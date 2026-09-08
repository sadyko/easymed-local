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
import { h, toast, field, fmtDateTime } from '../ui.js';
import { dateNumeric } from '../../shared/date-words.js';
import { tr, trf } from '../i18n.js';
import { inpatientModal, patientAnchor } from './inpatient-modal.js';
import { a4Sheet } from './a4-letterhead.js';
import { bmiOf, sheetCompleteness } from '../../shared/title-sheet-rules.js';
import { titleSheetPrintHtml } from './title-sheet-print.js';

export const TITLE_SHEET_KIND = 'title';

const val = (el) => String(el.value === null || el.value === undefined ? '' : el.value).trim();

/**
 * Форма листа. Возвращает поля для листа A4, fill(view) и read() → {sheet, patient}.
 * @param {{bed?: {id:number, code:string, ward_name?:string}|null}} opts — койка, выбранная в окне размещения.
 */
export function titleSheetForm({ bed = null } = {}) {
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
    const allergies  = h('textarea', { rows: '2' });
    const referred   = inp();
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
    const picked = { pediculosis: '', sanitation: '' };
    const uid = Math.random().toString(36).slice(2, 8);
    const radioEls = [];
    const radios = (key, options) => h('div', { class: 'ts-radios' }, ...options.map(([v, label]) => {
        const r = h('input', { type: 'radio', name: 'ts-' + key + '-' + uid, value: v, onchange: () => { picked[key] = v; } });
        r._tsKey = key; r._tsValue = v;
        radioEls.push(r);
        return h('label', null, r, ' ', tr(label));
    }));
    const pedRadios = radios('pediculosis', [['none', 'не выявлено'], ['found', 'выявлено']]);
    const sanRadios = radios('sanitation', [['full', 'полная'], ['partial', 'частичная'], ['none', 'не проводилась']]);

    const recalc = () => { const b = bmiOf(val(height), val(weight)); bmi.value = b === null ? '' : String(b); };
    height.addEventListener('input', recalc);
    weight.addEventListener('input', recalc);

    const info = {};
    const infoRow = (key, label) => {
        info[key] = h('span', { class: 'ts-v' }, '—');
        return h('div', { class: 'ts-kv' }, h('span', { class: 'ts-k' }, tr(label)), info[key]);
    };
    const block = (title, ...kids) => h('div', { class: 'ts-block' },
        h('div', { class: 'ts-block-t' }, tr(title)),
        h('div', { class: 'ts-grid' }, ...kids));

    const fields = [
        block('Пациент',
            field(tr('ФИО'), fullName),
            field(tr('Дата рождения'), dob),
            field(tr('Пол'), gender),
            field(tr('Телефон'), phone),
            field(tr('Адрес'), address),
            field(tr('Паспорт / ID'), nationalId),
            field(tr('Место работы'), occupation),
            field(tr('Контактное лицо'), ecName),
            field(tr('Телефон контактного лица'), ecPhone),
            field(tr('Группа крови и резус'), blood),
            field(tr('Аллергии'), allergies)),
        h('div', { class: 'muted ts-hint' }, tr('ФИО и дата рождения исправляются в карточке пациента.')),
        block('Поступление',
            infoRow('admitted_at', 'Дата и время'),
            infoRow('department', 'Отделение'),
            infoRow('place', 'Палата · койка'),
            infoRow('type', 'Вид госпитализации'),
            infoRow('diagnosis', 'Диагноз при направлении'),
            infoRow('complaint', 'Жалобы'),
            field(tr('Кем направлен'), referred)),
        block('Осмотр медсестры при поступлении',
            field(tr('Рост, см'), height),
            field(tr('Вес, кг'), weight),
            field(tr('ИМТ'), bmi),
            field(tr('Температура, °C'), temp),
            field(tr('АД, мм рт. ст.'), h('div', { class: 'ts-bp' }, bpSys, h('span', null, '/'), bpDia)),
            field(tr('Пульс, уд/мин'), pulse),
            field(tr('Осмотр на педикулёз и чесотку'), pedRadios),
            field(tr('Санитарная обработка'), sanRadios),
            field(tr('Примечание'), note)),
    ];

    function fill(view) {
        const p = (view && view.patient) || {};
        const a = (view && view.admission) || {};
        const s = (view && view.sheet) || {};
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
        for (const [el, key] of [[height, 'height_cm'], [weight, 'weight_kg'], [temp, 'temp_c'], [bpSys, 'bp_sys'], [bpDia, 'bp_dia'], [pulse, 'pulse_bpm']]) {
            el.value = s[key] === null || s[key] === undefined ? '' : String(s[key]);
        }
        recalc();
        picked.pediculosis = s.pediculosis || '';
        picked.sanitation = s.sanitation || '';
        for (const r of radioEls) r.checked = picked[r._tsKey] === r._tsValue;
        note.value = s.note || '';

        const placed = a.admitted_at && !['ordered', 'cancelled'].includes(a.status);
        info.admitted_at.textContent = placed ? fmtDateTime(a.admitted_at) : tr('при размещении');
        info.department.textContent = a.department || '—';
        info.place.textContent = [
            (bed && bed.ward_name) || a.ward_name,
            (bed && bed.code) || a.bed_code,
        ].filter(Boolean).join(' · ') || '—';
        info.type.textContent = a.admission_type === 'emergency' ? tr('Экстренная') : tr('Плановая');
        info.diagnosis.textContent = a.admission_diagnosis || '—';
        info.complaint.textContent = a.chief_complaint || '—';
    }

    function read() {
        return {
            sheet: {
                referred_from: val(referred),
                height_cm: val(height), weight_kg: val(weight), temp_c: val(temp),
                bp_sys: val(bpSys), bp_dia: val(bpDia), pulse_bpm: val(pulse),
                pediculosis: picked.pediculosis, sanitation: picked.sanitation,
                note: val(note),
            },
            patient: {
                gender: val(gender) || 'other',
                phone: val(phone), address: val(address), national_id: val(nationalId), occupation: val(occupation),
                emergency_contact_name: val(ecName), emergency_contact_phone: val(ecPhone),
                blood_type: val(blood), allergies: val(allergies),
            },
        };
    }

    return { fields, fill, read, inputs: { height, weight, bmi, temp, bpSys, bpDia, pulse, phone, referred } };
}

function sheetOnPaper(form) {
    return h('div', { class: 'a4-scroll ts-modal' },
        a4Sheet({ title: tr('Титульный лист'), children: [h('div', { class: 'ts-body' }, ...form.fields)] }));
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
        status.textContent = view.complete && view.sheet
            ? trf('Заполнен: {who} · {when}', { who: view.sheet.filled_by_name || '', when: view.sheet.filled_at ? fmtDateTime(view.sheet.filled_at) : '' })
            : tr('Лист заполнен не до конца — пустые поля можно дописать и сохранить.');
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
