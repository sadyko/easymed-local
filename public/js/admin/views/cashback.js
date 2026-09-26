// Cashback crediting — runs when an invoice becomes fully paid.
//
// CASHBACK_SERVER_V1 (ревью денег I4, 2026-09-26) — начисляет СЕРВЕР
// (credit_cashback, server/services/rpc/cashback.js). Прежде здесь браузер
// читал облачные колонки правил, которых офлайн нет, и сам вставлял строку
// patient_deposits: база кэшбэка не исключала оплату балансом и картой, а
// строку баланса мог вставить любой клиент. Теперь правило, база (только новые
// деньги, без 'wallet' и 'gift_card'), «один раз на счёт» и откат при возврате
// живут на сервере; реестр клиенту запись в patient_deposits не даёт.

import { supabase } from '../../supabase.js';

// Credit cashback for an invoice that has just been fully paid. Returns the
// credited amount (UZS) or 0 if nothing applied. Never throws — payment must
// succeed even if cashback can't be computed.
export async function creditCashbackOnPaid(invoiceId) {
    try {
        if (!invoiceId) return 0;
        const { data, error } = await supabase.rpc('credit_cashback', { invoice_id: Number(invoiceId) });
        if (error) { console.warn('[cashback] credit failed:', error.message || error); return 0; }
        return Number(data && data.credited) || 0;
    } catch (e) {
        console.warn('[cashback] error:', e.message);
        return 0;
    }
}
