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
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { caseDocTitle } from './case-docs.js?v=cw1';

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

// CASE_DOC_SET_SIMPLE_V1 — окна правки здесь больше нет: заведение документа
// стало одной строкой, а срок и блок правятся тем же серверным вызовом, когда
// они действительно понадобятся. Держать ради этого окно на четыре решения
// значило бы платить им за каждое добавление.

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

    // CASE_DOC_SET_SIMPLE_V1 — стрелок порядка в панели больше нет: строка это
    // имя и одна кнопка. Порядок остаётся за сервером (case_doc_types_reorder),
    // и вернуть его сюда можно, не трогая ничего другого.
    const setActive = async (t, active) => {
        const { error } = await supabase.rpc('case_doc_type_set_active', { kind: t.kind, active });
        if (error) { toast(error.message || tr('Не удалось изменить набор.'), 'fail'); return; }
        toast(active ? tr('Документ вернулся в набор.') : tr('Документ убран из набора.'), 'ok');
        await load(true);
    };

    // CASE_DOC_SET_SIMPLE_V1 (2026-09-09) — владелец: «i cannot add, because its
    // asking something with dialogue window … make just name of the document +
    // button and remove buttons and at the bottom a create document field».
    //
    // Окно спрашивало имя, правило срока, часы и «только у оперируемых» — четыре
    // решения там, где у врача одно: такого документа у нас нет, заведите. Срок
    // и блок нужны редко, а требовать их при заведении значит требовать всегда.
    // Свой документ создаётся БЕЗ СРОКА: он в наборе, спрашивается, но
    // просроченным не висит. Понадобится срок — его правят на сервере тем же
    // вызовом, что и раньше.
    function row(t) {
        const name = caseDocTitle(t.kind, t.title);
        return h('div', { class: 'cds-row' + (t.active ? '' : ' cds-off') },
            h('div', { class: 'cds-name' }, name),
            t.locked
                // Выписной эпикриз убрать нечем: на нём стоит гейт выписки, и
                // кнопка, которая всегда откажет, — обещание, а не действие.
                ? h('span', { class: 'cds-lock', title: tr('Выписной эпикриз убрать нельзя: на нём стоит гейт выписки.') },
                    Icon('Lock', { size: 13 }))
                : h('button', {
                    class: 'btn btn-sm btn-ghost', type: 'button',
                    'aria-label': t.active ? trf('Убрать из набора: {name}', { name }) : trf('Вернуть в набор: {name}', { name }),
                    title: t.active ? tr('Убрать из набора') : tr('Вернуть в набор'),
                    onclick: () => setActive(t, !t.active),
                }, Icon(t.active ? 'Minus' : 'Plus', { size: 13 })));
    }

    // Поле создания: имя — и всё. Enter работает так же, как кнопка: это одна
    // строка, и тянуться к мыши ради неё не за что.
    function addRow() {
        const input = h('input', { type: 'text', class: 'cds-new-in', placeholder: tr('Название нового документа') });
        const submit = async () => {
            const title = String(input.value || '').trim();
            if (!title) { input.focus && input.focus(); return; }
            const { error } = await supabase.rpc('case_doc_type_save', { title, due_rule: 'none', due_hours: null, block: '' });
            if (error) { toast(error.message || tr('Не удалось сохранить документ.'), 'fail'); return; }
            input.value = '';
            toast(tr('Документ добавлен в набор.'), 'ok');
            await load(true);
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); submit(); }
        });
        return h('div', { class: 'cds-new' }, input,
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: submit },
                Icon('Plus', { size: 13 })));
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
        if (types.length) {
            const list = h('div', { class: 'cds-list' });
            types.forEach((t) => list.appendChild(row(t)));
            box.appendChild(list);
        } else {
            box.appendChild(h('div', { class: 'cds-note' }, tr('Набор пуст.')));
        }
        box.appendChild(addRow());
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
