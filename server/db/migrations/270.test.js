// REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1 — миграция 270: направивший строки визита,
// рекомендация врача для регистратуры, строка, которой закрыта рекомендация.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Тест')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1, 1, '2026-11-02T09:00:00Z')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'УЗИ', 100)").run();
  const src = Number(db.prepare("INSERT INTO referral_sources (name) VALUES ('Партнёр')").run().lastInsertRowid);
  return { db, src };
}

test('мигр. 270: колонки и индексы на месте, у прежних строк пусто', () => {
  const { db } = fresh();
  const vs = db.prepare('PRAGMA table_info(visit_services)').all().map((c) => c.name);
  assert.ok(vs.includes('referred_by_source_id'));
  assert.ok(vs.includes('referral_note'));
  const rs = db.prepare('PRAGMA table_info(recommended_services)').all().map((c) => c.name);
  assert.ok(rs.includes('visit_service_id'));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_visit_services_referred_by'));
  assert.ok(idx.includes('idx_recommended_services_vs'));
  const id = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (1, 1, 'added')").run().lastInsertRowid);
  assert.deepEqual(db.prepare('SELECT referred_by_source_id, referral_note FROM visit_services WHERE id = ?').get(id),
    { referred_by_source_id: null, referral_note: null });
});

test('мигр. 270: источник строки — существующий источник; рекомендация не длиннее 500 знаков', () => {
  const { db, src } = fresh();
  db.prepare("INSERT INTO visit_services (visit_id, service_id, status, referred_by_source_id, referral_note) VALUES (1, 1, 'added', ?, 'натощак')").run(src);
  assert.throws(() => db.prepare("INSERT INTO visit_services (visit_id, service_id, status, referred_by_source_id) VALUES (1, 1, 'added', 99999)").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO visit_services (visit_id, service_id, status, referral_note) VALUES (1, 1, 'added', ?)").run('x'.repeat(501)), /CHECK/);
  db.prepare("INSERT INTO visit_services (visit_id, service_id, status, referral_note) VALUES (1, 1, 'added', ?)").run('ж'.repeat(500));
});

test('мигр. 270: удалённая строка визита снимает ссылку рекомендации, рекомендация остаётся', () => {
  const { db } = fresh();
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (1, 1, 'added')").run().lastInsertRowid);
  const rec = Number(db.prepare("INSERT INTO recommended_services (patient_id, service_id, status, visit_service_id) VALUES (1, 1, 'done', ?)").run(vs).lastInsertRowid);
  db.prepare('DELETE FROM visit_services WHERE id = ?').run(vs);
  assert.deepEqual(db.prepare('SELECT status, visit_service_id FROM recommended_services WHERE id = ?').get(rec), { status: 'done', visit_service_id: null });
});
