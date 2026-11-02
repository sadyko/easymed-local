// REPEAT_VISIT_V1 — «Записи вперёд»: свои записи врача на 30 дней вперёд, с
// завтрашнего МЕСТНОГО дня. Часовой пояс задан явно (UTC+5, до первого
// запроса к базе), «сегодня» прибито аргументом — тест не зависит ни от
// машины, ни от полуночи.
process.env.TZ = 'UZT-5';

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { openDb } = await import('../../db/connection.js');
const { migrate } = await import('../../db/migrate.js');
const { doctorUpcomingVisits } = await import('./doctor-upcoming.js');
const { RPC } = await import('./index.js');
const { isReadOnlyRpc } = await import('../control/gate.js');

const TODAY = '2026-11-02';
const DOC = { id: 10, role: 'doctor', extra_roles: [] };
const DOC2 = { id: 11, role: 'doctor', extra_roles: [] };

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'reg', 'x', 'Регистратор', 'registrar', 0);
  u.run(10, 'doc', 'x', 'Иванов Иван', 'doctor', 1);
  u.run(11, 'doc2', 'x', 'Петров Пётр', 'doctor', 1);
  u.run(12, 'adm', 'x', 'Алиева Алия', 'admin', 1);   // ADMIN_DOCTOR_V1 — администратор, который ведёт приём
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (77, 'Пациент Один', 'P-77'), (78, 'Пациент Два', 'P-78')").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active) VALUES (6, 'Повторный', 'Повторный приём', 60000, 1, 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (31, 'УЗИ почек', 90000, 'imaging')").run();
  return db;
}
const visit = (db, { pid = 77, doc = 10, at, status = 'scheduled', kind = 'first', origin = null }) =>
  Number(db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status, visit_kind, sync_origin) VALUES (?,?,?,?,?,?)')
    .run(pid, doc, at, status, kind, origin).lastInsertRowid);
const line = (db, vid, { doc = 10, ct = null, svc = null, status = 'added' } = {}) =>
  db.prepare('INSERT INTO visit_services (visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,?,1,0,0,?)')
    .run(vid, svc, ct, doc, status);

test('свои записи с завтрашнего местного дня на 30 дней; сегодняшние, отменённые, чужие и чужого здания — нет', () => {
  const db = freshDb();
  try {
    visit(db, { at: '2026-11-02T13:00:00Z' });                                     // сегодня 18:00 — это «Мой день»
    const midnight = visit(db, { at: '2026-11-02T19:00:00Z', kind: 'repeat' });    // 03.11 00:00 местного — уже завтра
    line(db, midnight, { ct: 6 });
    const tomorrow = visit(db, { pid: 78, at: '2026-11-03T04:00:00Z' });            // 03.11 09:00
    visit(db, { at: '2026-11-03T05:00:00Z', status: 'cancelled' });                 // отменён
    const foreign = visit(db, { pid: 78, doc: 11, at: '2026-11-04T06:00:00Z' });    // запись Петрова…
    line(db, foreign, { doc: 10, svc: 31 });                                        // …с УЗИ у Иванова — его запись тоже
    const foreignOnly = visit(db, { doc: 11, at: '2026-11-05T06:00:00Z' });         // только Петров
    line(db, foreignOnly, { doc: 10, svc: 31, status: 'cancelled' });               // снятая строка Иванова не в счёт
    visit(db, { at: '2026-11-06T06:00:00Z', origin: 'B' });                          // чужое здание
    const last = visit(db, { at: '2026-12-02T04:00:00Z' });                          // 02.12 — тридцатый день
    visit(db, { at: '2026-12-03T04:00:00Z' });                                       // 03.12 — за окном

    const out = doctorUpcomingVisits(db, { days: 30 }, DOC, { todayYmd: TODAY });
    assert.deepEqual([out.from, out.to], ['2026-11-03', '2026-12-02']);
    assert.deepEqual(out.rows.map((r) => r.visit_id), [midnight, tomorrow, foreign, last]);
    const first = out.rows[0];
    assert.deepEqual([first.day, first.time, first.visit_kind, first.patient_name, first.mrn], ['2026-11-03', '00:00', 'repeat', 'Пациент Один', 'P-77']);
    assert.deepEqual(first.what, ['Повторный приём']);
    assert.deepEqual(out.rows[2].what, ['УЗИ почек'], 'в чужой записи — только своя строка');
    assert.deepEqual(doctorUpcomingVisits(db, {}, DOC2, { todayYmd: TODAY }).rows.map((r) => r.visit_id), [foreign, foreignOnly],
      'у Петрова — только его записи');
  } finally { db.close(); }
});

test('только врачу: регистратор — отказ; администратор-врач — свои; чтение при просроченной лицензии', () => {
  const db = freshDb();
  try {
    assert.throws(() => doctorUpcomingVisits(db, {}, { id: 1, role: 'registrar' }, { todayYmd: TODAY }), (e) => e.status === 403);
    assert.deepEqual(doctorUpcomingVisits(db, {}, { id: 12, role: 'admin' }, { todayYmd: TODAY }).rows, []);
    assert.equal(typeof RPC.doctor_upcoming_visits, 'function', 'RPC не зарегистрирован');
    assert.ok(isReadOnlyRpc('doctor_upcoming_visits'), 'это чтение — кабинет показывает записи и при просроченной лицензии');
  } finally { db.close(); }
});
