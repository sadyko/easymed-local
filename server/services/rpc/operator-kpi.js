// OPERATOR_KPI_V1 (2026-11-14) — «Мой KPI»: дашборд оператора колл-центра.
//
// Владелец, со снимком доски CRM: «I want that each call operator has his own
// dashboard and he can see his KPI … the KPI setting we already have when we
// create employee, do not touch it there, just bring fix and % of interest if
// it is set there».
//
// ЧЬИ ЦИФРЫ. Оператор видит ТОЛЬКО себя. Тот, кто видит всю доску CRM
// (canSeeAllLeads — администратор, руководитель колл-центра), может выбрать
// любого оператора: это та же граница, что у «Операторов» отчёта колл-центра
// (rpc/callcenter.js CRM_HEAD_MERGE_TAGS_V1). KPI_SCOPE_V1 — именно оператора:
// чужой user_id вне списка выбора (operatorList) сервер не открывает никому.
//
// ОПРЕДЕЛЕНИЯ — те же, что у отчёта колл-центра, не свои:
//   * заявка оператора — та, которую он ВЕДЁТ (crm_requests.assigned_to), а не
//     та, что он завёл;
//   * «Пришёл», «Записан», «Не пришёл», потери — ступени из настроек воронки
//     (crm/config.js), а не зашитые ключи;
//   * звонок оператора — по его внутреннему номеру (users.pbx_extension =
//     calls.internal_number), «отвечен» — billsec > 0 (rpc/telephony.js).
//
// ОПЛАТА — ИЗ КАРТОЧКИ СОТРУДНИКА, КАРТОЧКА НЕ ТРОГАЕТСЯ. Вид оплаты
// (users.salary_type), оклад (salary_fixed) и процент (salary_percent) читаются
// как есть. Процент в карточке подписан «% of revenue»; у оператора выручка —
// это деньги, которые принесли ЕГО пациенты:
//   база = оплаты в кассу за период (приход по правилу кассы, INFLOW_SQL) от
//          пациентов, чья заявка у этого оператора дошла до «Пришёл» и была
//          заведена не позже оплаты.
// Пациент с двумя заявками у разных операторов засчитывается каждому из них —
// это решение отображения, а не начисление: настоящую зарплату по-прежнему
// считает бухгалтерия.

import { today, localDate, inLocalRange } from '../domain/day.js';
import { isAdminUser } from '../grants.js';
import { canViewSection } from '../roles.js';
import { canSeeAllLeads } from '../crm/visibility.js';
import { wonStageKey, lostStageKeys, noShowStageKey, openStageKeys, scheduledStageKey } from '../crm/config.js';
import { INFLOW_SQL } from '../../../public/js/shared/payment-methods.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const KPI_PERIODS = ['today', 'week', 'month', 'prev_month'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (part, total) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);
const holes = (arr) => (arr.length ? arr : ['']).map(() => '?').join(',');
const vals = (arr) => (arr.length ? arr : ['']);

function ymd(d) { return d.toISOString().slice(0, 10); }
function parse(s) { return new Date(s + 'T00:00:00Z'); }

/** Местные даты периода { key, from, to }; «месяц» — с первого числа по сегодня. */
export function kpiRange(todayYmd, period) {
  const t = parse(todayYmd);
  if (period === 'today') return { key: 'today', from: todayYmd, to: todayYmd };
  if (period === 'week') {
    const back = (t.getUTCDay() + 6) % 7;   // понедельник — начало недели
    return { key: 'week', from: ymd(new Date(t.getTime() - back * 86400000)), to: todayYmd };
  }
  if (period === 'prev_month') {
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
    return { key: 'prev_month', from: ymd(first), to: ymd(last) };
  }
  return { key: 'month', from: ymd(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), to: todayYmd };
}

function canOpen(db, user) {
  try { return isAdminUser(user) || canViewSection(db, user, 'crm'); } catch (_) { return false; }
}

/** Операторы для выбора руководителю: те, у кого есть заявки, внутренний номер или роль колл-центра. */
function operatorList(db) {
  return db.prepare(`
    SELECT u.id, COALESCE(NULLIF(u.full_name, ''), u.username) AS name
      FROM users u
     WHERE COALESCE(u.is_active, 1) = 1
       AND (u.role = 'callcenter' OR COALESCE(u.pbx_extension, '') <> ''
            OR EXISTS (SELECT 1 FROM crm_requests r WHERE r.assigned_to = u.id))
     ORDER BY name`).all();
}

export function operatorKpi(db, args, user) {
  if (!user || !canOpen(db, user)) throw new RpcError('Раздел CRM вам не выдан.', 403);
  const me = Number(user.id);
  const seeAll = canSeeAllLeads(db, user);
  const want = args && args.user_id != null && args.user_id !== '' ? Number(args.user_id) : me;
  if (!Number.isInteger(want) || want <= 0) throw new RpcError('Не указан оператор.', 400);
  if (want !== me && !seeAll) throw new RpcError('Чужие показатели видит только руководитель колл-центра.', 403);
  // KPI_SCOPE_V1 (2026-11-17) — В ОТВЕТЕ ОКЛАД И ПРОЦЕНТ ИЗ КАРТОЧКИ СОТРУДНИКА. Право
  // «вся доска CRM» (руководитель колл-центра, врач с crm.all) открывало по user_id
  // оплату ЛЮБОГО сотрудника — например, оклад главного врача: выбор скрывал
  // не-операторов, сервер — нет. Чужие показатели — только у тех, кого предлагает
  // выбор (operatorList); себя видит каждый. РЕШЕНИЕ: и администратору — только
  // операторы: экран другого не просит, а зарплаты остальных — в карточке сотрудника.
  // Отказ одинаков для не-оператора и для несуществующего id: перебором не узнать,
  // кто есть в клинике.
  const operators = seeAll ? operatorList(db) : [];
  if (want !== me && !operators.some((o) => Number(o.id) === want)) {
    throw new RpcError('Показатели и оплату открывают только у операторов колл-центра.', 403);
  }

  const op = db.prepare(`SELECT id, COALESCE(NULLIF(full_name, ''), username) AS name, role, pbx_extension,
      salary_type, salary_fixed, salary_percent, kpi_links FROM users WHERE id = ?`).get(want);
  if (!op) throw new RpcError('Сотрудник не найден.', 404);

  const period = KPI_PERIODS.includes(args && args.period) ? args.period : 'month';
  const range = kpiRange(today(db), period);
  const R = [range.from, range.to];

  const WON = wonStageKey(db);
  const SCHEDULED = scheduledStageKey(db) || '';
  const NO_SHOW = noShowStageKey(db) || '';
  const LOST = lostStageKeys(db).filter((k) => k !== NO_SHOW);
  const OPEN = openStageKeys(db);

  // ── Заявки ─────────────────────────────────────────────────────────────
  const L = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(r.status = ?) AS came,
           SUM(r.status = ?) AS scheduled,
           SUM(r.status = ?) AS no_show,
           SUM(r.status IN (${holes(LOST)})) AS lost,
           SUM(r.status IN (${holes(OPEN)})) AS open,
           SUM(r.patient_id IS NOT NULL) AS became_patient,
           SUM(r.scheduled_date IS NOT NULL AND r.scheduled_date <> '') AS with_date
      FROM crm_requests r
     WHERE r.assigned_to = ? AND ${inLocalRange('r.created_at')}`)
    .get(WON, SCHEDULED, NO_SHOW, ...vals(LOST), ...vals(OPEN), want, ...R);
  const leads = {
    total: L.total || 0, came: L.came || 0, scheduled: L.scheduled || 0, no_show: L.no_show || 0,
    lost: L.lost || 0, open: L.open || 0, became_patient: L.became_patient || 0, with_date: L.with_date || 0,
  };
  leads.conversion = pct(leads.came, leads.total);
  const openNow = db.prepare(`SELECT COUNT(*) n FROM crm_requests WHERE assigned_to = ? AND status IN (${holes(OPEN)})`)
    .get(want, ...vals(OPEN)).n;

  const byDay = new Map(db.prepare(`
    SELECT ${localDate('r.created_at')} AS d, COUNT(*) AS n, SUM(r.status = ?) AS came
      FROM crm_requests r WHERE r.assigned_to = ? AND ${inLocalRange('r.created_at')} GROUP BY d`)
    .all(WON, want, ...R).map((x) => [x.d, x]));
  const series = [];
  for (let d = range.from; d <= range.to; d = ymd(new Date(parse(d).getTime() + 86400000))) {
    const x = byDay.get(d);
    series.push({ date: d, leads: x ? x.n : 0, came: x ? (x.came || 0) : 0 });
  }

  // ── Звонки ─────────────────────────────────────────────────────────────
  const ext = String(op.pbx_extension || '').trim();
  let calls = null;
  if (ext) {
    const c = db.prepare(`
      SELECT SUM(CASE WHEN c.call_type = 0 THEN 1 ELSE 0 END) AS inc,
             SUM(CASE WHEN c.call_type = 0 AND COALESCE(c.billsec, 0) > 0 THEN 1 ELSE 0 END) AS ans,
             SUM(CASE WHEN c.call_type = 0 AND COALESCE(c.billsec, 0) = 0
                       AND COALESCE(c.disposition, '') NOT IN ('ONLINE','CALLING') THEN 1 ELSE 0 END) AS missed,
             SUM(CASE WHEN c.call_type = 1 THEN 1 ELSE 0 END) AS outg,
             SUM(CASE WHEN c.call_type = 1 AND COALESCE(c.billsec, 0) > 0 THEN 1 ELSE 0 END) AS outg_ans,
             SUM(COALESCE(c.billsec, 0)) AS talk,
             AVG(CASE WHEN c.call_type = 0 AND COALESCE(c.billsec, 0) > 0 THEN c.waitsec END) AS wait
        FROM calls c WHERE c.internal_number = ? AND ${inLocalRange('c.started_at')}`).get(ext, ...R);
    calls = {
      extension: ext,
      incoming: c.inc || 0, answered: c.ans || 0, missed: c.missed || 0,
      outgoing: c.outg || 0, outgoing_answered: c.outg_ans || 0,
      talk_min: Math.round((c.talk || 0) / 60), avg_wait_sec: Math.round(c.wait || 0),
      answer_rate: pct(c.ans || 0, (c.ans || 0) + (c.missed || 0)),
    };
  }

  // ── Задачи ─────────────────────────────────────────────────────────────
  const tasks = db.prepare(`
    SELECT SUM(CASE WHEN done_at IS NOT NULL AND ${inLocalRange('done_at')} THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN done_at IS NULL AND due_at IS NOT NULL AND julianday(due_at) < julianday('now') THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN done_at IS NULL THEN 1 ELSE 0 END) AS open
      FROM crm_tasks WHERE assignee_id = ?`).get(...R, want);

  // ── База процента: оплаты пациентов, которых оператор довёл до визита ──
  const pw = inLocalRange('p.paid_at');
  const base = db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS s, COUNT(DISTINCT i.patient_id) AS patients
      FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE p.${INFLOW_SQL} AND ${pw}
       AND EXISTS (SELECT 1 FROM crm_requests r
                    WHERE r.assigned_to = ? AND r.status = ? AND r.patient_id = i.patient_id
                      AND r.created_at <= p.paid_at)`).get(...R, want, WON);

  // ── Оплата из карточки сотрудника ─────────────────────────────────────
  const type = String(op.salary_type || '');
  const fixed = Number(op.salary_fixed) || 0;
  const percent = Number(op.salary_percent) || 0;
  const hasFix = (type === 'fixed' || type === 'fix_plus_kpi' || (!type && fixed > 0)) && fixed > 0;
  const hasPct = (type === 'percentage' || type === 'fix_plus_kpi' || (!type && percent > 0)) && percent > 0;
  const bonus = hasPct ? r2((Number(base.s) || 0) * percent / 100) : 0;
  const monthly = range.key === 'month' || range.key === 'prev_month';
  let kpiLinks = [];
  try { kpiLinks = Array.isArray(op.kpi_links) ? op.kpi_links : JSON.parse(op.kpi_links || '[]'); } catch (_) { kpiLinks = []; }
  const pay = {
    type, fixed: hasFix ? fixed : null, percent: hasPct ? percent : null,
    revenue_base: r2(base.s), revenue_patients: base.patients || 0,
    bonus: hasPct ? bonus : null,
    // Оклад — месячный: в итог «к начислению» он входит только за месяц.
    total: monthly && (hasFix || hasPct) ? r2((hasFix ? fixed : 0) + bonus) : null,
    kpi_links: kpiLinks.filter((k) => typeof k === 'string'),
    configured: hasFix || hasPct,
  };

  // ── Место среди операторов по «Пришёл» за тот же период ────────────────
  const ranks = db.prepare(`
    SELECT r.assigned_to AS uid, SUM(r.status = ?) AS came
      FROM crm_requests r WHERE r.assigned_to IS NOT NULL AND ${inLocalRange('r.created_at')}
     GROUP BY r.assigned_to ORDER BY came DESC`).all(WON, ...R);
  const pos = ranks.findIndex((x) => x.uid === want);

  return {
    operator: { id: op.id, name: op.name, extension: ext || null },
    period: range,
    leads, open_now: openNow, series,
    calls,
    tasks: { done: tasks.done || 0, overdue: tasks.overdue || 0, open: tasks.open || 0 },
    pay,
    rank: pos >= 0 && leads.came > 0 ? { place: pos + 1, of: ranks.filter((x) => (x.came || 0) > 0).length } : null,
    can_pick: seeAll,
    operators,
  };
}
