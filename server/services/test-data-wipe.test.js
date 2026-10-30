// TEST_DATA_WIPE_V1 — удаление тестовых данных на базе, собранной миграциями и
// наполненной всеми видами записей: что удалено, что осталось, ссылки целы,
// номера счетов с 1, запрет на удаление денег вернулся, сбой откатывает всё.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createDeposit, acceptDeposit, nextDepositNumber } from './rpc/deposits.js';
import { createInvoiceForVisit, recordPayment } from './rpc/billing.js';
import { openCashShift, cashMove } from './rpc/cashier.js';
import { sellCard, nextCardSaleNumber } from './rpc/card-sales.js';
import { wipeTestData } from './test-data-wipe.js';
import { tablesBy } from './test-data-wipe-plan.js';

const REG = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH = { id: 9, role: 'cashier', full_name: 'Юлдашева' };

const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
const ins = (db, sql, ...args) => db.prepare(sql).run(...args).lastInsertRowid;

// Всё, что бывает у учебной клиники: визиты с анализами и документами,
// стационар с назначениями и списаниями, деньги настоящими путями кассы,
// склад, брони онлайн-записи, CRM, Telegram — и то, что должно остаться.
function seeded() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, login, name, role] of [[1, 'a', 'Админ', 'admin'], [5, 'd', 'Врач', 'doctor'], [7, 'r', 'Каримова', 'registrar'], [9, 'c', 'Юлдашева', 'cashier']]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)').run(id, login, 'x', name, role);
  }
  const p = {};
  p.patient = ins(db, "INSERT INTO patients (full_name, branch_id, phone, photo_url, allergies, chronic_conditions) VALUES ('Учебный Пациент', 1, '+998901112233', 'patients/1/photo.jpg', 'пенициллин', 'гипертония')");
  p.mother = ins(db, "INSERT INTO patients (full_name, branch_id) VALUES ('Учебная Мама', 1)");
  ins(db, "INSERT INTO patient_guardians (patient_id, guardian_patient_id, name) VALUES (?, ?, 'Мама')", p.patient, p.mother);
  ins(db, "INSERT INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (?, ?, 'child')", p.patient, p.mother);
  ins(db, "INSERT INTO patient_conditions (patient_id, label) VALUES (?, 'Гипертония')", p.patient);
  p.svc = ins(db, "INSERT INTO services (name, price, is_lab) VALUES ('ОАК', 100000, 1)");
  p.product = ins(db, "INSERT INTO products (name, on_hand, avg_cost) VALUES ('Шприц 5 мл', 40, 1200)");
  p.ward = ins(db, "INSERT INTO wards (name) VALUES ('Палата 1')");
  p.bed = ins(db, "INSERT INTO beds (code, ward_id, status) VALUES ('1-1', ?, 'occupied')", p.ward);
  p.bedRepair = ins(db, "INSERT INTO beds (code, ward_id, status) VALUES ('1-2', ?, 'maintenance')", p.ward);
  p.source = ins(db, "INSERT INTO referral_sources (name) VALUES ('Внешний врач')");
  ins(db, "INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone) VALUES (?, '555', '+998900000000')", p.source);
  p.conn = ins(db, "INSERT INTO api_connections (kind, name, crm_source_key, key_hash, key_sealed, secret_sealed) VALUES ('partner', 'Партнёр', 'other', ?, 'x', 'x')", 'a'.repeat(64));

  // CRM и Telegram — остаются.
  p.card = ins(db, "INSERT INTO crm_requests (full_name, phone, patient_id, status) VALUES ('Учебный Пациент', '+998901112233', ?, 'scheduled')", p.patient);
  // Поправка 8: карточка, которую приход по учебному визиту закрыл ('done'), и
  // карточка без записи — их стадии и статусы строк удаление тоже не трогает.
  p.cardCame = ins(db, "INSERT INTO crm_requests (full_name, phone, patient_id, status) VALUES ('Учебный Пациент', '+998901112233', ?, 'came')", p.patient);
  p.cardIdle = ins(db, "INSERT INTO crm_requests (full_name, phone, status) VALUES ('Без записи', '+998907776655', 'in_process')");
  ins(db, "INSERT INTO crm_tags (key, label) VALUES ('vip', 'VIP')");
  ins(db, "INSERT INTO crm_request_tags (request_id, tag_key) VALUES (?, 'vip')", p.card);
  ins(db, "INSERT INTO crm_tasks (request_id, text) VALUES (?, 'Перезвонить')", p.card);
  ins(db, "INSERT INTO calls (general_call_id, started_at, patient_id) VALUES ('call-1', '2026-10-01T09:00:00Z', ?)", p.patient);
  ins(db, "INSERT INTO telegram_links (chat_id, phone) VALUES ('777', '+998901112233')");
  ins(db, "INSERT INTO telegram_messages (chat_id, direction, text) VALUES ('777', 'in', 'Здравствуйте')");
  ins(db, "INSERT INTO telegram_broadcasts (text_ru) VALUES ('Акция')");

  // Визит со всем, что под ним.
  p.visit = ins(db, "INSERT INTO visits (patient_id, branch_id, doctor_id, visit_date) VALUES (?, 1, 5, strftime('%Y-%m-%dT%H:%M:%SZ','now'))", p.patient);
  p.vs = ins(db, "INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?, ?, 5, 1, 100000, 100000, 'added')", p.visit, p.svc);
  ins(db, "INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?, 'HGB', '140')", p.vs);
  ins(db, "INSERT INTO lab_device_messages (raw, status, visit_service_id) VALUES ('MSH|...', 'applied', ?)", p.vs);
  ins(db, "INSERT INTO service_queue_tickets (visit_service_id, visit_id, service_id, number) VALUES (?, ?, ?, 1)", p.vs, p.visit, p.svc);
  ins(db, 'INSERT INTO recommended_services (patient_id, service_id, source_visit_id) VALUES (?, ?, ?)', p.patient, p.svc, p.visit);
  ins(db, 'INSERT INTO patient_vitals (patient_id, visit_id, pulse_bpm) VALUES (?, ?, 72)', p.patient, p.visit);
  ins(db, "INSERT INTO custdev_cards (visit_id, patient_id, visit_date) VALUES (?, ?, '2026-10-01')", p.visit, p.patient);
  ins(db, "INSERT INTO doctor_bot_notifications (visit_id, referral_source_id, chat_id) VALUES (?, ?, '555')", p.visit, p.source);
  ins(db, "INSERT INTO visit_documents (patient_id, visit_id, visit_service_id, title, file_path) VALUES (?, ?, ?, 'Заключение', ?)",
    p.patient, p.visit, p.vs, `patients/${p.patient}/docs/1-a-scan.pdf`);
  // Поправка 6: скан в карте пациента без визита — тоже учебный документ.
  ins(db, "INSERT INTO visit_documents (patient_id, title, file_path) VALUES (?, 'Скан направления', ?)",
    p.patient, `patients/${p.patient}/docs/2-b-scan.pdf`);
  ins(db, "INSERT INTO telegram_deliveries (chat_id, patient_id, doc_kind, doc_ref, trigger) VALUES ('777', ?, 'lab', 'x', 'push')", p.patient);
  ins(db, "INSERT INTO patient_activity_log (patient_id, visit_id, entity_type, action, summary) VALUES (?, ?, 'visit', 'created', 'визит')", p.patient, p.visit);
  ins(db, "INSERT INTO patient_activity_log (patient_id, entity_type, action, summary) VALUES (?, 'invoice', 'paid', 'счёт')", p.patient);
  ins(db, "INSERT INTO patient_activity_log (patient_id, entity_type, action, summary) VALUES (?, 'patient', 'edited', 'карта')", p.patient);

  // Связи CRM с визитом. Запись перевела карточку в «Записан» (след в
  // crm_booking_undo) и сама её завела (created_request = 1): discardEmptyVisit
  // вернул бы стадию и удалил бы карточку — удаление тестовых данных нет.
  p.line = ins(db, "INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto, released_from_visit_id, released_vs_id, released_held) VALUES (?, ?, '2026-10-01', 'pending', ?, ?, 1, ?, ?, 1)",
    p.card, p.svc, p.visit, p.vs, p.visit, p.vs);
  p.lineDone = ins(db, "INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id, visit_service_id) VALUES (?, ?, '2026-10-01', 'done', ?, ?)",
    p.cardCame, p.svc, p.visit, p.vs);
  p.lineIdle = ins(db, "INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, ?, '2026-11-01', 'pending')", p.cardIdle, p.svc);
  ins(db, 'INSERT INTO crm_booking_links (visit_id, request_id, created_request) VALUES (?, ?, 1)', p.visit, p.card);
  ins(db, "INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, set_status) VALUES (?, ?, 'recall', 'scheduled')", p.visit, p.card);
  ins(db, 'INSERT INTO crm_card_visit_views (request_id, visit_id) VALUES (?, ?)', p.card, p.visit);

  // Деньги — настоящими путями кассы: счёт, баланс, оплата с баланса и
  // наличными, продажа карты, внесение в кассу.
  openCashShift(db, { opening_float: 0 }, CASH);
  p.invoice = createInvoiceForVisit(db, { visit_id: p.visit, visit_service_ids: [p.vs] }, REG).invoice.id;
  const { deposit } = createDeposit(db, { patient_id: p.patient, amount: 300000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  recordPayment(db, { invoice_id: p.invoice, amount: 40000, method: 'wallet' }, CASH);
  recordPayment(db, { invoice_id: p.invoice, amount: 60000, method: 'cash' }, CASH);
  sellCard(db, { kind: 'gift_card', amount: 50000, method: 'cash', patient_id: p.patient }, CASH);
  cashMove(db, { kind: 'in', amount: 1000, article: 'размен' }, CASH);
  // Карта, заведённая в настройках, — остаётся; потраченное по ней — нет.
  p.giftCard = ins(db, "INSERT INTO patient_discounts (name, kind, amount, active) VALUES ('Подарочная 30', 'gift_card', 30000, 1)");
  ins(db, 'INSERT INTO card_ledger (discount_id, amount, remaining_after) VALUES (?, -10000, 20000)', p.giftCard);
  db.prepare('UPDATE patient_discounts SET remaining = 20000 WHERE id = ?').run(p.giftCard);
  ins(db, "INSERT INTO invoice_audit_log (invoice_id, visit_id, action) VALUES (?, ?, 'created')", p.invoice, p.visit);
  ins(db, "INSERT INTO pay_periods (month, closed_by) VALUES ('2026-09', 1)");
  ins(db, "INSERT INTO pay_period_lines (month, kind, line_key, data) VALUES ('2026-09', 'out', 'vs:1', '{}')");
  ins(db, "INSERT INTO pay_period_log (month, action, user_id) VALUES ('2026-09', 'close', 1)");
  ins(db, "INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, ?)", p.vs, p.invoice);
  ins(db, "INSERT INTO money_idempotency (key, rpc, result) VALUES ('k-test-0001', 'record_payment', '{}')");

  // Стационар: госпитализация со счётом выписки (цикл admissions ↔ invoices).
  p.adm = ins(db, "INSERT INTO admissions (patient_id, bed_id, ward_id, status) VALUES (?, ?, ?, 'active')", p.patient, p.bed, p.ward);
  p.admInvoice = ins(db, "INSERT INTO invoices (invoice_number, patient_id, admission_id, total_amount, status) VALUES ('INV-A-26-77777', ?, ?, 0, 'unpaid')", p.patient, p.adm);
  db.prepare('UPDATE admissions SET invoice_id = ? WHERE id = ?').run(p.admInvoice, p.adm);
  ins(db, "INSERT INTO admission_diets (admission_id, diet_code) VALUES (?, '1')", p.adm);
  ins(db, "INSERT INTO admission_meals (admission_id, meal_date, meal_key, status) VALUES (?, '2026-10-01', 'lunch', 'waiting')", p.adm);
  ins(db, 'INSERT INTO admission_prescriptions (admission_id, patient_id) VALUES (?, ?)', p.adm, p.patient);
  const r2 = ins(db, 'INSERT INTO admission_reviews (admission_id) VALUES (?)', p.adm);
  ins(db, 'INSERT INTO admission_reviews (admission_id, superseded_by) VALUES (?, ?)', p.adm, r2);
  p.admSvc = ins(db, 'INSERT INTO admission_services (admission_id, service_id) VALUES (?, ?)', p.adm, p.svc);
  ins(db, 'INSERT INTO admission_title_sheets (admission_id) VALUES (?)', p.adm);
  ins(db, 'INSERT INTO admission_transfers (admission_id, to_bed_id) VALUES (?, ?)', p.adm, p.bed);
  ins(db, "INSERT INTO admission_vitals (admission_id, measured_at) VALUES (?, '2026-10-01T09:00:00Z')", p.adm);
  ins(db, 'INSERT INTO med_administrations (admission_id, patient_id) VALUES (?, ?)', p.adm, p.patient);
  const order = ins(db, "INSERT INTO treatment_orders (admission_id, name, starts_on) VALUES (?, 'Анальгин', '2026-10-01')", p.adm);
  const given = ins(db, "INSERT INTO treatment_administrations (order_id, due_date, status) VALUES (?, '2026-10-01', 'given')", order);
  ins(db, 'INSERT INTO stock_pending_writeoffs (admission_service_id, administration_id, admission_id, product_id, base_qty, qty) VALUES (?, ?, ?, ?, 1, 1)',
    p.admSvc, given, p.adm, p.product);

  // Склад.
  ins(db, "INSERT INTO stock_movements (product_id, kind, qty) VALUES (?, 'receive', 40)", p.product);
  ins(db, "INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES ('room', 1, ?, 2)", p.product);
  const cnt = ins(db, "INSERT INTO stock_counts (count_number) VALUES ('SC-1')");
  ins(db, 'INSERT INTO stock_count_items (count_id, product_id) VALUES (?, ?)', cnt, p.product);
  ins(db, "INSERT INTO stock_issue_receipts (key, result) VALUES ('issue-1', '{}')");
  const po = ins(db, "INSERT INTO purchase_orders (po_number) VALUES ('PO-1')");
  ins(db, 'INSERT INTO purchase_order_items (po_id, product_id, qty_ordered) VALUES (?, ?, 1)', po, p.product);
  const req = ins(db, "INSERT INTO purchase_requisitions (req_number, converted_po_id) VALUES ('PR-1', ?)", po);
  ins(db, 'INSERT INTO purchase_requisition_items (req_id, product_id, qty) VALUES (?, ?, 1)', req, p.product);

  // Онлайн-запись: бронь уходит, заявка «перезвоните» остаётся.
  p.appt = ins(db, `INSERT INTO api_requests (public_id, connection_id, kind, status, doctor_id, start_at, duration_minutes, received_at, visit_id)
                    VALUES ('rq_appt0001', ?, 'appointment', 'confirmed', 5, '2026-10-01T09:00:00Z', 30, '2026-09-30T09:00:00Z', ?)`, p.conn, p.visit);
  p.callback = ins(db, `INSERT INTO api_requests (public_id, connection_id, kind, status, received_at, visit_id, crm_request_id)
                        VALUES ('rq_call00001', ?, 'request', 'arrived', '2026-09-30T09:00:00Z', ?, ?)`, p.conn, p.visit, p.card);
  ins(db, "INSERT INTO slot_holds (doctor_id, start_at, duration_minutes, until_at, api_request_id, kind) VALUES (5, '2026-10-01T09:00:00Z', 30, '2026-10-01T09:30:00Z', ?, 'booking')", p.appt);
  ins(db, "INSERT INTO api_outbox (connection_id, api_request_id, event, status, body) VALUES (?, ?, 'appointment.confirmed', 'pending', '{}')", p.conn, p.appt);
  ins(db, "INSERT INTO api_outbox (connection_id, api_request_id, event, status, body) VALUES (?, ?, 'request.accepted', 'pending', '{}')", p.conn, p.callback);

  // Связь зданий: прежнее надгробие и прежние отметки по картам остаются.
  ins(db, "INSERT INTO sync_tombstones (tbl, uid) VALUES ('patients', 'old-patient-uid')");
  ins(db, "INSERT INTO sync_seen (tbl, uid, col, stamp) VALUES ('patients', 'p-uid', 'phone', '1'), ('visits', 'v-uid', 'status', '1')");
  ins(db, "INSERT INTO sync_pending (tbl, uid, stamp, record, waits_tbl, waits_uid) VALUES ('visit_services', 'vs-uid', '1', '{}', 'visits', 'v-uid')");
  ins(db, "INSERT INTO sync_refused (tbl, uid, peer, err) VALUES ('invoices', 'i-uid', 'B', 'x')");
  return { db, p };
}

const KEPT = ['patients', 'patient_guardians', 'patient_relationships', 'patient_conditions', 'crm_requests', 'crm_request_tags',
  'crm_tasks', 'calls', 'telegram_links', 'telegram_messages', 'telegram_broadcasts', 'users', 'services', 'products', 'beds',
  'wards', 'referral_sources', 'doctor_bot_links', 'api_connections', 'crm_request_services'];

test('каждая удаляемая таблица наполнена до удаления и пуста после; оставленное — на месте', () => {
  const { db, p } = seeded();
  const empty = tablesBy('delete').filter((t) => count(db, t) === 0);
  assert.deepEqual(empty, [], 'наполнение теста должно покрывать каждую удаляемую таблицу');
  const keptBefore = Object.fromEntries(KEPT.map((t) => [t, count(db, t)]));
  const gone = Object.fromEntries(tablesBy('delete').map((t) => [t, count(db, t)]));
  const patientBefore = db.prepare('SELECT * FROM patients WHERE id = ?').get(p.patient);

  const r = wipeTestData(db);

  assert.deepEqual(tablesBy('delete').filter((t) => count(db, t) > 0), [], 'после удаления удаляемые таблицы пусты');
  assert.deepEqual(Object.fromEntries(KEPT.map((t) => [t, count(db, t)])), keptBefore, 'карты, CRM, Telegram, справочники — на месте');
  const patientAfter = db.prepare('SELECT * FROM patients WHERE id = ?').get(p.patient);
  assert.equal(patientAfter.photo_url, patientBefore.photo_url);
  assert.equal(patientAfter.allergies, 'пенициллин');
  assert.equal(patientAfter.chronic_conditions, 'гипертония');
  for (const t of tablesBy('delete')) assert.equal(r.deleted[t], gone[t], `итог ${t} — сколько строк было`);
  assert.equal(r.deleted.visits, 1);
  assert.equal(r.deleted.invoices, 4, 'счёт визита, квитанция депозита, продажа карты, счёт выписки');
  assert.equal(r.deleted.visit_documents, 2, 'документ визита и скан в карте без визита (поправка 6)');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'ни одной висячей ссылки');
  db.close();
});

test('частичные и очищаемые таблицы: остаётся ровно то, что решено', () => {
  const { db, p } = seeded();
  const lineStatus = db.prepare('SELECT status FROM crm_request_services WHERE id = ?').get(p.line).status;
  const stage = db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(p.card).status;
  wipeTestData(db);
  assert.deepEqual(db.prepare('SELECT entity_type FROM patient_activity_log').all().map((r) => r.entity_type), ['patient'],
    'журнал действий по визитам и счетам ушёл, запись о карте осталась');
  const reqs = db.prepare('SELECT id, kind, visit_id, crm_request_id FROM api_requests').all();
  assert.deepEqual(reqs, [{ id: p.callback, kind: 'request', visit_id: null, crm_request_id: p.card }], 'бронь ушла, заявка «перезвоните» осталась без визита');
  assert.deepEqual(db.prepare('SELECT api_request_id FROM api_outbox').all(), [{ api_request_id: p.callback }]);
  const cards = db.prepare("SELECT id, remaining, sale_invoice_id FROM patient_discounts WHERE kind = 'gift_card'").all();
  assert.deepEqual(cards, [{ id: p.giftCard, remaining: 30000, sale_invoice_id: null }], 'проданная карта ушла; заведённая — с полным остатком');
  const line = db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(p.line);
  assert.deepEqual([line.visit_id, line.visit_service_id, line.visit_service_auto, line.released_from_visit_id, line.released_vs_id, line.released_held],
    [null, null, 0, null, null, 0], 'строка карточки без ссылок на визит');
  assert.equal(line.status, lineStatus, 'статус строки карточки не трогается');
  assert.equal(line.scheduled_date, '2026-10-01');
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(p.card).status, stage, 'ступень карточки не трогается');
  assert.deepEqual(db.prepare('SELECT on_hand, avg_cost FROM products WHERE id = ?').get(p.product), { on_hand: 0, avg_cost: 0 }, 'остаток — с нуля');
  assert.equal(db.prepare('SELECT status FROM beds WHERE id = ?').get(p.bed).status, 'free');
  assert.equal(db.prepare('SELECT status FROM beds WHERE id = ?').get(p.bedRepair).status, 'maintenance', 'ремонт — не учебные данные');
  assert.equal(count(db, 'visit_documents'), 0, 'скан в карте пациента без визита тоже удалён (поправка 6)');
  db.close();
});

test('стадии карточек CRM и статусы их строк не меняются; итог называет карточки, потерявшие учебную запись (поправка 8)', () => {
  const { db, p } = seeded();
  // Оплата в кассе уже перевела карточку в «Пришёл». Вернуть её в «Записан» с
  // тем днём, что записан в следе crm_booking_undo: проигрыш следа (как в
  // discardEmptyVisit) вернул бы её в «Перезвонить» — тест бы это увидел.
  db.prepare("UPDATE crm_requests SET status = 'scheduled', scheduled_date = NULL WHERE id = ?").run(p.card);
  // Всё в строках карточек, кроме ссылок на визит, которые снимает удаление.
  const LINE_COLS = 'id, request_id, service_id, scheduled_date, status, note, created_at, doctor_id, consultation_type_id, legacy_copy';
  const cardsBefore = db.prepare('SELECT * FROM crm_requests ORDER BY id').all();
  const linesBefore = db.prepare(`SELECT ${LINE_COLS} FROM crm_request_services ORDER BY id`).all();

  const r = wipeTestData(db);

  assert.deepEqual(db.prepare('SELECT * FROM crm_requests ORDER BY id').all(), cardsBefore,
    'карточки на тех же стадиях и днях: crm_booking_undo не проигран, заведённая записью карточка не удалена');
  assert.deepEqual(db.prepare(`SELECT ${LINE_COLS} FROM crm_request_services ORDER BY id`).all(), linesBefore,
    'статусы и дни строк карточек те же');
  assert.equal(db.prepare('SELECT status FROM crm_request_services WHERE id = ?').get(p.lineDone).status, 'done', '«done» не возвращается в «pending»');
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(p.card).status, 'scheduled', '«Записан» остаётся «Записан»');
  assert.equal(r.crm_cards_unbooked, 2, 'две карточки держали учебный визит; карточка без записи не в счёт');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_request_services WHERE visit_id IS NOT NULL OR visit_service_id IS NOT NULL').get().n, 0);
  assert.ok(p.lineIdle);
  db.close();
});

test('номера счетов, депозитов и продаж карт снова с 1, а номера строк — дальше (штрихкоды проб)', () => {
  const { db, p } = seeded();
  const maxVs = db.prepare('SELECT MAX(id) AS m FROM visit_services').get().m;
  const seqBefore = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'visit_services'").get().seq;
  wipeTestData(db);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'visit_services'").get().seq, seqBefore, 'sqlite_sequence не тронут');
  openCashShift(db, { opening_float: 0 }, CASH);
  const v = ins(db, "INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))", p.patient);
  const vs = ins(db, "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, ?, 1, 100000, 100000, 'added')", v, p.svc);
  assert.ok(vs > maxVs, 'новая проба не получает номер учебной');
  const inv = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [vs] }, REG).invoice;
  assert.match(inv.invoice_number, /^INV-A-\d{2}-00001$/);
  assert.match(nextDepositNumber(db), /00001$/);
  assert.match(nextCardSaleNumber(db), /00001$/);
  db.close();
});

test('запрет на удаление денег снят только на время транзакции и вернулся тем же текстом', () => {
  const { db } = seeded();
  const sql = () => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'patient_deposits_no_delete'").get();
  const before = sql().sql;
  wipeTestData(db);
  assert.equal(sql().sql, before);
  db.close();
});

test('следы удаления в связи зданий убраны, прежние — остались', () => {
  const { db } = seeded();
  const journalMax = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_journal').get().m;
  const r = wipeTestData(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_journal WHERE seq > ?').get(journalMax).n, 0, 'в журнале нет «удалено» для другого здания');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM sync_journal').get().n > 0, 'прежний журнал остался');
  assert.deepEqual(db.prepare('SELECT tbl, uid FROM sync_tombstones').all(), [{ tbl: 'patients', uid: 'old-patient-uid' }], 'новых надгробий нет, прежнее осталось');
  assert.deepEqual(db.prepare('SELECT tbl FROM sync_seen').all(), [{ tbl: 'patients' }]);
  assert.equal(count(db, 'sync_pending'), 0);
  assert.equal(count(db, 'sync_refused'), 0);
  assert.ok(r.sync.sync_tombstones > 0, 'надгробия удаления сначала появились (триггеры), потом убраны');
  db.close();
});

test('сбой посередине откатывает всё: ни одна строка не удалена, запрет на месте', () => {
  const { db } = seeded();
  const before = Object.fromEntries(tablesBy('delete').map((t) => [t, count(db, t)]));
  const guardSql = () => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'patient_deposits_no_delete'").get();
  const guardBefore = guardSql().sql;
  db.exec("CREATE TEMP TRIGGER boom BEFORE DELETE ON visits BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => wipeTestData(db), /boom/);
  assert.equal(db.inTransaction, false, 'транзакция закрыта откатом');
  assert.deepEqual(Object.fromEntries(tablesBy('delete').map((t) => [t, count(db, t)])), before);
  assert.ok(guardSql());
  assert.equal(guardSql().sql, guardBefore, 'запрет вернулся тем же текстом');
  assert.equal(db.prepare('SELECT on_hand FROM products').get().on_hand, 40, 'и очистка откатилась');
  // Запрет действует: строку баланса с деньгами по-прежнему удалить нельзя.
  assert.throws(() => db.prepare("DELETE FROM patient_deposits WHERE status NOT IN ('pending','cancelled')").run(), /удалить нельзя/);
  db.close();
});

test('висячая ссылка, которую оставило бы удаление, — откат с именем таблицы', () => {
  const { db, p } = seeded();
  // Оставляемая таблица со ссылкой на визит без ON DELETE — как новая таблица,
  // которой забыли решение в плане.
  db.exec('CREATE TABLE wipe_probe (id INTEGER PRIMARY KEY, visit_id INTEGER REFERENCES visits(id))');
  db.prepare('INSERT INTO wipe_probe (visit_id) VALUES (?)').run(p.visit);
  const visits = count(db, 'visits');
  assert.throws(() => wipeTestData(db), /висячие ссылки в таблицах: wipe_probe/);
  assert.equal(db.inTransaction, false);
  assert.equal(count(db, 'visits'), visits, 'ничего не удалено');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'patient_deposits_no_delete'").get());
  db.close();
});
