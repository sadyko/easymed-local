// ADMIN_ACT_AS_V1 (2026-10-28) — «ВХОДЫ ОТ ИМЕНИ» В КАРТОЧКЕ СОТРУДНИКА.
//
// Спецификация — docs/specs/2026-10-28-admin-act-as-design.md: «Карточка
// сотрудника (для администратора) — „Входы от имени“: список сессий и
// действий». Журнал читает только GET /api/auth/act-as/log (сервер пускает
// администратора из своей учётной записи); здесь — показ:
//
//   • сеансы, где этот сотрудник — тот, от чьего имени работали, или сам
//     администратор, работавший от имени других (сервер отдаёт оба вида,
//     новые первыми, не больше 100): кто, когда, сколько длилось, чем кончилось,
//     сколько действий и сколько из них — записи;
//   • по нажатию — действия сеанса по порядку: время, что сделано словами
//     (таблица или RPC — короткой русской подписью, неизвестное — как есть),
//     чем ответил сервер. Чтения через RPC помечены «только чтение».
//
// Данных пациента в журнале нет и здесь быть не может: только имена таблиц,
// RPC и корзин файлов.
import { h, Icon, clear, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';

const LOG = '/api/auth/act-as/log';

async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    let json = {};
    try { json = await res.json(); } catch (_) { json = {}; }
    if (!res.ok) throw new Error((json && json.error && json.error.message) || ('HTTP ' + res.status));
    return json;
}

// --- что сделано — словами -------------------------------------------------

// RPC, которые что-то меняют, — короткой подписью. Остальные (редкие)
// показываются своим именем: честнее имени, чем выдуманная подпись.
// FIX_318_V1 (ADMIN_ACT_AS_V1) — и частые чтения: оболочка спрашивает их на
// каждом экране, и журнал без подписей читался как лог сервера
// («get_clinic_by_slug», «nav_visibility_get»). Подписаны чтения оболочки и
// RPC выпуска 3.18.0 (меню, «Телефон», «Реферирование», бот врачей, Meta,
// ссылки Telegram).
const RPC_LABELS = {
    record_payment: 'Приём оплаты',
    record_payment_split: 'Приём оплаты частями',
    create_invoice_for_visit: 'Счёт за визит',
    void_invoice: 'Отмена счёта',
    refund_payment: 'Возврат оплаты',
    refund_invoice_line: 'Возврат по строке счёта',
    mark_invoice_debt: 'Счёт — в долг',
    delete_invoice: 'Удаление счёта',
    open_cash_shift: 'Открытие смены кассы',
    close_cash_shift: 'Закрытие смены кассы',
    cash_move: 'Движение денег в кассе',
    accept_deposit: 'Приём аванса',
    refund_deposit: 'Возврат аванса',
    calendar_book: 'Запись на приём',
    ensure_visit: 'Открытие визита',
    booking_lines_add: 'Услуги в записи',
    booking_line_remove: 'Услуга убрана из записи',
    patient_card_save: 'Карта пациента',
    patient_card_doc_add: 'Документ в карте пациента',
    patient_card_doc_void: 'Отзыв документа пациента',
    merge_patients: 'Объединение пациентов',
    procedure_assign: 'Процедура взята',
    procedure_complete: 'Процедура выполнена',
    save_lab_results: 'Результаты анализов',
    visit_document_archive: 'Подписанный документ в архив',
    dispense_visit_item: 'Выдача товара пациенту',
    dispense_item: 'Выдача товара',
    remove_unpaid_service: 'Удаление неоплаченной услуги',
    change_unpaid_service: 'Замена неоплаченной услуги',
    admission_order_create: 'Направление в стационар',
    admission_admit: 'Размещение в стационаре',
    admission_review_save: 'Запись истории болезни',
    admission_discharge_request: 'Заявка на выписку',
    admission_discharge_finalize: 'Выписка',
    treatment_order_create: 'Назначение лечения',
    treatment_admin_mark: 'Отметка о выполнении назначения',
    admin_reset_user_password: 'Сброс пароля сотрудника',
    // FIX_318_V1 — оболочка (каждый экран)
    get_clinic_by_slug: 'Данные клиники',
    licence_status: 'Состояние лицензии',
    update_status: 'Проверка обновлений',
    nav_visibility_get: 'Видимость разделов',
    nav_visibility_save: 'Изменение видимости разделов',
    telegram_chat_unread: 'Непрочитанные сообщения Telegram',
    stock_pending_count: 'Не списано со склада',
    lan_address_status: 'Адрес в сети',
    crm_config_get: 'Настройки CRM',
    inpatient_capabilities: 'Права в стационаре',
    deposit_balance: 'Баланс аванса',
    patient_base_aggregates: 'Сводка по пациентам',
    disk_usage: 'Место на диске',   // DISK_GUARD_V1 — колокол администратора спрашивает каждую минуту
    // FIX_318_V1 — панель «Телефон», «Звонит», экран «Телефония»
    telephony_phone_me: 'Панель «Телефон»',
    telephony_live: 'Звонки сейчас',
    telephony_call_log: 'Журнал звонков',
    telephony_extensions: 'Внутренние номера станции',
    telephony_my_extension: 'Свой внутренний номер',
    telephony_webrtc_me: 'Вход телефона Easy-Med в АТС',   // SOFTPHONE_V1
    telephony_caller: 'Кто звонит',                        // SOFTPHONE_V1
    telephony_dial: 'Звонок из программы',
    telephony_ring_info: 'Адрес событий станции',
    telephony_ring_token_rotate: 'Новый адрес событий станции',
    telephony_recent_calls: 'Последние звонки',
    telephony_dispositions: 'Исходы звонков',
    telephony_settings_get: 'Настройки телефонии',
    telephony_providers_list: 'Провайдеры телефонии',
    // FIX_318_V1 — «Реферирование» и бот для врачей-источников
    referrals_representatives: 'Реферирование: представители',
    referrals_internal: 'Реферирование: врачи клиники',
    referrals_activity: 'Реферирование: активность',
    referrals_source_detail: 'Реферирование: внешний врач',
    referrals_doctor_detail: 'Реферирование: врач клиники',
    referrals_assign_representative: 'Закрепление врача за представителем',
    doctor_bot_settings_get: 'Бот для врачей: настройки',
    doctor_bot_settings_save: 'Бот для врачей: сохранение настроек',
    doctor_bot_token_clear: 'Бот для врачей: удаление токена',
    doctor_bot_test_connection: 'Бот для врачей: проверка связи',
    doctor_bot_stats: 'Бот для врачей: охват',
    doctor_bot_links_list: 'Бот для врачей: подключённые врачи',
    doctor_bot_link_revoke: 'Бот для врачей: отключение врача',
    // FIX_318_V1 — Meta и Telegram
    meta_settings_get: 'Meta: настройки',
    meta_settings_save: 'Meta: сохранение настроек',
    meta_connect: 'Meta: подключение страницы',
    meta_token_clear: 'Meta: удаление токена',
    meta_poll_now: 'Meta: получение заявок',
    meta_leads_recent: 'Meta: последние заявки',
    telegram_deeplinks_list: 'Ссылки для рекламы в Telegram',
    telegram_deeplink_save: 'Сохранение ссылки для рекламы',
    telegram_deeplink_delete: 'Удаление ссылки для рекламы',
    telegram_broadcast_options: 'Фильтры рассылки',
};

// Таблицы /api/db — чаще всего записываемые экраном.
const TABLE_LABELS = {
    visits: 'Визиты',
    visit_services: 'Услуги визита',
    patients: 'Пациенты',
    lab_results: 'Результаты анализов',
    invoices: 'Счета',
    invoice_items: 'Строки счёта',
    payments: 'Оплаты',
    stock_movements: 'Движение товара',
    services: 'Услуги',
    users: 'Сотрудники',
    crm_requests: 'Заявки CRM',
    crm_tasks: 'Задачи CRM',
    patient_activity_log: 'Журнал пациента',
    invoice_audit_log: 'Журнал счёта',
    admission_services: 'Услуги стационара',
    patient_relationships: 'Родственники пациента',
    consultation_templates: 'Шаблоны заключений',
    service_templates: 'Шаблоны услуг',
    doc_settings: 'Настройки документов',
    role_permissions: 'Права ролей',
    // FIX_318_V1 — «Реферирование» (3.18.0), документы кабинета, направления, метки CRM
    referral_sources: 'Врачи-источники',
    referral_source_categories: 'Категории источников',
    visit_documents: 'Документы визита',
    recommended_services: 'Направления врача',
    crm_request_tags: 'Метки заявок CRM',
};

// Корзины /api/storage.
const BUCKET_LABELS = {
    'clinic-docs': 'Документы клиники',
    'patient-photos': 'Фото пациентов',
    'doctor-photos': 'Фото врачей',
    'telegram-media': 'Файлы Telegram',
    'clinic-logos': 'Логотип клиники',
};

const OP_TEMPLATES = {
    insert: '{what}: добавление',
    update: '{what}: изменение',
    upsert: '{what}: запись',
    delete: '{what}: удаление',
};
const METHOD_OP = { POST: 'insert', PATCH: 'update', PUT: 'update', DELETE: 'delete' };
const FILE_TEMPLATES = { POST: '{what}: загрузка файла', PUT: '{what}: загрузка файла', DELETE: '{what}: удаление файла' };

const labelOr = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? tr(map[key]) : key);

/**
 * Действие журнала словами экрана. a — { kind, name } из act_as_actions:
 * db «таблица.операция», rpc «имя», users «МЕТОД /users/…», storage
 * «МЕТОД /storage/корзина». Незнакомое — как есть.
 */
export function actAsActionLabel(a) {
    const kind = a && a.kind;
    const name = String((a && a.name) || '');
    if (kind === 'rpc') return labelOr(RPC_LABELS, name);
    if (kind === 'db') {
        const dot = name.lastIndexOf('.');
        const table = dot > 0 ? name.slice(0, dot) : name;
        const op = dot > 0 ? name.slice(dot + 1) : '';
        const tpl = OP_TEMPLATES[op];
        return tpl ? trf(tpl, { what: labelOr(TABLE_LABELS, table) }) : name;
    }
    if (kind === 'users') {
        const tpl = OP_TEMPLATES[METHOD_OP[name.split(' ')[0]]];
        return tpl ? trf(tpl, { what: tr('Сотрудники') }) : name;
    }
    if (kind === 'storage') {
        const [method, where] = name.split(' ');
        const bucket = String(where || '').replace(/^\/storage\//, '');
        const tpl = FILE_TEMPLATES[method];
        return tpl ? trf(tpl, { what: labelOr(BUCKET_LABELS, bucket) }) : name;
    }
    return name;
}

/** Чем ответил сервер: «Выполнено» (2xx) или «Отказ · код». */
export function actAsStatusLabel(status) {
    const s = Number(status);
    if (s >= 200 && s < 300) return tr('Выполнено');
    return trf('Отказ · {code}', { code: Number.isFinite(s) && s > 0 ? String(s) : '—' });
}

/** Сколько длился вход от имени: «меньше минуты», «{n} мин», «{h} ч {m} мин». Идёт — до сейчас. */
export function actAsDuration(startedAt, endedAt, now = Date.now()) {
    const a = Date.parse(startedAt);
    const b = endedAt ? Date.parse(endedAt) : now;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '—';
    const min = Math.floor((b - a) / 60000);
    if (min < 1) return tr('меньше минуты');
    if (min < 60) return trf('{n} мин', { n: min });
    return trf('{h} ч {m} мин', { h: Math.floor(min / 60), m: min % 60 });
}

const pad2 = (n) => String(n).padStart(2, '0');
function timeOf(at) {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '—' : pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

const NOTE = { fontSize: '12.5px', color: 'var(--ink-500)' };

function actionsTable(out) {
    const list = (out && Array.isArray(out.actions)) ? out.actions : [];
    if (!list.length) return h('div', { class: 'muted', style: { ...NOTE, padding: '8px 0' } }, 'Действий не было.');
    const rows = list.map((a) => h('tr', { 'data-act-as-action': '', style: a.read_only ? { color: 'var(--ink-500)' } : null },
        h('td', { class: 'num', style: { whiteSpace: 'nowrap' } }, timeOf(a.at)),
        h('td', null, actAsActionLabel(a),
            a.read_only ? h('span', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '6px' } }, 'только чтение') : null),
        h('td', { style: { whiteSpace: 'nowrap', color: Number(a.status) >= 200 && Number(a.status) < 300 ? 'var(--ok-700, #1a7a44)' : 'var(--crit-700, #b91c1c)' } },
            actAsStatusLabel(a.status))));
    return h('div', null,
        h('div', { class: 'emp-table-wrap' }, h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Время'), h('th', null, 'Действие'), h('th', null, 'Результат'))),
            h('tbody', null, ...rows))),
        out.truncated ? h('div', { class: 'muted', style: { ...NOTE, marginTop: '6px' } }, trf('Показаны первые {n} действий.', { n: list.length })) : null);
}

function sessionRow(userId, s) {
    const box = h('div', { class: 'aah-actions', style: { display: 'none', marginTop: '10px' } });
    let loaded = false;
    let open = false;
    const toggle = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-act-as-toggle': '', 'aria-expanded': 'false', dataset: { viewOk: '1' } },
        Icon('ChevronRight', { size: 13 }), ' ', 'Показать действия');
    const setLabel = () => {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        clear(toggle);
        toggle.appendChild(Icon(open ? 'ChevronDown' : 'ChevronRight', { size: 13 }));
        toggle.appendChild(document.createTextNode(' ' + tr(open ? 'Скрыть действия' : 'Показать действия')));
    };
    toggle.addEventListener('click', async () => {
        open = !open;
        box.style.display = open ? '' : 'none';
        setLabel();
        if (!open || loaded) return;
        loaded = true;
        clear(box);
        box.appendChild(h('div', { class: 'muted', style: NOTE }, 'Загрузка…'));
        try {
            const out = await getJson(LOG + '?user_id=' + encodeURIComponent(userId) + '&act_as_id=' + encodeURIComponent(s.id));
            clear(box);
            box.appendChild(actionsTable(out));
        } catch (e) {
            loaded = false;
            clear(box);
            box.appendChild(h('div', { style: { ...NOTE, color: 'var(--crit-700, #b91c1c)' } }, trf('Не удалось загрузить журнал: {msg}', { msg: tr((e && e.message) || '') })));
        }
    });
    const ended = s.ended_at
        ? h('span', null, tr(s.end_reason || ''))
        : h('span', { style: { color: 'var(--purple-700, #6d28d9)', fontWeight: 600 } }, 'Идёт сейчас');
    return h('div', { class: 'aah-session', 'data-act-as-session': String(s.id), style: { padding: '12px 14px', border: '1px solid var(--ink-100)', borderRadius: '10px', marginBottom: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('div', { style: { flex: 1, minWidth: '220px' } },
                h('div', { style: { fontWeight: 600, fontSize: '13.5px' } },
                    trf('{admin} от имени {target}', { admin: s.admin_name || '—', target: s.target_name || '—' })),
                h('div', { class: 'muted', style: NOTE },
                    fmtDateTime(s.started_at), ' · ', actAsDuration(s.started_at, s.ended_at), ' · ', ended),
                h('div', { class: 'muted', style: NOTE },
                    trf('Действий: {n} · записей: {w}', { n: Number(s.action_count) || 0, w: Number(s.write_count) || 0 }))),
            toggle),
        box);
}

/**
 * Раздел «Входы от имени» карточки сотрудника: грузит журнал сам. userId —
 * номер сотрудника (users.id). Возвращает элемент сразу; список приходит
 * следом (promise — в .loaded, для проверок).
 */
export function actAsHistoryPane(userId) {
    const root = h('div', { class: 'aah', 'data-act-as-history': '' });
    root.appendChild(h('div', { class: 'muted', style: NOTE }, 'Загрузка…'));
    root.loaded = (async () => {
        try {
            const out = await getJson(LOG + '?user_id=' + encodeURIComponent(userId));
            clear(root);
            const list = Array.isArray(out && out.sessions) ? out.sessions : [];
            if (!list.length) {
                root.appendChild(h('div', { class: 'muted', style: { ...NOTE, padding: '12px 0' } }, 'Входов от имени не было.'));
                return;
            }
            for (const s of list) root.appendChild(sessionRow(userId, s));
        } catch (e) {
            clear(root);
            root.appendChild(h('div', { style: { ...NOTE, color: 'var(--crit-700, #b91c1c)' } }, trf('Не удалось загрузить журнал: {msg}', { msg: tr((e && e.message) || '') })));
        }
    })();
    return root;
}
