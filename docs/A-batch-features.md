# Batch A 지시서: 리마인더 메일 · 노쇼 이력 · 영어투어 시간 단일화

> 이 문서 하나만 보고 작업하세요. 판단이 필요하면 임의로 정하지 말고 멈추거나 최종 보고에 명시.

## [컨텍스트 고정 — 위반 금지]

- 프로젝트: `~/Desktop/raim-en`. Express 4 + EJS + Node 내장 `node:sqlite`(Node 26). **새 npm 의존성 추가 금지.**
- DB 접근은 `src/db.js` 기존 패턴(`db.prepare(...).run/get/all`), 마이그레이션은 기존 `ensureColumn` 헬퍼 사용.
- 날짜는 반드시 `src/helpers.js`의 `todayStr()/addDays()` (KST) 사용. `new Date()` 직접 계산 금지.
- git commit 금지. 지시 범위 밖 리팩터링 금지. `docs/` 수정 금지.
- 기존 테스트 49개는 계속 통과해야 한다 (`npm test`).

## [검증 하네스 노트 — 상설]

- 수동 검증 서버: `PORT=4325 npm start` 백그라운드, 끝나면 종료. 검증은 **curl 우선**, 브라우저는 시각 확인만.
- 모든 POST는 CSRF 필요: GET으로 `raim.csrf` 쿠키+폼의 `_csrf` 획득 → POST에 쿠키·토큰 동봉. `tests/helper.js`에 이미 구현돼 있으니 재사용.
- rate limit: `POST /reserve`는 IP당 10분 5회. 테스트는 파일마다 새 서버 인스턴스(helper의 `startApp`)라 리셋됨.

## [작업]

### A1. 스키마·설정

- `src/db.js`: `ensureColumn('reservations', 'reminder_sent', 'reminder_sent INTEGER NOT NULL DEFAULT 0')`
- settings 기본값에 `noshow_retention_days: '365'` 추가.
- `src/routes/admin.js` settings 저장 keys 배열과 `views/admin/settings.ejs`에 해당 항목 추가
  (label: `No-show record retention (days)` — Personal data retention 항목 바로 아래, min 1 max 3650).

### A2. 리마인더 메일 (`src/mailer.js`)

- `reminderEmail(r)` 추가 — 기존 `baseTemplate` 사용, 영어. 제목은 라우트가 아니라 호출부에서:
  `[Seoul RAIM] Reminder — your visit is tomorrow (${r.code})`
- 본문 필수 요소: 인사(${r.name}), 내일 방문 안내, 예약 정보 표(code/tour(fmtSlot)/party), "arrive 10 minutes early, 1F desk",
  오시는 길 한 줄(Chang-dong Stn Exit 1), "플랜이 바뀌면 My Booking에서 취소" 문구. 이모지 금지.

### A3. 스케줄러·보존정책 (`src/maintenance.js`)

- `async function sendReminders()` 신규 export:
  - 대상: `status='confirmed' AND visit_date = addDays(todayStr(), 1) AND reminder_sent = 0` (slots JOIN으로 시간 포함)
  - 각 건: `mailer.sendMail(...)` await → `UPDATE reservations SET reminder_sent=1 WHERE id=?`
  - 보낸 건수 > 0이면 `console.log('[reminder] sent N')`. 반환값: 보낸 건수.
- `start()`: 부팅 시 `sendReminders()` 1회 + `setInterval` 1시간 주기(`.unref()`). 기존 purge 로직 유지.
- `purgeOldData()` 수정 — 노쇼 보존 b안:
  - 일반: `DELETE FROM reservations WHERE visit_date < cutoffGeneral AND status != 'no_show'` (cutoffGeneral = today − retention_days)
  - 노쇼: `DELETE FROM reservations WHERE status='no_show' AND visit_date < cutoffNoshow` (cutoffNoshow = today − max(noshow_retention_days, retention_days))
  - email_log는 기존대로 retention_days 기준. 로그 메시지에 noshow 삭제 건수도 포함.

### A4. 노쇼 이력 배지 (admin)

- `src/routes/admin.js`의 대시보드 pending 쿼리와 `/reservations` 목록 쿼리에 서브쿼리 추가:
  `(SELECT COUNT(*) FROM reservations n WHERE n.email = r.email AND n.status = 'no_show') AS noshow_count`
- `views/admin/dashboard.ejs`(pending 테이블 Visitor 셀)와 `views/admin/reservations.ejs`(Visitor 셀)에서
  `noshow_count > 0`이면: `<span class="badge badge-noshow">No-shows: <%= r.noshow_count %></span>` 를 이메일 줄 아래 표시.

### A5. 영어투어 시간 단일 소스화

**문제**: 영어투어 시간이 `views/index.ejs`·`views/reserve.ejs`에 "Wednesday 15:40/16:30"으로 하드코딩되어 있어
admin에서 회차를 바꾸면 사이트 문구가 낡는다. slots 테이블을 단일 소스로 만든다.

- `src/helpers.js`에 `getEnglishTours()` 추가:
  ```
  active=1 AND language='en' 슬롯 조회 → 반환 객체:
  {
    available: bool,
    chip:     모든 EN 슬롯의 weekdays가 동일한 단일 요일이면 `English tours every ${요일명}`,
              그 외(요일 혼재/복수)엔 `English docent tours available`,
    summary:  요일 라벨별 그룹핑. 각 그룹: `${요일라벨}: ${항목들 ' · '.join}`,
              항목 = `${tour_type==='permanent'?'Permanent Exhibition':'Special Exhibition'} ${start_time}`,
              그룹 간 '; '로 연결. 예: `Every Wednesday: Permanent Exhibition 15:40 · Special Exhibition 16:30`
              (단일 그룹이면 앞에 'Every ' 접두),
    perType:  { permanent: `every ${요일라벨} at ${start_time}` | null, special: 동일 } —
              해당 타입 EN 슬롯이 여러 개면 첫 번째(시간 오름차순) 기준
  }
  요일명: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
  요일라벨: weekdays CSV의 각 숫자를 요일명으로 바꿔 ' & '로 연결.
  ```
- `src/routes/public.js`: `GET /`와 `GET /reserve`(에러 재렌더 포함 — reserveLimiter의 429 렌더와 `fail()`도)에
  `enTours: getEnglishTours()` 전달.
- 템플릿 치환 (하드코딩 제거 대상 전부):

| 위치 | available=true | available=false |
|---|---|---|
| index 히어로 칩 `English tours every Wednesday` | `<%= enTours.chip %>` | 칩 자체를 렌더하지 않음 |
| index 비교카드 ENGLISH 항목 | `docent tours — <%= enTours.summary %>` | 항목을 `English docent tours are not currently scheduled.`로 대체 (KOREAN 항목·MP3 노트는 유지) |
| index 슬라이더 Permanent 설명의 `English docent tour every Wednesday at 15:40` | `English docent tour <%= enTours.perType.permanent %>` | 그 문장 생략 (MP3 문장은 유지) |
| index 슬라이더 RE:PLAY 설명의 `every Wednesday at 16:30` | `<%= enTours.perType.special %>` 사용 | 문장 생략 |
| index FAQ `Are the tours in English?` 본문 첫 문장 | `Free English docent tours run <%= enTours.summary %>.` (뒤의 Korean+MP3 문장 유지) | `English docent tours are not currently scheduled.` + MP3 문장 유지 |
| reserve 사이드바 `English tours` 카드 | `<%= enTours.summary %>.` + 기존 Korean/MP3 문장 | `English docent tours are not currently scheduled.` + MP3 문장 |

- 시드 공지(notices)의 시간 언급은 직원 관리 콘텐츠이므로 **건드리지 않는다**.

### A6. 테스트 (`tests/features.test.js` 신규 — 케이스 고정: 추가·생략·약화 금지)

`tests/helper.js` 재사용. maintenance 함수는 서버 프로세스가 아니라 **모듈 직접 require**로 호출해도 된다
(helper의 DATA_DIR 설정 이후 require — helper.js의 clearSrcCache 참고).

| # | 케이스 | 기대 |
|---|---|---|
| F1 | 내일(KST) 방문 confirmed 1건 생성 후 `sendReminders()` | 반환 1, email_log에 `Reminder` 제목 1건, reminder_sent=1 |
| F2 | 직후 `sendReminders()` 재호출 | 반환 0, Reminder 메일 수 그대로 (중복 발송 없음) |
| F3 | pending(내일)·confirmed(모레) 각 1건 상태에서 `sendReminders()` | 반환 0 |
| F4 | retention_days=90, noshow_retention_days=365 설정 후: visit_date 100일 전 attended / 100일 전 no_show / 400일 전 no_show 3건 삽입 → `purgeOldData()` | attended 삭제, 100일 no_show 유지, 400일 no_show 삭제 |
| F5 | EN permanent 슬롯 start_time을 '15:50'으로 UPDATE 후 `GET /` | 본문에 `15:50` 포함, `15:40` 미포함 |
| F6 | EN 슬롯 2개 모두 active=0 후 `GET /` | `English tours every` 미포함, `not currently scheduled` 포함 |
| F7 | 이메일 X로 no_show 1건(관리자 전이로 생성) + 같은 이메일 새 pending → 대시보드 HTML | `No-shows: 1` 포함 |
| F8 | 전체 `npm test` | 기존 49 + 신규 전부 통과, 실패 0 |

## [완료 기준 — 증거 원문 첨부]

1. `npm test` 전체 출력 (pass/fail 카운트).
2. F5 상황의 curl 증거: 슬롯 시간 변경 전/후 `GET /` 본문 diff 요지 (grep 출력).
3. 수동 확인: `PORT=4325` 서버에서 대시보드에 노쇼 배지가 보이는 화면 텍스트(curl HTML grep로 충분).
4. 수정/생성 파일 목록, 판단이 필요했던 지점.

## [금지사항]

- 의존성 설치, cron 라이브러리, 새 라우트 추가(설정 저장 외), `docs/` 수정, git commit.
- 테스트를 통과시키기 위한 지시 범위 밖 소스 수정 — 필요해 보이면 멈추고 버그로 보고.
