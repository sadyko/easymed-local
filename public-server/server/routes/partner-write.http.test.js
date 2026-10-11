// PUBLIC_SERVER_V1 — заявки и онлайн-запись от партнёров: приём (данные
// пациента — только запечатанными), повтор external_id, проверки полей с field
// и reason, 409 slot_taken по присланному времени и своей очереди, статус,
// отмена, ответ на другое время, лимит записей.
import test from 'node:test';
import assert from 'node:assert/strict';
import { partnerStand, slotsFixture } from '../test-helpers/partner-stand.js';
import { NOW } from '../test-helpers/fixture.js';
import { applyEvents, ackInbox } from '../store/requests.js';
import { openSealed } from '../../../server/services/api/sync-identity.js';
import { isoOf } from '../lib/time.js';

const json = async (res) => ({ status: res.status, body: await res.json(), headers: res.headers });
const PATIENT = { name: 'ИМЯ_ПАЦИЕНТА', phone: '+998901234567', comment: 'КОММЕНТАРИЙ' };
const appt = (over = {}) => ({ doctor_id: 7, consultation: 'initial', start: '2030-03-12T09:00:00+05:00', patient: PATIENT, external_id: 'med-1', ...over });

test('онлайн-запись: 201 pending без hold_until; пациент — только запечатанным; повтор external_id — та же заявка (200)', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const r = await json(await s.send('POST', '/shifo/v1/appointments', appt()));
  assert.equal(r.status, 201);
  assert.match(r.body.request_id, /^rq_[A-Za-z0-9]{24}$/);
  assert.deepEqual([r.body.status, r.body.external_id, r.body.start, r.body.hold_until], ['pending', 'med-1', '2030-03-12T09:00:00+05:00', undefined]);
  assert.ok(!JSON.stringify(r.body).includes('ИМЯ_ПАЦИЕНТА'), 'данные пациента обратно не уходят');
  const item = s.db.prepare('SELECT * FROM inbox').get();
  assert.ok(!item.data.includes('ИМЯ') && !item.sealed.includes('ИМЯ'));
  assert.deepEqual(openSealed(s.clinic.identity, item.sealed), PATIENT, 'открыть может только клиника');
  const again = await json(await s.send('POST', '/shifo/v1/appointments', appt()));
  assert.deepEqual([again.status, again.body.request_id], [200, r.body.request_id]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 1);
});

test('время: занятое в присланном — 409; своё ждущее — 409; рядом свободное — 201; прошедшее, вне сетки, вне срока записи — 400', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const code = async (body) => { const r = await json(await s.send('POST', '/shifo/v1/appointments', body)); return [r.status, r.body.error ? r.body.error.code : r.body.status, r.body.error && r.body.error.field, r.body.error && r.body.error.reason]; };
  assert.deepEqual(await code(appt({ start: '2030-03-12T09:30:00+05:00', external_id: 'a1' })), [409, 'slot_taken', undefined, undefined], '09:45 занято — 30 минут не помещаются');
  assert.deepEqual(await code(appt({ external_id: 'a2' })), [201, 'pending', undefined, undefined]);
  assert.deepEqual(await code(appt({ start: '2030-03-12T09:15:00+05:00', external_id: 'a3' })), [409, 'slot_taken', undefined, undefined], 'перекрывает ждущую a2');
  assert.deepEqual(await code(appt({ consultation: 'repeat', start: '2030-03-12T10:15:00+05:00', external_id: 'a4' })), [201, 'pending', undefined, undefined]);
  assert.deepEqual(await code(appt({ start: '2030-03-11T08:00:00+05:00', external_id: 'a5' })), [400, 'invalid_field', 'start', 'past']);
  assert.deepEqual(await code(appt({ start: '2030-03-12T09:05:00+05:00', external_id: 'a6' })), [400, 'invalid_field', 'start', 'grid']);
  assert.deepEqual(await code(appt({ consultation: 'repeat', start: '2030-03-12T10:00', external_id: 'a10' })), [201, 'pending', undefined, undefined],
    'без смещения — время Ташкента, а не пояс машины сервера');
  assert.deepEqual(await code(appt({ start: 1900000000000, external_id: 'a11' })), [400, 'invalid_field', 'start', 'format']);
  assert.deepEqual(await code(appt({ start: '2030-03-26T09:00:00+05:00', external_id: 'a7' })), [400, 'invalid_field', 'start', 'horizon']);
  assert.deepEqual(await code(appt({ start: '2030-03-24T09:00:00+05:00', external_id: 'a8' })), [409, 'slot_taken', undefined, undefined],
    'день в пределах присланного, но его нет — врач не работает');
  // Клиника не на связи 5 дней: присланное время кончается 19-го — 24-е решит клиника (решение 19).
  s.db.prepare('UPDATE clinics SET slots = ?, slots_at = ?').run(JSON.stringify({ ...slotsFixture(), generated_at: '2030-03-06T04:00:00Z' }), '2030-03-06T04:00:00Z');
  assert.deepEqual(await code(appt({ start: '2030-03-24T09:00:00+05:00', external_id: 'a9' })), [201, 'pending', undefined, undefined],
    'день за пределами присланного времени — решит клиника');
});

test('поля: врач, вид приёма, услуга, пациент, номер партнёра — 400/404 с field и reason, без присланного значения', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const err = async (body) => { const r = await json(await s.send('POST', '/shifo/v1/appointments', body)); return [r.status, r.body.error.code, r.body.error.field, r.body.error.reason]; };
  assert.deepEqual(await err(appt({ doctor_id: 99 })), [404, 'not_found', 'doctor_id', undefined]);
  assert.deepEqual(await err(appt({ doctor_id: 8 })), [400, 'invalid_field', 'doctor_id', 'live_queue']);
  assert.deepEqual(await err(appt({ doctor_id: undefined })), [400, 'invalid_field', 'doctor_id', 'required']);
  assert.deepEqual(await err(appt({ consultation: 'vip' })), [400, 'invalid_field', 'consultation', 'unknown']);
  assert.deepEqual(await err(appt({ consultation: '', service_id: 999 })), [404, 'not_found', 'service_id', undefined]);
  assert.deepEqual(await err(appt({ patient: { name: 'Имя', phone: '12' } })), [400, 'invalid_field', 'patient.phone', 'format']);
  assert.deepEqual(await err(appt({ patient: { phone: '+998901234567' } })), [400, 'invalid_field', 'patient.name', 'required']);
  assert.deepEqual(await err(appt({ external_id: 'с пробелом' })), [400, 'invalid_field', 'external_id', 'format']);
  const raw = await json(await s.send('POST', '/shifo/v1/appointments', '{"patient":{"name":"ИМЯ_ПАЦИЕНТА"'));
  assert.deepEqual([raw.status, raw.body.error.code], [400, 'bad_json']);
  assert.ok(!JSON.stringify(raw.body).includes('ИМЯ'));
  const svc = await json(await s.send('POST', '/shifo/v1/appointments', appt({ consultation: '', service_id: 302, start: '2030-03-12T10:00:00+05:00' })));
  assert.equal(svc.status, 201, 'запись на услугу (20 минут — два окна)');
});

test('«перезвоните»: 201 new; без телефона — 400; врач не из снимка — 404', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const r = await json(await s.send('POST', '/shifo/v1/requests', { name: 'ИМЯ_ПАЦИЕНТА', phone: '+998901234567', service_id: 301, comment: 'после 18:00', external_id: 'cb-1' }));
  assert.deepEqual([r.status, r.body.status, r.body.type, r.body.service_id], [201, 'new', 'request', 301]);
  assert.deepEqual(openSealed(s.clinic.identity, s.db.prepare('SELECT sealed FROM inbox').get().sealed).comment, 'после 18:00');
  const bad = await json(await s.send('POST', '/shifo/v1/requests', { name: 'Имя' }));
  assert.deepEqual([bad.status, bad.body.error.field], [400, 'phone']);
  assert.equal((await s.send('POST', '/shifo/v1/requests', { name: 'Имя', phone: '+998901234567', doctor_id: 99 })).status, 404);
});

test('статус, отмена, другое время — только своё подключение; права', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const id = (await json(await s.send('POST', '/shifo/v1/appointments', appt()))).body.request_id;
  ackInbox(s.db, s.clinicId, '1', [{ request_id: id, hold_until: isoOf(NOW + 1800000) }], NOW);
  const st = await json(await s.get('/shifo/v1/requests/' + id));
  assert.deepEqual([st.body.status, st.body.hold_until], ['pending', '2030-03-11T09:30:00+05:00']);
  assert.equal((await s.get('/shifo/v1/requests/rq_neznayu12345')).status, 404);
  const ev = (seq, event, status, extra) => ({ seq, event, status, webhook_url: '', signature: '',
    body: JSON.stringify({ event_id: 'ev_' + seq, event, request_id: id, external_id: 'med-1', status, occurred_at: isoOf(NOW), ...extra }) });
  applyEvents(s.db, s.clinicId, [ev(1, 'booking.offered_other_time', 'offered', { offered_start: '2030-03-12T10:00:00+05:00', offer_until: '2030-03-11T09:30:00+05:00' })], NOW);
  const off = await json(await s.get('/shifo/v1/requests/' + id));
  assert.deepEqual([off.body.status, off.body.offered_start, off.body.offer_until], ['offered', '2030-03-12T10:00:00+05:00', '2030-03-11T09:30:00+05:00']);
  const acc = await json(await s.send('POST', '/shifo/v1/appointments/' + id + '/accept'));
  assert.deepEqual([acc.status, acc.body.status, acc.body.start], [200, 'pending', '2030-03-12T10:00:00+05:00']);
  const again = await json(await s.send('POST', '/shifo/v1/appointments/' + id + '/decline'));
  assert.deepEqual([again.status, again.body.error.code], [409, 'not_offered']);
  const del = await json(await s.send('DELETE', '/shifo/v1/appointments/' + id));
  assert.deepEqual([del.status, del.body.status], [200, 'cancelled']);
  assert.deepEqual(s.db.prepare('SELECT type FROM inbox ORDER BY cursor').all().map((r) => r.type), ['offer.accept', 'appointment.cancel']);
  const no = await json(await s.send('DELETE', '/shifo/v1/appointments/' + id + 'x'));
  assert.equal(no.status, 404);
});

test('права записи: без «Отмена записи» — 403; лимит записей 30 в минуту — 429', async (t) => {
  const s = await partnerStand({ scopes: ['clinic', 'slots', 'requests', 'appointments'], connection: { rate_limit: 300 } });
  t.after(s.close);
  const id = (await json(await s.send('POST', '/shifo/v1/appointments', appt()))).body.request_id;
  const del = await json(await s.send('DELETE', '/shifo/v1/appointments/' + id));
  assert.deepEqual([del.status, del.body.error.code, del.body.error.scope], [403, 'forbidden_scope', 'cancel']);
  let last;
  for (let i = 0; i < 30; i += 1) last = await s.send('POST', '/shifo/v1/requests', { name: 'Имя', phone: '+99890123456' + (i % 10), external_id: 'x' + i });
  assert.equal(last.status, 429, 'тридцать первая запись за минуту');
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
});
