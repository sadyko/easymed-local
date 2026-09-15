// TABLE_SETUP_V1 (2026-09-15) — «Настройка таблицы»: which columns a list
// shows and in what order, kept per browser. One dialog for every list that
// offers it (the services catalogue, the settings registers): left — the
// columns in their current order (drag the grip to reorder, untick to
// remove), right — the columns that can be added, «По умолчанию» restores the
// list's own default, «Применить» saves. The owner's reference had exactly
// this dialog; it lives here so no screen grows its own copy.
//
// Pure of any list's data: callers pass the column list ({key, label}), the
// default keys, the storage key, and get the chosen keys back.
import { h, Icon, clear } from '../ui.js';
import { tr } from '../i18n.js';

/** The saved order for `prefKey`, or null when unset/invalid (then the caller's default applies). */
export function readColPrefs(prefKey, validKeys) {
    try {
        const v = JSON.parse(localStorage.getItem(prefKey));
        if (Array.isArray(v) && v.length && v.every((k) => validKeys.includes(k))) return v;
    } catch (e) { /* no prefs or a broken value — defaults */ }
    return null;
}

/** Save the order; the default order is stored as "nothing" so a changed default reaches everyone. */
export function writeColPrefs(prefKey, keys, defaults) {
    try {
        if (!keys || keys.join() === (defaults || []).join()) localStorage.removeItem(prefKey);
        else localStorage.setItem(prefKey, JSON.stringify(keys));
    } catch (e) { /* private mode — the choice lives until reload */ }
}

/**
 * Open the dialog.
 * @param {object}   opts
 * @param {Array}    opts.columns   [{ key, label }] — every column the list can show
 * @param {string[]} opts.visible   keys currently shown, in order
 * @param {string[]} opts.defaults  keys of the list's default set, in order
 * @param {function} opts.onApply   (keys) => void — called with the chosen order
 */
export function openTableSetup({ columns, visible, defaults, onApply }) {
    const colByKey = (k) => columns.find((c) => c.key === k);
    let vis = visible.filter((k) => !!colByKey(k));
    let drag = null;   // key being dragged
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();

    const leftCount = h('b', null, '');
    const rightCount = h('b', null, '');
    const leftList = h('div', { class: 'tset-list', ondragover: (e) => { if (drag) e.preventDefault(); }, ondrop: (e) => { e.preventDefault(); moveTo(drag, vis.length); } });
    const rightList = h('div', { class: 'tset-list tset-avail' });

    const moveTo = (key, index) => {
        if (!key) return;
        const from = vis.indexOf(key);
        if (from < 0) return;
        const next = vis.filter((k) => k !== key);
        next.splice(index > from ? index - 1 : index, 0, key);
        vis = next; drag = null; paint();
    };
    const paint = () => {
        clear(leftList); clear(rightList);
        leftCount.textContent = String(vis.length);
        for (const key of vis) {
            const c = colByKey(key);
            const row = h('div', { class: 'tset-row', draggable: 'true',
                ondragstart: (e) => { drag = key; try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); } catch (err) { /* fake DOM */ } },
                ondragover: (e) => { if (!drag || drag === key) return; e.preventDefault(); e.stopPropagation(); },
                ondrop: (e) => { e.preventDefault(); e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : { top: 0, height: 0 };
                    const after = r.height && (e.clientY - r.top) > r.height / 2;
                    moveTo(drag, vis.indexOf(key) + (after ? 1 : 0)); },
            },
                h('label', { class: 'tset-check' },
                    h('input', { type: 'checkbox', checked: true, onchange: () => { if (vis.length > 1) { vis = vis.filter((k) => k !== key); paint(); } else paint(); } }),
                    h('span', null, c.label)),
                h('span', { class: 'tset-grip', title: tr('Перетащите, чтобы изменить порядок') }, Icon('Grid', { size: 14 })));
            leftList.appendChild(row);
        }
        const avail = columns.filter((c) => !vis.includes(c.key));
        rightCount.textContent = String(avail.length);
        if (!avail.length) rightList.appendChild(h('div', { class: 'tset-empty' }, 'Все колонки уже в таблице'));
        for (const c of avail) {
            rightList.appendChild(h('div', { class: 'tset-row' },
                h('label', { class: 'tset-check' },
                    h('input', { type: 'checkbox', onchange: () => { vis = [...vis, c.key]; paint(); } }),
                    h('span', null, c.label))));
        }
    };
    paint();

    const apply = () => { close(); onApply(vis); };
    const card = h('div', { class: 'modal-card tset-card' },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Settings', { size: 16 }), ' ', tr('Настройка таблицы')),
            h('button', { class: 'icon-btn sm', type: 'button', title: tr('Закрыть'), 'aria-label': tr('Закрыть'), onclick: close }, Icon('X', { size: 14 }))),
        h('div', { class: 'modal-body' },
            h('div', { class: 'tset-hint' }, 'Слева — колонки таблицы в текущем порядке: перетаскивайте строки за ручку справа, чтобы поменять очерёдность; снятая галочка убирает колонку. Справа — колонки, которые можно добавить галочкой.'),
            h('div', { class: 'tset-cols' },
                h('div', null, h('div', { class: 'tset-title' }, tr('В таблице'), ' ', leftCount), leftList),
                h('div', null, h('div', { class: 'tset-title' }, tr('Можно добавить'), ' ', rightCount), rightList))),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn btn-outline', type: 'button', onclick: () => { vis = [...defaults]; paint(); } }, Icon('Refresh', { size: 14 }), ' ', tr('По умолчанию')),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', type: 'button', onclick: close }, tr('Отмена')),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: apply }, Icon('Check', { size: 14 }), ' ', tr('Применить'))));

    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}

/**
 * Width shares for a fixed-layout table: each column's weight over the sum,
 * as `calc((100% - fixedPx) * share)` so any set of columns divides the card
 * exactly. Weights come from `w` when the column has one, else from its kind.
 */
export function widthShare(cols, fixedPx, weightOf) {
    const w = (c) => (c.w != null ? c.w : (weightOf ? weightOf(c) : 1));
    const sum = cols.reduce((n, c) => n + w(c), 0) || 1;
    return (c) => `calc((100% - ${fixedPx}px) * ${(w(c) / sum).toFixed(4)})`;
}
