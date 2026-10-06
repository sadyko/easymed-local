// LIS_REAL_ANALYZERS_V1_SERVICE — один вход для сообщения прибора: вид по
// заголовку → приём пробы (ingest.js) или служебная строка, и ответ прибору
// (docs/specs/2026-10-01-lis-real-analyzers-design.md, разделы 5–7).
//
// Служебное сообщение — контроль качества (MSH-16 = 2), калибровка (MSH-16 =
// 1) или запрос рабочего списка (QRY^Q02, QRY^Q01, ORM^O01):
//   — сохраняется целиком (инвариант 2), lab_device_messages.kind = вид;
//   — status = 'unmatched', resolved_at — сразу, visit_service_id — NULL всегда;
//   — номер пробы не ищется вовсе: у QC BS-200 в OBR-2 стоит НОМЕР ТЕСТА
//     (руководство, с. 16), и «1» легло бы в заказ № 1 чужого пациента;
//   — в бланк не идёт и в лоток не попадает (экран берёт только строки без
//     resolved_at);
//   — прибор отмечается «на связи»: это разобранное сообщение анализатора;
//   — ответ — ACK^R01 AA с MSH-16 эхом или ответ на запрос «заказов нет».
// Проба пациента идёт в тот же приём, что и прежде; здесь решается только
// ответ: AE 100 — не разобрано, AR 200 — известный, но не поддержанный тип
// (отказ без повтора), AE 207 — сорвалась запись (прибор пришлёт снова); у
// химии Mindray — AR 206 (LIS_VENDOR_EXACT_V1, hl7.js internalAck).
//
// LIS_VENDOR_EXACT_V1 — и ВИД ответа (replyStyle ниже): вид руководства Mindray
// или короткий вид гематологии (hl7.js LAYOUT_LONG / LAYOUT_SHORT); у A1000 —
// MSA-4, по которому он отмечает результат «Accepted».
import { readEnvelope, wireDecision } from './wire.js';   // wireDecision: LIS_VENDOR_EXACT_V1 — провод и для вида ответа
import { buildAck, buildQueryReply, mshOf } from './hl7.js';
import { internalAck, internalCode, firstField, LAYOUT_LONG, LAYOUT_SHORT } from './hl7.js';   // LIS_VENDOR_EXACT_V1
import { guessProfile } from './discover.js';   // LIS_VENDOR_EXACT_V1 — как сообщение назвало себя
import { getProfile } from './profiles/index.js';
import { ingestMessage } from './ingest.js';
import { recordMessage, touchDevice } from './inbox.js';

function serviceDetail(env) {
  if (env.kind === 'qc') return 'контроль качества — в бланки и «Необработанные» не идёт';
  if (env.kind === 'calibration') return 'калибровка — в бланки и «Необработанные» не идёт';
  if (env.queryCancel) return 'отмена запроса рабочего списка (' + env.type + ') — ответ «заказов нет»';
  return 'запрос рабочего списка (' + env.type + ')'
    + (env.queryBarcode ? ' по пробирке ' + env.queryBarcode : '')
    + ' — Easy-Med заказов не отдаёт, ответ «заказов нет»; запрос лучше выключить в настройках LIS прибора';
}

/** LIS_VENDOR_EXACT_V1 — гематология: провод mindray-hematology или вид профиля hematology. */
const isHeme = (p) => !!p && (p.wire === 'mindray-hematology' || p.kind === 'hematology');

/**
 * LIS_VENDOR_EXACT_V1 — каким видом отвечать прибору (hl7.js LAYOUT_*).
 * Чистое решение, без базы:
 *   — переадресатор (MSH-4 = LabPC) — длинный: ответ читает наш переадресатор
 *     (forwarder/deliver.js ищет «MSA|AA»), а не прибор;
 *   — гематология Mindray — короткий, сегодняшний (OM13 pdf 485): провод
 *     mindray-hematology или профиль вида hematology (BC-20, BC-5300, BC-780,
 *     BC-2800, BC-3000 Plus). Чей профиль: сообщения, если оно назвало себя
 *     (MSH-3/4, discover.js guessProfile), иначе строки прибора — отвечать надо
 *     тому, кто на самом деле говорит;
 *   — всё прочее — длинный, вид руководства: химия и ИХЛА Mindray, A1000 и
 *     НЕЗНАКОМЫЙ прибор. Первым может заговорить и CL-900i (MSH короче 19
 *     полей — отказ и блок связи), и BS-200 (BS200.exe читает кусок 27 —
 *     MSA-6); декодер A1000 длинный вид принимает (autobio-autolumo-a1000.
 *     settle.md, табл. c); у BS-240 — тот же вид (mindray-bs-240.md M15).
 * wire — провод (wire.js wireDecision): по нему приём читает вид сообщения, у
 * A1000 ставится MSA-4, а отказ по нашей вине у химии — AR (hl7.js internalAck).
 * Им же пользуется mllp.js для ответов, которые строит сам (приём бросил,
 * переросшее), — через index.js.
 * @param {{profile?:object|null, app?:string, facility?:string}} [o]
 * @returns {{layout:string, wire:string}}
 */
export function replyStyle({ profile = null, app = '', facility = '' } = {}) {
  const { wire } = wireDecision({ profile, facility, app });
  if (wire === 'forwarder') return { layout: LAYOUT_LONG, wire };
  const own = guessProfile({ app, facility });
  return { layout: isHeme(own || profile) ? LAYOUT_SHORT : LAYOUT_LONG, wire };
}

/**
 * LIS_VENDOR_EXACT_V1 — MSA-4 ответа A1000 (провод autobio-hl7): OBX-1
 * (TestRequest_ID), когда MSH-10 = 5 (по тесту), OBR-3 (внутренний номер
 * пробы), когда MSH-10 = 7 (по пробе); иначе пусто. Без него результат на A1000
 * не становится «Accepted», и лаборатория не видит, какие дошли
 * (autobio-autolumo-a1000.settle.md, табл. c, R1 и R5; M18).
 */
function autobioRef(text, env) {
  if (env.controlId === '5') return firstField(text, 'OBX', 1);
  if (env.controlId === '7') return firstField(text, 'OBR', 3);
  return '';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} text  сырой текст сообщения
 * @param {{peer?:string, deviceId?:number|null}} [o]
 * @returns {{code:'AA'|'AE'|'AR', kind:string, reply:string}}
 *   reply — готовый ответ прибору (без кадра MLLP); mllp.js шлёт его как есть.
 *   code — MSA-1 этого ответа.
 */
export function receiveMessage(db, text, { peer = '', deviceId = null } = {}) {
  // LIS_REAL_ANALYZERS_V1 (ревью R1, пп. 7 и 11) — провод: профиль строки
  // прибора и то, как сообщение называет себя (wire.js wireFor). Калибровка и
  // контроль по MSH-16 — только у провода, объявившего это соглашение (химия
  // Mindray, Autobio по сети); приём читает тем же проводом.
  // LIS_VENDOR_EXACT_V1 — и вид ответа (replyStyle): провод тот же.
  const device = deviceId ? db.prepare('SELECT profile FROM lab_devices WHERE id = ?').get(deviceId) : null;
  const head = mshOf(text);
  const style = replyStyle({ profile: device ? getProfile(device.profile) : null, facility: head.facility, app: head.app });
  const { wire, layout } = style;
  const env = readEnvelope(text, wire);

  if (env.service) {
    recordMessage(db, {
      deviceId, peer, raw: text,
      sampleId: env.kind === 'query' ? env.queryBarcode : '',
      visitServiceId: null, status: 'unmatched', detail: serviceDetail(env),
      kind: env.kind, resolved: true,
    });
    touchDevice(db, deviceId);
    if (env.kind !== 'query') return { code: 'AA', kind: env.kind, reply: buildAck(env, 'AA', { layout }) };
    // LIS_VENDOR_EXACT_V1 — ORM^O01 гематологии: ORR^O02 с MSA|AR «заказов нет».
    return { code: env.type === 'ORM^O01' ? 'AR' : 'AA', kind: env.kind, reply: buildQueryReply(env, { layout }) };
  }

  // Проба пациента, неразобранное и неподдержанное — прежний приём: он пишет
  // строку лотка (rejected — у мусора и неподдержанного типа) и решает AA/AE.
  // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 12) — провод приём решает сам тем же
  // wireDecision: при споре профиля и сообщения он кладёт пробу в лоток.
  const code = ingestMessage(db, text, peer, deviceId);
  if (env.kind === 'unsupported') return { code: 'AR', kind: 'result', reply: buildAck(env, 'AR', { layout }) };
  if (env.kind === 'unparsed') return { code: 'AE', kind: 'result', reply: buildAck(env, 'AE', { layout }) };
  // Заголовок разобран как ORU^R01, значит AE приёма — сорвавшаяся запись.
  // LIS_VENDOR_EXACT_V1 — у химии Mindray AR 206, у прочих AE 207 (hl7.js).
  if (code !== 'AA') return { code: internalCode(style), kind: 'result', reply: internalAck(env, style, { write: true }) };
  const ref = wire === 'autobio-hl7' ? autobioRef(text, env) : '';   // LIS_VENDOR_EXACT_V1 — MSA-4 у A1000
  return { code: 'AA', kind: 'result', reply: buildAck(env, 'AA', { layout, ref }) };
}
