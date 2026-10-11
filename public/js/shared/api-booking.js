// PUBLIC_API_V1 — ЗАЯВКИ И ОНЛАЙН-ЗАПИСЬ ИЗ API: словарь статусов, причин отказа
// и событий; срок удержания; разбор того, что приносит публичный сервер; тело
// уведомления партнёру. Один модуль на сервер (services/api/*.js) и экран
// (views/crm-api-booking.js): слово статуса и правило «можно ли подтвердить» у
// них одни.
//
// Чистый модуль — без базы, DOM и перевода. Подписи и сообщения — ключи словаря
// (i18n-strings.js): экран переводит их tr(), сервер отдаёт как есть.
import { EVENTS } from './api-connections.js';
import { PUBLIC_SLOT_MIN } from './doctor-public.js';
import { CONSULT_API_KINDS } from './consultation-price.js';

/**
 * Спецификация «Правила → Онлайн-запись»: время держится 30 минут — РАБОЧИХ
 * минут клиники, от приёма заявки клиникой (решения владельца 18–19,
 * 2026-10-11; holdUntilFor ниже).
 */
export const HOLD_MINUTES = 30;
/**
 * Встречное предложение («Предложить другое время») держится 30 ОБЫЧНЫХ минут:
 * оно ждёт ответа партнёра, а не регистратуры (решение 18 — о минутах клиники).
 */
export const OFFER_MINUTES = 30;
/** Сетка начал для партнёров — та же, что /slots (шаг 5). */
export const SLOT_STEP_MIN = PUBLIC_SLOT_MIN;

export const KINDS = Object.freeze(['request', 'appointment']);
export const STATUSES = Object.freeze(['new', 'accepted', 'pending', 'confirming', 'offered', 'confirmed',
  'declined', 'expired', 'cancelled', 'arrived', 'no_show']);
/** Время держится (удержание живо, пока не истекло). */
export const HELD_STATUSES = Object.freeze(['pending', 'offered']);
/** Ждёт ответа клиники — карточка доски показывает строку онлайн-записи. */
export const OPEN_STATUSES = Object.freeze(['new', 'accepted', 'pending', 'confirming', 'offered']);

export const STATUS_LABEL = Object.freeze({
  new:        'Новая заявка',
  accepted:   'Заявка в работе',
  pending:    'Ждёт подтверждения',
  confirming: 'Подтверждается',
  offered:    'Предложено другое время',
  confirmed:  'Записан',
  declined:   'Отклонено',
  expired:    'Не подтверждено вовремя',
  cancelled:  'Отменено',
  arrived:    'Пришёл',
  no_show:    'Не пришёл',
});
/** Что видит партнёр: поле status в ответе GET /requests/{id} и в уведомлении. */
export const PARTNER_STATUS = Object.freeze({
  new: 'new', accepted: 'accepted', pending: 'pending', confirming: 'pending', offered: 'offered',
  confirmed: 'booked', declined: 'declined', expired: 'expired', cancelled: 'cancelled', arrived: 'arrived', no_show: 'no_show',
});

export const DECLINE_REASONS = Object.freeze(['slot_taken', 'doctor_unavailable', 'not_bookable', 'duplicate', 'expired', 'other']);
/** Что выбирает регистратор в «Отклонить»; остальные причины ставит сервер. */
export const STAFF_DECLINE_REASONS = Object.freeze(['slot_taken', 'doctor_unavailable', 'other']);
export const DECLINE_LABEL = Object.freeze({
  slot_taken:         'Время уже занято',
  doctor_unavailable: 'Врач в это время не принимает',
  not_bookable:       'Запись к этому врачу через API не открыта',
  duplicate:          'Повтор заявки партнёра',
  expired:            'Срок держания времени истёк',   // решение 18: минуты рабочие — «за 30 минут» ночью неправда
  other:              'Другая причина',
});

/** События — из словаря шага 7 (shared/api-connections.js EVENTS); новых не заводим. */
export const EV = Object.freeze({
  accepted:  'request.accepted',
  created:   'appointment.created',
  confirmed: 'booking.confirmed',
  offered:   'booking.offered_other_time',
  declined:  'booking.declined',
  cancelled: 'appointment.cancelled',
  arrived:   'appointment.arrived',
});
/** Все события модуля есть в словаре шага 7 (тест сверяет). */
export const eventsKnown = () => Object.values(EV).every((e) => EVENTS.includes(e));

/** Что приносит публичный сервер (GET /_sync/v1/inbox). */
export const INBOX_TYPES = Object.freeze(['request.new', 'appointment.new', 'appointment.cancel', 'offer.accept', 'offer.decline']);

export const API_BOOKING_MESSAGES = Object.freeze({
  notFound:       'Заявка из API не найдена — возможно, её уже обработали. Обновите карточку.',
  noAccess:       'Эта карточка заявки вам недоступна.',
  noEdit:         'Обрабатывать заявки из API может администратор, регистратура или колл-центр.',
  mainOnly:       'Заявки из API обрабатываются в главном здании клиники.',
  notAppointment: 'Это заявка без времени — подтверждать нечего.',
  notRequest:     'Это онлайн-запись — её подтверждают, а не берут в работу.',
  notPending:     'Запись уже не ждёт подтверждения.',
  busy:           'Запись подтверждает другой сотрудник — обновите карточку.',
  holdExpired:    'Время больше не держится: запись не подтвердили вовремя. Партнёр получил отказ — позвоните пациенту и запишите обычным способом.',
  patient:        'Выберите карту пациента или заведите новую.',
  patientMissing: 'Карта пациента не найдена.',
  dayVisitBusy:   'У пациента на этот день уже есть визит с работой ({start}, врач {doctor}) — второй визит на день не заводится. Отклоните запись или предложите другой день.',
  // Ревью 8a, I7: подтверждение перенесло бы чужую запись пациента на время онлайн-записи.
  dayVisitExists: 'У пациента на этот день уже есть запись ({start}, врач {doctor}) — подтверждение перенесло бы её на время онлайн-записи. Перенесите или отмените ту запись в календаре либо предложите партнёру другое время.',
  start:          'Время указано неверно.',
  startPast:      'Это время уже прошло.',
  slotTaken:      'Это время занято — выберите другое.',
  reason:         'Выберите причину отказа.',
  alreadyAccepted:'Заявка уже в работе.',
});

const PUBLIC_ID_RE = /^rq_[A-Za-z0-9]{6,37}$/;
const EXTERNAL_RE = /^[\x21-\x7e]{1,64}$/;
const LANGS = Object.freeze(['', 'ru', 'uz', 'en']);
const text = (v) => String(v == null ? '' : v).trim();
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const msOf = (v) => { const t = Date.parse(String(v == null ? '' : v)); return Number.isFinite(t) ? t : null; };

/** Мгновение → 'YYYY-MM-DDTHH:MM:SSZ' (без миллисекунд, как пишет база). */
export const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Местное время клиники со смещением: '2026-10-07T13:30:00+05:00' — так время
 * видит партнёр (документация API: «время — Ташкент, UTC+5»). offsetMin —
 * смещение процесса клиники (сервер стоит в клинике, rpc/calendar.js).
 */
export function localIso(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60000);
  const p = (n) => String(n).padStart(2, '0');
  const sign = offsetMin >= 0 ? '+' : '-';
  const a = Math.abs(offsetMin);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    + `${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

// Сколько дней вперёд искать рабочее время клиники: при часах, где открыт хоть
// один день недели, оно находится за неделю; две — запас.
const HOLD_SEARCH_DAYS = 14;
const localMidnightMs = (ms, plusDays = 0) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays).getTime(); };

/**
 * fromMs плюс minutes РАБОЧИХ минут клиники. openOn(ms) — окно местного дня, в
 * который попадает ms: { from, to } в минутах от полуночи; null — клиника в
 * этот день закрыта; undefined — границы нет (часы не заданы, круглосуточно).
 * Без openOn, без границы или без единого рабочего дня за две недели — минуты
 * идут подряд, круглые сутки.
 */
function plusWorkingMinutes(fromMs, minutes, openOn) {
  const plain = fromMs + minutes * 60000;
  if (typeof openOn !== 'function') return plain;
  let left = minutes * 60000;
  let t = fromMs;
  for (let i = 0; i <= HOLD_SEARCH_DAYS; i += 1) {
    const midnight = localMidnightMs(t);
    const next = localMidnightMs(t, 1);
    const w = openOn(t);
    if (w === undefined) return t + left;
    if (w) {
      const open = Math.max(t, midnight + w.from * 60000);
      const close = Math.min(next, midnight + w.to * 60000);
      if (open < close) {
        const take = Math.min(left, close - open);
        left -= take;
        if (left <= 0) return open + take;
      }
    }
    t = next;
  }
  return plain;
}

/**
 * До какого мгновения держится время: HOLD_MINUTES РАБОЧИХ минут клиники от
 * fromIso, но не дольше начала приёма (прошедшее время держать незачем).
 * '' — даты неверны.
 *
 * РЕШЕНИЯ ВЛАДЕЛЬЦА 18–19 (2026-10-11), ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ОНИ ЖИВУТ:
 *   • 18 — минуты рабочие: заявка в 22:00 при открытии в 08:00 держится до
 *     08:30, в 17:50 при закрытии в 18:00 — до 08:20 следующего рабочего дня;
 *     выходной пропускается. Часы — openOn (сервер даёт часы главного здания:
 *     services/api/holds.js clinicOpenOn — тем же чтением, что сужает окна
 *     врачей в движке записи). Часы не заданы — 30 минут круглые сутки;
 *   • 19 — fromIso — миг, когда заявку ПРИНЯЛА КЛИНИКА (не когда её отправил
 *     партнёр): запись, пролежавшая в очереди сервера, пока клиника была без
 *     связи, не истекает в миг приёма.
 */
export function holdUntilFor(fromIso, startIso, { minutes = HOLD_MINUTES, openOn = null } = {}) {
  const r = msOf(fromIso);
  const s = msOf(startIso);
  if (r == null || s == null) return '';
  return isoOf(Math.min(plusWorkingMinutes(r, minutes, openOn), s));
}

/** Удержание заявки: 'held' — держится, 'expired' — срок вышел, 'none' — не держится вовсе. */
export function holdState(row, now = Date.now()) {
  if (!row || !HELD_STATUSES.includes(row.status)) return 'none';
  const until = msOf(row.status === 'offered' ? row.offer_until : row.hold_until);
  return until != null && until > now ? 'held' : 'expired';
}

/** Статус для экрана: истёкшее удержание — «Не подтверждено вовремя», даже если фон ещё не записал итог. */
export function shownStatus(row, now = Date.now()) {
  return holdState(row, now) === 'expired' ? 'expired' : String(row && row.status || '');
}

/** Что можно сделать с заявкой сейчас. */
export function bookingActions(row, now = Date.now()) {
  const r = row || {};
  const held = holdState(r, now) === 'held';
  const appt = r.kind === 'appointment';
  return {
    confirm: appt && r.status === 'pending' && held,
    offer:   appt && HELD_STATUSES.includes(r.status) && held,
    decline: appt && HELD_STATUSES.includes(r.status) && held,
    accept:  r.kind === 'request' && r.status === 'new',
  };
}

/**
 * Разбор элемента входящей очереди. Данные пациента приходят уже вскрытыми
 * (services/api/public-sync.js открывает запечатанное ключом клиники) в поле
 * patient. → { ok: true, value } | { ok: false, problem }.
 *
 * Срок держания разбор НЕ назначает и поле hold_until элемента не читает:
 * время держит клиника от СВОЕГО приёма заявки (решения владельца 18–19 —
 * services/api/bookings.js, holdUntilFor).
 */
export function parseInboxItem(item) {
  const it = item && typeof item === 'object' ? item : {};
  const type = text(it.type);
  if (!INBOX_TYPES.includes(type)) return { ok: false, problem: 'type' };
  const publicId = text(it.public_id);
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, problem: 'public_id' };
  const connectionId = posInt(it.connection_id);
  if (!connectionId) return { ok: false, problem: 'connection' };
  const base = { type, cursor: text(it.cursor), public_id: publicId, connection_id: connectionId };
  if (type !== 'request.new' && type !== 'appointment.new') {
    // Ревью 8a, M2: когда публичный сервер принял ответ партнёра — по нему судят,
    // успел ли партнёр согласиться в срок предложения (клиника могла быть без связи).
    const answered = msOf(it.received_at);
    return { ok: true, value: answered == null ? base : { ...base, received_at: isoOf(answered) } };
  }

  const received = msOf(it.received_at);
  if (received == null) return { ok: false, problem: 'received_at' };
  const d = it.data && typeof it.data === 'object' ? it.data : {};
  const externalId = text(d.external_id);
  if (externalId && !EXTERNAL_RE.test(externalId)) return { ok: false, problem: 'external_id' };
  const lang = text(d.lang).toLowerCase();
  if (!LANGS.includes(lang)) return { ok: false, problem: 'lang' };
  const p = it.patient && typeof it.patient === 'object' ? it.patient : {};
  const name = text(p.name);
  const phone = text(p.phone);
  const digits = phone.replace(/\D/g, '');
  if (!name || name.length > 120 || phone.length > 32 || digits.length < 7) return { ok: false, problem: 'patient' };
  const comment = text(p.comment).slice(0, 1000);
  const value = {
    ...base, received_at: isoOf(received), external_id: externalId, lang,
    patient: { name, phone, comment },
    doctor_id: posInt(d.doctor_id), branch_id: posInt(d.branch_id), service_id: posInt(d.service_id),
    package_id: posInt(d.package_id), consultation: '', start_at: null,
  };
  if (type === 'request.new') return { ok: true, value };

  if (!value.doctor_id) return { ok: false, problem: 'doctor' };
  const start = msOf(d.start);
  if (start == null) return { ok: false, problem: 'start' };
  const consultation = text(d.consultation);
  if (consultation && !CONSULT_API_KINDS.includes(consultation)) return { ok: false, problem: 'consultation' };
  if (!consultation && !value.service_id) return { ok: false, problem: 'what' };
  value.consultation = consultation;
  value.start_at = isoOf(start);
  return { ok: true, value };
}

/** Поля уведомления сверх общих — только эти; данных пациента среди них нет. */
export const WEBHOOK_DETAIL_KEYS = Object.freeze(['doctor_id', 'branch_id', 'start', 'offered_start', 'offer_until', 'reason', 'rescheduled']);

/**
 * Тело уведомления партнёру и записи статуса на публичном сервере. Белый
 * список: ни имени, ни телефона, ни комментария, ни номера карты — партнёр
 * получает номер заявки и её статус (screen-docs.js «Заявки и онлайн-запись»).
 */
export function webhookBody({ eventId, event, publicId, externalId = '', status, occurredAt, details = {} } = {}) {
  const out = {
    event_id: String(eventId || ''), event: String(event || ''), request_id: String(publicId || ''),
    external_id: String(externalId || ''), status: String(status || ''), occurred_at: String(occurredAt || ''),
  };
  for (const k of WEBHOOK_DETAIL_KEYS) {
    const v = details ? details[k] : undefined;
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
  }
  return out;
}
