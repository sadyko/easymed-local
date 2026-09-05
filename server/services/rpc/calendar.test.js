// CALENDAR_BOOKING_V1 — запись, перенос, растягивание и ЗАПРЕТ ДВОЙНОЙ ЗАПИСИ.
//
// Правило владельца (2026-09-05): «Один пациент на врача на слот — жёсткий
// запрет». Жёсткий — значит его нельзя обойти, выключив JavaScript. Поэтому
// проверяется не «экран не даёт нажать», а что ОТКАЗЫВАЕТ САМ ОБРАБОТЧИК, и
// что отказ НАЗЫВАЕТ ЗАНЯТОЕ ВРЕМЯ: регистратура стоит перед человеком, и
// «занято» без времени заставляет её тыкать в сетку наугад.
//
// Отдельно пиняется то, что запретом БЫТЬ НЕ ДОЛЖНО:
//   • стык (14:00–14:30 и 14:30–15:00) — две нормальные записи подряд;
//   • отменённая и не пришедшая запись время НЕ держат;
//   • перенос записи «на месте» не конфликтует сам с собой;
//   • у кабинета двойной занятости не запрещаем вовсе (capacity, миграция 082).
//
// Время в тестах набирается МЕСТНОЕ (new Date(y,m,d,h,mi)) и уходит в
// обработчик как ISO — ровно так же, как это делает экран. Поэтому тест не
// зависит от часового пояса машины, а обработчик проверяется вместе со своим
// переводом «настенное время → UTC в базе».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { calendarSlots, calendarWindows, calendarBook } from './calendar.js';
// CROSS_BRANCH_CALENDAR_V1 — квитанция соседа приходит НАСТОЯЩИМ механизмом.
import { markConfirmed } from '../branch-sync/journal.js';

const registrar = { id: 1, role: 'registrar', extra_roles: [] };
const cashier = { id: 2, role: 'cashier', extra_roles: [] };

// Понедельник 7 сентября 2026 — рабочий день во всех графиках ниже.
const DAY = '2026-09-07';
const at = (hh, mm = 0) => new Date(2026, 8, 7, hh, mm, 0, 0).toISOString();

const WH_9_18 = JSON.stringify({
  mon: { enabled: true, from: '09:00', to: '18:00' },
  tue: { enabled: true, from: '09:00', to: '18:00' },
});

function freshDb({ workingHours = WH_9_18 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (7,'doc','x','Петров П.П.','doctor',1,?)").run(workingHours);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (8,'doc2','x','Каримов Р.','doctor',1,?)").run(workingHours);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (4,'Сидорова Мария')").run();
  db.prepare("INSERT INTO rooms (id, name) VALUES (11,'Кабинет 201')").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (21,'Консультация',100000,30)").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (22,'Забор крови',20000,5)").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (23,'Без длительности',50000,0)").run();
  return db;
}

const book = (db, args, user = registrar) => calendarBook(db, args, user);

// ─── роли ───────────────────────────────────────────────────────────────────

test('роль решает: кассир не записывает и не читает слоты', async () => {
  const db = freshDb();
  assert.throws(() => calendarSlots(db, { doctor_id: 7, date: DAY }, cashier), /role is not allowed/);
  await assert.rejects(() => book(db, { patient_id: 3, doctor_id: 7, start: at(10) }, cashier), /role is not allowed/);
  db.close();
});

// ─── создание ───────────────────────────────────────────────────────────────

test('запись создаётся, длительность берётся ИЗ УСЛУГИ', async () => {
  const db = freshDb();
  const out = await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(10) });
  assert.equal(out.created, true);
  assert.equal(out.visit.duration_minutes, 30, 'длительность обязана прийти из services.duration_minutes');
  assert.equal(out.visit.service_id, 21);
  assert.equal(out.visit.doctor_id, 7);
  assert.equal(out.visit.status, 'scheduled');
  assert.equal(Date.parse(out.visit.visit_date), Date.parse(at(10)));

  // Лабораторная — своя длительность, и это ровно то, ради чего service_id
  // вообще заводился: пятиминутный забор не должен занимать полчаса.
  const lab = await book(db, { patient_id: 4, doctor_id: 8, service_id: 22, start: at(10) });
  assert.equal(lab.visit.duration_minutes, 5);

  // Услуга без заполненной длительности — 15 минут (решение владельца), а не ноль.
  const none = await book(db, { patient_id: 4, doctor_id: 8, service_id: 23, start: at(12) });
  assert.equal(none.visit.duration_minutes, 15);

  // Без услуги вовсе — тоже 15.
  const bare = await book(db, { patient_id: 3, doctor_id: 8, start: at(14) });
  assert.equal(bare.visit.duration_minutes, 15);
  db.close();
});

test('запись без пациента и без времени не создаётся', async () => {
  const db = freshDb();
  await assert.rejects(() => book(db, { doctor_id: 7, start: at(10) }), /patient_id is required/);
  await assert.rejects(() => book(db, { patient_id: 3, doctor_id: 7 }), /start is required/);
  await assert.rejects(() => book(db, { patient_id: 3, doctor_id: 7, start: 'завтра' }), /ISO datetime/);
  await assert.rejects(() => book(db, { patient_id: 3, doctor_id: 999, start: at(10) }), /doctor not found/);
  await assert.rejects(() => book(db, { patient_id: 999, doctor_id: 7, start: at(10) }), /patient not found/);
  db.close();
});

// ─── ЗАПРЕТ ДВОЙНОЙ ЗАПИСИ ──────────────────────────────────────────────────

test('второй пациент на то же время того же врача — ОТКАЗ, и отказ называет занятое время', async () => {
  const db = freshDb();
  await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(14, 30) });   // 14:30–15:00

  let err = null;
  try { await book(db, { patient_id: 4, doctor_id: 7, service_id: 21, start: at(14, 45) }); }
  catch (e) { err = e; }

  assert.ok(err, 'пересекающаяся запись обязана быть отвергнута');
  assert.equal(err.status, 409);
  assert.equal(err.code, 'slot_taken');
  assert.match(err.message, /14:30/, 'отказ обязан назвать занятое время');
  assert.match(err.message, /15:00/);
  assert.match(err.message, /Петров П\.П\./, 'отказ называет врача, у которого занято');
  assert.deepEqual(err.params, { doctor: 'Петров П.П.', from: '14:30', to: '15:00' });

  // И записи действительно не появилось — отказ не «показался», а сработал.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM visits').get().c, 1);
  db.close();
});

test('СТЫК разрешён: 14:30–15:00 и 15:00–15:30 — две нормальные записи подряд', async () => {
  const db = freshDb();
  await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(14, 30) });
  const next = await book(db, { patient_id: 4, doctor_id: 7, service_id: 21, start: at(15, 0) });
  assert.equal(next.created, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM visits').get().c, 2);

  // И за минуту до стыка — уже конфликт: граница проверяется, а не «примерно».
  await assert.rejects(() => book(db, { patient_id: 4, doctor_id: 7, service_id: 21, start: at(14, 59) }), /занято/);
  db.close();
});

test('другой врач в то же время — не конфликт (запрет про ВРАЧА, а не про час)', async () => {
  const db = freshDb();
  await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(11) });
  const other = await book(db, { patient_id: 4, doctor_id: 8, service_id: 21, start: at(11) });
  assert.equal(other.created, true);
  db.close();
});

test('отменённая и не пришедшая записи время НЕ держат', async () => {
  const db = freshDb();
  const v = await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(11) });
  db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(v.visit.id);
  const again = await book(db, { patient_id: 4, doctor_id: 7, service_id: 21, start: at(11) });
  assert.equal(again.created, true, 'отменённая запись держала бы слот навсегда');

  db.prepare("UPDATE visits SET status = 'no_show' WHERE id = ?").run(again.visit.id);
  const third = await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(11) });
  assert.equal(third.created, true);
  db.close();
});

test('запись БЕЗ врача не проверяется, и двойная занятость КАБИНЕТА не запрещена', async () => {
  const db = freshDb();
  await book(db, { patient_id: 3, room_id: 11, service_id: 21, start: at(11) });
  const second = await book(db, { patient_id: 4, room_id: 11, service_id: 21, start: at(11) });
  assert.equal(second.created, true,
    'у кабинета есть вместимость, и запрет там запретил бы то, что клиника делает каждый день');
  db.close();
});

// ─── ЭКСТРЕННАЯ ЗАПИСЬ ──────────────────────────────────────────────────────

test('экстренная запись поверх занятого требует ПРИЧИНЫ и записывает её в саму запись', async () => {
  const db = freshDb();
  await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(14, 30) });

  // Флаг без причины — не «галочка, снимающая проверку».
  let err = null;
  try { await book(db, { patient_id: 4, doctor_id: 7, service_id: 21, start: at(14, 45), emergency: true }); }
  catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'emergency_reason_required');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM visits').get().c, 1);

  const out = await book(db, {
    patient_id: 4, doctor_id: 7, service_id: 21, start: at(14, 45),
    emergency: true, emergency_reason: 'острая боль, направлен из приёмного',
  });
  assert.equal(out.created, true);
  assert.equal(out.emergency, true);
  assert.match(out.visit.notes, /Экстренная запись поверх занятого времени 14:30–15:00/);
  assert.match(out.visit.notes, /острая боль/);
  db.close();
});

// ─── ПЕРЕНОС И РАСТЯГИВАНИЕ ─────────────────────────────────────────────────

test('перенос идёт тем же обработчиком и той же проверкой', async () => {
  const db = freshDb();
  const a = await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(10) });
  const b = await book(db, { patient_id: 4, doctor_id: 7, service_id: 21, start: at(12) });

  // На занятое время — отказ, и запись остаётся на старом месте.
  await assert.rejects(() => book(db, { visit_id: b.visit.id, start: at(10, 15) }), /занято/);
  assert.equal(Date.parse(db.prepare('SELECT visit_date d FROM visits WHERE id=?').get(b.visit.id).d), Date.parse(at(12)));

  // На свободное — переносится.
  const moved = await book(db, { visit_id: b.visit.id, start: at(16) });
  assert.equal(moved.created, false);
  assert.equal(Date.parse(moved.visit.visit_date), Date.parse(at(16)));
  assert.equal(moved.visit.patient_id, 4, 'перенос не смеет менять пациента');
  assert.equal(moved.visit.duration_minutes, 30, 'перенос без длительности сохраняет прежнюю');
  assert.equal(moved.visit.service_id, 21, 'перенос без услуги сохраняет прежнюю');

  // Перенос «на то же место» не конфликтует сам с собой.
  const same = await book(db, { visit_id: a.visit.id, start: at(10) });
  assert.equal(Date.parse(same.visit.visit_date), Date.parse(at(10)));
  db.close();
});

test('растягивание проверяется так же: удлинение НА чужой приём отвергается', async () => {
  const db = freshDb();
  const a = await book(db, { patient_id: 3, doctor_id: 7, service_id: 22, start: at(10) });        // 10:00–10:05
  await book(db, { patient_id: 4, doctor_id: 7, service_id: 21, start: at(10, 30) });              // 10:30–11:00

  // До 10:30 растянуть можно — стык.
  const ok = await book(db, { visit_id: a.visit.id, start: at(10), duration_minutes: 30 });
  assert.equal(ok.visit.duration_minutes, 30);

  // А до 10:45 — уже нет, и отказ называет чужое время.
  let err = null;
  try { await book(db, { visit_id: a.visit.id, start: at(10), duration_minutes: 45 }); }
  catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'slot_taken');
  assert.deepEqual(err.params, { doctor: 'Петров П.П.', from: '10:30', to: '11:00' });
  assert.equal(db.prepare('SELECT duration_minutes d FROM visits WHERE id=?').get(a.visit.id).d, 30,
    'отвергнутое растягивание не должно сохраниться');
  db.close();
});

test('перенос на другого врача проверяет расписание НОВОГО врача', async () => {
  const db = freshDb();
  await book(db, { patient_id: 3, doctor_id: 8, service_id: 21, start: at(13) });
  const mine = await book(db, { patient_id: 4, doctor_id: 7, service_id: 21, start: at(13) });
  await assert.rejects(() => book(db, { visit_id: mine.visit.id, doctor_id: 8, start: at(13) }), /занято/);

  // Перетаскивание на «Не назначено» — врача снимаем, проверять нечего.
  const cleared = await book(db, { visit_id: mine.visit.id, doctor_id: null, start: at(13) });
  assert.equal(cleared.visit.doctor_id, null);
  db.close();
});

test('перевод записи в «отменён» не борется за слот, который сам освобождает', async () => {
  const db = freshDb();
  const a = await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(10) });
  const b = await book(db, {
    patient_id: 4, doctor_id: 7, service_id: 21, start: at(10),
    emergency: true, emergency_reason: 'экстренно',
  });
  const off = await book(db, { visit_id: b.visit.id, start: at(10), status: 'cancelled' });
  assert.equal(off.visit.status, 'cancelled');
  assert.equal(a.visit.id !== b.visit.id, true);
  db.close();
});

// ─── СВОБОДНЫЕ СЛОТЫ ────────────────────────────────────────────────────────

test('calendar_slots отдаёт окно дня, свободные начала и занятое', async () => {
  const db = freshDb();
  await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(10) });   // 10:00–10:30

  const out = calendarSlots(db, { doctor_id: 7, date: DAY, service_id: 21 }, registrar);
  assert.equal(out.date, DAY);
  assert.deepEqual(out.window, { from: '09:00', to: '18:00', breaks: [] });
  assert.equal(out.duration_minutes, 30);
  assert.equal(out.resource.kind, 'doctor');
  assert.equal(out.resource.name, 'Петров П.П.');

  const starts = out.slots.map((s) => s.start);
  assert.ok(starts.includes('09:00'));
  assert.ok(!starts.includes('10:00'), 'занятое время не может быть свободным');
  assert.ok(starts.includes('10:30'), 'стык — свободен');
  assert.equal(out.slots[0].end, '09:30');
  assert.equal(Date.parse(out.slots.find((s) => s.start === '10:30').start_iso), Date.parse(at(10, 30)));

  assert.deepEqual(out.busy, [{
    visit_id: 1, from: '10:00', to: '10:30', duration_minutes: 30,
    status: 'scheduled', patient_id: 3, patient_name: 'Иванов Иван',
  }]);
  db.close();
});

test('calendar_slots: выходной врача — окно null и ни одного слота', async () => {
  const db = freshDb({ workingHours: JSON.stringify({ mon: { enabled: false, from: '09:00', to: '18:00' } }) });
  const out = calendarSlots(db, { doctor_id: 7, date: DAY }, registrar);
  assert.equal(out.window, null);
  assert.deepEqual(out.slots, []);
  db.close();
});

test('calendar_slots: часы клиники сужают окно врача', async () => {
  const db = freshDb({ workingHours: JSON.stringify({ mon: { enabled: true, from: '08:00', to: '20:00' } }) });
  db.prepare("INSERT INTO branches (id, name, is_24_7, working_hours) VALUES (5,'Юнусабад',0,?)")
    .run(JSON.stringify({ mon: { enabled: true, from: '09:00', to: '17:00' } }));
  db.prepare('UPDATE users SET branch_id = 5 WHERE id = 7').run();
  const out = calendarSlots(db, { doctor_id: 7, date: DAY }, registrar);
  assert.deepEqual(out.window, { from: '09:00', to: '17:00', breaks: [] });
  db.close();
});

test('calendar_slots: обед вырезан из свободного', async () => {
  const db = freshDb({
    workingHours: JSON.stringify({
      mon: { enabled: true, from: '12:00', to: '15:00', lunchEnabled: true, lunchFrom: '13:00', lunchTo: '14:00' },
    }),
  });
  const out = calendarSlots(db, { doctor_id: 7, date: DAY, duration_minutes: 30 }, registrar);
  const starts = out.slots.map((s) => s.start);
  assert.deepEqual(out.window.breaks, [{ from: '13:00', to: '14:00' }]);
  assert.ok(starts.includes('12:30'));
  assert.ok(!starts.includes('13:00'), 'обед не предлагается');
  assert.ok(!starts.includes('13:30'));
  assert.ok(starts.includes('14:00'));
  db.close();
});

test('calendar_slots: exclude_visit_id — переносимая запись себе не мешает', async () => {
  const db = freshDb();
  const a = await book(db, { patient_id: 3, doctor_id: 7, service_id: 21, start: at(10) });
  const withIt = calendarSlots(db, { doctor_id: 7, date: DAY, service_id: 21 }, registrar);
  const without = calendarSlots(db, { doctor_id: 7, date: DAY, service_id: 21, exclude_visit_id: a.visit.id }, registrar);
  assert.ok(!withIt.slots.some((s) => s.start === '10:00'));
  assert.ok(without.slots.some((s) => s.start === '10:00'));
  db.close();
});

test('calendar_slots: кабинет — своя ось и свои часы', async () => {
  const db = freshDb();
  db.prepare('UPDATE rooms SET working_hours = ? WHERE id = 11')
    .run(JSON.stringify({ mon: { enabled: true, from: '08:00', to: '11:00' } }));
  await book(db, { patient_id: 3, room_id: 11, service_id: 21, start: at(9) });
  const out = calendarSlots(db, { room_id: 11, date: DAY, service_id: 21 }, registrar);
  assert.equal(out.resource.kind, 'room');
  assert.deepEqual(out.window, { from: '08:00', to: '11:00', breaks: [] });
  assert.ok(!out.slots.some((s) => s.start === '09:00'));
  assert.equal(out.busy.length, 1);
  db.close();
});

test('calendar_slots: без ресурса и с двумя сразу — отказ, а не догадка', async () => {
  const db = freshDb();
  assert.throws(() => calendarSlots(db, { date: DAY }, registrar), /doctor_id or room_id is required/);
  assert.throws(() => calendarSlots(db, { doctor_id: 7, room_id: 11, date: DAY }, registrar), /not both/);
  assert.throws(() => calendarSlots(db, { doctor_id: 7, date: '07.09.2026' }, registrar), /YYYY-MM-DD/);
  db.close();
});

// ─── ОКНА ПАЧКОЙ ────────────────────────────────────────────────────────────

test('calendar_windows отдаёт окна «ресурс × день» одним ответом', async () => {
  const db = freshDb();
  db.prepare('UPDATE users SET working_hours = ? WHERE id = 8')
    .run(JSON.stringify({ mon: { enabled: false }, tue: { enabled: true, from: '10:00', to: '16:00' } }));
  db.prepare('UPDATE rooms SET working_hours = ? WHERE id = 11')
    .run(JSON.stringify({ mon: { enabled: true, from: '08:00', to: '11:00' } }));

  const out = calendarWindows(db, { doctor_ids: [7, 8], room_ids: [11], date: DAY, days: 2 }, registrar);
  assert.deepEqual(out.days, ['2026-09-07', '2026-09-08']);
  assert.deepEqual(out.windows['doctor:7']['2026-09-07'], { from: '09:00', to: '18:00', breaks: [] });
  assert.equal(out.windows['doctor:8']['2026-09-07'], null, 'выходной обязан приехать как null, а не как окно');
  assert.deepEqual(out.windows['doctor:8']['2026-09-08'], { from: '10:00', to: '16:00', breaks: [] });
  assert.deepEqual(out.windows['room:11']['2026-09-07'], { from: '08:00', to: '11:00', breaks: [] });
  assert.equal(out.windows['room:11']['2026-09-08'], null);
  db.close();
});

test('calendar_windows: пустой запрос — пустой ответ, а не отказ', async () => {
  const db = freshDb();
  const out = calendarWindows(db, { date: DAY }, registrar);
  assert.deepEqual(out.days, []);
  assert.deepEqual(out.windows, {});
  // CROSS_BRANCH_CALENDAR_V1 — список зданий приезжает даже на пустой запрос:
  // переключатель филиалов строится ДО того, как что-нибудь выбрано, и отказ
  // «выберите ресурсы» оставил бы экран без переключателя навсегда.
  assert.ok(out.cross, 'межфилиальный контекст обязан быть и в пустом ответе');
  assert.deepEqual(out.cross.visits, {});
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// CROSS_BRANCH_CALENDAR_V1 — запись в чужое здание
// ═══════════════════════════════════════════════════════════════════════════
//
// Проверяется решение владельца целиком, включая ту его часть, которая стоила
// спора: неподтверждённую запись НЕ ОТКАЗЫВАЮТ, но и «записано» про неё не
// говорят. Слот держится здесь, ответ называет вещи своими именами, и ничего
// не теряется — порция ждёт в журнале следующего такта.

/** Второе здание в сети: строка `branches` с буквой B и врач, приписанный к ней. */
function withBranchB(db) {
  db.prepare("UPDATE branches SET letter = 'A' WHERE id = (SELECT MIN(id) FROM branches)").run();
  db.prepare("INSERT INTO branches (id, name, letter, active) VALUES (77,'Второй корпус','B',0)").run();
  db.prepare('UPDATE branch_identity SET letter = ?, branch_id = (SELECT MIN(id) FROM branches) WHERE id = 1').run('A');
  db.prepare('UPDATE users SET branch_id = 77 WHERE id = 8').run();   // Каримов принимает в B
  return 77;
}

/** Шпион вместо срочной выгрузки: считает вызовы и отвечает, чем скажут. */
function spy(result = { ok: true }) {
  const calls = [];
  const impl = async (...args) => { calls.push(args); return result; };
  return { impl, calls };
}

const journalRows = (db, uid) =>
  db.prepare("SELECT COUNT(*) n FROM sync_journal WHERE tbl='visits' AND uid = ?").get(uid).n;

test('запись в чужое здание выкладывается НЕМЕДЛЕННО, а не в часовой такт', async () => {
  const db = freshDb();
  withBranchB(db);
  const pub = spy({ ok: true, at: '2026-09-05T10:00:00Z' });

  const out = await calendarBook(db, { patient_id: 3, doctor_id: 8, start: at(10) }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });

  assert.equal(pub.calls.length, 1, 'выгрузка обязана случиться СРАЗУ: час ожидания — это второй человек на том же приёме');
  assert.equal(out.cross_branch.letter, 'B');
  assert.equal(out.cross_branch.published, true);
  assert.equal(out.cross_branch.confirmed, false,
    'подтвердить в момент записи невозможно: сосед ещё даже не забирал блоб');
  assert.equal(out.visit.cross_branch, 'B', 'на записи обязана стоять буква здания, которое её подтвердит');
  assert.ok(out.visit.cross_branch_seq > 0, 'без номера в журнале подтверждать нечего');
  db.close();
});

test('запись в СВОЁ здание ничего никуда не выкладывает', async () => {
  const db = freshDb();
  withBranchB(db);
  const pub = spy();
  const out = await calendarBook(db, { patient_id: 3, doctor_id: 7, start: at(10) }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });
  assert.equal(pub.calls.length, 0, 'обычная запись не должна дёргать канал');
  assert.equal(out.cross_branch, undefined);
  assert.equal(out.visit.cross_branch, '');
  db.close();
});

test('связи нет: запись СОЗДАНА, ответ говорит «не подтверждено», и ничего не потеряно', async () => {
  const db = freshDb();
  withBranchB(db);
  const pub = spy({ ok: false, reason: 'relay_offline' });

  const out = await calendarBook(db, { patient_id: 3, doctor_id: 8, start: at(10) }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });

  // ОТКАЗЫВАТЬ НЕЛЬЗЯ: слот в том здании действительно свободен, и отказ означал
  // бы потерянного пациента при живом свободном времени.
  assert.equal(out.created, true, 'запись обязана остаться: канал упал, а слот свободен');
  assert.equal(out.cross_branch.published, false);
  assert.equal(out.cross_branch.reason, 'relay_offline');
  assert.equal(out.cross_branch.confirmed, false);
  // И НЕ ПОТЕРЯНО: строка в журнале, значит уедет следующим тактом (срез
  // накопительный, пока нет квитанции).
  const uid = db.prepare('SELECT uid FROM visits WHERE id = ?').get(out.visit.id).uid;
  assert.ok(journalRows(db, uid) > 0, 'невыложенная запись обязана остаться в журнале');
  db.close();
});

test('до квитанции: карточка «подтверждается», слот занят; после — подтверждена', async () => {
  const db = freshDb();
  withBranchB(db);
  const pub = spy({ ok: true });
  const out = await calendarBook(db, { patient_id: 3, doctor_id: 8, start: at(10), duration_minutes: 30 }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });
  const seq = out.visit.cross_branch_seq;

  const before = calendarWindows(db, { doctor_ids: [8], date: DAY, days: 1 }, registrar);
  assert.equal(before.cross.visits[out.visit.id].confirming, true,
    'квитанции нет — карточка обязана честно говорить «подтверждается»');
  assert.equal(before.cross.visits[out.visit.id].building, 'B');

  // СЛОТ ЗАНЯТ И ЗДЕСЬ: неподтверждённая запись держит время так же, как любая.
  await assert.rejects(
    () => calendarBook(db, { patient_id: 4, doctor_id: 8, start: at(10, 15) }, registrar,
      { publishImpl: pub.impl, dataDir: '/tmp/none' }),
    /занято/,
  );

  // Квитанция приходит ТЕМ ЖЕ механизмом, что и всегда: sent_seq двигает только
  // markConfirmed, второго способа не заведено.
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq) VALUES ('B', ?, 0)").run(seq);
  markConfirmed(db, 'B', seq);

  const after = calendarWindows(db, { doctor_ids: [8], date: DAY, days: 1 }, registrar);
  const info = after.cross.visits[out.visit.id];
  assert.ok(!info || info.confirming === false, 'после квитанции метка обязана исчезнуть');
  db.close();
});
