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
// (отказ без повтора), AE 207 — сорвалась запись (прибор пришлёт снова).
import { readEnvelope, wireFor } from './wire.js';   // wireFor: LIS_REAL_ANALYZERS_V1, ревью R1, пп. 7 и 11
import { buildAck, buildQueryReply, ACK_INTERNAL, mshOf } from './hl7.js';
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

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} text  сырой текст сообщения
 * @param {{peer?:string, deviceId?:number|null}} [o]
 * @returns {{code:'AA'|'AE'|'AR', kind:string, reply:string}}
 *   reply — готовый ответ прибору (без кадра MLLP); mllp.js шлёт его как есть.
 */
export function receiveMessage(db, text, { peer = '', deviceId = null } = {}) {
  // LIS_REAL_ANALYZERS_V1 (ревью R1, пп. 7 и 11) — провод: профиль строки
  // прибора и то, как сообщение называет себя (wire.js wireFor). Калибровка и
  // контроль по MSH-16 — только у провода, объявившего это соглашение (химия
  // Mindray, Autobio по сети); приём читает тем же проводом.
  const device = deviceId ? db.prepare('SELECT profile FROM lab_devices WHERE id = ?').get(deviceId) : null;
  const head = mshOf(text);
  const wire = wireFor({ profile: device ? getProfile(device.profile) : null, facility: head.facility, app: head.app });
  const env = readEnvelope(text, wire);

  if (env.service) {
    recordMessage(db, {
      deviceId, peer, raw: text,
      sampleId: env.kind === 'query' ? env.queryBarcode : '',
      visitServiceId: null, status: 'unmatched', detail: serviceDetail(env),
      kind: env.kind, resolved: true,
    });
    touchDevice(db, deviceId);
    return { code: 'AA', kind: env.kind, reply: env.kind === 'query' ? buildQueryReply(env) : buildAck(env, 'AA') };
  }

  // Проба пациента, неразобранное и неподдержанное — прежний приём: он пишет
  // строку лотка (rejected — у мусора и неподдержанного типа) и решает AA/AE.
  const code = ingestMessage(db, text, peer, deviceId, { wire });
  if (env.kind === 'unsupported') return { code: 'AR', kind: 'result', reply: buildAck(env, 'AR') };
  if (env.kind === 'unparsed') return { code: 'AE', kind: 'result', reply: buildAck(env, 'AE') };
  // Заголовок разобран как ORU^R01, значит AE приёма — сорвавшаяся запись.
  if (code !== 'AA') return { code: 'AE', kind: 'result', reply: buildAck(env, 'AE', ACK_INTERNAL) };
  return { code: 'AA', kind: 'result', reply: buildAck(env, 'AA') };
}
