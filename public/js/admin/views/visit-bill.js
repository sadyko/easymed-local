// Bill & Pay — VISIT_BILL_V1 — per-visit cashier panel: add services to a
// visit, generate an invoice from the un-invoiced lines, and take payments.
// Mirrors visits.js / services.js for structure (DOM-building via h(), the
// modal-overlay chrome: .modal / .modal-backdrop / .modal-card / .modal-head
// / .modal-close / .modal-body / .modal-foot — there is no shared modal()
// helper in ui.js, every view builds its own overlay with those classes).
//
// ALL MONEY IS SERVER-SIDE. invoices/invoice_items/payments are read-only
// here (written only by the create_invoice_for_visit / record_payment RPCs
// — see server/services/rpc/billing.js). Every total/paid/status rendered
// below comes straight off a server response or a DB read; the ONE number
// this file computes client-side is `balance = total_amount - paid_amount`,
// and that's for display only (used to disable the payment row / prefill
// the amount placeholder) — record_payment re-derives and enforces the real
// balance server-side regardless of what the client sends.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, StatusTag, Tag, fmtDateTime, field } from '../ui.js';

function currentUserId() {
    try { return (window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.id) || null; }
    catch (e) { return null; }
}

// Thousands-separated money display, no currency symbol (e.g. 50000 -> "50 000").
function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Display-only rounding for the client-computed balance subtraction.
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function sectionTitle(text) {
    return h('div', { style: {
        fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.08em',
        color: 'var(--ink-500)', fontWeight: '700', marginBottom: '8px',
    } }, text);
}

function loadingRow(colspan) {
    return h('tr', null,
        h('td', { colspan: String(colspan), style: { textAlign: 'center', padding: '18px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Loading…'));
}

// -----------------------------------------------------------------------------
// ENTRY POINT
// -----------------------------------------------------------------------------
export function openVisitBillModal(visit, onChanged) {
    const p = visit.patients || {};
    const patientName = p.full_name || '—';
    const mrn = p.mrn || '—';

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // ---- state shared across sections ----
    let unInvoicedIds = [];

    // =========================================================================
    // 1. SERVICES ON THIS VISIT
    // =========================================================================
    const linesTbody = h('tbody');
    const linesEmptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'No services on this visit yet.');

    function lineRow(r) {
        const svc = r.services;
        const prod = r.products;
        const isDispensed = r.clinic_item_id != null;
        const itemName = svc ? svc.name : (prod ? prod.name : '—');
        const billed = r.invoice_item_id != null;
        const price = svc ? svc.price : r.unit_price;
        return h('tr', null,
            h('td', null, itemName || '—',
                isDispensed ? h('span', { style: { marginLeft: '8px' } }, Tag('Dispensed', { kind: 'info' })) : null),
            h('td', { class: 'num' }, String(r.quantity)),
            h('td', { class: 'num' }, fmtPrice(price)),
            h('td', { style: { textAlign: 'center' } }, billed ? '✓' : '—'),
            h('td', null, billed ? null : h('button', {
                class: 'btn btn-sm', type: 'button',
                onclick: () => removeLine(r),
            }, 'Remove')),
        );
    }

    async function loadLines() {
        clear(linesTbody);
        linesTbody.appendChild(loadingRow(5));
        try {
            const { data, error } = await supabase.from('visit_services')
                .select('*, services(name,price), products(name,unit)')
                .eq('visit_id', visit.id)
                .order('id');
            if (error) throw error;
            const rows = data || [];
            unInvoicedIds = rows.filter(r => r.invoice_item_id == null).map(r => r.id);
            clear(linesTbody);
            if (rows.length === 0) {
                linesEmptyEl.style.display = '';
            } else {
                linesEmptyEl.style.display = 'none';
                for (const r of rows) linesTbody.appendChild(lineRow(r));
            }
        } catch (e) {
            clear(linesTbody);
            unInvoicedIds = [];
            toast('Failed to load services: ' + (e && e.message || e), 'fail');
        }
    }

    async function removeLine(line) {
        try {
            const { error } = (line && line.clinic_item_id != null)
                ? await supabase.rpc('void_dispense', { visit_service_id: line.id })
                : await supabase.from('visit_services').delete().eq('id', line.id);
            if (error) throw error;
            toast('Removed', 'ok');
            await reloadAll();
            if (typeof onChanged === 'function') await onChanged();
        } catch (e) {
            toast((e && e.message) || 'Failed to remove service.', 'fail');
        }
    }

    // ---- Add service control ----
    const addSelect = h('select', null,
        h('option', { value: '' }, '— Select a service —'));
    const addQty = h('input', { type: 'number', min: '1', step: '1', value: '1' });
    const addBtn = h('button', { class: 'btn btn-sm', type: 'button' }, Icon('Plus', { size: 13 }), ' Add');

    async function loadServiceOptions() {
        try {
            const { data, error } = await supabase.from('services')
                .select('id,name,price').eq('active', 1).order('name');
            if (error) throw error;
            for (const s of (data || [])) {
                addSelect.appendChild(h('option', { value: s.id, dataset: { price: String(s.price) } },
                    `${s.name} — ${fmtPrice(s.price)}`));
            }
        } catch (e) {
            console.warn('[visit-bill] services load failed', e && e.message || e);
        }
    }

    addBtn.addEventListener('click', async () => {
        if (!addSelect.value) { toast('Choose a service first.', 'fail'); return; }
        const opt = addSelect.selectedOptions[0];
        const price = Number(opt && opt.dataset.price) || 0;
        const qty = Number(addQty.value) || 1;

        addBtn.disabled = true;
        try {
            const { error } = await supabase.from('visit_services').insert({
                visit_id: visit.id,
                service_id: Number(addSelect.value),
                quantity: qty,
                unit_price: price,
                total: round2(price * qty),
                status: 'added',
                created_by: currentUserId(),
            }).select().single();
            if (error) throw error;
            toast('Service added', 'ok');
            addSelect.value = '';
            addQty.value = '1';
            await reloadAll();
            if (typeof onChanged === 'function') await onChanged();
        } catch (e) {
            toast((e && e.message) || 'Failed to add service.', 'fail');
        } finally {
            addBtn.disabled = false;
        }
    });

    // ---- Dispense product control ----
    const dispenseSelect = h('select', null,
        h('option', { value: '' }, '— Select a product —'));
    const dispenseQty = h('input', { type: 'number', min: '1', step: '1', value: '1' });
    const dispenseBtn = h('button', { class: 'btn btn-sm', type: 'button' }, Icon('Pill', { size: 13 }), ' Dispense');

    async function loadProductOptions() {
        try {
            const { data, error } = await supabase.from('products')
                .select('id,name,unit,on_hand,sale_price').eq('active', 1).order('name');
            if (error) throw error;
            for (const p of (data || [])) {
                dispenseSelect.appendChild(h('option', { value: p.id },
                    `${p.name} (on hand: ${p.on_hand})`));
            }
        } catch (e) {
            console.warn('[visit-bill] products load failed', e && e.message || e);
        }
    }

    dispenseBtn.addEventListener('click', async () => {
        if (!dispenseSelect.value) { toast('Choose a product first.', 'fail'); return; }
        const qty = Number(dispenseQty.value) || 1;

        dispenseBtn.disabled = true;
        try {
            const { error } = await supabase.rpc('dispense_item', {
                product_id: Number(dispenseSelect.value),
                quantity: qty,
                visit_id: visit.id,
            });
            if (error) throw error;
            toast('Dispensed', 'ok');
            dispenseSelect.value = '';
            dispenseQty.value = '1';
            await reloadAll();
            if (typeof onChanged === 'function') await onChanged();
        } catch (e) {
            toast((e && e.message) || 'Failed to dispense product.', 'fail');
        } finally {
            dispenseBtn.disabled = false;
        }
    });

    // =========================================================================
    // 2. GENERATE INVOICE
    // =========================================================================
    const generateInfoEl = h('div', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    const generateBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: true },
        Icon('Receipt', { size: 14 }), ' Generate invoice');

    generateBtn.addEventListener('click', async () => {
        if (unInvoicedIds.length === 0) return;
        generateBtn.disabled = true;
        try {
            const { error } = await supabase.rpc('create_invoice_for_visit', {
                visit_id: visit.id,
                visit_service_ids: unInvoicedIds.slice(),
            });
            if (error) throw error;
            toast('Invoice created', 'ok');
            await reloadAll();
            if (typeof onChanged === 'function') await onChanged();
        } catch (e) {
            toast((e && e.message) || 'Failed to create invoice.', 'fail');
            generateBtn.disabled = unInvoicedIds.length === 0;
        }
    });

    function updateGenerateState() {
        const n = unInvoicedIds.length;
        generateBtn.disabled = n === 0;
        generateInfoEl.textContent = n === 0 ? 'All services are billed.' : `${n} un-invoiced line${n === 1 ? '' : 's'}`;
    }

    // =========================================================================
    // 3. INVOICES & PAYMENT
    // =========================================================================
    const invoicesContainer = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });

    function statBlock(label, value) {
        return h('div', null,
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, label),
            h('div', { class: 'cell-strong' }, value),
        );
    }

    function paymentRow(inv, balance) {
        const amtInp = h('input', { type: 'number', min: '0', step: 'any', placeholder: String(balance) });
        const methodSel = h('select', null,
            h('option', { value: 'cash', selected: true }, 'Cash'),
            h('option', { value: 'card' }, 'Card'),
            h('option', { value: 'transfer' }, 'Transfer'),
        );
        const payBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Take payment');

        payBtn.addEventListener('click', async () => {
            const amt = Number(amtInp.value);
            if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a valid amount.', 'fail'); return; }

            payBtn.disabled = true;
            const prevLabel = payBtn.textContent;
            payBtn.textContent = 'Processing…';
            try {
                const { error } = await supabase.rpc('record_payment', {
                    invoice_id: inv.id, amount: amt, method: methodSel.value,
                });
                if (error) throw error;
                toast('Payment recorded', 'ok');
                await reloadAll();
                if (typeof onChanged === 'function') await onChanged();
            } catch (e) {
                toast((e && e.message) || 'Failed to record payment.', 'fail');
                payBtn.disabled = false;
                payBtn.textContent = prevLabel;
            }
        });

        return h('div', { class: 'row', style: {
            alignItems: 'flex-end',
            borderTop: '1px solid var(--ink-100)', paddingTop: '10px', marginTop: '2px',
        } },
            h('div', { style: { width: '140px' } }, field('Amount', amtInp, { required: true })),
            h('div', { style: { width: '120px' } }, field('Method', methodSel)),
            payBtn,
        );
    }

    function invoiceCard(inv) {
        const total = Number(inv.total_amount) || 0;
        const paid = Number(inv.paid_amount) || 0;
        // DISPLAY ONLY — the server's total_amount/paid_amount/status are authoritative.
        const balance = Math.max(0, round2(total - paid));

        const card = h('div', { class: 'card', style: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
                h('div', { class: 'cell-strong' }, inv.invoice_number || ('#' + inv.id)),
                StatusTag(inv.status),
            ),
            h('div', { style: { display: 'flex', gap: '24px', fontSize: '12.5px' } },
                statBlock('Total', fmtPrice(total)),
                statBlock('Paid', fmtPrice(paid)),
                statBlock('Balance', fmtPrice(balance)),
            ),
        );

        if (inv.status === 'paid') {
            card.appendChild(h('div', { style: { fontSize: '12.5px', fontWeight: '600', color: 'var(--ok-700)' } }, 'Paid ✓'));
        } else if (balance > 0 && inv.status !== 'void' && inv.status !== 'refunded') {
            card.appendChild(paymentRow(inv, balance));
        }
        return card;
    }

    async function loadInvoices() {
        clear(invoicesContainer);
        invoicesContainer.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Loading…'));
        try {
            const { data, error } = await supabase.from('invoices').select('*').eq('visit_id', visit.id).order('id');
            if (error) throw error;
            const rows = data || [];
            clear(invoicesContainer);
            if (rows.length === 0) {
                invoicesContainer.appendChild(h('div', { class: 'empty' }, 'No invoices yet — generate one above.'));
                return;
            }
            for (const inv of rows) invoicesContainer.appendChild(invoiceCard(inv));
        } catch (e) {
            clear(invoicesContainer);
            toast('Failed to load invoices: ' + (e && e.message || e), 'fail');
        }
    }

    // =========================================================================
    // reload / mount
    // =========================================================================
    async function reloadAll() {
        await Promise.all([loadLines(), loadInvoices()]);
        updateGenerateState();
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '680px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)' } },
        h('header', { class: 'modal-head' },
            h('div', null,
                h('h2', null, Icon('Receipt', { size: 16 }), ` Bill & Pay — ${patientName} (${mrn})`),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, fmtDateTime(visit.visit_date)),
            ),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('div', null,
                sectionTitle('Services on this visit'),
                h('div', { class: 'card' },
                    h('table', { class: 'tbl' },
                        h('thead', null, h('tr', null,
                            h('th', null, 'Service'),
                            h('th', null, 'Qty'),
                            h('th', null, 'Price'),
                            h('th', null, 'Billed?'),
                            h('th', null, ''),
                        )),
                        linesTbody,
                    ),
                    linesEmptyEl,
                ),
                h('div', { class: 'row', style: { alignItems: 'flex-end', marginTop: '10px' } },
                    h('div', { class: 'grow' }, field('Service', addSelect)),
                    h('div', { style: { width: '90px' } }, field('Qty', addQty)),
                    addBtn),
                h('div', { class: 'row', style: { alignItems: 'flex-end', marginTop: '8px' } },
                    h('div', { class: 'grow' }, field('Product', dispenseSelect)),
                    h('div', { style: { width: '90px' } }, field('Qty', dispenseQty)),
                    dispenseBtn),
            ),
            h('div', null,
                sectionTitle('Generate invoice'),
                h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
                    generateInfoEl, generateBtn),
            ),
            h('div', null,
                sectionTitle('Invoices & payment'),
                invoicesContainer,
            ),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')),
    ));
    document.body.appendChild(overlay);

    loadServiceOptions();
    loadProductOptions();
    reloadAll();
}
