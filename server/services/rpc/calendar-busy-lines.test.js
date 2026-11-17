// SLOT_BUSY_LINES_V1 (3.25.0) — ВРЕМЯ ВРАЧА ЗАНИМАЕТ И СТРОКА ВИЗИТА СО СВОИМ ВРАЧОМ И ВРЕМЕНЕМ.
//
// Пациент записан на 09:00 к врачу А; «Добавить в этот визит» («Бронирование»
// BOOKING_DAY_JOIN_V1, калькулятор календаря, CRM) кладёт в ТОТ ЖЕ визит строку услуги
// врача Б на 15:00. Занятость считалась только по visits.doctor_id и времени самого
// визита, поэтому 15:00 врача Б оставалось «Свободно» в «Бронировании» и в календаре
// и записывалось второму пациенту — ровно двойная запись, которую правило владельца
// «один пациент на врача на слот» запрещает жёстко.
//
// Правило (rpc/calendar.js, SLOT_BUSY_LINES_V1): строка визита держит время своего врача
// [scheduled_at, + длительность услуги / вида приёма), если
//   • её врач — НЕ врач самого визита (время врача визита — это сам визит: его длину
//     растит присоединение JOIN_EXTENDS_BOOKING_V1, а перенос визита строки не двигает);
//   • визит держит время (scheduled / confirmed / arrived), строка не отменена, не
//     возвращена (pay_refund_releases), не товар и не «на дату» (местная полночь).
// Своя запись себе не мешает: exclude_visit_id и проверка строки той же записи
// исключают и визит, и его строки.
//
// День — ближайший будний через два дня (время суток прогона роли не играет).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { calendarSlots, calendarBook, calendarWindows, doctorDayWindows, slotIsFree } from './calendar.js';
import { bookingLinesAdd } from './booking-lines.js';

const REG = { id: 1, role: 'registrar', extra_roles: [] };
const A = 7, B = 8, C = 9;
const P = 3, Q = 4, R = 5, S = 6;

function nextWeekday(offset = 2) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
const DAY_D = nextWeekday();
const DAY = `${DAY_D.getFullYear()}-${String(DAY_D.getMonth() + 1).padStart(2, '0')}-${String(DAY_D.getDate()).padStart(2, '0')}`;
const at = (hh, mm = 0) => new Date(DAY_D.getFullYear(), DAY_D.getMonth(), DAY_D.getDate(), hh, mm, 0, 0).toISOString();

// Визит дня calendar_book ищет по МЕСТНОМУ дню SQLite, день записи — часами JS (как в calendar.test.js).
const TZ_SPLIT = (() => {
  const db = openDb(':memory:');
  const iso = '2030-01-07T00:30:00Z';
  const sql = db.prepare("SELECT strftime('%Y-%m-%d %H:%M', ?, 'localtime') AS v").get(iso).v;
  db.close();
  const d = new Date(iso);
  const js = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sql === js ? false : 'пояс JS не совпадает с поясом SQLite (предзагрузка tz-late) — визит дня по местному дню не найти';
})();

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const wh = {};
  for (const k of ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) wh[k] = { enabled: true, from: '08:00', to: '19:00' };
  const W = JSON.stringify(wh);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'reg', 'x', 'Регистратор', 'registrar', 0, '');
  u.run(A, 'doca', 'x', 'Алиева Нигора', 'doctor', 1, W);
  u.run(B, 'docb', 'x', 'Каримов Бахтиёр', 'doctor', 1, W);
  u.run(C, 'docc', 'x', 'Рахимов Олим', 'doctor', 1, W);
  const p = db.prepare('INSERT INTO patients (id, full_name) VALUES (?, ?)');
  p.run(P, 'Иванов Иван'); p.run(Q, 'Сидорова Мария'); p.run(R, 'Третий Пациент'); p.run(S, 'Четвёртый Пациент');
  const s = db.prepare('INSERT INTO services (id, name, price, duration_minutes) VALUES (?,?,?,?)');
  s.run(21, 'Консультация терапевта', 100000, 30);
  s.run(22, 'ЭКГ', 50000, 15);
  s.run(23, 'Без длительности', 40000, 0);
  s.run(24, 'Консультация кардиолога', 150000, 30);
  db.prepare("INSERT INTO consultation_types (id, name, price, duration_minutes) VALUES (31, 'Первичный приём', 120000, 45)").run();
  return db;
}

/** Пациент P записан на 09:00 к врачу А — визит и строка одним вызовом, как пишет «Бронирование». */
async function nine(db) {
  const out = await calendarBook(db, { patient_id: P, doctor_id: A, service_id: 21, line: { service_id: 21 }, start: at(9), status: 'scheduled' }, REG);
  return out.visit;
}
/** «Добавить в этот визит»: строка врача Б в визите P (booking_lines_add — та же дверь, что у «Бронирования»). */
function joinLine(db, visitId, line, patientId = P) {
  return bookingLinesAdd(db, { visit_id: visitId, patient_id: patientId, lines: [line] }, REG);
}
async function joinedB(db, { start = at(15), service = 24 } = {}) {
  const v = await nine(db);
  const out = joinLine(db, v.id, { service_id: service, doctor_id: B, scheduled_at: start });
  assert.equal(out.added.length, 1, 'стенд: строка врача Б не добавлена');
  return { v, lineId: out.added[0].id };
}
const slotsOf = (db, doctorId, args = {}) => calendarSlots(db, { doctor_id: doctorId, date: DAY, duration_minutes: 30, ...args }, REG);
const starts = (out) => out.slots.map((x) => x.start);
const overlapsWin = (out, from, to) => out.slots.filter((x) => x.start < to && from < x.end).map((x) => x.start + '–' + x.end);
async function refusal(promiseOrFn) {
  try { const r = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn; await r; } catch (e) { return e; }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
test('SLOT_BUSY_LINES_V1: 15:00 врача Б, занятое строкой визита пациента к врачу А, — не «Свободно»; занятость названа', async () => {
  const db = seed();
  const { v, lineId } = await joinedB(db);
  const out = slotsOf(db, B);
  assert.deepEqual(overlapsWin(out, '15:00', '15:30'), [], 'свободное время пересекает строку 15:00–15:30');
  assert.ok(starts(out).includes('14:30') && starts(out).includes('15:30'), 'стыки 14:30 и 15:30 обязаны остаться свободными: ' + starts(out).join(' '));
  const b = out.busy.find((x) => x.from === '15:00');
  assert.ok(b, 'занятость не называет 15:00: ' + JSON.stringify(out.busy));
  assert.equal(b.to, '15:30');
  assert.deepEqual([b.from_min, b.to_min], [15 * 60, 15 * 60 + 30]);
  assert.equal(b.visit_id, v.id);
  assert.equal(b.patient_id, P);
  assert.equal(b.patient_name, 'Иванов Иван');
  assert.equal(b.status, 'scheduled');
  assert.deepEqual(b.visit_service_ids, [lineId]);
  // Партнёрские окна и онлайн-запись — то же правило (одна занятость на продукт).
  const before = new Date(DAY_D.getFullYear(), DAY_D.getMonth(), DAY_D.getDate(), 7, 0).getTime();
  const w = doctorDayWindows(db, { doctorId: B, dayIso: DAY, durationMin: 15, now: before });
  assert.equal(w.windows.find((x) => x.start === '15:00').free, false);
  assert.equal(w.windows.find((x) => x.start === '15:15').free, false);
  assert.equal(w.windows.find((x) => x.start === '15:30').free, true);
  assert.equal(slotIsFree(db, { doctorId: B, startMs: Date.parse(at(15)), durationMin: 15, now: before }), false);
  db.close();
});

test('SLOT_BUSY_LINES_V1: calendar_book другого пациента к врачу Б на 15:00, 15:15, 14:45 — отказ slot_taken с временем строки; стык и экстренная — как прежде', async () => {
  const db = seed();
  await joinedB(db);
  for (const [hh, mm] of [[15, 0], [15, 15], [14, 45]]) {
    const e = await refusal(calendarBook(db, { patient_id: Q, doctor_id: B, service_id: 24, start: at(hh, mm) }, REG));
    assert.ok(e, `к врачу Б на ${hh}:${String(mm).padStart(2, '0')} записали поверх строки 15:00–15:30`);
    assert.equal(e.code, 'slot_taken');
    assert.equal(e.status, 409);
    assert.deepEqual([e.params.from, e.params.to, e.params.doctor], ['15:00', '15:30', 'Каримов Бахтиёр']);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = ?').get(Q).n, 0, 'отказ всё же завёл визит');
  const ok1 = await calendarBook(db, { patient_id: Q, doctor_id: B, service_id: 24, start: at(14, 30) }, REG);
  assert.equal(ok1.created, true, 'стык 14:30–15:00 отвергнут');
  const ok2 = await calendarBook(db, { patient_id: R, doctor_id: B, service_id: 24, start: at(15, 30) }, REG);
  assert.equal(ok2.created, true, 'стык 15:30 отвергнут');
  const emg = await calendarBook(db, { patient_id: S, doctor_id: B, service_id: 24, start: at(15), emergency: true, emergency_reason: 'острая боль' }, REG);
  assert.equal(emg.emergency, true, 'экстренная запись с причиной не прошла');
  assert.match(emg.visit.notes, /15:00–15:30: острая боль/);
  db.close();
});

test('SLOT_BUSY_LINES_V1: booking_lines_add — строка к врачу Б на время, занятое строкой или записью другого визита, — отказ slot_taken; своя запись, стык и строка без времени — пишутся', async () => {
  const db = seed();
  const { v } = await joinedB(db);
  const w = (await calendarBook(db, { patient_id: Q, doctor_id: C, service_id: 21, start: at(10) }, REG)).visit;
  for (const [hh, mm] of [[15, 0], [15, 20], [14, 50]]) {
    const e = await refusal(() => joinLine(db, w.id, { service_id: 24, doctor_id: B, scheduled_at: at(hh, mm) }, Q));
    assert.ok(e, `строка к врачу Б на ${hh}:${String(mm).padStart(2, '0')} легла поверх 15:00–15:30`);
    assert.equal(e.code, 'slot_taken');
    assert.equal(e.status, 409);
    assert.deepEqual([e.params.from, e.params.to], ['15:00', '15:30']);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(w.id).n, 0, 'отказ оставил строку');
  // Запись (визит) врача Б — тоже занятость для строки: прежде booking_lines_add время не проверял вовсе.
  await calendarBook(db, { patient_id: R, doctor_id: B, service_id: 24, start: at(16) }, REG);
  const e2 = await refusal(() => joinLine(db, w.id, { service_id: 24, doctor_id: B, scheduled_at: at(16, 10) }, Q));
  assert.equal(e2 && e2.code, 'slot_taken', 'строка легла на запись врача Б 16:00');
  assert.deepEqual([e2.params.from, e2.params.to], ['16:00', '16:30']);
  // Стык — пишется.
  assert.equal(joinLine(db, w.id, { service_id: 24, doctor_id: B, scheduled_at: at(15, 30) }, Q).added.length, 1);
  // Та же запись: вторая услуга к врачу Б на то же 15:00 визита P — своя строка не мешает.
  assert.equal(joinLine(db, v.id, { service_id: 22, doctor_id: B, scheduled_at: at(15) }).added.length, 1, 'своя строка той же записи отказала');
  // Строка без времени времени не занимает и не проверяется.
  assert.equal(joinLine(db, w.id, { service_id: 23, doctor_id: B }, Q).added.length, 1);
  db.close();
});

test('SLOT_BUSY_LINES_V1: строка врача самой записи не проверяется и не занимает второй раз — экстренная запись получает свою строку', async () => {
  const db = seed();
  await joinedB(db);
  const emg = await calendarBook(db, { patient_id: S, doctor_id: B, service_id: 24, start: at(15), emergency: true, emergency_reason: 'острая боль' }, REG);
  // Колл-центр пишет строки записи следом за calendar_book (калькулятор): строка врача записи на её время.
  const out = joinLine(db, emg.visit.id, { service_id: 24, doctor_id: B, scheduled_at: at(15) }, S);
  assert.equal(out.added.length, 1, 'строке экстренной записи отказали');
  // Занятость врача Б в 15:00: строка P и запись S — по одной, строка самой записи S второй раз не считается.
  const busy = slotsOf(db, B).busy.filter((x) => x.from === '15:00');
  assert.deepEqual(busy.map((x) => x.patient_id).sort(), [P, S].sort(), JSON.stringify(busy));
  db.close();
});

test('SLOT_BUSY_LINES_V1: не держат время — отменённая строка, отменённый и неявочный визит, возвращённая строка, строка «на дату», товар', async () => {
  const db = seed();
  const { v, lineId } = await joinedB(db);
  const free15 = () => starts(slotsOf(db, B)).includes('15:00');
  assert.equal(free15(), false, 'стенд: строка не держит 15:00');

  db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE id = ?").run(lineId);
  assert.equal(free15(), true, 'отменённая строка держит время');
  db.prepare("UPDATE visit_services SET status = 'added' WHERE id = ?").run(lineId);

  for (const st of ['cancelled', 'no_show']) {
    db.prepare('UPDATE visits SET status = ? WHERE id = ?').run(st, v.id);
    assert.equal(free15(), true, `строка визита «${st}» держит время`);
  }
  db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(v.id);
  assert.equal(free15(), false, 'строка пришедшего пациента время не держит');
  db.prepare("UPDATE visits SET status = 'scheduled' WHERE id = ?").run(v.id);

  // Возврат кассы: строка отпущена со счёта с возвратом и заново не выставлена.
  db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, 999)").run(lineId);
  assert.equal(free15(), true, 'возвращённая строка держит время');
  db.prepare('DELETE FROM pay_refund_releases').run();
  assert.equal(free15(), false);

  // Строка «на дату» (местная полночь) и выданный товар времени врача не держат.
  const midnight = new Date(DAY_D.getFullYear(), DAY_D.getMonth(), DAY_D.getDate(), 0, 0, 0, 0).toISOString();
  db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, status, scheduled_at) VALUES (?, 23, ?, 'added', ?)").run(v.id, C, midnight);
  db.prepare("INSERT INTO products (id, name) VALUES (5, 'Бинт')").run();
  db.prepare("INSERT INTO visit_services (visit_id, clinic_item_id, doctor_id, status, scheduled_at) VALUES (?, 5, ?, 'added', ?)").run(v.id, C, at(11));
  const c = slotsOf(db, C);
  assert.deepEqual(c.busy, [], 'строка «на дату» или товар заняли врача В: ' + JSON.stringify(c.busy));
  db.close();
});

test('SLOT_BUSY_LINES_V1: строки врача самой записи — это сама запись: нет второй занятости, перенос записи не оставляет старое время занятым', async () => {
  const db = seed();
  const v = await nine(db);   // строка записи: врач А, 09:00 — на время самого визита
  const a = slotsOf(db, A);
  assert.equal(a.busy.length, 1, 'строка записи дала вторую занятость: ' + JSON.stringify(a.busy));
  assert.equal(a.busy[0].visit_service_ids, undefined);
  await calendarBook(db, { visit_id: v.id, start: at(11) }, REG);   // перенос мышью — строка остаётся на 09:00
  const after = slotsOf(db, A);
  assert.ok(starts(after).includes('09:00'), 'после переноса 09:00 врача А осталось занятым строкой записи');
  assert.deepEqual(after.busy.map((x) => x.from), ['11:00']);
  db.close();
});

test('SLOT_BUSY_LINES_V1: своя запись себе не мешает — exclude_visit_id, перенос визита на время своей строки', async () => {
  const db = seed();
  const { v } = await joinedB(db);
  assert.ok(starts(slotsOf(db, B, { exclude_visit_id: v.id })).includes('15:00'), 'exclude_visit_id не снял строку своей записи (EXCLUDE_OWN_VISIT_V1)');
  // Перенос записи P к врачу Б на 15:00 — на время её же строки — не отказ.
  const moved = await calendarBook(db, { visit_id: v.id, doctor_id: B, start: at(15) }, REG);
  assert.equal(moved.visit.doctor_id, B);
  db.close();
});

test('SLOT_BUSY_LINES_V1: присоединение к записи — по прежним правилам; продление упирается и в строку чужого визита', { skip: TZ_SPLIT }, async () => {
  const db = seed();
  const v = await nine(db);   // P: врач А 09:00–09:30
  // Присоединение ЭКГ к записи P у врача А: 09:30 свободно — запись удлинилась (JOIN_EXTENDS_BOOKING_V1).
  const j1 = await calendarBook(db, { patient_id: P, doctor_id: A, service_id: 22, start: at(9) }, REG);
  assert.equal(j1.joined, true);
  assert.equal(j1.extended, true, 'своя запись не удлинилась');
  assert.equal(db.prepare('SELECT duration_minutes d FROM visits WHERE id = ?').get(v.id).d, 45);

  // Второй стенд: 09:45 врача А держит строка ЧУЖОГО визита (пациент Q записан к врачу В, строка к врачу А).
  const db2 = seed();
  const v2 = await nine(db2);
  const w = (await calendarBook(db2, { patient_id: Q, doctor_id: C, service_id: 21, start: at(8) }, REG)).visit;
  joinLine(db2, w.id, { service_id: 22, doctor_id: A, scheduled_at: at(9, 30) }, Q);   // 09:30–09:45 врача А
  const j2 = await calendarBook(db2, { patient_id: P, doctor_id: A, service_id: 22, start: at(9) }, REG);
  assert.equal(j2.joined, true);
  assert.equal(j2.extended, false, 'запись удлинилась поверх строки чужого визита');
  assert.equal(j2.next, '09:30');
  assert.equal(db2.prepare('SELECT duration_minutes d FROM visits WHERE id = ?').get(v2.id).d, 30);
  db.close(); db2.close();
});

test('SLOT_BUSY_LINES_V1: другие врачи не затронуты', async () => {
  const db = seed();
  await joinedB(db);
  assert.ok(starts(slotsOf(db, C)).includes('15:00'), 'строка врача Б заняла врача В');
  assert.deepEqual(slotsOf(db, C).busy, []);
  const ok = await calendarBook(db, { patient_id: Q, doctor_id: C, service_id: 21, start: at(15) }, REG);
  assert.equal(ok.created, true);
  db.close();
});

test('SLOT_BUSY_LINES_V1: длительность строки — услуга, вид приёма, иначе 15; строки одной записи на одно время — подряд', async () => {
  const db = seed();
  const v = await nine(db);
  // Вид приёма 45 минут у врача Б в 12:00.
  joinLine(db, v.id, { consultation_type_id: 31, doctor_id: B, scheduled_at: at(12) });
  // Услуга без длительности у врача В в 13:00 — 15 минут.
  joinLine(db, v.id, { service_id: 23, doctor_id: C, scheduled_at: at(13) });
  // Две услуги врача Б в 15:00 (30 + 15) — одна занятость 15:00–15:45.
  joinLine(db, v.id, { service_id: 24, doctor_id: B, scheduled_at: at(15) });
  joinLine(db, v.id, { service_id: 22, doctor_id: B, scheduled_at: at(15) });
  const b = slotsOf(db, B).busy.map((x) => [x.from, x.to]);
  assert.deepEqual(b, [['12:00', '12:45'], ['15:00', '15:45']]);
  assert.deepEqual(slotsOf(db, C).busy.map((x) => [x.from, x.to]), [['13:00', '13:15']]);
  const e = await refusal(calendarBook(db, { patient_id: Q, doctor_id: B, service_id: 24, start: at(12, 30) }, REG));
  assert.deepEqual(e && [e.code, e.params.from, e.params.to], ['slot_taken', '12:00', '12:45']);
  db.close();
});

test('SLOT_BUSY_LINES_V1: calendar_windows отдаёт сетке «Записи» строки чужих визитов по врачам — не строки записи самого врача', async () => {
  const db = seed();
  const { v, lineId } = await joinedB(db);
  const out = calendarWindows(db, { doctor_ids: [A, B, C], date: DAY, days: 1 }, REG);
  assert.deepEqual(Object.keys(out.busy_lines || {}).sort(), ['doctor:' + B]);
  const [x] = out.busy_lines['doctor:' + B];
  assert.equal(x.day, DAY);
  assert.deepEqual([x.from, x.to, x.from_min, x.to_min, x.duration_minutes], ['15:00', '15:30', 900, 930, 30]);
  assert.equal(x.visit_id, v.id);
  assert.deepEqual(x.visit_service_ids, [lineId]);
  assert.equal(x.patient_id, P);
  assert.equal(x.patient_name, 'Иванов Иван');
  assert.equal(x.visit_doctor_id, A);
  assert.equal(x.service, 'Консультация кардиолога');
  assert.equal(x.status, 'scheduled');
  db.close();
});
