// ═══════════════════════════════════════════════════════════════════════════
// TITLE_SHEET_V1 — ТИТУЛЬНЫЙ ЛИСТ НА ЭКРАНЕ
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «when request of hospitalization is accepted and patient is
// admitting to the bed, nurse should collect the title list, with personal
// information and anthropometric data of the patient, and it goes as a title
// list when history is collected». Решения владельца: лист — В ТОМ ЖЕ шаге,
// что и койка (пустые измерения допустимы и дописываются позже); измерения —
// рост, вес, ИМТ, температура, АД, пульс + осмотр на педикулёз и санобработка.
//
// Одна форма (titleSheetForm) — два места: окно размещения (после выбора
// койки; «Положить» шлёт admission_admit с листом — одним вызовом) и редактор
// в истории болезни (buildTitleSheetEditor — той же формы, что
// buildReviewEditor, чтобы case-workspace рисовал его тем же листом A4).
//
// Числа проверяет СЕРВЕР (rpc/title-sheet.js) и отвечает словами, называющими
// поле; экран лишь считает ИМТ по мере ввода (shared/title-sheet-rules.js).
import { supabase } from '../../supabase.js';
import { h, Icon, toast, field, fmtDateTime } from '../ui.js';
import { dateNumeric } from '../../shared/date-words.js';
import { tr, trf } from '../i18n.js';
import { inpatientModal, patientAnchor } from './inpatient-modal.js';
import { bmiOf, sheetCompleteness } from '../../shared/title-sheet-rules.js';
import { FORM_003, MOBILITY } from '../../shared/form-003.js';   // FORM_003_V1 — официальный текст бланка
import { clinicLetterheadData } from './a4-letterhead.js';
// Русские подсказки к строке 6 бланка — словарные ключи (i18n).
const MOBILITY_RU = { wheelchair: 'на коляске', stretcher: 'на носилках', walks: 'ходит сам' };
import { titleSheetPrintHtml, papersSummary } from './title-sheet-print.js';
import { printableSheet } from './doc-settings.js?v=noqr1';   // INPATIENT_DOCS_V1 — та же печать, что у всех бланков (ONE shared instance: ?v= как у остальных)

export const TITLE_SHEET_KIND = 'title';

// INPATIENT_DOCS_V1 — три бумаги при поступлении (владелец: «hospitalization
// agreement, informed consent, stationary pamyatka»). Печатаются тем же
// путём, что и все бланки (дизайнер «Документы» → printableSheet), текст —
// из настроек дизайнера. Галочка — отметка медсестры, что пациент подписал
// (памятку — получил); хранится на титульном листе, размещение не блокирует.
export const ADMISSION_PAPERS = Object.freeze([
    { type: 'inpatient_contract', flag: 'contract_signed', col: 'contract_signed_at', label: 'Договор на госпитализацию', tick: 'подписан' },
    { type: 'inpatient_consent',  flag: 'consent_signed',  col: 'consent_signed_at',  label: 'Информированное согласие', tick: 'подписано' },
    { type: 'inpatient_memo',     flag: 'memo_given',      col: 'memo_given_at',      label: 'Памятка стационара',       tick: 'выдана' },
]);
export function printInpatientDoc(type, data) {
    printableSheet({ type, data });
}

const val = (el) => String(el.value === null || el.value === undefined ? '' : el.value).trim();

/**
 * Форма листа. Возвращает поля для листа A4, fill(view) и read() → {sheet, patient}.
 * @param {{bed?: {id:number, code:string, ward_name?:string}|null}} opts — койка, выбранная в окне размещения.
 */
export function titleSheetForm({ bed = null, onPrint = printInpatientDoc } = {}) {
    // FORM_003_V1 — лист СТРОКА В СТРОКУ по бланку 003 «Беморнинг тиббий
    // баённомаси» (владелец: «adapt the title list … as a4 list, do not make
    // generic easymed style»). Официальный узбекский текст строк — из
    // shared/form-003.js, русская подсказка мелко рядом; заполняем то, что
    // знаем, остальное — линия под запись. Ниже строки 10 — то, что нужно
    // посту и чего на бланке нет: АД, пульс, педикулёз, санобработка, бумаги.
    const inp = (attrs = {}) => h('input', Object.assign({ type: 'text' }, attrs));
    const fullName = inp({ readonly: '' });
    const dob      = inp({ readonly: '' });
    const gender   = h('select', null,
        ...[['male', 'Мужской'], ['female', 'Женский'], ['other', 'Другое']].map(([v, l]) => h('option', { value: v }, tr(l))));
    const phone      = inp({ inputmode: 'tel' });
    const address    = inp();
    const nationalId = inp();
    const occupation = inp();
    const ecName     = inp();
    const ecPhone    = inp({ inputmode: 'tel' });
    const blood      = inp({ placeholder: 'напр. O(I) Rh+' });
    const allergies  = inp();
    const referred   = inp();
    const delivered  = inp();
    const sinceOnset = inp();
    const height = inp({ inputmode: 'decimal', placeholder: 'см' });
    const weight = inp({ inputmode: 'decimal', placeholder: 'кг' });
    const bmi    = inp({ readonly: '', class: 'ts-bmi' });
    const temp   = inp({ inputmode: 'decimal', placeholder: '°C' });
    const bpSys  = inp({ inputmode: 'numeric', placeholder: 'верхнее' });
    const bpDia  = inp({ inputmode: 'numeric', placeholder: 'нижнее' });
    const pulse  = inp({ inputmode: 'numeric', placeholder: 'уд/мин' });
    const note   = h('textarea', { rows: '2' });

    // Ответы медсестры — радиокнопки; выбранное держим в замыкании, а не
    // спрашиваем DOM: проверка «checked» по группе радио на разных браузерах
    // и в тестовой обвязке ведёт себя по-разному, а замыкание — одинаково.
    const picked = { pediculosis: '', sanitation: '', mobility: '' };
    const papers = { contract_signed: false, consent_signed: false, memo_given: false };
    const paperChecks = {};
    let current = { patient: {}, admission: {} };   // что сейчас на листе — для печати бумаг
    const uid = Math.random().toString(36).slice(2, 8);
    const radioEls = [];
    const radios = (key, options, cls = 'ts-radios') => h('div', { class: cls }, ...options.map(([v, label, hint]) => {
        const r = h('input', { type: 'radio', name: 'ts-' + key + '-' + uid, value: v, onchange: () => { picked[key] = v; } });
        r._tsKey = key; r._tsValue = v;
        radioEls.push(r);
        return h('label', null, r, ' ', typeof label === 'string' && hint !== undefined ? h('span', { class: 'f3-uz' }, label) : tr(label),
            hint !== undefined ? h('small', { class: 'f3-ru' }, tr(hint)) : null);
    }));
    const pedRadios = radios('pediculosis', [['none', 'не выявлено'], ['found', 'выявлено']]);
    const sanRadios = radios('sanitation', [['full', 'полная'], ['partial', 'частичная'], ['none', 'не проводилась']]);
    // Строка 6 бланка: официальные слова + русская подсказка.
    const mobilityRadios = radios('mobility', MOBILITY.map((m) => [m.code, m.uz, MOBILITY_RU[m.code]]), 'ts-radios f3-radios');

    const recalc = () => { const b = bmiOf(val(height), val(weight)); bmi.value = b === null ? '' : String(b); };
    height.addEventListener('input', recalc);
    weight.addEventListener('input', recalc);

    const F = FORM_003.lines;
    const info = {};
    const infoEl = (key, cls = '') => { info[key] = h('span', { class: 'f3-val' + (cls ? ' ' + cls : '') }, '—'); return info[key]; };
    const uz = (text) => h('span', { class: 'f3-uz' }, text);
    const ru = (text) => h('small', { class: 'f3-ru' }, tr(text));
    const row = (...kids) => h('div', { class: 'f3-row' }, ...kids.filter(Boolean));
    const ctl = (el, cls = '') => h('span', { class: 'f3-ctl' + (cls ? ' ' + cls : '') }, el);
    const hint = (text) => h('div', { class: 'f3-hint' }, text);
    const blockT = (uzText, ruText) => h('div', { class: 'f3-block-t' }, uz(uzText), ru(ruText));

    // FORM_003_V1 — данные для бумаги: пациент, отделение, палата · койка,
    // лечащий врач (при размещении обычно ещё не назначен — на бумаге линия).
    const docData = () => ({
        patientName: current.patient.full_name || '',
        department: current.admission.department || '',
        ward: (bed && bed.ward_name) || current.admission.ward_name || '',
        bed: (bed && bed.code) || current.admission.bed_code || '',
        doctorName: current.admission.attending_name || '',
        date: dateNumeric(new Date()),
    });
    const paperRow = ({ type, flag, label, tick }) => {
        const cb = h('input', { type: 'checkbox', onchange: (e) => { papers[flag] = !!((e.currentTarget || e.target) || {}).checked; } });
        paperChecks[flag] = cb;
        return h('div', { class: 'ts-paper' },
            h('span', { class: 'ts-paper-name' }, tr(label)),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => onPrint(type, docData()) }, Icon('Print', { size: 13 }), ' ', tr('Печать')),
            h('label', { class: 'ts-paper-tick' }, cb, ' ', tr(tick)));
    };

    const clinic = clinicLetterheadData();
    const fields = [
        h('div', { class: 'f3-head' },
            h('div', { class: 'f3-head-l' },
                h('div', { class: 'f3-ministry' }, FORM_003.ministry),
                h('div', { class: 'f3-org' }, clinic.name),
                h('div', { class: 'f3-org-l' }, FORM_003.orgLabel)),
            h('div', { class: 'f3-head-r' }, FORM_003.approval)),
        h('div', { class: 'f3-title' }, FORM_003.title, ' № ', infoEl('no', 'f3-no')),
        h('div', { class: 'f3-sub' }, tr('Титульный лист истории болезни')),
        row(uz(F.admitted), ru('дата поступления'), ctl(infoEl('admitted')), uz(F.time), ru('время'), ctl(infoEl('admitted_time'), 'f3-short')),
        row(uz(F.discharged), ru('дата выписки'), ctl(infoEl('discharged')), uz(F.time), ru('время'), ctl(infoEl('discharged_time'), 'f3-short')),
        row(uz(F.dept), ru('отделение'), ctl(infoEl('department')), uz(F.deptSuffix), ru('палата · койка'), ctl(infoEl('place'))),
        row(ctl(infoEl('transferred'), 'f3-wide'), uz(F.transferred), ru('переведён в')),
        row(ctl(infoEl('days'), 'f3-short'), uz(F.days), ru('дней в стационаре')),
        row(uz(F.mobility), ru('как доставляют по отделению'), mobilityRadios),
        row(uz(F.blood), ru('группа крови и резус'), ctl(blood)),
        row(uz(F.drugs), ru('аллергия на лекарства'), ctl(allergies, 'f3-wide')),
        hint(F.drugsHint),
        row(uz(F.name), ru('ФИО'), ctl(fullName, 'f3-wide'), uz(F.sex), ru('пол'), ctl(gender)),
        row(uz(F.dob), ru('дата рождения'), ctl(dob, 'f3-short')),
        row(uz(F.body), ru('рост, см'), ctl(height, 'f3-short'), uz(F.weight), ru('вес, кг'), ctl(weight, 'f3-short'),
            uz(F.temp), ru('температура, °C'), ctl(temp, 'f3-short'), ru('ИМТ'), ctl(bmi, 'f3-short')),
        row(uz(F.address), ru('постоянный адрес'), ctl(address, 'f3-wide')),
        row(ru('телефон'), ctl(phone), ru('паспорт / ID'), ctl(nationalId), ru('близкий родственник'), ctl(ecName), ru('его телефон'), ctl(ecPhone)),
        hint(F.addressHint),
        row(uz(F.work), ru('место работы, профессия, должность'), ctl(occupation, 'f3-wide')),
        row(uz(F.referred), ru('кем направлен'), ctl(referred, 'f3-wide')),
        hint(F.referredHint),
        row(uz(F.emergency), ru('доставлен экстренно'), ctl(infoEl('emergency'))),
        row(uz(F.transport), ru('каким транспортом'), ctl(delivered), uz(F.sinceOnset), ru('сколько прошло от начала болезни'), ctl(sinceOnset)),
        row(uz(F.refDx), ru('диагноз при направлении'), ctl(infoEl('refdx'), 'f3-wide')),
        row(uz(F.admDx), ru('диагноз приёмного покоя'), ctl(infoEl('admdx'), 'f3-wide')),
        blockT(F.nurse, 'Осмотр медсестры при поступлении'),
        row(ru('АД, мм рт. ст.'), h('span', { class: 'f3-ctl ts-bp' }, bpSys, h('span', null, '/'), bpDia), ru('пульс, уд/мин'), ctl(pulse, 'f3-short')),
        row(ru('Осмотр на педикулёз и чесотку'), pedRadios),
        row(ru('Санитарная обработка'), sanRadios),
        row(ru('Примечание'), ctl(note, 'f3-wide')),
        blockT(F.papers, 'Документы при поступлении'),
        h('div', { class: 'ts-papers' }, ...ADMISSION_PAPERS.map(paperRow)),
    ];

    const timeOf = (iso) => {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };
    const setInfo = (key, value) => { info[key].textContent = value || '—'; info[key].className = 'f3-val' + (value ? '' : ' f3-empty') + (info[key]._cls || ''); };

    function fill(view) {
        const p = (view && view.patient) || {};
        const a = (view && view.admission) || {};
        const s = (view && view.sheet) || {};
        current = { patient: p, admission: a };
        fullName.value = p.full_name || '';
        dob.value = p.date_of_birth ? dateNumeric(p.date_of_birth) : '';
        gender.value = ['male', 'female', 'other'].includes(p.gender) ? p.gender : 'other';
        phone.value = p.phone || '';
        address.value = p.address || '';
        nationalId.value = p.national_id || '';
        occupation.value = p.occupation || '';
        ecName.value = p.emergency_contact_name || '';
        ecPhone.value = p.emergency_contact_phone || '';
        blood.value = p.blood_type && p.blood_type !== 'unknown' ? p.blood_type : '';
        allergies.value = p.allergies || '';
        referred.value = s.referred_from || '';
        delivered.value = s.delivered_by || '';
        sinceOnset.value = s.since_onset || '';
        for (const [el, key] of [[height, 'height_cm'], [weight, 'weight_kg'], [temp, 'temp_c'], [bpSys, 'bp_sys'], [bpDia, 'bp_dia'], [pulse, 'pulse_bpm']]) {
            el.value = s[key] === null || s[key] === undefined ? '' : String(s[key]);
        }
        recalc();
        picked.pediculosis = s.pediculosis || '';
        picked.sanitation = s.sanitation || '';
        picked.mobility = s.mobility || '';
        for (const r of radioEls) r.checked = picked[r._tsKey] === r._tsValue;
        note.value = s.note || '';
        for (const { flag, col } of ADMISSION_PAPERS) { papers[flag] = !!s[col]; paperChecks[flag].checked = papers[flag]; }

        const placed = a.admitted_at && !['ordered', 'cancelled'].includes(a.status);
        setInfo('no', a.admission_no || '');
        setInfo('admitted', placed ? dateNumeric(a.admitted_at) : tr('при размещении'));
        setInfo('admitted_time', placed ? timeOf(a.admitted_at) : '');
        setInfo('discharged', a.discharged_at ? dateNumeric(a.discharged_at) : '');
        setInfo('discharged_time', a.discharged_at ? timeOf(a.discharged_at) : '');
        setInfo('department', a.department || '');
        setInfo('place', [(bed && bed.ward_name) || a.ward_name, (bed && bed.code) || a.bed_code].filter(Boolean).join(' · '));
        setInfo('transferred', a.discharge_outcome === 'transfer' ? (a.discharge_destination || '') : '');
        setInfo('days', a.days ? String(a.days) : '');
        setInfo('emergency', a.admission_type === 'emergency' ? F.yes + ' (' + tr('Экстренная') + ')' : F.no + ' (' + tr('Плановая') + ')');
        setInfo('refdx', a.admission_diagnosis || '');
        setInfo('admdx', a.clinical_diagnosis || '');
    }

    function read() {
        return {
            sheet: {
                referred_from: val(referred),
                height_cm: val(height), weight_kg: val(weight), temp_c: val(temp),
                bp_sys: val(bpSys), bp_dia: val(bpDia), pulse_bpm: val(pulse),
                pediculosis: picked.pediculosis, sanitation: picked.sanitation,
                mobility: picked.mobility, delivered_by: val(delivered), since_onset: val(sinceOnset),   // FORM_003_V1
                note: val(note),
                contract_signed: papers.contract_signed, consent_signed: papers.consent_signed, memo_given: papers.memo_given,
            },
            patient: {
                gender: val(gender) || 'other',
                phone: val(phone), address: val(address), national_id: val(nationalId), occupation: val(occupation),
                emergency_contact_name: val(ecName), emergency_contact_phone: val(ecPhone),
                blood_type: val(blood), allergies: val(allergies),
            },
        };
    }

    return { fields, fill, read, inputs: { height, weight, bmi, temp, bpSys, bpDia, pulse, phone, referred, delivered, sinceOnset } };
}

function sheetOnPaper(form) {
    // FORM_003_V1 — у бланка 003 СВОЯ шапка (министерство, учреждение, приказ),
    // общая шапка клиники здесь не рисуется.
    return h('div', { class: 'a4-scroll ts-modal' },
        h('div', { class: 'a4-paper f3-paper' },
            h('div', { class: 'a4-band-top' }),
            h('div', { class: 'ts-body f3' }, ...form.fields),
            h('div', { class: 'a4-band-bottom' })));
}

/**
 * Шаг 2 размещения: койка выбрана — заполнить лист и положить. «Положить» —
 * ОДИН вызов admission_admit с листом: плохое значение не кладёт пациента.
 */
export function openAdmissionTitleSheetModal({ admission, bed, onDone, onBack } = {}) {
    if (!admission || !admission.id) { toast(tr('Заявка не найдена.'), 'fail'); return null; }
    if (!bed || !bed.id) { toast(tr('Выберите койку.'), 'fail'); return null; }
    const p = admission.patients || {};
    const form = titleSheetForm({ bed });
    form.fill({ patient: p, admission, sheet: null });
    (async () => {
        const { data } = await supabase.rpc('admission_title_sheet_get', { admission_id: admission.id });
        if (data) form.fill(Object.assign({}, data, { admission: Object.assign({}, data.admission, { status: admission.status }) }));
    })();

    let m = null;
    m = inpatientModal(tr('Титульный лист'), 'Doc', [
        patientAnchor(p.full_name || '', [p.mrn, admission.department, bed.code ? trf('койка {code}', { code: bed.code }) : null].filter(Boolean).join(' · ')),
        sheetOnPaper(form),
    ], tr('Положить'), async () => {
        const { data, error } = await supabase.rpc('admission_admit', { admission_id: admission.id, bed_id: bed.id, title_sheet: form.read() });
        if (error) { toast(error.message || tr('Не удалось положить на койку.'), 'fail'); return false; }
        const complete = !!(data && data.title_sheet && sheetCompleteness(data.title_sheet).complete);
        toast(complete
            ? tr('Пациент размещён на койке. Титульный лист заполнен.')
            : tr('Пациент размещён на койке. Титульный лист заполнен не до конца — допишите его в истории болезни.'),
        complete ? 'ok' : 'warn');
        if (onDone) await onDone();
        return true;
    }, {
        width: 860,
        secondaryLabel: tr('Назад'),
        onSecondary: async () => { if (m) m.close(); if (onBack) onBack(); },
    });
    return m;
}

export async function printTitleSheet(view) {
    const { PRINT_FONT_FACE_CSS } = await import('../../shared/print-fonts.js');
    const html = titleSheetPrintHtml(view, { fontFaceCss: PRINT_FONT_FACE_CSS });
    const w = window.open('', '_blank');
    if (!w) { toast(tr('Для печати разрешите всплывающие окна.'), 'warn'); return false; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    return true;
}

/** Редактор для истории болезни — той же формы, что buildReviewEditor. */
export function buildTitleSheetEditor({ admission, onDone } = {}) {
    if (!admission || !admission.id) { toast(tr('Госпитализация не найдена.'), 'fail'); return null; }
    const form = titleSheetForm();
    const status = h('div', { class: 'muted ts-hint' });
    let view = null;
    const showStatus = () => {
        if (!view) { status.textContent = ''; return; }
        const head = view.complete && view.sheet
            ? trf('Заполнен: {who} · {when}', { who: view.sheet.filled_by_name || '', when: view.sheet.filled_at ? fmtDateTime(view.sheet.filled_at) : '' })
            : tr('Лист заполнен не до конца — пустые поля можно дописать и сохранить.');
        status.textContent = view.sheet ? head + ' · ' + papersSummary(view.sheet, { withDates: false }) : head;
    };
    const load = async () => {
        const { data, error } = await supabase.rpc('admission_title_sheet_get', { admission_id: admission.id });
        if (error) { toast(error.message || tr('Титульный лист не загрузился.'), 'fail'); return; }
        view = data;
        form.fill(data);
        showStatus();
    };
    load();

    return {
        title: tr('Титульный лист'),
        icon: 'Doc',
        noLetterhead: true,   // FORM_003_V1 — у бланка 003 своя шапка
        fields: [status, ...form.fields],
        submitLabel: tr('Сохранить'),
        submit: async () => {
            const { data, error } = await supabase.rpc('admission_title_sheet_save', Object.assign({ admission_id: admission.id }, form.read()));
            if (error) { toast(error.message || tr('Не удалось сохранить титульный лист.'), 'fail'); return false; }
            view = data;
            showStatus();
            toast(data && data.complete ? tr('Титульный лист сохранён.') : tr('Титульный лист сохранён, но заполнен не до конца.'),
                data && data.complete ? 'ok' : 'warn');
            if (onDone) await onDone();
            return true;
        },
        secondaryLabel: tr('Печать'),
        secondary: async () => {
            if (!view) await load();
            if (view) await printTitleSheet(view);
        },
    };
}
