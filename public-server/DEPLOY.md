# Публичный сервер api.easymed.uz — как он ставится (PUBLIC_SERVER_V1)

Это описание для шага 8c. Сам шаг 8b на сервер ничего не ставит.

## Где и почему так

- **Машина** — 45.77.242.169 (Vultr, Сингапур), решение владельца 16. На ней уже работают Symptex, n8n и старый шлюз.
  - В августе 2026 нехватка памяти уже роняла symptex.uz (память `symptex-gateway-fragility`).
  - Поэтому служба — **отдельный процесс** под **отдельным пользователем**, с **жёстким потолком памяти**: её падение не роняет соседей, а их падение — её.
- **Данные пациента**:
  - хранятся только запечатанными ключом клиники и стираются, как только клиника подтвердила приём;
  - не забранные клиникой — стираются через сутки, заявка закрывается для партнёра (решение владельца 20, `PUBLIC_UNCOLLECTED_MAX_HOURS`);
  - журнал запросов — без тел;
  - резервные копии базы держать не дольше суток (столько же живёт не забранная заявка) и не копировать их за пределы машины без шифрования.
- **Код** — выгрузка репозитория целиком (как у `control-plane/`). Служба берёт справочники и проверку подписи из `server/` и `public/js/shared/` того же коммита.

## Пользователь, папки, зависимости

На своей машине, в клоне репозитория (`<коммит>` — тег или хеш выпуска службы):

```bash
git -c core.autocrlf=false archive --format=tar.gz -o easymed-public.tar.gz <коммит>
scp easymed-public.tar.gz root@45.77.242.169:/tmp/
```

На сервере (Node 24 уже стоит; `npm ci` берёт пакеты из реестра npm):

```bash
sudo useradd --system --home /var/lib/easymed-public --shell /usr/sbin/nologin easymed-public
sudo install -d -o easymed-public -g easymed-public -m 700 /var/lib/easymed-public
sudo install -d -o root -g root -m 755 /opt/easymed-public /opt/easymed-public/repo
sudo tar -xzf /tmp/easymed-public.tar.gz -C /opt/easymed-public/repo && sudo rm -f /tmp/easymed-public.tar.gz
cd /opt/easymed-public/repo/public-server && sudo npm ci --omit=dev
sudo -u easymed-public node --input-type=module -e "import D from 'better-sqlite3'; new D(':memory:'); console.log('better-sqlite3 ok')"
```

- `npm ci` ставит ровно `public-server/package-lock.json` — те же версии, что в корне репозитория и в тестах. Lock выводится из корневого без сети: `node public-server/scripts/lock-from-root.mjs` (после смены версий express или better-sqlite3 в корне; страж — `public-server/server/lockfile.test.js`).
- better-sqlite3 13 везёт готовую сборку для linux-x64 — компилятор и python не нужны.

## Настройки — `/etc/easymed-public.env`

Права на файл: владелец `root`, режим `640`, группа `easymed-public`:

```bash
sudo install -m 640 -o root -g easymed-public /dev/null /etc/easymed-public.env
sudoedit /etc/easymed-public.env    # вставить строки ниже
```

```ini
# 8096: порт 8095 на этой машине — у сервера лицензий (easymed-cp, docs/HANDOVER.md)
PUBLIC_PORT=8096
PUBLIC_BIND=127.0.0.1
PUBLIC_DATA_DIR=/var/lib/easymed-public
PUBLIC_BASE_URL=https://api.easymed.uz
PUBLIC_TRUST_PROXY=loopback
PUBLIC_REQUIRE_HTTPS=1
PUBLIC_TZ_OFFSET_MIN=300
# допуск часов компьютера клиники, минуты (решение контролёра 2026-10-12)
PUBLIC_SYNC_SKEW_MIN=15
# сколько не забранная клиникой заявка ждёт, часы; потом закрыта для партнёра, шифротекст стёрт (решение владельца 20)
PUBLIC_UNCOLLECTED_MAX_HOURS=24
# адреса самой машины — уведомления туда не уходят никогда (защита соседних служб)
PUBLIC_SELF_IPS=45.77.242.169
# токен для /_metrics (пусто — адреса нет)
PUBLIC_METRICS_TOKEN=
PUBLIC_WEBHOOKS=1
# пусто — открытый ключ производителя, вшитый в программу (server/services/control/licence.js) —
# НАСТОЯЩИЙ ключ сервера лицензий (8c сверил: 46de4fe9…696a). Другой ключ служба примет только
# вместе с PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1 — это стенд, не api.easymed.uz (licence-key.js)
PUBLIC_LICENCE_PUBLIC_KEY=
# список производителя (не оплачено, выключено, отозванные ключи) — PUBLIC_LICENCE_V1, шаг 8c.
# Сервер лицензий на этой же машине (easymed-cp, 127.0.0.1:8095) — берём напрямую, без DNS и TLS.
PUBLIC_FEED_URL=http://127.0.0.1:8095/cp/v1/public-feed
# тот же токен, что EASYMED_CP_FEED_TOKEN у easymed-cp (не короче 32 знаков: openssl rand -hex 24)
PUBLIC_FEED_TOKEN=
PUBLIC_FEED_EVERY_SEC=60
```

На сервере лицензий (`easymed-cp`) — та же строка токена в его окружении, затем перезапуск:

```bash
sudo systemctl edit easymed-cp     # [Service] Environment=EASYMED_CP_FEED_TOKEN=<тот же токен>
sudo systemctl restart easymed-cp
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8095/cp/v1/public-feed                                   # 401
curl -s -H "Authorization: Bearer <токен>" http://127.0.0.1:8095/cp/v1/public-feed | head -c 200; echo   # {"payload":{"kind":"easymed-public-feed",...
journalctl -u easymed-cp --since "5 min ago" | grep "Signing key"                                           # Signing key: the production vendor key.
```

## Служба — `/etc/systemd/system/easymed-public.service`

```bash
sudoedit /etc/systemd/system/easymed-public.service    # вставить содержимое ниже
```

```ini
[Unit]
Description=Easy-Med public API server (api.easymed.uz)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=easymed-public
Group=easymed-public
WorkingDirectory=/opt/easymed-public/repo/public-server
EnvironmentFile=/etc/easymed-public.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --max-old-space-size=160 server/index.js
Restart=on-failure
RestartSec=5
# потолок памяти и процессора — соседям (Symptex, n8n) ничего не грозит
MemoryHigh=200M
MemoryMax=256M
MemorySwapMax=0
CPUQuota=50%
TasksMax=64
LimitNOFILE=4096
# изоляция
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ReadWritePaths=/var/lib/easymed-public
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

## nginx — отдельный server и свой upstream

Только на этот процесс, мимо старого шлюза. Вопрос 2 (Cloudflare) решает 8c. Если включат прокси Cloudflare, `PUBLIC_TRUST_PROXY` и `set_real_ip_from` нужно настроить на адреса Cloudflare. Иначе «Разрешённые IP» и лимиты будут считать адреса Cloudflare, а не партнёров.

```bash
sudoedit /etc/nginx/sites-available/api.easymed.uz    # вставить содержимое ниже; сертификат Let's Encrypt — до этого шага (8c)
sudo ln -s /etc/nginx/sites-available/api.easymed.uz /etc/nginx/sites-enabled/api.easymed.uz
sudo nginx -t && sudo systemctl reload nginx
```

```nginx
upstream easymed_public { server 127.0.0.1:8096; keepalive 16; }
server {
  listen 443 ssl http2;
  server_name api.easymed.uz;
  ssl_certificate     /etc/letsencrypt/live/api.easymed.uz/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.easymed.uz/privkey.pem;
  client_max_body_size 5m;              # снимок и время клиники — до 4 МБ (routes/sync.js SNAPSHOT_MAX_BYTES), остальное меньше
  access_log off;                       # без адресов с параметрами и IP в журнале nginx; журнал запросов — в базе службы
  location / {
    proxy_pass http://easymed_public;   # без пути после адреса: путь и query доходят байт в байт (подпись клиники)
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_connect_timeout 3s;
    proxy_read_timeout 25s;
    proxy_send_timeout 25s;
  }
}
server {
  listen 80;
  server_name api.easymed.uz;
  location ~ ^/docs(/(uz|en))?/?$ { return 301 https://$host$request_uri; }   # документация — открытая страница: http ведёт на https
  location / { return 444; }            # остальное по http не принимаем: ключ уже ушёл бы открытым
}
```

## Проверка после установки

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now easymed-public
curl -s https://api.easymed.uz/_health                     # {"status":"ok",...}
curl -sI https://api.easymed.uz/docs | head -1             # HTTP/2 200 — документация для партнёров (API_DOCS_V1)
curl -sI http://api.easymed.uz/docs | grep -i ^location    # location: https://api.easymed.uz/docs
systemctl show easymed-public -p MemoryCurrent -p MemoryMax
journalctl -u easymed-public --since "10 min ago"          # тел запросов и данных пациентов здесь нет
journalctl -u easymed-public --since "10 min ago" | grep "Licence key"   # Licence key: the production vendor key compiled into the app (46de4fe9a62a7f1349bdd3658be1696a).
curl -s -H "Authorization: Bearer <PUBLIC_METRICS_TOKEN>" http://127.0.0.1:8096/_metrics | grep -o '"feed_[a-z_]*":[^,]*'   # feed_age_s меньше 120, feed_error ""
```

- Строки `WARNING: licence key … is NOT the production vendor key` и `WARNING: PUBLIC_FEED_TOKEN is not set` на api.easymed.uz быть не должно.

Наблюдение — 8c:
- `/_health` раз в минуту, сообщение в Telegram при сбое;
- `/_metrics` с токеном: очередь заявок, не доставленные уведомления, клиники на связи;
- PUBLIC_LICENCE_V1: `feed_age_s` больше 600 (список производителя не обновлялся 10 минут) или `feed_error` не пустой — сообщение: отметка «не оплачено» и срочный отзыв ключей не доходят до партнёров. «Не оплачено» публичный сервер узнаёт только из списка (неоплаченной клинике сервер лицензий новой лицензии не выдаёт — решение контролёра 8c): без списка партнёры видят её до конца её последней лицензии (до 14 дней).

### Включение клиники (PUBLIC_LICENCE_V1)

1. Клиника настроила «API и подключения» (имя в адресе, хоть одно подключение) — её экран «API» пишет «ждём включения Easy-Med».
2. Панель `settings.easymed.uz/cp/` → клиника → карточка **Online booking / API** → переключатель. Строка «Clinic's API key» показывает принятый ключ (первый принимается сам).
3. Не позже чем через час (ближайшая сверка) в лицензии клиники — отпечаток ключа; через 15 секунд обмен пошёл, строка карточки «Clinic's licence…» говорит «online booking on». Проверка: `curl -s -H "Authorization: Bearer <ключ партнёра>" https://api.easymed.uz/<имя клиники>/v1/clinic` → 200.
4. Выключение — тот же переключатель: партнёрам «временно недоступна» в пределах минуты (список производителя), обмен клиники замолкает со следующей сверки.

## Восстановление базы из копии

- Только при **остановленной** службе (`<копия>` — файл резервной копии):

```bash
sudo systemctl stop easymed-public
sudo rm -f /var/lib/easymed-public/public.db-wal /var/lib/easymed-public/public.db-shm
sudo install -o easymed-public -g easymed-public -m 600 <копия> /var/lib/easymed-public/public.db
sudo systemctl start easymed-public
```

- **Заявки, принятые после снятия копии, теряются**: их статус и запечатанные данные были только в заменённой базе, а клиники их, может быть, ещё не забрали. Партнёр на `GET /requests/{id}` получит 404 — пусть позвонит в клинику. Код этого не исправит; копию снимать часто, но хранить не дольше суток.
- Статусы остальных заявок — как на момент копии, пока клиника не пришлёт по ним новое событие.
- Курсоры очереди при запуске поднимаются до часов сервера (`floorInboxCursor`), поэтому клиники, чей курсор ушёл вперёд, новые заявки получают; уже принятое клиника по номеру заявки узнаёт как повтор.
