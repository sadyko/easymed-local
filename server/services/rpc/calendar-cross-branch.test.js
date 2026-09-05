// CROSS_BRANCH_CALENDAR_V1 — МЕЖФИЛИАЛЬНЫЙ КАЛЕНДАРЬ НА НАСТОЯЩИХ ДАННЫХ.
//
// ─── ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, ЕСЛИ ЕСТЬ calendar.test.js ───────────────────────
//
// Потому что тот файл был зелёным, а работа — сломанной, и разница между ними
// ровно в одной строчке посева: он ставил врачу здание руками
// (`UPDATE users SET branch_id = 77`). Такого состояния синхронизация
// произвести не могла: справочник приписку не вёз, у настоящего филиала все
// врачи главной клиники стояли без здания — и вся межфилиальная машина
// (удержание слота, «подтверждается», срочная выгрузка) не включалась НИ РАЗУ.
// Оператор слышал обычное зелёное «Визит создан».
//
// Поэтому здесь ЗАПРЕЩЕНО собирать состояние руками. Всё, что делает этот файл
// перед проверкой, делает настоящий код продукта:
//
//   exportCatalogue / applyCatalogue — здание и график врача приезжают
//                                      справочником, как в клинике;
//   buildBatch / applyBatch          — чужая запись приезжает журналом, как в
//                                      клинике, включая случай «логин врача нам
//                                      ещё не привезли»;
//   becomeSecondary                  — эта установка становится филиалом тем же
//                                      путём, что и по ключу подключения.
//
// Если приписка врача перестанет ездить, эти тесты покраснеют сами — а именно
// этого и не хватило в прошлый раз.
//
// ─── ЧТО ИМЕННО ПРОВЕРЯЕТСЯ ─────────────────────────────────────────────────
//
//   1. запись в чужое здание НАЗЫВАЕТСЯ НЕПОДТВЕРЖДЁННОЙ, а не сделанной;
//   2. вердикт спора одинаков, в каком порядке записи ни подавай;
//   3. приехавшая запись без врача видна, названа и предупреждает — но время
//      ничьё не занимает, потому что чьё занимать, неизвестно;
//   4. график чужого врача СОБЛЮДАЕТСЯ (он теперь едет), а не выдумывается;
//   5. неподтверждённая запись СТАРЕЕТ и после порога читается иначе.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { calendarSlots, calendarWindows, calendarBook, resolveCollisions, CONFIRMING_STALE_MIN } from './calendar.js';
import { exportCatalogue, applyCatalogue } from '../branch-sync/catalogue.js';
import { becomeSecondary } from '../branch-sync/identity.js';
import { buildBatch } from '../branch-sync/journal.js';
import { applyBatch } from '../branch-sync/records.js';

const registrar = { id: 1, role: 'registrar', extra_roles: [] };

// Понедельник 7 сентября 2026 — рабочий день во всех графиках ниже.
const DAY = '2026-09-07';
const at = (hh, mm = 0) => new Date(2026, 8, 7, hh, mm, 0, 0).toISOString();

const MINE = 'B';   // эта установка — филиал
const FAR = 'A';    // соседнее здание — главная клиника

const WH_9_18 = JSON.stringify({ mon: { enabled: true, from: '09:00', to: '18:00' } });
const WH_10_14 = JSON.stringify({ mon: { enabled: true, from: '10:00', to: '14:00' } });

/** Шпион вместо срочной выгрузки: канал в тестах не поднимаем. */
function spy(result = { ok: true }) {
  const calls = [];
  return { impl: async (...a) => { calls.push(a); return result; }, calls };
}

/**
 * Главная клиника A: два здания в ростере и два врача — свой и наш.
 *
 * farHours — график врача ГЛАВНОЙ клиники. Он и есть предмет проверки 4:
 * филиал обязан узнать о нём из справочника, а не подставить своё умолчание.
 */
function mainClinic({ farHours = WH_9_18, clinicHours = '' } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("UPDATE branches SET name = 'Главный корпус', working_hours = ? WHERE letter = 'A'").run(clinicHours);
  db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run('Второй корпус', MINE);
  const aId = db.prepare("SELECT id FROM branches WHERE letter = 'A'").get().id;
  const bId = db.prepare('SELECT id FROM branches WHERE letter = ?').get(MINE).id;
  db.prepare(`INSERT INTO users (username, password_hash, full_name, role, is_doctor, working_hours, branch_id)
              VALUES ('doc','x','Петров П.П.','doctor',1,?,?)`).run(WH_9_18, bId);
  db.prepare(`INSERT INTO users (username, password_hash, full_name, role, is_doctor, working_hours, branch_id)
              VALUES ('doc2','x','Каримов Р.','doctor',1,?,?)`).run(farHours, aId);
  return db;
}

/**
 * ЭТА установка: филиал B, получивший справочник главной клиники настоящим
 * приёмом. Своих врачей он завёл ДО связывания — так и бывает: филиал работает,
 * потом его подключают, и справочник УСЫНОВЛЯЕТ его строки по логину.
 */
function branchB({ farHours = WH_9_18, clinicHours = '' } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  // Буква — до первого пациента: установке, уже выдавшей номера под своей
  // буквой, becomeSecondary отказывает (миграция 080).
  becomeSecondary(db, { letter: MINE, name: 'Второй корпус' });
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (7,'doc','x','Петров П.П.','doctor',1,?)").run(WH_9_18);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (8,'doc2','x','Каримов Р.','doctor',1,?)").run(WH_9_18);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (4,'Сидорова Мария')").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (21,'Консультация',100000,30)").run();

  const main = mainClinic({ farHours, clinicHours });
  db.transaction(() => applyCatalogue(db, exportCatalogue(main)))();
  main.close();
  return db;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. ЗДАНИЕ ВРАЧА ИЗВЕСТНО — И ИМЕННО ПОЭТОМУ ЗАПИСЬ НЕ НАЗЫВАЮТ СДЕЛАННОЙ
// ═══════════════════════════════════════════════════════════════════════════

test('здание врача приезжает СПРАВОЧНИКОМ: буквой, а не чужим id', () => {
  const db = branchB();
  const letterOf = (id) => {
    const u = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(id);
    return u.branch_id ? db.prepare('SELECT letter FROM branches WHERE id = ?').get(u.branch_id).letter : null;
  };
  assert.equal(letterOf(8), FAR, 'врач главной клиники обязан приехать приписанным к ГЛАВНОЙ клинике');
  assert.equal(letterOf(7), MINE, 'наш врач остаётся нашим');

  // И это НАШ id здания, а не чужой: у главной клиники строки нумеруются
  // иначе, и приехавший id указывал бы в никуда.
  const far = db.prepare('SELECT id FROM branches WHERE letter = ?').get(FAR);
  assert.equal(db.prepare('SELECT branch_id FROM users WHERE id = 8').get().branch_id, far.id);
  db.close();
});

test('запись к врачу соседнего здания объявляется НЕПОДТВЕРЖДЁННОЙ, а не сделанной', async () => {
  const db = branchB();
  const pub = spy({ ok: true });

  const out = await calendarBook(db, { patient_id: 3, doctor_id: 8, start: at(11) }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });

  // ЭТО И ЕСТЬ ГЛАВНАЯ ПРОВЕРКА ЗАДАЧИ. До починки справочника здесь было
  // пусто: cross_branch отсутствовал, выгрузка не звалась, слот у соседа не
  // держался — и оператор слышал обычное «Визит создан».
  assert.ok(out.cross_branch, 'запись в чужое здание обязана быть названа таковой');
  assert.equal(out.cross_branch.letter, FAR);
  assert.equal(out.cross_branch.name, 'Главный корпус', 'имя здания приехало ростером — оператор читает имя, а не букву');
  assert.equal(out.cross_branch.confirmed, false, 'подтвердить в момент записи невозможно: сосед ещё не забирал блоб');
  assert.equal(pub.calls.length, 1, 'запись в чужое здание выкладывается немедленно, а не в часовой такт');
  assert.equal(out.visit.cross_branch, FAR, 'на записи стоит буква здания, которое её подтвердит');
  assert.ok(out.visit.cross_branch_seq > 0, 'без номера в журнале подтверждать нечего');

  // И сетка говорит то же самое, тем же словом.
  const win = calendarWindows(db, { doctor_ids: [8], date: DAY, days: 1 }, registrar);
  assert.equal(win.cross.visits[out.visit.id].confirming, true);
  assert.equal(win.cross.visits[out.visit.id].building, FAR);
  db.close();
});

test('запись к своему врачу остаётся обычной: канал не дёргается, метки нет', async () => {
  const db = branchB();
  const pub = spy();
  const out = await calendarBook(db, { patient_id: 3, doctor_id: 7, start: at(11) }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });
  assert.equal(out.cross_branch, undefined);
  assert.equal(pub.calls.length, 0);
  assert.equal(out.visit.cross_branch, '');
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. ВЕРДИКТ СПОРА НЕ ЗАВИСИТ ОТ ПОРЯДКА
// ═══════════════════════════════════════════════════════════════════════════
//
// Три пересекающиеся записи — минимальный случай, на котором старое правило
// расходилось: охрана «проигравший уже назван» закрепляла ПЕРВОЕ найденное
// столкновение, а порядок строк у двух зданий разный. Здание A объявляло B1
// победителем, здание B — проигравшим, и каждое ждало своего пациента.

const clashRow = (id, uid, home, bookedAt, fromHh) => ({
  id, uid, home, building: home, doctor_id: 8,
  booked_at: bookedAt, status: 'scheduled',
  startMs: new Date(2026, 8, 7, fromHh, 0, 0, 0).getTime(),
  endMs: new Date(2026, 8, 7, fromHh, 30, 0, 0).getTime(),
});

test('вердикт спора одинаков, в каком порядке записи ни подавай', () => {
  // Три записи на одно время у одного врача из ТРЁХ разных зданий: все три
  // пересекаются друг с другом, и это тот минимум, на котором порядок начинал
  // решать.
  const a = clashRow(1, 'uid-a', 'A', '2026-09-05T09:00:00.000Z', 11);
  const b = clashRow(2, 'uid-b', 'B', '2026-09-05T09:00:30.000Z', 11);
  const c = clashRow(3, 'uid-c', 'C', '2026-09-05T09:01:00.000Z', 11);

  const verdict = (rows) => [...resolveCollisions(rows).entries()]
    .map(([id, v]) => `${id}:${v.loses ? 'loses' : 'wins'}:${v.with}`)
    .sort().join(' | ');

  const forward = verdict([a, b, c]);
  const backward = verdict([c, b, a]);
  const shuffled = verdict([b, c, a]);

  assert.equal(forward, backward,
    'два здания перечисляют одни и те же записи в разном порядке — вердикт обязан совпасть');
  assert.equal(forward, shuffled);
  // И вердикт по существу верен: самая ранняя запись выигрывает, две поздние
  // проигрывают ей — а не друг другу.
  assert.match(forward, /1:wins/);
  assert.match(forward, /2:loses:1/);
  assert.match(forward, /3:loses:1/);
});

test('спор двух зданий: побеждает более ранняя, и это видно в ответе сетки', async () => {
  const db = branchB();
  const pub = spy({ ok: true });
  // Наша запись к врачу главного корпуса — сделана ПОЗЖЕ.
  const ours = await calendarBook(db, { patient_id: 3, doctor_id: 8, start: at(11), duration_minutes: 30 }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });
  db.prepare("UPDATE visits SET booked_at = '2026-09-05T10:00:00.000Z' WHERE id = ?").run(ours.visit.id);
  // Их запись на то же время, сделанная РАНЬШЕ, — приехала журналом.
  db.prepare(`INSERT INTO visits (uid, sync_origin, patient_id, doctor_id, service_id, visit_date,
                                  duration_minutes, status, booked_at)
              VALUES ('uid-theirs', ?, 4, 8, 21, ?, 30, 'scheduled', '2026-09-05T09:00:00.000Z')`)
    .run(FAR, new Date(Date.parse(at(11))).toISOString());

  const win = calendarWindows(db, { doctor_ids: [8], date: DAY, days: 1 }, registrar);
  const theirs = db.prepare("SELECT id FROM visits WHERE uid = 'uid-theirs'").get().id;
  assert.equal(win.cross.visits[ours.visit.id].collision.loses, true, 'более поздняя запись проигрывает');
  assert.equal(win.cross.visits[theirs].collision.loses, false);
  assert.equal(win.cross.visits[ours.visit.id].collision.with, theirs, 'проигравшей названо, С КЕМ она спорит');
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ПРИЕХАВШАЯ ЗАПИСЬ БЕЗ ВРАЧА
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Приземлить в `to` запись из здания A, чей врач нам НЕИЗВЕСТЕН — настоящим
 * приёмом журнала, а не INSERT-ом. Именно так это и происходит: сотрудники
 * едут отдельным каналом и своим тактом, поэтому запись обгоняет справочник.
 */
function landForeignBookingWithUnknownDoctor(to, { hh = 12 } = {}) {
  const main = mainClinic();
  // Врач, которого у нас ещё нет: его завели в главной клинике только что, и
  // справочник до нас пока не доехал.
  main.prepare(`INSERT INTO users (username, password_hash, full_name, role, is_doctor, branch_id)
                VALUES ('novikov','x','Новиков Н.','doctor',1,
                        (SELECT id FROM branches WHERE letter = 'A'))`).run();
  const docId = main.prepare("SELECT id FROM users WHERE username = 'novikov'").get().id;
  main.prepare("INSERT INTO patients (full_name) VALUES ('Петрова Анна')").run();
  const pid = main.prepare("SELECT id FROM patients WHERE full_name = 'Петрова Анна'").get().id;
  main.prepare(`INSERT INTO visits (patient_id, doctor_id, visit_date, duration_minutes, status, booked_at)
                VALUES (?, ?, ?, 30, 'scheduled', '2026-09-05T08:00:00.000Z')`)
    .run(pid, docId, new Date(Date.parse(at(hh))).toISOString());

  const batch = buildBatch(main, { self: FAR, peer: MINE });
  const stats = applyBatch(to, batch.records, { self: MINE, peer: FAR, upto: batch.upto, seed: batch.seed });
  main.close();
  return stats;
}

test('чужая запись с незнакомым логином врача ПРИЗЕМЛЯЕТСЯ — без врача, но целиком', () => {
  const db = branchB();
  landForeignBookingWithUnknownDoctor(db);

  const v = db.prepare("SELECT * FROM visits WHERE sync_origin = ?").get(FAR);
  assert.ok(v, 'запись обязана приехать: ждать справочник значило бы спрятать занятое время, а через 30 дней потерять её');
  assert.equal(v.doctor_id, null, 'врача не выдумывают: колонка остаётся пустой');
  assert.ok(v.patient_id, 'пациент, время и статус — это и есть запись, и они приехали');
  db.close();
});

test('запись без врача НАЗВАНА: её время не занято ни у кого, и об этом сказано', () => {
  const db = branchB();
  landForeignBookingWithUnknownDoctor(db, { hh: 12 });
  const v = db.prepare('SELECT id FROM visits WHERE sync_origin = ?').get(FAR).id;

  const win = calendarWindows(db, { doctor_ids: [7, 8], date: DAY, days: 1 }, registrar);
  const info = win.cross.visits[v];
  assert.ok(info, 'запись без врача обязана попасть в межфилиальный контекст — иначе экран о ней не узнает вовсе');
  assert.equal(info.unassigned, true, 'она помечена именно как «врач не определён»');
  assert.equal(info.foreign, true);
  assert.equal(info.building, FAR, 'здание берётся из автора строки: врача, по которому его узнать, нет');
  db.close();
});

test('перед записью в то здание на то же время спрашивающий получает предупреждение', async () => {
  const db = branchB();
  landForeignBookingWithUnknownDoctor(db, { hh: 12 });

  // Слоты у врача ТОГО здания: время не отнято — там почти наверняка другой
  // врач, — но названо.
  const slots = calendarSlots(db, { doctor_id: 8, date: DAY, duration_minutes: 30 }, registrar);
  assert.ok(slots.slots.some((s) => s.start === '12:00'),
    'отнимать слот нельзя: врача той записи мы не знаем, и отказ терял бы пациента при свободном времени');
  assert.equal(slots.at_risk.length, 1, 'но молчать о ней тоже нельзя');
  assert.deepEqual(
    { from: slots.at_risk[0].from, to: slots.at_risk[0].to, building: slots.at_risk[0].building },
    { from: '12:00', to: '12:30', building: FAR },
  );

  // У СВОЕГО врача ничего этого нет: чужая запись без врача — не его дело.
  const ours = calendarSlots(db, { doctor_id: 7, date: DAY, duration_minutes: 30 }, registrar);
  assert.equal(ours.at_risk.length, 0);

  // И сама запись — тоже: ответ называет риск тому, кто записывает.
  const pub = spy({ ok: true });
  const out = await calendarBook(db, { patient_id: 3, doctor_id: 8, start: at(12), duration_minutes: 30 }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });
  assert.equal(out.created, true, 'записать можно — отказ был бы враньём про занятость');
  assert.equal(out.at_risk.length, 1, 'но ответ обязан назвать приехавшего пациента без врача');
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. ГРАФИК ЧУЖОГО ВРАЧА
// ═══════════════════════════════════════════════════════════════════════════

test('график врача соседнего здания СОБЛЮДАЕТСЯ, а не подменяется умолчанием 09:00–18:00', () => {
  const db = branchB({ farHours: WH_10_14 });

  const out = calendarSlots(db, { doctor_id: 8, date: DAY, duration_minutes: 30 }, registrar);
  assert.deepEqual(out.window, { from: '10:00', to: '14:00', breaks: [] },
    'окно приехало из справочника; до этого движок брал своё 09:00–18:00 и предлагал время, в которое врач не принимает');
  assert.equal(out.slots.some((s) => s.start === '09:00'), false);
  assert.equal(out.slots.some((s) => s.start === '15:00'), false);
  assert.ok(out.slots.some((s) => s.start === '10:00'));

  // И то же самое пачкой — сетка затеняет по этому же ответу.
  const win = calendarWindows(db, { doctor_ids: [8], date: DAY, days: 1 }, registrar);
  assert.deepEqual(win.windows['doctor:8'][DAY], { from: '10:00', to: '14:00', breaks: [] });
  db.close();
});

test('часы САМОГО здания тоже соблюдаются: врач до 18:00 в корпусе до 16:00 принимает до 16:00', () => {
  const db = branchB({
    farHours: WH_9_18,
    clinicHours: JSON.stringify({ mon: { enabled: true, from: '09:00', to: '16:00' } }),
  });
  const out = calendarSlots(db, { doctor_id: 8, date: DAY, duration_minutes: 30 }, registrar);
  assert.deepEqual(out.window, { from: '09:00', to: '16:00', breaks: [] },
    'часы соседнего здания приехали ростером: без них мы предлагали бы время, на которое оно само записать не даёт');
  db.close();
});

test('пустой график у обеих сторон означает ОДНО И ТО ЖЕ окно — вот почему отказ не понадобился', () => {
  // Незаполненный график — самый частый случай в клиниках, и он же был самым
  // опасным: пока колонка не ездила, «пусто у нас» и «пусто у них» совпадали
  // только случайно. Теперь колонка едет, и обе стороны берут одно умолчание
  // одного и того же движка.
  const db = branchB({ farHours: '' });
  const here = calendarSlots(db, { doctor_id: 8, date: DAY, duration_minutes: 30 }, registrar);
  const main = mainClinic({ farHours: '' });
  const there = calendarSlots(main, { doctor_id: main.prepare("SELECT id FROM users WHERE username='doc2'").get().id, date: DAY, duration_minutes: 30 },
    registrar);
  assert.deepEqual(here.window, there.window, 'два здания обязаны считать окно одинаково');
  main.close();
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. НЕПОДТВЕРЖДЁННАЯ ЗАПИСЬ СТАРЕЕТ
// ═══════════════════════════════════════════════════════════════════════════

test('свежая и застоявшаяся «подтверждается» читаются ПО-РАЗНОМУ', async () => {
  const db = branchB();
  const pub = spy({ ok: true });
  const fresh = await calendarBook(db, { patient_id: 3, doctor_id: 8, start: at(11) }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });
  const old = await calendarBook(db, { patient_id: 4, doctor_id: 8, start: at(15) }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });
  // Вторая записана давно: здание молчит с тех пор и квитанции не прислало.
  const longAgo = new Date(Date.now() - (CONFIRMING_STALE_MIN + 30) * 60000).toISOString();
  db.prepare('UPDATE visits SET booked_at = ? WHERE id = ?').run(longAgo, old.visit.id);

  const win = calendarWindows(db, { doctor_ids: [8], date: DAY, days: 1 }, registrar);
  const a = win.cross.visits[fresh.visit.id];
  const b = win.cross.visits[old.visit.id];

  assert.equal(a.confirming, true);
  assert.equal(a.confirming_stale, false, 'запись, сделанную минуту назад, тревогой объявлять нечестно');
  assert.ok(a.confirming_minutes != null && a.confirming_minutes < 5, 'возраст обязан быть назван числом');

  assert.equal(b.confirming, true);
  assert.equal(b.confirming_stale, true,
    'здание молчит дольше полного круга обмена — это уже не «идёт обмен», а повод звонить');
  assert.ok(b.confirming_minutes >= CONFIRMING_STALE_MIN);
  assert.equal(win.cross.stale_after_minutes, CONFIRMING_STALE_MIN,
    'порог считает сервер и называет его экрану: правило одно на обе стороны');
  db.close();
});

test('пришла квитанция — стареть больше нечему', async () => {
  const db = branchB();
  const pub = spy({ ok: true });
  const out = await calendarBook(db, { patient_id: 3, doctor_id: 8, start: at(11) }, registrar,
    { publishImpl: pub.impl, dataDir: '/tmp/none' });
  const longAgo = new Date(Date.now() - (CONFIRMING_STALE_MIN + 30) * 60000).toISOString();
  db.prepare('UPDATE visits SET booked_at = ? WHERE id = ?').run(longAgo, out.visit.id);
  db.prepare('INSERT INTO sync_peers (node, pub_seq, sent_seq) VALUES (?, 0, ?)')
    .run(FAR, out.visit.cross_branch_seq);

  const win = calendarWindows(db, { doctor_ids: [8], date: DAY, days: 1 }, registrar);
  const info = win.cross.visits[out.visit.id];
  assert.ok(!info || (info.confirming === false && info.confirming_stale === false),
    'подтверждённая запись не может быть просроченной: ждать больше нечего');
  db.close();
});
