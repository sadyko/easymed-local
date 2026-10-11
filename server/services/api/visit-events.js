// PUBLIC_API_V1 — ЧТО СТАЛО С ВИЗИТОМ ЗАЯВКИ ИЗ API: партнёр узнаёт о записи,
// переносе, отмене и приходе.
//
// Визит заявки живёт обычной жизнью: его переносят и отменяют календарём,
// приход доказывают касса и работа (crm/booking-mirror.js arrivedByEvidence —
// «Пришёл» в клинике нажимают не всегда). Дверей много, поэтому крючков в них
// нет: фон (services/api/public-sync.js, каждый такт) сверяет заявки с их
// визитами — сверка без памяти и идемпотентна, второй проход ничего не меняет.
//
//   • заявка «перезвоните» (kind request), по чьей карточке записали визит, —
//     «Записан» и appointment.created;
//   • записанная — визит перенесли (время или врач) — appointment.created с
//     rescheduled; отменили (или удалили) — appointment.cancelled; пришёл —
//     appointment.arrived; день прошёл без прихода — «Не пришёл» (без
//     уведомления: такого события в словаре нет); приход, доказанный позже,
//     поднимает «Не пришёл» в «Пришёл».
import { PRE_ARRIVAL } from '../crm/booking-mirror.js';
import { cameSurely } from '../crm/no-show.js';   // повторная проверка 8a, п. 6 — строгое правило прихода CRM
import { localDate } from '../domain/day.js';
import { EV, isoOf, localIso } from '../../../public/js/shared/api-booking.js';
import { enqueueEvent } from './outbox.js';

// Ревью 8a, M5: сверка идёт каждые 15 секунд — не перебирать всю историю.
// «Не пришёл» пересматривается (оплата, доехавшая позже) 14 дней после визита;
// заявка «перезвоните» ищет запись по своей карточке 30 дней от прихода.
export const RECHECK_NO_SHOW_DAYS = 14;
export const RECHECK_CALLBACK_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

const offsetMin = (ms) => -new Date(ms).getTimezoneOffset();
const partnerTime = (iso) => { const ms = Date.parse(iso); return Number.isFinite(ms) ? localIso(ms, offsetMin(ms)) : ''; };
const sameInstant = (a, b) => Date.parse(a) === Date.parse(b);

function update(db, id, fields, now) {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE api_requests SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), isoOf(now), id);
  return db.prepare('SELECT * FROM api_requests WHERE id = ?').get(id);
}

/**
 * Визит своего здания, который держит карточка (привязкой или строкой) и
 * который могла завести ЭТА заявка: до прихода (PRE_ARRIVAL) и не раньше дня,
 * когда она пришла. Повторная проверка 8a, п. 2: после слияния карточек
 * («Дубликаты») карточка несёт и старые визиты другой карточки — январский
 * визит или визит родственника на том же номере уходил партнёру как запись по
 * его заявке. Не по visits.created_at: это настоящие часы, а сверка живёт во
 * времени такта. Оставшаяся щель: будущий визит родственника на слитой
 * карточке всё ещё может быть принят за запись по заявке.
 */
function bookedVisitOfCard(db, crmRequestId, receivedAt) {
  return db.prepare(`
    SELECT v.* FROM visits v
     WHERE v.status IN (${PRE_ARRIVAL.map(() => '?').join(', ')}) AND v.sync_origin IS NULL
       AND ${localDate('v.visit_date')} >= ${localDate('?')}
       AND (v.id IN (SELECT visit_id FROM crm_booking_links WHERE request_id = ?)
            OR v.id IN (SELECT visit_id FROM crm_request_services WHERE request_id = ? AND visit_id IS NOT NULL))
     ORDER BY v.visit_date, v.id LIMIT 1`).get(...PRE_ARRIVAL, receivedAt, crmRequestId, crmRequestId) || null;
}

/**
 * Один проход сверки. Не бросает: ошибка одной заявки — в лог, остальные идут.
 * @returns {number} сколько заявок изменилось
 */
export function syncVisitOutcomes(db, { now = Date.now(), kekPath = null } = {}) {
  let changed = 0;
  const today = db.prepare(`SELECT ${localDate('?')} AS d`).get(isoOf(now)).d;
  const emit = (row, event, status, details = {}) => enqueueEvent(db, { request: row, event, status, details, now, kekPath });

  let callbacks = [];
  try {
    callbacks = db.prepare(`SELECT * FROM api_requests WHERE kind = 'request' AND status IN ('new', 'accepted')
                              AND visit_id IS NULL AND crm_request_id IS NOT NULL AND received_at >= ?`).all(isoOf(now - RECHECK_CALLBACK_DAYS * DAY_MS));
  } catch { return 0; }   // база до мигр. 245
  for (const r of callbacks) {
    try {
      const v = bookedVisitOfCard(db, r.crm_request_id, r.received_at);
      if (!v) continue;
      db.transaction(() => {
        const out = update(db, r.id, { status: 'confirmed', visit_id: v.id, patient_id: v.patient_id, doctor_id: v.doctor_id, start_at: isoOf(Date.parse(v.visit_date)) }, now);
        emit(out, EV.created, 'confirmed', { doctor_id: v.doctor_id, start: partnerTime(v.visit_date) });
      })();
      changed += 1;
    } catch (e) { console.warn('[public-api] заявка', r.id, 'не сверена с визитом:', e && e.message); }
  }

  const bound = db.prepare(`SELECT r.*, ${localDate('v.visit_date')} AS visit_day, v.id AS v_id, v.status AS v_status,
                                   v.visit_date AS v_date, v.doctor_id AS v_doctor
                              FROM api_requests r LEFT JOIN visits v ON v.id = r.visit_id
                             WHERE r.status = 'confirmed' OR (r.status = 'no_show' AND v.visit_date >= ?)`).all(isoOf(now - RECHECK_NO_SHOW_DAYS * DAY_MS));
  for (const r of bound) {
    try {
      db.transaction(() => {
        if (!r.v_id || r.v_status === 'cancelled') {
          if (r.status !== 'confirmed') return;
          emit(update(db, r.id, { status: 'cancelled' }, now), EV.cancelled, 'cancelled', { doctor_id: r.doctor_id });
          changed += 1;
          return;
        }
        // Ревью 8a, I1 и повторная проверка, п. 6: приход — только то, что бывает
        // лишь с человеком в клинике (cameSurely, строгое правило «Не пришёл» CRM):
        // отметка «Пришёл», работа над услугой, ПЛАТЁЖ в день визита или позже.
        // Предоплата накануне — не приход: прежде она с полуночи дня визита делала
        // заявку «пришёл», и отмена или перенос в тот же день до партнёра не доходили.
        // Финальная проверка 8a, п. 3: и регистрация на стойке — правило прихода
        // CRM (deskArrive → crmVisitStatus) закрывает строки карточки этого визита
        // ('done'), а сам визит остаётся «записан». Бесплатная консультация или
        // неоплаченный счёт иначе давали наутро «не пришёл». Только с дня визита:
        // предоплата накануне строк не закрывает (I1 держится).
        const came = cameSurely(db, { id: r.v_id, status: r.v_status, day: r.visit_day })
          || (r.visit_day <= today && !!db.prepare("SELECT 1 FROM crm_request_services WHERE visit_id = ? AND status = 'done' LIMIT 1").get(r.v_id));
        if (came) {
          emit(update(db, r.id, { status: 'arrived' }, now), EV.arrived, 'arrived', { doctor_id: r.v_doctor });
          changed += 1;
          return;
        }
        if (r.status === 'no_show') return;
        if (r.v_status === 'no_show' || (PRE_ARRIVAL.includes(r.v_status) && r.visit_day < today)) {
          update(db, r.id, { status: 'no_show' }, now);
          changed += 1;
          return;
        }
        if (!sameInstant(r.v_date, r.start_at) || Number(r.v_doctor || 0) !== Number(r.doctor_id || 0)) {
          const out = update(db, r.id, { start_at: isoOf(Date.parse(r.v_date)), doctor_id: r.v_doctor }, now);
          emit(out, EV.created, 'confirmed', { doctor_id: r.v_doctor, start: partnerTime(r.v_date), rescheduled: true });
          changed += 1;
        }
      })();
    } catch (e) { console.warn('[public-api] заявка', r.id, 'не сверена с визитом:', e && e.message); }
  }
  return changed;
}
