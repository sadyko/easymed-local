// BRANCH_PROFILE_V1 — ПРОФИЛЬ ЗДАНИЯ («Филиалы», шаг 4 API клиники): какие
// колонки branches правит только главное здание, какие свои у установки; одно
// место на адрес здания; «скрытое здание прячет врачей»; проверки записи и
// приёма синхронизации.
//
// Чистый модуль — без window, document, базы и перевода. Его читают экран
// «Филиалы» (views/branch-page.js, branches-editor.js), «Компания» филиала,
// /api/db (routes/db.js), синхронизация зданий (branch-sync/catalogue.js), RPC
// branch_hours_impact, а позже API (шаг 8) и публикация врача (шаг 5).
//
// ИМЕНА. branches.name — русское название: его показывает вся программа, по
// нему связываются здания и ищется здание при загрузке сотрудников. name_uz /
// name_en — рядом, наружу и в списке «Филиалов» на языке интерфейса.
//
// ОДНО МЕСТО НА АДРЕС ЗДАНИЯ. Главное здание держит адрес для партнёров, карту
// и телефон в своей «Компании» (doc_settings, шаг 3; решение владельца 11) —
// overlayOwnBuilding подставляет их в его строку. Остальные здания — в своих
// строках branches, их правит главное здание, синхронизация везёт их всем.
// Прежнее branches.address (вписанное руками в старом редакторе) больше не
// правится: третьего адреса у здания нет.
import { NAME_MAX, STREET_MAX, addressProblems, mapsProblem, storedProfileProblems } from './clinic-profile.js';
import { storedHoursProblem } from './branch-hours.js';

export const LANDMARK_MAX = 160;
const PHONE_MAX = 64;

/** Колонки миграции 241. */
export const BRANCH_PROFILE_COLUMNS = Object.freeze([
  'name_uz', 'name_en', 'country_code', 'region_code', 'district_code',
  'street_ru', 'street_uz', 'street_en', 'landmark_ru', 'landmark_uz', 'landmark_en',
  'maps_url', 'show_public',
]);
/** Едут в филиалы со списком сети, кроме name и часов (они ехали и раньше). */
export const BRANCH_SYNC_COLUMNS = Object.freeze(['phone', ...BRANCH_PROFILE_COLUMNS]);
/** Правит только главное здание: в филиале — 409 (routes/db.js). */
export const BRANCH_MAIN_COLUMNS = Object.freeze(['name', 'phone', ...BRANCH_PROFILE_COLUMNS, 'working_hours', 'is_24_7']);
/** Свои у каждой установки, как сегодня: между зданиями не ездят. address экран не правит (Р3). */
export const BRANCH_LOCAL_COLUMNS = Object.freeze(['address', 'active']);
/** Что правит страница здания. */
export const BRANCH_EDIT_COLUMNS = Object.freeze([...BRANCH_MAIN_COLUMNS, 'active']);
/** Главное здание: это берётся из его «Компании», в его строке branches не правится. */
export const OWN_FROM_COMPANY = Object.freeze([
  'country_code', 'region_code', 'district_code', 'street_ru', 'street_uz', 'street_en', 'maps_url', 'phone',
]);

export const BRANCH_MESSAGES = Object.freeze({
  name:              'Введите название на русском.',
  mainOnly:          'Названия, телефоны, адреса для партнёров, карты, часы работы и показ на сайте зданий меняются в главном здании.',
  newMainOnly:       'Новое здание заводится в главном здании.',
  ownInCompany:      'Адрес для партнёров, карта и телефон этого здания меняются в «Компании».',
  partnerInBranches: 'Адрес для партнёров и карту этого здания ведёт главное здание — в «Филиалах».',
  flag:              'Отметка записана неверно: нужно 0 или 1.',
  code:              'Код из справочника записан неверно.',
});

const TEXT = ['name', 'name_uz', 'name_en', 'phone', 'address', 'street_ru', 'street_uz', 'street_en',
  'landmark_ru', 'landmark_uz', 'landmark_en', 'maps_url'];
const FLAGS = ['show_public', 'is_24_7', 'active'];
const CODES = ['country_code', 'region_code', 'district_code'];
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;   // countries / regions / districts.code (мигр. 132)
const TEXT_MAX = {
  name: NAME_MAX, name_uz: NAME_MAX, name_en: NAME_MAX, phone: PHONE_MAX,
  street_ru: STREET_MAX, street_uz: STREET_MAX, street_en: STREET_MAX,
  landmark_ru: LANDMARK_MAX, landmark_uz: LANDMARK_MAX, landmark_en: LANDMARK_MAX,
};

export function normalizeBranch(v) {
  const out = { ...v };
  for (const k of TEXT) if (k in out) out[k] = String(out[k] == null ? '' : out[k]).trim();
  for (const k of FLAGS) if (k in out) out[k] = Number(out[k]) ? 1 : 0;
  return out;
}

/** Экран: название RU, адрес для партнёров «всё или ничего» (как «Компания»), карта. */
export function branchProblems(v, geo = {}) {
  const p = { ...addressProblems(v, geo) };
  if (!String(v.name || '').trim()) p.name = BRANCH_MESSAGES.name;
  const mp = mapsProblem(v.maps_url); if (mp) p.maps_url = mp;
  return p;
}

/** Сервер: значения ровно в том виде, в каком их пишут в базу; проверяются только присланные. */
export function storedBranchProblems(values) {
  const p = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return p;
  const given = (k) => Object.prototype.hasOwnProperty.call(values, k) && values[k] != null;
  if (given('maps_url')) { const m = storedProfileProblems({ maps_url: values.maps_url }).maps_url; if (m) p.maps_url = m; }
  if (given('working_hours')) { const m = storedHoursProblem(values.working_hours); if (m) p.working_hours = m; }
  for (const k of FLAGS) if (given(k) && ![0, 1, true, false].includes(values[k])) p[k] = BRANCH_MESSAGES.flag;
  for (const k of CODES) {
    if (given(k) && values[k] !== '' && !(typeof values[k] === 'string' && CODE_RE.test(values[k]))) p[k] = BRANCH_MESSAGES.code;
  }
  return p;
}

/**
 * Синхронизация: можно ли записать приехавшее значение. Нельзя — пропустить,
 * а не уронить приём (справочник принимается ОДНОЙ транзакцией: catalogue.js).
 */
export function syncableBranchValue(col, v) {
  if (col === 'show_public') return v === 0 || v === 1;
  if (typeof v !== 'string') return false;
  if (TEXT_MAX[col] && v.length > TEXT_MAX[col]) return false;
  return !Object.keys(storedBranchProblems({ [col]: v })).length;
}

/**
 * Строка ГЛАВНОГО здания так, как её видят пациенты и партнёры: адрес для
 * партнёров, карта и телефон — из его «Компании» (company = строка
 * doc_settings), остальное — из самой строки. Колонки, которой у «Компании»
 * нет (база до 240), не подменяются. Зовут: список и страница «Филиалов»,
 * выгрузка в филиалы (catalogue.js), API (шаг 8).
 */
export function overlayOwnBuilding(row, company) {
  if (!row || !company || typeof company !== 'object' || Array.isArray(company)) return row;
  const out = { ...row };
  for (const c of OWN_FROM_COMPANY) if (c in company && company[c] != null) out[c] = company[c];
  return out;
}

/**
 * Не прячет ли врача его здание. Скрытое здание (show_public = 0) прячет и
 * своих врачей — макет «Филиалы» (решение владельца 2026-10-06: «его врачи
 * тоже не показываются»). Здание врача — users.branch_id, как у часов и
 * календаря (rpc/calendar.js resourceWindow). Врач без здания и врач здания,
 * которого нет в списке, этим правилом не прячутся. Остальные условия
 * публикации врача (переключатель администратора) — шаг 5; API — шаг 8.
 */
export function branchAllowsDoctor(doctor, branchesById) {
  const id = doctor && doctor.branch_id;
  if (id == null || id === '') return true;
  const b = branchesById instanceof Map ? branchesById.get(Number(id)) : null;
  return !b || Number(b.show_public) !== 0;
}
