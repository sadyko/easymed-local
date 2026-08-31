// Shared invoice cancel / refund + audit-log helpers. Used by:
//   * visit-modal.js  → Invoice tab "Cancel & refund" button
//   * cashier.js      → cancel action on the invoice row
//
// Why split out: both surfaces need the exact same modal + DB sequence
// (insert negative payment, flip status to void/refunded, unlink
// visit_services, write one audit row). Keeping it here avoids drift.

import { supabase } from '../../supabase.js';
import { h, Icon, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ

// Identifies the user performing the action. With auth disabled we fall
// back to whatever's rendered in the user card on the sidebar — every
// audit row still records *which seat* did it, even when no real DB id
// exists yet.
export function currentActor() {
    const u = (typeof window !== 'undefined' && window.easymed?.state?.user) || {};
    return {
        id:   u.id || null,
        name: u.full_name || u.username || 'Неизвестно',
        role: u.role || null,
    };
}

// Write one audit row. Failures are non-fatal — logging hiccups must
// never roll back a payment that already happened.
export async function logInvoiceAction(inv, { visitId = null, action, fromStatus, toStatus, amount = 0, refundAmount = 0, reason = null, notes = null } = {}) {
    const actor = currentActor();
    const row = {
        invoice_id:     inv?.id || null,
        invoice_number: inv?.invoice_number || null,
        visit_id:       visitId || inv?.visit_id || null,
        action,
        from_status:    fromStatus || null,
        to_status:      toStatus   || null,
        amount,
        refund_amount:  refundAmount,
        actor_user_id:  actor.id,
        actor_name:     actor.name,
        actor_role:     actor.role,
        reason,
        notes,
    };
    const { error } = await supabase.from('invoice_audit_log').insert(row);
    if (error) console.warn('[invoice_audit_log] insert failed:', error.message);
}

// Open the reason+amount modal. `onDone` fires after a successful
// cancellation so the calling view can refresh its rows.
export function openCancelInvoiceDialog(inv, { onDone } = {}) {
    const paid  = Number(inv.paid_amount  || 0);
    const total = Number(inv.total_amount || 0);
    const willRefund = paid > 0;

    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const reasonInp = h('textarea', {
        rows: '2',
        style: { width: '100%', resize: 'vertical' },
        placeholder: willRefund ? 'Почему возвращаются деньги?' : 'Почему отменяется счёт?',
    });
    const amountInp = h('input', {
        type: 'number', step: '0.01', min: '0', max: String(paid),
        value: String(paid),
        style: { width: '160px' },
    });
    const notesInp = h('input', {
        type: 'text', placeholder: 'Необязательно — № чека, касса и т.д.', style: { width: '100%' },
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '480px', maxWidth: 'calc(100vw - 32px)' } },   // modal-compact = opt out of MODAL_FULLSCREEN_V1
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('X', { size: 16 }), ' ', willRefund ? 'Отменить счёт и вернуть деньги' : 'Отменить счёт'),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body' },
            h('div', { style: { fontSize: '12.5px', color: 'var(--ink-600)', marginBottom: '12px' } },
                'Счёт ', h('b', null, inv.invoice_number || inv.id.slice(0, 8)),
                ' · сумма ', h('b', null, total.toLocaleString('ru-RU'), ' сум'),
                ' · оплачено ', h('b', { style: { color: paid > 0 ? 'var(--ok-700)' : 'var(--ink-500)' } }, paid.toLocaleString('ru-RU'), ' сум'),
            ),
            h('div', { class: 'field' },
                h('label', null, 'Причина ', h('span', { style: { color: 'var(--crit-700)' } }, '*')),
                reasonInp,
            ),
            willRefund && h('div', { class: 'field' },
                h('label', null, 'Сумма возврата (сум)'),
                amountInp,
                h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '4px' } },
                    'По умолчанию — вся оплаченная сумма. Уменьшите для частичного возврата.'),
            ),
            h('div', { class: 'field' },
                h('label', null, 'Заметки'),
                notesInp,
            ),
            h('div', { style: { padding: '10px 12px', background: 'var(--warn-50)', borderRadius: '8px', fontSize: '12px', color: 'var(--warn-700)', lineHeight: '1.55' } },
                willRefund
                    ? 'Счёт будет помечен как возвращённый, услуги разблокированы для повторного выставления, добавлена запись в журнал.'
                    : 'Счёт будет аннулирован, услуги разблокированы для повторного выставления, добавлена запись в журнал.',
            ),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: close }, 'Оставить счёт'),
            h('button', {
                class: 'btn btn-danger',
                onclick: async (ev) => {
                    const reason = (reasonInp.value || '').trim();
                    if (!reason) { toast('Укажите причину.', 'fail'); reasonInp.focus(); return; }
                    let refund = 0;
                    if (willRefund) {
                        refund = Number(amountInp.value || 0);
                        if (!(refund > 0)) { toast('Сумма возврата должна быть больше 0.', 'fail'); amountInp.focus(); return; }
                        if (refund > paid) { toast('Возврат не может превышать оплаченную сумму.', 'fail'); return; }
                    }
                    ev.currentTarget.disabled = true;
                    try {
                        const ok = await cancelInvoice(inv, { reason, refundAmount: refund, notes: (notesInp.value || '').trim() || null });
                        if (ok) {
                            close();
                            if (typeof onDone === 'function') onDone();
                        }
                    } finally {
                        if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false;
                    }
                },
            }, Icon('X', { size: 14 }), ' ', willRefund ? 'Отменить и вернуть' : 'Отменить счёт'),
        ),
    ));

    document.body.appendChild(overlay);
    setTimeout(() => reasonInp.focus(), 0);
}

// Performs the cancellation. Returns true on success so callers can
// decide whether to close the modal / refresh their list.
export async function cancelInvoice(inv, { reason, refundAmount = 0, notes = null } = {}) {
    const willRefund = refundAmount > 0;
    const toStatus = willRefund ? 'refunded' : 'void';

    // CATALOG_WIZARD_V2 — wizard bookings may be part-paid from the patient's
    // BALANCE ('deposit' payments + a 'spent' ledger row). That portion must
    // never leave the till as cash, and the spent balance must be restored.
    let depositPaid = 0, giftPays = [];
    try {
        const { data: ncPays } = await supabase.from('payments')
            .select('amount, method, notes').eq('invoice_id', inv.id).in('method', ['deposit', 'gift_card']);
        for (const r of (ncPays || [])) {
            const a = Math.max(0, Number(r.amount || 0));
            if (r.method === 'deposit') depositPaid += a;
            else giftPays.push(r);
        }
    } catch (_) {}
    const giftPaid = giftPays.reduce((s, r) => s + Math.max(0, Number(r.amount || 0)), 0);
    const nonCashPaid = depositPaid + giftPaid;
    if (willRefund && nonCashPaid > 0) {
        const cashPaid = Math.max(0, Number(inv.paid_amount || 0) - nonCashPaid);
        if (refundAmount > cashPaid) {
            toast(trf('Наличными вернётся {sum} сум — остальное вернётся на баланс и карты пациента.', { sum: cashPaid.toLocaleString('ru-RU') }), 'info');
            refundAmount = cashPaid;
        }
    }

    // CATALOG_WIZARD_V4 — flip the invoice status FIRST, guarded so a second run
    // (stale list / two sessions) cannot re-refund or double-restore: only one call
    // wins the void/refunded transition; everything after it runs exactly once.
    const newPaid = Math.max(Number(inv.paid_amount || 0) - refundAmount, 0);
    const { data: flipped, error: updErr } = await supabase.from('invoices').update({
        status:      toStatus,
        paid_amount: newPaid,
    }).eq('id', inv.id).not('status', 'in', '("void","refunded")').select();
    if (updErr) { toast(trf('Не удалось отменить счёт: {msg}', { msg: updErr.message }), 'fail'); return false; }
    if (!flipped || !flipped.length) { toast('Счёт уже отменён.', 'info'); return false; }

    // Negative cash payment for the running ledger (after the guarded flip).
    if (refundAmount > 0) {
        const { error: payErr } = await supabase.from('payments').insert({
            // i18n-exempt: примечание пишется В БАЗУ (payments.notes) — хранимая запись, как серверные REASONS, а не текст экрана
            invoice_id: inv.id, amount: -refundAmount, method: 'cash', notes: `Возврат — ${reason}`,
            cashier_id: (typeof window !== 'undefined' && window.easymed?.state?.user?.id) || null,   // M3 — so cash refunds land in the shift / Z-report (was NULL → false OVER variance)
        });
        if (payErr) console.warn('[payments] refund insert failed (continuing):', payErr.message);
    }

    // CATALOG_WIZARD_V2 — restore the balance the wizard spent on this invoice.
    if (depositPaid > 0) {
        try {
            const { data: spentRows } = await supabase.from('patient_deposits')
                .select('id, patient_id, amount').eq('status', 'spent').ilike('notes', `%spend:${inv.id}%`);
            for (const r of (spentRows || [])) {
                await supabase.from('patient_deposits').insert({
                    patient_id: r.patient_id, amount: Number(r.amount || 0), method: 'other',
                    status: 'received', notes: 'unspend:' + inv.id,
                });
            }
        } catch (e) { console.warn('[cancel] deposit unspend:', e.message); }
    }
    // CATALOG_WIZARD_V4 — restore gift-card/certificate balances via the atomic RPC.
    if (giftPaid > 0) {
        try {
            for (const gp of giftPays) {
                const mId = /gift:([0-9a-f-]+)/i.exec(gp.notes || '');
                if (mId) await supabase.rpc('restore_patient_discount', { p_id: mId[1], p_amount: Math.max(0, Number(gp.amount || 0)) });
            }
        } catch (e) { console.warn('[cancel] gift restore:', e.message); }
    }
    // CATALOG_WIZARD_V4 — return the promo use (promo:<id> marker payment).
    try {
        const { data: promoPays } = await supabase.from('payments')
            .select('notes').eq('invoice_id', inv.id).ilike('notes', 'promo:%');
        for (const pp of (promoPays || [])) {
            const m = /promo:([0-9a-f-]+)/i.exec(pp.notes || '');
            if (m) await supabase.rpc('release_promo_use', { p_id: m[1] });
        }
    } catch (e) { console.warn('[cancel] promo release:', e.message); }

    // 3. Unlink visit_services so they can be re-billed on a fresh
    //    invoice. invoice_items stays as a permanent record.
    const { data: items } = await supabase
        .from('invoice_items').select('id').eq('invoice_id', inv.id);
    const ids = (items || []).map(r => r.id);
    if (ids.length) {
        await supabase.from('visit_services').update({ invoice_item_id: null }).in('invoice_item_id', ids);
    }

    // 4. Audit row.
    await logInvoiceAction(inv, {
        visitId:      inv.visit_id || null,
        action:       toStatus,
        fromStatus:   inv.status,
        toStatus,
        amount:       0,
        refundAmount,
        reason,
        notes,
    });

    // 5. Mirror into the patient-wide activity feed so the patient card's
    //    log shows cancelled invoices alongside referrals / service edits.
    //    Imported lazily to avoid a circular dependency.
    if (inv.patient_id) {
        const { logPatientActivity } = await import('./activity-log.js');
        await logPatientActivity({
            patientId:   inv.patient_id,
            visitId:     inv.visit_id || null,
            entityType:  'invoice',
            entityId:    inv.id,
            entityLabel: inv.invoice_number || inv.id.slice(0, 8),
            action:      willRefund ? 'refunded' : 'cancelled',
            /* i18n-exempt-start: summary пишется В БАЗУ (журнал действий) — хранимая запись, а не текст экрана */
            summary:     willRefund
                ? `Возврат ${refundAmount.toLocaleString('ru-RU')} сум — ${reason}`
                : `Отменён — ${reason}`,
            /* i18n-exempt-end */
            detail:      { refund_amount: refundAmount, from_status: inv.status, to_status: toStatus, notes },
        });
    }

    toast(willRefund
        ? trf('Возврат {sum} сум — счёт отменён.', { sum: refundAmount.toLocaleString('ru-RU') })
        : 'Счёт отменён.');
    return true;
}
