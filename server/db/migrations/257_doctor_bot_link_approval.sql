-- FIX_318_V1 (H3 + M2, 2026-10-28) — ПОДКЛЮЧЕНИЕ ВРАЧА К БОТУ — С ПОДТВЕРЖДЕНИЕМ
-- АДМИНИСТРАТОРА; ВЫКЛЮЧЕННЫЙ ВРАЧ ИЛИ СМЕНЁННЫЙ НОМЕР — ПОДКЛЮЧЕНИЕ ОТОЗВАНО.
--
-- Ревью выпуска 3.18.0 (бот для врачей-источников, мигр. 253):
--   H3 — клиника выключала врача-источника или меняла его номер, а бот
--        продолжал слать в его Telegram ФИО пришедших пациентов: выборка
--        уведомлений (doctor-bot/notify.js) не смотрела ни на active, ни на то,
--        что номер связки ещё номер врача;
--   M2 — подключение не требовало ничьего согласия: любой, кто пришлёт номер
--        из справочника, начинал получать имена пациентов.
--
-- 1. status — 'pending' (ждёт администратора), 'confirmed' (бот пишет),
--    'rejected' (отклонено; строка остаётся историей и отозвана). По умолчанию
--    'pending' — и для связок, заведённых до этой миграции: их никто не
--    подтверждал, поэтому они ждут администратора, как новые.
--    confirmed_at / confirmed_by — кто и когда подтвердил (вкладка
--    «Реферирование → Telegram-бот», список «Ожидают подтверждения»).
-- 2. Триггер на referral_sources: врача выключили (active = 0) или его номер
--    сменился по цифрам (последние 9 — ключ номера CRM) — открытые подключения
--    этого врача отзываются сразу. Смена записи того же номера («+998 90 …» →
--    «99890…») не отзывает. Включили врача обратно — подключение не
--    воскресает: врач присылает номер снова, администратор подтверждает.
--    Это вторая линия: выборка уведомлений и сама проверяет active и номер.
--
-- Только ADD COLUMN и CREATE TRIGGER.
ALTER TABLE doctor_bot_links ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'confirmed', 'rejected'));
ALTER TABLE doctor_bot_links ADD COLUMN confirmed_at TEXT;
ALTER TABLE doctor_bot_links ADD COLUMN confirmed_by INTEGER REFERENCES users(id);

CREATE TRIGGER doctor_bot_links_source_changed
AFTER UPDATE OF active, phone ON referral_sources
FOR EACH ROW WHEN NEW.active = 0 OR COALESCE(NEW.phone, '') <> COALESCE(OLD.phone, '')
BEGIN
  UPDATE doctor_bot_links
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
   WHERE referral_source_id = NEW.id
     AND revoked_at IS NULL
     AND (NEW.active = 0
          OR substr(replace(replace(replace(replace(replace(replace(replace(COALESCE(NEW.phone, ''),
                    ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), char(160), ''), -9)
             <> substr(replace(replace(replace(replace(replace(replace(replace(COALESCE(phone, ''),
                    ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), char(160), ''), -9));
END;
