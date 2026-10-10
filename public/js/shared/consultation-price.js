// DOCTOR_PROFILE_V1 — КОНСУЛЬТАЦИЯ ВРАЧА: ВЕДЁТ ЛИ, ПО КАКОЙ ЦЕНЕ, СКОЛЬКО
// ДЛИТСЯ. Одно правило на кассу (server/services/domain/pricing.js
// consultationFor), окно записи (views/service-picker-modal.js), CRM
// (views/crm.js), «Повторный визит» кабинета (views/service-workspace.js),
// карточку сотрудника (rpc/doctor-public.js) и API (шаг 8).
//
// Решение владельца 8 (2026-10-10): у врача нет строки цены по виду — общая
// цена вида везде; окно записи такую консультацию больше не прячет.
// Решение владельца 13 (2026-10-10): строка врача с пустой ценой (не
// «Бесплатно»; «Консультации врачей» пишут такую строку, когда цену не ввели)
// — 0, как и до шага 5, везде, в том числе партнёрам. Признак empty — чтобы
// карточка сказала «цена не введена». «Бесплатно» — 0; введённый 0 — 0.
//
// «Ведёт ли»: строка врача — её «Ведёт» (available); строки нет — ведёт, если
// это врач (is_doctor), а не любой сотрудник со специальностью. Вид выключен
// (active = 0) — не ведёт никто. Касса цену считает и без «ведёт»: строка
// визита уже есть.
//
// Чистый модуль — без DOM, базы и перевода.
import { isOn } from './flags.js';

export const CONSULT_API_KINDS = Object.freeze(['initial', 'repeat']);
/** Столько окно записи ставило консультации до шага 5 (service-picker-modal.js). */
export const CONSULT_MINUTES_DEFAULT = 30;
export const CONSULT_MINUTES_MIN = 5;
export const CONSULT_MINUTES_MAX = 480;

export const CONSULT_MESSAGES = Object.freeze({
  minutes:   'Длительность приёма — целое число минут от 5 до 480.',
  kind:      'Для партнёров — «Первичный приём», «Повторный приём» или ничего.',
  kindTaken: 'Этот вид для партнёров уже выбран у другой консультации — сначала снимите его там.',
});

const money = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : null);

/**
 * Цена консультации врача: { price, own, empty }.
 *   own   — у врача есть строка этого вида (своя цена, «Бесплатно» или пустая);
 *   empty — строка есть, цену не ввели и «Бесплатно» не отметили: это 0 (решение 13).
 * Строки нет — общая цена вида (решение 8).
 */
export function consultPrice(ct, dc) {
  if (dc) {
    if (isOn(dc.is_free)) return { price: 0, own: true, empty: false };
    const own = money(dc.price);
    return { price: own ?? 0, own: true, empty: own === null };
  }
  return { price: money(ct && ct.price) ?? 0, own: false, empty: false };
}

/** Ведёт ли врач этот вид. doctor не передан — решает строка (нет строки — ведёт). */
export function consultOffered(ct, dc, doctor = null) {
  if (!ct) return false;
  if (ct.active !== undefined && ct.active !== null && !isOn(ct.active)) return false;
  if (dc) return isOn(dc.available);
  return !doctor || isOn(doctor.is_doctor);
}

/** Длительность вида, минут; не задана или вне пределов — 30. */
export function consultMinutes(ct) {
  const n = Math.round(Number(ct && ct.duration_minutes));
  return Number.isFinite(n) && n >= CONSULT_MINUTES_MIN && n <= CONSULT_MINUTES_MAX ? n : CONSULT_MINUTES_DEFAULT;
}

/** Название на трёх языках: своё у врача, иначе вида. */
export function consultNames(ct, dc) {
  const pick = (...vs) => { for (const v of vs) { const s = String(v == null ? '' : v).trim(); if (s) return s; } return ''; };
  return {
    ru: pick(dc && dc.name_ru, ct && ct.name_ru, ct && ct.name),
    uz: pick(dc && dc.name_uz, ct && ct.name_uz),
    en: pick(dc && dc.name_en, ct && ct.name_en),
  };
}

/** Строка врача по виду: из нескольких — с большим id (как consultationFor: ORDER BY id DESC); без id — последняя. */
export function consultRowOf(rows, doctorId, typeId) {
  let best = null;
  for (const r of rows || []) {
    if (!r || String(r.doctor_id) !== String(doctorId) || String(r.consultation_type_id) !== String(typeId)) continue;
    if (!best || best.id == null || r.id == null || Number(r.id) > Number(best.id)) best = r;
  }
  return best;
}

/** Консультации, которые врач ведёт, — по порядку видов: цена, своя ли, введена ли, минуты, вид для партнёров. */
export function doctorConsultations(types, rows, doctor) {
  const order = (t) => (t.sort_order == null ? Number.MAX_SAFE_INTEGER : Number(t.sort_order));
  const list = [...(types || [])].sort((a, b) => (order(a) - order(b)) || (Number(a.id) - Number(b.id)));
  const out = [];
  for (const ct of list) {
    const dc = consultRowOf(rows, doctor && doctor.id, ct.id);
    if (!consultOffered(ct, dc, doctor)) continue;
    const p = consultPrice(ct, dc);
    out.push({
      consultation_type_id: Number(ct.id),
      api_kind: CONSULT_API_KINDS.includes(ct.api_kind) ? ct.api_kind : '',
      name: consultNames(ct, dc), price: p.price, own: p.own, empty: p.empty, minutes: consultMinutes(ct),
    });
  }
  return out;
}

/** Вид консультации перед записью (/api/db): только присланное. { field, message } | null. */
export function consultTypeProblem(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  const has = (k) => Object.prototype.hasOwnProperty.call(values, k) && values[k] != null;
  if (has('duration_minutes')) {
    const n = Number(values.duration_minutes);
    if (!Number.isInteger(n) || n < CONSULT_MINUTES_MIN || n > CONSULT_MINUTES_MAX) return { field: 'duration_minutes', message: CONSULT_MESSAGES.minutes };
  }
  if (has('api_kind') && values.api_kind !== '' && !CONSULT_API_KINDS.includes(values.api_kind)) return { field: 'api_kind', message: CONSULT_MESSAGES.kind };
  return null;
}

/**
 * Окно «Настройки → Виды консультаций» (settings-hub.js beforeSave): name —
 * русское название, name_ru держится тем же (его читают касса и окно записи);
 * пустая длительность (форма шлёт 0) не уходит — остаётся прежняя; «—» в
 * «Для партнёров» не уходит вовсе — значит снять. Возвращает текст отказа или null.
 */
export function prepareConsultTypeSave(payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'name')) payload.name_ru = payload.name;
  if (payload.duration_minutes === 0) delete payload.duration_minutes;
  if (!('api_kind' in payload)) payload.api_kind = '';
  const p = consultTypeProblem(payload);
  return p ? p.message : null;
}
