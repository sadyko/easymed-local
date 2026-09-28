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
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { canFixCashierLines } from '../permissions.js';

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
 * Окно «Исправить услуги» для счёта `inv` (строка «Приёма оплат»).
 * `onChanged` зовётся после каждой успешной правки — касса перерисуется.
 */
export async function openLineFix(inv, { onChanged = null } = {}) {
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
        intro.appendChild(h('span', null, editable
            ? tr('Пока по счёту не принято денег, услугу и врача можно поменять, лишнюю — убрать. Цену считает программа.')
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
            } else if (line && editable) {
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
