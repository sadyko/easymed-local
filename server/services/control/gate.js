import { controlState } from './state.js';

// LICENCE_CORE_V1 — the enforcement point.
//
// Enforced on the SERVER, in the two places every write already funnels through.
// Hiding buttons in the browser would be decoration: the API is reachable with
// curl from any PC on the clinic's network.
//
// 402 Payment Required is used deliberately. It is the one status whose meaning
// is exactly this, and it keeps a licence lapse distinguishable from 401 (log in
// again) and 403 (your role may not) — three different problems with three
// different fixes, which the UI must not confuse.

// RPCs that only read. Everything absent from this set is treated as a write.
//
// FAILS CLOSED ON PURPOSE. When someone adds an RPC next year and never reads
// this file, the failure mode is "it stops working during a lapse" — noticed
// immediately, fixed in one line. The alternative default would silently leave a
// hole open for as long as nobody looked.
const READ_ONLY_RPCS = new Set([
  'dashboard_summary', 'reports_overview', 'run_report', 'owner_report',
  // BUILDING_REPORTS_V1 — перечень зданий для выборки в «Отчётах». Чистое
  // чтение справочного порядка, как reports_overview рядом: клиника с
  // просроченной лицензией читает отчёты, и «читает» не должно означать
  // «конструктор без списка зданий».
  'report_buildings',
  // BUILDING_FRESHNESS_V1 — «данные ещё едут»: счётчики ожиданий и отказов по
  // зданиям. Чистое чтение, и для заблокированной клиники оно тем важнее:
  // молчащее здание и просроченная лицензия — две разные беды с двумя разными
  // починками, и путать их нельзя.
  'report_freshness',
  'cashier_invoices', 'cash_shift_summary', 'shift_report', 'cashier_report',
  'callcenter_report', 'queue_board', 'documents_feed', 'accommodation_state',
  'deposit_balance', 'list_deposits', 'service_delete_check', 'get_clinic_by_slug',
  'telegram_settings_get', 'telegram_links_list', 'telegram_deliveries_list',
  'telegram_stats', 'telegram_broadcast_status', 'telegram_broadcast_history',
  'telegram_chats_list', 'telegram_chat_messages', 'telegram_chat_unread',
  // UPDATE_DELIVERY_V1 — the approval screen's own status read; it changes
  // nothing, only reports the offer/approval/schedule/last result.
  'update_status',
  // LAB_STATS_V1 — usage counters for the lab's panels and services. A pure
  // read with no money in it — the same category as reports_overview above.
  'lab_usage_stats',
  // CRM_CONFIG_V1 — the kanban's own vocabulary (columns, sources, call
  // routing). A pure read, and the board cannot be drawn without it: a
  // licence-lapsed clinic may read but not write, and "read" must not mean
  // "a CRM board with no column headings".
  'crm_config_get',
  // CUSTDEV_V1 — доска и отчёт по обзвону. Чистое чтение. Клиника с
  // просроченной лицензией читает, но не пишет, и «читает» не должно означать
  // «пустой экран вместо доски». Оценка (custdev_rate/custdev_mark) и
  // досоздание карточек (custdev_sync) сюда НЕ входят — это записи.
  'custdev_list', 'custdev_report',
  // PROC_PERFORMER_V1 — очередь процедур. Чистое чтение, и клинике с
  // просроченной лицензией оно важно ровно так же, как отчёты рядом: медсестра
  // должна видеть, что ей назначено. Назначение исполнителя и отметка о
  // выполнении сюда НЕ входят — это записи.
  'procedures_list',
  // PATIENT_TAB_ACCESS_V1 — содержимое карты пациента по вкладкам. Чистое
  // чтение, и заблокированной клинике оно нужно ровно потому, что лицензия его
  // не отнимает: свои записи она читает свободно и не меняет ничего. Запись
  // (patient_card_save / _doc_add / _doc_delete / _set_doctor) сюда НЕ входит.
  'patient_card',
  // BRANCH_SYNC_V1 — состояние связи филиалов на экране «Настройки → Филиалы».
  // Чистое чтение: роль установки, адрес главного филиала и даты последних
  // попыток. Заблокированная клиника обязана видеть, ПОЧЕМУ справочник не
  // приезжает, — иначе к проблеме с лицензией добавляется вторая загадка.
  // Приём справочника (branch_sync_now) и связывание сюда НЕ входят: это
  // записи, и через блокировку они не проходят.
  'branch_sync_status',
  // INPATIENT_FLOW_V1 — где пациент на маршруте госпитализации и что этому
  // человеку с ним можно. Ничего не меняет, а для заблокированной клиники это
  // тем важнее: пациент в койке, и отделение обязано видеть его состояние даже
  // тогда, когда записи закрыты. Сами шаги маршрута — записи и сюда не входят.
  'admission_flow_state',
  // INPATIENT_REVIEW_V1 — врачебные записи госпитализации и набор прав роли.
  // Оба только читают. Заблокированной клинике первичный осмотр её лежащего
  // пациента нужен тем более: подписка кончилась, а история болезни — документ,
  // а не услуга. Сами осмотр и назначение лечащего врача — записи, и сюда не
  // входят.
  'admission_reviews_list', 'inpatient_capabilities',
  // …и справочник «кого можно назначить лечащим». Тоже только читает, и
  // клинике с просроченной подпиской он нужен ровно затем, зачем ей открыт
  // осмотр: увидеть список она обязана, а назначить (это запись) — не сможет,
  // и отказ придёт про подписку, а не про «в клинике нет врачей».
  'admission_attending_candidates',
  // TREATMENT_ORDERS_V1 — лист назначений и список задач медсестры на смену.
  // Оба ничего не меняют, и для заблокированной клиники это тем важнее:
  // пациент в койке получает лечение по часам, и не видеть, что ему назначено
  // и что просрочено, отделение не может ни одной смены. Сами отметки
  // (treatment_admin_mark/unmark) и назначения — записи, и сюда не входят.
  'treatment_orders_list', 'treatment_tasks_due',
  // DIET_TABLES_V1 — справочник столов, история стола, лист питания и
  // ПОРЦИОННИК. Заказ на кухню — тот документ, который клинике с просроченной
  // подпиской нужен раньше всех прочих: пациенты в койках, и завтрак им варят
  // независимо от состояния счёта. Сама смена стола и отметка приёма пищи —
  // записи, и сюда не входят.
  'diet_tables_list', 'admission_diet_history', 'admission_meals_list', 'kitchen_sheet',
  // TWO_STEP_DISCHARGE_V1 — очередь «Выписки к оформлению»: кого сегодня
  // отпускают, с каким исходом и с каким остатком по счёту. Только читает.
  // Заблокированной клинике этот список нужен тем более: пациенты в койках, и
  // не выписать их из-за состояния ПОДПИСКИ значит держать людей в больнице за
  // чужой долг. Сами два шага выписки — записи, и сюда они не входят.
  'admission_discharge_queue',
  // CALENDAR_BOOKING_V1 — свободные слоты врача/кабинета на день. Только
  // читает: график, обед, часы клиники и уже занятое. Заблокированной клинике
  // это нужно тем более — пациенты УЖЕ записаны и придут завтра, и не видеть
  // собственного расписания она не может ни одного дня. Сама запись
  // (calendar_book) сюда НЕ входит: это запись, и через блокировку она не
  // проходит.
  'calendar_slots', 'calendar_windows',
]);

// The way back in. These must work while locked or a clinic that wants to pay
// has no route to doing so — the reason login itself stays open.
const ALWAYS_ALLOWED_RPCS = new Set([
  'licence_status', 'licence_unlock', 'module_request',
  // ENROLLMENT_SCREEN_V1 — the first-run "type the EM- code" screen. A
  // never-enrolled install is locked (reason not_enrolled), so without this
  // line the one RPC that ends that state would 402 against it.
  'licence_enroll',
  // UPDATE_DELIVERY_V1 — a licence-lapsed clinic must still be able to
  // receive an update: the update may be exactly what the vendor ships to
  // fix the clinic's own situation (a licensing bug, a billing-flow fix),
  // and approving/cancelling it is vendor-relations, not clinical data —
  // the same category as the three RPCs above, not a write this gate exists
  // to hold back. tickUpdater's own pipeline (download/verify/stage/apply)
  // is not reached through this gate at all — it runs off a timer, not an
  // HTTP request — so this only ever governs whether the ADMIN can still
  // see the offer and say yes/no to it while locked.
  'update_approve', 'update_cancel',
  // «Проверить обновления» — triggers an immediate check-in. The check-in is
  // the very mechanism that renews a licence and delivers module grants, so
  // for a locked clinic this button is the recovery path itself: an admin who
  // just fixed the router (or just paid) presses it and gets unlocked NOW
  // instead of waiting for the daily timer. Blocking it at 402 would be
  // locking the clinic out of the one action that ends the lock.
  'update_check_now',
  // SYSTEM_SETTINGS_V1 — the backup/restore/reset block. A licence-lapsed
  // clinic must still be able to SAVE its data, and a decommissioned one to
  // erase itself — a lock that stands between a clinic and its own data would
  // turn a billing dispute into data hostage-taking. Safety does not depend
  // on this gate: all four re-check the admin role in their handlers
  // (rpc/backup.js), and the two destructive ones re-verify the caller's own
  // password with bcrypt on top. backup_list fits READ_ONLY_RPCS' letter, but
  // it travels with its three siblings so the feature is one findable block
  // with one reasoning.
  'backup_list', 'backup_create', 'backup_restore', 'factory_reset',
]);

export function isReadOnlyRpc(name) { return READ_ONLY_RPCS.has(name); }
export function isAlwaysAllowedRpc(name) { return ALWAYS_ALLOWED_RPCS.has(name); }

/** Resolved once per request, after the user is known and before any route can write. */
export function attachControl(db, dataDir) {
  return (req, res, next) => {
    try { req.control = controlState(db, dataDir); }
    catch (e) {
      // controlState is documented never to throw and is tested against twelve
      // corruption scenarios. If it ever does, a licensing bug must not take the
      // clinic down with it.
      console.warn('[licence] state unavailable:', e.message);
      req.control = { locked: false, modules: [], has: () => true, state: 'ok', reason: 'error', daysLeft: 0 };
    }
    next();
  };
}

// The message depends on WHY, and getting this wrong is the failure this whole
// feature was designed to avoid: a clinic that has PAID, whose router died, must
// never be told it owes money. The two lock states are mechanically identical and
// must read completely differently.
//
// This shipped hardcoded to the money wording and was caught in review — a paid
// but offline clinic saving a patient card got "Подписка не активна". The default
// below is deliberately the NEUTRAL message, not the money one: a call site that
// forgets to pass `control` should under-accuse, never over-accuse.
const LOCKED_MESSAGES = {
  unpaid:       'Подписка не активна. Обратитесь к менеджеру Easy-Med.',
  offline:      'Нет связи с Easy-Med. Проверьте интернет — изменения временно недоступны.',
  unlicensed:   'Система не активирована. Обратитесь к менеджеру Easy-Med.',
  not_enrolled: 'Система не активирована. Обратитесь к менеджеру Easy-Med.',
};
const LOCKED_DEFAULT = 'Изменения временно недоступны. Обратитесь к менеджеру Easy-Med.';

export function lockedResponse(res, control) {
  const reason = control && control.reason;
  return res.status(402).json({
    error: {
      code: 'licence_locked',
      reason: reason || 'unknown',
      message: LOCKED_MESSAGES[reason] || LOCKED_DEFAULT,
    },
  });
}
