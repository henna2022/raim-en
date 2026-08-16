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
| `HOST` | 선택 | `127.0.0.1` | 리슨할 인터페이스. **기본값(루프백)을 유지하세요** — 앱 포트가 외부에 직접 노출되면 안 됩니다(⑤ 참고). Docker 이미지는 내부적으로 `0.0.0.0`을 사용하고, 노출은 호스트 쪽 포트 매핑에서 루프백으로 제한합니다 |
| `SESSION_SECRET` | **필수(production)** | (없음) | 세션 쿠키 서명 키. `NODE_ENV=production`에서 미설정 시 부팅 거부 |
| `NODE_ENV` | 선택 | (미설정) | `production`으로 설정 시 쿠키 secure 플래그 활성화 + SESSION_SECRET 강제 + 초기 admin 비밀번호를 랜덤 생성 |
| `TRUST_PROXY` | **필수(프록시 뒤)** | (미설정) | `1`로 설정하면 리버스 프록시의 `X-Forwarded-For`/`X-Forwarded-Proto`를 신뢰. 프록시 뒤에서 누락 시 **로그인 불가 + 모든 rate limit이 하나의 버킷으로 붕괴**(⑤ 참고) |
| `BASE_URL` | **필수(실제 배포)** | `http://localhost:4310` | 공개 origin(`https://...`). 직원 알림 메일의 관리자 링크와 canonical/OG 태그에 사용됩니다. 비워두면 메일 링크가 `localhost`를 가리켜 직원이 클릭할 수 없습니다 |
| `ADMIN_INITIAL_PASSWORD` | 선택 | (없음) | 최초 1회 admin 계정 시드에만 사용. production에서 미설정이면 랜덤 생성 후 부팅 로그에 1회 출력 |
| `SMTP_HOST` | 선택 | (미설정) | 미설정 시 모든 메일이 Outbox(DB 저장, 미발송)로만 기록됨 |
| `SMTP_PORT` | 선택 | `587` | SMTP 포트 |
| `SMTP_SECURE` | 선택 | `false` | `true`면 SMTPS(TLS) 연결 |
| `SMTP_USER` | 선택 | (미설정) | SMTP 인증 계정 |
| `SMTP_PASS` | 선택 | (미설정) | SMTP 인증 비밀번호 |
| `SMTP_FROM` | 선택 | 설정값 `contact_email` | 발신자 이메일 주소 |
| `DATA_DIR` | 선택 | `./data` | SQLite DB 파일 저장 디렉토리 |
| `SHEETS_WEBHOOK_URL` | 선택 | (미설정) | Apps Script 웹앱 URL. 앱 → 시트 미러용 |
| `SHEETS_WEBHOOK_SECRET` | 선택 | (미설정) | 위와 짝. Apps Script 스크립트 속성과 동일한 값 |
| `SHEETS_INBOUND_SECRET` | 선택 | (미설정) | 시트 → 앱(상태 드롭다운)용. 미설정 시 `/api/sheet/status`가 503. **`SHEETS_WEBHOOK_SECRET`과 다른 값을 쓰세요** — 이쪽이 새면 남의 예약을 승인·거절하고 방문객에게 메일까지 보낼 수 있습니다 |

전체 목록은 `.env.example`을 참고하세요.

> **시트 → 앱 방향은 사이트가 인터넷에서 접근 가능해야 동작합니다.** 구글 서버가
> `https://<도메인>/api/sheet/status`를 직접 호출하기 때문입니다. 앱은 루프백에만
> 리슨하므로 ⑤의 nginx 설정(TLS 종료 + `proxy_pass`)이 되어 있어야 하고,
> Apps Script 스크립트 속성 `APP_STATUS_URL`에 그 공개 주소를 넣습니다.
> 사내망·localhost 전용 배포에서는 시트 미러(①)만 동작하고 드롭다운 처리(②)는
> 쓸 수 없습니다 — 그 경우 승인·거절은 관리자 페이지에서 하세요.

## ③ Docker 배포 절차

> **순서 주의**: 관리자 첫 로그인은 반드시 **TLS(⑤) 설정을 끝낸 뒤 HTTPS로** 하세요.
> 앱 포트(4310)는 루프백에만 바인딩되어 외부에서 직접 접근할 수 없으며, 이는 의도된 설정입니다.

```bash
# 1. 환경변수 파일 준비
cp .env.example .env

# 2. SESSION_SECRET 생성 후 .env에 채워넣기
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. .env에서 BASE_URL을 공개 주소로 설정 (예: BASE_URL=https://raim.seoulraim.com)
#    TRUST_PROXY=1 은 .env.example에 이미 들어 있습니다 — 프록시 뒤라면 그대로 두세요.

# 4. 빌드 및 기동
docker compose up -d --build

# 5. 로그 확인 — 초기 admin 비밀번호가 여기 1회만 출력됩니다. 지금 저장하세요.
docker compose logs -f raim-en
```

첫 기동 시 초기 관리자 계정(`admin`)이 자동 생성됩니다. **production에서는 비밀번호가 랜덤 생성되어 부팅 로그에만 1회 출력**됩니다(`ADMIN_INITIAL_PASSWORD`로 직접 지정 가능). 예전 버전에 있던 고정 비밀번호는 git에 공개되어 있으므로 production 시드에는 더 이상 사용되지 않습니다.

⑤의 nginx/TLS 설정을 끝낸 뒤:

1. `https://<도메인>/admin`으로 접속해 로그에 출력된 초기 비밀번호로 로그인합니다.
2. **Admin > Staff**에서 즉시 admin 비밀번호를 변경합니다.
3. 실제 근무 직원 계정을 **Admin > Staff**에서 생성합니다 (초기 admin 계정은 공용 계정으로 남겨두지 않는 것을 권장).
4. **④ 첫 배포 후 Admin 설정**을 이어서 진행합니다.

## ③-2 첫 배포 후 Admin 설정 (필수)

앱은 기동되지만, 아래 설정을 넣기 전까지는 운영 기능이 제대로 동작하지 않습니다. **Admin > Settings**에서:

| 설정 | 기본값 | 넣지 않으면 |
|---|---|---|
| `Staff notification email` | `raim@seoulraim.com` | 신규 신청·yeyak 해제 알림과 아침 다이제스트가 아무에게도 가지 않음 |
| `Morning digest hour` (KST 0–23) | `9` | 비우면 아침 다이제스트 비활성화 |
| `yeyak service URL — Permanent / Special` | (비어 있음) | 대시보드의 yeyak 바로가기 버튼이 표시되지 않음. **yeyak은 매월 새 서비스 페이지가 열리므로 매달 갱신이 필요합니다** |
| `yeyak admin console URL` | (비어 있음) | 관리자시스템 바로가기 버튼 미표시 |
| `Contact email / phone / address` | 시드값 | 공개 사이트와 방문객 메일에 잘못된 정보가 노출됨 |
| `Personal data retention (days)` | `90` | 개인정보 보존기한 정책과 실제 삭제 주기가 어긋남 |

숫자 설정(보존기한, 다이제스트 시각 등)은 서버에서 범위 검증 후 저장되며, 범위를 벗어난 값은 무시되고 경고가 표시됩니다.

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

TLS는 nginx에서 종단하고, 앱에는 루프백(`127.0.0.1:4310`)으로 평문 프록시합니다.

**⚠️ 앱 포트를 외부에 노출하지 마세요.** `docker-compose.yml`은 `127.0.0.1:4310:4310`으로 루프백에만 게시하고, Docker 없이 실행할 때도 앱은 기본적으로 루프백에만 바인딩합니다(`HOST`). 4310이 공인 IP에서 접근 가능하면 **TLS를 우회해 평문으로 관리자 세션을 탈취**당할 수 있습니다 — `TRUST_PROXY=1` 상태에서는 직접 접속한 클라이언트가 스스로 신뢰 홉이 되어 `X-Forwarded-Proto: https`를 위조할 수 있고, 그러면 `secure` 세션 쿠키가 평문 연결로 발급됩니다. Docker의 DNAT 규칙은 ufw보다 앞서므로 호스트 방화벽만으로는 막히지 않습니다.

배포 후 반드시 외부에서 확인하세요:

```bash
curl -sv --max-time 5 http://<공인IP>:4310/   # 반드시 연결 실패해야 정상
```

**`TRUST_PROXY=1`은 프록시 뒤에서 필수입니다.** 누락 시 두 가지가 동시에 깨집니다.

1. 앱이 연결을 HTTPS로 인식하지 못해 **세션 쿠키가 아예 발급되지 않고, 아무도 로그인할 수 없습니다.**
2. 모든 rate limit이 `req.ip`를 프록시 IP 하나로 보게 되어 **전체 방문자가 하나의 버킷을 공유합니다** — 공개 예약 폼이 10분당 5건에서 막혀 사실상 다운됩니다.

nginx가 `X-Forwarded-Proto`를 전달하는지도 반드시 확인하세요(아래 설정에 포함되어 있음). 이 헤더가 없으면 1번 증상이 그대로 발생합니다.

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

`scripts/backup.sh`는 `node:sqlite`의 `VACUUM INTO`로 온라인 백업을 `backups/raim-YYYYMMDD-HHMMSS.db`에 남기고, 최신 14개만 보관합니다.

**Docker 환경**에서는 스크립트가 이미지 안에 포함되어 있으므로 컨테이너에서 실행합니다(호스트에 Node를 설치할 필요 없음).

```bash
docker compose exec -w /app raim-en scripts/backup.sh
```

이때 백업 파일은 컨테이너 내부 `/app/backups`에 생성되므로, 호스트에 남기려면 `docker-compose.yml`의 `volumes`에 `./backups:/app/backups`를 추가하세요. 호스트에 Node가 설치돼 있다면 컨테이너 밖에서 `DATA_DIR=./data ./scripts/backup.sh`로 실행해도 됩니다(바인드 마운트된 같은 파일을 읽습니다).

**복원 절차**

1. 서버(또는 컨테이너)를 중지합니다: `docker compose down` 또는 `systemctl stop raim-en`.
2. 복원할 백업 파일을 `DATA_DIR/raim.db`로 교체합니다 (기존 `raim.db-wal`, `raim.db-shm`이 있다면 함께 제거).
   ```bash
   cp backups/raim-<날짜시각>.db data/raim.db
   rm -f data/raim.db-wal data/raim.db-shm
   ```
3. 서버(또는 컨테이너)를 다시 기동합니다: `docker compose up -d` 또는 `systemctl start raim-en`.

## ⑧ 업데이트 / 롤백

**업데이트 — 반드시 백업 후 진행**

```bash
./scripts/backup.sh          # 또는 docker compose exec -w /app raim-en scripts/backup.sh
git pull
docker compose up -d --build
# 또는 systemd 운영 시:
git pull && npm ci --omit=dev && sudo systemctl restart raim-en
```

스키마 마이그레이션은 **재기동 시 자동, 전진 방향으로만** 적용됩니다. 새 테이블·컬럼·설정 기본값은 기존 DB에 그대로 추가되며 기존 데이터는 보존됩니다(신규 설치와 업그레이드 모두 검증됨).

**롤백 — 데이터 호환성 주의**

```bash
git checkout <이전 커밋 또는 태그>
docker compose up -d --build
# 또는 systemd 운영 시:
git checkout <이전 커밋 또는 태그> && npm ci --omit=dev && sudo systemctl restart raim-en
```

⚠️ **코드만 되돌려도 DB는 되돌아가지 않습니다.** 새 버전이 기록한 데이터를 구 버전이 이해하지 못하면 화면이 깨질 수 있습니다. 대기자(waitlist) 기능(`2d7450e`) 이전으로 롤백한다면, 그 전에 새 상태값을 정리하세요:

```bash
# 대기자 행을 구 버전이 아는 상태로 되돌린다 (백업 후 실행)
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/raim.db');\
console.log(db.prepare(\"UPDATE reservations SET status='pending' WHERE status='waitlisted'\").run());"
```

가장 안전한 롤백은 **직전 백업 파일로 DB까지 함께 복원**하는 것입니다(⑦ 복원 절차). 현재 코드의 화면들은 알 수 없는 상태값을 만나도 500 대신 그대로 표시하도록 방어되어 있지만, 구 버전에는 그 방어가 없습니다.

## ⑨ 헬스체크

- `GET /` → `200` (공개 랜딩 페이지)
- `GET /admin/login` → `200` (관리자 로그인 페이지)

서버 **안에서** (앱은 루프백에만 바인딩되어 있습니다):

```bash
curl -sf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/
curl -sf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/admin/login
```

서버 **밖에서** — 공개 주소는 200, 앱 포트 직결은 반드시 실패해야 합니다:

```bash
curl -sf -o /dev/null -w '%{http_code}\n' https://<도메인>/
curl -sv --max-time 5 http://<공인IP>:4310/    # 연결 실패가 정상 (성공하면 ⑤ 재확인)
```

## ⑩ 원클릭 호스팅 (Render)

VPS·nginx 없이 GitHub 저장소만으로 상시 접속 주소를 얻는 가장 빠른 방법입니다.
저장소의 [`render.yaml`](../render.yaml) 블루프린트가 [`Dockerfile`](../Dockerfile)을
그대로 빌드해 웹 서비스를 만듭니다. TLS·리버스 프록시·`HOST=0.0.0.0`은 Render가
처리하므로 ⑤(nginx)는 필요 없습니다.

**절차**

1. [render.com](https://render.com) 로그인 → **New +** → **Blueprint**.
2. 이 GitHub 저장소(`henna2022/raim-en`)를 선택 → **Apply**.
   `render.yaml`대로 웹 서비스가 생성되고 `SESSION_SECRET`은 자동 생성됩니다.
3. 첫 배포가 끝나면 발급된 주소(`https://<서비스명>.onrender.com`)를 확인하고,
   서비스 **Environment**에서 `BASE_URL`을 그 주소로 설정합니다(메일 링크·OG용).
   실제 메일 발송이 필요하면 같은 화면에서 `SMTP_*`를 채웁니다(비우면 발송함 모드).
4. **Logs**에서 첫 부팅 로그의 1회성 `admin` 비밀번호를 저장하고, HTTPS 주소로
   `/admin`에 로그인해 비밀번호를 바꾸세요(③-2와 동일).

**무료(free) 등급 주의**

- 15분간 요청이 없으면 잠들고 다음 요청에 30~50초 콜드스타트가 있습니다.
- **영구 디스크가 없어 재배포·재시작 시 `data/`(SQLite)가 초기화**됩니다. 부팅
  때 admin 계정·회차·설정은 다시 시드되지만, **예약 기록과 바꾼 비밀번호는
  사라집니다.** 시연에는 충분하며, 데이터를 계속 유지하려면 `render.yaml`의
  `disk:` 블록 주석을 풀고 **starter 이상 유료 인스턴스**로 올리세요.
- 무료 등급은 셸이 없어 `npm run demo-seed`를 서버에서 실행할 수 없습니다. 시연
  데이터가 필요하면 화면에서 직접 예약을 넣거나, 유료 인스턴스의 Shell에서
  `npm run demo-seed`를 실행하세요.

> 이 `Dockerfile`은 Render 전용이 아니라 표준 컨테이너 이미지이므로 Railway·
> Fly.io·자체 서버(③ Docker Compose) 등 어디서든 동일하게 배포할 수 있습니다.
> 데이터 영구 보존이 기본으로 필요하면 볼륨을 붙일 수 있는 이들 쪽이 낫습니다.

## ⑪ 호스팅 (Fly.io) — 데이터 영구 보존

Render 무료 등급과 달리 **영구 볼륨**을 붙일 수 있어 예약 기록이 재배포에도
유지됩니다. 저장소의 [`fly.toml`](../fly.toml)이 같은 [`Dockerfile`](../Dockerfile)을
빌드하고 볼륨을 `/app/data`에 마운트합니다. SQLite는 단일 writer이므로 **머신
1대**로만 운영합니다.

**절차** ([flyctl](https://fly.io/docs/flyctl/install/) 설치 후)

```bash
# 1) 앱 생성 (이름이 겹치면 다른 이름을 쓰고 fly.toml의 app 값도 맞추세요)
fly apps create raim-en

# 2) 영구 볼륨 생성 (없으면 머신이 뜨지 않습니다)
fly volumes create raim_data --size 1 --region nrt

# 3) 필수 비밀값 — 없으면 production 부팅을 거부합니다
fly secrets set SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
#    (선택) 실제 메일:  fly secrets set SMTP_HOST=... SMTP_USER=... SMTP_PASS=... SMTP_FROM=...
#    (선택) 시트 연동:  fly secrets set SHEETS_WEBHOOK_URL=... SHEETS_WEBHOOK_SECRET=... SHEETS_INBOUND_SECRET=...

# 4) 배포
fly deploy

# 5) 발급된 주소(https://raim-en.fly.dev)를 fly.toml [env] BASE_URL에 넣고 다시 배포
#    (메일 링크·OG용. 웹 페이지는 요청에서 자동 유추되지만 메일은 이 값을 씁니다)
fly deploy

# 6) 1회성 admin 비밀번호 확인 → HTTPS로 /admin 로그인 후 변경
fly logs
```

**참고**

- `min_machines_running = 1` 로 두어 스케줄 작업(개인정보 90일 삭제·방문 전날
  리마인더·아침 다이제스트)이 계속 돌게 했습니다. 시연용이라 비용을 더 줄이려면
  `fly.toml`에서 `min_machines_running = 0` (유휴 시 정지)으로 바꾸세요 — 대신
  정지 중에는 위 스케줄 작업이 수행되지 않습니다.
- 데이터 백업은 ⑦과 동일하게 볼륨 안 `raim.db`를 대상으로 하되, Fly에서는
  `fly ssh console` 로 접속해 실행하거나 `fly volumes snapshots` 를 씁니다.
- 시연 데이터가 필요하면 `fly ssh console -C "npm run demo-seed"` 로 채웁니다.
