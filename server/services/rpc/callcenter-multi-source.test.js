// CRM_MULTI_SOURCE_V1 (2026-09-29) — ОТЧЁТ КОЛЛ-ЦЕНТРА ПО НЕСКОЛЬКИМ ИСТОЧНИКАМ.
//
// Решение владельца «Both»: заявка считается в КАЖДОМ своём источнике — «по
// источникам» и «конверсия по источникам» идут через json_each по правилу
// чтения (sources, иначе [source], иначе ['other']). Итоги считаются по
// заявкам, не по сумме строк. Заявки, у которых есть только source (от звонка,
// из зеркала записи, до миграции 231), считаются как прежде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { callcenterReport } from './callcenter.js';

const ADMIN = { id: 1, role: 'admin' };
const ALL = { from: '2000-01-01', to: '2100-01-01' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (1,'a','x','admin','Administrator')").run();
  const lead = db.prepare(`INSERT INTO crm_requests (full_name, phone, source, sources, status, created_at)
                           VALUES (?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`);
  // A — «пришла из Instagram и по совету знакомых», дошла.
  lead.run('А', '998900000001', 'instagram', '["instagram","referral"]', 'came');
  // B — только source (как пишут звонок → заявка и зеркало записи), в работе.
  lead.run('Б', '998900000002', 'instagram', null, 'in_process');
  // C — заявка от АТС: только source, дошла.
  lead.run('В', '998900000003', 'telephony', null, 'came');
  // D — главный «Звонок», второй Instagram, не пришла.
  lead.run('Г', '998900000004', 'call', '["call","instagram"]', 'no_show');
  // E — повтор внутри одной заявки считается один раз.
  lead.run('Д', '998900000005', 'website', '["website","website"]', 'in_process');
  return db;
}

test('«по источникам»: заявка — в каждом своём источнике; «только source» — как прежде', () => {
  const db = seed();
  try {
    const r = callcenterReport(db, ALL, ADMIN);
    const by = Object.fromEntries(r.bySource.map((x) => [x.source, x.count]));
    assert.deepEqual(by, { instagram: 3, referral: 1, telephony: 1, call: 1, website: 1 });
    assert.equal(r.bySource[0].source, 'instagram', 'по убыванию числа заявок');
    assert.equal(r.bySource.find((x) => x.source === 'referral').label, 'Рекомендация');
    // Итог — по заявкам: сумма по источникам (7) больше числа заявок, и это не ошибка.
    assert.equal(r.kpi.total, 5);
    assert.equal(r.kpi.came, 2);
  } finally { db.close(); }
});

test('конверсия по источникам: заявка с двумя источниками и «пришли» — в обоих', () => {
  const db = seed();
  try {
    const r = callcenterReport(db, ALL, ADMIN);
    const by = Object.fromEntries(r.sourceConv.map((x) => [x.name, x]));
    assert.deepEqual([by['Instagram'].count, by['Instagram'].came], [3, 1]);
    assert.equal(by['Instagram'].came_pct, 33.3);
    assert.deepEqual([by['Рекомендация'].count, by['Рекомендация'].came, by['Рекомендация'].came_pct], [1, 1, 100]);
    assert.deepEqual([by['Телефония'].count, by['Телефония'].came], [1, 1], 'заявка от звонка считается как прежде');
    assert.deepEqual([by['Звонок'].count, by['Звонок'].came], [1, 0]);
    assert.deepEqual([by['Сайт'].count, by['Сайт'].came], [1, 0], 'повтор внутри заявки посчитан дважды');
  } finally { db.close(); }
});

test('выгрузка списка: одна заявка — одна строка, все её источники через запятую', () => {
  const db = seed();
  try {
    const r = callcenterReport(db, ALL, ADMIN);
    assert.equal(r.rows.length, 5, 'заявка с двумя источниками размножилась в выгрузке');
    const col = r.columns.indexOf('Источник');
    const byName = Object.fromEntries(r.rows.map((row) => [row[r.columns.indexOf('Имя')], row[col]]));
    assert.equal(byName['А'], 'Instagram, Рекомендация');
    assert.equal(byName['Б'], 'Instagram');
    assert.equal(byName['В'], 'Телефония');
    assert.equal(byName['Г'], 'Звонок, Instagram', 'главный источник — первым');
    assert.equal(byName['Д'], 'Сайт');
  } finally { db.close(); }
});

test('период и видимость — как прежде: вне периода заявка не считается ни в одном источнике', () => {
  const db = seed();
  try {
    db.prepare("UPDATE crm_requests SET created_at = '2020-01-15T10:00:00Z' WHERE full_name = 'А'").run();
    const r = callcenterReport(db, { from: '2020-01-01', to: '2020-01-31' }, ADMIN);
    assert.deepEqual(r.bySource.map((x) => [x.source, x.count]), [['instagram', 1], ['referral', 1]]);
    assert.equal(r.kpi.total, 1);
  } finally { db.close(); }
});
