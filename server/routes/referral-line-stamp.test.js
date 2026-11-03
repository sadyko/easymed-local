// REFERRAL_LINE_V1 — направившего СТРОКИ визита ставит сервер: дверь /api/db, компилятор
// запросов, штамп реестра `resolve: 'line_referral'` (domain/line-referral.js). Настоящее
// приложение и настоящие сессии (стенд crm-unify-app.js: boss — админ, reg — регистратура,
// doc — врач №10 «Иванов» со своим внутренним источником).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at } from '../test-helpers/crm-unify-app.js';

const TODAY = localDay(0);
const srcOf = (db, doctorId) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(doctorId).id;
const lastVs = (db) => db.prepare('SELECT MAX(id) id FROM visit_services').get().id;
const stampOf = (db, id) => db.prepare('SELECT referred_by_source_id AS src, referral_note AS note FROM visit_services WHERE id = ?').get(id);

function seed(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12,'doc2','x','Петров','doctor',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ',80000,'imaging')").run();
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (900, 'Клиника Партнёр')").run();
  db.prepare("INSERT INTO referral_sources (id, name, active) VALUES (901, 'Выключенный партнёр', 0)").run();
}
// Каждая строка — в своём визите: одна услуга дважды в одном визите — отказ (DUP_STOP_V1).
function visit(db) {
  return Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, ?, 'arrived')").run(at(TODAY, 9)).lastInsertRowid);
}
async function insertLine(t, who, values) {
  const before = lastVs(t.db);
  const r = await t.dbq(who, { table: 'visit_services', op: 'insert',
    values: { visit_id: visit(t.db), quantity: 1, unit_price: 1, total: 1, status: 'added', ...values } });
  const id = lastVs(t.db);
  return { status: r.status, text: r.text, id: id !== before ? id : null };
}
const updateLine = (t, who, id, values) => t.dbq(who, { table: 'visit_services', op: 'update', values,
  filters: [{ col: 'id', op: 'eq', val: id }] });

test('врач: строка к другому исполнителю — его внутренний источник; присланный браузером чужой — не читается', async () => {
  const t = await startCrmApp(seed);
  try {
    const r = await insertLine(t, 'doc', { service_id: 50, doctor_id: 12, referred_by_source_id: srcOf(t.db, 12) });
    assert.equal(r.status, 200, r.text);
    assert.equal(stampOf(t.db, r.id).src, srcOf(t.db, 10));
    const lab = await insertLine(t, 'doc', { service_id: 40, referred_by_source_id: 900 });
    assert.equal(lab.status, 200, lab.text);
    assert.equal(stampOf(t.db, lab.id).src, srcOf(t.db, 10), 'анализ без исполнителя — направление врача');
  } finally { t.close(); }
});

test('врач: своя строка — без направившего; его источник выключен — без направившего', async () => {
  const t = await startCrmApp(seed);
  try {
    const own = await insertLine(t, 'doc', { service_id: 30, doctor_id: 10 });
    assert.equal(own.status, 200, own.text);
    assert.equal(stampOf(t.db, own.id).src, null);
    t.db.prepare('UPDATE referral_sources SET active = 0 WHERE doctor_id = 10').run();
    const off = await insertLine(t, 'doc', { service_id: 50, doctor_id: 12 });
    assert.equal(off.status, 200, off.text);
    assert.equal(stampOf(t.db, off.id).src, null);
  } finally { t.close(); }
});

test('стойка: «Кто направил» — явно и только включённый; без него — пусто; источник самого исполнителя — пусто', async () => {
  const t = await startCrmApp(seed);
  try {
    const set = await insertLine(t, 'reg', { service_id: 40, referred_by_source_id: 900 });
    assert.equal(set.status, 200, set.text);
    assert.equal(stampOf(t.db, set.id).src, 900);
    const none = await insertLine(t, 'reg', { service_id: 40 });
    assert.equal(none.status, 200, none.text);
    assert.equal(stampOf(t.db, none.id).src, null);
    const off = await insertLine(t, 'reg', { service_id: 40, referred_by_source_id: 901 });
    assert.equal(off.status, 400, off.text);
    assert.match(off.text, /не найден или выключен/);
    assert.equal(off.id, null, 'строка с выключенным источником легла');
    const ownLine = await insertLine(t, 'boss', { service_id: 50, doctor_id: 12, referred_by_source_id: srcOf(t.db, 12) });
    assert.equal(ownLine.status, 200, ownLine.text);
    assert.equal(stampOf(t.db, ownLine.id).src, null, 'врачу-исполнителю — «за направление» на свою же строку');
  } finally { t.close(); }
});

test('правкой направившего не меняет ни врач, ни стойка', async () => {
  const t = await startCrmApp(seed);
  try {
    const r = await insertLine(t, 'doc', { service_id: 50, doctor_id: 12 });
    assert.equal(r.status, 200, r.text);
    for (const who of ['doc', 'reg']) {
      const upd = await updateLine(t, who, r.id, { status: 'added', referred_by_source_id: 900 });
      assert.equal(upd.status, 200, who + ': ' + upd.text);
      assert.equal(stampOf(t.db, r.id).src, srcOf(t.db, 10), who + ' поменял направившего правкой');
    }
  } finally { t.close(); }
});

test('рекомендация для регистратуры пишется; длиннее 500 знаков — отказ, строки нет', async () => {
  const t = await startCrmApp(seed);
  try {
    const ok = await insertLine(t, 'doc', { service_id: 50, doctor_id: 12, referral_note: 'натощак, к 9:00' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(stampOf(t.db, ok.id).note, 'натощак, к 9:00');
    const long = await insertLine(t, 'doc', { service_id: 50, doctor_id: 12, referral_note: 'x'.repeat(501) });
    assert.ok(long.status >= 400 && long.status < 500, long.status + ' ' + long.text);
    assert.equal(long.id, null);
  } finally { t.close(); }
});
