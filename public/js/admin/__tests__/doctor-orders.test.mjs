// DOCTOR_REFERRAL_DESK_V1 — «Направления врача»: одно чтение и одни подписи на оба окна
// регистрации (быстрая регистрация, мастер визита). Модуль без DOM — стенд: фальшивый fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CALLS = [];
let ANSWER = { data: null };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  CALLS.push({ u, body });
  if (u.startsWith('/api/rpc/patient_referral_orders')) return { ok: !ANSWER.error, json: async () => ANSWER };
  return { ok: true, json: async () => ({ data: null }) };
};
const { loadDoctorOrders, orderKind, orderStateText, bonusText, orderVsIds, dmyOf } = await import('../doctor-orders.js');

test('спрашивает сервер о направлениях именно этого пациента; пустой ответ — пустые списки', async () => {
  CALLS.length = 0; ANSWER = { data: null };
  const o = await loadDoctorOrders(77);
  assert.deepEqual(CALLS.map((c) => [c.u, c.body]), [['/api/rpc/patient_referral_orders', { patient_id: 77 }]]);
  assert.deepEqual(o, { lines: [], recommendations: [], today: null });
  assert.deepEqual(await loadDoctorOrders(0), { lines: [], recommendations: [], today: null });
  assert.equal(CALLS.length, 1, 'без пациента сервер не спрашивают');
});

test('отказ сервера — исключение со словами сервера, а не «направлений нет»', async () => {
  ANSWER = { error: { message: 'Направления врача вашей роли недоступны.' } };
  await assert.rejects(loadDoctorOrders(77), /недоступны/);
  ANSWER = { data: null };
});

test('вид строки: сегодня без счёта — к оформлению; другой день; в счёте — ждёт кассу; оплачено', () => {
  const T = '2026-11-02';
  const line = (over) => ({ day: T, bill: { state: 'none', invoice_number: null }, ...over });
  assert.equal(orderKind(line({}), T), 'ready');
  assert.equal(orderKind(line({ day: '2026-11-03' }), T), 'future');
  assert.equal(orderKind(line({ bill: { state: 'invoiced', invoice_number: 'A-12' } }), T), 'billed');
  assert.equal(orderKind(line({ bill: { state: 'paid', invoice_number: 'A-12' } }), T), 'paid');
  assert.deepEqual(orderStateText(line({ bill: { state: 'invoiced', invoice_number: 'A-12' } }), T),
    { template: 'ждёт оплаты в кассе, счёт № {no}', params: { no: 'A-12' } });
  assert.deepEqual(orderStateText(line({ bill: { state: 'paid', invoice_number: 'A-12' } }), T),
    { template: 'оплачено, счёт № {no}', params: { no: 'A-12' } });
  assert.deepEqual(orderStateText(line({ day: '2026-11-03' }), T), { template: 'на {day}', params: { day: '03.11.2026' } });
  assert.deepEqual(orderStateText(line({}), T), { template: 'сегодня — к оформлению', params: {} });
});

test('кому бонус — имена через запятую; без получателей подписи нет; номера строк направлений', () => {
  assert.deepEqual(bonusText(['Клиника Х', 'Иванов']), { template: 'Бонус: {names}', params: { names: 'Клиника Х, Иванов' } });
  assert.equal(bonusText([]), null);
  assert.equal(bonusText(['', null]), null);
  assert.deepEqual([...orderVsIds({ lines: [{ visit_service_id: 5 }, { visit_service_id: '7' }] })], [5, 7]);
  assert.equal(orderVsIds(null).size, 0);
  assert.equal(dmyOf('2026-11-03'), '03.11.2026');
});
