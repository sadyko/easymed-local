// CLINIC_NEWS_V1 — «Информационная доска»: читают все вошедшие, пишет
// администратор; истёкшие и снятые — в архиве, закреплённые — сверху.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { clinicNewsList, clinicNewsSave, clinicNewsArchive, RpcError } from './clinic-news.js';
import { getRpc } from './index.js';
import { today } from '../domain/day.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin', 'Главный Администратор');
  ins.run(2, 'doc', 'x', 'doctor', 'Врач Клиники');
  return db;
}
const admin = { id: 1, role: 'admin' };
const doctor = { id: 2, role: 'doctor' };
const ids = (r) => r.items.map((n) => n.title);

test('RPC зарегистрированы; читать — любому вошедшему, писать и снимать — только администратору', () => {
  const db = fresh();
  for (const n of ['clinic_news_list', 'clinic_news_save', 'clinic_news_archive']) assert.equal(typeof getRpc(n), 'function', n);
  assert.throws(() => clinicNewsList(db, {}, null), (e) => e instanceof RpcError && e.status === 401);
  assert.deepEqual(clinicNewsList(db, {}, doctor).items, []);
  assert.throws(() => clinicNewsSave(db, { title: 'x' }, doctor), (e) => e.status === 403);
  const { id } = clinicNewsSave(db, { title: 'x' }, admin);
  assert.throws(() => clinicNewsArchive(db, { id }, doctor), (e) => e.status === 403);
});

test('проверка полей: заголовок обязателен, вид из списка, дата — YYYY-MM-DD', () => {
  const db = fresh();
  assert.throws(() => clinicNewsSave(db, { title: '   ' }, admin), (e) => e.status === 400);
  assert.throws(() => clinicNewsSave(db, { title: 'x', kind: 'party' }, admin), (e) => e.status === 400);
  assert.throws(() => clinicNewsSave(db, { title: 'x', show_until: '31.10.2026' }, admin), (e) => e.status === 400);
  assert.throws(() => clinicNewsSave(db, { title: 'x'.repeat(201) }, admin), (e) => e.status === 400);
  const { id } = clinicNewsSave(db, { title: '  УЗИ не работает  ', kind: 'equipment', body: ' до четверга ' }, admin);
  const row = clinicNewsList(db, {}, doctor).items.find((n) => n.id === id);
  assert.equal(row.title, 'УЗИ не работает');
  assert.equal(row.body, 'до четверга');
  assert.equal(row.kind, 'equipment');
  assert.equal(row.author, 'Главный Администратор');
});

test('доска: закреплённые сверху, истёкшие — в архиве; «Снять» уносит в архив, исправить снятое нельзя', () => {
  const db = fresh();
  const t = today(db);
  clinicNewsSave(db, { title: 'Обычная' }, admin);
  clinicNewsSave(db, { title: 'Закреплённая', pinned: true }, admin);
  clinicNewsSave(db, { title: 'Истекла', show_until: '2000-01-01' }, admin);
  clinicNewsSave(db, { title: 'До сегодня', show_until: t }, admin);
  const board = clinicNewsList(db, {}, doctor);
  assert.equal(board.items[0].title, 'Закреплённая');
  assert.ok(ids(board).includes('До сегодня'), 'срок «сегодня» — ещё на доске');
  assert.ok(!ids(board).includes('Истекла'));
  assert.ok(ids(clinicNewsList(db, { archive: true }, doctor)).includes('Истекла'));

  const id = board.items.find((n) => n.title === 'Обычная').id;
  assert.equal(clinicNewsArchive(db, { id }, admin).archived, true);
  assert.equal(clinicNewsArchive(db, { id }, admin).archived, false, 'второй раз — ничего');
  assert.ok(!ids(clinicNewsList(db, {}, doctor)).includes('Обычная'));
  assert.ok(ids(clinicNewsList(db, { archive: true }, doctor)).includes('Обычная'));
  assert.throws(() => clinicNewsSave(db, { id, title: 'Новая' }, admin), (e) => e.status === 409);
});

// CLINIC_NEWS_IMPORTANT_V1
test('«Важно»: сохраняется и снимается правкой; на доске — после закреплённых, перед свежими обычными', () => {
  const db = fresh();
  clinicNewsSave(db, { title: 'Важная старая', important: true }, admin);
  clinicNewsSave(db, { title: 'Обычная свежая' }, admin);
  clinicNewsSave(db, { title: 'Закреплённая', pinned: true }, admin);
  const board = clinicNewsList(db, {}, doctor);
  assert.deepEqual(ids(board), ['Закреплённая', 'Важная старая', 'Обычная свежая']);
  const imp = board.items[1];
  assert.equal(imp.important, 1);
  assert.equal(board.items[2].important, 0);

  clinicNewsSave(db, { id: imp.id, title: imp.title, important: false }, admin);
  assert.equal(clinicNewsList(db, {}, doctor).items.find((n) => n.id === imp.id).important, 0);
});

test('исправление: тот же id, новые поля', () => {
  const db = fresh();
  const { id } = clinicNewsSave(db, { title: 'Кардиолог', kind: 'doctor_visit' }, admin);
  assert.deepEqual(clinicNewsSave(db, { id, title: 'Кардиолог из Турции', kind: 'doctor_visit', pinned: true }, admin), { id });
  const row = clinicNewsList(db, {}, doctor).items[0];
  assert.equal(row.title, 'Кардиолог из Турции');
  assert.equal(row.pinned, 1);
});
