// PERMISSION_CATALOG_V1 (2026-09-18) — ЧТО В ПРОГРАММЕ МОЖНО РАЗРЕШИТЬ, ОДНИМ СПИСКОМ.
//
// Владелец: «we need to setup a roles and permissions as they should … by every
// section and every option of the section … also actions like, in the
// stationary, adding prescriptions, adding measurements etc. deleting, view and
// editing options too … so user who assigns the functions and roles understands
// what he's doing».
//
// ЭТОТ ФАЙЛ — ЕДИНСТВЕННЫЙ СПИСОК ПРАВ. Его читают ОБА конца: экран «Роли» рисует
// из него матрицу, а сервер по нему решает, пускать ли (server/services/grants.js).
// Второй копии списка быть не может: она разошлась бы с первой через один
// выпуск, и галочка на экране перестала бы значить то, что проверяет сервер.
//
// ТРИ ЯРУСА. Раздел → окно → действие.
//   раздел   — пункт меню («Стационар»);
//   окно     — вкладка внутри раздела («Заявки», «Койки»);
//   действие — то, что человек ДЕЛАЕТ в окне и что сервер проверяет отдельно
//              («добавляет назначение», «удаляет измерение»).
//
// ЧЕТЫРЕ УРОВНЯ, и у каждого одно значение на всю программу:
//   none   — ничего: раздела нет в меню, действие отказано;
//   view   — видит;
//   edit   — видит и меняет: добавляет, правит, отмечает;
//   delete — всё выше и ещё удаляет.
// Уровни ВЛОЖЕНЫ: delete включает edit, edit включает view. Поэтому у строки
// перечислены только те уровни, которые в ней ЧТО-ТО значат: у окна, где нечего
// удалять, выбора «удаление» нет — иначе это была бы галочка-обманка.
//
// ЧЕСТНОСТЬ. Строка попадает в матрицу только если у неё есть `enforced` —
// имя настоящей проверки на сервере или в оболочке. Тест сверяет: у каждой
// строки проверка есть, и каждая проверка описана здесь. Право, которого код не
// проверяет, показать нельзя: заведующая, поставившая «только просмотр», должна
// получить только просмотр, а не ту же кассу с теми же кнопками.
//
// ГДЕ ИМЕННО ПРОВЕРЯЮТ — говорит приставка, и она обязана быть ПРАВДОЙ:
//   rpc:<имя>    — ворота серверного вызова (services/rpc/…, requireGrant);
//   route:<имя>  — маршрут оболочки (permissions.js isRouteAllowed);
//   client:<имя> — предикат оболочки, и ТОЛЬКО он: сервер этот ключ не читает;
//   db:<таблица> — запись в таблицу через /api/db: у таблицы в реестре
//                  (server/db/schema-registry.js) стоит `write.grant` с этим
//                  ключом, и компилятор запросов пускает того, кому он выдан
//                  (db/write-grant.js, ROLE_REPORTS_SETTINGS_V1). У закрытой
//                  строки (`locked`) это та проверка, что оставляет запись
//                  только администратору;
//   api:<путь>   — REST-маршрут сервера (/api/<путь>, routes/<путь>.js),
//                  ворота которого читают этот ключ (ADMIN_ROWS_GRANTABLE_V1:
//                  «Сотрудники» живут на /api/users, а не на /api/db).
// Приставка client: — предупреждение, а не разрешение писать что угодно: такое
// право закрывает кнопку, но не запрещает действие тому, кто дойдёт до сервера
// другим путём, поэтому у него обязана быть своя серверная опора, названная в
// описании строки.
//
// ИМЕНА. Ключ — латиница через точку: 'inpatient.vitals'. Подписи — по-русски,
// словами клиники, и с описанием, ЧТО именно даёт уровень: человек, который
// раздаёт права, должен понимать последствие каждой галочки, не открывая код.

export const LEVELS = ['none', 'view', 'edit', 'delete'];
export const LEVEL_LABELS = { none: 'Нет', view: 'Просмотр', edit: 'Изменение', delete: 'Удаление' };
const RANK = { none: 0, view: 1, edit: 2, delete: 3 };

/** Даёт ли выданный уровень то, что требуется: 'edit' покрывает 'view'. */
export function levelAllows(have, need) {
  return (RANK[have] || 0) >= (RANK[need] || 0);
}

/**
 * Справочник. У раздела: key, label, desc, levels, windows[], actions[],
 * `legacy` — ключ старой матрицы (permissions.js NAV_MODULES), по которому
 * работают уже существующие ворота, пока они не переведены на новые ключи.
 * У окна/действия: key, label, desc, levels, enforced (что проверяет).
 * ROLE_REPORTS_SETTINGS_V1 — у окна ещё бывают `group` (подзаголовок, под
 * которым экран «Роли» его рисует), `legacyKeys` (см. раздел «Настройки») и
 * `locked` (только администратор: строка видна, выдать её нельзя).
 *
 * ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — бывшие закрытые строки стали
 * выдаваемыми, и у них появились ещё три свойства:
 *   `adminDefault` — ПРАВИЛО ПЕРЕХОДА «только администратор»: пока роль строку
 *                    не настраивала, сервер и оболочка отвечают как вчера —
 *                    администратору да, остальным нет. Экран «Роли» такую
 *                    строку из старых галочек не выводит (иначе первое же
 *                    сохранение роли раздало бы её);
 *   `of`           — у действия «Цены и проценты»: ключ плитки, к которой оно
 *                    относится (матрица рисует его прямо под плиткой);
 *   `moneyColumns` — какие колонки таблиц плитки открывает это действие сверх
 *                    `grantColumns` плитки (db/write-grant.js);
 *   `grantOps`     — у плитки: какие операции над таблицей открывает право,
 *                    если не все (ключ API создаёт только администратор).
 */
export const CATALOG = [
  {
    key: 'patients', label: 'Пациенты', legacy: 'patients',
    desc: 'Картотека клиники: карты, визиты, очередь и календарь записи.',
    levels: ['none', 'view', 'edit', 'delete'],
    levelDesc: {
      view: 'Видит картотеку и карты пациентов.',
      edit: 'Заводит и правит пациентов, записывает на приём.',
      delete: 'Удаляет визит, неоплаченную услугу из сметы и рекомендацию.',
    },
    windows: [
      { key: 'patients.list',     label: 'Список',   desc: 'Картотека и карта пациента.', levels: ['none', 'view'], enforced: 'route:patients' },
      { key: 'patients.queue',    label: 'Очередь',  desc: 'Доска номеров: кто у какого врача, в лаборатории и на процедурах.', levels: ['none', 'view'], enforced: 'route:patients/queue' },
      { key: 'patients.calendar', label: 'Записи',   desc: 'Календарь записи по врачам и кабинетам.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Записывает, переносит и отменяет записи.' }, enforced: 'route:patients/calendar' },
    ],
    actions: [],
  },
  {
    key: 'crm', label: 'CRM · Заявки', legacy: 'crm',
    desc: 'Обращения и лиды, звонки, превращение заявки в пациента.',
    levels: ['none', 'view', 'edit'],
    levelDesc: { view: 'Видит доску заявок.', edit: 'Ведёт заявки: берёт в работу, двигает по воронке, записывает.' },
    // CALLCENTER_OPERATOR_V1 (2026-09-21) — РАБОТА ОПЕРАТОРА СТАЛА СТРОКАМИ МАТРИЦЫ.
    //
    // Доска заявок была ОДНОЙ галочкой, а всё, что оператор на ней делает —
    // журнал звонков, набор номера, запись разговора, заведение карты, — решал
    // код списками ролей ['admin','registrar','callcenter'] (rpc/telephony.js).
    // Выдать это своей роли клиники было нельзя ничем, и отнять у штатной —
    // тоже: заведующая видела «CRM: изменение» и не могла узнать, что за ней
    // ещё и право позвонить и прослушать чужой разговор.
    windows: [
      { key: 'crm.calls', label: 'Звонки и записи разговоров', desc: 'Журнал звонков этого человека в карточке заявки: кто звонил, когда и сколько говорили.', levels: ['none', 'view'], enforced: 'rpc:crm_lead_calls' },
    ],
    actions: [
      { key: 'crm.dial',      label: 'Позвонить пациенту',        desc: 'Набор номера из программы: звонок уходит с ТРУБКИ САМОГО сотрудника (внутренний номер берётся из сессии), поэтому разбор по операторам считает его этому человеку.', levels: ['none', 'edit'], levelDesc: { edit: 'Звонит пациенту из заявки, карты и очереди.' }, enforced: 'rpc:telephony_dial' },
      { key: 'crm.recording', label: 'Прослушать запись',         desc: 'Запись разговора — это голос пациента: видеть строку в журнале и слушать сам разговор это разные права.', levels: ['none', 'edit'], levelDesc: { edit: 'Открывает и слушает записи разговоров.' }, enforced: 'rpc:telephony_call_recording' },
      // Проверка — ОКНО заведения карты в оболочке (permissions.js
      // canCreatePatient), и приставка говорит об этом прямо: сервер ключа
      // `crm.convert` не читает. Его опора другая и не настраиваемая — реестр
      // таблиц (schema-registry.js: вставку в patients делают admin, registrar и
      // callcenter), поэтому выданная строка откроет окно, но роли с другой
      // ОСНОВОЙ сервер сохранить карту всё равно не даст.
      //
      // «Нет» по этой строке ничего не отнимает: право заведения карты даёт ещё
      // и прежний ключ `registration`, и оболочка спрашивает новый ТОЛЬКО как
      // прибавку — иначе первое же сохранение роли на этом экране оставило бы
      // без карт всех, у кого работает прежний ключ.
      { key: 'crm.convert',   label: 'Завести пациента из заявки', desc: 'Превратить обращение в карту пациента, не открывая регистратуру. Открывает то же окно, что «+ Новый пациент»; сохранить карту сервер разрешает регистратуре, колл-центру и администратору.', levels: ['none', 'edit'], levelDesc: { edit: 'Заводит карту пациента из заявки.' }, enforced: 'client:canCreatePatient' },
      // CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — «РУКОВОДИТЕЛЬ КОЛЛ-ЦЕНТРА» ГАЛОЧКОЙ.
      //
      // Оператор видит свои заявки и ничьи (CRM_OWNERSHIP_V1), и до сих пор
      // ВСЮ доску видел только администратор — поэтому руководителю смены
      // нечем было передать заявку заболевшего оператора, кроме админского
      // входа. Эта строка снимает ограничение с любой роли, которой её дали:
      // один ключ читают сужение доски в компиляторе запросов
      // (schema-registry.js crm_requests.scope.allGrant), поиск и проверка
      // дубля (rpc/crm-leads.js), показатели звонков (telephony_operator_stats),
      // слияние дублей (crm_merge_leads) и отчёт колл-центра. Удалять заявки
      // по-прежнему может только администратор.
      { key: 'crm.all',       label: 'Видит все заявки и передаёт их', desc: 'Руководитель колл-центра: видит все карточки, а не только свои и ничьи, передаёт заявку другому оператору, видит звонки каждого оператора и просроченные задачи всей команды, объединяет дубли. Удалять заявки может только администратор.', levels: ['none', 'edit'], levelDesc: { edit: 'Видит и передаёт все заявки, объединяет дубли.' }, enforced: 'rpc:telephony_operator_stats' },
    ],
  },
  // CALLCENTER_OPERATOR_V1 — Cust Dev звонит ТОТ ЖЕ оператор, и до сих пор это
  // право жило только старым ключом раздела (`custdev`), которого в справочнике
  // не было вовсе: экран «Роли» его не рисовал, и выдавался он лишь миграцией
  // 078. Раздел получает строки, а его ворота (rpc/custdev.js) — правило
  // перехода: пока роль ключ не трогала, решает прежняя галочка раздела.
  {
    key: 'custdev', label: 'Cust Dev — обзвон после визита', legacy: 'custdev',
    desc: 'Обзвон тех, кто пришёл и оплатил: как прошло, что улучшить.',
    levels: ['none', 'view', 'edit'],
    levelDesc: { view: 'Видит доску обзвона и отчёт.', edit: 'Оценивает разговоры и отмечает обзвоненных.' },
    windows: [
      { key: 'custdev.list', label: 'Доска обзвона', desc: 'Кого звонить: визит, услуги, телефон, что уже сказали.', levels: ['none', 'view'], enforced: 'rpc:custdev_list' },
    ],
    actions: [
      { key: 'custdev.rate', label: 'Оценить разговор', desc: 'Оценки по итогам звонка и заметка — из них собирается отчёт.', levels: ['none', 'edit'], levelDesc: { edit: 'Ставит оценки и пишет заметку.' }, enforced: 'rpc:custdev_rate' },
    ],
  },
  {
    key: 'doctor', label: 'Кабинет врача', legacy: 'consultation',
    desc: 'Рабочее место врача: приёмы, заключения, назначения, оплаты.',
    levels: ['none', 'view'],
    levelDesc: { view: 'Открывает кабинет с теми окнами, что отмечены ниже.' },
    windows: [
      { key: 'doctor.dashboard',  label: 'Дашборд',    desc: 'Сводка врача за день.', levels: ['none', 'view'], enforced: 'route:consultation' },
      { key: 'doctor.visits',     label: 'Мои визиты', desc: 'Очередь и приёмы: заключение, направление на услуги.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Пишет заключение, назначает и направляет.' }, enforced: 'route:consultation/work' },
      { key: 'doctor.inpatients', label: 'Стационар',  desc: 'Мои пациенты в стационаре.', levels: ['none', 'view'], enforced: 'route:consultation/inpatients' },
      { key: 'doctor.pay',        label: 'Оплаты',     desc: 'Вознаграждение врача за услуги.', levels: ['none', 'view'], enforced: 'route:consultation/pay' },
      { key: 'doctor.profile',    label: 'Профиль',    desc: 'Свои специальности и шаблоны.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Правит свой профиль и шаблоны.' }, enforced: 'route:consultation/profile' },
    ],
    actions: [],
  },
  {
    key: 'labs', label: 'Лаборатория', legacy: 'labs',
    desc: 'Рабочий список и результаты анализов.',
    levels: ['none', 'view', 'edit', 'delete'],
    levelDesc: { view: 'Видит список и результаты.', edit: 'Вносит и подтверждает результаты.', delete: 'Удаляет показатель из бланка результата.' },
    windows: [], actions: [],
  },
  {
    key: 'procedures', label: 'Процедуры', legacy: 'procedures',
    desc: 'Очередь процедур медсестры.',
    levels: ['none', 'view', 'edit'],
    levelDesc: { view: 'Видит очередь процедур.', edit: 'Отмечает выполнение.' },
    windows: [], actions: [],
  },
  {
    key: 'inpatient', label: 'Стационар', legacy: 'beds',
    desc: 'Заявки на госпитализацию, койки, истории болезни и всё, что делают с лежащим пациентом.',
    levels: ['none', 'view'],
    levelDesc: { view: 'Открывает раздел с теми окнами, что отмечены ниже.' },
    windows: [
      { key: 'inpatient.requests', label: 'Заявки',         desc: 'Заявки на госпитализацию: кого и куда класть.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Создаёт заявку и размещает на койку.' }, enforced: 'rpc:admission_order_create' },
      { key: 'inpatient.patients', label: 'Пациенты',       desc: 'История болезни лежащего пациента: обзор, осмотры, документы.', levels: ['none', 'view'], enforced: 'rpc:case_overview' },
      { key: 'inpatient.beds',     label: 'Койки',          desc: 'Коечный фонд: кто где лежит, свободные и на уборке.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Меняет состояние койки.' }, enforced: 'rpc:bed_set_status' },
      { key: 'inpatient.history',  label: 'Госпитализации', desc: 'Журнал госпитализаций по образцу клиники, с выгрузкой в Excel.', levels: ['none', 'view'], enforced: 'rpc:admissions_register' },
    ],
    actions: [
      { key: 'inpatient.prescriptions', label: 'Назначения',  desc: 'Лист назначений: препараты, дозы, время.', levels: ['none', 'view', 'edit', 'delete'], levelDesc: { view: 'Видит лист назначений.', edit: 'Добавляет и правит назначения.', delete: 'Отменяет назначение.' }, enforced: 'rpc:treatment_orders' },
      { key: 'inpatient.marks',         label: 'Отметки о введении', desc: 'Медсестра отмечает, что препарат дан.', levels: ['none', 'view', 'edit', 'delete'], levelDesc: { view: 'Видит отметки.', edit: 'Ставит отметку «дано».', delete: 'Снимает любую отметку, в том числе чужую.' }, enforced: 'rpc:treatment_mark' },
      { key: 'inpatient.vitals',        label: 'Измерения',   desc: 'Температура, давление, пульс, сатурация.', levels: ['none', 'view', 'edit', 'delete'], levelDesc: { view: 'Видит измерения.', edit: 'Записывает измерение.', delete: 'Удаляет ошибочное измерение.' }, enforced: 'rpc:vitals' },
      { key: 'inpatient.reviews',       label: 'Осмотры',     desc: 'Дневник осмотров лечащего врача.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Читает осмотры.', edit: 'Пишет и публикует осмотр.' }, enforced: 'rpc:inpatient_reviews' },
      { key: 'inpatient.services',      label: 'Услуги в стационаре', desc: 'Услуги и процедуры, добавленные лежащему пациенту.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит список услуг.', edit: 'Добавляет услугу и отмечает выполнение.' }, enforced: 'rpc:admission_services' },
      { key: 'inpatient.discharge',     label: 'Выписка',     desc: 'Выписать пациента из стационара.', levels: ['none', 'edit'], levelDesc: { edit: 'Выписывает.' }, enforced: 'rpc:discharge' },
    ],
  },
  {
    key: 'mar', label: 'Лист назначений (медсестра)', legacy: 'beds',
    desc: 'Окно медсестры: что дать, кому и когда.',
    levels: ['none', 'view'],
    levelDesc: { view: 'Открывает окно с теми вкладками, что отмечены ниже.' },
    windows: [
      { key: 'mar.outpatient', label: 'Амбулаторные', desc: 'Назначения амбулаторным пациентам.', levels: ['none', 'view'], enforced: 'route:mar-nurse/outpatient' },
      { key: 'mar.inpatient',  label: 'Стационар',    desc: 'Назначения лежащим пациентам.', levels: ['none', 'view'], enforced: 'route:mar-nurse' },
    ],
    actions: [],
  },
  { key: 'kitchen',     label: 'Порционник',          legacy: 'beds', desc: 'Лист питания стационара для кухни.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит порционник.', edit: 'Назначает стол.' }, windows: [], actions: [], enforced: 'route:kitchen-sheet' },
  { key: 'discharges',  label: 'Выписки',             legacy: 'beds', desc: 'Очередь выписки и выписные документы.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит очередь выписки.', edit: 'Готовит и завершает выписку.' }, windows: [], actions: [], enforced: 'route:discharge' },
  { key: 'documents',   label: 'Документы',           legacy: 'patient-documents', desc: 'Печатные документы по пациентам.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Печатает документы.', edit: 'Заполняет и правит документы.' }, windows: [], actions: [] },
  { key: 'chat',        label: 'Чат с пациентами',    legacy: 'telegram-chat', desc: 'Переписка в Telegram-боте.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Читает переписку.', edit: 'Отвечает пациенту от имени клиники.' }, windows: [], actions: [] },
  { key: 'cashier',     label: 'Касса',               legacy: 'cashier', desc: 'Смена кассира и приём оплат.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит смену и счета.', edit: 'Принимает оплату, открывает и закрывает смену.' }, windows: [], actions: [] },
  { key: 'cashier_head',label: 'Старший кассир',      legacy: 'cashier-head', desc: 'Все смены и сверка.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит все смены.', edit: 'Проводит сверку и правит смены.' }, windows: [], actions: [] },
  { key: 'procurement', label: 'Закупки',             legacy: 'inventory', desc: 'Товары, остатки, поступления, заявки на закупку.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит склад и остатки.', edit: 'Оформляет приход, заявки и списания.' }, windows: [], actions: [
      // DEPARTMENTS_V1 — выдача со склада получателю (отдел, кабинет, сотрудник):
      // ворота issue_stock_lines. По умолчанию — администратор и снабженец.
      { key: 'procurement.issue', label: 'Выдача со склада', desc: 'Выдать товар отделу, кабинету или сотруднику.', levels: ['none', 'edit'], levelDesc: { edit: 'Выдаёт товар со склада получателю; склад списывается, получатель получает остаток.' }, enforced: 'rpc:issue_stock_lines' },
    ] },
  { key: 'dashboard',   label: 'Дашборд',             legacy: 'dashboard', desc: 'Сводка по клинике за день.', levels: ['none', 'view'], windows: [], actions: [] },
  // ROLE_REPORTS_SETTINGS_V1 (2026-09-25) — ОТЧЁТЫ ПО ГРУППАМ.
  //
  // Владелец: «an option to read a report per section for roles». Раздел
  // «Отчёты» был одной галочкой: кассир, которому нужен отчёт кассы, получал
  // вместе с ним и зарплаты всех врачей. Теперь у раздела семь окон — группы
  // отчётов; каждую проверяет сервер (services/report-access.js) по одной
  // карте «вид отчёта → группа» (REPORT_GROUP ниже), и по ней же хаб прячет
  // плитки. Ненастроенная группа живёт по ПРЕЖНЕМУ правилу («Отчёты» выданы —
  // видны все): после обновления никто не теряет ни одного отчёта.
  //
  // «Оплата врачей» — это ЧУЖИЕ начисления: свои врач видит в кабинете всегда,
  // и ни одна из этих галочек этого не отнимает.
  { key: 'reports',     label: 'Отчёты',              legacy: 'reports-hub', desc: 'Отчёты за период и выгрузка в Excel.', levels: ['none', 'view'], levelDesc: { view: 'Открывает отчёты тех групп, что отмечены ниже.' }, windows: [
      { key: 'reports.revenue',    label: 'Выручка и счета', desc: 'Общая выручка, счета и отчёт владельца.', levels: ['none', 'view'], enforced: 'rpc:run_report' },
      { key: 'reports.cashier',    label: 'Касса', desc: 'Отчёт кассира за период: поступления и расходы.', levels: ['none', 'view'], enforced: 'rpc:cashier_report' },
      { key: 'reports.doctor_pay', label: 'Оплата врачей', desc: 'Зарплаты врачей, стационарная доля, отчёты по врачам — начисления каждого врача. Свои начисления врач видит в кабинете всегда.', levels: ['none', 'view'], enforced: 'rpc:run_report' },
      { key: 'reports.referrals',  label: 'Рефералы', desc: 'Кто направил пациентов и вознаграждение за направления.', levels: ['none', 'view'], enforced: 'rpc:run_report' },
      { key: 'reports.services',   label: 'По услугам и рентабельность', desc: 'Отчёт по услугам и рентабельность операций.', levels: ['none', 'view'], enforced: 'rpc:run_report' },
      { key: 'reports.stock',      label: 'Закупки и склад', desc: 'Приход, расход, остатки и сроки годности.', levels: ['none', 'view'], enforced: 'rpc:run_report' },
      { key: 'reports.callcenter', label: 'Колл-центр', desc: 'Загрузка стойки, воронка заявок и работа операторов.', levels: ['none', 'view'], enforced: 'rpc:callcenter_report' },
      // ADMIN_ROWS_GRANTABLE_V1 — охват Telegram-бота выдаётся «Просмотром»
      // (сервер telegram_stats, telegram_links_list — тот же ключ). Роль,
      // которая строку не настраивала, живёт по прежнему правилу: только
      // администратор (`adminDefault`), а не «Отчёты выданы — видно всё».
      { key: 'reports.telegram',   label: 'Telegram-бот', desc: 'Сколько пациентов подключилось к боту, кто подключён и как рос охват.', levels: ['none', 'view'], levelDesc: { view: 'Видит охват бота и подключённых пациентов. Отвязать чат и разослать сообщение может только роль с «Telegram-бот: Изменение» в настройках.' }, adminDefault: true, enforced: 'rpc:telegram_stats' },
    ], actions: [] },
  // ROLE_REPORTS_SETTINGS_V1 — НАСТРОЙКИ ПО РАЗДЕЛАМ, ГРУППАМИ ХАБА.
  //
  // Окно = плитка хаба настроек; `group` — заголовок карточки хаба, под которым
  // плитка стоит, и экран «Роли» рисует окна этими же группами. «Изменение»
  // здесь НАСТОЯЩЕЕ: у таблиц плитки в реестре (server/db/schema-registry.js)
  // стоит `write.grant` с этим же ключом, и компилятор запросов пускает запись
  // тому, кому окно выдано на «Изменение» (db/write-grant.js). Плитка, чью
  // запись сервер не проверяет по ключу, «Изменения» не предлагает вовсе.
  //
  // `legacyKeys` — прежнее правило, по которому плитка была видна: ключи старой
  // матрицы ('hub' — любой, кто открывает сам хаб). Им экран «Роли» выводит
  // уровень у роли, которую ещё не настраивали, — и выводит только «Просмотр»:
  // писать в эти таблицы до сих пор мог один администратор.
  //
  // `locked` — только администратор, и выдать нельзя: строка видна, но
  // переключателя у неё нет, а сервер ключа не читает.
  //
  // `grantColumns` (ревью I2, решение: деньги — только администратору) — какие
  // колонки таблицы плитки право «Изменение» вправе писать; цены, проценты,
  // ставки и способы оплаты в этот список не входят и остаются за
  // администратором (db/write-grant.js отказывает, если такая колонка есть в
  // записи). Таблицы плитки без записи здесь — без денег, пишутся целиком.
  // Плитка, у которой без денег ничего не остаётся (скидки, полисы,
  // провайдеры, кэшбэк, ставки врачей), была закрытой строкой.
  //
  // ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — владелец: «there are some roles and
  // functions which are only available to the administrator. can you make
  // read, change, delete options for them too?». Закрытых строк больше нет:
  //   • у плитки-денег «Изменение» и есть деньги — вся плитка про них;
  //   • у плитки с деньгами внутри — действие «Цены и проценты» (`of` —
  //     плитка, `moneyColumns` — что оно открывает сверх `grantColumns`);
  //   • «Сотрудники», «Роли», CRM, телефония, Telegram и API — свои уровни и
  //     свои серверные ворота, а у каждой строки — `adminDefault`: пока роль
  //     её не настраивала, действует прежнее «только администратор».
  // Защиты от самоповышения («Роли», «Сотрудники», «API») — в
  // services/role-guard.js и routes/users.js.
  { key: 'settings',    label: 'Настройки',           legacy: 'settings', desc: 'Вся конфигурация клиники: услуги, сотрудники, роли, телефония.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Открывает настройки. Что в них видно и что можно менять, решают разделы ниже.', edit: 'Открывает настройки. Уровень раздела сам ничего не даёт менять — менять можно разделы, выданные ниже на «Изменение».' }, windows: [
      // ADMIN_ROWS_GRANTABLE_V1 — /api/users читает этот ключ (routes/users.js):
      // «Просмотр» — список, «Изменение» — завести и править, «Удаление» —
      // удалить сотрудника без истории. Администратора, себя и роль выше своей
      // не тронуть ни на каком уровне.
      { key: 'settings.employees', group: 'Управление пользователями и сотрудниками', label: 'Сотрудники', desc: 'Учётные записи персонала: логин, роль, данные сотрудника.', levels: ['none', 'view', 'edit', 'delete'], levelDesc: { view: 'Видит список сотрудников и их карточки.', edit: 'Заводит и правит сотрудников. Роль выдаёт только такую, у которой нет прав больше его собственных; администратора и свою роль не трогает.', delete: 'Удаляет сотрудника, за которым нет записей. Администратора и себя удалить нельзя.' }, adminDefault: true, enforced: 'api:users' },
      // Роли пишутся через /api/db (role_permissions и custom_roles), и дверь
      // проверяет самоповышение (services/role-guard.js). Удаления у ролей нет:
      // их отключают.
      { key: 'settings.roles', group: 'Управление пользователями и сотрудниками', label: 'Роли', desc: 'Кто что видит и может менять.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит права ролей, ничего не меняет.', edit: 'Меняет права ролей и заводит свои роли — не выше собственных прав. Роль администратора и свои собственные роли не меняет.' }, adminDefault: true, enforced: 'db:role_permissions' },
      // DEPARTMENTS_V1 — экран «Отделы»: список, карточка, формирование.
      { key: 'settings.departments', group: 'Управление пользователями и сотрудниками', label: 'Отделы', desc: 'Отделы клиники: руководитель, команда, помещения, снабжение.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит список отделов и их карточки.', edit: 'Формирует отделы: руководитель, команда, помещения.' }, enforced: 'rpc:department_form' },
      { key: 'settings.services', group: 'Настройки услуг', label: 'Список услуг', desc: 'Все услуги клиники: цены и куда ведёт каждая.', levels: ['none', 'view'], legacyKeys: ['services', 'settings:services'], enforced: 'route:services' },
      { key: 'settings.service_types', group: 'Настройки услуг', label: 'Типы услуг', desc: 'Как услуги сгруппированы в прайсе.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и переименовывает типы услуг. Способ оплаты типа — с действием «Цены и проценты».' }, legacyKeys: 'hub', grantColumns: { service_types: ['name', 'code', 'active'] }, enforced: 'db:service_types' },
      { key: 'settings.consultation_types', group: 'Настройки услуг', label: 'Консультации врачей', desc: 'Виды консультаций и их стоимость.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и переименовывает виды консультаций. Цены — с действием «Цены и проценты».' }, legacyKeys: 'hub', grantColumns: { consultation_types: ['name', 'name_ru', 'name_uz', 'sort_order', 'active'] }, enforced: 'db:consultation_types' },
      // PACKAGES_V1 — пакеты услуг: список услуг, срок предложения, скидка.
      // Скидка — деньги, её открывает «Цены и проценты» (ниже). Регистратура
      // сохраняет смету пакетом без скидки и снимает пакет из списка и без этой
      // строки (реестр, `nonAdminColumns`) — это её рабочий инструмент.
      { key: 'settings.service_packages', group: 'Настройки услуг', label: 'Пакеты услуг', desc: 'Наборы услуг для «+Пакеты» при регистрации: срок действия и скидка.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и правит пакеты: название, услуги, срок действия. Скидку пакета — с действием «Цены и проценты».' }, legacyKeys: 'hub', grantColumns: { service_templates: ['name', 'service_ids', 'valid_from', 'valid_until', 'active'] }, enforced: 'db:service_templates' },
      { key: 'settings.patients', group: 'Основное', label: 'Пациенты', desc: 'Картотека: данные пациента, контакты, номер карты.', levels: ['none', 'view'], legacyKeys: ['settings:patients'], enforced: 'route:settings:patients' },
      { key: 'settings.patient_categories', group: 'Основное', label: 'Категории пациентов', desc: 'Группы пациентов и скидка каждой группы.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и переименовывает категории. Скидку группы — с действием «Цены и проценты».' }, legacyKeys: 'hub', grantColumns: { patient_categories: ['name', 'tier', 'active'] }, enforced: 'db:patient_categories' },
      { key: 'settings.chronic_conditions', group: 'Основное', label: 'Хронические заболевания', desc: 'Список для анкеты пациента.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Пополняет и правит список.' }, legacyKeys: 'hub', enforced: 'db:chronic_conditions_ref' },
      { key: 'settings.documents', group: 'Основное', label: 'Документы', desc: 'Как выглядят печатные документы.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Меняет оформление печатных документов.' }, legacyKeys: ['documents', 'settings'], enforced: 'db:doc_branding' },
      // Скидка — это и есть деньги: срок, группа и услуги решают, кому она
      // достанется, поэтому делить её на «деньги» и «прочее» нечего (ревью I2).
      { key: 'settings.patient_discounts', group: 'Основное', label: 'Скидки пациентов', desc: 'Промокоды и сертификаты: скидка — это деньги клиники.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит скидки, ничего не меняет.', edit: 'Заводит и правит скидки — вместе с их процентами и суммами.' }, adminDefault: true, enforced: 'db:patient_discounts' },
      // ADMIN_ROWS_GRANTABLE_V1 — воронка, телефония и бот: RPC раздела читают
      // эти ключи. Ключи, секреты и токены не видит никто, кроме
      // администратора, — ни на каком уровне; «Изменение» задаёт новые.
      { key: 'settings.crm', group: 'Системные настройки', label: 'CRM-канбан', desc: 'Воронка заявок: колонки, источники, метки.', levels: ['none', 'view', 'edit', 'delete'], levelDesc: { view: 'Видит настройки воронки, ничего не меняет.', edit: 'Добавляет, переименовывает, скрывает и переставляет колонки, источники и метки.', delete: 'Удаляет колонки, источники и метки. Колонку или источник, в которых есть заявки, удалить нельзя — только скрыть.' }, adminDefault: true, enforced: 'rpc:crm_config_save' },
      { key: 'settings.telephony', group: 'Системные настройки', label: 'Телефония', desc: 'Подключение телефонии и маршрут звонков.', levels: ['none', 'view', 'edit', 'delete'], levelDesc: { view: 'Видит подключения и журнал звонков. Ключи и секреты скрыты.', edit: 'Меняет подключение и маршрут звонков, может задать новый ключ. Сохранённые ключи и секреты не видит.', delete: 'Удаляет подключение провайдера и стирает подключение Binotel.' }, adminDefault: true, enforced: 'rpc:telephony_settings_save' },
      { key: 'settings.telegram', group: 'Системные настройки', label: 'Telegram-бот', desc: 'Токен бота и выдача документов.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит настройки бота. Токен скрыт.', edit: 'Меняет настройки бота, задаёт новый токен, отвязывает чаты и делает рассылку. Сохранённый токен не видит.' }, adminDefault: true, enforced: 'rpc:telegram_settings_save' },
      // У ключа API нет областей доступа: это полный машинный доступ к клинике.
      // Поэтому создать ключ и задать его значение может только
      // администратор (`grantOps` — право открывает одну правку), а
      // «Изменение» переименовывает и отзывает ключ. Удаления ключей нет вовсе.
      { key: 'settings.api', group: 'Системные настройки', label: 'API', desc: 'Ключи доступа для партнёрских программ.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит список ключей; значение ключа скрыто.', edit: 'Переименовывает и отзывает ключи. Создать ключ может только администратор: ключ — это полный доступ к клинике.' }, adminDefault: true, grantOps: { api_tokens: ['update'] }, grantColumns: { api_tokens: ['name', 'active'] }, enforced: 'db:api_tokens' },
      { key: 'settings.company', group: 'Настройки Easy-Med', label: 'Компания', desc: 'Название, логотип, фирменный цвет и контакты клиники.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Меняет название, логотип и контакты клиники. Охват лаборатории между зданиями меняет только администратор.' }, legacyKeys: ['documents-settings', 'documents', 'settings'], grantColumns: { doc_settings: ['clinic_name', 'address', 'phone', 'email', 'license', 'logo_data_url', 'accent_color', 'paper_size', 'show_watermark', 'footer_note', 'legal_note'] }, enforced: 'db:doc_settings' },
      { key: 'settings.branches', group: 'Настройки Easy-Med', label: 'Филиалы', desc: 'Адреса зданий клиники.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и правит адреса. Связь зданий — только администратор.' }, legacyKeys: 'hub', enforced: 'db:branches' },
      { key: 'settings.rooms', group: 'Помещения', label: 'Помещения', desc: 'Этажи, кабинеты и палаты: койки, цены, оборудование.', levels: ['none', 'view', 'edit', 'delete'], levelDesc: { edit: 'Заводит и правит этажи, кабинеты, палаты, койки и оборудование. Цены палат и коек — с действием «Цены и проценты»; отдел помещения и врачей кабинета меняет только администратор.', delete: 'Удаляет оборудование и снимает его с помещений.' }, legacyKeys: ['rooms-setup', 'settings:rooms', 'settings:wards', 'settings:beds_settings', 'settings:floors', 'settings'], grantColumns: { rooms: ['name', 'code', 'room_type', 'capacity', 'queue_mode', 'floor_id', 'notes', 'active', 'working_hours', 'plan_x', 'plan_y', 'plan_w', 'plan_h'], wards: ['name', 'code', 'floor_id', 'active', 'type', 'color', 'plan_x', 'plan_y', 'plan_w', 'plan_h'], beds: ['code', 'ward_id', 'active', 'type', 'notes'] }, enforced: 'db:rooms' },
      { key: 'settings.payers', group: 'Управление плательщиками', label: 'Компании-плательщики', desc: 'Кто платит за пациента: страховые и компании.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и правит плательщиков.' }, legacyKeys: 'hub', enforced: 'db:payers' },
      // Полис — это процент покрытия, способ оплаты провайдера — его комиссия,
      // правило кэшбэка — его процент: без денег строки пусты (ревью I2).
      { key: 'settings.payer_policies', group: 'Управление плательщиками', label: 'Страховые полисы', desc: 'Что и на сколько процентов покрывает каждый плательщик.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит полисы, ничего не меняет.', edit: 'Заводит и правит полисы — вместе с процентом покрытия.' }, adminDefault: true, enforced: 'db:payer_policies' },
      { key: 'settings.payment_providers', group: 'Управление плательщиками', label: 'Провайдеры онлайн-платежей', desc: 'Какую комиссию платит клиника.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит провайдеров, ничего не меняет.', edit: 'Заводит и правит провайдеров — вместе с комиссией.' }, adminDefault: true, enforced: 'db:payment_providers' },
      { key: 'settings.cashback_rules', group: 'Управление плательщиками', label: 'Кэшбэк', desc: 'Сколько возвращать пациенту и за что.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит правила кэшбэка, ничего не меняет.', edit: 'Заводит и правит правила — вместе с процентом.' }, adminDefault: true, enforced: 'db:cashback_rules' },
      { key: 'settings.referral_sources', group: 'Направления', label: 'Список источников', desc: 'Откуда приходят пациенты.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и правит источники: имя, категорию, контакты. Ставки вознаграждения и реквизиты выплаты — с действием «Цены и проценты».' }, legacyKeys: 'hub', grantColumns: { referral_sources: ['name', 'category', 'category_id', 'last_name', 'first_name', 'middle_name', 'phone', 'workplace', 'district', 'active'] }, enforced: 'db:referral_sources' },
      { key: 'settings.referral_source_categories', group: 'Направления', label: 'Категории источников', desc: 'Как сгруппированы источники.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и переименовывает категории. Стандартные ставки — с действием «Цены и проценты».' }, legacyKeys: 'hub', grantColumns: { referral_source_categories: ['name', 'active'] }, enforced: 'db:referral_source_categories' },
      // Ставка врача — это его зарплата: вся плитка — деньги (ревью I2), и её
      // «Изменение» — это и есть право менять ставки (ADMIN_ROWS_GRANTABLE_V1).
      { key: 'settings.doctor_rates', group: 'Зарплата врача', label: 'Ставки врачей', desc: 'Процент врача по каждой услуге.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит ставки врачей, ничего не меняет.', edit: 'Заводит и правит ставки врачей.' }, adminDefault: true, enforced: 'db:doctor_rates' },
    ], actions: [
      // ADMIN_ROWS_GRANTABLE_V1 — «ЦЕНЫ И ПРОЦЕНТЫ» ОТДЕЛЬНЫМ ПРАВОМ У КАЖДОЙ
      // ПЛИТКИ, ГДЕ ОНИ ЕСТЬ. Плитка на «Изменение» пишет всё, КРОМЕ денег
      // (`grantColumns`, ревью I2); это действие открывает её деньги
      // (`moneyColumns`), и только вместе с «Изменением» самой плитки. Пока роль
      // строку не настраивала — «Нет» (`adminDefault`): деньги, как и вчера,
      // меняет администратор. Отдел помещения и охват лаборатории — не деньги
      // и остаются за администратором.
      { key: 'settings.service_types.money', of: 'settings.service_types', group: 'Настройки услуг', label: 'Цены и проценты', desc: 'Способ оплаты типа услуг.', levels: ['none', 'edit'], levelDesc: { edit: 'Меняет способ оплаты типа услуг (вместе с «Изменением» плитки).' }, adminDefault: true, moneyColumns: { service_types: ['billing_mode'] }, enforced: 'db:service_types' },
      { key: 'settings.consultation_types.money', of: 'settings.consultation_types', group: 'Настройки услуг', label: 'Цены и проценты', desc: 'Цена вида консультации.', levels: ['none', 'edit'], levelDesc: { edit: 'Меняет цены консультаций (вместе с «Изменением» плитки).' }, adminDefault: true, moneyColumns: { consultation_types: ['price'] }, enforced: 'db:consultation_types' },
      { key: 'settings.service_packages.money', of: 'settings.service_packages', group: 'Настройки услуг', label: 'Цены и проценты', desc: 'Скидка пакета услуг.', levels: ['none', 'edit'], levelDesc: { edit: 'Меняет скидку пакета (вместе с «Изменением» плитки).' }, adminDefault: true, moneyColumns: { service_templates: ['discount_percent'] }, enforced: 'db:service_templates' },
      { key: 'settings.patient_categories.money', of: 'settings.patient_categories', group: 'Основное', label: 'Цены и проценты', desc: 'Скидка группы пациентов.', levels: ['none', 'edit'], levelDesc: { edit: 'Меняет скидку группы (вместе с «Изменением» плитки).' }, adminDefault: true, moneyColumns: { patient_categories: ['discount_percent'] }, enforced: 'db:patient_categories' },
      { key: 'settings.rooms.money', of: 'settings.rooms', group: 'Помещения', label: 'Цены и проценты', desc: 'Цены палат и коек, способ оплаты палаты.', levels: ['none', 'edit'], levelDesc: { edit: 'Меняет цены палат и коек (вместе с «Изменением» плитки).' }, adminDefault: true, moneyColumns: { wards: ['billing_mode', 'price_per_day', 'price_per_hour'], beds: ['price_per_day', 'price_per_hour'] }, enforced: 'db:wards' },
      { key: 'settings.referral_sources.money', of: 'settings.referral_sources', group: 'Направления', label: 'Цены и проценты', desc: 'Ставки вознаграждения источника и реквизиты выплаты.', levels: ['none', 'edit'], levelDesc: { edit: 'Меняет ставки вознаграждения и реквизиты выплаты (вместе с «Изменением» плитки).' }, adminDefault: true, moneyColumns: { referral_sources: ['payment_type', 'card_number', 'reward_mode', 'own_percent', 'own_rates'] }, enforced: 'db:referral_sources' },
      { key: 'settings.referral_source_categories.money', of: 'settings.referral_source_categories', group: 'Направления', label: 'Цены и проценты', desc: 'Стандартные ставки категории источников.', levels: ['none', 'edit'], levelDesc: { edit: 'Меняет стандартные ставки категорий (вместе с «Изменением» плитки).' }, adminDefault: true, moneyColumns: { referral_source_categories: ['standard_percent', 'rates'] }, enforced: 'db:referral_source_categories' },
      // Зарплата сотрудника живёт в его карточке (/api/users): без этого права
      // не-администратор её не видит и не пишет (routes/users.js MONEY_FIELDS).
      { key: 'settings.employees.money', of: 'settings.employees', group: 'Управление пользователями и сотрудниками', label: 'Цены и проценты', desc: 'Зарплата и ставки в карточке сотрудника.', levels: ['none', 'edit'], levelDesc: { edit: 'Видит и меняет зарплату и ставки сотрудника (вместе с «Изменением» плитки).' }, adminDefault: true, enforced: 'api:users' },
    ] },
];

// ROLE_REPORTS_SETTINGS_V1 — ВИД ОТЧЁТА → ГРУППА (ключ окна раздела «Отчёты»).
//
// Одна карта на оба конца: сервер проверяет по ней run_report, owner_report,
// callcenter_report и cashier_report (services/report-access.js), хаб прячет по
// ней плитки. Вид без записи здесь сервер не выдаёт никому, кроме
// администратора, — новый отчёт обязан прийти сюда вместе со своей плиткой
// (тест reports-hub-v2 сверяет каждую плитку).
//
// Прежние «сырые» виды run_report (payments, invoices, services, visits,
// patients, stock_movements) плиток не имеют, но позвать их можно — они
// разложены по тем же группам; visits и patients — не деньги и не склад, им
// хватает самого раздела («reports»).
export const REPORT_GROUP = Object.freeze({
  total_revenue: 'reports.revenue', invoices_full: 'reports.revenue', owner: 'reports.revenue',
  cashier: 'reports.cashier',
  doctor_salaries: 'reports.doctor_pay', inpatient_share: 'reports.doctor_pay',
  by_doctors: 'reports.doctor_pay', doctor_services: 'reports.doctor_pay',
  referrals: 'reports.referrals', referrals_detail: 'reports.referrals',
  by_services: 'reports.services', surgery_profit: 'reports.services',
  procurement: 'reports.stock', stock_consumption: 'reports.stock',
  stock_statement: 'reports.stock', stock_expiry: 'reports.stock',
  callcenter: 'reports.callcenter',
  // ADMIN_ROWS_GRANTABLE_V1 — охват бота: своя группа с правилом перехода
  // «только администратор» (у строки `adminDefault`).
  telegram: 'reports.telegram',
  // прежние виды run_report
  payments: 'reports.cashier', invoices: 'reports.revenue', services: 'reports.services',
  stock_movements: 'reports.stock', visits: 'reports', patients: 'reports',
});

// ROLE_REPORTS_SETTINGS_V1 — старые ключи, при которых открывается хаб
// настроек (permissions.js isModuleAllowed('settings')): 'settings', любой
// 'settings:<раздел>' и страницы, живущие внутри хаба. Список один — его
// читают и ворота оболочки, и вывод уровней на экране «Роли» (legacyKeys: 'hub').
export const SETTINGS_HUB_LEGACY_KEYS = Object.freeze(['settings', 'documents', 'discounts-settings', 'api-settings', 'doctor-pay', 'consultation-types', 'communications', 'cashier-settings']);

/** Открыт ли хаб настроек по старому списку разделов (без справочника). */
export function settingsHubLegacy(sectionsList) {
  const s = sectionsList instanceof Set ? sectionsList : new Set(sectionsList || []);
  for (const k of s) if (typeof k === 'string' && k.startsWith('settings:')) return true;
  return SETTINGS_HUB_LEGACY_KEYS.some((k) => s.has(k));
}

/**
 * Прежний уровень плитки настроек у роли, которую ещё не настраивали:
 * 'view', если по старым ключам плитка была видна, иначе 'none'. «Изменения»
 * отсюда не бывает: писать в таблицы настроек до сих пор мог только
 * администратор, и вывести его из старых ключей значило бы раздать запись.
 */
export function settingsLegacyView(row, sectionsList) {
  if (!row || row.locked || !row.legacyKeys) return null;
  const s = sectionsList instanceof Set ? sectionsList : new Set(sectionsList || []);
  if (row.legacyKeys === 'hub') return settingsHubLegacy(s) ? 'view' : 'none';
  return row.legacyKeys.some((k) => s.has(k)) ? 'view' : 'none';
}

/**
 * ADMIN_ROWS_GRANTABLE_V1 — строка с правилом перехода «только администратор»:
 * пока роль её не настраивала, её не видит никто, кроме администратора.
 */
let adminDefaultMap = null;
export function isAdminDefault(key) {
  if (!adminDefaultMap) adminDefaultMap = catalogByKey();
  const r = adminDefaultMap.get(key);
  return !!(r && r.adminDefault);
}

/** Действие «Цены и проценты» плитки настроек — или null. */
export function moneyRowOf(tileKey) {
  for (const s of CATALOG) for (const a of s.actions || []) if (a.of === tileKey) return a;
  return null;
}

// ---------------------------------------------------------------------------
// ВЫВОД МАТРИЦЫ ИЗ СТАРЫХ ПОЛЕЙ (ROLES_MATRIX_V1). Жил в admin/roles-matrix.js;
// ADMIN_ROWS_GRANTABLE_V1 перенёс его сюда: тем же выводом сервер сравнивает,
// не выдаёт ли редактор ролей больше, чем держит сам (services/role-guard.js).
// ---------------------------------------------------------------------------
const LEGACY_TO_GRANT = { viewer: 'view', editor: 'edit', admin: 'delete' };

function clampTo(row, lvl) {
  const allowed = row.levels || ['none', 'view'];
  if (allowed.includes(lvl)) return lvl;
  // Уровня нет у строки — берём ближайший снизу из существующих.
  let best = 'none';
  for (const l of allowed) if ((RANK[l] || 0) <= (RANK[lvl] || 0) && (RANK[l] || 0) >= (RANK[best] || 0)) best = l;
  return best;
}

/**
 * grants из старых полей — для роли, у которой grants ещё нет.
 * Раздел получает уровень старого ключа; окна и действия внутри —
 * ТОТ ЖЕ уровень, срезанный до того, что у строки существует. Это ровно то,
 * что действует сегодня: ворота действий ещё живут по спискам ролей, но для
 * экрана «раздел выдан» означает «всё внутри доступно, как было».
 */
export function grantsFromLegacy(perms) {
  const sections = new Set((perms && perms.sections) || []);
  const levels = (perms && perms.levels) || {};
  const grants = {};
  for (const s of CATALOG) {
    const legacy = s.legacy;
    const on = legacy && sections.has(legacy);
    const lvl = on ? (LEGACY_TO_GRANT[levels[legacy]] || 'delete') : 'none';
    grants[s.key] = clampTo(s, lvl);
    for (const w of s.windows || []) {
      // ROLE_REPORTS_SETTINGS_V1 — закрытую строку (только администратор)
      // экран не выводит и не пишет: выдать её нельзя.
      // ADMIN_ROWS_GRANTABLE_V1 — строку с правилом «только администратор»
      // тоже НЕ выводим: из галочки «Настройки» или «Отчёты» не следует ни
      // право на «Роли», ни на ключи API, и выведенное «Изменение» раздало бы
      // их при первом же сохранении роли.
      if (w.locked || w.adminDefault) continue;
      // Плитка настроек выводится из СВОИХ прежних ключей и не выше
      // «Просмотра»: писать в её таблицы до сих пор мог только
      // администратор, и вывести «Изменение» из галочки «Настройки»
      // значило бы раздать запись в справочники при первом сохранении роли.
      if (w.legacyKeys) { grants[w.key] = settingsLegacyView(w, sections) || 'none'; continue; }
      grants[w.key] = on ? clampTo(w, lvl) : 'none';
    }
    for (const a of s.actions || []) {
      if (a.adminDefault) continue;   // ADMIN_ROWS_GRANTABLE_V1 — «Цены и проценты» и т. п.
      grants[a.key] = on ? clampTo(a, lvl) : 'none';
    }
  }
  return grants;
}

/** Все строки матрицы плоским списком: раздел, его окна и действия. */
export function catalogRows() {
  const rows = [];
  for (const s of CATALOG) {
    rows.push({ ...s, kind: 'section', parent: null });
    for (const w of s.windows || []) rows.push({ ...w, kind: 'window', parent: s.key });
    for (const a of s.actions || []) rows.push({ ...a, kind: 'action', parent: s.key });
  }
  return rows;
}

export function catalogByKey() {
  const m = new Map();
  for (const r of catalogRows()) m.set(r.key, r);
  return m;
}

/** Ключи старой матрицы (NAV_MODULES), которыми ещё живут старые ворота. */
export function legacyKeyOf(sectionKey) {
  const s = CATALOG.find((x) => x.key === sectionKey);
  return s ? s.legacy || null : null;
}
