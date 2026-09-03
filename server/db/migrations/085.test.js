// 085.test.js — LAB_ONE_CLINIC_V1: настройка «кого обслуживает лаборатория».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('085: по умолчанию лаборатория обслуживает ВСЮ КЛИНИКУ', () => {
  const db = fresh();
  const row = db.prepare('SELECT lab_scope FROM doc_settings WHERE id = 1').get();
  assert.equal(row.lab_scope, 'clinic',
    'владелец просил одну лабораторию на клинику — значит это и есть состояние «из коробки»');
  db.close();
});

test('085: клиника с двумя настоящими лабораториями может вернуть прежнюю границу', () => {
  const db = fresh();
  db.prepare("UPDATE doc_settings SET lab_scope = 'building' WHERE id = 1").run();
  assert.equal(db.prepare('SELECT lab_scope FROM doc_settings WHERE id = 1').get().lab_scope, 'building');
  db.close();
});

test('085: третьего значения не существует — иначе очередь молча опустеет', () => {
  const db = fresh();
  assert.throws(
    () => db.prepare("UPDATE doc_settings SET lab_scope = 'branch' WHERE id = 1").run(),
    /CHECK/,
    'база обязана отказать: опечатка в настройке не должна превращаться в третье поведение');
  assert.throws(
    () => db.prepare('UPDATE doc_settings SET lab_scope = NULL WHERE id = 1').run(),
    /NOT NULL/);
  db.close();
});
