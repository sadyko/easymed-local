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
  apiSyncSkippedAck,
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

// ─── РЕВЬЮ 8a, I2: «CRM: просмотр» НЕ РЕШАЕТ; КНОПКИ — ТОЛЬКО ТОМУ, КТО РЕШАЕТ ─

const NONE = { confirm: false, offer: false, decline: false, accept: false };
function setPerms(db, role, mut) {
  const p = JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);
  mut(p);
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), role);
}
async function decisions(s, user) {
  const status = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e.status; } };
  return [
    await status(() => apiBookingConfirm(s.db, { id: s.id, patient_id: 1 }, user)),
    await status(() => apiBookingOffer(s.db, { id: s.id, start: new Date(localAt(day, '15:00')).toISOString() }, user)),
    await status(() => apiBookingDecline(s.db, { id: s.id, reason: 'other' }, user)),
  ];
}

test('I2: своя роль регистратуры с «CRM: просмотр» — кнопок нет, решения 403, заявка и карточка не тронуты', async () => {
  const s = await withBooking();
  s.db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('reg_view', 'Регистратура — CRM просмотр', 'registrar')").run();
  s.db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('reg_view', JSON.stringify({ sections: ['crm', 'patients', 'calendar'], levels: { crm: 'viewer', patients: 'editor', calendar: 'editor' } }));
  s.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, custom_role_code) VALUES (20, 'regview', 'x', 'Регистратор Просмотр', 'registrar', 'reg_view')").run();
  const viewer = { id: 20, role: 'registrar', extra_roles: [], custom_role_code: 'reg_view' };
  assert.deepEqual(apiBookingList(s.db, { crm_request_id: s.card }, viewer).items[0].can, NONE);
  assert.deepEqual(await decisions(s, viewer), [403, 403, 403]);
  const cb = await ingestItem(s.db, { ...apptItem({ connId: s.connId, publicId: 'rq_call0001', startMs: START, receivedMs: Date.now() }), type: 'request.new', data: { external_id: 'cb-1' } }, {});
  assert.equal((await refusal(() => apiRequestAccept(s.db, { id: cb.id }, viewer))).status, 403);
  assert.equal(s.db.prepare('SELECT status FROM api_requests WHERE id = ?').get(s.id).status, 'pending');
  assert.equal(s.db.prepare('SELECT patient_id FROM crm_requests WHERE id = ?').get(s.card).patient_id, null);
});

test('I2: штатные регистратура (уровень CRM «просмотр») и колл-центр (CRM view в матрице) — тоже без решений', async () => {
  const s = await withBooking();
  setPerms(s.db, 'registrar', (p) => { p.levels = { ...(p.levels || {}), crm: 'viewer' }; });
  setPerms(s.db, 'callcenter', (p) => { p.grants = { ...(p.grants || {}), crm: 'view' }; });
  for (const user of [s.reg, s.cc]) {
    assert.deepEqual(apiBookingList(s.db, { crm_request_id: s.card }, user).items[0].can, NONE, user.role);
    assert.deepEqual(await decisions(s, user), [403, 403, 403], user.role);
  }
});

test('I2: медсестра и врач видят заявку без кнопок; регистратура-редактор — с кнопками; филиал — без кнопок', async () => {
  const s = await withBooking();
  for (const user of [s.nurse, { id: 7, role: 'doctor' }]) {
    assert.deepEqual(apiBookingList(s.db, { crm_request_id: s.card }, user).items[0].can, NONE, user.role);
  }
  assert.deepEqual(apiBookingList(s.db, { crm_request_id: s.card }, s.reg).items[0].can, { confirm: true, offer: true, decline: true, accept: false });
  s.db.prepare("UPDATE branch_identity SET role = 'secondary' WHERE id = 1").run();
  assert.deepEqual(apiBookingList(s.db, { crm_request_id: s.card }, s.reg).items[0].can, NONE, 'в филиале решения 409 — кнопок нет');
});

test('I4: пропущенные заявки сбрасывает только администратор (api_sync_skipped_ack); до сброса они видны в состоянии обмена', async () => {
  const s = await withBooking();
  s.db.prepare("UPDATE api_sync_state SET skipped_sealed = 2, skipped_failed = 1, skipped_last_at = '2030-03-11T04:00:00Z', skipped_last_ids = '[\"rq_a00001\"]' WHERE id = 1").run();
  assert.equal(typeof RPC.api_sync_skipped_ack, 'function');
  assert.equal(isReadOnlyRpc('api_sync_skipped_ack'), false);
  assert.equal((await refusal(() => apiSyncSkippedAck(s.db, {}, s.reg))).status, 403);
  assert.deepEqual(apiSyncStatus(s.db, {}, s.admin).skipped, { sealed: 2, failed: 1, last_at: '2030-03-11T04:00:00Z', last_ids: ['rq_a00001'] });
  assert.deepEqual(apiSyncSkippedAck(s.db, {}, s.admin), { ok: true });
  assert.deepEqual(apiSyncStatus(s.db, {}, s.admin).skipped, { sealed: 0, failed: 0, last_at: null, last_ids: [] });
});

// ─── РЕВЬЮ 8a, I6: «ДУБЛИКАТЫ» CRM НЕ ОТРЫВАЮТ ЗАЯВКУ ИЗ API ОТ КАРТОЧКИ ────

test('I6: слияние двух карточек онлайн-записей с одного номера — обе заявки на оставшейся карточке, подтверждаются, видны на доске', async () => {
  const { crmMergeLeads } = await import('./crm-merge.js');
  const s = await withBooking();
  const r2 = await ingestItem(s.db, apptItem({ connId: s.connId, publicId: 'rq_test0002', externalId: 'med-2', startMs: localAt(day, '11:00'), receivedMs: Date.now() - 500 }), { kekPath: s.kekPath });
  const card2 = s.db.prepare('SELECT crm_request_id AS c FROM api_requests WHERE id = ?').get(r2.id).c;
  crmMergeLeads(s.db, { keep_id: card2, merge_ids: [s.card] }, s.admin);
  assert.equal(s.db.prepare('SELECT crm_request_id AS c FROM api_requests WHERE id = ?').get(s.id).c, card2, 'заявка переехала за карточкой');
  assert.deepEqual(apiBookingList(s.db, { crm_request_id: card2 }, s.reg).items.map((x) => x.id).sort(), [s.id, r2.id].sort());
  assert.deepEqual(apiBoardMarks(s.db, {}, s.reg).marks[card2].map((m) => m.id).sort(), [s.id, r2.id].sort());
  const out = await apiBookingConfirm(s.db, { id: s.id, patient_id: 1 }, s.reg);
  assert.equal(out.status, 'confirmed');
});
