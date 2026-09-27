-- PAY_REFUND_V1 (владелец, 2026-09-27) — «ВОЗВРАТ ЗАБИРАЕТ И ДОЛЮ ВРАЧА».
--
-- Доля врача считается по ВЫПОЛНЕННОЙ работе (PAY_BASIS_PERFORMED_V1). Счёт,
-- по которому деньги вернули целиком, доли не даёт — но отмена такого счёта
-- (void после полного возврата) ОТПУСКАЕТ строки со счёта: у строки визита или
-- стационара пропадает invoice_item_id, и она выглядела бы невыставленной
-- работой, которую надо оплатить врачу по цене счёта. Обычная отмена
-- неоплаченного счёта так и должна работать («работа остаётся, её выставят
-- заново»), а отмена после возврата — нет.
--
-- Различить их по самой строке нельзя: ссылка стёрта. Поэтому касса в момент
-- отпускания пишет сюда, что строка ушла со счёта, по которому были возвраты
-- (domain/pay-releases.js). Отчёты такую строку без нового счёта не платят;
-- выставят её снова и оплатят — платит по новому счёту, как обычно.
--
-- Своя таблица, а не колонка visit_services: строки визита ездят между
-- зданиями (branch-sync), а это — местный учёт выплаты.
CREATE TABLE pay_refund_releases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('out', 'in')),   -- out: visit_services, in: admission_services
  line_id     INTEGER NOT NULL,
  invoice_id  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_pay_refund_releases_line ON pay_refund_releases(kind, line_id);
