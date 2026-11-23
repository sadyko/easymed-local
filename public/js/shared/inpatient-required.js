// INPATIENT_REQUIRED_V1 (2026-11-23) — ЧТО В СТАЦИОНАРЕ ОБЯЗАТЕЛЬНО: ОБЩИЕ ПРАВИЛА СЕРВЕРА И ЭКРАНА.
//
// Сервер по этим правилам считает полноту титульного листа и пустые обязательные
// разделы (rpc/title-sheet.js, rpc/inpatient-reviews.js), экран — рисует отметки
// (views/required-marks.js). Русского текста здесь нет намеренно: подписи полей —
// у экрана (i18n), слова отказов — у сервера.
//
// Этот модуль не импортирует title-sheet-rules.js (тот импортирует его): кольца нет.
import { SECTION_KEYS, sectionsFor } from './case-doc-sections.js';
import { richIsEmpty, textIsBlank } from './rich-text.js';

/**
 * Поля титульного листа, которые клиника вправе сделать обязательными.
 * where: 'sheet' — admission_title_sheets, 'patient' — карточка пациента,
 * 'paper' — отметка бумаги (заполнено = время отметки, колонка col).
 * Не предлагаются: ФИО и дата рождения (личность, правится в карточке), ИМТ
 * (вычисляется), примечание.
 * INPATIENT_REQUIRED_V1 (ревью) — и ПОЛ: карточка хранит 'other' там, где пол не выбран
 * (миграция 002, DEFAULT 'other'), и «Другое» — настоящий ответ. Отличить «не указан» от
 * «другое» нечем, поле было бы обязательным, которое никогда не пустое. Пол и так
 * спрашивает регистрация.
 */
export const TITLE_FIELDS = Object.freeze([
  ...['phone', 'address', 'national_id', 'occupation',
    'emergency_contact_name', 'emergency_contact_phone', 'blood_type', 'allergies']
    .map((key) => ({ key, group: 'patient', where: 'patient' })),
  ...['referred_from', 'delivered_by', 'mobility', 'since_onset'].map((key) => ({ key, group: 'admission', where: 'sheet' })),
  ...['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm'].map((key) => ({ key, group: 'measures', where: 'sheet' })),
  ...['pediculosis', 'sanitation'].map((key) => ({ key, group: 'exam', where: 'sheet' })),
  { key: 'contract_signed', group: 'papers', where: 'paper', col: 'contract_signed_at' },
  { key: 'consent_signed',  group: 'papers', where: 'paper', col: 'consent_signed_at' },
  { key: 'memo_given',      group: 'papers', where: 'paper', col: 'memo_given_at' },
].map(Object.freeze));
export const TITLE_GROUPS = Object.freeze(['patient', 'admission', 'measures', 'exam', 'papers']);
export const TITLE_FIELD_KEYS = Object.freeze(TITLE_FIELDS.map((f) => f.key));
/** Сегодняшние восемь (title-sheet-rules.js REQUIRED_KEYS) — тест держит их равными. */
export const DEFAULT_TITLE_REQUIRED = Object.freeze(['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation']);
/** Переключатели строки inpatient_settings (миграция 298). */
export const SWITCH_KEYS = Object.freeze(['intake_before_attending', 'admitting_at_placement', 'primary_needs_diagnosis', 'discharge_needs_epicrisis', 'title_required']);

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && textIsBlank(v));

/** Заполнено ли одно поле: лист (или форма экрана) и карточка пациента. */
export function titleFieldFilled(def, { sheet = null, patient = null } = {}) {
  if (!def) return true;
  if (def.where === 'patient') {
    const v = patient ? patient[def.key] : null;
    // Группа крови «unknown» — умолчание карточки (мигр. 002), то есть «не указана».
    if (def.key === 'blood_type' && String(v || '').trim().toLowerCase() === 'unknown') return false;
    return !blank(v);
  }
  if (!sheet) return false;
  // Бумага: в базе — время отметки, в форме экрана — галочка.
  // INPATIENT_REQUIRED_V1 (ревью) — галочка формы, если она есть, главнее старой отметки в базе:
  // снятая галочка значит «не подписано», даже когда строка из базы ещё несёт время.
  if (def.where === 'paper') {
    if (typeof sheet[def.key] === 'boolean') return sheet[def.key];
    return !blank(sheet[def.col]);
  }
  return !blank(sheet[def.key]);
}

/** Только известные ключи, без повторов, в порядке листа. */
export function cleanTitleRequired(keys) {
  const want = new Set(Array.isArray(keys) ? keys.map(String) : []);
  return TITLE_FIELD_KEYS.filter((k) => want.has(k));
}

/** Какие из обязательных полей пусты — в порядке листа. */
export function missingTitleFields({ sheet = null, patient = null } = {}, requiredKeys = DEFAULT_TITLE_REQUIRED) {
  const want = new Set(cleanTitleRequired(requiredKeys));
  return TITLE_FIELDS.filter((f) => want.has(f.key) && !titleFieldFilled(f, { sheet, patient })).map((f) => f.key);
}

/** Обязательные разделы: только те, что у документа есть, без повторов, в порядке документа. */
export function cleanRequiredSections(list, allowedSections) {
  const want = new Set(Array.isArray(list) ? list.map(String) : []);
  return (Array.isArray(allowedSections) ? allowedSections : []).filter((k) => want.has(k));
}

/** JSON колонки case_doc_types.required_sections → чистый список для рода; испорчено — пусто. */
export function parseRequiredSections(raw, kind) {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const v = Array.isArray(raw) ? raw : JSON.parse(raw);   // INPATIENT_REQUIRED_V1 (ревью) — уже разобранный список тоже
    return cleanRequiredSections(Array.isArray(v) ? v : [], sectionsFor(kind));
  } catch (e) { return []; }
}

/** Пустые обязательные разделы записи: разметка — по richIsEmpty, диагноз — по тексту. */
export function missingSections(fields, requiredSections) {
  const f = fields || {};
  return (Array.isArray(requiredSections) ? requiredSections : []).filter((key) => {
    if (!SECTION_KEYS.includes(key)) return false;
    return key === 'diagnosis' ? blank(f[key]) : richIsEmpty(f[key]);
  });
}

/** Ответ inpatient_settings_get → правила экрана. Пусто или сбой — сегодняшние правила. */
export function rulesFromSettings(data) {
  const s = (data && data.settings) || {};
  const on = (k) => (s[k] === undefined || s[k] === null ? true : !!Number(s[k]));
  const docs = {};
  for (const d of (data && Array.isArray(data.docs) ? data.docs : [])) {
    if (!d || !d.kind) continue;
    docs[d.kind] = {
      required: !(d.required === false || d.required === 0),
      requiredSections: Array.isArray(d.required_sections) ? d.required_sections.map(String) : [],
    };
  }
  return {
    intakeBeforeAttending: on('intake_before_attending'),
    admittingAtPlacement: on('admitting_at_placement'),
    primaryNeedsDiagnosis: on('primary_needs_diagnosis'),
    dischargeNeedsEpicrisis: on('discharge_needs_epicrisis'),
    titleRequired: on('title_required'),
    titleFields: Array.isArray(s.title_required_fields) ? cleanTitleRequired(s.title_required_fields) : DEFAULT_TITLE_REQUIRED.slice(),
    docs,
  };
}
// Заморожено вглубь: одна копия умолчаний на все экраны, правка на месте её бы испортила.
const defaultRules = rulesFromSettings(null);
export const DEFAULT_RULES = Object.freeze(Object.assign(defaultRules, {
  titleFields: Object.freeze(defaultRules.titleFields),
  docs: Object.freeze(defaultRules.docs),
}));

/** Обязательные разделы документа этого рода по правилам экрана. */
export function requiredSectionsOf(rules, kind) {
  const d = rules && rules.docs && rules.docs[kind];
  return d && Array.isArray(d.requiredSections) ? d.requiredSections.slice() : [];
}

/** Обязательные поля листа по правилам экрана: лист не обязателен — не обязательно ничего. */
export function titleKeysOf(rules) {
  const r = rules || DEFAULT_RULES;
  return r.titleRequired ? (r.titleFields || []).slice() : [];
}

/**
 * Ждёт ли госпитализация лечащего врача. withoutExam — переключатель «лечащий врач
 * только после осмотра» выключен: тогда ждёт и пациент, только что положенный на койку.
 */
export function waitsForAttending(row, withoutExam) {
  if (!row) return false;
  return row.status === 'examined' || (withoutExam === true && row.status === 'admitted');
}

/**
 * INPATIENT_REQUIRED_V1 (ревью) — этот ли человек приёмный врач госпитализации: то же
 * правило, что isAdmittingDoctor сервера (rpc/inpatient-flow.js) — номер совпал И среди
 * ролей (основная + extra_roles, как effectiveRoles) есть doctor. is_doctor здесь не в
 * счёт: это признак для списков врачей, его носит и медсестра со специальностью, а сервер
 * её по имени не пускает — кнопка по одному номеру вела бы в отказ.
 * Номера сравниваются строками: экран получает их и числом, и строкой.
 */
const rolesOfUser = (user) => [user.role, ...(Array.isArray(user.extra_roles) ? user.extra_roles : [])]
  .map((r) => String(r == null ? '' : r).trim().toLowerCase());
const namedAdmitting = (adm, user) => !!adm && !!user && user.id !== null && user.id !== undefined && user.id !== ''
  && adm.admitting_doctor_id !== null && adm.admitting_doctor_id !== undefined
  && String(adm.admitting_doctor_id) === String(user.id);

export function isAdmittingDoctorOf(adm, user) {
  return namedAdmitting(adm, user) && rolesOfUser(user).includes('doctor');
}

/**
 * INPATIENT_REQUIRED_V1 (ревью) — «это мой пациент на осмотр при поступлении»: назван
 * приёмным врачом И сервер этот шаг ему отдаст — по имени (isAdmittingDoctorOf, роль doctor)
 * или по роли: администратору и главному врачу осмотр приёмного врача и лечащий врач открыты
 * и так (rpc/inpatient-reviews.js: head_doctor/admin ИЛИ isAdmittingDoctor). Так
 * администратор-врач, названный приёмным, получает свой «Осмотр приёмного врача»
 * (BACKLOG_1011_V1), а медсестра со специальностью — ни одной кнопки, которой сервер откажет.
 */
export function admittingDoctorMayAct(adm, user) {
  if (!namedAdmitting(adm, user)) return false;
  const roles = rolesOfUser(user);
  return roles.includes('doctor') || roles.includes('admin') || roles.includes('head_doctor');
}
