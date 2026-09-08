// ═══════════════════════════════════════════════════════════════════════════
// CASE_OVERVIEW_V1 (2026-09-08) — ОБЗОР ГОСПИТАЛИЗАЦИИ ДЛЯ ВРАЧА
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «list of the patients → pressed opens a patients dashboard and
// main action → opens the documents to fill for the doctor. but in the
// dashboard we can see status of the patient, services prescription, and
// discharge button with generating the payments».
//
// Один вызов собирает всё, что врачу нужно видеть, ничего не храня заново:
// статус и дни, диагноз (при направлении → клинический из первичного осмотра
// → исход), лист медсестры, стол и еда за сегодня, назначения и дозы за
// сегодня, услуги и что из них в счёте, операцию (выведена из документов и
// услуг — модуля оперблока нет), счёт (проживание + счета), прогресс истории
// болезни, выписку и СОСЕДЕЙ по отделению для стрелок «‹ ›» в шапке.
//
// Соседи — список «В отделении» в том же порядке, что на вкладке «Пациенты»
// (палата → койка). Рядовой врач с назначенными пациентами ходит по СВОИМ;
// главный врач, администратор и пост — по всем: у них и обход по всем.
import { RpcError, loadAdmission } from './inpatient-flow.js';
import { hasAnyRole, effectiveRoles } from '../roles.js';
import { sheetView } from './title-sheet.js';
import { admissionCaseDocs } from './inpatient-reviews.js';
import { accommodationState } from './accommodation.js';
import { isSurgery } from './queue.js';
import { IN_BED_STATUSES } from '../../../public/js/shared/admission-status.js';
import { vitalsSummary } from './vitals.js';   // VITALS_NEWS_V1

export const OVERVIEW_ROLES = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];
const IN_BED_SQL = IN_BED_STATUSES.map((s) => `'${s}'`).join(',');
const MS_DAY = 86400 * 1000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Сколько раз в сутки, когда у назначения не задана сетка часов.
const FREQ_PER_DAY = { '1x': 1, '2x': 2, '3x': 3, '4x': 4, q6h: 4, once: 1, prn: 0 };

function nowUtc(db) {
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
}
function requireRead(user) {
  if (!hasAnyRole(user, OVERVIEW_ROLES)) throw new RpcError('Обзор госпитализации — недоступно вашей роли.', 403);
}
function slotsPerDay(o) {
  try {
    const arr = JSON.parse(o.slots || '[]');
    if (Array.isArray(arr) && arr.length) return arr.length;
  } catch (e) { /* сетка не задана — считаем по частоте */ }
  return FREQ_PER_DAY[o.freq_code] === undefined ? 1 : FREQ_PER_DAY[o.freq_code];
}

/** Соседи по отделению: prev/next для стрелок в шапке и «N из M». */
export function wardNeighbours(db, adm, user) {
  const roles = effectiveRoles(user);
  const plainDoctor = roles.includes('doctor') && !roles.includes('head_doctor') && !roles.includes('admin');
  let list = db.prepare(`
    SELECT a.id, a.attending_doctor_id, a.admitting_doctor_id, p.full_name, w.name AS ward_name, b.code AS bed_code
      FROM admissions a
      LEFT JOIN patients p ON p.id = a.patient_id
      LEFT JOIN wards w ON w.id = a.ward_id
      LEFT JOIN beds b ON b.id = a.bed_id
     WHERE a.status IN (${IN_BED_SQL})
     ORDER BY w.name, b.code, a.id`).all();
  let mine = false;
  if (plainDoctor) {
    // ADMITTING_DOCTOR_V1 — «мои» у рядового врача: кого лечит И кого ждут с
    // осмотром при поступлении (приёмный врач).
    const own = list.filter((r) => r.attending_doctor_id === user.id || r.admitting_doctor_id === user.id);
    if (own.length) { list = own; mine = true; }
  }
  const index = list.findIndex((r) => r.id === adm.id);
  const pick = (r) => (r ? { id: r.id, full_name: r.full_name || '', ward_name: r.ward_name || '', bed_code: r.bed_code || '' } : null);
  return {
    index, total: list.length, mine,
    prev: index > 0 ? pick(list[index - 1]) : null,
    next: index >= 0 && index < list.length - 1 ? pick(list[index + 1]) : null,
  };
}

export function admissionOverview(db, args, user) {
  requireRead(user);
  const adm = loadAdmission(db, args && args.admission_id);
  const now = nowUtc(db);
  const today = now.slice(0, 10);
  const view = sheetView(db, adm);
  const docs = admissionCaseDocs(db, { admission_id: adm.id, now }, user);

  // ── статус и дни ────────────────────────────────────────────────────────
  const placed = !['ordered', 'cancelled'].includes(adm.status);
  const admittedMs = placed && adm.admitted_at ? Date.parse(adm.admitted_at) : NaN;
  const endMs = adm.discharged_at ? Date.parse(adm.discharged_at) : Date.parse(now);
  const days = Number.isFinite(admittedMs) && Number.isFinite(endMs)
    ? Math.max(1, Math.floor((endMs - admittedMs) / MS_DAY) + 1) : null;

  // ── диагноз: при направлении → клинический (первичный осмотр) → исход ──
  const primary = db.prepare(`
    SELECT diagnosis, published_at FROM admission_reviews
     WHERE admission_id = ? AND kind = 'primary' AND published_at IS NOT NULL AND superseded_by IS NULL
     ORDER BY id DESC LIMIT 1`).get(adm.id) || null;
  const diagnosis = {
    referral: adm.admission_diagnosis || '',
    clinical: primary ? (primary.diagnosis || '') : '',
    clinical_at: primary ? primary.published_at : null,
    outcome: adm.discharge_outcome || null,
  };

  // ── питание ─────────────────────────────────────────────────────────────
  const dietRow = db.prepare(`
    SELECT d.diet_code, d.since, t.name
      FROM admission_diets d LEFT JOIN diet_tables t ON t.code = d.diet_code
     WHERE d.admission_id = ? AND d.ended_at IS NULL
     ORDER BY d.id DESC LIMIT 1`).get(adm.id) || null;
  const mealsToday = {};
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM admission_meals WHERE admission_id = ? AND meal_date = ? GROUP BY status').all(adm.id, today)) {
    mealsToday[r.status] = r.n;
  }

  // ── назначения и дозы за сегодня ────────────────────────────────────────
  const activeOrders = db.prepare(`
    SELECT * FROM treatment_orders
     WHERE admission_id = ? AND status = 'active' AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?)
     ORDER BY prn, starts_on, id`).all(adm.id, today, today);
  const byKind = {};
  for (const o of activeOrders) byKind[o.kind] = (byKind[o.kind] || 0) + 1;
  const due = activeOrders.filter((o) => !o.prn).reduce((s, o) => s + slotsPerDay(o), 0);
  const marks = { given: 0, refused: 0, missed: 0, held: 0 };
  for (const r of db.prepare(`
    SELECT a.status, COUNT(*) n FROM treatment_administrations a
      JOIN treatment_orders o ON o.id = a.order_id
     WHERE o.admission_id = ? AND a.due_date = ? AND a.voided_at IS NULL
     GROUP BY a.status`).all(adm.id, today)) {
    marks[r.status] = r.n;
  }
  const orders = {
    active: activeOrders.length,
    by_kind: byKind,
    today: Object.assign({ due }, marks),
    list: activeOrders.slice(0, 5).map((o) => ({ id: o.id, kind: o.kind, name: o.name, dose: o.dose, route: o.route, freq_code: o.freq_code, prn: !!o.prn })),
  };

  // ── услуги ──────────────────────────────────────────────────────────────
  const svcRows = db.prepare(`
    SELECT s.id, s.quantity, s.total, s.status, s.billable, s.performed_at, s.invoice_item_id, s.notes, s.service_id,
           sv.name AS service_name, sv.type AS service_type, p.name AS product_name
      FROM admission_services s
      LEFT JOIN services sv ON sv.id = s.service_id
      LEFT JOIN products p ON p.id = s.clinic_item_id
     WHERE s.admission_id = ?
     ORDER BY s.id DESC`).all(adm.id);
  const unbilledRows = svcRows.filter((r) => r.invoice_item_id === null && r.billable);
  const services = {
    count: svcRows.length,
    billed: svcRows.filter((r) => r.invoice_item_id !== null).length,
    unbilled: unbilledRows.length,
    sum_total: round2(svcRows.reduce((s, r) => s + (Number(r.total) || 0), 0)),
    sum_unbilled: round2(unbilledRows.reduce((s, r) => s + (Number(r.total) || 0), 0)),
    list: svcRows.slice(0, 6).map((r) => ({
      id: r.id, name: r.service_name || r.product_name || (r.notes || ''), quantity: r.quantity, total: r.total,
      invoiced: r.invoice_item_id !== null, performed_at: r.performed_at, status: r.status,
    })),
  };

  // ── операция: по документам и услугам, модуля оперблока нет ─────────────
  const surgicalDocs = db.prepare(`
    SELECT kind, published_at FROM admission_reviews
     WHERE admission_id = ? AND kind IN ('anesthesia','preop','operation') AND published_at IS NOT NULL AND superseded_by IS NULL
     ORDER BY published_at DESC`).all(adm.id);
  const protocol = surgicalDocs.find((r) => r.kind === 'operation') || null;
  const surgeryService = svcRows.some((r) => r.service_id && isSurgery({ svc_type: r.service_type, svc_type_name: '' }));
  const operation = {
    state: protocol ? 'done' : (surgicalDocs.length || surgeryService ? 'planned' : 'none'),
    at: protocol ? protocol.published_at : null,
    has_surgery_service: surgeryService,
    docs: surgicalDocs.map((r) => r.kind),
  };

  // ── счёт: проживание + счета госпитализации ─────────────────────────────
  let accommodation = null;
  try { accommodation = accommodationState(db, { admission_id: adm.id }, user); } catch (e) { accommodation = null; }
  const invoices = db.prepare('SELECT id, invoice_number, total_amount, paid_amount, status, created_at FROM invoices WHERE admission_id = ? ORDER BY id').all(adm.id);
  // DEBT_FLOW_V1 — отменённые и возвращённые счета в сумму не входят: по ним
  // денег не ждут, и «Долг» на обзоре после отмены счёта кассиром был бы
  // долгом, которого нет (владелец увидел ровно это).
  const live = invoices.filter((i) => i.status !== 'void' && i.status !== 'refunded');
  const total = round2(live.reduce((s, i) => s + (Number(i.total_amount) || 0), 0));
  const paid = round2(live.reduce((s, i) => s + (Number(i.paid_amount) || 0), 0));
  // «Долг» на обзоре — это ОФОРМЛЕННЫЙ долг (статус 'debt'), а не любой
  // неоплаченный остаток: пока пациент лежит, счёт просто «к оплате».
  const debtMarked = round2(live.filter((i) => i.status === 'debt')
    .reduce((s, i) => s + Math.max(0, (Number(i.total_amount) || 0) - (Number(i.paid_amount) || 0)), 0));
  const bill = {
    accommodation: accommodation ? {
      stay_units: accommodation.stay_units, invoiced: accommodation.invoiced, current: accommodation.current,
    } : null,
    invoices, total, paid, debt: round2(Math.max(0, total - paid)), debt_marked: debtMarked,
  };

  // ── выписка ─────────────────────────────────────────────────────────────
  const discharge = {
    status: adm.status,
    requested_at: adm.discharge_requested_at || null,
    planned_at: adm.planned_discharge_at || null,
    outcome: adm.discharge_outcome || null,
    discharged_at: adm.discharged_at || null,
  };

  return {
    now,
    admission: Object.assign({}, view.admission, { attending_doctor_id: adm.attending_doctor_id || null, days }),
    patient: view.patient,
    title_sheet: { complete: view.complete, bmi: view.bmi, sheet: view.sheet },
    diagnosis,
    diet: { current: dietRow, meals_today: mealsToday },
    orders,
    services,
    operation,
    bill,
    docs: { progress: docs.progress, next_kind: docs.next_kind, overdue: docs.progress.overdue, incomplete: docs.discharge_gate.incomplete },
    discharge,
    neighbours: wardNeighbours(db, adm, user),
    vitals: vitalsSummary(db, adm),   // VITALS_NEWS_V1 — показатели, NEWS и динамика
  };
}
