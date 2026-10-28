// REFERRALS_CRM_V1 (2026-10-26) — данные экрана «Реферирование» под CRM
// (docs/specs/2026-10-26-referrals-crm-design.md).
//
// Владелец: «under the CRM build Реферирование block … Referal external doctors
// are in setting now and it should be bring here without process change in
// registration and other places». Поэтому здесь НЕТ своей модели данных:
// внешние и внутренние врачи — те же строки referral_sources, направления
// внутреннего врача — те же recommended_services, деньги — те же строки отчёта
// «Рефералы» (referralReportLines из reports.js: оплаченные позиции после
// скидки и возвратов, закрытые месяцы из записи). Экран только показывает их
// иначе: по представителям, по врачам, по активности.
//
// Права. Экран — свой пункт меню «Реферирование» со своим ключом `referrals`
// (REFERRALS_NAV_V1: владелец вынес его из CRM в «Операции»); этот ключ — ворота
// каждого чтения здесь, CRM его не открывает. Деньги («Получено», «Сумма», «Вознаграждение») — только
// с reports.referrals ≥ просмотр: иначе сервер их не считает и не отдаёт
// (money: false), а не полагается на то, что экран их спрячет. Закрепление
// врача за представителем — право «Список источников: Изменение», то же, что
// правит источник в справочнике.
import { isAdminUser } from '../grants.js';
import { tableWriteAllowed } from '../../db/write-grant.js';   // закрепление врача — по праву записи в referral_sources, ровно как /api/db
import { canViewSection } from '../roles.js';
import { canSeeReportKey } from '../report-access.js';   // деньги — по группе отчётов reports.referrals (REPORT_GROUP), как у дашборда
import { referralReportLines, resolveRange } from './reports.js';
import { today, localDate, localRangeWhere } from '../domain/day.js';
import { activityCounters, normalizeWindow } from '../../../public/js/shared/referral-activity.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const REPRESENTATIVE_ROLE = 'medrep';   // custom_roles.code, заведён миграцией 252

function requireCrm(db, user) {   // имя историческое: раздел был подэкраном CRM полдня
  if (isAdminUser(user) || canViewSection(db, user, 'referrals')) return;
  throw new RpcError('Раздел «Реферирование» недоступен вашей роли. Права выдаёт администратор в «Настройки → Роли».', 403);
}
export function canSeeReferralMoney(db, user) {
  // Та же проверка, что открывает отчёт «Рефералы»: группа отчётов, пока ключ не настроен —
  // «Отчёты» или администратор (report-access.js). Не grantAllowsAdminOr: у строки нет adminDefault.
  return canSeeReportKey(db, user, 'reports.referrals');
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v) => Math.round(num(v) * 100) / 100;
// Источник визита — как в отчётах: источник визита, иначе источник карточки пациента.
const SOURCE_OF_VISIT = 'COALESCE(v.referral_source_id, pt.referral_source_id)';
// Направлением считается визит, который не отменили и на который пришли или
// ещё придут; «не пришёл» — не направление.
const VISIT_LIVE = "v.status NOT IN ('cancelled', 'no_show')";

function listRepresentatives(db) {
  return db.prepare(`SELECT id, full_name FROM users
                      WHERE custom_role_code = ? AND is_active = 1 ORDER BY full_name`).all(REPRESENTATIVE_ROLE);
}

function externalSources(db, { activeOnly = true } = {}) {
  return db.prepare(`SELECT rs.id, rs.code, rs.name, rs.phone, rs.workplace, rs.district, rs.specialty,
                            rs.category_id, rc.name AS category, rs.representative_id, rs.active
                       FROM referral_sources rs
                       LEFT JOIN referral_source_categories rc ON rc.id = rs.category_id
                      WHERE rs.doctor_id IS NULL${activeOnly ? ' AND rs.active = 1' : ''}
                      ORDER BY rs.name`).all();
}

/** Визиты за период по источникам: сколько визитов и разных пациентов. */
function visitAggregates(db, from, to) {
  const w = localRangeWhere('v.visit_date', from, to);
  const rows = db.prepare(`
    SELECT ${SOURCE_OF_VISIT} AS source_id, COUNT(*) AS visits, COUNT(DISTINCT v.patient_id) AS patients
      FROM visits v JOIN patients pt ON pt.id = v.patient_id
     WHERE ${VISIT_LIVE} AND ${SOURCE_OF_VISIT} IS NOT NULL AND ${w.sql}
     GROUP BY source_id`).all(...w.params);
  return new Map(rows.map((r) => [r.source_id, r]));
}

/**
 * Деньги за период из строк отчёта «Рефералы», сгруппированные по ключу:
 * внешние — по источнику, внутренние — по врачу-получателю. «Получено» —
 * оплаченная стоимость после скидки с учётом возвратов (та же доля, что
 * кормит вознаграждение), «Вознаграждение» — reward строки.
 */
function moneyBy(db, { from, to }, user, scope) {
  const out = new Map();
  for (const r of referralReportLines(db, { from, to, referrer: scope }, user)) {
    const key = scope === 'internal' ? r.beneficiary_doctor_id : r.referral_source_id;
    if (key == null) continue;
    const acc = out.get(key) || { received: 0, reward: 0, visits: new Map() };
    const received = r.paid ? num(r.after_discount) * num(r.pay_factor) : 0;
    acc.received += received;
    acc.reward += num(r.reward);
    if (r.visit_id != null) {
      const v = acc.visits.get(r.visit_id) || { received: 0, reward: 0 };
      v.received += received; v.reward += num(r.reward);
      acc.visits.set(r.visit_id, v);
    }
    out.set(key, acc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Представители
// ---------------------------------------------------------------------------
export function referralsRepresentatives(db, args, user) {
  requireCrm(db, user);
  const { from, to } = resolveRange(db, args);
  const money = canSeeReferralMoney(db, user);
  const representatives = listRepresentatives(db);
  const repIds = new Set(representatives.map((r) => r.id));
  const agg = visitAggregates(db, from, to);
  const cash = money ? moneyBy(db, { from, to }, user, 'external') : null;

  const sources = externalSources(db).map((s) => {
    const a = agg.get(s.id);
    const m = cash ? cash.get(s.id) : null;
    const row = {
      id: s.id, code: s.code || '', name: s.name, phone: s.phone || '', workplace: s.workplace || '',
      district: s.district || '', specialty: s.specialty || '', category: s.category || '',
      // Представитель, которого уволили или лишили роли, для экрана — «без
      // представителя»: закрепление в базе остаётся до нового выбора.
      representative_id: s.representative_id != null && repIds.has(s.representative_id) ? s.representative_id : null,
      visits: a ? num(a.visits) : 0,
      patients: a ? num(a.patients) : 0,
    };
    if (money) { row.received = round2(m ? m.received : 0); row.reward = round2(m ? m.reward : 0); }
    return row;
  });

  const w = localRangeWhere('v.visit_date', from, to);
  const patients = db.prepare(`
    SELECT COUNT(DISTINCT v.patient_id) AS n
      FROM visits v JOIN patients pt ON pt.id = v.patient_id
      JOIN referral_sources rs ON rs.id = ${SOURCE_OF_VISIT}
     WHERE rs.doctor_id IS NULL AND ${VISIT_LIVE} AND ${w.sql}`).get(...w.params).n;
  const assigned = sources.filter((s) => s.representative_id != null).length;
  const totals = {
    representatives: representatives.length,
    assigned,
    unassigned: sources.length - assigned,
    patients: num(patients),
  };
  if (money) totals.received = round2(sources.reduce((acc, s) => acc + num(s.received), 0));
  return { from, to, money, representatives, sources, totals };
}

export function referralsAssignRepresentative(db, args, user) {
  // Та же дверь, что у UPDATE referral_sources через /api/db (db/write-grant.js
  // tableWriteAllowed): роль из реестра (администратор) или право плитки «Список
  // источников: Изменение». НЕ своя строка в gate-fallbacks.js: ключ плитки настроек
  // описан там правилом «пишет по праву», а новая строка карты разошлась бы с таблицей
  // стандартов миграции 230 (230.test.js сверяет их ключ в ключ) — так и вышло в полном
  // прогоне 2026-10-27, поэтому строка снята.
  if (!tableWriteAllowed('referral_sources', 'update', user, db)) {
    throw new RpcError('Закреплять врача за представителем может роль с правом «Список источников: Изменение».', 403);
  }
  const sourceId = Number(args && args.source_id);
  if (!Number.isInteger(sourceId) || sourceId <= 0) throw new RpcError('Врач не выбран.', 400);
  const src = db.prepare('SELECT id, doctor_id FROM referral_sources WHERE id = ?').get(sourceId);
  if (!src) throw new RpcError('Врач-источник не найден.', 404);
  if (src.doctor_id != null) throw new RpcError('Врача клиники за представителем не закрепляют: представители ведут внешних врачей.', 400);

  let repId = null;
  const raw = args && args.user_id;
  if (raw !== undefined && raw !== null && raw !== '') {
    repId = Number(raw);
    const rep = Number.isInteger(repId) && repId > 0
      ? db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1 AND custom_role_code = ?').get(repId, REPRESENTATIVE_ROLE)
      : null;
    if (!rep) throw new RpcError('Этот сотрудник не медпредставитель: роль «Медпредставитель» выдаётся в «Настройки → Сотрудники».', 400);
  }
  db.prepare("UPDATE referral_sources SET representative_id = ? WHERE id = ?").run(repId, sourceId);
  return { source_id: sourceId, representative_id: repId };
}

// ---------------------------------------------------------------------------
// Внутренние врачи
// ---------------------------------------------------------------------------
export function referralsInternal(db, args, user) {
  requireCrm(db, user);
  const { from, to } = resolveRange(db, args);
  const money = canSeeReferralMoney(db, user);
  const doctors = db.prepare(`SELECT id, full_name, specialty FROM users
                               WHERE role = 'doctor' AND is_active = 1 ORDER BY full_name`).all();
  const w = localRangeWhere('r.created_at', from, to);
  const counts = new Map(db.prepare(`
    SELECT r.recommended_by AS doctor_id,
           COUNT(*) AS referrals,
           SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS waiting,
           SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
           COUNT(DISTINCT r.patient_id) AS patients
      FROM recommended_services r
     WHERE r.recommended_by IS NOT NULL AND ${w.sql}
     GROUP BY r.recommended_by`).all(...w.params).map((r) => [r.doctor_id, r]));
  const cash = money ? moneyBy(db, { from, to }, user, 'internal') : null;

  const rows = doctors.map((d) => {
    const c = counts.get(d.id);
    const m = cash ? cash.get(d.id) : null;
    const row = {
      id: d.id, full_name: d.full_name, specialty: d.specialty || '',
      referrals: c ? num(c.referrals) : 0, done: c ? num(c.done) : 0, waiting: c ? num(c.waiting) : 0,
      cancelled: c ? num(c.cancelled) : 0, patients: c ? num(c.patients) : 0,
    };
    if (money) { row.amount = round2(m ? m.received : 0); row.reward = round2(m ? m.reward : 0); }
    return row;
  });
  const sum = (k) => rows.reduce((acc, r) => acc + num(r[k]), 0);
  const totals = {
    doctors_referring: rows.filter((r) => r.referrals > 0).length,
    referrals: sum('referrals'), done: sum('done'), waiting: sum('waiting'), cancelled: sum('cancelled'),
  };
  if (money) { totals.amount = round2(sum('amount')); totals.reward = round2(sum('reward')); }
  return { from, to, money, doctors: rows, totals };
}

// ---------------------------------------------------------------------------
// Активность внешних врачей
// ---------------------------------------------------------------------------
function botLinkedSourceIds(db) {
  // Таблица появляется миграцией 253 (бот врачей): до неё — никто не подключён.
  // FIX_318_V1 (M2) — подключён — только ПОДТВЕРЖДЁННЫЙ администратором (мигр. 257).
  try {
    return new Set(db.prepare("SELECT referral_source_id FROM doctor_bot_links WHERE revoked_at IS NULL AND status = 'confirmed'").all()
      .map((r) => r.referral_source_id));
  } catch { return new Set(); }
}

export function referralsActivity(db, args, user) {
  requireCrm(db, user);
  const days = normalizeWindow(args && args.days);
  const t = today(db);
  const repFilter = args && args.representative_id;
  const representatives = listRepresentatives(db);
  const repIds = new Set(representatives.map((r) => r.id));
  const linked = botLinkedSourceIds(db);

  const byDay = new Map();
  for (const r of db.prepare(`
      SELECT ${SOURCE_OF_VISIT} AS source_id, ${localDate('v.visit_date')} AS day
        FROM visits v JOIN patients pt ON pt.id = v.patient_id
       WHERE ${VISIT_LIVE} AND ${SOURCE_OF_VISIT} IS NOT NULL`).all()) {
    if (!byDay.has(r.source_id)) byDay.set(r.source_id, []);
    byDay.get(r.source_id).push(r.day);
  }

  let sources = externalSources(db).map((s) => {
    const c = activityCounters(byDay.get(s.id) || [], t, days);
    return {
      id: s.id, code: s.code || '', name: s.name, specialty: s.specialty || '', workplace: s.workplace || '',
      representative_id: s.representative_id != null && repIds.has(s.representative_id) ? s.representative_id : null,
      last_visit: c.last, current: c.cur, previous: c.prev, total: c.total, status: c.status,
      telegram: linked.has(s.id),
    };
  });
  if (repFilter === 'none') sources = sources.filter((s) => s.representative_id == null);
  else if (repFilter !== undefined && repFilter !== null && repFilter !== '' && repFilter !== 'all') {
    const id = Number(repFilter);
    sources = sources.filter((s) => s.representative_id === id);
  }
  const totals = { active: 0, fading: 0, passive: 0, never: 0 };
  for (const s of sources) totals[s.status] += 1;
  return { days, today: t, representatives, sources, totals };
}

// ---------------------------------------------------------------------------
// «Подробнее» / «Печать»
// ---------------------------------------------------------------------------
export function referralsSourceDetail(db, args, user) {
  requireCrm(db, user);
  const sourceId = Number(args && args.source_id);
  if (!Number.isInteger(sourceId) || sourceId <= 0) throw new RpcError('Врач не выбран.', 400);
  const source = db.prepare(`SELECT rs.id, rs.code, rs.name, rs.phone, rs.workplace, rs.specialty, rc.name AS category
                               FROM referral_sources rs LEFT JOIN referral_source_categories rc ON rc.id = rs.category_id
                              WHERE rs.id = ?`).get(sourceId);
  if (!source) throw new RpcError('Врач-источник не найден.', 404);
  const { from, to } = resolveRange(db, args);
  const money = canSeeReferralMoney(db, user);
  const w = localRangeWhere('v.visit_date', from, to);
  const visits = db.prepare(`
    SELECT v.id, ${localDate('v.visit_date')} AS day, v.status, pt.id AS patient_id, pt.full_name AS patient,
           (SELECT GROUP_CONCAT(COALESCE(s.name, ''), ', ')
              FROM visit_services vs LEFT JOIN services s ON s.id = vs.service_id
             WHERE vs.visit_id = v.id AND vs.status NOT IN ('cancelled', 'removed')) AS services
      FROM visits v JOIN patients pt ON pt.id = v.patient_id
     WHERE ${VISIT_LIVE} AND ${SOURCE_OF_VISIT} = ? AND ${w.sql}
     ORDER BY v.visit_date DESC`).all(sourceId, ...w.params);
  const cash = money ? (moneyBy(db, { from, to }, user, 'external').get(sourceId) || null) : null;
  const rows = visits.map((v) => {
    const row = { visit_id: v.id, date: v.day, status: v.status, patient_id: v.patient_id, patient: v.patient, services: v.services || '' };
    if (money) {
      const m = cash && cash.visits.get(v.id);
      row.received = round2(m ? m.received : 0); row.reward = round2(m ? m.reward : 0);
    }
    return row;
  });
  const out = { source, from, to, money, visits: rows, patients: new Set(visits.map((v) => v.patient_id)).size };
  if (money) { out.received = round2(cash ? cash.received : 0); out.reward = round2(cash ? cash.reward : 0); }
  return out;
}

export function referralsDoctorDetail(db, args, user) {
  requireCrm(db, user);
  const doctorId = Number(args && args.doctor_id);
  if (!Number.isInteger(doctorId) || doctorId <= 0) throw new RpcError('Врач не выбран.', 400);
  const doctor = db.prepare('SELECT id, full_name, specialty FROM users WHERE id = ?').get(doctorId);
  if (!doctor) throw new RpcError('Врач не найден.', 404);
  const { from, to } = resolveRange(db, args);
  const money = canSeeReferralMoney(db, user);
  const w = localRangeWhere('r.created_at', from, to);
  const referrals = db.prepare(`
    SELECT ${localDate('r.created_at')} AS date, r.status, r.patient_id, pt.full_name AS patient,
           COALESCE(s.name, r.service_name, '') AS service
      FROM recommended_services r
      LEFT JOIN patients pt ON pt.id = r.patient_id
      LEFT JOIN services s ON s.id = r.service_id
     WHERE r.recommended_by = ? AND ${w.sql}
     ORDER BY r.created_at DESC`).all(doctorId, ...w.params);
  const out = { doctor, from, to, money, referrals };
  if (money) {
    const lines = referralReportLines(db, { from, to, referrer: 'internal' }, user)
      .filter((r) => r.beneficiary_doctor_id === doctorId)
      .map((r) => ({ date: r.date, patient: r.patient || '', service: r.service || '',
        amount: round2(r.after_discount), received: round2(r.paid ? num(r.after_discount) * num(r.pay_factor) : 0), reward: round2(r.reward) }));
    out.lines = lines;
    out.amount = round2(lines.reduce((a, r) => a + r.received, 0));
    out.reward = round2(lines.reduce((a, r) => a + r.reward, 0));
  }
  return out;
}
