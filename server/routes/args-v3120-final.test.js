// V3120_FINAL — финальная проверка 3.12.0, мелочи вызовов /api/db и RPC:
//   мусор в limit/offset/q у чтений — 400 по-русски, не 500;
//   пустой документ визита не сохраняется (stamps created_by — не содержимое);
//   связи поставщиков пачкой — по product_id (item_id такой колонки нет);
//   SUPPLIERS_VAT_V1 — с 28.09 связи пишет только сервер (product_save).
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

const ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory', 'callcenter', 'head_doctor', 'senior_nurse'];

async function start(t) {
  const db = openDb(':memory:');
  migrate(db);
  const pw = hashPassword('password1');
  const ids = {};
  for (const r of ROLES) {
    ids[r] = Number(db.prepare('INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?)')
      .run(r, pw, 'Сотрудник ' + r, r, r === 'doctor' ? 1 : 0).lastInsertRowid);
  }
  const dataDir = licensedDataDir();
  const server = await listen(createApp(db, { dataDir }));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = {};
  for (const r of ROLES) {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: r, password: 'password1' }) });
    assert.equal(res.status, 200, 'login ' + r);
    cookie[r] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  return { db, ids, base, cookie, storage: path.join(dataDir, 'storage') };
}

async function post(ctx, who, url, body) {
  const res = await fetch(ctx.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie[who] }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const q = (ctx, who, desc) => post(ctx, who, '/api/db', desc);
const rpc = (ctx, who, name, args) => post(ctx, who, '/api/rpc/' + name, args);

function seed(db, doctorId) {
  const pid = Number(db.prepare("INSERT INTO patients (mrn, full_name) VALUES ('P-FIN-1','Каримов Азиз')").run().lastInsertRowid);
  const sid = Number(db.prepare("INSERT INTO services (name, price, requires_doctor) VALUES ('Приём',100000,1)").run().lastInsertRowid);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, notes) VALUES (?,?,?,'жалобы')").run(pid, doctorId, '2026-09-20T09:00:00Z').lastInsertRowid);
  db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, notes) VALUES (?,?,?,1,100000,100000,'completed','заметка')").run(vid, sid, doctorId);
  return { pid, sid, vid };
}

// ---------------------------------------------------------------------------
// Мусор в аргументах чтений — 400 по-русски, не 500.
// ---------------------------------------------------------------------------
test('мусор в limit/offset/q: procedures_list, lis_recent, telegram_*, documents_feed — 400 по-русски', async (t) => {
  const ctx = await start(t);
  const bad = [{ a: 1 }, "abc' OR 1=1--", [null, {}], 'Я'.repeat(100000)];
  const calls = [
    ['procedures_list', (v) => ({ limit: v })],
    ['lis_recent', (v) => ({ limit: v })],
    ['telegram_chats_list', (v) => ({ limit: v })],
    ['telegram_chat_messages', (v) => ({ chat_id: v, limit: v })],
    ['telegram_chat_messages', (v) => ({ chat_id: 'tg-1', limit: v })],
    ['documents_feed', (v) => ({ q: v })],
    ['documents_feed', (v) => ({ limit: v, offset: v })],
  ];
  for (const [name, mk] of calls) {
    for (const v of bad) {
      if (name === 'documents_feed' && typeof v === 'string' && v.length < 100 && 'q' in mk(v)) continue;   // обычный текст поиска законен
      const r = await rpc(ctx, 'admin', name, mk(v));
      assert.equal(r.status, 400, name + ' ' + JSON.stringify(mk(v)).slice(0, 60) + ': ' + JSON.stringify(r.json).slice(0, 200));
      assert.match(r.json.error.message, /[А-Яа-я]/);
    }
  }
  // Обычные вызовы экранов работают как прежде.
  assert.equal((await rpc(ctx, 'admin', 'procedures_list', { limit: 300 })).status, 200);
  assert.equal((await rpc(ctx, 'admin', 'lis_recent', { limit: 30 })).status, 200);
  assert.equal((await rpc(ctx, 'admin', 'telegram_chats_list', {})).status, 200);
  assert.equal((await rpc(ctx, 'admin', 'documents_feed', { q: 'Каримов', limit: 50, offset: 0, types: [] })).status, 200);
});

// ---------------------------------------------------------------------------
// Пустой документ визита и связи поставщиков.
// ---------------------------------------------------------------------------
test('visit_documents: пустая вставка — 400 по-русски, документ с названием — 200', async (t) => {
  const ctx = await start(t);
  const { pid, vid } = seed(ctx.db, ctx.ids.doctor);
  const before = ctx.db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n;
  for (const values of [{}, { patient_id: pid, visit_id: vid }, { patient_id: pid, title: '   ' }]) {
    const r = await q(ctx, 'doctor', { table: 'visit_documents', op: 'insert', values });
    assert.equal(r.status, 400, JSON.stringify(values) + ': ' + JSON.stringify(r.json));
    // {} — общий отказ «no writable columns provided» (статья словаря переводит его на экране).
    if (Object.keys(values).length) assert.match(r.json.error.message, /[А-Яа-я]/);
  }
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n, before, 'ничего не записано');
  const ok = await q(ctx, 'doctor', { table: 'visit_documents', op: 'insert', values: { patient_id: pid, visit_id: vid, doc_type: 'note', title: 'Заключение' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

// SUPPLIERS_VAT_V1 (2026-09-28) — связи «товар ↔ поставщик» пишет только
// сервер (product_save / supplier_save): там проверка НДС, дублей и право
// «Закупки: Изменение». Прямая запись через /api/db — отказ; прежняя проверка
// «пачкой по product_id» (V3120_FINAL) держится тем, что писать пачкой больше
// нечего, а карточка сохраняет связи одним вызовом.
test('item_suppliers: связи пишет только сервер — /api/db отказывает, product_save сохраняет', async (t) => {
  const ctx = await start(t);
  const prod = Number(ctx.db.prepare("INSERT INTO products (name) VALUES ('Шприц 5 мл')").run().lastInsertRowid);
  const sup = Number(ctx.db.prepare("INSERT INTO suppliers (name) VALUES ('Aventus')").run().lastInsertRowid);
  ctx.db.prepare('INSERT INTO item_suppliers (product_id, supplier_id, last_price) VALUES (?,?,100)').run(prod, sup);
  const upd = await q(ctx, 'inventory', { table: 'item_suppliers', op: 'update', values: { last_price: 120 }, filters: [{ col: 'product_id', op: 'eq', val: prod }, { col: 'supplier_id', op: 'eq', val: sup }] });
  assert.equal(upd.status, 403, JSON.stringify(upd.json));
  const del = await q(ctx, 'inventory', { table: 'item_suppliers', op: 'delete', filters: [{ col: 'product_id', op: 'eq', val: prod }] });
  assert.equal(del.status, 403, JSON.stringify(del.json));
  const ins = await q(ctx, 'admin', { table: 'item_suppliers', op: 'insert', values: { product_id: prod, supplier_id: sup } });
  assert.equal(ins.status, 403, JSON.stringify(ins.json));
  assert.equal(ctx.db.prepare('SELECT last_price FROM item_suppliers WHERE product_id = ?').get(prod).last_price, 100, 'прямая запись ничего не изменила');
  const saved = await rpc(ctx, 'inventory', 'product_save', { id: prod, name: 'Шприц 5 мл', procurement_category: 'consumables', vat_rate: 12,
    suppliers: [{ supplier_id: sup, last_price: 120, vat_rate: 12 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const link = ctx.db.prepare('SELECT last_price, vat_rate FROM item_suppliers WHERE product_id = ?').get(prod);
  assert.deepEqual({ ...link }, { last_price: 120, vat_rate: 12 });
  // Врачу каталог не открыт — отказ словами матрицы прав.
  const doc = await rpc(ctx, 'doctor', 'product_save', { id: prod, name: 'Шприц', procurement_category: 'consumables', vat_rate: 12, suppliers: [] });
  assert.equal(doc.status, 403, JSON.stringify(doc.json));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM item_suppliers').get().n, 1);
});
