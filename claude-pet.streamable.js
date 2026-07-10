#!/usr/bin/env bun
// <xbar.title>Claude Pet</xbar.title>
// <swiftbar.type>streamable</swiftbar.type>
// <swiftbar.hideAbout>true</swiftbar.hideAbout>
// <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
// <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
// SwiftBar 스트리밍 플러그인: 배터리 위젯이 2분마다 남기는 .batt-burn.json을 읽어
// 메뉴바에 픽셀아트 동물 펫을 그린다. 프로세스가 계속 살아서 ~~~ 로 프레임을 교체.

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import zlib from "node:zlib";

const HOME = homedir();
// SELF_PATH = 설치된 실제 파일 경로 (SELF_DIR 패턴) — 펫 끄기 토글이 이 경로를 그대로 rename한다
const SELF_PATH =
  process.argv[1] || `${HOME}/.swiftbar-plugins/claude-pet.streamable.js`;
const SETTINGS_DIR = `${HOME}/.claude/swiftbar`;
const BURN_FILE = `${SETTINGS_DIR}/.batt-burn.json`;
const SPECIES_FILE = `${SETTINGS_DIR}/.pet-species`;
// 말풍선 팝업(네이티브 NSPanel) 관련 경로 — 배터리 위젯(claude-codex-usage.2m.js)이 메시지를 남기고,
// 이 펫 플러그인이 드롭다운 표시 + (조건부) 팝업 발사를 담당
const BUBBLE_MSG_FILE = `${SETTINGS_DIR}/.pet-bubble-msg.json`;
const BUBBLE_SHOWN_FILE = `${SETTINGS_DIR}/.pet-bubble-shown.json`;
const BUBBLE_SETTING_FILE = `${SETTINGS_DIR}/.pet-bubble`;
const BUBBLE_BIN = `${SETTINGS_DIR}/pet-bubble`;
const BUBBLE_COOLDOWN_SEC = 600;

// ══ PNG 인코더 (battery 플러그인과 동일한 순수 JS 구현, node:zlib만 사용) ══
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePNG(w, h, rgba, dpi) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const mk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunks = [sig, mk("IHDR", ihdr)];
  if (dpi) {
    // pHYs: DPI 선언 → NSImage가 포인트 크기를 px*72/dpi로 축소 (레티나 1:1 렌더)
    const phys = Buffer.alloc(9);
    const ppm = Math.round(dpi / 0.0254);
    phys.writeUInt32BE(ppm, 0);
    phys.writeUInt32BE(ppm, 4);
    phys[8] = 1;
    chunks.push(mk("pHYs", phys));
  }
  chunks.push(mk("IDAT", idat), mk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}
// 16×12 논리 px, SCALE=3 물리 배율 → 48×36 물리 px, dpi=216로 16×12pt 표시
const LOGICAL_W = 16;
const LOGICAL_H = 12;
const SCALE = 3;
const DPI = 216;
function makeCanvas(wl, hl) {
  const w = wl * SCALE,
    h = hl * SCALE;
  const buf = Buffer.alloc(w * h * 4, 0);
  const set = (x, y, col) => {
    if (x < 0 || y < 0 || x >= wl || y >= hl) return;
    const [r, g, b, a = 255] = col;
    for (let dy = 0; dy < SCALE; dy++)
      for (let dx = 0; dx < SCALE; dx++) {
        const px = ((y * SCALE + dy) * w + (x * SCALE + dx)) * 4;
        buf[px] = r;
        buf[px + 1] = g;
        buf[px + 2] = b;
        buf[px + 3] = a;
      }
  };
  return { w, h, buf, set };
}

// ── 다크모드 판정 (30초 캐시 — 프레임마다 defaults read를 부르지 않도록) ──
let darkCache = { value: false, at: 0 };
function isDarkMode() {
  const nowMs = Date.now();
  if (nowMs - darkCache.at < 30000) return darkCache.value;
  let v = false;
  try {
    v =
      execSync("defaults read -g AppleInterfaceStyle 2>/dev/null", {
        encoding: "utf8",
        timeout: 3000,
      }).trim() === "Dark";
  } catch {}
  darkCache = { value: v, at: nowMs };
  return v;
}

// ── 스프라이트 데이터: 종(species) × 상태(state) × 프레임. 문자 1개=논리 픽셀 1개.
// '.'=투명 '#'=ink(다크/라이트에 따라 렌더 시점에 색 결정) 'o'=accent(종별 고정색)
// 공통 골격: 몸통 8×5(x4-11,y5-9) · 머리 4×4(x10-13,y2-5, 눈 구멍 (12,3)) · 다리 2×1 스텁
const SPRITES = {
  cat: {
    run: [
      [
        "..........o..o..",
        "..........#..#..",
        "...........##...",
        "..........##.#..",
        ".o........####..",
        ".#...#########..",
        "..#.########....",
        "...#########....",
        "....########....",
        ".....######.....",
        "....##....##....",
        "................",
      ],
      [
        "..........o..o..",
        "..........#..#..",
        "...........##...",
        "..........##.#..",
        "..........####..",
        ".o...#########..",
        ".#..########....",
        "..##########....",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
    ],
    idle: [
      [
        "..........o..o..",
        "..........#..#..",
        "...........##...",
        "..........##.#..",
        ".o....########..",
        ".#...#########..",
        "..#.########....",
        "...#########....",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
      [
        "..........o..o..",
        "..........#..#..",
        "...........##...",
        "..........##.#..",
        "......########..",
        ".o...#########..",
        ".#..########....",
        "..##########....",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
    ],
    sleep: [
      [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "...........##...",
        "...###########..",
        "...##########...",
        "....########....",
        "................",
      ],
      [
        ".............###",
        "..............#.",
        ".............###",
        "................",
        "................",
        "................",
        "................",
        "...........##...",
        "...###########..",
        "...##########...",
        "....########....",
        "................",
      ],
    ],
    tired: [
      [
        "................",
        "................",
        "................",
        "..........####..",
        "......######.#..",
        ".....#########..",
        ".o..##########..",
        ".###########....",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
    ],
    exhausted: [
      [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "......#..#.##...",
        "...###########..",
        "...##########...",
        "....########....",
        "................",
      ],
    ],
    party: [
      [
        "........o.o##o..",
        "..o.......##.#..",
        ".o........####o.",
        ".#...#########..",
        "..#.########....",
        "...#########....",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
        "................",
        "................",
      ],
    ],
  },
  hamster: {
    run: [
      [
        "................",
        "..........#..#..",
        "...........##...",
        "..........##.#..",
        "..........#o##..",
        ".....#########..",
        "....########....",
        "...#########....",
        "....########....",
        ".....######.....",
        ".....######.....",
        "....##....##....",
      ],
      [
        "................",
        "..........#..#..",
        "...........##...",
        "..........##.#..",
        "..........#o##..",
        ".....#########..",
        "....########....",
        "....########....",
        "...#########....",
        ".....######.....",
        ".....######.....",
        "......##.##.....",
      ],
    ],
    idle: [
      [
        "................",
        "..........#..#..",
        "...........##...",
        "..........##.#..",
        "......#####o##..",
        ".....#########..",
        "....########....",
        "...#########....",
        "....########....",
        ".....######.....",
        ".....######.....",
        "......##.##.....",
      ],
      [
        "................",
        ".............#..",
        "..........###...",
        "..........##.#..",
        "......#####o##..",
        ".....#########..",
        "....########....",
        "...#########....",
        "....########....",
        ".....######.....",
        ".....######.....",
        "......##.##.....",
      ],
    ],
    sleep: [
      [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "...........##...",
        "...########o##..",
        "...##########...",
        "....########....",
        "................",
      ],
      [
        ".............###",
        "..............#.",
        ".............###",
        "................",
        "................",
        "................",
        "................",
        "...........##...",
        "...########o##..",
        "...##########...",
        "....########....",
        "................",
      ],
    ],
    tired: [
      [
        "................",
        "................",
        "................",
        "..........####..",
        "......######.#..",
        ".....######o##..",
        "....##########..",
        "....########....",
        "...#########....",
        ".....######.....",
        ".....######.....",
        "......##.##.....",
      ],
    ],
    exhausted: [
      [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "......#..#.##...",
        "...########o##..",
        "...##########...",
        "....########....",
        "................",
      ],
    ],
    party: [
      [
        "........o..##...",
        "..o.......##.#..",
        "..........#o##o.",
        ".....#########..",
        "....########....",
        "....########....",
        "....########....",
        "...#.######.....",
        ".....######.....",
        "......##.##.....",
        "................",
        "................",
      ],
    ],
  },
  rabbit: {
    run: [
      [
        "...........##...",
        "...........#o...",
        "...........##...",
        "..........##.#..",
        "..........####..",
        ".....#########..",
        "....########....",
        "...#########....",
        "....########....",
        ".....######.....",
        "....##....##....",
        "................",
      ],
      [
        "...........##...",
        "...........#o...",
        "...........##...",
        "..........##.#..",
        "..........####..",
        ".....#########..",
        "....########....",
        "....########....",
        "...#########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
    ],
    idle: [
      [
        "...........##...",
        "...........#o...",
        "...........##...",
        "..........##.#..",
        "......########..",
        ".....#########..",
        "....########....",
        "...#########....",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
      [
        "...........##...",
        "...........#o...",
        "..........###...",
        "..........##.#..",
        "......########..",
        ".....#########..",
        "....########....",
        "....########....",
        "...#########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
    ],
    sleep: [
      [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "...........##.##",
        "...###########..",
        "...##########...",
        "....########....",
        "................",
      ],
      [
        ".............###",
        "..............#.",
        ".............###",
        "................",
        "................",
        "................",
        "................",
        "...........##.##",
        "...###########..",
        "...##########...",
        "....########....",
        "................",
      ],
    ],
    tired: [
      [
        "................",
        "................",
        "................",
        ".........#.##.#.",
        "......######.#..",
        ".....#########..",
        "....##########..",
        "....########....",
        "...#########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
    ],
    exhausted: [
      [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "......#..#.##.##",
        "...###########..",
        "...##########...",
        "....########....",
        "................",
      ],
    ],
    party: [
      [
        "........o..##...",
        "..o.......##o#..",
        "..........####o.",
        ".....#########..",
        "....########....",
        "...#########....",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
        "................",
        "................",
      ],
    ],
  },
  turtle: {
    run: [
      [
        "................",
        "................",
        "................",
        "................",
        "......oooo......",
        ".....oooooo###..",
        "....ooooooo#.#..",
        "....ooooooo###..",
        "....########....",
        ".....######.....",
        "....##....##....",
        "................",
      ],
      [
        "................",
        "................",
        "................",
        "................",
        "......oooo......",
        ".....oooooo###..",
        "....ooooooo#.#..",
        "....ooooooo###..",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
    ],
    idle: [
      [
        "................",
        "................",
        "................",
        "................",
        "......oooo......",
        ".....oooooo###..",
        "....ooooooo#.#..",
        "....ooooooo###..",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
      [
        "................",
        "................",
        "................",
        "................",
        "......oooo......",
        ".....oooooo.###.",
        "....oooooooo#.#.",
        "....oooooooo###.",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
    ],
    sleep: [
      [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "...........##...",
        "...ooooooo####..",
        "...oooooooooo...",
        "....########....",
        "................",
      ],
      [
        ".............###",
        "..............#.",
        ".............###",
        "................",
        "................",
        "................",
        "................",
        "...........##...",
        "...ooooooo####..",
        "...oooooooooo...",
        "....########....",
        "................",
      ],
    ],
    tired: [
      [
        "................",
        "................",
        "................",
        "................",
        "......oooo......",
        ".....oooooo.....",
        "....ooooooo###..",
        "....ooooooo#.#..",
        "....##########..",
        ".....######.....",
        "......##.##.....",
        "................",
      ],
    ],
    exhausted: [
      [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "......#..#.##...",
        "...ooooooo####..",
        "...oooooooooo...",
        "....########....",
        "................",
      ],
    ],
    party: [
      [
        "........o.......",
        "..o.............",
        "......oooo....o.",
        ".....oooooo###..",
        "....ooooooo#.#..",
        "....ooooooo###..",
        "....########....",
        ".....######.....",
        "......##.##.....",
        "................",
        "................",
        "................",
      ],
    ],
  },
};

// 종별 고정 accent 색 (다크/라이트 공통)
const ACCENT = {
  cat: [255, 140, 105], // 코랄 — 귀 안쪽 + 꼬리 끝
  hamster: [255, 190, 120], // 골든 — 볼 점
  turtle: [110, 200, 120], // 그린 — 등껍질
  rabbit: [255, 150, 170], // 핑크 — 귀 안쪽
};
const ALL_SPECIES = ["cat", "hamster", "turtle", "rabbit"];
const SPECIES_LABELS = {
  cat: "고양이",
  hamster: "햄스터",
  turtle: "거북이",
  rabbit: "토끼",
};

function readSpecies() {
  try {
    const v = readFileSync(SPECIES_FILE, "utf8").trim();
    if (ALL_SPECIES.includes(v)) return v;
  } catch {}
  return "cat";
}

// ── 말풍선 팝업 설정: on(기본) / off — ~/.claude/swiftbar/.pet-bubble ──
function readBubbleSetting() {
  try {
    if (readFileSync(BUBBLE_SETTING_FILE, "utf8").trim() === "off")
      return "off";
  } catch {}
  return "on";
}

// 배터리 위젯이 남긴 최신 말풍선 메시지 { msg, pri, t } — 없거나 깨져 있으면 null
function readBubbleMsg() {
  try {
    const parsed = JSON.parse(readFileSync(BUBBLE_MSG_FILE, "utf8"));
    if (parsed && typeof parsed.msg === "string") return parsed;
  } catch {}
  return null;
}

// 네이티브 말풍선 팝업(NSPanel) 조건부 발사 — 고우선순위(방전/예산/쿼터, pri<=3) 또는
// 펫 상태가 이번 프레임에 party로 막 전환됐을 때만. 같은 메시지는 10분 내 재발사하지 않는다.
// 통째로 try/catch — 팝업 발사가 실패해도 드롭다운 루프는 계속돼야 한다.
function maybeShowBubblePopup(bubbleSetting, bubbleData, justPartied) {
  try {
    if (bubbleSetting !== "on") return;
    if (!existsSync(BUBBLE_BIN)) return;
    const highPriority =
      bubbleData && typeof bubbleData.pri === "number" && bubbleData.pri <= 3;
    if (!highPriority && !justPartied) return;
    const msg = justPartied ? "풀충전! 달릴 준비 됐어요 🎉" : bubbleData?.msg;
    if (!msg) return;
    let shown = null;
    try {
      const parsed = JSON.parse(readFileSync(BUBBLE_SHOWN_FILE, "utf8"));
      if (parsed && typeof parsed === "object") shown = parsed;
    } catch {}
    const nowS = Math.floor(Date.now() / 1000);
    if (
      shown &&
      shown.msg === msg &&
      nowS - (shown.t || 0) < BUBBLE_COOLDOWN_SEC
    )
      return;
    spawn(BUBBLE_BIN, [msg, "5"], { detached: true, stdio: "ignore" }).unref();
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(BUBBLE_SHOWN_FILE, JSON.stringify({ msg, t: nowS }));
  } catch {}
}

// ── 상태(state) 판정: .batt-burn.json 의 samples 배열에서 최근 2개로 판단 ──
function readBurn() {
  try {
    const parsed = JSON.parse(readFileSync(BURN_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.samples))
      return parsed;
  } catch {}
  return null;
}
function computeState(burn) {
  const nowS = Math.floor(Date.now() / 1000);
  const samples = burn?.samples || [];
  const last = samples.length ? samples[samples.length - 1] : null;
  const prev = samples.length > 1 ? samples[samples.length - 2] : null;
  // party: 리셋 직후 잔량이 30%p+ 급상승 (fresh)
  if (prev && last && last.remain - prev.remain >= 30 && nowS - last.t < 90)
    return "party";
  if (last && last.remain <= 5) return "exhausted";
  if (last && last.remain <= 20) return "tired";
  if (
    prev &&
    last &&
    nowS - last.t <= 5 * 60 &&
    prev.remain - last.remain >= 0.5
  )
    return "working";
  if (last && nowS - last.t <= 25 * 60) return "idle";
  return "sleep";
}
function intervalForState(state) {
  if (state === "working" || state === "party") return 1000;
  if (state === "idle" || state === "tired") return 2000;
  return 5000; // exhausted, sleep
}

// state+tick → 어떤 스프라이트 그리드를 그릴지 선택 (2프레임 상태는 tick으로 교대)
function pickFrame(species, state, tick) {
  const S = SPRITES[species];
  if (state === "working")
    return { grid: S.run[tick % 2], key: `run${tick % 2}` };
  if (state === "idle")
    return { grid: S.idle[tick % 2], key: `idle${tick % 2}` };
  if (state === "sleep")
    return { grid: S.sleep[tick % 2], key: `sleep${tick % 2}` };
  if (state === "tired") return { grid: S.tired[0], key: "tired0" };
  if (state === "exhausted") return { grid: S.exhausted[0], key: "exhausted0" };
  if (state === "party")
    // party: party 프레임과 run 프레임A를 교대해 통통 튀는 느낌
    return tick % 2 === 0
      ? { grid: S.party[0], key: "party0" }
      : { grid: S.run[0], key: "run0-bounce" };
  return { grid: S.idle[0], key: "idle0" };
}

// ── 렌더: 문자 그리드 → PNG base64. (species,state,frame,dark) 조합별로 캐시 ──
const spriteCache = new Map();
function renderSprite(grid, accent, dark) {
  const ink = dark ? [235, 235, 235] : [45, 45, 45];
  const cv = makeCanvas(LOGICAL_W, LOGICAL_H);
  for (let y = 0; y < LOGICAL_H; y++) {
    const row = grid[y];
    for (let x = 0; x < LOGICAL_W; x++) {
      const ch = row[x];
      if (ch === "#") cv.set(x, y, ink);
      else if (ch === "o") cv.set(x, y, accent);
    }
  }
  return encodePNG(cv.w, cv.h, cv.buf, DPI).toString("base64");
}
function getFrameBase64(species, state, tick, dark) {
  const { grid, key } = pickFrame(species, state, tick);
  const cacheKey = `${species}|${key}|${dark}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;
  const b64 = renderSprite(grid, ACCENT[species], dark);
  spriteCache.set(cacheKey, b64);
  return b64;
}

// ── 드롭다운 ──
const STATUS_LABEL = {
  working: "상태: 열일 중 🔥",
  idle: "상태: 한가함",
  sleep: "상태: 수면",
  tired: "상태: 지침",
  exhausted: "상태: 방전",
  party: "상태: 풀충전 축하!",
};
function buildDropdown(state, species, bubbleMsg, bubbleSetting) {
  const rows = [];
  // 말풍선: 배터리 위젯이 남긴 메시지가 있으면 드롭다운 맨 위에 노출 (상태 줄보다 먼저)
  if (bubbleMsg) rows.push(`💬 ${bubbleMsg} | size=12`);
  rows.push(
    `${STATUS_LABEL[state] || "상태: 알 수 없음"} | size=12 color=#8b949e`,
  );
  rows.push("---");
  for (const sp of ALL_SPECIES) {
    const active = sp === species;
    rows.push(
      `동물: ${SPECIES_LABELS[sp]}${active ? " ✓" : ""} | bash=/bin/sh param1=-c param2="mkdir -p '${SETTINGS_DIR}' && echo ${sp} > '${SPECIES_FILE}'" terminal=false refresh=false`,
    );
  }
  rows.push("---");
  // 팝업 말풍선 켜기/끄기 — 켜짐이면 클릭 시 off 기록, 꺼짐이면 클릭 시 on 기록 (동물 행과 동일한 bash 패턴)
  rows.push(
    `팝업 말풍선: ${bubbleSetting === "on" ? "켜짐" : "꺼짐"} | bash=/bin/sh param1=-c param2="mkdir -p '${SETTINGS_DIR}' && echo ${bubbleSetting === "on" ? "off" : "on"} > '${BUBBLE_SETTING_FILE}'" terminal=false refresh=false`,
  );
  // 펫 끄기: 설치된 파일을 .off로 rename → SwiftBar가 무시. install.sh/main plugin이 다시 켜준다.
  rows.push(
    `펫 끄기 | bash=/bin/mv param1="${SELF_PATH}" param2="${SELF_PATH}.off" terminal=false refresh=true`,
  );
  return rows;
}

// ── 메인 스트리밍 루프 ──
let tick = 0;
let prevState = null; // party 전환 감지용 — 직전 프레임의 state
async function loop() {
  while (true) {
    let waitMs = 5000;
    try {
      const species = readSpecies();
      const burn = readBurn();
      const state = computeState(burn);
      const dark = isDarkMode();
      const img = getFrameBase64(species, state, tick, dark);
      const bubbleData = readBubbleMsg();
      const bubbleSetting = readBubbleSetting();
      const justPartied = state === "party" && prevState !== "party";
      maybeShowBubblePopup(bubbleSetting, bubbleData, justPartied);
      const lines = [
        `| image=${img}`,
        "---",
        ...buildDropdown(state, species, bubbleData?.msg, bubbleSetting),
      ];
      console.log("~~~");
      console.log(lines.join("\n"));
      waitMs = intervalForState(state);
      prevState = state;
    } catch {
      // 프레임 하나가 깨져도 루프는 계속 — 다음 틱에서 회복 시도
    }
    tick++;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}
loop();
