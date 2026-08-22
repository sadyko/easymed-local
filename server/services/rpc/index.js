// Registry of server-side RPC handlers. Each is (db, args, user) => result.
// The 25 legacy Postgres functions are ported per-module in later Phase-2
// slices (dispensing, discounts, queue numbers, …).
import { createInvoiceForVisit, recordPayment, recordPaymentSplit, markInvoiceDebt, changeUnpaidService, removeUnpaidService, refundPayment, createInvoiceForAdmission, removeAdmissionLineFromInvoice } from './billing.js';
import { receiveStock, dispenseItem, voidDispense, dispenseAdmissionItem, voidDispensedAdmissionItem } from './inventory.js';
import { dashboardSummary } from './dashboard.js';
import { receiveStockLines, adjustStock, receivePurchaseOrder, approveRequisitionAndIssue, postStockCount, issueStockLines, importProductsExcel } from './procurement.js';
import { reportsOverview, runReport, ownerReport } from './reports.js';
import { openCashShift, closeCashShift, cashShiftSummary, cashMove, shiftReport, cashierInvoices, voidInvoice, deleteInvoice } from './cashier.js';
import { admitPatient, dischargePatient, setBedStatus, requestAdmission, transferAdmission, setAdmissionDiscount, cancelAdmissionRequest } from './inpatient.js';
import { ensureVisit } from './visits.js';
import { issueQueueNumbers, queueBoard } from './queue.js';
import { createDeposit, acceptDeposit, cancelDeposit, refundDeposit, listDeposits, depositBalance } from './deposits.js';   // DEPOSIT_V1
import { documentsFeed } from './documents.js';   // DOCS_FEED_V1
import { getClinicBySlug } from './clinic.js';
import { callcenterReport } from './callcenter.js';
import { billAccommodation, unbillAccommodation, accommodationState } from './accommodation.js';
import { setAdmissionDate } from './admission-date.js';   // ADMISSION_DATE_EDIT_V1   // ACCOMMODATION_AS_SERVICE_V1   // CALLCENTER_REPORT_V1
import { deleteService, serviceDeleteCheck } from './catalog.js';   // SERVICE_DELETE_V1
import { saveLabResults } from './lab.js';   // LAB_SAVE_BATCH_V1
import { cashierReport } from './cashier-report.js';   // CASHIER_REPORT_V1
import { telegramSettingsGet, telegramSettingsSave, telegramTokenClear, telegramTestConnection, telegramLinksList, telegramLinkRevoke, telegramDeliveriesList, telegramStats, telegramBroadcastPreview, telegramBroadcastSend, telegramBroadcastStatus, telegramBroadcastHistory, telegramChatsList, telegramChatMessages, telegramChatSend, telegramChatSendFile, telegramChatUnread, telegramFolderSave, telegramFolderSetChat, telegramChatLink } from './telegram.js';   // TELEGRAM_BOT_V1 / TELEGRAM_BROADCAST_V1 / TELEGRAM_CHAT_V1
import { licenceStatus, licenceUnlock, licenceEnroll, moduleRequest } from './licence.js';   // LICENCE_CORE_V1
import { updateStatus, updateApprove, updateCancel } from './updates.js';   // UPDATE_DELIVERY_V1

export const RPC = {
  get_clinic_by_slug:       (db, args, user) => getClinicBySlug(db, args, user),
  callcenter_report:        (db, args, user) => callcenterReport(db, args, user),
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

  // SERVICE_DELETE_V1 — «Удалить услугу». Hard-deletes only a service with no
  // visit / invoice / admission / queue / lab / CRM history; anything used is
  // refused (409) and deactivated instead, so billing history keeps its names.
  service_delete_check:           (db, args, user) => serviceDeleteCheck(db, args, user),
  delete_service:                 (db, args, user) => deleteService(db, args, user),

  // LAB_SAVE_BATCH_V1 — вся панель одним запросом и одной транзакцией.
  // Заменяет цикл «HTTP-запрос на каждый показатель»: 29 обращений по сети
  // превращались в секунду ожидания, а обрыв связи посередине оставлял
  // половину бланка сохранённой.
  save_lab_results:               (db, args, user) => saveLabResults(db, args, user),

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
};

export function getRpc(name) {
  return Object.prototype.hasOwnProperty.call(RPC, name) ? RPC[name] : null;
}
