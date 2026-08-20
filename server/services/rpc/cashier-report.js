// CASHIER_REPORT_V1 — «Отчёты → Отчёт кассира».
//
// Полная картина работы кассы за период: сколько денег пришло, сколько ушло и
// что стоит за каждой строкой. Отличается от сменного X-отчёта («Касса →
// Смены») тем, что смотрит НЕ на смену, а на период: владелец спрашивает «что
// было за месяц», а не «что в кассе у Юлдашевой прямо сейчас».
//
// Доход — это ПЛАТЕЖИ (payments), а не выставленные счета: выставленный и
// неоплаченный счёт денег в кассу не принёс, и складывать его с наличными
// значит показать доход, которого нет. Расход — движения кассы наружу
// (cash_movements kind='out'): инкассация, закупка на месте, возврат.
//
// Время местное (domain/day.js): платёж в 23:40 при UTC+5 иначе попал бы в
// следующие сутки, и суточная касса не сошлась бы с бумажной.

import { localDate, inLocalRange } from '../domain/day.js';

const METHOD_RU = {
  cash: 'Наличные', card: 'Карта', acquiring: 'Эквайринг',
  transfer: 'Перечисление', online: 'Онлайн', debt: 'В долг', other: 'Прочее',
};

const MOVE_RU = {
  collection: 'Инкассация', purchase: 'Закупка', refund: 'Возврат',
  salary: 'Зарплата', other: 'Прочее',
};

const num = (n) => Math.round(Number(n) || 0);

export function cashierReport(db, args, _user) {
  const a = args || {};
  const from = String(a.from || '').slice(0, 10);
  const to = String(a.to || '').slice(0, 10);

  // Филиал живёт на СЧЁТЕ, а не на платеже. Пустой список = все филиалы:
  // так же ведут себя остальные отчёты (см. reports.js), и «ничего не выбрано»
  // не должно означать «ничего не показывать».
  const branchIds = Array.isArray(a.branch_ids) ? a.branch_ids.map(Number).filter(Boolean) : [];
  const branchSql = branchIds.length ? ` AND i.branch_id IN (${branchIds.map(() => '?').join(',')})` : '';

  // ---- Поступления -------------------------------------------------------
  //
  // Строка = ОДИН платёж. Услуги и врачи склеиваются через « · », как в чеке:
  // один платёж закрывает счёт целиком, и разносить его по услугам значило бы
  // придумывать, какая часть денег за какую услугу — этого в данных нет.
  const income = db.prepare(`
    SELECT p.id, p.amount, p.method, ${localDate('p.paid_at')} AS day,
           strftime('%H:%M', p.paid_at, 'localtime') AS at,
           COALESCE(i.invoice_number, '') AS invoice_no,
           COALESCE(pat.full_name, '—')   AS patient,
           COALESCE(cash.full_name, '—')  AS cashier,
           (SELECT group_concat(x.name, ' · ') FROM (
              SELECT DISTINCT COALESCE(s.name, ii.description, 'Услуга') AS name
                FROM invoice_items ii LEFT JOIN services s ON s.id = ii.service_id
               WHERE ii.invoice_id = i.id) x)                     AS services,
           (SELECT group_concat(y.name, ' · ') FROM (
              SELECT DISTINCT u.full_name AS name
                FROM visit_services vs JOIN users u ON u.id = vs.doctor_id
               WHERE vs.visit_id = i.visit_id AND vs.doctor_id IS NOT NULL) y) AS doctors
      FROM payments p
      LEFT JOIN invoices i  ON i.id = p.invoice_id
      LEFT JOIN patients pat ON pat.id = i.patient_id
      LEFT JOIN users cash   ON cash.id = p.cashier_id
     WHERE ${inLocalRange('p.paid_at')}${branchSql}
     ORDER BY p.paid_at DESC`).all(from, to, ...branchIds);

  // ---- Расходы -----------------------------------------------------------
  //
  // Филиал берём у СМЕНЫ: у движения кассы своего филиала нет, оно
  // принадлежит смене, а смена — филиалу.
  const moveBranchSql = branchIds.length ? ` AND sh.branch_id IN (${branchIds.map(() => '?').join(',')})` : '';
  const expense = db.prepare(`
    SELECT m.id, m.amount, m.article, m.note, ${localDate('m.created_at')} AS day,
           strftime('%H:%M', m.created_at, 'localtime') AS at,
           COALESCE(u.full_name, '—') AS author
      FROM cash_movements m
      LEFT JOIN cash_shifts sh ON sh.id = m.shift_id
      LEFT JOIN users u        ON u.id = m.created_by
     WHERE m.kind = 'out' AND ${inLocalRange('m.created_at')}${moveBranchSql}
     ORDER BY m.created_at DESC`).all(from, to, ...branchIds);

  const incomeTotal = income.reduce((n, r) => n + num(r.amount), 0);
  const expenseTotal = expense.reduce((n, r) => n + num(r.amount), 0);

  const incomeColumns = ['Дата', 'Услуга', 'Врач', 'Пациент', 'Способ оплаты', 'Сумма', 'Счёт', 'Кассир'];
  const incomeRows = income.map((r) => [
    r.day + ' ' + (r.at || ''), r.services || '—', r.doctors || '—', r.patient,
    METHOD_RU[r.method] || r.method || '—', num(r.amount), r.invoice_no || '—', r.cashier,
  ]);

  // Колонки «Комментарий» здесь нет намеренно: у движения кассы всего два
  // текстовых поля — article (статья) и note (на что именно). Они уже заняты
  // «Типом расхода» и «На что»; третья колонка могла бы только повторить одно
  // из них, а пустая графа в отчёте читается как потерянные данные.
  const expenseColumns = ['Дата', 'На что', 'Тип расхода', 'Сумма', 'Провёл'];
  const expenseRows = expense.map((r) => [
    r.day + ' ' + (r.at || ''), r.note || r.article || '—',
    MOVE_RU[r.article] || r.article || '—', num(r.amount), r.author,
  ]);

  // Плоская выгрузка для кнопки «Скачать Excel» наверху: один лист, где
  // видно и приход, и расход — иначе владельцу пришлось бы качать два файла
  // и сводить их руками.
  // Плоская выгрузка для кнопки «Скачать Excel» наверху: один лист, где виден
  // и приход, и расход — иначе владельцу пришлось бы качать два файла и
  // сводить их руками. Расход пишется со знаком минус: в одном столбце «Сумма»
  // приход и расход обязаны складываться в итог, а не спорить друг с другом.
  const columns = ['Тип', 'Дата', 'Назначение', 'Врач / тип', 'Пациент', 'Способ оплаты', 'Сумма', 'Счёт', 'Провёл'];
  const rows = [
    ...income.map((r) => ['Поступление', r.day + ' ' + (r.at || ''), r.services || '—', r.doctors || '—',
      r.patient, METHOD_RU[r.method] || r.method || '—', num(r.amount), r.invoice_no || '—', r.cashier]),
    ...expense.map((r) => ['Расход', r.day + ' ' + (r.at || ''), r.note || r.article || '—',
      MOVE_RU[r.article] || r.article || '—', '', '', -num(r.amount), '', r.author]),
  ];

  return {
    kpi: { income: incomeTotal, expense: expenseTotal, net: incomeTotal - expenseTotal },
    income: { columns: incomeColumns, rows: incomeRows, total: incomeTotal },
    expense: { columns: expenseColumns, rows: expenseRows, total: expenseTotal },
    columns, rows,
  };
}
