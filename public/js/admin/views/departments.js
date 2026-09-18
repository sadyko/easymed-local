// DEPARTMENTS_V1 (2026-09-18) — ОТДЕЛЫ: СПИСОК, ФОРМИРОВАНИЕ, КАРТОЧКА.
//
// Владелец: «Create department → Assign head → Link rooms → Form department →
// Dispense supplies → Track department resources». Порядок шагов — его же:
// «form department → select team → confirm cabinets → (план помещений)».
//
// ЭКРАН — ОДИН, БЕЗ ЛЕСЕНКИ МОДАЛОК. Список; «Сформировать отдел» открывает
// мастер на месте списка (четыре шага: Отдел → Команда → Помещения →
// Проверка); карточка отдела — тоже на месте, с вкладками Обзор / Помещения /
// Команда / Снабжение / История. Модалки остались только у коротких вопросов
// («переназначить?») и у двух диалогов склада, которые и так живут в Закупках.
//
// НИЧЕГО НЕ ПЕРЕЕЗЖАЕТ МОЛЧА. Сотрудник другого отдела или кабинет другого
// отдела в списках помечены «сейчас в: …»; галочка на них задаёт вопрос, и
// только «Перевести» / «Переназначить» кладёт их в подтверждённый список,
// который сервер (department_form) требует для такого перевода.
//
// ДАННЫЕ — ТОЛЬКО С СЕРВЕРА. Экран не говорит «сформирован», пока
// department_form не вернул карточку; остатки, выдачи и расход на пациентов —
// те же строки, что видят Склад и лист медсестры (stock_holdings,
// stock_movements), собранные вокруг отдела.
import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, field, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { openStockIssueModal, productSearch, issueUnitOf, inpStyle } from './stock-issue-modal.js';
import { fmtQty, numStyle } from './inventory-shared.js';

const KIND_LABEL = {
    clinical: 'Клинический', laboratory: 'Лаборатория', diagnostics: 'Диагностика',
    procedure: 'Процедурный', inpatient: 'Стационар', administrative: 'Административный',
};
const ROLE_LABEL = {
    admin: 'Администратор', registrar: 'Регистратор', doctor: 'Врач', cashier: 'Кассир', lab: 'Лаборант',
    nurse: 'Медсестра', inventory: 'Снабжение', callcenter: 'Колл-центр', head_doctor: 'Главный врач', senior_nurse: 'Старшая медсестра',
};
// Подписи типов помещений — те же слова, что в «Настройки → Помещения»
// (rooms-setup.js TYPES) плюс старые коды кабинетов, которые там не заводятся.
const SUBTYPE_LABEL = {
    consultation: 'Консультация', procedure: 'Процедурная', general: 'Палата (общая)', vip: 'VIP', pediatrics: 'Детская',
    isolation: 'Изолятор', maternity: 'Родильная', icu: 'ПИТ / реанимация', surgery: 'Операционная', diagnostics: 'Диагностика',
    lab: 'Лаборатория', laboratory: 'Лаборатория', utility: 'Хозяйственное', reception: 'Регистратура',
};
const subtypeOf = (p) => (p.subtype ? tr(SUBTYPE_LABEL[p.subtype] || p.subtype) : '');
const REQ_STATUS = { draft: 'Черновик', submitted: 'Подана', approved: 'Согласована', issued: 'Выдана', rejected: 'Отклонена', cancelled: 'Отменена' };

let refs = {};
const state = { mode: 'list', list: null, listError: '', showInactive: false, card: null, cardTab: 'overview', cardError: '', draft: null, options: null };

async function rpc(name, args) {
    const { data, error } = await supabase.rpc(name, args || {});
    if (error) throw error;
    return data;
}

const roleOf = (u) => u.position || ROLE_LABEL[u.role] || u.role || '';
const staffLine = (u) => [roleOf(u), u.specialty].filter(Boolean).join(' · ');
const placeKind = (p) => (p.type === 'ward' ? tr('Палата') : tr('Кабинет'));
const placeLabel = (p) => (p.code && p.code !== p.name ? `${p.name} (${p.code})` : p.name);

// ---------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------
export async function renderDepartments(container, { onNavigate, payload, tabId } = {}) {
    clear(container);
    refs = { root: h('div', { class: 'fade-in dept' }), onNavigate: onNavigate || null, tabId: tabId || null };
    container.appendChild(refs.root);
    const sub = payload && typeof payload.sub === 'string' ? payload.sub : null;
    if (sub === 'new') { state.mode = 'wizard'; state.draft = null; }
    else if (sub && /^\d+$/.test(sub)) { state.mode = 'card'; state.cardId = Number(sub); }
    else state.mode = 'list';
    await paint();
}

function setSub(sub) {
    if (refs.tabId && typeof window.easymedSetTabSub === 'function') window.easymedSetTabSub(refs.tabId, sub);
    try { history.replaceState(null, '', '#departments' + (sub ? '/' + sub : '')); } catch { /* без истории */ }
}

async function paint() {
    clear(refs.root);
    if (state.mode === 'wizard') return paintWizard();
    if (state.mode === 'card') return paintCard();
    return paintList();
}

// ---------------------------------------------------------------------------
// Список
// ---------------------------------------------------------------------------
async function paintList() {
    const root = refs.root;
    const right = [];
    root.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    try {
        state.list = await rpc('department_list', { include_inactive: state.showInactive });
        state.listError = '';
    } catch (e) {
        state.list = null; state.listError = (e && e.message) || '';
    }
    clear(root);
    if (state.list && state.list.can_form) {
        right.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openWizard(null) }, Icon('Plus', { size: 14 }), ' ', tr('Сформировать отдел')));
    }
    root.appendChild(PageHead({
        title: 'Отделы',
        subtitle: 'Руководитель, команда, помещения и снабжение каждого отдела. Отдел — это имя, вокруг которого собираются люди, кабинеты и выданный товар.',
        right,
    }));
    if (!state.list) {
        root.appendChild(h('div', { class: 'empty' }, trf('Не удалось загрузить отделы: {msg}', { msg: state.listError }),
            h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn btn-sm', type: 'button', onclick: paint }, 'Повторить'))));
        return;
    }
    const rows = state.list.departments;
    const toggle = h('label', { class: 'dept-toggle muted' },
        h('input', { type: 'checkbox', checked: state.showInactive ? true : null, onchange: (e) => { state.showInactive = !!e.target.checked; paint(); } }),
        ' ', tr('Показать выключенные'));
    root.appendChild(h('div', { class: 'dept-tools' },
        h('span', { class: 'muted' }, trf('Отделов: {n}', { n: rows.length })),
        h('span', { class: 'grow' }), toggle));
    if (!rows.length) {
        root.appendChild(h('div', { class: 'empty' }, state.list.sees_all ? tr('Отделов пока нет — сформируйте первый.') : tr('Вы пока не состоите ни в одном отделе.')));
        return;
    }
    const tbody = h('tbody');
    for (const d of rows) {
        const places = (d.rooms || 0) + (d.wards || 0);
        tbody.appendChild(h('tr', { class: 'clickable-row' + (d.active ? '' : ' is-off'), onclick: () => openCard(d.id) },
            h('td', null, h('div', { class: 'dept-name' }, d.name), d.code ? h('div', { class: 'muted' }, d.code) : null),
            h('td', null, tr(KIND_LABEL[d.kind] || d.kind || '')),
            h('td', null, d.head ? h('div', null, h('div', null, d.head.full_name), h('div', { class: 'muted' }, staffLine(d.head))) : h('span', { class: 'muted' }, 'Не назначен')),
            h('td', { class: 'num' }, places ? String(places) : h('span', { class: 'muted' }, '—')),
            h('td', { class: 'num' }, d.members ? String(d.members) : h('span', { class: 'muted' }, '—')),
            h('td', { class: 'num' }, d.held_products ? String(d.held_products) : h('span', { class: 'muted' }, '—')),
            h('td', null, d.active ? h('span', { class: 'tag tag-ok' }, 'Работает') : h('span', { class: 'tag' }, 'Выключен')),
        ));
    }
    root.appendChild(h('div', { class: 'card', style: { overflowX: 'auto' } },
        h('table', { class: 'list' },
            h('thead', null, h('tr', null,
                h('th', null, 'Отдел'), h('th', null, 'Вид'), h('th', null, 'Руководитель'),
                h('th', { class: 'num' }, 'Помещений'), h('th', { class: 'num' }, 'Команда'), h('th', { class: 'num' }, 'Товаров на руках'), h('th', null, 'Статус'))),
            tbody)));
}

// ---------------------------------------------------------------------------
// Мастер: Отдел → Команда → Помещения → Проверка → «Сформировать отдел»
// ---------------------------------------------------------------------------
function emptyDraft() {
    return { id: null, name: '', code: '', kind: 'clinical', active: true, head: null, members: new Map(), reassignMembers: new Set(), places: new Map(), reassignPlaces: new Set(), step: 0 };
}

async function openWizard(card) {
    state.mode = 'wizard';
    const d = emptyDraft();
    if (card) {
        d.id = card.department.id; d.name = card.department.name; d.code = card.department.code || '';
        d.kind = card.department.kind; d.active = card.department.active; d.head = card.department.head || null;
        for (const m of card.members) d.members.set(m.id, m);
        for (const p of card.places) d.places.set(`${p.type}:${p.id}`, p);
    }
    state.draft = d;
    setSub(card ? String(card.department.id) : 'new');
    await paint();
}

async function loadOptions() {
    if (state.options) return state.options;
    const [staff, places] = await Promise.all([rpc('department_staff_options', {}), rpc('department_place_options', {})]);
    state.options = { staff: staff.staff || [], floors: places.floors || [], places: places.places || [] };
    return state.options;
}

const STEPS = ['Отдел', 'Команда', 'Помещения', 'Проверка'];

async function paintWizard() {
    const root = refs.root;
    const d = state.draft;
    root.appendChild(PageHead({ title: d.id ? 'Изменить отдел' : 'Сформировать отдел', subtitle: 'Четыре шага: сам отдел и руководитель, команда, помещения, проверка перед подтверждением.' }));
    root.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    let opts;
    try { opts = await loadOptions(); }
    catch (e) {
        clear(root);
        root.appendChild(h('div', { class: 'empty' }, trf('Не удалось загрузить справочники: {msg}', { msg: (e && e.message) || '' })));
        return;
    }
    clear(root);
    root.appendChild(PageHead({ title: d.id ? 'Изменить отдел' : 'Сформировать отдел', subtitle: 'Четыре шага: сам отдел и руководитель, команда, помещения, проверка перед подтверждением.' }));

    const stepsBar = h('ol', { class: 'dept-steps' }, ...STEPS.map((s, i) =>
        h('li', { class: i === d.step ? 'is-on' : (i < d.step ? 'is-done' : ''), onclick: () => { if (i < d.step) { d.step = i; paint(); } } },
            h('span', { class: 'dept-step-n' }, String(i + 1)), h('span', null, s))));
    root.appendChild(stepsBar);

    const card = h('div', { class: 'card dept-wizard' });
    root.appendChild(card);
    const body = h('div', { class: 'dept-wizard-body' });
    card.appendChild(body);

    if (d.step === 0) body.appendChild(stepDepartment(d, opts));
    else if (d.step === 1) body.appendChild(stepTeam(d, opts));
    else if (d.step === 2) body.appendChild(stepPlaces(d, opts));
    else body.appendChild(stepReview(d, opts));

    const backBtn = h('button', { class: 'btn', type: 'button', onclick: () => { if (d.step === 0) cancelWizard(); else { d.step -= 1; paint(); } } },
        d.step === 0 ? tr('Отмена') : tr('Назад'));
    const nextBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => nextStep(d) },
        d.step === 3 ? (d.id ? tr('Сохранить изменения') : tr('Сформировать отдел')) : tr('Далее'));
    card.appendChild(h('div', { class: 'dept-wizard-foot' }, backBtn, h('span', { class: 'grow' }), nextBtn));
}

function cancelWizard() {
    if (state.draft && state.draft.id) { state.mode = 'card'; state.cardId = state.draft.id; setSub(String(state.draft.id)); }
    else { state.mode = 'list'; setSub(null); }
    state.draft = null;
    paint();
}

function nextStep(d) {
    if (d.step === 0) {
        if (!d.name.trim()) { toast('Назовите отдел.', 'fail'); return; }
    }
    if (d.step < 3) { d.step += 1; paint(); return; }
    submitWizard(d);
}

async function submitWizard(d) {
    const btns = refs.root.querySelectorAll('.dept-wizard-foot button');
    btns.forEach((b) => { b.disabled = true; });
    try {
        const res = await rpc('department_form', {
            id: d.id, name: d.name.trim(), code: d.code.trim(), kind: d.kind, active: d.active,
            head_user_id: d.head ? d.head.id : null,
            member_ids: [...d.members.keys()],
            reassign_member_ids: [...d.reassignMembers],
            places: [...d.places.values()].map((p) => ({ type: p.type, id: p.id })),
            reassign_places: [...d.reassignPlaces].map((k) => { const [type, id] = k.split(':'); return { type, id: Number(id) }; }),
        });
        state.options = null;   // отделы изменились — справочники устарели
        toast(d.id ? 'Отдел сохранён' : 'Отдел сформирован', 'ok');
        state.draft = null;
        state.mode = 'card'; state.cardId = res.department_id; state.card = res.card; state.cardTab = 'overview'; state.justFormed = !d.id;
        setSub(String(res.department_id));
        await paint();
    } catch (e) {
        toast((e && e.message) || 'Не удалось сохранить отдел.', 'fail');
        btns.forEach((b) => { b.disabled = false; });
    }
}

// --- Шаг 1: отдел и руководитель --------------------------------------------
function stepDepartment(d, opts) {
    const nameInp = h('input', { type: 'text', value: d.name, placeholder: 'Например: Кардиология', style: inpStyle });
    nameInp.addEventListener('input', () => { d.name = nameInp.value; });
    const codeInp = h('input', { type: 'text', value: d.code, placeholder: 'Например: CARD', style: inpStyle });
    codeInp.addEventListener('input', () => { d.code = codeInp.value; });
    const kindSel = h('select', { style: inpStyle }, ...Object.entries(KIND_LABEL).map(([v, l]) => h('option', { value: v, selected: d.kind === v ? true : null }, l)));
    kindSel.addEventListener('change', () => { d.kind = kindSel.value; });
    const activeChk = h('input', { type: 'checkbox', checked: d.active ? true : null });
    activeChk.addEventListener('change', () => { d.active = !!activeChk.checked; });

    // Руководитель — врач или медсестра; поиск по имени, в строке — должность и текущий отдел.
    const headHost = h('div');
    const paintHead = () => {
        clear(headHost);
        if (d.head) {
            headHost.appendChild(h('div', { class: 'dept-pick' },
                h('div', null, h('div', { class: 'dept-name' }, d.head.full_name), h('div', { class: 'muted' }, staffLine(d.head))),
                h('span', { class: 'grow' }),
                h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { d.head = null; paintHead(); } }, 'Сменить')));
            return;
        }
        headHost.appendChild(staffPicker(opts.staff.filter((u) => u.eligible_head), {
            placeholder: 'Найти врача или медсестру…',
            onChoose: async (u) => {
                if (u.department_id && (!d.id || u.department_id !== d.id) && !d.members.has(u.id)) {
                    const ok = await askConfirm({
                        title: 'Перевести сотрудника?',
                        text: trf('{name} сейчас в отделе «{dept}». Руководитель всегда входит в команду — перевести в этот отдел?', { name: u.full_name, dept: u.department_name }),
                        okLabel: 'Перевести',
                    });
                    if (!ok) return;
                    d.reassignMembers.add(u.id);
                }
                d.head = u; d.members.set(u.id, u); paintHead();
            },
        }));
        headHost.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } }, 'Руководителем может быть врач или медсестра. Можно оставить пустым и назначить позже.'));
    };
    paintHead();

    return h('div', { class: 'dept-form' },
        field('Название отдела', nameInp, { required: true }),
        h('div', { class: 'dept-two' }, field('Код (необязательно)', codeInp), field('Вид', kindSel)),
        field('Руководитель', headHost),
        h('div', { class: 'field checkbox' }, activeChk, h('label', null, 'Отдел работает')));
}

/** Поиск по сотрудникам: поле + список совпадений с должностью и текущим отделом. */
function staffPicker(staff, { placeholder, onChoose, excludeIds = () => new Set() }) {
    const inp = h('input', { type: 'text', placeholder, style: inpStyle, autocomplete: 'off' });
    const drop = h('div', { class: 'sim-drop', hidden: true });
    function paintDrop() {
        const q = inp.value.trim().toLowerCase();
        clear(drop);
        const taken = excludeIds();
        const found = staff.filter((u) => !taken.has(u.id) && (!q || (u.full_name || '').toLowerCase().includes(q))).slice(0, 8);
        if (!found.length) { drop.appendChild(h('div', { class: 'sim-drop-empty muted' }, 'Ничего не найдено')); drop.hidden = false; return; }
        for (const u of found) {
            drop.appendChild(h('button', { type: 'button', class: 'sim-drop-item', onclick: () => { drop.hidden = true; inp.value = ''; onChoose(u); } },
                h('span', { class: 'sim-drop-name' }, u.full_name, h('span', { class: 'muted' }, staffLine(u) ? ' · ' + staffLine(u) : '')),
                u.department_name ? h('span', { class: 'sim-drop-avail muted' }, trf('сейчас в: {dept}', { dept: u.department_name })) : null));
        }
        drop.hidden = false;
    }
    inp.addEventListener('input', paintDrop);
    inp.addEventListener('focus', paintDrop);
    inp.addEventListener('blur', () => setTimeout(() => { drop.hidden = true; }, 150));
    return h('div', { class: 'dept-picker' }, inp, drop);
}

// --- Шаг 2: команда -----------------------------------------------------------
function stepTeam(d, opts) {
    const listHost = h('div', { class: 'dept-check-list' });
    const q = h('input', { type: 'text', placeholder: 'Найти сотрудника…', style: inpStyle });
    q.addEventListener('input', paintRows);

    function paintRows() {
        clear(listHost);
        const needle = q.value.trim().toLowerCase();
        const rows = opts.staff.filter((u) => !needle || (u.full_name || '').toLowerCase().includes(needle));
        if (!rows.length) { listHost.appendChild(h('div', { class: 'muted', style: { padding: '10px' } }, 'Ничего не найдено')); return; }
        for (const u of rows) {
            const on = d.members.has(u.id);
            const isHead = d.head && d.head.id === u.id;
            const foreign = u.department_id && u.department_id !== d.id;
            const chk = h('input', { type: 'checkbox', checked: on ? true : null, disabled: isHead ? true : null });
            chk.addEventListener('change', async () => {
                if (!chk.checked) { d.members.delete(u.id); d.reassignMembers.delete(u.id); paintRows(); return; }
                if (foreign) {
                    const ok = await askConfirm({ title: 'Перевести сотрудника?', text: trf('{name} сейчас в отделе «{dept}». Перевести в этот отдел?', { name: u.full_name, dept: u.department_name }), okLabel: 'Перевести' });
                    if (!ok) { chk.checked = false; return; }
                    d.reassignMembers.add(u.id);
                }
                d.members.set(u.id, u); paintRows();
            });
            listHost.appendChild(h('label', { class: 'dept-check-row' + (on ? ' is-on' : '') },
                chk,
                h('span', { class: 'dept-check-main' }, h('span', { class: 'dept-name' }, u.full_name, isHead ? h('span', { class: 'tag tag-ok', style: { marginLeft: '8px' } }, 'руководитель') : null),
                    h('span', { class: 'muted' }, staffLine(u))),
                foreign ? h('span', { class: 'dept-foreign' }, trf('сейчас в: {dept}', { dept: u.department_name })) : null));
        }
    }
    paintRows();
    return h('div', { class: 'dept-form' },
        h('div', { class: 'muted' }, 'Отметьте сотрудников отдела. Сотрудник состоит в одном отделе: кто сейчас в другом, перейдёт сюда только после вашего подтверждения.'),
        q, listHost,
        h('div', { class: 'muted' }, trf('Выбрано: {n}', { n: d.members.size })));
}

// --- Шаг 3: помещения по этажам ----------------------------------------------
function stepPlaces(d, opts) {
    const host = h('div');
    function paintRows() {
        clear(host);
        const byFloor = new Map();
        for (const p of opts.places) {
            const k = p.floor_id || 0;
            if (!byFloor.has(k)) byFloor.set(k, []);
            byFloor.get(k).push(p);
        }
        const floors = [...opts.floors.map((f) => ({ id: f.id, name: f.name })), { id: 0, name: tr('Без этажа') }].filter((f) => byFloor.has(f.id));
        if (!floors.length) { host.appendChild(h('div', { class: 'empty' }, 'Помещений пока нет — заведите кабинеты и палаты в «Настройки → Помещения».')); return; }
        for (const f of floors) {
            const rows = byFloor.get(f.id);
            const group = h('div', { class: 'dept-floor' }, h('div', { class: 'dept-floor-name' }, f.name));
            for (const p of rows) {
                const key = `${p.type}:${p.id}`;
                const on = d.places.has(key);
                const foreign = p.department_id && p.department_id !== d.id;
                const chk = h('input', { type: 'checkbox', checked: on ? true : null });
                chk.addEventListener('change', async () => {
                    if (!chk.checked) { d.places.delete(key); d.reassignPlaces.delete(key); paintRows(); return; }
                    if (foreign) {
                        const ok = await askConfirm({ title: 'Переназначить помещение?', text: trf('{kind} «{name}» сейчас в отделе «{dept}». Переназначить в этот отдел?', { kind: placeKind(p), name: placeLabel(p), dept: p.department_name }), okLabel: 'Переназначить' });
                        if (!ok) { chk.checked = false; return; }
                        d.reassignPlaces.add(key);
                    }
                    d.places.set(key, p); paintRows();
                });
                group.appendChild(h('label', { class: 'dept-check-row' + (on ? ' is-on' : '') },
                    chk,
                    h('span', { class: 'dept-check-main' }, h('span', { class: 'dept-name' }, placeLabel(p)),
                        h('span', { class: 'muted' }, [placeKind(p), subtypeOf(p), p.type === 'ward' && p.beds ? trf('коек: {n}', { n: p.beds }) : ''].filter(Boolean).join(' · '))),
                    foreign ? h('span', { class: 'dept-foreign' }, trf('сейчас в: {dept}', { dept: p.department_name })) : null));
            }
            host.appendChild(group);
        }
    }
    paintRows();
    return h('div', { class: 'dept-form' },
        h('div', { class: 'muted' }, 'Отметьте кабинеты и палаты отдела. Помещение принадлежит одному отделу: занятое другим перейдёт сюда только после вашего подтверждения.'),
        host,
        h('div', { class: 'muted' }, trf('Выбрано: {n}', { n: d.places.size })));
}

// --- Шаг 4: проверка ------------------------------------------------------------
function stepReview(d, opts) {
    const floorName = (id) => { const f = opts.floors.find((x) => x.id === id); return f ? f.name : tr('Без этажа'); };
    const places = [...d.places.values()].sort((a, b) => (a.floor_id || 0) - (b.floor_id || 0) || String(a.name).localeCompare(String(b.name)));
    const members = [...d.members.values()];
    const row = (label, value) => h('div', { class: 'dept-review-row' }, h('div', { class: 'muted' }, label), h('div', null, value));
    return h('div', { class: 'dept-form dept-review' },
        row('Отдел', h('b', null, d.name.trim() || '—')),
        row('Вид', tr(KIND_LABEL[d.kind] || d.kind)),
        row('Руководитель', d.head ? `${d.head.full_name} · ${staffLine(d.head)}` : h('span', { class: 'muted' }, 'Не назначен')),
        row('Команда', members.length ? h('ul', { class: 'dept-review-list' }, ...members.map((u) => h('li', null, u.full_name, d.reassignMembers.has(u.id) ? h('span', { class: 'dept-foreign' }, ' — ' + tr('переводится')) : null))) : h('span', { class: 'muted' }, 'Пока никого')),
        row('Помещения', places.length ? h('ul', { class: 'dept-review-list' }, ...places.map((p) => h('li', null, `${floorName(p.floor_id)} · ${placeLabel(p)}`, d.reassignPlaces.has(`${p.type}:${p.id}`) ? h('span', { class: 'dept-foreign' }, ' — ' + tr('переназначается')) : null))) : h('span', { class: 'muted' }, 'Пока нет')),
        row('Статус', d.active ? tr('Работает') : tr('Выключен')),
        h('div', { class: 'muted' }, 'Нажмите «Сформировать отдел» — всё выше сохранится за один раз.'));
}

// ---------------------------------------------------------------------------
// Карточка
// ---------------------------------------------------------------------------
async function openCard(id) {
    state.mode = 'card'; state.cardId = id; state.cardTab = 'overview'; state.card = null;
    setSub(String(id));
    await paint();
}

async function reloadCard() {
    state.card = await rpc('department_card', { department_id: state.cardId });
}

async function paintCard() {
    const root = refs.root;
    root.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    if (!state.card || state.card.department.id !== state.cardId) {
        try { await reloadCard(); state.cardError = ''; }
        catch (e) { state.card = null; state.cardError = (e && e.message) || ''; }
    }
    clear(root);
    const c = state.card;
    const back = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => { state.mode = 'list'; state.card = null; setSub(null); paint(); } }, Icon('ChevronLeft', { size: 14 }), ' ', tr('К списку отделов'));
    if (!c) {
        root.appendChild(back);
        root.appendChild(h('div', { class: 'empty' }, trf('Не удалось открыть отдел: {msg}', { msg: state.cardError })));
        return;
    }
    const dpt = c.department;
    const right = [];
    if (c.can_form) right.push(h('button', { class: 'btn', type: 'button', onclick: () => openWizard(c) }, Icon('Edit', { size: 14 }), ' ', tr('Изменить')));
    root.appendChild(h('div', { style: { marginBottom: '10px' } }, back));
    root.appendChild(PageHead({
        title: dpt.name,
        subtitle: [tr(KIND_LABEL[dpt.kind] || dpt.kind), dpt.code, dpt.active ? tr('работает') : tr('выключен')].filter(Boolean).join(' · '),
        right,
    }));
    if (state.justFormed) {
        state.justFormed = false;
        root.appendChild(h('div', { class: 'dept-banner' },
            Icon('Check', { size: 15 }), ' ', tr('Отдел сформирован.'), ' ',
            h('button', { class: 'link-btn', type: 'button', onclick: () => refs.onNavigate && refs.onNavigate('rooms-setup') }, 'Расставить помещения на плане')));
    }

    const tabs = [['overview', 'Обзор'], ['places', 'Помещения'], ['team', 'Команда'], ['supply', 'Снабжение'], ['history', 'История']];
    const counts = { places: c.places.length, team: c.members.length, supply: c.holdings.length, history: c.events.length };
    root.appendChild(h('div', { class: 'tabs', style: { marginBottom: '14px' } }, ...tabs.map(([id, label]) =>
        h('button', { class: 'tab' + (state.cardTab === id ? ' on' : ''), type: 'button', onclick: () => { state.cardTab = id; paint(); } },
            tr(label), counts[id] ? h('span', { class: 'tab-count' }, String(counts[id])) : null))));

    const body = h('div');
    root.appendChild(body);
    if (state.cardTab === 'overview') body.appendChild(cardOverview(c));
    else if (state.cardTab === 'places') body.appendChild(cardPlaces(c));
    else if (state.cardTab === 'team') body.appendChild(cardTeam(c));
    else if (state.cardTab === 'supply') body.appendChild(cardSupply(c));
    else body.appendChild(cardHistory(c));
}

function cardOverview(c) {
    const dpt = c.department;
    const row = (label, value) => h('div', { class: 'dept-review-row' }, h('div', { class: 'muted' }, label), h('div', null, value));
    const headCell = h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
        dpt.head ? h('div', null, h('div', null, dpt.head.full_name), h('div', { class: 'muted' }, staffLine(dpt.head))) : h('span', { class: 'muted' }, 'Не назначен'),
        c.can_form ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => changeHead(c) }, dpt.head ? tr('Сменить') : tr('Назначить')) : null);
    return h('div', { class: 'card dept-overview' },
        row('Руководитель', headCell),
        row('Вид', tr(KIND_LABEL[dpt.kind] || dpt.kind)),
        row('Код', dpt.code || h('span', { class: 'muted' }, '—')),
        row('Команда', trf('{n} чел.', { n: c.members.length })),
        row('Помещения', c.places.length ? trf('{n} — кабинетов {r}, палат {w}', { n: c.places.length, r: c.places.filter((p) => p.type === 'room').length, w: c.places.filter((p) => p.type === 'ward').length }) : h('span', { class: 'muted' }, 'Пока нет')),
        row('На руках', c.holdings.length ? trf('{n} наименований', { n: c.holdings.length }) : h('span', { class: 'muted' }, 'Ничего не выдано')),
        row('Статус', dpt.active ? tr('Работает') : tr('Выключен')),
        row('Создан', fmtDateTime(dpt.created_at)));
}

async function changeHead(c) {
    const opts = await loadOptions().catch(() => null);
    if (!opts) { toast('Не удалось загрузить сотрудников.', 'fail'); return; }
    const picked = await pickOne({
        title: 'Руководитель отдела',
        text: 'Врач или медсестра. Руководитель всегда входит в команду отдела.',
        picker: (onChoose) => staffPicker(opts.staff.filter((u) => u.eligible_head), { placeholder: 'Найти врача или медсестру…', onChoose }),
        clearLabel: c.department.head ? 'Снять руководителя' : null,
    });
    if (picked === undefined) return;
    try {
        const u = picked;
        let reassign = false;
        if (u && u.department_id && u.department_id !== c.department.id) {
            reassign = await askConfirm({ title: 'Перевести сотрудника?', text: trf('{name} сейчас в отделе «{dept}». Руководитель всегда входит в команду — перевести в этот отдел?', { name: u.full_name, dept: u.department_name }), okLabel: 'Перевести' });
            if (!reassign) return;
        }
        state.card = await rpc('department_head_set', { department_id: c.department.id, user_id: u ? u.id : null, reassign });
        state.options = null;
        toast(u ? 'Руководитель назначен' : 'Руководитель снят', 'ok');
        paint();
    } catch (e) { toast((e && e.message) || 'Не удалось.', 'fail'); }
}

function cardPlaces(c) {
    const floorName = (id) => { const f = c.floors.find((x) => x.id === id); return f ? f.name : tr('Без этажа'); };
    const byFloor = new Map();
    for (const p of c.places) { const k = p.floor_id || 0; if (!byFloor.has(k)) byFloor.set(k, []); byFloor.get(k).push(p); }
    const host = h('div', { class: 'card' });
    if (c.can_form) host.appendChild(h('div', { class: 'dept-tools' }, h('span', { class: 'grow' }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => addPlace(c) }, Icon('Plus', { size: 13 }), ' ', tr('Добавить помещение'))));
    if (!c.places.length) { host.appendChild(h('div', { class: 'empty' }, 'У отдела пока нет помещений.')); return host; }
    for (const [fid, rows] of [...byFloor.entries()].sort((a, b) => a[0] - b[0])) {
        const group = h('div', { class: 'dept-floor' }, h('div', { class: 'dept-floor-name' }, floorName(fid)));
        for (const p of rows) {
            group.appendChild(h('div', { class: 'dept-check-row is-static' },
                h('span', { class: 'dept-check-main' }, h('span', { class: 'dept-name' }, placeLabel(p)),
                    h('span', { class: 'muted' }, [placeKind(p), subtypeOf(p), p.type === 'ward' && p.beds ? trf('коек: {n}', { n: p.beds }) : ''].filter(Boolean).join(' · '))),
                c.can_form ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => {
                    const ok = await askConfirm({ title: 'Снять помещение?', text: trf('{kind} «{name}» перестанет принадлежать отделу «{dept}».', { kind: placeKind(p), name: placeLabel(p), dept: c.department.name }), okLabel: 'Снять' });
                    if (!ok) return;
                    try { state.card = await rpc('department_place_set', { department_id: c.department.id, type: p.type, id: p.id, on: false }); state.options = null; paint(); }
                    catch (e) { toast((e && e.message) || 'Не удалось.', 'fail'); }
                } }, 'Снять') : null));
        }
        host.appendChild(group);
    }
    return host;
}

async function addPlace(c) {
    const opts = await loadOptions().catch(() => null);
    if (!opts) { toast('Не удалось загрузить помещения.', 'fail'); return; }
    const free = opts.places.filter((p) => p.department_id !== c.department.id);
    const picked = await pickOne({
        title: 'Добавить помещение',
        text: 'Кабинет или палата. Занятое другим отделом перейдёт сюда только после подтверждения.',
        picker: (onChoose) => placePicker(free, opts.floors, onChoose),
    });
    if (!picked) return;
    try {
        let reassign = false;
        if (picked.department_id) {
            reassign = await askConfirm({ title: 'Переназначить помещение?', text: trf('{kind} «{name}» сейчас в отделе «{dept}». Переназначить в этот отдел?', { kind: placeKind(picked), name: placeLabel(picked), dept: picked.department_name }), okLabel: 'Переназначить' });
            if (!reassign) return;
        }
        state.card = await rpc('department_place_set', { department_id: c.department.id, type: picked.type, id: picked.id, on: true, reassign });
        state.options = null;
        toast('Помещение добавлено', 'ok');
        paint();
    } catch (e) { toast((e && e.message) || 'Не удалось.', 'fail'); }
}

function placePicker(places, floors, onChoose) {
    const floorName = (id) => { const f = floors.find((x) => x.id === id); return f ? f.name : tr('Без этажа'); };
    const inp = h('input', { type: 'text', placeholder: 'Найти кабинет или палату…', style: inpStyle, autocomplete: 'off' });
    const drop = h('div', { class: 'sim-drop', hidden: true });
    function paintDrop() {
        const q = inp.value.trim().toLowerCase();
        clear(drop);
        const found = places.filter((p) => !q || (p.name || '').toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q)).slice(0, 10);
        if (!found.length) { drop.appendChild(h('div', { class: 'sim-drop-empty muted' }, 'Ничего не найдено')); drop.hidden = false; return; }
        for (const p of found) {
            drop.appendChild(h('button', { type: 'button', class: 'sim-drop-item', onclick: () => { drop.hidden = true; onChoose(p); } },
                h('span', { class: 'sim-drop-name' }, placeLabel(p), h('span', { class: 'muted' }, ' · ' + placeKind(p) + ' · ' + floorName(p.floor_id))),
                p.department_name ? h('span', { class: 'sim-drop-avail muted' }, trf('сейчас в: {dept}', { dept: p.department_name })) : null));
        }
        drop.hidden = false;
    }
    inp.addEventListener('input', paintDrop);
    inp.addEventListener('focus', paintDrop);
    inp.addEventListener('blur', () => setTimeout(() => { drop.hidden = true; }, 150));
    return h('div', { class: 'dept-picker' }, inp, drop);
}

function cardTeam(c) {
    const host = h('div', { class: 'card' });
    if (c.can_form) host.appendChild(h('div', { class: 'dept-tools' }, h('span', { class: 'grow' }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => addMember(c) }, Icon('Plus', { size: 13 }), ' ', tr('Добавить сотрудника'))));
    if (!c.members.length) { host.appendChild(h('div', { class: 'empty' }, 'В отделе пока никого.')); return host; }
    const tbody = h('tbody');
    for (const u of c.members) {
        const isHead = c.department.head && c.department.head.id === u.id;
        tbody.appendChild(h('tr', null,
            h('td', null, u.full_name, isHead ? h('span', { class: 'tag tag-ok', style: { marginLeft: '8px' } }, 'руководитель') : null),
            h('td', null, roleOf(u)),
            h('td', null, u.specialty || h('span', { class: 'muted' }, '—')),
            h('td', { style: { textAlign: 'right' } }, c.can_form && !isHead ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => {
                const ok = await askConfirm({ title: 'Убрать из отдела?', text: trf('{name} перестанет числиться в отделе «{dept}».', { name: u.full_name, dept: c.department.name }), okLabel: 'Убрать' });
                if (!ok) return;
                try { state.card = await rpc('department_member_set', { department_id: c.department.id, user_id: u.id, on: false }); state.options = null; paint(); }
                catch (e) { toast((e && e.message) || 'Не удалось.', 'fail'); }
            } }, 'Убрать') : null)));
    }
    host.appendChild(h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'Сотрудник'), h('th', null, 'Должность'), h('th', null, 'Специальность'), h('th', null, ''))),
        tbody));
    return host;
}

async function addMember(c) {
    const opts = await loadOptions().catch(() => null);
    if (!opts) { toast('Не удалось загрузить сотрудников.', 'fail'); return; }
    const picked = await pickOne({
        title: 'Добавить сотрудника',
        text: 'Сотрудник состоит в одном отделе: кто сейчас в другом, перейдёт сюда только после подтверждения.',
        picker: (onChoose) => staffPicker(opts.staff, { placeholder: 'Найти сотрудника…', onChoose, excludeIds: () => new Set(c.members.map((m) => m.id)) }),
    });
    if (!picked) return;
    try {
        let reassign = false;
        if (picked.department_id && picked.department_id !== c.department.id) {
            reassign = await askConfirm({ title: 'Перевести сотрудника?', text: trf('{name} сейчас в отделе «{dept}». Перевести в этот отдел?', { name: picked.full_name, dept: picked.department_name }), okLabel: 'Перевести' });
            if (!reassign) return;
        }
        state.card = await rpc('department_member_set', { department_id: c.department.id, user_id: picked.id, on: true, reassign });
        state.options = null;
        toast('Сотрудник добавлен', 'ok');
        paint();
    } catch (e) { toast((e && e.message) || 'Не удалось.', 'fail'); }
}

// --- Снабжение: на руках, выдано, израсходовано, заявки -------------------------
function cardSupply(c) {
    const host = h('div');
    const tools = h('div', { class: 'dept-tools' }, h('span', { class: 'grow' }));
    if (c.can_request) tools.appendChild(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openRequisition(c) }, Icon('Doc', { size: 13 }), ' ', tr('Запросить у склада')));
    if (c.can_issue) tools.appendChild(h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openStockIssueModal({
        holder: { type: 'department', id: c.department.id, name: c.department.name },
        onDone: async () => { try { await reloadCard(); } catch { /* карточка перерисуется как есть */ } paint(); },
    }) }, Icon('Send', { size: 13 }), ' ', tr('Выдать со склада')));
    host.appendChild(tools);

    // На руках
    host.appendChild(sectionTable('На руках', c.holdings, ['Товар', 'Остаток'],
        (r) => [r.product_name, `${fmtQty(r.qty_units)} ${r.unit}`], 'Отделу ничего не выдано.', { numeric: [1] }));
    // Выдано со склада
    host.appendChild(sectionTable('Выдано со склада', c.issues, ['Когда', 'Товар', 'Сколько', 'Кем', 'Основание'],
        (r) => [fmtDateTime(r.created_at), r.product_name, `${fmtQty(r.qty_units)} ${r.unit}`, r.issued_by || '—', r.note || (r.source === 'requisition' ? tr('по заявке') : '—')],
        'Выдач пока не было.', { numeric: [2] }));
    // Израсходовано на пациентов
    host.appendChild(sectionTable('Израсходовано на пациентов', c.usage, ['Когда', 'Товар', 'Сколько', 'Пациент', 'Кто выдал'],
        (r) => [fmtDateTime(r.created_at), r.product_name + (r.kind === 'void' ? ' — ' + tr('отменено') : ''), `${fmtQty(r.qty_units)} ${r.unit}`, r.patient_name || h('span', { class: 'muted' }, '—'), r.by_name || '—'],
        'Из остатка отдела пациентам ещё ничего не выдавали.', { numeric: [2] }));
    // Заявки
    host.appendChild(sectionTable('Заявки на склад', c.requisitions, ['Номер', 'Статус', 'Позиций', 'Кто подал', 'Когда'],
        (r) => [r.req_number || '—', tr(REQ_STATUS[r.status] || r.status), String(r.lines || 0), r.requested_by_name || '—', fmtDateTime(r.created_at)],
        'Заявок пока нет.', { numeric: [2] }));
    return host;
}

function sectionTable(title, rows, heads, cells, emptyText, { numeric = [] } = {}) {
    const card = h('div', { class: 'card dept-section' }, h('div', { class: 'dept-section-title' }, tr(title), rows.length ? h('span', { class: 'tab-count' }, String(rows.length)) : null));
    if (!rows.length) { card.appendChild(h('div', { class: 'muted', style: { padding: '6px 0 4px' } }, emptyText)); return card; }
    card.appendChild(h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, ...heads.map((t, i) => h('th', { class: numeric.includes(i) ? 'num' : null }, t)))),
        h('tbody', null, ...rows.map((r) => h('tr', null, ...cells(r).map((v, i) => h('td', { class: numeric.includes(i) ? 'num' : null }, v))))))));
    return card;
}

// Заявка отдела на склад — те же строки, что «Новая заявка» в Закупках, отдел подставлен.
async function openRequisition(c) {
    const overlay = h('div', { class: 'modal sim' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const body = h('div', { class: 'modal-body', style: { flex: 1, minHeight: 0, overflowY: 'auto' } });
    const okBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Подать заявку');
    overlay.appendChild(h('div', { class: 'modal-card modal-compact sim-card', style: { width: '680px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Doc', { size: 16 }), ' ', tr('Запросить у склада')), h('button', { class: 'modal-close', onclick: close }, '×')),
        body,
        h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'), h('span', { class: 'grow' }), okBtn)));
    document.body.appendChild(overlay);
    body.appendChild(h('div', { class: 'muted', style: { padding: '16px', textAlign: 'center' } }, 'Загрузка товаров…'));
    let products = [];
    try {
        const { data, error } = await supabase.from('products').select('id,name,code,base_unit,consumption_unit,consumption_factor,on_hand').eq('active', 1).order('name', { ascending: true });
        if (error) throw error;
        products = data || [];
    } catch (e) { clear(body); body.appendChild(h('div', { class: 'empty' }, trf('Не удалось загрузить товары: {msg}', { msg: (e && e.message) || '' }))); return; }
    clear(body);
    const lines = [];
    const linesHost = h('div', { class: 'sim-lines' });
    const noteInp = h('input', { type: 'text', placeholder: 'Для чего (необязательно)', style: inpStyle });
    function addLine() {
        const line = { product: null, qty: '' };
        lines.push(line);
        const unitEl = h('span', { class: 'muted' }, '—');
        const qtyInp = h('input', { type: 'number', min: '0', step: 'any', style: { ...numStyle, width: '110px' } });
        qtyInp.addEventListener('input', () => { line.qty = qtyInp.value; });
        const picker = productSearch({ products, excludeIds: () => new Set(lines.filter((l) => l !== line && l.product).map((l) => l.product.id)),
            onChoose: (p) => { line.product = p; unitEl.textContent = p ? (issueUnitOf(p).unit || '—') : '—'; if (p) qtyInp.focus(); } });
        const row = h('div', { class: 'sim-line' },
            h('div', { class: 'sim-line-prod' }, picker.el, picker.drop),
            h('div', { class: 'sim-line-qty' }, qtyInp, unitEl),
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Убрать позицию', onclick: () => { const i = lines.indexOf(line); if (i >= 0) lines.splice(i, 1); row.remove(); if (!lines.length) addLine(); } }, '×'));
        linesHost.appendChild(row);
    }
    body.appendChild(field('Отдел', h('div', { class: 'sim-fixed' }, h('b', null, c.department.name))));
    body.appendChild(h('div', { class: 'sim-head' }, h('span', { class: 'sim-col-prod' }, 'Товар'), h('span', { class: 'sim-col-qty' }, 'Количество'), h('span', null, '')));
    body.appendChild(linesHost);
    body.appendChild(h('button', { class: 'btn btn-sm', type: 'button', onclick: addLine }, Icon('Plus', { size: 13 }), ' ', tr('Добавить позицию')));
    body.appendChild(field('Примечание', noteInp));
    body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Снабжение увидит заявку в Закупках и выдаст товар отделу — он появится «На руках».'));
    addLine();
    okBtn.addEventListener('click', async () => {
        const valid = lines.filter((l) => l.product && Number(l.qty) > 0);
        if (!valid.length) { toast('Добавьте хотя бы одну позицию.', 'fail'); return; }
        okBtn.disabled = true;
        try {
            // Сервер ждёт базовые единицы; человек вводит единицы выдачи — переводим здесь, как в Закупках.
            await rpc('create_requisition', {
                p_department: c.department.id,
                p_notes: noteInp.value.trim() || null,
                p_lines: valid.map((l) => { const iu = issueUnitOf(l.product); return { item_id: l.product.id, qty: Number(l.qty) / iu.factor, note: null }; }),
            });
            toast('Заявка подана', 'ok');
            close();
            try { await reloadCard(); } catch { /* как есть */ }
            paint();
        } catch (e) { toast((e && e.message) || 'Не удалось подать заявку.', 'fail'); okBtn.disabled = false; }
    });
}

// --- История -------------------------------------------------------------------
const EVENT_TEXT = {
    created: () => tr('Отдел сформирован'),
    updated: (d) => tr('Изменены данные отдела') + (d && d.name ? `: ${d.name[0]} → ${d.name[1]}` : ''),
    head_changed: (d) => (d && d.to ? trf('Руководитель: {name}', { name: d.to.name }) : tr('Руководитель снят')),
    member_added: (d) => trf('В команду добавлен: {name}', { name: d && d.name || '' }) + (d && d.from_department ? ' (' + trf('из отдела «{dept}»', { dept: d.from_department }) + ')' : ''),
    member_removed: (d) => trf('Из команды убран: {name}', { name: d && d.name || '' }),
    room_assigned: (d) => trf('Помещение назначено: {name}', { name: d && d.name || '' }) + (d && d.from_department ? ' (' + trf('из отдела «{dept}»', { dept: d.from_department }) + ')' : ''),
    room_removed: (d) => trf('Помещение снято: {name}', { name: d && d.name || '' }),
    issued: (d) => trf('Выдано со склада: {list}', { list: (d && d.lines || []).map((l) => l.name).join(', ') }),
    requisition_created: (d) => trf('Подана заявка на склад {num}', { num: d && d.req_number || '' }),
};

function cardHistory(c) {
    const host = h('div', { class: 'card' });
    if (!c.events.length) { host.appendChild(h('div', { class: 'empty' }, 'Записей пока нет.')); return host; }
    const list = h('div', { class: 'dept-events' });
    for (const e of c.events) {
        const f = EVENT_TEXT[e.kind];
        list.appendChild(h('div', { class: 'dept-event' },
            h('div', { class: 'muted dept-event-when' }, fmtDateTime(e.created_at)),
            h('div', null, f ? f(e.details) : e.kind, e.actor_name ? h('span', { class: 'muted' }, ' — ' + e.actor_name) : null)));
    }
    host.appendChild(list);
    return host;
}

// ---------------------------------------------------------------------------
// Короткие вопросы
// ---------------------------------------------------------------------------
function askConfirm({ title, text, okLabel = 'Да' }) {
    return new Promise((resolve) => {
        const overlay = h('div', { class: 'modal', style: { zIndex: '200' } });
        const done = (v) => { overlay.remove(); resolve(v); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => done(false) }));
        overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' }, h('h2', null, tr(title)), h('button', { class: 'modal-close', onclick: () => done(false) }, '×')),
            h('div', { class: 'modal-body' }, h('p', { style: { margin: 0 } }, text)),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Отмена'),
                h('span', { class: 'grow' }),
                h('button', { class: 'btn btn-primary', type: 'button', onclick: () => done(true) }, tr(okLabel)))));
        document.body.appendChild(overlay);
    });
}

/** Выбрать одного из списка: диалог с поиском. undefined — закрыли; null — «снять». */
function pickOne({ title, text, picker, clearLabel = null }) {
    return new Promise((resolve) => {
        const overlay = h('div', { class: 'modal', style: { zIndex: '190' } });
        const done = (v) => { overlay.remove(); resolve(v); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => done(undefined) }));
        overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' }, h('h2', null, tr(title)), h('button', { class: 'modal-close', onclick: () => done(undefined) }, '×')),
            h('div', { class: 'modal-body' }, text ? h('p', { class: 'muted', style: { margin: 0 } }, text) : null, picker((v) => done(v))),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', type: 'button', onclick: () => done(undefined) }, 'Отмена'),
                h('span', { class: 'grow' }),
                clearLabel ? h('button', { class: 'btn btn-danger', type: 'button', onclick: () => done(null) }, tr(clearLabel)) : null)));
        document.body.appendChild(overlay);
    });
}
