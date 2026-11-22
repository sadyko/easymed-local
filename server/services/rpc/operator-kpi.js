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
// (rpc/callcenter.js CRM_HEAD_MERGE_TAGS_V1).
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
    operators: seeAll ? operatorList(db) : [],
  };
}

// ---------------------------------------------------------------------------
// CRM_SALES_TEAM_V1 (2026-11-22, владелец со снимком «Отчёта по заявкам»: «make
// head of sales department report more detailed, statistic should show money
// brought from each sales manager too»).
//
// Весь отдел продаж одной таблицей: по каждому менеджеру — заявки и их судьба
// по ступеням воронки и ДЕНЬГИ, которые принесли его пациенты. Определения —
// ровно те же, что у «Мой KPI» выше (operatorKpi), чтобы руководитель и сам
// оператор видели одно и то же число:
//   * заявка менеджера — та, которую он ВЕДЁТ (assigned_to);
//   * «принесли» — оплаты в кассу за период (INFLOW_SQL) от пациентов, чья
//     заявка у этого менеджера дошла до «Пришёл» и заведена не позже оплаты.
//     Пациент с «пришедшими» заявками у двух менеджеров засчитывается обоим —
//     как у KPI; поэтому строка «Итого» денег — это сумма по ПАЦИЕНТАМ CRM
//     (без двойного счёта), а не сложение строк.
// Видит только тот, кому открыта вся доска (canSeeAllLeads): чужие деньги —
// та же граница, что выбор чужого оператора в «Мой KPI».
// Период — как у отчёта на экране: days = 1 (сегодня), 7, 30, 0 — всё время.
// ---------------------------------------------------------------------------
export function salesTeamReport(db, args, user) {
  if (!user || !canOpen(db, user)) throw new RpcError('Раздел CRM вам не выдан.', 403);
  if (!canSeeAllLeads(db, user)) throw new RpcError('Отчёт по отделу продаж видит руководитель колл-центра.', 403);

  const days = Number(args && args.days);
  const to = today(db);
  const from = days > 0 ? ymd(new Date(parse(to).getTime() - (Math.floor(days) - 1) * 86400000)) : '2000-01-01';
  const R = [from, to];

  const WON = wonStageKey(db);
  const SCHEDULED = scheduledStageKey(db) || '';
  const NO_SHOW = noShowStageKey(db) || '';
  const LOST = lostStageKeys(db).filter((k) => k !== NO_SHOW);
  const OPEN = openStageKeys(db);

  const leadRows = db.prepare(`
    SELECT r.assigned_to AS uid, COUNT(*) AS total,
           SUM(r.status = ?) AS came, SUM(r.status = ?) AS scheduled, SUM(r.status = ?) AS no_show,
           SUM(r.status IN (${holes(LOST)})) AS lost, SUM(r.status IN (${holes(OPEN)})) AS open,
           SUM(r.patient_id IS NOT NULL) AS became_patient
      FROM crm_requests r
     WHERE ${inLocalRange('r.created_at')}
     GROUP BY r.assigned_to`).all(WON, SCHEDULED, NO_SHOW, ...vals(LOST), ...vals(OPEN), ...R);

  // Первая «пришедшая» заявка пары (менеджер, пациент): оплата засчитывается,
  // если такая заявка заведена не позже оплаты — то же, что EXISTS у KPI.
  const pw = inLocalRange('p.paid_at');
  const PAIRS = `SELECT assigned_to, patient_id, MIN(created_at) AS first_at
                   FROM crm_requests
                  WHERE status = ? AND assigned_to IS NOT NULL AND patient_id IS NOT NULL
                  GROUP BY assigned_to, patient_id`;
  const money = db.prepare(`
    SELECT w.assigned_to AS uid, COALESCE(SUM(p.amount), 0) AS s, COUNT(DISTINCT i.patient_id) AS patients
      FROM payments p JOIN invoices i ON i.id = p.invoice_id
      JOIN (${PAIRS}) w ON w.patient_id = i.patient_id AND w.first_at <= p.paid_at
     WHERE p.${INFLOW_SQL} AND ${pw}
     GROUP BY w.assigned_to`).all(WON, ...R);
  const total = db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS s, COUNT(DISTINCT i.patient_id) AS patients
      FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE p.${INFLOW_SQL} AND ${pw}
       AND EXISTS (SELECT 1 FROM crm_requests r
                    WHERE r.status = ? AND r.assigned_to IS NOT NULL AND r.patient_id = i.patient_id
                      AND r.created_at <= p.paid_at)`).get(...R, WON);

  const byUid = new Map();
  const row = (uid) => {
    const k = uid == null ? 'none' : String(uid);
    if (!byUid.has(k)) {
      byUid.set(k, { user_id: uid == null ? null : Number(uid), total: 0, came: 0, scheduled: 0, no_show: 0,
        lost: 0, open: 0, became_patient: 0, revenue: 0, paying_patients: 0 });
    }
    return byUid.get(k);
  };
  for (const x of leadRows) {
    Object.assign(row(x.uid), { total: x.total || 0, came: x.came || 0, scheduled: x.scheduled || 0, no_show: x.no_show || 0,
      lost: x.lost || 0, open: x.open || 0, became_patient: x.became_patient || 0 });
  }
  for (const x of money) Object.assign(row(x.uid), { revenue: r2(x.s), paying_patients: x.patients || 0 });

  const ids = [...byUid.values()].map((m) => m.user_id).filter((v) => v != null);
  const names = new Map(ids.length ? db.prepare(`SELECT id, COALESCE(NULLIF(full_name, ''), username) AS name
      FROM users WHERE id IN (${holes(ids)})`).all(...ids).map((u) => [u.id, u.name]) : []);
  const managers = [...byUid.values()].map((m) => ({
    ...m,
    name: m.user_id == null ? null : (names.get(m.user_id) || null),
    conversion: pct(m.came, m.total),
    avg_check: m.paying_patients ? r2(m.revenue / m.paying_patients) : 0,
  })).sort((a, b) => (a.user_id == null) - (b.user_id == null) || b.revenue - a.revenue || b.came - a.came || b.total - a.total);

  const sum = (k) => managers.reduce((s, m) => s + (Number(m[k]) || 0), 0);

  // CRM_SALES_CHARTS_V1 (2026-11-22, владелец: «can you make it more detailed
  // with chart, I could make decision based on this report») — ряд по времени
  // для графиков: заявки и «пришли» — по дню заведения заявки (как цифры выше),
  // деньги — по дню оплаты (то же правило «Принесли», без повторов пациента).
  // Шаг — день, а за «всё время» и периоды длиннее 90 дней — месяц: сотни
  // столбиков по дню не читаются.
  const byMonth = !(days > 0 && days <= 90);
  const bucket = (col) => (byMonth ? `substr(${localDate(col)}, 1, 7)` : localDate(col));
  const leadSeries = db.prepare(`
    SELECT ${bucket('r.created_at')} AS k, COUNT(*) AS leads, SUM(r.status = ?) AS came
      FROM crm_requests r WHERE ${inLocalRange('r.created_at')} GROUP BY k`).all(WON, ...R);
  const moneySeries = db.prepare(`
    SELECT ${bucket('p.paid_at')} AS k, COALESCE(SUM(p.amount), 0) AS s
      FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE p.${INFLOW_SQL} AND ${pw}
       AND EXISTS (SELECT 1 FROM crm_requests r
                    WHERE r.status = ? AND r.assigned_to IS NOT NULL AND r.patient_id = i.patient_id
                      AND r.created_at <= p.paid_at)
     GROUP BY k`).all(...R, WON);
  const keys = new Set([...leadSeries.map((x) => x.k), ...moneySeries.map((x) => x.k)]);
  if (!byMonth) {   // каждый день периода — и пустой тоже: провал в ноль видно на графике
    for (let d = from; d <= to; d = ymd(new Date(parse(d).getTime() + 86400000))) keys.add(d);
  }
  const L = new Map(leadSeries.map((x) => [x.k, x]));
  const M = new Map(moneySeries.map((x) => [x.k, x]));
  const series = [...keys].filter(Boolean).sort().map((k) => ({
    key: k, leads: (L.get(k) || {}).leads || 0, came: (L.get(k) || {}).came || 0, revenue: r2((M.get(k) || {}).s),
  }));

  return {
    period: { from: days > 0 ? from : null, to },
    step: byMonth ? 'month' : 'day',
    series,
    managers,
    totals: {
      total: sum('total'), came: sum('came'), scheduled: sum('scheduled'), no_show: sum('no_show'),
      lost: sum('lost'), open: sum('open'), became_patient: sum('became_patient'),
      conversion: pct(sum('came'), sum('total')),
      revenue: r2(total.s), paying_patients: total.patients || 0,
    },
  };
}
