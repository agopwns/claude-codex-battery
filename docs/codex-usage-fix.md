# Codex 한도 표시 수정 — 2026-09-05

v1.16.0은 최근 수정된 세션 8개 중 첫 rate_limits를 읽어 Spark 전용 0%를 일반 Codex로 표시했다. 일반 Codex가 primary에 주간(10080분)만 보내는 경우에도 이를 5시간으로 표시했다. 파일 수정 시각은 사용량 측정 시각이 아니므로 오래된 이벤트도 최신처럼 보였다.

v1.16.1은 일반 codex(구형 ID 미제공 포함)만 선택하고 이벤트 timestamp로 비교한다. 파일 mtime은 탐색 상한으로만 사용한다. 300분/10080분 창을 fiveHour/weekly에 매핑해 배터리, 상세, 리셋 타임라인, 알림이 함께 사용한다. 없는 창은 배터리에서 생략하고 상세에 데이터 미제공으로 표시한다. 스냅샷 v2로 기존 오선택 캐시를 무효화한다. 구독 한도가 있는 계정에서 추가 credits 0을 한도 소진으로 오인해 자동 실행하는 것도 방지한다.

검증: `node --test tests/codex-usage.test.cjs` — tests 9, pass 9, fail 0. `node --check claude-codex-usage.2m.js` — exit 0. 테스트는 임시 로그와 부작용을 차단한 전체 렌더를 사용한다. 실제 로그에서도 일반 Codex의 주간 한도가 선택됨을 확인했다.

함정: primary/secondary는 기간명이 아니다. Spark의 limit_id는 codex_bengalfox다. 원본 응답에서 없는 5시간 창을 오래된 다른 응답이나 Spark 데이터로 채우면 안 된다.

설치 검증: 기존 설치본을 숨김 파일 `.claude-codex-usage.v1.16.0.pre-codex-fix.js`로 백업하고 v1.16.1을 반영했다. 실제 `--collect`와 렌더 실행(exit 0) 후 출력:

```text
Codex · pro
주간 남음 … 97% (사용 3%)
5시간 한도 · 데이터 미제공
다음 회복 C5 38m → CW 2d 12h → XW 6d 19h
```

`swiftbar://refreshallplugins` 호출 exit 0. 화면 캡처는 Orca runtime_unavailable(app running=false)로 미실시. 렌더 출력은 `/private/tmp/ccb-codex-fixed-menu.txt`에서 확인했다.
