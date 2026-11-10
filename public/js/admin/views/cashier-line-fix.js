// CASHIER_HEAD_V1 (2026-09-28) — «ИСПРАВИТЬ УСЛУГИ» У КАССЫ.
//
// Владелец: «fix in the roles for the cashier, so it can change service and
// provider for appointed + add service, and if created invoice. It should be
// switchable in the roles so cashier either only accepts [payments] or accepts
// and makes small fixes».
//
// Окно открывается из строки счёта в «Приёме оплат», и ТОЛЬКО у того, кому
// выдано право «Исправляет услуги в счёте» (permissions.js canFixCashierLines;
// регистратура и администратор — по своей роли). Без права касса выглядит как
// вчера: кассир только принимает оплату.
//
// Что можно — ровно то, что пускает сервер (rpc/billing.js, двери
// cashier_line_*): у строки счёта, по которому ещё не принято денег, —
// «Изменить» (услуга и исполнитель в одном окне — CASHIER_LINE_EDIT_V1, openLineEdit) и
// «Убрать»; внизу — «+ Добавить услугу».
// Цены экран не считает и не присылает: их считает сервер (личная цена врача,
// тариф визита, скидка группы), экран лишь показывает, во сколько обойдётся
// строка у каждого врача (cashier_line_performers). Отказ сервера показывается
// его же словами.
//
// CASHIER_PAID_SWAP_V1 (2026-09-28) — владелец: «paid bills: we cannot change
// the service — [we need to] make a refund or bill more if the price is
// different». В ОПЛАЧЕННОМ счёте (у кассира или администратора с тем же
// правом) у неначатой строки тоже есть «Заменить услугу» и «Сменить врача»:
// окно подтверждения до нажатия показывает, что будет с деньгами
// (cashier_line_swap_quote — та же замена в откатываемой транзакции):
// сколько вернуть пациенту и куда (тем же способом или на баланс) или сколько
// доплатить. Возврат сервер проводит сразу и печатается квитанция «Возврат
// разницы»; доплата — окно оплаты кассы (чек с пометкой «Доплата»).
// «Выставить заново» (openRebill) — невыставленные строки визита отменённого
// счёта: поменять услугу или врача, выставить счёт и принять оплату.
import { supabase } from '../../supabase.js';
import { loadVisitOrders, orderedMatch, orderedLabel } from './dup-order-check.js';   // DUP_STOP_V1 — «уже назначено» в окне выбора услуги
import { h, Icon, clear, toast, fmtDate } from '../ui.js';   // fmtDate: REFERRAL_BILL_V1 — день визита в пояснении «со дня визита»
import { tr, trf } from '../i18n.js';
import { canFixCashierLines, canSwapPaidLines } from '../permissions.js';
import { localYmd } from '../discount-rules.js';   // REFERRAL_BILL_V1 — местный день, как у остальной кассы
import { TUBE_STATUSES } from './lab-tube.js';   // LAB_TUBE_LABEL_V1 (ревью U11, M3/L5) — статусы строк, у которых есть пробирка
import { serviceRoute, performerRequired, ROUTE_SELECT } from '../../shared/service-route.js';   // LAB_NO_DOCTOR_V1 — performerRequired вместо needsPerformer   // DIAG_ROUTE_V1 (3.22.0) — анализ ли услуга решает группа (ревью L-5); услуге кабинета нужен исполнитель и у кассы (I-4)

// Работа по строке начата или сделана — сервер её не меняет (PERFORMED_LINE_STATUSES).
const PERFORMED = ['collected', 'in_progress', 'resulted', 'completed'];

function fmtSum(n) {
    const v = Math.round(Number(n) || 0);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Показывать ли у счёта кнопку «Исправить услуги». */
export function canOfferLineFix(inv) {
    if (!inv || !inv.visit_id) return false;                      // стационар, депозит, карта — не визит
    if (inv.status === 'void' || inv.status === 'refunded') return false;
    if (inv.payer_id) return false;                               // счёт плательщику правят не у кассы
    const no = String(inv.invoice_number || '');
    if (no.startsWith('DEP-') || no.startsWith('CARD-')) return false;
    return canFixCashierLines();
}

/** По счёту ещё не принято денег: строки в нём можно править. */
export function invoiceEditable(inv) {
    if (!inv) return false;
    if (Number(inv.paid_amount) > 0) return false;
    return inv.status === 'unpaid' || (inv.status === 'paid' && !(Number(inv.total_amount) > 0));
}

/**
 * CASHIER_PAID_SWAP_V1 — деньги по счёту уже есть, и строки в нём меняют С
 * РАСЧЁТОМ разницы: оплачен, частично или долг. Счёт плательщику — никогда.
 */
export function invoiceSwappable(inv) {
    if (!inv || invoiceEditable(inv) || inv.payer_id) return false;
    return inv.status === 'paid' || inv.status === 'partial' || inv.status === 'debt';
}

function newIdemKey() {
    try { if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID(); } catch (e) { /* ниже запасной */ }
    return 'k' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

const METHOD_RU = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод', acquiring: 'Эквайринг', wallet: 'С баланса', gift_card: 'Подарочная карта' };
// Куда уйдёт часть возврата — словами кассы.
function refundWhere(x) {
    if (x.to_card) return tr('На ту же подарочную карту');
    if (x.to_balance) return tr('На баланс пациента');
    return tr(METHOD_RU[x.refund_method] || x.refund_method || '');
}
function cashierName() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || {};
    return u.full_name || u.username || '';
}

/** Строку можно править: услуга (не товар) и работа по ней не начата. */
export function lineFixable(line) {
    return !!line && line.clinic_item_id == null && !PERFORMED.includes(line.status);
}

// Окно того же вида, что у кассы (cashier-desk.js modal): затемнение, карточка,
// шапка с крестиком. Возвращает тело и закрытие.
function sheet(title, icon, width, onClose = null) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); if (onClose) onClose(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const body = h('div', { class: 'modal-body' });
    const foot = h('footer', { class: 'modal-foot' });
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: width + 'px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon(icon, { size: 16 }), ' ', title),
            h('button', { class: 'modal-close', type: 'button', 'aria-label': tr('Закрыть'), onclick: close }, '×')),
        body, foot));
    document.body.appendChild(overlay);
    return { overlay, body, foot, close };
}

/** DUP_STOP_V1 (ревью m5) — врач строки: doctor_id(id, full_name) приходит объектом, иначе — числом. */
function lineDoctorId(line) {
    const d = line && line.doctor_id;
    if (d && typeof d === 'object') return d.id ?? null;
    return d ?? null;
}

let servicesCache = null;
async function loadServices() {
    if (servicesCache) return servicesCache;
    const { data, error } = await supabase.from('services')
        .select('id, name, price, requires_doctor, ' + ROUTE_SELECT)   // CASHIER_LINE_EDIT_V1 — type, is_lab — в ROUTE_SELECT (без повтора колонок).eq('active', 1).order('name', { ascending: true }).limit(5000);   // REFUND_SWAP_V1 — is_lab, type: окно замены называет, что новый анализ уйдёт в лабораторию
    if (error) throw error;
    servicesCache = data || [];
    return servicesCache;
}

/**
 * Выбор услуги: поиск по названию. Промис: услуга или null (закрыли окно).
 * DUP_STOP_V1 — `visitId`: услуги, уже назначенные в этом визите, погашены («уже
 * назначено») — замена или добавление на них — повтор, сервер откажет (409). Строка,
 * которую меняют (`exceptLineId`), не мешает: ту же услугу у другого врача выбрать можно.
 * DUP_STOP_V1 (ревью m5) — `doctorId`: врач, который останется у строки (замена услуги его
 * не меняет). Консультация, уже назначенная у этого врача, — повтор: погашена; у другого — нет.
 */
export function pickService(title, { visitId = null, exceptLineId = null, doctorId = null } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (done) return; done = true; resolve(v); };
        const s = sheet(title, 'Search', 480, () => finish(null));
        const search = h('input', { type: 'search', placeholder: tr('Название услуги'), 'aria-label': tr('Поиск услуги'), style: { width: '100%' } });
        const list = h('div', { style: { marginTop: '10px', maxHeight: '360px', overflowY: 'auto', display: 'grid', gap: '4px' } });
        s.body.appendChild(search);
        s.body.appendChild(list);
        s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, 'Отмена'));
        let all = [];
        let ordered = [];   // DUP_STOP_V1 — назначенное в визите
        const paint = () => {
            clear(list);
            const q = String(search.value || '').trim().toLowerCase();
            const rows = (q ? all.filter((x) => String(x.name || '').toLowerCase().includes(q)) : all).slice(0, 60);
            if (!rows.length) { list.appendChild(h('div', { class: 'muted', style: { padding: '8px' } }, 'Ничего не найдено.')); return; }
            for (const svc of rows) {
                const onVisit = orderedMatch(svc, ordered, doctorId);   // DUP_STOP_V1 · ревью m5 — врач строки
                const locked = !!(onVisit && onVisit.blocked);
                list.appendChild(h('button', {
                    type: 'button', class: 'btn btn-ghost', 'data-service-id': String(svc.id), disabled: locked,
                    title: locked ? tr('уже назначено') : undefined,
                    style: { justifyContent: 'space-between', display: 'flex', width: '100%', textAlign: 'left', opacity: locked ? '0.55' : '1' },
                    onclick: () => { if (locked) return; finish(svc); s.overlay.remove(); },
                }, h('span', null, svc.name || '—',
                    onVisit ? h('span', { class: 'muted', 'data-ordered': '' }, ' — ', orderedLabel(onVisit)) : null),
                h('span', { class: 'num muted' }, fmtSum(svc.price), ' ', tr('сум'))));
            }
        };
        search.addEventListener('input', paint);
        // DUP_STOP_V1 (ревью m3) — door: двери кассы сети R7b не зовут: строка записи колл-центра
        // для них назначение, и окно гасит её так же, как откажет cashier_line_add.
        Promise.all([loadServices(), loadVisitOrders({ visitId, door: 'cashier' })]).then(([rows, got]) => {
            all = rows;
            ordered = (got.ordered || []).filter((o) => Number(o.id) !== Number(exceptLineId));   // DUP_STOP_V1
            paint();
        })
            .catch((e) => { clear(list); list.appendChild(h('div', { style: { color: 'var(--crit-600)' } }, trf('Не удалось загрузить: {msg}', { msg: (e && e.message) || e }))); });
    });
}

/**
 * Выбор исполнителя. `args` — для cashier_line_performers. Промис: { id } |
 * { id: null } («без врача», если услуге врач не нужен) | null (закрыли окно).
 * REFUND_SWAP_V1 — вместе с id приходят имя и цена строки у этого
 * исполнителя (full_name, unit_price): окно замены показывает выбранного.
 */
// DIAG_ROUTE_V1 (I-4, 3.22.0) — `service`: услуга строки. Услуга кабинета (needsPerformer —
// то же правило, что у регистратуры) без исполнителя не видна ни одному кабинету
// (SERVICE_SCOPE_V3), поэтому «Без врача» ей не предлагается и у кассы; единственный
// исполнитель выбирается сам.
export function pickPerformer(title, args, { allowNone = false, service = null } = {}) {
    const mustPick = !!(service && performerRequired(service));   // LAB_NO_DOCTOR_V1
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (done) return; done = true; resolve(v); };
        const s = sheet(title, 'Stethoscope', 460, () => finish(null));
        const list = h('div', { style: { display: 'grid', gap: '4px', maxHeight: '380px', overflowY: 'auto' } },
            h('div', { class: 'muted', style: { padding: '8px' } }, 'Загрузка…'));
        s.body.appendChild(list);
        s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, 'Отмена'));
        const pick = (v) => { finish(v); s.overlay.remove(); };
        supabase.rpc('cashier_line_performers', args).then(({ data, error }) => {
            clear(list);
            if (error) { list.appendChild(h('div', { style: { color: 'var(--crit-600)' } }, error.message || tr('Не удалось загрузить.'))); return; }
            const people = (data && data.performers) || [];
            // DIAG_ROUTE_V1 (I-4) — один кандидат у услуги кабинета — выбран сам.
            if (mustPick && people.length === 1) {
                const p = people[0];
                pick({ id: p.id, full_name: p.full_name || null, unit_price: p.unit_price });
                return;
            }
            if (allowNone && !mustPick && !(data && data.requires_doctor)) {
                list.appendChild(h('button', { type: 'button', class: 'btn btn-ghost', 'data-performer': 'none', style: { justifyContent: 'space-between', display: 'flex', width: '100%' }, onclick: () => pick({ id: null, full_name: null, unit_price: data && data.catalog_price }) },
                    h('span', null, 'Без врача'), h('span', { class: 'num muted' }, fmtSum(data && data.catalog_price), ' ', tr('сум'))));
            }
            if (!people.length) list.appendChild(h('div', { class: 'muted', style: { padding: '8px' } }, 'Нет сотрудников, которые оказывают эту услугу.'));
            for (const p of people) {
                list.appendChild(h('button', {
                    type: 'button', class: 'btn btn-ghost', 'data-performer': String(p.id),
                    style: { justifyContent: 'space-between', display: 'flex', width: '100%', textAlign: 'left' },
                    onclick: () => pick({ id: p.id, full_name: p.full_name || null, unit_price: p.unit_price }),
                },
                h('span', null, p.full_name || ('#' + p.id), p.specialty ? h('span', { class: 'muted' }, ' · ', p.specialty) : null),
                h('span', { class: 'num' }, fmtSum(p.unit_price), ' ', tr('сум'))));
            }
        });
    });
}

async function loadInvoiceState(invoiceId) {
    const { data: invoice } = await supabase.from('invoices')
        .select('id, invoice_number, visit_id, status, subtotal, discount_amount, total_amount, paid_amount, payer_id')
        .eq('id', invoiceId).maybeSingle();
    if (!invoice) return { invoice: null, items: [], lines: [] };
    const { data: items } = await supabase.from('invoice_items')
        .select('id, description, total, discount_amount').eq('invoice_id', invoiceId).order('id', { ascending: true });
    const ids = (items || []).map((i) => i.id);
    let lines = [];
    if (ids.length) {
        const { data } = await supabase.from('visit_services')
            .select('id, service_id, status, total, invoice_item_id, clinic_item_id, consultation_type_id, services(name, is_lab, type), doctor_id(id, full_name)')   // services: LAB_TUBE_LABEL_V1 (К4) — прежняя услуга — анализ?
            .in('invoice_item_id', ids);
        lines = data || [];
    }
    return { invoice, items: items || [], lines };
}

async function runRpc(name, args, okText) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) { toast(error.message || tr('Не удалось.'), 'fail'); return null; }
    if (okText) toast(okText, 'ok');
    return data || {};
}

// CASHIER_LINE_EDIT_V1 — прежнее окно подтверждения замены в оплаченном счёте (openSwapConfirm)
// ушло в окно «Изменить» (openLineEdit, режим 'swap'): разница считается и проводится там же.

// ═══════════════════════════════════════════════════════════════════════════
// REFUND_SWAP_V1 (2026-10-29) — «ЗАМЕНИТЬ УСЛУГУ» В ОКНЕ «ПЛАТЕЖИ».
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец (3.19.0): обычный путь кассира был 6–7 шагов — вернуть услугу,
// регистратура добавляет новую, новый счёт, оплата, чек. Теперь у каждой
// услуги оплаченного счёта рядом с «Вернуть услугу» стоит «Заменить услугу»
// (кнопку рисует касса, cashier-desk.js openInvoiceRefund, по
// canSwapPaidLines: право «Исправляет услуги в счёте» и денежная роль).
// Одно окно: новая услуга и исполнитель выбираются вместе, цену и разницу
// считает сервер (cashier_line_swap_quote — та же замена в откатываемой
// транзакции: тариф визита, своя цена врача, скидка группы пациента).
// Разница — крупно:
//   • дешевле — «Вернуть деньгами» (каждый платёж тем же способом, что
//     платили; наличные — из кассы текущей смены) или «На баланс пациента»;
//   • дороже — после замены касса открывает окно оплаты «Доплата» (`onDone`);
//     закрыли его без оплаты — разница остаётся долгом счёта.
// По услуге уже начата работа — это решает сервер: `work.performed` из
// invoice_line_work (то же правило lineHasWork, что у замены и возврата) или
// отказ замены с кодом line_performed (работа началась, пока окно открыто).
// Перенести её нельзя, и окно предлагает «Вернуть эту услугу и выставить
// новую» — одну операцию сервера (cashier_line_rebill_quote /
// cashier_line_rebill_paid): прежняя строка остаётся в карте невыставленной и
// врачу не оплачивается, новая встаёт в тот же визит и счёт, разница — по тем
// же правилам. Предпросмотр возврата с новой отдаёт `line: null` (его строка
// откатана) — окно читает только подписи и суммы. Анализ меняют на анализ —
// окно говорит, что новый уйдёт в лабораторию новым заказом, а у возврата с
// новой — что пробу отметят заново. Пока замена в пути, окно ничего не
// меняет (busy). `onDone(r)` получает ответ сервера (`rebill: true` — второй путь).
// DIAG_ROUTE_V1 (3.22.0, ревью L-5) — то же правило, что у очереди лаборатории (serviceRoute).
export const cashierIsLabService = (s) => !!s && serviceRoute(s) === 'lab';
const isLabService = cashierIsLabService;
/** CASHIER_LINE_EDIT_V1 — нужен ли услуге исполнитель у кассы: анализу — никогда; кабинету и «специалисту» — да. */
export const cashierNeedsPerformer = (s) => !!s && serviceRoute(s) !== 'lab' && performerRequired(s);   // LAB_NO_DOCTOR_V1

// LAB_TUBE_LABEL_V1 (ревью U11, M3) — строка анализа в работе лаборатории (ждёт
// забора … результаты внесены — статусы пробирки, lab-tube.js): её номер мог уйти
// на этикетку пробирки. «Вернуть услугу» такой строки напоминает перепечатать
// этикетку (cashier-desk.js openLineRefundConfirm).
export const openLabTubeLine = (line) => !!line && isLabService(line.services) && TUBE_STATUSES.includes(line.status);

// LAB_TUBE_LABEL_V1 (ревью U11, L5) — двери замены без денег («Исправить услуги»
// до оплаты, «Выставить заново»): та же строка, другая услуга. Если строка могла
// стоять в пробирке (`could`: отпущена в лабораторию — или за неё вернули деньги) и
// прежняя или новая услуга — анализ, этикетка устарела: напоминание — те же слова,
// что у замены в «Платежах» (К4). Строка, которая в лабораторию не уходила, —
// без напоминания: этикетки у неё не было.
function reprintNote(line, svc, could) {
    return could && (isLabService(line && line.services) || isLabService(svc)) ? ' · ' + tr('Перепечатайте этикетку пробирки.') : '';
}

export async function openRefundSwap(inv, item, line, { work = null, onDone = null } = {}) {
    let svc = null;            // новая услуга { id, name, price, is_lab, type }
    let who = null;            // исполнитель { id, full_name } или { id: null } — «Без врача»
    let dest = 'original';     // разница: тем же способом или на баланс пациента
    let rebill = !!(work && work.performed);   // работа начата — по слову сервера, не по статусу на экране
    let quote = null;
    let seq = 0;               // ответ устаревшего предпросмотра не рисуется
    let idemKey = newIdemKey();   // ключ окна: двойное нажатие не проведёт деньги дважды
    // Ревью A3 — пока замена в пути, окно ничего не меняет и не пересчитывает:
    // второй щелчок, «куда вернуть», выбор услуги и исполнителя молчат.
    let busy = false;
    let pickBtns = [];
    let radios = [];
    const setBusy = (on) => {
        busy = on;
        for (const el of [...pickBtns, ...radios]) el.disabled = on;
    };
    const oldLab = isLabService(line && line.services);
    const s = sheet(trf('Заменить услугу · {name}', { name: item.description || '—' }), 'Repeat', 560);
    const intro = h('div', { class: 'muted', 'data-refund-swap-intro': '', style: { fontSize: '12.5px', lineHeight: 1.5 } });
    const picks = h('div', { style: { display: 'grid', gap: '8px', marginTop: '10px' } });
    const labNote = h('div');
    const body = h('div', { style: { display: 'grid', gap: '8px', marginTop: '10px' } });
    s.body.appendChild(intro);
    s.body.appendChild(picks);
    s.body.appendChild(labNote);
    s.body.appendChild(body);
    const okBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, tr('Заменить'));
    s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, 'Отмена'));
    s.foot.appendChild(h('span', { class: 'grow' }));
    s.foot.appendChild(okBtn);
    const kv = (k, v) => h('div', { class: 'row', style: { gap: '10px', fontSize: '13.5px', fontWeight: 500, alignItems: 'baseline' } },
        h('span', { style: { flex: 1, color: 'var(--ink-600)' } }, k), h('span', { class: 'num' }, v));
    const big = (label, sum, attr) => h('div', { [attr]: String(sum), style: { display: 'flex', gap: '10px', alignItems: 'baseline', marginTop: '6px' } },
        h('span', { style: { flex: 1, fontSize: '15px', fontWeight: 800 } }, label),
        h('span', { class: 'num', style: { fontSize: '24px', fontWeight: 800 } }, fmtSum(sum) + ' ' + tr('сум')));
    const doc = line && line.doctor_id && typeof line.doctor_id === 'object' ? line.doctor_id : null;
    const was = (item.description || '—') + (doc && doc.full_name ? ', ' + doc.full_name : '')
        + ' · ' + fmtSum(Math.max(0, Number(item.total || 0) - Number(item.discount_amount || 0))) + ' ' + tr('сум');

    const paintIntro = () => {
        clear(intro);
        intro.appendChild(h('span', null, rebill
            ? tr('По этой услуге уже начата работа (взята проба, есть результат, документ или идёт приём) — перенести её на другую услугу нельзя. Эта услуга вернётся: работа останется в карте пациента, врачу она не оплачивается. Новая услуга будет выставлена в тот же визит и счёт.')
            : tr('Выберите новую услугу и исполнителя. Цену и разницу считает программа.')));
    };
    // Анализ меняют на анализ: лаборатория получит новый заказ. У возврата с
    // новой проба прежнего анализа уже взята — лаборатория отметит её для
    // нового заново (можно из той же пробирки); у обычной замены пробы ещё нет.
    const paintLab = () => {
        clear(labNote);
        if (!(oldLab && svc && isLabService(svc))) return;
        labNote.appendChild(h('div', { 'data-swap-lab': '1', role: 'note', style: { marginTop: '8px', padding: '9px 12px', borderRadius: '10px', background: 'var(--warn-50, #fffbeb)', color: 'var(--warn-700, #b45309)', fontSize: '12.5px', lineHeight: 1.5 } },
            rebill
                ? tr('Новый анализ уйдёт в лабораторию новым заказом, и лаборатория заново отметит взятие пробы — можно из той же пробирки.')
                : tr('Новый анализ уйдёт в лабораторию новым заказом.')));
    };
    const paintPicks = () => {
        clear(picks);
        picks.appendChild(kv(tr('Было'), was));
        const svcBtn = h('button', { class: 'btn btn-sm', type: 'button', 'data-pick': 'service', onclick: () => chooseService() }, svc ? tr('Изменить') : tr('Выбрать услугу'));
        const needWho = !svc || cashierNeedsPerformer(svc);   // CASHIER_LINE_EDIT_V1
        const whoBtn = needWho ? h('button', { class: 'btn btn-sm', type: 'button', 'data-pick': 'performer', disabled: svc ? null : true, onclick: () => { if (svc) choosePerformer(); } }, tr('Выбрать')) : null;
        pickBtns = svc && whoBtn ? [svcBtn, whoBtn] : [svcBtn];
        picks.appendChild(h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', fontSize: '13.5px' } },
            h('span', { style: { flex: 1, color: 'var(--ink-600)' } }, tr('Новая услуга')),
            h('span', { class: 'cell-strong', 'data-picked-service': svc ? String(svc.id) : '' }, svc ? (svc.name || '—') : '—'),
            svcBtn));
        picks.appendChild(h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', fontSize: '13.5px' } },
            h('span', { style: { flex: 1, color: 'var(--ink-600)' } }, tr('Исполнитель')),
            h('span', { class: 'cell-strong', 'data-picked-performer': who ? (who.id == null ? 'none' : String(who.id)) : '' },
                who ? (who.id == null ? (needWho ? tr('Без врача') : tr(ROUTE_WORD[serviceRoute(svc)] || 'Без врача')) : (who.full_name || ('#' + who.id))) : '—'),
            whoBtn));
        paintLab();
    };
    // Работа по строке начата, а окно было на обычной замене: денег сервер не
    // двигал (отказ line_performed) — окно переходит к «Вернуть эту услугу и
    // выставить новую». Ключ повтора — новый: это другая операция сервера.
    const toRebill = () => {
        rebill = true;
        idemKey = newIdemKey();
        paintIntro();
        paintLab();
    };

    // «Вернуть деньгами» — без to_balance: каждый платёж возвращается своим
    // способом (с баланса — на баланс, картой-сертификатом — на ту же карту).
    // «На баланс пациента» — to_balance; закрытая карта — тем же выбором.
    const callArgs = () => ({
        visit_service_id: line.id,
        new_service_id: svc.id,
        ...(who.id == null ? { no_doctor: true } : { doctor_id: who.id }),
        ...(dest === 'balance' ? { to_balance: true, card_fallback: 'balance' } : { card_fallback: 'cash' }),
    });
    const quoteRpc = (args) => (rebill
        ? supabase.rpc('cashier_line_rebill_quote', args)
        : supabase.rpc('cashier_line_swap_quote', args));
    const commitRpc = (args) => (rebill
        ? supabase.rpc('cashier_line_rebill_paid', args)
        : supabase.rpc('cashier_line_swap_paid', args));

    const render = () => {
        clear(body);
        radios = [];
        const q = quote;
        if (q.changed === false) {
            body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Это та же услуга у того же исполнителя — менять нечего.'));
            okBtn.textContent = tr('Заменить');
            return false;
        }
        body.appendChild(kv(tr('Стало'), q.line_after || '—'));
        body.appendChild(kv(tr('Сумма счёта'), fmtSum(q.total_before) + ' → ' + fmtSum(q.total_after) + ' ' + tr('сум')));
        body.appendChild(kv(tr('Уже оплачено'), fmtSum(q.paid_before) + ' ' + tr('сум')));
        const commitLabel = (plain) => (rebill ? tr('Вернуть эту услугу и выставить новую') : plain);
        if (Number(q.refunded) > 0) {
            body.appendChild(big(tr('Вернуть пациенту'), q.refunded, 'data-swap-refund'));
            const destBox = h('div', { style: { display: 'grid', gap: '6px' } });
            for (const [v, label] of [['original', 'Вернуть деньгами'], ['balance', 'На баланс пациента']]) {
                const radio = h('input', { type: 'radio', name: 'refund-swap-dest', value: v, checked: dest === v ? true : null });
                radio.addEventListener('change', () => { if (busy || dest === v) return; dest = v; load(); });
                radios.push(radio);
                destBox.appendChild(h('label', { 'data-swap-dest': v, style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13.5px', cursor: 'pointer' } }, radio, tr(label)));
            }
            body.appendChild(destBox);
            body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, dest === 'balance'
                ? tr('Наличные из кассы не выдаются: сумма ляжет на баланс пациента и пойдёт в оплату следующей услуги.')
                : tr('Тем же способом, каким платили; наличные выдаются из кассы текущей смены.')));
            const plan = h('div', { class: 'muted', style: { fontSize: '12.5px', display: 'grid', gap: '2px' } });
            for (const x of (q.refund_plan || [])) {
                plan.appendChild(h('div', { 'data-swap-plan': x.refund_method || '' }, refundWhere(x) + ' — ' + fmtSum(x.amount) + ' ' + tr('сум')));
            }
            body.appendChild(plan);
            okBtn.textContent = commitLabel(trf('Заменить и вернуть {sum} сум', { sum: fmtSum(q.refunded) }));
        } else if (Number(q.due) > 0) {
            body.appendChild(big(tr('К доплате'), q.due, 'data-swap-due'));
            body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'После замены откроется окно оплаты разницы.'));
            okBtn.textContent = commitLabel(tr('Заменить и принять доплату'));
        } else {
            body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Сумма счёта не меняется — деньги не двигаются.'));
            okBtn.textContent = commitLabel(tr('Заменить'));
        }
        return true;
    };

    const load = async () => {
        if (busy || !svc || !who) return;
        const my = ++seq;
        okBtn.disabled = true;
        clear(body);
        body.appendChild(h('div', { class: 'muted' }, 'Считаем…'));
        let { data, error } = await quoteRpc(callArgs());
        if (my !== seq) return;
        // Работа по строке начата, а экран этого не видел (проба, результат,
        // документ): обычная замена отказала кодом line_performed — окно
        // переходит к «Вернуть эту услугу и выставить новую» и считает заново.
        if (error && error.code === 'line_performed' && !rebill) {
            toRebill();
            ({ data, error } = await quoteRpc(callArgs()));
            if (my !== seq) return;
        }
        if (error || !data) {
            clear(body);
            body.appendChild(h('div', { role: 'alert', style: { color: 'var(--crit-600, #dc2626)' } }, (error && error.message) || tr('Не удалось.')));
            return;
        }
        quote = data;
        okBtn.disabled = !render();
    };

    async function chooseService() {
        if (busy) return;
        const picked = await pickService(tr('Новая услуга'), { visitId: inv && inv.visit_id, exceptLineId: line && line.id });   // DUP_STOP_V1
        if (!picked || busy) return;
        svc = picked;
        who = null;
        quote = null;
        seq++;
        clear(body);
        okBtn.disabled = true;
        paintPicks();
        // CASHIER_LINE_EDIT_V1 — исполнитель — сразу за услугой, но только если он ей нужен: анализу
        // и процедуре — нет (их место — лаборатория и процедурный кабинет), строка уходит без врача.
        if (cashierNeedsPerformer(svc)) { await choosePerformer(); return; }
        who = { id: null, full_name: null };
        paintPicks();
        await load();
    }
    async function choosePerformer() {
        if (busy) return;
        const picked = await pickPerformer(tr('Кто оказывает услугу'), { service_id: svc.id, visit_id: inv.visit_id }, { allowNone: true, service: svc });   // DIAG_ROUTE_V1 (I-4)
        if (!picked || busy) return;
        who = picked;
        paintPicks();
        await load();
    }

    okBtn.addEventListener('click', async () => {
        if (busy || !quote || !svc || !who || quote.changed === false) return;
        setBusy(true);
        okBtn.disabled = true;
        const { data, error } = await commitRpc({ ...callArgs(), idempotency_key: idemKey });
        if (error && error.code === 'line_performed' && !rebill) {
            // Работа началась, пока окно было открыто: замена не прошла, деньги
            // не двигались. Окно называет причину и считает возврат с новой.
            toast(error.message || tr('Не удалось.'), 'info');
            setBusy(false);
            toRebill();
            await load();
            return;
        }
        if (error) { toast(error.message || tr('Не удалось.'), 'fail'); setBusy(false); okBtn.disabled = false; return; }
        s.overlay.remove();
        // LAB_TUBE_LABEL_V1 (К4) — в замене анализ (прежняя или новая услуга): касса
        // напомнит перепечатать этикетку пробирки (cashier-desk.js afterRefundSwap).
        // labNew — новая услуга сама анализ: у «Вернуть эту услугу и выставить
        // новую» только тогда «у нового анализа новый номер».
        if (onDone) await onDone({ ...(data || {}), rebill: rebill || !!(data && data.rebill), lab: oldLab || isLabService(svc), labNew: isLabService(svc) });
    });

    paintIntro();
    paintPicks();
    return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// CASHIER_LINE_EDIT_V1 (владелец, 2026-11-07) — ОДНО ОКНО «ИЗМЕНИТЬ».
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «окно и шаги замены услуги и врача ужасны; даже если меняю на анализ, требует
// врача». Прежде у строки — три кнопки и цепочка окон: «Заменить услугу» (окно поиска),
// «Сменить врача» (окно врачей с «Без врача» среди них), и у анализа — тоже. Теперь у строки
// одна «Изменить»: в одном окне — услуга (поиск, список сразу под ним); под ней исполнитель —
// ТОЛЬКО если услуге он нужен (услуга кабинета или «Услугу оказывает специалист»): отмеченные
// ей сотрудники с их ценой, единственный выбран сам; анализу и процедуре исполнитель не нужен —
// вместо выбора сказано, куда они идут (лаборатория, процедурный кабинет); новая цена — сразу;
// одна «Сохранить». Сменить только врача — «Изменить», врач, «Сохранить». Правила и деньги — те
// же двери сервера:
//   'edit' — денег по счёту нет (или строка без счёта — «Выставить заново»): услуга с
//            исполнителем — одной дверью cashier_line_change_service (doctor_id / no_doctor),
//            только исполнитель — cashier_line_set_doctor;
//   'swap' — деньги по счёту есть: разница — в этом же окне (cashier_line_swap_quote: сколько
//            вернуть и куда или сколько доплатить), «Сохранить» — cashier_line_swap_paid;
//   'add'  — «+ Добавить услугу»: cashier_line_add.
// Нужен ли исполнитель и куда идёт услуга, говорит сервер (cashier_line_performers:
// needs_performer, route) — правило serviceRoute, то же, что у записи и очереди.
const ROUTE_WORD = { lab: 'Лаборатория', procedure: 'Процедурный кабинет' };

/** Строка каталога услуги строки (с полями маршрута, ROUTE_SELECT), иначе — то, что пришло со строкой. */
function lineServiceRow(line) {
    if (!line) return null;
    const hit = (servicesCache || []).find((x) => line.service_id != null && Number(x.id) === Number(line.service_id));
    return hit || line.services || null;
}

/** Подпись под строкой счёта: исполнитель; без него — куда идёт услуга (анализ, процедура) или «Без врача». */
export function lineWhere(line, doc) {
    if (doc && doc.full_name) return doc.full_name;
    const svc = lineServiceRow(line);
    const word = svc ? ROUTE_WORD[serviceRoute(svc)] : null;
    return word ? tr(word) : tr('Без врача');
}

/** Итог окна «Исправить услуги»: к оплате — с учётом уже внесённого; скидка 100 % — словами. */
export function invoiceDueText(inv) {
    const total = Number(inv && inv.total_amount) || 0;
    const paid = Number(inv && inv.paid_amount) || 0;
    const due = Math.max(0, Math.round((total - paid) * 100) / 100);
    if (total === 0 && Number(inv && inv.subtotal) > 0 && Number(inv && inv.discount_amount) > 0) return tr('Скидка 100 % · к оплате 0 сум');
    if (paid > 0) return trf('Итого {total} сум · оплачено {paid} сум · к оплате {due} сум', { total: fmtSum(total), paid: fmtSum(paid), due: fmtSum(due) });
    return trf('К оплате по счёту: {sum} сум', { sum: fmtSum(total) });
}

/**
 * Окно «Изменить» строки (или «Добавить услугу»). Промис: { data, svc, serviceChanged,
 * doctorChanged } — ответ сервера и что изменилось; null — окно закрыли.
 * @param {{mode:'edit'|'swap'|'add', visitId:number, invoiceId?:number, item?:object, line?:object}} a
 */
export function openLineEdit({ mode, visitId, invoiceId = null, item = null, line = null } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (done) return; done = true; resolve(v); };
        const oldSvcId = line && line.service_id != null ? Number(line.service_id) : null;
        const oldDoc = line ? lineDoctorId(line) : null;
        const oldDocObj = line && line.doctor_id && typeof line.doctor_id === 'object' ? line.doctor_id : null;
        const name0 = (item && item.description) || (line && line.services && line.services.name) || '—';
        const s = sheet(mode === 'add' ? tr('Добавить услугу') : trf('Изменить услугу · {name}', { name: name0 }), mode === 'add' ? 'Plus' : 'Edit', 560, () => finish(null));
        let svc = null;          // выбранная услуга
        let perf = null;         // ответ cashier_line_performers для неё
        let who = null;          // выбранный исполнитель (id)
        let quote = null;        // 'swap' — расчёт разницы
        let dest = 'original';   // 'swap' — разница: тем же способом или на баланс
        let busy = false;
        let pSeq = 0; let qSeq = 0;
        const idemKey = newIdemKey();   // ключ окна: двойное нажатие не проведёт деньги дважды

        const label = (t) => h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' } }, t);
        const kv = (k, v, strong = false) => h('div', { class: 'row', style: { gap: '10px', fontSize: strong ? '15px' : '13.5px', fontWeight: strong ? 800 : 500 } },
            h('span', { style: { flex: 1, color: 'var(--ink-600)' } }, k), h('span', { class: 'num' }, v));
        if (mode !== 'add') {
            const wasSum = item ? Math.max(0, Number(item.total || 0) - Number(item.discount_amount || 0)) : (Number(line && line.unit_price) || 0) * (Number(line && line.quantity) || 1);
            s.body.appendChild(h('div', { class: 'muted', 'data-line-was': '', style: { fontSize: '12.5px', marginBottom: '8px' } },
                tr('Было') + ': ' + name0 + (oldDocObj && oldDocObj.full_name ? ', ' + oldDocObj.full_name : '') + ' · ' + fmtSum(wasSum) + ' ' + tr('сум')));
        }
        const chosen = h('div', { class: 'cell-strong', 'data-chosen-service': '' }, '—');
        const search = h('input', { type: 'search', placeholder: tr('Название услуги'), 'aria-label': tr('Поиск услуги'), 'data-service-search': '', style: { width: '100%' } });
        const list = h('div', { 'data-service-list': '', style: { maxHeight: '220px', overflowY: 'auto', display: 'grid', gap: '4px' } });
        const perfBox = h('div', { 'data-performer-box': '', style: { display: 'grid', gap: '6px' } });
        const priceRow = h('div', { 'data-new-price': '', style: { fontWeight: 700, fontSize: '13.5px' } });
        const quoteBox = h('div', { 'data-quote': '', style: { display: 'grid', gap: '6px' } });
        s.body.appendChild(h('div', { style: { display: 'grid', gap: '8px' } },
            label(tr('Услуга')), chosen, search, list, perfBox, priceRow, quoteBox));
        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true, 'data-line-save': '' }, mode === 'add' ? tr('Добавить') : tr('Сохранить'));
        s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, tr('Отмена')));
        s.foot.appendChild(h('span', { class: 'grow' }));
        s.foot.appendChild(saveBtn);

        const sameService = () => !!svc && (svc.id == null ? oldSvcId == null : Number(svc.id) === oldSvcId);
        const serviceChanged = () => !!svc && (mode === 'add' || !sameService());
        const needs = () => !!(perf && perf.needs_performer);
        /** Кого предлагать: отмеченные услуге; никого — все, кто может; прежний исполнитель той же услуги — тоже. */
        const candidates = () => {
            const ps = (perf && perf.performers) || [];
            const mapped = ps.filter((p) => p.assigned);
            const pool = mapped.length ? mapped : ps;
            if (sameService() && oldDoc != null && !pool.some((p) => Number(p.id) === Number(oldDoc))) {
                const keep = ps.find((p) => Number(p.id) === Number(oldDoc));
                if (keep) return [keep, ...pool];
            }
            return pool;
        };
        const doctorChanged = () => mode !== 'add' && (needs() ? who != null && Number(who) !== Number(oldDoc) : serviceChanged() && oldDoc != null);
        const ready = () => !!svc && !!perf && (!needs() || who != null) && (mode === 'add' || serviceChanged() || doctorChanged());
        const refresh = () => {
            const ok = !busy && ready() && (mode !== 'swap' || (!!quote && quote.changed !== false));
            saveBtn.disabled = !ok;
        };
        // 'swap' — что уходит серверу: новая услуга, исполнитель (или «без исполнителя» вместе с заменой услуги).
        const swapArgs = () => {
            const a = { visit_service_id: line.id };
            if (serviceChanged()) a.new_service_id = Number(svc.id);
            if (needs()) { if (serviceChanged() || doctorChanged()) a.doctor_id = Number(who); }
            else if (serviceChanged()) a.no_doctor = true;
            return { ...a, to_balance: dest === 'balance', card_fallback: dest === 'balance' ? 'balance' : 'cash' };
        };

        const paintChosen = () => { chosen.textContent = svc ? (svc.name || name0) : '—'; chosen.setAttribute('data-chosen-service', svc && svc.id != null ? String(svc.id) : ''); };
        const paintPerf = () => {
            clear(perfBox);
            if (!svc || !perf) return;
            if (!needs()) {
                const word = ROUTE_WORD[perf.route];
                perfBox.appendChild(h('div', { class: 'muted', 'data-no-performer': perf.route || '', style: { fontSize: '12.5px' } },
                    word ? trf('Исполнитель не нужен: {where}.', { where: tr(word) }) : tr('Без врача')));
                return;
            }
            perfBox.appendChild(label(tr('Исполнитель')));
            const pool = candidates();
            if (!pool.length) {
                perfBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Нет сотрудников, которые оказывают эту услугу.')));
                return;
            }
            const sel = h('select', { 'data-performer-select': '', style: { width: '100%' } },
                who == null ? h('option', { value: '' }, tr('Выберите исполнителя')) : null,
                ...pool.map((p) => h('option', { value: String(p.id), selected: Number(p.id) === Number(who) ? true : null },
                    (p.full_name || ('#' + p.id)) + (p.specialty ? ' · ' + p.specialty : '') + ' — ' + fmtSum(p.unit_price) + ' ' + tr('сум'))));
            sel.value = who == null ? '' : String(who);
            sel.addEventListener('change', () => {
                if (busy) { sel.value = who == null ? '' : String(who); return; }
                who = sel.value ? Number(sel.value) : null;
                paintPrice(); refresh(); requote();
            });
            perfBox.appendChild(sel);
        };
        const paintPrice = () => {
            clear(priceRow);
            if (!svc || !perf) return;
            let unit = null;
            if (needs()) { const p = candidates().find((x) => Number(x.id) === Number(who)); unit = p ? p.unit_price : null; }
            else unit = perf.catalog_price;
            if (unit != null) priceRow.appendChild(h('span', null, trf('Цена: {sum} сум', { sum: fmtSum(unit) })));
        };
        const paintQuote = () => {
            clear(quoteBox);
            if (mode !== 'swap' || !quote) return;
            const q = quote;
            if (q.changed === false) { quoteBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Это та же услуга у того же исполнителя — менять нечего.'))); return; }
            quoteBox.appendChild(kv(tr('Стало'), q.line_after || '—'));
            quoteBox.appendChild(kv(tr('Сумма счёта'), fmtSum(q.total_before) + ' → ' + fmtSum(q.total_after) + ' ' + tr('сум')));
            quoteBox.appendChild(kv(tr('Уже оплачено'), fmtSum(q.paid_before) + ' ' + tr('сум')));
            if (Number(q.refunded) > 0) {
                quoteBox.appendChild(h('div', { 'data-swap-refund': String(q.refunded), style: { marginTop: '6px' } }, kv(tr('Вернуть пациенту'), fmtSum(q.refunded) + ' ' + tr('сум'), true)));
                const destBox = h('div', { style: { display: 'grid', gap: '6px' } });
                for (const [v, text] of [['original', 'Тем же способом, каким платили'], ['balance', 'На баланс пациента']]) {
                    const radio = h('input', { type: 'radio', name: 'line-edit-dest', value: v, checked: dest === v ? true : null });
                    radio.addEventListener('change', () => { if (busy || dest === v) return; dest = v; requote(); });
                    destBox.appendChild(h('label', { 'data-swap-dest': v, style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13.5px', cursor: 'pointer' } }, radio, tr(text)));
                }
                quoteBox.appendChild(destBox);
                const plan = h('div', { class: 'muted', style: { fontSize: '12.5px', display: 'grid', gap: '2px' } });
                for (const x of (q.refund_plan || [])) plan.appendChild(h('div', { 'data-swap-plan': x.refund_method || '' }, refundWhere(x) + ' — ' + fmtSum(x.amount) + ' ' + tr('сум')));
                quoteBox.appendChild(plan);
                saveBtn.textContent = trf('Заменить и вернуть {sum} сум', { sum: fmtSum(q.refunded) });
            } else if (Number(q.due) > 0) {
                quoteBox.appendChild(h('div', { 'data-swap-due': String(q.due), style: { marginTop: '6px' } }, kv(tr('К доплате'), fmtSum(q.due) + ' ' + tr('сум'), true)));
                quoteBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('После замены откроется окно оплаты разницы.')));
                saveBtn.textContent = tr('Заменить и принять доплату');
            } else {
                quoteBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Сумма счёта не меняется — деньги не двигаются.')));
                saveBtn.textContent = tr('Сохранить');
            }
        };
        async function requote() {
            if (mode !== 'swap') return;
            quote = null;
            const my = ++qSeq;
            clear(quoteBox);
            if (!ready()) { saveBtn.textContent = tr('Сохранить'); refresh(); return; }
            refresh();
            quoteBox.appendChild(h('div', { class: 'muted' }, tr('Считаем…')));
            const { data, error } = await supabase.rpc('cashier_line_swap_quote', swapArgs());
            if (my !== qSeq) return;
            clear(quoteBox);
            if (error || !data) {
                quoteBox.appendChild(h('div', { role: 'alert', style: { color: 'var(--crit-600, #dc2626)' } }, (error && error.message) || tr('Не удалось.')));
                refresh();
                return;
            }
            quote = data;
            paintQuote();
            refresh();
        }
        async function choose(row) {
            if (busy || !row) return;
            svc = row; perf = null; who = null; quote = null;
            clear(quoteBox);
            paintChosen(); paintPerf(); paintPrice(); refresh();
            const my = ++pSeq;
            const args = line && sameService() ? { visit_service_id: line.id } : { service_id: Number(row.id), visit_id: visitId };
            const { data, error } = await supabase.rpc('cashier_line_performers', args);
            if (my !== pSeq) return;
            if (error) {
                clear(perfBox);
                perfBox.appendChild(h('div', { role: 'alert', style: { color: 'var(--crit-600, #dc2626)' } }, error.message || tr('Не удалось загрузить.')));
                return;
            }
            perf = data || {};
            if (needs()) {
                const pool = candidates();
                if (sameService() && oldDoc != null && pool.some((p) => Number(p.id) === Number(oldDoc))) who = Number(oldDoc);
                else if (pool.length === 1) who = Number(pool[0].id);   // единственный — выбран сам
            }
            paintPerf(); paintPrice(); refresh();
            await requote();
        }

        // Список услуг — сразу под поиском; уже назначенные в визите — погашены (DUP_STOP_V1).
        let all = []; let ordered = [];
        const paintList = () => {
            clear(list);
            const q = String(search.value || '').trim().toLowerCase();
            const rows = (q ? all.filter((x) => String(x.name || '').toLowerCase().includes(q)) : all).slice(0, 60);
            if (!rows.length) { list.appendChild(h('div', { class: 'muted', style: { padding: '8px' } }, tr('Ничего не найдено.'))); return; }
            for (const row of rows) {
                const onVisit = orderedMatch(row, ordered, oldDoc);
                const locked = !!(onVisit && onVisit.blocked);
                list.appendChild(h('button', {
                    type: 'button', class: 'btn btn-ghost', 'data-service-id': String(row.id), disabled: locked,
                    title: locked ? tr('уже назначено') : undefined,
                    style: { justifyContent: 'space-between', display: 'flex', width: '100%', textAlign: 'left', opacity: locked ? '0.55' : '1' },
                    onclick: () => { if (!locked) choose(row); },
                }, h('span', null, row.name || '—', onVisit ? h('span', { class: 'muted', 'data-ordered': '' }, ' — ', orderedLabel(onVisit)) : null),
                h('span', { class: 'num muted' }, fmtSum(row.price), ' ', tr('сум'))));
            }
        };
        search.addEventListener('input', paintList);

        saveBtn.addEventListener('click', async () => {
            if (busy || !ready() || (mode === 'swap' && !(quote && quote.changed !== false))) return;
            busy = true; refresh();
            const svcChanged = serviceChanged(); const docChanged = doctorChanged();
            let res;
            if (mode === 'add') res = await supabase.rpc('cashier_line_add', { invoice_id: invoiceId, service_id: Number(svc.id), doctor_id: needs() ? Number(who) : null });
            else if (mode === 'swap') res = await supabase.rpc('cashier_line_swap_paid', { ...swapArgs(), idempotency_key: idemKey });
            else if (svcChanged) res = await supabase.rpc('cashier_line_change_service', { visit_service_id: line.id, new_service_id: Number(svc.id), ...(needs() ? { doctor_id: Number(who) } : { no_doctor: true }) });
            else res = await supabase.rpc('cashier_line_set_doctor', { visit_service_id: line.id, doctor_id: Number(who) });
            if (res.error) { toast(res.error.message || tr('Не удалось.'), 'fail'); busy = false; refresh(); return; }
            s.overlay.remove();
            finish({ data: res.data || {}, svc, serviceChanged: svcChanged, doctorChanged: docChanged });
        });

        Promise.all([loadServices(), loadVisitOrders({ visitId, door: 'cashier' })]).then(([rows, got]) => {
            all = rows;
            ordered = (got.ordered || []).filter((o) => !line || Number(o.id) !== Number(line.id));
            paintList();
            // 'edit' / 'swap' — окно открывается на услуге строки: сменить только врача — один выбор.
            if (mode !== 'add' && line) choose(rows.find((x) => oldSvcId != null && Number(x.id) === oldSvcId) || { id: oldSvcId, name: name0, ...(line.services || {}) });
        }).catch((e) => { clear(list); list.appendChild(h('div', { style: { color: 'var(--crit-600)' } }, trf('Не удалось загрузить: {msg}', { msg: (e && e.message) || e }))); });
    });
}

/**
 * Окно «Исправить услуги» для счёта `inv` (строка «Приёма оплат»).
 * `onChanged` зовётся после каждой успешной правки — касса перерисуется.
 * CASHIER_PAID_SWAP_V1 — `onPayDue(row, due)`: после замены на дороже касса
 * сразу открывает окно оплаты разницы; `printSlip(data)` — квитанция
 * «Возврат разницы».
 */
export async function openLineFix(inv, { onChanged = null, onPayDue = null, printSlip = null } = {}) {
    const s = sheet(trf('Исправить услуги · {no}', { no: inv.invoice_number || ('#' + inv.id) }), 'Edit', 640);
    const intro = h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } });
    const table = h('div', { style: { display: 'grid', gap: '6px' } });
    const total = h('div', { style: { marginTop: '12px', fontWeight: 700, textAlign: 'right' } });
    s.body.appendChild(intro);
    s.body.appendChild(table);
    s.body.appendChild(total);
    const addBtn = h('button', { class: 'btn btn-primary', type: 'button' }, '+ Добавить услугу');
    s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, 'Закрыть'));
    s.foot.appendChild(h('span', { class: 'grow' }));
    s.foot.appendChild(addBtn);

    let current = inv;
    const changed = async () => { if (onChanged) { try { await onChanged(); } catch (_) { /* касса перерисуется сама */ } } };

    const paint = async () => {
        clear(table);
        table.appendChild(h('div', { class: 'muted' }, 'Загрузка…'));
        const st = await loadInvoiceState(current.id);
        try { await loadServices(); } catch (_) { /* без каталога подпись строки — по её группе */ }   // CASHIER_LINE_EDIT_V1 — маршрут строки
        clear(table); clear(intro); clear(total);
        if (!st.invoice) {
            intro.appendChild(h('span', null, 'В счёте не осталось услуг — он удалён.'));
            return;
        }
        current = { ...current, ...st.invoice };
        const editable = invoiceEditable(st.invoice);
        // CASHIER_PAID_SWAP_V1 — деньги по счёту есть: замена с расчётом разницы.
        const swappable = !editable && invoiceSwappable(st.invoice) && canSwapPaidLines();
        intro.appendChild(h('span', null, editable
            ? tr('Пока по счёту не принято денег, услугу и врача можно поменять, лишнюю — убрать. Цену считает программа.')
            : swappable
                ? tr('По счёту уже приняты деньги. У неначатой услуги можно поменять услугу или врача: разницу касса сразу вернёт пациенту или возьмёт доплату. Убрать оплаченную услугу — через «Вернуть услугу». Новая услуга будет выставлена отдельным счётом.')
                : tr('По счёту уже приняты деньги — его строки не меняются (оплаченное возвращают через «Вернуть услугу»). Новая услуга будет выставлена отдельным счётом.')));
        const byItem = new Map(st.lines.map((l) => [l.invoice_item_id, l]));
        for (const item of st.items) {
            const line = byItem.get(item.id) || null;
            const doc = line && line.doctor_id && typeof line.doctor_id === 'object' ? line.doctor_id : null;
            const actions = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } });
            // CASHIER_LINE_EDIT_V1 — одна «Изменить» (услуга и исполнитель в одном окне); «Убрать» — пока денег нет.
            if ((editable || swappable) && line && lineFixable(line)) {
                actions.appendChild(h('button', { class: 'btn btn-sm', type: 'button', 'data-line-edit': String(line.id), onclick: async () => {
                    const r = await openLineEdit({ mode: editable ? 'edit' : 'swap', visitId: st.invoice.visit_id, invoiceId: st.invoice.id, item, line });
                    if (!r) return;
                    if (editable) {
                        // LAB_TUBE_LABEL_V1 (ревью U11, L5) — счёт на ноль уже отпустил строку в лабораторию.
                        const note = r.serviceChanged ? reprintNote(line, r.svc, TUBE_STATUSES.includes(line.status)) : '';
                        toast((r.serviceChanged ? (r.doctorChanged ? tr('Услуга и врач заменены.') : tr('Услуга заменена.')) : tr('Врач заменён.')) + note, 'ok');
                        await paint(); await changed();
                    } else {
                        // LAB_TUBE_LABEL_V1 (К4) — в замене анализ: уведомление напомнит перепечатать этикетку.
                        await afterSwap({ ...r.data, lab: r.serviceChanged && (isLabService(line.services) || isLabService(r.svc)) });
                    }
                } }, tr('Изменить')));
                if (editable) {
                    actions.appendChild(h('button', { class: 'btn btn-sm', type: 'button', style: { color: 'var(--crit-600, #dc2626)' }, onclick: async () => {
                        const ok = typeof confirm === 'function' ? confirm(trf('Убрать услугу «{name}» из счёта?', { name: item.description || '—' })) : true;
                        if (!ok) return;
                        if (await runRpc('cashier_line_remove', { visit_service_id: line.id }, tr('Услуга убрана.'))) { await paint(); await changed(); }
                    } }, tr('Убрать')));
                }
            } else if (line && (editable || swappable)) {
                actions.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Работа уже начата — не меняется'));
            }
            table.appendChild(h('div', {
                class: 'row', 'data-line': line ? String(line.id) : '',
                style: { gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--ink-50)', alignItems: 'center' },
            },
            h('div', { style: { flex: '1', minWidth: 0 } },
                h('div', { class: 'cell-strong' }, item.description || '—'),
                h('div', { class: 'muted', 'data-line-where': '', style: { fontSize: '12.5px' } }, lineWhere(line, doc))),   // CASHIER_LINE_EDIT_V1 — анализ: «Лаборатория», а не «Без врача»
            h('div', { class: 'num', style: { whiteSpace: 'nowrap', fontWeight: 600 } }, fmtSum(item.total), ' ', tr('сум')),
            actions));
        }
        // CASHIER_LINE_EDIT_V1 — к оплате — с учётом внесённого; скидка 100 % — словами.
        total.appendChild(h('span', { 'data-invoice-due': '' }, invoiceDueText(st.invoice)));
    };

    // CASHIER_PAID_SWAP_V1 — после замены в оплаченном счёте: что стало с деньгами.
    // LAB_TUBE_LABEL_V1 (К4, поправка владельца) — заменили анализ (r.lab): одно
    // уведомление заканчивается «Перепечатайте этикетку пробирки.» — номер строки
    // тот же, но в пробирке другой анализ. Смена врача анализ не меняет — r.lab нет.
    async function afterSwap(r) {
        const reprint = r.lab ? ' · ' + tr('Перепечатайте этикетку пробирки.') : '';
        if (Number(r.refunded) > 0) {
            toast((r.to_balance
                ? trf('Разница {sum} сум зачислена на баланс пациента.', { sum: fmtSum(r.refunded) })
                : trf('Пациенту возвращено {sum} сум.', { sum: fmtSum(r.refunded) })) + reprint, 'ok');
            if (printSlip) {
                try {
                    printSlip({ kind: 'swap', invoice: r.invoice || current, patient: { full_name: current.patient_name, mrn: current.mrn },
                        before: r.line_before, after: r.line_after, refunded: r.refunded, plan: r.refund_plan || [], cashier: cashierName() });
                } catch (e) { /* печать не отменяет проведённый возврат */ }
            }
        } else if (Number(r.due) > 0) {
            toast(trf('Услуга заменена — к доплате {sum} сум.', { sum: fmtSum(r.due) }) + reprint, 'info');
        } else {
            toast(tr('Услуга заменена — сумма счёта не изменилась.') + reprint, 'ok');
        }
        await paint();
        await changed();
        if (Number(r.due) > 0 && onPayDue) {
            s.overlay.remove();   // окно оплаты разницы — поверх кассы, а не поверх этого окна
            await onPayDue({ ...current, ...(r.invoice || {}) }, Number(r.due));
        }
    }

    addBtn.addEventListener('click', async () => {
        // CASHIER_LINE_EDIT_V1 — то же окно: услуга, исполнитель — только если он ей нужен, цена.
        const got = await openLineEdit({ mode: 'add', visitId: current.visit_id, invoiceId: current.id });
        if (!got) return;
        const r = got.data;
        if (r.invoice_created && r.invoice) {
            toast(trf('Счёт уже оплачен — услуга выставлена новым счётом {no}.', { no: r.invoice.invoice_number || ('#' + r.invoice.id) }), 'ok');
        } else {
            toast(tr('Услуга добавлена в счёт.'), 'ok');
        }
        await paint(); await changed();
    });

    await paint();
    return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// CASHIER_PAID_SWAP_V1 — «ВЫСТАВИТЬ ЗАНОВО» из «Возвратов и отмен».
// ═══════════════════════════════════════════════════════════════════════════
//
// Отменённый счёт (с «Оставить услуги», или после возврата, когда сделанная
// работа осталась в визите) оставляет строки визита без счёта. Здесь касса их
// видит, по праву «Исправляет услуги в счёте» меняет услугу и врача (двери
// неоплаченных правок — строка без счёта денег не держит), отмечает, что
// выставить, и выставляет счёт; строки, за которые пациенту вернули деньги,
// выставляются только этим явным выбором (rebill_refunded). `onBilled(invoice)`
// — касса открывает окно оплаты.
//
// REFERRAL_BILL_V1 (2026-09-29) — то же окно открывает «Ждут счёта» кассы
// (визит без отменённого счёта): `title` — свой заголовок («Выставить счёт ·
// {пациент}»), `preselectRefunded: false` — строки, за которые пациенту вернули
// деньги, не отмечены сразу: здесь их снова выставляют только явной галочкой.
// «Возвраты и отмены» по-прежнему отмечают всё (выставляют заново осознанно).
//
// REFERRAL_BILL_V1 — решение владельца 29.09 «Card's payer, can split».
// `cardPayer` ({ id, name, kind }) — ДЕЙСТВУЮЩИЙ плательщик из карты пациента
// (cashier_unbilled; то же правило, что у отказа врачу). С ним в окне «Кому
// счёт»: этот плательщик (по умолчанию) или «Пациенту» — других плательщиков
// здесь нет. Отмеченные строки уходят выбранному. Счёт плательщику —
// create_invoice_for_visit с payer_id и discount_amount: 0, как задание
// COVERAGE_SPLIT_V1 мастера визита; окна оплаты у него нет (денег у кассы не
// будет — расчёт по акту): тост, `onBilled(invoice, { payer, items })` — касса
// печатает акт, — и окно ОСТАЁТСЯ с невыставленными строками, уже отмеченными
// и с «Пациенту»: второй проход выставляет остаток пациенту. Не осталось —
// окно закрывается. Неотмеченное ждёт в «Ждут счёта».
//
// REFERRAL_BILL_V1 — решение владельца 29.09 «From the visit day»: счёт
// плательщику из карты — только со дня визита (местный день: тот же
// localYmd, что у остальной кассы; сервер считает день визита так же —
// date(visit_date, 'localtime')). Визит ещё впереди — плательщик в «Кому
// счёт» виден, но не выбирается, и сказано почему: сейчас можно выставить
// только пациенту (предоплата). В день визита и позже — как прежде.
//
// REFBILL_REVIEW_V1 (ревью m2) — `patientId`: окно «Ждут счёта» само
// перечитывает плательщика из карты пациента — при открытии и ещё раз прямо
// перед счётом. Прежде счёт уходил плательщику из СТРОКИ СПИСКА: регистратура
// убрала или сменила страховую, пока список висел или окно было открыто, — и
// прежней страховой молча выставлялся счёт. Изменился — «Кому счёт»
// перерисован, сказано словами, а счёт не уходит, пока касса не нажмёт снова.
export async function openRebill(row, { onBilled = null, title = null, preselectRefunded = true, cardPayer = null, patientId = null } = {}) {
    const s = sheet(title || trf('Выставить заново · {no}', { no: row.invoice_number || ('#' + row.invoice_id) }), 'Receipt', 640);
    s.body.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } },
        tr('Строки визита без счёта: отметьте, что выставить. Услугу и врача можно поменять до выставления.')));
    let payer = cardPayer && cardPayer.id != null ? cardPayer : null;   // REFERRAL_BILL_V1 · REFBILL_REVIEW_V1 — перечитывается из карты
    const visitDay = row && row.visit_date ? localYmd(new Date(row.visit_date)) : '';   // REFERRAL_BILL_V1 — «From the visit day»
    const lockedFor = (p) => !!(p && visitDay && visitDay > localYmd());
    let payerLocked = lockedFor(payer);
    let target = payer && !payerLocked ? 'payer' : 'patient';
    const targetBox = payer || patientId != null ? h('div', { class: 'row', style: { gap: '14px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' } }) : null;
    if (targetBox) s.body.appendChild(targetBox);
    const table = h('div', { style: { display: 'grid', gap: '6px' } });
    s.body.appendChild(table);
    const billBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, tr('Выставить счёт и принять оплату'));
    s.foot.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => s.close() }, 'Закрыть'));
    s.foot.appendChild(h('span', { class: 'grow' }));
    s.foot.appendChild(billBtn);
    const chosen = new Set();
    let seeded = false;
    let refunded = new Set();
    const canFix = canFixCashierLines();

    // REFERRAL_BILL_V1 — «Кому счёт» и подпись кнопки по выбору.
    const paintTarget = () => {
        billBtn.textContent = target === 'payer' ? tr('Выставить счёт плательщику') : tr('Выставить счёт и принять оплату');
        if (!targetBox) return;
        clear(targetBox);
        if (!payer) return;   // REFBILL_REVIEW_V1 — плательщика в карте (больше) нет: выбора нет
        targetBox.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 700 } }, tr('Кому счёт')));
        for (const [v, label] of [['payer', trf('{name} — плательщик в карте', { name: payer.name || '—' })], ['patient', tr('Пациенту')]]) {
            const locked = v === 'payer' && payerLocked;   // REFERRAL_BILL_V1 — до дня визита
            const radio = h('input', { type: 'radio', name: 'bill-target', value: v, checked: target === v ? true : null, disabled: locked ? true : null });
            if (!locked) radio.addEventListener('change', () => { target = v; paintTarget(); });
            targetBox.appendChild(h('label', { 'data-bill-target': v, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '13.5px', cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? '0.55' : '1' } }, radio, label));
        }
        if (payerLocked) {   // REFERRAL_BILL_V1 — почему плательщика выбрать нельзя
            targetBox.appendChild(h('div', { class: 'muted', 'data-payer-locked': '', style: { flexBasis: '100%', fontSize: '12.5px' } },
                trf('Счёт плательщику — со дня визита ({date}). Сейчас можно выставить только пациенту (предоплата).', { date: fmtDate(row.visit_date) })));
        }
    };
    paintTarget();

    // REFBILL_REVIEW_V1 (ревью m2) — плательщик карты сейчас. true — тот же, что
    // в окне; false — изменился (окно перерисовано, сказано) или проверить не
    // удалось. Окно без patientId («Возвраты и отмены») карты не читает.
    const recheckCardPayer = async () => {
        if (patientId == null) return true;
        let live;
        try { live = await readCardPayer(patientId); }
        catch (e) { toast(tr('Не удалось проверить плательщика в карте — повторите.'), 'fail'); return false; }
        if ((live ? Number(live.id) : null) === (payer ? Number(payer.id) : null)) return true;
        const was = payer;
        payer = live;
        payerLocked = lockedFor(payer);
        target = payer && !payerLocked ? 'payer' : 'patient';
        paintTarget();
        toast(payer
            ? trf('Плательщик в карте пациента изменился: теперь «{name}». Проверьте «Кому счёт».', { name: payer.name || '—' })
            : trf('В карте пациента больше нет плательщика «{name}» — счёт выставляется пациенту.', { name: (was && was.name) || '—' }), 'info');
        return false;
    };

    const paint = async () => {
        clear(table);
        table.appendChild(h('div', { class: 'muted' }, 'Загрузка…'));
        let lines = [];
        try { await loadServices(); } catch (_) { /* CASHIER_LINE_EDIT_V1 — без каталога подпись строки по её группе */ }
        try {
            const { data } = await supabase.from('visit_services')
                .select('id, service_id, status, quantity, unit_price, total, invoice_item_id, clinic_item_id, consultation_type_id, services(name, is_lab, type), products(name), doctor_id(id, full_name)')   // is_lab, type: LAB_TUBE_LABEL_V1 (ревью U11, L5) — строка — анализ?
                .eq('visit_id', row.visit_id).is('invoice_item_id', null).order('id', { ascending: true });
            lines = (data || []).filter((l) => l.status !== 'cancelled' && l.invoice_item_id == null);
        } catch (e) { lines = []; }
        try {
            const { data: rf } = await supabase.rpc('visit_refunded_lines', { visit_id: row.visit_id });
            refunded = new Set(((rf && rf.line_ids) || []).map(Number));
        } catch (e) { /* без пометки сервер всё равно не выставит их молча */ }
        if (!seeded) { for (const l of lines) if (preselectRefunded || !refunded.has(Number(l.id))) chosen.add(Number(l.id)); seeded = true; }   // REFERRAL_BILL_V1 — preselectRefunded
        for (const id of [...chosen]) if (!lines.some((l) => Number(l.id) === id)) chosen.delete(id);
        clear(table);
        if (!lines.length) {
            table.appendChild(h('div', { class: 'empty' }, 'Невыставленных строк не осталось — выставлять нечего.'));
            billBtn.disabled = true;
            return 0;   // REFERRAL_BILL_V1 — после счёта плательщику: окно закрывается
        }
        for (const l of lines) {
            const id = Number(l.id);
            const box = h('input', { type: 'checkbox', checked: chosen.has(id) ? true : null, 'aria-label': tr('Выставить') });
            box.addEventListener('change', () => { if (box.checked) chosen.add(id); else chosen.delete(id); billBtn.disabled = !chosen.size; });
            const name = (l.services && l.services.name) || (l.products && l.products.name) || '—';
            const doc = l.doctor_id && typeof l.doctor_id === 'object' ? l.doctor_id : null;
            const tags = [];
            if (refunded.has(id)) tags.push(tr('возвращено'));
            if (PERFORMED.includes(l.status)) tags.push(tr('работа сделана'));
            const actions = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } });
            if (canFix && lineFixable(l)) {
                // CASHIER_LINE_EDIT_V1 — одна «Изменить»: услуга и исполнитель в одном окне.
                actions.appendChild(h('button', { class: 'btn btn-sm', type: 'button', 'data-line-edit': String(id), onclick: async () => {
                    const r = await openLineEdit({ mode: 'edit', visitId: row.visit_id, line: l });
                    if (!r) return;
                    // LAB_TUBE_LABEL_V1 (ревью U11, L5) — за строку вернули деньги: она была в
                    // лаборатории, и этикетка с её номером могла остаться на пробирке.
                    const note = r.serviceChanged ? reprintNote(l, r.svc, refunded.has(id) || TUBE_STATUSES.includes(l.status)) : '';
                    toast((r.serviceChanged ? (r.doctorChanged ? tr('Услуга и врач заменены.') : tr('Услуга заменена.')) : tr('Врач заменён.')) + note, 'ok');
                    await paint();
                } }, tr('Изменить')));
            }
            table.appendChild(h('div', {
                class: 'row', 'data-rebill-line': String(id),
                style: { gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--ink-50)', alignItems: 'center' },
            },
            box,
            h('div', { style: { flex: '1', minWidth: 0 } },
                h('div', { class: 'cell-strong' }, name, tags.length ? h('span', { class: 'muted', style: { fontWeight: 500 } }, ' · ' + tags.join(', ')) : null),
                h('div', { class: 'muted', 'data-line-where': '', style: { fontSize: '12.5px' } }, lineWhere(l, doc))),   // CASHIER_LINE_EDIT_V1
            h('div', { class: 'num', style: { whiteSpace: 'nowrap', fontWeight: 600 } }, fmtSum((Number(l.unit_price) || 0) * (Number(l.quantity) || 1)), ' ', tr('сум')),
            actions));
        }
        billBtn.disabled = !chosen.size;
        return lines.length;   // REFERRAL_BILL_V1 — остаток строк (0 — окно после счёта плательщику закрывается)
    };

    billBtn.addEventListener('click', async () => {
        const ids = [...chosen];
        if (!ids.length) { toast(tr('Отметьте, что выставить.'), 'fail'); return; }
        billBtn.disabled = true;
        // REFBILL_REVIEW_V1 (ревью m2) — плательщик карты ещё раз, прямо перед
        // счётом: изменился — окно перерисовано и сказано, счёт не уходит.
        if (!(await recheckCardPayer())) { billBtn.disabled = !chosen.size; return; }
        const toPayer = target === 'payer' && !!payer && !payerLocked;   // REFERRAL_BILL_V1 — и только со дня визита
        const { data, error } = await supabase.rpc('create_invoice_for_visit', {
            visit_id: row.visit_id, visit_service_ids: ids,
            // REFERRAL_BILL_V1 — плательщику: без скидки пациента, как задание COVERAGE_SPLIT_V1 мастера.
            ...(toPayer ? { payer_id: Number(payer.id), discount_amount: 0 } : {}),
            ...(ids.some((id) => refunded.has(id)) ? { rebill_refunded: true } : {}),
        });
        if (error) {
            toast(error.message || tr('Не удалось.'), 'fail');
            // REFBILL_REVIEW_V1 (ревью m6) — отказ сервера (строку, пока окно было
            // открыто, выставил другой: «уже в счёте») — строки перечитываются,
            // устаревшие галочки уходят, кнопка — по тому, что осталось.
            await paint();
            return;
        }
        if (toPayer) {
            // REFERRAL_BILL_V1 — денег у кассы по нему не будет: тост, акт, и
            // окно остаётся с остатком — вторым проходом пациенту.
            toast(trf('Счёт плательщику {payer} выставлен — оплата по акту', { payer: payer.name || '—' }), 'ok');
            if (onBilled && data && data.invoice) {
                try { await onBilled(data.invoice, { payer, items: (data && data.items) || [] }); }
                catch (e) { console.warn('[rebill] after payer bill:', e && e.message); }
            }
            target = 'patient';
            seeded = false;
            paintTarget();
            const left = await paint();
            if (!left) s.overlay.remove();
            return;
        }
        toast(trf('Счёт выставлен: {no}.', { no: (data && data.invoice && data.invoice.invoice_number) || '' }), 'ok');
        s.overlay.remove();
        if (onBilled && data && data.invoice) await onBilled(data.invoice);
    });

    await recheckCardPayer();   // REFBILL_REVIEW_V1 (ревью m2) — при открытии: список мог устареть
    await paint();
    return s;
}

// REFBILL_REVIEW_V1 (ревью m2) — ДЕЙСТВУЮЩИЙ плательщик из карты пациента
// сейчас: { id, name, kind } или null. Правило то же, что у сервера
// (cashier_unbilled, billing.js visitHasCardPayer): patients.payer_id на
// плательщика с active = 1; выключенный — не плательщик.
async function readCardPayer(patientId) {
    const { data: p, error } = await supabase.from('patients').select('id, payer_id').eq('id', patientId).maybeSingle();
    if (error) throw error;
    if (!p || p.payer_id == null) return null;
    const { data: py, error: e2 } = await supabase.from('payers').select('id, name, kind, active').eq('id', p.payer_id).maybeSingle();
    if (e2) throw e2;
    return py && (py.active === true || Number(py.active) === 1) ? { id: Number(py.id), name: py.name, kind: py.kind } : null;
}
