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

// WEBSITE_EDITOR_V2 (2026-11-25, владелец: «looks old styled and not user friendly, can you make
// it clear and user friendly and … on the right side … live change in website»):
//
//   * три колонки: разделы слева, форма посередине, справа — «Живой просмотр» настоящей
//     страницы с несохранёнными правками (website-preview.js);
//   * язык ОДИН на экран (и на просмотр): раньше каждое поле стояло тремя карточками подряд;
//   * сохранение — одна полоса внизу формы, она говорит, есть ли несохранённое, и умеет
//     отменить; правки всех разделов настроек копятся в одном объекте и сохраняются вместе;
//   * карточка содержимого открывается на месте формы, а не окном поверх просмотра;
//   * выключатель и состояние сайта — в шапке, видны из любого раздела.

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, field, checkField, Tag } from '../ui.js';
import { commerceToolLevel } from '../permissions.js';
import { tr, trf } from '../i18n.js';   // toast()/textContent минуют tr() внутри h() — переводим сами
import { uploadFile } from '../storage.js';
import { createPreview } from './website-preview.js';

// Языки сайта — тот же порядок и набор, что проверяет websiteSettingsSave.
const LANGS = [
    ['uz', 'Узбекский'],
    ['ru', 'Русский'],
    ['en', 'Английский'],
];

const DEFAULT_SITE_PORT = 8001;

// Разделы: id, подпись, значок, страница просмотра и место на ней.
const NAV = [
    ['Сайт', [
        ['general',      'Основное',            'Settings',    '/'],
        ['contacts',     'Контакты',            'Phone',       '/contact'],
    ]],
    ['Страницы', [
        ['home',         'Главная страница',    'Globe',       '/', '.home-hero'],
        ['about',        'О клинике',           'Info',        '/about'],
        ['legal',        'Правовые документы',  'Shield',      '/privacy'],
    ]],
    ['Содержимое', [
        ['doctors',      'Врачи',               'Stethoscope', '/doctors'],
        ['services',     'Услуги',              'Pulse',       '/services'],
        ['departments',  'Отделения',           'Building',    '/departments'],
        ['testimonials', 'Отзывы',              'Heart',       '/', '[class*="testimonial"],[class*="review"]'],
        ['faq',          'Вопросы и ответы',    'Help',        '/faq'],
        ['posts',        'Новости',             'Megaphone',   '/news'],
    ]],
    ['Продвижение', [
        ['seo',          'SEO',                 'Search',      '/'],
    ]],
];
const NAV_ITEMS = NAV.flatMap(([, items]) => items);
const navItem = (id) => NAV_ITEMS.find((n) => n[0] === id) || NAV_ITEMS[0];

// Корзина хранилища сайта (server/routes/storage.js): только эти расширения —
// SVG сайт не отдаёт. Проверяем заранее, чтобы ответить по-русски до загрузки,
// а не голым 415 сервера.
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

const state = {
    settings:   {},
    saved:      '{}',     // что лежит на сервере (JSON) — с ним сравнивается «не сохранено»
    site:       { running: false, port: 0 },
    updated_at: null,
    tab:        'general',
    lang:       'ru',
    saving:     false,
    editor:     null,     // открытая карточка содержимого
};

const refs = { root: null, head: null, nav: null, langs: null, body: null, bar: null, preview: null, onChanged: null };

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || tr('Не удалось выполнить запрос.'));
    // Порядок, «На главной», публикация — видны на сайте сразу, значит и в просмотре.
    if (refs.preview && /^website_content_(save|publish|delete|reorder)$/.test(name)) refs.preview.schedule();
    return data;
}

// «Изменение» — правит; «Просмотр» — видит всё серым и без кнопок сохранения.
const readOnly = () => commerceToolLevel('commerce_website') !== 'edit';

// Ветка settings, создаваемая по требованию: открыли вкладку — объект должен
// существовать, даже если в базе его ещё нет.
function branch(key) { return subBranch(state.settings, key); }
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

// Пустые ветки экран создаёт сам, открывая раздел, — правкой они не считаются.
function pruned(v) {
    if (Array.isArray(v)) return v.map(pruned);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v).sort()) {
            const p = pruned(v[k]);
            const empty = p == null || p === '' || (typeof p === 'object' && Object.keys(p).length === 0);
            if (!empty) out[k] = p;
        }
        return out;
    }
    return v;
}
const isDirty = () => JSON.stringify(pruned(state.settings)) !== JSON.stringify(pruned(JSON.parse(state.saved)));
const editorSnapshot = () => (state.editor ? JSON.stringify(state.editor.draft) : '');
const editorDirty = () => !!state.editor && editorSnapshot() !== state.editor.initial;

if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', (e) => {
        if (refs.root && refs.root.isConnected && !readOnly() && (isDirty() || editorDirty())) { e.preventDefault(); e.returnValue = ''; }
    });
}

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
    state.saved = '{}';
    state.saving = false;
    state.editor = null;
    refs.preview = null;

    refs.root = h('div', { class: 'fade-in ws-ed', 'data-website-settings': '' });
    container.appendChild(refs.root);
    const loading = h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…');
    refs.root.appendChild(loading);

    let data;
    try {
        data = await rpc('website_settings_get');
    } catch (e) {
        clear(refs.root);
        refs.root.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
            h('div', null, 'Не удалось загрузить настройки сайта.'),
            h('div', { class: 'muted', style: { marginTop: '6px' } }, errText(e))));
        return;
    }

    const loaded = data && data.settings;
    state.settings   = (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) ? loaded : {};
    state.saved      = JSON.stringify(state.settings);
    state.site       = readSite(data && data.site);
    state.updated_at = (data && data.updated_at) || null;
    const langs = siteLangs();
    if (!langs.includes(state.lang)) state.lang = langs[0];

    clear(refs.root);
    refs.head  = h('div');
    refs.nav   = h('nav', { class: 'ws-nav', 'aria-label': 'Разделы сайта' });
    refs.langs = h('div', { class: 'ws-langs' });
    refs.body  = h('div', { class: 'ws-body' });
    refs.bar   = h('div', { class: 'ws-savebar' });
    // Любая правка формы: поля сообщают input/change, кнопки порядка и «Убрать» — click.
    for (const ev of ['input', 'change', 'click']) refs.body.addEventListener(ev, () => setTimeout(changed, 0));
    refs.preview = createPreview({
        load: async (path) => {
            const args = { path, settings: state.settings };
            const row = previewRow();
            if (row) args.row = row;
            const out = await rpc('website_preview', args);
            return String((out && out.html) || '');
        },
        getLang: () => state.lang,
        onLang: (l) => setLang(l),
    });
    const toggle = h('button', { type: 'button', class: 'ws-pv-toggle', 'aria-pressed': 'false', onclick: () => {
        const on = !refs.root.classList.contains('show-preview');
        refs.root.classList.toggle('show-preview', on);
        toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
        toggle.textContent = tr(on ? 'Вернуться к редактору' : 'Показать сайт');
    } }, 'Показать сайт');
    refs.root.appendChild(refs.head);
    refs.root.appendChild(toggle);
    refs.root.appendChild(h('div', { class: 'ws-layout' },
        refs.nav,
        h('div', { class: 'ws-form' }, refs.langs, refs.body, refs.bar),
        refs.preview.el));

    paint();
    showTabPage();
    refs.preview.refresh();
}

function paint() {
    paintHead();
    paintNav();
    paintLangs();
    clear(refs.body);
    refs.onChanged = null;
    const tabBody = h('div', { class: 'ws-cards' });
    refs.body.appendChild(tabBody);
    if (state.editor) renderEditor(tabBody);
    else (TAB_RENDERERS[state.tab] || TAB_RENDERERS.general)(tabBody);
    paintBar();
}

function showTabPage() {
    const [, , , path, sel] = navItem(state.tab);
    refs.preview.show(path, sel || null);
}

function changed() {
    if (!refs.root) return;
    paintBar();
    if (refs.onChanged) refs.onChanged();
    const snap = JSON.stringify(state.settings) + editorSnapshot();
    if (snap === refs.lastSnap) return;
    refs.lastSnap = snap;
    paintLangs();   // точка «текста ещё нет» гаснет с первой буквой
    refs.preview.schedule();
}

function setLang(code) {
    if (state.lang === code) return;
    state.lang = code;
    paint();
    refs.preview.refresh();
}

// Уйти с открытой карточки: несохранённое в ней пропадёт — сначала спросить.
function leaveEditor(next) {
    if (!editorDirty() || readOnly()) { state.editor = null; next(); return; }
    openConfirm({
        title: 'Закрыть без сохранения?', text: 'Правки этой карточки не сохранены и пропадут.', okLabel: 'Закрыть без сохранения',
        onOk: async () => { state.editor = null; next(); },
    });
}

function openTab(id) {
    if (state.tab === id && !state.editor) return;
    leaveEditor(() => { state.tab = id; paint(); showTabPage(); refs.preview.schedule(); });
}

function paintNav() {
    clear(refs.nav);
    for (const [group, items] of NAV) {
        refs.nav.appendChild(h('div', { class: 'ws-nav-group' },
            h('div', { class: 'ws-nav-title' }, group),
            ...items.map(([id, label, icon]) => h('button', {
                class: 'ws-nav-item' + (state.tab === id ? ' on' : ''), type: 'button', 'data-ws-tab': id,
                'aria-current': state.tab === id ? 'page' : null,
                onclick: () => openTab(id),
            }, Icon(icon, { size: 16 }), h('span', null, label)))));
    }
}

const siteLangs = () => {
    const l = Array.isArray(state.settings.langs) ? LANGS.map(([c]) => c).filter((c) => state.settings.langs.includes(c)) : [];
    return l.length ? l : LANGS.map(([c]) => c);
};

// Есть ли на языке хоть один текст раздела (или карточки) — точка у языка без текста.
const LANG_TEXTS = {
    home:  (c) => { const x = state.settings.hero || {}; return [x[c] && x[c].title, x[c] && x[c].subtitle]; },
    about: (c) => { const x = (state.settings.about || {})[c] || {}; return [x.title, x.body]; },
    legal: (c) => { const x = state.settings.legal || {}; return [(x.privacy || {})[c], (x.terms || {})[c]]; },
    seo:   (c) => { const x = state.settings.seo || {}; return [(x.title || {})[c], (x.description || {})[c]]; },
};
function langMissing(code) {
    const texts = state.editor ? Object.values(state.editor.draft.content[code] || {}) : (LANG_TEXTS[state.tab] ? LANG_TEXTS[state.tab](code) : ['-']);
    return !texts.some((v) => str(v).trim());
}

function paintLangs() {
    clear(refs.langs);
    const on = siteLangs();
    refs.langs.appendChild(h('span', { class: 'ws-langs-label' }, 'Язык текста и просмотра'));
    refs.langs.appendChild(h('div', { class: 'ws-segs' }, ...LANGS.map(([code, label]) => {
        const empty = langMissing(code);
        return h('button', {
            type: 'button', class: 'ws-seg' + (state.lang === code ? ' on' : ''), 'data-ws-lang': code,
            'aria-pressed': state.lang === code ? 'true' : 'false',
            title: !on.includes(code) ? 'Язык выключен на сайте' : (empty ? 'На этом языке текста ещё нет' : null),
            onclick: () => setLang(code),
        }, label, empty && on.includes(code) ? h('span', { class: 'ws-dot', 'aria-hidden': 'true' }) : null);
    })));
}

// Реестр вкладок: новая вкладка — функция здесь, меню о ней не знает.
const TAB_RENDERERS = {
    general:      renderGeneralTab,
    contacts:     renderContactsTab,
    home:         renderHomeTab,
    about:        renderAboutTab,
    legal:        renderLegalTab,
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
    return h('section', { class: 'card ws-card' },
        h('div', { class: 'ws-card-head' }, h('span', { class: 'ws-card-ico' }, Icon(iconName, { size: 16 })), h('h3', null, title)),
        h('div', { class: 'ws-card-body' }, ...children));
}

// Карточка, у которой есть место на сайте: поставили курсор в поле — просмотр
// открывает эту страницу и прокручивается к этому месту.
function at(el, path, sel) {
    el.addEventListener('focusin', () => { if (refs.preview) refs.preview.show(path, sel || null); });
    return el;
}

function hint(text) { return h('p', { class: 'ws-hint' }, text); }
function note(text) { return h('p', { class: 'ws-note' }, Icon('Info', { size: 15 }), h('span', null, text)); }

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
        class: 'btn btn-ghost btn-sm ws-move', type: 'button',
        title: dir < 0 ? 'Выше' : 'Ниже', 'aria-label': dir < 0 ? 'Выше' : 'Ниже',
        disabled: disabled ? true : null, onclick,
    }, Icon(dir < 0 ? 'ArrowUp' : 'ArrowDown', { size: 14 }));
}

// Загрузка: вместо голого поля «Выберите файл» — обычная кнопка.
function uploadButton(label, { multiple = false, onFiles }) {
    const inp = h('input', { type: 'file', accept: IMAGE_ACCEPT, multiple: multiple ? true : null, class: 'ws-file', 'aria-label': label,
        onchange: async (e) => {
            const files = [].slice.call(e.target.files || []);
            if (!files.length) return;
            await onFiles(files);
            e.target.value = '';
            changed();
        } });
    return h('label', { class: 'btn btn-outline btn-sm ws-upload' }, Icon('Image', { size: 14 }), ' ', label, inp);
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
        const sent = JSON.stringify(state.settings);   // правки, набранные во время запроса, — ещё не сохранены
        const out = await rpc('website_settings_save', { settings: JSON.parse(sent), prev_updated_at: state.updated_at });
        state.saved = sent;
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

// Полоса сохранения. На «Просмотре» кнопок нет вовсе — вместо них строка,
// почему поля серые. При открытой карточке содержимого — её собственные кнопки.
function paintBar() {
    clear(refs.bar);
    refs.bar.className = 'ws-savebar';
    if (readOnly()) {
        refs.bar.appendChild(h('span', { class: 'muted' }, 'Доступ только для чтения: менять настройки сайта нельзя.'));
        if (state.editor) refs.bar.appendChild(backButton('Закрыть'));
        return;
    }
    if (state.editor) { paintEditorBar(); return; }

    const dirty = isDirty();
    refs.bar.classList.toggle('is-dirty', dirty);
    refs.bar.appendChild(h('span', { class: 'ws-savebar-text', role: 'status', 'data-ws-dirty': dirty ? '1' : '0' },
        dirty ? 'Есть несохранённые изменения — посетители их ещё не видят'
            : (state.updated_at
                ? trf('Всё сохранено. Последнее изменение: {at}', { at: localTime(state.updated_at) })
                : 'Всё сохранено')));
    if (dirty) {
        refs.bar.appendChild(h('button', { class: 'btn btn-outline', type: 'button', 'data-ws-discard': '', onclick: () => openConfirm({
            title: 'Отменить изменения?', text: 'Все несохранённые правки настроек сайта пропадут.', okLabel: 'Отменить изменения',
            onOk: async () => { state.settings = JSON.parse(state.saved); paint(); refs.preview.refresh(); },
        }) }, 'Отменить'));
    }
    const btn = h('button', { class: 'btn btn-primary', type: 'button', 'data-ws-save': '' }, Icon('Check', { size: 14 }), ' ', 'Сохранить');
    btn.disabled = !dirty;
    btn.addEventListener('click', async () => {
        if (state.saving) return;
        for (const [tab, validate] of [['general', validateGeneral], ['contacts', validateContacts], ['seo', validateSeo]]) {
            const err = validate();
            if (!err) continue;
            toast(tr(err), 'fail');
            if (state.tab !== tab) openTab(tab);
            return;
        }
        btn.disabled = true;
        // Форму не перерисовываем: человек мог продолжить набирать.
        await saveSettings();
        paintHead();
        paintBar();
    });
    refs.bar.appendChild(btn);
}

function localTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return str(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Шапка: состояние сайта, выключатель, «Открыть сайт»
// ---------------------------------------------------------------------------
function siteUrl() {
    const lang = str(state.settings.default_lang) || 'uz';
    return `http://${location.hostname}:${state.site.port || DEFAULT_SITE_PORT}/${lang}/`;
}

// Выключатель сохраняет сразу (как «ИИ отвечает в чатах»): включить сайт и потом
// искать, какую кнопку нажать, чтобы порт открылся, — лишний шаг. Уходит весь
// объект настроек, а значит и несохранённые правки — подсказка в «Основном» это говорит.
function paintHead() {
    clear(refs.head);
    const s = state.settings;
    const on = s.enabled === true;
    const box = h('input', {
        type: 'checkbox', checked: on, role: 'switch', class: 'ws-switch', 'data-ws-enabled': '',
        'aria-label': 'Сайт включён',
        disabled: readOnly() ? true : null,
    });
    box.addEventListener('change', async () => {
        const prev = s.enabled;
        // Только настоящее true/false: сервер строку «false» не примет (она
        // открыла бы порт), поэтому и экран другого не шлёт.
        s.enabled = box.checked === true;
        box.disabled = true;
        if (await saveSettings()) { paintHead(); paintBar(); return; }
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

    refs.head.appendChild(PageHead({
        title: 'Веб-сайт',
        subtitle: 'Меняйте тексты слева — справа сразу видно, как их увидит посетитель.',
        right: [
            status,
            h('label', { class: 'ws-enable' }, box, h('span', null, 'Сайт включён')),
            state.site.running
                ? h('a', { class: 'btn btn-outline btn-sm', href: siteUrl(), target: '_blank', rel: 'noopener noreferrer', 'data-ws-open': '' },
                    Icon('Globe', { size: 14 }), ' ', 'Открыть сайт')
                : null,
        ],
    }));
    if (on && !state.site.running) {
        refs.head.appendChild(h('p', { class: 'ws-alert' },
            'Порт занят другой программой или сайт отключён на сервере. Перезапустите программу; если не поможет — обратитесь к менеджеру Easy-Med.'));
    }
}

// ---------------------------------------------------------------------------
// «Основное», «Контакты»
// ---------------------------------------------------------------------------
function renderGeneralTab(bodyEl) {
    const s = state.settings;
    const defLang = str(s.default_lang) || 'uz';
    const langSel = h('select', {
        disabled: readOnly() ? true : null,
        onchange: (e) => { s.default_lang = e.target.value; },
    }, ...LANGS.map(([code, label]) => h('option', { value: code, selected: defLang === code }, label)));

    const langChecks = LANGS.map(([code, label]) => {
        const box = h('input', {
            type: 'checkbox',
            checked: siteLangs().includes(code),
            disabled: readOnly() ? true : null,
            onchange: (e) => {
                const set = new Set(Array.isArray(s.langs) ? s.langs : siteLangs());
                if (e.target.checked) set.add(code); else set.delete(code);
                s.langs = LANGS.map(([c]) => c).filter((c) => set.has(c));
            },
        });
        return checkField(label, box);
    });

    bodyEl.appendChild(card('Языки сайта', 'Globe',
        h('div', { class: 'ws-label' }, 'Доступные языки'),
        h('div', { class: 'ws-checks' }, ...langChecks),
        field('Язык по умолчанию', langSel),
        hint('С этого языка начинает посетитель, который пришёл без указания языка.'),
    ));
    bodyEl.appendChild(card('Где открывается сайт', 'Link',
        note('Сайт открывается с компьютеров локальной сети по адресу этого компьютера, порт 8001. При первом запуске Windows может один раз спросить, разрешить ли программе доступ к сети, — ответьте «Разрешить» для частных сетей.'),
        readOnly() ? null : hint('Выключатель «Сайт включён» вверху сохраняет настройки сразу — вместе с несохранёнными правками всех разделов.'),
        hint('Живой просмотр справа работает и при выключенном сайте.'),
    ));
}

function validateGeneral() {
    const s = state.settings;
    if (Array.isArray(s.langs) && !s.langs.length) return 'Оставьте включённым хотя бы один язык сайта.';
    if (s.default_lang && !siteLangs().includes(s.default_lang)) {
        return 'Язык по умолчанию должен быть среди доступных языков.';
    }
    return null;
}

function renderContactsTab(bodyEl) {
    const contact = branch('contact');
    const social  = branch('social');
    bodyEl.appendChild(at(card('Контакты', 'Phone',
        h('div', { class: 'ws-grid2' },
            field('Телефон', textInput(contact, 'phone', { placeholder: '+998 71 200 00 00' })),
            field('Email', textInput(contact, 'email', { placeholder: 'info@clinic.uz' }))),
        field('Адрес', textInput(contact, 'address')),
    ), '/contact'));
    bodyEl.appendChild(at(card('Карта и проезд', 'MapPin',
        field('Ссылка на карту', textInput(contact, 'map_url', { placeholder: 'https://maps.google.com/…' })),
        // Chilla CONTACT_HOME_V1 — кнопка «Вызвать такси» под картой; пусто — кнопки нет.
        field('Ссылка «Вызвать такси» (Яндекс Go и т. п.)', textInput(contact, 'taxi_url', { placeholder: 'https://3.redirect.appmetrica.yandex.com/route?…' })),
        field('Карта на странице (HTML-код виджета)', textArea(contact, 'map_embed', 4)),
        hint('Код вставляется на сайт как есть. Политика безопасности сайта автоматически разрешает карты с google.com, maps.google.com и yandex.ru; виджет с другого источника может быть отклонён — тогда оставьте только ссылку на карту.'),
    ), '/contact', '.contact-side'));
    bodyEl.appendChild(at(card('Социальные сети', 'Msg',
        h('div', { class: 'ws-grid2' },
            field('Instagram', textInput(social, 'instagram', { placeholder: 'https://instagram.com/…' })),
            field('Telegram',  textInput(social, 'telegram',  { placeholder: 'https://t.me/…' })),
            field('Facebook',  textInput(social, 'facebook',  { placeholder: 'https://facebook.com/…' })),
            field('YouTube',   textInput(social, 'youtube',   { placeholder: 'https://youtube.com/…' }))),
        hint('Только полные адреса, начинающиеся с https://. Пустое поле — значок в подвале сайта не показывается.'),
    ), '/contact', '.site-footer'));
}

function validateContacts() {
    const social = branch('social');
    for (const key of ['instagram', 'telegram', 'facebook', 'youtube']) {
        const v = str(social[key]).trim();
        if (v && !/^https:\/\//i.test(v)) return 'Ссылки на соцсети должны начинаться с https://';
    }
    return null;
}

// ---------------------------------------------------------------------------
// «SEO» — форма повторяет то, что читает сайт (server/site/seo.js):
// seo.base_url — строка, seo.title / seo.description — {uz,ru,en}.
// ---------------------------------------------------------------------------
function renderSeoTab(bodyEl) {
    const seo = branch('seo');
    for (const key of ['title', 'description']) {
        if (typeof seo[key] === 'string') seo[key] = { uz: seo[key], ru: seo[key], en: seo[key] };
        subBranch(seo, key);
    }
    const code = state.lang;

    const gUrl = h('div', { class: 'ws-serp-url' });
    const gTitle = h('div', { class: 'ws-serp-title' });
    const gDesc = h('div', { class: 'ws-serp-desc' });
    const paintSerp = () => {
        gUrl.textContent = (str(seo.base_url).trim().replace(/\/+$/, '') || 'https://clinic.uz') + '/' + code + '/';
        gTitle.textContent = str(seo.title[code]).trim() || str(((state.settings.hero || {})[code] || {}).title).trim() || tr('Название клиники');
        gDesc.textContent = str(seo.description[code]).trim() || tr('Описание клиники для поисковой выдачи.');
    };
    paintSerp();
    refs.onChanged = paintSerp;

    bodyEl.appendChild(card('Так сайт выглядит в поиске', 'Search',
        h('div', { class: 'ws-serp', 'data-ws-serp': '' }, gUrl, gTitle, gDesc),
        field('Заголовок в поиске (title)', textInput(seo.title, code)),
        field('Описание в поиске (description)', textArea(seo.description, code, 3)),
    ));
    bodyEl.appendChild(card('Адрес сайта', 'Link',
        field('Базовый адрес сайта', textInput(seo, 'base_url', { placeholder: 'https://clinic.uz' })),
        hint('Пока адрес не задан, sitemap.xml и канонические ссылки не формируются: без домена абсолютный адрес страницы построить не из чего.'),
    ));
    // Код аналитики вставляется на сайт как есть (тот же уровень доверия, что
    // «Карта на странице») — отсюда та же предупреждающая строка.
    const analytics = branch('analytics');
    bodyEl.appendChild(card('Аналитика', 'Chart',
        field('Код аналитики (HTML)', textArea(analytics, 'inject_snippet', 6)),
        hint('Вставляется на сайт как есть — только из доверенного источника. Политика безопасности сайта автоматически разрешает Google Tag Manager и Яндекс.Метрику; скрипты с других доменов будут заблокированы.'),
        hint('В живом просмотре код аналитики не запускается.'),
    ));
}

function validateSeo() {
    const base = str(branch('seo').base_url).trim();
    if (base && !/^https?:\/\//i.test(base)) return 'Базовый адрес должен начинаться с http:// или https://';
    return null;
}

// ---------------------------------------------------------------------------
// «Главная страница» / «О клинике» / «Правовые документы» — те же ветки settings,
// что читает сайт (server/site/render/home.js, static-pages.js). legal.privacy /
// legal.terms — «поле → язык» простой строкой, а не {title,body}.
// ---------------------------------------------------------------------------
function renderHomeTab(bodyEl) {
    const hero = branch('hero');
    const code = state.lang;
    const heroLang = subBranch(hero, code);
    const price = subBranch(hero, 'price');   // {from, amount}; «от» и валюту сайт подставляет сам
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

    bodyEl.appendChild(at(card('Первый экран', 'Sparkles',
        field('Строка над заголовком', textInput(subBranch(hero, 'kicker'), code)),
        field('Заголовок', textInput(heroLang, 'title')),
        field('Подзаголовок', textArea(heroLang, 'subtitle', 3)),
        h('div', { class: 'ws-grid2' },
            field('Цена в заголовке', amount),
            h('div', { class: 'ws-check-end' }, checkField('Показывать слово «от»', fromCb))),
        hint('Разряды и название валюты сайт расставит сам, на языке страницы. Пустое поле — строки на сайте нет вовсе.'),
    ), '/', '.home-hero'));

    const ctaRow = (key, title) => {
        const cta = subBranch(hero, key);
        return h('div', { class: 'ws-sub' }, h('div', { class: 'ws-label' }, title),
            h('div', { class: 'ws-grid2' },
                field('Подпись', textInput(subBranch(cta, 'label'), code)),
                field('Ссылка', textInput(cta, 'href', { placeholder: '/ru/services' }))));
    };
    bodyEl.appendChild(at(card('Кнопки', 'Target',
        field('Текст кнопки записи', textInput(heroLang, 'cta', { placeholder: 'Записаться' })),
        ctaRow('cta2', 'Вторая кнопка (с обводкой)'),
        ctaRow('cta3', 'Третья кнопка (мягкая)'),
        hint('Кнопка появляется на сайте, только когда заполнены и подпись, и ссылка. Годятся адрес внутри сайта («/ru/services»), полный адрес с https://, tel: и mailto:.'),
    ), '/', '.hero__actions'));

    bodyEl.appendChild(at(heroPhotosCard(hero), '/', '.home-hero'));
    bodyEl.appendChild(at(statsCard(code), '/', '.hero__stats'));
    // Chilla WHY_US_REMOVED_V1 — «Почему нас выбирают» сайт больше не рисует,
    // редактора нет; settings.why_us, если есть, остаётся в объекте нетронутым.
}

function renderAboutTab(bodyEl) {
    const about = subBranch(branch('about'), state.lang);
    bodyEl.appendChild(card('О клинике', 'Info',
        field('Заголовок', textInput(about, 'title')),
        field('Текст', textArea(about, 'body', 12))));
}

function renderLegalTab(bodyEl) {
    const legal = branch('legal');
    bodyEl.appendChild(at(card('Политика конфиденциальности', 'Shield',
        field('Текст', textArea(subBranch(legal, 'privacy'), state.lang, 10))), '/privacy'));
    bodyEl.appendChild(at(card('Условия использования', 'Doc',
        field('Текст', textArea(subBranch(legal, 'terms'), state.lang, 10)),
        hint('Пока текст не заполнен, посетитель видит заглушку страницы, помеченную noindex.')), '/terms'));
}

// Загрузка картинки в корзину сайта: расширение проверяется до отправки.
async function uploadWebsiteImage(file, prefix) {
    if (!IMAGE_EXT.test(String(file && file.name || ''))) {
        throw new Error(tr('На сайт загружаются только картинки JPG, PNG и WEBP.'));
    }
    const { path } = await uploadFile('website', file, prefix);
    return path;
}

async function uploadAll(files, prefix, take) {
    let ok = 0;
    for (const f of files) {
        try { take(await uploadWebsiteImage(f, prefix)); ok++; } catch (err) {
            toast(trf('Не удалось загрузить изображение. {reason}', { reason: errText(err) }), 'fail');
        }
    }
    if (ok) toast(tr('Изображение загружено'));
}

function photoTile(path, ...actions) {
    return h('div', { class: 'ws-photo' }, h('img', { src: publicUrl(path), alt: '' }),
        readOnly() ? null : h('div', { class: 'ws-photo-acts' }, ...actions));
}
function removeButton(onclick) {
    return h('button', { class: 'btn btn-ghost btn-sm ws-move', type: 'button', title: 'Убрать', 'aria-label': 'Убрать', onclick }, Icon('Trash', { size: 14 }));
}

function heroPhotoField(hero, key, label) {
    const box = h('div', { class: 'ws-sub' });
    const sync = () => {
        clear(box);
        box.appendChild(h('div', { class: 'ws-label' }, label));
        if (str(hero[key])) box.appendChild(photoTile(hero[key], removeButton(() => { hero[key] = ''; sync(); })));
        if (!readOnly()) {
            box.appendChild(uploadButton(str(hero[key]) ? 'Заменить' : 'Загрузить', {
                onFiles: (files) => uploadAll(files.slice(0, 1), 'hero/', (p) => { hero[key] = p; sync(); }) }));
        }
    };
    sync();
    return box;
}

// Chilla HERO_SLIDESHOW_V1 — список фото заголовка; пусто — работает пара img1/img2.
function heroPhotosCard(hero) {
    if (!Array.isArray(hero.photos)) hero.photos = [];
    const list = hero.photos;
    const listBody = h('div', { class: 'ws-photos' });
    const swap = (a, b) => () => { [list[a], list[b]] = [list[b], list[a]]; paintList(); };

    function paintList() {
        clear(listBody);
        if (!list.length) listBody.appendChild(h('div', { class: 'ws-empty' }, 'Фотографий нет — заголовок покажет то, что загружено ниже.'));
        list.forEach((path, idx) => listBody.appendChild(photoTile(path,
            moveButton(-1, idx === 0, swap(idx - 1, idx)),
            moveButton(1, idx === list.length - 1, swap(idx, idx + 1)),
            removeButton(() => { list.splice(idx, 1); paintList(); }))));
    }
    paintList();

    return card('Фотографии в заголовке', 'Image',
        listBody,
        readOnly() ? null : h('div', null, uploadButton('Добавить фотографии', { multiple: true, onFiles: async (files) => {
            await uploadAll(files, 'hero/', (p) => list.push(p));
            paintList();
        } })),
        hint('Две и больше — заголовок меняет их каждые 5 секунд; одна — стоит неподвижно. Порядок задаётся стрелками, первая показывается первой. Пока список пуст, работают два поля ниже (коллаж).'),
        h('div', { class: 'ws-grid2' },
            heroPhotoField(hero, 'img1', 'Переднее фото (если список пуст)'),
            heroPhotoField(hero, 'img2', 'Второе фото (коллаж)')),
    );
}

// Цифры на главной: [{value, label:{uz,ru,en}}]; уходят той же кнопкой «Сохранить».
function statsCard(code) {
    const stats = branchArray('stats');
    const listBody = h('div', { class: 'ws-list' });
    const swap = (a, b) => () => { [stats[a], stats[b]] = [stats[b], stats[a]]; paintList(); };

    function paintList() {
        clear(listBody);
        if (!stats.length) listBody.appendChild(h('div', { class: 'ws-empty' }, 'Пока ничего не добавлено.'));
        stats.forEach((st, idx) => {
            const label = subBranch(st, 'label');
            listBody.appendChild(h('div', { class: 'ws-stat' },
                field('Значение', textInput(st, 'value', { placeholder: '15+' })),
                field('Подпись', textInput(label, code)),
                readOnly() ? null : h('div', { class: 'row', style: { gap: '2px' } },
                    moveButton(-1, idx === 0, swap(idx - 1, idx)),
                    moveButton(1, idx === stats.length - 1, swap(idx, idx + 1)),
                    removeButton(() => { stats.splice(idx, 1); paintList(); }))));
        });
    }
    paintList();

    return card('Статистика (цифры на главной)', 'Chart', listBody,
        readOnly() ? null : h('div', null, h('button', { class: 'btn btn-outline btn-sm', type: 'button',
            onclick: () => { stats.push({ value: '', label: { uz: '', ru: '', en: '' } }); paintList(); } },
        Icon('Plus', { size: 14 }), ' ', 'Добавить')));
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

    const listBody = h('div', { class: 'ws-list' });
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
    bodyEl.appendChild(card(cfg.title, navItem(kind)[2],
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
        editBtn.addEventListener('click', () => openEditor('services', CONTENT_KINDS.services, { ...r }, r));
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
        class: 'ws-row', 'data-ws-row': String(r.id), 'data-ws-state': str(r.state),
        style: { opacity: isShown ? '1' : '0.62' },
    },
        kind === 'doctors' && r.photo_url
            ? h('img', { src: r.photo_url, alt: '', style: { width: '36px', height: '36px', borderRadius: '50%', objectFit: 'cover', flex: '0 0 auto' } })
            : null,
        h('div', { class: 'ws-row-main' },
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
    const listBody = h('div', { class: 'ws-list' });

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
    if (addBtn) addBtn.addEventListener('click', () => openEditor(kind, cfg, freshRow(cfg, null), null));

    bodyEl.appendChild(card(cfg.tabLabel, navItem(kind)[2],
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

    const listBody = h('div', { class: 'ws-list' });
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

    bodyEl.appendChild(card(cfg.tabLabel, navItem(kind)[2],
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
        type: 'checkbox', class: 'ws-switch', checked: published, title: 'На сайте', 'aria-label': 'На сайте',
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
    const editBtn = viewOrEditButton(() => openEditor(kind, cfg, freshOrOverlay(), pick));
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
        class: 'ws-row', 'data-ws-row': String(pick ? pick[cfg.fk] : overlay.id),
        style: { opacity: overlay ? '1' : '0.72' },
    },
        readOnly() ? null : publishCb,
        h('div', { class: 'ws-row-main' },
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
        type: 'checkbox', class: 'ws-switch', checked: !!row.published, title: 'На сайте', 'aria-label': 'На сайте',
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

    const editBtn = viewOrEditButton(() => openEditor(kind, cfg, { ...row }, null));
    const delBtn = readOnly() ? null : h('button', { class: 'btn btn-outline btn-sm', type: 'button' },
        Icon('Trash', { size: 13 }), ' ', 'Удалить');
    if (delBtn) delBtn.addEventListener('click', () => openDeleteConfirm(kind, row, name, reload));

    return h('div', { class: 'ws-row', 'data-ws-row': String(row.id) },
        readOnly() ? null : publishCb,
        h('div', { class: 'ws-row-main' },
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

// ---------------------------------------------------------------------------
// Редактор карточки — НА МЕСТЕ формы (WEBSITE_EDITOR_V2): раньше он был окном поверх
// экрана и закрывал сайт. Язык полей — общий язык экрана. На «Просмотре» поля серые.
// ---------------------------------------------------------------------------
const PREVIEW_PAGE = {
    services:    (d) => '/services/' + d.service_id,
    departments: (d) => '/departments/' + (d.slug || 'draft'),
    posts:       (d) => '/news/' + (d.slug || 'draft'),
    faq:         () => '/faq',
    testimonials: () => '/',
};
function previewRow() {
    const ed = state.editor;
    return ed ? { kind: ed.kind, row: ed.draft } : null;
}

function openEditor(kind, cfg, row, pick) {
    const draft = { ...row, content: { uz: {}, ru: {}, en: {} } };
    for (const lang of ['uz', 'ru', 'en']) {
        const src = row.content && row.content[lang];
        draft.content[lang] = (src && typeof src === 'object') ? { ...src } : {};
    }
    const title = (pick && (cfg.pickLabel ? cfg.pickLabel(pick) : (cfg.rowLabel && cfg.rowLabel(pick))))
        || (cfg.rowLabel && cfg.rowLabel(draft)) || contentName(draft.content) || '';
    state.editor = { kind, cfg, draft, title, initial: JSON.stringify(draft) };
    paint();
    showEditorPage();
    refs.preview.schedule();
}

function showEditorPage() {
    const { kind, draft } = state.editor;
    refs.preview.show(PREVIEW_PAGE[kind](draft), kind === 'testimonials' ? navItem('testimonials')[4] : null);
}

const closeEditor = () => leaveEditor(() => { paint(); showTabPage(); refs.preview.schedule(); });

function backButton(label) {
    return h('button', { class: 'btn btn-outline', type: 'button', dataset: { viewOk: '1' }, 'data-ws-back': '', onclick: closeEditor }, label);
}

function renderEditor(bodyEl) {
    const { kind, cfg, draft, title } = state.editor;
    const langObj = draft.content[state.lang];

    bodyEl.appendChild(h('button', { class: 'ws-back', type: 'button', onclick: closeEditor },
        Icon('ChevronLeft', { size: 16 }), h('span', null, cfg.tabLabel)));

    bodyEl.appendChild(h('div', { 'data-ws-editor': kind }, card(title || 'Новая запись', navItem(kind)[2],
        ...cfg.fields.map(([key, label, type]) => field(label, type === 'textarea' ? textArea(langObj, key, key === 'body' || key === 'a' ? 8 : 4) : textInput(langObj, key))),
        cfg.scalarFields.length ? h('div', { class: 'ws-grid2' }, ...cfg.scalarFields.map((sf) => {
            if (sf.type !== 'select') return field(sf.label, textInput(draft, sf.key, { placeholder: sf.placeholder }));
            return field(sf.label, h('select', {
                disabled: readOnly() ? true : null,
                onchange: (e) => { draft[sf.key] = e.target.value; },
            }, ...sf.options.map(([val, label]) => h('option', { value: val, selected: String(draft[sf.key]) === String(val) }, label))));
        })) : null)));

    if (cfg.photoField) {
        const box = h('div', { class: 'ws-sub' });
        const sync = () => {
            clear(box);
            const path = draft[cfg.photoField];
            if (path) box.appendChild(photoTile(path, removeButton(() => { draft[cfg.photoField] = ''; sync(); })));
            if (!readOnly()) {
                // Префикс от fk, у новостей — от id черновика или метки
                // времени: разные черновики не перезапишут друг друга.
                const prefix = cfg.fk ? `${kind}/${draft[cfg.fk]}-` : `${kind}/${draft.id || Date.now()}-`;
                box.appendChild(uploadButton(path ? 'Заменить' : 'Загрузить', {
                    onFiles: (files) => uploadAll(files.slice(0, 1), prefix, (p) => { draft[cfg.photoField] = p; sync(); }) }));
            }
        };
        sync();
        bodyEl.appendChild(card(cfg.imageLabel, 'Image', box, hint('Только JPG, PNG или WEBP.')));
    }
}

function paintEditorBar() {
    const ed = state.editor;
    const dirty = editorDirty();
    refs.bar.classList.toggle('is-dirty', dirty);
    refs.bar.appendChild(h('span', { class: 'ws-savebar-text', role: 'status', 'data-ws-dirty': dirty ? '1' : '0' },
        dirty ? 'Карточка изменена и ещё не сохранена' : 'Изменений в карточке нет'));
    refs.bar.appendChild(backButton(dirty ? 'Отмена' : 'Закрыть'));
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-ws-modal-save': '' }, Icon('Check', { size: 14 }), ' ', 'Сохранить');
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        const { kind, cfg, draft } = ed;
        try {
            // Только то, что форма правит: сервер не трогает неприсланное, и
            // карточка услуги не сбросит её «На главной» и порядок.
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
            if (state.editor !== ed) return;
            state.editor = null;
            paint();
            showTabPage();
        } catch (e) {
            toast(trf('Не удалось сохранить. {reason}', { reason: errText(e) }), 'fail');
            saveBtn.disabled = false;
        }
    });
    refs.bar.appendChild(saveBtn);
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
