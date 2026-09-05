// Easy-Med — admin shell (left sidebar, design-sample layout).
// BUILD_STAMP_V1 — visible in the browser tab so anyone can tell which bundle a
// workstation is actually running (diagnoses cache staleness at a glance).
try { document.title = (document.title || 'Easy-Med') + ' · b2107a'; } catch (e) {}
// Sidebar nav (Clinical / Operations / Insights / Settings) with breadcrumbs.

import { supabase, pingSupabase } from './supabase.js';
import { SECTIONS } from './admin/sections.js?v=rolecmp1';
import { h, Icon, clear, initials } from './admin/ui.js';
import { phoneInput } from './admin/phone-input.js?v=ph1';
import {
    isModuleAllowed, isRouteAllowed,
    setFullAccess, setEffectiveFromRole, setEffectiveFromRoles, currentRoleLabel,
    scopedProviderId,
} from './admin/permissions.js';
import {
    verifyLogin, actorFromUser,
    rehydrateUserFromSession, completeFirstLoginReset, signOutAndReload,
} from './admin/auth.js?v=admdoc3';
import { t, tr, getLang, setLang, onLangChange } from './admin/i18n.js?v=pathway1';   // TS_TAB_I18N_V1 — tr() for tab labels
import { initClinicContext, ensureClinicContext } from './admin/clinic-context.js?v=localclinic2';   // CLINIC_AFTER_LOGIN_V1
import { renderVerificationBanner } from './admin/verify-banner.js?v=vb2';   // MODEL_A_VERIFY_V1
import { renderSetupChecklist } from './admin/setup-checklist.js?v=nolicense1';     // ONBOARDING_CHECKLIST_V1
import { renderNotifications } from './admin/notifications.js?v=nolicense1';      // NOTIF_CENTER_V1
import { initBranchContext, onBranchChange } from './admin/branch-context.js?v=bc3';
import { renderBranchPicker } from './admin/branch-picker.js';
import { loadDocBrandingAsync } from './admin/views/doc-settings.js?v=noqr1';   // DOC_SETTINGS_UNIFY_V1
import { setLicence, isLicensed, licenceState } from './admin/licence.js';   // LICENCE_CORE_V1
import { renderLockedModule } from './admin/views/locked-module.js';   // LICENCE_CORE_V1
import { renderActivation } from './admin/views/activation.js?v=branch1';   // LICENCE_CORE_V1 + BRANCH_FIRST_RUN_V1
import { renderUpdates } from './admin/views/updates.js';   // UPDATE_DELIVERY_V1
// SETTINGS_SPLIT_V1 — «Система» split into three screens (views/updates.js's
// header records what moved where); these are the two new halves.
import { renderSubscription } from './admin/views/subscription.js?v=split1';   // SETTINGS_SPLIT_V1
import { renderClinicData }   from './admin/views/clinic-data.js?v=split1';    // SETTINGS_SPLIT_V1
import { offerIsCurrent, formatRuHour } from './admin/updates-logic.js';   // UPDATE_DELIVERY_V1

import { renderDashboard }    from './admin/views/dashboard.js?v=owndash2';
import { renderPublicSite }   from './admin/views/public-site.js?v=pub6';   // PUBLIC_SITE_V1
// PATIENTS_HUB_V1 — маршрут «Пациенты» открывает ХОСТ раздела (список ·
// очередь · записи). Сам список никуда не делся: хост монтирует его первой
// вкладкой из того же views/patients.js.
import { renderPatientsHub } from './admin/views/patients-hub.js?v=phub1';
import { renderVisits }       from './admin/views/visits.js?v=visits1';   // VISITS_V1 — money-free scheduling
import { renderServices }     from './admin/views/services.js?v=aug31a';   // SERVICES_CATALOG_V1 — + SERVICES_ONE_EDITOR_V1 (единый редактор + удаление в строке)
import { renderRegistration } from './admin/views/registration.js?v=aug17f';
import { renderRoomCalendar } from './admin/views/room-calendar.js?v=aug17e';   // RESCAL_WIRE_V1 — «Календарь записи» (legacy Scheduling retired)
import { renderConsultation }     from './admin/views/consultation.js?v=dashpay1';
import { renderServiceWorkspace } from './admin/views/service-workspace.js?v=aug17e';
import { renderPatientCard }  from './admin/views/patient-card.js?v=labshared1';   // PATIENT_CARD_DESIGN_V2 + SVC_ROW_ACTIONS_V1 (?v must match service-workspace.js)
import { renderPlaceholder }  from './admin/views/placeholder.js';
import { renderSectionCrud }  from './admin/views/section-crud.js?v=svceditor1';
import { renderCashier, renderCashierHead } from './admin/views/cashier-desk.js?v=cash6';   // CASHIER_DESIGN_V2 + CASHIER_ROW_FIT_V1 — patient cell width, RU status, compact date
import { renderReport }       from './admin/views/report.js';
import { renderLaboratory }   from './admin/views/laboratory.js?v=labstats4';   // LAB_STATS_V1 — third mode «Статистика» (usage counters, no money) on the shared LAB_HEAD_ONE_V1 head
import { renderProcedures }   from './admin/views/procedures.js?v=unassigned1';
import { renderQueue }       from './admin/views/queue.js?v=q7';   // QUEUE_BOARD_V1
import { renderCrm }          from './admin/views/crm.js?v=aug18d';   // CRM_V10 — поиск пациента: телефон (и короткая форма), дата рождения; CRM_SERVICE_FILTER_V1 — рейка категорий (тег поднят, иначе браузер оставит старую копию)
import { renderDocsArchive }  from './admin/views/docs-archive.js?v=q3one';   // CLINICAL_DOCS_ARCHIVE_V1 — restored after concurrent clobber
import { renderReports }      from './admin/views/reports.js?v=vatincl1';
import { renderReportsHub }   from './admin/views/reports-hub.js?v=ru6';   // REPORTS_HUB_RU_V1 — «Отчёты» card grid + full-screen report builder
import { renderWardBeds }     from './admin/views/ward-beds.js?v=board3';   // INPATIENT_LOCAL_V1 — fresh local ward/bed board (legacy beds.js was cloud-coupled)
import { renderAdmissions }   from './admin/views/admissions.js?v=inp2';   // ADMISSION_ORDER_V1 — «Стационар»: окно медсестры (заявки, размещение, очередь осмотра)
import { renderMarSheet }    from './admin/views/mar-sheet.js?v=inp5';   // MAR_SHEET_V1 — лист назначений: сетка врача «назначение × час»
import { renderMarNurse }    from './admin/views/mar-nurse.js?v=inp5';   // MAR_NURSE_V1 — задачи медсестры: пациент — якорь, «5 прав»
import { renderKitchenSheet } from './admin/views/kitchen-sheet.js?v=diet1';   // KITCHEN_SHEET_V1 — порционник (Задача 7; экран был написан без маршрута)
import { renderDischarge }   from './admin/views/discharge.js?v=disch1';   // TWO_STEP_DISCHARGE_V1 — «Выписки к оформлению» (Задача 8; экран был написан без маршрута)
import { renderDoctorRoom }   from './admin/views/doctor-room.js?v=docroom1';   // DOCTOR_ROOM_V1 — Кабинет врача (consultation queue)
import { renderEmployees }    from './admin/views/employees.js?v=arch1';   // EMPLOYEE_EDITOR_V3 — per-service rate tables; v11 = RATE_LOAD_V2 (fixed rate survives reopen)
import { renderMarketing }    from './admin/views/marketing.js?v=btnright1';
import { renderCallCenter }   from './admin/views/callcenter.js';
import { renderDocuments }    from './admin/views/documents.js?v=noqr1';
import { renderDiscountsSettings } from './admin/views/discounts-settings.js?v=btnright1';   // PATIENT_DISCOUNTS_V1
import { renderApiSettings } from './admin/views/api-settings.js?v=api4';   // CLINIC_API_V1
import { renderDoctorPay } from './admin/views/doctor-pay.js?v=dp1';   // DOCTOR_PAY_BULK_V1
import { renderReferralSettings } from './admin/views/referral-settings.js?v=rr1';   // REFERRAL_REWARDS_V1
import { renderCashierSettings } from './admin/views/cashier-settings.js?v=shiftmode1';   // CASHIER_SHIFT_MODE_V1
import { renderRoomsSetup } from './admin/views/rooms-setup.js?v=rooms7';   // ROOMS_SETUP_V1 — кабинеты и палаты одним разделом
import { renderTelegramSettings } from './admin/views/telegram-settings.js?v=tg3';   // TELEGRAM_BOT_V1
import { renderTelephonySettings } from './admin/views/telephony-settings.js?v=tel1';   // TELEPHONY_V1 — Binotel call-center integration
import { renderCrmSettings } from './admin/views/crm-settings.js?v=crmcfg2';   // CRM_CONFIG_V1 — configurable kanban stages/sources/call routing
import { renderTelegramChat } from './admin/views/telegram-chat.js?v=tgc4';   // TELEGRAM_CHAT_V1
import { renderConsultationTypes } from './admin/views/consultation-types.js?v=ct5';   // CONSULTATION_TYPES_RESTORE
import { renderPharmacy }    from './admin/views/pharmacy.js?v=ph2';   // PHARMACY_V1
import { renderProcurement }  from './admin/views/procurement.js?v=vendorxlsx2';   // PROCUREMENT_IMPORT_V2
import { renderRequestsInbox } from './admin/views/requests-inbox.js?v=btnright1';
import { renderPacs }         from './admin/views/pacs.js';
import { renderInventory }    from './admin/views/inventory.js?v=inv4';   // INVENTORY_UI_V1 — Suppliers/PO/Requisitions/Counts tabs live
import { renderSettingsHub }  from './admin/views/settings-hub.js?v=updbadge1';   // SETTINGS_HUB_V1 — Документы -> rich designer; Пациенты -> settings:patients route
import { renderPatientDocuments } from './admin/views/patient-documents.js?v=docstoolbar1';   // PATIENT_DOCUMENTS_V1 + DOCS_TOOLBAR_V1
import { renderDocumentsSettings } from './admin/views/documents-settings.js?v=doc2';   // DOCUMENTS_SETTINGS_V1

// ---------------------------------------------------------------------------
// Nav definition — mirrors design-sample/src/app.jsx exactly + Settings group
// ---------------------------------------------------------------------------
// NAV_ORDER_V2 — sidebar grouped/ordered to mirror easymed exactly:
// Clinical → Operations → Analytics (Procurement sits under Operations with the
// cashier desks; Dashboard/Reports/Settings form the Analytics block at the
// bottom). Visits are reached per-patient; the services catalog lives in Settings.
const NAV = [
    { section: 'Clinical' },
    { id: 'patients', label: 'Patients', icon: 'Patients' },
    { id: 'crm',      label: 'CRM · Заявки', icon: 'Headset' },   // CRM_V1
    { id: 'consultation', label: 'My services', icon: 'Stethoscope' },   // DOCTOR_WORKSPACE_V1 — easymed's provider queue (was the simplified doctor-room stand-in; that route still works, just unlisted)
    // QUEUE_BOARD_V1 — доска номеров по назначениям. Стоит сразу под кабинетом
    // врача: отвечает на вопрос «кто ко мне ещё стоит», а номера для неё
    // выдаёт issue_queue_numbers при заведении услуги.
    { id: 'queue',    label: 'Очередь', icon: 'Clock' },
    { id: 'labs',     label: 'Laboratory', icon: 'Flask' },   // LABS_UI_V1
    { id: 'procedures', label: 'Процедуры', icon: 'Pulse' },   // PROCEDURES_V1 — очередь процедур (медсестра)
    // ADMISSION_ORDER_V1 — «Стационар» это РАБОТА (кого положить, кто лежит,
    // кого не осмотрели), а «Койки и палаты» — коечный ФОНД. Разные вопросы и
    // разные люди: первым живёт смена медсестры, вторым — администратор
    // клиники. Один пункт меню на оба заставлял бы медсестру искать свою
    // очередь внутри плана этажа. Права у них общие (ключ `beds`).
    { id: 'admissions', label: 'Inpatient ward', icon: 'Bed' },
    // MAR_NURSE_V1 — задачи медсестры по листу назначений. Отдельный пункт, а не
    // вкладка внутри «Стационара»: это работа СМЕНЫ, к которой возвращаются
    // каждый час, а окно госпитализации открывают, когда кого-то кладут.
    { id: 'mar-nurse', label: 'Treatment tasks', icon: 'Pill' },
    // KITCHEN_SHEET_V1 — порционник. Экран был написан Задачей 7 и остался без
    // единого входа: ни пункта меню, ни ветки маршрута. Здесь он их получает.
    { id: 'kitchen-sheet', label: 'Kitchen sheet', icon: 'Doc' },
    // TWO_STEP_DISCHARGE_V1 — «Выписки к оформлению»: ВТОРОЙ шаг выписки,
    // рабочее место старшей медсестры. Тот же случай, что у порционника
    // строкой выше: экран был написан Задачей 8 и остался без единого входа —
    // ни пункта меню, ни ветки маршрута, ни ключа прав. Отдельный пункт, а не
    // вкладка «Стационара»: заявку подаёт врач в карте пациента, а оформляет
    // выписку другой человек и через несколько часов — это его собственный
    // список работы на смену, а не часть окна госпитализации.
    { id: 'discharge', label: 'Discharges', icon: 'Check' },
    { id: 'beds',     label: 'Ward & beds', icon: 'Bed' },   // INPATIENT_LOCAL_V1 — Стационар и палаты
    { id: 'patient-documents', label: 'Documents', icon: 'Doc' },   // PATIENT_DOCUMENTS_V1
    { section: 'Operations' },
    // TELEGRAM_CHAT_V1 — переписка с пациентами это работа стойки, а не приём:
    // её ведут регистратура и call-центр, поэтому раздел живёт в «Операциях».
    // TELEGRAM_CHAT_BADGE_V1 — непрочитанные пациентские сообщения — это работа,
    // которая ждёт: значок красный, как у остальных «требует действия».
    { id: 'telegram-chat', label: 'Чат с пациентами', icon: 'Msg', badgeKind: 'alert' },
    // CASHIER_UNPAID_BADGE_V1 — деньги, которые ждут: красный, как у чата выше,
    // потому что неоплаченный счёт — это работа кассира, а не справка.
    { id: 'cashier-shifts', label: 'Cashier', icon: 'Wallet', badgeKind: 'alert' },   // CASHIER_LOCAL_V1 — Касса (module key 'cashier')
    { id: 'cashier-head', label: 'Head cashier', icon: 'Coins' },   // CASHIER_LOCAL_V1 — Старший кассир (key 'cashier-head')
    { id: 'inventory', label: 'Procurement', icon: 'Pill' },   // INVENTORY_UI_V1 — Закупки
    { section: 'Analytics' },
    { id: 'dashboard', label: 'Dashboard', icon: 'Dashboard' },
    { id: 'reports-hub', label: 'Reports', icon: 'Chart' },   // REPORTS_HUB_V1
    { id: 'settings', label: 'Settings', icon: 'Settings', badgeKind: 'alert' },   // SETTINGS_HUB_V1 + UPDATE_BADGE_V1
];

// Live nav badges — populated by loadNavCounts() from Supabase. Updated on
// boot + after every navigate() so they always reflect current DB state.
const navCounts = {
    patients:     null,    // total active patients
    requests:     null,    // pending Symptex requests (visits.status='requested')
    appointments: null,    // today's visits
    consultation: null,    // queued + in_progress visit_services (active work)
    'cashier-shifts': null,   // CASHIER_UNPAID_BADGE_V1 — unpaid + partial + debt invoices (money to collect)
    pacs:         12,      // studies awaiting read — TODO: wire to a `studies` count once table exists
    // UPDATE_BADGE_V1 — не «сколько», а «есть»: 1 = ждёт обновление. Счётчик, а
    // не отдельный флаг, потому что бейдж в меню уже умеет ровно это, и второй
    // механизм рядом означал бы два места, где рисуется одна и та же точка.
    settings:     null,
    'telegram-chat': null,   // TELEGRAM_CHAT_BADGE_V1 — входящие без read_at
};

const CRUMBS = {
    dashboard:     ['Insights', 'Dashboard'],
    patients:      ['Clinical', 'Patients'],
    'doctor-room': ['Clinical', "Doctor's room"],   // DOCTOR_ROOM_V1
    crm:           ['Clinical', 'CRM · Заявки'],   // CRM_V1
    employees:     ['Настройки', 'Сотрудники'],   // EMPLOYEE_EDITOR_V1
    visits:        ['Clinical', 'Visits'],   // VISITS_V1
    services:      ['Clinical', 'Services'],   // SERVICES_CATALOG_V1
    requests:      ['Clinical', 'Заявки'],
    'patient-card':['Clinical', 'Patients', 'Patient'],
    appointments:  ['Clinical', 'Календарь записи'],
    consultation:       ['Clinical', 'My services'],
    'service-workspace':['Clinical', 'My services', 'Patient workspace'],
    registration:  ['Clinical', 'New patient registration'],
    queue:         ['Clinical', 'Очередь'],   // QUEUE_BOARD_V1
    labs:          ['Clinical', 'Laboratory'],
    inventory:     ['Clinical', 'Procurement'],   // INVENTORY_UI_V1 — PROCUREMENT_WORKSPACE_V1
    'patient-documents': ['Clinical', 'Documents'],   // PATIENT_DOCUMENTS_V1
    procedures:    ['Clinical', 'Procedures'],
    admissions:    ['Clinical', 'Inpatient ward'],   // ADMISSION_ORDER_V1
    'mar-nurse':   ['Clinical', 'Treatment tasks'],   // MAR_NURSE_V1
    'mar-sheet':   ['Clinical', 'Inpatient ward', 'Treatment sheet'],   // MAR_SHEET_V1
    'kitchen-sheet': ['Clinical', 'Kitchen sheet'],   // KITCHEN_SHEET_V1
    discharge:     ['Clinical', 'Discharges'],   // TWO_STEP_DISCHARGE_V1
    beds:          ['Clinical', 'Ward & beds'],
    pacs:          ['Clinical', 'Imaging · PACS'],
    pharmacy:      ['Operations', 'Pharmacy'],
    'cashier-shifts': ['Operations', 'Касса'],
    'cashier-head':   ['Operations', 'Старший кассир'],   // CASHIER_HEAD_NAV_V1
    procurement:   ['Operations', 'Procurement'],
    marketing:     ['Operations', 'Marketing'],
    callcenter:    ['Operations', 'Call center'],
    reports:       ['Insights', 'Reports'],
    'reports-hub': ['Insights', 'Reports'],   // REPORTS_HUB_V1 — distinct route from legacy 'reports'
    settings:      ['Insights', 'Settings'],
    documents:     ['Insights', 'Settings', 'Documents'],
    'documents-settings': ['Insights', 'Settings', 'Documents'],   // DOCUMENTS_SETTINGS_V1 — new letterhead editor, distinct route from 'documents' above
    'discounts-settings': ['Insights', 'Settings', 'Скидки пациентов'],   // PATIENT_DISCOUNTS_V1
    'api-settings': ['Insights', 'Settings', 'API'],   // CLINIC_API_V1
    'telegram-settings': ['Insights', 'Settings', 'Telegram-бот'],   // TELEGRAM_BOT_V1
    'telephony-settings': ['Insights', 'Settings', 'Телефония'],   // TELEPHONY_V1
    'crm-settings': ['Insights', 'Settings', 'CRM-канбан'],   // CRM_CONFIG_V1
    'telegram-chat': ['Insights', 'Чат с пациентами'],   // TELEGRAM_CHAT_V1
    'consultation-types': ['Insights', 'Settings', 'Консультации врачей'],   // CONSULTATION_TYPES_RESTORE
    'doctor-pay': ['Insights', 'Settings', 'Зарплата врачей'],   // DOCTOR_PAY_BULK_V1
    // SUBSCRIPTION_SUBROUTE_V1 — 'updates' had no CRUMBS entry, and CRUMBS is
    // also what isKnownView() at boot consults. Two consequences, both real:
    // the tab for «Система» was labelled with the raw route id ('updates', via
    // initialTabLabel's last-resort branch), and a reload — or a pasted
    // '#updates/subscription' link — was rejected as an unknown view and
    // bounced to the home screen, so the deep link only ever worked for the
    // life of one page. The route itself is ALWAYS_ALLOWED in permissions.js,
    // so naming it here grants nothing new.
    updates:      ['Insights', 'Settings', 'Система'],
    // SETTINGS_SPLIT_V1 — the two routes «Система» split into. Named here for
    // exactly the reasons the line above records: isKnownView() reads CRUMBS at
    // boot, so a route missing from it is bounced to the home screen on reload,
    // and the tab would otherwise be labelled with the raw route id. Both are
    // ALWAYS_ALLOWED in permissions.js, so naming them here grants nothing.
    subscription:  ['Insights', 'Settings', 'Подписка'],
    'clinic-data': ['Insights', 'Settings', 'Данные клиники'],
};

// SETTINGS_SPLIT_V1 — the routes that stay open through a full licence
// lockout. 'activation' is where a locked clinic fixes its licence; 'updates'
// because an update may be exactly what fixes it (its RPCs are READ_ONLY /
// ALWAYS_ALLOWED server-side for that purpose); 'subscription' because a clinic
// whose subscription lapsed must be able to read its own subscription state and
// ask for a module; 'clinic-data' because a lapsed clinic must still be able to
// save its data and a decommissioned one to erase itself — backup_create /
// backup_restore / factory_reset are ALWAYS_ALLOWED server-side for precisely
// that reason (server/services/control/gate.js). Before the split the last two
// were reachable only because they were cards on 'updates'; the exemption
// followed them rather than being quietly dropped.
const LOCKOUT_EXEMPT = new Set(['activation', 'updates', 'subscription', 'clinic-data']);

const PLACEHOLDERS = new Set([]);   // PHARMACY_V1 — pharmacy is now a real view

// ---------------------------------------------------------------------------
// State + DOM
// ---------------------------------------------------------------------------
// NO_TABS_APPBAR_V1 — how many mounted view panes may exist at once. The tab
// strip was, underneath the chrome, a view CACHE: each route kept its own
// mounted DOM, so scroll position, filters, half-typed forms and computed
// results survived a trip to another screen. That is worth keeping; the
// unbounded part was not — every route ever visited stayed mounted for the
// life of the session, and with the strip removed there would be no UI left
// to close any of them. So the cache stays and gets a ceiling: the active
// pane plus the two before it (MRU order), which covers the real pattern
// (registratura bouncing Пациенты ↔ Касса ↔ Лаборатория) without hoarding.
// The fourth-oldest pane is unmounted and re-renders from scratch next time.
const VIEW_CACHE_MAX = 3;

const state = {
    view:    'dashboard',
    payload: null,
    user:    { full_name: 'Super Admin', role: 'admin', is_super_admin: true },
    // Mounted view panes, MOST-RECENTLY-USED FIRST. Each entry owns its own
    // DOM node inside #view-root; navigating toggles visibility, so a cached
    // view is never re-rendered.
    //   { key, view, payload, title, root, scrollY }
    panes:     [],
    activeKey: null,
};
const viewRoot  = document.getElementById('view-root');
const titleEl   = document.getElementById('section-title');
const sidebarEl = document.getElementById('sidebar-body');

// SIDEBAR_COLLAPSE_V1 — restore the persisted collapsed state before first paint (no flash).
try {
    if (localStorage.getItem('easymed_sidebar_collapsed') === '1')
        document.querySelector('.app')?.classList.add('sidebar-collapsed');
} catch (_) {}
const crumbsEl  = document.getElementById('crumbs');
const statusEl  = document.getElementById('supabase-status');
const searchEl  = document.getElementById('topbar-search');

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
// First sidebar module the active role can reach — used as the landing page
// and the fallback when a route is denied (since Dashboard is now role-gated
// and may not be available).
function firstAllowedView() {
    // LANDING_VISITS_V1 — фиксированная стартовая страница: журнал «Визиты»
    // (для всех ролей с модулем «Пациенты»); иначе — первый доступный пункт меню.
    if (isRouteAllowed('visits')) return 'visits';
    for (const item of NAV) {
        if (item.section) continue;
        if (isModuleAllowed(item.id)) return item.id;
    }
    return 'dashboard';   // unreachable in practice (super admin sees all)
}

// LAB_PANELS_BY_SECTION_V1 — route ids that no longer exist, mapped to where
// their screen lives now. Two places consult this table: navigate() (an old
// history entry replayed by popstate, or any caller still naming the dead id)
// and parseHash() (an old '#lab-settings' bookmark pasted into the address
// bar). 'lab-settings' was Настройки → «Лаборатория и диагностика»; its editor
// is now the «Панели» mode of Лаборатория — owner decision 2026-08-31: the
// panels editor lives ONLY in the lab section, gated by lab-section access.
const LEGACY_ROUTES = { 'lab-settings': { view: 'labs', sub: 'panels' } };

function navigate(view, payload, opts = {}) {
    if (!view) return;
    // Old links must not break: a retired route id is answered by the screen
    // that replaced it, not by a blank unknown view.
    const legacy = LEGACY_ROUTES[view];
    if (legacy) { view = legacy.view; payload = { ...(payload || {}), sub: legacy.sub }; }
    const key = viewKeyFor(view, payload);

    // Already mounted? Show it again — never re-render (that IS the cache).
    const existing = state.panes.find(p => p.key === key);
    if (existing) {
        // ONE_PANE_PER_SECTION_V1 (was ONE_TAB_PER_SECTION_V1) — the shared
        // patient-card pane re-renders in place when a DIFFERENT patient is
        // opened into it.
        if (view === 'patient-card' && (existing.payload?.id ?? null) !== (payload?.id ?? null)) {
            existing.payload = payload ?? null;
            existing.title   = sectionTitleFor(view, payload);
            existing.scrollY = 0;
            clear(existing.root);
            activatePane(existing);
            renderViewInto(existing);
            if (!opts.skipHistory) pushHistory(view, payload);
            return;
        }
        activatePane(existing);
        if (!opts.skipHistory) pushHistory(view, payload);
        return;
    }

    // First navigation since boot — drop the "Loading…" placeholder.
    if (state.panes.length === 0) clear(viewRoot);

    // New pane — mount a fresh root for it inside #view-root and render into it.
    const paneRoot = document.createElement('div');
    paneRoot.className = 'view-pane';
    paneRoot.dataset.viewKey = key;
    viewRoot.appendChild(paneRoot);

    const pane = {
        key,
        view,
        payload:  payload ?? null,
        title:    sectionTitleFor(view, payload),
        root:     paneRoot,
        scrollY:  0,
    };

    // Save the outgoing pane's scroll before swapping, then make this one the
    // most-recently-used entry and trim the cache back to its ceiling.
    snapshotActiveScroll();
    state.panes.unshift(pane);
    state.activeKey = key;
    state.view      = view;
    state.payload   = payload ?? null;
    evictStalePanes();

    if (!opts.skipHistory) pushHistory(view, payload);
    saveRoute(view);
    renderSidebar();
    renderSectionTitle();
    renderCrumbs();
    showOnlyActivePane();
    renderViewInto(pane);
    loadNavCounts();
}

function pushHistory(view, payload) {
    const url = hashFor(view, payload);
    try {
        history.pushState({ view, payload: payload ?? null }, '', url);
    } catch {
        try { history.pushState({ view }, '', url); } catch {}
    }
}

// HASH_SUBROUTE_V1 — a MODE inside a view, carried in the hash as '#view/sub'.
//
// This app has no hash router: pushHistory writes the hash, nothing ever read
// it, and the route that survives a reload is the one saved to localStorage.
// «Панели» inside Лаборатория is the first piece of state that localStorage
// cannot express — the same view with two different faces — so the convention
// starts here and is deliberately tiny: ONE slash, the view before it, and the
// part after it reaches the view as ctx.payload.sub.
//
// It is not a second view id ('labs-panels') because the plan requires one
// sidebar entry and one tab for Лаборатория; a second id would have produced a
// second tab and a second nav item for what is one screen in two modes.
function hashFor(view, payload) {
    const sub = payload && typeof payload.sub === 'string' ? payload.sub : null;
    return '#' + view + (sub ? '/' + sub : '');
}

function parseHash() {
    let raw = '';
    try { raw = String(location.hash || '').replace(/^#/, ''); } catch { raw = ''; }
    if (!raw) return { view: null, sub: null };
    const i = raw.indexOf('/');
    const parsed = i < 0 ? { view: raw, sub: null } : { view: raw.slice(0, i), sub: raw.slice(i + 1) || null };
    // A retired route id in a pasted/bookmarked hash maps to its replacement —
    // and because the replacement carries a sub, it also WINS the boot below
    // (a bare legacy hash would otherwise be ignored like any bare '#view').
    const legacy = LEGACY_ROUTES[parsed.view];
    return legacy ? { view: legacy.view, sub: legacy.sub } : parsed;
}

// ---------------------------------------------------------------------------
// Pane identity, section title, switching, eviction
// ---------------------------------------------------------------------------
// The cache key. Unchanged from the old tabIdFor(): detail views need one pane
// per record so a second service workspace doesn't reuse the first one's DOM.
// ONE_PANE_PER_SECTION_V1 — patient-card is deliberately a SINGLE reusable
// pane (owner request: one pane per section); opening another patient
// re-renders it in place (see navigate()).
function viewKeyFor(view, payload) {
    if (view === 'service-workspace' && payload?.serviceId) return `service-workspace:${payload.serviceId}`;
    if (view === 'service-workspace' && payload?.visitId)   return `service-workspace:visit:${payload.visitId}`;
    if (view === 'consultation'      && payload?.visitId)   return `consultation:${payload.visitId}`;
    if (view.startsWith('settings:')) return view;
    if (view.startsWith('report:'))   return view;
    return view;
}

// NO_TABS_APPBAR_V1 — what the top bar says the user is looking at. This is
// the old initialTabLabel(), unchanged in logic: the tab labels were the only
// place a screen announced its own identity, and the app bar inherits that job
// (CRUMBS stays the source, and stays load-bearing for isKnownView()).
function sectionTitleFor(view, payload) {
    if (view === 'patient-card')      return payload?.label || 'Patient';
    if (view === 'service-workspace') return payload?.label || 'Workspace';
    if (view === 'consultation')      return payload?.label || 'Consultation';
    const cr = CRUMBS[view];
    if (cr && cr.length) return cr[cr.length - 1];
    if (view.startsWith('settings:')) {
        const key = view.slice('settings:'.length);
        return (SECTIONS?.[key]?.label) || key;
    }
    if (view.startsWith('report:')) {
        const key = view.slice('report:'.length);
        return 'Report · ' + ((SECTIONS?.[key]?.label) || key);
    }
    return view;
}

function renderSectionTitle() {
    if (!titleEl) return;
    const pane = state.panes.find(p => p.key === state.activeKey);
    const raw  = pane ? pane.title : sectionTitleFor(state.view, state.payload);
    titleEl.textContent = tr(raw);
}

// HASH_SUBROUTE_V1 — a view that owns a sub-route reports it here, so the
// pane's payload keeps telling the truth about what is on screen. Two things
// depend on that: the next navigate() to this view writes the right hash
// (clicking the sidebar entry for the section you are already in must not
// silently drop '/panels' out of the URL), and a re-render of a cached pane —
// the branch/lang switches re-render every one — reopens the mode the user was
// in rather than resetting them to the view's default.
//
// The NAME survives the tab strip on purpose: laboratory.js and every future
// sub-route view call it, and the contract (a view names its own pane by the
// `tabId` it was handed in ctx) did not change — only what is underneath.
window.easymedSetTabSub = function setTabSub(paneKey, sub) {
    const pane = state.panes.find(p => p.key === paneKey);
    if (!pane) return;
    const payload = { ...(pane.payload || {}) };
    if (sub) payload.sub = sub; else delete payload.sub;
    pane.payload = Object.keys(payload).length ? payload : null;
    if (state.activeKey === paneKey) state.payload = pane.payload;
};

// Called by views (or anyone) once they know their real title (e.g. a patient
// name fetched async). It used to relabel a tab; it now retitles the app bar,
// which is where screen identity moved. views/updates.js is a live caller.
window.easymedSetTabLabel = function setTabLabel(paneKey, label) {
    const pane = state.panes.find(p => p.key === paneKey);
    if (!pane || !label) return;
    pane.title = label;
    if (state.activeKey === paneKey) renderSectionTitle();
};

function snapshotActiveScroll() {
    const cur = state.panes.find(p => p.key === state.activeKey);
    if (cur) cur.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
}

// Show an already-mounted pane and mark it most-recently-used.
function activatePane(pane) {
    // Clicking the sidebar entry for the section you are ALREADY in must not
    // move the page: there is no outgoing pane to snapshot, so the stored
    // scrollY is stale and restoring it would yank the reader back up.
    const sameScreen = state.activeKey === pane.key;
    if (!sameScreen) snapshotActiveScroll();
    const i = state.panes.indexOf(pane);
    if (i > 0) { state.panes.splice(i, 1); state.panes.unshift(pane); }
    state.activeKey = pane.key;
    state.view      = pane.view;
    state.payload   = pane.payload;
    saveRoute(pane.view);
    renderSidebar();
    renderSectionTitle();
    renderCrumbs();
    showOnlyActivePane();
    if (!sameScreen) requestAnimationFrame(() => window.scrollTo({ top: pane.scrollY || 0, behavior: 'instant' in window ? 'instant' : 'auto' }));
}

// Unmount everything past the cache ceiling. The list is MRU-ordered, so the
// tail is the least recently used; the ACTIVE pane can never be evicted (it is
// always at index 0), which is what keeps this safe to call from navigate().
function evictStalePanes() {
    while (state.panes.length > VIEW_CACHE_MAX) {
        const stale = state.panes.pop();
        if (!stale || stale.key === state.activeKey) break;
        try { stale.root.remove(); } catch (_) {}
    }
}

function showOnlyActivePane() {
    for (const p of state.panes) {
        p.root.style.display = (p.key === state.activeKey) ? '' : 'none';
    }
}

// Browser back/forward — replay the navigation without pushing a new entry.
window.addEventListener('popstate', (e) => {
    const s = e.state;
    if (s && s.view) navigate(s.view, s.payload || null, { skipHistory: true });
});

// Each pane renders into its OWN root div. Called once when the pane is first
// mounted; after that the DOM stays put and navigation only toggles visibility
// (until the pane falls off the end of the cache and is unmounted).
async function renderViewInto(pane) {
    const root = pane.root;
    clear(root);
    if (!isRouteAllowed(pane.view)) {
        root.appendChild(accessDenied());
        return;
    }
    // `tabId` keeps its NAME in ctx: ~100 view files read it and the two
    // globals (easymedSetTabSub / easymedSetTabLabel) take it as their handle.
    // It is the pane key now — the contract is unchanged, the mechanism
    // underneath is not.
    const ctx = { onNavigate: navigate, payload: pane.payload, tabId: pane.key };
    return renderViewInner(root, pane.view, ctx);
}

// Legacy renderView shim — kept so any caller still pointing here ends up
// rendering into the currently-active pane's root.
async function renderView() {
    const pane = state.panes.find(p => p.key === state.activeKey);
    if (!pane) return;
    return renderViewInto(pane);
}

// COMING_SOON_V1 — render a parked module's real view (blurred, in the background)
// behind a non-interactive "coming soon" panel. The content stays visible but
// unclickable (the overlay intercepts pointer events); the sidebar still works so
// the user can navigate away. The overlay is a SIBLING of the view wrapper, so a
// view's own async re-render can never remove it.
function comingSoonOverlay() {
    return h('div', { class: 'coming-soon-overlay', style: {
            position: 'absolute', inset: '0', zIndex: '60',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
            background: 'rgba(248, 250, 252, 0.55)',
            backdropFilter: 'blur(7px)', WebkitBackdropFilter: 'blur(7px)',
        } },
        h('div', { style: {
                background: '#fff', borderRadius: '18px', textAlign: 'center',
                padding: '34px 36px', maxWidth: '440px',
                boxShadow: '0 14px 50px rgba(15, 23, 42, 0.20)',
                border: '1px solid var(--ink-100)',
            } },
            h('div', { style: {
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: '60px', height: '60px', borderRadius: '50%', marginBottom: '16px',
                    background: 'var(--teal-50, #ecfeff)', color: 'var(--teal-600, #0e7490)',
                } }, Icon('Clock', { size: 30 })),
            h('div', { style: { fontWeight: '600', fontSize: '17px', color: 'var(--ink-900)', marginBottom: '14px' } },
                'Скоро · Tez orada · Coming soon'),
            h('div', { style: { color: 'var(--ink-600)', fontSize: '13.5px', lineHeight: '1.7' } },
                h('div', null, 'Этот раздел скоро будет доступен.'),
                h('div', null, 'Bu bo‘lim tez orada ishga tushadi.'),
                h('div', null, 'This section will be available soon.'))));
}

async function renderComingSoon(viewRoot, ctx, renderFn) {
    viewRoot.style.position = 'relative';
    viewRoot.style.minHeight = '72vh';
    const bg = h('div', { class: 'coming-soon-bg', style: { position: 'relative' } });
    viewRoot.appendChild(bg);
    try { await renderFn(bg, ctx); } catch (e) { /* background is decorative — never block the gate */ }
    viewRoot.appendChild(comingSoonOverlay());
}

async function renderViewInner(viewRoot, viewName, ctx) {
    // LICENCE_CORE_V1 — a lapsed subscription outranks everything. It blocks every
    // module, not just unbought ones, so it must be checked first: otherwise a
    // locked clinic clicking «Пациенты» lands on the sales screen, which has
    // nothing to sell for a free-core module and renders a bare card with no way
    // forward. Two different locks, two different screens — see the spec's §4.
    const _lic = licenceState();
    // UPDATE_DELIVERY_V1 — 'updates' is exempted the same way 'activation'
    // is: update_status/update_approve/update_cancel are READ_ONLY /
    // ALWAYS_ALLOWED server-side (server/services/control/gate.js) precisely
    // so a licence-lapsed clinic can still receive and approve an update —
    // which may be exactly what fixes its own licensing situation. A screen
    // that then refused to even OPEN while locked would defeat that.
    // SETTINGS_SPLIT_V1 — the list is LOCKOUT_EXEMPT (see its own comment):
    // three of the four entries used to be one screen, and spelling them out
    // inline twice in this function is how the second call site below drifted
    // away from the first in the past.
    if (_lic.locked && !LOCKOUT_EXEMPT.has(viewName)) {
        await renderActivation(viewRoot, _lic);
        return;
    }
    // LICENCE_CORE_V1 — checked BEFORE the role gate. A clinic that has not bought
    // a module should be offered it, not told their role is wrong: two different
    // problems with two different fixes, and confusing them makes the clinic
    // phone their admin instead of their vendor.
    //
    // Lives here, on this function's own `viewRoot` param (the one tab actually
    // being rendered) — NOT in navigate(), which has no isRouteAllowed guard of
    // its own to sit beside (it only mounts a new tab and delegates the paint to
    // renderViewInto()/renderViewInner()), and not on the shared #view-root
    // container either: that div holds every open tab's root stacked as
    // siblings, and renderLockedModule() clears its target — clearing the shared
    // container would wipe every other open tab, not just this one.
    // UPDATE_DELIVERY_V1 — same exemption as the full-lockout branch above,
    // repeated here because isLicensed() has its OWN, separately-reasoned
    // `_licence.locked === true` short-circuit (see licence.js) that would
    // otherwise still catch 'updates' even after surviving the check above,
    // and render it through renderLockedModule() — which has no
    // LICENSED_MODULES entry for 'updates' (it is core, not sold separately)
    // and would show the wrong screen entirely ("Модуль не подключён").
    // SETTINGS_SPLIT_V1 — same list as the branch above, and it MUST be the
    // same one: 'subscription' and 'clinic-data' have no LICENSED_MODULES entry
    // either, so a locked clinic reaching them would land on a sales screen
    // with nothing to sell instead of on its own backups.
    if (!LOCKOUT_EXEMPT.has(viewName) && !isLicensed(viewName)) {
        await renderLockedModule(viewRoot, viewName);
        return;
    }
    if (!isRouteAllowed(viewName)) {
        viewRoot.appendChild(accessDenied());
        return;
    }
    // PLATFORM_ONLY_SECTIONS_V1 — block direct navigation to platform-only settings sections.
    if (viewName && viewName.startsWith('settings:') && isPlatformOnlySection(viewName.slice('settings:'.length)) && !isPlatformSuperAdmin()) {
        viewRoot.appendChild(accessDenied());
        return;
    }
    // SERVICE_SOON_V1 — these catalog sub-sections are parked behind a "coming soon" gate.
    if (viewName && viewName.startsWith('settings:') && !!SECTIONS[viewName.slice('settings:'.length)]?.comingSoon) {
        viewRoot.appendChild(h('div', { class: 'empty', style: { padding: '48px 24px', textAlign: 'center' } },
            h('div', { style: { fontWeight: '600', color: 'var(--ink-900)', marginBottom: '4px' } }, 'Скоро'),
            h('div', { class: 'muted' }, 'Этот раздел скоро будет доступен.')));
        return;
    }
    const state = { view: viewName, payload: ctx.payload };   // local shadow for the switch below
    try {
        switch (state.view) {
            case 'dashboard':     return void await renderDashboard(viewRoot, ctx);
            case 'public-site':   return void await renderPublicSite(viewRoot, ctx);   // PUBLIC_SITE_V1
            case 'patients':      return void await renderPatientsHub(viewRoot, ctx);   // PATIENTS_HUB_V1 — список · очередь · записи
            case 'visits':        return void await renderVisits(viewRoot, ctx);   // VISITS_V1
            case 'services':      return void await renderServices(viewRoot, ctx);   // SERVICES_CATALOG_V1
            case 'requests':      return void await renderRequestsInbox(viewRoot, ctx);   // REQUESTS_INBOX_V1
            case 'patient-card':  return void renderPatientCard(viewRoot, ctx);
            case 'appointments':  return void await renderRoomCalendar(viewRoot, ctx);   // RESCAL_WIRE_V1
            case 'consultation':       return void renderConsultation(viewRoot, ctx);
            case 'service-workspace':  return void renderServiceWorkspace(viewRoot, ctx);
            case 'registration':  return void renderRegistration(viewRoot, ctx);
            case 'cashier-shifts': return void await renderCashier(viewRoot, ctx);   // CASHIER_LOCAL_V1 — Касса workspace
            case 'cashier-head':   return void await renderCashierHead(viewRoot, ctx);   // CASHIER_LOCAL_V1 — head-cashier overview
            case 'labs':          return void await renderLaboratory(viewRoot, ctx);
            case 'inventory':     return void await renderInventory(viewRoot, ctx);   // INVENTORY_UI_V1
            case 'patient-documents': return void await renderPatientDocuments(viewRoot, ctx);   // PATIENT_DOCUMENTS_V1
            case 'procedures':    return void await renderProcedures(viewRoot, ctx);
            // QUEUE_BOARD_V1 — собственный маршрут доски цел: он и пункт меню
            // «Очередь», и адрес для роли, которой выдана ТОЛЬКО доска, без
            // картотеки. Внутри «Пациентов» та же доска живёт вкладкой.
            case 'queue':         return void await renderQueue(viewRoot, ctx);
            case 'crm':           return void await renderCrm(viewRoot, ctx);   // CRM_V1
            case 'docs-archive':  return void await renderDocsArchive(viewRoot, ctx);   // CLINICAL_DOCS_ARCHIVE_V1
            case 'admissions':    return void await renderAdmissions(viewRoot, ctx);   // ADMISSION_ORDER_V1
            case 'mar-sheet':     return void await renderMarSheet(viewRoot, ctx);   // MAR_SHEET_V1
            case 'mar-nurse':     return void await renderMarNurse(viewRoot, ctx);   // MAR_NURSE_V1
            case 'kitchen-sheet': return void await renderKitchenSheet(viewRoot, ctx);   // KITCHEN_SHEET_V1
            case 'discharge':     return void await renderDischarge(viewRoot, ctx);   // TWO_STEP_DISCHARGE_V1
            case 'beds':          return void await renderWardBeds(viewRoot, ctx);   // INPATIENT_LOCAL_V1
            case 'doctor-room':   return void await renderDoctorRoom(viewRoot, ctx);   // DOCTOR_ROOM_V1
            case 'pacs':          return void await renderComingSoon(viewRoot, ctx, renderPacs);          // COMING_SOON_V1
            case 'pharmacy':      return void await renderComingSoon(viewRoot, ctx, renderPharmacy);      // COMING_SOON_V1 / PHARMACY_V1
            case 'procurement':   return void await renderProcurement(viewRoot, ctx);   // PROCUREMENT_LIVE_V1 — unparked from Soon
            case 'marketing':     return void await renderComingSoon(viewRoot, ctx, renderMarketing);     // COMING_SOON_V1
            case 'callcenter':    return void await renderComingSoon(viewRoot, ctx, renderCallCenter);    // COMING_SOON_V1
            case 'reports':       return void await renderReports(viewRoot, ctx);
            case 'reports-hub':   return void await renderReportsHub(viewRoot, ctx);   // REPORTS_HUB_V1
            case 'documents':     return void await renderDocuments(viewRoot, ctx);
            case 'consultation-types': return void await renderConsultationTypes(viewRoot, ctx);   // CONSULTATION_TYPES_RESTORE
            case 'discounts-settings': return void await renderDiscountsSettings(viewRoot, ctx);   // PATIENT_DISCOUNTS_V1
            case 'api-settings': return void await renderApiSettings(viewRoot, ctx);   // CLINIC_API_V1
            case 'telegram-settings': return void await renderTelegramSettings(viewRoot, ctx);   // TELEGRAM_BOT_V1
            case 'telephony-settings': return void await renderTelephonySettings(viewRoot, ctx);   // TELEPHONY_V1
            case 'crm-settings': return void await renderCrmSettings(viewRoot, ctx);   // CRM_CONFIG_V1
            case 'telegram-chat': return void await renderTelegramChat(viewRoot, ctx);   // TELEGRAM_CHAT_V1
            case 'doctor-pay': return void await renderDoctorPay(viewRoot, ctx);   // DOCTOR_PAY_BULK_V1
            case 'referral-settings': return void await renderReferralSettings(viewRoot);   // REFERRAL_REWARDS_V1
            case 'cashier-settings':  return void await renderCashierSettings(viewRoot);    // CASHIER_SHIFT_MODE_V1
            case 'rooms-setup':       return void await renderRoomsSetup(viewRoot);       // ROOMS_SETUP_V1
            case 'settings':      return void await renderSettingsHub(viewRoot, ctx);   // SETTINGS_HUB_V1
            case 'employees':     return void await renderEmployees(viewRoot, ctx);   // EMPLOYEE_EDITOR_V1 — Сотрудники
            case 'documents-settings': return void await renderDocumentsSettings(viewRoot, ctx);   // DOCUMENTS_SETTINGS_V1
            // SETTINGS_SPLIT_V1 — ctx passed on purpose: it still carries
            // payload.sub, which is how the retired '#updates/subscription'
            // deep link is recognised and handed to the subscription screen.
            case 'updates':       return void await renderUpdates(viewRoot, ctx);   // UPDATE_DELIVERY_V1 — reachable from the banner + Settings; readable by anyone, actions gate themselves inside the view
            case 'subscription':  return void await renderSubscription(viewRoot, ctx);   // SETTINGS_SPLIT_V1 — подписка и модули
            case 'clinic-data':   return void await renderClinicData(viewRoot, ctx);     // SETTINGS_SPLIT_V1 — резервные копии и опасная зона
        }
        // Settings drilldown:  settings:<section_key>
        if (state.view.startsWith('settings:')) {
            const key = state.view.slice('settings:'.length);
            return void await renderSectionCrud(viewRoot, { sectionKey: key, onNavigate: navigate });
        }
        // Reports drilldown
        if (state.view.startsWith('report:')) {
            const key = state.view.slice('report:'.length);
            const def = SECTIONS[key];
            return void renderReport(viewRoot, { def: def || { label: key, description: '' }, onNavigate: navigate });
        }
        if (PLACEHOLDERS.has(state.view)) return void renderPlaceholder(viewRoot, { def: PLACEHOLDER_META[state.view], onNavigate: navigate });
        renderPlaceholder(viewRoot, { def: { label: 'Easy-Med', description: 'Pick a section from the sidebar.' }, onNavigate: navigate });
    } catch (e) {
        console.error('[Easy-Med] view error:', e);
        clear(viewRoot);
        viewRoot.appendChild(h('div', { class: 'error-state' },
            h('div', null, 'View failed to render.'),
            h('div', null, h('code', null, e.message || String(e))),
            h('button', { class: 'btn btn-outline', style: { marginTop: '12px' }, onclick: () => navigate(firstAllowedView()) }, 'Back to home'),
        ));
    }
}

// Shown when the active role tries to reach a section it isn't allowed.
function accessDenied() {
    const role = currentRoleLabel();
    return h('div', { class: 'error-state', style: { textAlign: 'center', padding: '48px 24px' } },
        h('div', { style: { color: 'var(--crit-700)', display: 'flex', justifyContent: 'center', marginBottom: '10px' } },
            Icon('Warning', { size: 28 })),
        h('div', { style: { fontSize: '17px', fontWeight: 700, color: 'var(--ink-900)' } }, 'No access'),
        h('div', { class: 'muted', style: { marginTop: '4px', fontSize: '13.5px' } },
            role ? `The “${role}” role doesn’t have access to this section.` : 'You don’t have access to this section.'),
        h('button', { class: 'btn btn-outline', style: { marginTop: '16px' }, onclick: () => navigate(firstAllowedView()) },
            'Go to my home page'),
    );
}

const PLACEHOLDER_META = {
    labs:     { label: 'Laboratory',           description: 'Order labs, view results, manage test catalog.' },
    procedures: { label: 'Procedures',          description: 'Очередь процедур — медсестра отмечает выполнение.' },
    pharmacy: { label: 'Pharmacy',             description: 'Inventory, dispensing, formulary management.' },
    beds:     { label: 'Ward & beds',          description: 'Real-time bed status, admissions, transfers.' },
};

// ---------------------------------------------------------------------------
// Sidebar render
// ---------------------------------------------------------------------------
function renderSidebar() {
    clear(sidebarEl);

    // NO_TABS_APPBAR_V1 — the «+ Новый пациент» CTA is gone (owner, 2026-09-05:
    // "and create patient button"). Registering a patient is not a thing the
    // sidebar has to shout on every screen; it is one click inside «Пациенты»,
    // whose own header carries «Создать пациента» (views/patients.js), and the
    // 'registration' route itself is untouched — bookmarks, deep links and
    // every onNavigate('registration') caller still open it.

    // PUBLIC_SITE_V1 — the Symptex public-profile screen (clinic users only;
    // hidden for the company-less platform super-admin). It used to be a second
    // CTA styled inline with color-mix(); it is now an ordinary nav item, so it
    // inherits the one active treatment instead of inventing a third look.
    if (isModuleAllowed('public-site') && window.easymed?.state?.user?.company_id) {
        const onPS = state.view === 'public-site';
        const navEl = h('div', { class: 'nav nav-list-top' });
        navEl.appendChild(h('button', {
            class: 'nav-item' + (onPS ? ' active' : ''),
            title: t('sidebar.publicSite', 'Публичный сайт'),
            onclick: () => navigate('public-site'),
        },
            h('span', { class: 'nav-icon' }, Icon('Globe', { size: 18 })),
            h('span', null, t('sidebar.publicSite', 'Публичный сайт')),
        ));
        sidebarEl.appendChild(navEl);
    }

    let currentHeaderEl = null;   // pending section header, appended lazily
    let currentNav = null;
    let currentNavHasItems = false;
    for (const item of NAV) {
        if (item.section) {
            // Defer rendering the section header + nav container until we know
            // at least one item under it is visible for the active role —
            // otherwise an empty "Operations" header would dangle.
            const navEl = h('div', { class: 'nav' });
            currentNav = navEl;
            currentNavHasItems = false;
            if (item.section === 'Soon') {
                // COMING_SOON_V1 — the parked-modules section is a collapsible
                // accordion: the chevron toggles it and the state persists.
                // Default collapsed (parked modules stay tucked away).
                const collapsed = localStorage.getItem('easymed_soon_collapsed') !== '0';
                if (collapsed) navEl.style.display = 'none';
                const chevEl = h('span', { class: 'nav-soon-chevron', style: {
                        marginLeft: 'auto', display: 'inline-flex',
                        transition: 'transform .18s ease',
                        transform: collapsed ? 'rotate(-90deg)' : 'none' } },
                    Icon('ChevronDown', { size: 14 }));
                currentHeaderEl = h('div', { class: 'nav-section nav-section--toggle', style: {
                        display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none' },
                    onclick: () => {
                        const willCollapse = navEl.style.display !== 'none';
                        navEl.style.display = willCollapse ? 'none' : '';
                        chevEl.style.transform = willCollapse ? 'rotate(-90deg)' : 'none';
                        try { localStorage.setItem('easymed_soon_collapsed', willCollapse ? '1' : '0'); } catch (e) {}
                    } },
                    h('span', null, t('sidebar.sections.' + item.section, item.section)),
                    chevEl);
            } else {
                currentHeaderEl = h('div', { class: 'nav-section' },
                    t('sidebar.sections.' + item.section, item.section));
            }
            continue;
        }
        // Hide modules the active role can't access (super admin = all).
        if (!isModuleAllowed(item.id)) continue;
        if (currentNav && !currentNavHasItems) {
            if (currentHeaderEl) sidebarEl.appendChild(currentHeaderEl);
            sidebarEl.appendChild(currentNav);
            currentNavHasItems = true;
        }
        if (!currentNav) {
            currentNav = h('div', { class: 'nav' });
            sidebarEl.appendChild(currentNav);
            currentNavHasItems = true;
        }
        const active = state.view === item.id || (item.id === 'settings' && (state.view.startsWith('settings') || state.view === 'documents'))
                                              || (item.id === 'reports'  && state.view.startsWith('report'))
                                              || (item.id === 'consultation' && state.view === 'service-workspace');
        const badgeText = formatBadge(navCounts[item.id]);
        // LICENCE_CORE_V1 — an unbought module stays VISIBLE and gets a lock mark.
        // Hiding it would hide what the clinic could buy, and nobody asks for a
        // feature they have never seen. Deliberately NOT folded into
        // isModuleAllowed() above: that gate hides, this one marks.
        const unlicensed = !isLicensed(item.id);
        currentNav.appendChild(h('button', {
            class: 'nav-item' + (active ? ' active' : '') + (unlicensed ? ' nav-locked' : ''),
            title: t('sidebar.nav.' + item.id, item.label),   // SIDEBAR_RAIL_V1 — readable when collapsed
            onclick: () => navigate(item.id),
        },
            h('span', { class: 'nav-icon' }, Icon(item.icon, { size: 18 })),
            h('span', null, t('sidebar.nav.' + item.id, item.label)),
            badgeText && h('span', {
                class: 'nav-badge' + (item.badgeKind === 'alert' && navCounts[item.id] > 0 ? ' alert' : ''),
            }, badgeText),
            unlicensed && h('span', { class: 'nav-lock-icon' }, Icon('Lock', { size: 14 })),
        ));
    }
}

// Format a count for the sidebar badge. Returns null when there's nothing to
// show (count unloaded or zero) — the caller skips rendering the chip then.
function formatBadge(n) {
    if (n == null) return null;
    if (n === 0)   return null;
    if (n < 1000)  return String(n);
    const k = n / 1000;
    return (k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')) + 'K';
}

// Pull real counts from Supabase + re-render the sidebar. Errors fail silent —
// the badges just don't appear, the rest of the app keeps working.
// UPDATE_BADGE_V1 — обновление ждёт установки: 1 или 0.
//
// Ошибку глотаем: бейдж — это подсказка, а не операция. Нет связи с control
// plane или роль без прав — бейджа просто нет, что честнее, чем зажечь его на
// пустом месте и отправить человека искать несуществующее обновление.
async function loadUpdateBadge() {
    try {
        const { data, error } = await supabase.rpc('update_status', {});
        if (error || !data) return;
        const LIVE = ['downloading', 'verifying', 'unpacking', 'snapshot', 'switching'];
        const busy = data.progress && LIVE.indexOf(data.progress.phase) !== -1;
        const offered = !!(data.offer && data.offer.version && data.offer.version !== data.current_version);
        navCounts.settings = (busy || offered) ? 1 : 0;
    } catch (e) { /* подсказка, не операция */ }
}

async function loadNavCounts() {
    // UPDATE_BADGE_V1 — своим вызовом, а не внутри чужого try: упавший
    // запрос пациентов не должен молча гасить бейдж обновления.
    loadUpdateBadge();
    // PHASE2A_SHELL — once trimmed to the Patients count only, because the
    // other badge tables didn't exist in local mode yet. Restored since:
    // telegram-chat (TELEGRAM_CHAT_BADGE_V1) and invoices
    // (CASHIER_UNPAID_BADGE_V1) below. visits/visit_services counts are still
    // gone along with their NAV entries.
    try {
        const navCid = (window.CLINIC && window.CLINIC.id) || null;
        const scopeCid = (q) => navCid ? q.eq('company_id', navCid) : q;   // M1 — badge counts must match their clinic-scoped lists (RLS-bypass roles)
        const pRes = await scopeCid(supabase.from('patients').select('id', { count: 'exact', head: true }).eq('active', true));
        if (!pRes.error) navCounts.patients = pRes.count ?? 0;
    } catch (e) {
        console.warn('[nav counts]', e.message);
    }
    // TELEGRAM_CHAT_BADGE_V1 — непрочитанные сообщения пациентов.
    //
    // Свой try, а не общий с пациентами: один упавший счётчик не должен гасить
    // остальные (ровно это и случилось у прежних badge-запросов выше).
    // isModuleAllowed — потому что telegram_chat_unread закрыт requireChatView:
    // у врача или кассира раздела нет, и без проверки они получали бы 403
    // каждые 20 секунд фонового опроса.
    if (isModuleAllowed('telegram-chat')) {
        try {
            const { data, error } = await supabase.rpc('telegram_chat_unread');
            if (!error && data) navCounts['telegram-chat'] = data.unread ?? 0;
        } catch (e) {
            console.warn('[nav counts] telegram:', e.message);
        }
    }
    // CASHIER_UNPAID_BADGE_V1 — сколько счетов ещё ждут оплаты. Статусы — те же
    // три, что server/services/domain/money.js::OUTSTANDING_STATUSES ('unpaid',
    // 'partial', 'debt'): 'debt' обязан быть здесь — однажды он уже «исчезал» из
    // дашборда, пока касса его считала (см. заголовок money.js). void/refunded
    // не долг. Свой try — по той же причине, что у телеграма выше.
    //
    // НЕ scopeCid: у invoices в schema-registry нет фильтра company_id (локальный
    // режим не мультиарендный), и обёртка превращала бы каждый опрос в 4xx.
    if (isModuleAllowed('cashier-shifts')) {
        try {
            const iRes = await supabase.from('invoices')
                .select('id', { count: 'exact', head: true })
                .in('status', ['unpaid', 'partial', 'debt']);
            if (!iRes.error) navCounts['cashier-shifts'] = iRes.count ?? 0;
        } catch (e) {
            console.warn('[nav counts] cashier:', e.message);
        }
    }
    renderSidebar();
}

// SERVICE_SCOPE_V1 — self-heal the badges so they clear shortly after the user acts
// (completes a service / takes a payment) even without navigating.
if (typeof window !== 'undefined') {
    window.easymed = window.easymed || {};
    window.easymed.refreshNav = loadNavCounts;
    if (!window.__emNavTimer) window.__emNavTimer = setInterval(() => loadNavCounts(), 20000);
    // SERVICE_REALTIME_V1 — instant badge updates when a patient is routed to a section,
    // paid at the cashier, or a service is completed. Debounced; fails silent if realtime
    // isn't enabled (the 20s poll above is the fallback).
    if (!window.__emNavRealtime) {
        try {
            let _rt = null;
            const ping = () => { clearTimeout(_rt); _rt = setTimeout(() => loadNavCounts(), 800); };
            window.__emNavRealtime = supabase.channel('em-nav-badges')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'visit_services' }, ping)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, ping)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, ping)
                .subscribe();
        } catch (e) { console.warn('[nav realtime]', e.message); }
    }
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------
function renderCrumbs() {
    // Crumbs element was removed from the topbar — bail out cleanly so
    // no caller crashes if it still invokes renderCrumbs() out of habit.
    if (!crumbsEl) return;
    let crumbs = CRUMBS[state.view];
    if (!crumbs) {
        if (state.view.startsWith('settings:')) {
            const def = SECTIONS[state.view.slice(9)];
            crumbs = ['Insights', 'Settings', def?.label || state.view.slice(9)];
        } else if (state.view.startsWith('report:')) {
            const def = SECTIONS[state.view.slice(7)];
            crumbs = ['Insights', 'Reports', def?.label || state.view.slice(7)];
        } else {
            crumbs = [state.view];
        }
    }
    // Translate known segments (sections + standard module labels). Anything
    // not in the dictionary (e.g. a settings-section label coming from
    // sections.js) is shown as-is. Mapping keys are the raw English strings.
    const TR_SEG = {
        'Clinical':   t('sidebar.sections.Clinical',   'Clinical'),
        'Operations': t('sidebar.sections.Operations', 'Operations'),
        'Insights':   t('sidebar.sections.Insights',   'Insights'),
        'Patients':              t('sidebar.nav.patients',     'Patients'),
        'Календарь записи':      t('sidebar.nav.appointments', 'Календарь записи'),
        'My services':           t('sidebar.nav.consultation', 'My services'),
        'Laboratory':            t('sidebar.nav.labs',         'Laboratory'),
        'Ward & beds':           t('sidebar.nav.beds',         'Ward & beds'),
        'Inpatient ward':        t('sidebar.nav.admissions',   'Inpatient ward'),   // ADMISSION_ORDER_V1
        'Treatment tasks':       t('sidebar.nav.mar-nurse',     'Treatment tasks'),   // MAR_NURSE_V1
        'Treatment sheet':       t('sidebar.nav.mar-sheet',     'Treatment sheet'),   // MAR_SHEET_V1
        'Kitchen sheet':         t('sidebar.nav.kitchen-sheet', 'Kitchen sheet'),   // KITCHEN_SHEET_V1
        'Discharges':            t('sidebar.nav.discharge',    'Discharges'),   // TWO_STEP_DISCHARGE_V1
        'Pharmacy':              t('sidebar.nav.pharmacy',     'Pharmacy'),
        'Cashier':               t('sidebar.nav.cashier',      'Cashier'),
        'Procurement':           t('sidebar.nav.procurement',  'Procurement'),
        'Marketing':             t('sidebar.nav.marketing',    'Marketing'),
        'Call center':           t('sidebar.nav.callcenter',   'Call center'),
        'Dashboard':             t('sidebar.nav.dashboard',    'Dashboard'),
        'Reports':               t('sidebar.nav.reports',      'Reports'),
        'Settings':              t('sidebar.nav.settings',     'Settings'),
        'Patient':               t('crumbs.patient',           'Patient'),
        'Patient workspace':     t('crumbs.workspace',         'Patient workspace'),
        'New patient registration': t('crumbs.registration',   'New patient registration'),
        'Documents':             t('crumbs.documents',         'Documents'),
    };
    crumbs = crumbs.map(c => TR_SEG[c] || c);

    // Map a NAV label (e.g. "Patients", "Settings") back to its route id so the
    // breadcrumb can navigate. Section labels (Clinical / Operations / Insights)
    // aren't routes and stay as plain text. Built from both raw and translated
    // labels so a clicked translated crumb still routes correctly.
    const labelToView = {};
    for (const item of NAV) if (item.id) {
        labelToView[item.label] = item.id;
        labelToView[t('sidebar.nav.' + item.id, item.label)] = item.id;
    }

    clear(crumbsEl);
    crumbs.forEach((c, i) => {
        if (i > 0) crumbsEl.appendChild(h('span', { class: 'sep' }, '›'));
        const isLast = i === crumbs.length - 1;
        const target = !isLast ? labelToView[c] : null;
        if (target) {
            crumbsEl.appendChild(h('button', {
                style: { background: 'none', border: 0, padding: 0, margin: 0, color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit' },
                onmouseover: (e) => { e.currentTarget.style.textDecoration = 'underline'; },
                onmouseout:  (e) => { e.currentTarget.style.textDecoration = 'none'; },
                onclick: () => navigate(target),
            }, c));
        } else {
            crumbsEl.appendChild(h('span', { class: isLast ? 'current' : '' }, c));
        }
    });
}

// ---------------------------------------------------------------------------
// Settings + Reports landing pages
// ---------------------------------------------------------------------------
// Icon assignments — keep the visual cue consistent across the sidebar,
// header crumbs, and this index. New sections inherit the Folder icon
// until somebody adds them here.
const SECTION_ICONS = {
    patients:                   'Patients',
    services:                   'Flask',
    service_categories:         'Folder',
    service_types:              'Filter',
    ikpu_codes:                 'ID',
    product_nnm:                'Pill',
    users:                      'User',
    positions:                  'ID',
    roles:                      'Settings',
    cashiers:                   'Wallet',
    virtual_doctors:            'Stethoscope',
    departments:                'Building',
    payer_policies:             'Doc',
    payers:                     'Wallet',
    payment_providers:          'Coins',
    cashback:                   'Coins',
    companies:                  'Building',
    branches:                   'MapPin',
    referral_sources:           'Send',
    referral_source_categories: 'Folder',
    doctor_prices:              'Wallet',
    doctor_referral_bonuses:    'Wallet',
    patient_categories:         'Patients',
    wards:                      'Bed',
    beds_settings:              'Bed',
    floors:                     'Layers',
    rooms:                      'MapPin',
};
const GROUP_META = {
    'General':                  { icon: 'Folder',     color: '#0ea5e9' },
    'Service settings':         { icon: 'Flask',      color: '#a855f7' },
    'User & staff management':  { icon: 'Patients',   color: 'var(--primary-600)' },
    'Payer management':         { icon: 'Wallet',     color: '#16a34a' },
    'Branch management':        { icon: 'Building',   color: '#0284c7' },
    'Referrals':                { icon: 'Send',       color: '#f97316' },
    'Doctor salary':            { icon: 'Wallet',     color: '#16a34a' },
    'Rooms & floors':           { icon: 'Building',   color: '#0d9488' },
    'Inpatient':                { icon: 'Bed',        color: '#a855f7' },
};
const SECTION_DESCRIPTIONS = {
    patients:                   'Patient register · demographics, contacts, MRN',
    services:                   'All bookable services · pricing · tube colours',
    service_categories:         'Category / direction tree under each type',
    service_types:              'Top-level buckets (Consultation, Lab, Diagnostics…)',
    ikpu_codes:                 'IKPU codes for fiscal receipts',
    product_nnm:                'Marked goods (NNM) catalogue',
    users:                      'Employees · doctors, nurses, reception, admin',
    positions:                  'Job titles for the employee directory',
    roles:                      'Access roles with allowed sidebar sections',
    cashiers:                   'Cashier-desk assignments',
    virtual_doctors:            'Tele-medicine doctor profiles',
    departments:                'Clinical departments and their heads',
    payer_policies:             'Insurance + corporate plans',
    payers:                     'Payer companies — insurers, employers, government',
    payment_providers:          'Online payment channels + processing fee %',
    cashback:                   'Cashback rules returned to patients on payment',
    companies:                  'Legal entities owning the clinic network',
    branches:                   'Physical clinic locations',
    referral_sources:           'Where patients come from',
    referral_source_categories: 'Referral source buckets',
    doctor_prices:              'Per-doctor service pricing overrides',
    doctor_referral_bonuses:    'Doctor referral bonus rules',
    patient_categories:         'Patient tiers (VIP, regular, …)',
    wards:                      'Inpatient wards',
    beds_settings:              'Bed inventory per ward',
    floors:                     'Building floors / levels',
    rooms:                      'Consulting & procedure rooms per floor',
};

// PLATFORM_ONLY_SECTIONS_V1 — Geography + Access-requests settings are EasyMed-PLATFORM
// reference/admin data, NOT clinic-configurable. Clinic owners/admins (even with full
// access) must not see or open them; only a platform super-admin (users.is_super_admin)
// may. Hardcoded here rather than a sections.js flag because permissions.js/sections.js are
// BARE imports (CF-cached ~4h) — enforcing in the cache-busted admin.js takes effect now.
// ROLE_EDITOR_AVAIL_V1 — platform-only + coming-soon now live as flags on each section in sections.js
// (platformOnly / comingSoon) so the gating here and the Roles editor share ONE source of truth.
function isPlatformOnlySection(key) { return !!SECTIONS[key]?.platformOnly; }
function isPlatformSuperAdmin() { try { return window?.easymed?.state?.user?.is_super_admin === true; } catch (e) { return false; } }

function renderSettingsIndex(container) {
    clear(container);
    const buckets = new Map();
    const top = [];
    for (const [key, def] of Object.entries(SECTIONS)) {
        if (def.hidden || !def.table) continue;
        // Only list sub-sections the active role can open.
        if (!isRouteAllowed('settings:' + key)) continue;
        if (isPlatformOnlySection(key) && !isPlatformSuperAdmin()) continue;   // PLATFORM_ONLY_SECTIONS_V1
        if (def.group) {
            if (!buckets.has(def.group)) buckets.set(def.group, []);
            buckets.get(def.group).push([key, def]);
        } else top.push([key, def]);
    }
    const cardEls = [];
    // 'Documents' isn't a table-backed section — it opens its own view. It now
    // lives inside Settings under the General card (subject to the same route
    // permission it had as a top-level nav item).
    const generalExtras = [
        ...(isRouteAllowed('documents') ? [documentsRow()] : []),
        ...(isRouteAllowed('discounts-settings') ? [discountsRow()] : []),   // PATIENT_DISCOUNTS_V1
        ...(isRouteAllowed('api-settings') ? [apiRow()] : []),   // CLINIC_API_V1
    ];
    const consultExtras = isRouteAllowed('consultation-types') ? [consultRow()] : [];   // CONSULTATION_TYPES_RESTORE
    const doctorPayExtras = isRouteAllowed('doctor-pay') ? [doctorPayRow()] : [];   // DOCTOR_PAY_BULK_V1
    const referralExtras = isRouteAllowed('referral-settings') ? [referralRewardRow()] : [];   // REFERRAL_REWARDS_V1
    const cashierSetExtras = isRouteAllowed('cashier-settings') ? [cashierSettingsRow()] : [];   // CASHIER_SHIFT_MODE_V1
    const roomsSetupExtras = isRouteAllowed('rooms-setup') ? [roomsSetupRow()] : [];   // ROOMS_SETUP_V1
    // SETTINGS_ORDER_V1 — explicit card order; any unlisted group is appended after.
    const _cardByName = new Map();
    if (top.length || generalExtras.length) _cardByName.set('General', groupCard('General', top, generalExtras));
    for (const [name, items] of buckets) _cardByName.set(name, groupCard(name, items, name === 'Service settings' ? consultExtras : name === 'Referrals' ? referralExtras : name === 'User & staff management' ? cashierSetExtras : name === 'Rooms & floors' ? roomsSetupExtras : []));   // REFERRAL_REWARDS_V1 + CASHIER_SHIFT_MODE_V1
    // LAB_ROLE_SETTINGS_V2 — the non-table extras (consultation types,
    // referrals, doctor pay) attach to their group card above ONLY when a
    // table-backed section already created it. A role granted just the extra
    // would lose the row. Create the card here when its group is absent but
    // has extras. (LAB_PANELS_BY_SECTION_V1: lab settings left this list —
    // panels are edited from Лаборатория, not from Settings.)
    if (consultExtras.length && !_cardByName.has('Service settings'))
        _cardByName.set('Service settings', groupCard('Service settings', [], consultExtras));
    if (referralExtras.length && !_cardByName.has('Referrals'))
        _cardByName.set('Referrals', groupCard('Referrals', [], referralExtras));
    if (roomsSetupExtras.length && !_cardByName.has('Rooms & floors')) _cardByName.set('Rooms & floors', groupCard('Rooms & floors', [], roomsSetupExtras));   // ROOMS_SETUP_V1
    if (doctorPayExtras.length && !_cardByName.has('Doctor salary')) _cardByName.set('Doctor salary', groupCard('Doctor salary', [], doctorPayExtras));   // DOCTOR_PAY_BULK_V1
    const _groupOrder = ['Branch management', 'User & staff management', 'Service settings', 'General', 'Rooms & floors', 'Inpatient', 'Payer management', 'Referrals', 'Doctor salary'];
    for (const _n of _groupOrder) { if (_cardByName.has(_n)) { cardEls.push(_cardByName.get(_n)); _cardByName.delete(_n); } }
    for (const _c of _cardByName.values()) cardEls.push(_c);

    // Filter every row + collapse empty cards as the user types. Pure
    // client-side, no re-render — keeps the cursor in the input.
    const searchInput = h('input', {
        placeholder: 'Search settings…',
        style: {
            height: '38px', padding: '0 14px 0 36px',
            border: '1px solid var(--ink-200)', borderRadius: '10px',
            fontSize: '13.5px', width: '280px',
            background: 'white', outline: 'none',
            fontFamily: 'inherit',
        },
        oninput: (e) => {
            const t = e.target.value.trim().toLowerCase();
            for (const card of cardEls) {
                let visible = 0;
                for (const btn of card.querySelectorAll('[data-settings-key]')) {
                    const lbl  = (btn.dataset.label || '').toLowerCase();
                    const desc = (btn.dataset.desc  || '').toLowerCase();
                    const ok = !t || lbl.includes(t) || desc.includes(t);
                    btn.style.display = ok ? '' : 'none';
                    if (ok) visible++;
                }
                card.style.display = visible === 0 ? 'none' : '';
            }
        },
    });

    container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Settings'),
                h('p',  { class: 'page-subtitle' }, 'Manage clinic data — services, users, payers, branches, referrals, doctor pricing, and more.'),
            ),
            h('div', { style: { position: 'relative', display: 'flex', alignItems: 'center' } },
                h('span', { style: { position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)', pointerEvents: 'none' } },
                    Icon('Search', { size: 14 })),
                searchInput,
            ),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', alignItems: 'stretch' } }, ...cardEls),
    ));

    function groupCard(name, items, extraRows = []) {
        const meta = GROUP_META[name] || { icon: 'Folder', color: 'var(--primary-600)' };
        const count = items.length + extraRows.length;
        return h('div', { class: 'card', style: { overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%' } },
            // Group header — coloured icon chip + name + section count.
            h('div', { style: {
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '14px 16px',
                borderBottom: '1px solid var(--ink-100)',
            } },
                h('div', {
                    style: {
                        width: '34px', height: '34px', borderRadius: '9px',
                        display: 'grid', placeItems: 'center',
                        background: meta.color + '1a',   // 10% tint
                        color: meta.color,
                        flex: '0 0 34px',
                    },
                }, Icon(meta.icon, { size: 17 })),
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)' } }, name),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '1px' } },
                        `${count} section${count === 1 ? '' : 's'}`),
                ),
            ),
            h('div', { style: { padding: '6px 6px 8px' } }, ...items.map(([key, def]) => sectionRow(key, def)), ...extraRows),
        );
    }

    function sectionRow(key, def) {
        const _soon = !!SECTIONS[key]?.comingSoon;   // SERVICE_SOON_V1 / ROLE_EDITOR_AVAIL_V1
        return settingsRow({
            key,
            iconName: SECTION_ICONS[key] || 'Folder',
            label:    (def.label || key) + (_soon ? '  \u00b7  Скоро' : ''),
            desc:     _soon ? 'Раздел скоро будет доступен' : (SECTION_DESCRIPTIONS[key] || ''),
            onClick:  _soon ? () => {} : () => navigate('settings:' + key),
            soon:     _soon,
        });
    }

    // Non-table General entry: opens the standalone Documents view.
    function documentsRow() {
        return settingsRow({
            key:      'documents',
            iconName: 'Doc',
            label:    'Documents',
            desc:     'Printable templates & document settings',
            onClick:  () => navigate('documents'),
        });
    }
    function consultRow() {
        return settingsRow({
            key:      'consultation-types',
            iconName: 'Stethoscope',
            label:    'Консультации врачей',
            desc:     'Типы консультаций (RU/UZ/EN) и цены по каждому врачу',
            onClick:  () => navigate('consultation-types'),
        });
    }
    function roomsSetupRow() {   // ROOMS_SETUP_V1
        return settingsRow({
            key:      'rooms-setup',
            iconName: 'Bed',
            label:    'Помещения — кабинеты и палаты',
            desc:     'Один экран: кабинет или палата, койки и цена проживания создаются одним окном',
            onClick:  () => navigate('rooms-setup'),
        });
    }
    function cashierSettingsRow() {   // CASHIER_SHIFT_MODE_V1
        return settingsRow({
            key:      'cashier-settings',
            iconName: 'Wallet',
            label:    'Смены кассы',
            desc:     'Вручную или автоматическое закрытие/открытие смены в 00:00',
            onClick:  () => navigate('cashier-settings'),
        });
    }
    function referralRewardRow() {   // REFERRAL_REWARDS_V1
        return settingsRow({
            key:      'referral-settings',
            iconName: 'Coins',
            label:    'Реферальное вознаграждение',
            desc:     'Общие ставки % по группам услуг — для источников с режимом «Общий»',
            onClick:  () => navigate('referral-settings'),
        });
    }
    function doctorPayRow() {   // DOCTOR_PAY_BULK_V1
        return settingsRow({
            key:      'doctor-pay',
            iconName: 'Wallet',
            label:    'Зарплата врачей',
            desc:     'Массово задать долю врача (%) по услугам — всем или выбранным',
            onClick:  () => navigate('doctor-pay'),
        });
    }
    function discountsRow() {
        return settingsRow({
            key:      'discounts-settings',
            iconName: 'Coins',
            label:    'Скидки пациентов',
            desc:     'Промокоды, подарочные карты и сертификаты — лимиты и привязка к пациентам',
            onClick:  () => navigate('discounts-settings'),
        });
    }
    function apiRow() {
        return settingsRow({
            key:      'api-settings',
            iconName: 'Key',
            label:    'API',
            desc:     'Токены для интеграции с Symptex и партнёрами + документация',
            onClick:  () => navigate('api-settings'),
        });
    }

    function settingsRow({ key, iconName, label, desc, onClick, soon }) {
        return h('button', {
            class: 'settings-row' + (soon ? ' settings-row--soon' : ''),
            dataset: { settingsKey: key, label, desc },
            style: {
                width: '100%',
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '10px 12px',
                border: '0', borderRadius: '8px',
                background: 'transparent',
                textAlign: 'left',
                cursor: soon ? 'default' : 'pointer',
                opacity: soon ? '0.5' : '1',
                fontFamily: 'inherit',
                transition: 'background-color 120ms ease',
            },
            onmouseover: soon ? () => {} : (e) => { e.currentTarget.style.background = 'var(--ink-25)'; },
            onmouseout:  soon ? () => {} : (e) => { e.currentTarget.style.background = 'transparent'; },
            onclick: onClick,
        },
            h('div', {
                style: {
                    width: '32px', height: '32px', borderRadius: '8px',
                    display: 'grid', placeItems: 'center',
                    background: 'var(--ink-25)',
                    color: 'var(--ink-600)',
                    flex: '0 0 32px',
                },
            }, Icon(iconName, { size: 15 })),
            h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, label),
                desc && h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, desc),
            ),
            h('span', { style: { color: 'var(--ink-300)', flex: '0 0 14px', display: 'flex' } },
                Icon('ChevronRight', { size: 14 })),
        );
    }
}

function renderReportsIndex(container) {
    clear(container);
    const buckets = new Map();
    for (const [key, def] of Object.entries(SECTIONS)) {
        if (def.type !== 'report') continue;
        const g = def.group || 'General';
        if (!buckets.has(g)) buckets.set(g, []);
        buckets.get(g).push([key, def]);
    }
    const cardEls = [];
    for (const [name, items] of buckets) {
        cardEls.push(h('div', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, name)),
            h('div', { style: { padding: '6px 0' } }, ...items.map(([key, def]) =>
                h('button', {
                    class: 'nav-item',
                    style: { margin: '1px 10px', width: 'calc(100% - 20px)' },
                    onclick: () => navigate('report:' + key),
                }, h('span', { class: 'nav-icon' }, Icon('Chart', { size: 14 })), h('span', null, def.label || key)),
            )),
        ));
    }
    container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Reports & analytics'),
                h('p',  { class: 'page-subtitle' }, 'Operational KPIs, financial reports, clinical metrics.'),
            ),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' } }, ...cardEls),
    ));
}

// ---------------------------------------------------------------------------
// Connection chip
// ---------------------------------------------------------------------------
// Last-known status key + ok flag — so we can re-render the chip in the new
// language whenever the user switches.
let _lastStatusKey = 'connecting';
let _lastStatusOk  = true;

function setStatus(key, ok) {
    _lastStatusKey = key; _lastStatusOk = ok;
    if (!statusEl) return;
    statusEl.classList.toggle('is-off', !ok);
    clear(statusEl);
    statusEl.appendChild(h('span', { class: 'dot' }));
    statusEl.appendChild(document.createTextNode(' ' + t('topbar.' + key, key)));
}

// ---------------------------------------------------------------------------
// Route persistence
// ---------------------------------------------------------------------------
const ROUTE_KEY = 'easymed:route';
function saveRoute(v) { try { localStorage.setItem(ROUTE_KEY, v); } catch {} }
function loadRoute()  { try { return localStorage.getItem(ROUTE_KEY); } catch { return null; } }

// ---------------------------------------------------------------------------
// User card
// ---------------------------------------------------------------------------
function paintUserCard() {
    document.getElementById('user-avatar').textContent = initials(state.user.full_name);
    document.getElementById('user-name').textContent   = state.user.full_name;
    const label = currentRoleLabel();
    document.getElementById('user-role').textContent = label
        || ((state.user.role || 'user').charAt(0).toUpperCase() + (state.user.role || 'user').slice(1));
}

// ---------------------------------------------------------------------------
// Role preview — until a real login lands, this lets an admin see the app
// exactly as a given role would. Super admin always has full access; picking
// a role applies that role's section permissions to the sidebar + routes.
// ---------------------------------------------------------------------------
const PREVIEW_KEY = 'easymed:preview-role';
let rolesCache = [];

async function loadRolesForPreview() {
    const { data, error } = await supabase
        .from('roles')
        .select('id, name, permissions, active')
        .order('name', { ascending: true });
    if (error) { console.warn('[role preview] load failed:', error.message); rolesCache = []; return; }
    rolesCache = data || [];
}

function applyPreview(roleId, { persist = true } = {}) {
    if (!roleId) {
        setFullAccess('Super Admin');
    } else {
        const role = rolesCache.find(r => r.id === roleId);
        if (role) setEffectiveFromRole(role);
        else      setFullAccess('Super Admin');
    }
    if (persist) {
        try { roleId ? localStorage.setItem(PREVIEW_KEY, roleId) : localStorage.removeItem(PREVIEW_KEY); } catch {}
    }
    paintUserCard();
    renderSidebar();
    // If the current view is no longer permitted, bounce to the first
    // module the previewed role can reach.
    if (!isRouteAllowed(state.view)) navigate(firstAllowedView());
    else renderView();
}

// Account controls — the "View as role" switcher (super admin only) +
// Log out button. Mounts inside the topbar user-card popover; the popover
// is toggled by the avatar button next to the language switcher.
function renderAccountControls() {
    const foot = document.getElementById('user-popover');
    if (!foot) return;
    const old = document.getElementById('account-controls');
    if (old) old.remove();

    const wrap = h('div', { id: 'account-controls', style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } });

    // Role-preview switcher — only super admins may impersonate roles.
    if (state.user.is_super_admin) {
        let saved = null;
        try { saved = localStorage.getItem(PREVIEW_KEY); } catch {}
        if (saved && !rolesCache.some(r => r.id === saved)) saved = null;
        const select = h('select', {
            id: 'role-preview-select',
            style: {
                width: '100%', height: '32px', padding: '0 8px',
                border: '1px solid var(--ink-200)', borderRadius: '8px',
                fontSize: '12.5px', fontFamily: 'inherit', background: 'white',
                color: 'var(--ink-800)', cursor: 'pointer',
            },
            onchange: (e) => applyPreview(e.target.value || null),
        },
            h('option', { value: '', selected: !saved }, 'Super Admin (full access)'),
            ...rolesCache.map(r => h('option', { value: r.id, selected: saved === r.id }, r.name || 'Role')),
        );
        wrap.appendChild(h('div', null,
            h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' } }, 'View as role'),
            select,
        ));
        if (saved) applyPreview(saved, { persist: false });
    }

    // Self-service password change — available to every signed-in user.
    wrap.appendChild(h('button', {
        class: 'btn btn-outline',
        style: { width: '100%', justifyContent: 'center', fontSize: '12.5px' },
        onclick: () => { document.getElementById('user-popover')?.setAttribute('hidden', ''); openChangePasswordModal(); },
    }, Icon('Shield', { size: 13 }), ' Сменить пароль'));

    wrap.appendChild(h('button', {
        class: 'btn btn-outline',
        style: { width: '100%', justifyContent: 'center', fontSize: '12.5px' },
        onclick: logout,
    }, Icon('ArrowRight', { size: 13 }), ' Log out'));

    foot.appendChild(wrap);
}

// Change-password modal — uses supabase.auth.updateUser, which rotates the
// password of the CURRENT session's user. No admin rights needed; every role
// can change their own password here.
function openChangePasswordModal() {
    const overlay = h('div', { class: 'modal', style: { zIndex: '9000' } });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const errEl  = h('div', { style: { color: 'var(--crit-700)', fontSize: '12.5px', minHeight: '16px' } });
    const inpStyle = {
        width: '100%', height: '38px', padding: '0 12px', boxSizing: 'border-box',
        border: '1px solid var(--ink-200)', borderRadius: '9px',
        fontSize: '13.5px', fontFamily: 'inherit', outline: 'none',
    };
    const passInp  = h('input', { type: 'password', placeholder: 'Новый пароль (мин. 8 символов)', autocomplete: 'new-password', style: inpStyle });
    const pass2Inp = h('input', { type: 'password', placeholder: 'Повторите пароль', autocomplete: 'new-password', style: inpStyle });

    const saveBtn = h('button', { class: 'btn btn-primary', style: { minWidth: '120px', justifyContent: 'center' } }, 'Сохранить');
    saveBtn.addEventListener('click', async () => {
        errEl.textContent = '';
        const p1 = passInp.value, p2 = pass2Inp.value;
        if (p1.length < 8)  { errEl.textContent = 'Минимум 8 символов.'; passInp.focus(); return; }
        if (p1 !== p2)      { errEl.textContent = 'Пароли не совпадают.'; pass2Inp.focus(); return; }
        saveBtn.disabled = true;
        try {
            const { error } = await supabase.auth.updateUser({ password: p1, data: { password_set: true } });
            if (error) { errEl.textContent = 'Не удалось сменить пароль: ' + error.message; return; }
            close();
            toast('Пароль изменён.');
        } catch (e) {
            errEl.textContent = 'Ошибка: ' + (e.message || e);
        } finally {
            saveBtn.disabled = false;
        }
    });

    const card = h('div', { class: 'modal-card', style: { width: '380px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Shield', { size: 16 }), ' Сменить пароль'),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                'Новый пароль вступает в силу сразу; активные сессии на других устройствах не разрываются.'),
            passInp, pass2Inp, errEl,
        ),
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),   // BTNS_RIGHT_V1
            h('button', { class: 'btn', onclick: close }, 'Отмена'),
            saveBtn,
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => passInp.focus(), 0);
    const onKey = (ev) => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
}

function logout() {
    // Clear role-preview pick (Supabase Auth's session is wiped by signOut
    // inside signOutAndReload — see js/admin/auth.js).
    try { localStorage.removeItem(PREVIEW_KEY); } catch {}
    signOutAndReload();
}

// Resolve which section permissions are in force for the signed-in actor.
//   Super Admin (is_super_admin === true) → god-mode, sidebar label "Super Admin".
//   Plain Admin (role text 'admin' + is_super_admin false) → role_id flow,
//       label comes from the role row ("Admin"). Functionally full access
//       since the Admin role grants every section, but the user is labeled
//       distinctly and could later be restricted by editing the Admin role.
//   Any other role_id → that role's permissions + label.
//   No role_id → fallback by classification (doctor label or none).
async function applyActorPermissions(actor) {
    if (actor.is_super_admin) { setFullAccess('Super Admin'); return; }
    // CLINIC_ADMIN_FULL_ACCESS_V1 — the clinic owner/admin (role 'admin' + a company)
    // always has full access; staff roles apply only to non-admin users. Wins over any
    // role that may have been assigned, so an admin can never be locked out of their clinic.
    if (actor.is_admin) { setFullAccess('Администратор клиники'); return; }
    // LOCAL_ROLES_V1 — this local app has no dynamic roles table; access for the
    // 7 fixed staff roles is configured in Settings → Roles & permissions and
    // stored one row per role in `role_permissions` (permissions = a JSON string
    // { sections:[...navIds], levels:{navId:'viewer'|'editor'|'admin'} } consumed
    // verbatim by setEffectiveFromRole). Admins never reach here (full access is
    // granted above). A missing/invalid row falls through to the fail-closed
    // defaults below.
    if (actor.role) {
        // MULTI_ROLE_V1 — a user's UI access is the UNION of their primary role plus
        // any extra_roles (Employees → «Дополнительные роли»). Load every role's row
        // and union via setEffectiveFromRoles (primary first, so its name stays the
        // label).
        //
        // MULTI_ROLE_SERVER_V1 — extras now widen SERVER data access too
        // (services/roles.js effectiveRoles), so this union no longer promises
        // screens the API will refuse. It used to: extras moved the sidebar only,
        // and a склад employee given the registrar role saw the CRM board and got a
        // bare «not allowed» on save. What still does NOT grant data access is the
        // module matrix below — ticking a module opens a MENU, never a table.
        let extra = [];
        if (actor.id) {
            try {
                const { data: u } = await supabase.from('users').select('extra_roles').eq('id', actor.id).maybeSingle();
                let e = u && u.extra_roles;
                if (typeof e === 'string') { try { e = JSON.parse(e); } catch (_) { e = []; } }
                if (Array.isArray(e)) extra = e.filter(Boolean);
            } catch (_) { /* column absent pre-migration 020 → primary role only */ }
        }
        const roleNames = [actor.role, ...extra].filter((r, i, a) => r && a.indexOf(r) === i);
        try {
            const { data, error } = await supabase.from('role_permissions').select('role, permissions').in('role', roleNames);
            if (!error && Array.isArray(data) && data.length) {
                const rows = roleNames.map((rn) => {
                    const d = data.find((x) => x.role === rn);
                    if (!d || !d.permissions) return null;
                    let p = d.permissions;
                    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = null; } }
                    return (p && Array.isArray(p.sections)) ? { name: rn, permissions: p } : null;
                }).filter(Boolean);
                if (rows.length) { setEffectiveFromRoles(rows); return; }
            }
        } catch (_) { /* table absent pre-migration 013 → fail-closed fallback below */ }
    }
    // Fallback when no configured row exists: doctors keep a minimal clinical set
    // (their data stays self-scoped via scopedDoctorId()); everyone else is
    // fail-closed until an admin grants access in Settings → Roles & permissions.
    if (actor.is_doctor) {
        // ROLE_KEYS_V2 — «consultation» (Мои услуги) is the doctor's OWN cabinet;
        // it was missing here, so even the fallback left a doctor unable to open
        // their queue. Its absence was invisible because the key the Roles editor
        // wrote (`doctor-room`) is not a gate either.
        setEffectiveFromRole({ name: 'Doctor', permissions: {
            sections: ['patients', 'consultation', 'labs', 'dashboard', 'patient-documents'],
            levels: { patients: 'editor', consultation: 'editor', labs: 'editor', 'patient-documents': 'editor' },
        } });
    } else {
        setEffectiveFromRole({ name: actor.role || 'Без роли', permissions: { sections: ['__no_access__'], levels: {} } });
    }
}

// ---------------------------------------------------------------------------
// Login screen
// ---------------------------------------------------------------------------
function showLogin() {
    const existing = document.getElementById('login-overlay');
    if (existing) existing.remove();

    const errEl = h('div', { style: { color: 'var(--crit-700)', fontSize: '12.5px', minHeight: '16px', textAlign: 'center' } });
    const userInp = h('input', {
        type: 'text', placeholder: 'Username or email', autocomplete: 'username',
        style: loginInputStyle(),
    });
    const passInp = h('input', {
        type: 'password', placeholder: 'Password', autocomplete: 'current-password',
        style: loginInputStyle(),
    });
    const btn = h('button', {
        type: 'submit', class: 'btn btn-primary',
        style: { width: '100%', justifyContent: 'center', height: '40px', fontSize: '13.5px' },
    }, 'Sign in');

    const submit = async () => {
        errEl.textContent = '';
        btn.disabled = true;
        try {
            const res = await verifyLogin(userInp.value, passInp.value);
            if (res.error) { errEl.textContent = res.error; passInp.focus(); passInp.select(); return; }
            const overlay = document.getElementById('login-overlay');
            if (overlay) overlay.remove();
            // First-login force-reset: signed in successfully with the temp
            // password from migration 032's distribution table, but never
            // set their own password yet. Render the reset screen instead
            // of dropping into the dashboard.
            if (res.needsPasswordReset) {
                showFirstLoginReset(res.user);
                return;
            }
            await onAuthed(res.user);
        } catch (e) {
            console.error('[login]', e);
            errEl.textContent = 'Login failed — ' + (e.message || e);
        } finally {
            btn.disabled = false;
        }
    };

    const form = h('form', {
        onsubmit: (e) => { e.preventDefault(); submit(); },
        style: { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' },
    },
        userInp, passInp, btn, errEl,
    );

    // Secondary action — opens the self-signup screen. Type=button keeps it
    // from accidentally submitting the login form.
    const createAcctBtn = h('button', {
        type: 'button',
        class: 'btn btn-outline',
        style: { width: '100%', justifyContent: 'center', height: '38px', fontSize: '13.5px' },
        onclick: () => showSignup(),
    }, 'Create an account');

    const signupRow = h('div', { style: { width: '100%', display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--ink-400)', fontSize: '12.5px' } },
            h('div', { style: { flex: '1', height: '1px', background: 'var(--ink-100)' } }),
            h('span', null, "Don't have an account?"),
            h('div', { style: { flex: '1', height: '1px', background: 'var(--ink-100)' } }),
        ),
        createAcctBtn,
    );

    const card = h('div', {
        style: {
            width: '360px', maxWidth: 'calc(100vw - 32px)',
            background: 'white', borderRadius: '16px', padding: '28px 26px',
            boxShadow: '0 24px 60px rgba(11,20,24,0.22)', display: 'flex',
            flexDirection: 'column', alignItems: 'center', gap: '16px',
        },
    },
        h('div', {
            style: {
                width: '52px', height: '52px', borderRadius: '14px',
                background: 'linear-gradient(135deg, var(--primary-600, #167873), var(--primary-800, #0f4f4b))',
                display: 'grid', placeItems: 'center', color: 'white',
            },
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="26" height="26"><path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/></svg>',
        }),
        h('div', { style: { textAlign: 'center' } },
            h('div', { style: { fontSize: '17px', fontWeight: 700, color: 'var(--ink-900)' } }, 'Easy-Med'),
            h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', marginTop: '2px' } }, 'Sign in to continue'),
        ),
        form,
        signupRow,
    );

    const overlay = h('div', {
        id: 'login-overlay',
        style: {
            position: 'fixed', inset: '0', zIndex: '9999',
            display: 'grid', placeItems: 'center',
            background: 'linear-gradient(160deg, #e7ebee, #f3f5f7)',
        },
    }, card);

    document.body.appendChild(overlay);
    setTimeout(() => userInp.focus(), 0);
}

function loginInputStyle() {
    return {
        width: '100%', height: '40px', padding: '0 12px',
        border: '1px solid var(--ink-200)', borderRadius: '9px',
        fontSize: '13.5px', fontFamily: 'inherit', outline: 'none',
        boxSizing: 'border-box',
    };
}

// ---------------------------------------------------------------------------
// Sign-up screen — "Request access" inbox. Inserts a row into
// public.signup_requests (migration 046). No auth.users row is created
// here; an admin reviews requests under Settings → Sign-up requests and
// provisions the account via the existing Employees flow.
// ---------------------------------------------------------------------------
function showSignup() {
    const existing = document.getElementById('login-overlay');
    if (existing) existing.remove();

    // On the apex (easymed.uz with no clinic context) the staff-request form
    // doesn't make sense — there's no specific clinic to request access at.
    // Skip straight to the create-clinic wizard instead.
    if (!window.CLINIC_SLUG) {
        showCreateClinicOnly();
        return;
    }

    const errEl = h('div', { style: { color: 'var(--crit-700)', fontSize: '12.5px', minHeight: '16px', textAlign: 'center' } });
    const okEl  = h('div', { style: { color: 'var(--ok-700)',   fontSize: '12.5px', minHeight: '16px', textAlign: 'center' } });

    const nameInp  = h('input',    { type: 'text', placeholder: 'Full name',             autocomplete: 'name',  style: loginInputStyle() });
    // PHONE_INPUT_V1 — country control; its inner field carries the login-form
    // styling, minus the left corners the country button occupies.
    const phoneInp = phoneInput('phone', 'Phone (+998 …)');
    Object.assign(phoneInp.input.style, loginInputStyle(), { borderRadius: '0 9px 9px 0', borderLeft: '0' });
    const emailInp = h('input',    { type: 'email',placeholder: 'Email (optional)',      autocomplete: 'email', style: loginInputStyle() });
    const userInp  = h('input',    { type: 'text', placeholder: 'Desired username (optional)', autocomplete: 'off', style: loginInputStyle() });
    const msgInp   = h('textarea', {
        placeholder: 'Why you need access (optional)',
        rows: '3',
        style: { ...loginInputStyle(), height: 'auto', padding: '8px 12px', resize: 'vertical', minHeight: '64px' },
    });

    const btn = h('button', {
        type: 'submit', class: 'btn btn-primary',
        style: { width: '100%', justifyContent: 'center', height: '40px', fontSize: '13.5px' },
    }, 'Request access');

    const backBtn = h('button', {
        type: 'button', class: 'btn btn-outline',
        style: { width: '100%', justifyContent: 'center', height: '38px', fontSize: '13.5px' },
        onclick: () => showLogin(),
    }, 'Back to sign in');

    const submit = async () => {
        errEl.textContent = '';
        okEl.textContent  = '';
        const fname = (nameInp.value  || '').trim();
        const phone = (phoneInp.value || '').trim();
        const email = (emailInp.value || '').trim() || null;
        const uname = (userInp.value  || '').trim().toLowerCase() || null;
        const msg   = (msgInp.value   || '').trim() || null;
        if (!fname) { errEl.textContent = 'Full name is required.'; return; }
        if (!phone) { errEl.textContent = 'Phone number is required.'; return; }

        btn.disabled = true;
        try {
            const { error } = await supabase.from('signup_requests').insert({
                full_name: fname, phone, email, username: uname, message: msg,
            });
            if (error) {
                // Most likely cause when this fails is that migration 046
                // hasn't been applied yet. Surface that clearly.
                if (/relation .* does not exist|signup_requests/i.test(error.message || '')) {
                    errEl.textContent = 'Sign-up requests table is missing — ask the admin to run migration 046.';
                } else {
                    errEl.textContent = error.message || 'Could not submit your request.';
                }
                return;
            }
            okEl.textContent = 'Request submitted. An admin will reach out once your account is ready.';
            // Lock the form so the user can't double-submit.
            for (const el of [nameInp, phoneInp, emailInp, userInp, msgInp]) el.disabled = true;
            btn.disabled = true;
            btn.textContent = 'Submitted';
        } catch (e) {
            console.error('[signup-request]', e);
            errEl.textContent = 'Submission failed — ' + (e.message || e);
        } finally {
            // Re-enable only if we didn't succeed.
            if (!okEl.textContent) btn.disabled = false;
        }
    };

    const form = h('form', {
        onsubmit: (e) => { e.preventDefault(); submit(); },
        style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' },
    },
        nameInp, phoneInp, emailInp, userInp, msgInp, btn, errEl, okEl,
    );

    const card = h('div', {
        style: {
            width: '360px', maxWidth: 'calc(100vw - 32px)',
            background: 'white', borderRadius: '16px', padding: '28px 26px',
            boxShadow: '0 24px 60px rgba(11,20,24,0.22)', display: 'flex',
            flexDirection: 'column', alignItems: 'center', gap: '14px',
        },
    },
        h('div', {
            style: {
                width: '52px', height: '52px', borderRadius: '14px',
                background: 'linear-gradient(135deg, var(--primary-600, #167873), var(--primary-800, #0f4f4b))',
                display: 'grid', placeItems: 'center', color: 'white',
            },
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="26" height="26"><path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/></svg>',
        }),
        h('div', { style: { textAlign: 'center' } },
            h('div', { style: { fontSize: '17px', fontWeight: 700, color: 'var(--ink-900)' } },
                window.CLINIC?.name || 'Easy-Med'),
            h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', marginTop: '2px', lineHeight: '1.45' } },
                'For staff joining ',
                h('strong', null, window.CLINIC?.name || 'an existing clinic'),
                ' — an admin will review your request.'),
        ),
        form,
        backBtn,
        h('div', {
            style: {
                marginTop: '8px', paddingTop: '14px', borderTop: '1px solid var(--ink-100, #e6ecf0)',
                fontSize: '12.5px', color: 'var(--ink-600, #5a6c78)', textAlign: 'center', lineHeight: '1.45',
            },
        }, 'Not joining ', h('strong', null, window.CLINIC?.name || 'a clinic'), ' — opening your own?'),
        h('button', {
            type: 'button', class: 'btn btn-outline',
            style: {
                width: '100%', justifyContent: 'center', height: '40px', fontSize: '13.5px',
                fontWeight: '700', color: 'var(--primary-700, #0d8a8a)',
                borderColor: 'var(--primary-700, #0d8a8a)', marginTop: '2px',
            },
            onclick: (e) => {
                e.preventDefault();
                if (typeof window.openClinicSignup === 'function') {
                    window.openClinicSignup();
                } else {
                    window.location.href = 'https://easymed.uz/';
                }
            },
        }, 'Create a new clinic →'),
    );

    const overlay = h('div', {
        id: 'login-overlay',
        style: {
            position: 'fixed', inset: '0', zIndex: '9999',
            display: 'grid', placeItems: 'center',
            background: 'linear-gradient(160deg, #e7ebee, #f3f5f7)',
        },
    }, card);

    document.body.appendChild(overlay);
    setTimeout(() => nameInp.focus(), 0);
}

// ---------------------------------------------------------------------------
// Apex-only screen — when someone clicks "Request access" on easymed.uz
// (no clinic context), there's nothing to join. Show only the create-clinic
// CTA so the next click opens the wizard, not the irrelevant staff form.
// ---------------------------------------------------------------------------
function showCreateClinicOnly() {
    const existing = document.getElementById('login-overlay');
    if (existing) existing.remove();

    const card = h('div', {
        style: {
            width: '420px', maxWidth: 'calc(100vw - 32px)',
            background: 'white', borderRadius: '16px', padding: '36px 30px',
            boxShadow: '0 24px 60px rgba(11,20,24,0.22)', display: 'flex',
            flexDirection: 'column', alignItems: 'center', gap: '18px', textAlign: 'center',
        },
    },
        h('div', {
            style: {
                width: '56px', height: '56px', borderRadius: '14px',
                background: 'linear-gradient(135deg, var(--primary-600, #167873), var(--primary-800, #0f4f4b))',
                display: 'grid', placeItems: 'center', color: 'white',
            },
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/></svg>',
        }),
        h('div', null,
            h('div', { style: { fontSize: '24px', fontWeight: 800, color: 'var(--ink-900)', letterSpacing: '-0.01em' } }, 'Open your clinic'),
            h('div', { style: { fontSize: '13.5px', color: 'var(--ink-500)', marginTop: '8px', lineHeight: '1.5' } },
                'Pick a name, get your own subdomain at ',
                h('strong', null, '<your-clinic>.easymed.uz'),
                ', and start a 7-day free trial. No card required.'),
        ),
        h('button', {
            type: 'button', class: 'btn btn-primary',
            style: { width: '100%', justifyContent: 'center', height: '46px', fontSize: '15px', fontWeight: '700' },
            onclick: () => {
                if (typeof window.openClinicSignup === 'function') {
                    window.openClinicSignup();
                } else {
                    window.location.href = 'https://easymed.uz/';
                }
            },
        }, 'Create my clinic →'),
        h('button', {
            type: 'button', class: 'btn btn-outline',
            style: { width: '100%', justifyContent: 'center', height: '40px', fontSize: '13.5px' },
            onclick: () => showLogin(),
        }, 'Back to sign in'),
        h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', marginTop: '4px', lineHeight: '1.45' } },
            'Already on a clinic? Sign in at ',
            h('strong', null, '<your-slug>.easymed.uz'),
            ' instead.'),
    );

    const overlay = h('div', {
        id: 'login-overlay',
        style: {
            position: 'fixed', inset: '0', zIndex: '9999',
            display: 'grid', placeItems: 'center',
            background: 'linear-gradient(160deg, #e7ebee, #f3f5f7)',
        },
    }, card);

    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Pending-review screen — shown when a clinic logs in before its license
// and certificate have been approved in the Platform Console.
// ---------------------------------------------------------------------------
function showPendingReview(clinic) {
    const existing = document.getElementById('login-overlay');
    if (existing) existing.remove();
    const status = clinic.verification_status;

    const titleMap = {
        pending_documents: 'Upload your documents to continue',
        pending_review:    'Your clinic is under review',
        rejected:          'Application not approved',
    };
    const bodyMap = {
        pending_documents: 'We received your signup but no license / certificate files are on file yet. Please re-open the signup wizard to upload them, or contact support if you think this is a mistake.',
        pending_review:    'Thanks — we received your license and certificate. Our review team is checking them now and will email you (and ping your Telegram if you provided one) as soon as your workspace is open. Usually within 24 hours.',
        rejected:          'Unfortunately we could not verify the documents you submitted. Please contact us so we can sort this out together.',
    };

    const card = h('div', {
        style: {
            width: '460px', maxWidth: 'calc(100vw - 32px)',
            background: 'white', borderRadius: '16px', padding: '36px 32px',
            boxShadow: '0 24px 60px rgba(11,20,24,0.22)', display: 'flex',
            flexDirection: 'column', alignItems: 'center', gap: '14px', textAlign: 'center',
        },
    },
        h('div', {
            style: {
                width: '64px', height: '64px', borderRadius: '16px',
                background: status === 'rejected' ? '#fff0f0' : '#fffbe6',
                color: status === 'rejected' ? '#c83434' : '#a07810',
                display: 'grid', placeItems: 'center', fontSize: '30px', fontWeight: '700',
            },
        }, status === 'rejected' ? '!' : '⏱'),
        h('div', null,
            h('div', { style: { fontSize: '24px', fontWeight: 800, color: 'var(--ink-900)', letterSpacing: '-0.01em' } }, titleMap[status] || 'Account pending'),
            h('div', { style: { fontSize: '13.5px', color: 'var(--ink-500)', marginTop: '10px', lineHeight: '1.6' } }, bodyMap[status] || ''),
        ),
        clinic.rejection_reason
            ? h('div', { style: { background: '#fff0f0', color: '#7a1a1a', padding: '12px 14px', borderRadius: '10px', fontSize: '13.5px', width: '100%', lineHeight: '1.45', textAlign: 'left' } },
                h('strong', null, 'Reason: '),
                clinic.rejection_reason,
              )
            : null,
        h('a', {
            href: 'mailto:hello@easymed.uz?subject=' + encodeURIComponent('Clinic verification — ' + (clinic.name || clinic.slug)),
            class: 'btn btn-primary',
            style: { width: '100%', justifyContent: 'center', height: '44px', fontSize: '13.5px', textDecoration: 'none', marginTop: '6px' },
        }, 'Contact support'),
        h('button', {
            type: 'button', class: 'btn btn-outline',
            style: { width: '100%', justifyContent: 'center', height: '40px', fontSize: '13.5px' },
            onclick: () => { window.location.href = 'https://easymed.uz/'; },
        }, 'Back to easymed.uz'),
    );

    const overlay = h('div', {
        id: 'login-overlay',
        style: {
            position: 'fixed', inset: '0', zIndex: '9999',
            display: 'grid', placeItems: 'center',
            background: 'linear-gradient(160deg, #e7ebee, #f3f5f7)',
        },
    }, card);
    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// First-login force-reset screen — rendered once per user, right after
// their first successful sign-in with the temp password from migration 032.
// Locked from being skipped: closes only on successful password update,
// then drops into onAuthed() as if they'd logged in normally.
// ---------------------------------------------------------------------------
function showFirstLoginReset(user) {
    const existing = document.getElementById('login-overlay');
    if (existing) existing.remove();

    const errEl = h('div', { style: { color: 'var(--crit-700)', fontSize: '12.5px', minHeight: '16px', textAlign: 'center' } });
    const newPwd  = h('input', { type: 'password', placeholder: 'New password (min 8 characters)', autocomplete: 'new-password', style: loginInputStyle() });
    const confirm = h('input', { type: 'password', placeholder: 'Repeat new password',            autocomplete: 'new-password', style: loginInputStyle() });
    const btn = h('button', {
        type: 'submit', class: 'btn btn-primary',
        style: { width: '100%', justifyContent: 'center', height: '40px', fontSize: '13.5px' },
    }, 'Set new password');

    const submit = async () => {
        errEl.textContent = '';
        if (newPwd.value !== confirm.value) {
            errEl.textContent = 'Passwords do not match.';
            confirm.focus(); confirm.select();
            return;
        }
        if ((newPwd.value || '').length < 8) {
            errEl.textContent = 'Use at least 8 characters.';
            newPwd.focus(); newPwd.select();
            return;
        }
        btn.disabled = true;
        try {
            const res = await completeFirstLoginReset(newPwd.value);
            if (res.error) { errEl.textContent = res.error; return; }
            const overlay = document.getElementById('login-overlay');
            if (overlay) overlay.remove();
            await onAuthed(user);
        } catch (e) {
            console.error('[first-login reset]', e);
            errEl.textContent = 'Reset failed — ' + (e.message || e);
        } finally {
            btn.disabled = false;
        }
    };

    const form = h('form', {
        onsubmit: (e) => { e.preventDefault(); submit(); },
        style: { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' },
    }, newPwd, confirm, btn, errEl);

    const card = h('div', {
        style: {
            width: '380px', maxWidth: 'calc(100vw - 32px)',
            background: 'white', borderRadius: '16px', padding: '28px 26px',
            boxShadow: '0 24px 60px rgba(11,20,24,0.22)', display: 'flex',
            flexDirection: 'column', alignItems: 'center', gap: '16px',
        },
    },
        h('div', {
            style: {
                width: '52px', height: '52px', borderRadius: '14px',
                background: 'linear-gradient(135deg, var(--primary-600, #167873), var(--primary-800, #0f4f4b))',
                display: 'grid', placeItems: 'center', color: 'white',
            },
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="26" height="26"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
        }),
        h('div', { style: { textAlign: 'center' } },
            h('div', { style: { fontSize: '17px', fontWeight: 700, color: 'var(--ink-900)' } }, 'Set your password'),
            h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', marginTop: '4px', lineHeight: '1.5' } },
                'Signed in as ', h('b', null, user.username || user.full_name || ''),
                '. Replace the temporary password to continue.'),
        ),
        form,
    );

    const overlay = h('div', {
        id: 'login-overlay',
        style: {
            position: 'fixed', inset: '0', zIndex: '9999',
            display: 'grid', placeItems: 'center',
            background: 'linear-gradient(160deg, #e7ebee, #f3f5f7)',
        },
    }, card);

    document.body.appendChild(overlay);
    setTimeout(() => newPwd.focus(), 0);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
    setStatus('connecting', true);
    pingSupabase().then(ok => setStatus(ok ? 'connected' : 'notConnected', ok));

    // Resolve which clinic this subdomain belongs to (sets window.CLINIC).
    // Await this so we can gate login on the clinic's verification state.
    const { slug, clinic } = await initClinicContext(supabase);
    loadDocBrandingAsync().catch(() => {});   // clinic-global document branding at boot
    const sub = document.querySelector('.brand-sub');
    if (sub) {
        if (clinic?.name) sub.textContent = clinic.name;
        else if (slug)    sub.textContent = slug;
    }

    const userRow = await rehydrateUserFromSession();
    if (!userRow) { showLogin(); return; }

    // LICENCE_CORE_V1 — fetched before onAuthed() paints the shell, so the sidebar
    // is never drawn with a module open and then corrected a frame later.
    //
    // An RPC rather than a field on /api/auth/me: db-auth.js's getUser() returns
    // only { data: { user } } and drops every other property of that response, so
    // a licence block added there would vanish silently and NOTHING would ever
    // lock — an enforcement failure that looks exactly like everything working.
    try {
        const { data: lic } = await supabase.rpc('licence_status', {});
        setLicence(lic || null);
    } catch (e) {
        // A licence check that cannot run must never stop someone logging in.
        // null means "clinical core open, paid modules closed" — see licence.js.
        console.warn('[licence]', e && e.message);
        setLicence(null);
    }

    // MODEL_A_VERIFY_V1 — let an un-verified clinic into its OWN private workspace; only a
    // REJECTED clinic is blocked at the door. A non-blocking banner (renderVerificationBanner)
    // handles the license upload; going public on Symptex / accepting patient bookings stays gated
    // on verification elsewhere (medcore verified+active + platform-approved publication).
    if (slug && clinic && clinic.verification_status === 'rejected' && !userRow.is_super_admin) {
        await signOutAndShowPendingReview(clinic);
        return;
    }

    await onAuthed(userRow);
    if (!userRow.is_super_admin) {
        renderNotifications(clinic).catch((e) => console.warn('[notifications]', e));   // NOTIF_CENTER_V1 — unified bell + dismissible banners
    }
}

async function signOutAndShowPendingReview(clinic) {
    try { await supabase.auth.signOut(); } catch {}
    showPendingReview(clinic);
}

// Called after a successful login OR session rehydrate. Sets the actor,
// resolves their permissions, then starts the app shell. Supabase Auth
// persists its own session under the storageKey set in js/supabase.js;
// nothing for us to save here.
async function onAuthed(userRow) {
    window.CURRENT_USER = userRow;
    // CLINIC_AFTER_LOGIN_V1 — boot() resolves the clinic BEFORE the session
    // exists, and /api/rpc is behind requireAuth, so on a fresh login that call
    // 401s and window.CLINIC is parked at null. Logging in through the form does
    // NOT reload the page (submit → onAuthed), so nothing ever asked again and
    // every screen gated on currentClinicId() stayed broken for the whole
    // session — lab-settings says so out loud, right after a laborant saves a
    // panel. This is the one place all three entries converge (login submit,
    // first-login reset, boot-with-session), so it is the only place that can
    // fix all three. No-op when the clinic already resolved.
    await ensureClinicContext(supabase);
    await initBranchContext(supabase, userRow);
    state.user = actorFromUser(userRow);
    await applyActorPermissions(state.user);
    startApp();
    renderLicenceBanner();   // LICENCE_CORE_V1 — after the shell exists, so `.app` is there to mount above
    // UPDATE_DELIVERY_V1 — fire-and-forget, same posture as boot()'s own
    // renderNotifications() call: a check that cannot run (offline, RPC
    // error) must never block login or surface as an error to the clinic.
    renderUpdateBanner().catch((e) => console.warn('[updates]', e && e.message));
}

// LICENCE_CORE_V1 — the countdown banner. A lapsed subscription gets the full
// activation screen (renderActivation, in renderViewInner); this is for the
// days BEFORE that, so the lock is never a surprise. Mounted the same way as
// verify-banner.js/notifications.js: a sibling inserted right above `.app`.
//
// Idempotent by construction — always removes any prior banner by id before
// deciding whether to (re)mount one, so calling this twice (or from the
// onLangChange listener below) never leaves two banners stacked.
function renderLicenceBanner() {
    document.getElementById('licence-banner')?.remove();
    const lic = licenceState();
    // 'ok' needs no banner; 'locked' is the full-screen activation takeover
    // instead — a banner on top of that screen would just be redundant chrome.
    if (lic.state !== 'notice' && lic.state !== 'warn') return;

    // daysLeft is structurally > 0 whenever state is 'notice'/'warn' — ladder.js
    // only reaches either rung when msLeft > 0, and Math.ceil() of a positive
    // number is never 0. But the client cannot fully trust a hand-edited or
    // malformed RPC payload reaching this far, so floor at 1 defensively rather
    // than ever rendering "через 0 дн.".
    const days = Math.max(1, Number(lic.days_left) || 0);
    // Built directly rather than through tr()'s STRINGS dictionary: the day
    // count is dynamic, and this codebase's existing convention for a number
    // embedded in a Russian sentence (see reports-hub.js's "N дн." KPI tiles)
    // is a plain concatenated string, not a template key — there is no {n}
    // placeholder precedent in STRINGS to follow instead.
    const msg = lic.reason === 'unpaid'
        ? `Подписка заканчивается через ${days} дн. Свяжитесь с менеджером Easy-Med.`
        : `Нет связи с Easy-Med ${days} дн. Проверьте интернет — иначе система заблокируется.`;

    const banner = h('div', { id: 'licence-banner', class: lic.state === 'warn' ? 'licence-warn' : 'licence-notice' },
        h('span', { class: 'lb-msg' }, Icon(lic.state === 'warn' ? 'Warning' : 'Clock', { size: 15 }), msg));
    document.body.insertBefore(banner, document.querySelector('.app') || document.body.firstChild);
}

// Repaint on a language switch, same as the other topbar/sidebar chrome in
// startApp()'s own onLangChange handler — registered once at module load
// (not inside onAuthed) so logging out and back in never stacks a second
// listener. Safe to fire before any login too: licenceState() reads as 'ok'
// with nothing set, so this simply no-ops.
onLangChange(() => renderLicenceBanner());

// UPDATE_DELIVERY_V1 (Task 6) — the quiet update banner, mounted the same way
// as #licence-banner just above (a sibling inserted right above `.app`).
// Deliberately calm: only two states, and neither is ever the amber/red
// treatment the licence banner uses for its 'warn'/'locked' states — an
// available or scheduled update is good news, not a problem the clinic
// caused.
//
// Unlike renderLicenceBanner() this hits the network on every call
// (update_status has no cheap client-side cache the way licenceState() is
// one), so it is called once at login (onAuthed above) and again on demand
// via window.easymedRefreshUpdateBanner() from views/updates.js after an
// approve/change/cancel — NOT wired into onLangChange: a language toggle is
// not a moment worth repeating that round trip for, and this screen's own
// visible strings still render through tr() at whichever language is active
// whenever it next repaints.
async function renderUpdateBanner() {
    document.getElementById('update-banner')?.remove();
    let status;
    try {
        const { data, error } = await supabase.rpc('update_status', {});
        if (error) throw error;
        status = data || {};
    } catch (e) {
        return;   // same posture as licence.js/verify-banner.js — a check that cannot run must never alarm anyone
    }
    // offerIsCurrent — the narrow window right after a successful install,
    // before the next daily check-in clears/replaces the offer server-side
    // (see server/services/control/checkin.js); see updates-logic.js's own
    // comment. Treated as "nothing waiting" here too.
    const offer = offerIsCurrent(status.offer, status.current_version) ? null : status.offer;
    if (!offer) return;

    const banner = h('div', { id: 'update-banner' });
    if (status.approved) {
        // status.hour, NOT Number(status.hour): an «Обновить сейчас» consent has
        // hour null BY DESIGN, and Number(null) is 0 — the first immediate
        // install shipped a banner promising «запланировано на 00:00» (owner's
        // screenshot, 2026-08-23). The same Number(null)===0 trap update_approve's
        // own comment warns about, hit from the display side this time.
        const hour = status.hour;
        // Built directly, not through tr()'s STRINGS table — same convention
        // as renderLicenceBanner's own dynamic day-count message just above:
        // there is no {hour} placeholder mechanism to hook a dynamic value
        // into instead.
        banner.appendChild(h('span', { class: 'ub-msg' }, Icon('Clock', { size: 15 }),
            status.immediate === true ? 'Обновление устанавливается.'
                : Number.isInteger(hour) ? `Обновление запланировано на ${formatRuHour(hour)}.`
                : 'Обновление запланировано.'));
    } else {
        banner.appendChild(h('span', { class: 'ub-msg' }, Icon('Download', { size: 15 }),
            `Доступно обновление ${offer.version} — `,
            h('button', { class: 'ub-link', type: 'button', onclick: () => navigate('updates') }, 'Подробнее')));
    }
    document.body.insertBefore(banner, document.querySelector('.app') || document.body.firstChild);
}

// Bridge for views/updates.js, which cannot import this module back (admin.js
// is the entry script that imports every view; a view importing it would
// form a cycle) — same established pattern as window.easymedSetTabLabel
// above for tab titles.
window.easymedRefreshUpdateBanner = renderUpdateBanner;

// SIDEBAR_COLLAPSE_V1 — chevron collapses the global left nav; the floating
// re-open button restores it. Wired once; state persisted to localStorage.
function wireSidebarCollapse() {
    const app = document.querySelector('.app');
    if (!app || app._sbCollapseWired) return;
    app._sbCollapseWired = true;
    const setCollapsed = (on) => {
        app.classList.toggle('sidebar-collapsed', on);
        try { localStorage.setItem('easymed_sidebar_collapsed', on ? '1' : '0'); } catch (_) {}
    };
    const toggle = () => setCollapsed(!app.classList.contains('sidebar-collapsed'));
    // APP_RELOAD_BTN_V1 — the topbar reload button is wired here (not via inline
    // onclick, which the CSP blocks) so it works in standalone/app mode.
    document.getElementById('topbar-reload')?.addEventListener('click', () => location.reload());
    // Chevron collapses; the logo toggles (and is the only control left on the rail).
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => setCollapsed(true));
    const logo = document.getElementById('sidebar-logo');
    if (logo) {
        logo.addEventListener('click', toggle);
        logo.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
}

// Renders the app shell for the now-authenticated actor.
function startApp() {
    window.easymed = { state, supabase, navigate };
    paintUserCard();
    wireSidebarCollapse();   // SIDEBAR_COLLAPSE_V1
    searchEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate('patients'); });

    // Apply the current language to anything painted statically (search
    // placeholder), wire the language switcher buttons, and re-render
    // language-sensitive chrome whenever the user switches.
    applyTopbarLang();
    wireLangSwitcher();
    wireUserPopover();
    renderBranchPicker(document.getElementById('branch-picker'));
    onLangChange(() => {
        applyTopbarLang();
        renderSidebar();
        renderSectionTitle();
        renderCrumbs();
        setStatus(_lastStatusKey, _lastStatusOk);
        for (const pane of state.panes) { try { renderViewInto(pane); } catch (e) { console.warn('[lang] re-render', e); } }   // LANG_RERENDER_V1 — navigate() no-ops on a cached pane, so re-render them directly
    });
    onBranchChange(() => {
        // BRANCH_RERENDER_V1 — re-render every CACHED pane so the branch filter
        // actually re-applies. navigate(state.view) no-ops on an already-mounted
        // pane (see "Already mounted? Show it again — never re-render"), which
        // left lists showing the previously-selected branch's data after the
        // FILIAL picker changed.
        for (const pane of state.panes) { try { renderViewInto(pane); } catch (e) { console.warn('[branch] re-render', e); } }
    });

    const last = loadRoute();
    const isKnownView = (v) => !!v && (CRUMBS[v] || PLACEHOLDERS.has(v) || v.startsWith('settings') || v.startsWith('report'));
    const valid = last && isKnownView(last);
    let target = valid ? last : firstAllowedView();
    if (!isRouteAllowed(target)) target = firstAllowedView();

    // HASH_SUBROUTE_V1 — a hash that names a SUB-route (#labs/panels) carries
    // state the remembered route cannot express, so it wins the boot. A bare
    // '#view' does NOT: a plain hash can be stale, and the remembered route
    // keeps the precedence it has always had.
    const hash = parseHash();
    if (hash.sub && isKnownView(hash.view) && isRouteAllowed(hash.view)) target = hash.view;
    navigate(target, hash.sub && hash.view === target ? { sub: hash.sub } : null);

    // Load roles (for the super-admin "View as" switcher) then render the
    // footer account controls (switcher + logout). loadRolesForPreview fails
    // soft, so the .then always runs and the logout button always appears.
    loadRolesForPreview().then(renderAccountControls);
}

function applyTopbarLang() {
    if (searchEl) searchEl.placeholder = t('topbar.search', searchEl.placeholder);
    const langBox = document.getElementById('topbar-lang');
    if (langBox) {
        langBox.querySelectorAll('button[data-lang]').forEach(b =>
            b.classList.toggle('on', b.dataset.lang === getLang()));
    }
}

function wireLangSwitcher() {
    const box = document.getElementById('topbar-lang');
    if (!box) return;
    box.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-lang]');
        if (b) setLang(b.dataset.lang);
    });
}

// Click the avatar pill in the topbar to reveal the View-as-role switcher +
// Log out. Click outside or press Escape to dismiss.
function wireUserPopover() {
    const btn = document.getElementById('user-card-btn');
    const pop = document.getElementById('user-popover');
    if (!btn || !pop) return;
    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const open  = () => { pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pop.hidden ? open() : close();
    });
    document.addEventListener('click', (e) => {
        if (pop.hidden) return;
        if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) close(); });
}

boot().catch(e => {
    console.error('[Easy-Med] boot failed:', e);
    setStatus('bootFailed', false);
    clear(viewRoot);
    viewRoot.appendChild(h('div', { class: 'error-state' }, 'Failed to boot — ', h('code', null, e.message)));
});


// PWA_V1 — register the service worker so EasyMed is installable («Открыть в приложении»).
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try { window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); }); } catch (e) {}
}
// PWA_INSTALL_FAB_V1 — a prominent, pulsating install button (the native address-bar icon is easy to miss).
if (typeof window !== 'undefined') {
    let __emInstallPrompt = null;
    const __emStandalone = () => !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    const __emDlSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    function __emShowInstall() {
        if (__emStandalone() || document.getElementById('em-install-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'em-install-btn'; btn.type = 'button'; btn.className = 'em-install-fab';
        btn.title = 'Установить EasyMed как приложение';
        btn.innerHTML = __emDlSvg + '<span>Установить приложение</span>';
        btn.addEventListener('click', async () => {
            if (!__emInstallPrompt) return;
            btn.disabled = true;
            try { __emInstallPrompt.prompt(); await __emInstallPrompt.userChoice; } catch (e) {}
            __emInstallPrompt = null; btn.remove();
        });
        (document.body || document.documentElement).appendChild(btn);
    }
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); __emInstallPrompt = e; __emShowInstall(); });
    window.addEventListener('appinstalled', () => { const b = document.getElementById('em-install-btn'); if (b) b.remove(); __emInstallPrompt = null; });
}
