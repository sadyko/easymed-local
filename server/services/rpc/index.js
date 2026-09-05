// Registry of server-side RPC handlers. Each is (db, args, user) => result.
// The 25 legacy Postgres functions are ported per-module in later Phase-2
// slices (dispensing, discounts, queue numbers, …).
import { createInvoiceForVisit, recordPayment, recordPaymentSplit, markInvoiceDebt, changeUnpaidService, removeUnpaidService, refundPayment, createInvoiceForAdmission, removeAdmissionLineFromInvoice } from './billing.js';
import { receiveStock, dispenseItem, voidDispense, dispenseAdmissionItem, voidDispensedAdmissionItem } from './inventory.js';
import { dashboardSummary } from './dashboard.js';
import { receiveStockLines, adjustStock, receivePurchaseOrder, approveRequisitionAndIssue, postStockCount, issueStockLines, importProductsExcel } from './procurement.js';
import { reportsOverview, runReport, ownerReport, reportBuildings, reportFreshness } from './reports.js';   // BUILDING_REPORTS_V1 / BUILDING_FRESHNESS_V1
import { openCashShift, closeCashShift, cashShiftSummary, cashMove, shiftReport, cashierInvoices, voidInvoice, deleteInvoice } from './cashier.js';
import { admitPatient, dischargePatient, setBedStatus, requestAdmission, transferAdmission, setAdmissionDiscount, cancelAdmissionRequest, admissionOrderCreate, admissionOrderCancel, admissionAdmit,
  admissionDischargeRequest, admissionDischargeCancelRequest, admissionDischargeFinalize, admissionDischargeQueue } from './inpatient.js';   // ADMISSION_ORDER_V1 / TWO_STEP_DISCHARGE_V1
import { admissionFlowState, inpatientCapabilities } from './inpatient-flow.js';   // INPATIENT_FLOW_V1
import { admissionReviewSave, admissionSetAttending, admissionChangeAttending, admissionReviewsList } from './inpatient-reviews.js';   // INPATIENT_REVIEW_V1
import {
  treatmentOrderCreate, treatmentOrderCancel, treatmentOrdersList,
  treatmentAdminMark, treatmentAdminUnmark, treatmentTasksDue,
} from './treatment-orders.js';   // TREATMENT_ORDERS_V1
import {
  dietTablesList, admissionDietSet, admissionDietHistory,
  admissionMealMark, admissionMealsList, kitchenSheet,
} from './diet.js';   // DIET_TABLES_V1
import { ensureVisit } from './visits.js';
import { calendarSlots, calendarWindows, calendarBook } from './calendar.js';   // CALENDAR_BOOKING_V1
import { issueQueueNumbers, queueBoard } from './queue.js';
import { createDeposit, acceptDeposit, cancelDeposit, refundDeposit, listDeposits, depositBalance } from './deposits.js';   // DEPOSIT_V1
import { documentsFeed } from './documents.js';   // DOCS_FEED_V1
import { getClinicBySlug } from './clinic.js';
import { callcenterReport } from './callcenter.js';
import { billAccommodation, unbillAccommodation, accommodationState } from './accommodation.js';
import { setAdmissionDate } from './admission-date.js';   // ADMISSION_DATE_EDIT_V1   // ACCOMMODATION_AS_SERVICE_V1   // CALLCENTER_REPORT_V1
import { deleteService, serviceDeleteCheck } from './catalog.js';   // SERVICE_DELETE_V1
import { serviceSave } from './service-save.js';   // SERVICE_EDITOR_V1
import { saveLabResults } from './lab.js';   // LAB_SAVE_BATCH_V1
import { labUsageStats } from './lab-stats.js';   // LAB_STATS_V1
import { roomAssignDoctors } from './rooms.js';   // ROOMS_SETUP_V1
import { roomsSetupDelete } from './rooms-delete.js';   // ROOMS_DELETE_V1
import { cashierReport } from './cashier-report.js';   // CASHIER_REPORT_V1
import { telegramSettingsGet, telegramSettingsSave, telegramTokenClear, telegramTestConnection, telegramLinksList, telegramLinkRevoke, telegramDeliveriesList, telegramStats, telegramBroadcastPreview, telegramBroadcastSend, telegramBroadcastStatus, telegramBroadcastHistory, telegramChatsList, telegramChatMessages, telegramChatSend, telegramChatSendFile, telegramChatUnread, telegramFolderSave, telegramFolderSetChat, telegramChatLink } from './telegram.js';   // TELEGRAM_BOT_V1 / TELEGRAM_BROADCAST_V1 / TELEGRAM_CHAT_V1
import { licenceStatus, licenceUnlock, licenceEnroll, moduleRequest } from './licence.js';   // LICENCE_CORE_V1
import { telephonySettingsGet, telephonySettingsSave, telephonyTest, telephonyRecentCalls, telephonyDispositions } from './telephony.js';   // TELEPHONY_V1 / TELEPHONY_ROUTING_V1
import { crmConfigGet, crmConfigSave } from './crm-config.js';   // CRM_CONFIG_V1
import { updateStatus, updateApprove, updateCancel, updateCheckNow } from './updates.js';   // UPDATE_DELIVERY_V1
import { backupList, backupCreate, backupRestore, factoryReset } from './backup.js';   // SYSTEM_SETTINGS_V1
import { custdevList, custdevSync, custdevRate, custdevMark, custdevReport } from './custdev.js';   // CUSTDEV_V1
import {
  branchSyncStatus, branchSyncMakeKey, branchSyncPairAdopt, branchSyncUnpair, branchSyncNow,
  branchSyncRelaySet, branchSyncRelayPublish, branchSyncRegenerateKey,   // BRANCH_SYNC_RELAY_V1
  branchSyncBranches, branchSyncAddBranch, branchSyncBranchKey,   // BRANCH_IDENTITY_V1
  branchSyncReissueKey,   // BRANCH_REISSUE_V1
} from './branch-sync.js';   // BRANCH_SYNC_V1

export const RPC = {
  get_clinic_by_slug:       (db, args, user) => getClinicBySlug(db, args, user),
  callcenter_report:        (db, args, user) => callcenterReport(db, args, user),
  // CUSTDEV_V1 — обзвон пациентов после визита
  custdev_list:             (db, args, user) => custdevList(db, args, user),
  custdev_sync:             (db, args, user) => custdevSync(db, args, user),
  custdev_rate:             (db, args, user) => custdevRate(db, args, user),
  custdev_mark:             (db, args, user) => custdevMark(db, args, user),
  custdev_report:           (db, args, user) => custdevReport(db, args, user),
  // ACCOMMODATION_AS_SERVICE_V1 — проживание становится услугой по кнопке
  bill_accommodation:       (db, args, user) => billAccommodation(db, args, user),
  unbill_accommodation:     (db, args, user) => unbillAccommodation(db, args, user),
  accommodation_state:      (db, args, user) => accommodationState(db, args, user),
  set_admission_date:       (db, args, user) => setAdmissionDate(db, args, user),   // ADMISSION_DATE_EDIT_V1   // CALLCENTER_REPORT_V1
  create_invoice_for_visit: (db, args, user) => createInvoiceForVisit(db, args, user),
  record_payment:           (db, args, user) => recordPayment(db, args, user),
  record_payment_split:     (db, args, user) => recordPaymentSplit(db, args, user),
  mark_invoice_debt:        (db, args, user) => markInvoiceDebt(db, args, user),   // DEBT_BTN_V1
  change_unpaid_service:    (db, args, user) => changeUnpaidService(db, args, user),   // SVC_CHANGE_V1 — замена услуги + пересчёт счёта   // SPLIT_PAY_V1 — оплата двумя+ способами
  refund_payment:           (db, args, user) => refundPayment(db, args, user),   // CASHIER_REFUND_V1 — возврат оплаты (отрицательный платёж)
  receive_stock:            (db, args, user) => receiveStock(db, args, user),
  dispense_item:            (db, args, user) => dispenseItem(db, args, user),
  void_dispense:            (db, args, user) => voidDispense(db, args, user),
  dashboard_summary:        (db, args, user) => dashboardSummary(db, args, user),
  receive_stock_lines:      (db, args, user) => receiveStockLines(db, args, user),
  adjust_stock:             (db, args, user) => adjustStock(db, args, user),
  receive_purchase_order:        (db, args, user) => receivePurchaseOrder(db, args, user),          // PROC_P2 — book a delivery against a PO
  approve_requisition_and_issue: (db, args, user) => approveRequisitionAndIssue(db, args, user),    // PROC_P2 — issue a requisition from the pool
  post_stock_count:              (db, args, user) => postStockCount(db, args, user),                // PROC_P2 — reconcile a physical count
  issue_stock_lines:             (db, args, user) => issueStockLines(db, args, user),               // PROCUREMENT_REDESIGN_V1 — Выдача со склада
  import_products_excel:         (db, args, user) => importProductsExcel(db, args, user),           // PROCUREMENT_REDESIGN_V1 — Импорт из Excel
  reports_overview:         (db, args, user) => reportsOverview(db, args, user),
  run_report:               (db, args, user) => runReport(db, args, user),
  owner_report:             (db, args, user) => ownerReport(db, args, user),   // REPORTS_HUB_RU_V1 — «Отчёт владельца» charts
  // BUILDING_REPORTS_V1 — перечень ЗДАНИЙ клиники для выборки в «Отчётах».
  // Через /api/db его собрать нельзя: реестр не отдаёт браузеру branches.letter,
  // а прежняя выборка филиалов грузилась с active = 1 — соседнее здание же
  // заводится как active = 0 и в список не попадало вовсе.
  report_buildings:         (db, args, user) => reportBuildings(db, args, user),
  // BUILDING_FRESHNESS_V1 — свежесть данных по каждому зданию: когда его записи
  // приходили в последний раз, сколько их ждёт родителя и сколько база не
  // приняла. Чистое чтение — ровно та же категория, что report_buildings.
  report_freshness:         (db, args, user) => reportFreshness(db, args, user),
  open_cash_shift:          (db, args, user) => openCashShift(db, args, user),
  close_cash_shift:         (db, args, user) => closeCashShift(db, args, user),
  cash_shift_summary:       (db, args, user) => cashShiftSummary(db, args, user),
  cash_move:                (db, args, user) => cashMove(db, args, user),          // CASHIER_DESIGN_V2 — «Внести» / «Изъять»
  shift_report:             (db, args, user) => shiftReport(db, args, user),       // CASHIER_DESIGN_V2 — X-отчёт / история смены
  cashier_invoices:         (db, args, user) => cashierInvoices(db, args, user),   // CASHIER_DESIGN_V2 — «Приём оплат» list + chips
  void_invoice:             (db, args, user) => voidInvoice(db, args, user),       // CASHIER_DESIGN_V2 — отмена счёта без денег
  delete_invoice:            (db, args, user) => deleteInvoice(db, args, user),   // INVOICE_DELETE_V1
  admit_patient:            (db, args, user) => admitPatient(db, args, user),
  discharge_patient:        (db, args, user) => dischargePatient(db, args, user),
  set_bed_status:           (db, args, user) => setBedStatus(db, args, user),

  // DAY_VISIT_V1 — a visit is one calendar day per patient; services land on
  // their date's visit. Find-or-create lives server-side so visit counts are
  // computed, never hand-managed.
  ensure_visit:              (db, args, user) => ensureVisit(db, args, user),
  // CALENDAR_BOOKING_V1 — «Календарь записи».
  //
  // calendar_slots ЧИТАЕТ (стоит в READ_ONLY_RPCS, control/gate.js): свободные
  // начала приёма у врача или в кабинете на день — график, обед, часы клиники
  // и уже занятое считает один общий движок slot-engine.js. Клиника с
  // просроченной лицензией обязана видеть своё расписание: пациенты уже
  // записаны, и «читает» не должно означать «пустая сетка».
  //
  // calendar_book ПИШЕТ и потому в READ_ONLY_RPCS не входит. Один вход на три
  // действия — записать, перенести, растянуть, — потому что проверка у всех
  // трёх одна: ОДИН ПАЦИЕНТ НА ВРАЧА НА СЛОТ (решение владельца 2026-09-05).
  // Отказ называет занятое время; экстренная запись поверх занятого —
  // отдельное действие с обязательной причиной, а не тихий обход.
  calendar_slots:            (db, args, user) => calendarSlots(db, args, user),
  // calendar_windows — рабочие окна пачкой на «ресурс × день». Тоже чтение
  // (READ_ONLY_RPCS): без него затенение нерабочих часов пришлось бы считать
  // в браузере — четвёртой реализацией того же правила.
  calendar_windows:          (db, args, user) => calendarWindows(db, args, user),
  calendar_book:             (db, args, user) => calendarBook(db, args, user),
  // QUEUE_TICKET_V1 — easymed's queue-number allocator (Postgres mig 122):
  // per-doctor for consultations, one shared number for a patient's labs,
  // doctor-or-room for procedures, per-apparatus for imaging. Idempotent.
  issue_queue_numbers:       (db, args, user) => issueQueueNumbers(db, args, user),
  // DEPOSIT_V1 — предоплата пациента: регистратура заводит, касса принимает.
  create_deposit:            (db, args, user) => createDeposit(db, args, user),
  accept_deposit:            (db, args, user) => acceptDeposit(db, args, user),
  cancel_deposit:            (db, args, user) => cancelDeposit(db, args, user),
  refund_deposit:            (db, args, user) => refundDeposit(db, args, user),   // DEPOSIT_REFUND_V1
  list_deposits:             (db, args, user) => listDeposits(db, args, user),
  deposit_balance:           (db, args, user) => depositBalance(db, args, user),
  // QUEUE_BOARD_V1 — читающая сторона тех же номеров: доска «кто у кого
  // стоит» по назначениям за день. Доступ по выданному разделу 'queue'
  // (canViewSection), а не по списку ролей: раздел раздаётся в «Настройки →
  // Роли», как «Чат с пациентами».
  queue_board:               (db, args, user) => queueBoard(db, args, user),
  // DOCS_FEED_V1 - лента готовых документов по всей клинике: анализы,
  // диагностика и подписанные заключения одним списком с фильтрами.
  documents_feed:            (db, args, user) => documentsFeed(db, args, user),
  // SVC_UNPAID_REMOVE_V1 — patient-card trash: drop a service line + repair
  // its UNPAID invoice (shrink or delete) in one transaction.
  remove_unpaid_service:     (db, args, user) => removeUnpaidService(db, args, user),

  // DOCTOR_WORKSPACE_V1 — easymed's service-workspace RPC names (p_* args from
  // the original Postgres functions) mapped onto the local handlers above.
  dispense_visit_item:       (db, args, user) => dispenseItem(db, { product_id: args.p_item_id, quantity: args.p_qty, visit_id: args.p_visit_id, doctor_id: args.p_doctor_id ?? null }, user),
  void_dispensed_visit_item: (db, args, user) => voidDispense(db, { visit_service_id: args.p_line }, user),
  request_admission:         (db, args, user) => requestAdmission(db, { patient_id: args.p_patient_id, doctor_id: args.p_doctor_id ?? null, pathway: args.p_pathway, chief_complaint: args.p_chief_complaint ?? '', diagnosis: args.p_diagnosis ?? '' }, user),

  // BED_CONSOLE_V1 — стационарная консоль койки: выдача препаратов (easymed
  // p_* имена), счёт по госпитализации, перевод и скидка на проживание.
  dispense_admission_item:        (db, args, user) => dispenseAdmissionItem(db, { admission_id: args.p_admission_id, product_id: args.p_item_id, quantity: args.p_qty, doctor_id: args.p_doctor_id ?? null, billable: args.p_billable === undefined ? true : !!args.p_billable, note: args.p_note ?? null }, user),
  void_dispensed_admission_item:  (db, args, user) => voidDispensedAdmissionItem(db, { line_id: args.p_line }, user),
  create_invoice_for_admission:   (db, args, user) => createInvoiceForAdmission(db, args, user),
  remove_admission_line_from_invoice: (db, args, user) => removeAdmissionLineFromInvoice(db, args, user),   // BED_CONSOLE_V3 — «Из счёта»
  transfer_admission:             (db, args, user) => transferAdmission(db, args, user),
  set_admission_discount:         (db, args, user) => setAdmissionDiscount(db, args, user),

  // ADM_REQUEST_LIFECYCLE_V1 — «Отклонить заявку»: закрыть заявку на
  // госпитализацию, которая не будет выполнена. Без неё статус 'requested'
  // был тупиком: выйти из него не мог никто, и пациента больше нельзя было
  // направить в стационар. (Выполнение заявки делает admit_patient.)
  cancel_admission_request:       (db, args, user) => cancelAdmissionRequest(db, args, user),

  // ADMISSION_ORDER_V1 (Задача 2) — ЗАЯВКА и РАЗМЕЩЕНИЕ, две первые стрелки
  // маршрута владельца. Заявку оформляет регистратура (или врач из кабинета:
  // request_admission выше пишет ту же строку в том же 'ordered' — это второй
  // вход, а не дубль); кладёт на койку медсестра, старшая медсестра, главный
  // врач или администратор (матрица в rpc/inpatient-flow.js).
  //
  // cancel_admission_request строкой выше — ПРЕДШЕСТВЕННИК admission_order_cancel:
  // ни один экран его не зовёт (grep по public/), он остаётся ради внешних
  // вызовов. Новый экран зовёт admission_order_cancel — тот требует причину,
  // спрашивает матрицу прав и отпускает койку в 'cleaning'.
  admission_order_create:         (db, args, user) => admissionOrderCreate(db, args, user),
  admission_order_cancel:         (db, args, user) => admissionOrderCancel(db, args, user),
  admission_admit:                (db, args, user) => admissionAdmit(db, args, user),

  // TWO_STEP_DISCHARGE_V1 (Задача 8) — ВЫПИСКА В ДВА ШАГА. Клиническая
  // готовность и административная выписка — разные события разных людей:
  // ЛЕЧАЩИЙ ВРАЧ подаёт заявку (исход, опубликованный эпикриз, рекомендации) и
  // на этом его часть кончается — койку он не освобождает; СТАРШАЯ МЕДСЕСТРА
  // оформляет (фактическое время, чек-лист, долг) — но исхода она не объявляет.
  // Заявку можно ОТОЗВАТЬ: между двумя шагами проходят часы, и за эти часы
  // состояние пациента меняется (референс этого не умеет — см. lifecycle.js).
  // Долг ПРЕДУПРЕЖДАЕТ, а не запрещает: он требует подписи «Долг согласован»,
  // после которой выписка проходит с долгом. Койка уходит в 'cleaning', а не в
  // 'free' — её открывает отдельное set_bed_status.
  //
  // discharge_patient (строкой выше) остаётся: он выписывает тех, кого
  // положили ДО обновления, — у них нет и не будет выписного эпикриза, без
  // которого новый первый шаг заявку не примет.
  //
  // admission_discharge_queue — чтение (READ_ONLY_RPCS в control/gate.js).
  admission_discharge_request:        (db, args, user) => admissionDischargeRequest(db, args, user),
  admission_discharge_cancel_request: (db, args, user) => admissionDischargeCancelRequest(db, args, user),
  admission_discharge_finalize:       (db, args, user) => admissionDischargeFinalize(db, args, user),
  admission_discharge_queue:          (db, args, user) => admissionDischargeQueue(db, args, user),

  // INPATIENT_FLOW_V1 — где госпитализация на маршруте и что ЭТОТ человек
  // может с ней сделать. Чистое чтение (см. READ_ONLY_RPCS в control/gate.js):
  // матрица прав живёт на сервере, и экранам Задач 2, 3 и 8 её надо спросить, а
  // не пересчитать у себя — вторая копия матрицы разошлась бы с первой.
  // Сами шаги маршрута (заявка, размещение, осмотр, выписка) — Задачи 2, 3, 8.
  admission_flow_state:           (db, args, user) => admissionFlowState(db, args, user),

  // INPATIENT_REVIEW_V1 — первичный осмотр и лечащий врач (Задача 3 плана
  // «Стационар»). Осмотр публикует ГЛАВНЫЙ ВРАЧ, и публикация двигает
  // 'admitted' → 'examined'; лечащего врача назначает он же, и это шаг
  // 'examined' → 'active' — единственный, после которого открываются
  // назначения (assertCanPrescribe). Черновик осмотра не двигает ничего, а
  // исправление опубликованного — НОВАЯ запись, а не UPDATE поверх прежней.
  // admission_reviews_list и inpatient_capabilities — чтение (READ_ONLY_RPCS
  // в control/gate.js).
  admission_review_save:          (db, args, user) => admissionReviewSave(db, args, user),
  admission_set_attending:        (db, args, user) => admissionSetAttending(db, args, user),
  // СМЕНА лечащего врача — то самое «делается отдельно», которым
  // admission_set_attending отказывал, не имея за собой ничего. Главный врач
  // или администратор, на 'active' и 'discharging'. Он же — единственный
  // способ починить госпитализацию, у которой attending_doctor_id пуст:
  // старый admit_patient позволял класть пациента без врача, 091 перенесла
  // такие строки как есть, и назначения им отвечали 403 всем без исключения.
  admission_change_attending:     (db, args, user) => admissionChangeAttending(db, args, user),
  admission_reviews_list:         (db, args, user) => admissionReviewsList(db, args, user),
  // Что ЭТА роль вправе делать в стационаре вообще. Один ответ на экран-очередь
  // вместо запроса по каждой строке: право на шаг зависит от роли, а не от
  // пациента, но считать его в браузере нельзя — матрица живёт на сервере.
  inpatient_capabilities:         (db, args, user) => inpatientCapabilities(db, args, user),

  // TREATMENT_ORDERS_V1 — лист назначений (Задача 4 плана «Стационар»).
  // Врач назначает и отменяет (assertCanPrescribe: пациент дошёл до лечения И
  // это его лечащий врач), медсестра отмечает дозы по часам, старшая медсестра
  // снимает ошибочную отметку — со следом, а не удалением. Экранов пока нет:
  // их строит Задача 5, списание и начисление — Задача 6.
  // treatment_orders_list и treatment_tasks_due — чтение (READ_ONLY_RPCS).
  treatment_order_create:         (db, args, user) => treatmentOrderCreate(db, args, user),
  treatment_order_cancel:         (db, args, user) => treatmentOrderCancel(db, args, user),
  treatment_orders_list:          (db, args, user) => treatmentOrdersList(db, args, user),
  treatment_admin_mark:           (db, args, user) => treatmentAdminMark(db, args, user),
  treatment_admin_unmark:         (db, args, user) => treatmentAdminUnmark(db, args, user),
  treatment_tasks_due:            (db, args, user) => treatmentTasksDue(db, args, user),

  // DIET_TABLES_V1 — лечебные столы (Задача 7 плана «Стационар»).
  // Стол меняют врач, главный врач, старшая медсестра и администратор, и в
  // истории остаются ОБА периода: старый закрывается, новый открывается, а
  // автором пишется ТОТ, КТО НАЖАЛ, — не лечащий врач (ошибка референса,
  // разобранная в шапке rpc/diet.js). Питание отмечает медсестра, отметка
  // идемпотентна по (госпитализация, дата, приём).
  // diet_tables_list, admission_diet_history, admission_meals_list и
  // kitchen_sheet — чтение (READ_ONLY_RPCS в control/gate.js).
  diet_tables_list:               (db, args, user) => dietTablesList(db, args, user),
  admission_diet_set:             (db, args, user) => admissionDietSet(db, args, user),
  admission_diet_history:         (db, args, user) => admissionDietHistory(db, args, user),
  admission_meal_mark:            (db, args, user) => admissionMealMark(db, args, user),
  admission_meals_list:           (db, args, user) => admissionMealsList(db, args, user),
  // Порционник — заказ на кухню на дату: палата · койка · пациент · стол плюс
  // итог по столам. Считает КАЖДУЮ госпитализацию в койке (IN_BED_STATUSES).
  kitchen_sheet:                  (db, args, user) => kitchenSheet(db, args, user),

  // SERVICE_DELETE_V1 — «Удалить услугу». Hard-deletes only a service with no
  // visit / invoice / admission / queue / lab / CRM history; anything used is
  // refused (409) and deactivated instead, so billing history keeps its names.
  service_delete_check:           (db, args, user) => serviceDeleteCheck(db, args, user),
  delete_service:                 (db, args, user) => deleteService(db, args, user),

  // SERVICE_EDITOR_V1 — редактор услуги: услуга + комбобоксы (тип/категория/
  // отделение создаются по набранному имени) + членство исполнителей в
  // users.service_rates — ОДНОЙ транзакцией, чтобы частичное сохранение
  // было невозможно (см. заголовок service-save.js).
  service_save:                   (db, args, user) => serviceSave(db, args, user),

  // LAB_SAVE_BATCH_V1 — вся панель одним запросом и одной транзакцией.
  // Заменяет цикл «HTTP-запрос на каждый показатель»: 29 обращений по сети
  // превращались в секунду ожидания, а обрыв связи посередине оставлял
  // половину бланка сохранённой.
  save_lab_results:               (db, args, user) => saveLabResults(db, args, user),

  // LAB_STATS_V1 — «Лаборатория → Статистика»: сколько раз заказаны панели и
  // безпанельные лабораторные услуги за период и сколько выдано. Только
  // счётчики, никаких денег; доступ — LAB_SECTION_ROLES, как у записей панелей.
  lab_usage_stats:                (db, args, user) => labUsageStats(db, args, user),
  room_assign_doctors:            (db, args, user) => roomAssignDoctors(db, args, user),   // ROOMS_SETUP_V1
  rooms_setup_delete:             (db, args, user) => roomsSetupDelete(db, args, user),   // ROOMS_DELETE_V1

  // CASHIER_REPORT_V1 — «Отчёт кассира»: приход, расход и итог за ПЕРИОД
  // (в отличие от X-отчёта смены, который смотрит на одну смену).
  cashier_report:                 (db, args, user) => cashierReport(db, args, user),

  // TELEGRAM_BOT_V1 — раздел «Telegram-бот» в настройках: токен, режимы
  // выдачи, проверка связи. Только admin; сам токен наружу не отдаётся.
  // telegram_test_connection — ЕДИНСТВЕННЫЙ асинхронный RPC (ходит в
  // api.telegram.org), ради него routes/rpc.js ждёт промис.
  telegram_settings_get:          (db, args, user) => telegramSettingsGet(db, args, user),
  telegram_settings_save:         (db, args, user) => telegramSettingsSave(db, args, user),
  telegram_token_clear:           (db, args, user) => telegramTokenClear(db, args, user),
  telegram_test_connection:       (db, args, user) => telegramTestConnection(db, args, user),
  // Связанные чаты и журнал выдач: доступ по одному номеру телефона принят
  // осознанно, и «Отвязать» — то, чем клиника закрывает доступ, если номер
  // перешёл к другому человеку.
  telegram_links_list:            (db, args, user) => telegramLinksList(db, args, user),
  telegram_link_revoke:           (db, args, user) => telegramLinkRevoke(db, args, user),
  telegram_deliveries_list:       (db, args, user) => telegramDeliveriesList(db, args, user),

  // TELEGRAM_BROADCAST_V1 — «Отчёты → Telegram-бот»: охват подключений и
  // рассылка сообщений пациентам. Отправка требует подтверждения числом
  // получателей, и это проверяется на сервере, а не только в диалоге.
  telegram_stats:                 (db, args, user) => telegramStats(db, args, user),
  telegram_broadcast_preview:     (db, args, user) => telegramBroadcastPreview(db, args, user),
  telegram_broadcast_send:        (db, args, user) => telegramBroadcastSend(db, args, user),
  telegram_broadcast_status:      (db, args, user) => telegramBroadcastStatus(db, args, user),
  telegram_broadcast_history:     (db, args, user) => telegramBroadcastHistory(db, args, user),

  // TELEGRAM_CHAT_V1 — «Чат с пациентами» в левом меню. Единственные RPC бота,
  // которые НЕ admin-only: раздел выдаётся ролям, и его уровень (viewer /
  // editor) решает, читать переписку или ещё и отвечать в неё.
  telegram_chats_list:            (db, args, user) => telegramChatsList(db, args, user),
  telegram_chat_messages:         (db, args, user) => telegramChatMessages(db, args, user),
  telegram_chat_unread:           (db, args, user) => telegramChatUnread(db, args, user),
  telegram_chat_link:       (db, args, user) => telegramChatLink(db, args, user),   // TELEGRAM_ORPHAN_CHAT_V1
  telegram_chat_send:             (db, args, user) => telegramChatSend(db, args, user),
  telegram_chat_send_file:        (db, args, user) => telegramChatSendFile(db, args, user),   // TELEGRAM_CHAT_FILE_V1
  // TELEGRAM_CHAT_FOLDERS_V1 — папки чатов («Долги», «VIP»). Общие для клиники:
  // регистратура работает сменами, и личная папка исчезала бы вместе со сменой.
  telegram_folder_save:           (db, args, user) => telegramFolderSave(db, args, user),
  telegram_folder_set_chat:       (db, args, user) => telegramFolderSetChat(db, args, user),

  // TELEPHONY_V1 — Настройки → «Телефония» (Binotel). Admin-only; the secret
  // never leaves the server (api_secret_set only). telephony_test is async —
  // routes/rpc.js has awaited handlers since telegram_test_connection.
  // NORMAL 402 gating on purpose: telephony is clinical operations, not
  // licence recovery — nothing here belongs in gate.js's allowed sets.
  telephony_settings_get:   (db, args, user) => telephonySettingsGet(db, args, user),
  telephony_settings_save:  (db, args, user) => telephonySettingsSave(db, args, user),
  telephony_test:           (db, args, user) => telephonyTest(db, args, user),
  telephony_recent_calls:   (db, args, user) => telephonyRecentCalls(db, args, user),
  // TELEPHONY_ROUTING_V1 — «Звонки → заявки» на том же экране: какие исходы
  // звонков вообще бывают у ЭТОЙ клиники (наблюдённые + вендорский список) и
  // какое правило стоит у каждого. Читающий вызов, но в READ_ONLY_RPCS его
  // НЕТ намеренно — как и telephony_settings_get: у клиники с просроченной
  // лицензией нет опроса звонков, и настраивать маршрут ей нечего.
  telephony_dispositions:   (db, args, user) => telephonyDispositions(db, args, user),

  // CRM_CONFIG_V1 — Настройки → «CRM-канбан»: колонки доски, источники и
  // «звонок -> карточка» (миграция 077). _get читают И доска, и экран
  // настроек — это словарь, из которого рисуется канбан, поэтому он открыт
  // всем сотрудникам и стоит в READ_ONLY_RPCS (control/gate.js): клиника с
  // просроченной лицензией обязана видеть свою доску. _save — только admin,
  // обычное 402-ограничение, ничего always-allowed.
  crm_config_get:           (db, args, user) => crmConfigGet(db, args, user),
  crm_config_save:          (db, args, user) => crmConfigSave(db, args, user),

  // LICENCE_CORE_V1 — the three that stay reachable while locked (see
  // control/gate.js ALWAYS_ALLOWED_RPCS). Without them a clinic that wants to
  // pay would have no way to say so.
  licence_status:  (db, args, user) => licenceStatus(db, args, user),
  licence_unlock:  (db, args, user) => licenceUnlock(db, args, user),
  // ENROLLMENT_SCREEN_V1 — first-run activation; a not-enrolled install is
  // locked by definition, so this lives in the same always-allowed set.
  licence_enroll:  (db, args, user) => licenceEnroll(db, args, user),
  module_request:  (db, args, user) => moduleRequest(db, args, user),

  // UPDATE_DELIVERY_V1 — the approval screen's own RPCs (see control/gate.js
  // for why update_approve/update_cancel stay reachable through a licence
  // lapse, same as the three above).
  update_status:   (db, args, user) => updateStatus(db, args, user),
  update_approve:  (db, args, user) => updateApprove(db, args, user),
  update_cancel:   (db, args, user) => updateCancel(db, args, user),
  // «Проверить обновления» — an immediate check-in on demand; also how a
  // fresh module grant reaches the clinic without waiting a day. Same
  // always-allowed reasoning as the rest of this block: the check-in is the
  // very thing that can UNLOCK a locked clinic (licence renewal), so it must
  // stay reachable through a lapse.
  update_check_now: (db, args, user) => updateCheckNow(db, args, user),

  // SYSTEM_SETTINGS_V1 — Настройки → Система: резервные копии и опасная зона.
  // Also always-allowed through a licence lapse (control/gate.js has the
  // reasoning); the admin-role and caller-password checks live in backup.js.
  backup_list:      (db, args, user) => backupList(db, args, user),
  backup_create:    (db, args, user) => backupCreate(db, args, user),
  backup_restore:   (db, args, user) => backupRestore(db, args, user),
  factory_reset:    (db, args, user) => factoryReset(db, args, user),

  // BRANCH_SYNC_V1 — Настройки → Филиалы: связывание отдельных установок
  // Easy-Med и перенос справочника из главного филиала. В READ_ONLY_RPCS
  // (control/gate.js) внесён только branch_sync_status — остальные пишут, и
  // клиника с просроченной лицензией их не получает.
  branch_sync_status:   (db, args, user) => branchSyncStatus(db, args, user),
  branch_sync_make_key: (db, args, user) => branchSyncMakeKey(db, args, user),
  // BRANCH_REISSUE_V1 — тот же вызов экрана, но ключ теперь не только
  // связывает: на установке, активированной как ОТДЕЛЬНАЯ клиника по ошибке,
  // он ещё и переселяет её в филиал, которому принадлежит (branchSyncPairAdopt).
  branch_sync_pair:     (db, args, user) => branchSyncPairAdopt(db, args, user),
  branch_sync_unpair:   (db, args, user) => branchSyncUnpair(db, args, user),
  branch_sync_now:      (db, args, user) => branchSyncNow(db, args, user),
  // BRANCH_SYNC_RELAY_V1 — резервный канал через сервер Easy-Med: согласие на
  // выгрузку, ручная выгрузка и перевыпуск ключа синхронизации. Все три пишут
  // (на диск или в базу), поэтому в READ_ONLY_RPCS их тоже нет.
  branch_sync_relay_set:     (db, args, user) => branchSyncRelaySet(db, args, user),
  branch_sync_relay_publish: (db, args, user) => branchSyncRelayPublish(db, args, user),
  branch_sync_regenerate_key: (db, args, user) => branchSyncRegenerateKey(db, args, user),
  // BRANCH_IDENTITY_V1 — список филиалов с их буквами и ПОСТОЯННЫМИ ключами
  // подключения. Ни один из трёх не в READ_ONLY_RPCS (control/gate.js):
  // branch_sync_branches отдаёт ключи, а в ключе лежат и секрет подписи, и ключ
  // шифрования группы, поэтому он стоит за проверкой роли наравне с пишущими.
  branch_sync_branches:   (db, args, user) => branchSyncBranches(db, args, user),
  branch_sync_add_branch: (db, args, user) => branchSyncAddBranch(db, args, user),
  branch_sync_branch_key: (db, args, user) => branchSyncBranchKey(db, args, user),
  // BRANCH_REISSUE_V1 — новый код активации филиалу, чей компьютер
  // переустановили. Гасит прежнюю установку этого филиала у поставщика,
  // поэтому стоит за той же ролью, что и выдача ключей.
  branch_sync_reissue_key: (db, args, user) => branchSyncReissueKey(db, args, user),
};

export function getRpc(name) {
  return Object.prototype.hasOwnProperty.call(RPC, name) ? RPC[name] : null;
}
