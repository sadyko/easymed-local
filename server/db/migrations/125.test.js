// FACILITY_PLAN_V1 — координаты помещений на плане и оборудование.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('у помещений есть координаты плана, у клиники — оборудование и его размещение', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const fid = db.prepare("INSERT INTO floors (name, level) VALUES ('1 этаж', 1)").run().lastInsertRowid;
        const rid = db.prepare("INSERT INTO rooms (name, floor_id, plan_x, plan_y, plan_w, plan_h) VALUES ('Кабинет 101', ?, 32, 48, 176, 96)").run(fid).lastInsertRowid;
        const wid = db.prepare("INSERT INTO wards (name, floor_id) VALUES ('Палата 1', ?)").run(fid).lastInsertRowid;
        const eid = db.prepare("INSERT INTO equipment (name) VALUES ('ЭКГ')").run().lastInsertRowid;
        db.prepare('INSERT INTO room_equipment (room_id, equipment_id, quantity) VALUES (?, ?, 2)').run(rid, eid);
        db.prepare('INSERT INTO room_equipment (ward_id, equipment_id) VALUES (?, ?)').run(wid, eid);

        const room = db.prepare('SELECT plan_x, plan_y, plan_w, plan_h FROM rooms WHERE id = ?').get(rid);
        assert.deepEqual(room, { plan_x: 32, plan_y: 48, plan_w: 176, plan_h: 96 });
        const ward = db.prepare('SELECT plan_x, plan_w FROM wards WHERE id = ?').get(wid);
        assert.deepEqual(ward, { plan_x: 0, plan_w: 0 }, 'палата без координат — «не размещена», а не «в углу»');
        assert.equal(db.prepare('SELECT COUNT(*) n FROM room_equipment').get().n, 2);
        // Удалили кабинет — его оборудование не висит в воздухе.
        db.prepare('DELETE FROM rooms WHERE id = ?').run(rid);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM room_equipment WHERE room_id IS NOT NULL').get().n, 0);
        assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally { db.close(); }
});

test('миграция проходит на базе с уже заведёнными помещениями и ничего в них не меняет', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig125-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 125 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    const fid = db.prepare("INSERT INTO floors (name, level) VALUES ('2 этаж', 2)").run().lastInsertRowid;
    db.prepare("INSERT INTO rooms (name, code, room_type, floor_id) VALUES ('Кабинет 205', '205', 'consultation', ?)").run(fid);

    migrate(db);

    const row = db.prepare('SELECT name, code, room_type, floor_id, plan_x, plan_w FROM rooms').get();
    assert.equal(row.name, 'Кабинет 205');
    assert.equal(row.code, '205');
    assert.equal(row.room_type, 'consultation');
    assert.equal(row.floor_id, fid);
    assert.equal(row.plan_x, 0, 'у старого помещения координат нет — экран разложит его сам');
    assert.equal(row.plan_w, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('equipment','room_equipment')").get().n, 2);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
});
