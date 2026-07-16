# P0-3 지시서: 관리자 인증 강화 + 세션 영속화

> 이 문서 하나만 보고 작업하세요. **P0-1, P0-2가 머지된 코드 위에서 작업합니다.**

## [컨텍스트 고정 — 위반 금지]

- 프로젝트: `~/Desktop/raim-en`. Express 4 + EJS + Node 내장 `node:sqlite` (Node 26).
- **새 npm 의존성 추가 금지** (connect-sqlite3 등 세션 스토어 라이브러리 포함 — 아래 수제 스토어로).
- DB 접근은 `src/db.js`의 기존 패턴(`db.prepare(...).run/get/all`)을 따를 것.

## [작업]

### 1. 로그인 무차별 대입 방어 (`src/routes/admin.js`)

- **IP 기준**: P0-1의 `src/ratelimit.js`를 재사용해 `POST /admin/login`에 IP당 15분에 10회. 초과 시 로그인 페이지를 429로 재렌더, 메시지 `"Too many attempts. Try again later."`
- **계정 기준 잠금**: 모듈 스코프 `Map<username, {fails, lockedUntil}>`.
  - 실패 시 `fails += 1`. `fails >= 5`면 `lockedUntil = now + 15분`.
  - 잠금 중에는 **올바른 비밀번호여도** 로그인 거부, 같은 429 메시지 (계정 존재 여부가 새어나가지 않도록 메시지는 IP 제한과 동일 문구).
  - 로그인 성공 시 해당 엔트리 삭제.
- **실패 지연**: 로그인 실패 응답 전에 `await new Promise(r => setTimeout(r, 400))`.
- **감사 로그**: 실패/잠금 발생 시 `console.warn('[auth] failed login', {username, ip})` 형식으로 남길 것 (비밀번호는 절대 로그 금지).

### 2. SESSION_SECRET 강제 (`src/app.js`)

```js
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production.');
  process.exit(1);
}
```
- 개발 모드에서 미설정이면 시작 시 `console.warn` 1회.
- 세션 쿠키 옵션에 `secure: process.env.NODE_ENV === 'production'` 추가 (TRUST_PROXY 주석과 함께: 프록시 뒤에서는 P0-1의 trust proxy 설정이 있어야 secure 쿠키가 동작).

### 3. SQLite 세션 스토어 (`src/session-store.js` 신규)

현재 MemoryStore는 재시작 시 전 직원 로그아웃 + 프로세스 메모리 누적 문제가 있다. express-session의 `Store`를 상속한 수제 스토어로 교체:

```js
const session = require('express-session');
const { db } = require('./db');

// 테이블 (src/db.js의 schema exec 블록에 추가):
// CREATE TABLE IF NOT EXISTS sessions (
//   sid TEXT PRIMARY KEY,
//   data TEXT NOT NULL,
//   expires INTEGER NOT NULL   -- epoch ms
// );

class SqliteStore extends session.Store {
  get(sid, cb)      // SELECT 후 만료 검사. 만료면 destroy 후 cb(null, null).
                    // JSON.parse 실패 시 cb(null, null) (throw 금지)
  set(sid, sess, cb) // INSERT ... ON CONFLICT(sid) DO UPDATE.
                    // expires = sess.cookie.expires ?? now + maxAge(기본 8h)
  destroy(sid, cb)
  touch(sid, sess, cb) // expires만 갱신
}
```

- 모든 cb는 `cb(err)` 규약 준수, 콜백 없이 throw하지 말 것.
- 만료 세션 청소: `setInterval` 30분 주기 `DELETE FROM sessions WHERE expires < ?`, `.unref()`.
- `src/app.js`의 `session({...})`에 `store: new SqliteStore()` 장착.

## [완료 기준 — 전부 증명할 것]

1. 같은 username으로 비밀번호 5회 실패 후, **올바른 비밀번호**로 시도 → 여전히 거부(429). 15분 뒤(또는 테스트를 위해 Map을 조작해) 성공하는 것 확인.
2. 로그인 성공 → 서버 재시작(`npm start` 다시) → **재로그인 없이** 같은 쿠키로 `/admin` 200 (세션 영속화 증거).
3. `NODE_ENV=production npm start` (SESSION_SECRET 없이) → 즉시 종료 + FATAL 메시지.
4. `sessions` 테이블에 로그인 후 행이 생기고, 로그아웃 시 삭제되는 것 확인.
5. 기존 e2e 1회 완주 (예약→승인→취소) + 콘솔 에러 0건.

## [금지사항]

- staff 테이블/비밀번호 해싱 방식(scrypt) 변경 금지.
- 세션 스토어 라이브러리 설치 금지.
- 잠금 상태를 DB에 저장하지 말 것 (메모리로 충분 — 재시작 시 리셋되는 것 허용).
