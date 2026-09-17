// CALLCENTER_SHIFT_V1 — разбор звонков по операторам: считается по журналу, а
// не по отметкам, ничего не теряет и открыт только заведующей.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telephonyOperatorStats } from './telephony.js';

const BOSS = { id: 1, role: 'admin', extra_roles: [] };
const DAY = { from: '2026-09-17T00:00:00Z', to: '2026-09-18T00:00:00Z' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension) VALUES (?,?,?,?,?,?)');
  mk.run(11, 'nasiba', 'x', 'Насиба Алиева', 'callcenter', '101');
  mk.run(12, 'zuhra',  'x', 'Зухра Мирзаева', 'callcenter', '102');
  const call = db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number,
      internal_number, billsec, disposition, source) VALUES (?,?,?,?,?,?,?,'poll')`);
  // Насиба: два исходящих, один из них с разговором 120 секунд.
  call.run('a1', '2026-09-17T09:00:00Z', 1, '+998901111111', '101', 120, 'ANSWER');
  call.run('a2', '2026-09-17T09:30:00Z', 1, '+998902222222', '101', 0,   'NOANSWER');
  // Зухра: один входящий с разговором 60 секунд.
  call.run('b1', '2026-09-17T10:00:00Z', 0, '+998903333333', '102', 60,  'ANSWER');
  // Звонок с номера, который никому не принадлежит (общая линия).
  call.run('c1', '2026-09-17T11:00:00Z', 0, '+998904444444', '900', 30,  'ANSWER');
  // Вчерашний звонок — в сегодняшнюю смену попадать не должен.
  call.run('d1', '2026-09-16T09:00:00Z', 1, '+998905555555', '101', 999, 'ANSWER');
  return db;
}

test('за смену видно, кто сколько звонил и сколько говорил', () => {
  const db = seed();
  try {
    const rows = telephonyOperatorStats(db, DAY, BOSS);
    const byName = Object.fromEntries(rows.map((r) => [r.operator_name || r.extension, r]));

    assert.equal(byName['Насиба Алиева'].calls, 2);
    assert.equal(byName['Насиба Алиева'].outgoing, 2);
    assert.equal(byName['Насиба Алиева'].answered, 1, 'недозвон посчитан как разговор');
    assert.equal(byName['Насиба Алиева'].talk_sec, 120);

    assert.equal(byName['Зухра Мирзаева'].calls, 1);
    assert.equal(byName['Зухра Мирзаева'].outgoing, 0);
    assert.equal(byName['Зухра Мирзаева'].talk_sec, 60);
  } finally { db.close(); }
});

test('звонки с ничьего номера не пропадают — иначе сумма не сойдётся с журналом', () => {
  const db = seed();
  try {
    const rows = telephonyOperatorStats(db, DAY, BOSS);
    const orphan = rows.find((r) => !r.operator_name);
    assert.ok(orphan, 'звонок с непривязанного номера потерялся из отчёта');
    assert.equal(orphan.extension, '900');
    assert.equal(rows.reduce((s, r) => s + r.calls, 0), 4, 'сумма по операторам не равна числу звонков за день');
  } finally { db.close(); }
});

test('вчерашняя смена в сегодняшнюю не попадает', () => {
  const db = seed();
  try {
    const rows = telephonyOperatorStats(db, DAY, BOSS);
    assert.equal(rows.reduce((s, r) => s + r.talk_sec, 0), 210, 'в смену затесался звонок другого дня');
  } finally { db.close(); }
});

test('отчёт о работе людей закрыт для всех, кроме заведующей', () => {
  const db = seed();
  try {
    for (const role of ['callcenter', 'registrar', 'doctor']) {
      assert.throws(() => telephonyOperatorStats(db, DAY, { id: 5, role, extra_roles: [] }),
        (e) => e.status === 403, role + ' увидел отчёт о работе коллег');
    }
  } finally { db.close(); }
});

test('без периода отчёт не строится — иначе он молча покажет всю историю', () => {
  const db = seed();
  try {
    assert.throws(() => telephonyOperatorStats(db, {}, BOSS), (e) => e.status === 400);
  } finally { db.close(); }
});
