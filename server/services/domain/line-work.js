// REFUND_ANY_V1 — «ПО СТРОКЕ ВИЗИТА ЕСТЬ РАБОТА»: одно правило на сервер.
//
// Перенесено из rpc/billing.js без изменений (ревью B4, п. 9): тем же правилом
// теперь судит и перевод статуса (visit-status-guard.js — возвращённую строку
// без следа работы в работу не берут), а тянуть ради него весь billing.js в
// ворота статуса нельзя — billing.js сам приходит к этим воротам через
// crm/booking-mirror. billing.js отдаёт оба имени дальше, как прежде, поэтому
// правка неоплаченного, возврат строки, отмена счёта и окно «Вернуть услугу»
// не изменились.

// INPATIENT_MONEY_FIX_V1 — ВЫПОЛНЕННАЯ РАБОТА НЕ СНИМАЕТСЯ И НЕ ПОДМЕНЯЕТСЯ.
//
// Один список «работа начата или сделана» на сервер — его же спрашивает отмена
// счёта (cashier.js voidInvoice). Прежде здесь стояли только in_progress и
// completed: взятый анализ ('collected') снимался вместе с пробой, а на
// готовом ('resulted') удаление падало 500 на внешнем ключе lab_results.
// Замена услуги перенесла бы результаты анализа на другую услугу. След работы
// (результат, документ, сообщение прибора) держит строку так же, как статус.
export const PERFORMED_LINE_STATUSES = ['collected', 'in_progress', 'resulted', 'completed'];

// REFUND_ANY_V1 (ревью B3) — ОДНО ПРАВИЛО «ПО СТРОКЕ ВИЗИТА ЕСТЬ РАБОТА»:
// статус работы (PERFORMED_LINE_STATUSES) ИЛИ след — результат анализа,
// документ (в том числе отозванный), сообщение анализатора. Эти ссылки —
// простые внешние ключи без каскада: строку с ними удалить нельзя, и снимать
// её как «неначатую» нельзя. Спрашивают его правка неоплаченного
// (assertNotPerformed), возврат строки (refundInvoiceLine), отмена счёта
// (cashier.js voidInvoice), окно «Вернуть услугу» (invoiceLineWork) и — ревью
// B4 — перевод статуса и отметка процедуры (visit-status-guard.js,
// rpc/procedures.js): экран и сервер решают одинаково. `vs` — { id, status }
// строки визита.
export function lineHasWork(db, vs) {
  if (PERFORMED_LINE_STATUSES.includes(vs.status)) return true;
  const trace = db.prepare(`
    SELECT (EXISTS(SELECT 1 FROM lab_results WHERE visit_service_id = ?)
         OR EXISTS(SELECT 1 FROM visit_documents WHERE visit_service_id = ?)
         OR EXISTS(SELECT 1 FROM lab_device_messages WHERE visit_service_id = ?)) AS t`).get(vs.id, vs.id, vs.id);
  return !!(trace && trace.t);
}
