// SETTINGS_SPLIT_V1 (2026-08-29) — «Данные клиники»: where the backups card
// and the danger zone live now that «Система» is version-and-what's-new only.
//
// WHY THEY MOVED HERE RATHER THAN ANYWHERE ELSE. The owner's instruction
// trimmed «Система» to the version and the what's-new note. It said nothing
// about deleting the backup/restore and factory-reset controls — and those two
// cards are the clinic's ONLY way to save its data and its only way to erase
// it. Losing the entrance would lose the function: there is no other screen,
// no CLI, no launcher menu that reaches backup_create / backup_restore /
// factory_reset. So the cards keep their code untouched (views/system-backups.js
// and views/system-danger.js are imported, not copied) and get a tile of their
// own in the same «Настройки Easy-Med» group, one row below «Подписка».
//
// The two belong on ONE screen because they are the same subject read forwards
// and backwards — "keep this clinic's data" and "destroy this clinic's data" —
// and because the danger zone's own copy already sends the admin to the backup
// list ("если не отмечено, копии останутся на диске"). Splitting them would put
// that sentence on a screen without the thing it refers to.
//
// Like 'updates' and 'subscription', this route survives a full licence
// lockout (admin.js's renderViewInner exemption) and is ALWAYS_ALLOWED in
// permissions.js. That is not a convenience: the backup and reset RPCs are
// ALWAYS_ALLOWED server-side too (server/services/control/gate.js's own
// comment) precisely so a lapsed clinic can still save its data and a
// decommissioned one can still erase itself. A screen that refused to open
// while locked would defeat the server's own decision.
//
// Non-admins get the backups card's read-only explanation and no danger zone
// at all — the cards decide that themselves from the `admin` flag, exactly as
// they did when they sat on «Система».

import { h } from '../ui.js';
import { isAdminActor } from '../admin-actor.js';
import { renderBackupsCard } from './system-backups.js';
import { renderDangerCard } from './system-danger.js';

export async function renderClinicData(root, ctx = {}) {
    const wrap = h('div', { class: 'fade-in upd-wrap' });
    root.appendChild(wrap);

    wrap.appendChild(h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, 'Данные клиники'),
            h('p', { class: 'page-subtitle' }, 'Резервные копии и полное удаление данных клиники.'))));

    const admin = isAdminActor();

    // Backups is awaited so this function resolves only once the whole page is
    // real — the fake-DOM tests (and the human eye) rely on that, the same way
    // views/updates.js did when it owned this card.
    const bakRoot = h('div');
    wrap.appendChild(bakRoot);
    await renderBackupsCard(bakRoot, { admin });

    const dzRoot = h('div');
    wrap.appendChild(dzRoot);
    renderDangerCard(dzRoot, { admin });
}
