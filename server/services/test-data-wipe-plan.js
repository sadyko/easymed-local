// TEST_DATA_WIPE_V1 (docs/specs/2026-10-29-3190-refund-swap-test-wipe-design.md,
// раздел 3) — «Удалить тестовые данные»: РЕШЕНИЕ ПО КАЖДОЙ ТАБЛИЦЕ БАЗЫ.
//
// Владелец (2026-10-29): клиника, которая учится на выдуманных пациентах,
// убирает учебные визиты, деньги и движения склада, не теряя настроек.
// КАРТЫ ПАЦИЕНТОВ И CRM ОСТАЮТСЯ; настройки, роли, права, сотрудники, услуги,
// цены, лабораторные панели, приборы, кабинеты и койки, шаблоны, подключения
// и лицензия не трогаются.
//
// Здесь только решения — без кода удаления (его делает test-data-wipe.js).
// Каждая таблица схемы — ровно одно решение:
//   delete  — все строки удаляются;
//   partial — удаляются строки под условием `where`; у оставшихся можно
//             сбросить значения (`reset`: { set, where });
//   clear   — строки остаются, ссылки и значения сбрасываются (`set`, `where`);
//   sync    — служебные таблицы связи зданий: убирается только то, что
//             написало само удаление (test-data-wipe.js wipeSyncTraces);
//   keep    — не трогается.
// Условия — неизменный текст этого файла, ни одно значение не приходит из
// запроса.
//
// ЗАЩИТА ОТ БУДУЩИХ ТАБЛИЦ (тест test-data-wipe-plan.test.js): каждая таблица
// базы, собранной миграциями, должна быть здесь, и ни одной лишней. Новая
// таблица без решения роняет сборку — как охват объединения пациентов
// (rpc/patient-merge.test.js).
//
// sqlite_sequence не таблица данных: удаление его не трогает НИКОГДА. От
// visit_services.id зависят штрихкоды проб и ответы анализаторов — номер
// строки, выданный однажды, не должен достаться новой пробе.

const del = (group) => Object.freeze({ how: 'delete', group });
const keep = (why) => Object.freeze({ how: 'keep', why });

// Записи журнала действий пациента, которые относятся к визитам и деньгам.
// Их пишет экран (views/activity-log.js logPatientActivity). Сервер пишет ещё
// записи о самой карте — entity_type 'patient' без visit_id (объединение карт,
// rpc/patient-merge.js logMerged; встречное объединение в связи зданий,
// branch-sync/records.js logMergeConflict): условие их не задевает, они
// остаются вместе с картой.
const VISIT_ACTIVITY_TYPES = "('visit','service','item','invoice','recommendation')";

export const TABLE_PLAN = Object.freeze({
  // ── визиты и всё, что под ними ─────────────────────────────────────────
  visits: del('visits'),
  visit_services: del('visits'),
  service_queue_tickets: del('visits'),
  recommended_services: del('visits'),
  patient_vitals: del('visits'),
  custdev_cards: del('visits'),
  doctor_bot_notifications: del('visits'),
  patient_activity_log: Object.freeze({
    how: 'partial', group: 'visits',
    where: `visit_id IS NOT NULL OR entity_type IN ${VISIT_ACTIVITY_TYPES}`,
  }),

  // ── лаборатория ────────────────────────────────────────────────────────
  lab_results: del('lab'),
  lab_device_messages: del('lab'),

  // ── документы визитов (файлы — test-data-wipe.js removeVisitDocFiles) ─
  visit_documents: del('documents'),
  telegram_deliveries: del('documents'),

  // ── стационар ──────────────────────────────────────────────────────────
  admissions: del('inpatient'),
  admission_diets: del('inpatient'),
  admission_meals: del('inpatient'),
  admission_prescriptions: del('inpatient'),
  admission_reviews: del('inpatient'),
  admission_services: del('inpatient'),
  admission_title_sheets: del('inpatient'),
  admission_transfers: del('inpatient'),
  admission_vitals: del('inpatient'),
  med_administrations: del('inpatient'),
  treatment_orders: del('inpatient'),
  treatment_administrations: del('inpatient'),
  // Койки остаются; занятые и «на уборке» после учебных пациентов — свободны.
  beds: Object.freeze({ how: 'clear', group: 'inpatient', set: "status = 'free'", where: "status IN ('occupied','cleaning')" }),

  // ── деньги ─────────────────────────────────────────────────────────────
  invoices: del('money'),
  invoice_items: del('money'),
  payments: del('money'),
  invoice_audit_log: del('money'),
  cash_shifts: del('money'),
  cash_movements: del('money'),
  patient_deposits: del('money'),
  card_ledger: del('money'),
  pay_refund_releases: del('money'),
  pay_periods: del('money'),
  pay_period_lines: del('money'),
  pay_period_log: del('money'),
  money_idempotency: del('money'),
  // Номера счетов, депозитов и продаж карт снова с 1 (INV-…-00001):
  // счётчик года заводится заново при первом номере (billing.js nextInvoiceNumber).
  invoice_counters: del('money'),
  deposit_counters: del('money'),
  card_sale_counters: del('money'),
  // Карты, проданные в кассе, — деньги (sale_invoice_id); заведённые в
  // настройках остаются, их остаток — снова номинал (журнала карты больше нет;
  // та же формула, что у триггера patient_discounts_card_remaining_upd).
  patient_discounts: Object.freeze({
    how: 'partial', group: 'money',
    where: 'sale_invoice_id IS NOT NULL',
    reset: Object.freeze({
      set: 'remaining = MAX(amount, 0)',
      where: "kind IN ('gift_card','certificate') AND remaining IS NOT MAX(amount, 0)",
    }),
  }),

  // ── склад ──────────────────────────────────────────────────────────────
  stock_movements: del('stock'),
  stock_holdings: del('stock'),
  stock_counts: del('stock'),
  stock_count_items: del('stock'),
  stock_pending_writeoffs: del('stock'),
  stock_issue_receipts: del('stock'),
  purchase_orders: del('stock'),
  purchase_order_items: del('stock'),
  purchase_requisitions: del('stock'),
  purchase_requisition_items: del('stock'),
  // Остатки товаров — с нуля: настоящий приход вносится заново.
  products: Object.freeze({ how: 'clear', group: 'stock', set: 'on_hand = 0, avg_cost = 0', where: 'on_hand <> 0 OR avg_cost <> 0' }),

  // ── онлайн-запись (брони) ──────────────────────────────────────────────
  // Заявки «перезвоните» (kind = 'request') — вход в CRM, остаются; брони —
  // нет. У оставшихся ссылку на визит снимает внешний ключ (ON DELETE SET NULL).
  api_requests: Object.freeze({ how: 'partial', group: 'booking', where: "kind = 'appointment'" }),
  api_outbox: Object.freeze({
    how: 'partial', group: 'booking',
    where: "api_request_id IN (SELECT id FROM api_requests WHERE kind = 'appointment')",
  }),
  slot_holds: del('booking'),

  // ── связи CRM с удалёнными визитами (карточки остаются) ────────────────
  crm_booking_links: del('crm_links'),
  crm_booking_undo: del('crm_links'),
  crm_card_visit_views: del('crm_links'),
  // Строки карточек остаются со своим статусом и днём; снимаются только ссылки
  // на визит и строку визита (у двух последних нет внешнего ключа — мигр.
  // 187, 246). В отличие от discardEmptyVisit (rpc/visits.js), удаление НЕ
  // возвращает карточки CRM на прежние стадии: не проигрывает crm_booking_undo,
  // не переводит строки 'done' обратно в 'pending' и не удаляет карточки,
  // заведённые самой записью. Решение владельца 2026-10-30: CRM остаётся ровно
  // такой, какая есть; карточку с удалённой учебной записью обычный ежечасный
  // проход может потом перевести в «Не пришёл».
  crm_request_services: Object.freeze({
    how: 'clear', group: 'crm_links',
    set: 'visit_id = NULL, visit_service_id = NULL, visit_service_auto = 0, '
      + 'released_from_visit_id = NULL, released_vs_id = NULL, released_held = 0',
    where: 'visit_id IS NOT NULL OR visit_service_id IS NOT NULL OR visit_service_auto <> 0 '
      + 'OR released_from_visit_id IS NOT NULL OR released_vs_id IS NOT NULL OR released_held <> 0',
  }),

  // ── связь зданий: только следы самого удаления ─────────────────────────
  sync_journal: Object.freeze({ how: 'sync' }),
  sync_tombstones: Object.freeze({ how: 'sync' }),
  sync_seen: Object.freeze({ how: 'sync' }),
  sync_pending: Object.freeze({ how: 'sync' }),
  sync_refused: Object.freeze({ how: 'sync' }),
  // Авторство и отчеканенные номера удалённых строк убирают сами триггеры
  // *_journal_del / invoices_minted_del (миграции 084, 087, 090).
  sync_authored: keep('sync'),
  sync_minted: keep('sync'),
  sync_peers: keep('sync'),
  branch_identity: keep('sync'),
  branch_letters_spent: keep('sync'),
  branch_sync_map: keep('sync'),

  // ── карты пациентов ────────────────────────────────────────────────────
  patients: keep('patients'),
  patient_guardians: keep('patients'),
  patient_relationships: keep('patients'),
  patient_conditions: keep('patients'),
  patient_merges: keep('patients'),

  // ── CRM, звонки, Telegram, Meta ────────────────────────────────────────
  crm_requests: keep('crm'),
  crm_request_tags: keep('crm'),
  crm_tasks: keep('crm'),
  crm_tags: keep('crm'),
  crm_stages: keep('crm'),
  crm_sources: keep('crm'),
  crm_settings: keep('crm'),
  crm_call_routing: keep('crm'),
  crm_conversion_log: keep('crm'),
  crm_merge_log: keep('crm'),
  crm_one_way_repair_log: keep('crm'),
  crm_unify_repair_log: keep('crm'),
  calls: keep('crm'),
  meta_leads: keep('crm'),
  meta_form_cursors: keep('crm'),
  telegram_links: keep('crm'),
  telegram_messages: keep('crm'),
  telegram_broadcasts: keep('crm'),
  telegram_broadcast_targets: keep('crm'),
  telegram_chat_folders: keep('crm'),
  telegram_chat_folder_items: keep('crm'),
  telegram_deeplinks: keep('crm'),
  telegram_deeplink_hits: keep('crm'),
  telegram_deeplink_leads: keep('crm'),
  doctor_bot_links: keep('crm'),

  // ── сотрудники, роли, права ────────────────────────────────────────────
  users: keep('staff'),
  user_branches: keep('staff'),
  user_specialties: keep('staff'),
  sessions: keep('staff'),
  roles: keep('staff'),
  custom_roles: keep('staff'),
  role_permissions: keep('staff'),
  role_grant_reviews: keep('staff'),
  role_permission_reviews: keep('staff'),
  positions: keep('staff'),
  doctor_rates: keep('staff'),
  doctor_conditions: keep('staff'),
  virtual_doctors: keep('staff'),
  act_as_sessions: keep('staff'),
  act_as_actions: keep('staff'),

  // ── справочники: услуги, цены, лаборатория, склад ──────────────────────
  services: keep('catalog'),
  service_categories: keep('catalog'),
  service_types: keep('catalog'),
  service_templates: keep('catalog'),
  consultation_types: keep('catalog'),
  doctor_consultation_prices: keep('catalog'),
  lab_panels: keep('catalog'),
  lab_panel_analytes: keep('catalog'),
  lab_panel_templates: keep('catalog'),
  lab_panel_template_analytes: keep('catalog'),
  lab_analyte_templates: keep('catalog'),
  icd10: keep('catalog'),
  ikpu_codes: keep('catalog'),
  product_nnm: keep('catalog'),
  suppliers: keep('catalog'),
  item_suppliers: keep('catalog'),
  units: keep('catalog'),
  diet_tables: keep('catalog'),
  chronic_conditions_ref: keep('catalog'),
  patient_categories: keep('catalog'),
  payers: keep('catalog'),
  payer_policies: keep('catalog'),
  referral_sources: keep('catalog'),
  referral_source_categories: keep('catalog'),
  referral_rewards: keep('catalog'),
  countries: keep('catalog'),
  regions: keep('catalog'),
  districts: keep('catalog'),

  // ── настройки, подключения, приборы, кабинеты ──────────────────────────
  branches: keep('settings'),
  companies: keep('settings'),
  departments: keep('settings'),
  department_events: keep('settings'),
  floors: keep('settings'),
  rooms: keep('settings'),
  room_equipment: keep('settings'),
  equipment: keep('settings'),
  wards: keep('settings'),
  doc_settings: keep('settings'),
  doc_branding: keep('settings'),
  case_doc_types: keep('settings'),
  consultation_templates: keep('settings'),
  cashback_rules: keep('settings'),
  payment_providers: keep('settings'),
  stock_settings: keep('settings'),
  stock_settings_log: keep('settings'),
  stock_minimums: keep('settings'),
  lab_devices: keep('settings'),
  api_connections: keep('settings'),
  api_journal: keep('settings'),
  api_settings: keep('settings'),
  api_sync_state: keep('settings'),
  api_tokens: keep('settings'),
  meta_settings: keep('settings'),
  telegram_settings: keep('settings'),
  doctor_bot_settings: keep('settings'),
  telephony_settings: keep('settings'),
  telephony_providers: keep('settings'),
  nav_visibility: keep('settings'),
  module_requests: keep('settings'),
  tariffs: keep('settings'),

  // ── служебные ──────────────────────────────────────────────────────────
  schema_migrations: keep('service'),
  control_state: keep('service'),          // лицензия, часы связи зданий
  ops_events: keep('service'),             // статистика без данных пациентов
  telegram_state: keep('service'),
  doctor_bot_state: keep('service'),
  referral_source_counter: keep('service'),
  referral_rate_migration_log: keep('service'),
  // Отметки разовых исправлений CRM: без них исправление прошло бы снова.
  crm_one_way_repair: keep('service'),
  crm_unify_repair: keep('service'),
  // Разрешения серверных дверей баланса — пусты после каждого запуска
  // (server/index.js чистит их сразу после миграций).
  ledger_write_token: keep('service'),
  merge_money_moves: keep('service'),
});

// Порядок шагов. Сначала то, что смотрит на ещё живые строки (журнал действий
// по visit_id, сброс ссылок CRM), потом удаление от детей к родителям: каждая
// таблица уходит раньше той, на которую ссылается. Цикл admissions.invoice_id ↔
// invoices.admission_id разрешает отложенная проверка ключей
// (test-data-wipe.js: PRAGMA defer_foreign_keys).
export const WIPE_ORDER = Object.freeze([
  'crm_request_services', 'products', 'beds', 'patient_activity_log',
  'stock_pending_writeoffs', 'stock_issue_receipts', 'stock_count_items', 'stock_counts',
  'stock_holdings', 'stock_movements',
  'purchase_order_items', 'purchase_requisition_items', 'purchase_requisitions', 'purchase_orders',
  'treatment_administrations', 'treatment_orders', 'med_administrations',
  'admission_diets', 'admission_meals', 'admission_prescriptions', 'admission_reviews',
  'admission_title_sheets', 'admission_transfers', 'admission_vitals', 'admission_services',
  'lab_results', 'lab_device_messages', 'telegram_deliveries', 'visit_documents',
  'service_queue_tickets', 'recommended_services', 'patient_vitals', 'custdev_cards',
  'doctor_bot_notifications', 'crm_booking_links', 'crm_booking_undo', 'crm_card_visit_views',
  'api_outbox', 'slot_holds', 'api_requests',
  'card_ledger', 'patient_discounts',
  'pay_refund_releases', 'pay_period_lines', 'pay_period_log', 'pay_periods', 'money_idempotency',
  'patient_deposits', 'payments', 'cash_movements', 'cash_shifts',
  'visit_services', 'invoice_audit_log', 'invoice_items', 'admissions', 'invoices', 'visits',
  'invoice_counters', 'deposit_counters', 'card_sale_counters',
]);

// Триггеры-запреты, которые удаление снимает на время своей транзакции и
// ставит обратно тем же текстом из sqlite_master (мигр. 160: строку баланса с
// деньгами удалить нельзя — «её можно только вернуть»). Откат транзакции
// возвращает и триггер.
export const GUARD_TRIGGERS = Object.freeze({
  patient_deposits: Object.freeze(['patient_deposits_no_delete']),
});

// ВСЕ триггеры, которые срабатывают от самого удаления (событие DELETE на
// удаляемых и частично удаляемых таблицах). Каждый просмотрен: что он пишет и
// куда. Новый триггер роняет тест, пока его не просмотрят и не впишут сюда, —
// иначе удаление могло бы молча писать в оставляемую таблицу.
//   *_journal_del (мигр. 084, 087) — пишут удаление в sync_journal и
//     sync_tombstones (следы самого удаления, их убирает wipeSyncTraces) и
//     стирают авторство удалённой строки в sync_authored;
//   invoices_minted_del (мигр. 090) — стирает отчеканенный номер счёта в
//     sync_minted;
//   admission_services_pending_cancel (мигр. 226) — отменяет ждущие списания
//     в stock_pending_writeoffs; их удаление уносит раньше (WIPE_ORDER),
//     менять уже нечего;
//   patient_deposits_no_delete (мигр. 160) — запрет, GUARD_TRIGGERS выше.
export const DELETE_TRIGGERS = Object.freeze({
  visits: Object.freeze(['visits_journal_del']),
  visit_services: Object.freeze(['visit_services_journal_del']),
  lab_results: Object.freeze(['lab_results_journal_del']),
  invoices: Object.freeze(['invoices_journal_del', 'invoices_minted_del']),
  invoice_items: Object.freeze(['invoice_items_journal_del']),
  payments: Object.freeze(['payments_journal_del']),
  admission_services: Object.freeze(['admission_services_pending_cancel']),
  patient_deposits: Object.freeze(['patient_deposits_no_delete']),
});

/** Таблицы с данным решением. */
export function tablesBy(how) {
  return Object.keys(TABLE_PLAN).filter((t) => TABLE_PLAN[t].how === how);
}
