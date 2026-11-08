// REFERRAL_RATE_CAP_V1 (3.22.0, ревью) — особая ставка источника за услугу
// (referral_sources.service_rates, REFERRAL_SERVICE_RATES_V1): процент — от 0 до 100,
// сумма — не меньше нуля. Проверка — в двери /api/db, какой бы экран ни писал:
// прежде «250» вместо «25» сохранялось и платило в десять раз больше. Настоящее
// приложение и настоящие сессии (стенд crm-unify-app.js: boss — администратор).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp } from '../test-helpers/crm-unify-app.js';

const ratesOf = (db, id) => JSON.parse(db.prepare('SELECT service_rates s FROM referral_sources WHERE id = ?').get(id).s || '[]');

test('особая ставка: процент больше 100 или меньше 0 и отрицательная сумма — 400 словами; вставка и правка', async () => {
  const t = await startCrmApp();
  try {
    const insert = (service_rates) => t.dbq('boss', { table: 'referral_sources', op: 'insert', values: { name: 'Партнёр', service_rates } });
    for (const [bad, msg] of [
      [[{ service_id: 30, unit: 'pct', value: 250 }], 'Особая ставка в процентах — от 0 до 100.'],
      [[{ service_id: 30, unit: 'pct', value: -1 }], 'Особая ставка в процентах — от 0 до 100.'],
      [[{ service_id: 30, unit: 'fix', value: -5000 }], 'Особая ставка суммой не может быть меньше нуля.'],
    ]) {
      const before = t.db.prepare('SELECT COUNT(*) n FROM referral_sources').get().n;
      const r = await insert(bad);
      assert.equal(r.status, 400, JSON.stringify(bad) + ' → ' + r.text);
      assert.equal(r.json.error && r.json.error.message, msg);
      assert.equal(t.db.prepare('SELECT COUNT(*) n FROM referral_sources').get().n, before, 'строка не записана');
    }
    const ok = await insert([{ service_id: 30, unit: 'pct', value: 100 }, { service_id: 40, unit: 'fix', value: 70000 }]);
    assert.equal(ok.status, 200, ok.text);
    const id = t.db.prepare("SELECT MAX(id) id FROM referral_sources WHERE name = 'Партнёр'").get().id;

    const update = (service_rates) => t.dbq('boss', { table: 'referral_sources', op: 'update', values: { service_rates },
      filters: [{ col: 'id', op: 'eq', val: id }] });
    const bad = await update([{ service_id: 30, unit: 'pct', value: 101 }]);
    assert.equal(bad.status, 400, bad.text);
    assert.deepEqual(ratesOf(t.db, id), [{ service_id: 30, unit: 'pct', value: 100 }, { service_id: 40, unit: 'fix', value: 70000 }], 'прежние ставки целы');
    const good = await update([{ service_id: 30, unit: 'pct', value: 25 }]);
    assert.equal(good.status, 200, good.text);
    assert.deepEqual(ratesOf(t.db, id), [{ service_id: 30, unit: 'pct', value: 25 }]);
    // Правка без ставок не проверяет их вовсе.
    const rename = await t.dbq('boss', { table: 'referral_sources', op: 'update', values: { name: 'Партнёр 2' }, filters: [{ col: 'id', op: 'eq', val: id }] });
    assert.equal(rename.status, 200, rename.text);
  } finally { t.close(); }
});
