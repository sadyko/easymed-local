// REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1 — ревью U10 (2026-11-03): ПРИВЯЗКА РЕКОМЕНДАЦИИ К
// СТРОКЕ — ДОКАЗАТЕЛЬСТВО, КОТОРОЕ НЕЛЬЗЯ ПОДДЕЛАТЬ.
//
// Пробы ревью P1, P2, P5, P6, P7 (снимок rc/3.21.0) — здесь регрессиями на настоящем приложении и
// сессиях (crm-unify-app.js; doc — врач №10 «Иванов», reg — регистратура, cc — колл-центр):
//   HIGH-1 — рекомендацию, написанную задним числом, нельзя привязать к чужой строке ради бонуса;
//            медсестра не привязывает; кто рекомендовал — ставит сервер (не браузер);
//   LOW-8  — отменённая/снятая/возвращённая строка, отменённый визит, закрытый месяц — отказ;
//   MEDIUM-2 — направивший строки — тот, кто рекомендовал (сам исполняет — никто), а не вставивший;
//   MEDIUM-3 — роль без клинических разделов не читает направления врача и метки календаря;
//   MEDIUM-4 — вариант «б»: внешний партнёр строки не добавляется к внешнему партнёру визита.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at } from '../test-helpers/crm-unify-app.js';
import { hashPassword } from '../services/auth.js';
import { runReport } from '../services/rpc/reports.js';
import { openCashShift } from '../services/rpc/cashier.js';
import { referralsInternal } from '../services/rpc/referrals.js';

const TODAY = localDay(0);
const OLD = '2020-01-01T00:00:00Z';   // рекомендация из прошлого приёма — заведомо старше строки
const admin = { id: 1, role: 'admin' };
const srcOf = (db, doctorId) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(doctorId).id;
const lastVs = (db) => db.prepare('SELECT MAX(id) id FROM visit_services').get().id;
const lastRec = (db) => db.prepare('SELECT MAX(id) id FROM recommended_services').get().id;
const lineSrc = (db, id) => db.prepare('SELECT referred_by_source_id s FROM visit_services WHERE id = ?').get(id).s;
const recRow = (db, id) => db.prepare('SELECT recommended_by, status, visit_service_id FROM recommended_services WHERE id = ?').get(id);
const oldRec = (db, { service = 50, by = 12, created = OLD } = {}) => Number(db.prepare(
  "INSERT INTO recommended_services (patient_id, service_id, service_name, recommended_by, status, created_at) VALUES (77, ?, 'УЗИ', ?, 'pending', ?)")
  .run(service, by, created).lastInsertRowid);
// Сегодня, чуть раньше строки: «Внутренние врачи» считают рекомендации периода по дню записи.
const EARLIER = () => new Date(Date.now() - 5000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const newVisit = (db, status = 'arrived') => Number(db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (77, ?, ?)')
  .run(at(TODAY, 9), status).lastInsertRowid);

function seed(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12,'doc2','x','Петров','doctor',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (20,'nurse1',?,'Медсестра','nurse',0)").run(hashPassword('password1'));
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ',80000,'imaging'), (61,'Холтер',90000,'imaging')").run();
  const extCat = Number(db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 10)").run().lastInsertRowid);
  db.prepare("INSERT INTO referral_sources (id, name, category_id) VALUES (900, 'Партнёр А', ?), (901, 'Партнёр Б', ?)").run(extCat, extCat);
  db.prepare('UPDATE referral_source_categories SET standard_percent = 10 WHERE is_internal = 1').run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (500, 77, ?, 'arrived')").run(at(TODAY, 9));
}

async function login(t, username) {
  const base = `http://127.0.0.1:${t.server.address().port}`;
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }) });
  assert.equal(res.status, 200, 'вход ' + username);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: r.status, text, json };
  };
  return { rpc: (name, args) => call('/api/rpc/' + name, args), dbq: (desc) => call('/api/db', desc) };
}
async function line(t, who, values) {
  const r = await t.dbq(who, { table: 'visit_services', op: 'insert', values: { visit_id: 500, quantity: 1, unit_price: 80000, total: 80000, status: 'added', ...values } });
  assert.equal(r.status, 200, r.text);
  return lastVs(t.db);
}
async function bill(t, vsIds, visitId = 500) {
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: visitId, visit_service_ids: vsIds, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return inv.json.data.invoice;
}
async function pay(t, invoice) {
  openCashShift(t.db, { opening_float: 0 }, { id: 9, role: 'cashier', full_name: 'Кассир' });
  const p = await t.rpc('record_payment', 'kassa', { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' });
  assert.equal(p.status, 200, p.text);
}
const bonusRows = (db) => {
  const r = runReport(db, { kind: 'referrals_detail', from: TODAY, to: TODAY }, admin);
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])))
    .map((o) => [o['Источник'], o['Услуга'], o['Вознаграждение']]);
};
const attach = (t, who, recommendation_id, visit_service_id) => t.rpc('referral_recommendation_attach', who, { recommendation_id, visit_service_id });

test('HIGH-1 (проба P1): врач не привязывает рекомендацию к строке, которую завёл не он, — бонус не уходит', async () => {
  const t = await startCrmApp((db) => { seed(db); db.prepare('UPDATE patients SET referral_source_id = 900 WHERE id = 77').run(); });
  try {
    const X = await line(t, 'reg', { service_id: 50, doctor_id: 12 });
    const invoice = await bill(t, [X]);
    // Врач, который не направлял, пишет рекомендацию ПОСЛЕ строки и пробует привязать её.
    const rec = await t.dbq('doc', { table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 50, service_name: 'УЗИ', recommended_by: 10, status: 'pending' } });
    assert.equal(rec.status, 200, rec.text);
    const recId = lastRec(t.db);
    const att = await attach(t, 'doc', recId, X);
    assert.equal(att.status, 403, att.text);
    assert.match(att.json.error.message, /завёл другой сотрудник/);
    assert.equal(lineSrc(t.db, X), null, 'строке поставлен направивший');
    assert.equal(recRow(t.db, recId).status, 'pending', 'рекомендация закрыта чужой строкой');
    await pay(t, invoice);
    assert.deepEqual(bonusRows(t.db), [['Партнёр А', 'УЗИ', 8000]], 'клиника платит за одну строку дважды');
  } finally { t.close(); }
});

test('HIGH-1 (проба P2): медсестра не привязывает рекомендации, а её рекомендация врача не называет', async () => {
  const t = await startCrmApp(seed);
  try {
    const X = await line(t, 'reg', { service_id: 61, doctor_id: 10, unit_price: 90000, total: 90000 });
    const nurse = await login(t, 'nurse1');
    const rec = await nurse.dbq({ table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 61, service_name: 'Холтер', recommended_by: 12, recommended_by_name: 'Петров', status: 'pending' } });
    assert.equal(rec.status, 200, rec.text);
    const recId = lastRec(t.db);
    assert.equal(recRow(t.db, recId).recommended_by, null, 'медсестра записала рекомендацию от имени врача №12');
    const att = await nurse.rpc('referral_recommendation_attach', { recommendation_id: recId, visit_service_id: X });
    assert.equal(att.status, 403, att.text);
    assert.equal(lineSrc(t.db, X), null);
  } finally { t.close(); }
});

test('HIGH-1: кто рекомендовал — ставит сервер: врачу — он сам; стойке — никто (привязка закрывает рекомендацию без направившего)', async () => {
  const t = await startCrmApp(seed);
  try {
    const own = await t.dbq('doc', { table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 61, service_name: 'Холтер', recommended_by: 12, status: 'pending' } });
    assert.equal(own.status, 200, own.text);
    assert.equal(recRow(t.db, lastRec(t.db)).recommended_by, 10, 'врач записал рекомендацию от имени коллеги');
    const forged = await t.dbq('reg', { table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 50, service_name: 'УЗИ', recommended_by: 12, status: 'pending' } });
    assert.equal(forged.status, 200, forged.text);
    const recId = lastRec(t.db);
    assert.equal(recRow(t.db, recId).recommended_by, null, 'стойка выдала рекомендацию за врача №12');
    const X = await line(t, 'reg', { service_id: 50 });
    const att = await attach(t, 'reg', recId, X);
    assert.equal(att.status, 200, att.text);
    assert.equal(att.json.data.referred_by_source_id, null);
    assert.equal(lineSrc(t.db, X), null);
    assert.deepEqual(recRow(t.db, recId), { recommended_by: null, status: 'done', visit_service_id: X });
  } finally { t.close(); }
});

test('HIGH-1: рекомендация, написанная после строки, к ней не привязывается', async () => {
  const t = await startCrmApp(seed);
  try {
    const Y = await line(t, 'doc', { service_id: 50, doctor_id: 12 });
    t.db.prepare('UPDATE visit_services SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z'), Y);
    const rec = await t.dbq('doc', { table: 'recommended_services', op: 'insert', values: { patient_id: 77, service_id: 50, service_name: 'УЗИ', status: 'pending' } });
    assert.equal(rec.status, 200, rec.text);
    const att = await attach(t, 'doc', lastRec(t.db), Y);
    assert.equal(att.status, 409, att.text);
    assert.match(att.json.error.message, /позже/);
    assert.equal(recRow(t.db, lastRec(t.db)).status, 'pending');
  } finally { t.close(); }
});

test('LOW-8: отменённая, снятая и возвращённая строка, отменённый визит и закрытый месяц — привязки нет', async () => {
  const t = await startCrmApp(seed);
  try {
    const refused = async (vs, re, what) => {
      const rec = oldRec(t.db);
      const r = await attach(t, 'reg', rec, vs);
      assert.equal(r.status, 409, what + ': ' + r.text);
      assert.match(r.json.error.message, re, what);
      assert.equal(recRow(t.db, rec).status, 'pending', what + ': рекомендация закрыта');
      assert.equal(lineSrc(t.db, vs), null, what + ': строке поставлен направивший');
    };
    for (const st of ['cancelled', 'removed']) {
      const vs = await line(t, 'reg', { visit_id: newVisit(t.db), service_id: 50 });
      t.db.prepare('UPDATE visit_services SET status = ? WHERE id = ?').run(st, vs);
      await refused(vs, /отменена или снята/, st);
    }
    {   // «Вернуть услугу»: строка без позиции счёта, отпущена с возвратом
      const vs = await line(t, 'reg', { visit_id: newVisit(t.db), service_id: 50 });
      t.db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, 1)").run(vs);
      await refused(vs, /возвращена/, 'возвращённая');
    }
    for (const st of ['cancelled', 'no_show']) {
      const v = newVisit(t.db);
      const vs = await line(t, 'reg', { visit_id: v, service_id: 50 });
      t.db.prepare('UPDATE visits SET status = ? WHERE id = ?').run(st, v);
      await refused(vs, /Визит отменён/, 'визит ' + st);
    }
    {   // закрытый месяц оплаты врачей
      const vs = await line(t, 'reg', { visit_id: newVisit(t.db), service_id: 50 });
      t.db.prepare('INSERT INTO pay_periods (month, closed_by) VALUES (?, 1)').run(TODAY.slice(0, 7));
      await refused(vs, /закрыты/, 'закрытый месяц');
    }
  } finally { t.close(); }
});

test('MEDIUM-2 (проба P6): строку по рекомендации коллеги заводит другой врач — направивший тот, кто рекомендовал; исполняет сам — никто', async () => {
  const t = await startCrmApp(seed);
  try {
    // Петров (12) рекомендовал УЗИ и выполнит его сам; Иванов (10) добавляет её в визит.
    const recA = oldRec(t.db, { service: 50, by: 12, created: EARLIER() });
    const X = await line(t, 'doc', { service_id: 50, doctor_id: 12 });
    assert.equal(lineSrc(t.db, X), srcOf(t.db, 10), 'стенд: дверь /api/db ставит источник вставившего врача');
    const a = await attach(t, 'doc', recA, X);
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.data.referred_by_source_id, null);
    assert.equal(lineSrc(t.db, X), null, 'направивший строки — вставивший врач, а не рекомендовавший');
    // Петров рекомендовал Холтер, выполняет Иванов — направивший строки Петров.
    const recB = oldRec(t.db, { service: 61, by: 12, created: EARLIER() });
    const Y = await line(t, 'doc', { service_id: 61, doctor_id: 10, unit_price: 90000, total: 90000 });
    const b = await attach(t, 'doc', recB, Y);
    assert.equal(b.status, 200, b.text);
    assert.equal(lineSrc(t.db, Y), srcOf(t.db, 12));
    await pay(t, await bill(t, [X, Y]));
    const out = referralsInternal(t.db, { from: TODAY, to: TODAY }, admin);
    const row = (id) => { const d = out.doctors.find((x) => x.id === id); return d && { referrals: d.referrals, reward: d.reward }; };
    assert.deepEqual(row(12), { referrals: 2, reward: 9000 });
    assert.deepEqual(row(10), { referrals: 0, reward: 0 }, 'вставивший врач получил чужое направление');
  } finally { t.close(); }
});

test('MEDIUM-3 (проба P5): роль без клинических разделов не читает направления врача; колл-центр не получает метки', async () => {
  const t = await startCrmApp((db) => {
    seed(db);
    db.prepare('DELETE FROM role_permissions WHERE role = ?').run('nurse');
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('nurse', JSON.stringify({ sections: ['inventory'], levels: { inventory: 'editor' } }));
    db.prepare("INSERT INTO recommended_services (patient_id, service_id, service_name, recommended_by, notes, status) VALUES (77, 50, 'УЗИ', 10, 'CLINICAL-NOTE', 'pending')").run();
  });
  try {
    await line(t, 'doc', { service_id: 50, doctor_id: 12, referral_note: 'NOTE-FOR-DESK' });
    const nurse = await login(t, 'nurse1');
    const r = await nurse.rpc('patient_referral_orders', { patient_id: 77 });
    assert.equal(r.status, 403, r.text);
    assert.ok(!r.text.includes('CLINICAL-NOTE') && !r.text.includes('NOTE-FOR-DESK'), 'данные пациента ушли роли склада');
    const cc = await t.rpc('referral_visit_links', 'cc', { visit_ids: [500] });
    assert.equal(cc.status, 200, cc.text);
    assert.deepEqual(cc.json.data, [], 'колл-центр узнал, кто направил на визит');
    const reg = await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 });
    assert.equal(reg.status, 200, reg.text);
    assert.equal(reg.json.data.lines.length, 1);
    assert.deepEqual((await t.rpc('referral_visit_links', 'reg', { visit_ids: [500] })).json.data, [{ visit_id: 500, doctor_name: 'Иванов' }]);
  } finally { t.close(); }
});

test('MEDIUM-4 (проба P7, вариант «б»): партнёр визита А + «Кто направил» Б у новой строки — платится только А', async () => {
  const t = await startCrmApp((db) => { seed(db); db.prepare('UPDATE visits SET referral_source_id = 900 WHERE id = 500').run(); });
  try {
    const X = await line(t, 'reg', { service_id: 50, referred_by_source_id: 901 });
    assert.equal(lineSrc(t.db, X), 901, 'стенд: стойка поставила строке партнёра Б');
    await pay(t, await bill(t, [X]));
    assert.deepEqual(bonusRows(t.db), [['Партнёр А', 'УЗИ', 8000]], 'два внешних партнёра за одну строку');
  } finally { t.close(); }
});
