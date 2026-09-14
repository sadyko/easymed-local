// REPEAT_WINDOW_V1 — окно дней повторного визита: колонки есть, пустые по умолчанию, пишутся.
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

test('repeat_days_from / repeat_days_to: есть, читаются, пишутся при вставке и правке', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const cols = db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
        for (const c of ['repeat_days_from', 'repeat_days_to']) {
            assert.ok(cols.includes(c), 'нет колонки services.' + c);
            assert.ok(readableColumns('services').includes(c), c + ' не читается');
            assert.ok(writableColumns('services', 'insert').includes(c), c + ' не принимается при вставке');
            assert.ok(writableColumns('services', 'update').includes(c), c + ' не принимается при правке');
        }
    } finally { db.close(); }
});

test('услуга, настроенная до миграции, остаётся с одним окном: новые колонки пустые', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig130-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 130 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO services (name, price, price_secondary, secondary_days_from, secondary_days_to, price_repeat) VALUES ('Приём', 200000, 60000, 1, 6, 0)").run();
    migrate(db);
    const r = db.prepare('SELECT secondary_days_from, secondary_days_to, repeat_days_from, repeat_days_to FROM services WHERE name = ?').get('Приём');
    assert.deepEqual(r, { secondary_days_from: 1, secondary_days_to: 6, repeat_days_from: null, repeat_days_to: null });
    db.close();
});
