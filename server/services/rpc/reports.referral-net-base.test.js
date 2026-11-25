// REFERRAL_NET_BASE_V1 (владелец 2026-11-24, по снимку «Подробнее» врача-источника:
// «here it should show sum after VAT and discount, and then it should calculate %»; на
// вопрос — «сменить правило», «для всех») — ПРОЦЕНТ ВОЗНАГРАЖДЕНИЯ ЗА НАПРАВЛЕНИЕ — ОТ
// СУММЫ ПОСЛЕ СКИДКИ И НДС:
//   • УЗИ 200 000, скидка 20 % (160 000), НДС 12 % (19 200) → база 140 800; партнёр 10 %
//     → 14 080, свой врач 5 % → 7 040 — одно число во всех отчётах и в кабинете;
//   • окно «Подробнее» показывает цепочку: цена − скидка − НДС = база, ставка, вознаграждение;
//   • стационар — тем же правилом; фикс — за услугу, как был;
//   • «с дня обновления» (мигр. 300): счёт, выставленный до обновления, — по правилу 3.22.0;
//   • закрытый месяц: смена ставки НДС услуги после закрытия корректировки не даёт.
// Правило 3.22.0 (до скидки) — reports.referral-full-price.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { runReport, doctorPaySummary, doctorReferralReward, payPeriodClose } from './reports.js';
import { createInvoiceForVisit, createInvoiceForAdmission, recordPayment } from './billing.js';
import { referralsDoctorDetail, referralsSourceDetail } from './referrals.js';
import { today } from '../domain/day.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';

const admin = { id: 9, role: 'admin' };
const round2 = (n) => Math.round(n * 100) / 100;
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const sum = (list, col) => round2(list.reduce((n, o) => n + (Number(o[col]) || 0), 0));
function months(db) {
  const cur = today(db).slice(0, 7);
  let y = Number(cur.slice(0, 4)); let mm = Number(cur.slice(5, 7)) - 1;
  if (mm < 1) { mm = 12; y -= 1; }
  return { cur, prev: y + '-' + String(mm).padStart(2, '0') };
}
const lastDay = (m) => m + '-' + String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0');
const range = (m) => ({ from: m + '-01', to: lastDay(m) });
const run = (db, kind, rng) => runReport(db, { kind, ...rng }, admin);
const refRows = (db, rng) => objects(run(db, 'referrals', rng));
const rewardOf = (rows, source, where) => sum(rows.filter((o) => o['Источник'] === source && (!where || o['Где'] === where)), 'Вознаграждение');

// Как в reports.referral-full-price.test.js, но УЗИ с НДС 12 %. upgrading — база до мигр. 300.
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');
function clinic({ upgrading = false } = {}) {
  const db = openDb(':memory:');
  if (upgrading) {
    const stage = tmpDir('em-rnb-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
      if (parseInt(f, 10) >= 300 || !f.endsWith('.sql')) continue;
      fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
  } else migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default)
                        VALUES (?,?,?,?,?,?,'',0)`);
  u.run(1, 'uzi', 'x', 'doctor', 'Узистов У.', 1);
  u.run(2, 'napr', 'x', 'doctor', 'Направляев Н.', 1);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1, 'УЗИ', 200000, 12, 'imaging')").run();
  let own = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 2').get();
  if (!own) own = { id: db.prepare("INSERT INTO referral_sources (name, doctor_id) VALUES ('Направляев Н.', 2)").run().lastInsertRowid };
  db.prepare("UPDATE referral_sources SET reward_mode = 'own', own_percent = 5, own_rates = '[]' WHERE id = ?").run(own.id);
  const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 10)").run().lastInsertRowid;
  const partner = Number(db.prepare("INSERT INTO referral_sources (name, code, category_id) VALUES ('Клиника Х', 'KX', ?)").run(cat).lastInsertRowid);
  const fixer = Number(db.prepare("INSERT INTO referral_sources (name, code, category_id, service_rates) VALUES ('Фикс-партнёр', 'FP', ?, ?)")
    .run(cat, JSON.stringify([{ service_id: 1, unit: 'fix', value: 70000 }])).lastInsertRowid);
  const pt = db.prepare('INSERT INTO patients (id, mrn, full_name, referral_source_id) VALUES (?,?,?,?)');
  pt.run(1, 'P-1', 'Пациент партнёра', partner);
  pt.run(2, 'P-2', 'Пациент врача', own.id);
  pt.run(3, 'P-3', 'Пациент фикс-партнёра', fixer);
  let seq = 0;
  // Оплаченный счёт на УЗИ пациента patient со скидкой 40 000 (20 %); at — день визита и счёта
  // (null — счёт выставлен сейчас).
  const paidWith20 = (at, patient) => {
    const id = ++seq;
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,?,?, 'scheduled')").run(id, patient, at || new Date().toISOString());
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id)
                VALUES (?,?,1,1,1,200000,200000,'completed', NULL)`).run(id, id);
    const inv = createInvoiceForVisit(db, { visit_id: id, visit_service_ids: [id], discount_amount: 40000, discount_choice: 'manual' }, admin).invoice;
    if (at) db.prepare('UPDATE invoices SET created_at = ? WHERE id = ?').run(at, inv.id);
    assert.equal(db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(inv.id).total_amount, 160000);
    recordPayment(db, { invoice_id: inv.id, amount: 160000, method: 'cash' }, admin);
    return inv.id;
  };
  return { db, paidWith20, partner, fixer, own: own.id };
}

test('процент — от суммы после скидки и НДС: 200 000 − 40 000 − 19 200 = 140 800; партнёр 10 % → 14 080, свой врач 5 % → 7 040 — везде одно число', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const at = cur + '-02T09:00:00Z';
  c.paidWith20(at, 1);
  c.paidWith20(at, 2);
  c.paidWith20(at, 3);
  const rows = refRows(c.db, range(cur));
  assert.equal(rewardOf(rows, 'Клиника Х'), 14080);
  assert.equal(rewardOf(rows, 'Направляев Н.'), 7040);
  assert.equal(rewardOf(rows, 'Фикс-партнёр'), 70000, 'фикс — за услугу, ни скидка, ни НДС его не трогают');
  assert.equal(doctorReferralReward(c.db, { doctor_id: 2, ...range(cur) }, admin).reward, 7040);
  assert.equal(doctorPaySummary(c.db, { doctor_id: 2, ...range(cur) }, admin).referral.reward, 7040);
  assert.equal(referralsDoctorDetail(c.db, { doctor_id: 2, ...range(cur) }, admin).reward, 7040);
  const notes = run(c.db, 'referrals', range(cur)).notes;
  assert.ok(notes.some((n) => /после скидки и НДС/.test(n)), 'правило не названо');
  assert.ok(!notes.some((n) => /по правилу 3\.22\.0/.test(n)), 'у новой базы нет счетов до обновления');
});

test('окно «Подробнее»: цена − скидка − НДС = база, ставка, вознаграждение; шапка — итог базы', () => {
  const c = clinic();
  const { cur } = months(c.db);
  c.paidWith20(cur + '-02T09:00:00Z', 1);
  const det = referralsSourceDetail(c.db, { source_id: c.partner, ...range(cur) }, admin);
  assert.equal(det.lines.length, 1);
  const l = det.lines[0];
  assert.deepEqual([l.price, l.discount, l.tax, l.base, l.reward], [200000, 40000, 19200, 140800, 14080]);
  assert.deepEqual(l.rate, { unit: 'pct', value: 10 });
  assert.equal(det.base, 140800);
  assert.equal(det.received, 160000, '«Получено» — как было: оплачено после скидки');
  const fx = referralsSourceDetail(c.db, { source_id: c.fixer, ...range(cur) }, admin);
  assert.equal(c.paidWith20(cur + '-03T09:00:00Z', 3) > 0, true);
  const fx2 = referralsSourceDetail(c.db, { source_id: c.fixer, ...range(cur) }, admin);
  assert.equal(fx.lines.length, 0);
  assert.deepEqual(fx2.lines[0].rate, { unit: 'fix', value: 70000 });
  assert.equal(fx2.lines[0].reward, 70000);
});

test('стационар: процент партнёра — от строк счёта госпитализации после скидки и НДС', () => {
  const c = clinic();
  const { cur } = months(c.db);
  c.db.prepare('UPDATE referral_sources SET inpatient_bonus_enabled = 1, inpatient_pct = 5 WHERE id = ?').run(c.partner);
  c.db.prepare("INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status, referral_source_id) VALUES (1, 'A-1', 1, 1, 'active', ?)").run(c.partner);
  c.db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, performed_at)
                VALUES (1, 1, 1, 1, 1, 1, 200000, 200000, 'added', 1, ?)`).run(new Date().toISOString());
  const { invoice } = createInvoiceForAdmission(c.db, { admission_id: 1, admission_service_ids: [1] }, admin);
  c.db.prepare("UPDATE invoices SET paid_amount = total_amount, status = 'paid' WHERE id = ?").run(invoice.id);
  const inRows = refRows(c.db, range(cur)).filter((o) => o['Где'] === 'Стационар');
  assert.equal(rewardOf(inRows, 'Клиника Х'), 8800, '5 % от 176 000 (200 000 − НДС 24 000)');
});

test('обновление: счёт до мигр. 300 — по правилу 3.22.0 (20 000), счёт после — от суммы после скидки и НДС (14 080); примечание с датой — в словаре', () => {
  const c = clinic({ upgrading: true });
  const { cur, prev } = months(c.db);
  c.paidWith20(prev + '-10T09:00:00Z', 1);
  migrate(c.db);   // клиника ставит обновление: мигр. 300 записывает момент
  assert.ok(c.db.prepare('SELECT from_at FROM referral_net_price_from WHERE id = 1').get(), 'момент обновления не записан');
  c.paidWith20(null, 1);
  assert.equal(rewardOf(refRows(c.db, range(prev)), 'Клиника Х'), 20000, 'прошлый счёт — как был');
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Клиника Х'), 14080);
  const r = run(c.db, 'referrals', { from: prev + '-01', to: lastDay(cur) });
  const i = r.notes.findIndex((n) => /по правилу 3\.22\.0/.test(n));
  assert.ok(i >= 0, 'счета до обновления не названы');
  const t = r.notes_t && r.notes_t[i];
  assert.ok(t && t.template, 'нет шаблона с датой');
  const e = STRINGS[t.template];
  assert.ok(e && e.ru === t.template, 'нет статьи словаря');
  for (const lang of ['en', 'uz']) {
    assert.ok(e[lang] && !/[А-Яа-яЁё]/.test(e[lang]), lang + ' с кириллицей или пуст');
    assert.ok(e[lang].includes('{date}'), lang + ': потерян {date}');
  }
  for (const n of r.notes.filter((x) => /после скидки и НДС/.test(x))) {
    const s = STRINGS[n];
    assert.ok(s && s.ru === n && !/[А-Яа-яЁё]/.test(s.en) && !/[А-Яа-яЁё]/.test(s.uz), 'примечание без перевода: ' + n.slice(0, 60));
  }
});

test('закрытый месяц: ставку НДС услуги сменили после закрытия — вознаграждение по записи, без корректировки', () => {
  const c = clinic();
  const { cur, prev } = months(c.db);
  c.paidWith20(prev + '-10T09:00:00Z', 1);
  payPeriodClose(c.db, { month: prev }, admin);
  c.db.prepare('UPDATE services SET tax_rate = 0 WHERE id = 1').run();
  assert.equal(rewardOf(refRows(c.db, range(prev)), 'Клиника Х'), 14080);
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Клиника Х'), 0, 'смена ставки НДС дала корректировку');
});
