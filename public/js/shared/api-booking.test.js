// PUBLIC_API_V1 — общий модуль заявок из API: удержание, статусы, действия,
// разбор входящего, тело уведомления без данных пациента.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../admin/i18n-strings.js';
import {
  HOLD_MINUTES, STATUSES, STATUS_LABEL, PARTNER_STATUS, DECLINE_REASONS, DECLINE_LABEL, STAFF_DECLINE_REASONS,
  API_BOOKING_MESSAGES, eventsKnown, isoOf, localIso, holdUntilFor, holdState, shownStatus, bookingActions,
  parseInboxItem, webhookBody, WEBHOOK_DETAIL_KEYS,
} from './api-booking.js';

const T0 = Date.parse('2026-10-11T09:00:00Z');

test('удержание: 30 минут от приёма заявки, но не дольше начала приёма; мусор — пусто', () => {
  assert.equal(HOLD_MINUTES, 30);
  assert.equal(holdUntilFor('2026-10-11T09:00:00Z', '2026-10-20T05:00:00Z'), '2026-10-11T09:30:00Z');
  assert.equal(holdUntilFor('2026-10-11T09:00:00Z', '2026-10-11T09:15:00Z'), '2026-10-11T09:15:00Z');
  assert.equal(holdUntilFor('вчера', '2026-10-11T09:15:00Z'), '');
  assert.equal(isoOf(T0), '2026-10-11T09:00:00Z');
  assert.equal(localIso(Date.parse('2026-10-07T08:30:00Z'), 300), '2026-10-07T13:30:00+05:00');
});

// PUBLIC_API_V1 — решение владельца 18 (2026-10-11): 30 РАБОЧИХ минут клиники.
// Местное время строится конструктором Date — тест не зависит от пояса машины.
// 2030-03-11 — понедельник; часы здания пн–сб 08:00–18:00, вс — выходной.
const L = (day, hhmm) => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); };
const at = (day, hhmm) => isoOf(L(day, hhmm));
const MON_SAT_8_18 = (ms) => (new Date(ms).getDay() === 0 ? null : { from: 8 * 60, to: 18 * 60 });
const FAR = at('2030-04-01', '10:00');

test('рабочие минуты (решение 18): в часы — +30; вечером — остаток утром; ночью — до 08:30; выходной пропускается; до открытия — от открытия', () => {
  const hold = (day, hhmm, start = FAR) => holdUntilFor(at(day, hhmm), start, { openOn: MON_SAT_8_18 });
  assert.equal(hold('2030-03-11', '10:00'), at('2030-03-11', '10:30'));
  assert.equal(hold('2030-03-11', '17:50'), at('2030-03-12', '08:20'), '10 минут сегодня и 20 завтра');
  assert.equal(hold('2030-03-11', '22:00'), at('2030-03-12', '08:30'));
  assert.equal(hold('2030-03-16', '17:45'), at('2030-03-18', '08:15'), 'суббота → понедельник: воскресенье закрыто');
  assert.equal(hold('2030-03-17', '12:00'), at('2030-03-18', '08:30'), 'заявка в выходной');
  assert.equal(hold('2030-03-11', '06:00'), at('2030-03-11', '08:30'));
  assert.equal(hold('2030-03-11', '22:00', at('2030-03-12', '08:15')), at('2030-03-12', '08:15'), 'не дольше начала приёма');
});

test('рабочие минуты: часы не заданы или «круглосуточно» — 30 минут круглые сутки; ни одного рабочего дня — тоже', () => {
  assert.equal(holdUntilFor(at('2030-03-11', '22:00'), FAR, { openOn: () => undefined }), at('2030-03-11', '22:30'));
  assert.equal(holdUntilFor(at('2030-03-11', '22:00'), FAR, { openOn: null }), at('2030-03-11', '22:30'));
  assert.equal(holdUntilFor(at('2030-03-11', '22:00'), FAR, { openOn: () => null }), at('2030-03-11', '22:30'));
  assert.equal(holdUntilFor(at('2030-03-11', '22:00'), FAR, { minutes: 10, openOn: MON_SAT_8_18 }), at('2030-03-12', '08:10'));
});

test('состояние удержания и статус для экрана: истёкшее — «не подтверждено вовремя» до прохода фона', () => {
  const pending = { kind: 'appointment', status: 'pending', hold_until: '2026-10-11T09:30:00Z' };
  assert.equal(holdState(pending, T0), 'held');
  assert.equal(holdState(pending, T0 + 30 * 60000), 'expired', 'ровно в срок — уже не держится');
  assert.equal(shownStatus(pending, T0 + 31 * 60000), 'expired');
  const offered = { kind: 'appointment', status: 'offered', hold_until: '2026-10-11T09:01:00Z', offer_until: '2026-10-11T09:40:00Z' };
  assert.equal(holdState(offered, T0 + 35 * 60000), 'held', 'у предложения — свой срок');
  assert.equal(holdState({ status: 'confirmed', hold_until: '2026-10-11T09:30:00Z' }, T0), 'none');
});

test('действия: подтвердить — только ждущую с живым удержанием; взять в работу — только новую заявку без времени', () => {
  const p = { kind: 'appointment', status: 'pending', hold_until: '2026-10-11T09:30:00Z' };
  assert.deepEqual(bookingActions(p, T0), { confirm: true, offer: true, decline: true, accept: false });
  assert.deepEqual(bookingActions(p, T0 + 3600000), { confirm: false, offer: false, decline: false, accept: false });
  assert.deepEqual(bookingActions({ ...p, status: 'offered', offer_until: '2026-10-11T09:30:00Z' }, T0),
    { confirm: false, offer: true, decline: true, accept: false });
  assert.deepEqual(bookingActions({ kind: 'request', status: 'new' }, T0), { confirm: false, offer: false, decline: false, accept: true });
  assert.deepEqual(bookingActions({ kind: 'request', status: 'accepted' }, T0), { confirm: false, offer: false, decline: false, accept: false });
});

test('словарь: у каждого статуса — подпись и статус партнёра; причины — подписи; события — из словаря шага 7', () => {
  for (const s of STATUSES) { assert.ok(STATUS_LABEL[s], s); assert.ok(PARTNER_STATUS[s], s); }
  for (const r of DECLINE_REASONS) assert.ok(DECLINE_LABEL[r], r);
  assert.ok(STAFF_DECLINE_REASONS.every((r) => DECLINE_REASONS.includes(r)));
  assert.equal(PARTNER_STATUS.confirmed, 'booked', 'партнёр видит «booked», как в документации');
  assert.equal(eventsKnown(), true);
});

test('каждая подпись и сообщение модуля — статья словаря ru / uz / en', () => {
  const texts = [...Object.values(STATUS_LABEL), ...Object.values(DECLINE_LABEL), ...Object.values(API_BOOKING_MESSAGES)];
  for (const t of texts) {
    const e = STRINGS[t];
    assert.ok(e && e.ru === t && e.uz && e.en, 'нет статьи: ' + t);
  }
});

const appt = (over = {}) => ({
  type: 'appointment.new', cursor: '17', public_id: 'rq_e2a9f0c1', connection_id: 3, received_at: '2026-10-11T09:00:00Z',
  data: { external_id: 'med-8f2c41', doctor_id: 12, consultation: 'initial', start: '2026-10-20T10:00:00+05:00', branch_id: 1, lang: 'uz' },
  patient: { name: ' Абдурахмонов Фаррух ', phone: '+998 90 123 45 67', comment: 'Ребёнок 5 лет' },
  ...over,
});

test('разбор онлайн-записи: время в UTC, пациент без лишних пробелов; срок держания разбор не назначает', () => {
  const r = parseInboxItem(appt());
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    type: 'appointment.new', cursor: '17', public_id: 'rq_e2a9f0c1', connection_id: 3, received_at: '2026-10-11T09:00:00Z',
    external_id: 'med-8f2c41', lang: 'uz', patient: { name: 'Абдурахмонов Фаррух', phone: '+998 90 123 45 67', comment: 'Ребёнок 5 лет' },
    doctor_id: 12, branch_id: 1, service_id: null, package_id: null, consultation: 'initial',
    start_at: '2026-10-20T05:00:00Z',
  });
  // Решения владельца 18–19: срок держит клиника от СВОЕГО приёма заявки
  // (services/api/bookings.js) — названный публичным сервером срок не читается.
  const own = parseInboxItem(appt({ hold_until: '2026-10-11T09:20:00Z' }));
  assert.equal('hold_until' in own.value, false);
});

test('разбор: отказы по полям; отмена и ответ на предложение — только номер', () => {
  const bad = (over, problem) => assert.deepEqual(parseInboxItem(appt(over)), { ok: false, problem });
  bad({ type: 'appointment.delete' }, 'type');
  bad({ public_id: 'rq_1' }, 'public_id');
  bad({ connection_id: 'три' }, 'connection');
  bad({ received_at: 'вчера' }, 'received_at');
  bad({ data: { ...appt().data, external_id: 'с пробелом' } }, 'external_id');
  bad({ data: { ...appt().data, lang: 'de' } }, 'lang');
  bad({ patient: { name: '', phone: '+998901234567' } }, 'patient');
  bad({ patient: { name: 'Имя', phone: '12-34' } }, 'patient');
  bad({ data: { ...appt().data, doctor_id: null } }, 'doctor');
  bad({ data: { ...appt().data, start: 'завтра' } }, 'start');
  bad({ data: { ...appt().data, consultation: 'vip' } }, 'consultation');
  bad({ data: { ...appt().data, consultation: '', service_id: null } }, 'what');
  assert.deepEqual(parseInboxItem({ type: 'appointment.cancel', cursor: '18', public_id: 'rq_e2a9f0c1', connection_id: 3 }),
    { ok: true, value: { type: 'appointment.cancel', cursor: '18', public_id: 'rq_e2a9f0c1', connection_id: 3 } });
  const cb = parseInboxItem({ ...appt({ type: 'request.new' }), data: { external_id: 'x1', service_id: 301 } });
  assert.equal(cb.ok, true);
  assert.equal(cb.value.start_at, null);
  assert.equal(cb.value.service_id, 301);
});

test('тело уведомления: белый список — данные пациента не уходят, даже если их подсунуть', () => {
  const body = webhookBody({
    eventId: 'ev_1', event: 'booking.confirmed', publicId: 'rq_e2a9f0c1', externalId: 'med-1', status: 'booked',
    occurredAt: '2026-10-11T09:05:00Z',
    details: { doctor_id: 12, start: '2026-10-20T10:00:00+05:00', name: 'Фаррух', phone: '+998901234567', patient_id: 5, comment: 'x', mrn: 'A-1' },
  });
  assert.deepEqual(Object.keys(body), ['event_id', 'event', 'request_id', 'external_id', 'status', 'occurred_at', 'doctor_id', 'start']);
  assert.ok(!JSON.stringify(body).includes('Фаррух') && !JSON.stringify(body).includes('998901234567'));
  assert.deepEqual(WEBHOOK_DETAIL_KEYS.filter((k) => /name|phone|patient|comment|mrn/.test(k)), []);
});
