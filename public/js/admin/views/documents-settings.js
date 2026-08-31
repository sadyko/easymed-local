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

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, field } from '../ui.js';
import { tr } from '../i18n.js';
import { phoneInput } from '../phone-input.js?v=ph1';

// SETTINGS_SPLIT_V1 — paper_size/show_watermark/footer_note/legal_note остались
// в таблице, но не в этом объекте: DEFAULTS описывает то, чем управляет ЭТОТ
// экран, и лишнее поле здесь снова превратилось бы в поле формы.
const DEFAULTS = {
    clinic_name: '', address: '', phone: '', email: '', license: '',
    logo_data_url: null, accent_color: '#167873',
};

let state = { ...DEFAULTS };
const refs = { container: null, previewEl: null, thumbWrap: null, saveBtn: null, errNote: null, controls: null };

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

    const backBtn = h('button', {
        class: 'btn btn-outline btn-sm', type: 'button', style: { marginBottom: '14px' },
        onclick: () => onNavigate && onNavigate('settings'),
    }, Icon('ChevronLeft', { size: 14 }), ' ', 'Настройки');

    refs.saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save },
        Icon('Check', { size: 14 }), ' ', 'Сохранить');

    const formCard = h('div', { class: 'card' });
    buildForm(formCard);

    refs.previewEl = h('div');
    const previewCard = h('div', { class: 'card', style: { position: 'sticky', top: '16px', alignSelf: 'flex-start' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('ID', { size: 16 }), ' ', 'Как это выглядит')),
        h('div', { style: { padding: '18px' } }, refs.previewEl));

    refs.container.appendChild(h('div', { class: 'fade-in' },
        backBtn,
        h('div', { class: 'page-head' },
            h('div', null,
                // SETTINGS_SPLIT_V1 — заголовок наконец совпал с плиткой, из
                // которой сюда приходят. Раньше здесь стояло «Documents».
                h('h1', { class: 'page-title' }, 'Компания'),
                h('p', { class: 'page-subtitle' }, 'Название, логотип, фирменный цвет и контакты клиники'),
            ),
            h('div', { class: 'page-head-actions' }, refs.saveBtn),
        ),
        h('div', { class: 'row', style: { gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('div', { class: 'col grow', style: { minWidth: '320px', flexBasis: '420px' } }, formCard),
            h('div', { class: 'col grow', style: { minWidth: '320px', flexBasis: '420px' } }, previewCard),
        ),
    ));

    renderPreview();
}

// -----------------------------------------------------------------------------
// FORM — every control writes straight into `state` and repaints the preview.
// -----------------------------------------------------------------------------
function buildForm(card) {
    const onText = (key) => (e) => { state[key] = e.target.value; renderPreview(); };

    const nameInp    = h('input', { type: 'text', oninput: onText('clinic_name') });
    const addressInp = h('input', { type: 'text', oninput: onText('address') });
    // PHONE_INPUT_V1 — country control; read its .value (not e.target.value,
    // which would be the raw inner field including a bare «+998»).
    const phoneInp   = phoneInput('phone', '+998 71 200 12 00');
    phoneInp.addEventListener('input', () => { state.phone = phoneInp.value; renderPreview(); });
    const emailInp   = h('input', { type: 'text', oninput: onText('email') });
    const licenseInp = h('input', { type: 'text', oninput: onText('license') });
    const accentInp  = h('input', { type: 'color', oninput: onText('accent_color') });

    const fileInp = h('input', { type: 'file', accept: 'image/*', onchange: onLogoPick });
    refs.thumbWrap = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' } });

    refs.controls = { nameInp, addressInp, phoneInp, emailInp, licenseInp, accentInp };
    refs.errNote = h('div', { class: 'empty', style: { display: 'none', margin: '0 16px 12px' } },
        'Не удалось загрузить данные компании — показаны значения по умолчанию.');

    card.appendChild(h('div', { class: 'card-header' }, h('h3', null, Icon('ID', { size: 16 }), ' ', 'Реквизиты клиники')));
    card.appendChild(refs.errNote);
    card.appendChild(h('div', { style: { padding: '4px 16px 16px', display: 'flex', flexDirection: 'column' } },
        field('Название клиники', nameInp),
        field('Адрес', addressInp),
        field('Телефон', phoneInp),
        field('Электронная почта', emailInp),
        field('Номер лицензии', licenseInp),
        field('Фирменный цвет', accentInp),
        field('Логотип', h('div', null, fileInp, refs.thumbWrap)),
        // SETTINGS_SPLIT_V1 — сказано ровно один раз и там, где раньше стояли
        // переехавшие переключатели: иначе администратор, помнящий «размер
        // бумаги» на этом экране, решит, что настройка пропала.
        h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px' } },
            'Размер бумаги, водяной знак и подписи внизу документов настраиваются в разделе «Документы».'),
    ));
}

// Push the loaded/saved `state` values into the live form controls (DOM
// property assignment — h() only sets initial attributes at creation time).
function applyStateToControls() {
    const c = refs.controls;
    c.nameInp.value    = state.clinic_name || '';
    c.addressInp.value = state.address || '';
    c.phoneInp.value   = state.phone || '';
    c.emailInp.value   = state.email || '';
    c.licenseInp.value = state.license || '';
    c.accentInp.value  = state.accent_color || '#167873';
    paintThumb();
}

// -----------------------------------------------------------------------------
// LOGO — client-side resize (canvas) before it ever becomes a data URL, so a
// raw phone photo never blows the /api/db 100kb JSON body limit.
// -----------------------------------------------------------------------------
function resizeImageToDataUrl(file, maxDim, cb) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            const scale = Math.min(1, maxDim / Math.max(width, height));
            width = Math.round(width * scale); height = Math.round(height * scale);
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            cb(canvas.toDataURL('image/png'));
        };
        img.onerror = () => cb(null);
        img.src = e.target.result;
    };
    reader.onerror = () => cb(null);
    reader.readAsDataURL(file);
}

function onLogoPick(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';   // always reset — lets the same file be re-picked after Remove
    if (!file) return;
    resizeImageToDataUrl(file, 220, (dataUrl) => {
        if (!dataUrl) { toast('Не удалось прочитать это изображение.', 'fail'); return; }
        if (dataUrl.length > 90000) {
            toast('Логотип слишком большой даже после сжатия — выберите изображение поменьше.', 'fail');
            return;
        }
        state.logo_data_url = dataUrl;
        paintThumb();
        renderPreview();
    });
}

function removeLogo() {
    state.logo_data_url = null;
    paintThumb();
    renderPreview();
}

function paintThumb() {
    if (!refs.thumbWrap) return;
    clear(refs.thumbWrap);
    if (state.logo_data_url) {
        refs.thumbWrap.appendChild(h('img', {
            src: state.logo_data_url,
            style: { height: '40px', maxWidth: '120px', objectFit: 'contain', border: '1px solid var(--ink-100)', borderRadius: '6px', background: '#fff' },
        }));
        refs.thumbWrap.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: removeLogo },
            Icon('Trash', { size: 13 }), ' ', 'Удалить логотип'));
    } else {
        refs.thumbWrap.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Логотип не загружен'));
    }
}

// -----------------------------------------------------------------------------
// LOAD / SAVE
// -----------------------------------------------------------------------------
async function load() {
    try {
        const { data, error } = await supabase.from('doc_settings').select('*').eq('id', 1).single();
        if (error) throw error;
        state = { ...DEFAULTS, ...(data || {}) };
        if (refs.errNote) refs.errNote.style.display = 'none';
    } catch (e) {
        // tr() on the fixed sentence, the server's own message appended raw —
        // the convention every RPC-facing screen here follows (activation.js,
        // system-backups.js): a message built by concatenation would never be
        // translatable at all.
        toast(tr('Не удалось загрузить данные компании.') + ' ' + ((e && e.message) || e), 'fail');
        state = { ...DEFAULTS };
        if (refs.errNote) refs.errNote.style.display = '';
    }
    applyStateToControls();
    renderPreview();
}

async function save() {
    refs.saveBtn.disabled = true;
    const prevLabel = refs.saveBtn.textContent;
    refs.saveBtn.textContent = tr('Сохранение…');
    try {
        // SETTINGS_SPLIT_V1 — ровно те поля, которыми управляет этот экран.
        // paper_size / show_watermark / footer_note / legal_note НЕ шлются
        // намеренно: /api/db обновляет только перечисленные колонки, поэтому
        // то, что клиника ввела в них раньше, остаётся в базе нетронутым, а не
        // затирается значениями по умолчанию из отсутствующей формы.
        const payload = {
            clinic_name:    state.clinic_name || '',
            address:        state.address || '',
            phone:          state.phone || '',
            email:          state.email || '',
            license:        state.license || '',
            logo_data_url:  state.logo_data_url || null,
            accent_color:   state.accent_color || '#167873',
        };
        const { data, error } = await supabase.from('doc_settings').update(payload).eq('id', 1).select().single();
        if (error) throw error;
        state = { ...DEFAULTS, ...(data || payload) };
        applyStateToControls();
        renderPreview();
        toast(tr('Сохранено'), 'ok');
    } catch (e) {
        toast((e && e.message) || tr('Не удалось сохранить.'), 'fail');
    } finally {
        refs.saveBtn.disabled = false;
        refs.saveBtn.textContent = prevLabel;
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
