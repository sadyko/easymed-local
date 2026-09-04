// BUILDING_REPORTS_V1 — SQL-сторона измерения «здание».
//
// Главное, что здесь проверяется: наличие метки происхождения выясняется У
// БАЗЫ, а не предполагается. У склада и кассы её нет и не будет, у денег она
// появилась только миграцией 087, а отчёт со ссылкой на несуществующую колонку
// не вернул бы нули — он бы УПАЛ, и отчёты перестали бы открываться вовсе.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  buildingContext, buildingWhere, originExpr, hasColumn, summariseByBuilding,
  labScopeOf, labScopeWhere, ownBuildingLetter, OWN_KEY, stampLetter, normalizeLetter,
} from './buildings.js';

function db2() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();
  return db;
}

test('перечень зданий: своё по букве из branch_identity, сосед — даже с active = 0', () => {
  const db = db2();
  const ctx = buildingContext(db);
  assert.equal(ownBuildingLetter(db), 'A');
  assert.equal(ctx.ownKey, 'A');
  assert.deepEqual(ctx.options.map((o) => o.key), ['A', 'B']);
  assert.equal(ctx.label(''), 'Main Branch', 'своя строка (sync_origin NULL) — имя своей клиники');
  assert.equal(ctx.label('B'), 'Чиланзар');
  assert.equal(ctx.unattributed('B'), 'Чиланзар, врач не указан');
});

test('незнакомая буква подписывается «Филиал X» — той же формулировкой, что метки в списках', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO patients (full_name, sync_origin) VALUES ('Приехал','C')").run();
  const ctx = buildingContext(db);
  assert.equal(ctx.label('C'), 'Филиал C');
  assert.ok(ctx.options.some((o) => o.key === 'C'), 'здание, приславшее записи, названо');
});

// Склад и касса между зданиями не ездят и метки не получат НИКОГДА, а деньги
// её получили только миграцией 087 — до неё ссылка на колонку уронила бы
// каждый отчёт. Оба случая — один код: «нет метки» значит «все строки свои».
test('таблица без метки: выражение здания — своя строка, а «только сосед» = пусто', () => {
  const db = db2();
  const ctx = buildingContext(db);
  assert.equal(hasColumn(db, 'stock_movements', 'sync_origin'), false, 'склад не ездит');
  assert.equal(originExpr(db, 'stock_movements', 'sm'), "''");
  assert.equal(buildingWhere(db, ctx, { buildings: ['A'] }, 'stock_movements', 'sm').clause, '');
  assert.equal(buildingWhere(db, ctx, { buildings: ['B'] }, 'stock_movements', 'sm').clause, ' AND 1 = 0');
  // И то же самое для несуществующей таблицы — PRAGMA не должна ронять отчёт.
  assert.equal(originExpr(db, 'no_such_table', 'x'), "''");
});

test('таблица с меткой: фильтр по зданиям строится на sync_origin', () => {
  const db = db2();
  const ctx = buildingContext(db);
  assert.equal(originExpr(db, 'patients', 'p'), "COALESCE(p.sync_origin, '')");
  assert.equal(buildingWhere(db, ctx, { buildings: ['A'] }, 'patients', 'p').clause,
    ' AND (p.sync_origin IS NULL)');
  const f = buildingWhere(db, ctx, { buildings: ['B'] }, 'patients', 'p');
  assert.equal(f.clause, ' AND (p.sync_origin IN (?))');
  assert.deepEqual(f.params, ['B']);
  assert.equal(buildingWhere(db, ctx, { buildings: ['A', 'B'] }, 'patients', 'p').clause, '',
    'выбраны все = фильтра нет');
  assert.equal(buildingWhere(db, ctx, {}, 'patients', 'p').clause, '');
});

test('разрез печатает КАЖДОЕ известное здание, включая пустое', () => {
  const db = db2();
  const ctx = buildingContext(db);
  const out = summariseByBuilding(ctx, [{ origin: '', amount: 100 }], { total: (r) => r.amount });
  assert.deepEqual(out.map((b) => b.key), ['A', 'B']);
  assert.equal(out[0].total, 100);
  assert.equal(out[1].total, 0, 'ноль напротив здания и отсутствие здания читаются по-разному');
});

test('граница лаборатории берётся из doc_settings и совпадает с правилом экрана', () => {
  const db = db2();
  assert.equal(labScopeOf(db), 'clinic', 'по умолчанию — вся клиника (решение владельца, мигр. 085)');
  assert.equal(labScopeWhere(db, labScopeOf(db), 'visit_services', 'vs'), '');
  db.prepare("UPDATE doc_settings SET lab_scope = 'building' WHERE id = 1").run();
  assert.equal(labScopeOf(db), 'building');
  assert.equal(labScopeWhere(db, labScopeOf(db), 'visit_services', 'vs'), ' AND vs.sync_origin IS NULL');
  // Таблица без метки границу не получает — иначе запрос упал бы на колонке.
  assert.equal(labScopeWhere(db, 'building', 'cash_movements', 'm'), '');
});

test('база без выданной буквы не теряет своё здание', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare('DELETE FROM branch_identity').run();
  const ctx = buildingContext(db);
  assert.equal(ctx.ownKey, OWN_KEY);
  assert.equal(ctx.options[0].own, true);
  assert.equal(ctx.label(''), 'Это здание');
});

// ---------------------------------------------------------------------------
// BUILDING_FRESHNESS_V1 — буква здания из МЕТКИ синхронизации.
//
// У sync_pending отдельной колонки «чьё это» нет: буква зашита в метку
// (hlc.js — 12 hex миллисекунд, дефис, 4 hex счётчика, дефис, буква). Разобрать
// её надо ровно так же, как это делает обмен, — иначе ожидания соседнего здания
// молча приписались бы своему, то есть ровно та ошибка, ради которой писалось
// всё измерение «здание».
// ---------------------------------------------------------------------------

test('буква здания читается из метки, а мусор не выдаётся за своё здание', () => {
  assert.equal(stampLetter('0000018f0000-0000-B'), 'B');
  assert.equal(stampLetter('0000018f0000-000a-AB'), 'AB', 'буква может быть из нескольких знаков');
  assert.equal(stampLetter('0000018f0000-0000-b'), 'B', 'регистр приводится, как и везде');

  for (const bad of ['', 'мусор', null, undefined, 42, '0000018f0000-0000-', '0000018f0000-0000-Ж', 'короткая']) {
    assert.equal(stampLetter(bad), null, JSON.stringify(bad) + ' — не буква здания');
  }
});

test('правило «что считать буквой» одно на систему', () => {
  assert.equal(normalizeLetter(' b '), 'B');
  assert.equal(normalizeLetter('С'), null, 'кириллическая «С» буквой узла не является');
});
