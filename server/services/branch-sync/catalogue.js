// BRANCH_SYNC_V1 — ЧТО именно едет между филиалами, и как оно приземляется.
//
// Этап 1 переносит только СПРАВОЧНИК: сведения о клинике, услуги с ценами,
// лабораторные панели с показателями и — с STAFF_SYNC_V1 (миграция 086) —
// СОТРУДНИКОВ С ИХ РОЛЯМИ И ПРАВАМИ РОЛЕЙ. Ни пациентов, ни визитов, ни
// результатов, ни счетов, ни платежей — это Этапы 2 и 3, и до них правило
// владельца «НЕ ПЕРСОНАЛЬНЫЕ ДАННЫЕ ПАЦИЕНТОВ» держится здесь самым простым
// способом из возможных: таблицы и колонки перечислены В КОДЕ, и выгрузка
// физически не умеет отдать ничего другого. Сотрудник — не пациент: это
// работник клиники, и его учётная запись нужна второму зданию, чтобы он мог в
// нём работать.
//
// Это та же идея, что у STATS_V1 (control/metrics.js): не «отфильтруем лишнее
// перед отправкой», а «сборщик умеет собрать только вот это». Фильтр забывают
// обновить, когда в таблицу добавляют колонку; перечень — нет, потому что новая
// колонка просто не попадает в выгрузку, пока её сюда не впишут. Гарантия
// закреплена тестом: в базу-источник сажается пациент-маркер со счётом и
// анализом, и весь JSON выгрузки проверяется на отсутствие его следов.
//
// ГЛАВНОЕ РЕШЕНИЕ ПРИЁМА — строки приезжают ПО СОБСТВЕННЫМ id принимающей базы,
// а соответствие хранится в branch_sync_map (см. миграцию 079 с разбором, почему
// перенос «как есть, вместе с id» испортил бы уже выставленные счета филиала).

import { normName } from '../../../public/js/admin/service-editor-logic.js';

// Колонки doc_settings, которые описывают КЛИНИКУ, а не ЗДАНИЕ.
//
// address / phone / email намеренно НЕ синхронизируются, хотя владелец
// перечислил «информацию о компании» целиком. Причина видна на первом же
// напечатанном документе: doc_settings — источник шапки печатных форм
// (rpc/clinic.js get_clinic_by_slug), и, приехав из главного филиала, адрес с
// телефоном заменили бы на бланках второго филиала его собственные контакты
// чужими. Пациент, пришедший по такому направлению, поехал бы в другое здание.
// Свой адрес и телефон у филиала уже есть — в таблице branches, которая и
// заведена ровно для этого.
//
// id / updated_at не переносятся: id всегда 1 (строка одна по CHECK), а
// updated_at должен показывать, когда справочник изменился ЗДЕСЬ.
//
// LAB_ONE_CLINIC_V1 — lab_scope («лаборатория обслуживает всю клинику / только
// своё здание», миграция 085) едет ИМЕННО ЗДЕСЬ, а не остаётся местной
// настройкой, и это главное в ней. Настройка описывает, как устроена
// лаборатория КЛИНИКИ; если бы каждое здание решало у себя, одно ждало бы, что
// его пробирки возьмут в работу в главном корпусе, а главный корпус их бы не
// видел — и никто бы не узнал, потому что молчащая очередь выглядит как
// «сегодня нет заказов». Настройка меняется в главном филиале и приезжает
// остальным той же порцией справочника, что и прайс.
export const DOC_SETTINGS_COLUMNS = [
  'clinic_name', 'license', 'logo_data_url', 'accent_color',
  'paper_size', 'show_watermark', 'footer_note', 'legal_note',
  'lab_scope',
];

// Таблицы справочника — В ПОРЯДКЕ ЗАВИСИМОСТЕЙ. Порядок не косметика: services
// ссылается на service_types/service_categories/departments, а
// lab_panel_analytes — на lab_panels, и родитель должен получить свой локальный
// id раньше, чем ребёнок попытается на него сослаться.
//
//   columns   — что переносим (id идёт отдельно, как remote_id);
//   refs      — колонки-ссылки: чужой id переводится в свой через карту;
//   natural   — по чему УСЫНОВЛЯТЬ уже существующую местную строку (ниже);
//   scopeRef  — для дочерних таблиц: искать кандидата на усыновление только
//               внутри своего родителя.
export const TABLES = [
  {
    name: 'service_types',
    columns: ['name', 'code', 'billing_mode', 'active'],
    refs: {},
    natural: ['code', 'name'],
  },
  {
    name: 'service_categories',
    columns: ['code', 'name', 'parent_id', 'description', 'active'],
    // Ссылка на саму себя — поэтому parent_id проставляется вторым проходом,
    // когда все категории уже получили локальные id (см. applyCatalogue).
    refs: { parent_id: 'service_categories' },
    selfRef: 'parent_id',
    natural: ['code', 'name'],
  },
  {
    // Отделения тянутся не сами по себе, а как ЗАВИСИМОСТЬ услуг:
    // services.department_id — внешний ключ, а foreign_keys включён
    // (db/connection.js), поэтому услуга с чужим department_id без своей
    // строки в departments не вставилась бы вовсе. Данные при этом
    // неклинические: название, код, вид отделения. Сотрудники (users.
    // department_id) не переносятся — приезжают только сами отделения.
    name: 'departments',
    columns: ['name', 'code', 'kind', 'active'],
    refs: {},
    natural: ['code', 'name'],
  },
  {
    name: 'services',
    columns: [
      'name', 'code', 'price', 'tax_rate', 'duration_minutes', 'requires_doctor', 'active',
      'is_lab', 'specimen', 'result_unit', 'ref_low', 'ref_high', 'ref_text', 'type',
      'type_id', 'category_id', 'department_id', 'tube_color',
      // SERVICE_EDITOR_V1 (миграция 081) — доля исполнителя по умолчанию ЕДЕТ:
      // это ценовая политика клиники, и она путешествует вместе с прайсом.
      'default_doctor_percent',
      // services.room_id (та же миграция 081) НАМЕРЕННО ОТСУТСТВУЕТ: кабинет —
      // факт ЗДАНИЯ, а не клиники. «Кабинет 5» главного филиала ничего не
      // значит во втором корпусе, а приехавший чужой id указал бы на случайную
      // местную комнату или в никуда. Принимающий филиал хранит свой
      // NULL/локальный кабинет; перечень колонок здесь — и есть гарантия, что
      // room_id физически не попадает в выгрузку (пин: 081.test.js).
    ],
    refs: { type_id: 'service_types', category_id: 'service_categories', department_id: 'departments' },
    natural: ['code', 'name'],
  },
  {
    name: 'lab_panels',
    // core_panel_id — не внешний ключ на местную таблицу, а номер панели в
    // облачном каталоге CORE; он одинаково осмыслен во всех установках и едет
    // как есть.
    columns: ['name', 'code', 'modality', 'has_narrative', 'service_id', 'core_panel_id', 'active'],
    refs: { service_id: 'services' },
    natural: ['code', 'name'],
  },
  {
    name: 'lab_panel_analytes',
    columns: [
      'panel_id', 'code', 'name', 'unit', 'value_type', 'value_options', 'decimals',
      'ref_low', 'ref_high', 'ref_text', 'ref_low_m', 'ref_high_m', 'ref_low_f', 'ref_high_f',
      'group_label', 'sort_order', 'ref_ranges', 'active',
    ],
    refs: { panel_id: 'lab_panels' },
    natural: ['code', 'name'],
    scopeRef: 'panel_id',
  },

  // ---------------------------------------------------------------------------
  // STAFF_SYNC_V1 (миграция 086) — СОТРУДНИКИ И РОЛИ.
  //
  // Владелец: «the filial users (employees are not rendered to other branches)»
  // и раньше «every information … users and roles … should be movable across
  // the branches». Правило то же, что у прайса: главная клиника ими управляет,
  // филиал получает.
  //
  // ПОЧЕМУ ЗДЕСЬ, А НЕ В СВОЁМ КАНАЛЕ. Всё, что нужно сотрудникам, этот файл уже
  // умеет и уже доказал тестами: одностороннее движение главный → филиал,
  // усыновление уже заведённых строк вместо дублей, перевод чужих id в свои
  // через branch_sync_map, dryRun тем же кодом. Отдельный канал учился бы этому
  // заново и разошёлся бы с этим на первой же правке.
  //
  // ПОСЛЕ departments — не косметика: users.department_id ссылается на
  // departments, foreign_keys включён (db/connection.js), и сотрудник с чужим
  // department_id без своей строки отделения не вставился бы вовсе.
  {
    name: 'users',
    // Выгружает ТОЛЬКО главная клиника (см. exportCatalogue). Канал
    // односторонний по замыслу; здесь это записано так, что филиал физически не
    // умеет отдать своих людей наверх, а не так, что «мы его об этом не просим».
    mainOnly: true,
    columns: [
      // Кто это и как его показать.
      'username', 'full_name', 'first_name', 'last_name', 'middle_name',
      'phone', 'email', 'position', 'specialty', 'staff_type', 'scheduling_mode',
      'is_doctor', 'doctor_category', 'license_number', 'license_expiry_date',
      'hire_date', 'department_id',
      // Чем ему разрешено пользоваться. role — основная роль, extra_roles —
      // «Дополнительные роли»; ACL авторизует по ОБЪЕДИНЕНИЮ (services/roles.js
      // effectiveRoles), поэтому одна без другой приехала бы половиной прав.
      'role', 'extra_roles',
      // ПАРОЛЬ. Решение владельца, названное вслух: один человек — один вход в
      // любом здании. Едет bcrypt-хеш (services/auth.js), а не пароль; канал
      // между зданиями зашифрован сквозным групповым ключом (relay-crypto.js),
      // и филиал получает ровно то же, что уже хранит про своих сотрудников.
      // Разбор последствий — в шапке миграции 086.
      'password_hash',
      // Уволенный/отключённый обязан приехать именно отключённым — иначе филиал
      // продолжал бы пускать в систему человека, которому доступ закрыли.
      'is_active',
    ],
    refs: { department_id: 'departments' },
    // ЛОГИН, и выбор здесь вынужденный, а не вкусовой. users.username —
    // единственная колонка таблицы с UNIQUE (001_init, COLLATE NOCASE), то есть
    // единственная, по которой две независимо заведённые установки говорят об
    // ОДНОМ человеке; и одновременно та, промах по которой не «создал бы
    // дубль», как у услуги, а свалил бы INSERT на UNIQUE — вместе со ВСЕЙ
    // транзакцией приёма, то есть и с прайсом. Телефон меняют, ФИО совпадают у
    // однофамильцев, id у каждой установки свой; логин человек вводит сам,
    // каждый день, и именно им он входит во втором здании.
    natural: ['username'],
    uniqueNatural: true,
    localFlag: 'is_local',
    deactivateMissing: 'is_active',
    // ЧЕГО ЗДЕСЬ НЕТ, и почему:
    //
    //   id                       — приезжает как remote_id, свой выдаёт SQLite
    //                              (см. шапку файла и миграцию 079);
    //   branch_id, room_id       — факты ЗДАНИЯ. «Кабинет 5» и «филиал 2»
    //                              главной клиники во втором корпусе означают
    //                              случайную местную комнату или ничего — та же
    //                              причина, по которой не едет services.room_id;
    //   working_hours            — расписание В ЭТОМ здании: врач принимает
    //                              здесь по вторникам, а там по четвергам;
    //   salary_type, salary_fixed, salary_percent, employment_type,
    //   service_rate_default, referral_rate_default,
    //   service_rates, referral_rates
    //                            — деньги и трудовые отношения. Мало того что
    //                              это не нужно филиалу, чтобы показать и
    //                              впустить сотрудника, — в service_rates и
    //                              referral_rates лежат id УСЛУГ главной
    //                              клиники, и, приехав как есть, ставка врача
    //                              указала бы на чужую местную услугу. Приём
    //                              переводит только колонки из refs, а внутрь
    //                              JSON он не смотрит;
    //   must_change_password     — состояние, которое снимается ВВОДОМ нового
    //                              пароля здесь; приехав, оно требовало бы от
    //                              человека смены, которую филиал всё равно не
    //                              вправе сделать (миграция 086);
    //   kpi_links                — ссылки на дашборды конкретной установки;
    //   active                   — GENERATED ALWAYS AS (is_active) (миграция
    //                              032): записать её нельзя в принципе;
    //   created_at, updated_at   — когда строка появилась ЗДЕСЬ;
    //   sessions                 — открытые сессии не переносятся никогда: это
    //                              не сведения о человеке, а ключи от входа.
  },
  {
    // Что каждой роли разрешено видеть и менять. Сами роли — код
    // (services/roles.js VALID_ROLES), а вот НАБОР РАЗДЕЛОВ у роли настраивает
    // администратор («Настройки → Роли»), и это политика КЛИНИКИ, а не здания:
    // медсестра, которой в главном корпусе открыли процедуры, во втором обязана
    // видеть их же. Иначе один и тот же человек с одной и той же ролью видел бы
    // в двух зданиях два разных приложения, и понять почему было бы нечем.
    //
    // role — natural key по той же причине, что username выше: UNIQUE
    // (миграция 013). Строки засеяны одинаково в обеих установках, поэтому
    // первая синхронизация их усыновляет, а не удваивает.
    name: 'role_permissions',
    mainOnly: true,
    columns: ['role', 'permissions'],
    refs: {},
    natural: ['role'],
    uniqueNatural: true,
    // updated_at не едет: он должен показывать, когда права поменялись ЗДЕСЬ.
  },
];

// STAFF_SYNC_SEAL_V1 — таблицы, которые едут ТОЛЬКО в запечатанном виде.
//
// Это тот же список, что `mainOnly` выше, но названный отдельным именем и
// вынесенный наружу, потому что у него появился ВТОРОЙ читатель с другим
// вопросом. `mainOnly` отвечает «кто вправе это отдавать» (филиал — никогда);
// этот список отвечает «что нельзя класть в открытое тело ответа». Совпадают
// они не случайно: обе таблицы — учётные записи с хешами паролей и права
// ролей, то есть ровно то, что главная клиника раздаёт вниз и что не должно
// оказаться на проводе открытым текстом (routes/branch-sync.js).
//
// Выводится из TABLES, а не переписывается рядом: добавив завтра третью
// таблицу с mainOnly, автор получит защиту, не вспомнив про этот файл.
export const SEALED_ONLY_TABLES = Object.freeze(TABLES.filter((t) => t.mainOnly).map((t) => t.name));

/**
 * Та же выгрузка, но БЕЗ таблиц, которые нельзя отдавать открытым текстом.
 *
 * Ключи УДАЛЯЮТСЯ, а не обнуляются в пустой список, и разница осмысленная:
 * пустой список означает «эта установка сотрудников не отдаёт» (так отвечает
 * филиал), а отсутствие ключа — «в этом теле сотрудников нет вовсе». Второе и
 * есть правда про открытый ответ старому филиалу. Для приёмника оба варианта
 * одинаково безопасны (applyCatalogue не отключает никого по пустому списку),
 * но в отчётах и в глазах читающего дамп они говорят разное.
 *
 * Возвращает НОВЫЙ объект: вызывающий отдаёт его в res.json() и не должен
 * получить в руки испорченный снимок.
 */
export function withoutSealedTables(catalogue) {
  const out = { ...catalogue };
  for (const name of SEALED_ONLY_TABLES) delete out[name];
  return out;
}

// STAFF_SYNC_SEAL_V1 — как филиал говорит «я умею распечатать ответ».
//
// Живёт ЗДЕСЬ, рядом с withoutSealedTables, по той же причине, по которой
// CATALOGUE_PATH живёт в pairing.js: обе стороны обязаны брать имя из одного
// места, иначе они разойдутся на один символ и это будет выглядеть как «филиал
// почему-то не получает сотрудников». Отдающая сторона — routes/branch-sync.js,
// принимающая — pull.js, и обе смотрят сюда: зависимость идёт от маршрута к
// службе, а не наоборот.
export const ACCEPT_HEADER = 'x-em-branch-accept';
export const SEALED_FORM = 'sealed';

/**
 * Снимок справочника этой установки — то, что главный филиал отдаёт по сети.
 *
 * Строки берутся ЦЕЛИКОМ, включая active = 0. Снятая с продажи услуга обязана
 * доехать до филиала именно как снятая: пропустить её означало бы, что филиал
 * продолжает её продавать, а «удалить у себя то, чего нет у главного» этот этап
 * делать не будет (см. applyCatalogue — ничего не удаляем).
 */
export function exportCatalogue(db, { now = () => new Date() } = {}) {
  const out = {
    generated_at: now().toISOString(),
    doc_settings: null,
  };

  const settings = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get();
  if (settings) {
    const picked = {};
    for (const col of DOC_SETTINGS_COLUMNS) picked[col] = settings[col] ?? null;
    out.doc_settings = picked;
  }

  // BRANCH_ROSTER_V1 — кто есть в сети: буква -> имя.
  //
  // Имя филиала знает ТОЛЬКО главная клиника: его вводили там, заводя филиал.
  // Филиал же называл себя буквой, а строку главной клиники у себя держал под
  // засеянным «Main Branch» — на его экране стояли «C» и «Main Branch», одно
  // не имя, другое чужое (снимок владельца 2026-09-02). Ключ с именем (0.6.9)
  // чинит только НОВЫЕ подключения; этот список чинит уже подключённые при
  // первой же синхронизации и держит имена в согласии дальше.
  //
  // Только строки с буквой: без буквы это не узел сети, а адрес внутри одной
  // установки, и соседям он ни к чему.
  out.roster = db.prepare(
    "SELECT letter, name FROM branches WHERE letter IS NOT NULL AND letter <> '' ORDER BY letter"
  ).all().map((r) => ({ letter: r.letter, name: r.name || '' }));

  // STAFF_SYNC_V1 — СОТРУДНИКОВ ОТДАЁТ ТОЛЬКО ГЛАВНАЯ КЛИНИКА.
  //
  // Канал справочника односторонний по замыслу, но до сих пор это держалось на
  // том, кого КТО спрашивает: выгрузку зовут только два места, и оба — сторона
  // главного филиала. Для прайса цена ошибки — лишняя строка в справочнике; для
  // сотрудников это учётные записи с паролями, уехавшие в чужое здание, и
  // держать такое на договорённости нельзя. Здесь запрет записан в самом
  // сборщике: филиал (branch_identity.role = 'secondary', миграция 080) отдаёт
  // по этим таблицам ПУСТО, чем бы его ни спросили.
  //
  // Пустой список, а не отсутствующий ключ: приёмник читает выгрузку как
  // «таблица → строки», и таблица, которой в JSON нет вовсе, неотличима от
  // выгрузки старой версии — а это в applyCatalogue отдельный, противоположный
  // по смыслу случай («не трогай местное»). Пустой список говорит ровно то, что
  // есть: сотрудников эта установка не отдаёт.
  //
  // Незаполненная роль (строки branch_identity нет) считается главной — так же,
  // как её считает readIdentity в остальном коде: свежая установка ещё никем не
  // филиал.
  const identity = db.prepare('SELECT role FROM branch_identity WHERE id = 1').get();
  const isMain = !identity || identity.role !== 'secondary';

  for (const spec of TABLES) {
    if (spec.mainOnly && !isMain) { out[spec.name] = []; continue; }
    const cols = ['id', ...spec.columns].map((c) => `"${c}"`).join(', ');
    // Имена таблиц и колонок — из константы выше, не из запроса, поэтому
    // интерполяция здесь не строит SQL из пользовательского ввода (тот же
    // инвариант, что и в db/query-compiler.js: идентификаторы только из
    // белого списка, значения — только параметрами).
    out[spec.name] = db.prepare(`SELECT ${cols} FROM "${spec.name}" ORDER BY id`).all();
  }
  return out;
}

// Форма буквы узла — та же, что у letters.js (LETTER_MAX_CHARS) и identity.js.
// Своя копия, а не импорт: там это правило выдачи буквы, здесь — проверка
// того, что приехало по сети.
const ROSTER_LETTER_RE = /^[A-Z]{1,8}$/;

// Одинаковы ли значения, приехавшее и местное. SQLite вернёт цену как 250000
// (INTEGER) там, где JSON привёз 250000.0, а пустая строка и NULL в этих
// таблицах взаимозаменяемы по смыслу — без нормализации каждая синхронизация
// «находила» изменения там, где их нет, и делала бесконечный UPDATE всего
// справочника (и снимала бы резервную копию на каждый пустой прогон).
function sameValue(a, b) {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === null || nb === null) return na === nb;
  if (typeof na === 'number' || typeof nb === 'number') {
    const fa = Number(na); const fb = Number(nb);
    if (Number.isFinite(fa) && Number.isFinite(fb)) return fa === fb;
  }
  return String(na) === String(nb);
}

// «То же имя» для усыновления — ТА ЖЕ функция, которой редактор услуги решает
// «выбрать или создать» (NFC + trim + регистр + ё→е). Именно их согласие —
// несущая конструкция: имя, которое редактор считает существующей услугой,
// синхронизация обязана считать ею же. Поэтому не копия правила, а импорт.
const norm = normName;

/**
 * Приземлить справочник главного филиала в эту базу.
 *
 * ВЫЗЫВАТЬ ВНУТРИ ОДНОЙ ТРАНЗАКЦИИ (rpc/branch-sync.js так и делает) — половина
 * приехавшего прайса хуже, чем не приехавший вовсе.
 *
 * Три правила, каждое выбрано в сторону «не трогать чужое»:
 *
 * 1. НИЧЕГО НЕ УДАЛЯЕМ. Строки, которых у главного филиала нет, остаются как
 *    были. Локальная услуга может уже стоять в выставленных счетах и в
 *    оказанных визитах — удаление порвало бы историю, а «спрятать» её
 *    (active = 0) означало бы, что филиал перестал продавать то, что реально
 *    оказывает. Снять услугу с продажи главный филиал может явно: он
 *    выставляет active = 0 у себя, и это приезжает обычным обновлением.
 *
 *    ОДНО ИСКЛЮЧЕНИЕ, и оно тоже не удаление: СОТРУДНИК, пропавший из выгрузки
 *    главной клиники, ОТКЛЮЧАЕТСЯ здесь (spec.deactivateMissing, STAFF_SYNC_V1).
 *    Уволенного из ростера главной клиники убирают совсем, а не помечают, и
 *    филиал, оставивший его активным, продолжал бы пускать в систему человека,
 *    которому доступ закрыли. Строка при этом остаётся: за ней тянутся визиты и
 *    счета этого здания. Сотрудников, заведённых В ФИЛИАЛЕ (users.is_local = 1),
 *    это правило не касается вовсе.
 *
 * 2. УСЫНОВЛЕНИЕ ПЕРЕД ВСТАВКОЙ. Филиалы почти всегда заводят справочник
 *    руками ещё до связывания. Без этого шага первая же синхронизация
 *    удвоила бы весь прайс: два «Приём кардиолога», и регистратура выбирает
 *    из них наугад. Поэтому для несопоставленной чужой строки ищется
 *    местная — по коду, а если кода нет, по названию. Усыновление
 *    происходит, только когда кандидат РОВНО ОДИН и он ещё ни за кем не
 *    закреплён: при двух одинаковых названиях угадывать нечего, и создаётся
 *    новая строка.
 *
 * 3. dryRun ПРОГОНЯЕТ ТОТ ЖЕ КОД. «Изменится ли что-нибудь» решает не
 *    отдельный предсказатель (он разошёлся бы с реальным приёмом на первой же
 *    правке), а этот же проход с отключённой записью. Так «повторный запуск
 *    ничего не делает» — проверяемое свойство, и именно оно позволяет не
 *    снимать резервную копию на каждый пустой прогон.
 *
 * @returns {{changed:number, created:object, updated:object, adopted:object,
 *   settings:boolean, roster?:number, deactivated?:object}}
 */
export function applyCatalogue(db, payload, { dryRun = false } = {}) {
  const summary = { changed: 0, created: {}, updated: {}, adopted: {}, settings: false };
  if (!payload || typeof payload !== 'object') return summary;

  // ---- сведения о клинике (одна строка, id = 1) --------------------------
  if (payload.doc_settings && typeof payload.doc_settings === 'object') {
    const local = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get();
    if (local) {
      const changes = {};
      for (const col of DOC_SETTINGS_COLUMNS) {
        if (!(col in payload.doc_settings)) continue;
        // Разные версии на двух концах — нормальное состояние этого продукта, и
        // здесь оно опаснее в ОБЕ стороны. Пропуск сверху закрывает старого
        // ОТПРАВИТЕЛЯ («ключа нет — оставь местное»); эта строка закрывает
        // старого ПОЛУЧАТЕЛЯ: главный филиал уже обновлён и шлёт колонку,
        // которой у филиала ещё нет (первый такой случай — lab_scope, миграция
        // 085). Без неё UPDATE упал бы на «no such column», а приём справочника
        // идёт ОДНОЙ транзакцией — филиал перестал бы получать и прайс тоже,
        // пока не обновится. Колонка приедет со следующей синхронизацией, когда
        // миграция здесь применится.
        if (!(col in local)) continue;
        if (!sameValue(payload.doc_settings[col], local[col])) changes[col] = payload.doc_settings[col];
      }
      const keys = Object.keys(changes);
      if (keys.length) {
        summary.settings = true;
        summary.changed += 1;
        if (!dryRun) {
          const sets = keys.map((k) => `"${k}" = ?`).join(', ');
          db.prepare(`UPDATE doc_settings SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1`)
            .run(...keys.map((k) => changes[k]));
        }
      }
    }
  }

  // ---- имена филиалов (BRANCH_ROSTER_V1) --------------------------------------
  // Главная клиника — единственный источник имён (решение владельца 3:
  // справочное правит только главная). Совпадение по БУКВЕ, не по id: буквы
  // одинаковы во всей сети, локальные id — нет. Своя строка (буква из
  // branch_identity) и строка главной (A) переименовываются одинаково — это
  // одно правило, а не два.
  if (Array.isArray(payload.roster)) {
    // COLLATE NOCASE — ТА ЖЕ, что у поиска строки ниже (ревью 7/7b, M4).
    // Разъехавшись, эти два запроса делают именно то, чего список сети делать
    // не должен: строка ищется без учёта регистра и НАХОДИТСЯ, а
    // переименование ищет с учётом и не находит — филиал молча остаётся под
    // старым именем, и никакой ошибки при этом нет.
    const rename = db.prepare('UPDATE branches SET name = ? WHERE letter = ? COLLATE NOCASE');
    // BRANCH_RECORDS_V1 (Задача 7) — НЕЗНАКОМАЯ БУКВА ТЕПЕРЬ ЗАВОДИТСЯ, А НЕ
    // ПРОПУСКАЕТСЯ, и это не улучшение списка, а условие того, чтобы фаза
    // работала в сети больше двух зданий.
    //
    // Филиал знает ровно две строки: свою (её заводит identity.js при
    // активации) и главную (засеяна миграцией 080 под буквой A). О третьем
    // филиале он не узнаёт ниоткуда — а с Фазы 2 адрес журнала соседа
    // выводится из его БУКВЫ (relay.js journalPeers). Без этой вставки Филиал B и
    // Филиал C обменивались бы записями только через главную клинику... точнее,
    // НЕ обменивались вовсе: пересылки чужих записей в этом механизме нет
    // (applyBatch чистит свой хвост журнала), каждый узел говорит с каждым сам.
    //
    // active = 0 НАРОЧНО. Строка заводится, чтобы была ИЗВЕСТНА БУКВА
    // соседа, а не чтобы чужое здание появилось в выборе кабинетов этой
    // установки: членство исполнителей и карточка сотрудника сеют «все филиалы»
    // по `WHERE active = 1` (rpc/service-save.js), и тихое появление там чужого здания
    // было бы изменением поведения, о котором никто не просил. journalPeers
    // по `active` не фильтрует именно поэтому.
    //
    // Форма буквы проверяется та же, что в letters.js и identity.js: список приехал
    // снаружи, а UNIQUE-индекс по букве — NOCASE: кириллическая «С» или пустая
    // строка здесь стоила бы строки-призрака, которую нечем убрать.
    const adopt = db.prepare('INSERT INTO branches (name, letter, active) VALUES (?, ?, 0)');
    for (const entry of payload.roster) {
      if (!entry || typeof entry.letter !== 'string' || typeof entry.name !== 'string') continue;
      const name = entry.name.trim().slice(0, 120);
      if (!name) continue;
      const row = db.prepare('SELECT id, name FROM branches WHERE letter = ? COLLATE NOCASE').get(entry.letter);
      if (!row) {
        if (!ROSTER_LETTER_RE.test(entry.letter)) continue;
        summary.roster = (summary.roster || 0) + 1;
        summary.changed += 1;
        if (!dryRun) adopt.run(name, entry.letter);
        continue;
      }
      if (row.name === name) continue;
      summary.roster = (summary.roster || 0) + 1;
      summary.changed += 1;
      if (!dryRun) rename.run(name, entry.letter);
    }
  }

  // ---- карта соответствий -------------------------------------------------
  // Читается целиком в память: справочник клиники — это тысячи строк, не
  // миллионы, а тысяча точечных SELECT-ов внутри транзакции стоила бы дороже.
  const mapped = new Map();          // 'таблица:чужой id' -> свой id
  const claimed = new Map();         // 'таблица' -> Set(своих id, уже закреплённых)
  for (const row of db.prepare('SELECT table_name, remote_id, local_id FROM branch_sync_map').all()) {
    mapped.set(`${row.table_name}:${row.remote_id}`, row.local_id);
    if (!claimed.has(row.table_name)) claimed.set(row.table_name, new Set());
    claimed.get(row.table_name).add(row.local_id);
  }
  const claimSet = (t) => { if (!claimed.has(t)) claimed.set(t, new Set()); return claimed.get(t); };

  // Свои id раздаются подряд от этого счётчика только в dryRun: настоящие
  // выдаёт SQLite. Отрицательные — чтобы «выдуманный» id нельзя было спутать с
  // настоящим, если он куда-то просочится.
  let fakeId = -1;

  const insertMap = db.prepare(
    'INSERT INTO branch_sync_map (table_name, remote_id, local_id) VALUES (?, ?, ?) '
    + 'ON CONFLICT(table_name, remote_id) DO UPDATE SET local_id = excluded.local_id, '
    + "synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
  );
  const remember = (table, remoteId, localId) => {
    mapped.set(`${table}:${remoteId}`, localId);
    claimSet(table).add(localId);
    if (!dryRun) insertMap.run(table, remoteId, localId);
  };

  // Чужой id -> свой. Если у чужой строки соответствия нет вовсе (ссылка в
  // никуда — строка, которой у главного филиала уже нет), ставится NULL:
  // отказаться от всей услуги из-за отсутствующей категории было бы хуже, чем
  // принять её без категории.
  const resolveRef = (table, remoteId) => {
    if (remoteId === null || remoteId === undefined || remoteId === '') return null;
    return mapped.get(`${table}:${remoteId}`) ?? null;
  };

  for (const spec of TABLES) {
    const rows = Array.isArray(payload[spec.name]) ? payload[spec.name] : [];
    // Колонки, которые ставим сразу. Самоссылка (service_categories.parent_id)
    // откладывается: на первом проходе половина родителей ещё не существует.
    const firstPass = spec.columns.filter((c) => c !== spec.selfRef);

    // Кандидаты на усыновление — все свои строки таблицы, по одному чтению.
    const localRows = db.prepare(`SELECT * FROM "${spec.name}"`).all();

    for (const remote of rows) {
      if (!remote || typeof remote !== 'object' || remote.id === undefined || remote.id === null) continue;

      // ВЕРСИОННЫЙ ПЕРЕКОС — нормальное состояние: обновления приезжают
      // помашинно, и главный филиал может неделями отдавать выгрузку БЕЗ
      // колонки, которую эта база уже получила миграцией (первой так поехала
      // default_doctor_percent из 081). Отсутствующий ключ значит «экспортёр
      // старой версии», а не NULL: NULL валил бы INSERT об NOT NULL и затирал
      // бы местную настройку на UPDATE. Поэтому дальше участвуют только
      // колонки, которые в строке ДЕЙСТВИТЕЛЬНО есть — ровно тот же приём,
      // которым ветка doc_settings выше всегда и жила (`col in payload…`).
      const present = firstPass.filter((col) => col in remote);
      const values = {};
      for (const col of present) {
        values[col] = spec.refs[col] ? resolveRef(spec.refs[col], remote[col]) : (remote[col] ?? null);
      }

      let localId = mapped.get(`${spec.name}:${remote.id}`) ?? null;
      let localRow = localId != null ? localRows.find((r) => r.id === localId) : null;
      if (localId != null && !localRow) {
        // Соответствие есть, а строки нет: её удалили здесь руками. Считаем
        // строку несопоставленной и заводим заново — иначе UPDATE ушёл бы в
        // пустоту и справочник навсегда остался бы неполным.
        localId = null;
      }

      // --- усыновление -----------------------------------------------------
      if (localId == null) {
        // Первый ключ, который у приехавшей строки ЗАПОЛНЕН. Перечень берётся из
        // самой таблицы (spec.natural), а не из зашитого здесь ['code','name']:
        // у справочных таблиц это по-прежнему код, потом название, а у
        // сотрудников — логин (STAFF_SYNC_V1), и зашитый список молча не нашёл
        // бы его, превратив усыновление в дубль. Порядок в spec.natural и есть
        // порядок предпочтения.
        const key = spec.natural.find((k) => norm(remote[k]));
        if (key) {
          const scopeVal = spec.scopeRef ? values[spec.scopeRef] : undefined;
          const sameKey = localRows.filter((r) =>
            norm(r[key]) === norm(remote[key])
            && (!spec.scopeRef || r[spec.scopeRef] === scopeVal));
          const candidates = sameKey.filter((r) => !claimSet(spec.name).has(r.id));
          if (candidates.length === 1) {
            localId = candidates[0].id;
            localRow = candidates[0];
            remember(spec.name, remote.id, localId);
            summary.adopted[spec.name] = (summary.adopted[spec.name] || 0) + 1;
          } else if (spec.uniqueNatural && candidates.length === 0 && sameKey.length === 1) {
            // ЗАНЯТУЮ СТРОКУ ЗАБИРАЕМ, если ключ уникален в самой базе.
            //
            // Для услуги «кандидат уже за кем-то закреплён» безобидно: заводится
            // вторая строка, и худшее — дубль в прайсе. Для логина и роли это
            // UNIQUE-индекс: INSERT упал бы, а приём идёт ОДНОЙ транзакцией —
            // филиал перестал бы получать и прайс тоже, навсегда, потому что
            // каждая следующая синхронизация падала бы там же.
            //
            // Так происходит от устаревшей карты соответствий: филиал
            // перепривязали к пересобранной главной клинике, восстановили из
            // резервной копии — и branch_sync_map держит местного «ivanov» за
            // чужим id, которого больше не существует. Забрать строку и
            // переписать соответствие — единственный ответ, после которого
            // синхронизация продолжает работать; мёртвая запись карты просто
            // больше никем не спрашивается.
            localId = sameKey[0].id;
            localRow = sameKey[0];
            remember(spec.name, remote.id, localId);
            summary.adopted[spec.name] = (summary.adopted[spec.name] || 0) + 1;
          }
        }
        // Строка перешла под управление главной клиники — и, если это
        // усыновление, ИМЕННО СЕЙЧАС, до первого же UPDATE по ней. Метка
        // (users.is_local, миграция 086) — то, чем экран «Сотрудники» и
        // routes/users.js отличают «завели здесь» от «приехал сверху»; без неё
        // усыновлённый сотрудник остался бы редактируемым в филиале, и правка
        // молча исчезла бы при ближайшей синхронизации.
        //
        // И ЭТО СЧИТАЕТСЯ ИЗМЕНЕНИЕМ (ревью Фазы 3, I4). Раньше строка стояла
        // под `!dryRun` и никуда не попадала в summary — холостой прогон
        // недосчитывал ровно то, что происходит с людьми: усыновлённая строка,
        // совпадающая с местной колонка в колонку, давала changed = 0, и
        // rpc/branch-sync.js выходил раньше применения. То есть переход
        // сотрудника под управление главной клиники мог не случиться вовсе —
        // и при этом не быть названным на экране.
        if (localId != null && spec.localFlag && localRow[spec.localFlag] !== 0) {
          summary.changed += 1;
          if (!dryRun) {
            db.prepare(`UPDATE "${spec.name}" SET "${spec.localFlag}" = 0 WHERE id = ?`).run(localId);
          }
        }
      }

      // --- вставка ---------------------------------------------------------
      if (localId == null) {
        summary.created[spec.name] = (summary.created[spec.name] || 0) + 1;
        summary.changed += 1;
        if (dryRun) {
          remember(spec.name, remote.id, fakeId--);
        } else {
          // Только приехавшие колонки: отсутствующие получают умолчание своей
          // таблицы, как у любой местной вставки. Плюс метка происхождения
          // (STAFF_SYNC_V1): строка заведена не здесь, и умолчание колонки
          // (is_local = 1, «завели здесь») для неё как раз неверно.
          const insCols = spec.localFlag ? [...present, spec.localFlag] : present;
          const insVals = spec.localFlag ? [...present.map((c) => values[c]), 0] : present.map((c) => values[c]);
          const cols = insCols.map((c) => `"${c}"`).join(', ');
          const qs = insCols.map(() => '?').join(', ');
          const info = db.prepare(`INSERT INTO "${spec.name}" (${cols}) VALUES (${qs})`)
            .run(...insVals);
          remember(spec.name, remote.id, Number(info.lastInsertRowid));
        }
        continue;
      }

      // --- обновление ------------------------------------------------------
      const changedCols = localRow ? present.filter((c) => !sameValue(values[c], localRow[c])) : present;
      if (changedCols.length) {
        summary.updated[spec.name] = (summary.updated[spec.name] || 0) + 1;
        summary.changed += 1;
        if (!dryRun) {
          const sets = changedCols.map((c) => `"${c}" = ?`).join(', ');
          db.prepare(`UPDATE "${spec.name}" SET ${sets} WHERE id = ?`)
            .run(...changedCols.map((c) => values[c]), localId);
        }
      }
    }

    // --- исчезнувшие у главной клиники: ОТКЛЮЧИТЬ, а не удалить ------------
    //
    // Единственное место, где приём этого канала действует по ОТСУТСТВИЮ
    // строки, и включено оно ровно для сотрудников (spec.deactivateMissing).
    // Прайсу это не нужно и было бы вредно: услугу главная клиника снимает с
    // продажи явно, выставляя active = 0. Уволенного сотрудника из выгрузки
    // просто не станет — и филиал обязан узнать об этом сам, иначе человек,
    // которому вчера закрыли доступ, сегодня входит в системе второго здания.
    //
    // УДАЛИТЬ НЕЛЬЗЯ ФИЗИЧЕСКИ: за строкой тянутся визиты, счета, выданные
    // результаты и подписанные документы ЭТОГО здания. Отключение оставляет
    // историю целой и закрывает вход — ровно то, что и требуется.
    //
    // ТОЛЬКО СТРОКИ ГЛАВНОЙ КЛИНИКИ (localFlag = 0). Регистратор, нанятый в
    // филиале до всего этого, главной клинике неизвестен и остаётся работать:
    // это требование владельца, и проверяется оно по метке происхождения, а не
    // по «нет в карте соответствий» — карту чистят при отвязке, метку нет.
    //
    // ПУСТАЯ ВЫГРУЗКА НИКОГО НЕ ОТКЛЮЧАЕТ (`rows.length`). Ключа может не быть
    // вовсе — это главная клиника старой версии; список может приехать пустым —
    // так отвечает установка-филиал (см. exportCatalogue). Ни то ни другое не
    // означает «в клинике не осталось сотрудников», а последствие было бы
    // необратимым в худшем смысле: здание, где ни один человек не может войти.
    if (spec.deactivateMissing && spec.localFlag && rows.length) {
      const seen = new Set();
      for (const remote of rows) {
        const id = remote && remote.id !== undefined ? mapped.get(`${spec.name}:${remote.id}`) : null;
        if (id != null) seen.add(id);
      }
      const live = db.prepare(
        `SELECT id FROM "${spec.name}" WHERE "${spec.localFlag}" = 0 AND "${spec.deactivateMissing}" <> 0`,
      ).all();
      for (const row of live) {
        if (seen.has(row.id)) continue;
        summary.deactivated = summary.deactivated || {};
        summary.deactivated[spec.name] = (summary.deactivated[spec.name] || 0) + 1;
        summary.changed += 1;
        if (!dryRun) {
          db.prepare(`UPDATE "${spec.name}" SET "${spec.deactivateMissing}" = 0 WHERE id = ?`).run(row.id);
        }
      }
    }

    // --- второй проход: самоссылка ----------------------------------------
    if (spec.selfRef) {
      const after = dryRun ? localRows : db.prepare(`SELECT * FROM "${spec.name}"`).all();
      for (const remote of rows) {
        const localId = mapped.get(`${spec.name}:${remote.id}`);
        if (localId == null) continue;
        // Тот же версионный перекос, что и выше: строка без этой колонки —
        // старый экспортёр, местное значение остаётся.
        if (!remote || !(spec.selfRef in remote)) continue;
        const want = resolveRef(spec.refs[spec.selfRef], remote[spec.selfRef]);
        const have = after.find((r) => r.id === localId)?.[spec.selfRef] ?? null;
        // В dryRun у только что «вставленных» строк локальной копии нет, и have
        // будет undefined -> null: это и есть честный ответ «значение изменится».
        if (sameValue(want, have)) continue;
        summary.updated[spec.name] = (summary.updated[spec.name] || 0) + 1;
        summary.changed += 1;
        if (!dryRun) db.prepare(`UPDATE "${spec.name}" SET "${spec.selfRef}" = ? WHERE id = ?`).run(want, localId);
      }
    }
  }

  return summary;
}
