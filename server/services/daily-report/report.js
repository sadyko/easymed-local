// DAILY_REPORT_BOT_V1 (2026-11-13) — текст ежедневного отчёта совету директоров.
//
// ЧИСЛА — НЕ СВОИ. Отчёт читает dashboardOverview (rpc/dashboard-overview.js) за
// один день — тот же расчёт, что «Сводка» на экране руководителя. Своих запросов
// здесь нет нарочно: две формулы «принято за день» рано или поздно разошлись бы, и
// совет директоров увидел бы в Telegram одно число, а главный врач на экране другое.
// user = null — сервер без зрителя: все разделы (деньги, CRM, звонки) на месте.
//
// Текст — HTML для Telegram (sendMessage parse_mode HTML): жирные заголовки
// блоков, имена из базы экранируются. Без эмодзи — как весь продукт.
//
// DAILY_REPORT_FORMAT_V2 (2026-11-14) — владелец прислал образец «Итог дня»
// и сказал: «format of telegram push report should be more like this. But first
// there should be total income then by cashier, then by coverage type». Отсюда:
//   * шапка «Итог дня — 14 ноября, суббота», блоки короткими строками
//     «название — число», суммы в строках без «сум» (в заголовке блока — с ним);
//   * порядок: принято за день (способы оплаты, счетов закрыто) → по кассирам →
//     по типу покрытия → по отделениям → по группам услуг → пациенты → колл-центр;
//   * разбивки по кассирам, покрытию, отделениям и группам считает dayBreakdown()
//     ниже: в сводке руководителя их нет. Определение «принято» — то же, что у
//     сводки (INFLOW_SQL, день по paid_at), поэтому сумма каждой разбивки
//     сходится с «Принято за день».
import { dashboardOverview } from '../rpc/dashboard-overview.js';
import { METHOD_RU, INFLOW_SQL } from '../../../public/js/shared/payment-methods.js';
import { today, localRangeWhere } from '../domain/day.js';
import { sectionsOf } from './settings.js';

const TG_LIMIT = 4000;   // у Telegram 4096 знаков; запас на «…»
const TOP = 5;
const TOP_SPLIT = 8;     // строк в разбивке; остальное — «и ещё N — сумма»

const WEEKDAY = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export const SECTION_TITLES = Object.freeze({
  cash: 'Принято за день', cashiers: 'По кассирам', coverage: 'По типу покрытия',
  departments: 'По отделениям', groups: 'По группам услуг', patients: 'Пациенты',
  crm: 'Колл-центр', debt: 'Долг пациентов', calls: 'Звонки', doctors: 'Врачи',
});

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** «1 250 000 сум» — пробел между тысячами, как на экранах клиники. */
export function money(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '−' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' сум';
}
const num = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
/** «(+12 %)» к прошлому дню; с нуля — «(было 0)»; равно — ничего. */
export function delta(cur, prev) {
  const c = Number(cur) || 0;
  const p = Number(prev) || 0;
  if (c === p) return '';
  if (!p) return ' (было 0)';
  const pct = Math.round(((c - p) / p) * 100);
  return pct ? ` (${pct > 0 ? '+' : '−'}${Math.abs(pct)} %)` : '';
}
/** «(+12 % к вчера)» у итога дня; равно или вчера ноль — ничего (DAILY_REPORT_OWNER_V1). */
function vsYesterday(cur, prev) {
  const c = Number(cur) || 0;
  const p = Number(prev) || 0;
  if (!p || c === p) return '';
  const pct = Math.round(((c - p) / p) * 100);
  return pct ? ` (${pct > 0 ? '+' : '−'}${Math.abs(pct)} % к вчера)` : '';
}
function dmy(ymd) { const [y, m, d] = String(ymd).split('-'); return `${d}.${m}.${y}`; }
function weekday(ymd) { return WEEKDAY[new Date(ymd + 'T12:00:00Z').getUTCDay()]; }
function addDays(ymd, n) { return new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }

/** День отчёта по настройке «за какой день»: 'today' — сегодня клиники, 'yesterday' — вчера. */
export function reportDay(db, period) {
  const t = today(db);
  return period === 'yesterday' ? addDays(t, -1) : t;
}

function clinicName(db) {
  try { const r = db.prepare('SELECT clinic_name FROM doc_settings WHERE id = 1').get(); return (r && r.clinic_name) || 'Easy-Med'; }
  catch (_) { return 'Easy-Med'; }
}

/** «14 ноября» — день и месяц словом, как в образце владельца. */
function dayMonth(ymd) { const [, m, d] = String(ymd).split('-'); return `${Number(d)} ${MONTH_GEN[Number(m) - 1]}`; }

/**
 * Разбивки «Принято за день», которых нет в сводке руководителя.
 * Каждая считается от одних и тех же строк payments (приход кассы за день:
 * INFLOW_SQL, день по paid_at — как «Принято» у сводки), поэтому сумма каждой
 * разбивки равна «Принято за день».
 *   cashiers — по тому, кто принял (payments.cashier_id);
 *   coverage — по плательщику счёта (invoices.payer_id → payers), без плательщика
 *              — «Сам пациент»;
 *   departments / groups — оплата делится между услугами счёта по доле строки
 *              (invoice_items.total), отделение и группа — у услуги. Группа —
 *              тип услуги (service_types: Консультации, Диагностика,
 *              Лаборатория…; так у образца владельца и у «Направлений» сводки),
 *              без типа — категория. Оплата без
 *              счёта или счёт без строк — «(без отделения)» / «(без группы)».
 * Таблица из поздней миграции на старой базе — пустая разбивка, а не сбой отчёта.
 */
export function dayBreakdown(db, day) {
  const out = { cashiers: [], coverage: [], departments: [], groups: [], invoices_closed: 0, leads_with_card: 0 };
  const pw = localRangeWhere('p.paid_at', day, day);
  const safe = (fn) => { try { fn(); } catch (_) { /* старая база — разбивки нет */ } };
  const PAY = `FROM payments p WHERE p.${INFLOW_SQL} AND ${pw.sql}`;

  safe(() => {
    out.cashiers = db.prepare(`SELECT COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, 'Не указан') AS name, SUM(p.amount) AS sum
        FROM payments p LEFT JOIN users u ON u.id = p.cashier_id
        WHERE p.${INFLOW_SQL} AND ${pw.sql} GROUP BY p.cashier_id ORDER BY sum DESC`).all(...pw.params);
  });
  safe(() => {
    out.coverage = db.prepare(`SELECT py.name AS name, py.kind AS kind, SUM(p.amount) AS sum
        FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN payers py ON py.id = i.payer_id
        WHERE p.${INFLOW_SQL} AND ${pw.sql} GROUP BY i.payer_id ORDER BY sum DESC`).all(...pw.params);
  });
  safe(() => {
    const pays = db.prepare(`SELECT p.invoice_id AS inv, SUM(p.amount) AS sum ${PAY} GROUP BY p.invoice_id`).all(...pw.params);
    const items = db.prepare(`SELECT ii.invoice_id AS inv, COALESCE(ii.total, 0) AS total, d.name AS dept, COALESCE(st.name, c.name) AS grp
        FROM invoice_items ii LEFT JOIN services s ON s.id = ii.service_id
        LEFT JOIN departments d ON d.id = s.department_id LEFT JOIN service_types st ON st.id = s.type_id
        LEFT JOIN service_categories c ON c.id = s.category_id
        WHERE ii.invoice_id IN (SELECT DISTINCT p.invoice_id ${PAY})`).all(...pw.params);
    const byInv = new Map();
    for (const it of items) { if (!byInv.has(it.inv)) byInv.set(it.inv, []); byInv.get(it.inv).push(it); }
    const dept = new Map();
    const grp = new Map();
    const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    for (const p of pays) {
      const lines = (byInv.get(p.inv) || []).filter((l) => Number(l.total) > 0);
      const base = lines.reduce((s, l) => s + Number(l.total), 0);
      if (!base) { add(dept, null, p.sum); add(grp, null, p.sum); continue; }
      for (const l of lines) {
        const part = (p.sum * Number(l.total)) / base;
        add(dept, l.dept || null, part);
        add(grp, l.grp || null, part);
      }
    }
    const rows = (m) => [...m].map(([name, sum]) => ({ name, sum })).sort((a, b) => b.sum - a.sum);
    out.departments = rows(dept);
    out.groups = rows(grp);
  });
  safe(() => {
    const iw = localRangeWhere('i.paid_at', day, day);
    out.invoices_closed = db.prepare(`SELECT COUNT(*) AS n FROM invoices i WHERE i.status = 'paid' AND ${iw.sql}`).get(...iw.params).n;
  });
  safe(() => {
    const rw = localRangeWhere('r.created_at', day, day);
    out.leads_with_card = db.prepare(`SELECT COUNT(*) AS n FROM crm_requests r WHERE r.patient_id IS NOT NULL AND ${rw.sql}`).get(...rw.params).n;
  });
  return out;
}

/** Строки разбивки: первые TOP_SPLIT, остальное одной строкой «и ещё N — сумма». */
function splitLines(rows, emptyName) {
  const live = rows.filter((r) => Math.round(Number(r.sum) || 0) !== 0);
  if (!live.length) return null;
  const head = live.slice(0, TOP_SPLIT).map((r) => `${esc(r.name || emptyName)} — ${num(r.sum)}`);
  const rest = live.slice(TOP_SPLIT);
  if (rest.length) head.push(`и ещё ${rest.length} — ${num(rest.reduce((s, r) => s + Number(r.sum), 0))}`);
  return head;
}

const PAYER_KIND = { insurance: 'страховая', government: 'гос. программа', corporate: 'организация' };

/** Блок: { title } — заголовок со значением (жирным), lines — строки. */
const BLOCKS = {
  cash(o, b) {
    const f = o.finance;
    if (!f) return null;
    const methods = f.methods.filter((m) => m.sum).map((m) => `${esc(METHOD_RU[m.method] || m.method || 'Другое')} — ${num(m.sum)}`);
    return {
      // DAILY_REPORT_OWNER_V1 (владелец: «make it more appropriate to owner, it
      // is now too detailed») — сравнение со вчера только у итога, словами.
      title: `Принято за день: ${money(f.collected)}${vsYesterday(f.collected, f.collected_prev)}`,
      lines: [
        ...methods,
        f.refunds ? `возвраты — ${num(f.refunds)}` : null,
        `счетов закрыто — ${num(b.invoices_closed)}`,
      ].filter(Boolean),
    };
  },
  cashiers(o, b) {
    if (!o.finance) return null;
    return { lines: splitLines(b.cashiers, 'Не указан') || ['оплат не было'] };
  },
  coverage(o, b) {
    if (!o.finance) return null;
    const rows = b.coverage.map((r) => ({
      name: r.name ? `${r.name}${PAYER_KIND[r.kind] ? ` (${PAYER_KIND[r.kind]})` : ''}` : 'Сам пациент', sum: r.sum,
    }));
    return { lines: splitLines(rows, 'Сам пациент') || ['оплат не было'] };
  },
  departments(o, b) {
    if (!o.finance) return null;
    return { lines: splitLines(b.departments, '(без отделения)') || ['оплат не было'] };
  },
  groups(o, b) {
    if (!o.finance) return null;
    return { lines: splitLines(b.groups, '(без группы)') || ['оплат не было'] };
  },
  patients(o) {
    const p = o.patients;
    const inBed = o.inpatient_ext && o.inpatient_ext.in_bed_now;
    return {
      lines: [
        // DAILY_REPORT_OWNER_V1 — три строки владельца, без процентов и отмен.
        `визитов — ${num(p.visits)}`,
        `новых карт — ${num(p.new)}`,
        inBed != null ? `в стационаре сейчас — ${num(inBed)}` : null,
      ].filter(Boolean),
    };
  },
  crm(o, b) {
    const c = o.crm;
    if (!c) return null;
    return {
      lines: [
        `заявок — ${num(c.leads)}`,
        `дошли — ${num(c.won)}`,
        `завели карту — ${num(b.leads_with_card)}`,
      ],
    };
  },
  debt(o) {
    const f = o.finance;
    if (!f) return null;
    const a = f.debt_aging;
    const row = (label, x) => (x.n ? `${label} — ${num(x.n)} счёт. · ${num(x.sum)}` : null);
    const sum = a.d7.sum + a.d30.sum + a.older.sum;
    const lines = [row('до 7 дней', a.d7), row('8–30 дней', a.d30), row('старше 30 дней', a.older)].filter(Boolean);
    return { title: sum ? `Долг пациентов: ${money(sum)}` : null, lines: lines.length ? lines : ['долгов нет'] };
  },
  calls(o) {
    const c = o.calls;
    if (!c) return null;
    if (!c.incoming && !c.outgoing) return { lines: ['звонков не было'] };
    return {
      lines: [
        `входящих — ${num(c.incoming)}${delta(c.incoming, c.incoming_prev)}, отвечено ${num(c.answered)} (${c.answer_rate} %)`,
        `пропущено — ${num(c.missed)}${c.not_called_back ? `, не перезвонили ${num(c.not_called_back)}` : ''}`,
        `исходящих — ${num(c.outgoing)}`,
      ],
    };
  },
  doctors(o) {
    const list = (o.doctors || []).slice(0, TOP);
    if (!list.length) return { lines: ['приёмов не было'] };
    return { lines: list.map((d) => `${esc(d.name)} — пациентов ${num(d.patients)}${d.sum != null ? ', ' + num(d.sum) : ''}`) };
  },
};

/**
 * Текст отчёта за день. sections — список блоков (пусто — все). Возвращает
 * { day, text }; текст не длиннее предела Telegram.
 */
export function buildReport(db, { day = today(db), sections = null } = {}) {
  const o = dashboardOverview(db, { days: 1, end: day }, null);
  const b = dayBreakdown(db, o.period.to);
  const keys = Array.isArray(sections) && sections.length ? sections : sectionsOf('[]');
  const head = [`<b>${esc(clinicName(db))}</b>`, `<b>Итог дня — ${dayMonth(o.period.to)}, ${weekday(o.period.to)}</b>`].join('\n');
  const foot = '';   // DAILY_REPORT_OWNER_V1 — сравнение уже стоит у итога («к вчера»)
  // Блоки добавляются целиком, пока влезают: обрезка посреди текста могла бы
  // разрезать тег <b>, и Telegram отказал бы во ВСЁМ сообщении.
  let body = '';
  for (const k of keys) {
    const fn = BLOCKS[k];
    const blk = fn ? fn(o, b) : null;
    if (!blk || !blk.lines || !blk.lines.length) continue;
    const block = `\n\n<b>${blk.title || SECTION_TITLES[k]}</b>\n` + blk.lines.join('\n');
    if ((head + body + block + foot).length > TG_LIMIT) { body += '\n\n…'; break; }
    body += block;
  }
  return { day: o.period.to, text: head + body + foot };
}
