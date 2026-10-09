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
import { buildOru, junkReason, normaliseProxyBarcode, worklistEntries, PROXY_QUIET_PREFIX } from './lisproxy-form.js';
import { worklistLines } from './ingest.js';

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
// LIS_PROXY_V1 (ревью A8) — ключ, присланный дважды, — массив (lisproxy-form.js
// parseProxyForm): значение — ПОСЛЕДНЕЕ строковое, а не «пустое значение».
const str = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? [...v].reverse().find((x) => typeof x === 'string') ?? '' : '');

/** Запросы прокси (LIS-API.md, §1) — по имени без учёта регистра (ревью A4). */
export const PROXY_METHODS = Object.freeze(['apiResultSave', 'apiOrderGet', 'apiBarcodeListGet']);
/**
 * method запроса: первое строковое значение (у method[] — тоже, ревью A5); имя
 * известного запроса — в его написании, какой бы ни был регистр.
 */
export const methodOf = (body) => {
  const v = obj(body).method;
  const first = typeof v === 'string' ? v : Array.isArray(v) ? v.find((x) => typeof x === 'string') ?? '' : '';
  const m = first.trim();
  return PROXY_METHODS.find((k) => k.toLowerCase() === m.toLowerCase()) || m;
};

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
 * Разобрать запрос, уже записанный в журнал строкой id.
 * @returns {{type:'text'|'json', body:any}}
 */
export function handleProxyRequest(db, { id, peer = '', body = {}, now = new Date() } = {}) {
  const b = obj(body);
  const method = methodOf(b);
  if (method === 'apiResultSave') return handleResult(db, { id, peer, body: b, now });
  if (method === 'apiOrderGet') return handleOrder(db, { id, peer, body: b });
  if (method === 'apiBarcodeListGet') {
    return quietQuery(db, { id, peer, who: obj(b.order),
      detail: (reply) => 'LIS Proxy: запрос всех проб (apiBarcodeListGet) — пакетная загрузка выключена, ответ ' + reply });
  }
  return quietQuery(db, { id, peer, who: b.order ? obj(b.order) : obj(b.lisResult),
    detail: (reply) => 'LIS Proxy: незнакомый запрос «' + (method || '(нет method)') + '» — ответ ' + reply });
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
  // LIS_PROXY_V1 (ревью CRASH) — ORU и номер — в строку журнала ДО приёма: если
  // приём бросит наружу, строка «ошибка разбора» хранит ORU, и «Привязать» её
  // примет (с пустым raw — «пустое сообщение»). Статус и причину пишет приём.
  db.prepare('UPDATE lab_device_messages SET raw = ?, sample_id = ? WHERE id = ?').run(raw, bc.barcode, id);
  // Прежний вход своего порта: «прибор выключен», N2, ворота, D4/D6/D7, серия.
  receiveMessage(db, raw, { peer, deviceId, journalId: id });
  if (note) {
    db.prepare("UPDATE lab_device_messages SET detail = CASE WHEN COALESCE(detail, '') = '' THEN ? ELSE detail || ? END WHERE id = ?")
      .run(note.slice(2), note, id);
  }
  return RESULT_OK;
}

/**
 * apiOrderGet — рабочий список одной пробирки (раздел 5). Нашлось — JSON
 * {"0":{…}, …}; не нашлось (любая причина) — ORDER_NOT_FOUND (Р26).
 */
function handleOrder(db, { id, peer, body }) {
  const o = obj(body.order);
  const sent = str(o.barcode).trim();
  const who = resolveDevice(db, id, { name: str(o.name), label: str(o.host), peer });
  const d = who.device;
  let entries = {};
  let why = '';
  let sampleId = sent;
  if (!d) why = 'прибор не заведён — ' + who.reason;
  else if (Number(d.added) !== 1) why = 'прибор ещё не добавлен — «Добавить прибор» → «Найдены в сети» → «Добавить»';
  else if (Number(d.enabled) !== 1) why = 'прибор выключен в «Анализаторах»';
  else {
    const bc = normaliseProxyBarcode(sent, { autolumo: d.profile === AUTOLUMO });
    if (!bc.ok) why = bc.why;
    else {
      sampleId = bc.barcode;
      const w = worklistLines(db, { deviceId: d.id, orderId: Number(bc.barcode.slice(4)) });
      if (!w.ok) why = w.why;
      else entries = worklistEntries({ barcode: bc.barcode, codes: w.codes, patient: w.patient, specimen: w.specimen });
      if (w.ok && !(w.patient && w.patient.date_of_birth)) why = 'дата рождения не указана — прибор получит пустую дату';
    }
  }
  const codes = Object.values(entries).map((e) => e.code);
  const out = codes.length ? { type: 'json', body: entries } : ORDER_NOT_FOUND;
  const detail = 'LIS Proxy: рабочий список по пробирке ' + (sampleId || '(пусто)')
    + (codes.length ? ' — отдано тестов: ' + codes.length + ' (' + codes.join(', ') + ')' + (why ? '; ' + why : '') : ' — ничего не отдано: ' + why)
    + movedNote(who.moved);
  // Запрос — не проба: строка разрешена, к заказу не привязана (строка лотка при
  // заказе держит кассу — billing.js), «запросы N» у прибора считает lis_service_counts.
  recordMessage(db, { id, deviceId: d ? d.id : null, peer, raw: '', sampleId, status: 'unmatched', detail, kind: 'query', resolved: true });
  db.prepare('UPDATE lab_device_messages SET reply_body = ? WHERE id = ?').run(replyText(out), id);
  return out;
}

/**
 * apiBarcodeListGet и незнакомый method: ORDER_NOT_FOUND и строка журнала (Р19, Р26).
 * detail(reply) — текст журнала с ответом, как он ушёл по проводу.
 */
function quietQuery(db, { id, peer, who: w, detail }) {
  const name = str(w.name).trim();
  const who = name ? resolveDevice(db, id, { name, label: str(w.host), peer }) : { device: null, moved: null };
  const reply = replyText(ORDER_NOT_FOUND);
  recordMessage(db, { id, deviceId: who.device ? who.device.id : null, peer, raw: '', sampleId: '', status: 'unmatched',
    detail: detail(reply) + movedNote(who.moved), kind: 'query', resolved: true });
  db.prepare('UPDATE lab_device_messages SET reply_body = ? WHERE id = ?').run(reply, id);
  return ORDER_NOT_FOUND;
}
