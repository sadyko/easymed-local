// LAB_TUBE_LABEL_V1 (решение владельца 2026-11-02) — ЭТИКЕТКА НА ПРОБИРКУ.
//
// Было: «Штрих-код» карточки очереди печатал ОДНУ этикетку на визит — с номером
// rows[0], а строки очереди идут по id desc, то есть с номером САМОЙ НОВОЙ
// строки, и номер менялся, как только выставляли ещё один анализ. На снимке
// владельца № 00000032 — «Анализ мочи» второго счёта; кровь с этим номером BC-780
// не разложил («неоднозначно»: две открытые «Анализ крови»).
//
// Стало: строки визита делятся на пробирки, этикетка — на каждую.
//   • Ключ пробирки — день строки, прибор и материал:
//       день     — как у приёма (ingest.js orderAge): позднейшее из «создана»,
//                  «записана», «день визита», не позже сегодня, местный;
//       прибор   — тот, что кормит услугу: панель услуги (lab_panels.device_id),
//                  как у приёма (ingest.js orderSide); только у услуги с флагом
//                  «лабораторная» — заказ без него приём не заполняет;
//       материал — specimenKey (shared/specimen-key.js) — тот же ключ, которым
//                  приём делит пробирку между заказами визита (D3).
//     Без прибора — по материалу; без материала — своя этикетка у строки.
//   • Номер этикетки — САМАЯ СТАРАЯ строка пробирки: строки, добавленные позже,
//     номер не меняют. Прибор этот заказ кормит сам, поэтому приём кладёт пробу
//     в него, а остальные строки пробирки заполняет D3 — та же группа.
//   • В пробирку идут только открытые оплаченные строки (queued … resulted):
//     голый номер выданного заказа приём отказывает (bareIdRefusal), неоплаченного —
//     ворота (gateRefusal). Возвращённые без результата (skipIds) — тоже нет.
// Модуль чистый: без DOM и сети — его тестирует node --test, его же берёт тест
// приёма (server/lis/tube-label.test.js).
import { specimenKey } from '../../shared/specimen-key.js';
import { labBarcodeValue } from './lab-doc.js?v=labshared1';   // тот же адрес, что у laboratory.js — один экземпляр модуля
import { dateNumeric } from '../../shared/date-words.js';

export const TUBE_STATUSES = Object.freeze(['queued', 'collected', 'in_progress', 'resulted']);

const isOn = (v) => v === true || Number(v) === 1;
const pad2 = (n) => String(n).padStart(2, '0');

/** Местный календарный день 'YYYY-MM-DD' (Date | ISO | 'YYYY-MM-DD'); '' — не разобрать. */
export function localDay(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * День строки для пробирки — как у приёма (ingest.js orderAge): позднейшее из
 * «создана», «записана», «день визита», не позже сегодня. '' — не известен.
 */
export function tubeDay(r, { visitDate = null, today = localDay(new Date()) } = {}) {
    const days = [r && r.created_at, r && r.scheduled_at, visitDate].map(localDay).filter((d) => d && d <= today);
    return days.length ? days.sort().pop() : '';
}

// Короткое название анализа для этикетки (в справочнике короткого имени нет):
// сокращение в самом имени («Антимюллеров гормон АМГ (ИФА)» → «АМГ»), иначе
// первое в скобках («Общий анализ крови (ОАК, …)» → «ОАК»), иначе имя,
// обрезанное до 18 знаков. Сокращение — до 10 знаков, не меньше двух заглавных
// (или из 2–3 знаков с заглавной: «Hb»; одна буква — «Витамин D» — не сокращение).
const SHORT_MAX = 18;
const ABBR = /^[\p{Lu}\d][\p{L}\d%#.+\-]{0,9}$/u;
const capsOf = (w) => (w.match(/\p{Lu}/gu) || []).length;
const isAbbr = (w) => ABBR.test(w) && (capsOf(w) >= 2 || (w.length >= 2 && w.length <= 3 && capsOf(w) >= 1));
export function shortTestName(name) {
    const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    if (s.length <= SHORT_MAX) return s;
    const outside = s.replace(/\([^()]*\)/g, ' ').split(' ').find(isAbbr);
    if (outside) return outside;
    for (const m of s.matchAll(/\(([^()]*)\)/g)) {
        const head = m[1].split(/[,;]/)[0].trim();
        if (isAbbr(head)) return head;
    }
    return s.slice(0, SHORT_MAX - 1).trimEnd() + '…';
}

/**
 * service_id → прибор панели услуги (lab_panels.device_id; null — панель без
 * прибора). Как у приёма (orderSide): активная панель, первая по номеру.
 */
export function tubeDeviceMap(panels) {
    const out = {};
    const list = (panels || []).filter((p) => p && p.service_id != null && (p.active === undefined || isOn(p.active)))
        .slice().sort((a, b) => Number(a.id) - Number(b.id));
    for (const p of list) {
        if (Object.prototype.hasOwnProperty.call(out, p.service_id)) continue;
        out[p.service_id] = p.device_id == null || p.device_id === '' ? null : p.device_id;
    }
    return out;
}

/**
 * Пробирки визита.
 * @param {object[]} rows  лабораторные строки ОДНОГО визита (visit_services + services{name, specimen, is_lab})
 * @param {{deviceByService?: object|Map, skipIds?: Set<number>, visitDate?: string|null, today?: string}} [opts]
 * @returns {Array<{key:string, labelId:number, code:string, rowIds:number[], tests:string[],
 *                  collectedAt:string|null, deviceId:any, material:string, day:string}>}
 *          по возрастанию номера этикетки
 */
export function tubeGroups(rows, opts = {}) {
    const devices = opts.deviceByService || {};
    const skip = opts.skipIds instanceof Set ? opts.skipIds : new Set();
    const visitDate = opts.visitDate || null;
    const today = opts.today || localDay(new Date());
    const deviceOf = (sid) => {
        const v = devices instanceof Map ? devices.get(sid) : devices[sid];
        return v == null || v === '' ? null : v;
    };
    const open = (rows || [])
        .filter((r) => r && r.id != null && TUBE_STATUSES.includes(r.status) && !skip.has(Number(r.id)))
        .slice().sort((a, b) => Number(a.id) - Number(b.id));
    const byKey = new Map();
    for (const r of open) {
        const svc = r.services || {};
        const material = specimenKey(svc.specimen);
        const deviceId = isOn(svc.is_lab) ? deviceOf(r.service_id) : null;
        const day = tubeDay(r, { visitDate, today });
        const key = deviceId != null ? day + '|d' + deviceId + '|m' + material
            : material ? day + '|m' + material
            : day + '|r' + r.id;
        let g = byKey.get(key);
        if (!g) {
            // Строки идут по возрастанию номера: группу заводит её САМАЯ СТАРАЯ строка.
            g = { key, labelId: Number(r.id), code: labBarcodeValue(r.id), rowIds: [], tests: [], collectedAt: null, deviceId, material, day };
            byKey.set(key, g);
        }
        g.rowIds.push(Number(r.id));
        const t = shortTestName(svc.name);
        if (t && !g.tests.includes(t)) g.tests.push(t);
        const c = r.sample_collected_at ? String(r.sample_collected_at) : '';
        if (c && (!g.collectedAt || c < g.collectedAt)) g.collectedAt = c;
    }
    return [...byKey.values()];
}

/**
 * Время на этикетке — местное (часы компьютера клиники), числом, как в печатных
 * бланках: «02.11.2026, 19:06». Нет отметки забора — сейчас.
 */
export function tubeLabelStamp(value, now = new Date()) {
    return dateNumeric(value || now, { withTime: true });
}
