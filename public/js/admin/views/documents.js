// Documents — clinic-wide template & branding editor.
//
// Six document types share one branding source (doc-settings.js).
// Edit clinic identity, accent colour, typeface, paper size, language,
// elements (watermark / QR / stamp / signature), and footer copy in the
// left panel. The right panel re-renders the document immediately using
// the same printableSheet() helper every other "Print" button in the app
// calls. So an Invoice receipt printed from the Cashier picks up exactly
// what you see in the preview.

import { h, Icon, PageHead, toast, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { sanitizeRichHtml } from '../sanitize.js';
import { supabase } from '../../supabase.js';
import { currentUser } from '../data.js';
import {
    DEFAULT_DOC_SETTINGS,
    loadDocSettings,
    saveDocSettings,
    renderPreviewHtml,
    printableSheet,
    DOC_VARIANTS,
    loadDocBrandingAsync,
    applyCompanyBranding,
} from './doc-settings.js?v=q3company1';   // ONE shared instance — ?v=db9 must match in EVERY importer (incl. admin.js + visit-modal)

const DOC_TYPES = [
    { id: 'conclusion', label: 'Заключение врача', icon: 'Stethoscope', sub: 'Клинический отчёт',    paper: 'A4' },
    { id: 'lab',        label: 'Результаты анализов',         icon: 'Flask',       sub: 'Панель анализов',         paper: 'A4' },
    { id: 'diag',       label: 'Диагностика',  icon: 'Activity',    sub: 'Снимки / ЭКГ',      paper: 'A4' },
    { id: 'invoice',    label: 'Счёт',             icon: 'Doc',         sub: 'До оплаты', paper: 'A4' },
    { id: 'check',      label: 'Чек клиники',        icon: 'Wallet',      sub: 'Чек за услугу',    paper: 'A5' },
    { id: 'fiscal',     label: 'Кассовый чек',      icon: 'Wallet',      sub: 'ОФД / термо',      paper: 'thermal' },
];

const BRAND_SWATCHES = [
    ['#167873', '#effaf8', 'Teal'],
    ['#1d4ed8', '#eef2ff', 'Blue'],
    ['#7c3aed', '#f5f3ff', 'Violet'],
    ['#0f766e', '#ecfdf5', 'Forest'],
    ['#0b1418', '#f3f5f7', 'Ink'],
    ['#b45309', '#fffbeb', 'Amber'],
    ['#dc2626', '#fef2f2', 'Crimson'],
    ['#ec4899', '#fdf2f8', 'Pink'],
];

const state = {
    active: 'conclusion',       // currently previewed doc type
    s:      loadDocSettings(),  // working copy of branding settings
    dirty:  false,              // has the user changed anything since last save?
};
let containerRef = null;

export async function renderDocuments(container) {
    containerRef = container;
    state.s     = loadDocSettings();
    state.dirty = false;
    paint();                         // immediate shell
    await loadDocBrandingAsync();    // clinic-global branding from DB
    state.s = loadDocSettings();
    paint();
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------
function paint() {
    clear(containerRef);

    containerRef.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        PageHead({
            title: 'Document templates',
            subtitle: 'Branding & layout for every printed artefact — conclusions, results, invoices, receipts, referrals. Every "Print" button in the app uses these settings.',
            right: [
                h('button', {
                    class: 'btn btn-outline',
                    onclick: () => printableSheet({
                        type:     state.active,
                        settings: state.s,
                    }),
                }, Icon('Print', { size: 14 }), ' Print preview'),
                h('button', { class: 'btn btn-outline', onclick: () => openDocTemplatesModal() }, Icon('Doc', { size: 14 }), ' Шаблоны заключений'),
                h('button', {
                    class: 'btn btn-outline',
                    onclick: () => {
                        if (!confirm('Reset all template settings to the defaults? Any unsaved changes will be lost.')) return;
                        state.s = { ...DEFAULT_DOC_SETTINGS };
                        state.dirty = true;
                        paint();
                    },
                }, Icon('Refresh', { size: 14 }), ' Reset'),
                h('button', {
                    class: state.dirty ? 'btn btn-primary' : 'btn btn-outline',
                    disabled: state.dirty ? null : '',
                    onclick: () => {
                        saveDocSettings(state.s);
                        state.dirty = false;
                        toast('Document templates saved. Every Print button now uses these settings.');
                        paint();
                    },
                }, Icon('Check', { size: 14 }), state.dirty ? ' Save' : ' Saved'),
            ],
        }),

        // Doc type tabs
        h('div', { class: 'tabs', style: { background: 'var(--ink-25)', borderRadius: '12px', padding: '6px', display: 'flex', gap: '4px', flexWrap: 'wrap' } },
            ...DOC_TYPES.map(d => h('button', {
                class: 'tab' + (state.active === d.id ? ' on' : ''),
                style: {
                    flex: '1 1 0', minWidth: '140px',
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '10px 12px',
                    border: '0', borderRadius: '8px',
                    background: state.active === d.id ? 'white' : 'transparent',
                    color: state.active === d.id ? 'var(--ink-900)' : 'var(--ink-600)',
                    fontSize: '12.5px', fontWeight: state.active === d.id ? 700 : 500,
                    cursor: 'pointer', fontFamily: 'inherit',
                    boxShadow: state.active === d.id ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                    textAlign: 'left',
                },
                onclick: () => { state.active = d.id; paint(); },
            },
                Icon(d.icon, { size: 14 }),
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', null, d.label),
                    h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', fontWeight: 500, marginTop: '1px' } },
                        d.sub + ' · ' + d.paper),
                ),
            )),
        ),

        // Editor + preview
        h('div', { style: { display: 'grid', gridTemplateColumns: '340px 1fr', gap: '16px', alignItems: 'flex-start' } },
            settingsPanel(),
            previewPanel(),
        ),
    ));
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------
function settingsPanel() {
    const fromCompany = state.s.useCompanyIdentity !== false;
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', position: 'sticky', top: '88px' } },
        variantCard(),
        editorCard('Clinic identity', 'Building', [
            companyIdentityToggle(fromCompany),
            h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', lineHeight: '1.45', marginBottom: '2px' } },
                // COMPANY_SECTION_V1 — раздел теперь действительно существует
                // (Настройки → Основное → «Компания»); раньше подсказка отправляла
                // туда, куда попасть было нельзя, а поля здесь молча
                // перезаписывались при каждой загрузке.
                fromCompany
                    ? 'Логотип, название, цвет и контакты берутся из раздела «Компания» (Настройки → Основное). Выключите тумблер, чтобы задать свои только для печати.'
                    : 'Свои данные клиники для печати — переопределяют раздел «Компания».'),
            logoField(),
            field('Clinic name',        'clinicName', { readonly: fromCompany }),
            field('Tagline',            'tagline',    { readonly: fromCompany }),
            field('Address',            'address',    { readonly: fromCompany }),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
                field('Phone', 'phone', { readonly: fromCompany }),
                field('Email', 'email', { readonly: fromCompany }),
            ),
            field('Tax / registration ID', 'taxId', { readonly: fromCompany }),
            field('License',               'license', { readonly: fromCompany }),
        ]),
        editorCard('Visual style', 'Sparkles', [
            mini('Brand colour'),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                ...BRAND_SWATCHES.map(([c, soft, name]) => {
                    const on = state.s.accent === c;
                    return h('button', {
                        title: name,
                        onclick: () => set({ accent: c, accentSoft: soft }),
                        style: {
                            width: '32px', height: '32px', borderRadius: '8px',
                            background: c, cursor: 'pointer', position: 'relative',
                            border: '2px solid white',
                            boxShadow: on ? `0 0 0 2px ${c}` : '0 0 0 1px var(--ink-200)',
                            padding: 0, fontFamily: 'inherit',
                        },
                    });
                }),
            ),
            customColorRow(),
            mini('Typeface',    { mt: 14 }),
            segmented('fontPair', [['modern','Modern'], ['serif','Serif'], ['clinical','Clinical']]),
            mini('Density',     { mt: 14 }),
            segmented('density', [['compact','Compact'], ['comfortable','Default'], ['airy','Airy']]),
            mini('Paper size',  { mt: 14 }),
            segmented('paperSize', [['A4','A4'], ['A5','A5'], ['Letter','Letter']]),
            mini('Language',    { mt: 14 }),
            segmented('language', [['en','EN'], ['ru','RU'], ['uz','UZ']]),
            mini('Corner style', { mt: 14 }),
            segmented('cornerStyle', [['rounded','Rounded'], ['sharp','Sharp']]),
        ]),
        editorCard('Elements', 'Filter', [
            toggle('Watermark',         'showWatermark'),
            state.s.showWatermark ? watermarkOpacityControl() : null,
            toggle('QR · verification', 'showQR'),
            toggle('Doctor signature',  'showSignature'),
        ]),
        editorCard('Footer copy', 'Doc', [
            field('Thank-you note',  'footerNote', { multi: true }),
            field('Legal disclaimer','legalNote',  { multi: true }),
        ]),
    );
}

function editorCard(title, iconName, children) {
    return h('div', { class: 'card', style: { overflow: 'hidden' } },
        h('div', { style: { padding: '11px 14px', borderBottom: '1px solid var(--ink-100)', background: 'var(--ink-25)' } },
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
                h('span', { style: { color: 'var(--primary-600)', display: 'inline-flex' } }, Icon(iconName, { size: 14 })),
                h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-700)', textTransform: 'uppercase', letterSpacing: '0.06em' } }, title),
            ),
        ),
        h('div', { style: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' } }, ...children),
    );
}

function field(label, key, opts = {}) {
    const ro = !!opts.readonly;
    const roStyle = ro ? { background: 'var(--ink-25)', color: 'var(--ink-500)', cursor: 'not-allowed' } : {};
    const wrap = h('div', null,
        mini(label),
        opts.multi
            ? h('textarea', {
                value: state.s[key] || '',
                rows: '2',
                disabled: ro || null,
                style: { ...fieldStyle(true), ...roStyle },
                oninput: ro ? null : (e) => set({ [key]: e.target.value }, { skipRepaint: true }),
            })
            : h('input', {
                type: 'text',
                value: state.s[key] || '',
                disabled: ro || null,
                style: { ...fieldStyle(false), ...roStyle },
                oninput: ro ? null : (e) => set({ [key]: e.target.value }, { skipRepaint: true }),
            }),
    );
    return wrap;
}

// Logo uploader — reads the chosen image as a data URL and stores it in
// settings.logoDataUrl. The header on every printed document then renders
// the uploaded mark instead of the built-in gradient symbol.
function logoField() {
    // COMPANY_BRANDING_UNIFY: when the Company has a logo it wins — show it read-only here.
    const _companyLogo = state.s.logoUrl || '';
    if (_companyLogo) {
        return h('div', null,
            mini('Clinic logo'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
                h('img', { src: _companyLogo, style: { width: '48px', height: '48px', objectFit: 'contain', borderRadius: '10px', border: '1px solid var(--ink-200)', background: 'white', flex: '0 0 48px' } }),
                h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', lineHeight: '1.4' } }, 'Логотип берётся из раздела «Компания». Чтобы изменить — обновите его там.'),
            ),
        );
    }
    const has = !!state.s.logoDataUrl;

    const fileInput = h('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/svg+xml,image/webp',
        style: { display: 'none' },
        onchange: (e) => { handleLogoFile(e.target.files && e.target.files[0]); e.target.value = ''; },
    });

    const preview = has
        ? h('img', {
            src: state.s.logoDataUrl,
            style: {
                width: '48px', height: '48px', objectFit: 'contain',
                borderRadius: '10px', border: '1px solid var(--ink-200)',
                background: 'white', flex: '0 0 48px',
            },
        })
        : h('div', {
            style: {
                width: '48px', height: '48px', borderRadius: '10px', flex: '0 0 48px',
                background: `linear-gradient(135deg, ${state.s.accent}, ${state.s.accent})`,
                display: 'grid', placeItems: 'center',
            },
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/></svg>',
        });

    return h('div', null,
        mini('Clinic logo'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            preview,
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: 0 } },
                h('div', { style: { display: 'flex', gap: '6px' } },
                    h('button', {
                        class: 'btn btn-outline',
                        style: { height: '30px', padding: '0 10px', fontSize: '12.5px' },
                        onclick: () => fileInput.click(),
                    }, Icon('Plus', { size: 13 }), has ? ' Replace' : ' Upload'),
                    has && h('button', {
                        class: 'btn btn-outline',
                        style: { height: '30px', padding: '0 10px', fontSize: '12.5px', color: 'var(--crit-700)' },
                        onclick: () => set({ logoDataUrl: null }),
                    }, 'Remove'),
                ),
                h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', lineHeight: '1.4' } },
                    has ? 'Shown on every printed document.' : 'PNG, JPG or SVG · max 1 MB · square works best.'),
            ),
        ),
        fileInput,
    );
}

function handleLogoFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('Please choose an image file (PNG, JPG or SVG).', 'fail'); return; }
    if (file.size > 1024 * 1024) { toast('Logo too large — please use an image under 1 MB.', 'fail'); return; }
    const reader = new FileReader();
    reader.onload  = () => set({ logoDataUrl: reader.result });
    reader.onerror = () => toast('Could not read that file.', 'fail');
    reader.readAsDataURL(file);
}

function mini(text, opts = {}) {
    return h('div', {
        style: {
            fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            marginBottom: '4px',
            marginTop: opts.mt ? (opts.mt + 'px') : '0',
        },
    }, text);
}

function fieldStyle(multi) {
    return {
        width: '100%',
        minHeight: multi ? '50px' : '32px',
        border: '1px solid var(--ink-200)', borderRadius: '7px',
        background: 'white', padding: '6px 9px',
        fontSize: '12.5px', color: 'var(--ink-900)',
        outline: 'none', fontFamily: 'inherit',
        boxSizing: 'border-box', resize: 'vertical',
    };
}

function segmented(key, options) {
    return h('div', { style: { display: 'flex', gap: '4px', background: 'var(--ink-50, #f5f7f8)', padding: '3px', borderRadius: '8px' } },
        ...options.map(([v, l]) => {
            const on = state.s[key] === v;
            return h('button', {
                style: {
                    flex: 1, height: '26px', borderRadius: '6px',
                    background: on ? 'white' : 'transparent',
                    color: on ? 'var(--ink-900)' : 'var(--ink-500)',
                    border: 0,
                    fontSize: '12.5px', fontWeight: 600, fontFamily: 'inherit',
                    cursor: 'pointer',
                    boxShadow: on ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                },
                onclick: () => set({ [key]: v }),
            }, l);
        }),
    );
}

// Custom brand colour — a native picker plus a hex code field, so the
// accent can be set to any value beyond the preset swatches. Both stay in
// sync and the soft tint (used for pills, section fills, table headers) is
// derived automatically from the chosen colour.
function customColorRow() {
    const isPreset = BRAND_SWATCHES.some(([c]) => c.toLowerCase() === String(state.s.accent || '').toLowerCase());
    const valid = /^#[0-9a-f]{6}$/i.test(state.s.accent || '');

    const colorInput = h('input', {
        type: 'color',
        value: valid ? state.s.accent.toLowerCase() : '#167873',
        title: 'Pick a custom colour',
        style: {
            width: '36px', height: '32px', padding: '2px', flex: '0 0 36px',
            border: '1px solid var(--ink-200)', borderRadius: '7px',
            background: 'white', cursor: 'pointer',
        },
        oninput:  (e) => applyAccent(e.target.value, { skipRepaint: true }),
        onchange: (e) => applyAccent(e.target.value),
    });

    const hexInput = h('input', {
        type: 'text',
        value: state.s.accent || '',
        placeholder: '#167873',
        spellcheck: false,
        maxlength: '7',
        style: { ...fieldStyle(false), flex: 1, fontFamily: 'ui-monospace, Menlo, Consolas, monospace' },
        oninput: (e) => {
            const v = e.target.value.trim();
            if (/^#?[0-9a-f]{6}$/i.test(v)) applyAccent(normHex(v), { skipRepaint: true });
        },
        onchange: () => paint(),
    });

    return h('div', null,
        mini('Custom colour', { mt: 10 }),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            colorInput, hexInput,
            !isPreset && valid
                ? h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)', whiteSpace: 'nowrap' } }, 'CUSTOM')
                : null,
        ),
    );
}

function normHex(v) {
    v = String(v).trim();
    if (!v.startsWith('#')) v = '#' + v;
    return v.toLowerCase();
}

function applyAccent(hex, opts) {
    const hx = normHex(hex);
    set({ accent: hx, accentSoft: softTintFromAccent(hx) }, opts);
}

// Lighten the accent toward white by ~92 % to produce the soft tint used
// for pill backgrounds, section fills and table headers.
function softTintFromAccent(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(normHex(hex));
    if (!m) return state.s.accentSoft || '#eef2ff';
    const n = parseInt(m[1], 16);
    const mix = (c) => Math.round(c + (255 - c) * 0.92);
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Slider for the logo-watermark faintness (0–20 %). Live-updates the
// preview without a full repaint so the slider keeps focus while dragging.
function watermarkOpacityControl() {
    const pct = Math.round((state.s.watermarkOpacity ?? 0.04) * 100);
    const valLabel = h('span', {
        class: 'num',
        style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-700)' },
    }, pct + '%');
    return h('div', { style: { padding: '2px 0 4px' } },
        h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } },
            h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'Watermark visibility'),
            valLabel,
        ),
        h('input', {
            type: 'range', min: '0', max: '20', step: '1', value: String(pct),
            style: { width: '100%', accentColor: 'var(--primary-600)' },
            oninput: (e) => {
                valLabel.textContent = e.target.value + '%';
                set({ watermarkOpacity: Number(e.target.value) / 100 }, { skipRepaint: true });
            },
        }),
    );
}

function toggle(label, key) {
    const v = !!state.s[key];
    return h('label', {
        class: 'row',
        style: {
            gap: '10px', cursor: 'pointer', fontSize: '12.5px', color: 'var(--ink-800)',
            justifyContent: 'space-between', padding: '4px 0',
        },
    },
        h('span', null, label),
        h('span', {
            style: {
                width: '34px', height: '20px', borderRadius: '999px',
                background: v ? 'var(--primary-600)' : 'var(--ink-200)',
                position: 'relative', transition: 'background-color 120ms ease',
                flex: '0 0 34px',
            },
            onclick: (e) => { e.preventDefault(); set({ [key]: !v }); },
        },
            h('span', {
                style: {
                    position: 'absolute', top: '2px', left: v ? '16px' : '2px',
                    width: '16px', height: '16px', borderRadius: '999px',
                    background: 'white', transition: 'left 120ms ease',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
                },
            }),
        ),
        h('input', { type: 'checkbox', checked: v, style: { display: 'none' }, onchange: () => set({ [key]: !v }) }),
    );
}

// Apply a settings patch. Repaints by default so segmented controls /
// toggles / colour swatches reflect their new state immediately. For text
// inputs we pass skipRepaint to avoid stealing focus on every keystroke —
// the preview re-renders directly via patchPreview().
function set(patch, opts = {}) {
    state.s = { ...state.s, ...patch };
    state.dirty = true;
    if (opts.skipRepaint) {
        patchPreview();
        markDirty();
    } else {
        paint();
    }
}

function markDirty() {
    // Repaint just the Save button's class/label to show "Save" instead of
    // "Saved" once the user changes something — without re-rendering the
    // whole tree (which would lose focus on the text input being edited).
    const saveBtn = containerRef.querySelector('.page-head .btn-outline:last-of-type, .page-head .btn-primary:last-of-type');
    // (Best-effort — the next full repaint will set the class correctly.)
}

function patchPreview() {
    const slot = containerRef.querySelector('#doc-preview-slot');
    if (!slot) return;
    clear(slot);
    slot.appendChild(buildPreviewFrame());
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------
function previewPanel() {
    return h('div', { class: 'card', style: { padding: '14px', background: 'var(--ink-25, #f5f7f8)' } },
        h('div', { class: 'row', style: { gap: '8px', marginBottom: '10px', alignItems: 'center' } },
            h('span', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-700)', textTransform: 'uppercase', letterSpacing: '0.06em' } },
                'Live preview'),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                '— ' + typeMeta(state.active).label + ' · ' + state.s.paperSize),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                'Same renderer every Print button uses'),
        ),
        h('div', { id: 'doc-preview-slot' }, buildPreviewFrame()),
    );
}

function buildPreviewFrame() {
    // The doc-settings module is the single source of truth — its rich
    // per-type renderer (Logo / SectionBar / InfoBlock / Vitals / Lab
    // table with indicator bars / imaging tiles / Stamp / QR / Signature)
    // produces the same HTML the print window will use. So WYSIWYG.
    const html = renderPreviewHtml(state.active, state.s);

    const iframe = h('iframe', {
        style: {
            width: '100%', height: '1100px',
            border: '1px solid var(--ink-100)', borderRadius: '10px',
            background: 'white', display: 'block',
        },
    });
    setTimeout(() => {
        try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!doc) return;
            const stripped = html.replace(/<script>[\s\S]*?<\/script>/g, '');
            doc.open(); doc.write(stripped); doc.close();
        } catch (e) { console.warn('[preview write]', e); }
    }, 0);
    return iframe;
}

function typeMeta(id) {
    return DOC_TYPES.find(d => d.id === id) || DOC_TYPES[0];
}


// DOC_VARIANTS_V1 — per-type print-variant selector (designs are code; selection is saved).
function variantCard() {
    const list = (typeof DOC_VARIANTS !== 'undefined' && DOC_VARIANTS[state.active]) || [{ key: 'classic', label: 'Классический' }];
    const sel = (state.s.variant && state.s.variant[state.active]) || 'classic';
    return editorCard('Вариант для печати', 'Sparkles', [
        h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', lineHeight: '1.45', marginBottom: '4px' } },
            trf('Дизайн печати для типа «{type}». Выбранный вариант печатается из приёма врача и из визита пациента.', { type: typeMeta(state.active).label || state.active })),
        ...list.map(v => {
            const on = sel === v.key;
            return h('button', {
                type: 'button', disabled: v.stub ? '' : null,
                onclick: () => { if (!v.stub) setVariant(state.active, v.key); },
                style: {
                    display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left',
                    padding: '8px 10px', borderRadius: '8px', cursor: v.stub ? 'not-allowed' : 'pointer',
                    border: '1px solid ' + (on ? 'var(--primary-500)' : 'var(--ink-200)'),
                    background: on ? 'var(--primary-50)' : 'white',
                    color: v.stub ? 'var(--ink-400)' : 'var(--ink-800)',
                    fontFamily: 'inherit', fontSize: '12.5px', fontWeight: on ? 600 : 500,
                },
            },
                h('span', { style: { width: '14px', display: 'inline-flex', flex: '0 0 14px' } }, on ? Icon('Check', { size: 14 }) : null),
                h('span', { style: { flex: 1 } }, v.label),
                v.stub ? h('span', { style: { fontSize: '12.5px', color: 'var(--ink-400)' } }, 'скоро') : null,
            );
        }),
    ]);
}

function setVariant(type, key) {
    state.s.variant = { ...(state.s.variant || {}), [type]: key };
    state.dirty = true;
    paint();
}


// DOC_TEMPLATES_V1 — manage the shared «Шаблоны заключений» (consultation_templates) from #documents.
// Same library the workspace «Шаблоны» button uses; «Общие» = shared to all clinic doctors.
const TPL_SECTIONS = [
    ['chief_complaint', 'Жалобы'], ['hpi', 'Анамнез'], ['labs_text', 'Лабораторные'],
    ['instrumental_text', 'Инструментальные'], ['physical_exam', 'Осмотр'],
    ['primary_diagnosis', 'Диагноз'], ['therapy_text', 'Терапия'], ['recommendations_text', 'Рекомендации'],
];

async function openDocTemplatesModal() {
    const me = currentUser() || {};
    const st = { rows: [], filter: 'all', q: '', mode: 'view', selId: null, draft: null };
    const overlay = h('div', { class: 'modal', style: { zIndex: '170' } });
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };

    const listEl = h('div', { class: 'tplm-list' });
    const detailEl = h('div', { class: 'tplm-detail' });
    const footMeta = h('span', { class: 'muted', style: { fontSize: '12.5px', display: 'inline-flex', alignItems: 'center', gap: '6px' } });
    const searchInp = h('input', { class: 'tplm-input', type: 'search', placeholder: 'Поиск по названию…', style: { maxWidth: '320px' }, oninput: (e) => { st.q = e.target.value; paintList(); } });

    let barEl;
    const fbtn = (id, label) => h('button', { class: 'btn btn-sm ' + (st.filter === id ? 'btn-primary' : 'btn-outline'), onclick: () => { st.filter = id; const nb = buildBar(); barEl.replaceWith(nb); barEl = nb; paintList(); } }, label);
    function buildBar() {
        return h('div', { class: 'tplm-bar' },
            searchInp,
            h('div', { style: { display: 'flex', gap: '6px' } }, fbtn('all', 'Все'), fbtn('mine', 'Мои'), fbtn('shared', 'Общие')),
            h('span', { style: { flex: 1 } }),
            h('button', { class: 'btn btn-outline', onclick: () => startNew() }, Icon('Plus', { size: 14 }), ' Новый шаблон'));
    }
    barEl = buildBar();

    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '900px', maxWidth: 'calc(100vw - 32px)', height: '85vh', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Doc', { size: 16 }), ' Шаблоны заключений'), h('button', { class: 'modal-close', onclick: close }, '×')),
        barEl,
        h('div', { class: 'modal-body', style: { display: 'grid', gridTemplateColumns: '300px 1fr', gap: '0', padding: '0', flex: '1', overflow: 'hidden' } }, listEl, detailEl),
        h('footer', { class: 'modal-foot' }, footMeta, h('span', { style: { flex: 1 } }), h('button', { class: 'btn', onclick: close }, 'Закрыть'))));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    await load(); paintList(); paintDetail(); paintFootMeta();

    async function load() {
        try {
            const { data } = await supabase.from('consultation_templates')
                .select('id,name,doc_type,scope,body,author_id,author_name,updated_at').order('updated_at', { ascending: false });
            st.rows = data || [];
        } catch (e) { st.rows = []; toast('Не удалось загрузить шаблоны', 'fail'); }
    }
    function filtered() {
        const ql = st.q.trim().toLowerCase();
        return st.rows.filter(r =>
            (st.filter === 'all' || (st.filter === 'mine' && r.author_id === me.id) || (st.filter === 'shared' && r.scope === 'shared'))
            && (!ql || (r.name || '').toLowerCase().includes(ql)));
    }
    function paintFootMeta() {
        clear(footMeta);
        footMeta.appendChild(h('span', null, trf('{n} шаблон(ов)', { n: st.rows.length }), ' · '));
        footMeta.appendChild(Icon('Globe', { size: 12 }));
        footMeta.appendChild(h('span', null, ' общие видны всем врачам клиники'));
    }
    function paintList() {
        clear(listEl);
        const rows = filtered();
        if (!rows.length) { listEl.appendChild(h('div', { class: 'tplm-empty' }, st.rows.length ? 'Ничего не найдено' : 'Пока нет шаблонов')); return; }
        for (const r of rows) {
            const on = st.selId === r.id;
            listEl.appendChild(h('div', { class: 'tplm-item' + (on ? ' on' : ''), onclick: () => { st.selId = r.id; st.mode = 'view'; st.draft = null; paintList(); paintDetail(); } },
                h('div', { class: 'tplm-item-main' },
                    h('div', { class: 'tplm-name' }, r.name || '(без названия)'),
                    h('div', { class: 'tplm-meta' }, (r.scope === 'shared' ? 'Общий' : 'Личный') + ' · ' + (r.author_name || '—'))),
                r.scope === 'shared' ? Icon('Globe', { size: 13 }) : Icon('User', { size: 13 })));
        }
    }
    function startNew() { st.mode = 'edit'; st.selId = null; st.draft = { name: '', scope: 'shared', doc_type: 'Приём (осмотр, консультация)', body: {} }; paintDetail(); }
    function startEdit(r) { st.mode = 'edit'; st.selId = r.id; st.draft = { id: r.id, name: r.name || '', scope: r.scope || 'shared', doc_type: r.doc_type || 'Приём (осмотр, консультация)', body: { ...(r.body || {}) } }; paintDetail(); }
    function paintDetail() {
        clear(detailEl);
        if (st.mode === 'edit') return void paintEditor();
        const r = st.rows.find(x => x.id === st.selId);
        if (!r) { detailEl.appendChild(h('div', { class: 'tplm-empty' }, 'Выберите шаблон слева')); return; }
        const filled = TPL_SECTIONS.filter(([k]) => (r.body || {})[k]);
        detailEl.appendChild(h('div', { class: 'tplm-form' },
            h('div', { class: 'tplm-detail-head' },
                h('b', { style: { fontSize: '15px', color: 'var(--ink-900)' } }, r.name || '(без названия)'),
                h('span', { style: { flex: 1 } }),
                h('button', { class: 'btn btn-outline btn-sm', onclick: () => startEdit(r) }, Icon('Edit', { size: 13 }), ' Изменить'),
                h('button', { class: 'btn btn-outline btn-sm', style: { color: 'var(--crit-700)' }, onclick: () => askDelete(r) }, Icon('Trash', { size: 13 }))),
            h('div', { class: 'tplm-meta', style: { marginTop: '2px' } }, (r.scope === 'shared' ? 'Общий для всех врачей' : 'Только я') + ' · ' + (r.author_name || '—')),
            ...filled.map(([k, lbl]) => h('div', { style: { marginTop: '12px' } },
                h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' } }, lbl),
                h('div', { style: { fontSize: '13.5px', color: 'var(--ink-800)', whiteSpace: 'pre-wrap', lineHeight: '1.5' }, html: sanitizeRichHtml(r.body[k]) }))),
            filled.length ? null : h('div', { class: 'muted', style: { marginTop: '12px', fontSize: '12.5px' } }, 'Шаблон без заполненных секций.')));
    }
    function paintEditor() {
        const d = st.draft;
        clear(detailEl);
        const nameIn = h('input', { class: 'tplm-input', value: d.name, oninput: (e) => { d.name = e.target.value; } });
        const sbtn = (val, label, icon) => h('button', { class: 'btn btn-sm ' + (d.scope === val ? 'btn-primary' : 'btn-outline'), onclick: () => { d.scope = val; paintEditor(); } }, Icon(icon, { size: 13 }), ' ' + label);
        detailEl.appendChild(h('div', { class: 'tplm-form' },
            h('b', { style: { fontSize: '13.5px', color: 'var(--ink-900)' } }, d.id ? 'Изменение шаблона' : 'Новый шаблон'),
            h('div', { class: 'tplm-field' }, h('label', null, 'Название'), nameIn),
            h('div', { class: 'tplm-field' }, h('label', null, 'Видимость'),
                h('div', { style: { display: 'flex', gap: '6px' } }, sbtn('shared', 'Общий для всех', 'Globe'), sbtn('private', 'Только я', 'User'))),
            h('div', { class: 'tplm-form-secs' }, ...TPL_SECTIONS.map(([k, lbl]) => h('div', { class: 'tplm-field' },
                h('label', null, lbl),
                h('textarea', { class: 'tplm-input', rows: '2', value: String(d.body[k] || '').replace(/<[^>]+>/g, ''), oninput: (e) => { d.body[k] = e.target.value; } })))),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
                h('button', { class: 'btn btn-ghost', onclick: () => { st.mode = 'view'; st.draft = null; paintDetail(); } }, 'Отмена'),
                h('span', { style: { flex: 1 } }),
                h('button', { class: 'btn btn-primary', onclick: (ev) => save(ev.currentTarget) }, Icon('Check', { size: 14 }), ' Сохранить шаблон'))));
    }
    async function save(btn) {
        const d = st.draft;
        if (!d.name.trim()) { toast('Укажите название шаблона', 'warn'); return; }
        if (btn) btn.disabled = true;
        const body = {};
        for (const [k] of TPL_SECTIONS) { const v = String(d.body[k] || '').trim(); if (v) body[k] = v; }
        try {
            if (d.id) {
                const { error } = await supabase.from('consultation_templates').update({ name: d.name.trim(), scope: d.scope, body, doc_type: d.doc_type }).eq('id', d.id);
                if (error) throw error; toast('Шаблон обновлён', 'ok');
            } else {
                const { data, error } = await supabase.from('consultation_templates').insert({ name: d.name.trim(), scope: d.scope, doc_type: d.doc_type, body, author_name: (me.full_name || me.username || 'Врач') }).select('id').maybeSingle();
                if (error) throw error; toast('Шаблон сохранён', 'ok'); if (data) st.selId = data.id;
            }
        } catch (e) { toast('Не удалось сохранить', 'fail'); if (btn) btn.disabled = false; return; }
        await load(); st.mode = 'view'; st.draft = null; paintList(); paintDetail(); paintFootMeta();
    }
    function askDelete(r) {
        if (!confirm(trf('Удалить шаблон «{name}»?', { name: r.name || '' }))) return;
        (async () => {
            try { const { error } = await supabase.from('consultation_templates').delete().eq('id', r.id); if (error) throw error; toast('Шаблон удалён', 'ok'); }
            catch (e) { toast('Не удалось удалить', 'fail'); return; }
            st.selId = null; await load(); paintList(); paintDetail(); paintFootMeta();
        })();
    }
}

// CLINIC_IDENTITY_OVERRIDE_V1 — toggle: clinic identity from «Компания» (default) vs #documents override.
function companyIdentityToggle(on) {
    return h('label', { class: 'row', style: { gap: '10px', cursor: 'pointer', fontSize: '12.5px', color: 'var(--ink-800)', justifyContent: 'space-between', padding: '2px 0 6px' } },
        h('span', null, 'Данные клиники из раздела «Компания»'),
        h('span', {
            style: { width: '34px', height: '20px', borderRadius: '999px', background: on ? 'var(--primary-600)' : 'var(--ink-200)', position: 'relative', flex: '0 0 34px', transition: 'background-color 120ms ease' },
            onclick: (e) => { e.preventDefault(); state.s.useCompanyIdentity = !on; state.s = applyCompanyBranding(state.s); state.dirty = true; paint(); },
        },
            h('span', { style: { position: 'absolute', top: '2px', left: on ? '16px' : '2px', width: '16px', height: '16px', borderRadius: '999px', background: 'white', transition: 'left 120ms ease', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' } }),
        ),
    );
}
