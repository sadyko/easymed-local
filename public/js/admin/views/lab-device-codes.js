// LIS_MINDRAY_CODES_V1 — ИЗ ЧЕГО ВЫБИРАТЬ «Поле анализатора». Чистая функция:
// ни DOM, ни словаря, ни сети — только списки на входе и решение на выходе.
// Тот же приём, что у lab-devices-live.js: проверять надо правило, а не разметку.
//
// Порядок — решение владельца (2026-09-28):
//   1. коды, которые ЭТОТ анализатор действительно присылал («6690-2 · WBC»);
//   2. типовой список модели (профиль) — догадка, а не факт;
//   3. свой код руками — для того, чего нет ни там, ни там.
// Выбор или ввод и есть подтверждение (D4), как было.
//
// Что сохраняется при выборе присланного кода: ИМЯ (компонент 2), если оно
// есть, иначе код. Строка бланка, подтверждённая как «WBC», ловит и
// «6690-2^WBC^LN» (сеть), и «WBC^^99MRC» (переадресатор с лабораторного ПК):
// приём сравнивает с компонентом 1 или 2 (server/lis/match.js).

/** Значение пункта «Вписать код…»: не код прибора, а команда экрана. */
export const TYPE_OWN = '__lis_type_own__';

const K = (s) => String(s == null ? '' : s).trim().toUpperCase();

/**
 * @param {object} o
 * @param {Array<{code:string,name:string,value_type?:string}>} [o.sent]  что прибор присылал (lis_device_codes)
 * @param {Array<{code:string,name:string}>} [o.channels]                каналы профиля модели
 * @param {string} [o.current]                                           сохранённый device_code строки
 * @returns {{sent:Array<{value:string,label:string}>, typical:Array<{value:string,label:string}>,
 *            orphan:{value:string,label:string}|null, selected:string}}
 *   orphan   — сохранённый код, которого нет ни в одном списке: показать отдельно, а не «не выбрано»;
 *   selected — value пункта, который изображает сохранённый код ('' — ничего не сохранено).
 */
export function codeChoices({ sent = [], channels = [], current = '' } = {}) {
    const cur = K(current);
    let selected = '';

    // Числа — вперёд: режимы пробы и референсная группа (IS) тоже присылаются,
    // но в бланк их не кладут. Внутри групп — порядок прибора.
    const ordered = sent.map((c, i) => ({ c, i }))
        .sort((a, b) => ((K(b.c.value_type) === 'NM') - (K(a.c.value_type) === 'NM')) || (a.i - b.i))
        .map((x) => x.c);

    const seen = new Set();
    const sentOpts = [];
    for (const c of ordered) {
        const value = String(c.name || c.code || '').trim();
        if (!value || seen.has(K(value))) continue;
        seen.add(K(value));
        const both = c.code && c.name && K(c.code) !== K(c.name);
        sentOpts.push({ value, label: both ? c.code + ' · ' + c.name : value });
        if (cur && !selected && (cur === K(c.code) || cur === K(c.name))) selected = value;
    }

    const typical = [];
    for (const ch of channels) {
        const value = String(ch.code || '').trim();
        // Уже есть среди присланных — второй раз не показываем.
        if (!value || seen.has(K(value))) continue;
        seen.add(K(value));
        typical.push({ value, label: ch.name ? value + ' · ' + ch.name : value });
        if (cur && !selected && cur === K(value)) selected = value;
    }

    let orphan = null;
    if (cur && !selected) {
        const value = String(current).trim();
        orphan = { value, label: value };
        selected = value;
    }
    return { sent: sentOpts, typical, orphan, selected };
}
