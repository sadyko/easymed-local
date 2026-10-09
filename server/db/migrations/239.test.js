// LIS_PROXY_V1 (мигр. 239) — ПРИЁМ ЧЕРЕЗ LIS PROXY: только ADD COLUMN.
//
// Новые колонки есть и пусты у прежних строк; via принимает только NULL и
// 'lisproxy'; таблицы не пересобраны (строки и триггер адреса мигр. 233 на
// месте); смена proxy_ip у строки BS-200 эпоху кодов и подтверждения не трогает.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function dbBefore239() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig239-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 239)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('239: колонки LIS Proxy добавлены, прежние строки не тронуты, via — только NULL или lisproxy', () => {
  const db = dbBefore239();
  db.exec(`INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled) VALUES (7, 'BS-200', 'mindray-bs-200', 'mllp', '10.0.0.40', 2575, 1);
           INSERT INTO lab_device_messages (id, device_id, raw, status) VALUES (9, 7, 'MSH|^~\\&|x', 'applied');`);
  migrate(db);
  for (const c of ['via', 'proxy_name', 'proxy_label', 'proxy_ip']) assert.ok(cols(db, 'lab_devices').includes(c), 'lab_devices.' + c);
  for (const c of ['source_body', 'reply_body']) assert.ok(cols(db, 'lab_device_messages').includes(c), 'lab_device_messages.' + c);
  assert.deepEqual(db.prepare('SELECT name, host, via, proxy_ip FROM lab_devices WHERE id = 7').get(),
    { name: 'BS-200', host: '10.0.0.40', via: null, proxy_ip: null }, 'прежняя строка — как была, via пуст');
  assert.deepEqual(db.prepare('SELECT raw, source_body, reply_body FROM lab_device_messages WHERE id = 9').get(),
    { raw: 'MSH|^~\\&|x', source_body: null, reply_body: null });
  assert.throws(() => db.prepare("UPDATE lab_devices SET via = 'mllp' WHERE id = 7").run(), /CHECK/);
  db.prepare("UPDATE lab_devices SET via = 'lisproxy' WHERE id = 7").run();
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_lab_devices_address_unstamp'").get(),
    'триггер адреса мигр. 233 на месте — таблица не пересобиралась');
});

test('239: смена proxy_ip у строки BS-200 не снимает подтверждения и не растит эпоху (триггер смотрит host и port)', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.exec(`INSERT INTO lab_devices (id, name, profile, transport, host, enabled, via, proxy_name, proxy_ip) VALUES (1, 'bs200', 'mindray-bs-200', 'mllp', '', 1, 'lisproxy', 'bs200', '192.168.1.21');
           INSERT INTO services (id, name, is_lab) VALUES (9, 'Биохимия', 1);
           INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5, 'Биохимия', 9, 1);
           INSERT INTO lab_panel_analytes (panel_id, code, name, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
             VALUES (5, 'GLU', 'Глюкоза', 'GLU', 1, 1, 0);`);
  db.prepare("UPDATE lab_devices SET proxy_ip = '192.168.1.35' WHERE id = 1").run();
  assert.equal(db.prepare('SELECT code_epoch FROM lab_devices WHERE id = 1').get().code_epoch, 0);
  assert.deepEqual(db.prepare('SELECT device_code_confirmed_device_id AS d, device_code_confirmed_epoch AS e FROM lab_panel_analytes WHERE panel_id = 5').get(), { d: 1, e: 0 });
});
