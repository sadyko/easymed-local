-- 239 — LIS_PROXY_V1 (2026-10-09): ПРИЁМ ЧЕРЕЗ LIS PROXY
-- (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 8).
--
-- LIS Proxy — программа поставщика на лабораторном ПК: говорит с анализатором
-- и на каждое значение шлёт форму POST на /api/lisproxy. Её анализатор — строка
-- lab_devices с via = 'lisproxy'.
--
-- ТОЛЬКО ADD COLUMN (как мигр. 233): таблицы не пересобираются, CHECK
-- мигр. 123 не трогаются, бэкфилла нет, новых таблиц и триггеров нет.

-- Чей прибор: NULL — свой порт LIS (как все строки до этой миграции);
-- 'lisproxy' — анализатор за LIS Proxy. Пишет только сервер (discover.js
-- ensureProxyDevice). Свой порт такие строки не видит (discover.js
-- ensureDevice, lis/index.js — via IS NULL).
ALTER TABLE lab_devices ADD COLUMN via TEXT CHECK (via IS NULL OR via IN ('lisproxy'));

-- Имя анализатора в LIS Proxy (lisResult[name] / order[name]) — по нему и по
-- адресу прибор узнаётся; подпись (-host, обычно имя лабораторного ПК) — для
-- показа и для узнавания после смены адреса; адрес лабораторного ПК. Адрес —
-- НЕ host: триггер мигр. 233 (trg_lab_devices_address_unstamp) на смену host у
-- BS-200 снимает подтверждения, а смена адреса по DHCP у LIS Proxy — не смена
-- прибора. sending_app у таких строк пуст: по нему приём угадывает модель.
ALTER TABLE lab_devices ADD COLUMN proxy_name TEXT;
ALTER TABLE lab_devices ADD COLUMN proxy_label TEXT;
ALTER TABLE lab_devices ADD COLUMN proxy_ip TEXT;

-- Тело запроса LIS Proxy как пришло (форма, percent-encoding): raw держит
-- синтетический ORU^R01, который перечитывают серия, «Привязать» и «Поле
-- анализатора». Ответ Easy-Med (рабочий список — JSON) — для журнала: кто
-- спросил какую пробирку и что ему ответили. Пишет только сервер.
ALTER TABLE lab_device_messages ADD COLUMN source_body TEXT;
ALTER TABLE lab_device_messages ADD COLUMN reply_body TEXT;
