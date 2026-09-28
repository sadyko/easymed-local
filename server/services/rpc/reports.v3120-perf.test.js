// V3120_PERF — отчёты переписаны ради скорости (период по индексу, выборки
// движка выплаты — только по ключам строк периода, подзапросы скидки и налога —
// соединениями). Цифры обязаны остаться ТЕМИ ЖЕ. Здесь каждый отчёт и каждый
// RPC кабинета врача считается дважды на одних и тех же данных — прежним SQL
// (__setReportsPushDown(false) даёт его бит в бит) и новым — и ответы
// сравниваются целиком (deepEqual).
//
// Данные нарочно пёстрые: строки у самой местной полуночи в обеих формах
// времени ('…Z' и '….000Z'), три месяца, ступени (две полосы), фикс-ставка,
// своя скидка строки с копейками и скидка счёта, частичный и полный возврат,
// отменённый счёт, консультации без услуги, строки без врача, соседнее здание
// (счета и строки с sync_origin), стационар с исполнителем и назначившим,
// направления партнёра и сотрудника, расходники на операцию, закрытый месяц и
// изменение после закрытия (корректировка). Администратор-врач — отдельно:
// его кабинет (doctor_pay_summary) спрашивается и им самим.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { __setReportsPushDown, payPeriodClose } from './reports.js';

const admin = { id: 9, role: 'admin', username: 'adm' };
const adminDoctor = { id: 4, role: 'doctor', extra_roles: ['admin'], is_doctor: 1 };
const adminDoctor2 = { id: 4, role: 'admin', is_doctor: 1 };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.pragma('foreign_keys = OFF');
  const off = db.prepare("SELECT CAST(strftime('%s','now','localtime') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) s").get().s;
  const today = db.prepare("SELECT date('now','localtime') d").get().d;
  const dayOf = (k) => db.prepare('SELECT date(?, ?) d').get(today, k + ' days').d;
  const midnight = (d) => Date.parse(d + 'T00:00:00Z') - off * 1000;
  let rnd = 20260927;
  const rand = (n) => {
    rnd = (rnd + 0x6D2B79F5) | 0;
    let t = Math.imul(rnd ^ (rnd >>> 15), 1 | rnd);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const edges = [0, 1000, -1000, 500, 60e3, -60e3, 9 * 3600e3, 14 * 3600e3, 23 * 3600e3 + 59 * 60e3];
  const at = (k) => {
    const iso = new Date(midnight(dayOf(k)) + edges[rand(edges.length)]).toISOString();
    return rand(2) ? iso : iso.slice(0, 19) + 'Z';
  };

  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates,
                          service_rate_default, inpatient_rates, inpatient_referral_pct, specialty) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  u.run(1, 'd1', 'x', 'doctor', 'Терапевтов', 1, JSON.stringify([{ service_id: 1, pct: 30 }, { service_id: 3, fix: 15000 }]), 10, JSON.stringify([{ service_id: 3, pct: 20 }]), 0, 'Терапевт');
  u.run(2, 'd2', 'x', 'doctor', 'Хирургов', 1, JSON.stringify([{ service_id: 4, pct: 25 }]), 0, JSON.stringify([{ service_id: 4, pct: 35 }, { service_id: 3, fix: 7000 }]), 0, 'Хирург');
  u.run(3, 'd3', 'x', 'doctor', 'Направляев', 1, '', 5, '[]', 7, 'Кардиолог');
  u.run(4, 'ad', 'x', 'admin', 'Админ Врачов', 1, JSON.stringify([{ service_id: 1, pct: 20 }, { service_id: 2, pct: 12.5 }]), 0, '[]', 0, 'Терапевт');
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '', 0, '[]', 0, '');
  const s = db.prepare(`INSERT INTO services (id, name, price, tax_rate, type, is_lab, doctor_tier_from, doctor_tier_percent,
                          doctor_tier_from_2, doctor_tier_percent_2) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  s.run(1, 'Приём терапевта', 150000, 12, 'consultation', 0, 3, 40, 6, 50);   // ступени
  s.run(2, 'ОАК', 40000, 0, 'lab', 1, 0, 0, 0, 0);
  s.run(3, 'Перевязка', 80000, 12, 'procedure', 0, 2, 45, 0, 0);
  s.run(4, 'Операция на колене', 3000000, 12, 'other', 0, 0, 0, 0, 0);
  db.prepare("INSERT INTO consultation_types (id, name, price) VALUES (1, 'Повторный', 90000)").run();
  const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 3)").run().lastInsertRowid;
  const partner = db.prepare(`INSERT INTO referral_sources (name, code, category_id, reward_mode, own_percent, own_rates,
                                inpatient_bonus_enabled, inpatient_pct, inpatient_fixed) VALUES ('Клиника Х','KX',?, 'own', 5, '[]', 1, 4, 50000)`).run(cat).lastInsertRowid;
  let own = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 3').get();
  if (!own) own = { id: db.prepare("INSERT INTO referral_sources (name, doctor_id) VALUES ('Направляев', 3)").run().lastInsertRowid };
  db.prepare("UPDATE referral_sources SET reward_mode = 'own', own_percent = 10, own_rates = '[]' WHERE id = ?").run(own.id);
  const pcat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('Льгота', 7.5, 1)").run().lastInsertRowid;
  const pt = db.prepare('INSERT INTO patients (id, mrn, full_name, referral_source_id, category_id, sync_origin) VALUES (?,?,?,?,?,?)');
  for (let i = 1; i <= 8; i++) pt.run(i, 'A-26-0000' + i, 'Пациент ' + i, [partner, own.id, null, null][i % 4], i % 3 === 0 ? pcat : null, i === 8 ? 'B' : null);
  db.prepare('INSERT INTO products (id, name, avg_cost, sale_price) VALUES (1, ?, 1234.5, 2000)').run('Бинт');

  const insV = db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status, sync_origin, referral_source_id) VALUES (?,?,?,?,?,?) RETURNING id');
  const insVs = db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status,
                              consultation_type_id, sync_origin, created_at) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`);
  const insInv = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, admission_id, subtotal, discount_amount,
                               total_amount, paid_amount, status, created_at, paid_at, voided_at, sync_origin, created_by)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,9) RETURNING id`);
  const insIi = db.prepare(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total, discount_amount)
                            VALUES (?,?,?,?,?,?,?) RETURNING id`);
  const insPay = db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at, cashier_id) VALUES (?,?,?,?,9)");
  const statuses = ['completed', 'completed', 'in_progress', 'resulted', 'collected', 'added', 'queued'];
  let n = 0;
  for (let k = -75; k <= 1; k++) {
    for (let j = 0; j < 6; j++) {
      const foreign = rand(9) === 0 ? 'B' : null;
      const vStatus = rand(12) === 0 ? 'cancelled' : 'arrived';
      const pid = 1 + rand(7);
      const v = insV.get(pid, 1 + rand(4), at(k), vStatus, foreign, rand(5) === 0 ? partner : null).id;
      const lines = [];
      for (let m = 0; m < 1 + rand(3); m++) {
        const sid = [1, 1, 2, 3, 4, null][rand(6)];
        const qty = 1 + rand(2);
        const price = sid == null ? 90000 : [0, 150000, 40000, 80000, 3000000][sid];
        const doc = foreign ? null : rand(8) === 0 ? null : 1 + rand(4);
        const vs = insVs.get(v, sid, doc, qty, price, price * qty, statuses[rand(statuses.length)],
          sid == null ? 1 : null, foreign, at(k)).id;
        lines.push({ vs, sid, qty, price });
      }
      if (rand(4) === 0) continue;                 // строки без счёта — по цене, которую поставит счёт
      const created = at(k + (rand(5) === 0 ? 1 : 0));
      const sub = lines.reduce((a, l) => a + l.price * l.qty, 0);
      const disc = rand(4) === 0 ? Math.round(sub * 0.05) : 0;
      const st = ['paid', 'paid', 'paid', 'partial', 'unpaid', 'void', 'refunded'][rand(7)];
      const inv = insInv.get('INV-' + (++n), v, pid, null, sub, disc, sub - disc, 0, st, created,
        st === 'paid' ? created : null, st === 'void' ? created : null, foreign, ).id;
      for (const l of lines) {
        const own = rand(6) === 0 ? Math.round(l.price * l.qty * 0.1333 * 100) / 100 : 0;   // своя скидка с копейками
        const ii = insIi.get(inv, l.sid, l.sid == null ? 'Консультация' : 'Услуга', l.qty, l.price, l.price * l.qty, own).id;
        if (!foreign) db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(ii, l.vs);
      }
      if (st === 'paid' || st === 'partial' || st === 'refunded') {
        const amount = st === 'partial' ? Math.round((sub - disc) / 3) : sub - disc;
        insPay.run(inv, amount, rand(2) ? 'cash' : 'card', created);
        db.prepare('UPDATE invoices SET paid_amount = ? WHERE id = ?').run(amount, inv);
        if (st === 'refunded') insPay.run(inv, -amount, 'cash', at(k + 1));
        else if (rand(6) === 0) insPay.run(inv, -Math.round(amount / 4), 'cash', at(k + 1));   // частичный возврат
      }
      if (lines.some((l) => l.sid === 4)) {
        const l = lines.find((x) => x.sid === 4);
        db.prepare(`INSERT INTO stock_movements (product_id, qty, kind, reference_type, reference_id, unit_cost, created_at)
                    VALUES (1, ?, 'dispense', 'visit', ?, ?, ?)`).run(-(1 + rand(3)), l.vs, rand(2) ? null : 999.25, at(k));
      }
    }
  }
  // Стационар: две госпитализации, строки у полуночи, счёт госпитализации.
  for (let a = 1; a <= 2; a++) {
    const adm = db.prepare(`INSERT INTO admissions (patient_id, doctor_id, status, admission_no, referral_source_id, referring_doctor_id, admitted_at)
                            VALUES (?, 1, 'active', ?, ?, ?, ?) RETURNING id`).get(a, 'A-' + a, a === 1 ? partner : null, a === 2 ? 3 : null, at(-40)).id;
    const inv = insInv.get('ADM-' + a, null, a, adm, 0, 0, 0, 0, a === 1 ? 'paid' : 'partial', at(-5), null, null, null).id;
    let total = 0;
    for (let k = -45; k <= 0; k += 3) {
      const sid = [3, 4, 3, null][rand(4)];
      const price = sid == null ? 300000 : sid === 3 ? 80000 : 3000000;
      const ii = rand(3) ? insIi.get(inv, sid, sid == null ? 'Проживание' : 'Услуга', 1, price, price, 0).id : null;
      if (ii) total += price;
      db.prepare(`INSERT INTO admission_services (admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total,
                    status, billable, invoice_item_id, performed_at, notes) VALUES (?,?,?,?,1,?,?,'added',1,?,?,?)`)
        .run(adm, sid, 1, rand(2) ? 2 : null, price, price, ii, rand(5) ? at(k) : null, sid == null ? 'ACCOMMODATION' : null);
    }
    db.prepare('UPDATE invoices SET subtotal = ?, total_amount = ? WHERE id = ?').run(total, total, inv);
    insPay.run(inv, a === 1 ? total : Math.round(total / 2), 'cash', at(-5));
    db.prepare('UPDATE invoices SET paid_amount = ? WHERE id = ?').run(a === 1 ? total : Math.round(total / 2), inv);
  }
  // SUPPLIERS_VAT_V1 — товары под НДС: налог строки товара берётся у товара
  // (products.vat_rate) подзапросом по строке визита / стационара — и прежний, и
  // нынешний SQL обязаны найти его одинаково. Строки товара — со счётом (своя
  // скидка, скидка счёта) и без, «без НДС» и 0 % рядом; стационар — строкой в
  // счёте госпитализации. Без rand(): случайная последовательность выше не
  // сдвигается.
  db.prepare('UPDATE products SET vat_rate = 12 WHERE id = 1').run();
  db.prepare("INSERT INTO products (id, name, avg_cost, sale_price, vat_rate) VALUES (2, 'Шприц', 300, 700, NULL), (3, 'Маска', 100, 800, 0)").run();
  const insGoods = db.prepare(`INSERT INTO visit_services (visit_id, clinic_item_id, doctor_id, quantity, unit_price, total, status, created_at)
                               VALUES (?,?,?,?,?,?,'added',?) RETURNING id`);
  for (let k = -70, n2 = 0; k <= 0; k += 5, n2++) {
    const day = dayOf(k) + 'T0' + (n2 % 9) + ':30:00Z';
    const v = insV.get(1 + (n2 % 7), 1 + (n2 % 4), day, 'arrived', null, null).id;
    const g1 = insGoods.get(v, 1, 1 + (n2 % 4), 2, 2000, 4000, day).id;
    const g2 = insGoods.get(v, 2 + (n2 % 2), n2 % 3 ? 2 : null, 1, 700, 700, day).id;
    insGoods.get(v, 1, 3, 1, 2000, 2000, day);                        // без счёта
    if (n2 % 4 === 3) continue;
    const disc = n2 % 3 === 0 ? 470 : 0;
    const inv = insInv.get('GDS-' + n2, v, 1 + (n2 % 7), null, 4700, disc, 4700 - disc, 0, n2 % 5 ? 'paid' : 'unpaid', day, n2 % 5 ? day : null, null, null).id;
    db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(insIi.get(inv, null, 'Бинт', 2, 2000, 4000, n2 % 2 ? 133.33 : 0).id, g1);
    db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(insIi.get(inv, null, 'Шприц', 1, 700, 700, 0).id, g2);
    if (n2 % 5) { insPay.run(inv, 4700 - disc, 'cash', day); db.prepare('UPDATE invoices SET paid_amount = ? WHERE id = ?').run(4700 - disc, inv); }
  }
  {
    const adm = db.prepare(`INSERT INTO admissions (patient_id, doctor_id, status, admission_no, admitted_at)
                            VALUES (3, 2, 'active', 'A-G', ?) RETURNING id`).get(dayOf(-20) + 'T08:00:00Z').id;
    const inv = insInv.get('ADM-G', null, 3, adm, 6000, 0, 6000, 6000, 'paid', dayOf(-3) + 'T10:00:00Z', dayOf(-3) + 'T10:00:00Z', null, null).id;
    const ii = insIi.get(inv, null, 'Бинт', 3, 2000, 6000, 0).id;
    db.prepare(`INSERT INTO admission_services (admission_id, clinic_item_id, doctor_id, quantity, unit_price, total, status, billable, invoice_item_id, performed_at)
                VALUES (?, 1, 2, 3, 2000, 6000, 'added', 1, ?, ?)`).run(adm, ii, dayOf(-10) + 'T12:00:00Z');
    insPay.run(inv, 6000, 'cash', dayOf(-3) + 'T10:00:00Z');
  }
  // Закрытый месяц (позапрошлый) и изменение ПОСЛЕ закрытия — корректировка.
  const prev2 = dayOf(-62).slice(0, 7);
  payPeriodClose(db, { month: prev2 }, admin);
  const late = db.prepare(`SELECT i.id, i.paid_amount FROM invoices i WHERE i.status = 'paid' AND i.admission_id IS NULL
                             AND substr(i.created_at, 1, 7) = ? ORDER BY i.id LIMIT 1`).get(prev2);
  if (late) insPay.run(late.id, -Math.round(late.paid_amount / 2), 'cash', at(-1));
  return { db, dayOf, prev2 };
}

const KINDS = ['payments', 'invoices', 'services', 'visits', 'patients', 'stock_movements',
  'total_revenue', 'referrals', 'invoices_full', 'procurement', 'surgery_profit', 'doctor_salaries', 'inpatient_share',
  'referrals_detail', 'by_services', 'by_doctors', 'doctor_services', 'doctor_lines', 'by_specialty',
  'stock_consumption', 'stock_statement', 'stock_expiry'];

function both(db, name, args, user = admin) {
  const rpc = getRpc(name);
  const out = [];
  for (const on of [false, true]) {
    __setReportsPushDown(on);
    try { out.push({ ok: rpc(db, args, user) }); } catch (e) { out.push({ err: e.message }); }
  }
  __setReportsPushDown(true);
  return out;
}

test('V3120_PERF: каждый отчёт и кабинет врача — тот же ответ прежним и новым SQL', () => {
  const { db, dayOf, prev2 } = seed();
  const ranges = [
    [dayOf(0), dayOf(0)], [dayOf(-1), dayOf(-1)], [dayOf(-30), dayOf(0)],
    [prev2 + '-01', dayOf(0)], [prev2 + '-01', prev2 + '-28'], [dayOf(-75), dayOf(1)],
  ];
  let calls = 0, nonEmpty = 0;
  const check = (name, args, user) => {
    const [a, b] = both(db, name, args, user);
    assert.deepEqual(b, a, `${name} ${JSON.stringify(args)} ${user.id}`);
    assert.ok(a.ok, `${name} ${JSON.stringify(args)} упал: ${a.err}`);
    calls++;
    if (JSON.stringify(a.ok).length > 400) nonEmpty++;
  };
  for (const [from, to] of ranges) {
    for (const kind of KINDS) check('run_report', { kind, from, to }, admin);
    check('run_report', { kind: 'total_revenue', from, to, buildings: ['B'] }, admin);
    check('run_report', { kind: 'doctor_salaries', from, to, buildings: ['A'] }, admin);
    check('owner_report', { from, to }, admin);
    check('reports_overview', { from, to }, admin);
    for (const doctor_id of [1, 2, 3, 4]) {
      check('doctor_pay_summary', { doctor_id, from, to }, admin);
      check('doctor_inpatient_share', { doctor_id, from, to }, admin);
      check('doctor_referral_reward', { doctor_id, from, to }, admin);
    }
    // Администратор-врач: свой кабинет и чужой (ему открыта «Оплата врачей»).
    for (const u of [adminDoctor, adminDoctor2]) {
      check('doctor_pay_summary', { doctor_id: 4, from, to }, u);
      check('doctor_pay_summary', { doctor_id: 1, from, to }, u);
    }
  }
  check('doctor_tier_positions', { doctor_id: 1, from: prev2, to: dayOf(0).slice(0, 7) }, admin);
  assert.ok(calls > 250, 'calls ' + calls);
  assert.ok(nonEmpty > calls / 2, 'сравнение обязано идти на непустых отчётах');
  db.close();
});

test('V3120_PERF: администратор-врач открывает свою выплату за сегодня и за месяц без ошибки SQL', () => {
  const { db, dayOf } = seed();
  for (const u of [adminDoctor, adminDoctor2]) {
    for (const [from, to] of [[dayOf(0), dayOf(0)], [dayOf(-29), dayOf(0)], [dayOf(-6), dayOf(0)]]) {
      const r = getRpc('doctor_pay_summary')(db, { doctor_id: 4, from, to }, u);
      assert.ok(r && typeof r === 'object');
    }
  }
  db.close();
});
