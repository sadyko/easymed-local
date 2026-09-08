// VITALS_NEWS_V1 — таблица измерений показателей в стационаре.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('таблица есть: показатели могут быть пустыми, сознание — только ACVPU, ссылки на госпитализацию и сотрудника', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'nur','x','Медсестра','nurse')").run();
        db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
        db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'active')").run();
        db.prepare("INSERT INTO admission_vitals (admission_id, measured_at, temp_c, pulse_bpm, measured_by) VALUES (10, '2026-09-08T08:00:00Z', 38.1, 104, 3)").run();
        const row = db.prepare('SELECT * FROM admission_vitals WHERE admission_id = 10').get();
        assert.equal(row.spo2, null);
        assert.equal(row.on_oxygen, 0);
        assert.equal(row.consciousness, 'alert');
        assert.equal(row.note, '');
        assert.ok(row.created_at);
        assert.throws(() => db.prepare("INSERT INTO admission_vitals (admission_id, measured_at, consciousness) VALUES (10, '2026-09-08T09:00:00Z', 'sleepy')").run(), /CHECK/);
        assert.throws(() => db.prepare("INSERT INTO admission_vitals (admission_id, measured_at) VALUES (999, '2026-09-08T09:00:00Z')").run(), /FOREIGN KEY/);
    } finally { db.close(); }
});

test('миграция проходит на базе с лежащими пациентами', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig114-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 114 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status, admitted_at) VALUES (10, 1, 'active', '2026-09-08T10:00:00Z')").run();
    migrate(db);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='admission_vitals'").get().n, 1);
    assert.equal(db.prepare('SELECT status FROM admissions WHERE id = 10').get().status, 'active');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
