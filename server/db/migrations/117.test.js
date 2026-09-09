// CASE_DOC_FREE_SEC_V1 — колонка под свои разделы документа истории болезни.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('свои разделы и переименованные подписи хранятся с САМОЙ записью', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5,'doc','x','Врач','doctor')").run();
        db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
        db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'active')").run();

        const layout = JSON.stringify({
            titles: { complaints: 'Жалобы пациента' },
            extra: [{ title: 'Осмотр стопы', html: '<p>Пульсация сохранена</p>' }],
        });
        db.prepare("INSERT INTO admission_reviews (admission_id, kind, author_id, sections_json) VALUES (10, 'primary', 5, ?)").run(layout);

        const back = JSON.parse(db.prepare('SELECT sections_json FROM admission_reviews WHERE admission_id = 10').get().sections_json);
        assert.equal(back.titles.complaints, 'Жалобы пациента');
        assert.equal(back.extra[0].title, 'Осмотр стопы');

        // Документ БЕЗ своих разделов ничем не отличается от прежних: колонка пуста.
        db.prepare("INSERT INTO admission_reviews (admission_id, kind, author_id) VALUES (10, 'round', 5)").run();
        assert.equal(db.prepare("SELECT sections_json FROM admission_reviews WHERE kind = 'round'").get().sections_json, null);
    } finally { db.close(); }
});

test('миграция проходит на базе с уже написанными записями и ничего в них не меняет', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig117-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 117 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5,'doc','x','Врач','doctor')").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'active')").run();
    db.prepare("INSERT INTO admission_reviews (admission_id, kind, author_id, published_at, objective) VALUES (10, 'primary', 5, '2026-09-08T11:00:00Z', '<p>Осмотрен</p>')").run();

    migrate(db);

    const row = db.prepare("SELECT kind, objective, published_at, sections_json FROM admission_reviews WHERE admission_id = 10").get();
    assert.equal(row.kind, 'primary');
    assert.equal(row.objective, '<p>Осмотрен</p>', 'написанное миграцией не тронуто');
    assert.ok(row.published_at);
    assert.equal(row.sections_json, null, 'у старой записи новая колонка пуста, и это правильно');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
