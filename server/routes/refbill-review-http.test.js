// REFBILL_REVIEW_V1 (2026-09-29) — РЕВЬЮ REFERRAL_BILL_V1, C1 и M4 ЧЕРЕЗ HTTP.
//
// Пробы ревьюера (probe-http.mjs, probe-http-doctorid.mjs) — настоящее
// приложение, SQLite в памяти, настоящие сессии. Врач сам пишет строку через
// /api/db (price_tier и doctor_id — колонки вставки врача в реестре) и сам
// выставляет по ней счёт:
//   • «повторный визит» (0 сум) пациенту, которого сервер считает первичным
//     (200 000), давал счёт 0 — «оплачен», строка в очереди, касса не видела
//     ничего. Теперь — 403 до счёта; честная строка — 200 000;
//   • исполнитель строки — только тот, кому оказывать услугу можно
//     (assertPerformer): коллега-врач со своей ценой — законное направление,
//     регистратор с «ценой 0» и уволенный — отказ;
//   • строку регистратуры врач не выставляет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

function todayAt(hh) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, 0, 0, 0).toISOString();
}

async function start() {
  const db = openDb(':memory:');
  migrate(db);
  const user = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, is_active) VALUES (?,?,?,?,?,?,?)');
  user.run(1, 'boss', hashPassword('password1'), 'Админ', 'admin', 0, 1);
  user.run(2, 'reg', hashPassword('password1'), 'Регистратура', 'registrar', 0, 1);
  user.run(3, 'cash', hashPassword('password1'), 'Кассир', 'cashier', 0, 1);
  user.run(10, 'doc', hashPassword('password1'), 'Иванов', 'doctor', 1, 1);
  user.run(11, 'free', hashPassword('password1'), 'Коллега', 'doctor', 1, 1);
  user.run(12, 'clerk', hashPassword('password1'), 'Регистратор с ценой', 'registrar', 0, 1);
  user.run(13, 'gone', hashPassword('password1'), 'Уволенный', 'doctor', 1, 0);
  // Приём 200 000; второй визит 60 000; повторный — бесплатно (пример владельца).
  db.prepare("INSERT INTO services (id, name, price, type, price_secondary, secondary_days_from, secondary_days_to, price_repeat) VALUES (60,'Приём кардиолога',200000,'consultation',60000,1,6,0)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  for (const id of [11, 12, 13]) {
    db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([{ service_id: 60, price: 0, pct: 0 }, { service_id: 40, price: 0, pct: 0 }]), id);
  }
  db.prepare("INSERT INTO patients (id, full_name, phone, mrn) VALUES (77,'Новый пациент','+998900000077','A-000077')").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  for (const who of ['boss', 'reg', 'cash', 'doc']) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: who, password: 'password1' }),
    });
    assert.equal(res.status, 200, 'вход ' + who);
    cookies[who] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const call = async (path, who, body) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies[who] },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const rpc = (name, who, args) => call('/api/rpc/' + name, who, args);
  const insertLine = (who, values) => call('/api/db', who, { table: 'visit_services', op: 'insert', returning: true, single: 'single', values });
  return { db, rpc, insertLine, close: () => { server.close(); db.close(); } };
}

async function dayVisit(t, who = 'doc') {
  const ev = await t.rpc('ensure_visit', who, { patient_id: 77, date: todayAt(9), doctor_id: null, visit_type: 'outpatient' });
  assert.equal(ev.status, 200, JSON.stringify(ev.json));
  return ev.json.data.visit.id;
}
const invoiceCount = (t) => t.db.prepare('SELECT COUNT(*) n FROM invoices').get().n;

test('C1 (probe-http): врач ставит строке «повторный визит» и выставляет сам — 403, счёта нет; честная строка — 200 000', async () => {
  const t = await start();
  try {
    const q = await t.rpc('service_price_quote', 'doc', { patient_id: 77, service_ids: [60], doctor_id: 10 });
    assert.equal(q.json.data.quotes[60].tier, 'primary', 'сервер считает пациента первичным');
    const visitId = await dayVisit(t);
    const ins = await t.insertLine('doc', { visit_id: visitId, service_id: 60, doctor_id: 10, quantity: 1, unit_price: 0, total: 0, status: 'added', price_tier: 'repeat' });
    assert.equal(ins.status, 200, JSON.stringify(ins.json));
    const bill = await t.rpc('create_invoice_for_visit', 'doc', { visit_id: visitId, visit_service_ids: [ins.json.data.id], discount_amount: 0, payer_id: null });
    assert.equal(bill.status, 403, 'счёт на ноль по «повторному визиту»: ' + JSON.stringify(bill.json));
    assert.equal(bill.json.error.message, 'Тариф визита в строке «Приём кардиолога» не совпадает с расчётом сервера — счёт по ней выставит касса.');
    assert.equal(invoiceCount(t), 0);
    const line = t.db.prepare('SELECT status, invoice_item_id FROM visit_services WHERE id = ?').get(ins.json.data.id);
    assert.deepEqual({ ...line }, { status: 'added', invoice_item_id: null }, 'строка не ушла в очередь «оплаченной»');

    const honest = await t.insertLine('doc', { visit_id: visitId, service_id: 60, doctor_id: 10, quantity: 1, unit_price: 200000, total: 200000, status: 'added', price_tier: null });
    const ok = await t.rpc('create_invoice_for_visit', 'doc', { visit_id: visitId, visit_service_ids: [honest.json.data.id], discount_amount: 0 });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.data.invoice.total_amount, 200000);
    assert.equal(ok.json.data.invoice.status, 'unpaid');
    const cash = await t.rpc('cashier_invoices', 'cash', {});
    assert.ok(cash.json.data.rows.some((r) => r.id === ok.json.data.invoice.id), 'касса видит счёт врача');
  } finally { t.close(); }
});

test('C1 (probe-http-doctorid): исполнитель строки — коллега-врач законно, регистратор с «ценой 0» и уволенный — отказ', async () => {
  const t = await start();
  try {
    const visitId = await dayVisit(t);
    const tries = [
      [12, 400, 'Консультацию проводит врач — выберите врача.'],
      [13, 400, 'Этот сотрудник уволен или отключён — выберите работающего исполнителя.'],
    ];
    for (const [doctorId, status, message] of tries) {
      const ins = await t.insertLine('doc', { visit_id: visitId, service_id: 60, doctor_id: doctorId, quantity: 1, unit_price: 0, total: 0, status: 'added', price_tier: null });
      assert.equal(ins.status, 200, JSON.stringify(ins.json));
      const bill = await t.rpc('create_invoice_for_visit', 'doc', { visit_id: visitId, visit_service_ids: [ins.json.data.id], discount_amount: 0 });
      assert.equal(bill.status, status, 'исполнитель ' + doctorId + ': ' + JSON.stringify(bill.json));
      assert.equal(bill.json.error.message, message);
    }
    assert.equal(invoiceCount(t), 0);
    // Направление к коллеге — строка у коллеги, цена его своя («Услуги и
    // ставки»), ровно как посчитает касса: это правило клиники, а не скидка.
    const ins = await t.insertLine('doc', { visit_id: visitId, service_id: 60, doctor_id: 11, quantity: 1, unit_price: 0, total: 0, status: 'added', price_tier: null });
    const bill = await t.rpc('create_invoice_for_visit', 'doc', { visit_id: visitId, visit_service_ids: [ins.json.data.id], discount_amount: 0 });
    assert.equal(bill.status, 200, JSON.stringify(bill.json));
    assert.equal(bill.json.data.items[0].unit_price, 0, 'своя цена коллеги');
  } finally { t.close(); }
});

test('M4: строку регистратуры врач через HTTP не выставляет; касса — выставляет', async () => {
  const t = await start();
  try {
    const visitId = await dayVisit(t, 'reg');
    const ins = await t.insertLine('reg', { visit_id: visitId, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, status: 'added' });
    assert.equal(ins.status, 200, JSON.stringify(ins.json));
    const bill = await t.rpc('create_invoice_for_visit', 'doc', { visit_id: visitId, visit_service_ids: [ins.json.data.id], discount_amount: 0 });
    assert.equal(bill.status, 403);
    assert.equal(bill.json.error.message, 'Врач выставляет счёт только за услуги, которые добавил сам. Остальное выставит касса.');
    const byCash = await t.rpc('create_invoice_for_visit', 'cash', { visit_id: visitId, visit_service_ids: [ins.json.data.id] });
    assert.equal(byCash.status, 200, JSON.stringify(byCash.json));
    assert.equal(byCash.json.data.invoice.total_amount, 40000);
  } finally { t.close(); }
});
