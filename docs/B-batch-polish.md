# Batch B 지시서: 폴리시 묶음 (favicon · OG · lazy · robots · 슬라이더 접근성 · admin 검색/페이지네이션 · .ics 첨부)

> 이 문서 하나만 보고 작업하세요. 판단이 필요하면 임의로 정하지 말고 최종 보고에 명시.

## [컨텍스트 고정 — 위반 금지]

- 프로젝트: `~/Desktop/raim-en`. Express 4 + EJS + Node 내장 `node:sqlite`(Node 26). **새 npm 의존성 추가 금지.**
- 기존 스타일 유지, 범위 밖 리팩터링 금지, `docs/` 수정 금지, git commit 금지.
- 기존 테스트 56개는 계속 통과해야 한다 (`npm test`).

## [검증 하네스 노트]

- 수동 검증: `PORT=4326 npm start` 백그라운드, 종료 필수. curl 우선.
- CSRF/rate limit 처리는 `tests/helper.js` 패턴 재사용.

## [작업]

### B1. favicon

- `public/favicon.svg` 생성 — 외부 리소스 없이 순수 SVG. 디자인: 둥근 사각(#3182f6 배경, rx 20%) 위에
  흰색 로봇 얼굴(둥근 눈 2개 + 입 라인) 단순 도형. 텍스트/이모지 글리프 사용 금지(폰트 의존 방지).
- 공개 3페이지(`index/reserve/booking`)와 admin 전 페이지 `<head>`(admin은 `partials/top.ejs`·`login.ejs`·`print_day.ejs`)에
  `<link rel="icon" type="image/svg+xml" href="/favicon.svg">` 추가.

### B2. OG/메타 태그 (공개 3페이지)

각 페이지 `<head>`에:
```html
<meta property="og:type" content="website">
<meta property="og:site_name" content="Seoul Robot & AI Museum">
<meta property="og:title" content="{페이지 <title>과 동일}">
<meta property="og:description" content="{index는 기존 meta description 재사용, reserve/booking은 페이지 부제 한 문장}">
<meta property="og:image" content="/img/hero.jpg">
<meta name="twitter:card" content="summary_large_image">
```
- reserve/booking에는 `<meta name="description">`도 같은 문구로 추가.

### B3. 이미지 로딩 최적화 (index.ejs)

- 히어로 이미지: `fetchpriority="high"` 추가 (lazy 금지 — LCP).
- 슬라이더 4장 + 지도 타일 9장: `loading="lazy"` + `decoding="async"` 추가.
- 슬라이더 이미지에 `width="800" height="470"`(비율 힌트) 추가 — CSS가 크기를 지배하므로 표시엔 영향 없음.

### B4. robots.txt

- `public/robots.txt`:
  ```
  User-agent: *
  Disallow: /admin
  Disallow: /api/
  Disallow: /booking
  Allow: /
  ```

### B5. 슬라이더 키보드 접근성 (index.ejs)

- `.slides` 컨테이너에 `tabindex="0" role="region" aria-label="Exhibitions carousel"` 추가.
- 인라인 스크립트에 keydown 핸들러: 컨테이너 포커스 상태에서 ArrowLeft/ArrowRight → `slideMove(±1)` + `preventDefault()`.
- CSS(site.css): `.slides:focus-visible { outline: 3px solid var(--blue); outline-offset: 4px; border-radius: 8px; }`

### B6. admin 예약 검색 + 페이지네이션 (`/admin/reservations`)

- 필터 폼에 `q` 텍스트 입력 추가 (placeholder `Name, email or code`).
  서버: `q`가 있으면 `AND (r.name LIKE ? OR r.email LIKE ? OR r.code LIKE ?)` — 파라미터는 `%q%`, LIKE 대소문자 무시(기본).
- 페이지네이션: `page` 쿼리 파라미터(1부터), 페이지당 50건. `LIMIT 50 OFFSET (page-1)*50`.
  총 건수 `COUNT(*)` 동일 조건으로 조회, 하단에 `Prev / Page X of Y / Next` 링크(현재 필터·q 유지).
  기존 `LIMIT 500` 문구/코드는 제거.

| 응답 | 형식 |
|---|---|
| `GET /admin/reservations?q=...&page=N` | 200 HTML, 유효하지 않은 page(0, 음수, NaN)는 1로 처리 |

### B7. 확정 메일 .ics 캘린더 첨부

- `src/mailer.js`에 `icsForReservation(r)` 추가 — 순수 문자열 생성:
  ```
  BEGIN:VCALENDAR / VERSION:2.0 / PRODID:-//Seoul RAIM//EN / BEGIN:VEVENT
  UID:{r.code}@raim-en / DTSTAMP·DTSTART·DTEND는 UTC(Z) — KST 시각에서 9시간 빼서 변환
  SUMMARY:Seoul Robot & AI Museum — {Permanent|Special} Exhibition Tour
  LOCATION:{settings.address_en} / DESCRIPTION:Reservation {code}. Party of {n}. Free admission...
  END:VEVENT / END:VCALENDAR
  ```
  줄바꿈은 `\r\n`. 날짜 경계 주의: KST 00:00~08:59 시작이면 UTC로 전날이 된다 — Date 객체로 변환할 것.
- `sendMail(to, subject, html, attachments)`로 시그니처 확장(4번째 선택 인자, nodemailer `attachments` 그대로 전달).
  기존 호출부는 무변경. confirm 시(관리자 confirm 액션)에만
  `[{ filename: 'raim-visit.ics', content: ics, contentType: 'text/calendar' }]` 첨부.
- Outbox 모드(SMTP 미설정)에서는 첨부가 저장되지 않아도 된다 — 단, `email_log`에 기존대로 html은 기록.

### B8. 테스트 (`tests/polish.test.js` 신규 — 케이스 고정)

| # | 케이스 | 기대 |
|---|---|---|
| G1 | `icsForReservation()` 단위: visit_date 2026-08-01, start 09:40, end 10:20 | `DTSTART:20260801T004000Z`·`DTEND:20260801T012000Z`·`UID:` 포함, CRLF 사용 |
| G2 | `GET /robots.txt` | 200, `Disallow: /admin` 포함 |
| G3 | `GET /favicon.svg` | 200, `image/svg+xml` |
| G4 | 예약 2건(이름 Alice/Bob) 생성 후 `GET /admin/reservations?q=alice` | Alice만 표시, Bob 미표시 |
| G5 | 예약 60건 삽입 후 `?page=2` | 200, `Page 2 of 2` 포함, 행 수 10 |
| G6 | `GET /` | `loading="lazy"` 슬라이더 이미지에 존재, 히어로 이미지엔 없음, `og:title` 메타 존재 |
| G7 | 전체 `npm test` | 기존 56 + 신규 전부 통과 |

## [완료 기준 — 증거 원문]

1. `npm test` 전체 출력.
2. curl: robots.txt·favicon.svg 응답 헤더, `/admin/reservations?q=` 검색 HTML grep.
3. confirm 흐름 1회 실행 후 SMTP 미설정 환경에서 에러 없이 확정 메일이 outbox에 기록되는 것.
4. 수정/생성 파일 목록, 판단 지점.

## [금지사항]

- 의존성 설치(ical 라이브러리 포함), 슬라이더 구조 변경, `docs/` 수정, git commit.
- 테스트 통과 목적의 범위 밖 소스 수정 — 필요하면 멈추고 버그 보고.
