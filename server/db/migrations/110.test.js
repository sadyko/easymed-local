// TITLE_SHEET_V1 — таблица титульного листа: одна на госпитализацию, без пересборок.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

function seedAdmission(db) {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'nurse1','x','Медсестра','nurse')").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'admitted')").run();
}

test('таблица есть, и на одну госпитализацию — один лист', () => {
    const db = fresh();
    try {
        seedAdmission(db);
        const cols = db.prepare('PRAGMA table_info(admission_title_sheets)').all().map((c) => c.name);
        for (const c of ['admission_id', 'referred_from', 'height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm',
            'pediculosis', 'sanitation', 'note', 'filled_by', 'filled_at', 'created_at', 'updated_at']) {
            assert.ok(cols.includes(c), 'нет колонки ' + c);
        }
        db.prepare("INSERT INTO admission_title_sheets (admission_id, height_cm) VALUES (10, 172)").run();
        assert.throws(() => db.prepare("INSERT INTO admission_title_sheets (admission_id) VALUES (10)").run(), /UNIQUE/);
        assert.throws(() => db.prepare("INSERT INTO admission_title_sheets (admission_id, pediculosis) VALUES (11, 'maybe')").run(), /CHECK|FOREIGN KEY/);
        assert.throws(() => db.prepare("UPDATE admission_title_sheets SET sanitation='yes' WHERE admission_id=10").run(), /CHECK/);
    } finally { db.close(); }
});

test('миграция проходит на базе, где уже лежат пациенты со ссылками', () => {
    // Урок 1.1.0: пересборка таблицы при включённых внешних ключах роняет
    // запуск клиники. Здесь пересборки нет — только CREATE TABLE, — и этот
    // тест стоит сторожем, чтобы она не появилась.
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig110-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        // Всё с 110 и новее — за бортом сцены: 111 меняет ту же таблицу и без
        // 110 упала бы сама, а не проверила бы 110.
        if (parseInt(f, 10) >= 110 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    seedAdmission(db);
    db.prepare("INSERT INTO admission_reviews (admission_id, kind, diagnosis, published_at) VALUES (10,'primary','J18.9','2026-09-08T10:00:00Z')").run();
    db.prepare("INSERT INTO wards (id, name) VALUES (1,'Терапия')").run();
    db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'T-1',1,'occupied')").run();
    db.prepare('UPDATE admissions SET bed_id=1, ward_id=1 WHERE id=10').run();

    migrate(db);   // 110 (и всё новее) поверх базы со ссылками

    assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_reviews').get().n, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'миграция порвала ссылки');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='admission_title_sheets'").get().n, 1);
    db.close();
});
