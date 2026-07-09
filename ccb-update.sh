#!/bin/bash
# Claude & Codex Usage Battery — self-update
# 위젯 드롭다운의 "🆕 업데이트"에서 호출됨. 최신 스크립트를 내려받아 제자리 교체.
set -e
RAW="https://raw.githubusercontent.com/agopwns/claude-codex-battery/main"
DEST_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$DEST_DIR/claude-codex-usage.2m.js"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
TMP="$(mktemp)"

echo "최신 버전을 내려받는 중..."
curl -fsSL --max-time 20 "$RAW/claude-codex-usage.2m.js" -o "$TMP"

# 무결성 최소 검증 — 제대로 받았는지 (shebang + 핵심 함수 존재)
if ! head -1 "$TMP" | grep -q "bun" || ! grep -q "renderBatteryImage" "$TMP"; then
  echo "❌ 다운로드 검증 실패 — 업데이트를 중단합니다."
  rm -f "$TMP"
  exit 1
fi

# 이전본 백업 후 교체 (shebang을 이 환경의 bun 경로로)
[ -f "$DEST" ] && cp "$DEST" "$DEST.bak"
sed "1s|.*|#!$BUN|" "$TMP" > "$DEST"
chmod +x "$DEST"
rm -f "$TMP"

# 버전 캐시 초기화 + SwiftBar 새로고침
rm -f "$HOME/.claude/swiftbar/.update-check.json" 2>/dev/null || true
open "swiftbar://refreshallplugins" 2>/dev/null || true

echo "✅ 최신으로 업데이트했습니다. (이전본: $DEST.bak)"
