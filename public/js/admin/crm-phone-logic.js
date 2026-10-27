// CRM_PHONE_V1 (2026-10-17) — РЕШЕНИЯ ПАНЕЛИ «ТЕЛЕФОН» БЕЗ DOM.
//
// Что показывать на дисплее набора, в какую группу дня положить звонок, как
// фильтровать журнал, каким словом назвать исход, когда загорается полоса «только
// что звонили» и какая строка журнала — наш только что набранный звонок. Ни DOM,
// ни часов, ни сети: всё приходит параметрами, и всё проверяется в
// crm-phone-logic.test.js на граничных значениях (тот же договор, что у
// telephony-logic.js рядом).
//
// Слова исходов — ключи словаря i18n-strings.js: панель рисует их через h(),
// текстовый путь которого переводит tr(). Длительность и исход вендора берутся из
// telephony-logic.js — второго словаря «BUSY → Абонент занят» в коде быть не должно.
import { formatDuration, dispositionLabel } from './telephony-logic.js';
import { nameKey, phoneKey } from './views/crm-phone-match.js';

/** Короче семи цифр не бывает ни одного набираемого номера; тот же порог у сервера (telephony/dial.js). */
export const MIN_DIGITS = 7;
/** «Только что звонили»: входящий без ответа моложе двух минут (эвристика «live» из EasyPhone). */
export const JUST_CALLED_MS = 2 * 60 * 1000;
/** Строка журнала о нашем звонке может начаться чуть РАНЬШЕ нашего нажатия: часы станции — не наши. */
export const DIAL_MATCH_GRACE_MS = 60 * 1000;
/** Карточка «трубка звонит» без ответа журнала живёт десять минут и уступает покою. */
export const DIAL_CARD_TTL_MS = 10 * 60 * 1000;
/** Экран телефониста обновляется сам — он смотрит на него, а не жмёт F5. */
export const POLL_MS = 7000;
const TAIL = 9;

export const digitsOf = (v) => String(v == null ? '' : v).replace(/\D+/g, '');
export const tail9 = (v) => digitsOf(v).slice(-TAIL);

/** Набранное: цифры, * и #; плюс — только ведущий («99+8» станция не наберёт). */
export function cleanTyped(s) {
    const t = String(s || '').replace(/[^\d*#+]/g, '');
    return t.startsWith('+') ? '+' + t.slice(1).replace(/\+/g, '') : t.replace(/\+/g, '');
}

/**
 * Показ набранного: РОВНО ТО, ЧТО НАБРАЛИ, группами по три. Общий формат телефонов
 * (phone-format.js) дописывает «+» и код страны — в карточке это удобство, а в
 * наборнике враньё: человек увидел бы не тот номер, который уйдёт на станцию.
 */
export function groupTyped(v) {
    const s = cleanTyped(v);
    const plus = s.startsWith('+');
    const body = plus ? s.slice(1) : s;
    return (plus ? '+' : '') + body.replace(/(.{3})(?=.)/g, '$1 ');
}

export const canDial = (v) => digitsOf(v).length >= MIN_DIGITS;

const ymd = (d) => d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
const pad2 = (n) => String(n).padStart(2, '0');

/** Группа дня по ЛОКАЛЬНОЙ дате клиники: 'today' | 'yesterday' | 'earlier'. Мусор — 'earlier'. */
export function dayGroup(iso, now = new Date()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'earlier';
    if (ymd(d) === ymd(now)) return 'today';
    const y = new Date(now.getTime());
    y.setDate(y.getDate() - 1);
    return ymd(d) === ymd(y) ? 'yesterday' : 'earlier';
}

export const GROUP_ORDER = ['today', 'yesterday', 'earlier'];

/** Звонки по группам дня в порядке «сегодня · вчера · ранее»; пустые группы опущены. */
export function groupCalls(calls, now = new Date()) {
    const buckets = { today: [], yesterday: [], earlier: [] };
    for (const c of calls || []) buckets[dayGroup(c && c.started_at, now)].push(c);
    return GROUP_ORDER.filter((k) => buckets[k].length).map((k) => ({ key: k, rows: buckets[k] }));
}

/** Время строки: сегодня — ЧЧ:ММ, иначе ДД.ММ ЧЧ:ММ. */
export function timeLabel(iso, now = new Date()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const t = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return ymd(d) === ymd(now) ? t : pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + ' ' + t;
}

/**
 * Исход звонка словами клиники. Разговор был — «Отвечен» в любую сторону; входящий
 * без разговора — «Пропущен»; наш недозвон — словом станции (BUSY → «Абонент
 * занят», CANCEL → «Отменён»), а без слова — «Без ответа».
 */
export function outcomeOf(c) {
    const out = Number(c && c.call_type) === 1;
    const answered = Number(c && c.billsec) > 0;
    const kind = out ? 'out' : (answered ? 'in' : 'miss');
    let word;
    if (answered) word = 'Отвечен';
    else if (!out) word = 'Пропущен';
    else {
        const d = String((c && c.disposition) || '').trim().toUpperCase();
        word = d && d !== 'ANSWER' ? dispositionLabel(d) : 'Без ответа';
    }
    return { out, answered, kind, word, icon: kind === 'miss' ? 'PhoneMissed' : (out ? 'PhoneOut' : 'PhoneIn') };
}

/** Длительность разговора m:ss; не было разговора — тире. */
export const talkLabel = (sec) => (Number(sec) > 0 ? formatDuration(Number(sec)) : '—');

/** Запрос — это номер, если в нём нет ничего, кроме цифр, пробелов, плюса, скобок и дефисов. */
const looksLikeNumber = (q) => /^[\d\s+()\-]+$/.test(q);

export function matchesQuery(c, query) {
    const q = String(query || '').trim();
    if (!q) return true;
    if (looksLikeNumber(q)) return digitsOf(c && c.external_number).includes(digitsOf(q));
    return nameKey(c && c.patient_name).includes(nameKey(q));
}

/**
 * Сегменты как в образце: «Входящие» — ВСЕ входящие (и пропущенные тоже),
 * «Исходящие» — все наши, «Пропущенные» — входящие без разговора. Недозвон
 * исходящего пропущенным не считается: пациент нам не звонил.
 */
export function filterCalls(calls, { seg = 'all', query = '' } = {}) {
    return (calls || []).filter((c) => {
        const o = outcomeOf(c);
        if (seg === 'in' && o.out) return false;
        if (seg === 'out' && !o.out) return false;
        if (seg === 'miss' && o.kind !== 'miss') return false;
        return matchesQuery(c, query);
    });
}

/** Полоса «только что звонили»: свежайший входящий без ответа моложе двух минут. */
export function justCalled(calls, now = Date.now()) {
    return (calls || []).find((c) => Number(c.call_type) === 0 && !(Number(c.billsec) > 0)
        && now - Date.parse(c.started_at) < JUST_CALLED_MS) || null;
}

/**
 * Какая строка журнала — наш только что набранный звонок: исходящий, хвост номера
 * из девяти цифр совпал (у одного номера код страны то есть, то нет), начался не
 * раньше чем за минуту до нашего нажатия.
 */
export function matchDialed(calls, { digits, since }) {
    const t = tail9(digits);
    if (!t) return null;
    return (calls || []).find((c) => Number(c.call_type) === 1 && tail9(c.external_number) === t
        && Date.parse(c.started_at) >= Number(since) - DIAL_MATCH_GRACE_MS) || null;
}

/** Инициалы для аватара карточки звонка; без имени — «#». */
export function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '#';
}

/**
 * Кому принадлежит номер: заявка с доски (по ключу номера, как ищет сама доска),
 * иначе пациент из строки журнала с тем же номером. По обрывку не угадываем.
 */
export function whoIs(digits, { leads = [], calls = [] } = {}) {
    const d = digitsOf(digits);
    if (d.length < MIN_DIGITS) return null;
    const k = phoneKey(d);
    const lead = (leads || []).find((r) => r && phoneKey(r.phone) === k);
    if (lead) return { kind: 'lead', name: lead.full_name || '', lead };
    const c = (calls || []).find((x) => x && x.patient_name && phoneKey(x.external_number) === k);
    if (c) return { kind: 'patient', name: c.patient_name, patient_id: c.patient_id || null };
    return null;
}
