# P0-2 지시서: CSRF 보호 (더블 서브밋 쿠키)

> 이 문서 하나만 보고 작업하세요. **P0-1이 머지된 코드 위에서 작업합니다.**

## [컨텍스트 고정 — 위반 금지]

- 프로젝트: `~/Desktop/raim-en`. Express 4 + EJS + Node 내장 `node:sqlite` (Node 26).
- **새 npm 의존성 추가 금지.** `csurf`는 deprecated이므로 절대 설치하지 말 것. cookie-parser도 설치하지 않는다 (아래 수제 파서 사용).
- 기존 파일 구조·스타일 유지, 범위 밖 리팩터링 금지.

## [설계 결정 (이유 포함 — 바꾸지 말 것)]

- 방식: **더블 서브밋 쿠키**. 세션 기반 토큰은 `saveUninitialized:false`인 현재 세션 설정과 충돌해(모든 방문자에게 세션 생성) 부적합.
- 세션 쿠키에 이미 `SameSite=Lax`가 걸려 있어 대부분의 CSRF는 차단되지만, 공공기관 보안 점검 기준으로 토큰 방어를 이중으로 둔다.
- 쿠키는 `httpOnly`로 둔다 — 토큰을 폼에 넣는 주체는 서버(EJS)이므로 JS에서 읽을 필요가 없다.

## [작업]

### 1. `src/csrf.js` 신규 작성

```js
const crypto = require('node:crypto');

// (a) 요청 헤더의 Cookie 문자열에서 이름으로 값 꺼내는 수제 파서 (~5줄)
function readCookie(req, name) { /* req.headers.cookie 파싱, decodeURIComponent */ }

// (b) 미들웨어: 모든 요청에서
//   - csrf 쿠키가 없으면 crypto.randomBytes(24).toString('hex') 생성 후
//     res.cookie('raim.csrf', token, { httpOnly:true, sameSite:'lax', maxAge: 8h })
//   - res.locals.csrf = 토큰  (EJS에서 <%= csrf %>로 사용)
//   - req.method === 'POST'일 때: req.body._csrf와 쿠키 값을 비교.
//     길이 다르면 즉시 실패, 같으면 crypto.timingSafeEqual로 비교.
//     불일치/부재 → 403. 응답: 뒤로가기 안내가 있는 간단한 HTML
//     ("Your form session expired. Please go back and try again.")
module.exports = { csrfMiddleware };
```

- `src/app.js`에서 `express.urlencoded` **다음**, 라우터 **이전**에 `app.use(csrfMiddleware)` 장착.

### 2. 모든 POST 폼에 토큰 주입

`grep -rn 'method="POST"' views/` 로 전수 확인 후, **각 폼의 첫 줄**에 추가:

```html
<input type="hidden" name="_csrf" value="<%= csrf %>">
```

대상 파일(작업 시점에 grep 결과가 우선):
- `views/reserve.ejs` (1개)
- `views/booking.ejs` (취소 폼)
- `views/admin/login.ejs`
- `views/admin/partials/top.ejs` (로그아웃 폼)
- `views/admin/partials/res_actions.ejs` (confirm/decline/상태변경/reopen 폼 여러 개)
- `views/admin/schedule.ejs` (슬롯 행별 폼 + 추가 폼 + 휴관 추가/삭제 폼)
- `views/admin/notices.ejs` (추가 + 항목별 수정 폼)
- `views/admin/staff.ejs` (추가 + 행별 비밀번호/삭제 폼)
- `views/admin/settings.ejs`

GET 폼(`/booking` 조회, 예약 필터)에는 넣지 않는다.

### 3. 주의점

- `res.locals.csrf`는 로그인 전 페이지(login.ejs)에서도 쓰이므로 미들웨어는 세션 로그인 여부와 무관하게 동작해야 함.
- P0-1의 허니팟 리다이렉트 경로(봇 처리)는 CSRF 검사 **통과 후** 실행되므로 추가 처리 불필요 — 단, 검사 순서가 바뀌지 않았는지 확인.

## [완료 기준 — 전부 증명할 것]

1. `grep -c 'method="POST"' views/ -r` 결과와 `grep -c 'name="_csrf"' views/ -r` 결과가 일치 (숫자 제시).
2. curl로 `_csrf` 없이 `POST /reserve` → 403, DB에 행 없음.
3. curl로 잘못된 `_csrf` + 올바른 쿠키 → 403.
4. 브라우저 e2e 1회 완주: 예약 신청 → admin 로그인 → 승인(yeyak 체크박스) → 방문자 취소 → 각 단계 정상. (모든 POST가 토큰을 통과한다는 증거)
5. admin의 모든 화면에서 버튼 1개 이상씩 실제로 눌러 403이 없는지 확인: schedule 저장, notice 저장, staff 비밀번호 리셋, settings 저장, 로그아웃.
6. 서버 콘솔 에러 0건.

## [금지사항]

- 라이브러리 설치 금지. 세션에 토큰 저장 금지(설계 결정 참조).
- 토큰 검증을 특정 라우트에만 거는 방식 금지 — 반드시 전역 POST 가드로.
