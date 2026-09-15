// SERVICE_NAMES_ONLINE_V1 — названия на uz/en и флаг онлайн-записи: колонки есть, пусты у старых строк, пишутся.
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

test('name_uz / name_en / online_booking: есть, читаются, пишутся при вставке и правке', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const cols = db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
        for (const c of ['name_uz', 'name_en', 'online_booking']) {
            assert.ok(cols.includes(c), 'нет колонки services.' + c);
            assert.ok(readableColumns('services').includes(c), c + ' не читается');
            assert.ok(writableColumns('services', 'insert').includes(c), c + ' не принимается при вставке');
            assert.ok(writableColumns('services', 'update').includes(c), c + ' не принимается при правке');
        }
    } finally { db.close(); }
});

test('услуга, заведённая до миграции: названия на uz/en пусты, онлайн-запись выключена', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig131-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 131 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO services (name, price) VALUES ('Приём', 200000)").run();
    migrate(db);
    const r = db.prepare("SELECT name, name_uz, name_en, online_booking FROM services WHERE name = 'Приём'").get();
    assert.deepEqual(r, { name: 'Приём', name_uz: null, name_en: null, online_booking: 0 });
    db.close();
});
