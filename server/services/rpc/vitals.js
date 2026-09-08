// VITALS_NEWS_V1 — измерения показателей в стационаре и балл NEWS2.
//
// Владелец (2026-09-08): «dashboard like this» — панель показателей на обзоре
// госпитализации: температура, АД, пульс, ЧДД, SpO₂ с динамикой, балл NEWS с
// уровнем риска и рекомендацией, кнопка «Добавить измерение».
//
// Измерение вносит тот, кто измерял: медсестра поста, старшая, врач. Только
// пациенту НА КОЙКЕ: заявке измерять нечего, выписанному — поздно (запись
// задним числом в закрытую историю). Диапазоны проверяет сервер — тот же
// модуль, что и экран (shared/news2.js), так что отказ звучит одинаково.
//
// Балл NEWS не хранится: одна шкала на сервер и экран, считается при чтении.
import { RpcError, loadAdmission } from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';
import { IN_BED_STATUSES } from '../../../public/js/shared/admission-status.js';
import { news2Score, vitalError, VITAL_RANGES, CONSCIOUSNESS } from '../../../public/js/shared/news2.js';

export const VITALS_WRITE_ROLES = ['nurse', 'senior_nurse', 'doctor', 'head_doctor', 'admin'];
export const VITALS_READ_ROLES = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];

/** Сколько последних измерений едет в обзор (искорки плиток и динамика NEWS). */
export const SERIES_LIMIT = 12;

const LABEL = {
  temp_c: 'Температура', bp_sys: 'АД систолическое', bp_dia: 'АД диастолическое',
  pulse_bpm: 'Пульс', resp_rate: 'ЧДД', spo2: 'SpO₂',
};
const MEASURED_KEYS = ['temp_c', 'bp_sys', 'pulse_bpm', 'resp_rate', 'spo2'];

const nowUtc = (db) => db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;

function parseVitals(a) {
  const out = {};
  const errors = [];
  for (const key of Object.keys(VITAL_RANGES)) {
    const raw = a[key];
    if (raw === undefined || raw === null || raw === '') { out[key] = null; continue; }
    const err = vitalError(key, raw);
    if (err) { errors.push(LABEL[key] + ': ' + err); continue; }
    out[key] = Number(String(raw).replace(',', '.'));
  }
  if ((out.bp_sys === null) !== (out.bp_dia === null)) errors.push('АД: нужны обе цифры — систолическое и диастолическое');
  if (out.bp_sys !== null && out.bp_dia !== null && out.bp_dia >= out.bp_sys) errors.push('АД: диастолическое должно быть меньше систолического');
  out.on_oxygen = a.on_oxygen === true || a.on_oxygen === 1 || a.on_oxygen === '1' ? 1 : 0;
  const c = a.consciousness === undefined || a.consciousness === null || a.consciousness === '' ? 'alert' : String(a.consciousness);
  if (!CONSCIOUSNESS.includes(c)) errors.push('Сознание: неизвестное значение');
  out.consciousness = c;
  out.note = String(a.note || '').trim().slice(0, 500);
  return { out, errors };
}

function withScore(r) {
  return Object.assign({}, r, { news: news2Score(r) });
}

/**
 * Внести измерение.
 * @param {{admission_id, measured_at?, temp_c?, bp_sys?, bp_dia?, pulse_bpm?, resp_rate?, spo2?, on_oxygen?, consciousness?, note?}} args
 */
export function admissionVitalsAdd(db, args, user) {
  if (!hasAnyRole(user, VITALS_WRITE_ROLES)) throw new RpcError('Измерения вносит медсестра или врач.', 403);
  const a = args || {};
  const run = db.transaction(() => {
    const adm = loadAdmission(db, a.admission_id);
    if (!IN_BED_STATUSES.includes(adm.status)) {
      throw new RpcError(adm.status === 'ordered'
        ? 'Пациент ещё не размещён на койке — измерения начинаются с койки.'
        : 'Госпитализация закрыта — измерения в неё больше не вносят.', 400);
    }
    const { out, errors } = parseVitals(a);
    if (errors.length) throw new RpcError(errors.join('; '), 400);
    if (!MEASURED_KEYS.some((k) => out[k] !== null)) {
      throw new RpcError('Пустое измерение: внесите хотя бы один показатель.', 400);
    }
    let at = typeof a.measured_at === 'string' && a.measured_at ? a.measured_at : nowUtc(db);
    const t = new Date(at);
    if (Number.isNaN(t.getTime())) throw new RpcError('measured_at must be an ISO date.', 400);
    at = t.toISOString().replace(/\.\d{3}Z$/, 'Z');

    const id = db.prepare(`
      INSERT INTO admission_vitals
        (admission_id, measured_at, temp_c, bp_sys, bp_dia, pulse_bpm, resp_rate, spo2, on_oxygen, consciousness, note, measured_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(adm.id, at, out.temp_c, out.bp_sys, out.bp_dia, out.pulse_bpm, out.resp_rate, out.spo2,
        out.on_oxygen, out.consciousness, out.note, (user && user.id) || null).lastInsertRowid;
    const row = db.prepare(`
      SELECT v.*, u.full_name AS measured_by_name FROM admission_vitals v
      LEFT JOIN users u ON u.id = v.measured_by WHERE v.id = ?`).get(id);
    return { vital: withScore(row), summary: vitalsSummary(db, adm) };
  });
  return run();
}

/** Все измерения госпитализации, новые первыми. */
export function admissionVitalsList(db, args, user) {
  if (!hasAnyRole(user, VITALS_READ_ROLES)) throw new RpcError('Показатели — недоступно вашей роли.', 403);
  const adm = loadAdmission(db, args && args.admission_id);
  const rows = db.prepare(`
    SELECT v.*, u.full_name AS measured_by_name FROM admission_vitals v
    LEFT JOIN users u ON u.id = v.measured_by
    WHERE v.admission_id = ? ORDER BY v.measured_at DESC, v.id DESC LIMIT 200`).all(adm.id);
  return { rows: rows.map(withScore) };
}

/**
 * Сводка для обзора: последнее и предыдущее измерение, ряд последних
 * SERIES_LIMIT по возрастанию времени (искорки), текущий NEWS и тренд.
 *
 * Пока измерений нет, а титульный лист уже принёс температуру/АД/пульс — они
 * идут ПЕРВОЙ точкой «при поступлении» (source 'title'): динамика начинается
 * с койки, а не с первого обхода.
 */
export function vitalsSummary(db, adm) {
  const rows = db.prepare(`
    SELECT v.*, u.full_name AS measured_by_name FROM admission_vitals v
    LEFT JOIN users u ON u.id = v.measured_by
    WHERE v.admission_id = ? ORDER BY v.measured_at DESC, v.id DESC LIMIT ?`).all(adm.id, SERIES_LIMIT);
  const count = db.prepare('SELECT COUNT(*) n FROM admission_vitals WHERE admission_id = ?').get(adm.id).n;
  const series = rows.slice().reverse().map((r) => withScore(Object.assign({ source: 'vital' }, r)));

  const sheet = db.prepare('SELECT temp_c, bp_sys, bp_dia, pulse_bpm, filled_at FROM admission_title_sheets WHERE admission_id = ?').get(adm.id);
  if (sheet && (sheet.temp_c !== null || sheet.bp_sys !== null || sheet.pulse_bpm !== null)) {
    const at = adm.admitted_at || sheet.filled_at || null;
    const baseline = withScore({
      id: null, source: 'title', admission_id: adm.id, measured_at: at,
      temp_c: sheet.temp_c, bp_sys: sheet.bp_sys, bp_dia: sheet.bp_dia, pulse_bpm: sheet.pulse_bpm,
      resp_rate: null, spo2: null, on_oxygen: 0, consciousness: null, note: '', measured_by: null, measured_by_name: '',
    });
    if (!series.length || (at && at <= series[0].measured_at)) series.unshift(baseline);
  }

  const last = series.length ? series[series.length - 1] : null;
  const prev = series.length > 1 ? series[series.length - 2] : null;
  const first = series.length ? series[0] : null;
  const trend = last && first && last !== first ? last.news.total - first.news.total : 0;
  return {
    count,
    last, prev, series,
    news: last ? last.news : news2Score({}),
    trend,
    can_add: IN_BED_STATUSES.includes(adm.status),
  };
}
