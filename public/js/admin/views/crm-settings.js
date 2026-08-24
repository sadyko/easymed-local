// CRM_CONFIG_V1 — Настройки → «CRM-канбан»
// (docs/plans/2026-08-24-crm-kanban-settings.md, part B).
//
// Three jobs on one screen, in the order the owner described them:
//   1. «Колонки канбана» — the funnel itself: name, colour, order, visible.
//   2. «Источники» — where a lead came from.
//   3. «Звонки → карточки» — which column a Binotel call outcome lands in.
//
// Everything here writes to crm_stages / crm_sources / crm_call_routing
// (migration 077) through two RPCs, and views/crm.js reads the same config —
// so this screen IS the board's vocabulary, not a copy of it.
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
    validateStages, validateSources, validateRouting,
    dispositionRu, ROUTING_ACTIONS,
    shapeConfig, isNotImplemented,
} from '../crm-settings-logic.js';

const state = { cfg: null, busy: false };
let refs = { root: null, body: null, stages: null, sources: null, routing: null };

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

export async function renderCrmSettings(container, { onNavigate } = {}) {
    clear(container);
    refs = { root: null, body: null, stages: null, sources: null, routing: null, onNavigate: onNavigate || null };
    refs.root = h('div', { class: 'fade-in' });
    container.appendChild(refs.root);

    refs.root.appendChild(PageHead({
        title: 'CRM-канбан',
        subtitle: 'Колонки воронки, источники заявок и правила, по которым звонки становятся карточками.',
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
    refs.body.appendChild(routingCard());
}

// Never assume the write landed the way the screen imagined it: the server
// renumbers positions, folds colour aliases, and saving COLUMNS can rewrite
// ROUTING (hiding a column switches the rules that fed it off). So the screen
// redraws from the server's own answer.
//
// crm_config_save already returns the whole config for exactly that reason;
// `fresh` is that reply. A reply that is not a config — an older server
// answering {ok:true} — falls back to one extra read, so the screen is right
// under either contract.
async function reload(fresh) {
    const cfg = (fresh && typeof fresh === 'object' && (Array.isArray(fresh.stages) || Array.isArray(fresh.sources)))
        ? fresh : await rpc('crm_config_get', {});
    state.cfg = shapeConfig(cfg);
    paint();
}

const cardShell = (icon, title, ...content) => h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-header' }, h('h3', null, Icon(icon, { size: 16 }), ' ', title)),
    ...content);

const hint = (text, style = {}) => h('div', { class: 'muted',
    style: { fontSize: '12px', lineHeight: '1.6', ...style } }, text);

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
    return h('div', { class: 'row', style: { gap: '2px' } },
        btn(-1, index === 0, 'Выше'),
        btn(1, index === list.length - 1, 'Ниже'));
}

// The key is shown, small and monospaced, because it is what the board's
// columns, the routing rules and every export are keyed by — an owner
// debugging with support needs to be able to read it out. It is never
// editable after creation: renaming a key would orphan every lead in it.
const keyChip = (key) => h('span', { class: 'cell-mono muted',
    style: { fontSize: '11px', whiteSpace: 'nowrap' } }, key);

function labelInput(row, onEdit) {
    const input = h('input', {
        type: 'text', value: row.label, spellcheck: 'false', maxlength: String(LABEL_MAX),
        style: { width: '100%' },
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

const rowBox = (...children) => h('div', {
    class: 'row',
    style: { gap: '10px', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--ink-100)', flexWrap: 'wrap' },
}, ...children);

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

    list.forEach((row, i) => {
        const isWon = row.kind === 'won';
        box.appendChild(rowBox(
            moveButtons(list, i, onChange),
            h('div', { style: { flex: '1 1 200px', minWidth: '160px' } }, labelInput(row)),
            keyChip(row.key),
            colorPicker(row),
            // The conversion column is a BEHAVIOUR, not a label: it is the only
            // status that opens the patient-registration popup. Badge it, and
            // take away the two controls that could break that path.
            isWon ? Tag('конверсия', { kind: 'ok' }) : null,
            activeToggle(row, { locked: isWon, lockedTitle: 'Колонку конверсии нельзя скрыть' }),
            h('span', { class: 'grow' }),
            (isWon || UNDELETABLE_STAGE_KEYS.includes(row.key))
                ? null
                : removeButton(row.label, () => onChange(list.filter((_, j) => j !== i))),
        ));
        if (isWon) {
            box.appendChild(hint('Через эту колонку регистрируется пациент — её нельзя ни удалить, ни скрыть.',
                { margin: '-4px 0 4px 0' }));
        } else if (UNDELETABLE_STAGE_KEYS.includes(row.key)) {
            box.appendChild(hint(UNDELETABLE_STAGE_REASON, { margin: '-4px 0 4px 0' }));
        }
    });

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
    }));
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

    list.forEach((row, i) => {
        box.appendChild(rowBox(
            moveButtons(list, i, onChange),
            h('div', { style: { flex: '1 1 200px', minWidth: '160px' } }, labelInput(row)),
            keyChip(row.key),
            activeToggle(row),
            h('span', { class: 'grow' }),
            UNDELETABLE_SOURCE_KEYS.includes(row.key)
                ? null
                : removeButton(row.label, () => onChange(list.filter((_, j) => j !== i))),
        ));
        if (UNDELETABLE_SOURCE_KEYS.includes(row.key)) {
            box.appendChild(hint(UNDELETABLE_SOURCE_REASON, { margin: '-4px 0 4px 0' }));
        }
    });

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
    }));
}

// ---------------------------------------------------------------------------
// 3. Звонки → карточки
// ---------------------------------------------------------------------------
function routingCard() {
    refs.routing = h('div');
    paintRouting();
    return cardShell('Headset', 'Звонки → карточки', refs.routing);
}

function paintRouting() {
    const box = refs.routing;
    clear(box);

    const stages = state.cfg.stages;
    const activeStages = stages.filter((s) => s.is_active);
    const rows = state.cfg.routing;

    box.appendChild(hint('Телефония сообщает, чем закончился каждый звонок. Здесь решается, из каких звонков система сама делает заявку и в какую колонку её кладёт.',
        { padding: '18px 18px 0' }));

    if (!rows.length) {
        box.appendChild(h('div', { class: 'empty', style: { padding: '30px 20px' } },
            h('p', null, 'Правил маршрутизации пока нет.'),
            h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                'Они приезжают вместе с обновлением сервера — исходы звонков и правила по умолчанию задаются там.')));
        box.appendChild(routingFootnote());
        return;
    }

    const tb = h('tbody');
    for (const r of rows) {
        // The action select drives the column select: «не создавать» has no
        // column to name, so the field goes disabled rather than pretending
        // the choice still matters.
        const stageSel = h('select', { style: { minWidth: '180px' }, disabled: r.action !== 'create' },
            ...activeStages.map((s) => h('option', { value: s.key, selected: r.stage_key === s.key }, s.label)));
        stageSel.addEventListener('change', () => { r.stage_key = stageSel.value; });

        const actionSel = h('select', { style: { minWidth: '160px' } },
            ...ROUTING_ACTIONS.map((a) => h('option', { value: a.value, selected: r.action === a.value }, a.label)));
        actionSel.addEventListener('change', () => {
            r.action = actionSel.value;
            // Switching to «создать заявку» with no column chosen would build a
            // rule that refuses to save. Land it in the first visible column
            // instead — the owner can move it, and the rule is valid meanwhile.
            if (r.action === 'create' && !activeStages.some((s) => s.key === r.stage_key)) {
                r.stage_key = activeStages.length ? activeStages[0].key : null;
            }
            paintRouting();
        });

        tb.appendChild(h('tr', null,
            h('td', null,
                h('div', null, dispositionRu(r.disposition)),
                // The raw code stays visible: it is what Binotel support and
                // the call log speak, and an outcome this screen has not
                // learned shows up as its code and nothing else.
                h('div', { class: 'cell-mono muted', style: { fontSize: '11px' } }, r.disposition)),
            h('td', null, actionSel),
            h('td', null, stageSel),
        ));
    }

    box.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
        h('thead', null, h('tr', null,
            h('th', null, 'Исход звонка'),
            h('th', null, 'Что делать'),
            h('th', null, 'В какую колонку'))),
        tb));

    box.appendChild(h('div', { style: { padding: '0 18px' } }, saveRow('Сохранить маршрут', async () => {
        const routing = state.cfg.routing.map((r) => ({
            provider: r.provider || 'binotel',
            disposition: r.disposition,
            action: r.action,
            // «Не создавать» keeps no column: a rule that creates nothing has
            // nowhere to put it, and storing a stale key would resurrect a
            // deleted column's name on the next read.
            stage_key: r.action === 'create' ? r.stage_key : null,
        }));
        const v = validateRouting(routing, state.cfg.stages);
        if (!v.ok) { toast(v.error, 'warn'); return; }
        const fresh = await rpc('crm_config_save', { routing });
        toast('Маршрут сохранён.', 'success');
        await reload(fresh);
    })));
    box.appendChild(routingFootnote());
}

// The honest limit, on the screen rather than in the documentation: these
// rules do nothing at all unless the Телефония module is connected AND its
// call polling is on — no call reaches the system otherwise, so there is
// nothing to route.
function routingFootnote() {
    return h('div', { style: { padding: '0 18px 18px' } },
        hint('Правила работают, только пока подключён модуль «Телефония» и включён опрос звонков — иначе звонки в систему не попадают и заявки создавать не из чего.'),
        h('button', {
            class: 'btn btn-sm', type: 'button', style: { marginTop: '8px' },
            onclick: () => { if (refs.onNavigate) refs.onNavigate('telephony-settings'); },
            // The label is its own text child, with the space beside it: h()
            // runs tr() once PER child, and ' Настройки телефонии' — a single
            // child carrying a leading space — is a different dictionary key
            // from the phrase itself, so it would never be translated.
        }, Icon('Phone', { size: 13 }), ' ', 'Настройки телефонии'));
}

// ---------------------------------------------------------------------------
// Add / save rows
// ---------------------------------------------------------------------------
// `taken()` is read at click time, not at build time: the list changes under
// this row every time something is added or removed, and a stale key list
// would hand out a duplicate key.
function addRow(buttonLabel, placeholder, onAdd, taken) {
    const input = h('input', { type: 'text', placeholder, spellcheck: 'false', style: { flex: '1 1 220px', minWidth: '160px' } });
    const btn = h('button', { class: 'btn', type: 'button',
        onclick: () => {
            const label = String(input.value || '').trim();
            // Refusal, not a generated placeholder name: an unnamed column on
            // the board is worse than no column.
            if (!label) { toast('Введите название.', 'warn'); return; }
            input.value = '';
            onAdd(label, taken());
        } }, Icon('Plus', { size: 13 }), ' ', buttonLabel);
    return h('div', { class: 'row', style: { gap: '8px', marginTop: '12px', flexWrap: 'wrap' } }, input, btn);
}

function saveRow(label, fn) {
    const btn = h('button', { class: 'btn btn-primary', type: 'button',
        onclick: () => run(btn, fn) }, Icon('Check', { size: 13 }), ' ', label);
    return h('div', { class: 'row', style: { gap: '8px', marginTop: '14px' } }, btn);
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
