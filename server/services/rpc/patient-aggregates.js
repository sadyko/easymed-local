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
//   • визиты — все строки `visits` пациента, включая отменённые: картотека
//     отвечает на вопрос «человек у нас бывал?», а не «сколько раз дошёл»;
//   • последний визит — самая поздняя дата визита (её же показывает карта);
//   • баланс — ОПЛАЧЕНО МИНУС ВЫСТАВЛЕНО по счетам пациента, минус значит долг.
//     Отменённые и возвращённые счета не в счёт: денег по ним не ждут (то же
//     правило, что в журнале госпитализаций, DEBT_FLOW_V1);
//   • страховка и её вид — из справочника плательщиков по patients.payer_id;
//   • регистратор — ФИО того, кто завёл карту (users.full_name по created_by).
import { RpcError } from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';

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

  return db.prepare(`
    SELECT p.id AS patient_id,
           (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id) AS visit_count,
           (SELECT MAX(v.visit_date) FROM visits v WHERE v.patient_id = p.id) AS last_visit,
           (SELECT COALESCE(SUM(i.paid_amount - i.total_amount), 0) FROM invoices i
             WHERE i.patient_id = p.id AND i.status NOT IN ('void', 'refunded')) AS balance,
           py.name AS insurer,
           py.kind AS payer_type,
           u.full_name AS registrar
      FROM patients p
      LEFT JOIN payers py ON py.id = p.payer_id
      LEFT JOIN users  u  ON u.id  = p.created_by
     WHERE p.id IN (${holes})`).all(...use).map((r) => ({
    ...r,
    visit_count: Number(r.visit_count) || 0,
    balance: round2(r.balance),
    insurer: r.insurer || '',
    payer_type: r.payer_type || '',
    registrar: r.registrar || '',
  }));
}
