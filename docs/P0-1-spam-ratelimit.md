# P0-1 지시서: 공개 폼 스팸 방지 + 요청 속도 제한

> 이 문서 하나만 보고 작업하세요. 문서 밖의 판단이 필요하면 작업을 멈추고 질문하세요.

## [컨텍스트 고정 — 위반 금지]

- 프로젝트: `~/Desktop/raim-en`. Express 4 + EJS + **Node 내장 `node:sqlite`** (Node 26). ORM 없음.
- DB 접근은 반드시 `src/db.js`의 기존 패턴(`db.prepare(...).run/get/all`)을 따를 것.
- **새 npm 의존성 추가 금지.** 이 작업은 전부 내장 모듈로 구현한다.
- 기존 파일 구조·변수명·EJS 클래스명·코딩 스타일 유지. 이 문서 범위 밖 리팩터링 금지.
- 서버 실행: `npm start` (포트 4310). DB 초기화: 서버 끄고 `data/` 삭제.

## [배경]

이 시스템은 직원이 신청 1건마다 수작업(yeyak 좌석 차단)을 하는 구조라, 스팸 신청 수십 건이면 운영이 마비된다. 공개 폼 3종(`POST /reserve`, `POST /booking/cancel`, 조회)에 최소한의 자동화 방어를 넣는다.

## [작업]

### 1. `src/ratelimit.js` 신규 작성 — 고정 윈도우 rate limiter

```js
// 시그니처 (정확히 이 형태로)
function rateLimit({ windowMs, max, keyFn, onLimit }) -> Express middleware
```

- 내부 저장소: `Map<key, {count, resetAt}>`. `keyFn(req)` 기본값은 `req.ip`.
- 요청 시 해당 key의 `resetAt`이 지났으면 카운터 리셋. `count > max`면 `onLimit(req, res)` 호출(응답 책임은 onLimit에 있음), 아니면 `next()`.
- 메모리 누수 방지: `setInterval`로 10분마다 만료 엔트리 삭제, 반드시 `.unref()` 호출.
- `app.set('trust proxy', 1)`은 **환경변수 `TRUST_PROXY=1`일 때만** `src/app.js`에서 설정 (리버스 프록시 뒤에 배포될 때만 켠다는 주석 포함).

### 2. 적용 지점 (`src/routes/public.js`)

| 라우트 | 제한 | 초과 시 응답 |
|---|---|---|
| `POST /reserve` | IP당 10분에 5회 | 기존 `fail()` 헬퍼와 같은 방식으로 reserve 페이지를 429로 재렌더, 에러 메시지: `"Too many requests. Please wait a few minutes and try again."` |
| `POST /booking/cancel` | IP당 10분에 10회 | 429 + `/booking`으로 리다이렉트 |
| `GET /booking` (조회 시도) | IP당 10분에 30회 | 429 텍스트 응답 |

### 3. 이메일당 활성 예약 상한 (`POST /reserve` 검증 로직에 추가)

- 같은 이메일로 `status IN ('pending','confirmed')`이고 `visit_date >= 오늘(KST)`인 예약이 **3건 이상**이면 거절.
- 에러 메시지: `"You already have 3 upcoming reservations. Please cancel one via My Booking, or contact us by email."`
- 오늘 날짜는 반드시 기존 `src/helpers.js`의 `todayStr()`을 사용할 것 (new Date() 직접 사용 금지 — KST 처리 때문).

### 4. 허니팟 (`views/reserve.ejs` + `POST /reserve`)

- 폼 안에 사람 눈에 안 보이는 필드 추가:
  ```html
  <div class="hp-field" aria-hidden="true">
    <label for="website">Website</label>
    <input type="text" id="website" name="website" tabindex="-1" autocomplete="off">
  </div>
  ```
- `public/css/site.css`에 `.hp-field { position:absolute; left:-9999px; opacity:0; height:0; overflow:hidden; }` 추가. `display:none`은 쓰지 말 것(일부 봇이 감지함).
- 서버: `website` 값이 비어있지 않으면 **DB에 아무것도 저장하지 않고, 메일도 보내지 않고**, `/booking?new=1`로 302 리다이렉트 (봇에게는 성공처럼 보이게). `views/booking.ejs`는 code 없이 `new=1`만 있어도 배너가 뜨는지 확인하고, 안 뜨면 뜨도록 최소 수정.

## [완료 기준 — 전부 증명할 것]

1. curl로 같은 IP에서 `POST /reserve` 6회 연속 → 6번째가 HTTP 429.
2. `website` 필드를 채운 신청 → 302 응답이지만 `reservations` 테이블에 행이 없고 `email_log`에도 기록이 없음 (`sqlite3` CLI 또는 node로 조회해 증명).
3. 같은 이메일로 미래 날짜 예약 3건 생성 후 4번째 신청 → 400 + 지정된 에러 메시지.
4. 기존 정상 플로우 회귀 없음: 예약 신청 → admin 로그인(admin/raim2026!) → yeyak 체크박스 승인 → `/booking`에서 Confirmed 확인까지 브라우저로 1회 완주.
5. 서버 콘솔에 에러 0건.

## [금지사항]

- express-rate-limit 등 라이브러리 설치 금지 (위 수제 구현으로).
- 기존 검증 로직(`fail()` 체인) 순서 변경 금지 — 새 검증은 기존 체인에 항목으로 추가만.
- admin 라우트는 이 작업에서 건드리지 않는다 (P0-3에서 별도 처리).
