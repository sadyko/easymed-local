// STOCK_REQUEST_V1 (mig 145) — у заявки есть держатель и пометка «авто»,
// у держателя — минимум и норма на товар.
//
// Форма проверки — та же, что у 142: колонки есть и старые строки получили
// честное значение · реестр отдаёт новое на чтение и фильтр · повторный накат
// ничего не ломает · обмен зданий новые таблицы и колонки не везёт.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { readableColumns, filterAllowed, writableColumns } from '../schema-registry.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
function seed(db) {
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (5,'n','x','nurse','Медсестра')").run();
  db.prepare("INSERT INTO departments (id, name) VALUES (9, 'Терапия')").run();
  db.prepare("INSERT INTO products (id, name, unit, base_unit) VALUES (7, 'Перчатки', 'pcs', 'pcs')").run();
}

test('145: у заявки holder_type/holder_id и auto; заявка, названная только отделом, получает держателя сама', () => {
  const db = fresh();
  try {
    const cols = Object.fromEntries(db.prepare('PRAGMA table_info(purchase_requisitions)').all().map((c) => [c.name, c]));
    assert.ok(cols.holder_type && cols.holder_id && cols.auto, 'нет новых колонок заявки');
    assert.equal(cols.auto.notnull, 1);
    assert.equal(cols.auto.dflt_value, '0');
    seed(db);

    // Экран «Заявки» пишет напрямую, называя только отдел, — держатель ставится из него.
    const id = db.prepare("INSERT INTO purchase_requisitions (req_number, status, department_id) VALUES ('R1','submitted',9)").run().lastInsertRowid;
    assert.deepEqual({ ...db.prepare('SELECT holder_type, holder_id, auto FROM purchase_requisitions WHERE id=?').get(id) },
      { holder_type: 'department', holder_id: 9, auto: 0 });
    // Названный держатель не перебивается отделом.
    const id2 = db.prepare("INSERT INTO purchase_requisitions (req_number, status, holder_type, holder_id, auto) VALUES ('R2','submitted','staff',5,1)").run().lastInsertRowid;
    assert.deepEqual({ ...db.prepare('SELECT holder_type, holder_id, auto FROM purchase_requisitions WHERE id=?').get(id2) },
      { holder_type: 'staff', holder_id: 5, auto: 1 });
    // Кабинет — не держатель заявки.
    assert.throws(() => db.prepare("INSERT INTO purchase_requisitions (req_number, holder_type, holder_id) VALUES ('R3','room',1)").run(), /CHECK/i);
    assert.throws(() => db.prepare("INSERT INTO purchase_requisitions (req_number, auto) VALUES ('R4', 2)").run(), /CHECK/i);
  } finally { db.close(); }
});

test('145: минимум и норма — один на держателя и товар, норма не меньше минимума, оба не отрицательные', () => {
  const db = fresh();
  try {
    seed(db);
    const ins = db.prepare('INSERT INTO stock_minimums (holder_type, holder_id, product_id, min_qty, target_qty, set_by) VALUES (?,?,?,?,?,?)');
    ins.run('staff', 5, 7, 2, 10, 5);
    assert.throws(() => ins.run('staff', 5, 7, 1, 1, 5), /UNIQUE/i, 'второй минимум на того же держателя и товар');
    ins.run('department', 5, 7, 1, 1, 5);   // тот же id, но другой тип держателя — другая строка
    assert.throws(() => ins.run('staff', 6, 7, 5, 4, 5), /CHECK/i, 'норма меньше минимума');
    assert.throws(() => ins.run('staff', 6, 7, -1, 4, 5), /CHECK/i, 'отрицательный минимум');
    assert.throws(() => ins.run('room', 6, 7, 1, 4, 5), /CHECK/i, 'кабинету минимум не ставится');
    assert.throws(() => ins.run('staff', 6, 999, 1, 4, 5), /FOREIGN KEY/i, 'товара нет');
    const row = db.prepare('SELECT updated_at FROM stock_minimums WHERE holder_type=? AND holder_id=?').get('staff', 5);
    assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally { db.close(); }
});

test('145: «Заявки» читают держателя и «авто» и фильтруют по ним — но записать их напрямую нельзя', () => {
  for (const c of ['holder_type', 'holder_id', 'auto']) {
    assert.ok(readableColumns('purchase_requisitions').includes(c), `${c} не читается`);
    assert.ok(filterAllowed('purchase_requisitions', c), `по ${c} нельзя отфильтровать`);
    assert.ok(!writableColumns('purchase_requisitions', 'insert').includes(c),
      `${c} пишется напрямую: «авто» и держатель ставит сервер, а не экран`);
    assert.ok(!writableColumns('purchase_requisitions', 'update').includes(c), `${c} правится напрямую`);
  }
  // Минимумы экран читает вызовом (stock_minimums_list), а не таблицей.
  assert.deepEqual(readableColumns('stock_minimums'), []);
});

test('145: заявки и минимумы не уезжают в другое здание', () => {
  for (const t of ['stock_minimums', 'purchase_requisitions', 'purchase_requisition_items']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(SHIPPED, t), `${t} попала в обмен между зданиями`);
  }
  for (const [tbl, cols] of Object.entries(SHIPPED)) {
    for (const c of ['holder_type', 'holder_id', 'min_qty', 'target_qty']) {
      assert.ok(!cols.includes(c), `${c} уехал бы филиалам в составе ${tbl}`);
    }
  }
  const db = fresh();
  try {
    const trigs = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='stock_minimums'").all();
    assert.deepEqual(trigs, [], 'у минимумов появились триггеры обмена');
  } finally { db.close(); }
});

test('145 ложится на базу с заявками: старые получают держателя из отдела, «списание без отдела» остаётся без держателя', () => {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig145-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 145 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  seed(db);
  db.prepare("INSERT INTO purchase_requisitions (id, req_number, status, department_id) VALUES (1,'REQ-A','issued',9)").run();
  db.prepare("INSERT INTO purchase_requisitions (id, req_number, status) VALUES (2,'REQ-B','submitted')").run();

  migrate(db);
  migrate(db);   // повторный прогон — ничего не ломает и не задваивает

  const rows = db.prepare('SELECT id, status, department_id, holder_type, holder_id, auto FROM purchase_requisitions ORDER BY id').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: 1, status: 'issued', department_id: 9, holder_type: 'department', holder_id: 9, auto: 0 },
    { id: 2, status: 'submitted', department_id: null, holder_type: null, holder_id: null, auto: 0 },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='stock_minimums'").get().n, 1);
  db.close();
});
