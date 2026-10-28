// FIX_318_V1 (H3 + M2) — миграция 257: подключение врача к боту ждёт
// подтверждения администратора; выключенный врач или врач со сменённым
// номером теряет подключение сразу (триггер).
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
  const tmp = tmpDir('em-mig257-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}
const cols = (db) => new Map(db.prepare('PRAGMA table_info(doctor_bot_links)').all().map((c) => [c.name, c]));

test('мигр. 257: статус подключения (по умолчанию «ожидает»), кто и когда подтвердил; прежние связки — тоже ждут подтверждения', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(256));
  db.prepare("INSERT INTO referral_sources (name, first_name, phone) VALUES ('Врач До', 'До', '+998901234567')").run();
  const src = db.prepare("SELECT id FROM referral_sources WHERE name = 'Врач До'").get().id;
  db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone) VALUES (?, '555', '998901234567')").run(src);
  assert.ok(!cols(db).has('status'));
  migrate(db, dirUpTo(257));
  const c = cols(db);
  for (const n of ['status', 'confirmed_at', 'confirmed_by']) assert.ok(c.has(n), 'doctor_bot_links.' + n);
  assert.equal(db.prepare('SELECT status FROM doctor_bot_links').get().status, 'pending',
    'подключение, сделанное без подтверждения, ждёт администратора');
  db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone) VALUES (?, '556', '998901234567')").run(src);
  assert.equal(db.prepare("SELECT status FROM doctor_bot_links WHERE chat_id = '556'").get().status, 'pending', 'новое — тоже');
  assert.throws(() => db.prepare("UPDATE doctor_bot_links SET status = 'maybe'").run(), /CHECK/);
});

test('мигр. 257: выключили врача или сменили номер — его подключения отозваны; смена только записи номера — нет; чужие подключения не тронуты', () => {
  const db = openDb(':memory:');
  migrate(db);
  const src = db.prepare('INSERT INTO referral_sources (name, first_name, phone) VALUES (?,?,?)');
  const A = Number(src.run('Врач А', 'А', '+998 90 123 45 67').lastInsertRowid);
  const B = Number(src.run('Врач Б', 'Б', '+998 91 765 43 21').lastInsertRowid);
  const link = db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone, status) VALUES (?, ?, ?, 'confirmed')");
  link.run(A, '1', '998901234567');
  link.run(B, '2', '998917654321');
  const revoked = (chat) => db.prepare('SELECT revoked_at FROM doctor_bot_links WHERE chat_id = ?').get(chat).revoked_at;

  db.prepare("UPDATE referral_sources SET phone = '998901234567' WHERE id = ?").run(A);   // та же цифра, другая запись
  assert.equal(revoked('1'), null, 'формат номера — не смена номера');
  db.prepare("UPDATE referral_sources SET phone = '+998 90 000 00 00' WHERE id = ?").run(A);
  assert.ok(revoked('1'), 'номер сменился — подключение отозвано');
  assert.equal(revoked('2'), null, 'другой врач не тронут');

  db.prepare('UPDATE referral_sources SET active = 0 WHERE id = ?').run(B);
  assert.ok(revoked('2'), 'врача выключили — подключение отозвано');
  db.prepare('UPDATE referral_sources SET active = 1 WHERE id = ?').run(B);
  assert.ok(revoked('2'), 'включили обратно — подключение не воскресает, врач подключается заново');
});
