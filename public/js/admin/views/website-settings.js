// WEBSITE_V1, этап 2 — экран «Веб-сайт» (Настройки → Коммерческие инструменты).
//
// Перенос редактора Chilla (views/website-settings.js) с отличиями этого проекта
// (docs/superpowers/plans/2026-11-24-website-stage2-editor.md, п.3, 4, 7, 8):
//
//   * Первая карточка «Основного» — «Сайт включён» (settings.enabled, только
//     boolean). В Chilla сайт поднимался всегда; здесь порт 8001 открывается
//     лишь по этому выключателю, и сохранение сразу поднимает или закрывает
//     слушатель (rpc/website.js → requestSiteRefresh). Строка состояния — из
//     ответа сервера (site.running / site.port), а не из того, что стоит в
//     выключателе: «включён, но порт занят» должно быть видно словами.
//   * Врачи и услуги — НЕ свои карточки сайта, как в Chilla, а существующие
//     профили (спека §4): врач виден по «Публичному профилю», услуга — по флагу
//     «Услуги для сайта и партнёров». Здесь у них только добавки сайта: порядок,
//     «На главной», у услуги — фото и описание. Публиковать и удалять их нечем;
//     «Сбросить» стирает добавки (сервер: website_content_delete).
//   * Право — строка «Ролей» `commerce_website` (commerceToolLevel), а не
//     canEdit('website') Chilla. На «Просмотре» экран монтируется в рамке
//     «только просмотр» (view-only.js, admin.js), а сам ещё и не рисует кнопок
//     сохранения: рамка — удобство, сервер отказывает второй раз.
//   * Кнопки «Отчёт сайта» в шапке нет — отчёт строится этапом 4.
//   * Карточки «Уведомления» (куда бот шлёт заявки с сайта) нет — заявок с сайта
//     ещё нет (этап 3): поле, которое ни на что не влияет, хуже его отсутствия.
//
// Доступ к данным — только через supabase.rpc(): таблиц website_* нет в
// реестре /api/db (спека §4), это сама конструкция, а не обход.
//
// Сохранение настроек всегда отправляет ВЕСЬ объект settings (read-modify-write):
// website_settings_save перезаписывает JSON целиком, и вкладка, приславшая только
// свои поля, стёрла бы чужие. Вместе с объектом уходит prev_updated_at — метка,
// которую экран прочитал или получил прошлым сохранением; сервер отвечает 409,
// если между ними сохранил кто-то ещё (Chilla WEBSITE_SETTINGS_LOST_UPDATE_V1).

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, field, checkField, Tag } from '../ui.js';
import { commerceToolLevel } from '../permissions.js';
import { tr, trf } from '../i18n.js';   // toast()/textContent минуют tr() внутри h() — переводим сами
import { uploadFile } from '../storage.js';

// Языки сайта — тот же порядок и набор, что проверяет websiteSettingsSave.
const LANGS = [
    ['uz', 'Узбекский'],
    ['ru', 'Русский'],
    ['en', 'Английский'],
];

const DEFAULT_SITE_PORT = 8001;

const TABS = [
    ['general',      'Основное'],
    ['home',         'Главная страница'],
    ['doctors',      'Врачи'],
    ['services',     'Услуги'],
    ['departments',  'Отделения'],
    ['testimonials', 'Отзывы'],
    ['faq',          'Вопросы и ответы'],
    ['posts',        'Новости'],
    ['seo',          'SEO'],
];

// Корзина хранилища сайта (server/routes/storage.js): только эти расширения —
// SVG сайт не отдаёт. Проверяем заранее, чтобы ответить по-русски до загрузки,
// а не голым 415 сервера.
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

const state = {
    settings:   {},
    site:       { running: false, port: 0 },
    updated_at: null,
    tab:        'general',
    saving:     false,
};

const refs = { root: null, body: null };

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || tr('Не удалось выполнить запрос.'));
    return data;
}

// «Изменение» — правит; «Просмотр» — видит всё серым и без кнопок сохранения.
const readOnly = () => commerceToolLevel('commerce_website') !== 'edit';

// Ветка settings, создаваемая по требованию: открыли вкладку — объект должен
// существовать, даже если в базе его ещё нет.
function branch(key) {
    const s = state.settings;
    if (!s[key] || typeof s[key] !== 'object' || Array.isArray(s[key])) s[key] = {};
    return s[key];
}
// То же для массивов верхнего уровня (stats): редактор списков не работает поверх {}.
function branchArray(key) {
    const s = state.settings;
    if (!Array.isArray(s[key])) s[key] = [];
    return s[key];
}
function subBranch(parent, key) {
    if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) parent[key] = {};
    return parent[key];
}
const str = (v) => (v == null ? '' : String(v));
const errText = (e) => String((e && e.message) || e || '');
const publicUrl = (path) => supabase.storage.from('website').getPublicUrl(path).data.publicUrl;

function readSite(site) {
    const s = site && typeof site === 'object' ? site : {};
    return { running: s.running === true, port: Number(s.port) || 0 };
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------
export async function renderWebsiteSettings(container) {
    clear(container);
    state.settings = {};
    state.saving = false;

    refs.root = h('div', { class: 'fade-in ws-ed', 'data-website-settings': '' });
    container.appendChild(refs.root);

    refs.root.appendChild(PageHead({
        title: 'Веб-сайт',
        subtitle: 'Публичный сайт клиники: включение, тексты, врачи и услуги, поисковая выдача. Сохранённые изменения посетитель видит сразу.',
    }));

    refs.body = h('div');
    refs.root.appendChild(refs.body);
    refs.body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));

    let data;
    try {
        data = await rpc('website_settings_get');
    } catch (e) {
        clear(refs.body);
        refs.body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
            h('div', null, 'Не удалось загрузить настройки сайта.'),
            h('div', { class: 'muted', style: { marginTop: '6px' } }, errText(e))));
        return;
    }

    const loaded = data && data.settings;
    state.settings   = (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) ? loaded : {};
    state.site       = readSite(data && data.site);
    state.updated_at = (data && data.updated_at) || null;

    paint();
}

function paint() {
    clear(refs.body);
    refs.body.appendChild(tabRail());
    const tabBody = h('div', { style: { paddingTop: '16px' } });
    refs.body.appendChild(tabBody);
    const fn = TAB_RENDERERS[state.tab] || TAB_RENDERERS.general;
    fn(tabBody);
}

function tabRail() {
    return h('div', { class: 'tabs', style: { marginTop: '-4px', flexWrap: 'wrap' } },
        ...TABS.map(([id, label]) => h('button', {
            class: 'tab' + (state.tab === id ? ' on' : ''),
            type: 'button',
            'data-ws-tab': id,
            onclick: () => { if (state.tab !== id) { state.tab = id; paint(); } },
        }, label)));
}

// Реестр вкладок: новая вкладка — функция здесь, рейка о ней не знает.
const TAB_RENDERERS = {
    general:      renderGeneralTab,
    home:         renderHomeTab,
    doctors:      (bodyEl) => renderProfileTab('doctors', bodyEl),
    services:     (bodyEl) => renderProfileTab('services', bodyEl),
    departments:  (bodyEl) => renderContentTab('departments', bodyEl),
    testimonials: (bodyEl) => renderContentTab('testimonials', bodyEl),
    faq:          (bodyEl) => renderContentTab('faq', bodyEl),
    posts:        (bodyEl) => renderContentTab('posts', bodyEl),
    seo:          renderSeoTab,
};

// ---------------------------------------------------------------------------
// Общие мелочи оформления
// ---------------------------------------------------------------------------
function card(title, iconName, ...children) {
    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon(iconName, { size: 16 }), ' ', title)),
        h('div', { style: { padding: '4px 16px 16px', display: 'flex', flexDirection: 'column' } }, ...children));
}

function hint(text) {
    return h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '-6px', marginBottom: '12px' } }, text);
}

// Подпись группы карточек «одна на язык» — без неё три группы карточек
// «Узбекский/Русский/Английский» подряд неотличимы.
function subheading(text) {
    return h('div', { style: { fontWeight: '700', fontSize: '13.5px', margin: '18px 2px 6px' } }, text);
}

// Поле, привязанное к ветке settings или черновику: пишет прямо в объект.
function textInput(obj, key, opts = {}) {
    return h('input', {
        type: 'text',
        value: str(obj[key]),
        placeholder: opts.placeholder || null,
        disabled: readOnly() ? true : null,
        oninput: (e) => { obj[key] = e.target.value; },
    });
}

function textArea(obj, key, rows = 4) {
    const el = h('textarea', {
        rows: String(rows),
        disabled: readOnly() ? true : null,
        oninput: (e) => { obj[key] = e.target.value; },
    });
    el.value = str(obj[key]);   // через .value, а не текстовым узлом: содержимое пользователя не переводится
    return el;
}

function moveButton(dir, disabled, onclick) {
    return h('button', {
        class: 'btn btn-outline btn-sm', type: 'button',
        title: dir < 0 ? 'Выше' : 'Ниже', 'aria-label': dir < 0 ? 'Выше' : 'Ниже',
        disabled: disabled ? true : null, onclick,
    }, Icon(dir < 0 ? 'ArrowUp' : 'ArrowDown', { size: 13 }));
}

// Окно-подтверждение (те же классы .modal/.modal-card, что у прочих окон), не
// window.confirm: называет, что именно изменится.
function openConfirm({ title, name, text, okLabel, danger = true, onOk }) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '150' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const okBtn = h('button', { class: danger ? 'btn btn-danger' : 'btn btn-primary', type: 'button', 'data-ws-confirm': '' }, okLabel);
    okBtn.addEventListener('click', async () => {
        okBtn.disabled = true;
        try { await onOk(); close(); } catch { okBtn.disabled = false; }
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '420px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, title),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            name ? h('div', { style: { fontWeight: '600' } }, name) : null,
            h('div', { class: 'muted', style: { marginTop: '6px' } }, text)),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn btn-outline', type: 'button', onclick: close }, 'Отмена'),
            okBtn),
    ));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    return overlay;
}

// ---------------------------------------------------------------------------
// Сохранение настроек
// ---------------------------------------------------------------------------
// Одна функция и для кнопки «Сохранить», и для выключателя «Сайт включён»:
// оба шлют весь объект и одну и ту же метку версии, и не могут разойтись.
// Возвращает true при успехе; при отказе — тост с фразой сервера (409 сам
// говорит «обновите страницу») и false, ничего не перерисовывая.
async function saveSettings() {
    if (state.saving) return false;
    state.saving = true;
    try {
        const out = await rpc('website_settings_save', { settings: state.settings, prev_updated_at: state.updated_at });
        state.updated_at = (out && out.updated_at) || state.updated_at;
        if (out && out.site) state.site = readSite(out.site);
        toast(tr('Сохранено'));
        return true;
    } catch (e) {
        toast(trf('Не удалось сохранить. {reason}', { reason: errText(e) }), 'fail');
        return false;
    } finally {
        state.saving = false;
    }
}

// Кнопка сохранения вкладки. На «Просмотре» её нет вовсе — вместо неё строка,
// почему поля серые.
function saveRow(validate) {
    if (readOnly()) {
        return h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '4px 2px 0' } },
            'Доступ только для чтения: менять настройки сайта нельзя.');
    }
    const btn = h('button', { class: 'btn btn-primary', type: 'button', 'data-ws-save': '' }, Icon('Check', { size: 14 }), ' ', 'Сохранить');
    btn.addEventListener('click', async () => {
        if (state.saving) return;
        if (validate) {
            const err = validate();
            if (err) { toast(tr(err), 'fail'); return; }
        }
        btn.disabled = true;
        if (await saveSettings()) { paint(); return; }
        btn.disabled = false;
    });
    const row = h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', padding: '4px 2px 0' } }, btn);
    if (state.updated_at) {
        row.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } },
            trf('Последнее изменение: {at}', { at: String(state.updated_at).replace('T', ' ').replace(/\.\d+Z$|Z$/, '') })));
    }
    return row;
}

// ---------------------------------------------------------------------------
// Вкладка «Основное»
// ---------------------------------------------------------------------------
function siteUrl() {
    const lang = str(state.settings.default_lang) || 'uz';
    return `http://${location.hostname}:${state.site.port || DEFAULT_SITE_PORT}/${lang}/`;
}

// «Сайт включён» — первая карточка. Выключатель сохраняет сразу (как «ИИ
// отвечает в чатах»): включить сайт и потом искать, какую кнопку нажать, чтобы
// порт открылся, — лишний шаг. Уходит весь объект настроек, а значит и
// несохранённые правки этой вкладки — подсказка под выключателем это говорит.
function siteCard() {
    const s = state.settings;
    const on = s.enabled === true;
    const box = h('input', {
        type: 'checkbox', checked: on, role: 'switch', 'data-ws-enabled': '',
        'aria-label': 'Сайт включён',
        disabled: readOnly() ? true : null,
    });
    box.addEventListener('change', async () => {
        const prev = s.enabled;
        // Только настоящее true/false: сервер строку «false» не примет (она
        // открыла бы порт), поэтому и экран другого не шлёт.
        s.enabled = box.checked === true;
        box.disabled = true;
        if (await saveSettings()) { paint(); return; }
        if (prev === undefined) delete s.enabled; else s.enabled = prev;
        box.checked = prev === true;
        box.disabled = false;
    });

    let status;
    if (state.site.running) {
        status = h('span', { class: 'tag tag-ok', 'data-ws-status': 'running' },
            trf('Сайт работает: порт {port}', { port: String(state.site.port || DEFAULT_SITE_PORT) }));
    } else if (on) {
        // Выключатель стоит, а слушателя нет: порт занят другой программой,
        // модуля нет в лицензии или сайт выключен на сервере (SITE_PORT=0).
        status = h('span', { class: 'tag tag-warn', 'data-ws-status': 'down' }, 'Сайт включён, но не запущен');
    } else {
        status = h('span', { class: 'tag', 'data-ws-status': 'off' }, 'Сайт выключен');
    }

    return card('Публичный сайт', 'Globe',
        h('label', { class: 'row', style: { gap: '12px', alignItems: 'center', padding: '10px 0 6px', cursor: readOnly() ? 'default' : 'pointer' } },
            box,
            h('span', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h('strong', null, 'Сайт включён'),
                h('span', null, status))),
        on && !state.site.running
            ? hint('Порт занят другой программой или сайт отключён на сервере. Перезапустите программу; если не поможет — обратитесь к менеджеру Easy-Med.')
            : null,
        state.site.running
            ? h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '4px 0 8px' } },
                h('a', { class: 'btn btn-outline btn-sm', href: siteUrl(), target: '_blank', rel: 'noopener noreferrer', 'data-ws-open': '' },
                    Icon('Globe', { size: 13 }), ' ', 'Открыть сайт'))
            : null,
        hint('Сайт открывается с компьютеров локальной сети по адресу этого компьютера, порт 8001. При первом запуске Windows может один раз спросить, разрешить ли программе доступ к сети, — ответьте «Разрешить» для частных сетей.'),
        readOnly() ? null : hint('Выключатель сохраняет настройки сразу — вместе с несохранёнными правками этой вкладки.'),
    );
}

function renderGeneralTab(bodyEl) {
    const s = state.settings;
    const contact = branch('contact');
    const social  = branch('social');

    bodyEl.appendChild(siteCard());

    const defLang = str(s.default_lang) || 'uz';
    const langSel = h('select', {
        disabled: readOnly() ? true : null,
        onchange: (e) => { s.default_lang = e.target.value; },
    }, ...LANGS.map(([code, label]) => h('option', { value: code, selected: defLang === code }, label)));

    const enabled = Array.isArray(s.langs) && s.langs.length ? s.langs.slice() : LANGS.map(([c]) => c);
    s.langs = enabled;
    const langChecks = LANGS.map(([code, label]) => {
        const box = h('input', {
            type: 'checkbox',
            checked: enabled.includes(code),
            disabled: readOnly() ? true : null,
            onchange: (e) => {
                const set = new Set(s.langs || []);
                if (e.target.checked) set.add(code); else set.delete(code);
                s.langs = LANGS.map(([c]) => c).filter((c) => set.has(c));
            },
        });
        return checkField(label, box);
    });

    bodyEl.appendChild(card('Языки', 'Doc',
        field('Язык по умолчанию', langSel),
        hint('С этого языка начинает посетитель, который пришёл без указания языка.'),
        h('div', { style: { fontWeight: '600', fontSize: '12.5px', marginBottom: '6px' } }, 'Доступные языки'),
        ...langChecks,
    ));

    bodyEl.appendChild(card('Контакты', 'Phone',
        field('Телефон', textInput(contact, 'phone', { placeholder: '+998 71 200 00 00' })),
        field('Email', textInput(contact, 'email', { placeholder: 'info@clinic.uz' })),
        field('Адрес', textInput(contact, 'address')),
        field('Ссылка на карту', textInput(contact, 'map_url', { placeholder: 'https://maps.google.com/…' })),
        field('Карта на странице (HTML-код виджета)', textArea(contact, 'map_embed', 4)),
        // Chilla CONTACT_HOME_V1 — кнопка «Вызвать такси» под картой; пусто — кнопки нет.
        field('Ссылка «Вызвать такси» (Яндекс Go и т. п.)', textInput(contact, 'taxi_url', { placeholder: 'https://3.redirect.appmetrica.yandex.com/route?…' })),
        hint('Код вставляется на сайт как есть. Политика безопасности сайта автоматически разрешает карты с google.com, maps.google.com и yandex.ru; виджет с другого источника может быть отклонён — тогда оставьте только ссылку на карту.'),
    ));

    bodyEl.appendChild(card('Социальные сети', 'Msg',
        field('Instagram', textInput(social, 'instagram', { placeholder: 'https://instagram.com/…' })),
        field('Telegram',  textInput(social, 'telegram',  { placeholder: 'https://t.me/…' })),
        field('Facebook',  textInput(social, 'facebook',  { placeholder: 'https://facebook.com/…' })),
        field('YouTube',   textInput(social, 'youtube',   { placeholder: 'https://youtube.com/…' })),
        hint('Только полные адреса, начинающиеся с https://. Пустое поле — значок в подвале сайта не показывается.'),
    ));

    bodyEl.appendChild(saveRow(validateGeneral));
}

function validateGeneral() {
    const s = state.settings;
    const langs = Array.isArray(s.langs) ? s.langs : [];
    if (!langs.length) return 'Оставьте включённым хотя бы один язык сайта.';
    if (s.default_lang && !langs.includes(s.default_lang)) {
        return 'Язык по умолчанию должен быть среди доступных языков.';
    }
    const social = branch('social');
    for (const key of ['instagram', 'telegram', 'facebook', 'youtube']) {
        const v = str(social[key]).trim();
        if (v && !/^https:\/\//i.test(v)) return 'Ссылки на соцсети должны начинаться с https://';
    }
    return null;
}

// ---------------------------------------------------------------------------
// Вкладка «SEO» — форма повторяет то, что читает сайт (server/site/seo.js):
// seo.base_url — строка, seo.title / seo.description — {uz,ru,en}.
// ---------------------------------------------------------------------------
function renderSeoTab(bodyEl) {
    const seo = branch('seo');
    if (!seo.title || typeof seo.title !== 'object' || Array.isArray(seo.title)) {
        seo.title = typeof seo.title === 'string' ? { uz: seo.title, ru: seo.title, en: seo.title } : {};
    }
    if (!seo.description || typeof seo.description !== 'object' || Array.isArray(seo.description)) {
        seo.description = typeof seo.description === 'string'
            ? { uz: seo.description, ru: seo.description, en: seo.description } : {};
    }

    bodyEl.appendChild(card('Поисковая оптимизация', 'Chart',
        field('Базовый адрес сайта', textInput(seo, 'base_url', { placeholder: 'https://clinic.uz' })),
        hint('Пока адрес не задан, sitemap.xml и канонические ссылки не формируются: без домена абсолютный адрес страницы построить не из чего.'),
    ));

    for (const [code, label] of LANGS) {
        bodyEl.appendChild(card(label, 'Doc',
            field('Заголовок в поиске (title)', textInput(seo.title, code)),
            field('Описание в поиске (description)', textArea(seo.description, code, 3)),
        ));
    }

    // Код аналитики вставляется на сайт как есть (тот же уровень доверия, что
    // «Карта на странице» в «Основном») — отсюда та же предупреждающая строка.
    const analytics = branch('analytics');
    bodyEl.appendChild(card('Аналитика', 'Chart',
        field('Код аналитики (HTML)', textArea(analytics, 'inject_snippet', 6)),
        hint('Вставляется на сайт как есть — только из доверенного источника. Политика безопасности сайта автоматически разрешает Google Tag Manager и Яндекс.Метрику; скрипты с других доменов будут заблокированы.'),
    ));

    bodyEl.appendChild(saveRow(validateSeo));
}

function validateSeo() {
    const base = str(branch('seo').base_url).trim();
    if (base && !/^https?:\/\//i.test(base)) return 'Базовый адрес должен начинаться с http:// или https://';
    return null;
}

// ---------------------------------------------------------------------------
// Вкладка «Главная страница» — hero / stats / about / legal, те же ветки
// settings, что читает сайт (server/site/render/home.js, static-pages.js).
// legal.privacy / legal.terms — «поле → язык» простой строкой, а не {title,body}.
// ---------------------------------------------------------------------------
function renderHomeTab(bodyEl) {
    bodyEl.appendChild(subheading('Заголовок сайта (hero)'));
    const hero = branch('hero');
    for (const [code, label] of LANGS) {
        const heroLang = subBranch(hero, code);
        bodyEl.appendChild(card(label, 'Sparkles',
            field('Заголовок', textInput(heroLang, 'title')),
            field('Подзаголовок', textArea(heroLang, 'subtitle', 2)),
            field('Текст кнопки записи', textInput(heroLang, 'cta', { placeholder: 'Записаться' })),
        ));
    }

    bodyEl.appendChild(heroKickerCard(hero));
    bodyEl.appendChild(heroPriceCard(hero));
    bodyEl.appendChild(heroCtaCard(hero, 'cta2', 'Вторая кнопка (с обводкой)'));
    bodyEl.appendChild(heroCtaCard(hero, 'cta3', 'Третья кнопка (мягкая)'));
    bodyEl.appendChild(heroPhotosCard(hero));

    bodyEl.appendChild(statsCard());
    // Chilla WHY_US_REMOVED_V1 — «Почему нас выбирают» сайт больше не рисует,
    // редактора нет; settings.why_us, если есть, остаётся в объекте нетронутым.

    bodyEl.appendChild(subheading('О клинике'));
    const about = branch('about');
    for (const [code, label] of LANGS) {
        const aboutLang = subBranch(about, code);
        bodyEl.appendChild(card(label, 'Doc',
            field('Заголовок', textInput(aboutLang, 'title')),
            field('Текст', textArea(aboutLang, 'body', 4)),
        ));
    }

    bodyEl.appendChild(subheading('Правовые документы'));
    const legal = branch('legal');
    const privacy = subBranch(legal, 'privacy');
    const terms = subBranch(legal, 'terms');
    for (const [code, label] of LANGS) {
        bodyEl.appendChild(card(label, 'Doc',
            field('Политика конфиденциальности', textArea(privacy, code, 6)),
            field('Условия использования', textArea(terms, code, 6)),
        ));
    }
    bodyEl.appendChild(hint('Пока текст не заполнен, посетитель видит заглушку страницы, помеченную noindex.'));

    bodyEl.appendChild(saveRow());
}

// Надзаголовок: hero.kicker = {uz,ru,en}.
function heroKickerCard(hero) {
    const kicker = subBranch(hero, 'kicker');
    return card('Строка над заголовком', 'Sparkles',
        h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
            ...LANGS.map(([code, label]) => h('div', { style: { flex: '1', minWidth: '150px' } },
                field(label, textInput(kicker, code))))),
        hint('Короткая строка над заголовком — например, направление клиники. Пустое поле: на сайте строки нет вовсе.'),
    );
}

// Цена: hero.price = {from, amount}; «от» и валюту сайт подставляет сам.
function heroPriceCard(hero) {
    const price = subBranch(hero, 'price');
    const amount = h('input', {
        type: 'number', min: '0', step: '1',
        value: (price.amount == null || price.amount === '') ? '' : String(price.amount),
        disabled: readOnly() ? true : null,
        oninput: (e) => {
            const v = e.target.value.trim();
            // Пустое — пустым, а не нулём: «0» в настройках выглядел бы как цена.
            price.amount = v === '' ? '' : Number(v);
        },
    });
    const fromCb = h('input', {
        type: 'checkbox', checked: !!price.from, disabled: readOnly() ? true : null,
        onchange: (e) => { price.from = e.target.checked; },
    });
    return card('Цена в заголовке', 'Chart',
        field('Сумма', amount),
        checkField('Показывать слово «от»', fromCb),
        hint('Разряды и название валюты сайт расставит сам, на языке страницы. Пустая сумма: строки с ценой на сайте нет вовсе.'),
    );
}

// Дополнительные кнопки: hero.cta2 / hero.cta3 = {label:{uz,ru,en}, href}.
function heroCtaCard(hero, key, title) {
    const cta = subBranch(hero, key);
    const label = subBranch(cta, 'label');
    return card(title, 'Target',
        h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
            ...LANGS.map(([code, lbl]) => h('div', { style: { flex: '1', minWidth: '150px' } },
                field(lbl, textInput(label, code))))),
        field('Ссылка', textInput(cta, 'href', { placeholder: '/ru/services' })),
        hint('Кнопка появляется на сайте, только когда заполнены и подпись, и ссылка. Годятся адрес внутри сайта («/ru/services»), полный адрес с https://, tel: и mailto:.'),
    );
}

// Загрузка картинки в корзину сайта: расширение проверяется до отправки.
async function uploadWebsiteImage(file, prefix) {
    if (!IMAGE_EXT.test(String(file && file.name || ''))) {
        throw new Error(tr('На сайт загружаются только картинки JPG, PNG и WEBP.'));
    }
    const { path } = await uploadFile('website', file, prefix);
    return path;
}

function heroPhotoField(hero, key, label) {
    const preview = h('img', {
        alt: '',
        style: { maxWidth: '150px', maxHeight: '180px', borderRadius: '8px', objectFit: 'cover', marginTop: '8px' },
    });
    const clearBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Убрать');
    const sync = () => {
        const path = str(hero[key]);
        preview.style.display = path ? '' : 'none';
        clearBtn.style.display = (path && !readOnly()) ? '' : 'none';
        if (path) preview.src = publicUrl(path);
    };
    clearBtn.addEventListener('click', () => { hero[key] = ''; sync(); });

    const fileInp = h('input', {
        type: 'file', accept: IMAGE_ACCEPT, disabled: readOnly() ? true : null,
        onchange: async (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            try {
                hero[key] = await uploadWebsiteImage(f, 'hero/');
                sync();
                toast(tr('Изображение загружено'));
            } catch (err) {
                toast(trf('Не удалось загрузить изображение. {reason}', { reason: errText(err) }), 'fail');
            }
        },
    });
    sync();
    return h('div', { style: { flex: '1', minWidth: '200px' } }, field(label, fileInp), preview, clearBtn);
}

// Chilla HERO_SLIDESHOW_V1 — список фото заголовка; пусто — работает пара img1/img2.
function heroPhotosCard(hero) {
    if (!Array.isArray(hero.photos)) hero.photos = [];
    const list = hero.photos;
    const listBody = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } });

    function paintList() {
        clear(listBody);
        if (!list.length) {
            listBody.appendChild(h('div', { class: 'empty', style: { padding: '12px' } },
                'Фотографий нет — заголовок покажет то, что загружено ниже.'));
        }
        list.forEach((path, idx) => {
            const img = h('img', {
                src: publicUrl(path), alt: '',
                style: { width: '120px', height: '150px', objectFit: 'cover', borderRadius: '8px', display: 'block' },
            });
            const left = moveButton(-1, idx === 0, () => { [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]]; paintList(); });
            const right = moveButton(1, idx === list.length - 1, () => { [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]]; paintList(); });
            const del = h('button', { class: 'btn btn-outline btn-sm', type: 'button', title: 'Убрать', 'aria-label': 'Убрать' },
                Icon('Trash', { size: 13 }));
            del.addEventListener('click', () => { list.splice(idx, 1); paintList(); });
            listBody.appendChild(h('div', { class: 'card', style: { padding: '8px' } }, img,
                readOnly() ? null : h('div', { class: 'row', style: { gap: '4px', marginTop: '6px' } }, left, right, del)));
        });
    }
    paintList();

    const addInp = h('input', {
        type: 'file', accept: IMAGE_ACCEPT, multiple: true, disabled: readOnly() ? true : null,
        onchange: async (e) => {
            const files = [].slice.call(e.target.files || []);
            let ok = 0;
            for (const f of files) {
                try {
                    list.push(await uploadWebsiteImage(f, 'hero/'));
                    ok++;
                } catch (err) {
                    toast(trf('Не удалось загрузить изображение. {reason}', { reason: errText(err) }), 'fail');
                }
            }
            e.target.value = '';
            paintList();
            if (ok) toast(tr('Изображение загружено'));
        },
    });

    return card('Фотографии в заголовке', 'Image',
        listBody,
        readOnly() ? null : field('Добавить фотографии', addInp),
        hint('Две и больше — заголовок меняет их каждые 5 секунд; одна — стоит неподвижно. Порядок задаётся стрелками, первая показывается первой. Пока список пуст, работают два поля ниже (коллаж). Не забудьте сохранить кнопкой внизу вкладки.'),
        h('div', { class: 'row', style: { gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start', marginTop: '10px' } },
            heroPhotoField(hero, 'img1', 'Переднее фото (если список пуст)'),
            heroPhotoField(hero, 'img2', 'Второе фото (коллаж)')),
    );
}

// Цифры на главной: [{value, label:{uz,ru,en}}]; уходят той же кнопкой «Сохранить».
function statsCard() {
    const stats = branchArray('stats');
    const listBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });

    function paintList() {
        clear(listBody);
        if (!stats.length) {
            listBody.appendChild(h('div', { class: 'empty', style: { padding: '14px' } }, 'Пока ничего не добавлено.'));
        }
        stats.forEach((st, idx) => {
            subBranch(st, 'label');
            const up = moveButton(-1, idx === 0, () => { [stats[idx - 1], stats[idx]] = [stats[idx], stats[idx - 1]]; paintList(); });
            const down = moveButton(1, idx === stats.length - 1, () => { [stats[idx + 1], stats[idx]] = [stats[idx], stats[idx + 1]]; paintList(); });
            const del = h('button', { class: 'btn btn-outline btn-sm', type: 'button', title: 'Убрать', 'aria-label': 'Убрать' }, Icon('Trash', { size: 13 }));
            del.addEventListener('click', () => { stats.splice(idx, 1); paintList(); });

            listBody.appendChild(h('div', { class: 'card', style: { padding: '10px', display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' } },
                h('div', { style: { flex: '0 0 100px' } }, field('Значение', textInput(st, 'value', { placeholder: '15+' }))),
                ...LANGS.map(([code, label]) => h('div', { style: { flex: '1', minWidth: '120px' } }, field(label, textInput(st.label, code)))),
                readOnly() ? null : h('div', { class: 'row', style: { gap: '4px' } }, up, down, del),
            ));
        });
    }
    paintList();

    const addBtn = readOnly() ? null : h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, Icon('Plus', { size: 13 }), ' ', 'Добавить');
    if (addBtn) addBtn.addEventListener('click', () => { stats.push({ value: '', label: { uz: '', ru: '', en: '' } }); paintList(); });

    return card('Статистика (цифры на главной)', 'Chart',
        h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '10px' } }, addBtn),
        listBody);
}

// ---------------------------------------------------------------------------
// Вкладки «Врачи» и «Услуги» — существующие профили (спека §4).
//
// Список и метка показа — с сервера (website_content_list): state 'shown' |
// 'off' | 'branch_hidden' у врачей, 'shown' | 'off' | 'no_uz' у услуг, тем же
// правилом, что у самого сайта. Скрытые здесь видимыми не делаются — подсказка
// говорит, где включить показ. У показанных — «На главной» и порядок; у
// услуги ещё фото и описание по языкам.
//
// Услуг сотни: без поиска вкладка показывает только те, что на сайте, а поиск
// ищет по всем; рисуется не больше PAGE строк за раз («Показать ещё»).
// ---------------------------------------------------------------------------
const PAGE = 100;

const PROFILE_KINDS = {
    doctors: {
        title: 'Врачи',
        fk: 'user_id',
        label: (r) => r.full_name || '',
        sub: (r) => r.specialty || '',
        search: (r) => [r.full_name, r.specialty],
        intro: 'Врачи попадают на сайт из «Публичного профиля» в карточке сотрудника. Здесь — порядок на сайте и показ на главной странице.',
        reasons: {
            off: 'Скрыт: включите «Публичный профиль» в карточке сотрудника',
            branch_hidden: 'Скрыт: филиал скрыт с сайта',
        },
        resetText: 'Порядок и отметка «На главной» вернутся к исходным. Сам врач и его профиль не меняются.',
        allByDefault: true,
    },
    services: {
        title: 'Услуги',
        fk: 'service_id',
        label: (r) => r.name || '',
        sub: (r) => (r.price != null && r.price !== '' ? trf('{sum} сум', { sum: Number(r.price).toLocaleString('ru-RU') }) : ''),
        search: (r) => [r.name, r.name_uz, r.name_en],
        intro: 'Услуги попадают на сайт из «Настройки → Услуги для сайта и партнёров». Здесь — порядок, показ на главной, фото и описание.',
        reasons: {
            off: 'Скрыт: включите показ в «Услуги для сайта и партнёров»',
            no_uz: 'Скрыт: нет названия на узбекском',
        },
        resetText: 'Порядок, отметка «На главной», фото и описание для сайта будут стёрты. Сама услуга и её цена не меняются.',
        allByDefault: false,
    },
};

async function renderProfileTab(kind, bodyEl) {
    const cfg = PROFILE_KINDS[kind];
    bodyEl.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    let rows;
    try {
        const out = await rpc('website_content_list', { kind });
        rows = (out && Array.isArray(out.rows)) ? out.rows : [];
    } catch (e) {
        if (state.tab !== kind) return;
        clear(bodyEl);
        bodyEl.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
            h('div', null, 'Не удалось загрузить данные.'),
            h('div', { class: 'muted', style: { marginTop: '6px' } }, errText(e))));
        return;
    }
    if (state.tab !== kind) return;   // вкладку успели переключить, пока ждали ответ
    clear(bodyEl);
    paintProfileTab(kind, cfg, bodyEl, rows);
}

function paintProfileTab(kind, cfg, bodyEl, rows) {
    const reload = () => { clear(bodyEl); renderProfileTab(kind, bodyEl); };
    // Сервер уже отдаёт показанных первыми и в порядке сайта.
    const shown = rows.filter((r) => r.shown);
    let query = '';
    let limit = PAGE;

    const listBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    const counterEl = h('span', { class: 'muted', style: { fontSize: '12.5px' }, 'data-ws-counter': '' });

    const filtered = () => {
        const q = query.trim().toLowerCase();
        if (!q) return cfg.allByDefault ? rows : shown;
        return rows.filter((r) => cfg.search(r).some((v) => String(v || '').toLowerCase().includes(q)));
    };

    function paintRows() {
        clear(listBody);
        const list = filtered();
        counterEl.textContent = trf('На сайте: {on} из {all}', { on: String(shown.length), all: String(rows.length) });
        if (!rows.length) {
            listBody.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, 'Пока ничего нет.'));
            return;
        }
        if (!list.length) {
            listBody.appendChild(h('div', { class: 'empty', style: { padding: '20px' } },
                query.trim() ? 'Ничего не найдено.' : 'На сайте пока ни одной услуги — найдите нужные поиском, чтобы узнать, что мешает их показу.'));
            return;
        }
        // Стрелки порядка — только без поиска: в отфильтрованном списке соседа
        // по сайту может не быть на экране, и «выше» переставило бы невидимое.
        const canMove = !readOnly() && !query.trim();
        for (const r of list.slice(0, limit)) listBody.appendChild(profileRow(kind, cfg, r, shown, canMove, reload, paintRows));
        if (list.length > limit) {
            listBody.appendChild(h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', justifyContent: 'center', padding: '6px 0' } },
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, trf('Показано {n} из {all}', { n: String(limit), all: String(list.length) })),
                h('button', { class: 'btn btn-outline btn-sm', type: 'button', dataset: { viewOk: '1' }, 'data-ws-more': '',
                    onclick: () => { limit += PAGE; paintRows(); } }, 'Показать ещё')));
        }
    }

    const searchInput = h('input', {
        type: 'text', placeholder: 'Поиск…', value: '', 'aria-label': 'Поиск',
        style: { maxWidth: '260px' },
        oninput: (e) => { query = e.target.value; limit = PAGE; paintRows(); },
    });

    paintRows();
    bodyEl.appendChild(card(cfg.title, 'Doc',
        h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '2px' } },
            searchInput, counterEl),
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px', marginBottom: '12px' } },
            cfg.intro, cfg.allByDefault ? null : h('span', null, ' ', 'Без поиска показаны только услуги на сайте; поиск — по всем.')),
        listBody,
    ));
}

function profileRow(kind, cfg, r, shown, canMove, reload, repaint) {
    const name = cfg.label(r) || '—';
    const sub = cfg.sub(r);
    const isShown = !!r.shown;
    const reason = !isShown ? (cfg.reasons[r.state] || 'Скрыт с сайта') : '';

    const chips = [];
    if (isShown) chips.push(Tag('На сайте', { kind: 'ok' }));
    if (isShown && r.featured) chips.push(Tag('На главной', { kind: 'info' }));
    if (kind === 'services' && isShown && !r.image_path) chips.push(Tag('нет фото', { kind: 'warn' }));

    const actions = [];
    if (isShown && !readOnly()) {
        const fb = h('input', { type: 'checkbox', checked: !!r.featured, 'data-ws-featured': String(r.id) });
        fb.addEventListener('change', async () => {
            const val = fb.checked;
            fb.disabled = true;
            try {
                await rpc('website_content_save', { kind, row: { [cfg.fk]: r[cfg.fk], featured: val ? 1 : 0 } });
                r.featured = val ? 1 : 0;
                r.has_extras = true;
                toast(tr('Сохранено'));
                repaint();
                return;
            } catch (e) {
                fb.checked = !val;
                toast(trf('Не удалось сохранить. {reason}', { reason: errText(e) }), 'fail');
            }
            fb.disabled = false;
        });
        actions.push(h('label', { class: 'row', style: { gap: '6px', alignItems: 'center', fontSize: '12.5px', cursor: 'pointer' } }, fb, h('span', null, 'На главной')));
    }
    if (isShown && canMove) {
        const idx = shown.indexOf(r);
        const move = (dir) => async () => {
            const j = idx + dir;
            [shown[idx], shown[j]] = [shown[j], shown[idx]];
            try {
                await rpc('website_content_reorder', { kind, ids: shown.map((x) => x[cfg.fk]) });
                reload();
                return;
            } catch (e) {
                [shown[idx], shown[j]] = [shown[j], shown[idx]];   // сервер не принял — откатываем локальный порядок
                toast(trf('Не удалось изменить порядок. {reason}', { reason: errText(e) }), 'fail');
            }
            repaint();
        };
        actions.push(moveButton(-1, idx <= 0, move(-1)), moveButton(1, idx < 0 || idx === shown.length - 1, move(1)));
    }
    if (kind === 'services' && isShown) {
        const editBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', dataset: { viewOk: '1' }, 'data-ws-edit': String(r.id) },
            Icon(readOnly() ? 'Search' : 'Edit', { size: 13 }), ' ', readOnly() ? 'Посмотреть' : 'Изменить');
        editBtn.addEventListener('click', () => openEditorModal('services', CONTENT_KINDS.services, { ...r }, r, reload));
        actions.push(editBtn);
    }
    if (r.has_extras && !readOnly()) {
        const resetBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-ws-reset': String(r.id) },
            Icon('Undo', { size: 13 }), ' ', 'Сбросить');
        resetBtn.addEventListener('click', () => openConfirm({
            title: 'Сбросить настройки сайта?', name, text: cfg.resetText, okLabel: 'Сбросить',
            onOk: async () => {
                try {
                    await rpc('website_content_delete', { kind, id: r[cfg.fk] });
                } catch (e) {
                    toast(trf('Не удалось сбросить. {reason}', { reason: errText(e) }), 'fail');
                    throw e;
                }
                toast(tr('Сброшено'));
                reload();
            },
        }));
        actions.push(resetBtn);
    }

    return h('div', {
        class: 'card', 'data-ws-row': String(r.id), 'data-ws-state': str(r.state),
        style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', flexWrap: 'wrap', opacity: isShown ? '1' : '0.62' },
    },
        kind === 'doctors' && r.photo_url
            ? h('img', { src: r.photo_url, alt: '', style: { width: '36px', height: '36px', borderRadius: '50%', objectFit: 'cover', flex: '0 0 auto' } })
            : null,
        h('div', { style: { flex: '1 1 220px', minWidth: '0' } },
            h('div', { style: { fontWeight: '600', fontSize: '13.5px' } }, name),
            sub ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '1px' } }, sub) : null,
            reason ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' }, 'data-ws-reason': str(r.state) }, reason) : null),
        chips.length ? h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', flex: '0 0 auto' } }, ...chips) : null,
        actions.length ? h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', flex: '0 0 auto', flexWrap: 'wrap' } }, ...actions) : null);
}

// ---------------------------------------------------------------------------
// Вкладки «Отделения» / «Отзывы» / «Вопросы и ответы» / «Новости» — как в Chilla,
// со своей отметкой «На сайте». Плюс конфигурация окна услуги (services):
// оно открывается из вкладки «Услуги» тем же редактором.
//
// fk — колонка внешнего ключа; fields — поля content по языкам; scalarFields —
// прочие колонки формы; photoField — путь к файлу в корзине 'website'.
// ---------------------------------------------------------------------------
const CONTENT_KINDS = {
    services: {
        tabLabel: 'Услуги',
        fk: 'service_id',
        noSlug: true,   // у услуги слага нет: адрес — id + латиница имени (спека §4)
        fields: [
            ['short_desc',  'Краткое описание',    'textarea'],
            ['body',        'Полное описание',     'textarea'],
            ['preparation', 'Подготовка к услуге', 'textarea'],
        ],
        photoField: 'image_path',
        imageLabel: 'Изображение',
        scalarFields: [],
        rowLabel: (row) => row.name || '',
    },
    departments: {
        tabLabel: 'Отделения',
        pickList: 'departments',
        fk: 'department_id',
        pickLabel: (p) => p.name || '',
        fields: [
            ['name',        'Название', 'text'],
            ['description', 'Описание', 'textarea'],
        ],
        photoField: 'image_path',
        imageLabel: 'Изображение',
        scalarFields: [],
    },
    // Отзывы / FAQ — без внешнего ключа: «Добавить» открывает пустой черновик.
    // primaryField — какое поле content «главное» для чипов «нет uz/ru».
    testimonials: {
        tabLabel: 'Отзывы',
        fields: [
            ['text', 'Текст отзыва', 'textarea'],
        ],
        scalarFields: [
            { key: 'author_name', label: 'Имя автора', type: 'text' },
            {
                key: 'rating', label: 'Оценка', type: 'select', default: '5',
                options: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']],
            },
        ],
        primaryField: 'text',
        rowLabel: (row) => row.author_name || row.content?.ru?.text || row.content?.uz?.text || row.content?.en?.text || '',
    },
    faq: {
        tabLabel: 'Вопросы и ответы',
        fields: [
            ['q', 'Вопрос', 'text'],
            ['a', 'Ответ', 'textarea'],
        ],
        scalarFields: [],
        primaryField: 'q',
        rowLabel: (row) => row.content?.ru?.q || row.content?.uz?.q || row.content?.en?.q || '',
    },
    // Новости — свой слаг (сервер считает из заголовка) и обложка; ручного
    // порядка нет — лента по дате публикации (website_content_reorder отказывает).
    posts: {
        tabLabel: 'Новости',
        hasSlug: true,
        fields: [
            ['title',   'Заголовок',         'text'],
            ['excerpt', 'Краткое описание',  'textarea'],
            ['body',    'Полное описание',   'textarea'],
        ],
        photoField: 'cover_path',
        imageLabel: 'Обложка',
        scalarFields: [],
        primaryField: 'title',
        noReorder: true,
        rowLabel: (row) => row.content?.ru?.title || row.content?.uz?.title || row.content?.en?.title || '',
        metaLine: (row) => row.published_at ? String(row.published_at).slice(0, 10).split('-').reverse().join('.') : '—',
    },
};

function contentName(content) {
    const c = content || {};
    return (c.ru && c.ru.name) || (c.uz && c.uz.name) || (c.en && c.en.name) || '';
}

function completenessChips(cfg, row) {
    const nameField = cfg.primaryField || 'name';
    const c = row.content || {};
    const chips = [];
    if (cfg.photoField && !row[cfg.photoField]) chips.push(Tag('нет фото', { kind: 'warn' }));
    if (!(c.uz && c.uz[nameField])) chips.push(Tag('нет uz', { kind: 'warn' }));
    if (!(c.ru && c.ru[nameField])) chips.push(Tag('нет ru', { kind: 'warn' }));
    return chips;
}

function viewOrEditButton(onclick) {
    const btn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', dataset: { viewOk: '1' } },
        Icon(readOnly() ? 'Search' : 'Edit', { size: 13 }), ' ', readOnly() ? 'Посмотреть' : 'Изменить');
    btn.addEventListener('click', onclick);
    return btn;
}

async function renderContentTab(kind, bodyEl) {
    const cfg = CONTENT_KINDS[kind];
    bodyEl.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));

    // Виды без списка из системы (отзывы/FAQ/новости) website_pick_lists не зовут.
    let pickLists = {}, listOut;
    try {
        if (cfg.pickList) {
            [pickLists, listOut] = await Promise.all([
                rpc('website_pick_lists'),
                rpc('website_content_list', { kind }),
            ]);
        } else {
            listOut = await rpc('website_content_list', { kind });
        }
    } catch (e) {
        if (state.tab !== kind) return;
        clear(bodyEl);
        bodyEl.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
            h('div', null, 'Не удалось загрузить данные.'),
            h('div', { class: 'muted', style: { marginTop: '6px' } }, errText(e))));
        return;
    }
    if (state.tab !== kind) return;
    clear(bodyEl);
    const rows = (listOut && listOut.rows) || [];
    if (cfg.pickList) paintPickListTab(kind, cfg, bodyEl, (pickLists && pickLists[cfg.pickList]) || [], rows);
    else paintStandaloneTab(kind, cfg, bodyEl, rows);
}

// Отзывы / FAQ / новости — самостоятельные записи.
function paintStandaloneTab(kind, cfg, bodyEl, rows) {
    const reload = () => { clear(bodyEl); renderContentTab(kind, bodyEl); };
    const listBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });

    function paintRows() {
        clear(listBody);
        if (!rows.length) {
            listBody.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, 'Пока ничего не добавлено.'));
            return;
        }
        rows.forEach((row, idx) => listBody.appendChild(contentRow(kind, cfg, row, idx, rows, reload, paintRows)));
    }
    paintRows();

    const addBtn = readOnly() ? null : h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-ws-add': '' },
        Icon('Plus', { size: 13 }), ' ', 'Добавить');
    if (addBtn) addBtn.addEventListener('click', () => openEditorModal(kind, cfg, freshRow(cfg, null), null, reload));

    bodyEl.appendChild(card(cfg.tabLabel, 'Doc',
        h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '10px' } }, addBtn),
        listBody,
    ));
}

// Отделения — все активные отделения клиники (website_pick_lists), к ним —
// строки сайта по department_id. Сначала показанные на сайте в порядке сайта
// (среди них работают стрелки), затем остальные по алфавиту. Массовых кнопок
// Chilla («Показать все найденные») нет: их делали ради сотен услуг, а
// отделений в клинике — единицы.
function paintPickListTab(kind, cfg, bodyEl, pickArr, rows) {
    const overlayByFk = new Map(rows.map((r) => [r[cfg.fk], r]));
    const pickByFk = new Map(pickArr.map((p) => [p[cfg.fk], p]));
    const reload = () => { clear(bodyEl); renderContentTab(kind, bodyEl); };

    const publishedRows = rows.filter((r) => r.published && pickByFk.has(r[cfg.fk]));
    const publishedFks = new Set(publishedRows.map((r) => r[cfg.fk]));
    const rest = pickArr
        .filter((p) => !publishedFks.has(p[cfg.fk]))
        .sort((a, b) => cfg.pickLabel(a).localeCompare(cfg.pickLabel(b)));

    const listBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    function paintRows() {
        clear(listBody);
        if (!pickArr.length) {
            listBody.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, 'В клинике нет активных отделений.'));
            return;
        }
        publishedRows.forEach((row, idx) => listBody.appendChild(
            pickListRow(kind, cfg, pickByFk.get(row[cfg.fk]), row, { idx, arr: publishedRows }, reload, paintRows)));
        rest.forEach((p) => listBody.appendChild(
            pickListRow(kind, cfg, p, overlayByFk.get(p[cfg.fk]) || null, null, reload, paintRows)));
    }
    paintRows();

    bodyEl.appendChild(card(cfg.tabLabel, 'Doc',
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '12px' } },
            'Отделения берутся из системы — отметьте, какие показать на сайте, и заполните их описание.'),
        listBody,
    ));
}

// Первое включение «На сайте» без строки сайта — сеем имя из системы, иначе
// сайт нарисовал бы карточку без названия (слаг из него сервер посчитает сам).
function seedContent(pick) {
    return { ru: { name: (pick && pick.name) || '' } };
}

function pickListRow(kind, cfg, pick, overlay, order, reload, repaint) {
    const name = (pick && cfg.pickLabel(pick)) || (overlay && contentName(overlay.content)) || '—';
    const published = !!(overlay && overlay.published);

    const publishCb = h('input', {
        type: 'checkbox', checked: published, title: 'На сайте', 'aria-label': 'На сайте',
        onchange: async (e) => {
            const val = e.target.checked;
            e.target.disabled = true;
            try {
                // Один website_content_save с published; content — только у
                // новой строки (у существующей не прислан — сервер не трогает).
                const row = { [cfg.fk]: pick[cfg.fk], published: val ? 1 : 0 };
                if (!overlay) row.content = seedContent(pick);
                await rpc('website_content_save', { kind, row });
                toast(val ? tr('Опубликовано') : tr('Снято с публикации'));
                reload();
                return;
            } catch (err) {
                e.target.checked = !val;
                toast(trf('Не удалось изменить публикацию. {reason}', { reason: errText(err) }), 'fail');
            }
            e.target.disabled = false;
        },
    });

    const moveBtns = [];
    if (order && !readOnly()) {
        const move = (dir) => async () => {
            const arr = order.arr;
            const j = order.idx + dir;
            [arr[order.idx], arr[j]] = [arr[j], arr[order.idx]];
            try {
                await rpc('website_content_reorder', { kind, ids: arr.map((r) => r.id) });
            } catch (err) {
                [arr[order.idx], arr[j]] = [arr[j], arr[order.idx]];
                toast(trf('Не удалось изменить порядок. {reason}', { reason: errText(err) }), 'fail');
            }
            repaint();
        };
        moveBtns.push(moveButton(-1, order.idx === 0, move(-1)), moveButton(1, order.idx === order.arr.length - 1, move(1)));
    }

    const freshOrOverlay = () => (overlay ? { ...overlay } : freshRow(cfg, pick));
    const editBtn = viewOrEditButton(() => openEditorModal(kind, cfg, freshOrOverlay(), pick, reload));
    const delBtn = (readOnly() || !overlay) ? null : h('button', { class: 'btn btn-outline btn-sm', type: 'button' },
        Icon('Trash', { size: 13 }), ' ', 'Удалить');
    if (delBtn) delBtn.addEventListener('click', () => openDeleteConfirm(kind, overlay, name, reload));

    const overlayName = overlay ? contentName(overlay.content) : '';
    const secondary = [];
    if (overlay) {
        if (overlayName && overlayName !== name) secondary.push(overlayName);
        secondary.push(overlay.slug || '—');
    }

    return h('div', {
        class: 'card', 'data-ws-row': String(pick ? pick[cfg.fk] : overlay.id),
        style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', opacity: overlay ? '1' : '0.72' },
    },
        readOnly() ? null : publishCb,
        h('div', { style: { flex: '1 1 auto', minWidth: '0' } },
            h('div', { style: { fontWeight: '600', fontSize: '13.5px' } }, name),
            secondary.length ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '1px' } }, secondary.join(' · ')) : null),
        published ? Tag('На сайте', { kind: 'ok' }) : null,
        overlay ? h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', flex: '0 0 auto' } }, ...completenessChips(cfg, overlay)) : null,
        h('div', { class: 'row', style: { gap: '4px', flex: '0 0 auto' } }, ...moveBtns, editBtn, delBtn));
}

// Строка отзыва / вопроса / новости: «На сайте», имя + чипы полноты, порядок,
// «Изменить», «Удалить».
function contentRow(kind, cfg, row, idx, rows, reload, repaint) {
    const name = (cfg.rowLabel && cfg.rowLabel(row)) || contentName(row.content) || '—';

    const publishCb = h('input', {
        type: 'checkbox', checked: !!row.published, title: 'На сайте', 'aria-label': 'На сайте',
        onchange: async (e) => {
            const val = e.target.checked;
            e.target.disabled = true;
            try {
                await rpc('website_content_publish', { kind, id: row.id, published: val });
                row.published = val ? 1 : 0;
                toast(val ? tr('Опубликовано') : tr('Снято с публикации'));
                // Дата выхода новости ставится публикацией — без перечитывания
                // строка показывала бы «—» до следующего захода.
                if (kind === 'posts') { reload(); return; }
            } catch (err) {
                e.target.checked = !val;
                toast(trf('Не удалось изменить публикацию. {reason}', { reason: errText(err) }), 'fail');
            }
            e.target.disabled = false;
        },
    });

    const moveBtns = [];
    if (!readOnly() && !cfg.noReorder) {
        const move = (dir) => async () => {
            const j = idx + dir;
            [rows[idx], rows[j]] = [rows[j], rows[idx]];
            try {
                await rpc('website_content_reorder', { kind, ids: rows.map((r) => r.id) });
            } catch (err) {
                [rows[idx], rows[j]] = [rows[j], rows[idx]];
                toast(trf('Не удалось изменить порядок. {reason}', { reason: errText(err) }), 'fail');
            }
            repaint();
        };
        moveBtns.push(moveButton(-1, idx === 0, move(-1)), moveButton(1, idx === rows.length - 1, move(1)));
    }

    const editBtn = viewOrEditButton(() => openEditorModal(kind, cfg, { ...row }, null, reload));
    const delBtn = readOnly() ? null : h('button', { class: 'btn btn-outline btn-sm', type: 'button' },
        Icon('Trash', { size: 13 }), ' ', 'Удалить');
    if (delBtn) delBtn.addEventListener('click', () => openDeleteConfirm(kind, row, name, reload));

    return h('div', { class: 'card', 'data-ws-row': String(row.id), style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px' } },
        readOnly() ? null : publishCb,
        h('div', { style: { flex: '1', minWidth: '0' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                h('span', { style: { fontWeight: '600', fontSize: '13.5px' } }, name),
                row.published ? Tag('На сайте', { kind: 'ok' }) : null,
                ...completenessChips(cfg, row)),
            cfg.metaLine ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '1px' } }, cfg.metaLine(row)) : null),
        moveBtns.length ? h('div', { class: 'row', style: { gap: '4px' } }, ...moveBtns) : null,
        editBtn, delBtn);
}

function freshRow(cfg, pick) {
    const row = { content: { uz: {}, ru: {}, en: {} } };
    if (cfg.fk) { row[cfg.fk] = pick[cfg.fk]; if (!cfg.noSlug) row.slug = ''; }
    if (cfg.photoField) row[cfg.photoField] = '';
    for (const sf of cfg.scalarFields) {
        row[sf.key] = sf.default !== undefined ? sf.default : (sf.type === 'checkbox' ? 0 : '');
    }
    return row;
}

// Редактор карточки: языковые под-вкладки над полями content, прочие поля, фото.
// На «Просмотре» поля серые и кнопки «Сохранить» нет.
function openEditorModal(kind, cfg, row, pick, reload) {
    const draft = { ...row, content: { uz: {}, ru: {}, en: {} } };
    for (const lang of ['uz', 'ru', 'en']) {
        const src = row.content && row.content[lang];
        draft.content[lang] = (src && typeof src === 'object') ? { ...src } : {};
    }
    let activeLang = 'ru';

    const overlay = h('div', { class: 'modal', style: { zIndex: '130' }, 'data-ws-editor': kind });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const langTabs = h('div', { class: 'tabs', style: { marginBottom: '10px' } });
    const fieldsWrap = h('div', { style: { display: 'flex', flexDirection: 'column' } });
    function paintLangTabs() {
        clear(langTabs);
        for (const [code, label] of LANGS) {
            const btn = h('button', { class: 'tab' + (activeLang === code ? ' on' : ''), type: 'button' }, label);
            btn.addEventListener('click', () => { activeLang = code; paintLangTabs(); paintFields(); });
            langTabs.appendChild(btn);
        }
    }
    // Chilla WEBSITE_CONTENT_MODAL_COMPACT_V1 — короткие поля парами, длинные на
    // всю ширину в три строки: иначе окно выше экрана.
    const PAIR = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' };
    function paintFields() {
        clear(fieldsWrap);
        const langObj = draft.content[activeLang];
        let pair = null;
        for (const [key, label, kindF] of cfg.fields) {
            if (kindF === 'textarea') {
                pair = null;
                fieldsWrap.appendChild(field(label, textArea(langObj, key, 3)));
                continue;
            }
            if (!pair || pair.children.length >= 2) {
                pair = h('div', { style: PAIR });
                fieldsWrap.appendChild(pair);
            }
            pair.appendChild(field(label, textInput(langObj, key)));
        }
    }
    paintLangTabs();
    paintFields();

    const scalarWrap = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px', marginTop: '4px' } });
    for (const sf of cfg.scalarFields) {
        if (sf.type === 'select') {
            const sel = h('select', {
                disabled: readOnly() ? true : null,
                onchange: (e) => { draft[sf.key] = e.target.value; },
            }, ...sf.options.map(([val, label]) => h('option', { value: val, selected: String(draft[sf.key]) === String(val) }, label)));
            scalarWrap.appendChild(field(sf.label, sel));
        } else {
            scalarWrap.appendChild(field(sf.label, textInput(draft, sf.key, { placeholder: sf.placeholder })));
        }
    }

    let photoBlock = null;
    if (cfg.photoField) {
        const hasPhoto = !!draft[cfg.photoField];
        const preview = h('img', {
            alt: '',
            style: { maxWidth: '160px', maxHeight: '160px', borderRadius: '8px', objectFit: 'cover', display: hasPhoto ? '' : 'none', marginTop: '8px' },
        });
        if (hasPhoto) preview.src = publicUrl(draft[cfg.photoField]);
        const fileInp = h('input', {
            type: 'file', accept: IMAGE_ACCEPT, disabled: readOnly() ? true : null,
            onchange: async (e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                try {
                    // Префикс от fk, у новостей — от id черновика или метки
                    // времени: разные черновики не перезапишут друг друга.
                    const prefix = cfg.fk ? `${kind}/${draft[cfg.fk]}-` : `${kind}/${draft.id || Date.now()}-`;
                    const path = await uploadWebsiteImage(f, prefix);
                    draft[cfg.photoField] = path;
                    preview.src = publicUrl(path);
                    preview.style.display = '';
                    toast(tr('Изображение загружено'));
                } catch (err) {
                    toast(trf('Не удалось загрузить изображение. {reason}', { reason: errText(err) }), 'fail');
                }
            },
        });
        photoBlock = h('div', { style: { marginTop: '8px' } }, field(cfg.imageLabel, fileInp), preview,
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } }, 'Только JPG, PNG или WEBP.'));
    }

    const titleName = (pick && (cfg.pickLabel ? cfg.pickLabel(pick) : (cfg.rowLabel && cfg.rowLabel(pick))))
        || (cfg.rowLabel && cfg.rowLabel(draft)) || contentName(draft.content) || '—';

    const saveBtn = readOnly() ? null : h('button', { class: 'btn btn-primary', type: 'button', 'data-ws-modal-save': '' }, Icon('Check', { size: 14 }), ' ', 'Сохранить');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
            // Только то, что форма правит: сервер не трогает неприсланное, и
            // окно услуги не сбросит её «На главной» и порядок.
            const payload = { content: draft.content };
            if (draft.id != null && !cfg.fk) payload.id = draft.id;
            if (cfg.fk) payload[cfg.fk] = draft[cfg.fk];
            // Слаг шлём, чтобы повторное сохранение не пересчитало опубликованный
            // адрес из нового заголовка.
            if ((cfg.fk && !cfg.noSlug) || cfg.hasSlug) payload.slug = draft.slug || '';
            if (cfg.photoField) payload[cfg.photoField] = draft[cfg.photoField] || '';
            for (const sf of cfg.scalarFields) payload[sf.key] = draft[sf.key];
            await rpc('website_content_save', { kind, row: payload });
            toast(tr('Сохранено'));
            close();
            reload();
        } catch (e) {
            toast(trf('Не удалось сохранить. {reason}', { reason: errText(e) }), 'fail');
            saveBtn.disabled = false;
        }
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '640px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, cfg.tabLabel, ' — ', titleName),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' }, langTabs, fieldsWrap, cfg.scalarFields.length ? scalarWrap : null, photoBlock),
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-outline', type: 'button', onclick: close }, readOnly() ? 'Закрыть' : 'Отмена'),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    return overlay;
}

function openDeleteConfirm(kind, row, name, reload) {
    openConfirm({
        title: 'Удалить запись?', name,
        text: 'Это действие необратимо: карточка исчезнет с публичного сайта.',
        okLabel: 'Удалить',
        onOk: async () => {
            try {
                await rpc('website_content_delete', { kind, id: row.id });
            } catch (e) {
                toast(trf('Не удалось удалить. {reason}', { reason: errText(e) }), 'fail');
                throw e;
            }
            toast(tr('Удалено'));
            reload();
        },
    });
}

// Для тестов: снимок состояния экрана.
export const __test = { state, PROFILE_KINDS };
