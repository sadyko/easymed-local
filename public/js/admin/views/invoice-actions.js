// Shared invoice cancel / refund + audit-log helpers. Used by:
//   * visit-modal.js  → Invoice tab "Cancel & refund" button
//
// RPC_PORT_V1 — the money moves on the server (void_invoice / refund_payment,
// the same doors as the cashier desk); this module is the dialog + the logs.

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
                'Счёт ', h('b', null, inv.invoice_number || String(inv.id)),
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
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                    'По умолчанию — вся оплаченная сумма. Уменьшите для частичного возврата.'),
            ),
            h('div', { class: 'field' },
                h('label', null, 'Заметки'),
                notesInp,
            ),
            h('div', { style: { padding: '10px 12px', background: 'var(--warn-50)', borderRadius: '8px', fontSize: '12.5px', color: 'var(--warn-700)', lineHeight: '1.55' } },
                willRefund
                    // RPC_PORT_V1 — возврат идёт по платежам (refund_payment), как у кассы: строки визита остаются за счётом.
                    ? 'Деньги вернутся по платежам счёта; при полном возврате счёт будет отменён, услуги останутся в визите для повторного выставления. Добавится запись в журнал.'
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

    // RPC_PORT_V1 (ревью I1) — ОТМЕНУ И ВОЗВРАТ ПРОВОДИТ СЕРВЕР.
    //
    // Здесь браузер сам правил invoices (статус, paid_amount), вставлял
    // отрицательный платёж и отвязывал строки визита. Реестр не даёт invoices и
    // payments записи с клиента ни одной роли, поэтому «Отменить счёт» всегда
    // кончался «not allowed». Теперь — те же двери, что у кассы (cashier-desk.js):
    //   • неоплаченный счёт — void_invoice с keep_services: услуги остаются в
    //     визите невыставленными, как и обещает окно, запись в журнал пишет
    //     сервер;
    //   • оплаченный — refund_payment по платежам счёта, от последнего к
    //     первому, пока не набрана сумма возврата: деньги уходят из смены того,
    //     кто возвращает, а статус счёта сервер пересчитывает сам.
    // Облачные остатки (списание баланса 'deposit', подарочные карты, промокоды)
    // убраны: офлайн таких платежей не бывает — платежи пишет только сервер.
    if (!willRefund) {
        const { error } = await supabase.rpc('void_invoice', { invoice_id: inv.id, keep_services: true, reason });
        if (error) { toast(trf('Не удалось отменить счёт: {msg}', { msg: error.message || error }), 'fail'); return false; }
    } else {
        const { data: pays, error: pErr } = await supabase.from('payments')
            .select('id, amount, notes').eq('invoice_id', inv.id);
        if (pErr) { toast(trf('Не удалось отменить счёт: {msg}', { msg: pErr.message || pErr }), 'fail'); return false; }
        const rows = pays || [];
        const refundedOf = (pid) => rows
            .filter((r) => Number(r.amount) < 0 && (r.notes === 'REFUND#' + pid || String(r.notes || '').startsWith('REFUND#' + pid + ' ')))
            .reduce((s2, r) => s2 - Number(r.amount), 0);
        let left = Math.round(refundAmount * 100) / 100;
        const positive = rows.filter((r) => Number(r.amount) > 0).sort((x, y) => Number(y.id) - Number(x.id));
        for (const pay of positive) {
            if (left <= 0) break;
            const refundable = Math.round((Number(pay.amount) - refundedOf(pay.id)) * 100) / 100;
            if (refundable <= 0) continue;
            const amt = Math.min(left, refundable);
            const { error } = await supabase.rpc('refund_payment', { payment_id: pay.id, amount: amt, reason });
            if (error) { toast(trf('Не удалось отменить счёт: {msg}', { msg: error.message || error }), 'fail'); return false; }
            left = Math.round((left - amt) * 100) / 100;
        }
        if (left > 0) refundAmount = Math.round((refundAmount - left) * 100) / 100;
        // Полный возврат — это отмена: refund_payment оставляет счёт «не
        // оплачен» (для кассы — снова долг пациента), поэтому счёт без денег
        // гасится тем же void_invoice. Частичный возврат счёт не отменяет.
        if (Number(inv.paid_amount || 0) - refundAmount <= 0) {
            const { error } = await supabase.rpc('void_invoice', { invoice_id: inv.id, keep_services: true, reason });
            if (error) { toast(trf('Не удалось отменить счёт: {msg}', { msg: error.message || error }), 'fail'); return false; }
        }
    }

    // 4. Audit row. RPC_PORT_V1 — отмену журналирует void_invoice сам; возврат
    // (refund_payment) журнала счёта не пишет — пишем здесь.
    if (willRefund) await logInvoiceAction(inv, {
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
            entityLabel: inv.invoice_number || String(inv.id),
            action:      willRefund ? 'refunded' : 'cancelled',
            /* i18n-exempt-start: summary пишется В БАЗУ (журнал действий) — хранимая запись, а не текст экрана */
            summary:     willRefund
                ? `Возврат ${refundAmount.toLocaleString('ru-RU')} сум — ${reason}`
                : `Отменён — ${reason}`,
            /* i18n-exempt-end */
            detail:      { refund_amount: refundAmount, from_status: inv.status, to_status: toStatus, notes },
        });
    }

    // RPC_PORT_V1 — частичный возврат счёт не отменяет: он остаётся частично оплаченным.
    const fullRefund = willRefund && Number(inv.paid_amount || 0) - refundAmount <= 0;
    toast(!willRefund ? 'Счёт отменён.'
        : fullRefund ? trf('Возврат {sum} сум — счёт отменён.', { sum: refundAmount.toLocaleString('ru-RU') })
        : trf('Возврат {sum} сум проведён.', { sum: refundAmount.toLocaleString('ru-RU') }));
    return true;
}
