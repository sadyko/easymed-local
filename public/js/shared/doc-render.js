// TELEGRAM_BOT_V1 — общий рендерер печатных форм.
//
// Вырезан из views/doc-settings.js без изменений: тот модуль импортирует
// supabase, ui и tenant-tables, поэтому в Node его не загрузить — а PDF для
// Telegram-бота собирает сервер. Здесь только чистые функции построения HTML,
// без импортов браузерного окружения, так что файл одинаково работает и в
// браузере (кнопки «Печать»), и в Node (бот).
//
// Из этого следует главное свойство: документ, который пациент получает в
// Telegram, не может разъехаться с тем, что печатает регистратура, — это
// буквально один и тот же код.
//
// Единственная правка при переносе: buildSheetHtml больше не подставляет
// loadDocSettings() сам (это localStorage) — настройки передаёт вызывающий.

import { renderDesignedVariant } from '../admin/views/doc-variants.js?v=labref19a';
export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}
// ---------------------------------------------------------------------------
// Build the final HTML for the print/preview window. Wraps the per-type
// renderer in branded paper chrome + auto-print script.
// ---------------------------------------------------------------------------
export function buildSheetHtml({ type = 'invoice', s = null, data = null, idLine = null, title = null, bodyHtml = null }) {
    // `s` обязателен: этот модуль не знает ни про localStorage, ни про
    // clinic-контекст. Настройки собирает вызывающий — браузер через
    // loadDocSettings(), сервер через doc_settings/doc_branding.
    if (!s) throw new Error('buildSheetHtml: настройки документа (s) обязательны.');
    const cfg = s;
    // DESIGNED_VARIANTS_V1 — full standalone design (Medion handout) for this type+variant, if any.
    // INVOICE_58MM_V1 — designed variants only receive `data`; surface the invoice/idLine number as docNo.
    if (data && typeof data === 'object' && !data.docNo && idLine) data = Object.assign({}, data, { docNo: idLine });
    const _designed = renderDesignedVariant(type, (cfg.variant && cfg.variant[type]) || 'classic', cfg, data || (type === 'conclusion' ? sampleConclusion() : null));
    if (_designed) return _designed;
    const fontStack = fontFor(cfg.fontPair);

    // Per-type body. External callers (invoice receipt from the cashier,
    // etc.) can pass `bodyHtml` to override the placeholder content with
    // real data; the wrapper (header + footer + watermark + stamp) is
    // always supplied by doc-settings.
    const body = bodyHtml != null
        ? renderCustomBody({ s: cfg, type, bodyHtml, idLine, title })
        : renderBuiltinBody({ s: cfg, type, data });

    // Page geometry per type. Fiscal = narrow thermal strip, A5 = half A4.
    // `h` = printable height (page height minus the 12mm @page margins on
    // each side) so the sheet can fill the page and pin the footer to the
    // bottom. Fiscal rolls are variable-length so they get no fixed height.
    const paper =
        type === 'fiscal'                            ? { w: '58mm',  pad: '10px 9px',  cls: 'fiscal', h: null   } :
        (cfg.paperSize === 'A5' || type === 'check') ? { w: '148mm', pad: '20px 24px', cls: 'a5',     h: '186mm' } :
        cfg.paperSize === 'Letter'                   ? { w: '215.9mm', pad: '28px 32px', cls: 'letter', h: '255.4mm' } :
                                                       { w: '210mm', pad: '28px 32px', cls: 'a4',     h: '273mm' };
    const pageBg = `linear-gradient(180deg, #f3f5f7, #e7ebee)`;
    const radius = cfg.cornerStyle === 'sharp' ? '0' : '10px';

    return `<!doctype html>
<html lang="${esc(cfg.language || 'en')}"><head>
<meta charset="utf-8">
<title>${esc(title || titleFor(type))} · ${esc(idLine || '')}</title>
<style>
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
    font-family: ${fontStack};
    color: ${cfg.ink};
    background: ${pageBg};
    padding: 28px 18px 60px;
    min-height: 100vh;
    /* Keep branded backgrounds (logo gradient, accent fills, stamp) when
       the browser renders to PDF / paper — without this they are stripped
       and the logo disappears on the real printout. */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
}
.sheet {
    background: ${cfg.paperBg};
    margin: 0 auto;
    padding: ${paper.pad};
    width: ${paper.w};
    max-width: 100%;
    ${paper.h ? `min-height: ${paper.h};` : ''}
    border-radius: ${radius};
    box-shadow: 0 24px 60px rgba(11,20,24,0.10), 0 1px 3px rgba(11,20,24,0.06);
    border: 1px solid rgba(11,20,24,0.06);
    position: relative;
    overflow: hidden;
    /* Flex column so the footer can be pushed to the bottom of the page
       regardless of how short the body is. */
    display: flex;
    flex-direction: column;
}
.row { display: flex; gap: 12px; }
.muted { color: #7a8892; }
.mono { font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; }
.h1 { font-size: 28px; font-weight: 700; color: ${cfg.ink}; line-height: 1.25; letter-spacing: -0.015em; }
.lbl { font-size: 13px; color: #7a8892; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
.pill-solid { display:inline-flex; align-items:center; padding:4px 12px; border-radius:999px; background:${cfg.accent}; color:white; font-size:12.5px; font-weight:700; letter-spacing:0.04em; }
.pill-soft  { display:inline-flex; align-items:center; padding:3px 9px;  border-radius:999px; background:${cfg.accentSoft}; color:${cfg.accent}; font-size:11px; font-weight:700; letter-spacing:0.04em; }
.sect { display:flex; align-items:center; gap:10px; margin:20px 0 12px; }
.sect .num { width:22px; height:22px; border-radius:999px; background:${cfg.accent}; color:white; display:grid; place-items:center; font-size:11px; font-weight:700; }
.sect .txt { font-size:14px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:${cfg.accent}; }
.sect .rule { flex:1; height:1px; background:${cfg.accent}30; }
.info { border:1px solid #e7ebee; border-radius:10px; padding:12px 14px; background:#fafbfc; }
.info .title { font-size:13px; font-weight:700; color:${cfg.accent}; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:6px; }
.info .kv { display:flex; align-items:baseline; gap:8px; padding:4px 0; border-bottom:1px dashed #e7ebee; font-size:15px; }
.info .kv .k { color:#7a8892; min-width:100px; }
.info .kv .v { flex:1; color:${cfg.ink}; font-weight:600; }
.info .kv:last-child { border-bottom: 0; }
.body { font-size:16.5px; color:#1f2d34; line-height:1.65; text-align:justify; }
.vitals { display:grid; grid-template-columns:repeat(var(--cols,5),1fr); gap:8px; }
.vital { padding:10px 12px; border-radius:8px; background:#fafbfc; border:1px solid #e7ebee; }
.vital .lbl { font-size:9.5px; }
.vital .val { display:flex; align-items:baseline; gap:3px; margin-top:2px; }
.vital .val .n { font-size:18px; font-weight:700; color:${cfg.ink}; letter-spacing:-0.01em; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; }
.vital .val .u { font-size:10px; color:#7a8892; }
.vital .val .f { margin-left:auto; font-size:9.5px; font-weight:700; padding:0 5px; border-radius:4px; background:#fde7c5; color:#b45309; }
.lab { border-radius:10px; border:1px solid #e7ebee; overflow:hidden; }
.lab .hd { display:grid; grid-template-columns: 2fr 1.1fr 1.4fr 1.4fr 0.7fr; background:${cfg.accentSoft}; padding:8px 12px; font-size:13px; font-weight:700; color:${cfg.accent}; text-transform:uppercase; letter-spacing:0.08em; }
.lab .hd > .r { text-align:right; }
.lab .row {
    display:grid; grid-template-columns: 2fr 1.1fr 1.4fr 1.4fr 0.7fr;
    padding:8px 12px; align-items:center; border-top:1px solid #f3f5f7; font-size:15px;
}
.lab .row.alt { background:#fafbfc; }
.lab .name { color:${cfg.ink}; font-weight:500; }
.lab .val  { text-align:right; font-family: ui-monospace, Menlo, monospace; font-weight:700; color:${cfg.ink}; }
.lab .val.out { color:#b45309; }
.lab .val .u { color:#7a8892; font-weight:500; font-size:10px; }
.lab .ref  { color:#55636d; font-family: ui-monospace, Menlo, monospace; font-size:11px; }
.lab .bar  { position:relative; height:6px; background:#e7ebee; border-radius:999px; }
.lab .bar .zone { position:absolute; left:15%; right:15%; top:0; bottom:0; background:${cfg.accentSoft}; border-radius:999px; }
.lab .bar .dot { position:absolute; top:-2px; width:10px; height:10px; border-radius:999px; background:${cfg.accent}; border:2px solid white; box-shadow:0 1px 2px rgba(0,0,0,0.18); }
.lab .bar .dot.out { background:#b45309; }
.lab .flag { text-align:right; }
.lab .flag .ok { font-size:10px; font-weight:700; padding:1px 6px; border-radius:4px; background:#ecfdf5; color:#047857; }
.lab .flag .bad { font-size:10px; font-weight:700; padding:1px 6px; border-radius:4px; background:#fde7c5; color:#b45309; }
.checklist { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:7px; }
.checklist li { display:flex; gap:10px; font-size:16px; color:#1f2d34; line-height:1.5; }
.checklist .n { flex:0 0 18px; width:18px; height:18px; border-radius:5px; background:${cfg.accentSoft}; color:${cfg.accent}; display:grid; place-items:center; font-size:10px; font-weight:700; margin-top:1px; font-family: ui-monospace, Menlo, monospace; }
.footer { margin-top:auto; padding-top:16px; border-top:1px solid #e7ebee; font-size:11px; color:#7a8892; line-height:1.6; display:flex; gap:16px; }
.footer .copy { color:${cfg.ink}; font-size:10px; font-weight:600; margin-bottom:2px; }
.footer .legal { font-style: italic; }
.footer .right { text-align:right; }
.footer .right .web { font-family: ui-monospace, Menlo, monospace; color:${cfg.accent}; font-weight:700; }
.diag-tiles { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
.diag-tile { aspect-ratio: 1.1 / 1; background: radial-gradient(ellipse at center, #1f2d34 0%, #0b1418 80%); border-radius:8px; position:relative; overflow:hidden; border: 1px solid ${cfg.accent}40; }
.diag-tile .lbl { position:absolute; top:6px; left:8px; font-size:9px; color:#aab4bc; font-family: ui-monospace, Menlo, monospace; text-transform:uppercase; letter-spacing:0.08em; }
.diag-tile .freq { position:absolute; bottom:6px; right:8px; font-size:9px; color:${cfg.accent}; font-family: ui-monospace, Menlo, monospace; }
.measure { display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; }
.measure .cell { padding:10px 12px; border-radius:8px; background:#fafbfc; border:1px solid #e7ebee; }
.measure .cell .k { font-size:9.5px; color:#7a8892; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; }
.measure .cell .v { display:flex; align-items:baseline; gap:3px; margin-top:2px; }
.measure .cell .v .n { font-size:17px; font-weight:700; color:${cfg.ink}; font-family: ui-monospace, Menlo, monospace; }
.measure .cell .v .u { font-size:10px; color:#7a8892; }
.measure .cell .v .f { margin-left:auto; font-size:9px; font-weight:700; padding:0 5px; border-radius:4px; background:#fde7c5; color:#b45309; }
.measure .cell .ref { font-size:9.5px; color:#7a8892; margin-top:2px; font-family: ui-monospace, Menlo, monospace; }
.signoff { margin-top:26px; display:flex; align-items:flex-end; justify-content:space-between; gap:18px; }
.signoff .who { font-size:14px; color:#55636d; }
.signoff .lic { font-size:13px; color:#7a8892; }
.totals { margin-top:12px; margin-left:auto; max-width:300px; }
.totals .line { display:flex; justify-content:space-between; padding:4px 0; font-size:15px; }
.totals .line.grand { border-top:2px solid ${cfg.accent}; margin-top:4px; padding-top:8px; font-weight:700; font-size:18px; color:${cfg.ink}; }
.totals .line.owe { color:#b91c1c; font-weight:600; }
.wm { position:absolute; inset:0; display:grid; place-items:center; pointer-events:none; opacity:${cfg.watermarkOpacity ?? 0.04}; }
.fiscal-body { font: 11px/1.4 ui-monospace, "JetBrains Mono", monospace; color:#000; white-space:pre; }
/* FISCAL_58MM_V1 — adaptive receipt body: fits 58mm, large black bold, flex rows. */
.fisc { font-family: "Helvetica Neue", Arial, sans-serif; color:#000; line-height:1.3; }
.fisc .f-name { text-align:center; font-size:15px; font-weight:800; line-height:1.15; }
.fisc .f-sub { text-align:center; font-size:9.5px; font-weight:600; margin-top:1px; overflow-wrap:anywhere; }
.fisc .f-hr { border-top:1px dashed #000; margin:5px 0; }
.fisc .f-hr2 { border-top:2px solid #000; margin:5px 0; }
.fisc .f-title { text-align:center; font-size:12.5px; font-weight:800; text-transform:uppercase; margin:3px 0; }
.fisc .f-kv { display:flex; justify-content:space-between; gap:8px; font-size:11.5px; margin:1.5px 0; }
.fisc .f-kv b { font-weight:800; text-align:right; }
.fisc .f-item { margin:3px 0; }
.fisc .f-item-n { font-size:11.5px; font-weight:700; overflow-wrap:anywhere; }
.fisc .f-item-r { display:flex; justify-content:space-between; gap:8px; font-size:11px; font-weight:600; }
.fisc .f-item-r b { font-weight:800; }
.fisc .f-tot { display:flex; justify-content:space-between; gap:8px; font-size:14.5px; font-weight:800; margin:4px 0; border-top:1px solid #000; border-bottom:1px solid #000; padding:3px 0; }
.fisc .f-thanks { text-align:center; font-size:10.5px; font-weight:700; margin-top:5px; }
/* FISCAL_BOLD_ALL_V1 — the thermo-cheque is bold EVERYWHERE (screen preview and
   paper): thin strokes look weak on screen and print faintly on thermal heads.
   Monospace advance width is identical in bold, so columns stay aligned. */
${paper.cls === 'fiscal' ? `.sheet, .sheet * { color: #000 !important; font-weight: 700 !important; -webkit-text-stroke: 0.2px #000; }` : ''}
@media print {
    body { background: white; padding: 0; }
    .sheet { box-shadow: none; border: 0; border-radius: 0; margin: 0; width: 100%; }
    /* DOC_PAGINATE_V1 - почему документ длиннее страницы печатался неправильно.
       На экране .sheet это flex-колонка с overflow:hidden: так подвал
       прижимается к низу листа. Но Chrome НЕ РАЗБИВАЕТ flex-контейнер на
       страницы, а overflow:hidden обрезает всё, что не поместилось. Вместе это
       давало ровно одну страницу: остальное срезалось или рвалось посреди
       таблицы, а break-inside:avoid на секциях игнорировался - внутри
       flex-контейнера он не действует.
       В печати возвращаем обычный блочный поток: страница делится нормально,
       ничего не обрезается, запреты разрыва начинают работать. Подвал при этом
       идёт следом за содержимым, а не приклеен к низу - сознательный размен:
       у документа на три страницы подвал внизу ПЕРВОЙ был бы просто ошибкой. */
    .sheet { display: block; overflow: visible; }
    /* Заголовок таблицы повторяется на каждой странице: иначе на второй
       странице колонки цифр остаются без подписей. */
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    /* Строку результата пополам не рвём - половина значения на одной странице
       и половина на другой это не документ. */
    tr, .lab .row, .lab .hd { break-inside: avoid; page-break-inside: avoid; }
    /* FISCAL_PRINT_SHARP_V1 — thermal heads are 1-bit: greys dither into fuzz
       and any page scaling blurs the glyphs. Force pure black, kill smoothing,
       and let the 80mm roll use its full width (margin 0 below — a 12mm @page
       margin left only 56mm printable, so the browser downscaled the sheet). */
    ${paper.cls === 'fiscal' ? `
    .sheet { padding: 0 1mm; overflow: visible; }
    /* every template element prints solid black — thermal heads dither greys
       into faintness; and 10.5px guarantees the 42-char line fits 74mm with
       slack, so nothing is ever clipped at the right edge */
    /* thermal heads print thin strokes faintly — bold everything (monospace
       advance width is identical in bold, so column alignment is untouched)
       and thicken glyph strokes slightly for solid, dark output */
    .sheet, .sheet * { color: #000 !important; font-weight: 700 !important; -webkit-text-stroke: 0.2px #000; }
    .fiscal-body { font-size: 10.5px; -webkit-font-smoothing: none; text-rendering: optimizeSpeed; }
    ` : ''}
}
@page { size: ${paper.cls === 'a5' ? 'A5' : paper.cls === 'letter' ? 'Letter' : paper.cls === 'fiscal' ? '58mm auto' : 'A4'}; margin: ${paper.cls === 'fiscal' ? '1.5mm' : '12mm'}; }
</style></head><body>
<div class="sheet">
    ${type !== 'fiscal' && cfg.showWatermark ? watermarkMark(cfg) : ''}
    ${body}
</div>
<script>window.onload = () => { setTimeout(() => window.print(), 250); };</script>
</body></html>`;
}

// External-print fallback: caller passes their own body HTML; we wrap it
// with the standard branded header + footer.
function renderCustomBody({ s, type, bodyHtml, idLine, title }) {
    return `
        ${headerHTML(s)}
        <div class="row" style="margin-top:18px;align-items:flex-start;gap:18px;">
            <div style="flex:1">
                <span class="pill-solid">${esc(title || titleFor(type))}</span>
                <div class="h1" style="margin-top:8px;">${esc(title || titleFor(type))}</div>
                ${idLine ? `<div style="font-size:12px;color:#55636d;margin-top:4px;">Document <span class="mono" style="color:${s.ink};font-weight:600;">${esc(idLine)}</span> · ${esc(new Date().toLocaleDateString())}</div>` : ''}
            </div>
        </div>
        ${bodyHtml}
        ${signoffHTML(s, { signerName: '', signerSpec: '', signerLicense: '' })}
        ${footerHTML(s)}
    `;
}

// Per-type built-in body — used by the live preview and as the default
// when no caller-supplied `bodyHtml` is provided.
function renderBuiltinBody({ s, type, data }) {
    switch (type) {
        case 'conclusion': return conclusionBody(s, data);
        // LAB_BLANK_ONE_TEMPLATE_V1 — case 'lab' здесь БЫЛ, но был недостижим:
        // renderDesignedVariant() перехватывает type='lab' в buildSheetHtml()
        // раньше и всегда возвращает документ. Английский labBody() ни разу не
        // печатался и удалён, чтобы бланк результатов остался ровно один.
        case 'diag':       return diagBody(s, data);
        case 'invoice':    return invoiceBody(s, data);
        case 'act':        return actBody(s, data);
        case 'check':      return checkBody(s, data);
        case 'fiscal':     return fiscalBody(s, data);
    }
    return '<div style="padding:24px;color:#999;">No template for this document type yet.</div>';
}

// ---------------------------------------------------------------------------
// Shared atoms
// ---------------------------------------------------------------------------
function fontFor(pair) {
    return pair === 'serif'    ? `"Source Serif Pro", "Georgia", serif` :
           pair === 'clinical' ? `"IBM Plex Sans", "Inter", system-ui, sans-serif` :
                                 `"Inter", "SF Pro Text", system-ui, sans-serif`;
}
function titleFor(type) {
    return ({
        conclusion: 'Medical conclusion',
        lab:        'Laboratory report',
        diag:       'Imaging & diagnostics',
        invoice:    'Invoice',
        act:        'Акт оказанных услуг',
        check:      'Service receipt',
        fiscal:     'Fiscal receipt',
    })[type] || 'Document';
}
function logoSVG(accent) {
    return `<div style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg, ${accent}, ${darken(accent, 0.3)});display:grid;place-items:center;flex:0 0 44px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="22" height="22">
            <path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/>
        </svg>
    </div>`;
}
function darken(hex, by) {
    // Quick & dirty hex darken — used only for the logo gradient. Falls
    // back to the input if parsing fails.
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    const r = Math.max(0, Math.round(parseInt(hex.slice(1, 3), 16) * (1 - by)));
    const g = Math.max(0, Math.round(parseInt(hex.slice(3, 5), 16) * (1 - by)));
    const b = Math.max(0, Math.round(parseInt(hex.slice(5, 7), 16) * (1 - by)));
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}
// LOGO_WORDMARK_V1 — the uploaded logo IS the clinic's wordmark: it already
// carries the name, so printing the name beside it said everything twice.
// hasLogo() decides both halves of that (see headerHTML) — without an uploaded
// logo the built-in gradient mark carries no name and the text must stay.
function hasLogo(s) { return !!(s.logoUrl || s.logoDataUrl); }
function logoMark(s) {
    const _logo = s.logoUrl || s.logoDataUrl;
    if (_logo) {
        // Not a 44px square: a wordmark is WIDE, and forcing it into a square box
        // made object-fit shrink it to a stamp. Fix the HEIGHT, let the width
        // follow the artwork, and cap it so a very long logo can't crowd out the
        // contact block on the right.
        return `<img src="${esc(_logo)}" alt="${esc(s.clinicName)}" style="height:64px;width:auto;max-width:300px;object-fit:contain;object-position:left center;flex:0 1 auto;display:block;" />`;
    }
    return logoSVG(s.accent);
}
function headerHTML(s) {
    return `<div style="display:flex;align-items:center;gap:14px;padding-bottom:18px;border-bottom:2px solid ${s.accent};">
        ${logoMark(s)}
        <div style="flex:1;">
            ${hasLogo(s) ? '' : `<div style="font-size:17px;font-weight:700;letter-spacing:-0.01em;color:${s.ink};">${esc(s.clinicName)}</div>`}
            <div style="font-size:11px;color:#55636d;margin-top:1px;font-weight:500;">${esc(s.tagline)}</div>
        </div>
        <div style="text-align:right;font-size:10.5px;color:#55636d;line-height:1.55;">
            <div>${esc(s.address)}</div>
            <div>${esc(s.phone)} · ${esc(s.email)}</div>
            <div style="color:${s.accent};font-weight:600;">${esc(s.web)}</div>
        </div>
    </div>`;
}
function sectionBar(text, accent, num) {
    return `<div class="sect">
        ${num != null ? `<span class="num">${esc(String(num))}</span>` : ''}
        <span class="txt">${esc(text)}</span>
        <span class="rule"></span>
    </div>`;
}
function infoBlock(accent, ink, title, rows) {
    return `<div class="info">
        <div class="title">${esc(title)}</div>
        ${rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}
    </div>`;
}
// Fallback watermark when no custom logo image is uploaded — renders the
// clinic brand mark (rounded gradient tile + heartbeat), large and faint,
// so the watermark IS the logo rather than a generic cross.
function watermarkSVG(accent) {
    return `<div class="wm">
        <div style="width:46%;max-width:300px;aspect-ratio:1/1;border-radius:18%;background:linear-gradient(135deg, ${accent}, ${darken(accent, 0.3)});display:grid;place-items:center;">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:62%;height:62%;">
                <path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/>
            </svg>
        </div>
    </div>`;
}
function watermarkMark(s) {
    const _logo = s.logoUrl || s.logoDataUrl;
    if (_logo) {
        return `<div class="wm">
            <img src="${esc(_logo)}" alt="" style="width:60%;max-width:340px;object-fit:contain;" />
        </div>`;
    }
    return watermarkSVG(s.accent);
}
function stampSVG(accent) {
    return `<div style="width:96px;height:96px;border-radius:50%;border:2.5px solid ${accent};opacity:0.85;display:grid;place-items:center;transform:rotate(-7deg);position:relative;box-shadow:inset 0 0 0 6px white, inset 0 0 0 7px ${accent};">
        <svg viewBox="0 0 100 100" width="92" height="92" style="position:absolute;inset:0;">
            <defs><path id="circ" d="M50,50 m -34,0 a 34,34 0 1,1 68,0 a 34,34 0 1,1 -68,0"/></defs>
            <text fill="${accent}" font-family="Inter, sans-serif" font-size="8.4" font-weight="700" letter-spacing="1.2">
                <textPath href="#circ" startOffset="2%">CLINIC SEAL · APPROVED · CONFIDENTIAL ·</textPath>
            </text>
        </svg>
        <div style="text-align:center;color:${accent};font-family: ui-monospace, JetBrains Mono, monospace;">
            <div style="font-size:8px;font-weight:700;letter-spacing:0.1em;">EASY-MED</div>
            <div style="font-size:13px;font-weight:700;">✚</div>
            <div style="font-size:7.5px;font-weight:700;">${new Date().getFullYear()}</div>
        </div>
    </div>`;
}
function signatureSVG(accent) {
    return `<svg viewBox="0 0 140 40" width="140" height="40">
        <path d="M4 28 C 12 18, 18 8, 28 18 C 36 28, 30 32, 38 26 C 46 20, 50 14, 58 22 C 64 28, 72 30, 80 22 C 86 16, 92 20, 102 28 C 110 34, 118 20, 134 12" fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M4 34 L 134 34" stroke="#aab4bc" stroke-width="0.5" stroke-dasharray="2 2"/>
    </svg>`;
}
function qrBlock(accent) {
    // Deterministic pseudo-random dot pattern — same generator the sample
    // uses so the QR pattern stays recognisable even though it's not a
    // real verification code.
    let dots = '';
    for (let i = 0; i < 80; i++) {
        const x = 9 + (i % 12);
        const y = 9 + Math.floor(i / 12);
        if ((x * 7 + y * 13) % 5 < 2) continue;
        if (x > 20 || y > 20) continue;
        dots += `<rect x="${x}" y="${y}" width="1" height="1" fill="${accent}"/>`;
    }
    return `<div style="display:flex;align-items:center;gap:10px;">
        <svg width="56" height="56" viewBox="0 0 24 24" style="flex:0 0 56px;">
            <rect x="0" y="0" width="24" height="24" fill="white"/>
            ${[[0,0],[17,0],[0,17]].map(([x,y]) => `<g>
                <rect x="${x}" y="${y}" width="7" height="7" fill="${accent}"/>
                <rect x="${x+1}" y="${y+1}" width="5" height="5" fill="white"/>
                <rect x="${x+2}" y="${y+2}" width="3" height="3" fill="${accent}"/>
            </g>`).join('')}
            ${dots}
        </svg>
        <div style="font-size:9.5px;color:#55636d;line-height:1.55;max-width:130px;">
            <div style="color:${accent};font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Verify</div>
            Scan to verify authenticity. Document hash auto-recorded on issue.
        </div>
    </div>`;
}
function signoffHTML(s, { signerName, signerSpec, signerLicense }) {
    return `<div class="signoff">
        <div style="flex:1;">
            ${s.showSignature ? signatureSVG(s.accent) : ''}
            ${signerName ? `<div class="who">${esc(signerName)}${signerSpec ? ` · ${esc(signerSpec)}` : ''}</div>` : ''}
            ${signerLicense ? `<div class="lic">${esc(signerLicense)}</div>` : ''}
        </div>
        <div style="display:flex;gap:14px;align-items:flex-end;">
            ${s.showQR ? qrBlock(s.accent) : ''}
            ${s.showStamp ? stampSVG(s.accent) : ''}
        </div>
    </div>`;
}
function footerHTML(s) {
    return `<div class="footer">
        <div style="flex:1;">
            <div class="copy">${esc(s.footerNote)}</div>
            <div class="legal">${esc(s.legalNote)}</div>
            ${s.legalName ? `<div style="margin-top:4px;color:#8a949c;font-weight:600;">${esc(s.legalName)}</div>` : ''}
            ${(s.taxId || s.license) ? `<div style="margin-top:4px;color:#aab4bc;">${[s.taxId, s.license].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
        </div>
        <div class="right">
            <div class="web">${esc(s.web)}</div>
            <div>Page 1 of 1</div>
        </div>
    </div>`;
}
function titleBlock(s, { pillText, title, idLabel, idValue, dateStr, rightLabel, rightValue }) {
    return `<div class="row" style="margin-top:18px;align-items:flex-start;gap:18px;">
        <div style="flex:1;">
            <span class="pill-solid">${esc(pillText)}</span>
            <div class="h1" style="margin-top:8px;">${esc(title)}</div>
            <div style="font-size:12px;color:#55636d;margin-top:4px;">${esc(idLabel || 'Document')} <span class="mono" style="color:${s.ink};font-weight:600;">${esc(idValue)}</span>${dateStr ? ` · ${esc(dateStr)}` : ''}</div>
        </div>
        ${rightLabel ? `<div style="text-align:right;">
            <div class="lbl">${esc(rightLabel)}</div>
            <div style="font-size:13px;font-weight:600;color:${s.ink};margin-top:2px;">${esc(rightValue || '')}</div>
        </div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Built-in document bodies — these are the rich templates the preview
// shows. External callers (invoice/lab/etc.) can pass a `data` blob to
// override the placeholder content with real values.
// ---------------------------------------------------------------------------
function conclusionBody(s, d) {
    d = d || sampleConclusion();
    const sec = (label, text) => text ? `${sectionBar(label, s.accent)}<div class="body">${esc(text)}</div>` : '';
    const rxItems = (d.prescriptions || []);
    const rxHtml = rxItems.length ? `${sectionBar('Рецепт', s.accent)}<ol class="checklist">${rxItems.map((r, i) => `<li><span class="n">${i + 1}</span><span><b>${esc(r.name || '')}</b>${r.dose ? ' · ' + esc(r.dose) : ''}${(r.freq || r.dur || r.notes) ? `<br><span style="color:#55636d;font-size:11.5px;">${esc([r.freq, r.dur, r.notes].filter(Boolean).join(' · '))}</span>` : ''}</span></li>`).join('')}</ol>` : '';
    const refItems = (d.referrals || []);
    const refHtml = refItems.length ? `${sectionBar('Рекомендованные услуги', s.accent)}<ol class="checklist">${refItems.map((r, i) => `<li><span class="n">${i + 1}</span><span>${esc(r.name || '')}${r.note ? ` · <span style="color:#55636d;">${esc(r.note)}</span>` : ''}</span></li>`).join('')}</ol>` : '';
    const dxBlock = d.dx ? `${sectionBar('Диагноз', s.accent)}<div style="padding:12px 14px;border-radius:8px;background:${s.accentSoft};border:1px solid ${s.accent}30;">${d.icd10 ? `<div style="font-size:11px;color:${s.accent};font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">МКБ-10 · ${esc(d.icd10)}</div>` : ''}<div style="font-size:14.5px;font-weight:700;color:${s.ink};margin-top:3px;">${esc(d.dx)}</div></div>` : '';
    return `
        ${headerHTML(s)}
        ${titleBlock(s, {
            pillText: 'Медицинское заключение',
            title:    d.title || 'Заключение приёма',
            idLabel:  'Документ',
            idValue:  d.docNo || '—',
            dateStr:  d.issueDate || ('Дата: ' + new Date().toLocaleDateString('ru-RU')),
            rightLabel: 'Тип визита',
            rightValue: d.visitType || 'Амбулаторный',
        })}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px;">
            ${infoBlock(s.accent, s.ink, 'Пациент', d.patient || [['ФИО', d.patientName || '—'], ['Дата рождения', d.dob || '—'], ['Пол', d.sex || '—'], ['ID пациента', d.mrn || '—']])}
            ${infoBlock(s.accent, s.ink, 'Лечащий врач', d.doctor || [['Врач', d.doctorName || '—'], ['Специальность', d.doctorSpec || '—'], ['Услуга', d.service || '—'], ['Телефон', d.phone || '—']])}
        </div>
        ${sec('Жалобы', d.complaint)}
        ${sec('Анамнез', d.hpi)}
        ${sec('Лабораторные исследования', d.labs)}
        ${sec('Инструментальные исследования', d.instrumental)}
        ${sec('Осмотр', d.exam)}
        ${dxBlock}
        ${sec('Терапия', d.therapy)}
        ${sec('Рекомендации', d.recsText)}
        ${rxHtml}
        ${refHtml}
        ${signoffHTML(s, { signerName: d.doctorName || '—', signerSpec: d.doctorSpec || '', signerLicense: d.signerLicense || ('Подписано ' + new Date().toLocaleString('ru-RU')) })}
        ${footerHTML(s)}
    `;
}


function diagBody(s, d) {
    d = d || sampleDiag();
    const tiles = (d.views || ['PLAX view','PSAX view','Apical 4-ch']).map((lbl, i) => `
        <div class="diag-tile">
            <svg viewBox="0 0 100 90" style="position:absolute;inset:0;width:100%;height:100%;">
                <defs>
                    <radialGradient id="g${i}" cx="50%" cy="0%" r="80%">
                        <stop offset="0%" stop-color="#d3d9de" stop-opacity="0.9"/>
                        <stop offset="40%" stop-color="#aab4bc" stop-opacity="0.5"/>
                        <stop offset="100%" stop-color="#324049" stop-opacity="0.05"/>
                    </radialGradient>
                </defs>
                <polygon points="50,5 95,85 5,85" fill="url(#g${i})"/>
                <ellipse cx="50" cy="48" rx="22" ry="14" stroke="#e7ebee" stroke-width="0.6" fill="none" opacity="0.7"/>
                <ellipse cx="50" cy="48" rx="14" ry="9" stroke="#e7ebee" stroke-width="0.5" fill="#0b1418" opacity="0.8"/>
                <path d="M30 55 Q 50 38 70 55" stroke="${s.accent}" stroke-width="0.7" fill="none" opacity="0.8"/>
            </svg>
            <span class="lbl">${esc(lbl)}</span>
            <span class="freq">HR 78 · 2.5 MHz</span>
        </div>`).join('');
    const cells = (d.measurements || sampleDiag().measurements).map(m => `
        <div class="cell">
            <div class="k">${esc(m.k)}</div>
            <div class="v"><span class="n">${esc(m.v)}</span><span class="u">${esc(m.u || '')}</span>${m.flag ? `<span class="f">${esc(m.flag)}</span>` : ''}</div>
            <div class="ref">ref ${esc(m.range)}</div>
        </div>`).join('');
    return `
        ${headerHTML(s)}
        ${titleBlock(s, {
            pillText: 'Imaging & diagnostics',
            title:    d.title || 'Echocardiography · transthoracic',
            idLabel:  'Study',
            idValue:  d.docNo || 'DX-2026-02744',
            dateStr:  d.issueDate || `${new Date().toLocaleDateString()}, ${new Date().toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit'})} · Cardiology suite`,
        })}
        <div style="text-align:right;font-size:11px;color:#55636d;line-height:1.6;margin-top:6px;">
            <div><b style="color:${s.ink};">${esc(d.patientName || 'Aliyev Bobur A.')}</b></div>
            <div>${esc(d.patientMeta || 'MRN-04188 · 42y · M')}</div>
            <div>Performed by ${esc(d.performer || 'Dr. D. Juraev')}</div>
        </div>
        ${sectionBar('Imaging', s.accent)}
        <div class="diag-tiles">${tiles}</div>
        ${sectionBar('Measurements', s.accent)}
        <div class="measure">${cells}</div>
        ${sectionBar('Findings', s.accent, 1)}
        <div class="body">${esc(d.findings || 'Left ventricle of normal size with preserved systolic function (LVEF 58%). Mild septal hypertrophy (IVSd 12 mm) consistent with chronic hypertensive remodeling. Grade I diastolic dysfunction (E/A 0.9, normal e′). Valves structurally normal; trivial mitral regurgitation, no aortic regurgitation or stenosis. Right ventricle and atria within normal limits. No pericardial effusion.')}</div>
        ${sectionBar('Impression', s.accent, 2)}
        <div style="padding:14px 16px;border-radius:10px;background:${s.accentSoft};border:1px solid ${s.accent}30;">
            <div style="font-size:13.5px;font-weight:700;color:${s.ink};line-height:1.5;">
                ${esc(d.impression || 'Preserved LVEF · mild septal hypertrophy · grade I diastolic dysfunction.')}<br/>
                <span style="font-weight:500;color:#324049;">${esc(d.impressionExtra || 'Findings are compatible with hypertensive heart disease without overt cardiomyopathy.')}</span>
            </div>
        </div>
        ${signoffHTML(s, {
            signerName:    d.signerName    || 'D. Juraev, MD',
            signerSpec:    d.signerSpec    || 'Cardiac imaging',
            signerLicense: d.signerLicense || 'Verified',
        })}
        ${footerHTML(s)}
    `;
}

function invoiceBody(s, d) {
    d = d || sampleInvoice();
    const items = (d.items || []).map(it => {
        const subtotal = Number(it.qty || 1) * Number(it.price || 0);
        return `<div class="row ${it._alt ? 'alt' : ''}" style="grid-template-columns: 2fr 1fr 1.4fr 1.4fr;">
            <span class="name">${esc(it.name)}</span>
            <span class="val" style="font-weight:500;color:#55636d;">${esc(String(it.qty || 1))}</span>
            <span class="val">${Number(it.price || 0).toLocaleString('ru-RU')} <span class="u">UZS</span></span>
            <span class="val">${subtotal.toLocaleString('ru-RU')} <span class="u">UZS</span></span>
        </div>`;
    }).join('');
    const subtotal = Number(d.subtotal || 0);
    const tax      = Number(d.tax || 0);
    const total    = Number(d.total || 0);
    const paid     = Number(d.paid || 0);
    const owed     = Math.max(total - paid, 0);
    return `
        ${headerHTML(s)}
        ${titleBlock(s, {
            pillText: 'Invoice',
            title:    d.title || 'Outpatient services',
            idLabel:  'Invoice',
            idValue:  d.docNo || 'INV-2026-00014',
            dateStr:  d.issueDate || `Issued ${new Date().toLocaleDateString()}`,
            rightLabel: 'Status',
            rightValue: (d.status || 'PAID').toUpperCase(),
        })}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px;">
            ${infoBlock(s.accent, s.ink, 'Patient', d.patient || [
                ['Full name', 'Aliyev Bobur Akmalovich'],
                ['MRN', 'MRN-04188'],
                ['Phone', '+998 89 555 55 55'],
            ])}
            ${infoBlock(s.accent, s.ink, 'Billing', d.billing || [
                ['Issue date', new Date().toLocaleDateString()],
                ['Due', 'On receipt'],
                ['Payer', 'Self-pay'],
                ['Cashier', 'Desk #1'],
            ])}
        </div>
        ${sectionBar('Services', s.accent)}
        <div class="lab">
            <div class="hd" style="grid-template-columns: 2fr 1fr 1.4fr 1.4fr;">
                <span>Service</span><span class="r">Qty</span><span class="r">Price</span><span class="r">Subtotal</span>
            </div>
            ${items || '<div class="row"><span style="color:#999;">No items.</span></div>'}
        </div>
        <div class="totals">
            <div class="line"><span>Subtotal</span><span>${subtotal.toLocaleString('ru-RU')} UZS</span></div>
            ${tax > 0 ? `<div class="line"><span>VAT (12 %)</span><span>${tax.toLocaleString('ru-RU')} UZS</span></div>` : ''}
            <div class="line grand"><span>Total</span><span>${total.toLocaleString('ru-RU')} UZS</span></div>
            ${paid > 0 ? `<div class="line"><span>Paid</span><span>${paid.toLocaleString('ru-RU')} UZS</span></div>` : ''}
            ${owed > 0 ? `<div class="line owe"><span>Outstanding</span><span>${owed.toLocaleString('ru-RU')} UZS</span></div>` : ''}
        </div>
        ${signoffHTML(s, {
            signerName:    d.cashierName  || 'Cashier · Desk #1',
            signerSpec:    '',
            signerLicense: `Receipt fixed in fiscal memory · ${new Date().toLocaleString('ru-RU')}`,
        })}
        ${footerHTML(s)}
    `;
}

// Медицинский акт оказанных услуг — печатается для непациентских плательщиков
// (ДМС / B2B / госпрограмма) вместо счёта. Пациент подписывает после оказания
// услуг; акт используется для сверки и выставления счёта плательщику.
function actBody(s, d) {
    d = d || {};
    const items = (d.items || []).map(it => {
        const gross = Number(it.qty || 1) * Number(it.price || 0);
        const disc  = Number(it.disc || 0);
        const net   = Math.round(gross * (1 - disc / 100));
        return `<div class="row ${it._alt ? 'alt' : ''}" style="grid-template-columns: 2fr 0.7fr 1.1fr 0.8fr 1.1fr 0.5fr;">
            <span class="name">${esc(it.name)}</span>
            <span class="val" style="font-weight:500;color:#55636d;">${esc(String(it.qty || 1))}</span>
            <span class="val">${Number(it.price || 0).toLocaleString('ru-RU')} <span class="u">UZS</span></span>
            <span class="val">${disc ? disc + ' %' : '—'}</span>
            <span class="val">${net.toLocaleString('ru-RU')} <span class="u">UZS</span></span>
            <span class="val" style="text-align:center;font-size:14px;line-height:1;">☐</span>
        </div>`;
    }).join('');
    const subtotal      = (d.items || []).reduce((a, it) => a + Number(it.qty || 1) * Number(it.price || 0), 0);
    const discountTotal = (d.items || []).reduce((a, it) => { const g = Number(it.qty || 1) * Number(it.price || 0); return a + Math.round(g * (Number(it.disc || 0) / 100)); }, 0);
    const total         = subtotal - discountTotal;
    return `
        ${headerHTML(s)}
        ${titleBlock(s, {
            pillText:   'Акт услуг',
            title:      d.title || 'Акт оказанных медицинских услуг',
            idLabel:    'Акт',
            idValue:    d.docNo || '—',
            dateStr:    d.issueDate || `Дата ${new Date().toLocaleDateString('ru-RU')}`,
            rightLabel: 'Оплата',
            rightValue: d.coverage || 'По договору',
        })}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px;">
            ${infoBlock(s.accent, s.ink, 'Пациент', d.patient || [
                ['ФИО', '—'], ['Карта №', '—'], ['Дата рождения', '—'],
            ])}
            ${infoBlock(s.accent, s.ink, 'Плательщик / организация', d.payer || [
                ['Организация', '—'], ['Полис', '—'], ['Покрытие', '100%'],
            ])}
        </div>
        ${sectionBar('Оказанные услуги', s.accent)}
        <div class="lab">
            <div class="hd" style="grid-template-columns: 2fr 0.7fr 1.1fr 0.8fr 1.1fr 0.5fr;">
                <span>Услуга</span><span class="r">Кол-во</span><span class="r">Цена</span><span class="r">Скидка</span><span class="r">Сумма</span><span class="r" style="text-align:center;">✓</span>
            </div>
            ${items || '<div class="row"><span style="color:#999;">Нет услуг.</span></div>'}
        </div>
        <div class="totals">
            <div class="line"><span>Подытог</span><span>${subtotal.toLocaleString('ru-RU')} UZS</span></div>
            <div class="line"><span>Скидка</span><span>−${discountTotal.toLocaleString('ru-RU')} UZS</span></div>
            <div class="line grand"><span>Итого:</span><span>${total.toLocaleString('ru-RU')} UZS</span></div>
        </div>
        <div style="margin-top:40px;font-size:11.5px;color:#55636d;"><!-- ACT_PROTOCOL_SIGN_V1 -->
            <div style="display:flex;gap:28px;">
                <div style="flex:1;border-top:1px solid ${s.ink};padding-top:6px;">Пациент<br><span style="font-size:10px;color:#8a96a0;">подпись / Ф.И.О.</span></div>
                <div style="flex:1;border-top:1px solid ${s.ink};padding-top:6px;">Врач<br><span style="font-size:10px;color:#8a96a0;">подпись / Ф.И.О.</span></div>
                <div style="flex:1;border-top:1px solid ${s.ink};padding-top:6px;">Представитель страховой<br><span style="font-size:10px;color:#8a96a0;">подпись / Ф.И.О.</span></div>
            </div>
            <div style="display:flex;gap:28px;margin-top:28px;align-items:flex-end;">
                <div style="flex:1;border-top:1px solid ${s.ink};padding-top:6px;">Дата</div>
                <div style="flex:1;text-align:center;">М.П.<br><span style="font-size:10px;color:#8a96a0;">место печати</span></div>
                <div style="flex:1;"></div>
            </div>
        </div>
        ${footerHTML(s)}
    `;
}
function checkBody(s, d) {
    d = d || sampleCheck();
    const lines = (d.items || []).map(it => `
        <div class="row" style="grid-template-columns: 2fr 1fr 1.4fr;">
            <span class="name">${esc(it.name)}</span>
            <span class="val" style="font-weight:500;color:#55636d;">${esc(String(it.qty || 1))}</span>
            <span class="val">${Number(it.price || 0).toLocaleString('ru-RU')} <span class="u">UZS</span></span>
        </div>`).join('');
    return `
        ${headerHTML(s)}
        ${titleBlock(s, {
            pillText: 'Service receipt',
            title:    d.title || 'Cardiology consultation',
            idLabel:  'Check',
            idValue:  d.docNo || 'CHK-2026-00872',
            dateStr:  d.issueDate || new Date().toLocaleString('ru-RU'),
            rightLabel: 'Method',
            rightValue: (d.method || 'Cash').toString(),
        })}
        ${sectionBar('Service', s.accent)}
        <div class="lab">
            <div class="hd" style="grid-template-columns: 2fr 1fr 1.4fr;">
                <span>Service</span><span class="r">Qty</span><span class="r">Amount</span>
            </div>
            ${lines}
        </div>
        <div class="totals">
            <div class="line grand"><span>Paid</span><span>${(Number(d.total) || 0).toLocaleString('ru-RU')} UZS</span></div>
        </div>
        ${signoffHTML(s, {
            signerName:    d.cashierName  || 'Cashier · Desk #1',
            signerSpec:    '',
            signerLicense: `Cash desk · ${new Date().toLocaleString('ru-RU')}`,
        })}
        ${footerHTML(s)}
    `;
}

function fiscalBody(s, d) {
    d = d || sampleFiscal();
    const money = (n) => (Number(n) || 0).toLocaleString('ru-RU');
    const itemsHtml = (d.items || []).map(it => {
        const qty = Number(it.qty || 1) || 1;
        const price = Number(it.price || 0);
        return `<div class="f-item"><div class="f-item-n">${esc(it.name || '—')}</div>`
             + `<div class="f-item-r"><span>${qty} × ${money(price)}</span><b>${money(qty * price)}</b></div></div>`;
    }).join('');
    const ofd = (d.ofdTicket && d.ofdTicket !== '—') ? `<div class="f-sub">ОФД: ${esc(d.ofdTicket)}</div>` : '';
    const tax = Number(d.tax) || 0;
    return `<div class="fisc">`
        + `<div class="f-name">${esc((s.clinicName || 'Клиника').toUpperCase())}</div>`
        + ((s.address || s.taxId) ? `<div class="f-sub">${[s.address, s.taxId ? 'ИНН ' + s.taxId : ''].filter(Boolean).map(esc).join(' · ')}</div>` : '')
        + (s.phone ? `<div class="f-sub">${esc(s.phone)}</div>` : '')
        + `<div class="f-hr2"></div>`
        + `<div class="f-title">Чек об оплате</div>`
        + `<div class="f-kv"><span>Чек №</span><b>${esc(d.docNo || '—')}</b></div>`
        + `<div class="f-kv"><span>Дата</span><b>${esc(new Date().toLocaleString('ru-RU').slice(0, 16))}</b></div>`
        // RECEIPT_PATIENT_ID_V1 — блок пациента. Чек служит талоном: с ним идут
        // в лабораторию и в кабинет, и там по нему сверяют человека. Раньше на
        // чеке не было НИ ОДНОГО признака пациента — только услуги и сумма.
        // Печатаем блок, лишь когда данные переданы: пустые строки на 58-мм
        // ленте — это выброшенная бумага.
        + (d.patientName || d.mrn || d.dob || d.sex ? (
            `<div class="f-hr"></div>`
            + (d.patientName ? `<div class="f-kv"><span>Пациент</span><b>${esc(d.patientName)}</b></div>` : '')
            + (d.mrn         ? `<div class="f-kv"><span>Карта №</span><b>${esc(d.mrn)}</b></div>` : '')
            + (d.dob         ? `<div class="f-kv"><span>Дата рожд.</span><b>${esc(d.dob)}</b></div>` : '')
            + (d.sex         ? `<div class="f-kv"><span>Пол</span><b>${esc(d.sex)}</b></div>` : '')
        ) : '')
        + `<div class="f-hr"></div>`
        + (itemsHtml || `<div class="f-sub">Нет позиций</div>`)
        + `<div class="f-hr"></div>`
        + `<div class="f-kv"><span>Подытог</span><b>${money(d.subtotal)}</b></div>`
        + (tax > 0 ? `<div class="f-kv"><span>НДС</span><b>${money(tax)}</b></div>` : '')
        + `<div class="f-tot"><span>ИТОГО</span><b>${money(d.total)} UZS</b></div>`
        + `<div class="f-kv"><span>Оплата</span><b>${esc(d.method || 'наличные')}</b></div>`
        + ofd
        + `<div class="f-hr"></div>`
        + `<div class="f-thanks">Спасибо за визит!</div>`
        + `</div>`;
}
function pad(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n); }

// ---------------------------------------------------------------------------
// Placeholder data — used for the preview, and as a fallback when an
// external caller doesn't supply real data.
// ---------------------------------------------------------------------------
function sampleConclusion() {
    return {
        title: 'Заключение приёма', docNo: 'ЗК-2026-00042', visitType: 'Амбулаторный · плановый',
        patientName: 'Алиев Бобур Акмалович', dob: '14.03.1984 · 42 г.', sex: 'Мужской', mrn: 'MRN-04188', phone: '+998 90 123 45 67',
        doctorName: 'О. Юсупов', doctorSpec: 'Терапевт', service: 'Приём (осмотр, консультация)',
        complaint: 'Периодические головные боли и повышение АД в течение 2 недель, усиливающиеся к вечеру.',
        hpi: 'Считает себя больным около 2 недель. Связывает с эмоциональными нагрузками. Наследственность по ГБ отягощена.',
        labs: 'ОАК — без значимых отклонений. Глюкоза 5.4 ммоль/л. Холестерин 5.1 ммоль/л.',
        instrumental: 'ЭКГ — синусовый ритм, ЧСС 76 в мин, без острых изменений.',
        exam: 'Состояние удовлетворительное. АД 138/86 мм рт.ст. Тоны сердца ясные, ритмичные. Дыхание везикулярное.',
        dx: 'Артериальная гипертензия I степени, риск 2', icd10: 'I10',
        therapy: 'Эналаприл 5 мг 2 раза в день. Контроль АД утром и вечером, ведение дневника.',
        recsText: 'Диета с ограничением соли (<5 г/сут). Регулярная физическая активность. Повторный приём через 2 недели.',
        prescriptions: [{ name: 'Эналаприл', dose: '5 мг', freq: '2 раза/день', dur: '14 дней' }, { name: 'Индапамид', dose: '1.5 мг', freq: 'утром', dur: '14 дней' }],
        referrals: [{ name: 'Консультация кардиолога', note: 'при сохранении АД' }, { name: 'СМАД', note: '' }],
    };
}
function sampleDiag() {
    return {
        measurements: [
            { k: 'LVEF',    v: '58',  u: '%',    range: '≥ 55',  flag: null },
            { k: 'LVEDD',   v: '48',  u: 'mm',   range: '37–55', flag: null },
            { k: 'IVSd',    v: '12',  u: 'mm',   range: '6–11',  flag: 'H' },
            { k: 'LA',      v: '38',  u: 'mm',   range: '< 40',  flag: null },
            { k: 'Ao root', v: '32',  u: 'mm',   range: '20–37', flag: null },
            { k: 'E/A',     v: '0.9', u: '',     range: '> 1.0', flag: 'L' },
            { k: 'TAPSE',   v: '22',  u: 'mm',   range: '> 17',  flag: null },
            { k: 'PASP',    v: '24',  u: 'mmHg', range: '< 35',  flag: null },
        ],
    };
}
function sampleInvoice() {
    return {
        items: [
            { name: 'Consultation · Cardiology',           qty: 1, price: 250000 },
            { name: 'Echocardiography · transthoracic',    qty: 1, price: 350000, _alt: true },
            { name: 'Lab panel · metabolic + HbA1c',       qty: 1, price: 195000 },
        ],
        subtotal: 795000, tax: 95400, total: 890400, paid: 890400, status: 'paid',
    };
}
function sampleCheck() {
    return { items: [{ name: 'Consultation · Cardiology', qty: 1, price: 250000 }], total: 250000, method: 'Cash' };
}
function sampleFiscal() {
    return {
        items: [
            { name: 'Cardiology consultation', qty: 1, price: 250000 },
            { name: 'Echocardiography',        qty: 1, price: 350000 },
            { name: 'Lab panel',               qty: 1, price: 195000 },
        ],
        // RECEIPT_PATIENT_ID_V1 — превью в Настройки → Документы должно показывать
        // блок пациента, иначе администратор не увидит, что чек его печатает.
        patientName: 'Алиев Бобур Акмалович', mrn: 'P-26-04188',
        dob: '14.03.1984 · 42 г.', sex: 'Мужской',
        subtotal: 795000, tax: 95400, total: 890400, method: 'card', ofdTicket: '4188-2240-9812',
    };
}
