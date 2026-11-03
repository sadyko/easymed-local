// DUP_STOP_V1 (остатки A1–A4, 3.21.0) — ПРОВЕРКИ ДВЕРИ /api/db ЧИТАЮТ СТРОКИ ТАК ЖЕ, КАК ИХ
// НАЙДЁТ САМА ЗАПИСЬ.
//
// Прежде проверки выбирали задетые строки ЧТЕНИЕМ с правами роли. Роль, которой правка
// разрешена, а чтение — нет (медсестра или врач без разделов данных пациента), получала 403
// на выборке, ошибку глотал catch — и проверка пропускалась:
//   • A1 — пакет снимался со строки, уже стоящей в счёте (refusePackageWrite);
//   • A2 — неоплаченная услуга уходила в работу (mirrorBefore → unpaidWorkRefusal);
//   • A3 — документ врача на возвращённой строке переписывался (refundedSignRefusal);
//     и приход по заявке CRM не отмечался (crmEvidenceTargets — не правило, отметка);
//   • A4 — compileUpdateTargets сам проверяет право на правку.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { compileUpdateTargets, compileDeleteTargets } from '../db/query-compiler.js';

const CUT = JSON.stringify({ sections: ['inventory'], levels: {}, grants: {} });   // только склад: данные пациентов не читаются

async function start({ cutDoctor = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const user = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  user.run(1, 'boss', hashPassword('password1'), 'Админ', 'admin', 0);
  user.run(2, 'reg', hashPassword('password1'), 'Регистратура', 'registrar', 0);
  user.run(10, 'doc', hashPassword('password1'), 'Иванов', 'doctor', 1);
  user.run(13, 'nurse', hashPassword('password1'), 'Медсестра', 'nurse', 0);
  db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)').run('nurse', CUT);
  if (cutDoctor) db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)').run('doctor', CUT);
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (30,'Консультация',100000,'consultation')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77,'Пациент Тест')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (500,77,'2026-11-03T09:00:00Z','arrived')").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  for (const who of ['boss', 'reg', 'doc', 'nurse']) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: who, password: 'password1' }),
    });
    assert.equal(res.status, 200, 'вход ' + who);
    cookies[who] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const dbq = async (who, desc) => {
    const res = await fetch(base + '/api/db', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies[who] },
      body: JSON.stringify(desc),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  return { db, dbq, close: () => { server.close(); db.close(); } };
}

const upd = (t, who, table, values, id) => t.dbq(who, { table, op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });

test('DUP_STOP_V1 (остаток A1): медсестра без чтения строк визита не снимает пакет со строки в счёте — 409, пакет на месте', async () => {
  const t = await start();
  try {
    t.db.prepare("INSERT INTO service_templates (id, name, is_package) VALUES (5,'Пакет «Чекап»',1)").run();
    t.db.prepare("INSERT INTO invoices (id, patient_id, visit_id, status, total_amount) VALUES (70,77,500,'unpaid',36000)").run();
    t.db.prepare('INSERT INTO invoice_items (id, invoice_id, service_id, quantity, unit_price, total) VALUES (71,70,40,1,36000,36000)').run();
    t.db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status, package_id, invoice_item_id) VALUES (900,500,40,1,36000,36000,'added',5,71)").run();
    const peek = await t.dbq('nurse', { table: 'visit_services', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: 900 }] });
    assert.equal(peek.status, 403, 'стенд: медсестре строки визита не отдаются');
    const r = await upd(t, 'nurse', 'visit_services', { package_id: null }, 900);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match(r.json.error.message, /^Строка уже в счёте/);
    assert.equal(t.db.prepare('SELECT package_id FROM visit_services WHERE id = 900').get().package_id, 5, 'пакет снят со строки в счёте');
    // строка вне счёта — снимается, как прежде
    t.db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status, package_id) VALUES (901,500,30,1,90000,90000,'added',5)").run();
    const free = await upd(t, 'nurse', 'visit_services', { package_id: null }, 901);
    assert.equal(free.status, 200, JSON.stringify(free.json));
    assert.equal(t.db.prepare('SELECT package_id FROM visit_services WHERE id = 901').get().package_id, null);
  } finally { t.close(); }
});

test('DUP_STOP_V1 (остаток A2): медсестра без чтения строк визита не берёт неоплаченный анализ в работу — 409, статус прежний', async () => {
  const t = await start();
  try {
    t.db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status) VALUES (900,500,40,1,40000,40000,'added')").run();
    const r = await upd(t, 'nurse', 'visit_services', { status: 'in_progress' }, 900);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match(r.json.error.message, /ещё не оплачен/);
    assert.equal(t.db.prepare('SELECT status FROM visit_services WHERE id = 900').get().status, 'added', 'неоплаченная услуга ушла в работу');
    // регистратура читает строки — отказ тот же (правило одно)
    const reg = await upd(t, 'reg', 'visit_services', { status: 'in_progress' }, 900);
    assert.equal(reg.status, 409, JSON.stringify(reg.json));
  } finally { t.close(); }
});

// DUP_STOP_V1 (ревью полировки L1, проба PA1) — отказ «ещё не оплачен» называл услугу строки:
// медсестра со складом, которой строки визита не читаются, узнавала по номеру строки название
// анализа или приёма любого неоплаченного визита («Анализ «ВИЧ (ИФА)» ещё не оплачен…»). Такой
// роли — те же слова без названия (как безымянный отказ повтора, остаток A5); стойке — с названием.
test('DUP_STOP_V1 (ревью полировки L1): медсестре без чтения строк визита отказ «ещё не оплачен» — без названия услуги; стойке — с названием', async () => {
  const t = await start();
  try {
    t.db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (41,'ВИЧ (ИФА)',90000,'lab',1)").run();
    t.db.prepare("INSERT INTO services (id, name, price, type) VALUES (31,'Консультация венеролога',150000,'consultation')").run();
    t.db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status) VALUES (900,500,41,1,90000,90000,'added')").run();
    t.db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status) VALUES (901,500,31,1,150000,150000,'added')").run();
    const peek = await t.dbq('nurse', { table: 'visit_services', op: 'select', columns: 'id,service_id', filters: [{ col: 'id', op: 'eq', val: 900 }] });
    assert.equal(peek.status, 403, 'стенд: медсестре строки визита не отдаются');
    const cases = [
      [900, 'collected', 'Анализ ещё не оплачен — пробу берут и результат вносят после кассы.', 'Анализ «ВИЧ (ИФА)» ещё не оплачен — пробу берут и результат вносят после кассы.'],
      [901, 'completed', 'Консультация ещё не оплачена — подписать её можно после кассы.', 'Консультация «Консультация венеролога» ещё не оплачена — подписать её можно после кассы.'],
      [901, 'in_progress', 'Услуга ещё не оплачена — начать работу по ней можно после кассы.', 'Услуга «Консультация венеролога» ещё не оплачена — начать работу по ней можно после кассы.'],
    ];
    for (const [id, status, nameless, named] of cases) {
      const n = await t.dbq('nurse', { table: 'visit_services', op: 'update', values: { status }, filters: [{ col: 'id', op: 'eq', val: id }, { col: 'status', op: 'eq', val: 'added' }] });
      assert.equal(n.status, 409, JSON.stringify(n.json));
      assert.equal(n.json.error.message, nameless, 'медсестра ' + id + ' → ' + status);
      const r = await upd(t, 'reg', 'visit_services', { status }, id);
      assert.equal(r.status, 409, JSON.stringify(r.json));
      assert.equal(r.json.error.message, named, 'стойка ' + id + ' → ' + status);
    }
    assert.deepEqual(t.db.prepare('SELECT status FROM visit_services WHERE id IN (900, 901) ORDER BY id').all().map((r) => r.status), ['added', 'added']);
    // слова без названия — на трёх языках экрана
    const { STRINGS } = await import('../../public/js/admin/i18n-strings.js');
    for (const [, , nameless] of cases) {
      const e = STRINGS[nameless];
      assert.ok(e && e.ru === nameless && e.uz && e.en, 'нет статьи словаря: ' + nameless);
      assert.doesNotMatch(e.uz + e.en, /[А-Яа-яЁё]/, nameless);
    }
  } finally { t.close(); }
});

test('DUP_STOP_V1 (остаток A3): врач без разделов данных пациента не переписывает свой документ на возвращённой строке — 409 refunded_line', async () => {
  const t = await start({ cutDoctor: true });
  try {
    t.db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status, doctor_id) VALUES (900,500,30,1,100000,100000,'completed',10)").run();
    t.db.prepare("INSERT INTO invoices (id, patient_id, visit_id, status, total_amount) VALUES (70,77,500,'refunded',0)").run();
    t.db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out',900,70)").run();
    t.db.prepare("INSERT INTO visit_documents (id, patient_id, visit_id, visit_service_id, doc_type, title, body, created_by) VALUES (60,77,500,900,'conclusion','Заключение','прежний текст',10)").run();
    const peek = await t.dbq('doc', { table: 'visit_documents', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: 60 }] });
    assert.equal(peek.status, 403, 'стенд: этому врачу документы пациентов не отдаются');
    const r = await upd(t, 'doc', 'visit_documents', { body: 'новый текст' }, 60);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'refunded_line');
    assert.equal(t.db.prepare('SELECT body FROM visit_documents WHERE id = 60').get().body, 'прежний текст', 'документ возвращённой строки переписан');
    // название — можно (не подпись)
    const title = await upd(t, 'doc', 'visit_documents', { title: 'Заключение (копия)' }, 60);
    assert.equal(title.status, 200, JSON.stringify(title.json));
  } finally { t.close(); }
});

test('DUP_STOP_V1 (остаток A3): работа медсестры без чтения строк визита тоже доказывает приход по заявке CRM', async () => {
  const t = await start();
  try {
    t.db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (900,500,30,'queued')").run();
    const rid = t.db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES ('Лид','998900000000','scheduled',77,'2026-11-03')").run().lastInsertRowid;
    const lid = t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id) VALUES (?,30,'2026-11-03','pending',500)").run(rid).lastInsertRowid;
    const r = await upd(t, 'nurse', 'visit_services', { status: 'in_progress' }, 900);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(t.db.prepare('SELECT status FROM crm_request_services WHERE id = ?').get(lid).status, 'done', 'работа над пациентом не закрыла строку заявки');
  } finally { t.close(); }
});

test('DUP_STOP_V1 (остаток A4): выборка строк правки и удаления — только тому, кто эту запись вообще может', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const desc = { table: 'visit_services', filters: [{ col: 'id', op: 'eq', val: 1 }] };
    for (const role of ['callcenter', 'cashier']) {
      assert.throws(() => compileUpdateTargets(desc, { id: 5, role }, { db }, ['id', 'notes']), (e) => e.status === 403, role + ': правки строк визита нет — и выборки без правил чтения тоже');
    }
    assert.throws(() => compileUpdateTargets({ table: 'visit_documents', filters: desc.filters }, { id: 5, role: 'registrar' }, { db }, ['id']), (e) => e.status === 403, 'регистратура документы не правит');
    assert.ok(compileUpdateTargets(desc, { id: 13, role: 'nurse' }, { db }, ['id']).sql.startsWith('SELECT'), 'медсестра правит строки визита');
    assert.throws(() => compileDeleteTargets(desc, { id: 13, role: 'nurse' }, { db }, ['id']), (e) => e.status === 403, 'медсестра строки визита не удаляет');
    const del = compileDeleteTargets(desc, { id: 2, role: 'registrar' }, { db }, ['id', 'invoice_item_id']);
    assert.match(del.sql, /^SELECT "visit_services"\."id", "visit_services"\."invoice_item_id" FROM "visit_services" WHERE/);
    assert.throws(() => compileDeleteTargets({ table: 'visit_services', filters: [{ col: 'status', op: 'eq', val: 'added' }] }, { id: 2, role: 'registrar' }, { db }), (e) => e.status === 400, 'удаление — только по строкам, как сам DELETE');
  } finally { db.close(); }
});
