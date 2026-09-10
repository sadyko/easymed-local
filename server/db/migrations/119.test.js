// DIARY_ENTRY_DATE_V1 — день, о котором запись, хранится рядом с подписью.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

function seed(db) {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5,'doc','x','Врач','doctor')").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'active')").run();
}

test('день записи и время подписи — разные колонки и разные сведения', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        seed(db);
        // Обход был девятого, запись легла утром десятого — так и пишут.
        db.prepare(`INSERT INTO admission_reviews (admission_id, kind, author_id, published_at, entry_date)
                    VALUES (10, 'round', 5, '2026-09-10T08:12:00Z', '2026-09-09')`).run();
        const row = db.prepare("SELECT published_at, entry_date FROM admission_reviews WHERE kind='round'").get();
        assert.equal(row.entry_date, '2026-09-09', 'за какой день запись');
        assert.equal(row.published_at, '2026-09-10T08:12:00Z', 'подпись задним числом не ставится');
    } finally { db.close(); }
});

test('миграция проходит на базе с написанными документами и ничего в них не меняет', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig119-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 119 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    seed(db);
    db.prepare(`INSERT INTO admission_reviews (admission_id, kind, author_id, published_at, objective)
                VALUES (10, 'round', 5, '2026-09-08T11:00:00Z', '<p>Состояние стабильное</p>')`).run();

    migrate(db);

    const row = db.prepare("SELECT objective, published_at, entry_date FROM admission_reviews WHERE kind='round'").get();
    assert.equal(row.objective, '<p>Состояние стабильное</p>', 'написанное миграцией не тронуто');
    assert.equal(row.published_at, '2026-09-08T11:00:00Z');
    assert.equal(row.entry_date, null, 'у прежней записи днём считается день публикации, и колонка пуста');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
