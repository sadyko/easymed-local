// INPATIENT_BONUS_V1 (мигр. 155) — кто направил на госпитализацию,
// стационарное вознаграждение партнёра, ставки стационара у сотрудника — и
// ПЕРЕНОС прежнего «Стационар, %» (users.service_rates[].inpatient_pct) в
// users.inpatient_rates с развязкой от амбулаторной ставки.
//
// Проверяется: колонки и их ограничения · перенос значений (включая 0 и
// дубли услуги) · ключ inpatient_pct исчезает из service_rates · запись,
// жившая только ради стационара, удаляется и пишется в журнал · прочие
// записи целы · повторный прогон ничего не меняет · и деньги: после переноса
// амбулаторная ставка по умолчанию больше не обнуляется записью {pct: 0}, а
// стационарная доля та же, что до переноса.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctorPaySummary } from '../../services/rpc/reports.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const cols = (db, t) => Object.fromEntries(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c]));

// Вернуть базу в состояние «до 155» и прогнать её снова — так, как её
// встретит клиника со старыми ставками.
const ADDED = [
  ['admissions', 'referral_source_id'],
  ['referral_sources', 'inpatient_bonus_enabled'], ['referral_sources', 'inpatient_pct'], ['referral_sources', 'inpatient_fixed'],
  ['users', 'inpatient_rates'], ['users', 'inpatient_referral_pct'], ['users', 'inpatient_referral_fixed'],
];
function rollback155(db) {
  for (const [t, c] of ADDED) db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
  db.exec('DROP TABLE inpatient_rate_migration_log');
  db.prepare("DELETE FROM schema_migrations WHERE name LIKE '155%'").run();
}
// Шаг переноса (раздел 4 файла) ещё раз — миграция целиком второй раз не
// идёт (schema_migrations), но её перенос обязан быть идемпотентным.
const SQL155 = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '155_inpatient_bonus.sql'), 'utf8');
function rerunTransfer(db) {
  db.exec(SQL155.slice(SQL155.indexOf('CREATE TABLE IF NOT EXISTS inpatient_rate_migration_log')));
}
const userRow = (db, id) => db.prepare('SELECT service_rates, inpatient_rates FROM users WHERE id = ?').get(id);
const log = (db) => db.prepare('SELECT user_id, service_id, inpatient_pct, entry FROM inpatient_rate_migration_log ORDER BY id').all();

test('155: колонки — у госпитализации, у источника и у сотрудника, с ограничениями', () => {
  const db = freshDb();
  try {
    assert.ok(cols(db, 'admissions').referral_source_id);
    const rs = cols(db, 'referral_sources');
    for (const c of ['inpatient_bonus_enabled', 'inpatient_pct', 'inpatient_fixed']) {
      assert.ok(rs[c], 'нет ' + c);
      assert.equal(rs[c].notnull, 1);
      assert.equal(Number(rs[c].dflt_value), 0);
    }
    const u = cols(db, 'users');
    assert.equal(u.inpatient_rates.dflt_value, "''");
    assert.ok(u.inpatient_referral_pct && u.inpatient_referral_fixed);
    const ins = db.prepare('INSERT INTO referral_sources (name, inpatient_bonus_enabled, inpatient_pct, inpatient_fixed) VALUES (?,?,?,?)');
    ins.run('ok', 1, 100, 0);
    assert.throws(() => ins.run('pct', 1, 101, 0), /CHECK/);
    assert.throws(() => ins.run('neg', 1, 5, -1), /CHECK/);
    assert.throws(() => ins.run('flag', 2, 5, 0), /CHECK/);
    const uins = db.prepare("INSERT INTO users (username, password_hash, role, inpatient_referral_pct, inpatient_referral_fixed) VALUES (?, 'x', 'doctor', ?, ?)");
    assert.throws(() => uins.run('u1', 150, 0), /CHECK/);
    assert.throws(() => uins.run('u2', 5, -5), /CHECK/);
    // Источник удалили — госпитализация остаётся, без направившего.
    const src = ins.run('gone', 0, 0, 0).lastInsertRowid;
    const pt = db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid;
    const a = db.prepare("INSERT INTO admissions (patient_id, status, referral_source_id) VALUES (?, 'active', ?)").run(pt, src).lastInsertRowid;
    db.prepare('DELETE FROM referral_sources WHERE id = ?').run(src);
    assert.equal(db.prepare('SELECT referral_source_id FROM admissions WHERE id = ?').get(a).referral_source_id, null);
  } finally { db.close(); }
});

test('155: «Стационар, %» переезжает в inpatient_rates; запись только ради стационара — удаляется с журналом', () => {
  const db = freshDb();
  try {
    rollback155(db);
    const ins = db.prepare("INSERT INTO users (id, username, password_hash, role, service_rates, service_rate_default) VALUES (?, ?, 'x', 'doctor', ?, ?)");
    ins.run(1, 'mixed', JSON.stringify([
      { service_id: 1, pct: 0, inpatient_pct: 20, branches: [] },        // только ради стационара → удаляется
      { service_id: 2, pct: 40, inpatient_pct: 10, branches: [1] },      // амбулаторная остаётся без ключа
      { service_id: 3, pct: 0, branches: [] },                           // сознательный 0 без стационара — цел
      { service_id: 4, pct: 0, price: 5000, inpatient_pct: 5 },          // своя цена — запись осталась
      { service_id: 5, pct: 0, fix: 7000, inpatient_pct: 0 },            // фикс — запись осталась; 0 — тоже ставка
      { service_id: 6, pct: 30, inpatient_pct: '' },                     // мусор в ключе — просто исчезает
    ]), 30);
    ins.run(2, 'dup', JSON.stringify([
      { service_id: 7, pct: 10, inpatient_pct: 15 }, { service_id: 7, pct: 10, inpatient_pct: 25 },
    ]), 0);
    ins.run(3, 'none', JSON.stringify([{ service_id: 1, pct: 50 }]), 0);
    ins.run(4, 'broken', '{not json', 0);
    ins.run(5, 'empty', '', 0);
    migrate(db);

    const one = userRow(db, 1);
    assert.deepEqual(JSON.parse(one.inpatient_rates), [
      { service_id: 1, pct: 20 }, { service_id: 2, pct: 10 }, { service_id: 4, pct: 5 }, { service_id: 5, pct: 0 },
    ]);
    assert.deepEqual(JSON.parse(one.service_rates), [
      { service_id: 2, pct: 40, branches: [1] },
      { service_id: 3, pct: 0, branches: [] },
      { service_id: 4, pct: 0, price: 5000 },
      { service_id: 5, pct: 0, fix: 7000 },
      { service_id: 6, pct: 30 },
    ]);
    assert.ok(!one.service_rates.includes('inpatient_pct'));
    // Дубли услуги — бо́льшая ставка (как читал отчёт, MAX).
    assert.deepEqual(JSON.parse(userRow(db, 2).inpatient_rates), [{ service_id: 7, pct: 25 }]);
    // Без стационарных ключей, битый JSON и пустое — не тронуты.
    assert.deepEqual(userRow(db, 3), { service_rates: JSON.stringify([{ service_id: 1, pct: 50 }]), inpatient_rates: '' });
    assert.deepEqual(userRow(db, 4), { service_rates: '{not json', inpatient_rates: '' });
    assert.deepEqual(userRow(db, 5), { service_rates: '', inpatient_rates: '' });

    const l = log(db);
    assert.equal(l.length, 1, JSON.stringify(l));
    assert.equal(l[0].user_id, 1);
    assert.equal(l[0].service_id, 1);
    assert.equal(l[0].inpatient_pct, 20);
    assert.deepEqual(JSON.parse(l[0].entry), { service_id: 1, pct: 0, inpatient_pct: 20, branches: [] });

    // Повторный прогон ничего не меняет.
    const before = [userRow(db, 1), userRow(db, 2)];
    rerunTransfer(db);
    assert.deepEqual([userRow(db, 1), userRow(db, 2)], before);
    assert.equal(log(db).length, 1);
  } finally { db.close(); }
});

test('155: деньги — ставка по умолчанию больше не обнуляется, стационарная доля та же', () => {
  const db = freshDb();
  try {
    rollback155(db);
    // Врач: 30 % по умолчанию; услугу 1 отмечал ТОЛЬКО ради «Стационар, 20 %».
    db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default)
                VALUES (1, 'doc', 'x', 'doctor', 'Врач', 1, ?, 30)`)
      .run(JSON.stringify([{ service_id: 1, pct: 0, inpatient_pct: 20, branches: [] }]));
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (9, 'adm', 'x', 'admin')").run();
    migrate(db);
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'П')").run();
    db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1, 'Перевязка', 100000, 0)").run();
    db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1, 1, '2026-08-05T09:00:00Z')").run();
    db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status)
                VALUES (1, 1, 1, 1, 100000, 100000, 'completed')`).run();
    db.prepare("INSERT INTO admissions (id, patient_id, doctor_id, status) VALUES (1, 1, 1, 'active')").run();
    db.prepare(`INSERT INTO admission_services (admission_id, service_id, doctor_id, quantity, unit_price, total, status, billable, performed_at)
                VALUES (1, 1, 1, 1, 100000, 100000, 'added', 1, '2026-08-05T10:00:00Z')`).run();
    const s = doctorPaySummary(db, { doctor_id: 1, from: '2026-08-01', to: '2026-08-31' }, { id: 9, role: 'admin' });
    // До переноса запись {pct: 0} перекрывала 30 % по умолчанию и амбулатория давала 0.
    assert.equal(s.outpatient.fee, 30000);
    assert.equal(s.inpatient.fee, 20000);
  } finally { db.close(); }
});
