// SETTINGS_SPLIT_V1 (2026-08-29) — «Подписка» is a screen of its own now.
//
// The owner's instruction, verbatim: «in the subcription settings we need only
// left with subscription and modules status (with request). and in the system
// only the version and last updated "wahts new".» So this route shows exactly
// two things — the subscription state (clinic, id, status, valid-until, days
// left, last contact) and the module list with «Запросить» — and nothing else.
//
// What this file is NOT: a second copy of that card. The card is still
// views/system-subscription.js, imported here unchanged; this module is only
// the page around it (head + wrapper). The predecessor arrangement
// (SUBSCRIPTION_SUBROUTE_V1) pointed the «Подписка» tile at '#updates/
// subscription' precisely to avoid a second copy — that reasoning still holds,
// only the conclusion changed: a screen the owner describes as its own screen
// gets its own route, and the no-second-copy rule is honoured by importing the
// card rather than by refusing to give it a route.
//
// Route id 'subscription', registered in admin.js (CRUMBS + switch) and
// permissions.js (ALWAYS_ALLOWED, like 'updates'). It is also exempt from the
// licence lockout in admin.js for the reason the lockout exists: a clinic whose
// subscription lapsed is exactly the clinic that must be able to read its own
// subscription state and ask for a module.
//
// The «Проверить обновления» check-in button deliberately did NOT come along:
// it belongs to «Система» (it fetches the update offer), and the owner's list
// for this screen has two items on it. A granted module still arrives on its
// own at the next daily check-in.

import { h } from '../ui.js';
import { isAdminActor } from '../admin-actor.js';
import { renderSubscriptionCard } from './system-subscription.js';

export async function renderSubscription(root, ctx = {}) {
    // Same wrapper class as «Система» — .upd-wrap is what holds these cards to
    // one readable column, and the card was designed inside it.
    const wrap = h('div', { class: 'fade-in upd-wrap' });
    root.appendChild(wrap);

    wrap.appendChild(h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, 'Подписка'),
            h('p', { class: 'page-subtitle' }, 'Активация, срок действия и подключённые модули.'))));

    // `admin` is passed in, not re-derived by the card — the one convention
    // this page shares with «Система» and «Данные клиники» (admin-actor.js).
    renderSubscriptionCard(wrap, { admin: isAdminActor() });
}
