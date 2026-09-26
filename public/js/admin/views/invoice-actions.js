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

// RPC_PORT_V1 (ревью M3) — кто двигает деньги по счёту. Сервер пускает к
// record_payment / mark_invoice_debt / refund_payment / void_invoice только
// кассу и администратора (billing.js PAYMENT_ROLES, cashier.js SHIFT_ROLES),
// считая дополнительные роли. Экран спрашивает ТОТ ЖЕ список, чтобы не
// показывать кнопку, которую сервер всё равно отвергнет.
export const INVOICE_MONEY_ROLES = ['admin', 'cashier'];
export function canMoveInvoiceMoney(roles) {
    return (Array.isArray(roles) ? roles : []).some((r) => INVOICE_MONEY_ROLES.includes(String(r)));
}
// Отказ сервера по роли (403 → code 'forbidden') — по-русски и одной фразой;
// прочие ошибки — как прислал сервер.
export function invoiceMoneyErrorText(error) {
    if (error && error.code === 'forbidden') return tr('Деньги по счёту принимает, возвращает и списывает в долг только касса или администратор.');
    return (error && (error.message || String(error))) || '—';
}

// Open the reason+amount modal. `onDone` fires after the invoice changed —
// a full success, or a refund that stopped half-way (the money that did go
// back is real, so the calling view must reload either way).
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
    // Ревью I3 — та же галочка и то же умолчание, что у кассы (cashier-desk.js
    // voidModal): отмена снимает неначатые услуги с визита, галочка их
    // оставляет, чтобы выставить счёт заново. У счёта стационара своё правило.
    const keepBox = h('input', { type: 'checkbox' });

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
            inv.admission_id ? null : h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px', margin: '0 0 10px', cursor: 'pointer' } },
                keepBox, h('span', null, 'Оставить услуги в визите — выставлю счёт заново')),
            h('div', { style: { padding: '10px 12px', background: 'var(--warn-50)', borderRadius: '8px', fontSize: '12.5px', color: 'var(--warn-700)', lineHeight: '1.55' } },
                willRefund
                    // RPC_PORT_V1 — возврат идёт по платежам (refund_payment), как у кассы.
                    ? 'Деньги вернутся по платежам счёта; при полном возврате счёт будет отменён. Добавится запись в журнал.'
                    : 'Счёт будет аннулирован, добавлена запись в журнал.',
                h('div', { style: { marginTop: '4px' } }, inv.admission_id
                    ? 'Неначатые услуги счёта снова станут доступны для выставления.'
                    : 'Неначатые услуги счёта будут сняты с визита — пациент не останется ждать кассу.'),
            ),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: close }, 'Оставить счёт'),
            h('button', {
                class: 'btn btn-danger',
                onclick: async (ev) => {
                    // Ревью I1 — кнопку берём ДО первого await: после него
                    // ev.currentTarget уже null, и разблокировка кнопки падала.
                    const btn = ev.currentTarget;
                    const reason = (reasonInp.value || '').trim();
                    if (!reason) { toast('Укажите причину.', 'fail'); reasonInp.focus(); return; }
                    let refund = 0;
                    if (willRefund) {
                        refund = Number(amountInp.value || 0);
                        if (!(refund > 0)) { toast('Сумма возврата должна быть больше 0.', 'fail'); amountInp.focus(); return; }
                        if (refund > paid) { toast('Возврат не может превышать оплаченную сумму.', 'fail'); return; }
                    }
                    if (btn) btn.disabled = true;
                    try {
                        const res = await cancelInvoice(inv, {
                            reason, refundAmount: refund, notes: (notesInp.value || '').trim() || null,
                            keepServices: !inv.admission_id && !!keepBox.checked,
                        });
                        if (res) {
                            close();
                            if (typeof onDone === 'function') onDone();
                        }
                    } finally {
                        if (btn && btn.isConnected) btn.disabled = false;
                    }
                },
            }, Icon('X', { size: 14 }), ' ', willRefund ? 'Отменить и вернуть' : 'Отменить счёт'),
        ),
    ));

    document.body.appendChild(overlay);
    setTimeout(() => reasonInp.focus(), 0);
}

// Performs the cancellation. Returns 'done' on success, 'partial' when a
// refund stopped half-way (some money did go back — the caller must reload),
// or false when nothing changed.
export async function cancelInvoice(inv0, { reason, refundAmount = 0, notes = null, keepServices = false } = {}) {
    // RPC_PORT_V1 (ревью I1) — ОТМЕНУ И ВОЗВРАТ ПРОВОДИТ СЕРВЕР.
    //
    // Здесь браузер сам правил invoices (статус, paid_amount), вставлял
    // отрицательный платёж и отвязывал строки визита. Реестр не даёт invoices и
    // payments записи с клиента ни одной роли, поэтому «Отменить счёт» всегда
    // кончался «not allowed». Теперь — те же двери, что у кассы (cashier-desk.js):
    //   • неоплаченный счёт — void_invoice (галочка «Оставить услуги в визите» —
    //     keep_services, по умолчанию выключена, как у кассы);
    //   • оплаченный — refund_payment по платежам счёта, от последнего к
    //     первому, пока не набрана сумма возврата; если ПОСЛЕДНИЙ ответ сервера
    //     говорит, что денег на счёте не осталось, счёт гасится void_invoice
    //     (сам refund_payment оставил бы его «не оплачен», то есть снова долгом).
    // Счёт перечитывается с сервера перед началом: окно могло быть открыто
    // давно, и решать по снимку на момент отрисовки нельзя.
    // Облачные остатки (списание баланса 'deposit', подарочные карты, промокоды)
    // убраны: офлайн таких платежей не бывает — платежи пишет только сервер.
    let inv = inv0;
    try {
        const { data: fresh } = await supabase.from('invoices').select('*').eq('id', inv0.id).maybeSingle();
        if (fresh) inv = { ...inv0, ...fresh };
    } catch (_) { /* снимок окна — лучше, чем ничего */ }
    if (inv.status === 'void' || inv.status === 'refunded') { toast('Счёт уже отменён.', 'info'); return false; }

    const willRefund = refundAmount > 0;
    const keep = !inv.admission_id && !!keepServices;
    const voidIt = async () => supabase.rpc('void_invoice', { invoice_id: inv.id, keep_services: keep, reason });

    let refunded = 0;
    let voided = false;
    let failure = null;
    if (!willRefund) {
        const { error } = await voidIt();
        if (error) { toast(trf('Не удалось отменить счёт: {msg}', { msg: invoiceMoneyErrorText(error) }), 'fail'); return false; }
        voided = true;
    } else {
        const { data: pays, error: pErr } = await supabase.from('payments')
            .select('id, amount, notes').eq('invoice_id', inv.id);
        if (pErr) { toast(trf('Не удалось отменить счёт: {msg}', { msg: invoiceMoneyErrorText(pErr) }), 'fail'); return false; }
        const rows = pays || [];
        const refundedOf = (pid) => rows
            .filter((r) => Number(r.amount) < 0 && (r.notes === 'REFUND#' + pid || String(r.notes || '').startsWith('REFUND#' + pid + ' ')))
            .reduce((s2, r) => s2 - Number(r.amount), 0);
        const want = Math.round(refundAmount * 100) / 100;
        let left = want;
        let lastInvoice = null;
        const positive = rows.filter((r) => Number(r.amount) > 0).sort((x, y) => Number(y.id) - Number(x.id));
        for (const pay of positive) {
            if (left <= 0) break;
            const refundable = Math.round((Number(pay.amount) - refundedOf(pay.id)) * 100) / 100;
            if (refundable <= 0) continue;
            const amt = Math.min(left, refundable);
            const { data: rRes, error } = await supabase.rpc('refund_payment', { payment_id: pay.id, amount: amt, reason });
            if (error) { failure = error; break; }
            if (rRes && rRes.invoice) lastInvoice = rRes.invoice;
            left = Math.round((left - amt) * 100) / 100;
            refunded = Math.round((refunded + amt) * 100) / 100;
        }
        if (failure) {
            console.warn('[cancel] refund stopped:', failure.message || failure);
            toast(trf('Возвращено {done} из {want}, счёт не отменён.', {
                done: refunded.toLocaleString('ru-RU'), want: want.toLocaleString('ru-RU'),
            }), 'fail');
            if (refunded <= 0) {
                toast(trf('Не удалось отменить счёт: {msg}', { msg: invoiceMoneyErrorText(failure) }), 'fail');
                return false;
            }
        } else if (lastInvoice && Number(lastInvoice.paid_amount) === 0) {
            // Полный возврат — это отмена. Решает ответ ПОСЛЕДНЕГО возврата, а
            // не снимок окна.
            const { error } = await voidIt();
            if (error) toast(trf('Не удалось отменить счёт: {msg}', { msg: invoiceMoneyErrorText(error) }), 'fail');
            else voided = true;
        }
    }
    const toStatus = voided ? 'void' : 'refunded';

    // 4. Audit row. RPC_PORT_V1 — отмену журналирует void_invoice сам; возврат
    // (refund_payment) журнала счёта не пишет — пишем здесь, и частичный тоже.
    if (refunded > 0) await logInvoiceAction(inv, {
        visitId:      inv.visit_id || null,
        action:       'refunded',
        fromStatus:   inv.status,
        toStatus:     voided ? 'void' : null,
        amount:       0,
        refundAmount: refunded,
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
            action:      refunded > 0 ? 'refunded' : 'cancelled',
            /* i18n-exempt-start: summary пишется В БАЗУ (журнал действий) — хранимая запись, а не текст экрана */
            summary:     refunded > 0
                ? `Возврат ${refunded.toLocaleString('ru-RU')} сум${voided ? ', счёт отменён' : ''} — ${reason}`
                : `Отменён — ${reason}`,
            /* i18n-exempt-end */
            detail:      { refund_amount: refunded, from_status: inv.status, to_status: toStatus, notes },
        });
    }

    if (failure) return 'partial';
    toast(!willRefund ? 'Счёт отменён.'
        : voided ? trf('Возврат {sum} сум — счёт отменён.', { sum: refunded.toLocaleString('ru-RU') })
        : trf('Возврат {sum} сум проведён.', { sum: refunded.toLocaleString('ru-RU') }));
    return 'done';
}
