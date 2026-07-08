#!/bin/bash
# Claude & Codex 사용량 배터리 위젯 — 설치 스크립트
set -e
cd "$(dirname "$0")"

echo "🔋 Claude & Codex Usage Battery — 설치"
echo "────────────────────────────────────"

# 1) bun (필수)
if ! command -v bun >/dev/null 2>&1; then
  echo "❌ bun이 없습니다. 먼저 설치하세요:"
  echo "   curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
BUN=$(command -v bun)
echo "✅ bun: $BUN"

# 2) SwiftBar (필수)
if [ ! -d "/Applications/SwiftBar.app" ]; then
  echo "❌ SwiftBar가 없습니다. 먼저 설치하세요:"
  echo "   brew install swiftbar"
  exit 1
fi
echo "✅ SwiftBar"

# 3) ccusage (없으면 자동 설치)
if ! command -v ccusage >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/ccusage" ]; then
  echo "ℹ️  ccusage 설치 중..."
  bun install -g ccusage
fi
echo "✅ ccusage"

# 4) codex (선택 — 없으면 Codex 배터리는 안 뜨고 Claude만 표시)
if command -v codex >/dev/null 2>&1; then
  echo "✅ codex CLI (Codex 배터리 표시됨)"
else
  echo "ⓘ  codex CLI 없음 — Claude 배터리만 표시됩니다"
fi

# 5) 플러그인 배치 (shebang을 이 환경의 bun 절대경로로 — SwiftBar는 GUI라 PATH가 제한적)
PLUGIN_DIR="${SWIFTBAR_PLUGIN_DIR:-$HOME/.swiftbar-plugins}"
mkdir -p "$PLUGIN_DIR"
sed "1s|.*|#!$BUN|" claude-codex-usage.1m.js > "$PLUGIN_DIR/claude-codex-usage.1m.js"
chmod +x "$PLUGIN_DIR/claude-codex-usage.1m.js"
echo "✅ 플러그인 배치: $PLUGIN_DIR"

# 6) SwiftBar에 폴더 지정 + 실행
BID=$(defaults read /Applications/SwiftBar.app/Contents/Info CFBundleIdentifier 2>/dev/null || echo "com.ameba.SwiftBar")
defaults write "$BID" PluginDirectory -string "$PLUGIN_DIR"
open -a SwiftBar

echo "────────────────────────────────────"
echo "✅ 완료! 메뉴바 오른쪽에 배터리가 뜹니다."
echo "   갱신 주기: 1분 (파일명 .1m. 을 .30s. 등으로 바꾸면 조정)"
