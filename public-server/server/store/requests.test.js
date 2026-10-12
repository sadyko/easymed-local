// PUBLIC_SERVER_V1 — заявки и очередь: данные пациента только запечатанными и
// их открывает разбор клиники (parseInboxItem); подтверждение курсора стирает
// элементы целиком; held — срок держания; события клиники ведут статус;
// отмена и ответ на другое время; закрытие без ответа.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequest, requestRow, inboxItems, ackInbox, queueOverlaps, partnerCancel, partnerAnswerOffer, applyEvents,
  closeOverdue, purgeRequests, newRequestId, floorInboxCursor } from './requests.js';
import { admitClinic, saveKeys, clinicRow } from './clinics.js';
import { openSealed } from '../../../server/services/api/sync-identity.js';
import { parseInboxItem } from '../../../public/js/shared/api-booking.js';
import { testDb, testVendor, testClinic, NOW } from '../test-helpers/fixture.js';
import { isoOf } from '../lib/time.js';
import { PENDING_PER_CLINIC_MAX } from './deliveries.js';

const vendor = testVendor();
const START = Date.parse('2030-03-12T05:00:00Z');
const PATIENT = { name: 'Абдурахмонов Фаррух', phone: '+998901234567', comment: 'Ребёнок 5 лет' };

function setup() {
  const { db } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, { clinicId: c.clinicId, fingerprint: c.identity.fingerprint,
    licence: { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active' } }, NOW);
  saveKeys(db, c.clinicId, { generated_at: isoOf(NOW), box_key: c.identity.boxPublic, connections: [] }, NOW);
  return { db, c, clinic: () => clinicRow(db, c.clinicId) };
}
const appt = (s, over = {}) => createRequest(s.db, { clinic: s.clinic(), connectionId: 3, kind: 'appointment', externalId: 'med-1', lang: 'ru',
  doctorId: 7, consultation: 'initial', startAt: isoOf(START), durationMin: 30, patient: PATIENT, now: NOW, ...over });
const event = (seq, row, ev, status, extra = {}, hook = {}) => ({ seq, event: ev, status,
  body: JSON.stringify({ event_id: 'ev_' + seq, event: ev, request_id: row.id, external_id: 'med-1', status, occurred_at: isoOf(NOW), ...extra }),
  webhook_url: '', signature: '', ...hook });

test('номер заявки — как ждёт клиника', () => {
  for (let i = 0; i < 50; i += 1) assert.match(newRequestId(), /^rq_[A-Za-z0-9]{24}$/);
});

test('приём: статус без данных пациента; в очереди — запечатанные, их открывает и разбирает клиника; повтор external_id — та же заявка', () => {
  const s = setup();
  const r = appt(s);
  assert.equal(r.created, true);
  assert.equal(r.row.status, 'pending');
  assert.equal(r.row.hold_until, null, 'срок держания назначит клиника (решение 19)');
  const stored = JSON.stringify(s.db.prepare('SELECT * FROM requests').all()) + JSON.stringify(s.db.prepare('SELECT type, data FROM inbox').all());
  for (const mark of ['Абдурахмонов', '998901234567', 'Ребёнок']) assert.ok(!stored.includes(mark), 'открытым лежит: ' + mark);
  const [it] = inboxItems(s.db, s.c.clinicId, '');
  assert.equal(it.cursor, '1');
  const opened = { ...it, patient: openSealed(s.c.identity, it.sealed) };
  delete opened.sealed;
  const p = parseInboxItem(opened);
  assert.equal(p.ok, true, 'разбор клиники принимает элемент: ' + p.problem);
  assert.deepEqual(p.value.patient, PATIENT);
  assert.equal(p.value.start_at, isoOf(START));
  assert.equal(p.value.consultation, 'initial');
  const again = appt(s);
  assert.deepEqual([again.created, again.row.id], [false, r.row.id]);
  assert.equal(inboxItems(s.db, s.c.clinicId, 0).length, 1);
  s.db.prepare('UPDATE clinics SET box_key = NULL').run();
  assert.deepEqual(appt(s, { externalId: 'med-9' }), { error: 'clinic_offline' });
});

test('«перезвоните»: разбор клиники принимает; доставка = ответ (событий клиника не шлёт)', () => {
  const s = setup();
  const r = createRequest(s.db, { clinic: s.clinic(), connectionId: 3, kind: 'request', patient: PATIENT, serviceId: 301, now: NOW });
  assert.equal(r.row.status, 'new');
  const [it] = inboxItems(s.db, s.c.clinicId, 0);
  assert.equal(parseInboxItem({ ...it, patient: openSealed(s.c.identity, it.sealed) }).ok, true);
  ackInbox(s.db, s.c.clinicId, it.cursor, [], NOW + 1000);
  const row = requestRow(s.db, s.c.clinicId, r.row.id);
  assert.equal(row.delivered_at, isoOf(NOW + 1000));
  assert.equal(row.answered_at, isoOf(NOW + 1000));
});

test('подтверждение курсора: элементы до курсора стёрты целиком; held — срок держания; чужое и мусор не действуют', () => {
  const s = setup();
  const a = appt(s).row;
  const b = appt(s, { externalId: 'med-2', startAt: isoOf(START + 3600000) }).row;
  assert.deepEqual(ackInbox(s.db, s.c.clinicId, 'x', [], NOW), { error: 'bad_request' });
  const r = ackInbox(s.db, s.c.clinicId, '1', [{ request_id: a.id, hold_until: '2030-03-11T04:30:00Z' }, { request_id: 'rq_чужой', hold_until: 'нет' }], NOW + 1000);
  assert.deepEqual(r, { ok: true, deleted: 1 });
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE sealed IS NOT NULL').get().n, 1, 'второй ещё ждёт');
  const ra = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual([ra.hold_until, ra.delivered_at, ra.answered_at], ['2030-03-11T04:30:00Z', isoOf(NOW + 1000), isoOf(NOW + 1000)]);
  assert.equal(requestRow(s.db, s.c.clinicId, b.id).delivered_at, null);
  ackInbox(s.db, s.c.clinicId, '2', [], NOW + 2000);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);
});

test('занятость своей очередью: ждущая и предложенная держат, истёкшая — нет', () => {
  const s = setup();
  const a = appt(s).row;
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 7, START + 15 * 60000, 15, NOW), true);
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 7, START + 30 * 60000, 15, NOW), false, 'сразу после — свободно');
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 8, START, 15, NOW), false, 'другой врач');
  s.db.prepare("UPDATE requests SET hold_until = ? WHERE id = ?").run(isoOf(NOW - 1000), a.id);
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 7, START, 15, NOW), false, 'срок вышел');
  s.db.prepare("UPDATE requests SET status = 'offered', offered_start = ?, offer_until = ? WHERE id = ?").run(isoOf(START + 7200000), isoOf(NOW + 60000), a.id);
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 7, START + 7200000, 15, NOW), true);
});

test('отмена пациентом: ждущая — сразу cancelled; записанная — ждёт клинику; повтор — без нового элемента; отказанную — нельзя', () => {
  const s = setup();
  const a = appt(s).row;
  assert.equal(partnerCancel(s.db, a, NOW).row.status, 'cancelled');
  assert.deepEqual(inboxItems(s.db, s.c.clinicId, 0).map((i) => i.type), ['appointment.new', 'appointment.cancel']);
  const b = appt(s, { externalId: 'med-2' }).row;
  s.db.prepare("UPDATE requests SET status = 'booked' WHERE id = ?").run(b.id);
  const r = partnerCancel(s.db, requestRow(s.db, s.c.clinicId, b.id), NOW);
  assert.equal(r.row.status, 'booked');
  assert.ok(r.row.cancel_requested_at);
  partnerCancel(s.db, r.row, NOW);
  assert.equal(inboxItems(s.db, s.c.clinicId, 0).filter((i) => i.type === 'appointment.cancel').length, 2, 'повтор — без нового элемента');
  s.db.prepare("UPDATE requests SET status = 'declined' WHERE id = ?").run(b.id);
  assert.deepEqual(partnerCancel(s.db, requestRow(s.db, s.c.clinicId, b.id), NOW), { error: 'not_cancellable' });
});

test('другое время: согласие в срок — pending на новом времени; после срока — offer_expired; отказ — cancelled', () => {
  const s = setup();
  const a = appt(s).row;
  assert.deepEqual(partnerAnswerOffer(s.db, a, true, NOW), { error: 'not_offered' });
  const offered = isoOf(START + 7200000);
  s.db.prepare("UPDATE requests SET status = 'offered', offered_start = ?, offer_until = ?, delivered_at = ?, answered_at = ? WHERE id = ?")
    .run(offered, isoOf(NOW + 60000), isoOf(NOW), isoOf(NOW), a.id);
  const row = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual(partnerAnswerOffer(s.db, row, true, NOW + 61000), { error: 'offer_expired' });
  const ok = partnerAnswerOffer(s.db, row, true, NOW + 1000).row;
  assert.deepEqual([ok.status, ok.start_at, ok.offered_start, ok.delivered_at, ok.answered_at], ['pending', offered, null, null, null]);
  assert.equal(inboxItems(s.db, s.c.clinicId, 0).at(-1).type, 'offer.accept');
  const b = appt(s, { externalId: 'med-2', startAt: isoOf(START + 86400000) }).row;
  s.db.prepare("UPDATE requests SET status = 'offered', offered_start = ?, offer_until = ? WHERE id = ?").run(offered, isoOf(NOW + 60000), b.id);
  assert.equal(partnerAnswerOffer(s.db, requestRow(s.db, s.c.clinicId, b.id), false, NOW).row.status, 'cancelled');
  assert.equal(inboxItems(s.db, s.c.clinicId, 0).at(-1).type, 'offer.decline');
});

test('события клиники: статус, повтор seq, испорченное принято без действия, уведомление — только с адресом и подписью', () => {
  const s = setup();
  const a = appt(s).row;
  const sig = 'sha256=' + 'a'.repeat(64);
  const offer = event(1, a, 'booking.offered_other_time', 'offered', { offered_start: '2030-03-12T12:00:00+05:00', offer_until: '2030-03-11T09:30:00+05:00' },
    { webhook_url: 'https://med24.uz/hooks', signature: sig });
  const r = applyEvents(s.db, s.c.clinicId, [
    offer,
    { seq: 2, event: 'booking.confirmed', body: '{испорчено' },
    { seq: 'x' },
    event(3, a, 'booking.declined', 'declined', { reason: 'slot_taken' }, { webhook_url: 'http://10.0.0.1/x', signature: sig }),
  ], NOW);
  assert.deepEqual(r.accepted, [1, 2, 3]);
  const row = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual([row.status, row.reason, row.offered_start, row.offer_until], ['declined', 'slot_taken', null, null]);
  const d = s.db.prepare('SELECT * FROM deliveries').all();
  assert.equal(d.length, 1, 'адрес http и частный IP в очередь доставки не встаёт');
  assert.equal(d[0].url, 'https://med24.uz/hooks');
  assert.equal(d[0].body, offer.body, 'тело — байт в байт как подписала клиника');
  assert.equal(d[0].connection_id, 3);
  assert.deepEqual(applyEvents(s.db, s.c.clinicId, [offer], NOW).accepted, [1]);
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'declined', 'повтор seq с тем же телом ничего не меняет');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 1, 'и второго уведомления нет');
  applyEvents(s.db, s.c.clinicId, [event(4, a, 'booking.confirmed', 'booked', { start: '2030-03-12T10:00:00+05:00', branch_id: 1 })], NOW);
  const b = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual([b.status, b.reason, b.start_at, b.branch_id], ['booked', null, '2030-03-12T05:00:00Z', 1]);
});

test('отменённое партнёром не превращается в «истекло» от клиники, не дошедшей до отмены', () => {
  const s = setup();
  const a = appt(s).row;
  partnerCancel(s.db, a, NOW);
  applyEvents(s.db, s.c.clinicId, [event(1, a, 'booking.declined', 'expired', { reason: 'expired' })], NOW + 1000);
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'cancelled');
});

test('закрытие без ответа: забрала и молчит 30 минут — not_processed; не забрала сутки (решение владельца 20) — not_collected, шифротекст стёрт', () => {
  const s = setup();
  const quiet = appt(s).row;
  const held = appt(s, { externalId: 'med-2', startAt: isoOf(START + 3600000) }).row;
  const callback = createRequest(s.db, { clinic: s.clinic(), connectionId: 3, kind: 'request', patient: PATIENT, now: NOW }).row;
  ackInbox(s.db, s.c.clinicId, '3', [{ request_id: held.id, hold_until: isoOf(NOW + 1800000) }], NOW);
  assert.deepEqual(closeOverdue(s.db, NOW + 29 * 60000), { not_processed: 0, not_collected: 0 });
  assert.deepEqual(closeOverdue(s.db, NOW + 31 * 60000), { not_processed: 1, not_collected: 0 });
  const q = requestRow(s.db, s.c.clinicId, quiet.id);
  assert.deepEqual([q.status, q.reason], ['closed', 'not_processed']);
  assert.equal(requestRow(s.db, s.c.clinicId, held.id).status, 'pending');
  assert.equal(requestRow(s.db, s.c.clinicId, callback.id).status, 'new');
  const late = appt(s, { externalId: 'med-3', startAt: isoOf(START + 7200000) }).row;
  assert.deepEqual(closeOverdue(s.db, NOW + 86400000 - 1000), { not_processed: 0, not_collected: 0 }, 'сутки ещё не прошли');
  assert.deepEqual(closeOverdue(s.db, NOW + 86400000 + 1000, { uncollectedMaxMs: 48 * 3600000 }), { not_processed: 0, not_collected: 0 },
    'срок — настройка PUBLIC_UNCOLLECTED_MAX_HOURS');
  assert.deepEqual(closeOverdue(s.db, NOW + 86400000 + 1000), { not_processed: 0, not_collected: 1 });
  assert.deepEqual([requestRow(s.db, s.c.clinicId, late.id).status, requestRow(s.db, s.c.clinicId, late.id).reason], ['closed', 'not_collected']);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);
  applyEvents(s.db, s.c.clinicId, [event(9, quiet, 'booking.declined', 'declined', { reason: 'slot_taken' })], NOW + 32 * 60000);
  assert.equal(requestRow(s.db, s.c.clinicId, quiet.id).status, 'declined', 'позднее слово клиники сильнее закрытия');
});

test('без данных пациента — отмена пациентом записанного визита — ждёт клинику 7 суток: решение 20 — о заявках с шифротекстом', () => {
  const s = setup();
  const a = appt(s).row;
  ackInbox(s.db, s.c.clinicId, '1', [{ request_id: a.id, hold_until: isoOf(NOW + 1800000) }], NOW);
  s.db.prepare("UPDATE requests SET status = 'booked' WHERE id = ?").run(a.id);
  partnerCancel(s.db, requestRow(s.db, s.c.clinicId, a.id), NOW);
  assert.deepEqual(closeOverdue(s.db, NOW + 3 * 86400000), { not_processed: 0, not_collected: 0 });
  assert.deepEqual(inboxItems(s.db, s.c.clinicId, 0).map((i) => [i.type, i.sealed]), [['appointment.cancel', undefined]],
    'клиника, выключенная на выходные, всё равно узнает об отмене визита');
  closeOverdue(s.db, NOW + 7 * 86400000 + 1000);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0, 'клиника молчит 7 суток — элемент снят');
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'booked');
});

test('уборка: статусы старше 90 дней, номера событий старше 30 дней', () => {
  const s = setup();
  appt(s);
  applyEvents(s.db, s.c.clinicId, [{ seq: 1, event: 'x', body: '' }], NOW);
  assert.deepEqual(purgeRequests(s.db, NOW + 31 * 86400000), { requests: 0, events: 1 });
  assert.deepEqual(purgeRequests(s.db, NOW + 91 * 86400000), { requests: 1, events: 0 });
});

test('ревью 8b, C2: базу клиники восстановили — новое событие с прежним номером применяется; точный повтор — нет', () => {
  const s = setup();
  const a = appt(s).row;
  const hook = { webhook_url: 'https://med24.uz/hooks', signature: 'sha256=' + 'a'.repeat(64) };
  assert.deepEqual(applyEvents(s.db, s.c.clinicId, [event(1, a, 'booking.confirmed', 'booked', {}, hook)], NOW).accepted, [1]);
  // Клиника восстановила свою базу из копии: номера событий пошли заново.
  const after = event(1, a, 'appointment.cancelled', 'cancelled', {}, hook);
  assert.deepEqual(applyEvents(s.db, s.c.clinicId, [after], NOW + 1000).accepted, [1]);
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'cancelled', 'новое событие с прежним номером не потеряно');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 2, 'и уведомление о нём встало в очередь');
  assert.deepEqual(applyEvents(s.db, s.c.clinicId, [after], NOW + 2000).accepted, [1]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 2, 'точный повтор (ответ сервера потерялся) — без второго уведомления');
});

test('ревью 8b, C3: базу сервера восстановили или собрали заново — курсор очереди не идёт назад, клиника получает всё неподтверждённое', () => {
  const s = setup();
  appt(s);
  appt(s, { externalId: 'med-2', startAt: isoOf(START + 3600000) });
  const held = inboxItems(s.db, s.c.clinicId, '');
  const clinicCursor = held.at(-1).cursor;
  // База сервера собрана заново: очереди нет, счётчик курсоров — с нуля.
  s.db.prepare('DELETE FROM inbox').run();
  s.db.prepare("UPDATE sqlite_sequence SET seq = 0 WHERE name = 'inbox'").run();
  floorInboxCursor(s.db, NOW + 60000);   // запуск службы
  const fresh = appt(s, { externalId: 'med-3', startAt: isoOf(START + 7200000) }).row;
  const items = inboxItems(s.db, s.c.clinicId, clinicCursor);
  assert.deepEqual(items.map((i) => i.public_id), [fresh.id], 'курсор клиники впереди — новая заявка всё равно отдаётся');
  assert.ok(Number(items[0].cursor) > Number(clinicCursor), 'курсор не пошёл назад');
  assert.deepEqual(ackInbox(s.db, s.c.clinicId, items[0].cursor, [], NOW + 61000), { ok: true, deleted: 1 });
  floorInboxCursor(s.db, NOW);   // повторный запуск с часами раньше — не откатывает
  appt(s, { externalId: 'med-4', startAt: isoOf(START + 10800000) });
  const [next] = inboxItems(s.db, s.c.clinicId, '');
  assert.ok(Number(next.cursor) > Number(items[0].cursor), 'запуск с отставшими часами курсор не откатывает');
});

test('ревью 8b, C8: очередь уведомлений клиники полна — событие принято и применено, уведомление пропущено и сосчитано', () => {
  const s = setup();
  const a = appt(s).row;
  s.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
                INSERT INTO deliveries (clinic_id, event_id, event, url, body, signature, next_at, created_at, updated_at)
                SELECT ?, 'ev_' || i, 'booking.confirmed', 'https://med24.uz/h', '{}', 's', ?, ?, ? FROM n`)
    .run(PENDING_PER_CLINIC_MAX, s.c.clinicId, isoOf(NOW), isoOf(NOW), isoOf(NOW));
  const hook = { webhook_url: 'https://med24.uz/hooks', signature: 'sha256=' + 'a'.repeat(64) };
  const r = applyEvents(s.db, s.c.clinicId, [event(1, a, 'booking.confirmed', 'booked', {}, hook)], NOW);
  assert.deepEqual(r, { accepted: [1], queue_full: 1 });
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'booked', 'статус партнёру всё равно обновлён — он увидит его в GET /requests/{id}');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, PENDING_PER_CLINIC_MAX, 'сверх потолка строк нет');
  s.db.prepare("UPDATE deliveries SET state = 'delivered' WHERE id = 1").run();
  assert.deepEqual(applyEvents(s.db, s.c.clinicId, [event(2, a, 'booking.declined', 'declined', { reason: 'slot_taken' }, hook)], NOW), { accepted: [2], queue_full: 0 });
});

test('ревью 8b, C9: клиника предложила другое время, пока согласие партнёра на прежнее ехало к ней — согласие снято, партнёр видит новое предложение', () => {
  const s = setup();
  const a = appt(s).row;
  const offerAt = (seq, startIso) => event(seq, a, 'booking.offered_other_time', 'offered', { offered_start: startIso, offer_until: isoOf(NOW + 1800000) });
  applyEvents(s.db, s.c.clinicId, [offerAt(1, '2030-03-12T07:00:00Z')], NOW);
  const off = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual(partnerAnswerOffer(s.db, off, true, NOW + 1000, { offeredStart: Date.parse('2030-03-12T09:00:00Z') }), { error: 'offer_changed' },
    'партнёр отвечает на другое предложение — 409');
  const acc = partnerAnswerOffer(s.db, off, true, NOW + 1000, { offeredStart: Date.parse('2030-03-12T07:00:00Z') });
  assert.equal(acc.row.status, 'pending');
  const [item] = inboxItems(s.db, s.c.clinicId, '').filter((i) => i.type === 'offer.accept');
  assert.equal(item.data.offered_start, '2030-03-12T07:00:00Z', 'клиника видит, на какое предложение ответ');
  // Регистратор тем временем предложил 14:00: событие приходит раньше, чем клиника заберёт очередь.
  applyEvents(s.db, s.c.clinicId, [offerAt(2, '2030-03-12T09:00:00Z')], NOW + 2000);
  assert.deepEqual(inboxItems(s.db, s.c.clinicId, '').filter((i) => i.type === 'offer.accept'), [], 'согласие на прежнее время не дойдёт до нового предложения');
  const now = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual([now.status, now.offered_start], ['offered', '2030-03-12T09:00:00Z']);
});

test('ревью 8b, C9: то же предложение ещё раз, пока согласие на него в очереди, — согласие остаётся, статус pending', () => {
  const s = setup();
  const a = appt(s).row;
  const offer = (seq) => event(seq, a, 'booking.offered_other_time', 'offered', { offered_start: '2030-03-12T07:00:00Z', offer_until: isoOf(NOW + 1800000) });
  applyEvents(s.db, s.c.clinicId, [offer(1)], NOW);
  partnerAnswerOffer(s.db, requestRow(s.db, s.c.clinicId, a.id), true, NOW + 1000);
  applyEvents(s.db, s.c.clinicId, [offer(2)], NOW + 2000);
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'pending');
  assert.equal(inboxItems(s.db, s.c.clinicId, '').filter((i) => i.type === 'offer.accept').length, 1);
});

test('ревью 8b, C10: «другое время» от клиники, не дошедшей до отмены или отказа партнёра, отмену не перебивает — время свободно', () => {
  const s = setup();
  const a = appt(s).row;
  partnerCancel(s.db, a, NOW);
  applyEvents(s.db, s.c.clinicId, [event(1, a, 'booking.offered_other_time', 'offered', { offered_start: '2030-03-12T07:00:00Z', offer_until: isoOf(NOW + 1800000) })],
    NOW + 1000);
  applyEvents(s.db, s.c.clinicId, [event(2, a, 'booking.confirmed', 'pending')], NOW + 2000);
  const r = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual([r.status, r.offered_start], ['cancelled', null], 'отмена партнёра сильнее предложения в пути');
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 7, Date.parse('2030-03-12T07:00:00Z'), 15, NOW + 3000), false, 'призрачное предложение время не держит');
  assert.deepEqual(partnerAnswerOffer(s.db, r, true, NOW + 3000), { error: 'not_offered' });
  applyEvents(s.db, s.c.clinicId, [event(3, a, 'appointment.created', 'booked', { start: '2030-03-12T10:00:00+05:00' })], NOW + 4000);
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'booked', 'клиника записала до отмены — это итог, а не «в пути»');
});

test('ревью 8b, C10: отказ партнёра от другого времени держится как отмена — новое предложение клиники в пути его не перебивает', () => {
  const s = setup();
  const a = appt(s).row;
  const offer = (seq, start) => event(seq, a, 'booking.offered_other_time', 'offered', { offered_start: start, offer_until: isoOf(NOW + 1800000) });
  applyEvents(s.db, s.c.clinicId, [offer(1, '2030-03-12T07:00:00Z')], NOW);
  const r = partnerAnswerOffer(s.db, requestRow(s.db, s.c.clinicId, a.id), false, NOW + 1000).row;
  assert.equal(r.status, 'cancelled');
  assert.ok(r.cancel_requested_at, 'отказ отмечен как отмена партнёром');
  applyEvents(s.db, s.c.clinicId, [offer(2, '2030-03-12T09:00:00Z')], NOW + 2000);
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'cancelled', 'клиника применит отказ к своему предложению — обе стороны «отменено»');
  assert.deepEqual(inboxItems(s.db, s.c.clinicId, '').filter((i) => i.type === 'offer.decline').length, 1, 'отказ доходит до клиники');
});

test('ревью 8b, C11: заявку, отданную клинике в GET, уборка не закрывает, пока ждёт подтверждения; поздний held оживляет закрытую сервером', () => {
  const s = setup();
  const a = appt(s).row;
  const cb = createRequest(s.db, { clinic: s.clinic(), connectionId: 3, kind: 'request', patient: PATIENT, now: NOW }).row;
  const DAY = 86400000;
  const items = inboxItems(s.db, s.c.clinicId, '', { now: NOW + DAY - 5000 });   // клиника вернулась за 5 секунд до срока
  assert.equal(items.length, 2);
  assert.deepEqual(closeOverdue(s.db, NOW + DAY + 1000), { not_processed: 0, not_collected: 0 }, 'отдано клинике — не закрывать, пока она подтверждает');
  assert.deepEqual(ackInbox(s.db, s.c.clinicId, items.at(-1).cursor, [{ request_id: a.id, hold_until: isoOf(NOW + DAY + 1800000) }], NOW + DAY + 2000),
    { ok: true, deleted: 2 });
  assert.deepEqual([requestRow(s.db, s.c.clinicId, a.id).status, requestRow(s.db, s.c.clinicId, a.id).hold_until], ['pending', isoOf(NOW + DAY + 1800000)]);
  assert.equal(requestRow(s.db, s.c.clinicId, cb.id).status, 'new');
  // Отдано, но подтверждения нет дольше запаса — закрывается как обычно.
  const b = appt(s, { externalId: 'med-2', startAt: isoOf(START + 3600000) }).row;
  inboxItems(s.db, s.c.clinicId, '', { now: NOW + 1000 });
  assert.deepEqual(closeOverdue(s.db, NOW + DAY + 1000), { not_processed: 0, not_collected: 1 });
  // Клиника всё же подтвердила позже и держит время — заявка оживает.
  ackInbox(s.db, s.c.clinicId, '0', [{ request_id: b.id, hold_until: isoOf(NOW + DAY + 1800000) }], NOW + DAY + 3000);
  const rb = requestRow(s.db, s.c.clinicId, b.id);
  assert.deepEqual([rb.status, rb.reason, rb.hold_until], ['pending', null, isoOf(NOW + DAY + 1800000)]);
  assert.ok(rb.delivered_at);
});
