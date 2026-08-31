// Lightweight i18n for the admin app.
//
// Usage in views:
//   import { t, onLangChange } from '../i18n.js';
//   const title = t('myservices.title');           // returns the localized string
//   onLangChange(() => repaint());                 // re-render on switch
//
// Switcher (in admin.html topbar) calls setLang('ru' | 'en' | 'uz').
// The choice is persisted to localStorage so the next visit honours it.
// First-time visitors get auto-detected from navigator.language (handy in
// Tashkent where browsers commonly default to ru/uz).
//
// Missing keys fall back to the EN string, then to the `fallback` arg, then to
// the raw key — so partially translated views never blow up; they just show
// English alongside whatever has been translated.

import { STRINGS } from './i18n-strings.js?v=pathway1';

const I18N = {
    en: {
        sidebar: {
            newPatient: 'New patient',
            publicSite: 'Public site',
            sections: { Clinical: 'Clinical', Operations: 'Operations', Insights: 'Insights', Soon: 'Soon' },
            nav: {
                patients:     'Patients',
                appointments: 'Reception',
                consultation: "Doctor's cabinet",
                labs:         'Laboratory',
                beds:         'Ward & beds',
                pharmacy:     'Pharmacy',
                cashier:      'Cashier',
                procurement:  'Procurement',
                marketing:    'Marketing',
                callcenter:   'Call center',
                dashboard:    'Dashboard',
                reports:      'Reports',
                settings:     'Settings',
                requests:     'Requests',
                procedures:   'Procedures',
                'docs-archive': 'Documents',
                'cashier-shifts': 'Cashier',
                pacs:         'Imaging · PACS',
            },
            logout: 'Log out',
            viewAsRole: 'View as role',
            viewAs: 'View as',
            superAdmin: 'Super Admin (full access)',
        },
        branch: { label: 'Branch', all: 'All branches', selectAll: 'Select all', clear: 'Clear', none: 'No branch', nSelected: '{n} branches' },
        topbar: {
            search: 'Search patients, MRN, phone…',
            connected: 'Connected',
            connecting: 'Connecting…',
            notConnected: 'Not connected',
            bootFailed: 'Boot failed',
        },
        crumbs: {
            dashboard:    'Dashboard',
            patients:     'Patients',
            patient:      'Patient',
            clinical:     'Clinical',
            scheduling:   'Scheduling',
            myservices:   'My services',
            workspace:    'Patient workspace',
            registration: 'New patient registration',
            laboratory:   'Laboratory',
            beds:         'Ward & beds',
            operations:   'Operations',
            pharmacy:     'Pharmacy',
            cashier:      'Cashier',
            procurement:  'Procurement',
            marketing:    'Marketing',
            callcenter:   'Call center',
            insights:     'Insights',
            reports:      'Reports',
            settings:     'Settings',
            documents:    'Documents',
        },
        myservices: {
            tabs:     { appointments: 'My appointments', dashboard: 'My dashboard' },
            title:    'My appointments',
            subtitle: 'Services unlocked once the cashier accepts payment or records a debt. Start when the patient is with you, then mark complete.',
            view:     { list: 'List', grid: 'Grid' },
            stat:     { all: 'All', toStart: 'To start', inProgress: 'In progress', completed: 'Completed' },
            search:   'Search patient, MRN, phone, service…',
            showing:  'Showing',
            of:       'of',
            empty:    'No services to show. Items appear here once the cashier accepts payment or marks the invoice as debt.',
            col:      { patient: 'Patient', service: 'Service', staff: 'Doctor / staff', price: 'Price', accepted: 'Accepted', status: 'Status', action: 'Action' },
            action:   { start: 'Start service', complete: 'Complete service' },
            status:   { toStart: 'To start', inProgress: 'In progress', completed: 'Completed', done: 'Done' },
        },
        common: {
            cancel: 'Cancel', save: 'Save', edit: 'Edit', delete: 'Delete',
            confirm: 'Confirm', close: 'Close', add: 'Add', remove: 'Remove',
            view: 'View', open: 'Open',
        },
    },

    ru: {
        sidebar: {
            newPatient: 'Новый пациент',
            publicSite: 'Публичный сайт',
            sections: { Clinical: 'Клиника', Operations: 'Операции', Insights: 'Аналитика', Soon: 'Скоро' },
            nav: {
                patients:     'Пациенты',
                appointments: 'Регистратура',
                consultation: 'Кабинет врача',
                labs:         'Лаборатория',
                beds:         'Стационар и палаты',
                pharmacy:     'Аптека',
                cashier:      'Касса',
                procurement:  'Закупки',
                marketing:    'Маркетинг',
                callcenter:   'Колл-центр',
                dashboard:    'Дашборд',
                reports:      'Отчёты',
                settings:     'Настройки',
                requests:     'Заявки',
                procedures:   'Процедуры',
                'docs-archive': 'Документы',
                'cashier-shifts': 'Касса',
                pacs:         'Снимки · PACS',
            },
            logout: 'Выйти',
            viewAsRole: 'Просмотр как роль',
            viewAs: 'Смотреть как',
            superAdmin: 'Super Admin (полный доступ)',
        },
        branch: { label: 'Филиал', all: 'Все филиалы', selectAll: 'Выбрать все', clear: 'Очистить', none: 'Нет филиала', nSelected: 'Филиалов: {n}' },
        topbar: {
            search: 'Поиск пациентов, MRN, телефон…',
            connected: 'Подключено',
            connecting: 'Подключение…',
            notConnected: 'Не подключено',
            bootFailed: 'Ошибка загрузки',
        },
        crumbs: {
            dashboard:    'Дашборд',
            patients:     'Пациенты',
            patient:      'Пациент',
            clinical:     'Клиника',
            scheduling:   'Расписание',
            myservices:   'Мои услуги',
            workspace:    'Рабочая область пациента',
            registration: 'Новая регистрация пациента',
            laboratory:   'Лаборатория',
            beds:         'Стационар и палаты',
            operations:   'Операции',
            pharmacy:     'Аптека',
            cashier:      'Касса',
            procurement:  'Закупки',
            marketing:    'Маркетинг',
            callcenter:   'Колл-центр',
            insights:     'Аналитика',
            reports:      'Отчёты',
            settings:     'Настройки',
            documents:    'Документы',
        },
        myservices: {
            tabs:     { appointments: 'Мои записи', dashboard: 'Моя панель' },
            title:    'Мои записи',
            subtitle: 'Услуги разблокируются, когда касса принимает оплату или фиксирует долг. Начните, когда пациент с вами, затем отметьте как выполнено.',
            view:     { list: 'Список', grid: 'Сетка' },
            stat:     { all: 'Все', toStart: 'К началу', inProgress: 'В работе', completed: 'Завершено' },
            search:   'Поиск: пациент, MRN, телефон, услуга…',
            showing:  'Показано',
            of:       'из',
            empty:    'Услуг для отображения нет. Записи появляются здесь, когда касса принимает оплату или помечает счёт как долг.',
            col:      { patient: 'Пациент', service: 'Услуга', staff: 'Врач / персонал', price: 'Цена', accepted: 'Принято', status: 'Статус', action: 'Действие' },
            action:   { start: 'Начать услугу', complete: 'Завершить услугу' },
            status:   { toStart: 'К началу', inProgress: 'В работе', completed: 'Завершено', done: 'Выполнено' },
        },
        common: {
            cancel: 'Отмена', save: 'Сохранить', edit: 'Изменить', delete: 'Удалить',
            confirm: 'Подтвердить', close: 'Закрыть', add: 'Добавить', remove: 'Удалить',
            view: 'Просмотр', open: 'Открыть',
        },
    },

    // UZ — falls back to EN for any key not yet translated. Filled in over time.
    uz: {
        sidebar: {
            newPatient: 'Yangi bemor',
            publicSite: 'Ommaviy sayt',
            sections: { Clinical: 'Klinika', Operations: 'Operatsiyalar', Insights: 'Tahlil', Soon: 'Tez orada' },
            nav: {
                patients:     'Bemorlar',
                appointments: 'Registratura',
                consultation: 'Shifokor kabineti',
                labs:         'Laboratoriya',
                beds:         'Statsionar va palatalar',
                pharmacy:     'Dorixona',
                cashier:      'Kassa',
                procurement:  'Xaridlar',
                marketing:    'Marketing',
                callcenter:   'Call-markaz',
                dashboard:    'Boshqaruv paneli',
                reports:      'Hisobotlar',
                settings:     'Sozlamalar',
                requests:     'Arizalar',
                procedures:   'Muolajalar',
                'docs-archive': 'Hujjatlar',
                'cashier-shifts': 'Kassa',
                pacs:         'Tasvirlar · PACS',
            },
            logout: 'Chiqish',
            viewAsRole: 'Rol sifatida koʻrish',
            viewAs: 'Sifatida koʻrish',
            superAdmin: 'Super Admin (toʻliq huquq)',
        },
        branch: { label: 'Filial', all: 'Barcha filiallar', selectAll: 'Hammasini tanlash', clear: 'Tozalash', none: 'Filial yoʻq', nSelected: '{n} ta filial' },
        topbar: {
            search: 'Bemor, MRN, telefon qidirish…',
            connected: 'Ulangan',
            connecting: 'Ulanmoqda…',
            notConnected: 'Ulanmagan',
            bootFailed: 'Yuklash xatosi',
        },
        myservices: {
            tabs:     { appointments: 'Mening yozuvlarim', dashboard: 'Mening panelim' },
            title:    'Mening yozuvlarim',
            subtitle: 'Xizmatlar kassa toʻlovni qabul qilgach yoki qarz sifatida qayd etgach ochiladi. Bemor yoningizda boʻlganda boshlang, soʻng tugatilgan deb belgilang.',
            search:   'Bemor, MRN, telefon, xizmat qidirish…',
            showing:  'Koʻrsatilmoqda',
            of:       'dan',
            empty:    'Koʻrsatiladigan xizmatlar yoʻq. Kassa toʻlovni qabul qilgach yoki hisobni qarz deb belgilagach, yozuvlar shu yerda paydo boʻladi.',
            view:     { list: 'Roʻyxat', grid: 'Tarmoq' },
            stat:     { all: 'Hammasi', toStart: 'Boshlash kerak', inProgress: 'Jarayonda', completed: 'Tugatilgan' },
            col:      { patient: 'Bemor', service: 'Xizmat', staff: 'Shifokor / xodim', price: 'Narx', accepted: 'Qabul qilingan', status: 'Holat', action: 'Amal' },
            action:   { start: 'Xizmatni boshlash', complete: 'Xizmatni tugatish' },
            status:   { toStart: 'Boshlash kerak', inProgress: 'Jarayonda', completed: 'Tugatilgan', done: 'Bajarildi' },
        },
        crumbs: {
            dashboard: 'Boshqaruv paneli', patients: 'Bemorlar', patient: 'Bemor', clinical: 'Klinika',
            scheduling: 'Jadval', myservices: 'Mening xizmatlarim', workspace: 'Bemor ish maydoni',
            registration: 'Yangi bemorni roʻyxatga olish', laboratory: 'Laboratoriya', beds: 'Statsionar va palatalar',
            operations: 'Operatsiyalar', pharmacy: 'Dorixona', cashier: 'Kassa', procurement: 'Xaridlar',
            marketing: 'Marketing', callcenter: 'Call-markaz', insights: 'Tahlil', reports: 'Hisobotlar',
            settings: 'Sozlamalar', documents: 'Hujjatlar',
        },
        common: {
            cancel: 'Bekor qilish', save: 'Saqlash', edit: 'Tahrirlash', delete: 'Oʻchirish',
            confirm: 'Tasdiqlash', close: 'Yopish', add: 'Qoʻshish', remove: 'Olib tashlash',
            view: 'Koʻrish', open: 'Ochish',
        },
    },
};

const STORAGE_KEY = 'admin.lang';
const LISTENERS = new Set();
let currentLang = 'en';

function readStored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function writeStored(code) {
    try { localStorage.setItem(STORAGE_KEY, code); } catch {}
}
function detect() {
    const stored = readStored();
    if (stored && I18N[stored]) return stored;
    const langs = (navigator.languages && navigator.languages.length)
        ? navigator.languages : [navigator.language || 'en'];
    for (const raw of langs) {
        const code = String(raw || '').toLowerCase().slice(0, 2);
        if (I18N[code]) return code;
    }
    return 'en';
}

// Look up a dotted key in the current locale, falling back to EN and finally
// to the caller's default. Never throws.
export function t(key, fallback) {
    const path = String(key || '').split('.');
    const dig = (obj) => path.reduce((o, k) => (o == null ? o : o[k]), obj);
    let v = dig(I18N[currentLang]);
    if (v != null) return v;
    if (currentLang !== 'en') {
        v = dig(I18N.en);
        if (v != null) return v;
    }
    return fallback != null ? fallback : key;
}

export function tr(str) {
    if (str == null || str === '') return str;
    let e = STRINGS[str];
    if (e) return e[currentLang] || e.en || str;
    const key = String(str).trim();
    if (key !== str) {
        e = STRINGS[key];
        if (e) return (str.startsWith(' ') ? ' ' : '') + (e[currentLang] || e.en || key) + (str.endsWith(' ') ? ' ' : '');
    }
    return str;
}

// I18N_COVERAGE_V1 (2026-08-31) — translate FIRST, substitute SECOND.
//
// tr() matches WHOLE strings, so a sentence assembled around a value —
// `'Создан ' + date` — can never resolve, whatever the dictionary holds.
// The cure (proven on the Updates screen, commit 08ab775) is to keep the
// complete Russian sentence WITH ITS {holes} as the dictionary key, translate
// it, and only then put the values back. trf() is that pattern as one call,
// for views; pure logic modules keep returning {template, params} and let the
// view call trf (or tr + updates-logic's fill, which this mirrors — same
// split/join semantics, same "an unknown hole stays visible" rule).
export function trf(template, params) {
    let out = String(tr(template) ?? '');
    if (!params) return out;
    for (const [key, value] of Object.entries(params)) {
        out = out.split('{' + key + '}').join(String(value));
    }
    return out;
}

export function getLang() { return currentLang; }

export function setLang(code) {
    if (!I18N[code]) code = 'en';
    if (currentLang === code) return;
    currentLang = code;
    writeStored(code);
    document.documentElement.lang = code;
    for (const fn of LISTENERS) { try { fn(code); } catch (e) { console.warn('[i18n] listener:', e); } }
    // Also fire a window-level event so non-module code can react.
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: code } }));
}

export function onLangChange(fn) {
    LISTENERS.add(fn);
    return () => LISTENERS.delete(fn);
}

// init — pick a language at module load.
currentLang = detect();
document.documentElement.lang = currentLang;
