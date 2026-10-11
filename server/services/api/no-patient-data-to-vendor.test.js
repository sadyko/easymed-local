// PUBLIC_API_V1 — СТРАЖ СПЕЦИФИКАЦИИ «Сервер»: очередь заявок — на отдельном
// публичном сервере, НЕ на сервере лицензий; на сервере лицензий нет и не будет
// данных пациентов.
//
// Проверяется двумя сторонами:
//   1. клиника: модули API (services/api/*.js) говорят только с публичным
//      сервером — адреса и переменной сервера лицензий в них нет; адрес по
//      умолчанию — api.easymed.uz;
//   2. сервер лицензий (control-plane/): в его базе нет таблиц и колонок
//      пациентов, визитов, заявок и записей, а в маршрутах — адресов заявок и
//      онлайн-записи. Заявка партнёра, отправленная туда по ошибке, не нашла
//      бы, куда лечь.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb as openCpDb } from '../../../control-plane/server/db/connection.js';
import { migrate as migrateCp } from '../../../control-plane/server/db/migrate.js';
import { DEFAULT_PUBLIC_URL } from './public-sync.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

test('клиника: модули API не знают адреса сервера лицензий; адрес обмена — api.easymed.uz', () => {
  assert.equal(new URL(DEFAULT_PUBLIC_URL).hostname, 'api.easymed.uz');
  const files = fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  assert.ok(files.includes('public-sync.js') && files.includes('bookings.js'));
  const bad = [];
  for (const f of files) {
    const src = strip(fs.readFileSync(path.join(HERE, f), 'utf8'));
    for (const mark of ['settings.easymed.uz', 'EASYMED_CONTROL_URL', 'install_token', '/cp/v1/']) {
      if (src.includes(mark)) bad.push(f + ': ' + mark);
    }
  }
  assert.deepEqual(bad, []);
});

test('сервер лицензий: ни таблиц, ни колонок пациентов, визитов, заявок и записей', () => {
  const db = openCpDb(':memory:');
  migrateCp(db);
  const BAD = /patient|visit|diagnos|appointment|booking|slot|request_id|api_request|crm|full_name_ru|date_of_birth/i;
  const bad = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (BAD.test(name)) bad.push(name);
    for (const c of db.prepare(`PRAGMA table_info(${name})`).all()) if (BAD.test(c.name)) bad.push(name + '.' + c.name);
  }
  assert.deepEqual(bad, []);
});

test('сервер лицензий: в маршрутах нет адресов заявок, онлайн-записи и очереди', () => {
  const dir = path.join(REPO, 'control-plane', 'server', 'routes');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
    const src = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const m of src.matchAll(/['"`](\/[^'"`]*)['"`]/g)) {
      // «/requests» панели производителя (admin.js) — просьбы клиник о модулях, не заявки пациентов.
      if (/\/(appointments|inbox|_sync|slots|patients)\b/.test(m[1])) bad.push(f + ': ' + m[1]);
    }
  }
  assert.deepEqual(bad, []);
});
