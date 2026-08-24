// CRM_CONFIG_V1 — Настройки → «CRM-канбан»
// (docs/plans/2026-08-24-crm-kanban-settings.md, part B).
//
// Two jobs on one screen, in the order the owner described them:
//   1. «Колонки канбана» — the funnel itself: name, colour, order, visible.
//   2. «Источники» — where a lead came from.
//
// TELEPHONY_ROUTING_V1 (docs/plans/2026-08-24-telephony-owns-its-routing.md)
// took the third card away, and the owner was right to ask for it: «звонок →
// заявка» is a property of the SOURCE, not of the board. Binotel has
// dispositions, a website form will have its own outcomes, Instagram has none
// — one CRM screen holding every integration's rules would grow a section per
// vendor, none of them next to the vendor's own credentials. The card now
// lives in views/telephony-settings.js. Nothing about the STORAGE moved:
// crm_call_routing, crm_config_save {routing} and lead-from-call.js are
// untouched, and they were already keyed by provider — which is what made
// per-source ownership the natural shape all along.
//
// Everything here writes to crm_stages / crm_sources (migration 077) through
// two RPCs, and views/crm.js reads the same config — so this screen IS the
// board's vocabulary, not a copy of it.
//
// Each card saves its OWN section with its own button: crm_config_save takes
// the whole ordered array of the section being saved, because that is how the
// screen edits it (reorder + rename + recolour are one thought, and one
// transaction). Nothing is written until that button is pressed — removing a
// row from the list is not deleting it until then.
//
// The 501 path is not theory: /api/rpc answers 501 rpc_not_implemented for a
// name it has no handler for, which is exactly what a clinic still running an
// older build sees while the update makes its way there. The screen answers it
// with a calm «недоступно» line rather than a crash (isNotImplemented).
//
// Every display/validation DECISION lives in ../crm-settings-logic.js; this
// file is DOM only.

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, Tag, clear, toast, checkField } from '../ui.js';
// h() runs tr() over its text children, but anything that changes text AFTER
// the render through .textContent bypasses h() — those places call tr()
// explicitly (same trick as telephony-settings.js).
import { tr } from '../i18n.js';
import {
    COLORS, tagKind, LABEL_MAX,
    UNDELETABLE_STAGE_KEYS, UNDELETABLE_SOURCE_KEYS,
    UNDELETABLE_STAGE_REASON, UNDELETABLE_SOURCE_REASON,
    deriveKey, moveItem, withPositions,
    validateStages, validateSources,
    shapeConfig, isNotImplemented,
} from '../crm-settings-logic.js';

// The signature of a section as the SERVER last gave it. Dirtiness is then a
// comparison, not a flag every edit path has to remember to set — and the
// screen edits rows in place (labels type straight into the model), so a flag
// would have been wrong within a day.
function sig(rows, keys) {
    return JSON.stringify((rows || []).map((r) => keys.map((k) => r[k])));
}
const STAGE_SIG_KEYS = ['key', 'label', 'color', 'kind', 'is_active'];
const SOURCE_SIG_KEYS = ['key', 'label', 'is_active'];
const state = { cfg: null, busy: false };
let refs = { root: null, body: null, stages: null, sources: null };

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) {
        const e = new Error(error.message || 'Не удалось выполнить запрос.');
        // The code is what isNotImplemented() reads: it separates "the server
        // is older than this screen" from a real failure. new Error() drops
        // it — carry it across by hand.
        e.code = error.code;
        throw e;
    }
    return data;
}

// No onNavigate: with the routing card gone this screen navigates nowhere.
// admin.js still passes its ctx — extra arguments are harmless — and the day
// something here needs to navigate, it takes the parameter back.
export async function renderCrmSettings(container) {
    clear(container);
    refs = { root: null, body: null, stages: null, sources: null };
    refs.root = h('div', { class: 'fade-in' });
    container.appendChild(refs.root);

    refs.root.appendChild(PageHead({
        title: 'CRM-канбан',
        subtitle: 'Колонки воронки и источники заявок — структура доски CRM.',
    }));

    const body = h('div');
    refs.root.appendChild(body);
    refs.body = body;

    body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    try {
        state.cfg = shapeConfig(await rpc('crm_config_get', {}));
    } catch (e) {
        clear(body);
        if (isNotImplemented(e)) {
            // A clinic still on an older build has no handler for these RPC
            // names. Not an emergency, and nothing to frighten it with in red.
            body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
                'Настройки CRM недоступны: сервер ещё не обновлён до этой версии.'));
        } else {
            body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
                'Не удалось загрузить настройки: ' + e.message));
        }
        return;
    }
    paint();
}

function paint() {
    clear(refs.body);
    refs.body.appendChild(stagesCard());
    refs.body.appendChild(sourcesCard());
}

// Never assume the write landed the way the screen imagined it: the server
// renumbers positions and folds colour aliases. So the screen redraws from
// the server's own answer.
//
// Saving COLUMNS still rewrites ROUTING server-side — hiding a column
// switches the rules that fed it off (saveStages' unroute) — but that card
// now lives on the Телефония screen, which reads its rules fresh every time
// it opens. Nothing on THIS screen can show a stale copy of them.
//
// crm_config_save already returns the whole config for exactly that reason;
// `fresh` is that reply. A reply that is not a config — an older server
// answering {ok:true} — falls back to one extra read, so the screen is right
// under either contract.
async function reload(fresh) {
    const cfg = (fresh && typeof fresh === 'object' && (Array.isArray(fresh.stages) || Array.isArray(fresh.sources)))
        ? fresh : await rpc('crm_config_get', {});
    state.cfg = shapeConfig(cfg);
    state.baseStages = sig(state.cfg.stages, STAGE_SIG_KEYS);
    state.baseSources = sig(state.cfg.sources, SOURCE_SIG_KEYS);
    paint();
}

const cardShell = (icon, title, ...content) => h('div', { class: 'card crm-set-card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-header' }, h('h3', null, Icon(icon, { size: 16 }), ' ', title)),
    ...content);

const hint = (text, style = {}) => h('div', { class: 'muted crm-set-note', style }, text);

// ---------------------------------------------------------------------------
// Shared row furniture
// ---------------------------------------------------------------------------
// ↑/↓ instead of drag-and-drop, deliberately: this is the pattern the lookup
// editors already use, it works with a keyboard and a screen reader without
// any extra work, and a settings list is reordered once a year — not a place
// to spend a drag implementation.
function moveButtons(list, index, onChange) {
    const btn = (delta, disabled, aria) => h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', disabled, 'aria-label': aria,
        style: { padding: '2px 6px', lineHeight: '1' },
        onclick: () => onChange(moveItem(list, index, delta)),
    }, Icon(delta < 0 ? 'ArrowUp' : 'ArrowDown', { size: 13 }));
    return h('div', { class: 'crm-set-move' },
        btn(-1, index === 0, 'Выше'),
        btn(1, index === list.length - 1, 'Ниже'));
}

// The key is shown, small and monospaced, because it is what the board's
// columns, the routing rules and every export are keyed by — an owner
// debugging with support needs to be able to read it out. It is never
// editable after creation: renaming a key would orphan every lead in it.
const keyChip = (key) => h('span', { class: 'cell-mono crm-set-key' }, key);

function labelInput(row, onEdit) {
    const input = h('input', {
        type: 'text', value: row.label, spellcheck: 'false', maxlength: String(LABEL_MAX),
    });
    // Typed straight into the model, with no repaint: repainting on every
    // keystroke would move the caret to the end of the field.
    input.addEventListener('input', () => { row.label = input.value; if (onEdit) onEdit(); });
    return input;
}

function activeToggle(row, { locked = false, lockedTitle = '' } = {}) {
    const cb = h('input', { type: 'checkbox', checked: !!row.is_active, disabled: locked, title: lockedTitle });
    cb.addEventListener('change', () => { row.is_active = cb.checked ? 1 : 0; });
    return checkField('Видна', cb);
}

// Removal only edits the list in memory; nothing is destroyed until «Сохранить».
// The confirm is still here because the pair «убрал строку → нажал сохранить»
// is easy to do by accident and impossible to undo afterwards.
// window.confirm is guarded: the fake-DOM test harness has no dialogs, and a
// missing dialog must not silently mean "no".
// The question is a STATIC dictionary string and the row's name is appended
// after it: tr() is keyed by the source string, so «Убрать колонку «X»…»
// built by concatenation would never find a translation and a UZ/EN clinic
// would get a Russian dialog.
function askRemove(label) {
    const text = tr('Убрать строку из списка? Она исчезнет только после сохранения.') + '\n\n' + label;
    return (typeof window !== 'undefined' && typeof window.confirm === 'function')
        ? window.confirm(text) : true;
}

function removeButton(label, onRemove) {
    return h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'Удалить',
        style: { color: 'var(--crit-700, #b03a3a)' },
        onclick: () => { if (askRemove(label)) onRemove(); },
    }, Icon('Trash', { size: 13 }));
}

// One grid row: [reorder] [name+key] [colour] [visible] [actions]. A grid, not
// a wrapping flex — with up to seven controls per row the flex version lined
// nothing up between rows and re-shuffled itself at every window width. Cells
// are always emitted, even when empty, or the columns stop aligning the moment
// one row lacks a delete button.
const rowBox = ({ move, name, colors, visible, actions }) => h('div', { class: 'crm-set-row' },
    h('div', { class: 'crm-set-move' }, move || null),
    h('div', { class: 'crm-set-name' }, name || null),
    h('div', { class: 'crm-set-colors' }, colors || null),
    h('div', { class: 'crm-set-visible' }, visible || null),
    h('div', { class: 'crm-set-actions' }, actions || null));

// ---------------------------------------------------------------------------
// 1. Колонки канбана
// ---------------------------------------------------------------------------
function stagesCard() {
    refs.stages = h('div', { style: { padding: '18px' } });
    paintStages();
    return cardShell('Grid', 'Колонки канбана', refs.stages);
}

function paintStages() {
    const box = refs.stages;
    clear(box);
    box.appendChild(hint('Колонки доски CRM слева направо. Скрытая колонка исчезает с доски, но заявки, которые в ней стоят, никуда не деваются.',
        { marginBottom: '12px' }));

    const list = state.cfg.stages;
    const onChange = (next) => { state.cfg.stages = next; paintStages(); };

    // The list is one visual block; explanations go UNDER it, not between the
    // rows. A paragraph after every protected row broke the rhythm of the
    // table and made eight columns look like a wall of prose.
    const listBox = h('div', { class: 'crm-set-list' });
    let hasWon = false;
    let hasUndeletable = false;

    list.forEach((row, i) => {
        const isWon = row.kind === 'won';
        const protectedRow = isWon || UNDELETABLE_STAGE_KEYS.includes(row.key);
        if (isWon) hasWon = true;
        if (!isWon && UNDELETABLE_STAGE_KEYS.includes(row.key)) hasUndeletable = true;
        listBox.appendChild(rowBox({
            move: moveButtons(list, i, onChange),
            name: [labelInput(row), keyChip(row.key)],
            colors: colorPicker(row),
            // The conversion column is a BEHAVIOUR, not a label: it is the only
            // status that opens the patient-registration popup. Badge it, and
            // take away the two controls that could break that path.
            visible: [
                isWon ? Tag('конверсия', { kind: 'ok' }) : null,
                activeToggle(row, { locked: isWon, lockedTitle: 'Колонку конверсии нельзя скрыть' }),
            ],
            actions: protectedRow
                ? null
                : removeButton(row.label, () => onChange(list.filter((_, j) => j !== i))),
        }));
    });
    box.appendChild(listBox);
    // The SAME sentences that used to sit between the rows, now collected
    // under the list: a row explains itself by having no delete button, and
    // the reason belongs where it can be read once instead of three times.
    if (hasWon) {
        box.appendChild(hint('Через эту колонку регистрируется пациент — её нельзя ни удалить, ни скрыть.',
            { marginTop: '10px' }));
    }
    if (hasUndeletable) {
        box.appendChild(hint(UNDELETABLE_STAGE_REASON, { marginTop: hasWon ? '4px' : '10px' }));
    }

    box.appendChild(addRow('Добавить колонку', 'Название новой колонки', (label, taken) => {
        state.cfg.stages = withPositions([...list, {
            key: deriveKey(label, taken, 'col'),
            label,
            // Grey by default ('' is the neutral token, matching mig 077's
            // CHECK): a new column has no meaning in the funnel yet, and
            // picking a colour for the owner would imply one.
            color: '',
            position: list.length + 1,
            is_active: 1,
            // Never 'won': the conversion column already exists and there can
            // be only one (validateStages refuses a second).
            kind: 'open',
        }]);
        paintStages();
    }, () => list.map((s) => s.key)));

    box.appendChild(saveRow('Сохранить колонки', async () => {
        const stages = withPositions(state.cfg.stages).map((s) => ({ ...s, label: String(s.label || '').trim() }));
        const v = validateStages(stages);
        if (!v.ok) { toast(v.error, 'warn'); return; }
        const fresh = await rpc('crm_config_save', { stages });
        toast('Колонки сохранены.', 'success');
        await reload(fresh);
    }, sig(state.cfg.stages, STAGE_SIG_KEYS) !== state.baseStages));
}

// Colour is picked from the house tokens as swatches — never a free hex field.
// The board's tags, the funnel report and the list view all reuse admin.css's
// `.tag-*` classes, so an arbitrary colour would either be ignored or land
// unreadable text on an unreadable background.
function colorPicker(row) {
    const box = h('div', { class: 'row', style: { gap: '4px' } });
    const repaint = () => {
        clear(box);
        for (const c of COLORS) {
            const on = row.color === c.token;
            box.appendChild(h('button', {
                type: 'button',
                class: 'tag' + (tagKind(c.token) ? ' tag-' + tagKind(c.token) : ''),
                'aria-label': c.label,
                'aria-pressed': on ? 'true' : 'false',
                title: c.label,
                style: {
                    width: '22px', height: '22px', padding: '0', cursor: 'pointer',
                    borderRadius: '999px', borderWidth: on ? '2px' : '1px',
                    borderStyle: 'solid', borderColor: on ? 'var(--ink-900, #16232b)' : 'var(--ink-200)',
                },
                onclick: () => { row.color = c.token; repaint(); },
            }));
        }
    };
    repaint();
    return box;
}

// ---------------------------------------------------------------------------
// 2. Источники
// ---------------------------------------------------------------------------
function sourcesCard() {
    refs.sources = h('div', { style: { padding: '18px' } });
    paintSources();
    return cardShell('Layers', 'Источники', refs.sources);
}

function paintSources() {
    const box = refs.sources;
    clear(box);
    box.appendChild(hint('Откуда пришло обращение. Источник выбирается в карточке заявки и служит фильтром доски и отчёта по воронке.',
        { marginBottom: '12px' }));

    const list = state.cfg.sources;
    const onChange = (next) => { state.cfg.sources = next; paintSources(); };

    const listBox = h('div', { class: 'crm-set-list' });
    let anyProtected = false;
    list.forEach((row, i) => {
        const protectedRow = UNDELETABLE_SOURCE_KEYS.includes(row.key);
        if (protectedRow) anyProtected = true;
        listBox.appendChild(rowBox({
            move: moveButtons(list, i, onChange),
            name: [labelInput(row), keyChip(row.key)],
            visible: activeToggle(row),
            actions: protectedRow
                ? null
                : removeButton(row.label, () => onChange(list.filter((_, j) => j !== i))),
        }));
    });
    box.appendChild(listBox);
    if (anyProtected) box.appendChild(hint(UNDELETABLE_SOURCE_REASON, { marginTop: '10px' }));

    box.appendChild(addRow('Добавить источник', 'Название нового источника', (label, taken) => {
        state.cfg.sources = withPositions([...list, {
            key: deriveKey(label, taken, 'src'), label, position: list.length + 1, is_active: 1,
        }]);
        paintSources();
    }, () => list.map((s) => s.key)));

    box.appendChild(saveRow('Сохранить источники', async () => {
        const sources = withPositions(state.cfg.sources).map((s) => ({ ...s, label: String(s.label || '').trim() }));
        const v = validateSources(sources);
        if (!v.ok) { toast(v.error, 'warn'); return; }
        const fresh = await rpc('crm_config_save', { sources });
        toast('Источники сохранены.', 'success');
        await reload(fresh);
    }, sig(state.cfg.sources, SOURCE_SIG_KEYS) !== state.baseSources));
}

// ---------------------------------------------------------------------------
// Add / save rows
// ---------------------------------------------------------------------------
// `taken()` is read at click time, not at build time: the list changes under
// this row every time something is added or removed, and a stale key list
// would hand out a duplicate key.
function addRow(buttonLabel, placeholder, onAdd, taken) {
    const input = h('input', { type: 'text', placeholder, spellcheck: 'false' });

    // ONE function, called by the button and by the Enter key.
    //
    // It used to be the button's onclick, with the key handler calling
    // `btn.onclick()`. That threw: ui.js's h() wires every on* prop through
    // addEventListener, so the .onclick PROPERTY is undefined and pressing
    // Enter — the first thing anyone does after typing a name — died with a
    // TypeError and added nothing. Reported as «I cannot add a column».
    function submit() {
        const label = String(input.value || '').trim();
        // Refusal, not a generated placeholder name: an unnamed column on
        // the board is worse than no column.
        if (!label) { toast('Введите название.', 'warn'); return; }
        input.value = '';
        onAdd(label, taken());
    }

    const btn = h('button', { class: 'btn', type: 'button', onclick: submit },
        Icon('Plus', { size: 13 }), ' ', buttonLabel);
    input.addEventListener('keydown', (e) => {
        if (!e || e.key !== 'Enter') return;
        // The field may sit inside a form one day; never let Enter navigate.
        if (typeof e.preventDefault === 'function') e.preventDefault();
        submit();
    });
    return h('div', { class: 'crm-set-add' }, input, btn);
}

// `dirty` = this section has edits that exist only on screen.
//
// Adding a column puts it in the list and NOTHING else — it reaches the clinic
// only when this button is pressed. Without saying so, the screen looks like it
// accepted the column and then lost it on the next reload, which is exactly how
// «I cannot add a column» feels from the other side. The marker is a plain
// sentence rather than a badge: it has to be readable, not decoded.
function saveRow(label, fn, dirty) {
    const btn = h('button', { class: 'btn btn-primary', type: 'button',
        onclick: () => run(btn, fn) }, Icon('Check', { size: 13 }), ' ', label);
    return h('div', { class: 'crm-set-save' },
        btn,
        dirty ? h('span', { class: 'crm-set-dirty', role: 'status' },
            Icon('Warning', { size: 13 }), ' ', 'Изменения не сохранены') : null);
}

// One save at a time: two sections written in parallel is a race the server
// resolves at random (verbatim the rule telephony-settings.js follows).
async function run(btn, fn) {
    if (state.busy) return;
    state.busy = true;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try { await fn(); }
    catch (e) {
        toast(isNotImplemented(e)
            ? tr('Сохранение недоступно: сервер ещё не обновлён.')
            : (e.message || tr('Не удалось сохранить.')), 'error');
    }
    finally {
        state.busy = false;
        try { btn.disabled = false; btn.textContent = label; } catch (_) { /* перерисовано */ }
    }
}
