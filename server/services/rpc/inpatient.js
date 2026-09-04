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
// ПРИЗНАК ВРАЧА — один на сервер (см. шапку функции в inpatient-reviews.js):
// администратор клиники может быть врачом, и по тексту роли это не видно.
// Старый путь поступления обязан спросить его тем же вопросом, что и новый, —
// иначе «лечащий врач» на карточке и «лечащий врач» в назначениях разъедутся.
import { isDoctorRow } from './inpatient-reviews.js';

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const ADMIT_ROLES = ['admin', 'registrar', 'nurse', 'doctor'];
// ВЫПИСЫВАЮТ ТЕ, КТО СТОИТ У КОЙКИ. Кассир и регистратура убраны отсюда, и это
// исправление, а не ужесточение.
//
// Прямая выписка закрывает госпитализацию из любого состояния «в койке»: без
// исхода, без эпикриза, без врачебной подписи. Пока список звучал как
// «admin, registrar, nurse, cashier», это означало, что человек за кассой или
// за стойкой регистратуры мог закрыть чужую историю болезни — при том, что
// исход госпитализации («выписан домой» / «переведён» / «летальный исход») по
// правилу TWO_STEP_DISCHARGE_V1 объявляет ВРАЧ, а оформляет старшая медсестра.
// Ни кассир, ни регистратор в новом порядке выписку не подписывают нигде
// (TRANSITION_ROLES в inpatient-flow.js: 'active→discharging' — врач,
// 'discharging→discharged' — старшая медсестра, главный врач, админ), и
// оставлять им СТАРУЮ кнопку значило бы держать открытым ровно тот вход,
// который новый маршрут закрыл.
//
// Старшая медсестра и главный врач, наоборот, добавлены: именно они оформляют
// выписку в новом порядке, и наследственный путь не должен быть им закрыт там,
// где открыт рядовой медсестре.
const DISCHARGE_ROLES = ['admin', 'nurse', 'senior_nurse', 'head_doctor'];
// Applying a money discount is a stricter privilege than discharging: a nurse
// or registrar can discharge (at full accommodation price) but may NOT waive or
// reduce the bill — only an admin or cashier can (adversarial-review finding #1).
const DISCOUNT_ROLES = ['admin', 'cashier'];
// TWO_STEP_DISCHARGE_V1 — «койку убрали, она готова» отмечает тот, кто в
// отделении работает. Старшая медсестра и главный врач добавлены сюда Задачей
// 8: после выписки койка уходит в 'cleaning', и вернуть её в 'free' — это
// второе, отдельное действие (правило референса: выписанная койка не свободна).
// Без них старшая медсестра могла ОФОРМИТЬ выписку и не могла открыть
// освободившуюся койку — то есть шаг, который она же и породила, оставался ей
// недоступен.
const BED_STATUS_ROLES = ['admin', 'registrar', 'nurse', 'senior_nurse', 'head_doctor'];
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

// ─── ГРАНИЦА ВЫПУСКА: КТО ЕЩЁ ВПРАВЕ ХОДИТЬ СТАРЫМ ПУТЁМ ────────────────────
//
// `admit_patient` и `discharge_patient` — RPC версии v0.8.0. Каждый делает
// СВОИМ ОДНИМ ДВИЖЕНИЕМ то, на что новый маршрут тратит четыре подписи, и
// потому каждый — обход маршрута:
//
//   admit_patient      писал status='active' с пустыми examined_* и
//                      attending_doctor_id: заявка → медсестра → первичный
//                      осмотр → лечащий врач пропускались одним нажатием, и
//                      получившуюся госпитализацию нельзя было ни лечить
//                      (assertCanPrescribe: «Назначения ведёт лечащий врач
//                      этого пациента»), ни починить;
//   discharge_patient  закрывал госпитализацию без исхода, без эпикриза и без
//                      врачебной подписи — из любого состояния «в койке».
//
// УБРАТЬ ИХ СОВСЕМ БЫЛО НЕЛЬЗЯ, и довод тот же, каким жил LEGACY_EDGES: в день
// обновления в койках лежат люди, которых клали ДО него. У них нет выписного
// эпикриза (без него новый первый шаг заявку не примет), а у части — и
// лечащего врача (091 переносит attending_doctor_id := doctor_id, а старый
// admit_patient позволял ему быть пустым). Закрыть старый путь для них значит
// запереть живого человека в клинике порядком сборки программы.
//
// ЗАТО ЕГО МОЖНО ЗАКРЫТЬ ДЛЯ ВСЕХ ОСТАЛЬНЫХ, и граница проходит там, где ей
// естественно проходить: `schema_migrations.applied_at` миграции 091 — это
// МОМЕНТ, КОГДА ЭТА КЛИНИКА ОБНОВИЛАСЬ. Госпитализация, заведённая раньше, —
// наследство; заведённая позже — прошла новым маршрутом целиком, и старому
// пути в ней делать нечего. Дата не выдумана и не захардкожена: у каждой
// клиники она своя, и наследство естественно кончается само, когда выпишется
// последний, кто лежал до обновления.
const RELEASE_MIGRATION = '091_inpatient_workflow.sql';

function releaseCutoff(db) {
  let row = null;
  try {
    row = db.prepare('SELECT applied_at FROM schema_migrations WHERE name = ?').get(RELEASE_MIGRATION);
  } catch {
    row = null;   // база старше таблицы миграций — наследства в ней нет по определению
  }
  return (row && row.applied_at) || null;
}

/**
 * Заведена ли эта госпитализация ДО обновления, то есть вправе ли она ходить
 * старым путём.
 *
 * Обе даты — ISO 'YYYY-MM-DDTHH:MM:SSZ' в UTC (DEFAULT колонки и applied_at
 * пишет одно и то же strftime), поэтому сравнение строк здесь — сравнение
 * времени, а не совпадение.
 */
function isLegacyAdmission(db, adm) {
  const cutoff = releaseCutoff(db);
  if (!cutoff) return false;
  const created = adm && (adm.created_at || adm.admitted_at);
  return typeof created === 'string' && created !== '' && created < cutoff;
}

// Текст отказа — ОДИН на оба старых RPC: человек у экрана должен узнать не
// «нельзя», а куда идти. Слова названы теми же, что стоят на экранах.
const LEGACY_ADMIT_REFUSAL =
  'Госпитализация одним нажатием больше не открывает лечение: так пациент оставался без '
  + 'первичного осмотра и без лечащего врача. Оформите заявку и положите пациента в разделе '
  + '«Стационар»: медсестра размещает на койке, главный врач проводит первичный осмотр и '
  + 'назначает лечащего врача.';

const LEGACY_DISCHARGE_REFUSAL =
  'Прямая выписка осталась только для тех, кого положили до этого обновления. Эту '
  + 'госпитализацию выписывают в два шага: лечащий врач подаёт заявку на выписку в карте '
  + 'госпитализации (исход, эпикриз, рекомендации), старшая медсестра оформляет её на экране '
  + '«Выписки к оформлению».';

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

/**
 * СТАРЫЙ ПУТЬ ПОСТУПЛЕНИЯ — ТОЛЬКО ДЛЯ ЗАЯВОК, ОФОРМЛЕННЫХ ДО ЭТОГО ОБНОВЛЕНИЯ.
 *
 * Что здесь изменилось и почему (разбор C1):
 *
 *   1. НОВУЮ госпитализацию этот RPC больше НЕ ЗАВОДИТ. Раньше он писал
 *      status='active' на пустом месте: без заявки, без размещения медсестрой,
 *      без первичного осмотра и без лечащего врача. Экран доски коек звал его
 *      кнопкой «Госпитализировать», а миграция 092 выдала эту доску медсестре,
 *      старшей медсестре, главному врачу и регистратуре — то есть весь маршрут
 *      владельца обходился одним нажатием у четырёх ролей сразу, и пациент
 *      оставался БЕЗ ЛЕЧАЩЕГО ВРАЧА: назначения ему отказывали (403 «Назначения
 *      ведёт лечащий врач этого пациента»), а admission_set_attending отвечал
 *      «Лечащий врач уже назначен», потому что смотрел на статус. Кнопка убрана
 *      с экрана (views/ward-beds.js), а вход закрыт здесь — экран не защита,
 *      /api/rpc открыт curl'ом с любого компьютера клиники.
 *
 *   2. ЗАЯВКУ, ОФОРМЛЕННУЮ ДО ОБНОВЛЕНИЯ, он по-прежнему выполняет. Это то же
 *      наследство, ради которого живут LEGACY_EDGES: строки в 'ordered',
 *      заведённые старым request_admission, существуют в живых базах, и
 *      закрывать им дорогу в день обновления незачем — новый экран их тоже
 *      кладёт, но внешние вызовы на этот RPC уже написаны.
 *
 *   3. И ДАЖЕ ТОГДА ОН НЕ ОСТАВЛЯЕТ ПАЦИЕНТА БЕЗ ЛЕЧАЩЕГО ВРАЧА. Раз этот путь
 *      ведёт сразу в 'active' (лечение открыто), он ОБЯЗАН проставить то, чем
 *      лечение подписывают: attending_doctor_id и отметку осмотра. Без врача
 *      поступление отвергается, а не проходит молча.
 */
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

    // ГРАНИЦА ВЫПУСКА (см. isLegacyAdmission выше). Заявки нет вовсе — значит
    // этот вызов завёл бы НОВУЮ госпитализацию мимо маршрута; заявка есть, но
    // оформлена уже после обновления — значит она пришла новым путём и им же
    // должна дойти до койки. В обоих случаях отказ называет экран, а не «нельзя».
    if (!pending || !isLegacyAdmission(db, pending)) {
      throw new RpcError(LEGACY_ADMIT_REFUSAL, 400);
    }

    // ЛЕЧАЩИЙ ВРАЧ ОБЯЗАТЕЛЕН НА ЭТОМ ПУТИ, и это прямое следствие того, куда
    // путь ведёт: в 'active', где назначения уже открыты. Кто их подписывает,
    // спрашивает assertCanPrescribe — и на пустом attending_doctor_id отвечает
    // 403 всем, включая того самого врача, который пациента и ведёт. Раньше
    // такая госпитализация была невосстановима; теперь её нельзя даже создать.
    // Направивший (doctor_id заявки) годится в лечащие по умолчанию — чаще
    // всего это один человек.
    const attendingId = doctorId !== null ? doctorId : pending.doctor_id;
    if (!attendingId) {
      throw new RpcError(
        'Укажите лечащего врача: без него по этой госпитализации нельзя будет ни назначить '
        + 'лечение, ни выписать пациента заявкой. ' + LEGACY_ADMIT_REFUSAL, 400);
    }
    const attending = db.prepare(
      'SELECT id, role, is_doctor, specialty, license_number, active FROM users WHERE id = ?').get(attendingId);
    if (!attending) throw new RpcError('doctor not found.', 400);
    if (!isDoctorRow(attending)) {
      throw new RpcError('Лечащим врачом можно назначить только врача: у выбранного сотрудника нет признака врача.', 400);
    }
    if (attending.active === 0) {
      throw new RpcError('Сотрудник уволен — лечащим врачом его назначить нельзя.', 400);
    }

    const at = nowIso(db);
    assertTransition('admission', pending.status, 'active');
    // Details supplied at the desk win; anything omitted keeps what the
    // referring doctor filed.
    //
    // ПОДПИСИ ПРОПУЩЕННЫХ ШАГОВ. Этот путь сжимает размещение, первичный осмотр
    // и назначение лечащего в ОДНО действие ОДНОГО человека, и все три отметки
    // ставятся его именем. Оставить их пустыми было бы хуже, чем «неточно»:
    // строка стала бы неотличима от мигрировавшей (091 намеренно оставляет
    // examined_* пустыми у тех, кто лежал до обновления), а разбор «кто открыл
    // лечение, минуя осмотр» обязан их различать. COALESCE — чтобы повторный
    // вызов не переписал уже стоящую подпись.
    db.prepare(`
      UPDATE admissions
         SET bed_id = ?, ward_id = ?, status = 'active',
             admitted_at = ?,
             admitted_by = COALESCE(admitted_by, ?),
             examined_at = COALESCE(examined_at, ?),
             examined_by = COALESCE(examined_by, ?),
             attending_doctor_id = ?,
             doctor_id = COALESCE(?, doctor_id, ?),
             pathway = ?,
             chief_complaint = CASE WHEN ? <> '' THEN ? ELSE chief_complaint END,
             admission_diagnosis = CASE WHEN ? <> '' THEN ? ELSE admission_diagnosis END
       WHERE id = ? AND status = 'ordered'
    `).run(bedId, bed.ward_id, at,
           (user && user.id) || null, at, (user && user.id) || null,
           attendingId, doctorId, attendingId, pathway,
           chiefComplaint, chiefComplaint, admissionDiagnosis, admissionDiagnosis, pending.id);
    const admissionId = pending.id;

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
    // ЭТО ТЕПЕРЬ СТАРЫЙ ПУТЬ, И ОН ОСТАВЛЕН РАБОТАТЬ (TWO_STEP_DISCHARGE_V1,
    // Задача 8). Новый порядок — два шага: admission_discharge_request
    // (лечащий врач: исход и эпикриз) → admission_discharge_finalize (старшая
    // медсестра: время, чек-лист, койка). Он построен РЯДОМ, ниже в этом файле.
    //
    // Убрать прямую выписку в тот же день было нельзя: в койках лежат
    // пациенты, положенные ДО обновления, и выписного эпикриза у них нет — а
    // новый первый шаг без опубликованного эпикриза заявку не примет. Отделение
    // упёрлось бы в отказ на живом человеке. Стрелки перечислены в LEGACY_EDGES
    // (inpatient-flow.js), и тест держит инвариант: из КАЖДОГО состояния «в
    // койке» наружу ведёт хотя бы один путь.
    //
    // НО ТОЛЬКО ДЛЯ НИХ — см. границу выпуска ниже. «Оставлено работать» и
    // «оставлено работать навсегда для всех» — разные вещи, и разбор C1 показал
    // цену второго: 16 сочетаний роли и состояния закрывали чужую историю
    // болезни без исхода, без эпикриза и без подписи врача.
    if (!IN_BED_STATUSES.includes(admission.status)) {
      throw new RpcError(
        admission.status === 'ordered'
          ? 'Пациент ещё не размещён на койке — заявку на госпитализацию отменяют, а не выписывают.'
          : admission.status === 'cancelled'
            ? 'Заявка на госпитализацию отменена — выписывать некого.'
            : 'Пациент уже выписан — госпитализация закрыта.', 400);
    }

    // ГРАНИЦА ВЫПУСКА (см. isLegacyAdmission выше). ЭТА ПРОВЕРКА СТОИТ ПОСЛЕ
    // проверки состояния намеренно: у заявки, у отменённой и у уже выписанной
    // госпитализации свой точный ответ, и заменять его рассказом про два шага
    // значило бы отвечать не на тот вопрос.
    //
    // Наследство — это ЛЮДИ В КОЙКАХ НА МОМЕНТ ОБНОВЛЕНИЯ, а не «кнопка
    // навсегда». У них нет выписного эпикриза и не будет: их клали до того,
    // как он стал обязателен, и новый первый шаг их заявку не примет. Всё, что
    // завели ПОСЛЕ обновления, прошло маршрут целиком — у него есть лечащий
    // врач, есть кому подписать исход, и обходить два шага незачем.
    if (!isLegacyAdmission(db, admission)) {
      throw new RpcError(LEGACY_DISCHARGE_REFUSAL, 400);
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

// ═══════════════════════════════════════════════════════════════════════════
// TWO_STEP_DISCHARGE_V1 — ВЫПИСКА В ДВА ШАГА
// (Задача 8 плана docs/plans/2026-09-04-inpatient-workflow.md)
// ═══════════════════════════════════════════════════════════════════════════
//
// ─── ПОЧЕМУ ДВА, А НЕ ОДНА КНОПКА ───────────────────────────────────────────
//
// Клиническая готовность и административная выписка — разные события разных
// людей, и между ними проходят часы. ВРАЧ НЕ ОСВОБОЖДАЕТ КОЙКУ: пациент ещё
// лежит, счёт не собран, документы не выданы, перевозка приедет к трём.
// МЕДСЕСТРА НЕ ОБЪЯВЛЯЕТ ИСХОД: «выписан домой» / «переведён» / «летальный
// исход» — врачебное заключение, и подписывает его тот, кто лечил.
//
// Шаг 1  admission_discharge_request    'active' → 'discharging'
//        лечащий врач / главный врач / администратор. Исход, эпикриз (уже
//        опубликованный), рекомендации, планируемая дата.
// Шаг 1' admission_discharge_cancel_request   'discharging' → 'active'
//        ОТЗЫВ заявки. Референс этого не умеет — см. domain/lifecycle.js.
// Шаг 2  admission_discharge_finalize   'discharging' → 'discharged'
//        старшая медсестра / главный врач / администратор. Фактическое время,
//        чек-лист, долг, койка в 'cleaning'.
//
// ─── ЧЕГО ЗДЕСЬ НЕТ ─────────────────────────────────────────────────────────
//
// Своих правил маршрута и своей матрицы прав: и «дошёл ли пациент», и «вправе
// ли этот человек» спрашиваются у inpatient-flow.js — там же, где их
// спрашивают Задачи 2, 3 и 4.
//
// Запрета выписывать по-старому: discharge_patient (выше) остаётся рабочим для
// тех, кого положили до обновления. См. комментарий там.

// Исход госпитализации. Четыре значения — то, что спрашивает отчётность, и то,
// что записано в CHECK миграции 097. Список живёт ЗДЕСЬ, а не в двух местах:
// экран получает его вместе с очередью.
export const DISCHARGE_OUTCOMES = ['home', 'transfer', 'refuse', 'death'];

// Кто ЧИТАЕТ очередь выписок. Шире, чем кто её оформляет: врач должен видеть,
// что с его заявкой, а медсестра поста — кого сегодня отпускают. Кассы и склада
// здесь нет: это не документ на деньги, а список людей.
const DISCHARGE_QUEUE_ROLES = ['nurse', 'senior_nurse', 'doctor', 'head_doctor', 'admin'];

// Причина, с которой закрываются оставшиеся назначения при оформлении выписки.
// Ровно то слово, что уходит в treatment_orders.cancel_reason.
const CLOSE_ORDERS_REASON = 'Выписка';

/**
 * СКОЛЬКО ГОСПИТАЛИЗАЦИЯ ОСТАЛАСЬ ДОЛЖНА — и что в это число НЕ ВХОДИТ.
 *
 * Считается из двух половин, потому что деньги стационара живут в двух местах:
 *   • строки, ещё не попавшие в счёт (`admission_services` без invoice_item_id)
 *     — начислено, но не выставлено;
 *   • счета госпитализации (`invoices.admission_id`) — выставлено, и часть из
 *     этого уже оплачена.
 *
 * долг = (не выставлено) + (выставлено) − (оплачено)
 *
 * ЧТО ИСКЛЮЧЕНО, НАМЕРЕННО И ВСЛУХ (возвращается в `excludes`, экран это
 * показывает — «показать, чего число не покрывает» честнее, чем выдумать
 * ровное):
 *   1. строки «в учёте расходов» (billable = 0) — это внутренний расход
 *      клиники, пациенту он не выставляется никогда;
 *   2. аннулированные и возвращённые счета ('void', 'refunded') — по ним денег
 *      не ждут;
 *   3. счета ВИЗИТОВ того же пациента: у них invoices.admission_id пуст, и
 *      привязать их к койке нечем. Приём в поликлинике во время лежания — не
 *      долг стационара;
 *   4. то, что ЕЩЁ НЕ ВНЕСЕНО строкой: непробитое проживание
 *      (bill_accommodation — «не внесли, значит не выставили», решение
 *      ACCOMMODATION_AS_SERVICE_V1), несписанные препараты (stock_status
 *      'skipped'/'short', миграция 096). Программа не знает о них цены и не
 *      имеет права её придумать.
 *
 * Невыставленные строки оценены по СОХРАНЁННОМУ total. В счёте они могут
 * подорожать: create_invoice_for_admission берёт цену из каталога и из ставки
 * исполняющего врача (unitPriceFor). Число поэтому — «не меньше чем», и в
 * ЭТУ сторону ошибаться правильно: пугать долгом, которого нет, хуже, чем
 * назвать чуть меньший.
 *
 * @returns {{balance:number, unbilled:number, invoiced:number, paid:number}}
 */
export function admissionBalance(db, admissionId) {
  const lines = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS sum, COUNT(*) AS n
      FROM admission_services
     WHERE admission_id = ? AND billable = 1 AND invoice_item_id IS NULL`).get(admissionId);
  const internal = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS sum, COUNT(*) AS n
      FROM admission_services
     WHERE admission_id = ? AND billable = 0`).get(admissionId);
  const inv = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS total, COALESCE(SUM(paid_amount), 0) AS paid, COUNT(*) AS n
      FROM invoices
     WHERE admission_id = ? AND status NOT IN ('void', 'refunded')`).get(admissionId);
  const dropped = db.prepare(`
    SELECT COUNT(*) AS n FROM invoices
     WHERE admission_id = ? AND status IN ('void', 'refunded')`).get(admissionId);

  const unbilled = round2(lines.sum);
  const invoiced = round2(inv.total);
  const paid = round2(inv.paid);
  return {
    balance: round2(unbilled + invoiced - paid),
    unbilled,
    unbilled_lines: lines.n,
    invoiced,
    paid,
    invoice_count: inv.n,
    // Экран называет исключения словами; сервер отдаёт только счётчики, чтобы
    // строки перевода жили там же, где остальные строки экрана (i18n-strings).
    excludes: {
      internal_lines: internal.n,
      internal_amount: round2(internal.sum),
      void_invoices: dropped.n,
    },
  };
}

/** Сколько назначений ещё идёт: то, что чек-лист выписки называет «лист назначений». */
function activeOrderCount(db, admissionId) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM treatment_orders WHERE admission_id = ? AND status = 'active'")
    .get(admissionId);
  return row ? row.n : 0;
}

/**
 * ШАГ 1 — ЗАЯВКА НА ВЫПИСКУ. Лечащий врач говорит «готов».
 *
 * ПОРЯДОК ПРОВЕРОК — содержание, а не оформление:
 *   1. заявка уже подана? — «Заявка подана» важнее всего прочего, это двойное
 *      нажатие, а не ошибка;
 *   2. РОЛЬ — кассиру и медсестре правильный ответ «это делает лечащий врач», а
 *      не «эпикриз не опубликован»: второй отправляет писать документ туда, где
 *      дело вообще не в документе;
 *   3. СВОЙ ли пациент — матрица плана говорит «✔ (свой пациент)»: чужого
 *      выписывает главный врач, а не любой врач клиники;
 *   4. ЭПИКРИЗ — и только опубликованный. Черновик не документ (095): пустить
 *      выписку по недописанному эпикризу значит выдать человеку на руки
 *      половину записи и закрыть историю болезни на ней же.
 */
export function admissionDischargeRequest(db, args, user) {
  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('admission_id must be a positive integer.', 400);

  const outcome = (args && args.outcome) || '';
  if (!DISCHARGE_OUTCOMES.includes(outcome)) {
    throw new RpcError('Укажите исход: выписан домой, переведён, отказ от лечения или летальный исход.', 400);
  }
  const destination = textArg(args && args.destination, 300);
  if (outcome === 'transfer' && !destination) {
    throw new RpcError('Укажите, в какое учреждение переведён пациент.', 400);
  }
  const recommendations = textArg(args && args.recommendations, 4000);
  const plannedAt = textArg(args && args.planned_discharge_at, 40) || null;
  const at = textArg(args && args.at, 40) || null;

  const run = db.transaction(() => {
    const adm = loadAdmission(db, admissionId);

    // 1. Повтор.
    if (adm.status === 'discharging') {
      throw new RpcError('Заявка на выписку уже подана.', 400);
    }

    // 2. Роль (и заодно состояние: маршрут отвечает «нельзя пропустить шаг»,
    //    называя недостающий, — см. explainRefusal в inpatient-flow.js).
    assertMayTransition(adm.status, 'discharging', user);

    // 3. Свой пациент. Главный врач и администратор — по всему отделению; тот
    //    же круг, что у назначений (assertCanPrescribe).
    if (!hasAnyRole(user, ['admin', 'head_doctor'])
        && adm.attending_doctor_id !== (user && user.id)) {
      throw new RpcError('Заявку на выписку подаёт лечащий врач этого пациента или главный врач.', 403);
    }

    // 4. Выписной эпикриз — опубликованный и действующий (не заменённый
    //    исправлением, superseded_by IS NULL: заменённый эпикриз — это история,
    //    а не текущий документ).
    const epicrisis = db.prepare(`
      SELECT id, published_at FROM admission_reviews
       WHERE admission_id = ? AND kind = 'discharge'
         AND published_at IS NOT NULL AND superseded_by IS NULL
       ORDER BY id DESC LIMIT 1`).get(admissionId);
    if (!epicrisis) {
      const draft = db.prepare(`
        SELECT id FROM admission_reviews
         WHERE admission_id = ? AND kind = 'discharge' AND published_at IS NULL
         ORDER BY id DESC LIMIT 1`).get(admissionId);
      // Черновик и пустое место — РАЗНЫЕ беды человека у экрана: одному
      // осталось нажать «Опубликовать», другому — написать документ.
      throw new RpcError(draft
        ? 'Выписной эпикриз сохранён черновиком — опубликуйте его, затем подайте заявку.'
        : 'Выписной эпикриз не написан — заявку на выписку принять нельзя.', 400);
    }

    db.prepare(`
      UPDATE admissions
         SET discharge_outcome = ?, discharge_destination = ?, discharge_recommendations = ?,
             planned_discharge_at = COALESCE(?, planned_discharge_at)
       WHERE id = ?`).run(outcome, destination, recommendations, plannedAt, admissionId);

    // Состояние и подпись шага — дело машины маршрута; она же проверила бы
    // роль второй раз, и это не лишнее: у неё это единственный способ.
    const res = admissionTransition(db, { admission_id: admissionId, to: 'discharging', at }, user);
    const stamp = at || nowIso(db);
    db.prepare('UPDATE admissions SET discharge_requested_by = ?, discharge_requested_at = ? WHERE id = ?')
      .run((user && user.id) || null, stamp, admissionId);

    return {
      admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId),
      epicrisis_id: epicrisis.id,
      // Чтобы врач видел, что оставляет старшей медсестре.
      active_orders: activeOrderCount(db, admissionId),
      balance: admissionBalance(db, admissionId),
      from: res.from,
    };
  });

  return run();
}

/**
 * ШАГ 1' — ОТЗЫВ ЗАЯВКИ. 'discharging' → 'active'.
 *
 * Референс этого не умеет, и это его дыра, а не строгость: за часы между
 * «готов» и «оформлено» состояние пациента меняется. Без отзыва отделению
 * остаётся оформить выписку и завести новую госпитализацию — то есть соврать в
 * истории болезни и в деньгах.
 *
 * Отзывает тот, кто подавал (врач своего пациента / главный врач / админ), а не
 * старшая медсестра. Причина обязательна и уходит в журнал движений
 * (`admission_transfers`, kind 'discharge_cancel'): отзыв — единственный след
 * того, что человека собирались отпустить и передумали. Койка в строке —
 * только `to_*`: пациент никуда не переезжает, он остаётся там, где лежал.
 *
 * ЧТО СТИРАЕТСЯ, А ЧТО ОСТАЁТСЯ. Стирается ПОДПИСЬ заявки (исход, куда, кем,
 * когда): исход у лежащего пациента — ложь на карточке, и следующая заявка
 * обязана объявить его заново. Остаются РЕКОМЕНДАЦИИ: это набранный врачом
 * клинический текст, и стирать его за то, что выписку отложили на день, — терять
 * работу на ровном месте. Эпикриз (admission_reviews) не трогается вовсе: он
 * документ и живёт своей жизнью, с исправлениями через superseded_by.
 */
export function admissionDischargeCancelRequest(db, args, user) {
  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('admission_id must be a positive integer.', 400);
  const reason = textArg(args && args.reason, 300);
  if (!reason) throw new RpcError('Укажите причину отзыва заявки на выписку.', 400);

  const run = db.transaction(() => {
    const adm = loadAdmission(db, admissionId);
    if (adm.status !== 'discharging') {
      throw new RpcError(adm.status === 'discharged'
        ? 'Пациент уже выписан — отзывать нечего.'
        : 'Заявка на выписку не подана — отзывать нечего.', 400);
    }
    assertMayTransition('discharging', 'active', user);
    if (!hasAnyRole(user, ['admin', 'head_doctor'])
        && adm.attending_doctor_id !== (user && user.id)) {
      throw new RpcError('Отозвать заявку может лечащий врач этого пациента или главный врач.', 403);
    }

    const res = admissionTransition(db, { admission_id: admissionId, to: 'active' }, user);
    db.prepare(`
      UPDATE admissions
         SET discharge_outcome = NULL, discharge_destination = '',
             discharge_requested_by = NULL, discharge_requested_at = NULL
       WHERE id = ?`).run(admissionId);
    db.prepare(`
      INSERT INTO admission_transfers (admission_id, to_bed_id, to_ward_id,
                                       kind, reason, transferred_at, transferred_by)
      VALUES (?, ?, ?, 'discharge_cancel', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)
    `).run(admissionId, adm.bed_id, adm.ward_id, reason, (user && user.id) || null);

    return { admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId), from: res.from };
  });

  return run();
}

/**
 * ШАГ 2 — ОФОРМЛЕНИЕ ВЫПИСКИ. Старшая медсестра закрывает госпитализацию.
 *
 * ─── ДОЛГ ПРЕДУПРЕЖДАЕТ, А НЕ ЗАПРЕЩАЕТ ────────────────────────────────────
 *
 * Правило референса, названное в плане дважды. Долг НЕ отменяет выписку — он
 * требует, чтобы под ним поставили подпись: «Долг согласован (гарантия /
 * рассрочка)». Первый вызов без подписи возвращает отказ С СУММОЙ; тот же вызов
 * с debt_ack = true проходит, и выписка оформляется С ДОЛГОМ. Это НЕ «сначала
 * заплатите»: программа, которая держит человека до оплаты, не сохраняет деньги,
 * а заставляет отделение выписывать мимо системы — после чего база перестаёт
 * знать, кто где лежит.
 *
 * Сумма записывается в строку (`discharge_debt_amount`), потому что она
 * ИЗМЕНИТСЯ: касса примет деньги, счёт сторнируют, и пересчитанный через неделю
 * «долг при выписке» покажет не то, под чем расписывались.
 *
 * ─── КОЙКА НЕ СТАНОВИТСЯ СВОБОДНОЙ ─────────────────────────────────────────
 *
 * Она уходит в 'cleaning'. В 'free' её переводит ОТДЕЛЬНОЕ действие
 * (set_bed_status, медсестра / старшая медсестра). Правило референса, и то же
 * самое уже делают прямая выписка, отмена заявки и перевод.
 *
 * ─── ЛИСТ НАЗНАЧЕНИЙ ───────────────────────────────────────────────────────
 *
 * Незакрытые назначения выписку НЕ ЗАПРЕЩАЮТ (план: «выписка без закрытого
 * листа назначений — предупреждение, не запрет»), но с close_orders = true
 * закрываются здесь же, с причиной «Выписка».
 *
 * Закрываются ПРЯМОЙ ЗАПИСЬЮ в те же колонки, что пишет treatment_order_cancel,
 * а не вызовом самого RPC, и это осознанно: тот стоит за assertCanPrescribe,
 * то есть за правом НАЗНАЧАТЬ, которого у старшей медсестры нет и быть не
 * должно. Закрытие листа при выписке — административная часть выписки, а не
 * врачебная отмена лечения, и разрешает её право оформлять выписку. Строка
 * получает ровно те же поля (status, cancel_reason, cancel_by, cancel_at), так
 * что для всех, кто её читает, разницы нет.
 */
export function admissionDischargeFinalize(db, args, user) {
  const a = args || {};
  const admissionId = a.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('admission_id must be a positive integer.', 400);

  const at = textArg(a.at, 40) || null;
  const note = textArg(a.note, 1000);
  const closeOrders = a.close_orders === true || a.close_orders === 1;
  const debtAck = a.debt_ack === true || a.debt_ack === 1;
  const billSettled = a.bill_settled === true || a.bill_settled === 1;
  const docsGiven = a.docs_given === true || a.docs_given === 1;

  const run = db.transaction(() => {
    const adm = loadAdmission(db, admissionId);

    // 1. Состояние. Из 'active' сюда не попадают: сначала заявка врача — в этом
    //    и есть смысл двух шагов. Старый одношаговый путь остаётся у
    //    discharge_patient, для тех, кого положили до обновления.
    if (adm.status !== 'discharging') {
      throw new RpcError(
        adm.status === 'discharged' ? 'Пациент уже выписан — госпитализация закрыта.'
        : adm.status === 'cancelled' ? 'Заявка на госпитализацию отменена — выписывать некого.'
        : adm.status === 'ordered'   ? 'Пациент ещё не размещён на койке — заявку отменяют, а не выписывают.'
        : 'Заявка на выписку не подана — её подаёт лечащий врач.', 400);
    }

    // 2. Роль. Врача (кроме главного) здесь нет — он подал заявку и на этом его
    //    часть кончилась.
    assertMayTransition('discharging', 'discharged', user);

    // 3. Деньги: предупреждают, но требуют подписи.
    const balance = admissionBalance(db, admissionId);
    const owes = balance.balance > 0.005;
    if (owes && !debtAck) {
      throw new RpcError(
        'По госпитализации есть неоплаченный остаток — ' + balance.balance
        + '. Выписке это не мешает: подтвердите «Долг согласован (гарантия / рассрочка)».', 400);
    }

    // 4. Лист назначений.
    let closed = 0;
    if (closeOrders) {
      const stamp = nowIso(db);
      closed = db.prepare(`
        UPDATE treatment_orders
           SET status = 'cancelled', cancel_reason = ?, cancel_by = ?, cancel_at = ?
         WHERE admission_id = ? AND status = 'active'`)
        .run(CLOSE_ORDERS_REASON, (user && user.id) || null, stamp, admissionId).changes;
    }
    const remaining = activeOrderCount(db, admissionId);

    // 5. Состояние и фактическое время. Машина маршрута ставит discharged_at
    //    через COALESCE (она не должна знать, что время могут указать руками);
    //    настоящее время выписки проставляется следом, явно и поверх.
    const res = admissionTransition(db, { admission_id: admissionId, to: 'discharged', at }, user);
    const dischargedAt = at || res.admission.discharged_at || nowIso(db);

    // charge_amount — то, что ДЕЙСТВИТЕЛЬНО внесено за проживание строкой
    // (ACCOMMODATION_AS_SERVICE_V1, тот же запрос, что у прямой выписки): не
    // внесли — не выставили, и карточка не должна утверждать обратное.
    const billedRow = db.prepare(
      "SELECT total FROM admission_services WHERE admission_id = ? AND notes LIKE 'ACCOMMODATION%' LIMIT 1"
    ).get(admissionId);

    db.prepare(`
      UPDATE admissions
         SET discharged_at = ?, discharged_by = ?, charge_amount = ?, discharge_note = ?,
             discharge_orders_closed = ?, discharge_bill_settled = ?, discharge_docs_given = ?,
             discharge_debt_amount = ?, discharge_debt_ack = ?,
             discharge_debt_ack_by = ?, discharge_debt_ack_at = ?
       WHERE id = ?`).run(
      dischargedAt, (user && user.id) || null,
      billedRow ? round2(billedRow.total) : 0, note,
      remaining === 0 ? 1 : 0, billSettled ? 1 : 0, docsGiven ? 1 : 0,
      balance.balance, owes && debtAck ? 1 : 0,
      owes && debtAck ? ((user && user.id) || null) : null,
      owes && debtAck ? dischargedAt : null,
      admissionId);

    // 6. Койка: 'cleaning', НЕ 'free'.
    if (adm.bed_id) {
      db.prepare("UPDATE beds SET status = 'cleaning' WHERE id = ?").run(adm.bed_id);
    }
    db.prepare(`
      INSERT INTO admission_transfers (admission_id, from_bed_id, from_ward_id, kind, reason, transferred_at, transferred_by)
      VALUES (?, ?, ?, 'discharge', ?, ?, ?)
    `).run(admissionId, adm.bed_id, adm.ward_id, note || null, dischargedAt, (user && user.id) || null);

    return {
      admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId),
      bed: adm.bed_id ? db.prepare('SELECT * FROM beds WHERE id = ?').get(adm.bed_id) : null,
      orders_closed: closed,
      orders_left: remaining,
      balance,
      debt_acknowledged: owes && debtAck,
    };
  });

  return run();
}

/**
 * ОЧЕРЕДЬ СТАРШЕЙ МЕДСЕСТРЫ — кого сегодня оформлять.
 *
 * Все госпитализации в 'discharging', в порядке подачи заявки: пациент, палата,
 * койка, лечащий врач, исход, кто и когда подал — и ДОЛГ. Долг считает сервер
 * (admissionBalance), а не браузер, по той же причине, по какой доска коек не
 * считает занятость сама: вторая копия правила разошлась бы с первой молча, и
 * разошлась бы в сторону «долга нет».
 *
 * Ничего не меняет — стоит в READ_ONLY_RPCS (control/gate.js): клиника с
 * просроченной лицензией обязана видеть, кого она сегодня отпускает.
 */
export function admissionDischargeQueue(db, args, user) {
  requireRole(user, DISCHARGE_QUEUE_ROLES);
  const a = args || {};
  const rawWard = a.ward_id;
  const wardId = rawWard === undefined || rawWard === null || rawWard === '' ? null : Number(rawWard);
  if (wardId !== null && !isPositiveInt(wardId)) throw new RpcError('ward_id must be a positive integer.', 400);

  const params = [];
  let where = "a.status = 'discharging'";
  if (wardId !== null) { where += ' AND a.ward_id = ?'; params.push(wardId); }

  const rows = db.prepare(`
    SELECT a.id AS admission_id, a.admission_no, a.status,
           a.discharge_outcome, a.discharge_destination, a.discharge_recommendations,
           a.discharge_requested_at, a.discharge_requested_by,
           a.planned_discharge_at, a.admitted_at, a.department,
           p.id AS patient_id, p.full_name AS patient_name,
           w.id AS ward_id, w.name AS ward_name,
           b.id AS bed_id, b.code AS bed_code,
           doc.full_name AS attending_name,
           req.full_name AS requested_by_name
      FROM admissions a
      JOIN patients p ON p.id = a.patient_id
      LEFT JOIN wards w ON w.id = a.ward_id
      LEFT JOIN beds  b ON b.id = a.bed_id
      LEFT JOIN users doc ON doc.id = a.attending_doctor_id
      LEFT JOIN users req ON req.id = a.discharge_requested_by
     WHERE ${where}
     ORDER BY a.discharge_requested_at, a.id
  `).all(...params);

  return {
    ward_id: wardId,
    outcomes: DISCHARGE_OUTCOMES,
    rows: rows.map((r) => ({
      ...r,
      balance: admissionBalance(db, r.admission_id),
      active_orders: activeOrderCount(db, r.admission_id),
    })),
  };
}
