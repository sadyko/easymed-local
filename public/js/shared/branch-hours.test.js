// BRANCH_PROFILE_V1 — часы здания: сетка экрана ⇄ колонки branches ⇄ движок
// записи. Движок (slot-engine.js clinicWindow) не меняется — тест сверяет с ним
// каждое состояние сетки, поэтому слоты читают часы так же, как сегодня.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WEEK, blankDays, readBranchHours, writeBranchHours, hoursProblem, storedHoursProblem, hoursGroups, HOURS_MESSAGES } from './branch-hours.js';
import { clinicWindow, WEEKDAY_KEYS } from '../../../server/services/rpc/slot-engine.js';
import { STRINGS } from '../admin/i18n-strings.js';

const engine = (cols) => WEEK.map((k) => clinicWindow(cols, WEEKDAY_KEYS.indexOf(k)));

test('«Не ограничивать» и «Круглосуточно» — движок не ставит границы ни в один день', () => {
  assert.deepEqual(writeBranchHours({ mode: 'none', days: blankDays() }), { working_hours: '{}', is_24_7: 0 });
  assert.deepEqual(writeBranchHours({ mode: 'allday', days: blankDays() }), { working_hours: '{}', is_24_7: 1 });
  for (const mode of ['none', 'allday']) {
    assert.deepEqual(engine(writeBranchHours({ mode, days: blankDays() })), WEEK.map(() => undefined), mode);
  }
});

test('по дням недели: пишутся все семь дней; неотмеченный — закрыт, часы дня — окно', () => {
  const days = blankDays();
  days.sat = { on: true, from: '09:00', to: '15:00' };
  const cols = writeBranchHours({ mode: 'week', days });
  assert.deepEqual(Object.keys(JSON.parse(cols.working_hours)), WEEK);
  assert.equal(cols.is_24_7, 0);
  const w = engine(cols);
  assert.deepEqual(w.slice(0, 5), [0, 1, 2, 3, 4].map(() => ({ from: 540, to: 1080 })));
  assert.deepEqual(w[5], { from: 540, to: 900 });
  assert.equal(w[6], null, 'воскресенье закрыто');
  assert.equal(storedHoursProblem(cols.working_hours), '');
});

test('прочитанное и записанное обратно — то же окно движка (и для старой формы с enabled)', () => {
  for (const [wh, is24] of [
    ['{}', 0], ['', 0], ['не json', 0], ['{}', 1],
    [JSON.stringify({ mon: { enabled: true, from: '08:00', to: '17:00' }, tue: { enabled: false, from: '08:00', to: '17:00' } }), 0],
    [JSON.stringify({ mon: { on: true, from: '10:00', to: '19:00' }, sun: { on: true, from: '10:00', to: '14:00' } }), 0],
    [JSON.stringify({ wed: { from: '07:30', to: '12:00' } }), 0],   // без флага — день включён (dayIsOn)
    [JSON.stringify({ thu: { on: true, from: '9:00', to: ' 17:30 ' } }), 0],   // время так, как его прочтёт parseHhmm движка
    [JSON.stringify({ fri: { on: true, from: '25:00', to: '12:00' }, sat: true }), 0],   // мусор во «с» — полночь; день не объектом — закрыт
  ]) {
    const back = writeBranchHours(readBranchHours(wh, is24));
    assert.deepEqual(engine(back), engine({ working_hours: wh, is_24_7: is24 }), wh + ' / ' + is24);
  }
});

test('экран: ни одного рабочего дня — объяснение; конец раньше начала — объяснение с днём', () => {
  const days = blankDays();
  for (const k of WEEK) days[k] = { ...days[k], on: false };
  assert.deepEqual(hoursProblem({ mode: 'week', days }), { template: HOURS_MESSAGES.noDay, day: null });
  days.tue = { on: true, from: '18:00', to: '09:00' };
  assert.deepEqual(hoursProblem({ mode: 'week', days }), { template: HOURS_MESSAGES.order, day: 'tue' });
  days.tue = { on: true, from: '09:00', to: '18:00' };
  assert.equal(hoursProblem({ mode: 'week', days }), null);
  assert.equal(hoursProblem({ mode: 'none', days }), null);
});

test('сервер: в базу — только то, что пишет экран (семь дней, ровно on/from/to)', () => {
  const good = writeBranchHours({ mode: 'week', days: blankDays() }).working_hours;
  for (const ok of [good, '{}', '']) assert.equal(storedHoursProblem(ok), '');
  const o = JSON.parse(good);
  for (const bad of [
    JSON.stringify({ mon: o.mon }),                                           // не все дни
    JSON.stringify({ ...o, mon: { ...o.mon, enabled: false } }),              // «enabled» движок прочёл бы раньше «on»
    JSON.stringify({ ...o, mon: { on: 'да', from: '09:00', to: '18:00' } }),
    JSON.stringify({ ...o, mon: { on: true, from: '9:00', to: '18:00' } }),
    JSON.stringify({ ...o, mon: { on: true, from: '18:00', to: '09:00' } }),
    JSON.stringify(Object.fromEntries(WEEK.map((k) => [k, { on: false, from: '09:00', to: '18:00' }]))),   // ни одного рабочего дня
    '[1,2]', 'не json', 42,
  ]) assert.equal(storedHoursProblem(bad), HOURS_MESSAGES.stored, String(bad));
});

test('список: подряд идущие дни с одинаковыми часами — одной группой', () => {
  const days = blankDays();
  days.sat = { on: true, from: '09:00', to: '15:00' };
  assert.deepEqual(hoursGroups({ mode: 'week', days }), [
    { from: 'mon', to: 'fri', hours: '09:00–18:00' },
    { from: 'sat', to: 'sat', hours: '09:00–15:00' },
  ]);
  assert.deepEqual(hoursGroups({ mode: 'none', days }), []);
});

test('каждое сообщение модуля переведено на ru / uz / en с теми же {дырками}', () => {
  for (const m of Object.values(HOURS_MESSAGES)) {
    const e = STRINGS[m];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + m);
    for (const hole of m.match(/\{\w+\}/g) || []) assert.ok(e.uz.includes(hole) && e.en.includes(hole), m + ' теряет ' + hole);
  }
});

// BRANCH_PROFILE_V1 (ревью шага 4, #5) — выходной день со стёртым временем: поле
// времени отдаёт '' и выключено у неотмеченного дня — владелец его не видит и не
// поправит. Экран такой день не проверяет, значит и запись не должна его ронять.
test('выходной день со стёртым временем: пишется со временем по умолчанию — сервер принимает', () => {
  const days = blankDays();
  days.sat = { on: false, from: '09:00', to: '' };
  days.sun = { on: false, from: 'мусор', to: undefined };
  const grid = { mode: 'week', days };
  assert.equal(hoursProblem(grid), null, 'экран пропускает');
  const cols = writeBranchHours(grid);
  assert.equal(storedHoursProblem(cols.working_hours), '', 'и сервер принимает то же');
  const o = JSON.parse(cols.working_hours);
  assert.deepEqual([o.sat, o.sun], [{ on: false, from: '09:00', to: '18:00' }, { on: false, from: '09:00', to: '18:00' }]);
  assert.deepEqual(engine(cols), engine({ working_hours: JSON.stringify({ ...o, sat: { on: false, from: '09:00', to: '' } }), is_24_7: 0 }),
    'движку время выходного дня безразлично');
});

test('свойство: что принимает проверка экрана, то принимает и сервер (две тысячи случайных сеток)', () => {
  let s = 11;   // mulberry32: воспроизводимо и без вырождения в числах с плавающей точкой
  const rnd = (n) => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
  const GOOD = [['09:00', '18:00'], ['00:00', '23:59'], ['12:30', '18:00'], ['08:00', '09:00']];
  const JUNK = ['', '9:00', '24:00', 'xx', undefined, null, 900, '18:00'];
  const FLAGS_OFF = [false, 0, '', undefined, null];
  let accepted = 0, offJunk = 0;
  for (let i = 0; i < 2000; i++) {
    const days = {};
    for (const k of WEEK) {
      if (!rnd(10)) continue;   // день не прислан
      if (rnd(2)) { const [from, to] = GOOD[rnd(GOOD.length)]; days[k] = { on: rnd(2) ? true : 1, from, to }; }
      else days[k] = { on: FLAGS_OFF[rnd(FLAGS_OFF.length)], from: JUNK[rnd(JUNK.length)], to: JUNK[rnd(JUNK.length)] };
    }
    for (const mode of ['week', 'none', 'allday']) {
      const grid = { mode, days };
      if (hoursProblem(grid) !== null) continue;
      if (mode === 'week') {
        accepted += 1;
        if (Object.values(days).some((d) => !d.on && !/^\d\d:\d\d$/.test(String(d.to)))) offJunk += 1;
      }
      const cols = writeBranchHours(grid);
      assert.equal(storedHoursProblem(cols.working_hours), '', mode + ' ' + JSON.stringify(days));
    }
  }
  assert.ok(accepted > 500 && offJunk > 200, 'проверка действительно перебирает принятые сетки: ' + accepted + ' / ' + offJunk);
});
