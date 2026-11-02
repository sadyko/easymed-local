// LAST_VISIT_TRUE_V1 — «последний визит» — последний СОСТОЯВШИЙСЯ (≤ сегодня,
// не отменён, не «не пришёл»), «ближайшая запись» — отдельно, «визитов» —
// только состоявшиеся. День — МЕСТНЫЙ: клиника в UTC+5.
//
// Часовой пояс задаётся явно и ДО первого запроса к базе (SQLite берёт
// 'localtime' у среды процесса), а «сегодня» прибито аргументом — тест не
// зависит ни от машины, ни от того, что сейчас полночь.
process.env.TZ = 'UZT-5';

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { openDb } = await import('../../db/connection.js');
const { migrate } = await import('../../db/migrate.js');
const { patientVisitSummary } = await import('./visit-summary.js');

const TODAY = '2026-11-02';

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  for (const id of [1, 2, 3, 4]) db.prepare('INSERT INTO patients (id, full_name) VALUES (?, ?)').run(id, 'П' + id);
  return db;
}
const visit = (db, pid, at, status = 'scheduled') =>
  db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?)').run(pid, at, status);

test('будущие, отменённые и неявки не входят; ближайшая запись — отдельно', () => {
  const db = freshDb();
  try {
    visit(db, 1, '2026-10-20T05:00:00Z', 'arrived');     // 20.10 — состоялся
    visit(db, 1, '2026-10-25T05:00:00Z', 'cancelled');   // отменён
    visit(db, 1, '2026-10-28T05:00:00Z', 'no_show');     // не пришёл
    visit(db, 1, '2026-11-02T18:59:00Z');                // 02.11 23:59 местного — СЕГОДНЯ, состоялся
    visit(db, 1, '2026-11-02T20:00:00Z', 'cancelled');   // 03.11 01:00 — отменённая запись не «ближайшая»
    visit(db, 1, '2026-11-03T04:00:00Z');                // 03.11 09:00 — ближайшая запись
    visit(db, 1, '2026-11-10T04:00:00Z');                // 10.11 — дальше
    const s = patientVisitSummary(db, [1], { today: TODAY }).get(1);
    assert.equal(s.visit_count, 2, 'визитов — только состоявшиеся: 20.10 и сегодня');
    assert.equal(Date.parse(s.last_visit), Date.parse('2026-11-02T18:59:00Z'), 'последний визит — не будущая запись');
    assert.equal(s.last_visit_day, '2026-11-02');
    assert.equal(Date.parse(s.next_visit), Date.parse('2026-11-03T04:00:00Z'), 'ближайшая запись — не отменённая');
    assert.equal(s.next_visit_day, '2026-11-03');
  } finally { db.close(); }
});

test('визит в 19:00Z — следующий МЕСТНЫЙ день (00:00 по Ташкенту), а не сегодняшний', () => {
  const db = freshDb();
  try {
    visit(db, 2, '2026-11-02T19:00:00.000Z');            // 03.11 00:00 местного
    visit(db, 3, '2026-11-02T18:59:59Z');                // 02.11 23:59:59 местного
    const m = patientVisitSummary(db, [2, 3], { today: TODAY });
    assert.deepEqual([m.get(2).visit_count, m.get(2).last_visit, m.get(2).next_visit_day], [0, null, '2026-11-03']);
    assert.equal(Date.parse(m.get(2).next_visit), Date.parse('2026-11-02T19:00:00Z'), 'время приходит как было, в UTC');
    assert.deepEqual([m.get(3).visit_count, m.get(3).last_visit_day, m.get(3).next_visit], [1, '2026-11-02', null]);
  } finally { db.close(); }
});

test('пациент без визитов — нули; мусор в списке и пустой список — без ошибок', () => {
  const db = freshDb();
  try {
    const m = patientVisitSummary(db, [4, '4', 0, -1, 'x', null], { today: TODAY });
    assert.deepEqual([...m.keys()], [4]);
    assert.deepEqual(m.get(4), { visit_count: 0, last_visit: null, last_visit_day: null, next_visit: null, next_visit_day: null });
    assert.equal(patientVisitSummary(db, [], { today: TODAY }).size, 0);
    assert.throws(() => patientVisitSummary(db, [4], { today: '02.11.2026' }), /YYYY-MM-DD/);
  } finally { db.close(); }
});
