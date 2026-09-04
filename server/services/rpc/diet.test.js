// DIET_TABLES_V1 — лечебные столы: сервер.
//
// Проверяется то, что в отделении стоит денег и правды в истории болезни:
//   • смена стола ЗАКРЫВАЕТ предыдущий период и открывает новый — оба остаются
//     в истории (главное отличие от референса, который правит строку на месте);
//   • автором пишется ТОТ, КТО НАЖАЛ, а не лечащий врач (второе отличие от
//     референса, и оно про подделку подписи в истории болезни);
//   • стол не назначить, пока пациент не дошёл до лечения;
//   • отметка приёма пищи идемпотентна — общий планшет в коридоре;
//   • порционник считает порции по столам на ДАТУ, слушается фильтра по
//     отделению и не кормит выписанного.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  dietTablesList, admissionDietSet, admissionDietHistory,
  admissionMealMark, admissionMealsList, kitchenSheet,
  mealsForFrequency, RpcError,
} from './diet.js';

// Носитель роли: надстроечные роли живут ТОЛЬКО в extra_roles (roles.js
// EXTRA_ONLY_ROLES) — врач остаётся врачом, медсестра медсестрой.
const ACTOR = {
  admin:        { id: 9, role: 'admin' },
  doctor:       { id: 1, role: 'doctor' },                              // лечащий врач
  other_doctor: { id: 3, role: 'doctor' },                              // чужой врач
  head_doctor:  { id: 4, role: 'doctor', extra_roles: ['head_doctor'] },
  nurse:        { id: 2, role: 'nurse' },
  senior_nurse: { id: 5, role: 'nurse', extra_roles: ['senior_nurse'] },
  registrar:    { id: 6, role: 'registrar' },
  cashier:      { id: 7, role: 'cashier' },
};

const clinicToday = (db) => db.prepare("SELECT date('now','localtime') d").get().d;

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'doc', 'x', 'Лечащий', 'doctor');
  u.run(2, 'nur', 'x', 'Медсестра', 'nurse');
  u.run(3, 'doc2', 'x', 'Чужой', 'doctor');
  u.run(4, 'head', 'x', 'Главный', 'doctor');
  u.run(5, 'snur', 'x', 'Старшая', 'nurse');
  u.run(6, 'reg', 'x', 'Регистратура', 'registrar');
  u.run(7, 'cash', 'x', 'Касса', 'cashier');
  u.run(9, 'boss', 'x', 'Админ', 'admin');
  const p = db.prepare('INSERT INTO patients (id, full_name) VALUES (?,?)');
  p.run(1, 'Иванов Иван');
  p.run(2, 'Петров Пётр');
  p.run(3, 'Сидорова Мария');
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (2,'Хирургия','daily',250000)").run();
  const b = db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (?,?,?,'occupied')");
  b.run(1, 'K-1', 1); b.run(2, 'K-2', 1); b.run(3, 'X-1', 2);
  return db;
}

/** Госпитализация в заданном состоянии. */
function admission(db, { id, patient, bed, ward, status }) {
  db.prepare(`INSERT INTO admissions (id, patient_id, bed_id, ward_id, doctor_id, attending_doctor_id, status)
              VALUES (?,?,?,?,1,1,?)`).run(id, patient, bed, ward, status);
  return id;
}

/** Одна лечащаяся госпитализация — самый частый случай в тестах ниже. */
function oneActive() {
  const db = seed();
  admission(db, { id: 1, patient: 1, bed: 1, ward: 1, status: 'active' });
  return db;
}

// ─── 1. Справочник ──────────────────────────────────────────────────────────

test('справочник отдаёт пятнадцать действующих столов, без №12', () => {
  const db = oneActive();
  const { diets } = dietTablesList(db, {}, ACTOR.nurse);
  assert.equal(diets.length, 15);
  assert.deepEqual(diets.map((d) => d.code), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '13', '14', '15']);
  db.close();
});

test('погашенный стол исчезает из выбора, но виден по запросу настройки', () => {
  const db = oneActive();
  db.prepare("UPDATE diet_tables SET active = 0 WHERE code = '14'").run();
  assert.equal(dietTablesList(db, {}, ACTOR.doctor).diets.length, 14);
  assert.equal(dietTablesList(db, { include_inactive: true }, ACTOR.admin).diets.length, 15);
  db.close();
});

test('касса справочник столов не читает — это история болезни, а не счёт', () => {
  const db = oneActive();
  assert.throws(() => dietTablesList(db, {}, ACTOR.cashier), (e) => e instanceof RpcError && e.status === 403);
  db.close();
});

// ─── 2. Назначение стола: история ───────────────────────────────────────────

test('смена стола закрывает предыдущий период — в истории остаются оба', () => {
  const db = oneActive();
  const first = admissionDietSet(db, { admission_id: 1, diet_code: '15' }, ACTOR.doctor);
  assert.equal(first.changed, true);
  assert.equal(first.diet.ended_at, null);

  const second = admissionDietSet(db, { admission_id: 1, diet_code: '9', note: 'выявлен диабет' }, ACTOR.doctor);
  assert.equal(second.changed, true);
  assert.equal(second.previous.id, first.diet.id);
  assert.ok(second.previous.ended_at, 'предыдущий период ЗАКРЫТ, а не переписан');
  assert.equal(second.previous.diet_code, '15', 'старый стол в истории остался прежним');
  assert.equal(second.diet.ended_at, null);

  const { history, current } = admissionDietHistory(db, { admission_id: 1 }, ACTOR.nurse);
  assert.equal(history.length, 2, 'история хранит ОБА периода');
  assert.deepEqual(history.map((r) => r.diet_code), ['9', '15'], 'новый сверху');
  assert.equal(current.diet_code, '9');
  assert.equal(history[0].note, 'выявлен диабет');
  assert.equal(history[0].diet_name, 'Стол №9', 'имя стола подшито к строке истории');
  db.close();
});

test('автором смены записан ТОТ, КТО НАЖАЛ, а не лечащий врач', () => {
  // Ошибка референса дословно: он подписывает смену стола лечащим врачом, кто
  // бы её ни сделал. Стол в 03:40 меняет дежурная старшая медсестра.
  const db = oneActive();
  const r = admissionDietSet(db, { admission_id: 1, diet_code: '0' }, ACTOR.senior_nurse);
  assert.equal(r.diet.assigned_by, ACTOR.senior_nurse.id);
  assert.notEqual(r.diet.assigned_by, 1, 'лечащий врач (id 1) к этой записи отношения не имеет');
  const { history } = admissionDietHistory(db, { admission_id: 1 }, ACTOR.doctor);
  assert.equal(history[0].assigned_by_name, 'Старшая');
  db.close();
});

test('повтор того же назначения не плодит период нулевой длины', () => {
  const db = oneActive();
  admissionDietSet(db, { admission_id: 1, diet_code: '5' }, ACTOR.doctor);
  const again = admissionDietSet(db, { admission_id: 1, diet_code: '5' }, ACTOR.doctor);
  assert.equal(again.changed, false);
  assert.equal(admissionDietHistory(db, { admission_id: 1 }, ACTOR.doctor).history.length, 1);
  db.close();
});

test('разовость: сказанное — берётся, промолчали — сохраняется прежняя', () => {
  const db = oneActive();
  const six = admissionDietSet(db, { admission_id: 1, diet_code: '11', meals_per_day: 6 }, ACTOR.doctor);
  assert.equal(six.diet.meals_per_day, 6);
  // Перевод на другой стол без слова о разовости не должен ТИХО снять
  // шестиразовое питание у истощённого пациента.
  const next = admissionDietSet(db, { admission_id: 1, diet_code: '15' }, ACTOR.doctor);
  assert.equal(next.diet.meals_per_day, 6);
  assert.throws(() => admissionDietSet(db, { admission_id: 1, diet_code: '9', meals_per_day: 2 }, ACTOR.doctor),
    (e) => e instanceof RpcError && /3-, 4-, 5- или 6-разовым/.test(e.message));
  db.close();
});

test('N-разовое питание — фиксированный набор приёмов, а не первые N подряд', () => {
  assert.deepEqual(mealsForFrequency(3), ['breakfast', 'lunch', 'dinner']);
  assert.deepEqual(mealsForFrequency(4), ['breakfast', 'lunch', 'tea', 'dinner']);
  assert.deepEqual(mealsForFrequency(5), ['breakfast', 'breakfast2', 'lunch', 'tea', 'dinner']);
  assert.equal(mealsForFrequency(6).length, 6);
  assert.deepEqual(mealsForFrequency(99), mealsForFrequency(4), 'неизвестное N — как 4-разовое');
});

// ─── 3. Назначение стола: запреты ───────────────────────────────────────────

test('стол не назначить, пока пациент не дошёл до лечения', () => {
  const db = seed();
  admission(db, { id: 1, patient: 1, bed: null, ward: 1, status: 'ordered' });
  admission(db, { id: 2, patient: 2, bed: 1, ward: 1, status: 'admitted' });
  admission(db, { id: 3, patient: 3, bed: 2, ward: 1, status: 'examined' });

  for (const id of [1, 2, 3]) {
    assert.throws(() => admissionDietSet(db, { admission_id: id, diet_code: '15' }, ACTOR.head_doctor),
      (e) => e instanceof RpcError && e.status === 400,
      `госпитализация ${id} ещё не дошла до лечения`);
  }
  // Отказ называет НЕДОСТАЮЩИЙ ШАГ, а не «нельзя».
  assert.throws(() => admissionDietSet(db, { admission_id: 3, diet_code: '15' }, ACTOR.head_doctor),
    /Лечащий врач ещё не назначен/);
  db.close();
});

test('выписанному стол не меняют', () => {
  const db = seed();
  admission(db, { id: 1, patient: 1, bed: 1, ward: 1, status: 'discharged' });
  assert.throws(() => admissionDietSet(db, { admission_id: 1, diet_code: '15' }, ACTOR.doctor),
    (e) => e instanceof RpcError && /выписан/i.test(e.message));
  db.close();
});

test('стол меняют врач, главный врач, старшая медсестра и админ — и никто больше', () => {
  const db = oneActive();
  for (const who of ['doctor', 'head_doctor', 'senior_nurse', 'admin']) {
    const r = admissionDietSet(db, { admission_id: 1, diet_code: '15', note: who }, ACTOR[who]);
    assert.equal(r.changed, true, who);
  }
  for (const who of ['nurse', 'registrar', 'cashier']) {
    assert.throws(() => admissionDietSet(db, { admission_id: 1, diet_code: '9' }, ACTOR[who]),
      (e) => e instanceof RpcError && e.status === 403, who);
  }
  db.close();
});

test('врач меняет стол любому лежащему, а не только своему пациенту', () => {
  // Матрица плана — без оговорки «свой пациент» (в отличие от назначений):
  // стол отменяют перед экстренной операцией, и хирург не разыскивает
  // лечащего врача.
  const db = oneActive();
  const r = admissionDietSet(db, { admission_id: 1, diet_code: '0' }, ACTOR.other_doctor);
  assert.equal(r.diet.assigned_by, ACTOR.other_doctor.id);
  db.close();
});

test('несуществующий и погашенный стол назначить нельзя', () => {
  const db = oneActive();
  assert.throws(() => admissionDietSet(db, { admission_id: 1, diet_code: '12' }, ACTOR.doctor),
    /Стол не найден/, 'стола №12 не существует');
  db.prepare("UPDATE diet_tables SET active = 0 WHERE code = '14'").run();
  assert.throws(() => admissionDietSet(db, { admission_id: 1, diet_code: '14' }, ACTOR.doctor),
    /выведен из справочника/);
  db.close();
});

// ─── 3б. Право на смену стола едет вместе с историей ────────────────────────
//
// Карта госпитализации рисует кнопку «Сменить стол» по этому флагу, и считает
// его ТА ЖЕ функция, которой admissionDietSet потом откажет. Своей копии двух
// правил (роль + шаг маршрута) в браузере нет намеренно: вторая копия матрицы
// разошлась бы с первой молча, и кнопка появилась бы у того, кому сервер
// откажет, — то есть программа пообещала бы то, чего не делает.

test('can_set в истории совпадает с тем, что сервер РАЗРЕШИТ: по ролям', () => {
  const db = oneActive();
  for (const who of ['doctor', 'head_doctor', 'senior_nurse', 'admin']) {
    assert.equal(admissionDietHistory(db, { admission_id: 1 }, ACTOR[who]).can_set, true, who);
  }
  // Обычная медсестра читать стол ВПРАВЕ, менять — нет: кнопки у неё быть не
  // должно, а сам стол она видеть обязана.
  assert.equal(admissionDietHistory(db, { admission_id: 1 }, ACTOR.nurse).can_set, false);
  db.close();
});

test('can_set гаснет там же, где отказывает admissionDietSet: маршрут и выписка', () => {
  const db = seed();
  admission(db, { id: 1, patient: 1, bed: 1, ward: 1, status: 'admitted' });
  admission(db, { id: 2, patient: 2, bed: 2, ward: 1, status: 'active' });
  admission(db, { id: 3, patient: 3, bed: 3, ward: 2, status: 'discharged' });

  for (const id of [1, 3]) {
    assert.equal(admissionDietHistory(db, { admission_id: id }, ACTOR.doctor).can_set, false, 'id ' + id);
    assert.throws(() => admissionDietSet(db, { admission_id: id, diet_code: '9' }, ACTOR.doctor),
      (e) => e instanceof RpcError, 'флаг и отказ обязаны сходиться, id ' + id);
  }
  assert.equal(admissionDietHistory(db, { admission_id: 2 }, ACTOR.doctor).can_set, true);
  db.close();
});

// ─── 4. Отметка приёма пищи ─────────────────────────────────────────────────

test('отметка идемпотентна: повтор перезаписывает свою строку', () => {
  const db = oneActive();
  const day = clinicToday(db);
  admissionMealMark(db, { admission_id: 1, meal_date: day, meal_key: 'lunch', status: 'served' }, ACTOR.nurse);
  admissionMealMark(db, { admission_id: 1, meal_date: day, meal_key: 'lunch', status: 'served' }, ACTOR.nurse);
  const last = admissionMealMark(db, { admission_id: 1, meal_date: day, meal_key: 'lunch', status: 'eaten' }, ACTOR.nurse);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM admission_meals').get().c, 1, 'одна строка, а не три');
  assert.equal(last.meal.status, 'eaten', 'последнее слово за последней отметкой');
  assert.equal(last.meal.marked_by, ACTOR.nurse.id);
  db.close();
});

test('неизвестная отметка и неизвестный приём пищи отвергаются', () => {
  const db = oneActive();
  assert.throws(() => admissionMealMark(db, { admission_id: 1, meal_key: 'lunch', status: 'ate' }, ACTOR.nurse),
    /Неизвестная отметка питания/);
  assert.throws(() => admissionMealMark(db, { admission_id: 1, meal_key: 'brunch', status: 'eaten' }, ACTOR.nurse),
    /Неизвестный приём пищи/);
  assert.throws(() => admissionMealMark(db, { admission_id: 1, meal_date: '04.09.2026', meal_key: 'lunch', status: 'eaten' }, ACTOR.nurse),
    /ГГГГ-ММ-ДД/);
  db.close();
});

test('отметка идёт с размещения, но не выписанному и не заявке', () => {
  const db = seed();
  admission(db, { id: 1, patient: 1, bed: 1, ward: 1, status: 'admitted' });
  admission(db, { id: 2, patient: 2, bed: null, ward: 1, status: 'ordered' });
  admission(db, { id: 3, patient: 3, bed: 2, ward: 1, status: 'discharged' });
  // Кормят с первого часа после размещения — задолго до первичного осмотра.
  assert.equal(admissionMealMark(db, { admission_id: 1, meal_key: 'dinner', status: 'eaten' }, ACTOR.nurse).meal.status, 'eaten');
  for (const id of [2, 3]) {
    assert.throws(() => admissionMealMark(db, { admission_id: id, meal_key: 'dinner', status: 'eaten' }, ACTOR.nurse),
      /лежит в отделении/);
  }
  db.close();
});

test('отмечает питание медсестра, старшая и админ; врач и касса — нет', () => {
  const db = oneActive();
  for (const who of ['nurse', 'senior_nurse', 'admin']) {
    admissionMealMark(db, { admission_id: 1, meal_key: 'lunch', status: 'served' }, ACTOR[who]);
  }
  for (const who of ['doctor', 'registrar', 'cashier']) {
    assert.throws(() => admissionMealMark(db, { admission_id: 1, meal_key: 'lunch', status: 'served' }, ACTOR[who]),
      (e) => e instanceof RpcError && e.status === 403, who);
  }
  db.close();
});

test('лист питания разворачивает день по разовости и подшивает отметки', () => {
  const db = oneActive();
  admissionDietSet(db, { admission_id: 1, diet_code: '9', meals_per_day: 5 }, ACTOR.doctor);
  admissionMealMark(db, { admission_id: 1, meal_key: 'breakfast', status: 'eaten' }, ACTOR.nurse);
  const sheet = admissionMealsList(db, { admission_id: 1 }, ACTOR.nurse);
  assert.equal(sheet.meals.length, 5);
  assert.equal(sheet.diet_code, '9');
  assert.equal(sheet.meals[0].mark.status, 'eaten');
  assert.equal(sheet.meals[1].mark, null, 'неотмеченный приём — пустая клетка, а не выдуманная строка');
  db.close();
});

// ─── 5. Порционник ──────────────────────────────────────────────────────────

/** Отделение: три лечащихся пациента, два в терапии, один в хирургии. */
function threeInBed() {
  const db = seed();
  admission(db, { id: 1, patient: 1, bed: 1, ward: 1, status: 'active' });
  admission(db, { id: 2, patient: 2, bed: 2, ward: 1, status: 'active' });
  admission(db, { id: 3, patient: 3, bed: 3, ward: 2, status: 'active' });
  return db;
}

test('порционник считает порции по столам на дату', () => {
  const db = threeInBed();
  admissionDietSet(db, { admission_id: 1, diet_code: '5' }, ACTOR.doctor);
  admissionDietSet(db, { admission_id: 2, diet_code: '5' }, ACTOR.doctor);
  admissionDietSet(db, { admission_id: 3, diet_code: '9' }, ACTOR.doctor);

  const sheet = kitchenSheet(db, { date: clinicToday(db) }, ACTOR.nurse);
  assert.equal(sheet.total_portions, 3);
  assert.deepEqual(sheet.totals.map((t) => [t.diet_code, t.portions]), [['5', 2], ['9', 1]]);
  assert.equal(sheet.totals[0].diet_name, 'Стол №5');
  // Строка порционника называет палату, койку, пациента и стол.
  const row = sheet.rows.find((r) => r.admission_id === 1);
  assert.equal(row.ward_name, 'Терапия');
  assert.equal(row.bed_code, 'K-1');
  assert.equal(row.patient_name, 'Иванов Иван');
  assert.equal(row.diet_code, '5');
  assert.equal(row.meals_per_day, 4);
  db.close();
});

test('порционник слушается фильтра по отделению', () => {
  const db = threeInBed();
  admissionDietSet(db, { admission_id: 1, diet_code: '5' }, ACTOR.doctor);
  admissionDietSet(db, { admission_id: 2, diet_code: '5' }, ACTOR.doctor);
  admissionDietSet(db, { admission_id: 3, diet_code: '9' }, ACTOR.doctor);

  const therapy = kitchenSheet(db, { ward_id: 1 }, ACTOR.senior_nurse);
  assert.equal(therapy.total_portions, 2);
  assert.deepEqual(therapy.totals.map((t) => [t.diet_code, t.portions]), [['5', 2]]);

  const surgery = kitchenSheet(db, { ward_id: 2 }, ACTOR.senior_nurse);
  assert.deepEqual(surgery.rows.map((r) => r.patient_name), ['Сидорова Мария']);
  db.close();
});

test('выписанного в порционнике нет — на него не варят', () => {
  const db = threeInBed();
  admissionDietSet(db, { admission_id: 1, diet_code: '5' }, ACTOR.doctor);
  admissionDietSet(db, { admission_id: 2, diet_code: '5' }, ACTOR.doctor);
  db.prepare("UPDATE admissions SET status = 'discharged' WHERE id = 2").run();

  const sheet = kitchenSheet(db, {}, ACTOR.nurse);
  assert.equal(sheet.rows.some((r) => r.admission_id === 2), false);
  assert.deepEqual(sheet.totals.filter((t) => t.diet_code === '5').map((t) => t.portions), [1],
    'порций пятого стола стало на одну меньше');
  db.close();
});

test('в порционник попадает и тот, кого ещё не осмотрели: он лежит и ест', () => {
  const db = seed();
  admission(db, { id: 1, patient: 1, bed: 1, ward: 1, status: 'admitted' });
  const sheet = kitchenSheet(db, {}, ACTOR.nurse);
  assert.equal(sheet.total_portions, 1);
  // Стола нет — отдельная строка итога, а не пропуск: кухня всё равно кормит.
  assert.deepEqual(sheet.totals, [{ diet_code: null, diet_name: null, portions: 1 }]);
  db.close();
});

test('порционник на дату показывает стол, действовавший ТОГДА', () => {
  const db = oneActive();
  const day = clinicToday(db);
  admissionDietSet(db, { admission_id: 1, diet_code: '15' }, ACTOR.doctor);
  // Вчерашний период закрыт вчера же; сегодняшний открыт сегодня.
  db.prepare(`UPDATE admission_diets SET since = date('now','localtime','-3 days') || 'T08:00:00Z',
                                         ended_at = date('now','localtime','-1 day') || 'T08:00:00Z'
              WHERE admission_id = 1`).run();
  admissionDietSet(db, { admission_id: 1, diet_code: '9' }, ACTOR.doctor);

  const twoDaysAgo = db.prepare("SELECT date('now','localtime','-2 days') d").get().d;
  assert.equal(kitchenSheet(db, { date: twoDaysAgo }, ACTOR.nurse).rows[0].diet_code, '15');
  assert.equal(kitchenSheet(db, { date: day }, ACTOR.nurse).rows[0].diet_code, '9');
  db.close();
});

test('порционник читают отделение и админ, но не касса', () => {
  const db = threeInBed();
  for (const who of ['nurse', 'senior_nurse', 'head_doctor', 'admin', 'doctor']) {
    assert.equal(typeof kitchenSheet(db, {}, ACTOR[who]).total_portions, 'number', who);
  }
  for (const who of ['cashier', 'registrar']) {
    assert.throws(() => kitchenSheet(db, {}, ACTOR[who]),
      (e) => e instanceof RpcError && e.status === 403, who);
  }
  db.close();
});

// ───────────────────────────────────────────────────────────────────────────
// SOURCE_NO_CONTROL_CHARS_V1 — исходник не должен быть «бинарным».
//
// В этом файле жил НАСТОЯЩИЙ байт NUL: разделитель ключа группировки написали
// не escape-последовательностью `\0`, а самим символом. Программа от этого
// работала, а вот POSIX-grep объявлял файл двоичным («Binary file … matches»)
// и НЕ ПЕЧАТАЛ НИ ОДНОЙ СТРОКИ. То есть любой поиск по репозиторию — свой,
// ревью, CI-грепы — молча пропускал весь модуль лечебных столов. Та же беда
// была в server/services/crm/config.js.
//
// Проверяются БАЙТЫ, а не текст: в тексте такой символ невидим, и именно
// поэтому он и прожил тут так долго.
// ───────────────────────────────────────────────────────────────────────────
test('в исходниках нет управляющих символов — иначе grep объявляет файл двоичным', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    path.join(here, 'diet.js'),
    path.join(here, '..', 'crm', 'config.js'),
  ];
  for (const file of files) {
    const bytes = readFileSync(file);
    const bad = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      // Позволены только табуляция, перевод строки и возврат каретки.
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) bad.push(i + ':0x' + b.toString(16));
      if (b === 0x7f) bad.push(i + ':0x7f');
    }
    assert.deepEqual(bad, [], file + ' содержит управляющие символы: ' + bad.join(', ')
      + ' — пишите их escape-последовательностью, иначе grep перестаёт видеть файл');
  }
});
