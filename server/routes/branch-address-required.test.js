// CLINIC_API_STEP7_V1 — решение владельца 11 ПО ЗДАНИЯМ через настоящее приложение
// (план шага 7, «Шагам 4, 8 и 9» и «Завершение» п. 5): пока включено подключение
// API, у филиала, показанного на сайте, адрес для партнёров полный —
//   • /api/db: сохранение такого филиала без района / улицы и включение «Показывать
//     на сайте» у филиала с неполным адресом — 400 partner_address_required с полем;
//   • RPC: подключение не включается, пока такой филиал есть — 409, сообщение
//     называет здание (шаблон и значения — клиенту, он переводит фразу);
//   • скрытый филиал не проверяется; последнее подключение выключено — правило снято.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { insertConnectionRow } from '../test-helpers/api-connection-row.js';
import { STRINGS } from '../../public/js/admin/i18n-strings.js';

async function setup() {
  const dataDir = licensedDataDir();
  const db = openDb(path.join(dataDir, 'easymed.db'));
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run('boss', hashPassword('password1'), 'Босс', 'admin');
  db.prepare(`UPDATE doc_settings SET clinic_name = 'Шифо', region_code = 'tashkent-city', district_code = 'yunusobod',
    street_ru = 'ул. Мира, 1' WHERE id = 1`).run();
  const branch = Number(db.prepare(`INSERT INTO branches (name, letter, region_code, district_code, street_ru, show_public)
    VALUES ('Чиланзар', 'C', 'tashkent-city', 'chilonzor', 'ул. Бунёдкор, 5', 1)`).run().lastInsertRowid);
  const server = await listen(createApp(db, { dataDir }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }) });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  return {
    db, branch,
    dbCall: (body) => post('/api/db', body),   // CLINIC_API_STEP7_V1 (ревью слияния №3) — запрос /api/db как есть
    saveBranch: (values, id = branch) => post('/api/db', { table: 'branches', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] }),
    rpc: (name, body) => post('/api/rpc/' + name, body),
    stop() { server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('филиал на сайте без района при включённом подключении — 400 с полем, база не тронута; полный адрес и скрытие — проходят', async () => {
  const t = await setup();
  try {
    insertConnectionRow(t.db);
    const bad = await t.saveBranch({ district_code: '' });
    assert.equal(bad.status, 400);
    const { error } = await bad.json();
    assert.deepEqual([error.code, error.field], ['partner_address_required', 'district_code']);
    assert.ok(STRINGS[error.message] && STRINGS[error.message].uz && STRINGS[error.message].en, 'сообщение переведено');
    assert.equal(t.db.prepare('SELECT district_code FROM branches WHERE id = ?').get(t.branch).district_code, 'chilonzor', 'строка не тронута');
    assert.equal((await t.saveBranch({ name_uz: 'Chilonzor' })).status, 200, 'адрес полон — правка проходит');
    t.db.prepare("UPDATE branches SET district_code = '' WHERE id = ?").run(t.branch);
    assert.equal((await t.saveBranch({ show_public: 0 })).status, 200, 'скрыть филиал с неполным адресом можно');
    const show = await t.saveBranch({ show_public: 1 });
    assert.equal(show.status, 400, 'показать на сайте с неполным адресом нельзя');
    assert.equal((await show.json()).error.field, 'district_code');
    assert.equal((await t.saveBranch({ name_en: 'Chilanzar' })).status, 200, 'скрытый филиал не проверяется');
    t.db.prepare('UPDATE api_connections SET active = 0').run();
    assert.equal((await t.saveBranch({ show_public: 1 })).status, 200, 'последнее подключение выключено — правило снято');
  } finally { t.stop(); }
});

test('подключение не включается, пока филиал на сайте без адреса: 409, сообщение называет здание; скрыли — включается', async () => {
  const t = await setup();
  try {
    const id = insertConnectionRow(t.db, { active: 0 });
    t.db.prepare("UPDATE branches SET district_code = '' WHERE id = ?").run(t.branch);
    const res = await t.rpc('api_connection_update', { id, active: true });
    assert.equal(res.status, 409);
    const { error } = await res.json();
    assert.equal(error.code, 'branch_address_required');
    assert.ok(error.message.includes('«Чиланзар»'), error.message);
    assert.ok(STRINGS[error.template] && STRINGS[error.template].uz && STRINGS[error.template].en, 'шаблон — статья словаря');
    assert.deepEqual(error.params, { name: 'Чиланзар' });
    assert.equal(t.db.prepare('SELECT active FROM api_connections WHERE id = ?').get(id).active, 0, 'подключение осталось выключенным');
    t.db.prepare('UPDATE branches SET show_public = 0 WHERE id = ?').run(t.branch);
    assert.equal((await t.rpc('api_connection_update', { id, active: true })).status, 200, 'скрытый филиал не мешает');
  } finally { t.stop(); }
});

// CLINIC_API_STEP7_V1 (ревью слияния №3) — собранные руками запросы не обходят правило:
// отбор «in» строкой «(id)» рядом с «eq» и вставка с active: 0 (active при вставке не
// пишется — здание ляжет работающим и видимым на сайте).
test('/api/db: «eq» + «in» строкой и вставка с active: 0 — 400, база не тронута', async () => {
  const t = await setup();
  try {
    insertConnectionRow(t.db);
    t.db.prepare("UPDATE branches SET district_code = '', show_public = 0 WHERE id = ?").run(t.branch);   // скрытое, неполное — допустимо
    const post = t.dbCall;
    const bypass = await post({ table: 'branches', op: 'update', values: { show_public: 1 },
      filters: [{ col: 'id', op: 'eq', val: t.branch }, { col: 'id', op: 'in', val: `(${t.branch})` }] });
    assert.equal(bypass.status, 400);
    assert.equal((await bypass.json()).error.code, 'partner_address_required');
    assert.equal(t.db.prepare('SELECT show_public FROM branches WHERE id = ?').get(t.branch).show_public, 0, 'здание осталось скрытым');
    const n = t.db.prepare('SELECT COUNT(*) AS n FROM branches').get().n;
    const ins = await post({ table: 'branches', op: 'insert', values: { name: 'Юнусабад', active: 0 } });
    assert.equal(ins.status, 400);
    assert.equal((await ins.json()).error.field, 'region_code');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM branches').get().n, n, 'здание не заведено');
  } finally { t.stop(); }
});
