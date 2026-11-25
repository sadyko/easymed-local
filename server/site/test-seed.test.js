// WEBSITE_V1 — засев тестов сайта: показанный врач и показанная услуга по
// ПРАВИЛАМ ПРОФИЛЯ (те же функции, что у Symptex), а не строкой website_*.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seedDoctor, seedService } from '../test-helpers/site-seed.js';
import { publicDoctors } from '../services/api/snapshot.js';
import { servicePublicState } from '../../public/js/shared/service-public.js';

test('seedDoctor({shown:true}) — врач показан по правилам профиля; shown:false — скрыт', () => {
  const db = openDb(':memory:'); migrate(db);
  const a = seedDoctor(db, { ru: 'Иванов Иван', uz: 'Ivanov Ivan', specialty: 'Кардиолог', shown: true });
  const b = seedDoctor(db, { ru: 'Петров Пётр', specialty: 'Терапевт', shown: false });
  const ids = publicDoctors(db).map((u) => u.id);
  assert.ok(ids.includes(a)); assert.ok(!ids.includes(b));
  db.close();
});

test('seedService({shown:true}) — услуга показана; shown:false — нет', () => {
  const db = openDb(':memory:'); migrate(db);
  const a = seedService(db, { ru: 'УЗИ', uz: 'UZI', price: 100000, shown: true });
  const b = seedService(db, { ru: 'Анализ', uz: 'Tahlil', price: 5000, shown: false });
  const row = (id) => db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  assert.equal(servicePublicState(row(a)), 'shown');
  assert.notEqual(servicePublicState(row(b)), 'shown');
  db.close();
});