// CASE_OVERVIEW_V1 — «выписка с формированием оплаты».
//
// Владелец: «discharge button with generating the payments». Врач подаёт
// заявку на выписку — и в той же транзакции клиника получает счёт: проживание
// доначисляется по сегодняшний день (ACCOMMODATION_AS_SERVICE_V1: строкой
// admission_services), и все ещё не выставленные строки услуг собираются в
// ОДИН счёт госпитализации (billing.js, buildAdmissionInvoice). Касса видит
// готовый счёт до того, как пациент дойдёт до неё.
//
// Право — у того, кто подаёт заявку (лечащий врач / главный врач /
// администратор): это проверил admission_discharge_request. Роль кассы здесь
// не спрашивается — иначе врач «нажимал бы кнопку», а счёт не появлялся бы.
//
// Нечего выставлять — счёта нет (null), и это не ошибка: пациент, лежавший
// бесплатно, выписывается без бумаги о нуле.
import { computeAccommodation, billAccommodation } from './accommodation.js';
import { buildAdmissionInvoice } from './billing.js';

export function generateAdmissionBill(db, admissionId, user) {
  const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId);
  if (!adm) return null;
  let accommodationUnits = 0;
  try {
    const c = computeAccommodation(db, adm);
    if (c && c.units > 0) {
      billAccommodation(db, { admission_id: admissionId }, user);
      accommodationUnits = c.units;
    }
  } catch (e) {
    // Без палаты или тарифа проживание не считается — счёт собирается из услуг.
    accommodationUnits = 0;
  }
  const ids = db.prepare(`
    SELECT id FROM admission_services
     WHERE admission_id = ? AND invoice_item_id IS NULL AND billable = 1
     ORDER BY id`).all(admissionId).map((r) => r.id);
  if (!ids.length) return null;
  const { invoice, items } = buildAdmissionInvoice(db, admissionId, ids, user);
  return {
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    total_amount: invoice.total_amount,
    items: items.length,
    accommodation_units: accommodationUnits,
  };
}
