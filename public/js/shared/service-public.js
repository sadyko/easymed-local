// SERVICES_PACKAGES_V1 — УСЛУГИ НА САЙТЕ И У ПАРТНЁРОВ (шаг 6 API клиники):
// пять групп прайса и их коды для API, кто из услуг показывается, цифры
// экрана «Услуги для сайта и партнёров».
//
// Чистый модуль — без window, document, базы и перевода. Его читают экран
// (views/services-public.js), RPC services_public_overview / services_set_online
// (server/services/rpc/services-public.js), /api/db (routes/db.js — правило
// показа при любой записи услуги), service_save, пакеты (shared/package-price.js
// — пакет показывается, только если показаны все его услуги) и в шаге 8 — API.
//
// ПОКАЗ — это прежний флаг services.online_booking (мигр. 131): один флаг на
// сайт клиники, Symptex и партнёров. Правило прежнее (владелец, 2026-09-15):
// показывать можно только услугу с названием на русском и узбекском;
// английское — по желанию, без него партнёры покажут русское.
//
// ГРУППА — services.type, фиксированные пять (словарь владельца: «Группа» —
// пять, «Тип» и «Категория» клиника пишет сама). В базе хирургия — 'other'
// (мигр. 109), устаревшее 'radiology' — «Диагностика». Коды для партнёров —
// из документации API (макет screen-docs.js:61): consultations, lab,
// diagnostics, procedures, surgery.
import { isOn } from './flags.js';

/** Пять групп — в порядке макета (data.js GROUPS): ключ базы, код API, подпись (ключ словаря). */
export const PUBLIC_GROUPS = Object.freeze([
  Object.freeze({ key: 'consultation', api: 'consultations', label: 'Консультации' }),
  Object.freeze({ key: 'lab', api: 'lab', label: 'Лаборатория' }),
  Object.freeze({ key: 'imaging', api: 'diagnostics', label: 'Диагностика' }),
  Object.freeze({ key: 'procedure', api: 'procedures', label: 'Процедуры' }),
  Object.freeze({ key: 'other', api: 'surgery', label: 'Хирургия' }),
]);
export const GROUP_KEYS = Object.freeze(PUBLIC_GROUPS.map((g) => g.key));
export const API_GROUPS = Object.freeze(PUBLIC_GROUPS.map((g) => g.api));

export const SERVICE_PUBLIC_MESSAGES = Object.freeze({
  needUz:           'Нужно название на узбекском',
  online:           'Чтобы показывать услугу на сайте и у партнёров, нужно название на русском и узбекском.',
  adminOnly:        'Показ услуг на сайте и у партнёров меняет администратор.',
  mainOnly:         'Показ услуг меняется в главном здании — сюда он приходит с прайсом.',
  ids:              'Не выбрано ни одной услуги.',
  flag:             'Отметка записана неверно: нужно «да» или «нет».',
  noPerformer:      'Нет врача — в профилях врачей партнёры её не увидят.',
  performersHidden: 'Все её врачи скрыты — в профилях врачей партнёры её не увидят.',
});

const text = (v) => String(v == null ? '' : v).trim();

/** Группа услуги — одна из пяти: по services.type; 'radiology' — «Диагностика»; без типа — по признаку лаборатории (как services.js groupKey). */
export function serviceGroupOf(service) {
  const t = text(service && service.type).toLowerCase();
  if (t === 'radiology') return 'imaging';
  if (GROUP_KEYS.includes(t)) return t;
  return service && isOn(service.is_lab) ? 'lab' : 'consultation';
}

/** Код группы для партнёров (consultations / lab / diagnostics / procedures / surgery). */
export function apiGroupOf(service) {
  const key = serviceGroupOf(service);
  return PUBLIC_GROUPS.find((g) => g.key === key).api;
}

/** Код API → значения services.type (для отбора ?group= в шаге 8); чужой код — null. */
export function programTypesOfApi(code) {
  const g = PUBLIC_GROUPS.find((x) => x.api === code);
  if (!g) return null;
  return g.key === 'imaging' ? ['imaging', 'radiology'] : [g.key];
}

/** Есть название на русском (services.name) и на узбекском. */
export function serviceNamesReady(service) {
  return !!(text(service && service.name) && text(service && service.name_uz));
}

/** Названия на трёх языках; пустое — '' (в шаге 8 партнёр получит вместо него русское). */
export function serviceNames(service) {
  return { ru: text(service && service.name), uz: text(service && service.name_uz), en: text(service && service.name_en) };
}

/**
 * Что с показом услуги: 'shown' | 'off' | 'no_uz' | 'inactive'.
 * Отключённая в прайсе (active = 0) не показывается никогда; без названия на
 * узбекском — тоже, даже если флаг стоит (импорт до CLINIC_API_FIX_V1 мог его
 * поставить).
 */
export function servicePublicState(service) {
  const s = service || {};
  if (s.active != null && !isOn(s.active) && s.active !== true) return 'inactive';
  if (!serviceNamesReady(s)) return 'no_uz';
  return isOn(s.online_booking) || s.online_booking === true ? 'shown' : 'off';
}

/** Правило показа перед записью: строка (как ляжет в базу) с включённым показом без названия RU + UZ — текст отказа; иначе null. */
export function onlineRuleProblem(row) {
  const r = row || {};
  if (!(isOn(r.online_booking) || r.online_booking === true)) return null;
  return serviceNamesReady(r) ? null : SERVICE_PUBLIC_MESSAGES.online;
}

/**
 * Решение владельца 12 — услуга прайса группы «Консультации» у врачей:
 * performers — [{ id, shown }] (shown — врач виден партнёрам). null — с ней
 * всё в порядке; иначе ключ предупреждения.
 */
export function consultServiceWarning(performers) {
  const list = Array.isArray(performers) ? performers : [];
  if (!list.length) return 'noPerformer';
  return list.some((p) => p && p.shown) ? null : 'performersHidden';
}

/**
 * «Показать всю группу»: какие услуги группы включить и какие пропустить.
 * Отключённые в прайсе не трогаются вовсе; уже показанные — не в списке.
 */
export function bulkShowPlan(services, group) {
  const on = [];
  const skipped = [];
  for (const s of services || []) {
    if (!s || serviceGroupOf(s) !== group) continue;
    const st = servicePublicState(s);
    if (st === 'off') on.push(Number(s.id));
    else if (st === 'no_uz') skipped.push(Number(s.id));
  }
  return { on, skipped };
}

/**
 * Три цифры над вкладками (макет screen-services.js:39-41):
 *   • показываем услуг — показанных из всех действующих;
 *   • врачей с ценами консультаций — видимых партнёрам и ведущих хоть одну консультацию, из всех действующих врачей;
 *   • без перевода на английский — ПОКАЗАННЫХ услуг без английского названия (отступление от макета: скрытая услуга наружу не уходит).
 * doctors — [{ state, consultations: [...] }] (state — doctorPublicState).
 */
export function servicePublicFacts(services, doctors) {
  const active = (services || []).filter((s) => servicePublicState(s) !== 'inactive');
  const shown = active.filter((s) => servicePublicState(s) === 'shown');
  const docs = doctors || [];
  return {
    services_shown: shown.length,
    services_total: active.length,
    doctors_shown: docs.filter((d) => d && d.state === 'shown' && Array.isArray(d.consultations) && d.consultations.length > 0).length,
    doctors_total: docs.length,
    no_en: shown.filter((s) => !text(s.name_en)).length,
  };
}
