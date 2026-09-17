// DIALPAD_V1 (2026-09-17) — ТЕЛЕФОН В УГЛУ ЭКРАНА.
//
// Владелец: «can we make a 3cx like ui element so user can press and call from
// there?» — то есть набрать номер с клавиатуры прямо в программе, не выходя из
// того экрана, где работаешь.
//
// ЧЕСТНО О ТОМ, ЧТО ЭТО ТАКОЕ. Снаружи похоже на программный телефон, но звук
// идёт НЕ через компьютер: и Binotel, и onlinePBX звонят так, что сначала
// поднимается трубка у оператора, и только потом набирается собеседник. Поэтому
// панель — это НАБОРНИК, а не трубка: она отдаёт станции команду «соедини меня
// с этим номером». Об этом сказано прямо в панели, иначе оператор будет искать
// голос в колонках и положит трубку раньше, чем станция успеет соединить.
// (Настоящий разговор в браузере — это другая работа: браузер должен сам стать
// SIP-телефоном, и клинике придётся открыть для этого линию у провайдера.)
//
// ПОЧЕМУ В ОБОЛОЧКЕ, А НЕ НА ЭКРАНЕ CRM. Позвонить нужно и из картотеки, и из
// кассы, и с дашборда — по номеру на бумажке, которого ни в одной карточке нет.
// Панель живёт над всеми экранами и переживает переходы между ними.
//
// ПРАВА — те же, что у кнопки «Позвонить» (call-action.js): нет права звонить —
// нет и панели. Один список ролей на обе двери.
import { h, Icon, clear, toast } from './ui.js';
import { tr, trf } from './i18n.js';
import { canCall, placeCall } from './call-action.js?v=call1';
import { formatPhone } from './phone-format.js';

const ROOT_ID = 'em-dialpad';
const RECENT_KEY = 'easymed.dialpad.recent.v1';
const MAX_RECENT = 5;
// Короче семи цифр не бывает ни одного набираемого номера в стране; на этом же
// пороге отказывает и сервер (telephony/dial.js), так что кнопка не обещает
// того, что не сбудется.
const MIN_DIGITS = 7;

/**
 * localStorage, у которого в приватном режиме кидается САМ доступ к свойству.
 * Список последних номеров не стоит того, чтобы уронить оболочку.
 */
function safeStorage() {
    try { return typeof localStorage === 'undefined' ? null : localStorage; }
    catch (e) { return null; }
}

function readRecent() {
    const st = safeStorage();
    try {
        const raw = st && st.getItem ? st.getItem(RECENT_KEY) : null;
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((v) => typeof v === 'string').slice(0, MAX_RECENT) : [];
    } catch (e) { return []; }
}

function rememberNumber(num) {
    const st = safeStorage();
    const next = [num, ...readRecent().filter((v) => v !== num)].slice(0, MAX_RECENT);
    try { if (st && st.setItem) st.setItem(RECENT_KEY, JSON.stringify(next)); } catch (e) { /* приватный режим */ }
    return next;
}

/** Цифры и плюс — всё, что имеет смысл отдавать станции. */
function cleanNumber(s) {
    const t = String(s || '').replace(/[^\d+]/g, '');
    // Плюс — только ведущий: «99+8» станция не наберёт.
    return t.startsWith('+') ? '+' + t.slice(1).replace(/\+/g, '') : t.replace(/\+/g, '');
}

const digitsOf = (s) => String(s || '').replace(/\D+/g, '');

/**
 * Панель набора в оболочке. Идемпотентна: повторный вызов убирает прежнюю и
 * ставит новую — ровно как renderLicenceBanner, чтобы после смены пользователя
 * или языка их не оказалось две.
 */
export function mountDialpad() {
    document.getElementById(ROOT_ID)?.remove();
    if (!canCall()) return null;

    let value = '';
    let open = false;

    const root = h('div', { id: ROOT_ID, style: {
        position: 'fixed', right: '18px', bottom: '18px', zIndex: '60',
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px',
    } });

    // ----- экран набора -----------------------------------------------------
    const display = h('div', { style: {
        fontSize: '20px', fontWeight: '600', minHeight: '28px', letterSpacing: '.01em',
        color: 'var(--ink-900, #14212b)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    } });
    const hint = h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } });

    // На экране набора показывается РОВНО ТО, ЧТО НАБРАЛИ. Общий формат
    // телефонов (phone-format.js) дописывает «+» и код страны — в карточке это
    // удобство, а в наборнике враньё: человек увидел бы не тот номер, который
    // сейчас уйдёт на станцию. Поэтому здесь только пробелы через каждые три
    // цифры, и ни одного знака сверх набранного.
    function groupTyped(v) {
        const plus = v.startsWith('+');
        const d = digitsOf(v);
        const groups = d.replace(/(\d{3})(?=\d)/g, '$1 ');
        return (plus ? '+' : '') + groups;
    }

    function paintDisplay() {
        const d = digitsOf(value);
        display.textContent = value ? groupTyped(value) : '';
        display.style.color = value ? 'var(--ink-900, #14212b)' : 'var(--ink-300, #c3ced2)';
        if (!value) display.textContent = tr('Наберите номер');
        clear(hint);
        hint.appendChild(document.createTextNode(
            d.length >= MIN_DIGITS ? tr('Сначала зазвонит ваш телефон — снимите трубку')
                                   : tr('Наберите номер целиком')));
        callBtn.disabled = d.length < MIN_DIGITS;
        callBtn.style.opacity = callBtn.disabled ? '.55' : '1';
    }

    const press = (ch) => { value = cleanNumber(value + ch); paintDisplay(); };
    const erase = () => { value = value.slice(0, -1); paintDisplay(); };

    // ----- клавиатура -------------------------------------------------------
    const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'],
                  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
                  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
                  ['*', ''], ['0', '+'], ['#', '']];
    const pad = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginTop: '12px' } });
    for (const [key, sub] of KEYS) {
        const btn = h('button', {
            class: 'btn', type: 'button', 'aria-label': trf('Цифра {n}', { n: key }),
            style: { height: '42px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0', lineHeight: '1.1' },
            onclick: () => press(key),
            // Долгое нажатие на ноль даёт «+» — привычка любого телефона, и без
            // неё международный номер набрать нечем.
            oncontextmenu: (ev) => { if (key === '0') { ev.preventDefault(); press('+'); } },
        },
            h('span', { style: { fontSize: '17px', fontWeight: '600' } }, key),
            sub ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, sub) : null);
        pad.appendChild(btn);
    }

    const callBtn = h('button', {
        class: 'btn btn-primary', type: 'button',
        style: { width: '100%', marginTop: '10px', justifyContent: 'center' },
        onclick: async () => {
            const num = cleanNumber(value);
            if (digitsOf(num).length < MIN_DIGITS) return;
            callBtn.disabled = true;
            const was = callCap.textContent;
            callCap.textContent = tr('Звоним…');
            try {
                const ok = await placeCall(num);
                if (ok) { rememberNumber(num); paintRecent(); }
            } finally {
                callBtn.disabled = false;
                callCap.textContent = was;
                paintDisplay();
            }
        },
    }, Icon('Phone', { size: 15 }));
    const callCap = h('span', null, 'Позвонить');
    callBtn.appendChild(callCap);

    // ----- последние номера -------------------------------------------------
    // Хранятся В БРАУЗЕРЕ ЭТОГО оператора, а не в базе: это его личное удобство
    // («перезвонить тому же»), а не факт о клинике. Журнал звонков клиники —
    // отдельная вещь, он в карточке пациента и в отчёте.
    const recentBox = h('div', { style: { marginTop: '12px' } });
    function paintRecent() {
        clear(recentBox);
        const list = readRecent();
        if (!list.length) return;
        recentBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '6px' } }, 'Последние'));
        for (const num of list) {
            recentBox.appendChild(h('button', {
                class: 'btn btn-sm', type: 'button',
                style: { width: '100%', justifyContent: 'flex-start', marginBottom: '4px' },
                onclick: () => { value = num; paintDisplay(); },
            }, Icon('Clock', { size: 13 }), h('span', null, formatPhone(num) || num)));
        }
    }

    const panel = h('div', { role: 'dialog', 'aria-label': tr('Телефон'), style: {
        display: 'none', width: '268px', maxWidth: 'calc(100vw - 36px)',
        background: 'var(--white, #fff)', border: '1px solid var(--ink-100, #e6ecef)',
        borderRadius: '14px', boxShadow: '0 12px 32px rgba(20,33,43,.16)', padding: '14px',
    } },
        h('div', { class: 'row', style: { alignItems: 'center', gap: '8px', marginBottom: '8px' } },
            h('span', { style: { fontSize: '13.5px', fontWeight: '600' } }, 'Телефон'),
            h('span', { class: 'grow' }),
            // НЕ .modal-close: та кнопка красная и с подписью «Закрыть» — она
            // для шапки большого окна, а здесь перекрыла бы собой пол-панели.
            h('button', {
                class: 'btn btn-sm', type: 'button', 'aria-label': tr('Закрыть'), title: tr('Закрыть'),
                style: { padding: '4px 7px' },
                onclick: () => toggle(false),
            }, Icon('X', { size: 13 }))),
        h('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } },
            h('div', { style: { flex: '1', minWidth: '0' } }, display),
            h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': tr('Стереть цифру'), onclick: erase },
                Icon('ChevronLeft', { size: 14 }))),
        hint, pad, callBtn, recentBox);

    const launcher = h('button', {
        class: 'btn btn-primary', type: 'button', 'aria-expanded': 'false',
        title: 'Телефон — набрать номер и позвонить',
        style: { borderRadius: '999px', height: '46px', width: '46px', padding: '0', justifyContent: 'center', boxShadow: '0 6px 18px rgba(20,33,43,.18)' },
        onclick: () => toggle(!open),
    }, Icon('Phone', { size: 18 }));

    function toggle(next) {
        open = !!next;
        panel.style.display = open ? '' : 'none';
        launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) paintDisplay();
    }

    // Клавиатура компьютера: панель открыта — цифры набираются с неё, Enter
    // звонит, Esc закрывает. Без этого «набрать номер» означало бы двенадцать
    // попаданий мышью по кнопкам.
    function onKey(ev) {
        if (!open) return;
        const t = ev.target;
        // Пока человек печатает в поле поиска или в форме, цифры принадлежат ей.
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return;
        if (ev.key === 'Escape') { toggle(false); return; }
        if (ev.key === 'Enter') { callBtn.click(); return; }
        if (ev.key === 'Backspace') { ev.preventDefault(); erase(); return; }
        if (/^[0-9*#+]$/.test(ev.key)) { ev.preventDefault(); press(ev.key); }
    }
    document.addEventListener('keydown', onKey);
    root._detach = () => document.removeEventListener('keydown', onKey);

    root.appendChild(panel);
    root.appendChild(launcher);
    document.body.appendChild(root);
    paintDisplay();
    paintRecent();
    return { open: () => toggle(true), close: () => toggle(false), el: root };
}
