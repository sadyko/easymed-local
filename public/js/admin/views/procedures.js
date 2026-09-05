// Procedures — the procedure worklist. PROC_PERFORMER_V1.
//
// Решение владельца дословно: «procedures, either can be for doctors or nurses,
// or either can be for the procedure room ambulator patients or can be for
// stationary patients. and they too should come to the employee. as a selected
// service provider when setting a service and the registator selects the
// provider.»
//
// Отсюда три вещи, которых на этом экране раньше не было:
//
//   1. ИСПОЛНИТЕЛЬ — ВРАЧ ИЛИ МЕДСЕСТРА. Кто вправе, решает сервер
//      (rpc/procedures.js canPerformProcedures) по флагу is_doctor и по роли
//      медсестры, а не по слову в role: администратор клиники сплошь и рядом
//      ведёт приём.
//
//   2. ДВА ВИДА ПРОЦЕДУР В ОДНОМ СПИСКЕ. Кабинетная живёт строкой визита
//      (visit_services), палатная — строкой госпитализации
//      (admission_services), и второй этот экран не видел ВООБЩЕ. Теперь обе
//      приходят одним RPC и различаются на глаз: у палатной своя метка, своя
//      иконка, своя полоса слева и адрес — «Стационар · <палата> · койка <код>».
//
//   3. ОЧЕРЕДЬ СОБИРАЕТ СЕРВЕР. Раньше экран сам ходил в visit_services и сам
//      отсеивал чужое. Правило «кому это видно» переехало на сервер целиком —
//      медсестра, попросившая чужую очередь curl'ом, получает свою.
//
// Область видимости прежняя (SERVICE_SCOPE_V1): врач/медсестра видят своё и
// ничьё, полный администратор — всё. Здание — своё (BRANCH_ORIGIN_V1), и у
// палатных строк иначе не бывает: госпитализации между зданиями не ездят.
import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, toast, clear, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { currentUser } from '../data.js';
import { openItemPickerModal } from './item-picker-modal.js?v=billoptin1';   // PROC_PRODUCTS_V1 — reuse the dispense picker

const STATUS_RU = { added: 'Назначено', queued: 'В очереди', in_progress: 'Выполняется', completed: 'Выполнено' };
const OPEN = ['added', 'queued', 'in_progress'];
const state = { rows: [], filter: 'open', showAll: true, search: '', place: 'all' };   // PROC_SEARCH_V1 / PROC_PERFORMER_V1

export async function renderProcedures(container) {
    clear(container);
    container.appendChild(PageHead({ title: tr('Процедуры'), subtitle: tr('Очередь процедур — процедурный кабинет и палаты') }));
    const body = h('div', { class: 'card', style: { padding: '0', overflow: 'hidden' } });
    container.appendChild(body);
    body.appendChild(h('div', { class: 'muted', style: { padding: '28px', textAlign: 'center' } }, tr('Загрузка…')));
    await load();
    paint(body);
}

async function load() {
    // Одна очередь на два вида процедур. Склейка, сортировка и правило
    // видимости — на сервере (rpc/procedures.js): палатная строка живёт в
    // другой таблице, и браузеру её одним запросом не достать.
    const { data, error } = await supabase.rpc('procedures_list', { limit: 300 });
    if (error) {
        console.warn('[procedures]', error.message);
        toast(trf('Не удалось загрузить процедуры: {msg}', { msg: error.message }), 'fail');
        state.rows = []; return;
    }
    state.rows = (data && data.rows) || [];
    state.showAll = (data && data.scope) === 'all';
}

function placeOf(r) { return r.kind === 'inpatient' ? 'inpatient' : 'outpatient'; }

function paint(body) {
    clear(body);
    const counts = {
        open: state.rows.filter(r => OPEN.includes(r.status)).length,
        done: state.rows.filter(r => r.status === 'completed').length,
        all:  state.rows.length,
    };
    const tabs = h('div', { class: 'row', style: { gap: '6px', padding: '12px 14px', borderBottom: '1px solid var(--ink-100, #eee)', flexWrap: 'wrap' } });
    for (const [key, label] of [['open', tr('В работе')], ['done', tr('Выполнено')], ['all', tr('Все')]]) {
        tabs.appendChild(h('button', { class: 'btn btn-sm ' + (state.filter === key ? 'btn-primary' : 'btn-outline'), type: 'button',
            onclick: () => { state.filter = key; paint(body); } }, `${label} · ${counts[key]}`));
    }
    // PROC_PERFORMER_V1 — «где» это второй вопрос после «что»: у процедурного
    // кабинета и у палат разный порядок дня, и смешанный список мешает обоим.
    // Переключатель показывается, только когда есть что разделять.
    const places = {
        outpatient: state.rows.filter(r => placeOf(r) === 'outpatient').length,
        inpatient:  state.rows.filter(r => placeOf(r) === 'inpatient').length,
    };
    if (places.outpatient && places.inpatient) {
        tabs.appendChild(h('span', { style: { width: '1px', alignSelf: 'stretch', background: 'var(--ink-100, #eee)', margin: '0 4px' } }));
        for (const [key, label, icon] of [['all', tr('Везде'), null], ['outpatient', tr('Кабинет'), 'Drop'], ['inpatient', tr('Стационар'), 'Bed']]) {
            tabs.appendChild(h('button', { class: 'btn btn-sm ' + (state.place === key ? 'btn-primary' : 'btn-outline'), type: 'button',
                onclick: () => { state.place = key; paint(body); } },
                icon ? Icon(icon, { size: 13 }) : null,
                icon ? ' ' + label + ' · ' + places[key] : label));
        }
    }
    // PROC_SEARCH_V1 — live search over service / patient / phone / performer.
    // Only the row list repaints on input so the field keeps focus.
    const searchInp = h('input', {
        type: 'search', value: state.search || '', placeholder: tr('Поиск: услуга, пациент, телефон…'),
        style: { marginLeft: 'auto', height: '30px', padding: '0 10px', border: '1px solid var(--ink-200, #ddd)', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit', width: '250px', outline: 'none' },
        oninput: (e) => { state.search = e.target.value; repaintRows(); },
    });
    tabs.appendChild(searchInp);
    body.appendChild(tabs);
    const rowsWrap = h('div');
    body.appendChild(rowsWrap);
    const repaintRows = () => {
        clear(rowsWrap);
        const q = (state.search || '').trim().toLowerCase();
        const shown = state.rows
            .filter(r => state.filter === 'all' ? true : state.filter === 'done' ? r.status === 'completed' : OPEN.includes(r.status))
            .filter(r => state.place === 'all' || placeOf(r) === state.place)
            .filter(r => !q || [r.service, r.patient, r.phone, r.performer, r.ward, r.bed].some(v => (v || '').toLowerCase().includes(q)));
        if (!shown.length) {
            rowsWrap.appendChild(h('div', { class: 'empty', style: { padding: '40px', textAlign: 'center' } },
                q ? tr('Ничего не найдено') : state.showAll ? tr('Нет процедур в этой категории') : tr('Вам пока не назначено процедур')));
            return;
        }
        for (const r of shown) rowsWrap.appendChild(rowEl(r, body));
    };
    repaintRows();
}

// PROC_PERFORMER_V1 — «где» одной меткой. Кабинетная и палатная процедура
// делаются в разных местах, и перепутать их на бегу значит пойти не туда:
// подпись у палатной несёт палату и койку, то есть адрес.
function placeChip(r) {
    if (r.kind === 'inpatient') {
        const where = [r.ward, r.bed ? trf('койка {code}', { code: r.bed }) : null].filter(Boolean).join(' · ');
        return h('span', { class: 'proc-chip proc-chip-in', title: tr('Палатная процедура — пациент лежит в стационаре') },
            Icon('Bed', { size: 12 }), ' ' + tr('Стационар') + (where ? ' · ' + where : ''));
    }
    return h('span', { class: 'proc-chip proc-chip-out', title: tr('Амбулаторная процедура — пациент приходит в процедурный кабинет') },
        Icon('Drop', { size: 12 }), ' ' + tr('Процедурный кабинет'));
}

function rowEl(r, body) {
    injectProcStyles();
    const done = r.done || r.status === 'completed';
    // PROC_UNASSIGNED_V1 — «Назначен» (кто должен сделать) и «Выполнил» (кто
    // сделал) — РАЗНЫЕ вопросы. Пока никто не назначен, строка это и говорит.
    const whoLine = r.unassigned
        ? (done ? '' : tr('Исполнитель не назначен'))
        : trf('Исполнитель · {name}', { name: r.performer });
    return h('div', { class: 'row proc-row' + (r.kind === 'inpatient' ? ' proc-row-in' : ''), style: { justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '12px 14px', borderBottom: '1px solid var(--ink-50, #f3f3f3)' } },
        h('div', { style: { minWidth: '0' } },
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { fontWeight: '600', fontSize: '13.5px' } }, r.service),
                placeChip(r)),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                [r.patient, r.phone, whoLine, fmtDateTime(r.when)].filter(Boolean).join(' · '))),
        h('div', { class: 'row', style: { gap: '8px', flex: 'none', alignItems: 'center' } },
            // Свободную процедуру берёт себе тот, кто её выполняет — отдельного
            // назначающего в смене нет, а ждать администратора у процедурного
            // кабинета некому.
            r.unassigned && !done
                ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', title: tr('Назначить процедуру на себя'),
                    onclick: () => takeProcedure(r, body) }, Icon('User', { size: 13 }), ' ' + tr('Взять'))
                : null,
            h('span', { class: 'tag' + (done ? ' tag-ok' : r.unassigned ? ' tag-warn' : ''), style: { fontSize: '12.5px' } },
                tr(STATUS_RU[r.status] || r.status)),
            r.status === 'added'
                // #15 — un-released (pay-first): the nurse can't perform it until the cashier confirms (payment/debt).
                ? h('span', { class: 'tag', style: { fontSize: '12.5px', opacity: '.75' } }, Icon('Wallet', { size: 11 }), ' ' + tr('Ожидает кассу'))
                : done
                    ? h('span', { class: 'muted', style: { fontSize: '12.5px', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: [r.done_by, r.done_at ? fmtDateTime(r.done_at) : '', r.notes].filter(Boolean).join(' · ') },
                        // PROC_DONE_STAMP_V1 — who pressed «Выполнить» and when
                        [r.done_by || '', r.done_at ? fmtDateTime(r.done_at) : '', r.notes].filter(Boolean).join(' · '))
                    : h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openDone(r, body) }, tr('Выполнить'))));
}

// PROC_PRODUCTS_V1 — compact «Выполнить процедуру» modal, styled like the inpatient
// bed card: a patient block on top + a «Товары (расходные материалы)» section where
// consumables are dispensed onto the procedure's visit (same dispense_visit_item RPC
// as the consult/inpatient flows). No «Услуги» section — procedures don't add services.
function openDone(r, body) {
    injectProcStyles();
    const inpatient = r.kind === 'inpatient';
    const overlay = h('div', { class: 'modal', style: { zIndex: '130' } });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const note = h('textarea', { rows: '3', placeholder: tr('Примечание — доза, место, реакция (необязательно)'),
        style: { width: '100%', padding: '8px 10px', border: '1px solid var(--ink-200, #ddd)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '12.5px', boxSizing: 'border-box', resize: 'vertical' } });
    note.value = r.notes || '';

    // Dispensed-products list for this visit (clinic_item_id rows), with per-line void.
    const itemsWrap = h('div', { style: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' } });
    async function refreshItems() {
        const items = await loadProcItems(r.visit_id);
        clear(itemsWrap);
        if (!items.length) {
            itemsWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 4px', textAlign: 'center' } },
                r.visit_id ? tr('Товаров пока нет. Нажмите «Добавить товары», чтобы списать расходники.') : tr('Визит не привязан — добавить товары нельзя.')));
            return;
        }
        for (const it of items) {
            itemsWrap.appendChild(h('div', { class: 'proc-item' },
                Icon('Pill', { size: 15 }),
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: '13.5px', fontWeight: 600 } }, it.name, h('span', { class: 'muted', style: { fontWeight: 500 } }, ' × ' + it.qty)),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, it.total.toLocaleString('ru-RU') + ' UZS' + (it.invoiced ? ' · ' + tr('в счёте') : ''))),
                it.invoiced
                    ? h('span', { class: 'muted', style: { fontSize: '12.5px' }, title: tr('Уже в счёте — убрать нельзя') }, Icon('Check', { size: 12 }))
                    : h('button', { class: 'btn btn-ghost btn-sm', type: 'button', style: { color: 'var(--crit-700)' }, title: tr('Убрать (вернуть на склад)'),
                        onclick: async () => {
                            if (!confirm(trf('Убрать «{name}»? Товар вернётся на склад.', { name: it.name }))) return;
                            try { const { error } = await supabase.rpc('void_dispensed_visit_item', { p_line: it.id }); if (error) throw error; toast(tr('Товар возвращён на склад.')); await refreshItems(); }
                            catch (e) { toast(e?.message || String(e), 'fail'); }
                        } }, Icon('Trash', { size: 12 }))));
        }
    }

    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: r.visit_id ? null : true,
        onclick: () => openItemPickerModal({
            title: tr('Добавить товары'), confirmLabel: tr('Добавить'),
            onConfirm: async (lines) => {
                let ok = 0; const fails = [];
                for (const { item, qty } of lines) {
                    try {
                        const { error } = await supabase.rpc('dispense_visit_item', { p_visit_id: r.visit_id, p_item_id: item.id, p_qty: Number(qty), p_doctor_id: r.performer_id || null });
                        if (error) throw error; ok++;
                    } catch (e) { fails.push(`${item.name}: ${e?.message || e}`); }
                }
                await refreshItems();
                if (ok === 0) throw new Error(fails[0] || tr('Не удалось добавить товары'));
                toast(trf('Добавлено позиций: {n}', { n: ok }) + (fails.length ? ' · ' + trf('ошибок: {n}', { n: fails.length }) : ''));
                if (fails.length) toast(fails.join('; '), 'fail');
            },
        }) }, Icon('Plus', { size: 13 }), ' ' + tr('Добавить товары'));

    const age = r.dob ? Math.floor((Date.now() - new Date(r.dob).getTime()) / 31557600000) : null;
    const sex = r.sex === 'male' ? 'M' : r.sex === 'female' ? 'F' : null;

    overlay.appendChild(h('div', { class: 'modal-card modal-compact proc-done-card', style: { width: '560px', maxWidth: 'calc(100vw - 32px)' } },   // modal-compact = opt out of MODAL_FULLSCREEN_V1
        h('header', { class: 'modal-head' }, h('h2', null, Icon(inpatient ? 'Bed' : 'Drop', { size: 16 }), ' ' + tr('Выполнить процедуру')),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' } },
            // PROC_TITLE_BLOCK_V1 — the procedure name as a prominent banner so a
            // nurse/doctor sees at a glance WHICH procedure they are performing.
            h('div', { class: 'proc-title-block' + (inpatient ? ' proc-title-in' : '') },
                h('div', { class: 'proc-title-ic' }, Icon(inpatient ? 'Bed' : 'Drop', { size: 20 })),
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'proc-title-label' }, inpatient ? tr('Процедура в палате') : tr('Процедура в кабинете')),
                    h('div', { class: 'proc-title-name' }, r.service)),
            ),
            // Patient block — inpatient-style card
            h('div', { class: 'proc-pcard' },
                h('div', { class: 'proc-av' }, procInitials(r.patient)),
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '15px' } }, r.patient),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                        [r.mrn, age != null ? age + ' y' : null, sex, r.phone].filter(Boolean).join(' · ') || '—'),
                    // Адрес палатного пациента: к нему идут, а не он приходит.
                    inpatient
                        ? h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                            [r.ward, r.bed ? trf('койка {code}', { code: r.bed }) : null].filter(Boolean).join(' · ') || '—')
                        : null)),
            // Расходники. Палатная выдача идёт через койку (ward-beds.js: свой
            // склад и счёт госпитализации) — второй путь списания на тот же
            // случай разошёлся бы с ней молча.
            inpatient
                ? h('div', { class: 'proc-sec' },
                    h('div', { class: 'proc-sec-head' }, h('h4', null, tr('Расходные материалы'))),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '10px 14px' } },
                        tr('Расходники палатного пациента списываются на койке — в карточке госпитализации.')))
                : h('div', { class: 'proc-sec' },
                    h('div', { class: 'proc-sec-head' },
                        h('h4', null, tr('Товары (расходные материалы)')),
                        h('span', { style: { flex: 1 } }),
                        addBtn),
                    itemsWrap),
            // Note
            h('div', null,
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '4px' } }, tr('Примечание')),
                note),
        ),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '12px 14px', borderTop: '1px solid var(--ink-100, #eee)' } },
            h('button', { class: 'btn btn-outline', type: 'button', onclick: close }, tr('Отмена')),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
                const ok = await complete(r, note.value.trim());
                if (!ok) return;
                close(); await load(); paint(body);
            } }, tr('Отметить выполненной')))));
    document.body.appendChild(overlay);
    if (!inpatient) refreshItems();
}

// PROC_PRODUCTS_V1 — dispensed clinic-item lines for a visit (same shape as the
// consult «Назначения (в клинике)» list).
async function loadProcItems(visitId) {
    if (!visitId) return [];
    const { data, error } = await supabase.from('visit_services')
        .select('id, quantity, unit_price, invoice_item_id, clinic_item_id, clinic_items(name, unit)')
        .eq('visit_id', visitId).not('clinic_item_id', 'is', null);
    if (error) { console.warn('[procedures] items:', error.message); return []; }
    return (data || []).map(x => {
        const qty = Number(x.quantity ?? 1), price = Number(x.unit_price ?? 0);
        return { id: x.id, invoiced: !!x.invoice_item_id, qty, total: price * qty,
            name: (x.clinic_items?.name || tr('Товар')) + (x.clinic_items?.unit ? ' (' + x.clinic_items.unit + ')' : '') };
    });
}

function procInitials(name) {
    return (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '—';
}

function injectProcStyles() {
    if (document.getElementById('proc-done-styles')) return;
    const s = document.createElement('style');
    s.id = 'proc-done-styles';
    // Injected after admin.css → these !important rules beat MODAL_FULLSCREEN_V1.
    //
    // Кабинетная процедура носит бирюзу системы (--primary-*), палатная —
    // янтарь (--warn-*, тот же, что у .tag-warn в admin.css). Оттенки взяты из
    // :root, а не выдуманы рядом: свой амбер разошёлся бы с остальными
    // экранами клиники.
    // Свои правила живут здесь, а не в общем admin-views.css, намеренно: их
    // читает один экран, и правка одного экрана не должна трогать общий файл.
    s.textContent = `
.modal-card.proc-done-card { width: 560px !important; max-width: calc(100vw - 32px) !important; height: auto !important; max-height: calc(100vh - 48px) !important; }
.modal-card.proc-done-card > .modal-body { flex: 0 1 auto !important; }
.proc-title-block { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--primary-50, #effaf8); border: 1px solid var(--primary-200, #b3e3dd); border-radius: 12px; }
.proc-title-ic { width: 40px; height: 40px; flex: 0 0 40px; border-radius: 11px; background: var(--primary-100, #d8f1ee); color: var(--primary-700, #115d5a); display: flex; align-items: center; justify-content: center; }
.proc-title-label { font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 700; color: var(--primary-600, #167873); }
.proc-title-name { font-size: 20px; font-weight: 700; color: var(--ink-900); line-height: 1.2; overflow-wrap: anywhere; }
.proc-title-block.proc-title-in { background: var(--warn-50, #fffbeb); border-color: #fde9b6; }
.proc-title-block.proc-title-in .proc-title-ic { background: #fdf0cd; color: var(--warn-800, #8a4309); }
.proc-title-block.proc-title-in .proc-title-label { color: var(--warn-800, #8a4309); }
.proc-pcard { display: flex; gap: 12px; align-items: center; padding: 12px 14px; background: var(--ink-25); border: 1px solid var(--ink-100); border-radius: 12px; }
.proc-av { width: 42px; height: 42px; flex: 0 0 42px; border-radius: 50%; background: var(--primary-100, #d8f1ee); color: var(--primary-700, #115d5a); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; }
.proc-sec { border: 1px solid var(--ink-100); border-radius: 12px; overflow: hidden; }
.proc-sec-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--ink-100); background: var(--ink-25); }
.proc-sec-head h4 { margin: 0; font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-700); }
.proc-item { display: flex; align-items: center; gap: 10px; padding: 9px 12px; background: var(--primary-50); border: 1px solid var(--primary-200); border-radius: 9px; }
.proc-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.proc-chip-out { background: var(--primary-50, #effaf8); color: var(--primary-700, #115d5a); border: 1px solid var(--primary-200, #b3e3dd); }
.proc-chip-in  { background: var(--warn-50, #fffbeb); color: var(--warn-800, #8a4309); border: 1px solid #fde9b6; }
.proc-row-in { box-shadow: inset 3px 0 0 var(--warn-500, #f59e0b); }
`;
    document.head.appendChild(s);
}

// PROC_UNASSIGNED_V1 / PROC_PERFORMER_V1 — «Взять»: свободная процедура
// закрепляется за тем, кто нажал. Куда именно её записать, решает сервер: у
// кабинетной строки исполнитель это visit_services.doctor_id, у палатной —
// admission_services.performer_id (её doctor_id это лечащий врач и деньги,
// см. миграцию 102). Статус НЕ трогаем: очередь кассы живёт своим порядком.
async function takeProcedure(r, body) {
    const me = currentUser();
    if (!me || me.id == null) { toast(tr('Не удалось определить пользователя — войдите заново.'), 'fail'); return; }
    const { error } = await supabase.rpc('procedure_assign', { kind: r.kind, id: r.id });
    if (error) { toast(trf('Не удалось взять процедуру: {msg}', { msg: error.message }), 'fail'); return; }
    toast(tr('Процедура закреплена за вами'));
    await load();
    paint(body);
}

// Отметка о выполнении. Проверку «касса ещё не провела» (#15) держит сервер —
// здесь она была бы украшением: тот же вызов доступен из консоли браузера.
async function complete(r, noteText) {
    const { error } = await supabase.rpc('procedure_complete', { kind: r.kind, id: r.id, notes: noteText || '' });
    if (error) { toast(trf('Ошибка: {msg}', { msg: error.message }), 'fail'); return false; }
    toast(tr('Процедура выполнена'));
    return true;
}
