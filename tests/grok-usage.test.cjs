const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../claude-codex-usage.2m.js'), 'utf8');
const grokSource = source.slice(
  source.indexOf('// Grok CLI의 OIDC 토큰'),
  source.indexOf('// PixelLab은 토큰이 아니라'),
);
const future = new Date(Date.now() + 6 * 3600e3).toISOString();
const weekly = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: new Date(Date.now() - 2 * 86400e3).toISOString(),
      end: new Date(Date.now() + 5 * 86400e3).toISOString(),
    },
    creditUsagePercent: 11,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [{ product: 'GrokBuild', usagePercent: 11 }],
    billingPeriodStart: new Date(Date.now() - 2 * 86400e3).toISOString(),
    billingPeriodEnd: new Date(Date.now() + 5 * 86400e3).toISOString(),
  },
};

function evaluate({ auth, billing = weekly, settings = { subscription_tier_display: 'SuperGrok' }, prev = null }) {
  const calls = [];
  const ctx = {
    HOME: '/home/test',
    SNAPSHOT_FILE: '/state/.usage-snapshot.json',
    process: { env: {} },
    readFileSync(file) {
      if (file === '/home/test/.grok/auth.json') return JSON.stringify(auth);
      if (file === '/state/.usage-snapshot.json') {
        if (prev) return JSON.stringify({ grok: prev });
        throw new Error('no snapshot');
      }
      throw new Error('unexpected read: ' + file);
    },
    execSync(command, options) {
      calls.push({ command, input: options.input });
      const body = command.includes('/v1/settings') ? settings : billing;
      return JSON.stringify(body) + '\n200';
    },
  };
  vm.createContext(ctx);
  vm.runInContext(grokSource + '; result = getGrok(); token = readGrokToken();', ctx);
  return { result: JSON.parse(JSON.stringify(ctx.result)), token: ctx.token, calls };
}

test('Grok auth prefers an unexpired OIDC scope and supports the legacy scope', () => {
  const auth = {
    'https://accounts.x.ai/sign-in': { auth_mode: 'legacy', key: 'legacy-secret' },
    'https://auth.x.ai::client-id': { auth_mode: 'oidc', key: 'oidc-secret', expires_at: future },
  };
  assert.equal(evaluate({ auth }).token, 'oidc-secret');
  assert.equal(evaluate({ auth: { 'https://accounts.x.ai/sign-in': auth['https://accounts.x.ai/sign-in'] } }).token, 'legacy-secret');
});

test('Grok collector reports login required when no credential or cache exists', () => {
  const { result, calls } = evaluate({ auth: {} });
  assert.equal(result.error, 'login');
  assert.equal(calls.length, 0);
});

test('Grok collector normalizes weekly usage and keeps credentials out of commands and snapshots', () => {
  const secret = 'top-secret-token';
  const { result, calls } = evaluate({
    auth: { 'https://auth.x.ai::client-id': { auth_mode: 'oidc', key: secret, expires_at: future } },
  });
  assert.equal(result.usedPct, 11);
  assert.equal(result.remainingPct, 89);
  assert.equal(result.periodType, 'weekly');
  assert.equal(result.plan, 'SuperGrok');
  assert.deepEqual(result.products, [{ product: 'GrokBuild', usedPct: 11 }]);
  assert.ok(calls.some((call) => call.command.includes('/v1/billing?format=credits')));
  assert.ok(calls.every((call) => !call.command.includes(secret)));
  assert.ok(calls.every((call) => call.input.includes('x-xai-token-auth: xai-grok-cli')));
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('Grok collector preserves an explicit zero percentage', () => {
  const billing = structuredClone(weekly);
  billing.config.creditUsagePercent = 0;
  billing.config.productUsage[0].usagePercent = 0;
  const { result } = evaluate({
    auth: { 'https://accounts.x.ai/sign-in': { key: 'legacy-secret' } },
    billing,
  });
  assert.equal(result.usedPct, 0);
  assert.equal(result.remainingPct, 100);
  assert.equal(result.products[0].usedPct, 0);
});

test('missing or malformed Grok percentage never becomes 100% remaining', () => {
  for (const value of [undefined, null, '', '   ', false, 101, -1]) {
    const billing = structuredClone(weekly);
    if (value === undefined) delete billing.config.creditUsagePercent;
    else billing.config.creditUsagePercent = value;
    const { result } = evaluate({
      auth: { 'https://accounts.x.ai/sign-in': { key: 'legacy-secret' } },
      billing,
    });
    assert.equal(result.error, 'fetch');
    assert.equal(result.remainingPct, undefined);
  }
});

test('Grok failures retain only a valid stale snapshot and label it as cache data', () => {
  const prev = {
    measuredAt: Math.floor(Date.now() / 1000) - 600,
    live: true,
    usedPct: 37,
    remainingPct: 63,
    periodType: 'weekly',
    products: [],
  };
  const malformed = structuredClone(weekly);
  delete malformed.config.creditUsagePercent;
  const { result } = evaluate({
    auth: { 'https://accounts.x.ai/sign-in': { key: 'legacy-secret' } },
    billing: malformed,
    prev,
  });
  assert.equal(result.usedPct, 37);
  assert.equal(result.remainingPct, 63);
  assert.equal(result.live, false);
  assert.equal(result.error, undefined);
});

test('Grok labels are sanitized and cadence requires valid full bounds', () => {
  const billing = structuredClone(weekly);
  delete billing.config.currentPeriod.type;
  billing.config.currentPeriod.start = new Date(Date.now() + 86400e3).toISOString();
  billing.config.productUsage = [{ product: 'Build|bad\nrow', usagePercent: 5 }];
  const { result } = evaluate({
    auth: { 'https://accounts.x.ai/sign-in': { key: 'legacy-secret' } },
    billing,
    settings: { subscription_tier_display: 'Super|Grok\nrow' },
  });
  assert.equal(result.periodType, 'credits');
  assert.equal(result.periodStart, null);
  assert.equal(result.plan, 'Super Grok row');
  assert.equal(result.products[0].product, 'Build bad row');
});
