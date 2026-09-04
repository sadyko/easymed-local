// 087.test.js — BRANCH_MONEY_V1: журнал денег пишется САМ.
//
// Те же проверки, что у 084 (записи), на трёх денежных таблицах — плюс два
// правила, которых у записей не было и которые здесь несущие:
//   • paid_amount НЕ журналируется вовсе (он не уезжает, его считают);
//   • сравнение сумм численное: запись того же REAL не должна порождать
//     «правку», которой не было, и гонять счёт по сети.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const MONEY = ['invoices', 'invoice_items', 'payments'];

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('DELETE FROM sync_journal').run();
  return db;
}

/** Пациент → счёт → позиция → платёж: минимальная денежная цепочка. */
function bill(db, { total = 100000 } = {}) {
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const iid = db.prepare(`INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, status)
                          VALUES ('INV-A-26-00001', ?, ?, ?, 'unpaid')`).run(pid, total, total).lastInsertRowid;
  const itid = db.prepare(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total)
                           VALUES (?, 'Консультация', 1, ?, ?)`).run(iid, total, total).lastInsertRowid;
  const payid = db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?, ?, 'cash')")
    .run(iid, total).lastInsertRowid;
  return { pid, iid, itid, payid };
}

test('087: у денег есть uid и метка происхождения', () => {
  const db = fresh();
  for (const t of MONEY) {
    const uid = db.prepare(`SELECT type FROM pragma_table_info('${t}') WHERE name='uid'`).get();
    const org = db.prepare(`SELECT type, "notnull", dflt_value FROM pragma_table_info('${t}') WHERE name='sync_origin'`).get();
    assert.ok(uid, t + ': без uid строка не переживёт границу филиала');
    assert.ok(org, t + ': без sync_origin неизвестно, чьи это деньги');
    assert.equal(org.notnull, 0, t + ': своя строка помечена именно ПУСТЫМ значением');
  }
  db.close();
});

test('087: uid выдаётся сам, а sync_origin у своей работы пуст', () => {
  const db = fresh();
  const { iid, itid, payid } = bill(db);
  for (const [t, id] of [['invoices', iid], ['invoice_items', itid], ['payments', payid]]) {
    const row = db.prepare(`SELECT uid, sync_origin FROM ${t} WHERE id = ?`).get(id);
    assert.equal(typeof row.uid, 'string', t + ': строка без uid никуда не поедет');
    assert.equal(row.uid.length, 32, t);
    assert.equal(row.sync_origin, null, t + ': выписано здесь — значит своё');
  }
  db.close();
});

test('087: uid уникален — две строки под одним uid означали бы приём одной записи дважды', () => {
  const db = fresh();
  const { iid } = bill(db);
  const uid = db.prepare('SELECT uid FROM invoices WHERE id = ?').get(iid).uid;
  const pid = db.prepare('SELECT patient_id FROM invoices WHERE id = ?').get(iid).patient_id;
  assert.throws(
    () => db.prepare("INSERT INTO invoices (uid, invoice_number, patient_id) VALUES (?, 'INV-A-26-00002', ?)").run(uid, pid),
    /UNIQUE/i, 'молча выбрать одну из двух одинаковых строк хуже, чем упасть');
  db.close();
});

test('087: выставленный счёт, его позиция и платёж попадают в журнал без участия кода', () => {
  const db = fresh();
  bill(db);
  for (const t of MONEY) {
    const rows = db.prepare('SELECT op, uid, cols FROM sync_journal WHERE tbl = ?').all(t);
    assert.ok(rows.length >= 1, t + ': соседи обязаны узнать о деньгах');
    assert.ok(rows.every((r) => r.op === 'put'), t);
    assert.ok(rows.every((r) => typeof r.uid === 'string' && r.uid.length === 32),
      t + ': записи без uid в журнале не бывает — NOT NULL уронил бы выставление счёта');
    assert.ok(rows.some((r) => r.cols === '*'), t + ': у соседа этой строки нет — ему нужна вся');
  }
  db.close();
});

test('087: правка суммы журналируется именно этой колонкой', () => {
  const db = fresh();
  const { iid } = bill(db);
  db.prepare('DELETE FROM sync_journal').run();
  db.prepare('UPDATE invoices SET total_amount = 90000 WHERE id = ?').run(iid);
  assert.deepEqual(db.prepare('SELECT cols FROM sync_journal').all().map((r) => r.cols), ['total_amount']);
  db.close();
});

// ГЛАВНОЕ ПРАВИЛО ЭТОЙ МИГРАЦИИ. paid_amount не уезжает (journal.js SHIPPED):
// каждое здание считает его из платежей, которые к нему доехали. Значит и в
// журнале ему делать нечего — иначе пересчёт на приёме становился бы сетевым
// событием и счёт ходил бы по кругу.
test('087: пересчёт paid_amount НЕ поднимает счёт в сеть', () => {
  const db = fresh();
  const { iid } = bill(db);
  db.prepare('DELETE FROM sync_journal').run();
  db.prepare('UPDATE invoices SET paid_amount = 100000 WHERE id = ?').run(iid);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n, 0,
    'paid_amount — производная, а не правка: она считается на каждой стороне своя');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_authored WHERE col = 'paid_amount'").get().n, 0,
    'и авторства у неё нет: автора у арифметики не бывает');
  db.close();
});

// А статус, наоборот, едет: 'debt', 'void' и 'refunded' — решения человека, из
// сумм их не вычислить, и посчитанный статус превратил бы отменённый в филиале
// счёт в долг пациента.
test('087: смена статуса едет соседям', () => {
  const db = fresh();
  const { iid } = bill(db);
  db.prepare('DELETE FROM sync_journal').run();
  db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(iid);
  assert.deepEqual(db.prepare('SELECT cols FROM sync_journal').all().map((r) => r.cols), ['status']);
  db.close();
});

// ДЕНЬГИ — ЭТО REAL. Сравнение в триггере (NEW.x IS NOT OLD.x) обязано быть
// численным, иначе запись того же самого 1234.56 порождала бы «правку» и гнала
// строку соседям на ровном месте.
test('087: запись того же числа не считается правкой', () => {
  const db = fresh();
  const { iid, payid } = bill(db, { total: 1234.56 });
  db.prepare('DELETE FROM sync_journal').run();
  db.prepare('UPDATE invoices SET total_amount = 1234.56 WHERE id = ?').run(iid);
  db.prepare('UPDATE payments SET amount = 1234.56 WHERE id = ?').run(payid);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n, 0,
    'то же число — не правка; иначе каждая порция возвращалась бы обратно');
  // А настоящая копейка разницы — правка.
  db.prepare('UPDATE invoices SET total_amount = 1234.57 WHERE id = ?').run(iid);
  assert.deepEqual(db.prepare('SELECT cols FROM sync_journal').all().map((r) => r.cols), ['total_amount']);
  assert.equal(db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(iid).total_amount, 1234.57);
  db.close();
});

test('087: правка пишет авторство колонки, вставка — нет', () => {
  const db = fresh();
  const { iid } = bill(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_authored WHERE tbl = 'invoices'").get().n, 0,
    'у новой строки пол авторства — её created_at, отдельная запись не нужна');
  db.prepare("UPDATE invoices SET status = 'paid', paid_at = '2026-09-04T10:00:00Z' WHERE id = ?").run(iid);
  const cols = db.prepare("SELECT col FROM sync_authored WHERE tbl = 'invoices' ORDER BY col").all().map((r) => r.col);
  assert.deepEqual(cols, ['paid_at', 'status']);
  db.close();
});

test('087: удаление счёта оставляет надгробие и уносит авторство', () => {
  const db = fresh();
  const { iid, itid, payid } = bill(db);
  const uid = db.prepare('SELECT uid FROM invoices WHERE id = ?').get(iid).uid;
  db.prepare('UPDATE invoices SET total_amount = 1 WHERE id = ?').run(iid);   // завели авторство
  // Порядок удаления — детей раньше родителя: foreign_keys = ON.
  db.prepare('DELETE FROM payments WHERE id = ?').run(payid);
  db.prepare('DELETE FROM invoice_items WHERE id = ?').run(itid);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(iid);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_journal WHERE tbl='invoices' AND op='del'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_tombstones WHERE tbl='invoices' AND uid=?").get(uid).n, 1,
    'без надгробия вернувшийся сосед воскресил бы удалённый счёт');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_authored WHERE tbl='invoices' AND uid=?").get(uid).n, 0);
  db.close();
});

// РЕШЕНИЕ, ЗАПИСАННОЕ ТЕСТОМ. Кассовая смена не ездит: у неё FK на users(id) и
// branches(id), а ни пользователи, ни локальные id филиалов между зданиями не
// ходят — привезённая смена ссылалась бы в пустоту. Цена названа в шапке
// миграции: по чужому зданию не показать ни кассира, ни остаток в ящике.
test('087: кассовые смены и движения ящика НАМЕРЕННО остаются в своём здании', () => {
  const db = fresh();
  for (const t of ['cash_shifts', 'cash_movements']) {
    const uid = db.prepare(`SELECT name FROM pragma_table_info('${t}') WHERE name='uid'`).get();
    assert.equal(uid, undefined, t + ': смена принадлежит человеку и ящику, а они не ездят');
  }
  db.close();
});
