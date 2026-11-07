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
//   • Ревью U11, M1 — «уже взята» тоже часть ключа: строка, которая ещё ждёт
//     забора (queued), не делит пробирку со строками, чья проба уже взята
//     (collected, in_progress, resulted). Иначе отдельный забор того же дня
//     (утром «Биохимия» взята и посчитана, вечером врач назначил «Электролиты» на
//     тот же BS-200) получал номер утренней строки, и вечерний калий перезаписывал
//     утренний черновик. Анализ, добавленный ДО забора, — в той же пробирке, номер
//     прежний. Добавленный ПОСЛЕ — своя этикетка; а прогнать снова ту же пробирку
//     с прежней этикеткой можно: приём заполнит новую строку как соседа (D3).
//   • Ревью U11, L6 — recent: примет ли приём голый номер этикетки (срок
//     BARE_ID_MAX_AGE_DAYS — общий с приёмом). Старую пробирку карточка не печатает.
// Модуль чистый: без DOM и сети — его тестирует node --test, его же берёт тест
// приёма (server/lis/tube-label.test.js).
import { specimenKey } from '../../shared/specimen-key.js';
import { labBarcodeValue } from './lab-doc.js?v=labshared1';   // тот же адрес, что у laboratory.js — один экземпляр модуля
import { dateNumeric } from '../../shared/date-words.js';
import { BARE_ID_MAX_AGE_DAYS } from '../../shared/lab-label-age.js';   // LAB_TUBE_LABEL_V1 (ревью U11, L6) — срок голого номера, общий с приёмом
import { dayLabelValue } from '../../shared/lab-day-label.js';   // LAB_ONE_BARCODE_V1 — номер этикетки дня визита

export { BARE_ID_MAX_AGE_DAYS };
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

/** 'YYYY-MM-DD' на n дней раньше по местному календарю; '' — не разобрать. */
function daysBefore(ymd, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? localDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - n)) : '';
}

/**
 * LAB_TUBE_LABEL_V1 (ревью U11, L6) — примет ли приём голый номер этикетки
 * пробирки этого дня: как orderAge (ingest.js) — день известен и не раньше, чем
 * BARE_ID_MAX_AGE_DAYS дней назад (сам день-граница — ещё да). Старше — приём
 * отказывает («старше 7 дней»), и карточка такую этикетку не печатает.
 */
export function tubeRecent(day, today = localDay(new Date())) {
    const cutoff = daysBefore(today, BARE_ID_MAX_AGE_DAYS);
    return !!day && !!cutoff && day >= cutoff;
}

// Короткое название анализа для этикетки (в справочнике короткого имени нет):
// сокращение в самом имени («Антимюллеров гормон АМГ (ИФА)» → «АМГ»), иначе
// первое в скобках («Общий анализ крови (ОАК, …)» → «ОАК»), иначе имя до скобок,
// если помещается, иначе имя, обрезанное до 18 знаков. Сокращение — до 10 знаков,
// не меньше двух заглавных (или из 2–3 знаков с заглавной: «Hb»; одна буква —
// «Витамин D» — не сокращение).
//
// Ревью U11, L3 — сокращение должно называть САМ анализ:
//   • метод — не анализ: «… методом ИХЛА», «… (ИФА)», «(ПЦР)» пропускаются;
//   • обычное короткое слово с заглавной («На скрытую кровь…», «По …») — не сокращение;
//   • первое слово, за которым идёт уточнение («Т4 свободный …», «ПСА общий …»), —
//     не весь анализ: берётся имя до скобок;
//   • в скобках у панели («Коагулограмма (ПТИ, МНО, …)», «Липидограмма (…)») — её
//     состав, а не сокращение; и сокращение из скобок начинается с той же буквы,
//     что имя («Общий анализ крови (ОАК…)»), латинское — как есть («Hb», «ABO»).
const SHORT_MAX = 18;
const ABBR = /^[\p{Lu}\d][\p{L}\d%#.+\-]{0,9}$/u;
const capsOf = (w) => (w.match(/\p{Lu}/gu) || []).length;
const isAbbr = (w) => ABBR.test(w) && (capsOf(w) >= 2 || (w.length >= 2 && w.length <= 3 && capsOf(w) >= 1));
// i18n-exempt: не текст экрана — сокращения методов в НАЗВАНИЯХ услуг справочника, с ними сравнивается имя
const METHODS = new Set(['ИФА', 'ИХЛА', 'ХЛА', 'ЭХЛА', 'ИХЛ', 'ИХА', 'РИА', 'РИФ', 'ПЦР', 'ПЦР-РВ', 'ELISA', 'CLIA', 'ECLIA', 'CMIA', 'PCR', 'RT-PCR']);
const isMethod = (w) => METHODS.has(String(w).toUpperCase());
const isWord = (w) => /^\p{Lu}[а-яё]{1,2}$/u.test(w);
const isLatin = (w) => /^[A-Za-z\d%#.+\-]+$/.test(w);
const PANEL = /грамм|профил|панел|комплекс|скрининг/i;
const testAbbr = (w) => isAbbr(w) && !isMethod(w) && !isWord(w);
export function shortTestName(name) {
    const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    if (s.length <= SHORT_MAX) return s;
    const head = s.split('(')[0].trim();
    const words = s.replace(/\([^()]*\)/g, ' ').split(' ').filter(Boolean);
    const outside = words.find((w, i) => testAbbr(w) && !(i === 0 && words.length > 1));
    if (outside) return outside;
    if (!PANEL.test(head)) {
        for (const m of s.matchAll(/\(([^()]*)\)/g)) {
            const abbr = m[1].split(/[,;]/)[0].trim();
            if (testAbbr(abbr) && (isLatin(abbr) || abbr[0].toLowerCase() === s[0].toLowerCase())) return abbr;
        }
    }
    const base = head || s;
    return base.length <= SHORT_MAX ? base : base.slice(0, SHORT_MAX - 1).trimEnd() + '…';
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
 *                  collectedAt:string|null, deviceId:any, material:string, day:string,
 *                  drawn:boolean, recent:boolean}>}
 *          по возрастанию номера этикетки; drawn — проба пробирки уже взята (ревью U11, M1),
 *          recent — приём примет голый номер её этикетки (ревью U11, L6)
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
        // Ревью U11, M1 — ждёт забора или уже взята: разные пробирки (см. шапку модуля).
        const drawn = r.status !== 'queued';
        const stage = drawn ? '|drawn' : '|wait';
        const key = deviceId != null ? day + stage + '|d' + deviceId + '|m' + material
            : material ? day + stage + '|m' + material
            : day + '|r' + r.id;
        let g = byKey.get(key);
        if (!g) {
            // Строки идут по возрастанию номера: группу заводит её САМАЯ СТАРАЯ строка.
            g = { key, labelId: Number(r.id), code: labBarcodeValue(r.id), rowIds: [], tests: [], collectedAt: null, deviceId, material, day,
                drawn, recent: tubeRecent(day, today) };   // ревью U11, M1 и L6
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
 * LAB_ONE_BARCODE_V1 (решение владельца 2026-11-07, п. 10) — ЭТИКЕТКА ДНЯ ВИЗИТА.
 * Один номер на все анализы дня визита (shared/lab-day-label.js: 90000000 + самая
 * старая открытая оплаченная строка дня) — одна и та же этикетка на каждую
 * пробирку: копий столько, сколько пробирок (tubeGroups этого дня). Приём по этому
 * номеру заполняет каждую строку дня, которую кормит прибор (ingest.js dayAnchor),
 * — порядок анализов и материал услуги больше не решают. Дней обычно один; у
 * стационарного визита — свой номер на каждый день.
 *
 * Ревью S3, M-2 — ПОВТОРНЫЙ ЗАБОР. Тот же анализ того же прибора дважды за день в
 * РАЗНЫХ пробирках (утренняя проба взята, вечерняя ждёт): по номеру дня приём не
 * знает, в который из двух открытых заказов писать, и общие анализы отказывает
 * («неоднозначно»). Пробирке повторного забора — своя этикетка строки (номер
 * заказа, lab-doc.js labBarcodeValue): приём ведёт её прежним путём точно — в этот
 * заказ, а прочие строки пробирки заполняет D3. Два одинаковых анализа в ОДНОЙ
 * пробирке (оба ждут забора) — это одна пробирка, отдельной этикетки нет (приём
 * скажет «неоднозначно», лишний заказ снимает человек). Строки без прибора приём
 * не заполняет — им номер дня, как был.
 *
 * Ревью S3, M-3 — МОЧА И ДРУГОЙ МАТЕРИАЛ НА ОДНОМ ПРИБОРЕ. LIS Proxy материал пробы
 * (OBR-15) не передаёт, и по номеру дня приём не отличит пробирку мочи от сыворотки
 * на одном BS-200: обе — «неоднозначно», и рабочий список тоже. В такой день ВСЕ
 * пробирки этого прибора (и мочи, и прочего материала, и без материала) — со своими
 * этикетками 3.21 (номер пробирки по материалу, t.code): их приём ведёт точно, по
 * материалу заказа номера. Остальным приборам — номер дня.
 * @returns {Array<{day:string, lineId:number, code:string, copies:number, tests:string[],
 *                  rowIds:number[], collectedAt:string|null, recent:boolean, tubes:object[],
 *                  own:Array<{code:string, why:'repeat'|'material', tests:string[], rowIds:number[], collectedAt:string|null}>}>}
 *          по возрастанию дня; code '' — номер строки не помещается в номер дня
 *          (тогда печатаются прежние этикетки пробирок этого дня: tubes);
 *          own — пробирки со своей этикеткой строки (ревью S3, M-2), copies — без них
 */
export function dayLabels(rows, opts = {}) {
    const rowById = new Map((rows || []).filter((r) => r && r.id != null).map((r) => [Number(r.id), r]));
    const byDay = new Map();
    for (const t of tubeGroups(rows, opts)) {
        let d = byDay.get(t.day);
        if (!d) {
            d = { day: t.day, lineId: t.labelId, code: '', copies: 0, tests: [], rowIds: [], collectedAt: null, recent: t.recent, tubes: [] };
            byDay.set(t.day, d);
        }
        d.lineId = Math.min(d.lineId, t.labelId);
        d.copies += 1;
        d.tubes.push(t);
        for (const x of t.tests) if (!d.tests.includes(x)) d.tests.push(x);
        d.rowIds.push(...t.rowIds);
        if (t.collectedAt && (!d.collectedAt || t.collectedAt < d.collectedAt)) d.collectedAt = t.collectedAt;
    }
    const out = [...byDay.values()];
    for (const d of out) {
        d.rowIds.sort((a, b) => a - b);
        d.code = dayLabelValue(d.lineId);
        d.own = [];
        const repeats = repeatTubes(d, rowById);   // ревью S3, M-2
        const split = urineSplitDevices(d);        // ревью S3, M-3
        for (const t of d.tubes) {
            const ids = repeats.get(t);
            if (ids) {
                d.copies -= 1;
                d.own.push({ code: labBarcodeValue(Math.min(...ids)), why: 'repeat', tests: t.tests.slice(), rowIds: t.rowIds.slice(), collectedAt: t.collectedAt });
            } else if (t.deviceId != null && split.has(String(t.deviceId))) {
                d.copies -= 1;
                d.own.push({ code: t.code, why: 'material', tests: t.tests.slice(), rowIds: t.rowIds.slice(), collectedAt: t.collectedAt });
            }
        }
    }
    return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.lineId - b.lineId));
}

/**
 * Ревью S3, M-2 — пробирки повторного забора дня: пробирка → номера её строк, у
 * которых тот же анализ (услуга) того же прибора уже есть в ДРУГОЙ пробирке этого
 * дня с меньшим номером строки. Строки без прибора — не в счёт.
 * @returns {Map<object, number[]>}
 */
function repeatTubes(d, rowById) {
    const tubeOf = new Map();
    for (const t of d.tubes) for (const id of t.rowIds) tubeOf.set(id, t);
    const first = new Map();   // услуга → пробирка её первой строки дня
    const out = new Map();
    for (const id of d.rowIds) {
        const t = tubeOf.get(id);
        const r = rowById.get(id);
        if (!t || t.deviceId == null || !r || r.service_id == null) continue;
        const k = String(r.service_id);
        if (!first.has(k)) { first.set(k, t); continue; }
        if (first.get(k) === t) continue;   // та же пробирка — одна пробирка, своей этикетки нет
        if (!out.has(t)) out.set(t, []);
        out.get(t).push(id);
    }
    return out;
}

/**
 * Ревью S3, M-3 — приборы, которые в этот день кормят и пробирку мочи, и пробирку
 * другого материала (или без материала): у таких пробирок свои этикетки.
 * @returns {Set<string>}
 */
function urineSplitDevices(d) {
    const seen = new Map();   // прибор → { urine, other }
    for (const t of d.tubes) {
        if (t.deviceId == null) continue;
        const k = String(t.deviceId);
        const m = seen.get(k) || { urine: false, other: false };
        if (t.material === 'urine') m.urine = true; else m.other = true;
        seen.set(k, m);
    }
    return new Set([...seen].filter(([, m]) => m.urine && m.other).map(([k]) => k));
}

/**
 * Время на этикетке — местное (часы компьютера клиники), числом, как в печатных
 * бланках: «02.11.2026, 19:06». Нет отметки забора — сейчас.
 */
export function tubeLabelStamp(value, now = new Date()) {
    return dateNumeric(value || now, { withTime: true });
}
