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
const num = (v) => (v === null || v === undefined || v === '' ? '' : String(v));

/**
 * Лист как <section>: шапка клиники, заголовок, три блока, подпись.
 * @param {{admission:object, patient:object, sheet:object|null, bmi:number|null, complete:boolean}} view
 * @param {{extra?: string}} opts — HTML, который сборка истории кладёт под лист (пробелы комплекта).
 */
export function titleSheetPrintSection(view, { extra = '' } = {}) {
    const a = (view && view.admission) || {};
    const p = (view && view.patient) || {};
    const s = (view && view.sheet) || null;
    const d = clinicLetterheadData();
    const placed = a.admitted_at && !['ordered', 'cancelled'].includes(a.status);
    const bp = s && s.bp_sys !== null && s.bp_sys !== undefined && s.bp_dia !== null && s.bp_dia !== undefined
        ? `${s.bp_sys}/${s.bp_dia}` : '';
    const sign = s && view.complete
        ? `<div class="sign">${esc(trf('Титульный лист заполнил(а): {who} · {when}', { who: s.filled_by_name || '', when: s.filled_at ? fmtDateTime(s.filled_at) : '' }))}</div>`
        : `<div class="sign warn">${esc(tr('Титульный лист не заполнен'))}</div>`;

    return `
<section class="ts">
  <div class="ts-band"></div>
  <div class="ts-head">
    <div class="ts-clinic">
      ${d.logo ? `<img class="ts-logo" src="${esc(d.logo)}" alt="">` : ''}
      <div><b>${esc(d.name)}</b>${d.legal ? `<small>${esc(d.legal)}</small>` : ''}${d.addr ? `<small>${esc(d.addr)}</small>` : ''}${d.phone ? `<small>${esc(d.phone)}</small>` : ''}</div>
    </div>
    <div class="ts-doc">
      <h1>${esc(a.admission_no ? trf('История болезни № {no}', { no: a.admission_no }) : tr('История болезни'))}</h1>
      <div class="ts-sub">${esc(tr('Титульный лист'))}</div>
    </div>
  </div>
  <h2>${esc(tr('Пациент'))}</h2>
  <div class="grid">
    ${kv(tr('ФИО'), p.full_name)}
    ${kv(tr('Дата рождения'), p.date_of_birth ? dateNumeric(p.date_of_birth) : '')}
    ${kv(tr('Пол'), genderWord(p.gender))}
    ${kv(tr('Телефон'), p.phone)}
    ${kv(tr('Адрес'), p.address)}
    ${kv(tr('Паспорт / ID'), p.national_id)}
    ${kv(tr('Место работы'), p.occupation)}
    ${kv(tr('Контактное лицо'), [p.emergency_contact_name, p.emergency_contact_phone].filter(Boolean).join(' · '))}
    ${kv(tr('Группа крови и резус'), p.blood_type && p.blood_type !== 'unknown' ? p.blood_type : '')}
    ${kv(tr('Аллергии'), p.allergies)}
  </div>
  <h2>${esc(tr('Поступление'))}</h2>
  <div class="grid">
    ${kv(tr('Дата и время'), placed ? fmtDateTime(a.admitted_at) : '')}
    ${kv(tr('Отделение'), a.department)}
    ${kv(tr('Палата · койка'), [a.ward_name, a.bed_code].filter(Boolean).join(' · '))}
    ${kv(tr('Вид госпитализации'), a.admission_type === 'emergency' ? tr('Экстренная') : tr('Плановая'))}
    ${kv(tr('Диагноз при направлении'), a.admission_diagnosis)}
    ${kv(tr('Жалобы'), a.chief_complaint)}
    ${kv(tr('Кем направлен'), s ? s.referred_from : '')}
    ${kv(tr('Лечащий врач'), a.attending_name)}
  </div>
  <h2>${esc(tr('Осмотр медсестры при поступлении'))}</h2>
  <div class="grid">
    ${kv(tr('Рост, см'), s ? num(s.height_cm) : '')}
    ${kv(tr('Вес, кг'), s ? num(s.weight_kg) : '')}
    ${kv(tr('ИМТ'), num(view && view.bmi))}
    ${kv(tr('Температура, °C'), s ? num(s.temp_c) : '')}
    ${kv(tr('АД, мм рт. ст.'), bp)}
    ${kv(tr('Пульс, уд/мин'), s ? num(s.pulse_bpm) : '')}
    ${kv(tr('Осмотр на педикулёз и чесотку'), s ? pediculosisWord(s.pediculosis) : '')}
    ${kv(tr('Санитарная обработка'), s ? sanitationWord(s.sanitation) : '')}
    ${kv(tr('Примечание'), s ? s.note : '')}
  </div>
  ${sign}
  ${extra}
</section>`;
}

/* type-scale-exempt-start */
export function titleSheetPrintCss() {
    return `
.ts { page-break-after: always; }
.ts-band { height: 6px; background: #1f7a72; border-radius: 3px; margin-bottom: 14px; }
.ts-head { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; border-bottom: 2px solid #16232b; padding-bottom: 12px; margin-bottom: 14px; }
.ts-clinic { display: flex; gap: 12px; align-items: flex-start; font-size: 12px; color: #55636d; }
.ts-clinic b { display: block; font-size: 15px; color: #16232b; margin-bottom: 2px; }
.ts-clinic small { display: block; font-size: 11.5px; }
.ts-logo { max-height: 48px; max-width: 140px; object-fit: contain; }
.ts-doc { text-align: right; }
.ts-doc h1 { font-size: 20px; margin: 0; }
.ts-sub { font-size: 13px; font-weight: 600; color: #55636d; margin-top: 2px; }
.ts h2 { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: #55636d; margin: 14px 0 6px; }
.ts .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; }
.ts .kv { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px dotted #d3d9de; font-size: 13px; }
.ts .kv .k { color: #55636d; min-width: 150px; }
.ts .kv .v { font-weight: 600; }
.ts .sign { margin-top: 14px; font-size: 12px; color: #55636d; text-align: right; }
.ts .sign.warn { color: #b45309; font-weight: 600; }
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
