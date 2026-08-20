import { h, clear } from '../ui.js';
import { tr } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { LICENSED_MODULES } from '../licensed-modules.js';

// LICENCE_CORE_V1 — what a clinic sees when it opens a module it has not bought.
//
// This is NOT an error screen, and building it as one would waste the most
// valuable moment the product gets: somebody is actively trying to use the
// feature. So it leads with the outcome, explains in one sentence, and makes
// asking cost a single click.
//
// h() already runs every literal text child through tr() (see ui.js), so the
// static Russian strings below are passed as plain literals and picked up by
// the source-string dictionary automatically. The two places that change text
// AFTER the initial render do it via .textContent, which bypasses h() — those
// call tr() explicitly, matching the pattern used in services.js/settings-hub.js.
//
// No emojis, per the house rule — any mark here would be a real icon.

// Clinic-facing date, matching the rest of the app (cashier-desk.js,
// consultation.js): DD.MM.YYYY via toLocaleDateString('ru-RU'), never the raw
// ISO string the RPC returns (migration 073 stores
// strftime('%Y-%m-%dT%H:%M:%SZ','now')).
function formatRequestDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU');
}

export async function renderLockedModule(root, navId) {
    const mod = LICENSED_MODULES[navId];
    clear(root);

    // A module gated but not described is a bug in licensed-modules.js. Say so
    // plainly rather than rendering an empty page nobody can diagnose.
    if (!mod) {
        root.appendChild(h('div', { class: 'card' }, h('p', null, 'Модуль не подключён')));
        return;
    }

    // A dedicated status region, not the button label: role="status" is an
    // implicit aria-live="polite" region, so a screen-reader user hears the
    // outcome (sent / already sent / failed) on every update no matter where
    // focus is. Overwriting the button's own accessible name (as an earlier
    // draft of this screen did) is not reliably announced.
    const foot = h('p', { class: 'lm-foot', role: 'status' },
        'Заявка уйдёт вашему менеджеру Easy-Med. Обычно отвечаем в тот же рабочий день.');

    const cta = h('button', {
        type: 'button',
        class: 'btn btn-primary lm-cta',
        onclick: async () => {
            // The native `disabled` attribute stops a real pointer click, but
            // nothing stops this handler firing again directly (or a second
            // click landing before the browser reflects the attribute) while
            // the first call is still in flight — guard re-entry explicitly.
            if (cta.disabled) return;
            cta.disabled = true;
            try {
                const { data, error } = await supabase.rpc('module_request', { module_key: mod.key });
                if (error) throw error;
                // already:true means an earlier click (this session or a past
                // one) already opened a request — data.requested_at is THAT
                // original request's date, not "now", and showing it as-is is
                // correct: the clinic should see when they actually asked.
                const when = formatRequestDate(data?.requested_at);
                cta.textContent = tr('Заявка отправлена') + (when ? ' ' + when : '');
                foot.textContent = tr('Ваш менеджер свяжется с вами.');
            } catch (e) {
                // Re-enable: an offline clinic must be able to try again later.
                cta.disabled = false;
                foot.textContent = tr('Не удалось отправить заявку. Попробуйте ещё раз.');
            }
        },
    }, 'Подключить модуль');

    root.appendChild(h('div', { class: 'card locked-module' },
        h('div', { class: 'lm-label' }, 'Модуль не подключён'),
        h('h1', { class: 'lm-title' }, mod.title),
        h('p', { class: 'lm-blurb' }, mod.blurb),
        cta,
        foot,
    ));
}
