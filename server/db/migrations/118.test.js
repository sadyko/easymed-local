// SERVICE_ORDER_FORM_V1 — «на когда» назначена услуга: своя колонка, не performed_at.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

function seed(db) {
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'active')").run();
    db.prepare("INSERT INTO services (id, name, price) VALUES (7,'КТ грудной клетки', 850000)").run();
}

test('план и факт — РАЗНЫЕ времена, и обе колонки живут рядом', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        seed(db);
        db.prepare(`INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, planned_at)
                    VALUES (10, 7, 1, 850000, 850000, '2026-09-11T10:30:00Z')`).run();
        const row = db.prepare('SELECT planned_at, performed_at FROM admission_services WHERE admission_id = 10').get();
        assert.equal(row.planned_at, '2026-09-11T10:30:00Z', 'на когда назначено');
        assert.equal(row.performed_at, null, 'назначенное ещё не сделано — и акт не должен утверждать обратное');
    } finally { db.close(); }
});

test('миграция проходит на базе с уже начисленными строками и ничего в них не меняет', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig118-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 118 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    seed(db);
    db.prepare(`INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, performed_at, billable)
                VALUES (10, 7, 2, 850000, 1700000, '2026-09-09T08:00:00Z', 1)`).run();

    migrate(db);

    const row = db.prepare('SELECT quantity, total, performed_at, billable, planned_at FROM admission_services WHERE admission_id = 10').get();
    assert.equal(row.quantity, 2, 'начисленное миграцией не тронуто');
    assert.equal(row.total, 1700000);
    assert.equal(row.performed_at, '2026-09-09T08:00:00Z');
    assert.equal(row.billable, 1);
    assert.equal(row.planned_at, null, 'у старой строки новая колонка пуста, и это правильно');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
