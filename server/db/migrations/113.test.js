// ADMITTING_DOCTOR_V1 — колонка приёмного врача у госпитализации.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('колонка есть, по умолчанию пуста и ссылается на сотрудников', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (5,'doc','x','Врач','doctor',1)").run();
        db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
        db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'admitted')").run();
        assert.equal(db.prepare('SELECT admitting_doctor_id FROM admissions WHERE id = 10').get().admitting_doctor_id, null);
        db.prepare('UPDATE admissions SET admitting_doctor_id = 5 WHERE id = 10').run();
        assert.equal(db.prepare('SELECT admitting_doctor_id FROM admissions WHERE id = 10').get().admitting_doctor_id, 5);
        assert.throws(() => db.prepare('UPDATE admissions SET admitting_doctor_id = 999 WHERE id = 10').run(), /FOREIGN KEY/);
    } finally { db.close(); }
});

test('миграция проходит на базе с лежащими пациентами', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig113-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 113 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status, admitted_at) VALUES (10, 1, 'active', '2026-09-08T10:00:00Z')").run();
    migrate(db);
    const row = db.prepare('SELECT status, admitting_doctor_id FROM admissions WHERE id = 10').get();
    assert.deepEqual(row, { status: 'active', admitting_doctor_id: null });
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
