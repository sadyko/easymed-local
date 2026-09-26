// GROUPS_FIVE_REFERRAL_V1 (mig 153) — ставки направлений переводятся с ключа
// service_types.id на группу (services.type, одна из пяти).
//
// Проверяется: перевод по большинству услуг типа · тип без услуг — по имени,
// иначе отбрасывается с записью в журнал · два типа в одну группу с РАЗНЫМИ
// ставками — остаётся тип с бо́льшим числом услуг, проигравший в журнале ·
// одинаковые ставки сливаются без журнала · уже переведённое не трогается ·
// и деньги: ставка, заданная на «Консультации» до миграции, платит на строке
// консультации ровно столько же после неё.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { runReport } from '../../services/rpc/reports.js';

const MIG = '153%';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
// Прогнать 153 ещё раз — так, как её встретит база клиники со старыми ставками.
function rerun153(db) {
  db.prepare('DELETE FROM schema_migrations WHERE name LIKE ?').run(MIG);
  migrate(db);
}
const typeId = (db, name) => db.prepare('INSERT INTO service_types (name) VALUES (?)').run(name).lastInsertRowid;
function services(db, tid, type, n) {
  for (let i = 0; i < n; i += 1) {
    db.prepare('INSERT INTO services (name, price, type, type_id) VALUES (?, 1000, ?, ?)').run(`${type}-${tid}-${i}`, type, tid);
  }
}
const catRates = (db, id) => JSON.parse(db.prepare('SELECT rates FROM referral_source_categories WHERE id = ?').get(id).rates);
const srcRates = (db, id) => JSON.parse(db.prepare('SELECT own_rates FROM referral_sources WHERE id = ?').get(id).own_rates);
const logRows = (db) => db.prepare('SELECT * FROM referral_rate_migration_log ORDER BY id').all();

test('153: журнал заведён, на свежей базе переводить нечего', () => {
  const db = freshDb();
  try {
    assert.deepEqual(logRows(db), []);
    const cols = db.prepare('PRAGMA table_info(referral_rate_migration_log)').all().map((c) => c.name);
    for (const c of ['table_name', 'row_id', 'type_id', 'service_group', 'unit', 'value', 'kept_type_id', 'reason']) {
      assert.ok(cols.includes(c), 'нет колонки ' + c);
    }
  } finally { db.close(); }
});

test('153: тип → группа по большинству услуг; тип без услуг — по названию или в журнал', () => {
  const db = freshDb();
  try {
    const tMixed = typeId(db, 'Смешанный');          // 3 процедуры + 1 лаборатория → procedure
    services(db, tMixed, 'procedure', 3);
    services(db, tMixed, 'lab', 1);
    const tRad = typeId(db, 'Старый рентген');        // только radiology → imaging
    services(db, tRad, 'radiology', 2);
    const tSurgName = typeId(db, 'Хирургия ');        // без услуг, имя совпадает → other
    const tEmpty = typeId(db, 'Лучевая диагностика 2'); // без услуг, имя не из пяти → в журнал
    const cat = db.prepare("INSERT INTO referral_source_categories (name, rates) VALUES ('К', ?)").run(JSON.stringify([
      { type_id: tMixed, unit: 'pct', value: 12 },
      { type_id: tRad, unit: 'fix', value: 40000 },
      { type_id: String(tSurgName), unit: 'pct', value: 30 },   // id строкой — так тоже бывало
      { type_id: tEmpty, unit: 'pct', value: 9 },
    ])).lastInsertRowid;
    rerun153(db);

    assert.deepEqual(catRates(db, cat), [
      { group: 'imaging', unit: 'fix', value: 40000 },
      { group: 'procedure', unit: 'pct', value: 12 },
      { group: 'other', unit: 'pct', value: 30 },
    ]);
    const log = logRows(db);
    assert.equal(log.length, 1, JSON.stringify(log));
    assert.equal(log[0].reason, 'unmapped');
    assert.equal(log[0].type_id, tEmpty);
    assert.equal(log[0].type_name, 'Лучевая диагностика 2');
    assert.equal(log[0].value, 9);
    assert.equal(log[0].table_name, 'referral_source_categories');
  } finally { db.close(); }
});

test('153: два типа в одну группу с разными ставками — остаётся тип с бо́льшим числом услуг, другой в журнале', () => {
  const db = freshDb();
  try {
    const tBig = typeId(db, 'Анализы');       // 5 lab
    services(db, tBig, 'lab', 5);
    const tSmall = typeId(db, 'Анализы доп'); // 2 lab
    services(db, tSmall, 'lab', 2);
    const tSame = typeId(db, 'Анализы ещё');  // 1 lab, та же ставка, что у tBig
    services(db, tSame, 'lab', 1);
    // Меньший тип стоит ПЕРВЫМ — порядок в массиве не решает.
    const src = db.prepare("INSERT INTO referral_sources (name, reward_mode, own_rates) VALUES ('И', 'own', ?)").run(JSON.stringify([
      { type_id: tSmall, unit: 'pct', value: 10 },
      { type_id: tBig, unit: 'pct', value: 20 },
      { type_id: tSame, unit: 'pct', value: 20 },
    ])).lastInsertRowid;
    rerun153(db);

    assert.deepEqual(srcRates(db, src), [{ group: 'lab', unit: 'pct', value: 20 }]);
    const log = logRows(db);
    assert.equal(log.length, 1, 'совпадающая ставка не должна попадать в журнал: ' + JSON.stringify(log));
    assert.equal(log[0].reason, 'conflict');
    assert.equal(log[0].table_name, 'referral_sources');
    assert.equal(log[0].row_id, src);
    assert.equal(log[0].type_id, tSmall);
    assert.equal(log[0].service_group, 'lab');
    assert.equal(log[0].value, 10);
    assert.equal(log[0].unit, 'pct');
    assert.equal(log[0].kept_type_id, tBig);
  } finally { db.close(); }
});

test('153: идемпотентна; уже переведённое и записи с группой не трогаются', () => {
  const db = freshDb();
  try {
    const tCons = typeId(db, 'Приёмы');
    services(db, tCons, 'consultation', 2);
    const done = JSON.stringify([{ group: 'lab', unit: 'fix', value: 5000 }]);
    const catDone = db.prepare("INSERT INTO referral_source_categories (name, rates) VALUES ('Готово', ?)").run(done).lastInsertRowid;
    // Смешанная строка: запись с группой выигрывает у переводимой в ту же группу.
    const catMixed = db.prepare("INSERT INTO referral_source_categories (name, rates) VALUES ('Смесь', ?)").run(JSON.stringify([
      { type_id: tCons, unit: 'pct', value: 5 },
      { group: 'consultation', unit: 'pct', value: 8 },
    ])).lastInsertRowid;
    rerun153(db);
    assert.equal(db.prepare('SELECT rates FROM referral_source_categories WHERE id = ?').get(catDone).rates, done);
    assert.deepEqual(catRates(db, catMixed), [{ group: 'consultation', unit: 'pct', value: 8 }]);
    assert.equal(logRows(db).filter((r) => r.reason === 'conflict').length, 1);

    const snapshot = db.prepare('SELECT id, rates FROM referral_source_categories ORDER BY id').all();
    const logCount = logRows(db).length;
    rerun153(db);
    assert.deepEqual(db.prepare('SELECT id, rates FROM referral_source_categories ORDER BY id').all(), snapshot);
    assert.equal(logRows(db).length, logCount, 'повторный накат дописал журнал');
  } finally { db.close(); }
});

test('153: деньги не меняются — ставка на «Консультации» до миграции платит столько же после', () => {
  const db = freshDb();
  try {
    db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (1,'reg','x','admin','Р')").run();
    const tCons = db.prepare("SELECT id FROM service_types WHERE name = 'Консультации'").get().id;
    const tLab = db.prepare("SELECT id FROM service_types WHERE name = 'Лаборатория'").get().id;
    const sCons = db.prepare("INSERT INTO services (name, price, type, type_id) VALUES ('Приём терапевта', 50000, 'consultation', ?)").run(tCons).lastInsertRowid;
    const sLab = db.prepare("INSERT INTO services (name, price, type, type_id, is_lab) VALUES ('ОАК', 40000, 'lab', ?, 1)").run(tLab).lastInsertRowid;
    // Ставка, какой её записал редактор ДО миграции: ключ — id типа.
    const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent, rates) VALUES ('Партнёры', 3, ?)").run(JSON.stringify([
      { type_id: tCons, unit: 'fix', value: 30000 },
      { type_id: tLab, unit: 'pct', value: 20 },
    ])).lastInsertRowid;
    const src = db.prepare("INSERT INTO referral_sources (name, category_id) VALUES ('Клиника Х', ?)").run(cat).lastInsertRowid;
    const p = db.prepare("INSERT INTO patients (full_name, mrn, branch_id) VALUES ('Ann','P-1',1)").run().lastInsertRowid;
    const v = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date, referral_source_id) VALUES (?,1,'2026-08-05T09:00:00Z',?)").run(p, src).lastInsertRowid;
    const inv = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, branch_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by, created_at, paid_at)
      VALUES ('INV-1',?,?,1,140000,0,140000,140000,'paid',1,'2026-08-05T09:30:00Z','2026-08-05T10:00:00Z')`).run(v, p).lastInsertRowid;
    db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,'Приём терапевта',2,50000,100000)").run(inv, sCons);
    db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,'ОАК',1,40000,40000)").run(inv, sLab);
    rerun153(db);

    const r = runReport(db, { kind: 'referrals_detail', from: '2026-08-01', to: '2026-08-31' }, { id: 1, role: 'admin' });
    const col = (name) => r.columns.indexOf(name);
    const byService = new Map(r.rows.map((row) => [row[col('Услуга')], row[col('Вознаграждение')]]));
    // По type_id старый расчёт давал: 2 × 30 000 фикс и 20 % от 40 000.
    assert.equal(byService.get('Приём терапевта'), 60000);
    assert.equal(byService.get('ОАК'), 8000);
    assert.deepEqual(logRows(db), []);
  } finally { db.close(); }
});
