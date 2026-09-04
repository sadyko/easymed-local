// Server-side inpatient RPCs (ward & bed admission / discharge). Accommodation
// charges are computed here from DB rows (ward/bed rates, elapsed stay) —
// client-supplied amounts are never trusted. Every handler that touches
// money or bed/admission state runs inside db.transaction(...)() for atomicity.

import { nextInvoiceNumber } from './billing.js';
import { assertTransition } from '../domain/lifecycle.js';
import { hasAnyRole } from '../roles.js';
// INPATIENT_FLOW_V1 (миграция 091) — «в койке» это ЧЕТЫРЕ состояния, а не одно.
// Каждый запрос ниже, который раньше спрашивал status='active', спрашивает этот
// список: поступивший, но ещё не осмотренный пациент лежит в койке точно так же,
// как лечащийся, — койка занята, и суточное за неё идёт.
import {
  IN_BED_STATUSES, OPEN_STATUSES,
  // ADMISSION_ORDER_V1 (Задача 2) — заявка и размещение НЕ двигают статус
  // руками: состояние переводит машина маршрута, она же проверяет роль.
  admissionTransition, assertMayTransition, loadAdmission,
} from './inpatient-flow.js';

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

// Списки состояний для SQL. Строятся из одного источника (inpatient-flow.js),
// а не переписываются в каждом запросе: разошедшиеся копии этого списка — самый
// дорогой способ сломать стационар (койка «свободна», пациент в ней).
const IN_BED_SQL = IN_BED_STATUSES.map((s) => `'${s}'`).join(',');
const OPEN_SQL = OPEN_STATUSES.map((s) => `'${s}'`).join(',');

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
    // INPATIENT_FLOW_V1 — открыта = заявка ИЛИ любое состояние в койке. Раньше
    // список был ('requested','active'); между ними теперь два шага, и пациент,
    // лежащий в 'admitted', получил бы вторую заявку в стационар.
    const open = db.prepare(`SELECT status FROM admissions WHERE patient_id=? AND status IN (${OPEN_SQL})`).get(patientId);
    if (open) {
      throw new RpcError(open.status === 'ordered'
        ? 'patient already has a pending admission request.'
        : 'patient already has an active admission.', 400);
    }

    const info = db.prepare(`
      INSERT INTO admissions (patient_id, doctor_id, pathway, chief_complaint, admission_diagnosis, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'ordered', ?)
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

    db.prepare("UPDATE admissions SET status = 'cancelled', discharged_at = ? WHERE id = ? AND status = 'ordered'")
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

    // INPATIENT_FLOW_V1 — один пациент, одна койка: считаем ВСЕ состояния в
    // койке, а не только 'active'.
    const patientActive = db.prepare(`SELECT 1 FROM admissions WHERE patient_id=? AND status IN (${IN_BED_SQL})`).get(patientId);
    if (patientActive) {
      throw new RpcError('patient already has an active admission.', 400);
    }
    const bedActive = db.prepare(`SELECT 1 FROM admissions WHERE bed_id=? AND status IN (${IN_BED_SQL})`).get(bedId);
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
    const pending = db.prepare("SELECT * FROM admissions WHERE patient_id=? AND status='ordered' ORDER BY id LIMIT 1").get(patientId);

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
         WHERE id = ? AND status = 'ordered'
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
    // ВЫПИСЫВАЮТ ЛЮБОГО, КТО В КОЙКЕ, — а не только того, кто дошёл до лечения.
    //
    // Здесь стояло `!== 'active'`, и это было верно ровно до Задачи 2. Она
    // научила медсестру класть пациента в 'admitted', и в тот же день
    // появилась дыра, которую видно только со стороны пациента: между
    // 'admitted' и 'active' стоят первичный осмотр главного врача и назначение
    // лечащего, а выписка требовала 'active'. Пациента, положенного через окно
    // медсестры, НЕЛЬЗЯ БЫЛО ВЫПИСАТЬ ВООБЩЕ, пока главный врач его не
    // осмотрит: человека держал в клинике порядок сборки программы. Домой
    // уходят и из приёмного покоя — до всякого лечения.
    //
    // 'ordered' сюда не входит намеренно: у заявки нет ни койки, ни прожитого
    // времени, и «выписывать» там нечего — её ОТМЕНЯЮТ
    // (admission_order_cancel). Закрытую госпитализацию не открывают заново.
    //
    // Выписка остаётся ОДНОШАГОВОЙ: двухшаговую (заявка лечащего врача →
    // оформление старшей медсестрой) строит Задача 8, она же уберёт этот путь
    // целиком вместе со стрелками LEGACY_EDGES.
    if (!IN_BED_STATUSES.includes(admission.status)) {
      throw new RpcError(
        admission.status === 'ordered'
          ? 'Пациент ещё не размещён на койке — заявку на госпитализацию отменяют, а не выписывают.'
          : admission.status === 'cancelled'
            ? 'Заявка на госпитализацию отменена — выписывать некого.'
            : 'Пациент уже выписан — госпитализация закрыта.', 400);
    }
    // Правило базы: статус пишут только после того, как его одобрил маршрут.
    assertTransition('admission', admission.status, 'discharged');

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
    // INPATIENT_FLOW_V1 — койку нельзя объявить свободной под кем угодно из
    // лежащих, а не только под лечащимся: до 091 запрос смотрел на 'active'.
    const activeAdmission = db.prepare(`SELECT 1 FROM admissions WHERE bed_id=? AND status IN (${IN_BED_SQL})`).get(bedId);
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
    // INPATIENT_FLOW_V1 — перевести можно любого, кто лежит: пациента переводят
    // и до первичного осмотра (палата занята, освободилась другая).
    if (!IN_BED_STATUSES.includes(adm.status)) throw new RpcError('admission is not active.', 400);
    const toBed = db.prepare('SELECT * FROM beds WHERE id = ?').get(toBedId);
    if (!toBed || !toBed.active) throw new RpcError('bed not found.', 400);
    if (toBed.id === adm.bed_id) throw new RpcError('пациент уже на этой койке.', 400);
    if (toBed.status !== 'free' || db.prepare(`SELECT 1 FROM admissions WHERE bed_id=? AND status IN (${IN_BED_SQL})`).get(toBedId)) {
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

// ═══════════════════════════════════════════════════════════════════════════
// ADMISSION_ORDER_V1 — заявка на госпитализацию и размещение на койке
// (Задача 2 плана docs/plans/2026-09-04-inpatient-workflow.md)
// ═══════════════════════════════════════════════════════════════════════════
//
// Маршрут владельца начинается здесь: «регистрация пациента → ЗАЯВКА НА
// ГОСПИТАЛИЗАЦИЮ → медсестра КЛАДЁТ НА КОЙКУ → …». Три обработчика ниже — эти
// две стрелки и отмена между ними.
//
// ПОЧЕМУ ОНИ НЕ ТРОГАЮТ status НАПРЯМУЮ. Состояние двигает только
// admissionTransition (inpatient-flow.js): она знает порядок шагов, знает
// матрицу прав и подписывает шаг (кем, когда). Здесь остаётся то, чего машина
// маршрута знать не должна, — что такое койка и что такое палата.
//
// ЧТО ОСТАЁТСЯ ЖИТЬ РЯДОМ. `request_admission` (выше) — та же заявка, поданная
// ВРАЧОМ из кабинета: она пишет ту же строку в том же 'ordered' и попадает в то
// же окно медсестры. Это не дубль, а второй вход, которым владелец пользуется:
// направление в стационар рождается на приёме. `admit_patient` (выше) —
// быстрый путь v0.8.0 (доска коек, поступление одним движением), он тоже
// остаётся: убрать его до Задачи 3 значило бы, что положенного медсестрой
// пациента некому перевести в 'active' и, следовательно, некому выписать.

// Кто оформляет заявку — матрица плана, строка «Создать заявку на
// госпитализацию»: регистратура, старшая медсестра, врач, главный врач,
// администратор. Медсестры здесь нет намеренно: её дело — разместить.
const ORDER_CREATE_ROLES = ['registrar', 'senior_nurse', 'doctor', 'head_doctor', 'admin'];
const ADMISSION_TYPES = ['planned', 'emergency'];
const STAY_MODES = ['round', 'day'];

function textArg(v, max) {
  return (typeof v === 'string' ? v : '').trim().slice(0, max);
}

/**
 * Заявка на госпитализацию: строка в 'ordered', БЕЗ койки и без денег.
 *
 * Койку не занимает специально. Заявка — это «пациента ждут в отделении», а не
 * «место забронировано»: подержи она койку, отделение считало бы занятыми
 * места, на которых никто не лежит, и суточное начисление пришлось бы учить
 * различать «лежит» и «обещали».
 *
 * @param {{patient_id:number, ward_id?:number, department?:string,
 *          admission_type?:'planned'|'emergency', stay_mode?:'round'|'day',
 *          planned_at?:string, note?:string, doctor_id?:number}} args
 */
export function admissionOrderCreate(db, args, user) {
  if (!hasAnyRole(user, ORDER_CREATE_ROLES)) {
    throw new RpcError('Оформить заявку на госпитализацию может регистратура, старшая медсестра, врач, главный врач или администратор.', 403);
  }

  const patientId = args && args.patient_id;
  if (!isPositiveInt(patientId)) throw new RpcError('patient_id must be a positive integer.', 400);

  const rawWard = args && args.ward_id;
  const wardId = rawWard === undefined || rawWard === null || rawWard === '' ? null : Number(rawWard);
  if (wardId !== null && !isPositiveInt(wardId)) throw new RpcError('ward_id must be a positive integer.', 400);

  const rawDoctor = args && args.doctor_id;
  const doctorId = rawDoctor === undefined || rawDoctor === null || rawDoctor === '' ? null : Number(rawDoctor);
  if (doctorId !== null && !isPositiveInt(doctorId)) throw new RpcError('doctor_id must be a positive integer.', 400);

  const admissionType = (args && args.admission_type) || 'planned';
  if (!ADMISSION_TYPES.includes(admissionType)) {
    throw new RpcError('Тип госпитализации: плановая или экстренная.', 400);
  }
  const stayMode = (args && args.stay_mode) || 'round';
  if (!STAY_MODES.includes(stayMode)) {
    throw new RpcError('Режим пребывания: круглосуточный или дневной.', 400);
  }
  const department = textArg(args && args.department, 120);
  const plannedAt = textArg(args && args.planned_at, 40) || null;
  const note = textArg(args && args.note, 500);

  const run = db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) {
      throw new RpcError('Пациент не найден.', 400);
    }
    if (wardId !== null && !db.prepare('SELECT 1 FROM wards WHERE id = ?').get(wardId)) {
      throw new RpcError('Палата не найдена.', 400);
    }
    if (doctorId !== null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(doctorId)) {
      throw new RpcError('Направивший врач не найден.', 400);
    }
    // ОДНА ОТКРЫТАЯ ГОСПИТАЛИЗАЦИЯ НА ПАЦИЕНТА — тот же список OPEN_SQL, что у
    // request_admission: заявка врача и заявка регистратуры не должны
    // складываться в две очереди на одного человека.
    const open = db.prepare(`SELECT status FROM admissions WHERE patient_id=? AND status IN (${OPEN_SQL})`).get(patientId);
    if (open) {
      throw new RpcError(open.status === 'ordered'
        ? 'У пациента уже есть незакрытая заявка на госпитализацию.'
        : 'Пациент уже госпитализирован.', 400);
    }

    const at = nowIso(db);
    const info = db.prepare(`
      INSERT INTO admissions
        (patient_id, ward_id, doctor_id, department, admission_type, stay_mode,
         planned_at, chief_complaint, status, ordered_at, ordered_by, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ordered', ?, ?, ?)
    `).run(patientId, wardId, doctorId, department, admissionType, stayMode,
           plannedAt, note, at, user.id, user.id);
    const admissionId = info.lastInsertRowid;
    db.prepare("UPDATE admissions SET admission_no = 'ADM-' || substr('00000'||id,-5,5) WHERE id=?").run(admissionId);
    // Журнал движений: заявка — тоже событие с пациентом, и «когда это
    // началось» должно читаться из одного места вместе с поступлением и
    // переводами (BED_CONSOLE_V1).
    db.prepare(`
      INSERT INTO admission_transfers (admission_id, to_ward_id, kind, reason, transferred_at, transferred_by)
      VALUES (?, ?, 'order', ?, ?, ?)
    `).run(admissionId, wardId, note || null, at, user.id);

    return { admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId) };
  });

  return run();
}

/**
 * Отмена заявки: 'cancelled' с ПРИЧИНОЙ.
 *
 * Причина обязательна. Отменённая заявка — единственный след того, что пациента
 * ждали и не дождались; без слова «почему» этот след не отвечает ни на один
 * вопрос, ради которого к нему приходят («передумали?», «увезли в другую
 * клинику?», «завели по ошибке?»).
 *
 * Койку, если она уже занята (отмена возможна и из 'admitted'), отпускает в
 * 'cleaning', а не в 'free' — правило референса, то же, что при выписке:
 * освободившаяся койка не готова, пока её не убрали.
 */
export function admissionOrderCancel(db, args, user) {
  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('admission_id must be a positive integer.', 400);
  const reason = textArg(args && args.reason, 300);
  if (!reason) throw new RpcError('Укажите причину отмены заявки.', 400);

  const run = db.transaction(() => {
    const before = loadAdmission(db, admissionId);
    const res = admissionTransition(db, { admission_id: admissionId, to: 'cancelled', reason }, user);
    if (before.bed_id) {
      db.prepare("UPDATE beds SET status='cleaning' WHERE id=?").run(before.bed_id);
    }
    db.prepare(`
      INSERT INTO admission_transfers (admission_id, from_bed_id, from_ward_id, kind, reason, transferred_at, transferred_by)
      VALUES (?, ?, ?, 'cancel', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)
    `).run(admissionId, before.bed_id, before.ward_id, reason, user.id);
    return { admission: res.admission };
  });

  return run();
}

/**
 * Размещение на койке: медсестра выполняет заявку.
 *
 * ПОРЯДОК ПРОВЕРОК ЗДЕСЬ — СОДЕРЖАНИЕ, А НЕ ОФОРМЛЕНИЕ. Он отвечает на вопрос
 * «что человеку у экрана делать дальше», и каждая перестановка делает ответ
 * хуже:
 *   1. состояние заявки — «пациент уже на койке» важнее всего остального;
 *   2. РОЛЬ — кассиру нужно услышать «это делает медсестра», а не «койка на
 *      уборке»: второй ответ отправляет искать другую койку там, где дело не в
 *      койке (см. assertMayTransition);
 *   3. койка — существует, в фонде, свободна, из той палаты, что названа в
 *      заявке;
 *   4. пациент — не лежит уже где-то ещё.
 *
 * 'cleaning' и 'maintenance' называются СВОИМИ СЛОВАМИ, а не «койка недоступна»:
 * убрать палату и вызвать техника — разные действия разных людей, и экран
 * обязан сказать, какое из них нужно.
 */
export function admissionAdmit(db, args, user) {
  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('admission_id must be a positive integer.', 400);
  const bedId = args && args.bed_id;
  if (!isPositiveInt(bedId)) throw new RpcError('bed_id must be a positive integer.', 400);
  const at = typeof (args && args.at) === 'string' && args.at ? args.at : null;

  const run = db.transaction(() => {
    const adm = loadAdmission(db, admissionId);

    // 1. Заявка ли это ещё.
    if (adm.status !== 'ordered') {
      throw new RpcError(
        IN_BED_STATUSES.includes(adm.status) ? 'Пациент уже размещён на койке.'
        : adm.status === 'cancelled'         ? 'Заявка на госпитализацию отменена — положить пациента нельзя.'
        : adm.status === 'discharged'        ? 'Пациент уже выписан — госпитализация закрыта.'
        : 'Положить на койку можно только по оформленной заявке.', 400);
    }

    // 2. Роль (до койки — см. шапку).
    assertMayTransition('ordered', 'admitted', user);

    // 3. Койка.
    const bed = db.prepare('SELECT * FROM beds WHERE id = ?').get(bedId);
    if (!bed) throw new RpcError('Койка не найдена.', 400);
    if (bed.active !== 1) throw new RpcError('Койка выведена из коечного фонда.', 400);
    if (bed.status === 'cleaning')    throw new RpcError('Койка на уборке — сначала подтвердите уборку.', 400);
    if (bed.status === 'maintenance') throw new RpcError('Койка в ремонте — положить пациента нельзя.', 400);
    if (bed.status !== 'free')        throw new RpcError('Койка занята.', 400);
    // Занятость СЧИТАЕТСЯ ПО ГОСПИТАЛИЗАЦИЯМ, а не по beds.status: статус койки
    // — housekeeping, и разойтись с правдой он может (ровно от этого доска коек
    // считает occupied по admissions, а не по колонке).
    if (db.prepare(`SELECT 1 FROM admissions WHERE bed_id=? AND status IN (${IN_BED_SQL})`).get(bedId)) {
      throw new RpcError('Койка занята другим пациентом.', 400);
    }
    // Палата из заявки. Проверяем ТОЛЬКО когда заявка её называет: чаще всего
    // палату выбирает та же медсестра в момент размещения, и требовать её
    // заранее значило бы заставить регистратуру угадывать коечный фонд.
    if (adm.ward_id != null && bed.ward_id !== adm.ward_id) {
      const want = db.prepare('SELECT name FROM wards WHERE id = ?').get(adm.ward_id);
      throw new RpcError('Койка из другой палаты: заявка оформлена в «' + ((want && want.name) || adm.ward_id) + '».', 400);
    }

    // 4. Один пациент — одна койка.
    if (db.prepare(`SELECT 1 FROM admissions WHERE patient_id=? AND id<>? AND status IN (${IN_BED_SQL})`).get(adm.patient_id, adm.id)) {
      throw new RpcError('У пациента уже есть открытая госпитализация на койке.', 400);
    }

    // Койка и палата — дело этого обработчика; состояние и подпись шага
    // (admitted_by / admitted_at) — дело машины маршрута.
    db.prepare('UPDATE admissions SET bed_id = ?, ward_id = ? WHERE id = ?').run(bedId, bed.ward_id, adm.id);
    const res = admissionTransition(db, { admission_id: adm.id, to: 'admitted', at }, user);
    db.prepare("UPDATE beds SET status='occupied' WHERE id=?").run(bedId);
    db.prepare(`
      INSERT INTO admission_transfers (admission_id, to_bed_id, to_ward_id, kind, transferred_at, transferred_by)
      VALUES (?, ?, ?, 'admit', ?, ?)
    `).run(adm.id, bedId, bed.ward_id, res.admission.admitted_at, user.id);

    return { admission: res.admission, bed: db.prepare('SELECT * FROM beds WHERE id = ?').get(bedId) };
  });

  return run();
}
