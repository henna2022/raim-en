# Seoul RAIM — English Visitor Guide & Reservation System

외국인 방문객을 위한 서울로봇인공지능과학관 영문 안내 + 전용 예약 시스템 (로컬 완성형).

## 실행

```bash
npm install
npm start          # http://localhost:4310
```

- **공개 사이트**: http://localhost:4310 — 랜딩(안내) / `/reserve`(예약 신청) / `/booking`(예약 조회·취소)
- **관리자**: http://localhost:4310/admin — 초기 계정 `admin` / `raim2026!` (로그인 후 Staff 메뉴에서 비밀번호 변경 및 직원 계정 추가)

데이터는 `data/raim.db` (SQLite, Node 내장 `node:sqlite`)에 저장됩니다. DB를 초기화하려면 서버를 끄고 `data/` 폴더를 삭제하세요(시드 데이터가 다시 생성됨).

## 예약 운영 흐름

1. 외국인이 `/reserve`에서 날짜·회차 선택 후 신청 → 상태 `pending`, 방문자에게 "request received" 메일
   + **담당자 메일로 한국어 알림 발송** (Settings의 Staff notification email, 당일 신청은 제목에 [오늘])
2. 직원이 admin 대시보드에서 신청 확인 — 48시간 넘게 대기한 신청은 빨간 강조 + OVER 48H 배지
3. **서울시 공공서비스예약(yeyak) 관리자 예약으로 해당 회차 좌석을 먼저 차단**
4. admin에서 체크박스(yeyak 차단 완료) 체크 후 Confirm → 확정 메일 자동 발송
5. 당일 데스크: Dashboard의 "Print today's desk list"로 명단 출력, 방문 후 Attended/No-show 처리

좌석이 없으면 Decline(사유 입력) → 거절 메일 발송. 방문객은 `/booking`에서 코드+이메일로 조회·취소 가능.

**확정 예약이 취소되면** (방문자 취소든 직원 취소든) 해당 건이 Dashboard의 **Yeyak release queue**에 올라가고
담당자 메일로 "좌석 해제 필요" 알림이 갑니다. yeyak에서 좌석을 해제한 뒤 "Seats released"를 눌러야 큐에서 사라집니다.

**개인정보 보존기한**: 방문일로부터 `retention_days`(기본 90일)가 지난 예약과 메일 로그는 서버가 자동 삭제합니다
(부팅 시 + 12시간마다, `src/maintenance.js`).

## 이메일 (SMTP)

기본값은 **발송함(Outbox) 모드**: 실제 발송 없이 admin > Emails에서 미리보기만 됩니다.
실제 발송하려면 환경변수를 설정하고 실행:

```bash
SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... \
SMTP_FROM="Seoul RAIM <raim@seoulraim.com>" npm start
```

## 스케줄 데이터

- 회차(slots): 공식 관람시간표 기준으로 시드됨. 상설 6회 / 기획 6회, 화~일.
  수요일 15:40(상설)·16:30(기획)은 영어 도슨트 회차로 분리 등록되어 있음 — admin > Schedule에서 수정 가능.
- 휴관: 매주 월요일 자동 휴관. 명절 등 추가 휴관일과 "월요일 개관(공휴일 대체)"은 admin > Schedule > Closures에서 관리.

## 실서비스 전 필수 조치 (현재는 로컬 프로토타입)

- [ ] `SESSION_SECRET` 환경변수 설정 (현재 dev 기본값)
- [ ] HTTPS 적용, 세션 스토어를 메모리 → 영속 스토어로 교체, CSRF 토큰 추가
- [ ] 개인정보 처리방침 페이지(수집 항목·보관 기간) 법무/행정 검토 — 방문일 이후 자동 삭제 배치 권장
- [ ] `admin` 초기 비밀번호 변경, 직원 계정 발급 (5명)
- [ ] 요청 속도 제한(rate limit) 및 스팸 방지(허니팟/캡차 대안) 추가
- [ ] DB 백업 정책 (data/raim.db)

## 구조

```
src/app.js            서버 엔트리 (Express, 세션)
src/db.js             SQLite 스키마 + 시드 (직원, 회차, 공지, 설정)
src/helpers.js        날짜/휴관/회차 계산, 예약 코드 생성 (KST 기준)
src/mailer.js         메일 템플릿 4종 + SMTP/Outbox 전환
src/routes/public.js  랜딩, 예약 신청, 예약 조회/취소, /api/sessions
src/routes/admin.js   로그인, 대시보드, 예약 처리, 스케줄/공지/직원/설정/발송함
views/                EJS 템플릿 (public + admin)
public/css/           site.css(공개), admin.css(관리자)
```
