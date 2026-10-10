// DOCTOR_PROFILE_V1 — консультация врача: ведёт ли, по какой цене (решения
// владельца 8 и 13), сколько длится, вид для партнёров. Одно правило на кассу,
// окно записи, CRM, «Повторный визит», карточку и API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSULT_API_KINDS, CONSULT_MINUTES_DEFAULT, CONSULT_MESSAGES,
  consultPrice, consultOffered, consultMinutes, consultNames, consultRowOf, doctorConsultations, consultTypeProblem, prepareConsultTypeSave,
} from './consultation-price.js';
import { STRINGS } from '../admin/i18n-strings.js';

const CT = { id: 5, name: 'Первичный', name_ru: 'Первичный приём', name_uz: 'Dastlabki qabul', price: 100000, active: 1, duration_minutes: 30, api_kind: 'initial', sort_order: 1 };

test('цена: своя — её; «Бесплатно» — 0; 0 — настоящая цена; строка с пустой ценой — 0 (решение 13); строки нет — общая цена вида (решение 8)', () => {
  assert.deepEqual(consultPrice(CT, { price: 150000, is_free: 0 }), { price: 150000, own: true, empty: false });
  assert.deepEqual(consultPrice(CT, { price: 150000, is_free: 1 }), { price: 0, own: true, empty: false });
  assert.deepEqual(consultPrice(CT, { price: null, is_free: 1 }), { price: 0, own: true, empty: false }, '«Бесплатно» — не «цена не введена»');
  assert.deepEqual(consultPrice(CT, { price: '0', is_free: 0 }), { price: 0, own: true, empty: false });
  assert.deepEqual(consultPrice(CT, null), { price: 100000, own: false, empty: false });
  assert.deepEqual(consultPrice(CT, { price: null, is_free: 0 }), { price: 0, own: true, empty: true }, 'пустая цена в строке врача — 0, не общая цена вида');
  assert.deepEqual(consultPrice(CT, { price: '', is_free: '0' }), { price: 0, own: true, empty: true });
  assert.deepEqual(consultPrice(CT, { price: 'abc', is_free: 0 }), { price: 0, own: true, empty: true });
  assert.deepEqual(consultPrice({ price: -5 }, null), { price: 0, own: false, empty: false }, 'отрицательной цены не бывает');
  assert.deepEqual(consultPrice(null, { price: 70000 }), { price: 70000, own: true, empty: false });
});

test('ведёт ли: строка — её «Ведёт»; строки нет — врач (is_doctor) ведёт; вид выключен — никто', () => {
  assert.equal(consultOffered(CT, { available: 1 }), true);
  assert.equal(consultOffered(CT, { available: 0 }), false);
  assert.equal(consultOffered(CT, null, { is_doctor: 1 }), true);
  assert.equal(consultOffered(CT, null, { is_doctor: true }), true);
  assert.equal(consultOffered(CT, null, { is_doctor: 0, role: 'doctor' }), false, 'по is_doctor, не по роли');
  assert.equal(consultOffered(CT, null), true, 'врач не назван (кабинет самого врача) — решает строка');
  assert.equal(consultOffered({ ...CT, active: 0 }, { available: 1 }), false);
  assert.equal(consultOffered({ ...CT, active: undefined }, null), true, 'экран не спросил active — вид включён');
  assert.equal(consultOffered(null, { available: 1 }), false);
});

test('длительность: из вида; пусто или вне 5..480 — 30', () => {
  assert.equal(consultMinutes({ duration_minutes: 45 }), 45);
  for (const v of [null, 0, 4, 481, 'x']) assert.equal(consultMinutes({ duration_minutes: v }), CONSULT_MINUTES_DEFAULT, String(v));
  assert.equal(consultMinutes(null), 30);
});

test('название: своё у врача на каждом языке, иначе вида', () => {
  assert.deepEqual(consultNames(CT, { name_ru: 'Приём кардиолога', name_en: ' ' }), { ru: 'Приём кардиолога', uz: 'Dastlabki qabul', en: '' });
  assert.deepEqual(consultNames({ name: 'Старое' }, null), { ru: 'Старое', uz: '', en: '' });
});

test('строка врача по виду: из нескольких — с большим id, как касса (ORDER BY id DESC)', () => {
  const rows = [{ id: 7, doctor_id: 3, consultation_type_id: 5, price: 170000 }, { id: 4, doctor_id: 3, consultation_type_id: 5, price: 150000 },
    { id: 9, doctor_id: 4, consultation_type_id: 5, price: 1 }];
  assert.equal(consultRowOf(rows, 3, 5).price, 170000);
  assert.equal(consultRowOf([...rows].reverse(), 3, 5).price, 170000);
  assert.equal(consultRowOf(rows, 3, 6), null);
});

test('консультации врача — по порядку видов, только те, что ведёт: цена, своя ли, минуты, вид для партнёров', () => {
  const REPEAT = { id: 6, name_ru: 'Повторный приём', name_uz: 'Takroriy qabul', price: 60000, active: 1, api_kind: 'repeat', duration_minutes: 15, sort_order: 2 };
  const OFF = { id: 7, name_ru: 'Онлайн', price: 50000, active: 0, sort_order: 3 };
  const rows = [{ id: 1, doctor_id: 3, consultation_type_id: 5, price: 150000, available: 1, is_free: 0 }];
  assert.deepEqual(doctorConsultations([REPEAT, CT, OFF], rows, { id: 3, is_doctor: 1 }), [
    { consultation_type_id: 5, api_kind: 'initial', name: { ru: 'Первичный приём', uz: 'Dastlabki qabul', en: '' }, price: 150000, own: true, empty: false, minutes: 30 },
    { consultation_type_id: 6, api_kind: 'repeat', name: { ru: 'Повторный приём', uz: 'Takroriy qabul', en: '' }, price: 60000, own: false, empty: false, minutes: 15 },
  ]);
  assert.deepEqual(doctorConsultations([REPEAT, CT], [{ id: 2, doctor_id: 3, consultation_type_id: 5, available: 0 }], { id: 3, is_doctor: 1 })
    .map((c) => c.consultation_type_id), [6], '«Ведёт» снято — нет');
  assert.deepEqual(doctorConsultations([CT], [{ id: 3, doctor_id: 3, consultation_type_id: 5, price: null, available: 1, is_free: 0 }], { id: 3, is_doctor: 1 })
    .map((c) => [c.price, c.own, c.empty]), [[0, true, true]], 'строка с пустой ценой — 0 и «цена не введена» (решение 13)');
});

test('вид консультации перед записью: длительность целым 5..480, вид для партнёров — initial / repeat / пусто', () => {
  assert.equal(consultTypeProblem({ duration_minutes: 45, api_kind: 'initial' }), null);
  assert.equal(consultTypeProblem({ name: 'X' }), null, 'неприсланное не проверяется');
  assert.deepEqual(consultTypeProblem({ duration_minutes: 4 }), { field: 'duration_minutes', message: CONSULT_MESSAGES.minutes });
  assert.deepEqual(consultTypeProblem({ duration_minutes: 30.5 }), { field: 'duration_minutes', message: CONSULT_MESSAGES.minutes });
  assert.deepEqual(consultTypeProblem({ api_kind: 'first' }), { field: 'api_kind', message: CONSULT_MESSAGES.kind });
  assert.equal(consultTypeProblem({ api_kind: '' }), null);
  assert.deepEqual(CONSULT_API_KINDS, ['initial', 'repeat']);
});

test('окно «Виды консультаций»: name_ru — как name; пустая длительность не уходит; «—» снимает вид для партнёров', () => {
  const p = { name: 'Первичный приём', price: 100000, duration_minutes: 0 };
  assert.equal(prepareConsultTypeSave(p), null);
  assert.deepEqual(p, { name: 'Первичный приём', name_ru: 'Первичный приём', price: 100000, api_kind: '' });
  assert.equal(prepareConsultTypeSave({ name: 'Повторный', duration_minutes: 3, api_kind: 'repeat' }), CONSULT_MESSAGES.minutes);
});

test('сообщения переведены на ru / uz / en', () => {
  for (const m of Object.values(CONSULT_MESSAGES)) { const e = STRINGS[m]; assert.ok(e && e.ru && e.uz && e.en, m); }
});
