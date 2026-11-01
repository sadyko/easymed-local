// DASHBOARD_CEO_V1 (2026-10-31) — отделы «Обзора клиники», которых там не было.
//
// Владелец, глядя на сводку: «make fully informing dashboard in terms of all
// departments like marketing ads, call center, ambulatory, stationar and other,
// super informative for CEO of hospital». Решено расширить «Обзор клиники»
// (DASHBOARD_OVERVIEW_V1), а не заводить вторую похожую вкладку. Этот модуль —
// новые разделы ответа; dashboard-overview.js зовёт его одной строкой и отдаёт
// его поля рядом со своими.
//
// Те же правила, что у обзора:
//   * период — местные дни, окна — localRangeWhere (ctx.win);
//   * раздел, который человеку не открыт, приходит null — его нет в ответе;
//   * суммы — только с правом на выручку (ctx.money), иначе null;
//   * каждое определение взято у раздела-хозяина, ссылка — у запроса.
//
// Чего здесь НЕТ, и почему (не «забыли»):
//   * расход на рекламу и цена заявки — в базе нет ни рекламного кабинета, ни
//     расходов: Meta отдаёт клинике заявки и переписку, но не деньги;
//   * ожидание в очереди амбулатории — у строки визита нет времени вызова и
//     начала приёма (visit_services: только scheduled_at / sample_collected_at).

import { localDate, localRangeWhere } from '../domain/day.js';
import { isAdminUser } from '../grants.js';
import { canViewSection } from '../roles.js';
import { canSeeAllLeads } from '../crm/visibility.js';
import { wonStageKey } from '../crm/config.js';
import { sourceEachSql } from '../crm/sources.js';
import { INFLOW_SQL } from '../../../public/js/shared/payment-methods.js';
import { IN_BED_STATUSES } from '../../../public/js/shared/admission-status.js';
import { inboxStats } from '../meta/inbox-stats.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const TOP = 8;
/** Отменённый визит и «не пришёл» — не работа клиники (как у обзора и отчётов). */
const LIVE_VISIT_SQL = "COALESCE(v.status, '') NOT IN ('cancelled','no_show')";
/** Звонок ещё идёт (как у обзора). */
const LIVE_CALL_SQL = "COALESCE(c.disposition, '') NOT IN ('ONLINE','CALLING')";
/** Строка услуги ВЫПОЛНЕНА — список отчётов (reports.js VS_PERFORMED_STATUSES), как у обзора. */
const VS_PERFORMED_SQL = "vs.status IN ('collected','in_progress','resulted','completed')";
/** Что считается процедурой — rpc/procedures.js PROCEDURE_SERVICE_SQL. */
const PROCEDURE_SQL = "(s.type = 'procedure' OR d.kind = 'procedure')";
const IN_BED = IN_BED_STATUSES.map((s) => `'${s}'`).join(',');

function sees(db, user, section) {
  if (!user) return true;
  try { return isAdminUser(user) || canViewSection(db, user, section); } catch (_) { return false; }
}
function seesCrm(db, user) {
  if (!user) return true;
  try { return canSeeAllLeads(db, user); } catch (_) { return false; }
}
/** Таблица появилась поздней миграцией — на старой базе раздел просто пуст. */
function safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

/**
 * ctx: { db, user, from, to, prevFrom, prevTo, money }
 * Возвращает { marketing, callcenter, outpatient, inpatient_ext, procedures, stock, referrers }.
 */
export function overviewDepartments(ctx) {
  const { db, user, from, to, prevFrom, prevTo, money } = ctx;
  const one = (sql, params = []) => db.prepare(sql).get(...params);
  const all = (sql, params = []) => db.prepare(sql).all(...params);
  const win = (col, prev = false) => localRangeWhere(col, prev ? prevFrom : from, prev ? prevTo : to);
  const out = {};
  const won = safe(() => wonStageKey(db), 'came');
  const pw = win('p.paid_at');

  /**
   * Сколько заплатили за период пациенты из подзапроса (одна колонка pid).
   * Деньги кассы — по счёту пациента, приход по правилу обзора (INFLOW_SQL).
   */
  const paidBy = (pidSql, params) => r2(one(`SELECT COALESCE(SUM(p.amount), 0) s
      FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE p.${INFLOW_SQL} AND ${pw.sql} AND i.patient_id IN (${pidSql})`, [...pw.params, ...params]).s);

  // ── МАРКЕТИНГ И РЕКЛАМА ─────────────────────────────────────────────────
  out.marketing = null;
  if (seesCrm(db, user)) {
    const mw = win('m.received_at');
    const meta = safe(() => {
      const totals = one(`SELECT COUNT(*) n,
           SUM(CASE WHEN m.status = 'error' THEN 1 ELSE 0 END) errors,
           SUM(CASE WHEN m.status = 'merged' THEN 1 ELSE 0 END) merged,
           SUM(CASE WHEN r.status = ? THEN 1 ELSE 0 END) won,
           COUNT(DISTINCT r.patient_id) patients
        FROM meta_leads m LEFT JOIN crm_requests r ON r.id = m.crm_request_id WHERE ${mw.sql}`, [won, ...mw.params]);
      const prev = (() => { const x = win('m.received_at', true);
        return one(`SELECT COUNT(*) n FROM meta_leads m WHERE ${x.sql}`, x.params).n; })();
      // Кампания, а где её нет (форма без рекламы) — форма.
      const camp = "COALESCE(NULLIF(m.campaign_name, ''), NULLIF(m.form_name, ''), '')";
      const campaigns = all(`SELECT ${camp} AS name, COUNT(*) n,
           SUM(CASE WHEN r.status = ? THEN 1 ELSE 0 END) won,
           COUNT(DISTINCT r.patient_id) patients
        FROM meta_leads m LEFT JOIN crm_requests r ON r.id = m.crm_request_id
       WHERE ${mw.sql} GROUP BY name ORDER BY n DESC LIMIT ${TOP}`, [won, ...mw.params])
        .map((c) => ({
          name: c.name, n: c.n, won: c.won || 0, patients: c.patients || 0,
          revenue: money ? paidBy(`SELECT r.patient_id FROM meta_leads m JOIN crm_requests r ON r.id = m.crm_request_id
              WHERE ${mw.sql} AND r.patient_id IS NOT NULL AND ${camp} = ?`, [...mw.params, c.name]) : null,
        }));
      return { leads: totals.n || 0, leads_prev: prev, errors: totals.errors || 0, merged: totals.merged || 0,
        won: totals.won || 0, patients: totals.patients || 0, campaigns };
    }, null);

    // Источники заявок — каждая заявка под КАЖДЫМ своим источником, как у
    // CRM (crm/sources.js sourceEachSql); «стали пациентами» и их оплаты.
    const rw = win('r.created_at');
    const se = sourceEachSql('r', 'src');
    const sources = safe(() => all(`SELECT src.value AS key, COALESCE(cs.label, src.value) AS label, COUNT(*) n,
         SUM(CASE WHEN r.status = ? THEN 1 ELSE 0 END) won,
         COUNT(DISTINCT r.patient_id) patients
      FROM crm_requests r, ${se.join}
      LEFT JOIN crm_sources cs ON cs.key = src.value
     WHERE ${se.ok} AND ${rw.sql}
     GROUP BY src.value ORDER BY n DESC`, [won, ...rw.params]), []).map((s) => ({
      key: s.key, label: s.label || s.key, n: s.n, won: s.won || 0, patients: s.patients || 0,
      revenue: money ? paidBy(`SELECT r.patient_id FROM crm_requests r, ${se.join}
          WHERE ${se.ok} AND ${rw.sql} AND r.patient_id IS NOT NULL AND src.value = ?`, [...rw.params, s.key]) : null,
    }));

    // Чат Facebook и Instagram — теми же словами, что его «Статистика».
    let chat = null;
    if (sees(db, user, 'meta-chat')) {
      chat = safe(() => {
        const s = inboxStats(db, { from, to });
        const ch = Object.fromEntries(s.channels.map((c) => [c.key, c]));
        return {
          messages_in: s.totals.messages_in, comments_in: s.totals.comments_in, people: s.totals.people,
          answered: s.totals.answered, requests: s.totals.requests, missed: s.totals.missed,
          median_ms: s.totals.median_ms, leads: s.totals.leads,
          waiting_now: s.waiting_now,
          channels: ['messenger', 'instagram', 'facebook', 'instagram_comments'].map((k) => ({ key: k, incoming: ch[k].incoming, leads: ch[k].leads })),
        };
      }, null);
    }

    // Рассылки SMS (мигр. 262). Telegram-рассылки — в карточке бота.
    const sw = win('b.created_at');
    const sms = safe(() => one(`SELECT COUNT(*) n, COALESCE(SUM(b.sent_count), 0) sent, COALESCE(SUM(b.failed_count), 0) failed
      FROM sms_broadcasts b WHERE ${sw.sql}`, sw.params), { n: 0, sent: 0, failed: 0 });

    out.marketing = { meta, sources, chat, sms: { broadcasts: sms.n || 0, sent: sms.sent || 0, failed: sms.failed || 0 } };
  }

  // ── КОЛЛ-ЦЕНТР ──────────────────────────────────────────────────────────
  // Оператор звонка — по внутреннему номеру (users.pbx_extension), как у
  // показателей операторов (rpc/telephony.js telephonyOperatorStats);
  // «отвечен» — billsec > 0, там же.
  out.callcenter = null;
  if (seesCrm(db, user)) {
    const cw = win('c.started_at');
    const operators = all(`SELECT COALESCE(u.full_name, '') AS name, COALESCE(NULLIF(c.internal_number, ''), '') AS ext,
         SUM(CASE WHEN c.call_type = 0 THEN 1 ELSE 0 END) inc,
         SUM(CASE WHEN c.call_type = 0 AND COALESCE(c.billsec, 0) > 0 THEN 1 ELSE 0 END) ans,
         SUM(CASE WHEN c.call_type = 1 THEN 1 ELSE 0 END) outg,
         SUM(COALESCE(c.billsec, 0)) talk,
         AVG(CASE WHEN c.call_type = 0 AND COALESCE(c.billsec, 0) > 0 THEN c.waitsec END) wait
      FROM calls c
      LEFT JOIN users u ON u.pbx_extension IS NOT NULL AND u.pbx_extension <> '' AND u.pbx_extension = c.internal_number
     WHERE ${cw.sql}
     GROUP BY name, ext ORDER BY (inc + outg) DESC LIMIT ${TOP}`, cw.params)
      .map((o) => ({ name: o.name, ext: o.ext, incoming: o.inc || 0, answered: o.ans || 0, outgoing: o.outg || 0,
        talk_min: Math.round((o.talk || 0) / 60), avg_wait_sec: Math.round(o.wait || 0) }));
    // Когда теряем звонки — пропущенные входящие по часу суток.
    const missedHours = Array.from({ length: 24 }, (_, h) => ({ hour: h, missed: 0, incoming: 0 }));
    for (const r of all(`SELECT CAST(strftime('%H', c.started_at, 'localtime') AS INTEGER) h,
         SUM(CASE WHEN c.call_type = 0 THEN 1 ELSE 0 END) inc,
         SUM(CASE WHEN c.call_type = 0 AND COALESCE(c.billsec, 0) = 0 AND ${LIVE_CALL_SQL} THEN 1 ELSE 0 END) missed
      FROM calls c WHERE ${cw.sql} GROUP BY h`, cw.params)) {
      if (missedHours[r.h]) { missedHours[r.h].incoming = r.inc || 0; missedHours[r.h].missed = r.missed || 0; }
    }
    // Звонок → заявка → пришёл (crm_requests.call_id).
    const rw = win('r.created_at');
    const fromCalls = one(`SELECT COUNT(*) n, SUM(CASE WHEN r.status = ? THEN 1 ELSE 0 END) won
      FROM crm_requests r WHERE r.call_id IS NOT NULL AND ${rw.sql}`, [won, ...rw.params]);
    out.callcenter = { operators, missed_hours: missedHours, leads_from_calls: fromCalls.n || 0, won_from_calls: fromCalls.won || 0 };
  }

  // ── АМБУЛАТОРИЯ ─────────────────────────────────────────────────────────
  // Отделение визита — отделение врача; где его нет — специальность врача,
  // затем отделение или вид услуги визита (как «Направления» обзора: клиники,
  // которые врачам отделений не проставили, иначе получили бы одну пустую строку).
  const vw = win('v.visit_date');
  const deptName = "COALESCE(NULLIF(d.name, ''), NULLIF(u.specialty, ''), NULLIF(d2.name, ''), NULLIF(st.name, ''), '')";
  const byDept = all(`SELECT ${deptName} AS dept,
       SUM(CASE WHEN ${LIVE_VISIT_SQL} THEN 1 ELSE 0 END) visits,
       SUM(CASE WHEN v.status = 'no_show' THEN 1 ELSE 0 END) no_show,
       SUM(CASE WHEN v.status = 'cancelled' THEN 1 ELSE 0 END) cancelled,
       COUNT(DISTINCT CASE WHEN ${LIVE_VISIT_SQL} THEN v.patient_id END) patients
    FROM visits v LEFT JOIN users u ON u.id = v.doctor_id LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN services s0 ON s0.id = COALESCE(v.service_id, (SELECT vs0.service_id FROM visit_services vs0 WHERE vs0.visit_id = v.id ORDER BY vs0.id LIMIT 1))
    LEFT JOIN departments d2 ON d2.id = s0.department_id
    LEFT JOIN service_types st ON st.id = s0.type_id
   WHERE ${vw.sql} GROUP BY dept ORDER BY visits DESC LIMIT 10`, vw.params);
  const weekdays = Array.from({ length: 7 }, (_, i) => ({ wd: i, visits: 0 }));
  for (const r of all(`SELECT CAST(strftime('%w', ${localDate('v.visit_date')}) AS INTEGER) wd, COUNT(*) n
      FROM visits v WHERE ${vw.sql} AND ${LIVE_VISIT_SQL} GROUP BY wd`, vw.params)) {
    if (weekdays[r.wd]) weekdays[r.wd].visits = r.n;
  }
  const sw2 = win('vs.created_at');
  const svc = one(`SELECT COUNT(*) n, COUNT(DISTINCT vs.visit_id) visits, COALESCE(SUM(vs.total), 0) s
    FROM visit_services vs JOIN visits v ON v.id = vs.visit_id WHERE ${sw2.sql} AND ${LIVE_VISIT_SQL}`, sw2.params);
  const status = one(`SELECT SUM(CASE WHEN v.status = 'no_show' THEN 1 ELSE 0 END) ns,
       SUM(CASE WHEN v.status = 'cancelled' THEN 1 ELSE 0 END) cn, COUNT(*) n
    FROM visits v WHERE ${vw.sql}`, vw.params);
  out.outpatient = {
    departments: byDept.map((d) => ({ name: d.dept, visits: d.visits || 0, patients: d.patients || 0, no_show: d.no_show || 0, cancelled: d.cancelled || 0 })),
    weekdays,
    services_per_visit: svc.visits ? r1(svc.n / svc.visits) : null,
    revenue_per_visit: money && svc.visits ? r2(svc.s / svc.visits) : null,
    no_show: status.ns || 0, cancelled: status.cn || 0,
    no_show_rate: status.n ? r1(((status.ns || 0) / status.n) * 100) : 0,
  };

  // ── СТАЦИОНАР ПОДРОБНО ──────────────────────────────────────────────────
  // «Сейчас» — по госпитализациям в койке, не по beds.status (rpc/dashboard.js).
  const inBedNow = one(`SELECT COUNT(*) n FROM admissions WHERE status IN (${IN_BED})`).n;
  const bedsTotal = one('SELECT COUNT(*) n FROM beds WHERE COALESCE(active, 1) = 1').n;
  const bedsBusy = one(`SELECT COUNT(DISTINCT bed_id) n FROM admissions WHERE bed_id IS NOT NULL AND status IN (${IN_BED})`).n;
  const wards = all(`SELECT w.name, COUNT(b.id) beds,
       COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM admissions a WHERE a.bed_id = b.id AND a.status IN (${IN_BED})) THEN 1 ELSE 0 END), 0) busy
    FROM wards w LEFT JOIN beds b ON b.ward_id = w.id AND COALESCE(b.active, 1) = 1
   WHERE COALESCE(w.active, 1) = 1 GROUP BY w.id HAVING beds > 0 ORDER BY w.name`);
  const aw = win('a.admitted_at');
  const kinds = one(`SELECT SUM(CASE WHEN a.admission_type = 'emergency' THEN 1 ELSE 0 END) emergency,
       SUM(CASE WHEN a.admission_type = 'planned' THEN 1 ELSE 0 END) planned,
       SUM(CASE WHEN a.stay_mode = 'day' THEN 1 ELSE 0 END) day_stay
    FROM admissions a WHERE a.status <> 'cancelled' AND ${aw.sql}`, aw.params);
  const dw = win('a.discharged_at');
  const outcomes = {};
  for (const r of all(`SELECT COALESCE(a.discharge_outcome, '') k, COUNT(*) n FROM admissions a
      WHERE a.status = 'discharged' AND ${dw.sql} GROUP BY k`, dw.params)) outcomes[r.k || 'unknown'] = r.n;
  const dischargeDebt = one(`SELECT COALESCE(SUM(a.discharge_debt_amount), 0) s, SUM(CASE WHEN COALESCE(a.discharge_debt_amount, 0) > 0.005 THEN 1 ELSE 0 END) n
    FROM admissions a WHERE a.status = 'discharged' AND ${dw.sql}`, dw.params);
  // Койко-день — строка admission_services без услуги (rpc/accommodation.js).
  const sw3 = win('s.created_at');
  const ward = one(`SELECT
       COALESCE(SUM(CASE WHEN s.service_id IS NULL THEN s.quantity ELSE 0 END), 0) bed_days,
       COALESCE(SUM(CASE WHEN s.service_id IS NULL THEN s.total ELSE 0 END), 0) bed_sum,
       COALESCE(SUM(s.total), 0) total
    FROM admission_services s JOIN admissions a ON a.id = s.admission_id
   WHERE ${sw3.sql} AND COALESCE(s.billable, 1) = 1 AND COALESCE(a.status, '') <> 'cancelled'`, sw3.params);
  const byDeptIp = all(`SELECT COALESCE(NULLIF(a.department, ''), '') name, COUNT(*) n FROM admissions a
    WHERE a.status <> 'cancelled' AND ${aw.sql} GROUP BY name ORDER BY n DESC LIMIT 6`, aw.params);
  out.inpatient_ext = {
    in_bed_now: inBedNow, beds_total: bedsTotal, beds_busy: bedsBusy,
    occupancy: bedsTotal ? Math.round((bedsBusy / bedsTotal) * 100) : 0,
    wards: wards.map((w) => ({ name: w.name, beds: w.beds, busy: w.busy })),
    emergency: kinds.emergency || 0, planned: kinds.planned || 0, day_stay: kinds.day_stay || 0,
    outcomes,
    bed_days: r1(ward.bed_days),
    revenue: money ? r2(ward.total) : null,
    bed_revenue: money ? r2(ward.bed_sum) : null,
    discharge_debt: money ? r2(dischargeDebt.s) : null,
    discharge_debt_n: dischargeDebt.n || 0,
    departments: byDeptIp.map((d) => ({ name: d.name, n: d.n })),
  };

  // ── ПРОЦЕДУРЫ ───────────────────────────────────────────────────────────
  const procRows = all(`SELECT s.id, s.name, COUNT(*) n,
       SUM(CASE WHEN ${VS_PERFORMED_SQL} THEN 1 ELSE 0 END) done, COALESCE(SUM(vs.total), 0) sm
    FROM visit_services vs JOIN visits v ON v.id = vs.visit_id
    JOIN services s ON s.id = vs.service_id LEFT JOIN departments d ON d.id = s.department_id
   WHERE ${sw2.sql} AND ${LIVE_VISIT_SQL} AND ${PROCEDURE_SQL}
   GROUP BY s.id ORDER BY n DESC`, sw2.params);
  const wardProc = one(`SELECT COUNT(*) n, SUM(CASE WHEN s2.performed_at IS NOT NULL THEN 1 ELSE 0 END) done
    FROM admission_services s2 JOIN services s ON s.id = s2.service_id LEFT JOIN departments d ON d.id = s.department_id
    JOIN admissions a ON a.id = s2.admission_id
   WHERE ${win('s2.created_at').sql} AND COALESCE(a.status, '') <> 'cancelled' AND ${PROCEDURE_SQL}`, win('s2.created_at').params);
  out.procedures = {
    outpatient: procRows.reduce((n, r) => n + r.n, 0),
    outpatient_done: procRows.reduce((n, r) => n + (r.done || 0), 0),
    inpatient: wardProc.n || 0, inpatient_done: wardProc.done || 0,
    revenue: money ? r2(procRows.reduce((n, r) => n + r.sm, 0)) : null,
    top: procRows.slice(0, 6).map((r) => ({ name: r.name, n: r.n, sum: money ? r2(r.sm) : null })),
  };

  // ── СКЛАД ───────────────────────────────────────────────────────────────
  out.stock = null;
  if (sees(db, user, 'inventory')) {
    // Низкий остаток — правило сводки (rpc/dashboard.js low_stock_count).
    const low = all(`SELECT name, unit, on_hand, reorder_level FROM products
      WHERE active = 1 AND reorder_level > 0 AND on_hand <= reorder_level
      ORDER BY (on_hand * 1.0 / reorder_level), name LIMIT ${TOP}`);
    const lowN = one('SELECT COUNT(*) n FROM products WHERE active = 1 AND reorder_level > 0 AND on_hand <= reorder_level').n;
    const zero = one('SELECT COUNT(*) n FROM products WHERE active = 1 AND reorder_level > 0 AND on_hand <= 0').n;
    // purchase_orders.received_at — формат «ГГГГ-ММ-ДД ЧЧ:ММ:СС» (datetime('now')):
    // окно localRangeWhere с ним точное, см. domain/day.js.
    const rcv = win('po.received_at');
    const po = safe(() => one(`SELECT COUNT(*) n, COALESCE(SUM(po.total), 0) s FROM purchase_orders po
      WHERE po.status IN ('received','partial') AND ${rcv.sql}`, rcv.params), { n: 0, s: 0 });
    const openPo = safe(() => one("SELECT COUNT(*) n FROM purchase_orders WHERE status IN ('ordered','partial')").n, 0);
    const mvw = win('m.created_at');
    const used = safe(() => one(`SELECT COALESCE(SUM(ABS(m.qty) * COALESCE(m.unit_cost, 0)), 0) s FROM stock_movements m
      WHERE m.kind = 'dispense' AND ${mvw.sql}`, mvw.params).s, 0);
    out.stock = {
      low_count: lowN, zero_count: zero,
      low: low.map((p) => ({ name: p.name, unit: p.unit || '', on_hand: p.on_hand, reorder_level: p.reorder_level })),
      received_orders: po.n || 0, received_sum: money ? r2(po.s) : null,
      open_orders: openPo,
      used_sum: money ? r2(used) : null,
    };
  }

  // ── НАПРАВИТЕЛИ ─────────────────────────────────────────────────────────
  out.referrers = null;
  if (sees(db, user, 'referrals')) {
    const rsName = "COALESCE(NULLIF(TRIM(rs.name), ''), TRIM(COALESCE(rs.last_name, '') || ' ' || COALESCE(rs.first_name, '')))";
    const top = all(`SELECT rs.id, ${rsName} AS name, COALESCE(u.full_name, '') AS rep,
         COUNT(DISTINCT v.id) visits, COUNT(DISTINCT v.patient_id) patients,
         COALESCE(SUM(vs.total), 0) s
      FROM visits v JOIN referral_sources rs ON rs.id = v.referral_source_id
      LEFT JOIN users u ON u.id = rs.representative_id
      LEFT JOIN visit_services vs ON vs.visit_id = v.id
     WHERE ${vw.sql} AND ${LIVE_VISIT_SQL}
     GROUP BY rs.id ORDER BY ${money ? 's' : 'visits'} DESC LIMIT ${TOP}`, vw.params);
    const ipRef = one(`SELECT COUNT(*) n FROM admissions a WHERE a.referral_source_id IS NOT NULL AND a.status <> 'cancelled' AND ${aw.sql}`, aw.params).n;
    const reps = all(`SELECT COALESCE(u.full_name, '') name, COUNT(DISTINCT v.id) visits, COUNT(DISTINCT rs.id) sources
      FROM visits v JOIN referral_sources rs ON rs.id = v.referral_source_id JOIN users u ON u.id = rs.representative_id
     WHERE ${vw.sql} AND ${LIVE_VISIT_SQL} GROUP BY u.id ORDER BY visits DESC LIMIT 6`, vw.params);
    const added = safe(() => { const x = win('ra.created_at');
      return one(`SELECT COUNT(*) n FROM rep_bot_additions ra WHERE ${x.sql}`, x.params).n; }, 0);
    const refVisits = one(`SELECT COUNT(*) n FROM visits v WHERE v.referral_source_id IS NOT NULL AND ${vw.sql} AND ${LIVE_VISIT_SQL}`, vw.params).n;
    out.referrers = {
      visits: refVisits, admissions: ipRef, new_sources_by_reps: added,
      top: top.map((t) => ({ name: t.name, rep: t.rep, visits: t.visits, patients: t.patients, sum: money ? r2(t.s) : null })),
      reps: reps.map((r) => ({ name: r.name, visits: r.visits, sources: r.sources })),
    };
  }

  return out;
}
