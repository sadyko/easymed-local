// VISIT_TIER_SHOWN_CASHIER_V1 (2026-11-10) — ЧИП «ВТОРОЙ ВИЗИТ» / «ПОВТОРНЫЙ ВИЗИТ»
// У СТРОК С УЖЕ ЗАПИСАННОЙ ЦЕНОЙ: КАССА И БЫСТРАЯ РЕГИСТРАЦИЯ.
//
// Владелец: убедиться, что изменение цены по счёту визита (VISIT_TIER_PRICING_V1)
// видят и касса, и регистратура. Мастер визита и смета калькулятора показывали чип
// и зачёркнутую цену первого визита (visit-wizard.js tierChip,
// service-picker-modal.js pickerTierNote), а окно оплаты, «Исправить услуги»,
// «Выставить счёт», «Платежи» и быстрая регистрация — одну сумму, и кассир не мог
// ответить пациенту, почему 60 000, а не 200 000.
//
// Тот же вид — класс wzc-tier (admin-views.css), та же подсказка, что у мастера.
// Ярус и цену первого визита для кассы называет сервер (cashier_line_tiers,
// rpc/cashier.js): своя цена врача (OWN_PRICE_TIER_RATIO_V1) или каталог, и только
// если её можно восстановить честно; иначе — чип без зачёркнутой цены.
import { h } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { tierLabel, shownTierNote } from '../visit-tier-logic.js';

/** Подсказка чипа: дни от прошлого визита и цена первого визита — что известно. */
export function tierChipTitle(note, fmtMoney) {
    if (!note) return '';
    const price = note.firstPrice != null ? fmtMoney(note.firstPrice) : null;
    if (note.daysSince != null && price != null) {
        return trf('Прошлый визит по этой услуге — {n} дн. назад. Цена первого визита: {price}', { n: note.daysSince, price });
    }
    if (note.daysSince != null) return trf('Прошлый визит по этой услуге — {n} дн. назад.', { n: note.daysSince });
    if (price != null) return trf('Цена первого визита: {price}', { price });
    return tr('Цена по счёту визита: у пациента уже был визит по этой услуге.');
}

/**
 * Узлы рядом с суммой строки: чип яруса и (struck: true) зачёркнутая сумма по
 * цене первого визита. t — ответ по строке ({ tier, price, first_price,
 * quantity, days_since }); нет яруса — пустой список.
 */
export function tierChipNodes(t, fmtMoney, { struck = true } = {}) {
    const note = shownTierNote(t);
    if (!note) return [];
    const out = [h('span', { class: 'wzc-tier', 'data-tier-chip': note.tier, title: tierChipTitle(note, fmtMoney) }, tierLabel(note.tier))];
    if (struck && note.struck != null) {
        out.push(h('s', { class: 'num muted', 'data-tier-first': String(note.struck), style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, fmtMoney(note.struck)));
    }
    return out;
}

/**
 * Ярусы строк счёта ({ invoice_id }) или визита ({ visit_id }) с сервера.
 * → { byItem: Map(invoice_item_id → строка), byLine: Map(visit_service_id → строка) }.
 * Сбой или старый сервер — пустые карты: строки показываются без чипа, как прежде.
 */
export async function loadLineTiers(args) {
    const out = { byItem: new Map(), byLine: new Map() };
    try {
        const { data, error } = await supabase.rpc('cashier_line_tiers', args);
        if (error) return out;
        for (const l of (data && Array.isArray(data.lines) ? data.lines : [])) {
            if (!l) continue;
            if (l.invoice_item_id != null) out.byItem.set(Number(l.invoice_item_id), l);
            if (l.visit_service_id != null) out.byLine.set(Number(l.visit_service_id), l);
        }
    } catch (_) { /* без чипа */ }
    return out;
}
