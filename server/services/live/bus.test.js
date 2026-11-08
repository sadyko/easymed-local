// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — шина изменений: номер версии,
// склейка всплеска в одно событие, в событии — только имена, без данных.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createLiveBus, liveBusFor, liveBump, LIVE_TABLES } from './bus.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshDb(t) {
  const db = openDb(':memory:');
  migrate(db);
  t.after(() => db.close());
  return db;
}

/** Слушатель, который складывает события в массив. */
function collect(bus) {
  const got = [];
  const off = bus.subscribe((ev) => got.push(ev));
  return { got, off };
}

test('версия растёт на единицу с каждым событием и начинается с часов запуска', (t) => {
  const db = freshDb(t);
  const bus = createLiveBus(db, { coalesceMs: 10_000, now: () => 1_700_000_000_000 });
  assert.equal(bus.version, 1_700_000_000_000, 'версия начинается со времени запуска — после перезапуска она не меньше прежней');
  const { got } = collect(bus);
  bus.bump({ tables: ['invoices'] });
  bus.flush();
  bus.bump({ rpc: ['record_payment'] });
  bus.flush();
  assert.deepEqual(got.map((e) => e.v), [1_700_000_000_001, 1_700_000_000_002]);
  assert.equal(bus.version, 1_700_000_000_002);
  assert.equal(bus.flush(), null, 'пустая склейка события не даёт и версию не двигает');
  assert.equal(bus.version, 1_700_000_000_002);
});

test('всплеск записей склеивается в одно событие с объединением таблиц и RPC', async (t) => {
  const db = freshDb(t);
  const bus = createLiveBus(db, { coalesceMs: 40 });
  const { got } = collect(bus);
  bus.bump({ tables: ['invoices'] });
  bus.bump({ tables: ['payments', 'invoices'], rpc: ['record_payment'] });
  bus.bump({ rpc: ['create_invoice_for_visit'] });
  assert.equal(got.length, 0, 'событие уходит не сразу, а после окна склейки');
  await sleep(120);
  assert.equal(got.length, 1, 'одно событие на всплеск');
  assert.deepEqual(got[0].tables, ['invoices', 'payments']);
  assert.deepEqual(got[0].rpc, ['create_invoice_for_visit', 'record_payment']);
  bus.bump({ tables: ['visits'] });
  await sleep(120);
  assert.equal(got.length, 2, 'следующий всплеск — своё событие');
  assert.deepEqual(got[1].tables, ['visits']);
});

test('событие несёт только версию, имена таблиц и RPC — ни строк, ни имён пациентов, ни номеров', async (t) => {
  const db = freshDb(t);
  const bus = createLiveBus(db, { coalesceMs: 10_000 });
  const { got } = collect(bus);
  const MARK = 'Маркер-Пациент-LIVE';
  const pid = Number(db.prepare('INSERT INTO patients (full_name, phone) VALUES (?, ?)').run(MARK, '+998 90 000 00 00').lastInsertRowid);
  db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, ?)').run(pid, '2026-11-08T09:00:00Z', 'arrived');
  // Мусор в именах (данные, SQL, кириллица) не проходит в событие вовсе.
  bus.bump({ tables: [MARK, "x'); DROP TABLE visits;--", 'invoices', 42, null], rpc: ['Иванов', 'record_payment', { a: 1 }] });
  const ev = bus.flush();
  assert.ok(ev, 'событие есть');
  assert.deepEqual(Object.keys(ev).sort(), ['rpc', 'tables', 'v']);
  assert.deepEqual(ev.tables, ['invoices', 'visits'], 'запись визита поймана самой базой; мусорные имена отброшены');
  assert.deepEqual(ev.rpc, ['record_payment']);
  const text = JSON.stringify(got);
  assert.ok(!text.includes(MARK), 'имя пациента не попало в событие');
  assert.ok(!text.includes('998'), 'телефон не попал в событие');
  // Кроме номера версии в событии нет ни одного числа: ни id строки, ни суммы.
  assert.equal(typeof ev.v, 'number');
  for (const name of [...ev.tables, ...ev.rpc]) assert.match(name, /^[a-z][a-z0-9_]*$/, 'только имена-идентификаторы');
});

test('запись в наблюдаемую таблицу любой дорогой (не /api/db и не RPC) даёт событие с её именем', async (t) => {
  const db = freshDb(t);
  const bus = createLiveBus(db, { coalesceMs: 30 });
  const { got } = collect(bus);
  assert.ok(bus.capture, 'перехват записей базой установлен');
  // Так пишут приём анализаторов, обмен филиалов, боты — мимо маршрутов.
  db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run();
  const pid = db.prepare('SELECT MAX(id) AS id FROM patients').get().id;
  db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, '2026-11-08T09:00:00Z', 'arrived')").run(pid);
  await sleep(100);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].tables, ['visits'], 'patients не наблюдается — в событии только visits');
  for (const t2 of ['visits', 'visit_services', 'invoices', 'invoice_items', 'payments', 'lab_results', 'admission_services']) {
    assert.ok(LIVE_TABLES.includes(t2), t2 + ' наблюдается');
  }
});

test('рамка записи: успех отдаёт пойманные таблицы, отказ их выбрасывает', async (t) => {
  const db = freshDb(t);
  const bus = createLiveBus(db, { coalesceMs: 10_000 });
  db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run();
  const pid = db.prepare('SELECT MAX(id) AS id FROM patients').get().id;
  // Отказ: запись внутри рамки, потом откат — события нет.
  const failed = bus.open();
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, '2026-11-08T09:00:00Z', 'arrived')").run(pid);
      throw new Error('откат');
    })();
  } catch { /* ожидаемо */ }
  assert.deepEqual([...failed.end()], ['visits'], 'рамка видела запись');
  assert.equal(bus.flush(), null, 'неудачная запись события не дала');
  // Успех: пойманное уходит в событие вместе с тем, что назвал маршрут.
  const ok = bus.open();
  db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, '2026-11-08T10:00:00Z', 'arrived')").run(pid);
  const held = ok.end();
  bus.bump({ tables: [...held, 'patients'] });
  assert.deepEqual(bus.flush().tables, ['patients', 'visits']);
});

test('since: объединение пропущенного; сброс, если номер старше кольца, из будущего или мусор', (t) => {
  const db = freshDb(t);
  const bus = createLiveBus(db, { coalesceMs: 10_000, now: () => 1000, ringMax: 3 });
  bus.bump({ tables: ['visits'] }); bus.flush();          // 1001
  bus.bump({ tables: ['invoices'], rpc: ['x_rpc'] }); bus.flush();   // 1002
  bus.bump({ tables: ['payments'] }); bus.flush();        // 1003
  assert.deepEqual(bus.since(1001), { v: 1003, tables: ['invoices', 'payments'], rpc: ['x_rpc'] });
  assert.deepEqual(bus.since(1003), { v: 1003, tables: [], rpc: [] }, 'ничего нового');
  assert.deepEqual(bus.since(1000), { v: 1003, tables: ['invoices', 'payments', 'visits'], rpc: ['x_rpc'] }, 'с начала работы — всё кольцо');
  bus.bump({ tables: ['lab_results'] }); bus.flush();     // 1004 — кольцо из трёх, 1001 выпал
  assert.equal(bus.since(1000).reset, true, 'старше кольца — сброс: «могло измениться всё»');
  assert.deepEqual(bus.since(1001).tables, ['invoices', 'lab_results', 'payments'], 'граница кольца ещё известна');
  assert.equal(bus.since(5000).reset, true, 'номер из будущего (сервер перезапущен) — сброс');
  assert.deepEqual(bus.since(undefined), { v: 1004 }, 'без номера — просто версия');
  assert.deepEqual(bus.since('abc'), { v: 1004 });
});

test('шина ничего не роняет: падающий слушатель, мусор на входе, база без шины', async (t) => {
  const db = freshDb(t);
  assert.equal(liveBusFor(db), null);
  assert.doesNotThrow(() => liveBump(db, { tables: ['visits'] }), 'без шины — молча ничего');
  assert.doesNotThrow(() => liveBump(null, null));
  const bus = createLiveBus(db, { coalesceMs: 10_000 });
  assert.equal(createLiveBus(db), bus, 'одна шина на базу');
  assert.equal(liveBusFor(db), bus);
  const seen = [];
  bus.subscribe(() => { throw new Error('слушатель упал'); });
  bus.subscribe((ev) => seen.push(ev.v));
  assert.doesNotThrow(() => bus.bump(undefined));
  assert.doesNotThrow(() => bus.bump({ tables: 'visits' }));
  liveBump(db, { tables: ['visits'] });
  assert.doesNotThrow(() => bus.flush());
  assert.equal(seen.length, 1, 'второй слушатель получил событие, хоть первый упал');
});

test('сбой шины не роняет и не откатывает саму запись', (t) => {
  const db = freshDb(t);
  const bus = createLiveBus(db, { coalesceMs: 10_000 });
  bus.touch = () => { throw new Error('шина сломана'); };
  db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run();
  const pid = db.prepare('SELECT MAX(id) AS id FROM patients').get().id;
  assert.doesNotThrow(() => db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, '2026-11-08T09:00:00Z', 'arrived')").run(pid));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 1, 'запись на месте');
});

test('подписка снимается; счётчик слушателей возвращается к нулю', (t) => {
  const db = freshDb(t);
  const bus = createLiveBus(db, { coalesceMs: 10_000 });
  const a = bus.subscribe(() => {});
  const b = bus.subscribe(() => {});
  assert.equal(bus.listenerCount, 2);
  a(); b(); b();
  assert.equal(bus.listenerCount, 0);
});
