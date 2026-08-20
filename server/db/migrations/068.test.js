// FREE_SERVICE_V1 — расклинивает уже зависшие бесплатные строки.
//
// В живой базе таких оказалось 10: все с queue_no на руках у пациентов и все в
// 'added', то есть на доске очереди — «ожидает оплату» без всякой возможности
// эту оплату провести.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function seeded() {
  const db = openDb(':memory:');
  migrate(db);
  const p = db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid;
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-18T09:00:00Z')").run(p).lastInsertRowid;
  const add = (total, status) => db.prepare(
    "INSERT INTO visit_services (visit_id, quantity, unit_price, total, status, queue_key, queue_no) VALUES (?,1,?,?,?,'doc:2:2026-08-18',1)")
    .run(v, total, total, status).lastInsertRowid;
  return { db, add };
}
const rerun = (db) => db.exec(fs.readFileSync(new URL('./068_free_services_out_of_cashier.sql', import.meta.url), 'utf8'));
const statusOf = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;

test('зависшая бесплатная строка уходит в обычное ожидание', () => {
  const { db, add } = seeded();
  const free = add(0, 'added');
  rerun(db);
  assert.equal(statusOf(db, free), 'queued');
});

test('платная строка в ожидании кассы не трогается', () => {
  const { db, add } = seeded();
  const paid = add(60000, 'added');
  rerun(db);
  assert.equal(statusOf(db, paid), 'added', 'по ней деньги ещё берут');
});

test('уже принятые и закрытые строки не трогаются', () => {
  const { db, add } = seeded();
  const serving = add(0, 'in_progress');
  const done = add(0, 'completed');
  rerun(db);
  assert.equal(statusOf(db, serving), 'in_progress');
  assert.equal(statusOf(db, done), 'completed');
});

test('номер очереди миграция не меняет', () => {
  const { db, add } = seeded();
  const free = add(0, 'added');
  rerun(db);
  assert.equal(db.prepare('SELECT queue_no FROM visit_services WHERE id = ?').get(free).queue_no, 1);
});
