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
2. **아침 다이제스트**(매일 `digest_hour` 시각, 기본 09시 KST) 메일 1통으로 그날 처리할 일을 받습니다 —
   대기 신청 목록(SLA 48시간 초과 강조), yeyak 해제 대기, 대기자(waitlist), 오늘 확정 방문 건수
3. 직원이 admin 대시보드에서 확인 — 신청은 **(방문일, 회차)별로 그룹**으로 묶여 표시됩니다
4. **서울시 공공서비스예약(yeyak) 관리자 예약으로 그룹의 합계 좌석을 한 번에 차단**
   (그룹의 "Copy for yeyak" 버튼으로 입력용 텍스트 복사, Settings에 저장한 월별 yeyak 링크로 바로 이동)
5. 체크박스(yeyak 차단 완료) 체크 후 **일괄 Confirm** → 각 방문자에게 확정 메일 + 캘린더(.ics) 발송
6. 당일 데스크: Dashboard의 "Print today's desk list"로 명단 출력, 방문 후 Attended/No-show 처리

**좌석이 없을 때**는 거절 대신 **Waitlist**에 올립니다 — 방문자에게 대기 안내 메일이 가고, 좌석이 나면 승격(Confirm)할
수 있습니다. 그 회차가 완전히 찼다면 **매진(sold-out) 표시**를 함께 걸어 예약 폼에서 아예 선택되지 않게 합니다
(해제는 admin > Schedule). 방문일이 지나도록 좌석이 나지 않은 대기 건은 자동으로 거절 처리되고 안내 메일이 나갑니다.

**확정 예약이 취소되면** (방문자 취소든 직원 취소든) 해당 건이 Dashboard의 **Yeyak release queue**에 올라가고
담당자 메일로 알림이 갑니다. 차단해 둔 좌석은 **같은 회차 대기자에게 먼저 승격**하고, 남는 좌석만 yeyak에서 해제한 뒤
"Resolved"를 눌러 큐에서 내립니다.

방문객은 `/booking`에서 코드+이메일로 상태 조회·취소(대기자는 "Leave the waitlist")가 가능합니다.

**개인정보 보존기한**: 방문일로부터 `retention_days`(기본 90일)가 지난 예약과 메일 로그는 서버가 자동 삭제합니다
(부팅 시 + 12시간마다, `src/maintenance.js`).

## Google 시트 미러 (선택)

신청·상태 변경을 Google 시트에 자동 반영합니다. 직원이 스프레드시트로 현황을 보고,
실제 처리(확정·거절·대기)는 관리자 페이지에서 합니다 — **시트에서 값을 고쳐도 앱으로
돌아오지 않습니다.** 설치는 [`scripts/apps-script/Code.gs`](scripts/apps-script/Code.gs)
상단 주석 참고. `SHEETS_WEBHOOK_URL`/`SHEETS_WEBHOOK_SECRET`을 비우면 기능이 꺼집니다.

- 요청사항(자유입력) 원문은 시트로 내보내지 않고 **"있음"만 표시**합니다. 자유입력에
  건강 관련 정보가 섞이면 민감정보가 되어 규제 수준이 올라가기 때문입니다.
- 보존기한이 지나 앱에서 파기된 예약은 **시트에서도 자동 삭제**됩니다.
- 시트는 링크 공유하지 말고 담당자 계정에만 개별 공유하세요. 개인 계정이 아닌
  **기관 계정 소유**로 두는 것이 원칙입니다.

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

## 실서비스 전 필수 조치

구현 완료 (코드에 반영됨):

- [x] `SESSION_SECRET` 강제 — production에서 미설정 시 부팅 거부 (`src/app.js`)
- [x] 세션 스토어 SQLite 영속화 (`src/session-store.js`), CSRF 더블 서브밋 (`src/csrf.js`)
- [x] 요청 속도 제한 + 허니팟 스팸 방지 (`src/ratelimit.js`, `src/routes/public.js`)
- [x] 개인정보 보존기한 자동 삭제 배치 (`src/maintenance.js`)
- [x] DB 백업 스크립트 + 복원 절차 (`scripts/backup.sh`, `docs/DEPLOY.md` ⑦)
- [x] 보안 헤더·HSTS, 운영 쿠키 `Secure` (`src/app.js`, `src/csrf.js`)

배포 시 운영자가 해야 할 일 — 절차는 [`docs/DEPLOY.md`](docs/DEPLOY.md):

- [ ] HTTPS(nginx) 적용 + `TRUST_PROXY=1`, 앱 포트 4310 외부 비노출 확인
- [ ] `admin` 초기 비밀번호 변경(부팅 로그의 1회성 랜덤 값), 직원 계정 발급
- [ ] Admin > Settings 초기 설정 (담당자 메일, 다이제스트 시각, 월별 yeyak 링크)
- [ ] 백업 cron 등록
- [ ] 개인정보 처리방침 페이지(수집 항목·보관 기간) 법무/행정 검토

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
