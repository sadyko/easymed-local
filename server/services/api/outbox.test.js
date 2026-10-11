// PUBLIC_API_V1 — события наружу: тело без данных пациента; подпись клиники
// секретом подключения проверяется секретом, который видит администратор;
// уведомление — только выбранным событиям; секрет не открыть — событие уходит
// без уведомления с пометкой.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { bookingSeed } from '../../test-helpers/api-booking-seed.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { KEK_FILE } from './secret-box.js';
import { enqueueEvent, unsentEvents, markSent, markFailed, signBody } from './outbox.js';

function withRequest(s) {
  const id = Number(s.db.prepare(`INSERT INTO api_requests (public_id, connection_id, external_id, kind, status, doctor_id, start_at, duration_minutes,
      received_at, patient_name, patient_phone, comment)
    VALUES ('rq_outbox001', ?, 'med-77', 'appointment', 'confirmed', 7, '2030-03-12T05:00:00Z', 30, '2030-03-01T00:00:00Z',
      'Абдурахмонов Фаррух', '+998901234567', 'Ребёнок 5 лет')`).run(s.connId).lastInsertRowid);
  return s.db.prepare('SELECT * FROM api_requests WHERE id = ?').get(id);
}

test('событие: тело — номер заявки, статус партнёра и детали; без имени, телефона и комментария; подпись — секретом подключения', () => {
  const s = bookingSeed();
  const request = withRequest(s);
  const id = enqueueEvent(s.db, { request, event: 'booking.confirmed', status: 'confirmed',
    details: { doctor_id: 7, start: '2030-03-12T10:00:00+05:00' }, now: Date.parse('2030-03-01T00:05:00Z'), kekPath: s.kekPath });
  const row = s.db.prepare('SELECT * FROM api_outbox WHERE id = ?').get(id);
  const body = JSON.parse(row.body);
  assert.match(body.event_id, /^ev_[0-9a-f]{24}$/);
  assert.deepEqual({ ...body, event_id: 'x' }, { event_id: 'x', event: 'booking.confirmed', request_id: 'rq_outbox001', external_id: 'med-77',
    status: 'booked', occurred_at: '2030-03-01T00:05:00Z', doctor_id: 7, start: '2030-03-12T10:00:00+05:00' });
  for (const pii of ['Абдурахмонов', '998901234567', 'Ребёнок']) assert.ok(!row.body.includes(pii), pii);
  assert.equal(row.webhook_url, 'https://med24.uz/hooks');
  assert.equal(row.signature, 'sha256=' + crypto.createHmac('sha256', s.secret).update(row.body).digest('hex'));
  assert.equal(row.signature, signBody(s.secret, row.body));
  assert.equal(row.note, '');
});

test('уведомление — только выбранному событию и при адресе; секрет не открыть — без уведомления, с пометкой', () => {
  const s = bookingSeed();
  const request = withRequest(s);
  const note = (id) => s.db.prepare('SELECT note, webhook_url, signature FROM api_outbox WHERE id = ?').get(id);
  assert.deepEqual({ ...note(enqueueEvent(s.db, { request, event: 'appointment.arrived', status: 'arrived', kekPath: s.kekPath })) },
    { note: 'not_subscribed', webhook_url: '', signature: '' });
  const otherPc = path.join(tmpDir('em-otherpc-'), KEK_FILE);
  assert.deepEqual({ ...note(enqueueEvent(s.db, { request, event: 'booking.confirmed', status: 'confirmed', kekPath: otherPc })) },
    { note: 'no_secret', webhook_url: '', signature: '' });
  s.db.prepare("UPDATE api_connections SET webhook_url = '' WHERE id = ?").run(s.connId);
  assert.equal(note(enqueueEvent(s.db, { request, event: 'booking.confirmed', status: 'confirmed', kekPath: s.kekPath })).note, 'no_webhook');
});

test('очередь: по порядку; принятые уходят, неудача копит попытки', () => {
  const s = bookingSeed();
  const request = withRequest(s);
  const a = enqueueEvent(s.db, { request, event: 'booking.confirmed', status: 'confirmed', kekPath: s.kekPath });
  const b = enqueueEvent(s.db, { request, event: 'appointment.cancelled', status: 'cancelled', kekPath: s.kekPath });
  assert.deepEqual(unsentEvents(s.db).map((r) => r.id), [a, b]);
  markFailed(s.db, [a, b], 'offline');
  markSent(s.db, [a]);
  assert.deepEqual(unsentEvents(s.db).map((r) => [r.id, r.attempts, r.last_error]), [[b, 1, 'offline']]);
});
