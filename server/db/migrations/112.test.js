// FORM_003_V1 — три строки бланка 003 на титульном листе: как доставляют, каким транспортом, сколько прошло от начала болезни.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('колонки есть, по умолчанию пусты, mobility принимает только три вида и пустоту', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
        db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'admitted')").run();
        db.prepare('INSERT INTO admission_title_sheets (admission_id) VALUES (10)').run();
        const row = db.prepare('SELECT mobility, delivered_by, since_onset FROM admission_title_sheets WHERE admission_id = 10').get();
        assert.deepEqual(row, { mobility: '', delivered_by: '', since_onset: '' });
        for (const v of ['wheelchair', 'stretcher', 'walks']) db.prepare('UPDATE admission_title_sheets SET mobility = ? WHERE admission_id = 10').run(v);
        assert.throws(() => db.prepare("UPDATE admission_title_sheets SET mobility = 'car' WHERE admission_id = 10").run(), /CHECK/);
    } finally { db.close(); }
});

test('миграция проходит на базе с заполненными титульными листами', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig112-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 112 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'admitted')").run();
    db.prepare("INSERT INTO admission_title_sheets (admission_id, height_cm, contract_signed_at) VALUES (10, 172, '2026-09-08T10:00:00Z')").run();
    migrate(db);
    const row = db.prepare('SELECT height_cm, contract_signed_at, mobility FROM admission_title_sheets WHERE admission_id = 10').get();
    assert.deepEqual(row, { height_cm: 172, contract_signed_at: '2026-09-08T10:00:00Z', mobility: '' });
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
