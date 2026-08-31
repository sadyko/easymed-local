// ROOMS_SETUP_V1 — «Помещения»: одно место, где заводятся кабинеты и палаты.
//
// До этого раздела помещения клиники были размазаны по ЧЕТЫРЁМ разделам
// настроек в ДВУХ группах: Floors и Rooms в «Rooms & floors», Wards и Beds в
// «Inpatient». Чтобы открыть стационар на шесть коек, администратор заводил
// палату в одном разделе, уходил в другой и создавал шесть коек по одной,
// руками повторяя номер и цену. Ошибиться было легче, чем сделать правильно.
//
// Здесь то же самое — одним диалогом: тип → название → (для стационара) число
// коек и цена. Койки создаются пачкой, тип и нумерация наследуются от палаты.
//
// СХЕМУ НЕ МЕНЯЕМ. Кабинет остаётся строкой rooms, палата — строкой wards со
// своими beds: на wards завязаны admissions, admission_transfers и биллинг
// проживания, и сливать таблицы ради одного экрана значит переписывать
// стационар целиком. Объединение здесь на уровне ИНТЕРФЕЙСА: раздел читает обе
// таблицы и пишет в ту, которая соответствует выбранному типу. Старые разделы
// продолжают работать и остаются как «продвинутый» доступ к тем же строкам.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, PageHead } from '../ui.js';
import { soleBranchId, getSelectedBranchIds } from '../branch-context.js?v=bc3';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ

// Типы из постановки владельца. outpatient → rooms.room_type,
// stationary → wards.type. Значения берём ТОЛЬКО из тех, что уже разрешены в
// sections.js, чтобы старые разделы, фильтры и отчёты продолжали понимать
// данные без миграции.
const TYPES = [
    { key: 'consultation', kind: 'room', label: tr('Консультация'),     icon: 'Stethoscope', hint: tr('Кабинет приёма') },
    { key: 'diagnostics',  kind: 'room', label: tr('Диагностика'),      icon: 'Activity',    hint: tr('УЗИ, ЭКГ, рентген') },
    { key: 'lab',          kind: 'room', label: tr('Лаборатория'),      icon: 'Flask',       hint: tr('Окно забора') },
    { key: 'procedure',    kind: 'room', label: tr('Процедурная'),      icon: 'Plus',        hint: tr('Уколы, капельницы') },
    { key: 'surgery',      kind: 'room', label: tr('Операционная'),     icon: 'Pulse',       hint: tr('Операции') },
    { key: 'general',      kind: 'ward', label: tr('Палата (общая)'),   icon: 'Bed',         hint: tr('Стационар') },
    { key: 'icu',          kind: 'ward', label: tr('ПИТ / реанимация'), icon: 'Heart',       hint: tr('Интенсивная терапия') },
    { key: 'isolation',    kind: 'ward', label: tr('Изолятор'),         icon: 'Shield',      hint: tr('Инфекционный бокс') },
    { key: 'vip',          kind: 'ward', label: tr('VIP'),              icon: 'Sparkles',    hint: tr('Повышенной комфортности') },
    { key: 'maternity',    kind: 'ward', label: tr('Родильная'),        icon: 'Heart',       hint: tr('Роды и послеродовые') },
    { key: 'pediatrics',   kind: 'ward', label: tr('Детская'),          icon: 'Patients',    hint: tr('Детский стационар') },
];
const TYPE_BY_KEY = Object.fromEntries(TYPES.map(t => [t.key, t]));

// wards.type не знает значения 'vip' — VIP это свойство КОЙКИ (beds.type),
// а палата остаётся 'other'. Пишем только разрешённые значения.
const WARD_TYPE_FALLBACK = { vip: 'other' };
function wardTypeFor(key) { return WARD_TYPE_FALLBACK[key] || key; }
function bedTypeFor(key) {
    if (key === 'icu') return 'icu';
    if (key === 'isolation') return 'isolation';
    if (key === 'vip') return 'vip';
    return 'standard';
}

const state = { floors: [], depts: [], rooms: [], wards: [], bedsByWard: {} };
let containerRef = null;

export async function renderRoomsSetup(container) {
    containerRef = container;
    clear(container);
    container.appendChild(h('div', { class: 'empty' }, tr('Загрузка…')));
    try {
        await load();
    } catch (e) {
        clear(container);
        container.appendChild(h('div', { class: 'card', style: { padding: '20px' } },
            h('div', { class: 'empty' }, trf('Не удалось загрузить помещения: {msg}', { msg: (e && e.message) || e }))));
        return;
    }
    paint();
}

async function load() {
    const [fl, dp, rm, wd, bd] = await Promise.all([
        supabase.from('floors').select('id, name, level, branch_id, active').order('level', { ascending: true }),
        supabase.from('departments').select('id, name, floor_id, kind').order('name', { ascending: true }),
        supabase.from('rooms').select('id, name, code, room_type, capacity, department_id, floor_id, active').order('name', { ascending: true }),
        supabase.from('wards').select('id, name, code, type, floor_id, branch_id, billing_mode, price_per_hour, price_per_day, active').order('name', { ascending: true }),
        supabase.from('beds').select('id, ward_id, code, type, status, active').limit(5000),
    ]);
    state.floors = fl.data || [];
    state.depts = dp.data || [];
    state.rooms = rm.data || [];
    state.wards = wd.data || [];
    state.bedsByWard = {};
    for (const b of (bd.data || [])) {
        (state.bedsByWard[b.ward_id] = state.bedsByWard[b.ward_id] || []).push(b);
    }
}

function money(n) {
    const v = Number(n) || 0;
    return v ? trf('{n} сум', { n: v.toLocaleString('ru-RU') }) : '—';
}

function floorName(id) {
    const f = state.floors.find(x => String(x.id) === String(id));
    return f ? f.name : null;
}

// -----------------------------------------------------------------------------
// Список
// -----------------------------------------------------------------------------
function paint() {
    clear(containerRef);

    const rows = [
        ...state.rooms.map(r => ({
            kind: 'room', id: r.id, name: r.name, code: r.code, type: r.room_type,
            floor_id: r.floor_id, active: r.active !== false, raw: r,
            meta: (state.depts.find(d => String(d.id) === String(r.department_id)) || {}).name || '—',
            price: '—',
        })),
        ...state.wards.map(w => {
            const beds = (state.bedsByWard[w.id] || []).length;
            return {
                kind: 'ward', id: w.id, name: w.name, code: w.code, type: w.type,
                floor_id: w.floor_id, active: w.active !== false, raw: w,
                meta: trf('коек: {n}', { n: beds }),
                price: w.billing_mode === 'daily'
                    ? trf('{price} / сут', { price: money(w.price_per_day) })
                    : trf('{price} / час', { price: money(w.price_per_hour) }),
            };
        }),
    ];

    const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });

    if (!rows.length) {
        body.appendChild(h('div', { class: 'card', style: { padding: '28px', textAlign: 'center' } },
            h('div', { class: 'muted' }, tr('Помещений пока нет. Начните с кабинета приёма или палаты.'))));
    }

    const byFloor = new Map();
    for (const r of rows) {
        const key = r.floor_id == null ? '' : String(r.floor_id);
        if (!byFloor.has(key)) byFloor.set(key, []);
        byFloor.get(key).push(r);
    }
    const order = [...byFloor.keys()].sort((a, b) => {
        const fa = state.floors.find(f => String(f.id) === a);
        const fb = state.floors.find(f => String(f.id) === b);
        const la = fa && fa.level != null ? fa.level : 999;
        const lb = fb && fb.level != null ? fb.level : 999;
        return la - lb;
    });

    for (const key of order) {
        body.appendChild(h('div', { class: 'card rs-card' },
            h('div', { class: 'rs-floor' }, floorName(key) || tr('Этаж не указан')),
            h('div', { class: 'rs-tbl' },
                h('div', { class: 'rs-row rs-row--head' },
                    h('span', { class: 'rs-name' }, tr('Название')),
                    h('span', { class: 'rs-type' }, tr('Тип')),
                    h('span', { class: 'rs-meta' }, tr('Отдел / койки')),
                    h('span', { class: 'rs-price' }, tr('Проживание')),
                    h('span', { class: 'rs-act' }, ''),
                ),
                ...byFloor.get(key).map(rowEl),
            )));
    }

    containerRef.appendChild(h('div', { class: 'fade-in' },
        PageHead({
            title: tr('Помещения'),
            subtitle: tr('Кабинеты и палаты клиники в одном разделе. Палата заводится вместе с койками и ценой — одним окном.'),
            right: h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: openWizard },
                Icon('Plus', { size: 14 }), ' ', tr('Добавить помещение')),
        }),
        body,
    ));
}

function rowEl(r) {
    const t = TYPE_BY_KEY[r.type] || {};
    return h('div', { class: 'rs-row' },
        h('span', { class: 'rs-name', title: r.name || '' },
            r.name || '—',
            r.code ? h('span', { class: 'muted', style: { fontWeight: '400' } }, ' · ' + r.code) : null,
            r.active ? null : h('span', { class: 'muted', style: { fontWeight: '400' } }, ' · ', tr('выключено'))),
        h('span', { class: 'rs-type' }, Tag(t.label || r.type || '—', { kind: r.kind === 'ward' ? 'warn' : '' })),
        h('span', { class: 'rs-meta muted' }, r.meta || '—'),
        h('span', { class: 'rs-price' }, r.price || '—'),
        h('span', { class: 'rs-act' },
            r.kind === 'ward'
                ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openAddBeds(r.raw) }, tr('Койки'))
                : null),
    );
}

// -----------------------------------------------------------------------------
// Диалог
// -----------------------------------------------------------------------------
function modalShell(title) {
    const overlay = h('div', { class: 'modal' });
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const bodyEl = h('div', { style: { padding: '18px 20px', overflow: 'auto' } });
    const footEl = h('div', { style: { padding: '14px 20px', borderTop: '1px solid var(--ink-100)', display: 'flex', justifyContent: 'flex-end', gap: '10px' } });
    overlay.appendChild(h('div', {
        class: 'modal-card',
        style: { width: '560px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column' },
    },
        h('div', { style: { padding: '16px 20px', borderBottom: '1px solid var(--ink-100)', fontWeight: '700', fontSize: '15px' } }, title),
        bodyEl, footEl));
    document.body.appendChild(overlay);
    return { overlay, bodyEl, footEl, close };
}

function openWizard() {
    const m = modalShell(tr('Новое помещение'));
    const draft = {
        type: null, name: '', code: '', department_id: '', floor_id: '',
        beds: 4, billing_mode: 'daily', price: 0,
    };

    function step1() {
        clear(m.bodyEl); clear(m.footEl);
        m.bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px', marginBottom: '12px' } },
            tr('Шаг 1 из 2 — что это за помещение?')));
        const grid = h('div', { class: 'rs-typegrid' });
        for (const t of TYPES) {
            grid.appendChild(h('button', {
                class: 'rs-type-card' + (draft.type === t.key ? ' is-on' : ''),
                type: 'button',
                onclick: () => { draft.type = t.key; step2(); },
            },
                h('span', { class: 'rs-type-ic' }, Icon(t.icon, { size: 17 })),
                h('span', { style: { minWidth: '0' } },
                    h('span', { class: 'rs-type-lb' }, t.label),
                    h('span', { class: 'rs-type-hint muted' }, t.hint)),
            ));
        }
        m.bodyEl.appendChild(grid);
        m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: m.close }, tr('Отмена')));
    }

    function step2() {
        const t = TYPE_BY_KEY[draft.type];
        const isWard = t.kind === 'ward';
        clear(m.bodyEl); clear(m.footEl);
        m.bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px', marginBottom: '12px' } },
            trf('Шаг 2 из 2 — {type}', { type: t.label.toLowerCase() })));

        m.bodyEl.appendChild(field(tr('Название'),
            h('input', {
                class: 'inp', value: draft.name,
                placeholder: isWard ? tr('Палата №3') : tr('Кабинет 201'),
                oninput: (e) => { draft.name = e.target.value; },
            }), { required: true }));

        m.bodyEl.appendChild(field(isWard ? tr('Код палаты (необязательно)') : tr('Номер двери (необязательно)'),
            h('input', {
                class: 'inp', value: draft.code,
                placeholder: isWard ? 'W3' : '201',
                oninput: (e) => { draft.code = e.target.value; },
            })));

        if (isWard) {
            m.bodyEl.appendChild(field(tr('Этаж'),
                h('select', { class: 'inp', onchange: (e) => { draft.floor_id = e.target.value; } },
                    h('option', { value: '' }, tr('— этаж не указан —')),
                    ...state.floors.map(f => h('option', {
                        value: String(f.id), selected: String(draft.floor_id) === String(f.id),
                    }, f.name)))));

            m.bodyEl.appendChild(field(tr('Сколько коек создать'),
                h('input', {
                    class: 'inp', type: 'number', min: '0', max: '200', value: String(draft.beds),
                    oninput: (e) => { draft.beds = e.target.value; },
                }),
                { hint: tr('Койки пронумеруются автоматически: 1, 2, 3… Позже можно добавить ещё кнопкой «Койки».') }));

            const priceFld = field(tr('Цена за сутки, сум'),
                h('input', {
                    class: 'inp', type: 'number', min: '0', step: '1000', value: String(draft.price),
                    oninput: (e) => { draft.price = e.target.value; },
                }),
                { hint: tr('Ставка палаты. Отдельная койка может стоить иначе — это задаётся в карточке койки.') });

            m.bodyEl.appendChild(field(tr('Как считать проживание'),
                h('select', {
                    class: 'inp',
                    onchange: (e) => {
                        draft.billing_mode = e.target.value;
                        const lb = priceFld.querySelector('label');
                        if (lb) lb.textContent = draft.billing_mode === 'daily' ? tr('Цена за сутки, сум') : tr('Цена за час, сум');
                    },
                },
                    h('option', { value: 'daily', selected: draft.billing_mode === 'daily' }, tr('За сутки (24 часа)')),
                    h('option', { value: 'hourly', selected: draft.billing_mode === 'hourly' }, tr('За час')))));
            m.bodyEl.appendChild(priceFld);
        } else {
            m.bodyEl.appendChild(field(tr('Отдел'),
                h('select', { class: 'inp', onchange: (e) => { draft.department_id = e.target.value; } },
                    h('option', { value: '' }, tr('— отдел не указан —')),
                    ...state.depts.map(d => h('option', {
                        value: String(d.id), selected: String(draft.department_id) === String(d.id),
                    }, d.name))),
                { hint: tr('Этаж кабинета определяется отделом.') }));
        }

        m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: step1 }, tr('Назад')));
        const saveBtn = h('button', {
            class: 'btn btn-primary btn-sm', type: 'button',
            onclick: async () => {
                saveBtn.disabled = true;
                try {
                    await save(draft);
                    m.close();
                    await load();
                    paint();
                } catch (e) {
                    toast((e && e.message) || tr('Не удалось сохранить.'), 'fail');
                    saveBtn.disabled = false;
                }
            },
        }, tr('Создать'));
        m.footEl.appendChild(saveBtn);
    }

    step1();
}

async function save(draft) {
    const t = TYPE_BY_KEY[draft.type];
    const name = (draft.name || '').trim();
    if (!name) throw new Error(tr('Укажите название.'));

    if (t.kind === 'room') {
        const { error } = await supabase.from('rooms').insert({
            name,
            code: (draft.code || '').trim() || null,
            room_type: draft.type,
            department_id: draft.department_id ? Number(draft.department_id) : null,
            active: true,
        });
        if (error) throw new Error(error.message);
        toast(tr('Кабинет создан.'), 'ok');
        return;
    }

    // Палата, затем койки — двумя запросами и именно в этом порядке. Если
    // вставка коек не пройдёт, палата уже создана и видна в списке: койки
    // дозаводятся кнопкой «Койки», а не пересозданием палаты.
    const branch_id = soleBranchId() || (getSelectedBranchIds()[0] != null ? getSelectedBranchIds()[0] : null);
    const price = Number(draft.price) || 0;
    const payload = {
        name,
        code: (draft.code || '').trim() || null,
        type: wardTypeFor(draft.type),
        floor_id: draft.floor_id ? Number(draft.floor_id) : null,
        billing_mode: draft.billing_mode,
        price_per_day: draft.billing_mode === 'daily' ? price : 0,
        price_per_hour: draft.billing_mode === 'hourly' ? price : 0,
        active: true,
    };
    if (branch_id != null) payload.branch_id = branch_id;

    const { data, error } = await supabase.from('wards').insert(payload).select('id').single();
    if (error) throw new Error(error.message);

    const n = Math.max(0, Math.min(200, parseInt(draft.beds, 10) || 0));
    if (n > 0) await insertBeds(data.id, draft.type, 1, n);
    toast(n ? trf('Палата создана, коек: {n}.', { n }) : tr('Палата создана.'), 'ok');
}

async function insertBeds(wardId, typeKey, from, count) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        rows.push({
            ward_id: wardId,
            code: String(from + i),
            type: bedTypeFor(typeKey),
            status: 'free',
            active: true,
        });
    }
    const { error } = await supabase.from('beds').insert(rows);
    if (error) throw new Error(trf('Палата создана, но койки не добавились: {msg}', { msg: error.message }));
}

// «Койки» на существующей палате — дозаводит СЛЕДУЮЩИЕ номера, не трогая
// существующие: занятая койка не должна поменять номер под пациентом.
function openAddBeds(ward) {
    const m = modalShell(trf('Койки — {ward}', { ward: ward.name || '' }));
    const have = state.bedsByWard[ward.id] || [];
    const maxNo = have.reduce((mx, b) => Math.max(mx, parseInt(b.code, 10) || 0), 0);
    const draft = { count: 1 };

    m.bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px', marginBottom: '12px' } },
        trf('Сейчас коек: {have}. Новые получат номера с {from}.', { have: have.length, from: maxNo + 1 })));
    m.bodyEl.appendChild(field(tr('Сколько добавить'),
        h('input', {
            class: 'inp', type: 'number', min: '1', max: '200', value: '1',
            oninput: (e) => { draft.count = e.target.value; },
        })));

    m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: m.close }, tr('Отмена')));
    const btn = h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: async () => {
            btn.disabled = true;
            try {
                const n = Math.max(1, Math.min(200, parseInt(draft.count, 10) || 1));
                await insertBeds(ward.id, ward.type, maxNo + 1, n);
                toast(trf('Добавлено коек: {n}.', { n }), 'ok');
                m.close();
                await load();
                paint();
            } catch (e) {
                toast((e && e.message) || tr('Не удалось добавить койки.'), 'fail');
                btn.disabled = false;
            }
        },
    }, tr('Добавить'));
    m.footEl.appendChild(btn);
}
