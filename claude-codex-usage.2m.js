#!/usr/bin/env bun
// <xbar.title>Claude & Codex Usage</xbar.title>
// <xbar.version>v3.0</xbar.version>
// <xbar.author>개발부스러기</xbar.author>
// <xbar.desc>Claude Code 5시간 블록 + Codex rate limit을 메뉴바에 배터리 아이콘으로 상시 표시</xbar.desc>
// SwiftBar 플러그인: 1분마다 갱신. 메뉴바=배터리 잔량 아이콘(자체 PNG), 클릭=상세 게이지.

import { execSync, spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";

const HOME = homedir();
// 바이너리 경로 자동 탐지 (환경별로 다름 — 이식성)
function findBin(name, extra = []) {
  const cands = [
    ...extra,
    `${HOME}/.bun/bin/${name}`,
    "/opt/homebrew/bin/" + name,
    "/usr/local/bin/" + name,
  ];
  for (const c of cands) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  try {
    const p = execSync(`command -v ${name} 2>/dev/null`, {
      encoding: "utf8",
    }).trim();
    if (p) return p;
  } catch {}
  return name; // 최후: PATH에 의존
}
const CCUSAGE = findBin("ccusage");
const CODEX_BIN = findBin("codex");
const CODEX_SESSIONS = `${HOME}/.codex/sessions`;
const now = Math.floor(Date.now() / 1000);

// ── 자동 업데이트 (알림 + 원클릭) ──
const VERSION = "1.7.3";
const SELF_DIR = dirname(process.argv[1] || `${HOME}/.swiftbar-plugins/x`);
const REPO_RAW =
  "https://raw.githubusercontent.com/agopwns/claude-codex-battery/main";
const UPDATE_CACHE = `${HOME}/.claude/swiftbar/.update-check.json`;
function cmpVer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
// 캐시된 최신 버전을 읽고, 24h+ 지났으면 백그라운드로 GitHub VERSION만 조용히 확인
// (렌더를 막지 않음 — codex 자동갱신과 동일한 spawn+unref 패턴)
function getUpdateInfo() {
  let cache = null;
  try {
    cache = JSON.parse(readFileSync(UPDATE_CACHE, "utf8"));
  } catch {}
  const age = cache?.checkedAt ? now - cache.checkedAt : Infinity;
  if (age > 24 * 3600) {
    try {
      const cmd =
        `latest=$(curl -fsL --max-time 8 "${REPO_RAW}/VERSION" 2>/dev/null | tr -d '[:space:]'); ` +
        `[ -n "$latest" ] && printf '{"checkedAt":%s,"latest":"%s"}' "${now}" "$latest" > "${UPDATE_CACHE}"`;
      const child = spawn("/bin/sh", ["-c", cmd], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {}
  }
  const latest = cache?.latest;
  return { latest, hasUpdate: !!latest && cmpVer(latest, VERSION) > 0 };
}

// ══ 배터리 아이콘 PNG 렌더 (순수 JS, node:zlib만) ══════════
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
  // 물리 픽셀 좌표 직접 기록 — 글자 렌더 전용(FS가 SCALE과 다를 수 있어 set()의 논리 좌표계로는 표현 불가)
  const setPx = (px, py, col) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const [r, g, b, a = 255] = col;
    const o = (py * w + px) * 4;
    buf[o] = r;
    buf[o + 1] = g;
    buf[o + 2] = b;
    buf[o + 3] = a;
  };
  return { w, h, buf, set, setPx };
}
const _rect = (cv, x, y, rw, rh, col) => {
  for (let j = 0; j < rh; j++)
    for (let i = 0; i < rw; i++) cv.set(x + i, y + j, col);
};
const _stroke = (cv, x, y, rw, rh, col) => {
  for (let i = 1; i < rw - 1; i++) {
    cv.set(x + i, y, col);
    cv.set(x + i, y + rh - 1, col);
  }
  for (let j = 1; j < rh - 1; j++) {
    cv.set(x, y + j, col);
    cv.set(x + rw - 1, y + j, col);
  }
};
// ── 크기 프리셋: big(기본) / small — 드롭다운 ⚙️ 배터리 설정 또는 ~/.claude/swiftbar/.batt-size 로 전환 ──
const SIZE_FILE = `${HOME}/.claude/swiftbar/.batt-size`;
let SIZE = "big";
try {
  if (readFileSync(SIZE_FILE, "utf8").trim() === "small") SIZE = "small";
} catch {}
// ── 채움 색: traffic(신호등, 기본) / white / green(게임보이) / neon(시안) — ~/.claude/swiftbar/.batt-fill ──
const FILL_FILE = `${HOME}/.claude/swiftbar/.batt-fill`;
let FILL = "traffic";
try {
  const v = readFileSync(FILL_FILE, "utf8").trim();
  if (["white", "green", "neon"].includes(v)) FILL = v;
} catch {}
// ── 글자 크기: 70/80/90/100% — ~/.claude/swiftbar/.batt-font (그 외 값·파일 없음은 100%로 폴백) ──
const FONT_FILE = `${HOME}/.claude/swiftbar/.batt-font`;
let FONTPCT = 100;
try {
  const v = parseInt(readFileSync(FONT_FILE, "utf8").trim(), 10);
  if ([70, 80, 90, 100].includes(v)) FONTPCT = v;
} catch {}
// ── 글자 색: auto(기본, 항상 어두운 색) / black / white / red / blue — ~/.claude/swiftbar/.batt-text ──
const TEXT_FILE = `${HOME}/.claude/swiftbar/.batt-text`;
let TEXTCOL = "auto";
try {
  const v = readFileSync(TEXT_FILE, "utf8").trim();
  if (["black", "white", "red", "blue"].includes(v)) TEXTCOL = v;
} catch {}
// ── 전체 크기: 50~200% 정수(5% 스텝 UI) — ~/.claude/swiftbar/.batt-scale (그 외 값·파일 없음은 100%로 폴백) ──
const SCALE_FILE = `${HOME}/.claude/swiftbar/.batt-scale`;
let SIZEPCT = 100;
try {
  const v = parseInt(readFileSync(SCALE_FILE, "utf8").trim(), 10);
  if (Number.isInteger(v) && v >= 50 && v <= 200) SIZEPCT = v;
} catch {}
// ── 배터리 표시 선택: 켤 배터리 키 CSV (c5,cw,cf,x5,xw) — 파일 없음/전부 무효면 전체 표시 ──
const SHOW_FILE = `${HOME}/.claude/swiftbar/.batt-show`;
const ALL_BATTS = ["c5", "cw", "cf", "x5", "xw"];
let SHOWSET = new Set(ALL_BATTS);
try {
  const keys = readFileSync(SHOW_FILE, "utf8")
    .trim()
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((k) => ALL_BATTS.includes(k));
  if (keys.length) SHOWSET = new Set(keys);
} catch {}
// ── 임계값 알림 켜짐/꺼짐: on(기본) / off — ~/.claude/swiftbar/.batt-notify ──
const NOTIFY_FILE = `${HOME}/.claude/swiftbar/.batt-notify`;
let NOTIFY = "on";
try {
  if (readFileSync(NOTIFY_FILE, "utf8").trim() === "off") NOTIFY = "off";
} catch {}
// ── 표시 방식: image(기본, 배터리 아이콘) / text(컴팩트 텍스트) — ~/.claude/swiftbar/.batt-display ──
const DISPLAY_FILE = `${HOME}/.claude/swiftbar/.batt-display`;
let DISPLAY = "image";
try {
  if (readFileSync(DISPLAY_FILE, "utf8").trim() === "text") DISPLAY = "text";
} catch {}
// ── 월 예산(선택, USD) — ~/.claude/swiftbar/.batt-budget 에 손으로 양수 기록 (서브메뉴 없음). 0/미설정=기능 꺼짐 ──
const BUDGET_FILE = `${HOME}/.claude/swiftbar/.batt-budget`;
let BUDGET = 0;
try {
  const v = parseFloat(readFileSync(BUDGET_FILE, "utf8").trim());
  if (Number.isFinite(v) && v > 0) BUDGET = v;
} catch {}
// macOS 알림 발사 (detached osascript, 메시지가 ps 프로세스 목록에 남지 않음) — 임계값 알림 + C5 소진 예측 알림 공용
function fireNotification(msg) {
  try {
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const cmd = `osascript -e 'display notification "${esc(msg)}" with title "${esc("Claude·Codex Battery")}"'`;
    const child = spawn("/bin/sh", ["-c", cmd], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {}
}
// 배터리 키 → 사람이 읽는 라벨 (설정 서브메뉴 + 알림 엔진 공용)
const battLabels = {
  c5: "Claude 5시간 (C5)",
  cw: "Claude 주간 (CW)",
  cf: "Fable 주간 (CF)",
  x5: "Codex 5시간 (X5)",
  xw: "Codex 주간 (XW)",
};

// 4x6 픽셀 폰트 (big 프리셋)
const FONT46 = {
  0: ["0110", "1001", "1001", "1001", "1001", "0110"],
  1: ["0010", "0110", "0010", "0010", "0010", "0111"],
  2: ["0110", "1001", "0010", "0100", "1000", "1111"],
  3: ["1110", "0001", "0110", "0001", "1001", "0110"],
  4: ["0010", "0110", "1010", "1111", "0010", "0010"],
  5: ["1111", "1000", "1110", "0001", "1001", "0110"],
  6: ["0110", "1000", "1110", "1001", "1001", "0110"],
  7: ["1111", "0001", "0010", "0100", "0100", "0100"],
  8: ["0110", "1001", "0110", "1001", "1001", "0110"],
  9: ["0110", "1001", "1001", "0111", "0001", "0110"],
  C: ["0110", "1001", "1000", "1000", "1001", "0110"],
  X: ["1001", "1001", "0110", "0110", "1001", "1001"],
};
// 3x5 클래식 픽셀 폰트 (small 프리셋)
const FONT35 = {
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "001", "001", "001"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  C: ["111", "100", "100", "100", "111"],
  X: ["101", "101", "010", "101", "101"],
};
// 프리셋별 지오메트리: font/자간, 캡슐(bw×bh), 배치(capw·간격), 캔버스 높이, 숫자 y오프셋
const PRESET =
  SIZE === "small"
    ? {
        font: FONT35,
        adv: () => 4,
        bw: 14,
        bh: 9,
        capw: 16,
        gap: 3,
        ggap: 7,
        pad: 1,
        lblgap: 2,
        H: 9,
        dy: 2,
        scale: 3,
        dpi: 144, // 27px 캔버스를 13.5pt로 표시 — 레티나(2x) 디바이스 픽셀 1:1
      }
    : {
        font: FONT46,
        adv: (ch) => (ch === "1" ? 4 : 5),
        bw: 18,
        bh: 10,
        capw: 20,
        gap: 5,
        ggap: 10,
        pad: 2,
        lblgap: 3,
        H: 12,
        dy: 3,
        scale: 2,
        dpi: 0, // 기존 크기 유지 (pHYs 없음)
      };
const SCALE = PRESET.scale;
const NUM = PRESET.font;
// 글자 전용 물리 스케일 (SCALE*FONTPCT/100, 소수 허용 — 70~90%는 캡슐 내부에 여백을 남긴다)
const FS = (SCALE * FONTPCT) / 100;
const FONT_ROWS = SIZE === "small" ? 5 : 6; // 폰트 행 수 (FONT35=5, FONT46=6) — 세로 중앙정렬용
const chAdv = PRESET.adv; // big: 5px('1'만 4px 커닝 — "100" 물림 방지), small: 4px
// 물리 픽셀 공간에 글리프 문자열 렌더 (fs = 글리프 1px당 물리 px, 소수 허용 — nearest-neighbor)
// colorAt(physicalX): 픽셀별 색 결정 콜백 — 채움 경계 대비 처리(drawCapsule)나 단색(그룹 라벨)에 사용
function drawTextPx(cv, xPx, yPx, str, fs, colorAt) {
  let cx = xPx;
  for (const ch of str) {
    const g = NUM[ch];
    if (g) {
      const rows = g.length,
        cols = g[0].length;
      const gw = Math.round(cols * fs),
        gh = Math.round(rows * fs);
      const x0 = Math.round(cx);
      for (let py = 0; py < gh; py++)
        for (let px = 0; px < gw; px++) {
          const r = Math.min(rows - 1, Math.floor(py / fs));
          const c = Math.min(cols - 1, Math.floor(px / fs));
          if (g[r][c] === "1") cv.setPx(x0 + px, yPx + py, colorAt(x0 + px));
        }
    }
    cx += chAdv(ch) * fs;
  }
}
// 레이아웃 폭(논리 단위)은 FONTPCT와 무관하게 고정 — 글자 크기를 바꿔도 캡슐 간격이 흔들리지 않도록
const numW = (s) => [...s].reduce((w, ch) => w + chAdv(ch), 0) - 1;
// 실제 macOS 배터리 인디케이터 색 (Apple HIG system colors, 다크/라이트 각각)
function heatRemain(r, dark) {
  if (r <= 20) return dark ? [255, 69, 58] : [255, 59, 48]; // systemRed
  if (r < 50) return dark ? [255, 214, 10] : [255, 204, 0]; // systemYellow
  return dark ? [48, 209, 88] : [52, 199, 89]; // systemGreen
}
const heatRemainHex = (r) =>
  r <= 20 ? "#FF453A" : r < 50 ? "#FFD60A" : "#30D158"; // 드롭다운 게이지 (다크 기준)
// 캡슐 하나: 테두리 + 잔량 채움 + 안에 잔량 숫자(100 포함, 항상 표시)
function drawCapsule(cv, x, midY, remain, ink, dark) {
  const bw = PRESET.bw,
    bh = PRESET.bh,
    by = midY - Math.floor(bh / 2);
  _stroke(cv, x, by, bw, bh, ink);
  _rect(cv, x + bw, by + 3, 2, bh - 6, ink); // 단자
  if (remain != null) {
    const innerW = bw - 4;
    const v = Math.max(0, Math.min(100, remain));
    const fw = Math.round((v / 100) * innerW);
    // 채움 색: traffic(기본)=신호등 system color, white=다크에서 흰색·라이트에서 진회색(가독성 유지)
    // green=게임보이 감성 녹색, neon=시안 네온
    const fillCol =
      FILL === "white"
        ? dark
          ? [255, 255, 255]
          : [60, 60, 60]
        : FILL === "green"
          ? dark
            ? [120, 200, 80]
            : [60, 140, 40]
          : FILL === "neon"
            ? dark
              ? [10, 230, 230]
              : [0, 150, 160]
            : heatRemain(remain, dark);
    if (fw > 0) _rect(cv, x + 2, by + 2, fw, bh - 4, fillCol);
    // 빈 구간 트랙: 반투명 오버레이로 대비 확보 (macOS 시스템 배터리 아이콘 스타일)
    const trackCol = dark ? [255, 255, 255, 90] : [0, 0, 0, 50];
    if (fw < innerW)
      _rect(cv, x + 2 + fw, by + 2, innerW - fw, bh - 4, trackCol);
    const s = String(Math.round(v));
    const txPx = x * SCALE + (bw * SCALE - numW(s) * FS) / 2;
    const tyPx = Math.round((by + bh / 2) * SCALE - (FONT_ROWS * FS) / 2);
    // 숫자 색: 글리프를 한 가지 색으로 통째로 렌더 (경계 분할 제거 — 트랙이 빈 구간 대비를 보장)
    const digitCol =
      TEXTCOL === "black"
        ? [30, 30, 30]
        : TEXTCOL === "white"
          ? [255, 255, 255]
          : TEXTCOL === "red"
            ? dark
              ? [255, 69, 58]
              : [255, 59, 48]
            : TEXTCOL === "blue"
              ? dark
                ? [10, 132, 255]
                : [0, 122, 255]
              : [30, 30, 30]; // auto: 항상 어두운 숫자 — white/traffic 채움과 회색 트랙 모두 위에서 읽힘
    drawTextPx(cv, txPx, tyPx, s, FS, () => digitCol);
  }
  return x + bw + 2;
}
// 캡슐 N개(items=[{label,remain}]). 그룹(C=Claude / X=Codex) 앞에 라벨 문자.
function renderBatteryImage(dark, items) {
  const ink = dark ? [235, 235, 235] : [45, 45, 45];
  const CAPW = PRESET.capw,
    GAP = PRESET.gap,
    GGAP = PRESET.ggap,
    PAD = PRESET.pad,
    LBLGAP = PRESET.lblgap;
  const H = PRESET.H;
  const midY = Math.floor(H / 2);
  // 폭 계산 (그룹 라벨 포함)
  let W = PAD * 2;
  let pg = null;
  for (let i = 0; i < items.length; i++) {
    const g = items[i].label[0];
    if (g !== pg) {
      if (pg !== null) W += GGAP;
      W += numW(g) + LBLGAP;
      pg = g;
    } else W += GAP;
    W += CAPW;
  }
  const cv = makeCanvas(Math.max(W, 8), H);
  let x = PAD;
  pg = null;
  for (let i = 0; i < items.length; i++) {
    const g = items[i].label[0];
    if (g !== pg) {
      if (pg !== null) x += GGAP;
      // 그룹 라벨(C 또는 X) — 논리 박스(numW(g)) 안에서 물리 좌표로 중앙정렬해 그린다
      const lxPx = x * SCALE + (numW(g) * SCALE - numW(g) * FS) / 2;
      const lyPx = Math.round(cv.h / 2 - (FONT_ROWS * FS) / 2);
      drawTextPx(cv, lxPx, lyPx, g, FS, () => ink);
      x += numW(g) + LBLGAP;
      pg = g;
    } else x += GAP;
    drawCapsule(cv, x, midY, items[i].remain, ink, dark);
    x += CAPW;
  }
  // 전체 크기 %: pHYs DPI를 역비례로 조정 — 표시 pt = px*72/dpi. 100%면 프리셋 기본값 그대로(바이트 동일 경로 유지)
  const dpiEff =
    SIZEPCT === 100 ? PRESET.dpi : ((PRESET.dpi || 72) * 100) / SIZEPCT;
  return encodePNG(cv.w, cv.h, cv.buf, dpiEff).toString("base64");
}
function isDarkMode() {
  try {
    return (
      execSync("defaults read -g AppleInterfaceStyle 2>/dev/null", {
        encoding: "utf8",
        timeout: 3000,
      }).trim() === "Dark"
    );
  } catch {
    return false;
  }
}

// ── 게이지 렌더 (부분 블록, 의존성 0) ──────────────────────
const FULL = "█",
  EMPTY = "░",
  PART = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
function bar(pct, w) {
  pct = Math.max(0, Math.min(100, pct || 0));
  const filled = (pct / 100) * w;
  let fb = Math.floor(filled);
  let idx = Math.round((filled - fb) * 8);
  if (idx === 8) {
    fb++;
    idx = 0;
  }
  fb = Math.min(fb, w);
  let s = FULL.repeat(fb),
    used = fb;
  if (idx > 0 && fb < w) {
    s += PART[idx];
    used++;
  }
  s += EMPTY.repeat(Math.max(0, w - used));
  return s;
}
// 사용률 → 색 (GitHub 신호색)
function heat(pct) {
  if (pct >= 80) return "#f85149"; // 빨강
  if (pct >= 50) return "#d29922"; // 노랑
  return "#3fb950"; // 초록
}

// ── 공용 유틸 ──────────────────────────────────────────────
const fmtDur = (secs) => {
  if (secs <= 0) return "0m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};
const fmtTok = (n) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n}`;
};
// epoch초 → 로컬 HH:MM (24시간제, 0패딩) — C5 소진 예측 시각 표시용
const hhmm = (epochSec) => {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
// battItems([{label,remain}]) → 컴팩트 텍스트. 라벨 첫 글자(C/X)로 그룹핑(등장 순서 유지),
// 그룹 내 값은 반올림된 remain을 · 로 연결 (remain==null → –). 그룹은 공백으로 연결.
const compactBattText = (items) => {
  const order = [];
  const groups = {};
  for (const it of items) {
    const g = it.label[0];
    if (!groups[g]) {
      groups[g] = [];
      order.push(g);
    }
    groups[g].push(it.remain == null ? "–" : String(Math.round(it.remain)));
  }
  return order.map((g) => g + groups[g].join("·")).join(" ");
};

// ── 1. Claude Code: 활성 5시간 블록 ────────────────────────
function getClaude() {
  try {
    const raw = execSync(`${CCUSAGE} blocks --active --json`, {
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const data = JSON.parse(raw);
    const b =
      (data.blocks || []).find((x) => x.isActive) || (data.blocks || [])[0];
    if (!b) return null;
    const startTs = Math.floor(new Date(b.startTime).getTime() / 1000);
    const endTs = Math.floor(new Date(b.endTime).getTime() / 1000);
    const span = Math.max(1, endTs - startTs);
    const elapsedPct = Math.max(
      0,
      Math.min(100, ((now - startTs) / span) * 100),
    );
    return {
      elapsedPct,
      remainMin:
        b.projection?.remainingMinutes ??
        Math.max(0, Math.floor((endTs - now) / 60)),
      cost: b.costUSD || 0,
      tokens: b.totalTokens || 0,
      projCost: b.projection?.totalCost ?? null,
      costPerHour: b.burnRate?.costPerHour ?? null,
    };
  } catch (e) {
    return { error: String(e.message || e).split("\n")[0] };
  }
}

// ── 1b. Claude 오늘 모델별 사용 (Opus/Sonnet/Fable/Haiku) ──
const MODEL_NAMES = {
  "claude-fable-5": "Fable 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
};
const shortModel = (n) => MODEL_NAMES[n] || (n || "").replace("claude-", "");
function getClaudeModels() {
  try {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const raw = execSync(`${CCUSAGE} daily --breakdown --json --since ${ymd}`, {
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const day = (JSON.parse(raw).daily || []).slice(-1)[0];
    if (!day) return null;
    const models = (day.modelBreakdowns || [])
      .map((m) => ({
        name: m.modelName,
        cost: m.cost || 0,
        tokens:
          (m.inputTokens || 0) +
          (m.outputTokens || 0) +
          (m.cacheCreationTokens || 0) +
          (m.cacheReadTokens || 0),
      }))
      .filter((m) => m.cost > 0.005)
      .sort((a, b) => b.cost - a.cost);
    if (!models.length) return null;
    return { models, total: models.reduce((s, m) => s + m.cost, 0) };
  } catch {
    return null;
  }
}

// ── 1b-2. 일별 사용량 영구 스냅샷 — ccusage 로그는 ~30일이면 유실되므로
// 위젯이 돌 때마다(2분 주기) 오늘자 총합을 로컬 날짜 기준으로 UPSERT해 보관한다 ──
const USAGE_HISTORY_FILE = `${HOME}/.claude/swiftbar/usage-history.json`;
const localYmd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// cmodels(getClaudeModels 결과)를 오늘 키로 덮어쓰기 저장. 마지막 실행 값이 그날의 최종치가 된다.
// 파일이 없거나 깨졌으면 {}부터 다시 시작(자가 복구). 400개 초과 시 오래된 날짜부터 정리.
function upsertUsageHistory(cmodels) {
  try {
    let hist = {};
    try {
      const parsed = JSON.parse(readFileSync(USAGE_HISTORY_FILE, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        hist = parsed;
    } catch {}
    const models = {};
    let tokens = 0;
    for (const m of cmodels.models) {
      models[m.name] = m.cost;
      tokens += m.tokens;
    }
    hist[localYmd()] = { cost: cmodels.total, tokens, models };
    const keys = Object.keys(hist).sort();
    if (keys.length > 400) {
      for (const k of keys.slice(0, keys.length - 400)) delete hist[k];
    }
    mkdirSync(dirname(USAGE_HISTORY_FILE), { recursive: true });
    writeFileSync(USAGE_HISTORY_FILE, JSON.stringify(hist));
    return hist;
  } catch {
    return null;
  }
}
// 히스토리에서 이번 달·지난달 누적 비용 행 문자열 생성 (데이터 없으면 null).
// BUDGET(> 0) 설정 시 "/ 예산 $B (P%)" 조각을 덧붙이고 임계값별로 색을 바꾼다.
// 알림 판정(checkBudgetAlert)이 curSum을 재사용할 수 있도록 { row, curSum }로 반환.
function monthlyUsageRow(hist) {
  if (!hist) return null;
  const d = new Date();
  const y = d.getFullYear(),
    mo = d.getMonth(); // 0-indexed
  const curPrefix = `${y}-${String(mo + 1).padStart(2, "0")}`;
  let prevY = y,
    prevMo = mo - 1;
  if (prevMo < 0) {
    prevMo = 11;
    prevY = y - 1;
  }
  const prevPrefix = `${prevY}-${String(prevMo + 1).padStart(2, "0")}`;
  let curSum = 0,
    prevSum = 0,
    prevHas = false;
  for (const [k, v] of Object.entries(hist)) {
    if (k.startsWith(curPrefix)) curSum += v.cost || 0;
    else if (k.startsWith(prevPrefix)) {
      prevSum += v.cost || 0;
      prevHas = true;
    }
  }
  let s = `이번 달 누적 $${curSum.toFixed(0)}`;
  let color = "#8b949e";
  if (BUDGET > 0) {
    const pct = Math.round((curSum / BUDGET) * 100);
    s += ` / 예산 $${BUDGET.toFixed(0)} (${pct}%)`;
    color = pct >= 100 ? "#FF453A" : pct >= 80 ? "#d29922" : "#8b949e";
  }
  if (prevHas) s += `  ·  지난달 $${prevSum.toFixed(0)}`;
  return { row: `${s} | size=11 color=${color}`, curSum };
}
// 예산의 80%/100% 최초 돌파(상향만) 시 1회 알림. state 파일에 {month, zone}을 보관해
// 같은 달 재돌파를 걸러내고, 달이 바뀌면 zone을 "ok"로 리셋한다. 하향 전이는 조용히 갱신만.
// 렌더를 절대 막지 않도록 통째로 try/catch — 파일이 깨져 있으면 자가 복구.
const BUDGET_STATE_FILE = `${HOME}/.claude/swiftbar/.batt-budget-state.json`;
function checkBudgetAlert(curSum) {
  try {
    if (BUDGET <= 0) return;
    const monthKey = localYmd().slice(0, 7); // "YYYY-MM"
    let state = null;
    try {
      const parsed = JSON.parse(readFileSync(BUDGET_STATE_FILE, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.month && parsed.zone)
        state = parsed;
    } catch {}
    if (!state || state.month !== monthKey)
      state = { month: monthKey, zone: "ok" };
    const pct = Math.round((curSum / BUDGET) * 100);
    const zone = pct >= 100 ? "over100" : pct >= 80 ? "warn80" : "ok";
    const order = { ok: 0, warn80: 1, over100: 2 };
    if (order[zone] > order[state.zone] && NOTIFY !== "off") {
      if (zone === "warn80") {
        fireNotification(
          `📊 이번 달 사용 $${curSum.toFixed(0)} — 예산의 ${pct}% 도달`,
        );
      } else if (zone === "over100") {
        fireNotification(
          `💸 이번 달 사용 $${curSum.toFixed(0)} — 예산 $${BUDGET.toFixed(0)} 초과`,
        );
      }
    }
    state.zone = zone;
    mkdirSync(dirname(BUDGET_STATE_FILE), { recursive: true });
    writeFileSync(BUDGET_STATE_FILE, JSON.stringify(state));
  } catch {}
}
// 최근 7일(로컬 달력 기준, 오늘 포함) 일별 지출 막대 차트 행. 데이터 없으면(전부 null) null.
// 막대 색: 오늘=진하게(다크/라이트 대비), 나머지 데이터일=회색, 결측일=흐린 회색 1px 스텁.
// 차트 버그가 드롭다운 전체를 죽이면 안 되므로 통째로 try/catch.
function sparklineRow(hist, dark) {
  try {
    if (!hist) return null;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const key = localYmd(new Date(Date.now() - i * 86400e3));
      days.push(hist[key]?.cost ?? null);
    }
    const known = days.filter((v) => v != null);
    if (!known.length) return null;
    const sum = known.reduce((a, b) => a + b, 0);
    const maxCost = Math.max(...known);
    const cv = makeCanvas(7 * 5 + 1, 16);
    const baseline = 15;
    for (let i = 0; i < 7; i++) {
      const cost = days[i];
      const x = 1 + i * 5;
      if (cost == null) {
        _rect(cv, x, baseline, 4, 1, [128, 128, 128, 60]);
        continue;
      }
      const barH =
        maxCost > 0 ? Math.max(1, Math.round((cost / maxCost) * 14)) : 1;
      const isToday = i === 6;
      const col = isToday
        ? dark
          ? [255, 255, 255]
          : [45, 45, 45]
        : [128, 128, 128, 180];
      _rect(cv, x, baseline - barH + 1, 4, barH, col);
    }
    const img = encodePNG(cv.w, cv.h, cv.buf, SCALE * 72).toString("base64");
    return `최근 7일 $${sum.toFixed(0)} · 최대 $${maxCost.toFixed(0)}/일 | image=${img} size=11 color=#8b949e`;
  } catch {
    return null;
  }
}

// ── 1c. Claude 실제 rate limit — Anthropic OAuth usage API 직접 조회 ──
// 이 맥의 Claude Code 로그인 토큰(키체인)으로 /usage와 같은 데이터를 서버에서 직접
// 가져온다. 수치는 계정 단위 합산이라 다른 디바이스·데스크톱앱·웹 사용분도 포함.
// 실패 시 폴백: 자체 캐시(마지막 성공 응답) → 레거시 usage-cache.json 파일.
const CLAUDE_STATE_DIR = `${HOME}/.claude/swiftbar`;
const CLAUDE_USAGE_CACHE = `${CLAUDE_STATE_DIR}/.claude-usage.json`;
const LEGACY_USAGE_FILES = [
  `${HOME}/.claude/MEMORY/STATE/usage-cache.json`,
  `${HOME}/.claude/PAI/MEMORY/STATE/usage-cache.json`,
];

// 토큰은 반환값으로만 존재 — 파일·로그·프로세스 인자 어디에도 남기지 않는다
function readClaudeToken() {
  // 옵트아웃: 키체인 접근/라이브 조회를 원치 않으면 `touch ~/.claude/swiftbar/.no-live`
  // — 키체인 프롬프트에서 '거부'를 누르면 2분마다 다시 뜨므로, 그 대신 이 스위치를 쓴다.
  if (existsSync(`${CLAUDE_STATE_DIR}/.no-live`)) return null;
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const t = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (t) return t;
  } catch {}
  try {
    // 키체인이 없는 환경(예: 수동 이전) 대비 — Claude Code의 파일 자격증명
    const raw = readFileSync(`${HOME}/.claude/.credentials.json`, "utf8");
    return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null;
  } catch {}
  return null;
}

function fetchClaudeUsageLive() {
  const token = readClaudeToken();
  if (!token) return null;
  try {
    // Authorization 헤더는 stdin(-H @-)으로 전달 — ps 프로세스 목록에 토큰 노출 방지
    const raw = execSync(
      `/usr/bin/curl -fsS --max-time 5 -H @- -H "anthropic-beta: oauth-2025-04-20" https://api.anthropic.com/api/oauth/usage`,
      {
        encoding: "utf8",
        timeout: 8000,
        input: `Authorization: Bearer ${token}\n`,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const d = JSON.parse(raw);
    if (!d?.five_hour) return null;
    try {
      mkdirSync(CLAUDE_STATE_DIR, { recursive: true });
      writeFileSync(
        CLAUDE_USAGE_CACHE,
        JSON.stringify({ fetchedAt: Math.floor(Date.now() / 1000), data: d }),
      );
    } catch {}
    return { data: d, measuredAt: Math.floor(Date.now() / 1000), live: true };
  } catch {
    return null;
  }
}

function readClaudeUsageFallback() {
  try {
    const c = JSON.parse(readFileSync(CLAUDE_USAGE_CACHE, "utf8"));
    if (c?.data?.five_hour)
      return { data: c.data, measuredAt: c.fetchedAt ?? 0, live: false };
  } catch {}
  for (const f of LEGACY_USAGE_FILES) {
    try {
      const d = JSON.parse(readFileSync(f, "utf8"));
      if (d?.five_hour)
        return {
          data: d,
          measuredAt: Math.floor(statSync(f).mtimeMs / 1000),
          live: false,
        };
    } catch {}
  }
  return null;
}

// 5시간 세션 / 주간 전체 / Fable 주간(weekly_scoped) 사용률
function getClaudeUsage() {
  const src = fetchClaudeUsageLive() ?? readClaudeUsageFallback();
  if (!src) return null;
  const { data: d, measuredAt, live } = src;
  try {
    const toTs = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
    const win = (o) =>
      o ? { pct: o.utilization ?? 0, resetsAt: toTs(o.resets_at) } : null;
    // Fable(또는 최상위 모델) 주간 scoped 한도
    let fable = null;
    for (const l of d.limits || []) {
      const mdl = l.scope?.model?.display_name;
      if (l.group === "weekly" && mdl) {
        fable = {
          pct: l.percent ?? 0,
          resetsAt: toTs(l.resets_at),
          model: mdl,
        };
        break;
      }
    }
    return {
      measuredAt,
      live,
      fiveHour: win(d.five_hour),
      weekly: win(d.seven_day),
      fable,
    };
  } catch {
    return null;
  }
}

// ── 2. Codex: 가장 신선한 rate_limits ──────────────────────
function walkJsonl(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkJsonl(p, out);
    else if (ent.name.endsWith(".jsonl")) {
      try {
        out.push({ path: p, mtime: statSync(p).mtimeMs });
      } catch {}
    }
  }
}
function getCodex() {
  if (!existsSync(CODEX_SESSIONS)) return null;
  const files = [];
  walkJsonl(CODEX_SESSIONS, files);
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, 8)) {
    try {
      const lines = readFileSync(f.path, "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes("rate_limits")) continue;
        let obj;
        try {
          obj = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        const rl = obj.payload?.rate_limits ?? obj.rate_limits;
        // prolite=primary/secondary(%), premium=credits(잔액) — 둘 중 하나라도 있으면 유효
        if (rl && (rl.primary || rl.secondary || rl.credits)) {
          return {
            measuredAt: Math.floor(f.mtime / 1000),
            limitId: rl.limit_id || null,
            plan: rl.plan_type || null,
            primary: rl.primary || null,
            secondary: rl.secondary || null,
            credits: rl.credits || null,
          };
        }
      }
    } catch {}
  }
  return null;
}
function windowState(w) {
  if (!w) return null;
  const stale = w.resets_at && w.resets_at < now;
  return {
    pct: stale ? 0 : (w.used_percent ?? 0),
    resetsIn: w.resets_at ? w.resets_at - now : null,
    stale,
  };
}
// 소진 + 오래됨일 때만 하루 최대 몇 회 Codex를 백그라운드로 굴려 리셋 감지 (throttle 6h)
function maybeAutoRefreshCodex(codex) {
  try {
    if (!codex) return;
    // 소진 판정: credits 소진 OR 어떤 창이든 100% 사용
    let exhausted = false;
    if (codex.credits) {
      const cr = codex.credits;
      exhausted = !cr.unlimited && (!cr.has_credits || Number(cr.balance) <= 0);
    } else {
      const p = windowState(codex.primary),
        s = windowState(codex.secondary);
      exhausted = Boolean((p && p.pct >= 100) || (s && s.pct >= 100));
    }
    if (!exhausted) return;
    if (now - codex.measuredAt < 2 * 3600) return; // 2h+ 오래됐을 때만
    const tsFile = `${HOME}/.claude/swiftbar/.codex-refresh-ts`;
    let last = 0;
    try {
      last = parseInt(readFileSync(tsFile, "utf8").trim(), 10) || 0;
    } catch {}
    if (now - last < 6 * 3600) return; // throttle: 6h 간격 (하루 최대 4회)
    writeFileSync(tsFile, String(now));
    // detached 백그라운드 실행 — 위젯을 막지 않음. 완료되면 세션 로그 갱신됨.
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        `echo "reply ok" | "${CODEX_BIN}" exec --sandbox read-only --skip-git-repo-check - >/dev/null 2>&1`,
      ],
      { detached: true, stdio: "ignore", cwd: HOME },
    );
    child.unref();
  } catch {}
}

// ── 렌더링 ─────────────────────────────────────────────────
const claude = getClaude();
const cusage = getClaudeUsage();
const cmodels = getClaudeModels();
const usageHist = cmodels ? upsertUsageHistory(cmodels) : null;
const codex = getCodex();
maybeAutoRefreshCodex(codex); // 소진+오래됨 시 백그라운드 갱신 (throttle)
const out = [];

// 메뉴바: 배터리 잔량 아이콘 (전부 "남은 %")
//   Claude(usage-cache): C5=5시간세션 · CW=주간전체 · CF=Fable 주간
//   Codex(rate_limits) : X5=5시간 · XW=주간
const rem = (pct) => (pct == null ? null : Math.max(0, 100 - pct));
// 한쪽만 쓰는 사용자 대응: 데이터가 있는 서비스만 표시
const hasClaude = !!cusage || !!(claude && !claude.error);
const hasCodex = !!codex;
const battItems = [];
// Claude — usage-cache 있으면 3종, 없어도 ccusage 블록이 있으면 C5만. 둘 다 없으면 Claude 배터리 생략.
if (cusage) {
  battItems.push({ label: "C5", remain: rem(cusage.fiveHour?.pct) });
  battItems.push({ label: "CW", remain: rem(cusage.weekly?.pct) });
  if (cusage.fable)
    battItems.push({ label: "CF", remain: rem(cusage.fable.pct) });
} else if (claude && !claude.error) {
  battItems.push({ label: "C5", remain: Math.max(0, 100 - claude.elapsedPct) });
}
// Codex — 세션 데이터 있을 때만. Codex 안 쓰는 사람에겐 X 배터리 자체를 안 그림.
if (codex && (codex.primary || codex.secondary)) {
  // prolite: 5시간·주간 % 창
  const p = windowState(codex.primary);
  const s = windowState(codex.secondary);
  battItems.push({ label: "X5", remain: p ? Math.max(0, 100 - p.pct) : null });
  battItems.push({ label: "XW", remain: s ? Math.max(0, 100 - s.pct) : null });
} else if (codex && codex.credits) {
  // premium: 크레딧 잔액 (총량 미제공 → 있음=100 / 소진=0 / 무제한=100)
  const cr = codex.credits;
  const remain = cr.unlimited
    ? 100
    : cr.has_credits && Number(cr.balance) > 0
      ? 100
      : 0;
  battItems.push({ label: "X", remain });
}
// 표시 선택 적용 — premium "X" 라벨은 x5 토글에 귀속. 전부 꺼지면 안전하게 전체 표시(드롭다운 진입로 유지)
const battKey = (label) => (label === "X" ? "x5" : label.toLowerCase());
let visibleItems = battItems.filter((b) => SHOWSET.has(battKey(b.label)));
if (!visibleItems.length) visibleItems = battItems;

// ── 임계값 알림: 20%/10% 하향 돌파 + 리셋 회복(≥95%) macOS 알림 ──
// 숨겨진 배터리도 포함해 battItems 전체를 대상으로 함 (표시 여부와 무관하게 쿼터는 실재)
let worstZone = "ok"; // 말풍선용: 이번 실행에서 관측된 가장 나쁜 배터리 존
{
  const NOTIFY_STATE_FILE = `${HOME}/.claude/swiftbar/.batt-notify-state.json`;
  const zoneOf = (r) => (r <= 10 ? "low10" : r <= 20 ? "low20" : "ok");
  const zoneRank = { ok: 0, low20: 1, low10: 2 };
  let notifyState = {};
  try {
    const parsed = JSON.parse(readFileSync(NOTIFY_STATE_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      notifyState = parsed;
  } catch {}
  for (const item of battItems) {
    if (item.remain == null) continue;
    const key = battKey(item.label);
    // Codex 창이 3시간+ 오래되면 리셋됐을 수 있어 판정 자체를 건너뜀 (오탐 방지, line ~983 staleWarn과 동일 기준)
    if (
      (key === "x5" || key === "xw") &&
      codex &&
      now - codex.measuredAt > 3 * 3600
    )
      continue;
    const remain = Math.round(item.remain);
    const zone = zoneOf(remain);
    if (zoneRank[zone] > zoneRank[worstZone]) worstZone = zone;
    const prevZone = notifyState[key]?.zone || "ok";
    if (zone !== prevZone && NOTIFY !== "off") {
      const label = battLabels[key] || key;
      if (prevZone === "ok" && zone === "low20") {
        fireNotification(`⚠️ ${label} 잔량 ${remain}%`);
      } else if (
        (prevZone === "ok" || prevZone === "low20") &&
        zone === "low10"
      ) {
        fireNotification(`🚨 ${label} 잔량 ${remain}%`);
      } else if (
        (prevZone === "low20" || prevZone === "low10") &&
        zone === "ok" &&
        remain >= 95
      ) {
        fireNotification(`🔋 ${label} 리셋 — 잔량 ${remain}%`);
      }
      // (low20|low10)→ok remain<95, low10→low20: 조용히 zone만 갱신(소음 방지)
    }
    notifyState[key] = { zone };
  }
  try {
    mkdirSync(dirname(NOTIFY_STATE_FILE), { recursive: true });
    writeFileSync(NOTIFY_STATE_FILE, JSON.stringify(notifyState));
  } catch {}
}

// ── C5(Claude 5시간) 소진 페이스 예측: 최근 90분 샘플의 기울기로 리셋 전 소진 여부를 투영 ──
const BURN_FILE = `${HOME}/.claude/swiftbar/.batt-burn.json`;
let c5ProjectionRow = null;
let c5Depleting = false; // 말풍선용: 리셋 전 소진 예측 여부
let c5DepleteT = null; // 말풍선용: 예상 소진 시각(epoch초)
{
  try {
    const w = cusage?.fiveHour;
    if (w && typeof w.resetsAt === "number" && w.resetsAt > now) {
      let state = null;
      try {
        const parsed = JSON.parse(readFileSync(BURN_FILE, "utf8"));
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.resetsAt === "number" &&
          Array.isArray(parsed.samples)
        )
          state = parsed;
      } catch {}
      if (!state) state = { resetsAt: w.resetsAt, samples: [], notifiedAt: 0 };
      if (typeof state.notifiedAt !== "number") state.notifiedAt = 0;
      // 리셋 시각이 바뀌었다 = 새 블록 시작 → 샘플 초기화
      if (Math.abs(state.resetsAt - w.resetsAt) > 600) {
        state = { resetsAt: w.resetsAt, samples: [], notifiedAt: 0 };
      }
      const remainNow = 100 - (w.pct ?? 0);
      const prevLast = state.samples[state.samples.length - 1] || null;
      state.samples.push({ t: now, remain: remainNow });
      state.samples = state.samples.filter((s) => now - s.t <= 90 * 60);
      // 직전 샘플보다 잔량이 5%p 넘게 급상승 = 블록 중간 이상치(계정 단위 회복 등) → 새 샘플만 유지
      if (prevLast && remainNow - prevLast.remain > 5) {
        state.samples = [{ t: now, remain: remainNow }];
      }
      const first = state.samples[0];
      const last = state.samples[state.samples.length - 1];
      if (state.samples.length >= 3 && last.t - first.t >= 15 * 60) {
        const rate = (first.remain - last.remain) / (last.t - first.t); // %/sec
        if (rate > 0) {
          const depleteT = now + last.remain / rate;
          if (depleteT < state.resetsAt) {
            c5ProjectionRow = `      예상 소진 ${hhmm(depleteT)} ⚠️ 리셋(${hhmm(state.resetsAt)}) 전 소진 페이스 | font=Menlo size=11 color=#FF453A`;
            c5Depleting = true;
            c5DepleteT = depleteT;
            if (NOTIFY !== "off" && state.notifiedAt !== state.resetsAt) {
              fireNotification(
                `⏳ Claude 5시간 — 현재 페이스면 ${hhmm(depleteT)} 소진 (리셋 ${hhmm(state.resetsAt)} 전)`,
              );
              state.notifiedAt = state.resetsAt;
            }
          } else {
            c5ProjectionRow = `      페이스 −${(rate * 3600).toFixed(1)}%/h · 리셋까지 여유 | font=Menlo size=11 color=#8b949e`;
          }
        }
      }
      mkdirSync(dirname(BURN_FILE), { recursive: true });
      writeFileSync(BURN_FILE, JSON.stringify(state));
    }
  } catch {}
}

// ── 펫 말풍선: 데이터 기반 코멘트 한 줄 (우선순위 1~7, 첫 매치 채택) ──
// 이번 실행에서 이미 계산된 값만 재사용(신규 파일 읽기·프로세스 실행 없음).
// { msg, pri } 반환 — pri는 팝업 트리거(claude-pet.streamable.js)가 고우선순위(<=3)만 골라내는 데 사용.
function speechBubbleRow() {
  if (!cusage && !cmodels) return null; // 데이터 자체가 없으면 행 생략
  if (c5Depleting && c5DepleteT != null) {
    return {
      msg: `이 페이스면 ${hhmm(c5DepleteT)}에 방전이에요… 쉬엄쉬엄요 🥵`,
      pri: 1,
    };
  }
  if (BUDGET > 0) {
    const monthly = monthlyUsageRow(usageHist);
    if (monthly && monthly.curSum / BUDGET >= 1) {
      return { msg: "이번 달 예산을 넘겼어요 💸", pri: 2 };
    }
  }
  if (worstZone === "low10")
    return { msg: "간식(쿼터)이 거의 없어요… 🥺", pri: 3 };
  if (worstZone === "low20")
    return { msg: "간식이 얼마 안 남았어요 🥺", pri: 4 };
  const c5Remain =
    cusage?.fiveHour?.pct != null ? 100 - cusage.fiveHour.pct : null;
  if (c5Remain != null && c5Remain >= 95) {
    return { msg: "풀충전! 달릴 준비 됐어요 ⚡", pri: 5 };
  }
  if (c5Remain != null && c5Remain < 95 && cmodels?.total >= 100) {
    return {
      msg: `열일 중… 오늘 벌써 $${Math.round(cmodels.total)} 태웠어요 🔥`,
      pri: 6,
    };
  }
  return { msg: "오늘도 무사히 굴러가는 중이에요 🛞", pri: 7 };
}

// 잔량 숫자가 캡슐 안에 들어감 → 메뉴바는 이미지만. 라벨은 드롭다운 범례.
// 둘 다 없으면(신규/양쪽 미사용) 배터리 대신 안내 아이콘.
const dark = isDarkMode(); // 배터리 아이콘 + 스파크라인 공용 — 매번 다시 조회하지 않는다
if (battItems.length) {
  if (DISPLAY === "text") {
    out.push(`${compactBattText(visibleItems)} | font=Menlo size=12`);
  } else {
    out.push(`| image=${renderBatteryImage(dark, visibleItems)}`);
  }
} else {
  out.push("🔋 —");
}
out.push("---");
const codexLegend =
  codex?.credits && !codex.primary && !codex.secondary
    ? "X = Codex 크레딧"
    : "X5·XW = Codex 5시간·주간";
const legendParts = [];
if (hasClaude) legendParts.push("C5·CW·CF = Claude 5시간·주간·Fable");
if (hasCodex) legendParts.push(codexLegend);
if (legendParts.length) {
  out.push(
    `🔋 남은 %  ·  ${legendParts.join("  ·  ")} | size=11 color=#8b949e`,
  );
  const bubble = speechBubbleRow();
  if (bubble) out.push(`💬 ${bubble.msg} | size=12`);
  // 펫 플러그인(claude-pet.streamable.js)이 드롭다운·팝업에 재사용할 수 있도록 공유 파일에 기록
  try {
    if (bubble) {
      const PET_BUBBLE_MSG_FILE = `${HOME}/.claude/swiftbar/.pet-bubble-msg.json`;
      mkdirSync(dirname(PET_BUBBLE_MSG_FILE), { recursive: true });
      writeFileSync(
        PET_BUBBLE_MSG_FILE,
        JSON.stringify({ msg: bubble.msg, pri: bubble.pri, t: now }),
      );
    }
  } catch {}
  out.push("---");
}

// Claude 상세 — hasClaude일 때만 (Claude Code 안 쓰면 섹션 자체 생략)
if (hasClaude) {
  out.push("Claude Code | size=13 color=#8b949e");
  if (cusage) {
    const winRow = (label, w) => {
      if (!w) return;
      const r = Math.max(0, 100 - (w.pct ?? 0));
      const reset = w.resetsAt
        ? w.resetsAt < now
          ? "리셋됨"
          : `리셋 ${fmtDur(w.resetsAt - now)}`
        : "";
      out.push(
        `${label} ▕${bar(r, 20)}▏ ${Math.round(r)}%  (사용 ${Math.round(w.pct ?? 0)}%)${reset ? "  ·  " + reset : ""} | font=Menlo color=${heatRemainHex(r)}`,
      );
    };
    winRow("5시간 남음", cusage.fiveHour);
    if (c5ProjectionRow) out.push(c5ProjectionRow);
    winRow("주간 남음 ", cusage.weekly);
    if (cusage.fable) winRow(`${cusage.fable.model} 남음`, cusage.fable);
    out.push(
      cusage.live
        ? `라이브 (Anthropic usage API — 전 디바이스 합산) | size=11 color=#8b949e`
        : `측정 ${fmtDur(now - cusage.measuredAt)} 전 (캐시 폴백 — Claude Code 로그인·네트워크 확인) | size=11 color=#d29922`,
    );
  }
  if (claude && !claude.error) {
    out.push(
      `블록 비용  $${claude.cost.toFixed(2)}  ·  ${fmtTok(claude.tokens)} 토큰  ·  $${claude.costPerHour?.toFixed(1) ?? "?"}/h | font=Menlo size=11 color=#8b949e`,
    );
  }
  // 오늘 모델별 사용 (최대 모델 대비 막대)
  if (cmodels && cmodels.models.length) {
    out.push(
      `오늘 모델별  ·  합 $${cmodels.total.toFixed(0)} | size=11 color=#8b949e`,
    );
    const maxCost = cmodels.models[0].cost || 1;
    for (const m of cmodels.models) {
      const g = bar((m.cost / maxCost) * 100, 12);
      const label = shortModel(m.name).padEnd(9, " ");
      out.push(
        `${label}▕${g}▏ $${m.cost.toFixed(1)}  ${fmtTok(m.tokens)} | font=Menlo`,
      );
    }
    const monthly = monthlyUsageRow(usageHist);
    if (monthly) {
      out.push(monthly.row);
      if (BUDGET > 0) checkBudgetAlert(monthly.curSum);
    }
    const sparkRow = sparklineRow(usageHist, dark);
    if (sparkRow) out.push(sparkRow);
  }
  out.push("---");
}

// Codex 상세 — hasCodex일 때만 (Codex 안 쓰면 섹션 자체 생략)
if (hasCodex) {
  out.push(
    `Codex${codex?.plan ? " · " + codex.plan : codex?.limitId ? " · " + codex.limitId : ""} | size=13 color=#8b949e`,
  );
  const p = windowState(codex.primary);
  const s = windowState(codex.secondary);
  // premium: primary/secondary 없이 크레딧 잔액만
  if (!p && !s && codex.credits) {
    const cr = codex.credits;
    if (cr.unlimited) {
      out.push("크레딧  무제한 | font=Menlo color=#3fb950");
    } else if (!cr.has_credits || Number(cr.balance) <= 0) {
      out.push("크레딧  소진 · 한도 초과 (0) | font=Menlo color=#f85149");
      out.push(
        "      Codex 설정에서 크레딧 구매 또는 리셋 대기 | font=Menlo size=11 color=#8b949e",
      );
    } else {
      out.push(`크레딧  잔액 ${cr.balance} | font=Menlo color=#3fb950`);
    }
  }
  if (p) {
    const reset = p.stale
      ? "리셋됨"
      : p.resetsIn != null
        ? `리셋 ${fmtDur(p.resetsIn)}`
        : "";
    const pr = Math.max(0, 100 - p.pct);
    out.push(
      `5시간 남음 ▕${bar(pr, 20)}▏ ${Math.round(pr)}%  (사용 ${Math.round(p.pct)}%) | font=Menlo color=${heatRemainHex(pr)}`,
    );
    out.push(`      ${reset} | font=Menlo size=11 color=#8b949e`);
  }
  if (s) {
    const reset = s.stale
      ? "리셋됨"
      : s.resetsIn != null
        ? `리셋 ${fmtDur(s.resetsIn)}`
        : "";
    const sr = Math.max(0, 100 - s.pct);
    out.push(
      `주간 남음  ▕${bar(sr, 20)}▏ ${Math.round(sr)}%  (사용 ${Math.round(s.pct)}%) | font=Menlo color=${heatRemainHex(sr)}`,
    );
    out.push(`      ${reset} | font=Menlo size=11 color=#8b949e`);
  }
  const age = now - codex.measuredAt;
  const staleWarn = age > 3 * 3600; // 3시간+ 오래됨 → 리셋됐을 수 있음
  out.push(
    `측정 ${fmtDur(age)} 전${staleWarn ? "  ·  ⚠ 리셋됐을 수 있음, Codex 쓰면 갱신" : " (Codex 세션 기준)"} | size=11 color=${staleWarn ? "#d29922" : "#8b949e"}`,
  );
  out.push("---");
}

// 둘 다 없으면(신규/양쪽 미사용) 안내
if (!hasClaude && !hasCodex) {
  out.push(
    "Claude Code나 Codex를 실행하면 사용량이 표시됩니다 | size=12 color=gray",
  );
  out.push("---");
}

// 새 버전이 있으면 강조 원클릭 업데이트, 없어도 수동 업데이트 행은 항상 노출
const upd = getUpdateInfo();
if (upd.hasUpdate) {
  out.push(
    `🆕 v${upd.latest} 업데이트 (현재 v${VERSION}) | bash="${SELF_DIR}/.ccb-update.sh" terminal=false refresh=true color=#28963f`,
  );
} else {
  out.push(
    `⬆️ 지금 업데이트 — GitHub 최신으로 교체 (현재 v${VERSION}) | bash="${SELF_DIR}/.ccb-update.sh" terminal=false refresh=true`,
  );
}
out.push("🔄 지금 새로고침 | refresh=true");
// ccusage가 있을 때만(선택 의존) 대시보드 바로가기 노출
if (claude && !claude.error) {
  out.push(
    `📊 ccusage 대시보드 열기 | bash="${CCUSAGE}" param1=blocks param2=--active terminal=true`,
  );
}
out.push(
  `v${VERSION}  ·  Claude & Codex Usage Battery | size=11 color=#8b949e`,
);
// 배터리 설정 서브메뉴 — 크기 / 채움 색 / 글자 크기. 옵션 클릭 시 해당 설정 파일에 값을 기록하고 새로고침
{
  const SETTINGS_DIR = `${HOME}/.claude/swiftbar`;
  const settingRow = (label, active, file, val) =>
    out.push(
      `-- ${active ? "✓ " : ""}${label} | bash=/bin/sh param1=-c param2="mkdir -p '${SETTINGS_DIR}' && echo ${val} > '${file}'" terminal=false refresh=true size=11 color=#8b949e`,
    );
  // 테마 프리셋: 채움 색·글자 색·글자 크기를 한 번에 세팅하는 원클릭 행 (✓ 로직 없음 — 프리셋은 상태가 아니라 동작)
  const themeRow = (label, { fill, text, font }) =>
    out.push(
      `-- ${label} | bash=/bin/sh param1=-c param2="mkdir -p '${SETTINGS_DIR}' && echo ${fill} > '${FILL_FILE}' && echo ${text} > '${TEXT_FILE}' && echo ${font} > '${FONT_FILE}'" terminal=false refresh=true size=11 color=#8b949e`,
    );
  out.push("⚙️ 배터리 설정 | size=11 color=#8b949e");
  settingRow(
    "표시 방식: 배터리 이미지",
    DISPLAY === "image",
    DISPLAY_FILE,
    "image",
  );
  settingRow(
    "표시 방식: 컴팩트 텍스트",
    DISPLAY === "text",
    DISPLAY_FILE,
    "text",
  );
  out.push("-- 🎨 테마 프리셋 | size=11 color=#8b949e");
  themeRow("테마: 미니멀", { fill: "white", text: "auto", font: "80" });
  themeRow("테마: 신호등 클래식", {
    fill: "traffic",
    text: "auto",
    font: "90",
  });
  themeRow("테마: 게임보이", { fill: "green", text: "black", font: "90" });
  themeRow("테마: 네온", { fill: "neon", text: "black", font: "90" });
  settingRow("크기: 크게", SIZE === "big", SIZE_FILE, "big");
  settingRow("크기: 작게", SIZE === "small", SIZE_FILE, "small");
  const up = Math.min(200, SIZEPCT + 5);
  const down = Math.max(50, SIZEPCT - 5);
  settingRow(
    `전체 크기 +5% → ${up}% (현재 ${SIZEPCT}%)`,
    false,
    SCALE_FILE,
    String(up),
  );
  settingRow(
    `전체 크기 −5% → ${down}% (현재 ${SIZEPCT}%)`,
    false,
    SCALE_FILE,
    String(down),
  );
  for (const k of ALL_BATTS) {
    const on = SHOWSET.has(k);
    const next = ALL_BATTS.filter((b) => (b === k ? !on : SHOWSET.has(b)));
    settingRow(
      `표시: ${battLabels[k]}`,
      on,
      SHOW_FILE,
      next.length ? next.join(",") : "none",
    );
  }
  settingRow(
    NOTIFY === "on" ? "알림: 켜짐 — 20%/10% 하향·리셋 회복 시" : "알림: 꺼짐",
    NOTIFY === "on",
    NOTIFY_FILE,
    NOTIFY === "on" ? "off" : "on",
  );
  settingRow("채움 색: 신호등", FILL === "traffic", FILL_FILE, "traffic");
  settingRow("채움 색: 흰색", FILL === "white", FILL_FILE, "white");
  settingRow("채움 색: 초록", FILL === "green", FILL_FILE, "green");
  settingRow("채움 색: 네온", FILL === "neon", FILL_FILE, "neon");
  settingRow("글자 색: 자동", TEXTCOL === "auto", TEXT_FILE, "auto");
  settingRow("글자 색: 검정", TEXTCOL === "black", TEXT_FILE, "black");
  settingRow("글자 색: 흰색", TEXTCOL === "white", TEXT_FILE, "white");
  settingRow("글자 색: 빨강", TEXTCOL === "red", TEXT_FILE, "red");
  settingRow("글자 색: 파랑", TEXTCOL === "blue", TEXT_FILE, "blue");
  settingRow("글자 크기: 100%", FONTPCT === 100, FONT_FILE, "100");
  settingRow("글자 크기: 90%", FONTPCT === 90, FONT_FILE, "90");
  settingRow("글자 크기: 80%", FONTPCT === 80, FONT_FILE, "80");
  settingRow("글자 크기: 70%", FONTPCT === 70, FONT_FILE, "70");
  // 펫 플러그인(claude-pet.streamable.js) 상태 행 — SwiftBar의 DisabledPlugins 목록으로 판정.
  // 구 방식(off 확장자 rename 존재 여부 체크)은 폐기 — SwiftBar가 그 파일도 그대로 실행해버려 무의미했다.
  const PET_FILE_NAME = "claude-pet.streamable.js";
  let disabledPlugins = "";
  try {
    disabledPlugins = execSync(
      "defaults read com.ameba.SwiftBar DisabledPlugins 2>/dev/null",
      { encoding: "utf8", timeout: 3000 },
    );
  } catch {
    disabledPlugins = ""; // 조회 실패는 "꺼져있지 않음"으로 간주
  }
  if (disabledPlugins.includes(PET_FILE_NAME)) {
    out.push(
      `-- 펫: 꺼짐 — 클릭하면 켜기 | bash=/usr/bin/open param1=-g param2=swiftbar://enableplugin?name=${PET_FILE_NAME} terminal=false size=11 color=#8b949e`,
    );
  } else if (existsSync(join(SELF_DIR, PET_FILE_NAME))) {
    out.push("-- 펫: 켜짐 — 끄려면 펫 드롭다운에서 | size=11 color=#8b949e");
  }
}
out.push(
  `⭐ github.com/dennykim123/claude-codex-battery | href=https://github.com/dennykim123/claude-codex-battery size=11 color=#8b949e`,
);
// 위젯 끄기 — SwiftBar의 플러그인 비활성화 URL. 재활성화: SwiftBar 메뉴 → Plugins
out.push(
  `✕ 위젯 끄기 (SwiftBar 설정에서 재활성화) | href=swiftbar://disableplugin?plugin=claude-codex-usage size=11 color=#8b949e`,
);

console.log(out.join("\n"));
