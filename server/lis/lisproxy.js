// LIS_PROXY_V1 — запрос LIS Proxy: журнал, прибор, результат, рабочий список
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, разделы 2–6).
//
// Прокси шлёт каждое значение ОДИН раз и не повторяет, а анализатору уже
// ответил «принято». Поэтому: сначала строка журнала (тело как пришло —
// source_body), потом всё остальное дописывает ЭТУ ЖЕ строку, и ответ — 200 на
// любой исход (маршрут server/routes/lisproxy.js). Результат идёт в прежний
// приём (receive.js → ingest.js) синтетическим ORU^R01 (lisproxy-form.js).
import { recordMessage, touchDevice } from './inbox.js';
import { receiveMessage } from './receive.js';
import { ensureProxyDevice } from './discover.js';
import { buildOru, junkReason, normaliseProxyBarcode, PROXY_QUIET_PREFIX } from './lisproxy-form.js';

/** Журнал строки, пока запрос не разобран: если процесс упал посреди — строка так и скажет. */
export const JOURNAL_PENDING = 'LIS Proxy: запрос сохранён, разбор не завершён';
/** Модель, у которой прокси обрезает номер до 8 знаков (Р10). */
export const AUTOLUMO = 'autobio-autolumo-a1000';

/**
 * Ответ на apiResultSave — на КАЖДЫЙ исход (принято, лоток, справка): ровно
 * «Ok», с большой O и малой k. Руководство поставщика для разработчиков ЛИС
 * (LIS-API.md, §2 и §5): на любой другой текст lisproxy пишет ошибку и НЕ ШЛЁТ
 * остальные тесты этой пробы, а AutoLumo A1860 получает подтверждение (ACK)
 * только на «Ok». Измерено было только одно значение — рисковать нельзя.
 */
export const RESULT_OK = Object.freeze({ type: 'text', body: 'Ok' });

/**
 * «Ничего не отдаём» — рабочий список не найден, номер не пробирки, запрос всех
 * проб, незнакомый запрос. ОДНА константа, два вида:
 *   — {} (JSON): измерено на настоящей программе — анализатору прокси не отвечает
 *     ничего, BS-200 ждёт до своего тайм-аута (5–20 с);
 *   — «Order not found» (текст): так велит руководство поставщика (LIS-API.md,
 *     §3–§4); на программе не проверялось — может дать анализатору сразу «не найдено».
 * Выбор — по проверке настоящей программой (пробный период до 2026-10-10 18:51).
 * До решения — {}; EASYMED_LISPROXY_NOT_FOUND=text (читается один раз, при
 * загрузке) включает текст без правки кода — для этой проверки.
 */
export const NOT_FOUND_JSON = Object.freeze({ type: 'json', body: Object.freeze({}) });
export const NOT_FOUND_TEXT = Object.freeze({ type: 'text', body: 'Order not found' });
export const ORDER_NOT_FOUND = /^text$/i.test(String(process.env.EASYMED_LISPROXY_NOT_FOUND || '').trim()) ? NOT_FOUND_TEXT : NOT_FOUND_JSON;

/** Тело ответа так, как оно уйдёт по проводу (для журнала — reply_body). */
export const replyText = (out) => (out.type === 'json' ? JSON.stringify(out.body) : String(out.body));

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');

export const methodOf = (body) => str(obj(body).method).trim();

/** Ответ, когда разбор сорвался: прокси ждёт 2xx; результату — «Ok», запросу — «ничего». */
export function fallbackReply(method) { return method === 'apiResultSave' ? RESULT_OK : ORDER_NOT_FOUND; }

/** Строка журнала — ПЕРВОЙ, до прибора и разбора. Бросает — маршрут отвечает 500. */
export function journalProxyRequest(db, { peer = '', body = '', method = '', note = '' } = {}) {
  return recordMessage(db, {
    peer, raw: '', status: 'rejected', detail: note || JOURNAL_PENDING,
    kind: method === 'apiResultSave' ? 'result' : 'query', sourceBody: String(body == null ? '' : body),
  });
}

/** Разбор сорвался после журнала: строка говорит почему (по возможности); ответ — всё равно 200. */
export function failJournal(db, id, err) {
  try {
    db.prepare("UPDATE lab_device_messages SET status = 'rejected', resolved_at = NULL, detail = ? WHERE id = ?")
      .run('LIS Proxy: ошибка разбора — ' + String((err && err.message) || err), id);
  } catch { /* журнал уже записан; причина — по возможности */ }
}

/**
 * Разобрать запрос, уже записанный в журнал строкой id. Задачи 7–8 плана
 * наполняют разбор запросов; пока у них — прибор и ответ.
 * @returns {{type:'text'|'json', body:any}}
 */
export function handleProxyRequest(db, { id, peer = '', body = {}, now = new Date() } = {}) {
  const b = obj(body);
  const method = methodOf(b);
  if (method === 'apiResultSave') return handleResult(db, { id, peer, body: b, now });
  const who = obj(b.order);
  if (str(who.name).trim()) resolveDevice(db, id, { name: str(who.name), label: str(who.host), peer });
  return fallbackReply(method);
}

/** Прибор запроса: найти или завести (discover.js), записать в журнал, «на связи» — на каждом запросе. */
function resolveDevice(db, id, { name, label, peer }) {
  const r = ensureProxyDevice(db, { name, label, ip: peer });
  if (r.device) {
    db.prepare('UPDATE lab_device_messages SET device_id = ? WHERE id = ?').run(r.device.id, id);
    touchDevice(db, r.device.id);
  }
  return r;
}
// Примечание к журналу о смене адреса (Р8, п. 2) — пишут разборы результата и запросов.
const movedNote = (m) => (m ? '; адрес LIS Proxy сменился: ' + (m.from || '—') + ' → ' + (m.to || '—') : '');

/** apiResultSave — одно значение (раздел 3). Ответ на любой исход — «Ok» (Р23). */
function handleResult(db, { id, peer, body, now }) {
  const r = obj(body.lisResult);
  const R = obj(r.R);
  const f = { code: str(r.code), res: str(R.res), unit: str(R.unit), norms: str(R.norms), flag: str(R.flag) };
  const sent = str(r.barcode).trim();
  const who = resolveDevice(db, id, { name: str(r.name), label: str(r.host), peer });
  const deviceId = who.device ? who.device.id : null;
  const note = movedNote(who.moved);

  // Мусор прибора: строка разрешена сразу — без лотка, без серии, не в ленте (Р13).
  const junk = junkReason(f);
  if (junk) {
    recordMessage(db, { id, deviceId, peer, raw: '', sampleId: sent, status: 'unmatched', detail: PROXY_QUIET_PREFIX + junk + note, resolved: true });
    return RESULT_OK;
  }
  // Прибора нет (имя пустое, предел находок) — в лоток, в приём не идёт (Р12):
  // приём без прибора пишет в панель с кодами производителя.
  if (!who.device) {
    recordMessage(db, { id, deviceId: null, peer, raw: buildOru({ ...f, controlId: String(id), now }), sampleId: sent, status: 'unmatched',
      detail: 'LIS Proxy: прибор не заведён — ' + who.reason + ' — значения не записаны' });
    return RESULT_OK;
  }
  // Не номер пробирки — в лоток с причиной; заказ не ищется (решение владельца 3, Р11).
  const bc = normaliseProxyBarcode(sent, { autolumo: who.device.profile === AUTOLUMO });
  const raw = buildOru({ ...f, barcode: bc.ok ? bc.barcode : '', controlId: String(id), now });
  if (!bc.ok) {
    recordMessage(db, { id, deviceId, peer, raw, sampleId: sent, status: 'unmatched', detail: bc.why + note });
    return RESULT_OK;
  }
  // Прежний вход своего порта: «прибор выключен», N2, ворота, D4/D6/D7, серия.
  receiveMessage(db, raw, { peer, deviceId, journalId: id });
  if (note) {
    db.prepare("UPDATE lab_device_messages SET detail = CASE WHEN COALESCE(detail, '') = '' THEN ? ELSE detail || ? END WHERE id = ?")
      .run(note.slice(2), note, id);
  }
  return RESULT_OK;
}
