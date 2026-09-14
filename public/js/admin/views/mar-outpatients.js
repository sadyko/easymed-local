// MAR_OUTPATIENTS_V1 — вкладка «Амбулаторные» на рабочем месте медсестры.
//
// Владелец (2026-09-14): «in the #mar-nurse we need to create one tab for
// patients in the ambulatory. there will be list, and nurses can dispense
// items which is dispensed from the procurement either to the nurse or either
// to the cabinet or to the department».
//
// Та же раскладка, что у стационарной смены: СЛЕВА ЛЮДИ — сегодняшние
// амбулаторные визиты (outpatients_today), справа — выбранный человек: якорь
// с именем и картой, красный баннер аллергии, что уже выдано на этом визите и
// форма «выдать». Выдаётся С РУК — из того, что склад выдал этой медсестре,
// её кабинету или отделению (holdings_list). Склад при этом не списывается
// второй раз: это и есть починенный поток (rpc/holdings.js, миграция 128).
//
// Что выдано — сразу строка визита: касса увидит её в счёте пациента, как
// любую выдачу; галочка «в счёт» снятая — строка на нуле (учёт расхода без
// денег). Отмена — только у неоплаченной строки и только той, что выдана с рук.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, field, checkField, initials } from '../ui.js';
import { pastelFor } from '../pastel.js';
import { tr, trf } from '../i18n.js';
import { fmtPrice, fmtQty } from './inventory-shared.js';

const HOLDER_WORD = { staff: 'Мои запасы', room: 'Кабинет', department: 'Отделение' };

/** «Кабинет: Процедурный» / «Мои запасы» — подпись источника в списке. */
export function holderLabel(hd, myId) {
    if (hd.holder_type === 'staff') return Number(hd.holder_id) === Number(myId) ? tr(HOLDER_WORD.staff) : hd.holder_name || tr('Сотрудник');
    return tr(HOLDER_WORD[hd.holder_type] || '') + ': ' + (hd.holder_name || '');
}

/**
 * Источники, из которых ЭТА медсестра может выдавать: свои запасы первыми,
 * затем кабинеты и отделения — только те, где что-то есть. Чужие личные
 * запасы (другого сотрудника) не предлагаются: выдавать из чужого кармана
 * нельзя, даже если он в списке.
 */
export function sourcesFor(holdings, myId) {
    const byKey = new Map();
    for (const hd of holdings || []) {
        if (hd.holder_type === 'staff' && Number(hd.holder_id) !== Number(myId)) continue;
        if (!(hd.qty_units > 0)) continue;
        const key = hd.holder_type + ':' + hd.holder_id;
        if (!byKey.has(key)) byKey.set(key, { key, holder_type: hd.holder_type, holder_id: hd.holder_id, holder_name: hd.holder_name, items: [] });
        byKey.get(key).items.push(hd);
    }
    const order = { staff: 0, room: 1, department: 2 };
    return [...byKey.values()].sort((a, b) => (order[a.holder_type] - order[b.holder_type]) || String(a.holder_name).localeCompare(String(b.holder_name)));
}

/** «10:30» из ISO-времени визита, в местном времени. */
export function visitTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export async function mountOutpatients(body, { user, onEmpty } = {}) {
    const myId = user && user.id;
    const state = { visits: [], selected: null, items: null, holdings: [], failed: '' };

    async function load() {
        const [v, hd] = await Promise.all([
            supabase.rpc('outpatients_today', {}),
            supabase.rpc('holdings_list', {}),
        ]);
        state.failed = v.error ? (v.error.message || tr('нет данных')) : '';
        state.visits = (!v.error && v.data && Array.isArray(v.data.visits)) ? v.data.visits : [];
        state.holdings = (!hd.error && hd.data && Array.isArray(hd.data.holdings)) ? hd.data.holdings : [];
        if (!state.visits.some((x) => x.id === state.selected)) state.selected = state.visits.length ? state.visits[0].id : null;
        await loadItems();
        paint();
    }
    async function loadItems() {
        state.items = null;
        if (!state.selected) return;
        const { data } = await supabase.rpc('visit_items', { visit_id: state.selected });
        state.items = data && Array.isArray(data.items) ? data.items : [];
    }
    async function reloadHoldings() {
        const hd = await supabase.rpc('holdings_list', {});
        state.holdings = (!hd.error && hd.data && Array.isArray(hd.data.holdings)) ? hd.data.holdings : [];
    }

    function paint() {
        clear(body);
        body.appendChild(peopleCard());
        body.appendChild(workCard());
    }

    function peopleCard() {
        const card = h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Patients', { size: 16 }), ' ', tr('Сегодня в клинике')),
                h('span', { style: { flex: 1 } }),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, trf('пациентов: {n}', { n: state.visits.length }))));
        if (state.failed) {
            card.appendChild(h('div', { class: 'empty', style: { padding: '26px' } }, trf('Не удалось загрузить визиты: {msg}', { msg: state.failed })));
            return card;
        }
        if (!state.visits.length) {
            card.appendChild(h('div', { class: 'empty', style: { padding: '26px' } }, tr('Сегодня амбулаторных визитов нет.')));
            return card;
        }
        for (const v of state.visits) {
            const active = v.id === state.selected;
            card.appendChild(h('button', {
                type: 'button',
                style: {
                    display: 'flex', alignItems: 'center', gap: '11px', width: '100%', textAlign: 'left',
                    padding: '10px 14px', border: '0', borderBottom: '1px solid var(--ink-100)',
                    background: active ? 'var(--primary-25, #f2faf8)' : 'transparent',
                    cursor: 'pointer', font: 'inherit',
                },
                onclick: async () => { state.selected = v.id; state.items = null; paint(); await loadItems(); paint(); },
            },
                h('span', {
                    class: ('mar-av ' + pastelFor(v.patient_id || v.patient_name)).trim(),
                    style: {
                        width: '34px', height: '34px', borderRadius: '999px', flex: '0 0 34px',
                        background: 'var(--p-bg, var(--primary-50))', color: 'var(--p-fg, var(--primary-700))',
                        display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '12.5px',
                    },
                }, initials(v.patient_name || '?')),
                h('span', { style: { flex: 1, minWidth: 0 } },
                    h('span', { style: { display: 'block', fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)' } }, v.patient_name || tr('без имени')),
                    h('span', { class: 'muted', style: { display: 'block', fontSize: '12.5px' } },
                        [visitTime(v.visit_date) || null, v.mrn || null, v.doctor_name || null].filter(Boolean).join(' · '))),
                v.item_count ? Tag(trf('выдано: {n}', { n: v.item_count })) : null));
        }
        return card;
    }

    function workCard() {
        const box = h('div', { style: { display: 'grid', gap: '14px', alignContent: 'start' } });
        const v = state.visits.find((x) => x.id === state.selected);
        if (!v) {
            box.appendChild(h('div', { class: 'card' },
                h('div', { class: 'empty', style: { padding: '26px' } }, tr('Выберите пациента слева.'))));
            return box;
        }
        const head = h('div', { class: 'card', style: { padding: '14px 16px', display: 'grid', gap: '10px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-100, #d7efe9)', borderRadius: '11px' } },
                h('span', { class: ('mar-av ' + pastelFor(v.patient_id || v.patient_name)).trim(),
                    style: { width: '38px', height: '38px', borderRadius: '999px', flex: '0 0 38px', background: 'var(--p-bg, var(--primary-50))', color: 'var(--p-fg, var(--primary-700))', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '13.5px' } },
                    initials(v.patient_name || '?')),
                h('div', { style: { minWidth: 0 } },
                    h('div', { style: { fontSize: '17px', fontWeight: 700, color: 'var(--ink-900)', lineHeight: 1.2 } }, v.patient_name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } },
                        [v.mrn || null, visitTime(v.visit_date) || null, v.doctor_name ? trf('врач: {name}', { name: v.doctor_name }) : null].filter(Boolean).join(' · ')))));
        if (v.allergies && String(v.allergies).trim()) {
            head.appendChild(h('div', { role: 'alert', style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 12px', background: 'var(--crit-50, #fef2f2)', border: '1px solid var(--crit-200, #fecaca)', borderRadius: '10px', color: 'var(--crit-700, #b91c1c)', fontSize: '13.5px' } },
                Icon('Warning', { size: 16 }), h('div', null, h('b', null, tr('Аллергия')), ': ', String(v.allergies))));
        }
        box.appendChild(head);
        box.appendChild(itemsCard(v));
        box.appendChild(giveCard(v));
        return box;
    }

    function itemsCard(v) {
        const card = h('div', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Pill', { size: 16 }), ' ', tr('Выдано на этом визите'))));
        if (state.items === null) { card.appendChild(h('div', { class: 'muted', style: { padding: '14px' } }, tr('Загрузка…'))); return card; }
        if (!state.items.length) { card.appendChild(h('div', { class: 'empty', style: { padding: '18px' } }, tr('Пока ничего не выдано.'))); return card; }
        const tb = h('tbody');
        for (const it of state.items) {
            const undo = it.from_holding && !it.invoiced
                ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => {
                    if (!window.confirm(tr('Отменить выдачу? Количество вернётся на руки.'))) return;
                    const { error } = await supabase.rpc('void_holding_dispense', { visit_service_id: it.id });
                    if (error) { toast(error.message || tr('Не удалось отменить.'), 'error'); return; }
                    toast(tr('Выдача отменена.'), 'success');
                    await Promise.all([loadItems(), reloadHoldings()]);
                    v.item_count = Math.max(0, (v.item_count || 1) - 1);
                    paint();
                } }, tr('Отменить'))
                : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, it.invoiced ? tr('в счёте') : (it.from_holding ? '' : tr('со склада')));
            tb.appendChild(h('tr', null,
                h('td', null, it.product_name),
                h('td', { class: 'num' }, fmtQty(Number(it.quantity)), ' ', it.unit || ''),
                h('td', { class: 'num' }, fmtPrice(it.total)),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, it.created_by_name || ''),
                h('td', { style: { textAlign: 'right' } }, undo)));
        }
        card.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
            h('thead', null, h('tr', null, h('th', null, 'Товар'), h('th', null, 'Кол-во'), h('th', null, 'Сумма'), h('th', null, 'Кто выдал'), h('th', null, ''))),
            tb));
        return card;
    }

    function giveCard(v) {
        const card = h('div', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Send', { size: 16 }), ' ', tr('Выдать пациенту'))));
        const sources = sourcesFor(state.holdings, myId);
        const bodyEl = h('div', { style: { padding: '14px 16px', display: 'grid', gap: '10px' } });
        if (!sources.length) {
            bodyEl.appendChild(h('div', { class: 'empty', style: { padding: '14px' } },
                h('p', null, tr('На руках ничего нет.')),
                h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                    tr('Склад выдаёт препараты и расходники сотруднику, в кабинет или в отделение — в разделе «Склад → Выдать». Выданное появится здесь.'))));
            card.appendChild(bodyEl);
            return card;
        }
        const srcSel = h('select', null, ...sources.map((s) => h('option', { value: s.key }, holderLabel(s, myId))));
        const prodSel = h('select', null);
        const qtyInp = h('input', { type: 'number', min: '0', step: 'any', value: '1', style: { width: '110px' } });
        const unitEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
        const availEl = h('div', { class: 'muted', style: { fontSize: '12.5px' } }, '');
        const billChk = h('input', { type: 'checkbox' });
        billChk.checked = true;
        const current = () => sources.find((s) => s.key === srcSel.value) || sources[0];
        // The first option is what a browser selects by default; read it that way too.
        const currentItem = () => { const items = current().items || []; return items.find((it) => String(it.product_id) === prodSel.value) || items[0] || null; };
        function paintProducts() {
            clear(prodSel);
            for (const it of current().items) {
                prodSel.appendChild(h('option', { value: String(it.product_id) }, it.product_name + ' — ' + fmtQty(it.qty_units) + ' ' + (it.consumption_unit || '')));
            }
            paintUnit();
        }
        function paintUnit() {
            const it = currentItem();
            unitEl.textContent = it ? (it.consumption_unit || '') : '';
            availEl.textContent = it
                ? trf('Есть {qty} {unit} · цена за единицу {price}', { qty: fmtQty(it.qty_units), unit: it.consumption_unit || '', price: fmtPrice((it.sale_price || 0) / (it.consumption_factor || 1)) })
                : '';
        }
        srcSel.addEventListener('change', paintProducts);
        prodSel.addEventListener('change', paintUnit);
        paintProducts();

        const giveBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
            const it = currentItem();
            const qty = Number(qtyInp.value);
            if (!it) return toast(tr('Выберите товар.'), 'warn');
            if (!Number.isFinite(qty) || qty <= 0) return toast(tr('Количество — положительное число.'), 'warn');
            if (qty > it.qty_units + 1e-9) return toast(trf('На руках только {qty} {unit}.', { qty: fmtQty(it.qty_units), unit: it.consumption_unit || '' }), 'warn');
            giveBtn.disabled = true;
            try {
                const { data, error } = await supabase.rpc('dispense_from_holding', {
                    holder: { type: current().holder_type, id: current().holder_id },
                    product_id: it.product_id, quantity: qty, visit_id: v.id, billable: billChk.checked,
                });
                if (error) throw error;
                toast(trf('Выдано: {name} — {qty} {unit}', { name: data && data.item_name ? data.item_name : it.product_name, qty: fmtQty(qty), unit: it.consumption_unit || '' }), 'success');
                v.item_count = (v.item_count || 0) + 1;
                await Promise.all([loadItems(), reloadHoldings()]);
                paint();
            } catch (e) {
                toast((e && e.message) || tr('Не удалось выдать.'), 'error');
            } finally { giveBtn.disabled = false; }
        } }, Icon('Check', { size: 13 }), ' ', tr('Выдать'));

        bodyEl.appendChild(field('Откуда', srcSel));
        bodyEl.appendChild(field('Что', prodSel));
        bodyEl.appendChild(field('Сколько', h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, qtyInp, unitEl)));
        bodyEl.appendChild(availEl);
        bodyEl.appendChild(checkField('В счёт пациента', billChk));
        bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 0 26px' } },
            tr('Снимите, если расходник входит в услугу: строка ляжет на визит с нулевой суммой, остаток спишется.')));
        bodyEl.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '4px' } }, giveBtn));
        card.appendChild(bodyEl);
        return card;
    }

    await load();
    return { reload: load };
}
