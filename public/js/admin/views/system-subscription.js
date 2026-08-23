// SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md, Task 3) — the
// «Активация и подписка» card on Settings → «Система» (views/updates.js is
// the page; this module is one of its three sibling cards, split out the
// same way laboratory.js keeps lab-barcode.js/lab-grouping.js beside it so
// no single view file doubles in size).
//
// Everything here READS the licence copy the app already fetched at boot
// (licence.js's licenceState() — admin.js setLicence()'d the licence_status
// answer once at login). No refetch: the card would only re-ask the same
// server for the same answer, and the one flow that changes the licence
// underneath us (the «Проверить обновления» check-in, one card up) already
// reloads the whole page when that happens. The extended fields
// (clinic_id / valid_until / last_checkin) may be missing until the
// parallel-built server task ships them — every one degrades to an em-dash
// via system-logic.js, never "undefined".
//
// `admin` arrives as a parameter from updates.js's isAdminActor() — the one
// shared convention call site — rather than each sibling re-deriving it.
// Politeness only, as everywhere: module_request and licence_enroll re-check
// server-side no matter what this card renders.

import { h, Icon, Tag, field } from '../ui.js';
import { tr } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { licenceState } from '../licence.js';
import { buildEnrollForm } from './activation.js';
import {
    subscriptionBadge, validityLabel, lastCheckinLabel, dashWhenEmpty,
    moduleRows, enrollFormVisible, requestDateLabel,
} from '../system-logic.js';

function infoRow(label, valueNode) {
    return [
        h('span', { class: 'sys-info-label' }, label),
        h('span', { class: 'sys-info-value' }, valueNode),
    ];
}

export function renderSubscriptionCard(root, { admin }) {
    const lic = licenceState();
    const badge = subscriptionBadge(lic);

    const card = h('div', { class: 'card upd-card sys-card' },
        h('div', { class: 'sys-card-head' }, Icon('Shield', { size: 16 }),
            h('span', null, 'Активация и подписка')));

    card.appendChild(h('div', { class: 'sys-info' },
        infoRow('Клиника', dashWhenEmpty(lic.clinic_name)),
        infoRow('ID клиники', dashWhenEmpty(lic.clinic_id)),
        infoRow('Статус', Tag(badge.label, { kind: badge.kind })),
        infoRow('Действует до', validityLabel(lic)),
        infoRow('Последняя связь с Easy-Med', lastCheckinLabel(lic.last_checkin)),
    ));

    card.appendChild(h('div', { class: 'sys-block-title' }, 'Модули'));
    const list = h('div', { class: 'sys-modules' });
    for (const m of moduleRows(lic.modules)) {
        const row = h('div', { class: 'sys-module-row' },
            h('span', { class: 'sys-module-name' }, m.label));
        if (m.enabled) {
            row.appendChild(h('span', { class: 'sys-module-on' }, Icon('Check', { size: 14 }), ' ', 'Подключён'));
        } else if (admin) {
            row.appendChild(requestControl(m.key));
        } else {
            // Read-only for non-admins — asking the vendor for a module is a
            // clinic-level decision, same admin gate as every button on this
            // page (and the updates screen's own zero-buttons-for-non-admin
            // rule, which its tests assert across the whole page).
            row.appendChild(h('span', { class: 'muted sys-module-off' }, 'Не подключён'));
        }
        list.appendChild(row);
    }
    card.appendChild(list);

    // The EM- code entry — ONLY while licence_status says not enrolled (after
    // a factory reset the first-run screen owns entry; an enrolled clinic
    // would only earn `already_enrolled`). The form itself is activation.js's
    // buildEnrollForm — the same flow, extracted, never a copy.
    if (enrollFormVisible(lic) && admin) {
        const { input, btn, statusEl } = buildEnrollForm();
        card.appendChild(h('div', { class: 'sys-enroll' },
            h('div', { class: 'sys-block-title' }, 'Активация'),
            h('p', { class: 'muted sys-note' }, 'Введите код активации, полученный от менеджера Easy-Med.'),
            field('Введите код активации', input),
            h('div', { class: 'sys-enroll-actions' }, btn, statusEl)));
    }

    root.appendChild(card);
}

// «Запросить» — the same module_request flow as locked-module.js's CTA (same
// re-entrancy guard, same already:true handling: requested_at is the ORIGINAL
// request's date, and showing it as-is is correct — the clinic should see
// when they actually asked). Not extracted from that file: the two share the
// RPC but not a surface — different copy, different layout, different
// success rendering — and locked-module.js's own comment history explains
// why its screen is a sales page, which this row is not.
function requestControl(moduleKey) {
    const statusEl = h('span', { class: 'muted sys-module-req-status', role: 'status' });
    const btn = h('button', {
        type: 'button', class: 'btn btn-outline btn-sm',
        onclick: async () => {
            if (btn.disabled) return;
            btn.disabled = true;
            statusEl.textContent = '';
            try {
                const { data, error } = await supabase.rpc('module_request', { module_key: moduleKey });
                if (error) throw error;
                const when = requestDateLabel(data?.requested_at);
                btn.textContent = tr('Заявка отправлена') + (when ? ' ' + when : '');
            } catch (e) {
                // Re-enable: an offline clinic must be able to try again later.
                btn.disabled = false;
                statusEl.textContent = tr('Не удалось отправить заявку. Попробуйте ещё раз.');
            }
        },
    }, 'Запросить');
    return h('span', { class: 'sys-module-req' }, btn, statusEl);
}
