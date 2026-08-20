// LICENCE_CORE_V1 — which parts of the app are sold separately, and what to say
// about them when they are not bought.
//
// Keys are nav ids / route names from admin.js; `key` is the licence vocabulary
// used in the signed licence and in the vendor panel. Anything NOT listed here is
// part of the clinical core and is never for sale — a clinic must always be able
// to register a patient and take money.
//
// The copy is deliberately benefit-led, not feature-led. This screen is the best
// sales surface in the product: somebody is asking for the module at the exact
// moment they want it.
//
// Object.create(null) — not a `{}` literal — because this map is looked up with
// keys that come from the URL/nav id (attacker-influenced in principle) and a
// `{}` literal inherits `toString`, `constructor`, `__proto__` etc. from
// Object.prototype, so `LICENSED_MODULES['constructor']` on a literal would
// return a function instead of undefined. A null-prototype object has no such
// inherited properties, so every lookup that isn't one of the three keys below
// is a clean `undefined`.
export const LICENSED_MODULES = Object.assign(Object.create(null), {
    crm: {
        key: 'crm',
        title: 'Все звонки и заявки — в одном списке',
        blurb: 'Call-центр собирает обращения пациентов, ведёт их до записи и показывает, кто перезвонил, а кто нет.',
    },
    'telegram-chat': {
        key: 'telegram',
        title: 'Пациент забирает анализы сам, в Telegram',
        blurb: 'Бот узнаёт пациента по номеру телефона и отправляет готовые результаты. Регистратура перестаёт распечатывать и обзванивать.',
    },
});

/** Every nav id that is gated. Used by the sidebar to decide where to draw a lock. */
export const LICENSED_NAV_IDS = new Set(Object.keys(LICENSED_MODULES));

// `marketing` is deliberately ABSENT from this map, though the server's
// SELLABLE_MODULES still knows the key.
//
// It has no NAV entry and its route renders behind renderComingSoon's overlay, so
// the feature does not exist yet. While it was listed here, opening #marketing
// showed a polished "buy this module" screen with a working request button — the
// product offering to sell something that, once bought, would still show "coming
// soon". Leaving it out means #marketing behaves exactly as it did before
// licensing existed.
//
// Add it back in the same commit that gives marketing a NAV entry and a real
// screen, not before.
