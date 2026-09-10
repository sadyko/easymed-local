// CASE_FILE_TABS_V1 (2026-09-10) — ИСТОРИЯ БОЛЕЗНИ ЧЕТЫРЬМЯ ВКЛАДКАМИ.
//
// Владелец: «after the card of the patient we need to add tabs for navigation:
// 1) documents (current existing) 2) prescriptions 3) examinations and lab
// 4) surgery».
//
// Экран истории болезни был одним — документами. Всё остальное про этого
// пациента лежало по другим адресам: назначения — в «Листе назначений»,
// анализы — в лаборатории, операция — строкой в обзоре. Врач у постели ходил
// между разделами и каждый раз заново искал пациента.
//
// ЧТО ЗДЕСЬ НЕ ДЕЛАЕТСЯ. Вкладки НИЧЕГО НЕ СЧИТАЮТ и ничего не дублируют: они
// показывают то, что уже присылают `admission_overview` (назначения, услуги,
// операция) и `admission_doc_sources` (анализы, снимки, функциональные). Где
// есть полноценный экран — лист назначений, — вкладка на него и уводит, а не
// заводит вторую его копию: две копии расходятся, и лечение начинают читать по
// той, что врёт.
import { h, Icon, clear, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { caseDocTitle } from './case-docs.js';

/** Вкладки истории болезни. Порядок — порядок работы у постели. */
export const CASE_TABS = Object.freeze([
    { id: 'documents', label: 'Документы',              icon: 'Doc' },
    { id: 'orders',    label: 'Назначения',             icon: 'Pill' },
    { id: 'exams',     label: 'Обследования и анализы', icon: 'Flask' },
    { id: 'surgery',   label: 'Операция',               icon: 'Stethoscope' },
]);

/**
 * Полоса вкладок — системная (.tabs/.tab), та же, что во всех разделах.
 * @param {{active:string, onPick:(id:string)=>void, badges?:object}} opts
 */
export function caseTabsBar({ active = 'documents', onPick = null, badges = {} } = {}) {
    return h('div', { class: 'tabs cf-tabs', role: 'tablist' }, ...CASE_TABS.map((t) => {
        const on = t.id === active;
        const n = badges[t.id];
        return h('button', {
            class: 'tab' + (on ? ' on' : ''), type: 'button', role: 'tab',
            'aria-selected': on ? 'true' : 'false',
            onclick: () => { if (!on && onPick) onPick(t.id); },
        }, Icon(t.icon, { size: 15 }), tr(t.label),
            n ? h('span', { class: 'tab-count' }, String(n)) : null);
    }));
}

const empty = (text) => h('div', { class: 'cf-empty' }, tr(text));
const when = (v) => (v ? fmtDateTime(v) : '');

// ---------------------------------------------------------------------------
// 2. Назначения
// ---------------------------------------------------------------------------
/**
 * Что назначено этому пациенту. Список — из обзора; отмечает дозы и ведёт
 * сетку «назначение × час» ЛИСТ НАЗНАЧЕНИЙ, и вкладка честно уводит туда, а
 * не рисует вторую сетку.
 */
export function caseOrdersPanel(overview, { onOpenSheet = null } = {}) {
    const rows = (overview && overview.orders) || [];
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Назначения') });
    box.appendChild(h('div', { class: 'cf-pane-h' },
        h('b', null, tr('Назначения')),
        h('span', { class: 'grow' }),
        onOpenSheet
            ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => onOpenSheet() },
                Icon('Grid', { size: 14 }), ' ', tr('Лист назначений'))
            : null));

    if (!rows.length) {
        box.appendChild(empty('Назначений пока нет. Их делает лечащий врач в листе назначений.'));
        return box;
    }
    box.appendChild(h('ul', { class: 'cf-list' }, ...rows.map((r) => h('li', { class: 'cf-row' },
        h('div', { class: 'cf-row-main' },
            h('div', { class: 'cf-row-t' }, r.name || '—'),
            h('div', { class: 'cf-row-m' },
                [r.dose, r.route, r.prn ? tr('по требованию') : r.freq_code].filter(Boolean).join(' · '))),
        r.started_at ? h('div', { class: 'cf-row-r' }, trf('с {when}', { when: when(r.started_at) })) : null))));
    return box;
}

// ---------------------------------------------------------------------------
// 3. Обследования и анализы
// ---------------------------------------------------------------------------
const flagWord = { high: 'выше нормы', low: 'ниже нормы' };

function labCard(a) {
    const rows = (a.results || []).filter((r) => r && r.parameter);
    return h('div', { class: 'cf-item' },
        h('div', { class: 'cf-item-h' },
            h('b', null, a.name || '—'),
            h('span', { class: 'cf-when' }, when(a.at))),
        rows.length
            ? h('table', { class: 'cf-tbl' }, h('tbody', null, ...rows.map((r) => h('tr', {
                class: r.flag === 'high' || r.flag === 'low' ? 'cf-off' : '',
            },
                h('td', null, r.parameter),
                h('td', { class: 'num' }, [r.value, r.unit].filter(Boolean).join(' ')),
                h('td', { class: 'cf-ref' }, r.reference_range || ''),
                h('td', { class: 'cf-flag' }, r.flag && flagWord[r.flag] ? tr(flagWord[r.flag]) : '')))))
            : h('div', { class: 'cf-row-m' }, tr('Результат ещё не внесён.')));
}

function reportCard(a) {
    return h('div', { class: 'cf-item' },
        h('div', { class: 'cf-item-h' },
            h('b', null, a.name || '—'),
            h('span', { class: 'cf-when' }, when(a.at))),
        a.conclusion
            ? h('div', { class: 'cf-concl' }, a.conclusion)
            : h('div', { class: 'cf-row-m' }, tr('Заключение ещё не написано.')));
}

/**
 * Анализы, снимки и функциональные — ТОГО ЖЕ ИСТОЧНИКА, что и правая панель
 * «Вставить в документ» (admission_doc_sources). Один запрос, одна правда:
 * список во вкладке и список для вставки не смогут разойтись.
 */
export function caseExamsPanel(admissionId) {
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Обследования и анализы') });
    box.appendChild(h('div', { class: 'cf-pane-h' }, h('b', null, tr('Обследования и анализы'))));
    const body = h('div', { class: 'cf-body' }, h('div', { class: 'cf-row-m' }, tr('Загружаем результаты…')));
    box.appendChild(body);

    (async () => {
        const { data, error } = await supabase.rpc('admission_doc_sources', { admission_id: admissionId });
        clear(body);
        if (error) {
            body.appendChild(h('div', { class: 'cf-row-m' },
                trf('Результаты не загрузились: {msg}', { msg: error.message || '' })));
            return;
        }
        const lab = (data && data.lab) || [];
        const imaging = (data && data.imaging) || [];
        const functional = (data && data.functional) || [];
        if (!lab.length && !imaging.length && !functional.length) {
            body.appendChild(empty('Ни анализов, ни исследований по этой госпитализации ещё нет.'));
            return;
        }
        const group = (title, items, card) => {
            if (!items.length) return;
            body.appendChild(h('div', { class: 'cf-group' }, tr(title)));
            for (const it of items) body.appendChild(card(it));
        };
        group('Анализы', lab, labCard);
        group('Исследования', imaging, reportCard);
        group('Функциональные', functional, reportCard);
    })();

    return box;
}

// ---------------------------------------------------------------------------
// 4. Операция
// ---------------------------------------------------------------------------
const OP_DOCS = ['anesthesia', 'preop', 'operation'];
const OP_WORD = { done: 'Проведена', planned: 'Запланирована', none: 'Не планируется' };

/**
 * Операция и её три документа.
 *
 * Состояние операции считает СЕРВЕР (admission_overview.operation): «есть
 * протокол» и «есть услуга операции» — это две разные вещи, и решать их в
 * браузере значило бы завести вторую версию правила.
 */
export function caseSurgeryPanel(overview, docs, { onDoc = null } = {}) {
    const op = (overview && overview.operation) || { state: 'none' };
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Операция') });
    box.appendChild(h('div', { class: 'cf-pane-h' }, h('b', null, tr('Операция'))));

    const state = h('div', { class: 'cf-op' + (op.state === 'done' ? ' cf-op-done' : op.state === 'planned' ? ' cf-op-plan' : '') },
        tr(OP_WORD[op.state] || OP_WORD.none));
    box.appendChild(h('div', { class: 'cf-body' }, state,
        op.at ? h('div', { class: 'cf-row-m' }, trf('Когда: {when}', { when: when(op.at) })) : null,
        op.has_surgery_service ? h('div', { class: 'cf-row-m' }, tr('Операция есть в услугах госпитализации.')) : null));

    // Документы хирургического блока — с их состоянием из чек-листа.
    const items = ((docs && docs.items) || []).filter((i) => OP_DOCS.includes(i.kind));
    if (!items.length) {
        box.appendChild(empty('Документы операции появятся, как только будет написан первый из них.'));
        return box;
    }
    box.appendChild(h('div', { class: 'cf-group' }, tr('Документы операции')));
    box.appendChild(h('ul', { class: 'cf-list' }, ...items.map((it) => {
        const name = caseDocTitle(it.kind, it.title);
        return h('li', { class: 'cf-row' },
            h('div', { class: 'cf-row-main' },
                h('div', { class: 'cf-row-t' }, name),
                h('div', { class: 'cf-row-m' }, it.published_at
                    ? trf('оформлен {when}', { when: when(it.published_at) })
                    : tr('ещё не написан'))),
            onDoc
                ? h('button', { class: 'btn btn-sm', type: 'button',
                    onclick: () => onDoc(it.kind, it.state === 'published' ? 'view' : 'edit',
                        it.review_id || it.draft_id || null, name) },
                    tr(it.published_at ? 'Открыть' : 'Написать'))
                : null);
    })));
    return box;
}
