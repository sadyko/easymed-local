// LIS_REAL_ANALYZERS_V1_WIRE — провод прибора как ДАННЫЕ: в каком поле номер
// пробы, код теста, подпись и значение. ЧИСТЫЙ модуль: ни базы, ни сети, ни
// времени (docs/specs/2026-10-01-lis-real-analyzers-design.md, разделы 1, 4,
// 5, 7).
//
// Почему провод, а не один разбор на всех. Сегодняшний разбор (hl7.js
// parseMessage) читает то, что пишет Mindray-гематология: номер пробы в OBR-3,
// код в OBX-3, значение — OBX-5 целиком. Настоящие приборы клиники пишут иначе:
//   — BS-200 кладёт в OBR-3 номер места в штативе («Sample ID is for internal
//     use and must not be analyzed by the server», руководство, с. 24), а
//     штрихкод — в OBR-2; голое «2» из OBR-3 легло бы в заказ № 2 чужого
//     пациента;
//   — Autobio по сети пишет код позиции в OBX-4, а в OBX-5 — «RLU^концентрация»:
//     OBX-5 целиком дал бы в бланке «5981666^390.946».
// Профиль называет свой провод (profile.wire); сообщения нашего переадресателя
// (MSH-4 = LabPC) читаются проводом forwarder, какой бы ни был профиль.
//
// Чего здесь НЕТ: решения, что применять. D4 (только подтверждённое человеком)
// живёт в match.js и ingest.js; провод решает только, что СРАВНИВАТЬ.
import { mshOf } from './hl7.js';
import { guessProfile } from './discover.js';   // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 11) — провод и по тому, как сообщение называет себя

export const WIRES = Object.freeze(['default', 'forwarder', 'mindray-chem', 'autobio-hl7', 'mindray-hematology']);

/**
 * LIS_PROXY_V1 (ревью I2/I3) — MSH-3 синтетического ORU входа LIS Proxy
 * (lisproxy-form.js buildOru; MSH-4 — LabPC). Поля такого сообщения — как у
 * переадресателя (номер — OBR-3, код — OBX-3, значение — OBX-5 целиком, флаг
 * прибора — OBX-8), а правила значения и флага — МОДЕЛИ строки прибора, как у
 * своего порта: провод lisproxy-chem (BS-200 и химия Mindray — D6: качественный
 * ответ, хвостовые нули), lisproxy-autobio (A1000 — D9: флаги прибора), lisproxy
 * (гематология, прибор без модели — как переадресатель).
 */
export const LISPROXY_APP = 'LISPROXY';
const PROXY_WIRE_OF = Object.freeze({ 'mindray-chem': 'lisproxy-chem', 'autobio-hl7': 'lisproxy-autobio' });
export const PROXY_WIRES = Object.freeze(new Set(['lisproxy', 'lisproxy-chem', 'lisproxy-autobio']));
// Провода lisproxy* не в WIRES: WIRES — провода, которые называет профиль; эти
// выбирает только wireDecision по самому сообщению.
/** Провод с полями переадресателя: номер — OBR-3, подпись — OBX-4 (наш переадресатель и вход LIS Proxy). */
export const forwarderLike = (wire) => wire === 'forwarder' || PROXY_WIRES.has(wire);

/** MSH-4 нашего переадресателя (analyzers/forwarder/hl7-oru.js). */
export const FORWARDER_FACILITY = 'LabPC';

/**
 * Номер пробы по проводу (раздел 1): основное поле, запасное (только если
 * основное пусто) и поля, которые не читаются никогда.
 */
const SAMPLE_FIELDS = Object.freeze({
  'default':            { primary: 'filler', fallback: null,     never: [] },
  'forwarder':          { primary: 'filler', fallback: null,     never: [] },
  'lisproxy':           { primary: 'filler', fallback: null,     never: [] },   // LIS_PROXY_V1 — как forwarder
  'lisproxy-chem':      { primary: 'filler', fallback: null,     never: [] },   // LIS_PROXY_V1 — номер кладёт сам вход (OBR-3)
  'lisproxy-autobio':   { primary: 'filler', fallback: null,     never: [] },   // LIS_PROXY_V1
  'mindray-chem':       { primary: 'placer', fallback: null,     never: ['filler'] },
  'autobio-hl7':        { primary: 'placer', fallback: null,     never: [] },
  'mindray-hematology': { primary: 'filler', fallback: 'placer', never: [] },
});
const FIELD_NAME = { placer: 'OBR-2', filler: 'OBR-3' };

const known = (wire) => (WIRES.includes(wire) || PROXY_WIRES.has(wire) ? wire : 'default');   // PROXY_WIRES: LIS_PROXY_V1 (ревью I2/I3)

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R1, п. 11) — какой провод безопаснее, когда
 * профиль строки и само сообщение называют разные: меньше полей, откуда берутся
 * голые цифры. mindray-chem не читает OBR-3 никогда (место в штативе BS-200),
 * autobio-hl7 берёт голые цифры только из OBR-2, mindray-hematology — из OBR-3
 * и запасного OBR-2.
 */
const SAFER = ['default', 'forwarder', 'lisproxy', 'lisproxy-chem', 'lisproxy-autobio', 'mindray-hematology', 'autobio-hl7', 'mindray-chem'];   // lisproxy*: LIS_PROXY_V1 — спора у них не бывает (wireDecision)

/**
 * Какой провод у сообщения: переадресатор узнаётся по MSH-4, иначе — провод
 * профиля прибора, иначе (прибор без профиля, прежние профили) — default.
 *
 * LIS_REAL_ANALYZERS_V1 (ревью R1, п. 11) — и по тому, как сообщение называет
 * себя (MSH-3 / MSH-4, псевдонимы профилей — discover.js guessProfile):
 *   — у строки нет профиля или профиль провода не называет (прежние, чужой) —
 *     провод сообщения: строка BS-200 без профиля или с профилем BS-240 иначе
 *     читала бы OBR-3 — номер места в штативе;
 *   — профиль и сообщение называют РАЗНЫЕ провода — безопасный из двух (SAFER):
 *     сообщение, назвавшее себя BS-200, OBR-3 не читает никогда.
 * @param {{profile?: {wire?:string}|null, facility?: string, app?: string}} [o]
 */
export function wireFor(o = {}) {
  return wireDecision(o).wire;
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 12) — провод и СПОР. Профиль строки и
 * само сообщение называют РАЗНЫЕ провода, и ни один не default: строка
 * прибора — «BC-780», а сообщение назвало себя «Mindray|BS-200E». Безопасный
 * провод (wire) годится, чтобы прочесть вид сообщения и номер для человека, но
 * не чтобы класть значения в бланк: какое поле значение и где код, решает
 * провод, и выбирать наугад нельзя. Приём (ingest.js) такое сообщение кладёт в
 * лоток с причиной — человек правит модель прибора.
 * @returns {{wire:string, conflict:boolean, rowModel?:string, messageModel?:string}}
 */
export function wireDecision({ profile = null, facility = '', app = '' } = {}) {
  const viaForwarder = String(facility == null ? '' : facility).trim().toLowerCase() === FORWARDER_FACILITY.toLowerCase();
  // LIS_PROXY_V1 (ревью I2/I3) — синтетическое ORU входа LIS Proxy: правила — модели строки.
  if (viaForwarder && String(app == null ? '' : app).trim().toUpperCase() === LISPROXY_APP) {
    return { wire: PROXY_WIRE_OF[profile && profile.wire] || 'lisproxy', conflict: false };
  }
  if (viaForwarder) return { wire: 'forwarder', conflict: false };
  const own = guessProfile({ app, facility });
  const fromRow = known(profile && profile.wire);
  const fromMessage = known(own && own.wire);
  if (fromRow === fromMessage || fromMessage === 'default') return { wire: fromRow, conflict: false };
  if (fromRow === 'default') return { wire: fromMessage, conflict: false };
  const wire = SAFER.indexOf(fromRow) >= SAFER.indexOf(fromMessage) ? fromRow : fromMessage;
  return { wire, conflict: true, rowModel: profile.model || profile.key || '', messageModel: own.model };
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R1, п. 7) — провода, у которых MSH-16 = 1/2
 * значит калибровку и контроль качества: химия Mindray (руководство BS-200,
 * с. 8: «0- Sample result; 1- Calibration result; 2- QC result»).
 * LIS_VENDOR_EXACT_V1 (D2) — и BS-240 с CL-900i: их профили теперь на этом
 * проводе, и соглашение у них документировано тем же словами (руководство
 * BS-360E/BS-240Pro/BS-240E, с. 12; Host Interface Manual CL, с. 1-26).
 * Раньше они стояли на default «по отсутствию руководства», и их контроль
 * (MSH + OBR, номер теста в OBR-2) читался как проба.
 *
 * Ревью R2, п. 11 — Autobio по сети (autobio-hl7) снят: его провод — по
 * полевому драйверу, не по документу, и то, что MSH-16 у него значит то же,
 * — догадка по заголовку «A2000 plus HL7 protocol V0.02». Его MSH-16 = 1/2
 * идёт обычным приёмом: без этикетки LAB- — в лоток, где его видно.
 * ПРОВЕРИТЬ НА ПРИБОРЕ (спецификация, раздел 5).
 */
const VENDOR_KIND_WIRES = new Set(['mindray-chem']);

/**
 * LIS_VENDOR_EXACT_V1 (D7) — контроль гематологии Mindray. Её диалект читают
 * провода default (BC-20, BC-5300 — профили без провода) и mindray-hematology
 * (BC-780). MSH-16 там пуст; контроль — ORU^R01 с
 *   — MSH-11 = Q («the MSH-11 value of QC message is Q», руководство BC-3600,
 *     с. D-31; BC-5300, приложение C, табл. 1) или T / D (табл. D-2 того же
 *     руководства: результат контроля / настройка контроля), ИЛИ
 *   — OBR-4.1 = 00003–00008 — тип результата: L-J, X, XB, X-R, средние X и X-R
 *     (BC-5300, табл. 9; BC-3600, табл. D-8). Проба — 00001 (счёт) и 00002
 *     (микроскопия).
 * В OBR-3 контроля — номер файла контроля, маленькое голое число («6»):
 * прочитанный как проба, он ложился в открытый свежий заказ № 6 чужого
 * пациента. Теперь такое сообщение служебное: мимо бланков и лотка, ответ AA.
 * T и D у MSH-11 и в стандарте HL7 — не рабочая проба (обучение, отладка).
 */
const HEMATOLOGY_KIND_WIRES = new Set(['default', 'mindray-hematology']);
const HEMATOLOGY_QC_PROCESSING = new Set(['Q', 'T', 'D']);
const HEMATOLOGY_QC_RESULT_TYPE = /^0000[3-8]$/;
/**
 * LIS_VENDOR_EXACT_V1 (D7, ревью) — система кодов Mindray. Провод default читает
 * и чужие приборы (найденный без модели, «Другой анализатор (общий HL7)»,
 * прежние профили), а «00003»–«00008» — вид результата только у Mindray: в
 * каждом примере производителя — «00003^LJ QCR^99MRC» (BC-5300, табл. 9;
 * BC-3600, с. D-32). Без 99MRC такой OBR-4 — чужой код теста, а не контроль.
 */
const HEMATOLOGY_QC_SYSTEM = '99MRC';

/** LIS_VENDOR_EXACT_V1 (D7) — контроль гематологии по MSH-11 или OBR-4 любого OBR (вид результата Mindray, 99MRC). */
function hematologyQc(text, msh) {
  const segs = String(text == null ? '' : text).split(SEG).filter((s) => s.trim() !== '');
  const comps = (v) => String(v == null ? '' : v).split(msh.compSep).map((c) => c.trim());
  const processing = comps(String(segs[0] || '').split(msh.fieldSep)[10])[0].toUpperCase();
  if (HEMATOLOGY_QC_PROCESSING.has(processing)) return true;
  return segs.some((s) => {
    if (!s.startsWith('OBR')) return false;
    const c = comps(s.split(msh.fieldSep)[4]);
    return HEMATOLOGY_QC_RESULT_TYPE.test(c[0]) && String(c[2] || '').toUpperCase() === HEMATOLOGY_QC_SYSTEM;   // LIS_VENDOR_EXACT_V1 — только код Mindray
  });
}

/**
 * LIS_VENDOR_EXACT_V1 — контроль A1000 (провод autobio-hl7). Кодировщик
 * программы клиники (AutoLumo1000.exe 1.0.7) шлёт контроль РОВНО как пробу
 * пациента, без всякой пометки (autobio-autolumo-a1000.settle.md, находка 2):
 * MSH-16 пуст, вид пробы в сообщение не идёт. Отличие одно — у контроля пуст
 * «ID пациента», и сегмента PID нет (HL7-библиотека прибора пустой сегмент не
 * пишет; у 19 настоящих контролей клиники PID нет ни у одного). Номер контроля
 * в OBR-2 — маленькое голое число («1», «3») — ложился в открытый свежий заказ
 * № 3 чужого пациента (acceptance A1000, T7a).
 *
 * Но PID нет и у пробы пациента — отсюда границы правила:
 *   — «по пробе» (MSH-10 = 7) кодировщик PID не пишет никогда (Et4JYjNVXn), а
 *     контроль «по пробе» не отправляется вовсе (settle, находка 1): только
 *     «по тесту», MSH-10 = 5 — код команды, не номер сообщения;
 *   — «по тесту» PID-3 = «ID пациента» (fKQJJMdGWN), вид пробы кодировщику не
 *     передаётся (wencExhtA): проба с пустым «ID пациента» выглядит как
 *     контроль. Поэтому без PID — контроль, только если номер не может быть
 *     пробиркой пациента: не этикетка LAB- (в любом поле OBR, хоть две — спор
 *     решает приём), не номер с этикетки — LABEL_DIGITS и больше цифр (решение
 *     владельца 2026-10-06, п. 4), и номер вообще есть (без номера — в лоток).
 * Остаётся проба без «ID пациента» и с номером, который приём и так не
 * принимает (номер лаборатории «5», буквы): она станет контролем, а не строкой
 * «Необработанных» — поэтому в настройке A1000 «ID пациента» заполняют или
 * сканируют этикетку LAB-.
 */
function autobioQc(text, msh) {
  if (msh.controlId !== '5') return false;
  const lines = String(text == null ? '' : text).split(SEG);
  if (lines.some((s) => s === 'PID' || s.startsWith('PID' + msh.fieldSep))) return false;
  const pick = pickMessageSample(readResult(text, 'autobio-hl7').obrs, 'autobio-hl7');
  if (pick.lab || pick.conflict || !pick.sampleId) return false;
  return !(DIGITS.test(pick.value) && pick.value.length >= LABEL_DIGITS);
}

// Запросы рабочего списка (раздел 7): Easy-Med заказов не отдаёт, отвечает
// «заказов нет». QRY^Q02 — BS-200 и химия Mindray, QRY^Q01 — Autobio,
// ORM^O01 — гематология Mindray.
const QUERY_TYPES = new Set(['QRY^Q02', 'QRY^Q01', 'ORM^O01']);

const SEG = /\r\n?|\n/;

/**
 * Вид сообщения по заголовку (раздел 5) — без исключений.
 *
 * kind:
 *   'result'      — ORU^R01 пробы пациента: MSH-16 = 0, пусто или любое другое;
 *   'calibration' — ORU^R01 с MSH-16 = 1;
 *   'qc'          — ORU^R01 с MSH-16 = 2 (руководство BS-200, с. 8 и 23).
 *                   LIS_REAL_ANALYZERS_V1 (ревью R1, п. 7) — калибровка и контроль
 *                   по MSH-16 — только у проводов VENDOR_KIND_WIRES (wire —
 *                   второй аргумент; не назван — по MSH-3/4 сообщения). У прочих
 *                   MSH-16 вида не меняет: проба пациента не прячется в служебные.
 *                   LIS_VENDOR_EXACT_V1 (D7) — у гематологии Mindray (провода
 *                   HEMATOLOGY_KIND_WIRES) контроль — MSH-11 = Q/T/D или OBR-4.1 =
 *                   00003–00008 с системой кодов Mindray 99MRC (OBR-4.3);
 *   'query'       — запрос рабочего списка (QRY^Q02, QRY^Q01, ORM^O01);
 *   'unsupported' — разобранный заголовок известного, но не поддержанного типа
 *                   (ADT^A01 …) — ответ AR;
 *   'unparsed'    — нет MSH или пустой тип — ответ AE.
 * service — служебное сообщение (контроль, калибровка, запрос): в бланк и лоток
 * не идёт.
 * У запроса: queryBarcode — QRD-8 (штрихкод пробирки, с. 19), queryCancel —
 * QRD-9 = CAN (отмена группового запроса, с. 34), qrd/qrf — сегменты целиком
 * для эха в ответе Autobio (DSR^Q01).
 */
export function readEnvelope(text, wire) {
  const msh = mshOf(text);
  const env = { ...msh, kind: 'unparsed', service: false, queryBarcode: '', queryCancel: false, qrd: '', qrf: '' };
  if (!msh.ok || !msh.type) return env;
  if (msh.type === 'ORU^R01') {
    // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 7) — только у провода, объявившего
    // это соглашение; провод не назван — по тому, как сообщение называет себя.
    const w = wire === undefined ? wireFor({ app: msh.app, facility: msh.facility }) : known(wire);
    const vendor = VENDOR_KIND_WIRES.has(w);
    env.kind = vendor && msh.ackType === '2' ? 'qc' : vendor && msh.ackType === '1' ? 'calibration'
      : HEMATOLOGY_KIND_WIRES.has(w) && hematologyQc(text, msh) ? 'qc'   // LIS_VENDOR_EXACT_V1 (D7)
      : w === 'autobio-hl7' && autobioQc(text, msh) ? 'qc'   // LIS_VENDOR_EXACT_V1 — контроль A1000: без PID, не номер пробирки
      : 'result';
  } else if (QUERY_TYPES.has(msh.type)) {
    env.kind = 'query';
    for (const s of String(text).split(SEG)) {
      if (!env.qrd && s.startsWith('QRD')) {
        env.qrd = s;
        const f = s.split(msh.fieldSep);
        env.queryBarcode = String(f[8] == null ? '' : f[8]).split(msh.compSep)[0].trim();
        env.queryCancel = String(f[9] == null ? '' : f[9]).split(msh.compSep)[0].trim().toUpperCase() === 'CAN';
      } else if (!env.qrf && s.startsWith('QRF')) {
        env.qrf = s;
      }
    }
  } else {
    env.kind = 'unsupported';
  }
  env.service = env.kind === 'qc' || env.kind === 'calibration' || env.kind === 'query';
  return env;
}

/** BS-200 пишет «5.000000»: хвостовые нули после точки срезаются, число не округляется. */
export function trimZeros(v) {   // LIS_PROXY_V1 — export: значение BS-200 через LIS Proxy (lisproxy-form.js)
  const m = /^([-+]?\d+)\.(\d*?)0*$/.exec(v);
  if (!m) return v;
  const out = m[2] ? m[1] + '.' + m[2] : m[1];
  return /^[-+]?0$/.test(out) ? '0' : out;
}

/**
 * LIS_VENDOR_EXACT_V1 (D0) — одна десятичная запятая между цифрами — точка:
 * ПК прибора с русскими региональными настройками пишет «4,17» (A1000 —
 * double.ToString() .NET; BS-200, CL-900i, BC-5300 — тоже Windows). Только
 * число целиком «цифры,цифры»: «1,2,3», «a,b» и «4,17 mg» не трогаются. В
 * числе HL7 разделителей тысяч нет — «1,000» тем самым единица (как
 * match.js valueKey).
 */
export function decimalPoint(v) {
  return String(v == null ? '' : v).replace(/^([-+]?\d+),(\d+)$/, '$1.$2');
}
/** LIS_VENDOR_EXACT_V1 (D0) — простое число, как его читает приём (ingest.js). */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * LIS_VENDOR_EXACT_V1 (D5) — «нет результата» Mindray: число в OBX-5 не больше
 * −100000000. Руководство CL: «-0x0fffffff means invalid value» (−268435455);
 * в записях BS-240 (2017) — «-268435455.000000» по каждому непосчитанному
 * тесту, у BS-300 того же семейства — «-100000000.0». Такого значения не
 * бывает ни у одного анализа, поэтому правило — на любом проводе. Текст
 * качественных тестов («-», «+», «+-») не число и правило не задевает.
 */
const NO_RESULT_MAX = -100000000;
export function isNoResult(v) {   // LIS_PROXY_V1 — export: «нет результата» от LIS Proxy — справка (lisproxy-form.js)
  const s = decimalPoint(String(v == null ? '' : v).trim());
  return /^-\d+(\.\d+)?$/.test(s) && parseFloat(s) <= NO_RESULT_MAX;
}
/**
 * Причина «не писать» для журнала лотка: что прислал прибор и, для сверки,
 * OBX-13 — значение ДО правки (руководство BS-200: «used as original
 * result»). OBX-13 в бланк не пишется никогда.
 * LIS_VENDOR_EXACT_V1 (D6) — и OBX-9 химии/ИХЛА Mindray: «If the fifth field
 * is invalid value, please refer to ninth field for the result» (Host
 * Interface Manual CL, с. 1-20) — человек видит ответ прибора и вносит его
 * сам; приём «нет результата» не дописывает ничем.
 */
function noResultHold(obx5, obx13, obx9 = '') {
  const refs = [obx13 && 'OBX-13 «' + obx13 + '»', obx9 && 'OBX-9 «' + obx9 + '»'].filter(Boolean);
  return 'прибор: нет результата «' + obx5 + '»' + (refs.length ? ', ' + refs.join(', ') + ' — для сверки, в бланк не пишется' : '');
}

/**
 * LIS_VENDOR_EXACT_V1 (D6) — качественный ответ в OBX-9 химии и ИХЛА Mindray:
 * «Negative-, Positive+, weak positive+-» (Host Interface Manual CL,
 * с. 1-20; руководство BS-360E/BS-240Pro/BS-240E — то же). На экране CL те же
 * ответы — флаги REAC / NREA («реактивно» / «нереактивно»). Неопределённый
 * ответ (пограничный, «серая зона») — тоже отклонение: человек обязан
 * посмотреть. 'positive' | 'negative' | '' — не качественный ответ (пусто,
 * целое «вероятность» BS-200, «оптимизированный результат» числом).
 */
const QUAL_NEGATIVE = /^(negative|neg|non-?reactive|non reactive|nrea|отрицательн\S*)$/;
const QUAL_POSITIVE = /^(positive|pos|reactive|reac|weak(ly)? positive|weak(ly)? reactive|borderline|equivocal|gr[ae]y ?zone|indeterminate|положительн\S*|слабоположительн\S*|слабо положительн\S*|сомнительн\S*)$/;
function qualitativeOf(raw) {
  // Скобки — как в таблице ASTM того же руководства: «Negative(-)», «Weak positive(+-)».
  const s = String(raw == null ? '' : raw).toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const word = s.replace(/[\s+\-±]+$/, '');   // «positive+», «negative-», «weak positive+-»
  if (!word) return s.startsWith('-') ? 'negative' : 'positive';   // одни знаки: «-», «+», «+-», «±»
  if (QUAL_NEGATIVE.test(word)) return 'negative';
  if (QUAL_POSITIVE.test(word)) return 'positive';
  return '';
}

/**
 * LIS_VENDOR_EXACT_V1 (D9; решение владельца 2026-10-06, п. 5 —
 * analyzer-research\fix\DECISIONS.md: «предупреждения не мешают») — флаги A1000
 * по перечню самого прибора: ToolsLib.Flags программы клиники AutoLumo1000 1.0.7,
 * смысл каждого — её же подписи (en\AutoLumo1000.resources.dll, Data_Item_FLAG*).
 * Раньше в лоток уходил любой флаг, кроме ORH/ORL, а у A1000 клиники 832 из 949
 * результатов несут CEX (realtest\verify\a1000\reports\flags-decoded.txt): в
 * бланк не ложилось почти ничего, а A1000 по MSA-4 отмечал результат «Accepted».
 *   A1000_IGNORE — предупреждения о сроках и контроле качества: число пишется,
 *     флаг — по диапазону клиники. CEX «calibration curve or cut-off value is
 *     expired», PEX «kit is beyond the after-open validate period», LEX «kit is
 *     beyond the expiry date», EXS «substrate is expired», QEX «quality control
 *     lot is beyond expiry date», QCF «a quality control violates one or more
 *     Westgard rules», LQCF «result is obtained after that the QC is out of range».
 *   A1000_HIGH — ORH «above the upper limit of the measuring range», OVR «above
 *     the highest calibrator»: «>число» и «Выше»;
 *   A1000_LOW — ORL «below the lower limit of the measuring range»: «<число» и «Ниже».
 * Остальное — ошибки измерения (ERR, QNS, QNR, SUC, RLU, CLT, TRI…), флаги,
 * которых нет в перечне владельца (GRY, CRH, CRL, OVD, DRX, γ…), и незнакомые —
 * не писать: строка бланка «не пришла», проба в лотке с «флаги прибора: …».
 *
 * LIS_VENDOR_EXACT_V1 (D9, доклассификация) — остаток перечня по подписям той же
 * программы (весь перечень, 62 имени, — wire.test.js A1000_ENUM):
 *   — OVD «Result from a diluted sample» (прибор сам развёл пробу и пересчитал —
 *     число окончательное) и DRX «The result is calculated from the derivation
 *     of formula» (расчётный тест) — не мешают, как сроки: в A1000_IGNORE;
 *   — A1000_CRITICAL — CRH «above the upper limit of the critical range», CRL
 *     «below the lower limit of the critical range» (критический диапазон задаёт
 *     лаборатория на приборе): число пишется, OBX-8 — HH / LL, словарь HL7 для
 *     «паники»; ingest.js flagFromDevice делает из них 'critical';
 *   — GRY «For qualitative assays or the QC, result is within the specified gray
 *     zone» — пограничный ответ: не писать, решает человек; прочие 48 имён
 *     перечня — ошибки, сбои температуры, «повторите тест», ответы TB-IGRA — тоже;
 *     имя вне перечня — незнакомое: не писать.
 * Критический и предел измерения в одну сторону — «>» / «<» и «критический»;
 * в разные стороны (CRH с ORL, CRL с ORH/OVR, CRH с CRL) — спор: не писать.
 */
const A1000_IGNORE = new Set(['CEX', 'PEX', 'LEX', 'EXS', 'QEX', 'QCF', 'LQCF', 'OVD', 'DRX']);   // LIS_VENDOR_EXACT_V1 — + OVD, DRX
const A1000_HIGH = new Set(['ORH', 'OVR']);
const A1000_LOW = new Set(['ORL']);
/** LIS_VENDOR_EXACT_V1 (D9) — критический диапазон прибора → OBX-8 HL7 «HH» / «LL». */
const A1000_CRITICAL = new Map([['CRH', 'HH'], ['CRL', 'LL']]);

/**
 * LIS_VENDOR_EXACT_V1 (D9) — флаги A1000 → что писать. Общий для провода
 * autobio-hl7 (флаги из NTE) и входа LIS Proxy (lisproxy-autobio: флаги — поле
 * flag прокси, OBX-8 синтетического ORU) — LIS_PROXY_V1 (ревью I3).
 *   hold — не писать (ошибка измерения, незнакомый флаг, «выше» вместе с «ниже»);
 *   иначе abnormal (H / L / HH / LL или '') и value («>предел» / «<предел»).
 * @param {string[]} flags  флаги в верхнем регистре
 * @param {string[]} sent   те же, как прислал прибор (для причины в лотке)
 * @returns {{hold:string, abnormal:string, value:string}}
 */
function a1000Flags(flags, sent, value) {
  let v = value;
  const rest = flags.filter((x) => !A1000_IGNORE.has(x));
  const high = rest.some((x) => A1000_HIGH.has(x));
  const low = rest.some((x) => A1000_LOW.has(x));
  const critical = [...new Set(rest.filter((x) => A1000_CRITICAL.has(x)).map((x) => A1000_CRITICAL.get(x)))];
  const up = high || critical.includes('HH');
  const down = low || critical.includes('LL');
  const other = rest.filter((x) => !A1000_HIGH.has(x) && !A1000_LOW.has(x) && !A1000_CRITICAL.has(x));
  if (other.length || (up && down)) return { hold: 'флаги прибора: ' + sent.join('-'), abnormal: '', value: v };   // LIS_VENDOR_EXACT_V1 — как прислал прибор
  let abnormal = '';
  if (high) {
    abnormal = 'H';
    if (v && !/^[<>]/.test(v)) v = '>' + v;
  } else if (low) {
    abnormal = 'L';
    if (v && !/^[<>]/.test(v)) v = '<' + v;
  }
  if (critical.length) abnormal = critical[0];   // LIS_VENDOR_EXACT_V1 — «критический» сильнее «выше»/«ниже»
  return { hold: '', abnormal, value: v };
}

/**
 * LIS_PROXY_V1 (ревью I3) — флаги A1000 из поля flag LIS Proxy (OBX-8
 * синтетического ORU, экранированное lisproxy-form.js escapeHl7): через «-»,
 * как в NTE своего порта, или иным разделителем. «N» — «нет флага» (не флаг
 * перечня A1000). Каким видом прокси шлёт флаги AutoLumo, на программе не
 * проверено: незнакомое — не писать (D9), его видно в лотке.
 */
function proxyFlags(field) {
  const sent = String(field == null ? '' : field).split(/\\[FSTRE]\\|[-\s,;|~^&\\]+/).map((x) => x.trim()).filter((x) => x && x.toUpperCase() !== 'N');
  return { sent, flags: sent.map((x) => x.toUpperCase()) };
}

/**
 * LIS_VENDOR_EXACT_V1 (D9) — NTE, который A1000 ставит ПЕРЕД каждым OBX
 * (кодировщик программы клиники; лист A1000, §3): NTE-3 — повторения
 * «лот ~ флаги через «-» ~ имя реагента ~ код ~ срок ~ штатив ~ место».
 * Флаги (ToolsLib.Flags): ORH — выше предела измерения, ORL — ниже; ERR,
 * QNS, CEX, PEX и прочие — с результатом что-то не так. В OBX-8 A1000 флагов
 * не пишет — только здесь.
 */
function autobioNote(nte, fieldSep, repSep) {
  if (!nte) return { flags: [], sent: [], reagent: '' };
  const reps = String(nte.split(fieldSep)[3] == null ? '' : nte.split(fieldSep)[3]).split(repSep);
  // LIS_VENDOR_EXACT_V1 — sent: флаги как их прислал прибор — для причины в лотке
  // (лаборант сверяет с экраном A1000; «γPO+» в верхнем регистре стал бы «ΓPO+»);
  // flags — те же в верхнем регистре, для классов.
  const sent = String(reps[1] == null ? '' : reps[1]).split('-').map((x) => x.trim()).filter(Boolean);
  return {
    flags: sent.map((x) => x.toUpperCase()),
    sent,
    reagent: String(reps[2] == null ? '' : reps[2]).trim(),
  };
}

/**
 * Строки теста и первый OBR по проводу (раздел 4). Без исключений: мусор даёт
 * пустой результат. Наружу — строки в сегодняшнем виде (valueType, code, name,
 * system, codeRaw, value, unit, range, abnormal, status) и новое поле label.
 *
 *   code, name — то, что сравнивает match.js (компонент 1 ИЛИ 2). Пустое name —
 *                второй проход по имени ничего не находит;
 *   label      — ТОЛЬКО показ (журнал, «Поле анализатора», лента), не
 *                сравнивается никогда.
 *
 * | провод             | код (сравнивается)   | подпись (показ)     | значение                          |
 * | default            | OBX-3.1, затем 3.2   | —                   | OBX-5 целиком                     |
 * | forwarder          | OBX-3.1, затем 3.2   | OBX-4               | OBX-5 целиком                     |
 * | mindray-chem       | OBX-3.1 — номер теста| OBX-4 — имя теста   | OBX-5 без хвостовых нулей         |
 * | autobio-hl7        | OBX-4.1, иначе 3.1   | NTE-3.3, OBX-3.2/3.1| OBX-5, 1-е повторение, компонент 2|
 * | mindray-hematology | OBX-3.1, затем 3.2   | —                   | OBX-5 целиком                     |
 * Единица — OBX-6.1, референс — OBX-7, флаг — OBX-8 (1-е повторение), статус —
 * OBX-11 (пусто = F решает match.js), у всех одинаково.
 *
 * LIS_VENDOR_EXACT_V1 — hold: причина НЕ писать строку (match.js: строка бланка
 * «не пришла» с этой причиной, лоток). Есть только у таких строк: «нет
 * результата» Mindray (D5), флаги прибора A1000 — ошибка измерения или
 * незнакомый флаг (D9; предупреждения о сроках и контроле, ORH/OVR/ORL — не
 * hold: решение владельца 2026-10-06, п. 5; LIS_VENDOR_EXACT_V1 — и OVD, DRX,
 * CRH/CRL — не hold, у CRH/CRL abnormal HH/LL; GRY — hold).
 * Десятичная запятая у mindray-chem и autobio-hl7 — точка (D0); у A1000
 * простое число — NM, флаги ORH/ORL — в abnormal (H/L) и знак «>»/«<» (D9).
 * qualitative (D6) — качественный ответ OBX-9 у mindray-chem: 'positive' |
 * 'negative'; есть только у таких строк. Простое число у mindray-chem — NM
 * (индекс COI качественного теста CL). LIS_VENDOR_EXACT_V1 (D6, ревью) — у
 * не-числовой строки без ответа в OBX-9 — по тексту OBX-5 («+», «+-», «-» BS-200).
 *
 * obr — первый OBR: { placer: OBR-2, filler: OBR-3 }, компонент 1 без пробелов
 * по краям; null — OBR нет.
 * obrs (LIS_REAL_ANALYZERS_V1, ревью R1, п. 1) — ВСЕ OBR сообщения: поля OBR-2 и
 * OBR-3 целиком (без пробелов по краям) и разделитель компонентов отправителя —
 * для pickMessageSample: номер пробы ищется у каждого OBR и во всех компонентах.
 *
 * @returns {{obr: {placer:string, filler:string}|null, obrs: Array<{placer:string, filler:string, compSep:string}>, observations: object[]}}
 */
export function readResult(raw, wire = 'default') {
  const w = known(wire);
  const segments = String(raw == null ? '' : raw).split(SEG).filter((s) => s.trim() !== '');
  if (!segments.length || !segments[0].startsWith('MSH')) return { obr: null, obrs: [], observations: [] };
  const msh = segments[0];
  const fieldSep = msh[3] || '|';
  const encEnd = msh.indexOf(fieldSep, 4);
  const enc = encEnd === -1 ? '^~\\&' : msh.slice(4, encEnd);
  const compSep = enc[0] || '^';
  const repSep = enc[1] || '~';
  const comp = (v) => String(v == null ? '' : v).split(compSep);
  const t = (v) => String(v == null ? '' : v).trim();

  let obr = null;
  const obrs = [];
  const observations = [];
  let nte = '';   // LIS_VENDOR_EXACT_V1 (D9) — NTE перед очередным OBX (A1000)
  for (const seg of segments.slice(1)) {
    const f = seg.split(fieldSep);
    if (seg.startsWith('NTE')) {
      nte = seg;
    } else if (seg.startsWith('OBR')) {
      // Первый OBR задаёт пробу, как в parseMessage.
      if (!obr) obr = { placer: comp(f[2])[0].trim(), filler: comp(f[3])[0].trim() };
      obrs.push({ placer: t(f[2]), filler: t(f[3]), compSep });
    } else if (seg.startsWith('OBX')) {
      const obx3 = comp(f[3]);
      const o = {
        valueType: t(f[2]),
        code: t(obx3[0]),
        name: t(obx3[1]),
        system: t(obx3[2]),
        codeRaw: t(f[3]),
        value: t(f[5]),
        unit: comp(f[6])[0].trim(),
        range: t(f[7]),
        abnormal: String(f[8] == null ? '' : f[8]).split(repSep)[0].trim(),
        status: t(f[11]),
        label: '',
      };
      if (w === 'forwarder' || w === 'lisproxy') {   // lisproxy: LIS_PROXY_V1 — гематология и прибор без модели — как переадресатель
        o.label = t(f[4]);
      } else if (w === 'lisproxy-chem') {
        // LIS_PROXY_V1 (ревью I2) — BS-200 (химия Mindray) через LIS Proxy: значение
        // и ответ — как у своего порта (mindray-chem ниже): хвостовые нули
        // срезаются, запятая — точка, качественный ответ «+» / «Positive» / «-»
        // — по тексту не-числовой строки (D6; OBX-9 прокси не передаёт), простое
        // число — NM. Код — OBX-3 одним компонентом (вход кладёт его сам).
        o.label = t(f[4]);
        o.name = '';
        o.value = trimZeros(decimalPoint(o.value));
        const q = o.valueType.toUpperCase() !== 'NM' ? qualitativeOf(o.value) : '';
        if (q) o.qualitative = q;
        if (PLAIN_NUMBER.test(o.value)) o.valueType = 'NM';
      } else if (w === 'lisproxy-autobio') {
        // LIS_PROXY_V1 (ревью I3) — AutoLumo A1000 через LIS Proxy: значение —
        // концентрация (прокси шлёт её одну), флаги прибора — поле flag прокси
        // (OBX-8): правила D9 те же, что у провода autobio-hl7 (a1000Flags).
        o.label = t(f[4]);
        o.name = '';
        const pf = proxyFlags(f[8]);
        const a = a1000Flags(pf.flags, pf.sent, decimalPoint(o.value));
        o.abnormal = a.abnormal;
        if (a.hold) o.hold = a.hold;
        o.value = a.value;
        if (PLAIN_NUMBER.test(o.value)) o.valueType = 'NM';
      } else if (w === 'mindray-chem') {
        // Номер теста задаёт лаборатория на приборе (ItemID.ini, с. 22);
        // OBX-4 — подпись, которую оператор правит как хочет: «functions as a
        // note and must not be analyzed» (с. 24).
        o.name = '';
        o.label = t(f[4]);
        o.value = trimZeros(decimalPoint(o.value));   // LIS_VENDOR_EXACT_V1 (D0) — «5,000000» → «5»
        // LIS_VENDOR_EXACT_V1 (D6) — качественный ответ прибора — OBX-9: у CL-900i
        // OBX-8 «Fixed as N» у КАЖДОГО результата, и положительный HBsAg/HCV/HIV
        // выходил «Норма». Флаг по ответу ставит ingest.js (resultFlag).
        // LIS_VENDOR_EXACT_V1 (D6, ревью) — а BS-200 пишет ответ в сам OBX-5:
        // «test result (concentration, negative(-), positive(+), weak
        // positive(+-), etc)» (HIM v5.0, с. 18), его OBX-9 — целое «вероятность».
        // Текст OBX-5 читается только у не-числовой строки (OBX-2 не NM) и
        // только если OBX-9 ответа не дал; число ответом не бывает (qualitativeOf).
        const q = qualitativeOf(f[9]) || (o.valueType.toUpperCase() !== 'NM' ? qualitativeOf(o.value) : '');
        if (q) o.qualitative = q;
        // Индекс COI качественного теста (OBX-2 = ST) — число: numeric_value
        // есть, и диапазон клиники работает. Текст («+», «-», «+-») — как был.
        if (PLAIN_NUMBER.test(o.value)) o.valueType = 'NM';
      } else if (w === 'autobio-hl7') {
        // AutoLumoHL7.cs (LiveMachine), строки 129–163: код — OBX-4, значение —
        // компонент 2 OBX-5; компонент 1 — RLU, сигнал прибора.
        // LIS_VENDOR_EXACT_V1 — сверено с кодировщиком самой программы клиники
        // (AutoLumo1000.exe 1.0.7; лист A1000, §3): «по тесту» OBX-3 = OBX-4 =
        // код теста, OBX-1 — внутренний номер заявки; «по пробе» OBX-4 пуст, и
        // код — OBX-3.1 (D9). OBX-2 у A1000 всегда CE.
        const obx4 = comp(f[4]);
        o.code = t(obx4[0]) || t(obx3[0]);
        o.name = '';
        o.system = '';
        o.codeRaw = t(f[4]) || t(f[3]);
        const note = autobioNote(nte, fieldSep, repSep);
        o.label = note.reagent || t(obx3[1]) || t(obx3[0]);   // LIS_VENDOR_EXACT_V1 — имя реагента из NTE («AFP»)
        let v = decimalPoint(t(comp(String(f[5] == null ? '' : f[5]).split(repSep)[0])[1]));
        // LIS_VENDOR_EXACT_V1 (D9) — флаги прибора. За пределом измерения
        // прибор шлёт сам предел простым числом: ORH — «выше» и знак «>»,
        // ORL — «ниже» и «<» (если знака ещё нет).
        // LIS_VENDOR_EXACT_V1 (D9; решение владельца 2026-10-06, п. 5) —
        // предупреждения о сроках и контроле (A1000_IGNORE: CEX, PEX, LEX…) не
        // мешают; OVR — как ORH; не писать (строка бланка «не пришла», проба в
        // лотке) — только ошибку измерения, незнакомый флаг и спор «выше» с «ниже».
        // LIS_VENDOR_EXACT_V1 (D9, доклассификация) — и критический диапазон
        // (CRH/CRL → HH/LL); OVD и DRX — в A1000_IGNORE; спор направлений
        // (выше и ниже разом, в том числе критического) — не писать.
        const a = a1000Flags(note.flags, note.sent, v);   // LIS_PROXY_V1 (ревью I3) — те же правила у входа LIS Proxy
        if (a.hold) o.hold = a.hold;
        else if (a.abnormal) o.abnormal = a.abnormal;
        v = a.value;
        o.value = v;
        // LIS_VENDOR_EXACT_V1 (D0) — простое число — число (NM): без этого у
        // A1000 не было numeric_value, диапазон клиники не срабатывал, и флаг
        // выходил «Норма» при любом значении. «>x» и «<x» остаются текстом.
        if (PLAIN_NUMBER.test(v)) o.valueType = 'NM';
      }
      // LIS_VENDOR_EXACT_V1 (D5) — «нет результата»: строка помечена hold, и
      // match.js её не пишет — строка бланка «не пришла» с этой причиной (лоток).
      if (!o.hold && isNoResult(o.value)) o.hold = noResultHold(t(f[5]), t(f[13]), w === 'mindray-chem' ? t(f[9]) : '');
      observations.push(o);
      nte = '';   // LIS_VENDOR_EXACT_V1 (D9) — NTE относится только к своему OBX
    }
  }
  return { obr, obrs, observations };
}

/**
 * Наша этикетка: «LAB-000123» — 'LAB-' и не меньше 6 цифр (lab-doc.js
 * labAccession: 'LAB-' + padStart(6)), регистр не важен.
 *
 * LIS_REAL_ANALYZERS_V1 (ревью R1, п. 8) — раньше здесь была проверка
 * parseSampleId (/^lab[-_ ]?\d+$/i): «LAB2», «lab 2», «lab_2», «LAB-123»
 * считались нашей этикеткой и обходили правило голых цифр (открытый заказ
 * последних 7 дней). Easy-Med так не печатает — это не наше.
 */
/**
 * LIS_VENDOR_EXACT_V1 — сколько цифр в номере на этикетке: номер заказа,
 * дополненный нулями до 6 (lab-doc.js labAccession). Та же граница у «номера с
 * этикетки» без LAB- (решение владельца 2026-10-06, п. 4; ingest.js) и у
 * контроля A1000 (autobioQc).
 */
export const LABEL_DIGITS = 6;
const LAB_RE = new RegExp('^lab-(\\d{' + LABEL_DIGITS + ',})$', 'i');   // LIS_VENDOR_EXACT_V1 — было /^lab-(\d{6,})$/i
const labNumber = (v) => { const m = LAB_RE.exec(String(v == null ? '' : v).trim()); return m ? parseInt(m[1], 10) : null; };
const DIGITS = /^\d+$/;

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R1, п. 2) — что несёт поле OBR целиком, по
 * компонентам. Раньше читался только компонент 1: OBR-3 = «2^LAB-000123»
 * читалось как голое «2» и ложилось в открытый свежий заказ № 2.
 *   lab      — этикетка LAB- в ЛЮБОМ компоненте (одна и та же — хоть дважды);
 *   conflict — в компонентах РАЗНЫЕ этикетки LAB-;
 *   bare     — поле ЦЕЛИКОМ из цифр (один компонент), как читал parseMessage;
 *   foreign  — что-то есть, но это не этикетка и не голые цифры («2^15», «15^»,
 *              «QC1», «lab_000123»): номера нет;
 *   empty    — поле пусто.
 * Этикетка рядом с голыми цифрами в другом компоненте («2^LAB-000123») —
 * этикетка: LAB- бьёт всё и внутри поля, как между полями OBR-2 и OBR-3.
 */
function fieldInfo(raw, compSep = '^') {
  const whole = String(raw == null ? '' : raw).trim();
  if (!whole) return { kind: 'empty', whole };
  const comps = whole.split(compSep).map((c) => c.trim()).filter(Boolean);
  const labs = comps.filter((c) => labNumber(c) != null);
  const numbers = [...new Set(labs.map(labNumber))];
  if (numbers.length > 1) return { kind: 'conflict', whole };
  if (numbers.length === 1) return { kind: 'lab', whole, value: labs[0], number: numbers[0] };
  if (DIGITS.test(whole)) return { kind: 'bare', whole, value: whole, number: parseInt(whole, 10) };
  return { kind: 'foreign', whole };
}

/**
 * Номер пробы одного OBR по проводу (раздел 1). Одна чистая функция.
 *
 *   1. LAB- бьёт всё: этикетка LAB- в OBR-2 или OBR-3 (кроме полей «никогда»),
 *      в любом компоненте поля, — наша пробирка, в каком бы поле прибор её ни
 *      передал.
 *   2. Два РАЗНЫХ LAB- (в двух полях или в компонентах одного) — номера нет
 *      (conflict); в sample_id — что пришло.
 *   3. Иначе основное поле провода, а если оно пусто — запасное: голые цифры —
 *      только поле целиком из цифр; другое непустое (foreign) — номера нет.
 *   4. Иначе номера нет.
 * Решать, примет ли заказ голые цифры (правило «открытый недавний заказ»), —
 * дело приёма (ingest.js): здесь только выбор поля.
 *
 * @param {{placer:string, filler:string, compSep?:string}|null} obr  поля целиком
 *        (readResult().obrs) или, по-старому, компонент 1 (readResult().obr)
 * @returns {{sampleId:string, value:string, field:''|'OBR-2'|'OBR-3', lab:boolean, conflict:boolean, why?:string, foreign?:boolean}}
 *   sampleId — что записать в lab_device_messages.sample_id;
 *   value    — выбранный номер ('' — номера нет);
 *   lab      — выбран по правилу LAB-;
 *   why      — у спора в компонентах одного поля: 'components';
 *   foreign  — в поле не этикетка и не голые цифры (ревью R1, пп. 2 и 8).
 */
export function pickSampleId(obr, wire = 'default') {
  const rule = SAMPLE_FIELDS[known(wire)];
  const none = { sampleId: '', value: '', field: '', lab: false, conflict: false };
  if (!obr) return none;
  const readable = ['placer', 'filler'].filter((k) => !rule.never.includes(k));
  const info = Object.fromEntries(readable.map((k) => [k, fieldInfo(obr[k], obr.compSep || '^')]));

  const torn = readable.find((k) => info[k].kind === 'conflict');
  if (torn) return { sampleId: info[torn].whole, value: '', field: '', lab: true, conflict: true, why: 'components' };
  const labs = readable.filter((k) => info[k].kind === 'lab');
  if (labs.length === 2 && info[labs[0]].number !== info[labs[1]].number) {
    return { sampleId: labs.map((k) => info[k].value).join(' / '), value: '', field: '', lab: true, conflict: true };
  }
  if (labs.length) {
    const k = labs.includes(rule.primary) ? rule.primary : labs[0];
    return { sampleId: info[k].value, value: info[k].value, field: FIELD_NAME[k], lab: true, conflict: false };
  }
  for (const k of [rule.primary, rule.fallback]) {
    if (!k || info[k].kind === 'empty') continue;
    if (info[k].kind === 'bare') return { sampleId: info[k].value, value: info[k].value, field: FIELD_NAME[k], lab: false, conflict: false };
    return { sampleId: info[k].whole, value: '', field: FIELD_NAME[k], lab: false, conflict: false, foreign: true };
  }
  return none;
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R1, пп. 1 и 5) — номер пробы сообщения по ВСЕМ
 * OBR (readResult().obrs). Раньше номер брался у первого OBR, а строки OBX — у
 * всех: «OBR|1||LAB-000123 …, OBR|2||LAB-000124 …» клал значения пробы 124 в
 * бланк 123.
 *   — номер каждого OBR — по тому же правилу провода (pickSampleId);
 *   — спор внутри OBR — спор сообщения;
 *   — у разных OBR РАЗНЫЕ номера — номера нет (conflict, why: 'obrs'), ничего не
 *     пишется; в sample_id — все номера через « / »;
 *   — иначе первый НЕПУСТОЙ номер по OBR (до E5 parseMessage брал первый
 *     непустой OBR-3 — пустой первый OBR не делает пробу ничьей); тот же номер,
 *     записанный этикеткой и голыми цифрами, — не спор, этикетка бьёт.
 */
export function pickMessageSample(obrs, wire = 'default') {
  const none = { sampleId: '', value: '', field: '', lab: false, conflict: false };
  const picks = (Array.isArray(obrs) ? obrs : []).map((o) => pickSampleId(o, wire));
  const torn = picks.find((p) => p.conflict);
  if (torn) return torn;
  const named = picks.filter((p) => p.sampleId);
  if (!named.length) return none;
  const keyOf = (p) => (p.value ? 'n' + parseInt(String(p.value).replace(/^lab-/i, ''), 10) : 's' + p.sampleId);
  const keys = [...new Set(named.map(keyOf))];
  if (keys.length > 1) {
    return { sampleId: [...new Set(named.map((p) => p.sampleId))].join(' / '), value: '', field: '', lab: named.some((p) => p.lab), conflict: true, why: 'obrs' };
  }
  return named.find((p) => p.lab) || named[0];
}
