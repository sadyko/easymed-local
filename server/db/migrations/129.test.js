// PATIENT_FORM_ONE_V1 · CHRONIC_REF_V1 · DISCOUNT_RULES_V1 — колонки анкеты, справочник, правила скидок.
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
const FORM_COLS = ['phone_secondary', 'language', 'passport_number', 'behavior_note', 'country', 'region', 'district', 'mahalla', 'citizenship'];

test('поля окна заведения наконец хранятся: колонки есть, вставка и правка их принимают', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const cols = db.prepare('PRAGMA table_info(patients)').all().map((c) => c.name);
        for (const c of FORM_COLS) {
            assert.ok(cols.includes(c), 'нет колонки patients.' + c);
            assert.ok(writableColumns('patients', 'insert').includes(c), c + ' не принимается при вставке');
            assert.ok(writableColumns('patients', 'update').includes(c), c + ' не принимается при правке');
            assert.ok(readableColumns('patients').includes(c), c + ' не читается');
        }
        db.prepare("INSERT INTO chronic_conditions_ref (name, code) VALUES ('Гипертония', 'I10')").run();
        assert.equal(db.prepare('SELECT COUNT(*) n FROM chronic_conditions_ref WHERE active = 1').get().n, 1);
        // Seeded categories exist (migration 011); a fresh one gets its own id.
        const catId = db.prepare("INSERT INTO patient_categories (name) VALUES ('VIP-test')").run().lastInsertRowid;
        db.prepare("INSERT INTO patient_discounts (name, percent, valid_until, category_id, service_ids) VALUES ('vip10', 10, '2026-12-31', ?, '[5,7]')").run(catId);
        const d = db.prepare('SELECT valid_from, valid_until, category_id, service_ids, note FROM patient_discounts').get();
        assert.deepEqual(d, { valid_from: null, valid_until: '2026-12-31', category_id: catId, service_ids: '[5,7]', note: '' });
        db.prepare('DELETE FROM patient_categories WHERE id = ?').run(catId);
        assert.equal(db.prepare('SELECT category_id FROM patient_discounts').get().category_id, null, 'группы нет — скидка остаётся, ссылка снята');
    } finally { db.close(); }
});

test('миграция проходит на базе с пациентами и скидками, ничего в них не меняя', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig129-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 129 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO patients (full_name, chronic_conditions) VALUES ('Иванов Иван', 'Гипертония, Астма')").run();
    db.prepare("INSERT INTO patient_discounts (name, kind, percent) VALUES ('chegirma', 'promo', 10)").run();

    migrate(db);

    const p = db.prepare('SELECT full_name, chronic_conditions, phone_secondary, citizenship FROM patients').get();
    assert.deepEqual(p, { full_name: 'Иванов Иван', chronic_conditions: 'Гипертония, Астма', phone_secondary: null, citizenship: null });
    const d = db.prepare('SELECT name, percent, valid_from, valid_until, category_id, service_ids FROM patient_discounts').get();
    assert.deepEqual(d, { name: 'chegirma', percent: 10, valid_from: null, valid_until: null, category_id: null, service_ids: '[]' }, 'старая скидка — без ограничений, как и была');
    db.close();
});
