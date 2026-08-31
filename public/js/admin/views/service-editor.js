// SERVICE_EDITOR_V1 — редактор услуги: опубликованный диалог «Своя услуга
// клиники», перестроенный для локальной системы. Дизайн:
// docs/plans/2026-08-31-service-editor-design.md.
//
// Два сознательных отличия от опубликованного образца (оба — решения владельца):
//   1. Исполнители отмечаются ДО первого сохранения. «Сначала сохраните услугу,
//      затем откройте её снова» было обходом чужого бэкенда, не фичей: здесь
//      один диалог, одно сохранение, и rpc service_save кладёт услугу,
//      созданные справочники и членство исполнителей одной транзакцией.
//   2. Один редактор везде: любое место, создающее услугу, открывает этот
//      диалог (сегодня это ровно одно место — sections.js services →
//      section-crud, см. openEditor).
//
// Все РЕШЕНИЯ (раздел→type, комбобокс выбрать-или-создать, кто врач, слияние
// ставок) живут в ../service-editor-logic.js и проверены тестом; здесь только
// рисование и один вызов RPC. Сервер перепроверяет всё сам: клиентские
// подсказки — вежливость, а не защита.
import { supabase } from '../../supabase.js';
import { h, Icon, toast, field, checkField } from '../ui.js';
import { trf } from '../i18n.js';
import {
    SERVICE_SECTIONS, labBlockVisible, resolveCombobox, splitPerformers,
    currentPerformerIds, performerGate, rpcErrorTemplate,
} from '../service-editor-logic.js';

// Тот же перечень пробирок, что вела старая generic-форма (sections.js,
// CLSI order of draw). Значения — то, что хранит services.tube_color и читает
// tubePill в laboratory.js; подписи — латиница медицинского обихода,
// намеренно без перевода (как и было).
const TUBE_OPTIONS = [
    ['',           '—'],
    ['light_blue', 'Light blue · Coagulation (PT/INR/PTT)'],
    ['red',        'Red · Serum chemistry, drug levels'],
    ['gold',       'Gold (SST) · Chemistry, serology, immuno'],
    ['green',      'Green · Plasma chemistry, ammonia'],
    ['lavender',   'Lavender · CBC, hematology, HbA1c'],
    ['pink',       'Pink · Blood bank, crossmatch'],
    ['grey',       'Grey · Glucose, lactate'],
    ['royal_blue', 'Royal blue · Heavy metals, trace'],
    ['yellow_acd', 'Yellow ACD · HLA, paternity, flow cyto'],
    ['black',      'Black · ESR'],
    ['none',       'No tube · Urine, stool, swab, saliva'],
];

// Комбобокс «выбери или впиши новую»: <input list=…> + <datalist>. Родной
// контрол браузера даёт и выпадающий список, и свободный ввод — ровно то, что
// нужно, без самодельного дропдауна. В списке — только активные строки;
// РАЗРЕШЕНИЕ набранного (выбор против создания) делает resolveCombobox по
// полному списку, и сервер повторяет его же правилом normName, так что
// совпадение с неактивной строкой — это выбор её, а не двойник.
let _dlSeq = 0;
function combo(labelText, rows, initialId) {
    const listId = 'svc-ed-dl-' + (++_dlSeq);
    const dl = h('datalist', { id: listId },
        ...rows.filter((r) => r.active !== 0 && r.active !== false)
            .map((r) => h('option', { value: r.name })));
    const initial = initialId != null ? (rows.find((r) => r.id === initialId) || null) : null;
    const inp = h('input', {
        type: 'text', list: listId,
        placeholder: 'Выберите или впишите новую…',
        value: initial ? initial.name : '',
    });
    const wrap = field(labelText, h('div', null, inp, dl));
    return { el: wrap, input: inp, resolve: () => resolveCombobox(inp.value, rows) };
}

const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

/**
 * Открыть редактор услуги.
 * @param {object} opts
 * @param {object|null} opts.row      строка services (редактирование) или null (создание)
 * @param {boolean}     opts.readOnly без права записи — всё выключено, кнопки «Сохранить» нет
 * @param {function}    opts.onSaved  вызывается после успешного сохранения
 */
export async function openServiceEditor({ row = null, readOnly = false, onSaved = null } = {}) {
    // ---- данные -----------------------------------------------------------
    let types, cats, deps, rooms, users;
    try {
        const [t, c, d, r, u] = await Promise.all([
            supabase.from('service_types').select('id, name, active').order('name'),
            supabase.from('service_categories').select('id, name, active').order('name'),
            supabase.from('departments').select('id, name, active').order('name'),
            supabase.from('rooms').select('id, name').eq('active', true).order('name'),
            // ВСЕ сотрудники, не только активные: у неактивного может быть
            // запись этой услуги в service_rates, и его галочка обязана
            // приехать в performers, иначе сохранение сняло бы его членство
            // молча (performers — авторитетный список).
            supabase.from('users').select('id, full_name, specialty, role, is_doctor, is_active, service_rates').order('full_name'),
        ]);
        for (const res of [t, c, d, r, u]) if (res.error) throw new Error(res.error.message);
        types = t.data || []; cats = c.data || []; deps = d.data || [];
        rooms = r.data || []; users = u.data || [];
    } catch (e) {
        console.warn('[service-editor] lookups:', e && e.message);
        toast('Не удалось загрузить справочники. Обновите страницу.', 'fail');
        return;
    }

    const picked = new Set(row && row.id ? currentPerformerIds(users, row.id) : []);
    const { doctors, others } = splitPerformers(users);

    // ---- левая колонка: что это -------------------------------------------
    const nameInp = h('input', { type: 'text', value: (row && row.name) || '' });
    const typeSel = h('select', null,
        ...SERVICE_SECTIONS.map((s) => h('option', {
            value: s.type, selected: (row ? row.type === s.type : s.type === 'consultation'),
        }, s.label)));
    const typeCombo = combo('Тип', types, row && row.type_id);
    const catCombo  = combo('Категория', cats, row && row.category_id);
    const depCombo  = combo('Отделение', deps, row && row.department_id);
    const roomSel = h('select', null,
        h('option', { value: '' }, '—'),
        ...rooms.map((r) => h('option', { value: String(r.id), selected: !!(row && row.room_id === r.id) }, r.name)));

    // Лабораторный блок — существующие колонки services, видим ТОЛЬКО при
    // разделе «лаборатория» (labBlockVisible). Скрытый блок сервер не пишет,
    // поэтому спрятанные значения не затираются.
    const specimenInp = h('input', { type: 'text', value: (row && row.specimen) || '' });
    const unitInp     = h('input', { type: 'text', value: (row && row.result_unit) || '' });
    const refLowInp   = h('input', { type: 'number', step: 'any', value: row && row.ref_low != null ? row.ref_low : '' });
    const refHighInp  = h('input', { type: 'number', step: 'any', value: row && row.ref_high != null ? row.ref_high : '' });
    const refTextInp  = h('input', { type: 'text', value: (row && row.ref_text) || '' });
    const tubeSel = h('select', null,
        ...TUBE_OPTIONS.map(([v, l]) => h('option', { value: v, selected: !!(row && (row.tube_color || '') === v) }, l)));
    const labBlock = h('div', null,
        field('Материал (кровь, моча…)', specimenInp),
        field('Единица результата', unitInp),
        h('div', { class: 'mg-grid' },
            field('Референс: от', refLowInp),
            field('Референс: до', refHighInp)),
        field('Референс (текст)', refTextInp),
        field('Цвет пробирки', tubeSel));

    const syncLab = () => { labBlock.style.display = labBlockVisible(typeSel.value) ? '' : 'none'; };
    typeSel.addEventListener('change', syncLab);
    syncLab();

    // ---- правая колонка: деньги и время -----------------------------------
    const priceInp = h('input', { type: 'number', step: '0.01', min: '0', value: row && row.price != null ? row.price : '' });
    const vatInp   = h('input', { type: 'number', step: '0.01', value: row && row.tax_rate != null ? row.tax_rate : 12 });
    const durInp   = h('input', { type: 'number', min: '1', value: row && row.duration_minutes != null ? row.duration_minutes : 30 });
    const reqDoc   = h('input', { type: 'checkbox' });
    reqDoc.checked = row ? !!row.requires_doctor : false;
    const pctInp   = h('input', { type: 'number', step: '0.01', min: '0', max: '100', value: row && row.default_doctor_percent != null ? row.default_doctor_percent : 0 });

    // ---- исполнители -------------------------------------------------------
    // «Врач» переключает СПИСОК между врачами и остальными; галочки живут в
    // общем наборе picked и переключение их НЕ сбрасывает — у услуги могут
    // быть и врачи, и медсёстры разом (опубликованный диалог терял отметки
    // при переключении; здесь это починено сознательно).
    const docChk = h('input', { type: 'checkbox' });
    docChk.checked = true;
    const staffBox = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '180px', overflowY: 'auto' } });
    function renderStaff() {
        staffBox.replaceChildren();
        // Неактивный сотрудник показывается только если уже отмечен: снять
        // его можно, наставить новых неактивных — незачем.
        const src = (docChk.checked ? doctors : others)
            .filter((u) => (u.is_active !== 0 && u.is_active !== false) || picked.has(u.id));
        if (!src.length) {
            staffBox.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                docChk.checked ? 'Нет врачей.' : 'Нет других сотрудников.'));
            return;
        }
        for (const u of src) {
            const cb = h('input', { type: 'checkbox', disabled: readOnly, onchange: (e) => {
                if (e.target.checked) picked.add(u.id); else picked.delete(u.id);
            } });
            cb.checked = picked.has(u.id);
            const sub = docChk.checked ? (u.specialty || '') : (u.role || '');
            staffBox.appendChild(h('label', { style: {
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                border: '1px solid var(--ink-200)', borderRadius: '8px',
                padding: '5px 9px', fontSize: '12.5px', cursor: 'pointer',
            } }, cb, u.full_name + (sub ? ' · ' + sub : '')));
        }
    }
    docChk.addEventListener('change', renderStaff);
    renderStaff();

    const performersSection = h('section', { class: 'mg-section span-full' },
        h('h3', null, 'Исполнители'),
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', padding: '0 0 10px', cursor: 'pointer' } },
            docChk, h('span', null, 'Врач'),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '(снимите — другие сотрудники)')),
        staffBox);
    // Блок виден только при «оказывает специалист» — как в опубликованном
    // диалоге. Скрытие НЕ очищает picked: члены остаются членами, пока их
    // не сняли явно (см. сборку performers при сохранении).
    const syncPerformers = () => { performersSection.style.display = reqDoc.checked ? '' : 'none'; };
    reqDoc.addEventListener('change', syncPerformers);
    syncPerformers();

    // ---- низ: код и статус -------------------------------------------------
    const codeInp = h('input', { type: 'text', value: (row && row.code) || '', style: { maxWidth: '220px' } });
    const activeChk = h('input', { type: 'checkbox' });
    activeChk.checked = row ? !!row.active : true;

    // ---- сборка ------------------------------------------------------------
    if (readOnly) {
        for (const el of [nameInp, typeSel, typeCombo.input, catCombo.input, depCombo.input, roomSel,
            specimenInp, unitInp, refLowInp, refHighInp, refTextInp, tubeSel,
            priceInp, vatInp, durInp, reqDoc, pctInp, docChk, codeInp, activeChk]) el.disabled = true;
    }

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();

    async function save(e) {
        const name = nameInp.value.trim();
        if (!name) { toast('Укажите название услуги.', 'warn'); nameInp.focus(); return; }
        const price = Number(priceInp.value);
        if (priceInp.value === '' || !Number.isFinite(price) || price < 0) {
            toast('Укажите цену услуги.', 'warn'); priceInp.focus(); return;
        }
        // performers — авторитетный СПИСОК ЧЛЕНСТВА: сервер добавит недостающих
        // и снимет неотмеченных. Отправляется и при выключенном «оказывает
        // специалист» — членство меняют галочки, а не видимость блока.
        const performers = [...picked];
        const gate = performerGate(reqDoc.checked, performers.length);
        if (!gate.ok) { toast(gate.error, 'warn'); return; }

        const args = {
            id: row && row.id != null ? row.id : undefined,
            name,
            type: typeSel.value,
            price,
            tax_rate: numOrNull(vatInp.value),
            duration_minutes: numOrNull(durInp.value),
            requires_doctor: reqDoc.checked,
            default_doctor_percent: numOrNull(pctInp.value) ?? 0,
            room_id: roomSel.value ? Number(roomSel.value) : null,
            code: codeInp.value.trim() || null,
            active: activeChk.checked,
            type_ref: typeCombo.resolve(),
            category_ref: catCombo.resolve(),
            department_ref: depCombo.resolve(),
            performers,
        };
        if (labBlockVisible(typeSel.value)) {
            args.lab = {
                specimen: specimenInp.value.trim() || null,
                result_unit: unitInp.value.trim() || null,
                ref_low: numOrNull(refLowInp.value),
                ref_high: numOrNull(refHighInp.value),
                ref_text: refTextInp.value.trim() || null,
                tube_color: tubeSel.value || null,
            };
        }

        e.target.disabled = true;
        try {
            const { error } = await supabase.rpc('service_save', args);
            if (error) {
                // Ошибка с динамикой (имя/id в тексте) переводится по коду:
                // шаблон из словаря, значения — после перевода. Без кода —
                // message как есть (toast сам прогонит его через tr()).
                const known = rpcErrorTemplate(error);
                throw new Error(known ? trf(known.template, known.params) : (error.message || String(error)));
            }
            toast('Услуга сохранена.');
            close();
            if (onSaved) await onSaved();
        } catch (err) {
            toast(err.message || String(err), 'fail');
        } finally { e.target.disabled = false; }
    }

    const card = h('div', { class: 'modal-card modal-grouped has-groups' },
        h('header', { class: 'modal-head' },
            h('h2', null, readOnly ? 'Просмотр услуги' : (row ? 'Изменить услугу' : 'Новая услуга')),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('section', { class: 'mg-section' },
                h('h3', null, 'Основное'),
                field('Название', nameInp, { required: true }),
                field('Раздел — куда попадает услуга (маршрутизация)', typeSel),
                typeCombo.el,
                catCombo.el,
                depCombo.el,
                field('Кабинет (очередь диагностики)', roomSel),
                labBlock),
            h('section', { class: 'mg-section' },
                h('h3', null, 'Цена, налог и длительность'),
                field('Цена', priceInp, { required: true }),
                field('НДС (%)', vatInp),
                field('Длительность (мин)', durInp),
                checkField('Услугу оказывает специалист (врач / медсестра)', reqDoc),
                field('Доля исполнителя по умолчанию, %', pctInp)),
            performersSection,
            h('section', { class: 'mg-section span-full' },
                h('div', { class: 'mg-grid' },
                    field('Внутренний код (необязательно)', codeInp),
                    checkField('Активна', activeChk)))),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: close }, readOnly ? 'Закрыть' : 'Отмена'),
            !readOnly && h('button', { class: 'btn btn-primary', onclick: save },
                Icon('Check', { size: 14 }), ' Сохранить')));

    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => nameInp.focus(), 30);
}
