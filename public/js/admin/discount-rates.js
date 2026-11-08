// DISCOUNT_RATES_V1 (3.22.0, решение владельца 2026-11-07) — СКИДКА ПО УСЛУГАМ.
//
// Владелец: «When we are adding the discount in the group, we should be able to
// select the discount for each service. For example for consultations 100 % and
// 20 % for another». У скидки группы пациентов (patient_categories.discount_percent,
// мигр. 107) и у промокода (patient_discounts) был один процент на всё. Теперь у них
// могут быть СТАВКИ (мигр. 274, колонка discount_rates, JSON):
//   { "g": { "consultation": 100 },   — группа услуги (пять фиксированных, services.type)
//     "c": { "12": 50 },              — категория услуг клиники (services.category_id)
//     "s": { "345": 0 } }             — отдельная услуга
// Действует САМАЯ ТОЧНАЯ: услуга > категория > группа > процент самой скидки. 0 % —
// на эту услугу скидки нет; 100 % — бесплатно. Скидка без ставок ('{}') — ровно
// прежняя: один процент на всё, к чему она применялась.
//
// Одно правило на сервер и экраны (как discount-rules.js): сервер считает им
// счёт (server/services/domain/discount-rates.js), окна регистрации — смету, и
// показанное не расходится с выставленным. Чистые функции: без DOM, сети и текста
// интерфейса.
import { TYPE_TO_GROUP_NAME } from './views/service-group.js';

/** Пять групп услуг в порядке окна: Консультации, Диагностика, Лаборатория, Процедуры, Хирургия. */
export const RATE_GROUPS = Object.freeze(['consultation', 'imaging', 'lab', 'procedure', 'other']);
/** Подписи групп (русские — окно переводит их через tr()). */
export const RATE_GROUP_LABELS = Object.freeze(Object.fromEntries(RATE_GROUPS.map((k) => [k, TYPE_TO_GROUP_NAME[k]])));

const LEVELS = ['g', 'c', 's'];
const r2 = (n) => Math.round(n * 100) / 100;   // как round2 в billing.js

function pctOf(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(100, Math.max(0, n));
}

/** Ставки из колонки (строка JSON или объект) — { g, c, s }; мусор отброшен, процент 0..100. */
export function parseRates(v) {
    let o = v;
    if (typeof v === 'string') { try { o = JSON.parse(v || '{}'); } catch { o = null; } }
    const out = { g: {}, c: {}, s: {} };
    if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
    for (const lvl of LEVELS) {
        const src = o[lvl];
        if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
        for (const [k, val] of Object.entries(src)) {
            const p = pctOf(val);
            if (p === null) continue;
            if (lvl === 'g') { if (RATE_GROUPS.includes(k)) out.g[k] = p; continue; }
            const id = Number(k);
            if (Number.isInteger(id) && id > 0) out[lvl][String(id)] = p;
        }
    }
    return out;
}

/** Есть ли у скидки хоть одна ставка (явный 0 % — тоже ставка). */
export function hasRates(v) {
    const r = parseRates(v);
    return LEVELS.some((l) => Object.keys(r[l]).length > 0);
}

/** Ставки для записи: только заполненные, числами; пустые уровни не пишутся. */
export function cleanRates(v) {
    const r = parseRates(v);
    const out = {};
    for (const l of LEVELS) if (Object.keys(r[l]).length) out[l] = r[l];
    return out;
}

/**
 * Группа услуги строки: 'consultation' | 'imaging' | 'lab' | 'procedure' | 'other' или
 * null (товар, строка без услуги). Правило — serviceTypeKey (service-group.js):
 * тип услуги, «Лучевая диагностика» (radiology) — Диагностика, без типа — анализ по
 * is_lab, иначе консультация. Консультация по виду приёма (без услуги) — { consultation: true }.
 */
export function rateGroupOf(svc) {
    if (!svc) return null;
    if (svc.consultation === true) return 'consultation';
    const t = String(svc.type || '').trim().toLowerCase();
    if (t === 'radiology') return 'imaging';
    if (RATE_GROUPS.includes(t)) return t;
    if (svc.is_lab === true || Number(svc.is_lab) === 1) return 'lab';
    return 'consultation';
}

/**
 * Процент скидки на строку.
 * @param {{pct:number, rates?:object|string, scope?:number[]}|null} discount
 *   pct — процент скидки (по умолчанию), rates — ставки, scope — «Только на эти
 *   услуги» промокода (пусто — на все).
 * @param {{id?:number, type?:string, is_lab?:number, category_id?:number, consultation?:boolean}|null} service
 *   услуга строки; null — товар (действует процент скидки).
 * @returns {number} 0..100
 */
export function lineDiscountPct(discount, service) {
    if (!discount) return 0;
    const def = pctOf(discount.pct) ?? 0;
    const sid = service && service.id != null && service.id !== '' ? Number(service.id) : null;
    const scope = Array.isArray(discount.scope) ? discount.scope.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (scope.length && !(sid !== null && scope.includes(sid))) return 0;
    const r = parseRates(discount.rates);
    if (sid !== null && r.s[String(sid)] !== undefined) return r.s[String(sid)];
    const cid = service && service.category_id != null && service.category_id !== '' ? Number(service.category_id) : null;
    if (cid !== null && r.c[String(cid)] !== undefined) return r.c[String(cid)];
    const g = rateGroupOf(service);
    if (g && r.g[g] !== undefined) return r.g[g];
    return def;
}

/**
 * Скидка строк по ставкам: каждая строка — свой процент, до 0,01 (как round2 сервера).
 * @param discount  как у lineDiscountPct
 * @param {Array<{service:object|null, total:number}>} lines
 * @returns {{ total:number, lines: Array<{pct:number, off:number}> }}
 */
export function ratedDiscount(discount, lines) {
    const out = (lines || []).map((l) => {
        const pct = lineDiscountPct(discount, l && l.service);
        const t = Math.max(0, Number(l && l.total) || 0);
        return { pct, off: r2(t * pct / 100) };
    });
    return { total: r2(out.reduce((s, l) => s + l.off, 0)), lines: out };
}

/**
 * Ревью S5 L-2 — действуют ли у скидки клиники ставки по услугам: только у промокода
 * С ПРОЦЕНТОМ (вид не выбран — тоже промокод). У подарочной карты и сертификата (это
 * деньги) и у промокода суммой счёт ставок не видит — настройки их поле не показывают.
 */
export function promoRatesApply(row) {
    if (!row || ['gift_card', 'certificate'].includes(row.kind)) return false;
    return (Number(row.percent) || 0) > 0;
}

/**
 * DISCOUNT_RATES_NEW_FORM_V1 (3.22.0, владелец 2026-11-08) — показывать ли ставки по услугам
 * в окне скидки. Новое окно открывается с пустым «Скидка, %», и promoRatesApply прятал ставки
 * так же, как у карты и промокода суммой: владелец видел строку-подсказку вместо пяти групп и
 * решил, что новой скидке ставки не задать. Окно прячет их только там, где они не нужны
 * никогда: подарочная карта, сертификат и промокод СУММОЙ (сумма есть, процента нет). Процент
 * ещё не набран — ставки видны; записать их без процента окно не даст (promoRatesApply — правило
 * счёта, оно не менялось).
 */
export function promoRatesEditable(row) {
    if (!row || ['gift_card', 'certificate'].includes(row.kind)) return false;
    return !((Number(row.amount) || 0) > 0 && !((Number(row.percent) || 0) > 0));
}

/** Источник ставок промокода: { pct, rates, scope } или null (сумма, карта, без ставок). */
export function promoRateSource(row) {
    if (!promoRatesApply(row)) return null;
    const pct = Number(row.percent) || 0;
    if (!hasRates(row.discount_rates)) return null;
    const scope = Array.isArray(row.service_ids) ? row.service_ids
        : (() => { try { const a = JSON.parse(row.service_ids || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } })();
    return { pct: Math.min(pct, 100), rates: row.discount_rates, scope };
}

/**
 * Что даст счёт скидкой по ставкам — зеркало сервера (server/services/domain/
 * discount-rates.js ratedChoice), чтобы смета показывала то, что выставит касса.
 * @param {{key?:string|null, group?:{pct:number, rates?:any}|null, promo?:object|null, sent?:number,
 *          lines: Array<{service:object|null, total:number}>}} a
 *   key — выбор скидки ('group' | 'manual' | 'none' | 'promo:<id>'; пусто — прежние экраны);
 *   lines — строки счёта пациента без своей скидки пакета; sent — присланная скидка.
 * @returns {null | {rated:boolean, off:number, lines:Array<{pct:number, off:number}>}}
 *   null — ставок нет: прежнее правило экрана; rated:false — своя скидка «вручную» больше
 *   скидки по ставкам: прежнее правило без пола группы; rated:true — off по строкам.
 */
export function ratedOutcome({ key = null, group = null, promo = null, sent = 0, lines = [] } = {}) {
    const k = key == null ? '' : String(key);
    let src = null;
    if (k.startsWith('promo:')) src = promoRateSource(promo);
    else if ((k === '' || k === 'group' || k === 'manual') && group && hasRates(group.rates)) src = { pct: group.pct, rates: group.rates };
    if (!src) return null;
    const r = ratedDiscount(src, lines);
    if ((k === '' || k === 'manual') && (Number(sent) || 0) > Math.ceil(r.total - 1e-9) + 0.005) return { rated: false, off: r.total, lines: r.lines };
    return { rated: true, off: r.total, lines: r.lines };
}

/**
 * Сводка у строки скидки: «По умолчанию 20 %, Консультации 100 %, 3 услуги особо».
 * Возвращает части — окно склеивает их своими переведёнными словами; null — ставок нет.
 */
export function ratesSummary(defPct, rates) {
    const r = parseRates(rates);
    if (!hasRates(r)) return null;
    return {
        def: pctOf(defPct) ?? 0,
        groups: RATE_GROUPS.filter((k) => r.g[k] !== undefined).map((k) => ({ key: k, pct: r.g[k] })),
        categories: Object.keys(r.c).length,
        services: Object.keys(r.s).length,
    };
}
