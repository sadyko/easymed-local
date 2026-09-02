// Settings hub — SETTINGS_HUB_V2 — grouped card-grid config landing page that
// mirrors easymed's «Настройки» page 1:1. Group headings use easymed's exact
// Russian titles (Основное, Настройки услуг, Управление персоналом, Управление
// филиалами, Управление плательщиками, Кабинеты и этажи, Стационар, Направления,
// Зарплата врача — see public/js/admin/sections.js `group` fields + i18n-strings.js),
// with English one-line sub-descriptions per item, matching the surrounding
// English app chrome. Structure mirrors public/js/admin/views/services.js
// (mount / fetchAndPaint / DOM via h()) and its modal chrome.
//
// «Управление филиалами» is the ONE heading from that list that is deliberately
// gone — SETTINGS_ONE_COMPANY_V1, see the long note above GROUPS for why.
//
// Two internal states, both driven by one module-level `state` object:
//   state.section === null            -> HUB (card grid of groups/items)
//   state.section === '<LOOKUP key>'  -> shared, config-driven lookup editor
//
// The lookup tables are admin-writable via /api/db (see
// server/db/schema-registry.js) — insert does NOT accept `active` (DB defaults
// it to 1); update may send it. The settings-match config tables
// (payer_policies / payment_providers / cashback_rules /
// referral_source_categories / referral_rewards / patient_discounts /
// api_tokens / doctor_rates) were added in migration 012.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, checkField } from '../ui.js';
import { getLang, tr } from '../i18n.js';
import { phoneInput } from '../phone-input.js?v=ph1';
// ROLES_EDITOR_V2 — «Роли» — свой файл экрана (views/roles-editor.js). Он жил
// здесь и тянул за собой NAV_MODULES; вынесен по конвенции «один файл на
// экран» и чтобы правки прав не задевали этот файл. Хаб только монтирует
// экран и даёт ему дорогу назад.
import { renderRolesEditor } from './roles-editor.js?v=roles2';

// BRANCH_SYNC_V1 — «Филиалы» отвечают теперь на два разных вопроса: какие у
// клиники адреса (таблица branches, редактор ниже) и как связаны ОТДЕЛЬНЫЕ
// установки Easy-Med в разных зданиях. Второе живёт своим файлом-экраном по
// той же конвенции, что и «Роли», и монтируется НАД списком — разводить их по
// двум пунктам меню значило бы вернуть путаницу «две плитки про одно и то же»,
// которую SETTINGS_ONE_COMPANY_V1 только что убрал.
import { renderBranchSyncCard } from './branch-sync.js?v=bsync4';   // bsync4: филиалы таблицей, предупреждения — в окна подтверждения (BRANCH_LIST_V2)

let state = { section: null };   // null = hub; else one of LOOKUP_CONFIG's keys

const refs = { container: null, onNavigate: null };

export async function renderSettingsHub(container, { onNavigate } = {}) {
    refs.container  = container;
    refs.onNavigate = onNavigate;
    state = { section: null };
    hubQuery = '';
    await repaint();
}

async function repaint() {
    clear(refs.container);
    if (state.section === 'roles') await renderRolesEditor(refs.container, { onBack: backToHub });
    else if (state.section) await renderEditor(refs.container, state.section);
    else renderHub(refs.container);
}

function openSection(key) { state.section = key; repaint(); }
function backToHub()      { state.section = null; repaint(); }

const nav = (route) => () => { if (refs.onNavigate) refs.onNavigate(route); };
// SETTINGS_SPLIT_V1 — navSub() lived here for one caller, «Подписка», which
// opened '#updates/subscription' back when subscription was a card inside
// «Система». It has its own route now, so the helper went with its only user
// rather than staying as a convention nothing in this file follows. The
// HASH_SUBROUTE_V1 convention itself is alive and documented in admin.js
// (views/laboratory.js still uses it for '#labs/panels'), and the old hash is
// still answered — by views/updates.js, see its renderUpdates().
const goto = (url) => () => { window.location.href = url; };

// -----------------------------------------------------------------------------
// HUB — SETTINGS_HUB_V4. Grouped card grid mirroring easymed's «Настройки»:
// colored group-icon tiles + «N разделов», a search box and greyed «· Скоро»
// (soon) rows. Group order and labels match the easymed screenshot.
//
// Two things were broken here and are fixed in V4:
//   1. LAYOUT — the grid track was `minmax(640px, 1fr)`, so on a real clinic
//      monitor auto-fill only ever fitted ONE column: cards stretched the full
//      content width and every row became a thin band with its chevron marooned
//      on the far right. Now the layout lives in CSS (.set-* in admin-views.css)
//      on a 400px track, so it lands on 2–3 natural columns and degrades to one
//      only on narrow screens. Cards stretch to their row's tallest and groups
//      are ordered by section count, so each row's cards match in size.
//   2. LANGUAGE — labels/descriptions were a mix of Russian and English source
//      strings, and ui.js `h()` runs every text child through i18n `tr()`. Only
//      the strings that happened to exist in i18n-strings.js got translated, so
//      the card read «Список услуг / Laboratory & diagnostics / Товары и
//      препараты». Every label and description is now a Russian source string
//      with a full ru/en/uz entry in i18n-strings.js, so the whole page renders
//      in one language.
// -----------------------------------------------------------------------------
// SETTINGS_ONE_COMPANY_V1 (2026-08-29, owner: «в настройках два управления
// филиалами — сделать одно, второе убрать») — группа «Управление филиалами»
// удалена целиком, и вот почему.
//
// В хабе стояли ДВЕ плитки со словом «компания», и владелец не мог понять,
// какая из них настоящая:
//   1) «Компания» → documents-settings — запись doc_settings (id=1). Это и есть
//      клиника: название, логотип, фирменный цвет, контакты. Из неё
//      rpc/clinic.js собирает window.CLINIC, ею подписаны шапка приложения и
//      КАЖДАЯ печатная форма.
//   2) «Компании» → openSection('companies') — реестр юридических лиц из
//      облачной (SaaS) версии. По ней вообще НЕЛЬЗЯ БЫЛО КЛИКНУТЬ с пользой:
//      в LOOKUP_CONFIG ниже записи 'companies' нет, поэтому renderEditor()
//      упирался в свою же защиту `if (!cfg) { backToHub(); return; }` и
//      возвращал владельца на тот же экран. Плитка была мёртвой кнопкой.
//
// Проверено по этой базе перед удалением: в `companies` НОЛЬ строк, а её
// локальная схема — 13 «бумажных» колонок (name, legal_name, tax_id, director…).
// Ни одна работающая часть приложения не читает оттуда поведение:
//   • notifications.js берёт companies.eq('id', clinic.id) — clinic.id всегда 1
//     от синтетического get_clinic_by_slug, строки нет, напоминание не
//     возникает НИ РАЗУ;
//   • setup-checklist.js импортирован в admin.js, но renderSetupChecklist()
//     не вызывается ниоткуда (см. шапку notifications.js: «Replaces …
//     renderSetupChecklist»);
//   • cashier-settings.js / referral-settings.js / procurement.js /
//     reports-export.js / verify-banner.js читают companies.cashier_shift_mode,
//     .referral_reward_rates, .costing_method, .verification_status — таких
//     колонок нет ни в таблице, ни в schema-registry.js, эти вызовы и так
//     отвечают 4xx (CLAUDE.md, «Cloud leftovers in an offline app»);
//   • у локальной `branches` НЕТ колонки company_id — внешнего ключа на
//     companies в этой базе не существует вовсе (он есть только в устаревшем
//     облачном описании sections.js).
//
// Поэтому убрана ТОЛЬКО плитка. Таблица, миграция 026, запись в
// schema-registry.js, раздел sections.js и маршрут 'settings:companies' целы:
// схему молча не меняют, данные не удаляют, и ссылка из notifications.js
// по-прежнему открывается. Реестр юрлиц перестал притворяться настройкой
// клиники, а не исчез.
//
// «Список филиалов» переехал в «Настройки Easy-Med» под именем «Филиалы» —
// это и есть то самое «одно управление филиалами». Группа осталась пустой и
// удалена: заголовок над единственной осиротевшей строкой хуже, чем его
// отсутствие.
const GROUPS = [
    {
        title: 'Управление пользователями и сотрудниками', icon: 'ID', color: { bg: '#e4f3f1', fg: '#1f8a80' },
        items: [
            { label: 'Сотрудники', desc: 'Врачи, медсёстры, регистратура, администрация', icon: 'ID',       live: true, action: nav('employees') },
            { label: 'Роли',       desc: 'Роли доступа и разрешённые разделы меню',       icon: 'Settings', live: true, action: () => openSection('roles') },
            { label: 'Отделы',     desc: 'Клинические отделения и их руководители',       icon: 'Building', live: true, action: () => openSection('departments') },
        ],
    },
    {
        title: 'Настройки услуг', icon: 'Flask', color: { bg: '#efeafb', fg: '#6b4fb0' },
        items: [
            { label: 'Список услуг',        desc: 'Все услуги клиники · цены и маршрутизация', icon: 'Receipt', live: true, action: nav('services') },
            // LAB_PANELS_BY_SECTION_V1 (2026-08-31) — «Лаборатория и диагностика»
            // is gone from this card on purpose (owner: «remove the laboratory
            // and the panels settings from the settings, leave only in the lab
            // section with switch»). The panel editor's one home is the «Панели»
            // mode of Лаборатория, open to every role that can open the section;
            // the old address redirects there (admin.js LEGACY_ROUTES).
            { label: 'Товары и препараты',  desc: 'Склад · остатки, цены, точки заказа', icon: 'Pill',   live: true, action: nav('inventory') },
            { label: 'Типы услуг',          desc: 'Категории и разделы услуг',           icon: 'Layers', live: true, action: () => openSection('service_types') },
            { label: 'Консультации врачей', desc: 'Виды консультаций и их стоимость',    icon: 'Stethoscope', live: true, action: () => openSection('consultation_types') },
        ],
    },
    {
        title: 'Основное', icon: 'Folder', color: { bg: '#fdf3e1', fg: '#b07d1f' },
        items: [
            { label: 'Пациенты',            desc: 'Картотека пациентов · данные, контакты, номер карты', icon: 'ID',       live: true, action: nav('settings:patients') },   // PATIENTS_SECTION_V1 — easymed's section-CRUD register (route, NOT openSection: that's the hub's own lookup editor and has no patients config)
            { label: 'Категории пациентов', desc: 'Категории пациентов (VIP, обычные, …)',               icon: 'Layers',   live: true, action: () => openSection('patient_categories') },
            // COMPANY_SECTION_V1 — «Компания» было НЕКУДА открыть.
            //
            // Печатные формы, шапка приложения и window.CLINIC берут название,
            // логотип и контакты клиники из doc_settings (см. get_clinic_by_slug).
            // Редактор этой записи существовал (views/documents-settings.js,
            // маршрут 'documents-settings'), но на него никто не ссылался: плитка
            // «Документы» вела в дизайнер шаблонов ('documents'). А дизайнер, в
            // свою очередь, писал «данные берутся из раздела «Компания»» —
            // раздела, которого в меню не было. Отсюда и «нельзя изменить
            // название компании»: менять было негде, а правки в дизайнере
            // затирались при следующей загрузке.
            { label: 'Документы',           desc: 'Печатные шаблоны и настройки документов',             icon: 'Doc',      live: true, action: nav('documents') },
            { label: 'Скидки пациентов',    desc: 'Промокоды, подарочные карты и сертификаты',           icon: 'Coins',    live: true, action: () => openSection('patient_discounts') },
            // TELEGRAM_BOT_V1 — токен бота и режимы выдачи документов пациентам.
            // Раздел админский: isRouteAllowed('telegram-settings') пускает только
            // полный доступ, остальные упрутся в отказ на самом экране.
            // TELEPHONY_V1 — интеграция колл-центра Binotel: ключи, опрос,
            // WebHook-и, журнал звонков. Раздел админский тем же правилом, что
            // Telegram-бот (isRouteAllowed('telephony-settings') → false для
            // настроенных ролей), а без модуля `callcenter` маршрутизатор сам
            // покажет стандартный экран «Модуль не подключён».
            // UPDATE_DELIVERY_V1 — the approval screen (views/updates.js) is
            // also reachable from its own quiet banner; this row is the
            // other of the two entry points the plan calls for.
            // SYSTEM_SETTINGS_V1 — relabelled «Обновления» → «Система»: the
            // screen behind it grew activation/subscription, backups and the
            // danger zone. The ROUTE ID stays 'updates' on purpose — deep
            // links and admin.js's lockout exemption both key on the id, not
            // this label (see views/updates.js's own header).
        ],
    },
    {
        // SETTINGS_GROUPS_V2 (2026-08-24, owner's own grouping) — the four
        // integration/plumbing tiles moved out of «Основное», which had grown
        // to eleven unrelated rows. These are the ones a technician touches
        // when connecting the clinic to something, not ones a receptionist
        // opens daily.
        title: 'Системные настройки', icon: 'Settings', color: { bg: '#e9ebfb', fg: '#4b52b0' },
        items: [
            { label: 'CRM-канбан',          desc: 'Колонки воронки и источники заявок', icon: 'Grid', live: true, action: nav('crm-settings') },
            // TELEPHONY_ROUTING_V1 — обе подписи поехали вслед за карточкой
            // «Звонки → заявки»: CRM-канбан обещал маршрут, которого у него
            // больше нет, а Телефония не упоминала маршрут, который теперь её.
            { label: 'Телефония',           desc: 'Звонки Binotel: подключение, опрос, маршрут звонков в заявки и журнал', icon: 'Headset', live: true, action: nav('telephony-settings') },
            { label: 'Telegram-бот',        desc: 'Пациент получает свои документы в Telegram по номеру телефона', icon: 'Bot', live: true, action: nav('telegram-settings') },
            { label: 'API',                 desc: 'Токены интеграции для партнёров',                     icon: 'Settings', live: true, action: () => openSection('api_tokens') },
        ],
    },
    {
        // SETTINGS_ONE_COMPANY_V1 — «системные настройки одним разделом»
        // (владелец, 2026-08-29): Компания · Филиалы · Система · Подписка.
        // Всё, что описывает САМУ клинику и её установку Easy-Med, в одном
        // месте и в этом порядке — сначала кто мы, потом где мы, потом чем
        // мы это обслуживаем и за что платим. Группа уже существовала с
        // «Компанией» и «Системой»; она расширена, а не заведена третья
        // рядом с ней. «Системные настройки» (CRM, телефония, Telegram, API)
        // остаются отдельной группой: это подключения к чужим сервисам, а не
        // сведения о клинике.
        title: 'Настройки Easy-Med', icon: 'Shield', color: { bg: '#e4f3f1', fg: '#1f8a80' },
        items: [
            { label: 'Компания',            desc: 'Название, логотип, фирменный цвет и контакты клиники', icon: 'ID', live: true, action: nav('documents-settings') },
            // Единственное «управление филиалами» в системе: тот же редактор
            // (LOOKUP_CONFIG.branches), просто теперь у него один вход, а не
            // собственная группа из двух строк.
            { label: 'Филиалы',             desc: 'Физические адреса клиник', icon: 'Building', live: true, action: () => openSection('branches') },
            // SETTINGS_SPLIT_V1 (2026-08-29, владелец: «в подписке оставить
            // только подписку и статус модулей (с запросом), а в системе —
            // только версию и что нового») — «Система» больше не четыре
            // карточки в одном экране. Каждая плитка ведёт на свой маршрут:
            //   Система        → 'updates'      (версия + «что нового»)
            //   Подписка       → 'subscription' (состояние подписки + модули)
            //   Данные клиники → 'clinic-data'  (копии + опасная зона)
            { label: 'Система',             desc: 'Версия системы и что нового в последнем обновлении', icon: 'Shield', live: true, action: nav('updates') },
            // «Подписка» — теперь собственный экран, но карточка внутри него
            // ТА ЖЕ САМАЯ (views/system-subscription.js): экран её импортирует,
            // а не копирует. Второй копии подписки в системе нет.
            { label: 'Подписка',            desc: 'Активация, срок действия и подключённые модули', icon: 'Wallet', live: true, action: nav('subscription') },
            // «Данные клиники» — единственный вход к резервным копиям и к
            // полному удалению данных. Плитка появилась вместе с разделением:
            // без неё обе функции остались бы в коде, но исчезли бы с экрана,
            // а другого пути к backup_create/backup_restore/factory_reset в
            // системе нет вообще.
            { label: 'Данные клиники',      desc: 'Резервные копии и полное удаление данных клиники', icon: 'Database', live: true, action: nav('clinic-data') },
        ],
    },
    {
        // ROOMS_SETUP_V1 — ОДНА группа, а не две. Помещения клиники стояли
        // двумя карточками («Кабинеты и этажи» + «Стационар») по четырём
        // построчным редакторам, и объединённый экран, попав в обе, дал два
        // одинаковых пункта «Помещения» — ровно ту путаницу, ради устранения
        // которой раздел и делался. Теперь вход один; старые редакторы остались
        // под ним, потому что дают поля, которых нет в мастере, и импорт.
        title: 'Помещения', icon: 'Building', color: { bg: '#e8f6ed', fg: '#2e8b52' },
        items: [
            { label: 'Помещения', desc: 'Этажи, кабинеты и палаты в одном экране · койки, цена, очередь, врачи', icon: 'Building', live: true, action: nav('rooms-setup') },
            { label: 'Этажи',    desc: 'Этажи и уровни здания',                    icon: 'Layers', live: true, action: () => openSection('floors') },
            { label: 'Кабинеты', desc: 'Кабинеты приёма и процедурные по этажам',  icon: 'Grid',   live: true, action: () => openSection('rooms') },
            { label: 'Палаты',   desc: 'Палаты стационара',                        icon: 'Bed',    live: true, action: () => openSection('wards') },
            { label: 'Кровати',  desc: 'Койки по палатам',                         icon: 'Bed',    live: true, action: () => openSection('beds') },
        ],
    },
    {
        title: 'Управление плательщиками', icon: 'Coins', color: { bg: '#e9ebfb', fg: '#4b52b0' },
        items: [
            { label: 'Компании-плательщики',       desc: 'Страховые и корпоративные плательщики', icon: 'Coins', live: true, action: () => openSection('payers') },
            { label: 'Страховые полисы',           desc: 'Программы покрытия по плательщикам',    icon: 'Doc',   live: true, action: () => openSection('payer_policies') },
            { label: 'Провайдеры онлайн-платежей', desc: 'Payme, Click, Uzum — комиссии клиники', icon: 'Coins', live: true, action: () => openSection('payment_providers') },
            { label: 'Кэшбэк',                     desc: 'Правила кэшбэка для пациентов',         icon: 'Coins', live: true, action: () => openSection('cashback_rules') },
        ],
    },
    {
        title: 'Направления', icon: 'MapPin', color: { bg: '#e3f4f7', fg: '#1f7f95' },
        items: [
            { label: 'Список источников',          desc: 'Откуда приходят пациенты',              icon: 'MapPin', live: true, action: () => openSection('referral_sources') },
            { label: 'Категории источников',       desc: 'Группы источников направлений',         icon: 'Folder', live: true, action: () => openSection('referral_source_categories') },
            { label: 'Реферальное вознаграждение', desc: 'Процент вознаграждения за услуги',      icon: 'Coins',  live: true, action: () => openSection('referral_rewards') },
        ],
    },
    {
        title: 'Зарплата врача', icon: 'Coins', color: { bg: '#fbeae9', fg: '#b0453b' },
        items: [
            { label: 'Ставки врачей', desc: 'Процент врача по каждой услуге', icon: 'Coins', live: true, action: () => openSection('doctor_rates') },
        ],
    },
];

let hubQuery = '';

// «N разделов» — Russian needs 3 plural forms, so build the count outside tr()
// (which keys on whole source strings and cannot interpolate).
function sectionsLabel(n) {
    const lang = getLang();
    if (lang === 'en') return n + (n === 1 ? ' section' : ' sections');
    if (lang === 'uz') return n + " bo'lim";
    const d10 = n % 10, d100 = n % 100;
    const word = (d10 === 1 && d100 !== 11) ? 'раздел'
        : (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) ? 'раздела'
        : 'разделов';
    return n + ' ' + word;
}

function renderHub(container) {
    const searchInp = h('input', { type: 'search', class: 'set-search', placeholder: 'Поиск настроек…', value: hubQuery });
    const grid = h('div', { class: 'set-grid' });
    searchInp.addEventListener('input', () => { hubQuery = searchInp.value; renderGrid(grid); });

    container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Настройки'),
                h('p', { class: 'page-subtitle' }, 'Управление данными клиники — услуги, пользователи, плательщики, филиалы, направления и многое другое.'),
            ),
            searchInp,
        ),
        grid,
    ));
    renderGrid(grid);
}

function renderGrid(grid) {
    clear(grid);
    const q = hubQuery.trim().toLowerCase();
    // Search both the Russian source strings and what is actually on screen, so
    // typing "patients" finds Пациенты while the app is in English.
    const haystack = (it) => [it.label, it.desc, tr(it.label), tr(it.desc || '')].join(' ').toLowerCase();
    const match = (it) => !q || haystack(it).includes(q);
    // Cards in a grid row stretch to the tallest one, so order by section count
    // (desc) to keep each row's cards close in size — otherwise a 1-section card
    // lands beside a 5-section one and grows four empty rows of padding. Sort is
    // stable, so same-sized groups keep their declaration order (easymed's).
    const visible = GROUPS
        .map(group => ({ group, items: q ? group.items.filter(match) : group.items }))
        .filter(x => x.items.length)
        .sort((a, b) => b.items.length - a.items.length);
    if (!visible.length) { grid.appendChild(h('div', { class: 'empty set-empty' }, 'Ничего не найдено.')); return; }
    for (const v of visible) grid.appendChild(buildGroupCard(v.group, v.items));
}

function buildGroupCard(group, items) {
    const c = group.color || { bg: 'var(--ink-50)', fg: 'var(--ink-600)' };
    return h('div', { class: 'card set-card' },
        h('div', { class: 'set-card-head' },
            h('span', { class: 'set-card-ico', style: { background: c.bg, color: c.fg } }, Icon(group.icon, { size: 17 })),
            h('div', null,
                h('div', { class: 'set-card-title' }, group.title),
                // Counts what is on screen, so it stays honest while searching.
                h('div', { class: 'set-card-sub' }, sectionsLabel(items.length)),
            ),
        ),
        h('div', { class: 'set-card-body' }, ...items.map(buildItemRow)),
    );
}

function buildItemRow(item) {
    const chip = h('span', { class: 'set-row-ico' }, Icon(item.icon, { size: 15 }));
    const name = item.live
        ? item.label
        : h('span', null, item.label, h('span', { class: 'set-soon-tag' }, ' · Скоро'));
    // Both lines ellipsize, and at three columns there is less room to do it in —
    // so each carries its full text as a tooltip rather than being unreadable.
    const desc = item.live ? item.desc : 'Раздел скоро будет доступен';
    const text = h('div', { class: 'set-row-txt' },
        h('div', { class: 'set-row-name', title: item.label }, name),
        h('div', { class: 'set-row-desc', title: desc }, desc),
    );

    if (!item.live) return h('div', { class: 'set-row set-row-soon' }, chip, text);

    const row = h('div', {
        class: 'set-row set-row-link',
        role: 'button',
        tabindex: '0',
        onclick: item.action,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.action(); } },
    },
        chip, text,
        h('span', { class: 'set-row-chev' }, Icon('ChevronRight', { size: 14 })));
    return row;
}

// -----------------------------------------------------------------------------
// LOOKUP EDITOR — shared, config-driven CRUD.
//   field types: text | number | select (static options) | fk (async options)
//     fk fields: { fkTable, fkLabel, fkActiveCol?='active', fkFilter?={col:val} }
//   column types: plain (row[key]) | embed (row[key][embedLabel||'name'])
//     embed cfg: cfg.embed = 'table(col)[, table2(col2)]'  (matches select())
// -----------------------------------------------------------------------------
const LOOKUP_CONFIG = {
    // ---- Основное / General ----------------------------------------------
    patient_categories: {
        table: 'patient_categories', title: 'Patient categories', icon: 'ID',
        columns: [{ key: 'name', label: 'Name' }, { key: 'tier', label: 'Tier' }],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'tier', label: 'Tier', type: 'text' },
        ],
    },
    patient_discounts: {
        table: 'patient_discounts', title: 'Discounts & certificates', icon: 'Coins',
        columns: [{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' }, { key: 'percent', label: 'Percent %' }, { key: 'amount', label: 'Amount' }],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'kind', label: 'Kind', type: 'select', options: [['promo', 'Промокод'], ['gift_card', 'Подарочная карта'], ['certificate', 'Сертификат']] },
            { key: 'percent', label: 'Percent off (%)', type: 'number' },
            { key: 'amount', label: 'Fixed amount (UZS)', type: 'number' },
        ],
    },
    api_tokens: {
        table: 'api_tokens', title: 'API tokens', icon: 'Settings',
        columns: [{ key: 'name', label: 'Name' }, { key: 'token', label: 'Token' }],
        fields: [
            { key: 'name', label: 'Token name / purpose', type: 'text', required: true },
            { key: 'token', label: 'Token value', type: 'text' },
        ],
    },

    // ---- Настройки услуг / Service settings -------------------------------
    service_types: {
        table: 'service_types', title: 'Service types', icon: 'Layers',
        columns: [{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'billing_mode', label: 'Billing' }],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'code', label: 'Code', type: 'text' },
            { key: 'billing_mode', label: 'Billing mode', type: 'select', options: [['one_time', 'Разовая'], ['continuable', 'Продлеваемая']] },
        ],
    },
    consultation_types: {
        table: 'consultation_types', title: 'Consultation types', icon: 'Flask',
        columns: [{ key: 'name', label: 'Name' }, { key: 'price', label: 'Price' }],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'price', label: 'Price', type: 'number' },
        ],
    },

    // ---- Управление персоналом / Staff -----------------------------------
    departments: {
        table: 'departments', title: 'Departments', icon: 'Building',
        columns: [{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'kind', label: 'Kind' }],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'code', label: 'Code', type: 'text' },
            { key: 'kind', label: 'Kind', type: 'select', options: [['clinical', 'Клиническое'], ['laboratory', 'Лабораторное'], ['diagnostics', 'Диагностическое'], ['procedure', 'Процедурное'], ['inpatient', 'Стационарное'], ['administrative', 'Административное']] },
        ],
    },

    // ---- Управление филиалами / Branch management ------------------------
    branches: {
        table: 'branches', title: 'Branches', icon: 'Building',
        columns: [{ key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'address', label: 'Address' }],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'phone', label: 'Phone', type: 'phone' },
            { key: 'address', label: 'Address', type: 'text' },
        ],
    },

    // ---- Управление плательщиками / Payer management ---------------------
    payers: {
        table: 'payers', title: 'Payer companies', icon: 'Coins',
        columns: [{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' }],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'kind', label: 'Kind', type: 'select', options: [['insurance', 'Страховая'], ['corporate', 'Корпоративный'], ['government', 'Государственный']] },
        ],
    },
    payer_policies: {
        table: 'payer_policies', title: 'Payer policies', icon: 'Doc', embed: 'payers(name)',
        columns: [{ key: 'name', label: 'Policy' }, { key: 'payers', label: 'Payer', embed: true }, { key: 'coverage_percent', label: 'Coverage %' }],
        fields: [
            { key: 'name', label: 'Policy name (e.g. Gold 2026)', type: 'text', required: true },
            { key: 'payer_id', label: 'Payer company', type: 'fk', fkTable: 'payers', fkLabel: 'name' },
            { key: 'coverage_percent', label: 'Coverage % (insurer pays)', type: 'number' },
        ],
    },
    payment_providers: {
        table: 'payment_providers', title: 'Online payment providers', icon: 'Coins',
        columns: [{ key: 'name', label: 'Provider' }, { key: 'fee_percent', label: 'Fee %' }],
        fields: [
            { key: 'name', label: 'Provider name (Payme, Click, Uzum…)', type: 'text', required: true },
            { key: 'fee_percent', label: 'Processing fee charged to the clinic (%)', type: 'number' },
        ],
    },
    cashback_rules: {
        table: 'cashback_rules', title: 'Cashback', icon: 'Coins',
        columns: [{ key: 'name', label: 'Rule' }, { key: 'percent', label: 'Cashback %' }],
        fields: [
            { key: 'name', label: 'Rule name (e.g. Self-pay 3%)', type: 'text', required: true },
            { key: 'percent', label: 'Cashback % (returned to patient)', type: 'number' },
        ],
    },

    // ---- Кабинеты и этажи / Rooms & floors -------------------------------
    floors: {
        table: 'floors', title: 'Floors', icon: 'Layers',
        columns: [{ key: 'name', label: 'Name' }, { key: 'level', label: 'Level' }],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'level', label: 'Level', type: 'number' },
        ],
    },
    rooms: {
        table: 'rooms', title: 'Rooms', icon: 'Grid', embed: 'floors(name)',
        columns: [{ key: 'name', label: 'Name' }, { key: 'floors', label: 'Floor', embed: true }],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'floor_id', label: 'Floor', type: 'fk', fkTable: 'floors', fkLabel: 'name' },
        ],
    },

    // ---- Стационар / Inpatient -------------------------------------------
    wards: {
        table: 'wards', title: 'Wards', icon: 'Bed',
        columns: [{ key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'billing_mode', label: 'Billing' }, { key: 'price_per_day', label: 'Price/day' }],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'type', label: 'Type', type: 'select', options: [['general', 'Общая'], ['icu', 'Реанимация'], ['maternity', 'Родильная'], ['pediatrics', 'Детская'], ['surgery', 'Хирургическая'], ['oncology', 'Онкологическая'], ['isolation', 'Изолятор'], ['other', 'Прочая']] },
            { key: 'billing_mode', label: 'Accommodation billing', type: 'select', options: [['daily', 'Посуточно'], ['hourly', 'Почасово']] },
            { key: 'price_per_day', label: 'Price per day (UZS)', type: 'number' },
            { key: 'price_per_hour', label: 'Price per hour (UZS)', type: 'number' },
        ],
    },
    beds: {
        // `status` is operational (managed on the Ward & beds board via the inpatient
        // RPCs), not config — so it is shown read-only in the list but not editable here.
        table: 'beds', title: 'Beds', icon: 'Bed', embed: 'wards(name)', orderBy: 'code',   // beds has no `name` column — order by `code`
        columns: [{ key: 'code', label: 'Code' }, { key: 'wards', label: 'Ward', embed: true }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }],
        fields: [
            { key: 'code', label: 'Code', type: 'text', required: true },
            { key: 'ward_id', label: 'Ward', type: 'fk', fkTable: 'wards', fkLabel: 'name' },
            { key: 'type', label: 'Type', type: 'select', options: [['standard', 'Обычная'], ['icu', 'Реанимационная'], ['isolation', 'Изоляционная'], ['vip', 'VIP'], ['recovery', 'Послеоперационная'], ['observation', 'Наблюдения']] },
            { key: 'price_per_day', label: 'Price/day override (0 = use ward)', type: 'number' },
            { key: 'price_per_hour', label: 'Price/hour override (0 = use ward)', type: 'number' },
        ],
    },

    // ---- Направления / Referrals -----------------------------------------
    // REFERRAL_SOURCE_PERSON_V1 (mig 058) — a source is normally a PERSON the
    // clinic pays a commission to, so the card carries ФИО in three parts, how to
    // reach them, where they work, and the payout details. The `name` column is
    // still what every consumer displays (визит-мастер «Кто направил», отчёт
    // «Рефералы», подбор услуг) — beforeSave composes it from the ФИО parts, so
    // none of them had to change and non-person rows («Instagram») keep working.
    referral_sources: {
        table: 'referral_sources', title: 'Source list', icon: 'MapPin',
        addTitle: 'Новый источник направления', editTitle: 'Источник направления',
        modalWidth: '620px', modalCols: '1fr 1fr',
        columns: [
            { key: 'name', label: 'ФИО' },
            { key: 'phone', label: 'Телефон' },
            { key: 'workplace', label: 'Место работы' },
            { key: 'district', label: 'Район' },
            { key: 'category', label: 'Категория' },
        ],
        fields: [
            { key: 'last_name',   label: 'Фамилия', type: 'text' },
            { key: 'first_name',  label: 'Имя', type: 'text', required: true },
            { key: 'middle_name', label: 'Отчество', type: 'text' },
            { key: 'phone',       label: 'Телефон', type: 'phone' },
            { key: 'workplace',   label: 'Место работы', type: 'text' },
            { key: 'district',    label: 'Район', type: 'text' },
            { key: 'payment_type', label: 'Тип оплаты', type: 'select',
              options: [['cash', 'Наличные'], ['card', 'На карту'], ['transfer', 'Перечислением']] },
            { key: 'card_number', label: 'Номер карты', type: 'text' },
            // Свободный текст с подсказками из «Категорий источников»: визит-мастер
            // группирует источники ПО ЭТОЙ СТРОКЕ, и три написания одной категории
            // дали бы три отдельные группы.
            { key: 'category',    label: 'Категория', type: 'suggest',
              listTable: 'referral_source_categories', listLabel: 'name' },
        ],
        // `name` — производная колонка: её не показываем, но она NOT NULL и
        // остаётся тем, что видят все остальные экраны.
        beforeSave(payload) {
            const full = [payload.last_name, payload.first_name, payload.middle_name]
                .map(v => (v || '').trim()).filter(Boolean).join(' ');
            if (!full) return 'Укажите хотя бы имя источника.';
            payload.name = full;
        },
    },
    referral_source_categories: {
        table: 'referral_source_categories', title: 'Source categories', icon: 'Folder',
        columns: [{ key: 'name', label: 'Name' }],
        fields: [{ key: 'name', label: 'Category name', type: 'text', required: true }],
    },
    referral_rewards: {
        table: 'referral_rewards', title: 'Referral reward', icon: 'Coins',
        columns: [{ key: 'name', label: 'Name' }, { key: 'percent', label: 'Reward %' }],
        fields: [
            { key: 'name', label: 'Reward rule name', type: 'text', required: true },
            { key: 'percent', label: 'Reward % of service price', type: 'number' },
        ],
    },

    // ---- Зарплата врача / Doctor salary ----------------------------------
    doctor_rates: {
        table: 'doctor_rates', title: 'Doctor rates', icon: 'Coins',
        embed: 'users(full_name), services(name)', orderBy: 'id',   // doctor_rates has no `name` column
        columns: [
            { key: 'users', label: 'Doctor', embed: true, embedLabel: 'full_name' },
            { key: 'services', label: 'Service', embed: true },
            { key: 'percent', label: 'Percent %' },
        ],
        fields: [
            { key: 'doctor_id', label: 'Doctor', type: 'fk', fkTable: 'users', fkLabel: 'full_name', fkActiveCol: 'is_active', fkFilter: { role: 'doctor' }, required: true },
            { key: 'service_id', label: 'Service', type: 'fk', fkTable: 'services', fkLabel: 'name', required: true },
            { key: 'percent', label: 'Doctor % of service price', type: 'number' },
        ],
    },
};

// Render a table cell, treating 0 as a real value (not "empty").
function fmtCell(v) {
    if (v === 0) return '0';
    return (v === null || v === undefined || v === '') ? '—' : String(v);
}

// ENUM_LABELS_V1 — a select's options as [storedValue, humanLabel] pairs.
// Older entries were bare strings used as BOTH, which is how «insurance» and
// «gift_card» ended up in front of a registrar. Bare strings still work (they
// become their own label) so a config can be migrated one list at a time.
function optionPairs(f) {
    return (f.options || []).map(o => (Array.isArray(o) ? o : [o, o]));
}

// The label for a stored enum value, for the LIST view — without this the table
// would keep printing the raw value while the editor showed the translated one.
function enumLabel(cfg, key, value) {
    const f = (cfg.fields || []).find(x => x.key === key && x.type === 'select');
    if (!f) return value;
    const hit = optionPairs(f).find(([val]) => val === value);
    return hit ? hit[1] : value;
}

async function renderEditor(container, key) {
    const cfg = LOOKUP_CONFIG[key];
    if (!cfg) { backToHub(); return; }   // unknown section — safety net, never happens from the hub UI

    const tbody = h('tbody');
    const emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        `No ${cfg.title.toLowerCase()} yet — add the first one.`);

    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openRowModal(null) },
        Icon('Plus', { size: 14 }), ' Add');

    // BRANCH_SYNC_V1 — слот под карточку связи филиалов. Заполняется после
    // отрисовки (карточка ходит в RPC), поэтому список филиалов появляется
    // сразу и не ждёт сети.
    const syncSlot = key === 'branches' ? h('div') : null;

    container.appendChild(h('div', { class: 'fade-in' },
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginBottom: '14px' }, onclick: backToHub },
            Icon('ChevronLeft', { size: 14 }), ' Back to settings'),
        h('div', { class: 'page-head' },
            h('div', null, h('h1', { class: 'page-title' }, cfg.title)),
        ),
        syncSlot,
        h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon(cfg.icon, { size: 16 }), ' ', cfg.title),
                addBtn,
            ),
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    ...cfg.columns.map(c => h('th', null, c.label)),
                    h('th', null, 'Active'),
                )),
                tbody,
            ),
            emptyEl,
        ),
    ));

    if (syncSlot) {
        // Не await: карточка связи не должна задерживать список, а её
        // собственные отказы она показывает сама.
        renderBranchSyncCard(syncSlot).catch((e) => console.warn('[branch-sync] card failed:', e && e.message));
    }

    await load();

    async function load() {
        clear(tbody);
        tbody.appendChild(h('tr', null,
            h('td', { colspan: String(cfg.columns.length + 1), style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Loading…')));
        emptyEl.style.display = 'none';
        try {
            const cols = cfg.embed ? '*, ' + cfg.embed : '*';
            const { data, error } = await supabase.from(cfg.table).select(cols).order(cfg.orderBy || 'name').limit(500);
            if (error) { toast(`Failed to load ${cfg.title.toLowerCase()}: ` + (error.message || error), 'fail'); paintRows([]); return; }
            paintRows(data || []);
        } catch (e) {
            toast(`Failed to load ${cfg.title.toLowerCase()}: ` + (e && e.message || e), 'fail');
            paintRows([]);
        }
    }

    function paintRows(rows) {
        clear(tbody);
        if (!rows || rows.length === 0) { emptyEl.style.display = ''; return; }
        emptyEl.style.display = 'none';
        for (const row of rows) tbody.appendChild(rowEl(row));
    }

    function rowEl(row) {
        const inactive = !row.active;
        return h('tr', {
            class: 'row-click',
            style: { cursor: 'pointer', opacity: inactive ? '0.55' : '' },
            onclick: () => openRowModal(row),
        },
            ...cfg.columns.map(c => h('td', null,
                c.embed ? fmtCell(row[c.key] ? row[c.key][c.embedLabel || 'name'] : null)
                        : fmtCell(enumLabel(cfg, c.key, row[c.key])))),
            h('td', null, Tag(row.active ? 'Yes' : 'No', { kind: row.active ? 'ok' : '', dot: true })),
        );
    }

    // -------------------------------------------------------------------
    // ADD / EDIT MODAL — shared across all tables, built from cfg.fields.
    // -------------------------------------------------------------------
    function openRowModal(row) {
        const isEdit = !!row;
        const overlay = h('div', { class: 'modal' });
        const close = () => overlay.remove();
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

        const controls = {};   // field key -> input/select element
        const fkFields = [];   // fk fields whose <select> options load async, after mount
        const suggestFields = [];   // SUGGEST_FIELD_V1 — datalists filled after mount
        const fieldEls = cfg.fields.map(f => {
            let control;
            if (f.type === 'select') {
                // ENUM_LABELS_V1 — options are [storedValue, humanLabel]. The
                // value that reaches the DB is unchanged; only what the user
                // reads is different, and h() runs the label through tr(), so
                // the same list serves ru / en / uz.
                control = h('select', null,
                    !f.required ? h('option', { value: '' }, '—') : null,
                    ...optionPairs(f).map(([val, label]) =>
                        h('option', { value: val, selected: !!(row && row[f.key] === val) }, label)));
            } else if (f.type === 'number') {
                control = h('input', { type: 'number', value: row && row[f.key] != null ? String(row[f.key]) : '' });
            } else if (f.type === 'phone') {
                // PHONE_INPUT_V1 — country picker, Uzbekistan by default. Its
                // .value reads '' while only the dialling code is present, so
                // save() below treats an untouched field as empty.
                control = phoneInput(f.key, f.placeholder || '+998 90 961 00 04', { value: row ? row[f.key] : '' });
            } else if (f.type === 'fk') {
                // Options populated after mount by loadFkOptions() (see below) — starts
                // with just the "— none —" placeholder so the modal can render immediately.
                control = h('select', null, h('option', { value: '' }, '— none —'));
                fkFields.push(f);
            } else if (f.type === 'suggest') {
                // SUGGEST_FIELD_V1 — a plain TEXT column with a <datalist> of the
                // values already in use elsewhere (f.listTable/f.listLabel). Free
                // text still saves, so nothing that groups on the string breaks —
                // the list only stops the same category being spelled three ways.
                const listId = 'sg-' + f.key + '-' + Math.floor(performance.now());
                const dl = h('datalist', { id: listId });
                control = h('span', { style: { display: 'block' } },
                    h('input', { type: 'text', list: listId, value: row ? (row[f.key] || '') : '', style: { width: '100%' } }),
                    dl);
                // .value on the wrapper must read the input's — save() is generic.
                const inner = control.firstChild;
                Object.defineProperty(control, 'value', { get: () => inner.value, set: (v) => { inner.value = v; } });
                suggestFields.push({ f, dl });
            } else {
                control = h('input', { type: 'text', value: row ? (row[f.key] || '') : '' });
            }
            controls[f.key] = control;
            return field(f.label, control, { required: !!f.required });
        });
        const activeChk = h('input', { type: 'checkbox', checked: row ? !!row.active : true });

        // FK_OPTIONS_V2 — load each fk <select>'s options from its lookup table
        // (active rows only, alphabetical), then re-select the row's current value.
        // Supports a custom active column (f.fkActiveCol, e.g. users.is_active) and
        // an extra equality filter (f.fkFilter, e.g. { role: 'doctor' }).
        async function loadFkOptions(f) {
            const select = controls[f.key];
            try {
                let q = supabase.from(f.fkTable).select('id,' + f.fkLabel).eq(f.fkActiveCol || 'active', 1);
                if (f.fkFilter) for (const [col, val] of Object.entries(f.fkFilter)) q = q.eq(col, val);
                const { data, error } = await q.order(f.fkLabel);
                if (error) throw error;
                const current = row && row[f.key] != null ? Number(row[f.key]) : null;
                clear(select);
                select.appendChild(h('option', { value: '' }, '— none —'));
                for (const opt of (data || [])) {
                    select.appendChild(h('option', { value: String(opt.id), selected: current !== null && current === Number(opt.id) }, opt[f.fkLabel]));
                }
            } catch (e) {
                toast(`Failed to load ${f.label.toLowerCase()} options: ` + (e && e.message || e), 'fail');
            }
        }

        // SUGGEST_FIELD_V1 — fill a datalist with the distinct values already used
        // in f.listTable. Failure is silent: the field is free text either way.
        async function loadSuggestions({ f, dl }) {
            try {
                const { data } = await supabase.from(f.listTable).select(f.listLabel).limit(300);
                const seen = [...new Set((data || []).map(r => (r[f.listLabel] || '').trim()).filter(Boolean))]
                    .sort((a, b) => a.localeCompare(b, 'ru'));
                for (const v of seen) dl.appendChild(h('option', { value: v }));
            } catch (e) { /* suggestions are a convenience, never a blocker */ }
        }

        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isEdit ? 'Save' : 'Add');
        saveBtn.addEventListener('click', save);

        async function save() {
            const payload = {};
            for (const f of cfg.fields) {
                if (f.type === 'number') { payload[f.key] = Number(controls[f.key].value) || 0; continue; }
                if (f.type === 'fk') {
                    const raw = controls[f.key].value;
                    if (f.required && !raw) { toast(`Choose ${f.label.toLowerCase()}.`, 'fail'); return; }
                    payload[f.key] = raw ? Number(raw) : null;
                    continue;
                }
                const raw = controls[f.key].value;
                const v = typeof raw === 'string' ? raw.trim() : raw;
                if (f.required && !v) { toast(`Enter ${f.label.toLowerCase()}.`, 'fail'); return; }
                if (v) payload[f.key] = v;   // skip empties — omitted, never sent as ''
            }
            if (isEdit) payload.active = activeChk.checked ? 1 : 0;   // insert never accepts `active`

            // DERIVED_COLUMN_V1 — a config may compute columns the form does not
            // show (referral_sources.name from the three ФИО parts). Returning a
            // string aborts the save with that message.
            if (cfg.beforeSave) {
                const problem = cfg.beforeSave(payload, { isEdit, row });
                if (typeof problem === 'string') { toast(problem, 'fail'); return; }
            }

            saveBtn.disabled = true;
            const prevLabel = saveBtn.textContent;
            saveBtn.textContent = isEdit ? 'Saving…' : 'Adding…';
            try {
                const { error } = isEdit
                    ? await supabase.from(cfg.table).update(payload).eq('id', row.id).select().single()
                    : await supabase.from(cfg.table).insert(payload).select().single();
                if (error) throw error;
                toast('Saved', 'ok');
                close();
                await load();
            } catch (e) {
                toast((e && e.message) || 'Failed to save.', 'fail');
                saveBtn.disabled = false;
                saveBtn.textContent = prevLabel;
            }
        }

        // A config with many fields can ask for a wider, two-column body — a
        // nine-field form in the default 440px column is a scrollbar.
        overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: (cfg.modalWidth || '440px'), maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon(cfg.icon, { size: 16 }), ' ',
                    isEdit ? (cfg.editTitle || ('Edit ' + cfg.title)) : (cfg.addTitle || ('Add ' + cfg.title))),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body', style: cfg.modalCols ? { display: 'grid', gridTemplateColumns: cfg.modalCols, gap: '0 14px' } : null },
                ...fieldEls,
                isEdit ? checkField('Active', activeChk) : null,
            ),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
                h('span', { class: 'grow' }),
                saveBtn),
        ));
        document.body.appendChild(overlay);
        for (const f of fkFields) loadFkOptions(f);
        for (const s of suggestFields) loadSuggestions(s);
    }
}
