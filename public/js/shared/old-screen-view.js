// V3121_ROLES — «ПРОСМОТР» ОТ СТАРОГО ЭКРАНА «РОЛИ»: ОТПЕЧАТОК И ВОЗВРАТ.
//
// Экран «Роли» 0.9–3.0 сохранял «Стационар» и «Закупки» с уровнем «viewer»
// (уровень тогда ничего не значил). Пересохранение такой роли на матрице
// (3.1+) превращало его в явный «Просмотр» на каждом окне и действии раздела
// (permission-catalog.js grantsFromLegacy) — и с 3.2 медсестра не записывает
// измерения, склад не выдаёт со склада.
//
// ОТЛИЧИТЬ ТАКУЮ СТРОКУ ОТ ВЫБОРА ЧЕЛОВЕКА НЕЛЬЗЯ. «Просмотр» на всех строках
// раздела, выставленный руками на нынешнем экране, сохраняется байт в байт тем
// же (тот же collect → legacyFromGrants). Поэтому миграция 215 права НЕ
// меняет: она записывает совпавшие строки в role_permission_reviews, а экран
// «Роли» показывает администратору такую роль с выбором «Вернуть права по
// умолчанию» или «Оставить как есть». Отпечаток и возврат — здесь, в одном
// месте для экрана и теста; SQL миграции повторяет отпечаток (тест сверяет).
//
// ВОЗВРАТ — это снять ключи раздела (решает прежнее правило ролей в коде, то
// есть ровно то, что основа роли получает по умолчанию, не выше) и поставить
// уровню раздела «editor», как у штатных ролей: иначе следующее «Сохранить» на
// матрице снова вывело бы из «viewer» тот же «Просмотр».
export const OLD_SCREEN_AREAS = Object.freeze({
  inpatient: Object.freeze({
    legacyKey: 'beds',
    keys: Object.freeze({
      inpatient: 'view', 'inpatient.requests': 'view', 'inpatient.patients': 'view', 'inpatient.beds': 'view',
      'inpatient.history': 'view', 'inpatient.prescriptions': 'view', 'inpatient.marks': 'view', 'inpatient.vitals': 'view',
      'inpatient.reviews': 'view', 'inpatient.services': 'view', 'inpatient.discharge': 'none',
      mar: 'view', 'mar.outpatient': 'view', 'mar.inpatient': 'view', kitchen: 'view', discharges: 'view',
    }),
  }),
  procurement: Object.freeze({
    legacyKey: 'inventory',
    keys: Object.freeze({ procurement: 'view', 'procurement.issue': 'none' }),
  }),
});

function parse(perms) {
  if (typeof perms === 'string') { try { return JSON.parse(perms); } catch { return null; } }
  return perms && typeof perms === 'object' ? perms : null;
}

/** Совпадает ли строка прав с отпечатком старого перевода по разделу. */
export function matchesOldScreen(perms, area) {
  const p = parse(perms);
  const a = OLD_SCREEN_AREAS[area];
  if (!p || !a) return false;
  if (!p.levels || p.levels[a.legacyKey] !== 'viewer') return false;
  const g = p.grants && typeof p.grants === 'object' ? p.grants : null;
  if (!g) return false;
  return Object.entries(a.keys).every(([k, v]) => g[k] === v);
}

/** Строка прав с правами раздела «по умолчанию основы» (не меняет исходную). */
export function restoreOldScreenArea(perms, area) {
  const p = JSON.parse(JSON.stringify(parse(perms) || {}));
  const a = OLD_SCREEN_AREAS[area];
  if (!a) return p;
  p.grants = { ...(p.grants || {}) };
  for (const k of Object.keys(a.keys)) delete p.grants[k];
  p.levels = { ...(p.levels || {}), [a.legacyKey]: 'editor' };
  return p;
}
