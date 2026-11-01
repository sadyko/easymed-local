// DASHBOARD_OVERVIEW_V1 (2026-10-30) — ОБЗОР КЛИНИКИ ДЛЯ РУКОВОДИТЕЛЯ.
//
// Владелец: «make super informative in terms of everything, CRM, Telegram bot,
// clinic, all the departments to Head of clinic».
//
// Сводка (dashboard.js) отвечает на вопрос «как идёт СЕГОДНЯ» и обязана
// помещаться в один экран (DASH_ONE_SCREEN_V1). Руководителю нужен другой
// вопрос — «как идёт клиника ЗА ПЕРИОД и что требует моего внимания»: деньги и
// чем платят, кто должен и как давно, какие направления и врачи работают,
// сколько заявок пришло и сколько из них дошло до клиники, сколько звонков
// потеряно и кому так и не перезвонили, что делает Telegram-бот, как быстро
// лаборатория отдаёт результат. Это отдельный запрос и отдельная вкладка, а не
// ещё восемь плиток на сводке: сводка осталась взглядом, обзор — чтением.
//
// КАЖДОЕ ЧИСЛО ИДЁТ С ПРОШЛЫМ ПЕРИОДОМ той же длины, где сравнение имеет смысл:
// «120 визитов» ничего не говорят руководителю, «120, на 18 % больше» — говорят.
//
// ДОСТУП — ПО РАЗДЕЛАМ, ТЕМИ ЖЕ ПРЕДИКАТАМИ, ЧТО У САМИХ РАЗДЕЛОВ. Раздел, который
// человеку не открыт, приходит null — его нет в ответе сервера, а не только на
// экране (тот же принцип, что V3120_FIX у сводки):
//   • деньги (финансы, суммы по направлениям, врачам и услугам) — право на
//     выручку в «Отчётах» (reports.revenue), как у сводки;
//   • заявки и звонки — «видит всю доску» CRM (crm.all), как у показателей
//     операторов (rpc/telephony.js telephonyOperatorStats);
//   • Telegram — раздел «Чат с пациентами», как у самого чата (rpc/telegram.js);
//   • пациенты, направления (количества), лаборатория, стационар — всем, кто
//     видит сводку: те же счётчики уже стоят на её плитках.
//
// Периоды — МЕСТНЫЕ календарные дни (domain/day.js), окна — localRangeWhere:
// точные для любого формата даты и идут по индексу колонки.

import { today, localDate, localRangeWhere } from '../domain/day.js';
import { outstandingWhere } from '../domain/money.js';
import { INFLOW_SQL } from '../../../public/js/shared/payment-methods.js';
import { canSeeReportKey } from '../report-access.js';
import { canSeeAllLeads } from '../crm/visibility.js';
import { canViewSection } from '../roles.js';
import { openStageKeys, lostStageKeys, wonStageKey } from '../crm/config.js';
import { overviewDepartments } from './dashboard-overview-depts.js';

const DAYS_DEFAULT = 14;
const DAYS_MAX = 90;
/** Строка услуги ВЫПОЛНЕНА — тот же список, что у отчётов (reports.js VS_PERFORMED_STATUSES). */
const VS_PERFORMED_SQL = "vs.status IN ('collected','in_progress','resulted','completed')";
/** Отменённый визит и «не пришёл» — не работа клиники (reports.js LIVE_VISIT_SQL). */
const LIVE_VISIT_SQL = "COALESCE(v.status, '') NOT IN ('cancelled','no_show')";
/** Живой счёт за услуги: не отменён, не возвращён, не депозит и не подарочная карта (reports.js). */
const LIVE_SERVICE_INVOICE_SQL = `i.status NOT IN ('void','refunded')
  AND COALESCE(i.invoice_number, '') NOT LIKE 'DEP-%' AND COALESCE(i.invoice_number, '') NOT LIKE 'CARD-%'`;
/** Звонок ещё идёт — ни отвеченным, ни пропущенным его считать рано. */
const LIVE_CALL_SQL = "COALESCE(c.disposition, '') NOT IN ('ONLINE','CALLING')";
const TOP = 10;

function seesMoney(db, user) {
  if (!user) return true;
  try { return canSeeReportKey(db, user, 'reports.revenue'); } catch (_) { return false; }
}
function seesCrm(db, user) {
  if (!user) return true;
  try { return canSeeAllLeads(db, user); } catch (_) { return false; }
}
function seesTelegram(db, user) {
  if (!user) return true;
  try { return canViewSection(db, user, 'telegram-chat'); } catch (_) { return false; }
}

function addDays(ymd, n) {
  return new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const inList = (keys) => keys.map((k) => `'${String(k).replace(/'/g, "''")}'`).join(',') || "''";

export function dashboardOverview(db, args, user) {
  const days = Math.max(1, Math.min(DAYS_MAX, Math.round(Number(args && args.days) || DAYS_DEFAULT)));
  const to = today(db);
  const from = addDays(to, -(days - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const list = [];
  for (let d = from; d <= to; d = addDays(d, 1)) list.push(d);

  const one = (sql, params = []) => db.prepare(sql).get(...params);
  const all = (sql, params = []) => db.prepare(sql).all(...params);
  /** Окно периода по колонке: { sql, params }; prev — прошлый период той же длины. */
  const win = (col, prev = false) => localRangeWhere(col, prev ? prevFrom : from, prev ? prevTo : to);
  /** Одно и то же число за текущий и прошлый период. */
  const pair = (fn) => ({ cur: fn(win, false), prev: fn(win, true) });

  const money = seesMoney(db, user);
  const out = {
    period: { days, from, to, prev_from: prevFrom, prev_to: prevTo },
    money_visible: money,
  };

  // ── ПАЦИЕНТЫ ────────────────────────────────────────────────────────────
  const newPatients = pair((w, p) => { const x = w('pt.created_at', p);
    return one(`SELECT COUNT(*) n FROM patients pt WHERE ${x.sql}`, x.params).n; });
  const visitsN = pair((w, p) => { const x = w('v.visit_date', p);
    return one(`SELECT COUNT(*) n FROM visits v WHERE ${x.sql} AND ${LIVE_VISIT_SQL}`, x.params).n; });
  const vw = win('v.visit_date');
  const vstat = one(`SELECT COUNT(DISTINCT CASE WHEN ${LIVE_VISIT_SQL} THEN v.patient_id END) uniq,
      SUM(CASE WHEN ${LIVE_VISIT_SQL} AND v.visit_kind = 'repeat' THEN 1 ELSE 0 END) rep,
      SUM(CASE WHEN COALESCE(v.status,'') IN ('cancelled','no_show') THEN 1 ELSE 0 END) lost
    FROM visits v WHERE ${vw.sql}`, vw.params);
  // Возраст тех, кто пришёл за период — на сегодняшний день клиники.
  const ages = { child: 0, young: 0, middle: 0, senior: 0, unknown: 0 };
  for (const r of all(`SELECT CASE
        WHEN pt.date_of_birth IS NULL OR pt.date_of_birth = '' THEN 'unknown'
        WHEN (julianday(date(?)) - julianday(pt.date_of_birth)) / 365.25 < 18 THEN 'child'
        WHEN (julianday(date(?)) - julianday(pt.date_of_birth)) / 365.25 < 40 THEN 'young'
        WHEN (julianday(date(?)) - julianday(pt.date_of_birth)) / 365.25 < 60 THEN 'middle'
        ELSE 'senior' END AS b, COUNT(*) n
      FROM patients pt
     WHERE pt.id IN (SELECT v.patient_id FROM visits v WHERE ${vw.sql} AND ${LIVE_VISIT_SQL})
     GROUP BY b`, [to, to, to, ...vw.params])) ages[r.b] = r.n;
  const referrals = all(`SELECT COALESCE(NULLIF(TRIM(rs.name), ''),
             TRIM(COALESCE(rs.last_name, '') || ' ' || COALESCE(rs.first_name, ''))) AS name, COUNT(*) n
      FROM visits v JOIN referral_sources rs ON rs.id = v.referral_source_id
     WHERE ${vw.sql} AND ${LIVE_VISIT_SQL}
     GROUP BY rs.id ORDER BY n DESC LIMIT 6`, vw.params);
  const visitsTotal = visitsN.cur;
  out.patients = {
    new: newPatients.cur, new_prev: newPatients.prev,
    visits: visitsTotal, visits_prev: visitsN.prev,
    unique: vstat.uniq || 0,
    repeat: vstat.rep || 0, first: Math.max(0, visitsTotal - (vstat.rep || 0)),
    cancelled: vstat.lost || 0,
    ages, referrals,
  };

  // ── НАПРАВЛЕНИЯ, ВРАЧИ, УСЛУГИ ──────────────────────────────────────────
  // «Направление» — отделение услуги, а где оно не указано — вид услуги
  // (Консультации, Диагностика, Лаборатория…). В клиниках, которые отделения
  // услугам не проставили, иначе вся работа легла бы одной строкой «Прочее».
  // Сумма — то, на что услуги НАЗНАЧЕНЫ (цена строк), а не деньги кассы: деньги
  // кассы платёж не раскладывает по услугам, и выдумывать эту раскладку здесь
  // значило бы показать руководителю число, которого нет ни в одном отчёте.
  const sw = win('vs.created_at');
  const dirRows = all(`SELECT COALESCE(d.name, st.name) AS dir_name, COUNT(*) n,
         SUM(CASE WHEN ${VS_PERFORMED_SQL} THEN 1 ELSE 0 END) done,
         COALESCE(SUM(vs.total), 0) s
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN service_types st ON st.id = s.type_id
     WHERE ${sw.sql} AND ${LIVE_VISIT_SQL}
     GROUP BY dir_name`, sw.params);
  // Стационар — равное направление: его услуги и койко-дни живут в
  // admission_services, а не в строках визита.
  const aw = win('s.created_at');
  const ward = one(`SELECT COUNT(*) n, SUM(CASE WHEN s.performed_at IS NOT NULL THEN 1 ELSE 0 END) done,
         COALESCE(SUM(s.total), 0) s
      FROM admission_services s JOIN admissions a ON a.id = s.admission_id
     WHERE ${aw.sql} AND COALESCE(s.billable, 1) = 1 AND COALESCE(a.status, '') <> 'cancelled'`, aw.params);
  const directions = dirRows.map((r) => ({ name: r.dir_name, inpatient: false, n: r.n, done: r.done || 0, sum: r2(r.s) }));
  if (ward.n) directions.push({ name: null, inpatient: true, n: ward.n, done: ward.done || 0, sum: r2(ward.s) });
  directions.sort((a, b) => (money ? b.sum - a.sum : 0) || b.n - a.n);
  out.directions = directions.map((r) => ({ ...r, sum: money ? r.sum : null }));

  const order = money ? 's DESC, n DESC' : 'n DESC';
  out.doctors = all(`SELECT u.id, COALESCE(NULLIF(u.full_name, ''), u.username) AS name, u.specialty,
         COUNT(DISTINCT v.patient_id) patients, COUNT(*) n,
         SUM(CASE WHEN ${VS_PERFORMED_SQL} THEN 1 ELSE 0 END) done,
         COALESCE(SUM(vs.total), 0) s
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      JOIN users u ON u.id = COALESCE(vs.doctor_id, v.doctor_id)
     WHERE ${sw.sql} AND ${LIVE_VISIT_SQL}
     GROUP BY u.id ORDER BY ${order} LIMIT ${TOP}`, sw.params)
    .map((r) => ({ id: r.id, name: r.name, specialty: r.specialty || '', patients: r.patients, n: r.n,
      done: r.done || 0, sum: money ? r2(r.s) : null }));
  out.services = all(`SELECT s.id, s.name, COUNT(*) n, COALESCE(SUM(vs.total), 0) s
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      JOIN services s ON s.id = vs.service_id
     WHERE ${sw.sql} AND ${LIVE_VISIT_SQL}
     GROUP BY s.id ORDER BY ${order} LIMIT ${TOP}`, sw.params)
    .map((r) => ({ id: r.id, name: r.name, n: r.n, sum: money ? r2(r.s) : null }));

  // ── ФИНАНСЫ ─────────────────────────────────────────────────────────────
  out.finance = null;
  if (money) {
    // Приход кассы — то же правило, что у плитки «Принято сегодня»: оплата с
    // депозита и подарочной картой — трата уже принятых денег, не новые.
    const collected = pair((w, p) => { const x = w('p.paid_at', p);
      return r2(one(`SELECT COALESCE(SUM(p.amount), 0) s FROM payments p WHERE p.${INFLOW_SQL} AND ${x.sql}`, x.params).s); });
    const pw = win('p.paid_at');
    const refunds = r2(-one(`SELECT COALESCE(SUM(p.amount), 0) s FROM payments p
       WHERE p.${INFLOW_SQL} AND p.amount < 0 AND ${pw.sql}`, pw.params).s);
    const methods = all(`SELECT p.method, COALESCE(SUM(p.amount), 0) s FROM payments p
       WHERE p.amount > 0 AND ${pw.sql} GROUP BY p.method ORDER BY s DESC`, pw.params)
      .map((r) => ({ method: r.method, sum: r2(r.s) }));
    const iw = win('i.created_at');
    const inv = one(`SELECT COUNT(*) n, COALESCE(AVG(i.total_amount), 0) avg,
         COALESCE(SUM(i.discount_amount), 0) disc
      FROM invoices i WHERE ${iw.sql} AND ${LIVE_SERVICE_INVOICE_SQL}`, iw.params);
    // Долг по давности: свежий долг — забота кассы, долг старше месяца —
    // забота руководителя.
    const aging = { d7: { n: 0, sum: 0 }, d30: { n: 0, sum: 0 }, older: { n: 0, sum: 0 } };
    for (const r of all(`SELECT CASE
          WHEN julianday(date(?)) - julianday(${localDate('i.created_at')}) <= 7 THEN 'd7'
          WHEN julianday(date(?)) - julianday(${localDate('i.created_at')}) <= 30 THEN 'd30'
          ELSE 'older' END AS b, COUNT(*) n, COALESCE(SUM(i.total_amount - i.paid_amount), 0) s
        FROM invoices i WHERE ${outstandingWhere('i.status')} AND i.total_amount - i.paid_amount > 0.005
        GROUP BY b`, [to, to])) aging[r.b] = { n: r.n, sum: r2(r.s) };
    const cw = win('cs.closed_at');
    const shifts = one(`SELECT COUNT(*) n,
         COALESCE(SUM(CASE WHEN cs.over_short < 0 THEN cs.over_short ELSE 0 END), 0) short,
         COALESCE(SUM(CASE WHEN cs.over_short > 0 THEN cs.over_short ELSE 0 END), 0) over,
         SUM(CASE WHEN ABS(COALESCE(cs.over_short, 0)) > 0.005 THEN 1 ELSE 0 END) off
      FROM cash_shifts cs WHERE cs.closed_at IS NOT NULL AND ${cw.sql}`, cw.params);
    const openShifts = one("SELECT COUNT(*) n FROM cash_shifts WHERE closed_at IS NULL AND COALESCE(status, 'open') = 'open'").n;
    out.finance = {
      collected: collected.cur, collected_prev: collected.prev, refunds,
      methods,
      invoices: inv.n, avg_check: r2(inv.avg), discounts: r2(inv.disc),
      debt_aging: aging,
      shifts_closed: shifts.n, shifts_off: shifts.off || 0,
      shortage: r2(shifts.short), surplus: r2(shifts.over), shifts_open: openShifts,
    };
  }

  // ── CRM И ЗВОНКИ ────────────────────────────────────────────────────────
  out.crm = null;
  out.calls = null;
  out.series = list.map((d) => ({ date: d, leads: 0, calls_in: 0, missed: 0 }));
  const byDay = new Map(out.series.map((r) => [r.date, r]));
  if (seesCrm(db, user)) {
    const won = wonStageKey(db);
    const open = openStageKeys(db);
    const lost = lostStageKeys(db);
    const leads = pair((w, p) => { const x = w('r.created_at', p);
      return one(`SELECT COUNT(*) n FROM crm_requests r WHERE ${x.sql}`, x.params).n; });
    const rw = win('r.created_at');
    const kinds = one(`SELECT
         SUM(CASE WHEN r.status = ? THEN 1 ELSE 0 END) won,
         SUM(CASE WHEN r.status IN (${inList(lost)}) THEN 1 ELSE 0 END) lost,
         SUM(CASE WHEN r.status IN (${inList(open)}) THEN 1 ELSE 0 END) open
      FROM crm_requests r WHERE ${rw.sql}`, [won, ...rw.params]);
    const wonPrev = (() => { const x = win('r.created_at', true);
      return one(`SELECT COUNT(*) n FROM crm_requests r WHERE r.status = ? AND ${x.sql}`, [won, ...x.params]).n; })();
    // Воронка периода по колонкам доски — в порядке колонок.
    const stages = all(`SELECT st.key, st.label, st.kind, st.color, COUNT(r.id) n
        FROM crm_stages st LEFT JOIN crm_requests r ON r.status = st.key AND ${rw.sql}
       WHERE st.is_active = 1 GROUP BY st.key ORDER BY st.position, st.key`, rw.params);
    const sources = all(`SELECT r.source AS key, COALESCE(cs.label, r.source) AS label, COUNT(*) n,
         SUM(CASE WHEN r.status = ? THEN 1 ELSE 0 END) won
        FROM crm_requests r LEFT JOIN crm_sources cs ON cs.key = r.source
       WHERE ${rw.sql} GROUP BY r.source ORDER BY n DESC`, [won, ...rw.params]);
    const operators = all(`SELECT r.assigned_to AS id, u.full_name AS name, COUNT(*) n,
         SUM(CASE WHEN r.status = ? THEN 1 ELSE 0 END) won
        FROM crm_requests r LEFT JOIN users u ON u.id = r.assigned_to
       WHERE ${rw.sql} GROUP BY r.assigned_to ORDER BY n DESC LIMIT 8`, [won, ...rw.params]);
    const openNow = one(`SELECT COUNT(*) n, SUM(CASE WHEN assigned_to IS NULL THEN 1 ELSE 0 END) unassigned
        FROM crm_requests WHERE status IN (${inList(open)})`);
    const tasksOverdue = one(`SELECT COUNT(*) n FROM crm_tasks
        WHERE done_at IS NULL AND due_at IS NOT NULL AND julianday(due_at) < julianday('now')`).n;
    let metaLeads = 0;
    try { const x = win('m.received_at'); metaLeads = one(`SELECT COUNT(*) n FROM meta_leads m WHERE ${x.sql}`, x.params).n; } catch (_) { /* старая база без Meta */ }
    for (const r of all(`SELECT ${localDate('r.created_at')} d, COUNT(*) n FROM crm_requests r WHERE ${rw.sql} GROUP BY d`, rw.params)) {
      const row = byDay.get(r.d); if (row) row.leads = r.n;
    }
    out.crm = {
      leads: leads.cur, leads_prev: leads.prev,
      won: kinds.won || 0, won_prev: wonPrev, lost: kinds.lost || 0, open: kinds.open || 0,
      conversion: leads.cur ? r1(((kinds.won || 0) / leads.cur) * 100) : 0,
      conversion_prev: leads.prev ? r1((wonPrev / leads.prev) * 100) : 0,
      stages: stages.map((s) => ({ key: s.key, label: s.label, kind: s.kind, color: s.color || '', n: s.n })),
      sources: sources.map((s) => ({ key: s.key, label: s.label || '', n: s.n, won: s.won || 0 })),
      operators: operators.map((o) => ({ id: o.id, name: o.name || null, n: o.n, won: o.won || 0 })),
      open_now: openNow.n || 0, unassigned_now: openNow.unassigned || 0,
      tasks_overdue: tasksOverdue, meta_leads: metaLeads,
    };

    // Звонки: call_type 0 — входящий, 1 — исходящий (rpc/telephony.js).
    const callPair = pair((w, p) => { const x = w('c.started_at', p);
      return one(`SELECT
           SUM(CASE WHEN c.call_type = 0 THEN 1 ELSE 0 END) inc,
           SUM(CASE WHEN c.call_type = 1 THEN 1 ELSE 0 END) outg,
           SUM(CASE WHEN c.call_type = 0 AND COALESCE(c.billsec, 0) > 0 THEN 1 ELSE 0 END) ans,
           SUM(CASE WHEN c.call_type = 0 AND COALESCE(c.billsec, 0) = 0 AND ${LIVE_CALL_SQL} THEN 1 ELSE 0 END) missed,
           AVG(CASE WHEN c.call_type = 0 AND COALESCE(c.billsec, 0) > 0 THEN c.waitsec END) wait,
           COALESCE(SUM(c.billsec), 0) talk
        FROM calls c WHERE ${x.sql}`, x.params); });
    const cw = win('c.started_at');
    // «Не перезвонили» — номера, чей пропущенный входящий так и остался без
    // разговора ПОСЛЕ него (ни нашего звонка, ни их повторного, на который
    // ответили). Считается в JS по двум выборкам по индексу started_at:
    // встречный подзапрос по номеру шёл бы без индекса по всему журналу.
    const missedRows = all(`SELECT c.external_number num, MAX(c.started_at) at FROM calls c
       WHERE ${cw.sql} AND c.call_type = 0 AND COALESCE(c.billsec, 0) = 0 AND ${LIVE_CALL_SQL}
         AND COALESCE(c.external_number, '') <> '' GROUP BY c.external_number`, cw.params);
    let notCalledBack = 0;
    if (missedRows.length) {
      const lastTalk = new Map(all(`SELECT c.external_number num, MAX(c.started_at) at FROM calls c
         WHERE c.started_at >= ? AND COALESCE(c.billsec, 0) > 0 AND COALESCE(c.external_number, '') <> ''
         GROUP BY c.external_number`, [addDays(from, -1)]).map((r) => [r.num, r.at]));
      for (const m of missedRows) { const t = lastTalk.get(m.num); if (!t || t < m.at) notCalledBack++; }
    }
    for (const r of all(`SELECT ${localDate('c.started_at')} d,
         SUM(CASE WHEN c.call_type = 0 THEN 1 ELSE 0 END) inc,
         SUM(CASE WHEN c.call_type = 0 AND COALESCE(c.billsec, 0) = 0 AND ${LIVE_CALL_SQL} THEN 1 ELSE 0 END) missed
        FROM calls c WHERE ${cw.sql} GROUP BY d`, cw.params)) {
      const row = byDay.get(r.d); if (row) { row.calls_in = r.inc || 0; row.missed = r.missed || 0; }
    }
    const c = callPair.cur;
    const cp = callPair.prev;
    const rate = (x) => ((x.ans || 0) + (x.missed || 0)) ? r1(((x.ans || 0) / ((x.ans || 0) + (x.missed || 0))) * 100) : 0;
    out.calls = {
      incoming: c.inc || 0, outgoing: c.outg || 0, answered: c.ans || 0, missed: c.missed || 0,
      incoming_prev: cp.inc || 0, missed_prev: cp.missed || 0,
      answer_rate: rate(c), answer_rate_prev: rate(cp),
      avg_wait_sec: Math.round(c.wait || 0), talk_min: Math.round((c.talk || 0) / 60),
      not_called_back: notCalledBack,
    };
  }

  // ── TELEGRAM-БОТ ────────────────────────────────────────────────────────
  out.telegram = null;
  if (seesTelegram(db, user)) {
    const subs = one(`SELECT
         SUM(CASE WHEN revoked_at IS NULL AND blocked_at IS NULL THEN 1 ELSE 0 END) active,
         SUM(CASE WHEN revoked_at IS NULL AND blocked_at IS NOT NULL THEN 1 ELSE 0 END) blocked
      FROM telegram_links`);
    const newSubs = pair((w, p) => { const x = w('l.linked_at', p);
      return one(`SELECT COUNT(*) n FROM telegram_links l WHERE ${x.sql}`, x.params).n; });
    const mw = win('m.created_at');
    const msgs = one(`SELECT
         SUM(CASE WHEN m.direction = 'in' THEN 1 ELSE 0 END) inc,
         SUM(CASE WHEN m.direction = 'out' AND m.kind = 'text' THEN 1 ELSE 0 END) replies,
         COUNT(DISTINCT CASE WHEN m.direction = 'in' THEN m.chat_id END) chats
      FROM telegram_messages m WHERE ${mw.sql}`, mw.params);
    const unread = one("SELECT COUNT(*) n FROM telegram_messages WHERE direction = 'in' AND read_at IS NULL").n;
    const unreadChats = one("SELECT COUNT(DISTINCT chat_id) n FROM telegram_messages WHERE direction = 'in' AND read_at IS NULL").n;
    const dw = win('d.created_at');
    const deliv = one(`SELECT SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END) sent,
         SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) failed
      FROM telegram_deliveries d WHERE ${dw.sql}`, dw.params);
    const bw = win('b.created_at');
    const bc = one(`SELECT COUNT(*) n, COALESCE(SUM(b.sent_count), 0) sent, COALESCE(SUM(b.failed_count), 0) failed
      FROM telegram_broadcasts b WHERE ${bw.sql}`, bw.params);
    let deeplinkLeads = 0;
    try { const x = win('dl.created_at'); deeplinkLeads = one(`SELECT COUNT(*) n FROM telegram_deeplink_leads dl WHERE ${x.sql}`, x.params).n; } catch (_) { /* старая база */ }
    out.telegram = {
      subscribers: subs.active || 0, blocked: subs.blocked || 0,
      new_subscribers: newSubs.cur, new_subscribers_prev: newSubs.prev,
      messages_in: msgs.inc || 0, replies: msgs.replies || 0, chats: msgs.chats || 0,
      unread, unread_chats: unreadChats,
      docs_sent: deliv.sent || 0, docs_failed: deliv.failed || 0,
      broadcasts: bc.n, broadcast_sent: bc.sent, broadcast_failed: bc.failed,
      deeplink_leads: deeplinkLeads,
    };
  }

  // ── ЛАБОРАТОРИЯ ─────────────────────────────────────────────────────────
  const ordered = one(`SELECT COUNT(*) n FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id JOIN services s ON s.id = vs.service_id
     WHERE ${sw.sql} AND s.is_lab = 1 AND ${LIVE_VISIT_SQL}`, sw.params).n;
  const lw = win('lr.verified_at');
  // Срок выполнения — от заказа строки до ПОСЛЕДНЕГО подтверждённого
  // показателя: результат готов, когда готов весь, а не первая строка бланка.
  const tat = one(`SELECT COUNT(*) n, AVG(h) avg_h FROM (
      SELECT (julianday(MAX(lr.verified_at)) - julianday(vs.created_at)) * 24 AS h
        FROM lab_results lr JOIN visit_services vs ON vs.id = lr.visit_service_id
       WHERE lr.verified_at IS NOT NULL AND ${lw.sql}
       GROUP BY vs.id)`, lw.params);
  const flags = one(`SELECT COUNT(*) n, SUM(CASE WHEN lr.flag IS NOT NULL AND lr.flag NOT IN ('', 'normal') THEN 1 ELSE 0 END) abn
      FROM lab_results lr WHERE lr.verified_at IS NOT NULL AND ${lw.sql}`, lw.params);
  out.lab = {
    ordered, verified: tat.n || 0,
    avg_tat_hours: tat.avg_h != null ? r1(Math.max(0, tat.avg_h)) : null,
    results: flags.n || 0, abnormal: flags.abn || 0,
    abnormal_pct: flags.n ? r1(((flags.abn || 0) / flags.n) * 100) : 0,
  };

  // ── СТАЦИОНАР ЗА ПЕРИОД ─────────────────────────────────────────────────
  const adm = pair((w, p) => { const x = w('a.admitted_at', p);
    return one(`SELECT COUNT(*) n FROM admissions a WHERE a.status <> 'cancelled' AND ${x.sql}`, x.params).n; });
  const dw2 = win('a.discharged_at');
  const dis = one(`SELECT COUNT(*) n, AVG(julianday(a.discharged_at) - julianday(a.admitted_at)) los
      FROM admissions a WHERE a.status = 'discharged' AND a.discharged_at IS NOT NULL AND a.admitted_at IS NOT NULL
        AND ${dw2.sql}`, dw2.params);
  out.inpatient = {
    admissions: adm.cur, admissions_prev: adm.prev,
    discharges: dis.n || 0, avg_los_days: dis.los != null ? r1(Math.max(0, dis.los)) : null,
  };

  // DASHBOARD_CEO_V1 — маркетинг, колл-центр, амбулатория, стационар подробно,
  // процедуры, склад, направители (dashboard-overview-depts.js).
  Object.assign(out, overviewDepartments({ db, user, from, to, prevFrom, prevTo, money }));

  return out;
}
