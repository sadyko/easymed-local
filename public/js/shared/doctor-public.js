// DOCTOR_PROFILE_V1 — ПУБЛИЧНЫЙ ПРОФИЛЬ ВРАЧА (шаг 5 API клиники): что видят
// пациенты на сайте клиники, в Symptex и у партнёров.
//
// Чистый модуль — без window, document, базы и перевода. Его читают карточка
// сотрудника («Публичный профиль», views/doctor-public-pane.js), список
// сотрудников, «Мой профиль», routes/users.js, rpc/doctor-profile.js,
// rpc/doctor-public.js, а в шаге 8 — API.
//
// Правила (спецификация «Правила, без которых не строим»; макет screen-doctor.js):
//   • показ врача меняет только администратор;
//   • показываемый врач — с ФИО на русском и хотя бы одной специальностью;
//   • документы печатают users.full_name и users.specialty — здесь их нет;
//   • скрытое здание прячет своих врачей (shared/branch-profile.js, шаг 4).
import { branchAllowsDoctor } from './branch-profile.js';

export const DOCTOR_LANGS = Object.freeze(['ru', 'uz', 'en']);
/** «Запись открыта на» (макет screen-doctor.js:101). */
export const BOOKING_DAYS = Object.freeze([7, 14, 30]);
export const DEFAULT_BOOKING_DAYS = 14;
/** Окно для партнёров — 15 минут у всех врачей (макет: «Одинаково для всех врачей»). */
export const PUBLIC_SLOT_MIN = 15;
/** «Что увидят партнёры» — семь дней, начиная с завтрашнего (макет nextDays(7)). */
export const PREVIEW_DAYS = 7;
export const PRACTICE_SINCE_MIN = 1940;

export const DOCTOR_PUBLIC_MESSAGES = Object.freeze({
  adminOnly:   'Показ врача на сайте и у партнёров меняет администратор.',
  nameRu:      'Чтобы показывать врача, введите ФИО на русском.',
  specialty:   'Чтобы показывать врача, выберите специальность.',
  oneLanguage: 'Нужен хотя бы один язык приёма.',
  languages:   'Языки приёма — только русский, узбекский и английский.',
  since:       'Год начала работы врачом — от 1940 до текущего года.',
  bookingDays: 'Запись открывается на 7, 14 или 30 дней вперёд.',
  flag:        'Отметка записана неверно: нужно «да» или «нет».',
  // SYMPTEX_FIELDS_V1 (ревью 2026-11-12, M10) — ссылки врача уходят партнёрам (snapshot.js), телефон — никогда
  socialsPublic: 'Instagram и Telegram видят пациенты на сайтах партнёров клиники. Телефон партнёрам не передаётся.',
});

const yearOf = (now) => (now instanceof Date ? now : new Date(now == null ? Date.now() : now)).getFullYear();

// SYMPTEX_FIELDS_V1 (ревью 2026-11-12, M2; повторное ревью 2026-11-13, N1/N2) —
// Instagram и Telegram врача для партнёров. Карточка принимает любую
// http(s)-ссылку (rpc/doctor-profile.js URL_KEYS); наружу уходит только ссылка
// на ПРОФИЛЬ в своей сети:
//   • адрес — http(s), хост своей сети (Instagram — instagram.com, www., m.;
//     Telegram — t.me, telegram.me, www.), без логина, пароля и порта;
//   • путь — ровно одно имя (и, может быть, «/» после него): имя по правилам
//     сети (Instagram — буквы, цифры, «.» и «_», до 30, без точки в начале, в
//     конце и двух подряд; Telegram — 5–32 знака, буквы, цифры и «_», с буквы)
//     и не служебный адрес (приглашения «+…» и joinchat, share, proxy, socks,
//     login, addstickers, accounts, explore…);
//   • ссылка собирается заново только из имени: https://instagram.com/<имя>,
//     https://t.me/<имя> — без запроса и якоря. Кавычки, пробелы и «<>» в неё
//     попасть не могут (в имени их нет).
// Иное — пустая строка. То же правило у Symptex (src/clinicdata/socials.js).
export const SOCIAL_LINK_HOSTS = Object.freeze({
  instagram: Object.freeze(['instagram.com', 'www.instagram.com', 'm.instagram.com']),
  telegram: Object.freeze(['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me']),
});
const SOCIAL_HANDLE = Object.freeze({ instagram: /^[A-Za-z0-9._]{1,30}$/, telegram: /^[A-Za-z][A-Za-z0-9_]{4,31}$/ });
const SOCIAL_RESERVED = Object.freeze({
  instagram: new Set(['explore', 'p', 'reel', 'reels', 'stories', 'accounts', 'direct', 'tv', 'about', 'developer', 'legal', 'privacy', 'web', 'challenge']),
  telegram: new Set(['joinchat', 'addstickers', 'addemoji', 'addtheme', 'addlist', 'share', 'proxy', 'socks', 'login', 'setlanguage',
    'confirmphone', 'invoice', 'giftcode', 'boost', 'contact', 'iv']),
});
const SOCIAL_BASE = Object.freeze({ instagram: 'https://instagram.com/', telegram: 'https://t.me/' });
export function doctorSocialLink(kind, v) {
  const hosts = SOCIAL_LINK_HOSTS[kind];
  const s = String(v == null ? '' : v).trim();
  if (!hosts || !s || s.length > 2000) return '';
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (u.username || u.password || u.port || !hosts.includes(u.hostname.toLowerCase())) return '';
  const m = /^\/([^/]+)\/?$/.exec(u.pathname);
  if (!m) return '';
  const handle = m[1];
  if (!SOCIAL_HANDLE[kind].test(handle) || SOCIAL_RESERVED[kind].has(handle.toLowerCase())) return '';
  if (kind === 'instagram' && (handle.startsWith('.') || handle.endsWith('.') || handle.includes('..'))) return '';
  return SOCIAL_BASE[kind] + handle;
}

/** Языки → ['ru','uz','en'] в этом порядке, без повторов; не список или чужой код → null. */
export function normalizeLanguages(v) {
  let list = v;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return null; } }
  if (!Array.isArray(list) || !list.every((x) => DOCTOR_LANGS.includes(x))) return null;
  return DOCTOR_LANGS.filter((l) => list.includes(l));
}
/** Сохранённое (TEXT JSON или массив) → массив; мусор → []. Для чтения. */
export function readLanguages(v) { return normalizeLanguages(v) || []; }
/** Присланный список: null — годен. */
export function languagesProblem(v) {
  const list = normalizeLanguages(v);
  if (!list) return DOCTOR_PUBLIC_MESSAGES.languages;
  if (!list.length) return DOCTOR_PUBLIC_MESSAGES.oneLanguage;
  return null;
}

/** «Работает врачом с»: '' / null — снять; целый год 1940..текущий. { value } или { problem }. */
export function cleanPracticeSince(v, now = new Date()) {
  if (v == null || v === '') return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < PRACTICE_SINCE_MIN || n > yearOf(now)) return { problem: DOCTOR_PUBLIC_MESSAGES.since };
  return { value: n };
}
/** Стаж на сайте — полных лет от года начала работы (растёт сам). */
export function experienceYears(since, now = new Date()) {
  if (since == null || since === '') return null;
  const n = Number(since);
  return Number.isInteger(n) ? Math.max(0, yearOf(now) - n) : null;
}
/** Год, который показывает экран: свой — иначе из прежнего стажа (строка главной старой версии). */
export function shownPracticeSince(profile, now = new Date()) {
  const p = profile || {};
  if (p.practice_since != null && p.practice_since !== '') return Number(p.practice_since);
  if (p.experience_years != null && p.experience_years !== '') return yearOf(now) - Number(p.experience_years);
  return null;
}
/**
 * Стаж и «работает с» — одно значение в двух колонках: прежний стаж
 * (users.experience_years — его читают филиалы старой версии и прежние экраны)
 * пишется вместе с годом. Пришёл год — стаж из него; пришёл только стаж
 * (экран старой версии) — год из стажа.
 */
export function withExperience(values, now = new Date()) {
  const out = { ...values };
  if ('practice_since' in out) out.experience_years = experienceYears(out.practice_since, now);
  else if ('experience_years' in out) out.practice_since = out.experience_years == null ? null : yearOf(now) - Number(out.experience_years);
  return out;
}

/** Заполненность — семь проверок макета (completeness): ФИО ×3, специальность, биография ×3. */
const MISS = Object.freeze({
  full_name_ru: 'ФИО RU', full_name_uz: 'ФИО UZ', full_name_en: 'ФИО EN',
  bio_ru: 'биография RU', bio_uz: 'биография UZ', bio_en: 'биография EN',
});
const SPECIALTY_MISS = 'специальность';
export const COMPLETENESS_LABELS = Object.freeze([...Object.values(MISS), SPECIALTY_MISS]);
export function profileCompleteness(profile, specialtiesCount) {
  const p = profile || {};
  const filled = (k) => String(p[k] == null ? '' : p[k]).trim() !== '';
  const missing = [];
  for (const k of ['full_name_ru', 'full_name_uz', 'full_name_en']) if (!filled(k)) missing.push(MISS[k]);
  if (!(Number(specialtiesCount) > 0)) missing.push(SPECIALTY_MISS);
  for (const k of ['bio_ru', 'bio_uz', 'bio_en']) if (!filled(k)) missing.push(MISS[k]);
  return { pct: Math.round(((7 - missing.length) / 7) * 100), missing };
}

/** Показываемый врач — с ФИО на русском и специальностью. null — можно. */
export function publicationProblem({ is_public, full_name_ru, specialties }) {
  if (!(is_public === true || Number(is_public) === 1)) return null;
  if (!String(full_name_ru == null ? '' : full_name_ru).trim()) return DOCTOR_PUBLIC_MESSAGES.nameRu;
  if (!(Number(specialties) > 0)) return DOCTOR_PUBLIC_MESSAGES.specialty;
  return null;
}

/**
 * Что с показом врача: 'shown' | 'off' | 'branch_hidden' | 'inactive' | 'not_doctor'.
 * Врач — по is_doctor, не по роли и специальности (инвариант проекта).
 * Скрытое здание прячет своих врачей (branchAllowsDoctor, шаг 4). Флаги — и
 * числами из базы, и булевыми из /api/users.
 */
export function doctorPublicState(doctor, branchesById) {
  const d = doctor || {};
  const on = (v) => v === true || Number(v) === 1;
  if (!on(d.is_doctor)) return 'not_doctor';
  if (d.is_active === false || (d.is_active != null && Number(d.is_active) === 0)) return 'inactive';
  if (!on(d.is_public)) return 'off';
  if (!branchAllowsDoctor(d, branchesById)) return 'branch_hidden';
  return 'shown';
}
export const doctorIsPublic = (doctor, branchesById) => doctorPublicState(doctor, branchesById) === 'shown';
