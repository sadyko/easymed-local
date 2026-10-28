// CALL_RING_V1 (2026-10-17) — СОБЫТИЕ СТАНЦИИ О ЖИВОМ ЗВОНКЕ, ОДНИМ ВИДОМ.
//
// Владелец: «is it possible to ring here and number with patient name appear».
// Чтобы панель «Телефон» узнала о звонке В МОМЕНТ звонка, станция должна сама
// сказать о нём: onlinePBX — исходящим вебхуком («начало звонка», «начавшийся
// разговор», «завершение звонка»), Binotel — запросом «кто звонит»
// (apiCallSettings, telephony/webhooks.js). Этот модуль приводит их к одному
// виду:
//
//     { uuid, event: 'ring' | 'answer' | 'end', direction: 'in' | 'out', caller, callee, at }
//
// ЕГО ЧИТАЮТ ОБЕ СТОРОНЫ КАНАЛА: публичный сервер (public-server/routes/pbx.js —
// принимает вебхук onlinePBX, потому что клиника за NAT) и сама клиника (прямой
// приём telephony/ring-webhook.js и Binotel). Один разборщик — чтобы одно и то
// же событие читалось одинаково, откуда бы ни пришло.
//
// ПОЧЕМУ РАЗБОР ТЕРПИМЫЙ. Официальной схемы вебхуков onlinePBX в открытом
// доступе нет; по сторонним коннекторам известны поля event, direction, uuid,
// caller, callee, date, gateway. Поэтому: направление — по подстрокам (и
// по-русски тоже), номера — по нескольким именам полей, время — unix-секунды,
// миллисекунды или ISO. Непонятное событие НЕ теряется молча: оно
// возвращается как { unknown: true, keys, name } — имена полей без значений и
// имя события, чтобы по журналу сервера (клиника) или по колонке keys
// (публичный сервер) можно было уточнить схему на первых настоящих событиях, не
// глядя на номера пациентов.
//
// FIX_318_V1 (C6) — ИМЯ СОБЫТИЯ — ТОЛЬКО ИЗ СПИСКА, НЕ ПО ПОДСТРОКАМ. Подстроки
// угадывали: «call_missed» (есть «call») читался как «звонит» — панель
// показывала пропущенный звонок звонящим; «pending» (есть «end») — как «конец».
// Теперь имя сверяется со списком EVENT_NAMES целиком (регистр, пробелы и
// дефисы не важны); всё остальное — unknown: пропускается, клиника пишет его
// имя в журнал один раз (live.js), публичный сервер — в строку unknown.
//
// !!! ИМЕНА СОБЫТИЙ НЕ СВЕРЕНЫ С НАСТОЯЩЕЙ СТАНЦИЕЙ. Список ниже собран из
// сторонних коннекторов и названий в кабинете onlinePBX («начало звонка»,
// «начавшийся разговор», «завершение звонка»), а не из документации и не с
// живой станции. До выпуска клиникам — подключить вебхук настоящего кабинета
// onlinePBX, сделать входящий (ответить), входящий (не ответить), исходящий и
// посмотреть имена: журнал клиники («[ring] событие станции … не распознано»)
// или строки event = 'unknown' публичного сервера (keys: 'event=<имя>').
// Пропущенное нужное имя — дописать сюда (тест pbx-event.test.js).
import { dialableNumber } from './dial.js';

export const RING = 'ring';
export const ANSWER = 'answer';
export const END = 'end';

const EVENT_NAMES = new Map([
  ...['call_start', 'call_started', 'start', 'call_ring', 'call_ringing', 'ring', 'ringing', 'call_incoming', 'incoming',
    'call_new', 'new_call', 'call_begin', 'начало звонка', 'входящий звонок'].map((n) => [n, RING]),
  ...['call_answer', 'call_answered', 'answer', 'answered', 'call_talk', 'talk', 'call_connected', 'connected',
    'call_bridge', 'bridge', 'начавшийся разговор', 'начало разговора'].map((n) => [n, ANSWER]),
  ...['call_end', 'call_ended', 'end', 'call_hangup', 'hangup', 'call_finish', 'call_finished', 'finish',
    'call_completed', 'completed', 'call_stop', 'завершение звонка', 'конец звонка'].map((n) => [n, END]),
]);
const DAY_MS = 86_400_000;

const pick = (body, names) => {
  for (const n of names) {
    const v = body[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
};

const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Время события: unix-секунды, миллисекунды, ISO или «дата время»; мусор — время приёма.
 * FIX_318_V1 (C6) — и время вне диапазона дат (огромное число: new Date бросал
 * RangeError, станция получала 400 и повторяла событие), и дальше суток от
 * приёма (часы станции врут) — время приёма, без исключения.
 */
export function eventTime(raw, now) {
  const fallback = isoOf(now);
  if (raw === undefined || raw === null || raw === '') return fallback;
  let ms = NaN;
  const n = Number(raw);
  if (Number.isFinite(n)) { if (n > 0) ms = n < 1e11 ? n * 1000 : n; }
  else { const t = Date.parse(String(raw).replace(' ', 'T')); if (Number.isFinite(t)) ms = t; }
  if (!Number.isFinite(ms) || Math.abs(ms - now) > DAY_MS) return fallback;
  return isoOf(ms);
}

// FIX_318_V1 (C6) — имя события для сверки со списком: регистр, лишние пробелы и дефисы не важны.
const nameKey = (raw) => String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, ' ');
function eventKind(raw) {
  const k = nameKey(raw);
  return EVENT_NAMES.get(k) || EVENT_NAMES.get(k.replace(/[\s-]+/g, '_')) || '';
}
/**
 * Имя непонятного события — для журнала и строки unknown: только буквы, цифры и
 * «_ . - :», не длиннее 40; похожее на номер (5+ цифр подряд) или с иными
 * знаками — '?': в журнал не должно попасть ничего, кроме имени.
 */
function unknownName(raw) {
  const k = nameKey(raw);
  if (!k) return '';
  if (/\d{5,}/.test(k) || /[^\p{L}\p{N} _.\-:]/u.test(k)) return '?';
  return k.slice(0, 40);
}

function directionOf(raw, caller, callee) {
  const s = String(raw || '').toLowerCase();
  if (/out|исход|chiq/.test(s)) return 'out';
  if (/in|вход|kir/.test(s)) return 'in';
  // Направления нет — по виду номеров: добавочный (до пяти цифр) звонит
  // длинному номеру — исходящий; иначе входящий.
  const c = caller.replace(/\D/g, '');
  const d = callee.replace(/\D/g, '');
  return c && c.length <= 5 && d.length > 5 ? 'out' : 'in';
}

/**
 * Событие onlinePBX (или любой станции с похожими полями) → один вид.
 * @returns {{uuid:string, event:string, direction:string, caller:string, callee:string, at:string} | {unknown:true, keys:string[], name:string} | null}
 */
export function normalizePbxEvent(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (!keys.length) return null;
  const rawName = pick(body, ['event', 'type', 'status', 'action', 'state']);
  const event = eventKind(rawName);
  if (!event) return { unknown: true, keys, name: unknownName(rawName) };   // FIX_318_V1 (C6) — и имя: по нему сверяется схема
  const caller = dialableNumber(pick(body, ['caller', 'from', 'caller_id_number', 'caller_number', 'src', 'phone', 'external_number', 'externalNumber']));
  const callee = dialableNumber(pick(body, ['callee', 'to', 'destination_number', 'called', 'dst', 'internal_number', 'internalNumber']));
  const at = eventTime(pick(body, ['date', 'time', 'timestamp', 'start_stamp', 'created_at']), now);
  let uuid = String(pick(body, ['uuid', 'call_id', 'callid', 'id', 'generalCallID', 'general_call_id']) || '').trim().slice(0, 80);
  // Без номера звонка начало, ответ и конец не нашли бы друг друга: ключ
  // собирается из номеров и минуты — на один разговор хватает.
  if (!uuid) uuid = 'syn:' + caller + '|' + callee + '|' + at.slice(0, 16);
  return { uuid, event, direction: directionOf(pick(body, ['direction', 'dir']), caller, callee), caller, callee, at };
}

/** Binotel «кто звонит» (apiCallSettings) — это и есть «звонит сейчас». Без номера звонящего — null. */
export function ringFromBinotelSettings(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object') return null;
  const caller = dialableNumber(body.externalNumber);
  if (!caller) return null;
  const id = String(body.generalCallID || '').trim();
  return {
    uuid: id ? 'binotel:' + id : 'syn:' + caller + '|' + dialableNumber(body.internalNumber) + '|' + isoOf(now).slice(0, 16),
    event: RING,
    direction: 'in',
    caller,
    callee: dialableNumber(body.internalNumber),
    at: isoOf(now),
  };
}

/**
 * FIX_318_V1 (C2) — Binotel «звонок завершён» (apiCallCompleted, callDetails) —
 * конец живого звонка, который открыл «кто звонит»: тот же ключ
 * binotel:<generalCallID>. Без него «Входящий звонок» висел на панели три
 * минуты (RINGING_MAX_MS) и пищал 40 секунд после того, как трубку положили.
 * answered — разговор был (billsec > 0 или disposition ANSWER): отдельного
 * события «ответили» Binotel вебхуком не шлёт, а без этой пометки отвеченный
 * звонок показался бы «Пропущен». Без номера звонка — null (закрывать нечего).
 */
export function endFromBinotelCompleted(details, { now = Date.now() } = {}) {
  if (!details || typeof details !== 'object') return null;
  const id = String(details.generalCallID || '').trim();
  if (!id) return null;
  const answered = Number(details.billsec) > 0 || /^answer/i.test(String(details.disposition || '').trim());
  return {
    uuid: 'binotel:' + id,
    event: END,
    direction: Number(details.callType) === 1 ? 'out' : 'in',
    caller: dialableNumber(details.externalNumber),
    callee: dialableNumber(details.internalNumber),
    at: isoOf(now),
    answered,
  };
}
