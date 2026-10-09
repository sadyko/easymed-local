// LIS_PROXY_V1 — запрос LIS Proxy: журнал, прибор, результат, рабочий список
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, разделы 2–6).
//
// Прокси шлёт каждое значение ОДИН раз и не повторяет, а анализатору уже
// ответил «принято». Поэтому: сначала строка журнала (тело как пришло —
// source_body), потом всё остальное дописывает ЭТУ ЖЕ строку, и ответ — 200 на
// любой исход (маршрут server/routes/lisproxy.js). Результат идёт в прежний
// приём (receive.js → ingest.js) синтетическим ORU^R01 (lisproxy-form.js).
import { recordMessage } from './inbox.js';

/** Журнал строки, пока запрос не разобран: если процесс упал посреди — строка так и скажет. */
export const JOURNAL_PENDING = 'LIS Proxy: запрос сохранён, разбор не завершён';

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
 * Разобрать запрос, уже записанный в журнал строкой id. Задачи 3–8 плана
 * наполняют разбор; пока — только ответ.
 * @returns {{type:'text'|'json', body:any}}
 */
export function handleProxyRequest(db, { id, peer = '', body = {} } = {}) {
  return fallbackReply(methodOf(body));
}
