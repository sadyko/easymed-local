// LIS_PROXY_V1 — форма LIS Proxy → то, что понимает приём Easy-Med. ЧИСТЫЙ
// модуль: ни базы, ни сети (docs/specs/2026-10-09-lis-proxy-endpoint-design.md,
// разделы 3.2–3.5 и 5).
//
// Прокси шлёт одно значение в запросе (apiResultSave). Приём Easy-Med — HL7 до
// самого низа: сырое сообщение перечитывают серия, «Привязать», «Поле
// анализатора». Поэтому значение превращается в минимальный ORU^R01 и идёт тем
// же входом, что у своего порта (receive.js), — правила владельца не дублируются.
import { decimalPoint, trimZeros, isNoResult, FORWARDER_FACILITY } from './wire.js';

/** MSH-3 синтетического сообщения: постоянное. Имя анализатора в прокси — свободный текст, а модель по MSH-3 угадывает приём (discover.js guessProfile). */
export const PROXY_APP = 'LISPROXY';
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
