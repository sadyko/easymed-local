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

// LAST_VISIT_TRUE_V1 (ревью, minor-1) — ПРОШЕДШАЯ ЗАПИСЬ, НА КОТОРУЮ НИКТО НЕ ПРИШЁЛ,
// — НЕ ВИЗИТ. Отметку «Не пришёл» в клинике не ставит никто (crm/no-show.js двигает
// только карточку CRM), и пустая запись, перенесённая автоматикой на воскресенье,
// наутро становилась «Последним визитом». Состоялся: сегодняшний день — всегда (не
// отменён, не неявка); прошедший — только с доказательством прихода: «Пришёл»
// (status 'arrived'), строка в работе или оплаченная (queued, collected,
// in_progress, resulted, completed) или оплата по счёту визита (paid_amount > 0).
test('ревью minor-1: прошедшая запись без прихода не считается; «Пришёл», оплаченная строка, оплата и сегодня — считаются', () => {
  const db = freshDb();
  try {
    db.prepare("INSERT INTO services (id, name, price) VALUES (5, 'Приём', 100000)").run();
    const v = (pid, at, status = 'scheduled') => Number(visit(db, pid, at, status).lastInsertRowid);
    const line = (vid, status) => db.prepare('INSERT INTO visit_services (visit_id, service_id, status) VALUES (?, 5, ?)').run(vid, status);
    // 1 — пустая прошедшая запись (воскресенье, никто не пришёл) и прошедшая
    //     «подтверждённая» со строкой в смете ('added') — ни одна не визит.
    v(1, '2026-11-01T06:00:00Z');
    line(v(1, '2026-10-30T06:00:00Z', 'confirmed'), 'added');
    // 2 — «Пришёл» на прошлой неделе.
    v(2, '2026-10-26T06:00:00Z', 'arrived');
    // 3 — статус так и остался 'scheduled', но строка оплачена ('queued') — пациент был.
    line(v(3, '2026-10-27T06:00:00Z'), 'queued');
    // 4 — сегодняшняя запись (никто ещё не пришёл) — «сегодня».
    v(4, '2026-11-02T04:00:00Z');
    const m = patientVisitSummary(db, [1, 2, 3, 4], { today: TODAY });
    assert.deepEqual([m.get(1).visit_count, m.get(1).last_visit, m.get(1).last_visit_day], [0, null, null], 'пустая прошедшая запись стала визитом');
    assert.deepEqual([m.get(2).visit_count, m.get(2).last_visit_day], [1, '2026-10-26']);
    assert.deepEqual([m.get(3).visit_count, m.get(3).last_visit_day], [1, '2026-10-27'], 'оплаченная строка — доказательство прихода');
    assert.deepEqual([m.get(4).visit_count, m.get(4).last_visit_day, m.get(4).next_visit], [1, '2026-11-02', null], 'сегодняшняя запись — «сегодня»');
  } finally { db.close(); }
});

test('ревью minor-1: оплата по счёту визита и работа над услугой — приход; пустая прошлая запись не перебивает настоящий визит', () => {
  const db = freshDb();
  try {
    db.prepare("INSERT INTO services (id, name, price) VALUES (5, 'Приём', 100000)").run();
    const v = (pid, at, status = 'scheduled') => Number(visit(db, pid, at, status).lastInsertRowid);
    const line = (vid, status) => db.prepare('INSERT INTO visit_services (visit_id, service_id, status) VALUES (?, 5, ?)').run(vid, status);
    // 1 — оплачен счёт, строки ещё «в смете»: деньги у кассы — человек был.
    const paid = v(1, '2026-10-20T06:00:00Z');
    line(paid, 'added');
    db.prepare("INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status) VALUES (?, 1, 100000, 100000, 'paid')").run(paid);
    // …а неоплаченный счёт приходом не является.
    const unpaid = v(1, '2026-10-25T06:00:00Z');
    db.prepare("INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status) VALUES (?, 1, 100000, 0, 'unpaid')").run(unpaid);
    // 2 — в работе / завершено / проба / результат — каждая из работ.
    for (const [i, st] of ['in_progress', 'completed', 'collected', 'resulted'].entries()) line(v(2, `2026-10-0${i + 1}T06:00:00Z`), st);
    // 2 — позже всех: пустая запись — не последний визит.
    v(2, '2026-10-31T06:00:00Z', 'confirmed');
    // 3 — отменённый визит с оплатой (предоплата) — не визит, как и прежде.
    const pre = v(3, '2026-10-29T06:00:00Z', 'cancelled');
    db.prepare("INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status) VALUES (?, 3, 50000, 50000, 'paid')").run(pre);
    const m = patientVisitSummary(db, [1, 2, 3], { today: TODAY });
    assert.deepEqual([m.get(1).visit_count, m.get(1).last_visit_day], [1, '2026-10-20'], 'оплата — приход, неоплаченный счёт — нет');
    assert.deepEqual([m.get(2).visit_count, m.get(2).last_visit_day], [4, '2026-10-04'], 'пустая запись 31.10 перебила настоящий визит');
    assert.deepEqual([m.get(3).visit_count, m.get(3).last_visit], [0, null]);
  } finally { db.close(); }
});

// LAST_VISIT_TRUE_V1 (полировка 3.21.0, п. 16) — правило из шапки visit-summary.js: счёт, который
// вернули целиком и отменили (оплата обнулена), прошедший визит состоявшимся не делает; «Пришёл»
// или строка в работе — делают.
test('полировка п. 16: полностью возвращённый и отменённый счёт — не приход; «Пришёл» и строка в работе — приход', () => {
  const db = freshDb();
  try {
    db.prepare("INSERT INTO services (id, name, price) VALUES (5, 'Приём', 100000)").run();
    const v = (pid, at, status = 'scheduled') => Number(visit(db, pid, at, status).lastInsertRowid);
    const refunded = (vid, pid) => db.prepare("INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status) VALUES (?, ?, 100000, 0, 'refunded')").run(vid, pid);
    const line = (vid, status) => db.prepare('INSERT INTO visit_services (visit_id, service_id, status) VALUES (?, 5, ?)').run(vid, status);
    const a = v(1, '2026-10-20T06:00:00Z'); refunded(a, 1); line(a, 'added');           // ни прихода, ни работы
    const b = v(2, '2026-10-21T06:00:00Z', 'arrived'); refunded(b, 2);                    // «Пришёл»
    const c = v(3, '2026-10-22T06:00:00Z'); refunded(c, 3); line(c, 'in_progress');     // работа начата
    const m = patientVisitSummary(db, [1, 2, 3], { today: TODAY });
    assert.deepEqual([m.get(1).visit_count, m.get(1).last_visit], [0, null], 'возвращённый визит без прихода остался «последним»');
    assert.deepEqual([m.get(2).visit_count, m.get(2).last_visit_day], [1, '2026-10-21']);
    assert.deepEqual([m.get(3).visit_count, m.get(3).last_visit_day], [1, '2026-10-22']);
  } finally { db.close(); }
});
