// CASHIER_HEAD_V1 (2026-09-28) — «ИСПРАВИТЬ УСЛУГИ» У КАССЫ.
//
// Владелец: «fix in the roles for the cashier, so it can change service and
// provider for appointed + add service, and if created invoice. It should be
// switchable in the roles so cashier either only accepts [payments] or accepts
// and makes small fixes».
//
// Окно открывается из строки счёта в «Приёме оплат», и ТОЛЬКО у того, кому
// выдано право «Исправляет услуги в счёте» (permissions.js canFixCashierLines;
// регистратура и администратор — по своей роли). Без права касса выглядит как
// вчера: кассир только принимает оплату.
//
// Что можно — ровно то, что пускает сервер (rpc/billing.js, двери
// cashier_line_*): у строки счёта, по которому ещё не принято денег, —
// «Заменить услугу», «Сменить врача», «Убрать»; внизу — «+ Добавить услугу».
// Цены экран не считает и не присылает: их считает сервер (личная цена врача,
// тариф визита, скидка группы), экран лишь показывает, во сколько обойдётся
// строка у каждого врача (cashier_line_performers). Отказ сервера показывается
// его же словами.
//
// CASHIER_PAID_SWAP_V1 (2026-09-28) — владелец: «paid bills: we cannot change
// the service — [we need to] make a refund or bill more if the price is
// different». В ОПЛАЧЕННОМ счёте (у кассира или администратора с тем же
// правом) у неначатой строки тоже есть «Заменить услугу» и «Сменить врача»:
// окно подтверждения до нажатия показывает, что будет с деньгами
// (cashier_line_swap_quote — та же замена в откатываемой транзакции):
// сколько вернуть пациенту и куда (тем же способом или на баланс) или сколько
// доплатить. Возврат сервер проводит сразу и печатается квитанция «Возврат
// разницы»; доплата — окно оплаты кассы (чек с пометкой «Доплата»).
// «Выставить заново» (openRebill) — невыставленные строки визита отменённого
// счёта: поменять услугу или врача, выставить счёт и принять оплату.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { canFixCashierLines, canSwapPaidLines } from '../permissions.js';

// Работа по строке начата или сделана — сервер её не меняет (PERFORMED_LINE_STATUSES).
const PERFORMED = ['collected', 'in_progress', 'resulted', 'completed'];

function fmtSum(n) {
    const v = Math.round(Number(n) || 0);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Показывать ли у счёта кнопку «Исправить услуги». */
export function canOfferLineFix(inv) {
    if (!inv || !inv.visit_id) return false;                      // стационар, депозит, карта — не визит
    if (inv.status === 'void' || inv.status === 'refunded') return false;
    if (inv.payer_id) return false;                               // счёт плательщику правят не у кассы
    const no = String(inv.invoice_number || '');
    if (no.startsWith('DEP-') || no.startsWith('CARD-')) return false;
    return canFixCashierLines();
}

/** По счёту ещё не принято денег: строки в нём можно править. */
export function invoiceEditable(inv) {
    if (!inv) return false;
    if (Number(inv.paid_amount) > 0) return false;
    return inv.status === 'unpaid' || (inv.status === 'paid' && !(Number(inv.total_amount) > 0));
}

/**
 * CASHIER_PAID_SWAP_V1 — деньги по счёту уже есть, и строки в нём меняют С
 * РАСЧЁТОМ разницы: оплачен, частично или долг. Счёт плательщику — никогда.
 */
export function invoiceSwappable(inv) {
    if (!inv || invoiceEditable(inv) || inv.payer_id) return false;
    return inv.status === 'paid' || inv.status === 'partial' || inv.status === 'debt';
}

function newIdemKey() {
    try { if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID(); } catch (e) { /* ниже запасной */ }
    return 'k' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

const METHOD_RU = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод', acquiring: 'Эквайринг', wallet: 'С баланса', gift_card: 'Подарочная карта' };
// Куда уйдёт часть возврата — словами кассы.
function refundWhere(x) {
    if (x.to_card) return tr('На ту же подарочную карту');
    if (x.to_balance) return tr('На баланс пациента');
    return tr(METHOD_RU[x.refund_method] || x.refund_method || '');
}
function cashierName() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || {};
    return u.full_name || u.username || '';
}

/** Строку можно править: услуга (не товар) и работа по ней не начата. */
export function lineFixable(line) {
    return !!line && line.clinic_item_id == null && !PERFORMED.includes(line.status);
}

// Окно того же вида, что у кассы (cashier-desk.js modal): затемнение, карточка,
// шапка с крестиком. Возвращает тело и закрытие.
function sheet(title, icon, width, onClose = null) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); if (onClose) onClose(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const body = h('div', { class: 'modal-body' });
    const foot = h('footer', { class: 'modal-foot' });
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: width + 'px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon(icon, { size: 16 }), ' ', title),
            h('button', { class: 'modal-close', type: 'button', 'aria-label': tr('Закрыть'), onclick: close }, '×')),
        body, foot));
    document.body.appendChild(overlay);
    return { overlay, body, foot, close };
}

let servicesCache = null;
async function loadServices() {
    if (servicesCache) return servicesCache;
    const { data, error } = await supabase.from('services')
        .select('id, name, price, requires_doctor').eq('active', 1).order('name', { ascending: true }).limit(5000);
    if (error) throw error;
    servicesCache = data || [];
    return servicesCache;
}

/**
 * Выбор услуги: поиск по названию. Промис: услуга или null (закрыли окно).
 */
export function pickService(title) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (done) return; done = true; resolve(v); };
        const s = sheet(title, 'Search', 480, () => finish(null));
        const search = h('input', { type: 'search', placeholder: tr('Название услуги'), 'aria-label': tr('Поиск услуги'), style: { width: '100%' } });
        const list = h('div', { style: { marginTop: '10px', maxHeight: '360px', overflowY: 'auto', display: 'grid', gap: '4px' } });
        s.body.appendChild(search);
        s.body.appendChild(list);
        s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, 'Отмена'));
        let all = [];
        const paint = () => {
            clear(list);
            const q = String(search.value || '').trim().toLowerCase();
            const rows = (q ? all.filter((x) => String(x.name || '').toLowerCase().includes(q)) : all).slice(0, 60);
            if (!rows.length) { list.appendChild(h('div', { class: 'muted', style: { padding: '8px' } }, 'Ничего не найдено.')); return; }
            for (const svc of rows) {
                list.appendChild(h('button', {
                    type: 'button', class: 'btn btn-ghost', 'data-service-id': String(svc.id),
                    style: { justifyContent: 'space-between', display: 'flex', width: '100%', textAlign: 'left' },
                    onclick: () => { finish(svc); s.overlay.remove(); },
                }, h('span', null, svc.name || '—'), h('span', { class: 'num muted' }, fmtSum(svc.price), ' ', tr('сум'))));
            }
        };
        search.addEventListener('input', paint);
        loadServices().then((rows) => { all = rows; paint(); })
            .catch((e) => { clear(list); list.appendChild(h('div', { style: { color: 'var(--crit-600)' } }, trf('Не удалось загрузить: {msg}', { msg: (e && e.message) || e }))); });
    });
}

/**
 * Выбор исполнителя. `args` — для cashier_line_performers. Промис: { id } |
 * { id: null } («без врача», если услуге врач не нужен) | null (закрыли окно).
 */
export function pickPerformer(title, args, { allowNone = false } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (done) return; done = true; resolve(v); };
        const s = sheet(title, 'Stethoscope', 460, () => finish(null));
        const list = h('div', { style: { display: 'grid', gap: '4px', maxHeight: '380px', overflowY: 'auto' } },
            h('div', { class: 'muted', style: { padding: '8px' } }, 'Загрузка…'));
        s.body.appendChild(list);
        s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, 'Отмена'));
        const pick = (v) => { finish(v); s.overlay.remove(); };
        supabase.rpc('cashier_line_performers', args).then(({ data, error }) => {
            clear(list);
            if (error) { list.appendChild(h('div', { style: { color: 'var(--crit-600)' } }, error.message || tr('Не удалось загрузить.'))); return; }
            const people = (data && data.performers) || [];
            if (allowNone && !(data && data.requires_doctor)) {
                list.appendChild(h('button', { type: 'button', class: 'btn btn-ghost', 'data-performer': 'none', style: { justifyContent: 'space-between', display: 'flex', width: '100%' }, onclick: () => pick({ id: null }) },
                    h('span', null, 'Без врача'), h('span', { class: 'num muted' }, fmtSum(data && data.catalog_price), ' ', tr('сум'))));
            }
            if (!people.length) list.appendChild(h('div', { class: 'muted', style: { padding: '8px' } }, 'Нет сотрудников, которые оказывают эту услугу.'));
            for (const p of people) {
                list.appendChild(h('button', {
                    type: 'button', class: 'btn btn-ghost', 'data-performer': String(p.id),
                    style: { justifyContent: 'space-between', display: 'flex', width: '100%', textAlign: 'left' },
                    onclick: () => pick({ id: p.id }),
                },
                h('span', null, p.full_name || ('#' + p.id), p.specialty ? h('span', { class: 'muted' }, ' · ', p.specialty) : null),
                h('span', { class: 'num' }, fmtSum(p.unit_price), ' ', tr('сум'))));
            }
        });
    });
}

async function loadInvoiceState(invoiceId) {
    const { data: invoice } = await supabase.from('invoices')
        .select('id, invoice_number, visit_id, status, subtotal, discount_amount, total_amount, paid_amount, payer_id')
        .eq('id', invoiceId).maybeSingle();
    if (!invoice) return { invoice: null, items: [], lines: [] };
    const { data: items } = await supabase.from('invoice_items')
        .select('id, description, total, discount_amount').eq('invoice_id', invoiceId).order('id', { ascending: true });
    const ids = (items || []).map((i) => i.id);
    let lines = [];
    if (ids.length) {
        const { data } = await supabase.from('visit_services')
            .select('id, service_id, status, total, invoice_item_id, clinic_item_id, consultation_type_id, doctor_id(id, full_name)')
            .in('invoice_item_id', ids);
        lines = data || [];
    }
    return { invoice, items: items || [], lines };
}

async function runRpc(name, args, okText) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) { toast(error.message || tr('Не удалось.'), 'fail'); return null; }
    if (okText) toast(okText, 'ok');
    return data || {};
}

/**
 * CASHIER_PAID_SWAP_V1 — окно подтверждения замены в оплаченном счёте.
 * `args` — { visit_service_id, new_service_id } или { visit_service_id, doctor_id }.
 * Сначала предпросмотр (что будет с деньгами), потом — сама замена. `onDone`
 * получает ответ сервера.
 */
export async function openSwapConfirm(args, { onDone = null } = {}) {
    let dest = 'original';
    const idemKey = newIdemKey();   // ключ окна: двойное нажатие не вернёт деньги дважды
    const s = sheet(tr('Замена в оплаченном счёте'), 'Repeat', 520);
    const body = h('div', { style: { display: 'grid', gap: '8px' } });
    s.body.appendChild(body);
    const okBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, tr('Заменить'));
    s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, 'Отмена'));
    s.foot.appendChild(h('span', { class: 'grow' }));
    s.foot.appendChild(okBtn);
    const callArgs = () => ({ ...args, to_balance: dest === 'balance', card_fallback: dest === 'balance' ? 'balance' : 'cash' });
    const kv = (k, v, strong = false) => h('div', { class: 'row', style: { gap: '10px', fontSize: strong ? '15px' : '13.5px', fontWeight: strong ? 800 : 500 } },
        h('span', { style: { flex: 1, color: 'var(--ink-600)' } }, k), h('span', { class: 'num' }, v));
    let quote = null;
    const render = () => {
        clear(body);
        const q = quote;
        body.appendChild(kv(tr('Было'), q.line_before || '—'));
        body.appendChild(kv(tr('Стало'), q.line_after || '—'));
        body.appendChild(kv(tr('Сумма счёта'), fmtSum(q.total_before) + ' → ' + fmtSum(q.total_after) + ' ' + tr('сум')));
        body.appendChild(kv(tr('Уже оплачено'), fmtSum(q.paid_before) + ' ' + tr('сум')));
        if (Number(q.refunded) > 0) {
            body.appendChild(h('div', { 'data-swap-refund': String(q.refunded), style: { marginTop: '6px' } },
                kv(tr('Вернуть пациенту'), fmtSum(q.refunded) + ' ' + tr('сум'), true)));
            const destBox = h('div', { style: { display: 'grid', gap: '6px' } });
            for (const [v, label] of [['original', 'Тем же способом, каким платили'], ['balance', 'На баланс пациента']]) {
                const radio = h('input', { type: 'radio', name: 'swap-dest', value: v, checked: dest === v ? true : null });
                radio.addEventListener('change', () => { if (dest === v) return; dest = v; load(); });
                destBox.appendChild(h('label', { 'data-swap-dest': v, style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13.5px', cursor: 'pointer' } }, radio, tr(label)));
            }
            body.appendChild(destBox);
            const plan = h('div', { class: 'muted', style: { fontSize: '12.5px', display: 'grid', gap: '2px' } });
            for (const x of (q.refund_plan || [])) {
                plan.appendChild(h('div', { 'data-swap-plan': x.refund_method || '' }, refundWhere(x) + ' — ' + fmtSum(x.amount) + ' ' + tr('сум')));
            }
            body.appendChild(plan);
            okBtn.textContent = trf('Заменить и вернуть {sum} сум', { sum: fmtSum(q.refunded) });
        } else if (Number(q.due) > 0) {
            body.appendChild(h('div', { 'data-swap-due': String(q.due), style: { marginTop: '6px' } },
                kv(tr('К доплате'), fmtSum(q.due) + ' ' + tr('сум'), true)));
            body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'После замены откроется окно оплаты разницы.'));
            okBtn.textContent = tr('Заменить и принять доплату');
        } else {
            body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Сумма счёта не меняется — деньги не двигаются.'));
            okBtn.textContent = tr('Заменить');
        }
    };
    const load = async () => {
        okBtn.disabled = true;
        clear(body);
        body.appendChild(h('div', { class: 'muted' }, 'Считаем…'));
        const { data, error } = await supabase.rpc('cashier_line_swap_quote', callArgs());
        if (error || !data) {
            clear(body);
            body.appendChild(h('div', { role: 'alert', style: { color: 'var(--crit-600, #dc2626)' } }, (error && error.message) || tr('Не удалось.')));
            return;
        }
        quote = data;
        render();
        okBtn.disabled = false;
    };
    okBtn.addEventListener('click', async () => {
        okBtn.disabled = true;
        const { data, error } = await supabase.rpc('cashier_line_swap_paid', { ...callArgs(), idempotency_key: idemKey });
        if (error) { toast(error.message || tr('Не удалось.'), 'fail'); okBtn.disabled = false; return; }
        s.overlay.remove();
        if (onDone) await onDone(data || {});
    });
    await load();
    return s;
}

/**
 * Окно «Исправить услуги» для счёта `inv` (строка «Приёма оплат»).
 * `onChanged` зовётся после каждой успешной правки — касса перерисуется.
 * CASHIER_PAID_SWAP_V1 — `onPayDue(row, due)`: после замены на дороже касса
 * сразу открывает окно оплаты разницы; `printSlip(data)` — квитанция
 * «Возврат разницы».
 */
export async function openLineFix(inv, { onChanged = null, onPayDue = null, printSlip = null } = {}) {
    const s = sheet(trf('Исправить услуги · {no}', { no: inv.invoice_number || ('#' + inv.id) }), 'Edit', 640);
    const intro = h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } });
    const table = h('div', { style: { display: 'grid', gap: '6px' } });
    const total = h('div', { style: { marginTop: '12px', fontWeight: 700, textAlign: 'right' } });
    s.body.appendChild(intro);
    s.body.appendChild(table);
    s.body.appendChild(total);
    const addBtn = h('button', { class: 'btn btn-primary', type: 'button' }, '+ Добавить услугу');
    s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, 'Закрыть'));
    s.foot.appendChild(h('span', { class: 'grow' }));
    s.foot.appendChild(addBtn);

    let current = inv;
    const changed = async () => { if (onChanged) { try { await onChanged(); } catch (_) { /* касса перерисуется сама */ } } };

    const paint = async () => {
        clear(table);
        table.appendChild(h('div', { class: 'muted' }, 'Загрузка…'));
        const st = await loadInvoiceState(current.id);
        clear(table); clear(intro); clear(total);
        if (!st.invoice) {
            intro.appendChild(h('span', null, 'В счёте не осталось услуг — он удалён.'));
            return;
        }
        current = { ...current, ...st.invoice };
        const editable = invoiceEditable(st.invoice);
        // CASHIER_PAID_SWAP_V1 — деньги по счёту есть: замена с расчётом разницы.
        const swappable = !editable && invoiceSwappable(st.invoice) && canSwapPaidLines();
        intro.appendChild(h('span', null, editable
            ? tr('Пока по счёту не принято денег, услугу и врача можно поменять, лишнюю — убрать. Цену считает программа.')
            : swappable
                ? tr('По счёту уже приняты деньги. У неначатой услуги можно поменять услугу или врача: разницу касса сразу вернёт пациенту или возьмёт доплату. Убрать оплаченную услугу — через «Вернуть услугу». Новая услуга будет выставлена отдельным счётом.')
                : tr('По счёту уже приняты деньги — его строки не меняются (оплаченное возвращают через «Вернуть услугу»). Новая услуга будет выставлена отдельным счётом.')));
        const byItem = new Map(st.lines.map((l) => [l.invoice_item_id, l]));
        for (const item of st.items) {
            const line = byItem.get(item.id) || null;
            const doc = line && line.doctor_id && typeof line.doctor_id === 'object' ? line.doctor_id : null;
            const actions = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } });
            if (editable && line && lineFixable(line)) {
                actions.appendChild(h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
                    const svc = await pickService(tr('Заменить услугу'));
                    if (!svc) return;
                    if (await runRpc('cashier_line_change_service', { visit_service_id: line.id, new_service_id: svc.id }, tr('Услуга заменена.'))) { await paint(); await changed(); }
                } }, 'Заменить услугу'));
                actions.appendChild(h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
                    const who = await pickPerformer(tr('Сменить врача'), { visit_service_id: line.id });
                    if (!who || who.id == null) return;
                    if (await runRpc('cashier_line_set_doctor', { visit_service_id: line.id, doctor_id: who.id }, tr('Врач заменён.'))) { await paint(); await changed(); }
                } }, 'Сменить врача'));
                actions.appendChild(h('button', { class: 'btn btn-sm', type: 'button', style: { color: 'var(--crit-600, #dc2626)' }, onclick: async () => {
                    const ok = typeof confirm === 'function' ? confirm(trf('Убрать услугу «{name}» из счёта?', { name: item.description || '—' })) : true;
                    if (!ok) return;
                    if (await runRpc('cashier_line_remove', { visit_service_id: line.id }, tr('Услуга убрана.'))) { await paint(); await changed(); }
                } }, 'Убрать'));
            } else if (swappable && line && lineFixable(line)) {
                // CASHIER_PAID_SWAP_V1 — «Убрать» здесь нет: оплаченное снимает «Вернуть услугу».
                actions.appendChild(h('button', { class: 'btn btn-sm', type: 'button', 'data-swap': 'service', onclick: async () => {
                    const svc = await pickService(tr('Заменить услугу'));
                    if (!svc) return;
                    await openSwapConfirm({ visit_service_id: line.id, new_service_id: svc.id }, { onDone: afterSwap });
                } }, 'Заменить услугу'));
                actions.appendChild(h('button', { class: 'btn btn-sm', type: 'button', 'data-swap': 'doctor', onclick: async () => {
                    const who = await pickPerformer(tr('Сменить врача'), { visit_service_id: line.id });
                    if (!who || who.id == null) return;
                    await openSwapConfirm({ visit_service_id: line.id, doctor_id: who.id }, { onDone: afterSwap });
                } }, 'Сменить врача'));
            } else if (line && (editable || swappable)) {
                actions.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Работа уже начата — не меняется'));
            }
            table.appendChild(h('div', {
                class: 'row', 'data-line': line ? String(line.id) : '',
                style: { gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--ink-50)', alignItems: 'center' },
            },
            h('div', { style: { flex: '1', minWidth: 0 } },
                h('div', { class: 'cell-strong' }, item.description || '—'),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } }, doc && doc.full_name ? doc.full_name : tr('Без врача'))),
            h('div', { class: 'num', style: { whiteSpace: 'nowrap', fontWeight: 600 } }, fmtSum(item.total), ' ', tr('сум')),
            actions));
        }
        total.appendChild(h('span', null, trf('К оплате по счёту: {sum} сум', { sum: fmtSum(st.invoice.total_amount) })));
    };

    // CASHIER_PAID_SWAP_V1 — после замены в оплаченном счёте: что стало с деньгами.
    async function afterSwap(r) {
        if (Number(r.refunded) > 0) {
            toast(r.to_balance
                ? trf('Разница {sum} сум зачислена на баланс пациента.', { sum: fmtSum(r.refunded) })
                : trf('Пациенту возвращено {sum} сум.', { sum: fmtSum(r.refunded) }), 'ok');
            if (printSlip) {
                try {
                    printSlip({ kind: 'swap', invoice: r.invoice || current, patient: { full_name: current.patient_name, mrn: current.mrn },
                        before: r.line_before, after: r.line_after, refunded: r.refunded, plan: r.refund_plan || [], cashier: cashierName() });
                } catch (e) { /* печать не отменяет проведённый возврат */ }
            }
        } else if (Number(r.due) > 0) {
            toast(trf('Услуга заменена — к доплате {sum} сум.', { sum: fmtSum(r.due) }), 'info');
        } else {
            toast(tr('Услуга заменена — сумма счёта не изменилась.'), 'ok');
        }
        await paint();
        await changed();
        if (Number(r.due) > 0 && onPayDue) {
            s.overlay.remove();   // окно оплаты разницы — поверх кассы, а не поверх этого окна
            await onPayDue({ ...current, ...(r.invoice || {}) }, Number(r.due));
        }
    }

    addBtn.addEventListener('click', async () => {
        const svc = await pickService(tr('Добавить услугу'));
        if (!svc) return;
        const who = await pickPerformer(tr('Кто оказывает услугу'), { service_id: svc.id, visit_id: current.visit_id }, { allowNone: true });
        if (!who) return;
        const r = await runRpc('cashier_line_add', { invoice_id: current.id, service_id: svc.id, doctor_id: who.id }, null);
        if (!r) return;
        if (r.invoice_created && r.invoice) {
            toast(trf('Счёт уже оплачен — услуга выставлена новым счётом {no}.', { no: r.invoice.invoice_number || ('#' + r.invoice.id) }), 'ok');
        } else {
            toast(tr('Услуга добавлена в счёт.'), 'ok');
        }
        await paint(); await changed();
    });

    await paint();
    return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// CASHIER_PAID_SWAP_V1 — «ВЫСТАВИТЬ ЗАНОВО» из «Возвратов и отмен».
// ═══════════════════════════════════════════════════════════════════════════
//
// Отменённый счёт (с «Оставить услуги», или после возврата, когда сделанная
// работа осталась в визите) оставляет строки визита без счёта. Здесь касса их
// видит, по праву «Исправляет услуги в счёте» меняет услугу и врача (двери
// неоплаченных правок — строка без счёта денег не держит), отмечает, что
// выставить, и выставляет счёт; строки, за которые пациенту вернули деньги,
// выставляются только этим явным выбором (rebill_refunded). `onBilled(invoice)`
// — касса открывает окно оплаты.
//
// REFERRAL_BILL_V1 (2026-09-29) — то же окно открывает «Ждут счёта» кассы
// (визит без отменённого счёта): `title` — свой заголовок («Выставить счёт ·
// {пациент}»), `preselectRefunded: false` — строки, за которые пациенту вернули
// деньги, не отмечены сразу: здесь их снова выставляют только явной галочкой.
// «Возвраты и отмены» по-прежнему отмечают всё (выставляют заново осознанно).
export async function openRebill(row, { onBilled = null, title = null, preselectRefunded = true } = {}) {
    const s = sheet(title || trf('Выставить заново · {no}', { no: row.invoice_number || ('#' + row.invoice_id) }), 'Receipt', 640);
    s.body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } },
        tr('Строки визита без счёта: отметьте, что выставить. Услугу и врача можно поменять до выставления.')));
    const table = h('div', { style: { display: 'grid', gap: '6px' } });
    s.body.appendChild(table);
    const billBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, tr('Выставить счёт и принять оплату'));
    s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, 'Закрыть'));
    s.foot.appendChild(h('span', { class: 'grow' }));
    s.foot.appendChild(billBtn);
    const chosen = new Set();
    let seeded = false;
    let refunded = new Set();
    const canFix = canFixCashierLines();

    const paint = async () => {
        clear(table);
        table.appendChild(h('div', { class: 'muted' }, 'Загрузка…'));
        let lines = [];
        try {
            const { data } = await supabase.from('visit_services')
                .select('id, service_id, status, quantity, unit_price, total, invoice_item_id, clinic_item_id, consultation_type_id, services(name), products(name), doctor_id(id, full_name)')
                .eq('visit_id', row.visit_id).is('invoice_item_id', null).order('id', { ascending: true });
            lines = (data || []).filter((l) => l.status !== 'cancelled' && l.invoice_item_id == null);
        } catch (e) { lines = []; }
        try {
            const { data: rf } = await supabase.rpc('visit_refunded_lines', { visit_id: row.visit_id });
            refunded = new Set(((rf && rf.line_ids) || []).map(Number));
        } catch (e) { /* без пометки сервер всё равно не выставит их молча */ }
        if (!seeded) { for (const l of lines) if (preselectRefunded || !refunded.has(Number(l.id))) chosen.add(Number(l.id)); seeded = true; }   // REFERRAL_BILL_V1 — preselectRefunded
        for (const id of [...chosen]) if (!lines.some((l) => Number(l.id) === id)) chosen.delete(id);
        clear(table);
        if (!lines.length) {
            table.appendChild(h('div', { class: 'empty' }, 'Невыставленных строк не осталось — выставлять нечего.'));
            billBtn.disabled = true;
            return;
        }
        for (const l of lines) {
            const id = Number(l.id);
            const box = h('input', { type: 'checkbox', checked: chosen.has(id) ? true : null, 'aria-label': tr('Выставить') });
            box.addEventListener('change', () => { if (box.checked) chosen.add(id); else chosen.delete(id); billBtn.disabled = !chosen.size; });
            const name = (l.services && l.services.name) || (l.products && l.products.name) || '—';
            const doc = l.doctor_id && typeof l.doctor_id === 'object' ? l.doctor_id : null;
            const tags = [];
            if (refunded.has(id)) tags.push(tr('возвращено'));
            if (PERFORMED.includes(l.status)) tags.push(tr('работа сделана'));
            const actions = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } });
            if (canFix && lineFixable(l)) {
                actions.appendChild(h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
                    const svc = await pickService(tr('Заменить услугу'));
                    if (!svc) return;
                    if (await runRpc('cashier_line_change_service', { visit_service_id: id, new_service_id: svc.id }, tr('Услуга заменена.'))) await paint();
                } }, 'Заменить услугу'));
                actions.appendChild(h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
                    const who = await pickPerformer(tr('Сменить врача'), { visit_service_id: id });
                    if (!who || who.id == null) return;
                    if (await runRpc('cashier_line_set_doctor', { visit_service_id: id, doctor_id: who.id }, tr('Врач заменён.'))) await paint();
                } }, 'Сменить врача'));
            }
            table.appendChild(h('div', {
                class: 'row', 'data-rebill-line': String(id),
                style: { gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--ink-50)', alignItems: 'center' },
            },
            box,
            h('div', { style: { flex: '1', minWidth: 0 } },
                h('div', { class: 'cell-strong' }, name, tags.length ? h('span', { class: 'muted', style: { fontWeight: 500 } }, ' · ' + tags.join(', ')) : null),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } }, doc && doc.full_name ? doc.full_name : tr('Без врача'))),
            h('div', { class: 'num', style: { whiteSpace: 'nowrap', fontWeight: 600 } }, fmtSum((Number(l.unit_price) || 0) * (Number(l.quantity) || 1)), ' ', tr('сум')),
            actions));
        }
        billBtn.disabled = !chosen.size;
    };

    billBtn.addEventListener('click', async () => {
        const ids = [...chosen];
        if (!ids.length) { toast(tr('Отметьте, что выставить.'), 'fail'); return; }
        billBtn.disabled = true;
        const { data, error } = await supabase.rpc('create_invoice_for_visit', {
            visit_id: row.visit_id, visit_service_ids: ids,
            ...(ids.some((id) => refunded.has(id)) ? { rebill_refunded: true } : {}),
        });
        if (error) { toast(error.message || tr('Не удалось.'), 'fail'); billBtn.disabled = false; return; }
        toast(trf('Счёт выставлен: {no}.', { no: (data && data.invoice && data.invoice.invoice_number) || '' }), 'ok');
        s.overlay.remove();
        if (onBilled && data && data.invoice) await onBilled(data.invoice);
    });

    await paint();
    return s;
}
