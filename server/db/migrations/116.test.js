// CASE_DOC_SET_V2 — колонка для записи СВОЕГО рода клиники.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('свой род пишется в type_kind, а колонка kind остаётся в рамках своего CHECK', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5,'doc','x','Врач','doctor')").run();
        db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
        db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'active')").run();

        // Свой род — через 'other' плюс настоящий род в новой колонке.
        db.prepare("INSERT INTO admission_reviews (admission_id, kind, type_kind, author_id) VALUES (10, 'other', 'own_11', 5)").run();
        const own = db.prepare("SELECT kind, type_kind FROM admission_reviews WHERE admission_id = 10").get();
        assert.equal(own.kind, 'other');
        assert.equal(own.type_kind, 'own_11');

        // Прежний способ записи не сломан: у встроенного рода колонка пуста.
        db.prepare("INSERT INTO admission_reviews (admission_id, kind, author_id) VALUES (10, 'primary', 5)").run();
        assert.equal(db.prepare("SELECT type_kind FROM admission_reviews WHERE kind = 'primary'").get().type_kind, null);

        // CHECK на kind ЖИВ: снимать его пересборкой таблицы мы не стали.
        assert.throws(() => db.prepare("INSERT INTO admission_reviews (admission_id, kind, author_id) VALUES (10, 'own_11', 5)").run(),
            /CHECK/, 'свой род нельзя класть прямо в kind — на то и вторая колонка');
    } finally { db.close(); }
});

test('миграция проходит на базе с уже написанными записями и ничего в них не меняет', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig116-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 116 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5,'doc','x','Врач','doctor')").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'active')").run();
    db.prepare("INSERT INTO admission_reviews (admission_id, kind, author_id, published_at, objective) VALUES (10, 'primary', 5, '2026-09-08T11:00:00Z', '<p>Осмотрен</p>')").run();

    migrate(db);

    const row = db.prepare("SELECT kind, type_kind, objective, published_at FROM admission_reviews WHERE admission_id = 10").get();
    assert.equal(row.kind, 'primary', 'род написанной записи переписан миграцией');
    assert.equal(row.type_kind, null, 'у старой записи новая колонка пуста, и это правильно');
    assert.equal(row.objective, '<p>Осмотрен</p>');
    assert.ok(row.published_at);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
