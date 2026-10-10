// REFERENCE_LISTS_V1 (полировка, 2026-10-10) — КОДЫ ГЕОГРАФИИ КЛИНИКА НЕ МЕНЯЕТ.
//
// Партнёры по API клиники получают коды страны, города и района (миграция 132,
// shared/geo-codes.js). До этой правки /api/db пускал любого администратора
// клиники менять, стирать и удалять эти строки вместе с кодами: код, изменённый
// в одной клинике, переставал совпадать у партнёра.
//
// Теперь:
//   • код строки не меняется и не стирается (правка с тем же кодом — проходит);
//   • строку встроенного справочника (код бланка) удалить нельзя — её выключают;
//   • новый код не может повторить уже занятый или код бланка.
// Редактор «География» (sections.js: countries — name / code / active, regions и
// districts — родитель / name / active; удаление по id) работает как работал:
// переименовать, выключить, завести свою строку, удалить свою.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { STRINGS } from '../../public/js/admin/i18n-strings.js';

const FIXED = 'Код в справочнике не меняется никогда: по нему партнёры узнают страну, город и район. Название поменять можно — код останется прежним.';
const TAKEN = 'Такой код в справочнике уже есть — у каждой строки свой код.';
const BUILTIN = 'Строку встроенного справочника удалить нельзя: её код получают партнёры. Её можно выключить.';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (desc) => {
    const r = await fetch(base + '/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(desc) });
    return { status: r.status, body: await r.json() };
  };
  return { db, call, stop() { server.close(); db.close(); } };
}
const byId = (id) => [{ col: 'id', op: 'eq', val: id }];
const idOf = (db, table, code) => db.prepare(`SELECT id FROM ${table} WHERE code = ?`).get(code).id;
const rowOf = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
function refused(res, message) {
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'conflict');
  assert.equal(res.body.error.message, message);
}

test('код строки не меняется и не стирается: страна, регион, район — 409, база не тронута', async () => {
  const t = await startServer();
  try {
    const uz = idOf(t.db, 'countries', 'UZ');
    const tash = idOf(t.db, 'regions', 'tashkent-city');
    const bek = idOf(t.db, 'districts', 'bektemir');
    for (const [table, id, values] of [
      ['countries', uz, { code: 'UZB' }],
      ['countries', uz, { name: 'Узбекистан', code: '', active: true }],   // форма «Географии» со стёртым кодом
      ['regions', tash, { code: 'tashkent-capital' }],
      ['districts', bek, { code: null }],
      ['districts', bek, { name: 'Бектемир', code: 'bektemir-2' }],
    ]) {
      refused(await t.call({ table, op: 'update', values, filters: byId(id) }), FIXED);
    }
    assert.equal(rowOf(t.db, 'countries', uz).code, 'UZ');
    assert.equal(rowOf(t.db, 'regions', tash).code, 'tashkent-city');
    assert.deepEqual([rowOf(t.db, 'districts', bek).code, rowOf(t.db, 'districts', bek).name], ['bektemir', 'Бектемирский район']);

    // Одна правка на много строк — тоже нет.
    const many = t.db.prepare('SELECT id FROM districts WHERE region_id = ?').all(tash).map((r) => r.id);
    refused(await t.call({ table: 'districts', op: 'update', values: { code: 'x' }, filters: [{ col: 'id', op: 'in', val: many }] }), FIXED);
  } finally { t.stop(); }
});

test('строку встроенного справочника удалить нельзя — 409 со словами «её можно выключить»; строка на месте', async () => {
  const t = await startServer();
  try {
    for (const [table, code] of [['countries', 'AF'], ['regions', 'karakalpakstan'], ['districts', 'bektemir'], ['districts', 'nukus-shahri']]) {
      const id = idOf(t.db, table, code);
      refused(await t.call({ table, op: 'delete', filters: byId(id) }), BUILTIN);
      assert.ok(rowOf(t.db, table, id), table + ' ' + code + ' удалён');
    }
    // Удаление пачкой, задевающее строку бланка, — тоже нет (и своя строка в пачке остаётся).
    const tash = idOf(t.db, 'regions', 'tashkent-city');
    const own = t.db.prepare("INSERT INTO districts (region_id, name) VALUES (?, 'Свой район')").run(tash).lastInsertRowid;
    refused(await t.call({ table: 'districts', op: 'delete', filters: [{ col: 'id', op: 'in', val: [own, idOf(t.db, 'districts', 'chilonzor')] }] }), BUILTIN);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM districts WHERE region_id = ?').get(tash).n, 13);
  } finally { t.stop(); }
});

test('новый код не повторяет занятый и код бланка: вставка (и пачкой) — 409', async () => {
  const t = await startServer();
  try {
    const tash = idOf(t.db, 'regions', 'tashkent-city');
    const uz = idOf(t.db, 'countries', 'UZ');
    refused(await t.call({ table: 'districts', op: 'insert', values: { region_id: tash, name: 'Двойник', code: 'bektemir', active: true } }), TAKEN);
    refused(await t.call({ table: 'countries', op: 'insert', values: { name: 'Ещё Узбекистан', code: 'UZ', active: true } }), TAKEN);
    refused(await t.call({ table: 'regions', op: 'insert', values: { country_id: uz, name: 'Наманган-2', code: 'namangan', active: true } }), TAKEN);
    refused(await t.call({ table: 'countries', op: 'insert', values: [
      { name: 'Турция', code: 'TR', active: true }, { name: 'Турция-2', code: 'TR', active: true }] }), TAKEN);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM districts WHERE name = 'Двойник'").get().n, 0);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM countries WHERE code = 'TR'").get().n, 0, 'пачка не легла наполовину');
  } finally { t.stop(); }
});

test('«География» работает как работала: переименовать, выключить, завести и удалить свою строку', async () => {
  const t = await startServer();
  try {
    const uz = idOf(t.db, 'countries', 'UZ');
    const tash = idOf(t.db, 'regions', 'tashkent-city');
    const bek = idOf(t.db, 'districts', 'bektemir');
    const ok = (res) => assert.equal(res.status, 200, JSON.stringify(res.body));

    // Страна: форма шлёт name / code / active — код как был.
    ok(await t.call({ table: 'countries', op: 'update', values: { name: 'Республика Узбекистан', code: 'UZ', active: true }, filters: byId(uz) }));
    assert.deepEqual([rowOf(t.db, 'countries', uz).name, rowOf(t.db, 'countries', uz).code], ['Республика Узбекистан', 'UZ']);
    // Регион и район: форма шлёт родителя / name / active — кода в ней нет.
    ok(await t.call({ table: 'regions', op: 'update', values: { country_id: uz, name: 'город Ташкент (столица)', active: true }, filters: byId(tash) }));
    ok(await t.call({ table: 'districts', op: 'update', values: { region_id: tash, name: 'Бектемир', active: false }, filters: byId(bek) }));
    assert.deepEqual([rowOf(t.db, 'districts', bek).name, rowOf(t.db, 'districts', bek).active, rowOf(t.db, 'districts', bek).code],
      ['Бектемир', 0, 'bektemir'], 'переименован и выключен, код — прежний');

    // Своя страна со своим кодом, свой регион и район без кода.
    ok(await t.call({ table: 'countries', op: 'insert', values: { name: 'Турция', code: 'TR', active: true } }));
    ok(await t.call({ table: 'countries', op: 'insert', values: { name: 'Грузия', code: null, active: true } }));
    ok(await t.call({ table: 'regions', op: 'insert', values: { country_id: uz, name: 'Своя область', active: true } }));
    const ownRegion = t.db.prepare("SELECT id FROM regions WHERE name = 'Своя область'").get().id;
    ok(await t.call({ table: 'districts', op: 'insert', values: { region_id: ownRegion, name: 'Свой район', active: true } }));
    const ownDistrict = t.db.prepare("SELECT id FROM districts WHERE name = 'Свой район'").get().id;

    // Своя строка без кода получает код, если он не занят; занятый — нет.
    const ge = t.db.prepare("SELECT id FROM countries WHERE name = 'Грузия'").get().id;
    refused(await t.call({ table: 'countries', op: 'update', values: { name: 'Грузия', code: 'KZ', active: true }, filters: byId(ge) }), TAKEN);
    ok(await t.call({ table: 'countries', op: 'update', values: { name: 'Грузия', code: 'GE', active: true }, filters: byId(ge) }));
    assert.equal(rowOf(t.db, 'countries', ge).code, 'GE');

    // Свои строки удаляются.
    ok(await t.call({ table: 'districts', op: 'delete', filters: byId(ownDistrict) }));
    ok(await t.call({ table: 'regions', op: 'delete', filters: byId(ownRegion) }));
    ok(await t.call({ table: 'countries', op: 'delete', filters: byId(idOf(t.db, 'countries', 'TR')) }));
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM countries WHERE code = 'TR'").get().n, 0);
    assert.equal(rowOf(t.db, 'districts', ownDistrict), undefined);
  } finally { t.stop(); }
});

test('объяснения отказов — статьи словаря на трёх языках', () => {
  for (const msg of [FIXED, TAKEN, BUILTIN]) {
    const e = STRINGS[msg];
    assert.ok(e && e.ru === msg && e.uz && e.en, 'нет статьи словаря: ' + msg);
  }
});
