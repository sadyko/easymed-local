// CRM_DAY_LINES_V1 (3.23.0) — ЧТО ИЗ ЗАЯВОК ПОДСТАВИТЬ В СМЕТУ ЭТОГО ДНЯ: выбор из ждущих строк
// карточек пациента. Чистая функция, без базы и DOM: её зовёт сервер (rpc/crm-day-lines.js,
// RPC crm_day_lines), а прежде то же самое делал браузер (crm-lines.js) — правило одно.
//
// Два шага, оба — прежние правила подстановки (crm-lines.js до 3.23.0):
//   1. CRM_REAL_BOOKING_V1 — визит известен (окно открыто на конкретном визите): строки ИМЕННО
//      этого приёма; ни одна строка на него не ссылается (записали не через слот) — весь день:
//      сузить до пустоты хуже, чем предложить лишнее;
//   2. V3120_FIX / V3120_FINAL — ОДНА УСЛУГА — ОДНА СТРОКА: две карточки одного человека на
//      одну консультацию у одного врача (или по виду приёма) дают в смету одну строку — из
//      одинаковых остаётся строка этого визита, иначе самая ранняя. Строка без услуги и вида
//      приёма — сама по себе.
const same = (a, b) => a != null && b != null && String(a) === String(b);

/** @param {Array<{id, service_id, consultation_type_id, doctor_id, visit_id}>} lines — по порядку id */
export function pickDayLines(lines, visitId = null) {
  const all = dedupe(Array.isArray(lines) ? lines : [], visitId);
  if (visitId == null || visitId === '') return all;
  const mine = all.filter((l) => same(l.visit_id, visitId));
  return mine.length ? mine : all;
}

function dedupe(lines, visitId) {
  const byKey = new Map();
  const mine = (x) => visitId != null && same(x.visit_id, visitId);
  for (const l of lines) {
    const svcKey = l.service_id != null ? 's:' + l.service_id
      : (l.consultation_type_id != null ? 'c:' + l.consultation_type_id : null);
    if (svcKey == null) { byKey.set('#' + l.id, l); continue; }   // без услуги сравнивать нечего
    const k = svcKey + '|d:' + (l.doctor_id || '');
    const had = byKey.get(k);
    if (!had || (mine(l) && !mine(had))) byKey.set(k, l);
  }
  return [...byKey.values()];
}
