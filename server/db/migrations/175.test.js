// INPATIENT_MONEY_FIX_V1 (мигр. 175) — невыставленная услуга стационара получает
// цену, которую возьмёт счёт: личную цену врача, иначе каталог. Выставленная
// строка не трогается.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createInvoiceForAdmission } from '../../services/rpc/billing.js';

const SQL = readFileSync(new URL('./175_inpatient_line_prices.sql', import.meta.url), 'utf8');

test('175: акт получает цену счёта — у выставленной строки цена прежняя', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, service_rates)
                VALUES (1,'doc','x','Хирург','doctor',?), (2,'d2','x','Без цены','doctor','[]'), (3,'d3','x','Кривой','doctor','{oops')`)
      .run(JSON.stringify([{ service_id: 1, price: 700000, pct: 10 }]));
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO services (id, name, price, type) VALUES (1,'Операция',500000,'other'), (2,'Перевязка',50000,'procedure')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (1,1,'active')").run();
    const ins = db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, quantity, unit_price, total, billable)
                            VALUES (?,1,?,?,?,?,?,1)`);
    ins.run(1, 1, 1, 2, 500000, 1000000);   // своя цена врача → 700 000 × 2
    ins.run(2, 2, 2, 1, 40000, 40000);      // врач без своей цены → каталог 50 000
    ins.run(3, 1, 3, 1, 500000, 500000);    // испорченный service_rates → каталог
    ins.run(4, 1, 1, 1, 500000, 500000);    // уйдёт в счёт до миграции
    createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [4] }, { id: 1, role: 'admin' });
    db.prepare('UPDATE admission_services SET unit_price = 1, total = 1 WHERE id = 4').run();   // след: не трогать

    db.exec(SQL);
    const row = (id) => db.prepare('SELECT unit_price, total FROM admission_services WHERE id = ?').get(id);
    assert.deepEqual({ ...row(1) }, { unit_price: 700000, total: 1400000 });
    assert.deepEqual({ ...row(2) }, { unit_price: 50000, total: 50000 });
    assert.deepEqual({ ...row(3) }, { unit_price: 500000, total: 500000 });
    assert.deepEqual({ ...row(4) }, { unit_price: 1, total: 1 }, 'выставленная строка не меняется');
  } finally { db.close(); }
});
