// LAB_PRINT_PICK_V1 (решение владельца 2026-11-07, п. 8) — ОКНО «ЧТО НАПЕЧАТАТЬ».
//
// «Печать» в «Документах» (карта пациента и раздел «Документы» слева) печатала
// всё сразу — все анализы визита одним бланком. Теперь она открывает окно: список
// документов анализов (подтверждённые вместе — один документ, shared/lab-doc-batches.js)
// и их анализов с галочками — все отмечены, только готовые; «Печать» печатает
// отмеченные ОДНИМ окном печати (одним бланком). Галочка документа отмечает и
// снимает все его анализы.
import { h, Icon } from '../ui.js';
import { tr, trf } from '../i18n.js';

/**
 * @param {{title?:string, docs:Array<{key:string, title:string, subtitle?:string, orders:Array<{id:number, name:string}>}>,
 *          onPrint:(orderIds:number[]) => any}} o
 * @returns {HTMLElement|null} окно (null — печатать нечего)
 */
export function openLabPrintPick({ title = 'Что напечатать', docs = [], onPrint } = {}) {
    const list = (docs || []).filter((d) => d && (d.orders || []).length);
    if (!list.length) return null;
    const overlay = h('div', { class: 'modal', 'data-lab-print-pick': '' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const orderBoxes = [];
    const printBtn = h('button', { class: 'btn btn-primary', type: 'button' }, Icon('Print', { size: 14 }), ' ', tr('Печать'));
    const countEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } });
    const sync = () => {
        const n = orderBoxes.filter((b) => b.box.checked).length;
        countEl.textContent = trf('Отмечено анализов: {n}', { n });
        printBtn.disabled = n === 0;
        if (n === 0) printBtn.setAttribute('disabled', ''); else if (printBtn.removeAttribute) printBtn.removeAttribute('disabled');
    };
    const tick = (box, on) => { box.checked = on; if (on) box.setAttribute('checked', ''); else if (box.removeAttribute) box.removeAttribute('checked'); };

    const body = h('div', { class: 'modal-body' });
    for (const d of list) {
        const docBox = h('input', { type: 'checkbox', 'data-pick-doc': d.key, 'aria-label': d.title });
        tick(docBox, true);
        const mine = [];
        const ordersEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0 0 26px' } });
        for (const o of d.orders) {
            const box = h('input', { type: 'checkbox', 'data-pick-order': String(o.id), 'aria-label': o.name || '' });
            tick(box, true);
            const entry = { box, id: Number(o.id), doc: docBox };
            mine.push(entry);
            orderBoxes.push(entry);
            box.addEventListener('change', () => {
                tick(docBox, mine.every((m) => m.box.checked));
                sync();
            });
            ordersEl.appendChild(h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13.5px' } }, box, h('span', null, o.name || '—')));
        }
        docBox.addEventListener('change', () => { for (const m of mine) tick(m.box, docBox.checked); sync(); });
        body.appendChild(h('div', { class: 'lab-pick-doc', style: { padding: '8px 0', borderBottom: '1px solid var(--ink-50)' } },
            h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontWeight: 600 } }, docBox,
                h('span', null, d.title),
                d.subtitle ? h('span', { class: 'muted', style: { fontWeight: 400, fontSize: '12.5px' } }, d.subtitle) : null),
            ordersEl));
    }
    printBtn.addEventListener('click', () => {
        const ids = orderBoxes.filter((b) => b.box.checked).map((b) => b.id);
        if (!ids.length) return;
        close();
        if (onPrint) onPrint(ids);
    });
    sync();

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Print', { size: 16 }), ' ', tr(title)),
            h('button', { class: 'modal-close', type: 'button', onclick: close, 'aria-label': tr('Закрыть') }, '×')),
        body,
        h('footer', { class: 'modal-foot' },
            countEl,
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', type: 'button', onclick: close }, tr('Отмена')),
            printBtn),
    ));
    document.body.appendChild(overlay);
    return overlay;
}
