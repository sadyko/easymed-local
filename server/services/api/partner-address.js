// CLINIC_API_STEP7_V1 — РЕШЕНИЕ ВЛАДЕЛЬЦА 11 (2026-10-10): адрес для партнёров
// (город / область, район, улица RU из «Компании») необязателен, пока у клиники
// нет включённых подключений API, и обязателен, как только включено хоть одно:
//   • включение подключения (и создание включённого) без полного адреса —
//     отказ 409 partner_address_required: экран ведёт в «Компанию»;
//   • пока подключение включено, «Компания» без адреса не сохраняется
//     (routes/db.js, 400 с полем).
// Проверка одна — partnerAddressProblems (shared/clinic-profile.js), та же у
// экрана.
//
// ЗДАНИЯ, ПОКАЗАННЫЕ ПАРТНЁРАМ (план шага 7, «Шагам 4, 8 и 9», «Завершение» п. 5;
// строит шаг, влившийся вторым): то же правило для каждого филиала, который
// работает и отмечен «Показывать на сайте» (branchShownToPartners — так их
// прочтёт шаг 8). Главное здание — только через «Компанию»: его строка branches
// адреса не держит (шаг 4, одно место на здание).
//   • включение подключения — отказ 409, сообщение называет здание (шаблон);
//   • /api/db: сохранение такого филиала с неполным адресом и включение отметки
//     у филиала с неполным адресом — 400 с полем (routes/db.js).
import { partnerAddressProblems, PARTNER_ADDRESS_COLUMNS, PROFILE_MESSAGES } from '../../../public/js/shared/clinic-profile.js';
import { readIdentity } from '../branch-sync/identity.js';   // CLINIC_API_STEP7_V1 (ревью №8)
import { branchShownToPartners } from '../../../public/js/shared/branch-profile.js';   // CLINIC_API_STEP7_V1 — здания на сайте
import { withTemplate } from '../server-message.js';   // CLINIC_API_STEP7_V1 — сообщение называет здание: шаблон + значения

export const ADDRESS_MESSAGES = Object.freeze({
  enable: 'Подключение нельзя включить: в «Компании» не заполнен адрес для партнёров — город или область, район и улица на русском.',
  save: PROFILE_MESSAGES.partnerAddress,
  // CLINIC_API_STEP7_V1 — здания, показанные на сайте.
  enableBranch: 'Подключение нельзя включить: у здания «{name}», которое показывается на сайте, не заполнен адрес для партнёров — город или область, район и улица на русском. Заполните его в «Филиалах» или снимите там «Показывать филиал на сайте и у партнёров».',
  enableBranches: 'Подключение нельзя включить: у зданий, которые показываются на сайте, не заполнен адрес для партнёров — {names}. Заполните его в «Филиалах» или снимите там «Показывать филиал на сайте и у партнёров».',
  saveBranch: 'Пока включены подключения API, у здания, которое показывается на сайте, адрес для партнёров обязателен: город или область, район и улица на русском. Заполните его или снимите «Показывать филиал на сайте и у партнёров».',
  // CLINIC_API_STEP7_V1 (ревью слияния №1) — «Добавить филиал» карточки синхронизации
  // при включённом подключении заводит здание скрытым (rpc/branch-sync.js).
  addBranchHidden: 'Новый филиал пока не показывается на сайте и у партнёров: пока включено подключение API, сначала заполните его адрес в «Филиалах» — город или область, район и улицу на русском, — затем включите там «Показывать филиал на сайте и у партнёров».',
});

export function apiActive(db) {
  try { return !!db.prepare('SELECT 1 FROM api_connections WHERE active = 1 AND deleted_at IS NULL LIMIT 1').get(); }
  catch { return false; }   // база до мигр. 242 — подключений нет
}

// CLINIC_API_STEP7_V1 (ревью №8) — адрес для партнёров требуется только в ГЛАВНОМ
// здании: подключения живут там (таблицы api_* в филиал не едут, записи в филиале —
// 409). Здание, ставшее филиалом с подключением, оставленным включённым, иначе не
// могло бы очистить адрес своего здания, а выключить подключение отсюда нельзя.
function isSecondaryInstall(db) {
  try { return readIdentity(db).role === 'secondary'; } catch { return false; }
}
/** Обязателен ли сейчас адрес для партнёров: главное здание и включено хоть одно подключение. */
export function partnerAddressRequired(db) {
  return !isSecondaryInstall(db) && apiActive(db);
}

/** Есть ли из чего выбирать (как availability() экрана, company-address.js). */
export function addressAvailability(db, row) {
  const country = String((row && row.country_code) || 'UZ');
  let regionsAvailable = false;
  let districtsAvailable = false;
  try {
    regionsAvailable = !!db.prepare(`SELECT 1 FROM regions r JOIN countries c ON c.id = r.country_id
      WHERE c.code = ? AND r.code IS NOT NULL AND r.active = 1 LIMIT 1`).get(country);
    if (row && row.region_code) {
      districtsAvailable = !!db.prepare(`SELECT 1 FROM districts d JOIN regions r ON r.id = d.region_id
        WHERE r.code = ? AND d.code IS NOT NULL AND d.active = 1 LIMIT 1`).get(row.region_code);
    }
  } catch { /* справочника нет — требовать можно только улицу */ }
  return { regionsAvailable, districtsAvailable };
}

/** Проблемы адреса «Компании» (с присланными правками поверх сохранённого). */
export function companyAddressProblems(db, values = null) {
  let cur = {};
  try { cur = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {}; } catch { cur = {}; }
  const row = values ? { ...cur, ...values } : cur;
  return partnerAddressProblems(row, addressAvailability(db, row));
}

// CLINIC_API_STEP7_V1 — строка branches СВОЕГО здания установки (у главного —
// его строка, адрес которой живёт в «Компании»).
function ownBranchId(db) {
  try { return readIdentity(db).branch_id ?? null; } catch { return null; }
}
/** Проблемы адреса строки здания (CLINIC_API_STEP7_V1). */
export function branchAddressProblems(db, row) {
  return partnerAddressProblems(row || {}, addressAvailability(db, row));
}
/**
 * CLINIC_API_STEP7_V1 — что мешает включить подключение: адрес «Компании»
 * (главное здание) и каждый филиал, показанный партнёрам, с неполным адресом.
 * [{ building: 'main' | 'branch', branch_id, name, problems }] — сначала
 * «Компания», потом здания по порядку.
 */
export function partnerAddressBlockers(db) {
  const out = [];
  const own = ownBranchId(db);
  const company = companyAddressProblems(db);
  if (Object.keys(company).length) out.push({ building: 'main', branch_id: own, name: '', problems: company });
  let rows = [];
  try { rows = db.prepare('SELECT * FROM branches ORDER BY id').all(); } catch { rows = []; }
  for (const r of rows) {
    if (own != null && Number(r.id) === Number(own)) continue;   // главное — через «Компанию»
    if (!branchShownToPartners(r)) continue;                      // скрытое или закрытое партнёрам не видно
    const problems = branchAddressProblems(db, r);
    if (Object.keys(problems).length) out.push({ building: 'branch', branch_id: r.id, name: String(r.name || ''), problems });
  }
  return out;
}

/**
 * Включение подключения: адрес неполон — отказ 409. «Компания» — код
 * partner_address_required (экран ведёт в «Компанию»); CLINIC_API_STEP7_V1 —
 * филиалы на сайте: код branch_address_required, сообщение называет здание
 * (экран ведёт в «Филиалы»).
 */
export function requirePartnerAddress(db) {
  const blockers = partnerAddressBlockers(db);
  if (!blockers.length) return;
  let e;
  if (blockers[0].building === 'main') {
    e = new Error(ADDRESS_MESSAGES.enable);
    e.code = 'partner_address_required';
  } else {
    e = blockers.length === 1
      ? withTemplate(new Error(''), ADDRESS_MESSAGES.enableBranch, { name: blockers[0].name })
      : withTemplate(new Error(''), ADDRESS_MESSAGES.enableBranches, { names: blockers.map((b) => b.name).join(', ') });
    e.code = 'branch_address_required';
  }
  e.status = 409;
  throw e;
}

/** /api/db: правка doc_settings, пока подключение включено. null — можно; иначе { field, message }. */
export function companyAddressRefusal(db, meta, body) {
  if (!meta || meta.table !== 'doc_settings' || (meta.op !== 'update' && meta.op !== 'upsert')) return null;
  if (!partnerAddressRequired(db)) return null;   // CLINIC_API_STEP7_V1 (ревью №8) — и не в филиале
  const v = body && body.values;
  const values = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const problems = companyAddressProblems(db, values);
  const field = PARTNER_ADDRESS_COLUMNS.find((c) => problems[c]);
  return field ? { field, message: ADDRESS_MESSAGES.save } : null;
}

// CLINIC_API_STEP7_V1 — /api/db: правка строки branches, пока подключение включено.
// Строки, которые правят: отбор по id (eq / in — так пишут экраны); иной отбор —
// все здания. Своя строка главного здания не проверяется: её адрес — «Компания».
function targetRows(db, body) {
  const f = body && Array.isArray(body.filters) ? body.filters : [];
  let ids = null;
  let byId = f.length > 0;
  for (const x of f) {
    if (!x || x.col !== 'id' || (x.op !== 'eq' && x.op !== 'in')) { byId = false; break; }
    const list = (x.op === 'in' && Array.isArray(x.val) ? x.val : [x.val]).map(Number);
    ids = ids == null ? list : ids.filter((i) => list.includes(i));
  }
  try {
    if (!byId) return db.prepare('SELECT * FROM branches').all();
    const one = db.prepare('SELECT * FROM branches WHERE id = ?');
    return [...new Set(ids)].map((i) => one.get(i)).filter(Boolean);
  } catch { return []; }
}
/**
 * Сохраняемая строка филиала (сохранённое + присланное) показывается партнёрам, а
 * адрес неполон — { field, message }; иначе null. Новое здание по умолчанию
 * работает и видно на сайте (мигр. 241). Скрыть или закрыть здание можно всегда.
 */
export function branchAddressRefusal(db, meta, body) {
  if (!meta || meta.table !== 'branches' || !['insert', 'update', 'upsert'].includes(meta.op)) return null;
  if (!partnerAddressRequired(db)) return null;   // главное здание и включено подключение (ревью №8)
  const v = body && body.values;
  const check = (row) => {
    if (!branchShownToPartners(row)) return null;
    const problems = branchAddressProblems(db, row);
    const field = PARTNER_ADDRESS_COLUMNS.find((c) => problems[c]);
    return field ? { field, message: ADDRESS_MESSAGES.saveBranch } : null;
  };
  if (meta.op !== 'update') {
    for (const row of Array.isArray(v) ? v : [v]) {
      const r = check({ active: 1, show_public: 1, ...(row && typeof row === 'object' ? row : {}) });
      if (r) return r;
    }
    return null;
  }
  const values = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const own = ownBranchId(db);
  for (const cur of targetRows(db, body)) {
    if (own != null && Number(cur.id) === Number(own)) continue;
    const r = check({ ...cur, ...values });
    if (r) return r;
  }
  return null;
}
