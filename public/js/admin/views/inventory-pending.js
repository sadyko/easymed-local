// OWN_SHELF_ONLY_V1 (ревью F6, 2026-09-28) — «НЕ СПИСАНО СО СКЛАДА»: ОЧЕРЕДЬ
// СКЛАДА. Живёт в «Закупках» чипом со счётом; тот же счёт — бейдж «Закупок» в
// меню (admin.js loadNavCounts).
//
// Владелец: «The dose is recorded, so the patient's chart is never blocked.
// The drug is marked «не списано со склада», and the warehouse sees it in a
// list to settle.»
//
// Сюда попадает доза (и расход сверх дозы) из листа назначений, которую
// медсестра ввела при ВКЛЮЧЁННОМ «Только со своих полок», когда препарата на
// её полках не было: отметка записана, пациенту начислено (один раз, как при
// обычной выдаче), а склад ещё не списан. «Списать» берёт товар со склада или
// с выбранной полки ровно один раз — обычным движением журнала на ту же строку
// начисления. Всё считает сервер (rpc/stock-pending.js): чего и сколько, откуда
// можно списать и хватит ли там; экран только показывает и спрашивает.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { loadingCard } from './inventory-shared.js';
import { hasActorRole } from '../permissions.js';

/** Кто разбирает очередь (зеркало rpc/stock-pending.js requireWarehouse). */
export const PENDING_ROLES = Object.freeze(['admin', 'inventory']);
export const canSettlePending = () => hasActorRole(PENDING_ROLES);

/** Сколько ждёт — или null, если не ответили (бейдж тогда не рисуется). */
export async function loadPendingCount() {
    try {
        const { data, error } = await supabase.rpc('stock_pending_count', {});
        if (error || !data) return null;
        const n = Number(data.pending);
        return Number.isFinite(n) ? n : null;
    } catch { return null; }
}

const fmtNum = (n) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 3 });

/** «Палата 3 · койка 3-1» — место пациента словами. */
export function placeLine(r) {
    if (r.ward_name && r.bed_code) return trf('{ward} · койка {bed}', { ward: r.ward_name, bed: r.bed_code });
    return r.ward_name || (r.bed_code ? trf('койка {bed}', { bed: r.bed_code }) : '—');
}

/** Подпись источника в окне «Списать»: сколько там есть и хватит ли. */
export function sourceLabel(s, unit) {
    const name = s.type === 'warehouse' ? tr('Склад') : (s.name || '—');
    const qty = `${fmtNum(s.qty_shown)} ${unit || ''}`.trim();
    return s.enough
        ? trf('{name} — есть {qty}', { name, qty })
        : trf('{name} — есть {qty}, не хватает', { name, qty });
}

export async function renderPendingTab(container, { onChanged = null } = {}) {
    container.appendChild(loadingCard());
    let res;
    try { res = await supabase.rpc('stock_pending_list', {}); } catch (e) { res = { error: e }; }
    clear(container);
    if (res.error || !res.data) {
        container.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', 'data-pending-error': '' },
            tr((res.error && res.error.message) || 'Не удалось загрузить список.'))));
        return;
    }
    const reload = async () => {
        clear(container);
        await renderPendingTab(container, { onChanged });
        if (typeof onChanged === 'function') onChanged();
    };
    const rows = res.data.rows || [];
    const head = h('div', { class: 'card-header', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('h3', null, Icon('Warning', { size: 15 }), ' ', tr('Не списано со склада')),
        Tag(String(rows.length), { kind: rows.length ? 'warn' : '' }));
    const hint = h('div', { class: 'muted', style: { padding: '8px 16px', fontSize: '12.5px', borderBottom: '1px solid var(--ink-100)' } },
        tr('Доза введена и начислена пациенту, а препарата не было на полках медсестры. Спишите его со склада или с полки, откуда его взяли, — один раз.'));
    if (!rows.length) {
        container.appendChild(h('div', { class: 'card' }, head, hint,
            h('div', { class: 'empty', style: { padding: '14px 16px' }, 'data-pending-empty': '' }, tr('Всё списано — ждущих доз нет.'))));
        return;
    }
    const tbody = h('tbody');
    for (const r of rows) {
        tbody.appendChild(h('tr', { 'data-pending-row': String(r.id) },
            h('td', null, r.patient_name || '—', r.mrn ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, r.mrn) : null),
            h('td', null, r.product_name || '—', r.kind === 'extra' ? h('div', null, Tag(tr('сверх дозы'), { kind: 'warn' })) : null),
            h('td', { class: 'num' }, `${fmtNum(r.qty)} ${r.unit || ''}`.trim()),
            h('td', null, r.given_by_name || '—'),
            h('td', null, fmtDateTime(r.given_at)),
            h('td', null, placeLine(r)),
            h('td', null, h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-pending-settle': String(r.id),
                onclick: () => openSettleModal(r, reload) }, Icon('Check', { size: 13 }), ' ', tr('Списать')))));
    }
    container.appendChild(h('div', { class: 'card' }, head, hint,
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Пациент')), h('th', null, tr('Препарат')), h('th', null, tr('Сколько')),
                h('th', null, tr('Кто ввёл')), h('th', null, tr('Когда')), h('th', null, tr('Палата')), h('th', null, ''))),
            tbody)));
}

/** Окно «Списать»: откуда — склад или полка, где этот товар лежит. */
export function openSettleModal(r, onDone) {
    const sources = Array.isArray(r.sources) ? r.sources : [];
    const firstEnough = sources.find((s) => s.enough);
    const sel = h('select', { 'aria-label': 'Откуда списать', 'data-pending-source': '', style: { width: '100%', height: '34px' } },
        ...sources.map((s, i) => {
            const o = h('option', { value: String(i) }, sourceLabel(s, r.unit));
            if (!s.enough) o.setAttribute('disabled', '');
            if (s === firstEnough) o.setAttribute('selected', '');
            return o;
        }));
    if (firstEnough) sel.value = String(sources.indexOf(firstEnough));
    const overlay = h('div', { class: 'modal', style: { zIndex: '140' }, 'data-pending-modal': String(r.id) });
    const close = () => overlay.remove();
    const go = h('button', { class: 'btn btn-primary', type: 'button', 'data-pending-go': '',
        onclick: async () => {
            const s = sources[Number(sel.value)];
            if (!s || !s.enough) { toast(tr('Выберите, откуда списать: там должно хватать.'), 'warn'); return; }
            go.setAttribute('disabled', '');
            const { error } = await supabase.rpc('stock_pending_settle', { id: r.id, source: s.type === 'warehouse' ? { type: 'warehouse' } : { type: s.type, id: s.id } });
            if (error) { go.removeAttribute('disabled'); toast(tr(error.message || 'Не удалось списать.'), 'fail'); return; }
            close();
            toast(tr('Списано.'), 'ok');
            if (typeof onDone === 'function') await onDone();
        } }, Icon('Check', { size: 13 }), ' ', tr('Списать'));
    if (!firstEnough) go.setAttribute('disabled', '');
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', role: 'dialog', style: { width: '480px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Warning', { size: 16 }), ' ', trf('Списать: {name}', { name: r.product_name || '' })),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { display: 'grid', gap: '8px' } },
            h('p', { style: { margin: 0 } }, trf('{patient} · {qty} · ввела {who}, {when}', {
                patient: r.patient_name || '—', qty: `${fmtNum(r.qty)} ${r.unit || ''}`.trim(),
                who: r.given_by_name || '—', when: fmtDateTime(r.given_at),
            })),
            h('label', { style: { display: 'grid', gap: '4px', fontSize: '13.5px' } }, tr('Откуда списать'), sel),
            firstEnough ? null : h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' }, 'data-pending-nowhere': '' },
                tr('Нигде не хватает — сначала оприходуйте товар или верните его на полку.'))),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, tr('Отмена')),
            h('span', { class: 'grow' }),
            go)));
    document.body.appendChild(overlay);
    return { close };
}
