// V3120_FIX (мигр. 202) — запись закрытого месяца хранит партнёров: у
// pay_periods флаг partners (по умолчанию 0 — старые месяцы), у строк — source_id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('202: pay_periods.partners (0 по умолчанию) и pay_period_lines.source_id', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const pcols = db.prepare('PRAGMA table_info(pay_periods)').all().map((c) => c.name);
    const lcols = db.prepare('PRAGMA table_info(pay_period_lines)').all().map((c) => c.name);
    assert.ok(pcols.includes('partners'));
    assert.ok(lcols.includes('source_id'));
    db.prepare("INSERT INTO pay_periods (month) VALUES ('2026-01')").run();
    assert.equal(db.prepare("SELECT partners FROM pay_periods WHERE month = '2026-01'").get().partners, 0);
    db.prepare(`INSERT INTO pay_period_lines (month, doctor_id, source_id, kind, line_key, date, fee, data)
                VALUES ('2026-01', NULL, 7, 'ref', 'ref:1', '2026-01-05', 10, '{}')`).run();
    assert.equal(db.prepare('SELECT source_id FROM pay_period_lines').get().source_id, 7);
  } finally { db.close(); }
});
