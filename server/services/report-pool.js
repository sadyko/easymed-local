// V3120_PERF — ТЯЖЁЛЫЕ ОТЧЁТЫ НЕ ДЕРЖАТ КЛИНИКУ.
//
// better-sqlite3 синхронен, а сервер — один поток. Отчёт за год на большой
// клинике считается секунды (за три года — десятки), и всё это время не
// отвечал НИ ОДИН экран: регистратура, касса, лаборатория ждали, пока
// бухгалтерия досчитает зарплаты. Теперь отчёты (POOLED_RPCS) уходят в
// небольшой пул потоков (report-worker.js): у каждого своё соединение к ТОЙ
// ЖЕ базе только для чтения (WAL — читатели не ждут писателя), тот же код
// обработчиков и те же проверки прав. Основной поток только пересылает вызов
// и сразу свободен.
//
// Чего здесь НЕТ намеренно:
//   * записи — закрытие и открытие месяца (pay_period_close/_reopen) остаются
//     в основном потоке: писатель у базы один;
//   * пула без файла базы — база в памяти (тесты) и база не в WAL считаются
//     по-старому, синхронно; пул включает только запуск сервера
//     (server/index.js, configureReportPool). Так все существующие тесты идут
//     как шли.
//
// Ограничения: не больше MAX_PER_USER отчётов одного пользователя разом
// (кабинет врача открывает три-четыре вызова сразу — они проходят; десяток
// нажатий «Сформировать» — нет), и TIMEOUT_MS на отчёт: дольше — поток
// останавливается вместе с запросом, пользователь получает 503 «сузьте
// период», пул поднимает поток заново.
import { Worker } from 'node:worker_threads';
import { withTemplate } from './server-message.js';

export const POOLED_RPCS = new Set([
  'run_report', 'owner_report', 'cashier_report', 'reports_overview',
  'doctor_pay_summary', 'doctor_referral_reward', 'doctor_inpatient_share', 'doctor_tier_positions',
]);

const TIMEOUT_T = 'Отчёт считается слишком долго — сузьте период.';
const BUSY_T = 'Ваш прошлый отчёт ещё считается — дождитесь его и повторите.';

let pool = null;

const httpError = (status, code, template) =>
  withTemplate(Object.assign(new Error(template), { status, code }), template, {});

/**
 * Включить пул. Вызывается при запуске сервера с настоящим файлом базы.
 * Возвращает true, если пул включён; false — отчёты считаются синхронно.
 */
export function configureReportPool({ db, dbFile, dataDir = null, size = 2, timeoutMs = 120000, maxPerUser = 3 } = {}) {
  shutdownReportPool();
  if (String(process.env.EASYMED_REPORT_WORKERS || '') === '0' || size < 1) return false;
  if (!dbFile || dbFile === ':memory:') return false;
  // Параллельное чтение держится на WAL; без него поток отчёта ждал бы
  // писателя, а писатель — его.
  try {
    if (db && String(db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'wal') return false;
  } catch { return false; }
  pool = { dbFile, dataDir, size, timeoutMs, maxPerUser, workers: [], queue: [], perUser: new Map(), seq: 0, broken: false };
  for (let i = 0; i < size; i++) pool.workers.push(spawn(pool));
  return true;
}

export function reportPoolEnabled() { return !!pool && !pool.broken; }

export async function shutdownReportPool() {
  const p = pool;
  pool = null;
  if (!p) return;
  for (const job of p.queue) job.reject(httpError(503, 'report_pool_closed', TIMEOUT_T));
  await Promise.all(p.workers.map((w) => w.worker.terminate().catch(() => {})));
}

function spawn(p) {
  const worker = new Worker(new URL('./report-worker.js', import.meta.url), {
    workerData: { dbFile: p.dbFile, dataDir: p.dataDir },
  });
  // Поток не держит процесс: остановка сервера не ждёт отчётов.
  worker.unref();
  const slot = { worker, job: null, ready: false };
  worker.on('message', (m) => {
    if (m && m.ready) { slot.ready = true; pump(p); return; }
    const job = slot.job;
    if (!job || !m || m.id !== job.id) return;
    slot.job = null;
    worker.unref();
    finish(p, job);
    if (m.error) job.reject(Object.assign(new Error(m.error.message), m.error));
    else job.resolve(m.data);
    pump(p);
  });
  const lost = (why) => {
    if (slot.dead) return;   // 'error' и следом 'exit' — одна потеря, один новый поток
    slot.dead = true;
    const job = slot.job;
    slot.job = null;
    const i = p.workers.indexOf(slot);
    if (pool !== p) return;
    if (!slot.ready && !job) {
      // Поток не поднялся вовсе (нет модуля, не открылась база) — пул
      // выключается, отчёты идут синхронно, как до него.
      p.broken = true;
      console.warn('[report-pool] worker failed to start, falling back to in-process reports:', why);
      for (const q of p.queue.splice(0)) { finish(p, q); q.reject(Object.assign(new Error('fallback'), { fallback: true })); }
      return;
    }
    if (job) { finish(p, job); job.reject(job.timedOut ? httpError(503, 'report_timeout', TIMEOUT_T) : Object.assign(new Error(String(why)), { status: 500 })); }
    if (i >= 0) p.workers[i] = spawn(p);
    pump(p);
  };
  worker.on('error', (e) => lost(e && e.message));
  worker.on('exit', (code) => { if (slot.job || !slot.ready || code !== 0) lost('exit ' + code); });
  return slot;
}

function finish(p, job) {
  clearTimeout(job.timer);
  const n = (p.perUser.get(job.userKey) || 1) - 1;
  if (n <= 0) p.perUser.delete(job.userKey); else p.perUser.set(job.userKey, n);
}

function pump(p) {
  for (const slot of p.workers) {
    if (!slot.ready || slot.job || !p.queue.length) continue;
    const job = p.queue.shift();
    slot.job = job;
    job.slot = slot;
    // Пока поток считает, он держит процесс (иначе процесс без других дел —
    // тест, скрипт — вышел бы, не дождавшись ответа); свободный — не держит.
    slot.worker.ref();
    slot.worker.postMessage({ id: job.id, name: job.name, args: job.args, user: job.user });
  }
}

/**
 * Выполнить RPC отчёта в пуле. Отказ с `fallback: true` означает «пула нет —
 * считай сам» (dispatchRpc так и делает).
 */
export function runPooled(name, args, user) {
  const p = pool;
  if (!p || p.broken) return Promise.reject(Object.assign(new Error('fallback'), { fallback: true }));
  const userKey = user && user.id != null ? String(user.id) : '-';
  const inFlight = p.perUser.get(userKey) || 0;
  if (inFlight >= p.maxPerUser) return Promise.reject(httpError(429, 'report_busy', BUSY_T));
  p.perUser.set(userKey, inFlight + 1);
  return new Promise((resolve, reject) => {
    const job = {
      id: ++p.seq, name, userKey, resolve, reject, slot: null, timedOut: false,
      // Через границу потока — только данные: JSON отбрасывает всё, что не
      // клонируется (функции, классы), и обработчик получает то же, что увидел
      // бы в основном потоке после res.json.
      args: JSON.parse(JSON.stringify(args ?? {})),
      user: user == null ? user : JSON.parse(JSON.stringify(user)),
    };
    job.timer = setTimeout(() => {
      job.timedOut = true;
      const qi = p.queue.indexOf(job);
      if (qi >= 0) { p.queue.splice(qi, 1); finish(p, job); reject(httpError(503, 'report_timeout', TIMEOUT_T)); return; }
      // Считается: поток останавливается вместе с запросом (иначе он досчитал
      // бы никому не нужный отчёт), 'exit' поднимет новый.
      if (job.slot) job.slot.worker.terminate().catch(() => {});
    }, p.timeoutMs);
    job.timer.unref?.();
    p.queue.push(job);
    pump(p);
  });
}

/**
 * Единая точка вызова RPC для маршрута: отчёт — в пул (если он включён),
 * всё остальное и отчёт без пула — как прежде, в этом потоке.
 */
export async function dispatchRpc(db, name, handler, args, user) {
  if (POOLED_RPCS.has(name) && reportPoolEnabled()) {
    try {
      return await runPooled(name, args, user);
    } catch (e) {
      if (!e || !e.fallback) throw e;
    }
  }
  return handler(db, args, user);
}
