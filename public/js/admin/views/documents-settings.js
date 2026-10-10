// «Компания» — DOCUMENTS_SETTINGS_V1 — сведения о самой клинике: название,
// адрес, телефон, почта, лицензия, логотип и фирменный цвет. Одна строка в
// `doc_settings` (id=1, засеяна миграцией 008): читать может любая роль,
// менять — только администратор, через /api/db
// (server/db/schema-registry.js). Из этой записи rpc/clinic.js собирает
// window.CLINIC, ею подписаны шапка приложения и каждая печатная форма.
//
// SETTINGS_SPLIT_V1 (2026-08-29, владелец: «in the company the company
// info») — экран был наполовину не про компанию. Вместе с реквизитами он
// редактировал НАСТРОЙКИ ПЕЧАТНОГО ШАБЛОНА: размер бумаги, водяной знак,
// нижний колонтитул и юридическую сноску, — и звался «Documents». Плитка
// «Компания» открывала экран с заголовком «Documents»; ровно та путаница, из-за
// которой владелец не мог найти, где меняется название клиники.
//
// Четыре поля шаблона убраны отсюда, и это ничего не сломало — проверено по
// коду перед удалением: `paper_size`, `show_watermark`, `footer_note` и
// `legal_note` из doc_settings НЕ ЧИТАЕТ никто. Печать берёт свои настройки из
// doc_branding (views/doc-settings.js: paperSize / showWatermark / footerNote /
// legalNote), который редактируется в «Документах» — это и есть их настоящее
// место, и там они живые. Здешние были вторым, мёртвым набором тех же
// переключателей: клиника меняла их и не видела разницы.
//
// Колонки НЕ удалены (миграции необратимы, а данные молча не выбрасывают) и
// сохраняются как есть: save() их просто не отправляет, поэтому то, что клиника
// когда-то ввела, остаётся в базе нетронутым.
//
// Это ДРУГАЯ функция, чем дизайнер шаблонов (views/documents.js +
// views/doc-settings.js, маршрут 'documents', таблица doc_branding): там шесть
// типов документов, варианты и предпросмотр печати. Здесь — одна запись о
// клинике. Маршрут 'documents-settings' (НЕ 'documents'), чтобы не столкнуться
// с тем экраном.
//
// CLINIC_PROFILE_V1 (2026-10-10, шаг 3 API клиники) — «Компания» стала
// профилем клиники для сайта, Symptex и партнёров: названия и описание на
// трёх языках, сайт, Telegram и Instagram. Документы печатают то же, что
// печатали: RU-название (clinic_name) и адрес, вписанный руками (address);
// сайт на бланках не печатается (ответы владельца 2026-10-10). Колонки,
// проверки и нормализация — общие с /api/db и синхронизацией зданий
// (shared/clinic-profile.js); поля на трёх языках — company-fields.js.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, field } from '../ui.js';
import { tr } from '../i18n.js';
import { phoneInput } from '../phone-input.js?v=ph1';
// CLINIC_API_FIX_V1 — тот же экземпляр модуля, что у admin.js (тот же ?v=).
import { refreshClinicBrand } from '../clinic-context.js?v=localclinic2';
// CLINIC_PROFILE_V1 — профиль клиники: колонки и проверки; поля на трёх языках.
import { COMPANY_COLUMNS, NAME_MAX, ABOUT_MAX, normalizeProfile, companyProblems } from '../../shared/clinic-profile.js';
import { triGroup, labeled } from './company-fields.js';
import { logosCard } from './company-logos.js';

// SETTINGS_SPLIT_V1 — paper_size/show_watermark/footer_note/legal_note остались
// в таблице, но не в этом объекте: DEFAULTS описывает то, чем управляет ЭТОТ
// экран, и лишнее поле здесь снова превратилось бы в поле формы.
// CLINIC_PROFILE_V1 — это ровно колонки «Компании» (COMPANY_COLUMNS): строки
// пустые («нет логотипа» — '': колонка NOT NULL), цвет — фирменный.
const DEFAULTS = Object.freeze(Object.fromEntries(
    COMPANY_COLUMNS.map((c) => [c, c === 'accent_color' ? '#167873' : ''])));

// CLINIC_PROFILE_V1 — ОДИН объект на экран: карточки (логотипы, адрес) держат
// ссылку на него, поэтому load() и save() меняют его содержимое (setState), а
// не подменяют объект — иначе карточка писала бы в устаревшую копию.
let state = { ...DEFAULTS };
function setState(values) {
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, DEFAULTS, values || {});
}
const refs = { container: null, previewEl: null, saveBtn: null, errNote: null, controls: null,
    // CLINIC_PROFILE_V1 — строки ошибок по колонкам; доступность списков адреса (задача 11).
    errs: {}, geoAvailability: () => ({}), logos: null };

export async function renderDocumentsSettings(container, { onNavigate } = {}) {
    refs.container = container;
    state = { ...DEFAULTS };
    mount(onNavigate);
    await load();
}

// -----------------------------------------------------------------------------
// MOUNT — static shell (back button, page head, two-column layout). load()
// fills in the real values once the fetch resolves.
// -----------------------------------------------------------------------------
function mount(onNavigate) {
    clear(refs.container);

    // APPBAR_BACK_V1 — своя кнопка «назад» убрана: путь назад теперь один и
    // живёт в верхней панели оболочки (admin.js PARENT_OF). Четыре экрана
    // рисовали её каждый по-своему, а тридцать не рисовали вовсе.

    refs.saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save },
        ...saveBtnContent());   // CLINIC_API_FIX_V1 — тем же строителем save() возвращает кнопку

    const formCard = h('div', { class: 'card' });
    buildForm(formCard);
    refs.errs = {};   // CLINIC_PROFILE_V1 — заполняют карточки ниже
    const linksCard = buildLinksCard();
    // CLINIC_PROFILE_V1 — два логотипа (company-logos.js); прежний логотип
    // «Реквизитов» ушёл в квадратную плитку.
    refs.logos = logosCard(state, { onChange: () => renderPreview() });

    refs.previewEl = h('div');
    const previewCard = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('ID', { size: 16 }), ' ', 'Как это выглядит')),
        h('div', { style: { padding: '18px' } }, refs.previewEl));

    refs.container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                // SETTINGS_SPLIT_V1 — заголовок наконец совпал с плиткой, из
                // которой сюда приходят. Раньше здесь стояло «Documents».
                h('h1', { class: 'page-title' }, 'Компания'),
                h('p', { class: 'page-subtitle' },
                    'Название, описание, адрес, логотипы, контакты и ссылки клиники. Эти данные видят пациенты на сайте клиники, в Symptex и у партнёров.'),
            ),
            h('div', { class: 'page-head-actions' }, refs.saveBtn),
        ),
        // CLINIC_PROFILE_V1 — слева карточки профиля стопкой, справа
        // предпросмотры; на узком экране — один столбец (flexWrap). Ширину
        // правой колонки на широком экране держит CSS (.cpf-side).
        h('div', { class: 'row', style: { gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('div', { class: 'col cpf-main', style: { minWidth: 'min(320px, 100%)', flex: '3 1 480px' } },
                h('div', { class: 'cpf-stack' }, formCard, refs.logos.node, linksCard)),
            h('div', { class: 'col cpf-side', style: { minWidth: 'min(320px, 100%)', flex: '1 1 320px' } },
                h('div', { class: 'cpf-stack' }, previewCard)),
        ),
    ));

    renderPreview();
}

// -----------------------------------------------------------------------------
// FORM — every control writes straight into `state` and repaints the preview.
// -----------------------------------------------------------------------------
function buildForm(card) {
    const onText = (key) => (e) => { state[key] = e.target.value; renderPreview(); };

    // CLINIC_PROFILE_V1 — название и описание на трёх языках. RU-название —
    // clinic_name: его печатают документы и показывает строка под меню.
    const names = triGroup('Название клиники', null, {
        key: 'name', cellLabel: 'Название', max: NAME_MAX,
        hint: 'RU печатается на документах. UZ и EN видят партнёры и программа на узбекском и английском.',
        onInput: (l, v) => { state[l === 'ru' ? 'clinic_name' : 'name_' + l] = v; renderPreview(); },
    });
    const about = triGroup('Коротко о клинике', null, {
        key: 'about', cellLabel: 'Описание', textarea: true, max: ABOUT_MAX,
        hint: 'Два-три предложения: чем клиника занимается. Партнёры показывают это под названием.',
        onInput: (l, v) => { state['about_' + l] = v; renderPreview(); },
    });
    const addressInp = h('input', { type: 'text', oninput: onText('address') });
    // PHONE_INPUT_V1 — country control; read its .value (not e.target.value,
    // which would be the raw inner field including a bare «+998»).
    const phoneInp   = phoneInput('phone', '+998 71 200 12 00');
    phoneInp.addEventListener('input', () => { state.phone = phoneInp.value; renderPreview(); });
    const emailInp   = h('input', { type: 'text', oninput: onText('email') });
    const licenseInp = h('input', { type: 'text', oninput: onText('license') });
    const accentInp  = h('input', { type: 'color', oninput: onText('accent_color') });

    refs.controls = { names, about, addressInp, phoneInp, emailInp, licenseInp, accentInp };
    refs.errNote = h('div', { class: 'empty', style: { display: 'none', margin: '0 16px 12px' } },
        'Не удалось загрузить данные компании — показаны значения по умолчанию.');

    card.appendChild(h('div', { class: 'card-header' }, h('h3', null, Icon('Building', { size: 16 }), ' ', 'Реквизиты клиники')));
    card.appendChild(refs.errNote);
    card.appendChild(h('div', { class: 'cpf-body' },
        names.node,
        about.node,
        h('div', { class: 'cpf-grid' },
            field('Адрес', addressInp),
            h('div', null, field('Телефон', phoneInp), h('p', { class: 'cpf-hint' }, 'У пациентов это кнопка «Позвонить».')),
            field('Электронная почта', emailInp),
            field('Номер лицензии', licenseInp),
            field('Фирменный цвет', accentInp)),
        // SETTINGS_SPLIT_V1 — сказано ровно один раз и там, где раньше стояли
        // переехавшие переключатели: иначе администратор, помнящий «размер
        // бумаги» на этом экране, решит, что настройка пропала.
        h('p', { class: 'muted', style: { fontSize: '12.5px', margin: 0 } },
            'Размер бумаги, водяной знак и подписи внизу документов настраиваются в разделе «Документы».'),
    ));
}

// CLINIC_PROFILE_V1 — «Сайт и соцсети». Хранится нормализованным (save():
// normalizeProfile): сайт — https://…, Telegram и Instagram — @имя; вставленная
// ссылка урезается до имени. На бланках ничего из этого не печатается (ответ
// владельца 2026-10-10) — только API, партнёры и предпросмотр.
const LINK_FIELDS = [
    { key: 'website', label: 'Сайт', icon: 'Globe', ph: 'https://klinika.uz', mode: 'url',
        hint: 'Можно без https:// — допишем сами.' },
    { key: 'telegram_bot', label: 'Telegram-бот', icon: 'Bot', ph: '@klinika_bot',
        hint: 'Бот для записи и вопросов пациентов. Имя заканчивается на bot.' },
    { key: 'telegram_channel', label: 'Telegram-канал', icon: 'Send', ph: '@klinika',
        hint: 'Новости и акции клиники.' },
    { key: 'instagram', label: 'Instagram', icon: 'Camera', ph: '@klinika',
        hint: 'Можно вставить ссылку — оставим только имя.' },
];
function buildLinksCard() {
    refs.links = {};
    const grid = h('div', { class: 'cpf-grid' });
    for (const f of LINK_FIELDS) {
        const ctrl = h('input', { type: 'text', placeholder: f.ph, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: f.mode || null });
        const box = labeled(f.label, ctrl, { key: f.key, hint: f.hint, prefix: Icon(f.icon, { size: 15 }) });
        ctrl.addEventListener('input', () => { state[f.key] = ctrl.value; box.err.set(''); renderPreview(); });
        refs.links[f.key] = box;
        refs.errs[f.key] = box.err;
        grid.appendChild(box.node);
    }
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Globe', { size: 16 }), ' ', 'Сайт и соцсети')),
        h('div', { class: 'cpf-body' },
            h('p', { class: 'cpf-hint' }, 'Ссылки получают сайт клиники, Symptex и партнёры. На бланках они не печатаются.'),
            grid));
}

// Push the loaded/saved `state` values into the live form controls (DOM
// property assignment — h() only sets initial attributes at creation time).
function applyStateToControls() {
    const c = refs.controls;
    c.names.set({ ru: state.clinic_name, uz: state.name_uz, en: state.name_en });   // CLINIC_PROFILE_V1
    c.about.set({ ru: state.about_ru, uz: state.about_uz, en: state.about_en });
    c.addressInp.value = state.address || '';
    c.phoneInp.value   = state.phone || '';
    c.emailInp.value   = state.email || '';
    c.licenseInp.value = state.license || '';
    c.accentInp.value  = state.accent_color || '#167873';
    for (const [k, box] of Object.entries(refs.links || {})) box.ctrl.value = state[k] || '';
    if (refs.logos) refs.logos.paint();   // CLINIC_PROFILE_V1 — плитки логотипов по загруженной строке
}

// CLINIC_PROFILE_V1 — объяснение под каждым полем с ошибкой; поле без ошибки — чистое.
function showProblems(problems) {
    for (const [k, err] of Object.entries(refs.errs)) err.set(problems[k] || '');
}

// CLINIC_PROFILE_V1 — прежний единственный логотип (resizeImageToDataUrl /
// onLogoPick / removeLogo / paintThumb) ушёл: его место — квадратная плитка
// «Логотипов» (company-logos.js). Печатная копия (logo_data_url) делается там
// же и в тех же пределах — 220 px, не больше 90 000 знаков.

// -----------------------------------------------------------------------------
// LOAD / SAVE
// -----------------------------------------------------------------------------
async function load() {
    try {
        const { data, error } = await supabase.from('doc_settings').select('*').eq('id', 1).single();
        if (error) throw error;
        setState(data);   // CLINIC_PROFILE_V1 — тот же объект (карточки держат ссылку)
        if (refs.errNote) refs.errNote.style.display = 'none';
    } catch (e) {
        // tr() on the fixed sentence, the server's own message appended raw —
        // the convention every RPC-facing screen here follows (activation.js,
        // system-backups.js): a message built by concatenation would never be
        // translatable at all.
        toast(tr('Не удалось загрузить данные компании.') + ' ' + ((e && e.message) || e), 'fail');
        setState(null);
        if (refs.errNote) refs.errNote.style.display = '';
    }
    applyStateToControls();
    renderPreview();
}

// CLINIC_API_FIX_V1 — содержимое кнопки «Сохранить»: значок и подпись. Одним
// строителем кнопку рисует mount() и возвращает save() после записи. Раньше
// save() возвращал подпись через textContent — значок пропадал до F5.
function saveBtnContent() {
    return [Icon('Check', { size: 14 }), document.createTextNode(' '), document.createTextNode(tr('Сохранить'))];
}
function paintSaveBtn(btn, busy) {
    clear(btn);
    for (const n of busy ? [document.createTextNode(tr('Сохранение…'))] : saveBtnContent()) btn.appendChild(n);
}

async function save() {
    const btn = refs.saveBtn;   // CLINIC_API_FIX_V1 — та же кнопка, что гасили, даже если экран перерисуют
    // CLINIC_PROFILE_V1 — сначала привести (https://, @имя, пробелы) и проверить
    // теми же правилами, что знает сервер (shared/clinic-profile.js). Ошибка —
    // объяснение под полем и тост; запрос не уходит.
    const v = normalizeProfile(state);
    const problems = companyProblems(v, refs.geoAvailability());
    showProblems(problems);
    if (Object.keys(problems).length) { toast(tr('Проверьте выделенные поля.'), 'fail'); return; }
    btn.disabled = true;
    paintSaveBtn(btn, true);
    try {
        // SETTINGS_SPLIT_V1 — ровно те поля, которыми управляет этот экран.
        // paper_size / show_watermark / footer_note / legal_note НЕ шлются
        // намеренно: /api/db обновляет только перечисленные колонки, поэтому
        // то, что клиника ввела в них раньше, остаётся в базе нетронутым, а не
        // затирается значениями по умолчанию из отсутствующей формы.
        // CLINIC_PROFILE_V1 — «эти поля» теперь COMPANY_COLUMNS; lab_scope
        // среди них нет (его меняет только администратор, в другом месте).
        const payload = {};
        for (const c of COMPANY_COLUMNS) payload[c] = v[c] == null ? DEFAULTS[c] : v[c];
        payload.logo_data_url = v.logo_data_url || '';    // null отклоняет база (NOT NULL)
        payload.accent_color = v.accent_color || '#167873';
        const { data, error } = await supabase.from('doc_settings').update(payload).eq('id', 1).select().single();
        if (error) throw error;
        setState(data || payload);
        applyStateToControls();
        renderPreview();
        toast(tr('Сохранено'), 'ok');
        // CLINIC_API_FIX_V1 — новое название сразу под меню и в window.CLINIC
        // (по нему печатаются документы), без F5. Сбой перечитывания
        // сохранение не отменяет: оно уже прошло.
        await refreshClinicBrand(supabase).catch(() => {});
    } catch (e) {
        toast((e && e.message) || tr('Не удалось сохранить.'), 'fail');
    } finally {
        btn.disabled = false;
        paintSaveBtn(btn, false);   // CLINIC_API_FIX_V1 — значок и подпись, как были
    }
}

// -----------------------------------------------------------------------------
// PREVIEW — how the clinic's own identity looks: logo, name, contacts, accent
// rule. Updates live as the form changes.
//
// SETTINGS_SPLIT_V1 — it used to be a mock DOCUMENT: a «Medical Certificate»
// heading, «Patient: ____» sample lines, and the footer/legal notes printed at
// the bottom. Those went with the settings that produced them — a sample of a
// printed form belongs on «Документы», where the template is actually edited,
// and showing a footer note here with no field to change it would be a control
// the screen displays but cannot operate.
//
// All clinic-supplied strings go through h()'s textContent path — never
// innerHTML.
// -----------------------------------------------------------------------------
function renderPreview() {
    if (!refs.previewEl) return;
    clear(refs.previewEl);

    const accent = state.accent_color || '#167873';
    const contactBits = [state.address, state.phone, state.email, state.license].filter(Boolean);

    const logoEl = state.logo_data_url
        ? h('img', { src: state.logo_data_url, style: { maxHeight: '48px', maxWidth: '150px', objectFit: 'contain', flex: '0 0 auto' } })
        : h('div', { style: { width: '40px', height: '40px', borderRadius: '9px', background: accent, flex: '0 0 40px' } });

    const headerRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', position: 'relative' } },
        logoEl,
        h('div', { style: { flex: '1', minWidth: 0 } },
            h('div', { style: { fontWeight: '700', fontSize: '17px', color: accent } }, state.clinic_name || 'Название клиники'),
            contactBits.length
                ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, contactBits.join(' · '))
                : null,
        ));

    const rule = h('div', { style: { borderTop: `2px solid ${accent}`, margin: '14px 0 4px' } });

    refs.previewEl.appendChild(h('div', {
        style: {
            position: 'relative', overflow: 'hidden',
            background: '#fff', border: '1px solid var(--ink-100)', borderRadius: '10px',
            boxShadow: '0 4px 18px rgba(11,20,24,0.08)', padding: '24px', maxWidth: '460px', margin: '0 auto',
        },
    }, headerRow, rule));

    refs.previewEl.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '12px', textAlign: 'center' } },
        'Так клиника подписана в шапке программы и во всех печатных документах.'));
}
