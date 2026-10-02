// Document settings + rich template renderer.
//
// Single source of truth for everything the clinic prints. The Documents
// page reads/writes settings here; every "Print" button in the app calls
// `printableSheet({type, data})` which produces a richly-branded sheet
// with the same visual treatment shown in the preview.
//
// Faithful port of the sample design under Documents/src/view-documents.jsx —
// logo + gradient mark, accent section bars with numbered circles,
// InfoBlock paired-key cards, Vital tiles, lab table with indicator bars,
// imaging tiles, rotating circular stamp, signature scribble, QR pattern,
// branded footer.

import { supabase } from '../../supabase.js';
import { currentClinicId } from '../tenant-tables.js';
import { toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1
// TELEGRAM_BOT_V1 — сам рендерер переехал в ../../shared/doc-render.js,
// чтобы его мог импортировать и сервер (Node) для сборки PDF боту.
// Здесь остаётся то, что без браузера не живёт: загрузка/сохранение настроек
// и открытие окна печати. Реэкспорт ниже сохраняет прежний публичный API.
import { buildSheetHtml, esc, INPATIENT_DOC_DEFAULT_TEXT } from '../../shared/doc-render.js';   // INPATIENT_DOCS_V1
// PRINT_AUTO_V1 — «Печать» сразу открывает окно принтера: скрипт печати — одним помощником.
import { ensureAutoPrint } from '../../shared/print-auto.js';

const KEY = 'easymed:doc-settings:v1';
let _cache = null;   // DB/localStorage-hydrated branding (clinic-global)

// V3120_FIX — у клиники без адреса, телефона или почты в «Компании» бланк
// печатал КОНТАКТЫ ПОСТАВЩИКА: «Tashkent, 12 Amir Temur Ave.», «+998 71 200 12
// 00», «hello@easy-med.uz». Пациент звонил бы по чужому номеру. Заготовки
// пустые, а пустое поле бланк не печатает вовсе.
//
// Заготовки подвала были английскими и печатались на каждом русском бланке.
// Теперь подвал — только текст, который клиника вписала сама.
//
// saveDocSettings() хранит объект ЦЕЛИКОМ, заготовки тоже, поэтому у клиник,
// сохранявших «Документы», старые значения лежат в настройках. LEGACY_DEFAULTS
// ниже вычищает именно их (и только их) при чтении.
const LEGACY_DEFAULTS = {
    clinicName: 'Easy-Med Clinic',
    address:    'Tashkent, 12 Amir Temur Ave., 100000',
    phone:      '+998 71 200 12 00',
    email:      'hello@easy-med.uz',
    footerNote: 'Thank you for choosing our clinic. Please keep this document for your records.',
    legalNote:  'This document is generated electronically and is valid without a manual signature when sealed with a digital signature.',
};

export const DEFAULT_DOC_SETTINGS = {
    clinicName: '',
    tagline:    '',
    address:    '',
    phone:      '',
    email:      '',
    web:        '',
    taxId:      '',   // DOC_REQUISITES_V1 — blank unless the clinic sets tax_id
    license:    '',   // DOC_REQUISITES_V1 — blank unless the clinic sets license_number

    // Uploaded clinic logo as a data URL (PNG/JPG/SVG). When null we fall
    // back to the built-in gradient heartbeat mark.
    logoDataUrl: null,

    // Clinic identity (name/logo/address/contacts) defaults from the «Компания» record;
    // set false to override with the fields below for printed documents.
    useCompanyIdentity: true,

    accent:      '#167873',
    accentSoft:  '#effaf8',
    ink:         '#0b1418',
    paperBg:     '#ffffff',

    showWatermark:    true,
    watermarkOpacity: 0.04,     // 0–0.20 — faintness of the logo watermark
    // NO_FAKE_MARKS_V1 — showStamp / showSignature / showQR больше нет: ни
    // печати, ни росчерка, ни QR на бумаге не рисуется. Настройка, которой
    // нечем управлять, — обещание.

    language:    'ru',   // V3120_FIX — печатные бланки русские
    paperSize:   'A4',          // A4 / A5 / Letter
    // THERMAL_WIDTH_V1 — ролик термопринтера: 40 / 58 / 80 мм. Влияет только на
    // чековые макеты (счёт-термочек, фискальный чек, кассовый чек); A4-бланки
    // печатаются по paperSize и этой настройки не видят.
    thermalWidth: '58',
    density:     'comfortable', // compact / comfortable / airy
    fontPair:    'modern',      // modern / serif / clinical
    cornerStyle: 'rounded',
    footerNote:  '',
    legalNote:   '',


    // INPATIENT_DOCS_V1 — тексты трёх бумаг при поступлении; по умолчанию —
    // формулировки образцов Aurora, клиника правит их в «Документах».
    ...INPATIENT_DOC_DEFAULT_TEXT,

    // Per-type selected print variant: { conclusion:'classic', lab:'classic', ... }
    variant: {},
};

// Available print variants per document type (designs are code; variant 1 = current design,
// the rest are stubs until the clinic supplies its designs).
export const DOC_VARIANTS = {
    conclusion: [{ key: 'classic', label: 'Классический (цвет)' }, { key: 'compact', label: 'Компактный · эконом' }],
    lab:        [{ key: 'classic', label: 'Классический (цвет)' }, { key: 'compact', label: 'Компактный · эконом' }],
    diag:       [{ key: 'classic', label: 'Классический (цвет)' }, { key: 'compact', label: 'Компактный · эконом' }],
    invoice:    [{ key: 'classic', label: 'Классический' }, { key: 'compact', label: 'Компактный · эконом' }, { key: 'thermal', label: 'Термочек (ширина в настройках)' }],
    check:      [{ key: 'classic', label: 'Классический' }],
    fiscal:     [{ key: 'classic', label: 'Термо-чек' }],
    inpatient_contract: [{ key: 'classic', label: 'Классический' }],   // INPATIENT_DOCS_V1
    inpatient_consent:  [{ key: 'classic', label: 'Классический' }],
    inpatient_memo:     [{ key: 'classic', label: 'Классический' }],
};

export function loadDocSettings() {
    let s;
    if (_cache) { s = { ...DEFAULT_DOC_SETTINGS, ..._cache }; }
    else {
        try {
            const raw = localStorage.getItem(KEY);
            s = raw ? { ...DEFAULT_DOC_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_DOC_SETTINGS };
        } catch { s = { ...DEFAULT_DOC_SETTINGS }; }
    }
    if (!s.variant || typeof s.variant !== 'object') s.variant = {};
    for (const [k, v] of Object.entries(LEGACY_DEFAULTS)) if (s[k] === v) s[k] = '';   // V3120_FIX
    if (s.language === 'en') s.language = 'ru';
    const _out = applyCompanyBranding(s);
    if (_out && _out.tagline === 'Care, clarity, precision') _out.tagline = '';   // legacy default — treat as unset
    return _out;
}

// Clinic-global: hydrate the in-memory cache (+ localStorage) from doc_branding so the SYNC
// loadDocSettings() — used by every Print button — reflects the clinic's saved branding.
export async function loadDocBrandingAsync() {
    try {
        const cid = currentClinicId();
        if (!cid) return loadDocSettings();
        // Skip the DB fetch until an auth session exists — avoids a 401 pre-fetch at
        // boot (the documents view re-loads this post-login; localStorage caches it).
        try { const { data: { session } } = await supabase.auth.getSession(); if (!session) return loadDocSettings(); } catch { return loadDocSettings(); }
        const { data } = await supabase.from('doc_branding').select('settings').eq('company_id', cid).maybeSingle();
        if (data && data.settings && typeof data.settings === 'object') {
            _cache = data.settings;
            try { localStorage.setItem(KEY, JSON.stringify(data.settings)); } catch (e) {}
        }
    } catch (e) { console.warn('[doc-settings] load DB', e && e.message); }
    return loadDocSettings();
}

// COMPANY_BRANDING_UNIFY: the Company record (window.CLINIC) is the source of truth for identity
// fields + logo; local doc settings own the styling (accent/watermark/font/tagline) and fill gaps.
export function applyCompanyBranding(s) {
    const c = (typeof window !== 'undefined' && window.CLINIC) || null;
    // OVERRIDE mode (#documents): saved doc-settings identity wins — don't overlay «Компания»,
    // and clear the company logo so logoMark() falls back to the uploaded logoDataUrl.
    if (s.useCompanyIdentity === false) { s.logoUrl = null; return s; }
    if (!c) return s;
    if (c.name_ru || c.name) s.clinicName = c.name_ru || c.name;
    if (c.address)           s.address    = c.address;
    if (c.phone)             s.phone      = c.phone;
    if (c.email)             s.email      = c.email;
    if (c.website)           s.web        = c.website;
    if (c.tax_id)            s.taxId      = c.tax_id;
    if (c.license_number)    s.license    = c.license_number;
    if (c.legal_name)        s.legalName  = c.legal_name;
    // COMPANY_SECTION_V1 — фирменный цвет тоже принадлежит клинике, а не
    // отдельному шаблону: выбранный в «Компании» он применяется во всех
    // печатных формах сразу. Тумблер «Данные клиники из раздела «Компания»»
    // (выше) по-прежнему позволяет задать свой цвет только для печати.
    if (c.accent_color)      s.accent     = c.accent_color;
    s.logoUrl = c.logo_url || null;
    return s;
}
export function saveDocSettings(settings) {
    _cache = { ...settings };
    try { localStorage.setItem(KEY, JSON.stringify(settings)); }
    catch (e) { console.warn('[doc-settings] save LS:', e); }
    // Clinic-global persist (fire-and-forget) — the sync cache above is what callers read.
    try {
        const cid = currentClinicId();
        if (cid) supabase.from('doc_branding')
            .upsert({ company_id: cid, settings, updated_at: new Date().toISOString() }, { onConflict: 'company_id' })
            .then(({ error }) => { if (error) { console.warn('[doc-settings] save DB:', error.message); toast(trf('Настройки сохранены только локально: {msg}', { msg: error.message }), 'fail'); } });
    } catch (e) { console.warn('[doc-settings] save DB:', e && e.message); }
}

export { buildSheetHtml, esc };

// ---------------------------------------------------------------------------
// printableSheet — opens the branded sheet in a new window and auto-prints.
// External callers (invoice receipt button etc.) call this with `type` +
// `data`. Falls back to an inline iframe preview if pop-ups are blocked.
//
// PRINT_AUTO_V1 (владелец, 02.10) — «печатает сам» было правдой только для
// запасной обёртки doc-render.js: оформленные бланки doc-variants.js (кабинет
// врача, лаборатория, счёт, чек и квитанция кассы — receipt-print.js тоже
// печатает отсюда) открывались страницей без печати. Теперь окно получает
// скрипт печати общим помощником ensureAutoPrint — только если своего нет.
// ---------------------------------------------------------------------------
export function printableSheet({ type = 'invoice', title = null, idLine = null, data = null, bodyHtml = null, settings = null, head = null } = {}) {
    const s = settings || loadDocSettings();
    const html = ensureAutoPrint(buildSheetHtml({ type, s, data, idLine, title, bodyHtml, head }));   // PRINT_AUTO_V1
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (w) { w.document.open(); w.document.write(html); w.document.close(); return; }
    openInlinePrintPreview(html);
}

function openInlinePrintPreview(html) {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.style.zIndex = '160';
    overlay.innerHTML = `
        <div class="modal-backdrop"></div>
        <div class="modal-card" style="width:900px;max-width:calc(100vw - 32px);height:85vh;display:flex;flex-direction:column;">
            <header class="modal-head"><h2>${tr('Предпросмотр печати')}</h2><button class="modal-close">×</button></header>
            <div class="modal-body" style="flex:1;overflow:hidden;padding:8px;"><iframe style="width:100%;height:100%;border:1px solid var(--ink-100);border-radius:8px;background:white;"></iframe></div>
            <footer class="modal-foot">
                <button class="btn">${tr('Закрыть')}</button>
                <span class="grow"></span>
                <button class="btn btn-primary">${tr('Печать')}</button>
            </footer>
        </div>`;
    const close = () => overlay.remove();
    overlay.querySelector('.modal-backdrop').onclick = close;
    overlay.querySelector('.modal-close').onclick = close;
    overlay.querySelector('.btn').onclick = close;
    const iframe = overlay.querySelector('iframe');
    const printFrame = () => { try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) {} };
    const printBtn = overlay.querySelector('.btn-primary');
    printBtn.onclick = printFrame;
    document.body.appendChild(overlay);
    const stripped = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (doc) { doc.open(); doc.write(stripped); doc.close(); }
    // PRINT_AUTO_V1 — окно заблокировано, а шагов не больше: окно принтера
    // открывается и здесь само (после загрузки бланка и шрифтов), «Печать» —
    // в фокусе: Enter или одно нажатие печатает ещё раз.
    try { printBtn.focus(); } catch (e) { /* фокус — удобство */ }
    autoPrintFrame(iframe, doc, printFrame);
}

// PRINT_AUTO_V1 — печать бланка в iframe после его загрузки и шрифтов, один раз.
function autoPrintFrame(iframe, doc, printFrame) {
    if (!doc) return;
    let done = false;
    const go = () => {
        if (done) return;
        done = true;
        (doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve())
            .then(() => setTimeout(printFrame, 250), () => setTimeout(printFrame, 250));
    };
    if (doc.readyState === 'complete') { go(); return; }
    try { iframe.contentWindow.addEventListener('load', go); } catch (e) { go(); }
}

// Same renderer the preview pane uses — exposed so the editor doesn't need
// to know the internal type-dispatch.
export function renderPreviewHtml(type, settings) {
    return buildSheetHtml({ type, s: settings });
}
