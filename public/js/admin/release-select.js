// RELEASE_SELECT_V1 (3.25.0, решение владельца) — «ЧТО МОЖНО ОКАЗАТЬ СЕЙЧАС».
//
// Частичная оплата и «Оставить как долг» больше не отпускают в работу весь счёт
// (rpc/billing.js, RELEASE_SELECT_V1): кассир отмечает, какие услуги пациент
// получит сейчас, по умолчанию — ни одной. Полная оплата отпускает всё сама, и
// блока тогда не видно. Неотмеченная услуга не попадает ни в лабораторию, ни в
// работу кабинета врача; врач видит её в своих направлениях — «ждёт оплаты».
//
// Один блок на все окна, где касса берёт часть денег или оставляет долг: окно
// оплаты кассы (cashier-desk.js payModal — к нему же ведут «Разделить оплату»,
// «Ждут счёта», «Выставить счёт» и доплата после замены) и окно визита
// (visit-modal.js «Частичная оплата» / «Долг»). Какие строки ещё не отпущены,
// говорит сервер (invoice_release_lines) — то же правило, по которому он проверит
// выбор. Сумма отмеченного — только сведения: оплату она не ограничивает.
import { supabase } from '../supabase.js';
import { h, clear } from './ui.js';
import { tr, trf } from './i18n.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Спрашивать ли кассира: внесено меньше остатка — частичная оплата. Чистая. */
export function releaseChoiceNeeded(balance, paying) {
    return r2(paying) < r2(balance) - 0.001;
}

/** Сумма отмеченных строк (сведения для кассира). Чистая. */
export function releaseSum(lines, ids) {
    const want = new Set((ids || []).map(Number));
    return r2((lines || []).filter((l) => want.has(Number(l.id))).reduce((a, l) => a + (Number(l.total) || 0), 0));
}

/**
 * RELEASE_SELECT_V1 (ревью, решение владельца) — выданный товар (product, dispensed:
 * сервер нашёл списание со склада или полки по этой строке) уже у пациента: отмечать
 * «оказать сейчас» нечего, галочки у него нет. Невыданный товар отмечается, как услуга.
 */
export function releasableLine(l) {
    return !!l && !(l.product && l.dispensed);
}

/** Неотпущенные строки счёта с сервера: [{ id, name, doctor, total }]. Бросает при отказе. */
export async function loadReleaseLines(invoiceId) {
    const { data, error } = await supabase.rpc('invoice_release_lines', { invoice_id: Number(invoiceId) });
    if (error) throw new Error(error.message || String(error));
    return Array.isArray(data && data.lines) ? data.lines.filter(releasableLine) : [];
}

let seq = 0;
/**
 * Блок с галочками: { el, sumEl, setVisible(on), load(invoiceId), ids(), sum() }.
 * Пока строки не пришли или не пришли вовсе — ids() пустой: в работу не уходит
 * ничего (то же безопасное умолчание, что у сервера). Галочки — настоящие
 * <input type="checkbox"> в <label> со своим названием: доступны с клавиатуры
 * и читаются экранным диктором; группа названа заголовком блока.
 */
export function releaseSelect({ onChange = null } = {}) {
    const headId = 'release-select-' + (++seq);
    let lines = null;          // null — грузятся; [] — неотпущенных нет
    let failed = false;
    let visible = false;
    const picked = new Set();
    const listEl = h('div', { role: 'group', 'aria-labelledby': headId,
        style: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '170px', overflowY: 'auto' } });
    const el = h('div', { 'data-release-select': '',
        style: { display: 'none', marginTop: '8px', padding: '10px 12px', borderRadius: '12px',
                 border: '1px solid var(--warn-200, #fde68a)', background: 'var(--warn-50, #fffbeb)' } },
        h('div', { id: headId, style: { fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-600)' } },
            tr('Что можно оказать сейчас')),
        h('div', { class: 'muted', style: { fontSize: '12.5px', lineHeight: 1.4, margin: '2px 0 8px' } },
            tr('Отметьте услуги, которые пациент получит сейчас. Неотмеченные ждут оплаты: в лабораторию и к врачу они не попадут.')),
        listEl);
    const sumEl = h('div', { 'data-release-sum': '', class: 'muted', style: { display: 'none', fontSize: '12.5px' } });

    const sum = () => releaseSum(lines, [...picked]);
    const paintSum = () => {
        sumEl.textContent = trf('Отмечено услуг на {sum} сум', { sum: fmt(sum()) });
        sumEl.style.display = visible && lines && lines.length ? '' : 'none';
    };
    const note = (text, color) => h('div', { class: color ? null : 'muted', style: { fontSize: '12.5px', ...(color ? { color } : {}) } }, text);
    const paintList = () => {
        clear(listEl);
        if (failed) { listEl.appendChild(note(tr('Не удалось загрузить услуги счёта — ни одна не будет передана в работу.'), 'var(--crit-700, #b91c1c)')); return; }
        if (lines === null) { listEl.appendChild(note(tr('Загрузка услуг счёта…'))); return; }
        if (!lines.length) { listEl.appendChild(note(tr('Все услуги этого счёта уже переданы в работу.'))); return; }
        for (const l of lines) {
            const id = Number(l.id);
            const cb = h('input', { type: 'checkbox', 'data-release-line': String(id), checked: picked.has(id) });
            cb.addEventListener('change', () => {
                if (cb.checked) picked.add(id); else picked.delete(id);
                paintSum();
                if (typeof onChange === 'function') onChange();
            });
            listEl.appendChild(h('label', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '3px 0', fontSize: '12.5px', cursor: 'pointer' } },
                cb,
                h('span', { style: { flex: '1', minWidth: '0', color: 'var(--ink-800)' } },
                    l.name || tr('Услуга'),
                    l.doctor ? h('span', { class: 'muted', style: { marginLeft: '6px' } }, l.doctor) : null),
                h('span', { class: 'num', style: { whiteSpace: 'nowrap' } }, fmt(l.total) + ' ' + tr('сум'))));
        }
    };
    const setVisible = (on) => {
        visible = !!on;
        el.style.display = visible ? '' : 'none';
        paintSum();
    };
    const load = async (invoiceId) => {
        try { lines = await loadReleaseLines(invoiceId); failed = false; }
        catch (e) { lines = []; failed = true; console.warn('[release-select]', e && e.message); }
        for (const id of [...picked]) if (!lines.some((l) => Number(l.id) === id)) picked.delete(id);
        paintList();
        paintSum();
        return lines;
    };
    paintList();
    return {
        el, sumEl, setVisible, load, sum,
        ids: () => (lines || []).map((l) => Number(l.id)).filter((id) => picked.has(id)),
    };
}
