// ADMIN_ACT_AS_V1 (2026-10-28) — правила входа от имени, проверяемые без HTTP:
//   • имя в журналах клиники: «Иванова А. (от имени: адм. Петров П.)», номер —
//     сотрудника (invoice_audit_log через кассу и счёт);
//   • R3 — подпись от чужого имени: каждая RPC подписи отказывает сама, до
//     любой работы; без входа от имени — как прежде;
//   • правило «новая или изменённая подпись» в записях кабинета.
// HTTP-сторона (вход, журнал, авто-конец) — routes/act-as.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { RPC } from './rpc/index.js';
import { createInvoiceForVisit } from './rpc/billing.js';
import { procedureComplete } from './rpc/procedures.js';
import { admissionReviewSave } from './rpc/inpatient-reviews.js';
import { visitDocumentArchive } from './rpc/patient-card.js';
import { refuseSignWhileActing, refuseDoctorDocWhileActing, docBodyGiven } from './act-as-sign.js';
import { actingActorName, isActing, ACT_AS_SIGN_REFUSAL, ACT_AS_END, ACT_AS_MAX_HOURS, ACT_AS_MESSAGES } from '../../public/js/shared/act-as.js';
import { STRINGS } from '../../public/js/admin/i18n-strings.js';
import { signedEntryAdded } from './domain/cabinet-notes.js';

const ADMIN = { id: 1, full_name: 'Петров П.' };
const acting = (user) => ({ ...user, acting_admin: { ...ADMIN } });
const isSignRefusal = (e) => e && e.status === 403 && e.code === 'sign_while_acting' && e.message === ACT_AS_SIGN_REFUSAL;

test('общие правила: имя «от имени», признак входа от имени, причины конца и предел 2 часа', () => {
  assert.equal(actingActorName(acting({ id: 3 }), 'Иванова А.'), 'Иванова А. (от имени: адм. Петров П.)');
  assert.equal(actingActorName({ id: 3, acting_admin: null }, 'Иванова А.'), 'Иванова А.', 'без входа от имени — имя как есть');
  assert.equal(actingActorName(null, 'Иванова А.'), 'Иванова А.');
  assert.equal(actingActorName({ id: 3 }, null), null, 'пустое имя без входа от имени остаётся пустым');
  assert.equal(isActing(acting({ id: 3 })), true);
  assert.equal(isActing({ id: 3, acting_admin: null }), false);
  assert.equal(isActing(undefined), false);
  assert.deepEqual(Object.values(ACT_AS_END).sort(), ['Вернулся', 'Вышел', 'Истекло', 'Сессия завершена', 'Сотрудник недоступен'].sort());
  assert.equal(ACT_AS_MAX_HOURS, 2);
  assert.equal(ACT_AS_SIGN_REFUSAL, 'Подписать документ врача от чужого имени нельзя — вернитесь к своей учётной записи; подписывает сам врач.');
});

test('все тексты входа от имени — в словаре экрана на трёх языках, без кириллицы в uz/en', () => {
  const phrases = [...Object.values(ACT_AS_MESSAGES), ACT_AS_SIGN_REFUSAL, ...Object.values(ACT_AS_END)];
  for (const p of phrases) {
    const e = STRINGS[p];
    assert.ok(e, 'нет в словаре: ' + p);
    assert.equal(e.ru, p);
    for (const lang of ['uz', 'en']) {
      assert.ok(e[lang] && e[lang] !== p, `${lang}: ${p}`);
      assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, `${lang} с кириллицей: ${p}`);
    }
  }
});

test('refuseSignWhileActing: от имени — 403 sign_while_acting с текстом R3; без — ничего', () => {
  assert.throws(() => refuseSignWhileActing(acting({ id: 3, role: 'doctor' })), isSignRefusal);
  assert.doesNotThrow(() => refuseSignWhileActing({ id: 3, role: 'doctor', acting_admin: null }));
  assert.doesNotThrow(() => refuseSignWhileActing({ id: 3, role: 'doctor' }));
  assert.doesNotThrow(() => refuseSignWhileActing(null));
});

test('ревью-2: текст документа визита — есть или нет (docBodyGiven); документ с текстом от имени — отказ R3', () => {
  for (const v of [{ a: 1 }, [1], 'текст', '{"a":1}', '"x"', 0, false]) assert.equal(docBodyGiven(v), true, JSON.stringify(v));
  for (const v of [undefined, null, '', '   ', {}, [], '{}', '[]', 'null', '""']) assert.equal(docBodyGiven(v), false, JSON.stringify(v));
  assert.throws(() => refuseDoctorDocWhileActing(acting({ id: 3 }), 'note', { a: 1 }), isSignRefusal);
  assert.throws(() => refuseDoctorDocWhileActing(acting({ id: 3 }), 'protocol', null), isSignRefusal);
  assert.doesNotThrow(() => refuseDoctorDocWhileActing(acting({ id: 3 }), 'upload', null));
  assert.doesNotThrow(() => refuseDoctorDocWhileActing({ id: 3 }, 'note', { a: 1 }), 'без входа от имени — как прежде');
});

test('правило записей кабинета: подпись новая или изменённая — да; прежние подписи, черновики, чужой текст — нет', () => {
  const N = (history, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current: {}, history, ...extra });
  const S1 = { kind: 'signed', savedAt: '2026-10-02T08:00:00.000Z', by: 3, fields: { a: '1', b: '2' } };
  const S2 = { kind: 'signed', savedAt: '2026-10-28T08:00:00.000Z', by: 3, fields: { a: '3' } };
  const D = { kind: 'draft', savedAt: '2026-10-28T07:00:00.000Z', fields: { a: 'x' } };
  assert.equal(signedEntryAdded(N([S1]), N([S1, S2])), true, 'новая подпись');
  assert.equal(signedEntryAdded(N([S1]), N([{ ...S1, fields: { a: '9', b: '2' } }])), true, 'та же дата, другое содержание');
  assert.equal(signedEntryAdded(null, N([S1])), true, 'первая подпись на пустой строке');
  assert.equal(signedEntryAdded(N([S1]), N([S1, D])), false, 'черновик после подписи');
  assert.equal(signedEntryAdded(N([S1]), N([{ fields: { b: '2', a: '1' }, by: 3, savedAt: S1.savedAt, kind: 'signed' }])), false, 'порядок ключей — не изменение');
  assert.equal(signedEntryAdded(N([S1, S2]), N([S1])), false, 'потеря подписи — забота другого правила');
  assert.equal(signedEntryAdded(N([S1]), 'Комментарий'), false);
  assert.equal(signedEntryAdded('Комментарий', N([D])), false);
  assert.equal(signedEntryAdded(N([S1]), null), false);
});

// ─── R3: каждая RPC подписи отказывает сама ─────────────────────────────────

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, extra_roles, is_doctor) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Петров П.', 'admin', '[]', 0);
  u.run(3, 'doc', 'x', 'Иванова А.', 'doctor', '[]', 1);
  u.run(4, 'nurse', 'x', 'Медсестра Н.', 'nurse', '[]', 0);
  u.run(7, 'reg', 'x', 'Регистратор Р.', 'registrar', '[]', 0);
  u.run(9, 'cash', 'x', 'Кассир К.', 'cashier', '[]', 0);
  u.run(11, 'head', 'x', 'Старший кассир С.', 'cashier', '["head_cashier"]', 0);
  u.run(12, 'hdoc', 'x', 'Главврач Г.', 'doctor', '["head_doctor"]', 1);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (1, 'Приём', 100000, 'consultation'), (2, 'Инъекция', 50000, 'procedure')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1, 1, '2026-10-28T07:00:00Z')").run();
  const line = db.prepare("INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?, 1, ?, ?, 1, 100000, 100000, ?)");
  line.run(1, 1, 3, 'added');
  line.run(2, 2, null, 'queued');
  line.run(3, 1, 3, 'in_progress');
  return db;
}

test('R3: процедура, запись стационара, копия подписи — от имени отказ ДО любой работы; сам сотрудник — как прежде', () => {
  const db = clinic();
  const nurse = { id: 4, role: 'nurse', full_name: 'Медсестра Н.' };
  const doc = { id: 3, role: 'doctor', full_name: 'Иванова А.' };
  const hdoc = { id: 12, role: 'doctor', extra_roles: ['head_doctor'], full_name: 'Главврач Г.' };

  assert.throws(() => procedureComplete(db, { kind: 'outpatient', id: 2 }, acting(nurse)), isSignRefusal);
  assert.throws(() => RPC.procedure_complete(db, { kind: 'outpatient', id: 2 }, acting(nurse)), isSignRefusal);
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 2').get().status, 'queued');
  procedureComplete(db, { kind: 'outpatient', id: 2 }, nurse);
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 2').get().status, 'completed');

  // Отказ до разбора аргументов: даже пустой вызов — R3, а не «не найдено».
  assert.throws(() => admissionReviewSave(db, {}, acting(hdoc)), isSignRefusal);
  assert.throws(() => RPC.admission_review_save(db, { admission_id: 1, kind: 'primary' }, acting(hdoc)), isSignRefusal);
  assert.throws(() => admissionReviewSave(db, { admission_id: 999, kind: 'primary' }, hdoc), (e) => !isSignRefusal(e), 'без входа от имени — обычные проверки');

  const args = { visit_service_id: 3, doc_type: 'protocol', title: 'Протокол', body: { complaints: 'Кашель' } };
  assert.throws(() => visitDocumentArchive(db, args, acting(doc)), isSignRefusal);
  assert.throws(() => RPC.visit_document_archive(db, args, acting(doc)), isSignRefusal);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n, 0);
  visitDocumentArchive(db, args, doc);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n, 1);
});

// ─── Имя «от имени» в журналах клиники, которые пишет сервер ────────────────

test('журнал счёта: правка строки и отмена счёта от имени — имя «сотрудник (от имени: адм. …)», номер — сотрудника', () => {
  const db = clinic();
  const reg = { id: 7, role: 'registrar', full_name: 'Регистратор Р.' };
  const head = { id: 11, role: 'cashier', extra_roles: ['head_cashier'], full_name: 'Старший кассир С.' };
  const cashier = { id: 9, role: 'cashier', full_name: 'Кассир К.' };
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (4, 1, 1, 3, 1, 100000, 100000, 'added')").run();
  const out = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1, 4] }, reg);

  RPC.cashier_line_remove(db, { visit_service_id: 4 }, acting(head));
  const removed = db.prepare("SELECT actor_user_id, actor_name FROM invoice_audit_log WHERE action = 'line_remove'").get();
  assert.ok(removed, 'строка журнала счёта записана');
  assert.equal(removed.actor_user_id, 11, 'номер — сотрудника: права и принадлежность — его');
  assert.equal(removed.actor_name, 'Старший кассир С. (от имени: адм. Петров П.)');

  RPC.void_invoice(db, { invoice_id: out.invoice.id, reason: 'Ошибка' }, acting(cashier));
  const voided = db.prepare("SELECT actor_user_id, actor_name FROM invoice_audit_log WHERE action = 'void'").get();
  assert.equal(voided.actor_user_id, 9);
  assert.equal(voided.actor_name, 'Кассир К. (от имени: адм. Петров П.)');

  // Без входа от имени — имя как прежде.
  const db2 = clinic();
  const out2 = createInvoiceForVisit(db2, { visit_id: 1, visit_service_ids: [1] }, reg);
  RPC.void_invoice(db2, { invoice_id: out2.invoice.id, reason: 'Ошибка' }, cashier);
  assert.equal(db2.prepare("SELECT actor_name FROM invoice_audit_log WHERE action = 'void'").get().actor_name, 'Кассир К.');
});
