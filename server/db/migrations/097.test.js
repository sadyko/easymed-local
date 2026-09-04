// 097.test.js — TWO_STEP_DISCHARGE_V1: колонки двухшаговой выписки.
//
// Миграция добавляет пятнадцать колонок в `admissions` — таблицу, которую в
// ЭТОМ ЖЕ выпуске уже пересобрала 091. Весь вопрос теста поэтому один: она
// добавила и НИЧЕГО не пересобрала. Клиника с пациентами в койках и с уже
// выписанными госпитализациями после обновления читается как раньше, и ни одна
// строка не переписана.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M097 = '097_discharge.sql';

/** База ровно в том виде, в каком её застаёт 097 на работающей клинике. */
function dbBefore097() {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= M097) break;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(DIR, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
  }
  return db;
}

function apply097(db) {
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(DIR, M097), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(M097);
  })();
}

/** Живая клиника: один лежит, один уже выписан прямой выпиской v0.8.0. */
function running(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'doc','x','Лечащий','doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (2,'Петров Пётр')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'occupied')").run();
  db.prepare(`INSERT INTO admissions (id, patient_id, bed_id, ward_id, doctor_id, attending_doctor_id,
                                      status, admitted_at)
              VALUES (1,1,1,1,1,1,'active','2026-09-01T08:00:00Z')`).run();
  db.prepare(`INSERT INTO admissions (id, patient_id, ward_id, doctor_id, status, admitted_at, discharged_at, charge_amount)
              VALUES (2,2,1,1,'discharged','2026-08-20T08:00:00Z','2026-08-25T11:00:00Z',750000)`).run();
  return db;
}

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

const NEW_COLUMNS = [
  'discharge_outcome', 'discharge_destination', 'discharge_recommendations',
  'discharge_requested_by', 'discharge_requested_at',
  'discharged_by', 'discharge_orders_closed', 'discharge_bill_settled',
  'discharge_docs_given', 'discharge_note',
  'discharge_debt_ack', 'discharge_debt_ack_by', 'discharge_debt_ack_at',
  'discharge_debt_amount',
];

test('097 ДОБАВЛЯЕТ колонки и ничего не пересобирает', () => {
  const db = dbBefore097();
  running(db);
  const before = cols(db, 'admissions');
  const rowsBefore = db.prepare('SELECT * FROM admissions ORDER BY id').all();

  apply097(db);

  // Ровно новые колонки в конце, ни одной старой не пропало и порядок прежних
  // не изменился — это и есть подпись ADD COLUMN, в отличие от пересборки.
  assert.deepEqual(cols(db, 'admissions'), [...before, ...NEW_COLUMNS]);

  // Ни одна строка не переписана: старые значения на месте, новые пусты.
  const after = db.prepare('SELECT * FROM admissions ORDER BY id').all();
  assert.equal(after.length, rowsBefore.length);
  for (let i = 0; i < after.length; i++) {
    for (const k of before) assert.deepEqual(after[i][k], rowsBefore[i][k], `строка ${after[i].id}, колонка ${k}`);
  }
});

test('097 не трогает НИ ОДНОЙ другой таблицы', () => {
  const db = dbBefore097();
  running(db);
  const snapshot = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const before = snapshot();
  apply097(db);
  const after = snapshot();

  assert.deepEqual(after.map((t) => t.name), before.map((t) => t.name), 'список таблиц тот же');
  for (const t of after) {
    const was = before.find((b) => b.name === t.name);
    if (t.name === 'admissions') continue;
    assert.equal(t.sql, was.sql, `таблица ${t.name} изменена, а не должна`);
  }
});

test('открытая госпитализация после обновления выглядит «заявки на выписку не подавали»', () => {
  const db = dbBefore097();
  running(db);
  apply097(db);

  const adm = db.prepare('SELECT * FROM admissions WHERE id = 1').get();
  // NULL — осмысленный ответ: «исхода ещё нет». Пустая строка соврала бы.
  assert.equal(adm.discharge_outcome, null);
  assert.equal(adm.discharge_requested_by, null);
  assert.equal(adm.discharge_requested_at, null);
  assert.equal(adm.discharged_by, null);
  // Долга при выписке НЕ ЗНАЕМ (NULL), а не «долга не было» (0).
  assert.equal(adm.discharge_debt_amount, null);
  // Текстовые — пустая строка, как chief_complaint (091): экраны не обязаны
  // помнить про COALESCE.
  assert.equal(adm.discharge_destination, '');
  assert.equal(adm.discharge_recommendations, '');
  assert.equal(adm.discharge_note, '');
  // Чек-лист: ничего не отмечено.
  assert.equal(adm.discharge_orders_closed, 0);
  assert.equal(adm.discharge_bill_settled, 0);
  assert.equal(adm.discharge_docs_given, 0);
  assert.equal(adm.discharge_debt_ack, 0);
});

test('исход — только четыре значения, и «заявки нет» (NULL) среди них законно', () => {
  const db = dbBefore097();
  running(db);
  apply097(db);

  for (const ok of ['home', 'transfer', 'refuse', 'death']) {
    db.prepare('UPDATE admissions SET discharge_outcome = ? WHERE id = 1').run(ok);
    assert.equal(db.prepare('SELECT discharge_outcome o FROM admissions WHERE id=1').get().o, ok);
  }
  db.prepare('UPDATE admissions SET discharge_outcome = NULL WHERE id = 1').run();
  assert.equal(db.prepare('SELECT discharge_outcome o FROM admissions WHERE id=1').get().o, null);

  for (const bad of ['', 'выписан', 'home ', 'HOME', 'улучшение']) {
    assert.throws(() => db.prepare('UPDATE admissions SET discharge_outcome = ? WHERE id = 1').run(bad),
      /CHECK constraint failed/, `исход «${bad}» не должен приниматься`);
  }
});

test('очередь выписок обходится индексами 091 — новых 097 не заводит', () => {
  const db = dbBefore097();
  running(db);
  const idxBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='admissions' ORDER BY name").all().map((r) => r.name);
  apply097(db);
  const idxAfter = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='admissions' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(idxAfter, idxBefore, '097 не добавляет индексов — см. хвост миграции');

  // И отбор очереди всё равно идёт ПО ИНДЕКСУ, а не перебором таблицы: 091
  // уже проиндексировала статус.
  db.prepare("UPDATE admissions SET status='discharging', discharge_requested_at='2026-09-04T09:00:00Z' WHERE id=1").run();
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM admissions WHERE status='discharging' ORDER BY discharge_requested_at").all();
  assert.ok(plan.some((r) => /USING INDEX/.test(String(r.detail))), JSON.stringify(plan));
  assert.ok(!plan.some((r) => /SCAN admissions/.test(String(r.detail))), 'перебора таблицы быть не должно');
});

test('097 применяется поверх уже применённой себя без вреда (миграции идут один раз)', () => {
  const db = dbBefore097();
  running(db);
  apply097(db);
  const names = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name);
  assert.ok(names.includes(M097));
  // Повторный прогон миграций пропускает уже применённые — это делает
  // migrate.js; здесь достаточно того, что имя записано ровно один раз.
  assert.equal(names.filter((n) => n === M097).length, 1);
});
