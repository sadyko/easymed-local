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
import { sanitizeStoredHtml } from '../../shared/rich-text.js';   // CASE_DOC_A4_V1 — печать разметки документа
import { h, Icon, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { titleSheetPrintSection, titleSheetPrintCss, papersSummary } from './title-sheet-print.js';   // TITLE_SHEET_V1 / INPATIENT_DOCS_V1

// ---------------------------------------------------------------------------
// Словарь названий
// ---------------------------------------------------------------------------
// Порядок и состав задаёт СЕРВЕР (CASE_DOC_SET); здесь только имена. Список
// покрыт тестом на полноту (__tests__/case-docs.test.mjs): род документа,
// приехавший с сервера без имени, нарисовался бы пустой строкой.
export const CASE_DOC_TITLE = {
    title:       'Титульный лист',   // TITLE_SHEET_V1 — документ медсестры, первой строкой
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

// Титульный лист приезжает в чек-листе первой строкой, но в справочнике
// набора (case_doc_types) его нет: он часть самой госпитализации, а не
// документ, который клиника вольна не вести. Убрать его из набора нечем.
const TITLE_KIND = 'title';

/**
 * Имя документа.
 *
 * CASE_DOC_SET_V2 — у СВОЕГО рода клиники имя приходит с сервера, и переводить
 * его некому: клиника назвала документ своими словами, и подменять их словарём
 * значило бы показать ей чужое название. У встроенного рода имя живёт в
 * словаре и переводится на три языка.
 *
 * @param {string} kind род записи
 * @param {string} [title] имя, пришедшее с сервера (у встроенных пусто)
 */
export function caseDocTitle(kind, title) {
    const own = String(title === null || title === undefined ? '' : title).trim();
    if (own) return own;
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
    // CASE_DOC_SET_OPEN_V1 — эпикриз отпёрли, и клиника вправе убрать его из
    // набора. Тогда выписку не держит НИЧЕГО, и говорить «эпикриз оформлен»
    // значит отчитываться о документе, которого у клиники нет.
    if (!blocked) {
        const kept = ((state && state.items) || []).some((it) => it && it.kind === 'discharge');
        return kept
            ? tr('Выписной эпикриз оформлен — заявку на выписку примут.')
            : tr('Выписной эпикриз убран из набора — заявку на выписку примут.');
    }
    return blocked.reason === 'draft'
        ? tr('Заявку на выписку не примут: выписной эпикриз сохранён черновиком — его нужно опубликовать.')
        : tr('Заявку на выписку не примут: выписной эпикриз ещё не написан.');
}

/** Названия недооформленных документов — тот же список, что у сервера. */
export function caseMissingTitles(state) {
    // CASE_DOC_SET_V2 — имя берётся у самого пункта: у своего рода клиники его
    // больше взять неоткуда. И НЕ .map(caseDocTitle) — второй аргумент map это
    // индекс, и он приезжал бы вместо имени.
    const items = [...((state && state.items) || []), ...((state && state.other) || [])];
    const titleOf = (kind) => (items.find((i) => i && i.kind === kind) || {}).title || '';
    return ((state && state.discharge_gate && state.discharge_gate.incomplete) || [])
        .map((kind) => caseDocTitle(kind, titleOf(kind)));
}

// ---------------------------------------------------------------------------
// Состав набора — из самого чек-листа
// ---------------------------------------------------------------------------
// CASE_DOC_SET_INLINE_V1 (2026-09-09) — владелец: «remove this shit completely,
// and add to the kasallik tarixi hujjatlari a buttons near the documents cards.
// and in the bottom a card with free fields».
//
// Отдельная панель «Состав истории болезни» ушла целиком: она стояла в той же
// колонке под чек-листом и перечисляла ТЕ ЖЕ документы теми же словами. Здесь
// остались только два действия, которые она делала, — и вызываются они из
// строк самого списка.

/** Состав правят те же, кто назначает лечащего врача (DOC_TYPE_WRITE_ROLES). */
export function canEditDocSet() {
    const u = (typeof window !== 'undefined' && window.easymed
        && window.easymed.state && window.easymed.state.user) || null;
    if (!u) return false;
    const role = String(u.role || '').toLowerCase();
    return !!u.is_admin || u.is_super_admin === true || role === 'admin' || role === 'head_doctor';
}

/**
 * Убрать документ из набора клиники.
 *
 * Убрать — НЕ удалить: написанные этим родом записи остаются в историях болезни
 * и печатаются, из чек-листа уходит только пункт. Об обратной дороге сказано
 * здесь же, в момент, когда она понадобится: другого списка убранного на экране
 * больше нет.
 *
 * @returns {Promise<boolean>} правда, если состав изменился
 */
export async function caseDocSetDrop(kind, name) {
    const { error } = await supabase.rpc('case_doc_type_set_active', { kind, active: false });
    if (error) { toast(error.message || tr('Не удалось изменить состав набора.'), 'fail'); return false; }
    toast(trf('«{name}» убран из набора. Чтобы вернуть — впишите это название внизу списка.', { name }), 'ok');
    return true;
}

/**
 * Документы, УБРАННЫЕ из набора.
 *
 * Владелец: «when i am deleting the documents we gave should disappear but go
 * inactive and added when necessary». Убранный документ не исчезает бесследно:
 * он стоит в конце списка бледной строкой, и вернуть его — одно нажатие, а не
 * память о том, как он назывался.
 *
 * Чек-лист их не присылает (admission_case_docs — про ЭТУ госпитализацию и
 * только про действующий набор), поэтому убранные спрашиваются справочником.
 * Отказ по праву — не беда: тогда и кнопок правки состава нет.
 */
export async function loadDocTypeSet() {
    const { data, error } = await supabase.rpc('case_doc_types_list', {});
    if (error || !data || !Array.isArray(data.types)) return [];
    return data.types.map((t) => ({
        kind: t.kind,
        name: caseDocTitle(t.kind, t.title),
        active: !!t.active,
        // CASE_DOC_RENAME_V1 — переименовать и удалить можно ТОЛЬКО свой род
        // клиники: у встроенного имя живёт в словаре и переводится на три
        // языка, а удалить его нельзя вовсе.
        own: !t.builtin,
        used: Number(t.used) || 0,
    }));
}

/**
 * Переименовать свой документ.
 *
 * Шлём ТОЛЬКО имя: правило срока и часы экран не спрашивал и не знает, а
 * сервер оставляет их прежними (case-doc-types.js, CASE_DOC_RENAME_V1).
 */
export async function caseDocSetRename(kind, title) {
    const name = String(title || '').trim();
    if (!name) return false;
    const { error } = await supabase.rpc('case_doc_type_save', { kind, title: name });
    if (error) { toast(error.message || tr('Не удалось изменить состав набора.'), 'fail'); return false; }
    toast(trf('Документ переименован: {name}.', { name }), 'ok');
    return true;
}

/**
 * Удалить свой документ насовсем.
 *
 * Сервер откажет, если им уже написаны записи, — и это не придирка: удалённый
 * род оставил бы написанное без имени. Отказ показываем словами сервера.
 */
export async function caseDocSetDelete(kind, name) {
    const { error } = await supabase.rpc('case_doc_type_delete', { kind });
    if (error) { toast(error.message || tr('Не удалось изменить состав набора.'), 'fail'); return false; }
    toast(trf('«{name}» удалён.', { name }), 'ok');
    return true;
}

/** Вернуть убранный документ в набор — той же кнопкой, что и убрали. */
export async function caseDocSetRestore(kind, name) {
    const { error } = await supabase.rpc('case_doc_type_set_active', { kind, active: true });
    if (error) { toast(error.message || tr('Не удалось изменить состав набора.'), 'fail'); return false; }
    toast(trf('«{name}» возвращён в набор.', { name }), 'ok');
    return true;
}

/**
 * Завести документ по имени — ИЛИ ВЕРНУТЬ убранный, если имя совпало.
 *
 * Возврата иначе не было бы вовсе: убранный документ уходит из чек-листа, а
 * список убранного экран больше не показывает. Совпадение ищется по тому
 * имени, которое человек видел в списке, — у встроенного рода это перевод, у
 * своего собственное имя.
 *
 * @returns {Promise<boolean>} правда, если состав изменился
 */
export async function caseDocSetAdd(title) {
    const name = String(title || '').trim();
    if (!name) return false;
    const norm = (v) => String(v || '').trim().toLowerCase();

    const { data, error } = await supabase.rpc('case_doc_types_list', {});
    if (error) { toast(error.message || tr('Не удалось изменить состав набора.'), 'fail'); return false; }
    const gone = ((data && data.types) || [])
        .filter((t) => !t.active)
        .find((t) => norm(caseDocTitle(t.kind, t.title)) === norm(name));

    if (gone) {
        const back = await supabase.rpc('case_doc_type_set_active', { kind: gone.kind, active: true });
        if (back.error) { toast(back.error.message || tr('Не удалось изменить состав набора.'), 'fail'); return false; }
        toast(trf('«{name}» возвращён в набор.', { name: caseDocTitle(gone.kind, gone.title) }), 'ok');
        return true;
    }

    // Свой документ заводится БЕЗ СРОКА: он в наборе и спрашивается, но
    // просроченным не висит. Срок — отдельное решение, и спрашивать его в тот
    // момент, когда человек просто заводит бумагу, значит спрашивать всегда.
    const { error: saveErr } = await supabase.rpc('case_doc_type_save', {
        title: name, due_rule: 'none', due_hours: null, block: '',
    });
    if (saveErr) { toast(saveErr.message || tr('Не удалось изменить состав набора.'), 'fail'); return false; }
    toast(trf('«{name}» добавлен в набор.', { name }), 'ok');
    return true;
}

// ---------------------------------------------------------------------------
// Что показывается
// ---------------------------------------------------------------------------
// CASE_DOC_SET_INLINE_V1 (2026-09-09) — ФИЛЬТРОВ БОЛЬШЕ НЕТ. Владелец: «remove
// options». Три сегмента («все», «к заполнению», «просрочено») прятали часть
// списка ради списка в десять строк, который виден целиком и так. А спрятанный
// пункт чек-листа — это пункт, о котором забыли: чек-лист затем и существует,
// чтобы показывать ВСЁ, чего от истории болезни ждут.

/** Пункты, которые вообще показываются: неприменимый блок не место занимает. */
export function caseVisibleItems(state) {
    return ((state && state.items) || []).filter((i) => i.applies);
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
        onclick: () => onDoc(item.kind, 'view', rev.id, caseDocTitle(item.kind, item.title)),
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

function itemRow(item, state, onDoc, activeKind = null, onDrop = null, onRename = null) {
    // CASE_DOC_OWN_NAME_V1 — имя считается ОДИН раз и едет в каждое открытие:
    // у своего рода клиники его больше взять неоткуда, и лист подписывался
    // «Прочий документ» вместо того, как документ назвали.
    const docName = caseDocTitle(item.kind, item.title);
    const isNext = item.state === 'next';
    // CASE_WORKSPACE_V1 — на рабочем экране документ открыт СПРАВА, и слева
    // обязано быть видно, какой именно: иначе после третьей бумаги врач не
    // помнит, что он сейчас правит. В окне (activeKind не передан) подсветки
    // нет — там открытый документ и так закрывает собой всё.
    const isOpen = !!activeKind && item.kind === activeKind;
    const meta = item.state === 'published' ? caseDoneText(item) : caseDueText(item, state);

    const open = h('button', {
        class: 'btn-plain', type: 'button',
        style: {
            flex: '1', minWidth: '0', textAlign: 'left', background: 'none', border: 'none',
            padding: '0', cursor: 'pointer', font: 'inherit', color: 'inherit',
        },
        // CASE_DOC_OWN_NAME_V1 — имя едет вместе с родом: у своего рода клиники
        // его больше взять неоткуда, и лист подписывался «Прочий документ».
        onclick: () => onDoc(item.kind, item.state === 'published' ? 'view' : 'edit',
            item.review_id || item.draft_id || null, docName),
    },
    h('span', {
        class: 'cd-row-n',
        style: {
            display: 'block', fontSize: '13.5px', lineHeight: '1.35',
            fontWeight: item.state === 'pending' ? '500' : '600',
            color: item.state === 'pending' ? 'var(--ink-500)' : 'var(--ink-800)',
        },
    }, caseDocTitle(item.kind, item.title)),
    );

    // CASE_ROW_NAME_ONLY_V1 — владелец: «we dont need information in the card
    // only name and button». В карточке остаётся название и действие; состояние
    // по-прежнему названо цветом рельса, кружком-иконкой и — для читалки и
    // подсказки мыши — словами в aria-label и title строки.
    const stateLine = [caseDocStateWord(item.state), meta].filter(Boolean).join(' · ');
    open.setAttribute('title', caseDocTitle(item.kind, item.title) + (stateLine ? ' — ' + stateLine : ''));
    open.setAttribute('aria-label', caseDocTitle(item.kind, item.title) + (stateLine ? ': ' + stateLine : ''));


    // CASE_DOC_RENAME_V1 — ИМЯ ПРАВИТСЯ В САМОЙ СТРОКЕ. Владелец: «why i cant
    // delete or edit added documents?». Кнопка-имя подменяется полем на месте:
    // окно ради одного поля — это два лишних нажатия и потерянное из виду
    // место в списке.
    const slot = h('div', { class: 'cd-slot' }, open);
    const startRename = () => {
        const input = h('input', {
            type: 'text', class: 'cd-ren',
            'aria-label': trf('Название: {name}', { name: docName }),
        });
        // Значение — СВОЙСТВОМ, а не атрибутом: атрибут value задаёт лишь
        // исходное значение поля, и правка начиналась бы с пустой строки.
        input.value = docName;
        // Правка закрывается ОДИН раз. Иначе Esc отменял бы, а следующий за ним
        // blur — тут же сохранял отменённое; и Enter слал бы имя дважды, потому
        // что перерисовка списка уводит фокус с поля.
        let closed = false;
        const stop = () => { if (closed) return; closed = true; clear(slot); slot.appendChild(open); };
        const save = () => {
            if (closed) return;
            const value = String(input.value || '').trim();
            if (!value || value === docName) { stop(); return; }
            closed = true;
            onRename(item.kind, value);
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); stop(); }
        });
        input.addEventListener('blur', save);
        clear(slot);
        slot.appendChild(input);
        input.focus();
    };

    const actions = h('div', { style: { display: 'flex', gap: '6px', flexShrink: '0', alignItems: 'center' } });
    // РОВНО ОДНА заметная кнопка на весь список — у пункта, который сервер
    // назвал следующим (next_kind). Остальные действия одинаково спокойные.
    if (isNext) {
        actions.appendChild(actionBtn(tr('Продолжить'), { primary: true, icon: 'ArrowRight', onclick: () => onDoc(item.kind, 'edit', item.draft_id, docName) }));
    } else if (item.state === 'overdue') {
        actions.appendChild(actionBtn(tr('Оформить'), { icon: 'Plus', onclick: () => onDoc(item.kind, 'edit', item.draft_id, docName) }));
    } else if (item.state === 'draft') {
        actions.appendChild(actionBtn(tr('Дописать'), { icon: 'Edit', onclick: () => onDoc(item.kind, 'edit', item.draft_id, docName) }));
    } else if (item.state === 'published') {
        actions.appendChild(actionBtn(tr('Исправить'), { icon: 'Edit', onclick: () => onDoc(item.kind, 'correct', item.review_id, docName) }));
    } else if (item.due_rule === 'period') {
        actions.appendChild(actionBtn(tr('Создать запись'), { icon: 'Plus', onclick: () => onDoc(item.kind, 'edit', item.draft_id, docName) }));
    }
    // DIARY_ENTRY_DATE_V1 — владелец о дневнике: «one document which can be
    // added every day». Повторяющийся документ пишут КАЖДЫЙ ДЕНЬ, и «Новая
    // запись» у него есть всегда — в том числе когда сегодняшняя запись уже
    // сделана: иначе завтрашнюю нельзя завести, не дождавшись просрочки, а
    // единственная кнопка «Исправить» уводит переписывать вчерашнюю.
    //
    // review_id НЕ передаётся намеренно: новая запись начинается с чистого
    // листа, а не с чужого черновика.
    if (item.due_rule === 'period' && (item.state === 'published' || isNext)) {
        actions.appendChild(actionBtn(tr('Новая запись'), { icon: 'Plus', onclick: () => onDoc(item.kind, 'edit', null, docName) }));
    }

    const rows = [h('div', {
        style: {
            display: 'flex', alignItems: 'flex-start', gap: '10px',
            padding: '9px 8px 9px 12px', borderRadius: '10px', position: 'relative',
            // Открытый сейчас документ важнее «следующего по регламенту»: это
            // то, что человек делает прямо сейчас.
            background: isOpen ? 'var(--primary-100, #d6efe9)' : (isNext ? 'var(--primary-50)' : 'transparent'),
            boxShadow: isOpen ? 'inset 0 0 0 1px var(--primary-300)' : 'none',
        },
    },
    h('span', {
        style: {
            position: 'absolute', left: '2px', top: '9px', bottom: '9px', width: '3px',
            borderRadius: '3px', background: STATE_COLOR[item.state],
        },
    }),
    stateDot(item), slot, actions)];

    // CASE_DOC_SET_INLINE_V1 — СОСТАВ НАБОРА ПРАВИТСЯ ЗДЕСЬ ЖЕ, У СТРОКИ.
    //
    // Владелец: «add to the kasallik tarixi hujjatlari a buttons near the
    // documents cards». Отдельная панель «Состав истории болезни» стояла в той
    // же колонке и перечисляла ТЕ ЖЕ документы слово в слово — один список
    // дважды, и владелец видел его как дублирование. Кнопка стоит там, где на
    // документ и смотрят.
    //
    // «Убрать» — не «удалить»: написанные этим родом записи остаются в истории
    // болезни и печатаются, из чек-листа уходит только пункт.
    if (onRename) {
        actions.appendChild(h('button', {
            class: 'btn cd-step cd-ren-b', type: 'button',
            'aria-label': trf('Переименовать: {name}', { name: docName }),
            title: tr('Переименовать'),
            onclick: startRename,
        }, Icon('Edit', { size: 16 })));
    }

    if (onDrop) {
        const name = docName;
        actions.appendChild(h('button', {
            class: 'btn cd-step cd-drop', type: 'button',
            'aria-label': trf('Убрать из набора: {name}', { name }),
            title: tr('Убрать из набора'),
            onclick: () => onDrop(item.kind, name),
        }, Icon('Minus', { size: 16 })));
    }

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
 * @param {{state:object, onDoc:function, onAssemble:function, activeKind:string,
 *          onDrop:function, onAdd:function}} opts
 *        onDoc(kind, mode, reviewId) — открыть/написать/исправить документ.
 *        onDrop(kind, name) — убрать документ из набора клиники (может не быть:
 *        состав правят главный врач и администратор).
 *        onAdd(title) — завести документ в набор по имени.
 *        types[] — состав как справочник: {kind, name, active, own, used}.
 *        onRestore(kind, name) — вернуть убранный; onRename(kind, title) —
 *        переименовать свой; onDelete(kind, name) — удалить свой насовсем.
 *        Вид не открывает окна сам: окна документов живут в
 *        admission-modal.js, и импортировать его отсюда значило бы завести
 *        круговую зависимость между двумя половинами одного экрана.
 */
export function caseDocsView({ state, onDoc, onAssemble = null, activeKind = null,
    onDrop = null, onAdd = null, types = [], onRestore = null, onRename = null, onDelete = null } = {}) {
    // CASE_RAIL_FIT_V1 (2026-09-08) — ТРИ ЗОНЫ, А НЕ ОДНА СТОПКА.
    //
    // Владелец: «this section should fit in to a left panel. and user should
    // not scroll. only scroll in the list».
    //
    // Панель была одной стопкой в двадцать блоков: цифры, полоса, фильтры,
    // одиннадцать документов, «подшить», правило выписки, перечень
    // недооформленного — и «Собрать историю» под всем этим, то есть за краем
    // экрана. Чтобы нажать кнопку, ради которой список и заполняли, врач
    // уезжал страницей вниз и терял из виду сам список.
    //
    // Теперь зон три: шапка (сколько оформлено и фильтры) и подвал (правило
    // выписки) стоят на месте, а прокручивается ТОЛЬКО список документов.
    // Высоту зонам задаёт колонка (admin-views.css, .cw-rail): здесь только
    // разметка, потому что эта же панель рисуется и в карточке
    // госпитализации, где никакой высоты ей никто не навязывает и список
    // просто идёт во всю длину.
    const box = h('div', { class: 'cd-box', style: { display: 'flex', flexDirection: 'column' } });
    const head = h('div', { class: 'cd-head' });
    const list = h('div', { class: 'cd-list' });
    const foot = h('div', { class: 'cd-foot' });
    {
        // Умолчания, а не доверие: панель рисуется в чужой карточке
        // (admission-modal.js), и ответ без прогресса или без списка обязан
        // дать пустой чек-лист, а не уронить всю карточку госпитализации.
        const p = Object.assign({ done: 0, total: 0, overdue: 0, draft: 0 }, state.progress || {});

        head.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            Icon('Doc', { size: 16 }),
            h('b', { style: { fontSize: '13.5px' } }, tr('Документы истории болезни')),
        ));

        // CASE_ROW_NAME_ONLY_V1 — в узкой колонке строка ПЕРЕНОСИТСЯ, а не
        // вылезает за карточку (владелец показал обрезанный «просрочено»).
        head.appendChild(h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '7px', margin: '10px 0 0', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '17px', fontWeight: '700' } }, trf('{done}/{total}', { done: p.done, total: p.total })),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('оформлено')),
            p.overdue > 0
                ? h('span', {
                    style: {
                        marginLeft: 'auto', maxWidth: '100%', fontSize: '12.5px', fontWeight: '600', color: 'var(--crit-700)',
                        background: 'var(--crit-50)', borderRadius: '20px', padding: '2px 9px',
                    },
                }, trf('просрочено: {n}', { n: p.overdue }))
                : null,
        ));
        head.appendChild(progressBar(p));

        const groupLabel = (text) => h('div', {
            style: {
                fontSize: '12.5px', fontWeight: '600', letterSpacing: '.4px', textTransform: 'uppercase',
                color: 'var(--ink-400)', margin: '12px 2px 2px',
            },
        }, text);

        // Убрать из набора можно ТОЛЬКО пункт набора: титульный лист заводится
        // не справочником (он часть госпитализации), а «прочие документы» — уже
        // написанные бумаги этого пациента, и в наборе их нет вовсе.
        const dropOf = (it) => (onDrop && it.kind !== TITLE_KIND ? onDrop : null);
        // CASE_DOC_RENAME_V1 — переименовать можно только СВОЙ документ клиники:
        // у встроенного имя живёт в словаре и переводится на три языка, а
        // переписать его здесь значило бы навсегда прибить документ к одному.
        const ownKinds = new Set((types || []).filter((t) => t.own).map((t) => t.kind));
        const renameOf = (it) => (onRename && ownKinds.has(it.kind) ? onRename : null);

        const required = caseVisibleItems(state);
        list.appendChild(groupLabel(tr('Обязательные · по регламенту')));
        if (required.length) {
            list.appendChild(h('ul', { style: { listStyle: 'none', margin: '0', padding: '0' } },
                ...required.map((it) => itemRow(it, state, onDoc, activeKind, dropOf(it), renameOf(it)))));
        } else {
            list.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 2px' } },
                tr('Всё оформлено.')));
        }

        // CASE_DOC_LIST_QUIET_V1 (2026-09-09) — владелец показал на этот кусок:
        // «remove this please». Под списком стояли заголовок «Прочие
        // документы», строка «Ничего не подшито», кнопка «Подшить документ» и
        // абзац про хирургический блок — четыре элемента, из которых три
        // говорили о том, чего НЕТ. В колонке высотой в экран они отнимали
        // место у списка, ради которого её и открывают.
        //
        // Подшитые бумаги никуда не делись: как только они появляются, свой
        // заголовок и строки возвращаются. Молчит только пустота.
        // CASE_DOC_SET_BACK_V1 — УБРАННЫЙ ДОКУМЕНТ НЕ ИСЧЕЗАЕТ БЕССЛЕДНО.
        //
        // Владелец: «when i am deleting the documents we gave should disappear
        // but go inactive and added when necessary». Убранные стоят тут же, в
        // конце списка, бледной строкой с «+»: набор виден целиком — и что в
        // нём есть, и что из него убрали, — а вернуть документ можно нажатием.
        // CASE_FILE_QUIET_V1 — убранные документы за ОДНОЙ строкой со счётчиком:
        // клиника, убравшая шесть встроенных, получала шесть бледных строк в той
        // же колонке, что рабочий чек-лист. Возвращают документ изредка, читают
        // список всегда.
        const dropped = (types || []).filter((t) => !t.active);
        if (onRestore && dropped.length) {
            const gone = h('ul', { class: 'cd-gone-list', style: { listStyle: 'none', margin: '0', padding: '0' } });
            gone.hidden = true;
            const head2 = h('button', {
                class: 'cd-gone-h', type: 'button', 'aria-expanded': 'false',
                onclick: () => {
                    gone.hidden = !gone.hidden;
                    head2.setAttribute('aria-expanded', gone.hidden ? 'false' : 'true');
                },
            }, tr('Убраны из набора'), h('span', { class: 'cd-gone-n' }, String(dropped.length)));
            list.appendChild(head2);
            list.appendChild(gone);
            gone.appendChild(h('ul', { style: { listStyle: 'none', margin: '0', padding: '0' } },
                ...dropped.map((t) => h('li', { class: 'cd-gone' },
                    h('span', { class: 'cd-gone-n' }, t.name),
                    // CASE_DOC_RENAME_V1 — УДАЛИТЬ НАСОВСЕМ можно только свой
                    // документ, которым ещё ничего не написано: удалённый род
                    // оставил бы написанное без имени. У остальных корзины нет
                    // вовсе — кнопка, которая всегда откажет, это обещание, а
                    // не действие.
                    onDelete && t.own && !t.used
                        ? h('button', {
                            class: 'btn cd-step cd-del', type: 'button',
                            'aria-label': trf('Удалить насовсем: {name}', { name: t.name }),
                            title: tr('Удалить насовсем'),
                            onclick: () => onDelete(t.kind, t.name),
                        }, Icon('Trash', { size: 16 }))
                        : null,
                    h('button', {
                        class: 'btn cd-step cd-back', type: 'button',
                        'aria-label': trf('Вернуть в набор: {name}', { name: t.name }),
                        title: tr('Вернуть в набор'),
                        onclick: () => onRestore(t.kind, t.name),
                    }, Icon('Plus', { size: 16 }))))));
        }

        const other = state.other || [];
        if (other.length) {
            list.appendChild(groupLabel(tr('Прочие документы')));
            list.appendChild(h('ul', { style: { listStyle: 'none', margin: '0', padding: '0' } },
                ...other.map((it) => itemRow(it, state, onDoc, activeKind))));
        }

        // CASE_DOC_ADD_IN_LIST_V1 (2026-09-09) — СТРОКА СОЗДАНИЯ — ПОСЛЕДНЯЯ
        // СТРОКА СПИСКА. Владелец: «please transfer this in to a list». В
        // подвале она стояла ПОД правилом выписки и перечнем неоформленного,
        // то есть за двумя абзацами текста от списка, к которому относится.
        // Дочитал список до конца, такого документа нет — вот строка, чтобы
        // его завести.
        //
        // Имя — и всё: окно спрашивало имя, правило срока, часы и «только у
        // оперируемых» — четыре вопроса там, где у врача одно решение. Свой
        // документ заводится БЕЗ СРОКА: он в наборе и спрашивается, но
        // просроченным не висит.
        if (onAdd) {
            const input = h('input', {
                type: 'text', class: 'cd-add-in',
                placeholder: tr('Название нового документа'),
                'aria-label': tr('Название нового документа'),
            });
            const go = () => {
                const value = String(input.value || '').trim();
                if (!value) return;
                input.value = '';
                onAdd(value);
            };
            // Enter работает так же, как кнопка: строка одна, и тянуться к мыши
            // ради неё не за что.
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
            list.appendChild(h('div', { class: 'cd-add' }, input,
                h('button', {
                    class: 'btn btn-primary cd-add-go', type: 'button',
                    'aria-label': tr('Добавить документ в набор'),
                    // CASE_FILE_QUIET_V1 — объяснение в подсказке кнопки, а не
                    // строкой под полем: нужно оно раз в месяц, а висело всегда.
                    title: tr('Документ встанет в набор всех историй болезни.'),
                    onclick: go,
                    // Знак «плюс» из набора иконок и СЛОВО рядом: голый плюс на
                    // кнопке не говорит, что именно он добавит.
                }, Icon('Plus', { size: 16 }), ' ', tr('Добавить'))));
        }

        // ─── Подвал: правило выписки и сборка ────────────────────────────────
        const gate = state.discharge_gate || { blocking: [], incomplete: [] };
        Object.assign(foot.style, {
            marginTop: '12px', borderTop: '1px solid var(--ink-100)', paddingTop: '10px',
            display: 'grid', gap: '8px',
        });
        foot.appendChild(h('div', {
            style: {
                display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px', lineHeight: '1.45',
                color: gate.blocked ? 'var(--crit-700)' : 'var(--ink-500)',
            },
        }, Icon(gate.blocked ? 'Warning' : 'Info', { size: 14 }), h('span', null, caseGateText(state))));
        // CASE_FILE_QUIET_V1 (2026-09-10) — ПЕРЕЧЕНЬ НЕДООФОРМЛЕННОГО УБРАН.
        // Он повторял словами тот самый список, что стоит строкой выше: там
        // каждый ненаписанный документ уже красный, с красным рельсом и
        // значком. Три способа сказать одно — это не втрое понятнее.
        // caseMissingTitles() жив: им пользуется карточка госпитализации, где
        // списка документов нет вовсе.
        // На рабочем экране сборка стоит в шапке (onAssemble не передан):
        // вторая такая же кнопка в подвале списка шагов означала бы, что их две
        // разные — а она одна.
        if (onAssemble) {
            foot.appendChild(h('button', {
                class: 'btn btn-sm', type: 'button', style: { justifySelf: 'start' },
                onclick: () => onAssemble(),
            }, Icon('Print', { size: 13 }), ' ', tr('Собрать историю болезни')));
        }
        box.appendChild(head);
        box.appendChild(list);
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
    let state = null;
    let types = [];

    const paint = () => {
        clear(box);
        if (!state) {
            box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Загрузка…')));
            return;
        }
        // CASE_DOC_SET_INLINE_V1 — состав правят те же, кто назначает лечащего
        // врача (DOC_TYPE_WRITE_ROLES на сервере). Палатному врачу кнопок не
        // показываем: кнопка, которая всегда откажет, — обещание, а не действие.
        const mayEdit = canEditDocSet();
        box.appendChild(caseDocsView({
            state,
            onDoc,
            onAssemble: onAssemble || (() => assembleCaseFile(admissionId)),
            onDrop: mayEdit ? async (kind, name) => { if (await caseDocSetDrop(kind, name)) await reload(); } : null,
            onAdd: mayEdit ? async (title) => { if (await caseDocSetAdd(title)) await reload(); } : null,
            types,
            onRestore: mayEdit ? async (kind, name) => { if (await caseDocSetRestore(kind, name)) await reload(); } : null,
            onRename: mayEdit ? async (kind, title) => { if (await caseDocSetRename(kind, title)) await reload(); } : null,
            onDelete: mayEdit ? async (kind, name) => { if (await caseDocSetDelete(kind, name)) await reload(); } : null,
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
        // Убранные — вторым запросом и ТОЛЬКО тем, кто правит состав: остальным
        // они на экране не нужны, а лишний запрос у постели стоит времени.
        types = canEditDocSet() ? await loadDocTypeSet() : [];
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
// FORM_003_FILL_PAGE_V1 — .after-cover несёт page-break-before: документы
// начинаются с новой страницы, а титульный лист её НЕ ЗАКАНЧИВАЕТ. Разрыв
// после листа срабатывал всегда и рождал пустую вторую страницу там, где
// документов ещё нет.
export function caseFilePrintHtml(file, { fontFaceCss = '' } = {}) {
    const c = (file && file.cover) || {};
    const documents = (file && file.documents) || [];

    const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v || '—')}</span></div>`;
    const dt = (iso) => (iso ? fmtDateTime(iso) : '');

    // CASE_FILE_COVER_V2 — списка «В комплекте не хватает» на обложке больше
    // нет (владелец: «remove this from the list»). Пробелы комплекта — рабочая
    // подсказка экрана документов (caseGateText / caseMissingTitles), а не
    // содержание подшитой истории: на бумаге перечень того, чего НЕТ, читался
    // как часть документа и пугал того, кому историю выдают на руки.
    const draftsHtml = file && file.drafts_excluded
        ? `<p class="note">${esc(trf('Черновиков не включено: {n}. Черновик — не документ и в историю болезни не подшивается.', { n: file.drafts_excluded }))}</p>`
        : '';
    // TITLE_SHEET_CLEAN_V1 — «Собрал: такой-то, тогда-то» на бумаге не
    // печатается (владелец: «we should remove from the bottom of the document
    // this informations»). Кто нажал кнопку сборки — служебный след, а не
    // содержание истории болезни; он остаётся в базе и на экране документов.
    // На старой обложке (снимки без титульного листа) строка сохранена: те
    // истории уже подшиты именно такими, и менять их задним числом нечестно.

    // Прежняя обложка — для снимков, собранных ДО титульного листа: у них
    // title_sheet нет, и печататься они должны как печатались.
    const legacyCover = `
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
  ${draftsHtml}
</section>`;

    // TITLE_SHEET_V1 — первая страница собранной истории — титульный лист по
    // бланку 003, ЦЕЛЫМ листом A4 (FORM_003_A4_V1: .ts занимает страницу, подпись
    // прижата к низу); документы начинаются со следующей страницы.
    const cover = file && file.title_sheet
        ? titleSheetPrintSection(file.title_sheet, { extra: draftsHtml })
        : legacyCover;

    const body = documents.map((d, i) => {
        // CASE_DOC_A4_V1 — разделы документа написаны форматируемым текстом, и
        // на бумагу они идут РАЗМЕТКОЙ: экранированный HTML печатался бы
        // тегами вместо жирного и списков. Диагноз — простой текст, он и
        // экранируется. Санитария та же, что на сервере при сохранении.
        // CASE_DOC_FREE_SEC_V1 — подпись раздела берётся ИЗ ДОКУМЕНТА, если он
        // её переименовал: бумага обязана читаться так, как её писали, а не так,
        // как разделы называются сегодня.
        const secTitles = (d.sections && d.sections.titles) || {};
        const parts = PART_TITLES
            .filter(([key]) => String(d[key] || '').trim())
            .map(([key, label]) => `<div class="part"><div class="pl">${esc(secTitles[key] || tr(label))}</div><div class="pv">${
                key === 'diagnosis' ? esc(d[key]) : sanitizeStoredHtml(d[key])
            }</div></div>`)
            .join('');
        // Свои разделы идут следом за колоночными, в том порядке, в каком их
        // писали. Раздел без имени печатается без подписи — так его и завели.
        const extra = ((d.sections && d.sections.extra) || [])
            .filter((x) => x && (String(x.title || '').trim() || String(x.html || '').trim()))
            .map((x) => `<div class="part">${
                String(x.title || '').trim() ? `<div class="pl">${esc(x.title)}</div>` : ''
            }<div class="pv">${sanitizeStoredHtml(x.html || '')}</div></div>`)
            .join('');
        const sign = [d.author_name, d.published_at ? fmtDateTime(d.published_at) : ''].filter(Boolean).join(' · ');
        return `
<section class="doc">
  <h2><span class="no">${i + 1}</span>${esc(caseDocTitle(d.kind, d.title))}${
      d.revision_count > 1 ? `<span class="rev">${esc(trf('редакция {n}', { n: d.revision_count }))}</span>` : ''
  }</h2>
  ${parts + extra || `<div class="part"><div class="pv empty">${esc(tr('Текст документа не заполнен.'))}</div></div>`}
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
.after-cover { page-break-before: always; }
.doc h2 { font-size: 15px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #d3d9de; padding-bottom: 5px; }
.doc h2 .no { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #16232b; color: #fff; font-size: 11px; }
.doc h2 .rev { margin-left: auto; font-size: 11px; font-weight: 600; color: #b45309; }
.part { display: flex; gap: 10px; padding: 3px 0; font-size: 13px; line-height: 1.5; }
.part .pl { min-width: 150px; color: #55636d; }
.part .pv { flex: 1; white-space: pre-wrap; }
.part .pv.empty { color: #7a8892; font-style: italic; }
.sign { margin-top: 6px; font-size: 12px; color: #55636d; text-align: right; }
${titleSheetPrintCss()}
</style></head><body>
${cover}
${body
    ? '<div class="after-cover">' + body + '</div>'
    : `<p class="note">${esc(tr('Опубликованных документов пока нет.'))}</p>`}
<script>window.onload=function(){(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){try{window.focus();window.print();}catch(e){}});};</scr` + `ipt>
</body></html>`;
}
/* type-scale-exempt-end */

/**
 * CASE_FILE_SAVE_V1 (2026-09-06) — СОБРАТЬ = ПОДШИТЬ В КАРТУ, а печать уже
 * потом.
 *
 * Владелец: «when the pressed the collect history, its will be saved in the
 * documents section of the patient».
 *
 * Раньше сборка только открывала окно печати: закрыл вкладку — и собранного
 * документа нет нигде, хотя это ровно та бумага, которую спрашивают через год.
 *
 * ПОРЯДОК ВАЖЕН: сначала сохранение на сервере, и только потом печать. Обратный
 * порядок в день, когда сохранение откажет, дал бы напечатанную историю,
 * которой нет в карте, — а человек с бумагой в руках уверен, что она сохранена.
 *
 * Печатается ТО ЖЕ САМОЕ, что подшито: сервер возвращает снимок, который сам же
 * и записал, поэтому бумага и карта не могут разойтись.
 */
export async function assembleCaseFile(admissionId) {
    const { data, error } = await supabase.rpc('admission_case_file_save', { admission_id: admissionId });
    if (error) { toast(error.message || tr('Не удалось собрать историю болезни.'), 'fail'); return null; }

    const saved = data || {};
    // Сколько черновиков осталось за бортом — говорим сразу: собравший обязан
    // знать, что не всё написанное попало в подшитую историю.
    toast(saved.drafts_excluded
        ? trf('История болезни подшита в документы пациента. Черновиков не вошло: {n}', { n: saved.drafts_excluded })
        : tr('История болезни подшита в документы пациента'), 'ok');

    const file = saved.file || saved.body || null;
    if (!file) return saved;
    const { PRINT_FONT_FACE_CSS } = await import('../../shared/print-fonts.js');
    const html = caseFilePrintHtml(file, { fontFaceCss: PRINT_FONT_FACE_CSS });
    const w = window.open('', '_blank');
    if (!w) { toast(tr('Документ сохранён; для печати разрешите всплывающие окна.'), 'warn'); return saved; }
    w.document.write(html);
    w.document.close();
    return saved;
}
