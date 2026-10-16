// CRM_LINK_ALL_V1 (редакция 2, 2026-10-16) — «ЗАПИСИ ПАЦИЕНТА» В КАРТОЧКЕ ЗАЯВКИ CRM
// (views/crm-card-bookings.js) и «Открыть в календаре» (views/calendar-focus.js): список записей
// карточки — день и время, состояние записи, врач, услуги; пусто — блок скрыт; отказ сервера —
// строка, окно работает; кнопка зовёт переход с днём записи.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, onRpc, calls, walk, textOf, byAttr, tick } from './api-harness.mjs';

const ss = new Map();
globalThis.sessionStorage = { getItem: (k) => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)), removeItem: (k) => ss.delete(k) };

const { cardBookingsBox, servicesLine, BOOKING_STATE } = await import('../views/crm-card-bookings.js');
const { setCalendarFocus, takeCalendarFocus } = await import('../views/calendar-focus.js');

const BOOKINGS = [
  { visit_id: 11, start: '2030-03-12T05:00:00Z', day: '2030-03-12', status: 'arrived', doctor: { id: 7, name: 'Петров Пётр' },
    services: [{ name: 'Приём терапевта', quantity: 1, status: 'completed' }] },
  { visit_id: 12, start: '2030-03-20T09:30:00Z', day: '2030-03-20', status: 'scheduled', doctor: null,
    services: [{ name: 'Анализ крови', quantity: 2, status: 'added' }, { name: 'УЗИ', quantity: 1, status: 'added' }] },
  { visit_id: 13, start: '2030-03-21T09:30:00Z', day: '2030-03-21', status: 'cancelled', doctor: null, services: [] },
];

test('CRM_LINK_ALL_V1 ред. 2: «Записи пациента» — каждая запись карточки: время, состояние, врач, услуги; запрос — по номеру карточки', async () => {
  reset();
  onRpc('crm_card_bookings', () => ({ request_id: 900, bookings: BOOKINGS }));
  const box = cardBookingsBox(900, { onOpenCalendar: () => {} });
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'crm_card_bookings').map((c) => c[1]), [{ request_id: 900 }]);
  assert.equal(box.style.display, '');
  const t = textOf(box);
  for (const s of ['Записи пациента', 'Пришёл', 'Записан', 'Отменён', 'Петров Пётр', 'Приём терапевта', 'Анализ крови ×2, УЗИ', 'Открыть в календаре']) {
    assert.ok(t.includes(s), 'нет: ' + s);
  }
  assert.deepEqual(byAttr(box, 'data-booking').map((n) => n.attrs['data-booking-status']), ['arrived', 'scheduled', 'cancelled']);
  assert.ok(!/сум|price/i.test(t), 'в списке деньги');
});

test('CRM_LINK_ALL_V1 ред. 2: записей нет — блок скрыт; отказ сервера — одна строка, без исключения', async () => {
  reset();
  onRpc('crm_card_bookings', () => ({ request_id: 1, bookings: [] }));
  const empty = cardBookingsBox(1);
  await tick();
  assert.equal(empty.style.display, 'none');
  assert.equal(empty.children.length, 0);
  reset();
  onRpc('crm_card_bookings', () => ({ __error: { message: 'Заявка не найдена.' }, status: 404 }));
  const failed = cardBookingsBox(2);
  await tick();
  assert.equal(failed.style.display, '');
  assert.ok(textOf(failed).includes('Записи пациента не загрузились: Заявка не найдена.'), textOf(failed));
});

test('CRM_LINK_ALL_V1 ред. 2: «Открыть в календаре» отдаёт запись; день записи доходит до календаря один раз и не старше минуты', async () => {
  reset();
  onRpc('crm_card_bookings', () => ({ request_id: 900, bookings: BOOKINGS }));
  const opened = [];
  const box = cardBookingsBox(900, { onOpenCalendar: (b) => opened.push(b.visit_id) });
  await tick();
  byAttr(box, 'data-booking-open', '12')[0].click();
  assert.deepEqual(opened, [12]);
  ss.clear();
  assert.equal(setCalendarFocus({ day: '2030-03-20', visitId: 12 }, 1000), true);
  assert.deepEqual(takeCalendarFocus(2000), { day: '2030-03-20', visitId: 12 });
  assert.equal(takeCalendarFocus(2000), null, 'просьба забрана дважды');
  setCalendarFocus({ day: '2030-03-20' }, 1000);
  assert.equal(takeCalendarFocus(1000 + 61000), null, 'устаревшая просьба увела календарь');
  assert.equal(setCalendarFocus({ day: '20.03.2030' }), false);
});

test('CRM_LINK_ALL_V1 ред. 2: подписи состояний — ключи словаря; услуги строкой', () => {
  assert.deepEqual(Object.keys(BOOKING_STATE), ['scheduled', 'confirmed', 'arrived', 'no_show', 'cancelled']);
  assert.deepEqual(Object.values(BOOKING_STATE).map((s) => s.label), ['Записан', 'Подтверждён', 'Пришёл', 'Не пришёл', 'Отменён']);
  assert.equal(servicesLine([{ name: 'A', quantity: 1 }, { name: 'B', quantity: 3 }]), 'A, B ×3');
  assert.equal(servicesLine(null), '');
  assert.ok(walk);
});
