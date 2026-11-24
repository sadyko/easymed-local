// PATIENT_AGGREGATES_V1 — числа картотеки: визиты, последний визит, баланс,
// страховка, регистратор. RPC не существовало вовсе (501), и картотека у
// КАЖДОГО пациента показывала «визитов не было» и «0 сум» — молча и похоже на
// правду.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { patientBaseAggregates, patientRegistrarPlans } from './patient-aggregates.js';
import { RpcError } from './inpatient-flow.js';
import { isReadOnlyRpc } from '../control/gate.js';

const registrar = { id: 2, role: 'registrar' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'reg','x','Ахмедова Нигора','registrar')").run();
  const payer = db.prepare("INSERT INTO payers (name, kind) VALUES ('Страховая А','insurance')").run().lastInsertRowid;
  const p1 = db.prepare("INSERT INTO patients (full_name, mrn, date_of_birth, gender, payer_id, created_by) VALUES ('Каримов Темур','31002','1971-07-03','male',?,2)").run(payer).lastInsertRowid;
  const p2 = db.prepare("INSERT INTO patients (full_name, mrn, date_of_birth, gender) VALUES ('Юлдашев Сардор','27431','1985-03-30','male')").run().lastInsertRowid;
  return { db, p1, p2 };
}

test('визиты считаются, последний визит — самый поздний', () => {
  const { db, p1, p2 } = seed();
  try {
    for (const d of ['2026-06-01T09:00:00Z', '2026-07-15T10:30:00Z', '2026-05-02T08:00:00Z']) {
      db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?)').run(p1, d, 'arrived');
    }
    const rows = patientBaseAggregates(db, { p_ids: [p1, p2] }, registrar);
    const a = rows.find((r) => r.patient_id === p1);
    const b = rows.find((r) => r.patient_id === p2);
    assert.equal(a.visit_count, 3);
    assert.equal(String(a.last_visit).slice(0, 10), '2026-07-15');
    assert.equal(b.visit_count, 0, 'у пациента без визитов — ноль, а не пустота');
    assert.equal(b.last_visit, null);
  } finally { db.close(); }
});

// V3120_FIX (MINOR) — баланс — деньги на балансе (кошелёк), долг — отдельно;
// net_balance — прежняя знаковая цифра.
test('долг — невыплаченное по живым счетам; отменённый счёт не считается долгом', () => {
  const { db, p1 } = seed();
  try {
    db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, paid_amount, status) VALUES ('INV-1',?,500000,500000,200000,'partial')").run(p1);
    db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, paid_amount, status) VALUES ('INV-2',?,300000,300000,0,'void')").run(p1);
    const [a] = patientBaseAggregates(db, { p_ids: [p1] }, registrar);
    assert.equal(a.debt, 300000, 'долг 300 000 — и ровно он, отменённый счёт мимо');
    assert.equal(a.balance, 0, 'на балансе денег нет');
    assert.equal(a.net_balance, -300000);
  } finally { db.close(); }
});

test('страховка, её вид и регистратор приходят именами, а не идентификаторами', () => {
  const { db, p1, p2 } = seed();
  try {
    const rows = patientBaseAggregates(db, { p_ids: [p1, p2] }, registrar);
    const a = rows.find((r) => r.patient_id === p1);
    const b = rows.find((r) => r.patient_id === p2);
    assert.equal(a.insurer, 'Страховая А');
    assert.equal(a.payer_type, 'insurance');
    assert.equal(a.registrar, 'Ахмедова Нигора');
    assert.equal(b.insurer, '', 'без плательщика — пустая строка, экран сам напишет прочерк');
    assert.equal(b.registrar, '');
  } finally { db.close(); }
});

test('пустой список — пустой ответ, а не вся картотека', () => {
  const { db } = seed();
  try {
    assert.deepEqual(patientBaseAggregates(db, { p_ids: [] }, registrar), []);
    assert.deepEqual(patientBaseAggregates(db, {}, registrar), []);
  } finally { db.close(); }
});

test('роль без картотеки получает отказ, а чтение разрешено при просроченной лицензии', () => {
  const { db, p1 } = seed();
  try {
    assert.throws(() => patientBaseAggregates(db, { p_ids: [p1] }, { id: 9, role: 'inventory' }),
      (e) => e instanceof RpcError && e.status === 403);
    assert.ok(isReadOnlyRpc('patient_base_aggregates'), 'это чтение — клиника обязана видеть картотеку и с просроченной лицензией');
  } finally { db.close(); }
});

// LAST_VISIT_TRUE_V1 — «последний визит» — последний СОСТОЯВШИЙСЯ, ближайшая
// запись — отдельным полем, визиты — только состоявшиеся. Даты далеко от
// сегодняшнего дня — тест не зависит ни от часового пояса, ни от полуночи.
test('LAST_VISIT_TRUE_V1: будущая запись и отменённый визит не «последний визит»; next_visit отдельно', () => {
  const { db, p1, p2 } = seed();
  try {
    const add = db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?)');
    add.run(p1, '2020-01-01T09:00:00Z', 'arrived');
    add.run(p1, '2021-06-01T09:00:00Z', 'cancelled');
    add.run(p1, '2022-03-01T09:00:00Z', 'no_show');
    add.run(p1, '2099-01-01T09:00:00Z', 'scheduled');
    add.run(p1, '2099-02-01T09:00:00Z', 'scheduled');
    add.run(p2, '2099-05-05T09:00:00Z', 'scheduled');
    db.prepare("UPDATE patients SET registration_date = '2019-12-31T12:00:00Z' WHERE id = ?").run(p2);
    const rows = patientBaseAggregates(db, { p_ids: [p1, p2] }, registrar);
    const a = rows.find((r) => r.patient_id === p1);
    const b = rows.find((r) => r.patient_id === p2);
    assert.equal(a.visit_count, 1, 'отменённый, неявка и будущие — не визиты');
    assert.equal(Date.parse(a.last_visit), Date.parse('2020-01-01T09:00:00Z'), 'последним визитом стала будущая запись');
    assert.equal(a.last_visit_day, '2020-01-01');
    assert.equal(Date.parse(a.next_visit), Date.parse('2099-01-01T09:00:00Z'), 'ближайшая запись — самая ранняя будущая');
    assert.equal(a.next_visit_day, '2099-01-01');
    assert.deepEqual([b.visit_count, b.last_visit, b.next_visit_day], [0, null, '2099-05-05'], 'только будущая запись — визитов не было');
    assert.equal(b.registration_day, '2019-12-31', 'день регистрации — местный день, а не пусто');
  } finally { db.close(); }
});

// PATIENT_LIST_REGISTRAR_V1 (2026-11-24) — колонка «Регистратор» картотеки: кто
// ОФОРМИЛ ПОСЛЕДНИЙ ВИЗИТ (тот же визит, что «Последний визит»: состоявшийся,
// domain/visit-summary.js), по правилу «кто оформил» списка «Записи CRM»
// (domain/visit-registrar.js: создатель живого счёта визита, затем отметка
// журнала visit_registered). Нет визита или у него никто не записан — кто завёл
// карту, как прежде; нет и его — пусто (экран пишет «Не указан»).
// Имена в тесте — заведомо выдуманные.
function seedRegistrars() {
  const s = seed();
  const u = s.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,'x',?,'registrar')");
  u.run(11, 'test-a', 'Тест Регистратор А');
  u.run(12, 'test-b', 'Тест Создатель Б');
  u.run(13, 'test-c', 'Тест Регистратор В');
  s.db.prepare('UPDATE patients SET created_by = 12 WHERE id = ?').run(s.p1);   // p1 завёл Б; p2 — импорт, автора нет
  let n = 0;
  s.visit = (pid, date, status = 'arrived') => Number(s.db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?)').run(pid, date, status).lastInsertRowid);
  s.invoice = (pid, vid, by, status = 'paid') => s.db.prepare("INSERT INTO invoices (invoice_number, patient_id, visit_id, subtotal, total_amount, paid_amount, status, created_by) VALUES (?,?,?,1000,1000,1000,?,?)").run('T-' + (++n), pid, vid, status, by);
  s.mark = (vid, by, name = null) => s.db.prepare("INSERT INTO invoice_audit_log (visit_id, action, actor_user_id, actor_name) VALUES (?,'visit_registered',?,?)").run(vid, by, name);
  s.of = (pid) => patientBaseAggregates(s.db, { p_ids: [s.p1, s.p2] }, registrar).find((r) => r.patient_id === pid);
  return s;
}

test('PATIENT_LIST_REGISTRAR_V1: импортированная карта без автора — тот, кто оформил её визит', () => {
  const s = seedRegistrars();
  try {
    s.invoice(s.p2, s.visit(s.p2, '2020-01-01T09:00:00Z'), 11);
    assert.equal(s.of(s.p2).registrar, 'Тест Регистратор А');
    assert.deepEqual(s.of(s.p2).registrars, ['Тест Регистратор А']);
  } finally { s.db.close(); }
});

test('PATIENT_LIST_REGISTRAR_V1: визитов нет — кто завёл карту; нет и его — пусто', () => {
  const s = seedRegistrars();
  try {
    assert.equal(s.of(s.p1).registrar, 'Тест Создатель Б');
    assert.deepEqual(s.of(s.p1).registrars, ['Тест Создатель Б']);
    assert.equal(s.of(s.p2).registrar, '');
    assert.deepEqual(s.of(s.p2).registrars, []);
  } finally { s.db.close(); }
});

test('PATIENT_LIST_REGISTRAR_V1: два визита — регистратор более позднего; отметка журнала считается', () => {
  const s = seedRegistrars();
  try {
    s.mark(s.visit(s.p1, '2021-05-05T09:00:00Z'), 13);          // поздний — В (отметка «оформлен»), заведён в базу первым
    s.invoice(s.p1, s.visit(s.p1, '2020-01-01T09:00:00Z'), 11);  // ранний — А
    assert.equal(s.of(s.p1).registrar, 'Тест Регистратор В', 'взят не последний визит (или создатель карты)');
  } finally { s.db.close(); }
});

test('PATIENT_LIST_REGISTRAR_V1: отменённый, «не пришёл» и будущая запись — не «последний визит», их регистратор не показывается', () => {
  const s = seedRegistrars();
  try {
    s.invoice(s.p2, s.visit(s.p2, '2020-01-01T09:00:00Z'), 11);
    s.invoice(s.p2, s.visit(s.p2, '2021-01-01T09:00:00Z', 'cancelled'), 13);
    s.invoice(s.p2, s.visit(s.p2, '2022-01-01T09:00:00Z', 'no_show'), 13);
    s.invoice(s.p2, s.visit(s.p2, '2099-01-01T09:00:00Z', 'scheduled'), 13);
    const a = s.of(s.p2);
    assert.equal(a.last_visit_day, '2020-01-01');
    assert.equal(a.registrar, 'Тест Регистратор А');
  } finally { s.db.close(); }
});

test('PATIENT_LIST_REGISTRAR_V1: у последнего визита никто не записан — кто завёл карту, а без него пусто', () => {
  const s = seedRegistrars();
  try {
    s.invoice(s.p1, s.visit(s.p1, '2020-01-01T09:00:00Z'), 11);
    s.visit(s.p1, '2021-01-01T09:00:00Z');                       // позже, без счёта и отметки
    s.invoice(s.p2, s.visit(s.p2, '2021-01-01T09:00:00Z'), 13, 'void');   // отменённый счёт — не «оформил»
    assert.equal(s.of(s.p1).registrar, 'Тест Создатель Б', 'регистратор взят у предыдущего визита, а не у создателя карты');
    assert.equal(s.of(s.p2).registrar, '');
    assert.deepEqual(s.of(s.p2).registrars, []);
  } finally { s.db.close(); }
});

test('PATIENT_LIST_REGISTRAR_V1: несколько человек у визита — первый по правилу «Записей CRM» (счета, затем журнал), все — списком', () => {
  const s = seedRegistrars();
  try {
    const v = s.visit(s.p2, '2020-01-01T09:00:00Z');
    s.mark(v, 13);
    s.mark(v, null, 'Тест Имя Из Журнала');
    s.invoice(s.p2, v, 11);
    s.invoice(s.p2, v, 11);
    const a = s.of(s.p2);
    assert.equal(a.registrar, 'Тест Регистратор А');
    assert.deepEqual(a.registrars, ['Тест Регистратор А', 'Тест Регистратор В', 'Тест Имя Из Журнала']);
  } finally { s.db.close(); }
});

test('PATIENT_LIST_REGISTRAR_V1: чтения регистратора страницы идут по индексам (до и после ANALYZE), число запросов не растёт со страницей', () => {
  const s = seedRegistrars();
  try {
    s.db.transaction(() => {
      const p = s.db.prepare('INSERT INTO patients (full_name) VALUES (?)');
      for (let i = 0; i < 400; i++) {
        const pid = Number(p.run('Тест Пациент ' + i).lastInsertRowid);
        const v = s.visit(pid, '2020-02-0' + (1 + (i % 9)) + 'T09:00:00Z');
        if (i % 2) s.invoice(pid, v, 11); else s.mark(v, 13);
      }
    })();
    const check = (when) => {
      const plans = patientRegistrarPlans(s.db, { patientIds: [s.p1, s.p2], visitIds: [1, 2] });
      assert.deepEqual(Object.keys(plans).sort(), ['invoices', 'journal', 'lastVisit']);
      const all = Object.values(plans).flat().join(' | ');
      assert.ok(/idx_visits_patient/.test(plans.lastVisit.join(' | ')), when + ': визиты страницы не по индексу пациента: ' + plans.lastVisit.join(' | '));
      assert.ok(/idx_invoices_visit/.test(plans.invoices.join(' | ')), when + ': счета не по индексу визита: ' + plans.invoices.join(' | '));
      assert.ok(/idx_invoice_audit_log_visit/.test(plans.journal.join(' | ')), when + ': журнал не по индексу визита: ' + plans.journal.join(' | '));
      assert.ok(!/SCAN (v|i|a|vs|iv|visits|invoices|invoice_audit_log|visit_services|users)\b/.test(all), when + ': полный обход таблицы: ' + all);
    };
    check('пустая статистика');
    s.db.exec('ANALYZE');
    check('после ANALYZE');
    // Одна страница — постоянное число запросов, сколько бы строк в ней ни было.
    const ids = s.db.prepare('SELECT id FROM patients ORDER BY id').all().map((r) => r.id);
    const count = (list) => {
      let n = 0;
      const orig = s.db.prepare;
      s.db.prepare = function (q) { if (/visit_registered|FROM invoices i\s+WHERE i\.visit_id IN|WHERE ok = 1/.test(q)) n++; return orig.call(this, q); };
      try { patientBaseAggregates(s.db, { p_ids: list }, registrar); } finally { s.db.prepare = orig; }
      return n;
    };
    assert.equal(count(ids.slice(0, 30)), 3, 'три чтения на страницу: последний визит, счета, журнал');
    // Повторный вызов берёт готовые запросы из памяти соединения — новых не больше.
    assert.ok(count(ids.slice(0, 2)) <= 3);
  } finally { s.db.close(); }
});
