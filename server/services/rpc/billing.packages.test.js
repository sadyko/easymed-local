// PACKAGES_V1 — деньги пакета услуг.
//
// Правило (решения владельца 26.09): скидка пакета — построчно и только на
// услуги самого пакета; с категорией пациента не суммируется — на строке пакета
// действует бо́льшая из двух; срок — окно предложения, и счёт по визиту вне
// окна сервер не выставляет. Скидка строки хранится в invoice_items.
// discount_amount; скидка счёта = сумма скидок строк + ручная/категорийная
// скидка на строки без своей скидки. Отчёты и выплата врачу берут у строки её
// собственную скидку, а остаток скидки счёта разносят только по строкам без
// своей — иначе скидка пакета «размазалась» бы на чужую строку и урезала долю
// врача, к пакету не причастного.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, removeUnpaidService, changeUnpaidService } from './billing.js';
import { runReport, performedPayLines } from './reports.js';

const admin = { id: 9, role: 'admin' };
const registrar = { id: 7, role: 'registrar' };
const DAY = '2026-09-10T09:00:00Z';     // местный день визита — 10.09 (UTC+5 и UTC)
const FROM = '2026-09-01';
const TO = '2026-09-30';

// Клиника: врач 1 — 30 % на обе услуги; УЗИ 100 000 с налогом 6 %, анализ
// 50 000 без налога. Пакет «Осень» — 20 % на УЗИ, с 01.09 по 30.09.
function clinic({ categoryPct = 0, pkg = {} } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default)
                        VALUES (?,?,?,?,?,?,?,0)`);
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', 1, JSON.stringify([{ service_id: 1, pct: 30 }, { service_id: 2, pct: 30 }]));
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0, '');
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '');
  let cat = null;
  if (categoryPct) cat = db.prepare("INSERT INTO patient_categories (name, discount_percent) VALUES ('VIP', ?)").run(categoryPct).lastInsertRowid;
  const src = db.prepare('INSERT INTO referral_sources (name, reward_mode, own_percent) VALUES (?, ?, 10)').run('Партнёр', 'own').lastInsertRowid;
  db.prepare("INSERT INTO patients (id, mrn, full_name, category_id) VALUES (1, 'P-1', 'Пациент', ?)").run(cat);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1, 'УЗИ', 100000, 6, 'imaging')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (2, 'Анализ', 50000, 0, 'lab')").run();
  const p = { name: 'Осень', ids: [1], pct: 20, from: '2026-09-01', until: '2026-09-30', active: 1, ...pkg };
  const packageId = db.prepare(`INSERT INTO service_templates (name, service_ids, discount_percent, valid_from, valid_until, active)
                                VALUES (?,?,?,?,?,?)`).run(p.name, JSON.stringify(p.ids), p.pct, p.from, p.until, p.active).lastInsertRowid;
  const visitId = db.prepare("INSERT INTO visits (patient_id, visit_date, status, referral_source_id) VALUES (1, ?, 'scheduled', ?)").run(DAY, src).lastInsertRowid;
  const line = (serviceId, { pkgId = null, status = 'completed' } = {}) => {
    const price = serviceId === 1 ? 100000 : 50000;
    return db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, package_id)
                       VALUES (?,?,1,1,?,?,?,?)`).run(visitId, serviceId, price, price, status, pkgId).lastInsertRowid;
  };
  return { db, packageId, visitId, line };
}
const invoiceOf = (c, ids, extra = {}) => createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: ids, ...extra }, registrar);
const itemFor = (res, serviceId) => res.items.find((i) => i.service_id === serviceId);

// ─── 1. Скидка строки и итог счёта ──────────────────────────────────────────

test('строка пакета несёт свою скидку; строка вне пакета — нет; итог сходится', () => {
  const c = clinic();
  const a = c.line(1, { pkgId: c.packageId });
  const b = c.line(2);
  const res = invoiceOf(c, [a, b]);
  assert.equal(itemFor(res, 1).discount_amount, 20000);
  assert.equal(itemFor(res, 2).discount_amount, 0);
  assert.equal(res.invoice.subtotal, 150000);
  assert.equal(res.invoice.discount_amount, 20000);
  assert.equal(res.invoice.total_amount, 130000);
});

test('категория пациента и пакет не суммируются: на строке пакета — бо́льшая из двух', () => {
  // Категория 30 % > пакет 20 %: строка пакета 30 %, строка вне пакета 30 %.
  let c = clinic({ categoryPct: 30 });
  let res = invoiceOf(c, [c.line(1, { pkgId: c.packageId }), c.line(2)]);
  assert.equal(itemFor(res, 1).discount_amount, 30000);
  assert.equal(res.invoice.discount_amount, 30000 + 15000);
  assert.equal(res.invoice.total_amount, 105000);
  // Категория 5 % < пакет 20 %: строка пакета 20 % (не 25), вне пакета 5 %.
  c = clinic({ categoryPct: 5 });
  res = invoiceOf(c, [c.line(1, { pkgId: c.packageId }), c.line(2)]);
  assert.equal(itemFor(res, 1).discount_amount, 20000);
  assert.equal(res.invoice.discount_amount, 20000 + 2500);
  assert.equal(res.invoice.total_amount, 127500);
});

test('ручная скидка кассира ложится только на строки без своей скидки и зажата их суммой', () => {
  const c = clinic();
  const res = invoiceOf(c, [c.line(1, { pkgId: c.packageId }), c.line(2)], { discount_amount: 80000 });
  // 20 000 пакета + ручная, зажатая суммой строки вне пакета (50 000).
  assert.equal(res.invoice.discount_amount, 70000);
  assert.equal(res.invoice.total_amount, 80000);
});

test('пакет без скидки (прежний шаблон) ведёт себя как обычная строка', () => {
  const c = clinic({ pkg: { pct: 0, from: null, until: null } });
  const res = invoiceOf(c, [c.line(1, { pkgId: c.packageId }), c.line(2)], { discount_amount: 15000 });
  assert.equal(itemFor(res, 1).discount_amount, 0);
  assert.equal(res.invoice.discount_amount, 15000);
});

// ─── 2. Срок предложения и состав пакета — на сервере ───────────────────────

test('истёкший и ещё не начавшийся пакет — отказ словами, и ничего не записано', () => {
  for (const pkg of [{ from: '2026-08-01', until: '2026-08-31' }, { from: '2026-09-15', until: null }]) {
    const c = clinic({ pkg });
    const a = c.line(1, { pkgId: c.packageId });
    assert.throws(() => invoiceOf(c, [a]), (e) => e.status === 400 && /Пакет «Осень»/.test(e.message) && /10\.09\.2026/.test(e.message));
    assert.equal(c.db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);
  }
});

test('услуга не из пакета с пометкой пакета — отказ', () => {
  const c = clinic();
  const b = c.line(2, { pkgId: c.packageId });
  assert.throws(() => invoiceOf(c, [b]), (e) => e.status === 400 && /не входит в пакет/.test(e.message));
});

test('границы окна включительно: первый и последний день пакета — действуют', () => {
  for (const pkg of [{ from: '2026-09-10', until: null }, { from: null, until: '2026-09-10' }]) {
    const c = clinic({ pkg });
    const res = invoiceOf(c, [c.line(1, { pkgId: c.packageId })]);
    assert.equal(res.invoice.discount_amount, 20000);
  }
});

// ─── 3. Правка неоплаченного счёта ──────────────────────────────────────────

test('убрали строку пакета — скидка счёта уменьшилась на её скидку', () => {
  const c = clinic();
  const a = c.line(1, { pkgId: c.packageId, status: 'added' });
  const b = c.line(2, { status: 'added' });
  invoiceOf(c, [a, b]);
  const out = removeUnpaidService(c.db, { visit_service_id: a }, admin);
  assert.equal(out.invoice.subtotal, 50000);
  assert.equal(out.invoice.discount_amount, 0);
  assert.equal(out.invoice.total_amount, 50000);
});

test('замена услуги в строке пакета снимает с неё пакет и его скидку', () => {
  const c = clinic();
  const a = c.line(1, { pkgId: c.packageId, status: 'added' });
  invoiceOf(c, [a, c.line(2, { status: 'added' })]);
  const out = changeUnpaidService(c.db, { visit_service_id: a, new_service_id: 2 }, admin);
  assert.equal(out.invoice.subtotal, 100000);
  assert.equal(out.invoice.discount_amount, 0);
  assert.equal(out.line.package_id, null);
  const item = c.db.prepare('SELECT discount_amount FROM invoice_items WHERE id = ?').get(out.line.invoice_item_id);
  assert.equal(item.discount_amount, 0);
});

// ─── 4. Отчёты и выплата: скидка строки — на своей строке ───────────────────

const payLine = (c, serviceId) => performedPayLines(c.db, { from: FROM, to: TO }).find((r) => r.service_id === serviceId);

test('доля врача по строке пакета = (цена − скидка пакета − налог) × ставка; строка вне пакета не задета', () => {
  const c = clinic();
  const a = c.line(1, { pkgId: c.packageId });
  const b = c.line(2);
  // До счёта — выплата по выполненному уже знает скидку пакета.
  assert.equal(payLine(c, 1).discount, 20000);
  assert.equal(Math.round(payLine(c, 1).doctor_fee), 22560);   // (100 000 − 20 000) × 0,94 × 30 %
  assert.equal(payLine(c, 2).doctor_fee, 15000);
  invoiceOf(c, [a, b]);
  // После счёта — то же самое, бит в бит по строке.
  assert.equal(payLine(c, 1).discount, 20000);
  assert.equal(Math.round(payLine(c, 1).doctor_fee), 22560);
  assert.equal(payLine(c, 2).discount, 0, 'скидка пакета размазалась на строку вне пакета');
  assert.equal(payLine(c, 2).doctor_fee, 15000);

  const r = runReport(c.db, { kind: 'total_revenue', from: FROM, to: TO }, admin);
  const col = (row, name) => row[r.columns.indexOf(name)];
  const us = r.rows.find((x) => col(x, 'Услуга') === 'УЗИ');
  const lab = r.rows.find((x) => col(x, 'Услуга') === 'Анализ');
  assert.equal(col(us, 'Скидка'), 20000);
  assert.equal(col(lab, 'Скидка'), 0);
  assert.equal(col(us, 'Доля врача'), 22560);
  assert.equal(col(lab, 'Доля врача'), 15000);
});

test('остаток скидки счёта разносится только по строкам без своей скидки', () => {
  const c = clinic();
  const b2 = c.db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (3, 'Приём', 50000, 0, 'consultation')").run();
  void b2;
  const a = c.line(1, { pkgId: c.packageId });
  const b = c.line(2);
  const d = c.db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status)
                          VALUES (?,3,1,1,50000,50000,'completed')`).run(c.visitId).lastInsertRowid;
  invoiceOf(c, [a, b, d], { discount_amount: 10000 });
  // 10 000 ручной скидки — поровну на две строки по 50 000; УЗИ — только свои 20 000.
  assert.equal(payLine(c, 1).discount, 20000);
  assert.equal(payLine(c, 2).discount, 5000);
  assert.equal(payLine(c, 3).discount, 5000);
});

test('вознаграждение партнёра по строке пакета — от суммы после скидки пакета', () => {
  const c = clinic();
  const res = invoiceOf(c, [c.line(1, { pkgId: c.packageId }), c.line(2)]);
  c.db.prepare("UPDATE invoices SET status = 'paid', paid_amount = total_amount WHERE id = ?").run(res.invoice.id);
  const r = runReport(c.db, { kind: 'referrals_detail', from: FROM, to: TO }, admin);
  const col = (row, name) => row[r.columns.indexOf(name)];
  const us = r.rows.find((x) => col(x, 'Услуга') === 'УЗИ');
  const lab = r.rows.find((x) => col(x, 'Услуга') === 'Анализ');
  assert.equal(col(us, 'Сумма после скидки'), 80000);
  assert.equal(col(us, 'Вознаграждение'), 8000);
  assert.equal(col(lab, 'Сумма после скидки'), 50000);
  assert.equal(col(lab, 'Вознаграждение'), 5000);
});

test('счёт без пакетов — отчёты считают ровно как прежде (доля скидки по сумме строки)', () => {
  const c = clinic();
  invoiceOf(c, [c.line(1), c.line(2)], { discount_amount: 30000 });
  assert.equal(payLine(c, 1).discount, 20000);
  assert.equal(payLine(c, 2).discount, 10000);
});

// ─── 5. Правка неоплаченного счёта: остаток скидки пересчитывается ──────────
//
// Разбор ревью I-2 / M-3. Скидка счёта = своя скидка строк пакета + остаток
// (ручная/категорийная) на строки без своей. Убирая или заменяя строку, прежний
// код вычитал из скидки счёта только скидку самой строки — остаток оставался
// прежним и мог лечь на строку, которой уже нет, или превысить оставшиеся.

function bigClinic(opts) {
  const c = clinic(opts);
  c.db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (3, 'УЗИ большое', 200000, 0, 'imaging')").run();
  c.db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (4, 'Анализ 100', 100000, 0, 'lab')").run();
  c.db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (5, 'Анализ 20', 20000, 0, 'lab')").run();
  c.db.prepare('UPDATE service_templates SET service_ids = ? WHERE id = ?').run(JSON.stringify([1, 3]), c.packageId);
  c.add = (serviceId, { pkgId = null } = {}) => {
    const price = c.db.prepare('SELECT price FROM services WHERE id = ?').get(serviceId).price;
    return c.db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, package_id)
                         VALUES (?,?,1,1,?,?,'added',?)`).run(c.visitId, serviceId, price, price, pkgId).lastInsertRowid;
  };
  return c;
}

test('убрали единственную строку без своей скидки — ручной остаток уходит с ней (ревью I-2, проба 1)', () => {
  const c = bigClinic();
  const p = c.add(3, { pkgId: c.packageId });   // 200 000, пакет 20 % = 40 000
  const lab = c.add(4);                          // 100 000
  const res = invoiceOf(c, [p, lab], { discount_amount: 30000 });
  assert.equal(res.invoice.discount_amount, 70000);
  const out = removeUnpaidService(c.db, { visit_service_id: lab }, admin);
  assert.equal(out.invoice.subtotal, 200000);
  assert.equal(out.invoice.discount_amount, 40000, 'ручные 30 000 остались висеть без строки');
  assert.equal(out.invoice.total_amount, 160000);
});

test('убрали строку — остаток зажат оставшимися строками без своей скидки (ревью I-2, проба 2)', () => {
  const c = bigClinic();
  const p = c.add(3, { pkgId: c.packageId });
  const lab = c.add(4);
  const small = c.add(5);                        // 20 000
  invoiceOf(c, [p, lab, small], { discount_amount: 30000 });
  const out = removeUnpaidService(c.db, { visit_service_id: lab }, admin);
  assert.equal(out.invoice.subtotal, 220000);
  // 40 000 пакета + остаток не больше 20 000 (строка на 20 000 не уходит в минус).
  assert.equal(out.invoice.discount_amount, 60000);
  assert.equal(out.invoice.total_amount, 160000);
});

test('замена услуги тоже пересчитывает остаток: он не больше строк без своей скидки', () => {
  const c = bigClinic();
  const p = c.add(3, { pkgId: c.packageId });
  const lab = c.add(4);
  invoiceOf(c, [p, lab], { discount_amount: 30000 });
  const out = changeUnpaidService(c.db, { visit_service_id: lab, new_service_id: 5 }, admin);
  assert.equal(out.invoice.subtotal, 220000);
  assert.equal(out.invoice.discount_amount, 60000);   // 40 000 + min(30 000, 20 000)
  assert.equal(out.invoice.total_amount, 160000);
});

test('строка пакета заменена у пациента с категорией — на ней действует пол категории (ревью M-3)', () => {
  const c = bigClinic({ categoryPct: 10 });
  const p = c.add(1, { pkgId: c.packageId });    // 100 000, max(20, 10) = 20 000
  const lab = c.add(2);                          // 50 000, категория 5 000
  const res = invoiceOf(c, [p, lab]);
  assert.equal(res.invoice.discount_amount, 25000);
  const out = changeUnpaidService(c.db, { visit_service_id: p, new_service_id: 3 }, admin);
  // 200 000 + 50 000 без своей скидки; категория 10 % = 25 000.
  assert.equal(out.invoice.subtotal, 250000);
  assert.equal(out.invoice.discount_amount, 25000);
  assert.equal(out.invoice.total_amount, 225000);
});

test('счёт по визиту отвечает остатком скидки (rest_discount) — мастер переносит только его (ревью I-1)', () => {
  const c = bigClinic();
  const res = invoiceOf(c, [c.add(3, { pkgId: c.packageId }), c.add(4)], { discount_amount: 30000 });
  assert.equal(res.rest_discount, 30000);
  assert.equal(res.invoice.discount_amount, 70000);
});
