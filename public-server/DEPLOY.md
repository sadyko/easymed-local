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

```bash
sudo useradd --system --home /var/lib/easymed-public --shell /usr/sbin/nologin easymed-public
sudo install -d -o easymed-public -g easymed-public -m 700 /var/lib/easymed-public
sudo install -d -o root -g root -m 755 /opt/easymed-public
# код: выгрузка тега/коммита в /opt/easymed-public/repo (git archive | tar -x), владелец root, только чтение
cd /opt/easymed-public/repo/public-server && sudo npm ci --omit=dev   # better-sqlite3 для Linux x64, Node 24
```

## Настройки — `/etc/easymed-public.env`

Права на файл: владелец `root`, режим `640`, группа `easymed-public`.

```ini
PUBLIC_PORT=8095
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
# пусто — открытый ключ производителя, вшитый в программу (server/services/control/licence.js)
PUBLIC_LICENCE_PUBLIC_KEY=
```

## Служба — `/etc/systemd/system/easymed-public.service`

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

```nginx
upstream easymed_public { server 127.0.0.1:8095; keepalive 16; }
server {
  listen 443 ssl http2;
  server_name api.easymed.uz;
  ssl_certificate     /etc/letsencrypt/live/api.easymed.uz/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.easymed.uz/privkey.pem;
  client_max_body_size 5m;
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
server { listen 80; server_name api.easymed.uz; return 444; }   # http не принимаем: ключ уже ушёл бы открытым
```

## Проверка после установки

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now easymed-public
curl -s https://api.easymed.uz/_health                     # {"status":"ok",...}
systemctl show easymed-public -p MemoryCurrent -p MemoryMax
journalctl -u easymed-public --since "10 min ago"          # тел запросов и данных пациентов здесь нет
```

Наблюдение — 8c:
- `/_health` раз в минуту, сообщение в Telegram при сбое;
- `/_metrics` с токеном: очередь заявок, не доставленные уведомления, клиники на связи.

## Восстановление базы из копии

- Только при **остановленной** службе: `sudo systemctl stop easymed-public`, заменить `/var/lib/easymed-public/public.db` (файлы `public.db-wal` и `public.db-shm` убрать), `sudo systemctl start easymed-public`.
- **Заявки, принятые после снятия копии, теряются**: их статус и запечатанные данные были только в заменённой базе, а клиники их, может быть, ещё не забрали. Партнёр на `GET /requests/{id}` получит 404 — пусть позвонит в клинику. Код этого не исправит; копию снимать часто, но хранить не дольше суток.
- Статусы остальных заявок — как на момент копии, пока клиника не пришлёт по ним новое событие.
- Курсоры очереди при запуске поднимаются до часов сервера (`floorInboxCursor`), поэтому клиники, чей курсор ушёл вперёд, новые заявки получают; уже принятое клиника по номеру заявки узнаёт как повтор.
