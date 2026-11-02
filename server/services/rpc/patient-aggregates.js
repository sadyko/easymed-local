// PATIENT_AGGREGATES_V1 (2026-09-16) — ЧИСЛА В КАРТОТЕКЕ: ВИЗИТЫ, ПОСЛЕДНИЙ
// ВИЗИТ, БАЛАНС, СТРАХОВКА, РЕГИСТРАТОР.
//
// Картотека пациентов показывает у каждой строки «визитов: N», дату последнего
// визита, баланс и того, кто завёл карту. Все эти числа экран спрашивал одним
// вызовом `patient_base_aggregates` — а такого RPC на сервере не было ВООБЩЕ:
// в ответ приходило 501, экран молча глотал отказ (`catch` вокруг вызова), и в
// картотеке у КАЖДОГО пациента стояло «визитов не было» и «0 сум». Ни одной
// жалобы это не вызвало именно потому, что выглядело как правда.
//
// Один запрос на страницу списка (30 строк), а не по запросу на строку: список
// листают быстро, и N+1 здесь стоил бы секунды на каждом нажатии.
//
// ЧТО СЧИТАЕТСЯ И ПОЧЕМУ ИМЕННО ТАК:
//   • LAST_VISIT_TRUE_V1 (3.21.0) — визиты, последний визит и ближайшая
//     запись — по одному правилу domain/visit-summary.js (то же у карты
//     пациента и бота): считаются только СОСТОЯВШИЕСЯ визиты (не отменён, не
//     «не пришёл», местный день ≤ сегодня); будущая запись — отдельным полем
//     next_visit, а не «последним визитом». Прежде визитами были все строки
//     `visits`, а последним — MAX(visit_date): будущая запись выигрывала;
//   • registration_day — МЕСТНЫЙ день регистрации: его картотека пишет, когда
//     состоявшихся визитов нет (раньше браузер резал ISO до дня UTC);
//   • V3120_FIX (MINOR) — баланс — ДЕНЬГИ НА БАЛАНСЕ пациента (депозит,
//     зачисления, кэшбэк: domain/wallet.js walletBalance — та же цифра, что в
//     карточке), а долг — отдельным полем debt: невыплаченное по живым счетам
//     (неоплачен / частично / долг; счёт плательщика — долг плательщика, не
//     пациента, и сюда не входит). Прежде «баланс» был «оплачено минус
//     выставлено» по счетам: депозит в нём не виден вовсе, а пациент с
//     депозитом и неоплаченным счётом выглядел просто должником. net_balance —
//     прежняя знаковая цифра (баланс минус долг) для экранов, которые ещё
//     рисуют одно число;
//   • страховка и её вид — из справочника плательщиков по patients.payer_id;
//   • регистратор — ФИО того, кто завёл карту (users.full_name по created_by).
import { RpcError } from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';
import { walletBalance } from '../domain/wallet.js';   // V3120_FIX
import { outstandingWhere } from '../domain/money.js';
import { localDate } from '../domain/day.js';   // LAST_VISIT_TRUE_V1 — местный день регистрации
import { patientVisitSummary } from '../domain/visit-summary.js';   // LAST_VISIT_TRUE_V1

// Кто видит картотеку, тот видит и её числа: отдельного права у них нет.
const AGGREGATE_ROLES = ['admin', 'registrar', 'doctor', 'head_doctor', 'nurse', 'senior_nurse', 'cashier', 'lab', 'callcenter'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function patientBaseAggregates(db, args, user) {
  if (!hasAnyRole(user, AGGREGATE_ROLES)) throw new RpcError('Картотека пациентов — недоступно вашей роли.', 403);
  const raw = (args && (args.p_ids || args.patient_ids)) || [];
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  // Пустой список — пустой ответ, а не «все пациенты»: экран спрашивает ровно
  // про строки своей страницы.
  if (!ids.length) return [];
  // Ограничение на всякий случай: страница картотеки — это десятки строк.
  const use = ids.slice(0, 500);
  const holes = use.map(() => '?').join(',');
  const visitsOf = patientVisitSummary(db, use);   // LAST_VISIT_TRUE_V1

  return db.prepare(`
    SELECT p.id AS patient_id,
           ${localDate("COALESCE(NULLIF(p.registration_date, ''), p.created_at)")} AS registration_day,
           (SELECT COALESCE(SUM(MAX(i.total_amount - i.paid_amount, 0)), 0) FROM invoices i
             WHERE i.patient_id = p.id AND i.payer_id IS NULL AND ${outstandingWhere('i.status')}) AS debt,
           py.name AS insurer,
           py.kind AS payer_type,
           u.full_name AS registrar
      FROM patients p
      LEFT JOIN payers py ON py.id = p.payer_id
      LEFT JOIN users  u  ON u.id  = p.created_by
     WHERE p.id IN (${holes})`).all(...use).map((r) => ({
    ...r,
    // LAST_VISIT_TRUE_V1 — состоявшиеся визиты и ближайшая запись (domain/visit-summary.js).
    ...visitsOf.get(Number(r.patient_id)),
    registration_day: r.registration_day || null,
    balance: walletBalance(db, r.patient_id),
    debt: round2(r.debt),
    net_balance: round2(walletBalance(db, r.patient_id) - round2(r.debt)),
    insurer: r.insurer || '',
    payer_type: r.payer_type || '',
    registrar: r.registrar || '',
  }));
}
