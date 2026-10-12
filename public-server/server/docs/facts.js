// API_DOCS_V1 — ЧИСЛА ДОКУМЕНТАЦИИ ИЗ КОДА. Каждое число страницы /docs берётся
// здесь из той постоянной, по которой работает сервер, — руками на странице
// чисел нет. Четыре группы чисел постоянной в этой службе не имеют (правила
// полей пациента, Max-Age CORS, ритм обмена и пределы программы клиники) — их
// держит страж: пробой настоящего сервера (docs/examples.http.test.js) и
// сверкой с постоянными программы клиники (docs/drift.test.js:
// server/services/api/public-sync.js, visit-events.js, snapshot.js). Код
// программы клиники служба при работе не загружает — только страж.
import { RATE_LIMITS, KEY_TTLS, KEY_PREFIX, SECRET_PREFIX } from '../../../public/js/shared/api-connections.js';
import { HOLD_MINUTES, OFFER_MINUTES } from '../../../public/js/shared/api-booking.js';
import { BOOKING_DAYS, DEFAULT_BOOKING_DAYS } from '../../../public/js/shared/doctor-public.js';
import { API_GROUPS } from '../../../public/js/shared/service-public.js';
import { IP_LIMIT_PER_MIN, AUTH_FAIL_LIMIT_PER_MIN, WRITE_LIMIT_PER_MIN, CLINIC_SILENT_MAX_MS } from '../routes/partner-auth.js';
import { PARTNER_BODY_LIMIT, MEDIA_MAX_AGE_SEC } from '../routes/partner.js';
import { STALE_AFTER_MS, STALE_DATA_MS } from '../routes/partner-read.js';
import { SLOT_MIN } from '../lib/slot-check.js';
import { WINDOW_MS } from '../lib/rate-limit.js';
import { WEBHOOK_TIMEOUT_MS, USER_AGENT } from '../lib/webhook-send.js';
import { RETRY_MINUTES, MAX_ATTEMPTS, DELIVERY_WINDOW_MS, HOST_TRIP_AFTER, HOST_BACKOFF_FIRST_MS, HOST_BACKOFF_MS } from '../store/deliveries.js';
import { ANSWER_TIMEOUT_MS, UNCOLLECTED_MAX_MS, REQUEST_KEEP_MS } from '../store/requests.js';
import { SLUG_ALIAS_DAYS } from '../store/clinics.js';
import { DEFAULT_TZ_OFFSET_MIN } from '../config.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Ритм обмена программы клиники (public-sync.js POLL_MS, SLOTS_EVERY_MS) — сверяет страж. */
export const CLINIC_RHYTHM = Object.freeze({ pollSec: 15, slotsEverySec: 60 });
/**
 * Пределы программы клиники, которые видит партнёр, — сверяет страж:
 * callbackBookDays — сколько дней от прихода заявки «перезвоните» клиника ищет
 * запись по её карточке (visit-events.js RECHECK_CALLBACK_DAYS); specialtiesMax —
 * сколько специальностей врача уходит в снимок (snapshot.js).
 */
export const CLINIC_LIMITS = Object.freeze({ callbackBookDays: 30, specialtiesMax: 4 });
/** Поля пациента и номер партнёра (routes/partner-write.js) — границы проверяют пробы стража. */
export const PATIENT_RULES = Object.freeze({ nameMax: 120, phoneMax: 32, phoneDigitsMin: 7, commentMax: 1000, externalMax: 64 });
/** Сколько браузер помнит ответ на предварительный запрос (routes/partner-auth.js Access-Control-Max-Age). */
export const CORS_MAX_AGE_SEC = 600;

/**
 * Числа страницы. base — адрес сервера (ctx.baseUrl), uncollectedMaxMs — срок
 * не забранной заявки из настроек службы (PUBLIC_UNCOLLECTED_MAX_HOURS).
 */
export function docFacts({ base = 'https://api.easymed.uz', uncollectedMaxMs = UNCOLLECTED_MAX_MS } = {}) {
  return Object.freeze({
    base, slug: 'shifo', keyPrefix: KEY_PREFIX, secretPrefix: SECRET_PREFIX,
    rateLimits: RATE_LIMITS, writePerMin: WRITE_LIMIT_PER_MIN, authFailPerMin: AUTH_FAIL_LIMIT_PER_MIN, ipPerMin: IP_LIMIT_PER_MIN,
    bodyKb: parseInt(PARTNER_BODY_LIMIT, 10),
    keyTtlMonths: KEY_TTLS.filter((t) => t !== 'never').map((t) => parseInt(t, 10) * (t.endsWith('y') ? 12 : 1)),
    slugAliasDays: SLUG_ALIAS_DAYS, slotMin: SLOT_MIN, bookingDays: BOOKING_DAYS, defaultBookingDays: DEFAULT_BOOKING_DAYS,
    holdMin: HOLD_MINUTES, offerMin: OFFER_MINUTES, answerMin: ANSWER_TIMEOUT_MS / MIN, uncollectedHours: uncollectedMaxMs / HOUR,
    keepDays: REQUEST_KEEP_MS / DAY, staleMin: STALE_AFTER_MS / MIN, staleDataMin: STALE_DATA_MS / MIN, silentDays: CLINIC_SILENT_MAX_MS / DAY,
    webhookTimeoutSec: WEBHOOK_TIMEOUT_MS / 1000, userAgent: USER_AGENT, retryMinutes: RETRY_MINUTES, attempts: MAX_ATTEMPTS,
    windowMin: DELIVERY_WINDOW_MS / MIN, hostTripAfter: HOST_TRIP_AFTER, hostRestFirstSec: HOST_BACKOFF_FIRST_MS / 1000, hostRestMaxSec: HOST_BACKOFF_MS / 1000,
    corsMaxAgeMin: CORS_MAX_AGE_SEC / 60,
    clinicPollSec: CLINIC_RHYTHM.pollSec, slotsEverySec: CLINIC_RHYTHM.slotsEverySec, ...CLINIC_LIMITS,
    // ревью шага 9, п. 6: и эти числа — из кода, а не словами в тексте
    mediaCacheHours: MEDIA_MAX_AGE_SEC / 3600, rateWindowSec: WINDOW_MS / 1000, groupCount: API_GROUPS.length,
    utc: 'UTC' + (DEFAULT_TZ_OFFSET_MIN < 0 ? '−' : '+') + Math.abs(DEFAULT_TZ_OFFSET_MIN) / 60,
    ...PATIENT_RULES,
  });
}
