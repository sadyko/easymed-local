// Cashback crediting — runs when an invoice becomes fully paid.
//
// Looks up the matching active rule in `cashback_rules` (migration 028) and
// credits the patient a % of the AFTER-TAX (net) invoice amount as usable
// credit — recorded as a `received` patient_deposits row, which is what the
// patient card surfaces in the "Cashback" balance.
//
// Rule matching (within validity window, active):
//   • payer scope — a rule with payer_id applies only to that payer; a rule
//     with payer_id = NULL applies to everyone / self-pay.
//   • the net amount must be ≥ the rule's min_purchase.
//   • best rule wins: payer-specific over generic, then highest %.
//
// Idempotent: a marker in the deposit notes (`cashback:<invoice_id>`) prevents
// a second credit if the invoice is re-paid / the function runs twice.

import { supabase } from '../../supabase.js';
import { currentUser } from '../data.js';

// Credit cashback for an invoice that has just been fully paid. Returns the
// credited amount (UZS) or 0 if nothing applied. Never throws — payment must
// succeed even if cashback can't be computed.
export async function creditCashbackOnPaid(invoiceId) {
    try {
        if (!invoiceId) return 0;

        const { data: inv, error } = await supabase.from('invoices')
            .select('id, invoice_number, patient_id, branch_id, payer_id, subtotal, tax_amount, total_amount, status')
            .eq('id', invoiceId).maybeSingle();
        if (error || !inv || inv.status !== 'paid' || !inv.patient_id) return 0;

        // Idempotency guard — already credited for this invoice?
        const marker = `cashback:${inv.id}`;
        const seen = await supabase.from('patient_deposits')
            .select('id').eq('patient_id', inv.patient_id).ilike('notes', `%${marker}%`).limit(1);
        if (seen.data && seen.data.length) return 0;

        // Active rules.
        const { data: rules, error: rErr } = await supabase.from('cashback_rules').select('*').eq('active', true);
        if (rErr) {
            if (/cashback_rules/i.test(rErr.message || '')) console.warn('[cashback] table missing — apply migration 028.');
            return 0;
        }
        if (!rules || !rules.length) return 0;

        // Base = after-tax (net) amount. Prefer the stored subtotal; otherwise
        // total minus tax.
        const total = Number(inv.total_amount || 0);
        const tax   = Number(inv.tax_amount || 0);
        let base  = inv.subtotal != null ? Number(inv.subtotal) : Math.max(0, total - tax);
        // CATALOG_WIZARD_V2 — the balance-paid portion earns no cashback (and a
        // fully-balance-paid invoice earns none): no cashback-on-cashback.
        try {
            const { data: depPays } = await supabase.from('payments')
                .select('amount').eq('invoice_id', inv.id).eq('method', 'deposit');
            const dep = (depPays || []).reduce((s, r) => s + Math.max(0, Number(r.amount || 0)), 0);
            if (dep > 0) base = Math.max(0, base - dep);
        } catch (_) {}

        const today = new Date().toISOString().slice(0, 10);
        const eligible = rules.filter(r => {
            if (r.valid_from && r.valid_from > today) return false;
            if (r.valid_to && r.valid_to < today) return false;
            if (r.payer_id && String(r.payer_id) !== String(inv.payer_id || '')) return false;
            if (base < Number(r.min_purchase || 0)) return false;
            return true;
        });
        if (!eligible.length) return 0;

        // Payer-specific first, then highest %.
        eligible.sort((a, b) => {
            const ap = a.payer_id ? 1 : 0, bp = b.payer_id ? 1 : 0;
            if (ap !== bp) return bp - ap;
            return Number(b.cashback_percent || 0) - Number(a.cashback_percent || 0);
        });
        const rule = eligible[0];

        let cashback = base * Number(rule.cashback_percent || 0) / 100;
        if (rule.max_cashback != null) cashback = Math.min(cashback, Number(rule.max_cashback));
        cashback = Math.round(cashback);
        if (cashback <= 0) return 0;

        const u = currentUser();
        const { error: insErr } = await supabase.from('patient_deposits').insert({
            patient_id:       inv.patient_id,
            branch_id:        inv.branch_id || null,
            amount:           cashback,
            method:           'other',
            status:           'received',
            notes:            `Cashback ${rule.cashback_percent}% on ${inv.invoice_number || inv.id.slice(0, 8)} · ${marker}`,
            created_by:       u?.id || null,
            created_by_name:  'Cashback',
            received_by:      u?.id || null,
            received_by_name: u?.full_name || 'Cashback',
            received_at:      new Date().toISOString(),
        });
        if (insErr) { console.warn('[cashback] credit failed:', insErr.message); return 0; }
        return cashback;
    } catch (e) {
        console.warn('[cashback] error:', e.message);
        return 0;
    }
}
