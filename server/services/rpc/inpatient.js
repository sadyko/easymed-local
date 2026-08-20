// Server-side inpatient RPCs (ward & bed admission / discharge). Accommodation
// charges are computed here from DB rows (ward/bed rates, elapsed stay) —
// client-supplied amounts are never trusted. Every handler that touches
// money or bed/admission state runs inside db.transaction(...)() for atomicity.

import { nextInvoiceNumber } from './billing.js';
import { assertTransition } from '../domain/lifecycle.js';
import { hasAnyRole } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const ADMIT_ROLES = ['admin', 'registrar', 'nurse', 'doctor'];
const DISCHARGE_ROLES = ['admin', 'registrar', 'nurse', 'cashier'];
// Applying a money discount is a stricter privilege than discharging: a nurse
// or registrar can discharge (at full accommodation price) but may NOT waive or
// reduce the bill — only an admin or cashier can (adversarial-review finding #1).
const DISCOUNT_ROLES = ['admin', 'cashier'];
const BED_STATUS_ROLES = ['admin', 'registrar', 'nurse'];
const BED_STATUS_VALUES = ['free', 'cleaning', 'maintenance'];
const PATHWAYS = ['therapy', 'surgical'];
// Upper bound on the computed accommodation charge. Guards round2() from
// overflowing a huge-but-finite rate*units to Infinity, which would poison
// the stored charge_amount, the created invoice, and any report that SUMs
// across invoices.
const MAX_MONEY = 1e12;

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

function nowIso(db) {
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') n").get().n;
}

// REQUEST_ADMISSION_V1 — easymed's request_admission RPC: the doctor files an
// inpatient request from the service workspace. No bed is taken and no money
// moves — the row is a status='requested' admission (bed_id NULL) that the
// ward/registrar desk later fulfils via admit_patient. One open request or
// active stay per patient at a time.
export function requestAdmission(db, args, user) {
  requireRole(user, ADMIT_ROLES);

  const patientId = args && args.patient_id;
  if (!isPositiveInt(patientId)) {
    throw new RpcError('patient_id must be a positive integer.', 400);
  }
  const rawDoctorId = args && args.doctor_id;
  const doctorId = rawDoctorId === undefined || rawDoctorId === null ? null : rawDoctorId;
  if (doctorId !== null && !isPositiveInt(doctorId)) {
    throw new RpcError('doctor_id must be a positive integer.', 400);
  }
  const pathway = args && args.pathway !== undefined && args.pathway !== null ? args.pathway : 'therapy';
  if (!PATHWAYS.includes(pathway)) {
    throw new RpcError(`pathway must be one of: ${PATHWAYS.join(', ')}`, 400);
  }
  const chiefComplaint = (args && typeof args.chief_complaint === 'string' ? args.chief_complaint : '').slice(0, 500);
  const admissionDiagnosis = (args && typeof args.diagnosis === 'string' ? args.diagnosis : '').slice(0, 500);

  const run = db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) {
      throw new RpcError('patient not found.', 400);
    }
    if (doctorId !== null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(doctorId)) {
      throw new RpcError('doctor not found.', 400);
    }
    const open = db.prepare("SELECT status FROM admissions WHERE patient_id=? AND status IN ('requested','active')").get(patientId);
    if (open) {
      throw new RpcError(open.status === 'active'
        ? 'patient already has an active admission.'
        : 'patient already has a pending admission request.', 400);
    }

    const info = db.prepare(`
      INSERT INTO admissions (patient_id, doctor_id, pathway, chief_complaint, admission_diagnosis, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'requested', ?)
    `).run(patientId, doctorId, pathway, chiefComplaint, admissionDiagnosis, user.id);
    const admissionId = info.lastInsertRowid;
    db.prepare("UPDATE admissions SET admission_no = 'ADM-' || substr('00000'||id,-5,5) WHERE id=?").run(admissionId);

    return { admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId) };
  });

  return run();
}

// ADM_REQUEST_LIFECYCLE_V1 — decline a hospitalisation request that will not be
// fulfilled (patient improved, referred elsewhere, filed in error). Without this
// the only exits from 'requested' were "never", which is what made the state a
// dead end. No bed and no money are involved, so the admit roles own it.
export function cancelAdmissionRequest(db, args, user) {
  requireRole(user, ADMIT_ROLES);

  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) {
    throw new RpcError('admission_id must be a positive integer.', 400);
  }
  const reason = (args && typeof args.reason === 'string' ? args.reason : '').slice(0, 300);

  const run = db.transaction(() => {
    const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId);
    if (!adm) throw new RpcError('admission not found.', 400);
    // An active stay is ended by discharge, never by cancelling — the table
    // says so, and this is the error the ward sees if they try.
    assertTransition('admission', adm.status, 'cancelled');

    db.prepare("UPDATE admissions SET status = 'cancelled', discharged_at = ? WHERE id = ? AND status = 'requested'")
      .run(nowIso(db), admissionId);
    db.prepare(`
      INSERT INTO admission_transfers (admission_id, kind, reason, transferred_at, transferred_by)
      VALUES (?, 'cancel', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)
    `).run(admissionId, reason || null, user.id);

    return { admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId) };
  });

  return run();
}

export function admitPatient(db, args, user) {
  requireRole(user, ADMIT_ROLES);

  const patientId = args && args.patient_id;
  if (!isPositiveInt(patientId)) {
    throw new RpcError('patient_id must be a positive integer.', 400);
  }
  const bedId = args && args.bed_id;
  if (!isPositiveInt(bedId)) {
    throw new RpcError('bed_id must be a positive integer.', 400);
  }
  const rawDoctorId = args && args.doctor_id;
  const doctorId = rawDoctorId === undefined || rawDoctorId === null ? null : rawDoctorId;
  if (doctorId !== null && !isPositiveInt(doctorId)) {
    throw new RpcError('doctor_id must be a positive integer.', 400);
  }
  const pathway = args && args.pathway !== undefined ? args.pathway : 'therapy';
  if (!PATHWAYS.includes(pathway)) {
    throw new RpcError(`pathway must be one of: ${PATHWAYS.join(', ')}`, 400);
  }
  const chiefComplaint = (args && typeof args.chief_complaint === 'string' ? args.chief_complaint : '').slice(0, 500);
  const admissionDiagnosis = (args && typeof args.admission_diagnosis === 'string' ? args.admission_diagnosis : '').slice(0, 500);

  const run = db.transaction(() => {
    const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
    if (!patient) {
      throw new RpcError('patient not found.', 400);
    }
    const bed = db.prepare('SELECT * FROM beds WHERE id = ?').get(bedId);
    if (!bed) {
      throw new RpcError('bed not found.', 400);
    }
    if (bed.active !== 1) {
      throw new RpcError('bed is not active.', 400);
    }
    if (bed.status !== 'free') {
      throw new RpcError(`bed is not free (status: ${bed.status}).`, 400);
    }
    if (doctorId !== null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(doctorId)) {
      throw new RpcError('doctor not found.', 400);   // clean 400 instead of an FK 500 (review finding #4)
    }

    const patientActive = db.prepare("SELECT 1 FROM admissions WHERE patient_id=? AND status='active'").get(patientId);
    if (patientActive) {
      throw new RpcError('patient already has an active admission.', 400);
    }
    const bedActive = db.prepare("SELECT 1 FROM admissions WHERE bed_id=? AND status='active'").get(bedId);
    if (bedActive) {
      throw new RpcError('bed already has an active admission.', 400);
    }

    // ADM_REQUEST_LIFECYCLE_V1 — giving a bed to a patient who already has an
    // open request FULFILS that request (requested -> active) instead of opening
    // a second, unrelated admission. Previously the request row was left behind
    // forever: no handler could ever move it out of 'requested', and because
    // request_admission refuses a second open request, that patient could never
    // be referred for inpatient care again. Fulfilling in place also keeps the
    // doctor's referral joined to the stay it produced.
    const pending = db.prepare("SELECT * FROM admissions WHERE patient_id=? AND status='requested' ORDER BY id LIMIT 1").get(patientId);

    let admissionId;
    if (pending) {
      assertTransition('admission', pending.status, 'active');
      // Details supplied at the desk win; anything omitted keeps what the
      // referring doctor filed.
      db.prepare(`
        UPDATE admissions
           SET bed_id = ?, ward_id = ?, status = 'active',
               admitted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
               doctor_id = COALESCE(?, doctor_id),
               pathway = ?,
               chief_complaint = CASE WHEN ? <> '' THEN ? ELSE chief_complaint END,
               admission_diagnosis = CASE WHEN ? <> '' THEN ? ELSE admission_diagnosis END
         WHERE id = ? AND status = 'requested'
      `).run(bedId, bed.ward_id, doctorId, pathway,
             chiefComplaint, chiefComplaint, admissionDiagnosis, admissionDiagnosis, pending.id);
      admissionId = pending.id;
    } else {
      const info = db.prepare(`
        INSERT INTO admissions
          (patient_id, bed_id, ward_id, doctor_id, pathway, chief_complaint, admission_diagnosis, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(patientId, bedId, bed.ward_id, doctorId, pathway, chiefComplaint, admissionDiagnosis, user.id);
      admissionId = info.lastInsertRowid;
    }

    db.prepare("UPDATE admissions SET admission_no = 'ADM-' || substr('00000'||id,-5,5) WHERE id=?").run(admissionId);
    db.prepare("UPDATE beds SET status='occupied' WHERE id=?").run(bedId);
    // BED_CONSOLE_V1 — «Поступил» в журнале движений пациента.
    db.prepare(`
      INSERT INTO admission_transfers (admission_id, to_bed_id, to_ward_id, kind, transferred_at, transferred_by)
      VALUES (?, ?, ?, 'admit', strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)
    `).run(admissionId, bedId, bed.ward_id, user.id);

    return { admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId) };
  });

  return run();
}

export function dischargePatient(db, args, user) {
  requireRole(user, DISCHARGE_ROLES);

  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) {
    throw new RpcError('admission_id must be a positive integer.', 400);
  }
  // ADM_DISCOUNT_HONOURED_V1 — a discount agreed DURING the stay is stored on
  // the admission by set_admission_discount; discharge used to ignore it and
  // then overwrite it with 0, so the patient was billed full price and the
  // agreed discount vanished. The stored percent is now the default, and an
  // explicit discount_percent argument overrides it at the desk.
  const overridden = args && args.discount_percent !== undefined && args.discount_percent !== null;
  const rawDiscount = overridden ? args.discount_percent : 0;
  if (typeof rawDiscount !== 'number' || !Number.isFinite(rawDiscount) || rawDiscount < 0 || rawDiscount > 100) {
    throw new RpcError('discount_percent must be a finite number between 0 and 100.', 400);
  }
  // The role gate bites only when APPLYING a new discount here. A percent
  // already stored on the admission was authorised by an admin/cashier when it
  // was saved, so a nurse or registrar may still discharge the patient at it —
  // they just cannot introduce one at the door.
  if (rawDiscount > 0 && !DISCOUNT_ROLES.includes(user.role)) {
    throw new RpcError('Only an admin or cashier may apply an accommodation discount.', 403);
  }

  const run = db.transaction(() => {
    const admission = db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId);
    if (!admission) throw new RpcError('admission not found or not active.', 400);
    // Only an active stay can be discharged — a 'requested' one has no bed and
    // no elapsed time to bill, and a discharged one is terminal.
    if (admission.status !== 'active') {
      assertTransition('admission', admission.status, 'discharged');
      throw new RpcError('admission not found or not active.', 400);
    }

    // Effective discount: the explicit argument when one was given, otherwise
    // whatever set_admission_discount stored on the stay. The stored value is
    // re-clamped to [0,100] so a hand-edited row can never produce a negative
    // net or a charge above gross.
    const storedPct = Number(admission.accommodation_discount_percent);
    const discountPct = overridden
      ? rawDiscount
      : (Number.isFinite(storedPct) ? Math.min(100, Math.max(0, storedPct)) : 0);

    const ward = admission.ward_id ? db.prepare('SELECT * FROM wards WHERE id = ?').get(admission.ward_id) : null;
    const bed = admission.bed_id ? db.prepare('SELECT * FROM beds WHERE id = ?').get(admission.bed_id) : null;

    const mode = ward && ward.billing_mode === 'hourly' ? 'hourly' : 'daily';
    const wardDaily = ward ? ward.price_per_day : 0;
    const wardHourly = ward ? ward.price_per_hour : 0;
    const bedDaily = bed ? bed.price_per_day : 0;
    const bedHourly = bed ? bed.price_per_hour : 0;
    const resolvedRate = mode === 'daily'
      ? (bedDaily > 0 ? bedDaily : wardDaily)
      : (bedHourly > 0 ? bedHourly : wardHourly);
    // Clamp a mis-configured negative rate to 0 (no charge) so it can never
    // produce a negative gross/charge_amount (adversarial-review finding #2).
    const rate = Number.isFinite(resolvedRate) && resolvedRate > 0 ? resolvedRate : 0;

    const nowStr = nowIso(db);
    let ms = Date.parse(nowStr) - Date.parse(admission.admitted_at);
    if (!(ms >= 0)) ms = 0;

    let units;
    if (mode === 'daily') {
      let days = Math.floor(ms / 86400000) + 1;
      if (days > 1) days -= 1;
      days = Math.max(1, days);
      units = days;
    } else {
      units = Math.max(1, Math.ceil(ms / 3600000));
    }

    const gross = round2(units * rate);
    if (!Number.isFinite(gross) || gross > MAX_MONEY) {
      throw new RpcError('computed accommodation charge is too large.', 400);
    }

    const net = round2(gross * (1 - discountPct / 100));
    const discountAmt = round2(gross - net);

    // ACCOMMODATION_AS_SERVICE_V1 — выписка БОЛЬШЕ НЕ выставляет счёт за койку.
    //
    // Раньше здесь молча создавался отдельный счёт на проживание, и не брать за
    // койку денег было нельзя: оставалось ставить скидку 100% или править счёт
    // после выписки. Теперь проживание вносят кнопкой на карточке — оно
    // становится строкой admission_services и уходит в ОДИН счёт госпитализации
    // вместе с процедурами (create_invoice_for_admission). Не внесли — не
    // выставили, и это осознанный выбор клиники, а не забытая настройка.
    //
    // invoice_id остаётся пустым: счёт по стационару собирает касса. В
    // charge_amount пишем то, что ДЕЙСТВИТЕЛЬНО внесено к оплате, а не то, что
    // могло бы набежать, — иначе карточка утверждала бы «начислено», когда не
    // начислено ничего.
    const invoiceId = null;
    const billedRow = db.prepare(
      "SELECT total FROM admission_services WHERE admission_id = ? AND notes LIKE 'ACCOMMODATION%' LIMIT 1"
    ).get(admissionId);
    const billedNet = billedRow ? round2(billedRow.total) : 0;

    db.prepare(`
      UPDATE admissions
      SET status='discharged', discharged_at=?, charge_amount=?, invoice_id=?, accommodation_discount_percent=?
      WHERE id=?
    `).run(nowStr, billedNet, invoiceId, discountPct, admissionId);

    if (admission.bed_id) {
      db.prepare("UPDATE beds SET status='cleaning' WHERE id=?").run(admission.bed_id);
    }

    return {
      admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId),
      invoice_id: invoiceId,
      units,
      rate,
      gross,
      discount_amount: discountAmt,
      charge: net,
      mode,
    };
  });

  return run();
}

export function setBedStatus(db, args, user) {
  requireRole(user, BED_STATUS_ROLES);

  const bedId = args && args.bed_id;
  if (!isPositiveInt(bedId)) {
    throw new RpcError('bed_id must be a positive integer.', 400);
  }
  const status = args && args.status;
  if (!BED_STATUS_VALUES.includes(status)) {
    throw new RpcError(`status must be one of: ${BED_STATUS_VALUES.join(', ')}`, 400);
  }

  const run = db.transaction(() => {
    const bed = db.prepare('SELECT * FROM beds WHERE id = ?').get(bedId);
    if (!bed) {
      throw new RpcError('bed not found.', 400);
    }
    const activeAdmission = db.prepare("SELECT 1 FROM admissions WHERE bed_id=? AND status='active'").get(bedId);
    if (activeAdmission) {
      throw new RpcError('bed has an active admission; discharge the patient instead of changing bed status.', 400);
    }

    db.prepare('UPDATE beds SET status=? WHERE id=?').run(status, bedId);
    return { bed: db.prepare('SELECT * FROM beds WHERE id = ?').get(bedId) };
  });

  return run();
}

// BED_CONSOLE_V1 — перевод пациента на другую свободную койку: атомарно
// обновляет госпитализацию, статусы обеих коек и пишет строку в журнал
// движений (admission_transfers, kind 'transfer').
export function transferAdmission(db, args, user) {
  requireRole(user, ADMIT_ROLES);
  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('admission_id must be a positive integer.', 400);
  const toBedId = args && args.to_bed_id;
  if (!isPositiveInt(toBedId)) throw new RpcError('to_bed_id must be a positive integer.', 400);
  const reason = (args && typeof args.reason === 'string' ? args.reason : '').slice(0, 300);

  const run = db.transaction(() => {
    const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId);
    if (!adm) throw new RpcError('admission not found.', 400);
    if (adm.status !== 'active') throw new RpcError('admission is not active.', 400);
    const toBed = db.prepare('SELECT * FROM beds WHERE id = ?').get(toBedId);
    if (!toBed || !toBed.active) throw new RpcError('bed not found.', 400);
    if (toBed.id === adm.bed_id) throw new RpcError('пациент уже на этой койке.', 400);
    if (toBed.status !== 'free' || db.prepare("SELECT 1 FROM admissions WHERE bed_id=? AND status='active'").get(toBedId)) {
      throw new RpcError('койка занята или недоступна.', 400);
    }

    const fromBedId = adm.bed_id, fromWardId = adm.ward_id;
    db.prepare('UPDATE admissions SET bed_id = ?, ward_id = ? WHERE id = ?').run(toBedId, toBed.ward_id, admissionId);
    if (fromBedId) db.prepare("UPDATE beds SET status='cleaning' WHERE id = ?").run(fromBedId);
    db.prepare("UPDATE beds SET status='occupied' WHERE id = ?").run(toBedId);
    db.prepare(`
      INSERT INTO admission_transfers (admission_id, from_bed_id, to_bed_id, from_ward_id, to_ward_id, kind, reason, transferred_at, transferred_by)
      VALUES (?, ?, ?, ?, ?, 'transfer', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)
    `).run(admissionId, fromBedId, toBedId, fromWardId, toBed.ward_id, reason || null, user.id);

    return { admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId) };
  });
  return run();
}

// BED_CONSOLE_V1 — сохранить скидку на проживание (учитывается сервером при
// выписке). Скидка — денежная привилегия: только admin/cashier (см. DISCOUNT_ROLES).
export function setAdmissionDiscount(db, args, user) {
  requireRole(user, DISCOUNT_ROLES);
  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('admission_id must be a positive integer.', 400);
  const pct = args && args.percent;
  if (!(typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100)) {
    throw new RpcError('percent must be 0..100.', 400);
  }
  const adm = db.prepare('SELECT id FROM admissions WHERE id = ?').get(admissionId);
  if (!adm) throw new RpcError('admission not found.', 400);
  db.prepare('UPDATE admissions SET accommodation_discount_percent = ? WHERE id = ?').run(pct, admissionId);
  return { admission_id: admissionId, percent: pct };
}
