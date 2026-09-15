// GEO_HARDCODE_V1 — география зашита: 14 регионов, 206 районов/городов, коды и названия на трёх языках.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { readableColumns } from '../schema-registry.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('после миграции: 7 стран, 14 регионов Узбекистана, 206 районов; коды уникальны; у каждого — uz и en', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        assert.equal(db.prepare('SELECT COUNT(*) n FROM countries').get().n, 7);
        const uz = db.prepare("SELECT id FROM countries WHERE code = 'UZ'").get();
        assert.equal(db.prepare('SELECT COUNT(*) n FROM regions WHERE country_id = ?').get(uz.id).n, 14);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM districts').get().n, 206);
        assert.equal(db.prepare('SELECT COUNT(DISTINCT code) n FROM districts').get().n, 206, 'коды районов уникальны');
        assert.equal(db.prepare("SELECT COUNT(*) n FROM districts WHERE name_uz IS NULL OR name_uz = '' OR name_en IS NULL OR name_en = '' OR code IS NULL").get().n, 0);
        assert.equal(db.prepare("SELECT COUNT(*) n FROM regions WHERE name_uz IS NULL OR code IS NULL").get().n, 0);
        const tash = db.prepare("SELECT id FROM regions WHERE name = 'город Ташкент'").get();
        assert.equal(db.prepare('SELECT COUNT(*) n FROM districts WHERE region_id = ?').get(tash.id).n, 12, 'Ташкент: 12 районов, без дублей к миграции 030');
        assert.equal(db.prepare("SELECT kind FROM districts WHERE code = 'nukus-shahri'").get().kind, 'город');
        const perRegion = db.prepare('SELECT r.name, COUNT(d.id) n FROM regions r LEFT JOIN districts d ON d.region_id = r.id WHERE r.country_id = ? GROUP BY r.id').all(uz.id);
        for (const r of perRegion) assert.ok(r.n >= 8, r.name + ': районов ' + r.n);
        for (const t of ['countries', 'regions', 'districts']) for (const c of ['name_uz', 'name_en']) assert.ok(readableColumns(t).includes(c), t + '.' + c + ' не читается');
    } finally { db.close(); }
});

test('база с пациентами и старой географией: ничего не дублируется, старые районы получают коды', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig132-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 132 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    const before = db.prepare("SELECT id FROM districts WHERE name = 'Юнусабадский район'").get().id;
    migrate(db);
    const after = db.prepare("SELECT id, code, name_uz FROM districts WHERE name = 'Юнусабадский район'").get();
    assert.equal(after.id, before, 'старая строка осталась той же (на неё могут ссылаться)');
    assert.equal(after.code, 'yunusobod');
    assert.equal(after.name_uz, 'Yunusobod tumani');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM districts').get().n, 206);
    db.close();
});
