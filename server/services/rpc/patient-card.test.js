// PATIENT_TAB_ACCESS_V1 — ОТКАЗ ЖИВЁТ НА СЕРВЕРЕ.
//
// Владелец просил закрыть вкладки карты пациента. Спрятать вкладку в браузере —
// не защита: тот же запрос уходит curl'ом. Поэтому здесь проверяется не то, что
// экран чего-то не нарисовал, а то, что СЕРВЕР НЕ ОТДАЛ данные:
//
//   • закрытая вкладка приходит null, а не пустым массивом (пустой массив
//     означал бы «счетов не было», и регистратура повторяла бы это пациенту);
//   • отказ НАЗЫВАЕТ вкладку и говорит, к кому идти;
//   • «Изменение» без «Удаления» удалить не может;
//   • удаление там, где его не существует, не выдаётся никому и никогда;
//   • по умолчанию (сеяные роли) видно ВСЁ — обновление никого не отключает;
//   • реестр таблиц остаётся внешней границей: вкладка не может выдать роли
//     больше, чем ей вообще положено.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  patientCard, patientCardSavePatient, patientCardAddDocument,
  patientCardDeleteDocument, patientCardSetServiceDoctor,
  requireServicesEdit, requireServicesDelete, tabDeniedMessage,
} from './patient-card.js';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7,'reg','x','Регистратор','registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (3,'doc','x','Врач Иванов','doctor',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5,'lab','x','Лаборант','lab')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'cash','x','Кассир','cashier')").run();

  const pid = db.prepare("INSERT INTO patients (full_name, mrn, branch_id, address, notes) VALUES ('Пациент','MRN-1',1,'ул. Тестовая 1','аккуратен')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, doctor_id, branch_id, visit_date) VALUES (?,3,1,'2026-08-12T09:00:00Z')").run(pid).lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, price, is_lab) VALUES ('ОАК', 50000, 1)").run().lastInsertRowid;
  const vsid = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, notes) VALUES (?,?,3,1,50000,50000,'added',?)")
    .run(vid, sid, JSON.stringify({ history: [{ kind: 'signed', savedAt: '2026-08-12T10:00:00Z', fields: {} }] })).lastInsertRowid;
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, entered_by) VALUES (?, 'HGB', '140', 5)").run(vsid);
  const inv = db.prepare("INSERT INTO invoices (patient_id, visit_id, branch_id, invoice_number, subtotal, total_amount, paid_amount, status, created_by) VALUES (?,?,1,'INV-A-26-00001',50000,50000,0,'unpaid',7)")
    .run(pid, vid).lastInsertRowid;
  const item = db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,'ОАК',1,50000,50000)").run(inv, sid).lastInsertRowid;
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(item, vsid);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id) VALUES (?, 20000, 'cash', 9)").run(inv);
  const doc = db.prepare("INSERT INTO visit_documents (patient_id, visit_id, title, doc_type, body) VALUES (?,?,'Заключение','protocol','{\"a\":1}')").run(pid, vid).lastInsertRowid;
  return { db, pid, vid, vsid, inv, item, doc };
}

const setTabs = (db, role, tabs) => {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const p = JSON.parse(row.permissions);
  p.patient_tabs = tabs;
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), role);
};

const REGISTRAR = { id: 7, role: 'registrar' };
const DOCTOR    = { id: 3, role: 'doctor' };
const LAB       = { id: 5, role: 'lab' };
const CASHIER   = { id: 9, role: 'cashier' };

// I18N_COVERAGE_V1 — сообщение сервера это ШАБЛОН, а название вкладки едет в
// params (клиент переводит шаблон и подставляет уже потом). Проверяем и то, и
// другое: отказ обязан НАЗЫВАТЬ вкладку, чем бы её ни подставили.
function refuses(fn, { tab, matches }) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'отказа не было');
  if (tab) assert.equal(err.params && err.params.tab, tab, 'отказ не называет вкладку: ' + err.message);
  if (matches) assert.match(err.message, matches);
  assert.equal(err.status, 403);
  return err;
}

// ---------------------------------------------------------------------------
// По умолчанию — ровно то, что было вчера.
// ---------------------------------------------------------------------------
test('по умолчанию карта отдаёт ВСЕ вкладки — обновление никого не отключает', () => {
  const { db, pid } = seed();
  for (const user of [REGISTRAR, DOCTOR, LAB, CASHIER]) {
    const out = patientCard(db, { patient_id: pid }, user);
    assert.ok(Array.isArray(out.visits) && out.visits.length === 1, user.role + ': визиты на месте');
    assert.ok(Array.isArray(out.services) && out.services.length === 1, user.role + ': услуги на месте');
    assert.ok(Array.isArray(out.lab_results) && out.lab_results.length === 1, user.role + ': анализы на месте');
    assert.ok(Array.isArray(out.invoices) && out.invoices.length === 1, user.role + ': счета на месте');
    assert.ok(Array.isArray(out.docs) && out.docs.length === 1, user.role + ': документы на месте');
    assert.equal(out.patient_limited, false, user.role + ': анкета целиком');
    assert.equal(out.patient.address, 'ул. Тестовая 1');
  }
  db.close();
});

test('раздел «Пациенты» остаётся внешней границей — без него карты нет', () => {
  const { db, pid } = seed();
  // склад и колл-центр никогда не имели раздела «Пациенты» (миграции 013/059)
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (11,'sklad','x','inventory')").run();
  assert.throws(() => patientCard(db, { patient_id: pid }, { id: 11, role: 'inventory' }), /Пациенты/);
  db.close();
});

// ---------------------------------------------------------------------------
// Закрытая вкладка: данных нет, и сказано почему.
// ---------------------------------------------------------------------------
test('закрытый «Счёт» — сервер НЕ отдаёт ни счетов, ни позиций, ни оплат', () => {
  const { db, pid } = seed();
  setTabs(db, 'lab', { billing: 'none' });
  const out = patientCard(db, { patient_id: pid }, LAB);
  assert.equal(out.invoices, null, 'null, а не пустой массив: «не выдано» ≠ «счетов не было»');
  assert.equal(out.invoice_items, null);
  assert.equal(out.payments, null);
  assert.equal(out.tabs.billing, 'none');
  // а всё остальное на месте — закрыта ОДНА вкладка, а не карта
  assert.equal(out.visits.length, 1);
  assert.equal(out.lab_results.length, 1);
  db.close();
});

test('роль только с «Визитами» и «Услугами» не получает ни анализов, ни документов, ни денег', () => {
  const { db, pid } = seed();
  setTabs(db, 'registrar', { labs: 'none', docs: 'none', billing: 'none', details: 'none' });
  const out = patientCard(db, { patient_id: pid }, REGISTRAR);
  assert.equal(out.lab_results, null);
  assert.equal(out.lab_orders, null);
  assert.equal(out.docs, null);
  assert.equal(out.doc_notes, null);
  assert.equal(out.invoices, null);
  assert.equal(out.visits.length, 1, '«Визиты» открыты');
  assert.equal(out.services.length, 1, '«Услуги» открыты');
  // анкета сжимается до того, что и так видно в СПИСКЕ пациентов
  assert.equal(out.patient_limited, true);
  assert.equal(out.patient.full_name, 'Пациент');
  assert.equal(out.patient.address, undefined, 'адреса на закрытой «Детали» нет');
  assert.equal(out.patient.notes, undefined, 'заметок тоже');
  db.close();
});

test('закрытые «Визиты» — ни списка визитов, ни даты последнего в шапке; услуги при этом живут', () => {
  const { db, pid } = seed();
  setTabs(db, 'cashier', { visits: 'none', services: 'view' });
  const out = patientCard(db, { patient_id: pid }, CASHIER);
  assert.equal(out.visits, null);
  assert.equal(out.last_visit_date, null, 'шапка не подсказывает дату закрытой вкладки');
  assert.equal(out.services.length, 1, 'услуги не зависят от списка визитов');
  assert.equal(out.services[0].visit_date, '2026-08-12T09:00:00Z', 'дата услуги едет НА СТРОКЕ');
  db.close();
});

// SERVICES_TAB_V1 — «Услуги» отделились от «Визитов» уже после того, как
// администраторы начали настраивать роли. Настройка, сохранённая ДО разделения,
// не содержит ключа `services` вовсе, и «скрыть визиты» тогда означало «скрыть и
// услуги». Наследование сохраняет ровно это намерение; новый редактор всегда
// пишет `services` явно, поэтому правило срабатывает только на старых строках.
test('старая настройка «визиты скрыты» продолжает скрывать и услуги', () => {
  const { db, pid } = seed();
  setTabs(db, 'cashier', { visits: 'none' });   // ключа services нет — это старая строка
  const out = patientCard(db, { patient_id: pid }, CASHIER);
  assert.equal(out.visits, null);
  assert.equal(out.services, null);
  assert.equal(out.tabs.services, 'none');
  db.close();
});

test('отказ называет вкладку и говорит, к кому идти', () => {
  const msg = tabDeniedMessage('billing');
  assert.match(msg, /Счёт/);
  assert.match(msg, /администратор клиники/);
  assert.match(msg, /Роли/);
});

// ---------------------------------------------------------------------------
// Запись: изменение и удаление — разные права.
// ---------------------------------------------------------------------------
test('«Только просмотр» на «Детали» — анкету не сохранить', () => {
  const { db, pid } = seed();
  setTabs(db, 'registrar', { details: 'view' });
  refuses(() => patientCardSavePatient(db, { patient_id: pid, values: { notes: 'x' } }, REGISTRAR), { tab: 'Деталь', matches: /Только просмотр/ });
  assert.equal(db.prepare('SELECT notes FROM patients WHERE id=?').get(pid).notes, 'аккуратен');
  db.close();
});

test('закрытая «Деталь» — анкету не сохранить и отказ называет вкладку', () => {
  const { db, pid } = seed();
  setTabs(db, 'registrar', { details: 'none' });
  refuses(() => patientCardSavePatient(db, { patient_id: pid, values: { notes: 'x' } }, REGISTRAR), { tab: 'Деталь', matches: /закрыта для вашей роли/ });
  db.close();
});

test('сохранение анкеты пишет ТОЛЬКО колонки реестра — вкладка не расширяет права', () => {
  const { db, pid } = seed();
  const before = db.prepare('SELECT mrn, sync_origin FROM patients WHERE id=?').get(pid);
  patientCardSavePatient(db, { patient_id: pid, values: { notes: 'новая заметка', sync_origin: 'X', id: 999 } }, REGISTRAR);
  const after = db.prepare('SELECT id, notes, mrn, sync_origin FROM patients WHERE id=?').get(pid);
  assert.equal(after.notes, 'новая заметка');
  assert.equal(after.sync_origin, before.sync_origin, 'метка филиала не writable ни через какую вкладку');
  assert.equal(after.id, pid);
  db.close();
});

test('реестр таблиц остаётся внешней границей: лаборанту анкету не сохранить даже с «Изменением»', () => {
  const { db, pid } = seed();
  setTabs(db, 'lab', { details: 'edit' });
  // patients.update — только admin/registrar (schema-registry.js)
  assert.throws(() => patientCardSavePatient(db, { patient_id: pid, values: { notes: 'x' } }, LAB), /прав/);
  db.close();
});

test('«Изменение» без «Удаления» на «Документах» — загрузить можно, удалить нельзя', () => {
  const { db, pid, doc } = seed();
  setTabs(db, 'doctor', { docs: 'edit' });
  const added = patientCardAddDocument(db, { patient_id: pid, row: { title: 'Скан', doc_type: 'upload' } }, DOCTOR);
  assert.ok(added.id, 'загрузка прошла');
  refuses(() => patientCardDeleteDocument(db, { patient_id: pid, document_id: doc }, DOCTOR), { tab: 'Документы', matches: /Удаление/ });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_documents WHERE voided_at IS NULL').get().n, 2, 'ничего не отозвано');
  db.close();
});

// PATIENT_FILE_ATTACH_V1 — уровень «Удаление» на вкладке «Документы» теперь
// ОТЗЫВАЕТ документ, а не стирает его: строка остаётся, помечается voided_*
// и перестаёт открываться. Проверяется здесь, а не только в
// patient-card-docs.test.js, потому что это ТО ЖЕ право и та же дверь.
test('«Удаление» на «Документах» — отзывает (строка остаётся); закрытая вкладка — нет', () => {
  const { db, pid, doc } = seed();
  setTabs(db, 'doctor', { docs: 'delete' });
  patientCardDeleteDocument(db, { patient_id: pid, document_id: doc }, DOCTOR);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n, 1, 'клиническая запись не стирается');
  const after = db.prepare('SELECT voided_at, voided_by FROM visit_documents WHERE id = ?').get(doc);
  assert.ok(after.voided_at, 'документ помечен отозванным');
  assert.equal(after.voided_by, DOCTOR.id, 'записано, КТО отозвал');

  const s2 = seed();
  setTabs(s2.db, 'doctor', { docs: 'none' });
  refuses(() => patientCardDeleteDocument(s2.db, { patient_id: s2.pid, document_id: s2.doc }, DOCTOR), { tab: 'Документы', matches: /закрыта для вашей роли/ });
  db.close(); s2.db.close();
});

test('удаления на «Счёте» не существует — его нельзя выдать даже настройкой', () => {
  const { db, pid } = seed();
  setTabs(db, 'registrar', { billing: 'delete' });
  const out = patientCard(db, { patient_id: pid }, REGISTRAR);
  assert.equal(out.tabs.billing, 'view', 'потолок вкладки — просмотр');
  assert.equal(out.caps.billing.del, false);
  assert.equal(out.caps.billing.edit, false);
  db.close();
});

test('строка услуги: смена врача требует «Изменения», снятие — «Удаления»', () => {
  const { db, pid, vsid } = seed();

  setTabs(db, 'registrar', { services: 'view' });
  refuses(() => patientCardSetServiceDoctor(db, { patient_id: pid, visit_service_id: vsid, doctor_id: 3 }, REGISTRAR), { tab: 'Услуги', matches: /Только просмотр/ });
  refuses(() => requireServicesEdit(db, REGISTRAR), { tab: 'Услуги', matches: /Только просмотр/ });
  refuses(() => requireServicesDelete(db, REGISTRAR), { tab: 'Услуги', matches: /Только просмотр/ });

  setTabs(db, 'registrar', { services: 'edit' });
  patientCardSetServiceDoctor(db, { patient_id: pid, visit_service_id: vsid, doctor_id: 3 }, REGISTRAR);
  assert.equal(db.prepare('SELECT doctor_id FROM visit_services WHERE id=?').get(vsid).doctor_id, 3);
  requireServicesEdit(db, REGISTRAR);                                    // проходит
  refuses(() => requireServicesDelete(db, REGISTRAR), { tab: 'Услуги', matches: /Удаление/ });   // а снять строку — нет

  setTabs(db, 'registrar', { services: 'delete' });
  requireServicesDelete(db, REGISTRAR);                                  // теперь проходит

  setTabs(db, 'registrar', { services: 'none' });
  refuses(() => requireServicesEdit(db, REGISTRAR), { tab: 'Услуги', matches: /закрыта для вашей роли/ });
  db.close();
});

test('нет пациента / нет id — честная ошибка, а не пустая карта', () => {
  const { db } = seed();
  assert.throws(() => patientCard(db, {}, REGISTRAR), /Не указан пациент/);
  assert.throws(() => patientCard(db, { patient_id: 999999 }, REGISTRAR), /не найден/);
  db.close();
});

test('документы: подписанные заключения кабинета врача едут вместе со вкладкой и исчезают вместе с ней', () => {
  const { db, pid } = seed();
  let out = patientCard(db, { patient_id: pid }, DOCTOR);
  assert.equal(out.doc_notes.length, 1, 'заключение из visit_services.notes на месте');
  setTabs(db, 'doctor', { docs: 'none' });
  out = patientCard(db, { patient_id: pid }, DOCTOR);
  assert.equal(out.doc_notes, null);
  db.close();
});
