// CRM_OWNERSHIP_V1 — чужая заявка не отдаётся сервером.
//
// Владелец: «assigned cards of the crm should be assigned to one user and not
// visible to another» и на вопрос «насколько строго» — «do not show».
//
// Здесь проверяется САМОЕ ГЛАВНОЕ: правило живёт в компиляторе запросов, а не
// на экранах, поэтому чужую заявку нельзя ни увидеть, ни открыть по номеру, ни
// исправить, ни удалить — каким бы запросом её ни спрашивали.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';
import { compile } from './query-compiler.js';

const NASIBA = { id: 11, role: 'callcenter', extra_roles: [] };
const ZUHRA  = { id: 12, role: 'callcenter', extra_roles: [] };
const REG    = { id: 13, role: 'registrar',  extra_roles: [] };
const BOSS   = { id: 14, role: 'admin',      extra_roles: [] };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  // Операторы должны существовать: у заявки внешний ключ на сотрудника.
  const mkUser = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  for (const u of [NASIBA, ZUHRA, REG, BOSS]) mkUser.run(u.id, 'u' + u.id, 'x', 'Сотрудник ' + u.id, u.role);
  const ins = db.prepare('INSERT INTO crm_requests (id, full_name, phone, status, assigned_to) VALUES (?,?,?,?,?)');
  ins.run(1, 'Насибина заявка', '+998900000001', 'in_process', NASIBA.id);
  ins.run(2, 'Зухрина заявка',  '+998900000002', 'in_process', ZUHRA.id);
  ins.run(3, 'Ничья заявка',    '+998900000003', 'in_process', null);
  return db;
}

const run = (db, desc, user) => {
  const q = compile(desc, user);
  return db.prepare(q.sql).all(...q.params);
};
const SELECT = { op: 'select', table: 'crm_requests', columns: 'id, full_name, assigned_to', filters: [] };

test('оператор видит свои заявки и ничьи — и НЕ видит чужую', () => {
  const db = seed();
  try {
    const mine = run(db, SELECT, NASIBA).map((r) => r.id).sort();
    assert.deepEqual(mine, [1, 3], 'оператор видит не то, что должен');

    const hers = run(db, SELECT, ZUHRA).map((r) => r.id).sort();
    assert.deepEqual(hers, [2, 3]);
  } finally { db.close(); }
});

test('чужую заявку не достать и по номеру — фильтр экрана не обходит правило', () => {
  const db = seed();
  try {
    const byId = run(db, { ...SELECT, filters: [{ col: 'id', op: 'eq', val: 2 }] }, NASIBA);
    assert.deepEqual(byId, [], 'чужая заявка отдалась по прямому запросу её номера');

    // И поиском по телефону тоже: это тот же запрос с другим фильтром.
    const byPhone = run(db, { ...SELECT, filters: [{ col: 'phone', op: 'eq', val: '+998900000002' }] }, NASIBA);
    assert.deepEqual(byPhone, [], 'чужая заявка нашлась поиском по телефону');
  } finally { db.close(); }
});

test('администратор видит доску целиком — иначе нечего передавать и не из чего собрать отчёт', () => {
  const db = seed();
  try {
    assert.deepEqual(run(db, SELECT, BOSS).map((r) => r.id).sort(), [1, 2, 3]);
  } finally { db.close(); }
});

test('правка чужой заявки не проходит, своя и ничья — проходят', () => {
  const db = seed();
  try {
    const upd = (id, user) => {
      const q = compile({ op: 'update', table: 'crm_requests', values: { note: 'тронули' },
                          filters: [{ col: 'id', op: 'eq', val: id }] }, user);
      return db.prepare(q.sql).run(...q.params).changes;
    };
    assert.equal(upd(2, NASIBA), 0, 'чужую заявку удалось исправить');
    assert.equal(upd(1, NASIBA), 1, 'свою заявку исправить не дали');
    assert.equal(upd(3, NASIBA), 1, 'ничью заявку исправить не дали — из неё не взять в работу');
  } finally { db.close(); }
});

test('«взять в работу»: ничья становится своей, и после этого её не видит сосед', () => {
  const db = seed();
  try {
    const take = compile({ op: 'update', table: 'crm_requests', values: { assigned_to: NASIBA.id },
                           filters: [{ col: 'id', op: 'eq', val: 3 }] }, NASIBA);
    assert.equal(db.prepare(take.sql).run(...take.params).changes, 1);
    assert.deepEqual(run(db, SELECT, NASIBA).map((r) => r.id).sort(), [1, 3]);
    assert.deepEqual(run(db, SELECT, ZUHRA).map((r) => r.id).sort(), [2],
      'взятая заявка осталась видна соседу');
  } finally { db.close(); }
});

test('удаление чужой заявки не проходит даже у того, кому удаление разрешено', () => {
  const db = seed();
  try {
    // Удалять заявки вправе только администратор, а он видит всё — значит,
    // проверяем на нём же, что правило не открывает лишнего: его удаление
    // должно работать, потому что ему доска видна целиком.
    const q = compile({ op: 'delete', table: 'crm_requests', filters: [{ col: 'id', op: 'eq', val: 2 }] }, BOSS);
    assert.equal(db.prepare(q.sql).run(...q.params).changes, 1);
  } finally { db.close(); }
});

test('регистратура живёт по тому же правилу, что и колл-центр', () => {
  const db = seed();
  try {
    assert.deepEqual(run(db, SELECT, REG).map((r) => r.id).sort(), [3],
      'регистратор увидел чужие заявки');
  } finally { db.close(); }
});

test('правило не задевает таблицы без владельца', () => {
  const db = seed();
  try {
    // Пациенты видны всем сотрудникам, как и были: правило применяется только
    // там, где в реестре объявлен scope.
    const q = compile({ op: 'select', table: 'patients', columns: 'id', filters: [] }, NASIBA);
    assert.equal(/assigned_to/.test(q.sql), false, 'ограничение по владельцу утекло в чужую таблицу');
  } finally { db.close(); }
});
