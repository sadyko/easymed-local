// SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md, Task 3) — the
// full-screen "restarting…" takeover shown the moment backup_restore or
// factory_reset answers {restarting:true}. The server replies, then exits
// with code 75 (~500ms later, so the response flushes first); under the
// launcher that exit IS the restart. This overlay's job is to keep anyone
// from clicking a dead app in the gap: it covers everything, polls
// /api/health until the server answers again, and reloads — a restore lands
// back in the app on the restored data, a factory reset lands on the
// first-run screen, and this code does not need to know which.
//
// Mechanism only, on purpose — every DECISION on this settings page lives in
// ../system-logic.js; three delay constants are not decisions worth a module.

import { h } from '../ui.js';

// First poll waits out the exit itself (reply flush + exit 75 + the
// launcher's respawn) — polling at 0s would hit the OLD server still
// draining and reload straight back into it before anything happened.
const FIRST_POLL_MS = 3000;
const POLL_EVERY_MS = 1500;
// The plan's honest limit: under `npm start` exit-75 just stops the process —
// nobody respawns it. After this long with no answer, say so instead of
// spinning forever over a server that is never coming back on its own.
const MANUAL_HINT_AFTER_MS = 30000;

/**
 * Mount the overlay and start polling. Returns the overlay element (the
 * fake-DOM tests find it on document.body and assert its presence; nothing
 * in production holds the reference — the reload is the only exit).
 */
export function showRestartOverlay() {
    const hint = h('p', { class: 'sys-restart-hint' },
        'Сервер пока не отвечает. Если система была запущена вручную, запустите её снова — отложенное действие применится при запуске.');
    hint.style.display = 'none';

    const overlay = h('div', { class: 'sys-restart-overlay', role: 'alert' },
        h('div', { class: 'sys-restart-card' },
            h('div', { class: 'sys-restart-spin', 'aria-hidden': 'true' }),
            h('h2', { class: 'sys-restart-title' }, 'Система перезапускается…'),
            h('p', { class: 'sys-restart-msg' },
                'Не закрывайте окно и не выключайте компьютер. Страница обновится сама.'),
            hint));
    document.body.appendChild(overlay);

    const startedAt = Date.now();
    async function poll() {
        try {
            // no-store: a cached 200 from before the restart would reload us
            // into the very outage this overlay exists to wait out.
            const res = await fetch('/api/health', { cache: 'no-store' });
            if (res && res.ok) {
                // Same try/catch-and-move-on as activation.js's reload — in
                // the fake-DOM tests location.reload does not exist.
                try { location.reload(); } catch (e) {}
                return;   // stop polling either way: the reload is in flight, or the harness has seen enough
            }
        } catch (e) { /* still down — the expected state mid-restart, keep waiting */ }
        if (Date.now() - startedAt > MANUAL_HINT_AFTER_MS) hint.style.display = '';
        setTimeout(poll, POLL_EVERY_MS);
    }
    setTimeout(poll, FIRST_POLL_MS);
    return overlay;
}
