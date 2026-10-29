// DISK_GUARD_V1 (docs/specs/2026-10-29-3181-cabinet-print-disk-design.md,
// раздел 3, п. 8) — карточка «Место на диске» на «Данных клиники»: база,
// копии, файлы (сканы и документы), версии программы, свободно; красное
// предупреждение, когда места мало, когда копия или обновление не сделаны из-за
// места и когда ручные копии одни занимают больше 30 % диска.
//
// Только администратору: disk_usage закрыт для остальных на сервере
// (rpc/backup.js), а «освободите место» — его работа. Неадмину — ни карточки,
// ни запроса (как и копии — views/system-backups.js). Решения — чистые
// функции system-logic.js (diskUsageView); здесь только вёрстка.
import { h, Icon, clear } from '../ui.js';
import { tr, getLang } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { diskUsageView } from '../system-logic.js';

export async function renderDiskCard(root, { admin }) {
    if (!admin) return;
    const card = h('div', { class: 'card upd-card sys-card' },
        h('div', { class: 'sys-card-head' }, Icon('Database', { size: 16 }),
            h('span', null, 'Место на диске')));
    root.appendChild(card);
    const body = h('div', { class: 'sys-disk', style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
    card.appendChild(body);

    let view = null;
    try {
        const { data, error } = await supabase.rpc('disk_usage', {});
        if (!error) view = diskUsageView(data, tr, getLang());
    } catch (e) { view = null; }
    clear(body);
    if (!view || !view.rows.length) {
        body.appendChild(h('p', { class: 'muted sys-note' }, 'Не удалось узнать место на диске.'));
        return;
    }
    // Красное — первым: «копия не сделана» важнее любой цифры ниже.
    for (const w of view.warnings) {
        body.appendChild(h('p', { class: 'sys-modal-warn', role: 'alert' }, Icon('Warning', { size: 14 }), ' ', w));
    }
    const grid = h('div', { class: 'sys-info' });
    for (const r of view.rows) {
        grid.appendChild(h('span', { class: 'sys-info-label' }, r.label));
        grid.appendChild(h('span', { class: 'sys-info-value' }, r.value));
    }
    body.appendChild(grid);
    // Строка «Резервные копии» — вся папка копий (server/services/disk-guard.js
    // diskUsageReport), а в таблице ниже копии по одной: пусть сумма не удивляет.
    body.appendChild(h('p', { class: 'muted sys-note' },
        'Резервные копии — это вся папка копий, вместе с копиями «До восстановления» и «До отката».'));
}
