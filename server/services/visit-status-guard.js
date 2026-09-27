// V3120_FIX (2026-09-27) — РАБОТА НАД НЕОПЛАЧЕННОЙ УСЛУГОЙ НЕ НАЧИНАЕТСЯ.
//
// Статус строки визита (visit_services.status) экраны лаборатории и кабинета
// врача меняют обычной дверью /api/db: «Проба взята» → 'collected', «В работу»
// → 'in_progress', «Подписать» → 'completed'. Сервер порядка не проверял
// вовсе: неоплаченный анализ можно было взять, а неоплаченную консультацию —
// подписать. У save_lab_results (rpc/lab.js) правило уже было — «результат
// вносят после кассы»; здесь ТО ЖЕ правило для всех остальных шагов работы.
//
// ПРАВИЛО. Строку в статусе 'added' (в смете, касса ещё не приняла деньги)
// нельзя перевести в работу — 'collected' / 'in_progress' / 'resulted' /
// 'completed', — если за неё есть что платить. Исключения:
//   • бесплатная строка (total = 0) — платить нечего (FREE_SERVICE_V1);
//   • строка в счёте ОРГАНИЗАЦИИ (invoices.payer_id) — её отпускает плательщик,
//     а не касса (COVER_SPLIT_V1);
//   • строка в уже оплаченном счёте (или отпущенном в долг) — касса своё
//     решение приняла, статус просто не догнал.
// Строки, которые уже 'queued' (оплачены или отпущены плательщиком) и дальше,
// правило не трогает: порядок шагов ПОСЛЕ кассы ведут сами экраны.
//
// Функция чистая по отношению к базе (только SELECT) и возвращает текст отказа
// по-русски или null. Зовёт её дверь /api/db (crm/booking-mirror-db.js,
// mirrorBefore) до записи.

/** Статусы, означающие «над пациентом уже работают». */
export const WORK_STATUSES = Object.freeze(['collected', 'in_progress', 'resulted', 'completed']);

const holes = (a) => a.map(() => '?').join(',');

/**
 * Отказ переводу строк визита `ids` в статус `nextStatus` — или null.
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} ids
 * @param {string} nextStatus
 */
export function unpaidWorkRefusal(db, ids, nextStatus) {
  if (!WORK_STATUSES.includes(String(nextStatus || ''))) return null;
  const list = (ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return null;
  const rows = db.prepare(`
    SELECT vs.id, vs.status, vs.total, vs.service_id, vs.consultation_type_id,
           s.name AS svc_name, s.type AS svc_type, s.is_lab,
           i.payer_id AS inv_payer, i.status AS inv_status
      FROM visit_services vs
      LEFT JOIN services s       ON s.id = vs.service_id
      LEFT JOIN invoice_items ii ON ii.id = vs.invoice_item_id
      LEFT JOIN invoices i       ON i.id = ii.invoice_id
     WHERE vs.id IN (${holes(list)})`).all(...list);
  for (const r of rows) {
    if (r.status !== 'added') continue;
    if (!(Number(r.total) > 0)) continue;
    if (r.inv_payer != null) continue;
    if (r.inv_status === 'paid' || r.inv_status === 'debt') continue;   // долг — касса отпустила
    const name = r.svc_name || (r.consultation_type_id != null ? 'Консультация' : 'услуга');
    if (Number(r.is_lab) === 1 || r.svc_type === 'lab') {
      return `Анализ «${name}» ещё не оплачен — пробу берут и результат вносят после кассы.`;
    }
    if (nextStatus === 'completed' && (r.svc_type === 'consultation' || r.service_id == null)) {
      return `Консультация «${name}» ещё не оплачена — подписать её можно после кассы.`;
    }
    return `Услуга «${name}» ещё не оплачена — начать работу по ней можно после кассы.`;
  }
  return null;
}
