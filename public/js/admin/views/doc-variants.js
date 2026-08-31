// Designed document variants — ported from the Medion Design System handout (Claude Design, 2026-06-09).
// Each renderer returns a FULL standalone HTML document, themed from `s` (clinic branding: accent, ink,
// accentSoft, logo, name, address, contacts, footer/legal, show* toggles) and filled from `d` (document data).
// renderDesignedVariant(type, variant, s, d) -> HTML string, or null so doc-settings.js falls back.
//
// Two variants per type (user decision 2026-06-09):
//   classic = full colour + branding (richer)        compact = ink-economy + small branding (denser, B&W)
// DOC_FONT_UP_V3 — all inline font sizes scaled up (~x1.35 small / x1.25 mid / x1.1 large): printed documents were too small to read.

// ONEST_TYPOGRAPHY_V1 — каждый вариант — полный standalone-документ со своим
// <style>; admin.css сюда не попадает, поэтому @font-face вставляется в каждый
// шаблон из общего модуля. Печать получает только СЕМЕЙСТВО — размеры бланков
// остаются их выверенными метриками (дизайн-док 2026-08-31, решение владельца).
import { PRINT_FONT_FACE_CSS } from '../../shared/print-fonts.js';

function esc(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function lines(t) { return String(t || '').split(/\n+/).map(x => x.trim()).filter(Boolean); }
function logoTag(s, px) {
    const url = s.logoUrl || s.logoDataUrl;
    if (url) return `<img src="${esc(url)}" alt="" style="width:${px}px;height:auto;display:block;object-fit:contain;">`;
    return `<div style="width:${px}px;height:${px}px;border-radius:9px;background:var(--accent);display:flex;align-items:center;justify-content:center;flex:none;">
        <svg viewBox="0 0 24 24" width="${Math.round(px * 0.6)}" height="${Math.round(px * 0.6)}" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/></svg>
    </div>`;
}
function toggleCls(s) {
    // STAMP_ONLY_V1 — signature + QR removed app-wide; only the stamp circle remains on documents.
    return [s.showStamp !== false ? 'show-stamp' : ''].filter(Boolean).join(' ');
}

// ECONOMY_BW_V1 — «Компактный · эконом» on a black-and-white printer came out as
// a flat wall of text: no rules, no section blocks, nothing separating anything.
//
// Two independent causes, both of which had to be fixed:
//
//  1. Rules drawn as BACKGROUNDS. `.hr` was `height:2px; background:var(--ink)`
//     — an element whose only visual is a background. Browsers do not print
//     backgrounds unless the user ticks «Background graphics» (off by default in
//     Chrome), and print-color-adjust:exact is honoured unevenly across drivers
//     and not at all by some. So the header rule, the chip separators and the
//     list bullets simply were not there on paper. A BORDER always prints, in
//     every browser, whatever that checkbox says — so the economy sheet draws
//     every rule with one.
//
//  2. Greys chosen for a colour screen. `--bar:#f2f3f5` (4% grey) and
//     `--line:#e2e4e9` (11%) look like tidy separators on a monitor; a mono
//     laser renders them as blank paper. The variants' own @media print block
//     darkened the TEXT greys (--ink/--muted/--faint) but left these structural
//     ones untouched, which is why the text survived and the structure did not.
//
// Appended LAST in each compact variant's <style> so it wins on specificity
// ties. Only the compact variants get it: the classic ones are designed for a
// colour printer and keep their tinted panels.
const ECONOMY_BW_CSS = `
/* --- ECONOMY_BW_V1 : structure that survives a mono printer --------------- */
.hr{ height:0 !important; background:none !important; border-top:2px solid var(--ink); }
.secbar{ background:none !important; border-radius:0; padding:3px 1px 2px;
         border-top:1.4px solid var(--ink); border-bottom:.6px solid var(--ink); }
.meta .chip + .chip::before{ background:none !important; border-left:1px solid var(--muted); }
ul.recs li::before{ background:none !important; border:1.2px solid var(--ink); }
/* The clinic's footer note («Спасибо за обращение…») was rendered by the classic
   CONCLUSION only — every economy sheet dropped it, so text typed in «Компания»
   silently never appeared. Its own class, because the compact variants disagree
   on whether the small print is .legal or .note. */
.thanks-eco{ font-size:10.5px; line-height:1.45; text-align:center; color:var(--ink-2); margin-top:8px; }
@media print{
  /* Structural greys, dark enough to read once greyscaled. */
  :root{ --line:#6b7280 !important; --line-2:#8b919c !important; --bar:#ffffff !important; }
  /* Belt and braces: the rules below are borders, so they print even if the
     browser drops every background on the page. */
  table.res thead th, table.rx thead th, table.items thead th{ border-bottom:1px solid var(--ink); }
  table.res tbody td, table.rx tbody td, table.items tbody td{ border-bottom:.75px solid var(--line-2); }
  .pstrip{ border-top:1px solid var(--muted); border-bottom:1px solid var(--muted); }
  .fld{ border-bottom:1px dotted var(--muted); }
  .qr{ border:1px solid var(--ink); }
}`;
const QR_SVG = `<svg viewBox="0 0 25 25" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h7v7h-7z M1 1v5h5v-5z M2 2h3v3h-3z M18 0h7v7h-7z M19 1v5h5v-5z M20 2h3v3h-3z M0 18h7v7h-7z M1 19v5h5v-5z M2 20h3v3h-3z"/><rect x="9" y="1" width="1" height="1"/><rect x="11" y="1" width="1" height="1"/><rect x="13" y="1" width="1" height="1"/><rect x="9" y="9" width="2" height="2"/><rect x="13" y="9" width="1" height="1"/><rect x="15" y="9" width="1" height="1"/><rect x="11" y="11" width="1" height="1"/><rect x="14" y="11" width="1" height="1"/><rect x="9" y="13" width="1" height="1"/><rect x="12" y="13" width="1" height="1"/><rect x="16" y="13" width="1" height="1"/><rect x="18" y="9" width="1" height="1"/><rect x="20" y="10" width="1" height="1"/><rect x="22" y="9" width="1" height="1"/><rect x="9" y="18" width="1" height="1"/><rect x="11" y="19" width="1" height="1"/><rect x="13" y="18" width="1" height="1"/><rect x="18" y="18" width="1" height="1"/><rect x="20" y="19" width="1" height="1"/><rect x="22" y="20" width="1" height="1"/><rect x="24" y="18" width="1" height="1"/></svg>`;
const SIG_SVG = `<svg viewBox="0 0 180 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 28 C 18 6, 26 6, 30 22 C 33 34, 40 34, 46 18 C 52 4, 60 6, 60 22 C 60 32, 68 30, 78 18 C 92 2, 104 2, 100 20 C 96 36, 112 32, 128 16 C 140 4, 150 10, 146 22 C 158 18, 170 16, 176 20" stroke="var(--ink)" stroke-width="2.2" stroke-linecap="round"/></svg>`;

// LAB_MULTI_REF_V1 — the reference cell used to be a single string. An analyte
// with several named ranges (hormones by cycle phase / menopause, paediatric age
// bands…) now arrives as a newline-separated block, one «Label: 3,5 – 12,5» per
// line, with «•» marking the range that matches this patient's sex/age. Render
// those as stacked lines and bold the match; a single-line value is emitted
// exactly as before, so every existing report is byte-identical.
function refCellHtml(ref) {
    const raw = String(ref == null ? '' : ref);
    if (!raw) return '';
    const lines = raw.split('\n').map(x => x.trim()).filter(Boolean);
    // LAB_REF_ALL_V1 - '•' это МАРКЕР подходящей строки, а не текст.
    // Одиночную строку раньше отдавали сырой, и в бланк уезжала точка.
    if (lines.length <= 1) {
        const one = lines[0] || raw;
        return one.charAt(0) === '•'
            ? `<span class="rr hit">${esc(one.slice(1).trim())}</span>`
            : esc(one);
    }
    return lines.map(l => {
        const hit = l.charAt(0) === '•';
        const txt = hit ? l.slice(1).trim() : l;
        return `<span class="rr${hit ? ' hit' : ''}">${esc(txt)}</span>`;
    }).join('');
}

// QUEUE_TICKET_V2 — the queue block closes both 58mm slips: the registration
// invoice (invoiceThermal) and the cashier's fiscal cheque (fiscalClassic).
// Defined once so the two can never drift apart. The number is the biggest type
// on the page — the patient reads it off a door or a board from a few metres.
// No letter prefix: the destination line above already names the queue.
const QUEUE_CSS = `
.f-q{ margin-top:4px; }
.f-q-h{ text-align:center; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; }
.f-q-item{ text-align:center; margin:7px 0 3px; }
.f-q-item + .f-q-item{ border-top:1px dashed #000; padding-top:6px; }
.f-q-s{ font-size:10px; font-weight:700; overflow-wrap:anywhere; line-height:1.25; }
.f-q-d{ font-size:10px; font-weight:800; text-transform:uppercase; overflow-wrap:anywhere; line-height:1.25; }
.f-q-n{ font-size:40px; font-weight:800; line-height:1.05; margin-top:2px; }`;

// d.queue = [{ service, label, number, key }]. Absent/empty/malformed -> '' so
// every caller that doesn't supply it (and every slip printed before this
// existed) renders exactly as it did.
//
// QUEUE_ONE_PER_VISIT_V1 — a number belongs to a DESTINATION, not to a service.
// All lab tests of one check are one place in the lab queue, so the DB now hands
// back the same number on several rows. Collapse those into a single block that
// names the destination once and lists the services under one number; printing
// the number once per service is what made a patient with two lab tests believe
// they had to queue twice. Lab + diagnostics + consultation still print three
// blocks, because those are three destinations.
//
// Grouped by `key` (the queue_key the DB counted against) when the caller
// supplies it, falling back to the printed label so older callers still merge.
function queueBlockHtml(d) {
    const rows = Array.isArray(d && d.queue) ? d.queue.filter(q => q && q.number) : [];
    if (!rows.length) return '';
    const groups = [];
    const byKey = new Map();
    rows.forEach(q => {
        const gk = String(q.key || q.label || '') + '\0' + String(q.number);
        let g = byKey.get(gk);
        if (!g) { g = { label: q.label || '', number: q.number, services: [] }; byKey.set(gk, g); groups.push(g); }
        if (q.service && g.services.indexOf(q.service) === -1) g.services.push(q.service);
    });
    return `<div class="f-hr2"></div><div class="f-q">
<div class="f-q-h">${groups.length > 1 ? 'Номера очереди' : 'Номер очереди'}</div>
${groups.map(g => `<div class="f-q-item">${g.label ? `<div class="f-q-d">${esc(g.label)}</div>` : ''}${g.services.map(sv => `<div class="f-q-s">${esc(sv)}</div>`).join('')}<div class="f-q-n">${esc(String(g.number))}</div></div>`).join('')}
</div>`;
}

export function renderDesignedVariant(type, variant, s, d) {
    d = d || {};
    if (type === 'conclusion') return (variant === 'compact') ? conclusionCompact(s, d) : conclusionClassic(s, d);
    if (type === 'lab') { const ld = (d && d.groups && d.groups.length) ? d : sampleLab(); return (variant === 'compact') ? labCompact(s, ld) : labClassic(s, ld); }
    if (type === 'diag') { const id = (d && (d.__editor || d.description || d.conclusion)) ? d : sampleImaging(); return (variant === 'compact') ? imagingCompact(s, id) : imagingClassic(s, id); }
    if (type === 'invoice') { const vd = (d && d.items && d.items.length) ? d : sampleInvoice(); return (variant === 'thermal') ? invoiceThermal(s, vd) : (variant === 'compact') ? invoiceCompact(s, vd) : invoiceClassic(s, vd); }
    if (type === 'fiscal') return fiscalClassic(s, (d && d.items && d.items.length) ? d : sampleFiscal());
    if (type === 'check') return receiptClassic(s, (d && d.items && d.items.length) ? d : sampleReceipt());
    return null;
}

function sampleFiscal() {
    // FISCAL_PATIENT_NAME_V1 — patientName here too, so Настройки → Документы
    // previews the row; without it the preview looks unchanged after the fix.
    return { docNo: '0094217', date: '01.10.2026 16:42', cashier: 'Юлдашева Д. Ф.', patientName: 'Рахимов Ж. Б.', mrn: '0024815', kassa: 'KKM-04', smena: '118', payMethod: 'БЕЗНАЛИЧНЫМИ (UZCARD)',
        items: [{ name: 'Консультация терапевта', qty: 1, price: 150000 }, { name: 'ЭКГ с расшифровкой', qty: 1, price: 80000 }, { name: 'Эхокардиография (ЭхоКГ)', qty: 1, price: 220000 }, { name: 'Общий анализ крови', qty: 1, price: 60000 }],
        subtotal: 510000, total: 459000, ofd: { fm: 'UZ 240810 004217', fpd: '1830 4471 9925', ofdNo: 'AA 008 4471 9925', ofdTime: '01.10.2026 16:42:07' } };
}
function sampleReceipt() {
    return { docNo: 'CHK-0094217', date: '01.10.2026 · 16:42', patientName: 'Рахимов Ж. Б.', mrn: '0024815', payMethod: 'Банковская карта · UZCARD', received: '459 000 сум', cashier: 'Юлдашева Д. Ф.',
        items: [{ name: 'Первичная консультация терапевта', qty: 1, price: 150000 }, { name: 'ЭКГ с расшифровкой', qty: 1, price: 80000 }, { name: 'Эхокардиография (ЭхоКГ)', qty: 1, price: 220000 }, { name: 'Общий анализ крови', qty: 1, price: 60000 }],
        subtotal: 510000, total: 459000 };
}

function money(n) { const v = Number(n); if (isNaN(v)) return esc(n); return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function kvRows(arr) { return (arr || []).map(([k, v]) => `<div class="fl">${esc(k)}</div><div class="fv">${esc(v)}</div>`).join(''); }
function sampleInvoice() {
    return {
        docNo: 'INV-2026-018342', issueDate: '01.10.2026', dueDate: '08.10.2026', status: 'UNPAID',
        patient: [['ФИО · F.I.Sh.', 'Рахимов Жасур Бахтиёрович'], ['ID пациента', '0024815'], ['Телефон', '+998 90 123 45 67']],
        billing: [['Тип · Turi', 'Платно (наличные/карта)'], ['Лечащий врач', 'Юсупова Н. А.'], ['Дата визита', '01.10.2026']],
        items: [
            { name: 'Первичная консультация терапевта', qty: 1, price: 150000 },
            { name: 'ЭКГ с расшифровкой', qty: 1, price: 80000 },
            { name: 'Эхокардиография (ЭхоКГ)', qty: 1, price: 220000 },
            { name: 'Общий анализ крови', qty: 1, price: 60000 },
            { name: 'Биохимия крови — липидный профиль', qty: 1, price: 180000 },
        ],
        subtotal: 690000, total: 690000, paid: 0,
    };
}

function paras(t) { return String(t || '').split(/\n\n+|\n/).map(x => x.trim()).filter(Boolean); }
function sampleImaging() {
    return {
        docNo: 'MR-2024-005140', dateIn: '01.10.2024', dateOut: new Date().toLocaleDateString('ru-RU'),
        patientName: 'Рахимов Жасур Бахтиёрович', dob: '14.03.1989', sex: 'Мужской', mrn: '0024815',
        study: { kind: 'МРТ головного мозга', area: 'Головной мозг, без контраста', device: 'Siemens Magnetom · 1,5 Тл', protocol: 'T1, T2, FLAIR, DWI' },
        films: [{ caption: 'SAG · T1', sub: 'SE 01' }, { caption: 'AX · FLAIR', sub: 'SE 02' }, { caption: 'AX · DWI', sub: 'SE 03' }],
        description: 'На серии МР-томограмм, взвешенных по T1 и T2 в трёх проекциях, получены изображения структур головного мозга. Срединные структуры не смещены. Желудочковая система не расширена, симметрична.\nВ белом веществе лобных долей субкортикально определяются единичные мелкие (до 3 мм) очаги гиперинтенсивного МР-сигнала по T2 и FLAIR — сосудистого генеза. Признаков ограничения диффузии на DWI не выявлено.\nКора и подкорковые ядра без очаговых изменений. Гипофиз обычных размеров. Придаточные пазухи носа пневматизированы, без признаков воспаления.',
        conclusion: 'МР-картина единичных очагов сосудистого характера в белом веществе лобных долей. Данных за объёмный процесс, ОНМК и демиелинизацию не получено. Рекомендуется контроль АД и наблюдение невролога; МРТ в динамике через 12 месяцев.',
        radiologist: 'Камилов А. Ш.', radiologistSpec: 'Врач лучевой диагностики',
    };
}

function sampleLab() {
    return {
        requestNo: '9932010003', dateIn: '01.10.2024', dateOut: new Date().toLocaleDateString('ru-RU'),
        patientName: 'Рахимов Жасур Бахтиёрович', dob: '14.03.1989', sex: 'Мужской', mrn: '0024815',
        conclusion: 'Дислипидемия (повышение общего холестерина, ЛПНП и триглицеридов) в сочетании с гипергликемией натощак и повышенным HbA1c. Рекомендована консультация эндокринолога и повторная липидограмма через 1 месяц.',
        labChief: 'Мустафаев Б. Р.', labChiefSpec: 'Врач клинической лабораторной диагностики',
        groups: [
            { title: 'Гематология — Клинический анализ крови', titleUz: 'Klinik qon tahlili', tests: [
                { name: 'Гемоглобин', code: 'HGB', value: '148', unit: 'г/л', ref: '130 – 170', flag: 'N', pos: 56 },
                { name: 'Эритроциты', code: 'RBC', value: '4,9', unit: '×10¹²/л', ref: '4,0 – 5,1', flag: 'N', pos: 72 },
                { name: 'Лейкоциты', code: 'WBC', value: '6,8', unit: '×10⁹/л', ref: '4,0 – 9,0', flag: 'N', pos: 54 },
                { name: 'Тромбоциты', code: 'PLT', value: '138', unit: '×10⁹/л', ref: '150 – 400', flag: 'L', pos: 16 },
                { name: 'СОЭ', code: 'ESR', value: '9', unit: 'мм/ч', ref: '< 15', flag: 'N', pos: 46 },
            ] },
            { title: 'Биохимия — Липидный профиль и углеводный обмен', titleUz: 'Qon biokimyosi', tests: [
                { name: 'Глюкоза (натощак)', code: 'GLU', value: '7,8', unit: 'ммоль/л', ref: '3,9 – 6,1', flag: 'H', pos: 90 },
                { name: 'Гликир. гемоглобин', code: 'HbA1c', value: '7,4', unit: '%', ref: '< 6,0', flag: 'H', pos: 88 },
                { name: 'Холестерин общий', code: 'CHOL', value: '6,2', unit: 'ммоль/л', ref: '< 5,2', flag: 'H', pos: 86 },
                { name: 'Холестерин ЛПНП', code: 'LDL', value: '4,1', unit: 'ммоль/л', ref: '< 3,0', flag: 'H', pos: 84 },
                { name: 'Триглицериды', code: 'TG', value: '2,3', unit: 'ммоль/л', ref: '< 1,7', flag: 'H', pos: 82 },
                { name: 'Креатинин', code: 'CREA', value: '92', unit: 'мкмоль/л', ref: '62 – 106', flag: 'N', pos: 60 },
            ] },
        ],
    };
}
function flagN(f) { return (f === 'H' || f === 'L') ? f.toUpperCase() : 'N'; }

// ---------------------------------------------------------------------------
// CONCLUSION · CLASSIC (full colour + branding)
// ---------------------------------------------------------------------------
const CHEV_UP = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';
const CHEV_DN = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
function conclusionClassic(s, d) {
    const accent2 = s.accent;   // emphasis colour = brand accent
    // BLANK_EDITOR_V1 — field: data-field marker for the WYSIWYG editor; in editor
    // mode (d.__editor) empty sections still render so the doctor can click into them.
    const _secOn = (field) => !field || !d.activeFields || d.activeFields.indexOf(field) > -1;
    const sec = (ru, uz, txt, field) => {
        if (d.__editor && field && d.activeFields && !_secOn(field)) return `<button type="button" class="bk-add" data-add="${field}">+ Добавить: ${esc(ru)}</button>`;
        return (txt || (d.__editor && field)) ? `<div class="sec"><div class="sec-h"><span class="ru">${esc(ru)}</span>${uz ? `<span class="uz">· ${esc(uz)}</span>` : ''}${d.__editor && field ? `<span class="bk-ctl"><button type="button" class="bk-up" data-up="${field}" title="Выше">${CHEV_UP}</button><button type="button" class="bk-dn" data-dn="${field}" title="Ниже">${CHEV_DN}</button><button type="button" class="bk-rm" data-rm="${field}" title="Убрать раздел">×</button></span>` : ''}</div><div class="sec-b"${field ? ` data-field="${field}"` : ''}>${esc(txt)}</div></div>` : '';
    };
    const recList = lines(d.recsText);
    const recsHtml = recList.length ? `<div class="sec"><div class="sec-h"><span class="ru">Рекомендации</span><span class="uz">· Tavsiyalar</span></div><ul class="recs">${recList.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
    const rx = (d.prescriptions || []).filter(r => r && r.name);
    const rxHtml = rx.length ? `<div class="sec"><div class="sec-h"><span class="ru">Рецепт</span><span class="uz">· Retsept</span></div><div class="rx-wrap"><table class="rx"><thead><tr><th class="num"></th><th>Препарат<span class="uz">Preparat</span></th><th>Доза<span class="uz">Doza</span></th><th>Режим приёма<span class="uz">Qabul rejimi</span></th><th>Длительность<span class="uz">Davomiyligi</span></th></tr></thead><tbody>${rx.map((r, i) => `<tr><td class="num">${i + 1}</td><td class="drug">${esc(r.name)}${r.notes ? `<small>${esc(r.notes)}</small>` : ''}${r.nurse ? `<small style="display:block;font-weight:400;color:#7a8290;font-size:.88em;margin-top:2px;">Медсестре: ${esc(r.nurse)}</small>` : ''}</td><td>${esc(r.dose || '—')}</td><td>${esc(r.freq || '—')}</td><td>${esc(r.dur || '—')}</td></tr>`).join('')}</tbody></table></div></div>` : '';
    const refs = (d.referrals || []).filter(r => r && r.name);
    const refsHtml = refs.length ? `<div class="sec"><div class="sec-h"><span class="ru">Рекомендованные услуги</span><span class="uz">· Tavsiya etilgan xizmatlar</span></div><div class="svc">${refs.map(r => `<div class="si"><span class="si-nm">${esc(r.name)}${r.note ? ` <span style="color:var(--faint)">· ${esc(r.note)}</span>` : ''}</span>${(d.__editor && r.id) ? `<button type="button" class="bk-recrm" data-rec-rm="${esc(r.id)}" title="Убрать рекомендацию">Удалить</button>` : ''}</div>`).join('')}</div></div>` : '';
    // DX_ALL_IN_DOC_V1 — every added diagnosis renders: the primary stays the editable
    // line; concomitant / complication / background follow with their type label.
    const dxExtras = (d.diagnoses || []).filter(x => x && x.type !== 'main' && x.name).map(x =>
        `<div style="display:flex;gap:7px;align-items:baseline;margin-top:4px;font-size:13.5px;line-height:1.4;">${x.code ? `<span class="icd">${esc(x.code)}</span>` : ''}<span>${esc(x.name)}</span><span style="margin-left:auto;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;opacity:.55;">${esc(x.typeLabel || '')}</span></div>`).join('');
    const dxHtml = (d.__editor && d.activeFields && d.activeFields.indexOf('primary_diagnosis') < 0)
        ? `<button type="button" class="bk-add" data-add="primary_diagnosis">+ Добавить: Диагноз</button>`
        : ((d.dx || d.__editor || dxExtras) ? `<div class="dx"><div class="dh"><span class="ru">Диагноз</span><span class="uz">· Tashxis</span>${d.__editor ? `<span class="bk-ctl"><button type="button" class="bk-up" data-up="primary_diagnosis" title="Выше">${CHEV_UP}</button><button type="button" class="bk-dn" data-dn="primary_diagnosis" title="Ниже">${CHEV_DN}</button><button type="button" class="bk-rm" data-rm="primary_diagnosis" title="Убрать раздел">×</button></span>` : ''}</div><div class="dx-row">${d.icd10 ? `<span class="icd">${esc(d.icd10)}</span>` : ''}<span class="dx-tx" data-field="primary_diagnosis">${esc(d.dx)}</span></div>${dxExtras}</div>` : '');
    const _secByField = {
        chief_complaint: sec('Жалобы', 'Shikoyatlar', d.complaint, 'chief_complaint'),
        hpi: sec('Анамнез', 'Anamnez', d.hpi, 'hpi'),
        labs_text: sec('Лабораторные исследования', 'Laboratoriya tekshiruvlari', d.labs, 'labs_text'),
        instrumental_text: sec('Инструментальные исследования', 'Instrumental tekshiruvlar', d.instrumental, 'instrumental_text'),
        physical_exam: sec('Осмотр', 'Ko‘rik', d.exam, 'physical_exam'),
        primary_diagnosis: dxHtml,
        therapy_text: sec('Терапия', 'Davolash', d.therapy, 'therapy_text'),
        recommendations_text: (d.__editor ? sec('Рекомендации', 'Tavsiyalar', d.recsText, 'recommendations_text') : recsHtml),
    };
    const _DEF_ORDER = ['chief_complaint', 'hpi', 'primary_diagnosis', 'therapy_text', 'recommendations_text'];
    // CONCL_SECTIONS_KEEP_V1 - фильтруем по ИЗВЕСТНЫМ разделам, а не по
    // порядку по умолчанию. Раньше здесь стоял _DEF_ORDER, и разделы, которых
    // в нём нет - «Осмотр», «Лабораторные исследования», «Инструментальные
    // исследования» - молча ВЫБРАСЫВАЛИСЬ из печати, хотя врач включил их в
    // кабинете и подписал документ. _DEF_ORDER остаётся тем, чем и был:
    // порядком по умолчанию и добивкой недостающих разделов ниже.
    const _KNOWN = Object.keys(_secByField);
    let _order = (d.sectionOrder && d.sectionOrder.length) ? d.sectionOrder.filter(k => _KNOWN.indexOf(k) > -1) : _DEF_ORDER.slice();
    for (const k of _DEF_ORDER) if (_order.indexOf(k) < 0) _order.push(k);
    const _bodyHtml = _order.map(k => _secByField[k] || '').join('\n');
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Заключение · ${esc(d.patientName || '')}</title><style>
${PRINT_FONT_FACE_CSS}
:root{ --accent:${esc(s.accent)}; --accent-2:${esc(accent2)}; --accent-soft:${esc(s.accentSoft || '#eef6f5')}; --ink:${esc(s.ink || '#16213f')};
  --ink-2:#3a4258; --muted:#454e63; --faint:#6b7285; --line:#e3e6ec; --line-2:#eef0f4; --paper:#fff; --page-bg:#e9eaee; --card-line:#e7eceb; }
*{margin:0;padding:0;box-sizing:border-box;} body{ background:var(--page-bg); font-family:'Onest',"Helvetica Neue",Arial,"Segoe UI",sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased; padding:24px 14px; display:flex; flex-direction:column; align-items:center; }
.sheet{ position:relative; width:210mm; min-height:297mm; display:flex; flex-direction:column; background:var(--paper); padding:15mm 14mm 16mm; box-shadow:0 8px 34px rgba(20,28,48,.16); }
.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:18px; }
.brand{ display:flex; align-items:center; gap:13px; } .brand .wm{ font-size:25.5px; font-weight:800; color:var(--ink); letter-spacing:-.01em; line-height:1; } .brand .tg{ font-size:12px; color:var(--muted); letter-spacing:.04em; margin-top:4px; }
.clinic{ text-align:right; line-height:1.5; } .clinic .cn{ font-size:15.5px; font-weight:700; color:var(--ink); } .clinic .cl{ font-size:13.5px; color:var(--muted); } .clinic .cl b{ color:var(--ink-2); font-weight:600; }
.rule{ height:1px; background:var(--line); margin:11px 0 0; }
.title{ text-align:center; margin-top:15px; } .title h1{ font-size:21px; font-weight:800; color:var(--ink); } .title .uz{ font-size:15.5px; font-style:italic; color:var(--muted); margin-top:3px; }
.meta{ display:flex; justify-content:center; margin-top:9px; } .meta .chip{ font-size:14px; color:var(--ink-2); padding:0 14px; position:relative; } .meta .chip + .chip::before{ content:""; position:absolute; left:0; top:2px; bottom:2px; width:1px; background:var(--line); } .meta .chip b{ color:var(--ink); font-weight:700; }
.cards{ display:grid; grid-template-columns:1fr 1fr; gap:11px; margin-top:14px; } .card{ background:var(--accent-soft); border:1px solid var(--card-line); border-radius:10px; padding:11px 14px 12px; break-inside:avoid; }
.card .ct{ display:flex; align-items:center; gap:7px; font-size:13px; font-weight:800; letter-spacing:.09em; text-transform:uppercase; color:var(--accent); margin-bottom:9px; } .card .ct .uz{ color:var(--faint); font-weight:600; font-style:italic; letter-spacing:.02em; text-transform:none; }
.fgrid{ display:grid; grid-template-columns:auto 1fr; gap:5px 14px; } .fgrid .fl{ font-size:12px; color:var(--muted); align-self:center; } .fgrid .fl i{ font-style:italic; color:var(--faint); } .fgrid .fv{ font-size:15.5px; font-weight:700; color:var(--ink); text-align:right; }
.body{ margin-top:16px; } .sec{ margin-bottom:12px; } /* DOC_LONG_BLOCK_BREAK_V1: break-inside:avoid убран. Блок с длинным текстом не влезает в остаток страницы целиком, и браузер уносит его на следующую, оставляя первую пустой под одной шапкой. Заголовок держим с началом блока через break-after у .secbar. */ 
.sec-h{ display:flex; align-items:baseline; gap:8px; padding-left:11px; position:relative; margin-bottom:5px; } .sec-h::before{ content:""; position:absolute; left:0; top:1px; bottom:1px; width:3.5px; border-radius:2px; background:var(--accent); } .sec-h .ru{ font-size:15.5px; font-weight:800; color:var(--ink); text-transform:uppercase; } .sec-h .uz{ font-size:13.5px; font-style:italic; color:var(--faint); }
.sec-b{ font-size:14.5px; line-height:1.6; color:var(--ink); font-weight:500; padding-left:11px; white-space:pre-wrap; }
.dx{ break-inside:avoid; margin:14px 0; border:1px solid var(--card-line); border-left:4px solid var(--line); background:var(--accent-soft); border-radius:9px; padding:11px 15px; } .dx .dh{ display:flex; align-items:baseline; gap:8px; margin-bottom:7px; } .dx .dh .ru{ font-size:15.5px; font-weight:800; text-transform:uppercase; color:var(--accent); } .dx .dh .uz{ font-size:13.5px; font-style:italic; color:var(--faint); }
.dx-row{ display:flex; gap:11px; align-items:flex-start; } .icd{ flex:none; font-size:15px; font-weight:800; color:#fff; background:var(--accent); border-radius:5px; padding:3px 9px; } .dx-tx{ font-size:15px; line-height:1.5; color:var(--ink); }
ul.recs{ list-style:none; padding-left:11px; display:flex; flex-direction:column; gap:4px; } ul.recs li{ font-size:14.5px; line-height:1.5; color:var(--ink); font-weight:500; padding-left:16px; position:relative; } ul.recs li::before{ content:""; position:absolute; left:2px; top:7px; width:5px; height:5px; border-radius:50%; background:var(--accent); }
.rx-wrap{ break-inside:avoid; padding-left:11px; } table.rx{ width:100%; border-collapse:collapse; font-size:14px; } table.rx thead th{ font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:700; text-align:left; padding:0 9px 6px 0; border-bottom:1.5px solid var(--line); } table.rx thead th .uz{ display:block; color:var(--faint); font-weight:600; font-style:italic; margin-top:1px; } table.rx tbody td{ padding:7px 9px 7px 0; border-bottom:1px solid var(--line-2); vertical-align:top; break-inside:avoid; } table.rx tbody tr:last-child td{ border-bottom:none; } table.rx .num{ width:20px; color:var(--accent); font-weight:800; } table.rx .drug{ font-weight:700; color:var(--ink); } table.rx .drug small{ display:block; font-weight:400; color:var(--faint); font-style:italic; }
.svc{ display:flex; flex-direction:column; gap:5px; padding-left:11px; } .svc .si{ display:flex; align-items:baseline; gap:10px; font-size:14px; color:var(--ink-2); padding-left:16px; position:relative; line-height:1.45; break-inside:avoid; } .svc .si-nm{ flex:1; min-width:0; overflow-wrap:anywhere; } .svc .si::before{ content:"+"; position:absolute; left:2px; top:0; color:var(--accent); font-weight:800; }
.signoff{ display:flex; justify-content:space-between; align-items:flex-end; gap:20px; margin-top:22px; break-inside:avoid; } .sig{ flex:1; max-width:320px; } .sig .role{ font-size:11.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); } .sig .role i{ font-style:italic; color:var(--faint); } .sig .mark{ height:34px; margin:2px 0 1px; display:flex; align-items:flex-end; } .sig .mark svg{ height:32px; width:auto; } .sig .name{ font-size:15px; font-weight:700; color:var(--ink); border-top:1px solid var(--ink); padding-top:4px; } .sig .spec{ font-size:13px; color:var(--muted); margin-top:2px; }
.sign-right{ display:flex; align-items:flex-end; gap:18px; } .qr{ width:60px; height:60px; flex:none; padding:5px; border:1px solid var(--line); border-radius:6px; } .qr svg{ width:100%; height:100%; display:block; } .qr svg path,.qr svg rect{ fill:var(--ink); } .qr-cap{ font-size:10px; color:var(--faint); text-align:center; margin-top:3px; }
.stamp{ width:86px; height:86px; flex:none; border:2px dashed var(--muted); border-radius:50%; position:relative; transform:rotate(-11deg); opacity:.78; } .stamp::before{ content:""; position:absolute; inset:7px; border:1px solid var(--line); border-radius:50%; } .stamp .sc{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--muted); } .stamp .sc .mp{ font-size:17.5px; font-weight:800; } .stamp .sc .sm{ font-size:9px; letter-spacing:.12em; text-transform:uppercase; margin-top:2px; }
.sheet:not(.show-stamp) .stamp, .sheet:not(.show-qr) .qr-box, .sheet:not(.show-qr) .qr, .sheet:not(.show-signature) .sig{ display:none; }   /* STAMP_ONLY_V1 */
.thanks{ text-align:center; font-size:14px; color:var(--ink-2); margin-top:18px; } .thanks b{ color:var(--accent); }
.legal{ font-size:11px; color:var(--faint); text-align:center; margin-top:10px; padding:0 8mm; line-height:1.5; }
.foot{ margin-top:auto; padding-top:10px; border-top:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; } .foot .fl{ font-size:13px; color:var(--ink); } .foot .fl b{ font-weight:700; } .foot .fr{ font-size:13px; font-weight:700; color:var(--ink); }
@media print{ @page{ size:A4; margin:13mm 14mm; } html,body{ background:#fff; padding:0; } body{ display:block; } /* DOC_A4_PRINT_V1 */ :root{ --ink:#000; --ink-2:#0f131b; --muted:#20242e; --faint:#333a45; } .sheet{ box-shadow:none; width:auto; min-height:268mm; padding:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
<section class="sheet ${toggleCls(s)}">
  <div class="head">
    <div class="brand">${logoTag(s, 46)}<div><div class="wm">${esc(s.clinicName || 'Клиника')}</div>${s.tagline ? `<div class="tg">${esc(s.tagline)}</div>` : ''}</div></div>
    <div class="clinic">
      ${s.address ? `<div class="cl">${esc(s.address)}</div>` : ''}
      <div class="cl">${s.phone ? `<b>Тел:</b> ${esc(s.phone)}` : ''}${s.web ? ` · <b>${esc(s.web)}</b>` : ''}</div>
    </div>
  </div>
  <div class="rule"></div>
  <div class="title"><h1>Заключение врача</h1><div class="uz">Shifokor xulosasi</div>
    <div class="meta">${d.docNo ? `<span class="chip">Документ <b>${esc(d.docNo)}</b></span>` : ''}<span class="chip">Дата приёма <b>${esc(d.issueDate || new Date().toLocaleDateString('ru-RU'))}</b></span><span class="chip">Тип визита <b>${esc(d.visitType || 'Первичный приём')}</b></span></div>
  </div>
  <div class="cards">
    <div class="card"><div class="ct">Пациент <span class="uz">· Bemor</span></div><div class="fgrid">
      <div class="fl">ФИО <i>· F.I.Sh.</i></div><div class="fv">${esc(d.patientName || '—')}</div>
      <div class="fl">Дата рождения <i>· Tug‘ilgan sana</i></div><div class="fv">${esc(d.dob || '—')}</div>
      <div class="fl">Пол <i>· Jinsi</i></div><div class="fv">${esc(d.sex || '—')}</div>
      <div class="fl">ID пациента <i>· Bemor ID</i></div><div class="fv">${esc(d.mrn || '—')}</div>
      <div class="fl">Телефон <i>· Telefon</i></div><div class="fv">${esc(d.phone || '—')}</div></div></div>
    ${d.showDoctor === false ? '' : `<div class="card"><div class="ct">Лечащий врач <span class="uz">· Davolovchi shifokor</span></div><div class="fgrid">
      <div class="fl">Врач <i>· Shifokor</i></div><div class="fv">${esc(d.doctorName || '—')}</div>
      <div class="fl">Специальность <i>· Mutaxassislik</i></div><div class="fv">${esc(d.doctorSpec || '—')}</div>
      <div class="fl">Услуга <i>· Xizmat</i></div><div class="fv">${esc(d.service || '—')}</div>
      <div class="fl">Телефон <i>· Telefon</i></div><div class="fv">${esc(d.doctorPhone || '—')}</div></div></div>`}
  </div>
  <div class="body">
    ${_bodyHtml}
    ${rxHtml}
    ${refsHtml}
  </div>
  <div class="signoff">
    <div class="sig"><div class="role">Лечащий врач <i>· Davolovchi shifokor</i></div><div class="mark">${SIG_SVG}</div><div class="name">${esc(d.doctorName || '—')}</div><div class="spec">${esc(d.doctorSpec || '')} · подпись</div></div>
    <div class="sign-right"><div class="qr-box" style="text-align:center"><div class="qr">${QR_SVG}</div><div class="qr-cap">Проверка<br>подлинности</div></div>
      </div>
  </div>
  ${s.footerNote ? `<div class="thanks">${esc(s.footerNote)}</div>` : ''}
  ${s.legalNote ? `<div class="legal">${esc(s.legalNote)}</div>` : ''}
  <div class="foot"><div class="fl">${s.web ? `<b>${esc(s.web)}</b> · ` : ''}${esc(s.clinicName || '')}</div><div class="fr">${esc(s.phone || '')}</div></div>
</section></body></html>`;
}

// ---------------------------------------------------------------------------
// CONCLUSION · COMPACT (ink-economy, small branding, B&W-friendly)
// ---------------------------------------------------------------------------
function conclusionCompact(s, d) {
    const _secOn = (field) => !field || !d.activeFields || d.activeFields.indexOf(field) > -1;
    const sec = (ru, uz, txt, field) => {
        if (d.__editor && field && d.activeFields && !_secOn(field)) return `<button type="button" class="bk-add" data-add="${field}">+ Добавить: ${esc(ru)}</button>`;
        return (txt || (d.__editor && field)) ? `<div class="secbar"><span class="ru">${esc(ru)}</span>${uz ? `<span class="uz">· ${esc(uz)}</span>` : ''}${d.__editor && field ? `<span class="bk-ctl"><button type="button" class="bk-up" data-up="${field}" title="Выше">${CHEV_UP}</button><button type="button" class="bk-dn" data-dn="${field}" title="Ниже">${CHEV_DN}</button><button type="button" class="bk-rm" data-rm="${field}" title="Убрать раздел">×</button></span>` : ''}</div><div class="sec"><div class="sec-b"${field ? ` data-field="${field}"` : ''}>${esc(txt)}</div></div>` : '';
    };
    const recList = lines(d.recsText);
    const recsHtml = recList.length ? `<div class="secbar"><span class="ru">Рекомендации</span><span class="uz">· Tavsiyalar</span></div><ul class="recs">${recList.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    const rx = (d.prescriptions || []).filter(r => r && r.name);
    const rxHtml = rx.length ? `<div class="secbar"><span class="ru">Рецепт</span><span class="uz">· Retsept</span></div><table class="rx"><thead><tr><th class="num"></th><th>Препарат</th><th>Доза</th><th>Режим</th><th>Длит.</th></tr></thead><tbody>${rx.map((r, i) => `<tr><td class="num">${i + 1}</td><td class="drug">${esc(r.name)}${r.notes ? `<small style="display:block;font-weight:400;font-style:italic;color:#7a8290;font-size:.88em;margin-top:2px;">${esc(r.notes)}</small>` : ''}${r.nurse ? `<small style="display:block;font-weight:400;color:#7a8290;font-size:.88em;margin-top:2px;">Медсестре: ${esc(r.nurse)}</small>` : ''}</td><td>${esc(r.dose || '—')}</td><td>${esc(r.freq || '—')}</td><td>${esc(r.dur || '—')}</td></tr>`).join('')}</tbody></table>` : '';
    const refs = (d.referrals || []).filter(r => r && r.name);
    const refsHtml = refs.length ? `<div class="secbar"><span class="ru">Рекомендованные услуги</span></div><ul class="recs">${refs.map(r => `<li>${esc(r.name)}${(d.__editor && r.id) ? `<button type="button" class="bk-recrm" data-rec-rm="${esc(r.id)}" title="Убрать рекомендацию">Удалить</button>` : ''}</li>`).join('')}</ul>` : '';
    const dxExtras = (d.diagnoses || []).filter(x => x && x.type !== 'main' && x.name).map(x =>
        `<div style="display:flex;gap:6px;align-items:baseline;margin-top:3px;font-size:11.5px;line-height:1.35;">${x.code ? `<span class="icd">${esc(x.code)}</span>` : ''}<span>${esc(x.name)}</span><span style="margin-left:auto;font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.55;">${esc(x.typeLabel || '')}</span></div>`).join('');
    const dxHtml = (d.__editor && d.activeFields && d.activeFields.indexOf('primary_diagnosis') < 0)
        ? `<button type="button" class="bk-add" data-add="primary_diagnosis">+ Добавить: Диагноз</button>`
        : ((d.dx || d.__editor || dxExtras) ? `<div class="dx"><div class="dh">Диагноз <span class="uz">· Tashxis</span>${d.__editor ? `<span class="bk-ctl"><button type="button" class="bk-up" data-up="primary_diagnosis" title="Выше">${CHEV_UP}</button><button type="button" class="bk-dn" data-dn="primary_diagnosis" title="Ниже">${CHEV_DN}</button><button type="button" class="bk-rm" data-rm="primary_diagnosis" title="Убрать раздел">×</button></span>` : ''}</div><div class="dx-row">${d.icd10 ? `<span class="icd">${esc(d.icd10)}</span>` : ''}<span data-field="primary_diagnosis">${esc(d.dx)}</span></div>${dxExtras}</div>` : '');
    const fld = (l, uz, v) => `<div class="fld"><span class="l">${esc(l)}${uz ? ` <i>· ${esc(uz)}</i>` : ''}</span><span class="d"></span><span class="v">${esc(v || '—')}</span></div>`;
    const _secByField = {
        chief_complaint: sec('Жалобы', 'Shikoyatlar', d.complaint, 'chief_complaint'),
        hpi: sec('Анамнез', 'Anamnez', d.hpi, 'hpi'),
        labs_text: sec('Лабораторные', 'Laboratoriya', d.labs, 'labs_text'),
        instrumental_text: sec('Инструментальные', 'Instrumental', d.instrumental, 'instrumental_text'),
        physical_exam: sec('Осмотр', 'Ko‘rik', d.exam, 'physical_exam'),
        primary_diagnosis: dxHtml,
        therapy_text: sec('Терапия', 'Davolash', d.therapy, 'therapy_text'),
        recommendations_text: (d.__editor ? sec('Рекомендации', 'Tavsiyalar', d.recsText, 'recommendations_text') : recsHtml),
    };
    const _DEF_ORDER = ['chief_complaint', 'hpi', 'primary_diagnosis', 'therapy_text', 'recommendations_text'];
    // CONCL_SECTIONS_KEEP_V1 - фильтруем по ИЗВЕСТНЫМ разделам, а не по
    // порядку по умолчанию. Раньше здесь стоял _DEF_ORDER, и разделы, которых
    // в нём нет - «Осмотр», «Лабораторные исследования», «Инструментальные
    // исследования» - молча ВЫБРАСЫВАЛИСЬ из печати, хотя врач включил их в
    // кабинете и подписал документ. _DEF_ORDER остаётся тем, чем и был:
    // порядком по умолчанию и добивкой недостающих разделов ниже.
    const _KNOWN = Object.keys(_secByField);
    let _order = (d.sectionOrder && d.sectionOrder.length) ? d.sectionOrder.filter(k => _KNOWN.indexOf(k) > -1) : _DEF_ORDER.slice();
    for (const k of _DEF_ORDER) if (_order.indexOf(k) < 0) _order.push(k);
    const _bodyHtml = _order.map(k => _secByField[k] || '').join('\n');
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Заключение · ${esc(d.patientName || '')}</title><style>
${PRINT_FONT_FACE_CSS}
:root{ --accent:${esc(s.accent)}; --accent-2:${esc(s.accent)}; --ink:${esc(s.ink || '#16213f')}; --ink-2:#39414f; --muted:#474f5e; --faint:#727a88; --line:#e2e4e9; --line-2:#eef0f3; --bar:#f2f3f5; --paper:#fff; --page-bg:#e9eaee; }
*{margin:0;padding:0;box-sizing:border-box;} body{ background:var(--page-bg); font-family:'Onest',"Helvetica Neue",Arial,"Segoe UI",sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased; padding:24px 14px; display:flex; flex-direction:column; align-items:center; }
.sheet{ position:relative; width:210mm; min-height:297mm; background:var(--paper); padding:13mm 14mm 14mm; box-shadow:0 8px 30px rgba(20,28,48,.14); }
.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:18px; } .brand{ display:flex; align-items:center; gap:10px; } .brand .wm{ font-size:18.5px; font-weight:800; color:var(--ink); line-height:1; } .brand .tg{ font-size:9.5px; color:var(--muted); letter-spacing:.05em; margin-top:3px; text-transform:uppercase; }
.clinic{ text-align:right; line-height:1.4; } .clinic .cn{ font-size:13.5px; font-weight:700; color:var(--ink); } .clinic .cl{ font-size:11.5px; color:var(--muted); margin-top:2px; }
.hr{ height:2px; background:var(--ink); margin-top:8px; opacity:.9; }
.title{ text-align:center; margin-top:11px; } .title h1{ font-size:19px; font-weight:800; color:var(--ink); } .title .uz{ font-size:13px; font-style:italic; color:var(--muted); margin-top:1px; }
.meta{ display:flex; justify-content:center; margin-top:5px; } .meta .chip{ font-size:12px; color:var(--ink-2); padding:0 11px; position:relative; } .meta .chip + .chip::before{ content:""; position:absolute; left:0; top:1px; bottom:1px; width:1px; background:var(--line); } .meta .chip b{ color:var(--ink); font-weight:700; }
.entwo{ display:grid; grid-template-columns:1fr 1fr; gap:0 34px; margin-top:11px; } .ent .cap{ font-size:11.5px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); margin-bottom:4px; }
.fld{ display:flex; align-items:baseline; gap:8px; font-size:13px; padding-bottom:2.5px; margin-bottom:2.5px; border-bottom:1px dotted var(--line); } .fld .l{ color:var(--muted); white-space:nowrap; } .fld .l i{ font-style:italic; color:var(--faint); } .fld .d{ flex:1; } .fld .v{ color:var(--ink); font-weight:700; text-align:right; }
.secbar{ display:flex; align-items:baseline; gap:8px; background:var(--bar); border-radius:5px; padding:4px 11px; margin:9px 0 5px; break-inside:avoid;  break-after:avoid; page-break-after:avoid; } .secbar .ru{ font-size:11px; font-weight:800; color:var(--ink); text-transform:uppercase; } .secbar .uz{ font-size:11.5px; font-style:italic; color:var(--muted); }
.sec{ margin-bottom:7px; } .sec-b{ font-size:12.5px; line-height:1.5; color:var(--ink); font-weight:500; padding:0 2px; white-space:pre-wrap; }
.dx{ break-inside:avoid; margin:8px 0; border-left:3px solid var(--line); padding:1px 0 1px 11px; } .dx .dh{ font-size:13.5px; font-weight:800; text-transform:uppercase; color:var(--accent); margin-bottom:3px; } .dx .dh .uz{ font-weight:400; font-style:italic; color:var(--faint); font-size:11.5px; margin-left:5px; text-transform:none; } .dx-row{ font-size:13.5px; line-height:1.45; color:var(--ink); font-weight:600; } .dx-row .icd{ font-weight:800; color:var(--accent); margin-right:5px; }
ul.recs{ list-style:none; padding:0 2px; display:grid; grid-template-columns:1fr 1fr; gap:2px 22px; } ul.recs li{ font-size:12.5px; line-height:1.45; color:var(--ink); font-weight:500; padding-left:12px; position:relative; } ul.recs li::before{ content:""; position:absolute; left:2px; top:6px; width:3.5px; height:3.5px; border-radius:50%; background:var(--accent); }
table.rx{ width:100%; border-collapse:collapse; font-size:12px; } table.rx thead th{ font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:700; text-align:left; padding:0 9px 4px 0; border-bottom:1px solid var(--line); } table.rx tbody td{ padding:4px 9px 4px 0; border-bottom:1px solid var(--line-2); vertical-align:top; } table.rx .num{ width:16px; color:var(--accent); font-weight:800; } table.rx .drug{ font-weight:700; color:var(--ink); }
.signoff{ display:flex; justify-content:space-between; align-items:flex-end; gap:16px; margin-top:14px; break-inside:avoid; } .sig{ flex:1; max-width:280px; } .sig .role{ font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); } .sig .name{ font-size:14px; font-weight:700; color:var(--ink); border-top:1px solid var(--ink); padding-top:3px; margin-top:18px; } .sig .spec{ font-size:11.5px; color:var(--muted); margin-top:1px; }
.sign-right{ display:flex; align-items:flex-end; gap:12px; } .qr{ width:46px; height:46px; flex:none; padding:3px; border:1px solid var(--line); border-radius:5px; } .qr svg{ width:100%; height:100%; } .qr svg path,.qr svg rect{ fill:var(--ink); } .stamp{ width:62px; height:62px; flex:none; border:1.5px dashed var(--muted); border-radius:50%; position:relative; transform:rotate(-10deg); opacity:.75; } .stamp .sc{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:13.5px; font-weight:800; }
.sheet:not(.show-stamp) .stamp, .sheet:not(.show-qr) .qr, .sheet:not(.show-signature) .sig{ display:none; }   /* STAMP_ONLY_V1 */
.legal{ font-size:10px; color:var(--faint); text-align:center; margin-top:9px; line-height:1.45; padding:0 6mm; }
.foot{ margin-top:auto; padding-top:7px; border-top:1px solid var(--ink); display:flex; align-items:center; justify-content:space-between; font-size:11.5px; color:var(--ink); } .foot b{ font-weight:700; }
@media print{ @page{ size:A4; margin:12mm 13mm; } html,body{ background:#fff; padding:0; } body{ display:block; } /* DOC_A4_PRINT_V1 */ :root{ --ink:#000; --ink-2:#0f131b; --muted:#20242e; --faint:#333a45; } .sheet{ box-shadow:none; width:auto; min-height:268mm; padding:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
${ECONOMY_BW_CSS}
</style></head><body>
<section class="sheet ${toggleCls(s)}">
  <div class="head">
    <div class="brand">${logoTag(s, 32)}<div><div class="wm">${esc(s.clinicName || 'Клиника')}</div>${s.tagline ? `<div class="tg">${esc(s.tagline)}</div>` : ''}</div></div>
    <div class="clinic">${s.address ? `<div class="cl">${esc(s.address)}</div>` : ''}<div class="cl">${s.phone ? esc(s.phone) : ''}${s.web ? ` · ${esc(s.web)}` : ''}</div></div>
  </div>
  <div class="hr"></div>
  <div class="title"><h1>Заключение врача</h1><div class="uz">Shifokor xulosasi</div>
    <div class="meta">${d.docNo ? `<span class="chip">№ <b>${esc(d.docNo)}</b></span>` : ''}<span class="chip">Дата <b>${esc(d.issueDate || new Date().toLocaleDateString('ru-RU'))}</b></span><span class="chip"><b>${esc(d.visitType || 'Первичный')}</b></span></div>
  </div>
  <div class="entwo">
    <div class="ent"><div class="cap">Пациент · Bemor</div>${fld('ФИО', 'F.I.Sh.', d.patientName)}${fld('Дата рожд.', 'Sana', d.dob)}${fld('Пол', 'Jinsi', d.sex)}${fld('ID', '', d.mrn)}${fld('Тел.', '', d.phone)}</div>
    ${d.showDoctor === false ? '' : `<div class="ent"><div class="cap">Лечащий врач · Shifokor</div>${fld('Врач', 'Shifokor', d.doctorName)}${fld('Спец.', 'Mutaxassis', d.doctorSpec)}${fld('Услуга', 'Xizmat', d.service)}${fld('Тел.', '', d.doctorPhone || '')}</div>`}
  </div>
  ${_bodyHtml}
  ${rxHtml}
  ${refsHtml}
  <div class="signoff">
    <div class="sig"><div class="role">Лечащий врач · Davolovchi shifokor</div><div class="name">${esc(d.doctorName || '—')}</div><div class="spec">${esc(d.doctorSpec || '')} · подпись</div></div>
    <div class="sign-right"><div class="qr">${QR_SVG}</div></div>
  </div>
  ${s.legalNote ? `<div class="legal">${esc(s.legalNote)}</div>` : ''}
  ${s.footerNote ? `<div class="thanks-eco">${esc(s.footerNote)}</div>` : ''}
  <div class="foot"><div>${s.web ? `<b>${esc(s.web)}</b> · ` : ''}${esc(s.clinicName || '')}</div><div>${esc(s.phone || '')}</div></div>
</section></body></html>`;
}

// ---------------------------------------------------------------------------
// LAB RESULTS · CLASSIC (full colour + range bars + H/L flags)
// ---------------------------------------------------------------------------
function clinicHeadHtml(s, logoPx) {
    return `<div class="head"><div class="brand">${logoTag(s, logoPx)}<div><div class="wm">${esc(s.clinicName || 'Клиника')}</div>${s.tagline ? `<div class="tg">${esc(s.tagline)}</div>` : ''}</div></div>
    <div class="clinic">${s.address ? `<div class="cl">${esc(s.address)}</div>` : ''}<div class="cl">${s.phone ? `<b>Тел:</b> ${esc(s.phone)}` : ''}${s.web ? ` · <b>${esc(s.web)}</b>` : ''}</div><div class="cl">${s.taxId ? `<b>ИНН</b> ${esc(s.taxId)}` : ''}${s.license ? ` · ${esc(s.license)}` : ''}</div></div></div>`;
}
function labClassic(s, d) {
    const fcl = (f) => f === 'H' ? 'h' : f === 'L' ? 'l' : '';
    // LAB_FLAG_CHEVRON_V1 — отклонение показывается ЦВЕТНЫМ ШЕВРОНОМ:
    // вверх — выше нормы, вниз — ниже. Буквы H/L читались как часть
    // результата, а направление отклонения приходилось расшифровывать.
    const fsym = (f) => f === 'H' ? '\u2303' : f === 'L' ? '\u2304' : '\u00b7';
    const row = (t) => `<tr><td class="pname">${esc(t.name)}${t.code ? ` <small>${esc(t.code)}</small>` : ''}</td><td class="r"><span class="val ${fcl(t.flag)}">${esc(t.value)}</span></td><td>${esc(t.unit || '')}</td><td class="ref">${refCellHtml(t.ref)}</td><td>${t.pos == null ? '<span class="rng-na">—</span>' : `<div class="range"><div class="track"></div><div class="band"></div><div class="mk ${fcl(t.flag)}" style="left:${Math.max(2, Math.min(98, t.pos))}%"></div></div>`}</td><td class="c">${t.flag ? `<span class="flag ${t.flag === 'H' ? 'h' : t.flag === 'L' ? 'l' : 'n'}">${fsym(t.flag)}</span>` : ''}</td></tr>`;
    const grp = (g) => `<div class="grp"><div class="grp-h"><span class="ru">${esc(g.title)}</span>${g.titleUz ? `<span class="uz">· ${esc(g.titleUz)}</span>` : ''}</div><table class="res"><colgroup><col style="width:33%"><col style="width:12%"><col style="width:13%"><col style="width:24%"><col style="width:10%"><col style="width:8%"></colgroup><thead><tr><th>Показатель<span class="uz">Ko‘rsatkich</span></th><th class="r">Результат<span class="uz">Natija</span></th><th>Ед.</th><th>Референс<span class="uz">Norma</span></th><th>Диапазон</th><th class="c">Флаг</th></tr></thead><tbody>${(g.tests || []).map(row).join('')}</tbody></table></div>`;
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Результаты анализов · ${esc(d.patientName || '')}</title><style>
${PRINT_FONT_FACE_CSS}
:root{ --accent:${esc(s.accent)}; --accent-2:${esc(s.accent)}; --accent-soft:${esc(s.accentSoft || '#eef6f5')}; --ink:${esc(s.ink || '#16213f')}; --ink-2:#3a4258; --muted:#454e63; --faint:#6b7285; --line:#e3e6ec; --line-2:#eef0f4; --paper:#fff; --page-bg:#e9eaee; --card-line:#e7eceb; --low:#2a6fb0; }
*{margin:0;padding:0;box-sizing:border-box;} body{ background:var(--page-bg); font-family:'Onest',"Helvetica Neue",Arial,"Segoe UI",sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased; padding:24px 14px; display:flex; flex-direction:column; align-items:center; }
.sheet{ position:relative; width:210mm; min-height:297mm; background:var(--paper); padding:15mm 14mm 16mm; box-shadow:0 8px 34px rgba(20,28,48,.16); }
.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:18px; } .brand{ display:flex; align-items:center; gap:13px; } .brand .wm{ font-size:25.5px; font-weight:800; color:var(--ink); line-height:1; } .brand .tg{ font-size:12px; color:var(--muted); letter-spacing:.04em; margin-top:4px; }
.clinic{ text-align:right; line-height:1.5; } .clinic .cl{ font-size:13.5px; color:var(--muted); } .clinic .cl b{ color:var(--ink-2); font-weight:600; }
.rule{ height:1px; background:var(--line); margin:11px 0 0; } .title{ text-align:center; margin-top:15px; } .title h1{ font-size:20px; font-weight:800; color:var(--ink); } .title .uz{ font-size:15px; font-style:normal; color:var(--muted); margin-top:3px; }
.meta{ display:flex; justify-content:center; margin-top:9px; } .meta .chip{ font-size:14px; color:var(--ink-2); padding:0 14px; position:relative; } .meta .chip + .chip::before{ content:""; position:absolute; left:0; top:2px; bottom:2px; width:1px; background:var(--line); } .meta .chip b{ color:var(--ink); font-weight:700; }
.pcard{ margin-top:14px; background:var(--accent-soft); border:1px solid var(--card-line); border-radius:10px; padding:11px 16px; display:grid; grid-template-columns:repeat(4,1fr); gap:9px 16px; break-inside:avoid; } .pf .fl{ font-size:11.5px; color:var(--muted); } .pf .fl i{ font-style:normal; color:var(--faint); } .pf .fv{ font-size:15px; font-weight:700; color:var(--ink); margin-top:1px; }
.grp{ margin-top:16px; } .grp-h{ break-after:avoid; page-break-after:avoid; } .grp-h{ display:flex; align-items:baseline; gap:8px; padding-left:11px; position:relative; margin-bottom:6px; } .grp-h::before{ content:""; position:absolute; left:0; top:1px; bottom:1px; width:3.5px; border-radius:2px; background:var(--accent); } .grp-h .ru{ font-size:11px; font-weight:800; color:var(--ink); text-transform:uppercase; } .grp-h .uz{ font-size:13.5px; font-style:normal; color:var(--faint); }
table.res{ width:100%; table-layout:fixed; border-collapse:collapse; font-size:11px; } table.res th, table.res td{ border:1px solid var(--line); padding:3px 7px; } table.res tbody tr:nth-child(even) td{ background:#f4f5f7; } thead{ display:table-header-group; } table.res tr{ break-inside:avoid; page-break-inside:avoid; } table.res thead th{ font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:700; text-align:left; padding:3px 7px; border:1px solid var(--line); background:#eef1f4; } table.res thead th .uz{ display:block; color:var(--faint); font-weight:600; font-style:normal; margin-top:1px; } table.res th.c,table.res td.c{ text-align:center; } table.res th.r,table.res td.r{ text-align:right; } table.res tbody td{ padding:3px 7px; border:1px solid var(--line); vertical-align:middle; overflow-wrap:anywhere; word-break:break-word; } table.res tbody tr:last-child td{ border-bottom:none; }
.pname{ font-weight:600; color:var(--ink); } .pname small{ color:var(--faint); font-weight:400; } .val{ font-weight:800; font-size:11px; color:var(--ink); } .val.h{ color:var(--accent-2); } .val.l{ color:var(--low); } .ref{ color:var(--ink-2); font-weight:600; white-space:nowrap; } .ref .rr{ display:block; white-space:nowrap; line-height:1.35; } .ref .rr.hit{ font-weight:800; color:var(--ink); }
.range{ position:relative; width:100%; max-width:74px; height:12px; overflow:hidden; } .rng-na{ color:var(--faint); } .range .track{ position:absolute; left:0; right:0; top:5px; height:3px; background:var(--line); border-radius:2px; } .range .band{ position:absolute; top:3.5px; left:22%; width:56%; height:6px; background:#d9dee7; border-radius:3px; } .range .mk{ position:absolute; top:1px; width:2.5px; height:11px; border-radius:1px; background:var(--ink); transform:translateX(-50%); } .range .mk.h{ background:var(--accent-2); } .range .mk.l{ background:var(--low); }
.flag{ display:inline-block; min-width:20px; text-align:center; font-weight:800; font-size:13px; } .flag.h{ color:var(--accent-2); font-size:15px; line-height:1; font-weight:900; } .flag.l{ color:var(--low); font-size:15px; line-height:1; font-weight:900; } .flag.n{ color:var(--faint); }
.legend{ display:flex; gap:16px; margin-top:11px; padding-left:11px; font-size:12px; color:var(--muted); } .legend span{ display:flex; align-items:center; gap:5px; } .legend .dh{ width:18px; height:11px; background:var(--accent-2); border-radius:3px; } .legend .dl{ width:18px; height:11px; background:var(--low); border-radius:3px; } .legend .dn{ width:9px; height:9px; border-radius:50%; background:var(--ink); }
.concl{ margin-top:16px; border:1px solid var(--card-line); border-left:4px solid var(--line); background:var(--accent-soft); border-radius:9px; padding:11px 15px; } .concl .ch{ font-size:15px; font-weight:800; text-transform:uppercase; color:var(--accent); margin-bottom:5px; } .concl .ch .uz{ font-size:13px; font-style:normal; color:var(--faint); font-weight:400; margin-left:6px; } .concl p{ font-size:14px; line-height:1.55; color:var(--ink-2); white-space:pre-wrap; }
.signoff{ display:flex; justify-content:space-between; align-items:flex-end; gap:20px; margin-top:20px; break-inside:avoid; } .sig{ flex:1; max-width:320px; } .sig .role{ font-size:11.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); } .sig .role i{ font-style:normal; color:var(--faint); } .sig .mark{ height:34px; margin:2px 0 1px; display:flex; align-items:flex-end; } .sig .mark svg{ height:32px; } .sig .name{ font-size:15px; font-weight:700; color:var(--ink); border-top:1px solid var(--ink); padding-top:4px; } .sig .spec{ font-size:13px; color:var(--muted); margin-top:2px; }
.sign-right{ display:flex; align-items:flex-end; gap:18px; } .qr{ width:60px; height:60px; flex:none; padding:5px; border:1px solid var(--line); border-radius:6px; } .qr svg{ width:100%; height:100%; } .qr svg path,.qr svg rect{ fill:var(--ink); } .qr-cap{ font-size:10px; color:var(--faint); text-align:center; margin-top:3px; } .stamp{ width:86px; height:86px; flex:none; border:2px dashed var(--muted); border-radius:50%; position:relative; transform:rotate(-11deg); opacity:.78; } .stamp::before{ content:""; position:absolute; inset:7px; border:1px solid var(--line); border-radius:50%; } .stamp .sc{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--muted); } .stamp .sc .mp{ font-size:17.5px; font-weight:800; } .stamp .sc .sm{ font-size:9px; letter-spacing:.12em; text-transform:uppercase; margin-top:2px; }
.sheet:not(.show-stamp) .stamp, .sheet:not(.show-qr) .qr-box, .sheet:not(.show-qr) .qr, .sheet:not(.show-signature) .sig{ display:none; }   /* STAMP_ONLY_V1 */
.legal{ font-size:11px; color:var(--faint); text-align:center; margin-top:13px; padding:0 8mm; line-height:1.5; }
.foot{ margin-top:auto; padding-top:10px; border-top:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; } .foot .fl{ font-size:13px; color:var(--ink); } .foot .fl b{ font-weight:700; } .foot .fr{ font-size:13px; font-weight:700; color:var(--ink); }
@media print{ @page{ size:A4; margin:13mm 14mm; } html,body{ background:#fff; padding:0; } body{ display:block; } /* DOC_A4_PRINT_V1 */ :root{ --ink:#000; --ink-2:#0f131b; --muted:#20242e; --faint:#333a45; } .sheet{ box-shadow:none; width:auto; min-height:268mm; padding:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body><section class="sheet ${toggleCls(s)}">
  ${clinicHeadHtml(s, 46)}<div class="rule"></div>
  <div class="title"><h1>Результаты лабораторных исследований</h1><div class="uz">Laboratoriya tekshiruvlari natijalari</div>
    <div class="meta">${d.requestNo ? `<span class="chip">Заявка <b>${esc(d.requestNo)}</b></span>` : ''}${d.dateIn ? `<span class="chip">Приём <b>${esc(d.dateIn)}</b></span>` : ''}<span class="chip">Выдан <b>${esc(d.dateOut || new Date().toLocaleDateString('ru-RU'))}</b></span></div></div>
  <div class="pcard"><div class="pf"><div class="fl">ФИО <i>· F.I.Sh.</i></div><div class="fv">${esc(d.patientName || '—')}</div></div><div class="pf"><div class="fl">Дата рождения</div><div class="fv">${esc(d.dob || '—')}</div></div><div class="pf"><div class="fl">Пол</div><div class="fv">${esc(d.sex || '—')}</div></div><div class="pf"><div class="fl">ID пациента</div><div class="fv">${esc(d.mrn || '—')}</div></div></div>
  ${(d.groups || []).map(grp).join('')}
  <div class="legend"><span><i class="dh"></i> \u2303 выше нормы</span><span><i class="dl"></i> \u2304 ниже нормы</span><span><i class="dn"></i> · в норме</span></div>
  ${d.conclusion ? `<div class="concl"><div class="ch">Заключение <span class="uz">· Xulosa</span></div><p>${esc(d.conclusion)}</p></div>` : ''}
  <div class="signoff"><div class="sig"><div class="role">Заведующий лабораторией <i>· Laboratoriya boshlig‘i</i></div><div class="mark">${SIG_SVG}</div><div class="name">${esc(d.labChief || '—')}</div><div class="spec">${esc(d.labChiefSpec || '')} · подпись</div></div>
    <div class="sign-right"><div class="qr-box" style="text-align:center"><div class="qr">${QR_SVG}</div><div class="qr-cap">Проверка<br>подлинности</div></div></div></div>
  ${s.legalNote ? `<div class="legal">${esc(s.legalNote)}</div>` : ''}
  <div class="foot"><div class="fl">${s.web ? `<b>${esc(s.web)}</b> · ` : ''}${esc(s.clinicName || '')}</div><div class="fr">${esc(s.phone || '')}</div></div>
</section></body></html>`;
}

// ---------------------------------------------------------------------------
// LAB RESULTS · COMPACT (ink-economy, grey bars, no range bars, B&W flags)
// ---------------------------------------------------------------------------
function labCompact(s, d) {
    const fsym = (f) => f === 'H' ? '⌃' : f === 'L' ? '⌄' : '·';
    const row = (t) => `<tr><td class="pname">${esc(t.name)}${t.code ? ` <small>${esc(t.code)}</small>` : ''}</td><td class="r"><b${(t.flag === 'H' || t.flag === 'L') ? ' style="text-decoration:underline"' : ''}>${esc(t.value)}</b></td><td>${esc(t.unit || '')}</td><td class="ref">${refCellHtml(t.ref)}</td><td class="c flag">${fsym(t.flag)}</td></tr>`;
    const grp = (g) => `<div class="secbar"><span class="ru">${esc(g.title)}</span></div><table class="res"><colgroup><col style="width:36%"><col style="width:13%"><col style="width:15%"><col style="width:26%"><col style="width:10%"></colgroup><thead><tr><th>Показатель</th><th class="r">Результат</th><th>Ед.</th><th>Референс</th><th class="c">Флаг</th></tr></thead><tbody>${(g.tests || []).map(row).join('')}</tbody></table>`;
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Результаты анализов · ${esc(d.patientName || '')}</title><style>
${PRINT_FONT_FACE_CSS}
:root{ --accent:${esc(s.accent)}; --ink:${esc(s.ink || '#16213f')}; --ink-2:#39414f; --muted:#474f5e; --faint:#727a88; --line:#e2e4e9; --line-2:#eef0f3; --bar:#f2f3f5; --paper:#fff; --page-bg:#e9eaee; }
*{margin:0;padding:0;box-sizing:border-box;} body{ background:var(--page-bg); font-family:'Onest',"Helvetica Neue",Arial,"Segoe UI",sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased; padding:24px 14px; display:flex; flex-direction:column; align-items:center; }
.sheet{ position:relative; width:210mm; min-height:297mm; background:var(--paper); padding:13mm 14mm 14mm; box-shadow:0 8px 30px rgba(20,28,48,.14); }
.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:18px; } .brand{ display:flex; align-items:center; gap:10px; } .brand .wm{ font-size:18.5px; font-weight:800; color:var(--ink); line-height:1; } .brand .tg{ font-size:9.5px; color:var(--muted); letter-spacing:.05em; margin-top:3px; text-transform:uppercase; } .clinic{ text-align:right; line-height:1.4; } .clinic .cl{ font-size:11.5px; color:var(--muted); margin-top:2px; }
.hr{ height:2px; background:var(--ink); margin-top:8px; } .title{ text-align:center; margin-top:11px; } .title h1{ font-size:17.5px; font-weight:800; } .title .uz{ font-size:12px; font-style:normal; color:var(--muted); }
.meta{ display:flex; justify-content:center; margin-top:5px; } .meta .chip{ font-size:12px; color:var(--ink-2); padding:0 11px; position:relative; } .meta .chip + .chip::before{ content:""; position:absolute; left:0; top:1px; bottom:1px; width:1px; background:var(--line); } .meta .chip b{ color:var(--ink); font-weight:700; }
.pstrip{ display:grid; grid-template-columns:repeat(4,1fr); gap:0 18px; margin-top:9px; padding:6px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); } .pstrip .fl{ font-size:11px; color:var(--muted); } .pstrip .fv{ font-size:13px; font-weight:700; color:var(--ink); }
.secbar{ background:var(--bar); border-radius:5px; padding:4px 11px; margin:9px 0 4px; break-inside:avoid;  break-after:avoid; page-break-after:avoid; } .secbar .ru{ font-size:13px; font-weight:800; color:var(--ink); text-transform:uppercase; }
table.res{ width:100%; table-layout:fixed; border-collapse:collapse; font-size:11px; } table.res th, table.res td{ border:1px solid var(--line); padding:3px 7px; } table.res tbody tr:nth-child(even) td{ background:#f4f5f7; } thead{ display:table-header-group; } table.res tr{ break-inside:avoid; page-break-inside:avoid; } table.res thead th{ font-size:9.5px; text-transform:uppercase; color:var(--muted); font-weight:700; text-align:left; padding:2px 6px; border:1px solid var(--line); background:#eef1f4; } table.res th.c,table.res td.c{ text-align:center; } table.res th.r,table.res td.r{ text-align:right; } table.res tbody td{ padding:2px 6px; border:1px solid var(--line); overflow-wrap:anywhere; word-break:break-word; } .pname{ color:var(--ink); } .pname small{ color:var(--faint); } .ref{ color:var(--ink-2); font-weight:600; white-space:nowrap; } .ref .rr{ display:block; white-space:nowrap; line-height:1.35; } .ref .rr.hit{ font-weight:800; color:var(--ink); } td.flag{ font-weight:800; color:var(--ink); }
.concl{ margin-top:10px; border-left:3px solid var(--ink); padding:1px 0 1px 10px; } .concl .ch{ font-size:12px; font-weight:800; text-transform:uppercase; color:var(--accent); margin-bottom:2px; } .concl p{ font-size:11.5px; line-height:1.45; color:var(--ink-2); white-space:pre-wrap; }
.signoff{ display:flex; justify-content:space-between; align-items:flex-end; gap:16px; margin-top:14px; break-inside:avoid; } .sig{ flex:1; max-width:280px; } .sig .role{ font-size:11px; text-transform:uppercase; color:var(--muted); } .sig .name{ font-size:13.5px; font-weight:700; color:var(--ink); border-top:1px solid var(--ink); padding-top:3px; margin-top:16px; } .sig .spec{ font-size:11px; color:var(--muted); }
.sign-right{ display:flex; align-items:flex-end; gap:12px; } .qr{ width:46px; height:46px; flex:none; padding:3px; border:1px solid var(--line); border-radius:5px; } .qr svg{ width:100%; height:100%; } .qr svg path,.qr svg rect{ fill:var(--ink); } .stamp{ width:58px; height:58px; flex:none; border:1.5px dashed var(--muted); border-radius:50%; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:12px; font-weight:800; transform:rotate(-10deg); opacity:.75; }
.sheet:not(.show-stamp) .stamp, .sheet:not(.show-qr) .qr, .sheet:not(.show-signature) .sig{ display:none; }   /* STAMP_ONLY_V1 */
.legal{ font-size:10px; color:var(--faint); text-align:center; margin-top:9px; line-height:1.45; } .foot{ margin-top:auto; padding-top:7px; border-top:1px solid var(--ink); display:flex; justify-content:space-between; font-size:11.5px; color:var(--ink); } .foot b{ font-weight:700; }
@media print{ @page{ size:A4; margin:12mm 13mm; } html,body{ background:#fff; padding:0; } body{ display:block; } /* DOC_A4_PRINT_V1 */ :root{ --ink:#000; --ink-2:#0f131b; --muted:#20242e; --faint:#333a45; } .sheet{ box-shadow:none; width:auto; min-height:268mm; padding:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
${ECONOMY_BW_CSS}
</style></head><body><section class="sheet ${toggleCls(s)}">
  <div class="head"><div class="brand">${logoTag(s, 32)}<div><div class="wm">${esc(s.clinicName || 'Клиника')}</div>${s.tagline ? `<div class="tg">${esc(s.tagline)}</div>` : ''}</div></div>
    <div class="clinic">${s.address ? `<div class="cl">${esc(s.address)}</div>` : ''}<div class="cl">${esc(s.phone || '')}${s.web ? ` · ${esc(s.web)}` : ''}</div></div></div>
  <div class="hr"></div>
  <div class="title"><h1>Результаты лабораторных исследований</h1><div class="uz">Laboratoriya natijalari</div>
    <div class="meta">${d.requestNo ? `<span class="chip">Заявка <b>${esc(d.requestNo)}</b></span>` : ''}<span class="chip">Выдан <b>${esc(d.dateOut || new Date().toLocaleDateString('ru-RU'))}</b></span></div></div>
  <div class="pstrip"><div><div class="fl">ФИО</div><div class="fv">${esc(d.patientName || '—')}</div></div><div><div class="fl">Дата рожд.</div><div class="fv">${esc(d.dob || '—')}</div></div><div><div class="fl">Пол</div><div class="fv">${esc(d.sex || '—')}</div></div><div><div class="fl">ID</div><div class="fv">${esc(d.mrn || '—')}</div></div></div>
  ${(d.groups || []).map(grp).join('')}
  ${d.conclusion ? `<div class="concl"><div class="ch">Заключение · Xulosa</div><p>${esc(d.conclusion)}</p></div>` : ''}
  <div class="signoff"><div class="sig"><div class="role">Заведующий лабораторией</div><div class="name">${esc(d.labChief || '—')}</div><div class="spec">${esc(d.labChiefSpec || '')} · подпись</div></div>
    <div class="sign-right"><div class="qr">${QR_SVG}</div></div></div>
  ${s.legalNote ? `<div class="legal">${esc(s.legalNote)}</div>` : ''}
  ${s.footerNote ? `<div class="thanks-eco">${esc(s.footerNote)}</div>` : ''}
  <div class="foot"><div>${s.web ? `<b>${esc(s.web)}</b> · ` : ''}${esc(s.clinicName || '')}</div><div>${esc(s.phone || '')}</div></div>
</section></body></html>`;
}

// ---------------------------------------------------------------------------
// IMAGING / DIAGNOSTICS · CLASSIC
// ---------------------------------------------------------------------------
const FILM_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M3 17l5-4 4 3 3-2 6 5"/></svg>';
// DIAG_IMAGES_V1 — uploaded imaging photos block (+/- like the text sections).
// `d.images` is an array of data URLs. Rendered in the on-screen blank, in print,
// and in the archived-doc view. Fully inline-styled so it needs no template CSS;
// the add/remove controls render ONLY in editor mode (d.__editor) and so never
// reach print/archive (those render with __editor:false).
function imagingImages(d) {
    const imgs = Array.isArray(d.images) ? d.images : [];
    if (!imgs.length && !d.__editor) return '';
    const cell = (src, i) =>
        `<div style="position:relative;border:1px solid var(--line,#e3e6ec);border-radius:8px;overflow:hidden;background:#f7f8fa;break-inside:avoid;">`
        + `<img src="${esc(src)}" alt="" style="display:block;width:100%;height:auto;max-height:150mm;object-fit:contain;">`
        + (d.__editor ? `<button type="button" data-img-rm="${i}" title="Удалить" style="position:absolute;top:5px;right:5px;width:22px;height:22px;border:0;border-radius:50%;background:rgba(17,24,39,.72);color:#fff;font:700 14px/22px Arial,sans-serif;cursor:pointer;padding:0;">×</button>` : '')
        + `</div>`;
    const grid = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:9px;padding-left:11px;">${imgs.map(cell).join('')}</div>`;
    const add = d.__editor
        ? `<button type="button" data-img-add style="display:block;width:calc(100% - 11px);margin:9px 0 0 11px;padding:9px 12px;border:1px dashed #cbd5e1;border-radius:8px;background:#f8fafc;color:#64748b;font:600 11px/1.2 'Helvetica Neue',Arial,sans-serif;cursor:pointer;text-align:center;">+ Добавить изображение</button>`
        : '';
    return `<div class="sec" style="margin-top:16px;break-inside:auto;">`
        + `<div style="font-size:15px;font-weight:800;text-transform:uppercase;color:var(--accent,#16213f);padding-left:11px;margin-bottom:6px;">Изображения <span style="font-style:normal;font-weight:400;color:var(--faint,#9aa1b2);">· Rasmlar</span></div>`
        + `${grid}${add}</div>`;
}

function imagingClassic(s, d) {
    const st = d.study || {};
    const films = (d.films || []).slice(0, 3);
    const f = (l, uz, v) => v ? `<div class="fl">${esc(l)}${uz ? ` <i>· ${esc(uz)}</i>` : ''}</div><div class="fv">${esc(v)}</div>` : '';
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Диагностика · ${esc(d.patientName || '')}</title><style>
${PRINT_FONT_FACE_CSS}
:root{ --accent:${esc(s.accent)}; --accent-2:${esc(s.accent)}; --accent-soft:${esc(s.accentSoft || '#eef6f5')}; --ink:${esc(s.ink || '#16213f')}; --ink-2:#3a4258; --muted:#454e63; --faint:#6b7285; --line:#e3e6ec; --line-2:#eef0f4; --paper:#fff; --page-bg:#e9eaee; --card-line:#e7eceb; }
*{margin:0;padding:0;box-sizing:border-box;} body{ background:var(--page-bg); font-family:'Onest',"Helvetica Neue",Arial,"Segoe UI",sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased; padding:24px 14px; display:flex; flex-direction:column; align-items:center; }
.sheet{ position:relative; width:210mm; min-height:297mm; background:var(--paper); padding:15mm 14mm 16mm; box-shadow:0 8px 34px rgba(20,28,48,.16); }
.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:18px; } .brand{ display:flex; align-items:center; gap:13px; } .brand .wm{ font-size:25.5px; font-weight:800; color:var(--ink); line-height:1; } .brand .tg{ font-size:12px; color:var(--muted); letter-spacing:.04em; margin-top:4px; } .clinic{ text-align:right; line-height:1.5; } .clinic .cl{ font-size:13.5px; color:var(--muted); } .clinic .cl b{ color:var(--ink-2); font-weight:600; }
.rule{ height:1px; background:var(--line); margin:11px 0 0; } .title{ text-align:center; margin-top:15px; } .title h1{ font-size:20px; font-weight:800; color:var(--ink); } .title .uz{ font-size:15px; font-style:italic; color:var(--muted); margin-top:3px; }
.meta{ display:flex; justify-content:center; margin-top:9px; } .meta .chip{ font-size:14px; color:var(--ink-2); padding:0 14px; position:relative; } .meta .chip + .chip::before{ content:""; position:absolute; left:0; top:2px; bottom:2px; width:1px; background:var(--line); } .meta .chip b{ color:var(--ink); font-weight:700; }
.cards{ display:grid; grid-template-columns:1fr 1fr; gap:11px; margin-top:14px; } .card{ background:var(--accent-soft); border:1px solid var(--card-line); border-radius:10px; padding:11px 14px 12px; break-inside:avoid; } .card .ct{ font-size:13px; font-weight:800; letter-spacing:.09em; text-transform:uppercase; color:var(--accent); margin-bottom:9px; } .card .ct .uz{ color:var(--faint); font-weight:600; font-style:italic; text-transform:none; }
.fgrid{ display:grid; grid-template-columns:auto 1fr; gap:5px 14px; } .fgrid .fl{ font-size:12px; color:var(--muted); align-self:center; } .fgrid .fl i{ font-style:italic; color:var(--faint); } .fgrid .fv{ font-size:15px; font-weight:700; color:var(--ink); text-align:right; }
.films{ display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:14px; break-inside:avoid; } .film{ position:relative; aspect-ratio:4/3; background:#111722; border-radius:8px; overflow:hidden; display:flex; align-items:center; justify-content:center; } .film .lab{ color:#5b6675; text-align:center; } .film .lab svg{ width:28px; height:28px; } .film .lab .t{ font-size:12px; margin-top:5px; } .film .cap{ position:absolute; left:7px; bottom:6px; font-size:11.5px; color:#cdd5e0; font-weight:700; } .film .cap2{ position:absolute; right:7px; bottom:6px; font-size:11px; color:#8b95a5; }
.sec{ margin-top:16px; } .sec-h{ display:flex; align-items:baseline; gap:8px; padding-left:11px; position:relative; margin-bottom:5px; } .sec-h::before{ content:""; position:absolute; left:0; top:1px; bottom:1px; width:3.5px; border-radius:2px; background:var(--accent); } .sec-h .ru{ font-size:15.5px; font-weight:800; color:var(--ink); text-transform:uppercase; } .sec-h .uz{ font-size:13.5px; font-style:italic; color:var(--faint); }
.sec-b{ font-size:14px; line-height:1.6; color:var(--ink-2); padding-left:11px; } .sec-b p{ margin-bottom:7px; } .sec-b p:last-child{ margin-bottom:0; }
.concl{ margin-top:16px; border:1px solid var(--card-line); border-left:4px solid var(--line); background:var(--accent-soft); border-radius:9px; padding:11px 15px; } .concl .ch{ font-size:15px; font-weight:800; text-transform:uppercase; color:var(--accent); margin-bottom:5px; } .concl .ch .uz{ font-size:13px; font-style:italic; color:var(--faint); font-weight:400; margin-left:6px; } .concl p{ font-size:14px; line-height:1.55; color:var(--ink-2); white-space:pre-wrap; }
.signoff{ display:flex; justify-content:space-between; align-items:flex-end; gap:20px; margin-top:20px; break-inside:avoid; } .sig{ flex:1; max-width:320px; } .sig .role{ font-size:11.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); } .sig .role i{ font-style:italic; color:var(--faint); } .sig .mark{ height:34px; margin:2px 0 1px; display:flex; align-items:flex-end; } .sig .mark svg{ height:32px; } .sig .name{ font-size:15px; font-weight:700; color:var(--ink); border-top:1px solid var(--ink); padding-top:4px; } .sig .spec{ font-size:13px; color:var(--muted); margin-top:2px; }
.sign-right{ display:flex; align-items:flex-end; gap:18px; } .qr{ width:60px; height:60px; flex:none; padding:5px; border:1px solid var(--line); border-radius:6px; } .qr svg{ width:100%; height:100%; } .qr svg path,.qr svg rect{ fill:var(--ink); } .qr-cap{ font-size:10px; color:var(--faint); text-align:center; margin-top:3px; } .stamp{ width:86px; height:86px; flex:none; border:2px dashed var(--muted); border-radius:50%; position:relative; transform:rotate(-11deg); opacity:.78; } .stamp::before{ content:""; position:absolute; inset:7px; border:1px solid var(--line); border-radius:50%; } .stamp .sc{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--muted); } .stamp .sc .mp{ font-size:17.5px; font-weight:800; } .stamp .sc .sm{ font-size:9px; letter-spacing:.12em; text-transform:uppercase; margin-top:2px; }
.sheet:not(.show-stamp) .stamp, .sheet:not(.show-qr) .qr-box, .sheet:not(.show-qr) .qr, .sheet:not(.show-signature) .sig{ display:none; }   /* STAMP_ONLY_V1 */
.legal{ font-size:11px; color:var(--faint); text-align:center; margin-top:13px; padding:0 8mm; line-height:1.5; } .foot{ margin-top:auto; padding-top:10px; border-top:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; } .foot .fl{ font-size:13px; color:var(--ink); } .foot .fl b{ font-weight:700; } .foot .fr{ font-size:13px; font-weight:700; color:var(--ink); }
@media print{ @page{ size:A4; margin:13mm 14mm; } html,body{ background:#fff; padding:0; } body{ display:block; } /* DOC_A4_PRINT_V1 */ :root{ --ink:#000; --ink-2:#0f131b; --muted:#20242e; --faint:#333a45; } .sheet{ box-shadow:none; width:auto; min-height:268mm; padding:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body><section class="sheet ${toggleCls(s)}">
  ${clinicHeadHtml(s, 46)}<div class="rule"></div>
  <div class="title"><h1>Результат диагностического исследования</h1><div class="uz">Diagnostika tekshiruvi natijasi</div>
    <div class="meta">${d.docNo ? `<span class="chip">Документ <b>${esc(d.docNo)}</b></span>` : ''}${d.dateIn ? `<span class="chip">Исследование <b>${esc(d.dateIn)}</b></span>` : ''}<span class="chip">Выдан <b>${esc(d.dateOut || new Date().toLocaleDateString('ru-RU'))}</b></span></div></div>
  <div class="cards">
    <div class="card"><div class="ct">Пациент <span class="uz">· Bemor</span></div><div class="fgrid">${f('ФИО', 'F.I.Sh.', d.patientName)}${f('Дата рождения', '', d.dob)}${f('Пол', '', d.sex)}${f('ID пациента', '', d.mrn)}</div></div>
    <div class="card"><div class="ct">Исследование <span class="uz">· Tekshiruv</span></div><div class="fgrid">${f('Вид', 'Turi', st.kind)}${f('Область', 'Soha', st.area)}${f('Аппарат', 'Apparat', st.device)}${f('Протокол', 'Protokol', st.protocol)}</div></div>
  </div>
  ${films.length ? `<div class="films">${films.map(fl => `<div class="film"><div class="lab">${FILM_SVG}<div class="t">Место для снимка</div></div><div class="cap">${esc(fl.caption || '')}</div><div class="cap2">${esc(fl.sub || '')}</div></div>`).join('')}</div>` : ''}
  <div class="sec"><div class="sec-h"><span class="ru">Описание</span><span class="uz">· Tavsif</span></div><div class="sec-b" data-field="instrumental_text">${paras(d.description).map(p => `<p>${esc(p)}</p>`).join('') || (d.__editor ? '' : '<p>—</p>')}</div></div>
  ${(d.conclusion || d.__editor) ? `<div class="concl"><div class="ch">Заключение <span class="uz">· Xulosa</span></div><p data-field="primary_diagnosis">${esc(d.conclusion)}</p></div>` : ''}
  ${imagingImages(d)}
  <div class="signoff"><div class="sig"><div class="role">Врач-рентгенолог <i>· Rentgenolog shifokor</i></div><div class="mark">${SIG_SVG}</div><div class="name">${esc(d.radiologist || '—')}</div><div class="spec">${esc(d.radiologistSpec || '')} · подпись</div></div>
    <div class="sign-right"><div class="qr-box" style="text-align:center"><div class="qr">${QR_SVG}</div><div class="qr-cap">Проверка<br>подлинности</div></div></div></div>
  ${s.legalNote ? `<div class="legal">${esc(s.legalNote)}</div>` : ''}
  <div class="foot"><div class="fl">${s.web ? `<b>${esc(s.web)}</b> · ` : ''}${esc(s.clinicName || '')}</div><div class="fr">${esc(s.phone || '')}</div></div>
</section></body></html>`;
}

// ---------------------------------------------------------------------------
// IMAGING / DIAGNOSTICS · COMPACT
// ---------------------------------------------------------------------------
function imagingCompact(s, d) {
    const st = d.study || {};
    const fld = (l, v) => v ? `<div class="fld"><span class="l">${esc(l)}</span><span class="d"></span><span class="v">${esc(v)}</span></div>` : '';
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Диагностика · ${esc(d.patientName || '')}</title><style>
${PRINT_FONT_FACE_CSS}
:root{ --accent:${esc(s.accent)}; --ink:${esc(s.ink || '#16213f')}; --ink-2:#39414f; --muted:#474f5e; --faint:#727a88; --line:#e2e4e9; --line-2:#eef0f3; --bar:#f2f3f5; --paper:#fff; --page-bg:#e9eaee; }
*{margin:0;padding:0;box-sizing:border-box;} body{ background:var(--page-bg); font-family:'Onest',"Helvetica Neue",Arial,"Segoe UI",sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased; padding:24px 14px; display:flex; flex-direction:column; align-items:center; }
.sheet{ position:relative; width:210mm; min-height:297mm; background:var(--paper); padding:13mm 14mm 14mm; box-shadow:0 8px 30px rgba(20,28,48,.14); }
.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:18px; } .brand{ display:flex; align-items:center; gap:10px; } .brand .wm{ font-size:18.5px; font-weight:800; line-height:1; } .brand .tg{ font-size:9.5px; color:var(--muted); letter-spacing:.05em; margin-top:3px; text-transform:uppercase; } .clinic{ text-align:right; } .clinic .cl{ font-size:11.5px; color:var(--muted); margin-top:2px; }
.hr{ height:2px; background:var(--ink); margin-top:8px; } .title{ text-align:center; margin-top:11px; } .title h1{ font-size:17.5px; font-weight:800; } .title .uz{ font-size:12px; font-style:italic; color:var(--muted); }
.meta{ display:flex; justify-content:center; margin-top:5px; } .meta .chip{ font-size:12px; color:var(--ink-2); padding:0 11px; position:relative; } .meta .chip + .chip::before{ content:""; position:absolute; left:0; top:1px; bottom:1px; width:1px; background:var(--line); } .meta .chip b{ color:var(--ink); font-weight:700; }
.entwo{ display:grid; grid-template-columns:1fr 1fr; gap:0 34px; margin-top:11px; } .ent .cap{ font-size:11.5px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); margin-bottom:4px; } .fld{ display:flex; align-items:baseline; gap:8px; font-size:13px; padding-bottom:2.5px; margin-bottom:2.5px; border-bottom:1px dotted var(--line); } .fld .l{ color:var(--muted); white-space:nowrap; } .fld .d{ flex:1; } .fld .v{ color:var(--ink); font-weight:700; text-align:right; }
.secbar{ background:var(--bar); border-radius:5px; padding:4px 11px; margin:9px 0 5px; break-inside:avoid;  break-after:avoid; page-break-after:avoid; } .secbar .ru{ font-size:13px; font-weight:800; text-transform:uppercase; } .secbar .uz{ font-size:11.5px; font-style:italic; color:var(--muted); margin-left:6px; }
.sec-b{ font-size:12px; line-height:1.45; color:var(--ink-2); padding:0 2px; } .sec-b p{ margin-bottom:5px; }
.concl{ margin-top:8px; border-left:3px solid var(--ink); padding:1px 0 1px 10px; } .concl .ch{ font-size:12px; font-weight:800; text-transform:uppercase; color:var(--accent); margin-bottom:2px; } .concl p{ font-size:11.5px; line-height:1.45; color:var(--ink-2); white-space:pre-wrap; }
.signoff{ display:flex; justify-content:space-between; align-items:flex-end; gap:16px; margin-top:14px; break-inside:avoid; } .sig{ flex:1; max-width:280px; } .sig .role{ font-size:11px; text-transform:uppercase; color:var(--muted); } .sig .name{ font-size:13.5px; font-weight:700; border-top:1px solid var(--ink); padding-top:3px; margin-top:16px; } .sig .spec{ font-size:11px; color:var(--muted); }
.sign-right{ display:flex; align-items:flex-end; gap:12px; } .qr{ width:46px; height:46px; flex:none; padding:3px; border:1px solid var(--line); border-radius:5px; } .qr svg{ width:100%; height:100%; } .qr svg path,.qr svg rect{ fill:var(--ink); } .stamp{ width:58px; height:58px; flex:none; border:1.5px dashed var(--muted); border-radius:50%; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:12px; font-weight:800; transform:rotate(-10deg); opacity:.75; }
.legal{ font-size:10px; color:var(--faint); text-align:center; margin-top:9px; line-height:1.45; } .foot{ margin-top:auto; padding-top:7px; border-top:1px solid var(--ink); display:flex; justify-content:space-between; font-size:11.5px; color:var(--ink); } .foot b{ font-weight:700; }
@media print{ @page{ size:A4; margin:12mm 13mm; } html,body{ background:#fff; padding:0; } body{ display:block; } /* DOC_A4_PRINT_V1 */ :root{ --ink:#000; --ink-2:#0f131b; --muted:#20242e; --faint:#333a45; } .sheet{ box-shadow:none; width:auto; min-height:268mm; padding:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
${ECONOMY_BW_CSS}
</style></head><body><section class="sheet ${toggleCls(s)}">
  <div class="head"><div class="brand">${logoTag(s, 32)}<div><div class="wm">${esc(s.clinicName || 'Клиника')}</div>${s.tagline ? `<div class="tg">${esc(s.tagline)}</div>` : ''}</div></div>
    <div class="clinic">${s.address ? `<div class="cl">${esc(s.address)}</div>` : ''}<div class="cl">${esc(s.phone || '')}${s.web ? ` · ${esc(s.web)}` : ''}</div></div></div>
  <div class="hr"></div>
  <div class="title"><h1>Результат диагностики</h1><div class="uz">Diagnostika natijasi</div>
    <div class="meta">${d.docNo ? `<span class="chip">№ <b>${esc(d.docNo)}</b></span>` : ''}<span class="chip">Выдан <b>${esc(d.dateOut || new Date().toLocaleDateString('ru-RU'))}</b></span></div></div>
  <div class="entwo">
    <div class="ent"><div class="cap">Пациент</div>${fld('ФИО', d.patientName)}${fld('Дата рожд.', d.dob)}${fld('Пол', d.sex)}${fld('ID', d.mrn)}</div>
    <div class="ent"><div class="cap">Исследование</div>${fld('Вид', st.kind)}${fld('Область', st.area)}${fld('Аппарат', st.device)}${fld('Протокол', st.protocol)}</div>
  </div>
  <div class="secbar"><span class="ru">Описание</span><span class="uz">· Tavsif</span></div>
  <div class="sec-b" data-field="instrumental_text">${paras(d.description).map(p => `<p>${esc(p)}</p>`).join('') || (d.__editor ? '' : '<p>—</p>')}</div>
  ${(d.conclusion || d.__editor) ? `<div class="concl"><div class="ch">Заключение · Xulosa</div><p data-field="primary_diagnosis">${esc(d.conclusion)}</p></div>` : ''}
  ${imagingImages(d)}
  <div class="signoff"><div class="sig"><div class="role">Врач-рентгенолог</div><div class="name">${esc(d.radiologist || '—')}</div><div class="spec">${esc(d.radiologistSpec || '')} · подпись</div></div>
    <div class="sign-right"><div class="qr">${QR_SVG}</div></div></div>
  ${s.legalNote ? `<div class="legal">${esc(s.legalNote)}</div>` : ''}
  ${s.footerNote ? `<div class="thanks-eco">${esc(s.footerNote)}</div>` : ''}
  <div class="foot"><div>${s.web ? `<b>${esc(s.web)}</b> · ` : ''}${esc(s.clinicName || '')}</div><div>${esc(s.phone || '')}</div></div>
</section></body></html>`;
}

// ---------------------------------------------------------------------------
// INVOICE · CLASSIC (consumes the cashier/visit-modal data shape)
// ---------------------------------------------------------------------------
function invoiceTotals(d) {
    const itemsSum = (d.items || []).reduce((a, it) => a + Number(it.qty || 1) * Number(it.price || 0), 0);
    const subtotal = Number(d.subtotal != null ? d.subtotal : itemsSum);
    const total = Number(d.total != null ? d.total : subtotal);
    const discount = Math.max(0, subtotal - total);
    return { subtotal, total, discount };
}
// INVOICE_QUEUE_V1 — талон очереди на БУМАЖНОМ счёте (A4).
//
// Мастер записи давно считает номера и передаёт их в печать (`queue:` в
// service-picker-modal.js), но печатал их только invoiceThermal. Вариант бланка
// берётся из настроек, а варианта там нет — значит 'classic', и номер молча
// пропадал: посчитан, доставлен в шаблон, выброшен.
//
// Отдельная вёрстка, а не queueBlockHtml(): у того классы .f-q* существуют
// только в CSS чековой ленты, на A4 они не определены. Здесь стили встроенные,
// поэтому блок не зависит от того, в какой вариант его вставили.
function queueBlockA4(d) {
    const rows = Array.isArray(d && d.queue) ? d.queue.filter(q => q && q.number) : [];
    if (!rows.length) return '';
    const byKey = new Map();
    const groups = [];
    rows.forEach(q => {
        const gk = String(q.key || q.label || '') + '\0' + String(q.number);
        let g = byKey.get(gk);
        if (!g) { g = { label: q.label || '', number: q.number, services: [] }; byKey.set(gk, g); groups.push(g); }
        if (q.service && g.services.indexOf(q.service) === -1) g.services.push(q.service);
    });
    const card = (g) => `<div style="display:flex;align-items:center;gap:10px;border:1px solid #d6dde2;border-radius:8px;padding:7px 11px;">`
        + `<div style="min-width:0;">`
        + (g.label ? `<div style="font-size:11px;font-weight:700;color:#16323f;">${esc(g.label)}</div>` : '')
        + (g.services.length ? `<div style="font-size:9.5px;color:#55636d;">${esc(g.services.join(' · '))}</div>` : '')
        + `</div>`
        + `<div style="margin-left:auto;font-size:22px;font-weight:800;line-height:1;color:#16323f;">${esc(String(g.number))}</div>`
        + `</div>`;
    return `<div style="margin:10px 0 2px;">`
        + `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#55636d;margin-bottom:5px;">`
        + `${groups.length > 1 ? 'Номера очереди' : 'Номер очереди'}</div>`
        + `<div style="display:flex;gap:8px;flex-wrap:wrap;">${groups.map(card).join('')}</div>`
        + `</div>`;
}

function invoiceClassic(s, d) {
    const t = invoiceTotals(d);
    const rows = (d.items || []).map((it, i) => `<tr><td class="num">${i + 1}</td><td class="svc">${esc(it.name || '—')}</td><td class="c">${esc(it.qty || 1)}</td><td class="r money">${money(it.price)}</td><td class="r money sum">${money(Number(it.qty || 1) * Number(it.price || 0))}</td></tr>`).join('');
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Счёт · ${esc(d.docNo || '')}</title><style>
${PRINT_FONT_FACE_CSS}
:root{ --accent:${esc(s.accent)}; --accent-2:${esc(s.accent)}; --accent-soft:${esc(s.accentSoft || '#eef6f5')}; --ink:${esc(s.ink || '#16213f')}; --ink-2:#3a4258; --muted:#454e63; --faint:#6b7285; --line:#e3e6ec; --line-2:#eef0f4; --paper:#fff; --page-bg:#e9eaee; --card-line:#e7eceb; }
*{margin:0;padding:0;box-sizing:border-box;} body{ background:var(--page-bg); font-family:'Onest',"Helvetica Neue",Arial,"Segoe UI",sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased; padding:24px 14px; display:flex; flex-direction:column; align-items:center; }
.sheet{ position:relative; width:210mm; min-height:297mm; background:var(--paper); padding:15mm 14mm 16mm; box-shadow:0 8px 34px rgba(20,28,48,.16); }
.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:18px; } .brand{ display:flex; align-items:center; gap:13px; } .brand .wm{ font-size:25.5px; font-weight:800; color:var(--ink); line-height:1; } .brand .tg{ font-size:12px; color:var(--muted); letter-spacing:.04em; margin-top:4px; } .clinic{ text-align:right; line-height:1.5; } .clinic .cl{ font-size:13.5px; color:var(--muted); } .clinic .cl b{ color:var(--ink-2); font-weight:600; }
.rule{ height:1px; background:var(--line); margin:11px 0 0; } .title{ text-align:center; margin-top:15px; } .title h1{ font-size:20px; font-weight:800; color:var(--ink); } .title .uz{ font-size:15px; font-style:italic; color:var(--muted); margin-top:3px; }
.meta{ display:flex; justify-content:center; margin-top:9px; } .meta .chip{ font-size:14px; color:var(--ink-2); padding:0 14px; position:relative; } .meta .chip + .chip::before{ content:""; position:absolute; left:0; top:2px; bottom:2px; width:1px; background:var(--line); } .meta .chip b{ color:var(--ink); font-weight:700; }
.cards{ display:grid; grid-template-columns:1fr 1fr; gap:11px; margin-top:14px; } .card{ background:var(--accent-soft); border:1px solid var(--card-line); border-radius:10px; padding:11px 14px 12px; break-inside:avoid; } .card .ct{ font-size:13px; font-weight:800; letter-spacing:.09em; text-transform:uppercase; color:var(--accent); margin-bottom:9px; } .card .ct .uz{ color:var(--faint); font-weight:600; font-style:italic; text-transform:none; }
.fgrid{ display:grid; grid-template-columns:auto 1fr; gap:5px 14px; } .fgrid .fl{ font-size:12px; color:var(--muted); align-self:center; } .fgrid .fv{ font-size:15px; font-weight:700; color:var(--ink); text-align:right; }
.sec-h{ display:flex; align-items:baseline; gap:8px; padding-left:11px; position:relative; margin:16px 0 6px; } .sec-h::before{ content:""; position:absolute; left:0; top:1px; bottom:1px; width:3.5px; border-radius:2px; background:var(--accent); } .sec-h .ru{ font-size:15.5px; font-weight:800; color:var(--ink); text-transform:uppercase; } .sec-h .uz{ font-size:13.5px; font-style:italic; color:var(--faint); }
table.items{ width:100%; border-collapse:collapse; font-size:14px; } table.items thead th{ font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:700; text-align:left; padding:0 10px 6px 0; border-bottom:1.5px solid var(--line); } table.items th.r,table.items td.r{ text-align:right; } table.items th.c,table.items td.c{ text-align:center; } table.items tbody td{ padding:8px 10px 8px 0; border-bottom:1px solid var(--line-2); vertical-align:top; break-inside:avoid; } table.items .num{ width:20px; color:var(--accent); font-weight:800; } table.items .svc{ font-weight:600; color:var(--ink); } table.items .money{ white-space:nowrap; } table.items .sum{ font-weight:700; }
.below{ display:flex; justify-content:flex-end; margin-top:14px; break-inside:avoid; } .totals{ width:300px; border:1px solid var(--card-line); border-radius:10px; overflow:hidden; } .totals .tr{ display:flex; justify-content:space-between; padding:8px 14px; font-size:14px; } .totals .tr .tl{ color:var(--muted); } .totals .tr .tv{ font-weight:700; color:var(--ink); } .totals .tr.disc .tv{ color:var(--accent-2); } .totals .tr + .tr{ border-top:1px solid var(--line-2); } .totals .due{ background:var(--accent); color:#fff; padding:11px 14px; display:flex; justify-content:space-between; align-items:center; } .totals .due .dl{ font-size:15px; font-weight:700; text-transform:uppercase; } .totals .due .dv{ font-size:20px; font-weight:800; } .totals .due .dv span{ font-size:15px; font-weight:600; opacity:.9; margin-left:3px; }
.signoff{ display:flex; justify-content:space-between; align-items:flex-end; gap:20px; margin-top:18px; break-inside:avoid; } .sig{ flex:1; max-width:300px; } .sig .role{ font-size:11.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); } .sig .role i{ font-style:italic; color:var(--faint); } .sig .mark{ height:34px; margin:2px 0 1px; display:flex; align-items:flex-end; } .sig .mark svg{ height:32px; } .sig .name{ font-size:15px; font-weight:700; color:var(--ink); border-top:1px solid var(--ink); padding-top:4px; } .sig .spec{ font-size:13px; color:var(--muted); margin-top:2px; }
.sign-right{ display:flex; align-items:flex-end; gap:18px; } .qr{ width:60px; height:60px; flex:none; padding:5px; border:1px solid var(--line); border-radius:6px; } .qr svg{ width:100%; height:100%; } .qr svg path,.qr svg rect{ fill:var(--ink); } .qr-cap{ font-size:10px; color:var(--faint); text-align:center; margin-top:3px; } .stamp{ width:86px; height:86px; flex:none; border:2px dashed var(--muted); border-radius:50%; position:relative; transform:rotate(-11deg); opacity:.78; } .stamp::before{ content:""; position:absolute; inset:7px; border:1px solid var(--line); border-radius:50%; } .stamp .sc{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--muted); } .stamp .sc .mp{ font-size:16px; font-weight:800; } .stamp .sc .sm{ font-size:8px; letter-spacing:.12em; text-transform:uppercase; margin-top:2px; }
.sheet:not(.show-stamp) .stamp, .sheet:not(.show-qr) .qr-box, .sheet:not(.show-qr) .qr, .sheet:not(.show-signature) .sig{ display:none; }   /* STAMP_ONLY_V1 */
.note{ font-size:11.5px; color:var(--muted); text-align:center; margin-top:12px; padding:0 6mm; line-height:1.55; } .note b{ color:var(--ink-2); } .foot{ margin-top:auto; padding-top:10px; border-top:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; } .foot .fl{ font-size:13px; color:var(--ink); } .foot .fl b{ font-weight:700; } .foot .fr{ font-size:13px; font-weight:700; color:var(--ink); }
@media print{ @page{ size:A4; margin:13mm 14mm; } html,body{ background:#fff; padding:0; } body{ display:block; } /* DOC_A4_PRINT_V1 */ :root{ --ink:#000; --ink-2:#0f131b; --muted:#20242e; --faint:#333a45; } .sheet{ box-shadow:none; width:auto; min-height:268mm; padding:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body><section class="sheet ${toggleCls(s)}">
  ${clinicHeadHtml(s, 46)}<div class="rule"></div>
  <div class="title"><h1>Счёт на оплату медицинских услуг</h1><div class="uz">Tibbiy xizmatlar uchun to‘lov hisobi</div>
    <div class="meta">${d.docNo ? `<span class="chip">Счёт <b>${esc(d.docNo)}</b></span>` : ''}<span class="chip">Дата <b>${esc(d.issueDate || new Date().toLocaleDateString('ru-RU'))}</b></span>${d.dueDate ? `<span class="chip">Оплатить до <b>${esc(d.dueDate)}</b></span>` : ''}</div></div>
  <div class="cards"><div class="card"><div class="ct">Пациент <span class="uz">· Bemor</span></div><div class="fgrid">${kvRows(d.patient)}</div></div>
    <div class="card"><div class="ct">Плательщик <span class="uz">· To‘lovchi</span></div><div class="fgrid">${kvRows(d.billing)}</div></div></div>
  <div class="sec-h"><span class="ru">Позиции</span><span class="uz">· Xizmatlar ro‘yxati</span></div>
  <table class="items"><thead><tr><th class="num"></th><th>Услуга<span class="uz" style="display:block;color:var(--faint);font-weight:600;font-style:italic">Xizmat</span></th><th class="c">Кол-во</th><th class="r">Цена, сум</th><th class="r">Сумма, сум</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="below"><div class="totals"><div class="tr"><span class="tl">Подытог</span><span class="tv">${money(t.subtotal)}</span></div>${t.discount > 0 ? `<div class="tr disc"><span class="tl">Скидка</span><span class="tv">−${money(t.discount)}</span></div>` : ''}<div class="due"><span class="dl">К оплате</span><span class="dv">${money(t.total)}<span>сум</span></span></div></div></div>
  ${queueBlockA4(d)}
  <div class="signoff"><div class="sig"><div class="role">Кассир · бухгалтер <i>· Kassir</i></div><div class="mark">${SIG_SVG}</div><div class="name">${esc(d.cashierName || '—')}</div><div class="spec">${esc(d.status || '')} · подпись</div></div>
    <div class="sign-right"><div class="qr-box" style="text-align:center"><div class="qr">${QR_SVG}</div><div class="qr-cap">Оплата<br>по QR</div></div></div></div>
  <div class="note">Счёт действителен к оплате до указанной даты. НДС включён в стоимость услуг. Документ сформирован в ИС клиники.</div>
  <div class="foot"><div class="fl">${s.web ? `<b>${esc(s.web)}</b> · ` : ''}${esc(s.clinicName || '')}</div><div class="fr">${esc(s.phone || '')}</div></div>
</section></body></html>`;
}

// ---------------------------------------------------------------------------
// INVOICE · COMPACT
// ---------------------------------------------------------------------------
function invoiceCompact(s, d) {
    const t = invoiceTotals(d);
    const kvFld = (arr) => (arr || []).map(([k, v]) => `<div class="fld"><span class="l">${esc(k)}</span><span class="dd"></span><span class="v">${esc(v)}</span></div>`).join('');
    const rows = (d.items || []).map((it, i) => `<tr><td class="num">${i + 1}</td><td class="svc">${esc(it.name || '—')}</td><td class="c">${esc(it.qty || 1)}</td><td class="r">${money(it.price)}</td><td class="r sum">${money(Number(it.qty || 1) * Number(it.price || 0))}</td></tr>`).join('');
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Счёт · ${esc(d.docNo || '')}</title><style>
${PRINT_FONT_FACE_CSS}
:root{ --accent:${esc(s.accent)}; --ink:${esc(s.ink || '#16213f')}; --ink-2:#39414f; --muted:#474f5e; --faint:#727a88; --line:#e2e4e9; --line-2:#eef0f3; --bar:#f2f3f5; --paper:#fff; --page-bg:#e9eaee; }
*{margin:0;padding:0;box-sizing:border-box;} body{ background:var(--page-bg); font-family:'Onest',"Helvetica Neue",Arial,"Segoe UI",sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased; padding:24px 14px; display:flex; flex-direction:column; align-items:center; }
.sheet{ position:relative; width:210mm; min-height:297mm; background:var(--paper); padding:13mm 14mm 14mm; box-shadow:0 8px 30px rgba(20,28,48,.14); }
.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:18px; } .brand{ display:flex; align-items:center; gap:10px; } .brand .wm{ font-size:18.5px; font-weight:800; line-height:1; } .brand .tg{ font-size:9.5px; color:var(--muted); letter-spacing:.05em; margin-top:3px; text-transform:uppercase; } .clinic{ text-align:right; } .clinic .cl{ font-size:11.5px; color:var(--muted); margin-top:2px; }
.hr{ height:2px; background:var(--ink); margin-top:8px; } .title{ text-align:center; margin-top:11px; } .title h1{ font-size:17.5px; font-weight:800; } .title .uz{ font-size:12px; font-style:italic; color:var(--muted); }
.meta{ display:flex; justify-content:center; margin-top:5px; } .meta .chip{ font-size:12px; color:var(--ink-2); padding:0 11px; position:relative; } .meta .chip + .chip::before{ content:""; position:absolute; left:0; top:1px; bottom:1px; width:1px; background:var(--line); } .meta .chip b{ color:var(--ink); font-weight:700; }
.entwo{ display:grid; grid-template-columns:1fr 1fr; gap:0 34px; margin-top:11px; } .ent .cap{ font-size:11.5px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); margin-bottom:4px; } .fld{ display:flex; align-items:baseline; gap:8px; font-size:13px; padding-bottom:2.5px; margin-bottom:2.5px; border-bottom:1px dotted var(--line); } .fld .l{ color:var(--muted); white-space:nowrap; } .fld .dd{ flex:1; } .fld .v{ color:var(--ink); font-weight:700; text-align:right; }
.secbar{ background:var(--bar); border-radius:5px; padding:4px 11px; margin:9px 0 5px; break-inside:avoid;  break-after:avoid; page-break-after:avoid; } .secbar .ru{ font-size:13px; font-weight:800; text-transform:uppercase; } .secbar .uz{ font-size:11.5px; font-style:italic; color:var(--muted); margin-left:6px; }
table.items{ width:100%; border-collapse:collapse; font-size:12px; } table.items thead th{ font-size:9.5px; text-transform:uppercase; color:var(--muted); font-weight:700; text-align:left; padding:0 8px 3px 0; border-bottom:1px solid var(--line); } table.items th.r,table.items td.r{ text-align:right; } table.items th.c,table.items td.c{ text-align:center; } table.items tbody td{ padding:3px 8px 3px 0; border-bottom:1px solid var(--line-2); } table.items .num{ width:16px; color:var(--accent); font-weight:800; } table.items .svc{ color:var(--ink); } table.items .sum{ font-weight:700; }
.tot{ display:flex; justify-content:flex-end; gap:24px; margin-top:8px; font-size:13.5px; align-items:baseline; } .tot .due{ font-size:16px; font-weight:800; color:var(--ink); } .tot .due span{ font-size:12px; font-weight:600; color:var(--muted); margin-left:3px; } .tot .sub{ color:var(--muted); }
.signoff{ display:flex; justify-content:space-between; align-items:flex-end; gap:16px; margin-top:14px; break-inside:avoid; } .sig{ flex:1; max-width:260px; } .sig .role{ font-size:11px; text-transform:uppercase; color:var(--muted); } .sig .name{ font-size:13.5px; font-weight:700; border-top:1px solid var(--ink); padding-top:3px; margin-top:16px; } .sig .spec{ font-size:11px; color:var(--muted); }
.sign-right{ display:flex; align-items:flex-end; gap:12px; } .qr{ width:46px; height:46px; flex:none; padding:3px; border:1px solid var(--line); border-radius:5px; } .qr svg{ width:100%; height:100%; } .qr svg path,.qr svg rect{ fill:var(--ink); } .stamp{ width:58px; height:58px; flex:none; border:1.5px dashed var(--muted); border-radius:50%; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:12px; font-weight:800; transform:rotate(-10deg); opacity:.75; }
.note{ font-size:10px; color:var(--faint); text-align:center; margin-top:9px; line-height:1.45; } .foot{ margin-top:auto; padding-top:7px; border-top:1px solid var(--ink); display:flex; justify-content:space-between; font-size:11.5px; color:var(--ink); } .foot b{ font-weight:700; }
@media print{ @page{ size:A4; margin:12mm 13mm; } html,body{ background:#fff; padding:0; } body{ display:block; } /* DOC_A4_PRINT_V1 */ :root{ --ink:#000; --ink-2:#0f131b; --muted:#20242e; --faint:#333a45; } .sheet{ box-shadow:none; width:auto; min-height:268mm; padding:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
${ECONOMY_BW_CSS}
</style></head><body><section class="sheet ${toggleCls(s)}">
  <div class="head"><div class="brand">${logoTag(s, 32)}<div><div class="wm">${esc(s.clinicName || 'Клиника')}</div>${s.tagline ? `<div class="tg">${esc(s.tagline)}</div>` : ''}</div></div>
    <div class="clinic">${s.address ? `<div class="cl">${esc(s.address)}</div>` : ''}<div class="cl">${esc(s.phone || '')}${s.web ? ` · ${esc(s.web)}` : ''}</div></div></div>
  <div class="hr"></div>
  <div class="title"><h1>Счёт на оплату медицинских услуг</h1><div class="uz">To‘lov hisobi</div>
    <div class="meta">${d.docNo ? `<span class="chip">№ <b>${esc(d.docNo)}</b></span>` : ''}<span class="chip">Дата <b>${esc(d.issueDate || new Date().toLocaleDateString('ru-RU'))}</b></span></div></div>
  <div class="entwo"><div class="ent"><div class="cap">Пациент · Bemor</div>${kvFld(d.patient)}</div><div class="ent"><div class="cap">Плательщик · To‘lovchi</div>${kvFld(d.billing)}</div></div>
  <div class="secbar"><span class="ru">Позиции</span><span class="uz">· Xizmatlar</span></div>
  <table class="items"><thead><tr><th class="num"></th><th>Услуга</th><th class="c">Кол-во</th><th class="r">Цена</th><th class="r">Сумма</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="tot">${t.discount > 0 ? `<span class="sub">Подытог ${money(t.subtotal)} · Скидка −${money(t.discount)}</span>` : ''}<span class="due">К оплате: ${money(t.total)}<span>сум</span></span></div>
  ${queueBlockA4(d)}
  <div class="signoff"><div class="sig"><div class="role">Кассир · бухгалтер</div><div class="name">${esc(d.cashierName || '—')}</div><div class="spec">${esc(d.status || '')} · подпись</div></div>
    <div class="sign-right"><div class="qr">${QR_SVG}</div></div></div>
  <div class="note">НДС включён в стоимость услуг. Документ сформирован в ИС клиники.</div>
  ${s.footerNote ? `<div class="thanks-eco">${esc(s.footerNote)}</div>` : ''}
  <div class="foot"><div>${s.web ? `<b>${esc(s.web)}</b> · ` : ''}${esc(s.clinicName || '')}</div><div>${esc(s.phone || '')}</div></div>
</section></body></html>`;
}

// ---------------------------------------------------------------------------
// INVOICE · THERMAL 58mm (cheque printer) — INVOICE_58MM_V1
// ---------------------------------------------------------------------------
// RECEIPT_DOB_PERFORMER_V1 — исполнитель под строкой услуги.
//
// Чек и термо-счёт служат талоном: с ними идут в кабинет и в лабораторию.
// «К кому идти» — это врач, лаборант или медсестра, и на бумаге это должно
// стоять рядом с услугой, а не угадываться по её названию.
//
// Одна функция на оба бланка: они печатаются на одной ленте и обязаны выглядеть
// одинаково. Услуга без назначенного исполнителя (процедуру берёт тот, кто
// свободен) не печатает ничего — пустая строка на 58 мм это выброшенная бумага.
function performerLine(it) {
    const who = it && it.performer ? String(it.performer).trim() : '';
    if (!who) return '';
    const role = it.performerRole ? String(it.performerRole).trim() : '';
    return `<div class="f-item-p">${esc(role ? role + ': ' + who : who)}</div>`;
}

// Строка даты рождения. Тёзки в регистратуре — обычное дело, и в кабинете
// сверяют именно по дате; одного номера карты для этого мало.
function dobRow(d) {
    // Счёт печатают разные экраны, и данные пациента они кладут ПО-РАЗНОМУ:
    // касса — строками в d.patient (['Дата рождения', …]), чек — плоским d.dob.
    // Понимаем оба, иначе «добавили дату рождения» работает у одного экрана и
    // молча не работает у другого.
    let dob = d && d.dob ? String(d.dob).trim() : '';
    if (!dob && d && Array.isArray(d.patient)) {
        const row = d.patient.find(([k]) => /рожд|birth|dob/i.test(String(k)));
        if (row) dob = String(row[1] || '').trim();
    }
    if (!dob || dob === '—') return '';
    return `<div class="f-kv"><span>Дата рожд.</span><b>${esc(dob)}</b></div>`;
}

const PERFORMER_CSS = '.f-item-p{ font-size:9.5px; font-weight:700; margin-top:1px; }';

function invoiceThermal(s, d) {
    // Same 58mm geometry as the cashier cheque (fiscalClassic): left-aligned to the printer's
    // left-anchored printable area, 46mm wide, pure black + bold, 6mm blank top feed so the logo
    // clears the thermal head's smashed leading edge. No signature/QR/stamp (those need A4).
    const t = invoiceTotals(d);
    const logo = (s.logoUrl || s.logoDataUrl) ? `<div class="f-logo"><img src="${esc(s.logoUrl || s.logoDataUrl)}" alt="" style="max-width:14mm;height:auto;filter:grayscale(1) contrast(1.5);"></div>` : '';
    const pick = (arr, kw) => { const r = (arr || []).find(([k]) => String(k).toLowerCase().includes(kw)); return r ? r[1] : ''; };
    const pName = pick(d.patient, 'name') || pick(d.patient, 'фио') || ((d.patient && d.patient[0]) ? d.patient[0][1] : '');
    // «Карта №» — то, как номер подписан на бланке кассы; без него номер карты
    // просто не печатался на термо-счёте.
    const pMrn  = pick(d.patient, 'mrn') || pick(d.patient, 'карта') || pick(d.patient, 'id');
    const paid  = Number(d.paid || 0);
    const due   = Math.max(0, t.total - paid);
    // QUEUE_TICKET_V1 — d.queue = [{ service, label, number }], one per registered
    // service. Absent/empty (any caller that doesn't supply it, and every invoice
    // printed before this change) renders nothing at all, so the slip is unchanged.
    const queueBlock = queueBlockHtml(d);   // QUEUE_TICKET_V2
    const items = (d.items || []).map((it, i) => `<div class="f-item"><div class="f-item-n">${i + 1}. ${esc(it.name)}</div><div class="f-item-r"><span>${esc(it.qty || 1)} × ${money(it.price)}</span><b>${money(Number(it.qty || 1) * Number(it.price || 0))}</b></div>${performerLine(it)}</div>`).join('');
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Счёт · ${esc(d.docNo || '')}</title><style>
${PRINT_FONT_FACE_CSS}
@page{ size:58mm auto; margin:0; }
*{ margin:0; padding:0; box-sizing:border-box; }
html,body{ background:#fff; }
body{ width:46mm; margin:0; padding-top:6mm; font-family:'Onest',"Helvetica Neue",Arial,sans-serif; color:#000; font-size:11px; line-height:1.28; overflow-wrap:anywhere; }
.f-logo{ display:flex; justify-content:center; margin-bottom:2px; }
.f-name{ text-align:center; font-size:14px; font-weight:800; line-height:1.12; }
.f-sub{ text-align:center; font-size:9px; font-weight:700; margin-top:1px; }
.f-hr{ border-top:1px dashed #000; margin:4px 0; }
.f-hr2{ border-top:2px solid #000; margin:4px 0; }
.f-title{ text-align:center; font-size:12px; font-weight:800; text-transform:uppercase; margin:2px 0; }
.f-kv{ display:flex; justify-content:space-between; gap:6px; font-size:11px; font-weight:700; margin:1px 0; }
.f-kv b{ font-weight:800; text-align:right; }
.f-item{ margin:3px 0; }
.f-item-n{ font-size:11px; font-weight:800; overflow-wrap:anywhere; }
.f-item-r{ display:flex; justify-content:space-between; gap:6px; font-size:10.5px; font-weight:700; }
.f-item-r b{ font-weight:800; white-space:nowrap; }
${PERFORMER_CSS}
.f-tot{ display:flex; justify-content:space-between; align-items:baseline; gap:6px; font-size:13.5px; font-weight:800; margin:3px 0; border-top:1.5px solid #000; border-bottom:1.5px solid #000; padding:3px 0; }
.f-tot b{ white-space:nowrap; }
.f-thanks{ text-align:center; font-size:10px; font-weight:700; margin-top:5px; }
${QUEUE_CSS}
@media print{ body{ width:46mm; margin:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; color:#000 !important; } }
</style></head><body>
${logo}<div class="f-name">${esc(s.clinicName || 'Клиника')}</div>
${s.address ? `<div class="f-sub">${esc(s.address)}</div>` : ''}${s.taxId ? `<div class="f-sub">ИНН: ${esc(s.taxId)}</div>` : ''}${s.phone ? `<div class="f-sub">${esc(s.phone)}</div>` : ''}
<div class="f-hr2"></div>
<div class="f-title">Счёт на оплату</div>
<div class="f-kv"><span>Счёт №</span><b>${esc(d.docNo || '—')}</b></div>
<div class="f-kv"><span>Дата</span><b>${esc(d.issueDate || d.date || new Date().toLocaleDateString('ru-RU'))}</b></div>
${pName ? `<div class="f-item-n" style="margin:1px 0">Пациент: ${esc(pName)}</div>` : ''}
${pMrn ? `<div class="f-kv"><span>ID</span><b>${esc(pMrn)}</b></div>` : ''}
${dobRow(d)}
<div class="f-hr"></div>
${items}
<div class="f-hr"></div>
${t.discount > 0 ? `<div class="f-kv"><span>Подытог</span><b>${money(t.subtotal)}</b></div><div class="f-kv"><span>Скидка</span><b>−${money(t.discount)}</b></div>` : ''}
<div class="f-tot"><span>К ОПЛАТЕ</span><b>${money(t.total)} сум</b></div>
${paid > 0 ? `<div class="f-kv"><span>Оплачено</span><b>${money(paid)}</b></div><div class="f-kv"><span>Остаток</span><b>${money(due)}</b></div>` : ''}
<div class="f-hr"></div>
<div class="f-thanks">Оплатите в кассе клиники · Kassada to'lang</div>
${queueBlock}
</body></html>`;
}

// ---------------------------------------------------------------------------
// FISCAL RECEIPT · thermal 80mm (monochrome, monospace, ОФД)
// ---------------------------------------------------------------------------
function fiscalClassic(s, d) {
    // FISCAL_RECEIPT_58MM_V2 — clean cashier receipt sized for the ~48mm printable width of a 58mm
    // thermal head so nothing runs off the paper. Black, bold, short. No ОФД/QR/barcode (mock).
    const t = invoiceTotals(d);
    const logo = (s.logoUrl || s.logoDataUrl) ? `<div class="f-logo"><img src="${esc(s.logoUrl || s.logoDataUrl)}" alt="" style="max-width:14mm;height:auto;filter:grayscale(1) contrast(1.5);"></div>` : '';
    const items = (d.items || []).map((it, i) => `<div class="f-item"><div class="f-item-n">${i + 1}. ${esc(it.name)}</div><div class="f-item-r"><span>${esc(it.qty || 1)} × ${money(it.price)}</span><b>${money(Number(it.qty || 1) * Number(it.price || 0))}</b></div>${performerLine(it)}</div>`).join('');
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Чек · ${esc(d.docNo || '')}</title><style>
${PRINT_FONT_FACE_CSS}
@page{ size:58mm auto; margin:0; }
*{ margin:0; padding:0; box-sizing:border-box; }
html,body{ background:#fff; }
body{ width:46mm; margin:0; padding-top:6mm; font-family:'Onest',"Helvetica Neue",Arial,sans-serif; color:#000; font-size:11px; line-height:1.28; overflow-wrap:anywhere; }
.f-logo{ display:flex; justify-content:center; margin-bottom:2px; }
.f-name{ text-align:center; font-size:14px; font-weight:800; line-height:1.12; }
.f-sub{ text-align:center; font-size:9px; font-weight:700; margin-top:1px; }
.f-hr{ border-top:1px dashed #000; margin:4px 0; }
.f-hr2{ border-top:2px solid #000; margin:4px 0; }
.f-title{ text-align:center; font-size:12px; font-weight:800; text-transform:uppercase; margin:2px 0; }
/* FISCAL_PATIENT_NAME_V1 — the patient is the first thing staff and the patient
   themselves look for when a cheque is handed over, so it sits above the
   «Кассовый чек» title at the largest size on the roll. anywhere-wrapping keeps
   an unusually long surname on the paper instead of clipping it. */
.f-pat{ text-align:center; font-size:15px; font-weight:800; line-height:1.15; text-transform:uppercase; margin:3px 0; overflow-wrap:anywhere; }
.f-kv{ display:flex; justify-content:space-between; gap:6px; font-size:11px; font-weight:700; margin:1px 0; }
.f-kv b{ font-weight:800; text-align:right; }
.f-item{ margin:3px 0; }
.f-item-n{ font-size:11px; font-weight:800; overflow-wrap:anywhere; }
.f-item-r{ display:flex; justify-content:space-between; gap:6px; font-size:10.5px; font-weight:700; }
.f-item-r b{ font-weight:800; white-space:nowrap; }
${PERFORMER_CSS}
.f-tot{ display:flex; justify-content:space-between; align-items:baseline; gap:6px; font-size:13.5px; font-weight:800; margin:3px 0; border-top:1.5px solid #000; border-bottom:1.5px solid #000; padding:3px 0; }
.f-tot b{ white-space:nowrap; }
.f-thanks{ text-align:center; font-size:10px; font-weight:700; margin-top:5px; }
${QUEUE_CSS}
@media print{ body{ width:46mm; margin:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; color:#000 !important; } }
</style></head><body>
${logo}<div class="f-name">${esc(s.clinicName || 'Клиника')}</div>
${s.address ? `<div class="f-sub">${esc(s.address)}</div>` : ''}${s.taxId ? `<div class="f-sub">ИНН: ${esc(s.taxId)}</div>` : ''}${s.phone ? `<div class="f-sub">${esc(s.phone)}</div>` : ''}
<div class="f-hr2"></div>
${d.patientName ? `<div class="f-pat">${esc(d.patientName)}</div><div class="f-hr2"></div>` : ''}
<div class="f-title">Кассовый чек</div>
<div class="f-kv"><span>Чек №</span><b>${esc(d.docNo || '—')}</b></div>
<div class="f-kv"><span>Дата</span><b>${esc(d.date || new Date().toLocaleString('ru-RU').slice(0, 16))}</b></div>
${d.cashier ? `<div class="f-kv"><span>Кассир</span><b>${esc(d.cashier)}</b></div>` : ''}
${d.mrn ? `<div class="f-kv"><span>Пациент ID</span><b>${esc(d.mrn)}</b></div>` : ''}
${dobRow(d)}
<div class="f-hr"></div>
${items}
<div class="f-hr"></div>
${t.discount > 0 ? `<div class="f-kv"><span>Подытог</span><b>${money(t.subtotal)}</b></div><div class="f-kv"><span>Скидка</span><b>−${money(t.discount)}</b></div>` : ''}
<div class="f-tot"><span>ИТОГО</span><b>${money(t.total)} сум</b></div>
<div class="f-kv"><span>${esc(d.payMethod || d.method || 'Оплачено')}</span><b>${money(t.total)}</b></div>
<div class="f-hr"></div>
<div class="f-thanks">Спасибо за обращение! · Tashrifingiz uchun rahmat!</div>
${queueBlockHtml(d)}
</body></html>`;
}

// ---------------------------------------------------------------------------
// CLINIC RECEIPT · A5 (compact paid-receipt)
// ---------------------------------------------------------------------------
function receiptClassic(s, d) {
    // CLINIC_CHEQUE_58MM_V1 — the clinic cheque (type 'check') was A5 (148x210mm), so it printed a
    // long, mostly-empty page on a 58mm thermal roll. Now a clean 58mm thermal receipt (same
    // geometry as the cashier fiscal cheque): left-aligned, 46mm, bold black, 6mm top feed.
    const t = invoiceTotals(d);
    const logo = (s.logoUrl || s.logoDataUrl) ? `<div class="f-logo"><img src="${esc(s.logoUrl || s.logoDataUrl)}" alt="" style="max-width:14mm;height:auto;filter:grayscale(1) contrast(1.5);"></div>` : '';
    const items = (d.items || []).map((it, i) => `<div class="f-item"><div class="f-item-n">${i + 1}. ${esc(it.name)}</div><div class="f-item-r"><span>${esc(it.qty || 1)} × ${money(it.price)}</span><b>${money(Number(it.qty || 1) * Number(it.price || 0))}</b></div>${performerLine(it)}</div>`).join('');
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Чек · ${esc(d.docNo || '')}</title><style>
${PRINT_FONT_FACE_CSS}
@page{ size:58mm auto; margin:0; }
*{ margin:0; padding:0; box-sizing:border-box; }
html,body{ background:#fff; }
body{ width:46mm; margin:0; padding-top:6mm; font-family:'Onest',"Helvetica Neue",Arial,sans-serif; color:#000; font-size:11px; line-height:1.28; overflow-wrap:anywhere; }
.f-logo{ display:flex; justify-content:center; margin-bottom:2px; }
.f-name{ text-align:center; font-size:14px; font-weight:800; line-height:1.12; }
.f-sub{ text-align:center; font-size:9px; font-weight:700; margin-top:1px; }
.f-hr{ border-top:1px dashed #000; margin:4px 0; }
.f-hr2{ border-top:2px solid #000; margin:4px 0; }
.f-title{ text-align:center; font-size:12px; font-weight:800; text-transform:uppercase; margin:2px 0; }
.f-kv{ display:flex; justify-content:space-between; gap:6px; font-size:11px; font-weight:700; margin:1px 0; }
.f-kv b{ font-weight:800; text-align:right; }
.f-item{ margin:3px 0; }
.f-item-n{ font-size:11px; font-weight:800; overflow-wrap:anywhere; }
.f-item-r{ display:flex; justify-content:space-between; gap:6px; font-size:10.5px; font-weight:700; }
.f-item-r b{ font-weight:800; white-space:nowrap; }
${PERFORMER_CSS}
.f-tot{ display:flex; justify-content:space-between; align-items:baseline; gap:6px; font-size:13.5px; font-weight:800; margin:3px 0; border-top:1.5px solid #000; border-bottom:1.5px solid #000; padding:3px 0; }
.f-tot b{ white-space:nowrap; }
.f-thanks{ text-align:center; font-size:10px; font-weight:700; margin-top:5px; }
@media print{ body{ width:46mm; margin:0; } *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; color:#000 !important; } }
</style></head><body>
${logo}<div class="f-name">${esc(s.clinicName || 'Клиника')}</div>
${s.address ? `<div class="f-sub">${esc(s.address)}</div>` : ''}${s.taxId ? `<div class="f-sub">ИНН: ${esc(s.taxId)}</div>` : ''}${s.phone ? `<div class="f-sub">${esc(s.phone)}</div>` : ''}
<div class="f-hr2"></div>
<div class="f-title">Чек об оплате</div>
<div class="f-kv"><span>Чек №</span><b>${esc(d.docNo || '—')}</b></div>
<div class="f-kv"><span>Дата</span><b>${esc(d.date || new Date().toLocaleString('ru-RU').slice(0, 16))}</b></div>
${d.cashier ? `<div class="f-kv"><span>Кассир</span><b>${esc(d.cashier)}</b></div>` : ''}
${d.patientName ? `<div class="f-item-n" style="margin:1px 0">Пациент: ${esc(d.patientName)}</div>` : ''}
${d.mrn ? `<div class="f-kv"><span>ID</span><b>${esc(d.mrn)}</b></div>` : ''}
${dobRow(d)}
<div class="f-hr"></div>
${items}
<div class="f-hr"></div>
${t.discount > 0 ? `<div class="f-kv"><span>Подытог</span><b>${money(t.subtotal)}</b></div><div class="f-kv"><span>Скидка</span><b>−${money(t.discount)}</b></div>` : ''}
<div class="f-tot"><span>ИТОГО</span><b>${money(t.total)} сум</b></div>
${d.payMethod ? `<div class="f-kv"><span>${esc(d.payMethod)}</span><b>${money(t.total)}</b></div>` : ''}
${d.received ? `<div class="f-kv"><span>Получено</span><b>${esc(d.received)}</b></div>` : ''}
<div class="f-hr"></div>
<div class="f-thanks">Спасибо за обращение! · Tashrifingiz uchun rahmat!</div>
</body></html>`;
}
