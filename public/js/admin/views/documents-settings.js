// Documents — DOCUMENTS_SETTINGS_V1 — clinic branding for printed documents
// (letterhead: clinic identity, accent colour, paper size, watermark, footer
// / legal notes). Backed by the single-row `doc_settings` table (id=1,
// seeded by migration 008): every staff role may read it, only admin may
// update it, via /api/db (server/db/schema-registry.js). Mirrors
// public/js/admin/views/services.js / settings-hub.js / inventory.js for
// structure (h()/Icon/clear/toast/Tag, shared field()/checkField() from
// ../ui.js) and modal-free single-page form pattern.
//
// NOTE: this is a DIFFERENT feature from the older, company-scoped
// "Document templates" editor (views/documents.js + views/doc-settings.js,
// route 'documents', table doc_branding) — that system covers six document
// types with a much richer per-type template/variant designer and is still
// live (permission-gated, listed in permissions.js). This view is the newer,
// simple, single clinic-wide letterhead editor for `doc_settings`. It is
// routed as 'documents-settings' (NOT 'documents') so it never collides with
// that existing route.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, field, checkField } from '../ui.js';
import { phoneInput } from '../phone-input.js?v=ph1';

const DEFAULTS = {
    clinic_name: '', address: '', phone: '', email: '', license: '',
    logo_data_url: null, accent_color: '#167873', paper_size: 'A4',
    show_watermark: 0, footer_note: '', legal_note: '',
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
    }, Icon('ChevronLeft', { size: 14 }), ' Settings');

    refs.saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save },
        Icon('Check', { size: 14 }), ' Save');

    const formCard = h('div', { class: 'card' });
    buildForm(formCard);

    refs.previewEl = h('div');
    const previewCard = h('div', { class: 'card', style: { position: 'sticky', top: '16px', alignSelf: 'flex-start' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Doc', { size: 16 }), ' Preview')),
        h('div', { style: { padding: '18px' } }, refs.previewEl));

    refs.container.appendChild(h('div', { class: 'fade-in' },
        backBtn,
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Documents'),
                h('p', { class: 'page-subtitle' }, 'Branding for printed documents — letterhead, logo, notes'),
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
    const paperSel   = h('select', { onchange: onText('paper_size') },
        h('option', { value: 'A4' }, 'A4'),
        h('option', { value: 'A5' }, 'A5'),
        h('option', { value: 'Letter' }, 'Letter'));
    const watermarkChk = h('input', {
        type: 'checkbox',
        onchange: (e) => { state.show_watermark = e.target.checked ? 1 : 0; renderPreview(); },
    });
    const footerTa = h('textarea', { rows: '3', oninput: onText('footer_note') });
    const legalTa  = h('textarea', { rows: '3', oninput: onText('legal_note') });

    const fileInp = h('input', { type: 'file', accept: 'image/*', onchange: onLogoPick });
    refs.thumbWrap = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' } });

    refs.controls = { nameInp, addressInp, phoneInp, emailInp, licenseInp, accentInp, paperSel, watermarkChk, footerTa, legalTa };
    refs.errNote = h('div', { class: 'empty', style: { display: 'none', margin: '0 16px 12px' } },
        'Could not load document settings — showing defaults.');

    card.appendChild(h('div', { class: 'card-header' }, h('h3', null, Icon('Doc', { size: 16 }), ' Letterhead')));
    card.appendChild(refs.errNote);
    card.appendChild(h('div', { style: { padding: '4px 16px 16px', display: 'flex', flexDirection: 'column' } },
        field('Clinic name', nameInp),
        field('Address', addressInp),
        field('Phone', phoneInp),
        field('Email', emailInp),
        field('License', licenseInp),
        h('div', { class: 'row', style: { gap: '12px' } },
            h('div', { class: 'col grow' }, field('Accent color', accentInp)),
            h('div', { class: 'col grow' }, field('Paper size', paperSel)),
        ),
        checkField('Show watermark', watermarkChk),
        field('Footer note', footerTa),
        field('Legal note', legalTa),
        field('Logo', h('div', null, fileInp, refs.thumbWrap)),
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
    c.paperSel.value   = state.paper_size || 'A4';
    c.watermarkChk.checked = !!state.show_watermark;
    c.footerTa.value   = state.footer_note || '';
    c.legalTa.value    = state.legal_note || '';
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
        if (!dataUrl) { toast('Could not read that image.', 'fail'); return; }
        if (dataUrl.length > 90000) {
            toast('Logo is too large even after resizing — please use a smaller/simpler image.', 'fail');
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
            Icon('Trash', { size: 13 }), ' Remove logo'));
    } else {
        refs.thumbWrap.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' } }, 'No logo uploaded'));
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
        toast('Failed to load document settings: ' + ((e && e.message) || e), 'fail');
        state = { ...DEFAULTS };
        if (refs.errNote) refs.errNote.style.display = '';
    }
    applyStateToControls();
    renderPreview();
}

async function save() {
    refs.saveBtn.disabled = true;
    const prevLabel = refs.saveBtn.textContent;
    refs.saveBtn.textContent = 'Saving…';
    try {
        const payload = {
            clinic_name:    state.clinic_name || '',
            address:        state.address || '',
            phone:          state.phone || '',
            email:          state.email || '',
            license:        state.license || '',
            logo_data_url:  state.logo_data_url || null,
            accent_color:   state.accent_color || '#167873',
            paper_size:     state.paper_size || 'A4',
            show_watermark: state.show_watermark ? 1 : 0,
            footer_note:    state.footer_note || '',
            legal_note:     state.legal_note || '',
        };
        const { data, error } = await supabase.from('doc_settings').update(payload).eq('id', 1).select().single();
        if (error) throw error;
        state = { ...DEFAULTS, ...(data || payload) };
        applyStateToControls();
        renderPreview();
        toast('Saved', 'ok');
    } catch (e) {
        toast((e && e.message) || 'Failed to save.', 'fail');
    } finally {
        refs.saveBtn.disabled = false;
        refs.saveBtn.textContent = prevLabel;
    }
}

// -----------------------------------------------------------------------------
// PREVIEW — a representative branded "paper" that updates live as the form
// changes. All clinic-supplied strings go through h()'s textContent path —
// never innerHTML.
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
            h('div', { style: { fontWeight: '700', fontSize: '16px', color: accent } }, state.clinic_name || 'Clinic name'),
            contactBits.length
                ? h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, contactBits.join(' · '))
                : null,
        ));

    const rule = h('div', { style: { borderTop: `2px solid ${accent}`, margin: '14px 0' } });

    const docTitle = h('div', { style: { fontWeight: '700', fontSize: '15px', marginBottom: '10px' } }, 'Medical Certificate');
    const sampleLines = h('div', { class: 'muted', style: { fontSize: '12.5px', lineHeight: '2' } },
        h('div', null, 'Patient: ____________________'),
        h('div', null, 'Date: ____________________'),
        h('div', null, 'Doctor: ____________________'));

    const footer = h('div', { style: { borderTop: `1px solid ${accent}`, marginTop: '26px', paddingTop: '10px' } },
        state.footer_note ? h('div', { class: 'muted', style: { fontSize: '10.5px' } }, state.footer_note) : null,
        state.legal_note  ? h('div', { class: 'muted', style: { fontSize: '10px', fontStyle: 'italic', marginTop: '2px' } }, state.legal_note) : null);

    refs.previewEl.appendChild(h('div', {
        style: {
            position: 'relative', overflow: 'hidden',
            background: '#fff', border: '1px solid var(--ink-100)', borderRadius: '10px',
            boxShadow: '0 4px 18px rgba(11,20,24,0.08)', padding: '24px', maxWidth: '460px', margin: '0 auto',
        },
    },
        Number(state.show_watermark) ? watermarkEl(accent) : null,
        headerRow, rule, docTitle, sampleLines, footer));
}

function watermarkEl(accent) {
    return h('div', {
        style: {
            position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: '0.06', pointerEvents: 'none',
        },
    },
        state.logo_data_url
            ? h('img', { src: state.logo_data_url, style: { width: '70%', objectFit: 'contain' } })
            : h('div', { style: { width: '55%', aspectRatio: '1 / 1', borderRadius: '20%', background: accent } }));
}
