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
    // TITLE_SHEET_CLEAN_V1 (2026-09-08) — владелец: «we should remove from the
    // bottom of the document this informations». Кто заполнил лист и в какую
    // минуту — служебный след системы, а не содержание бланка 003: на бумаге,
    // которую подшивают в историю и выдают на руки, этой строки нет. На экране
    // она осталась, под листом.
    //
    // Предупреждение о НЕзаполненном листе — другое дело: оно про сам документ,
    // и оно остаётся. Печатать пустой бланк, ничего об этом не сказав, значит
    // выдать бумагу, по которой нельзя понять, забыли её заполнить или так и
    // задумано.
    const sign = s && view.complete
        ? ''
        : `<div class="f3p-sign warn">${esc(tr('Титульный лист не заполнен'))}</div>`;

    // FORM_003_FORM_GRID_V1 (2026-09-08) — БЛАНК ЭТО ФОРМА, А НЕ АБЗАЦ.
    //
    // Владелец, увидев печать: «holy its looks terribly wrong, can you rewrite
    // that completely? i mean something is off i dont understand what».
    //
    // Что было не так — по пунктам, потому что «off» здесь складывалось из
    // четырёх разных вещей, и каждая по отдельности выглядела мелочью:
    //   • строка бланка была ПОТОКОМ ТЕКСТА: подпись, линия, снова подпись,
    //     снова линия. Ширину линии задавало содержимое, поэтому ни одна линия
    //     не начиналась и не заканчивалась там же, где соседняя, и лист читался
    //     как черновик, а не как бланк;
    //   • из-за этого длинное значение выталкивало следующую подпись на новую
    //     строку — на снимке «2. Жинси» осталось без своего значения, а «Erkak»
    //     повисло отдельной строкой снизу;
    //   • у пустых строк 9 и 10 линия шла до края и висела ни к чему не
    //     привязанная;
    //   • «ўтказилган» печаталось как «линия, потом слово» — задом наперёд для
    //     того, кто читает бланк сверху вниз.
    //
    // Стало: КАЖДАЯ строка бланка — сетка из четырёх колонок, одна и та же на
    // весь лист. Значение занимает всё, что осталось от своей ячейки, поэтому
    // линии всегда кончаются на одной вертикали, а подписи всегда начинаются на
    // одной. Пара «подпись + значение» не разрывается: она внутри ячейки.
    const cell = (inner, span) => '<div class="f3p-c' + (span ? ' f3p-c' + span : '') + '">' + inner + '</div>';
    const lab = (uzText, ruKey) => '<span class="f3p-lab">' + esc(uzText)
        + (ruKey ? ' <i>' + esc(tr(ruKey)) + '</i>' : '') + '</span>';
    const rul = (value, cls) => '<span class="f3p-v' + (cls ? ' ' + cls : '') + '">' + esc(value || '') + '</span>';
    const tail = (uzText, ruKey) => '<span class="f3p-tail">' + esc(uzText)
        + (ruKey ? ' <i>' + esc(tr(ruKey)) + '</i>' : '') + '</span>';
    const fld = (uzText, ruKey, value, span, cls) => cell(lab(uzText, ruKey) + rul(value, cls), span);
    const gap = (span) => '<div class="f3p-c' + (span ? ' f3p-c' + span : '') + '"></div>';
    const row = (...cs) => '<div class="f3p-row">' + cs.filter(Boolean).join('') + '</div>';
    const noteRow = (text) => '<div class="f3p-row"><div class="f3p-c4 f3p-hint">' + esc(text) + '</div></div>';
    const opts = (html) => '<span class="f3p-opts">' + html + '</span>';

    const grid = [
        row(fld(F.admitted, 'дата поступления', placed ? dateNumeric(a.admitted_at) : '', 2),
            fld(F.time, 'время', placed ? timeOf(a.admitted_at) : '', 2)),
        row(fld(F.discharged, 'дата выписки', a.discharged_at ? dateNumeric(a.discharged_at) : '', 2),
            fld(F.time, 'время', a.discharged_at ? timeOf(a.discharged_at) : '', 2)),
        row(fld(F.dept, 'отделение', a.department, 2),
            fld(F.deptSuffix, 'палата · койка', [a.ward_name, a.bed_code].filter(Boolean).join(' · '), 2)),
        // Слово стоит ПОСЛЕ линии — так оно и напечатано на бланке.
        row(cell(rul(a.discharge_outcome === 'transfer' ? a.discharge_destination : '')
            + tail(F.transferred, 'переведён в'), 4)),
        row(cell(rul(a.days ? String(a.days) : '') + tail(F.days, 'дней в стационаре'), 2),
            fld(F.blood, 'группа крови и резус', p.blood_type && p.blood_type !== 'unknown' ? p.blood_type : '', 2)),
        row(cell(lab(F.mobility, 'как доставляют по отделению') + opts(pick(MOBILITY, s ? s.mobility : '')), 4)),
        row(fld(F.drugs, 'аллергия на лекарства', p.allergies, 4)),
        noteRow(F.drugsHint),
        row(fld(F.name, 'ФИО', p.full_name, 3), fld(F.sex, 'пол', genderWord(p.gender), 1)),
        row(fld(F.dob, 'дата рождения', p.date_of_birth ? dateNumeric(p.date_of_birth) : '', 2), gap(2)),
        row(fld(F.body, 'рост, см', s ? num(s.height_cm) : '', 1),
            fld(F.weight, 'вес, кг', s ? num(s.weight_kg) : '', 1),
            fld(F.temp, 'температура, °C', s ? num(s.temp_c) : '', 1),
            cell(lab(tr('ИМТ')) + rul(num(view && view.bmi)), 1)),
        row(fld(F.address, 'постоянный адрес', p.address, 4)),
        // Телефон в четверть ширины не помещался и переносился цифрами на
        // вторую строку; родственник с телефоном — тем более.
        row(cell(lab(tr('телефон')) + rul(p.phone), 2),
            cell(lab(tr('паспорт / ID')) + rul(p.national_id), 2)),
        row(cell(lab(tr('близкий родственник'))
            + rul([p.emergency_contact_name, p.emergency_contact_phone].filter(Boolean).join(' · ')), 4)),
        noteRow(F.addressHint),
        row(fld(F.work, 'место работы, профессия, должность', p.occupation, 4)),
        row(fld(F.referred, 'кем направлен', s ? s.referred_from : '', 4)),
        noteRow(F.referredHint),
        // «ҳа, йўқ» рядом с длинной подписью ломалось пополам: подпись длинная,
        // а ячейка половинная. Строка теперь своя.
        row(cell(lab(F.emergency, emergency ? 'Экстренная' : 'Плановая')
            + opts(emergency
                ? '<b class="f3p-pick">' + esc(F.yes) + '</b>, ' + esc(F.no)
                : esc(F.yes) + ', <b class="f3p-pick">' + esc(F.no) + '</b>'), 4)),
        row(fld(F.transport, 'каким транспортом', s ? s.delivered_by : '', 2),
            fld(F.sinceOnset, 'сколько прошло от начала болезни', s ? s.since_onset : '', 2)),
        row(fld(F.refDx, 'диагноз при направлении', a.admission_diagnosis, 4)),
        row(fld(F.admDx, 'диагноз приёмного покоя', a.clinical_diagnosis, 4)),
    ];

    const blockT = (uzText, ruKey) => '<div class="f3p-block-t">' + esc(uzText)
        + ' <i>' + esc(tr(ruKey)) + '</i></div>';
    const nurseBlock = [
        blockT(F.nurse, 'Осмотр медсестры при поступлении'),
        row(cell(lab(tr('АД')) + rul(bp), 1),
            cell(lab(tr('пульс')) + rul(s ? num(s.pulse_bpm) : ''), 1),
            cell(lab(tr('Педикулёз')) + rul(s ? pediculosisWord(s.pediculosis) : ''), 1),
            cell(lab(tr('Санобработка')) + rul(s ? sanitationWord(s.sanitation) : ''), 1)),
        s && s.note ? row(fld(tr('Примечание'), null, s.note, 4)) : '',
        blockT(F.papers, 'Документы при поступлении'),
        '<div class="f3p-papers">' + esc(papersSummary(s || {})) + '</div>',
    ];
    const sub = esc(tr('Титульный лист истории болезни'));
    return `
<section class="ts f3p">
  <div class="f3p-head">
    <div class="f3p-hl">
      <div>${esc(FORM_003.ministry)}</div>
      <div class="f3p-org">${esc(d.name)}${d.legal ? ' · ' + esc(d.legal) : ''}${d.addr ? '<br>' + esc(d.addr) : ''}${d.phone ? ' · ' + esc(d.phone) : ''}</div>
      <div class="f3p-orgl">${esc(FORM_003.orgLabel)}</div>
    </div>
    <div class="f3p-hr">${esc(FORM_003.approval)}</div>
  </div>
  <h1 class="f3p-title">${esc(FORM_003.title)} № <span class="f3p-no">${esc(a.admission_no || '')}</span></h1>
  <div class="f3p-sub">${sub}</div>
  <div class="f3p-grid">
    ${grid.join('\n    ')}
  </div>
  <div class="f3p-block">
    ${nurseBlock.filter(Boolean).join('\n    ')}
  </div>
  ${sign}
  ${extra}
</section>`;
}

/* type-scale-exempt-start: печатный документ A4 — метрики бумаги, а не экрана (то же исключение, что у case-docs.js) */
// FORM_003_A4_V1 — лист занимает ЦЕЛУЮ страницу A4 (владелец: «make title list
// full a4»): min-height = 297mm − поля 2×14mm, колонка flex.
//
// FORM_003_ONE_PAGE_V1 — и НЕ БОЛЬШЕ одной страницы (владелец прислал печать,
// где бланк занял две).
//
// FORM_003_FORM_GRID_V1 — четыре колонки на всю ширину листа, одни и те же для
// каждой строки: подписи выстраиваются по одной вертикали, линии кончаются по
// другой. Ширину линии задаёт ЯЧЕЙКА, а не длина значения, — из-за обратного
// лист и выглядел «terribly wrong».
//
// FORM_003_FILL_PAGE_V1 (2026-09-08) — владелец: «its still not in the full a4».
// Причин было ДВЕ, и обе выглядели как одна:
//   1. .ts несла page-break-after: always. Разрыв срабатывал ВСЕГДА, в том
//      числе когда за листом ничего нет, — и печать честно выдавала вторую,
//      пустую страницу («1/2» в предпросмотре). Разрыв переехал туда, где ему
//      место: ПЕРЕД документами, которые за листом следуют.
//   2. Строки жались к верху, а низ листа пустовал: min-height растягивала
//      КОРОБКУ, но не содержимое. Теперь свободную высоту забирает сетка и
//      делит между строками (justify-content: space-between) — ровно так
//      разлинован бумажный бланк.
export function titleSheetPrintCss() {
    return `
.ts { box-sizing: border-box; min-height: 266mm; display: flex; flex-direction: column; }
.f3p { font-size: 12px; line-height: 1.3; color: #16232b; }
.f3p-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; font-size: 10px; line-height: 1.25; }
.f3p-hl { flex: 0 0 46%; text-align: center; font-weight: 700; }
.f3p-org { margin-top: 4px; font-weight: 700; border-bottom: 1px solid #16232b; padding-bottom: 2px; }
.f3p-orgl { font-weight: 400; font-size: 9px; color: #55636d; }
.f3p-hr { flex: 1 1 46%; text-align: right; font-weight: 700; }
.f3p-title { text-align: center; font-size: 14.5px; font-weight: 800; letter-spacing: 0.03em; margin: 11px 0 1px; }
.f3p-no { display: inline-block; min-width: 110px; border-bottom: 1px solid #16232b; padding: 0 6px; }
.f3p-sub { text-align: center; font-size: 10px; color: #55636d; margin-bottom: 9px; }
.f3p-grid { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: space-between; gap: 4px; }
.f3p-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); column-gap: 12px; align-items: end; page-break-inside: avoid; }
.f3p-c { grid-column: span 1; display: flex; align-items: baseline; gap: 5px; min-width: 0; }
.f3p-c2 { grid-column: span 2; }
.f3p-c3 { grid-column: span 3; }
.f3p-c4 { grid-column: span 4; }
.f3p-lab, .f3p-tail { flex: 0 0 auto; font-weight: 600; }
.f3p-lab i, .f3p-tail i { font-style: normal; font-weight: 400; font-size: 9px; color: #7a8892; }
.f3p-v { flex: 1 1 auto; min-width: 0; min-height: 15px; border-bottom: 1px solid #16232b; padding: 0 5px 1px; font-weight: 600; overflow-wrap: anywhere; }
.f3p-opts { flex: 1 1 auto; min-width: 0; padding-bottom: 1px; }
.f3p-pick { text-decoration: underline; text-underline-offset: 2px; }
.f3p-hint { font-size: 9px; color: #7a8892; text-align: center; }
.f3p-block { margin-top: 9px; padding-top: 7px; border-top: 1px dashed #aab4bc; display: flex; flex-direction: column; gap: 3px; }
.f3p-block-t { font-weight: 700; font-size: 11px; margin: 3px 0 1px; }
.f3p-block-t i { font-style: normal; font-weight: 400; font-size: 9px; color: #7a8892; }
.f3p-papers { font-size: 11px; }
.f3p-sign { margin-top: auto; padding-top: 10px; text-align: right; font-size: 11px; color: #55636d; }
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
</style></head><body>
${titleSheetPrintSection(view)}
<script>window.onload=function(){(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){try{window.focus();window.print();}catch(e){}});};</scr` + `ipt>
</body></html>`;
}
/* type-scale-exempt-end */
