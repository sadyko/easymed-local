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
// трёх языках, сайт, Telegram и Instagram (здесь), адрес для партнёров и
// сайта списками справочника, карта и маршрут (company-address.js), два
// логотипа (company-logos.js). Документы печатают то же, что печатали:
// RU-название (clinic_name) и «Адрес в документах» (address), вписанный
// руками, — списки его не меняют; сайт на бланках не печатается (ответы
// владельца 2026-10-10). Колонки, проверки и нормализация — общие с /api/db и
// синхронизацией зданий (shared/clinic-profile.js); поля на трёх языках —
// company-fields.js.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, field } from '../ui.js';
import { tr } from '../i18n.js';
import { phoneInput } from '../phone-input.js?v=ph1';
// CLINIC_API_FIX_V1 — тот же экземпляр модуля, что у admin.js (тот же ?v=).
import { refreshClinicBrand } from '../clinic-context.js?v=localclinic2';
// CLINIC_PROFILE_V1 — профиль клиники: колонки и проверки; поля на трёх языках.
import { COMPANY_COLUMNS, NAME_MAX, ABOUT_MAX, normalizeProfile, companyProblems } from '../../shared/clinic-profile.js';
import { COMPANY_PRINT, COMPANY_PARTNER } from '../../shared/clinic-profile.js';   // BRANCH_PROFILE_V1 — филиал сохраняет только своё для документов
import { PHONE_MAX } from '../../shared/branch-profile.js';   // BRANCH_PROFILE_V1 (ревью шага 4, #3) — тот же предел, что у сервера
import { partnerAddressProblems } from '../../shared/clinic-profile.js';   // CLINIC_API_STEP7_V1 — решение владельца 11
import { triGroup, labeled } from './company-fields.js';
import { logosCard } from './company-logos.js';
import { addressCard, mapCard } from './company-address.js';
import { patientPreview } from './company-preview.js';
import { logoSrc } from './company-logos.js';

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
    // CLINIC_PROFILE_V1 — строки ошибок по колонкам; доступность списков адреса;
    // «Как это увидят пациенты» и его язык (не язык интерфейса).
    errs: {}, geoAvailability: () => ({}), logos: null, address: null, map: null,
    patientEl: null, langBtns: null, previewLang: 'ru',
    // CLINIC_PROFILE_V1 (ревью C1) — что прочитано из базы (снимок для сравнения)
    // и удалось ли прочитать вообще.
    loaded: null, loadFailed: false,
    building: {} };   // BRANCH_PROFILE_V1 — своя строка branches в филиале

// CLINIC_PROFILE_V1 (ревью C1) — СОХРАНЯЕТСЯ ТОЛЬКО ИЗМЕНЁННОЕ.
//
// Строка не прочиталась (сервер перезапускается, сеть) — экран показывает
// значения по умолчанию, и «Сохранить» записало бы их поверх всей «Компании»:
// названия, адрес для бланков, телефон, лицензию, печатную копию логотипа,
// пути логотипов, ссылки. Синхронизация зданий унесла бы это во все филиалы.
// До шага 3 такое сохранение случайно спасал отказ базы на null в логотипе;
// задача 1 этот отказ убрала. Теперь два замка:
//   1) строка не прочиталась — «Сохранить» выключено, объяснение вверху;
//   2) уходят только колонки, которые отличаются от прочитанной строки
//      (снимок refs.loaded): нетронутое поле не может быть затёрто ничем.
// Значения сравниваются после тех же приведений, что и при записи.
const ERR_LOAD = 'Не удалось загрузить данные компании — обновите страницу, чтобы сохранить.';
const ADDRESS_COLUMNS = ['country_code', 'region_code', 'district_code', 'street_ru', 'street_uz', 'street_en'];
function valuesOf(src) {
    const v = normalizeProfile(src);
    const out = {};
    for (const c of COMPANY_COLUMNS) out[c] = v[c] == null ? DEFAULTS[c] : v[c];
    out.logo_data_url = v.logo_data_url || '';    // null отклоняет база (NOT NULL)
    out.accent_color = v.accent_color || '#167873';
    return out;
}
function changedValues(columns) {
    const now = valuesOf(state);
    const was = refs.loaded || {};
    const out = {};
    for (const c of columns) if (String(now[c]) !== String(was[c] == null ? '' : was[c])) out[c] = now[c];
    return out;
}
function paintLoadFailed() {
    const btn = refs.saveBtn;
    if (btn) {
        btn.disabled = !!refs.loadFailed;
        if (refs.loadFailed) btn.setAttribute('disabled', ''); else if (typeof btn.removeAttribute === 'function') btn.removeAttribute('disabled');
    }
    if (refs.errNote) refs.errNote.style.display = refs.loadFailed ? '' : 'none';
}

// CLINIC_PROFILE_V1 — «КОМПАНИЯ» В ФИЛИАЛЕ. Общее для клиники (названия,
// описание, логотипы, сайт и соцсети, лицензия, цвет — COMPANY_CLINIC_WIDE)
// приезжает из главного здания (branch-sync/catalogue.js), и /api/db
// отказывает его правке 409. Поэтому здесь эти поля только видны, вверху —
// объяснение, а «Сохранить» шлёт ровно своё у здания для документов
// (COMPANY_PRINT): адрес для бланков, телефон, почту.
// BRANCH_PROFILE_V1 — адрес для партнёров, карту и телефон для сайта филиала
// ведёт главное здание в «Филиалах» (одно место на здание): здесь они только
// видны — из своей строки branches, которая приезжает со списком сети.
const COMPANY_MAIN_ONLY = 'Название, описание, логотипы, сайт и соцсети, лицензия и фирменный цвет меняются в главном здании. Здесь — адрес, телефон и почта для документов этого здания.';   // BRANCH_PROFILE_V1
let secondary = false;
const isSecondaryBuilding = () => !!(typeof window !== 'undefined' && window.CLINIC && window.CLINIC.building_role === 'secondary');
// CLINIC_API_STEP7_V1 — решение владельца 11: пока включено хоть одно подключение
// API, адрес для партнёров обязателен. Флаг приходит с сервера (rpc/clinic.js)
// при входе; страница «API и подключения» обновляет его после каждого изменения.
const apiAddressRequired = () => !!(typeof window !== 'undefined' && window.CLINIC && window.CLINIC.api_address_required);

export async function renderDocumentsSettings(container, { onNavigate } = {}) {
    refs.container = container;
    secondary = isSecondaryBuilding();   // CLINIC_PROFILE_V1
    refs.loaded = null;                  // CLINIC_PROFILE_V1 (ревью C1)
    refs.loadFailed = false;
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
    refs.logos = logosCard(state, { onChange: () => renderPreview(), disabled: secondary });   // CLINIC_PROFILE_V1 — в филиале логотипы главного здания
    // CLINIC_PROFILE_V1 — адрес для партнёров и сайта (списки справочника,
    // улица RU / UZ / EN) и карта с маршрутом — company-address.js. Адрес на
    // бланках — «Адрес в документах» в «Реквизитах»: списки его не меняют.
    // BRANCH_PROFILE_V1 — в филиале адрес для партнёров, карту и телефон для
    // сайта ведёт главное здание в «Филиалах» (одно место на здание): карточки
    // показывают СВОЮ строку branches (приезжает со списком сети), только видно.
    const partner = secondary ? refs.building : state;
    refs.address = addressCard(partner, { onChange: () => renderPreview(), secondary, disabled: secondary,   // CLINIC_PROFILE_V1 — «Адрес этого здания» в филиале
        // CLINIC_API_STEP7_V1 — звёздочки решения владельца 11: только главное здание (в филиале поля только видны и не обязательны, ревью №8)
        required: apiAddressRequired() && !secondary,
        hint: secondary ? 'Адрес для партнёров, карту и телефон для сайта этого здания ведёт главное здание в «Филиалах». Здесь они только видны.' : '' });
    // Ревью шага 4, находка 10 — запертая карта филиала не просит вставить ссылку.
    refs.map = mapCard(partner, secondary
        ? { onChange: () => renderPreview(), disabled: true, label: 'Ссылка на это здание в Яндекс Картах',
            hint: 'Ссылку на карту этого здания ведёт главное здание в «Филиалах».' }
        : { onChange: () => renderPreview(), disabled: false });
    // Ревью 9 — своя строка branches не прочиталась: объяснение над адресом.
    refs.buildingNote = secondary ? h('div', { class: 'cpf-note brf-note-warn', role: 'alert', style: { display: 'none' } },
        Icon('Warning', { size: 16 }), h('span', null, ERR_BUILDING)) : null;
    Object.assign(refs.errs, refs.address.errs, { maps_url: refs.map.err });
    refs.geoAvailability = () => refs.address.availability();

    refs.previewEl = h('div');
    const previewCard = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('ID', { size: 16 }), ' ', 'Как это выглядит в документах')),
        h('div', { style: { padding: '18px' } }, refs.previewEl));

    // CLINIC_PROFILE_V1 — «Как это увидят пациенты»: RU / UZ / EN — язык
    // ПРЕДПРОСМОТРА (так покажут сайт и партнёры), а не интерфейса.
    refs.patientEl = h('div');
    refs.langBtns = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Язык' },
        ...[['ru', 'RU'], ['uz', 'UZ'], ['en', 'EN']].map(([code, tag]) => {
            const b = h('button', { type: 'button', dataset: { lang: code },
                onclick: () => { refs.previewLang = code; paintLangBtns(); renderPreview(); } }, document.createTextNode(tag));
            return b;
        }));
    paintLangBtns();
    const patientCard = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Image', { size: 16 }), ' ', 'Как это увидят пациенты'), refs.langBtns),
        h('div', { class: 'cpf-body' }, refs.patientEl,
            h('p', { class: 'cpf-hint' }, 'Так данные клиники выглядят на сайте клиники, в Symptex и у партнёров. Каждый показывает их в своём стиле, данные одинаковые.')));

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
        // CLINIC_PROFILE_V1 — филиал: строка-объяснение первой (вид — как
        // «Мой профиль» врача из главного здания, doctor-profile.js).
        secondary ? h('div', {
            class: 'docprof-managed', role: 'note',
            style: {
                display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px',
                padding: '9px 12px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5,
                background: 'var(--ink-25, #f6f8f9)', border: '1px solid var(--ink-100)', color: 'var(--ink-600)',
            },
        }, Icon('Building', { size: 15 }), h('span', null, COMPANY_MAIN_ONLY)) : null,
        // CLINIC_PROFILE_V1 — слева карточки профиля стопкой, справа
        // предпросмотры; на узком экране — один столбец (flexWrap). Ширину
        // правой колонки на широком экране держит CSS (.cpf-side).
        h('div', { class: 'row', style: { gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('div', { class: 'col cpf-main', style: { minWidth: 'min(320px, 100%)', flex: '3 1 480px' } },
                h('div', { class: 'cpf-stack' }, formCard, refs.buildingNote, refs.address.node, refs.logos.node, linksCard, refs.map.node)),   // BRANCH_PROFILE_V1 (ревью 9) — объяснение над адресом
            h('div', { class: 'col cpf-side', style: { minWidth: 'min(320px, 100%)', flex: '1 1 320px' } },
                h('div', { class: 'cpf-stack' }, patientCard, previewCard)),
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
        key: 'name', cellLabel: 'Название', max: NAME_MAX, disabled: secondary,   // CLINIC_PROFILE_V1 — филиал: из главного здания
        markMissing: true,   // CLINIC_PROFILE_V1 (полировка по макету) — «нет перевода» у пустых UZ / EN
        hint: 'RU печатается на документах. UZ и EN видят партнёры и программа на узбекском и английском.',
        onInput: (l, v) => { state[l === 'ru' ? 'clinic_name' : 'name_' + l] = v; renderPreview(); },
    });
    const about = triGroup('Коротко о клинике', null, {
        key: 'about', cellLabel: 'Описание', textarea: true, max: ABOUT_MAX, disabled: secondary,   // CLINIC_PROFILE_V1
        markMissing: true,   // CLINIC_PROFILE_V1 (полировка по макету)
        hint: 'Два-три предложения: чем клиника занимается. Партнёры показывают это под названием.',
        onInput: (l, v) => { state['about_' + l] = v; renderPreview(); },
    });
    // CLINIC_PROFILE_V1 — адрес, который ПЕЧАТАЕТСЯ: вписан руками, как
    // сегодня (ответ владельца 2026-10-10, вариант B). Списки «Адреса для
    // партнёров и сайта» его не трогают — подпись говорит это прямо.
    const addressInp = h('input', { type: 'text', autocomplete: 'off', oninput: onText('address') });
    const addressBox = labeled('Адрес в документах', addressInp, {
        key: 'address',
        hint: 'Так адрес печатается на бланках — впишите его так, как он должен стоять в документах. Адрес для партнёров и сайта выбирается ниже, из списков.',
    });
    // PHONE_INPUT_V1 — country control; read its .value (not e.target.value,
    // which would be the raw inner field including a bare «+998»).
    const phoneInp   = phoneInput('phone', '+998 71 200 12 00');
    phoneInp.input.setAttribute('maxlength', String(PHONE_MAX));   // BRANCH_PROFILE_V1 (ревью шага 4, #3) — предел виден полю, а не только серверу
    phoneInp.addEventListener('input', () => { state.phone = phoneInp.value; renderPreview(); });
    const emailInp   = h('input', { type: 'text', oninput: onText('email') });
    const licenseInp = h('input', { type: 'text', oninput: onText('license'), disabled: secondary });   // CLINIC_PROFILE_V1 — филиал: из главного здания
    const accentInp  = h('input', { type: 'color', oninput: onText('accent_color'), disabled: secondary });

    refs.controls = { names, about, addressInp, phoneInp, emailInp, licenseInp, accentInp };
    // CLINIC_PROFILE_V1 (ревью C1) — строка не прочиталась: сохранять нечего и
    // опасно (значения по умолчанию затёрли бы «Компанию»), «Сохранить» выключено.
    refs.errNote = h('div', { class: 'empty', role: 'alert', style: { display: 'none', margin: '0 16px 12px' } }, ERR_LOAD);

    card.appendChild(h('div', { class: 'card-header' }, h('h3', null, Icon('Building', { size: 16 }), ' ', 'Реквизиты клиники')));
    card.appendChild(refs.errNote);
    card.appendChild(h('div', { class: 'cpf-body' },
        names.node,
        about.node,
        addressBox.node,
        h('div', { class: 'cpf-grid' },
            h('div', null, field('Телефон', phoneInp), h('p', { class: 'cpf-hint' },
                secondary ? 'Печатается на документах этого здания. Сайт и партнёры получают телефон из «Филиалов» главного здания.' : 'У пациентов это кнопка «Позвонить».')),   // BRANCH_PROFILE_V1
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
        const ctrl = h('input', { type: 'text', placeholder: f.ph, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: f.mode || null,
            disabled: secondary });   // CLINIC_PROFILE_V1 — филиал: ссылки клиники — из главного здания
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
    if (refs.address) refs.address.paint();   // улица и полный адрес (коды — load())
    if (refs.map) refs.map.load();
}

// CLINIC_PROFILE_V1 — объяснение под каждым полем с ошибкой; поле без ошибки — чистое.
// Полировка по макету: focus — неудачное сохранение; экран прокручивается к
// ПЕРВОМУ неверному полю в порядке экрана (FIELD_ORDER) и ставит на него
// фокус. Иначе человек видел только тост, а поле могло быть ниже края.
const FIELD_ORDER = [
    // «Реквизиты клиники» → «Адрес для партнёров и сайта» → «Сайт и соцсети» → «Карта и маршрут»
    'clinic_name', 'name_uz', 'name_en', 'about_ru', 'about_uz', 'about_en', 'address', 'phone', 'email', 'license',
    'country_code', 'region_code', 'district_code', 'street_ru', 'street_uz', 'street_en',
    'website', 'telegram_bot', 'telegram_channel', 'instagram', 'maps_url',
];
function showProblems(problems, { focus = false } = {}) {
    for (const [k, err] of Object.entries(refs.errs)) err.set(problems[k] || '');
    if (!focus) return;
    const bad = (k) => !!(problems[k] && refs.errs[k] && refs.errs[k].ctrl);
    const first = FIELD_ORDER.find(bad) || Object.keys(problems).find(bad);
    if (first) focusField(refs.errs[first].ctrl);
}
function focusField(ctrl) {
    const calm = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try { ctrl.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' }); } catch (_) { /* старый браузер */ }
    try { ctrl.focus({ preventScroll: true }); } catch (_) { /* поле исчезло */ }
}

// CLINIC_PROFILE_V1 — прежний единственный логотип (resizeImageToDataUrl /
// onLogoPick / removeLogo / paintThumb) ушёл: его место — квадратная плитка
// «Логотипов» (company-logos.js). Печатная копия (logo_data_url) делается там
// же и в тех же пределах — 220 px, не больше 90 000 знаков.

// -----------------------------------------------------------------------------
// LOAD / SAVE
// -----------------------------------------------------------------------------
async function load() {
    // CLINIC_API_STEP7_V1 (ревью №9) — флаг «адрес для партнёров обязателен» мог
    // устареть (подключение включили или выключили в другом окне): перечитать
    // window.CLINIC при каждом открытии, вместе со строкой doc_settings.
    const flagFresh = refreshClinicBrand(supabase).catch(() => null);
    try {
        const { data, error } = await supabase.from('doc_settings').select('*').eq('id', 1).single();
        if (error) throw error;
        setState(data);   // CLINIC_PROFILE_V1 — тот же объект (карточки держат ссылку)
        refs.loaded = valuesOf(state);   // CLINIC_PROFILE_V1 (ревью C1) — снимок прочитанного
        refs.loadFailed = false;
    } catch (e) {
        // tr() on the fixed sentence, the server's own message appended raw —
        // the convention every RPC-facing screen here follows (activation.js,
        // system-backups.js): a message built by concatenation would never be
        // translatable at all.
        toast(tr('Не удалось загрузить данные компании.') + ' ' + ((e && e.message) || e), 'fail');
        setState(null);
        refs.loaded = null;
        refs.loadFailed = true;   // CLINIC_PROFILE_V1 (ревью C1) — сохранять нечем: выключено
    }
    await flagFresh;
    if (secondary) await loadBuilding();   // BRANCH_PROFILE_V1
    if (refs.address) refs.address.setRequired(apiAddressRequired() && !secondary);   // CLINIC_API_STEP7_V1 (ревью №9)
    paintLoadFailed();
    applyStateToControls();
    // CLINIC_PROFILE_V1 — списки адреса грузятся один раз, уже с сохранёнными
    // кодами: каскад выбирает их только из пресета, заданного до прихода списков.
    if (refs.address) refs.address.load();
    renderPreview();
}

// BRANCH_PROFILE_V1 — своя строка branches (window.CLINIC.own_branch_id). Тот же
// объект, что держат карточки адреса и карты, — меняется на месте. Не
// прочиталась — карточки пустые; править их здесь всё равно нельзя, и в
// сохранение они не входят. Ревью шага 4, находка 9 — пустота объяснена:
// тост и строка над адресом.
const ERR_BUILDING = 'Не удалось загрузить адрес, карту и телефон этого здания из «Филиалов» — обновите страницу.';
async function loadBuilding() {
    for (const k of Object.keys(refs.building)) delete refs.building[k];
    const id = typeof window !== 'undefined' && window.CLINIC ? window.CLINIC.own_branch_id : null;
    let failed = false;
    if (id != null) {
        try {
            const { data, error } = await supabase.from('branches').select('*').eq('id', id).maybeSingle();
            if (error) throw error;
            if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(refs.building, data);
        } catch (e) {
            failed = true;
            toast(tr(ERR_BUILDING) + ' ' + tr((e && e.message) || ''), 'fail');
        }
    }
    if (refs.buildingNote) refs.buildingNote.style.display = failed ? '' : 'none';
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
    // CLINIC_PROFILE_V1 (ревью C1) — строка не прочиталась: не сохранять ничего
    // (кнопка выключена; это — на случай, если нажатие всё же дошло).
    if (refs.loadFailed || !refs.loaded) { toast(tr(ERR_LOAD), 'fail'); return; }
    // SETTINGS_SPLIT_V1 — ровно те поля, которыми управляет этот экран.
    // paper_size / show_watermark / footer_note / legal_note НЕ шлются
    // намеренно: /api/db обновляет только перечисленные колонки, поэтому
    // то, что клиника ввела в них раньше, остаётся в базе нетронутым, а не
    // затирается значениями по умолчанию из отсутствующей формы.
    // CLINIC_PROFILE_V1 — «эти поля» теперь COMPANY_COLUMNS (lab_scope среди
    // них нет — его меняет только администратор, в другом месте); филиал шлёт
    // только своё у здания (общее приезжает из главного, /api/db отказал бы
    // его правке); и из них — только ИЗМЕНЁННЫЕ (ревью C1).
    const payload = changedValues(secondary ? COMPANY_PRINT : COMPANY_COLUMNS);   // BRANCH_PROFILE_V1 — филиал шлёт только своё для документов
    const keys = Object.keys(payload);
    if (!keys.length) { showProblems({}); toast(tr('Нет изменений'), 'info'); return; }
    // CLINIC_PROFILE_V1 — сначала привести (https://, @имя, пробелы) и проверить
    // теми же правилами, что знает сервер (shared/clinic-profile.js). Ошибка —
    // объяснение под полем и тост; запрос не уходит. Проверяется изменённое:
    // ссылка — если её меняли, адрес для партнёров — если меняли его часть
    // (прежние данные, которых не трогали, сохранение не останавливают).
    const v = normalizeProfile(state);
    const all = companyProblems(v, refs.geoAvailability());
    const addressTouched = keys.some((c) => ADDRESS_COLUMNS.includes(c));
    const problems = {};
    for (const [k, msg] of Object.entries(all)) {
        if (keys.includes(k) || (addressTouched && (ADDRESS_COLUMNS.includes(k)))) problems[k] = msg;
    }
    // CLINIC_API_STEP7_V1 — решение владельца 11: пока включено подключение API,
    // адрес для партнёров обязателен целиком, что бы ни меняли (сервер, routes/db.js,
    // откажет так же). В филиале подключений нет — правило его не касается.
    if (apiAddressRequired() && !secondary) {
        for (const [k, msg] of Object.entries(partnerAddressProblems(v, refs.geoAvailability()))) problems[k] = msg;
    }
    showProblems(problems, { focus: true });   // CLINIC_PROFILE_V1 (полировка) — к первому неверному полю
    if (Object.keys(problems).length) { toast(tr('Проверьте выделенные поля.'), 'fail'); return; }
    btn.disabled = true;
    paintSaveBtn(btn, true);
    try {
        const { data, error } = await supabase.from('doc_settings').update(payload).eq('id', 1).select().single();
        if (error) throw error;
        setState(data || { ...state, ...payload });
        refs.loaded = valuesOf(state);   // CLINIC_PROFILE_V1 (ревью C1) — новый снимок: записанное
        applyStateToControls();
        renderPreview();
        toast(tr('Сохранено'), 'ok');
        // CLINIC_API_FIX_V1 — новое название сразу под меню и в window.CLINIC
        // (по нему печатаются документы), без F5. Сбой перечитывания
        // сохранение не отменяет: оно уже прошло.
        await refreshClinicBrand(supabase).catch(() => {});
    } catch (e) {
        // CLINIC_API_STEP7_V1 (ревью №9) — сервер знает, что подключение включено, а флаг
        // экрана устарел: исправить флаг, поставить звёздочки и показать под полями,
        // чего не хватает (той же partnerAddressProblems, что у сервера).
        if (e && e.code === 'partner_address_required' && !secondary) {
            if (window.CLINIC) window.CLINIC.api_address_required = true;
            if (refs.address) refs.address.setRequired(true);
            const missing = partnerAddressProblems(normalizeProfile(state), refs.geoAvailability());
            if (e.field && !missing[e.field]) missing[e.field] = e.message;
            showProblems(missing, { focus: true });   // шаг 4 — к первому неверному полю
            toast(tr('Проверьте выделенные поля.'), 'fail');
            return;
        }
        // CLINIC_PROFILE_V1 (полировка) — сервер назвал поле (/api/db: { field,
        // message } — те же правила, что у экрана): объяснение под ним и фокус.
        if (e && e.field && e.message && refs.errs[e.field]) showProblems({ [e.field]: e.message }, { focus: true });
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
// CLINIC_PROFILE_V1 — кнопки языка предпросмотра: выбранная — .on и aria-pressed.
function paintLangBtns() {
    if (!refs.langBtns) return;
    for (const b of refs.langBtns.children) {
        const on = b.dataset && b.dataset.lang === refs.previewLang;
        b.className = on ? 'on' : '';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
}

// CLINIC_PROFILE_V1 — «Как это увидят пациенты»: квадратный логотип — файл,
// иначе печатная копия (прежний логотип); адрес — из выбранных строк справочника.
function renderPatientPreview() {
    if (!refs.patientEl) return;
    clear(refs.patientEl);
    const logo = state.logo_square_path ? logoSrc(state.logo_square_path) : (state.logo_data_url || '');
    const parts = refs.address ? refs.address.parts() : {};
    // BRANCH_PROFILE_V1 — в филиале пациенты видят адрес, карту и телефон из «Филиалов».
    const src = secondary
        ? { ...state, ...Object.fromEntries(COMPANY_PARTNER.map((c) => [c, refs.building[c] || ''])), phone: refs.building.phone || '' }
        : state;
    refs.patientEl.appendChild(patientPreview(src, { lang: refs.previewLang, parts, logo }));
}

function renderPreview() {
    renderPatientPreview();   // CLINIC_PROFILE_V1
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
