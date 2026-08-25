// CUSTDEV_V1 — два запроса на чтение: доска и отчёт.
//
// JOIN здесь, а не embed в /api/db, потому что custdev_cards намеренно нет в
// schema-registry.js: реестр раздаёт права по жёстко зашитому списку ролей, а
// доступ к Cust Dev выдаётся галочкой в «Настройки → Роли».

import { localDate } from '../domain/day.js';

// Столько карточек доска читает за раз — как 800 заявок в CRM. Доска это
// рабочая очередь, а не архив.
const MAX_ROWS = 1000;

const pct = (part, total) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

/**
 * Карточки периода с ЖИВЫМИ данными пациента и именами сотрудников.
 * Телефон и ФИО не снимок: если пациент исправил номер, звонить надо по новому.
 */
export function listCards(db, { from, to } = {}) {
  return db.prepare(`
    SELECT c.*,
           p.full_name AS patient_name, p.mrn AS mrn, p.phone AS phone,
           r.full_name AS registrar_name,
           k.full_name AS cashier_name,
           d.full_name AS doctor_name,
           cb.full_name AS called_by_name
      FROM custdev_cards c
      JOIN patients p ON p.id = c.patient_id
      LEFT JOIN users r  ON r.id  = c.registrar_id
      LEFT JOIN users k  ON k.id  = c.cashier_id
      LEFT JOIN users d  ON d.id  = c.doctor_id
      LEFT JOIN users cb ON cb.id = c.called_by
     WHERE ${localDate('c.visit_date')} BETWEEN date(?) AND date(?)
     ORDER BY c.visit_date DESC, c.id DESC
     LIMIT ${MAX_ROWS}
  `).all(from, to);
}

// Разрез по одному сотруднику. 'na' и 'unrated' не попадают ни в числитель, ни
// в знаменатель: иначе лабораторный визит без врача портил бы статистику врача,
// которого там не было.
//
// idColumn и scoreColumn подставляются в SQL текстом — обычно это ровно то, что
// в проекте запрещено. Здесь и ТОЛЬКО здесь это безопасно, потому что оба
// аргумента приходят литералами из этого же файла и никогда из запроса. Не
// расширять функцию до колонки «от вызывающего».
function byStaff(db, idColumn, scoreColumn, from, to) {
  const rows = db.prepare(`
    SELECT c.${idColumn} AS id,
           u.full_name   AS name,
           SUM(c.${scoreColumn} = 'good') AS good,
           SUM(c.${scoreColumn} = 'bad')  AS bad
      FROM custdev_cards c
      JOIN users u ON u.id = c.${idColumn}
     WHERE ${localDate('c.visit_date')} BETWEEN date(?) AND date(?)
       AND c.${scoreColumn} IN ('good','bad')
     GROUP BY c.${idColumn}, u.full_name
     ORDER BY u.full_name
  `).all(from, to);

  return rows.map((r) => ({ ...r, pct: pct(r.good, r.good + r.bad) }));
}

/** Всё, что показывает экран «Отчёт». */
export function reportFor(db, { from, to } = {}) {
  const k = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(status <> 'new')        AS called,
           SUM(status = 'satisfied')   AS satisfied,
           SUM(status = 'partial')     AS partial,
           SUM(status = 'unsatisfied') AS unsatisfied,
           SUM(status = 'unreachable') AS unreachable
      FROM custdev_cards
     WHERE ${localDate('visit_date')} BETWEEN date(?) AND date(?)
  `).get(from, to);

  const total = k.total || 0;
  const called = k.called || 0;

  return {
    total,
    called,
    calledPct: pct(called, total),
    satisfied: k.satisfied || 0,
    partial: k.partial || 0,
    unsatisfied: k.unsatisfied || 0,
    unreachable: k.unreachable || 0,
    byRegistrar: byStaff(db, 'registrar_id', 'score_registrar', from, to),
    byCashier:   byStaff(db, 'cashier_id',   'score_cashier',   from, to),
    byDoctor:    byStaff(db, 'doctor_id',    'score_doctor',    from, to),
  };
}
