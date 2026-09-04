// 090.test.js — BRANCH_NUMBER_REMINT_V1, часть вторая: место, где хранится
// принятое решение о перечеканенном номере.
//
// Проверяется обещание из шапки миграции: решение живёт столько же, сколько
// строка (чисткой синхронизации не затрагивается), а удаление строки его
// уносит — иначе заведённая заново строка с тем же uid получила бы номер из
// прошлой жизни.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('090: sync_minted хранит решение поколоночно и не даёт записать его дважды', () => {
  const db = fresh();
  const cols = db.prepare("SELECT name, \"notnull\" FROM pragma_table_info('sync_minted')").all();
  const byName = new Map(cols.map((c) => [c.name, c]));
  for (const c of ['tbl', 'uid', 'col', 'src', 'value', 'at']) {
    assert.ok(byName.has(c), 'нет колонки ' + c);
  }
  for (const c of ['tbl', 'uid', 'col', 'src', 'value']) {
    assert.equal(byName.get(c).notnull, 1, c + ': решение без этой части — не решение');
  }

  const ins = db.prepare('INSERT INTO sync_minted (tbl, uid, col, src, value) VALUES (?,?,?,?,?)');
  ins.run('invoices', 'u-1', 'invoice_number', 'INV-26-00001', 'INV-26-00001-C');
  // Ключ — (tbl, uid, col): у одной колонки одной строки ровно одно решение.
  assert.throws(() => ins.run('invoices', 'u-1', 'invoice_number', 'INV-26-00001', 'INV-26-00001-D'),
    /UNIQUE|constraint/i, 'второе решение по той же колонке означало бы, что номер сменился');
  // А другая колонка той же строки — уже другое решение.
  ins.run('patients', 'u-1', 'mrn', 'P-26-00001', 'P-26-00001-C');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_minted').get().n, 2);
  db.close();
});

test('090: чистка синхронизации решение не трогает — иначе номер «поплыл» бы через квартал', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Приезжий','P-26-00001-C')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(pid).uid;
  db.prepare('INSERT INTO sync_minted (tbl, uid, col, src, value) VALUES (?,?,?,?,?)')
    .run('patients', uid, 'mrn', 'P-26-00001', 'P-26-00001-C');

  // Ровно то, что чистит приём и чистка журнала.
  db.prepare('DELETE FROM sync_journal').run();
  db.prepare('DELETE FROM sync_seen').run();
  db.prepare('DELETE FROM sync_authored').run();

  assert.equal(db.prepare('SELECT value FROM sync_minted WHERE uid = ?').get(uid).value, 'P-26-00001-C',
    'номер напечатан на карте — он не имеет права смениться, даже когда метки выселены');
  db.close();
});

test('090: удалили строку — решение ушло вместе с ней', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Приезжий','P-26-00001-C')").run().lastInsertRowid;
  const puid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(pid).uid;
  const iid = db.prepare(`INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, status)
                          VALUES ('INV-26-00001-C', ?, 1000, 1000, 'unpaid')`).run(pid).lastInsertRowid;
  const iuid = db.prepare('SELECT uid FROM invoices WHERE id = ?').get(iid).uid;
  const ins = db.prepare('INSERT INTO sync_minted (tbl, uid, col, src, value) VALUES (?,?,?,?,?)');
  ins.run('patients', puid, 'mrn', 'P-26-00001', 'P-26-00001-C');
  ins.run('invoices', iuid, 'invoice_number', 'INV-26-00001', 'INV-26-00001-C');

  // Удаление РУКАМИ из программы, а не порцией синхронизации: именно поэтому
  // чистит триггер, а не код приёма.
  db.prepare('DELETE FROM invoices WHERE id = ?').run(iid);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_minted WHERE tbl = 'invoices'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_minted WHERE tbl = 'patients'").get().n, 1,
    'счёт удалили — карта пациента ни при чём');

  db.prepare('DELETE FROM patients WHERE id = ?').run(pid);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_minted').get().n, 0);
  db.close();
});
