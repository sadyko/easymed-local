// REFUND_ANY_V1 (ревью B4) — «КАКИЕ ИЗ ЭТИХ СТРОК ВИЗИТА — УСЛУГА ВОЗВРАЩЕНА».
//
// Один вопрос серверу (refunded_lines) на загрузку списка, а не по строке:
// лист лаборатории, кабинет врача («Мои приёмы»), дашборд кабинета и очередь
// процедур спрашивают через эту функцию. Сервер принимает до 1000 номеров за
// вызов — номера уходят партиями по REFUNDED_CHUNK, параллельно.
//
// Ответ — Set номеров (числа). Пустой список — пустой Set без вопроса. Сбой
// любой партии — null: экран показывает список как был (без отметок), а
// ворота сервера откажут работе и подписи по возвращённой строке сами.
import { supabase } from '../supabase.js';

export const REFUNDED_CHUNK = 500;

export async function loadRefundedLineIds(ids) {
    const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!list.length) return new Set();
    const chunks = [];
    for (let i = 0; i < list.length; i += REFUNDED_CHUNK) chunks.push(list.slice(i, i + REFUNDED_CHUNK));
    try {
        const parts = await Promise.all(chunks.map((c) => supabase.rpc('refunded_lines', { line_ids: c })));
        const out = new Set();
        for (const p of parts) {
            if (!p || p.error || !p.data || !Array.isArray(p.data.line_ids)) return null;
            for (const id of p.data.line_ids) out.add(Number(id));
        }
        return out;
    } catch (e) {
        console.warn('[refunded_lines]', e && e.message);
        return null;
    }
}
