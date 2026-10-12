// PUBLIC_SERVER_V1 — ЗАЯВКИ И ОНЛАЙН-ЗАПИСЬ ОТ ПАРТНЁРОВ (макет «Документация
// API», раздел «Заявки и онлайн-запись»; дизайн шага 8, §2, §3, §6, §7):
//   POST   /requests                     «перезвоните»            → 201 {request_id, status:'new'}
//   POST   /appointments                 запись на время           → 201 {request_id, status:'pending'}
//   GET    /requests/{id}                статус заявки (любой)
//   DELETE /appointments/{id}            отмена пациентом
//   POST   /appointments/{id}/accept     согласие на другое время
//   POST   /appointments/{id}/decline    отказ от другого времени
//
// Данные пациента (имя, телефон, комментарий) проверяются теми же правилами,
// что разбор очереди в клинике (shared/api-booking.js parseInboxItem), и
// запечатываются ключом клиники сразу (store/requests.js) — открытыми не лежат
// нигде и в ответ не возвращаются. Ошибка поля — 400 с field и reason, без
// присланного значения.
//
// Онлайн-запись принимается и когда клиника не на связи (решение 19): ответ
// pending без hold_until — срок назначит клиника при приёме. Время проверяется
// по последнему присланному и своей очереди (409 slot_taken) — первая линия;
// правду скажет клиника. Повтор с тем же external_id — та же заявка (200).
import { CONSULT_API_KINDS } from '../../../public/js/shared/consultation-price.js';
import { snapshotOf, slotsOf } from '../store/clinics.js';
import { createRequest, requestRow, requestByExternal, queueOverlaps, partnerCancel, partnerAnswerOffer } from '../store/requests.js';
import { slotState, windowsNeeded } from '../lib/slot-check.js';
import { sendError } from '../lib/errors.js';
import { localParts, addDays, msOfPartner, isoOf, partnerTime } from '../lib/time.js';
import { scope } from './partner-auth.js';

const EXTERNAL_RE = /^[\x21-\x7e]{1,64}$/;
const LANGS = ['', 'ru', 'uz', 'en'];
const RQ_RE = /^rq_[A-Za-z0-9]{6,37}$/;
const str = (v) => String(v == null ? '' : v).trim();
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

class FieldError extends Error {
  constructor(code, extra) { super(code); this.code = code; this.extra = extra; }
}
const field = (name, reason) => new FieldError('invalid_field', { field: name, reason });
const missing = (name) => new FieldError('not_found', { field: name });

/** Имя, телефон, комментарий — правила разбора очереди клиники. */
function patientOf(p, prefix) {
  const name = str(p.name);
  const phone = str(p.phone);
  const comment = str(p.comment);
  if (!name) throw field(prefix + 'name', 'required');
  if (name.length > 120) throw field(prefix + 'name', 'too_long');
  if (!phone) throw field(prefix + 'phone', 'required');
  if (phone.length > 32 || phone.replace(/\D/g, '').length < 7) throw field(prefix + 'phone', 'format');
  if (comment.length > 1000) throw field(prefix + 'comment', 'too_long');
  return { name, phone, comment };
}

/** Общее для обоих видов: номер партнёра, язык, врач/услуга/пакет из снимка. */
function common(b, s) {
  const externalId = str(b.external_id);
  if (externalId && !EXTERNAL_RE.test(externalId)) throw field('external_id', 'format');
  const lang = str(b.lang).toLowerCase();
  if (!LANGS.includes(lang)) throw field('lang', 'unknown');
  const pick = (name, list) => {
    if (b[name] == null || b[name] === '') return null;
    const id = posInt(b[name]);
    if (!id) throw field(name, 'format');
    if (list && !list.some((x) => x.id === id)) throw missing(name);
    return id;
  };
  return {
    externalId, lang,
    doctorId: pick('doctor_id', s.doctors || []), serviceId: pick('service_id', s.services || []),
    packageId: pick('package_id', s.packages || []), branchId: pick('branch_id', null),
  };
}

/** Заявка для партнёра — без данных пациента; время — Ташкент. */
export function publicRequest(row, offsetMin) {
  const t = (v) => partnerTime(v, offsetMin);
  const out = { request_id: row.id, external_id: row.external_id || '', type: row.kind, status: row.status };
  if (row.reason) out.reason = row.reason;
  for (const k of ['doctor_id', 'branch_id', 'service_id', 'package_id']) if (row[k]) out[k] = row[k];
  if (row.consultation) out.consultation = row.consultation;
  if (row.start_at) out.start = t(row.start_at);
  if (row.status === 'pending' && row.hold_until) out.hold_until = t(row.hold_until);
  if (row.status === 'offered') { out.offered_start = t(row.offered_start); out.offer_until = t(row.offer_until); }
  if (row.status === 'booked' && row.cancel_requested_at) out.cancel_requested = true;
  out.created_at = t(row.created_at);
  out.updated_at = t(row.updated_at);
  return out;
}

/** @param ctx {{db, now, offsetMin}} */
export function writeRoutes(r, ctx) {
  const handle = (fn) => (req, res) => {
    try { return fn(req, res); } catch (e) {
      if (e instanceof FieldError) return sendError(req, res, e.code, e.extra);
      throw e;
    }
  };
  const bodyOf = (req) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new FieldError('bad_request', {});
    return req.body;
  };
  const snap = (req) => {
    const s = snapshotOf(req.clinic);
    if (!s) throw new FieldError('not_found', {});
    return s;
  };
  const created = (res, out, row) => res.status(out.created ? 201 : 200).json(publicRequest(row, ctx.offsetMin));

  r.post('/requests', scope('requests'), handle((req, res) => {
    const b = bodyOf(req);
    const s = snap(req);
    const p = b.patient && typeof b.patient === 'object' ? b.patient : b;
    const patient = patientOf({ name: p.name, phone: p.phone, comment: p.comment ?? b.comment }, b.patient ? 'patient.' : '');
    const c = common(b, s);
    const out = createRequest(ctx.db, { clinic: req.clinic, connectionId: req.conn.id, kind: 'request', ...c, patient, now: ctx.now() });
    if (out.error) return sendError(req, res, out.error, { phone: String((s.clinic && s.clinic.phone) || '') });
    return created(res, out, out.row);
  }));

  r.post('/appointments', scope('appointments'), handle((req, res) => {
    const now = ctx.now();
    const b = bodyOf(req);
    const s = snap(req);
    const c = common(b, s);
    if (!c.doctorId) throw field('doctor_id', 'required');
    const doctor = s.doctors.find((d) => d.id === c.doctorId);
    if (doctor.reception === 'live_queue') throw field('doctor_id', 'live_queue');
    let minutes;
    let consultation = '';
    if (str(b.consultation)) {
      consultation = str(b.consultation);
      if (!CONSULT_API_KINDS.includes(consultation)) throw field('consultation', 'unknown');
      const ct = (doctor.consultations || []).find((x) => x.type === consultation);
      if (!ct) throw field('consultation', 'not_offered');
      minutes = ct.minutes;
    } else if (c.serviceId) {
      minutes = s.services.find((x) => x.id === c.serviceId).minutes;
    } else {
      throw field('consultation', 'required');
    }
    const startMs = msOfPartner(b.start, ctx.offsetMin);
    if (startMs == null) throw field('start', b.start == null ? 'required' : 'format');
    if (startMs <= now) throw field('start', 'past');
    const at = localParts(startMs, ctx.offsetMin);
    if (at.minutes % 15 !== 0 || at.seconds !== 0 || startMs % 1000 !== 0) throw field('start', 'grid');
    const horizon = Number(doctor.booking_days) > 0 ? Number(doctor.booking_days) : 14;
    if (at.date > addDays(localParts(now, ctx.offsetMin).date, horizon - 1)) throw field('start', 'horizon');
    const patient = patientOf(b.patient && typeof b.patient === 'object' ? { ...b.patient, comment: b.patient.comment ?? b.comment } : {}, 'patient.');
    if (c.externalId) {
      const again = requestByExternal(ctx.db, req.clinic.clinic_id, req.conn.id, c.externalId);
      if (again) return res.status(200).json(publicRequest(again, ctx.offsetMin));
    }
    const n = windowsNeeded(minutes);
    const durationMin = Math.min(480, Math.max(5, Number(minutes) > 0 ? Number(minutes) : 15));
    if (slotState(slotsOf(req.clinic), doctor, startMs, n, { now, offsetMin: ctx.offsetMin }) === 'taken'
      || queueOverlaps(ctx.db, req.clinic.clinic_id, doctor.id, startMs, durationMin, now)) {
      return sendError(req, res, 'slot_taken');
    }
    const out = createRequest(ctx.db, { clinic: req.clinic, connectionId: req.conn.id, kind: 'appointment', ...c, consultation,
      startAt: isoOf(startMs), durationMin, patient, now });
    if (out.error) return sendError(req, res, out.error, { phone: String((s.clinic && s.clinic.phone) || '') });
    return created(res, out, out.row);
  }));

  const own = (req, kind = null) => {
    const id = String(req.params.id || '');
    const row = RQ_RE.test(id) ? requestRow(ctx.db, req.clinic.clinic_id, id) : null;
    if (!row || row.connection_id !== req.conn.id || (kind && row.kind !== kind)) throw new FieldError('not_found', {});
    return row;
  };

  r.get('/requests/:id', scope('requests', 'appointments'), handle((req, res) => res.json(publicRequest(own(req), ctx.offsetMin))));

  r.delete('/appointments/:id', scope('cancel'), handle((req, res) => {
    const out = partnerCancel(ctx.db, own(req, 'appointment'), ctx.now());
    return out.error ? sendError(req, res, out.error) : res.json(publicRequest(out.row, ctx.offsetMin));
  }));

  // Ревью 8b, C9: offered_start в теле (необязательно) — предложение, на которое
  // отвечает партнёр; не то, что предлагается сейчас, — 409 offer_changed.
  for (const [action, accept] of [['accept', true], ['decline', false]]) {
    r.post('/appointments/:id/' + action, scope('appointments'), handle((req, res) => {
      const row = own(req, 'appointment');
      const seen = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body.offered_start : undefined;
      let offeredStart = null;
      if (seen != null && seen !== '') {
        offeredStart = msOfPartner(seen, ctx.offsetMin);
        if (offeredStart == null) throw field('offered_start', 'format');
      }
      const out = partnerAnswerOffer(ctx.db, row, accept, ctx.now(), { offeredStart });
      return out.error ? sendError(req, res, out.error) : res.json(publicRequest(out.row, ctx.offsetMin));
    }));
  }
}
