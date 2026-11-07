// DISCOUNT_V2 (3.22.0, ревью S1 L-4) — ПРИЧИНА СКИДКИ СЧЁТА НА ЯЗЫКЕ ЭКРАНА.
//
// invoices.discount_note сервер собирает по-русски (domain/discount-choice.js,
// billing.js cashier_invoice_discount): «Скидка группы «VIP» — 10%», «Промокод «ЛЕТО» —
// 15%», «Скидка вручную», «Касса: <причина> — 5% — 5 000 сум (доля врача — от цены до
// скидки)», части — через «; ». Касса на узбекском и английском показывала их как есть.
// Здесь неизменные части переводятся словарём; имя группы, промокода и причина кассира
// остаются, как их ввели. Незнакомая часть (запись другой версии) — как есть.
// Образцы ниже — регулярные выражения (разбор записи сервера), а не текст экрана: экран
// показывает только trf() по ключам словаря.
import { tr, trf } from './i18n.js';

const RE_GROUP = /^Скидка группы «(.*)» — (\d+(?:,\d+)?)%$/;
const RE_PROMO_PCT = /^Промокод «(.*)» — (\d+(?:,\d+)?)%$/;
const RE_PROMO_SUM = /^Промокод «(.*)» — (\d[\d\s ]*) сум$/;
const RE_DESK = /^Касса: (.+?) — (?:(\d+(?:,\d+)?)% — )?(\d[\d\s ]*) сум( \(доля врача — от цены до скидки\))?$/;
const MANUAL = /^Скидка вручную$/;

function piece(p) {
    let m;
    if (MANUAL.test(p)) return tr('Скидка вручную');
    if ((m = RE_GROUP.exec(p))) return trf('Скидка группы «{name}» — {pct}%', { name: m[1], pct: m[2] });
    if ((m = RE_PROMO_PCT.exec(p))) return trf('Промокод «{name}» — {value}%', { name: m[1], value: m[2] });
    if ((m = RE_PROMO_SUM.exec(p))) return trf('Промокод «{name}» — {value} сум', { name: m[1], value: m[2].trim() });
    if ((m = RE_DESK.exec(p))) {
        const head = m[2] != null
            ? trf('Касса: {reason} — {pct}% — {sum} сум', { reason: m[1], pct: m[2], sum: m[3].trim() })
            : trf('Касса: {reason} — {sum} сум', { reason: m[1], sum: m[3].trim() });
        return m[4] ? head + ' ' + tr('(доля врача — от цены до скидки)') : head;
    }
    return p;
}

/** Причина скидки счёта (invoices.discount_note) на языке экрана; пусто — ''. */
export function discountNoteText(note) {
    const s = String(note == null ? '' : note);
    if (!s) return '';
    return s.split('; ').map(piece).join('; ');
}
