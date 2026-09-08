// INPATIENT_DOCS_V1 — три отметки о бумагах при поступлении на титульном листе.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('три колонки времени есть, и по умолчанию они пусты', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const cols = db.prepare('PRAGMA table_info(admission_title_sheets)').all().map((c) => c.name);
        for (const c of ['contract_signed_at', 'consent_signed_at', 'memo_given_at']) assert.ok(cols.includes(c), 'нет колонки ' + c);
        db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
        db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'admitted')").run();
        db.prepare('INSERT INTO admission_title_sheets (admission_id) VALUES (10)').run();
        const row = db.prepare('SELECT contract_signed_at, consent_signed_at, memo_given_at FROM admission_title_sheets WHERE admission_id = 10').get();
        assert.deepEqual(row, { contract_signed_at: null, consent_signed_at: null, memo_given_at: null });
    } finally { db.close(); }
});

test('миграция проходит на базе, где титульные листы уже заполнены', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig111-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (f.startsWith('111_') || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'nurse1','x','Медсестра','nurse')").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'admitted')").run();
    db.prepare("INSERT INTO admission_title_sheets (admission_id, height_cm, weight_kg, filled_by, filled_at) VALUES (10, 172, 80, 3, '2026-09-08T10:00:00Z')").run();

    migrate(db);   // 111 поверх базы с листами

    const row = db.prepare('SELECT height_cm, filled_by, contract_signed_at FROM admission_title_sheets WHERE admission_id = 10').get();
    assert.deepEqual(row, { height_cm: 172, filled_by: 3, contract_signed_at: null });
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
