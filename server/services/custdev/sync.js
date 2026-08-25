// CUSTDEV_V1 — материализация карточек.
//
// Никакой фоновой работы и НИ ОДНОЙ правки в денежном коде: доска при открытии
// один раз досоздаёт то, чего не хватает. Прецедент такого «подмета при
// загрузке» в проекте уже есть — авто-no_show в views/crm.js.
//
// Идемпотентность держится не на аккуратности этого запроса, а на
// UNIQUE(visit_id) в миграции 078 плюс NOT EXISTS здесь.

import { localDate, today } from '../domain/day.js';

// Глубина первичного подмёта. В клинике с двухлетней историей без ограничения
// первое открытие доски создало бы десятки тысяч карточек «Не обзвонён» —
// очередь, которую никто никогда не разберёт.
export const BACKFILL_DAYS = 90;

/**
 * Создаёт недостающие карточки за пересечение периода с последними 90 днями.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{from?: string, to?: string}} window — местные 'YYYY-MM-DD'
 * @returns {number} сколько карточек создано
 */
export function syncCards(db, { from, to } = {}) {
  const t = today(db);
  const floor = db.prepare("SELECT date(?, '-' || ? || ' days') d").get(t, String(BACKFILL_DAYS)).d;

  const start = from && from > floor ? from : floor;
  const end = to && to < t ? to : t;
  if (start > end) return 0;

  // visits.visit_date хранит ПОЛНЫЙ UTC-момент (new Date().toISOString() в
  // doctor-room.js и room-calendar.js), а не голую дату. Поэтому сравниваем
  // через localDate(): на UTC+5 вечерний визит по UTC-срезу оказался бы
  // завтрашним и карточка появилась бы на день позже. Правило day.js: никто не
  // пишет date('now') или date(col) своими руками.
  const info = db.prepare(`
    INSERT INTO custdev_cards
           (visit_id, patient_id, visit_date, paid_amount, registrar_id, cashier_id, doctor_id)
    SELECT v.id,
           v.patient_id,
           v.visit_date,
           (SELECT COALESCE(SUM(i.paid_amount), 0) FROM invoices i WHERE i.visit_id = v.id),
           -- Смету составляет регистратура: автор ПЕРВОГО счёта визита.
           (SELECT i.created_by FROM invoices i WHERE i.visit_id = v.id ORDER BY i.id LIMIT 1),
           -- Кассир — тот, кто принял ПОСЛЕДНИЙ платёж: при доплате пациент
           -- разговаривал именно с ним.
           (SELECT p.cashier_id FROM payments p
              JOIN invoices i ON i.id = p.invoice_id
             WHERE i.visit_id = v.id ORDER BY p.id DESC LIMIT 1),
           -- У лабораторного визита своего врача нет — берём из услуг.
           COALESCE(v.doctor_id,
                    (SELECT vs.doctor_id FROM visit_services vs
                      WHERE vs.visit_id = v.id AND vs.doctor_id IS NOT NULL
                      ORDER BY vs.id LIMIT 1))
      FROM visits v
     WHERE v.status = 'arrived'
       AND ${localDate('v.visit_date')} BETWEEN date(?) AND date(?)
       AND ${localDate('v.visit_date')} < date(?)
       AND EXISTS (SELECT 1 FROM invoices i
                    WHERE i.visit_id = v.id
                      AND i.paid_amount > 0
                      AND i.status IN ('paid','partial'))
       AND NOT EXISTS (SELECT 1 FROM custdev_cards c WHERE c.visit_id = v.id)
  `).run(start, end, t);

  return info.changes;
}
