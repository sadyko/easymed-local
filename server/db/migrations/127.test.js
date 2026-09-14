// VISIT_TIER_PRICING_V1 — four nullable tier columns on services, price_tier on visit_services.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('услуга без ступеней остаётся услугой с одной ценой; строка визита помнит ступень', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const id = db.prepare("INSERT INTO services (name, price) VALUES ('УЗИ', 90000)").run().lastInsertRowid;
        const row = db.prepare('SELECT price, price_secondary, secondary_days_from, secondary_days_to, price_repeat FROM services WHERE id = ?').get(id);
        assert.deepEqual(row, { price: 90000, price_secondary: null, secondary_days_from: null, secondary_days_to: null, price_repeat: null });
        db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'x')").run();
        const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (1, '2026-09-14T05:00:00Z')").run().lastInsertRowid;
        db.prepare("INSERT INTO visit_services (visit_id, service_id, price_tier) VALUES (?, ?, 'secondary')").run(vid, id);
        db.prepare('INSERT INTO visit_services (visit_id, service_id) VALUES (?, ?)').run(vid, id);
        assert.deepEqual(db.prepare('SELECT price_tier FROM visit_services ORDER BY id').all(), [{ price_tier: 'secondary' }, { price_tier: null }]);
    } finally { db.close(); }
});

test('миграция проходит на базе с услугами и визитами, ничего в них не меняя', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig127-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 127 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    const id = db.prepare("INSERT INTO services (name, price) VALUES ('Приём', 200000)").run().lastInsertRowid;
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'x')").run();
    const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (1, '2026-09-10T05:00:00Z')").run().lastInsertRowid;
    db.prepare('INSERT INTO visit_services (visit_id, service_id, unit_price, total) VALUES (?, ?, 200000, 200000)').run(vid, id);

    migrate(db);

    assert.equal(db.prepare('SELECT price FROM services WHERE id = ?').get(id).price, 200000);
    assert.equal(db.prepare('SELECT price_secondary FROM services WHERE id = ?').get(id).price_secondary, null);
    const line = db.prepare('SELECT unit_price, price_tier FROM visit_services').get();
    assert.equal(line.unit_price, 200000);
    assert.equal(line.price_tier, null, 'старые строки — без ступени: их считали одной ценой');
    db.close();
});
