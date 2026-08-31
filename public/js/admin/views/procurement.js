// Operations · Procurement — REAL build (backed by live DB tables). PROCUREMENT_REAL_V1
//
// Replaces the former mockup. Three real tabs, all clinic-scoped by company_id
// (RLS enforces own-clinic reads + admin writes). Every select is filtered on
// .eq('company_id', currentClinicId()); every insert sets company_id.
//
//   • Stock              — item_stock ⋈ clinic_items, per branch; Receive / Adjust
//                          via stock_movements inserts (the apply_stock_movement
//                          AFTER-INSERT trigger upserts item_stock.qty_on_hand).
//   • Suppliers          — suppliers CRUD (soft-delete via active=false).
//   • Purchase orders    — purchase_orders + purchase_order_items; New PO,
//                          Mark ordered, Receive (per line → stock_movements).
//
// Shell idiom kept from the mockup: renderProcurement(container) builds the
// PageHead + .tabs bar ONCE; only `bodyEl` re-renders per tab via a TAB_VIEWS
// map + switchTab(id) + renderBody(). Stock-movement is the single source of
// truth for on-hand quantity — we NEVER write item_stock.qty_on_hand directly.

import { h, Icon, PageHead, clear, toast, fmtDate } from '../ui.js';
import { supabase } from '../../supabase.js';
import { currentClinicId } from '../tenant-tables.js';
import { getLang, tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1
import { canProcurementFull, canProcurementRequisitions } from '../permissions.js';   // PROCUREMENT_REQ_GRANT_V1
import { currentUser } from '../data.js';
import { openSectionImporter, downloadSectionSample } from './section-import-export.js?v=aug17e';   // PROCUREMENT_IMPORT_V2
import { barcodeSVG } from './lab-barcode.js?v=labbc1';   // BATCH_LABELS_V1 — same Code128 generator as lab labels
import { phoneInput } from '../phone-input.js?v=ph1';
import { PRINT_FONT_FACE_CSS } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1 — @font-face для печатных окон

// PHONE_INPUT_V1 — the supplier popups here style their inputs inline rather
// than through .field CSS, so the country control's inner input has to inherit
// that same styling; the left corners are squared off for the country button.
function styledPhoneInput(placeholder, inpStyle) {
    const w = phoneInput('phone', placeholder);
    Object.assign(w.input.style, inpStyle, { minWidth: 0, borderRadius: '0 8px 8px 0', borderLeft: '0' });
    return w;
}

// STOCK_LOG_V1 — who performed a stock movement (receives / adjustments).
function currentUserId() { return (typeof currentUser === 'function' && currentUser()?.id) || null; }

// PROCUREMENT_CATEGORIES_V1 — fixed catalog categories. Stored in
// clinic_items.procurement_category as the stable `key`; displayed in the
// active UI language. is_drug is derived (key === 'medicines').
const PRODUCT_CATEGORIES = [
    { key: 'medicines',    en: 'Medicines',                       ru: 'Лекарственные средства',                 uz: 'Dori vositalari' },
    { key: 'consumables',  en: 'Medical Consumables',             ru: 'Медицинские расходные материалы',        uz: 'Tibbiy sarflanadigan materiallar' },
    { key: 'equipment',    en: 'Medical Equipment',               ru: 'Медицинское оборудование',               uz: 'Tibbiy uskunalar' },
    { key: 'lab_supplies', en: 'Laboratory Supplies',             ru: 'Лабораторные материалы',                 uz: 'Laboratoriya materiallari' },
    { key: 'dental',       en: 'Dental Supplies',                 ru: 'Стоматологические материалы',            uz: 'Stomatologiya materiallari' },
    { key: 'radiology',    en: 'Radiology Supplies',              ru: 'Материалы для радиологии',               uz: 'Radiologiya materiallari' },
    { key: 'office_it',    en: 'Office & IT Supplies',            ru: 'Офисные и IT-принадлежности',            uz: 'Ofis va IT jihozlari' },
    { key: 'facility',     en: 'Facility & Maintenance Supplies', ru: 'Хозяйственные материалы и обслуживание', uz: 'Xoʻjalik va texnik xizmat materiallari' },
];
// PROCUREMENT_I18N_V1 — module labels in the active UI language.
const PR_L = {
    en: { title: 'Procurement', subtitle: 'Stock on hand, suppliers, and purchase orders — across the clinic’s branches.',
          reload: ' Reload', tabStock: 'Stock', tabPos: 'Purchase orders', tabProducts: 'Products', tabSuppliers: 'Suppliers',
          tabDepts: 'Departments',   // DEPT_USAGE_V1
          unSection: 'Units of measure', unBase: 'Base unit', unPurchase: 'Purchase unit', unCons: 'Dispensing unit',
          unPer: 'base units in 1', unEntry: 'Unit',
          unHint: 'Stock is always held in the base unit. Leave the factor at 1 when there is no packaging to convert.',
          unStockedIn: 'Stock is counted in this unit — the smallest one.', unBuyHead: 'How you BUY it', unBuyHint: "Leave the number at 1 if you don't buy in packs.", unGiveHead: 'How you DISPENSE it to patients', unGiveHint: 'Usually the same as the base unit — leave it at 1.',
          unSuggest: 'Looks like', unApply: 'Apply', unReviewed: 'Units confirmed',
          unNeedsReview: 'Units not confirmed yet', unConverted: 'will be stored as',
          dpHdr: ' Department stock', dpSub: 'Issued from the warehouse vs actually used on patients.',
          dpProduct: 'Product', dpGot: 'Received from stock', dpUsed: 'Used on patients', dpLeft: 'Left',
          dpSearch: 'Search product…', dpNoHits: 'Nothing found.',
          dpBal: 'On hand in department', dpDisp: 'To dispense', dpCost: 'Cost / unit', dpLegacy: 'Issues made before stock locations are not counted here.',
          tabExpiry: 'Expiry', tabValue: 'Valuation', tabReq: 'Requisitions', tabDash: 'Dashboard',
          rqHdr: 'Purchase requisitions', rqSub: 'Request items, get approval, then convert to a purchase order.',
          rqNew: 'New requisition', rqNum: 'Req #', rqStatus: 'Status', rqLines: 'Items', rqCreated: 'Created', rqActions: '',
          rqEmpty: 'No requisitions yet. Create one to request stock.', rqNeedMig: 'Apply migration 124 to enable requisitions.',
          rqSt_submitted: 'Awaiting approval', rqSt_approved: 'Approved', rqSt_rejected: 'Rejected', rqSt_converted: 'Ordered', rqSt_cancelled: 'Cancelled',
          rqApprove: 'Approve', rqReject: 'Reject', rqCancel: 'Cancel', rqConvert: 'Convert to PO', rqIssued: 'Issued to dept', rqRejectReason: 'Reason for rejection (optional)',
          rqCreateTitle: 'New requisition', rqCreateSub: 'List the items you need; an administrator approves before it becomes an order.',
          rqLineHint: 'Search a product to add it to the request.', rqQtyPh: 'qty', rqErrLines: 'Add at least one item with a quantity.',
          rqOk: 'Requisition created.', rqApproved: 'Requisition approved.', rqRejected: 'Requisition rejected.', rqCancelled: 'Requisition cancelled.', rqConverted: 'Purchase order created: ',
          tabCount: 'Stock count', tabAudit: 'Audit log',
          cnHdr: 'Stock counts', cnSub: 'Count what is on the shelf; the system posts the variance so on-hand matches reality. A count at a department seeds its opening balance.',
          cnNew: 'New count', cnNum: 'Count #', cnLoc: 'Location', cnLines: 'Items', cnVar: 'Variances', cnWhen: 'Posted', cnEmpty: 'No counts yet. Start one to reconcile stock.', cnNeedMig: 'Apply migration 125 to enable stock counts.',
          cnCreateTitle: 'New stock count', cnCreateSub: 'Pick a location, enter what you physically counted; the difference is posted as one adjustment per line.',
          cnBranch: 'Branch', cnPickLoc: 'Location', cnSystem: 'System', cnCounted: 'Counted', cnDiff: 'Variance', cnAddHint: 'Search a product to count it.', cnErrLines: 'Add at least one item and enter its counted quantity.', cnPost: 'Post count', cnOk: 'Count posted — stock reconciled.',
          auHdr: 'Stock movement log', auSub: 'Every stock change — who, when, what, and why.', auAll: 'All types', auSearch: 'Search product…', auWhen: 'When', auItem: 'Product', auKind: 'Type', auQty: 'Qty', auWhere: 'Location', auWhy: 'Reference', auWho: 'By', auEmpty: 'No movements match.', auNeedLoc: '—',
          vlHdr: 'Inventory valuation', vlSub: 'On-hand value at cost. WAC = moving weighted average; FIFO values remaining stock at the most recent purchase costs.',
          vlMethod: 'Costing method', vlWac: 'Weighted average', vlFifo: 'FIFO',
          vlProduct: 'Product', vlQty: 'On hand', vlCost: 'Unit cost', vlValue: 'Value', vlTotal: 'Total inventory value',
          vlNoCost: 'no cost', vlEmpty: 'Nothing on hand to value yet.', vlNeedMig: 'Apply migration 123 to enable costing.', vlSaved: 'Costing method saved.',
          bxTrack: 'Track batches & expiry', bxTrackHint: 'Capture a lot number and expiry on receipt; dispensing then follows FEFO (earliest expiry first).',
          prodExpiry: 'Expiration date',
          bxBatch: 'Batch / lot №', bxExpiry: 'Expiry date', bxBatchPh: 'lot №', bxGen: 'Generate a new code', utilize: 'Utilize', utTitle: 'Utilize (write off)', utSub: 'Removes the selected lot quantity from stock.', utQty: 'Quantity to utilize', utReason: 'Reason (optional)', utReasonPh: 'e.g. expired, damaged…', utDo: 'Utilize', utOk: 'Written off from stock.', utErrQty: 'Enter a quantity greater than 0.', utErrMax: 'Cannot exceed the on-hand quantity.', vlSupplier: 'Supplier', rcSupplier: 'Supplier', rcSupplierPh: 'Select supplier…', fltSearch: 'Search…', fltAllStatus: 'All statuses', fltActive: 'Active', fltInactive: 'Inactive', fltAllSups: 'All suppliers', fltAllCats: 'All categories', fltAllBranches: 'All branches', fltAllDepts: 'All departments', stOrder: 'Order', stRecvOrder: 'Receive order', 
          exHdr: 'Batches & expiry', exSub: 'On-hand lots by expiry date. Earliest first — dispensing consumes these first (FEFO).',
          exProduct: 'Product', exBatch: 'Batch', exExpiry: 'Expiry', exLoc: 'Location', exQty: 'On hand', exDays: 'Days left',
          exExpired: 'Expired', exSoon: 'Expiring soon', exOk: 'OK', exEmpty: 'No tracked lots yet. Turn on «Track batches» for a product, then receive it.', exNeedMig: 'Apply migration 122 to enable batch tracking.',
          dpEmpty: 'Nothing issued to this department yet.', dpMigration: 'Department storage locations could not be loaded. Reload the page; if it persists, contact your administrator.',
          stockHdr: ' Stock on hand', adjust: ' Adjust', receive: ' Receive',
          productsHdr: ' Products ', addProduct: ' Add product', importExcel: ' Import from Excel', sampleFile: ' Template',
          suppliersHdr: ' Suppliers ', addSupplier: ' Add supplier',
          posHdr: ' Purchase orders', newPO: ' New PO',
          issue: ' Issue', issueTitle: 'Issue to staff', issueSub: 'Deducts from stock and prints a signed requisition slip.',
          qty: 'Quantity *', recipient: 'Receiver *', note: 'Note', cancel: 'Cancel', issuePrint: ' Issue & print',
          staffSearch: 'Search employee by name…', noStaffSel: 'No employee selected.',
          // BULK_ISSUE_I18N_V1
          biTitle: 'Issue products', biSub: 'Several items to one recipient — deducts from stock and prints a requisition slip.',
          biBranch: 'Branch *', biDept: 'Issued to *', biInpatient: 'Inpatient', biOutpatient: 'Outpatient', biSurgery: 'Surgery theatre', biCssd: 'CSSD (ОЦС)',
          biItems: 'Products *', biItemsHint: 'Find a product in the search below — you can add several lines.',
          biProdSearch: 'Search product — pick to add…', biPickBranch: 'Choose a branch first.',
          biNothing: 'Nothing found.', biOnHand: 'In stock: ', biQtyPh: 'qty', biRemove: 'Remove',
          biNotePh: 'Purpose / note (optional)',
          biErrBranch: 'Choose a branch.', biErrLines: 'Add at least one product with a quantity above 0.',
          biErrShort: 'Not enough in stock: ', biErrShort2: ' — in stock ',
          biErrRecipient: 'Choose the employee receiving the goods.',
          biNoBranches: 'No branches for this clinic.', biBranchPh: 'Select a branch…',
          biDeptPh: 'Select where to issue…', biErrDept: 'Choose where the goods are issued to.',
          // RECEIVE_MULTI_V1
          poNewSupplier: ' New supplier',   // PO_NEW_SUPPLIER_V1
          rcTitle: 'Receive stock', rcSub: 'Records +receipt movements; on-hand updates automatically.',
          rcItems: 'Products *', rcItemsHint: 'Find a product below — you can receive several at once.',
          rcProdSearch: 'Search product — pick to add…', rcCreate: ' New product',
          rcQtyPh: 'qty', rcCostPh: 'unit cost', rcNotePh: 'Optional',
          rcErrLines: 'Add at least one product with a quantity above 0.',
          rcOk: 'Received positions: ', rcTotal: 'Total: ', rcReceive: ' Receive', rcPrintLabels: ' Print labels', rcNoLabels: 'No batch codes to print.',
          biOk: 'Issued positions: ', biPopup: 'Pop-up blocked — allow pop-ups to print the slip.',
          slipTitle: 'Requisition slip №', slipDept: 'Issued to:', slipRecipient: 'Recipient:', slipNote: 'Note:',
          slipNo: '№', slipName: 'Item', slipUnit: 'Unit', slipQty: 'Qty',
          slipIssuedBy: 'Issued by:', slipReceivedBy: 'Received by:', slipSign: '(signature)' },
    ru: { title: 'Закупки', subtitle: 'Остатки, поставщики и заказы на закупку — по всем филиалам клиники.',
          reload: ' Обновить', tabStock: 'Склад', tabPos: 'Заказы на закупку', tabProducts: 'Товары', tabSuppliers: 'Поставщики',
          tabDepts: 'Отделения',   // DEPT_USAGE_V1
          unSection: 'Единицы измерения', unBase: 'Базовая единица', unPurchase: 'Единица закупки', unCons: 'Единица выдачи',
          unPer: 'базовых единиц в 1', unEntry: 'Ед.',
          unHint: 'Остаток всегда хранится в базовой единице. Оставьте коэффициент 1, если пересчитывать нечего.',
          unStockedIn: 'В ней считается остаток — самая мелкая единица.', unBuyHead: 'Как вы ЗАКУПАЕТЕ', unBuyHint: 'Оставьте 1, если не закупаете упаковками.', unGiveHead: 'Как ВЫДАЁТЕ пациенту', unGiveHint: 'Обычно совпадает с базовой — оставьте 1.',
          unSuggest: 'Похоже, что', unApply: 'Применить', unReviewed: 'Единицы подтверждены',
          unNeedsReview: 'Единицы ещё не подтверждены', unConverted: 'будет записано как',
          dpHdr: ' Товары по отделениям', dpSub: 'Выдано со склада и сколько фактически израсходовано на пациентов.',
          dpProduct: 'Товар', dpGot: 'Получено со склада', dpUsed: 'Израсходовано на пациентов', dpLeft: 'Остаток',
          dpSearch: 'Поиск товара…', dpNoHits: 'Ничего не найдено.',
          dpBal: 'Остаток в отделении', dpDisp: 'К выдаче', dpCost: 'Себест. / ед.', dpLegacy: 'Выдачи, сделанные до появления мест хранения, здесь не учитываются.',
          tabExpiry: 'Сроки годности', tabValue: 'Оценка склада', tabReq: 'Заявки', tabDash: 'Дашборд',
          rqHdr: 'Заявки на закупку', rqSub: 'Запросите товары, получите согласование и превратите в заказ на закупку.',
          rqNew: 'Новая заявка', rqNum: 'Заявка №', rqStatus: 'Статус', rqLines: 'Позиции', rqCreated: 'Создана', rqActions: '',
          rqEmpty: 'Заявок пока нет. Создайте, чтобы запросить товары.', rqNeedMig: 'Примените миграцию 124 для работы с заявками.',
          rqSt_submitted: 'На согласовании', rqSt_approved: 'Согласована', rqSt_rejected: 'Отклонена', rqSt_converted: 'В заказе', rqSt_cancelled: 'Отменена',
          rqApprove: 'Согласовать', rqReject: 'Отклонить', rqCancel: 'Отменить', rqConvert: 'В заказ', rqIssued: 'Выдано в отдел', rqRejectReason: 'Причина отклонения (необязательно)',
          rqCreateTitle: 'Новая заявка', rqCreateSub: 'Перечислите нужные товары; администратор согласует до превращения в заказ.',
          rqLineHint: 'Найдите товар, чтобы добавить в заявку.', rqQtyPh: 'кол-во', rqErrLines: 'Добавьте хотя бы одну позицию с количеством.',
          rqOk: 'Заявка создана.', rqApproved: 'Заявка согласована.', rqRejected: 'Заявка отклонена.', rqCancelled: 'Заявка отменена.', rqConverted: 'Создан заказ на закупку: ',
          tabCount: 'Инвентаризация', tabAudit: 'Журнал',
          cnHdr: 'Инвентаризация', cnSub: 'Посчитайте фактический остаток; система проведёт расхождение, чтобы остаток совпал с реальностью. Инвентаризация по отделению задаёт его начальный остаток.',
          cnNew: 'Новый пересчёт', cnNum: 'Пересчёт №', cnLoc: 'Место', cnLines: 'Позиции', cnVar: 'Расхождения', cnWhen: 'Проведён', cnEmpty: 'Пересчётов пока нет. Начните, чтобы сверить остатки.', cnNeedMig: 'Примените миграцию 125 для инвентаризации.',
          cnCreateTitle: 'Новая инвентаризация', cnCreateSub: 'Выберите место, введите фактически посчитанное; разница проводится одной корректировкой на позицию.',
          cnBranch: 'Филиал', cnPickLoc: 'Место', cnSystem: 'В системе', cnCounted: 'Посчитано', cnDiff: 'Расхождение', cnAddHint: 'Найдите товар для пересчёта.', cnErrLines: 'Добавьте хотя бы одну позицию и введите посчитанное количество.', cnPost: 'Провести', cnOk: 'Инвентаризация проведена — остатки сверены.',
          auHdr: 'Журнал движений', auSub: 'Каждое изменение остатка — кто, когда, что и почему.', auAll: 'Все типы', auSearch: 'Поиск товара…', auWhen: 'Когда', auItem: 'Товар', auKind: 'Тип', auQty: 'Кол-во', auWhere: 'Место', auWhy: 'Основание', auWho: 'Кто', auEmpty: 'Нет подходящих движений.', auNeedLoc: '—',
          vlHdr: 'Оценка запасов', vlSub: 'Стоимость остатков по себестоимости. WAC — скользящая средняя; FIFO оценивает остаток по последним ценам закупки.',
          vlMethod: 'Метод учёта', vlWac: 'Средневзвешенная', vlFifo: 'ФИФО',
          vlProduct: 'Товар', vlQty: 'Остаток', vlCost: 'Себестоимость', vlValue: 'Стоимость', vlTotal: 'Итого стоимость запасов',
          vlNoCost: 'нет цены', vlEmpty: 'Пока нечего оценивать.', vlNeedMig: 'Примените миграцию 123 для учёта себестоимости.', vlSaved: 'Метод учёта сохранён.',
          bxTrack: 'Учёт партий и сроков', bxTrackHint: 'Фиксируйте номер партии и срок годности при приёмке; выдача идёт по FEFO (сначала с ближайшим сроком).',
          prodExpiry: 'Срок годности',
          bxBatch: 'Партия / серия №', bxExpiry: 'Срок годности', bxBatchPh: 'серия №', bxGen: 'Сгенерировать новый код', utilize: 'Утилизировать', utTitle: 'Утилизация (списание)', utSub: 'Списывает выбранное количество партии со склада.', utQty: 'Количество к утилизации', utReason: 'Причина (необязательно)', utReasonPh: 'напр. просрочка, брак…', utDo: 'Списать', utOk: 'Списано со склада.', utErrQty: 'Укажите количество больше 0.', utErrMax: 'Нельзя больше остатка на складе.', vlSupplier: 'Поставщик', rcSupplier: 'Поставщик', rcSupplierPh: 'Выберите поставщика…', fltSearch: 'Поиск…', fltAllStatus: 'Все статусы', fltActive: 'Активные', fltInactive: 'Неактивные', fltAllSups: 'Все поставщики', fltAllCats: 'Все категории', fltAllBranches: 'Все филиалы', fltAllDepts: 'Все отделы', stOrder: 'Заказать', stRecvOrder: 'Принять заказ', 
          exHdr: 'Партии и сроки годности', exSub: 'Остатки партий по сроку годности. Сначала ближайшие — они и расходуются первыми (FEFO).',
          exProduct: 'Товар', exBatch: 'Партия', exExpiry: 'Срок', exLoc: 'Место', exQty: 'Остаток', exDays: 'Осталось дней',
          exExpired: 'Просрочено', exSoon: 'Скоро истекает', exOk: 'ОК', exEmpty: 'Пока нет партий. Включите «Учёт партий» у товара и примите его.', exNeedMig: 'Примените миграцию 122 для учёта партий.',
          dpEmpty: 'В это отделение пока ничего не выдавали.', dpMigration: 'Не удалось загрузить места хранения отделения. Обновите страницу; если не помогает — обратитесь к администратору.',
          stockHdr: ' Остатки на складе', adjust: ' Корректировка', receive: ' Принять',
          productsHdr: ' Товары ', addProduct: ' Добавить товар', importExcel: ' Импорт из Excel', sampleFile: ' Шаблон',
          suppliersHdr: ' Поставщики ', addSupplier: ' Добавить поставщика',
          posHdr: ' Заказы на закупку', newPO: ' Новый заказ',
          issue: ' Выдать', issueTitle: 'Выдать товар', issueSub: 'Списывает со склада и печатает требование-накладную для подписи.',
          qty: 'Количество *', recipient: 'Кто получает *', note: 'Примечание', cancel: 'Отмена', issuePrint: ' Выдать и печать',
          staffSearch: 'Поиск сотрудника по имени…', noStaffSel: 'Сотрудник не выбран.',
          // BULK_ISSUE_I18N_V1
          biTitle: 'Выдача товаров', biSub: 'Несколько позиций одному получателю — списывает со склада и печатает требование-накладную.',
          biBranch: 'Филиал *', biDept: 'Куда выдаётся *', biInpatient: 'Стационар', biOutpatient: 'Амбулаторный', biSurgery: 'Операционная', biCssd: 'ОЦС',
          biItems: 'Товары *', biItemsHint: 'Найдите товар в поиске ниже — можно добавить несколько позиций.',
          biProdSearch: 'Поиск товара — выберите, чтобы добавить…', biPickBranch: 'Сначала выберите филиал.',
          biNothing: 'Ничего не найдено.', biOnHand: 'В наличии: ', biQtyPh: 'кол-во', biRemove: 'Убрать',
          biNotePh: 'Назначение / примечание (необязательно)',
          biErrBranch: 'Выберите филиал.', biErrLines: 'Добавьте хотя бы один товар с количеством больше 0.',
          biErrShort: 'Недостаточно на складе: ', biErrShort2: ' — в наличии ',
          biErrRecipient: 'Выберите сотрудника, который получает товар.',
          biNoBranches: 'Нет филиалов для этой клиники.', biBranchPh: 'Выберите филиал…',
          biDeptPh: 'Выберите, куда выдаётся…', biErrDept: 'Выберите, куда выдаётся товар.',
          // RECEIVE_MULTI_V1
          poNewSupplier: ' Новый поставщик',   // PO_NEW_SUPPLIER_V1
          rcTitle: 'Принять товар', rcSub: 'Фиксирует приход; остаток обновляется автоматически.',
          rcItems: 'Товары *', rcItemsHint: 'Найдите товар ниже — можно принять несколько позиций сразу.',
          rcProdSearch: 'Поиск товара — выберите, чтобы добавить…', rcCreate: ' Новый товар',
          rcQtyPh: 'кол-во', rcCostPh: 'цена за ед.', rcNotePh: 'Необязательно',
          rcErrLines: 'Добавьте хотя бы один товар с количеством больше 0.',
          rcOk: 'Принято позиций: ', rcTotal: 'Итого: ', rcReceive: ' Приход', rcPrintLabels: ' Печать этикеток', rcNoLabels: 'Нет кодов партий для печати.',
          biOk: 'Выдано позиций: ', biPopup: 'Всплывающее окно заблокировано — разрешите pop-ups для печати накладной.',
          slipTitle: 'Требование-накладная №', slipDept: 'Куда выдаётся:', slipRecipient: 'Получатель:', slipNote: 'Примечание:',
          slipNo: '№', slipName: 'Наименование', slipUnit: 'Ед.', slipQty: 'Кол-во',
          slipIssuedBy: 'Выдал:', slipReceivedBy: 'Получил:', slipSign: '(подпись)' },
    uz: { title: 'Xaridlar', subtitle: 'Ombor qoldiqlari, yetkazib beruvchilar va xarid buyurtmalari — klinikaning barcha filiallari boʻyicha.',
          reload: ' Yangilash', tabStock: 'Ombor', tabPos: 'Xarid buyurtmalari', tabProducts: 'Mahsulotlar', tabSuppliers: 'Yetkazib beruvchilar',
          tabDepts: 'Boʻlimlar',   // DEPT_USAGE_V1
          unSection: 'Oʻlchov birliklari', unBase: 'Asosiy birlik', unPurchase: 'Xarid birligi', unCons: 'Berish birligi',
          unPer: 'ta asosiy birlik 1 da', unEntry: 'Birlik',
          unHint: 'Qoldiq doimo asosiy birlikda saqlanadi. Qayta hisoblash kerak boʻlmasa, koeffitsiyentni 1 qoldiring.',
          unStockedIn: 'Qoldiq shunda hisoblanadi — eng kichik birlik.', unBuyHead: 'Qanday XARID qilasiz', unBuyHint: 'Paketlarda sotib olmasangiz 1 qoldiring.', unGiveHead: 'Bemorga qanday BERASIZ', unGiveHint: 'Odatda bazaviy birlik bilan bir xil — 1 qoldiring.',
          unSuggest: 'Koʻrinishidan', unApply: 'Qoʻllash', unReviewed: 'Birliklar tasdiqlangan',
          unNeedsReview: 'Birliklar hali tasdiqlanmagan', unConverted: 'sifatida yoziladi',
          dpHdr: ' Boʻlimlar boʻyicha mahsulotlar', dpSub: 'Ombordan berilgan va bemorlarga sarflangan miqdor.',
          dpProduct: 'Mahsulot', dpGot: 'Ombordan olingan', dpUsed: 'Bemorlarga sarflangan', dpLeft: 'Qoldiq',
          dpSearch: 'Mahsulot qidirish…', dpNoHits: 'Hech narsa topilmadi.',
          dpBal: 'Boʻlimdagi qoldiq', dpDisp: 'Berishga', dpCost: 'Tannarx / birlik', dpLegacy: 'Saqlash joylari joriy etilgunga qadar berilganlar bu yerda hisobga olinmaydi.',
          tabExpiry: 'Yaroqlilik muddati', tabValue: 'Ombor bahosi', tabReq: 'Arizalar', tabDash: 'Boshqaruv paneli',
          rqHdr: 'Xarid arizalari', rqSub: 'Mahsulot soʻrang, tasdiqlatib, xarid buyurtmasiga aylantiring.',
          rqNew: 'Yangi ariza', rqNum: 'Ariza №', rqStatus: 'Holat', rqLines: 'Pozitsiyalar', rqCreated: 'Yaratilgan', rqActions: '',
          rqEmpty: 'Hozircha arizalar yoʻq. Mahsulot soʻrash uchun yarating.', rqNeedMig: 'Arizalar uchun 124-migratsiyani qoʻllang.',
          rqSt_submitted: 'Tasdiq kutilmoqda', rqSt_approved: 'Tasdiqlangan', rqSt_rejected: 'Rad etilgan', rqSt_converted: 'Buyurtmada', rqSt_cancelled: 'Bekor qilingan',
          rqApprove: 'Tasdiqlash', rqReject: 'Rad etish', rqCancel: 'Bekor qilish', rqConvert: 'Buyurtmaga', rqIssued: 'Boʻlimga berildi', rqRejectReason: 'Rad etish sababi (ixtiyoriy)',
          rqCreateTitle: 'Yangi ariza', rqCreateSub: 'Kerakli mahsulotlarni sanang; administrator buyurtmaga aylantirishdan oldin tasdiqlaydi.',
          rqLineHint: 'Qoʻshish uchun mahsulotni qidiring.', rqQtyPh: 'soni', rqErrLines: 'Kamida bitta pozitsiya qoʻshing.',
          rqOk: 'Ariza yaratildi.', rqApproved: 'Ariza tasdiqlandi.', rqRejected: 'Ariza rad etildi.', rqCancelled: 'Ariza bekor qilindi.', rqConverted: 'Xarid buyurtmasi yaratildi: ',
          tabCount: 'Inventarizatsiya', tabAudit: 'Jurnal',
          cnHdr: 'Inventarizatsiya', cnSub: 'Javondagi haqiqiy qoldiqni sanang; tizim farqni oʻtkazadi. Boʻlim boʻyicha inventarizatsiya uning boshlangʻich qoldigʻini beradi.',
          cnNew: 'Yangi sanoq', cnNum: 'Sanoq №', cnLoc: 'Joy', cnLines: 'Pozitsiyalar', cnVar: 'Farqlar', cnWhen: 'Oʻtkazilgan', cnEmpty: 'Hozircha sanoqlar yoʻq. Qoldiqni solishtirish uchun boshlang.', cnNeedMig: 'Inventarizatsiya uchun 125-migratsiyani qoʻllang.',
          cnCreateTitle: 'Yangi inventarizatsiya', cnCreateSub: 'Joyni tanlang, haqiqatda sanalganini kiriting; farq har bir pozitsiya boʻyicha bitta tuzatish sifatida oʻtkaziladi.',
          cnBranch: 'Filial', cnPickLoc: 'Joy', cnSystem: 'Tizimda', cnCounted: 'Sanaldi', cnDiff: 'Farq', cnAddHint: 'Sanash uchun mahsulotni qidiring.', cnErrLines: 'Kamida bitta pozitsiya qoʻshing va sanalgan sonini kiriting.', cnPost: 'Oʻtkazish', cnOk: 'Inventarizatsiya oʻtkazildi — qoldiqlar solishtirildi.',
          auHdr: 'Harakatlar jurnali', auSub: 'Har bir qoldiq oʻzgarishi — kim, qachon, nima va nega.', auAll: 'Barcha turlar', auSearch: 'Mahsulot qidirish…', auWhen: 'Qachon', auItem: 'Mahsulot', auKind: 'Tur', auQty: 'Soni', auWhere: 'Joy', auWhy: 'Asos', auWho: 'Kim', auEmpty: 'Mos harakat yoʻq.', auNeedLoc: '—',
          vlHdr: 'Zaxira bahosi', vlSub: 'Qoldiqning tannarxdagi qiymati. WAC — siljuvchi oʻrtacha; FIFO qoldiqni oxirgi xarid narxlarida baholaydi.',
          vlMethod: 'Hisob usuli', vlWac: 'Oʻrtacha tortilgan', vlFifo: 'FIFO',
          vlProduct: 'Mahsulot', vlQty: 'Qoldiq', vlCost: 'Tannarx', vlValue: 'Qiymat', vlTotal: 'Jami zaxira qiymati',
          vlNoCost: 'narx yoʻq', vlEmpty: 'Hozircha baholanadigan narsa yoʻq.', vlNeedMig: 'Tannarx hisobi uchun 123-migratsiyani qoʻllang.', vlSaved: 'Hisob usuli saqlandi.',
          bxTrack: 'Partiya va muddat hisobi', bxTrackHint: 'Qabulda partiya raqami va muddatini kiriting; berish FEFO boʻyicha (avval muddati yaqinlari).',
          prodExpiry: 'Yaroqlilik muddati',
          bxBatch: 'Partiya / seriya №', bxExpiry: 'Yaroqlilik muddati', bxBatchPh: 'seriya №', bxGen: 'Yangi kod yaratish', utilize: 'Utilizatsiya', utTitle: 'Utilizatsiya (hisobdan chiqarish)', utSub: 'Tanlangan partiya miqdorini ombordan chiqaradi.', utQty: 'Utilizatsiya miqdori', utReason: 'Sabab (ixtiyoriy)', utReasonPh: 'masalan muddati oʻtgan…', utDo: 'Chiqarish', utOk: 'Ombordan chiqarildi.', utErrQty: '0 dan katta miqdor kiriting.', utErrMax: 'Qoldiqdan koʻp boʻlishi mumkin emas.', vlSupplier: 'Yetkazib beruvchi', rcSupplier: 'Yetkazib beruvchi', rcSupplierPh: 'Yetkazib beruvchini tanlang…', fltSearch: 'Qidirish…', fltAllStatus: 'Barcha holatlar', fltActive: 'Faol', fltInactive: 'Nofaol', fltAllSups: 'Barcha yetkazuvchilar', fltAllCats: 'Barcha toifalar', fltAllBranches: 'Barcha filiallar', fltAllDepts: 'Barcha boʻlimlar', stOrder: 'Buyurtma berish', stRecvOrder: 'Buyurtmani qabul qilish', 
          exHdr: 'Partiyalar va muddatlar', exSub: 'Partiyalar qoldigʻi muddat boʻyicha. Avval yaqinlari — ular birinchi sarflanadi (FEFO).',
          exProduct: 'Mahsulot', exBatch: 'Partiya', exExpiry: 'Muddat', exLoc: 'Joy', exQty: 'Qoldiq', exDays: 'Qolgan kun',
          exExpired: 'Muddati oʻtgan', exSoon: 'Muddati yaqin', exOk: 'OK', exEmpty: 'Hozircha partiyalar yoʻq. Mahsulotda «Partiya hisobi»ni yoqing va qabul qiling.', exNeedMig: 'Partiya hisobi uchun 122-migratsiyani qoʻllang.',
          dpEmpty: 'Bu boʻlimga hali hech narsa berilmagan.', dpMigration: 'Boʻlim saqlash joylari yuklanmadi. Sahifani yangilang; agar takrorlansa — administratorga murojaat qiling.',
          stockHdr: ' Ombordagi qoldiq', adjust: ' Tuzatish', receive: ' Qabul qilish',
          productsHdr: ' Mahsulotlar ', addProduct: ' Mahsulot qoʻshish', importExcel: ' Excel’dan import', sampleFile: ' Shablon',
          suppliersHdr: ' Yetkazib beruvchilar ', addSupplier: ' Yetkazib beruvchi qoʻshish',
          posHdr: ' Xarid buyurtmalari', newPO: ' Yangi buyurtma',
          issue: ' Berish', issueTitle: 'Mahsulot berish', issueSub: 'Ombordan chiqim qilinadi va imzo uchun talabnoma chop etiladi.',
          qty: 'Miqdor *', recipient: 'Kim oladi *', note: 'Izoh', cancel: 'Bekor qilish', issuePrint: ' Berish va chop etish',
          staffSearch: 'Xodimni ism boʻyicha qidirish…', noStaffSel: 'Xodim tanlanmagan.',
          // BULK_ISSUE_I18N_V1
          biTitle: 'Mahsulot berish', biSub: 'Bir oluvchiga bir nechta pozitsiya — ombordan chiqim qilinadi va talabnoma chop etiladi.',
          biBranch: 'Filial *', biDept: 'Qayerga beriladi *', biInpatient: 'Statsionar', biOutpatient: 'Ambulatoriya', biSurgery: 'Operatsion blok', biCssd: 'ОЦС',
          biItems: 'Mahsulotlar *', biItemsHint: 'Quyidagi qidiruvdan mahsulotni toping — bir nechta pozitsiya qoʻshish mumkin.',
          biProdSearch: 'Mahsulot qidirish — qoʻshish uchun tanlang…', biPickBranch: 'Avval filialni tanlang.',
          biNothing: 'Hech narsa topilmadi.', biOnHand: 'Mavjud: ', biQtyPh: 'miqdor', biRemove: 'Olib tashlash',
          biNotePh: 'Maqsad / izoh (ixtiyoriy)',
          biErrBranch: 'Filialni tanlang.', biErrLines: 'Kamida bitta mahsulotni 0 dan katta miqdor bilan qoʻshing.',
          biErrShort: 'Omborda yetarli emas: ', biErrShort2: ' — mavjud ',
          biErrRecipient: 'Mahsulotni oladigan xodimni tanlang.',
          biNoBranches: 'Bu klinika uchun filiallar yoʻq.', biBranchPh: 'Filialni tanlang…',
          biDeptPh: 'Qayerga berilishini tanlang…', biErrDept: 'Mahsulot qayerga berilishini tanlang.',
          // RECEIVE_MULTI_V1
          poNewSupplier: ' Yangi yetkazib beruvchi',   // PO_NEW_SUPPLIER_V1
          rcTitle: 'Mahsulot qabul qilish', rcSub: 'Kirim qayd etiladi; qoldiq avtomatik yangilanadi.',
          rcItems: 'Mahsulotlar *', rcItemsHint: 'Quyidan mahsulotni toping — bir vaqtda bir nechtasini qabul qilish mumkin.',
          rcProdSearch: 'Mahsulot qidirish — qoʻshish uchun tanlang…', rcCreate: ' Yangi mahsulot',
          rcQtyPh: 'miqdor', rcCostPh: 'birlik narxi', rcNotePh: 'Ixtiyoriy',
          rcErrLines: 'Kamida bitta mahsulotni 0 dan katta miqdor bilan qoʻshing.',
          rcOk: 'Qabul qilingan pozitsiyalar: ', rcTotal: 'Jami: ', rcReceive: ' Kirim', rcPrintLabels: ' Yorliqlarni chop etish', rcNoLabels: 'Chop etish uchun partiya kodlari yoʻq.',
          biOk: 'Berilgan pozitsiyalar: ', biPopup: 'Qalqib chiquvchi oyna bloklandi — talabnomani chop etish uchun ruxsat bering.',
          slipTitle: 'Talabnoma №', slipDept: 'Qayerga beriladi:', slipRecipient: 'Oluvchi:', slipNote: 'Izoh:',
          slipNo: '№', slipName: 'Nomi', slipUnit: 'Oʻlchov', slipQty: 'Miqdor',
          slipIssuedBy: 'Berdi:', slipReceivedBy: 'Oldi:', slipSign: '(imzo)' },
};
function prL(key) {
    const lang = (typeof getLang === 'function' && getLang()) || 'en';
    return (PR_L[lang] || PR_L.en)[key] ?? PR_L.en[key] ?? key;
}

function catLabel(key) {
    const cat = PRODUCT_CATEGORIES.find(c => c.key === key);
    if (!cat) return null;
    const lang = (typeof getLang === 'function' && getLang()) || 'en';
    return cat[lang] || cat.en;
}

// ============================================================================
// Module state + shell refs
// ============================================================================
const state = {
    tab: 'stock',   // PROCUREMENT_TAB_ORDER_V1
    stockBranch: 'all',   // branch filter on the Stock tab ('all' or a branch id)
    stockQ: '',           // STOCK_SEARCH_V1 — text filter on the Stock tab (product/unit/branch)
    branches: [],         // [{ id, name }]
    items: [],            // clinic_items [{ id, name, unit, ... }]
    suppliers: [],        // suppliers [{ id, name, active, ... }]
    itemSuppliers: [],    // item_suppliers junction [{ id, item_id, supplier_id }] — PROCUREMENT_PRODUCTS_V1
    itemSuppliersOk: true, // false when migration 062 isn't applied yet
};
let containerRef = null;
let bodyEl = null;
const tabButtons = {};

const TAB_VIEWS = {
    products:  prProducts,   // PROCUREMENT_PRODUCTS_V1 — catalog + supplier links
    suppliers: prSuppliers,
    pos:       prPurchaseOrders,
    stock:     prStock,
    depts:     prDepartments,   // DEPT_USAGE_V1
    expiry:    prExpiry,        // BATCH_FEFO_V1
    valuation: prValuation,     // COSTING_V1
    requisitions: prRequisitions,   // REQUISITIONS_V1
    counts:    prCounts,        // STOCK_COUNTS_V1
    audit:     prAudit,         // STOCK_AUDIT_V1
};

// ============================================================================
// BATCH_FEFO_V1 (migration 122) — «Сроки годности»: on-hand lots by expiry.
// Reads batch_stock ⋈ stock_batches ⋈ stock_locations, earliest expiry first.
// ============================================================================
let exRows = [];
let exLoading = false;
let exMig = false;
let exWrap = null;

function prExpiry() {
    const wrap = h('div', { class: 'card' });
    exWrap = wrap;
    paintExpiry();
    loadExpiry().then(paintExpiry);
    return wrap;
}

async function loadExpiry() {
    const cid = currentClinicId();
    if (!cid) return;
    exLoading = true; exMig = false;
    try {
        const { data, error } = await supabase
            .from('batch_stock')
            .select('qty_on_hand, item_id, location_id, batch_id, stock_batches(batch_number, expiry_date)')   // BATCH_DISPOSE_V1
            .eq('company_id', cid).gt('qty_on_hand', 0).limit(5000);
        if (error) { exMig = true; exRows = []; return; }
        const byItem = new Map(state.items.map(i => [String(i.id), i]));
        const byLoc  = new Map((state.locations || []).map(l => [String(l.id), l]));
        exRows = (data || []).map(r => {
            const b = r.stock_batches || {};
            const loc = byLoc.get(String(r.location_id)) || { name: '—' };
            return {
                item: byItem.get(String(r.item_id)) || { name: '—' },
                itemId: r.item_id, loc, locationId: r.location_id, batchId: r.batch_id,   // BATCH_DISPOSE_V1
                batch: b.batch_number || '—',
                expiry: b.expiry_date || null,
                qty: Number(r.qty_on_hand || 0),
            };
        }).sort((a, b) => {
            if (!a.expiry) return 1; if (!b.expiry) return -1;
            return a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0;
        });
    } catch (e) {
        console.warn('[procurement] expiry:', e && e.message); exRows = [];
    } finally { exLoading = false; }
}

// BATCH_DISPOSE_V1 — write off (utilize) a quantity of a specific lot at its
// location. Goes through dispose_batch_stock (SECURITY DEFINER; mig 132) which
// posts a location- and batch-targeted adjustment, so item_stock AND the named
// batch both drop — no FEFO reassignment, and it works cross-clinic.
function openDisposeModal(r) {
    const max = Number(r.qty) || 0;
    const inpStyle = { height: '36px', padding: '0 10px', border: '1px solid #d1d5db',
        borderRadius: '8px', fontSize: '13.5px', width: '100%', boxSizing: 'border-box' };
    const qtyIn = h('input', { type: 'number', min: '0.0001', step: 'any', max: String(max),
        value: String(max), style: { ...inpStyle, textAlign: 'right' } });
    const noteIn = h('input', { type: 'text', placeholder: prL('utReasonPh'), style: { ...inpStyle, fontSize: '13.5px' } });
    const info = (label, val) => h('div', { class: 'row', style: { justifyContent: 'space-between', fontSize: '12.5px', padding: '3px 0' } },
        h('span', { class: 'muted' }, label), h('b', { style: { textAlign: 'right', overflowWrap: 'anywhere' } }, val));

    openModal({
        title: prL('utTitle'),
        subtitle: prL('utSub'),
        width: '440px',
        body: h('div', { class: 'modal-body' },
            h('div', { style: { border: '1px solid var(--ink-100)', borderRadius: '10px', padding: '10px 12px', marginBottom: '12px' } },
                info(prL('exProduct'), r.item.name || '—'),
                info(prL('exBatch'), r.batch || '—'),
                info(prL('exExpiry'), r.expiry || '—'),
                info(prL('exLoc'), r.loc.name || '—'),
                info(prL('exQty'), fmtNum(max))),
            h('div', { class: 'field' }, h('label', null, prL('utQty')), qtyIn),
            h('div', { class: 'field' }, h('label', null, prL('utReason')), noteIn)),
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, prL('cancel')),
            h('button', { class: 'btn btn-primary', type: 'button',
                style: { background: 'var(--crit-600, #dc2626)', borderColor: 'var(--crit-600, #dc2626)' },
                onclick: async (e) => {
                    const q = Number(qtyIn.value);
                    if (!(q > 0)) { toast(prL('utErrQty'), 'fail'); qtyIn.focus(); return; }
                    if (q > max) { toast(prL('utErrMax'), 'fail'); qtyIn.focus(); return; }
                    e.target.disabled = true;
                    try {
                        const { error } = await supabase.rpc('dispose_batch_stock', {
                            p_item: r.itemId, p_location: r.locationId, p_batch: r.batchId,
                            p_qty: q, p_note: noteIn.value.trim() || null,
                        });
                        if (error) throw error;
                        toast(prL('utOk'), 'ok');
                        close();
                        await loadExpiry(); paintExpiry();
                        try { await loadStock(); paintStockTable(); } catch (_) {}
                    } catch (err) { toast(err.message || String(err), 'fail'); e.target.disabled = false; }
                } }, prL('utDo')),
        ],
    });
}

function daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    return Math.round((d - new Date()) / 86400000);
}

function paintExpiry() {
    const wrap = exWrap; if (!wrap) return;
    clear(wrap);
    wrap.appendChild(h('div', { class: 'card-header' },
        h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            h('h3', null, Icon('Clock', { size: 16 }), prL('exHdr')),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, prL('exSub')))));

    if (state.batchOk === false || exMig) {
        wrap.appendChild(h('div', { class: 'empty', style: { padding: '22px', color: 'var(--warn-700, #b45309)' } }, prL('exNeedMig')));
        return;
    }
    if (exLoading) {
        wrap.appendChild(h('div', { class: 'muted', style: { padding: '20px', fontSize: '12.5px' } }, 'Loading…'));
        return;
    }

    const badge = (days) => {
        if (days == null) return h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '—');
        let bg = 'var(--ok-50)', fg = 'var(--ok-700)', txt = prL('exOk');
        if (days < 0)        { bg = 'var(--crit-50)'; fg = 'var(--crit-700)'; txt = prL('exExpired'); }
        else if (days <= 90) { bg = 'var(--warn-50, #fffbeb)'; fg = 'var(--warn-700, #b45309)'; txt = prL('exSoon'); }
        return h('span', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', padding: '1px 8px',
            borderRadius: '999px', background: bg, color: fg, fontSize: '12.5px', fontWeight: 700 } }, txt);
    };

    const tbody = h('tbody', null,
        ...(exRows.length ? exRows.map(r => {
            const days = daysUntil(r.expiry);
            const crit = days != null && days < 0;
            const warn = days != null && days >= 0 && days <= 90;
            return h('tr', null,
                h('td', { style: { whiteSpace: 'normal', overflowWrap: 'anywhere' } },
                    h('div', { class: 'cell-strong' }, r.item.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                        [r.item.strength, r.item.form, baseUnitOf(r.item)].filter(Boolean).join(' · '))),
                h('td', { class: 'muted' }, r.batch),
                h('td', { class: 'cell-strong', style: { color: crit ? 'var(--crit-700)' : (warn ? 'var(--warn-700, #b45309)' : '') } },
                    r.expiry || '—'),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, r.loc.name || '—'),
                h('td', { class: 'num cell-strong' }, fmtNum(r.qty)),
                h('td', { class: 'num' }, days == null ? '—' : fmtNum(days)),
                h('td', null, badge(days)),
                h('td', null, r.qty > 0 ? h('button', { class: 'btn btn-outline btn-sm', type: 'button',   // BATCH_DISPOSE_V1
                    style: { color: 'var(--crit-700, #b91c1c)', borderColor: 'var(--crit-200, #fecaca)', padding: '0 10px', whiteSpace: 'nowrap' },
                    onclick: () => openDisposeModal(r) }, prL('utilize')) : null));
        }) : [emptyRow(8, prL('exEmpty'))]));

    wrap.appendChild(h('table', { class: 'tbl' },
        h('thead', null, h('tr', null,
            h('th', null, prL('exProduct')), h('th', null, prL('exBatch')),
            h('th', null, prL('exExpiry')), h('th', null, prL('exLoc')),
            h('th', { class: 'num' }, prL('exQty')), h('th', { class: 'num' }, prL('exDays')),
            h('th', null, ''), h('th', null, ''))),   // BATCH_DISPOSE_V1 — actions
        tbody));
}

// ============================================================================
// COSTING_V1 (migration 123) — «Оценка склада»: on-hand value at cost.
//   WAC  — qty × clinic_items.avg_cost (moving weighted average, DB-maintained)
//   FIFO — value the on-hand qty against the most recent receipt cost layers,
//          replayed from the movement ledger.
// ============================================================================
let vlMethod = 'wac';
let vlRows = [];
let vlLoading = false;
let vlMig = false;
let vlWrap = null;

function prValuation() {
    const wrap = h('div', { class: 'card' });
    vlWrap = wrap;
    // seed from the company's saved preference, if present
    vlMethod = (window.CLINIC && window.CLINIC.costing_method) || vlMethod;
    paintValuation();
    loadValuation().then(paintValuation);
    return wrap;
}

async function loadValuation() {
    const cid = currentClinicId();
    if (!cid) return;
    vlLoading = true; vlMig = false;
    try {
        if (state.costOk === false) { vlMig = true; vlRows = []; return; }
        // On-hand per item (sum across locations) and the receipt cost layers.
        const [balRes, movRes] = await Promise.all([
            supabase.from('item_stock').select('item_id, qty_on_hand')
                .eq('company_id', cid).gt('qty_on_hand', 0).limit(5000),
            supabase.from('stock_movements').select('item_id, qty, unit_cost, created_at')
                .eq('company_id', cid).gt('qty', 0).not('unit_cost', 'is', null)
                .order('created_at', { ascending: false }).limit(5000),
        ]);
        if (balRes.error) { vlMig = true; vlRows = []; return; }
        const onHand = new Map();
        for (const b of (balRes.data || [])) {
            onHand.set(b.item_id, (onHand.get(b.item_id) || 0) + Number(b.qty_on_hand || 0));
        }
        // newest-first receipt layers per item, for FIFO ending value
        const layers = new Map();
        for (const m of (movRes.data || [])) {
            if (!layers.has(m.item_id)) layers.set(m.item_id, []);
            layers.get(m.item_id).push({ qty: Number(m.qty || 0), cost: Number(m.unit_cost || 0) });
        }
        const byId = new Map(state.items.map(i => [String(i.id), i]));
        vlRows = [...onHand.entries()].map(([id, qty]) => {
            const it = byId.get(String(id)) || { name: '—' };
            const wac = it.avg_cost == null ? null : Number(it.avg_cost);
            // FIFO: fill qty from the newest layers.
            let remaining = qty, fifoVal = 0, ls = layers.get(id) || [];
            for (const l of ls) {
                if (remaining <= 0) break;
                const take = Math.min(remaining, l.qty);
                fifoVal += take * l.cost; remaining -= take;
            }
            if (remaining > 0 && wac != null) fifoVal += remaining * wac;   // fall back for the tail
            const fifoCost = qty > 0 ? fifoVal / qty : null;
            return { item: it, qty, wac, fifoCost, wacVal: wac == null ? null : qty * wac, fifoVal: ls.length || wac != null ? fifoVal : null };
        }).sort((a, b) => (b.wacVal || 0) - (a.wacVal || 0));
    } catch (e) {
        console.warn('[procurement] valuation:', e && e.message); vlRows = [];
    } finally { vlLoading = false; }
}

async function saveCostingMethod(m) {
    vlMethod = m;
    try {
        const cid = currentClinicId();
        await supabase.from('companies').update({ costing_method: m }).eq('id', cid);
        if (window.CLINIC) window.CLINIC.costing_method = m;
        toast(prL('vlSaved'), 'ok');
    } catch (e) { console.warn('[procurement] costing method:', e && e.message); }
    paintValuation();
}

function paintValuation() {
    const wrap = vlWrap; if (!wrap) return;
    clear(wrap);

    const methodBtn = (key, label) => h('button', {
        class: 'btn btn-sm ' + (vlMethod === key ? 'btn-primary' : 'btn-outline'),
        type: 'button', onclick: () => { if (vlMethod !== key) saveCostingMethod(key); },
    }, label);

    wrap.appendChild(h('div', { class: 'card-header' },
        h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            h('h3', null, Icon('Chart', { size: 16 }), prL('vlHdr')),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, prL('vlSub'))),
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, prL('vlMethod') + ':'),
            methodBtn('wac', prL('vlWac')), methodBtn('fifo', prL('vlFifo')))));

    if (state.costOk === false || vlMig) {
        wrap.appendChild(h('div', { class: 'empty', style: { padding: '22px', color: 'var(--warn-700, #b45309)' } }, prL('vlNeedMig')));
        return;
    }
    if (vlLoading) {
        wrap.appendChild(h('div', { class: 'muted', style: { padding: '20px', fontSize: '12.5px' } }, 'Loading…'));
        return;
    }

    const fifo = vlMethod === 'fifo';
    const total = vlRows.reduce((a, r) => a + (fifo ? (r.fifoVal || 0) : (r.wacVal || 0)), 0);

    const tbody = h('tbody', null,
        ...(vlRows.length ? vlRows.map(r => {
            const cost = fifo ? r.fifoCost : r.wac;
            const val  = fifo ? r.fifoVal : r.wacVal;
            return h('tr', null,
                h('td', { style: { whiteSpace: 'normal', overflowWrap: 'anywhere' } },
                    h('div', { class: 'cell-strong' }, r.item.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                        [r.item.strength, r.item.form, baseUnitOf(r.item)].filter(Boolean).join(' · '))),
                h('td', { class: 'num' }, fmtNum(r.qty)),
                h('td', { class: 'num muted' }, cost == null
                    ? h('span', { style: { color: 'var(--warn-700, #b45309)' } }, prL('vlNoCost'))
                    : fmtNum(Math.round(cost))),
                h('td', { class: 'num cell-strong' }, val == null ? '—' : fmtNum(Math.round(val))));
        }) : [emptyRow(4, prL('vlEmpty'))]));

    const foot = h('tfoot', null, h('tr', { style: { borderTop: '2px solid var(--ink-200)', fontWeight: 700 } },
        h('td', { colspan: 3, style: { textAlign: 'right' } }, prL('vlTotal') + ':'),
        h('td', { class: 'num' }, fmtNum(Math.round(total)) + ' UZS')));

    wrap.appendChild(h('table', { class: 'tbl' },
        h('thead', null, h('tr', null,
            h('th', null, prL('vlProduct')),
            h('th', { class: 'num' }, prL('vlQty')),
            h('th', { class: 'num' }, prL('vlCost')),
            h('th', { class: 'num' }, prL('vlValue')))),
        tbody, foot));
}

// ============================================================================
// REQUISITIONS_V1 (migration 124) — «Заявки»: request → approval → convert.
// All transitions go through SECURITY DEFINER RPCs; the buttons below are
// convenience gates, the RPCs are the real authority.
// ============================================================================
let reqRows = [];
let reqLoading = false;
let reqMig = false;
let reqWrap = null;
let reqBadgeEl = null;   // REQ_BADGE_V1 — count pill on the «Заявки» tab

// REQ_BADGE_V1 — «unclosed» = a requisition still in flight (awaiting approval or
// awaiting conversion to a PO). converted / rejected / cancelled are terminal.
function reqUnclosedCount() {
    return (reqRows || []).filter(r => r.status === 'submitted').length;   // REQ_APPROVE_TERMINAL_V1 — approved = issued/done, only awaiting-approval counts
}
function updateReqBadge() {
    if (!reqBadgeEl) return;
    const n = reqUnclosedCount();
    reqBadgeEl.textContent = n > 99 ? '99+' : String(n);
    reqBadgeEl.style.display = n > 0 ? 'inline-flex' : 'none';
}

function isAdminUser() {
    const u = (typeof currentUser === 'function' && currentUser()) || {};
    return u.is_admin === true || u.is_super_admin === true;
}

function reqStatusPill(status) {
    const map = {
        submitted: ['warn',  'rqSt_submitted'],
        approved:  ['info',  'rqSt_approved'],
        rejected:  ['crit',  'rqSt_rejected'],
        converted: ['ok',    'rqSt_converted'],
        cancelled: ['muted', 'rqSt_cancelled'],
    };
    const [kind, key] = map[status] || ['muted', 'rqSt_submitted'];
    const bg = { warn: 'var(--warn-50, #fffbeb)', info: 'var(--primary-50)', crit: 'var(--crit-50)', ok: 'var(--ok-50)', muted: 'var(--ink-50)' }[kind];
    const fg = { warn: 'var(--warn-700, #b45309)', info: 'var(--primary-700)', crit: 'var(--crit-700)', ok: 'var(--ok-700)', muted: 'var(--ink-500)' }[kind];
    return h('span', { style: { display: 'inline-flex', padding: '1px 9px', borderRadius: '999px',
        background: bg, color: fg, fontSize: '12.5px', fontWeight: 700 } }, prL(key));
}

// PROC_FILTERS_V1 — per-tab filter state + a compact filter-bar builder.
let prodFilter = { q: '', cat: 'all', sup: 'all', status: 'all' };
let poFilter   = { q: '', sup: 'all', status: 'all', branch: 'all' };
let reqFilter  = { q: '', status: 'all', dept: 'all' };
let supFilter  = { q: '', status: 'all' };

// PROC_FILTER_ROW_V1 — filters live in a second <thead> row, each control under
// its own column (replaces the old floating filter bar that sat against the
// card separator). Search keeps focus across the repaint it triggers.
let _pfFocusKey = null;
function procFilterCtrl(d, onChange) {
    if (d.type === 'search') {
        const inp = h('input', { type: 'search', value: d.get() || '', placeholder: d.placeholder || '',
            style: { height: '30px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: '8px',
                     font: 'inherit', fontSize: '12.5px', width: '100%', minWidth: '110px', boxSizing: 'border-box' } });
        inp.addEventListener('input', () => { clearTimeout(inp._t); inp._t = setTimeout(() => { d.set(inp.value); _pfFocusKey = d.key || null; onChange(); }, 200); });
        if (d.key && _pfFocusKey === d.key) setTimeout(() => { inp.focus(); const n = inp.value.length; try { inp.setSelectionRange(n, n); } catch (_) {} _pfFocusKey = null; }, 0);
        return inp;
    }
    const sel = h('select', {
        style: { height: '30px', padding: '0 6px', border: '1px solid var(--ink-200)', borderRadius: '8px',
                 font: 'inherit', fontSize: '12.5px', background: 'white', width: '100%', minWidth: '110px', boxSizing: 'border-box' } },
        ...d.options.map(o => h('option', { value: o.value, selected: String(o.value) === String(d.get()) }, o.label)));
    sel.addEventListener('change', () => { d.set(sel.value); onChange(); });
    return sel;
}
function procFilterRow(cells, onChange) {
    return h('tr', null, ...cells.map(c => h('th', { style: { padding: '4px 8px 10px', fontWeight: '400' } },
        c ? procFilterCtrl(c, onChange) : null)));
}

function prRequisitions() {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });
    reqWrap = wrap;
    const tableWrap = h('div');
    wrap.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
                h('h3', null, Icon('Doc', { size: 16 }), prL('rqHdr')),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, prL('rqSub'))),
            h('button', { class: 'btn btn-primary btn-sm', onclick: openNewRequisitionModal }, Icon('Plus', { size: 14 }), prL('rqNew'))),
        tableWrap));
    reqWrap._table = tableWrap;
    paintRequisitions();
    loadRequisitions().then(paintRequisitions);
    return wrap;
}

async function loadRequisitions() {
    const cid = currentClinicId();
    if (!cid) return;
    reqLoading = true; reqMig = false;
    try {
        let q = supabase.from('purchase_requisitions')
            .select('id, req_number, status, notes, reject_reason, branch_id, department, requested_by, converted_po_id, created_at, purchase_requisition_items(id)')
            .eq('company_id', cid);
        // PROCUREMENT_REQ_GRANT_V1 — a request-only user sees only their own requests.
        if (state.reqOnly) q = q.eq('requested_by', currentUserId());
        const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
        if (error) { reqMig = true; reqRows = []; return; }
        reqRows = data || [];
    } catch (e) {
        console.warn('[procurement] requisitions:', e && e.message); reqRows = [];
    } finally { reqLoading = false; updateReqBadge(); }
}

async function reqDo(fn, args, okKey, extra) {
    try {
        const { data, error } = await supabase.rpc(fn, args);
        if (error) throw error;
        toast(prL(okKey) + (extra ? extra(data) : ''), 'ok');
        await loadRequisitions();
        paintRequisitions();
    } catch (e) { toast(e.message || String(e), 'fail'); }
}

function paintRequisitions() {
    const wrap = reqWrap; if (!wrap) return;
    const tableWrap = wrap._table; if (!tableWrap) return;
    clear(tableWrap);

    if (reqMig) {
        tableWrap.appendChild(h('div', { class: 'empty', style: { padding: '22px', color: 'var(--warn-700, #b45309)' } }, prL('rqNeedMig')));
        return;
    }
    if (reqLoading) {
        tableWrap.appendChild(h('div', { class: 'muted', style: { padding: '20px', fontSize: '12.5px' } }, 'Loading…'));
        return;
    }

    const admin = isAdminUser();
    const meId = currentUserId();

    const rowActions = (r) => {
        const btns = [];
        const mkBtn = (labelKey, cls, onclick) => h('button', {
            class: 'btn btn-sm ' + cls, style: { height: '26px', padding: '0 9px', fontSize: '12.5px' },
            type: 'button', onclick }, prL(labelKey));
        if (r.status === 'submitted') {
            if (admin || canProcurementFull()) {   // REQ_APPROVE_ACCESS_V1 — procurement-role users can approve/reject
                btns.push(mkBtn('rqApprove', 'btn-primary', () => openApproveRequisitionModal(r)));   // REQ_APPROVE_ISSUE_V1
                btns.push(mkBtn('rqReject', 'btn-outline', () => {
                    const reason = window.prompt(prL('rqRejectReason'));
                    if (reason === null) return;
                    if (!reason.trim()) { toast('Укажите причину отклонения — она видна заявителю.', 'fail'); return; }   // REQ_APPROVE_ACCESS_V1
                    reqDo('reject_requisition', { p_id: r.id, p_reason: reason.trim() }, 'rqRejected');
                }));
            }
            if (admin || r.requested_by === meId)
                btns.push(mkBtn('rqCancel', 'btn-ghost', () => reqDo('cancel_requisition', { p_id: r.id }, 'rqCancelled')));
        } else if (r.status === 'approved') {
            // REQ_APPROVE_TERMINAL_V1 — approval already wrote the goods off the
            // warehouse into the department (approve_requisition_and_issue), so the
            // requisition is complete. No «В заказ» step; show the outcome instead.
            return h('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end', alignItems: 'center' } },
                h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--ok-700)', fontSize: '12.5px', fontWeight: 700 } },
                    Icon('Check', { size: 13 }), prL('rqIssued')));
        }
        return btns.length ? h('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' } }, ...btns) : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '—');
    };

    const rq = (reqFilter.q || '').trim().toLowerCase();   // PROC_FILTERS_V1
    const rRows = reqRows.filter(r => {
        if (rq && !((r.req_number || '').toLowerCase().includes(rq))) return false;
        if (reqFilter.status !== 'all' && r.status !== reqFilter.status) return false;
        if (reqFilter.dept !== 'all' && (r.department || '') !== reqFilter.dept) return false;
        return true;
    });
    const tbody = h('tbody', null,
        ...(rRows.length ? rRows.map(r => h('tr', null,
            h('td', { class: 'cell-mono cell-strong', style: { fontSize: '12.5px' } }, r.req_number || r.id.slice(0, 8)),
            h('td', null, reqStatusPill(r.status),
                r.status === 'rejected' && r.reject_reason
                    ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, r.reject_reason) : null),
            h('td', null, reqDeptLabelText(r.department)),
            h('td', { class: 'num' }, String((r.purchase_requisition_items || []).length)),
            h('td', { class: 'muted num', style: { fontSize: '12.5px' } }, fmtDate(r.created_at)),
            h('td', null, rowActions(r)),
        )) : [emptyRow(6, prL('rqEmpty'))]));

    tableWrap.appendChild(h('table', { class: 'tbl' },
        h('thead', null,
            h('tr', null,
                h('th', null, prL('rqNum')), h('th', null, prL('rqStatus')),
                h('th', null, 'Отдел'),
                h('th', { class: 'num' }, prL('rqLines')), h('th', null, prL('rqCreated')),
                h('th', { style: { width: '210px' } }, prL('rqActions'))),
            procFilterRow([   // PROC_FILTER_ROW_V1 — each filter under its column
                { type: 'search', key: 'rq.q', get: () => reqFilter.q, set: (v) => { reqFilter.q = v; }, placeholder: prL('fltSearch') },
                { options: [{ value: 'all', label: prL('fltAllStatus') }, ...['submitted', 'approved', 'rejected', 'converted', 'cancelled'].map(k => ({ value: k, label: prL('rqSt_' + k) }))], get: () => reqFilter.status, set: (v) => { reqFilter.status = v; } },
                { options: [{ value: 'all', label: prL('fltAllDepts') }, ...BULK_DEPTS.map(d => ({ value: d.key, label: prL(d.labelKey) }))], get: () => reqFilter.dept, set: (v) => { reqFilter.dept = v; } },
                null, null, null,
            ], paintRequisitions)),
        tbody));
}

// REQ_DEPT_V1 — text label for a requisition's target department.
function reqDeptLabelText(key) {
    if (!key) return '—';
    const d = BULK_DEPTS.find(x => x.key === key);
    return d ? prL(d.labelKey) : key;
}

// REQ_APPROVE_ISSUE_V1 — approve a requisition: show details, then on confirm issue
// the items from the branch warehouse to the requested department (stock_movements
// kind='issue' — same safe path «Выдать» uses), mark approved, and print a signable slip.
async function openApproveRequisitionModal(r) {
    let items = [], onHand = {}, reqName = '';
    try {
        const { data: its } = await supabase.from('purchase_requisition_items')
            .select('id, item_id, qty, note, clinic_items(id, name, base_unit)')
            .eq('req_id', r.id);
        items = its || [];
        const itemIds = items.map(x => x.item_id).filter(Boolean);
        if (itemIds.length && r.branch_id) {
            // REQ_ONHAND_WAREHOUSE_V1 — «На складе» must reflect the WAREHOUSE pool only
            // (what the RPC actually deducts). Without the location filter this summed
            // warehouse + every department pool, so the figure and the red short-flag
            // could hide a real warehouse shortage (or fake one). Mirrors STOCK_WAREHOUSE_ONLY_V1.
            const whl = (typeof warehouseLoc === 'function') ? warehouseLoc(r.branch_id) : null;
            let sq = supabase.from('item_stock').select('item_id, qty_on_hand, location_id').eq('branch_id', r.branch_id).in('item_id', itemIds);
            if (whl && whl.id) sq = sq.or('location_id.eq.' + whl.id + ',location_id.is.null');
            const { data: stk } = await sq;
            (stk || []).forEach(s => { onHand[s.item_id] = (onHand[s.item_id] || 0) + Number(s.qty_on_hand || 0); });
        }
        if (r.requested_by) {
            const { data: u } = await supabase.from('users').select('full_name').eq('id', r.requested_by).single();
            reqName = (u && u.full_name) || '';
        }
    } catch (e) { console.warn('[requisition approve] load:', e && e.message); }

    if (!items.length) { toast('В заявке нет позиций.', 'fail'); return; }
    const deptLbl = reqDeptLabelText(r.department);

    const itemsTable = h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Товар'), h('th', { class: 'num' }, 'Запрошено'), h('th', { class: 'num' }, 'На складе'))),
        h('tbody', null, ...items.map(it => {
            const nm = (it.clinic_items && it.clinic_items.name) || '—';
            const req = Number(it.qty || 0);
            const oh = onHand[it.item_id];
            const short = oh != null && oh < req;
            return h('tr', null,
                h('td', null, nm),
                h('td', { class: 'num cell-strong' }, String(req)),
                h('td', { class: 'num', style: short ? { color: 'var(--crit-700)', fontWeight: '700' } : {} }, oh == null ? '—' : String(oh)));
        })));

    openModal({
        title: trf('Согласование заявки {num}', { num: r.req_number || '' }),
        subtitle: trf('Отдел: {dept}', { dept: deptLbl }) + (reqName ? ' · ' + trf('Заявитель: {name}', { name: reqName }) : ''),
        width: '560px',
        body: h('div', { class: 'modal-body' },
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } },
                trf('При согласовании товары списываются со склада в отдел «{dept}» и печатается требование-накладная для подписи заявителем.', { dept: deptLbl })),
            itemsTable),
        footerButtons: (close) => [
            h('button', { class: 'btn btn-primary', type: 'button', onclick: async (e) => {
                e.target.disabled = true;
                try {
                    const issuer = (typeof currentUser === 'function' && currentUser()) || {};
                    // REQ_ISSUE_RPC_V1 — approve + issue to the department atomically,
                    // server-side. A direct stock_movements insert here failed the table's
                    // write RLS (company_id only, no super-admin bypass — mig 127); the
                    // SECURITY DEFINER RPC (mig 128) is the sanctioned path the mig 124
                    // header mandates, and it resolves the warehouse→department transfer.
                    const { error: apErr } = await supabase.rpc('approve_requisition_and_issue', { p_id: r.id });
                    if (apErr) throw apErr;
                    toast(prL('rqApproved'), 'ok');
                    close();
                    try {
                        openBulkIssueSlip({
                            lines: items.map(it => ({ item: { name: (it.clinic_items && it.clinic_items.name) || '—', unit: (it.clinic_items && it.clinic_items.base_unit) || '—' }, qty: Number(it.qty || 0) })),
                            branch: (state.branches.find(b => String(b.id) === String(r.branch_id)) || {}),
                            recipient: { full_name: reqName || '—' },
                            issuer, dept: deptLbl, note: r.notes || '',
                        });
                    } catch (se) { console.warn('[requisition slip]', se && se.message); }
                    await loadRequisitions();
                    paintRequisitions();
                    try { await loadStock(); paintStockTable(); } catch (pe) {}
                } catch (err) { toast(err.message || String(err), 'fail'); e.target.disabled = false; }
            } }, Icon('Check', { size: 14 }), ' Согласовать'),
        ],
    });
}

function openNewRequisitionModal() {
    const inpStyle = {
        height: '34px', padding: '0 10px', border: '1px solid #d1d5db', borderRadius: '8px',
        fontSize: '13.5px', background: 'white', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', width: '100%',
    };
    const lines = [];   // { item, qty, note }
    const linesWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    const branchSel = state.branches.length
        ? selectEl(state.branches.map(b => ({ id: b.id, label: b.name })),
            { value: state.stockBranch !== 'all' ? state.stockBranch : (state.branches[0] && state.branches[0].id) || '', style: { width: '100%' } })
        : null;

    function paintLines() {
        clear(linesWrap);
        if (!lines.length) { linesWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '10px 2px' } }, prL('rqLineHint'))); return; }
        lines.forEach((ln, idx) => {
            const qtyIn = h('input', { type: 'number', min: '0.0001', step: 'any', value: String(ln.qty ?? ''),
                placeholder: prL('rqQtyPh'), style: { ...inpStyle, width: '96px', textAlign: 'right' } });
            // REQ_UNIT_V1 — request in шт or уп; the hint shows what will actually
            // be issued (base units), so «1 уп = 10 шт» is visible before saving.
            const rqConv = h('div', { class: 'muted', style: { fontSize: '12.5px' } });
            const paintRqConv = () => {
                const f = unitFactor(ln.item, ln.unit);
                rqConv.textContent = f === 1 ? ''
                    : fmtNum(Number(ln.qty) || 0) + ' ' + ln.unit + ' ' + prL('unConverted') + ' '
                      + fmtNum(toBaseQty(ln.item, ln.qty, ln.unit)) + ' ' + baseUnitOf(ln.item);
            };
            const rqUnitSel = unitSelectFor(ln.item, () => ln.unit, (v) => { ln.unit = v; paintRqConv(); });
            qtyIn.addEventListener('input', () => { ln.qty = Number(qtyIn.value); paintRqConv(); });
            paintRqConv();
            const noteIn = h('input', { type: 'text', value: ln.note || '', placeholder: prL('note'), style: { ...inpStyle, width: '180px' } });
            noteIn.addEventListener('input', () => { ln.note = noteIn.value; });
            linesWrap.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
                border: '1px solid var(--ink-100)', borderRadius: '10px', background: 'var(--white)' } },
                h('div', { style: { minWidth: 0, flex: 1 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '13.5px', whiteSpace: 'normal', overflowWrap: 'anywhere' } }, ln.item.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, [ln.item.strength, baseUnitOf(ln.item)].filter(Boolean).join(' · ') || '—'),
                    rqConv),
                qtyIn, rqUnitSel, noteIn,
                h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: prL('biRemove'),
                    onclick: () => { lines.splice(idx, 1); paintLines(); } }, '×')));
        });
    }
    function addLine(item) {
        if (!item || lines.some(l => String(l.item.id) === String(item.id))) return;
        // REQ_UNIT_V1 — packed items default to the PURCHASE unit: a department
        // asking «1» of a packed product means 1 pack; save converts to base units.
        lines.push({ item, qty: 1, unit: (numOr1(item.pack_factor) !== 1 && item.purchase_unit) ? item.purchase_unit : baseUnitOf(item), note: '' }); paintLines();
    }

    // product search
    const prodWrap = h('div', { style: { position: 'relative', flex: 1 } });
    const prodInp = h('input', { type: 'text', placeholder: prL('rcProdSearch'), style: inpStyle });
    const prodSuggest = h('div', { style: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
        background: 'white', border: '1px solid var(--ink-200)', borderRadius: '10px',
        boxShadow: '0 10px 30px rgba(15,23,42,0.14)', maxHeight: '220px', overflow: 'auto', display: 'none' } });
    prodWrap.appendChild(prodInp); prodWrap.appendChild(prodSuggest);
    function paintSug() {
        const q = prodInp.value.trim().toLowerCase();
        clear(prodSuggest);
        if (!q) { prodSuggest.style.display = 'none'; return; }
        const hits = state.items.filter(i => itemLabel(i).toLowerCase().includes(q))
            .filter(i => !lines.some(l => String(l.item.id) === String(i.id))).slice(0, 8);
        if (!hits.length) prodSuggest.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } }, prL('biNothing')));
        else for (const it of hits) prodSuggest.appendChild(h('button', { type: 'button',
            style: { display: 'block', width: '100%', padding: '9px 12px', border: 'none', background: 'transparent',
                cursor: 'pointer', fontSize: '13.5px', color: 'var(--ink-800)', fontFamily: 'inherit', textAlign: 'left', whiteSpace: 'normal', overflowWrap: 'anywhere' },
            onmousedown: (e) => e.preventDefault(),
            onclick: () => { addLine(it); prodInp.value = ''; prodSuggest.style.display = 'none'; prodInp.focus(); } }, itemLabel(it)));
        prodSuggest.style.display = 'block';
    }
    prodInp.addEventListener('input', paintSug);
    prodInp.addEventListener('focus', paintSug);
    prodInp.addEventListener('blur', () => setTimeout(() => { prodSuggest.style.display = 'none'; }, 150));

    const deptReqSel = h('select', { style: inpStyle },   // REQ_DEPT_V1
        h('option', { value: '', selected: true }, 'Выберите отдел…'),
        ...BULK_DEPTS.map(d => h('option', { value: d.key }, prL(d.labelKey))));
    const noteInput = h('input', { type: 'text', placeholder: prL('rcNotePh'), style: inpStyle });
    paintLines();

    const body = h('form', { class: 'modal-body' },
        h('div', { class: 'field' }, h('label', null, 'Отдел (кто запрашивает) *'), deptReqSel),   // REQ_DEPT_V1
        // REQ_NO_BRANCH_V1 — «Филиал (склад)» field removed per owner; branchSel stays
        // defined (default branch) so the requisition still carries a branch_id.
        h('div', { class: 'field' }, h('label', null, prL('rcItems')), linesWrap),
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, prodWrap),
        h('div', { class: 'field' }, h('label', null, prL('note')), noteInput));

    openModal({
        title: prL('rqCreateTitle'), subtitle: prL('rqCreateSub'), width: '720px', body,
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, prL('cancel')),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: async (e) => {
                const valid = lines.filter(l => Number(l.qty) > 0);
                if (!valid.length) { toast(prL('rqErrLines'), 'fail'); return; }
                if (!deptReqSel.value) { toast('Выберите отдел, для которого запрашиваются товары.', 'fail'); return; }   // REQ_DEPT_V1
                e.target.disabled = true;
                try {
                    const { data: newId, error } = await supabase.rpc('create_requisition', {
                        p_branch: branchSel ? (branchSel.value || null) : null,
                        p_notes: noteInput.value.trim() || null,
                        p_lines: valid.map(l => ({ item_id: l.item.id, qty: toBaseQty(l.item, l.qty, l.unit), note: l.note || null })),   // REQ_UNIT_V1 — always base units
                        p_department: deptReqSel.value || null,
                    });
                    if (error) throw error;
                    toast(prL('rqOk'), 'ok');
                    close();
                    await loadRequisitions();
                    paintRequisitions();
                } catch (err) { toast(err.message || String(err), 'fail'); }
                finally { e.target.disabled = false; }
            } }, prL('rqNew')),
        ],
    });
    setTimeout(() => prodInp.focus(), 0);
}

// ============================================================================
// STOCK_COUNTS_V1 (migration 125) — «Инвентаризация»: count → variance → post.
//   post_stock_count() reads live on-hand at the location, records counted vs
//   system per line, and writes one reconciling adjustment per line. A count at
//   a department location that has no stock row starts from 0 = opening balance.
// ============================================================================
let cntRows = [];
let cntLoading = false;
let cntMig = false;
let cntWrap = null;

function prCounts() {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });
    cntWrap = wrap;
    const tableWrap = h('div');
    wrap.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
                h('h3', null, Icon('Grid', { size: 16 }), prL('cnHdr')),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, prL('cnSub'))),
            h('button', { class: 'btn btn-primary btn-sm', onclick: openNewCountModal }, Icon('Plus', { size: 14 }), prL('cnNew'))),
        tableWrap));
    wrap._table = tableWrap;
    paintCounts();
    loadCounts().then(paintCounts);
    return wrap;
}

async function loadCounts() {
    const cid = currentClinicId();
    if (!cid) return;
    cntLoading = true; cntMig = false;
    try {
        const { data, error } = await supabase.from('stock_counts')
            .select('id, count_number, location_id, status, note, posted_at, created_at, stock_count_items(variance)')
            .eq('company_id', cid).order('created_at', { ascending: false }).limit(300);
        if (error) { cntMig = true; cntRows = []; return; }
        cntRows = data || [];
    } catch (e) { console.warn('[procurement] counts:', e && e.message); cntRows = []; }
    finally { cntLoading = false; }
}

function locName(id) {
    const l = (state.locations || []).find(x => String(x.id) === String(id));
    return l ? l.name : '—';
}

function paintCounts() {
    const wrap = cntWrap; if (!wrap) return;
    const tableWrap = wrap._table; if (!tableWrap) return;
    clear(tableWrap);
    if (cntMig) { tableWrap.appendChild(h('div', { class: 'empty', style: { padding: '22px', color: 'var(--warn-700, #b45309)' } }, prL('cnNeedMig'))); return; }
    if (cntLoading) { tableWrap.appendChild(h('div', { class: 'muted', style: { padding: '20px', fontSize: '12.5px' } }, 'Loading…')); return; }

    const tbody = h('tbody', null,
        ...(cntRows.length ? cntRows.map(c => {
            const items = c.stock_count_items || [];
            const varN = items.filter(i => Number(i.variance) !== 0).length;
            return h('tr', null,
                h('td', { class: 'cell-mono cell-strong', style: { fontSize: '12.5px' } }, c.count_number || c.id.slice(0, 8)),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, locName(c.location_id)),
                h('td', { class: 'num' }, String(items.length)),
                h('td', { class: 'num', style: { color: varN ? 'var(--warn-700, #b45309)' : 'var(--ink-400)', fontWeight: varN ? 700 : 400 } }, String(varN)),
                h('td', { class: 'muted num', style: { fontSize: '12.5px' } }, fmtDate(c.posted_at || c.created_at)));
        }) : [emptyRow(5, prL('cnEmpty'))]));

    tableWrap.appendChild(h('table', { class: 'tbl' },
        h('thead', null, h('tr', null,
            h('th', null, prL('cnNum')), h('th', null, prL('cnLoc')),
            h('th', { class: 'num' }, prL('cnLines')), h('th', { class: 'num' }, prL('cnVar')),
            h('th', null, prL('cnWhen')))),
        tbody));
}

function openNewCountModal() {
    if (!state.branches.length) { toast(prL('biNoBranches'), 'info'); return; }
    const inpStyle = { height: '34px', padding: '0 10px', border: '1px solid #d1d5db', borderRadius: '8px',
        fontSize: '13.5px', background: 'white', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', width: '100%' };

    let branchId = state.stockBranch !== 'all' ? state.stockBranch : (state.branches[0] && state.branches[0].id) || '';
    let onHand = new Map();     // item_id -> system on-hand at chosen location
    const lines = [];           // { item, counted }

    const branchSel = selectEl(state.branches.map(b => ({ id: b.id, label: b.name })), { value: branchId, style: {} });
    const locSel = h('select', { style: inpStyle });
    const linesWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });

    function locOptions() {
        clear(locSel);
        const locs = (state.locations || []).filter(l => String(l.branch_id) === String(branchId));
        // warehouse first, then departments
        locs.sort((a, b) => (a.kind === 'warehouse' ? -1 : 1) - (b.kind === 'warehouse' ? -1 : 1));
        for (const l of locs) locSel.appendChild(h('option', { value: l.id }, l.name + (l.kind === 'warehouse' ? '' : '')));
        if (!locs.length) locSel.appendChild(h('option', { value: '' }, '—'));
    }
    async function refreshOnHand() {
        const cid = currentClinicId();
        onHand = new Map();
        const loc = locSel.value;
        try {
            let q = supabase.from('item_stock').select('item_id, qty_on_hand').eq('company_id', cid);
            if (loc) q = q.eq('location_id', loc);
            const { data } = await q.limit(5000);
            for (const r of (data || [])) onHand.set(String(r.item_id), (onHand.get(String(r.item_id)) || 0) + Number(r.qty_on_hand || 0));
        } catch (_) { /* leave empty → system 0 */ }
        paintLines();
    }
    function sysQty(item) { return onHand.get(String(item.id)) || 0; }

    function paintLines() {
        clear(linesWrap);
        if (!lines.length) { linesWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '10px 2px' } }, prL('cnAddHint'))); return; }
        // header row
        linesWrap.appendChild(h('div', { class: 'row', style: { gap: '10px', padding: '0 10px', fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)' } },
            h('div', { style: { flex: 1 } }, prL('cnSystem').toUpperCase()),
            h('div', { style: { width: '96px', textAlign: 'right' } }, prL('cnSystem')),
            h('div', { style: { width: '96px', textAlign: 'right' } }, prL('cnCounted')),
            h('div', { style: { width: '96px', textAlign: 'right' } }, prL('cnDiff')),
            h('div', { style: { width: '28px' } }, '')));
        lines.forEach((ln, idx) => {
            const sys = sysQty(ln.item);
            const varEl = h('div', { style: { width: '96px', textAlign: 'right', fontWeight: 700 } });
            const countedIn = h('input', { type: 'number', step: 'any', value: ln.counted === '' ? '' : String(ln.counted),
                placeholder: '0', style: { ...inpStyle, width: '96px', textAlign: 'right' } });
            function paintVar() {
                const v = (ln.counted === '' || ln.counted == null) ? 0 : (Number(ln.counted) - sys);
                varEl.textContent = (v > 0 ? '+' : '') + fmtNum(v);
                varEl.style.color = v > 0 ? 'var(--ok-700)' : (v < 0 ? 'var(--crit-700)' : 'var(--ink-400)');
            }
            countedIn.addEventListener('input', () => { ln.counted = countedIn.value === '' ? '' : Number(countedIn.value); paintVar(); });
            paintVar();
            linesWrap.appendChild(h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', padding: '8px 10px',
                border: '1px solid var(--ink-100)', borderRadius: '10px', background: 'var(--white)' } },
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '13.5px', whiteSpace: 'normal', overflowWrap: 'anywhere' } }, ln.item.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, [ln.item.strength, baseUnitOf(ln.item)].filter(Boolean).join(' · '))),
                h('div', { class: 'num muted', style: { width: '96px', textAlign: 'right' } }, fmtNum(sys)),
                countedIn, varEl,
                h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: prL('biRemove'),
                    onclick: () => { lines.splice(idx, 1); paintLines(); } }, '×')));
        });
    }
    function addLine(item) {
        if (!item || lines.some(l => String(l.item.id) === String(item.id))) return;
        lines.push({ item, counted: '' }); paintLines();
    }

    // product search
    const prodWrap = h('div', { style: { position: 'relative', flex: 1 } });
    const prodInp = h('input', { type: 'text', placeholder: prL('rcProdSearch'), style: inpStyle });
    const prodSuggest = h('div', { style: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
        background: 'white', border: '1px solid var(--ink-200)', borderRadius: '10px', boxShadow: '0 10px 30px rgba(15,23,42,0.14)',
        maxHeight: '220px', overflow: 'auto', display: 'none' } });
    prodWrap.appendChild(prodInp); prodWrap.appendChild(prodSuggest);
    function paintSug() {
        const q = prodInp.value.trim().toLowerCase();
        clear(prodSuggest);
        if (!q) { prodSuggest.style.display = 'none'; return; }
        const hits = state.items.filter(i => itemLabel(i).toLowerCase().includes(q))
            .filter(i => !lines.some(l => String(l.item.id) === String(i.id))).slice(0, 8);
        if (!hits.length) prodSuggest.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } }, prL('biNothing')));
        else for (const it of hits) prodSuggest.appendChild(h('button', { type: 'button',
            style: { display: 'block', width: '100%', padding: '9px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
                fontSize: '13.5px', color: 'var(--ink-800)', fontFamily: 'inherit', textAlign: 'left', whiteSpace: 'normal', overflowWrap: 'anywhere' },
            onmousedown: (e) => e.preventDefault(),
            onclick: () => { addLine(it); prodInp.value = ''; prodSuggest.style.display = 'none'; prodInp.focus(); } }, itemLabel(it)));
        prodSuggest.style.display = 'block';
    }
    prodInp.addEventListener('input', paintSug);
    prodInp.addEventListener('focus', paintSug);
    prodInp.addEventListener('blur', () => setTimeout(() => { prodSuggest.style.display = 'none'; }, 150));

    branchSel.addEventListener('change', () => { branchId = branchSel.value; locOptions(); refreshOnHand(); });
    locSel.addEventListener('change', refreshOnHand);
    const noteInput = h('input', { type: 'text', placeholder: prL('rcNotePh'), style: inpStyle });

    locOptions(); paintLines(); refreshOnHand();

    const body = h('form', { class: 'modal-body' },
        h('div', { class: 'row', style: { gap: '10px' } },
            h('div', { class: 'field', style: { flex: 1 } }, h('label', null, prL('cnBranch')), branchSel),
            h('div', { class: 'field', style: { flex: 1 } }, h('label', null, prL('cnPickLoc')), locSel)),
        h('div', { class: 'field' }, h('label', null, prL('cnLines')), linesWrap),
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, prodWrap),
        h('div', { class: 'field' }, h('label', null, prL('note')), noteInput));

    openModal({
        title: prL('cnCreateTitle'), subtitle: prL('cnCreateSub'), width: '760px', body,
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, prL('cancel')),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: async (e) => {
                const valid = lines.filter(l => l.counted !== '' && l.counted != null && Number.isFinite(Number(l.counted)));
                if (!valid.length) { toast(prL('cnErrLines'), 'fail'); return; }
                e.target.disabled = true;
                try {
                    const { error } = await supabase.rpc('post_stock_count', {
                        p_branch: branchId || null,
                        p_location: locSel.value || null,
                        p_note: noteInput.value.trim() || null,
                        p_lines: valid.map(l => ({ item_id: l.item.id, counted_qty: Number(l.counted) })),
                    });
                    if (error) throw error;
                    toast(prL('cnOk'), 'ok');
                    close();
                    await loadCounts(); paintCounts();
                    if (state.tab === 'stock') { await loadStock(); paintStockTable(); }
                } catch (err) { toast(err.message || String(err), 'fail'); }
                finally { e.target.disabled = false; }
            } }, Icon('Check', { size: 14 }), prL('cnPost')),
        ],
    });
    setTimeout(() => prodInp.focus(), 0);
}

// ============================================================================
// STOCK_AUDIT_V1 — «Журнал»: a readable ledger over stock_movements.
// ============================================================================
let audRows = [];
let audLoading = false;
let audWrap = null;
let audQ = '';
let audKind = '';

const AUD_KINDS = ['receipt', 'issue', 'adjustment', 'transfer'];

function prAudit() {
    const wrap = h('div', { class: 'card' });
    audWrap = wrap;
    paintAudit();
    loadAudit().then(paintAudit);
    return wrap;
}

async function loadAudit() {
    const cid = currentClinicId();
    if (!cid) return;
    audLoading = true;
    try {
        const { data, error } = await supabase.from('stock_movements')
            .select('id, item_id, kind, qty, from_location_id, to_location_id, reference_type, note, created_at, users:created_by(full_name)')
            .eq('company_id', cid).order('created_at', { ascending: false }).limit(400);
        if (error) throw error;
        audRows = data || [];
    } catch (e) { console.warn('[procurement] audit:', e && e.message); audRows = []; }
    finally { audLoading = false; }
}

// AUDIT_XLSX_V1 — export the CURRENTLY FILTERED movement log to .xlsx.
// Applies the same search+type filter as the table but WITHOUT the 250-row
// render cap (the loaded window is 400 movements). SheetJS at click-time.
async function exportAuditXlsx() {
    const q = audQ.trim().toLowerCase();
    const rows = audRows.filter(m => {
        if (audKind && m.kind !== audKind) return false;
        if (!q) return true;
        const it = itemById(m.item_id);
        return it && (it.name || '').toLowerCase().includes(q);
    });
    if (!rows.length) { toast('Нет строк для экспорта.', 'fail'); return; }
    const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
    const whereOf = (m) => {
        const fl = m.from_location_id ? locName(m.from_location_id) : null;
        const tl = m.to_location_id ? locName(m.to_location_id) : null;
        if (fl && tl) return fl + ' → ' + tl;
        return tl || fl || '—';
    };
    const header = [prL('auWhen'), prL('auItem'), prL('auKind'), prL('auQty'), prL('auWhere'), prL('auWhy'), prL('auWho')];
    const matrix = [header, ...rows.map(m => {
        const it = itemById(m.item_id);
        return [fmtDate(m.created_at), it?.name || '—', m.kind || '—', Number(m.qty || 0), whereOf(m),
                (m.reference_type || '') + (m.note ? ' · ' + m.note : ''), (m.users && m.users.full_name) || '—'];
    })];
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    ws['!cols'] = [{ wch: 14 }, { wch: 34 }, { wch: 12 }, { wch: 8 }, { wch: 24 }, { wch: 36 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Journal');
    XLSX.writeFile(wb, `stock-journal-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function paintAudit() {
    const wrap = audWrap; if (!wrap) return;
    clear(wrap);

    const search = h('input', { type: 'text', value: audQ, placeholder: prL('auSearch'),
        style: { height: '32px', padding: '0 10px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13.5px', width: '220px' } });
    search.addEventListener('input', () => { audQ = search.value; paintAudit(); setTimeout(() => search.focus(), 0); });
    const kindSel = h('select', { style: { height: '32px', padding: '0 8px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13.5px' } },
        h('option', { value: '' }, prL('auAll')), ...AUD_KINDS.map(k => h('option', { value: k }, k)));
    kindSel.value = audKind;
    kindSel.addEventListener('change', () => { audKind = kindSel.value; paintAudit(); });

    wrap.appendChild(h('div', { class: 'card-header' },
        h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            h('h3', null, Icon('Activity', { size: 16 }), prL('auHdr')),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, prL('auSub'))),
        h('div', { class: 'row', style: { gap: '8px' } },
            h('button', { class: 'btn btn-outline btn-sm', onclick: exportAuditXlsx }, Icon('Download', { size: 14 }), ' Excel'),   // AUDIT_XLSX_V1
            search, kindSel)));

    if (audLoading) { wrap.appendChild(h('div', { class: 'muted', style: { padding: '20px', fontSize: '12.5px' } }, 'Loading…')); return; }

    const q = audQ.trim().toLowerCase();
    const rows = audRows.filter(m => {
        if (audKind && m.kind !== audKind) return false;
        if (!q) return true;
        const it = itemById(m.item_id);
        return it && (it.name || '').toLowerCase().includes(q);
    }).slice(0, 250);

    const kindPill = (k) => {
        const c = { receipt: ['ok', '#059669'], issue: ['crit', '#dc2626'], adjustment: ['warn', '#b45309'], transfer: ['info', '#2563eb'] }[k] || ['muted', '#64748b'];
        return h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: c[1] } }, k || '—');
    };
    const whereOf = (m) => {
        const f = m.from_location_id ? locName(m.from_location_id) : null;
        const t = m.to_location_id ? locName(m.to_location_id) : null;
        if (f && t) return f + ' → ' + t;
        return t || f || '—';
    };

    const tbody = h('tbody', null,
        ...(rows.length ? rows.map(m => {
            const it = itemById(m.item_id);
            const qn = Number(m.qty || 0);
            return h('tr', null,
                h('td', { class: 'muted num', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, fmtDate(m.created_at)),
                h('td', { style: { whiteSpace: 'normal', overflowWrap: 'anywhere' } }, h('span', { class: 'cell-strong' }, it?.name || '—')),
                h('td', null, kindPill(m.kind)),
                h('td', { class: 'num cell-strong', style: { color: qn < 0 ? 'var(--crit-700)' : 'var(--ok-700)' } }, (qn > 0 ? '+' : '') + fmtNum(qn)),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, whereOf(m)),
                h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'normal', overflowWrap: 'anywhere' } },
                    (m.reference_type || '') + (m.note ? ' · ' + m.note : '')),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, (m.users && m.users.full_name) || '—'));
        }) : [emptyRow(7, prL('auEmpty'))]));

    wrap.appendChild(h('table', { class: 'tbl' },
        h('thead', null, h('tr', null,
            h('th', null, prL('auWhen')), h('th', null, prL('auItem')), h('th', null, prL('auKind')),
            h('th', { class: 'num' }, prL('auQty')), h('th', null, prL('auWhere')),
            h('th', null, prL('auWhy')), h('th', null, prL('auWho')))),
        tbody));
}

// ============================================================================
// Mount
// ============================================================================
export function renderProcurement(container) {
    containerRef = container;
    // PROCUREMENT_REQ_GRANT_V1 — someone granted only «Заявки на закупку» (e.g. a
    // nurse) sees ONLY the requisitions tab and lands on it.
    const reqOnly = canProcurementRequisitions() && !canProcurementFull();
    Object.assign(state, { tab: reqOnly ? 'requisitions' : 'stock', reqOnly, stockBranch: 'all', stockQ: '', branches: [], items: [], suppliers: [], itemSuppliers: [], itemSuppliersOk: true });   // STOCK_SEARCH_V1
    for (const k in tabButtons) delete tabButtons[k];

    clear(container);

    const cid = currentClinicId();
    if (!cid) {
        container.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
            PageHead({ title: 'Procurement', subtitle: 'Stock, suppliers, and purchase orders.' }),
            h('div', { class: 'card', style: { padding: '40px', textAlign: 'center' } },
                h('div', { style: { color: 'var(--ink-500)', fontSize: '13.5px' } },
                    Icon('Building', { size: 18 }), ' Open from a clinic subdomain to manage procurement.')),
        ));
        return;
    }

    bodyEl = h('div');
    container.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
        PageHead({
            title: prL('title'),
            subtitle: prL('subtitle'),
            right: [
                // PROCUREMENT_POPUP_VIEWS_V1 — report views open as popups from here
                // (not tabs). Hidden for a request-only user.
                ...(state.reqOnly ? [] : POPUP_BTNS.map(([id, icon, key, c]) =>
                    h('button', { class: 'btn btn-sm', style: { background: c.bg, color: c.fg, border: '1px solid ' + c.bd },
                        onclick: () => openViewPopup(id) },
                        Icon(icon, { size: 14 }), ' ' + prL(key)))),
                h('button', { class: 'btn btn-outline btn-sm', onclick: () => { reloadCommon().then(renderBody); } },
                    Icon('Refresh', { size: 14 }), prL('reload')),
            ],
        }),
        tabBar(),
        bodyEl,
    ));

    // Prime the common lookups (branches, items, suppliers) then render the tab.
    reloadCommon().then(renderBody);

    // REQ_BADGE_V1 — pull requisitions once up-front so the «Заявки» tab shows its
    // unclosed count even when we land on another tab. When «Заявки» is the active
    // tab, prRequisitions loads them itself, so skip the duplicate fetch here.
    if (state.tab !== 'requisitions') loadRequisitions().then(updateReqBadge);
}

// PROC_DASHBOARD_V1 — «Дашборд»: KPI tiles + charts over the last 30 days, with
// the underlying datasets exportable to Excel. Chart chrome/colors follow the
// validated reference palette (series: blue #2a78d6 приход, orange #eb6834
// расход; ink/grid from the chrome table); marks: 2px lines, 20px bars with a
// rounded data-end, hairline solid gridlines, native tooltips on hover targets.
function prDashboard() {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '6px 12px 18px' } },
        h('div', { class: 'muted', style: { padding: '30px', textAlign: 'center', fontSize: '13.5px' } }, 'Загрузка…'));

    const INK = '#0b0b0b', INK2 = '#52514e', MUT = '#898781', GRID = '#e1e0d9', BASE = '#c3c2b7';
    const S1 = '#2a78d6', S2 = '#eb6834', S3 = '#1baf7a';   // categorical slots 1/2/3 (validated set)

    // DASH_PERIOD_V1 — the whole dashboard follows one period: today / week /
    // month presets + a custom from-to range. Movement- and order-based
    // datasets use it; the stock KPIs are current-state by nature.
    let preset = 'month', customFrom = '', customTo = '';
    function dashRange() {
        const until = (preset === 'custom' && customTo) ? new Date(customTo + 'T23:59:59') : new Date();
        let since = new Date(); since.setHours(0, 0, 0, 0);
        if (preset === 'week') since.setDate(since.getDate() - 6);
        else if (preset === 'month') since.setDate(since.getDate() - 29);
        else if (preset === 'custom' && customFrom) since = new Date(customFrom + 'T00:00:00');
        return { since, until };
    }

    loadDash();
    return wrap;

    async function loadDash() {
        clear(wrap);
        wrap.appendChild(h('div', { class: 'muted', style: { padding: '30px', textAlign: 'center', fontSize: '13.5px' } }, 'Загрузка…'));
        const cid = currentClinicId();
        const { since, until } = dashRange();
        let mv = [], st = [], items = [], pos = [];
        try {
            const [mvR, stR, itR, poR] = await Promise.all([
                supabase.from('stock_movements').select('kind, qty, item_id, created_at').eq('company_id', cid).gte('created_at', since.toISOString()).lte('created_at', until.toISOString()).limit(10000),   // DASH_PERIOD_V1
                supabase.from('item_stock').select('item_id, qty_on_hand, reorder_level').eq('company_id', cid).limit(10000),
                supabase.from('clinic_items').select('id, name, avg_cost, price').eq('company_id', cid).limit(5000),
                supabase.from('purchase_orders').select('id, status, total, created_at, purchase_order_items(item_id, qty_ordered, unit_cost, line_total)').eq('company_id', cid).limit(2000),   // PROC_DASHBOARD_V2 / DASH_PERIOD_V1
            ]);
            mv = mvR.data || []; st = stR.data || []; items = itR.data || []; pos = poR.data || [];
        } catch (e) {
            clear(wrap); wrap.appendChild(h('div', { class: 'muted', style: { padding: '30px', textAlign: 'center' } }, 'Не удалось загрузить данные дашборда.'));
            console.warn('[dashboard]', e && e.message); return;
        }
        const itemById = {}; items.forEach(i => { itemById[i.id] = i; });

        // ---- datasets -------------------------------------------------
        const untilDay = new Date(until); untilDay.setHours(0, 0, 0, 0);   // DASH_PERIOD_V1
        const nDays = Math.max(1, Math.round((untilDay.getTime() - since.getTime()) / 86400000) + 1);
        const days = [], dayIdx = {};
        for (let i = 0; i < nDays; i++) {
            const d = new Date(since.getTime() + i * 86400000); const k = d.toISOString().slice(0, 10);
            dayIdx[k] = days.length;
            days.push({ key: k, label: String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0'), rec: 0, iss: 0 });
        }
        const consump = {};
        for (const m of mv) {
            const q = Number(m.qty) || 0; const b = dayIdx[String(m.created_at || '').slice(0, 10)];
            if (q > 0 && m.kind === 'receipt') { if (b != null) days[b].rec += q; }
            else if (q < 0) { if (b != null) days[b].iss += -q; consump[m.item_id] = (consump[m.item_id] || 0) + (-q); }
        }
        const totals = {}, reorders = {};
        for (const r of st) {
            totals[r.item_id] = (totals[r.item_id] || 0) + Number(r.qty_on_hand || 0);
            if (r.reorder_level != null && r.reorder_level !== '')
                reorders[r.item_id] = Math.max(Number(r.reorder_level), reorders[r.item_id] ?? -Infinity);
        }
        let stockValue = 0; const valueRows = [];
        for (const id in totals) {
            const it = itemById[id] || {}; const c = it.avg_cost != null ? Number(it.avg_cost) : (it.price != null ? Number(it.price) : 0);
            const v = totals[id] * c; stockValue += v;
            if (v > 0) valueRows.push({ name: it.name || '—', v: Math.round(v) });
        }
        valueRows.sort((a, b) => b.v - a.v);
        const positions = Object.values(totals).filter(q => q > 0.00001).length;
        let reorderCnt = 0;
        for (const id in totals) { const t = totals[id]; const ro = reorders[id]; if (ro != null ? t <= ro : t < STOCK_DEFAULT_REORDER) reorderCnt++; }
        const consumpRows = Object.entries(consump).map(([id, v]) => ({ name: (itemById[id] && itemById[id].name) || '—', v: Math.round(v * 100) / 100 })).sort((a, b) => b.v - a.v);
        const openPOs = pos.filter(p => ['draft', 'ordered', 'partially_received'].includes(p.status)).length;
        // PROC_DASHBOARD_V2 — value of not-yet-received orders + per-product ordered totals.
        const openPOSum = pos.filter(p => ['draft', 'ordered', 'partially_received'].includes(p.status))
            .reduce((a, p) => a + (Number(p.total) || 0), 0);
        const orderedAgg = {};
        for (const p of pos) {
            if (p.status === 'cancelled') continue;
            // DASH_PERIOD_V1 — only orders created inside the period
            if (p.created_at && (new Date(p.created_at) < since || new Date(p.created_at) > until)) continue;
            for (const li of (p.purchase_order_items || [])) {
                const a = orderedAgg[li.item_id] || (orderedAgg[li.item_id] = { qty: 0, sum: 0 });
                const q = Number(li.qty_ordered || 0);
                a.qty += q;
                a.sum += li.line_total != null ? Number(li.line_total) : q * (Number(li.unit_cost) || 0);
            }
        }
        const orderedRows = Object.entries(orderedAgg)
            .map(([id, a]) => ({ name: (itemById[id] && itemById[id].name) || '—', v: Math.round(a.qty * 100) / 100, sum: Math.round(a.sum) }))
            .sort((x, y) => y.v - x.v);

        // ---- excel export ---------------------------------------------
        async function exportDash() {
            try {
                const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Показатель', 'Значение'],
                    ['Стоимость запасов, сум', Math.round(stockValue)], ['Позиции на складе', positions],
                    ['Требуют дозаказа', reorderCnt], ['Открытые заказы', openPOs]]), 'KPI');
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Дата', 'Приход', 'Расход'],
                    ...days.map(d => [d.key, d.rec, d.iss])]), 'Движения');
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Товар', 'Расход за период'],
                    ...consumpRows.map(r => [r.name, r.v])]), 'Расход по товарам');
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Товар', 'Остаток', 'Себестоимость', 'Стоимость'],
                    ...Object.keys(totals).map(id => { const it = itemById[id] || {}; const c = Number(it.avg_cost ?? it.price ?? 0) || 0;
                        return [it.name || '—', totals[id], c, Math.round(totals[id] * c)]; })]), 'Запасы');
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Товар', 'Заказано, кол-во', 'Заказано, сумма'],
                    ...orderedRows.map(r => [r.name, r.v, r.sum])]), 'Заказанные товары');   // PROC_DASHBOARD_V2
                XLSX.writeFile(wb, 'procurement-dashboard-' + new Date().toISOString().slice(0, 10) + '.xlsx');
            } catch (e) { toast(trf('Экспорт не удался: {msg}', { msg: e.message || e }), 'fail'); }
        }

        // ---- ordered-products popup (PROC_DASHBOARD_V2) ---------------
        async function exportOrdered() {
            try {
                const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Товар', 'Заказано, кол-во', 'Заказано, сумма'],
                    ...orderedRows.map(r => [r.name, r.v, r.sum])]), 'Заказанные товары');
                XLSX.writeFile(wb, 'ordered-products-' + new Date().toISOString().slice(0, 10) + '.xlsx');
            } catch (e) { toast(trf('Экспорт не удался: {msg}', { msg: e.message || e }), 'fail'); }
        }
        function openOrderedListModal() {
            openModal({
                title: 'Заказанные товары',
                subtitle: 'Все товары из заказов на закупку (кроме отменённых), по убыванию количества.',
                width: '720px',
                zIndex: '220',
                body: h('div', { class: 'modal-body' },
                    h('table', { class: 'tbl', style: { width: '100%' } },
                        h('thead', null, h('tr', null,
                            h('th', null, 'Товар'), h('th', { class: 'num' }, 'Кол-во'), h('th', { class: 'num' }, 'Сумма'))),
                        h('tbody', null, ...(orderedRows.length
                            ? orderedRows.map(r => h('tr', null,
                                h('td', { class: 'cell-strong' }, r.name),
                                h('td', { class: 'num' }, fmtNum(r.v)),
                                h('td', { class: 'num' }, fmtNum(r.sum), ' сум')))
                            : [emptyRow(3, 'Заказов пока нет.')])))),
                footerButtons: () => [
                    h('button', { class: 'btn btn-outline', type: 'button', onclick: exportOrdered }, Icon('Download', { size: 14 }), ' Выгрузить в Excel'),
                ],
            });
        }
        function barRows(rows, color, fmt) {
            if (!rows.length) return h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '10px 0' } }, 'Нет данных за период.');
            const max = Math.max(1, ...rows.map(r => r.v));
            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                ...rows.map(r => h('div', { title: r.name + ': ' + fmt(r.v) + (r.sub ? ' · ' + r.sub : ''), style: { display: 'grid', gridTemplateColumns: '170px 1fr', gap: '10px', alignItems: 'center' } },
                    h('div', { style: { minWidth: 0, fontSize: '12.5px', color: INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, r.name),
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
                        h('div', { style: { width: Math.max(1.5, (r.v / max) * 70) + '%', height: '20px', background: color, borderRadius: '0 4px 4px 0', flex: '0 0 auto' } }),
                        h('div', { style: { fontSize: '12.5px', color: INK2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, fmt(r.v) + (r.sub ? ' · ' + r.sub : ''))))));
        }
        // DASH_PERIOD_V1 — roomier padding so text never sits in the corners.
        const card = (title, ...kids) => h('div', { style: { border: '1px solid var(--ink-100)', borderRadius: '14px', background: 'white', padding: '18px 20px', minWidth: 0 } },
            h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: INK, marginBottom: '12px' } }, title), ...kids);
        const tile = (label, value, accent) => h('div', { style: { flex: '1 1 0', minWidth: '160px', padding: '16px 18px', border: '1px solid var(--ink-100)', borderRadius: '14px', background: 'white' } },
            h('div', { style: { fontSize: '12.5px', color: INK2, marginBottom: '6px' } }, label),
            h('div', { style: { fontSize: '24px', fontWeight: 600, color: accent || INK } }, value));

        // ---- paint ----------------------------------------------------
        clear(wrap);
        // DASH_PERIOD_V1 — period presets + custom range drive the dashboard.
        const chip = (key, label) => h('button', {
            class: 'btn btn-sm ' + (preset === key ? 'btn-primary' : 'btn-outline'), type: 'button',
            onclick: () => {
                if (key === 'custom') {
                    preset = 'custom';
                    if (!customFrom) customFrom = since.toISOString().slice(0, 10);
                    if (!customTo) customTo = new Date().toISOString().slice(0, 10);
                } else { preset = key; }
                loadDash();
            },
        }, label);
        const dInp = (get, set) => {
            const i = h('input', { type: 'date', value: get(), style: { height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', font: 'inherit', fontSize: '12.5px' } });
            i.addEventListener('change', () => set(i.value));
            return i;
        };
        wrap.appendChild(h('div', { class: 'row', style: { alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '4px 2px 0' } },
            chip('today', 'Сегодня'), chip('week', 'Неделя'), chip('month', 'Месяц'), chip('custom', 'Период'),
            ...(preset === 'custom' ? [
                dInp(() => customFrom, (v) => { customFrom = v; }),
                h('span', { class: 'muted' }, '—'),
                dInp(() => customTo, (v) => { customTo = v; }),
                h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => loadDash() }, 'Применить'),
            ] : []),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '6px' } },
                fmtDate(since.toISOString()) + ' — ' + fmtDate(until.toISOString())),
            h('span', { style: { flex: 1 } }),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: exportDash }, Icon('Download', { size: 14 }), ' Excel')));
        wrap.appendChild(h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
            tile('Стоимость запасов', fmtNum(Math.round(stockValue)) + ' ' + tr('сум')),
            tile('Заказано на сумму', fmtNum(Math.round(openPOSum)) + ' ' + tr('сум')),   // PROC_DASHBOARD_V2 — open (not yet received) orders
            tile('Позиции на складе', fmtNum(positions)),
            tile('Требуют дозаказа', fmtNum(reorderCnt), reorderCnt > 0 ? '#d03b3b' : undefined),
            tile('Открытые заказы', fmtNum(openPOs))));
        // PROC_DASHBOARD_V2 — «Приход и расход» line chart removed per owner.
        wrap.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', alignItems: 'start' } },
            card('Топ расхода за период', barRows(consumpRows.slice(0, 8), S1, (v) => fmtNum(v))),
            card('Стоимость запасов — топ товаров', barRows(valueRows.slice(0, 8), S2, (v) => fmtNum(v) + ' ' + tr('сум')))));
        // PROC_DASHBOARD_V2 — most-ordered products + «Смотреть все» popup with Excel.
        wrap.appendChild(h('div', { style: { border: '1px solid var(--ink-100)', borderRadius: '14px', background: 'white', padding: '18px 20px', minWidth: 0 } },
            h('div', { class: 'row', style: { alignItems: 'center', gap: '10px', marginBottom: '12px' } },
                h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: INK } }, 'Заказанные товары — самые заказываемые'),
                h('span', { style: { flex: 1 } }),
                h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: openOrderedListModal }, 'Смотреть все')),
            barRows(orderedRows.slice(0, 8).map(r => ({ ...r, sub: fmtNum(r.sum) + ' ' + tr('сум') })), S3, (v) => fmtNum(v))));
    }
}

// PROCUREMENT_POPUP_VIEWS_V1 — Departments / Expiry / Stock count / Audit log are
// report-style views shown as POPUPS from buttons next to «Обновить», not tabs.
const POPUP_BTNS = [
    ['dash',   'Chart',    'tabDash',   { bg: '#f0fdfa', fg: '#0f766e', bd: '#99f6e4' }],   // teal — PROC_DASHBOARD_V1
    ['depts',  'Bed',      'tabDepts',  { bg: '#eff6ff', fg: '#1d4ed8', bd: '#bfdbfe' }],   // blue
    ['expiry', 'Clock',    'tabExpiry', { bg: '#fffbeb', fg: '#b45309', bd: '#fde68a' }],   // amber
    ['counts', 'Grid',     'tabCount',  { bg: '#ecfdf5', fg: '#047857', bd: '#a7f3d0' }],   // green
    ['audit',  'Activity', 'tabAudit',  { bg: '#f5f3ff', fg: '#6d28d9', bd: '#ddd6fe' }],   // violet
];
function openViewPopup(id) {
    const m = {
        dash:   { fn: prDashboard,   key: 'tabDash',   width: 'calc(100vw - 40px)', height: 'calc(100vh - 40px)' },   // PROC_DASHBOARD_V2
        depts:  { fn: prDepartments, key: 'tabDepts',  width: '900px' },
        expiry: { fn: prExpiry,      key: 'tabExpiry', width: '920px' },
        counts: { fn: prCounts,      key: 'tabCount',  width: '880px' },
        audit:  { fn: prAudit,       key: 'tabAudit',  width: '1000px' },
    }[id];
    if (!m) return;
    openModal({
        title: prL(m.key),
        width: m.width,
        height: m.height || null,   // PROC_DASHBOARD_V2
        zIndex: '150',   // nested dialogs (e.g. «New count») default to 160 → sit above this
        body: h('div', { style: { overflow: 'auto', flex: '1 1 auto', minHeight: 0, padding: '2px 2px 8px' } }, m.fn()),
        footerButtons: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, prL('cancel'))],
    });
}

function tabBar() {
    // PROCUREMENT_TAB_ORDER_V1 — owner-requested order; labels follow the UI language.
    const defs = state.reqOnly
        ? [ ['requisitions', 'Doc', prL('tabReq')] ]   // PROCUREMENT_REQ_GRANT_V1 — request-only view
        : [
        ['stock',     'Layers',   prL('tabStock')],
        ['requisitions', 'Doc',   prL('tabReq')],   // REQUISITIONS_V1 — request precedes the order
        ['pos',       'Receipt',  prL('tabPos')],
        ['products',  'Pill',     prL('tabProducts')],
        ['suppliers', 'Building', prL('tabSuppliers')],
        // PROCUREMENT_POPUP_VIEWS_V1 — Departments / Expiry / Stock count / Audit log
        // are now popup buttons next to «Обновить» (POPUP_BTNS / openViewPopup).
        // VALUATION_TAB_HIDDEN_V1 — «Оценка склада» tab removed per owner (kept the
        // prValuation code + i18n so it can be re-enabled by restoring this line).
    ];
    return h('div', { class: 'tabs', style: { marginTop: '-4px', flexWrap: 'wrap' } },
        ...defs.map(([id, iconName, label]) => {
            const btn = h('button', { class: 'tab' + (state.tab === id ? ' on' : ''), onclick: () => switchTab(id) },
                Icon(iconName, { size: 14 }), ' ' + label);
            if (id === 'requisitions') {
                // REQ_BADGE_V1 — red count pill of unclosed requisitions on the «Заявки» tab.
                reqBadgeEl = h('span', { style: { display: 'none', alignItems: 'center', justifyContent: 'center',
                    marginLeft: '6px', minWidth: '18px', height: '18px', padding: '0 5px', borderRadius: '999px',
                    background: 'var(--crit-600, #dc2626)', color: '#fff', fontSize: '12.5px', fontWeight: '700', lineHeight: '1' } });
                btn.appendChild(reqBadgeEl);
                updateReqBadge();
            }
            tabButtons[id] = btn;
            return btn;
        }),
    );
}

function switchTab(id) {
    if (state.tab === id) return;
    state.tab = id;
    for (const k in tabButtons) tabButtons[k].classList.toggle('on', k === id);
    renderBody();
}

function renderBody() {
    if (!bodyEl) return;
    clear(bodyEl);
    bodyEl.appendChild((TAB_VIEWS[state.tab] || prStock)());
}

// ============================================================================
// DEPT_USAGE_V1 — «Отделения»: per product, how much was issued from the
// warehouse to a department vs how much was actually consumed on patients.
//   received = Σ issued qty   (stock_movements kind='issue', department=X)
//   used     = Σ quantity     (inpatient → admission_services,
//                              outpatient → visit_services; rows with a
//                              clinic_item_id, i.e. products, not services)
//   left     = received − used
// «department» comes from migration 117; movements issued before it (or from
// the old per-row button) carry NULL and are simply not attributed.
// ============================================================================
let dpDept = 'inpatient';     // selected department tab
let dpRows = [];              // [{ item, got, used }]
let dpLoading = false;
let dpMigrationMissing = false;
let dpWrapRef = null;
let dpTableWrap = null;   // DEPT_SEARCH_V1 — only the table repaints while typing
let dpQ = '';             // product-name filter

function prDepartments() {
    const wrap = h('div', { class: 'card' });
    dpWrapRef = wrap;
    paintDepartments();
    loadDeptUsage().then(paintDepartments);
    return wrap;
}

async function loadDeptUsage() {
    const cid = currentClinicId();
    if (!cid) return;
    dpLoading = true;
    dpMigrationMissing = false;
    try {
        // STOCK_LOCATIONS_V1 — the department is a real stock location now, so
        // «Остаток» is an actual balance rather than (issued − used). Received
        // and used are the transfers in and out of that pool.
        let deptLocs = (state.locations || []).filter(l => String(l.code).toLowerCase() === dpDept);
        // DEPT_TAB_SELFHEAL — state.locations can be empty if the shared load
        // hadn't finished (or was reset) when this tab opened; fetch the pools
        // directly before concluding there are none. Every clinic has them
        // (migration 120), so an empty result here is a load glitch, not a
        // missing migration.
        if (!deptLocs.length) {
            const { data, error: locErr } = await supabase.from('stock_locations')
                .select('id, branch_id, code, name, kind').eq('company_id', cid);
            if (locErr) console.warn('[procurement] dept stock_locations read failed:', locErr.message);
            if (data && data.length) {
                state.locations = data;
                deptLocs = data.filter(l => String(l.code).toLowerCase() === dpDept);
            }
        }
        const locIds = deptLocs.map(l => l.id);
        if (!locIds.length) { dpMigrationMissing = true; dpRows = []; return; }
        const inList = '(' + locIds.join(',') + ')';
        const [balRes, movRes] = await Promise.all([
            supabase.from('item_stock').select('item_id, qty_on_hand')
                .eq('company_id', cid).in('location_id', locIds).limit(5000),
            supabase.from('stock_movements').select('item_id, qty, from_location_id, to_location_id')
                .eq('company_id', cid)
                .or('from_location_id.in.' + inList + ',to_location_id.in.' + inList)
                .limit(5000),
        ]);
        // DEPT_TAB_RESILIENT — a failing balance read must NOT blank the tab. Log
        // the real reason and fall back to net movement (received − used) so the
        // department still shows its activity.
        if (balRes.error) console.warn('[procurement] dept item_stock read failed:', balRes.error.message);
        if (movRes.error) console.warn('[procurement] dept movements read failed:', movRes.error.message);
        const balUnavailable = !!balRes.error;
        const locSet = new Set(locIds.map(String));
        const got = new Map(), used = new Map(), bal = new Map();
        for (const b of (balRes.data || [])) {
            bal.set(b.item_id, (bal.get(b.item_id) || 0) + Number(b.qty_on_hand || 0));
        }
        for (const m of (movRes.data || [])) {
            const q = Math.abs(Number(m.qty || 0));
            if (locSet.has(String(m.to_location_id)))   got.set(m.item_id, (got.get(m.item_id) || 0) + q);
            if (locSet.has(String(m.from_location_id))) used.set(m.item_id, (used.get(m.item_id) || 0) + q);
        }
        const ids = new Set([...got.keys(), ...used.keys(), ...bal.keys()]);
        const byId = new Map(state.items.map(i => [String(i.id), i]));
        dpRows = [...ids]
            .map(id => {
                const g = got.get(id) || 0, u = used.get(id) || 0;
                return {
                    item: byId.get(String(id)) || { id, name: '—' },
                    got: g, used: u,
                    bal: balUnavailable ? (g - u) : (bal.get(id) || 0),
                };
            })
            .filter(r => r.got || r.used || r.bal)
            .sort((a, b) => (a.item.name || '').localeCompare(b.item.name || ''));
    } catch (e) {
        console.warn('[procurement] dept usage:', e && e.message);
        dpRows = [];
    } finally {
        dpLoading = false;
    }
}

function dpSearchInput() {
    const inp = h('input', {
        type: 'search', value: dpQ, placeholder: prL('dpSearch'),
        style: {
            height: '32px', padding: '0 10px', border: '1px solid var(--ink-200)',
            borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit',
            outline: 'none', width: '220px',
        },
    });
    inp.addEventListener('input', () => { dpQ = inp.value; paintDeptRows(); });
    return inp;
}

function paintDepartments() {
    const wrap = dpWrapRef;
    if (!wrap) return;
    clear(wrap);

    // MORE_DEPARTMENTS_V2 — department picker is a dropdown (built from BULK_DEPTS,
    // so it always lists every department), with the product search beside it,
    // both on the left. The long description line is dropped for a cleaner header.
    const deptSel = h('select', {
        style: { height: '32px', padding: '0 10px', border: '1px solid var(--ink-200)',
            borderRadius: '8px', fontSize: '13.5px', fontFamily: 'inherit', background: 'white',
            outline: 'none', minWidth: '170px' },
    }, ...BULK_DEPTS.map(d => h('option', { value: d.key }, prL(d.labelKey))));
    deptSel.value = dpDept;
    deptSel.addEventListener('change', async () => {
        dpDept = deptSel.value; paintDepartments(); await loadDeptUsage(); paintDepartments();
    });

    wrap.appendChild(h('div', { class: 'card-header' },
        h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            h('h3', { style: { margin: 0 } }, Icon('Bed', { size: 16 }), prL('dpHdr')),
            deptSel,
            dpSearchInput()),   // DEPT_SEARCH_V1 — search on the left too
    ));

    if (dpMigrationMissing) {
        wrap.appendChild(h('div', { class: 'empty', style: { padding: '22px', color: 'var(--warn-700, #b45309)' } }, prL('dpMigration')));
        return;
    }
    if (dpLoading) {
        wrap.appendChild(h('div', { class: 'muted', style: { padding: '20px', fontSize: '12.5px' } }, 'Loading…'));
        return;
    }

    // DEPT_SEARCH_V1 — typing repaints ONLY the table, so the input keeps focus.
    dpTableWrap = h('div');
    wrap.appendChild(dpTableWrap);
    paintDeptRows();
}

// DEPT_UNIT_BREAKDOWN_V1 — a dept balance is stored in base units; also express it
// in the item's pack (purchase) and dispense (consumption) units so a nurse sees
// e.g. «10» (таблетки) with «1 уп · 10 таб» underneath. Empty when the item has no
// multi-tier units configured (falls back to just the base number).
function deptQtySub(item, baseQty) {
    if (!item || !(Number(baseQty) > 0)) return '';
    const base = String(baseUnitOf(item) || '').toLowerCase();
    const parts = [];
    const pf = numOr1(item.pack_factor);
    if (item.purchase_unit && pf > 1) parts.push(fmtNum(Number(baseQty) / pf) + ' ' + item.purchase_unit);
    const cf = numOr1(item.consumption_factor);
    if (item.consumption_unit && String(item.consumption_unit).toLowerCase() !== base && cf > 0)
        parts.push(fmtNum(Number(baseQty) / cf) + ' ' + item.consumption_unit);
    return parts.join(' · ');
}
function deptQtyCell(item, baseQty, extraClass, color) {
    const sub = deptQtySub(item, baseQty);
    return h('td', { class: 'num ' + (extraClass || ''), style: color ? { color } : {} },
        h('div', null, fmtNum(baseQty)),
        sub ? h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: '400' } }, sub) : null);
}
// DEPT_DISPENSE_QTY_V1 — the balance expressed in the item's dispense unit. With a
// consumption_factor > 1 (e.g. Analgin: 1 base = 10 таб для выдачи) the base balance
// is multiplied out; otherwise the dispense unit equals the base and it's the same
// number. Shown with the dispense unit label.
function deptDispCell(item, baseBal) {
    const cf = numOr1(item && item.consumption_factor);
    const cu = (item && (item.consumption_unit || baseUnitOf(item))) || '';
    const amt = cf > 1 ? Number(baseBal) * cf : Number(baseBal);
    return h('td', { class: 'num cell-strong' }, fmtNum(amt) + (cu ? ' ' + cu : ''));
}
// DEPT_UNIT_COST_V2 — cost of ONE DISPENSING unit = the pack/base cost (avg_cost,
// DB-maintained; else the card price) divided by the dispensing-units-per-base
// (consumption_factor). E.g. a 10 000 UZS pack of 10 таб → 1 000 UZS / таб.
function deptCostCell(item) {
    let c = (item && item.avg_cost != null) ? Number(item.avg_cost)
          : (item && item.price != null)    ? Number(item.price)
          : null;
    if (c != null) {
        const cf = numOr1(item && item.consumption_factor);
        if (cf > 1) c = c / cf;
    }
    return h('td', { class: 'num muted' }, c == null ? '—' : fmtNum(Math.round(c)) + ' UZS');
}

function paintDeptRows() {
    const host = dpTableWrap;
    if (!host) return;
    clear(host);
    const q = (dpQ || '').trim().toLowerCase();
    const shown = !q ? dpRows : dpRows.filter(r =>
        [r.item.name, r.item.strength, r.item.form, r.item.unit]
            .some(v => v && String(v).toLowerCase().includes(q)));

    const tbody = h('tbody', null,
        ...(shown.length
            ? shown.map(r => {
                const left = r.bal;   // STOCK_LOCATIONS_V1 — the real balance
                return h('tr', null,
                    h('td', { style: { whiteSpace: 'normal', overflowWrap: 'anywhere' } },
                        h('div', { class: 'cell-strong' }, r.item.name || '—'),
                        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                            [r.item.strength, r.item.form, r.item.unit].filter(Boolean).join(' · '))),
                    deptQtyCell(r.item, r.got, 'cell-strong'),
                    deptQtyCell(r.item, r.used, ''),
                    deptQtyCell(r.item, left, 'cell-strong', left < 0 ? 'var(--crit-700)' : (left === 0 ? 'var(--ink-400)' : 'var(--ok-700)')),
                    // DEPT_DISPENSE_QTY_V1 — how many dispense units the balance is worth
                    deptDispCell(r.item, left),
                    // DEPT_UNIT_COST_V1 — cost per base unit (WAC; falls back to the set price)
                    deptCostCell(r.item));
            })
            : [emptyRow(6, q ? prL('dpNoHits') : prL('dpEmpty'))]));

    // DEPT_TABLE_FIXED_COLS_V1 — fixed layout so the 5 numeric columns are all the
    // same width (product column a bit wider for the name).
    host.appendChild(h('table', { class: 'tbl', style: { tableLayout: 'fixed', width: '100%' } },
        h('thead', null, h('tr', null,
            h('th', { style: { width: '25%' } }, prL('dpProduct')),
            h('th', { class: 'num', style: { width: '15%' } }, prL('dpGot')),
            h('th', { class: 'num', style: { width: '15%' } }, prL('dpUsed')),
            h('th', { class: 'num', style: { width: '15%' } }, prL('dpBal')),
            h('th', { class: 'num', style: { width: '15%' } }, prL('dpDisp')),   // DEPT_DISPENSE_QTY_V1 — balance in dispense units
            h('th', { class: 'num', style: { width: '15%' } }, prL('dpCost')),   // DEPT_UNIT_COST_V1 — cost per base unit
        )),
        tbody,
    ));
}

// ============================================================================
// UNIT_ENGINE_V1 (migration 119) — three-tier units.
//   base_unit         inventory is ALWAYS held in this; every stock_movements.qty
//                     and item_stock.qty_on_hand is expressed in it
//   purchase_unit     what you buy in      → pack_factor base units per unit
//   consumption_unit  what you dispense in → consumption_factor base units per unit
// Mirrors public.to_base_units() so the client and the database can never
// disagree about what a stored quantity means.
// ============================================================================
// ============================================================================
// STOCK_LOCATIONS_V1 (migration 120) — a balance is (item, branch, location).
// An issue to a department is a TRANSFER: out of the branch warehouse and into
// that department's pool. When migration 120 isn't applied state.locations is
// empty, every lookup returns null, and the writers fall back to the legacy
// signed-qty movement that apply_stock_movement still understands.
// ============================================================================
function warehouseLoc(branchId) {
    return (state.locations || []).find(l =>
        String(l.branch_id) === String(branchId) && l.kind === 'warehouse') || null;
}
function deptLoc(branchId, code) {
    return (state.locations || []).find(l =>
        String(l.branch_id) === String(branchId)
        && String(l.code).toLowerCase() === String(code || '').toLowerCase()) || null;
}

function baseUnitOf(item) {
    return (item && (item.base_unit || item.unit)) || '';
}
function numOr1(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

// Entry units offered for a product: base first, then purchase / consumption when
// they differ AND carry a real factor. Returns [] when there is nothing to choose,
// so dialogs keep their existing single-input layout for the untouched majority.
function unitOptionsFor(item) {
    const out = [{ code: baseUnitOf(item), factor: 1 }];
    const push = (code, factor) => {
        const c = String(code || '').trim();
        if (!c || numOr1(factor) === 1) return;
        if (out.some(o => String(o.code || '').toLowerCase() === c.toLowerCase())) return;
        out.push({ code: c, factor: numOr1(factor) });
    };
    push(item && item.purchase_unit, item && item.pack_factor);
    push(item && item.consumption_unit, item && item.consumption_factor);
    return out.length > 1 ? out : [];
}
function unitFactor(item, code) {
    const hit = unitOptionsFor(item).find(o =>
        String(o.code || '').toLowerCase() === String(code || '').toLowerCase());
    return hit ? hit.factor : 1;
}
function toBaseQty(item, qty, code) {
    const n = Number(qty);
    return Number.isFinite(n) ? n * unitFactor(item, code) : 0;
}

// Build the per-line unit picker. Returns null when the product has no
// conversion declared — the row then renders exactly as it always has.
function unitSelectFor(item, getUnit, onChange) {
    const opts = unitOptionsFor(item);
    if (!opts.length) return null;
    const sel = h('select', {
        style: {
            height: '34px', padding: '0 6px', border: '1px solid #d1d5db', borderRadius: '8px',
            fontSize: '12.5px', background: 'white', fontFamily: 'inherit', width: '84px',
        },
    }, ...opts.map(o => h('option', { value: o.code }, o.code)));
    sel.value = getUnit();
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
}

// UNIT_UI_FIX — the product editor's base/purchase/consumption pickers use a real
// <select> off the whole `units` catalogue. A <datalist> silently filters its
// suggestions by the text already in the box, so a pre-filled "шт" hid every
// other unit — the manager saw only one choice.
function unitCatalogOptions(...include) {
    const seen = new Set(); const opts = [];
    const add = (code, label) => {
        const c = String(code || '').trim();
        if (!c || seen.has(c.toLowerCase())) return;
        seen.add(c.toLowerCase());
        opts.push({ id: c, label: label || c });
    };
    for (const u of (state.units || [])) add(u.code, u.code + (u.name_ru ? ' — ' + u.name_ru : ''));
    for (const v of include) add(v, v);   // keep a product's legacy/custom unit selectable
    return opts;
}
function ensureSelectOption(sel, val) {
    const v = String(val || '').trim();
    if (!v) return;
    if (![...sel.options].some(o => o.value === v)) sel.appendChild(h('option', { value: v }, v));
    sel.value = v;
}

// «№10/уп», «№5/амп», «10м/уп» — packaging currently smuggled into the free-text
// unit string. Parsed ONLY to pre-fill a suggestion a human confirms; never
// applied automatically, because that would silently redefine what existing
// balances mean (is 204 packs or 204 ampoules?).
const PACKISH = ['уп', 'упк', 'упак', 'пач', 'кор', 'box', 'pack'];
function suggestUnitSplit(item) {
    const raw = String((item && item.unit) || '').trim();
    let m = raw.match(/^№\s*(\d+)\s*\/\s*(.+)$/);
    if (m) {
        const factor = Number(m[1]);
        const tok = m[2].trim();
        if (!Number.isFinite(factor) || factor <= 1) return null;
        return PACKISH.includes(tok.toLowerCase())
            ? { base: 'шт', purchase: tok, factor }      // «№10/уп» → 1 уп = 10 шт
            : { base: tok, purchase: 'уп', factor };     // «№10/амп» → 1 уп = 10 амп
    }
    m = raw.match(/^(\d+(?:[.,]\d+)?)\s*([^\s\/]+)\s*\/\s*(.+)$/);
    if (m) {
        const factor = Number(m[1].replace(',', '.'));
        if (!Number.isFinite(factor) || factor <= 1) return null;
        return { base: m[2].trim(), purchase: m[3].trim(), factor };   // «10м/уп»
    }
    return null;
}

// ============================================================================
// Common data loaders (branches / items / suppliers) — clinic-scoped.
// ============================================================================
// UNIT_ENGINE_V1 — kept as a constant so the retry below can drop it wholesale.
const ITEM_COLS_UNITS = 'id, name, code, unit, form, strength, price, active, is_drug, '
    + 'procurement_category, base_unit, purchase_unit, pack_factor, consumption_unit, '
    + 'consumption_factor, units_reviewed';
// PRODUCT_EXPIRY_V1 / COSTING_V1 / BATCH_FEFO_V1 — optional columns from later
// migrations (122 / 123 / 127). The main query requests them; if ANY is missing
// the batch retry below falls back to ITEM_COLS_UNITS, which omits all three, so
// procurement still loads on a clinic that hasn't applied a later migration yet.
// (Regression guard: these MUST NOT live in ITEM_COLS_UNITS, or the retry can't
// drop them and reloadCommon throws — blanking branches/items.)
const ITEM_COLS_FULL = ITEM_COLS_UNITS + ', track_batches, avg_cost, deleted_at';

async function reloadCommon() {
    const cid = currentClinicId();
    if (!cid) return;
    try {
        const [br, it, sup, links, unitsRes, locRes] = await Promise.all([
            supabase.from('branches').select('id, name').eq('company_id', cid).order('name'),
            supabase.from('clinic_items').select(ITEM_COLS_FULL).eq('company_id', cid).order('name'),
            supabase.from('suppliers').select('id, name, contact_name, phone, email, notes, active').eq('company_id', cid).order('name'),
            supabase.from('item_suppliers').select('id, item_id, supplier_id, last_price, pack_factor, purchase_unit').eq('company_id', cid),   // SUPPLIER_PRICE_V1 / SUPPLIER_PACK_V1 / SUPPLIER_UNITS_V1
            // UNIT_ENGINE_V1 — shared catalogue (company_id null) + clinic's own.
            supabase.from('units').select('code, name_ru, name_en, name_uz, kind')
                .or('company_id.is.null,company_id.eq.' + cid).eq('active', true).order('code'),
            // STOCK_LOCATIONS_V1 (migration 120) — warehouse + department pools.
            supabase.from('stock_locations').select('id, branch_id, code, name, kind')
                .eq('company_id', cid).eq('active', true),
        ]);
        if (br.error) throw br.error;
        if (sup.error) throw sup.error;
        // PROCUREMENT_CATEGORIES_V1 — fall back gracefully when migration 063
        // (procurement_category column) isn't applied yet.
        let itemRows = it.data, itemErr = it.error;
        state.categoryOk = !itemErr;
        state.unitsOk = !itemErr;
        state.batchOk = !itemErr;
        state.costOk = !itemErr;
        state.delOk = !itemErr;   // PRODUCT_DELETE_V1
        // BATCH_FEFO_V1 — track_batches (mig 122) missing while unit cols present
        // (a clinic on 119 but not 122): drop only that column, keep unit features.
        if (itemErr && /track_batches|avg_cost|deleted_at/i.test(itemErr.message || '')
            && !/base_unit|pack_factor|consumption_unit|units_reviewed/i.test(itemErr.message || '')) {
            const retryB = await supabase.from('clinic_items').select(ITEM_COLS_UNITS)
                .eq('company_id', cid).order('name');
            itemRows = retryB.data; itemErr = retryB.error;
            state.batchOk = false; state.unitsOk = !itemErr;
            state.costOk = false;
            state.delOk = false;   // PRODUCT_DELETE_V1 — apply migration 136
            console.warn('[procurement] track_batches/avg_cost missing — apply migration 122/123');
        }
        // UNIT_ENGINE_V1 — degrade gracefully when migration 119 isn't applied:
        // drop the unit columns and carry on with the 1:1 legacy behaviour.
        if (itemErr && /base_unit|pack_factor|consumption_unit|units_reviewed/i.test(itemErr.message || '')) {
            const retryU = await supabase.from('clinic_items')
                .select('id, name, code, unit, form, strength, price, active, is_drug, procurement_category')
                .eq('company_id', cid).order('name');
            itemRows = retryU.data; itemErr = retryU.error;
            state.unitsOk = false;
            state.batchOk = false;
            state.categoryOk = !itemErr;
            console.warn('[procurement] unit columns missing — apply migration 119');
        }
        if (itemErr && /procurement_category/i.test(itemErr.message || '')) {
            const retry = await supabase.from('clinic_items')
                .select('id, name, code, unit, form, strength, price, active, is_drug')
                .eq('company_id', cid).order('name');
            itemRows = retry.data; itemErr = retry.error;
            state.categoryOk = false;
            console.warn('[procurement] procurement_category missing — apply migration 063');
        }
        if (itemErr) throw itemErr;
        state.branches  = br.data || [];
        // PRODUCT_DELETE_V1 — deleted products vanish from catalogs/pickers but stay
        // available for history lookups (audit, batches, PO lines) via itemsAll.
        state.itemsAll  = itemRows || [];
        state.items     = (itemRows || []).filter(r => !r.deleted_at);
        // UNIT_ENGINE_V1 — dropdown vocabulary; absence is never fatal.
        state.units     = (unitsRes && !unitsRes.error && unitsRes.data) ? unitsRes.data : [];
        // STOCK_LOCATIONS_V1 — absence just means migration 120 isn't applied yet.
        state.locations = (locRes && !locRes.error && locRes.data) ? locRes.data : [];
        state.suppliers = sup.data || [];
        // item_suppliers is migration 062 — tolerate its absence so the rest
        // of the module keeps working on clinics where it isn't applied yet.
        let linkRows = links.data, linkErr = links.error;
        state.supPackOk = !linkErr;
        // SUPPLIER_PACK_V1 — pack_factor is migration 134; degrade to price-only links
        // (per-supplier pack sizes hidden) instead of losing supplier links entirely.
        if (linkErr && /pack_factor|purchase_unit/i.test(linkErr.message || '')) {
            const retryL = await supabase.from('item_suppliers')
                .select('id, item_id, supplier_id, last_price').eq('company_id', cid);
            linkRows = retryL.data; linkErr = retryL.error;
            state.supPackOk = false;
            console.warn('[procurement] item_suppliers.pack_factor missing — apply migration 134');
        }
        if (linkErr) {
            state.itemSuppliers = [];
            state.itemSuppliersOk = false;
            console.warn('[procurement] item_suppliers unavailable (apply migration 062):', linkErr.message);
        } else {
            state.itemSuppliers = linkRows || [];
            state.itemSuppliersOk = true;
        }
    } catch (err) {
        toast(err.message || String(err), 'fail');
    }
}

// Supplier ids linked to an item / item ids linked to a supplier.
function suppliersOfItem(itemId) {
    return state.itemSuppliers.filter(l => l.item_id === itemId).map(l => l.supplier_id);
}
function itemsOfSupplier(supplierId) {
    return new Set(state.itemSuppliers.filter(l => l.supplier_id === supplierId).map(l => l.item_id));
}

// ============================================================================
// Helpers
// ============================================================================
function fmtNum(n) {
    if (n == null || n === '') return '—';
    const v = Number(n);
    if (!isFinite(v)) return String(n);
    // Thousands separators (space), keep up to 2 decimals without trailing zeros.
    const rounded = Math.round(v * 100) / 100;
    const [intPart, decPart] = String(rounded).split('.');
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return decPart ? grouped + '.' + decPart : grouped;
}
function fmtMoney(n) {
    if (n == null || n === '') return '—';
    return fmtNum(n);
}
function itemLabel(it) {
    if (!it) return '—';
    const extra = [it.strength, it.form].filter(Boolean).join(' · ');
    return it.name + (extra ? ' · ' + extra : '') + (it.unit ? ' (' + it.unit + ')' : '');
}
function itemById(id)   { return state.items.find(x => x.id === id) || (state.itemsAll || []).find(x => x.id === id) || null; }   // PRODUCT_DELETE_V1 — deleted items still resolve for history

// PRODUCT_DELETE_V1 — soft-delete: the product leaves the catalog/search/receive,
// but every stock movement, batch and PO line it appears in stays intact.
function confirmDeleteProduct(p) {
    openModal({
        title: 'Удалить товар?',
        subtitle: p.name || '',
        width: '480px',
        body: h('div', { class: 'modal-body' },
            h('p', { style: { margin: 0, fontSize: '13.5px', lineHeight: 1.5 } },
                'Товар исчезнет из каталога, поиска и приёмки. ',
                h('b', null, 'История закупок сохранится'),
                ' — движения по складу, партии и заказы останутся в отчётах и журнале.')),
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('button', {
                class: 'btn', type: 'button',
                style: { background: 'var(--crit-600, #dc2626)', borderColor: 'var(--crit-600, #dc2626)', color: '#fff' },
                onclick: async (e) => {
                    e.target.disabled = true;
                    try {
                        const { error } = await supabase.from('clinic_items')
                            .update({ deleted_at: new Date().toISOString(), active: false })
                            .eq('id', p.id).eq('company_id', currentClinicId());
                        if (error) throw error;
                        toast('Товар удалён. История закупок сохранена.', 'ok');
                        close();
                        await reloadCommon();
                        renderBody();
                    } catch (err) {
                        toast(err.message || String(err), 'fail');
                        e.target.disabled = false;
                    }
                },
            }, Icon('Trash', { size: 13 }), ' Удалить'),
        ],
    });
}
function branchById(id) { return state.branches.find(x => x.id === id) || null; }
function supplierById(id) { return state.suppliers.find(x => x.id === id) || null; }

// Build a <select> populated from {id,label} options. value preselected.
function selectEl(options, { value = '', placeholder = null, required = false, style = {} } = {}) {
    const inp = { height: '34px', padding: '0 10px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13.5px', background: 'white' };
    const sel = h('select', { style: { ...inp, ...style } });
    if (required) sel.required = true;
    if (placeholder != null) sel.appendChild(h('option', { value: '' }, placeholder));
    for (const o of options) {
        const opt = h('option', { value: String(o.id) }, o.label);
        if (String(o.id) === String(value)) opt.selected = true;
        sel.appendChild(opt);
    }
    return sel;
}

function fieldRow(labelText, control) {
    return h('div', { class: 'field' }, h('label', null, labelText), control);
}

// Generic modal shell (matches openServiceRequestModal). Returns { overlay, close }.
function openModal({ title, subtitle, body, footerButtons, width = null, height = null, zIndex = '160' }) {
    const overlay = h('div', { class: 'modal', style: { zIndex } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    // PROC_MODAL_COMPACT_V1 — every procurement dialog is a normal centred card:
    // `modal-compact` opts out of the global MODAL_FULLSCREEN_V1 rule (which
    // otherwise stretches them to the whole screen with huge dead gaps), and a
    // dialog that doesn't ask for a width gets a sensible default instead of the
    // fullscreen fallback.
    const cardStyle = { width: width || '560px', maxWidth: 'calc(100vw - 24px)', maxHeight: '90vh', display: 'flex', flexDirection: 'column' };
    if (height) { cardStyle.height = height; cardStyle.maxHeight = height; }   // PROC_DASHBOARD_V2 — near-fullscreen popups
    // NO_DOUBLE_CLOSE_V1 — the header × is globally styled as a labelled red
    // «Закрыть» pill, so footers no longer carry their own Close duplicate; a
    // footer left with no buttons is skipped entirely.
    const fb = (footerButtons(close) || []).filter(Boolean);
    const card = h('div', { class: 'modal-card modal-compact', style: cardStyle },
        h('header', { class: 'modal-head' },
            subtitle
                ? h('div', null, h('h2', null, title), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, subtitle))
                : h('h2', null, title),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×'),
        ),
        body,
        fb.length ? h('footer', { class: 'modal-foot' }, ...fb) : null,
    );
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    return { overlay, close };
}

// Empty state inside a card body.
function emptyRow(colspan, text) {
    return h('tr', null, h('td', { colspan: String(colspan), style: { padding: '22px', textAlign: 'center', color: 'var(--ink-500)', fontSize: '12.5px' } }, text));
}

// ============================================================================
// STOCK tab
// ============================================================================
let stockRows = [];   // joined item_stock rows for the current filter
let stockDisplayRows = [];   // SUPPLIER_STOCK_V1 — per-supplier split rows for the table/export
let openPOByItem = new Map();      // STOCK_ORDER_BTN_V1 — item_id -> latest receivable PO
let openPOByItemSup = new Map();   // STOCK_ORDER_BTN_V2 — item_id|supplier_id -> latest receivable PO

// STOCK_XLSX_V1 — export the CURRENTLY VISIBLE stock rows (branch + search filter
// applied) to .xlsx. SheetJS is pulled at click-time like the revenue report.
async function exportStockXlsx() {
    const q = (state.stockQ || '').trim().toLowerCase();
    const rows = !q ? stockDisplayRows : stockDisplayRows.filter(r => {
        const it = r._item || {}; const br = r._branch || {};
        return [it.name, it.strength, it.form, it.unit, br.name, r._supplier && r._supplier.name]
            .some(v => v && String(v).toLowerCase().includes(q));
    });
    if (!rows.length) { toast('Нет строк для экспорта.', 'fail'); return; }
    const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
    const header = ['Товар', 'Дозировка / форма', 'Ед.', 'Филиал', 'Поставщик', 'Остаток', 'Мин. остаток', 'Статус'];
    const matrix = [header, ...rows.map(r => {
        const it = r._item || {}; const br = r._branch || {};
        const onHand = Number(r.qty_on_hand || 0);
        const reorder = (r.reorder_level == null || r.reorder_level === '') ? null : Number(r.reorder_level);
        const low = stockRowLow(r);   // STOCK_FLAG_DEFAULT_V1
        return [it.name || '', [it.strength, it.form].filter(Boolean).join(' · '), it.unit || '',
                br.name || '', (r._supplier && r._supplier.name) || '—', onHand, reorder == null ? '' : reorder, low ? 'Дозаказ' : 'OK'];
    })];
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    ws['!cols'] = [{ wch: 30 }, { wch: 20 }, { wch: 8 }, { wch: 18 }, { wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock');
    XLSX.writeFile(wb, `stock-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
let stockLoading = false;
// STOCK_FILTER_ROW_V1 — per-column filters on the Stock table (PROC_FILTER_ROW_V1 pattern).
const stockFilter = { unit: 'all', sup: 'all', avail: 'all', flag: 'all' };
// STOCK_FLAG_DEFAULT_V1 — with no reorder level set, an item whose TOTAL drops
// below 5 base units flags «Reorder»; an explicit reorder_level overrides (<=).
const STOCK_DEFAULT_REORDER = 5;
function stockRowLow(r) {
    const onHand = Number(r.qty_on_hand || 0);
    const itemTotal = r.item_total != null ? Number(r.item_total) : onHand;
    const reorder = (r.reorder_level == null || r.reorder_level === '') ? null : Number(r.reorder_level);
    return reorder != null ? itemTotal <= reorder : itemTotal < STOCK_DEFAULT_REORDER;
}

function prStock() {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });

    const branchOpts = [{ id: 'all', label: 'All branches' }, ...state.branches.map(b => ({ id: b.id, label: b.name }))];
    const branchSel = selectEl(branchOpts, { value: state.stockBranch, style: { minWidth: '170px' } });
    branchSel.onchange = () => { state.stockBranch = branchSel.value; loadStock().then(paintStockTable); };

    // STOCK_FILTER_ROW_V1 — the old toolbar search moved into the filter row
    // under the Product column (state.stockQ is shared).
    const tableWrap = h('div');

    wrap.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
                h('h3', null, Icon('Layers', { size: 16 }), prL('stockHdr')),
                state.branches.length > 1 ? branchSel : null,   // PROC_NO_BRANCH_V1
            ),
            h('div', { class: 'row', style: { gap: '8px' } },
                h('button', { class: 'btn btn-outline btn-sm', onclick: exportStockXlsx }, Icon('Download', { size: 14 }), ' Excel'),   // STOCK_XLSX_V1
                // STOCK_IMPORT_BTN_V1 — same importer as the Products tab
                // (procurement_items: КОД/Товар/Категория/Остаток/Себестоимость/Цена/ИКПУ),
                // so a warehouse sheet can be loaded straight from the stock screen.
                // «Остаток» rows post opening-stock receipts via the safe stock path.
                h('button', { class: 'btn btn-ghost btn-sm', onclick: () => downloadSectionSample('procurement_items') },
                    Icon('Download', { size: 14 }), prL('sampleFile')),
                h('button', { class: 'btn btn-outline btn-sm',
                    onclick: () => openSectionImporter({
                        sectionKey: 'procurement_items',
                        onImported: async () => { await reloadCommon(); await loadStock(); paintStockTable(); },
                    }),
                }, Icon('ArrowUp', { size: 14 }), prL('importExcel')),
                h('button', { class: 'btn btn-outline btn-sm', onclick: openBulkIssueModal, title: prL('biSub') },
                    Icon('Minus', { size: 14 }), prL('issue')),   // BULK_ISSUE_V1
                h('button', { class: 'btn btn-outline btn-sm', onclick: openAdjustModal }, Icon('Edit', { size: 14 }), prL('adjust')),
                h('button', { class: 'btn btn-primary btn-sm', onclick: openReceiveModal }, Icon('Plus', { size: 14 }), prL('receive')),
            ),
        ),
        tableWrap,
    ));

    // initial load + paint into tableWrap
    paintStockInto(tableWrap);
    loadStock().then(() => paintStockInto(tableWrap));

    return wrap;
}

// Stock tab uses a dedicated re-paint targeting the table region only, so a
// branch-filter change doesn't repaint the whole tab.
let stockTableWrapRef = null;
function paintStockInto(tableWrap) {
    stockTableWrapRef = tableWrap;
    paintStockTable();
}
function paintStockTable() {
    const tableWrap = stockTableWrapRef;
    if (!tableWrap) return;
    clear(tableWrap);

    if (stockLoading) {
        tableWrap.appendChild(h('div', { class: 'muted', style: { padding: '20px', fontSize: '12.5px' } }, 'Loading…'));
        return;
    }

    // STOCK_SEARCH_V1 — filter by product name/strength/form/unit/branch.
    // STOCK_FILTER_ROW_V1 — plus the per-column filters (unit/supplier/avail/flag).
    const q = (state.stockQ || '').trim().toLowerCase();
    const visibleRows = stockDisplayRows.filter(r => {
        const it = r._item || {}; const br = r._branch || {};
        if (q && ![it.name, it.strength, it.form, it.unit, br.name, r._supplier && r._supplier.name]
            .some(v => v && String(v).toLowerCase().includes(q))) return false;
        if (stockFilter.unit !== 'all' && (baseUnitOf(it) || '—') !== stockFilter.unit) return false;
        if (stockFilter.sup !== 'all') {
            if (stockFilter.sup === 'none') { if (r._supplier) return false; }
            else if (String(r.supplier_id || '') !== String(stockFilter.sup)) return false;
        }
        const onHand = Number(r.qty_on_hand || 0);
        if (stockFilter.avail === 'pos' && !(onHand > 0.00001)) return false;
        if (stockFilter.avail === 'zero' && onHand > 0.00001) return false;
        if (stockFilter.flag !== 'all') {
            const low = stockRowLow(r);   // STOCK_FLAG_DEFAULT_V1
            if (stockFilter.flag === 'reorder' ? !low : low) return false;
        }
        return true;
    });

    const tbody = h('tbody', null,
        ...(visibleRows.length
            ? visibleRows.map(r => {
                const it = r._item || {};
                const br = r._branch || {};
                const onHand = Number(r.qty_on_hand || 0);
                const reorder = (r.reorder_level == null || r.reorder_level === '') ? null : Number(r.reorder_level);
                const itemTotal = r.item_total != null ? Number(r.item_total) : onHand;   // SUPPLIER_STOCK_V1
                const low = stockRowLow(r);   // STOCK_FLAG_DEFAULT_V1 — <5 total (or <= explicit reorder level)
                return h('tr', {
                    // STOCK_LOG_V1 — the row opens the movement log for this
                    // item at this branch (who received/adjusted, when, qty).
                    style: { cursor: 'pointer' },
                    title: 'Показать журнал движений',
                    onclick: () => openStockLogModal(it, br),
                    onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #fafafa)'; },
                    onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                },
                    h('td', { class: 'cell-strong' }, it.name || '—',
                        (it.strength || it.form)
                            ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, [it.strength, it.form].filter(Boolean).join(' · '))
                            : null),
                    // UNIT_ENGINE_V1 — on-hand is in the BASE unit; show the pack
                    // equivalent underneath when a conversion is declared.
                    h('td', { class: 'muted' }, baseUnitOf(it) || '—',
                        numOr1(it.pack_factor) !== 1 && it.purchase_unit
                            ? h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                                '1 ' + it.purchase_unit + ' = ' + fmtNum(numOr1(it.pack_factor)) + ' ' + baseUnitOf(it))
                            : null),
                    state.branches.length > 1 ? h('td', { class: 'muted', style: { fontSize: '12.5px' } }, br.name || '—') : null,   // PROC_NO_BRANCH_V1
                    h('td', { class: 'muted', style: { fontSize: '12.5px' } }, (r._supplier && r._supplier.name) || '—'),   // SUPPLIER_STOCK_V1
                    h('td', { class: 'num cell-strong', style: low ? { color: 'var(--crit-700)' } : {} },
                        low ? h('span', { title: 'At or below reorder level', style: { marginRight: '4px' } }, Icon('Warning', { size: 12 })) : null,
                        fmtNum(onHand)),
                    // COSTING_V1 — unit cost and extended value at moving average.
                    h('td', { class: 'num muted' }, it.avg_cost == null ? '—' : fmtNum(it.avg_cost)),
                    h('td', { class: 'num' }, it.avg_cost == null ? '—' : fmtNum(Math.round(onHand * Number(it.avg_cost)))),
                    // STOCK_FLAG_DEFAULT_V1 — coloured pills: OK light green, Reorder light red.
                    h('td', null, h('span', { style: {
                        display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 8px', borderRadius: '999px',
                        background: low ? 'var(--crit-50)' : 'var(--ok-50)',
                        color: low ? 'var(--crit-700)' : 'var(--ok-700)',
                        fontSize: '12.5px', fontWeight: 700,
                    } }, low ? 'Reorder' : 'OK')),
                    h('td', null, (() => {   // STOCK_ORDER_BTN_V1
                        // STOCK_ORDER_BTN_V2 — a supplier-split row only shows «Принять
                        // заказ» for an open PO from THAT supplier; the unattributed «—»
                        // row falls back to any open PO for the item.
                        const openPO = r.supplier_id
                            ? openPOByItemSup.get(String(r.item_id) + '|' + String(r.supplier_id))
                            : openPOByItem.get(String(r.item_id));
                        return h('button', {
                            class: 'btn btn-sm ' + (openPO ? 'btn-primary' : 'btn-outline'),
                            style: { height: '26px', padding: '0 10px', fontSize: '12.5px', whiteSpace: 'nowrap' },
                            type: 'button',
                            title: openPO ? (openPO.po_number || '') : prL('stOrder'),
                            onclick: (e) => {
                                e.stopPropagation();   // the row itself opens the movement log
                                switchTab('pos');
                                if (openPO) setTimeout(() => openPODetail(openPO), 80);
                                else setTimeout(() => openNewPOModal({ item: r._item, supplierId: r.supplier_id || null }), 80);   // PO_PREFILL_V1
                            },
                        }, openPO ? prL('stRecvOrder') : prL('stOrder'));
                    })()),
                    // STOCK_ISSUE_V1 / BULK_ISSUE_ONLY_V1 — the per-row «Выдать» button
                    // is gone: issuing goes through the single «Выдать» action in the
                    // toolbar (several products, one recipient, one requisition slip).
                );
            })
            : [emptyRow(state.branches.length > 1 ? 9 : 8, q ? 'Ничего не найдено.' : 'No stock yet. Use Receive to add inventory.')]),   // STOCK_SEARCH_V1 + COSTING_V1 (cost+value cols)
    );

    // STOCK_FILTER_ROW_V1 — options come from the loaded rows (units/suppliers
    // actually present), so the dropdowns never offer choices that match nothing.
    const unitOpts = [{ value: 'all', label: 'Все ед.' },
        ...[...new Set(stockDisplayRows.map(r => baseUnitOf(r._item || {}) || '—'))].sort().map(u => ({ value: u, label: u }))];
    const supSeen = new Map();
    let anyNoSup = false;
    for (const r of stockDisplayRows) {
        if (r._supplier) supSeen.set(String(r.supplier_id), r._supplier.name || '—');
        else anyNoSup = true;
    }
    const supOpts = [{ value: 'all', label: prL('fltAllSups') },
        ...[...supSeen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([v, l]) => ({ value: v, label: l })),
        ...(anyNoSup ? [{ value: 'none', label: 'Без поставщика' }] : [])];
    const availOpts = [{ value: 'all', label: 'Все' }, { value: 'pos', label: 'В наличии' }, { value: 'zero', label: 'Нулевые' }];
    const flagOpts  = [{ value: 'all', label: 'Все' }, { value: 'ok', label: 'OK' }, { value: 'reorder', label: 'Reorder' }];

    tableWrap.appendChild(h('table', { class: 'tbl' },
        h('thead', null, h('tr', null,
            h('th', null, 'Product'), h('th', null, 'Unit'),
            state.branches.length > 1 ? h('th', null, 'Branch') : null,   // PROC_NO_BRANCH_V1
            h('th', null, prL('vlSupplier')),   // SUPPLIER_STOCK_V1
            h('th', null, 'On hand'),
            h('th', { class: 'num' }, prL('vlCost')), h('th', { class: 'num' }, prL('vlValue')),   // COSTING_V1
            h('th', null, 'Flag'), h('th', { style: { width: '130px' } }, ''),   // STOCK_ORDER_BTN_V1
        ),
        procFilterRow([   // STOCK_FILTER_ROW_V1 — each filter under its column
            { type: 'search', key: 'st.q', get: () => state.stockQ, set: (v) => { state.stockQ = v; }, placeholder: prL('fltSearch') },
            { options: unitOpts,  get: () => stockFilter.unit,  set: (v) => { stockFilter.unit = v; } },
            ...(state.branches.length > 1 ? [null] : []),   // branch filter stays in the toolbar (server-side reload)
            { options: supOpts,   get: () => stockFilter.sup,   set: (v) => { stockFilter.sup = v; } },
            { options: availOpts, get: () => stockFilter.avail, set: (v) => { stockFilter.avail = v; } },
            null, null,
            { options: flagOpts,  get: () => stockFilter.flag,  set: (v) => { stockFilter.flag = v; } },
            null,
        ], paintStockTable)),
        tbody,
    ));
}

async function loadStock() {
    const cid = currentClinicId();
    if (!cid) return;
    stockLoading = true;
    paintStockTable();
    try {
        // STOCK_WAREHOUSE_ONLY_V1 — the Склад tab is the WAREHOUSE pool; department
        // pools have their own «Отделения» tab. Without a location filter an item
        // shows once per location (e.g. Analgin in the warehouse AND in a department).
        let whLocIds = (state.locations || []).filter(l => l.kind === 'warehouse').map(l => l.id);
        if (!whLocIds.length) {
            try {
                const { data: locs } = await supabase.from('stock_locations')
                    .select('id, kind').eq('company_id', cid).eq('kind', 'warehouse').eq('active', true);
                whLocIds = (locs || []).map(l => l.id);
            } catch (_) { /* legacy clinics without stock_locations → no filter below */ }
        }
        let q = supabase.from('item_stock')
            .select('id, item_id, branch_id, location_id, qty_on_hand, reorder_level, updated_at')
            .eq('company_id', cid);
        if (state.stockBranch && state.stockBranch !== 'all') q = q.eq('branch_id', state.stockBranch);
        // warehouse locations OR legacy rows with no location set
        if (whLocIds.length) q = q.or('location_id.in.(' + whLocIds.join(',') + '),location_id.is.null');
        const { data, error } = await q;
        if (error) throw error;
        // Join client-side against the cached items/branches lists.
        stockRows = (data || []).map(r => ({
            ...r,
            _item: itemById(r.item_id),
            _branch: branchById(r.branch_id),
        }))
        // Sort by product name then branch for a stable view.
        .sort((a, b) => ((a._item?.name || '').localeCompare(b._item?.name || '')) || ((a._branch?.name || '').localeCompare(b._branch?.name || '')));

        // SUPPLIER_STOCK_V1 — DISPLAY rows split each item's warehouse on-hand by the
        // supplier of its lots (batch_stock ⋈ stock_batches.supplier_id). stockRows
        // itself stays one-per-(item,branch) so the issue guard + product picker keep
        // reading true totals. Un-lotted / supplier-less stock reconstructs as a «—» row.
        const splitMap = new Map();
        try {
            let bq = supabase.from('batch_stock')
                .select('item_id, branch_id, location_id, qty_on_hand, stock_batches(supplier_id)')
                .eq('company_id', cid).gt('qty_on_hand', 0).limit(5000);
            if (state.stockBranch && state.stockBranch !== 'all') bq = bq.eq('branch_id', state.stockBranch);
            if (whLocIds.length) bq = bq.in('location_id', whLocIds);
            const { data: bdata } = await bq;
            for (const b of (bdata || [])) {
                const sid = (b.stock_batches && b.stock_batches.supplier_id) || '';
                const key = b.item_id + '|' + b.branch_id;
                let m = splitMap.get(key); if (!m) { m = new Map(); splitMap.set(key, m); }
                m.set(sid, (m.get(sid) || 0) + Number(b.qty_on_hand || 0));
            }
        } catch (_) { /* supplier column / batch layer absent → single «—» rows */ }

        stockDisplayRows = [];
        for (const r of stockRows) {
            const Q = Number(r.qty_on_hand || 0);
            // STOCK_HIDE_ZERO_V1 — only what is actually on hand: skip zero balances
            // unless a reorder level is set (keep the «Дозаказ» alert visible).
            // Negative balances stay visible — they signal a problem.
            if (Math.abs(Q) < 0.00001 && (r.reorder_level == null || r.reorder_level === '')) continue;
            const m = splitMap.get(r.item_id + '|' + r.branch_id);
            if (m && m.size) {
                let sum = 0, added = 0;
                for (const [sid, qty] of m.entries()) {
                    if (Math.abs(qty) < 0.00001) continue;
                    stockDisplayRows.push({ ...r, supplier_id: sid || null, qty_on_hand: qty, item_total: Q, _supplier: sid ? supplierById(sid) : null });
                    sum += qty; added++;
                }
                const remainder = Q - sum;
                if (remainder > 0.00001) { stockDisplayRows.push({ ...r, supplier_id: null, qty_on_hand: remainder, item_total: Q, _supplier: null }); added++; }
                if (!added) stockDisplayRows.push({ ...r, supplier_id: null, qty_on_hand: Q, item_total: Q, _supplier: null });
            } else {
                stockDisplayRows.push({ ...r, supplier_id: null, qty_on_hand: Q, item_total: Q, _supplier: null });
            }
        }
        stockDisplayRows.sort((a, b) =>
            ((a._item?.name || '').localeCompare(b._item?.name || ''))
            || ((a._branch?.name || '').localeCompare(b._branch?.name || ''))
            || ((a._supplier?.name || '').localeCompare(b._supplier?.name || '')));

        // STOCK_ORDER_BTN_V1 — receivable POs by item (latest first) for the
        // per-row Order / Receive-order button. Same column set loadPOs selects,
        // so openPODetail can open the object directly.
        try {
            const { data: pos } = await supabase.from('purchase_orders')
                .select('id, branch_id, supplier_id, po_number, status, order_date, expected_date, total, notes, created_at, received_at, purchase_order_items(item_id)')
                .eq('company_id', cid).in('status', ['ordered', 'partially_received'])
                .order('created_at', { ascending: false });
            openPOByItem = new Map(); openPOByItemSup = new Map();
            for (const po of (pos || []))
                for (const li of (po.purchase_order_items || [])) {
                    const k = String(li.item_id);
                    if (!openPOByItem.has(k)) openPOByItem.set(k, po);
                    const ks = k + '|' + String(po.supplier_id || '');   // STOCK_ORDER_BTN_V2
                    if (!openPOByItemSup.has(ks)) openPOByItemSup.set(ks, po);
                }
        } catch (_) { openPOByItem = new Map(); openPOByItemSup = new Map(); }
    } catch (err) {
        toast(err.message || String(err), 'fail');
        stockRows = []; stockDisplayRows = [];
    } finally {
        stockLoading = false;
    }
}

// ---- Stock movement log — STOCK_LOG_V1 -----------------------------------
// Click a stock row → history of every receipt/adjustment for that item at
// that branch: when, how many, at what cost, and WHO did it (users.full_name
// via stock_movements.created_by).
const MOVEMENT_KIND = {
    receipt:    { label: 'Приход',        color: 'var(--ok-700)' },
    adjustment: { label: 'Корректировка', color: 'var(--warn-700)' },
    issue:      { label: 'Расход',        color: 'var(--crit-700)' },
    transfer:   { label: 'Перемещение',   color: 'var(--info-700)' },
};

async function openStockLogModal(item, branch) {
    const bodyEl2 = h('div', { class: 'modal-body', style: { display: 'block' } },
        h('div', { class: 'muted', style: { padding: '20px', fontSize: '12.5px' } }, 'Загрузка журнала…'));

    openModal({
        title: trf('Журнал движений · {name}', { name: item.name || '—' }),
        subtitle: trf('{branch} — кто, когда и сколько принял или списал.', { branch: branch?.name || '—' }),
        width: '760px',
        body: bodyEl2,
        footerButtons: () => [],   // NO_DOUBLE_CLOSE_V1 — header red «Закрыть» is enough
    });

    const { data, error } = await supabase
        .from('stock_movements')
        .select('id, kind, qty, unit_cost, reference_type, reference_id, note, created_at, users:created_by(full_name)')
        .eq('company_id', currentClinicId())
        .eq('item_id', item.id)
        .eq('branch_id', branch.id)
        .order('created_at', { ascending: false })
        .limit(300);

    clear(bodyEl2);
    if (error) {
        bodyEl2.appendChild(h('div', { class: 'muted', style: { padding: '20px', fontSize: '12.5px' } },
            trf('Не удалось загрузить журнал: {msg}', { msg: error.message })));
        return;
    }
    const rows = data || [];
    if (!rows.length) {
        bodyEl2.appendChild(h('div', { class: 'muted', style: { padding: '28px 16px', textAlign: 'center', fontSize: '12.5px' } },
            'Движений пока нет — примите товар через кнопку Receive.'));
        return;
    }

    // STOCK_ISSUE_V1 — resolve issue recipients (reference_type='staff' →
    // reference_id is a users.id) in one batch lookup.
    const staffIds = [...new Set(rows.filter(m => m.reference_type === 'staff' && m.reference_id).map(m => m.reference_id))];
    const staffById = {};
    if (staffIds.length) {
        const { data: staff } = await supabase.from('users').select('id, full_name').in('id', staffIds);
        for (const u of (staff || [])) staffById[u.id] = u.full_name;
    }

    bodyEl2.appendChild(h('table', { class: 'tbl', style: { fontSize: '12.5px' } },
        h('thead', null, h('tr', null,
            h('th', null, 'Дата и время'),
            h('th', null, 'Операция'),
            h('th', { style: { textAlign: 'right' } }, 'Кол-во'),
            h('th', { style: { textAlign: 'right' } }, 'Цена ед.'),
            h('th', null, 'Примечание'),
            h('th', null, 'Кто принял'),
        )),
        h('tbody', null, ...rows.map(m => {
            const meta = MOVEMENT_KIND[m.kind] || { label: m.kind, color: 'var(--ink-600)' };
            const qty = Number(m.qty || 0);
            const d = new Date(m.created_at);
            const pad = n => String(n).padStart(2, '0');
            const when = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
            return h('tr', null,
                h('td', { class: 'num muted', style: { whiteSpace: 'nowrap' } }, when),
                h('td', null, h('span', { style: { color: meta.color, fontWeight: 600 } }, meta.label),
                    m.reference_type === 'po' ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, ' · из заказа') : null),
                h('td', { class: 'num cell-strong', style: { textAlign: 'right', color: qty >= 0 ? 'var(--ok-700)' : 'var(--crit-700)' } },
                    (qty >= 0 ? '+' : '') + fmtNum(qty)),
                h('td', { class: 'num muted', style: { textAlign: 'right' } }, m.unit_cost != null ? fmtMoney(Number(m.unit_cost)) : '—'),
                h('td', { class: 'muted', style: { fontSize: '12.5px', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.note || '—'),
                // «Кто принял»: for issues — the staff member who TOOK the goods
                // (plus who issued, muted); otherwise the movement's author.
                h('td', null,
                    m.kind === 'issue' && m.reference_type === 'staff'
                        ? h('div', null,
                            h('div', null, staffById[m.reference_id] || '—'),
                            m.users?.full_name ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, trf('выдал: {name}', { name: m.users.full_name })) : null)
                        : (m.users?.full_name || h('span', { class: 'muted' }, '—'))),
            );
        })),
    ));
}

// ---- Issue modal — STOCK_ISSUE_V1 -----------------------------------------
// Hand products to an employee/department: quantity + a type-to-search staff
// picker. Writes stock_movements kind='issue' (negative qty; the trigger
// deducts on-hand). The recipient is stored structurally in reference_type
// ='staff' + reference_id=<user id>, and a printable issue slip opens for
// signatures (storage keeps the paper).
// Cache the PROMISE (not the resolved rows) so concurrent keystrokes share
// one in-flight fetch instead of each starting their own.
let _issueStaffPromise = null;
function loadClinicStaff() {
    if (_issueStaffPromise) return _issueStaffPromise;
    const cid = currentClinicId();
    _issueStaffPromise = supabase.from('users')
        .select('id, full_name, role, specialty')
        .eq('company_id', cid).eq('active', true)
        .order('full_name').limit(500)
        .then(({ data, error }) => {
            if (error) { console.warn('[procurement] staff load:', error.message); return []; }
            return data || [];
        });
    return _issueStaffPromise;
}

// ---------------------------------------------------------------------------
// BULK_ISSUE_V1 — «Выдать» from the stock toolbar: several products at once to
// ONE recipient. Search + add lines with quantities, pick the department
// (стационар / амбулаторный) and the member of staff taking them, then write a
// signed stock_movements row per line and print one требование-накладная that
// lists them all.
// ---------------------------------------------------------------------------
const BULK_DEPTS = [
    { key: 'inpatient',  labelKey: 'biInpatient' },
    { key: 'outpatient', labelKey: 'biOutpatient' },
    { key: 'surgery',    labelKey: 'biSurgery' },   // MORE_DEPARTMENTS_V1
    { key: 'cssd',       labelKey: 'biCssd' },      // MORE_DEPARTMENTS_V1 — ОЦС
];

// ISSUE_PACK_V1 — units offered when ISSUING to a department: the base unit plus
// every distinct pack from the item's supplier links (Aventus 10/уп, EasyFarm
// 12/уп …) and any product-level conversion. Each option carries its own factor.
function issueUnitOptions(item) {
    const base = baseUnitOf(item);
    const opts = [{ code: base, factor: 1, label: base }];
    const seen = new Set([(base || '').toLowerCase() + '@1']);
    const push = (code, factor, supName) => {
        const f = Number(factor);
        const c = String(code || '').trim();
        if (!c || !(f > 0) || f === 1) return;
        const k = c.toLowerCase() + '@' + f;
        if (seen.has(k)) return;
        seen.add(k);
        opts.push({ code: c, factor: f, label: c + ' (' + fmtNum(f) + ' ' + base + (supName ? ' · ' + supName : '') + ')' });
    };
    for (const o of unitOptionsFor(item)) push(o.code, o.factor, null);
    for (const l of state.itemSuppliers.filter(x => String(x.item_id) === String(item.id))) {
        const sup = state.suppliers.find(x => String(x.id) === String(l.supplier_id));
        push(l.purchase_unit || item.purchase_unit || 'уп', l.pack_factor, sup ? sup.name : null);
    }
    return opts;
}

function openBulkIssueModal() {
    if (!state.branches.length) { toast(prL('biNoBranches'), 'info'); return; }
    const inpStyle = {
        height: '34px', padding: '0 10px', border: '1px solid #d1d5db',
        borderRadius: '8px', fontSize: '13.5px', background: 'white',
        fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', width: '100%',
    };

    // ---- branch: resolved automatically, no picker (BULK_ISSUE_NOBRANCH_V1).
    // Stock is still per branch in the DB, so we take the branch the stock tab is
    // filtered to; with no filter (or «all») we fall back to the clinic's first
    // branch — which is THE branch for single-branch clinics.
    const issueBranch = state.branches.find(b => String(b.id) === String(state.stockBranch))
        || state.branches[0];

    // ---- department ----
    const deptSel = h('select', { style: inpStyle },
        // BULK_ISSUE_DEPT_PICK_V1 — no silent default: the user must choose.
        h('option', { value: '', selected: true }, prL('biDeptPh')),
        ...BULK_DEPTS.map(d => h('option', { value: d.key }, prL(d.labelKey))));

    // ---- product lines ----
    const lines = [];   // { item, qty, onHand }
    const linesWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    const emptyHint = h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '10px 2px' } },
        prL('biItemsHint'));

    function onHandFor(itemId) {
        const bid = issueBranch?.id;
        const row = stockRows.find(r => String(r._item?.id) === String(itemId) && String(r._branch?.id) === String(bid));
        return Number(row?.qty_on_hand || 0);
    }
    function paintLines() {
        clear(linesWrap);
        if (!lines.length) { linesWrap.appendChild(emptyHint); return; }
        lines.forEach((ln, idx) => {
            const qtyIn = h('input', {
                type: 'number', min: '0.0001', step: 'any', value: String(ln.qty ?? ''),
                placeholder: prL('biQtyPh'),
                style: { ...inpStyle, width: '110px', textAlign: 'right' },
            });
            // UNIT_ENGINE_V1 — compare against on-hand in BASE units, not entry units.
            const issConv = h('div', { class: 'muted', style: { fontSize: '12.5px' } });
            function paintIssConv() {
                const f = ln.unitF > 0 ? ln.unitF : unitFactor(ln.item, ln.unit);   // ISSUE_PACK_V1
                issConv.textContent = f === 1 ? ''
                    : fmtNum(Number(ln.qty) || 0) + ' ' + ln.unit + ' ' + prL('unConverted') + ' '
                      + fmtNum((Number(ln.qty) || 0) * f) + ' ' + baseUnitOf(ln.item);
            }
            // ISSUE_PACK_V1 — options include each supplier's own pack (value = index,
            // because the same unit code can carry different factors per supplier).
            const issOpts = issueUnitOptions(ln.item);
            let issUnitSel = null;
            if (issOpts.length > 1) {
                issUnitSel = h('select', { style: {
                    height: '34px', padding: '0 6px', border: '1px solid #d1d5db', borderRadius: '8px',
                    fontSize: '12.5px', background: 'white', fontFamily: 'inherit', minWidth: '84px',
                } }, ...issOpts.map((o, i) => h('option', { value: String(i) }, o.label)));
                let curIdx = issOpts.findIndex(o => o.code.toLowerCase() === String(ln.unit || '').toLowerCase()
                    && (!(ln.unitF > 0) || o.factor === ln.unitF));
                if (curIdx < 0) curIdx = 0;
                issUnitSel.value = String(curIdx);
                ln.unit = issOpts[curIdx].code; ln.unitF = issOpts[curIdx].factor;
                issUnitSel.addEventListener('change', () => {
                    const o = issOpts[Number(issUnitSel.value)] || issOpts[0];
                    ln.unit = o.code; ln.unitF = o.factor;
                    paintIssConv(); paintLines();
                });
            } else { ln.unitF = 1; }
            qtyIn.addEventListener('input', () => { ln.qty = Number(qtyIn.value); paintIssConv(); });
            paintIssConv();
            const over = ((Number(ln.qty) || 0) * (ln.unitF > 0 ? ln.unitF : unitFactor(ln.item, ln.unit))) > ln.onHand;
            linesWrap.appendChild(h('div', {
                style: {
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
                    border: '1px solid ' + (over ? 'var(--crit-400, #f87171)' : 'var(--ink-100)'),
                    borderRadius: '10px', background: over ? 'var(--crit-50, #fef2f2)' : 'var(--white)',
                },
            },
                h('div', { style: { minWidth: 0, flex: 1 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '13.5px' } }, ln.item.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                        prL('biOnHand') + fmtNum(ln.onHand) + ' ' + baseUnitOf(ln.item)),
                    issConv),
                qtyIn, issUnitSel,
                h('button', {
                    class: 'btn btn-ghost btn-sm', type: 'button', title: prL('biRemove'),
                    onclick: () => { lines.splice(idx, 1); paintLines(); },
                }, '×'),
            ));
        });
    }

    // ---- product search ----
    const prodWrap = h('div', { style: { position: 'relative' } });
    const prodInp = h('input', { type: 'text', placeholder: prL('biProdSearch'), style: inpStyle });
    const prodSuggest = h('div', {
        style: {
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
            background: 'white', border: '1px solid var(--ink-200)', borderRadius: '10px',
            boxShadow: '0 10px 30px rgba(15,23,42,0.14)', maxHeight: '220px', overflow: 'auto', display: 'none',
        },
    });
    prodWrap.appendChild(prodInp); prodWrap.appendChild(prodSuggest);
    function paintProdSuggestions() {
        const q = prodInp.value.trim().toLowerCase();
        clear(prodSuggest);
        if (!q) { prodSuggest.style.display = 'none'; return; }
        const bid = issueBranch?.id;
        const hits = stockRows
            .filter(r => String(r._branch?.id) === String(bid))
            .filter(r => (r._item?.name || '').toLowerCase().includes(q))
            .filter(r => !lines.some(l => String(l.item.id) === String(r._item.id)))
            .slice(0, 8);
        if (!hits.length) {
            prodSuggest.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } }, prL('biNothing')));
        } else {
            for (const r of hits) {
                prodSuggest.appendChild(h('button', {
                    type: 'button',
                    style: {
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', width: '100%',
                        padding: '9px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
                        fontSize: '13.5px', color: 'var(--ink-800)', fontFamily: 'inherit', textAlign: 'left',
                    },
                    onmousedown: (e) => e.preventDefault(),
                    onclick: () => {
                        // UNIT_ENGINE_V1 — onHand is in base units; qty is entered in `unit`.
                        lines.push({ item: r._item, qty: 1, onHand: Number(r.qty_on_hand || 0), unit: baseUnitOf(r._item), unitF: 1 });   // ISSUE_PACK_V1
                        prodInp.value = ''; prodSuggest.style.display = 'none';
                        paintLines(); prodInp.focus();
                    },
                },
                    h('span', null, r._item?.name || '—'),
                    h('span', { class: 'muted', style: { fontSize: '12.5px' } }, fmtNum(r.qty_on_hand || 0) + ' ' + (r._item?.unit || ''))));
            }
        }
        prodSuggest.style.display = 'block';
    }
    prodInp.addEventListener('input', paintProdSuggestions);
    prodInp.addEventListener('focus', paintProdSuggestions);
    prodInp.addEventListener('blur', () => setTimeout(() => { prodSuggest.style.display = 'none'; }, 150));

    // ---- recipient (staff) ----
    let recipient = null;
    const chipEl = h('div', { style: { minHeight: '30px', display: 'flex', alignItems: 'center' } });
    const staffWrap = h('div', { style: { position: 'relative' } });
    const staffInp = h('input', { type: 'text', placeholder: prL('staffSearch'), style: inpStyle });
    const staffSuggest = h('div', {
        style: {
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
            background: 'white', border: '1px solid var(--ink-200)', borderRadius: '10px',
            boxShadow: '0 10px 30px rgba(15,23,42,0.14)', maxHeight: '200px', overflow: 'auto', display: 'none',
        },
    });
    staffWrap.appendChild(staffInp); staffWrap.appendChild(staffSuggest);
    function paintRecipientChip() {
        clear(chipEl);
        if (!recipient) {
            chipEl.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, prL('noStaffSel')));
            return;
        }
        chipEl.appendChild(h('span', {
            style: {
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '4px 6px 4px 10px', borderRadius: '999px',
                background: 'var(--primary-50)', border: '1px solid var(--primary-200)',
                color: 'var(--primary-700)', fontSize: '12.5px', fontWeight: 600,
            },
        },
            recipient.full_name,
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', style: { padding: '0 4px' },
                onclick: () => { recipient = null; paintRecipientChip(); } }, '×')));
    }
    let staffSeq = 0;
    async function paintStaffHits() {
        const q = staffInp.value.trim().toLowerCase();
        if (!q) { clear(staffSuggest); staffSuggest.style.display = 'none'; return; }
        const mySeq = ++staffSeq;
        const staff = await loadClinicStaff();
        if (mySeq !== staffSeq) return;
        clear(staffSuggest);
        const hits = staff.filter(u => (u.full_name || '').toLowerCase().includes(q)).slice(0, 8);
        if (!hits.length) {
            staffSuggest.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } }, prL('biNothing')));
        } else {
            for (const u of hits) {
                staffSuggest.appendChild(h('button', {
                    type: 'button',
                    style: {
                        display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
                        padding: '9px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
                        fontSize: '13.5px', color: 'var(--ink-800)', fontFamily: 'inherit', textAlign: 'left',
                    },
                    onmousedown: (e) => e.preventDefault(),
                    onclick: () => {
                        recipient = u; staffInp.value = ''; staffSuggest.style.display = 'none'; paintRecipientChip();
                    },
                },
                    h('span', null, u.full_name || '—'),
                    u.role ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, u.role) : null));
            }
        }
        staffSuggest.style.display = 'block';
    }
    staffInp.addEventListener('input', paintStaffHits);
    staffInp.addEventListener('focus', paintStaffHits);
    staffInp.addEventListener('blur', () => setTimeout(() => { staffSuggest.style.display = 'none'; }, 150));

    const noteInput = h('input', { type: 'text', placeholder: prL('biNotePh'), style: inpStyle });

    paintLines(); paintRecipientChip();

    const body = h('form', { class: 'modal-body' },
        h('div', { class: 'field' }, h('label', null, prL('biDept')), deptSel),
        h('div', { class: 'field' }, h('label', null, prL('biItems')), linesWrap),
        prodWrap,
        h('div', { class: 'field' }, h('label', null, prL('recipient')), chipEl, staffWrap),
        // BI_NO_NOTE_V1 - note field removed from the dialog; noteInput stays
        // defined so the submit path / slip params are unchanged.
    );

    openModal({
        title: prL('biTitle'),
        subtitle: prL('biSub'),
        width: '680px',
        body,
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, prL('cancel')),
            h('button', {
                class: 'btn btn-primary', type: 'button',
                onclick: async (e) => {
                    const branch = issueBranch;
                    if (!branch) { toast(prL('biNoBranches'), 'fail'); return; }
                    const valid = lines.filter(l => Number(l.qty) > 0);
                    if (!deptSel.value) { toast(prL('biErrDept'), 'fail'); deptSel.focus(); return; }   // BULK_ISSUE_DEPT_PICK_V1
                    if (!valid.length) { toast(prL('biErrLines'), 'fail'); return; }
                    // UNIT_ENGINE_V1 — the warehouse guard works in base units.
                    const issF = (l) => (l.unitF > 0 ? l.unitF : unitFactor(l.item, l.unit));   // ISSUE_PACK_V1
                    const over = valid.find(l => (Number(l.qty) || 0) * issF(l) > Number(l.onHand));
                    if (over) { toast(prL('biErrShort') + over.item.name + prL('biErrShort2') + fmtNum(over.onHand) + '.', 'fail'); return; }
                    if (!recipient) { toast(prL('biErrRecipient'), 'fail'); staffInp.focus(); return; }
                    e.target.disabled = true;
                    try {
                        const issuer = (typeof currentUser === 'function' && currentUser()) || {};
                        const dept = BULK_DEPTS.find(d => d.key === deptSel.value);
                        const deptLabel = prL(dept.labelKey);
                        const whLoc = warehouseLoc(branch.id);
                        const toLoc = deptLoc(branch.id, dept.key);
                        const noteTxt = [deptLabel, noteInput.value.trim()].filter(Boolean).join(' · ');
                        const rows = valid.map(l => ({
                            company_id: currentClinicId(),
                            item_id: l.item.id,
                            branch_id: branch.id,
                            kind: 'issue',
                            qty: -((Number(l.qty) || 0) * issF(l)),   // UNIT_ENGINE_V1 / ISSUE_PACK_V1 — supplier pack converts to base units
                            // STOCK_LOCATIONS_V1 — warehouse → department. Both
                            // null (mig 120 absent) = legacy warehouse-only debit.
                            from_location_id: whLoc ? whLoc.id : null,
                            to_location_id:   toLoc ? toLoc.id : null,
                            reference_type: 'staff',
                            reference_id: recipient.id,
                            department: dept.key,        // DEPT_USAGE_V1 — groupable, unlike the note text
                            note: noteTxt || null,
                            created_by: issuer.id || null,
                        }));
                        const { error } = await supabase.from('stock_movements').insert(rows);
                        if (error) throw error;
                        toast(prL('biOk') + valid.length + ' — ' + recipient.full_name + '.', 'ok');
                        close();
                        openBulkIssueSlip({ lines: valid, branch, recipient, issuer, dept: deptLabel, note: noteInput.value.trim() });
                        await loadStock();
                        paintStockTable();
                    } catch (err) {
                        toast(err.message || String(err), 'fail');
                    } finally { e.target.disabled = false; }
                },
            }, Icon('Minus', { size: 13 }), prL('issuePrint')),
        ],
    });
    setTimeout(() => prodInp.focus(), 0);
}

// Multi-row требование-накладная for the bulk issue (BULK_ISSUE_V1).
/* type-scale-exempt-start: печатный документ — семейство Onest, размеры остаются его выверенными метриками (дизайн-док 2026-08-31) */
function openBulkIssueSlip({ lines, branch, recipient, issuer, dept, note }) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dt = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const num = 'TN-' + now.getTime().toString(36).toUpperCase();
    const clinicName = (window.CLINIC && window.CLINIC.name) || '';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rowsHtml = lines.map((l, i) => `<tr>
      <td style="text-align:right">${i + 1}</td>
      <td>${esc(l.item.name || '')}</td>
      <td>${esc(l.item.unit || '—')}</td>
      <td style="text-align:right"><b>${esc(String(l.qty))}</b></td>
    </tr>`).join('');

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(num)}</title>
<style>
${PRINT_FONT_FACE_CSS}
  body { font: 13px/1.5 'Onest', 'Segoe UI', Arial, sans-serif; color: #111; max-width: 700px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .muted { color: #666; font-size: 12px; }
  .meta { margin-top: 10px; font-size: 12.5px; }
  .meta b { display: inline-block; min-width: 130px; }
  table { width: 100%; border-collapse: collapse; margin: 18px 0; }
  th, td { border: 1px solid #999; padding: 7px 10px; font-size: 12.5px; text-align: left; }
  th { background: #f2f2f2; font-weight: 600; }
  .sig { display: flex; justify-content: space-between; gap: 40px; margin-top: 44px; }
  .sig > div { flex: 1; }
  .sig .line { border-bottom: 1px solid #333; height: 34px; margin-bottom: 4px; }
  .sig .cap { font-size: 11px; color: #555; }
  @media print { body { margin: 10mm auto; } }
</style></head><body>
  <h1>${esc(prL('slipTitle'))} ${esc(num)}</h1>
  <div class="muted">${esc(clinicName)}${clinicName ? ' · ' : ''}${esc(branch?.name || '')} · ${esc(dt)}</div>
  <div class="meta">
    <div><b>${esc(prL('slipDept'))}</b> ${esc(dept || '—')}</div>
    <div><b>${esc(prL('slipRecipient'))}</b> ${esc(recipient?.full_name || '—')}</div>
    ${note ? `<div><b>${esc(prL('slipNote'))}</b> ${esc(note)}</div>` : ''}
  </div>
  <table>
    <thead><tr><th style="width:38px">${esc(prL('slipNo'))}</th><th>${esc(prL('slipName'))}</th><th style="width:80px">${esc(prL('slipUnit'))}</th><th style="width:110px;text-align:right">${esc(prL('slipQty'))}</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="sig">
    <div>
      <div class="line"></div>
      <div class="cap">${esc(prL('slipIssuedBy'))} ${esc(issuer?.full_name || issuer?.username || '')} ${esc(prL('slipSign'))}</div>
    </div>
    <div>
      <div class="line"></div>
      <div class="cap">${esc(prL('slipReceivedBy'))} ${esc(recipient?.full_name || '')} ${esc(prL('slipSign'))}</div>
    </div>
  </div>
  <script>window.addEventListener('load', function(){ (document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){ setTimeout(function(){ window.print(); }, 150); }); });</scr` + `ipt>
</body></html>`;

    const w = window.open('', '_blank', 'width=760,height=900');
    if (!w) { toast(prL('biPopup'), 'fail'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
}
/* type-scale-exempt-end */

// BULK_ISSUE_ONLY_V1 — UNUSED since the per-row «Выдать» button was removed;
// kept (with openIssueSlip) so a single-product issue can be re-enabled easily.
function openIssueModal(item, branch, onHand) {
    const inpStyle = {
        height: '34px', padding: '0 10px', border: '1px solid #d1d5db',
        borderRadius: '8px', fontSize: '13.5px', background: 'white',
        fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', width: '100%',
    };
    const qtyInput  = h('input', { type: 'number', min: '0.0001', step: 'any', placeholder: 'напр. 10', required: true, style: inpStyle });
    const noteInput = h('input', { type: 'text', placeholder: 'Отделение / назначение (необязательно)', style: inpStyle });

    // Staff picker: search + single selected chip.
    let recipient = null;
    const chipEl = h('div', { style: { minHeight: '30px', display: 'flex', alignItems: 'center' } });
    const searchWrap = h('div', { style: { position: 'relative' } });
    const searchInp  = h('input', { type: 'text', placeholder: prL('staffSearch'), style: inpStyle });
    const suggestEl  = h('div', {
        style: {
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20,
            background: 'white', border: '1px solid var(--ink-200)', borderRadius: '10px',
            boxShadow: '0 10px 30px rgba(15,23,42,0.14)', maxHeight: '200px', overflow: 'auto',
            display: 'none',
        },
    });
    searchWrap.appendChild(searchInp);
    searchWrap.appendChild(suggestEl);

    function paintRecipient() {
        clear(chipEl);
        if (!recipient) {
            chipEl.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, prL('noStaffSel')));
            return;
        }
        chipEl.appendChild(h('span', {
            style: {
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '4px 6px 4px 10px', borderRadius: '999px',
                background: 'var(--primary-50)', border: '1px solid var(--primary-200)',
                color: 'var(--primary-700)', fontSize: '12.5px', fontWeight: 600,
            },
        },
            recipient.full_name,
            recipient.role ? h('span', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 400 } }, recipient.role) : null,
            h('button', {
                type: 'button', title: 'Убрать',
                style: {
                    width: '18px', height: '18px', border: 'none', borderRadius: '50%',
                    background: 'var(--primary-100, #d3ece9)', color: 'var(--primary-700)',
                    cursor: 'pointer', fontSize: '12.5px', lineHeight: '1', padding: 0,
                    display: 'grid', placeItems: 'center',
                },
                onclick: () => { recipient = null; paintRecipient(); },
            }, '×'),
        ));
    }
    paintRecipient();

    let paintSeq = 0;   // stale-response guard: only the latest keystroke paints
    async function paintStaffSuggestions() {
        const q = searchInp.value.trim().toLowerCase();
        if (!q) { clear(suggestEl); suggestEl.style.display = 'none'; return; }
        const mySeq = ++paintSeq;
        const staff = await loadClinicStaff();
        if (mySeq !== paintSeq) return;   // a newer keystroke repainted already
        clear(suggestEl);                  // clear AFTER the await, right before appending
        const hits = staff.filter(u => (u.full_name || '').toLowerCase().includes(q)).slice(0, 8);
        if (!hits.length) {
            suggestEl.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } }, 'Никого не найдено.'));
        } else {
            for (const u of hits) {
                suggestEl.appendChild(h('button', {
                    type: 'button',
                    style: {
                        display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
                        padding: '9px 12px', border: 'none', background: 'transparent',
                        cursor: 'pointer', fontSize: '13.5px', color: 'var(--ink-800)',
                        fontFamily: 'inherit', textAlign: 'left',
                    },
                    onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-50)'; },
                    onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
                    onclick: () => {
                        recipient = u;
                        searchInp.value = '';
                        suggestEl.style.display = 'none';
                        paintRecipient();
                    },
                },
                    h('span', { style: { fontWeight: 600 } }, u.full_name),
                    h('span', { class: 'muted', style: { fontSize: '12.5px' } }, [u.role, u.specialty].filter(Boolean).join(' · ')),
                ));
            }
        }
        suggestEl.style.display = 'block';
    }
    searchInp.addEventListener('input', paintStaffSuggestions);
    searchInp.addEventListener('focus', paintStaffSuggestions);
    searchInp.addEventListener('blur', () => setTimeout(() => { suggestEl.style.display = 'none'; }, 150));

    const body = h('form', { class: 'modal-body' },
        h('div', { style: { padding: '10px 12px', background: 'var(--ink-25, #fafafa)', border: '1px solid var(--ink-100)', borderRadius: '10px', marginBottom: '12px', fontSize: '13.5px' } },
            h('div', { class: 'cell-strong' }, item.name || '—'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } },
                (branch?.name || '—') + ' · ' + trf('В наличии: {n} {unit}', { n: fmtNum(onHand), unit: item.unit || '' })),
        ),
        fieldRow(prL('qty'), qtyInput),
        h('div', { class: 'field' },
            h('label', null, prL('recipient')),
            chipEl,
            searchWrap,
        ),
        fieldRow(prL('note'), noteInput),
    );

    openModal({
        title: prL('issueTitle'),
        subtitle: prL('issueSub'),
        body,
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, prL('cancel')),
            h('button', {
                class: 'btn btn-primary', type: 'button',
                onclick: async (e) => {
                    const qty = Number(qtyInput.value);
                    if (!(qty > 0)) { toast('Укажите количество больше 0.', 'fail'); qtyInput.focus(); return; }
                    if (qty > onHand) { toast(trf('Недостаточно на складе — в наличии {n}.', { n: fmtNum(onHand) }), 'fail'); qtyInput.focus(); return; }
                    if (!recipient) { toast('Выберите сотрудника, который получает товар.', 'fail'); searchInp.focus(); return; }
                    e.target.disabled = true;
                    try {
                        const issuer = (typeof currentUser === 'function' && currentUser()) || {};
                        const { error } = await supabase.from('stock_movements').insert({
                            company_id: currentClinicId(),
                            item_id: item.id,
                            branch_id: branch.id,
                            kind: 'issue',
                            qty: -qty,                        // signed: – deducts
                            reference_type: 'staff',
                            reference_id: recipient.id,       // who took the goods
                            note: noteInput.value.trim() || null,
                            created_by: issuer.id || null,    // who issued
                        });
                        if (error) throw error;
                        toast(trf('Выдано {n} — {name}.', { n: fmtNum(qty), name: recipient.full_name }), 'ok');
                        close();
                        openIssueSlip({ item, branch, qty, recipient, issuer, note: noteInput.value.trim() });
                        await loadStock();
                        paintStockTable();
                    } catch (err) {
                        toast(err.message || String(err), 'fail');
                    } finally { e.target.disabled = false; }
                },
            }, Icon('Minus', { size: 13 }), prL('issuePrint')),
        ],
    });
    setTimeout(() => qtyInput.focus(), 0);
}

// Printable issue slip (требование-накладная) with signature lines — the
// storage manager keeps the signed paper copy.
/* i18n-exempt-start: требование-накладная (ТН) — печатный документ, намеренно русский */
    /* type-scale-exempt-start: печатный документ — семейство Onest, размеры остаются его выверенными метриками (дизайн-док 2026-08-31) */
function openIssueSlip({ item, branch, qty, recipient, issuer, note }) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dt = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const num = 'ТН-' + now.getTime().toString(36).toUpperCase();
    const clinicName = (window.CLINIC && window.CLINIC.name) || '';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(num)}</title>
<style>
${PRINT_FONT_FACE_CSS}
  body { font: 13px/1.5 'Onest', 'Segoe UI', Arial, sans-serif; color: #111; max-width: 640px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .muted { color: #666; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin: 18px 0; }
  th, td { border: 1px solid #999; padding: 7px 10px; font-size: 12.5px; text-align: left; }
  th { background: #f2f2f2; font-weight: 600; }
  .sig { display: flex; justify-content: space-between; gap: 40px; margin-top: 44px; }
  .sig > div { flex: 1; }
  .sig .line { border-bottom: 1px solid #333; height: 34px; margin-bottom: 4px; }
  .sig .cap { font-size: 11px; color: #555; }
  @media print { body { margin: 10mm auto; } }
</style></head><body>
  <h1>Требование-накладная № ${esc(num)}</h1>
  <div class="muted">${esc(clinicName)}${clinicName ? ' · ' : ''}${esc(branch?.name || '')} · ${esc(dt)}</div>
  <table>
    <thead><tr><th>Наименование</th><th>Ед.</th><th style="text-align:right">Кол-во</th><th>Примечание</th></tr></thead>
    <tbody><tr>
      <td>${esc(item.name || '')}</td>
      <td>${esc(item.unit || '—')}</td>
      <td style="text-align:right"><b>${esc(String(qty))}</b></td>
      <td>${esc(note || '—')}</td>
    </tr></tbody>
  </table>
  <div class="sig">
    <div>
      <div class="line"></div>
      <div class="cap">Выдал: ${esc(issuer?.full_name || issuer?.username || '')} (подпись)</div>
    </div>
    <div>
      <div class="line"></div>
      <div class="cap">Получил: ${esc(recipient?.full_name || '')} (подпись)</div>
    </div>
  </div>
  <script>window.addEventListener('load', function(){ (document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){ setTimeout(function(){ window.print(); }, 150); }); });</scr` + `ipt>
</body></html>`;

    const w = window.open('', '_blank', 'width=760,height=900');
    if (!w) { toast('Всплывающее окно заблокировано — разрешите pop-ups для печати накладной.', 'fail'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
}
/* type-scale-exempt-end */
    /* i18n-exempt-end */

// ---- Receive modal: INSERT stock_movements kind='receipt', qty = +quantity ---
// ---------------------------------------------------------------------------
// RECEIVE_MULTI_V1 — «Принять товар»: several products in one receipt.
// Each line carries its own quantity and unit cost (pre-filled from the catalog
// price). The branch is resolved automatically (stock filter, else the clinic's
// only branch) — no picker. A product missing from the catalog can be created
// inline and lands straight in the lines.
// ---------------------------------------------------------------------------
// BATCH_CODE_GEN_V1 — a short, gluable, effectively-unique lot code: prefix from the
// product code / latin name (else LOT) + YYMMDD + 4 random base36 chars, e.g. ANAL-260725-K3F9.
function genBatchCode(item) {
    // BATCH_CODE_SHORT_V1 — «ANAL-GV1T»: prefix + 4 random chars. The receive date
    // is dropped from the code (the lot row already records it); 36^4 ≈ 1.7M combos
    // per product keeps codes distinct, and get_or_create_batch keys lots by
    // (item, code, expiry) anyway.
    let pfx = String((item && (item.code || item.name)) || 'LOT').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (pfx.length < 2) pfx = 'LOT';
    const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
    return pfx + '-' + rnd;
}

function openReceiveModal() {
    if (!state.branches.length) { toast(prL('biNoBranches'), 'info'); return; }
    const recvBranch = state.branches.find(b => String(b.id) === String(state.stockBranch))
        || state.branches[0];

    const inpStyle = {
        height: '34px', padding: '0 10px', border: '1px solid #d1d5db',
        borderRadius: '8px', fontSize: '13.5px', background: 'white',
        fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', width: '100%',
    };

    const lines = [];   // { item, qty, cost }
    // WIDE_RECEIVE_LINE_V1 — one product per row, all fields on a single line; the
    // container only scrolls sideways if the viewport is too narrow to fit them.
    const linesWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', overflowX: 'auto', paddingBottom: '2px' } });
    const totalEl = h('b', null, '0');

    function recalcTotal() {
        const sum = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
        totalEl.textContent = fmtNum(Math.round(sum));
    }
    // SUPPLIER_LINE_V1 — the item_suppliers link (and its purchase price) for a pair.
    function supplierLinkOf(itemId, supplierId) {
        return state.itemSuppliers.find(x =>
            String(x.item_id) === String(itemId) && String(x.supplier_id) === String(supplierId)) || null;
    }
    // SUPPLIER_PACK_V1 — units-in-one for THIS line's unit, honouring the line's
    // supplier: when the unit is the product's PURCHASE unit and the supplier link
    // carries its own pack_factor (Aventus 10/pack vs EasyFarm 12/pack), it wins.
    function lineFactor(ln) {
        if (ln.supplier) {
            const link = supplierLinkOf(ln.item.id, ln.supplier);
            const lu = String((link && link.purchase_unit) || ln.item.purchase_unit || '').trim().toLowerCase();
            if (link && Number(link.pack_factor) > 0 && lu
                && String(ln.unit || '').trim().toLowerCase() === lu) return Number(link.pack_factor);
        }
        return unitFactor(ln.item, ln.unit);
    }
    // SUPPLIER_UNITS_V1 — the unit options for a line: base first, then THIS
    // supplier's purchase unit (its pack), then any product-level conversions.
    function lineUnitCodes(ln) {
        const seen = new Set(); const out = [];
        const add = (c) => { const t = String(c || '').trim(); if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); } };
        add(baseUnitOf(ln.item));
        const link = ln.supplier ? supplierLinkOf(ln.item.id, ln.supplier) : null;
        if (link && Number(link.pack_factor) > 0) add(link.purchase_unit || ln.item.purchase_unit || 'уп');
        for (const o of unitOptionsFor(ln.item)) add(o.code);
        return out;
    }
    // SUPPLIER_LINE_CREATE_V1 — the (+) next to the line's supplier select: create a
    // supplier on the spot, WITH its purchase price for this line's product. Writes
    // suppliers + the item_suppliers link (last_price), then selects it on the line.
    function openLineSupplierModal(ln) {
        const nmIn  = h('input', { type: 'text',  placeholder: 'Название компании *', style: { ...inpStyle, minWidth: 0 } });
        const mgIn  = h('input', { type: 'text',  placeholder: 'Менеджер (контактное лицо)', style: { ...inpStyle, minWidth: 0 } });
        const phIn  = styledPhoneInput('Телефон *', inpStyle);
        const emIn  = h('input', { type: 'email', placeholder: 'Email', style: { ...inpStyle, minWidth: 0 } });
        const prIn  = h('input', { type: 'number', min: '0', step: 'any',
            placeholder: trf('Цена закупки (за {unit})', { unit: baseUnitOf(ln.item) }), style: { ...inpStyle, minWidth: 0 } });
        if (ln.cost !== '' && ln.cost != null) prIn.value = String(ln.cost);
        openModal({
            title: 'Новый поставщик',
            subtitle: trf('Для товара «{name}» — создаётся, привязывается и подставляется в строку.', { name: ln.item.name || '—' }),
            width: '460px',
            zIndex: '220',   // above the receive modal (default 160)
            body: h('div', { class: 'modal-body' },
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                    nmIn, mgIn, phIn, emIn,
                    h('div', null,
                        h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '3px' } },
                            trf('Цена закупки у этого поставщика (за {unit})', { unit: baseUnitOf(ln.item) })),
                        prIn))),
            footerButtons: (close) => [
                h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
                h('button', {
                    class: 'btn btn-primary', type: 'button',
                    onclick: async (e) => {
                        const nm = nmIn.value.trim();
                        if (!nm) { toast('Введите название поставщика.', 'fail'); nmIn.focus(); return; }
                        if (!phIn.value.trim()) { toast('Укажите телефон поставщика.', 'fail'); phIn.focus(); return; }   // SUPPLIER_PHONE_REQ_V1
                        const price = prIn.value === '' ? null : Number(prIn.value);
                        e.target.disabled = true;
                        try {
                            const { data, error } = await supabase.from('suppliers')
                                .insert({
                                    company_id: currentClinicId(), name: nm,
                                    contact_name: mgIn.value.trim() || null,
                                    phone: phIn.value.trim() || null,
                                    email: emIn.value.trim() || null,
                                    active: true,
                                })
                                .select('id, name, contact_name, phone, email, notes, active').single();
                            if (error) throw error;
                            state.suppliers.push(data);
                            state.suppliers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
                            // Link to this line's product with the given purchase price.
                            if (state.itemSuppliersOk) {
                                const { data: lk, error: lkErr } = await supabase.from('item_suppliers')
                                    .insert({ company_id: currentClinicId(), item_id: ln.item.id,
                                        supplier_id: data.id, last_price: price })
                                    .select('id, item_id, supplier_id, last_price').single();
                                if (lkErr) console.warn('[line-supplier] link:', lkErr.message);
                                else state.itemSuppliers.push(lk);
                            }
                            ln.supplier = String(data.id);
                            if (price != null) ln.cost = price;
                            paintLines();
                            toast(trf('Поставщик «{name}» создан и выбран.', { name: data.name }), 'ok');
                            close();
                        } catch (err) {
                            toast(err.message || String(err), 'fail');
                            e.target.disabled = false;
                        }
                    },
                }, Icon('Plus', { size: 13 }), ' Создать'),
            ],
        });
        setTimeout(() => { try { nmIn.focus(); } catch (e) {} }, 30);
    }
    function addLine(item) {
        if (!item) return;
        // SUPPLIER_LINE_V1 — the SAME product may be received on several lines (one per
        // supplier), so duplicates are allowed; each line carries its own supplier+cost.
        // UNIT_ENGINE_V1 — qty/cost are entered in `unit`, stored in base units.
        // BATCH_FEFO_V1 — tracked products also capture a lot № + expiry.
        // BATCH_CODE_GEN_V1 — auto-mint a lot code for packed products (medicines /
        // batch-tracked) so it is ready to glue; others start blank (a code is also
        // minted the moment an expiry is entered). Editable per line.
        const packed = !!(item.is_drug || item.procurement_category === 'medicines' || item.track_batches);
        // Default supplier: the product's only linked supplier (its purchase price
        // pre-fills the cost); with several links the user picks and the price follows.
        const linked = state.itemSuppliers.filter(x => String(x.item_id) === String(item.id));
        const only = linked.length === 1 ? linked[0] : null;
        const defCost = only && only.last_price != null ? Number(only.last_price)
            : (item.price != null ? Number(item.price) : '');
        lines.push({ item, qty: 1, cost: defCost, unit: baseUnitOf(item),
            supplier: only ? String(only.supplier_id) : '',
            batch: (state.batchOk !== false && packed) ? genBatchCode(item) : '', expiry: '' });
        paintLines();
    }
    function paintLines() {
        clear(linesWrap);
        if (!lines.length) {
            linesWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '10px 2px' } }, prL('rcItemsHint')));
            recalcTotal();
            return;
        }
        lines.forEach((ln, idx) => {
            const qtyIn = h('input', { type: 'number', min: '0.0001', step: 'any', value: String(ln.qty ?? ''),
                placeholder: prL('rcQtyPh'), style: { ...inpStyle, width: '96px', textAlign: 'right' } });
            qtyIn.addEventListener('input', () => { ln.qty = Number(qtyIn.value); recalcTotal(); });
            const costIn = h('input', { type: 'number', min: '0', step: 'any', value: ln.cost === '' ? '' : String(ln.cost),
                placeholder: prL('rcCostPh'), style: { ...inpStyle, width: '120px', textAlign: 'right' } });
            costIn.addEventListener('input', () => { ln.cost = costIn.value === '' ? '' : Number(costIn.value); recalcTotal(); });
            // UNIT_ENGINE_V1 — pick the unit the goods arrive in; the movement is
            // always written in base units so stock stays comparable.
            const convHint = h('div', { class: 'muted', style: { fontSize: '12.5px' } });
            function paintConv() {
                const f = lineFactor(ln);   // SUPPLIER_PACK_V1 — supplier-specific pack size
                convHint.textContent = f === 1 ? ''
                    : fmtNum(Number(ln.qty) || 0) + ' ' + ln.unit + ' ' + prL('unConverted') + ' '
                      + fmtNum((Number(ln.qty) || 0) * f) + ' ' + baseUnitOf(ln.item);
            }
            // SUPPLIER_UNITS_V1 — options depend on the line's supplier (its own pack unit).
            const codes = lineUnitCodes(ln);
            if (!codes.some(c => c.toLowerCase() === String(ln.unit || '').toLowerCase())) ln.unit = codes[0];
            const unitSel = codes.length > 1 ? (() => {
                const sel = h('select', { style: {
                    height: '34px', padding: '0 6px', border: '1px solid #d1d5db', borderRadius: '8px',
                    fontSize: '12.5px', background: 'white', fontFamily: 'inherit', width: '84px',
                } }, ...codes.map(c => h('option', { value: c }, c)));
                sel.value = ln.unit;
                sel.addEventListener('change', () => { ln.unit = sel.value; paintConv(); recalcTotal(); });
                return sel;
            })() : null;
            qtyIn.addEventListener('input', paintConv);
            paintConv();

            // BATCH_CODE_GEN_V1 — auto-generated lot code, glued to the physical pack so
            // multiple deliveries of the same product (different expiries) stay distinct.
            // Editable (type the manufacturer's real lot if preferred); «↻» regenerates.
            // Passed to get_or_create_batch as batch_number → each code is its own FEFO lot.
            const codeIn = state.batchOk === false ? null
                : h('input', { type: 'text', value: ln.batch || '', placeholder: prL('bxBatchPh'), title: prL('bxBatch'),
                    style: { ...inpStyle, width: '150px', fontFamily: 'ui-monospace, monospace' } });
            if (codeIn) codeIn.addEventListener('input', () => { ln.batch = codeIn.value; });
            const codeGen = codeIn ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: prL('bxGen'),
                style: { padding: '0 8px', fontSize: '13.5px' },
                onclick: () => { ln.batch = genBatchCode(ln.item); codeIn.value = ln.batch; } }, '\u21bb') : null;
            const codeGroup = codeIn ? h('div', { class: 'row', style: { gap: '4px', alignItems: 'center' } },
                h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, prL('bxBatch')),
                codeIn, codeGen) : null;

            // PRODUCT_EXPIRY_V2 — expiration date INLINE, right next to the product.
            // Entering it stores the goods as a dated lot (see the Receive handler).
            const expIn = state.batchOk === false ? null
                : h('input', { type: 'date', value: ln.expiry || '', title: prL('bxExpiry'),
                    style: { ...inpStyle, width: '148px' } });
            if (expIn) expIn.addEventListener('input', () => {
                ln.expiry = expIn.value;
                // a dated lot should carry a code — mint one if the user left it blank
                if (expIn.value && codeIn && !ln.batch) { ln.batch = genBatchCode(ln.item); codeIn.value = ln.batch; }
            });
            const expGroup = expIn ? h('div', { class: 'row', style: { gap: '5px', alignItems: 'center' } },
                h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } },
                    Icon('Clock', { size: 12 }), ' ' + prL('bxExpiry')),
                expIn) : null;

            // SUPPLIER_LINE_V1 — supplier is chosen PER LINE, right next to the product
            // (the same product can arrive from different suppliers at different prices).
            // Picking a supplier pre-fills the cost from that supplier's purchase price
            // (item_suppliers.last_price, set in the product editor); linked suppliers list first.
            const actSups = (state.suppliers || []).filter(s => s.active !== false);
            const linkedIds = new Set(state.itemSuppliers
                .filter(x => String(x.item_id) === String(ln.item.id)).map(x => String(x.supplier_id)));
            const supOrdered = [...actSups.filter(s => linkedIds.has(String(s.id))),
                                ...actSups.filter(s => !linkedIds.has(String(s.id)))];
            const supSel = supOrdered.length
                ? h('select', { title: prL('rcSupplier'), style: { ...inpStyle, width: '180px' } },
                    h('option', { value: '' }, prL('rcSupplierPh')),
                    ...supOrdered.map(s => h('option', { value: String(s.id) }, s.name)))
                : null;
            if (supSel) {
                supSel.value = ln.supplier || '';
                supSel.addEventListener('change', () => {
                    ln.supplier = supSel.value || '';
                    const link = ln.supplier ? supplierLinkOf(ln.item.id, ln.supplier) : null;
                    if (link && link.last_price != null) {
                        ln.cost = Number(link.last_price);
                        costIn.value = String(ln.cost);
                        recalcTotal();
                    }
                    paintLines();   // SUPPLIER_UNITS_V1 — rebuild unit options + conversion for this supplier
                });
            }
            // SUPPLIER_LINE_CREATE_V1 — small yellow (+): create a supplier for THIS
            // product on the spot (with its purchase price). Shown even when the
            // clinic has no suppliers yet (supSel absent).
            const supAdd = h('button', { class: 'btn btn-sm', type: 'button', title: 'Новый поставщик для этого товара',
                style: { width: '28px', height: '28px', padding: '0', display: 'grid', placeItems: 'center', flex: '0 0 auto',
                    background: '#fde68a', border: '1px solid #fbcf4a', color: '#7c5a00', fontWeight: 700, borderRadius: '8px' },
                onclick: () => openLineSupplierModal(ln) }, '+');
            const supGroup = h('div', { class: 'row', style: { gap: '5px', alignItems: 'center' } },
                h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, prL('rcSupplier')),
                supSel, supAdd);

            linesWrap.appendChild(h('div', {
                style: {
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
                    border: '1px solid var(--ink-100)', borderRadius: '10px', background: 'var(--white)', flexWrap: 'nowrap',
                },
            },
                // RECEIVE_MULTI_V1 / WIDE_RECEIVE_LINE_V1 — the row stays on ONE line;
                // only a long product NAME wraps inside its own cell (below), never the row.
                h('div', { style: { minWidth: '140px', flex: 1 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '13.5px', whiteSpace: 'normal', overflowWrap: 'anywhere' } },
                        ln.item.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'normal', overflowWrap: 'anywhere' } },
                        [ln.item.strength, ln.item.form, baseUnitOf(ln.item)].filter(Boolean).join(' · ') || '—'),
                    convHint),
                supGroup,   // SUPPLIER_LINE_V1 — supplier right next to the product
                codeGroup, expGroup,   // BATCH_CODE_GEN_V1 code, then PRODUCT_EXPIRY_V2 expiry
                qtyIn, unitSel, costIn,
                h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: prL('biRemove'),
                    onclick: () => { lines.splice(idx, 1); paintLines(); } }, '×'),
            ));
        });
        recalcTotal();
    }

    // ---- product search (catalog) + inline create ----
    const prodWrap = h('div', { style: { position: 'relative', flex: 1 } });
    const prodInp = h('input', { type: 'text', placeholder: prL('rcProdSearch'), style: inpStyle });
    const prodSuggest = h('div', {
        style: {
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
            background: 'white', border: '1px solid var(--ink-200)', borderRadius: '10px',
            boxShadow: '0 10px 30px rgba(15,23,42,0.14)', maxHeight: '220px', overflow: 'auto', display: 'none',
        },
    });
    prodWrap.appendChild(prodInp); prodWrap.appendChild(prodSuggest);
    function paintProdSuggestions() {
        const q = prodInp.value.trim().toLowerCase();
        clear(prodSuggest);
        if (!q) { prodSuggest.style.display = 'none'; return; }
        // SUPPLIER_LINE_V1 — already-added products stay in the list: the same product
        // may be received again on another line from a different supplier.
        const hits = state.items
            .filter(i => itemLabel(i).toLowerCase().includes(q))
            .slice(0, 8);
        if (!hits.length) {
            prodSuggest.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } }, prL('biNothing')));
        } else {
            for (const it of hits) {
                prodSuggest.appendChild(h('button', {
                    type: 'button',
                    style: {
                        display: 'block', width: '100%', padding: '9px 12px', border: 'none', background: 'transparent',
                        cursor: 'pointer', fontSize: '13.5px', color: 'var(--ink-800)', fontFamily: 'inherit',
                        textAlign: 'left', whiteSpace: 'normal', overflowWrap: 'anywhere',
                    },
                    onmousedown: (e) => e.preventDefault(),
                    onclick: () => { addLine(it); prodInp.value = ''; prodSuggest.style.display = 'none'; prodInp.focus(); },
                }, itemLabel(it)));
            }
        }
        prodSuggest.style.display = 'block';
    }
    prodInp.addEventListener('input', paintProdSuggestions);
    prodInp.addEventListener('focus', paintProdSuggestions);
    prodInp.addEventListener('blur', () => setTimeout(() => { prodSuggest.style.display = 'none'; }, 150));

    const createBtn = h('button', {
        class: 'btn btn-outline btn-sm', type: 'button', style: { flex: '0 0 auto', whiteSpace: 'nowrap' },
        onclick: () => openProductModal(null, {
            onSaved: (newId) => {
                const it = state.items.find(i => String(i.id) === String(newId));
                if (it) addLine(it);
            },
        }),
    }, Icon('Plus', { size: 13 }), prL('rcCreate'));

    const noteInput = h('input', { type: 'text', placeholder: prL('rcNotePh'), style: inpStyle });
    // SUPPLIER_LINE_V1 — the supplier moved onto each product line (see paintLines);
    // the single whole-delivery supplier field is gone.

    paintLines();

    // RECEIVE_TIDY_V1 — search sits AT THE TOP (prominent, icon inside, pill-shaped);
    // lines grow under it; Note field removed (movements just carry no note). No
    // forced min-height, so the dialog hugs its content instead of leaving a gap.
    Object.assign(prodInp.style, {
        height: '42px', padding: '0 14px 0 40px', borderRadius: '999px',
        border: '1px solid var(--ink-200)', fontSize: '13.5px',
        boxShadow: '0 1px 2px rgba(15,23,42,0.05)',
    });
    prodWrap.appendChild(h('span', {
        style: { position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)',
            color: 'var(--ink-400, #94a3b8)', pointerEvents: 'none', display: 'inline-flex' },
    }, Icon('Search', { size: 15 })));
    const body = h('form', { class: 'modal-body' },
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, prodWrap, createBtn),
        h('div', { class: 'field', style: { marginTop: '2px' } }, h('label', null, prL('rcItems')), linesWrap),
        h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px', fontSize: '13.5px', marginTop: '2px' } },
            h('span', { class: 'muted' }, prL('rcTotal')), totalEl, h('span', { class: 'muted' }, 'UZS')),
    );

    // BATCH_LABELS_V1 — print one 58×40mm sticker per line that has a batch code
    // (same layout + Code128 barcode as the lab labels), ALL in one print job.
    function printBatchLabels() {
        const withCode = lines.filter(l => (l.batch || '').trim());
        if (!withCode.length) { toast(prL('rcNoLabels'), 'info'); return; }
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const fmtD = (iso) => { if (!iso) return ''; const p = String(iso).split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso; };
        const cards = withCode.map(l => {
            const code = l.batch.trim();
            const supName = l.supplier ? ((state.suppliers.find(s => String(s.id) === String(l.supplier)) || {}).name || '') : '';
            return `<div class="lbl">
              <div class="top"><span class="acc">№ ${esc(code)}</span><span class="date">${esc(fmtD(l.expiry))}</span></div>
              <div class="name" title="${esc(l.item.name || '')}">${esc(l.item.name || '')}</div>
              ${supName ? `<div class="mrn">${esc(supName)}</div>` : ''}
              <div class="bc">${barcodeSVG(code, { height: 48, moduleW: 1.4 })}</div>
              <div class="bcnum">${esc(code)}</div>
            </div>`;
        }).join('');
        /* type-scale-exempt-start: печатный документ — семейство Onest, размеры остаются его выверенными метриками (дизайн-док 2026-08-31) */
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Batch labels</title><style>
${PRINT_FONT_FACE_CSS}
          @page { size: 58mm 40mm; margin: 0; }
          * { box-sizing: border-box; }
          html,body { margin:0; padding:0; background:#fff; }
          .lbl { width:58mm; height:40mm; padding:1.5mm 2.5mm; overflow:hidden;
                 display:flex; flex-direction:column; justify-content:space-between;
                 page-break-after:always; font-family:'Onest',Arial,Helvetica,sans-serif; color:#000; }
          .top { display:flex; justify-content:space-between; align-items:baseline; gap:4px; }
          .acc { font-size:11pt; font-weight:700; }
          .date { font-size:8pt; }
          .name { font-size:10pt; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .mrn { font-size:8pt; margin-top:-1mm; }
          .bc { text-align:center; line-height:0; }
          .bc svg { width:100%; height:auto; max-height:17mm; }
          .bcnum { text-align:center; font-size:8pt; letter-spacing:2px; margin-top:0.3mm; }
        </style></head><body>${cards}
        <script>window.onload=function(){(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){try{window.focus();window.print();}catch(e){}setTimeout(function(){window.close();},400);});};<\/script>
        </body></html>`;
        /* type-scale-exempt-end */
        const win = window.open('', '_blank', 'width=460,height=380');
        if (!win) { toast('Разрешите всплывающие окна, чтобы печатать этикетки.', 'fail'); return; }
        win.document.write(html);
        win.document.close();
    }

    openModal({
        title: prL('rcTitle'),
        subtitle: prL('rcSub'),
        width: '1420px',   // WIDE_RECEIVE_LINE_V1 / SUPPLIER_LINE_V1 — supplier + batch + expiry + qty + unit + cost on one line
        body,
        footerButtons: (close) => [
            h('button', { class: 'btn btn-outline', type: 'button', onclick: printBatchLabels },
                Icon('Print', { size: 14 }), prL('rcPrintLabels')),   // BATCH_LABELS_V1
            h('button', { class: 'btn', type: 'button', onclick: close }, prL('cancel')),
            h('button', {
                class: 'btn btn-primary', type: 'button',
                onclick: async (e) => {
                    if (!recvBranch) { toast(prL('biNoBranches'), 'fail'); return; }
                    const valid = lines.filter(l => Number(l.qty) > 0);
                    if (!valid.length) { toast(prL('rcErrLines'), 'fail'); return; }
                    e.target.disabled = true;
                    try {
                        // PRODUCT_EXPIRY_V2 — an expiry entered on the line (or a product
                        // already tracked) is stored as a dated lot. Turn on batch/expiry
                        // tracking for the product FIRST (so the batch trigger maintains
                        // batch_stock + FEFO on the receipt), then resolve the lot.
                        const rows = [];
                        for (const l of valid) {
                            let batchId = null;
                            const lnSupplier = l.supplier || null;   // SUPPLIER_LINE_V1 — per-line supplier
                            if (state.batchOk !== false && (l.expiry || l.batch || l.item.track_batches || lnSupplier)) {
                                if (!l.item.track_batches) {
                                    const { error: tErr } = await supabase.from('clinic_items')
                                        .update({ track_batches: true }).eq('id', l.item.id);
                                    if (tErr) throw tErr;
                                    l.item.track_batches = true;
                                }
                                // SUPPLIER_STOCK_V1 — a supplier makes each delivery its own lot;
                                // mint a code if none so two suppliers never merge into one batch.
                                let bn = (l.batch || '').trim() || null;
                                let bId, bErr;
                                if (lnSupplier) {
                                    if (!bn) { bn = genBatchCode(l.item); l.batch = bn; }
                                    ({ data: bId, error: bErr } = await supabase.rpc('get_or_create_batch_v2', {
                                        p_item: l.item.id, p_batch_number: bn, p_expiry: l.expiry || null, p_supplier: lnSupplier }));
                                } else {
                                    ({ data: bId, error: bErr } = await supabase.rpc('get_or_create_batch', {
                                        p_item: l.item.id, p_batch_number: bn, p_expiry: l.expiry || null }));
                                }
                                if (bErr) throw bErr;
                                batchId = bId;
                            }
                            rows.push({
                                company_id: currentClinicId(),
                                item_id: l.item.id,
                                branch_id: recvBranch.id,
                                kind: 'receipt',
                                // UNIT_ENGINE_V1 — qty converted to base units, and the
                                // cost with it: a price per pack is not a price per tablet.
                                qty: (Number(l.qty) || 0) * lineFactor(l),   // signed: + adds (SUPPLIER_PACK_V1 — supplier pack size)
                                unit_cost: l.cost === '' || l.cost == null
                                    ? null
                                    : Number(l.cost) / lineFactor(l),
                                reference_type: 'manual',
                                batch_id: batchId,   // BATCH_FEFO_V1
                                note: noteInput.value.trim() || null,
                                created_by: currentUserId(),        // STOCK_LOG_V1 — who received
                            });
                        }
                        const { error } = await supabase.from('stock_movements').insert(rows);
                        if (error) throw error;
                        toast(prL('rcOk') + valid.length + '.', 'ok');
                        close();
                        await loadStock();
                        paintStockTable();
                    } catch (err) {
                        toast(err.message || String(err), 'fail');
                    } finally { e.target.disabled = false; }
                },
            }, prL('rcReceive')),
        ],
    });
    setTimeout(() => prodInp.focus(), 0);
}

function openAdjustModal() {
    if (!state.items.length) { toast('Add items to the catalog first.', 'info'); return; }
    if (!state.branches.length) { toast('No branches found for this clinic.', 'info'); return; }

    const itemSel   = selectEl(state.items.map(i => ({ id: i.id, label: itemLabel(i) })), { placeholder: 'Select product…', required: true });
    const branchSel = selectEl(state.branches.map(b => ({ id: b.id, label: b.name })), { value: state.stockBranch !== 'all' ? state.stockBranch : '', placeholder: 'Select branch…', required: true });
    const qtyInput  = h('input', { type: 'number', step: 'any', placeholder: 'Signed, e.g. -5 for wastage', required: true });
    const noteInput = h('input', { type: 'text', placeholder: 'Required — reason for adjustment' });

    const body = h('form', { class: 'modal-body' },
        h('p', { class: 'muted', style: { gridColumn: '1 / -1', margin: '0 0 4px', fontSize: '12.5px' } },
            'Enter a signed quantity: positive adds, negative removes (wastage, correction).'),
        fieldRow('Product *', itemSel),
        fieldRow('Branch *', branchSel),
        fieldRow('Quantity (signed) *', qtyInput),
        fieldRow('Note *', noteInput),
    );

    openModal({
        title: 'Adjust stock',
        subtitle: 'Records a signed adjustment movement.',
        width: '720px',   // ADJUST_STOCK_WIDE_V1 — the default card was cramped (fields squeezed + horizontal scroll)
        body,
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
            h('button', {
                class: 'btn btn-primary', type: 'button',
                onclick: async (e) => {
                    const itemId = itemSel.value;
                    const branchId = branchSel.value;
                    const qtyRaw = qtyInput.value;
                    const qty = Number(qtyRaw);
                    const note = noteInput.value.trim();
                    if (!itemId)   { toast('Pick a product.', 'fail'); return; }
                    if (!branchId) { toast('Pick a branch.', 'fail'); return; }
                    if (qtyRaw === '' || !isFinite(qty) || qty === 0) { toast('Enter a non-zero quantity.', 'fail'); qtyInput.focus(); return; }
                    if (!note) { toast('A note is required for adjustments.', 'fail'); noteInput.focus(); return; }
                    e.target.disabled = true;
                    try {
                        const { error } = await supabase.from('stock_movements').insert({
                            company_id: currentClinicId(),
                            item_id: itemId,
                            branch_id: branchId,
                            kind: 'adjustment',
                            qty: qty,                       // signed value as entered
                            reference_type: 'manual',
                            note: note,
                            created_by: currentUserId(),    // STOCK_LOG_V1 — who adjusted
                        });
                        if (error) throw error;
                        toast('Stock adjusted by ' + fmtNum(qty) + '.', 'ok');
                        close();
                        await loadStock();
                        paintStockTable();
                    } catch (err) {
                        toast(err.message || String(err), 'fail');
                    } finally { e.target.disabled = false; }
                },
            }, 'Save adjustment'),
        ],
    });
    setTimeout(() => itemSel.focus(), 0);
}

// ============================================================================
// PRODUCTS tab — PROCUREMENT_PRODUCTS_V1
// The catalog entry point: add/edit products (clinic_items) and connect each
// product to its suppliers. Purchase orders then start from these links.
// ============================================================================
// PRODUCT_BULK_DELETE_V1 — ticked product ids on the Products tab.
const prodSel = new Set();

function prProducts() {
    prodSel.clear();
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });
    const tableWrap = h('div');

    wrap.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Pill', { size: 16 }), prL('productsHdr'), h('span', { class: 'h-count' }, String(state.items.length))),
            h('div', { class: 'row', style: { gap: '6px' } },
                // PROCUREMENT_IMPORT_V1 — Excel import shaped after the legacy
                // warehouse export (КОД/Товар/Категория/Остаток/Себестоимость/Цена/ИКПУ).
                h('button', { class: 'btn btn-ghost btn-sm', onclick: () => downloadSectionSample('procurement_items') },
                    Icon('Download', { size: 14 }), prL('sampleFile')),
                h('button', {
                    class: 'btn btn-sm',
                    onclick: () => openSectionImporter({
                        sectionKey: 'procurement_items',
                        onImported: async () => {
                            await reloadCommon();
                            if (state.tab === 'stock') { await loadStock(); paintStockTable(); }
                            renderBody();
                        },
                    }),
                }, Icon('ArrowUp', { size: 14 }), prL('importExcel')),
                h('button', { class: 'btn btn-primary btn-sm', onclick: () => openProductModal(null) }, Icon('Plus', { size: 14 }), prL('addProduct')),
            ),
        ),
        !state.itemSuppliersOk ? h('div', {
            style: { margin: '10px 14px 0', padding: '8px 12px', background: 'var(--warn-50)', border: '1px solid #fde9b6', borderRadius: '8px', fontSize: '12.5px', color: 'var(--warn-700)' },
        }, 'Supplier links are disabled — apply migration 062_item_suppliers.sql to enable connecting products to suppliers.') : null,
        tableWrap,
    ));

    paintProductsInto(tableWrap);
    return wrap;
}

let productsTableWrapRef = null;
function paintProductsInto(tableWrap) {
    productsTableWrapRef = tableWrap;
    paintProductsTable();
}
function paintProductsTable() {
    const tableWrap = productsTableWrapRef;
    if (!tableWrap) return;
    clear(tableWrap);

    const supName = Object.fromEntries(state.suppliers.map(s => [s.id, s.name]));
    const pq = (prodFilter.q || '').trim().toLowerCase();   // PROC_FILTERS_V1
    const pItems = state.items.filter(p => {
        if (pq && !((p.name || '').toLowerCase().includes(pq) || (p.code || '').toLowerCase().includes(pq))) return false;
        if (prodFilter.cat !== 'all' && (p.procurement_category || (p.is_drug ? 'medicines' : '')) !== prodFilter.cat) return false;
        if (prodFilter.status !== 'all' && ((p.active !== false) !== (prodFilter.status === 'active'))) return false;
        if (prodFilter.sup !== 'all' && !suppliersOfItem(p.id).map(String).includes(String(prodFilter.sup))) return false;
        return true;
    });
    // PRODUCT_BULK_DELETE_V1 — tick rows (or tick-all) → red bulk-delete bar.
    const selectable = state.delOk !== false;
    const visIds = pItems.map(p => String(p.id));
    const selVis = visIds.filter(id => prodSel.has(id));
    if (selectable && selVis.length) {
        tableWrap.appendChild(h('div', { class: 'row', style: {
            gap: '10px', alignItems: 'center', padding: '8px 12px', margin: '10px 12px 0',
            background: 'var(--crit-50, #fef2f2)', border: '1px solid #fecaca', borderRadius: '9px' } },
            h('span', { style: { fontSize: '12.5px', fontWeight: 600 } }, trf('Выбрано товаров: {n}', { n: selVis.length })),
            h('div', { style: { flex: 1 } }),
            h('button', {
                class: 'btn btn-sm', type: 'button',
                style: { background: 'var(--crit-600, #dc2626)', borderColor: 'var(--crit-600, #dc2626)', color: '#fff' },
                onclick: () => confirmDeleteProducts(pItems.filter(p => prodSel.has(String(p.id)))),
            }, Icon('Trash', { size: 13 }), ' ', trf('Удалить выбранные ({n})', { n: selVis.length })),
        ));
    }
    const masterCb = selectable ? (() => {
        const cb = h('input', { type: 'checkbox', title: 'Выбрать все' });
        cb.checked = visIds.length > 0 && selVis.length === visIds.length;
        cb.addEventListener('change', () => {
            if (cb.checked) visIds.forEach(id => prodSel.add(id));
            else visIds.forEach(id => prodSel.delete(id));
            paintProductsTable();
        });
        return cb;
    })() : null;
    const tbody = h('tbody', null,
        ...(pItems.length
            ? pItems.flatMap(p => {
                // PROD_SUPPLIER_SPLIT_V1 — one row per linked supplier; «—» when none.
                // SUPPLIER_ROW_PRICE_V1 — each row prices from ITS supplier link
                // (item_suppliers.last_price); catalog price only as fallback.
                let links = state.itemSuppliers.filter(l => String(l.item_id) === String(p.id) && supName[l.supplier_id]);
                if (prodFilter.sup !== 'all') links = links.filter(l => String(l.supplier_id) === String(prodFilter.sup));
                const rowsFor = links.length ? links : [null];
                return rowsFor.map(lnk => h('tr', { style: p.active === false ? { opacity: '0.55' } : {} },
                    // PRODUCT_BULK_DELETE_V1 — tick cell (same product ticks on all its supplier rows).
                    ...(selectable ? [(() => {
                        const cb = h('input', { type: 'checkbox' });
                        cb.checked = prodSel.has(String(p.id));
                        cb.addEventListener('change', () => {
                            if (cb.checked) prodSel.add(String(p.id)); else prodSel.delete(String(p.id));
                            paintProductsTable();
                        });
                        return h('td', { style: { textAlign: 'center', width: '34px' } }, cb);
                    })()] : []),
                    h('td', { class: 'cell-strong' }, p.name || '—'),   // PROD_NO_SKU_V1 — КОД column dropped
                    h('td', { class: 'muted', style: { fontSize: '12.5px' } }, catLabel(p.procurement_category) || (p.is_drug ? catLabel('medicines') : '—')),
                    h('td', { class: 'muted' }, p.unit || '—'),
                    h('td', { class: 'num' }, (lnk && lnk.last_price != null) ? fmtMoney(Number(lnk.last_price))
                        : (p.price != null ? fmtMoney(Number(p.price)) : '—')),
                    h('td', { style: { fontSize: '12.5px' } },
                        lnk ? h('span', { class: 'tag' }, supName[lnk.supplier_id]) : h('span', { class: 'muted' }, '—')),
                    h('td', null, p.active === false
                        ? h('span', { class: 'tag' }, 'Inactive')
                        : h('span', { class: 'tag tag-ok' }, 'Active')),
                    h('td', null, h('div', { class: 'row', style: { gap: '4px' } },
                        h('button', { class: 'btn btn-ghost btn-sm', style: { height: '26px', padding: '0 8px', fontSize: '12.5px' }, onclick: () => openProductModal(p) }, Icon('Edit', { size: 12 }), ' Edit'),
                        // PRODUCT_DELETE_V1 — soft-delete (history preserved); hidden until mig 136.
                        state.delOk !== false ? h('button', {
                            class: 'btn btn-ghost btn-sm',
                            style: { height: '26px', padding: '0 8px', fontSize: '12.5px', color: 'var(--crit-700, #b91c1c)' },
                            onclick: () => confirmDeleteProduct(p),
                        }, Icon('Trash', { size: 12 }), ' Удалить') : null,
                    )),
                ));
            })
            : [emptyRow(8, 'No products yet. Add one to start — then connect suppliers and create purchase orders.')]),
    );

    const lang = (typeof getLang === 'function' && getLang()) || 'en';
    tableWrap.appendChild(h('table', { class: 'tbl' },
        h('thead', null,
            h('tr', null,
                ...(selectable ? [h('th', { style: { width: '34px', textAlign: 'center' } }, masterCb)] : []),
                h('th', null, 'Product'),
                h('th', null, lang === 'ru' ? 'Категория' : lang === 'uz' ? 'Kategoriya' : 'Category'),
                h('th', null, 'Unit'),
                h('th', null, 'Price'), h('th', null, 'Suppliers'),   // PRICE_COL_ALIGN_V1 — header left, same as its values
                h('th', null, 'Status'), h('th', { style: { width: '90px' } }, 'Actions')),
            procFilterRow([   // PROC_FILTER_ROW_V1
                ...(selectable ? [null] : []),   // PRODUCT_BULK_DELETE_V1 — tick column
                { type: 'search', key: 'pr.q', get: () => prodFilter.q, set: (v) => { prodFilter.q = v; }, placeholder: prL('fltSearch') },
                { options: [{ value: 'all', label: prL('fltAllCats') }, ...PRODUCT_CATEGORIES.map(c => ({ value: c.key, label: catLabel(c.key) }))], get: () => prodFilter.cat, set: (v) => { prodFilter.cat = v; } },
                null, null,
                { options: [{ value: 'all', label: prL('fltAllSups') }, ...state.suppliers.filter(s => s.active !== false).map(s => ({ value: s.id, label: s.name }))], get: () => prodFilter.sup, set: (v) => { prodFilter.sup = v; } },
                { options: [{ value: 'all', label: prL('fltAllStatus') }, { value: 'active', label: prL('fltActive') }, { value: 'inactive', label: prL('fltInactive') }], get: () => prodFilter.status, set: (v) => { prodFilter.status = v; } },
                null,
            ], paintProductsTable)),
        tbody,
    ));
}

// PRODUCT_BULK_DELETE_V1 — soft-delete several products at once; history preserved.
function confirmDeleteProducts(items) {
    if (!items || !items.length) return;
    const names = items.slice(0, 3).map(p => p.name).filter(Boolean).join(', ') + (items.length > 3 ? '…' : '');
    openModal({
        title: trf('Удалить товары ({n})?', { n: items.length }),
        subtitle: names,
        width: '500px',
        body: h('div', { class: 'modal-body' },
            h('p', { style: { margin: 0, fontSize: '13.5px', lineHeight: 1.5 } },
                'Выбранные товары исчезнут из каталога, поиска и приёмки. ',
                h('b', null, 'История закупок сохранится'),
                ' — движения по складу, партии и заказы останутся в отчётах и журнале.')),
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('button', {
                class: 'btn', type: 'button',
                style: { background: 'var(--crit-600, #dc2626)', borderColor: 'var(--crit-600, #dc2626)', color: '#fff' },
                onclick: async (e) => {
                    e.target.disabled = true;
                    try {
                        const { error } = await supabase.from('clinic_items')
                            .update({ deleted_at: new Date().toISOString(), active: false })
                            .in('id', items.map(p => p.id)).eq('company_id', currentClinicId());
                        if (error) throw error;
                        prodSel.clear();
                        toast(trf('Удалено товаров: {n}. История закупок сохранена.', { n: items.length }), 'ok');
                        close();
                        await reloadCommon();
                        renderBody();
                    } catch (err) {
                        toast(err.message || String(err), 'fail');
                        e.target.disabled = false;
                    }
                },
            }, Icon('Trash', { size: 13 }), ' ', trf('Удалить ({n})', { n: items.length })),
        ],
    });
}

function openProductModal(product, opts = {}) {   // RECEIVE_MULTI_V1 — opts.onSaved(itemId)
    const editing = !!product;
    const nameInput  = h('input', { type: 'text', placeholder: 'e.g. Перчатки нитриловые M', required: true, value: product?.name || '' });
    const codeInput  = h('input', { type: 'text', placeholder: 'Optional SKU / code', value: product?.code || '' });
    const unitInput  = h('input', { type: 'text', placeholder: 'шт / уп / мл…', value: product?.unit || 'шт' });
    const priceInput = h('input', { type: 'number', min: '0', step: 'any', placeholder: '0', value: product?.price ?? '' });
    // Category dropdown (fixed keys, labels follow the active UI language).
    // Falls back to the legacy is_drug flag when migration 063 isn't applied.
    const lang = (typeof getLang === 'function' && getLang()) || 'en';
    const catPlaceholder = lang === 'ru' ? 'Выберите категорию…' : lang === 'uz' ? 'Kategoriyani tanlang…' : 'Select category…';
    const categorySel = selectEl(
        PRODUCT_CATEGORIES.map(c => ({ id: c.key, label: c[lang] || c.en })),
        { value: product?.procurement_category || (product?.is_drug ? 'medicines' : ''), placeholder: catPlaceholder, style: { width: '100%' } },
    );
    const activeInput = h('input', { type: 'checkbox' });
    activeInput.checked = product ? product.active !== false : true;

    // ---- supplier links: rows (supplier + purchase price) + type-to-search picker ----
    // Pre-select the product's current links; new products start empty.
    const selected = new Set(editing ? suppliersOfItem(product.id) : []);
    // SUPPLIER_PRICE_V1 — per-supplier PURCHASE price (item_suppliers.last_price),
    // separate from the selling «Цена». supplier_id -> price.
    const supplierPrice = new Map();
    // SUPPLIER_PACK_V1 — per-supplier pack size (units in one purchase unit).
    const supplierPack = new Map();
    // SUPPLIER_UNITS_V1 — this supplier's own purchase unit for the product.
    const supplierUnit = new Map();
    if (editing) {
        for (const l of state.itemSuppliers.filter(l => l.item_id === product.id)) {
            if (l.last_price != null) supplierPrice.set(l.supplier_id, Number(l.last_price));
            if (l.pack_factor != null && Number(l.pack_factor) > 0) supplierPack.set(l.supplier_id, Number(l.pack_factor));
            if (l.purchase_unit) supplierUnit.set(l.supplier_id, String(l.purchase_unit));
        }
    }
    const inpStyle = {
        height: '34px', padding: '0 10px', border: '1px solid #d1d5db',
        borderRadius: '8px', fontSize: '13.5px', background: 'white',
        fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
    };

    // SUPPLIER_PRICE_V1 — one ROW per linked supplier: name + its purchase price + unlink.
    const chipsEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    function paintChips() {
        clear(chipsEl);
        if (!selected.size) {
            chipsEl.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px', lineHeight: '28px' } },
                'Поставщики не привязаны — найдите ниже или создайте нового.'));
            return;
        }
        for (const sid of selected) {
            const s = state.suppliers.find(x => x.id === sid);
            if (!s) continue;
            const priceIn = h('input', {
                type: 'number', min: '0', step: 'any', placeholder: 'цена',
                value: supplierPrice.has(sid) ? String(supplierPrice.get(sid)) : '',
                style: { ...inpStyle, width: '120px', height: '30px', textAlign: 'right' },
            });
            priceIn.addEventListener('input', () => {
                if (priceIn.value === '') supplierPrice.delete(sid);
                else supplierPrice.set(sid, Number(priceIn.value));
            });
            chipsEl.appendChild(h('div', {
                class: 'row',
                style: {
                    gap: '8px', alignItems: 'center', padding: '5px 8px 5px 12px',
                    borderRadius: '9px', background: 'var(--primary-50)', border: '1px solid var(--primary-200)',
                },
            },
                h('span', { style: { flex: 1, minWidth: 0, fontSize: '13.5px', fontWeight: 600, color: 'var(--primary-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name),
                h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, 'Цена закупки'),
                priceIn,
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'сум'),
                // SUPPLIER_PACK_V1 — this supplier's pack size: «1 уп = [N] шт».
                ...(state.supPackOk !== false ? (() => {
                    const packIn = h('input', {
                        type: 'number', min: '0.0001', step: 'any',
                        placeholder: String(numOr1(packFactIn.value)),
                        value: supplierPack.has(sid) ? String(supplierPack.get(sid)) : '',
                        title: trf('Сколько {base} в одной {pack} у этого поставщика (пусто = как у товара)', { base: baseUnitIn.value.trim() || tr('шт'), pack: purchUnitIn.value.trim() || tr('уп') }),
                        style: { ...inpStyle, width: '76px', height: '30px', textAlign: 'right' },
                    });
                    packIn.addEventListener('input', () => {
                        if (packIn.value === '' || !(Number(packIn.value) > 0)) supplierPack.delete(sid);
                        else supplierPack.set(sid, Number(packIn.value));
                    });
                    // SUPPLIER_UNITS_V1 — the purchase unit is chosen PER SUPPLIER too.
                    const curU = supplierUnit.get(sid) || purchUnitIn.value.trim() || 'уп';
                    const unitSelS = selectEl(unitCatalogOptions(curU), { value: curU,
                        style: { ...inpStyle, width: '150px', height: '30px' } });
                    unitSelS.addEventListener('change', () => {
                        if (unitSelS.value) supplierUnit.set(sid, unitSelS.value); else supplierUnit.delete(sid);
                    });
                    return [
                        h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, '· 1'),
                        unitSelS,
                        h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '='),
                        packIn,
                        h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } },
                            baseUnitIn.value.trim() || 'шт'),
                    ];
                })() : []),
                h('button', {
                    type: 'button', title: 'Отвязать',
                    style: {
                        width: '20px', height: '20px', border: 'none', borderRadius: '50%',
                        background: 'var(--primary-100, #d3ece9)', color: 'var(--primary-700)',
                        cursor: 'pointer', fontSize: '13.5px', lineHeight: '1', padding: 0,
                        display: 'grid', placeItems: 'center', flex: '0 0 auto',
                    },
                    onclick: () => { selected.delete(sid); supplierPrice.delete(sid); paintChips(); },
                }, '×'),
            ));
        }
    }
    // EDITOR_TDZ_FIX_V1 — do NOT paint here: paintChips reads packFactIn /
    // baseUnitIn / purchUnitIn (SUPPLIER_PACK_V1 row), which are const-declared
    // further down. Painting this early threw a ReferenceError for any product
    // WITH a linked supplier, so «Редактировать» silently did nothing. The
    // initial paint now happens after the units inputs exist (see below).

    // Search box with a suggestion dropdown — replaces the full checklist so
    // long supplier lists stay manageable.
    const searchWrap = h('div', { style: { position: 'relative' } });
    const searchInp  = h('input', {
        type: 'text', placeholder: 'Поиск поставщика по названию или телефону…',
        style: { ...inpStyle, width: '100%' },
    });
    const suggestEl = h('div', {
        style: {
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20,
            background: 'white', border: '1px solid var(--ink-200)', borderRadius: '10px',
            boxShadow: '0 10px 30px rgba(15,23,42,0.14)', maxHeight: '200px', overflow: 'auto',
            display: 'none',
        },
    });
    searchWrap.appendChild(searchInp);
    searchWrap.appendChild(suggestEl);

    function paintSuggestions() {
        const q = searchInp.value.trim().toLowerCase();
        clear(suggestEl);
        if (!q) { suggestEl.style.display = 'none'; return; }
        const hits = state.suppliers.filter(s => s.active !== false
            && !selected.has(s.id)
            && ((s.name || '').toLowerCase().includes(q) || (s.phone || '').toLowerCase().includes(q)))
            .slice(0, 8);
        if (!hits.length) {
            suggestEl.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } },
                'Ничего не найдено — создайте нового поставщика ниже.'));
        } else {
            for (const s of hits) {
                suggestEl.appendChild(h('button', {
                    type: 'button',
                    style: {
                        display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
                        padding: '9px 12px', border: 'none', background: 'transparent',
                        cursor: 'pointer', fontSize: '13.5px', color: 'var(--ink-800)',
                        fontFamily: 'inherit', textAlign: 'left',
                    },
                    onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-50)'; },
                    onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
                    onclick: () => {
                        selected.add(s.id);
                        searchInp.value = '';
                        suggestEl.style.display = 'none';
                        paintChips();
                    },
                },
                    h('span', { style: { fontWeight: 600 } }, s.name),
                    s.phone ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, s.phone) : null,
                ));
            }
        }
        suggestEl.style.display = 'block';
    }
    searchInp.addEventListener('input', paintSuggestions);
    searchInp.addEventListener('focus', paintSuggestions);
    searchInp.addEventListener('blur', () => setTimeout(() => { suggestEl.style.display = 'none'; }, 150));

    // Inline quick supplier creation — styled like every other modal input.
    const quickName    = h('input', { type: 'text', placeholder: 'Название компании *', style: { ...inpStyle, minWidth: 0 } });
    const quickManager = h('input', { type: 'text', placeholder: 'Менеджер (контактное лицо)', style: { ...inpStyle, minWidth: 0 } });
    const quickPhone   = styledPhoneInput('Телефон *', inpStyle);
    const quickEmail   = h('input', { type: 'email', placeholder: 'Email', style: { ...inpStyle, minWidth: 0 } });
    // SUPPLIER_QUICK_POPUP_V1 — creation moved into a popup so the four inline
    // fields no longer sit in the product form looking like a required section.
    function openQuickSupplierModal() {
        openModal({
            title: 'Новый поставщик',
            subtitle: 'Создаётся и сразу привязывается к этому товару.',
            width: '460px',
            zIndex: '220',   // above the product modal (default 160)
            body: h('div', { class: 'modal-body' },
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                    quickName, quickManager, quickPhone, quickEmail)),
            footerButtons: (close) => [
                h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
                h('button', {
                    class: 'btn btn-primary', type: 'button',
                    onclick: async (e) => {
                        const nm = quickName.value.trim();
                        if (!nm) { toast('Введите название поставщика.', 'fail'); quickName.focus(); return; }
                        if (!quickPhone.value.trim()) { toast('Укажите телефон поставщика.', 'fail'); quickPhone.focus(); return; }   // SUPPLIER_PHONE_REQ_V1
                        e.target.disabled = true;
                        try {
                            const { data, error } = await supabase.from('suppliers')
                                .insert({
                                    company_id: currentClinicId(), name: nm,
                                    contact_name: quickManager.value.trim() || null,
                                    phone: quickPhone.value.trim() || null,
                                    email: quickEmail.value.trim() || null,
                                    active: true,
                                })
                                .select('id, name, contact_name, phone, email, notes, active').single();
                            if (error) throw error;
                            state.suppliers.push(data);
                            state.suppliers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
                            selected.add(data.id);   // auto-link the new supplier to this product
                            quickName.value = ''; quickManager.value = ''; quickPhone.value = ''; quickEmail.value = '';
                            paintChips();
                            toast(trf('Поставщик «{name}» создан и привязан.', { name: data.name }), 'ok');
                            close();
                        } catch (err) {
                            toast(err.message || String(err), 'fail');
                            e.target.disabled = false;
                        }
                    },
                }, Icon('Plus', { size: 13 }), ' Создать'),
            ],
        });
        setTimeout(() => { try { quickName.focus(); } catch (e) {} }, 30);
    }
    const quickBtn = h('button', {
        class: 'btn btn-sm', type: 'button',
        style: { height: '34px', flex: '0 0 auto', background: '#fde68a', border: '1px solid #fbcf4a', color: '#7c5a00', fontWeight: 600 },
        onclick: openQuickSupplierModal,
    }, Icon('Plus', { size: 13 }), ' Новый поставщик');

    // ---- UNIT_ENGINE_V1 — three-tier units -------------------------------
    // Stock is always held in the base unit. Factors of 1 mean "no conversion",
    // which is what every product is seeded with, so this section is inert until
    // a manager deliberately declares packaging.
    const unitStyle = { ...inpStyle, width: '100%' };
    const baseVal  = product?.base_unit || product?.unit || 'шт';
    const purchVal = product?.purchase_unit || product?.unit || 'шт';
    const consVal  = product?.consumption_unit || product?.unit || 'шт';
    const baseUnitIn  = selectEl(unitCatalogOptions(baseVal),  { value: baseVal,  style: unitStyle });
    const purchUnitIn = selectEl(unitCatalogOptions(purchVal), { value: purchVal, style: unitStyle });
    const packFactIn  = h('input', { type: 'number', min: '0.0001', step: 'any', style: unitStyle,
        value: String(numOr1(product?.pack_factor)) });
    const consUnitIn  = selectEl(unitCatalogOptions(consVal),  { value: consVal,  style: unitStyle });
    const consFactIn  = h('input', { type: 'number', min: '0.0001', step: 'any', style: unitStyle,
        value: String(numOr1(product?.consumption_factor)) });
    const unitPreview = h('div', { class: 'muted', style: { fontSize: '12.5px' } });

    // UNITS_CLEAR_V1 — compact right-aligned factor inputs; the dispensing factor
    // defaults to 1 (a dispensing unit usually equals the base unit). The two unit
    // <select>s are narrowed so the equation rows read on one line.
    packFactIn.placeholder = '1'; consFactIn.placeholder = '1';
    if (!consFactIn.value || !(numOr1(consFactIn.value) > 0)) consFactIn.value = '1';
    Object.assign(packFactIn.style, { width: '84px', textAlign: 'right' });
    Object.assign(consFactIn.style, { width: '84px', textAlign: 'right' });
    Object.assign(purchUnitIn.style, { width: '160px', maxWidth: '48%' });
    Object.assign(consUnitIn.style,  { width: '160px', maxWidth: '48%' });
    Object.assign(baseUnitIn.style,  { width: '200px', maxWidth: '100%' });
    // Live base-unit name echoed at the tail of each equation ("= 250 [мл]").
    const _baseEcho = () => baseUnitIn.value.trim() || '—';
    const baseEchoP = h('span', { style: { fontSize: '13.5px', color: 'var(--ink-700)', whiteSpace: 'nowrap', fontWeight: 600 } }, _baseEcho());
    const baseEchoD = h('span', { style: { fontSize: '13.5px', color: 'var(--ink-700)', whiteSpace: 'nowrap', fontWeight: 600 } }, _baseEcho());

    function paintUnitPreview() {
        const b = _baseEcho();
        baseEchoP.textContent = b; baseEchoD.textContent = b;
        const parts = [];
        if (numOr1(packFactIn.value) !== 1 && purchUnitIn.value.trim())
            parts.push('1 ' + purchUnitIn.value.trim() + ' = ' + fmtNum(numOr1(packFactIn.value)) + ' ' + b);
        if (numOr1(consFactIn.value) !== 1 && consUnitIn.value.trim())
            parts.push('1 ' + consUnitIn.value.trim() + ' = ' + fmtNum(numOr1(consFactIn.value)) + ' ' + b);
        unitPreview.textContent = parts.length ? '✓  ' + parts.join('   ·   ') : prL('unHint');
    }
    [baseUnitIn, purchUnitIn, packFactIn, consUnitIn, consFactIn]
        .forEach(el => { el.addEventListener('input', paintUnitPreview); el.addEventListener('change', paintUnitPreview); });
    paintUnitPreview();

    // Suggestion parsed from the legacy unit string — offered, never auto-applied.
    const sugg = editing ? suggestUnitSplit(product) : null;
    const suggRow = sugg ? h('div', {
        class: 'row',
        style: { gap: '8px', alignItems: 'center', fontSize: '12.5px', flexWrap: 'wrap' },
    },
        h('span', { class: 'muted' },
            prL('unSuggest') + ' 1 ' + sugg.purchase + ' = ' + fmtNum(sugg.factor) + ' ' + sugg.base),
        h('button', {
            class: 'btn btn-outline btn-sm', type: 'button',
            onclick: () => {
                ensureSelectOption(baseUnitIn, sugg.base);
                ensureSelectOption(purchUnitIn, sugg.purchase);
                packFactIn.value = String(sugg.factor);
                paintUnitPreview();
            },
        }, prL('unApply')),
    ) : null;

    // PRODUCT_EXPIRY_V2 — the expiration date is entered PER DELIVERY in the Receive
    // dialog (stored as a dated lot), not on the product. No expiry field here.

    const unitsBlock = h('div', {
        style: {
            marginTop: '4px', padding: '12px 14px',
            background: 'var(--ink-25, #fafafa)', border: '1px solid var(--ink-100)',
            borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '10px',
        },
    },
        h('div', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-700)' } }, prL('unSection')),
        // BASE — the reference unit; everything converts to it (no factor of its own).
        h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' } },
            h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-900)' } }, prL('unBase')),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '4px' } }, prL('unStockedIn')),
                baseUnitIn)),
        // SUPPLIER_UNITS_V1 — the BUY conversion lives per supplier («Поставщики этого
        // товара» below); purchUnitIn/packFactIn stay DEFINED (unrendered) so stored
        // values round-trip. DISPENSE_UNIT_BACK_V1 — the dispensing setup returned per
        // owner request: «1 [unit] = [N] [base]», usually 1.
        h('div', { style: { height: '1px', background: 'var(--ink-100)' } }),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
            h('div', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-700)' } }, prL('unGiveHead')),
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '13.5px', color: 'var(--ink-900)' } },
                h('span', { style: { fontWeight: 700 } }, '1'), consUnitIn,
                h('span', { style: { fontWeight: 700 } }, '='), consFactIn),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, prL('unGiveHint'))),
    );

    paintChips();   // EDITOR_TDZ_FIX_V1 — first paint, now that the units inputs exist

    const body = h('form', { class: 'modal-body' },
        fieldRow('Name *', nameInput),
        // UNIT_FIELD_REMOVED_V1 — «Единица» dropped from the simple row (it's set via
        // the three-tier unit engine / defaults to «шт»); unitInput stays defined so
        // the save payload still carries a unit value.
        // PRICE_FIELD_REMOVED_V1 — «Price» dropped too: cost comes from the supplier
        // at receipt (avg_cost), not from the catalog. priceInput stays defined so an
        // existing product's stored price passes through the save payload unchanged.
        // PROD_NO_SKU_V1 — Code field hidden; an existing code round-trips via codeInput.
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', alignItems: 'end', margin: '4px 0 10px' } },
            fieldRow(lang === 'ru' ? 'Категория' : lang === 'uz' ? 'Kategoriya' : 'Category', categorySel),
            h('label', { class: 'row', style: { gap: '8px', cursor: 'pointer', fontSize: '13.5px', paddingBottom: '9px' } }, activeInput, 'Active'),
        ),
        state.unitsOk === false ? null : unitsBlock,
        state.itemSuppliersOk ? h('div', {
            style: {
                marginTop: '4px', padding: '12px 14px',
                background: 'var(--ink-25, #fafafa)', border: '1px solid var(--ink-100)',
                borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '10px',
            },
        },
            h('div', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-700)' } }, 'Поставщики этого товара'),
            chipsEl,
            searchWrap,
            // SUPPLIER_QUICK_POPUP_V1 — one yellow button; the form lives in a popup.
            h('div', { style: { borderTop: '1px dashed var(--ink-200)', paddingTop: '10px', display: 'flex', alignItems: 'center', gap: '10px' } },
                h('div', { class: 'muted', style: { fontSize: '12.5px', flex: 1 } }, 'Нет нужного поставщика в списке?'),
                quickBtn,
            ),
        ) : h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            'Supplier linking needs migration 062_item_suppliers.sql.'),
    );

    openModal({
        title: editing ? 'Edit product' : 'Add product',
        width: '900px',   // SUPPLIER_UNITS_V1 — wide enough for the full supplier row
        body,
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
            h('button', {
                class: 'btn btn-primary', type: 'button',
                onclick: async (e) => {
                    const name = nameInput.value.trim();
                    if (!name) { toast('Name is required.', 'fail'); nameInput.focus(); return; }
                    const catKey = categorySel.value || null;
                    const payload = {
                        name,
                        code:    codeInput.value.trim() || null,
                        unit:    unitInput.value.trim() || null,
                        // PRICE_DEFAULT_ZERO_V1 — clinic_items.price is NOT NULL in the DB, and the
                        // Price field is hidden (PRICE_FIELD_REMOVED_V1), so a NEW product must
                        // default to 0 or the insert dies with a not-null violation. Edits carry
                        // the stored price through the hidden input unchanged.
                        price:   priceInput.value === '' ? 0 : Number(priceInput.value),
                        is_drug: catKey === 'medicines',   // derived — pharmacy checks read is_drug
                        active:  activeInput.checked,
                    };
                    if (state.categoryOk) payload.procurement_category = catKey;
                    // UNIT_ENGINE_V1 — only written when migration 119 is applied.
                    if (state.unitsOk !== false) {
                        const pf = numOr1(packFactIn.value);
                        const cf = numOr1(consFactIn.value);
                        payload.base_unit          = baseUnitIn.value.trim() || unitInput.value.trim() || 'шт';
                        payload.purchase_unit      = purchUnitIn.value.trim() || payload.base_unit;
                        payload.pack_factor        = pf;
                        payload.consumption_unit   = consUnitIn.value.trim() || payload.base_unit;
                        payload.consumption_factor = cf;
                        // Confirmed once a human declares a real conversion here.
                        if (pf !== 1 || cf !== 1) payload.units_reviewed = true;
                    }
                    e.target.disabled = true;
                    try {
                        const cid = currentClinicId();
                        let itemId = product?.id;
                        if (editing) {
                            const { error } = await supabase.from('clinic_items')
                                .update(payload).eq('id', itemId).eq('company_id', cid);
                            if (error) throw error;
                        } else {
                            const { data, error } = await supabase.from('clinic_items')
                                .insert({ company_id: cid, ...payload }).select('id').single();
                            if (error) throw error;
                            itemId = data.id;
                        }
                        // Sync supplier links: delete removed, insert added, update prices (SUPPLIER_PRICE_V1).
                        // Errors are surfaced (a warning toast) rather than swallowed, so a failed
                        // supplier/price write is never silent — the product itself is already saved.
                        if (state.itemSuppliersOk) {
                            const current = new Set(editing ? suppliersOfItem(itemId) : []);
                            const toAdd    = [...selected].filter(id => !current.has(id));
                            const toRemove = [...current].filter(id => !selected.has(id));
                            const priceOf  = (sid) => supplierPrice.has(sid) ? supplierPrice.get(sid) : null;
                            const packOf   = (sid) => supplierPack.has(sid) ? supplierPack.get(sid) : null;   // SUPPLIER_PACK_V1
                            const sunitOf  = (sid) => supplierUnit.has(sid) ? supplierUnit.get(sid) : null;   // SUPPLIER_UNITS_V1
                            let linkFail = false;
                            if (toRemove.length) {
                                const { error } = await supabase.from('item_suppliers').delete()
                                    .eq('company_id', cid).eq('item_id', itemId).in('supplier_id', toRemove);
                                if (error) { linkFail = true; console.warn('[procurement] supplier unlink:', error.message); }
                            }
                            if (toAdd.length) {
                                const { error } = await supabase.from('item_suppliers')
                                    .insert(toAdd.map(sid => ({ company_id: cid, item_id: itemId, supplier_id: sid, last_price: priceOf(sid),
                                        ...(state.supPackOk !== false ? { pack_factor: packOf(sid), purchase_unit: sunitOf(sid) } : {}) })));
                                if (error) { linkFail = true; console.warn('[procurement] supplier links:', error.message); }
                            }
                            // Update the purchase price on links that already existed.
                            for (const sid of [...selected].filter(id => current.has(id))) {
                                const { error } = await supabase.from('item_suppliers')
                                    .update({ last_price: priceOf(sid), ...(state.supPackOk !== false ? { pack_factor: packOf(sid), purchase_unit: sunitOf(sid) } : {}) })
                                    .eq('company_id', cid).eq('item_id', itemId).eq('supplier_id', sid);
                                if (error) { linkFail = true; console.warn('[procurement] supplier price:', error.message); }
                            }
                            if (linkFail) toast('Товар сохранён, но не все цены/связи поставщиков обновились.', 'info');
                        }
                        toast(editing ? 'Product updated.' : 'Product added.', 'ok');
                        close();
                        await reloadCommon();
                        if (state.tab === 'products') renderBody();
                        // RECEIVE_MULTI_V1 — hand the new product back to the caller
                        // (the receive dialog adds it straight to its lines).
                        if (typeof opts.onSaved === 'function') { try { opts.onSaved(itemId); } catch (e) { console.warn('[procurement] onSaved:', e); } }
                    } catch (err) {
                        toast(err.message || String(err), 'fail');
                    } finally { e.target.disabled = false; }
                },
            }, editing ? 'Save' : 'Add'),
        ],
    });
    setTimeout(() => nameInput.focus(), 0);
}

// ============================================================================
// SUPPLIERS tab
// ============================================================================
function prSuppliers() {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });
    const tableWrap = h('div');

    wrap.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Building', { size: 16 }), prL('suppliersHdr'), h('span', { class: 'h-count' }, String(state.suppliers.length))),
            h('button', { class: 'btn btn-primary btn-sm', onclick: () => openSupplierModal(null) }, Icon('Plus', { size: 14 }), prL('addSupplier')),
        ),
        tableWrap,
    ));

    paintSuppliersInto(tableWrap);
    return wrap;
}

let supplierTableWrapRef = null;
function paintSuppliersInto(tableWrap) {
    supplierTableWrapRef = tableWrap;
    paintSuppliersTable();
}
function paintSuppliersTable() {
    const tableWrap = supplierTableWrapRef;
    if (!tableWrap) return;
    clear(tableWrap);

    const sq = (supFilter.q || '').trim().toLowerCase();   // PROC_FILTERS_V1
    const sRows = state.suppliers.filter(s => {
        if (sq && ![s.name, s.contact_name, s.phone, s.email].some(v => v && String(v).toLowerCase().includes(sq))) return false;
        if (supFilter.status !== 'all' && ((s.active !== false) !== (supFilter.status === 'active'))) return false;
        return true;
    });
    const tbody = h('tbody', null,
        ...(sRows.length
            ? sRows.map(s => h('tr', { style: s.active === false ? { opacity: '0.55' } : {} },
                h('td', { class: 'cell-strong' }, s.name || '—'),
                h('td', { class: 'muted' }, s.contact_name || '—'),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, s.phone || '—'),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, s.email || '—'),
                h('td', null, s.active === false
                    ? h('span', { class: 'tag' }, 'Inactive')
                    : h('span', { class: 'tag tag-ok' }, 'Active')),
                h('td', null, h('div', { class: 'row', style: { gap: '4px' } },
                    h('button', { class: 'btn btn-ghost btn-sm', style: { height: '26px', padding: '0 8px', fontSize: '12.5px' }, onclick: () => openSupplierModal(s) }, Icon('Edit', { size: 12 }), ' Edit'),
                    s.active === false
                        ? h('button', { class: 'btn btn-ghost btn-sm', style: { height: '26px', padding: '0 8px', fontSize: '12.5px' }, onclick: () => setSupplierActive(s, true) }, 'Restore')
                        : h('button', { class: 'icon-btn', style: { width: '26px', height: '26px' }, title: 'Deactivate', onclick: () => setSupplierActive(s, false) }, Icon('Trash', { size: 13 })),
                )),
            ))
            : [emptyRow(6, 'No suppliers yet. Add one to start.')]),
    );

    tableWrap.appendChild(h('table', { class: 'tbl' },
        h('thead', null,
            h('tr', null,
                h('th', null, 'Name'), h('th', null, 'Contact'), h('th', null, 'Phone'),
                h('th', null, 'Email'), h('th', null, 'Status'), h('th', { style: { width: '170px' } }, 'Actions')),
            procFilterRow([   // PROC_FILTER_ROW_V1
                { type: 'search', key: 'su.q', get: () => supFilter.q, set: (v) => { supFilter.q = v; }, placeholder: prL('fltSearch') },
                null, null, null,
                { options: [{ value: 'all', label: prL('fltAllStatus') }, { value: 'active', label: prL('fltActive') }, { value: 'inactive', label: prL('fltInactive') }], get: () => supFilter.status, set: (v) => { supFilter.status = v; } },
                null,
            ], paintSuppliersTable)),
        tbody,
    ));
}

async function setSupplierActive(supplier, active) {
    try {
        const { error } = await supabase.from('suppliers')
            .update({ active })
            .eq('id', supplier.id)
            .eq('company_id', currentClinicId());
        if (error) throw error;
        supplier.active = active;
        toast(active ? 'Supplier restored.' : 'Supplier deactivated.', 'ok');
        paintSuppliersTable();
    } catch (err) {
        toast(err.message || String(err), 'fail');
    }
}

function openSupplierModal(supplier, opts = {}) {   // PO_NEW_SUPPLIER_V1 — opts.onSaved(supplierId)
    const editing = !!supplier;
    let newSupplierId = null;
    const nameInput    = h('input', { type: 'text', placeholder: 'e.g. Pharma-Plus UZ', required: true, value: supplier?.name || '' });
    const contactInput = h('input', { type: 'text', placeholder: 'Optional', value: supplier?.contact_name || '' });
    const phoneField   = phoneInput('phone', '+998 90 961 00 04', { value: supplier?.phone });
    const emailInput   = h('input', { type: 'email', placeholder: 'Optional', value: supplier?.email || '' });
    const notesInput   = h('textarea', { rows: 3, placeholder: 'Optional' }, supplier?.notes || '');
    const activeInput  = h('input', { type: 'checkbox' });
    activeInput.checked = supplier ? supplier.active !== false : true;

    const body = h('form', { class: 'modal-body' },
        fieldRow('Name *', nameInput),
        fieldRow('Contact name', contactInput),
        fieldRow('Phone *', phoneField),
        fieldRow('Email', emailInput),
        fieldRow('Notes', notesInput),
        h('div', { class: 'field' },
            h('label', { class: 'row', style: { gap: '8px', cursor: 'pointer' } }, activeInput, 'Active'),
        ),
    );

    openModal({
        title: editing ? 'Edit supplier' : 'Add supplier',
        body,
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
            h('button', {
                class: 'btn btn-primary', type: 'button',
                onclick: async (e) => {
                    const name = nameInput.value.trim();
                    if (!name) { toast('Name is required.', 'fail'); nameInput.focus(); return; }
                    if (!phoneField.value.trim()) { toast('Укажите телефон поставщика.', 'fail'); phoneField.focus(); return; }   // SUPPLIER_PHONE_REQ_V1
                    const payload = {
                        name,
                        contact_name: contactInput.value.trim() || null,
                        phone: phoneField.value.trim() || null,
                        email: emailInput.value.trim() || null,
                        notes: notesInput.value.trim() || null,
                        active: activeInput.checked,
                    };
                    e.target.disabled = true;
                    try {
                        if (editing) {
                            const { error } = await supabase.from('suppliers')
                                .update(payload)
                                .eq('id', supplier.id)
                                .eq('company_id', currentClinicId());
                            if (error) throw error;
                        } else {
                            const { data: created, error } = await supabase.from('suppliers')
                                .insert({ company_id: currentClinicId(), ...payload })
                                .select('id').single();   // PO_NEW_SUPPLIER_V1 — id for the caller
                            if (error) throw error;
                            newSupplierId = created?.id || null;
                        }
                        toast(editing ? 'Supplier updated.' : 'Supplier added.', 'ok');
                        close();
                        await reloadCommon();
                        // Re-render the suppliers tab so the count + rows refresh.
                        if (state.tab === 'suppliers') renderBody();
                        // PO_NEW_SUPPLIER_V1 — hand the new supplier to the caller.
                        if (typeof opts.onSaved === 'function') {
                            try { opts.onSaved(newSupplierId || supplier?.id || null); }
                            catch (e) { console.warn('[procurement] supplier onSaved:', e); }
                        }
                    } catch (err) {
                        toast(err.message || String(err), 'fail');
                    } finally { e.target.disabled = false; }
                },
            }, editing ? 'Save' : 'Add'),
        ],
    });
    setTimeout(() => nameInput.focus(), 0);
}

// ============================================================================
// PURCHASE ORDERS tab
// ============================================================================
const PO_STATUS = {
    'draft':              { label: 'Draft',              color: 'var(--ink-500)' },
    'ordered':            { label: 'Ordered',            color: 'var(--info-500)' },
    'partially_received': { label: 'Partially received', color: 'var(--warn-500)' },
    'received':           { label: 'Received',           color: 'var(--ok-500)' },
    'cancelled':          { label: 'Cancelled',          color: 'var(--crit-500)' },
};
let poRows = [];
let poLoading = false;

function poStatusPill(status) {
    const m = PO_STATUS[status] || { label: status || '—', color: 'var(--ink-500)' };
    return h('span', { style: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '2px 8px', borderRadius: '999px',
        background: `color-mix(in oklab, ${m.color} 12%, white)`, color: m.color,
        border: `1px solid color-mix(in oklab, ${m.color} 35%, white)`,
        fontSize: '12.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
    } },
        h('span', { style: { width: '6px', height: '6px', borderRadius: '999px', background: m.color } }),
        m.label,
    );
}

function prPurchaseOrders() {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });
    const tableWrap = h('div');

    wrap.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Receipt', { size: 16 }), prL('posHdr')),
            h('button', { class: 'btn btn-primary btn-sm', onclick: openNewPOModal }, Icon('Plus', { size: 14 }), prL('newPO')),
        ),
        tableWrap,
    ));

    paintPOInto(tableWrap);
    loadPOs().then(() => paintPOInto(tableWrap));
    return wrap;
}

let poTableWrapRef = null;
function paintPOInto(tableWrap) {
    poTableWrapRef = tableWrap;
    paintPOTable();
}
function paintPOTable() {
    const tableWrap = poTableWrapRef;
    if (!tableWrap) return;
    clear(tableWrap);

    if (poLoading) {
        tableWrap.appendChild(h('div', { class: 'muted', style: { padding: '20px', fontSize: '12.5px' } }, 'Loading…'));
        return;
    }

    const pq = (poFilter.q || '').trim().toLowerCase();   // PROC_FILTERS_V1
    const rows = poRows.filter(po => {
        if (pq && !((po.po_number || '').toLowerCase().includes(pq))) return false;
        if (poFilter.sup !== 'all' && String(po.supplier_id) !== String(poFilter.sup)) return false;
        if (poFilter.status !== 'all' && po.status !== poFilter.status) return false;
        if (poFilter.branch !== 'all' && String(po.branch_id) !== String(poFilter.branch)) return false;
        return true;
    });
    const tbody = h('tbody', null,
        ...(rows.length
            ? rows.map(po => {
                const sup = supplierById(po.supplier_id);
                const br = branchById(po.branch_id);
                return h('tr', null,
                    h('td', { class: 'cell-mono cell-strong', style: { fontSize: '12.5px' } }, po.po_number || po.id.slice(0, 8)),
                    h('td', null, sup?.name || '—'),
                    state.branches.length > 1 ? h('td', { class: 'muted', style: { fontSize: '12.5px' } }, br?.name || '—') : null,   // PROC_NO_BRANCH_V1
                    h('td', null, poStatusPill(po.status)),
                    h('td', { class: 'num cell-strong' }, fmtMoney(po.total)),
                    h('td', { class: 'muted num', style: { fontSize: '12.5px' } }, fmtDate(po.created_at)),
                    h('td', null, h('button', { class: 'btn btn-ghost btn-sm', style: { height: '26px', padding: '0 8px', fontSize: '12.5px' }, onclick: () => openPODetail(po) }, 'Open ', Icon('ArrowRight', { size: 11 }))),
                );
            })
            : [emptyRow(state.branches.length > 1 ? 7 : 6, 'No purchase orders yet. Create one to start.')]),
    );

    const multiBr = state.branches.length > 1;   // PROC_NO_BRANCH_V1 — hide branch on single-branch clinics
    tableWrap.appendChild(h('table', { class: 'tbl' },
        h('thead', null,
            h('tr', null,
                h('th', null, 'PO #'), h('th', null, 'Supplier'),
                multiBr ? h('th', null, 'Branch') : null,
                h('th', null, 'Status'), h('th', null, 'Total'), h('th', null, 'Created'), h('th', { style: { width: '90px' } }, '')),
            procFilterRow([   // PROC_FILTER_ROW_V1
                { type: 'search', key: 'po.q', get: () => poFilter.q, set: (v) => { poFilter.q = v; }, placeholder: prL('fltSearch') },
                { options: [{ value: 'all', label: prL('fltAllSups') }, ...state.suppliers.map(s => ({ value: s.id, label: s.name }))], get: () => poFilter.sup, set: (v) => { poFilter.sup = v; } },
                ...(multiBr ? [{ options: [{ value: 'all', label: prL('fltAllBranches') }, ...state.branches.map(b => ({ value: b.id, label: b.name }))], get: () => poFilter.branch, set: (v) => { poFilter.branch = v; } }] : []),
                { options: [{ value: 'all', label: prL('fltAllStatus') }, ...Object.keys(PO_STATUS).map(k => ({ value: k, label: PO_STATUS[k].label }))], get: () => poFilter.status, set: (v) => { poFilter.status = v; } },
                null, null, null,
            ], paintPOTable)),
        tbody,
    ));
}

// DATE_FMT_V1 — fmtDate now imported from ui.js (locale-aware)

async function loadPOs() {
    const cid = currentClinicId();
    if (!cid) return;
    poLoading = true;
    paintPOTable();
    try {
        const { data, error } = await supabase.from('purchase_orders')
            .select('id, branch_id, supplier_id, po_number, status, order_date, expected_date, total, notes, created_at, received_at')
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;
        poRows = data || [];
    } catch (err) {
        toast(err.message || String(err), 'fail');
        poRows = [];
    } finally {
        poLoading = false;
    }
}

// ---- New PO modal: insert purchase_orders + purchase_order_items ------------
function openNewPOModal(prefill = null) {   // PO_PREFILL_V1 — { item, supplierId } from the stock row
    // PO_RECEIVE_STYLE_V1 — the order dialog works like «Принять товар»:
    // type-to-search a product on top, then per line pick the supplier, the
    // quantity and the unit price. Linked suppliers (Товары tab) are listed
    // first with «★» and their last purchase price pre-fills. «Создать заказ»
    // groups the lines by supplier — one draft PO per supplier.
    if (!state.branches.length) { toast('No branches found for this clinic.', 'info'); return; }
    if (!state.items.length) { toast('Add items to the catalog first.', 'info'); return; }

    const inpStyle = {
        height: '34px', padding: '0 10px', border: '1px solid #d1d5db', borderRadius: '8px',
        fontSize: '13.5px', background: 'white', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
    };
    const poBranch = state.branches.find(b => String(b.id) === String(state.stockBranch)) || state.branches[0];   // PO_NOBRANCH_V1
    const lines = [];   // { item, supplierId, qty, cost, costTouched }
    const linesWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    const totalEl = h('b', null, '0');

    function recalcTotal() {
        const sum = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
        totalEl.textContent = fmtMoney(sum);
    }
    function linkOf(itemId, supplierId) {
        return state.itemSuppliers.find(x => String(x.item_id) === String(itemId) && String(x.supplier_id) === String(supplierId)) || null;
    }
    function addLine(item, presetSup) {   // PO_PREFILL_V1
        if (!item || lines.some(l => String(l.item.id) === String(item.id))) return;
        const linked = suppliersOfItem(item.id);
        const ln = { item, supplierId: presetSup ? String(presetSup) : (linked.length === 1 ? String(linked[0]) : ''), qty: 1, cost: '', costTouched: false };
        const link0 = ln.supplierId ? linkOf(item.id, ln.supplierId) : null;
        ln.cost = (link0 && link0.last_price != null) ? Number(link0.last_price)
            : (item.price != null ? Number(item.price) : '');
        lines.push(ln);
        paintLines();
    }
    function paintLines() {
        clear(linesWrap);
        if (!lines.length) {
            linesWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '10px 2px' } },
                'Найдите товар в поиске выше — он появится здесь строкой заказа.'));
            recalcTotal();
            return;
        }
        lines.forEach((ln, idx) => {
            const linkedIds = new Set(suppliersOfItem(ln.item.id).map(String));
            const act = state.suppliers.filter(s => s.active !== false);
            const opts = [...act.filter(s => linkedIds.has(String(s.id))), ...act.filter(s => !linkedIds.has(String(s.id)))];
            const qtyIn = h('input', { type: 'number', min: '0.0001', step: 'any', value: String(ln.qty ?? ''),
                placeholder: 'Кол-во', style: { ...inpStyle, width: '92px', textAlign: 'right' } });
            qtyIn.addEventListener('input', () => { ln.qty = Number(qtyIn.value); recalcTotal(); });
            const costIn = h('input', { type: 'number', min: '0', step: 'any', value: ln.cost === '' ? '' : String(ln.cost),
                placeholder: 'Цена', style: { ...inpStyle, width: '120px', textAlign: 'right' } });
            costIn.addEventListener('input', () => { ln.cost = costIn.value === '' ? '' : Number(costIn.value); ln.costTouched = true; recalcTotal(); });
            const supSel = h('select', { style: { ...inpStyle, width: '190px' } },
                h('option', { value: '' }, 'Выберите поставщика…'),
                ...opts.map(s => h('option', { value: s.id, selected: String(s.id) === String(ln.supplierId) },
                    (linkedIds.has(String(s.id)) ? '★ ' : '') + s.name)));
            supSel.addEventListener('change', () => {
                ln.supplierId = supSel.value;
                // the price follows the supplier link unless it was hand-typed
                if (!ln.costTouched) {
                    const link = ln.supplierId ? linkOf(ln.item.id, ln.supplierId) : null;
                    ln.cost = (link && link.last_price != null) ? Number(link.last_price)
                        : (ln.item.price != null ? Number(ln.item.price) : '');
                    costIn.value = ln.cost === '' ? '' : String(ln.cost);
                    recalcTotal();
                }
            });
            linesWrap.appendChild(h('div', {
                style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
                         border: '1px solid var(--ink-100)', borderRadius: '10px', background: 'var(--white)', flexWrap: 'wrap' },
            },
                h('div', { style: { minWidth: '140px', flex: 1 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '13.5px', whiteSpace: 'normal', overflowWrap: 'anywhere' } }, ln.item.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, baseUnitOf(ln.item) || '—')),
                h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, 'Поставщик'),
                supSel, qtyIn, costIn,
                h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: prL('biRemove'),
                    onclick: () => { lines.splice(idx, 1); paintLines(); } }, '×'),
            ));
        });
        recalcTotal();
    }

    // ---- product type-to-search on top (same pattern as «Принять товар») ----
    const prodWrap = h('div', { style: { position: 'relative', flex: 1 } });
    const prodInp = h('input', { type: 'text', placeholder: prL('rcProdSearch'), style: { ...inpStyle, width: '100%' } });
    const prodSuggest = h('div', { style: {
        position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
        background: 'white', border: '1px solid var(--ink-200)', borderRadius: '10px',
        boxShadow: '0 10px 30px rgba(15,23,42,0.14)', maxHeight: '220px', overflow: 'auto', display: 'none',
    } });
    prodWrap.appendChild(prodInp); prodWrap.appendChild(prodSuggest);
    function paintProdSuggestions() {
        const q = prodInp.value.trim().toLowerCase();
        clear(prodSuggest);
        if (!q) { prodSuggest.style.display = 'none'; return; }
        const hits = state.items
            .filter(i => itemLabel(i).toLowerCase().includes(q))
            .filter(i => !lines.some(l => String(l.item.id) === String(i.id)))
            .slice(0, 8);
        if (!hits.length) {
            prodSuggest.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } }, prL('biNothing')));
        } else {
            for (const it of hits) {
                prodSuggest.appendChild(h('button', {
                    type: 'button',
                    style: { display: 'block', width: '100%', padding: '9px 12px', border: 'none', background: 'transparent',
                             cursor: 'pointer', fontSize: '13.5px', color: 'var(--ink-800)', fontFamily: 'inherit',
                             textAlign: 'left', whiteSpace: 'normal', overflowWrap: 'anywhere' },
                    onmousedown: (e) => e.preventDefault(),
                    onclick: () => { addLine(it); prodInp.value = ''; prodSuggest.style.display = 'none'; prodInp.focus(); },
                }, itemLabel(it)));
            }
        }
        prodSuggest.style.display = 'block';
    }
    prodInp.addEventListener('input', paintProdSuggestions);
    prodInp.addEventListener('focus', paintProdSuggestions);
    prodInp.addEventListener('blur', () => setTimeout(() => { prodSuggest.style.display = 'none'; }, 150));

    const notesInput = h('input', { type: 'text', placeholder: 'Optional', style: { ...inpStyle, width: '100%' } });
    paintLines();
    // PO_PREFILL_V1 — the stock row's product + supplier arrive pre-set.
    if (prefill && prefill.item && prefill.item.id) addLine(prefill.item, prefill.supplierId || null);

    const body = h('form', { class: 'modal-body', style: { display: 'block' } },
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginBottom: '12px' } }, prodWrap),
        h('div', { class: 'field', style: { marginBottom: '10px' } }, h('label', null, 'Позиции *'), linesWrap),
        h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px', fontSize: '13.5px', margin: '2px 0 10px' } },
            h('span', { class: 'muted' }, 'Итого:'), totalEl, h('span', { class: 'muted' }, 'UZS')),
        // PO_NO_NOTES_V1 — «Заметки» removed; notesInput stays defined so the save
        // payload still reads it (always empty → null).
    );

    openModal({
        title: 'Новый заказ на закупку',
        subtitle: 'Найдите товар, затем выберите поставщика, количество и цену. Строки с разными поставщиками станут отдельными заказами.',
        width: '860px',
        body,
        footerButtons: (close) => [
            h('button', { class: 'btn', type: 'button', onclick: close }, prL('cancel')),
            h('button', { class: 'btn btn-primary', type: 'button',
                onclick: async (e) => {
                    const branchId = poBranch?.id || null;   // PO_NOBRANCH_V1
                    if (!branchId) { toast(prL('biNoBranches'), 'fail'); return; }
                    const valid = lines.filter(l => Number(l.qty) > 0);
                    if (!valid.length) { toast('Добавьте хотя бы один товар с количеством больше 0.', 'fail'); return; }
                    const noSup = valid.find(l => !l.supplierId);
                    if (noSup) { toast(trf('Выберите поставщика для «{name}».', { name: noSup.item.name || '—' }), 'fail'); return; }
                    e.target.disabled = true;
                    try {
                        const cid = currentClinicId();
                        const bySup = new Map();   // one draft PO per supplier
                        for (const l of valid) {
                            const k = String(l.supplierId);
                            if (!bySup.has(k)) bySup.set(k, []);
                            bySup.get(k).push(l);
                        }
                        const made = [];
                        let seq = 0;
                        for (const [supplierId, ls] of bySup.entries()) {
                            const total = ls.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
                            const poNumber = 'PO-' + Date.now().toString(36).toUpperCase() + (bySup.size > 1 ? '-' + (++seq) : '');
                            const { data: poData, error: poErr } = await supabase.from('purchase_orders')
                                .insert({ company_id: cid, branch_id: branchId, supplier_id: supplierId, status: 'draft',
                                          order_date: null, total, po_number: poNumber, notes: notesInput.value.trim() || null })
                                .select('id').single();
                            if (poErr) throw poErr;
                            const lineRows = ls.map(l => ({
                                company_id: cid, po_id: poData.id, item_id: l.item.id,
                                qty_ordered: Number(l.qty), unit_cost: Number(l.cost) || 0,
                                // line_total is GENERATED — do NOT insert it.
                            }));
                            const { error: liErr } = await supabase.from('purchase_order_items').insert(lineRows);
                            if (liErr) throw liErr;
                            made.push(poNumber);
                        }
                        toast(made.length > 1 ? trf('Создано заказов: {n} ({list}).', { n: made.length, list: made.join(', ') }) : trf('Заказ {no} создан.', { no: made[0] }), 'ok');
                        close();
                        await loadPOs();
                        paintPOTable();
                    } catch (err) { toast(err.message || String(err), 'fail'); }
                    finally { e.target.disabled = false; }
                } }, 'Создать заказ'),
        ],
    });
    setTimeout(() => prodInp.focus(), 0);
}

// ---- PO detail: view lines, status transitions, receive ---------------------
async function openPODetail(po) {
    const sup = supplierById(po.supplier_id);
    const br = branchById(po.branch_id);

    const linesWrap = h('div', { style: { marginTop: '8px' } }, h('div', { class: 'muted', style: { padding: '14px', fontSize: '12.5px' } }, 'Loading lines…'));
    let lineItems = [];

    async function loadLines() {
        try {
            const { data, error } = await supabase.from('purchase_order_items')
                .select('id, item_id, qty_ordered, unit_cost, qty_received, line_total')
                .eq('po_id', po.id)
                .eq('company_id', currentClinicId());
            if (error) throw error;
            lineItems = data || [];
        } catch (err) {
            toast(err.message || String(err), 'fail');
            lineItems = [];
        }
        paintLines();
    }

    // map of line.id -> receive-qty input element (only when receivable)
    const receiveInputs = {};
    // GOODS_RECEIPT_V1 — line.id -> { batchEl, expiryEl } for batch-tracked items
    const batchInputs = {};

    function paintLines() {
        clear(linesWrap);
        const receivable = po.status === 'ordered' || po.status === 'partially_received';
        const tbody = h('tbody', null,
            ...(lineItems.length
                ? lineItems.map(li => {
                    const it = itemById(li.item_id);
                    const ordered = Number(li.qty_ordered || 0);
                    const received = Number(li.qty_received || 0);
                    const remaining = Math.max(0, ordered - received);
                    let recvCell;
                    if (receivable && remaining > 0) {
                        const recvInput = h('input', { type: 'number', min: '0', max: String(remaining), step: 'any', placeholder: String(remaining),
                            style: { width: '90px', height: '28px', padding: '0 8px', border: '1px solid #d1d5db', borderRadius: '6px' } });
                        receiveInputs[li.id] = recvInput;
                        const parts = [recvInput];
                        // PRODUCT_EXPIRY_V2 — expiration date on EVERY received PO line (any
                        // product); entering it stores the goods as a dated lot.
                        if (state.batchOk !== false && it) {
                            const expiryEl = h('input', { type: 'date',
                                style: { width: '150px', height: '26px', padding: '0 8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '12.5px' } });
                            batchInputs[li.id] = { expiryEl };
                            parts.push(h('div', { class: 'row', style: { gap: '6px', marginTop: '5px', alignItems: 'center', flexWrap: 'wrap' } },
                                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, prL('bxExpiry')), expiryEl));
                        }
                        recvCell = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, ...parts);
                    } else {
                        recvCell = remaining <= 0 ? h('span', { class: 'tag tag-ok' }, 'Done') : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '—');
                    }
                    return h('tr', null,
                        h('td', { class: 'cell-strong' }, it?.name || '—'),
                        h('td', { class: 'num' }, fmtNum(ordered)),
                        h('td', { class: 'num' }, fmtNum(received)),
                        h('td', { class: 'num muted' }, fmtNum(remaining)),
                        h('td', { class: 'num' }, fmtMoney(li.unit_cost)),
                        h('td', null, recvCell),
                    );
                })
                : [emptyRow(6, 'No lines on this PO.')]),
        );
        linesWrap.appendChild(h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Item'), h('th', null, 'Ordered'), h('th', null, 'Received'),
                h('th', null, 'Remaining'), h('th', null, 'Unit cost'), h('th', { style: { width: '110px' } }, 'Receive'),
            )),
            tbody,
        ));
    }

    const body = h('div', { class: 'modal-body', style: { display: 'block' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '4px' } },
            h('div', null, h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, 'Supplier'),
                h('div', { style: { fontSize: '13.5px', color: 'var(--ink-900)' } }, sup?.name || '—')),
            h('div', null, h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, 'Destination branch'),
                h('div', { style: { fontSize: '13.5px', color: 'var(--ink-900)' } }, br?.name || '—')),
            h('div', null, h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, 'Status'),
                h('div', { style: { marginTop: '2px' } }, poStatusPill(po.status))),
            h('div', null, h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, 'Total'),
                h('div', { class: 'num', style: { fontSize: '13.5px', color: 'var(--ink-900)' } }, fmtMoney(po.total))),
        ),
        linesWrap,
    );

    const { close } = openModal({
        title: 'PO ' + (po.po_number || po.id.slice(0, 8)),
        subtitle: 'Order date: ' + (po.order_date ? fmtDate(po.order_date) : 'not set'),
        width: '700px',
        body,
        footerButtons: (closeFn) => {
            const btns = [];   // NO_DOUBLE_CLOSE_V1 — header red «Закрыть» is enough

            if (po.status === 'draft') {
                btns.push(h('button', {
                    class: 'btn btn-outline', type: 'button',
                    onclick: async (e) => { e.target.disabled = true; try { await cancelPO(po, closeFn); } finally { e.target.disabled = false; } },
                }, 'Cancel PO'));
                btns.push(h('button', {
                    class: 'btn btn-primary', type: 'button',
                    onclick: async (e) => { e.target.disabled = true; try { await markOrdered(po, closeFn); } finally { e.target.disabled = false; } },
                }, Icon('Check', { size: 14 }), ' Mark ordered'));
            } else if (po.status === 'ordered' || po.status === 'partially_received') {
                btns.push(h('button', {
                    class: 'btn btn-primary', type: 'button',
                    onclick: async (e) => { e.target.disabled = true; try { await doReceive(closeFn); } finally { e.target.disabled = false; } },
                }, Icon('Plus', { size: 14 }), ' Receive entered'));
            }
            return btns;
        },
    });

    // Receive entered quantities for this PO. Reads `receiveInputs` (the live
    // per-line <input> map built in paintLines) directly via closure.
    // For each line with a positive entered qty: bump qty_received, INSERT a
    // +receipt stock_movement (reference_type='po', reference_id=po.id), then
    // recompute the PO status.
    async function doReceive(closeFn) {
        const cid = currentClinicId();
        try {
            if (!po.branch_id) { toast('This PO has no destination branch (it may have been deleted) - cannot receive.', 'fail'); return; }
            // Re-read lines fresh for current qty_received/qty_ordered.
            const { data: lines, error: lErr } = await supabase.from('purchase_order_items')
                .select('id, item_id, qty_ordered, unit_cost, qty_received')
                .eq('po_id', po.id)
                .eq('company_id', cid);
            if (lErr) throw lErr;

            const toReceive = [];
            for (const li of (lines || [])) {
                const inp = receiveInputs[li.id];
                if (!inp) continue;
                const raw = inp.value;
                if (raw === '' || raw == null) continue;
                const qty = Number(raw);
                if (!(qty > 0)) continue;
                const remaining = Math.max(0, Number(li.qty_ordered || 0) - Number(li.qty_received || 0));
                const capped = Math.min(qty, remaining);
                if (capped <= 0) continue;
                toReceive.push({ li, qty: capped });
            }

            if (!toReceive.length) { toast('Enter a quantity to receive on at least one line.', 'fail'); return; }

            for (const { li, qty } of toReceive) {
                const newReceived = Number(li.qty_received || 0) + qty;
                const { error: upErr } = await supabase.from('purchase_order_items')
                    .update({ qty_received: newReceived })
                    .eq('id', li.id)
                    .eq('company_id', cid);
                if (upErr) throw upErr;
                li.qty_received = newReceived; // reflect for the status recompute below

                // PRODUCT_EXPIRY_V2 — an expiry entered on the line (or an already-tracked
                // item) is stored as a dated lot; turn on tracking first, then resolve it.
                let batchId = null;
                const bi = batchInputs[li.id];
                const itRow = itemById(li.item_id);
                const bexp = (bi && bi.expiryEl && bi.expiryEl.value) || '';
                if (state.batchOk !== false && itRow && (bexp || itRow.track_batches)) {
                    if (!itRow.track_batches) {
                        const { error: tErr } = await supabase.from('clinic_items')
                            .update({ track_batches: true }).eq('id', li.item_id);
                        if (tErr) throw tErr;
                        itRow.track_batches = true;
                    }
                    const { data: bId, error: bErr } = await supabase.rpc('get_or_create_batch', {
                        p_item: li.item_id, p_batch_number: null, p_expiry: bexp || null,
                    });
                    if (bErr) throw bErr;
                    batchId = bId;
                }
                const { error: mvErr } = await supabase.from('stock_movements').insert({
                    company_id: cid,
                    item_id: li.item_id,
                    branch_id: po.branch_id,
                    kind: 'receipt',
                    qty: qty,                       // signed: + adds (the trigger upserts on-hand)
                    unit_cost: li.unit_cost ?? null,
                    reference_type: 'po',
                    reference_id: po.id,
                    batch_id: batchId,              // GOODS_RECEIPT_V1
                    note: 'PO ' + (po.po_number || po.id),
                    created_by: currentUserId(),    // STOCK_LOG_V1 — who received the PO line
                });
                if (mvErr) throw mvErr;
            }

            // 'received' when every line qty_received >= qty_ordered, else
            // 'partially_received'. received_at set only when fully received.
            const allDone = (lines || []).length > 0 && (lines || []).every(li => Number(li.qty_received || 0) >= Number(li.qty_ordered || 0));
            const patch = { status: allDone ? 'received' : 'partially_received' };
            if (allDone) patch.received_at = new Date().toISOString();
            const { error: stErr } = await supabase.from('purchase_orders')
                .update(patch)
                .eq('id', po.id)
                .eq('company_id', cid);
            if (stErr) throw stErr;

            toast(allDone ? 'PO fully received.' : 'Partial receipt recorded.', 'ok');
            closeFn();
            await loadPOs();
            paintPOTable();
            // Refresh Stock cache so on-hand reflects the receipt when viewed.
            if (state.tab === 'stock') { await loadStock(); paintStockTable(); }
        } catch (err) {
            toast(err.message || String(err), 'fail');
        }
    }

    loadLines();
}

async function markOrdered(po, closeFn) {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const { error } = await supabase.from('purchase_orders')
            .update({ status: 'ordered', order_date: today })
            .eq('id', po.id)
            .eq('company_id', currentClinicId());
        if (error) throw error;
        toast('PO marked as ordered.', 'ok');
        closeFn();
        await loadPOs();
        paintPOTable();
    } catch (err) {
        toast(err.message || String(err), 'fail');
    }
}

async function cancelPO(po, closeFn) {
    try {
        const { error } = await supabase.from('purchase_orders')
            .update({ status: 'cancelled' })
            .eq('id', po.id)
            .eq('company_id', currentClinicId());
        if (error) throw error;
        toast('PO cancelled.', 'ok');
        closeFn();
        await loadPOs();
        paintPOTable();
    } catch (err) {
        toast(err.message || String(err), 'fail');
    }
}
