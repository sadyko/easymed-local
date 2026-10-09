// LIS_PROXY_V1 — форма LIS Proxy → то, что понимает приём Easy-Med. ЧИСТЫЙ
// модуль: ни базы, ни сети (docs/specs/2026-10-09-lis-proxy-endpoint-design.md,
// разделы 3.2–3.5 и 5).
//
// Прокси шлёт одно значение в запросе (apiResultSave). Приём Easy-Med — HL7 до
// самого низа: сырое сообщение перечитывают серия, «Привязать», «Поле
// анализатора». Поэтому значение превращается в минимальный ORU^R01 и идёт тем
// же входом, что у своего порта (receive.js), — правила владельца не дублируются.
import { decimalPoint, trimZeros, isNoResult, FORWARDER_FACILITY, LISPROXY_APP } from './wire.js';   // LISPROXY_APP: ревью I2/I3

/** MSH-3 синтетического сообщения: постоянное. Имя анализатора в прокси — свободный текст, а модель по MSH-3 угадывает приём (discover.js guessProfile). */
export const PROXY_APP = LISPROXY_APP;   // ревью I2/I3 — по нему (и MSH-4 LabPC) wire.js выбирает провод lisproxy* по модели строки
/** Начало журнала у строки, которая не результат и не беда: мусор прибора, лишний показатель гематологии. Такие строки разрешены сразу и не в ленте (rpc/lis.js lisRecent). */
export const PROXY_QUIET_PREFIX = 'LIS Proxy, справка: ';
/** Начало причины «не номер пробирки» (лоток; ingest.js — та же стена у строк LIS Proxy). */
export const PROXY_NOT_TUBE = 'LIS Proxy прислал не штрихкод пробирки';
/** Служебные строки Mindray, которые прокси шлёт как значения (BC-20/BC-5300: Take Mode, Test Mode; BC-780: IS). Сравнение — без учёта регистра. */
export const PROXY_SERVICE_CODES = Object.freeze(['TAKE MODE', 'TEST MODE', 'BLOOD MODE', 'REF GROUP', 'REMARK', 'AGE', 'IS']);

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const SIX_DECIMALS = /^-?\d+\.\d{6}$/;
const t = (v) => String(v == null ? '' : v).trim();

/** Разделители HL7 в поле — escape-последовательности; перевод строки (граница сегмента) — пробел. */
export function escapeHl7(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\E\\')
    .replace(/\|/g, '\\F\\')
    .replace(/\^/g, '\\S\\')
    .replace(/&/g, '\\T\\')
    .replace(/~/g, '\\R\\')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Значение и его тип (OBX-2). Одна десятичная запятая без точки — точка
 * («5,1» → «5.1», ПК с русскими настройками); число ровно с шестью знаками после
 * точки (%f программы BS-200: «5.100000») — без хвостовых нулей, как делает с
 * BS-200 свой порт (wire.js trimZeros); NM — только простое число.
 */
export function proxyValue(res) {
  let v = decimalPoint(t(res));
  if (SIX_DECIMALS.test(v)) v = trimZeros(v);
  return { value: v, type: PLAIN_NUMBER.test(v) ? 'NM' : 'ST' };
}

/** Норма прибора: числа с шестью знаками — без хвостовых нулей («3.900000-6.100000» → «3.9-6.1»). */
export function proxyNorms(norms) {
  return t(norms).replace(/-?\d+\.\d{6}(?!\d)/g, (n) => trimZeros(n));
}

/**
 * Причина «это не результат» или null. Такая строка журнала разрешается сразу:
 * без лотка, без серии (раздел 3.4).
 */
export function junkReason({ code, res } = {}) {
  const c = t(code);
  const v = t(res);
  if (!v || /^\*+$/.test(v)) return 'пустое значение' + (c ? ' («' + c + '»)' : '');
  if (PROXY_SERVICE_CODES.includes(c.toUpperCase())) return 'служебная строка прибора «' + c + '»';
  if (/\s/.test(c) && !PLAIN_NUMBER.test(decimalPoint(v))) return 'служебная строка прибора «' + c + '»';
  if (isNoResult(v)) return 'прибор: нет результата «' + v + '»' + (c ? ' (' + c + ')' : '');
  return null;
}

const LAB_LABEL = /^LAB-(\d{6,})$/i;
// AutoLumo (тип AsServerAutoLumoA1860ASTM) отдаёт только последние 8 знаков
// номера: «LAB-000777» → «B-000777», «LAB-1234567» → «-1234567».
const AUTOLUMO_CUT = [/^B-(\d{6})$/i, /^-(\d{7})$/];

/**
 * Номер пробирки из поля barcode прокси (раздел 3.5).
 * @param {string} raw
 * @param {{autolumo?: boolean}} [o]  модель строки прибора — AutoLumo A1000
 * @returns {{ok:true, barcode:string, restored:boolean, shown:string} | {ok:false, barcode:'', restored:false, shown:string, why:string}}
 */
export function normaliseProxyBarcode(raw, { autolumo = false } = {}) {
  const s = t(raw);
  const lab = LAB_LABEL.exec(s);
  if (lab) return { ok: true, barcode: 'LAB-' + lab[1], restored: false, shown: s };
  const cut = AUTOLUMO_CUT.map((re) => re.exec(s)).find(Boolean);
  if (cut && autolumo) return { ok: true, barcode: 'LAB-' + cut[1], restored: true, shown: s };
  return { ok: false, barcode: '', restored: false, shown: s, why: notTubeReason(s, !!cut) };
}

function notTubeReason(s, looksCut) {
  const head = PROXY_NOT_TUBE + ': ' + (s || '(пусто)');
  if (!s) return head + ' — анализатор не передал номер пробы';
  if (s.includes('^')) return head + ' — проверьте тип анализатора в LIS Proxy (BC-20/BC-5300 путают поле)';
  if (/^\d+$/.test(s)) {
    return head + ' — похоже на номер пациента или места, а не пробирки: на анализаторе сканируйте этикетку LAB- в поле штрихкода,'
      + ' номер пациента не заполняйте; пробу привяжите кнопкой «Привязать»';
  }
  if (looksCut) return head + ' — похоже на обрезанную этикетку AutoLumo: если это AutoLumo A1000, выберите эту модель у прибора в «Анализаторах»';
  return head + ' — проверьте настройку штрихкода на анализаторе и тип анализатора в LIS Proxy; если это проба вашего заказа — нажмите «Привязать»';
}

const pad = (n) => String(n).padStart(2, '0');
/** MSH-7: местное время ПК — как у ответа прибору (hl7.js). */
export function hl7Stamp(d = new Date()) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/**
 * Одно значение — одно ORU^R01 провода forwarder (wire.js: MSH-4 = LabPC; номер
 * — OBR-3, код — OBX-3, значение — OBX-5 целиком). barcode — уже нормализованный
 * номер «LAB-…» или '' (не номер пробирки). Код — одним компонентом: сравнение
 * идёт по компоненту 1 или 2 (match.js), а текст лотка показывает OBX-3 целиком.
 */
export function buildOru({ code = '', res = '', unit = '', norms = '', flag = '', barcode = '', controlId = '1', now = new Date() } = {}) {
  const v = proxyValue(res);
  return [
    'MSH|^~\\&|' + PROXY_APP + '|' + FORWARDER_FACILITY + '|||' + hl7Stamp(now) + '||ORU^R01|' + escapeHl7(controlId) + '|P|2.3.1||||0||UNICODE',
    'PID|1',
    'OBR|1||' + escapeHl7(t(barcode)),
    'OBX|1|' + v.type + '|' + escapeHl7(t(code)) + '||' + escapeHl7(v.value) + '|' + escapeHl7(t(unit)) + '|' + escapeHl7(proxyNorms(norms))
      + '|' + escapeHl7(t(flag)) + '|||F',
  ].join('\r');
}

/** Дата рождения для прокси — только dd.MM.yyyy (другие виды прокси портит); нет даты — ''. */
export function dottedDate(v) {
  const s = t(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[3] + '.' + iso[2] + '.' + iso[1];
  return /^\d{2}\.\d{2}\.\d{4}$/.test(s) ? s : '';
}
/** Пол для прокси: «1» → M, «0» → F, прочее — пусто. */
export function sexCode(gender) { return gender === 'male' ? '1' : gender === 'female' ? '0' : ''; }
/** Биоматериал BS-200: serum / plasma / urine — по полю «Биоматериал» услуги; иначе сыворотка. */
export function biomaterialOf(specimen) {
  const s = t(specimen).toLowerCase();
  if (/моч|urine/.test(s)) return 'urine';
  if (/плазм|plasma/.test(s)) return 'plasma';
  return 'serum';
}

/**
 * Ответ apiOrderGet: {"0": {...}, "1": {...}} — по записи на код; каждый ключ в
 * каждой записи обязателен (иначе прокси ничего не шлёт анализатору). Имён нет
 * (решение владельца 2): clientId — номер пробирки.
 */
export function worklistEntries({ barcode, codes = [], patient = {}, specimen = '' } = {}) {
  const out = {};
  codes.forEach((code, i) => {
    out[String(i)] = {
      clientId: barcode,
      surname: '',
      name: '',
      date_birth: dottedDate(patient && patient.date_of_birth),
      sex: sexCode(patient && patient.gender),
      biomaterial_code: biomaterialOf(specimen),
      code,
    };
  });
  return out;
}

// ═══ LIS_PROXY_V1 (ревью I1) — ТЕЛО ЗАПРОСА: СВОЙ РАЗБОР ═════════════════════
// Вход (routes/lisproxy.js) читает тело байтами ДО разбора и пишет его в
// журнал первым; разбирает — здесь. Разборщик express (urlencoded) отказывал
// телу больше 100 КБ, больше 1000 пар, с Content-Type не формой или с
// charset не UTF-8 — и тогда ни тела в журнале, ни «Ok» в ответе, а на не-«Ok»
// прокси бросает остальные тесты пробы (LIS-API.md, §2). Здесь отказа нет:
// что разобралось — разобрано, остальное — отметка в журнале.

/** Сколько пар «ключ=значение» разбирается (одно значение — восемь пар). */
export const FORM_MAX_PAIRS = 10000;
/** Глубина скобок ключа: lisResult[R][res] — 3; глубже — остаток одним сегментом. */
const FORM_MAX_DEPTH = 5;
/** Сегменты ключа, которые не пишутся никогда: подмена прототипа объекта. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

const utf8Strict = () => new TextDecoder('utf-8', { fatal: true });
const decoderFor = (label) => { try { return new TextDecoder(label); } catch { return null; } };

/**
 * Байты тела → текст. UTF-8; не UTF-8 — объявленная в Content-Type кодировка
 * (если её знает TextDecoder), иначе windows-1251 (ПК с русскими настройками).
 * @returns {{text:string, charset:string}}  charset — чем прочитано на деле
 */
export function decodeProxyBody(buf, declared = '') {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf == null ? '' : String(buf), 'utf8');
  try { return { text: utf8Strict().decode(bytes), charset: 'utf-8' }; } catch { /* не UTF-8 */ }
  const own = declared && !/^utf-?8$/i.test(String(declared).trim()) ? decoderFor(String(declared).trim()) : null;
  const d = own || new TextDecoder('windows-1251');
  return { text: d.decode(bytes), charset: d.encoding };
}

/** Запрос результата — по СЫРОМУ тексту (method=apiResultSave, любой регистр, и method[]): ответ «Ok», даже если тело не разобралось. */
export function looksLikeResult(text) {
  return /(?:^|&)\s*method(?:\[\]|%5B%5D)?=\s*apiresultsave\s*(?:&|$)/i.test(String(text == null ? '' : text));
}

/** «+» — пробел; подряд идущие %XX — байты: UTF-8, иначе windows-1251 (notes узнаёт об этом). */
function pctDecode(s, notes) {
  return String(s).replace(/\+/g, ' ').replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = Buffer.from(run.replace(/%/g, ''), 'hex');
    try { return utf8Strict().decode(bytes); } catch {
      notes.add('значения в %XX не в UTF-8 — прочитаны как windows-1251');
      return new TextDecoder('windows-1251').decode(bytes);
    }
  });
}

/** Ключ → сегменты: «lisResult[R][res]» → ['lisResult', 'R', 'res']; «[]» — ''. Не по форме — ключ целиком. */
function keySegments(key) {
  const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
  if (!m) return [key];
  const segs = [m[1], ...[...m[2].matchAll(/\[([^[\]]*)\]/g)].map((x) => x[1])];
  return segs.length > FORM_MAX_DEPTH ? [...segs.slice(0, FORM_MAX_DEPTH - 1), segs.slice(FORM_MAX_DEPTH - 1).join('][')] : segs;
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Положить значение по сегментам. Повтор ключа — массив значений; «[]» — в массив; строка не затирает объект. */
function put(root, segs, value) {
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (Array.isArray(node)) {
      const next = {};
      node.push(next);
      node = next;
      continue;
    }
    const nextIsArray = segs[i + 1] === '';
    if (nextIsArray ? !Array.isArray(node[seg]) : !isPlainObject(node[seg])) {
      if (nextIsArray && typeof node[seg] === 'string') node[seg] = [node[seg]];
      else node[seg] = nextIsArray ? [] : {};
    }
    node = node[seg];
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(node)) { node.push(value); return; }
  const cur = node[last];
  if (cur === undefined) node[last] = value;
  else if (typeof cur === 'string') node[last] = [cur, value];
  else if (Array.isArray(cur)) cur.push(value);
  // объект уже есть («lisResult[name]=…» раньше «lisResult=…») — строка его не затирает
}

/**
 * Тело application/x-www-form-urlencoded в виде PHP (lisResult[R][res]=…) →
 * объект. Никогда не бросает. Повтор ключа — массив (кто читает, выбирает:
 * lisproxy.js — последнее значение, у method — первое).
 * @returns {{body: object, notes: string[]}}  notes — что разобрано не так, как пришло
 */
export function parseProxyForm(text) {
  const notes = new Set();
  const body = {};
  const pairs = String(text == null ? '' : text).split('&');
  if (pairs.length > FORM_MAX_PAIRS) notes.add('пар в теле больше ' + FORM_MAX_PAIRS + ' — разобраны первые ' + FORM_MAX_PAIRS);
  for (const pair of pairs.slice(0, FORM_MAX_PAIRS)) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = pctDecode(eq < 0 ? pair : pair.slice(0, eq), notes);
    if (!key) continue;
    const segs = keySegments(key);
    if (segs.some((s) => FORBIDDEN_SEGMENTS.has(s))) continue;
    put(body, segs, pctDecode(eq < 0 ? '' : pair.slice(eq + 1), notes));
  }
  return { body, notes: [...notes] };
}
