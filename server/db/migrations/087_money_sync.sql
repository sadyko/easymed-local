-- 087_money_sync.sql — BRANCH_MONEY_V1: счета и платежи едут между зданиями.
--
-- До этой миграции `invoices`, `invoice_items` и `payments` не покидали здания,
-- где их завели (journal.js так и писал: «деньги — Фаза 3»). Следствие видел
-- владелец: в главной клинике КАЖДЫЙ денежный отчёт показывал ноль по соседним
-- зданиям — не «мало», а именно ноль, потому что строк там не было вовсе.
--
-- Здесь этим трём таблицам выдаётся ровно то же, что записям выдали 083 и 084:
-- глобальная личность строки (uid), метка происхождения (sync_origin) и
-- триггеры журнала. Идиома скопирована оттуда ДОСЛОВНО, и три её места нельзя
-- «упростить», не сломав регистрацию денег:
--
--   (a) *_journal_ins ЧИТАЕТ СТРОКУ, а не NEW.uid. В AFTER INSERT триггере
--       NEW.uid — это то, что вставило приложение, то есть NULL: uid ставит
--       соседний триггер *_uid_autogen, и его UPDATE в чужом NEW не виден ни при
--       каком порядке срабатывания (а порядок AFTER-триггеров SQLite не
--       определяет вовсе). Записать NEW.uid значило бы NOT NULL constraint
--       failed на КАЖДОМ выставленном счёте.
--   (b) OLD.uid IS NULL → '*'. Строка, у которой uid только что появился, для
--       сети новая целиком: без этого сам факт заведения счёта не попадал бы в
--       журнал ни одной записью, и счёт не уехал бы никуда.
--   (c) *_journal_del пишет надгробие ТЕМ ЖЕ триггером и чистит sync_authored.
--
-- ЧТО ИМЕННО ПЕРЕЧИСЛЕНО В *_journal_upd — только колонки, которые уезжают
-- (SHIPPED + ссылки, journal.js). Правка колонки, которой в списке нет, НЕ даёт
-- записи в журнал вовсе, и здесь это несущее решение, а не экономия:
--
--   invoices.paid_amount В СПИСКЕ НЕТ НАМЕРЕННО. Это производная величина —
--   сумма платежей по счёту, — и она не уезжает (journal.js SHIPPED). Каждое
--   здание считает её из ТЕХ платежей, которые к нему приехали (records.js), и
--   поэтому у него всегда сходится собственная касса: сумма payments и
--   invoices.paid_amount в одной базе — одно и то же число в любой момент. На
--   этом равенстве стоят и кассовый отчёт, и возвраты (billing.js
--   refundPayment). Приезжай paid_amount готовым, счёт показывал бы «оплачено
--   500 000» рядом с пустой таблицей платежей до тех пор, пока платёж не
--   доедет. Раз она не едет, ей нечего делать и в журнале: пересчёт на приёме
--   не должен становиться сетевым событием и гонять строку по кругу.
--
--   invoices.status, наоборот, ЕДЕТ и в списке есть. Он НЕ производная:
--   'debt' — решение кассира «пациент заплатит позже», 'void' и 'refunded' —
--   отмена и возврат. Посчитай мы его из сумм, как paid_amount, отменённый в
--   филиале счёт приехал бы в главную как обычный неоплаченный и попал бы в
--   «нам должны» — то есть отчёт врал бы деньгами. Спорить об этой колонке
--   двум зданиям не о чем: приехавший счёт правится ТОЛЬКО там, где он выписан
--   (billing.js, BRANCH_MONEY_GUARD_V1), значит автор у неё ровно один.
--
-- ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ — cash_shifts и cash_movements. Смена кассы это смена
-- КОНКРЕТНОГО ЧЕЛОВЕКА за КОНКРЕТНЫМ ящиком: у неё FK на users(id) и на
-- branches(id), а ни пользователи, ни локальные id филиалов между зданиями не
-- ездят (сотрудников везёт ОТДЕЛЬНЫЙ канал — справочник, миграция 086).
-- Привезённая смена ссылалась бы в пустоту при foreign_keys=ON и была бы
-- отвергнута базой построчно, строка за строкой. Решение записано и в плане
-- фазы: «склад, себестоимость и кассовые смены остаются внутри здания».
-- ЦЕНА, названная вслух: кассовый отчёт по ЧУЖОМУ зданию не может показать ни
-- имени кассира, ни остатка в ящике, ни внесений и изъятий. О чужой кассе здесь
-- известно ровно то, что несёт сам платёж: сумма, способ и время. X-отчёт и
-- сверка ящика остаются делом того здания, где стоит ящик.
--
-- ЧЕГО ЕЩЁ НЕТ — досоздания журнала задним числом, по той же причине, что в 084:
-- бэкфилл добавил бы по записи на КАЖДУЮ уже существующую строку. Следствие
-- надо знать: сосед, с которым эта установка УЖЕ обменивается (тёплый),
-- получит деньги только с момента обновления; счета, выписанные раньше,
-- поедут лишь холодным засевом — новому зданию или соседу, забытому и
-- засеянному заново (journal.js seedPage читает сами таблицы, и деньги в этом
-- чтении теперь есть).
--
-- И ПРЕДУПРЕЖДЕНИЕ ИЗ 084, теперь и для этих трёх таблиц: любой массовый UPDATE
-- или пересборка таблицы будущей миграцией — СЕТЕВОЕ СОБЫТИЕ, каждая тронутая
-- строка уедет соседям целиком. Оборачивайте такие миграции DROP TRIGGER и
-- повторным CREATE TRIGGER текстом отсюда, а не по памяти.

ALTER TABLE invoices      ADD COLUMN uid TEXT;
ALTER TABLE invoice_items ADD COLUMN uid TEXT;
ALTER TABLE payments      ADD COLUMN uid TEXT;

-- BRANCH_ORIGIN_V1 — откуда строка. NULL = выписана здесь; буква = приехала.
-- Ставится один раз, при вставке приехавшей записи (records.js). Отсюда же
-- работает запрет на правку чужих денег: сервер отказывает по этой колонке.
ALTER TABLE invoices      ADD COLUMN sync_origin TEXT;
ALTER TABLE invoice_items ADD COLUMN sync_origin TEXT;
ALTER TABLE payments      ADD COLUMN sync_origin TEXT;

UPDATE invoices      SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE invoice_items SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE payments      SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;

-- UNIQUE, а не просто INDEX (та же причина, что в 083): приём ищет строку по
-- uid, и два совпадения означали бы, что одна запись приехала дважды под
-- разными локальными id — молча выбрать любую хуже, чем упасть.
CREATE UNIQUE INDEX idx_invoices_uid      ON invoices(uid);
CREATE UNIQUE INDEX idx_invoice_items_uid ON invoice_items(uid);
CREATE UNIQUE INDEX idx_payments_uid      ON payments(uid);

CREATE TRIGGER invoices_uid_autogen AFTER INSERT ON invoices
  WHEN NEW.uid IS NULL
  BEGIN UPDATE invoices SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TRIGGER invoice_items_uid_autogen AFTER INSERT ON invoice_items
  WHEN NEW.uid IS NULL
  BEGIN UPDATE invoice_items SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TRIGGER payments_uid_autogen AFTER INSERT ON payments
  WHEN NEW.uid IS NULL
  BEGIN UPDATE payments SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;

-- ---- invoices --------------------------------------------------------------
CREATE TRIGGER invoices_journal_ins AFTER INSERT ON invoices
  BEGIN INSERT INTO sync_journal (tbl, uid, op, cols)
        SELECT 'invoices', uid, 'put', '*' FROM invoices
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER invoices_journal_upd AFTER UPDATE ON invoices
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'invoices', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.invoice_number IS NOT OLD.invoice_number THEN 'invoice_number,' ELSE '' END ||
             CASE WHEN NEW.subtotal IS NOT OLD.subtotal THEN 'subtotal,' ELSE '' END ||
             CASE WHEN NEW.discount_amount IS NOT OLD.discount_amount THEN 'discount_amount,' ELSE '' END ||
             CASE WHEN NEW.total_amount IS NOT OLD.total_amount THEN 'total_amount,' ELSE '' END ||
             CASE WHEN NEW.status IS NOT OLD.status THEN 'status,' ELSE '' END ||
             CASE WHEN NEW.created_at IS NOT OLD.created_at THEN 'created_at,' ELSE '' END ||
             CASE WHEN NEW.paid_at IS NOT OLD.paid_at THEN 'paid_at,' ELSE '' END ||
             CASE WHEN NEW.visit_id IS NOT OLD.visit_id THEN 'visit_id,' ELSE '' END ||
             CASE WHEN NEW.patient_id IS NOT OLD.patient_id THEN 'patient_id,' ELSE '' END, ',') END AS cols
        FROM invoices r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';

    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'invoices', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM invoices r
      JOIN (
            SELECT 'invoice_number' AS col WHERE NEW.invoice_number IS NOT OLD.invoice_number
            UNION ALL SELECT 'subtotal' WHERE NEW.subtotal IS NOT OLD.subtotal
            UNION ALL SELECT 'discount_amount' WHERE NEW.discount_amount IS NOT OLD.discount_amount
            UNION ALL SELECT 'total_amount' WHERE NEW.total_amount IS NOT OLD.total_amount
            UNION ALL SELECT 'status' WHERE NEW.status IS NOT OLD.status
            UNION ALL SELECT 'created_at' WHERE NEW.created_at IS NOT OLD.created_at
            UNION ALL SELECT 'paid_at' WHERE NEW.paid_at IS NOT OLD.paid_at
            UNION ALL SELECT 'visit_id' WHERE NEW.visit_id IS NOT OLD.visit_id
            UNION ALL SELECT 'patient_id' WHERE NEW.patient_id IS NOT OLD.patient_id
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
CREATE TRIGGER invoices_journal_del AFTER DELETE ON invoices
  WHEN OLD.uid IS NOT NULL
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op) VALUES ('invoices', OLD.uid, 'del');
    INSERT OR REPLACE INTO sync_tombstones (tbl, uid) VALUES ('invoices', OLD.uid);
    DELETE FROM sync_authored WHERE tbl = 'invoices' AND uid = OLD.uid;
  END;

-- ---- invoice_items ---------------------------------------------------------
CREATE TRIGGER invoice_items_journal_ins AFTER INSERT ON invoice_items
  BEGIN INSERT INTO sync_journal (tbl, uid, op, cols)
        SELECT 'invoice_items', uid, 'put', '*' FROM invoice_items
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER invoice_items_journal_upd AFTER UPDATE ON invoice_items
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'invoice_items', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.description IS NOT OLD.description THEN 'description,' ELSE '' END ||
             CASE WHEN NEW.quantity IS NOT OLD.quantity THEN 'quantity,' ELSE '' END ||
             CASE WHEN NEW.unit_price IS NOT OLD.unit_price THEN 'unit_price,' ELSE '' END ||
             CASE WHEN NEW.total IS NOT OLD.total THEN 'total,' ELSE '' END ||
             CASE WHEN NEW.created_at IS NOT OLD.created_at THEN 'created_at,' ELSE '' END ||
             CASE WHEN NEW.invoice_id IS NOT OLD.invoice_id THEN 'invoice_id,' ELSE '' END ||
             CASE WHEN NEW.service_id IS NOT OLD.service_id THEN 'service_id,' ELSE '' END, ',') END AS cols
        FROM invoice_items r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';

    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'invoice_items', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM invoice_items r
      JOIN (
            SELECT 'description' AS col WHERE NEW.description IS NOT OLD.description
            UNION ALL SELECT 'quantity' WHERE NEW.quantity IS NOT OLD.quantity
            UNION ALL SELECT 'unit_price' WHERE NEW.unit_price IS NOT OLD.unit_price
            UNION ALL SELECT 'total' WHERE NEW.total IS NOT OLD.total
            UNION ALL SELECT 'created_at' WHERE NEW.created_at IS NOT OLD.created_at
            UNION ALL SELECT 'invoice_id' WHERE NEW.invoice_id IS NOT OLD.invoice_id
            UNION ALL SELECT 'service_id' WHERE NEW.service_id IS NOT OLD.service_id
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
CREATE TRIGGER invoice_items_journal_del AFTER DELETE ON invoice_items
  WHEN OLD.uid IS NOT NULL
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op) VALUES ('invoice_items', OLD.uid, 'del');
    INSERT OR REPLACE INTO sync_tombstones (tbl, uid) VALUES ('invoice_items', OLD.uid);
    DELETE FROM sync_authored WHERE tbl = 'invoice_items' AND uid = OLD.uid;
  END;

-- ---- payments --------------------------------------------------------------
CREATE TRIGGER payments_journal_ins AFTER INSERT ON payments
  BEGIN INSERT INTO sync_journal (tbl, uid, op, cols)
        SELECT 'payments', uid, 'put', '*' FROM payments
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER payments_journal_upd AFTER UPDATE ON payments
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'payments', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.amount IS NOT OLD.amount THEN 'amount,' ELSE '' END ||
             CASE WHEN NEW.method IS NOT OLD.method THEN 'method,' ELSE '' END ||
             CASE WHEN NEW.notes IS NOT OLD.notes THEN 'notes,' ELSE '' END ||
             CASE WHEN NEW.paid_at IS NOT OLD.paid_at THEN 'paid_at,' ELSE '' END ||
             CASE WHEN NEW.created_at IS NOT OLD.created_at THEN 'created_at,' ELSE '' END ||
             CASE WHEN NEW.invoice_id IS NOT OLD.invoice_id THEN 'invoice_id,' ELSE '' END, ',') END AS cols
        FROM payments r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';

    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'payments', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM payments r
      JOIN (
            SELECT 'amount' AS col WHERE NEW.amount IS NOT OLD.amount
            UNION ALL SELECT 'method' WHERE NEW.method IS NOT OLD.method
            UNION ALL SELECT 'notes' WHERE NEW.notes IS NOT OLD.notes
            UNION ALL SELECT 'paid_at' WHERE NEW.paid_at IS NOT OLD.paid_at
            UNION ALL SELECT 'created_at' WHERE NEW.created_at IS NOT OLD.created_at
            UNION ALL SELECT 'invoice_id' WHERE NEW.invoice_id IS NOT OLD.invoice_id
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
CREATE TRIGGER payments_journal_del AFTER DELETE ON payments
  WHEN OLD.uid IS NOT NULL
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op) VALUES ('payments', OLD.uid, 'del');
    INSERT OR REPLACE INTO sync_tombstones (tbl, uid) VALUES ('payments', OLD.uid);
    DELETE FROM sync_authored WHERE tbl = 'payments' AND uid = OLD.uid;
  END;
