# 배포 가이드

Seoul Robot & AI Museum — 외국인 방문자 예약 시스템(`raim-en`) 배포 안내입니다.

## ① 요구사항

다음 중 하나를 준비하세요.

- **Node.js 26 이상** (`node:sqlite` 내장 모듈을 사용하므로 Node 22.5 이상 필요 — 신규 배포는 Node 26 권장) + npm
- 또는 **Docker / Docker Compose** (호스트에 Node를 직접 설치할 필요 없음)

데이터베이스는 별도 서버 설치 없이 Node 내장 SQLite(`node:sqlite`, WAL 모드)를 사용합니다. 데이터 파일은 `DATA_DIR`(기본 `./data`)의 `raim.db`(+ `-wal`, `-shm`)입니다.

## ② 환경변수

| 변수 | 필수/선택 | 기본값 | 설명 |
|---|---|---|---|
| `PORT` | 선택 | `4310` | 앱이 리슨할 포트 |
| `SESSION_SECRET` | **필수(production)** | (없음) | 세션 쿠키 서명 키. `NODE_ENV=production`에서 미설정 시 부팅 거부 |
| `NODE_ENV` | 선택 | (미설정) | `production`으로 설정 시 쿠키 secure 플래그 활성화 + SESSION_SECRET 강제 |
| `TRUST_PROXY` | 선택(프록시 뒤라면 필수) | (미설정) | `1`로 설정하면 리버스 프록시의 `X-Forwarded-For`를 신뢰 |
| `BASE_URL` | 선택 | `http://localhost:4310` | 직원 알림 메일 속 관리자 페이지 링크의 기준 URL |
| `SMTP_HOST` | 선택 | (미설정) | 미설정 시 모든 메일이 Outbox(DB 저장, 미발송)로만 기록됨 |
| `SMTP_PORT` | 선택 | `587` | SMTP 포트 |
| `SMTP_SECURE` | 선택 | `false` | `true`면 SMTPS(TLS) 연결 |
| `SMTP_USER` | 선택 | (미설정) | SMTP 인증 계정 |
| `SMTP_PASS` | 선택 | (미설정) | SMTP 인증 비밀번호 |
| `SMTP_FROM` | 선택 | 설정값 `contact_email` | 발신자 이메일 주소 |
| `DATA_DIR` | 선택 | `./data` | SQLite DB 파일 저장 디렉토리 |

전체 목록은 `.env.example`을 참고하세요.

## ③ Docker 배포 절차

```bash
# 1. 환경변수 파일 준비
cp .env.example .env

# 2. SESSION_SECRET 생성 후 .env에 채워넣기
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. 빌드 및 기동
docker compose up -d --build

# 4. 로그 확인 (정상 기동 시 리슨 로그 출력)
docker compose logs -f raim-en
```

첫 기동 시 초기 관리자 계정이 자동 생성됩니다 (`admin` / `raim2026!`, 콘솔 로그로도 안내됨).

1. `http://<서버주소>:4310/admin`으로 접속해 초기 계정으로 로그인합니다.
2. **Admin > Staff**에서 즉시 admin 비밀번호를 변경합니다.
3. 실제 근무 직원 5명의 계정을 **Admin > Staff**에서 생성합니다 (초기 admin 계정은 공용 계정으로 남겨두지 않는 것을 권장).

## ④ Docker 없이 systemd로 운영하는 대안

```bash
npm ci --omit=dev
```

`/etc/systemd/system/raim-en.service` 예시:

```ini
[Unit]
Description=Seoul RAIM (EN) reservation site
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/raim-en
EnvironmentFile=/opt/raim-en/.env
ExecStart=/usr/bin/node src/app.js
Restart=on-failure
RestartSec=5
User=raim-en

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now raim-en
sudo systemctl status raim-en
```

## ⑤ 리버스 프록시 (nginx)

TLS는 nginx에서 종단하고, 앱에는 평문 HTTP로 프록시합니다. 이때 앱이 `X-Forwarded-For`/HTTPS 여부를 올바르게 인식하도록 **`TRUST_PROXY=1`이 반드시 필요**합니다 (없으면 세션 쿠키의 `secure` 판정이 어긋나 로그인 쿠키가 브라우저에 저장되지 않을 수 있음).

```nginx
server {
    listen 443 ssl http2;
    server_name raim.seoulraim.com;

    ssl_certificate     /etc/letsencrypt/live/raim.seoulraim.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/raim.seoulraim.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4310;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name raim.seoulraim.com;
    return 301 https://$host$request_uri;
}
```

## ⑥ SMTP 연결 확인

1. `.env`에 `SMTP_HOST`(및 필요 시 `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`)를 설정합니다.
2. 앱을 재기동합니다 (`docker compose up -d --build` 또는 `systemctl restart raim-en`).
3. 예약 신청 또는 취소 등으로 메일을 1건 발생시킵니다.
4. **Admin > Emails**에서 해당 메일의 배지를 확인합니다.
   - `SENT` 배지 → SMTP로 실제 발송됨
   - `OUTBOX` 배지 → 아직 미설정 상태이거나 발송 실패 (같은 화면에서 에러 메시지 확인 가능)

## ⑦ 백업과 복원

**백업 (cron 예시, 매일 03:00)**

```cron
0 3 * * * cd /opt/raim-en && ./scripts/backup.sh >> /var/log/raim-en-backup.log 2>&1
```

`scripts/backup.sh`는 `node:sqlite`의 `VACUUM INTO`로 온라인 백업을 `backups/raim-YYYYMMDD-HHMMSS.db`에 남기고, 최신 14개만 보관합니다 (docker-compose 환경에서는 컨테이너 밖에서 `DATA_DIR=./data ./scripts/backup.sh` 형태로 실행).

**복원 절차**

1. 서버(또는 컨테이너)를 중지합니다: `docker compose down` 또는 `systemctl stop raim-en`.
2. 복원할 백업 파일을 `DATA_DIR/raim.db`로 교체합니다 (기존 `raim.db-wal`, `raim.db-shm`이 있다면 함께 제거).
   ```bash
   cp backups/raim-<날짜시각>.db data/raim.db
   rm -f data/raim.db-wal data/raim.db-shm
   ```
3. 서버(또는 컨테이너)를 다시 기동합니다: `docker compose up -d` 또는 `systemctl start raim-en`.

## ⑧ 업데이트 / 롤백

**업데이트**

```bash
git pull
docker compose up -d --build
# 또는 systemd 운영 시:
git pull && npm ci --omit=dev && sudo systemctl restart raim-en
```

**롤백**

```bash
git checkout <이전 커밋 또는 태그>
docker compose up -d --build
# 또는 systemd 운영 시:
git checkout <이전 커밋 또는 태그> && npm ci --omit=dev && sudo systemctl restart raim-en
```

## ⑨ 헬스체크

- `GET /` → `200` (공개 랜딩 페이지)
- `GET /admin/login` → `200` (관리자 로그인 페이지)

```bash
curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:4310/
curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:4310/admin/login
```
