// CUSTDEV_V1 — форма таблицы и выдача права.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

// Минимальный визит с пациентом — нужен, чтобы FK не мешал вставке карточки.
function seedVisit(db) {
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Тест')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-08-01T10:00:00Z', 'arrived')").run();
}

test('078 — карточка заводится со здоровыми значениями по умолчанию', () => {
  const db = fresh();
  seedVisit(db);
  db.prepare('INSERT INTO custdev_cards (visit_id, patient_id, visit_date) VALUES (1, 1, ?)')
    .run('2026-08-01T10:00:00Z');
  const row = db.prepare('SELECT * FROM custdev_cards WHERE visit_id = 1').get();
  assert.equal(row.status, 'new');
  assert.equal(row.score_registrar, 'unrated');
  assert.equal(row.score_cashier, 'unrated');
  assert.equal(row.score_doctor, 'unrated');
  assert.equal(row.comment, '');
  assert.equal(row.paid_amount, 0);
  assert.equal(row.called_at, null);
});

test('078 — одна карточка на визит, вторая невозможна по схеме', () => {
  const db = fresh();
  seedVisit(db);
  const ins = db.prepare('INSERT INTO custdev_cards (visit_id, patient_id, visit_date) VALUES (1, 1, ?)');
  ins.run('2026-08-01T10:00:00Z');
  // Именно на этом держится идемпотентность custdev_sync.
  assert.throws(() => ins.run('2026-08-01T10:00:00Z'));
});

test('078 — CHECK-и не пускают выдуманный статус и выдуманную оценку', () => {
  const db = fresh();
  seedVisit(db);
  assert.throws(() => db.prepare(
    "INSERT INTO custdev_cards (visit_id, patient_id, visit_date, status) VALUES (1, 1, 'x', 'happy')").run());
  assert.throws(() => db.prepare(
    "INSERT INTO custdev_cards (visit_id, patient_id, visit_date, score_doctor) VALUES (1, 1, 'x', 'maybe')").run());
});

test('078 — право custdev выдано владельцу и колл-центру, с разными уровнями', () => {
  const db = fresh();
  const perms = (role) => JSON.parse(
    db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);

  const admin = perms('admin');
  assert.ok(admin.sections.includes('custdev'));
  assert.equal(admin.levels.custdev, 'admin');

  const cc = perms('callcenter');
  assert.ok(cc.sections.includes('custdev'), 'без этой строки колл-центр не увидел бы Cust Dev');
  assert.equal(cc.levels.custdev, 'editor');

  // Остальным — не выдано: оценивают их, а не они.
  const reg = perms('registrar');
  assert.ok(!reg.sections.includes('custdev'));
});

test('078 — повторный накат права не задваивает', () => {
  const db = fresh();
  // migrate() отслеживает файлы по имени, поэтому прогоняем сам UPDATE ещё раз:
  // именно он должен быть защищён NOT LIKE, а не механика migrate().
  db.prepare(`UPDATE role_permissions
                 SET permissions = json_set(
                       json_insert(permissions, '$.sections[#]', 'custdev'),
                       '$.levels.custdev', 'editor')
               WHERE role = 'callcenter'
                 AND json_valid(permissions)
                 AND permissions NOT LIKE '%"custdev"%'`).run();
  const cc = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role = 'callcenter'").get().permissions);
  assert.equal(cc.sections.filter((s) => s === 'custdev').length, 1);
});
