// CASE_DOC_SET_V2 — СОСТАВ ИСТОРИИ БОЛЕЗНИ НАСТРАИВАЕТ КЛИНИКА.
//
// Владелец (2026-09-08): «this list is hardcoded and the system asks for
// filling them, we need to make not hardcoded, and able to add a title
// document. its maybe before operation it can be anesthesist list etc etc. but
// we shoud give basic templates list + option».
//
// Экран живёт в «Документах» рядом с бланком документа: там же клиника пишет,
// ЧТО в документе, — логично, что рядом она решает, КАКИЕ документы вообще
// бывают. Отдельный раздел настроек для одного списка был бы ещё одним местом,
// куда надо помнить дорогу.
//
// ЧТО ЗДЕСЬ МОЖНО. Завести свой документ, поправить срок и имя, переставить
// местами, убрать из набора и вернуть обратно. Чего нельзя — тому есть причина,
// и она сказана вслух прямо в списке: встроенный род не удаляется (на него
// ссылаются написанные записи), выписной эпикриз не убирается (на нём стоит
// гейт выписки).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, field } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { caseDocTitle } from './case-docs.js?v=cw1';
import { inpatientModal } from './inpatient-modal.js';

/** Правила срока словами: клиника выбирает, КАК считается срок, а не выдумывает его. */
export const DUE_RULE_LABEL = {
    clock:        'Часы от поступления',
    period:       'Повторяется каждые N часов',
    surgical:     'Часы от начала операции',
    at_discharge: 'При выписке',
    none:         'Без срока',
};
const RULES_WITH_HOURS = ['clock', 'period', 'surgical'];

/** Строка «когда» — та же формулировка, что читает врач в чек-листе. */
export function dueWords(t) {
    if (!t) return '';
    if (t.due_rule === 'period') return trf('каждые {n} ч', { n: t.due_hours });
    if (t.due_rule === 'clock') return trf('{n} ч от поступления', { n: t.due_hours });
    if (t.due_rule === 'surgical') return trf('{n} ч от начала операции', { n: t.due_hours });
    if (t.due_rule === 'at_discharge') return tr('При выписке');
    return tr('Без срока');
}

// ---------------------------------------------------------------------------
// Окно правки одного документа
// ---------------------------------------------------------------------------
function openTypeModal({ type = null, onDone } = {}) {
    const isNew = !type;
    const titleIn = h('input', { type: 'text', value: type ? type.title : '', placeholder: tr('Например: Лист анестезиолога') });
    const ruleSel = h('select', null, ...Object.keys(DUE_RULE_LABEL).map((k) => h('option', {
        value: k, selected: type && type.due_rule === k ? true : null,
    }, tr(DUE_RULE_LABEL[k]))));
    const hoursIn = h('input', { type: 'number', min: '1', step: '1',
        value: type && type.due_hours !== null && type.due_hours !== undefined ? String(type.due_hours) : '' });
    const blockIn = h('input', { type: 'checkbox', checked: type && type.block === 'surgical' ? true : null });

    const hoursField = field(tr('Срок, часов'), hoursIn);
    const syncHours = () => { hoursField.style.display = RULES_WITH_HOURS.includes(ruleSel.value) ? '' : 'none'; };
    ruleSel.addEventListener('change', syncHours);
    syncHours();

    // Встроенное имя переводится на три языка; своё — нет. Сказать об этом
    // честнее, чем дать переименовать и молча потерять переводы.
    const nameNote = type && type.builtin
        ? h('div', { class: 'muted', style: { fontSize: '12.5px', lineHeight: '1.45' } },
            tr('У встроенного документа имя переводится на три языка. Своё имя заменит перевод и останется на одном языке — оставьте поле пустым, чтобы вернуть перевод.'))
        : null;

    return inpatientModal(isNew ? tr('Новый документ истории болезни') : tr('Документ истории болезни'), 'Doc', [
        field(tr('Название'), titleIn, { required: !type || !type.builtin }),
        nameNote,
        field(tr('Когда его ждут'), ruleSel),
        hoursField,
        h('label', { class: 'row', style: { gap: '8px', alignItems: 'center', fontSize: '13.5px', cursor: 'pointer' } },
            blockIn, h('span', null, tr('Только у оперируемых пациентов'))),
        h('div', { class: 'muted', style: { fontSize: '12.5px', lineHeight: '1.45' } },
            tr('Документ с этой отметкой появляется в списке, только когда у пациента написан хоть один документ операции.')),
    ], isNew ? tr('Добавить') : tr('Сохранить'), async () => {
        const args = {
            title: titleIn.value.trim(),
            due_rule: ruleSel.value,
            due_hours: RULES_WITH_HOURS.includes(ruleSel.value) ? Number(hoursIn.value) : null,
            block: blockIn.checked ? 'surgical' : '',
        };
        if (type) args.kind = type.kind;
        const { error } = await supabase.rpc('case_doc_type_save', args);
        if (error) { toast(error.message || tr('Не удалось сохранить документ.'), 'fail'); return false; }
        toast(isNew ? tr('Документ добавлен в набор.') : tr('Документ сохранён.'), 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 560 });
}

// ---------------------------------------------------------------------------
// Список состава
// ---------------------------------------------------------------------------
/**
 * Панель «Состав истории болезни».
 * @returns {Node} карточка, которая сама грузится и сама перерисовывается
 */
export function caseDocSetPanel({ onChange = null } = {}) {
    const box = h('section', { class: 'card cds', 'aria-label': tr('Состав истории болезни') });
    let types = [];

    const load = async (changed) => {
        const { data, error } = await supabase.rpc('case_doc_types_list', {});
        if (error) { types = null; paint(); return; }
        types = (data && data.types) || [];
        paint();
        // Состав изменился — чек-лист рядом обязан показать это сразу, иначе
        // врач видит документ в наборе и не видит его в списке.
        if (changed && onChange) { try { await onChange(); } catch (e) { /* экран сам перерисуется */ } }
    };

    const reorder = async (kinds) => {
        const { error } = await supabase.rpc('case_doc_types_reorder', { kinds });
        if (error) { toast(error.message || tr('Не удалось изменить порядок.'), 'fail'); return; }
        await load(true);
    };

    const setActive = async (t, active) => {
        const { error } = await supabase.rpc('case_doc_type_set_active', { kind: t.kind, active });
        if (error) { toast(error.message || tr('Не удалось изменить набор.'), 'fail'); return; }
        toast(active ? tr('Документ вернулся в набор.') : tr('Документ убран из набора.'), 'ok');
        await load(true);
    };

    function row(t, i) {
        const name = caseDocTitle(t.kind, t.title);
        const move = (delta) => {
            const order = types.map((x) => x.kind);
            const j = i + delta;
            if (j < 0 || j >= order.length) return;
            const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
            reorder(order);
        };
        return h('div', { class: 'cds-row' + (t.active ? '' : ' cds-off') },
            h('div', { class: 'cds-ord' },
                h('button', { class: 'cds-move', type: 'button', disabled: i === 0 ? true : null,
                    'aria-label': trf('Выше: {name}', { name }), onclick: () => move(-1) }, Icon('ArrowUp', { size: 13 })),
                h('button', { class: 'cds-move', type: 'button', disabled: i === types.length - 1 ? true : null,
                    'aria-label': trf('Ниже: {name}', { name }), onclick: () => move(1) }, Icon('ArrowDown', { size: 13 }))),
            h('div', { class: 'cds-main' },
                h('div', { class: 'cds-name' }, name,
                    t.builtin ? h('span', { class: 'cds-tag' }, tr('встроенный')) : null,
                    t.block === 'surgical' ? h('span', { class: 'cds-tag' }, tr('операция')) : null),
                h('div', { class: 'cds-when' }, dueWords(t),
                    t.used ? h('span', { class: 'cds-used' }, trf('записей: {n}', { n: t.used })) : null)),
            h('div', { class: 'cds-acts' },
                h('button', { class: 'btn btn-sm btn-ghost', type: 'button',
                    'aria-label': trf('Изменить: {name}', { name }),
                    onclick: () => openTypeModal({ type: t, onDone: () => load(true) }) }, Icon('Edit', { size: 13 })),
                t.locked
                    ? h('span', { class: 'cds-lock', title: tr('Выписной эпикриз убрать нельзя: на нём стоит гейт выписки.') },
                        Icon('Lock', { size: 13 }))
                    : h('button', {
                        class: 'btn btn-sm btn-ghost', type: 'button',
                        'aria-label': t.active ? trf('Убрать из набора: {name}', { name }) : trf('Вернуть в набор: {name}', { name }),
                        onclick: () => setActive(t, !t.active),
                    }, Icon(t.active ? 'Minus' : 'Plus', { size: 13 }))));
    }

    function paint() {
        clear(box);
        box.appendChild(h('header', { class: 'cds-h' },
            h('span', { class: 'cds-h-ic' }, Icon('Doc', { size: 14 })),
            h('h3', { class: 'cds-h-t' }, tr('Состав истории болезни'))));

        if (types === null) {
            box.appendChild(h('div', { class: 'cds-note cds-fail' }, tr('Состав не загрузился. Обновите страницу.')));
            return;
        }
        box.appendChild(h('div', { class: 'cds-note' },
            tr('Эти документы система спрашивает у врача по каждой госпитализации. Порядок здесь — порядок чек-листа и собранной истории.')));
        if (!types.length) {
            box.appendChild(h('div', { class: 'cds-note' }, tr('Набор пуст.')));
            return;
        }
        const list = h('div', { class: 'cds-list' });
        types.forEach((t, i) => list.appendChild(row(t, i)));
        box.appendChild(list);
        // CASE_DOC_SET_IN_RAIL_V1 — владелец: «in the left panel we have add
        // remove buttons and one create button in the bottom». У строк — правка
        // и «убрать»; создание одно и стоит под списком, где кончается перечень
        // и начинается мысль «а такого документа у нас нет».
        box.appendChild(h('button', {
            class: 'btn btn-primary btn-sm cds-add', type: 'button',
            onclick: () => openTypeModal({ onDone: () => load(true) }),
        }, Icon('Plus', { size: 13 }), ' ', tr('Добавить документ')));

        const off = types.filter((t) => !t.active).length;
        if (off) {
            box.appendChild(h('div', { class: 'cds-note' },
                trf('Убрано из набора: {n}. Написанные ими записи остались в историях болезни.', { n: off })));
        }
    }

    paint();
    load();
    return box;
}
