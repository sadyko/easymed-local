// ═══════════════════════════════════════════════════════════════════════════
// TITLE_SHEET_V1 (2026-09-08) — ТИТУЛЬНЫЙ ЛИСТ ИСТОРИИ БОЛЕЗНИ
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «when request of hospitalization is accepted and patient is
// admitting to the bed, nurse should collect the title list, with personal
// information and anthropometric data of the patient, and it goes as a title
// list when history is collected».
//
// Титульный лист — документ МЕДСЕСТРЫ, а не врача: его заполняют при
// размещении на койке (admission_admit — тем же вызовом, в той же
// транзакции), дописывают из истории болезни, и он идёт первой страницей
// собранной истории (admission_case_file → title_sheet).
//
// Личные данные НЕ КОПИРУЮТСЯ (миграция 110): лист показывает их из
// `patients` и пишет исправления обратно — только разрешённые поля
// (PATIENT_FIELDS в shared/title-sheet-rules.js). ФИО и дату рождения лист не
// правит: это личность, её правят в карточке пациента.
//
// Правила чисел (диапазоны, обязательный состав, ИМТ) — в
// public/js/shared/title-sheet-rules.js, общем с экраном. Здесь — только
// СЛОВА отказов: они русские по той же причине, что и остальные REASONS
// сервера.
import { RpcError, loadAdmission } from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';
import {
  MEASURES, MEASURE_KEYS, PEDICULOSIS, SANITATION, PATIENT_FIELDS,
  numOrNull, bmiOf, sheetCompleteness,
} from '../../../public/js/shared/title-sheet-rules.js';
import { MOBILITY_CODES } from '../../../public/js/shared/form-003.js';   // FORM_003_V1

export const SHEET_READ_ROLES  = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];
export const SHEET_WRITE_ROLES = ['nurse', 'senior_nurse', 'admin'];
/** Срок на лист — как у согласия и осмотра приёмного врача (CASE_DOC_SET): два часа от размещения. */
export const SHEET_DUE_HOURS = 2;
export const TITLE_KIND = 'title';

const LABEL = {
  height_cm: ['Рост', 'см'],
  weight_kg: ['Вес', 'кг'],
  temp_c:    ['Температура', '°C'],
  bp_sys:    ['АД верхнее', 'мм рт. ст.'],
  bp_dia:    ['АД нижнее', 'мм рт. ст.'],
  pulse_bpm: ['Пульс', 'уд/мин'],
};
const PATIENT_MAX = {
  gender: 10, phone: 40, address: 300, national_id: 40, occupation: 200,
  emergency_contact_name: 200, emergency_contact_phone: 40, blood_type: 20, allergies: 1000,
};
const GENDERS = ['male', 'female', 'other'];
const MS_HOUR = 3600 * 1000;
// INPATIENT_DOCS_V1 — галочки о бумагах при поступлении → время отметки (миграция 111).
const PAPERS = [['contract_signed', 'contract_signed_at'], ['consent_signed', 'consent_signed_at'], ['memo_given', 'memo_given_at']];
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

function nowUtc(db) {
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
}
function isoOf(ms) {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function str(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}
function requireRead(user) {
  if (!hasAnyRole(user, SHEET_READ_ROLES)) throw new RpcError('Титульный лист — недоступно вашей роли.', 403);
}
function requireWrite(user) {
  if (!hasAnyRole(user, SHEET_WRITE_ROLES)) {
    throw new RpcError('Титульный лист — недоступно вашей роли. Это делает: медсестра, старшая медсестра, администратор.', 403);
  }
}

/** Одно измерение: число в диапазоне, null для пустого, отказ словами для остального. */
function parseMeasure(key, raw) {
  const [label, unit] = LABEL[key];
  const def = MEASURES[key];
  const n = numOrNull(raw);
  if (n === null) return null;
  if (Number.isNaN(n)) throw new RpcError(`${label}: нужно число.`, 400);
  if (def.int && !Number.isInteger(n)) throw new RpcError(`${label}: нужно целое число.`, 400);
  if (n < def.min || n > def.max) throw new RpcError(`${label}: укажите от ${def.min} до ${def.max} ${unit}.`, 400);
  return n;
}

export function loadSheet(db, admissionId) {
  return db.prepare(`
    SELECT s.*, u.full_name AS filled_by_name
      FROM admission_title_sheets s
      LEFT JOIN users u ON u.id = s.filled_by
     WHERE s.admission_id = ?`).get(admissionId) || null;
}

/** Всё, что нужно экрану и печати: обложка госпитализации, пациент, лист, ИМТ, полнота, срок. */
export function sheetView(db, adm) {
  const admission = db.prepare(`
    SELECT a.id, a.admission_no, a.status, a.department, a.admitted_at, a.admitted_by, a.discharged_at,
           a.admission_type, a.stay_mode, a.admission_diagnosis, a.chief_complaint,
           a.discharge_destination, a.discharge_outcome, a.created_at,
           w.name AS ward_name, b.code AS bed_code, doc.full_name AS attending_name
      FROM admissions a
      LEFT JOIN wards w ON w.id = a.ward_id
      LEFT JOIN beds b ON b.id = a.bed_id
      LEFT JOIN users doc ON doc.id = a.attending_doctor_id
     WHERE a.id = ?`).get(adm.id);
  const patient = db.prepare(`
    SELECT id, full_name, mrn, date_of_birth, gender, phone, address, national_id, occupation,
           emergency_contact_name, emergency_contact_phone, blood_type, allergies
      FROM patients WHERE id = ?`).get(adm.patient_id) || null;
  const sheet = loadSheet(db, adm.id);
  const { complete, missing } = sheetCompleteness(sheet);
  // FORM_003_V1 — строка 10 бланка («Қабулхонада қўйилган ташҳис») — диагноз
  // опубликованного первичного осмотра; «кун ётиб даволанган» — дни на койке.
  const primary = db.prepare(`
    SELECT diagnosis FROM admission_reviews
     WHERE admission_id = ? AND kind = 'primary' AND published_at IS NOT NULL AND superseded_by IS NULL
     ORDER BY id DESC LIMIT 1`).get(adm.id);
  const placedForDays = !['ordered', 'cancelled'].includes(adm.status) && adm.admitted_at && Number.isFinite(Date.parse(adm.admitted_at));
  const endMs = adm.discharged_at && Number.isFinite(Date.parse(adm.discharged_at)) ? Date.parse(adm.discharged_at) : Date.now();
  const days = placedForDays ? Math.max(1, Math.floor((endMs - Date.parse(adm.admitted_at)) / 86400000) + 1) : null;
  // Точка отсчёта — размещение, и спрашивается она у состояния, не у колонки
  // (admitted_at заполнена и у заявки — см. admissionCaseDocs).
  const placed = !['ordered', 'cancelled'].includes(adm.status);
  const base = placed && adm.admitted_at ? Date.parse(adm.admitted_at) : NaN;
  return {
    admission: Object.assign({}, admission, { clinical_diagnosis: primary ? (primary.diagnosis || '') : '', days }),
    patient, sheet,
    bmi: sheet ? bmiOf(sheet.height_cm, sheet.weight_kg) : null,
    complete, missing,
    due_at: isoOf(Number.isFinite(base) ? base + SHEET_DUE_HOURS * MS_HOUR : null),
  };
}

/**
 * Сохранить лист (внутренняя половина — без проверки роли: её делает вызывающий
 * RPC, а admission_admit уже проверил право размещать). Поля, которых нет во
 * входе, не трогаются — так лист можно дописывать по одному полю.
 */
export function saveTitleSheet(db, adm, input, user) {
  if (adm.status === 'ordered') throw new RpcError('Титульный лист заполняют при размещении на койке — пациент ещё не размещён.', 400);
  if (adm.status === 'cancelled') throw new RpcError('Заявка отменена — титульный лист не нужен.', 400);

  const src = (input && input.sheet && typeof input.sheet === 'object') ? input.sheet : {};
  const existing = db.prepare('SELECT * FROM admission_title_sheets WHERE admission_id = ?').get(adm.id) || null;
  const next = Object.assign({
    referred_from: '', height_cm: null, weight_kg: null, temp_c: null, bp_sys: null, bp_dia: null, pulse_bpm: null,
    pediculosis: '', sanitation: '', note: '',
    contract_signed_at: null, consent_signed_at: null, memo_given_at: null,
    mobility: '', delivered_by: '', since_onset: '',   // FORM_003_V1
  }, existing || {});

  for (const key of MEASURE_KEYS) if (src[key] !== undefined) next[key] = parseMeasure(key, src[key]);
  if (src.pediculosis !== undefined) {
    const v = str(src.pediculosis, 10);
    if (!PEDICULOSIS.includes(v)) throw new RpcError('Осмотр на педикулёз и чесотку: выберите «не выявлено» или «выявлено».', 400);
    next.pediculosis = v;
  }
  if (src.sanitation !== undefined) {
    const v = str(src.sanitation, 10);
    if (!SANITATION.includes(v)) throw new RpcError('Санитарная обработка: выберите «полная», «частичная» или «не проводилась».', 400);
    next.sanitation = v;
  }
  if (src.referred_from !== undefined) next.referred_from = str(src.referred_from, 300);
  if (src.note !== undefined) next.note = str(src.note, 2000);
  // FORM_003_V1 — строки 6 и 8 бланка.
  if (src.mobility !== undefined) {
    const v = str(src.mobility, 12);
    if (!MOBILITY_CODES.includes(v)) throw new RpcError('Как доставляют: выберите «на коляске», «на носилках» или «ходит сам».', 400);
    next.mobility = v;
  }
  if (src.delivered_by !== undefined) next.delivered_by = str(src.delivered_by, 200);
  if (src.since_onset !== undefined) next.since_onset = str(src.since_onset, 200);
  if (next.bp_sys !== null && next.bp_dia !== null && next.bp_dia >= next.bp_sys) {
    throw new RpcError('АД: нижнее давление должно быть меньше верхнего.', 400);
  }

  const now = nowUtc(db);
  // INPATIENT_DOCS_V1 — отметка ставит время ОДИН раз, снятие стирает; поле,
  // которого нет во входе, не трогается. На полноту листа бумаги не влияют.
  for (const [flag, col] of PAPERS) {
    if (src[flag] === undefined) continue;
    next[col] = truthy(src[flag]) ? (next[col] || now) : null;
  }
  const { complete } = sheetCompleteness(next);
  // Подпись — кто ВПЕРВЫЕ заполнил лист целиком; дальше не переписывается.
  const filledBy = existing && existing.filled_at ? existing.filled_by : (complete ? ((user && user.id) || null) : null);
  const filledAt = existing && existing.filled_at ? existing.filled_at : (complete ? now : null);

  if (existing) {
    db.prepare(`
      UPDATE admission_title_sheets
         SET referred_from = ?, height_cm = ?, weight_kg = ?, temp_c = ?, bp_sys = ?, bp_dia = ?, pulse_bpm = ?,
             pediculosis = ?, sanitation = ?, note = ?,
             contract_signed_at = ?, consent_signed_at = ?, memo_given_at = ?,
             mobility = ?, delivered_by = ?, since_onset = ?,
             filled_by = ?, filled_at = ?, updated_at = ?
       WHERE id = ?`).run(
      next.referred_from, next.height_cm, next.weight_kg, next.temp_c, next.bp_sys, next.bp_dia, next.pulse_bpm,
      next.pediculosis, next.sanitation, next.note,
      next.contract_signed_at, next.consent_signed_at, next.memo_given_at,
      next.mobility, next.delivered_by, next.since_onset,
      filledBy, filledAt, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO admission_title_sheets
        (admission_id, referred_from, height_cm, weight_kg, temp_c, bp_sys, bp_dia, pulse_bpm,
         pediculosis, sanitation, note, contract_signed_at, consent_signed_at, memo_given_at,
         mobility, delivered_by, since_onset,
         filled_by, filled_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      adm.id, next.referred_from, next.height_cm, next.weight_kg, next.temp_c, next.bp_sys, next.bp_dia, next.pulse_bpm,
      next.pediculosis, next.sanitation, next.note, next.contract_signed_at, next.consent_signed_at, next.memo_given_at,
      next.mobility, next.delivered_by, next.since_onset,
      filledBy, filledAt, now, now);
  }

  // Исправления личных данных — В КАРТОЧКУ, и только разрешённые поля.
  const pin = (input && input.patient && typeof input.patient === 'object') ? input.patient : {};
  const sets = [];
  const vals = [];
  for (const f of PATIENT_FIELDS) {
    if (pin[f] === undefined) continue;
    const v = str(pin[f], PATIENT_MAX[f]);
    if (f === 'gender' && !GENDERS.includes(v)) throw new RpcError('Пол: выберите мужской, женский или другое.', 400);
    sets.push(`${f} = ?`);
    vals.push(v);
  }
  if (sets.length && adm.patient_id) {
    sets.push('updated_at = ?');
    vals.push(now, adm.patient_id);
    db.prepare(`UPDATE patients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return loadSheet(db, adm.id);
}

export function admissionTitleSheetGet(db, args, user) {
  requireRead(user);
  const adm = loadAdmission(db, args && args.admission_id);
  return sheetView(db, adm);
}

export function admissionTitleSheetSave(db, args, user) {
  requireWrite(user);
  const run = db.transaction(() => {
    const adm = loadAdmission(db, args && args.admission_id);
    saveTitleSheet(db, adm, args, user);
    return sheetView(db, adm);
  });
  return run();
}

/**
 * Строка чек-листа документов (admission_case_docs) — той же формы, что у
 * врачебных документов, чтобы список рисовал её той же строкой. Состояние:
 * полон — published (подпись = filled_at); есть неполная запись — draft;
 * ничего и срок вышел — overdue; иначе pending.
 */
export function titleSheetCaseItem(db, adm, baseMs, nowMs) {
  const row = loadSheet(db, adm.id);
  const { complete, missing } = sheetCompleteness(row);
  const dueAt = baseMs === null || baseMs === undefined ? null : baseMs + SHEET_DUE_HOURS * MS_HOUR;
  let state;
  if (row && complete) state = 'published';
  else if (dueAt !== null && nowMs > dueAt) state = 'overdue';
  else if (row) state = 'draft';
  else state = 'pending';
  return {
    kind: TITLE_KIND, group: 'nurse', order: -1, applies: true, required: true, state,
    due_rule: 'clock', due_at: isoOf(dueAt), period_hours: null, periods_missing: 0,
    entries: row && complete ? 1 : 0, block: null,
    review_id: null,
    published_at: row && complete ? row.filled_at : null,
    author_name: row && complete ? (row.filled_by_name || '') : '',
    revisions: [], revision_count: 0,
    draft_id: null, has_draft: !!row && !complete,
    missing,
    // INPATIENT_DOCS_V1 — какие бумаги подписаны: строка чек-листа называет их словами.
    papers: {
      contract_signed_at: row ? row.contract_signed_at : null,
      consent_signed_at:  row ? row.consent_signed_at : null,
      memo_given_at:      row ? row.memo_given_at : null,
    },
  };
}
