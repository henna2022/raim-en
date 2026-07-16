# P0-4 지시서: 자동화 테스트 스위트

> 이 문서 하나만 보고 작업하세요. **P0-1 ~ P0-3이 모두 머지된 코드 위에서 작업합니다.**
> 케이스 목록은 아래에 고정되어 있습니다 — **추가 금지, 생략 금지, 임의 변형 금지.**

## [컨텍스트 고정 — 위반 금지]

- 프로젝트: `~/Desktop/raim-en`. Express 4 + EJS + Node 내장 `node:sqlite` (Node 26).
- 테스트 프레임워크: **Node 내장 `node:test` + `node:assert`만 사용.** HTTP는 내장 `fetch`. supertest/jest/mocha/vitest 설치 금지.
- 실행 명령: `npm test` → `package.json`에 `"test": "node --test tests/"` 추가.

## [사전 리팩터링 — 정확히 이 두 가지만 허용]

1. `src/app.js`: 앱과 리슨 분리.
   ```js
   module.exports = app;
   if (require.main === module) { app.listen(PORT, ...); }
   ```
2. `src/db.js`: `const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');`

이 외의 소스 수정은 금지. (테스트가 안 짜지는 구조적 문제를 발견하면 멈추고 보고할 것.)

## [테스트 하네스 (`tests/helper.js`)]

- 각 테스트 파일은 `DATA_DIR`을 `fs.mkdtempSync(os.tmpdir() + '/raim-test-')`로 지정한 뒤 `require('../src/app')` → `app.listen(0)`으로 임의 포트에 띄운다. 시드가 자동 실행되므로 admin 계정은 `admin / raim2026!`.
- 쿠키 헬퍼: 응답의 `set-cookie`를 모아 다음 요청 `Cookie` 헤더로 보내는 간단한 jar 구현 (세션 + csrf 쿠키 유지).
- CSRF 헬퍼: 폼이 있는 페이지를 GET → `name="_csrf" value="..."`를 정규식으로 추출해 POST 바디에 포함.
- 날짜 헬퍼: "다음 월요일", "다음 수요일"을 KST 기준으로 계산 (오늘로부터 60일 이내 보장). `src/helpers.js`의 `todayStr`/`addDays`를 재사용해도 됨.
- 예약 생성 헬퍼 `makeReservation(overrides)` — 수요일 첫 회차로 정상 신청하고 code를 반환.
- rate-limit 간섭 주의: 테스트는 같은 IP(127.0.0.1)에서 돌므로, **A-16/F 등 제한 테스트는 별도 파일로 분리**하고 나머지 파일은 신청 횟수가 제한(10분 5회)에 걸리지 않도록 설계하거나, 테스트 전용으로 `RATE_LIMIT_MAX` 환경변수 오버라이드를 P0-1 구현에 요청… ❌ 소스 수정 금지이므로: **서버 인스턴스를 파일마다 새로 띄우면 메모리 기반 제한이 리셋된다**는 성질을 이용할 것.

## [케이스 목록 — 이 순서대로 파일 구성]

### tests/public-reserve.test.js — 공개 예약
| # | 케이스 | 기대 |
|---|---|---|
| A1 | `GET /` | 200, 본문에 `Book a Guided Tour` 포함 |
| A2 | `GET /api/sessions?date=<다음 월요일>` | `closed:true`, reason에 Monday |
| A3 | `GET /api/sessions?date=<다음 수요일>` | 세션 12개, `language:'en'` 정확히 2개 (15:40 permanent, 16:30 special) |
| A4 | `GET /api/sessions?date=2026-13-99` | 400 |
| A5 | `GET /api/sessions?date=<어제>` | closed (창구 밖) |
| A6 | 정상 신청 (수요일, EN 회차, party 2) | 302 → `/booking?...new=1`, DB에 pending 행, email_log에 "Request received" 1건 |
| A7 | 월요일 날짜로 신청 | 400 재렌더 |
| A8 | 창구(60일) 밖 날짜 | 400 |
| A9 | 그 요일에 없는 slot_id (예: 월요일 전용은 없으므로 존재하지 않는 id 9999) | 400 |
| A10 | party_size 0 / 7 / 'abc' | 각각 400 |
| A11 | 이메일 형식 오류 | 400 |
| A12 | agree 미체크 | 400 |
| A13 | 같은 이메일+날짜+회차 중복 신청 | 400 |
| A14 | 같은 이메일 활성 예약 3건 후 4번째 | 400, 메시지에 "3 upcoming" |
| A15 | 허니팟(website) 채움 | 302이지만 DB 행 없음, email_log 없음 |

### tests/public-booking.test.js — 조회/취소
| # | 케이스 | 기대 |
|---|---|---|
| B1 | 올바른 code+email 조회 | 200, 상태 배너 표시 |
| B2 | code는 맞고 email 틀림 | "No booking found", 예약 정보(이름/날짜) 미노출 |
| B3 | pending 취소 | 302, 상태 cancelled, 취소 메일 로그 |
| B4 | 이미 cancelled 재취소 | 302, 상태 그대로 cancelled (에러 없음) |
| B5 | 틀린 email로 취소 시도 | 상태 변화 없음 |

### tests/rate-limit.test.js — 속도 제한 (전용 파일, 새 서버 인스턴스)
| # | 케이스 | 기대 |
|---|---|---|
| R1 | `POST /reserve` 연속 6회 (CSRF 포함, 내용은 유효/무효 무관) | 6번째 429 |
| R2 | `POST /admin/login` 잘못된 비번 연속 11회 | 11번째 429 (IP 제한) |
| R3 | 같은 username 5회 실패 후 올바른 비번 | 여전히 거부 (계정 잠금) |

### tests/admin-auth.test.js — 관리자 인증
| # | 케이스 | 기대 |
|---|---|---|
| C1 | 비로그인 `GET /admin` | 302 → `/admin/login` |
| C2 | 틀린 비밀번호 | 401, 일반화된 메시지 (username 존재 여부 노출 금지) |
| C3 | 정상 로그인 | 302, 이후 `/admin` 200 |
| C4 | 로그아웃 | 이후 `/admin` 302 → login |
| C5 | staff 롤 계정 생성(admin으로) 후 그 계정으로 `GET /admin/staff` | 403 |
| C6 | 세션 영속화: 로그인 → 앱 인스턴스 재생성(같은 DATA_DIR) → 같은 쿠키로 `/admin` | 200 |

### tests/admin-flow.test.js — 예약 처리 전이
| # | 케이스 | 기대 |
|---|---|---|
| D1 | yeyak 체크박스 없이 confirm | 400, 상태 pending 유지 |
| D2 | 체크박스 포함 confirm | confirmed, decided_by='admin', "confirmed" 메일 로그 |
| D3 | decline + 사유 | declined, 메일 본문에 사유 포함 |
| D4 | pending 상태에서 attended 시도 | 400 |
| D5 | confirmed → no_show | 정상 전이 |
| D6 | confirmed → 직원 cancel | cancelled + 메일 |
| D7 | declined → reopen | pending |
| D8 | 존재하지 않는 action 이름 | 400 |
| D9 | `GET /admin/reservations.csv` | 200, `text/csv`, 본문에 예약 code 포함 |
| D10 | CSRF: 토큰 없이 confirm POST | 403, 상태 불변 |

### tests/schedule.test.js — 스케줄/휴관
| # | 케이스 | 기대 |
|---|---|---|
| E1 | 화요일에 kind=closed 휴관 추가 | 그 날짜 `/api/sessions` closed + reason 표시 |
| E2 | 월요일에 kind=open 추가 | 그 월요일 sessions 비어있지 않음 |
| E3 | 슬롯 active=0으로 수정 | `/api/sessions`에서 사라짐 |
| E4 | 예약이 달린 슬롯 삭제 시도 | 행 유지 + active=0 (soft delete) |
| E5 | 예약 없는 슬롯 삭제 | 행 삭제 |

## [완료 기준]

1. `npm test` 한 번에 전 케이스 통과, 실패 0. 출력 전문 첨부.
2. 실제 `data/raim.db`(개발 DB)가 테스트로 오염되지 않음 — 테스트 전후 파일 mtime/내용 동일 확인.
3. 테스트가 서로 순서에 의존하지 않음: `node --test tests/admin-flow.test.js` 단독 실행도 통과.
4. 총 소요 60초 이내.

## [금지사항]

- 케이스 임의 추가/삭제/약화(예: 상태 검증을 200 체크로 대체) 금지.
- 소스 수정은 [사전 리팩터링] 두 가지 외 금지. 테스트를 통과시키려고 소스를 고치고 싶어지면 **멈추고 버그로 보고** (그게 이 스위트의 존재 이유).
