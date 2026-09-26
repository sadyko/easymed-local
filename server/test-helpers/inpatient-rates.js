// INPATIENT_BONUS_V1 (мигр. 155) — фикстуры, написанные до переноса.
//
// Тесты стационарной доли (INPATIENT_SHARE_V1) заводят врачей по-старому:
// «Стационар, %» ключом inpatient_pct внутри users.service_rates. Миграция 155
// переносит этот ключ в users.inpatient_rates, но фикстура пишется ПОСЛЕ
// migrate(), и переносить её некому. Этот помощник делает с фикстурой то же,
// что миграция с базой клиники (правило проверяет db/migrations/155.test.js):
// ставка → inpatient_rates [{service_id, pct}], ключ убирается, запись «только
// ради стационара» (амбулаторный 0, без fix и без price) удаляется из
// service_rates. Одно отличие, осознанное: фикстура, переписавшая
// service_rates, описывает ставки врача ЦЕЛИКОМ, поэтому inpatient_rates
// собирается заново из неё (миграция же дописывает к уже заполненной колонке).
// Так старые проверки денег остаются теми же числами на новой схеме.
export function moveInpatientPct(db) {
  for (const u of db.prepare("SELECT id, service_rates FROM users WHERE service_rates LIKE '%inpatient_pct%'").all()) {
    const inp = new Map();
    const kept = [];
    for (const e of JSON.parse(u.service_rates)) {
      const hasInp = typeof e.inpatient_pct === 'number';
      if (hasInp) inp.set(Number(e.service_id), { service_id: Number(e.service_id), pct: e.inpatient_pct });
      const onlyInp = hasInp && !(Number(e.pct) > 0) && e.fix === undefined && e.price === undefined;
      if (onlyInp) continue;
      const { inpatient_pct: _drop, ...rest } = e;
      kept.push(rest);
    }
    db.prepare('UPDATE users SET service_rates = ?, inpatient_rates = ? WHERE id = ?')
      .run(JSON.stringify(kept), JSON.stringify([...inp.values()]), u.id);
  }
}
