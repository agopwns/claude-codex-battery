const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const zlib = require('node:zlib');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../claude-codex-usage.2m.js'), 'utf8');
const collector = source.slice(source.indexOf('function walkJsonl('), source.indexOf('// 소진 + 오래됨'));
const now = Math.floor(Date.now() / 1000);
const window = (minutes, used) => ({ window_minutes: minutes, used_percent: used, resets_at: now + minutes * 60 });
const rate = (id = 'codex', used = 3) => ({ limit_id: id, plan_type: 'pro', primary: window(10080, used), secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' } });
const event = (rl, seconds = now - 30) => JSON.stringify({ timestamp: new Date(seconds * 1000).toISOString(), payload: { rate_limits: rl } });
function collect(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-test-'));
  try {
    for (const [name, lines, mtime = now] of files) {
      const file = path.join(root, name);
      fs.writeFileSync(file, lines.join('\n'));
      fs.utimesSync(file, mtime, mtime);
    }
    const ctx = { ...fs, join: path.join, CODEX_SESSIONS: root, now };
    vm.createContext(ctx);
    vm.runInContext(collector + '; result = getCodex();', ctx);
    return JSON.parse(JSON.stringify(ctx.result));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function render(codex, snapshotVersion = 2) {
  const output = [], spawned = [];
  const ctx = {
    ...fs, ...path, zlib, Buffer, homedir: () => '/test-home',
    existsSync: () => false,
    readFileSync: (p) => {
      if (p.endsWith('.usage-snapshot.json')) return JSON.stringify({ v: snapshotVersion, collectedAt: now, codex });
      throw new Error('No fixture: ' + p);
    },
    statSync: () => { throw new Error('No file'); },
    writeFileSync: () => {}, mkdirSync: () => {}, renameSync: () => {}, unlinkSync: () => {},
    execSync: () => { throw new Error('Subprocess disabled'); },
    spawn: (...args) => { spawned.push(args); return { unref() {} }; },
    console: { log: (s) => output.push(s) },
    process: { argv: ['node', '/plugin.js'], execPath: '/node', pid: 1 },
  };
  vm.createContext(ctx);
  vm.runInContext(source.replace(/^#!.*\n/, '').replace(/^import[\s\S]*?;\n/gm, ''), ctx);
  return { text: output.join('\n'), spawned, items: vm.runInContext('battItems', ctx) };
}
test('Spark later in same log cannot overwrite general Codex', () => {
  const result = collect([['one.jsonl', [event(rate()), event(rate('codex_bengalfox', 0), now - 10), '{partial']]]);
  assert.equal(result.limitId, 'codex');
  assert.equal(result.weekly.used_percent, 3);
  assert.equal(result.fiveHour, null);
});
test('newer file activity does not override newer usage event or measured time', () => {
  const result = collect([
    ['touched.jsonl', [event(rate('codex', 1), now - 600)], now + 1],
    ['fresh.jsonl', [event(rate('codex', 7), now - 60)], now],
  ]);
  assert.equal(result.weekly.used_percent, 7);
  assert.equal(result.measuredAt, now - 60);
});
test('general Codex survives more than eight recently active Spark logs', () => {
  const files = Array.from({length: 9}, (_, i) => [`spark${i}.jsonl`, [event(rate('codex_bengalfox', 0))], now + i]);
  files.push(['general.jsonl', [event(rate())], now - 1]);
  assert.equal(collect(files).weekly.used_percent, 3);
});
test('legacy ID and reversed windows map by duration', () => {
  const rl = rate(); delete rl.limit_id; rl.secondary = window(300, 12);
  const result = collect([['legacy.jsonl', [event(rl)]]]);
  assert.equal(result.weekly.used_percent, 3);
  assert.equal(result.fiveHour.used_percent, 12);
});
test('malformed timestamps and Spark-only logs do not invent general usage', () => {
  assert.equal(collect([['bad.jsonl', [JSON.stringify({ payload: { rate_limits: rate() } }), event(rate('codex_bengalfox'))]]]), null);
});
test('weekly-only render shows XW 97 and unavailable five-hour, without credit exhaustion', () => {
  const { text, items } = render(collect([['one.jsonl', [event(rate())]]]));
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [{ label: 'XW', remain: 97 }]);
  assert.match(text, /주간 남음.*97%.*사용 3%/);
  assert.match(text, /5시간 한도 · 데이터 미제공/);
  assert.doesNotMatch(text, /5시간 남음|크레딧  소진|다음 회복[^\n]*X5/);
  assert.match(text, /다음 회복[^\n]*XW/);
});
test('old quota observation stays stale and zero extra credits do not trigger Codex runs', () => {
  const codex = collect([['one.jsonl', [event(rate(), now - 4 * 3600)]]]);
  const { text, spawned } = render(codex);
  assert.match(text, /리셋됐을 수 있음/);
  assert.doesNotMatch(text, /다음 회복[^\n]*XW/);
  assert.ok(!spawned.some(args => JSON.stringify(args).includes('reply ok')));
});
test('credits-only plans retain their display', () => {
  const rl = rate(); rl.primary = null; rl.credits = { has_credits: true, unlimited: false, balance: '25' };
  const { text } = render(collect([['one.jsonl', [event(rl)]]]));
  assert.match(text, /크레딧  잔액 25/);
  assert.doesNotMatch(text, /5시간 남음|주간 남음/);
});
test('v1 snapshot with wrongly selected Spark is discarded', () => {
  const { text } = render({ primary: window(300, 0), secondary: window(10080, 0), plan: 'pro', measuredAt: now }, 1);
  assert.doesNotMatch(text, /Codex · pro|5시간 남음|주간 남음/);
});
test('weekly pace projects depletion before reset at current burn rate', () => {
  // 주기 4d 14h 경과에 97% 사용 → 약 21%/일, 남은 3%는 ~3h 버팀, 리셋은 2d 10h 후
  const rl = rate('codex', 97); rl.primary.resets_at = now + (2 * 24 + 10) * 3600;
  const { text } = render(collect([['one.jsonl', [event(rl)]]]));
  assert.match(text, /페이스 −21\.\d%\/일 · 안전 −1\.2%\/일 ⚠️ 약 3h \d+m 후 소진 → 리셋까지 2d \d+h 공백/);
});
test('weekly pace shows headroom when burn is below safe rate', () => {
  // 주기 3d 경과에 20% 사용 → 약 6.7%/일, 리셋(4d 후) 때 ~53% 남음
  const rl = rate('codex', 20); rl.primary.resets_at = now + 4 * 86400;
  const { text } = render(collect([['one.jsonl', [event(rl)]]]));
  assert.match(text, /페이스 −6\.7%\/일 · 안전 −20\.0%\/일 — 여유, 1[12]d \d+h 버팀 · 리셋 때 ~53% 남음/);
});
test('weekly pace is hidden early in the window', () => {
  const { text } = render(collect([['one.jsonl', [event(rate('codex', 5))]]]));
  assert.doesNotMatch(text, /%\/일/);
});
