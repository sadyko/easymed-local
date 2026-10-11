// PUBLIC_API_V1 — ревью шага 8a, I2 (перевёрнутая проверка ревью
// client/zz-s8-verify-crm-screens-1-0): окно «Онлайн-запись через API» на
// НАСТОЯЩИХ ответах сервера (rpc/api-bookings.js над базой стенда онлайн-записи).
// Медсестре сервер не даёт решений — окно рисует заявку и статус, без выбора
// карты и без кнопок, и ничего не меняется; регистратуре — выбор карты и
// «Подтвердить запись», и подтверждение проходит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, onRpc, calls, walk, textOf, byAttr, buttonByText, lastToast, tick } from './api-harness.mjs';

const { apiBookingBox } = await import('../views/crm-api-booking.js');
const { bookingSeed, localAt, apptItem } = await import('../../../../server/test-helpers/api-booking-seed.js');
const { ingestItem } = await import('../../../../server/services/api/bookings.js');
const srv = await import('../../../../server/services/rpc/api-bookings.js');

// Решения RPC идут без подставного времени: запись — на неделю вперёд от сегодня.
const day = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

async function seeded() {
  const s = bookingSeed();
  s.db.prepare('UPDATE users SET booking_days = 30 WHERE id = 7').run();
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: localAt(day, '10:00'), receivedMs: Date.now() - 1000 }), { kekPath: s.kekPath });
  const card = s.db.prepare('SELECT crm_request_id AS c FROM api_requests WHERE id = ?').get(r.id).c;
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998 90 123-45-67')").run();
  return { s, id: r.id, card };
}
function mountAs(x, user) {
  const wrap = (fn) => async (body) => {
    try { return await fn(x.s.db, body, user); } catch (e) { return { __error: { message: e.message, code: e.code || '' }, status: e.status || 400 }; }
  };
  reset();
  for (const [name, fn] of [['api_booking_list', srv.apiBookingList], ['api_booking_candidates', srv.apiBookingCandidates],
    ['api_booking_confirm', srv.apiBookingConfirm], ['api_booking_decline', srv.apiBookingDecline], ['api_booking_offer', srv.apiBookingOffer]]) {
    onRpc(name, wrap(fn));
  }
  return apiBookingBox({ id: x.card }, { newPatient: async () => null });
}

test('медсестра: заявка и статус видны, решений нет, кандидатов не спрашивает, заявка не меняется', async () => {
  const x = await seeded();
  const box = mountAs(x, x.s.nurse);
  await tick(50);
  const t = textOf(box);
  assert.ok(t.includes('Онлайн-запись через API') && t.includes('Ждёт подтверждения'), t);
  assert.equal(walk(box).filter((n) => n.tagName === 'BUTTON').length, 0, 'кнопки у медсестры');
  for (const s of ['Карта пациента', 'Создать карту', 'Подтвердить запись', 'Предложить другое время', 'Отклонить']) assert.ok(!t.includes(s), 'показано: ' + s);
  assert.equal(calls.filter((c) => c[0] === 'api_booking_candidates').length, 0);
  assert.equal(lastToast(), null, 'отказа 403 не было — нечего было нажимать');
  assert.equal(x.s.db.prepare('SELECT status FROM api_requests WHERE id = ?').get(x.id).status, 'pending');
});

test('регистратура: выбор карты и «Подтвердить запись» — запись подтверждена', async () => {
  const x = await seeded();
  const box = mountAs(x, x.s.reg);
  await tick(50);
  const pick = walk(box).find((n) => n.attrs && n.attrs['data-candidate'] === '1');
  assert.ok(pick, 'кандидата нет');
  buttonByText(pick, /Выбрать/).click();
  await tick();
  byAttr(box, 'data-apib', 'confirm')[0].click();
  await tick(80);
  assert.equal(x.s.db.prepare('SELECT status FROM api_requests WHERE id = ?').get(x.id).status, 'confirmed', lastToast());
});
