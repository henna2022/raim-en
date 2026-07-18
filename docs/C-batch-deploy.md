# Batch C 지시서: 배포 패키지 + UAT 체크리스트

> 이 문서 하나만 보고 작업하세요. **이 배치는 앱 소스 코드를 한 줄도 수정하지 않습니다** — 새 파일 생성만.

## [컨텍스트 고정 — 위반 금지]

- 프로젝트: `~/Desktop/raim-en`. Node 26 내장 `node:sqlite`, DB 파일 `data/raim.db`(WAL).
- 앱 환경변수(이미 코드에 구현됨): `PORT`(기본 4310), `SESSION_SECRET`(production 필수 — 없으면 부팅 거부),
  `NODE_ENV`, `TRUST_PROXY`(리버스 프록시 뒤에서 1), `BASE_URL`(직원 알림 메일의 admin 링크),
  `SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS/SMTP_FROM`(미설정 시 Outbox 모드), `DATA_DIR`(기본 ./data).
- **수정 금지**: `src/`, `views/`, `public/`, `tests/`, `package.json`, 기존 `docs/`. git commit 금지.
- `npm test`(62개)는 작업 후에도 그대로 통과해야 한다 (아무것도 안 건드리면 당연히 통과 — 마지막에 1회 실행해 증명).

## [작업 — 생성할 파일 6개]

### C1. `Dockerfile`

- 베이스 `node:26-slim`. `WORKDIR /app`.
- `package.json`·`package-lock.json` 먼저 COPY → `npm ci --omit=dev` → `src/ views/ public/` COPY.
- `ENV NODE_ENV=production PORT=4310`, `EXPOSE 4310`, `VOLUME /app/data`, `CMD ["node", "src/app.js"]`.
- 주석으로: SESSION_SECRET 없이는 부팅이 거부됨을 명시.

### C2. `docker-compose.yml`

- 서비스 `raim-en`: `build: .`, `ports: "4310:4310"`, `env_file: .env`, `volumes: ./data:/app/data`,
  `restart: unless-stopped`.

### C3. `.env.example`

- 위 환경변수 전부, 각 줄 위에 한국어 주석 1줄. SESSION_SECRET는 생성법 주석:
  `# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `.gitignore`에 `.env` 한 줄 추가 (기존 파일 수정 허용 항목: `.gitignore`만 예외적으로 허용).

### C4. `scripts/backup.sh`

- bash 스크립트, 실행권한 부여. sqlite3 CLI 없이 node로 온라인 백업:
  `node -e "const{DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(SRC,{readOnly:true}); db.exec(\"VACUUM INTO '\"+DEST+\"'\")"` 방식.
- 인자: `DATA_DIR`(기본 ./data), 출력 `backups/raim-YYYYMMDD-HHMMSS.db`(디렉토리 자동 생성).
- 보관: 최신 14개만 남기고 오래된 백업 삭제. 성공/실패를 echo. `backups/`를 `.gitignore`에 추가.

### C5. `docs/DEPLOY.md` (한국어)

섹션 고정: ①요구사항(Node 26+ 또는 Docker) ②환경변수 표(위 목록 그대로, 필수/선택 구분)
③Docker 배포 절차(cp .env.example .env → 시크릿 생성 → compose up -d --build → 첫 로그인 후 admin 비밀번호 변경·직원 계정 5개 생성)
④Docker 없이 systemd로 돌리는 대안(서비스 유닛 예시) ⑤리버스 프록시(nginx server 블록 예시: HTTPS 종단, proxy_pass, `TRUST_PROXY=1` 필요성)
⑥SMTP 연결(설정 후 Outbox→실발송 전환 확인법: admin > Emails에서 SENT 배지)
⑦백업(cron 예시 `0 3 * * * .../scripts/backup.sh`)과 복원 절차(서버 중지→파일 교체→기동)
⑧업데이트/롤백(git pull→rebuild / git checkout 이전 커밋→rebuild) ⑨헬스체크(GET / 200, GET /admin/login 200).

### C6. `docs/UAT-checklist.md` (한국어, 직원 5명용)

체크박스(`- [ ]`) 형식, 시나리오 고정:
- **방문자 흐름(공개 사이트)**: 랜딩 정보 확인(시간·휴관·영어투어 문구가 admin 일정과 일치하는지) / 예약 신청 완료 및 접수 메일 수신 /
  My Booking 조회 / 방문자 취소 및 취소 메일 / 월요일·과거 날짜가 선택 불가한지.
- **직원 흐름(admin)**: 로그인·비밀번호 변경 / 신청 노티 메일 수신 확인 / yeyak 좌석 차단 후 체크박스 승인 → 확정 메일(.ics 첨부) /
  거절(사유) → 거절 메일 / 확정 취소 → 해제 큐 표시·해제 완료 처리 / 당일 명단 인쇄 / Attended·No-show 처리 후 노쇼 배지 확인 /
  일정 변경(영어투어 시간 수정 → 랜딩 문구 자동 변경 확인) / 휴관일 추가 → 예약창에서 닫힘 확인 / 공지 등록 → 랜딩 노출 / 설정 저장.
- **메일**: 접수·확정·리마인더(내일 방문 건으로 확인)·직원 노티 4종의 수신/내용.
- **예외**: 같은 회차 중복 신청 거부 / 잘못된 코드로 조회 실패 / 로그인 5회 실패 잠금.
- 각 항목에 "확인자/날짜" 기입란. 마지막에 "발견 문제 기록" 표(문제/화면/재현 방법/심각도).

## [검증]

1. `docker --version` 확인 — 설치돼 있으면 `docker build .` 실제 수행 후 성공 로그 첨부.
   **설치돼 있지 않으면 빌드 생략을 보고에 명시**하고, 대신 Dockerfile의 COPY 대상 경로가 실제 존재하는지 ls로 확인.
2. `scripts/backup.sh` 실제 실행: 백업 파일 생성 확인 + 생성된 백업을 node로 열어 `SELECT COUNT(*) FROM slots`가 원본과 같은지 확인 → 출력 첨부.
3. `npm test` 1회 실행 (62 통과 증명).
4. 생성 파일 목록, 판단 지점 보고.

## [금지사항]

- 앱 소스·기존 docs 수정(.gitignore 2줄 추가만 예외), 의존성 설치, git commit.
