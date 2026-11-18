// VISIT_TIER_ATTENDED_V1 (3.25.0) — «ПРОШЛЫЙ ПРИЁМ ВЫСТАВЛЕН» ДЛЯ СТЕНДОВ ТЕСТОВ.
//
// С 3.25.0 цена второго и повторного визита считается только от прошлого
// визита, на который пациент пришёл и строка которого выставлена в живой счёт
// (server/services/rpc/service-price-quote.js). Стенды, которые кладут историю
// пациента прямо в базу («прошлый приём, выполнен»), теперь кладут её и со
// счётом — так, как она выглядит у настоящей кассы: счёт визита, позиция
// строки, ссылка строки на позицию. Цена позиции — та, что дал бы счёт по
// ЗАПИСАННОМУ ярусу строки (domain/pricing.js lineUnitPrice — то же правило,
// которым доля врача считала эту строку без счёта); ярус строки помощник НЕ
// трогает (настоящий create_invoice_for_visit решил бы его заново) — история
// остаётся ровно той, что задал стенд. Не тестовый файл — его импортируют.
import { lineUnitPrice } from '../services/domain/pricing.js';

/**
 * Выставить строку visit_services отдельным счётом (status — 'paid' по
 * умолчанию; 'void' / 'refunded' — отменённый). Возвращает id счёта.
 */
export function markBilled(db, visitServiceId, { status = 'paid' } = {}) {
  const vs = db.prepare(`SELECT vs.*, v.patient_id AS visit_patient_id, v.visit_date AS visit_at
                           FROM visit_services vs JOIN visits v ON v.id = vs.visit_id WHERE vs.id = ?`).get(visitServiceId);
  if (!vs) throw new Error('markBilled: строки ' + visitServiceId + ' нет');
  const service = vs.service_id != null ? db.prepare('SELECT * FROM services WHERE id = ?').get(vs.service_id) || null : null;
  const qty = Number(vs.quantity) > 0 ? Number(vs.quantity) : 1;
  const unit = Math.round((Number(lineUnitPrice(db, vs, { service })) || 0) * 100) / 100;
  const total = Math.round(unit * qty * 100) / 100;
  // Счёт — в день визита (отчёты считают выставленную строку по дню счёта).
  const invoiceId = Number(db.prepare(`INSERT INTO invoices (visit_id, patient_id, subtotal, total_amount, paid_amount, status, created_at, paid_at)
                                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(vs.visit_id, vs.visit_patient_id, total, total, status === 'paid' ? total : 0, status, vs.visit_at, status === 'paid' ? vs.visit_at : null).lastInsertRowid);
  const itemId = Number(db.prepare(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total)
                                    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(invoiceId, vs.service_id, (service && service.name) || '', qty, unit, total).lastInsertRowid);
  db.prepare('UPDATE visit_services SET invoice_item_id = ?, unit_price = ?, total = ? WHERE id = ?').run(itemId, unit, total, visitServiceId);
  return invoiceId;
}
