// MY_REFERRALS_V1 (3.22.0, решение владельца 2026-11-07, п. 11) — «МОИ НАПРАВЛЕНИЯ» КАБИНЕТА ВРАЧА.
//
// Всё, что ЭТОТ врач направил (консультации, диагностика, анализы, процедуры, прочее) по всем
// пациентам: строки визитов, где направивший — он (правило «от врача» стойки, referral-orders.js:
// внутренний источник врача на строке, иначе его рекомендация, закрытая строкой, иначе он завёл
// строку врачом, а не стойкой) и исполнитель — не он; плюс его открытые рекомендации. Статус —
// не выставлено / ждёт оплаты / оплачено / в работе / готово / отменено / возвращено. Период — по
// дню направления (по умолчанию последние 30 дней). «Результат» — только готовое, у чего есть
// документ, и только если карта пациента роли открывает вкладку (то же правило, что у
// patient_doc_sources) — права шире прежних не становятся.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { myReferrals } from './my-referrals.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

process.env.TZ = 'Asia/Tashkent';

const U = {
  docA:  { id: 1, role: 'doctor', is_doctor: true },
  docB:  { id: 2, role: 'doctor', is_doctor: true },
  radio: { id: 3, role: 'doctor', is_doctor: true },
  lab:   { id: 4, role: 'lab' },
  reg:   { id: 5, role: 'registrar' },
  admDoc: { id: 6, role: 'admin', is_doctor: true },
  nurse: { id: 7, role: 'nurse' },
};

const NOW = new Date();
const iso = (daysAgo = 0) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'a', 'x', 'Алиев Анвар', 'doctor', 1);
  u.run(2, 'b', 'x', 'Боброва Белла', 'doctor', 1);
  u.run(3, 'r', 'x', 'Расулов Рустам', 'doctor', 1);
  u.run(4, 'l', 'x', 'Лаборант Лола', 'lab', 0);
  u.run(5, 'reg', 'x', 'Регистратура', 'registrar', 0);
  u.run(6, 'ad', 'x', 'Админ Доктор', 'admin', 1);
  u.run(7, 'n', 'x', 'Сестра Нина', 'nurse', 0);
  // Внутренний источник каждого врача заводит триггер миграции 122; у A он — №10, у B его нет.
  db.prepare('UPDATE referral_sources SET id = 10 WHERE doctor_id = 1').run();
  db.prepare('DELETE FROM referral_sources WHERE doctor_id = 2').run();
  const p = db.prepare('INSERT INTO patients (id, mrn, full_name, last_name, first_name) VALUES (?,?,?,?,?)');
  p.run(1, 'P-1', 'Пациентов Пётр', 'Пациентов', 'Пётр');
  p.run(2, 'P-2', 'Иванова Ирина', 'Иванова', 'Ирина');
  db.prepare("INSERT INTO departments (id, name, kind) VALUES (50, 'Лаборатория', 'laboratory')").run();
  const s = db.prepare('INSERT INTO services (id, name, price, type, department_id) VALUES (?,?,?,?,?)');
  s.run(1, 'УЗИ почек', 100000, 'imaging', null);
  s.run(2, 'ОАК', 50000, 'lab', null);
  s.run(3, 'Приём кардиолога', 150000, 'consultation', null);
  s.run(4, 'Инъекция', 20000, 'procedure', null);
  s.run(5, 'Аппендэктомия', 900000, 'other', null);
  s.run(6, 'Ферритин', 70000, 'consultation', 50);   // «Консультации» из отделения «Лаборатория» — анализ
  const v = db.prepare('INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,?,?,?)');
  v.run(1, 1, iso(0), 'arrived');
  v.run(2, 2, iso(0), 'scheduled');
  v.run(3, 1, iso(0), 'cancelled');
  v.run(4, 1, iso(40), 'arrived');
  return db;
}
let nextLine = 100;
function line(db, { visit = 1, service = 1, performer = null, by = 1, src = null, status = 'added', created = iso(0), ct = null } = {}) {
  const id = nextLine++;
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, total, status, created_by, referred_by_source_id, created_at)
              VALUES (?,?,?,?,?,1,1000,1000,?,?,?,?)`).run(id, visit, service, ct, performer, status, by, src, created);
  return id;
}
let nextInv = 1;
function bill(db, lineId, status) {
  const inv = nextInv++;
  db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status)
              VALUES (?,?,1,1,1000,1000,?,?)`).run(inv, 'INV-' + inv, status === 'paid' ? 1000 : 0, status);
  db.prepare('INSERT INTO invoice_items (id, invoice_id, service_id, quantity, unit_price, total) VALUES (?,?,1,1,1000,1000)').run(inv, inv);
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(inv, lineId);
}
const byId = (res) => Object.fromEntries(res.rows.filter((r) => r.kind === 'line').map((r) => [r.visit_service_id, r]));

test('MY_REFERRALS_V1: строки, направленные врачом, — его; своя строка, строка стойки и чужое направление — нет', () => {
  const db = seed();
  const a1 = line(db, { service: 1, performer: 3, by: 1, src: 10 });          // A → УЗИ к Расулову, источник A
  const b1 = line(db, { visit: 2, service: 2, performer: null, by: 2 });      // B без источника → ОАК
  const own = line(db, { service: 3, performer: 1, by: 1 });                  // своя строка A
  const desk = line(db, { service: 3, performer: 3, by: 5 });                 // стойка записала
  const deskRec = line(db, { visit: 2, service: 1, performer: 3, by: 5 });    // стойка закрыла рекомендацию B
  db.prepare("INSERT INTO recommended_services (patient_id, service_id, recommended_by, status, closed_at, visit_service_id) VALUES (2, 1, 2, 'done', ?, ?)").run(iso(0), deskRec);
  const aForB = line(db, { visit: 2, service: 4, performer: 7, by: 1 });      // A добавил рекомендацию B (у B нет источника)
  db.prepare("INSERT INTO recommended_services (patient_id, service_id, recommended_by, status, closed_at, visit_service_id) VALUES (2, 4, 2, 'done', ?, ?)").run(iso(0), aForB);

  const a = byId(myReferrals(db, {}, U.docA));
  assert.deepEqual(Object.keys(a).map(Number).sort(), [a1]);
  assert.equal(a[a1].service, 'УЗИ почек');
  assert.equal(a[a1].group, 'diag');
  assert.equal(a[a1].performer, 'Расулов Рустам');
  assert.equal(a[a1].patient_name, 'Пациентов Пётр');
  assert.equal(a[a1].status, 'not_billed');

  const b = byId(myReferrals(db, {}, U.docB));
  assert.deepEqual(Object.keys(b).map(Number).sort((x, y) => x - y), [b1, deskRec, aForB].sort((x, y) => x - y));
  assert.equal(b[b1].group, 'lab');
  assert.equal(b[aForB].group, 'procedure');
  assert.ok(!(own in a) && !(desk in a) && !(desk in b));
});

test('MY_REFERRALS_V1: статусы — не выставлено, ждёт оплаты, оплачено, в работе, готово, отменено, возвращено', () => {
  const db = seed();
  const notBilled = line(db, { performer: 3 });
  const unpaid = line(db, { performer: 3 }); bill(db, unpaid, 'unpaid');
  const debt = line(db, { performer: 3, status: 'queued' }); bill(db, debt, 'debt');
  const paid = line(db, { performer: 3, status: 'queued' }); bill(db, paid, 'paid');
  const work = line(db, { performer: 3, status: 'in_progress' }); bill(db, work, 'paid');
  const labWork = line(db, { service: 2, status: 'resulted' });
  const done = line(db, { performer: 3, status: 'completed' }); bill(db, done, 'paid');
  const cancelledLine = line(db, { performer: 3, status: 'cancelled' });
  const cancelledVisit = line(db, { visit: 3, performer: 3 });
  const refunded = line(db, { performer: 3, status: 'queued' });
  db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, 1)").run(refunded);
  const st = Object.fromEntries(Object.entries(byId(myReferrals(db, {}, U.docA))).map(([k, r]) => [k, r.status]));
  assert.deepEqual(st, {
    [notBilled]: 'not_billed', [unpaid]: 'awaiting_payment', [debt]: 'awaiting_payment', [paid]: 'paid',
    [work]: 'in_work', [labWork]: 'in_work', [done]: 'done', [cancelledLine]: 'cancelled', [cancelledVisit]: 'cancelled',
    [refunded]: 'refunded',
  });
});

test('MY_REFERRALS_V1: открытая рекомендация — «не выставлено», отменённая — «отменено»; закрытая строкой — строкой', () => {
  const db = seed();
  db.prepare("INSERT INTO recommended_services (id, patient_id, service_id, service_name, recommended_by, status, created_at) VALUES (1, 1, 5, 'Аппендэктомия', 1, 'pending', ?)").run(iso(1));
  db.prepare("INSERT INTO recommended_services (id, patient_id, service_id, recommended_by, status, closed_at, created_at) VALUES (2, 2, 3, 1, 'cancelled', ?, ?)").run(iso(0), iso(2));
  db.prepare("INSERT INTO recommended_services (id, patient_id, service_id, recommended_by, status, created_at) VALUES (3, 2, 3, 2, 'pending', ?)").run(iso(1));   // чужая
  const recs = myReferrals(db, {}, U.docA).rows.filter((r) => r.kind === 'rec');
  assert.deepEqual(recs.map((r) => [r.id, r.status, r.group, r.service, r.patient_name]), [
    [1, 'not_billed', 'other', 'Аппендэктомия', 'Пациентов Пётр'],
    [2, 'cancelled', 'consult', 'Приём кардиолога', 'Иванова Ирина'],
  ]);
});

test('MY_REFERRALS_V1: период — по дню направления, по умолчанию 30 дней; группа «Консультации» из лаборатории — анализ', () => {
  const db = seed();
  const old = line(db, { visit: 4, performer: 3, created: iso(40) });
  const fresh = line(db, { service: 6, created: iso(0) });
  const res = myReferrals(db, {}, U.docA);
  assert.deepEqual(Object.keys(byId(res)).map(Number), [fresh]);
  assert.equal(byId(res)[fresh].group, 'lab');
  assert.match(res.from, /^\d{4}-\d{2}-\d{2}$/);
  const wide = myReferrals(db, { from: iso(60).slice(0, 10), to: iso(0).slice(0, 10) }, U.docA);
  assert.deepEqual(Object.keys(byId(wide)).map(Number).sort(), [old, fresh].sort());
  assert.throws(() => myReferrals(db, { from: 'вчера' }, U.docA), (e) => e.status === 400);
  assert.throws(() => myReferrals(db, { from: '2026-01-10', to: '2026-01-01' }, U.docA), (e) => e.status === 400);
});

test('MY_REFERRALS_V1: открыто только врачу; данные пациентов — ворота роли', () => {
  const db = seed();
  for (const who of [U.nurse, U.reg, U.lab]) assert.throws(() => myReferrals(db, {}, who), (e) => e.status === 403);
  assert.doesNotThrow(() => myReferrals(db, {}, U.admDoc));
  // роль врача без клинических разделов — отказ ворот данных пациента
  db.prepare("INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES ('doctor', ?)").run(JSON.stringify({ sections: ['dashboard'] }));
  assert.throws(() => myReferrals(db, {}, U.docA), (e) => e.status === 403);
});

test('MY_REFERRALS_V1: «Результат» — у готового с документом и только при открытой вкладке карты', () => {
  const db = seed();
  const diag = line(db, { performer: 3, status: 'completed' });
  db.prepare("INSERT INTO visit_documents (doc_type, visit_id, visit_service_id, patient_id, body) VALUES ('diag', 1, ?, 1, '{}')").run(diag);
  const lab = line(db, { service: 2, status: 'completed' });
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?, 'HGB', '140')").run(lab);
  const noDoc = line(db, { performer: 3, status: 'completed' });
  const notDone = line(db, { performer: 3, status: 'in_progress' });
  db.prepare("INSERT INTO visit_documents (doc_type, visit_id, visit_service_id, patient_id, body) VALUES ('diag', 1, ?, 1, '{}')").run(notDone);
  const voided = line(db, { performer: 3, status: 'completed' });
  db.prepare("INSERT INTO visit_documents (doc_type, visit_id, visit_service_id, patient_id, body, voided_at) VALUES ('diag', 1, ?, 1, '{}', ?)").run(voided, iso(0));
  let r = byId(myReferrals(db, {}, U.docA));
  assert.equal(r[diag].result, 'doc');
  assert.equal(r[lab].result, 'labs');
  assert.equal(r[lab].performer, '', 'исполнителя у анализа нет — и не выдуман');
  assert.equal(r[noDoc].result, null);
  assert.equal(r[notDone].result, null);
  assert.equal(r[voided].result, null, 'отозванный документ не открывается');
  // вкладка «Документы» закрыта роли — документа нет, анализы есть
  db.prepare("INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES ('doctor', ?)").run(JSON.stringify({ sections: ['patients', 'consultation'], patient_tabs: { docs: 'none' } }));
  r = byId(myReferrals(db, {}, U.docA));
  assert.equal(r[diag].result, null);
  assert.equal(r[lab].result, 'labs');
});

test('MY_REFERRALS_V1: RPC в карте и в READ_ONLY_RPCS (чтение)', () => {
  assert.equal(typeof RPC.my_referrals, 'function');
  assert.equal(isReadOnlyRpc('my_referrals'), true);
});

test('MY_REFERRALS_V1: «Результат» находится окном patient_doc_sources у направившего врача (та же дверь, те же права)', async () => {
  const { patientDocSources } = await import('./patient-doc-sources.js');
  const db = seed();
  const diag = line(db, { performer: 3, status: 'completed' });
  db.prepare("INSERT INTO visit_documents (doc_type, visit_id, visit_service_id, patient_id, body) VALUES ('diag', 1, ?, 1, ?)")
    .run(diag, JSON.stringify({ service: 'УЗИ почек', description: 'Почки в норме.', conclusion: 'Патологии нет.', doctorName: 'Расулов Рустам' }));
  const lab = line(db, { service: 2, status: 'completed' });
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, verified_at) VALUES (?, 'HGB', '140', ?)").run(lab, iso(0));
  const rows = byId(myReferrals(db, {}, U.docA));
  assert.equal(rows[diag].result, 'doc');
  assert.equal(rows[lab].result, 'labs');
  const docs = patientDocSources(db, { patient_id: 1, limit: 100 }, U.docA);
  assert.ok(docs.groups.diag.some((d) => d.visit_service_id === diag), 'документа исследования нет в окне');
  assert.ok(docs.groups.labs.some((d) => (d.panels || []).some((p) => p.visit_service_id === lab)), 'анализа нет в окне');
});
