// SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md, Task 3) — the
// «Резервные копии» card on Settings → «Система» (views/updates.js), sibling
// module for the same reason as system-subscription.js.
//
// Talks to two of the plan's RPCs and codes against that contract exactly:
//   backup_list {}                → the listing (normalized defensively —
//                                   system-logic.js accepts bare array or
//                                   {backups:[...]}, and the {} an older
//                                   server answers before the RPC exists)
//   backup_create {}              → a new manual entry (the listing is
//                                   re-fetched rather than spliced in — the
//                                   server also prunes on create, so only a
//                                   fresh list is the truth)
//   backup_restore {name, password} → {ok, restarting:true}, after which the
//                                   server exits 75 and system-restart.js's
//                                   overlay owns the screen until /api/health
//                                   answers again.
//
// The card renders for everyone but only an admin gets the buttons AND the
// listing call — backup_list itself is admin-gated server-side, so calling
// it as a non-admin would only manufacture a guaranteed 403. Politeness
// only, as always: every RPC re-checks admin + password server-side.

import { h, Icon, clear, toast, field } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import {
    normalizeBackupList, backupKind, backupKindLabel, backupDateLabel, formatBytes, freeSpaceNote,
} from '../system-logic.js';
import { showRestartOverlay } from './system-restart.js';

export async function renderBackupsCard(root, { admin }) {
    const card = h('div', { class: 'card upd-card sys-card' },
        h('div', { class: 'sys-card-head' }, Icon('Database', { size: 16 }),
            h('span', null, 'Резервные копии')));
    root.appendChild(card);

    // The plan's honest limit, said where it matters and only once: a .db
    // backup cannot contain the storage/ tree, and pretending otherwise is
    // how a clinic loses its scans believing they were saved.
    const honesty = h('p', { class: 'muted sys-note' },
        'Копия содержит базу данных клиники. Загруженные файлы (сканы и документы) в неё не входят.');

    if (!admin) {
        card.appendChild(honesty);
        card.appendChild(h('p', { class: 'muted sys-note' },
            'Управление копиями доступно администратору клиники.'));
        return;
    }

    const statusEl = h('p', { class: 'sys-action-status muted', role: 'status' });
    const tableWrap = h('div', { class: 'sys-backups' });

    const createBtn = h('button', {
        type: 'button', class: 'btn btn-primary',
        onclick: async () => {
            // Same explicit re-entrancy guard as every RPC button on this
            // page: `disabled` stops a pointer click, not a second direct
            // call landing before the attribute is reflected.
            if (createBtn.disabled) return;
            createBtn.disabled = true;
            statusEl.textContent = tr('Создание копии…');
            try {
                const { error } = await supabase.rpc('backup_create', {});
                if (error) throw error;
                statusEl.textContent = '';
                toast(tr('Копия создана'), 'ok');
                await load();
            } catch (e) {
                statusEl.textContent = tr('Не удалось создать копию. Попробуйте ещё раз.');
            }
            createBtn.disabled = false;
        },
    }, Icon('Plus', { size: 14 }), ' ', 'Создать копию сейчас');

    card.appendChild(h('div', { class: 'sys-actions-row' }, createBtn, statusEl));
    card.appendChild(honesty);
    card.appendChild(tableWrap);

    async function load() {
        const { data, error } = await supabase.rpc('backup_list', {});
        clear(tableWrap);
        if (error) {
            tableWrap.appendChild(h('p', { class: 'muted sys-note' },
                'Не удалось загрузить список копий. Попробуйте ещё раз позже.'));
            return;
        }
        paintTable(normalizeBackupList(data));
        // The courtesy free-space line the listing may carry (plan B: "if
        // cheaply available") — absent on platforms where statfs failed, and
        // then nothing renders, which is the whole point of freeSpaceNote.
        const free = freeSpaceNote(data);
        if (free) tableWrap.appendChild(h('p', { class: 'muted sys-note' }, free));
    }

    function paintTable(rows) {
        if (!rows.length) {
            tableWrap.appendChild(h('p', { class: 'muted sys-note' }, 'Резервных копий пока нет.'));
            return;
        }
        const tb = h('tbody');
        for (const row of rows) {
            tb.appendChild(h('tr', null,
                h('td', null, backupDateLabel(row.mtimeMs)),
                h('td', null, backupKindLabel(backupKind(row))),
                h('td', null, formatBytes(row.size)),
                h('td', { class: 'sys-backups-restore' },
                    h('button', {
                        type: 'button', class: 'btn btn-outline btn-sm',
                        onclick: () => openRestoreModal(row),
                    }, 'Восстановить'))));
        }
        tableWrap.appendChild(h('table', { class: 'tbl sys-backups-tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Дата'), h('th', null, 'Тип'), h('th', null, 'Размер'), h('th', null, ''))),
            tb));
    }

    await load();
}

// The restore modal — the four things a frightened admin must read BEFORE
// the password field, in the order the plan gives them: what disappears,
// that a safety copy of the current state is made first, that a password is
// required, that the system will restart.
function openRestoreModal(row) {
    const ov = h('div', { class: 'modal', style: { zIndex: '150' } });
    const close = () => ov.remove();
    ov.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const pass = h('input', { type: 'password', class: 'sys-modal-input', autocomplete: 'current-password' });
    const statusEl = h('p', { class: 'sys-modal-status', role: 'status' });
    const when = backupDateLabel(row.mtimeMs);

    const confirmBtn = h('button', { type: 'button', class: 'btn btn-danger' },
        Icon('Refresh', { size: 14 }), ' ', 'Восстановить');
    confirmBtn.addEventListener('click', async () => {
        if (confirmBtn.disabled) return;
        if (!pass.value) { statusEl.textContent = tr('Введите пароль администратора.'); return; }
        confirmBtn.disabled = true;
        statusEl.textContent = '';
        try {
            const { data, error } = await supabase.rpc('backup_restore', { name: row.name, password: pass.value });
            if (error) throw error;
            if (!data || data.ok !== true) throw new Error('restore refused');
            // The server has already scheduled its exit-75; nothing on this
            // page is clickable-with-effect any more. The overlay owns the
            // screen from here until /api/health answers and reloads.
            close();
            showRestartOverlay();
        } catch (e) {
            // The server's message is the specific Russian sentence (wrong
            // password, unknown backup) — shown as-is, same convention as
            // activation.js's unlock/enroll errors.
            confirmBtn.disabled = false;
            statusEl.textContent = (e && e.message && e.message !== 'restore refused')
                ? e.message
                : tr('Не удалось восстановить копию. Попробуйте ещё раз.');
        }
    });

    ov.appendChild(h('div', { class: 'modal-card', style: { width: '480px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Database', { size: 16 }), ' ', 'Восстановление из копии'),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        h('div', { class: 'modal-body sys-modal-body' },
            // Dynamic Russian sentence, concatenation convention (see
            // updates-logic.js formatScheduled) — the date is the whole point
            // of this line, so it is spliced in, not looked up.
            h('p', { class: 'sys-modal-lead' }, trf('Будет восстановлена копия от {when}.', { when })),
            h('p', { class: 'sys-modal-warn' },
                Icon('Warning', { size: 14 }), ' ',
                'Все данные, введённые после этой даты, исчезнут.'),
            h('p', { class: 'sys-modal-note' },
                'Перед восстановлением автоматически создаётся страховочная копия текущего состояния.'),
            h('p', { class: 'sys-modal-note' },
                'Система перезапустится — сотрудники будут отключены на 1–2 минуты.'),
            field('Пароль администратора', pass),
            statusEl),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            confirmBtn)));

    document.body.appendChild(ov);
    setTimeout(() => { try { pass.focus(); } catch (e) {} }, 30);
}
