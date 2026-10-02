// JOURNALS_V1 (2026-10-02) — ПРАВИЛА ЖУРНАЛОВ БЕЗ БАЗЫ.
//
// «Журнал услуг» и «Реестр стационарных пациентов» (rpc/reports.js) читают
// базу несколькими выборками, а решают по ним здесь: какой выбор услуг принят,
// какие две строки — одна работа, какой номер у пациента, кто направил, какой
// диагноз и какое заключение. Модуль чистый — его проверяет таблица примеров
// (journal-rules.test.js), без базы и без экрана.
import { admissionDiagnosisText } from './admission-facts.js';

/** Год рождения — первые четыре знака даты, если это год. */
export function birthYear(dob) {
  const y = String(dob == null ? '' : dob).slice(0, 4);
  return /^\d{4}$/.test(y) ? y : '';
}

/** Не больше стольких услуг в одном журнале (тот же предел у окна выбора). */
export const JOURNAL_SERVICE_MAX = 2000;
export const KINDS_OF_CARE = Object.freeze(['all', 'inpatient', 'outpatient']);
export const SELF_REFERRED = 'сам';
export const INPATIENT_REFERRER = 'Стационар';
export const GENDER_RU = Object.freeze({ male: 'Муж.', female: 'Жен.' });
/** Сколько дней назад ищется подписанная консультация направившего врача. */
export const CONSULT_DX_DAYS = 30;
/** JOURNALS_V1_RJ1 — сколько дней до визита рекомендация из кабинета ещё называет направившего. */
export const REC_WINDOW_DAYS = 90;

/**
 * Выбор услуг журнала → { error: null | 'empty' | 'too_many', ids }.
 * Предел проверяется на присланном массиве — до разбора; мусор (не целые > 0)
 * отбрасывается; повторы — один раз. Числа строкой принимаются (<select>).
 */
export function parseServiceIds(raw) {
  if (Array.isArray(raw) && raw.length > JOURNAL_SERVICE_MAX) return { error: 'too_many', ids: [] };
  const ids = [];
  const seen = new Set();
  for (const v of Array.isArray(raw) ? raw : []) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
    if (Number.isSafeInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); ids.push(n); }
  }
  return { error: ids.length ? null : 'empty', ids };
}

/** Тип: пусто — «все»; иначе одно из трёх значений, прочее — null (отказ). */
export function parseKindOfCare(raw) {
  if (raw === undefined || raw === null || raw === '') return 'all';
  return KINDS_OF_CARE.includes(raw) ? raw : null;
}

export const genderWord = (g) => (Object.prototype.hasOwnProperty.call(GENDER_RU, g) ? GENDER_RU[g] : '');

/** 'ГГГГ-ММ-ДД' минус N дней (календарь, без часовых поясов); мусор — ''. */
export function dayMinus(ymd, days) {
  const t = Date.parse(String(ymd || '').slice(0, 10) + 'T00:00:00Z');
  return Number.isFinite(t) ? new Date(t - days * 86400000).toISOString().slice(0, 10) : '';
}

const lineKey = (l) => l.patient_id + '|' + l.service_id + '|' + l.day;

/**
 * Без двойного счёта: строка визита (src 'vs') и строка случая (src 'as') с
 * тем же пациентом, услугой и местным днём — одна работа. Остаётся строка
 * визита (у неё есть заключение), строки случая с этим ключом убираются.
 * Строка визита без своей госпитализации получает случай убранной строки:
 * строка случая — всегда стационар.
 */
export function dedupeJournalLines(lines) {
  const visitKeys = new Set(lines.filter((l) => l.src === 'vs').map(lineKey));
  const caseOf = new Map();
  for (const l of lines) {
    if (l.src === 'as' && visitKeys.has(lineKey(l)) && !caseOf.has(lineKey(l))) caseOf.set(lineKey(l), l.admission_id);
  }
  const out = [];
  for (const l of lines) {
    if (l.src === 'as' && visitKeys.has(lineKey(l))) continue;
    out.push(l.src === 'vs' && l.admission_id == null && caseOf.has(lineKey(l)) ? { ...l, admission_id: caseOf.get(lineKey(l)) } : l);
  }
  return out;
}

/** Порядок журнала: дата, затем ФИО, затем услуга; дальше — строка визита раньше и по номеру. */
export function sortJournalLines(lines, compare) {
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...lines].sort((a, b) => byText(String(a.day || ''), String(b.day || ''))
    || compare(a.patient, b.patient) || compare(a.service, b.service)
    || (a.src === b.src ? 0 : a.src === 'vs' ? -1 : 1)
    || (Number(a.line_id) || 0) - (Number(b.line_id) || 0));
}

/** «Ич. рақам»: номер пациента по первому появлению в журнале — у одного пациента один номер. */
export function patientOrdinals(lines) {
  const seen = new Map();
  return lines.map((l) => {
    if (!seen.has(l.patient_id)) seen.set(l.patient_id, seen.size + 1);
    return seen.get(l.patient_id);
  });
}

/** Рекомендации по ключу «пациент|услуга» в порядке запроса (новые сначала). */
export function indexRecommendations(recs) {
  const map = new Map();
  for (const r of recs || []) {
    const k = r.patient_id + '|' + r.service_id;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/**
 * «Кто направил» → { text, doctorId }. Стационар — лечащий врач случая, иначе
 * «Стационар». Амбулатория — ближайшая рекомендация этой услуги этому пациенту
 * не позже дня визита (с именем), иначе источник направления визита, иначе
 * «сам». doctorId — врач направившего (для диагноза консультации) или null.
 */
export function referrerOf(line, recIndex, adm) {
  if (line.admission_id != null) {
    const name = String((adm && adm.attending) || '').trim();
    return { text: name || INPATIENT_REFERRER, doctorId: name ? (adm.attending_doctor_id ?? null) : null };
  }
  const recs = (recIndex && recIndex.get(line.patient_id + '|' + line.service_id)) || [];
  // JOURNALS_V1_RJ1 (ревью, п. 5) — за REC_WINDOW_DAYS до дня визита и не
  // закрытая раньше него (closed_day — день closed_at: «добавлена в визит» или
  // «удалена»); закрытая в день визита — закрыта им.
  const day = String(line.day || '');
  const lo = dayMinus(day, REC_WINDOW_DAYS);
  const rec = recs.find((r) => String(r.day || '') <= day && String(r.day || '') >= lo
    && (!r.closed_day || String(r.closed_day) >= day) && String(r.name || '').trim());
  if (rec) return { text: String(rec.name).trim(), doctorId: rec.doctor_id ?? null };
  const source = String(line.visit_source || '').trim();
  if (source) return { text: source, doctorId: line.visit_source_doctor_id ?? null };
  return { text: SELF_REFERRED, doctorId: null };
}

/**
 * Диагноз подписанной консультации: основной из body.diagnoses («код —
 * название», как _mainDxText кабинета врача), иначе body.dx (= primary_diagnosis
 * или тот же основной — buildBlankData). diagnoses приходит JSON-текстом
 * (json_extract) или массивом.
 */
export function diagnosisOfBody(doc) {
  let list = doc && doc.diagnoses;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
  const main = Array.isArray(list)
    ? list.find((d) => d && d.type === 'main' && (String(d.code || '').trim() || String(d.name || '').trim()))
    : null;
  if (main) {
    const code = String(main.code || '').trim();
    const name = String(main.name || '').trim();
    return code && name ? code + ' — ' + name : (code || name);
  }
  return String((doc && doc.dx) || '').trim();
}

// JOURNALS_V1_RJ1 (ревью, п. 4) — консультации раскладываются ОДИН раз по
// «пациент|врач» (как indexRecommendations): иначе поиск на каждую строку шёл
// по всем документам периода — квадратично (20 000 × 20 000).
const consultKey = (patientId, doctorId) => Number(patientId) + '|' + Number(doctorId);
/** Подписанные консультации (новые сначала) → Map «пациент|врач» → список в том же порядке. */
export function indexConsultDocs(docs) {
  const map = new Map();
  for (const d of docs || []) {
    if (!d || d.doctor_id == null) continue;
    const k = consultKey(d.patient_id, d.doctor_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(d);
  }
  return map;
}

/**
 * docs — индекс indexConsultDocs (журнал) или список консультаций, новые
 * сначала: { patient_id, doctor_id, day, text }. Список — для малых выборок.
 */
export function consultDiagnosis(docs, patientId, doctorId, day) {
  if (doctorId == null) return '';
  const lo = dayMinus(day, CONSULT_DX_DAYS);
  const list = docs instanceof Map   // JOURNALS_V1_RJ1
    ? (docs.get(consultKey(patientId, doctorId)) || [])
    : (docs || []).filter((x) => x.patient_id === patientId && Number(x.doctor_id) === Number(doctorId));
  const d = list.find((x) => String(x.day) <= String(day) && String(x.day) >= lo && x.text);
  return d ? d.text : '';
}

/** «Диагноз при направлении» строки журнала. */
export function referralDiagnosis(line, adm, ref, docs) {
  if (line.admission_id != null) return admissionDiagnosisText(adm && adm.admission_diagnosis, adm && adm.review_diagnosis);
  return consultDiagnosis(docs, line.patient_id, ref && ref.doctorId, line.day);
}

// JOURNALS_V1_CONCLUSION (владелец, 02.10): «the fields of the "conclusion" in
// the journal → the "diagnosis" or "conclusion" in the doctors cabinet». Что
// пишет кабинет при подписи (service-workspace.js handleSignFinalize →
// buildBlankData, _BLANK_FIELD_MAP):
//   протокол приёма ('protocol') — снимок buildBlankData: раздел «Заключение»
//     (conclusion_text) → conclusionText; раздел «Диагноз» (primary_diagnosis,
//     иначе основной диагноз «код — название», _mainDxText) → dx; все диагнозы
//     с типами → diagnoses;
//   заключение исследования ('diag') — { description, conclusion }: поле
//     «Заключение» бланка исследования (primary_diagnosis) → conclusion,
//     «Описание» (instrumental_text) → description.
// Берётся «Заключение» (conclusionText, у исследования conclusion), пустое —
// «Диагноз» (основной «код — название», иначе dx). Описание исследования —
// находки, а не заключение: его не берём.
const CONCLUSION_FIELDS = ['conclusionText', 'conclusion'];
export function conclusionOfDoc(doc) {
  for (const k of CONCLUSION_FIELDS) {
    const v = doc ? doc[k] : null;
    const s = String(v == null ? '' : v).trim();
    if (s) return s;
  }
  return doc ? diagnosisOfBody(doc) : '';
}

// JOURNALS_V1_CONCLUSION — без подписанного документа («Status only»):
// анализ — «Результаты выданы дд.мм.гггг» по дню «Проверить и выдать»
// (visit_services.verified_at), прочая услуга — «Выполнено», если отмечена
// выполненной. Шаблон и значения едут в cells_t: колонка «Заключение» — не
// перечисление, словарём целиком её экран не переводит.
export const RESULTS_RELEASED_T = 'Результаты выданы {date}';
export const DONE_WORD = 'Выполнено';
const BLANK_CELL = Object.freeze({ text: '', template: null, params: null });

/** 'ГГГГ-ММ-ДД' → 'дд.мм.гггг'; мусор — ''. */
export function ruDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
}

/**
 * «Заключение» строки журнала → { text, template, params }. docText — текст
 * подписанного документа строки (conclusionOfDoc) или ''. line.done — строка
 * отмечена выполненной (визит — status 'completed', акт — performed_at);
 * line.released_day — местный день выдачи результатов анализа или null.
 * Документ без текста — как нет документа: показывается статус строки.
 */
export function journalConclusion(line, docText, isLab) {
  const text = String(docText == null ? '' : docText).trim();
  if (text) return { text, template: null, params: null };
  if (isLab) {
    const date = ruDay(line && line.released_day);
    return date ? { text: 'Результаты выданы ' + date, template: RESULTS_RELEASED_T, params: { date } } : { ...BLANK_CELL };
  }
  return line && line.done ? { text: DONE_WORD, template: DONE_WORD, params: {} } : { ...BLANK_CELL };
}
