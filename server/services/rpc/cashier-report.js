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
// BUILDING_REPORTS_V1 — здание как измерение; см. шапку domain/buildings.js.
import { buildingContext, buildingWhere, originExpr, summariseByBuilding } from '../domain/buildings.js';

const METHOD_RU = {
  cash: 'Наличные', card: 'Карта', acquiring: 'Эквайринг',
  transfer: 'Перечисление', online: 'Онлайн', debt: 'В долг', other: 'Прочее',
};

const MOVE_RU = {
  collection: 'Инкассация', purchase: 'Закупка', refund: 'Возврат',
  salary: 'Зарплата', other: 'Прочее',
};

const num = (n) => Math.round(Number(n) || 0);

// BUILDING_REPORTS_V1 — расход кассы принадлежит смене, а смены между зданиями
// не передаются. Значит, «Расходы» всегда только свои, и отчёт обязан это
// сказать: пустой расход у соседнего здания иначе читается как «там ничего не
// тратили».
const CASH_MOVE_LOCAL_NOTE = 'Расходы кассы между зданиями не передаются: раздел «Расходы» показывает только это здание.';

// CASHIER_NET_SCOPE_V1 — ЗАГОЛОВОК НЕ СМЕШИВАЕТ ОХВАТЫ.
//
// Когда деньги поехали между зданиями, «Доход» стал считаться ПО ВСЕЙ КЛИНИКЕ
// (платежи путешествуют), а «Расход» остался ТОЛЬКО СВОИМ (cash_movements не
// путешествуют — движение принадлежит смене, а смены не ездят). Итог при этом
// продолжал считаться как «доход − расход», то есть вычитал расход одного дома
// из дохода двух. Такое число не отвечает ни на один вопрос: оно не «сколько
// заработала клиника» (расходы соседа в нём не учтены) и не «сколько осталось в
// моей кассе» (чужой приход в неё не ложился). Чем больше соседнее здание, тем
// красивее выглядела бы эта касса.
//
// Выбрано: ИТОГ СЧИТАЕТСЯ ПО ЭТОМУ ЗДАНИЮ — приход этого здания минус его же
// расход. Обе половины из одного дома, и число сходится с бумажной кассой,
// которую кассир держит в руках. Приход по всей клинике никуда не делся: он
// стоит ОТДЕЛЬНОЙ плиткой и назван своим охватом. Итог каждого здания в
// отдельности считается в разрезе by_building ниже (там расход есть только у
// своего — по той же причине, и это видно).
//
// Второй вариант («итог по клинике из того, что ездит») отвергнут: он потребовал
// бы объявить расходы нулём у всех соседей, то есть напечатать выдуманную цифру
// вместо отсутствующей.
const NET_SCOPE_NOTE = 'Итог считается ПО ЭТОМУ ЗДАНИЮ: приход этого здания минус его расход. Доход по всей клинике показан отдельной плиткой — вычитать из него местный расход нельзя, движения кассы между зданиями не передаются.';

// Кассир приехавшего платежа неизвестен: карточки сотрудников между зданиями
// не передаются (cashier_id приезжает пустым). Подписываем строку зданием —
// прятать её нельзя, это настоящие деньги.
function cashierCell(ctx, r) {
  if (r.cashier && r.cashier !== '—') return r.cashier;
  return ctx.keyOf(r.origin) === ctx.ownKey ? '—' : ctx.label(r.origin);
}

export function cashierReport(db, args, _user) {
  const a = args || {};
  const from = String(a.from || '').slice(0, 10);
  const to = String(a.to || '').slice(0, 10);

  // Филиал живёт на СЧЁТЕ, а не на платеже. Пустой список = все филиалы:
  // так же ведут себя остальные отчёты (см. reports.js), и «ничего не выбрано»
  // не должно означать «ничего не показывать».
  const branchIds = Array.isArray(a.branch_ids) ? a.branch_ids.map(Number).filter(Boolean) : [];
  const branchSql = branchIds.length ? ` AND i.branch_id IN (${branchIds.map(() => '?').join(',')})` : '';

  // BUILDING_REPORTS_V1 — ЗДАНИЕ, а не филиал внутри базы. Фильтр по
  // `i.branch_id` у приехавшего платежа не совпадал ни с чем (branch_id не
  // путешествует и приезжает пустым), поэтому касса соседнего здания отдавала
  // ПУСТО. Здание берётся у САМОГО ПЛАТЕЖА: деньги принял тот, у кого они
  // физически легли в кассу, и метка на платеже — единственное, что об этом
  // знает.
  const ctx = buildingContext(db);
  const gf = buildingWhere(db, ctx, args, 'payments', 'p');
  const payOrigin = originExpr(db, 'payments', 'p');
  // Движения кассы (cash_movements) между зданиями не передаются — они всегда
  // свои. Фильтр это учитывает: «только соседнее здание» вернёт пусто, а не
  // чужие расходы под чужим именем.
  const gfm = buildingWhere(db, ctx, args, 'cash_movements', 'm');
  const moveOrigin = originExpr(db, 'cash_movements', 'm');

  // ---- Поступления -------------------------------------------------------
  //
  // Строка = ОДИН платёж. Услуги и врачи склеиваются через « · », как в чеке:
  // один платёж закрывает счёт целиком, и разносить его по услугам значило бы
  // придумывать, какая часть денег за какую услугу — этого в данных нет.
  const income = db.prepare(`
    SELECT p.id, p.amount, p.method, ${payOrigin} AS origin, ${localDate('p.paid_at')} AS day,
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
     WHERE ${inLocalRange('p.paid_at')}${branchSql}${gf.clause}
     ORDER BY origin, p.paid_at DESC`).all(from, to, ...branchIds, ...gf.params);

  // ---- Расходы -----------------------------------------------------------
  //
  // Филиал берём у СМЕНЫ: у движения кассы своего филиала нет, оно
  // принадлежит смене, а смена — филиалу.
  const moveBranchSql = branchIds.length ? ` AND sh.branch_id IN (${branchIds.map(() => '?').join(',')})` : '';
  const expense = db.prepare(`
    SELECT m.id, m.amount, m.article, m.note, ${moveOrigin} AS origin, ${localDate('m.created_at')} AS day,
           strftime('%H:%M', m.created_at, 'localtime') AS at,
           COALESCE(u.full_name, '—') AS author
      FROM cash_movements m
      LEFT JOIN cash_shifts sh ON sh.id = m.shift_id
      LEFT JOIN users u        ON u.id = m.created_by
     WHERE m.kind = 'out' AND ${inLocalRange('m.created_at')}${moveBranchSql}${gfm.clause}
     ORDER BY origin, m.created_at DESC`).all(from, to, ...branchIds, ...gfm.params);

  const incomeTotal = income.reduce((n, r) => n + num(r.amount), 0);
  const expenseTotal = expense.reduce((n, r) => n + num(r.amount), 0);
  // CASHIER_NET_SCOPE_V1 — приход ЭТОГО здания: вторая половина итога, у которой
  // тот же охват, что и у расхода. См. NET_SCOPE_NOTE выше.
  const ownIncomeTotal = income.reduce(
    (n, r) => n + (ctx.keyOf(r.origin) === ctx.ownKey ? num(r.amount) : 0), 0);
  // Клинике в одном здании ничего этого показывать не надо: «доход по клинике»
  // и «доход этого здания» у неё одно и то же число, и две плитки вместо одной
  // читались бы как поломка.
  const multiBuilding = ctx.options.length > 1;

  const incomeColumns = ['Здание', 'Дата', 'Услуга', 'Врач', 'Пациент', 'Способ оплаты', 'Сумма', 'Счёт', 'Кассир'];
  const incomeRows = income.map((r) => [
    ctx.label(r.origin), r.day + ' ' + (r.at || ''), r.services || '—', r.doctors || '—', r.patient,
    METHOD_RU[r.method] || r.method || '—', num(r.amount), r.invoice_no || '—', cashierCell(ctx, r),
  ]);

  // Колонки «Комментарий» здесь нет намеренно: у движения кассы всего два
  // текстовых поля — article (статья) и note (на что именно). Они уже заняты
  // «Типом расхода» и «На что»; третья колонка могла бы только повторить одно
  // из них, а пустая графа в отчёте читается как потерянные данные.
  const expenseColumns = ['Здание', 'Дата', 'На что', 'Тип расхода', 'Сумма', 'Провёл'];
  const expenseRows = expense.map((r) => [
    ctx.label(r.origin), r.day + ' ' + (r.at || ''), r.note || r.article || '—',
    MOVE_RU[r.article] || r.article || '—', num(r.amount), r.author,
  ]);

  // Плоская выгрузка для кнопки «Скачать Excel» наверху: один лист, где
  // видно и приход, и расход — иначе владельцу пришлось бы качать два файла
  // и сводить их руками.
  // Плоская выгрузка для кнопки «Скачать Excel» наверху: один лист, где виден
  // и приход, и расход — иначе владельцу пришлось бы качать два файла и
  // сводить их руками. Расход пишется со знаком минус: в одном столбце «Сумма»
  // приход и расход обязаны складываться в итог, а не спорить друг с другом.
  const columns = ['Здание', 'Тип', 'Дата', 'Назначение', 'Врач / тип', 'Пациент', 'Способ оплаты', 'Сумма', 'Счёт', 'Провёл'];
  const rows = [
    ...income.map((r) => [ctx.label(r.origin), 'Поступление', r.day + ' ' + (r.at || ''), r.services || '—',
      r.doctors || '—', r.patient, METHOD_RU[r.method] || r.method || '—', num(r.amount),
      r.invoice_no || '—', cashierCell(ctx, r)]),
    ...expense.map((r) => [ctx.label(r.origin), 'Расход', r.day + ' ' + (r.at || ''), r.note || r.article || '—',
      MOVE_RU[r.article] || r.article || '—', '', '', -num(r.amount), '', r.author]),
  ];

  // Разрез по зданиям: приход, расход и итог у каждого — и итог по клинике
  // сверху. Одно число на два дома не сходится ни с одной бумажной кассой.
  const by_building = summariseByBuilding(
    ctx,
    [...income.map((r) => ({ origin: r.origin, inc: num(r.amount), exp: 0 })),
     ...expense.map((r) => ({ origin: r.origin, inc: 0, exp: num(r.amount) }))],
    { income: (r) => r.inc, expense: (r) => r.exp },
  ).map((b) => ({ ...b, net: b.income - b.expense }));

  return {
    kpi: {
      // Приход ПО ВСЕЙ КЛИНИКЕ: платежи между зданиями ездят.
      income: incomeTotal,
      // Приход ЭТОГО здания — половина итога с тем же охватом, что и расход.
      income_own: ownIncomeTotal,
      // Расход ТОЛЬКО ЭТОГО здания: движения кассы не ездят.
      expense: expenseTotal,
      // CASHIER_NET_SCOPE_V1 — обе части из одного дома, см. NET_SCOPE_NOTE.
      net: ownIncomeTotal - expenseTotal,
      net_scope: 'own_building',
      multi_building: multiBuilding,
    },
    income: { columns: incomeColumns, rows: incomeRows, total: incomeTotal },
    expense: { columns: expenseColumns, rows: expenseRows, total: expenseTotal },
    by_building,
    notes: multiBuilding ? [CASH_MOVE_LOCAL_NOTE, NET_SCOPE_NOTE] : [CASH_MOVE_LOCAL_NOTE],
    columns, rows,
  };
}
