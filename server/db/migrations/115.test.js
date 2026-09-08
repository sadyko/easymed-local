// CASE_DOC_SET_V2 — состав истории болезни в базе, а не в коде.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('встроенный набор засеян тем же составом и в том же порядке, что был константой', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const rows = db.prepare('SELECT kind, title, due_rule, due_hours, block, builtin, active FROM case_doc_types ORDER BY sort_order').all();
        assert.deepEqual(rows.map((r) => r.kind),
            ['intake', 'anesthesia', 'preop', 'head_review', 'primary', 'rationale', 'operation', 'round', 'interim', 'discharge'],
            'порядок встроенного набора разошёлся с прежней константой');
        assert.ok(rows.every((r) => r.builtin === 1 && r.active === 1), 'встроенные роды должны быть встроенными и включёнными');

        const by = new Map(rows.map((r) => [r.kind, r]));
        assert.equal(by.get('intake').due_rule, 'clock');
        assert.equal(by.get('intake').due_hours, 2);
        assert.equal(by.get('round').due_rule, 'period');
        assert.equal(by.get('discharge').due_rule, 'at_discharge');
        assert.equal(by.get('discharge').due_hours, null, 'у выписного эпикриза часов не бывает');
        for (const k of ['anesthesia', 'preop', 'operation']) {
            assert.equal(by.get(k).block, 'surgical', k + ' выпал из хирургического блока');
        }
        assert.ok(rows.every((r) => r.title === ''), 'у встроенного рода имя переводится на экране, а не хранится');
    } finally { db.close(); }
});

test('свой род клиники: имя обязательно, правило срока — из четырёх, kind не повторяется', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        db.prepare("INSERT INTO case_doc_types (kind, title, due_rule, due_hours, sort_order) VALUES ('anesth_list','Лист анестезиолога','surgical',12,25)").run();
        const own = db.prepare("SELECT * FROM case_doc_types WHERE kind = 'anesth_list'").get();
        assert.equal(own.builtin, 0, 'свой род не может притвориться встроенным по умолчанию');
        assert.equal(own.active, 1);
        assert.ok(own.created_at);

        // Без срока — законное правило: документ в наборе, но не «просрочен».
        db.prepare("INSERT INTO case_doc_types (kind, title, due_rule, sort_order) VALUES ('partogram','Партограмма','none',35)").run();
        assert.equal(db.prepare("SELECT due_hours FROM case_doc_types WHERE kind = 'partogram'").get().due_hours, null);

        assert.throws(() => db.prepare("INSERT INTO case_doc_types (kind, due_rule) VALUES ('x','asap')").run(), /CHECK/,
            'выдуманное правило срока — это новая арифметика, а не строка справочника');
        assert.throws(() => db.prepare("INSERT INTO case_doc_types (kind) VALUES ('intake')").run(), /UNIQUE/,
            'два рода с одним kind развалили бы ссылки написанных записей');
        assert.throws(() => db.prepare("INSERT INTO case_doc_types (kind, active) VALUES ('y', 7)").run(), /CHECK/);
    } finally { db.close(); }
});

test('миграция проходит на базе с уже написанными записями истории болезни', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig115-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 115 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5,'doc','x','Врач','doctor')").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status, admitted_at) VALUES (10, 1, 'active', '2026-09-08T10:00:00Z')").run();
    db.prepare("INSERT INTO admission_reviews (admission_id, kind, author_id, published_at) VALUES (10, 'intake', 5, '2026-09-08T11:00:00Z')").run();

    migrate(db);

    // Написанная запись НЕ ТРОНУТА и продолжает находиться своим родом.
    const kept = db.prepare("SELECT kind, published_at FROM admission_reviews WHERE admission_id = 10").get();
    assert.equal(kept.kind, 'intake', 'род написанной записи переписан миграцией');
    assert.ok(kept.published_at);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM case_doc_types WHERE kind = 'intake'").get().n, 1,
        'род написанной записи пропал из набора');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
