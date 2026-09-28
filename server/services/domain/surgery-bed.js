// SURGERY_NEEDS_BED_V1 — операция оформляется НА ГОСПИТАЛИЗАЦИЮ.
//
// Владелец: «the surgery is bundled so it goes with the hospitalization —
// which means only in bed located patients service bill created».
//
// Одно правило на все двери, которые заводят или подменяют строку визита:
// /api/db (routes/db.js) и касса (CASHIER_HEAD_V1: rpc/billing.js — добавить
// услугу, заменить услугу). Прежде оно жило только в routes/db.js, и касса
// могла поставить операцию амбулаторному пациенту.
//
// 'other' — это и есть хирургия: отдельного значения в services.type нет
// (миграция 109), а подписан этот тип «Хирургия». Госпитализация ищется по
// ПАЦИЕНТУ визита; койку занимают четыре состояния из семи.
export const SURGERY_NEEDS_BED_TEXT = 'Хирургия оформляется на госпитализацию: сначала положите пациента на койку, '
  + 'иначе счёт за операцию окажется вне истории лечения.';

/** Текст отказа или null. */
export function surgeryWithoutBedRefusal(db, serviceId, visitId) {
  if (!serviceId || !visitId) return null;
  let surgery = false;
  try { surgery = !!db.prepare("SELECT 1 FROM services WHERE id = ? AND type = 'other'").get(serviceId); } catch { surgery = false; }
  if (!surgery) return null;
  let admitted = false;
  try {
    admitted = !!db.prepare(`SELECT 1 FROM admissions a
       JOIN visits v ON v.patient_id = a.patient_id
      WHERE v.id = ?
        AND a.discharged_at IS NULL
        AND a.status IN ('admitted','examined','active','discharging')
      LIMIT 1`).get(visitId);
  } catch { admitted = false; }
  return admitted ? null : SURGERY_NEEDS_BED_TEXT;
}
