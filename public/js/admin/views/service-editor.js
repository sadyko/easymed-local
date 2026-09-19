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
import { tr, trf } from '../i18n.js';
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
    const wrap = field(labelText, h('div', { class: 'svc-ed-combo' }, inp, dl));   // SERVICE_EDITOR_V2 — fills its column
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

    // SERVICE_EDITOR_V2 (2026-09-15) — the dialog rebuilt to the owner's
    // reference after the list («i guess its a little bit messy. please make
    // something like in the services list»): a header with the service's name
    // and its section, a rail of tabs on the left (Основное · Цены ·
    // Исполнители · Лаборатория), short labels with units in the label,
    // fields that share the width, and the visit-tier prices as two small
    // cards (second visit / repeat visit) instead of six long-named fields.
    // Same controls, same save — only the arrangement changed.

    // ---- основное ----------------------------------------------------------
    const nameInp = h('input', { type: 'text', value: (row && row.name) || '', placeholder: 'напр. Приём кардиолога' });
    // SERVICE_NAMES_ONLINE_V1 — название на узбекском и английском и флаг
    // «доступна для онлайн-записи» (только параметр). Включённая онлайн-запись
    // требует названий на русском и узбекском; английское — по желанию.
    const nameUzInp = h('input', { type: 'text', value: (row && row.name_uz) || '', placeholder: 'masalan, Kardiolog qabuli' });
    const nameEnInp = h('input', { type: 'text', value: (row && row.name_en) || '', placeholder: 'e.g. Cardiologist visit' });
    const onlineChk = h('input', { type: 'checkbox' });
    onlineChk.checked = row ? !!row.online_booking : false;
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
    const codeInp = h('input', { type: 'text', value: (row && row.code) || '', placeholder: 'необязательно' });
    const activeChk = h('input', { type: 'checkbox' });
    activeChk.checked = row ? !!row.active : true;

    // Лабораторный блок — существующие колонки services, видим ТОЛЬКО при
    // разделе «лаборатория» (labBlockVisible). Скрытый блок сервер не пишет,
    // поэтому спрятанные значения не затираются.
    // LAB_REFS_IN_PANELS_V1 — здесь остаётся только то, что относится к
    // ЗАБОРУ: материал и пробирка. Единицы и нормы отсюда убраны (владелец:
    // «this type of settings should be handled in labs/panels»), и правильно:
    // у услуги ОДНА единица и ОДИН диапазон, а у анализа их столько, сколько
    // показателей — у общего анализа крови около двадцати, у каждого своя
    // единица, свой диапазон и свои нормы для мужчин и женщин. Всё это живёт
    // в панели (Лаборатория → Панели), и бланк печатается по ней
    // (LAB_PANEL_IS_TRUTH_V1). Поле «одна норма на услугу» лишь путало: его
    // заполняли, а на бланк оно не попадало.
    //
    // Колонки services.result_unit/ref_* НЕ удалены и НЕ затираются: у услуги
    // без панели ввод результата всё ещё падает на них (laboratory.js), поэтому
    // при сохранении отправляем то, что уже лежит в строке, — без изменений.
    const specimenInp = h('input', { type: 'text', value: (row && row.specimen) || '' });
    const tubeSel = h('select', null,
        ...TUBE_OPTIONS.map(([v, l]) => h('option', { value: v, selected: !!(row && (row.tube_color || '') === v) }, l)));

    // ---- цены и время ------------------------------------------------------
    const priceInp = h('input', { type: 'number', step: '0.01', min: '0', value: row && row.price != null ? row.price : '' });
    const vatInp   = h('input', { type: 'number', step: '0.01', value: row && row.tax_rate != null ? row.tax_rate : 12 });
    const durInp   = h('input', { type: 'number', min: '1', value: row && row.duration_minutes != null ? row.duration_minutes : 30 });
    const reqDoc   = h('input', { type: 'checkbox' });
    reqDoc.checked = row ? !!row.requires_doctor : false;
    const pctInp   = h('input', { type: 'number', step: '0.01', min: '0', max: '100', value: row && row.default_doctor_percent != null ? row.default_doctor_percent : 0 });
    // DOCTOR_TIER_V1 — ступень доли по объёму (владелец: «more than 25 → 40 %»).
    // Пара полей; пустые — ступени нет. Правило и нумерацию считает сервер
    // (rpc/reports.js TIER_RANK_SQL); здесь только ввод.
    const tierFromInp = h('input', { type: 'number', step: '1', min: '0', value: row && row.doctor_tier_from ? row.doctor_tier_from : '', placeholder: '0 — нет' });
    const tierPctInp  = h('input', { type: 'number', step: '0.01', min: '0', max: '100', value: row && row.doctor_tier_percent ? row.doctor_tier_percent : '', placeholder: 'напр. 40' });

    // VISIT_TIER_PRICING_V1 — цена по счёту визита (владелец: «for the primary
    // visit, secondary, repeat visit and set dates between the first and
    // second»). Все поля необязательны: пустые — услуга с одной ценой.
    // Правило считает сервер (domain/visit-tier.js); здесь только ввод.
    const secPriceInp = h('input', { type: 'number', step: '0.01', min: '0', value: row && row.price_secondary != null ? row.price_secondary : '', placeholder: 'как первый' });
    const daysFromInp = h('input', { type: 'number', step: '1', min: '0', value: row && row.secondary_days_from != null ? row.secondary_days_from : '', placeholder: '1' });
    const daysToInp   = h('input', { type: 'number', step: '1', min: '0', value: row && row.secondary_days_to != null ? row.secondary_days_to : '', placeholder: 'без предела' });
    const repPriceInp = h('input', { type: 'number', step: '0.01', min: '0', value: row && row.price_repeat != null ? row.price_repeat : '', placeholder: 'как второй' });
    // REPEAT_WINDOW_V1 — своё окно дней у повторного визита (владелец: «repeat
    // days, it should have the range too»); оба пустые — как у второго.
    const repFromInp = h('input', { type: 'number', step: '1', min: '0', value: row && row.repeat_days_from != null ? row.repeat_days_from : '', placeholder: 'как у 2-го' });
    const repToInp   = h('input', { type: 'number', step: '1', min: '0', value: row && row.repeat_days_to != null ? row.repeat_days_to : '', placeholder: 'как у 2-го' });

    // ---- исполнители -------------------------------------------------------
    // Переключатель «Врачи | Другие сотрудники» меняет СПИСОК; галочки живут
    // в общем наборе picked и переключение их НЕ сбрасывает — у услуги могут
    // быть и врачи, и медсёстры разом. Поиск по имени — список на тридцать
    // врачей иначе листается.
    let staffMode = 'doctors';
    const staffSearch = h('input', { type: 'search', placeholder: 'Найти по имени…', class: 'svc-ed-staff-search',
        oninput: () => renderStaff() });
    const staffCount = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    const staffBox = h('div', { class: 'svc-ed-staff' });
    const staffSeg = {};
    const staffSegment = h('div', { class: 'segmented' },
        ...[['doctors', 'Врачи'], ['others', 'Другие сотрудники']].map(([k, label]) => (staffSeg[k] = h('button', {
            type: 'button', class: k === staffMode ? 'on' : '',
            onclick: () => { staffMode = k; for (const [kk, b] of Object.entries(staffSeg)) b.className = kk === k ? 'on' : ''; renderStaff(); },
        }, label))));
    function renderStaff() {
        staffBox.replaceChildren();
        const q = staffSearch.value.trim().toLowerCase();
        // Неактивный сотрудник показывается только если уже отмечен: снять
        // его можно, наставить новых неактивных — незачем.
        const src = (staffMode === 'doctors' ? doctors : others)
            .filter((u) => (u.is_active !== 0 && u.is_active !== false) || picked.has(u.id))
            .filter((u) => !q || String(u.full_name || '').toLowerCase().includes(q));
        staffCount.textContent = trf('Отмечено: {n}', { n: picked.size });
        if (!src.length) {
            staffBox.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                q ? 'Никого с таким именем.' : (staffMode === 'doctors' ? 'Нет врачей.' : 'Нет других сотрудников.')));
            return;
        }
        for (const u of src) {
            const cb = h('input', { type: 'checkbox', disabled: readOnly, onchange: (e) => {
                if (e.target.checked) picked.add(u.id); else picked.delete(u.id);
                staffCount.textContent = trf('Отмечено: {n}', { n: picked.size });
                e.target.closest('label').className = 'svc-ed-chip' + (e.target.checked ? ' on' : '');
            } });
            cb.checked = picked.has(u.id);
            const sub = staffMode === 'doctors' ? (u.specialty || '') : (u.role || '');
            staffBox.appendChild(h('label', { class: 'svc-ed-chip' + (cb.checked ? ' on' : '') },
                cb, h('span', null, u.full_name), sub ? h('span', { class: 'muted' }, ' · ' + sub) : null));
        }
    }
    renderStaff();

    if (readOnly) {
        for (const el of [nameInp, typeSel, typeCombo.input, catCombo.input, depCombo.input, roomSel,
            specimenInp, tubeSel,   // LAB_REFS_IN_PANELS_V1 — единицы и нормы живут в панели
            priceInp, vatInp, durInp, reqDoc, pctInp, codeInp, activeChk, nameUzInp, nameEnInp, onlineChk,
            secPriceInp, daysFromInp, daysToInp, repPriceInp, repFromInp, repToInp,
            tierFromInp, tierPctInp]) el.disabled = true;   // DOCTOR_TIER_V1
    }

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();

    async function save(e) {
        const name = nameInp.value.trim();
        if (!name) { toast('Укажите название услуги.', 'warn'); goTo('main', nameInp); return; }
        // SERVICE_NAMES_ONLINE_V1 — the server refuses this too; the check here
        // only puts the cursor where the missing word goes.
        if (onlineChk.checked && !nameUzInp.value.trim()) {
            toast('Для онлайн-записи заполните название на русском и узбекском.', 'warn'); goTo('main', nameUzInp); return;
        }
        const price = Number(priceInp.value);
        if (priceInp.value === '' || !Number.isFinite(price) || price < 0) {
            toast('Укажите цену услуги.', 'warn'); goTo('price', priceInp); return;
        }
        // DOCTOR_TIER_V1 — ступень задаётся парой; сервер откажет 400, а здесь
        // курсор сразу встаёт в незаполненное поле (rpc/service-save.js).
        const tFrom = Number(tierFromInp.value) > 0, tPct = Number(tierPctInp.value) > 0;
        if (tFrom !== tPct) {
            toast('Ступень задаётся парой: порог услуг в месяц И доля выше порога.', 'warn');
            goTo('price', tFrom ? tierPctInp : tierFromInp); return;
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
            doctor_tier_from: numOrNull(tierFromInp.value) ?? 0,      // DOCTOR_TIER_V1
            doctor_tier_percent: numOrNull(tierPctInp.value) ?? 0,
            room_id: roomSel.value ? Number(roomSel.value) : null,
            // VISIT_TIER_PRICING_V1 — пустое поле уходит как null (не 0): сервер
            // отличает «не задано» от «бесплатно».
            price_secondary: numOrNull(secPriceInp.value),
            secondary_days_from: numOrNull(daysFromInp.value),
            secondary_days_to: numOrNull(daysToInp.value),
            price_repeat: numOrNull(repPriceInp.value),
            repeat_days_from: numOrNull(repFromInp.value),
            repeat_days_to: numOrNull(repToInp.value),
            code: codeInp.value.trim() || null,
            active: activeChk.checked,
            name_uz: nameUzInp.value.trim() || null,
            name_en: nameEnInp.value.trim() || null,
            online_booking: onlineChk.checked,
            type_ref: typeCombo.resolve(),
            category_ref: catCombo.resolve(),
            department_ref: depCombo.resolve(),
            performers,
        };
        if (labBlockVisible(typeSel.value)) {
            args.lab = {
                specimen: specimenInp.value.trim() || null,
                tube_color: tubeSel.value || null,
                // Прежние значения — как есть: их правят в панели, а не здесь.
                result_unit: (row && row.result_unit) || null,
                ref_low: row && row.ref_low != null ? row.ref_low : null,
                ref_high: row && row.ref_high != null ? row.ref_high : null,
                ref_text: (row && row.ref_text) || null,
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

    // ---- сборка: шапка · рельс вкладок · содержимое · подвал --------------
    const sectionLabel = () => (SERVICE_SECTIONS.find((x) => x.type === typeSel.value) || {}).label || '';
    const headName = h('div', { class: 'svc-ed-name' }, '');
    const headSub  = h('div', { class: 'svc-ed-sub' }, '');
    const paintHead = () => {
        headName.textContent = nameInp.value.trim() || tr(row ? 'Без названия' : 'Новая услуга');
        headSub.textContent = [tr(sectionLabel()), codeInp.value.trim()].filter(Boolean).join(' · ');
    };
    nameInp.addEventListener('input', paintHead);
    codeInp.addEventListener('input', paintHead);

    const grp = (title, ...kids) => h('section', { class: 'svc-ed-grp' }, h('h3', null, title), ...kids);
    const grid = (cols, ...kids) => h('div', { class: 'svc-ed-grid cols-' + cols }, ...kids);
    const unitField = (label, inp, unit) => field(label, h('div', { class: 'svc-ed-unit' }, inp, h('span', null, unit)));

    const labGroup = grp('Забор материала',
        grid(2,
            field('Материал (кровь, моча…)', specimenInp),
            field('Цвет пробирки', tubeSel)),
        h('div', { class: 'svc-ed-note' }, 'Показатели, единицы и нормы задаются в панели анализа: Лаборатория → Панели.'));

    // The uz name is required only while online booking is on: the label
    // gets its star and the field its highlight the moment the box is ticked.
    const uzField = field('Название (UZ)', nameUzInp);
    const uzStar = h('span', { class: 'req' }, ' *');
    const syncOnline = () => {
        const on = onlineChk.checked;
        if (on && !uzStar.parentNode) uzField.firstChild.appendChild(uzStar);
        if (!on && uzStar.parentNode) uzStar.remove();
        uzField.className = 'field' + (on && !nameUzInp.value.trim() ? ' svc-ed-need' : '');
    };
    onlineChk.addEventListener('change', syncOnline);
    nameUzInp.addEventListener('input', syncOnline);
    syncOnline();

    const panels = {
        main: h('div', { class: 'svc-ed-panel' },
            grp('Наименование',
                field('Название (RU)', nameInp, { required: true }),
                grid(2,
                    uzField,
                    field('Название (EN)', nameEnInp)),
                h('div', { class: 'svc-ed-online' },
                    checkField('Доступна для онлайн-записи', onlineChk),
                    h('div', { class: 'svc-ed-note' }, 'Пока только параметр. Для онлайн-записи нужны названия на русском и узбекском — без них сохранить с включённой галочкой нельзя.'))),
            grp('Классификация',
                grid(2,
                    field('Группа — одна из пяти, задаёт маршрут', typeSel),   // SVC_VOCAB_V1
                    typeCombo.el,
                    catCombo.el,
                    depCombo.el,
                    field('Кабинет (очередь диагностики)', roomSel),
                    field('Внутренний код', codeInp)),
                checkField('Активна — видна в списках выбора', activeChk))),
        price: h('div', { class: 'svc-ed-panel' },
            grp('Цена и время',
                grid(3,
                    field('Цена', priceInp, { required: true }),
                    unitField('НДС', vatInp, '%'),
                    unitField('Длительность', durInp, 'мин')),
                grid(2,
                    checkField('Услугу оказывает специалист (врач / медсестра)', reqDoc),
                    unitField('Доля исполнителя по умолчанию', pctInp, '%')),
                h('div', { class: 'svc-ed-note' }, 'Ступень по объёму: начиная со следующей после порога услуги в календарном месяце доля исполнителя — не ниже указанной. Пусто — ступени нет.'),
                grid(2,
                    unitField('Порог, услуг в месяц', tierFromInp, 'шт.'),
                    unitField('Доля выше порога', tierPctInp, '%'))),
            grp('Цена по счёту визита',
                h('div', { class: 'svc-ed-note' }, 'Необязательно. Окно дней считается от предыдущего визита по этой же услуге; пришёл позже окна — снова первый визит. «Не раньше чем через 0» — второй визит в тот же день тоже считается.'),
                grid(2,
                    h('div', { class: 'svc-ed-tier' },
                        h('h4', null, 'Второй визит'),
                        field('Цена', secPriceInp),
                        grid(2,
                            unitField('Не раньше чем через', daysFromInp, 'дн.'),
                            unitField('Не позже чем через', daysToInp, 'дн.'))),
                    h('div', { class: 'svc-ed-tier' },
                        h('h4', null, 'Повторный визит — третий и далее'),
                        field('Цена (0 — бесплатно)', repPriceInp),
                        grid(2,
                            unitField('Не раньше чем через', repFromInp, 'дн.'),
                            unitField('Не позже чем через', repToInp, 'дн.')))))),
        staff: h('div', { class: 'svc-ed-panel' },
            grp('Кто выполняет услугу',
                h('div', { class: 'svc-ed-staff-bar' }, staffSegment, staffSearch, staffCount),
                staffBox)),
        lab: h('div', { class: 'svc-ed-panel' }, labGroup),
    };

    // Рельс. «Исполнители» — только когда услугу оказывает специалист (как и
    // раньше: блок был скрыт), «Лаборатория» — только у раздела лаборатории.
    // Скрытие НЕ очищает отмеченных: члены остаются членами, пока их не сняли.
    const TABS = [
        ['main',  'Основное',     'Doc'],
        ['price', 'Цены',         'Coins'],
        ['staff', 'Исполнители',  'User'],
        ['lab',   'Лаборатория',  'Flask'],
    ];
    let tab = 'main';
    const railBtns = {};
    const tabVisible = (k) => (k === 'staff' ? reqDoc.checked : k === 'lab' ? labBlockVisible(typeSel.value) : true);
    const showTab = (k) => {
        tab = k;
        for (const [kk, b] of Object.entries(railBtns)) b.className = 'svc-ed-tab' + (kk === k ? ' on' : '');
        for (const [kk, p] of Object.entries(panels)) p.style.display = kk === k ? '' : 'none';
    };
    const rail = h('aside', { class: 'svc-ed-rail' },
        ...TABS.map(([k, label, ic]) => (railBtns[k] = h('button', { type: 'button', class: 'svc-ed-tab', onclick: () => showTab(k) },
            Icon(ic, { size: 15 }), h('span', null, label)))));
    const syncRail = () => {
        for (const [k] of TABS) railBtns[k].style.display = tabVisible(k) ? '' : 'none';
        if (!tabVisible(tab)) showTab('main');
    };
    typeSel.addEventListener('change', () => { syncRail(); paintHead(); });
    reqDoc.addEventListener('change', syncRail);
    syncRail();
    showTab('main');
    paintHead();

    // Проверка перед сохранением ведёт на вкладку с пустым обязательным полем.
    const goTo = (k, inp) => { showTab(k); setTimeout(() => inp.focus(), 0); };

    const card = h('div', { class: 'modal-card svc-ed' },
        h('header', { class: 'modal-head svc-ed-head' },
            h('span', { class: 'svc-ed-ic' }, Icon('Receipt', { size: 20 })),
            h('div', { class: 'svc-ed-title' },
                h('h2', null, readOnly ? 'Просмотр услуги' : (row ? 'Изменить услугу' : 'Новая услуга')),
                headName, headSub),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body svc-ed-body' },
            rail,
            h('div', { class: 'svc-ed-cont' }, ...Object.values(panels))),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: close }, readOnly ? 'Закрыть' : 'Отмена'),
            !readOnly && h('button', { class: 'btn btn-primary', onclick: save },
                Icon('Check', { size: 14 }), ' Сохранить')));

    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => nameInp.focus(), 30);
}
