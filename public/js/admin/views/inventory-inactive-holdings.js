// V3120_FIX (2026-09-27) — «НА РУКАХ У ОТКЛЮЧЁННЫХ СОТРУДНИКОВ».
//
// Инспекция: товар, выданный медсестре на руки, после её отключения висел за
// ней навсегда — выдать его пациенту некому, вернуть было нечем. Под таблицей
// «Остатки на складе» теперь стоит этот блок (только когда есть что показать):
// что числится за отключёнными людьми, и две кнопки на строку —
// «Вернуть на склад» и «Передать» другому сотруднику. Обе — один вызов
// holding_return; права (администратор, кладовщик) проверяет сервер.
//
// Подтверждение — вторым нажатием на ту же кнопку (confirm() в окне просмотра
// не работает): первое нажатие меняет надпись на «Подтвердить…».
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { fmtQty, selStyle } from './inventory-shared.js';

/** Строки подотчёта отключённых сотрудников из ответа holdings_list. */
export function inactiveHoldings(holdings) {
    return (holdings || []).filter((r) => r && r.holder_type === 'staff' && r.holder_inactive && Number(r.qty_base) > 0);
}

/**
 * Дорисовать блок в `container` (после таблицы склада). Ничего не рисует, если
 * отключённым ничего не числится или вызов недоступен роли.
 * @param {HTMLElement} container
 * @param {Function} onChanged — перерисовать склад после возврата/передачи
 */
export async function renderInactiveHoldings(container, onChanged) {
    let rows = [], staff = [];
    try {
        const [hr, ur] = await Promise.all([
            supabase.rpc('holdings_list', {}),
            supabase.from('users').select('id,full_name').eq('active', 1).order('full_name', { ascending: true }),
        ]);
        if (hr.error) return;   // роли не видно подотчёта — блока нет, склад работает как прежде
        rows = inactiveHoldings((hr.data && hr.data.holdings) || []);
        staff = (ur.error ? [] : ur.data) || [];
    } catch { return; }
    if (!rows.length || !container.isConnected) return;   // ушли с вкладки, пока ждали ответа

    const tbody = h('tbody');
    const card = h('div', { class: 'card', style: { marginTop: '14px' } },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('User', { size: 15 }), ' ', tr('На руках у отключённых сотрудников'))),
        h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 16px 0' } },
            tr('Отключённый сотрудник не может выдать это пациенту. Верните товар на склад или передайте другому сотруднику.')),
        h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, tr('Сотрудник')),
                    h('th', null, tr('Товар')),
                    h('th', { class: 'num' }, tr('Количество')),
                    h('th', null, ''))),
                tbody)));

    for (const r of rows) tbody.appendChild(buildRow(r));
    container.appendChild(card);

    function buildRow(r) {
        const unit = r.consumption_unit || r.base_unit || '';
        const toSel = h('select', { style: { ...selStyle, height: '30px', fontSize: '12.5px', minWidth: '160px' } },
            h('option', { value: '' }, tr('— кому передать —')),
            ...staff.filter((u) => u.id !== r.holder_id).map((u) => h('option', { value: String(u.id) }, u.full_name || '')));

        let armed = null;   // 'return' | 'transfer' — ждём второго нажатия
        const returnBtn = h('button', { class: 'btn btn-sm', type: 'button' }, Icon('ArrowUp', { size: 13 }), ' ', tr('Вернуть на склад'));
        const transferBtn = h('button', { class: 'btn btn-sm', type: 'button' }, Icon('Send', { size: 13 }), ' ', tr('Передать'));

        function disarm() {
            armed = null;
            clear(returnBtn); returnBtn.append(Icon('ArrowUp', { size: 13 }), ' ', tr('Вернуть на склад'));
            clear(transferBtn); transferBtn.append(Icon('Send', { size: 13 }), ' ', tr('Передать'));
        }

        async function run(kind) {
            const args = { holder: { type: 'staff', id: r.holder_id }, product_id: r.product_id };
            if (kind === 'transfer') {
                const to = Number(toSel.value) || 0;
                if (!to) { toast(tr('Выберите, кому передать.'), 'warn'); disarm(); return; }
                args.to = { type: 'staff', id: to };
            }
            if (armed !== kind) {
                disarm();
                armed = kind;
                const btn = kind === 'return' ? returnBtn : transferBtn;
                clear(btn);
                btn.append(tr(kind === 'return' ? 'Подтвердить возврат' : 'Подтвердить передачу'));
                return;
            }
            returnBtn.disabled = true; transferBtn.disabled = true;
            const { data, error } = await supabase.rpc('holding_return', args);
            returnBtn.disabled = false; transferBtn.disabled = false;
            disarm();
            if (error) { toast(trf('Не удалось: {msg}', { msg: error.message || String(error) }), 'fail'); return; }
            toast(data && data.to
                ? trf('Передано: {qty} {unit} — {name}', { qty: fmtQty(data.returned_units), unit: data.unit || '', name: data.to.name || '' })
                : trf('Возвращено на склад: {qty} {unit}', { qty: fmtQty(data && data.returned_units), unit: (data && data.unit) || '' }), 'ok');
            if (typeof onChanged === 'function') onChanged();
        }
        returnBtn.addEventListener('click', () => run('return'));
        transferBtn.addEventListener('click', () => run('transfer'));

        return h('tr', null,
            h('td', null, r.holder_name || ''),
            h('td', null, r.product_name || ''),
            h('td', { class: 'num' }, [fmtQty(r.qty_units), unit].filter(Boolean).join(' ')),
            h('td', null, h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
                returnBtn, toSel, transferBtn)));
    }
}
