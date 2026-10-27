// REFERRALS_CRM_V1 — миграция 253: таблицы бота для врачей-источников.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dirUpTo(max) {
  const tmp = tmpDir('em-mig253-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}
const tables = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));

test('до 253 таблиц бота нет, после — четыре, строка настроек одна и выключена', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(252));
  for (const t of ['doctor_bot_settings', 'doctor_bot_links', 'doctor_bot_state', 'doctor_bot_notifications']) assert.ok(!tables(db).has(t), t);
  migrate(db, dirUpTo(253));
  for (const t of ['doctor_bot_settings', 'doctor_bot_links', 'doctor_bot_state', 'doctor_bot_notifications']) assert.ok(tables(db).has(t), t + ' не создана');
  const row = db.prepare('SELECT * FROM doctor_bot_settings').all();
  assert.equal(row.length, 1);
  assert.equal(row[0].id, 1);
  assert.equal(row[0].enabled, 0);
  assert.equal(row[0].bot_token_enc, '');
  assert.throws(() => db.prepare('INSERT INTO doctor_bot_settings (id) VALUES (2)').run(), 'вторая строка настроек запрещена');
});

test('один визит — одно уведомление; уведомление переживает удаление связки без неё (link_id → NULL)', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (3, 'doc', 'x', 'doctor', 'Врач')").run();
  db.prepare("INSERT INTO referral_sources (name, first_name, phone) VALUES ('Внешний Врач', 'Внешний', '+998901234567')").run();
  const src = db.prepare("SELECT id FROM referral_sources WHERE name = 'Внешний Врач'").get().id;
  db.prepare("INSERT INTO patients (id, full_name, phone, referral_source_id) VALUES (10, 'Пациент', '+998900000001', ?)").run(src);
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (100, 10, 3, '2026-10-26T07:00:00.000Z', 'arrived')").run();
  db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone) VALUES (?, '555', '998901234567')").run(src);
  const link = db.prepare('SELECT id FROM doctor_bot_links').get().id;
  db.prepare("INSERT INTO doctor_bot_notifications (visit_id, referral_source_id, link_id, chat_id, text) VALUES (100, ?, ?, '555', 'x')").run(src, link);
  assert.throws(() => db.prepare("INSERT INTO doctor_bot_notifications (visit_id, referral_source_id, link_id, chat_id, text) VALUES (100, ?, ?, '555', 'y')").run(src, link),
    'второе уведомление по тому же визиту');
  // Источники в приложении не удаляются ни одной ролью (реестр: delete roles []),
  // поэтому каскад от источника проверять не на чем; связку же удалить можно,
  // и журнал уведомлений при этом остаётся — плитка «за 30 дней» не худеет.
  db.prepare('DELETE FROM doctor_bot_links WHERE id = ?').run(link);
  const n = db.prepare('SELECT link_id, visit_id FROM doctor_bot_notifications').get();
  assert.equal(n.link_id, null);
  assert.equal(n.visit_id, 100);
});
