// STOCK_REQUEST_V1 (R2, 2026-09-23) — ОБЩИЕ КУСКИ ЭКРАНОВ ЗАЯВОК И МИНИМУМОВ.
//
// Владелец: «#my-stock should be able to request and set to auto request with
// minimum amount». План: docs/plans/2026-09-23-stock-requests.md. Решения:
// автозаявка — до нормы (минимум и норма на товар), одобряет кладовщик,
// человек просит себе, член отдела — и отделу; минимум ставит каждый себе,
// заведующая — отделу, склад и администратор — любому.
//
// ЗДЕСЬ — ТО, ЧТО НУЖНО ДВУМ ЭКРАНАМ СРАЗУ: «Мои запасы» (минимумы и заявка
// себе/отделу) и карточке отдела (минимумы отдела). Один диалог минимума и
// одни слова о состоянии — иначе «ниже минимума» на двух экранах разойдётся на
// первой же правке. Поиск товара — тот же, что у «Выдать со склада»
// (stock-issue-modal.js productSearch), второго поиска нет.
//
// ЕДИНИЦЫ. Человек считает ампулами и таблетками, а не упаковками: всё, что он
// видит и вводит, — в единицах расхода, и на провод уходит `unit:'consumption'`.
// Перевод в базовые делает сервер (rpc/stock-requests.js) тем же множителем,
// что выдача.
//
// ПРАВА СЧИТАЕТ СЕРВЕР. Кнопка «Изменить» стоит там, где сервер сказал
// `can_edit`; «Добавить минимум» — тому, кому сервер всё равно разрешит.
// Отказ сервера показывается его словами.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, field, Tag } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { fmtQty, numStyle } from './inventory-shared.js';
import { productSearch, issueUnitOf, inpStyle } from './stock-issue-modal.js';

async function rpc(name, args) {
    const { data, error } = await supabase.rpc(name, args || {});
    if (error) throw error;
    return data;
}

/** Активные товары для поиска — тот же запрос, что у выдачи и заявки отдела. */
export async function loadRequestProducts() {
    const { data, error } = await supabase.from('products').select('id,name,code,base_unit,consumption_unit,consumption_factor,on_hand').eq('active', 1).order('name', { ascending: true });
    if (error) throw error;
    return data || [];
}

const qtyText = (n, unit) => [fmtQty(Number(n) || 0), unit || ''].filter(Boolean).join(' ');
const unitOfRow = (r) => (r && (r.consumption_unit || r.base_unit)) || '';
const factorOfRow = (r) => (r && Number(r.consumption_factor) > 0 ? Number(r.consumption_factor) : 1);

/** Ячейка «Минимум»: число и, если остаток ниже, пометка цветом предупреждения. */
export function minimumCell(r) {
    if (!r) return h('span', { class: 'muted' }, '—');
    return h('div', null,
        h('div', null, qtyText(r.min_units, unitOfRow(r))),
        r.below_min ? Tag(tr('ниже минимума'), { kind: 'warn', dot: true }) : null);
}

export function targetCell(r) {
    if (!r) return h('span', { class: 'muted' }, '—');
    return qtyText(r.target_units, unitOfRow(r));
}

/** «заявка REQ-… на N шт», с пометкой «авто», когда её подал минимум. */
export function openRequestText(r) {
    const o = r && r.open_request;
    if (!o) return null;
    const params = { num: o.req_number || '', qty: fmtQty((Number(o.qty) || 0) * factorOfRow(r)), unit: unitOfRow(r) };
    return (o.auto ? trf('заявка {num} на {qty} {unit}, авто', params) : trf('заявка {num} на {qty} {unit}', params)).replace(/\s+/g, ' ').trim();
}

export function requestCell(r) {
    const t = openRequestText(r);
    return t || h('span', { class: 'muted' }, '—');
}

/**
 * Диалог минимума: поставить, поправить или снять.
 * @param {{ holder: {type:'staff'|'department', id:number, name?:string},
 *           row?: object|null,      // строка stock_minimums_list — правка; нет — новый минимум
 *           product?: object|null,  // товар уже известен (строка «на руках» без минимума)
 *           onDone?: Function }} opts
 */
export function openMinimumDialog({ holder, row = null, product = null, onDone = null }) {
    const overlay = h('div', { class: 'modal sim' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // Товар: из строки минимума, из строки «на руках» или выбирается поиском.
    let chosen = row
        ? { id: row.product_id, name: row.product_name, consumption_unit: row.consumption_unit, base_unit: row.base_unit, consumption_factor: row.consumption_factor }
        : (product ? { ...product } : null);
    const unitEl = (u) => h('span', { class: 'muted' }, u || '—');
    const minUnit = unitEl(chosen ? issueUnitOf(chosen).unit : '');
    const targetUnit = unitEl(chosen ? issueUnitOf(chosen).unit : '');
    const minInp = h('input', { type: 'number', min: '0', step: 'any', 'aria-label': 'Минимум', style: { ...numStyle, width: '110px' } });
    const targetInp = h('input', { type: 'number', min: '0', step: 'any', 'aria-label': 'Норма', style: { ...numStyle, width: '110px' } });
    if (row) { minInp.value = fmtQty(Number(row.min_units) || 0); targetInp.value = fmtQty(Number(row.target_units) || 0); }
    const errEl = h('div', { class: 'muted', role: 'alert', style: { fontSize: '12.5px', color: 'var(--crit-700)' } });

    const body = h('div', { class: 'modal-body', style: { flex: 1, minHeight: 0, overflowY: 'auto' } });
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Сохранить');
    const clearBtn = row && row.can_edit !== false
        ? h('button', { class: 'btn btn-ghost', type: 'button' }, Icon('Trash', { size: 13 }), ' ', tr('Снять минимум'))
        : null;

    function setUnit(p) {
        const u = p ? issueUnitOf(p).unit : '';
        minUnit.textContent = u || '—';
        targetUnit.textContent = u || '—';
    }

    function paintForm(products) {
        clear(body);
        body.appendChild(field(holder.type === 'department' ? 'Отдел' : 'Кому',
            h('div', { class: 'sim-fixed' }, holder.type === 'staff' && !holder.name ? tr('Себе') : h('b', null, holder.name || ''))));
        if (chosen && (row || product)) {
            body.appendChild(field('Товар', h('div', { class: 'sim-fixed' }, h('b', null, chosen.name || ''))));
        } else {
            const picker = productSearch({ products: products || [], onChoose: (p) => { chosen = p; setUnit(p); if (p) minInp.focus(); } });
            body.appendChild(field('Товар', h('div', { class: 'sim-line-prod' }, picker.el, picker.drop), { required: true }));
        }
        body.appendChild(h('div', { class: 'row', style: { gap: '16px', flexWrap: 'wrap' } },
            field('Минимум', h('div', { class: 'sim-line-qty' }, minInp, minUnit), { required: true }),
            field('Норма', h('div', { class: 'sim-line-qty' }, targetInp, targetUnit), { required: true })));
        body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            'Когда на руках станет меньше минимума, программа сама подаст заявку на склад — до нормы. Кладовщик одобрит её в «Заявках».'));
        body.appendChild(errEl);
    }

    let busy = false;
    function fail(e, fallback) {
        const msg = (e && e.message) || tr(fallback);
        errEl.textContent = msg;
        toast(msg, 'fail');
    }

    saveBtn.addEventListener('click', async () => {
        if (busy) return;
        errEl.textContent = '';
        if (!chosen) { fail(null, 'Выберите товар.'); return; }
        const min = Number(minInp.value);
        const target = Number(targetInp.value);
        if (minInp.value === '' || targetInp.value === '' || !Number.isFinite(min) || !Number.isFinite(target) || min < 0 || target < 0) {
            fail(null, 'Укажите минимум и норму — числа от нуля.');
            return;
        }
        if (target < min) { fail(null, 'Норма не может быть меньше минимума.'); return; }
        busy = true; saveBtn.disabled = true;
        try {
            const res = await rpc('stock_minimum_set', {
                holder_type: holder.type, holder_id: holder.id, product_id: chosen.id,
                min_qty: min, target_qty: target, unit: 'consumption',
            });
            const req = res && res.request;
            if (req) {
                const iu = issueUnitOf(chosen);
                toast(trf('Минимум сохранён. Подана заявка {num} на {qty} {unit}', { num: req.req_number || '', qty: fmtQty((Number(req.qty) || 0) * iu.factor), unit: iu.unit || '' }).trim(), 'ok');
            } else {
                toast('Минимум сохранён', 'ok');
            }
            close();
            if (typeof onDone === 'function') onDone(res);
        } catch (e) {
            fail(e, 'Не удалось сохранить минимум.');
            busy = false; saveBtn.disabled = false;
        }
    });

    if (clearBtn) clearBtn.addEventListener('click', async () => {
        if (busy) return;
        busy = true; clearBtn.disabled = true;
        try {
            await rpc('stock_minimum_clear', { holder_type: holder.type, holder_id: holder.id, product_id: row.product_id });
            toast('Минимум снят', 'ok');
            close();
            if (typeof onDone === 'function') onDone(null);
        } catch (e) {
            fail(e, 'Не удалось снять минимум.');
            busy = false; clearBtn.disabled = false;
        }
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact sim-card', style: { width: '560px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Target', { size: 16 }), ' ', tr(row ? 'Минимум и норма' : 'Добавить минимум')), h('button', { class: 'modal-close', onclick: close }, '×')),
        body,
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            clearBtn,
            h('span', { class: 'grow' }),
            saveBtn)));
    document.body.appendChild(overlay);

    if (chosen) { paintForm(null); return { close }; }
    body.appendChild(h('div', { class: 'muted', style: { padding: '16px', textAlign: 'center', fontSize: '12.5px' } }, 'Загрузка товаров…'));
    saveBtn.disabled = true;
    loadRequestProducts().then((products) => { saveBtn.disabled = false; paintForm(products); }, (e) => {
        clear(body);
        body.appendChild(h('div', { class: 'empty' }, trf('Не удалось загрузить товары: {msg}', { msg: (e && e.message) || '' })));
    });
    return { close };
}

/**
 * Диалог «Запросить»: себе или своему отделу (второе — только тому, у кого
 * отдел есть). Количество — в единицах расхода.
 * @param {{ departmentId?: number|null, departmentName?: string, onDone?: Function }} opts
 */
export function openStockRequestDialog({ departmentId = null, departmentName = '', onDone = null } = {}) {
    const overlay = h('div', { class: 'modal sim' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const forSel = departmentId
        ? h('select', { 'aria-label': 'Для кого', style: { ...inpStyle, width: '220px' } },
            h('option', { value: 'me' }, 'Себе'),
            h('option', { value: 'department' }, departmentName ? trf('Для отдела «{dept}»', { dept: departmentName }) : tr('Для отдела')))
        : null;
    if (forSel) forSel.value = 'me';
    const noteInp = h('input', { type: 'text', placeholder: 'Для чего (необязательно)', 'aria-label': 'Примечание', style: inpStyle });
    const lines = [];
    const linesHost = h('div', { class: 'sim-lines' });
    const body = h('div', { class: 'modal-body', style: { flex: 1, minHeight: 0, overflowY: 'auto' } });
    const okBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Подать заявку');
    let products = [];

    function addLine() {
        const line = { product: null, qty: '' };
        lines.push(line);
        const unitEl = h('span', { class: 'muted' }, '—');
        const qtyInp = h('input', { type: 'number', min: '0', step: 'any', 'aria-label': 'Количество', style: { ...numStyle, width: '110px' } });
        qtyInp.addEventListener('input', () => { line.qty = qtyInp.value; });
        const picker = productSearch({
            products,
            excludeIds: () => new Set(lines.filter((l) => l !== line && l.product).map((l) => l.product.id)),
            onChoose: (p) => { line.product = p; unitEl.textContent = p ? (issueUnitOf(p).unit || '—') : '—'; if (p) qtyInp.focus(); },
        });
        const row = h('div', { class: 'sim-line' },
            h('div', { class: 'sim-line-prod' }, picker.el, picker.drop),
            h('div', { class: 'sim-line-qty' }, qtyInp, unitEl),
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Убрать позицию', onclick: () => { const i = lines.indexOf(line); if (i >= 0) lines.splice(i, 1); row.remove(); if (!lines.length) addLine(); } }, '×'));
        linesHost.appendChild(row);
    }

    function paintForm() {
        clear(body);
        body.appendChild(field('Для кого', forSel || h('div', { class: 'sim-fixed' }, tr('Себе'))));
        body.appendChild(h('div', { class: 'sim-head' }, h('span', { class: 'sim-col-prod' }, 'Товар'), h('span', { class: 'sim-col-qty' }, 'Количество'), h('span', null, '')));
        body.appendChild(linesHost);
        body.appendChild(h('button', { class: 'btn btn-sm', type: 'button', onclick: addLine }, Icon('Plus', { size: 13 }), ' ', tr('Добавить позицию')));
        body.appendChild(field('Примечание', noteInp));
        body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            'Кладовщик увидит заявку в «Заявках»; после одобрения товар появится у вас «на руках» или у отдела.'));
        addLine();
    }

    let busy = false;
    okBtn.addEventListener('click', async () => {
        if (busy) return;
        const valid = lines.filter((l) => l.product && Number(l.qty) > 0);
        if (!valid.length) { toast('Добавьте хотя бы одну позицию.', 'fail'); return; }
        const forWhom = forSel && forSel.value === 'department' ? 'department' : 'me';
        const args = { for: forWhom };
        if (forWhom === 'department') args.department_id = departmentId;
        const notes = noteInp.value.trim();
        if (notes) args.notes = notes;
        args.lines = valid.map((l) => ({ product_id: l.product.id, qty: Number(l.qty), unit: 'consumption' }));
        busy = true; okBtn.disabled = true;
        try {
            const res = await rpc('stock_request_create', args);
            toast(trf('Заявка {num} подана — кладовщик увидит её в «Заявках».', { num: (res && res.req_number) || '' }), 'ok');
            close();
            if (typeof onDone === 'function') onDone(res);
        } catch (e) {
            toast((e && e.message) || tr('Не удалось подать заявку.'), 'fail');
            busy = false; okBtn.disabled = false;
        }
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact sim-card', style: { width: '680px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Send', { size: 16 }), ' ', tr('Запросить со склада')), h('button', { class: 'modal-close', onclick: close }, '×')),
        body,
        h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'), h('span', { class: 'grow' }), okBtn)));
    document.body.appendChild(overlay);

    body.appendChild(h('div', { class: 'muted', style: { padding: '16px', textAlign: 'center', fontSize: '12.5px' } }, 'Загрузка товаров…'));
    loadRequestProducts().then((list) => { products.push(...list); okBtn.disabled = false; paintForm(); }, (e) => {
        clear(body);
        body.appendChild(h('div', { class: 'empty' }, trf('Не удалось загрузить товары: {msg}', { msg: (e && e.message) || '' })));
    });
    return { close };
}
