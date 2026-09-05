// CASE_DOCS_V1 — ЧЕК-ЛИСТ ДОКУМЕНТОВ ИСТОРИИ БОЛЕЗНИ и СБОРКА ИСТОРИИ В ОДИН
// ФАЙЛ. Ответ на вопрос владельца: «можно сделать список стационарной
// госпитализации вот так? и собрать документы в один файл?» — мокап
// 040926/doc-checklist-mockup.html.
//
// ─── ЧТО ЗДЕСЬ ОТ МОКАПА, А ЧТО НЕТ ─────────────────────────────────────────
//
// От мокапа взято главное — СПОСОБ ЧИТАТЬ СПИСОК: состояние документа названо
// тремя способами сразу (цветной рельс слева, кружок-иконка, слово в мете),
// заметное действие ровно одно, обязательные и прочие документы разделены,
// сверху — «сколько оформлено», снизу — правило про выписку.
//
// НЕ взято три вещи, и каждая — сознательный отказ:
//
//   1. ДЕЙСТВИЯ ПО НАВЕДЕНИЮ МЫШИ. В мокапе кнопки «открыть / исправить /
//      создать» появляются на :hover. В клинике на экран нажимают ПАЛЬЦЕМ (у
//      сестринского поста тачскрин) и ходят по нему с клавиатуры; наведения
//      там не существует, то есть у половины строк действий нет вовсе. Здесь
//      кнопки видны всегда, у каждой своё имя для чтения с экрана, и до каждой
//      можно дойти табом.
//   2. РАЗМЕРЫ ШРИФТА 11.8 И 10.7 px. У продукта одна шкала (12.5 / 13.5 / 15 /
//      17 / 20 / 24 / 30 / 40, admin.css --fs-1..8, проверяется
//      __tests__/type-scale.test.mjs), и 12.5 — это ПОЛ, а не рекомендация:
//      мельче в клинике не читают. Плотность мокапа набрана не кеглем, а
//      расстояниями и насыщенностью.
//   3. ЯРЛЫК «ХИРУРГ. ПРОФИЛЬ». Профиля отделения в продукте сегодня нет
//      (department — свободный текст, миграция 092), и рисовать ярлык, за
//      которым ничего не стоит, — врать картинкой. Хирургический блок
//      появляется по ДАННЫМ (см. rpc/inpatient-reviews.js, CASE_DOC_SET).
//
// ─── ЭКРАН НИЧЕГО НЕ СЧИТАЕТ САМ ────────────────────────────────────────────
//
// Ни сроков, ни состояний, ни «что следующее», ни «чего не хватает для
// выписки». Всё это приходит одним ответом `admission_case_docs`, потому что
// вторая копия правила в браузере разошлась бы с сервером молча — ровно так,
// как уже расходились список врачей и матрица прав (см. шапку
// admission-modal.js). Здесь остаются НАЗВАНИЯ документов (их переводят) и
// вёрстка.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ

// ---------------------------------------------------------------------------
// Словарь названий
// ---------------------------------------------------------------------------
// Порядок и состав задаёт СЕРВЕР (CASE_DOC_SET); здесь только имена. Список
// покрыт тестом на полноту (__tests__/case-docs.test.mjs): род документа,
// приехавший с сервера без имени, нарисовался бы пустой строкой.
export const CASE_DOC_TITLE = {
    consent:     'Согласие на госпитализацию и вмешательство',
    intake:      'Осмотр приёмного врача',
    anesthesia:  'Осмотр анестезиолога и согласие на анестезию',
    preop:       'Предоперационный эпикриз',
    head_review: 'Осмотр заведующего отделением',
    primary:     'Первичный осмотр и план лечения',
    rationale:   'Обоснование клинического диагноза',
    operation:   'Протокол операции',
    round:       'Дневник наблюдения',
    interim:     'Этапный эпикриз',
    discharge:   'Выписной эпикриз',
    other:       'Прочий документ',
};

export function caseDocTitle(kind) {
    return tr(CASE_DOC_TITLE[kind] || CASE_DOC_TITLE.other);
}

// Слово состояния — третий способ назвать его (после рельса и кружка). Слово
// нужно тем, кто цвет не различает, и тем, кто читает экран голосом.
const STATE_WORD = {
    published: 'оформлен',
    draft:     'черновик',
    overdue:   'просрочен',
    next:      'следующий',
    pending:   'ожидает',
};

const STATE_COLOR = {
    published: 'var(--ok-500)',
    draft:     'var(--warn-500)',
    overdue:   'var(--crit-500)',
    next:      'var(--primary-600)',
    pending:   'var(--ink-300)',
};

const STATE_ICON = { published: 'Check', draft: 'Edit', overdue: 'Warning', next: 'ArrowRight', pending: 'Clock' };

export function caseDocStateWord(state) {
    return tr(STATE_WORD[state] || STATE_WORD.pending);
}

// ---------------------------------------------------------------------------
// Срок словами
// ---------------------------------------------------------------------------
/**
 * Подпись срока под названием документа.
 *
 * В мокапе это литералы («до 09.06», «было ≤ 72 ч», «через 10 сут (~18.06)»).
 * Здесь — тот же смысл, собранный из ВЫЧИСЛЕННОГО сервером `due_at` и рода
 * срока. Форма фразы зависит от рода: «до …» у разового, «ежедневно · …» у
 * дневника, «при выписке» у эпикриза — одна общая формулировка на все три
 * обманывала бы в двух случаях из трёх.
 */
export function caseDueText(item, state) {
    if (!item) return '';
    if (item.due_rule === 'at_discharge') return tr('при выписке');
    if (!state || !state.base_at) return tr('срок пойдёт с момента размещения на койке');
    if (!item.applies) return tr('только при операции');

    const when = item.due_at ? fmtDateTime(item.due_at) : '';
    if (item.due_rule === 'period') {
        if (item.periods_missing > 0) {
            return item.period_hours === 24
                ? trf('пропущено суток: {n}', { n: item.periods_missing })
                : trf('пропущено периодов: {n}', { n: item.periods_missing });
        }
        return item.period_hours === 24
            ? trf('ежедневно · следующая запись до {when}', { when })
            : trf('каждые 10 суток · следующий до {when}', { when });
    }
    if (item.state === 'overdue') return trf('срок был до {when}', { when });
    return when ? trf('до {when}', { when }) : '';
}

/** «оформлен 8 июня 2026 г., 11:57 · Мудунов А.М.» — кто и когда подписал. */
export function caseDoneText(item) {
    const when = item.published_at ? fmtDateTime(item.published_at) : '';
    const who = String(item.author_name || '').trim();
    if (when && who) return trf('{when} · {who}', { when, who });
    return when || who;
}

// ---------------------------------------------------------------------------
// Гейт выписки — словами сервера, а не своими
// ---------------------------------------------------------------------------
/**
 * ПОЧЕМУ ВЫПИСКА НЕ ПРОЙДЁТ — тем же документом и с тем же разделением, каким
 * отказывает сервер (rpc/inpatient.js, admission_discharge_request): «не
 * написан» и «сохранён черновиком» — две разные беды с двумя разными
 * починками, и одному человеку осталось нажать «Опубликовать», а другому —
 * написать документ.
 *
 * Про остальной набор здесь НЕ говорится «блокирует»: сегодня выписку держит
 * только эпикриз, и пообещать большее значило бы научить врача не тому.
 */
export function caseGateText(state) {
    const gate = (state && state.discharge_gate) || { blocking: [], incomplete: [] };
    const blocked = (gate.blocking || [])[0] || null;
    if (!blocked) return tr('Выписной эпикриз оформлен — заявку на выписку примут.');
    return blocked.reason === 'draft'
        ? tr('Заявку на выписку не примут: выписной эпикриз сохранён черновиком — его нужно опубликовать.')
        : tr('Заявку на выписку не примут: выписной эпикриз ещё не написан.');
}

/** Названия недооформленных документов — тот же список, что у сервера. */
export function caseMissingTitles(state) {
    return ((state && state.discharge_gate && state.discharge_gate.incomplete) || []).map(caseDocTitle);
}

// ---------------------------------------------------------------------------
// Фильтры
// ---------------------------------------------------------------------------
export const CASE_FILTERS = [
    ['all', 'Все'],
    ['todo', 'К заполнению'],
    ['overdue', 'Просрочено'],
];

export function caseFilterMatch(filter, item) {
    if (filter === 'overdue') return item.state === 'overdue';
    if (filter === 'todo') return item.state !== 'published';
    return true;
}

/** Пункты, которые вообще показываются: неприменимый блок не место занимает. */
export function caseVisibleItems(state, filter) {
    const items = ((state && state.items) || []).filter((i) => i.applies);
    return items.filter((i) => caseFilterMatch(filter, i));
}

// ---------------------------------------------------------------------------
// Панель
// ---------------------------------------------------------------------------

function stateDot(item) {
    return h('span', {
        style: {
            width: '20px', height: '20px', borderRadius: '50%', flexShrink: '0',
            display: 'grid', placeItems: 'center', marginTop: '1px',
            background: item.state === 'pending' ? 'var(--white)' : STATE_COLOR[item.state],
            border: item.state === 'pending' ? '2px solid var(--ink-200)' : 'none',
            color: 'var(--white)',
        },
    }, item.state === 'pending' ? null : Icon(STATE_ICON[item.state] || 'Clock', { size: 12 }));
}

function progressBar(progress) {
    const total = Math.max(1, progress.total);
    const seg = (n, color) => (n > 0
        ? h('i', { style: { display: 'block', height: '100%', background: color, width: (n / total * 100) + '%' } })
        : null);
    return h('div', {
        style: {
            height: '8px', borderRadius: '6px', background: 'var(--ink-100)',
            overflow: 'hidden', display: 'flex', marginTop: '6px',
        },
    }, seg(progress.done, 'var(--ok-500)'), seg(progress.draft, 'var(--warn-500)'), seg(progress.overdue, 'var(--crit-500)'));
}

/**
 * Кнопка действия. ВСЕГДА ВИДНА и ВСЕГДА ИМЕНОВАНА — см. шапку файла: в мокапе
 * действия появляются по наведению, и на тачскрине их нет.
 */
function actionBtn(label, { primary = false, icon = null, onclick }) {
    return h('button', {
        class: 'btn btn-sm' + (primary ? ' btn-primary' : ''),
        type: 'button',
        'aria-label': label,
        style: { whiteSpace: 'nowrap' },
        onclick,
    }, icon ? Icon(icon, { size: 13 }) : null, icon ? ' ' : null, label);
}

function revisionsBlock(item, onDoc) {
    // ИСПРАВЛЕНИЕ ХРАНИТ ОРИГИНАЛ (миграция 095), и список редакций — это
    // единственное место, где врач может его увидеть. В мокапе он захардкожен
    // парой строк; здесь это настоящие авторы, времена и номера.
    const list = h('ul', {
        style: {
            listStyle: 'none', margin: '4px 0 2px 30px', padding: '0 0 0 10px',
            borderLeft: '2px dashed var(--ink-100)', display: 'none',
        },
    }, ...item.revisions.map((rev) => h('li', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '12.5px' },
    },
    h('span', { style: { color: rev.current ? 'var(--primary-600)' : 'var(--ink-400)', fontWeight: rev.current ? '600' : '400' } },
        rev.no === 1 ? tr('Оригинал') : trf('Исправление {n}', { n: rev.no - 1 })),
    h('span', { class: 'muted', style: { flex: '1', minWidth: '0' } },
        [rev.at ? fmtDateTime(rev.at) : '', rev.author_name || ''].filter(Boolean).join(' · ')),
    h('button', {
        class: 'btn btn-sm', type: 'button',
        'aria-label': trf('Открыть редакцию {n}', { n: rev.no }),
        onclick: () => onDoc(item.kind, 'view', rev.id),
    }, tr('Открыть')))));

    const toggle = h('button', {
        class: 'btn btn-sm', type: 'button', 'aria-expanded': 'false',
        onclick: () => {
            const open = toggle.getAttribute('aria-expanded') === 'true';
            toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
            list.style.display = open ? 'none' : 'block';
        },
    }, trf('{n} ред.', { n: item.revision_count }));
    return { toggle, list };
}

function itemRow(item, state, onDoc) {
    const isNext = item.state === 'next';
    const meta = item.state === 'published' ? caseDoneText(item) : caseDueText(item, state);

    const open = h('button', {
        class: 'btn-plain', type: 'button',
        style: {
            flex: '1', minWidth: '0', textAlign: 'left', background: 'none', border: 'none',
            padding: '0', cursor: 'pointer', font: 'inherit', color: 'inherit',
        },
        onclick: () => onDoc(item.kind, item.state === 'published' ? 'view' : 'edit', item.review_id || item.draft_id || null),
    },
    h('span', {
        style: {
            display: 'block', fontSize: '13.5px', lineHeight: '1.35',
            fontWeight: item.state === 'pending' ? '500' : '600',
            color: item.state === 'pending' ? 'var(--ink-500)' : 'var(--ink-800)',
        },
    }, caseDocTitle(item.kind)),
    h('span', {
        style: { display: 'block', fontSize: '12.5px', marginTop: '2px', color: 'var(--ink-400)', lineHeight: '1.3' },
    },
    h('b', { style: { color: STATE_COLOR[item.state], fontWeight: '600' } }, caseDocStateWord(item.state)),
    meta ? ' · ' : null, meta || null));

    const actions = h('div', { style: { display: 'flex', gap: '6px', flexShrink: '0', alignItems: 'center' } });
    // РОВНО ОДНА заметная кнопка на весь список — у пункта, который сервер
    // назвал следующим (next_kind). Остальные действия одинаково спокойные.
    if (isNext) {
        actions.appendChild(actionBtn(tr('Продолжить'), { primary: true, icon: 'ArrowRight', onclick: () => onDoc(item.kind, 'edit', item.draft_id) }));
    } else if (item.state === 'overdue') {
        actions.appendChild(actionBtn(tr('Оформить'), { icon: 'Plus', onclick: () => onDoc(item.kind, 'edit', item.draft_id) }));
    } else if (item.state === 'draft') {
        actions.appendChild(actionBtn(tr('Дописать'), { icon: 'Edit', onclick: () => onDoc(item.kind, 'edit', item.draft_id) }));
    } else if (item.state === 'published') {
        actions.appendChild(actionBtn(tr('Исправить'), { icon: 'Edit', onclick: () => onDoc(item.kind, 'correct', item.review_id) }));
    } else if (item.due_rule === 'period') {
        actions.appendChild(actionBtn(tr('Создать запись'), { icon: 'Plus', onclick: () => onDoc(item.kind, 'edit', item.draft_id) }));
    }

    const rows = [h('div', {
        style: {
            display: 'flex', alignItems: 'flex-start', gap: '10px',
            padding: '9px 8px 9px 12px', borderRadius: '10px', position: 'relative',
            background: isNext ? 'var(--primary-50)' : 'transparent',
        },
    },
    h('span', {
        style: {
            position: 'absolute', left: '2px', top: '9px', bottom: '9px', width: '3px',
            borderRadius: '3px', background: STATE_COLOR[item.state],
        },
    }),
    stateDot(item), open, actions)];

    if (item.revision_count > 1) {
        const { toggle, list } = revisionsBlock(item, onDoc);
        actions.appendChild(toggle);
        rows.push(list);
    }
    return h('li', { style: { listStyle: 'none' } }, ...rows);
}

/**
 * ВИД ЧЕК-ЛИСТА — чистая функция от ответа сервера.
 *
 * Ничего не грузит и ничего не решает: сроки, состояния, «что следующее» и
 * «чего не хватает» приходят готовыми (`admission_case_docs`). Здесь —
 * названия, порядок на экране и КНОПКИ, до которых можно дойти пальцем и
 * табом.
 *
 * @param {{state:object, filter:string, onFilter:function,
 *          onDoc:function, onAssemble:function}} opts
 *        onDoc(kind, mode, reviewId) — открыть/написать/исправить документ.
 *        Вид не открывает окна сам: окна документов живут в
 *        admission-modal.js, и импортировать его отсюда значило бы завести
 *        круговую зависимость между двумя половинами одного экрана.
 */
export function caseDocsView({ state, filter = 'all', onFilter = null, onDoc, onAssemble = null } = {}) {
    const box = h('div', { style: { display: 'grid', gap: '0' } });
    {
        // Умолчания, а не доверие: панель рисуется в чужой карточке
        // (admission-modal.js), и ответ без прогресса или без списка обязан
        // дать пустой чек-лист, а не уронить всю карточку госпитализации.
        const p = Object.assign({ done: 0, total: 0, overdue: 0, draft: 0 }, state.progress || {});

        box.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            Icon('Doc', { size: 16 }),
            h('b', { style: { fontSize: '13.5px' } }, tr('Документы истории болезни')),
        ));

        box.appendChild(h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '7px', margin: '10px 0 0' } },
            h('span', { style: { fontSize: '17px', fontWeight: '700' } }, trf('{done}/{total}', { done: p.done, total: p.total })),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('оформлено')),
            p.overdue > 0
                ? h('span', {
                    style: {
                        marginLeft: 'auto', fontSize: '12.5px', fontWeight: '600', color: 'var(--crit-700)',
                        background: 'var(--crit-50)', borderRadius: '20px', padding: '2px 9px',
                    },
                }, trf('просрочено: {n}', { n: p.overdue }))
                : null,
        ));
        box.appendChild(progressBar(p));

        // Фильтры — сегменты с aria-pressed: до каждого можно дойти табом, и
        // чтение с экрана называет, какой из них выбран.
        const seg = h('div', {
            role: 'group', 'aria-label': tr('Фильтр документов'),
            style: { display: 'flex', gap: '4px', margin: '12px 0 4px' },
        }, ...CASE_FILTERS.map(([key, label]) => h('button', {
            class: 'btn btn-sm' + (filter === key ? ' btn-primary' : ''),
            type: 'button', 'aria-pressed': filter === key ? 'true' : 'false',
            onclick: () => onFilter && onFilter(key),
        }, tr(label), key === 'overdue' && p.overdue ? ' · ' + p.overdue : null)));
        box.appendChild(seg);

        const groupLabel = (text) => h('div', {
            style: {
                fontSize: '12.5px', fontWeight: '600', letterSpacing: '.4px', textTransform: 'uppercase',
                color: 'var(--ink-400)', margin: '12px 2px 2px',
            },
        }, text);

        const required = caseVisibleItems(state, filter);
        box.appendChild(groupLabel(tr('Обязательные · по регламенту')));
        if (required.length) {
            box.appendChild(h('ul', { style: { listStyle: 'none', margin: '0', padding: '0' } },
                ...required.map((it) => itemRow(it, state, onDoc))));
        } else {
            box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 2px' } },
                filter === 'overdue' ? tr('Просроченных документов нет.') : tr('Всё оформлено.')));
        }

        const other = (state.other || []).filter((i) => caseFilterMatch(filter, i));
        box.appendChild(groupLabel(tr('Прочие документы')));
        if (other.length) {
            box.appendChild(h('ul', { style: { listStyle: 'none', margin: '0', padding: '0' } },
                ...other.map((it) => itemRow(it, state, onDoc))));
        } else {
            box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '6px 2px' } },
                tr('Ничего не подшито.')));
        }
        box.appendChild(h('button', {
            class: 'btn btn-sm', type: 'button', style: { marginTop: '6px' },
            onclick: () => onDoc('other', 'edit', null),
        }, Icon('Plus', { size: 13 }), ' ', tr('Подшить документ')));

        // Хирургический блок молчит, пока не появился первый документ операции.
        // Сказать об этом один раз честнее, чем держать три вечно серых пункта.
        if (!state.surgical) {
            box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px', lineHeight: '1.45' } },
                tr('Осмотр анестезиолога, предоперационный эпикриз и протокол операции появятся в списке, как только будет написан первый из них.')));
        }

        // ─── Подвал: правило выписки и сборка ────────────────────────────────
        const gate = state.discharge_gate || { blocking: [], incomplete: [] };
        const foot = h('div', {
            style: {
                marginTop: '12px', borderTop: '1px solid var(--ink-100)', paddingTop: '10px',
                display: 'grid', gap: '8px',
            },
        });
        foot.appendChild(h('div', {
            style: {
                display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px', lineHeight: '1.45',
                color: gate.blocked ? 'var(--crit-700)' : 'var(--ink-500)',
            },
        }, Icon(gate.blocked ? 'Warning' : 'Info', { size: 14 }), h('span', null, caseGateText(state))));
        if ((gate.incomplete || []).length) {
            foot.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', lineHeight: '1.45' } },
                trf('Не оформлено из обязательного набора: {list}', { list: caseMissingTitles(state).join(', ') })));
        }
        foot.appendChild(h('button', {
            class: 'btn btn-sm', type: 'button', style: { justifySelf: 'start' },
            onclick: () => onAssemble && onAssemble(),
        }, Icon('Print', { size: 13 }), ' ', tr('Собрать историю болезни')));
        box.appendChild(foot);
    }
    return box;
}

/**
 * Панель чек-листа: тот же вид, но со своей загрузкой и перерисовкой.
 *
 * Разделение не косметическое: `caseDocsView` — чистая функция от ответа
 * сервера, и её можно проверить без браузера и без сети
 * (__tests__/case-docs.test.mjs рисует её на минимальном DOM и считает
 * кнопки). Панель, которая сама ходит в сеть, так не проверяется вовсе.
 *
 * @param {{admissionId:number, onDoc:function, onAssemble:function}} opts
 *        onDoc(kind, mode, reviewId) — открыть/написать/исправить документ.
 *        Панель не открывает окна сама: окна документов живут в
 *        admission-modal.js, и импортировать его отсюда значило бы завести
 *        круговую зависимость между двумя половинами одного экрана.
 */
export function caseDocsPanel({ admissionId, onDoc, onAssemble = null } = {}) {
    const box = h('div', { class: 'card', style: { padding: '12px 14px' } });
    let filter = 'all';
    let state = null;

    const paint = () => {
        clear(box);
        if (!state) {
            box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Загрузка…')));
            return;
        }
        box.appendChild(caseDocsView({
            state,
            filter,
            onFilter: (key) => { filter = key; paint(); },
            onDoc,
            onAssemble: onAssemble || (() => assembleCaseFile(admissionId)),
        }));
    };

    paint();
    const reload = async () => {
        const { data, error } = await supabase.rpc('admission_case_docs', { admission_id: admissionId });
        if (error) {
            clear(box);
            // Право читать историю болезни есть не у всех, кто открывает
            // карточку (регистратура её не видит — READ_ROLES в
            // rpc/inpatient-reviews.js). Отказ по роли не ломает карточку и не
            // кричит: панели просто нет — тот же приём, что у лечебного стола.
            // А вот СБОЙ обязан назвать себя: пустое место на месте документов
            // читается как «документов нет», и это ложь другого рода.
            box.style.display = error.code === 'forbidden' ? 'none' : '';
            if (error.code !== 'forbidden') {
                box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    trf('Документы истории болезни не загрузились: {msg}', { msg: error.message })));
            }
            return;
        }
        box.style.display = '';
        // Ответ без списка документов — это НЕ пустой чек-лист, а неответ
        // (устаревший сервер, заглушка, обрезанный прокси). Рисовать по нему
        // «0/0 оформлено» значило бы соврать про историю болезни в самом
        // спокойном виде: цифрами.
        if (!data || !Array.isArray(data.items)) { box.style.display = 'none'; return; }
        state = data;
        paint();
    };
    reload();
    return { el: box, reload, current: () => state };
}

// ---------------------------------------------------------------------------
// Сборка истории болезни в один файл
// ---------------------------------------------------------------------------

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PART_TITLES = [
    ['complaints', 'Жалобы'],
    ['objective', 'Объективно'],
    ['diagnosis', 'Диагноз'],
    ['plan', 'План обследования и лечения'],
    ['body', 'Дополнительно'],
];

/**
 * ПЕЧАТНЫЙ ФАЙЛ ИСТОРИИ БОЛЕЗНИ.
 *
 * Собирается тем же способом, что лист назначений (mar-sheet.js) и печатные
 * бланки (doc-variants.js / shared/doc-render.js): отдельный документ со своим
 * <style>, шрифт — из общего модуля печати, автопечать по загрузке шрифтов.
 * Свой механизм печати здесь был бы четвёртым в продукте.
 *
 * Функция ЧИСТАЯ (строка на входе — строка на выходе): её проверяет
 * __tests__/case-docs.test.mjs без браузера.
 */
/* type-scale-exempt-start: печатный документ A4 — метрики бумаги, а не экрана (то же исключение, что у mar-sheet.js и doc-variants.js) */
export function caseFilePrintHtml(file, { fontFaceCss = '' } = {}) {
    const c = (file && file.cover) || {};
    const documents = (file && file.documents) || [];
    const gaps = (file && file.gaps) || [];

    const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v || '—')}</span></div>`;
    const dt = (iso) => (iso ? fmtDateTime(iso) : '');

    const cover = `
<section class="cover">
  <h1>${esc(tr('История болезни'))}</h1>
  <p class="lead">${esc(c.patient_name || '')}${c.patient_mrn ? ' · ' + esc(c.patient_mrn) : ''}</p>
  <div class="grid">
    ${kv(tr('Номер госпитализации'), c.admission_no)}
    ${kv(tr('Отделение'), c.department)}
    ${kv(tr('Палата · койка'), [c.ward_name, c.bed_code].filter(Boolean).join(' · '))}
    ${kv(tr('Дата рождения'), c.patient_birth_date)}
    ${kv(tr('Поступление'), dt(c.admitted_at))}
    ${kv(tr('Выписка'), c.discharged_at ? dt(c.discharged_at) : dt(c.planned_discharge_at))}
    ${kv(tr('Лечащий врач'), [c.attending_name, c.attending_specialty].filter(Boolean).join(' · '))}
    ${kv(tr('Собрал'), [c.assembled_by, dt(c.assembled_at)].filter(Boolean).join(' · '))}
  </div>
  ${gaps.length ? `<div class="gaps"><b>${esc(tr('В комплекте не хватает:'))}</b><ul>${
      gaps.map((k) => `<li>${esc(caseDocTitle(k))}</li>`).join('')
  }</ul></div>` : `<p class="ok">${esc(tr('Обязательный комплект документов полный.'))}</p>`}
  ${file && file.drafts_excluded
      ? `<p class="note">${esc(trf('Черновиков не включено: {n}. Черновик — не документ и в историю болезни не подшивается.', { n: file.drafts_excluded }))}</p>`
      : ''}
</section>`;

    const body = documents.map((d, i) => {
        const parts = PART_TITLES
            .filter(([key]) => String(d[key] || '').trim())
            .map(([key, label]) => `<div class="part"><div class="pl">${esc(tr(label))}</div><div class="pv">${esc(d[key])}</div></div>`)
            .join('');
        const sign = [d.author_name, d.published_at ? fmtDateTime(d.published_at) : ''].filter(Boolean).join(' · ');
        return `
<section class="doc">
  <h2><span class="no">${i + 1}</span>${esc(caseDocTitle(d.kind))}${
      d.revision_count > 1 ? `<span class="rev">${esc(trf('редакция {n}', { n: d.revision_count }))}</span>` : ''
  }</h2>
  ${parts || `<div class="part"><div class="pv empty">${esc(tr('Текст документа не заполнен.'))}</div></div>`}
  <div class="sign">${esc(sign)}</div>
</section>`;
    }).join('');

    return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(tr('История болезни'))} · ${esc(c.admission_no || '')}</title>
<style>
${fontFaceCss}
@page { size: A4; margin: 14mm; }
body { font-family: 'Onest', -apple-system, 'Segoe UI', Roboto, sans-serif; color: #16232b; margin: 0; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
.lead { font-size: 16px; font-weight: 600; margin: 0 0 16px; }
.cover { border-bottom: 2px solid #16232b; padding-bottom: 14px; margin-bottom: 18px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; }
.kv { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px dotted #d3d9de; font-size: 13px; }
.kv .k { color: #55636d; min-width: 150px; }
.kv .v { font-weight: 600; }
.gaps { margin-top: 14px; border: 1px solid #e0b4b4; background: #fdf3f3; border-radius: 8px; padding: 10px 12px; font-size: 13px; }
.gaps ul { margin: 6px 0 0; padding-left: 18px; }
.ok { margin-top: 14px; font-size: 13px; color: #047857; }
.note { margin-top: 8px; font-size: 12px; color: #55636d; }
.doc { page-break-inside: avoid; margin-bottom: 18px; }
.doc h2 { font-size: 15px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #d3d9de; padding-bottom: 5px; }
.doc h2 .no { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #16232b; color: #fff; font-size: 11px; }
.doc h2 .rev { margin-left: auto; font-size: 11px; font-weight: 600; color: #b45309; }
.part { display: flex; gap: 10px; padding: 3px 0; font-size: 13px; line-height: 1.5; }
.part .pl { min-width: 150px; color: #55636d; }
.part .pv { flex: 1; white-space: pre-wrap; }
.part .pv.empty { color: #7a8892; font-style: italic; }
.sign { margin-top: 6px; font-size: 12px; color: #55636d; text-align: right; }
</style></head><body>
${cover}
${body || `<p class="note">${esc(tr('Опубликованных документов пока нет.'))}</p>`}
<script>window.onload=function(){(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){try{window.focus();window.print();}catch(e){}});};</scr` + `ipt>
</body></html>`;
}
/* type-scale-exempt-end */

/** Спросить сборку у сервера и открыть её печатным окном. */
export async function assembleCaseFile(admissionId) {
    const { data, error } = await supabase.rpc('admission_case_file', { admission_id: admissionId });
    if (error) { toast(error.message || tr('Не удалось собрать историю болезни.'), 'fail'); return null; }
    const { PRINT_FONT_FACE_CSS } = await import('../../shared/print-fonts.js');
    const html = caseFilePrintHtml(data, { fontFaceCss: PRINT_FONT_FACE_CSS });
    const w = window.open('', '_blank');
    if (!w) { toast(tr('Разрешите всплывающие окна для печати.'), 'fail'); return null; }
    w.document.write(html);
    w.document.close();
    return data;
}
