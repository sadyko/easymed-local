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
//
// V3120_FIX — «ТОЛЬКО СВОЯ ПОЛКА» (владелец 27.09). Экран просил весь реестр
// подотчёта (holdings_list без отбора) и предлагал источником КАЖДЫЙ кабинет и
// каждое отделение клиники. Теперь он спрашивает `reachable` для выбранного
// визита: сервер отдаёт только полки ЭТОЙ медсестры для ЭТОГО приёма (свой
// подотчёт, кабинет приёма, свой кабинет, отдел, свой отдел) в порядке цепочки.
// «Откуда» — с какой своей полки начать; не хватило — сервер добирает с
// остальных своих, склад последним (rpc/holdings.js dispense_from_holding).
//
// OWN_SHELF_ONLY_V1 (владелец 28.09) — «Склад (общий остаток)» в «Откуда»
// остался только администратору и складу: медсестра и врач выдают со своих
// полок, а пустые полки — это заявка на склад («На ваших полках ничего нет —
// запросите у склада» и кнопка). Кто берёт со склада, говорит сервер
// (holdings_list reachable → warehouse_allowed); каталог склада с остатками
// врачу и медсестре больше не запрашивается вовсе.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, field, checkField, initials } from '../ui.js';
import { pastelFor } from '../pastel.js';
import { tr, trf } from '../i18n.js';
import { fmtPrice, fmtQty } from './inventory-shared.js';
// EXPIRY_BALANCE_V1 — «списание просроченного предупреждает» (владелец 23.09).
// Слова пишет сервер (rpc/expiry.js), вкладка их только показывает.
import { toastStockWarnings } from './stock-warnings.js';
import { loadShelves, emptyShelvesNotice, shelfRequestButton } from './own-shelf.js';   // OWN_SHELF_ONLY_V1

const HOLDER_WORD = { staff: 'Мои запасы', room: 'Кабинет', department: 'Отделение' };
const WAREHOUSE_KEY = 'warehouse';

/** «Кабинет: Процедурный» / «Мои запасы» — подпись источника в списке. */
/**
 * V3120_FIX — «Взято: мои запасы, склад» — откуда на самом деле ушло (сервер
 * называет источники в ответе; выдача бывает частями).
 */
export function sourcesWords(sources, myId) {
    const words = [];
    for (const s of Array.isArray(sources) ? sources : []) {
        const w = s.type === WAREHOUSE_KEY ? tr('склад')
            : s.type === 'staff' ? tr('мои запасы')
            : s.type === 'room' ? tr('кабинет') : tr('отделение');
        if (!words.includes(w)) words.push(w);
    }
    return words.join(', ');
}

/**
 * Сколько этого товара можно выдать всего: свои полки + склад.
 * Ревью M2 — склад без числа (берёт, но не видит остаток): сколько там,
 * экран не знает — Infinity, и потолок ставит сервер, а не экран.
 */
export function reachableUnits(sources, productId) {
    let n = 0;
    for (const s of sources || []) {
        for (const it of s.items || []) {
            if (Number(it.product_id) !== Number(productId)) continue;
            if (it.qty_units == null) return Infinity;
            n += Number(it.qty_units) || 0;
        }
    }
    return Math.round(n * 1000) / 1000;
}

/** Ревью M2 — «10 амп» у товара источника, у склада без числа — «есть на складе». */
export function sourceQtyText(it) {
    return it.qty_units == null ? tr('есть на складе') : fmtQty(it.qty_units) + ' ' + (it.consumption_unit || '');
}

export function holderLabel(hd, myId) {
    if (hd.holder_type === WAREHOUSE_KEY) return tr('Склад (общий остаток)');
    if (hd.holder_type === 'staff') return Number(hd.holder_id) === Number(myId) ? tr(HOLDER_WORD.staff) : hd.holder_name || tr('Сотрудник');
    return tr(HOLDER_WORD[hd.holder_type] || '') + ': ' + (hd.holder_name || '');
}

/**
 * Источники, из которых ЭТА медсестра может выдавать: свои запасы первыми,
 * затем кабинеты и отделения — только те, где что-то есть. Чужие личные
 * запасы (другого сотрудника) не предлагаются: выдавать из чужого кармана
 * нельзя, даже если он в списке.
 * OWN_SHELF_ONLY_V1 — склад добавляется последним источником ТОЛЬКО при
 * `warehouse: true` (администратор и склад; решает сервер).
 */
export function sourcesFor(holdings, myId, products = [], { warehouse = true, visible = true, inStock = null } = {}) {
    const byKey = new Map();
    for (const hd of holdings || []) {
        if (hd.holder_type === 'staff' && Number(hd.holder_id) !== Number(myId)) continue;
        if (!(hd.qty_units > 0)) continue;
        const key = hd.holder_type + ':' + hd.holder_id;
        if (!byKey.has(key)) byKey.set(key, { key, holder_type: hd.holder_type, holder_id: hd.holder_id, holder_name: hd.holder_name, items: [] });
        byKey.get(key).items.push(hd);
    }
    const order = { staff: 0, room: 1, department: 2 };
    const out = [...byKey.values()].sort((a, b) => (order[a.holder_type] - order[b.holder_type]) || String(a.holder_name).localeCompare(String(b.holder_name)));
    // The warehouse is the last source — OWN_SHELF_ONLY_V1: for the admin and
    // the warehouse role only. Everyone else gives from their own shelves.
    if (!warehouse) return out;
    // Ревью M2 — берёт со склада, а числа не видит (своя роль на основе
    // администратора или склада с «Закупки: Нет»): склад — источник, как и
    // раньше на сервере, но без количества: «есть на складе» по списку сервера.
    const onWarehouse = (p) => (visible ? Number(p.on_hand) > 0 : !!(inStock && inStock.has(Number(p.id))));
    const stock = (products || []).filter((p) => p && p.active !== false && p.active !== 0 && onWarehouse(p)).map((p) => {
        const cf = p.consumption_unit && Number(p.consumption_factor) > 0 ? Number(p.consumption_factor) : 1;
        return { holder_type: WAREHOUSE_KEY, holder_id: null, holder_name: '', product_id: p.id, product_name: p.name,
            base_unit: p.base_unit || p.unit || '', consumption_unit: p.consumption_unit || p.base_unit || p.unit || '', consumption_factor: cf,
            sale_price: Number(p.sale_price) || 0,
            qty_base: visible ? Number(p.on_hand) : null,
            qty_units: visible ? Math.round(Number(p.on_hand) * cf * 100) / 100 : null };
    });
    if (stock.length) out.push({ key: WAREHOUSE_KEY, holder_type: WAREHOUSE_KEY, holder_id: null, holder_name: '', items: stock });
    return out;
}

/** «10:30» из ISO-времени визита, в местном времени. */
export function visitTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export async function mountOutpatients(body, { user, onEmpty } = {}) {
    const myId = user && user.id;
    // OWN_SHELF_ONLY_V1 — warehouse: берёт ли этот человек со склада (ответ
    // сервера вместе с полками; до ответа — нет: склад не обещаем заранее).
    const state = { visits: [], selected: null, items: null, holdings: [], products: [], failed: '', warehouse: false,
        warehouseVisible: false, inStock: new Set() };   // ревью M2 — видит ли число склада; что на складе есть

    async function loadProducts() {
        // OWN_SHELF_ONLY_V1 — каталог склада с остатками нужен только тому, кто
        // со склада выдаёт; врачу и медсестре он не запрашивается вовсе.
        if (!state.warehouse) { state.products = []; return; }
        const { data } = await supabase.from('products')
            .select('id,name,unit,base_unit,consumption_unit,consumption_factor,on_hand,sale_price,active')
            .eq('active', 1).order('name', { ascending: true });
        state.products = Array.isArray(data) ? data : [];
    }
    async function load() {
        const v = await supabase.rpc('outpatients_today', {});
        state.failed = v.error ? (v.error.message || tr('нет данных')) : '';
        state.visits = (!v.error && v.data && Array.isArray(v.data.visits)) ? v.data.visits : [];
        if (!state.visits.some((x) => x.id === state.selected)) state.selected = state.visits.length ? state.visits[0].id : null;
        await Promise.all([loadItems(), reloadHoldings()]);
        paint();
    }
    // V3120_FIX — только свои полки для выбранного визита (кабинет приёма у
    // каждого визита свой), и уже в порядке цепочки. OWN_SHELF_ONLY_V1 — и
    // ответ сервера, можно ли этому человеку брать со склада.
    async function loadHoldings() {
        const shelves = await loadShelves(state.selected ? { visit_id: state.selected } : null);
        state.holdings = shelves.rows;
        state.warehouse = shelves.warehouse;
        state.warehouseVisible = shelves.warehouseVisible;
        state.inStock = shelves.inStock;
    }
    async function loadItems() {
        state.items = null;
        if (!state.selected) return;
        const { data } = await supabase.rpc('visit_items', { visit_id: state.selected });
        state.items = data && Array.isArray(data.items) ? data.items : [];
    }
    async function reloadHoldings() {
        await loadHoldings();
        await loadProducts();
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
                onclick: async () => { state.selected = v.id; state.items = null; paint(); await Promise.all([loadItems(), loadHoldings()]); paint(); },
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
            const undo = (it.can_void !== undefined ? it.can_void : (it.from_holding && !it.invoiced))
                ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => {
                    if (!window.confirm(tr('Отменить выдачу? Количество вернётся туда, откуда взято.'))) return;
                    const { error } = await supabase.rpc('void_holding_dispense', { visit_service_id: it.id });
                    if (error) { toast(error.message || tr('Не удалось отменить.'), 'error'); return; }
                    toast(tr('Выдача отменена.'), 'success');
                    await Promise.all([loadItems(), reloadHoldings()]);
                    v.item_count = Math.max(0, (v.item_count || 1) - 1);
                    paint();
                } }, tr('Отменить'))
                : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, it.invoiced ? tr('в счёте') : '');
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
        const sources = sourcesFor(state.holdings, myId, state.products, { warehouse: state.warehouse, visible: state.warehouseVisible, inStock: state.inStock });
        const bodyEl = h('div', { style: { padding: '14px 16px', display: 'grid', gap: '10px' } });
        // OWN_SHELF_ONLY_V1 — заявка на склад, когда своих полок нет, открывается
        // прямо отсюда; после неё вкладка перечитывает полки.
        const onRequested = async () => { await reloadHoldings(); paint(); };
        if (!sources.length) {
            if (!state.warehouse) {
                bodyEl.appendChild(emptyShelvesNotice({ onDone: onRequested }));
            } else {
                bodyEl.appendChild(h('div', { class: 'empty', style: { padding: '14px' } },
                    h('p', null, tr('Выдавать нечего: на складе нет остатков.')),
                    h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                        tr('Приход оформляется в разделе «Склад». Выданное медсестре, в кабинет или в отделение появится здесь отдельным источником.'))));
            }
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
                prodSel.appendChild(h('option', { value: String(it.product_id) }, it.product_name + ' — ' + sourceQtyText(it)));   // ревью M2
            }
            paintUnit();
        }
        function paintUnit() {
            const it = currentItem();
            unitEl.textContent = it ? (it.consumption_unit || '') : '';
            const price = it ? fmtPrice((it.sale_price || 0) / (it.consumption_factor || 1)) : '';
            availEl.textContent = !it ? ''
                : it.qty_units == null ? trf('Есть на складе · цена за единицу {price}', { price })   // ревью M2 — склад без числа
                : trf('Есть {qty} {unit} · цена за единицу {price}', { qty: fmtQty(it.qty_units), unit: it.consumption_unit || '', price });
        }
        srcSel.addEventListener('change', paintProducts);
        prodSel.addEventListener('change', paintUnit);
        paintProducts();

        const giveBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
            const it = currentItem();
            const qty = Number(qtyInp.value);
            if (!it) return toast(tr('Выберите товар.'), 'warn');
            if (!Number.isFinite(qty) || qty <= 0) return toast(tr('Количество — положительное число.'), 'warn');
            // V3120_FIX — выбранная полка не обязана покрыть всё: недостачу
            // сервер доберёт с остальных своих полок, склад последним. Экран
            // останавливает только то, чего нет нигде.
            const reach = reachableUnits(sources, it.product_id);
            if (qty > reach + 1e-9) {
                // OWN_SHELF_ONLY_V1 — у врача и медсестры склада в сумме нет.
                return toast(state.warehouse
                    ? trf('Всего доступно {qty} {unit}: на руках, в кабинете, в отделении и на складе.', { qty: fmtQty(reach), unit: it.consumption_unit || '' })
                    : trf('На ваших полках всего {qty} {unit} — остальное запросите у склада.', { qty: fmtQty(reach), unit: it.consumption_unit || '' }), 'warn');
            }
            giveBtn.disabled = true;
            try {
                const src = current();
                const { data, error } = await supabase.rpc('dispense_from_holding', {
                    holder: src.holder_type === WAREHOUSE_KEY ? { type: WAREHOUSE_KEY } : { type: src.holder_type, id: src.holder_id },
                    product_id: it.product_id, quantity: qty, visit_id: v.id, billable: billChk.checked,
                });
                if (error) throw error;
                const from = sourcesWords(data && data.sources, myId);
                toast(trf('Выдано: {name} — {qty} {unit}', { name: data && data.item_name ? data.item_name : it.product_name, qty: fmtQty(qty), unit: it.consumption_unit || '' })
                    + (from ? ' · ' + trf('взято: {from}', { from }) : ''), 'success');
                toastStockWarnings(data);   // EXPIRY_BALANCE_V1 — просроченная партия: после успеха, не вместо него
                v.item_count = (v.item_count || 0) + 1;
                await Promise.all([loadItems(), reloadHoldings()]);
                paint();
            } catch (e) {
                toast((e && e.message) || tr('Не удалось выдать.'), 'error');
            } finally { giveBtn.disabled = false; }
        } }, Icon('Check', { size: 13 }), ' ', tr('Выдать'));

        bodyEl.appendChild(field('Откуда', srcSel));
        // OWN_SHELF_ONLY_V1 — подсказка «Пока только общий склад…» убрана: у
        // врача и медсестры склада в «Откуда» нет, у администратора он и так
        // виден последним пунктом.
        bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 0' } },
            state.warehouse
                ? tr('Не хватит на выбранной полке — доберётся с других ваших, склад последним. Чужие запасы не берутся.')
                : tr('Не хватит на выбранной полке — доберётся с других ваших. Чужие запасы не берутся; чего нет на ваших полках — запросите у склада.')));
        bodyEl.appendChild(field('Что', prodSel));
        bodyEl.appendChild(field('Сколько', h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, qtyInp, unitEl)));
        bodyEl.appendChild(availEl);
        bodyEl.appendChild(checkField('В счёт пациента', billChk));
        bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 0 26px' } },
            tr('Снимите, если расходник входит в услугу: строка ляжет на визит с нулевой суммой, остаток спишется.')));
        bodyEl.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '4px' } }, giveBtn,
            // OWN_SHELF_ONLY_V1 — у врача и медсестры заявка на склад рядом с «Выдать».
            state.warehouse ? null : shelfRequestButton({ onDone: onRequested })));
        card.appendChild(bodyEl);
        return card;
    }

    await load();
    return { reload: load };
}
