// 088.test.js — BRANCH_MONEY_NUMBER_V1: номер документа несёт букву здания.
//
// Проверяется обещание, данное клинике в шапке миграции: новые номера
// различимы между зданиями, СТАРЫЕ не меняются и продолжают работать, а
// нумерация не начинается заново.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { nextInvoiceNumber, branchLetter } from '../../services/rpc/billing.js';
import { nextDepositNumber } from '../../services/rpc/deposits.js';

function clinic(letter = 'A') {
  const db = openDb(':memory:');
  migrate(db);
  if (letter !== 'A') {
    db.prepare('UPDATE branch_identity SET letter = ? WHERE id = 1').run(letter);
  }
  return db;
}

test('088: главная клиника — буква A, и она стоит в номере счёта', () => {
  const db = clinic();
  assert.equal(branchLetter(db), 'A', 'её ставит миграция 080');
  assert.match(nextInvoiceNumber(db), /^INV-A-\d{2}-\d{5}$/);
  db.close();
});

test('088: номер депозита несёт ту же букву — он становится номером счёта', () => {
  const db = clinic('B');
  assert.match(nextDepositNumber(db), /^DEP-B-\d{2}-\d{5}$/);
  db.close();
});

// ТО, РАДИ ЧЕГО ВСЁ И СДЕЛАНО. Два здания в одну и ту же секунду выписывают
// первый счёт года. До буквы это был один и тот же 'INV-26-00001', и
// приехавший счёт соседа отвергался UNIQUE-индексом — молча и навсегда.
test('088: два здания в одну секунду не выдают одинаковый номер', () => {
  const a = clinic('A');
  const b = clinic('B');
  const na = nextInvoiceNumber(a);
  const nb = nextInvoiceNumber(b);
  assert.notEqual(na, nb, 'иначе приехавший счёт соседа отвергается уникальным индексом');
  assert.equal(na.slice(-5), nb.slice(-5), 'счётчики у зданий свои и совпадают — различает именно буква');
  // И проверка того, что действительно спасает: оба номера ложатся в ОДНУ базу.
  const pid = a.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const ins = a.prepare('INSERT INTO invoices (invoice_number, patient_id, total_amount) VALUES (?, ?, 1)');
  ins.run(na, pid);
  ins.run(nb, pid);
  assert.equal(a.prepare('SELECT COUNT(*) n FROM invoices').get().n, 2,
    'счёт филиала обязан лечь рядом со своим, а не быть отвергнутым');
  a.close(); b.close();
});

// СТАРЫЕ НОМЕРА НЕ ПЕРЕПИСЫВАЮТСЯ: они на чеках, в бумагах и в поиске. То же
// решение, что 080 приняла про MRN.
test('088: счёт со старым номером без буквы читается, печатается и попадает в отчёт', () => {
  const db = clinic();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  db.prepare(`INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, paid_amount, status, created_at, paid_at)
              VALUES ('INV-26-00041', ?, 70000, 70000, 70000, 'paid', '2026-08-01T09:00:00Z', '2026-08-01T09:05:00Z')`).run(pid);

  // читается по номеру — как его ищет касса и как его печатает документ
  const old = db.prepare('SELECT * FROM invoices WHERE invoice_number = ?').get('INV-26-00041');
  assert.ok(old, 'номер, напечатанный на чеке, обязан находиться и после обновления');
  assert.equal(old.invoice_number, 'INV-26-00041', 'и остаться тем же самым знак в знак');

  // попадает в отчёт — тот же вид запроса, что считает выручку по дню
  const revenue = db.prepare(`SELECT COALESCE(SUM(total_amount), 0) s FROM invoices
                               WHERE status <> 'void' AND substr(created_at, 1, 10) = '2026-08-01'`).get().s;
  assert.equal(revenue, 70000, 'старый счёт — такие же деньги, как новый');

  // и новый номер рядом с ним не спорит
  const fresh = nextInvoiceNumber(db);
  assert.match(fresh, /^INV-A-\d{2}-\d{5}$/);
  assert.notEqual(fresh, 'INV-26-00041');
  db.prepare('INSERT INTO invoices (invoice_number, patient_id, total_amount) VALUES (?, ?, 1)').run(fresh, pid);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 2);
  db.close();
});

// НУМЕРАЦИЯ НЕ НАЧИНАЕТСЯ ЗАНОВО: счётчик per-year общий, буква на него не
// влияет. За 'INV-26-00041' идёт 'INV-A-26-00042', а не 'INV-A-26-00001'.
test('088: нумерация продолжается с того же места, а не с единицы', () => {
  const db = clinic();
  const year4 = db.prepare("SELECT strftime('%Y','now') AS y").get().y;
  db.prepare('INSERT INTO invoice_counters (year, next_seq) VALUES (?, 42)').run(year4);
  assert.match(nextInvoiceNumber(db), /^INV-A-\d{2}-00042$/);
  assert.match(nextInvoiceNumber(db), /^INV-A-\d{2}-00043$/, 'и дальше по одному');
  db.close();
});

// Буква — это часть личности установки. Нет её — деньги нумеровать нельзя, и
// сказать об этом надо вслух: тот же выбор, что у триггера MRN в 080, который
// РАЗБИРАЕТ регистрацию вместо выдачи карты без номера.
test('088: без буквы здания счёт не выписывается вовсе', () => {
  const db = clinic();
  db.prepare('DELETE FROM branch_identity').run();
  assert.throws(() => nextInvoiceNumber(db), /Здание не определено/,
    'номер без буквы совпал бы с номером соседа, и потерялся бы счёт, а не буква');
  db.close();
});
