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
import { h, Icon, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { caseDocTitle } from './case-docs.js';

/** Вкладки истории болезни. Порядок — порядок работы у постели. */
export const CASE_TABS = Object.freeze([
    { id: 'documents', label: 'Документы',              icon: 'Doc' },
    { id: 'orders',    label: 'Назначения',             icon: 'Pill' },
    { id: 'exams',     label: 'Обследования и анализы', icon: 'Flask' },
    { id: 'surgery',   label: 'Операция',               icon: 'Stethoscope' },
    // ACT_OF_WORKS_V1 — акт стоит последним: он про деньги, а деньги считают,
    // когда лечение уже описано.
    { id: 'act',       label: 'Акт выполненных работ',  icon: 'Receipt' },
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

/**
 * РАЗДЕЛЫ СПРАВОЧНИКА, которые вкладка считает своими. Подстроки, без регистра
 * — и по-русски, и служебным словом маршрутизации (services.type), потому что
 * раздел у услуги может быть не заполнен, а слово стоит всегда.
 */
/* i18n-exempt-start: это не текст экрана, а куски НАЗВАНИЙ РАЗДЕЛОВ справочника,
   по которым узнаётся услуга. Переводить их значило бы искать «Laboratoriya» в
   справочнике, который заполнен по-русски. */
const EXAM_TYPES = ['лаборатор', 'диагностик', 'лучев', 'lab', 'imaging', 'radiolog', 'diagnost'];
const SURGERY_TYPES = ['хирург', 'операц', 'surg'];
/* i18n-exempt-end */

const empty = (text) => h('div', { class: 'cf-empty' }, tr(text));

/**
 * НАЗНАЧЕННЫЕ УСЛУГИ НУЖНОГО РАЗДЕЛА — из акта выполненных работ.
 *
 * ACT_ADD_SERVICE_V1 — назначенный анализ появляется в акте сразу, а результат
 * — когда его внесут. Между этими двумя моментами он обязан быть виден: иначе
 * врач, нажавший «Анализы и диагностика», не находит назначенного нигде и
 * назначает его второй раз.
 */
function orderedServices(charges, needles) {
    const lines = (charges && charges.lines) || [];
    const want = needles.map((x) => String(x).toLowerCase());
    return lines.filter((l) => l.kind === 'service'
        && want.some((w) => String(l.service_type || '').toLowerCase().includes(w)));
}

/** Строка «назначено, ещё не сделано». */
function orderedRow(l) {
    return h('li', { class: 'cf-row' },
        h('div', { class: 'cf-row-main' },
            h('div', { class: 'cf-row-t' }, l.name || '—'),
            h('div', { class: 'cf-row-m' },
                [l.doctor_name, l.at ? when(l.at) : ''].filter(Boolean).join(' · '))),
        h('span', { class: 'cf-row-m' }, tr(l.invoice_number ? 'в счёте' : 'не выставлен')));
}
const when = (v) => (v ? fmtDateTime(v) : '');

// ---------------------------------------------------------------------------
// 2. Назначения
// ---------------------------------------------------------------------------
/**
 * Что назначено этому пациенту. Список — из обзора; отмечает дозы и ведёт
 * сетку «назначение × час» ЛИСТ НАЗНАЧЕНИЙ, и вкладка честно уводит туда, а
 * не рисует вторую сетку.
 */
export function caseOrdersPanel(overview, { onOpenSheet = null, onAdd = null } = {}) {
    const rows = (overview && overview.orders) || [];
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Назначения') });
    box.appendChild(h('div', { class: 'cf-pane-h' },
        h('b', null, tr('Назначения')),
        h('span', { class: 'grow' }),
        onOpenSheet
            ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => onOpenSheet() },
                Icon('Grid', { size: 14 }), ' ', tr('Лист назначений'))
            : null,
        // ACT_ADD_SERVICE_V1 — назначение заводится ТЕМ ЖЕ окном, что и в листе
        // назначений: вторая форма с теми же полями разошлась бы с первой.
        onAdd
            ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => onAdd() },
                Icon('Plus', { size: 14 }), ' ', tr('Назначение'))
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
export function caseExamsPanel(admissionId, { onAdd = null, charges = null } = {}) {
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Обследования и анализы') });
    box.appendChild(h('div', { class: 'cf-pane-h' },
        h('b', null, tr('Обследования и анализы')),
        h('span', { class: 'grow' }),
        onAdd
            ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => onAdd() },
                Icon('Plus', { size: 14 }), ' ', tr('Анализы и диагностика'))
            : null));

    // Назначенное стоит ПЕРЕД результатами: сначала «что заказано», потом «что
    // пришло». Список берётся из акта — второго списка назначенного нет.
    const ordered = orderedServices(charges, EXAM_TYPES);
    if (ordered.length) {
        box.appendChild(h('div', { class: 'cf-group' }, tr('Назначено')));
        box.appendChild(h('ul', { class: 'cf-list' }, ...ordered.map(orderedRow)));
        box.appendChild(h('div', { class: 'cf-note' },
            tr('Назначенное отсюда попадает в акт выполненных работ. В рабочий список лаборатории оно пока не встаёт — пробирку берут по направлению.')));
    }

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
// 5. Акт выполненных работ
// ---------------------------------------------------------------------------
const KIND_WORD = { service: 'Услуга', item: 'Расходник', stay: 'Проживание' };

/** Сумма словами клиники: разряды пробелами, без копеек. */
const money = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function actRow(l, { onBillable = null } = {}) {
    const cls = 'cf-act-r' + (l.billable ? '' : ' cf-act-off');
    return h('tr', { class: cls },
        h('td', null,
            h('div', { class: 'cf-row-t' }, l.name || '—'),
            h('div', { class: 'cf-row-m' }, [tr(KIND_WORD[l.kind] || KIND_WORD.service),
                l.doctor_name, l.at ? when(l.at) : ''].filter(Boolean).join(' · '))),
        h('td', { class: 'num' }, String(l.quantity) + (l.unit ? ' ' + l.unit : '')),
        h('td', { class: 'num' }, money(l.unit_price)),
        h('td', { class: 'num cf-act-sum' }, money(l.total)),
        h('td', null, l.invoice_number
            ? h('span', { class: 'cf-act-inv' }, l.invoice_number)
            : h('span', { class: 'cf-row-m' }, tr('не выставлен'))),
        h('td', { class: 'cf-act-act' }, onBillable && !l.locked
            ? h('button', {
                class: 'btn btn-sm' + (l.billable ? '' : ' btn-outline'), type: 'button',
                title: l.billable ? tr('Исключить из счёта') : tr('Вернуть в счёт'),
                onclick: () => onBillable(l, !l.billable),
            }, tr(l.billable ? 'В счёт' : 'Не в счёт'))
            : (l.locked ? h('span', { class: 'cf-row-m' }, tr('в счёте')) : null)));
}

/**
 * АКТ ВЫПОЛНЕННЫХ РАБОТ — всё, что начислено этой госпитализации.
 *
 * ACT_OF_WORKS_V1 (2026-09-10) — владелец: «act of done things». Начисленное
 * копилось с самого начала (admission_services), но видел его только итог в
 * обзоре: «накоплено к оплате». Здесь оно построчно — с тем, кто сделал, когда,
 * почём и попало ли в счёт.
 *
 * Экран НИЧЕГО НЕ СЧИТАЕТ: суммы приходят готовыми. Две арифметики — своя на
 * сервере и своя в браузере — расходятся молча, а спорить с пациентом придётся
 * о той сумме, которую он увидел.
 */
export function caseActPanel(admissionId, { onInvoice = null, onAddExpense = null } = {}) {
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Акт выполненных работ') });
    const head = h('div', { class: 'cf-pane-h' }, h('b', null, tr('Акт выполненных работ')));
    const body = h('div', { class: 'cf-body' }, h('div', { class: 'cf-row-m' }, tr('Загружаем начисленное…')));
    box.appendChild(head);
    box.appendChild(body);

    const load = async () => {
        const { data, error } = await supabase.rpc('admission_charges', { admission_id: admissionId });
        clear(body);
        if (error) {
            // Отказ по роли — не поломка: акт видят те, кто отвечает за деньги.
            body.appendChild(h('div', { class: 'cf-row-m' }, error.code === 'forbidden'
                ? tr('Акт выполненных работ открыт кассе, администратору и главному врачу.')
                : trf('Акт не загрузился: {msg}', { msg: error.message || '' })));
            return;
        }
        const lines = (data && data.lines) || [];
        const t = (data && data.totals) || {};

        clear(head);
        head.appendChild(h('b', null, tr('Акт выполненных работ')));
        head.appendChild(h('span', { class: 'grow' }));
        if (onAddExpense) {
            head.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => onAddExpense(load) },
                Icon('Plus', { size: 14 }), ' ', tr('Добавить расход')));
        }
        if (onInvoice) {
            head.appendChild(h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                disabled: t.pending > 0 ? null : '',
                title: t.pending > 0 ? tr('Выставить счёт на всё, что ещё не выставлено') : tr('Выставлять нечего'),
                onclick: () => onInvoice(load),
            }, Icon('Receipt', { size: 14 }), ' ', tr('Выставить счёт')));
        }

        if (!lines.length) {
            body.appendChild(empty('Этой госпитализации ещё ничего не начислено.'));
            return;
        }

        body.appendChild(h('div', { class: 'cf-tblwrap' }, h('table', { class: 'cf-act' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Наименование')),
                h('th', { class: 'num' }, tr('Кол-во')),
                h('th', { class: 'num' }, tr('Цена')),
                h('th', { class: 'num' }, tr('Сумма')),
                h('th', null, tr('Счёт')),
                h('th', null, ''))),
            h('tbody', null, ...lines.map((l) => actRow(l, {
                onBillable: async (line, on) => {
                    const { error: e2 } = await supabase.rpc('admission_charge_set_billable',
                        { line_id: line.id, billable: on });
                    if (e2) { toast(e2.message || tr('Не удалось изменить строку.'), 'fail'); return; }
                    await load();
                },
            }))))));

        // Итоги — те же, что посчитал сервер, и в том же порядке, в каком о них
        // спрашивают: сколько всего, сколько ещё не выставлено, сколько в счетах.
        const sum = (label, value, cls) => h('div', { class: 'cf-sum' + (cls ? ' ' + cls : '') },
            h('span', { class: 'cf-sum-l' }, tr(label)),
            h('span', { class: 'cf-sum-v' }, money(value) + ' ' + tr('сум')));
        body.appendChild(h('div', { class: 'cf-sums' },
            sum('Начислено', t.accrued),
            sum('К выставлению', t.pending, 'cf-sum-hot'),
            sum('В счетах', t.invoiced),
            t.not_billable ? sum('За счёт клиники', t.not_billable) : null));
    };

    load();
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
export function caseSurgeryPanel(overview, docs, { onDoc = null, onAdd = null, charges = null } = {}) {
    const op = (overview && overview.operation) || { state: 'none' };
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Операция') });
    box.appendChild(h('div', { class: 'cf-pane-h' },
        h('b', null, tr('Операция')),
        h('span', { class: 'grow' }),
        // Владелец: «get service type surgery from the services list» — операция
        // выбирается из справочника разделом «Хирургия», а не пишется словами.
        onAdd
            ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => onAdd() },
                Icon('Plus', { size: 14 }), ' ', tr('Операция'))
            : null));

    const state = h('div', { class: 'cf-op' + (op.state === 'done' ? ' cf-op-done' : op.state === 'planned' ? ' cf-op-plan' : '') },
        tr(OP_WORD[op.state] || OP_WORD.none));
    box.appendChild(h('div', { class: 'cf-body' }, state,
        op.at ? h('div', { class: 'cf-row-m' }, trf('Когда: {when}', { when: when(op.at) })) : null,
        op.has_surgery_service ? h('div', { class: 'cf-row-m' }, tr('Операция есть в услугах госпитализации.')) : null));

    const ops = orderedServices(charges, SURGERY_TYPES);
    if (ops.length) {
        box.appendChild(h('div', { class: 'cf-group' }, tr('Операции в услугах')));
        box.appendChild(h('ul', { class: 'cf-list' }, ...ops.map(orderedRow)));
    }

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
