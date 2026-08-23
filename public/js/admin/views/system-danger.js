// SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md, Task 3) — the
// «Опасная зона» card on Settings → «Система» (views/updates.js). One RPC:
//   factory_reset {password, confirm, wipe_backups} → {ok, restarting:true}
// after which the server exits 75, processPendingAction wipes on the next
// boot, and the clinic lands on the first-run screen needing a NEW EM- code
// (the owner's locked decision: the danger zone is a FULL factory reset,
// activation included).
//
// Not rendered at all for a non-admin — a red delete-everything card is pure
// menace to a registrar who cannot press it, and this page's own tests
// assert a non-admin sees ZERO buttons anywhere on it. The server re-checks
// admin + password + the confirm word regardless (its check is the real
// one; the client's copy of the word check exists so the mismatch is caught
// BEFORE the scary click).

import { h, Icon, field, checkField } from '../ui.js';
import { tr } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { confirmWordOk } from '../system-logic.js';
import { showRestartOverlay } from './system-restart.js';

export function renderDangerCard(root, { admin }) {
    if (!admin) return;

    root.appendChild(h('div', { class: 'card upd-card sys-card sys-danger' },
        h('div', { class: 'sys-card-head' }, Icon('Warning', { size: 16 }),
            h('span', null, 'Опасная зона')),
        h('p', { class: 'sys-note sys-danger-text' },
            'Полное удаление всех данных клиники с этого компьютера. Действие необратимо.'),
        h('div', null,
            h('button', {
                type: 'button', class: 'btn btn-danger',
                onclick: () => openResetModal(),
            }, Icon('Trash', { size: 14 }), ' ', 'Удалить все данные клиники'))));
}

function openResetModal() {
    const ov = h('div', { class: 'modal', style: { zIndex: '150' } });
    const close = () => ov.remove();
    ov.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const wipeChk = h('input', { type: 'checkbox' });   // default OFF — recovery-from-mistake beats clean-disk (the plan's own words)
    const wordInput = h('input', { type: 'text', class: 'sys-modal-input', autocomplete: 'off', spellcheck: 'false' });
    const pass = h('input', { type: 'password', class: 'sys-modal-input', autocomplete: 'current-password' });
    const statusEl = h('p', { class: 'sys-modal-status', role: 'status' });

    const confirmBtn = h('button', { type: 'button', class: 'btn btn-danger', disabled: true },
        Icon('Trash', { size: 14 }), ' ', 'Удалить всё');

    // The button stays dead until the word is exactly right AND a password
    // was typed — not to protect the server (it re-checks both), but so the
    // admin cannot reach the point of no return on autopilot.
    function refreshEnabled() {
        confirmBtn.disabled = !(confirmWordOk(wordInput.value) && pass.value !== '');
    }
    wordInput.addEventListener('input', refreshEnabled);
    pass.addEventListener('input', refreshEnabled);

    let busy = false;   // `disabled` doubles as the form-validity flag here, so re-entrancy needs its own guard
    confirmBtn.addEventListener('click', async () => {
        if (busy || confirmBtn.disabled) return;
        if (!confirmWordOk(wordInput.value)) { statusEl.textContent = tr('Введите слово УДАЛИТЬ.'); return; }
        busy = true;
        confirmBtn.disabled = true;
        statusEl.textContent = '';
        try {
            const { data, error } = await supabase.rpc('factory_reset', {
                password: pass.value,
                confirm: wordInput.value.trim(),
                wipe_backups: wipeChk.checked === true,
            });
            if (error) throw error;
            if (!data || data.ok !== true) throw new Error('reset refused');
            close();
            // Ends at the first-run screen: the reload the overlay fires
            // lands on a virgin install asking for a new EM- code.
            showRestartOverlay();
        } catch (e) {
            busy = false;
            refreshEnabled();
            statusEl.textContent = (e && e.message && e.message !== 'reset refused')
                ? e.message
                : tr('Не удалось удалить данные. Попробуйте ещё раз.');
        }
    });

    ov.appendChild(h('div', { class: 'modal-card', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Warning', { size: 16 }), ' ', 'Удаление всех данных клиники'),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        h('div', { class: 'modal-body sys-modal-body' },
            h('p', { class: 'sys-modal-warn' },
                Icon('Warning', { size: 14 }), ' ',
                'Действие необратимо. Будут безвозвратно удалены:'),
            // The death list — everything the plan names, activation last and
            // loudest, because it is the one loss an admin does not expect
            // from "delete the data".
            h('ul', { class: 'sys-death-list' },
                h('li', null, 'пациенты, приёмы и вся история лечения'),
                h('li', null, 'счета, платежи и кассовые смены'),
                h('li', null, 'документы и загруженные файлы'),
                h('li', null, 'сотрудники, настройки и доступы'),
                h('li', null, 'активация — клинике потребуется НОВЫЙ код активации')),
            h('div', { class: 'sys-wipe-row' },
                checkField('Также удалить все резервные копии', wipeChk),
                h('p', { class: 'sys-modal-note' },
                    'Если не отмечено, копии останутся на диске — по ним можно будет восстановить данные. Отметка — полная очистка диска.')),
            field('Введите УДАЛИТЬ, чтобы подтвердить', wordInput),
            field('Пароль администратора', pass),
            h('p', { class: 'sys-modal-note' },
                'Система перезапустится и откроется экран первого запуска.'),
            statusEl),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            confirmBtn)));

    document.body.appendChild(ov);
    setTimeout(() => { try { wordInput.focus(); } catch (e) {} }, 30);
}
