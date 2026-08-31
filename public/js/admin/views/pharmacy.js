// PHARMACY_V1 — drug-focused inventory + dispensing lens over the products module.
// Items come from clinic_items WHERE is_drug=true (the «Препарат» flag set in
// #settings:clinic_items); stock from item_stock (kept by stock_movements);
// dispenses from med_administrations (stationary) + visit_services.clinic_item_id
// (выдача during a visit). Read/operational — purchasing lives in #procurement.
import { h, Icon, PageHead, toast, clear, fmtDateTime } from '../ui.js';
import { supabase } from '../../supabase.js';
import { currentClinicId } from '../tenant-tables.js';

const fmt = (n) => (Number(n) || 0).toLocaleString('ru-RU');

export async function renderPharmacy(container, { onNavigate } = {}) {
    clear(container);
    const cid = currentClinicId();
    const state = { tab: 'stock', branchId: '', search: '', items: [], stock: [], branches: [] };

    const tabsEl = h('div', { class: 'segmented', style: { marginBottom: '14px' } });
    const body = h('div', null);
    container.appendChild(h('div', { class: 'fade-in' },
        PageHead({ title: 'Аптека', subtitle: 'Препараты, остатки и выдачи. Номенклатура — из «Товаров» (флаг «Препарат»); закупки — в «Снабжении».' }),
        tabsEl, body));

    function paintTabs() {
        clear(tabsEl);
        for (const [id, label] of [['stock', 'Остатки'], ['dispenses', 'Выдачи']]) {
            tabsEl.appendChild(h('button', { class: 'segmented-btn' + (state.tab === id ? ' on' : ''), type: 'button',
                onclick: () => { if (state.tab === id) return; state.tab = id; paintTabs(); route(); } }, label));
        }
    }

    function route() { state.tab === 'dispenses' ? paintDispenses() : paintStock(); }

    // ── Остатки ──
    async function loadStock() {
        if (!cid) return;
        const [{ data: branches }, { data: items }] = await Promise.all([
            supabase.from('branches').select('id, name').eq('company_id', cid).eq('active', true).order('name'),
            supabase.from('clinic_items').select('id, name, code, unit, form, strength, price, active').eq('company_id', cid).eq('is_drug', true).order('name'),
        ]);
        state.branches = branches || []; state.items = items || [];
        const ids = state.items.map(i => i.id);
        let stock = [];
        if (ids.length) {
            const { data } = await supabase.from('item_stock').select('item_id, branch_id, qty_on_hand, reorder_level').in('item_id', ids);
            stock = data || [];
        }
        state.stock = stock;
    }

    function onHandFor(itemId) {
        const rows = state.stock.filter(s => s.item_id === itemId && (!state.branchId || s.branch_id === state.branchId));
        const qty = rows.reduce((a, s) => a + Number(s.qty_on_hand || 0), 0);
        const reorder = rows.reduce((a, s) => Math.max(a, Number(s.reorder_level || 0)), 0);
        return { qty, reorder, low: reorder > 0 && qty <= reorder };
    }

    async function paintStock() {
        clear(body);
        body.appendChild(h('div', { class: 'muted', style: { padding: '30px', textAlign: 'center' } }, 'Загрузка…'));
        await loadStock();
        clear(body);

        const total = state.items.length;
        const lowN = state.items.filter(i => onHandFor(i.id).low).length;
        const kpi = (label, value, tone) => h('div', { class: 'card', style: { flex: 1, padding: '14px 16px' } },
            h('div', { class: 'muted', style: { fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '.05em' } }, label),
            h('div', { style: { fontSize: '24px', fontWeight: 800, color: tone || 'var(--ink-900)' } }, value));
        body.appendChild(h('div', { class: 'row', style: { gap: '14px', marginBottom: '14px' } },
            kpi('Препаратов', String(total)),
            kpi('Заканчиваются', String(lowN), lowN ? 'var(--warn-700, #b45309)' : 'var(--ink-900)')));

        const search = h('input', { placeholder: 'Поиск по названию…', value: state.search,
            style: { height: '34px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13px', minWidth: '240px', fontFamily: 'inherit' },
            oninput: (e) => { state.search = e.target.value; renderTable(); } });
        const branchSel = state.branches.length > 1 ? h('select', { style: { height: '34px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '13px' },
            onchange: (e) => { state.branchId = e.target.value; renderTable(); } },
            h('option', { value: '' }, 'Все филиалы'),
            ...state.branches.map(b => h('option', { value: b.id, selected: state.branchId === b.id }, b.name))) : null;
        const toolbar = h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', marginBottom: '12px' } },
            search, branchSel,
            h('span', { style: { flex: 1 } }),
            h('button', { class: 'btn btn-outline btn-sm', onclick: () => onNavigate && onNavigate('procurement') }, Icon('Receipt', { size: 13 }), ' Снабжение'),
            h('button', { class: 'btn btn-outline btn-sm', onclick: () => onNavigate && onNavigate('settings:clinic_items') }, Icon('Pill', { size: 13 }), ' Товары'));
        body.appendChild(toolbar);

        const tblBox = h('div');
        body.appendChild(tblBox);
        function renderTable() {
            clear(tblBox);
            if (!state.items.length) {
                tblBox.appendChild(h('div', { class: 'empty', style: { padding: '46px 20px' } },
                    h('p', null, 'Препаратов нет.'),
                    h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } },
                        'Добавьте товар в «Товарах» и отметьте «Препарат (лекарство)».')));
                return;
            }
            const t = state.search.trim().toLowerCase();
            const list = state.items.filter(i => !t || (i.name || '').toLowerCase().includes(t) || (i.code || '').toLowerCase().includes(t));
            if (!list.length) { tblBox.appendChild(h('div', { class: 'muted', style: { padding: '24px', textAlign: 'center' } }, 'Ничего не найдено.')); return; }
            const tb = h('tbody');
            for (const i of list) {
                const { qty, reorder, low } = onHandFor(i.id);
                tb.appendChild(h('tr', null,
                    h('td', { style: { fontWeight: 500 } }, i.name, !i.active ? h('span', { class: 'tag', style: { marginLeft: '6px', fontSize: '10px' } }, 'выкл') : null),
                    h('td', { class: 'muted', style: { fontSize: '12.5px' } }, [i.form, i.strength].filter(Boolean).join(' · ') || '—'),
                    h('td', { class: 'muted' }, i.unit || '—'),
                    h('td', { class: 'num' }, fmt(i.price), ' сум'),
                    h('td', { class: 'num', style: { fontWeight: 700 } }, fmt(qty)),
                    h('td', { class: 'num muted' }, reorder ? fmt(reorder) : '—'),
                    h('td', null, low ? h('span', { class: 'tag tag-warn' }, 'Заканчивается') : (qty > 0 ? h('span', { class: 'tag tag-ok' }, 'В наличии') : h('span', { class: 'tag' }, 'Нет')))));
            }
            tblBox.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
                h('thead', null, h('tr', null,
                    h('th', null, 'Препарат'), h('th', null, 'Форма / дозировка'), h('th', null, 'Ед.'),
                    h('th', null, 'Цена'), h('th', null, 'Остаток'), h('th', null, 'Мин.'), h('th', null, 'Статус'))),
                tb));
        }
        renderTable();
    }

    // ── Выдачи ──
    async function paintDispenses() {
        clear(body);
        body.appendChild(h('div', { class: 'muted', style: { padding: '30px', textAlign: 'center' } }, 'Загрузка…'));
        let rows = [];
        try {
            const [{ data: meds }, { data: vs }] = await Promise.all([
                supabase.from('med_administrations')
                    .select('med_name, dose, instructions, administered_at, administered_by_name, patients(full_name, last_name, first_name)')
                    .eq('company_id', cid).order('administered_at', { ascending: false }).limit(60),
                supabase.from('visit_services')
                    .select('quantity, created_at, created_by, clinic_items(name, unit), visits!inner(patient_id, patients(full_name, last_name, first_name))')
                    .eq('company_id', cid).not('clinic_item_id', 'is', null).order('created_at', { ascending: false }).limit(60),
            ]);
            for (const m of (meds || [])) {
                const p = m.patients || {};
                rows.push({ when: m.administered_at, kind: 'Стационар', item: m.med_name + (m.dose ? ' · ' + m.dose : ''), qty: '', patient: [p.last_name, p.first_name].filter(Boolean).join(' ') || p.full_name || '—', by: m.administered_by_name || '', note: m.instructions || '' });
            }
            for (const v of (vs || [])) {
                const p = (v.visits && v.visits.patients) || {}; const it = v.clinic_items || {};
                rows.push({ when: v.created_at, kind: 'Визит', item: it.name || 'Препарат', qty: fmt(v.quantity) + (it.unit ? ' ' + it.unit : ''), patient: [p.last_name, p.first_name].filter(Boolean).join(' ') || p.full_name || '—', by: '', note: '' });
            }
            rows.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
        } catch (e) { console.warn('[pharmacy dispenses]', e && e.message); }

        clear(body);
        if (!rows.length) { body.appendChild(h('div', { class: 'empty', style: { padding: '50px 20px' } }, 'Выдач пока нет. Препараты выдаются из приёма врача или назначаются медсестрой в стационаре.')); return; }
        const tb = h('tbody');
        for (const r of rows) {
            tb.appendChild(h('tr', null,
                h('td', { class: 'muted', style: { fontSize: '12px', whiteSpace: 'nowrap' } }, fmtDateTime(r.when)),
                h('td', null, h('span', { class: r.kind === 'Стационар' ? 'tag tag-purple' : 'tag tag-info' }, r.kind)),
                h('td', { style: { fontWeight: 500 } }, r.item),
                h('td', { class: 'num muted' }, r.qty || ''),
                h('td', { class: 'muted' }, r.patient),
                h('td', { class: 'muted', style: { fontSize: '12px' } }, r.by),
                h('td', { class: 'muted', style: { fontSize: '12px' } }, r.note)));
        }
        body.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
            h('thead', null, h('tr', null,
                h('th', null, 'Дата'), h('th', null, 'Где'), h('th', null, 'Препарат'),
                h('th', null, 'Кол-во'), h('th', null, 'Пациент'), h('th', null, 'Выдал'), h('th', null, 'Примечание'))),
            tb));
    }

    paintTabs();
    route();
}
