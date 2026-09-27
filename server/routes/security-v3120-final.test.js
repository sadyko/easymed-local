// V3120_FINAL — финальная проверка 3.12.0, доступ и хранилище.
//
//   I1  deposit_balance отдавал баланс и журнал депозитов любого пациента
//       лаборатории, колл-центру, врачу, медсестре — теперь то же правило,
//       что у счетов (db/patient-data-gate.js, patient_deposits);
//   I2  DELETE в хранилище мимо замка Telegram и прав настроек;
//   I3  клинические таблицы (visits, visit_services, med_administrations,
//       patient_deposits, recommended_services, admission_services) читались
//       через /api/db любой ролью;
//   мелочи: «папка занята файлом» — правильный текст.
//
// Всё — настоящим HTTP через createApp.
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
// I1 — баланс депозита.
// ---------------------------------------------------------------------------
test('I1: колл-центр и склад не читают баланс и журнал депозитов пациента', async (t) => {
  const ctx = await start(t);
  const { pid } = seed(ctx.db, ctx.ids.doctor);
  for (const who of ['callcenter', 'inventory']) {
    const r = await rpc(ctx, who, 'deposit_balance', { patient_id: pid });
    assert.equal(r.status, 403, who + ': ' + JSON.stringify(r.json));
    assert.match(r.json.error.message, /[А-Яа-я]/);
  }
});

test('I1: касса, регистратура и роли, которым карта показывает вкладку «Счёт», баланс видят', async (t) => {
  const ctx = await start(t);
  const { pid } = seed(ctx.db, ctx.ids.doctor);
  for (const who of ['admin', 'cashier', 'registrar', 'doctor', 'nurse', 'lab', 'head_doctor', 'senior_nurse']) {
    const r = await rpc(ctx, who, 'deposit_balance', { patient_id: pid });
    assert.equal(r.status, 200, who + ': ' + JSON.stringify(r.json));
    assert.equal(r.json.data.balance, 0);
  }
});

test('I1: закрытая вкладка «Счёт» закрывает баланс роли, которой его давал только раздел пациентов', async (t) => {
  const ctx = await start(t);
  const { pid } = seed(ctx.db, ctx.ids.doctor);
  const row = ctx.db.prepare("SELECT permissions FROM role_permissions WHERE role = 'doctor'").get();
  const perms = JSON.parse(row.permissions);
  perms.patient_tabs = { billing: 'none' };
  ctx.db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'doctor'").run(JSON.stringify(perms));
  const r = await rpc(ctx, 'doctor', 'deposit_balance', { patient_id: pid });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  // Кассе баланс даёт её собственный раздел.
  assert.equal((await rpc(ctx, 'cashier', 'deposit_balance', { patient_id: pid })).status, 200);
});

// ---------------------------------------------------------------------------
// I3 — клинические таблицы через /api/db.
// ---------------------------------------------------------------------------
const CLINICAL = ['visits', 'visit_services', 'med_administrations', 'patient_deposits', 'recommended_services', 'admission_services'];

test('I3: склад и колл-центр не читают клинические таблицы (колл-центр — только визиты для своих заявок)', async (t) => {
  const ctx = await start(t);
  seed(ctx.db, ctx.ids.doctor);
  for (const table of CLINICAL) {
    const r = await q(ctx, 'inventory', { table, op: 'select', columns: 'id', limit: 5 });
    assert.equal(r.status, 403, 'inventory / ' + table + ': ' + JSON.stringify(r.json));
    assert.match(r.json.error.message, /[А-Яа-я]/);
  }
  for (const table of CLINICAL.filter((x) => x !== 'visits')) {
    const r = await q(ctx, 'callcenter', { table, op: 'select', columns: 'id', limit: 5 });
    assert.equal(r.status, 403, 'callcenter / ' + table + ': ' + JSON.stringify(r.json));
  }
  // Заявки CRM (requests-inbox) читают визиты — это экран колл-центра.
  assert.equal((await q(ctx, 'callcenter', { table: 'visits', op: 'select', columns: 'id', limit: 5 })).status, 200);
  // Через embed чужой таблицы — тоже нет.
  const e = await q(ctx, 'inventory', { table: 'services', op: 'select', columns: 'id,visit_services(notes)', limit: 5 });
  assert.ok([400, 403].includes(e.status), JSON.stringify(e.json));
});

test('I3: законные экраны работают — врач, лаборатория, медсестра, касса, регистратура, стационар', async (t) => {
  const ctx = await start(t);
  seed(ctx.db, ctx.ids.doctor);
  const ok = async (who, table) => {
    const r = await q(ctx, who, { table, op: 'select', columns: 'id', limit: 5 });
    assert.equal(r.status, 200, who + ' / ' + table + ': ' + JSON.stringify(r.json));
  };
  for (const table of ['visits', 'visit_services', 'recommended_services']) await ok('doctor', table);
  for (const table of ['visits', 'visit_services']) { await ok('lab', table); await ok('nurse', table); await ok('registrar', table); }
  await ok('cashier', 'visit_services'); await ok('cashier', 'patient_deposits');
  await ok('registrar', 'recommended_services'); await ok('registrar', 'patient_deposits');
  for (const who of ['nurse', 'registrar']) await ok(who, 'admission_services');
  await ok('nurse', 'med_administrations'); await ok('doctor', 'med_administrations');
  for (const table of CLINICAL) await ok('admin', table);
});

// ---------------------------------------------------------------------------
// I2 — удаление файлов.
// ---------------------------------------------------------------------------
function plant(ctx, rel, content = 'x') {
  const abs = path.join(ctx.storage, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
const del = (ctx, who, obj) => fetch(ctx.base + '/api/storage/' + obj, { method: 'DELETE', headers: { Cookie: ctx.cookie[who] } });
const put = (ctx, who, obj, body = 'data') => fetch(ctx.base + '/api/storage/' + obj,
  { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: ctx.cookie[who] }, body: Buffer.from(body) });

test('I2: лаборатория не удаляет вложения Telegram; склад и регистратура — лицензию и прочие файлы клиники', async (t) => {
  const ctx = await start(t);
  const tg = plant(ctx, 'telegram-media/chat/1/a.jpg');
  const r1 = await del(ctx, 'lab', 'telegram-media/chat/1/a.jpg');
  assert.equal(r1.status, 403);
  assert.match((await r1.json()).error.message, /[А-Яа-я]/);
  assert.ok(fs.existsSync(tg), 'файл на месте');

  const lic = plant(ctx, 'clinic-docs/1/license-1-lic.pdf', '%PDF');
  const misc = plant(ctx, 'clinic-docs/misc/cert.pdf', '%PDF');
  for (const who of ['inventory', 'registrar', 'callcenter', 'lab']) {
    assert.equal((await del(ctx, who, 'clinic-docs/1/license-1-lic.pdf')).status, 403, who);
    assert.equal((await del(ctx, who, 'clinic-docs/misc/cert.pdf')).status, 403, who);
    // Перезаписать лицензию загрузкой — то же самое, что удалить её.
    assert.equal((await put(ctx, who, 'clinic-docs/1/license-1-lic.pdf', '%PDF-fake')).status, 403, who + ' POST');
  }
  assert.ok(fs.existsSync(lic) && fs.existsSync(misc));
  assert.equal(fs.readFileSync(lic, 'utf8'), '%PDF');

  // Колл-центр (раздел «Чат с пациентами») своё вложение удалить может; администратор — всё.
  assert.equal((await del(ctx, 'callcenter', 'telegram-media/chat/1/a.jpg')).status, 200);
  assert.equal((await del(ctx, 'admin', 'clinic-docs/misc/cert.pdf')).status, 200);
  assert.equal(fs.existsSync(misc), false);
  assert.equal((await put(ctx, 'admin', 'clinic-docs/misc/logo.png', 'png')).status, 200);
});

test('хранилище: папка в пути занята файлом — понятный русский текст, не «файл уже есть»', async (t) => {
  const ctx = await start(t);
  plant(ctx, 'clinic-docs/misc/a.pdf', '%PDF');
  const r = await put(ctx, 'admin', 'clinic-docs/misc/a.pdf/b.pdf', '%PDF');
  assert.ok(r.status === 400 || r.status === 409, String(r.status));
  const msg = (await r.json()).error.message;
  assert.doesNotMatch(msg, /даст ему новое имя/);
  assert.match(msg, /папк/i);
});
