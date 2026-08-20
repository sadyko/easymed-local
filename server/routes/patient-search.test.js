// PATIENT_SEARCH_TOKENS_V1 / _DOB_V1 — поиск пациента через настоящий /api/db.
//
// Клиентский разбор строки проверен отдельно; здесь проверяется то, что из него
// получается в SQL: OR-группа по трём полям на каждое слово, И между словами.
// Именно эта часть была сломана — прежний поиск умел только непрерывную
// подстроку full_name, а по ID и телефону не искал вовсе, хотя обещал в
// плейсхолдере.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';

const PEOPLE = [
  ['Эргашев Жахонгир Нурийигит Ўғли', 'P-26-70002', '998948776767', '2004-02-17'],
  ['Тавбаева Малика Тохир Қизи',      'P-26-70001', '998904888000', '1990-12-10'],
  ['Ғаниева Зохида Иномовна',         'P-26-70000', '998915647400', '1974-10-12'],
  ['Эргашева Малика Собировна',       'P-26-69990', '998901112233', '1990-12-10'],
];

function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('reg', hashPassword('password1'), 'Регистратор', 'registrar');
  for (const [full_name, mrn, phone, dob] of PEOPLE) {
    db.prepare('INSERT INTO patients (full_name, mrn, phone, date_of_birth) VALUES (?,?,?,?)').run(full_name, mrn, phone, dob);
  }
  return new Promise((resolve) => {
    const server = createApp(db).listen(0, '127.0.0.1', () => {
      resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
async function login(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reg', password: 'password1' }),
  });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
// Exactly what data.js builds: one .or() group per word.
async function search(base, cookie, words, dob) {
  const filters = words.map((w) => ({ or: [
    { col: 'full_name', op: 'ilike', val: `%${w}%` },
    { col: 'mrn',       op: 'ilike', val: `%${w}%` },
    { col: 'phone',     op: 'ilike', val: `%${w}%` },
  ] }));
  if (dob) filters.push({ col: 'date_of_birth', op: 'eq', val: dob });
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ table: 'patients', op: 'select', columns: '*', filters }),
  });
  const json = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, JSON.stringify(json));
  return (json.data || []).map((p) => p.full_name);
}

test('кусок фамилии + кусок имени находит пациента', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);

  const found = await search(base, cookie, ['Эрг', 'Жах']);

  assert.deepEqual(found, ['Эргашев Жахонгир Нурийигит Ўғли'],
    'прежний поиск искал «Эрг Жах» одной подстрокой и не находил никого');
});

test('порядок слов не важен — фамилию и имя часто путают местами', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);
  assert.deepEqual(await search(base, cookie, ['Жах', 'Эрг']), ['Эргашев Жахонгир Нурийигит Ўғли']);
});

// И между словами: одно «Эрг» даёт двух однофамильцев, «Эрг Жах» — одного.
test('каждое слово сужает выборку', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);
  assert.equal((await search(base, cookie, ['Эрг'])).length, 2);
  assert.equal((await search(base, cookie, ['Эрг', 'Малика'])).length, 1);
});

test('поиск по номеру карты и по телефону — то, что обещает плейсхолдер', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);
  assert.deepEqual(await search(base, cookie, ['70001']), ['Тавбаева Малика Тохир Қизи']);
  assert.deepEqual(await search(base, cookie, ['9156474']), ['Ғаниева Зохида Иномовна']);
});

test('дата рождения находит тёзок и сужается вместе с именем', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);

  const sameDay = await search(base, cookie, [], '1990-12-10');
  assert.equal(sameDay.length, 2, 'в один день родились двое');
  assert.deepEqual(await search(base, cookie, ['Малика'], '1990-12-10').then(r => r.sort()),
    ['Тавбаева Малика Тохир Қизи', 'Эргашева Малика Собировна']);
  assert.deepEqual(await search(base, cookie, ['Эрг'], '1990-12-10'), ['Эргашева Малика Собировна']);
});
