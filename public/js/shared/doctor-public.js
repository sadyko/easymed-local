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
});

const yearOf = (now) => (now instanceof Date ? now : new Date(now == null ? Date.now() : now)).getFullYear();

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
