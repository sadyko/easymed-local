// SEARCHABLE_SELECT_V1 — длинный <select> с поиском.
//
// Список врачей в клинике перевалил за два десятка, и обычный <select> стал
// стеной имён во весь экран: нужного ищут глазами сверху вниз, а на ноутбуке
// список ещё и перекрывает саму форму.
//
// Оригинальный <select> НЕ выбрасывается, а прячется и остаётся источником
// правды: код формы читает `sel.value` и слушает `change` — как и раньше, ничего
// в местах вызова менять не нужно. Это же и страховка: сломайся обёртка,
// значение всё равно лежит в настоящем поле.
//
// Варианты читаются ЛЕНИВО, при каждом открытии: списки здесь дозагружаются
// асинхронно (`supabase...then(... appendChild)`), и компонент, снявший копию
// один раз при создании, показывал бы пустоту.

import { h } from '../ui.js';
import { filterByLabel } from '../../shared/text-match.js?v=tm1';   // TEXT_MATCH_V1 — правила поиска и тесты к ним

// sel — настоящий <select>. Возвращает элемент, который кладут в форму ВМЕСТО
// него (сам select уезжает внутрь скрытым).
// `background` — фон САМОГО поля (не выпадающего списка): им подсвечивают
// фильтр, чтобы было видно, что выборка сужена. По умолчанию белый, как везде.
export function searchableSelect(sel, { placeholder = 'Поиск…', background = 'var(--white, #fff)' } = {}) {
    sel.style.display = 'none';

    const input = h('input', {
        type: 'text', placeholder, autocomplete: 'off',
        style: {
            width: '100%', height: '40px', padding: '0 30px 0 12px', fontFamily: 'inherit',
            fontSize: '13.5px', border: '1px solid var(--ink-200)', borderRadius: '10px',
            background, outline: 'none', cursor: 'pointer',
        },
    });
    const caret = h('span', { style: {
        position: 'absolute', right: '11px', top: '50%', transform: 'translateY(-50%)',
        pointerEvents: 'none', color: 'var(--ink-400)', fontSize: '11px',
    } }, '▼');
    const list = h('div', { style: {
        position: 'absolute', left: '0', right: '0', top: 'calc(100% + 4px)', zIndex: '30',
        maxHeight: '260px', overflowY: 'auto', display: 'none',
        background: 'var(--white, #fff)', border: '1px solid var(--ink-200)',
        borderRadius: '10px', boxShadow: 'var(--shadow-lg, 0 10px 30px rgba(11,20,24,.16))',
    } });
    // SEARCHABLE_PLACEHOLDER_V1 — сброс выбора крестиком.
    //
    // Пустой пункт («— Лечащий врач —») больше не показывается строкой списка:
    // он не выбор, а подсказка, и в перечне врачей читался как ещё один врач.
    // Но сбросить уже выбранного врача по-прежнему нужно — для этого крестик,
    // который появляется только когда есть что сбрасывать.
    const clearBtn = h('button', {
        type: 'button', title: 'Очистить',
        style: {
            position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
            display: 'none', border: 'none', background: 'transparent', cursor: 'pointer',
            color: 'var(--ink-400)', fontSize: '15px', lineHeight: '1', padding: '2px 4px',
        },
        // mousedown, а не click: blur поля успел бы закрыть список раньше клика.
        onmousedown: (e) => { e.preventDefault(); pick({ value: '', label: '' }); },
    }, '×');
    const wrap = h('div', { style: { position: 'relative' } }, input, caret, clearBtn, list);

    const options = () => [...sel.options].map((o) => ({ value: o.value, label: o.textContent }));
    const labelOf = (v) => (options().find((o) => o.value === v) || {}).label || '';
    // Ничего не выбрано — поле ПУСТОЕ, и подсказку рисует родной placeholder
    // (серый, исчезает при вводе). Раньше сюда подставлялась подпись пустого
    // пункта, и «— Лечащий врач —» выглядело выбранным значением: при клике
    // оно ещё и подсвечивалось синим, будто это чьё-то имя.
    const showLabel = () => {
        const has = !!sel.value;
        input.value = has ? labelOf(sel.value) : '';
        clearBtn.style.display = has ? '' : 'none';
        caret.style.display = has ? 'none' : '';
    };

    let open = false;
    let active = -1;
    let rows = [];

    const close = () => { open = false; list.style.display = 'none'; active = -1; showLabel(); };

    const paint = (query) => {
        list.replaceChildren();
        // Пустой пункт из списка исключён: он подсказка, а не вариант выбора.
        rows = filterByLabel(options().filter((o) => o.value !== ''), query);
        if (!rows.length) {
            list.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } }, 'Ничего не найдено'));
            return;
        }
        rows.forEach((o, i) => {
            const isCur = o.value === sel.value;
            const row = h('div', {
                style: {
                    padding: '9px 12px', fontSize: '13.5px', cursor: 'pointer',
                    background: i === active ? 'var(--primary-50, #e8f3f2)' : 'transparent',
                    color: o.value === '' ? 'var(--ink-500)' : 'var(--ink-900)',
                    fontWeight: isCur ? '700' : '400',
                },
                onmouseenter: (e) => { active = i; e.currentTarget.style.background = 'var(--primary-50, #e8f3f2)'; },
                onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
                // mousedown, а не click: blur поля успел бы закрыть список раньше клика.
                onmousedown: (e) => { e.preventDefault(); pick(o); },
            }, o.label);
            list.appendChild(row);
        });
    };

    const pick = (o) => {
        sel.value = o.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        close();
    };

    // При открытии поле очищается: пользователь нажал, чтобы ВЫБРАТЬ, и ему
    // нужен пустой ввод под фамилию, а не выделенный синим прежний текст.
    // Если он передумает и уйдёт, close() вернёт прежнюю подпись.
    const openList = () => { open = true; list.style.display = ''; active = -1; input.value = ''; paint(''); };

    input.addEventListener('focus', openList);
    input.addEventListener('click', () => { if (!open) openList(); });
    input.addEventListener('input', () => { if (!open) { open = true; list.style.display = ''; } active = -1; paint(input.value); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { close(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) { openList(); return; }
            active = Math.max(0, Math.min(rows.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
            paint(input.value === labelOf(sel.value) ? '' : input.value);
            const el = list.children[active];
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
            return;
        }
        if (e.key === 'Enter' && open) { e.preventDefault(); if (rows[active]) pick(rows[active]); }
    });
    input.addEventListener('blur', () => { setTimeout(() => { if (open) close(); }, 0); });

    showLabel();
    // Значение могли поставить снаружи (предзаполнение формы) — держим подпись.
    sel.addEventListener('change', () => { if (!open) showLabel(); });

    wrap.appendChild(sel);
    return wrap;
}
