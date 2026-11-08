// REFERRAL_SERVICE_RATES_V1 — миграция 282 (у партнёра была 273 — номер занят DISCOUNT_V2 3.22.0): особые ставки источника по услугам.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('referral_sources.service_rates: пустая строка по умолчанию, хранит JSON как есть', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO referral_sources (name) VALUES ('Партнёр')").run();
  const row = () => db.prepare("SELECT service_rates FROM referral_sources WHERE name = 'Партнёр'").get();
  assert.equal(row().service_rates, '', 'у заведённого источника особых ставок нет');
  const json = JSON.stringify([{ service_id: 7, unit: 'pct', value: 15 }]);
  db.prepare("UPDATE referral_sources SET service_rates = ? WHERE name = 'Партнёр'").run(json);
  assert.equal(row().service_rates, json);
});
