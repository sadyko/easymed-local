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

/** MSH-4 нашего переадресателя (analyzers/forwarder/hl7-oru.js). */
export const FORWARDER_FACILITY = 'LabPC';

/**
 * Номер пробы по проводу (раздел 1): основное поле, запасное (только если
 * основное пусто) и поля, которые не читаются никогда.
 */
const SAMPLE_FIELDS = Object.freeze({
  'default':            { primary: 'filler', fallback: null,     never: [] },
  'forwarder':          { primary: 'filler', fallback: null,     never: [] },
  'mindray-chem':       { primary: 'placer', fallback: null,     never: ['filler'] },
  'autobio-hl7':        { primary: 'placer', fallback: null,     never: [] },
  'mindray-hematology': { primary: 'filler', fallback: 'placer', never: [] },
});
const FIELD_NAME = { placer: 'OBR-2', filler: 'OBR-3' };

const known = (wire) => (WIRES.includes(wire) ? wire : 'default');

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R1, п. 11) — какой провод безопаснее, когда
 * профиль строки и само сообщение называют разные: меньше полей, откуда берутся
 * голые цифры. mindray-chem не читает OBR-3 никогда (место в штативе BS-200),
 * autobio-hl7 берёт голые цифры только из OBR-2, mindray-hematology — из OBR-3
 * и запасного OBR-2.
 */
const SAFER = ['default', 'forwarder', 'mindray-hematology', 'autobio-hl7', 'mindray-chem'];

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
export function wireFor({ profile = null, facility = '', app = '' } = {}) {
  if (String(facility == null ? '' : facility).trim().toLowerCase() === FORWARDER_FACILITY.toLowerCase()) return 'forwarder';
  const own = guessProfile({ app, facility });
  const fromRow = known(profile && profile.wire);
  const fromMessage = known(own && own.wire);
  if (fromRow === fromMessage || fromMessage === 'default') return fromRow;
  if (fromRow === 'default') return fromMessage;
  return SAFER.indexOf(fromRow) >= SAFER.indexOf(fromMessage) ? fromRow : fromMessage;
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R1, п. 7) — провода, у которых MSH-16 = 1/2
 * значит калибровку и контроль качества: химия Mindray (руководство BS-200,
 * с. 8: «0- Sample result; 1- Calibration result; 2- QC result») и Autobio по
 * сети (тот же заголовок «…|2.3.1||||0||ASCII|||», «A2000 plus HL7 protocol
 * V0.02»). BS-240 и CL-900i — на проводе default: руководства на их HL7 у нас
 * нет, и прятать пробу пациента в «служебные» по догадке нельзя; их контроль,
 * если придёт, ляжет в «Необработанные», как до E4, и его отклонит человек.
 */
const VENDOR_KIND_WIRES = new Set(['mindray-chem', 'autobio-hl7']);

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
 *                   MSH-16 вида не меняет: проба пациента не прячется в служебные;
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
    env.kind = vendor && msh.ackType === '2' ? 'qc' : vendor && msh.ackType === '1' ? 'calibration' : 'result';
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
function trimZeros(v) {
  const m = /^([-+]?\d+)\.(\d*?)0*$/.exec(v);
  if (!m) return v;
  const out = m[2] ? m[1] + '.' + m[2] : m[1];
  return /^[-+]?0$/.test(out) ? '0' : out;
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
 * | autobio-hl7        | OBX-4.1 — код позиции| OBX-3.2, иначе 3.1  | OBX-5, 1-е повторение, компонент 2|
 * | mindray-hematology | OBX-3.1, затем 3.2   | —                   | OBX-5 целиком                     |
 * Единица — OBX-6.1, референс — OBX-7, флаг — OBX-8 (1-е повторение), статус —
 * OBX-11 (пусто = F решает match.js), у всех одинаково.
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
  for (const seg of segments.slice(1)) {
    const f = seg.split(fieldSep);
    if (seg.startsWith('OBR')) {
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
      if (w === 'forwarder') {
        o.label = t(f[4]);
      } else if (w === 'mindray-chem') {
        // Номер теста задаёт лаборатория на приборе (ItemID.ini, с. 22);
        // OBX-4 — подпись, которую оператор правит как хочет: «functions as a
        // note and must not be analyzed» (с. 24).
        o.name = '';
        o.label = t(f[4]);
        o.value = trimZeros(o.value);
      } else if (w === 'autobio-hl7') {
        // AutoLumoHL7.cs (LiveMachine), строки 129–163: код — OBX-4, значение —
        // компонент 2 OBX-5; компонент 1 — RLU, сигнал прибора. OBX-3 у Autobio
        // может быть номером заявки на тест, своим у каждого прогона, — не
        // сравнивается. Это ВЕРОЯТНО, а не документ (один драйвер, A2000 Plus):
        // первая настоящая проба сверяется построчно.
        const obx4 = comp(f[4]);
        o.code = t(obx4[0]);
        o.name = '';
        o.system = '';
        o.codeRaw = t(f[4]);
        o.label = t(obx3[1]) || t(obx3[0]);
        o.value = t(comp(String(f[5] == null ? '' : f[5]).split(repSep)[0])[1]);
      }
      observations.push(o);
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
const LAB_RE = /^lab-(\d{6,})$/i;
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
