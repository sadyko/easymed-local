// ROOMS_SETUP_V1 — «Помещения»: этажи, кабинеты и палаты одним разделом.
//
// До этого раздела помещения клиники были размазаны по ЧЕТЫРЁМ разделам
// настроек в ДВУХ группах: Floors и Rooms в «Rooms & floors», Wards и Beds в
// «Inpatient». Чтобы открыть стационар на шесть коек, администратор заводил
// палату в одном разделе, уходил в другой и создавал шесть коек по одной,
// руками повторяя номер и цену.
//
// Здесь всё в одном месте и всё РЕДАКТИРУЕТСЯ: этаж, кабинет (приём,
// диагностика, лаборатория, процедурная, операционная) и палата (общая, ПИТ,
// изолятор, VIP, родильная, детская) вместе с койками и ценой.
//
// СХЕМУ ТАБЛИЦ НЕ СЛИВАЕМ: кабинет остаётся строкой rooms, палата — wards +
// beds. На wards завязаны admissions, admission_transfers и биллинг проживания;
// слияние ради одного экрана означало бы переписать стационар целиком.
// Объединение здесь на уровне ИНТЕРФЕЙСА.
//
// Недостающие колонки (rooms.code/room_type/capacity/queue_mode, wards.code/
// floor_id) добавлены миграцией 082: локальная схема была тоньше общего
// редактора настроек, и раздел мог создать строку, но не мог её описать.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, PageHead } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ

// ROOM_CATS_V1 — типы сгруппированы в четыре категории по постановке владельца.
// cat — это ТОЛЬКО раскладка выбора; на запись она не влияет: kind по-прежнему
// решает, куда ляжет строка (rooms или wards), а key — что попадёт в room_type /
// wards.type. Операционная стоит в «Стационаре» рядом с ПИТ, потому что так её
// ищут, но остаётся КАБИНЕТОМ: коек и проживания у операционной нет.
const CATS = [
    ['ambulatory',  'Амбулаторные'],
    ['stationary',  'Стационар'],
    ['diagnostics', 'Диагностика'],
    ['laboratory',  'Лаборатория'],
];

const TYPES = [
    { key: 'consultation', cat: 'ambulatory',  kind: 'room', label: 'Консультация',     icon: 'Stethoscope', hint: 'Кабинет приёма' },
    { key: 'procedure',    cat: 'ambulatory',  kind: 'room', label: 'Процедурная',      icon: 'Plus',        hint: 'Уколы, капельницы' },

    { key: 'general',      cat: 'stationary',  kind: 'ward', label: 'Палата (общая)',   icon: 'Bed',         hint: 'Стационар' },
    { key: 'vip',          cat: 'stationary',  kind: 'ward', label: 'VIP',              icon: 'Sparkles',    hint: 'Повышенной комфортности' },
    { key: 'pediatrics',   cat: 'stationary',  kind: 'ward', label: 'Детская',          icon: 'Patients',    hint: 'Детский стационар' },
    { key: 'isolation',    cat: 'stationary',  kind: 'ward', label: 'Изолятор',         icon: 'Shield',      hint: 'Инфекционный бокс' },
    { key: 'maternity',    cat: 'stationary',  kind: 'ward', label: 'Родильная',        icon: 'Heart',       hint: 'Роды и послеродовые' },
    { key: 'icu',          cat: 'stationary',  kind: 'ward', label: 'ПИТ / реанимация', icon: 'Heart',       hint: 'Интенсивная терапия' },
    { key: 'surgery',      cat: 'stationary',  kind: 'room', label: 'Операционная',     icon: 'Pulse',       hint: 'Операции' },

    { key: 'diagnostics',  cat: 'diagnostics', kind: 'room', label: 'Диагностика',      icon: 'Activity',    hint: 'УЗИ, ЭКГ, рентген' },

    { key: 'lab',          cat: 'laboratory',  kind: 'room', label: 'Лаборатория',      icon: 'Flask',       hint: 'Окно забора' },
];
const TYPE_BY_KEY = Object.fromEntries(TYPES.map(t => [t.key, t]));

// wards.type по умолчанию 'general'; для VIP значения нет — VIP это свойство
// КОЙКИ (beds.type), палата остаётся общей.
const WARD_TYPE_FALLBACK = { vip: 'general' };
function wardTypeFor(key) { return WARD_TYPE_FALLBACK[key] || key; }
function bedTypeFor(key) {
    if (key === 'icu') return 'icu';
    if (key === 'isolation') return 'isolation';
    if (key === 'vip') return 'vip';
    return 'standard';
}

// Очередь кабинета. Смысл режимов — в миграции 082 и в маршрутизаторе очереди.
const QUEUE_MODES = [
    ['none',   'Без очереди'],
    ['room',   'Очередь к кабинету'],
    ['doctor', 'Очередь к врачу'],
];

const state = { floors: [], rooms: [], wards: [], bedsByWard: {}, doctors: [], view: 'plan' };
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
    const [fl, rm, wd, bd, us] = await Promise.all([
        supabase.from('floors').select('id, name, level, active').order('level', { ascending: true }),
        supabase.from('rooms').select('id, name, code, room_type, capacity, queue_mode, floor_id, active').order('name', { ascending: true }),
        supabase.from('wards').select('id, name, code, type, floor_id, billing_mode, price_per_hour, price_per_day, active').order('name', { ascending: true }),
        supabase.from('beds').select('id, ward_id, code, type, status, active').limit(5000),
        supabase.from('users').select('id, full_name, is_doctor, specialty, room_id, is_active').limit(1000),
    ]);
    state.floors = fl.data || [];
    state.rooms = rm.data || [];
    state.wards = wd.data || [];
    state.doctors = (us.data || []).filter(u => u.is_doctor && u.is_active !== false && u.is_active !== 0);
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
function doctorsIn(roomId) {
    return state.doctors.filter(d => String(d.room_id) === String(roomId));
}

// -----------------------------------------------------------------------------
// Список
// -----------------------------------------------------------------------------
function buildRows() {
    return [
        ...state.rooms.map(r => {
            const docs = doctorsIn(r.id);
            return {
                kind: 'room', id: r.id, name: r.name, code: r.code, type: r.room_type,
                floor_id: r.floor_id, active: r.active !== false && r.active !== 0, raw: r,
                docs,
                meta: docs.length ? docs.map(d => d.full_name).join(', ') : '\u2014',
                queueMode: r.queue_mode || 'none',
                queue: (QUEUE_MODES.find(q => q[0] === (r.queue_mode || 'none')) || QUEUE_MODES[0])[1],
                price: '\u2014',
            };
        }),
        ...state.wards.map(w => {
            const beds = state.bedsByWard[w.id] || [];
            return {
                kind: 'ward', id: w.id, name: w.name, code: w.code, type: w.type,
                floor_id: w.floor_id, active: w.active !== false && w.active !== 0, raw: w,
                beds,
                meta: trf('\u043a\u043e\u0435\u043a: {n}', { n: beds.length }),
                queue: '\u2014',
                price: w.billing_mode === 'daily'
                    ? trf('{price} / \u0441\u0443\u0442', { price: money(w.price_per_day) })
                    : trf('{price} / \u0447\u0430\u0441', { price: money(w.price_per_hour) }),
            };
        }),
    ];
}

// Этажи сверху вниз: меньший level — выше. Помещения без этажа собираются в
// отдельную группу в конце, иначе их не видно вовсе.
function groupByFloor(rows) {
    const byFloor = new Map();
    for (const r of rows) {
        const key = r.floor_id == null ? '' : String(r.floor_id);
        if (!byFloor.has(key)) byFloor.set(key, []);
        byFloor.get(key).push(r);
    }
    const order = [...byFloor.keys()].sort((a, b) => {
        const fa = state.floors.find(f => String(f.id) === a);
        const fb = state.floors.find(f => String(f.id) === b);
        return (fa && fa.level != null ? fa.level : 999) - (fb && fb.level != null ? fb.level : 999);
    });
    return { byFloor, order };
}

function paint() {
    clear(containerRef);
    const rows = buildRows();
    const { byFloor, order } = groupByFloor(rows);

    const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
    body.appendChild(floorsCard());

    if (!rows.length) {
        body.appendChild(h('div', { class: 'card', style: { padding: '28px', textAlign: 'center' } },
            h('div', { class: 'muted' }, tr('\u041f\u043e\u043c\u0435\u0449\u0435\u043d\u0438\u0439 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442. \u041d\u0430\u0447\u043d\u0438\u0442\u0435 \u0441 \u043a\u0430\u0431\u0438\u043d\u0435\u0442\u0430 \u043f\u0440\u0438\u0451\u043c\u0430 \u0438\u043b\u0438 \u043f\u0430\u043b\u0430\u0442\u044b.'))));
    }

    for (const key of order) {
        body.appendChild(state.view === 'plan'
            ? planFloorCard(key, byFloor.get(key))
            : listFloorCard(key, byFloor.get(key)));
    }

    containerRef.appendChild(h('div', { class: 'fade-in' },
        PageHead({
            title: tr('\u041f\u043e\u043c\u0435\u0449\u0435\u043d\u0438\u044f'),
            subtitle: tr('\u042d\u0442\u0430\u0436\u0438, \u043a\u0430\u0431\u0438\u043d\u0435\u0442\u044b \u0438 \u043f\u0430\u043b\u0430\u0442\u044b \u0432 \u043e\u0434\u043d\u043e\u043c \u0440\u0430\u0437\u0434\u0435\u043b\u0435. \u0417\u0434\u0435\u0441\u044c \u0436\u0435 \u2014 \u043e\u0447\u0435\u0440\u0435\u0434\u044c \u043a\u0430\u0431\u0438\u043d\u0435\u0442\u0430 \u0438 \u0432\u0440\u0430\u0447\u0438, \u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u0432 \u043d\u0451\u043c \u043f\u0440\u0438\u043d\u0438\u043c\u0430\u044e\u0442.'),
            right: h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
                viewSwitch(),
                h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openWizard() },
                    Icon('Plus', { size: 14 }), ' ', tr('\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u043f\u043e\u043c\u0435\u0449\u0435\u043d\u0438\u0435'))),
        }),
        body,
    ));
}

function viewSwitch() {
    const wrap = h('div', { class: 'segmented', role: 'group' });
    for (const [id, label] of [['plan', '\u041f\u043b\u0430\u043d'], ['list', '\u0421\u043f\u0438\u0441\u043e\u043a']]) {
        wrap.appendChild(h('button', {
            type: 'button', class: state.view === id ? 'is-on' : '',
            onclick: () => { state.view = id; paint(); },
        }, tr(label)));
    }
    return wrap;
}

// ---- ПЛАН: этаж = полоса, помещение = плитка -------------------------------
// Не чертёж по координатам: координат в схеме нет, и рисовать их с потолка
// значило бы показывать неправду. Плитки дают то, ради чего в план смотрят —
// сколько чего на этаже, кто где сидит и сколько коек занято.
function planFloorCard(key, rows) {
    const grid = h('div', { class: 'rs-plan' });
    for (const r of rows) grid.appendChild(planTile(r));
    return h('div', { class: 'card rs-card' },
        h('div', { class: 'rs-floor rs-floor--row' },
            h('span', null, floorName(key) || tr('\u042d\u0442\u0430\u0436 \u043d\u0435 \u0443\u043a\u0430\u0437\u0430\u043d')),
            h('span', { class: 'muted', style: { fontWeight: '400', fontSize: '12.5px' } },
                trf('\u043f\u043e\u043c\u0435\u0449\u0435\u043d\u0438\u0439: {n}', { n: rows.length }))),
        grid);
}

function planTile(r) {
    const t = TYPE_BY_KEY[r.type] || {};
    const kids = [
        h('div', { class: 'rs-tile__top' },
            h('span', { class: 'rs-tile__ic' }, Icon(t.icon || 'Grid', { size: 15 })),
            h('span', { class: 'rs-tile__code' }, r.code || '')),
        h('div', { class: 'rs-tile__name', title: r.name || '' }, r.name || '\u2014'),
        h('div', { class: 'rs-tile__type muted' }, t.label ? tr(t.label) : (r.type || '')),
    ];
    if (r.kind === 'ward') {
        const dots = h('div', { class: 'rs-beds' });
        for (const b of r.beds) {
            dots.appendChild(h('span', {
                class: 'rs-bed is-' + (b.status || 'free'),
                title: (b.code || '') + ' \u00b7 ' + (b.status || 'free'),
            }));
        }
        if (!r.beds.length) dots.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('\u043a\u043e\u0435\u043a \u043d\u0435\u0442')));
        kids.push(dots);
    } else {
        kids.push(h('div', { class: 'rs-tile__foot muted' },
            r.docs.length ? trf('\u0432\u0440\u0430\u0447\u0435\u0439: {n}', { n: r.docs.length }) : tr('\u0431\u0435\u0437 \u0432\u0440\u0430\u0447\u0430'),
            r.queueMode !== 'none' ? h('span', { class: 'rs-qbadge' }, Icon('Clock', { size: 11 })) : null));
    }
    return h('button', {
        class: 'rs-tile rs-tile--' + (r.kind === 'ward' ? 'ward' : 'room') + (r.active ? '' : ' is-off'),
        type: 'button', onclick: () => openWizard(r),
        title: r.active ? '' : tr('\u0432\u044b\u043a\u043b\u044e\u0447\u0435\u043d\u043e'),
    }, ...kids);
}

// ---- СПИСОК ----------------------------------------------------------------
function listFloorCard(key, rows) {
    return h('div', { class: 'card rs-card' },
        h('div', { class: 'rs-floor' }, floorName(key) || tr('\u042d\u0442\u0430\u0436 \u043d\u0435 \u0443\u043a\u0430\u0437\u0430\u043d')),
        h('div', { class: 'rs-tbl' },
            h('div', { class: 'rs-row rs-row--head' },
                h('span', { class: 'rs-name' }, tr('\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435')),
                h('span', { class: 'rs-type' }, tr('\u0422\u0438\u043f')),
                h('span', { class: 'rs-meta' }, tr('\u0412\u0440\u0430\u0447\u0438 / \u043a\u043e\u0439\u043a\u0438')),
                h('span', { class: 'rs-queue' }, tr('\u041e\u0447\u0435\u0440\u0435\u0434\u044c')),
                h('span', { class: 'rs-price' }, tr('\u041f\u0440\u043e\u0436\u0438\u0432\u0430\u043d\u0438\u0435')),
                h('span', { class: 'rs-act' }, ''),
            ),
            ...rows.map(rowEl),
        ));
}

function rowEl(r) {
    const t = TYPE_BY_KEY[r.type] || {};
    return h('div', { class: 'rs-row' },
        h('span', { class: 'rs-name', title: r.name || '' },
            r.name || '\u2014',
            r.code ? h('span', { class: 'muted', style: { fontWeight: '400' } }, ' \u00b7 ' + r.code) : null,
            r.active ? null : h('span', { class: 'muted', style: { fontWeight: '400' } }, ' \u00b7 ', tr('\u0432\u044b\u043a\u043b\u044e\u0447\u0435\u043d\u043e'))),
        h('span', { class: 'rs-type' }, Tag(t.label ? tr(t.label) : (r.type || '\u2014'), { kind: r.kind === 'ward' ? 'warn' : '' })),
        h('span', { class: 'rs-meta muted', title: r.meta || '' }, r.meta || '\u2014'),
        h('span', { class: 'rs-queue muted' }, r.kind === 'room' ? tr(r.queue) : '\u2014'),
        h('span', { class: 'rs-price' }, r.price || '\u2014'),
        h('span', { class: 'rs-act' },
            r.kind === 'ward'
                ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openAddBeds(r.raw) }, tr('\u041a\u043e\u0439\u043a\u0438'))
                : null,
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openWizard(r) }, tr('\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c')),
        ),
    );
}

// -----------------------------------------------------------------------------
function floorsCard() {
    const list = h('div', { class: 'rs-tbl' });
    if (!state.floors.length) {
        list.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '6px 0' } },
            tr('Этажей пока нет — добавьте первый, чтобы раскладывать по ним кабинеты и палаты.')));
    }
    for (const f of state.floors) {
        list.appendChild(h('div', { class: 'rs-row' },
            h('span', { class: 'rs-name' }, f.name,
                (f.active === false || f.active === 0) ? h('span', { class: 'muted', style: { fontWeight: '400' } }, ' · ', tr('выключено')) : null),
            h('span', { class: 'rs-meta muted' }, trf('уровень {n}', { n: f.level == null ? 0 : f.level })),
            h('span', { class: 'rs-act' },
                h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openFloor(f) }, tr('Изменить'))),
        ));
    }
    return h('div', { class: 'card rs-card' },
        h('div', { class: 'rs-floor rs-floor--row' },
            h('span', null, tr('Этажи')),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openFloor(null) },
                Icon('Plus', { size: 13 }), ' ', tr('Этаж'))),
        list);
}

function openFloor(row) {
    const m = modalShell(row ? tr('Этаж') : tr('Новый этаж'));
    const d = { name: row ? row.name : '', level: row ? (row.level == null ? 0 : row.level) : 0,
                active: row ? (row.active !== false && row.active !== 0) : true };
    m.bodyEl.appendChild(field(tr('Название'), h('input', {
        class: 'inp', value: d.name, placeholder: tr('2-й этаж'), oninput: (e) => { d.name = e.target.value; },
    }), { required: true }));
    m.bodyEl.appendChild(field(tr('Уровень (для порядка)'), h('input', {
        class: 'inp', type: 'number', value: String(d.level), oninput: (e) => { d.level = e.target.value; },
    }), { hint: tr('Чем меньше число, тем выше этаж в списке.') }));
    m.bodyEl.appendChild(activeRow(d));

    if (row) {
        m.footEl.appendChild(h('button', {
            class: 'btn btn-outline btn-sm rs-del', type: 'button',
            onclick: () => confirmDelete('floor', { id: row.id, name: row.name }, m),
        }, tr('Удалить')));
        m.footEl.appendChild(h('div', { style: { flex: '1 1 auto' } }));
    }
    m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: m.close }, tr('Отмена')));
    const btn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: async () => {
        btn.disabled = true;
        try {
            const name = (d.name || '').trim();
            if (!name) throw new Error(tr('Укажите название.'));
            const payload = { name, level: Number(d.level) || 0, active: d.active };
            const q = row ? supabase.from('floors').update(payload).eq('id', row.id)
                          : supabase.from('floors').insert(payload);
            const { error } = await q;
            if (error) throw new Error(error.message);
            toast(tr('Сохранено.'), 'ok');
            m.close(); await load(); paint();
        } catch (e) { toast((e && e.message) || tr('Не удалось сохранить.'), 'fail'); btn.disabled = false; }
    } }, tr('Сохранить'));
    m.footEl.appendChild(btn);
}

function activeRow(d) {
    const cb = h('input', { type: 'checkbox', checked: !!d.active, onchange: (e) => { d.active = e.target.checked; } });
    return h('label', { style: { display: 'flex', alignItems: 'center', gap: '9px', margin: '12px 0 2px', cursor: 'pointer' } },
        cb, h('span', { style: { fontSize: '13.5px' } }, tr('Активно')));
}

// -----------------------------------------------------------------------------
// Кабинет / палата — создание и редактирование одним диалогом
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
        style: { width: '580px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column' },
    },
        h('div', { style: { padding: '16px 20px', borderBottom: '1px solid var(--ink-100)', fontWeight: '700', fontSize: '15px' } }, title),
        bodyEl, footEl));
    document.body.appendChild(overlay);
    return { overlay, bodyEl, footEl, close };
}

// row === null → создание; иначе редактирование существующей строки.
function openWizard(row) {
    const editing = !!row;
    const m = modalShell(editing ? tr('Помещение') : tr('Новое помещение'));
    const src = editing ? row.raw : null;
    const d = {
        type: editing ? row.type : null,
        kind: editing ? row.kind : null,
        name: src ? (src.name || '') : '',
        code: src ? (src.code || '') : '',
        floor_id: src && src.floor_id != null ? String(src.floor_id) : '',
        active: src ? (src.active !== false && src.active !== 0) : true,
        queue_mode: src && src.queue_mode ? src.queue_mode : 'none',
        doctorIds: editing && row.kind === 'room' ? doctorsIn(row.id).map(x => x.id) : [],
        beds: 4,
        billing_mode: src && src.billing_mode ? src.billing_mode : 'daily',
        price: src ? (src.billing_mode === 'hourly' ? src.price_per_hour : src.price_per_day) || 0 : 0,
    };

    function step1() {
        clear(m.bodyEl); clear(m.footEl);
        m.bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px', marginBottom: '12px' } },
            tr('Шаг 1 из 2 — что это за помещение?')));
        // ROOM_CATS_V1 — выбор разложен по категориям: подряд одиннадцать плиток
        // читались как один список, где палата стоит рядом с лабораторией.
        for (const [catKey, catLabel] of CATS) {
            const items = TYPES.filter(t => t.cat === catKey);
            if (!items.length) continue;
            m.bodyEl.appendChild(h('div', { class: 'rs-catlb' }, tr(catLabel)));
            const grid = h('div', { class: 'rs-typegrid' });
            for (const t of items) {
                grid.appendChild(h('button', {
                    class: 'rs-type-card' + (d.type === t.key ? ' is-on' : ''), type: 'button',
                    onclick: () => { d.type = t.key; d.kind = t.kind; step2(); },
                },
                    h('span', { class: 'rs-type-ic' }, Icon(t.icon, { size: 17 })),
                    h('span', { style: { minWidth: '0' } },
                        h('span', { class: 'rs-type-lb' }, tr(t.label)),
                        h('span', { class: 'rs-type-hint muted' }, tr(t.hint))),
                ));
            }
            m.bodyEl.appendChild(grid);
        }
        m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: m.close }, tr('Отмена')));
    }

    function step2() {
        const t = TYPE_BY_KEY[d.type];
        const isWard = t.kind === 'ward';
        clear(m.bodyEl); clear(m.footEl);
        if (!editing) {
            m.bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px', marginBottom: '12px' } },
                trf('Шаг 2 из 2 — {type}', { type: tr(t.label).toLowerCase() })));
        }

        m.bodyEl.appendChild(field(tr('Название'), h('input', {
            class: 'inp', value: d.name, placeholder: isWard ? tr('Палата №3') : tr('Кабинет 201'),
            oninput: (e) => { d.name = e.target.value; },
        }), { required: true }));

        m.bodyEl.appendChild(field(isWard ? tr('Код палаты (необязательно)') : tr('Номер двери (необязательно)'),
            h('input', { class: 'inp', value: d.code, placeholder: isWard ? 'W3' : '201', oninput: (e) => { d.code = e.target.value; } })));

        m.bodyEl.appendChild(field(tr('Этаж'), h('select', { class: 'inp', onchange: (e) => { d.floor_id = e.target.value; } },
            h('option', { value: '' }, tr('— этаж не указан —')),
            ...state.floors.map(f => h('option', { value: String(f.id), selected: String(d.floor_id) === String(f.id) }, f.name)))));

        if (isWard) {
            if (!editing) {
                m.bodyEl.appendChild(field(tr('Сколько коек создать'), h('input', {
                    class: 'inp', type: 'number', min: '0', max: '200', value: String(d.beds),
                    oninput: (e) => { d.beds = e.target.value; },
                }), { hint: tr('Койки пронумеруются автоматически: 1, 2, 3… Позже можно добавить ещё кнопкой «Койки».') }));
            }
            const priceFld = field(d.billing_mode === 'daily' ? tr('Цена за сутки, сум') : tr('Цена за час, сум'),
                h('input', { class: 'inp', type: 'number', min: '0', step: '1000', value: String(d.price), oninput: (e) => { d.price = e.target.value; } }),
                { hint: tr('Ставка палаты. Отдельная койка может стоить иначе — это задаётся в карточке койки.') });
            m.bodyEl.appendChild(field(tr('Как считать проживание'), h('select', {
                class: 'inp',
                onchange: (e) => {
                    d.billing_mode = e.target.value;
                    const lb = priceFld.querySelector('label');
                    if (lb) lb.textContent = d.billing_mode === 'daily' ? tr('Цена за сутки, сум') : tr('Цена за час, сум');
                },
            },
                h('option', { value: 'daily', selected: d.billing_mode === 'daily' }, tr('За сутки (24 часа)')),
                h('option', { value: 'hourly', selected: d.billing_mode === 'hourly' }, tr('За час')))));
            m.bodyEl.appendChild(priceFld);
        } else {
            m.bodyEl.appendChild(field(tr('Очередь'), h('select', { class: 'inp', onchange: (e) => { d.queue_mode = e.target.value; } },
                ...QUEUE_MODES.map(([v, lb]) => h('option', { value: v, selected: d.queue_mode === v }, tr(lb)))),
                { hint: tr('«К кабинету» — один номер на дверь (УЗИ, рентген, забор). «К врачу» — номер идёт в линию врача, который здесь принимает.') }));
            m.bodyEl.appendChild(doctorsField(d));
        }

        m.bodyEl.appendChild(activeRow(d));

        // ROOMS_DELETE_V1 — «Удалить» стоит слева, отдельно от «Сохранить»:
        // это единственная необратимая кнопка в диалоге.
        if (editing) {
            m.footEl.appendChild(h('button', {
                class: 'btn btn-outline btn-sm rs-del', type: 'button',
                onclick: () => confirmDelete(t.kind === 'ward' ? 'ward' : 'room', row, m),
            }, tr('Удалить')));
            m.footEl.appendChild(h('div', { style: { flex: '1 1 auto' } }));
        }
        if (!editing) m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: step1 }, tr('Назад')));
        else m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: m.close }, tr('Отмена')));
        const saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: async () => {
            saveBtn.disabled = true;
            try { await save(d, editing ? row : null); m.close(); await load(); paint(); }
            catch (e) { toast((e && e.message) || tr('Не удалось сохранить.'), 'fail'); saveBtn.disabled = false; }
        } }, editing ? tr('Сохранить') : tr('Создать'));
        m.footEl.appendChild(saveBtn);
    }

    if (editing) step2(); else step1();
}

// Врачи кабинета. У врача ОДИН кабинет (users.room_id), у кабинета — сколько
// угодно врачей, поэтому это набор галочек, а не выпадающий список.
function doctorsField(d) {
    const box = h('div', { class: 'rs-docs' });
    if (!state.doctors.length) {
        box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Врачей в справочнике нет.')));
    }
    for (const doc of state.doctors) {
        const on = d.doctorIds.some(x => String(x) === String(doc.id));
        const cb = h('input', {
            type: 'checkbox', checked: on,
            onchange: (e) => {
                if (e.target.checked) d.doctorIds.push(doc.id);
                else d.doctorIds = d.doctorIds.filter(x => String(x) !== String(doc.id));
            },
        });
        const other = doc.room_id != null && (!d.doctorIds.some(x => String(x) === String(doc.id)));
        box.appendChild(h('label', { class: 'rs-doc' }, cb,
            h('span', null, doc.full_name || '—',
                doc.specialty ? h('span', { class: 'muted' }, ' · ' + doc.specialty) : null,
                other && doc.room_id != null ? h('span', { class: 'muted' }, ' · ', trf('сейчас: {room}', { room: (state.rooms.find(r => String(r.id) === String(doc.room_id)) || {}).name || '—' })) : null)));
    }
    return field(tr('Врачи в этом кабинете'), box,
        { hint: tr('Врач может сидеть только в одном кабинете — отметка здесь переносит его сюда.') });
}

async function save(d, row) {
    const t = TYPE_BY_KEY[d.type];
    const name = (d.name || '').trim();
    if (!name) throw new Error(tr('Укажите название.'));
    const floor_id = d.floor_id ? Number(d.floor_id) : null;

    if (t.kind === 'room') {
        const payload = {
            name, code: (d.code || '').trim(), room_type: d.type,
            queue_mode: d.queue_mode || 'none', floor_id, active: d.active,
        };
        const q = row ? supabase.from('rooms').update(payload).eq('id', row.id)
                      : supabase.from('rooms').insert(payload).select('id').single();
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        const roomId = row ? row.id : (data && data.id);
        await syncDoctors(roomId, d.doctorIds);
        toast(row ? tr('Сохранено.') : tr('Кабинет создан.'), 'ok');
        return;
    }

    const price = Number(d.price) || 0;
    const payload = {
        name, code: (d.code || '').trim(), type: wardTypeFor(d.type), floor_id,
        billing_mode: d.billing_mode,
        price_per_day: d.billing_mode === 'daily' ? price : 0,
        price_per_hour: d.billing_mode === 'hourly' ? price : 0,
        active: d.active,
    };
    if (row) {
        const { error } = await supabase.from('wards').update(payload).eq('id', row.id);
        if (error) throw new Error(error.message);
        toast(tr('Сохранено.'), 'ok');
        return;
    }
    // Палата, затем койки — двумя запросами и именно в этом порядке: если
    // вставка коек не пройдёт, палата уже создана и видна, койки дозаводятся
    // кнопкой «Койки», а не пересозданием палаты.
    const { data, error } = await supabase.from('wards').insert(payload).select('id').single();
    if (error) throw new Error(error.message);
    const n = Math.max(0, Math.min(200, parseInt(d.beds, 10) || 0));
    if (n > 0) await insertBeds(data.id, d.type, 1, n);
    toast(n ? trf('Палата создана, коек: {n}.', { n }) : tr('Палата создана.'), 'ok');
}

// users нельзя писать через /api/db (write roles пустые — это намеренно, staff
// правится только своими RPC), поэтому привязка врача к кабинету идёт узким
// admin-RPC, который трогает ровно room_id.
async function syncDoctors(roomId, wantIds) {
    if (roomId == null) return;
    const want = (wantIds || []).map(String);
    const have = doctorsIn(roomId).map(x => String(x.id));
    const add = want.filter(x => !have.includes(x));
    const remove = have.filter(x => !want.includes(x));
    if (!add.length && !remove.length) return;
    const { error } = await supabase.rpc('room_assign_doctors', {
        room_id: Number(roomId),
        add: add.map(Number),
        remove: remove.map(Number),
    });
    if (error) throw new Error(trf('Помещение сохранено, но врачи не привязались: {msg}', { msg: error.message }));
}

async function insertBeds(wardId, typeKey, from, count) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        rows.push({ ward_id: wardId, code: String(from + i), type: bedTypeFor(typeKey), active: true });
    }
    const { error } = await supabase.from('beds').insert(rows);
    if (error) throw new Error(trf('Палата создана, но койки не добавились: {msg}', { msg: error.message }));
}

// ROOMS_DELETE_V1 — удаление подтверждается и НЕ обещает больше, чем сделает.
// Сервер сам решает: если на помещении висят приёмы, талоны или
// госпитализации, оно отключается, а не удаляется, и возвращает, что именно
// его держит. Здесь мы честно показываем этот ответ, а не «удалено».
function confirmDelete(kind, row, parent) {
    const m = modalShell(tr('Удалить помещение?'));
    m.bodyEl.appendChild(h('div', { style: { fontSize: '13.5px', lineHeight: '1.55' } },
        trf('Удалить «{name}»?', { name: row.name || '' })));
    m.bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px', lineHeight: '1.5' } },
        tr('Если на помещении есть приёмы, талоны или госпитализации, оно будет отключено, а не удалено — история останется целой.')));
    m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: m.close }, tr('Отмена')));
    const btn = h('button', { class: 'btn btn-primary btn-sm rs-del', type: 'button', onclick: async () => {
        btn.disabled = true;
        try {
            const { data, error } = await supabase.rpc('rooms_setup_delete', { kind, id: Number(row.id) });
            if (error) throw new Error(error.message);
            toast(data && data.deleted ? tr('Удалено.') : ((data && data.message) || tr('Отключено.')),
                  data && data.deleted ? 'ok' : 'info');
            m.close();
            if (parent && parent.close) parent.close();
            await load(); paint();
        } catch (e) { toast((e && e.message) || tr('Не удалось удалить.'), 'fail'); btn.disabled = false; }
    } }, tr('Удалить'));
    m.footEl.appendChild(btn);
}

// «Койки» дозаводит СЛЕДУЮЩИЕ номера, не трогая существующие: занятая койка не
// должна поменять номер под пациентом.
function openAddBeds(ward) {
    const m = modalShell(trf('Койки — {ward}', { ward: ward.name || '' }));
    const have = state.bedsByWard[ward.id] || [];
    const maxNo = have.reduce((mx, b) => Math.max(mx, parseInt(b.code, 10) || 0), 0);
    const d = { count: 1 };

    m.bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px', marginBottom: '12px' } },
        trf('Сейчас коек: {have}. Новые получат номера с {from}.', { have: have.length, from: maxNo + 1 })));
    m.bodyEl.appendChild(field(tr('Сколько добавить'), h('input', {
        class: 'inp', type: 'number', min: '1', max: '200', value: '1', oninput: (e) => { d.count = e.target.value; },
    })));

    m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: m.close }, tr('Отмена')));
    const btn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: async () => {
        btn.disabled = true;
        try {
            const n = Math.max(1, Math.min(200, parseInt(d.count, 10) || 1));
            await insertBeds(ward.id, ward.type, maxNo + 1, n);
            toast(trf('Добавлено коек: {n}.', { n }), 'ok');
            m.close(); await load(); paint();
        } catch (e) { toast((e && e.message) || tr('Не удалось добавить койки.'), 'fail'); btn.disabled = false; }
    } }, tr('Добавить'));
    m.footEl.appendChild(btn);
}
