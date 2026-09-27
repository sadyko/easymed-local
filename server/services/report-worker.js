// V3120_PERF — поток отчётов. Отдельный поток со СВОИМ соединением к той же
// базе, только для чтения (журнал WAL позволяет читать параллельно с записью
// основного потока). Сюда приходят готовые вызовы тех же обработчиков RPC,
// что и в основном потоке (report-pool.js, POOLED_RPCS): тот же код, те же
// проверки прав по той же базе — пока он считает годовой отчёт, основной
// поток обслуживает регистратуру и кассу.
//
// Соединение read-only нарочно: если когда-нибудь отчёт начнёт писать, запись
// упадёт громко («attempt to write a readonly database»), а не поедет мимо
// основного потока и его транзакций.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { registerUdfs } from '../db/connection.js';
import { setDataDir } from './control/config.js';

const db = new Database(workerData.dbFile, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
registerUdfs(db);
if (workerData.dataDir) setDataDir(workerData.dataDir);
const { getRpc } = await import('./rpc/index.js');

// Ошибка обработчика — через границу потока только данными; основной поток
// соберёт из них ошибку с теми же полями (status, code, шаблон), и маршрут
// ответит ровно тем же, что ответил бы без потока.
const serialise = (e) => ({
  message: String((e && e.message) || e),
  status: e && e.status,
  code: e && e.code,
  template: e && e.template,
  params: e && e.params,
});

parentPort.on('message', async ({ id, name, args, user }) => {
  try {
    const handler = getRpc(name);
    // Сюда приходят только имена из POOLED_RPCS — у всех есть обработчик;
    // иное — ошибка программы (500 «Ошибка сервера» на экране).
    if (!handler) throw Object.assign(new Error('Ошибка сервера. Повторите позже.'), { status: 500, code: 'internal' });
    const data = await handler(db, args, user);
    parentPort.postMessage({ id, data });
  } catch (e) {
    parentPort.postMessage({ id, error: serialise(e) });
  }
});
parentPort.postMessage({ ready: true });
