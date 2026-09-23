// DOCTOR_TIER_V2 + EXTERNAL_LAB_V1 (mig 147) — ступени 2 и 3 доли врача и
// отметка «Внешняя лаборатория» на услуге. Нули = ничего не меняется.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { writableColumns, readableColumns } from '../schema-registry.js';
import { TABLES } from '../../services/branch-sync/catalogue.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));
const COLS = ['doctor_tier_from_2', 'doctor_tier_percent_2', 'doctor_tier_from_3', 'doctor_tier_percent_3', 'external_lab'];

test('147: колонки есть, NOT NULL, по умолчанию 0; реестр читает и пишет', () => {
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
        const row = db.prepare(`SELECT ${COLS.join(', ')} FROM services WHERE name = 'Приём'`).get();
        assert.deepEqual(row, Object.fromEntries(COLS.map((c) => [c, 0])));
    } finally { db.close(); }
});

test('147: все пять колонок едут с прайсом в филиалы', () => {
    const spec = TABLES.find((t) => t.name === 'services');
    for (const c of COLS) assert.ok(spec.columns.includes(c), c + ' не едет с прайсом');
});

test('147: миграция проходит на базе с услугой со ступенью и не трогает её', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig147-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 147 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO services (name, price, doctor_tier_from, doctor_tier_percent) VALUES ('Приём', 100000, 25, 40)").run();
    migrate(db);
    migrate(db);   // повторный прогон — ничего не ломает
    const row = db.prepare("SELECT doctor_tier_from, doctor_tier_percent, doctor_tier_from_2, external_lab FROM services WHERE name = 'Приём'").get();
    assert.deepEqual(row, { doctor_tier_from: 25, doctor_tier_percent: 40, doctor_tier_from_2: 0, external_lab: 0 });
    db.close();
});
