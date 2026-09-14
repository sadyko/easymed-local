// TELEPHONY_PROVIDERS_V1 — провайдеры телефонии кроме Binotel и происхождение звонка.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('провайдер заводится строкой, звонок помнит провайдера, удаление провайдера звонки не трогает', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const pid = db.prepare(`INSERT INTO telephony_providers (kind, name, enabled, config, secret)
            VALUES ('onlinepbx', 'Офис', 1, '{"domain":"clinic.onpbx.ru"}', '{"auth_key":"x"}')`).run().lastInsertRowid;
        db.prepare(`INSERT INTO calls (general_call_id, started_at, provider, provider_id)
            VALUES ('onlinepbx:abc', '2026-09-14T08:00:00Z', 'onlinepbx', ?)`).run(pid);
        db.prepare(`INSERT INTO calls (general_call_id, started_at) VALUES ('123', '2026-09-14T08:01:00Z')`).run();
        const rows = db.prepare('SELECT general_call_id, provider, provider_id FROM calls ORDER BY id').all();
        assert.deepEqual(rows, [
            { general_call_id: 'onlinepbx:abc', provider: 'onlinepbx', provider_id: pid },
            { general_call_id: '123', provider: 'binotel', provider_id: null },
        ]);
        db.prepare('DELETE FROM telephony_providers WHERE id = ?').run(pid);
        assert.equal(db.prepare("SELECT provider_id FROM calls WHERE general_call_id = 'onlinepbx:abc'").get().provider_id, null,
            'провайдера нет — звонок остался, ссылка снята');
        assert.throws(() => db.prepare("INSERT INTO telephony_providers (kind, name) VALUES ('skype', 'x')").run(), /CHECK/);
        assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally { db.close(); }
});

test('миграция проходит на базе со звонками Binotel и ничего в них не меняет', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig126-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 126 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number, disposition)
        VALUES ('9001', '2026-09-10T10:00:00Z', 0, '+998901234567', 'ANSWER')`).run();

    migrate(db);

    const row = db.prepare('SELECT general_call_id, external_number, disposition, provider, provider_id FROM calls').get();
    assert.equal(row.general_call_id, '9001');
    assert.equal(row.external_number, '+998901234567');
    assert.equal(row.disposition, 'ANSWER');
    assert.equal(row.provider, 'binotel', 'старый звонок — Binotel: других провайдеров не было');
    assert.equal(row.provider_id, null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='telephony_providers'").get().n, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
