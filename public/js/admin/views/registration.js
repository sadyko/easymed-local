// Patient registration — full port of design sample/src/view-registration.jsx.
// Left: 4-section form (Identity, Documents, Contacts & address, Legal rep).
// Right: Visit details + Coverage & payment sidebar.

import { tr, trf } from '../i18n.js';
import { h, Icon, PageHead, toast, clear, fmtDate } from '../ui.js';
import { openServicePickerModal } from './service-picker-modal.js?v=aug17e';   // CATALOG_WIZARD_V1
import { savePatient, loadPatientById } from '../data.js';
// REG_ADD_SERVICE_V1 — «Добавить услугу» открывает тот же мастер, что «Добавить
// услуги» в карте пациента и конверсия заявки в CRM. Раньше здесь импортировался
// patient-card.js openCreateVisitModal — пустая заглушка («replaced by the
// per-patient Book visit flow»), поэтому кнопка не открывала ничего.
// ?v= как у остальных импортёров visit-wizard.js — иначе получится второй
// экземпляр модуля.
import { openVisitWizard } from './visit-wizard.js?v=aug17e';
import { supabase } from '../../supabase.js';
import { uploadFile } from '../storage.js';
import { phoneInput, isCodeOnly } from '../phone-input.js?v=ph1';

// AURORA_REG_FORM_V1 — patient-photo bucket. Public bucket so photo_url holds a
// permanent URL (shapePatient renders patients.photo_url directly as <img src>).
// If the bucket is absent the upload throws → toast → patient saves photo-less.
const PHOTO_BUCKET = 'patient-photos';

const state = {
    gender:      '',
    citizenship: 'uz',
    residency:   'resident',   // 'resident' | 'nonresident' (maps to patients.citizenship)
    photoFile:   null,         // File/Blob pending upload (webcam snapshot or chosen file)
    photoUrl:    '',           // already-a-URL photo (from "по ссылке") OR uploaded result
    tgSent:      false,        // telegram opt-in toggled this session
    guardian:    { mode: 'base', relationship: 'Мать', guardianPatientId: '', name: '', phone: '', passport: '' },
};

// REG_RESET_V1 — where this view is currently mounted, so a successful save can
// blank it. admin.js's navigate() renders a view ONCE per tab and afterwards only
// switches to it ("Tab already open? Just switch to it — never re-render"), so
// renderRegistration does not run again when «+ New patient» is clicked a second
// time: the tab still holds the DOM nodes carrying the previous patient's values.
// Resetting the module `state` there is not enough — the text inputs live in the
// DOM, not in `state`.
let mountedContainer = null;
let mountedNavigate  = null;

function resetState() {
    state.gender      = '';
    state.citizenship = 'uz';
    state.residency   = 'resident';
    state.photoFile   = null;
    state.photoUrl    = '';
    state.tgSent      = false;
    state.guardian    = { mode: 'base', relationship: 'Мать', guardianPatientId: '', name: '', phone: '', passport: '' };
}

export function renderRegistration(container, { onNavigate } = {}) {
    mountedContainer = container;
    mountedNavigate  = onNavigate;
    resetState();
    paint(container, onNavigate);
}

// REG_RESET_V1 — rebuild the form empty. Called after a patient is saved, so the
// next «+ New patient» starts clean without a page refresh. Deliberately NOT
// called on plain navigation away: leaving the view mid-entry keeps the draft.
function resetRegistrationForm() {
    if (!mountedContainer || !mountedContainer.isConnected) return;
    resetState();
    paint(mountedContainer, mountedNavigate);
}

function paint(container, onNavigate) {
    clear(container);
    const formNode = h('form', { id: 'reg-form' });

    // REG_FIT_V1 — классы-зацепки для раскладки (см. admin-views.css): форма
    // должна помещаться на экране при 100% масштабе, а не упираться в свою
    // минимальную ширину и уезжать в горизонтальную прокрутку.
    container.appendChild(h('div', { class: 'fade-in reg-page', style: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '1320px', margin: '0 auto' } },
        PageHead({
            title: 'Создать пациента',
            subtitle: 'Создание или редактирование карты пациента и запись на первый приём',
            right: [
                h('button', { class: 'btn btn-danger', onclick: () => onNavigate('dashboard') }, 'Отмена'),
            ],
        }),
        // Ширина колонок и перенос правой колонки вниз на узком экране — в CSS
        // (.reg-cols), чтобы работал медиазапрос: инлайн-стиль его перебивает.
        h('div', { class: 'reg-cols' },
            leftCard(formNode, onNavigate),
            rightColumn(formNode, onNavigate),
        ),
    ));
}

// ---------------------------------------------------------------------------
function leftCard(formNode, onNavigate) {
    // Lifted refs so DOB drives Age automatically, and so the Legal-rep section
    // can be shown/hidden based on the computed age (minors & seniors must have
    // a representative on file).
    const dobInput = h('input', { name: 'date_of_birth', type: 'date' });
    const ageInput = h('input', {
        name: '__age', readOnly: true, placeholder: tr('—'),
        style: { background: 'var(--ink-25)', color: 'var(--ink-600)' },
    });
    const legalRepHint = h('div', { style: { fontSize: '12.5px', color: 'var(--warn-700)', fontWeight: 600, marginBottom: '10px' } }, '');
    const legalRepCard = section('4', 'Данные опекуна',
        'Требуется, если пациенту меньше 18 или больше 63 лет',
        guardianBody(legalRepHint),
    );
    legalRepCard.style.display = 'none';   // hidden until DOB triggers it

    // Cascading Country → Region → District dropdowns. Lists come from the
    // geography tables (migration 031) and are maintained under Settings →
    // Geography. Selected value of each <select> is the NAME (not the id),
    // so collectPatientPayload keeps writing plain text to patients.country /
    // region / district — no patient-schema change needed.
    const geo = geoCascade();

    function refreshAgeAndLegalRep() {
        const age = computeAge(dobInput.value);
        ageInput.value = (age == null || age < 0 || age > 130) ? '' : String(age);
        const catSel = document.querySelector('select[name="patient_category"]');
        if (catSel && !catSel.value) catSel.value = categoryFromAge(age);
        legalRepCard.style.display = 'none';   // OPEKUN_REMOVED_V1 — section never shown
    }
    dobInput.oninput = refreshAgeAndLegalRep;

    // Top search bar — live patient lookup so the registrar can find an
    // existing record before creating a duplicate.
    const searchInp = h('input', {
        type: 'search',
        autocomplete: 'off',
        style: { width: '100%', paddingLeft: '38px' },
        placeholder: tr('Поиск по ФИО, MRN, телефону или ПИНФЛ…'),
    });
    const resultsEl = h('div', {
        style: {
            position: 'absolute', top: 'calc(100% + 4px)', left: '0', right: '0',
            background: 'white', border: '1px solid var(--ink-200)', borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
            maxHeight: '320px', overflowY: 'auto',
            display: 'none', zIndex: '50',
        },
    });
    let searchTimer = null;
    const triggerSearch = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runPatientSearch(searchInp.value, resultsEl, onNavigate), 220);
    };
    searchInp.addEventListener('input', triggerSearch);
    searchInp.addEventListener('focus', () => { if (searchInp.value.trim().length >= 2) triggerSearch(); });
    document.addEventListener('click', (e) => {
        if (!searchInp.contains(e.target) && !resultsEl.contains(e.target)) {
            resultsEl.style.display = 'none';
        }
    });

    return h('div', { class: 'card' },
        // Search header
        h('div', { style: { padding: '16px 22px', borderBottom: '1px solid var(--ink-100)', background: 'linear-gradient(180deg, #f8fafa 0%, #ffffff 100%)' } },
            h('div', { class: 'field' },
                h('label', null,
                    'Найти существующего пациента ',
                    h('span', { class: 'muted', style: { fontWeight: 400 } }, '— проверьте перед созданием дубликата'),
                ),
                h('div', { style: { position: 'relative' } },
                    h('span', { style: { position: 'absolute', left: '12px', top: '11px', color: 'var(--ink-400)' } }, Icon('Search', { size: 16 })),
                    searchInp,
                    resultsEl,
                ),
                h('div', { class: 'hint' }, 'Не нашли? Заполните форму ниже, чтобы создать новую карту.'),
            ),
        ),

        h('div', { style: { padding: '24px' } },
            // SECTION 1
            section('1', 'Личные данные', 'ФИО, дата рождения, пол, телефон',
                h('div', { style: { display: 'grid', gridTemplateColumns: '156px 1fr', gap: '22px' } },
                    photoBlock(),
                    identityGrid(dobInput, ageInput),
                ),
            ),
            // REG_SECTIONS_SWAP_V1 — SECTION 2 is now «Контакты и адрес»;
            // «Документы и резидентство» moved to SECTION 3.
            section('2', 'Контакты и адрес', 'Где с пациентом можно связаться',
                h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' } },
                    field({ label: 'Email',                  input: mailInput('email',  'name@example.com') }),
                    field({ label: 'Предпочитаемый язык',    input: select('language', ['Узбекский', 'Русский', 'Английский', 'Каракалпакский']) }),
                    field({ label: 'Страна',                 input: geo.countrySel  }),
                    field({ label: 'Регион',                 input: geo.regionSel   }),
                    field({ label: 'Район',                  input: geo.districtSel }),
                    field({ label: 'Улица, дом, квартира',   input: h('input', { name: 'address',  placeholder: tr('ул. Амира Темура 12, кв. 47') }), span: 2 }),
                    field({ label: 'Махалля',                input: h('input', { name: 'mahalla',  placeholder: tr('Юнусабад-3') }) }),
                    field({ label: 'Telegram-бот (уведомления и напоминания)', input: telegramBlock(), span: 3 }),
                ),
                { foldable: true },   // REG_FOLD_SECTIONS_V1
            ),
            section('3', 'Документы и резидентство', 'ПИНФЛ, паспорт, гражданство',
                h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' } },
                    field({ label: 'Резидентство', span: 3, input: radioChips('__residency',
                        [['resident', 'Резидент РУз'], ['nonresident', 'Нерезидент']],
                        () => state.residency,
                        (v) => { state.residency = v; },
                    )}),
                    field({ label: 'ПИНФЛ (ЖШШИР)',          input: h('input', { name: 'national_id',     placeholder: tr('14 цифр'), maxLength: '14' }) }),
                    field({ label: 'Паспорт / документ №',   input: h('input', { name: 'passport_number', placeholder: tr('AB1234567') }) }),
                    field({ label: 'Гражданство / национальность', input: h('input', { name: 'nationality', placeholder: tr('Узбек') }) }),
                    field({ label: 'Категория пациента', span: 3, input: categorySelect() }),
                ),
                { foldable: true },   // REG_FOLD_SECTIONS_V1
            ),
            // OPEKUN_REMOVED_V1 — SECTION 4 (Данные опекуна) removed: guardian is
            // not collected or required at any age.
            // SECTION 5 — registrar caution flag
            section('5', 'Поведение / предупреждение', 'Для безопасности персонала — отметьте грубое, агрессивное или сложное поведение, чтобы предупредить следующего сотрудника',
                behaviorBox(),
            ),
        ),
        formNode,
    );
}

// A single, prominent caution box the registrar fills in when a patient has
// shown difficult / aggressive / problematic behaviour. Saved to
// patients.behavior_note and surfaced as a warning wherever the patient opens.
function behaviorBox() {
    return h('div', {
        style: {
            border: '1px solid #f0d29b', background: 'var(--warn-50)',
            borderRadius: '10px', padding: '12px 14px',
        },
    },
        h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px', color: 'var(--warn-700)', fontSize: '12.5px', fontWeight: 600 } },
            Icon('Warning', { size: 14 }),
            h('span', null, 'Показывается как предупреждение каждому сотруднику, открывающему карту пациента'),
        ),
        h('textarea', {
            name: 'behavior_note', rows: '3',
            style: { width: '100%', boxSizing: 'border-box' },
            placeholder: tr('напр. Грубил регистратуре; приходил в нетрезвом виде; отказывается ждать — будьте внимательны.'),
        }),
    );
}

function photoBlock() {
    const img = h('img', { alt: 'Фото пациента', style: { display: 'none', width: '156px', height: '156px', objectFit: 'cover', borderRadius: '12px' } });
    const ph  = h('div', { class: 'cam-ph' },
        Icon('Image', { size: 28 }),
        h('span', { style: { fontSize: '12.5px', fontWeight: 500 } }, 'Фото пациента'),
    );
    const box = h('div', { class: 'cam-box' }, ph, img);
    const setPhoto = (url) => {
        if (!url) { img.style.display = 'none'; ph.style.display = ''; return; }
        img.src = url; img.style.display = ''; ph.style.display = 'none';
    };
    const fileInp = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' },
        onchange: (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            state.photoFile = f; state.photoUrl = '';
            setPhoto(URL.createObjectURL(f));
            toast(trf('Фото загружено: {name}', { name: f.name || tr('файл') }));
        },
    });
    const acts = h('div', { class: 'cam-acts' },
        h('button', { class: 'cam-act', type: 'button', title: 'Сфотографировать с веб-камеры', 'aria-label': 'Сфотографировать',
            onclick: () => openWebcamModal((blob) => { state.photoFile = blob; state.photoUrl = ''; setPhoto(URL.createObjectURL(blob)); toast('Фото снято с камеры'); }) },
            Icon('Camera', { size: 15 })),
        h('button', { class: 'cam-act', type: 'button', title: 'Загрузить файл с компьютера', 'aria-label': 'Загрузить с компьютера',
            onclick: () => fileInp.click() },
            Icon('Download', { size: 15 })),
        h('button', { class: 'cam-act', type: 'button', title: 'Добавить фото по ссылке (URL)', 'aria-label': 'По ссылке',
            onclick: () => { const u = window.prompt('Ссылка на фото (URL)'); if (u && u.trim()) { state.photoFile = null; state.photoUrl = u.trim(); setPhoto(u.trim()); toast('Фото по ссылке добавлено'); } } },
            Icon('Globe', { size: 15 })),
    );
    return h('div', { class: 'cam-wrap' }, box, fileInp, acts);
}

function identityGrid(dobInput, ageInput) {
    // REG_ROWS_TOP_V1 — alignContent start: the grid stretches to the photo's
    // height, which spread the rows apart (phones drifted far below Пол).
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px', alignContent: 'start' } },
        field({ label: ['Фамилия ',  req()], input: nameInput('last_name',   'Каримова') }),
        field({ label: ['Имя ',      req()], input: nameInput('first_name',  'Азиза') }),
        field({ label: 'Отчество',           input: nameInput('middle_name', 'Рустамовна') }),
        field({ label: ['Дата рождения ', req()], input: dobInput }),
        field({ label: 'Возраст',            input: ageInput }),
        field({ label: ['Пол ', req()], input: radioChips('gender',
            [['M', 'Мужской'], ['F', 'Женский']],
            () => state.gender,
            (v) => { state.gender = v; },
            { nowrap: true },   // REG_ROWS_TOP_V2 — one-line gender = compact row = phones hug the DOB row
        )}),
        // REG_PHONE_COMPACT_V1 — phones are row 3 of the identity grid, so they
        // fill the photo-height stretch gap and align with the other fields.
        field({ label: ['Номер телефона ', req()], input: phoneInput('phone', '+998 90 961 00 04') }),
        field({ label: 'Доп. номер телефона',    input: phoneInput('phone_secondary', '+998 90 000 00 00') }),
    );
}

// ---------------------------------------------------------------------------
function rightColumn(formNode, onNavigate) {
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', position: 'sticky', top: '88px' } },
        // Visit details are no longer entered here — saving the patient opens
        // the Create-visit modal automatically (service picker + scheduling).
        coverageCard(formNode, onNavigate),
    );
}

function coverageCard(formNode, onNavigate) {
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Wallet', { size: 16 }), ' Регистрация пациента')),
        h('div', { class: 'card-pad' },
            h('div', { class: 'muted', style: { fontSize: '12.5px', lineHeight: '1.5' } },
                'Покрытие, скидка, направление и услуги задаются в визите — окно создания визита откроется автоматически после регистрации.'),
        ),
        h('div', {
            style: { padding: '14px 18px', borderTop: '1px solid var(--ink-100)', background: 'var(--ink-25)', borderRadius: '0 0 14px 14px', display: 'flex', gap: '8px' },
        },
            // Save the patient only — go to the patient card, don't open the
            // service picker. Use when the registrar just needs to register and
            // come back later to add services.
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { flex: '1', justifyContent: 'center' },
                onclick: (ev) => { const b = ev.currentTarget; if (b.disabled) return; b.disabled = true; Promise.resolve(doSavePatientOnly(formNode, onNavigate)).finally(() => { b.disabled = false; }); } },
                Icon('Check', { size: 14 }), ' Сохранить пациента'),
            // Save the patient AND open the Create-visit modal so a service can
            // be added immediately (same flow as the old "Register" button).
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', style: { flex: '1', justifyContent: 'center' },
                onclick: (ev) => { const b = ev.currentTarget; if (b.disabled) return; b.disabled = true; Promise.resolve(doSave(formNode, onNavigate)).finally(() => { b.disabled = false; }); } },
                Icon('Plus', { size: 14 }), ' Добавить услугу'),
        ),
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function section(num, title, desc, body, { foldable = false, open = false } = {}) {
    // REG_FOLD_SECTIONS_V1 — optional accordion: «Контакты и адрес» and
    // «Документы и резидентство» start folded; header click toggles. Hidden
    // inputs stay in the DOM, so saving reads their values either way.
    if (!foldable) {
        return h('div', { class: 'form-section' },
            h('div', { class: 'form-section-head' },
                h('span', { class: 'num-step' }, num),
                h('h4', null, title),
                h('p', null, desc),
            ),
            body,
        );
    }
    body.style.display = open ? '' : 'none';
    body.style.marginTop = '14px';
    // REG_FOLD_SECTIONS_V2 — the folded head is a compact clickable pill with an
    // explicit «Развернуть/Свернуть» affordance, not a bare header.
    const chev = h('span', { style: { marginLeft: 'auto', fontSize: '12.5px', fontWeight: '700', color: 'var(--primary-700)', display: 'inline-flex', alignItems: 'center', gap: '5px', flex: '0 0 auto', whiteSpace: 'nowrap' } }, open ? 'Свернуть ▾' : 'Развернуть ▸');
    const head = h('div', { class: 'form-section-head', style: {
            cursor: 'pointer', userSelect: 'none', margin: '0',
            background: 'var(--ink-25)', border: '1px solid var(--ink-100)',
            borderRadius: '10px', padding: '7px 12px',
        },
        onmouseenter: (e) => { e.currentTarget.style.background = 'var(--primary-50)'; e.currentTarget.style.borderColor = 'var(--primary-300)'; },
        onmouseleave: (e) => { e.currentTarget.style.background = 'var(--ink-25)'; e.currentTarget.style.borderColor = 'var(--ink-100)'; },
        onclick: () => {
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? '' : 'none';
            chev.textContent = hidden ? tr('Свернуть ▾') : tr('Развернуть ▸');
        } },
        h('span', { class: 'num-step' }, num),
        h('h4', null, title),
        h('p', null, desc),
        chev,
    );
    return h('div', { class: 'form-section', style: { marginBottom: '10px' } }, head, body);
}
function field({ label, input, span }) {
    const wrap = h('div', { class: 'field' }, h('label', null, ...(Array.isArray(label) ? label.map(x => typeof x === 'string' ? tr(x) : x) : [tr(label)])), input);
    if (span) wrap.style.gridColumn = `span ${span}`;
    return wrap;
}
function req() { return h('span', { class: 'req' }, '*'); }

// NAME_CAPS_V1 — ФИО inputs capitalise the first letter of every word as the
// registrar types (also after a space or hyphen: «Абдулла-оглы» → «Абдулла-Оглы»).
// Only the case of an already-typed lowercase letter changes, so ALL-CAPS входные
// данные и уже набранный текст не ломаются; the caret is restored because the
// string length never changes.
function capitalizeNameInput(el) {
    const pos = el.selectionStart;
    const v = el.value;
    const nv = v.replace(/(^|[\s\-])(\p{Ll})/gu, (m, sep, ch) => sep + ch.toLocaleUpperCase());
    if (nv !== v) {
        el.value = nv;
        try { el.setSelectionRange(pos, pos); } catch (e) {}
    }
}
function nameInput(nameAttr, ph) {
    const el = h('input', { name: nameAttr, placeholder: tr(ph), autocapitalize: 'words', autocomplete: 'off' });
    el.addEventListener('input', () => capitalizeNameInput(el));
    el.addEventListener('blur',  () => capitalizeNameInput(el));
    return el;
}

// Whole-years age from an ISO date (YYYY-MM-DD). Returns null when the date is
// missing or unparseable. Used to auto-fill Age and to decide whether the
// Legal-representative section must be required (under 18 / over 63).
function computeAge(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const t = new Date();
    let age = t.getFullYear() - d.getFullYear();
    const m = t.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < d.getDate())) age--;
    return age;
}
function needsLegalRep(age) { return false; }   // OPEKUN_REMOVED_V1 — guardian not required at any age
function select(name, options, def) {
    const sel = h('select', { name });
    for (const opt of options) sel.appendChild(h('option', { value: opt, selected: (def === opt) }, opt));
    return sel;
}

// Live patient lookup behind the top "Find existing patient" search box.
// Queries the patients table across the columns a registrar typically knows
// (name parts, phone, MRN, national_id) and renders clickable matches.
// On click, navigates to that patient's card — preventing duplicates.
async function runPatientSearch(term, resultsEl, onNavigate) {
    const t = (term || '').trim();
    if (t.length < 2) {
        clear(resultsEl);
        resultsEl.style.display = 'none';
        return;
    }
    // Searchable columns. last_name / first_name come from migration 026; the
    // try/catch tolerates a DB that doesn't have them yet.
    const fields = ['full_name', 'last_name', 'first_name', 'middle_name', 'phone', 'mrn', 'national_id'];
    const cols   = 'id, mrn, full_name, last_name, first_name, middle_name, phone, date_of_birth, national_id';
    const seen   = new Set();
    const rows   = [];
    await Promise.all(fields.map(async (f) => {
        try {
            let q = supabase.from('patients')
                .select(cols)
                .ilike(f, '%' + t + '%')
                .limit(8);
            // TENANT_SCOPE_V3 — search only this clinic's patients
            const _cid = (typeof window !== 'undefined' && window.CLINIC && window.CLINIC.id) || null;
            if (_cid) q = q.eq('company_id', _cid);
            const { data } = await q;
            for (const r of (data || [])) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
        } catch { /* column missing on this DB — skip it */ }
    }));

    clear(resultsEl);
    if (rows.length === 0) {
        resultsEl.appendChild(h('div', {
            style: { padding: '14px', fontSize: '12.5px', textAlign: 'center', color: 'var(--ink-500)' },
        }, trf('Совпадений по запросу «{q}» нет. Заполните форму ниже, чтобы создать новую карту.', { q: t })));
    } else {
        for (const p of rows.slice(0, 10)) {
            const name = [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' ').trim()
                       || p.full_name || '(unnamed)';
            const meta = [p.mrn, p.phone, p.national_id, p.date_of_birth].filter(Boolean).join(' · ');
            resultsEl.appendChild(h('button', {
                type: 'button',
                style: {
                    display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
                    textAlign: 'left', padding: '10px 14px',
                    background: 'white', border: '0',
                    borderBottom: '1px solid var(--ink-100)',
                    cursor: 'pointer', font: 'inherit',
                },
                onmouseenter: (ev) => { ev.currentTarget.style.background = 'var(--ink-25)'; },
                onmouseleave: (ev) => { ev.currentTarget.style.background = 'white'; },
                onclick: async () => {
                    resultsEl.style.display = 'none';
                    if (typeof onNavigate !== 'function') return;
                    // PATIENT_CARD_SHAPE_V1 — `p` is a RAW snake_case DB row; the patient
                    // card reads the camelCase view-model, so hand it the shaped record
                    // (loadPatientById returns shapePatient()) instead of the raw row.
                    const full = await loadPatientById(p.id).catch(() => null);
                    onNavigate('patient-card', full || p);
                },
            },
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { class: 'cell-strong', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
                    meta && h('div', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, meta),
                ),
                h('span', { style: { color: 'var(--ink-400)' } }, Icon('ArrowRight', { size: 14 })),
            ));
        }
    }
    resultsEl.style.display = '';
}

// Cascading Country → Region → District. Each select stores the chosen NAME
// as its value (so the existing form-submit code, which writes
// patients.country / region / district as plain text, keeps working). The
// row id is parked on the option's data-id attribute so we can use it to
// filter the next level down.
export function geoCascade() {
    const countrySel  = h('select', { name: 'country'  });
    const regionSel   = h('select', { name: 'region'   });
    const districtSel = h('select', { name: 'district' });

    paintSelect(countrySel,  [], 'Loading…');
    paintSelect(regionSel,   [], '— Select country first —');
    paintSelect(districtSel, [], '— Select region first —');

    function paintSelect(sel, rows, placeholder, selectedName) {
        clear(sel);
        sel.appendChild(h('option', { value: '' }, placeholder));
        for (const r of rows) {
            const opt = h('option', { value: r.name }, r.name);
            opt.dataset.id = r.id;
            if (selectedName && selectedName === r.name) opt.selected = true;
            sel.appendChild(opt);
        }
    }
    function selectedId(sel) {
        const o = sel.options[sel.selectedIndex];
        return o ? (o.dataset.id || '') : '';
    }

    async function loadCountries() {
        const { data, error } = await supabase
            .from('countries').select('id, name').eq('active', true).order('name');
        if (error) { console.warn('[geo] countries:', error.message); return []; }
        return data || [];
    }
    async function loadRegions(countryId) {
        if (!countryId) return [];
        const { data, error } = await supabase
            .from('regions').select('id, name').eq('country_id', countryId).eq('active', true).order('name');
        if (error) { console.warn('[geo] regions:', error.message); return []; }
        return data || [];
    }
    async function loadDistricts(regionId) {
        if (!regionId) return [];
        const { data, error } = await supabase
            .from('districts').select('id, name').eq('region_id', regionId).eq('active', true).order('name');
        if (error) { console.warn('[geo] districts:', error.message); return []; }
        return data || [];
    }

    countrySel.addEventListener('change', async () => {
        paintSelect(regionSel,   [], 'Loading…');
        paintSelect(districtSel, [], '— Select region first —');
        const regs = await loadRegions(selectedId(countrySel));
        paintSelect(regionSel, regs, regs.length ? '— Select region —' : 'No regions yet — add them under Settings → Geography');
    });
    regionSel.addEventListener('change', async () => {
        paintSelect(districtSel, [], 'Loading…');
        const dists = await loadDistricts(selectedId(regionSel));
        paintSelect(districtSel, dists, dists.length ? '— Select district —' : 'No districts yet — add them under Settings → Geography');
    });

    // Initial load: countries → default to Uzbekistan if present → its regions.
    (async () => {
        const countries = await loadCountries();
        paintSelect(countrySel, countries, countries.length ? '— Select country —' : 'No countries — add them under Settings → Geography', 'Uzbekistan');
        const cId = selectedId(countrySel);
        if (cId) {
            const regs = await loadRegions(cId);
            paintSelect(regionSel, regs, regs.length ? '— Select region —' : 'No regions yet — add them under Settings → Geography');
        }
    })();

    return { countrySel, regionSel, districtSel };
}
// PHONE_INPUT_V1 — the control now lives in admin/phone-input.js so every screen
// that takes a number can use it (it used to be private to this file, and only
// defaulted to Uzbekistan when the field was literally named 'phone'). Re-exported
// here because patient-card.js and others already import it from this module.
export { phoneInput };
export function mailInput(name, ph) {
    return h('div', { style: { position: 'relative' } },
        h('span', { style: { position: 'absolute', left: '12px', top: '12px', color: 'var(--ink-400)' } }, Icon('Mail', { size: 14 })),
        h('input', { name, style: { paddingLeft: '36px', width: '100%' }, placeholder: ph }),
    );
}
export function radioChips(name, options, getter, setter, { nowrap = false } = {}) {
    // REG_ROWS_TOP_V2 — nowrap: chips stay on ONE line (compact) so the row
    // doesn't grow tall and push the next grid row away.
    const wrap = h('div', { class: 'radio-chips', style: nowrap ? { flexWrap: 'nowrap' } : {} });
    function repaint() {
        clear(wrap);
        for (const [val, lbl] of options) {
            wrap.appendChild(h('button', {
                type: 'button',
                class: 'radio-chip' + (getter() === val ? ' on' : ''),
                style: nowrap ? { flex: '1', justifyContent: 'center', padding: '0 8px', fontSize: '12.5px', whiteSpace: 'nowrap' } : { flex: '1', justifyContent: 'center' },
                onclick: () => { setter(val); repaint(); },
                dataset: { name, value: val },
            }, h('span', { class: 'rc-dot' }), ' ', lbl));
        }
    }
    repaint();
    return wrap;
}

// ---------------------------------------------------------------------------
// Collect the patient payload from the identity form. Returns null (and toasts)
// when the required name is missing.
function collectPatientPayload(formNode) {
    const root = formNode.closest('.card') || document;
    const payload = {};
    for (const inp of root.querySelectorAll('input[name], select[name], textarea[name]')) {
        const n = inp.getAttribute('name');
        if (!n || n.startsWith('__')) continue;
        // PHONE_INPUT_V1 — phone fields are pre-filled with «+998», so a field
        // nobody typed into still has a value. Store it as empty, or every
        // patient would come out with a phone number of "+998".
        payload[n] = (inp.dataset.phone && isCodeOnly(inp.value)) ? '' : inp.value;
    }
    payload.gender = state.gender;
    // Residency toggle (radioChips → no [name]) maps to the citizenship column.
    payload.citizenship = state.residency === 'nonresident' ? 'nonresident' : 'resident';
    if (!payload.last_name || !payload.first_name) {
        toast('Фамилия и имя обязательны.', 'fail');
        return null;
    }
    // For minors (<18) and seniors (>63) a legal representative is mandatory.
    const age = computeAge(payload.date_of_birth);
    if (needsLegalRep(age)) {
        if (!(payload.legal_representative || '').trim()) {
            toast(trf('Пациенту {age} лет — укажите ФИО опекуна.', { age }), 'fail');
            return null;
        }
        if (!(payload.emergency_contact_phone || '').trim()) {
            toast(trf('Пациенту {age} лет — укажите телефон опекуна.', { age }), 'fail');
            return null;
        }
    }
    return payload;
}

// Register the patient, then immediately open the Create-visit modal (service
// picker + per-service scheduling, where the service sets the visit day). On
// success, land on the new patient's card so the visit is visible.
async function doSave(formNode, onNavigate) {
    return saveAndContinue(formNode, onNavigate, { openVisit: true });
}

// "Save the patient" — save only, then jump to the patient card. No service
// picker. Use when the registrar will return later to add services.
async function doSavePatientOnly(formNode, onNavigate) {
    return saveAndContinue(formNode, onNavigate, { openVisit: false });
}

// Shared core. When the duplicate guard fires, we DON'T fall back to a toast —
// the registrar gets a real dialog with two clear choices: open the existing
// patient or force-create a new record. `force` is set on the retry path.
async function saveAndContinue(formNode, onNavigate, { openVisit, force = false } = {}) {
    const payload = collectPatientPayload(formNode);
    if (!payload) return;
    // Upload the chosen/captured photo to Storage (never base64) and store the URL.
    const photoUrl = await uploadPendingPhoto();
    if (photoUrl) payload.photo_url = photoUrl;
    // Telegram opt-in → real boolean + timestamptz (069 columns).
    if (state.tgSent) { payload.telegram_opt_in = true; payload.telegram_invited_at = new Date().toISOString(); }
    let patient;
    try {
        patient = await savePatient(payload, { force });
    } catch (e) {
        if (e?.code === 'DUPLICATE_PATIENT' && e.existing) {
            openDuplicatePatientDialog(e, {
                onOpenExisting: async (c) => {
                    const p = await loadPatientById(c.id);
                    if (p) onNavigate('patient-card', p);
                    else   toast('Could not load that patient.', 'fail');
                },
                onForceCreate: () => saveAndContinue(formNode, onNavigate, { openVisit, force: true }),
            });
            return;
        }
        toast(`Save failed: ${e.message || e}`, 'fail');
        return;
    }
    await persistGuardian(patient, payload);
    // REG_RESET_V1 — the patient is saved, so this form is done. Blank it now:
    // the registration tab stays mounted after we navigate away, and without
    // this the next «+ New patient» shows the record we just created and needs
    // a page refresh to clear.
    resetRegistrationForm();
    toast('Пациент сохранён.');
    onNavigate('patients');
    // REG_ADD_SERVICE_V1 — и только теперь, для «Добавить услугу», открываем мастер.
    //
    // `openVisit` принимался и молча игнорировался (PHASE2A_SHELL припарковал
    // запись визита), поэтому ОБЕ кнопки в подвале делали одно и то же: сохранить
    // и уйти в список. Диалог не появлялся не из-за ошибки — вызова просто не было.
    //
    // Порядок «сначала перейти, потом открыть мастер» — тот же, что в конверсии
    // CRM (crm.js): мастер монтируется в document.body и переживает переход, а
    // если он почему-то не откроется, регистратор остаётся в списке пациентов,
    // а не на очищенной форме. Путь «Сохранить пациента» не затронут.
    //
    // shapePatient() отдаёт camelCase, мастер читает full_name — поэтому маппинг.
    if (openVisit && patient && patient.id) {
        Promise.resolve(openVisitWizard(null, {
            id: patient.id, full_name: patient.fullName, mrn: patient.mrn, phone: patient.phone,
        })).catch((e) => toast(trf('Не удалось открыть мастер услуг: {msg}', { msg: (e && e.message) || e }), 'fail'));
    }
}

// Duplicate-patient resolution dialog. Renders the candidate matches as a
// clickable list — click a row to open that record, or force-create a new one
// at the bottom if the registrar is sure it's a different person. The match
// score (phone, PINFL, name-Levenshtein, DOB) decides ordering and chip text.
//
// Exported so other flows (the Scheduling booking modal's "New patient"
// inline registration, for example) can reuse the same UX and back-end logic.
// `onOpenExisting(candidate)` receives the full candidate row (raw snake_case
// columns) — caller decides whether to navigate, select-for-booking, etc.
export function openDuplicatePatientDialog(err, { onOpenExisting, onForceCreate }) {
    const list = Array.isArray(err.existing) ? err.existing : (err.existing ? [err.existing] : []);

    const overlay = h('div', { class: 'modal', style: { zIndex: '160' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const fmtDob = (d) => fmtDate(d);   // DATE_FMT_V1

    const rowsEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' } },
        ...list.map(c => {
            const name = [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ').trim() || c.full_name || '(unnamed)';
            const reasonChips = (c._reasons || []).map(r => h('span', {
                style: {
                    fontSize: '12.5px', fontWeight: 600, padding: '1px 8px',
                    borderRadius: '999px', background: 'var(--primary-50)',
                    color: 'var(--primary-700)', textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                },
            }, r));
            return h('button', {
                type: 'button',
                class: 'dup-row',
                style: {
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '11px 13px', borderRadius: '10px',
                    border: '1px solid var(--ink-200)', background: 'white',
                    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                    width: '100%', transition: 'background 100ms ease, border-color 100ms ease',
                },
                onmouseenter: (ev) => { ev.currentTarget.style.background = 'var(--ink-25)'; ev.currentTarget.style.borderColor = 'var(--ink-300)'; },
                onmouseleave: (ev) => { ev.currentTarget.style.background = 'white'; ev.currentTarget.style.borderColor = 'var(--ink-200)'; },
                onclick: async (ev) => {
                    ev.currentTarget.disabled = true;
                    try { await onOpenExisting(c); close(); }
                    finally { if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false; }
                },
            },
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { class: 'row', style: { gap: '8px', marginBottom: '3px', flexWrap: 'wrap' } },
                        h('span', { class: 'cell-strong', style: { fontSize: '13.5px' } }, name),
                        c.mrn && h('span', { class: 'cell-mono muted', style: { fontSize: '12.5px' } }, c.mrn),
                    ),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '4px' } },
                        [
                            `DOB ${fmtDob(c.date_of_birth)}`,
                            c.phone || '—',
                            c.national_id ? 'PINFL ' + c.national_id : null,
                        ].filter(Boolean).join(' · ')),
                    reasonChips.length ? h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap' } }, ...reasonChips) : null,
                ),
                Icon('ArrowRight', { size: 14 }),
            );
        }),
    );

    const card = h('div', { class: 'modal-card', style: { width: '560px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Warning', { size: 16 }), ' Возможный дубликат пациента'),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body' },
            h('div', {
                style: {
                    padding: '11px 14px', border: '1px solid #f0d29b',
                    background: 'var(--warn-50)', borderRadius: '10px',
                    fontSize: '12.5px', color: 'var(--ink-800)',
                },
            }, list.length === 1
                ? 'Найдено 1 возможное совпадение. Выберите существующего пациента — или принудительно создайте нового, если уверены, что это другой человек.'
                : trf('Найдено совпадений: {n}. Выберите существующего пациента — или принудительно создайте нового, если ни один из них не тот же человек.', { n: list.length }),
            ),
            rowsEl,
        ),
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),   // BTNS_RIGHT_V1
            h('button', { class: 'btn', onclick: close }, 'Отмена'),
            h('button', { class: 'btn btn-outline',
                style: { color: 'var(--crit-700)', borderColor: 'var(--crit-500)' },
                onclick: async (ev) => {
                    ev.currentTarget.disabled = true;
                    try { await onForceCreate(); close(); }
                    finally { if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false; }
                },
            }, Icon('Plus', { size: 13 }), ' Создать принудительно'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
}

// ===========================================================================
// AURORA_REG_FORM_V1 — B3 additions: photo/webcam, country phone input,
// guardian picker, telegram opt-in, category/residency helpers.
// ===========================================================================

// --- Photo: upload the pending photo to Supabase Storage (NEVER base64). -----
// Returns the value to store in patients.photo_url: an external URL ("по ссылке"),
// a Storage public URL, or '' (leave unchanged / save photo-less on failure).
async function uploadPendingPhoto() {
    if (state.photoUrl) return state.photoUrl;          // "по ссылке" — already a URL
    if (!state.photoFile) return '';                    // nothing chosen
    const file = state.photoFile instanceof File
        ? state.photoFile
        : new File([state.photoFile], 'photo.jpg', { type: state.photoFile.type || 'image/jpeg' });
    try {
        const { path } = await uploadFile(PHOTO_BUCKET, file, 'patients/');
        const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
        return data?.publicUrl || '';
    } catch (e) {
        toast(trf('Не удалось загрузить фото: {msg}', { msg: e?.message || e }), 'fail');
        return '';                                       // save patient anyway, without photo
    }
}

// --- WebcamCapture modal: getUserMedia → <video> → canvas snapshot → Blob. ---
function openWebcamModal(onCapture) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '120' } });
    let stream = null;
    const stop = () => { if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; } };
    const close = () => { stop(); overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const video = h('video', { autoplay: true, playsinline: true, muted: true, class: 'cam-video' });
    const errEl = h('div', { class: 'cam-err', style: { display: 'none' } });
    const snapBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true,
        onclick: () => {
            const w = video.videoWidth || 1280, ht = video.videoHeight || 960;
            const cv = document.createElement('canvas'); cv.width = w; cv.height = ht;
            cv.getContext('2d').drawImage(video, 0, 0, w, ht);
            cv.toBlob((blob) => { if (blob) onCapture(blob); close(); }, 'image/jpeg', 0.9);
        } }, Icon('Camera', { size: 14 }), ' Сделать снимок');

    const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = ''; };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showErr('Камера не поддерживается этим браузером.');
    } else {
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
            .then((s) => { stream = s; video.srcObject = s; snapBtn.removeAttribute('disabled'); })
            .catch((e) => showErr(trf('Нет доступа к камере: {msg}. Разрешите доступ в браузере.', { msg: e?.message || e })));
    }

    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Camera', { size: 16 }), ' Съёмка фото пациента'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' }, errEl, video),
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),   // BTNS_RIGHT_V1
            h('button', { class: 'btn', onclick: close }, 'Отмена'),
            snapBtn),
    ));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
}

// --- Patient category auto-suggest from age. ---------------------------------
function categorySelect() {
    const sel = h('select', { name: 'patient_category' });
    sel.appendChild(h('option', { value: '' }, '—'));
    for (const opt of ['Взрослый', 'Ребёнок', 'Новорождённый']) sel.appendChild(h('option', { value: opt }, opt));
    return sel;
}
function categoryFromAge(age) {
    if (age == null) return '';
    if (age < 1)  return 'Новорождённый';
    if (age < 18) return 'Ребёнок';
    return 'Взрослый';
}

// --- Telegram opt-in block. --------------------------------------------------
function telegramBlock() {
    const chip = h('span', { class: 'tg-chip' }, Icon('Send', { size: 13 }), ' ', h('span', { class: 'tg-chip-t' }, 'Не подключён'));
    const note = h('div', { class: 'muted', style: { fontSize: '12.5px', display: 'none', marginTop: '6px' } });
    const btn = h('button', { class: 'btn btn-outline btn-sm', type: 'button',
        onclick: () => {
            state.tgSent = true;
            chip.classList.add('on');
            chip.querySelector('.tg-chip-t').textContent = tr('Приглашение отправлено');
            btn.style.display = 'none';
            const phone = (document.querySelector('input[name="phone"]')?.value) || tr('номер пациента');
            note.textContent = trf('Ссылка на бота отправлена на {phone} — подключение после перехода по ней.', { phone });
            note.style.display = '';
            toast('Приглашение отправлено');
        } },
        Icon('Send', { size: 13 }), ' Отправить приглашение в бот');
    return h('div', { class: 'tg-wrap' },
        h('div', { class: 'tg-row' }, chip, btn),
        note,
    );
}

// --- Guardian section: relationship + from-base/new toggle + adult picker. ----
function guardianBody(legalRepHint) {
    // Existing columns stay wired through named inputs so collectPatientPayload
    // + the minor/senior validation keep working unchanged.
    const repName  = h('input', { name: 'legal_representative', placeholder: tr('Каримов Рустам Аброрович') });
    const repPhone = phoneInput('emergency_contact_phone', '+998 90 123 45 67');
    const repPass  = h('input', { name: '__guardian_passport', placeholder: tr('AB1234567'),
        oninput: (e) => { state.guardian.passport = e.target.value; } });
    const relHidden = h('input', { type: 'hidden', name: 'legal_rep_relation', value: state.guardian.relationship });
    const notes    = h('input', { name: 'notes', placeholder: tr('Любая дополнительная информация…') });

    const relSel = select('__guardian_relationship',
        ['Мать', 'Отец', 'Бабушка', 'Дедушка', 'Опекун', 'Иной представитель'], state.guardian.relationship);
    relSel.addEventListener('change', () => { state.guardian.relationship = relSel.value; relHidden.value = relSel.value; });

    const baseWrap = h('div', { class: 'grd-pane' });
    const newWrap  = h('div', { class: 'grd-pane', style: { display: 'none' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' } },
            field({ label: ['ФИО опекуна ', req()], input: repName, span: 2 }),
            field({ label: ['Телефон опекуна ', req()], input: repPhone }),
            field({ label: 'Паспорт опекуна', input: repPass }),
        ),
    );

    // Searchable adult picker; on pick, mirror name into the required repName so
    // existing validation passes and the existing column is populated.
    baseWrap.appendChild(guardianFromBase((picked) => {
        state.guardian.guardianPatientId = picked ? picked.id : '';
        repName.value = picked ? (
            [picked.last_name, picked.first_name, picked.middle_name].filter(Boolean).join(' ').trim() || picked.full_name || ''
        ) : '';
        repPhone.value = picked ? (picked.phone || '') : '';
    }));

    const setMode = (m) => {
        state.guardian.mode = m;
        baseWrap.style.display = m === 'base' ? '' : 'none';
        newWrap.style.display  = m === 'new'  ? '' : 'none';
    };
    const modeToggle = h('div', { class: 'radio-chips' },
        modeChip('base', 'Выбрать из базы', () => state.guardian.mode, setMode),
        modeChip('new',  'Новый опекун',    () => state.guardian.mode, setMode),
    );

    setMode(state.guardian.mode);
    return h('div', null,
        legalRepHint, relHidden,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px', marginBottom: '12px' } },
            field({ label: 'Кем приходится', input: relSel }),
            field({ label: 'Режим', input: modeToggle, span: 2 }),
        ),
        baseWrap, newWrap,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px', marginTop: '12px' } },
            field({ label: 'Примечания', input: notes, span: 3 }),
        ),
    );
}
function modeChip(val, label, getter, setter) {
    const b = h('button', { type: 'button', class: 'radio-chip' + (getter() === val ? ' on' : ''),
        style: { flex: '1', justifyContent: 'center' },
        onclick: () => { setter(val); for (const sib of b.parentNode.children) sib.classList.toggle('on', sib === b); } },
        h('span', { class: 'rc-dot' }), ' ', label);
    return b;
}

// Searchable ADULT-patient picker — reuses the same 7-field ilike query as
// runPatientSearch, then filters to age >= 18. Stores guardian_patient_id.
function guardianFromBase(onPick) {
    const wrap = h('div', { class: 'grd-search-wrap' });
    const inp = h('input', { type: 'search', autocomplete: 'off', class: 'grd-search',
        placeholder: tr('Поиск опекуна по ФИО, ID или телефону…') });
    const icon = h('span', { class: 'grd-search-ic' }, Icon('Search', { size: 15 }));
    const results = h('div', { class: 'grd-results', style: { display: 'none' } });
    const picked = h('div', { class: 'grd-picked', style: { display: 'none' } });

    const clearPick = () => { onPick(null); picked.style.display = 'none'; wrap.querySelector('.grd-field').style.display = ''; };
    const showPicked = (p) => {
        onPick(p);
        const name = [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' ').trim() || p.full_name || '(без имени)';
        clear(picked);
        picked.append(
            h('div', { class: 'grd-picked-main' },
                h('div', { class: 'cell-strong' }, name),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } }, [p.mrn, p.phone].filter(Boolean).join(' · '))),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: clearPick }, 'Изменить'),
        );
        picked.style.display = ''; wrap.querySelector('.grd-field').style.display = 'none'; results.style.display = 'none';
    };

    const ageOf = (dob) => { if (!dob) return null; const d = new Date(dob); if (isNaN(d)) return null; const t = new Date(); let a = t.getFullYear() - d.getFullYear(); const m = t.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && t.getDate() < d.getDate())) a--; return a; };
    let timer = null;
    const run = async () => {
        const t = (inp.value || '').trim();
        if (t.length < 2) { results.style.display = 'none'; return; }
        const fields = ['full_name', 'last_name', 'first_name', 'middle_name', 'phone', 'mrn', 'national_id'];
        const cols = 'id, mrn, full_name, last_name, first_name, middle_name, phone, date_of_birth, national_id';
        const seen = new Set(); const rows = [];
        await Promise.all(fields.map(async (f) => {
            try {
                const { data } = await supabase.from('patients').select(cols).ilike(f, '%' + t + '%').limit(8);
                for (const r of (data || [])) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
            } catch { /* column missing — skip */ }
        }));
        const adults = rows.filter(r => { const a = ageOf(r.date_of_birth); return a == null || a >= 18; }).slice(0, 6);
        clear(results);
        if (!adults.length) {
            results.appendChild(h('div', { class: 'grd-empty' }, 'Не найдено. Заполните нового опекуна.'));
        } else {
            for (const p of adults) {
                const name = [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' ').trim() || p.full_name || '(без имени)';
                results.appendChild(h('button', { type: 'button', class: 'grd-opt', onclick: () => showPicked(p) },
                    h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { class: 'cell-strong' }, name),
                        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, [p.mrn, p.phone].filter(Boolean).join(' · '))),
                    Icon('Plus', { size: 13 })));
            }
        }
        results.style.display = '';
    };
    inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) results.style.display = 'none'; });

    wrap.append(
        h('div', { class: 'field grd-field' },
            h('label', null, 'Опекун из базы пациентов'),
            h('div', { class: 'grd-search-box' }, icon, inp, results)),
        picked,
    );
    return wrap;
}

// Write a patient_guardians row AFTER savePatient returns the patient id — only
// when a representative is mandatory (minor/senior). company_id fills via the
// table default current_user_company_id(); RLS is clinic-scoped. Swallow-with-log
// so a guardian write never blocks navigation (the patient is already saved).
async function persistGuardian(patient, payload) {
    if (!patient?.id) return;
    const age = computeAge(payload.date_of_birth);
    if (!needsLegalRep(age)) return;
    const g = state.guardian;
    const row = {
        patient_id:   patient.id,
        relationship: g.relationship || payload.legal_rep_relation || '',
        name:  payload.legal_representative || '',
        phone: payload.emergency_contact_phone || '',
    };
    if (g.mode === 'base' && g.guardianPatientId) row.guardian_patient_id = g.guardianPatientId;
    try {
        const { error } = await supabase.from('patient_guardians').insert(row);
        if (error) console.warn('[guardian] insert:', error.message);
    } catch (e) { console.warn('[guardian] insert threw:', e?.message || e); }
}
