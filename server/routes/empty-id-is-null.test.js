// EMPTY_ID_IS_NULL_V1 (2026-09-16) — ПУСТОЙ ВЫБОР В ССЫЛОЧНОЙ КОЛОНКЕ ЭТО NULL.
//
// Владелец: «i cant register patient». Окно заведения пациента отправляло
// `category_id: ""` — так выглядит невыбранный выпадающий список, — и SQLite
// отвечал «FOREIGN KEY constraint failed»: пустая строка для него не «ничего не
// выбрано», а ссылка на строку справочника с идентификатором «». Карта не
// создавалась вовсе.
//
// Правило живёт в одном месте (db/query-compiler.js bindWrite) и потому
// действует на все таблицы, и на вставку, и на правку. Ссылки узнаём У БАЗЫ
// (PRAGMA foreign_key_list), а не по имени: `national_id` — это ПИНФЛ, обычный
// текст и NOT NULL, и правило «всё, что кончается на _id» роняло бы вставку уже
// по другой причине.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (body) => {
    const r = await fetch(base + '/api/db', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  return { db, server, api };
}

test('пациент заводится, когда категория не выбрана: пустая ссылка — это NULL', async (t) => {
  const { db, server, api } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const res = await api({
    table: 'patients', op: 'insert', columns: '*', filters: [], order: [],
    values: {
      last_name: 'Тестова', first_name: 'Проба', full_name: 'Тестова Проба',
      date_of_birth: '1994-11-15', gender: 'female',
      // так выглядят НЕЗАПОЛНЕННЫЕ поля окна регистрации
      category_id: '', branch_id: '', payer_id: '', primary_doctor_id: '',
      national_id: '', address: '', country: '',
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const row = db.prepare("SELECT category_id, branch_id, payer_id, national_id, address FROM patients WHERE full_name = 'Тестова Проба'").get();
  assert.equal(row.category_id, null, 'пустая категория обязана лечь как NULL');
  assert.equal(row.branch_id, null);
  assert.equal(row.payer_id, null);
  // …а пустая строка в ОБЫЧНОЙ колонке остаётся пустой строкой: там она значит
  // «не заполнено», и подменять её на NULL нельзя (ПИНФЛ — NOT NULL).
  assert.equal(row.national_id, '');
  assert.equal(row.address, '');
});

test('выбранная категория сохраняется как число, а не теряется вместе с правилом', async (t) => {
  const { db, server, api } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const catId = db.prepare("INSERT INTO patient_categories (name) VALUES ('Сотрудник')").run().lastInsertRowid;

  const res = await api({
    table: 'patients', op: 'insert', columns: '*', filters: [], order: [],
    values: { last_name: 'Ким', first_name: 'Олег', full_name: 'Ким Олег', date_of_birth: '1980-05-05', gender: 'male', category_id: String(catId) },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(db.prepare("SELECT category_id FROM patients WHERE full_name = 'Ким Олег'").get().category_id, catId);
});

test('правка карты тем же правилом: категорию можно СНЯТЬ', async (t) => {
  const { db, server, api } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const catId = db.prepare("INSERT INTO patient_categories (name) VALUES ('Сотрудник')").run().lastInsertRowid;
  db.prepare("INSERT INTO patients (full_name, mrn, date_of_birth, gender, category_id) VALUES ('Ким Олег','K-1','1980-05-05','male',?)").run(catId);
  const id = db.prepare("SELECT id FROM patients WHERE full_name = 'Ким Олег'").get().id;

  const res = await api({
    table: 'patients', op: 'update', columns: '*', filters: [{ col: 'id', op: 'eq', val: id }], order: [],
    values: { category_id: '' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(db.prepare('SELECT category_id FROM patients WHERE id = ?').get(id).category_id, null);
});

// PATIENT_DUP_RULE_V2 — поиск дублей спрашивает фамилию и имя; без этих колонок
// в списке фильтров сервер отвечал «unknown filter column», экран молча глотал
// отказ, и предупреждение о повторной карте не показывалось ни разу.
test('поиск дублей может фильтровать по фамилии и имени', async (t) => {
  const { db, server, api } = await startServer();
  t.after(() => { server.close(); db.close(); });
  db.prepare("INSERT INTO patients (full_name, mrn, last_name, first_name, date_of_birth, gender) VALUES ('Тестова Проба','T-1','Тестова','Проба','1994-11-15','female')").run();

  for (const col of ['last_name', 'first_name']) {
    const res = await api({
      table: 'patients', op: 'select', columns: 'id, last_name, first_name',
      filters: [{ col, op: 'ilike', val: 'Те%' }], order: [], limit: 60,
    });
    assert.equal(res.status, 200, col + ': ' + JSON.stringify(res.json));
  }
  const hit = await api({
    table: 'patients', op: 'select', columns: 'id, last_name',
    filters: [{ col: 'last_name', op: 'ilike', val: 'Тест%' }], order: [], limit: 60,
  });
  assert.equal(hit.json.data.length, 1, 'однофамильца не нашли — предупреждение о дубле снова молчит');
});
