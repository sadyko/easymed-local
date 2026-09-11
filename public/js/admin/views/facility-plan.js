// FACILITY_PLAN_V1 (2026-09-11) — ПЛАН КЛИНИКИ: этажи, отделения, помещения,
// врачи и оборудование — строятся и переставляются руками, а не заводятся
// строками в таблице.
//
// Владелец: «the user should be able to visually build a hospital … feel like
// building and arranging a real hospital, not entering data into a spreadsheet».
//
// ГДЕ ЭТО ЖИВЁТ. Не отдельный раздел, а «План» раздела «Помещения»: этажи,
// кабинеты (rooms), палаты (wards) с койками, отделения (departments) и
// привязка врача к кабинету (users.room_id) в системе уже есть, и по ним
// работают запись, очередь, стационар и зарплата. План их не дублирует — он
// их РАСКЛАДЫВАЕТ: у помещения появились координаты на плане этажа
// (миграция 125: plan_x/plan_y/plan_w/plan_h), у клиники — оборудование
// (equipment, room_equipment). Всё, что план знает, лежит в базе; сменились
// данные — сменился план.
//
// ТРИ КОЛОНКИ: слева ДЕРЕВО (этаж → отделение → помещение), в центре ПЛАН
// выбранного этажа (плитки на сетке, тянутся мышью, растягиваются за угол),
// справа КАРТОЧКА выбранного помещения (отделение, тип, врачи, оборудование,
// койки, действия). Сверху — обзор клиники числами, поиск и фильтры.
//
// ЧЕГО ЗДЕСЬ НЕТ. Стен, дверей и лестниц: это не чертёж, а план управления —
// «кто где сидит и что там стоит». Помещение без координат раскладывается
// автоматически по сетке (пунктиром) и получает настоящие координаты, как
// только его сдвинули.
//
// КАК ЛОМАЕТСЯ. Перетаскивание пишет координаты одной строкой; отказ сервера
// возвращает плитку на место и говорит словами. Без указателя (клавиатура)
// выбранная плитка сдвигается стрелками. Без этажей — не пустой экран, а
// «Постройте клинику» с одной кнопкой.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, field, Tag } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { pastelFor } from '../pastel.js';

/** Шаг сетки плана в px и размеры плитки по умолчанию. */
export const GRID = 16;
export const DEFAULT_W = 176;
export const DEFAULT_H = 96;
const MIN_W = 112;
const MIN_H = 64;
const CANVAS_MIN_H = 480;

// Состояние плана живёт дольше одной отрисовки: выбранный этаж и помещение
// переживают перечитывание данных после сохранения.
const plan = { floorId: null, selKey: null, search: '', dept: '', type: '', menuEl: null };

const snap = (v) => Math.max(0, Math.round(v / GRID) * GRID);
const keyOf = (r) => r.kind + ':' + r.id;

/**
 * Помещения этажа в одной модели: кабинет и палата — разные таблицы, но на
 * плане они одинаковые плитки. `placed` — есть ли настоящие координаты.
 */
export function floorItems(state, floorId) {
    const rows = [];
    for (const r of state.rooms) {
        if (String(r.floor_id || '') !== String(floorId || '')) continue;
        rows.push({ kind: 'room', id: r.id, raw: r, name: r.name, code: r.code || '', type: r.room_type,
            department_id: r.department_id, active: r.active !== false && r.active !== 0,
            capacity: r.capacity || 0, x: r.plan_x || 0, y: r.plan_y || 0, w: r.plan_w || 0, h: r.plan_h || 0 });
    }
    for (const w of state.wards) {
        if (String(w.floor_id || '') !== String(floorId || '')) continue;
        rows.push({ kind: 'ward', id: w.id, raw: w, name: w.name, code: w.code || '', type: w.type,
            department_id: w.department_id, active: w.active !== false && w.active !== 0,
            beds: state.bedsByWard[w.id] || [], x: w.plan_x || 0, y: w.plan_y || 0, w: w.plan_w || 0, h: w.plan_h || 0 });
    }
    return rows.map((r) => ({ ...r, placed: r.w > 0 && r.h > 0 }));
}

/**
 * Автораскладка неразмещённых: по сетке слева направо, ниже уже размещённых.
 * Ничего не пишет в базу — это предложение, а не факт; факт появляется, когда
 * плитку сдвинули рукой.
 */
export function autoLayout(items, canvasW = 960) {
    const placed = items.filter((i) => i.placed);
    let top = placed.reduce((m, i) => Math.max(m, i.y + i.h), 0);
    if (top) top += GRID;
    let x = 0, rowH = 0;
    const out = [];
    for (const it of items) {
        if (it.placed) { out.push(it); continue; }
        const w = DEFAULT_W, hh = DEFAULT_H;
        if (x + w > canvasW && x > 0) { x = 0; top += rowH + GRID; rowH = 0; }
        out.push({ ...it, x, y: top, w, h: hh, auto: true });
        x += w + GRID; rowH = Math.max(rowH, hh);
    }
    return out;
}

/** Совпадает ли помещение с поиском: имя, код, отделение, врач, тип. */
export function matches(it, q, ctx) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return true;
    const dept = ctx.deptName(it.department_id) || '';
    const docs = it.kind === 'room' ? ctx.doctorsIn(it.id).map((d) => d.full_name || '').join(' ') : '';
    const type = ctx.typeLabel(it) || '';
    return [it.name, it.code, dept, docs, type].join(' ').toLowerCase().includes(s);
}

export function mountFacilityPlan(host, { state, api }) {
    const ctx = {
        deptName: (id) => { const d = state.departments.find((x) => String(x.id) === String(id)); return d ? d.name : ''; },
        doctorsIn: (roomId) => state.doctors.filter((d) => String(d.room_id) === String(roomId)),
        typeLabel: (it) => { const t = api.typeByKey(it.type); return t ? tr(t.label) : (it.type || ''); },
        equipmentOf: (it) => (state.roomEquipment || []).filter((re) => it.kind === 'room' ? String(re.room_id) === String(it.id) : String(re.ward_id) === String(it.id))
            .map((re) => ({ ...re, name: ((state.equipment || []).find((e) => String(e.id) === String(re.equipment_id)) || {}).name || '' })),
    };
    const floors = state.floors.slice().sort((a, b) => (a.level == null ? 999 : a.level) - (b.level == null ? 999 : b.level));
    if (!floors.some((f) => String(f.id) === String(plan.floorId))) plan.floorId = floors.length ? floors[0].id : null;

    clear(host);
    if (!floors.length) { host.appendChild(emptyState(api)); return; }

    const root = h('div', { class: 'fp' });
    root.appendChild(topBar(state, ctx, api, repaint));
    root.appendChild(tree(state, ctx, api, floors, repaint));
    root.appendChild(main(state, ctx, api, floors, repaint));
    root.appendChild(side(state, ctx, api, floors, repaint));
    host.appendChild(root);

    function repaint() { mountFacilityPlan(host, { state, api }); }
}

// ---- Пустая клиника ----------------------------------------------------------
function emptyState(api) {
    return h('div', { class: 'card fp-empty' },
        h('div', { class: 'fp-empty-ic' }, Icon('Building', { size: 28 })),
        h('div', { class: 'fp-empty-t' }, tr('Постройте клинику')),
        h('div', { class: 'fp-empty-s' }, tr('Начните с первого этажа, затем добавьте отделения, кабинеты, палаты и врачей.')),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => api.openFloor(null) },
            Icon('Plus', { size: 14 }), ' ', tr('Создать первый этаж')));
}

// ---- Обзор + поиск + фильтры -------------------------------------------------
function topBar(state, ctx, api, repaint) {
    const freeBeds = Object.values(state.bedsByWard).flat().filter((b) => (b.status || 'free') === 'free').length;
    const totalBeds = Object.values(state.bedsByWard).flat().length;
    const fig = (n, label) => h('div', { class: 'fp-fig' }, h('b', null, String(n)), h('span', null, label));
    const search = h('input', {
        type: 'search', class: 'fp-search', value: plan.search, autocomplete: 'off',
        placeholder: tr('Поиск: кабинет, врач, отделение…'),
        oninput: (e) => { plan.search = e.target.value; jumpToMatch(state, ctx, api); repaint(); },
    });
    const deptSel = h('select', { onchange: (e) => { plan.dept = e.target.value; repaint(); } },
        h('option', { value: '' }, tr('Все отделения')),
        ...state.departments.map((d) => h('option', { value: String(d.id), selected: plan.dept === String(d.id) }, d.name || '')));
    const typeSel = h('select', { onchange: (e) => { plan.type = e.target.value; repaint(); } },
        h('option', { value: '' }, tr('Все типы')),
        ...api.types().map((t) => h('option', { value: t.key, selected: plan.type === t.key }, tr(t.label))));
    return h('div', { class: 'fp-top' },
        h('div', { class: 'fp-figs' },
            fig(state.floors.length, tr('Этажи')),
            fig(state.departments.length, tr('Отделения')),
            fig(state.rooms.length + state.wards.length, tr('Помещения')),
            fig(state.doctors.length, tr('Врачи')),
            fig(freeBeds + ' / ' + totalBeds, tr('Свободных коек'))),
        h('div', { class: 'fp-tools' },
            h('div', { class: 'field fp-field' }, search),
            h('div', { class: 'field fp-field' }, deptSel),
            h('div', { class: 'field fp-field' }, typeSel)));
}

// Поиск ведёт на этаж первого совпадения: искать «Каримов» и не найти его,
// потому что он на другом этаже, — значит, поиск не работает.
function jumpToMatch(state, ctx, api) {
    const q = plan.search;
    if (!String(q || '').trim()) return;
    const all = state.floors.flatMap((f) => floorItems(state, f.id));
    const onThis = all.filter((it) => String(it.raw.floor_id) === String(plan.floorId) && matches(it, q, ctx));
    if (onThis.length) return;
    const hit = all.find((it) => matches(it, q, ctx));
    if (hit) { plan.floorId = hit.raw.floor_id; plan.selKey = keyOf(hit); }
}

function passesFilters(it, ctx) {
    if (plan.dept && String(it.department_id || '') !== plan.dept) return false;
    if (plan.type && it.type !== plan.type) return false;
    return matches(it, plan.search, ctx);
}

// ---- Дерево ------------------------------------------------------------------
function tree(state, ctx, api, floors, repaint) {
    const box = h('div', { class: 'card fp-tree' });
    box.appendChild(h('div', { class: 'card-header' },
        h('h3', null, Icon('Building', { size: 15 }), ' ', tr('Структура')),
        h('div', { class: 'dash-card-acts' },
            h('button', { class: 'btn btn-ghost btn-sm dash-act', type: 'button', title: tr('Добавить этаж'), onclick: () => api.openFloor(null) },
                Icon('Plus', { size: 13 }), ' ', tr('Этаж')))));
    const list = h('div', { class: 'fp-tree-list' });
    for (const f of floors) {
        const items = floorItems(state, f.id).filter((it) => passesFilters(it, ctx));
        const open = String(f.id) === String(plan.floorId);
        list.appendChild(h('button', {
            type: 'button', class: 'fp-node fp-node--floor' + (open ? ' is-open' : ''),
            'aria-expanded': open ? 'true' : 'false',
            onclick: () => { plan.floorId = f.id; plan.selKey = null; repaint(); },
        }, Icon(open ? 'ChevronDown' : 'ChevronRight', { size: 13 }), h('span', { class: 'fp-node-n' }, f.name || ''),
            h('span', { class: 'fp-node-c' }, String(items.length))));
        if (!open) continue;
        // Отделения этажа — по помещениям на нём; помещения без отделения — своей веткой.
        const groups = new Map();
        for (const it of items) {
            const k = it.department_id == null ? '' : String(it.department_id);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(it);
        }
        // Без отделения — в конец: сортировочный ключ вне алфавита, а не буква (её бы искал словарь).
        const LAST = '￿';
        const keys = [...groups.keys()].sort((a, b) => (ctx.deptName(a) || LAST).localeCompare(ctx.deptName(b) || LAST));
        for (const k of keys) {
            list.appendChild(h('div', { class: 'fp-node fp-node--dept ' + (k ? pastelFor('dept-' + k) : '') },
                h('i', { class: 'fp-dot' }), h('span', { class: 'fp-node-n' }, k ? ctx.deptName(k) : tr('Без отделения')),
                h('span', { class: 'fp-node-c' }, String(groups.get(k).length))));
            for (const it of groups.get(k)) {
                const on = plan.selKey === keyOf(it);
                list.appendChild(h('button', {
                    type: 'button', class: 'fp-node fp-node--room' + (on ? ' is-on' : '') + (it.active ? '' : ' is-off'),
                    onclick: () => { plan.selKey = keyOf(it); repaint(); },
                }, Icon(it.kind === 'ward' ? 'Bed' : 'Grid', { size: 12 }),
                    h('span', { class: 'fp-node-n' }, (it.code ? it.code + ' · ' : '') + (it.name || ''))));
            }
        }
        if (!items.length) list.appendChild(h('div', { class: 'fp-node fp-node--empty muted' }, tr('На этом этаже пока пусто')));
        list.appendChild(h('button', {
            type: 'button', class: 'fp-node fp-node--add',
            onclick: () => api.openWizard(null, { floor_id: f.id }),
        }, Icon('Plus', { size: 12 }), ' ', tr('Добавить помещение')));
    }
    box.appendChild(list);
    return box;
}

// ---- План этажа --------------------------------------------------------------
function main(state, ctx, api, floors, repaint) {
    const box = h('div', { class: 'card fp-main' });
    // Полоса этажей — сегменты; «+ Этаж» — рядом.
    const strip = h('div', { class: 'segmented fp-floors', role: 'tablist' });
    for (const f of floors) {
        const on = String(f.id) === String(plan.floorId);
        strip.appendChild(h('button', {
            type: 'button', role: 'tab', class: on ? 'on' : '', 'aria-selected': on ? 'true' : 'false',
            onclick: () => { plan.floorId = f.id; plan.selKey = null; repaint(); },
            oncontextmenu: (e) => { e.preventDefault(); openMenu(e, floorMenu(f, api)); },
        }, f.name || ''));
    }
    const floor = floors.find((f) => String(f.id) === String(plan.floorId)) || floors[0];
    box.appendChild(h('div', { class: 'card-header fp-main-head' },
        h('div', { class: 'fp-crumbs' }, h('span', null, tr('Клиника')), Icon('ChevronRight', { size: 12 }), h('b', null, floor.name || '')),
        h('div', { class: 'dash-card-right' }, strip,
            h('div', { class: 'dash-card-acts' },
                h('button', { class: 'btn btn-ghost btn-sm dash-act', type: 'button', onclick: () => api.openFloor(floor) }, Icon('Edit', { size: 13 }), ' ', tr('Этаж')),
                h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => api.openWizard(null, { floor_id: floor.id }) }, Icon('Plus', { size: 13 }), ' ', tr('Помещение'))))));

    const items = autoLayout(floorItems(state, floor.id));
    const canvas = h('div', { class: 'fp-canvas', tabindex: '0', 'aria-label': tr('План этажа') });
    const maxY = items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
    canvas.style.minHeight = Math.max(CANVAS_MIN_H, maxY + GRID * 4) + 'px';
    if (!items.length) {
        canvas.appendChild(h('div', { class: 'fp-canvas-empty' },
            h('div', null, tr('На этом этаже пока пусто')),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => api.openWizard(null, { floor_id: floor.id }) },
                Icon('Plus', { size: 13 }), ' ', tr('Добавить помещение'))));
    }
    for (const it of items) canvas.appendChild(tile(it, state, ctx, api, repaint));
    // Клавиатура: стрелки двигают выбранное, Delete — удаляет (с подтверждением).
    canvas.addEventListener('keydown', (e) => {
        const it = items.find((x) => keyOf(x) === plan.selKey);
        if (!it) return;
        const d = { ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID] }[e.key];
        if (d) { e.preventDefault(); savePlace(it, { x: it.x + d[0], y: it.y + d[1], w: it.w, h: it.h }, api); }
        if (e.key === 'Delete') { e.preventDefault(); api.confirmDelete(it.kind, { id: it.id, name: it.name }); }
    });
    canvas.addEventListener('click', (e) => { if (e.target === canvas) { plan.selKey = null; repaint(); } });
    box.appendChild(canvas);
    box.appendChild(legend(state, items, ctx));
    return box;
}

function legend(state, items, ctx) {
    const seen = new Map();
    for (const it of items) if (it.department_id != null) seen.set(String(it.department_id), ctx.deptName(it.department_id));
    if (!seen.size) return h('div');
    return h('div', { class: 'fp-legend' },
        ...[...seen.entries()].map(([id, name]) => h('span', { class: 'fp-legend-i ' + pastelFor('dept-' + id) }, h('i', null), name || '')));
}

/** Плитка помещения на плане: тянется, растягивается, открывает меню. */
function tile(it, state, ctx, api, repaint) {
    const on = plan.selKey === keyOf(it);
    const dim = !passesFilters(it, ctx);
    const docs = it.kind === 'room' ? ctx.doctorsIn(it.id) : [];
    const eq = ctx.equipmentOf(it);
    const free = it.kind === 'ward' ? it.beds.filter((b) => (b.status || 'free') === 'free').length : null;
    const el = h('div', {
        class: 'fp-room' + (it.kind === 'ward' ? ' fp-room--ward' : '') + (on ? ' is-on' : '') + (dim ? ' is-dim' : '')
            + (it.auto ? ' is-auto' : '') + (it.active ? '' : ' is-off') + ' ' + (it.department_id != null ? pastelFor('dept-' + it.department_id) : ''),
        role: 'button', tabindex: '0', 'data-key': keyOf(it),
        title: [it.name, ctx.deptName(it.department_id), docs.length ? trf('врачей: {n}', { n: docs.length }) : null].filter(Boolean).join(' · '),
        style: { left: it.x + 'px', top: it.y + 'px', width: it.w + 'px', height: it.h + 'px' },
        onclick: () => { plan.selKey = keyOf(it); repaint(); },
        oncontextmenu: (e) => { e.preventDefault(); plan.selKey = keyOf(it); openMenu(e, roomMenu(it, state, api, repaint)); },
    },
        h('div', { class: 'fp-room-top' },
            h('span', { class: 'fp-room-code' }, it.code || ''),
            h('span', { class: 'fp-room-dept' }, ctx.deptName(it.department_id) || '')),
        h('div', { class: 'fp-room-name' }, it.name || '—'),
        h('div', { class: 'fp-room-meta' },
            it.kind === 'ward'
                ? h('span', { class: 'fp-chip' }, Icon('Bed', { size: 11 }), ' ', trf('{free} / {total}', { free: free, total: it.beds.length }))
                : h('span', { class: 'fp-chip' }, Icon('Stethoscope', { size: 11 }), ' ', String(docs.length)),
            eq.length ? h('span', { class: 'fp-chip' }, Icon('Layers', { size: 11 }), ' ', String(eq.length)) : null,
            !it.active ? Tag(tr('выключено'), { kind: 'warn' }) : null),
        h('span', { class: 'fp-resize', title: tr('Растянуть') }),
    );
    attachDrag(el, it, api);
    return el;
}

// Перетаскивание и растягивание одним механизмом: указатель захватывается
// самой плиткой, поэтому события приходят ей и после выхода за её край.
function attachDrag(el, it, api) {
    let start = null;
    el.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        const resize = e.target && e.target.classList && e.target.classList.contains('fp-resize');
        start = { x: e.clientX, y: e.clientY, ox: it.x, oy: it.y, ow: it.w, oh: it.h, resize, moved: false };
        try { if (el.setPointerCapture) el.setPointerCapture(e.pointerId); } catch (_) { /* без захвата — тянем пока над плиткой */ }
        el.classList.add('is-drag');
    });
    el.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
        if (start.resize) {
            el.style.width = Math.max(MIN_W, start.ow + dx) + 'px';
            el.style.height = Math.max(MIN_H, start.oh + dy) + 'px';
        } else {
            el.style.left = Math.max(0, start.ox + dx) + 'px';
            el.style.top = Math.max(0, start.oy + dy) + 'px';
        }
    });
    const finish = async (e) => {
        if (!start) return;
        const s = start; start = null;
        el.classList.remove('is-drag');
        if (!s.moved) return;
        const dx = e.clientX - s.x, dy = e.clientY - s.y;
        const next = s.resize
            ? { x: s.ox, y: s.oy, w: Math.max(MIN_W, snap(s.ow + dx)), h: Math.max(MIN_H, snap(s.oh + dy)) }
            : { x: snap(s.ox + dx), y: snap(s.oy + dy), w: s.ow, h: s.oh };
        await savePlace(it, next, api);
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
}

/** Координаты — в базу, одной строкой; отказ возвращает плитку словами. */
export async function savePlace(it, next, api) {
    const table = it.kind === 'ward' ? 'wards' : 'rooms';
    const payload = { plan_x: snap(next.x), plan_y: snap(next.y), plan_w: Math.max(MIN_W, snap(next.w || DEFAULT_W)), plan_h: Math.max(MIN_H, snap(next.h || DEFAULT_H)) };
    const { error } = await supabase.from(table).update(payload).eq('id', it.id);
    if (error) { toast(trf('Положение не сохранилось: {msg}', { msg: error.message }), 'fail'); }
    await api.reload();
}

// ---- Карточка выбранного -----------------------------------------------------
function side(state, ctx, api, floors, repaint) {
    const box = h('div', { class: 'card fp-side' });
    const all = floorItems(state, plan.floorId);
    const it = all.find((x) => keyOf(x) === plan.selKey);
    if (!it) {
        const floor = floors.find((f) => String(f.id) === String(plan.floorId)) || {};
        box.appendChild(h('div', { class: 'card-header' }, h('h3', null, Icon('Layers', { size: 15 }), ' ', floor.name || '')));
        box.appendChild(h('div', { class: 'fp-side-body' },
            kv(tr('Помещения'), String(all.length)),
            kv(tr('Кабинеты'), String(all.filter((x) => x.kind === 'room').length)),
            kv(tr('Палаты'), String(all.filter((x) => x.kind === 'ward').length)),
            kv(tr('Врачи'), String(all.filter((x) => x.kind === 'room').reduce((n, x) => n + ctx.doctorsIn(x.id).length, 0))),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px' } }, tr('Выберите помещение на плане — здесь будут его врачи, оборудование и действия.'))));
        return box;
    }
    const docs = it.kind === 'room' ? ctx.doctorsIn(it.id) : [];
    const eq = ctx.equipmentOf(it);
    box.appendChild(h('div', { class: 'card-header' },
        h('h3', null, Icon(it.kind === 'ward' ? 'Bed' : 'Grid', { size: 15 }), ' ', (it.code ? it.code + ' · ' : '') + (it.name || '')),
        h('button', { class: 'btn btn-ghost btn-sm dash-act', type: 'button', onclick: () => api.openWizard(api.rowFor(it)) }, Icon('Edit', { size: 13 }), ' ', tr('Изменить'))));
    const body = h('div', { class: 'fp-side-body' });
    body.appendChild(h('div', { class: 'fp-crumbs fp-crumbs--sm' },
        h('span', null, tr('Клиника')), Icon('ChevronRight', { size: 11 }),
        h('span', null, (floors.find((f) => String(f.id) === String(it.raw.floor_id)) || {}).name || ''), Icon('ChevronRight', { size: 11 }),
        h('span', null, ctx.deptName(it.department_id) || tr('Без отделения')), Icon('ChevronRight', { size: 11 }),
        h('b', null, it.name || '')));
    body.appendChild(kv(tr('Отделение'), ctx.deptName(it.department_id) || '—'));
    body.appendChild(kv(tr('Тип'), ctx.typeLabel(it) || '—'));
    body.appendChild(kv(tr('Статус'), it.active ? tr('Работает') : tr('Выключено')));
    if (it.kind === 'ward') {
        const free = it.beds.filter((b) => (b.status || 'free') === 'free').length;
        body.appendChild(kv(tr('Койки'), trf('свободно {free} из {total}', { free, total: it.beds.length })));
    } else if (it.capacity) {
        body.appendChild(kv(tr('Вместимость'), String(it.capacity)));
    }
    // Врачи
    if (it.kind === 'room') {
        body.appendChild(h('div', { class: 'fp-sec' }, tr('Врачи'),
            h('button', { class: 'btn btn-ghost btn-sm dash-act', type: 'button', onclick: () => openDoctorPicker(it, state, ctx, api) },
                Icon('Plus', { size: 12 }), ' ', tr('Назначить врача'))));
        if (!docs.length) body.appendChild(h('div', { class: 'muted fp-none' }, tr('Врачи не назначены')));
        for (const d of docs) {
            body.appendChild(h('div', { class: 'fp-row' },
                h('span', { class: 'fp-av ' + pastelFor(d.id) }, (d.full_name || '?').split(/\s+/).map((p) => p[0] || '').join('').slice(0, 2).toUpperCase()),
                h('span', { class: 'fp-row-m' }, h('span', { class: 'fp-row-n' }, d.full_name || ''), h('span', { class: 'fp-row-s' }, d.specialty || '')),
                h('button', { class: 'btn btn-ghost btn-sm btn-icon', type: 'button', 'aria-label': tr('Снять назначение'), title: tr('Снять назначение'),
                    onclick: async () => { await api.assignDoctors(it.id, docs.filter((x) => x.id !== d.id).map((x) => x.id)); } },
                    Icon('X', { size: 13 }))));
        }
    }
    // Оборудование
    body.appendChild(h('div', { class: 'fp-sec' }, tr('Оборудование'),
        h('button', { class: 'btn btn-ghost btn-sm dash-act', type: 'button', onclick: () => openEquipmentPicker(it, state, api) },
            Icon('Plus', { size: 12 }), ' ', tr('Добавить оборудование'))));
    if (!eq.length) body.appendChild(h('div', { class: 'muted fp-none' }, tr('Оборудования нет')));
    for (const e of eq) {
        body.appendChild(h('div', { class: 'fp-row' },
            h('span', { class: 'fp-row-m' }, h('span', { class: 'fp-row-n' }, e.name || ''), h('span', { class: 'fp-row-s' }, trf('{n} шт.', { n: e.quantity || 1 }))),
            h('button', { class: 'btn btn-ghost btn-sm btn-icon', type: 'button', 'aria-label': tr('Убрать'), title: tr('Убрать'),
                onclick: async () => {
                    const { error } = await supabase.from('room_equipment').delete().eq('id', e.id);
                    if (error) toast(error.message, 'fail'); await api.reload();
                } }, Icon('X', { size: 13 }))));
    }
    // Действия
    body.appendChild(h('div', { class: 'fp-actions' },
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openMoveFloor(it, state, api) }, Icon('Move', { size: 13 }), ' ', tr('Перенести на этаж')),
        h('button', { class: 'btn btn-outline btn-sm rs-del', type: 'button', onclick: () => api.confirmDelete(it.kind, { id: it.id, name: it.name }) }, Icon('Trash', { size: 13 }), ' ', tr('Удалить'))));
    box.appendChild(body);
    return box;
}

function kv(k, v) {
    return h('div', { class: 'fp-kv' }, h('span', { class: 'fp-kv-k' }, k), h('span', { class: 'fp-kv-v' }, v));
}

// ---- Меню по правой кнопке ---------------------------------------------------
function openMenu(e, entries) {
    closeMenu();
    const menu = h('div', { class: 'fp-menu', role: 'menu' },
        ...entries.map((m) => h('button', { type: 'button', role: 'menuitem', class: 'fp-menu-i' + (m.danger ? ' is-danger' : ''),
            onclick: () => { closeMenu(); m.run(); } }, m.icon ? Icon(m.icon, { size: 13 }) : null, ' ', m.label)));
    menu.style.left = (e.clientX || 0) + 'px';
    menu.style.top = (e.clientY || 0) + 'px';
    document.body.appendChild(menu);
    plan.menuEl = menu;
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { if (plan.menuEl) { plan.menuEl.remove(); plan.menuEl = null; } }

function roomMenu(it, state, api, repaint) {
    return [
        { label: tr('Изменить'), icon: 'Edit', run: () => api.openWizard(api.rowFor(it)) },
        it.kind === 'room' ? { label: tr('Назначить врача'), icon: 'Stethoscope', run: () => openDoctorPicker(it, state, null, api) } : null,
        { label: tr('Оборудование'), icon: 'Layers', run: () => openEquipmentPicker(it, state, api) },
        { label: tr('Перенести на этаж'), icon: 'Move', run: () => openMoveFloor(it, state, api) },
        { label: tr('Удалить'), icon: 'Trash', danger: true, run: () => api.confirmDelete(it.kind, { id: it.id, name: it.name }) },
    ].filter(Boolean);
}
function floorMenu(f, api) {
    return [
        { label: tr('Изменить'), icon: 'Edit', run: () => api.openFloor(f) },
        { label: tr('Добавить помещение'), icon: 'Plus', run: () => api.openWizard(null, { floor_id: f.id }) },
    ];
}

// ---- Окна: врачи, оборудование, перенос --------------------------------------
function openDoctorPicker(it, state, _ctx, api) {
    const m = api.modal(tr('Назначить врача'));
    const picked = new Set(state.doctors.filter((d) => String(d.room_id) === String(it.id)).map((d) => String(d.id)));
    const list = h('div', { class: 'rs-docs' });
    const q = h('input', { type: 'search', class: 'inp', placeholder: tr('Поиск врача…'), oninput: () => paint() });
    function paint() {
        clear(list);
        const s = (q.value || '').toLowerCase();
        for (const d of state.doctors) {
            if (s && !((d.full_name || '') + ' ' + (d.specialty || '')).toLowerCase().includes(s)) continue;
            const cb = h('input', { type: 'checkbox', checked: picked.has(String(d.id)),
                onchange: (e) => { if (e.target.checked) picked.add(String(d.id)); else picked.delete(String(d.id)); } });
            const elsewhere = d.room_id != null && String(d.room_id) !== String(it.id);
            list.appendChild(h('label', { class: 'rs-doc' }, cb, h('span', null, d.full_name || '', d.specialty ? h('span', { class: 'muted' }, ' · ' + d.specialty) : null,
                elsewhere ? h('span', { class: 'muted' }, ' · ', trf('сейчас: {room}', { room: (state.rooms.find((r) => String(r.id) === String(d.room_id)) || {}).name || '—' })) : null)));
        }
        if (!list.children.length) list.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Ничего не найдено')));
    }
    paint();
    m.bodyEl.appendChild(field(tr('Врачи'), h('div', null, q, list), { hint: tr('Врач может сидеть только в одном кабинете — отметка здесь переносит его сюда.') }));
    m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: m.close }, tr('Отмена')));
    const btn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: async () => {
        btn.disabled = true;
        try { await api.assignDoctors(it.id, [...picked].map(Number)); toast(tr('Врачи назначены.'), 'ok'); m.close(); }
        catch (e) { toast((e && e.message) || tr('Не удалось сохранить.'), 'fail'); btn.disabled = false; }
    } }, tr('Назначить'));
    m.footEl.appendChild(btn);
}

function openEquipmentPicker(it, state, api) {
    const m = api.modal(tr('Добавить оборудование'));
    const d = { equipment_id: '', name: '', quantity: 1 };
    const sel = h('select', { onchange: (e) => { d.equipment_id = e.target.value; } },
        h('option', { value: '' }, tr('Новое оборудование…')),
        ...(state.equipment || []).map((e) => h('option', { value: String(e.id) }, e.name || '')));
    const name = h('input', { class: 'inp', placeholder: tr('Например, ЭКГ-аппарат'), oninput: (e) => { d.name = e.target.value; } });
    const qty = h('input', { class: 'inp', type: 'number', min: '1', value: '1', oninput: (e) => { d.quantity = e.target.value; } });
    m.bodyEl.appendChild(field(tr('Из справочника'), sel));
    m.bodyEl.appendChild(field(tr('Название оборудования'), name, { hint: tr('Если в справочнике нет — впишите, оно появится в нём.') }));
    m.bodyEl.appendChild(field(tr('Количество'), qty));
    m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: m.close }, tr('Отмена')));
    const btn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: async () => {
        btn.disabled = true;
        try {
            let eqId = d.equipment_id ? Number(d.equipment_id) : null;
            if (!eqId) {
                const nm = (d.name || '').trim();
                if (!nm) throw new Error(tr('Укажите название.'));
                const { data, error } = await supabase.from('equipment').insert({ name: nm, active: 1 }).select('id').single();
                if (error) throw new Error(error.message);
                eqId = data.id;
            }
            const link = { equipment_id: eqId, quantity: Math.max(1, parseInt(d.quantity, 10) || 1) };
            if (it.kind === 'ward') link.ward_id = it.id; else link.room_id = it.id;
            const { error } = await supabase.from('room_equipment').insert(link);
            if (error) throw new Error(error.message);
            toast(tr('Оборудование добавлено.'), 'ok');
            m.close(); await api.reload();
        } catch (e) { toast((e && e.message) || tr('Не удалось сохранить.'), 'fail'); btn.disabled = false; }
    } }, tr('Добавить'));
    m.footEl.appendChild(btn);
}

function openMoveFloor(it, state, api) {
    const m = api.modal(tr('Перенести на этаж'));
    const d = { floor_id: it.raw.floor_id == null ? '' : String(it.raw.floor_id), department_id: it.department_id == null ? '' : String(it.department_id) };
    const fl = h('select', { onchange: (e) => { d.floor_id = e.target.value; } },
        ...state.floors.map((f) => h('option', { value: String(f.id), selected: d.floor_id === String(f.id) }, f.name || '')));
    const dp = h('select', { onchange: (e) => { d.department_id = e.target.value; } },
        h('option', { value: '' }, tr('Без отделения')),
        ...state.departments.map((x) => h('option', { value: String(x.id), selected: d.department_id === String(x.id) }, x.name || '')));
    m.bodyEl.appendChild(field(tr('Этаж'), fl));
    m.bodyEl.appendChild(field(tr('Отделение'), dp));
    m.footEl.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: m.close }, tr('Отмена')));
    const btn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: async () => {
        btn.disabled = true;
        try {
            const table = it.kind === 'ward' ? 'wards' : 'rooms';
            // На новом этаже плитка раскладывается заново: старые координаты там ничего не значат.
            const payload = { floor_id: d.floor_id ? Number(d.floor_id) : null, department_id: d.department_id ? Number(d.department_id) : null, plan_x: 0, plan_y: 0, plan_w: 0, plan_h: 0 };
            const { error } = await supabase.from(table).update(payload).eq('id', it.id);
            if (error) throw new Error(error.message);
            if (payload.floor_id != null) plan.floorId = payload.floor_id;
            toast(tr('Перенесено.'), 'ok');
            m.close(); await api.reload();
        } catch (e) { toast((e && e.message) || tr('Не удалось сохранить.'), 'fail'); btn.disabled = false; }
    } }, tr('Перенести'));
    m.footEl.appendChild(btn);
}
