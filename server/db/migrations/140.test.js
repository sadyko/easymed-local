// DOCTOR_TIER_V1 — ступень доли врача по объёму: порог услуг в месяц и доля
// выше порога живут на УСЛУГЕ. Нули = ступени нет, поведение прежнее.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { writableColumns, readableColumns } from '../schema-registry.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));
const COLS = ['doctor_tier_from', 'doctor_tier_percent'];

// WHERE name: migration 041 seeds its own LAB-CBC row (id -41) into a fresh
// services table, so a bare SELECT without a filter can return that seed
// row instead of the one a test just inserted. Both tests below filter on
// name = 'Приём' for this reason.

test('колонки ступени есть, по умолчанию 0, реестр их читает и пишет', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const info = db.prepare('PRAGMA table_info(services)').all();
        for (const c of COLS) {
            const col = info.find((x) => x.name === c);
            assert.ok(col, 'нет колонки services.' + c);
            assert.equal(col.notnull, 1, c + ' должна быть NOT NULL');
            assert.equal(String(col.dflt_value), '0', c + ' по умолчанию 0');
            assert.ok(readableColumns('services').includes(c), c + ' не читается');
            assert.ok(writableColumns('services', 'insert').includes(c), c + ' не принимается при вставке');
            assert.ok(writableColumns('services', 'update').includes(c), c + ' не принимается при правке');
        }
        db.prepare("INSERT INTO services (name, price) VALUES ('Приём', 100000)").run();
        const row = db.prepare("SELECT doctor_tier_from, doctor_tier_percent FROM services WHERE name = 'Приём'").get();
        assert.deepEqual(row, { doctor_tier_from: 0, doctor_tier_percent: 0 });
    } finally { db.close(); }
});

test('миграция проходит на базе с услугами и не трогает их долю по умолчанию', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig140-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 140 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO services (name, price, default_doctor_percent) VALUES ('Приём', 100000, 35)").run();

    migrate(db);
    migrate(db);   // повторный прогон — ничего не ломает

    const row = db.prepare("SELECT default_doctor_percent, doctor_tier_from, doctor_tier_percent FROM services WHERE name = 'Приём'").get();
    assert.deepEqual(row, { default_doctor_percent: 35, doctor_tier_from: 0, doctor_tier_percent: 0 });
    db.close();
});
