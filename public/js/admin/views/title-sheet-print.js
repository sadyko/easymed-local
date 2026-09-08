// TITLE_SHEET_V1 — титульный лист НА БУМАГЕ: сам по себе («Печать» на листе) и
// первой страницей собранной истории болезни (case-docs.js, caseFilePrintHtml).
//
// Отдельный модуль без окон и запросов: его импортируют и case-docs.js, и
// title-sheet.js, а те друг друга — нет. Шапка клиники — та же, что у листа на
// экране (a4-letterhead.js → window.CLINIC): бумага и экран показывают одну
// клинику.
import { tr, trf } from '../i18n.js';
import { fmtDateTime } from '../ui.js';
import { dateNumeric } from '../../shared/date-words.js';   // дата рождения — числом, как в документе
import { clinicLetterheadData } from './a4-letterhead.js';
import { FORM_003, MOBILITY } from '../../shared/form-003.js';   // FORM_003_V1

export function esc(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const GENDER = { male: 'Мужской', female: 'Женский', other: 'Другое' };
const PEDICULOSIS_WORD = { none: 'не выявлено', found: 'выявлено' };
const SANITATION_WORD = { full: 'полная', partial: 'частичная', none: 'не проводилась' };

export function genderWord(g) { return GENDER[g] ? tr(GENDER[g]) : ''; }
export function pediculosisWord(v) { return PEDICULOSIS_WORD[v] ? tr(PEDICULOSIS_WORD[v]) : ''; }
export function sanitationWord(v) { return SANITATION_WORD[v] ? tr(SANITATION_WORD[v]) : ''; }

const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v || '—')}</span></div>`;

// INPATIENT_DOCS_V1 — три бумаги при поступлении и их отметки на листе.
export const PAPERS_UI = Object.freeze([
    { flag: 'contract_signed', col: 'contract_signed_at', doc: 'Договор',  yes: 'подписан',  no: 'не подписан' },
    { flag: 'consent_signed',  col: 'consent_signed_at',  doc: 'Согласие', yes: 'подписано', no: 'не подписано' },
    { flag: 'memo_given',      col: 'memo_given_at',      doc: 'Памятка',  yes: 'выдана',    no: 'не выдана' },
]);
/** «Договор — подписан 08.09.2026 12:10 · Согласие — не подписано · Памятка — выдана …» */
export function papersSummary(papers, { withDates = true } = {}) {
    const p = papers || {};
    return PAPERS_UI.map(({ col, doc, yes, no }) => {
        const when = p[col];
        const state = when ? (withDates ? tr(yes) + ' ' + fmtDateTime(when) : tr(yes)) : tr(no);
        return trf('{doc} — {state}', { doc: tr(doc), state });
    }).join(' · ');
}
const num = (v) => (v === null || v === undefined || v === '' ? '' : String(v));

/**
 * FORM_003_V1 — бланк 003 «Беморнинг тиббий баённомаси» строка в строку:
 * шапка бланка, заголовок с номером, строки 1–10 с подчёркнутыми значениями
 * (пусто — линия под запись), ниже — осмотр медсестры, бумаги и подпись.
 * @param {{admission:object, patient:object, sheet:object|null, bmi:number|null, complete:boolean}} view
 * @param {{extra?: string}} opts — HTML, который сборка истории кладёт под лист (пробелы комплекта).
 */
export function titleSheetPrintSection(view, { extra = '' } = {}) {
    const a = (view && view.admission) || {};
    const p = (view && view.patient) || {};
    const s = (view && view.sheet) || null;
    const d = clinicLetterheadData();
    const F = FORM_003.lines;
    const placed = a.admitted_at && !['ordered', 'cancelled'].includes(a.status);
    const timeOf = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); };
    const v = (value, cls = '') => `<span class="f3p-v${cls ? ' ' + cls : ''}">${esc(value || '')}</span>`;
    const uz = (t) => `<span class="f3p-uz">${esc(t)}</span>`;
    const ru = (t) => `<span class="f3p-ru">${esc(tr(t))}</span>`;
    const line = (...parts) => `<div class="f3p-line">${parts.join(' ')}</div>`;
    const pick = (options, chosen) => options.map((o) => (o.code === chosen ? `<b class="f3p-pick">${esc(o.uz)}</b>` : esc(o.uz))).join(', ');
    const bp = s && s.bp_sys !== null && s.bp_sys !== undefined && s.bp_dia !== null && s.bp_dia !== undefined ? `${s.bp_sys}/${s.bp_dia}` : '';
    const emergency = a.admission_type === 'emergency';
    const sign = s && view.complete
        ? '<div class="f3p-sign">' + esc(F.filledBy) + ' ' + esc(tr('(заполнила)')) + ': <b>' + esc(s.filled_by_name || '') + '</b> · ' + esc(s.filled_at ? fmtDateTime(s.filled_at) : '') + '</div>'
        : `<div class="f3p-sign warn">${esc(tr('Титульный лист не заполнен'))}</div>`;

    // Строки бланка собираются здесь, а не внутри шаблона: сторож i18n
    // (shape 2b) не видит кириллицу в ${…}, если она не под tr() напрямую.
    const rows = [
        line(uz(F.admitted), ru('дата поступления'), v(placed ? dateNumeric(a.admitted_at) : ''), uz(F.time), v(placed ? timeOf(a.admitted_at) : '', 's')),
        line(uz(F.discharged), ru('дата выписки'), v(a.discharged_at ? dateNumeric(a.discharged_at) : ''), uz(F.time), v(a.discharged_at ? timeOf(a.discharged_at) : '', 's')),
        line(uz(F.dept), v(a.department), uz(F.deptSuffix), ru('палата · койка'), v([a.ward_name, a.bed_code].filter(Boolean).join(' · '))),
        line(v(a.discharge_outcome === 'transfer' ? a.discharge_destination : '', 'wide'), uz(F.transferred), ru('переведён в')),
        line(v(a.days ? String(a.days) : '', 's'), uz(F.days), ru('дней в стационаре')),
        line(uz(F.mobility) + ':', pick(MOBILITY, s ? s.mobility : ''), '<span class="f3p-note">(' + esc(tr('нужное подчёркнуто')) + ')</span>'),
        line(uz(F.blood), ru('группа крови и резус'), v(p.blood_type && p.blood_type !== 'unknown' ? p.blood_type : '')),
        line(uz(F.drugs), ru('аллергия на лекарства'), v(p.allergies, 'wide')),
        '<div class="f3p-hint">' + esc(F.drugsHint) + '</div>',
        line(uz(F.name), v(p.full_name, 'wide'), uz(F.sex), v(genderWord(p.gender))),
        line(uz(F.dob), v(p.date_of_birth ? dateNumeric(p.date_of_birth) : '')),
        line(uz(F.body), v(s ? num(s.height_cm) : '', 's'), uz(F.weight), v(s ? num(s.weight_kg) : '', 's'), uz(F.temp), v(s ? num(s.temp_c) : '', 's'), ru('ИМТ'), v(num(view && view.bmi), 's')),
        line(uz(F.address), v(p.address, 'wide')),
        line(ru('телефон'), v(p.phone), ru('паспорт / ID'), v(p.national_id), ru('близкий родственник'), v([p.emergency_contact_name, p.emergency_contact_phone].filter(Boolean).join(' · '))),
        '<div class="f3p-hint">' + esc(F.addressHint) + '</div>',
        line(uz(F.work), v(p.occupation, 'wide')),
        line(uz(F.referred), v(s ? s.referred_from : '', 'wide')),
        '<div class="f3p-hint">' + esc(F.referredHint) + '</div>',
        line(uz(F.emergency) + ':', emergency ? '<b class="f3p-pick">' + esc(F.yes) + '</b>, ' + esc(F.no) : esc(F.yes) + ', <b class="f3p-pick">' + esc(F.no) + '</b>',
            '<span class="f3p-note">(' + esc(emergency ? tr('Экстренная') : tr('Плановая')) + ')</span>'),
        line(uz(F.transport), v(s ? s.delivered_by : ''), uz(F.sinceOnset), v(s ? s.since_onset : '')),
        line(uz(F.refDx), v(a.admission_diagnosis, 'wide')),
        line(uz(F.admDx), v(a.clinical_diagnosis, 'wide')),
    ];
    const nurseBlock = [
        '<div class="f3p-block-t">' + esc(F.nurse) + ' <span class="f3p-ru">' + esc(tr('Осмотр медсестры при поступлении')) + '</span></div>',
        line(ru('АД'), v(bp, 's'), ru('пульс'), v(s ? num(s.pulse_bpm) : '', 's'), ru('Осмотр на педикулёз и чесотку'), v(s ? pediculosisWord(s.pediculosis) : ''), ru('Санитарная обработка'), v(s ? sanitationWord(s.sanitation) : '')),
        s && s.note ? line(ru('Примечание'), v(s.note, 'wide')) : '',
        '<div class="f3p-block-t">' + esc(F.papers) + ' <span class="f3p-ru">' + esc(tr('Документы при поступлении')) + '</span></div>',
        '<div class="f3p-line">' + esc(papersSummary(s || {})) + '</div>',
    ];
    const sub = esc(tr('Титульный лист истории болезни'));
    return `
<section class="ts f3p">
  <div class="f3p-head">
    <div class="f3p-l">
      <div>${esc(FORM_003.ministry)}</div>
      <div class="f3p-org">${esc(d.name)}${d.legal ? ' · ' + esc(d.legal) : ''}${d.addr ? '<br>' + esc(d.addr) : ''}${d.phone ? ' · ' + esc(d.phone) : ''}</div>
      <div class="f3p-orgl">${esc(FORM_003.orgLabel)}</div>
    </div>
    <div class="f3p-r">${esc(FORM_003.approval)}</div>
  </div>
  <h1 class="f3p-title">${esc(FORM_003.title)} № ${v(a.admission_no, 'no')}</h1>
  <div class="f3p-sub">${sub}</div>
  ${rows.join('\n  ')}
  <div class="f3p-block">
    ${nurseBlock.join('\n    ')}
  </div>
  ${sign}
  ${extra}
</section>`;
}

/* type-scale-exempt-start: печатный документ A4 — метрики бумаги, а не экрана (то же исключение, что у case-docs.js) */
export function titleSheetPrintCss() {
    return `
.ts { page-break-after: always; }
.f3p { font-size: 12px; line-height: 1.55; color: #16232b; }
.f3p-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; font-size: 10.5px; line-height: 1.35; margin-bottom: 10px; }
.f3p-l { flex: 1; text-align: center; font-weight: 700; }
.f3p-org { margin-top: 6px; font-weight: 700; border-bottom: 1px solid #16232b; padding-bottom: 2px; }
.f3p-orgl { font-weight: 400; font-size: 9.5px; color: #55636d; }
.f3p-r { flex: 1; text-align: right; font-weight: 700; }
.f3p-title { text-align: center; font-size: 15px; font-weight: 800; letter-spacing: 0.04em; margin: 12px 0 2px; }
.f3p-sub { text-align: center; font-size: 10.5px; color: #55636d; margin-bottom: 10px; }
.f3p-line { margin: 3px 0; }
.f3p-uz { font-weight: 600; }
.f3p-ru { font-size: 9.5px; color: #7a8892; }
.f3p-note { font-size: 9.5px; color: #7a8892; }
.f3p-v { display: inline-block; min-width: 120px; border-bottom: 1px solid #16232b; padding: 0 6px; font-weight: 600; vertical-align: baseline; }
.f3p-v.s { min-width: 56px; }
.f3p-v.wide { min-width: 60%; }
.f3p-v.no { min-width: 110px; }
.f3p-pick { text-decoration: underline; text-underline-offset: 2px; }
.f3p-hint { font-size: 9px; color: #7a8892; text-align: center; margin: -2px 0 4px; }
.f3p-block { margin-top: 10px; padding-top: 8px; border-top: 1px dashed #aab4bc; }
.f3p-block-t { font-weight: 700; font-size: 11.5px; margin: 6px 0 2px; }
.f3p-sign { margin-top: 14px; text-align: right; font-size: 11px; color: #55636d; }
.f3p-sign.warn { color: #b45309; font-weight: 600; }
`;
}

/** Лист отдельной страницей — кнопка «Печать» на самом листе. */
export function titleSheetPrintHtml(view, { fontFaceCss = '' } = {}) {
    const a = (view && view.admission) || {};
    return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(tr('Титульный лист'))} · ${esc(a.admission_no || '')}</title>
<style>
${fontFaceCss}
@page { size: A4; margin: 14mm; }
body { font-family: 'Onest', -apple-system, 'Segoe UI', Roboto, sans-serif; color: #16232b; margin: 0; }
${titleSheetPrintCss()}
.ts { page-break-after: auto; }
</style></head><body>
${titleSheetPrintSection(view)}
<script>window.onload=function(){(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){try{window.focus();window.print();}catch(e){}});};</scr` + `ipt>
</body></html>`;
}
/* type-scale-exempt-end */
