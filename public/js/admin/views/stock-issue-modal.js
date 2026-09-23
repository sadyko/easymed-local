// STOCK_ISSUE_MODAL_V1 (2026-09-18) — ОДНА ДВЕРЬ «ВЫДАТЬ СО СКЛАДА».
//
// Владелец (DEPARTMENTS_V1): «Dispense Products … search products, add multiple
// products, set quantities, remove products, view available stock … review the
// issue before confirmation … avoid double deduction if the user refreshes or
// submits the same transaction twice».
//
// Раньше диалог жил внутри inventory-sklad.js: список товаров одним <select>
// без поиска, без проверки перед отправкой. Теперь диалог общий: Склад
// открывает его с выбором получателя, карточка отдела — с получателем уже
// подставленным (holder). Один диалог, один вызов issue_stock_lines, один
// ключ квитанции на открытие: повторная отправка той же формы (обновили
// страницу, нажали дважды) возвращает ту же квитанцию, склад не списывается
// второй раз (server: stock_issue_receipts).
//
// Количество вводится в ЕДИНИЦАХ ВЫДАЧИ (шт, таб.), как медсестра считает;
// сервер переводит в базовые и не даёт уйти в минус — здесь та же проверка
// стоит раньше, чтобы человек увидел «больше, чем есть» до отправки.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, field } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { fmtQty, numStyle } from './inventory-shared.js';
// EXPIRY_BALANCE_V1 — «выдача просроченного предупреждает» (владелец 23.09).
// Слова пишет сервер, диалог их только показывает — и ПОСЛЕ «Выдано»: выдача
// прошла, окно закрывается, а предупреждение остаётся на виду.
import { toastStockWarnings } from './stock-warnings.js';

const HOLDER_LABEL = { staff: 'Сотруднику', room: 'В кабинет', department: 'В отделение' };

/** Единица выдачи и множитель: consumption, если задана, иначе базовая. */
export function issueUnitOf(p) {
    if (p && p.consumption_unit && Number(p.consumption_factor) > 0) return { unit: p.consumption_unit, factor: Number(p.consumption_factor) };
    return { unit: (p && p.base_unit) || '', factor: 1 };
}

function randomKey() {
    try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return 'issue-' + window.crypto.randomUUID().replace(/-/g, ''); } catch { /* старый браузер */ }
    return 'issue-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

export const inpStyle = { width: '100%', height: '34px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', background: 'white', fontFamily: 'inherit', boxSizing: 'border-box' };

/**
 * Поиск товара: поле + выпадающий список по названию или коду, с остатком в
 * единицах выдачи. Общий для выдачи и заявки: один поиск, одни слова.
 * @returns {{ el: HTMLElement, drop: HTMLElement, clear: Function }}
 */
export function productSearch({ products, excludeIds = () => new Set(), onChoose, placeholder = 'Название или код товара…' }) {
    const search = h('input', { type: 'text', placeholder, style: inpStyle, autocomplete: 'off' });
    const drop = h('div', { class: 'sim-drop', hidden: true });
    let chosen = null;
    const availableOf = (p) => { const iu = issueUnitOf(p); return (Number(p.on_hand) || 0) * iu.factor; };
    function paintDrop() {
        const q = search.value.trim().toLowerCase();
        clear(drop);
        if (!q) { drop.hidden = true; return; }
        const taken = excludeIds();
        const found = (products || [])
            .filter((p) => !taken.has(p.id) && ((p.name || '').toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q)))
            .slice(0, 8);
        if (!found.length) { drop.appendChild(h('div', { class: 'sim-drop-empty muted' }, 'Ничего не найдено')); drop.hidden = false; return; }
        for (const p of found) {
            const iu = issueUnitOf(p);
            drop.appendChild(h('button', { type: 'button', class: 'sim-drop-item', onclick: () => { chosen = p; search.value = p.name; drop.hidden = true; onChoose(p); } },
                h('span', { class: 'sim-drop-name' }, p.name, p.code ? h('span', { class: 'muted' }, ' · ' + p.code) : null),
                h('span', { class: 'sim-drop-avail muted' }, trf('Доступно: {qty} {unit}', { qty: fmtQty(availableOf(p)), unit: iu.unit || '' }).trim())));
        }
        drop.hidden = false;
    }
    search.addEventListener('input', () => { if (chosen && search.value !== chosen.name) { chosen = null; onChoose(null); } paintDrop(); });
    search.addEventListener('focus', paintDrop);
    search.addEventListener('blur', () => setTimeout(() => { drop.hidden = true; }, 150));
    return { el: search, drop, focus: () => search.focus() };
}

/**
 * Открыть диалог выдачи.
 * @param {{ holder?: {type:'staff'|'room'|'department', id:number, name?:string}|null, onDone?: Function }} opts
 */
export function openStockIssueModal({ holder = null, onDone = null } = {}) {
    const overlay = h('div', { class: 'modal sim' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const idemKey = randomKey();
    const data = { products: [], departments: [], rooms: [], staff: [] };
    const lines = [];   // { product, qty }
    let step = 'edit';   // edit | review

    // --- Получатель: подставлен или выбирается --------------------------------
    const fixed = holder && holder.type && holder.id ? { ...holder } : null;
    const holderType = h('select', { style: { ...inpStyle, width: '180px' } },
        ...Object.entries(HOLDER_LABEL).map(([v, l]) => h('option', { value: v }, l)));
    const holderSel = h('select', { style: { ...inpStyle, flex: '1' } }, h('option', { value: '' }, '— Выберите —'));
    function paintHolders() {
        clear(holderSel);
        holderSel.appendChild(h('option', { value: '' }, '— Выберите —'));
        const rows = holderType.value === 'staff' ? data.staff : holderType.value === 'room' ? data.rooms : data.departments;
        for (const r of rows) holderSel.appendChild(h('option', { value: String(r.id) }, r.label));
    }
    holderType.addEventListener('change', paintHolders);
    function currentHolder() {
        if (fixed) return fixed;
        const id = Number(holderSel.value) || 0;
        if (!id) return null;
        const rows = holderType.value === 'staff' ? data.staff : holderType.value === 'room' ? data.rooms : data.departments;
        const r = rows.find((x) => x.id === id);
        return { type: holderType.value, id, name: r ? r.label : '' };
    }

    const noteInp = h('input', { type: 'text', placeholder: 'Основание или цель (необязательно)', style: inpStyle });

    // --- Строки ----------------------------------------------------------------
    const linesHost = h('div', { class: 'sim-lines' });
    const addBtn = h('button', { class: 'btn btn-sm', type: 'button', disabled: true, onclick: () => addLine() }, Icon('Plus', { size: 13 }), ' ', tr('Добавить позицию'));

    function availableOf(p) { const iu = issueUnitOf(p); return (Number(p.on_hand) || 0) * iu.factor; }

    function addLine() {
        const line = { product: null, qty: '' };
        lines.push(line);
        linesHost.appendChild(buildLine(line));
    }

    function buildLine(line) {
        const avail = h('div', { class: 'muted sim-avail' }, '');
        const unitEl = h('span', { class: 'muted' }, '—');
        const qtyInp = h('input', { type: 'number', min: '0', step: 'any', value: '', style: { ...numStyle, width: '110px' } });
        qtyInp.addEventListener('input', () => { line.qty = qtyInp.value; paintAvail(); });

        function paintAvail() {
            if (!line.product) { avail.textContent = ''; unitEl.textContent = '—'; row.classList.remove('is-over'); return; }
            const iu = issueUnitOf(line.product);
            const a = availableOf(line.product);
            unitEl.textContent = iu.unit || '—';
            const over = Number(line.qty) > a + 1e-9;
            avail.textContent = trf('Доступно: {qty} {unit}', { qty: fmtQty(a), unit: iu.unit || '' }).trim()
                + (over ? ' — ' + tr('больше, чем есть на складе') : '');
            row.classList.toggle('is-over', over);
        }

        const picker = productSearch({
            products: data.products,
            excludeIds: () => new Set(lines.filter((l) => l !== line && l.product).map((l) => l.product.id)),
            onChoose: (p) => { line.product = p; paintAvail(); if (p) qtyInp.focus(); },
        });

        const removeBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Убрать позицию',
            onclick: () => { const i = lines.indexOf(line); if (i >= 0) lines.splice(i, 1); row.remove(); if (!lines.length) addLine(); } }, '×');

        const row = h('div', { class: 'sim-line' },
            h('div', { class: 'sim-line-prod' }, picker.el, picker.drop, avail),
            h('div', { class: 'sim-line-qty' }, qtyInp, unitEl),
            removeBtn);
        return row;
    }

    // --- Шаги: правка → проверка ---------------------------------------------
    const body = h('div', { class: 'modal-body', style: { flex: 1, minHeight: 0, overflowY: 'auto' } });
    const primaryBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Проверить');
    const backBtn = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => { step = 'edit'; paint(); } }, 'Назад к правке');
    const title = h('h2', null, Icon('Send', { size: 16 }), ' ', tr('Выдать со склада'));

    function validLines() {
        const out = [];
        for (const l of lines) {
            if (!l.product) continue;
            const qty = Number(l.qty);
            if (!Number.isFinite(qty) || qty <= 0) continue;
            out.push({ product: l.product, qty });
        }
        return out;
    }

    function paintEdit() {
        clear(body);
        if (!fixed) {
            body.appendChild(field('Кому', h('div', { class: 'row', style: { gap: '8px' } }, holderType, holderSel), { required: true }));
        } else {
            body.appendChild(field('Кому', h('div', { class: 'sim-fixed' }, tr(HOLDER_LABEL[fixed.type] || ''), ': ', h('b', null, fixed.name || ''))));
        }
        body.appendChild(h('div', { class: 'sim-head' },
            h('span', { class: 'sim-col-prod' }, 'Товар'),
            h('span', { class: 'sim-col-qty' }, 'Количество'),
            h('span', null, '')));
        body.appendChild(linesHost);
        body.appendChild(addBtn);
        body.appendChild(field('Примечание', noteInp));
        body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            'Выданное числится за получателем: медсестра выдаёт пациенту из своих запасов, кабинета или отделения — склад второй раз не списывается.'));
        primaryBtn.textContent = tr('Проверить');
        backBtn.hidden = true;
    }

    function paintReview(dest, valid) {
        clear(body);
        body.appendChild(h('div', { class: 'sim-review' },
            h('div', { class: 'sim-review-row' }, h('span', { class: 'muted' }, 'Получатель'), h('b', null, (tr(HOLDER_LABEL[dest.type] || '') + ': ' + (dest.name || '')).trim())),
            h('div', { class: 'sim-review-row' }, h('span', { class: 'muted' }, 'Позиций'), h('b', null, String(valid.length))),
            noteInp.value.trim() ? h('div', { class: 'sim-review-row' }, h('span', { class: 'muted' }, 'Примечание'), h('span', null, noteInp.value.trim())) : null,
        ));
        body.appendChild(h('table', { class: 'list' },
            h('thead', null, h('tr', null, h('th', null, 'Товар'), h('th', { style: { textAlign: 'right' } }, 'Выдать'), h('th', { style: { textAlign: 'right' } }, 'Останется на складе'))),
            h('tbody', null, ...valid.map(({ product, qty }) => {
                const iu = issueUnitOf(product);
                return h('tr', null,
                    h('td', null, product.name),
                    h('td', { style: { textAlign: 'right' } }, fmtQty(qty) + ' ' + (iu.unit || '')),
                    h('td', { style: { textAlign: 'right' } }, fmtQty(availableOf(product) - qty) + ' ' + (iu.unit || '')));
            }))));
        primaryBtn.textContent = tr('Подтвердить выдачу');
        backBtn.hidden = false;
    }

    function paint() { if (step === 'edit') paintEdit(); }

    let sending = false;
    primaryBtn.addEventListener('click', async () => {
        if (sending) return;
        const dest = currentHolder();
        if (!dest) { toast('Укажите, кому выдаётся товар.', 'fail'); return; }
        const valid = validLines();
        if (!valid.length) { toast('Добавьте хотя бы одну позицию.', 'fail'); return; }
        const over = valid.find(({ product, qty }) => qty > availableOf(product) + 1e-9);
        if (over) { toast(trf('{name}: больше, чем есть на складе.', { name: over.product.name }), 'fail'); return; }
        if (step === 'edit') { step = 'review'; paintReview(dest, valid); return; }

        sending = true;
        primaryBtn.disabled = true;
        const prev = primaryBtn.textContent;
        primaryBtn.textContent = tr('Выдаём…');
        try {
            const payload = {
                lines: valid.map(({ product, qty }) => ({ product_id: product.id, qty, unit: 'consumption' })),
                holder: { type: dest.type, id: dest.id },
                note: noteInp.value.trim() || undefined,
                idempotency_key: idemKey,
            };
            const { data: res, error } = await supabase.rpc('issue_stock_lines', payload);
            if (error) throw error;
            toast(res && res.repeated ? 'Эта выдача уже проведена — повторно не списано.' : 'Выдано со склада', 'ok');
            // EXPIRY_BALANCE_V1 — предупреждение о просроченной партии идёт
            // ПОСЛЕ успеха и НЕ мешает закрытию: это предупреждение, а не отказ.
            toastStockWarnings(res);
            close();
            if (typeof onDone === 'function') onDone(res);
        } catch (e) {
            toast((e && e.message) || 'Не удалось выдать.', 'fail');
            sending = false;
            primaryBtn.disabled = false;
            primaryBtn.textContent = prev;
        }
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact sim-card', style: { width: '720px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' }, title, h('button', { class: 'modal-close', onclick: close }, '×')),
        body,
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            backBtn,
            h('span', { class: 'grow' }),
            primaryBtn)));
    document.body.appendChild(overlay);

    body.appendChild(h('div', { class: 'muted', style: { padding: '16px', textAlign: 'center', fontSize: '12.5px' } }, 'Загрузка товаров…'));

    (async () => {
        try {
            const reqs = [supabase.from('products').select('id,name,code,base_unit,consumption_unit,consumption_factor,on_hand').eq('active', 1).order('name', { ascending: true })];
            if (!fixed) {
                reqs.push(
                    supabase.from('departments').select('id,name').eq('active', 1).order('name', { ascending: true }),
                    supabase.from('rooms').select('id,name,code').eq('active', 1).order('name', { ascending: true }),
                    supabase.from('users').select('id,full_name,role').eq('active', 1).order('full_name', { ascending: true }));
            }
            const [pr, dr, rr, ur] = await Promise.all(reqs);
            if (pr.error) throw pr.error;
            data.products = pr.data || [];
            if (!fixed) {
                if (dr && dr.error) throw dr.error;
                if (rr && rr.error) throw rr.error;
                if (ur && ur.error) throw ur.error;
                data.departments = (dr.data || []).map((d) => ({ id: d.id, label: d.name }));
                data.rooms = (rr.data || []).map((r) => ({ id: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }));
                data.staff = (ur.data || []).map((u) => ({ id: u.id, label: u.full_name }));
                paintHolders();
            }
            addBtn.disabled = false;
            paintEdit();
            addLine();
        } catch (e) {
            clear(body);
            body.appendChild(h('div', { class: 'empty' }, trf('Не удалось загрузить товары: {msg}', { msg: (e && e.message) || '' })));
        }
    })();
    return { close };
}
