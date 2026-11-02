// PICK_DAY_V1 — подписи и поиск ближайшего слота (views/pick-day.js): одни на
// мастер визита и калькулятор услуг.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// I18N_LOCALE_PIN_V1 — русский ДО импорта (CI на en-US).
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { documentElement: {} };   // i18n.js ставит documentElement.lang
globalThis.window = { dispatchEvent() {} };        // setLang шлёт 'langchange'
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

const { slotWhenLabel, dayWhenLabel, nearestFree, noFreeText, nearestButtonText, manyDaysWarning, visitDayNote } = await import('../views/pick-day.js');
const { setLang } = await import('../i18n.js');

test('«вт 3 ноября 09:00» — день недели, число, месяц словом и время', () => {
  assert.equal(slotWhenLabel('2026-11-03', 9 * 60), 'вт 3 ноября 09:00');
  assert.equal(slotWhenLabel('2026-11-08', 14 * 60 + 30), 'вс 8 ноября 14:30');
  assert.equal(dayWhenLabel('2026-12-01'), 'вт 1 декабря');
  assert.equal(nearestButtonText('2026-11-03', 540), 'Ближайшее: вт 3 ноября 09:00');
  assert.equal(visitDayNote('2026-11-03'), 'Визит — вт 3 ноября: все услуги сметы в этот день');
});

test('nearestFree — первый день списка, где есть свободное, и первое время в нём', () => {
  const free = { '2026-11-03': [], '2026-11-04': [600, 630], '2026-11-05': [540] };
  assert.deepEqual(nearestFree(Object.keys(free), (d) => free[d]), { iso: '2026-11-04', min: 600 });
  assert.equal(nearestFree(['2026-11-03'], (d) => free[d]), null);
  assert.equal(nearestFree([], () => [1]), null);
});

test('предупреждение о днях: 2–4 — «дня», 5 и больше — «дней»; один день — пусто', () => {
  assert.equal(manyDaysWarning(1), '');
  assert.equal(manyDaysWarning(2), 'Услуги на 2 дня → 2 визита, 2 счёта');
  assert.equal(manyDaysWarning(4), 'Услуги на 4 дня → 4 визита, 4 счёта');
  assert.equal(manyDaysWarning(5), 'Услуги на 5 дней → 5 визитов, 5 счетов');
  assert.equal(manyDaysWarning(12), 'Услуги на 12 дней → 12 визитов, 12 счетов');
});

test('пометка: сегодня — «Сегодня…», день визита — «В этот день…»', () => {
  assert.equal(noFreeText(true), 'Сегодня у врача нет свободного времени');
  assert.equal(noFreeText(false), 'В этот день у врача нет свободного времени');
});

test('узбекский и английский — без кириллицы', () => {
  for (const lang of ['uz', 'en']) {
    setLang(lang);
    try {
      for (const s of [nearestButtonText('2026-11-03', 540), manyDaysWarning(2), manyDaysWarning(7), noFreeText(true), noFreeText(false), visitDayNote('2026-11-03')]) {
        assert.ok(!/[А-Яа-яЁё]/.test(s), lang + ': ' + s);
      }
    } finally { setLang('ru'); }
  }
});
