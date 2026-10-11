// PUBLIC_API_V1 — RPC онлайн-записи из API: видит тот, кому /api/db отдаёт
// карточку (оператор — свои и ничьи); решает администратор, регистратура,
// колл-центр; медсестра и врач только смотрят; филиал не решает; список —
// подписи, кандидаты по номеру семьи, действия; доска — только видимые карточки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem } from '../api/bookings.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import {
  apiBookingList, apiBookingCandidates, apiBookingConfirm, apiBookingOffer, apiBookingDecline, apiRequestAccept, apiBoardMarks, apiSyncStatus,
} from './api-bookings.js';

// Решения RPC идут без подставного времени: запись — на неделю вперёд от сегодня.
const day = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const START = localAt(day, '10:00');
const refusal = async (fn) => { try { await fn(); } catch (e) { return e; } return assert.fail('ожидался отказ'); };

async function withBooking() {
  const s = bookingSeed();
  s.db.prepare('UPDATE users SET booking_days = 30 WHERE id = 7').run();
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: Date.now() - 1000 }), { kekPath: s.kekPath });
  assert.equal(r.status, 'pending');
  const card = s.db.prepare('SELECT crm_request_id AS c FROM api_requests WHERE id = ?').get(r.id).c;
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998 90 123-45-67'), (2, 'P-2', 'Абдурахмонова Мадина', '998901234567'), (3, 'P-3', 'Чужой', '+998935550000')").run();
  return { ...s, id: r.id, card };
}

test('карта RPC и ворота лицензии: чтения — в READ_ONLY_RPCS, решения — нет', () => {
  for (const n of ['api_booking_list', 'api_booking_candidates', 'api_board_marks', 'api_sync_status']) {
    assert.equal(typeof RPC[n], 'function', n);
    assert.equal(isReadOnlyRpc(n), true, n);
  }
  for (const n of ['api_booking_confirm', 'api_booking_offer', 'api_booking_decline', 'api_request_accept']) {
    assert.equal(typeof RPC[n], 'function', n);
    assert.equal(isReadOnlyRpc(n), false, n);
  }
});

test('список: подключение, врач, что выбрал пациент и цена, срок удержания, действия; кандидаты — семья на номере, совпавшее имя первым', async () => {
  const s = await withBooking();
  const { items } = apiBookingList(s.db, { crm_request_id: s.card }, s.reg);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.deepEqual([it.status, it.partner_status, it.connection.name, it.doctor.name, it.what.name, it.what.price, it.external_id],
    ['pending', 'pending', 'med24.uz', 'Петров Пётр Петрович', 'Первичный приём', 150000, 'med-1']);
  assert.deepEqual(it.can, { confirm: true, offer: true, decline: true, accept: false });
  const c = apiBookingCandidates(s.db, { id: s.id }, s.reg).items;
  assert.deepEqual(c.map((x) => [x.id, x.why]), [[1, 'phone_name'], [2, 'phone']], 'оба на номере, совпавшее имя — первым; чужой номер — нет');
});

test('решения: регистратура подтверждает; медсестра и врач — нет; чужая карточка оператора — нет; филиал — 409', async () => {
  const s = await withBooking();
  assert.equal((await refusal(() => apiBookingConfirm(s.db, { id: s.id, patient_id: 1 }, s.nurse))).status, 403);
  s.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5, 'cc2', 'x', 'Оператор Два', 'callcenter')").run();
  s.db.prepare('UPDATE crm_requests SET assigned_to = 5 WHERE id = ?').run(s.card);
  assert.equal((await refusal(() => apiBookingList(s.db, { crm_request_id: s.card }, s.cc))).status, 403, 'карточка другого оператора не видна');
  assert.equal((await refusal(() => apiBookingConfirm(s.db, { id: s.id, patient_id: 1 }, s.reg))).status, 403, 'и регистратуре без «crm.all» — как у /api/db');
  s.db.prepare('UPDATE crm_requests SET assigned_to = NULL WHERE id = ?').run(s.card);
  s.db.prepare("UPDATE branch_identity SET role = 'secondary' WHERE id = 1").run();
  assert.equal((await refusal(() => apiBookingConfirm(s.db, { id: s.id, patient_id: 1 }, s.reg))).status, 409);
  s.db.prepare("UPDATE branch_identity SET role = 'main' WHERE id = 1").run();
  const out = await apiBookingConfirm(s.db, { id: s.id, patient_id: 1 }, s.reg);
  assert.deepEqual([out.status, typeof out.visit_id, out.already], ['confirmed', 'number', false]);
  assert.equal((await apiBookingConfirm(s.db, { id: s.id, patient_id: 1 }, s.reg)).already, true);
});

test('другое время и отказ через RPC; «Взять в работу»; доска — только видимые карточки', async () => {
  const s = await withBooking();
  const off = apiBookingOffer(s.db, { id: s.id, start: new Date(localAt(day, '15:00')).toISOString() }, s.cc);
  assert.equal(off.status, 'offered');
  const marks = apiBoardMarks(s.db, {}, s.reg).marks;
  assert.deepEqual(marks[s.card].map((m) => [m.status, m.connection_name]), [['offered', 'med24.uz']]);
  const dec = apiBookingDecline(s.db, { id: s.id, reason: 'other' }, s.admin);
  assert.equal(dec.status, 'declined');
  assert.deepEqual(apiBoardMarks(s.db, {}, s.reg).marks, {}, 'решённая — с доски уходит');
  const cb = await ingestItem(s.db, { ...apptItem({ connId: s.connId, publicId: 'rq_call0001', startMs: START, receivedMs: Date.now() }), type: 'request.new', data: { external_id: 'cb-1' } }, {});
  assert.equal(apiRequestAccept(s.db, { id: cb.id }, s.cc).status, 'accepted');
  s.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5, 'cc2', 'x', 'Оператор Два', 'callcenter')").run();
  const cardCb = s.db.prepare('SELECT crm_request_id AS c FROM api_requests WHERE id = ?').get(cb.id).c;
  s.db.prepare('UPDATE crm_requests SET assigned_to = 5 WHERE id = ?').run(cardCb);
  assert.equal(apiBoardMarks(s.db, {}, s.cc).marks[cardCb], undefined, 'чужая карточка оператора — без строки');
});

test('состояние обмена — строке «API: Просмотр» и администратору; регистратуре — нет', async () => {
  const s = await withBooking();
  const st = apiSyncStatus(s.db, {}, s.admin);
  assert.equal(typeof st.state, 'string');
  assert.equal(st.waiting_requests, 1);
  assert.equal((await refusal(() => apiSyncStatus(s.db, {}, s.reg))).status, 403);
});
