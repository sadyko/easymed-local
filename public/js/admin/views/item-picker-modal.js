// Item picker modal — "Dispense clinic item(s)" surface. DISPENSE_ITEM_V1
//
// Lists the clinic's `clinic_items` (active products: medications,
// consumables, etc.) with a search box, the current branch on-hand (when a
// single branch is resolvable, otherwise the sum across branches), price, and
// unit/form/strength meta.
//
// DISPENSE_MULTI_V1 — multi-item cart: clicking a product ADDS it to a list;
// each line has its own quantity + unit; one confirm dispenses them all. On
// confirm the dialog does NOT write anything itself — it hands the chosen lines
// back to the caller via `onConfirm(lines)` where `lines` is
// `[{ item, qty, unit }]`. Each surface (consultation workspace, visit modal,
// admission modal) then loops the appropriate SECURITY DEFINER RPC
// (`dispense_visit_item` / `dispense_admission_item`) — one atomic call per
// line — so the RPC choice stays in the caller and this dialog is
// surface-agnostic.
//
// Fail-soft: catalogue/stock loads are wrapped; a load error shows a toast and
// an empty state rather than throwing. The caller's onConfirm is awaited; if it
// throws (e.g. every line failed) the message is surfaced and the dialog stays
// open so the user can retry. Callers that partially succeed should NOT throw —
// they toast a summary and resolve, and the dialog closes.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { currentClinicId } from '../tenant-tables.js';
import { gw } from '../gateway.js';   // ITEM_UNIT_V1 — persist a corrected catalog unit

// ITEM_UNIT_V1 — dispensing counts in the item's unit and price is per unit, so
// the unit must be explicit to avoid miscounts. Standard units; the item's own
// unit is merged in if it isn't already listed.
const DISPENSE_UNITS = ['шт', 'уп', 'табл', 'капс', 'амп', 'фл', 'мл', 'л', 'г', 'кг', 'м', 'пара', 'компл', 'наб', 'доза'];
function unitOptions(current) {
    const set = [...DISPENSE_UNITS];
    const c = (current || '').trim();
    if (c && !set.includes(c)) set.unshift(c);
    return set;
}

export function openItemPickerModal({
    onConfirm,                       // async (lines) => void ; lines = [{item, qty, unit}] (throws → toast, dialog stays open)
    title        = 'Выдать товары',
    confirmLabel = 'Выдать',
    confirmIcon  = 'Check',
    branchId     = null,             // optional — scope on-hand to this branch when known
    initialSearch = '',              // RX_DISPENSE_V1 — prefill the search (e.g. from an Rx line)
} = {}) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '135' } });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => close() }));

    const state = {
        items:    [],     // [{ id, name, unit, form, strength, price, active, _onHand }]
        search:   initialSearch || '',
        lines:    [],     // DISPENSE_MULTI_V1 — cart: [{ item, qty, unit }]
        loading:  true,
        branchId: branchId || null,
    };

    const card = h('div', { class: 'modal-card modal-compact', style: {   // PROD_BILL_OPTIN_V1 — not fullscreen
        width: '600px', maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column',
    } });
    overlay.appendChild(card);

    card.appendChild(h('header', { class: 'modal-head' },
        h('h2', null, Icon('Pill', { size: 16 }), ' ', title),
        h('button', { class: 'modal-close', onclick: () => close() }, '×'),
    ));

    // ITEM_PICKER_LAYOUT_V1 — body is a fixed-height flex column: search stays
    // put, the product LIST scrolls, and the selected-items cart stays visible
    // above the footer (no scrolling to the bottom to see/confirm the amounts).
    const body = h('div', { style: { padding: '14px 18px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } });
    card.appendChild(body);

    const searchInput = h('input', {
        placeholder: 'Поиск товара — нажмите, чтобы добавить в список…',
        value: state.search,
        style: { width: '100%', height: '36px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', marginBottom: '10px', flex: 'none' },
        oninput: (e) => { state.search = e.target.value; renderList(); },
    });

    // Product catalogue — the only large scrolling area (bounded).
    const listEl = h('div', { style: { border: '1px solid var(--ink-100)', borderRadius: '10px', overflowY: 'auto', background: 'white', flex: 1, minHeight: '130px' } });

    // Selected-items cart — bounded so it never pushes the footer off-screen.
    const cartEl = h('div', { style: { flex: 'none', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--ink-100)', maxHeight: '190px', overflowY: 'auto' } });

    body.append(searchInput, listEl, cartEl);

    // --- footer -----------------------------------------------------------
    const summary = h('span', { style: { fontSize: '12.5px', color: 'var(--ink-500)' } }, 'Выберите товары');
    const confirmBtn = h('button', { class: 'btn btn-primary', disabled: '',
        onclick: () => doConfirm(),
    }, Icon(confirmIcon, { size: 14 }), ' ' + confirmLabel);

    card.appendChild(h('footer', { class: 'modal-foot' },
        summary,
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', onclick: () => close() }, 'Отмена'),
        confirmBtn,
    ));

    // --- load -------------------------------------------------------------
    (async () => {
        const cid = currentClinicId();
        if (!cid) {
            state.loading = false;
            toast('Нет контекста клиники — список товаров недоступен.', 'fail');
            renderList();
            return;
        }
        try {
            const { data: items, error } = await supabase
                .from('clinic_items')
                .select('id, name, unit, form, strength, price, active, is_drug')
                .eq('company_id', cid)
                .eq('active', true)
                .order('is_drug', { ascending: false }).order('name');
            if (error) throw error;
            state.items = (items || []).map(it => ({ ...it, _onHand: null }));
            await loadOnHand(cid);
        } catch (err) {
            toast(err?.message || String(err), 'fail');
            state.items = [];
        } finally {
            state.loading = false;
            renderList();
        }
    })();

    async function loadOnHand(cid) {
        try {
            if (!state.branchId) {
                const { data: brs } = await supabase
                    .from('branches').select('id').eq('company_id', cid);
                if (Array.isArray(brs) && brs.length === 1) state.branchId = brs[0].id;
            }
            let q = supabase.from('item_stock')
                .select('item_id, branch_id, qty_on_hand')
                .eq('company_id', cid);
            if (state.branchId) q = q.eq('branch_id', state.branchId);
            const { data: stock, error } = await q;
            if (error) throw error;
            const byItem = {};
            for (const s of (stock || [])) {
                byItem[s.item_id] = (byItem[s.item_id] || 0) + Number(s.qty_on_hand || 0);
            }
            for (const it of state.items) {
                if (it.id in byItem) it._onHand = byItem[it.id];
            }
        } catch (err) {
            console.warn('[item-picker] on-hand load failed:', err?.message || err);
        }
    }

    function filtered() {
        const t = state.search.trim().toLowerCase();
        if (!t) return state.items;
        return state.items.filter(it =>
            (it.name || '').toLowerCase().includes(t) ||
            (it.form || '').toLowerCase().includes(t) ||
            (it.strength || '').toLowerCase().includes(t));
    }

    function lineFor(id) { return state.lines.find(l => l.item.id === id) || null; }

    // DISPENSE_MULTI_V1 — clicking a product adds it (or +1 if already in the cart).
    function addLine(it) {
        const existing = lineFor(it.id);
        if (existing) existing.qty = Number(existing.qty || 0) + 1;
        else state.lines.push({ item: it, qty: 1, unit: it.unit || 'шт' });
        renderList(); renderCart(); updateSummary();
    }
    function removeLine(l) {
        const i = state.lines.indexOf(l);
        if (i >= 0) state.lines.splice(i, 1);
        renderList(); renderCart(); updateSummary();
    }

    function renderList() {
        clear(listEl);
        if (state.loading) {
            listEl.appendChild(h('div', { style: { padding: '28px', textAlign: 'center', color: 'var(--ink-500)', fontSize: '13.5px' } }, 'Загрузка…'));
            return;
        }
        const rows = filtered();
        if (!rows.length) {
            listEl.appendChild(h('div', { style: { padding: '28px', textAlign: 'center', color: 'var(--ink-500)', fontSize: '13.5px' } },
                state.items.length ? 'Ничего не найдено.' : 'В каталоге клиники нет активных товаров.'));
            return;
        }
        rows.forEach((it, idx) => {
            const meta = [it.unit, it.form, it.strength].filter(Boolean).join(' · ');
            const on = it._onHand;
            const onLabel = on == null ? '—' : Number(on).toLocaleString('ru-RU');
            const lowStock = on != null && Number(on) <= 0;
            const inCart = lineFor(it.id);
            listEl.appendChild(h('button', {
                type: 'button',
                style: {
                    display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '12px', width: '100%',
                    alignItems: 'center', textAlign: 'left',
                    padding: '10px 14px', cursor: 'pointer',
                    borderTop: idx === 0 ? 'none' : '1px solid var(--ink-100)',
                    background: inCart ? 'var(--primary-50)' : 'white',
                    border: 'none', borderLeft: inCart ? '3px solid var(--primary-500)' : '3px solid transparent',
                },
                onclick: () => addLine(it),
            },
                h('div', { style: { minWidth: 0 } },
                    h('div', { style: { fontWeight: 600, fontSize: '13.5px', color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: it.name }, it.name || '—'),
                    meta && h('div', { class: 'muted', style: { fontSize: '12.5px' } }, meta),
                ),
                h('div', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                    h('div', { class: 'num', style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, Number(it.price || 0).toLocaleString('ru-RU') + ' UZS'),
                    h('div', { style: { fontSize: '12.5px', color: lowStock ? 'var(--crit-700)' : 'var(--ink-500)' } }, trf('Остаток: {n}', { n: onLabel })),
                ),
                inCart
                    ? h('span', { style: { minWidth: '22px', height: '22px', borderRadius: '999px', background: 'var(--primary-500)', color: 'white', font: '700 11px/22px inherit', textAlign: 'center', flexShrink: 0, padding: '0 6px' } }, '×' + Number(inCart.qty || 0))
                    : h('span', { style: { width: '22px', height: '22px', borderRadius: '999px', border: '1.5px solid var(--ink-200)', color: 'var(--ink-400)', font: '600 15px/20px inherit', textAlign: 'center', flexShrink: 0 } }, '+'),
            ));
        });
    }

    function renderCart() {
        clear(cartEl);
        if (!state.lines.length) {
            cartEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', textAlign: 'center', padding: '4px 0' } },
                'Выберите товары в списке выше — можно добавить несколько.'));
            return;
        }
        for (const l of state.lines) {
            const qtyInp = h('input', { type: 'number', min: '0.0001', step: 'any', value: String(l.qty), class: 'num',
                style: { width: '66px', height: '32px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', textAlign: 'right' } });
            qtyInp.addEventListener('input', () => { l.qty = qtyInp.value; updateSummary(); });
            // ITEM_UNIT_V1 — per-line unit; changing it corrects the item's
            // catalog unit (gateway) so the per-unit price basis is unambiguous.
            const unitSel = h('select', { style: { height: '32px', padding: '0 4px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', background: 'white', fontFamily: 'inherit', width: '72px' } },
                ...unitOptions(l.unit).map(u => h('option', { value: u }, u)));
            unitSel.value = l.unit || '';
            unitSel.addEventListener('change', () => {
                l.unit = unitSel.value;
                if (l.unit && l.unit !== (l.item.unit || '')) {
                    l.item.unit = l.unit;
                    gw('/crud/clinic_items/' + l.item.id, { method: 'PATCH', body: { unit: l.unit } })
                        .catch(err => console.warn('[item-picker] unit save:', err?.message || err));
                }
                updateSummary();
            });
            cartEl.appendChild(h('div', {
                style: { display: 'flex', alignItems: 'center', gap: '7px', padding: '6px 10px', marginBottom: '6px', background: 'var(--ink-25, #fafafa)', border: '1px solid var(--ink-100)', borderRadius: '8px' },
            },
                h('span', { style: { flex: 1, minWidth: 0, fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: l.item.name }, l.item.name),
                qtyInp,
                unitSel,
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '×'),
                h('span', { class: 'num', style: { fontSize: '12.5px', color: 'var(--ink-700)', minWidth: '62px', textAlign: 'right' } }, Number(l.item.price || 0).toLocaleString('ru-RU')),
                h('button', { type: 'button', title: 'Убрать', class: 'btn btn-ghost btn-sm',
                    style: { color: 'var(--crit-700)', width: '28px', padding: 0 }, onclick: () => removeLine(l) },
                    Icon('Trash', { size: 13 })),
            ));
        }
    }

    function cartTotal() {
        return state.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.item.price) || 0), 0);
    }
    function validLines() {
        return state.lines.filter(l => Number(l.qty) > 0);
    }

    function updateSummary() {
        const valid = validLines();
        if (valid.length) {
            summary.textContent = trf('Позиций: {n} · Итого: {total} UZS', { n: valid.length, total: cartTotal().toLocaleString('ru-RU') });
            confirmBtn.removeAttribute('disabled');
        } else {
            summary.textContent = state.lines.length ? tr('Укажите количество больше 0') : tr('Выберите товары');
            confirmBtn.setAttribute('disabled', '');
        }
    }

    async function doConfirm() {
        const lines = validLines().map(l => ({ item: l.item, qty: Number(l.qty), unit: l.unit || l.item.unit || '' }));
        if (!lines.length) { toast('Добавьте хотя бы один товар с количеством больше 0.', 'fail'); return; }
        confirmBtn.setAttribute('disabled', '');
        confirmBtn.textContent = tr('Выдача…');
        try {
            if (onConfirm) await onConfirm(lines);
            close();
        } catch (err) {
            // A caller throws only when the whole batch failed — surface it and
            // keep the dialog open so the user can retry.
            toast(err?.message || String(err), 'fail');
            clear(confirmBtn);
            confirmBtn.append(Icon(confirmIcon, { size: 14 }), ' ' + confirmLabel);
            confirmBtn.removeAttribute('disabled');
        }
    }

    function close() {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    setTimeout(() => searchInput.focus(), 30);
    renderList();
    renderCart();
    updateSummary();
}
