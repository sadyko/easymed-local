// Закупки — «Поставщики» tab (PROCUREMENT_REDESIGN_V1): простой CRUD-справочник.
// Удаления нет — поставщика деактивируют, чтобы прошлые записи не ломались
// (registry: delete roles []).
//
// SUPPLIERS_VAT_V1 (2026-09-28) — владелец: «connect the providers to the drug
// products and add products (connect products to the providers). One provider
// can have multiple drugs». Карточка поставщика показывает ВСЕ его товары с его
// ценой закупки (без НДС) и ставкой НДС и умеет «Добавить товар»: привязать
// существующий или завести новый, уже привязанный. Сохраняется одним вызовом
// supplier_save (поставщик + все его товары, одна транзакция, проверка НДС и
// дублей на сервере — rpc/catalog-goods.js).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, checkField } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fetchGuard, CATEGORY_LABEL, numStyle, vatSelect } from './inventory-shared.js';
import { phoneInput } from '../phone-input.js?v=ph1';

const refs = { tbody: null, emptyEl: null, totalEl: null };

export function renderSuppliersTab(container) {
    refs.tbody = h('tbody');
    refs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'Пока нет поставщиков — добавьте первого.');
    refs.totalEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');

    const addBtn = h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => openSupplierModal(null, fetchAndPaint),
    }, Icon('Plus', { size: 14 }), ' Добавить поставщика');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            refs.totalEl,
            h('div', { class: 'page-head-actions' }, addBtn),
        ),
        h('div', { class: 'card' },
            h('div', { style: { overflowX: 'auto' } },
                h('table', { class: 'tbl' },
                    h('thead', null, h('tr', null,
                        h('th', null, 'Название'),
                        h('th', null, 'Контактное лицо'),
                        h('th', null, 'Телефон'),
                        h('th', null, 'Товаров'),
                        h('th', null, 'Примечание'),
                        h('th', null, 'Статус'),
                    )),
                    refs.tbody,
                )),
            refs.emptyEl,
        ),
    ));

    fetchAndPaint();
}

async function fetchAndPaint() {
    const token = ++fetchGuard.token;
    clear(refs.tbody);
    refs.tbody.appendChild(h('tr', null,
        h('td', { colspan: '6', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка…')));
    try {
        const [{ data, error }, lk] = await Promise.all([
            supabase.from('suppliers').select('*').order('name', { ascending: true }).limit(500),
            // SUPPLIERS_VAT_V1 — сколько товаров у поставщика (многие ко многим).
            supabase.from('item_suppliers').select('supplier_id').limit(5000),
        ]);
        if (token !== fetchGuard.token) return;
        if (error) throw error;
        const counts = new Map();
        for (const l of ((lk && !lk.error && lk.data) || [])) counts.set(l.supplier_id, (counts.get(l.supplier_id) || 0) + 1);
        paintRows(data || [], counts);
        refs.totalEl.textContent = trf('Поставщиков: {n}', { n: (data || []).length });
    } catch (e) {
        if (token !== fetchGuard.token) return;
        toast(trf('Не удалось загрузить поставщиков: {msg}', { msg: (e && e.message) || e }), 'fail');
        paintRows([], new Map());
    }
}

function paintRows(rows, counts) {
    clear(refs.tbody);
    if (!rows.length) { refs.emptyEl.style.display = ''; return; }
    refs.emptyEl.style.display = 'none';
    for (const s of rows) {
        refs.tbody.appendChild(h('tr', {
            class: 'row-click',
            style: { cursor: 'pointer', opacity: s.active ? '' : '0.55' },
            onclick: () => openSupplierModal(s, fetchAndPaint),
        },
            h('td', { class: 'cell-strong' }, s.name || '—'),
            h('td', null, s.contact_name || '—'),   // LIVE_AUDIT_FIX_V1 — колонки реестра
            h('td', null, s.phone || '—'),
            h('td', { class: 'num' }, String(counts.get(s.id) || 0)),
            h('td', { class: 'muted' }, s.notes || ''),
            h('td', null, Tag(s.active ? 'Активен' : 'Неактивен', { kind: s.active ? 'ok' : '', dot: true })),
        ));
    }
}

/**
 * Аргументы supplier_save. products — только если список товаров поставщика
 * загружен: не загрузился — товары не отправляются, и сервер связи не трогает.
 */
export function supplierSavePayload({ id = null, name, contact, phone, note, active, linked, linksLoaded }) {
    const payload = supplierPayload({ name, contact, phone, note, active });
    if (id != null) payload.id = id;
    if (linksLoaded) {
        payload.products = (linked || []).map((l) => ({
            product_id: l.product_id,
            last_price: l.last_price == null || l.last_price === '' ? null : Number(l.last_price),
            vat_rate: l.vat_rate === undefined ? null : l.vat_rate,
        }));
    }
    return payload;
}

/**
 * Карточка поставщика. onSaved(supplier) получает сохранённого поставщика.
 * opts.withProducts === false — короткая форма без товаров («+ Новый
 * поставщик» из карточки товара и из «Принять товар»).
 */
export function openSupplierModal(s, onSaved, opts = {}) {
    const isEdit = !!s;
    const withProducts = opts.withProducts !== false;
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const nameInp = h('input', { type: 'text', required: true, value: s ? (s.name || '') : '' });
    const contactInp = h('input', { type: 'text', value: s ? (s.contact_name || '') : '' });
    const phoneInp = phoneInput('phone', '+998 90 961 00 04', { value: s ? s.phone : '' });
    const noteInp = h('input', { type: 'text', value: s ? (s.notes || '') : '' });
    const activeChk = h('input', { type: 'checkbox', checked: s ? !!s.active : true });

    // ---- Товары поставщика (item_suppliers) ----
    // [{ product_id, name, category, unit, last_price, vat_rate }]
    const linked = [];
    let linksLoaded = !isEdit;
    let allProducts = [];
    const linkedEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    const countEl = h('span', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 400 } }, '');

    function paintLinked() {
        clear(linkedEl);
        countEl.textContent = linked.length ? trf('Товаров: {n}', { n: linked.length }) : '';
        if (!linked.length) {
            linkedEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                isEdit && !linksLoaded ? 'Загрузка…' : 'Товары не привязаны — найдите ниже или создайте новый.'));
            return;
        }
        for (const ln of linked) {
            const priceInp = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'цена', 'aria-label': 'Цена без НДС',
                value: ln.last_price != null ? String(ln.last_price) : '', style: { ...numStyle, width: '100px', flex: '0 0 auto' } });
            priceInp.addEventListener('input', () => { ln.last_price = priceInp.value === '' ? null : Number(priceInp.value); });
            const vSel = vatSelect(ln.vat_rate, (v) => { ln.vat_rate = v; }, { flex: '0 0 auto' });
            const lbl = (t) => h('span', { class: 'muted', style: { fontSize: '12.5px', flex: '0 0 auto', whiteSpace: 'nowrap' } }, t);
            linkedEl.appendChild(h('div', {
                class: 'row',
                style: { gap: '7px', alignItems: 'center', flexWrap: 'wrap', padding: '7px 12px',
                         background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-100, #d7efe9)', borderRadius: '10px' },
            },
                h('span', { style: { flex: '1 1 160px', minWidth: '100px', overflow: 'hidden' } },
                    h('span', { style: { display: 'block', fontWeight: 700, color: 'var(--primary-700)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, ln.name),
                    h('span', { class: 'muted', style: { fontSize: '12.5px' } }, CATEGORY_LABEL[ln.category] || ln.category || '')),
                lbl('Цена без НДС'), priceInp, lbl(ln.unit ? trf('сум за {unit}', { unit: ln.unit }) : tr('сум')),
                lbl('НДС'), vSel,
                h('button', {
                    type: 'button', title: 'Отвязать', 'aria-label': 'Отвязать',
                    style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-400)', fontWeight: 700, flex: '0 0 auto' },
                    onclick: () => { linked.splice(linked.indexOf(ln), 1); paintLinked(); },
                }, '×'),
            ));
        }
    }

    const fromProduct = (p) => ({ product_id: p.id, name: p.name, category: p.procurement_category,
        unit: p.purchase_unit || p.base_unit || '', last_price: null, vat_rate: p.vat_rate == null ? null : Number(p.vat_rate) });

    // «Добавить товар» — поиск по каталогу; уже привязанные не предлагаются.
    const prodSearch = h('input', { type: 'text', placeholder: 'Добавить товар — поиск по названию…', 'aria-label': 'Добавить товар',
        style: { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1px solid var(--ink-200)', borderRadius: '10px', fontFamily: 'inherit', fontSize: '13.5px' } });
    const prodResults = h('div', { style: { display: 'none', border: '1px solid var(--ink-200)', borderRadius: '10px', marginTop: '4px', maxHeight: '220px', overflow: 'auto', background: 'var(--white, #fff)' } });
    function paintProdResults() {
        clear(prodResults);
        const q = prodSearch.value.trim().toLowerCase();
        const pool = allProducts.filter((p) => !linked.some((l) => l.product_id === p.id))
            .filter((p) => !q || (p.name || '').toLowerCase().includes(q)).slice(0, 10);
        if (!q && !pool.length) { prodResults.style.display = 'none'; return; }
        prodResults.style.display = '';
        if (!pool.length) { prodResults.appendChild(h('div', { class: 'muted', style: { padding: '9px 12px', fontSize: '12.5px' } }, 'Не найдено')); return; }
        for (const p of pool) {
            prodResults.appendChild(h('div', {
                style: { padding: '8px 12px', cursor: 'pointer', fontSize: '13.5px' },
                onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                onmousedown: (e) => {
                    e.preventDefault();
                    linked.push(fromProduct(p));
                    prodSearch.value = ''; prodResults.style.display = 'none'; paintLinked();
                },
            }, p.name, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, ' · ', CATEGORY_LABEL[p.procurement_category] || '')));
        }
    }
    prodSearch.addEventListener('input', paintProdResults);
    prodSearch.addEventListener('focus', paintProdResults);
    prodSearch.addEventListener('blur', () => setTimeout(() => { prodResults.style.display = 'none'; }, 150));

    // «Новый товар» — карточка товара; у сохранённого поставщика товар сразу
    // привязан к нему (сервер заводит связь), у нового — связь уедет с «Сохранить».
    const newProductBtn = h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async () => {
            const { openProductModal } = await import('./inventory-products.js');
            openProductModal(null, (saved) => {
                if (saved && saved.id && !linked.some((l) => l.product_id === saved.id)) {
                    linked.push(fromProduct(saved));
                    allProducts.push(saved);
                    paintLinked();
                }
            }, isEdit ? { presetSupplier: { id: s.id, name: s.name } } : {});
        },
    }, Icon('Plus', { size: 13 }), ' Новый товар');

    if (withProducts) {
        (async () => {
            try {
                const { data } = await supabase.from('products').select('id,name,procurement_category,base_unit,purchase_unit,vat_rate').eq('active', 1).order('name').limit(1000);
                allProducts = data || [];
            } catch (e) { allProducts = []; }
        })();
        if (isEdit) {
            (async () => {
                try {
                    const { data, error } = await supabase.from('item_suppliers')
                        .select('product_id, last_price, vat_rate, purchase_unit, products(id,name,procurement_category,base_unit,purchase_unit)')
                        .eq('supplier_id', s.id);
                    if (error) throw error;
                    for (const r of (data || [])) {
                        const p = r.products || {};
                        linked.push({ product_id: r.product_id, name: p.name || ('#' + r.product_id), category: p.procurement_category,
                            unit: r.purchase_unit || p.purchase_unit || p.base_unit || '', last_price: r.last_price,
                            vat_rate: r.vat_rate == null ? null : Number(r.vat_rate) });
                    }
                    linked.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
                    linksLoaded = true;
                    paintLinked();
                } catch (e) {
                    // Список не загрузился — «Сохранить» не должен стереть связи.
                    linksLoaded = false;
                    prodSearch.disabled = true;
                    newProductBtn.disabled = true;
                    clear(linkedEl);
                    linkedEl.appendChild(h('div', { style: { fontSize: '12.5px', color: 'var(--crit-700)' } },
                        'Товары поставщика не загрузились — при сохранении связи с ними не изменятся.'));
                }
            })();
        }
        paintLinked();
    }

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isEdit ? 'Сохранить' : 'Добавить');
    saveBtn.addEventListener('click', save);

    async function save() {
        const name = nameInp.value.trim();
        if (!name) { toast('Укажите название поставщика.', 'fail'); return; }
        for (const ln of linked) {
            if (ln.last_price != null && !(Number.isFinite(Number(ln.last_price)) && Number(ln.last_price) >= 0)) {
                toast(trf('Цена закупки товара «{name}» — неотрицательное число.', { name: ln.name }), 'fail'); return;
            }
        }
        saveBtn.disabled = true;
        const prev = saveBtn.textContent;
        saveBtn.textContent = tr('Сохраняем…');
        try {
            const payload = supplierSavePayload({
                id: isEdit ? s.id : null, name,
                contact: contactInp.value, phone: phoneInp.value, note: noteInp.value, active: activeChk.checked,
                linked, linksLoaded: withProducts && linksLoaded,
            });
            const { data, error } = await supabase.rpc('supplier_save', payload);
            if (error) throw error;
            toast('Сохранено', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved(data && data.supplier ? data.supplier : null, data);
        } catch (e) {
            toast((e && e.message) || 'Не удалось сохранить.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prev;
        }
    }

    const productsPanel = withProducts ? h('div', { style: { background: 'var(--ink-25, #f8fafa)', border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '12px 14px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px' } },
            h('span', { style: { fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)' } }, 'Товары поставщика'), countEl),
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px' } },
            'Цена закупки — без НДС, за единицу закупки; НДС — ставка этого поставщика. «Принять товар» подставляет их сам.'),
        linkedEl,
        h('div', { style: { marginTop: '10px' } }, prodSearch, prodResults),
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginTop: '10px', borderTop: '1px dashed var(--ink-150, var(--ink-200))', paddingTop: '10px' } },
            h('span', { class: 'muted', style: { flex: 1, fontSize: '12.5px' } }, 'Нет товара в каталоге?'),
            newProductBtn),
    ) : null;

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: withProducts ? '680px' : '420px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Building', { size: 16 }), ' ', isEdit ? 'Поставщик' : 'Добавить поставщика'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { overflowY: 'auto' } },
            field('Название', nameInp, { required: true }),
            field('Контактное лицо', contactInp),
            field('Телефон', phoneInp),
            field('Примечание', noteInp),
            checkField('Активен', activeChk),
            productsPanel,
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    nameInp.focus();
}

// LIVE_AUDIT_FIX_V1 — строка поставщика КОЛОНКАМИ РЕЕСТРА (suppliers:
// contact_name, notes). Экран писал `contact` и `note` — таких колонок нет,
// компилятор их молча выбрасывал, и контактное лицо с примечанием не
// сохранялись никогда; список читал те же несуществующие поля.
// SUPPLIERS_VAT_V1 — те же ключи уходят в supplier_save.
export function supplierPayload({ name, contact, phone, note, active }) {
    return {
        name: String(name || '').trim(),
        contact_name: String(contact || '').trim(),
        phone: String(phone || '').trim(),
        notes: String(note || '').trim(),
        active: active ? 1 : 0,
    };
}
