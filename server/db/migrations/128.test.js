// HOLDINGS_V1 — остатки держателей (сотрудник / кабинет / отделение) и движение, помнящее держателя.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('одна строка на держателя и товар; чужой вид держателя не принимается', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const pid = db.prepare("INSERT INTO products (name, on_hand) VALUES ('Шприц', 100)").run().lastInsertRowid;
        db.prepare("INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES ('room', 1, ?, 10)").run(pid);
        assert.throws(() => db.prepare("INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES ('room', 1, ?, 5)").run(pid), /UNIQUE/);
        assert.throws(() => db.prepare("INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES ('cabinet', 1, ?, 5)").run(pid), /CHECK/);
        db.prepare("INSERT INTO stock_movements (product_id, kind, qty, holder_type, holder_id) VALUES (?, 'dispense', -1, 'room', 1)").run(pid);
        assert.deepEqual(db.prepare('SELECT holder_type, holder_id FROM stock_movements').get(), { holder_type: 'room', holder_id: 1 });
    } finally { db.close(); }
});

test('миграция проходит на базе с движениями склада и не трогает их', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig128-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 128 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    const pid = db.prepare("INSERT INTO products (name, on_hand) VALUES ('Шприц', 100)").run().lastInsertRowid;
    db.prepare("INSERT INTO stock_movements (product_id, kind, qty, reference_type, note) VALUES (?, 'dispense', -5, 'issue', 'Процедурный')").run(pid);

    migrate(db);

    const mv = db.prepare('SELECT qty, note, holder_type, holder_id FROM stock_movements').get();
    assert.deepEqual(mv, { qty: -5, note: 'Процедурный', holder_type: null, holder_id: null }, 'старая выдача текстом — без держателя, как и была');
    assert.equal(db.prepare('SELECT on_hand FROM products WHERE id = ?').get(pid).on_hand, 100);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='stock_holdings'").get().n, 1);
    db.close();
});
