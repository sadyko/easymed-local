// Cashier — CASHIER_DESIGN_V2. The Касса workspace rebuilt to match the
// production easymed cashier page: teal shift banner (X-отчёт / Внести /
// Изъять / Закрыть смену), 7 KPI tiles, and the «Приём оплат» invoice list
// with status chips, search, payment + cancel actions and Excel export.
// A Head-cashier overview lives below (unchanged from CASHIER_LOCAL_V1).
//
// All money math is server-side (server/services/rpc/cashier.js + billing.js):
//   open_cash_shift / close_cash_shift / cash_shift_summary
//   cash_move        — «Внести» / «Изъять» drawer movements
//   shift_report     — X-отчёт / внутренний отчёт / история смены
//   cashier_invoices — the invoice list + chip aggregates, joined server-side
//   record_payment   — stamps payments.shift_id from the cashier's open shift
//   void_invoice     — отмена счёта (только без принятых денег; возвраты — follow-up)
// DEPOSIT_V1 — депозиты ПОРТИРОВАНЫ: чип «ДЕПОЗИТЫ» показывает предоплаты,
// заведённые регистратурой и ждущие приёма. Приём пишет строку в ящик смены
// (rpc/deposits.js), выручкой депозит не становится.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, StatusTag, Avatar, field, fmtDateTime, initials, avColor } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { printableSheet } from './doc-settings.js?v=noqr1';
import { moneyDisplay, moneyNumber } from '../../shared/money-input.js?v=mi2';   // MONEY_INPUT_V2
import { loadInvoiceLines, performersByItem } from './receipt-print.js?v=rp1';   // INVOICE_QUEUE_V1 — тот же сбор талонов, что у чека   // CASH_CHECK_PRINT_V1 — бланк «Кассовый чек» из Настройки → Документы
import { PRINT_FONT_FACE_CSS } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1 — @font-face для печатных окон

const METHOD_RU = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод', acquiring: 'Эквайринг' };
// DEPOSIT_METHOD_BY_CASHIER_V1 — у ДЕПОЗИТА три способа, а не четыре: их берут
// у окошка. METHOD_RU выше шире, потому что описывает ещё и старые платежи, где
// «Перевод» встречается. Живёт на уровне модуля — окно приёма (ниже) вне
// paintDeposits, и держать словарь внутри значило бы прятать его от окна.
const DEP_METHODS = [['cash', 'Наличные'], ['card', 'Карта'], ['acquiring', 'Эквайринг']];

// CASH_CHECK_PRINT_V1 — после приёма оплаты сразу печатаем кассовый чек
// (вариант «Кассовый чек» из Настройки → Документы) и дублируем на нём БЛОК
// НОМЕРОВ ОЧЕРЕДИ пациента: чек выдают то на регистратуре, то в кассе — с
// номерами на чеке пациенту удобно в любом случае. issue_queue_numbers
// идемпотентен, так что повторная печать не выдаёт новых номеров.
// Best-effort: сбой печати никогда не блокирует принятую оплату.
// RECEIPT_PATIENT_ID_V1 — «14.03.1984 · 42 г.» одной строкой. Возраст берём на
// момент печати; пустая/битая дата не должна печатать «NaN г.».
const GENDER_RU = { male: 'Мужской', female: 'Женский', other: '—' };
function fmtDobAge(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).slice(0, 10));
    if (Number.isNaN(d.getTime())) return '';
    const t = new Date();
    let age = t.getFullYear() - d.getFullYear();
    const m = t.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < d.getDate())) age--;
    const date = d.toLocaleDateString('ru-RU');
    return (age >= 0 && age < 130) ? trf('{date} · {age} г.', { date, age }) : date;
}

// REPRINT_DOCS_V1 — A4-счёт по строке кассы (бланк «Счёт» из Настройки →
// Документы). Состав тянем из invoice_items: список кассы знает только первую
// позицию и «+N ещё», а на счёте должны быть все.
async function printInvoiceSheet(inv) {
    try {
        const { data: items } = await supabase.from('invoice_items')
            .select('id, description, quantity, unit_price, total').eq('invoice_id', inv.id);
        const paid = Number(inv.paid_amount) || 0;
        // INVOICE_QUEUE_V1 — талоны и на СЧЁТЕ, не только на чеке. Пациенту всё
        // равно, какую из двух бумаг ему дали: номер очереди нужен на той, что
        // у него в руках. Сбор общий с чеком (receipt-print.js) и best-effort —
        // пустой список печати не мешает.
        // RECEIPT_DOB_PERFORMER_V1 — очередь и исполнители одним запросом: раньше
        // счёт брал только очередь, поэтому «Исполнитель» на нём не появлялся.
        const { queue, byItem: perfByItem } = await loadInvoiceLines(supabase, inv.id);
        /* i18n-exempt-start: данные ПЕЧАТНОГО счёта (бланк) — печатные документы намеренно русские, как METHOD_RU/GENDER_RU в receipt-print.js */
        printableSheet({ type: 'invoice', idLine: inv.invoice_number || String(inv.id), data: {
            title: 'Счёт за медицинские услуги',
            queue,   // INVOICE_QUEUE_V1
            docNo: inv.invoice_number || String(inv.id),
            issueDate: 'Дата ' + new Date(inv.created_at || Date.now()).toLocaleDateString('ru-RU'),
            status: paid >= Number(inv.total_amount) ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'UNPAID'),
            patient: [
                ['ФИО', inv.patient_name || '—'],
                ['Карта №', inv.mrn || '—'],
                ['Дата рождения', fmtDobAge(inv.date_of_birth) || '—'],
                ['Телефон', inv.phone || '—'],
            ],
            billing: [
                ['Дата', new Date(inv.created_at || Date.now()).toLocaleDateString('ru-RU')],
                ['Оплата', inv.methods ? inv.methods.split(',').map(m => METHOD_RU[m] || m).join(', ') : '—'],
                // COVERAGE_SPLIT_V1 — счёт контрагента: на бланке видно, кому он выставлен.
                ...(inv.payer_id ? [['Плательщик', inv.payer_name || '—']] : []),
            ],
            items: (items || []).map((it, i) => ({
                name: it.description || 'Услуга', qty: it.quantity, price: it.unit_price, _alt: i % 2 === 1,
                ...(perfByItem[it.id] || {}),   // RECEIPT_DOB_PERFORMER_V1
            })),
            subtotal: inv.subtotal, total: inv.total_amount, paid,
        } });
        /* i18n-exempt-end */
    } catch (e) {
        console.warn('[cashier] invoice print:', e && e.message);
        toast(trf('Не удалось напечатать счёт: {msg}', { msg: (e && e.message) || e }), 'fail');
    }
}

async function printFiscalCheck(inv, paidAmt, method) {
    try {
        const { data: items } = await supabase.from('invoice_items')
            .select('id, description, quantity, unit_price, total').eq('invoice_id', inv.id);
        const itemIds = (items || []).map(i => i.id);
        let queue = [];
        let perfByItem = {};   // RECEIPT_DOB_PERFORMER_V1
        if (itemIds.length) {
            const { data: vsRows } = await supabase.from('visit_services')
                .select('id, invoice_item_id, queue_key, queue_no, services(name), doctor_id(full_name, specialty, role)')
                .in('invoice_item_id', itemIds);
            // RECEIPT_DOB_PERFORMER_V1 — тот же запрос отдаёт и исполнителя.
            perfByItem = performersByItem(vsRows);
            const ids = (vsRows || []).map(r => r.id);
            if (ids.length) {
                const { data: tickets, error: qErr } = await supabase.rpc('issue_queue_numbers', { p_ids: ids });
                if (!qErr) {
                    const nameByVs = new Map((vsRows || []).map(r => [r.id, (r.services && r.services.name) || '']));
                    queue = (tickets || []).map(t => ({
                        service: nameByVs.get(t.visit_service_id) || 'Услуга',
                        label: t.label || '', number: t.number, key: t.queue_key || '',
                    }));
                }
            }
        }
        const u = (window.easymed && window.easymed.state && window.easymed.state.user) || {};
        printableSheet({ type: 'fiscal', idLine: inv.invoice_number || String(inv.id), data: {
            docNo: inv.invoice_number || String(inv.id),
            date: new Date().toLocaleString('ru-RU').slice(0, 17),
            patientName: inv.patient_name || '—',
            mrn: inv.mrn || '',
            // RECEIPT_PATIENT_ID_V1 — по чеку сверяют пациента в лаборатории.
            // Возраст СЧИТАЕТСЯ при печати, а не хранится: иначе чек, выданный
            // год назад, называл бы неверный возраст.
            dob: fmtDobAge(inv.date_of_birth),
            sex: GENDER_RU[String(inv.gender || '').toLowerCase()] || '',
            cashier: u.full_name || u.username || '',
            items: (items || []).map(it => ({
                name: it.description || 'Услуга', qty: it.quantity, price: it.unit_price,
                ...(perfByItem[it.id] || {}),   // RECEIPT_DOB_PERFORMER_V1
            })),
            subtotal: inv.subtotal, discount: inv.discount_amount,
            total: inv.total_amount, paid: paidAmt,
            method: METHOD_RU[method] || method, payMethod: METHOD_RU[method] || method,
            queue,   // QUEUE_TICKET_V1 — номера очереди на чеке
        } });
    } catch (e) { console.warn('[cashier] check print:', e && e.message); }
}

// Reasons for cash-drawer movements (reference «Касса», same list as production).
const CASH_IN_ARTICLES = [
    'Возврат подотчётных средств', 'Спонсорская помощь', 'Продажа ТМЦ / имущества',
    'Аренда помещений', 'Поступление от партнёра', 'Прочее',
];
const CASH_OUT_ARTICLES = [
    'Хозяйственные расходы', 'Закуп медикаментов', 'Зарплата / аванс', 'Коммунальные платежи',
    'Аренда', 'Транспорт', 'Канцелярия', 'Инкассация', 'Трансфер в казначейство', 'Прочее',
];


// MONEY_INPUT_V2 — превращает поле в денежное: текст, живое разделение тысяч
// («40 000»), значение читается moneyVal(inp). Применяется ко всем суммам кассы.
//
// Разбор вынесен в shared/money-input.js. Здесь он был написан регулярками
// /D+/g и /^d+$/ — БЕЗ обратной косой, то есть по литеральной букве «D» вместо
// «не цифра». Пробел-разделитель тысяч не вычищался, Number('5 0000') давал
// NaN, а NaN || 0 — ноль: поле «Сумма» схлопывалось в «0» на пятой цифре, и
// любая сумма от тысячи уходила на сервер нулём. В модуле у этого есть тесты,
// в DOM-обёртке их не напишешь.
function moneyfy(inp) {
    inp.type = 'text'; inp.inputMode = 'numeric'; inp.autocomplete = 'off';
    if (inp.value) inp.value = moneyDisplay(inp.value);
    inp.addEventListener('input', () => {
        const caretFromEnd = inp.value.length - (inp.selectionStart ?? inp.value.length);
        inp.value = moneyDisplay(inp.value);
        const pos = Math.max(0, inp.value.length - caretFromEnd);
        try { inp.setSelectionRange(pos, pos); } catch (e) {}
    });
    return inp;
}
function moneyVal(inp) { return moneyNumber(inp.value); }

const RU_M_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const RU_M_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
// «16 июл. 18:45» — the shift banner
function fmtRuShort(iso) {
    const d = new Date(iso);
    return `${d.getDate()} ${RU_M_SHORT[d.getMonth()]}. ${hhmm(d)}`;
}
// «30 июля 2026 г. в 11:31» — the СОЗДАН column
function fmtRuLong(iso) {
    // I18N_COVERAGE_V1 — единый локале-зависимый формат из ui.js вместо русской сборки, которую tr() не найдёт
    return fmtDateTime(iso);
}
// CASHIER_ROW_FIT_V1 — «16.08.2026 21:25» for the СОЗДАН column. Distinct from
// fmtRuShort above, which drops the year and is what the shift banner, the
// printed receipts and the payment log already use — this needs the year and a
// constant width, they need brevity.
function fmtRuNumeric(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${hhmm(d)}`;
}
const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shiftNo = (shift) => 'CASHIER/' + String(shift.id).padStart(5, '0');

// =============================================================================
// CASHIER WORKSPACE (Касса) — nav id 'cashier-shifts'
// =============================================================================
const state = {
    filter: 'unpaid',       // 'unpaid' | 'debt' | 'partial' | 'paid' | 'cancelled' | 'all'
    search: '',
    rows:   [],
    counts: null,
    deposits: [],   // DEPOSIT_V1 — ждущие приёма предоплаты
};

export async function renderCashier(container) {
    clear(container);
    state.filter = 'unpaid';
    state.search = '';
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);
    await paint(root);
}

async function paint(root) {
    clear(root);

    let summary;
    try {
        const { data, error } = await supabase.rpc('cash_shift_summary', {});
        if (error) throw error;
        summary = data;
    } catch (e) {
        root.appendChild(h('div', { class: 'card', style: { padding: '18px' } },
            h('div', { class: 'empty' }, trf('Не удалось загрузить кассу: {msg}', { msg: (e && e.message) || e }))));
        return;
    }

    if (!summary || !summary.shift) { root.appendChild(openShiftCard(root)); return; }

    root.appendChild(shiftBanner(root, summary));
    root.appendChild(kpiTiles(summary));
    root.appendChild(await paymentsCard(root, summary));
}

// ---- No open shift ----------------------------------------------------------
function openShiftCard(root) {
    const card = h('div', { class: 'card', style: { padding: '26px', textAlign: 'center' } },
        h('div', { style: { color: 'var(--ink-400)', marginBottom: '8px' } }, Icon('Wallet', { size: 32 })),
        h('h3', { style: { margin: '0 0 4px' } }, 'Смена не открыта'),
        h('p', { class: 'muted', style: { fontSize: '13.5px', margin: '0 0 16px' } },
            'Откройте смену, чтобы принимать оплаты. Укажите наличные, которые уже лежат в кассе, как начальный остаток.'),
    );
    card.appendChild(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openShiftModal(root) },
        Icon('Plus', { size: 14 }), ' Открыть смену'));
    return card;
}

function openShiftModal(root) {
    const floatInp = moneyfy(h('input', { type: 'number', min: '0', step: '1', value: '0' }));
    modal('Открыть смену', 'Wallet',
        [field('Начальный остаток (наличные в кассе)', floatInp, { required: true })],
        'Открыть смену',
        async () => {
            const v = moneyVal(floatInp);
            if (!Number.isFinite(v) || v < 0) { toast('Укажите корректный начальный остаток.', 'fail'); return false; }
            const { error } = await supabase.rpc('open_cash_shift', { opening_float: v });
            if (error) { toast((error.message) || 'Не удалось открыть смену.', 'fail'); return false; }
            toast('Смена открыта', 'ok');
            await paint(root);
            return true;
        });
}

// ---- Teal shift banner -------------------------------------------------------
function shiftBanner(root, summary) {
    const { shift, totals } = summary;
    const stale = ymdLocal(new Date(shift.opened_at)) !== ymdLocal(new Date());

    const bannerBtn = (label, icon, onclick, opts = {}) => h('button', {
        type: 'button', onclick,
        style: {
            display: 'inline-flex', alignItems: 'center', gap: '7px',
            padding: '9px 14px', borderRadius: '10px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600,
            border: '1px solid ' + (opts.danger ? '#dc2626' : 'rgba(255,255,255,0.28)'),
            background: opts.danger ? '#dc2626' : 'rgba(255,255,255,0.12)',
            color: '#fff', whiteSpace: 'nowrap',
            transition: 'background .1s',
        },
        onmouseenter: (e) => { e.currentTarget.style.background = opts.danger ? '#b91c1c' : 'rgba(255,255,255,0.22)'; },
        onmouseleave: (e) => { e.currentTarget.style.background = opts.danger ? '#dc2626' : 'rgba(255,255,255,0.12)'; },
    }, Icon(icon, { size: 14 }), label);

    return h('div', {
        style: {
            background: 'linear-gradient(120deg, var(--primary-800, #0b5d52), var(--primary-600, #128577))',
            borderRadius: '16px', padding: '16px 20px', marginBottom: '16px',
            display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap',
            boxShadow: '0 4px 14px rgba(11,93,82,0.25)',
        },
    },
        h('div', {
            style: {
                width: '44px', height: '44px', borderRadius: '12px', flex: '0 0 auto',
                background: 'rgba(255,255,255,0.14)', color: '#fff',
                display: 'grid', placeItems: 'center',
            },
        }, Icon('Wallet', { size: 20 })),
        h('div', { style: { minWidth: 0 } },
            h('div', { style: { color: '#fff', fontWeight: 700, fontSize: '15px' } },
                (summary.cashier_name || 'Кассир') + (summary.branch_name ? ' · ' + summary.branch_name : '')),
            h('div', { style: { color: 'rgba(255,255,255,0.75)', fontSize: '12.5px', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                trf('Смена {no} · открыта {when} · платежей: {n}', { no: shiftNo(shift), when: fmtRuShort(shift.opened_at), n: totals.count }),
                stale ? h('span', {
                    style: {
                        background: '#fbe8b5', color: '#7a5b00', borderRadius: '999px',
                        padding: '2px 10px', fontSize: '12.5px', fontWeight: 600,
                    },
                }, 'смена не сегодняшняя — закройте и откройте новую') : null,
            ),
        ),
        h('span', { style: { flex: '1 1 auto' } }),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            bannerBtn('Внутренний отчёт', 'Print', () => printShiftReport(true)),
            bannerBtn('X-отчёт', 'Doc', () => xReportModal()),
            bannerBtn('Внести', 'Plus', () => moveModal(root, 'in')),
            bannerBtn('Изъять', 'ArrowUp', () => moveModal(root, 'out')),
            // SHIFT_AUTO_V2 — смена закрывается сама в полночь; ручной кнопки нет
        ),
    );
}

// ---- KPI tiles ----------------------------------------------------------------
function kpiTiles(summary) {
    const { shift, totals } = summary;
    const cashIn = (totals.cash || 0) + (summary.cash_in || 0);

    const tile = (icon, iconColor, tint, label, value, sub) => h('div', {
        style: {
            background: tint || 'var(--white, #fff)', border: '1px solid var(--ink-100)',
            borderRadius: '14px', padding: '14px 16px', minWidth: 0,
        },
    },
        h('div', {
            style: {
                width: '30px', height: '30px', borderRadius: '9px', marginBottom: '10px',
                background: 'var(--white, #fff)', color: iconColor,
                display: 'grid', placeItems: 'center', border: '1px solid var(--ink-100)',
            },
        }, Icon(icon, { size: 15 })),
        h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' } }, label),
        h('div', { style: { marginTop: '4px', display: 'flex', alignItems: 'baseline', gap: '5px' } },
            h('span', { class: 'num', style: { fontSize: '20px', fontWeight: 800, color: 'var(--ink-900)', fontVariantNumeric: 'tabular-nums' } }, value),
            h('span', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 700 } }, 'UZS'),
        ),
        sub ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, sub) : null,
    );

    return h('div', {
        style: {
            display: 'grid', gap: '12px', marginBottom: '16px',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        },
    },
        tile('Doc',      'var(--ink-600)',  '',        'Старт смены',      fmtPrice(shift.opening_float)),
        tile('Check',    'var(--ok-600, #16a34a)',  'var(--ok-50, #ecfdf5)',  'Оплачено счетов',  fmtPrice(totals.total), trf('{n} платеж.', { n: totals.count })),
        tile('Plus',     'var(--ok-600, #16a34a)',  'var(--ok-50, #ecfdf5)',  'Приход наличных',  fmtPrice(cashIn)),
        tile('ID',       '#4f46e5',         '#eef2ff', 'Оплата картой',    fmtPrice(totals.card)),
        tile('Activity', '#2563eb',         '#eff6ff', 'Эквайринг',        fmtPrice(totals.acquiring || 0)),
        tile('ArrowUp',  '#dc2626',         '#fef2f2', 'Расход наличных',  fmtPrice(summary.cash_out)),
        tile('Wallet',   '#2563eb',         '#eff6ff', 'Остаток наличных', fmtPrice(summary.expected_drawer)),
    );
}

// ---- Внести / Изъять ----------------------------------------------------------
function moveModal(root, kind) {
    const isIn = kind === 'in';
    const amtInp = moneyfy(h('input', { type: 'number', min: '0', step: '1', value: '' }));
    const artSel = h('select', null, ...(isIn ? CASH_IN_ARTICLES : CASH_OUT_ARTICLES).map(a => h('option', { value: a }, a)));
    const noteInp = h('input', { type: 'text', placeholder: 'Комментарий (необязательно)' });
    modal(isIn ? 'Внести наличные' : 'Изъять наличные', isIn ? 'Plus' : 'ArrowUp',
        [
            field('Сумма', amtInp, { required: true }),
            field('Статья', artSel),
            field('Примечание', noteInp),
        ],
        isIn ? 'Внести' : 'Изъять',
        async () => {
            const v = moneyVal(amtInp);
            if (!Number.isFinite(v) || v <= 0) { toast('Укажите сумму больше нуля.', 'fail'); return false; }
            const { error } = await supabase.rpc('cash_move', { kind, amount: v, article: artSel.value, note: noteInp.value || '' });
            if (error) { toast((error.message) || 'Не удалось выполнить операцию.', 'fail'); return false; }
            toast(isIn ? 'Наличные внесены' : 'Наличные изъяты', 'ok');
            await paint(root);
            return true;
        });
}

// ---- X-отчёт / История / печать ------------------------------------------------
async function loadShiftReport() {
    const { data, error } = await supabase.rpc('shift_report', {});
    if (error) { toast(error.message || 'Не удалось получить отчёт.', 'fail'); return null; }
    return data;
}

function xReportModal() {
    loadShiftReport().then((r) => {
        if (!r) return;
        const line = (label, value, strong) => h('div', { class: 'row', style: { padding: '7px 0', borderBottom: '1px solid var(--ink-50)', fontSize: '13.5px' } },
            h('span', { style: { color: 'var(--ink-600)' } }, label),
            h('span', { class: 'grow' }),
            h('span', { class: 'num', style: { fontWeight: strong ? 800 : 600, color: strong ? 'var(--primary-700)' : 'var(--ink-900)' } }, value));
        modal(trf('X-отчёт · {no}', { no: shiftNo(r.shift) }), 'Doc',
            [
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } },
                    trf('Открыта {when} · касса остаётся открытой', { when: fmtRuShort(r.shift.opened_at) })),
                line('Старт смены', fmtPrice(r.shift.opening_float)),
                line('Наличные', fmtPrice(r.totals.cash)),
                line('Карта', fmtPrice(r.totals.card)),
                line('Перевод', fmtPrice(r.totals.transfer)),
                line('Эквайринг', fmtPrice(r.totals.acquiring)),
                line(trf('Всего оплат ({n} платеж.)', { n: r.totals.count }), fmtPrice(r.totals.total)),
                line('Внесения', fmtPrice(r.cash_in)),
                line('Изъятия', fmtPrice(r.cash_out)),
                line('Остаток наличных', fmtPrice(r.expected_drawer), true),
            ],
            'Печать',
            async () => { printReportDoc(r, false); return false; });
    });
}

// CASHIER_HISTORY_ALL_V2 — «История операций»: the FULL feed, not just the
// current shift. Every invoice event and every payment/возврат (direct read of
// the registered payments table; invoices missing from the loaded «Приём
// оплат» rows are resolved with one extra invoices read), plus drawer
// movements — full cash_movements history when that table is readable via
// /api/db, else the current shift's from shift_report. Grouped by day, newest
// first; each positive payment carries a «Возврат» action (refund_payment RPC).
async function historyModal(root) {
    const invById = new Map(state.rows.map(r => [r.id, r]));

    let payRows = [];
    try {
        const { data } = await supabase.from('payments')
            .select('id, invoice_id, amount, method, paid_at, notes')
            .order('paid_at', { ascending: false }).limit(500);
        payRows = data || [];
    } catch (e) { /* the feed still shows invoices */ }

    // Resolve invoice labels the loaded list doesn't hold (older than its cap).
    const extraInv = new Map();
    const missing = [...new Set(payRows.map(p => p.invoice_id))].filter(id => id != null && !invById.has(id));
    if (missing.length) {
        try {
            const { data } = await supabase.from('invoices')
                .select('id, invoice_number, patients(full_name)').in('id', missing).limit(500);
            for (const r of (data || [])) {
                extraInv.set(r.id, { id: r.id, invoice_number: r.invoice_number, patient_name: (r.patients && r.patients.full_name) || '' });
            }
        } catch (e) { /* leave unresolved */ }
    }
    const invInfo = (id) => invById.get(id) || extraInv.get(id) || null;

    let moveRows = [];
    try {
        const { data, error } = await supabase.from('cash_movements')
            .select('id, kind, amount, article, note, created_at')
            .order('id', { ascending: false }).limit(300);
        if (error || !data) throw new Error('cash_movements not readable');
        moveRows = data;
    } catch (e) {
        try {
            const { data } = await supabase.rpc('shift_report', {});
            moveRows = (data && data.movements) || [];
        } catch (e2) { moveRows = []; }
    }

    const events = [];
    for (const inv of state.rows) events.push({ t: inv.created_at, kind: 'invoice', inv });
    for (const p of payRows)      events.push({ t: p.paid_at, kind: p.amount < 0 ? 'refund' : 'payment', p });
    for (const m of moveRows)     events.push({ t: m.created_at, kind: 'move', m });
    events.sort((a, b) => new Date(b.t || 0) - new Date(a.t || 0));

    // Two-line rows: bold title + amount on top, full details below (no truncation).
    const line = (time, title, titleColor, sub, right, action) => h('div', { style: { padding: '9px 0', borderBottom: '1px solid var(--ink-50)' } },
        h('div', { class: 'row', style: { gap: '10px', fontSize: '12.5px', alignItems: 'center' } },
            h('span', { class: 'muted num', style: { flex: '0 0 44px' } }, time),
            h('span', { style: { flex: 1, minWidth: 0, fontWeight: 700, color: titleColor || 'var(--ink-900)' } }, title),
            action || null,
            right),
        sub ? h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '3px 0 0 54px', lineHeight: 1.5, wordBreak: 'break-word' } }, sub) : null,
    );

    const refundBtnSmall = (p) => h('button', {
        class: 'btn btn-outline btn-sm', type: 'button',
        style: { color: 'var(--crit-600, #dc2626)', borderColor: 'var(--crit-200, #fecaca)' },
        onclick: () => openRefundConfirm(p, invInfo(p.invoice_id), root),
    }, 'Возврат');

    const rows = [];
    let lastDay = null;
    for (const ev of events.slice(0, 600)) {
        const d = new Date(ev.t || 0);
        const day = ymdLocal(d);
        if (day !== lastDay) {
            lastDay = day;
            rows.push(h('div', { style: { padding: '12px 0 4px', fontSize: '12.5px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--ink-500)' } },
                fmtDate(d)));
        }
        if (ev.kind === 'payment' || ev.kind === 'refund') {
            const p = ev.p;
            const isRefund = ev.kind === 'refund';
            const inv = invInfo(p.invoice_id);
            const reason = isRefund && p.notes && p.notes.includes(' — ') ? p.notes.slice(p.notes.indexOf(' — ') + 3) : '';
            const sub = [
                tr(METHOD_RU[p.method] || p.method),
                inv ? trf('счёт {no}', { no: inv.invoice_number || '#' + inv.id }) : tr('счёт удалён из списка'),
                inv && inv.patient_name ? inv.patient_name : null,
                reason ? trf('причина: {reason}', { reason }) : null,
            ].filter(Boolean).join(' · ');
            rows.push(line(hhmm(d),
                isRefund ? 'Возврат оплаты' : 'Оплата',
                isRefund ? 'var(--crit-600, #dc2626)' : 'var(--ink-900)',
                sub,
                h('span', { class: 'num', style: { fontWeight: 700, color: isRefund ? 'var(--crit-600)' : 'var(--ok-700)' } },
                    (isRefund ? '−' : '+') + fmtPrice(Math.abs(p.amount))),
                isRefund ? null : refundBtnSmall(p)));
        } else if (ev.kind === 'invoice') {
            const inv = ev.inv;
            const cancelled = inv.status === 'void' || inv.status === 'refunded';
            const svc = inv.first_item
                ? inv.first_item + (inv.items_count > 1 ? ' ' + trf('+{n} ещё', { n: inv.items_count - 1 }) : '')
                : null;
            const debt = Math.max(Number(inv.total_amount || 0) - Number(inv.paid_amount || 0), 0);
            const sub = [
                inv.patient_name || '—',
                svc,
                inv.doctor_name ? trf('врач: {name}', { name: inv.doctor_name }) : null,
                cancelled ? tr('отменён') : (debt > 0 ? trf('долг {sum}', { sum: fmtPrice(debt) }) : tr('оплачен полностью')),
            ].filter(Boolean).join(' · ');
            rows.push(line(hhmm(d),
                trf('Счёт {no} выставлен', { no: inv.invoice_number || '#' + inv.id }),
                cancelled ? 'var(--ink-400)' : 'var(--ink-900)',
                sub,
                h('span', { class: 'num', style: { fontWeight: 600, color: cancelled ? 'var(--ink-400)' : 'var(--ink-900)', textDecoration: cancelled ? 'line-through' : 'none' } },
                    fmtPrice(inv.total_amount))));
        } else {
            const m = ev.m;
            rows.push(line(hhmm(d),
                m.kind === 'in' ? 'Внесение наличных' : 'Изъятие наличных',
                'var(--ink-900)',
                [m.article, m.note].filter(Boolean).join(' · ') || null,
                h('span', { class: 'num', style: { fontWeight: 700, color: m.kind === 'in' ? 'var(--ok-700)' : 'var(--crit-600)' } },
                    (m.kind === 'in' ? '+' : '−') + fmtPrice(m.amount))));
        }
    }

    modal('История операций', 'Clock',
        [rows.length
            ? h('div', { style: { maxHeight: '62vh', overflow: 'auto' } }, ...rows)
            : h('div', { class: 'empty' }, 'Операций пока нет.')],
        'Закрыть',
        async () => true, 760);
}

async function printShiftReport(withPayments) {
    const r = await loadShiftReport();
    if (r) printReportDoc(r, withPayments);
}

/* i18n-exempt-start: печатная форма X-отчёта / внутреннего отчёта смены — печатный документ, намеренно русский */
/* type-scale-exempt-start: печатный документ — семейство Onest, размеры остаются его выверенными метриками (дизайн-док 2026-08-31) */
function printReportDoc(r, withPayments) {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const row = (l, v, strong) => `<tr><td style="padding:4px 0;color:#555">${esc(l)}</td><td style="padding:4px 0;text-align:right;font-weight:${strong ? 800 : 600}">${esc(v)}</td></tr>`;
    // i18n-exempt: печатная форма X-отчёта/внутреннего отчёта — печатные документы намеренно русские
    let body = `
      <h2 style="margin:0 0 2px">${withPayments ? 'Внутренний отчёт' : 'X-отчёт'} · ${esc(shiftNo(r.shift))}</h2>
      <div style="color:#777;font-size:12px;margin-bottom:14px">${esc(r.cashier_name || '')} · открыта ${esc(fmtRuShort(r.shift.opened_at))} · сформирован ${esc(fmtRuShort(new Date().toISOString()))}</div>
      <table style="width:100%;border-collapse:collapse;font-size:13.5px;max-width:420px">
        ${row('Старт смены', fmtPrice(r.shift.opening_float))}
        ${row('Наличные', fmtPrice(r.totals.cash))}
        ${row('Карта', fmtPrice(r.totals.card))}
        ${row('Перевод', fmtPrice(r.totals.transfer))}
        ${row('Эквайринг', fmtPrice(r.totals.acquiring))}
        ${row(`Всего оплат (${r.totals.count} платеж.)`, fmtPrice(r.totals.total))}
        ${row('Внесения', fmtPrice(r.cash_in))}
        ${row('Изъятия', fmtPrice(r.cash_out))}
        ${row('Остаток наличных', fmtPrice(r.expected_drawer), true)}
      </table>`;
    if (withPayments) {
        // i18n-exempt: печатная форма — строки платежей
        const pRows = r.payments.map((p) =>
            `<tr><td style="padding:3px 6px 3px 0;color:#555">${esc(fmtRuShort(p.paid_at))}</td><td style="padding:3px 6px">${esc(p.patient || '')}</td><td style="padding:3px 6px;color:#777">${esc(p.invoice || '')}</td><td style="padding:3px 6px">${esc(METHOD_RU[p.method] || p.method)}</td><td style="padding:3px 0;text-align:right;font-weight:600">${fmtPrice(p.amount)}</td></tr>`).join('');
        // i18n-exempt: печатная форма — движения наличных
        const mRows = r.movements.map((m) =>
            `<tr><td style="padding:3px 6px 3px 0;color:#555">${esc(fmtRuShort(m.created_at))}</td><td style="padding:3px 6px" colspan="2">${m.kind === 'in' ? 'Внесение' : 'Изъятие'}${m.article ? ' · ' + esc(m.article) : ''}</td><td></td><td style="padding:3px 0;text-align:right;font-weight:600">${m.kind === 'in' ? '+' : '−'}${fmtPrice(m.amount)}</td></tr>`).join('');
        // i18n-exempt: печатная форма — заголовки таблиц
        body += `
          <h3 style="margin:18px 0 6px;font-size:14px">Платежи</h3>
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">${pRows || '<tr><td style="color:#999">Нет платежей.</td></tr>'}</table>
          ${mRows ? `<h3 style="margin:18px 0 6px;font-size:14px">Движения наличных</h3><table style="width:100%;border-collapse:collapse;font-size:12.5px">${mRows}</table>` : ''}`;
    }
    const w = window.open('', '_blank');
    if (!w) { toast('Разрешите всплывающие окна для печати.', 'fail'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(shiftNo(r.shift))}</title><style>${PRINT_FONT_FACE_CSS}</style></head>
      <body style="font-family:'Onest',-apple-system,'Segoe UI',Roboto,sans-serif;padding:28px">${body}
      <script>window.onload = () => (document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(() => window.print());</script></body></html>`);
    w.document.close();
}
/* type-scale-exempt-end */
/* i18n-exempt-end */

// ---- Close shift ---------------------------------------------------------------
function closeShiftModal(root, shift, expectedDrawer) {
    const countedInp = moneyfy(h('input', { type: 'number', min: '0', step: '1', value: '' }));
    const notesInp = h('input', { type: 'text', placeholder: 'Комментарий (необязательно)' });
    const diffEl = h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } });
    const renderDiff = () => {
        clear(diffEl);
        const c = moneyVal(countedInp);
        if (!Number.isFinite(c) || countedInp.value === '') {
            diffEl.appendChild(h('span', null, 'Ожидается в кассе: ', h('strong', null, fmtPrice(expectedDrawer)), ' сум'));
            return;
        }
        const os = Math.round((c - expectedDrawer) * 100) / 100;
        diffEl.appendChild(h('span', null, 'Ожидается ', h('strong', null, fmtPrice(expectedDrawer)), ' · ',
            os === 0 ? h('span', { style: { color: 'var(--ok-700)', fontWeight: 600 } }, 'сходится')
                     : h('span', { style: { color: os > 0 ? 'var(--primary-700)' : 'var(--crit-600)', fontWeight: 600 } }, (os > 0 ? 'излишек +' : 'недостача ') + fmtPrice(os))));
    };
    countedInp.addEventListener('input', renderDiff);
    renderDiff();

    modal(trf('Закрыть смену · {no}', { no: shiftNo(shift) }), 'Wallet',
        [field('Пересчитанные наличные в кассе', countedInp, { required: true }), diffEl, field('Примечание', notesInp)],
        'Закрыть смену',
        async () => {
            const c = moneyVal(countedInp);
            if (!Number.isFinite(c) || c < 0) { toast('Укажите пересчитанную сумму.', 'fail'); return false; }
            const { data, error } = await supabase.rpc('close_cash_shift', { shift_id: shift.id, counted_amount: c, notes: notesInp.value || '' });
            if (error) { toast((error.message) || 'Не удалось закрыть смену.', 'fail'); return false; }
            const os = data && data.shift ? data.shift.over_short : 0;
            toast(os === 0 ? 'Смена закрыта — касса сходится' : (os > 0 ? trf('Смена закрыта — излишек +{sum}', { sum: fmtPrice(os) }) : trf('Смена закрыта — недостача {sum}', { sum: fmtPrice(os) })), os === 0 ? 'ok' : 'info');
            await paint(root);
            return true;
        });
}

// =============================================================================
// «Приём оплат» — invoice list with chips, search, pay / cancel, Excel.
// =============================================================================
async function paymentsCard(root, summary) {
    const chipsEl = h('div');
    const searchEl = h('div');
    const tableEl = h('div');

    const headBtn = (label, icon, onclick, primary) => h('button', {
        class: primary ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm',
        type: 'button', onclick,
    }, Icon(icon, { size: 13 }), ' ' + label);

    const card = h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, summary.branch_name ? trf('Приём оплат — счета филиала {name}', { name: summary.branch_name }) : 'Приём оплат — счета клиники'),
            h('div', { class: 'row', style: { gap: '8px' } },
                headBtn('Обновить', 'Refresh', () => paint(root)),
                headBtn('История', 'Clock', () => historyModal(root)),
                headBtn('Excel', 'Download', () => exportInvoicesXlsx()),
            ),
        ),
        h('div', { style: { padding: '14px 16px' } }, chipsEl, searchEl, tableEl),
    );

    await loadInvoices();
    function repaintTable() {
        paintChips(chipsEl, repaintTable);
        paintSearch(searchEl, repaintTable);
        paintTable(tableEl, root);
    }
    repaintTable();
    return card;
}

async function loadInvoices() {
    state.rows = [];
    state.counts = null;
    const { data, error } = await supabase.rpc('cashier_invoices', {});
    if (error) { toast(trf('Не удалось загрузить счета: {msg}', { msg: error.message || error }), 'fail'); return; }
    state.rows = (data && data.rows) || [];
    state.counts = (data && data.counts) || null;
    // DEPOSIT_V1 — отдельный запрос: депозиты не счета, в cashier_invoices их
    // нет. Сбой списка депозитов не должен прятать счета — чип просто покажет 0.
    try {
        // DEPOSIT_REVENUE_V1 — тянем все: принятые тоже должны быть видны, иначе
        // деньги, которые кассир только что взял, исчезают с экрана.
        const dep = await supabase.rpc('list_deposits', { status: 'all' });
        state.deposits = (dep && dep.data && dep.data.rows) || [];
    } catch (e) { state.deposits = []; }
}

// CASHIER_ROW_FIT_V1 — invoice statuses in this screen's own language.
//
// The row tag used ui.js's shared StatusTag, whose STATUS_MAP is an English
// table shared with the clinical screens ('Unpaid', 'Cancelled'). So the filter
// tile said «НЕ ОПЛАЧЕН» while the row beside it said «Unpaid» — the same fact
// in two languages, a metre apart. Mapping locally keeps the fix off every
// other screen that leans on the shared map.
const INV_STATUS_RU = {
    unpaid:   { text: 'Не оплачен', kind: 'warn' },
    debt:     { text: 'Долг',       kind: 'warn' },
    partial:  { text: 'Частично',   kind: 'info' },
    paid:     { text: 'Оплачен',    kind: 'ok'   },
    void:     { text: 'Отменён',    kind: 'crit' },
    refunded: { text: 'Возврат',    kind: 'crit' },
};
function invStatusTag(status) {
    const m = INV_STATUS_RU[status];
    return m ? Tag(m.text, { kind: m.kind, dot: true }) : StatusTag(status);
}

const CHIPS = [
    { key: 'unpaid',    label: 'НЕ ОПЛАЧЕН', icon: 'Warning',  color: 'var(--crit-600, #dc2626)' },
    { key: 'debt',      label: 'ДОЛГ',       icon: 'Receipt',  color: '#b45309' },
    { key: 'partial',   label: 'ЧАСТИЧНО',   icon: 'Activity', color: '#b45309' },
    { key: 'paid',      label: 'ОПЛАЧЕН',    icon: 'Check',    color: 'var(--ok-600, #16a34a)' },
    { key: 'cancelled', label: 'ОТМЕНЁН',    icon: 'X',        color: 'var(--crit-600, #dc2626)' },
    { key: 'all',       label: 'ВСЕ СЧЕТА',  icon: 'Doc',      color: 'var(--ink-700)' },
    // DEPOSIT_V1 — предоплаты стоят рядом со счетами: касса принимает и то и
    // другое, и разводить их по разным экранам значит прятать половину работы.
    { key: 'deposits',  label: 'ДЕПОЗИТЫ',   icon: 'Wallet',   color: 'var(--primary-700, #167873)' },
];

function paintChips(el, onChange) {
    clear(el);
    const c = state.counts || {};
    el.appendChild(h('div', {
        style: {
            display: 'grid', gap: '10px', marginBottom: '12px',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        },
    },
        ...CHIPS.map((chip) => {
            const pendingDeps = (state.deposits || []).filter((d) => d.status === 'pending');
            const agg = chip.key === 'deposits'
                ? { n: pendingDeps.length, sum: pendingDeps.reduce((n, d) => n + Number(d.amount || 0), 0) }
                : (c[chip.key] || { n: 0, sum: 0 });
            const active = state.filter === chip.key;
            return h('button', {
                type: 'button',
                onclick: () => { state.filter = chip.key; onChange(); },
                style: {
                    textAlign: 'left', padding: '12px 14px', borderRadius: '12px', cursor: 'pointer',
                    fontFamily: 'inherit', background: 'var(--white, #fff)',
                    border: active ? '2px solid var(--primary-500)' : '1px solid var(--ink-100)',
                    boxShadow: active ? '0 0 0 3px var(--primary-50)' : 'none',
                },
            },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', color: chip.color, fontSize: '12.5px', fontWeight: 800, letterSpacing: '0.05em' } },
                    Icon(chip.icon, { size: 13 }), chip.label),
                h('div', { class: 'num', style: { fontSize: '20px', fontWeight: 800, color: 'var(--ink-900)', marginTop: '4px' } }, String(agg.n)),
                h('div', { class: 'muted num', style: { fontSize: '12.5px', marginTop: '1px' } },
                    chip.key === 'all' || chip.key === 'paid' || chip.key === 'cancelled'
                        ? fmtPrice(agg.sum) + ' UZS'
                        : fmtPrice(agg.sum) + ' UZS'),
            );
        }),
    ));
}

// DEPOSIT_V1 — список предоплат, ждущих приёма, и кнопка «Принять».
//
// Принимает ТОЛЬКО касса и только через accept_deposit: там же, в одной
// транзакции, наличные попадают в ящик смены. Прямая правка строки из браузера
// оставила бы ящик несведённым на закрытии.
function paintDeposits(el, root) {
    const all = state.deposits || [];
    if (!all.length) {
        el.appendChild(h('div', { class: 'empty' }, 'Депозитов пока нет.'));
        return;
    }
    // DEPOSIT_REVENUE_V1 — сначала те, кто ждёт денег (это работа кассира),
    // следом принятые и возвращённые: касса должна видеть, что она сегодня взяла,
    // и уметь вернуть. Раньше список показывал только pending, и принятый депозит
    // пропадал с экрана в тот момент, когда за него взяли деньги.
    const order = { pending: 0, received: 1, refunded: 2, cancelled: 3 };
    const rows = all.slice().sort((a, b) =>
        (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.id - a.id);
    const tbody = h('tbody');
    for (const d of rows) {
        // DEPOSIT_METHOD_BY_CASHIER_V1 — способ выбирает ТОТ, КТО БЕРЁТ ДЕНЬГИ.
        // Раньше здесь стоял confirm(), и «Принять» молча записывало наличные:
        // при оплате картой ящик расходился с тем, что кассир действительно взял,
        // а разница всплывала только на закрытии смены.
        //
        // DEPOSIT_ACCEPT_MODAL_V1 — выбор переехал из строки таблицы в ОКНО, как
        // у оплаты счёта. Это то же самое действие: видно, от кого и сколько,
        // отмечаешь способ, подтверждаешь. Список прямо в строке этого не
        // показывал и менялся молча — щелчок мимо, и депозит принят не тем
        // способом, без единого подтверждения.
        const acceptBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Принять');
        acceptBtn.addEventListener('click', () => openAcceptDepositModal(d, root));

        const cancelBtn = h('button', { class: 'btn btn-sm', type: 'button', style: { color: 'var(--crit-600)' } }, 'Отменить');
        cancelBtn.addEventListener('click', async () => {
            if (!confirm(trf('Отменить депозит {no}? Деньги по нему не приняты.', { no: d.deposit_number || '' }))) return;
            cancelBtn.disabled = true;
            const { error } = await supabase.rpc('cancel_deposit', { deposit_id: d.id });
            if (error) { toast(trf('Не удалось отменить: {msg}', { msg: error.message || error }), 'fail'); cancelBtn.disabled = false; return; }
            toast('Депозит отменён.', 'info');
            paint(root);
        });
        // DEPOSIT_REFUND_V1 — принятый депозит возвращается тем же способом,
        // каким его взяли: отрицательный платёж по счёту депозита (сервер), а на
        // экране — одна кнопка рядом со статусом «Оплачен».
        const refundBtn = h('button', { class: 'btn btn-sm', type: 'button', style: { color: 'var(--crit-600)' } }, 'Возврат');
        refundBtn.addEventListener('click', async () => {
            const max = Number(d.amount || 0);
            const raw = prompt(trf('Вернуть по депозиту {no}', { no: d.deposit_number || '' }) + '\n'
                + trf('Принято: {sum} сум. Сколько вернуть?', { sum: fmtPrice(max) }), String(max));
            if (raw === null) return;
            const amount = Math.round(Number(String(raw).replace(/\D+/g, '')) || 0);
            if (!(amount > 0)) { toast('Введите сумму возврата.', 'fail'); return; }
            refundBtn.disabled = true;
            const { error } = await supabase.rpc('refund_deposit', { deposit_id: d.id, amount });
            if (error) { toast(error.message || 'Не удалось вернуть.', 'fail'); refundBtn.disabled = false; return; }
            toast(trf('Возврат оформлен: {sum} сум', { sum: fmtPrice(amount) }), 'ok');
            paint(root);
        });

        const statusTag = d.status === 'received' ? Tag('Оплачен', { kind: 'ok', dot: true })
            : d.status === 'refunded' ? Tag('Возвращён', { kind: 'crit', dot: true })
            : d.status === 'cancelled' ? Tag('Отменён', { kind: '', dot: true })
            : Tag('Ждёт оплаты', { kind: 'warn', dot: true });

        const actions = d.status === 'pending' ? [cancelBtn, acceptBtn]
            : d.status === 'received' ? [refundBtn]
            : [];

        tbody.appendChild(h('tr', null,
            h('td', { class: 'cell-strong' }, d.deposit_number || ('#' + d.id)),
            h('td', null, d.patient_name || '—'),
            h('td', { class: 'muted' }, d.patient_mrn || '—'),
            h('td', { class: 'num', style: { fontWeight: 700 } }, fmtPrice(d.amount), ' сум'),
            // Колонка «Способ» у ждущего депозита теперь не мёртвое «—», а сам
            // выбор: кассир отмечает, чем заплатили, в той же строке.
            // У ждущего депозита способа ещё НЕТ — его называет кассир в окне
            // приёма. Пишем это словами, а не «—»: прочерк читается как «данных
            // нет», а их и не должно быть, пока деньги не взяли.
            h('td', { class: 'muted' }, METHOD_RU[d.method] || (d.status === 'pending' ? 'выберет касса' : '—')),
            h('td', { class: 'muted' }, d.created_by_name || '—'),
            h('td', { class: 'muted' }, fmtDateTime(d.created_at)),
            h('td', null, statusTag),
            h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                h('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } }, ...actions)),
        ));
    }
    el.appendChild(h('div', { style: { overflowX: 'auto' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, '№ депозита'), h('th', null, 'Пациент'), h('th', null, 'MRN'),
                h('th', { style: { textAlign: 'right' } }, 'Сумма'), h('th', null, 'Способ'),
                h('th', null, 'Кто завёл'), h('th', null, 'Создан'), h('th', null, 'Статус'), h('th', null, ''),
            )),
            tbody)));
}

function filteredRows() {
    let rows = state.rows;
    if (state.filter === 'cancelled') rows = rows.filter(r => r.status === 'void' || r.status === 'refunded');
    else if (state.filter !== 'all') rows = rows.filter(r => r.status === state.filter);
    const q = state.search.trim().toLowerCase();
    if (q) {
        rows = rows.filter(r =>
            (r.patient_name || '').toLowerCase().includes(q) ||
            (r.invoice_number || '').toLowerCase().includes(q) ||
            (r.mrn || '').toLowerCase().includes(q) ||
            (r.phone || '').toLowerCase().includes(q));
    }
    return rows;
}

function paintSearch(el, onChange) {
    clear(el);
    const inp = h('input', {
        type: 'text', value: state.search,
        placeholder: 'Поиск: счёт, пациент, MRN, телефон…',
        style: {
            height: '36px', padding: '0 12px', width: '340px', maxWidth: '100%',
            border: '1px solid var(--ink-200)', borderRadius: '9px',
            fontSize: '12.5px', fontFamily: 'inherit',
        },
    });
    let tmr = null;
    inp.addEventListener('input', () => {
        clearTimeout(tmr);
        tmr = setTimeout(() => { state.search = inp.value; onChange(); }, 200);
    });
    const shown = filteredRows().length;
    const total = state.counts ? state.counts.all.n : state.rows.length;
    el.appendChild(h('div', { class: 'row', style: { alignItems: 'center', gap: '10px', margin: '2px 0 12px' } },
        inp,
        h('span', { class: 'grow' }),
        h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Показано ', h('strong', null, String(shown)), ' из ', String(total)),
    ));
    // keep focus while typing (repaint replaces the node)
    if (state.search) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

function paintTable(el, root) {
    clear(el);
    if (state.filter === 'deposits') { paintDeposits(el, root); return; }
    const rows = filteredRows();
    if (!rows.length) {
        el.appendChild(h('div', { class: 'empty' }, 'Нет счетов по выбранному фильтру.'));
        return;
    }
    const th = (t, right) => h('th', { style: right ? { textAlign: 'right' } : null }, t);
    const tbody = h('tbody');
    for (const inv of rows) tbody.appendChild(invoiceRow(inv, root));
    el.appendChild(h('div', { style: { overflowX: 'auto' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                th('Пациент'), th('Услуга'), th('Врач'), th('Создан'),
                th('Сумма', true), th('Оплачено', true), th('Долг', true),
                th('Оплата'), th('Статус'), th('Действие'),
            )),
            tbody,
        ),
    ));
}

// INVOICE_DELETE_V1 — удаление отменённого счёта видит только главный админ.
//
// Проверка здесь — вежливость, а не защита: она прячет кнопку, которая всё
// равно ответила бы отказом. Право решает СЕРВЕР (rpc/cashier.js:
// deleteInvoice, роли ['admin']), и обойти его, дёрнув RPC напрямую, нельзя.
function isGeneralAdmin() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    if (!u) return false;
    if (u.is_super_admin === true || u.is_admin === true) return true;
    const extra = Array.isArray(u.extra_roles) ? u.extra_roles : [];
    return [u.role, ...extra].includes('admin');
}

function invoiceRow(inv, root) {
    const balance = Math.max(Math.round((inv.total_amount - inv.paid_amount) * 100) / 100, 0);
    const cancelled = inv.status === 'void' || inv.status === 'refunded';
    const discountPct = (inv.subtotal > 0 && inv.discount_amount > 0)
        ? Math.round(inv.discount_amount / inv.subtotal * 10000) / 100 : 0;

    const svcText = (inv.first_item || '—')
        + (inv.items_count > 1 ? ` +${inv.items_count - 1} more` : '')
        + (discountPct > 0 ? ' ' + trf('(скидка {n}%)', { n: discountPct }) : '');
    const methods = inv.methods ? inv.methods.split(',').map(m => tr(METHOD_RU[m] || m)).join(', ') : '—';

    const payBtn = (!cancelled && balance > 0)
        ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => payModal(root, inv, balance) },
            Icon('Wallet', { size: 13 }), ' Оплатить')
        : null;
    // CASHIER_REFUND_V1 — money was taken → offer the refund flow.
    const refundBtn = (!cancelled && inv.paid_amount > 0)
        ? h('button', {
            type: 'button', title: 'Возврат оплаты',
            onclick: () => openInvoiceRefund(inv, root),
            style: {
                width: '30px', height: '30px', borderRadius: '8px', cursor: 'pointer',
                border: '1px solid var(--warn-200, #fde68a)', background: 'var(--white, #fff)',
                color: 'var(--warn-700, #b45309)', display: 'inline-grid', placeItems: 'center',
            },
        }, Icon('Repeat', { size: 13 }))
        : null;
    const voidBtn = (!cancelled && inv.paid_amount <= 0)
        ? h('button', {
            type: 'button', title: 'Отменить счёт',
            onclick: () => voidModal(root, inv),
            style: {
                width: '30px', height: '30px', borderRadius: '8px', cursor: 'pointer',
                border: '1px solid var(--crit-200, #fecaca)', background: 'var(--white, #fff)',
                color: 'var(--crit-600, #dc2626)', display: 'inline-grid', placeItems: 'center',
            },
        }, Icon('X', { size: 13 }))
        : null;

    // REPRINT_DOCS_V1 — перепечатка чека и счёта ПО ЛЮБОЙ строке, включая уже
    // оплаченные. Раньше чек печатался ровно один раз — в момент приёма оплаты
    // (printFiscalCheck внутри payModal), и больше взять его было негде: у
    // оплаченного счёта в столбце «Действие» оставалась только кнопка возврата.
    // Пациент, потерявший чек, или лаборатория, которой он нужен как талон,
    // оставались ни с чем.
    const iconBtn = (title, icon, onclick, color, border) => h('button', {
        type: 'button', title, onclick,
        style: {
            width: '30px', height: '30px', borderRadius: '8px', cursor: 'pointer',
            border: '1px solid ' + border, background: 'var(--white, #fff)',
            color, display: 'inline-grid', placeItems: 'center',
        },
    }, Icon(icon, { size: 13 }));

    // Чек — только когда деньги действительно приняты: чек на неоплаченный
    // счёт был бы документом о несуществующем платеже.
    const checkBtn = (inv.paid_amount > 0)
        ? iconBtn('Печать чека', 'Wallet',
            () => printFiscalCheck(inv, inv.paid_amount, (inv.methods || '').split(',')[0] || 'cash'),
            'var(--primary-700)', 'var(--primary-200, #b6e2d6)')
        : null;
    // Счёт печатается всегда: это документ о начислении, а не об оплате.
    const invoiceBtn = iconBtn('Печать счёта', 'Doc', () => printInvoiceSheet(inv),
        'var(--ink-700)', 'var(--ink-200)');

    // INVOICE_DELETE_V1 — уборка списка: отменённые счета копятся десятками и
    // мешают искать рабочие. Только отменённые, только без платежей, только
    // главный админ — на 'refunded' кнопки нет, за возвратом стоят деньги.
    const deletable = inv.status === 'void' && !(inv.paid_amount > 0) && isGeneralAdmin();
    const deleteBtn = deletable
        ? iconBtn('Удалить отменённый счёт', 'Trash', async () => {
            const label = (inv.invoice_number || ('#' + inv.id)) + ' · ' + (inv.patient_name || '');
            if (!confirm(trf('Удалить отменённый счёт {label} безвозвратно?\n\nУслуги пациента останутся, удаляется только сам документ.', { label }))) return;
            const { error } = await supabase.rpc('delete_invoice', { invoice_id: inv.id });
            if (error) { toast(error.message || 'Не удалось удалить счёт.', 'fail'); return; }
            toast('Счёт удалён.', 'ok');
            await paint(root);
        }, 'var(--crit-600, #dc2626)', 'var(--crit-200, #fecaca)')
        : null;

    return h('tr', null,
        // CASHIER_ROW_FIT_V1 — the patient cell needs a width floor and its own
        // no-wrap, exactly like the service cell below.
        //
        // Every other column in this 10-column table either states a width or
        // holds short text, so the browser took all of its slack out of this
        // one — collapsing «Test Test · P-26-69912 · +998 95 076 80 08» into a
        // six-line stack one word wide. Truncating with an ellipsis (and the
        // full value in the tooltip) keeps the row one line tall no matter how
        // long the name or how narrow the window.
        h('td', { style: { minWidth: '210px' } }, h('div', { class: 'row', style: { gap: '10px', flexWrap: 'nowrap' } },
            Avatar({ initials: initials(inv.patient_name || '?'), color: avColor(inv.id) }),
            h('div', { style: { minWidth: 0 } },
                h('div', { class: 'cell-strong', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: inv.patient_name || '' }, inv.patient_name || '—'),
                h('div', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                    [inv.mrn, inv.phone].filter(Boolean).join(' · ')),
                // COVERAGE_SPLIT_V1 — платит не пациент: видно ещё в списке, до
                // открытия окна оплаты, иначе кассир потянется взять эти деньги.
                inv.payer_id ? h('span', {
                    style: {
                        display: 'inline-block', marginTop: '3px', padding: '1px 8px', borderRadius: '999px',
                        fontSize: '12.5px', fontWeight: 700, whiteSpace: 'nowrap',
                        background: 'var(--warn-50, #fffbeb)', color: 'var(--warn-700, #b45309)',
                    },
                    title: 'Счёт выставлен плательщику — не долг пациента',
                }, trf('платит {name}', { name: inv.payer_name || tr('плательщик') })) : null,
            ),
        )),
        h('td', { style: { maxWidth: '260px' } }, h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, svcText)),
        h('td', null, inv.doctor_name || '—'),
        // CASHIER_ROW_FIT_V1 — «16 августа 2026 г. в 21:25» in the tabular font
        // demanded more width than any other column and is what starved the
        // patient cell. In a list the cashier scans by row, the day and time are
        // what matter; the full form stays in the tooltip.
        h('td', { class: 'num', style: { fontSize: '12.5px', whiteSpace: 'nowrap' }, title: fmtRuLong(inv.created_at) },
            fmtRuNumeric(inv.created_at)),
        h('td', { class: 'num', style: { textAlign: 'right', fontWeight: 600 } }, fmtPrice(inv.total_amount)),
        h('td', { class: 'num', style: { textAlign: 'right', color: 'var(--ok-700)', fontWeight: 600 } }, fmtPrice(inv.paid_amount)),
        h('td', { class: 'num', style: { textAlign: 'right', color: balance > 0 && !cancelled ? 'var(--crit-600)' : 'var(--ink-500)', fontWeight: 700 } },
            cancelled ? '—' : fmtPrice(balance)),
        h('td', null, methods),
        h('td', null, invStatusTag(inv.status)),
        h('td', null, h('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } },
            payBtn, checkBtn, invoiceBtn, refundBtn, voidBtn, deleteBtn)),   // REPRINT_DOCS_V1 — чек/счёт доступны и после оплаты
    );
}

function payModal(root, inv, balance) {
    // SPLIT_PAY_V1 — счёт можно оплатить одним или НЕСКОЛЬКИМИ способами сразу
    // (например: часть наличными, часть картой или эквайрингом). Каждая строка —
    // способ + сумма; все строки проводятся одной транзакцией (record_payment_split),
    // каждая часть попадает в смену отдельной строкой по своему способу.
    let providers = [];
    const tenders = [{ method: 'cash', amount: balance, providerId: '' }];

    // PAY_DETAILS_V1 — кассир (и пациент у окна) должны видеть, ЗА ЧТО платят:
    // в списке счетов есть только первая позиция и «+N ещё». Тянем строки счёта
    // и показываем их прямо в окне оплаты — состав, скидка и итог.
    const linesEl = h('div');   // .modal-body — это grid с gap, свой отступ не нужен
    const money = (n) => h('span', { class: 'num', style: { whiteSpace: 'nowrap' } }, fmtPrice(n), ' сум');
    const totalRow = (label, value, opts = {}) => h('div', {
        style: {
            display: 'flex', gap: '10px', alignItems: 'baseline',
            padding: '4px 0', fontSize: opts.strong ? '13.5px' : '12.5px',
            fontWeight: opts.strong ? 800 : 500,
            color: opts.color || (opts.strong ? 'var(--ink-900)' : 'var(--ink-600)'),
        },
    }, h('span', { style: { flex: 1 } }, label), value);

    const renderLines = (items) => {
        clear(linesEl);
        if (!items) {   // ещё грузятся
            linesEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '10px 12px' } }, 'Загрузка состава счёта…'));
            return;
        }
        const box = h('div', {
            style: {
                border: '1px solid var(--ink-100)', borderRadius: '12px',
                padding: '10px 12px', background: 'var(--white, #fff)',
            },
        });
        box.appendChild(h('div', {
            style: { fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-500)', marginBottom: '6px' },
        }, 'За что платим'));

        // COVERAGE_SPLIT_V1 — счёт может быть выставлен НЕ пациенту: эти деньги
        // с него брать нельзя, они придут от организации по договору.
        if (inv.payer_id) {
            box.appendChild(h('div', {
                style: {
                    display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px',
                    padding: '9px 12px', borderRadius: '10px',
                    background: 'var(--warn-50, #fffbeb)', color: 'var(--warn-700, #b45309)',
                    fontSize: '12.5px', fontWeight: 700, lineHeight: '1.35',
                },
            }, Icon('Warning', { size: 15 }),
                h('span', null, 'Счёт выставлен на ', inv.payer_name || 'плательщика',
                    h('span', { style: { display: 'block', fontWeight: 500 } }, 'Это не долг пациента — оплата приходит от плательщика.'))));
        }

        if (!items.length) {
            box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Состав счёта недоступен.'));
        } else {
            // Длинный счёт не должен выдавливать кнопки за край экрана.
            const list = h('div', { style: { maxHeight: '190px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' } });
            for (const it of items) {
                const qty = Number(it.quantity) || 1;
                list.appendChild(h('div', { style: { display: 'flex', gap: '10px', alignItems: 'baseline', padding: '3px 0', fontSize: '12.5px' } },
                    h('span', { style: { flex: 1, minWidth: 0, color: 'var(--ink-800)' } },
                        it.description || (it.services && it.services.name) || 'Услуга',
                        qty > 1 ? h('span', { class: 'muted', style: { marginLeft: '6px' } }, '×' + qty) : null),
                    money(it.total)));
            }
            box.appendChild(list);
        }

        const sub = Number(inv.subtotal) || 0;
        const disc = Number(inv.discount_amount) || 0;
        const paid = Number(inv.paid_amount) || 0;
        box.appendChild(h('div', { style: { borderTop: '1px solid var(--ink-100)', marginTop: '8px', paddingTop: '6px' } },
            disc > 0 ? totalRow('Подытог', money(sub)) : null,
            disc > 0 ? totalRow('Скидка', h('span', { class: 'num', style: { color: 'var(--crit-600, #dc2626)', whiteSpace: 'nowrap' } }, '−' + fmtPrice(disc), ' сум')) : null,
            totalRow('Итого по счёту', money(inv.total_amount), { strong: true }),
            // Частично оплаченный счёт: видно, что уже внесено и сколько осталось.
            paid > 0 ? totalRow('Уже оплачено', h('span', { class: 'num', style: { color: 'var(--ok-700, #047857)', whiteSpace: 'nowrap' } }, fmtPrice(paid), ' сум')) : null,
            paid > 0 ? totalRow('К оплате', money(balance), { strong: true }) : null,
        ));
        linesEl.appendChild(box);
    };
    renderLines(null);
    supabase.from('invoice_items')
        .select('id, description, quantity, unit_price, total, services(id, name)')
        .eq('invoice_id', inv.id)
        .then(({ data, error }) => {
            if (error) console.warn('[cashier] invoice_items:', error.message);
            renderLines(data || []);
        });

    const bodyEl = h('div');
    // DEBT_BTN_V1 / PAY_SUMMARY_V2 — итог оплаты. Раньше это были две строки
    // моноширинным шрифтом на сером фоне: подпись и сумма сливались, а «Счёт
    // закрывается полностью» читалось как ещё одна цифра. Теперь — сумма
    // крупно справа, а под ней ЦВЕТНАЯ плашка с исходом: закрыт / долг / перебор.
    const payAmountEl = h('span', { class: 'num', style: { fontSize: '24px', fontWeight: 800, color: 'var(--ink-900)', letterSpacing: '-0.02em', whiteSpace: 'nowrap' } });
    const statusIcoEl = h('span', { style: { display: 'inline-flex', flexShrink: '0' } });
    const statusTxtEl = h('span', { style: { flex: '1', minWidth: '0' } });
    const statusAmtEl = h('span', { class: 'num', style: { fontWeight: 800, whiteSpace: 'nowrap' } });
    const statusEl = h('div', {
        style: {
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '9px 12px', borderRadius: '10px',
            fontSize: '13.5px', fontWeight: 700, lineHeight: '1.3',
        },
    }, statusIcoEl, statusTxtEl, statusAmtEl);

    const hintEl = h('div', {
        style: {
            marginTop: '2px', padding: '12px 14px',
            background: 'var(--white, #fff)', border: '1px solid var(--ink-100)',
            borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: '10px',
        },
    },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
            h('span', { style: { flex: '1', fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-600)' } }, 'Вносит пациент'),
            payAmountEl,
            h('span', { style: { fontSize: '12.5px', color: 'var(--ink-500)' } }, 'сум')),
        statusEl);

    const styleBtn = (el, active) => {
        el.style.border = active ? '2px solid var(--primary-500)' : '1px solid var(--ink-200)';
        el.style.background = active ? 'var(--primary-50, #f2faf8)' : 'var(--white, #fff)';
        el.style.color = active ? 'var(--primary-700)' : 'var(--ink-700)';
    };
    const tendered = () => tenders.reduce((s2, t) => s2 + (Number(t.amount) || 0), 0);
    const refreshHint = () => {
        const sum = tendered();
        const left = Math.round((balance - sum) * 100) / 100;
        payAmountEl.textContent = fmtPrice(sum);

        // PAY_SUMMARY_V2 — исход одной фразой, без арифметики в уме у кассира.
        let ico, text, amount, fg, bg;
        if (left > 0) {
            ico = 'Warning';  fg = 'var(--warn-700, #b45309)'; bg = 'var(--warn-50, #fffbeb)';
            text = 'Останется долг';        amount = fmtPrice(left) + ' ' + tr('сум');
        } else if (left < 0) {
            ico = 'Warning';  fg = 'var(--crit-700, #b91c1c)'; bg = 'var(--crit-50, #fef2f2)';
            text = 'Сдача пациенту';        amount = fmtPrice(-left) + ' ' + tr('сум');
        } else {
            ico = 'Check';    fg = 'var(--ok-700, #047857)';   bg = 'var(--ok-50, #ecfdf5)';
            text = 'Счёт закрывается полностью'; amount = '';
        }
        statusEl.style.background = bg;
        statusEl.style.color = fg;
        clear(statusIcoEl);
        statusIcoEl.appendChild(Icon(ico, { size: 15 }));
        statusTxtEl.textContent = text;
        statusAmtEl.textContent = amount;
    };

    const render = () => {
        clear(bodyEl);
        tenders.forEach((t, i) => {
            const row = h('div', { style: { border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '10px', marginBottom: '8px' } });
            const btnRow = h('div', { style: { display: 'flex', gap: '6px' } },
                ...[['cash', 'Наличные'], ['card', 'Карта'], ['acquiring', 'Эквайринг']].map(([v, l]) => {
                    const b = h('button', {
                        type: 'button',
                        style: { flex: '1', cursor: 'pointer', fontFamily: 'inherit', fontWeight: '700', fontSize: '12.5px', padding: '9px 4px', borderRadius: '9px' },
                        onclick: () => { t.method = v; if (v === 'acquiring' && !t.providerId && providers.length === 1) t.providerId = String(providers[0].id); render(); },
                    }, l);
                    styleBtn(b, t.method === v);
                    return b;
                }));
            row.appendChild(btnRow);

            // MONEY_INPUT_V1 — текстовое поле с живым разделением тысяч
            // («40 000»); в t.amount хранится чистое число.
            const amtInp = h('input', {
                type: 'text', inputmode: 'numeric', autocomplete: 'off',
                value: t.amount ? fmtPrice(t.amount) : '',
                placeholder: 'Сумма',
                style: { flex: '1', padding: '9px 11px', border: '1px solid var(--ink-200)', borderRadius: '9px', fontFamily: 'inherit', fontSize: '13.5px', textAlign: 'right' },
            });
            amtInp.addEventListener('input', () => {
                const digits = amtInp.value.replace(/\D+/g, '');
                const num = digits ? Number(digits) : 0;
                const caretFromEnd = amtInp.value.length - (amtInp.selectionStart ?? amtInp.value.length);
                amtInp.value = digits ? fmtPrice(num) : '';
                const pos = Math.max(0, amtInp.value.length - caretFromEnd);
                try { amtInp.setSelectionRange(pos, pos); } catch (e) {}
                t.amount = num;
                refreshHint();
            });
            const rmBtn = tenders.length > 1
                ? h('button', { type: 'button', title: 'Убрать', style: { flex: '0 0 34px', cursor: 'pointer', border: '1px solid var(--ink-200)', borderRadius: '9px', background: 'var(--white, #fff)', color: 'var(--crit-600, #dc2626)', fontWeight: 700 },
                    onclick: () => { tenders.splice(i, 1); render(); } }, '×')
                : null;
            row.appendChild(h('div', { style: { display: 'flex', gap: '6px', marginTop: '7px' } }, amtInp, rmBtn));

            if (t.method === 'acquiring') {
                const provSel = h('select', { style: { width: '100%', marginTop: '7px', padding: '8px 10px', border: '1px solid var(--ink-200)', borderRadius: '9px', fontFamily: 'inherit', fontSize: '12.5px' },
                    onchange: (e) => { t.providerId = e.target.value; } },
                    ...(providers.length
                        ? [h('option', { value: '' }, 'Выберите провайдера…')].concat(
                           providers.map(pr => h('option', { value: String(pr.id), selected: String(t.providerId) === String(pr.id) }, pr.name + ' · ' + Number(pr.fee_percent || 0).toFixed(2) + '%')))
                        : [h('option', { value: '' }, 'Нет провайдеров — Настройки → Провайдеры онлайн-платежей')]));
                row.appendChild(provSel);
            }
            bodyEl.appendChild(row);
        });
        if (tenders.length < 3) {
            bodyEl.appendChild(h('button', {
                type: 'button', class: 'btn btn-outline btn-sm', style: { width: '100%', justifyContent: 'center' },
                onclick: () => {
                    const left = Math.max(0, Math.round((balance - tendered()) * 100) / 100);
                    tenders.push({ method: 'card', amount: left, providerId: providers.length === 1 ? String(providers[0].id) : '' });
                    render();
                },
            }, '+ Разделить оплату (второй способ)'));
        }
        bodyEl.appendChild(hintEl);
        refreshHint();
    };

    supabase.from('payment_providers').select('id, name, fee_percent').eq('active', 1).order('name').then(({ data }) => {
        providers = data || [];
        render();
    });
    render();

    modal(trf('Оплата · {no}', { no: inv.invoice_number || ('#' + inv.id) }), 'Receipt',
        [
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px' } },
                trf('{name} — к оплате', { name: inv.patient_name }), ' ', h('strong', null, fmtPrice(balance)), ' сум'),
            linesEl,   // PAY_DETAILS_V1 — состав счёта перед выбором способа оплаты
            bodyEl,
        ],
        'Принять оплату',
        async () => {
            const parts = [];
            for (const t of tenders) {
                const a = Number(t.amount) || 0;
                if (a <= 0) continue;
                let notes = '';
                if (t.method === 'acquiring') {
                    const pr = providers.find(x => String(x.id) === String(t.providerId));
                    if (!pr) { toast('Выберите провайдера эквайринга для строки «Эквайринг».', 'fail'); return false; }
                    // i18n-exempt: примечание платежа пишется В БАЗУ — хранимая запись, а не текст экрана
                    notes = 'Эквайринг: ' + pr.name;
                }
                parts.push({ method: t.method, amount: a, notes });
            }
            if (!parts.length) { toast('Укажите сумму.', 'fail'); return false; }
            const sum = parts.reduce((s2, x) => s2 + x.amount, 0);
            if (sum > balance + 0.001) { toast(trf('Сумма частей больше остатка ({sum} сум).', { sum: fmtPrice(balance) }), 'fail'); return false; }

            const { error } = parts.length === 1
                ? await supabase.rpc('record_payment', { invoice_id: inv.id, amount: parts[0].amount, method: parts[0].method, notes: parts[0].notes })
                : await supabase.rpc('record_payment_split', { invoice_id: inv.id, tenders: parts });
            if (error) { toast((error.message) || 'Не удалось принять оплату.', 'fail'); return false; }
            toast('Оплата принята', 'ok');
            const main = parts.slice().sort((a, b) => b.amount - a.amount)[0];
            printFiscalCheck(inv, sum, main.method);   // CASH_CHECK_PRINT_V1 — чек + номера очереди (не блокирует)
            await paint(root);
            return true;
        },
        460,
        // DEBT_BTN_V1 — «Оставить как долг» рядом с «Отмена»: записать введённую
        // часть (если есть), перевести счёт в долг, услуги отдать в работу —
        // врач/лаборатория/процедуры видят их, не дожидаясь полной оплаты.
        (close) => h('button', {
            class: 'btn', type: 'button',
            style: { color: 'var(--crit-600, #dc2626)', borderColor: 'var(--crit-300, #fca5a5)', fontWeight: 700 },
            onclick: async (e) => {
                const btn = e.currentTarget;
                const parts = [];
                for (const t of tenders) {
                    const a = Number(t.amount) || 0;
                    if (a <= 0) continue;
                    let notes = '';
                    if (t.method === 'acquiring') {
                        const pr = providers.find(x => String(x.id) === String(t.providerId));
                        if (!pr) { toast('Выберите провайдера эквайринга для строки «Эквайринг».', 'fail'); return; }
                        // i18n-exempt: примечание платежа пишется В БАЗУ — хранимая запись, а не текст экрана
                        notes = 'Эквайринг: ' + pr.name;
                    }
                    parts.push({ method: t.method, amount: a, notes });
                }
                const sum = parts.reduce((s2, x) => s2 + x.amount, 0);
                if (sum >= balance - 0.001) { toast('Введённая сумма покрывает счёт — нажмите «Принять оплату».', 'info'); return; }
                btn.disabled = true;
                try {
                    if (parts.length) {
                        const { error } = parts.length === 1
                            ? await supabase.rpc('record_payment', { invoice_id: inv.id, amount: parts[0].amount, method: parts[0].method, notes: parts[0].notes })
                            : await supabase.rpc('record_payment_split', { invoice_id: inv.id, tenders: parts });
                        if (error) throw new Error(error.message || 'Оплата не записана');
                    }
                    const { error: dErr } = await supabase.rpc('mark_invoice_debt', { invoice_id: inv.id });
                    if (dErr) throw new Error(dErr.message || 'Не удалось оформить долг');
                    toast(parts.length ? tr('Счёт оставлен как долг (частичная оплата записана) — услуги переданы в работу.') : tr('Счёт оставлен как долг — услуги переданы в работу.'), 'ok');
                    if (sum > 0) printFiscalCheck(inv, sum, parts[0].method);
                    close();
                    await paint(root);
                } catch (err) {
                    toast((err && err.message) || 'Не удалось оформить долг.', 'fail');
                    btn.disabled = false;
                }
            },
        }, 'Оставить как долг'));
}

function voidModal(root, inv) {
    modal(trf('Отменить счёт · {no}', { no: inv.invoice_number || ('#' + inv.id) }), 'X',
        [h('div', { style: { fontSize: '13.5px', lineHeight: 1.55 } },
            'Счёт пациента ', h('strong', null, inv.patient_name || '—'), ' на ',
            h('strong', null, fmtPrice(inv.total_amount)), ' сум будет отменён. ',
            h('span', { class: 'muted' }, 'Неначатые услуги счёта снова станут доступны для выставления.'))],
        'Отменить счёт',
        async () => {
            const { error } = await supabase.rpc('void_invoice', { invoice_id: inv.id });
            if (error) { toast((error.message) || 'Не удалось отменить счёт.', 'fail'); return false; }
            toast('Счёт отменён', 'ok');
            await paint(root);
            return true;
        });
}

// CASHIER_REFUND_V1 — an invoice's payment list, each with a «Возврат» action.
async function openInvoiceRefund(inv, root) {
    let pays = [];
    try {
        const { data } = await supabase.from('payments')
            .select('id, invoice_id, amount, method, paid_at, notes')
            .eq('invoice_id', inv.id).order('id', { ascending: false }).limit(100);
        pays = data || [];
    } catch (e) { /* empty list explains below */ }
    const info = { id: inv.id, invoice_number: inv.invoice_number || ('#' + inv.id), patient_name: inv.patient_name || '' };

    const rows = pays.map(p => h('div', { class: 'row', style: { padding: '8px 0', borderBottom: '1px solid var(--ink-50)', gap: '10px', fontSize: '12.5px', alignItems: 'center' } },
        h('span', { class: 'muted num', style: { flex: '0 0 110px' } }, fmtRuShort(p.paid_at)),
        h('span', { style: { flex: 1 } },
            h('strong', null, p.amount < 0 ? 'Возврат' : 'Оплата'),
            h('span', { class: 'muted' }, ' · ' + (METHOD_RU[p.method] || p.method))),
        h('span', { class: 'num', style: { fontWeight: 700, color: p.amount < 0 ? 'var(--crit-600)' : 'var(--ok-700)' } },
            (p.amount < 0 ? '−' : '+') + fmtPrice(Math.abs(p.amount))),
        p.amount > 0 ? h('button', {
            class: 'btn btn-outline btn-sm', type: 'button',
            style: { color: 'var(--crit-600, #dc2626)', borderColor: 'var(--crit-200, #fecaca)' },
            onclick: () => openRefundConfirm(p, info, root),
        }, 'Возврат') : h('span', { style: { width: '72px' } }),
    ));

    modal(trf('Платежи · {label}', { label: info.invoice_number + (info.patient_name ? ' · ' + info.patient_name : '') }), 'Receipt',
        [rows.length
            ? h('div', { style: { maxHeight: '50vh', overflow: 'auto' } }, ...rows)
            : h('div', { class: 'empty' }, 'По счёту нет платежей.')],
        'Закрыть', async () => true, 560);
}

// CASHIER_REFUND_V1 — confirm dialog; the server caps the amount by what is
// actually still refundable on this payment and rolls the invoice back.
function openRefundConfirm(p, info, root) {
    const amtInp = moneyfy(h('input', { type: 'number', min: '1', max: String(p.amount), step: '1', value: String(p.amount) }));
    const reasonInp = h('input', { type: 'text', placeholder: 'Причина (необязательно)' });
    modal(tr('Возврат оплаты') + (info && info.invoice_number ? ' · ' + info.invoice_number : ''), 'Repeat',
        [
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px', lineHeight: 1.5 } },
                trf('Платёж от {when} · {method}', { when: fmtRuLong(p.paid_at), method: tr(METHOD_RU[p.method] || p.method) })
                + (info && info.patient_name ? ' · ' + info.patient_name : '')
                + ' — ' + fmtPrice(p.amount) + ' ' + tr('сум')),
            field('Сумма возврата', amtInp, { required: true }),
            field('Причина', reasonInp),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                'Возврат уменьшит «Оплачено» по счёту; наличный возврат выдаётся из кассы текущей смены.'),
        ],
        'Оформить возврат',
        async () => {
            const v = moneyVal(amtInp);
            if (!Number.isFinite(v) || v <= 0) { toast('Укажите сумму возврата.', 'fail'); return false; }
            const { error } = await supabase.rpc('refund_payment', { payment_id: p.id, amount: v, reason: reasonInp.value || '' });
            if (error) { toast(error.message || 'Не удалось оформить возврат.', 'fail'); return false; }
            toast('Возврат оформлен', 'ok');
            document.querySelectorAll('.modal').forEach(m => m.remove());   // close the stacked dialogs
            await paint(root);
            return true;
        });
}

async function exportInvoicesXlsx() {
    const rows = filteredRows();
    if (!rows.length) { toast('Нет счетов для выгрузки.', 'fail'); return; }
    try {
        const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
        const columns = ['№ счёта', 'Пациент', 'МРН', 'Телефон', 'Услуга', 'Врач', 'Создан', 'Сумма', 'Оплачено', 'Долг', 'Оплата', 'Статус'];
        const aoa = [columns, ...rows.map(r => [
            r.invoice_number || '', r.patient_name || '', r.mrn || '', r.phone || '',
            (r.first_item || '') + (r.items_count > 1 ? ` +${r.items_count - 1}` : ''),
            r.doctor_name || '', (r.created_at || '').replace('T', ' ').slice(0, 16),
            r.total_amount, r.paid_amount, Math.max(r.total_amount - r.paid_amount, 0),
            r.methods ? r.methods.split(',').map(m => METHOD_RU[m] || m).join(', ') : '',
            r.status,
        ])];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = columns.map(c => ({ wch: c.length > 8 ? 20 : 13 }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Invoices');
        XLSX.writeFile(wb, `cashier_${ymdLocal(new Date())}.xlsx`);
        toast('Файл скачан', 'ok');
    } catch (e) {
        console.error('[cashier] xlsx:', e);
        toast('Не удалось сформировать файл.', 'fail');
    }
}

// =============================================================================
// HEAD CASHIER — nav id 'cashier-head'. Read-only overview of all shifts.
// =============================================================================
export async function renderCashierHead(container) {
    clear(container);
    const tbody = h('tbody');
    const unassignedWrap = h('div');   // off-drawer cash banner (populated async)
    const root = h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Head cashier'),
                h('p', { class: 'page-subtitle' }, 'All cash shifts across cashiers — floats, collections and reconciliation.'),
            ),
        ),
        unassignedWrap,
        h('div', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Coins', { size: 16 }), ' Cash shifts')),
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Cashier'), h('th', null, 'Opened'), h('th', null, 'Closed'),
                    h('th', { style: { textAlign: 'right' } }, 'Float'),
                    h('th', { style: { textAlign: 'right' } }, 'Expected'),
                    h('th', { style: { textAlign: 'right' } }, 'Counted'),
                    h('th', { style: { textAlign: 'right' } }, 'Over/Short'),
                    h('th', null, 'Status'),
                )),
                tbody,
            ),
        ),
    );
    container.appendChild(root);

    loadUnassignedCash(unassignedWrap);

    tbody.appendChild(h('tr', null, h('td', { colspan: '8', style: { textAlign: 'center', padding: '20px', color: 'var(--ink-500)' } }, 'Loading…')));
    let rows = [];
    try {
        const { data, error } = await supabase.from('cash_shifts')
            .select('*, users(full_name)').order('id', { ascending: false }).limit(300);
        if (error) throw error;
        rows = data || [];
    } catch (e) {
        clear(tbody);
        tbody.appendChild(h('tr', null, h('td', { colspan: '8', style: { textAlign: 'center', padding: '18px', color: 'var(--crit-600)' } }, 'Failed to load: ' + ((e && e.message) || e))));
        return;
    }
    clear(tbody);
    if (!rows.length) { tbody.appendChild(h('tr', null, h('td', { colspan: '8', style: { textAlign: 'center', padding: '20px', color: 'var(--ink-500)' } }, 'No shifts yet.'))); return; }
    for (const s of rows) {
        const os = s.over_short;
        const osCell = s.status === 'closed'
            ? (os === 0 ? h('span', { class: 'muted' }, '0') : h('span', { style: { color: os > 0 ? 'var(--primary-700)' : 'var(--crit-600)', fontWeight: 600 } }, (os > 0 ? '+' : '') + fmtPrice(os)))
            : h('span', { class: 'muted' }, '—');
        tbody.appendChild(h('tr', null,
            h('td', null, (s.users && s.users.full_name) || ('#' + s.cashier_id)),
            h('td', null, fmtDateTime(s.opened_at)),
            h('td', null, s.closed_at ? fmtDateTime(s.closed_at) : '—'),
            h('td', { style: { textAlign: 'right' } }, fmtPrice(s.opening_float)),
            h('td', { style: { textAlign: 'right' } }, s.expected_amount != null ? fmtPrice(s.expected_amount) : '—'),
            h('td', { style: { textAlign: 'right' } }, s.counted_amount != null ? fmtPrice(s.counted_amount) : '—'),
            h('td', { style: { textAlign: 'right' } }, osCell),
            h('td', null, Tag(s.status === 'open' ? 'Open' : 'Closed', { kind: s.status === 'open' ? 'ok' : '', dot: true })),
        ));
    }
}

// Off-drawer cash — cash payments taken with NO open shift (shift_id NULL) don't
// belong to any drawer, so they escape a shift's over/short reconciliation. This
// surfaces them so a head cashier can chase them down (see the adversarial review
// note in server/services/rpc/cashier.js). Bounded read — enough for a local clinic.
async function loadUnassignedCash(wrap) {
    clear(wrap);
    try {
        const { data, error } = await supabase.from('payments')
            .select('amount').is('shift_id', null).eq('method', 'cash').limit(2000);
        if (error || !data || !data.length) return;
        const total = data.reduce((s, p) => s + (Number(p.amount) || 0), 0);
        if (total <= 0) return;
        const more = data.length >= 2000 ? '+' : '';
        wrap.appendChild(h('div', { class: 'card', style: { marginBottom: '14px', padding: '11px 14px', display: 'flex', gap: '10px', alignItems: 'flex-start', borderLeft: '3px solid var(--warn-500, #d99a00)' } },
            h('span', { style: { color: 'var(--warn-600, #b98200)', flex: '0 0 16px', marginTop: '1px' } }, Icon('Warning', { size: 15 })),
            h('div', { style: { fontSize: '12.5px', lineHeight: '1.5' } },
                h('strong', null, 'Off-drawer cash: ', fmtPrice(total), more, ' сум'),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    data.length + more + ' cash payment(s) were taken without an open shift, so they are not tied to any drawer. Ask cashiers to open a shift before taking cash.'),
            ),
        ));
    } catch (_) { /* non-critical surface — ignore */ }
}

// =============================================================================
// Shared minimal modal (mirrors settings-hub.js chrome).
// onSubmit returns true to close, false to keep open.
// =============================================================================
function modal(title, icon, bodyEls, submitLabel, onSubmit, width = 460, extraFooter = null) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const submitBtn = h('button', { class: 'btn btn-primary', type: 'button' }, submitLabel);
    submitBtn.addEventListener('click', async () => {
        submitBtn.disabled = true;
        const prev = submitBtn.textContent;
        submitBtn.textContent = 'Working…';
        let ok = false;
        try { ok = await onSubmit(); } catch (e) { toast((e && e.message) || 'Failed.', 'fail'); }
        if (ok) { close(); return; }
        submitBtn.disabled = false;
        submitBtn.textContent = prev;
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: width + 'px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon(icon, { size: 16 }), ' ', title),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' }, ...bodyEls),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            typeof extraFooter === 'function' ? extraFooter(close) : extraFooter,   // DEBT_BTN_V1 — доп. кнопка рядом с «Отмена»
            h('span', { class: 'grow' }),
            submitBtn),
    ));
    document.body.appendChild(overlay);
}

// DEPOSIT_ACCEPT_MODAL_V1 — окно приёма депозита.
//
// Повторяет окно оплаты счёта намеренно: для кассира это одно и то же действие —
// взять деньги и отметить, чем заплатили. Те же сегментные кнопки способа, тот
// же порядок «что → сколько → способ → подтвердить», тот же modal().
//
// Способ обязателен и НЕ имеет значения по умолчанию на сервере: «Принять»
// одним щелчком раньше записывало наличные, и депозит, внесённый картой,
// завышал ожидаемый остаток в ящике до самого закрытия смены.
function openAcceptDepositModal(d, root) {
    let method = 'cash';   // предвыбор, но отправляется только явно нажатое
    const money = (n) => h('span', { class: 'num', style: { whiteSpace: 'nowrap' } }, fmtPrice(n), ' сум');

    const styleBtn = (el, active) => {
        el.style.border = active ? '2px solid var(--primary-500)' : '1px solid var(--ink-200)';
        el.style.background = active ? 'var(--primary-50, #f2faf8)' : 'var(--white, #fff)';
        el.style.color = active ? 'var(--primary-700)' : 'var(--ink-700)';
    };

    const btnRow = h('div', { style: { display: 'flex', gap: '6px' } });
    const buttons = DEP_METHODS.map(([v, l]) => {
        const b = h('button', {
            type: 'button',
            style: { flex: '1', cursor: 'pointer', fontFamily: 'inherit', fontWeight: '700', fontSize: '12.5px', padding: '9px 4px', borderRadius: '9px' },
            onclick: () => { method = v; buttons.forEach(([bb, vv]) => styleBtn(bb, vv === method)); },
        }, l);
        btnRow.appendChild(b);
        return [b, v];
    });
    buttons.forEach(([b, v]) => styleBtn(b, v === method));

    const head = h('div', { style: { border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '11px 13px' } },
        h('div', { style: { fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.05em', color: 'var(--ink-500)', textTransform: 'uppercase', marginBottom: '6px' } },
            'Депозит'),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'baseline', fontSize: '13.5px' } },
            h('span', { style: { flex: 1 } }, d.patient_name || '—'),
            h('span', { class: 'muted' }, d.patient_mrn || '')),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'baseline', marginTop: '6px', fontWeight: 800, fontSize: '15px' } },
            h('span', { style: { flex: 1 } }, 'К приёму'), money(d.amount)),
        d.notes ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } }, d.notes) : null);

    // Наличные меняют ящик смены, безнал — нет. Кассир должен знать это ДО
    // подтверждения: именно из-за молчаливой записи наличных ящик и расходился.
    const hint = h('div', { class: 'muted', style: { fontSize: '12.5px' } },
        'Наличные попадут в ящик смены, карта и эквайринг — нет.');

    modal(trf('Приём депозита · {no}', { no: d.deposit_number || ('#' + d.id) }), 'Wallet',
        [head, h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-700)' } }, 'Чем платит пациент'), btnRow, hint],
        'Принять оплату',
        async () => {
            const { error } = await supabase.rpc('accept_deposit', { deposit_id: d.id, method });
            if (error) { toast(trf('Не удалось принять: {msg}', { msg: error.message || error }), 'fail'); return false; }
            toast(trf('Депозит принят · {method}', { method: tr(METHOD_RU[method] || method) }), 'ok');
            paint(root);   // ящик и итоги смены изменились — перерисовываем экран целиком
            return true;
        }, 430);
}

// Тестовые точки входа: экран целиком без DOM не поднимается, а окно приёма
// депозита проверить надо — способ, который оно отправляет, определяет, попадут
// деньги в ящик смены или нет.
export const __test_openAcceptDepositModal = openAcceptDepositModal;
export const __test_DEP_METHODS = DEP_METHODS;
