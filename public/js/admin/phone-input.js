// PHONE_INPUT_V1 — the one phone control the whole app uses.
//
// It was previously a private helper inside views/registration.js, wired up on
// exactly two screens (patient registration + patient card), and it only
// defaulted to Uzbekistan when the field happened to be named 'phone'. Every
// other place a number is typed — CRM leads, employees, suppliers, wards,
// clinic details, the config-driven section editors — was a bare <input> where
// the registrar had to type «+998» by hand. This module is that control,
// extracted, defaulted to Uzbekistan everywhere, and importable from anywhere.
//
// Usage — drop-in for an <input>:
//     const phone = phoneInput('phone');          // shows «+998», UZ flag
//     phone.value = patient.phone || '';          // seeds it (any format)
//     ...
//     payload.phone = phone.value;                // '' until digits are typed
//
// The wrapper proxies .value / .focus() / .disabled to the inner <input>, so it
// substitutes for one at call sites without further changes. Reading .value
// gives '' while only a country code is present, so `if (phone.value.trim())`
// and required-checks keep working — an untouched field is still empty.
//
// Flags are inline SVG, NOT flagcdn.com images: this app must run with no
// network at all (see CLAUDE.md), and the old <img> tags rendered as broken
// icons offline.
//
// The country-code and formatting rules live in phone-format.js so they can be
// unit-tested without a DOM (see __tests__/phone-format.test.mjs).

import { h, Icon, clear } from './ui.js';
import {
    PHONE_COUNTRIES, DEFAULT_COUNTRY, countryByIso,
    detectCountry, fmtPhone, phoneDigits, isCodeOnly, formatPhone,
} from './phone-format.js';

// Re-exported so callers need only one import.
export {
    PHONE_COUNTRIES, DEFAULT_COUNTRY, detectCountry, fmtPhone, phoneDigits, isCodeOnly, formatPhone,
} from './phone-format.js';

// --- Flags ------------------------------------------------------------------
// Deliberately simplified: at 22x16 the detail of a real flag is invisible, and
// these have to be inline (no network, no build step to inline an asset).
const FLAGS = {
    UZ: '<rect width="22" height="16" fill="#fff"/><rect width="22" height="5" fill="#0099b5"/><rect y="11" width="22" height="5" fill="#1eb53a"/><rect y="5" width="22" height="1" fill="#ce1126"/><rect y="10" width="22" height="1" fill="#ce1126"/><circle cx="4.4" cy="2.5" r="1.7" fill="#fff"/><circle cx="5.5" cy="2.5" r="1.7" fill="#0099b5"/>',
    KZ: '<rect width="22" height="16" fill="#00afca"/><circle cx="11" cy="7.5" r="3" fill="#fec50c"/>',
    RU: '<rect width="22" height="16" fill="#fff"/><rect y="5.33" width="22" height="5.33" fill="#0039a6"/><rect y="10.66" width="22" height="5.34" fill="#d52b1e"/>',
    KG: '<rect width="22" height="16" fill="#e8112d"/><circle cx="11" cy="8" r="3.4" fill="#ffef00"/>',
    TJ: '<rect width="22" height="16" fill="#fff"/><rect width="22" height="5.33" fill="#cc0000"/><rect y="10.66" width="22" height="5.34" fill="#006600"/><circle cx="11" cy="8" r="1.9" fill="#f8c300"/>',
    TM: '<rect width="22" height="16" fill="#28ae66"/><rect x="3" width="3.4" height="16" fill="#c4262e"/><rect x="4" width="1.4" height="16" fill="#fff"/>',
    TR: '<rect width="22" height="16" fill="#e30a17"/><circle cx="8.5" cy="8" r="3.4" fill="#fff"/><circle cx="9.8" cy="8" r="2.7" fill="#e30a17"/><circle cx="13.4" cy="8" r="1.3" fill="#fff"/>',
    AE: '<rect width="22" height="16" fill="#fff"/><rect width="22" height="5.33" fill="#00732f"/><rect y="10.66" width="22" height="5.34" fill="#000"/><rect width="6" height="16" fill="#ff0000"/>',
    AF: '<rect width="22" height="16" fill="#000"/><rect x="7.33" width="7.34" height="16" fill="#d32011"/><rect x="14.67" width="7.33" height="16" fill="#007a36"/>',
    US: '<rect width="22" height="16" fill="#fff"/><rect width="22" height="2.3" fill="#b22234"/><rect y="4.6" width="22" height="2.3" fill="#b22234"/><rect y="9.2" width="22" height="2.3" fill="#b22234"/><rect y="13.8" width="22" height="2.2" fill="#b22234"/><rect width="10" height="9.2" fill="#3c3b6e"/>',
};

function flagEl(iso, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 22 16');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = FLAGS[iso] || '';
    return svg;
}

// One document-level listener for the whole app, bound lazily and never removed.
// The previous version added one listener per control and never detached it, so
// every modal that opened leaked another; with the control now on a dozen more
// screens that adds up. This walks the live DOM instead of holding references,
// so closed modals leave nothing behind.
let docCloserBound = false;
function bindMenuCloser() {
    if (docCloserBound) return;
    docCloserBound = true;
    document.addEventListener('click', (e) => {
        for (const menu of document.querySelectorAll('.ph-menu')) {
            if (menu.style.display === 'none') continue;
            const wrap = menu.closest('.ph-wrap');
            if (!wrap || !wrap.contains(e.target)) menu.style.display = 'none';
        }
    });
}

/**
 * @param {string}  name          `name` attribute of the inner input (form scrapers rely on it)
 * @param {string} [placeholder]
 * @param {object} [opts]
 * @param {string} [opts.iso]      starting country, default UZ
 * @param {boolean}[opts.blank]    start with no country code at all
 * @param {string} [opts.value]    initial number, any format
 */
export function phoneInput(name, placeholder, opts = {}) {
    const start = opts.blank ? null : (countryByIso(opts.iso) || DEFAULT_COUNTRY);
    let digits = start ? start.code : '';

    const input = h('input', {
        name, type: 'tel', class: 'ph-input', autocomplete: 'off',
        placeholder: placeholder || '+998 90 961 00 04',
    });
    input.dataset.phone = '1';   // marks the field for raw form scrapers — see isCodeOnly()

    const flagBox = h('span', { class: 'ph-flag-box' });
    const menu = h('div', { class: 'ph-menu', style: { display: 'none' } });
    const trigger = h('button', {
        type: 'button', class: 'ph-trigger', 'aria-label': 'Выбрать страну',
        onclick: () => { menu.style.display = menu.style.display === 'none' ? '' : 'none'; },
    }, flagBox);

    for (const c of PHONE_COUNTRIES) {
        menu.appendChild(h('button', {
            type: 'button', class: 'ph-opt',
            onclick: () => {
                const cur = detectCountry(digits);
                digits = c.code + (cur ? digits.slice(cur.code.length) : '');
                render();
                menu.style.display = 'none';
                input.focus();
            },
        },
            flagEl(c.iso, 'ph-opt-flag'),
            h('span', { class: 'ph-opt-name' }, c.name),
            h('span', { class: 'ph-opt-code muted' }, '+' + c.code)));
    }

    function render(keepCaret) {
        const c = detectCountry(digits);
        clear(flagBox);
        if (c) { flagBox.appendChild(flagEl(c.iso, 'ph-flag')); trigger.title = c.name; }
        else   { flagBox.appendChild(Icon('Phone', { size: 14 })); trigger.title = 'Выбрать страну'; }

        const next = !digits ? '' : (c ? fmtPhone(c, digits.slice(c.code.length)) : '+' + digits);
        if (next === input.value) return;
        // Reformatting rewrites the whole value, which would otherwise throw the
        // caret to the end whenever someone edits in the middle of a number.
        const caret = keepCaret ? digitsBeforeCaret() : -1;
        input.value = next;
        if (caret >= 0) placeCaretAfterDigits(next, caret);
    }

    function digitsBeforeCaret() {
        try {
            const at = input.selectionStart;
            if (at == null) return -1;
            return (input.value.slice(0, at).match(/\d/g) || []).length;
        } catch { return -1; }
    }

    function placeCaretAfterDigits(text, n) {
        try {
            if (n <= 0) { input.setSelectionRange(text.length, text.length); return; }
            let seen = 0;
            for (let i = 0; i < text.length; i++) {
                if (text[i] >= '0' && text[i] <= '9' && ++seen === n) {
                    input.setSelectionRange(i + 1, i + 1);
                    return;
                }
            }
            input.setSelectionRange(text.length, text.length);
        } catch { /* not a text-selectable input — ignore */ }
    }

    input.addEventListener('input', () => {
        digits = phoneDigits(input.value);
        // Wiping the field drops back to the default dialling code rather than
        // leaving it bare — the next number is overwhelmingly a local one.
        if (!digits && start) digits = start.code;
        render(true);
    });

    bindMenuCloser();

    const wrap = h('div', { class: 'ph-wrap' }, trigger, input, menu);
    wrap.input = input;
    Object.defineProperty(wrap, 'value', {
        get: () => (isCodeOnly(input.value) ? '' : formatPhone(input.value)),
        set: (v) => {
            digits = phoneDigits(v);
            if (!digits && start) digits = start.code;
            render();
        },
    });
    Object.defineProperty(wrap, 'disabled', {
        get: () => input.disabled,
        set: (v) => { input.disabled = !!v; trigger.disabled = !!v; },
    });
    wrap.focus = () => input.focus();

    if (opts.value) wrap.value = opts.value;
    else render();
    return wrap;
}
