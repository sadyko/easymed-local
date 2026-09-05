// TPL_BODY_JSON_V1 (2026-09-05) — «Шаблоны заключений» не создавались и не
// сохранялись НИ РАЗУ.
//
// Владелец: «also we cannot create or save the templates».
//
// Причина одна и не в правах: тело шаблона — это карта разделов документа
// ({chief_complaint: '…', therapy_text: '…'}), то есть ОБЪЕКТ, а колонка
// `body` в реестре не была объявлена JSON-колонкой. Компилятор связывает
// только строки, числа и NULL и на объект отвечает 400 «unsupported value
// type» — на КАЖДОЕ сохранение, и на создание, и на изменение. Окно при этом
// говорило только «Не удалось сохранить», поэтому со стороны это выглядело
// как «шаблоны просто не работают».
//
// Проверяется весь путь целиком, через настоящий /api/db: объект уходит,
// ложится в TEXT, читается обратно ОБЪЕКТОМ (parseJsonColumns в routes/db.js).
// Тест компилятора в отрыве этого не доказал бы: половина механизма живёт на
// обратном пути, и без неё шаблон сохранился бы, а открылся строкой.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const BODY = {
  chief_complaint: 'Боль в горле, температура 37,8',
  therapy_text:    'Полоскание, обильное питьё',
  recommendations_text: 'Повторный приём через 3 дня',
};

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('doc', hashPassword('password1'), 'Каримова Азиза', 'doctor');
  const server = await listen(createApp(db));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function login(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'doc', password: 'password1' }),
  });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
async function db(base, cookie, payload) {
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('шаблон заключения создаётся: тело-объект уходит и возвращается объектом', async (t) => {
  const { db: conn, server, base } = await startServer();
  t.after(() => { server.close(); conn.close(); });
  const cookie = await login(base);

  const made = await db(base, cookie, {
    table: 'consultation_templates', op: 'insert',
    values: [{ name: 'ОРВИ — первичный', scope: 'private', doc_type: 0, body: BODY, author_id: 1, author_name: 'Каримова Азиза' }],
    columns: '*',
  });
  assert.equal(made.status, 200, 'сохранение отвечало 400 «unsupported value type»: ' + JSON.stringify(made.json));

  const read = await db(base, cookie, { table: 'consultation_templates', op: 'select', columns: '*', filters: [] });
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.equal(read.json.data.length, 1);
  const row = read.json.data[0];
  assert.equal(row.name, 'ОРВИ — первичный');
  // Именно ОБЪЕКТ, а не строка: окно шаблонов читает body.chief_complaint
  // напрямую, и строка означала бы пустые разделы у сохранённого шаблона.
  assert.deepEqual(row.body, BODY, 'тело шаблона вернулось не разобранным: ' + typeof row.body);
  // TPL_AUTHOR_LOCAL_V1 — без автора окно считает СВОЙ шаблон чужим и сразу
  // после сохранения прячет «Изменить» и «Удалить».
  assert.equal(row.author_id, 1, 'автор шаблона не сохранился');
});

test('шаблон изменяется: правка тела не отвергается и не теряет разделы', async (t) => {
  const { db: conn, server, base } = await startServer();
  t.after(() => { server.close(); conn.close(); });
  const cookie = await login(base);

  const made = await db(base, cookie, {
    table: 'consultation_templates', op: 'insert',
    values: [{ name: 'ОРВИ', scope: 'private', doc_type: 0, body: BODY, author_name: 'Каримова Азиза' }],
    columns: '*',
  });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const first = await db(base, cookie, { table: 'consultation_templates', op: 'select', columns: '*', filters: [] });
  const id = first.json.data[0].id;

  const next = { ...BODY, therapy_text: 'Полоскание, жаропонижающее при t > 38,5' };
  const upd = await db(base, cookie, {
    table: 'consultation_templates', op: 'update',
    values: { name: 'ОРВИ — взрослые', scope: 'shared', doc_type: 0, body: next },
    filters: [{ col: 'id', op: 'eq', val: id }],
  });
  assert.equal(upd.status, 200, 'правка отвергалась ровно так же, как создание: ' + JSON.stringify(upd.json));

  const read = await db(base, cookie, { table: 'consultation_templates', op: 'select', columns: '*', filters: [] });
  const row = read.json.data[0];
  assert.equal(row.name, 'ОРВИ — взрослые');
  assert.equal(row.scope, 'shared');
  assert.deepEqual(row.body, next);
});
