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
import { dateNumeric } from '../../shared/date-words.js';   // ACT_TABLE_V1 — дата в реестре одним числом
import { downloadCsv } from '../csv.js';                    // ACT_TABLE_V1 — «Excel»: реестр таблицей

/** Вкладки истории болезни. Порядок — порядок работы у постели. */
export const CASE_TABS = Object.freeze([
    { id: 'documents', label: 'Документы',              icon: 'Doc' },
    { id: 'beds',      label: 'Койки и переводы',       icon: 'Bed' },
    { id: 'vitals',    label: 'Показатели',             icon: 'Activity' },
    { id: 'orders',    label: 'Лист назначений',        icon: 'Pill' },
    { id: 'exams',     label: 'Обследования и услуги',  icon: 'Flask' },
    // В наборе нет еды; кухонный экран приложения зовёт 'Doc', но здесь он
    // столкнулся бы с «Документами» — берём каплю: стол и питьевой режим.
    { id: 'meals',     label: 'Питание',                icon: 'Drop' },
    { id: 'surgery',   label: 'Операция',               icon: 'Stethoscope' },
    // ACT_OF_WORKS_V1 — акт и счета стоят последними: они про деньги, а деньги
    // считают, когда лечение уже описано.
    { id: 'act',       label: 'Акт выполненных работ',  icon: 'Receipt' },
    { id: 'invoices',  label: 'Счета',                  icon: 'Wallet' },
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
/** Колонки реестра обследований — один список на экран и на выгрузку. */
const EXAM_COLS = ['Услуга', 'Назначил', 'Дата', 'Кабинет', 'Кол-во', 'Стоимость', 'Сумма', 'Статус', 'Результат'];
const EXAM_ST = {
    ordered: { word: 'Назначена', cls: 'cf-chip-off' },
    ready:   { word: 'Результат готов', cls: 'cf-chip-inv' },
};

/** Плашка состояния — одна на обе строки реестра. */
function examStatus(kind) {
    const m = EXAM_ST[kind] || EXAM_ST.ordered;
    return h('span', { class: 'cf-chip ' + m.cls }, tr(m.word));
}

/**
 * ОБСЛЕДОВАНИЯ И УСЛУГИ — реестром эталона владельца.
 *
 * EXAM_TABLE_V1 — в одной таблице две разные вещи, и каждая строка честно
 * говорит, которая она: НАЗНАЧЕННОЕ (из акта выполненных работ — с врачом,
 * кабинетом и деньгами) и ПРИШЕДШИЕ РЕЗУЛЬТАТЫ (из admission_doc_sources —
 * того же запроса, что кормит правую панель «Вставить в документ»: один запрос,
 * одна правда). Связать их сегодня нечем: результат лаборатории привязан к
 * визиту, а не к строке начисления, — поэтому строки стоят рядом, а не
 * склеиваются в одну ложным соответствием.
 */
export function caseExamsPanel(admissionId, { onAdd = null, charges = null } = {}) {
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Обследования и услуги') });
    box.appendChild(h('div', { class: 'cf-pane-h' },
        h('b', null, tr('Обследования и услуги')),
        h('span', { class: 'grow' }),
        onAdd
            ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => onAdd() },
                Icon('Plus', { size: 14 }), ' ', tr('Анализы и диагностика'))
            : null));

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
        // Назначенное — из акта: второго списка назначенного в системе нет.
        const ordered = orderedServices(charges, EXAM_TYPES);
        const results = [
            ...lab.map((it) => ({ it, card: labCard })),
            ...imaging.map((it) => ({ it, card: reportCard })),
            ...functional.map((it) => ({ it, card: reportCard })),
        ];
        if (!ordered.length && !results.length) {
            body.appendChild(empty('Ни анализов, ни исследований по этой госпитализации ещё нет.'));
            return;
        }

        const tbody = h('tbody');
        // Назначенное — сверху: сначала «что заказано», потом «что пришло».
        for (const l of ordered) {
            tbody.appendChild(h('tr', null,
                h('td', null, h('div', { class: 'cf-row-t' }, l.name || '—')),
                h('td', null, l.doctor_name || '—'),
                h('td', { class: 'num' }, day(l.at)),
                h('td', null, l.room || '—'),
                h('td', { class: 'num' }, String(l.quantity)),
                h('td', { class: 'num' }, money(l.unit_price)),
                h('td', { class: 'num cf-act-sum' }, money(l.total)),
                h('td', null, examStatus('ordered')),
                h('td', { class: 'cf-row-m' }, tr('ожидается'))));
        }
        for (const r of results) {
            const it = r.it;
            // Раскрытие живёт СТРОКОЙ ПОД строкой, а не отдельным окном: результат
            // читают рядом с назначением, а не вместо него.
            const det = h('tr', { class: 'cf-exam-det' });
            const show = () => {
                if (det.children.length) { clear(det); return; }
                det.appendChild(h('td', { colspan: String(EXAM_COLS.length) }, r.card(it)));
            };
            tbody.appendChild(h('tr', null,
                h('td', null, h('div', { class: 'cf-row-t' }, it.name || '—')),
                h('td', null, it.doctor_name || '—'),
                h('td', { class: 'num' }, day(it.at)),
                h('td', null, '—'),
                h('td', { class: 'num' }, '—'),
                h('td', { class: 'num' }, '—'),
                h('td', { class: 'num' }, '—'),
                h('td', null, examStatus('ready')),
                h('td', null, h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: show },
                    Icon('ZoomIn', { size: 13 }), ' ', tr('Просмотреть')))));
            tbody.appendChild(det);
        }

        body.appendChild(h('div', { class: 'cf-tblwrap' }, h('table', { class: 'cf-act' },
            h('thead', null, h('tr', null,
                ...EXAM_COLS.map((label, i) => h('th', { class: [2, 4, 5, 6].includes(i) ? 'num' : null }, tr(label))))),
            tbody)));

        if (ordered.length) {
            const accrued = ordered.reduce((a, l) => a + (Number(l.total) || 0), 0);
            body.appendChild(h('div', { class: 'cf-sums' },
                h('div', { class: 'cf-sum' },
                    h('span', { class: 'cf-sum-l' }, tr('Начислено по обследованиям')),
                    h('span', { class: 'cf-sum-v' }, money(accrued) + ' ' + tr('сум')))));
            body.appendChild(h('div', { class: 'cf-note' },
                tr('Назначенное отсюда попадает в акт выполненных работ. В рабочий список лаборатории оно пока не встаёт — пробирку берут по направлению.')));
        }
    })();

    return box;
}

// ---------------------------------------------------------------------------
// 5. Акт выполненных работ
// ---------------------------------------------------------------------------
const KIND_WORD = { service: 'Услуга', item: 'Расходник', stay: 'Койко-день' };
// Ключи слева — значения products.category в базе; справа — то, что читает касса.
const CAT_WORD = { drug: 'Медикаменты', consumable: 'Мед. изделия', other: 'Прочее' };
/** Колонки реестра — один список на экран, печать и выгрузку. */
const ACT_COLS = ['Наименование', 'Вид расхода', 'Тип расхода', 'Дата', 'Ед-ца', 'Кол-во',
    'Стоимость', 'Сумма', 'Счёт'];

/** Сумма словами клиники: разряды пробелами, без копеек. */
const money = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
/** Дата строки — одним числом, как в реестре: время здесь только мешает. */
const day = (v) => (v ? dateNumeric(String(v).slice(0, 10)) : '');

/**
 * ТИП РАСХОДА — то, чем строка является в деньгах.
 *
 * У расходника его знает ТОВАР (products.category: медикамент или изделие), у
 * услуги — раздел справочника, у проживания типа нет вовсе. Своей колонки «тип»
 * у строки акта нет, и заводить её значило бы держать вторую правду рядом со
 * справочником, который это и так знает.
 */
function actType(l) {
    if (l.kind === 'stay') return tr('Стационар');
    if (l.kind === 'item') return tr(CAT_WORD[l.product_category] || CAT_WORD.other);
    return l.service_type || '—';
}

/** Строка реестра значениями — одна на экран, печать и выгрузку. */
function actCells(l) {
    return [l.name || '—', tr(KIND_WORD[l.kind] || KIND_WORD.service), actType(l), day(l.at),
        l.unit || '—', String(l.quantity), money(l.unit_price), money(l.total),
        l.invoice_number || tr('не выставлен')];
}

/** Счёт строки: номер плашкой — зелёной, если оплачен. */
function invCell(l) {
    if (!l.invoice_number) return h('span', { class: 'cf-chip cf-chip-off' }, tr('не выставлен'));
    return h('span', { class: 'cf-chip ' + (l.paid ? 'cf-chip-ok' : 'cf-chip-inv'),
        title: l.paid ? tr('Счёт оплачен') : tr('Счёт выставлен, не оплачен') }, l.invoice_number);
}

/**
 * СТРОКА АКТА.
 *
 * Галочка стоит только там, где счёт ещё можно выставить: строку, уже попавшую
 * в счёт, и строку «за счёт клиники» отмечать нечем — а молча пропускать их при
 * выставлении хуже, чем не дать отметить.
 */
function actRow(l, { onBillable = null, selected = false, onSelect = null } = {}) {
    const canPick = !l.locked && l.billable;
    const c = actCells(l);
    return h('tr', { class: 'cf-act-r' + (l.billable ? '' : ' cf-act-off') },
        h('td', { class: 'cf-act-pick' }, canPick && onSelect
            ? h('input', { type: 'checkbox', checked: selected, 'aria-label': tr('Выбрать строку'),
                onchange: (e) => onSelect(l, !!e.target.checked) })
            : null),
        h('td', null, h('div', { class: 'cf-row-t' }, c[0]),
            l.doctor_name ? h('div', { class: 'cf-row-m' }, l.doctor_name) : null),
        h('td', null, c[1]),
        h('td', null, c[2]),
        h('td', { class: 'num' }, c[3]),
        h('td', null, c[4]),
        h('td', { class: 'num' }, c[5]),
        h('td', { class: 'num' }, c[6]),
        h('td', { class: 'num cf-act-sum' }, c[7]),
        h('td', null, invCell(l)),
        h('td', { class: 'cf-act-act' }, onBillable && !l.locked
            ? h('button', {
                class: 'btn btn-sm' + (l.billable ? ' btn-outline' : ''), type: 'button',
                title: l.billable ? tr('Исключить из счёта') : tr('Вернуть в счёт'),
                onclick: () => onBillable(l, !l.billable),
            }, tr(l.billable ? 'Не в счёт' : 'В счёт'))
            : (l.locked ? h('span', { class: 'cf-row-m' }, tr('в счёте')) : null)));
}

const csvEsc = (c) => '"' + String(c == null ? '' : c).split('"').join('""') + '"';
/** Реестр для Excel: те же колонки и те же значения, что на экране. */
export function actCsv(data) {
    const rows = [ACT_COLS.map((x) => tr(x)), ...((data && data.lines) || []).map(actCells)];
    return rows.map((r) => r.map(csvEsc).join(';')).join(String.fromCharCode(13) + String.fromCharCode(10));
}

const htmlEsc = (v) => String(v == null ? '' : v)
    .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
/** Реестр на бумагу: та же таблица, тем же порядком колонок. */
export function actPrintBody(data) {
    const lines = (data && data.lines) || [];
    const t = (data && data.totals) || {};
    const head = ACT_COLS.map((x) => '<th>' + htmlEsc(tr(x)) + '</th>').join('');
    const body = lines.map((l) => '<tr>' + actCells(l).map((v) => '<td>' + htmlEsc(v) + '</td>').join('') + '</tr>').join('');
    const foot = htmlEsc(tr('Итого начислено')) + ': ' + htmlEsc(money(t.accrued) + ' ' + tr('сум'));
    return '<div class="act-wrap"><table class="act-print"><thead><tr>' + head + '</tr></thead>'
        + '<tbody>' + body + '</tbody></table>'
        + '<div class="act-print-sum"><b>' + foot + '</b></div></div>';
}

/**
 * АКТ ВЫПОЛНЕННЫХ РАБОТ — всё, что начислено этой госпитализации.
 *
 * ACT_OF_WORKS_V1 (2026-09-10) — владелец: «act of done things». Начисленное
 * копилось с самого начала (admission_services), но видел его только итог в
 * обзоре: «накоплено к оплате». Здесь оно построчно — с тем, кто сделал, когда,
 * почём и попало ли в счёт.
 *
 * ACT_TABLE_V1 — реестром эталона владельца: вид и тип расхода, дата, единица,
 * количество, цена, сумма и номер счёта плашкой; отметил строки — выставил счёт
 * ровно на них. ЧЕГО В РЕЕСТРЕ НЕТ И ПОЧЕМУ: «Источник» (стационар / оперблок /
 * анестезия) и «Относится к» — за ними в базе не стоит ничего, пока нет
 * оперблока; скидка живёт на счёте, а не на строке. Колонка, которая всегда
 * пуста, — это обещание, а не сведения.
 *
 * Экран НИЧЕГО НЕ СЧИТАЕТ: суммы приходят готовыми. Две арифметики — своя на
 * сервере и своя в браузере — расходятся молча, а спорить с пациентом придётся
 * о той сумме, которую он увидел.
 */
export function caseActPanel(admissionId, { onInvoice = null, onAddExpense = null, onPrint = null } = {}) {
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Акт выполненных работ') });
    const head = h('div', { class: 'cf-pane-h' }, h('b', null, tr('Акт выполненных работ')));
    const body = h('div', { class: 'cf-body' }, h('div', { class: 'cf-row-m' }, tr('Загружаем начисленное…')));
    box.appendChild(head);
    box.appendChild(body);

    // Что отмечено галочками. Живёт между перерисовками: снимать выбор после
    // каждого «не в счёт» значило бы заставлять кассу отмечать заново.
    const picked = new Set();
    const view = { kind: 'all', q: '' };

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
        // Отмеченное, чего в акте больше нет, забывается: счёт с номером строки,
        // которой не существует, — это отказ сервера в лицо кассиру.
        const alive = new Set(lines.map((l) => l.id));
        for (const id of [...picked]) if (!alive.has(id)) picked.delete(id);
        const pending = lines.filter((l) => l.billable && !l.invoice_id);

        // Шапка перерисовывается вместе с выбором: цифра на кнопке «Выставить
        // счёт» — это ровно то, что отмечено галочками.
        const paintHead = () => {
            clear(head);
            head.appendChild(h('b', null, tr('Акт выполненных работ')));
            head.appendChild(h('span', { class: 'grow' }));
            if (onInvoice && lines.length) {
                const n = picked.size || pending.length;
                head.appendChild(h('button', {
                    class: 'btn btn-primary btn-sm', type: 'button', disabled: !n,
                    title: picked.size
                        ? tr('Выставить счёт на отмеченные строки')
                        : tr('Выставить счёт на всё, что ещё не выставлено'),
                    onclick: () => onInvoice(load, picked.size ? [...picked] : null),
                }, Icon('Receipt', { size: 14 }), ' ',
                    n ? trf('Выставить счёт ({n})', { n }) : tr('Выставить счёт')));
            }
            if (onAddExpense) {
                head.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => onAddExpense(load) },
                    Icon('Plus', { size: 14 }), ' ', tr('Добавить расход')));
            }
            if (lines.length && onPrint) {
                head.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => onPrint(data) },
                    Icon('Print', { size: 14 }), ' ', tr('Печать')));
            }
            if (lines.length) {
                head.appendChild(h('button', {
                    class: 'btn btn-outline btn-sm', type: 'button',
                    title: tr('Скачать реестр таблицей — открывается в Excel'),
                    onclick: () => downloadCsv(actCsv(data), 'act-' + ((data && data.admission_no) || admissionId) + '.csv'),
                }, Icon('Download', { size: 14 }), ' ', tr('Excel')));
            }
        };
        paintHead();

        if (!lines.length) {
            body.appendChild(empty('Этой госпитализации ещё ничего не начислено.'));
            return;
        }

        // Фильтры реестра: чем строка является и поиск по наименованию.
        const KINDS = [['all', 'Всё'], ['service', 'Услуги'], ['item', 'Расходники'], ['stay', 'Койко-дни']];
        const chips = h('div', { class: 'cf-filter' });
        const table = h('div', { class: 'cf-tblwrap' });
        const paint = () => {
            clear(chips);
            for (const [id, label] of KINDS) {
                const n = id === 'all' ? lines.length : lines.filter((l) => l.kind === id).length;
                if (!n) continue;
                chips.appendChild(h('button', {
                    class: 'cf-fchip' + (view.kind === id ? ' on' : ''), type: 'button',
                    onclick: () => { view.kind = id; paint(); },
                }, tr(label), h('span', { class: 'cf-fchip-n' }, String(n))));
            }
            chips.appendChild(h('span', { class: 'grow' }));
            chips.appendChild(h('input', {
                class: 'input cf-fsearch', type: 'search', value: view.q,
                placeholder: 'Поиск по наименованию',
                oninput: (e) => { view.q = e.target.value; paint(); },
            }));

            const q = view.q.trim().toLowerCase();
            const shown = lines.filter((l) => (view.kind === 'all' || l.kind === view.kind)
                && (!q || String(l.name || '').toLowerCase().includes(q)));
            const pickable = shown.filter((l) => !l.locked && l.billable);
            const allOn = pickable.length > 0 && pickable.every((l) => picked.has(l.id));

            clear(table);
            table.appendChild(h('table', { class: 'cf-act' },
                h('thead', null, h('tr', null,
                    h('th', { class: 'cf-act-pick' }, pickable.length
                        ? h('input', { type: 'checkbox', checked: allOn, 'aria-label': tr('Выбрать все строки'),
                            onchange: () => {
                                for (const l of pickable) { if (allOn) picked.delete(l.id); else picked.add(l.id); }
                                paint(); paintHead();
                            } })
                        : null),
                    ...ACT_COLS.map((label, i) => h('th', { class: [3, 5, 6, 7].includes(i) ? 'num' : null }, tr(label))),
                    h('th', null, ''))),
                h('tbody', null, ...shown.map((l) => actRow(l, {
                    selected: picked.has(l.id),
                    onSelect: (line, on) => { if (on) picked.add(line.id); else picked.delete(line.id); paint(); paintHead(); },
                    onBillable: async (line, on) => {
                        const { error: e2 } = await supabase.rpc('admission_charge_set_billable',
                            { line_id: line.id, billable: on });
                        if (e2) { toast(e2.message || tr('Не удалось изменить строку.'), 'fail'); return; }
                        await load();
                    },
                })))));
            if (!shown.length) table.appendChild(empty('По этому фильтру строк нет.'));
        };

        body.appendChild(chips);
        body.appendChild(table);
        paint();

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

// ---------------------------------------------------------------------------
// 6. Койки и переводы
// ---------------------------------------------------------------------------
/* i18n-exempt-start: ключи слева — значения admission_transfers.kind в базе */
const MOVE_WORD = {
    admit: 'Размещение', transfer: 'Перевод', return_home: 'Домашний отпуск',
    discharge: 'Выписка', discharge_cancel: 'Отмена выписки', admitted_at: 'Правка даты поступления',
};
/* i18n-exempt-end */
const bedLine = (ward, bed) => [ward, bed].filter(Boolean).join(' · ') || '—';

/**
 * КОЙКИ И ПЕРЕВОДЫ — лента размещений пациента.
 *
 * CASE_TABS_FULL_V1 — журнал переводов ведётся с самого начала
 * (admission_transfers, миграция 025) и по нему считается проживание, но в
 * истории болезни его было не видно: «где лежит сейчас» знала шапка, «где лежал
 * вчера» — никто. Журнал ДОПИСЫВАЕТСЯ, а не правится, поэтому здесь он только
 * читается: перевод делают в «Стационаре», где для этого есть и койки, и права.
 */
export function caseBedsPanel(admissionId, overview) {
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Койки и переводы') });
    box.appendChild(h('div', { class: 'cf-pane-h' }, h('b', null, tr('Койки и переводы'))));

    const a = (overview && overview.admission) || {};
    box.appendChild(h('div', { class: 'cf-body' },
        h('div', { class: 'cf-row-t' }, bedLine(a.ward_name, a.bed_code)),
        h('div', { class: 'cf-row-m' }, tr('Где пациент лежит сейчас'))));

    const body = h('div', { class: 'cf-body' }, h('div', { class: 'cf-row-m' }, tr('Загружаем ленту размещений…')));
    box.appendChild(body);

    (async () => {
        const { data, error } = await supabase.from('admission_transfers')
            .select('id, kind, reason, transferred_at, from_bed_id(code), to_bed_id(code), '
                  + 'from_ward_id(name), to_ward_id(name)')
            .eq('admission_id', admissionId).order('transferred_at');
        clear(body);
        if (error) {
            body.appendChild(h('div', { class: 'cf-row-m' },
                trf('Лента не загрузилась: {msg}', { msg: error.message || '' })));
            return;
        }
        const rows = data || [];
        if (!rows.length) {
            body.appendChild(empty('Переводов не было: пациент лежит там же, куда его положили.'));
            return;
        }
        box.appendChild(h('div', { class: 'cf-group' }, tr('Лента размещений')));
        box.appendChild(h('ul', { class: 'cf-list' }, ...rows.map((r) => {
            const to = bedLine(r.to_ward_id && r.to_ward_id.name, r.to_bed_id && r.to_bed_id.code);
            const from = bedLine(r.from_ward_id && r.from_ward_id.name, r.from_bed_id && r.from_bed_id.code);
            return h('li', { class: 'cf-row' },
                h('div', { class: 'cf-row-main' },
                    h('div', { class: 'cf-row-t' }, tr(MOVE_WORD[r.kind] || MOVE_WORD.transfer)),
                    h('div', { class: 'cf-row-m' }, r.kind === 'transfer' && from !== '—'
                        ? trf('{from} → {to}', { from, to })
                        : to),
                    r.reason ? h('div', { class: 'cf-row-m' }, r.reason) : null),
                h('span', { class: 'cf-when' }, when(r.transferred_at)));
        })));
    })();

    return box;
}

// ---------------------------------------------------------------------------
// 7. Питание
// ---------------------------------------------------------------------------
/**
 * ПИТАНИЕ — действующий стол, его история и сегодняшние отметки.
 *
 * Блок стола здесь ТОТ ЖЕ, что в карточке госпитализации (dietSection): он уже
 * знает и историю периодов, и право на смену стола — а право это считает
 * сервер, и вторая его копия разошлась бы с первой молча. Берётся он поздним
 * импортом: карточка тянет за собой редактор документов, и статическая ссылка
 * замкнула бы круг модулей.
 */
export function caseMealsPanel(admissionId, overview, { onChange = null } = {}) {
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Питание') });
    box.appendChild(h('div', { class: 'cf-pane-h' }, h('b', null, tr('Питание'))));

    const meals = (overview && overview.diet && overview.diet.meals_today) || null;
    if (meals) {
        box.appendChild(h('div', { class: 'cf-body' },
            h('div', { class: 'cf-row-m' }, trf('Сегодня: съедено {eaten}, отказов {refused}',
                { eaten: meals.eaten || 0, refused: meals.refused || 0 }))));
    }

    const body = h('div', { class: 'cf-body' }, h('div', { class: 'cf-row-m' }, tr('Загружаем стол…')));
    box.appendChild(body);

    (async () => {
        const [{ data, error }, mod] = await Promise.all([
            supabase.rpc('admission_diet_history', { admission_id: admissionId }),
            import('./admission-modal.js?v=inp2'),
        ]);
        clear(body);
        if (error) {
            body.appendChild(h('div', { class: 'cf-row-m' },
                trf('Стол не загрузился: {msg}', { msg: error.message || '' })));
            return;
        }
        const admission = (overview && overview.admission) || { id: admissionId };
        const section = mod.dietSection(Object.assign({ id: admissionId }, admission), data, () => {
            if (onChange) onChange();
        });
        if (section) body.appendChild(section);
        else body.appendChild(empty('Стол этой госпитализации закрыт для вашей роли.'));
    })();

    return box;
}

// ---------------------------------------------------------------------------
// 8. Счета
// ---------------------------------------------------------------------------
/* i18n-exempt-start: ключи слева — значения invoices.status в базе */
const INV_WORD = {
    unpaid: 'Не оплачен', partial: 'Оплачен частично', paid: 'Оплачен',
    debt: 'Долг', void: 'Аннулирован', refunded: 'Возврат',
};
/* i18n-exempt-end */
const INV_TONE = { paid: 'cf-chip-ok', debt: 'cf-chip-hot', void: 'cf-chip-off', refunded: 'cf-chip-off' };

/**
 * СЧЕТА ГОСПИТАЛИЗАЦИИ — что уже выставлено и что из этого оплачено.
 *
 * Считает СЕРВЕР (admission_overview.bill): итог, оплачено и долг приходят
 * готовыми, и это те же цифры, что видит касса. Деньги принимает касса — здесь
 * их не принимают и не правят: счёт живёт своей жизнью после выставления.
 */
export function caseInvoicesPanel(overview, { onCashier = null } = {}) {
    const bill = (overview && overview.bill) || {};
    const rows = bill.invoices || [];
    const box = h('section', { class: 'card cf-pane', 'aria-label': tr('Счета') });
    box.appendChild(h('div', { class: 'cf-pane-h' },
        h('b', null, tr('Счета')),
        h('span', { class: 'grow' }),
        onCashier && rows.length
            ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => onCashier() },
                Icon('Wallet', { size: 14 }), ' ', tr('Касса'))
            : null));

    if (!rows.length) {
        box.appendChild(empty('Счетов по этой госпитализации ещё нет. Их выставляют в акте выполненных работ.'));
        return box;
    }

    box.appendChild(h('div', { class: 'cf-tblwrap' }, h('table', { class: 'cf-act' },
        h('thead', null, h('tr', null,
            h('th', null, tr('Счёт')),
            h('th', { class: 'num' }, tr('Дата')),
            h('th', { class: 'num' }, tr('Сумма')),
            h('th', { class: 'num' }, tr('Оплачено')),
            h('th', null, tr('Статус')))),
        h('tbody', null, ...rows.map((i) => h('tr', null,
            h('td', null, h('div', { class: 'cf-row-t' }, i.invoice_number || ('#' + i.id))),
            h('td', { class: 'num' }, day(i.created_at)),
            h('td', { class: 'num cf-act-sum' }, money(i.total_amount)),
            h('td', { class: 'num' }, money(i.paid_amount)),
            h('td', null, h('span', { class: 'cf-chip ' + (INV_TONE[i.status] || 'cf-chip-inv') },
                tr(INV_WORD[i.status] || INV_WORD.unpaid)))))))));

    const sum = (label, value, cls) => h('div', { class: 'cf-sum' + (cls ? ' ' + cls : '') },
        h('span', { class: 'cf-sum-l' }, tr(label)),
        h('span', { class: 'cf-sum-v' }, money(value) + ' ' + tr('сум')));
    box.appendChild(h('div', { class: 'cf-sums' },
        sum('Выставлено', bill.total),
        sum('Оплачено', bill.paid),
        bill.debt ? sum('Долг', bill.debt, 'cf-sum-hot') : null));
    return box;
}
