// CRM_ONE_WAY_V1 (мигр. 246, переписана до выпуска) — разметка отпущенных строк карточки
// (released_from_visit_id, released_vs_id), таблицы разового исправления (O8) и снятый
// триггер прежней 246 (O10: смена пациента карточки привязок не снимает — приватность
// держится при чтении).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function seed(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2, 'reg', 'x', 'Регистратура', 'registrar')").run();
  for (const id of [77, 78]) db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?, ?, ?)').run(id, 'Пациент ' + id, '+99890000' + id);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (77, '2026-11-01T10:00:00Z', 'scheduled', 2)").run().lastInsertRowid);
  const rid = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Лид', '+998900000077', 'in_process', 77)").run().lastInsertRowid);
  db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'patient')").run(vid, rid);
  return { vid, rid };
}

test('CRM_ONE_WAY_V1 мигр. 246: колонки отпуска строки и журнал исправления есть; триггера смены пациента нет — 77 → 78 → 77 привязку не теряет', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(crm_request_services)').all().map((c) => c.name);
  assert.ok(cols.includes('released_from_visit_id') && cols.includes('released_vs_id'));
  assert.deepEqual(db.prepare('SELECT id, done_at FROM crm_one_way_repair').all().map((r) => ({ ...r })), [{ id: 1, done_at: null }]);
  const log = db.prepare('PRAGMA table_info(crm_one_way_repair_log)').all().map((c) => c.name);
  assert.deepEqual(log, ['id', 'line_id', 'request_id', 'visit_id', 'visit_service_id', 'action', 'detail', 'created_at']);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'crm_requests_patient_display_links'").get(), undefined);
  const { vid, rid } = seed(db);
  db.prepare('UPDATE crm_requests SET patient_id = 78 WHERE id = ?').run(rid);
  db.prepare('UPDATE crm_requests SET patient_id = 77 WHERE id = ?').run(rid);
  assert.deepEqual({ ...db.prepare('SELECT visit_id, source FROM crm_booking_links WHERE request_id = ?').get(rid) }, { visit_id: vid, source: 'patient' });
});

test('CRM_ONE_WAY_V1 мигр. 246: база ветки, где прошла прежняя 246 (триггер), — после миграции триггера нет, колонки есть', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-246-'));
  try {
    for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && Number(x.slice(0, 3)) < 246)) fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
    fs.writeFileSync(path.join(tmp, '246_crm_card_patient_links.sql'), `CREATE TRIGGER IF NOT EXISTS crm_requests_patient_display_links
AFTER UPDATE OF patient_id ON crm_requests WHEN NEW.patient_id IS NOT OLD.patient_id
BEGIN DELETE FROM crm_booking_links WHERE request_id = NEW.id; END;`);
    const db = openDb(':memory:');
    migrate(db, tmp);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'crm_requests_patient_display_links'").get());
    fs.rmSync(path.join(tmp, '246_crm_card_patient_links.sql'));
    for (const f of ['246_crm_one_way.sql', '247_crm_card_visit_views.sql']) fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
    migrate(db, tmp);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'crm_requests_patient_display_links'").get(), undefined);
    assert.ok(db.prepare('PRAGMA table_info(crm_request_services)').all().some((c) => c.name === 'released_from_visit_id'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
