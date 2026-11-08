// LAST_VISIT_TRUE_V1 (2026-11-02) — «ПОСЛЕДНИЙ ВИЗИТ», «БЛИЖАЙШАЯ ЗАПИСЬ» И
// «ВИЗИТОВ» — ОДНО ПРАВИЛО НА ВСЕ ЭКРАНЫ.
//
// Было три копии одного неверного определения: картотека
// (rpc/patient-aggregates.js), карта пациента (rpc/patient-card.js) и
// подключённые пациенты Telegram-бота (rpc/telegram.js) брали MAX(visit_date)
// и COUNT(*) по ВСЕМ визитам. Будущая запись — в том числе пустая, которую
// автоперенос поставил на завтра, — выигрывала у настоящего приёма, а
// отменённые и неявки считались «визитами».
//
// Правило (решение владельца, выпуск 3.21.0):
//   • состоявшийся визит — статус не «отменён» и не «не пришёл», и МЕСТНЫЙ
//     день визита ≤ сегодня клиники (domain/day.js — тот же 'localtime', что у
//     отчётов: приём в 00:30 по Ташкенту хранится как 19:30Z накануне);
//   • LAST_VISIT_TRUE_V1 (ревью, minor-1) — прошедший день состоялся только с
//     ДОКАЗАТЕЛЬСТВОМ ПРИХОДА. Отметку «Не пришёл» в клинике не ставит никто
//     (crm/no-show.js двигает только карточку CRM), «Пришёл» нажимают редко
//     (на боевой базе все 390 визитов 'scheduled' при 389 оплаченных счетах —
//     crm/visit-status.js): пустая запись, перенесённая автоматикой на
//     воскресенье, наутро становилась «Последним визитом». Теперь:
//       – визит СЕГОДНЯШНЕГО дня — состоялся (пациент ещё может прийти);
//       – визит ПРОШЕДШЕГО дня — если он «Пришёл» (status 'arrived'), или у
//         него есть строка в работе либо отпущенная кассой (WORKED_LINE_STATUSES:
//         'queued' ставят оплата, долг, нулевой счёт и счёт плательщику;
//         дальше — проба, приём, результат, выдача), или по счёту визита
//         есть оплата (invoices.paid_amount > 0 — как у arrivedByEvidence CRM;
//         полный возврат обнуляет её и отменяет счёт);
//       – будущий визит не состоялся никогда.
//     Строка «в смете» ('added') и неоплаченный счёт доказательством не
//     являются: их заводят и при записи по телефону;
//   • LAST_VISIT_TRUE_V1 (полировка 3.21.0, п. 16) — ВОЗВРАТ: счёт, который
//     вернули целиком и отменили, оплаты больше не несёт (paid_amount = 0), и
//     прошедший визит с таким счётом выпадает из «Последнего визита» и из числа
//     визитов, если он не «Пришёл» и ни одна его строка не в работе
//     (WORKED_LINE_STATUSES). Пришедший или начатый — остаётся состоявшимся;
//   • «визитов» — число состоявшихся;
//   • «последний визит» — самый поздний состоявшийся;
//   • «ближайшая запись» — самый ранний такой же визит ПОСЛЕ сегодняшнего дня.
// Визиты всех зданий считаются: картотека клиники общая (PATIENTS_CLINIC_WIDE_V1).
// Пустые будущие записи не удаляются — их видно в календаре; здесь они просто
// перестают быть «последним визитом».
//
// Время возвращается нормализованным ISO UTC ('…T…Z', через julianday): в базе
// лежат и '…:00Z', и '…:00.000Z', и строковый MAX между ними не всегда честен.
import { localDate, today as clinicToday } from './day.js';

export const NOT_HAPPENED_STATUSES = Object.freeze(['cancelled', 'no_show']);
// LAST_VISIT_TRUE_V1 (ревью, minor-1) — статусы строки визита, которые бывают
// только после кассы или работы над пациентом (машина состояний — миграция 041:
// added → queued → collected → in_progress → resulted → completed).
export const WORKED_LINE_STATUSES = Object.freeze(['queued', 'collected', 'in_progress', 'resulted', 'completed']);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const CHUNK = 500;

const empty = () => ({ visit_count: 0, last_visit: null, last_visit_day: null, next_visit: null, next_visit_day: null });

/**
 * PATIENT_LIST_LAST_VISIT_V1 — правило «состоялся» одним SQL-фрагментом: визиты
 * (не отменённые и не «не пришёл»), у каждого — pid, jd (julianday), d (местный
 * день) и ok (1 — состоялся по правилу выше). Им пользуются эта сводка и
 * картотека (rpc/patient-list.js: сортировка и отбор по последнему визиту) —
 * одно определение, а не две копии, которые разойдутся с первой же правкой.
 *
 * Параметры фрагмента — ДВА раза сегодня клиники ('YYYY-MM-DD'), затем
 * параметры `where`.
 * @param {string} [where] — условие на v (например, v.patient_id IN (…)).
 */
export function visitsWithHappenedSql(where = '1=1') {
  const local = localDate('v.visit_date');
  const gone = NOT_HAPPENED_STATUSES.map((s) => `'${s}'`).join(', ');
  const worked = WORKED_LINE_STATUSES.map((s) => `'${s}'`).join(', ');
  return `SELECT v.patient_id AS pid, julianday(v.visit_date) AS jd, ${local} AS d,
                 CASE WHEN ${local} = ? THEN 1
                      WHEN ${local} > ? THEN 0
                      WHEN v.status = 'arrived' THEN 1
                      WHEN EXISTS (SELECT 1 FROM visit_services vs
                                    WHERE vs.visit_id = v.id AND vs.status IN (${worked})) THEN 1
                      WHEN EXISTS (SELECT 1 FROM invoices iv
                                    WHERE iv.visit_id = v.id AND iv.paid_amount > 0) THEN 1
                      ELSE 0 END AS ok
            FROM visits v
           WHERE (${where})
             AND v.status NOT IN (${gone})`;
}

/**
 * Визиты пациентов по правилу выше, одним запросом на пачку.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<number|string>} patientIds
 * @param {{ today?: string }} [opts] today — местный 'YYYY-MM-DD' (для тестов);
 *        по умолчанию — сегодня клиники (domain/day.js today).
 * @returns {Map<number, { visit_count: number, last_visit: string|null,
 *   last_visit_day: string|null, next_visit: string|null, next_visit_day: string|null }>}
 *   ключ — id пациента; у пациента без визитов — нули и null.
 */
export function patientVisitSummary(db, patientIds, { today = null } = {}) {
  const ids = [...new Set((Array.isArray(patientIds) ? patientIds : []).map(Number)
    .filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map(ids.map((id) => [id, empty()]));
  if (!ids.length) return out;
  const day = today == null ? clinicToday(db) : String(today);
  if (!YMD.test(day)) throw new Error('patientVisitSummary: today must be YYYY-MM-DD, got ' + day);
  // LAST_VISIT_TRUE_V1 (ревью, minor-1) — «состоялся» ОПИСАН один раз
  // (внутренний SELECT, колонка ok). LAST_VISIT_TRUE_V1 (полировка, п. 16) — но
  // SQLite разворачивает этот подзапрос во внешний, и выражение ok с его EXISTS
  // вычисляется на каждое упоминание: SUM(ok) и MAX(CASE WHEN ok = 1 …) — дважды
  // на визит. Цена — та же пара EXISTS по индексам idx_visit_services_visit и
  // idx_invoices_visit, и только у прошедших дней без «Пришёл» (CASE
  // останавливается на первой подошедшей ветке: сегодня, будущее и «Пришёл»
  // решаются без запросов).
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rows = db.prepare(`
      SELECT pid, happened,
             strftime('%Y-%m-%dT%H:%M:%SZ', last_jd) AS last_visit,
             ${localDate('last_jd')}                  AS last_visit_day,
             strftime('%Y-%m-%dT%H:%M:%SZ', next_jd) AS next_visit,
             ${localDate('next_jd')}                  AS next_visit_day
        FROM (SELECT pid,
                     SUM(ok)                           AS happened,
                     MAX(CASE WHEN ok = 1 THEN jd END) AS last_jd,
                     MIN(CASE WHEN d > ? THEN jd END)  AS next_jd
                FROM (${visitsWithHappenedSql(`v.patient_id IN (${part.map(() => '?').join(', ')})`)})
               GROUP BY pid)`).all(day, day, day, ...part);
    for (const r of rows) {
      out.set(Number(r.pid), {
        visit_count: Number(r.happened) || 0,
        last_visit: r.last_visit || null,
        last_visit_day: r.last_visit_day || null,
        next_visit: r.next_visit || null,
        next_visit_day: r.next_visit_day || null,
      });
    }
  }
  return out;
}
