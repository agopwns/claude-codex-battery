# CLAUDE.md

Claude/Codex 사용량을 macOS 메뉴바에 배터리+픽셀 펫으로 보여주는 SwiftBar 플러그인.
dennykim123/claude-codex-battery(MIT)의 **개인 포크** — origin=agopwns(내 포크), upstream=원본.
로드맵/작업 이력은 `TODO.md`, 사용자(Jun)의 설정 취향은 그대로 유지할 것.

## 구성 (3개 산출물)

| 파일                       | 역할                                                           | 설치 위치                                       |
| -------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| `claude-codex-usage.2m.js` | 본체: 배터리 렌더+usage 수집+알림+스냅샷. 2분 주기             | `~/.swiftbar-plugins/`                          |
| `claude-pet.streamable.js` | 픽셀 펫: SwiftBar streamable(상주 스트림), 상태머신+애니메이션 | `~/.swiftbar-plugins/`                          |
| `pet-bubble.swift`         | 네이티브 말풍선(NSPanel) 헬퍼 CLI                              | swiftc로 `~/.claude/swiftbar/pet-bubble` 컴파일 |

데이터 흐름: 본체가 `~/.claude/swiftbar/`에 상태 파일을 남기고(단일 SoT), 펫이 매 프레임 읽어서 표시/팝업. 플러그인 간 import 금지 — 펫은 자체 PNG 인코더 사본을 가짐.

## 배포 절차 (수정 후 반드시)

```bash
# 1. 버전 범프: 본체의 `const VERSION` + VERSION 파일 동기화 (self-update가 포크 VERSION 파일과 비교)
# 2. 설치 (shebang을 bun 절대경로로 교체해서 복사 — SwiftBar는 GUI라 PATH 제한적)
sed "1s|.*|#!$(command -v bun)|" claude-codex-usage.2m.js > ~/.swiftbar-plugins/claude-codex-usage.2m.js && chmod +x ~/.swiftbar-plugins/claude-codex-usage.2m.js
sed "1s|.*|#!$(command -v bun)|" claude-pet.streamable.js > ~/.swiftbar-plugins/claude-pet.streamable.js && chmod +x ~/.swiftbar-plugins/claude-pet.streamable.js
xcrun swiftc -O pet-bubble.swift -o ~/.claude/swiftbar/pet-bubble   # Swift 수정 시
# 3. 반영
pkill -f "claude-pet.streamable"; open -g "swiftbar://refreshallplugins"
# 4. 커밋 + push origin main (자동 업데이트 버튼이 포크 main의 raw를 받아옴)
```

검증 습관: 본체는 `bun claude-codex-usage.2m.js | head`로 출력 확인, 이미지가 바뀌면 base64 디코드→`sips`/Read로 눈 검수, 메뉴바 실물은 `screencapture -x -R"x,0,w,26"`.

## 설정/상태 파일 (`~/.claude/swiftbar/`)

- 설정(사용자 선택, 절대 임의 초기화 금지): `.batt-size`(big/small) `.batt-scale`(50~~200%) `.batt-fill`(traffic/white/green/neon) `.batt-text`(auto/black/white/red/blue) `.batt-font`(70~~100) `.batt-show`(CSV c5,cw,cf,x5,xw) `.batt-display`(image/text) `.batt-notify`(on/off) `.batt-budget`(USD, 수동) `.batt-anomaly`(off/normal/sensitive) `.pet-species` `.pet-scale`(50~250%) `.pet-bubble`(on/off)
- 상태(플러그인이 관리): `.usage-snapshot.json`(수집 캐시 — 렌더는 이것만 읽고, `--collect` 분리 프로세스가 갱신) `.collect.lock`(수집 중복 방지, TTL 90s) `.claude-usage.json`(usage API 캐시) `usage-history.json`(일별 스냅샷, ROI 데이터 — 삭제 금지) `.batt-burn.json`(C5 샘플) `.batt-notify-state.json` `.batt-budget-state.json` `.pet-bubble-msg.json` `.pet-bubble-shown.json` `.update-check.json`

## 코드 컨벤션

- prettier 스타일(더블쿼트·세미콜론, 저장 시 훅이 자동 포맷), 주석은 한국어
- 설정 읽기는 try/catch+화이트리스트 폴백 패턴, 상태 파일은 자가 복구(깨지면 {}부터)
- 렌더 실패가 메뉴바를 죽이면 안 됨 — 행 생성/팝업/스냅샷은 전부 try/catch로 격리
- 알림·서브프로세스는 detached spawn+unref (렌더 블로킹 금지)

## 핵심 도메인 지식 (실측으로 확인된 것들)

- **표시 크기 = pHYs DPI 트릭**: PNG에 dpi 선언 → 표시 pt = px×72/dpi. 크기 %는 dpi 역비례. 100%(레티나 1:1)가 가장 선명
- **SwiftBar streamable**: `<swiftbar.type>streamable</swiftbar.type>`, 프레임마다 `~~~` 줄 + 전체 블록 출력. 파일명 주기는 무시됨
- **⚠️ SwiftBar는 `.js.off` 같은 파일도 실행함** — 플러그인 비활성화는 반드시 URL 스킴(`swiftbar://disableplugin?name=<파일명>`). 상태는 defaults `com.ameba.SwiftBar` `DisabledPlugins` 배열
- **펫 AX 앵커링**: 말풍선 헬퍼가 접근성 API로 SwiftBar 메뉴바 아이템 스캔, 펫=무제목+폭 22~42pt(≈34) 휴리스틱. 호출 프로세스가 AX trusted여야 함(아니면 고정 오프셋 폴백). SwiftBar가 스폰하는 자동 팝업은 SwiftBar에 손쉬운 사용 권한 필요
- **노치 맥북 메뉴바**: 공간 부족 시 왼쪽 상태 아이콘부터 통째로 숨김(좌표가 화면 밖으로 밀림). 대응=`.batt-show` 축소·텍스트 모드·⌘드래그 정리
- **ccusage 로그는 ~30일 보존** → `usage-history.json` 일별 스냅샷이 영구 기록 (월간 ROI 보고서 데이터원)
- Codex 데이터는 `~/.codex/sessions` 로그 파싱이라 스테일 가능 — 3h+ 경과 시 알림/판정 제외 패턴 유지

## upstream 추종

```bash
git fetch upstream && git rebase upstream/main   # 충돌 시 커스텀(우리 쪽) 우선, REPO_RAW는 반드시 agopwns 유지
```
