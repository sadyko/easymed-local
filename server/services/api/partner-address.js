// CLINIC_API_STEP7_V1 — РЕШЕНИЕ ВЛАДЕЛЬЦА 11 (2026-10-10): адрес для партнёров
// (город / область, район, улица RU из «Компании») необязателен, пока у клиники
// нет включённых подключений API, и обязателен, как только включено хоть одно:
//   • включение подключения (и создание включённого) без полного адреса —
//     отказ 409 partner_address_required: экран ведёт в «Компанию»;
//   • пока подключение включено, «Компания» без адреса не сохраняется
//     (routes/db.js, 400 с полем).
// Проверка одна — partnerAddressProblems (shared/clinic-profile.js), та же у
// экрана. Филиалы, показанные партнёрам, — правило шага 4 (план шага 7, раздел
// «Шагам 4, 8 и 9»).
import { partnerAddressProblems, PARTNER_ADDRESS_COLUMNS, PROFILE_MESSAGES } from '../../../public/js/shared/clinic-profile.js';

export const ADDRESS_MESSAGES = Object.freeze({
  enable: 'Подключение нельзя включить: в «Компании» не заполнен адрес для партнёров — город или область, район и улица на русском.',
  save: PROFILE_MESSAGES.partnerAddress,
});

export function apiActive(db) {
  try { return !!db.prepare('SELECT 1 FROM api_connections WHERE active = 1 AND deleted_at IS NULL LIMIT 1').get(); }
  catch { return false; }   // база до мигр. 242 — подключений нет
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

/** Включение подключения: адрес неполон — отказ 409 с кодом partner_address_required. */
export function requirePartnerAddress(db) {
  if (!Object.keys(companyAddressProblems(db)).length) return;
  const e = new Error(ADDRESS_MESSAGES.enable);
  e.status = 409;
  e.code = 'partner_address_required';
  throw e;
}

/** /api/db: правка doc_settings, пока подключение включено. null — можно; иначе { field, message }. */
export function companyAddressRefusal(db, meta, body) {
  if (!meta || meta.table !== 'doc_settings' || (meta.op !== 'update' && meta.op !== 'upsert')) return null;
  if (!apiActive(db)) return null;
  const v = body && body.values;
  const values = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const problems = companyAddressProblems(db, values);
  const field = PARTNER_ADDRESS_COLUMNS.find((c) => problems[c]);
  return field ? { field, message: ADDRESS_MESSAGES.save } : null;
}
