// V3120_PERF — отчёты в пуле потоков: долгий отчёт НЕ держит основной поток.
//
// До пула годовой отчёт на большой клинике останавливал весь сервер: пока он
// считался, ни регистратура, ни касса не получали ответа (better-sqlite3
// синхронен, поток один). Здесь на файловой базе в WAL:
//   * пока в пуле считается долгий отчёт, основной поток отвечает на дешёвые
//     вызовы сразу (задержка цикла событий — миллисекунды, а не секунды);
//   * ответ из пула тот же, что синхронный (данные, отказы с кодом/шаблоном);
//   * слишком долгий отчёт — 503 «сузьте период», поток поднимается заново;
//   * лишний отчёт одного пользователя — 429; чужой пользователь не ждёт;
//   * без пула (база в памяти) — всё синхронно, как было.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { getRpc } from './rpc/index.js';
import { tmpDir, closeOnExit } from '../test-helpers/tmpdir.js';
import {
  configureReportPool, shutdownReportPool, dispatchRpc, reportPoolEnabled, POOLED_RPCS,
} from './report-pool.js';

const admin = { id: 9, role: 'admin', username: 'adm' };
const N = Number(process.env.REPORT_POOL_TEST_LINES || 150000);

function fileDb(n = N) {
  const file = path.join(tmpDir('em-rpool-'), 'easymed.db');
  const db = closeOnExit(openDb(file));
  migrate(db);
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates)
              VALUES (1,'doc','x','doctor','Доктор',1,?), (9,'adm','x','admin','Админ',0,'')`)
    .run(JSON.stringify([{ service_id: 1, pct: 30 }]));
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'Приём',100000,12,'consultation')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  // Выполненные строки за три года — столько, чтобы отчёт считался заметно.
  db.exec(`
    WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < ${n})
    INSERT INTO visits (id, patient_id, doctor_id, visit_date, status)
    SELECT k, 1, 1, strftime('%Y-%m-%dT%H:%M:%SZ', '2024-01-01', '+' || (k % 1000) || ' days', '+' || (k % 600) || ' minutes'), 'arrived' FROM n;
    WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < ${n})
    INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status)
    SELECT k, 1, 1, 1, 100000, 100000, 'completed' FROM n;`);
  return { db, file };
}

const RANGE = { from: '2024-01-01', to: '2026-12-31' };

// REPORT_POOL_LOAD_TOLERANT_V1 — дешёвые вызовы основного потока, пока пул
// считает отчёт: сколько дольше порога и 95-й процентиль (нижнее значение
// ранга — один выброс при малом числе замеров его не сдвигает).
const CHEAP_SLOW_MS = 250;
const CHEAP_P95_MS = 100;
function cheapCallStats(ms) {
  const sorted = [...ms].sort((x, y) => x - y);
  return {
    slow: ms.filter((x) => x >= CHEAP_SLOW_MS).length,
    p95: sorted.length ? sorted[Math.floor(0.95 * (sorted.length - 1))] : 0,
  };
}

test('REPORT_POOL_LOAD_TOLERANT_V1: один выброс под нагрузкой проходит; поток, стоящий весь отчёт, — нет', () => {
  // Прогон 3.22.0: сотни вызовов по 8–12 мс и один 639 мс — машина была занята.
  const spike = [...Array.from({ length: 200 }, (_, i) => 8 + (i % 5)), 639];
  assert.deepEqual(cheapCallStats(spike), { slow: 1, p95: 12 });
  // Мало замеров — тот же выброс процентиль не сдвигает.
  assert.ok(cheapCallStats([9, 10, 11, 12, 639]).p95 < CHEAP_P95_MS);
  // Основной поток ждал отчёта: медленные почти все — оба правила это ловят.
  const blocked = Array.from({ length: 20 }, (_, i) => (i < 3 ? 10 : 400));
  assert.ok(cheapCallStats(blocked).slow > 1);
  assert.ok(cheapCallStats(blocked).p95 >= CHEAP_P95_MS);
  // Два выброса — уже не случайность.
  assert.equal(cheapCallStats([...spike, 700]).slow, 2);
});

test('без файла базы пула нет — отчёт считается здесь же, как прежде', async () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.equal(configureReportPool({ db, dbFile: ':memory:' }), false);
  assert.equal(reportPoolEnabled(), false);
  const r = await dispatchRpc(db, 'run_report', getRpc('run_report'), { kind: 'payments' }, admin);
  assert.deepEqual(r, getRpc('run_report')(db, { kind: 'payments' }, admin));
  db.close();
});

test('долгий отчёт в пуле не держит основной поток; ответ — тот же, что без пула', async () => {
  const { db, file } = fileDb();
  const args = { kind: 'doctor_lines', ...RANGE };
  const t0 = performance.now();
  const want = getRpc('run_report')(db, args, admin);
  const syncMs = performance.now() - t0;

  assert.equal(configureReportPool({ db, dbFile: file }), true);
  try {
    const started = performance.now();
    let done = false;
    const pending = dispatchRpc(db, 'run_report', getRpc('run_report'), args, admin).finally(() => { done = true; });
    // Пока отчёт считается — основной поток отвечает: цикл событий крутится,
    // дешёвый вызов к базе проходит сразу.
    let maxLag = 0, cheapMax = 0, ticks = 0;
    const cheapMs = [];   // REPORT_POOL_LOAD_TOLERANT_V1 — каждый дешёвый вызов, а не только худший
    while (!done) {
      const a = performance.now();
      await new Promise((r) => setTimeout(r, 5));
      maxLag = Math.max(maxLag, performance.now() - a - 5);
      const c = performance.now();
      getRpc('report_buildings')(db, {}, admin);
      // И запись: регистратура заводит пациента, пока поток отчёта читает.
      db.prepare("INSERT INTO patients (full_name) VALUES ('Новый пациент')").run();
      const ms = performance.now() - c;
      cheapMs.push(ms);
      cheapMax = Math.max(cheapMax, ms);
      ticks++;
    }
    const got = await pending;
    const pooledMs = performance.now() - started;
    const { slow: cheapSlow, p95: cheapP95 } = cheapCallStats(cheapMs);   // REPORT_POOL_LOAD_TOLERANT_V1
    console.log(`[report-pool] sync ${Math.round(syncMs)} ms (loop blocked the whole time); pooled ${Math.round(pooledMs)} ms, `
      + `main loop max lag ${Math.round(maxLag)} ms, cheap call max ${Math.round(cheapMax)} ms, p95 ${Math.round(cheapP95)} ms, `
      + `${cheapSlow} over ${CHEAP_SLOW_MS} ms, ${ticks} ticks`);
    assert.deepEqual(got, want, 'поток считает то же, что основной');
    // REPORT_POOL_LOAD_TOLERANT_V1 (3.23.0) — было «cheapMax < 250»: в прогоне
    // всего набора тестов параллельно (релиз 3.22.0) один вызов из сотен ждал
    // 639 мс — машина была занята другими файлами, а не отчётом (этот файл один:
    // 8–12 мс). Смысл проверки прежний — основной поток НЕ стоит весь отчёт:
    // заблокированный поток сделал бы медленными почти все вызовы, а не один.
    // Поэтому: не больше ОДНОГО вызова дольше 250 мс и 95-й процентиль меньше 100 мс.
    assert.ok(cheapSlow <= 1, `чтение и запись в основном потоке ждали отчёта: ${cheapSlow} вызовов дольше ${CHEAP_SLOW_MS} мс из ${ticks} (худший ${Math.round(cheapMax)} мс)`);
    assert.ok(cheapP95 < CHEAP_P95_MS, `чтение и запись в основном потоке ждали отчёта: 95-й процентиль ${Math.round(cheapP95)} мс из ${ticks} вызовов`);
    assert.ok(ticks >= 5, 'пока считался отчёт, основной поток успел ответить много раз');
    assert.ok(maxLag < Math.max(250, syncMs / 4), `цикл событий не стоял: задержка ${Math.round(maxLag)} мс при отчёте ${Math.round(syncMs)} мс`);

    // Отказ обработчика доходит тем же — код, статус, шаблон.
    const bad = { kind: 'no_such_report' };
    let syncErr, poolErr;
    try { getRpc('run_report')(db, bad, admin); } catch (e) { syncErr = e; }
    try { await dispatchRpc(db, 'run_report', getRpc('run_report'), bad, admin); } catch (e) { poolErr = e; }
    for (const k of ['message', 'status', 'code', 'template']) assert.deepEqual(poolErr[k], syncErr[k], k);
    assert.deepEqual(poolErr.params, syncErr.params);
  } finally {
    await shutdownReportPool();
  }
});

test('слишком долгий отчёт — 503 «сузьте период», пул после этого работает', async () => {
  const { db, file } = fileDb(30000);
  assert.equal(configureReportPool({ db, dbFile: file, size: 1, timeoutMs: 30 }), true);
  try {
    await assert.rejects(
      dispatchRpc(db, 'run_report', getRpc('run_report'), { kind: 'doctor_lines', ...RANGE }, admin),
      (e) => e.status === 503 && e.code === 'report_timeout' && /сузьте период/.test(e.message) && e.template === e.message,
    );
  } finally {
    await shutdownReportPool();
  }
  assert.equal(configureReportPool({ db, dbFile: file, size: 1, timeoutMs: 60000 }), true);
  try {
    const r = await dispatchRpc(db, 'run_report', getRpc('run_report'), { kind: 'payments', from: '2024-01-01', to: '2024-01-01' }, admin);
    assert.deepEqual(r, getRpc('run_report')(db, { kind: 'payments', from: '2024-01-01', to: '2024-01-01' }, admin));
  } finally {
    await shutdownReportPool();
  }
});

test('лишний отчёт одного пользователя — 429; другой пользователь не ждёт этой очереди', async () => {
  const { db, file } = fileDb(30000);
  assert.equal(configureReportPool({ db, dbFile: file, size: 1, maxPerUser: 1 }), true);
  try {
    const first = dispatchRpc(db, 'run_report', getRpc('run_report'), { kind: 'doctor_lines', ...RANGE }, admin);
    await assert.rejects(
      dispatchRpc(db, 'run_report', getRpc('run_report'), { kind: 'payments' }, admin),
      (e) => e.status === 429 && e.code === 'report_busy',
    );
    const other = { id: 1, role: 'doctor', is_doctor: 1 };
    const mine = dispatchRpc(db, 'doctor_pay_summary', getRpc('doctor_pay_summary'), { doctor_id: 1, from: '2024-01-01', to: '2024-01-31' }, other);
    await first;
    assert.ok(await mine);
  } finally {
    await shutdownReportPool();
  }
});

test('в пуле — только чтение: закрытие месяца и прочие записи остаются в основном потоке', () => {
  for (const n of ['pay_period_close', 'pay_period_reopen', 'report_choices']) assert.equal(POOLED_RPCS.has(n), false, n);
  for (const n of POOLED_RPCS) assert.ok(getRpc(n), 'обработчик ' + n + ' существует');
});
