// SERVICE_GROUPS_V1 — every service must belong to a group.
//
// Before 056 all 513 services had type_id NULL while service_types held five
// perfectly good rows. Nothing pointed at them, so the group rail in every
// picker collapsed to a single bucket and selecting a group returned an empty
// list. These tests pin the backfill and, more importantly, the invariant: no
// service may be left ungrouped, because an ungrouped service is one the doctor
// cannot find by browsing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// The mapping migration 056 applies, mirrored from TYPE_TO_GROUP_NAME in
// public/js/admin/views/service-group.js. If the two ever disagree, a
// backfilled service and a freshly-imported one land in different groups.
const EXPECTED = {
  consultation: 'Консультации',
  lab:          'Лаборатория',
  procedure:    'Процедуры',
  imaging:      'Диагностика',
  radiology:    'Лучевая диагностика',
  other:        'Хирургия',
};

function seeded() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('the six routing types all exist as service_types rows', () => {
  const db = seeded();
  for (const name of Object.values(EXPECTED)) {
    const row = db.prepare('SELECT id FROM service_types WHERE name = ?').get(name);
    assert.ok(row, `service_types is missing «${name}» — services of that type cannot be grouped`);
  }
  db.close();
});

test('no service is left without a group', () => {
  const db = seeded();
  // Reproduce the pre-056 shape: a catalogue imported with type only.
  db.prepare('UPDATE services SET type_id = NULL').run();
  db.exec(`
    INSERT INTO services (name, price, type, is_lab) VALUES
      ('Приём кардиолога', 100, 'consultation', 0),
      ('ОАК',               80, 'lab',          1),
      ('УЗИ почек',        120, 'imaging',      0),
      ('В/в инъекция',      30, 'procedure',    0),
      ('Лапароскопия',    1000, 'other',        0);
  `);
  const before = db.prepare('SELECT COUNT(*) n FROM services WHERE type_id IS NULL').get().n;
  assert.ok(before > 0, 'the test must actually start from the broken shape');

  db.exec(read056());

  const after = db.prepare('SELECT COUNT(*) n FROM services WHERE type_id IS NULL').get().n;
  assert.equal(after, 0, 'every service must resolve to a group');
  db.close();
});

test('each routing type lands in the right group', () => {
  const db = seeded();
  db.prepare('UPDATE services SET type_id = NULL').run();
  for (const [type] of Object.entries(EXPECTED)) {
    db.prepare('INSERT INTO services (name, price, type, is_lab) VALUES (?,?,?,?)')
      .run('svc-' + type, 100, type, type === 'lab' ? 1 : 0);
  }
  db.exec(read056());

  for (const [type, groupName] of Object.entries(EXPECTED)) {
    const row = db.prepare(`
      SELECT st.name AS group_name FROM services s
        JOIN service_types st ON st.id = s.type_id
       WHERE s.name = ?`).get('svc-' + type);
    assert.equal(row.group_name, groupName, `type=${type} must group as «${groupName}»`);
  }
  db.close();
});

test('a service already filed by hand keeps its group', () => {
  const db = seeded();
  const diag = db.prepare("SELECT id FROM service_types WHERE name='Диагностика'").get().id;
  // A lab service the admin deliberately moved into Диагностика.
  db.prepare("INSERT INTO services (name, price, type, is_lab, type_id) VALUES ('Особая', 1, 'lab', 1, ?)").run(diag);
  db.exec(read056());
  const row = db.prepare("SELECT type_id FROM services WHERE name='Особая'").get();
  assert.equal(row.type_id, diag, '056 must only touch NULL type_id');
  db.close();
});

test('056 is idempotent — no duplicate service_types, no regrouping', () => {
  const db = seeded();
  db.exec(read056());
  const typesAfterFirst = db.prepare('SELECT COUNT(*) n FROM service_types').get().n;
  const groupsAfterFirst = db.prepare('SELECT id, type_id FROM services ORDER BY id').all();

  db.exec(read056());
  db.exec(read056());

  assert.equal(db.prepare('SELECT COUNT(*) n FROM service_types').get().n, typesAfterFirst);
  assert.deepEqual(db.prepare('SELECT id, type_id FROM services ORDER BY id').all(), groupsAfterFirst);
  db.close();
});

test('grouping produces more than one bucket — the symptom that started this', () => {
  const db = seeded();
  db.prepare('UPDATE services SET type_id = NULL').run();
  db.exec(`
    INSERT INTO services (name, price, type, is_lab) VALUES
      ('a', 1, 'consultation', 0), ('b', 1, 'lab', 1), ('c', 1, 'imaging', 0),
      ('d', 1, 'procedure', 0),    ('e', 1, 'other', 0);
  `);
  db.exec(read056());
  const buckets = db.prepare('SELECT COUNT(DISTINCT type_id) n FROM services').get().n;
  assert.ok(buckets >= 5, `expected at least 5 distinct groups, got ${buckets}`);
  db.close();
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
function read056() {
  return fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '056_service_type_backfill.sql'), 'utf8');
}
