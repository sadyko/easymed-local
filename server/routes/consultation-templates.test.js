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
import { licensedDataDir } from '../services/control/licensed-fixture.js';   // LICENCE_FIXTURE_V1
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
// LICENCE_FIXTURE_V1 — каталог данных задаётся ЯВНО. createApp(db) без него
// берёт настоящую папку ./data проекта: на машине разработчика она активирована,
// а на сборочной — нет, и тест «работает у меня» падает в сборке (так и вышло
// с v0.9.0). Права лицензии этот файл не проверяет, поэтому берёт готовую.
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
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

// ---------------------------------------------------------------------------
// CABINET_FIX_V1_TPL (2026-10-02) — «ЛИЧНЫЙ» ЛИЧНЫЙ НА СЕРВЕРЕ, doc_type СТРОКОЙ.
//
// Найдено чтением кода и проверено: строки шаблонов на сервере не были
// ограничены ничем. «Все» в окне шаблонов показывали чужие личные шаблоны, а
// любой врач через /api/db правил и удалял любой шаблон — кнопки «Изменить» и
// «Удалить» прятал только экран. Теперь правило в реестре (schema-registry.js,
// scope + readAlso): личный читает автор и администратор, общий — все; правит и
// удаляет — автор или администратор; автора ставит сервер из сессии.
//
// doc_type — TEXT, а окно слало число: better-sqlite3 связывает число как REAL,
// и в базе dev шаблон диагностики лежит как '1.0'. Колонка объявлена в реестре
// текстовой (`text`), и число пишется строкой '1'.
// ---------------------------------------------------------------------------
async function startClinic() {
  const conn = openDb(':memory:');
  migrate(conn);
  const add = conn.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)');
  const ids = {
    doc:   add.run('doc',   hashPassword('password1'), 'Каримова Азиза', 'doctor').lastInsertRowid,
    doc2:  add.run('doc2',  hashPassword('password1'), 'Юсупов Бахтиёр', 'doctor').lastInsertRowid,
    admin: add.run('admin', hashPassword('password1'), 'Администратор',  'admin').lastInsertRowid,
  };
  const server = await listen(createApp(conn, { dataDir: licensedDataDir() }));
  return { conn, server, ids, base: `http://127.0.0.1:${server.address().port}` };
}
async function loginAs(base, username) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }),
  });
  assert.equal(res.status, 200, username);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const names = (r) => (r.json.data || []).map((t) => t.name).sort();

test('CABINET_FIX_V1_TPL: личный шаблон видит только автор и администратор, общий — все', async (t) => {
  const { conn, server, base } = await startClinic();
  t.after(() => { server.close(); conn.close(); });
  const doc = await loginAs(base, 'doc');
  const doc2 = await loginAs(base, 'doc2');
  const admin = await loginAs(base, 'admin');
  for (const [name, scope] of [['Личный Азизы', 'private'], ['Общий Азизы', 'shared']]) {
    const r = await db(base, doc, { table: 'consultation_templates', op: 'insert', values: [{ name, scope, doc_type: '0', body: BODY }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const all = { table: 'consultation_templates', op: 'select', columns: '*', filters: [] };
  assert.deepEqual(names(await db(base, doc, all)), ['Личный Азизы', 'Общий Азизы'], 'автор не видит свой личный шаблон');
  assert.deepEqual(names(await db(base, doc2, all)), ['Общий Азизы'], 'чужой врач видит личный шаблон');
  assert.deepEqual(names(await db(base, admin, all)), ['Личный Азизы', 'Общий Азизы'], 'администратор видит не всё');
  // и по номеру — тоже нет
  const pid = conn.prepare("SELECT id FROM consultation_templates WHERE name = 'Личный Азизы'").get().id;
  const byId = await db(base, doc2, { table: 'consultation_templates', op: 'select', columns: '*', filters: [{ col: 'id', op: 'eq', val: pid }] });
  assert.deepEqual(byId.json.data, [], 'личный шаблон отдаётся чужому по номеру');
});

test('CABINET_FIX_V1_TPL: шаблон правит и удаляет автор или администратор; чужой — нет, даже общий', async (t) => {
  const { conn, server, base } = await startClinic();
  t.after(() => { server.close(); conn.close(); });
  const doc = await loginAs(base, 'doc');
  const doc2 = await loginAs(base, 'doc2');
  const admin = await loginAs(base, 'admin');
  await db(base, doc, { table: 'consultation_templates', op: 'insert', values: [{ name: 'Общий Азизы', scope: 'shared', doc_type: '0', body: BODY }] });
  const id = conn.prepare("SELECT id FROM consultation_templates WHERE name = 'Общий Азизы'").get().id;
  const row = () => conn.prepare('SELECT name FROM consultation_templates WHERE id = ?').get(id);
  // чужой врач: правка и удаление проходят мимо строки
  await db(base, doc2, { table: 'consultation_templates', op: 'update', values: { name: 'взлом' }, filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.equal(row().name, 'Общий Азизы', 'чужой врач переименовал общий шаблон');
  await db(base, doc2, { table: 'consultation_templates', op: 'delete', filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.ok(row(), 'чужой врач удалил общий шаблон');
  // автор правит
  const own = await db(base, doc, { table: 'consultation_templates', op: 'update', values: { name: 'Общий Азизы — 2' }, filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.equal(row().name, 'Общий Азизы — 2');
  // администратор правит и удаляет чужой
  await db(base, admin, { table: 'consultation_templates', op: 'update', values: { name: 'Поправил админ' }, filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.equal(row().name, 'Поправил админ');
  await db(base, admin, { table: 'consultation_templates', op: 'delete', filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.equal(row(), undefined, 'администратор не удалил шаблон');
});

test('CABINET_FIX_V1_TPL: автора ставит сервер — чужим именем шаблон не подписать', async (t) => {
  const { conn, server, base, ids } = await startClinic();
  t.after(() => { server.close(); conn.close(); });
  const doc2 = await loginAs(base, 'doc2');
  const r = await db(base, doc2, { table: 'consultation_templates', op: 'insert',
    values: [{ name: 'Подделка', scope: 'private', doc_type: '0', body: BODY, author_id: Number(ids.doc), author_name: 'Каримова Азиза' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(conn.prepare("SELECT author_id FROM consultation_templates WHERE name = 'Подделка'").get().author_id, Number(ids.doc2),
    'шаблон записан на чужого автора — он попал бы в его «Мои» и стал бы его личным');
});

test('CABINET_FIX_V1_TPL: doc_type ложится строкой «0/1/2/3», и число тоже — не «1.0»', async (t) => {
  const { conn, server, base } = await startClinic();
  t.after(() => { server.close(); conn.close(); });
  const doc = await loginAs(base, 'doc');
  const put = (name, doc_type) => db(base, doc, { table: 'consultation_templates', op: 'insert', values: [{ name, scope: 'private', doc_type, body: { rx: [] } }] });
  for (const [name, v] of [['строкой', '1'], ['числом', 1], ['рецепт', '3'], ['ноль числом', 0]]) {
    const r = await put(name, v);
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const got = Object.fromEntries(conn.prepare('SELECT name, doc_type, typeof(doc_type) AS t FROM consultation_templates').all().map((r) => [r.name, r.doc_type + ':' + r.t]));
  assert.deepEqual(got, { 'строкой': '1:text', 'числом': '1:text', 'рецепт': '3:text', 'ноль числом': '0:text' });
  // правка числом — тоже строкой
  const id = conn.prepare("SELECT id FROM consultation_templates WHERE name = 'числом'").get().id;
  await db(base, doc, { table: 'consultation_templates', op: 'update', values: { doc_type: 2 }, filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.equal(conn.prepare('SELECT doc_type FROM consultation_templates WHERE id = ?').get(id).doc_type, '2');
});
