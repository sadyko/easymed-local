// REFERRAL_BILL_V1 (2026-09-29) — АКТ ОКАЗАННЫХ УСЛУГ ПО СЧЁТУ ПЛАТЕЛЬЩИКА
// (AKT_DOC_V1): ОДНА СБОРКА НА МАСТЕР ВИЗИТА И НА КАССУ.
//
// Акт жил замыканием внутри visit-wizard.js (printAkt): шапка, блок
// плательщика («По полису ДМС» / «По договору», полис или «счёт №»), покрытие.
// Решение владельца 29.09 («Card's payer, can split»): касса выставляет строки
// «Ждут счёта» плательщику из карты пациента — и печатает тот же акт. Поэтому
// сборка вынесена сюда, а не скопирована: мастер и касса зовут actSheet().
// Строки акта и талоны приносит вызывающий: мастер знает их из сметы, касса —
// из счёта, который выставил сервер (цена и скидка строки — серверные).
//
// Без DOM: печатает printableSheet, данные — supabase; оба передаются
// вызывающим, как в receipt-print.js.
import { loadInvoiceLines } from './receipt-print.js?v=rp1';
import { dateNumeric } from '../../shared/date-words.js';

// Страховая платит по полису; организация и госпрограмма — по договору.
// Пустой kind — страховая (так его читает и мастер визита).
export function isDmsPayer(p) {
    return ['insurance', 'dms', ''].includes(String((p && p.kind) || '').toLowerCase());
}

/**
 * Бланк 'act' для printableSheet: { type, idLine, data }.
 * В бланке уже есть блок плательщика, покрытие и подписи сторон — свой бланк не
 * нужен, достаточно отдать данные в его форме. Итоги он считает по items сам.
 * @param {object} a
 * @param {object} a.invoice   счёт плательщика (invoice_number / id)
 * @param {object} [a.payer]   { name, kind }
 * @param {object} [a.patient] { full_name, mrn }
 * @param {string} [a.visitDay] 'YYYY-MM-DD' — местный день услуг
 * @param {string} [a.policyNo] номер полиса (только у страховой)
 * @param {Array}  [a.items]   [{ name, qty, price, disc?, _alt? }]
 * @param {Array}  [a.queue]   талоны очереди по услугам АКТА (ACT_SHEET_V1)
 */
/* i18n-exempt-start: печатный акт — печатный документ, намеренно русский */
export function actSheet({ invoice, payer = null, patient = {}, visitDay = '', policyNo = '', items = [], queue = [] } = {}) {
    const no = (invoice && (invoice.invoice_number || String(invoice.id))) || '—';
    const dms = payer ? isDmsPayer(payer) : false;
    const p = patient || {};
    return {
        type: 'act',
        idLine: 'АКТ ' + no,
        data: {
            title: 'Акт оказанных медицинских услуг',
            docNo: 'АКТ ' + no,
            // MONTH_WORDS_V1 — дата не зависит от языка ОС (тот же вид, что ru-RU).
            issueDate: 'Дата ' + dateNumeric(new Date()),
            coverage: dms ? 'По полису ДМС' : 'По договору',
            patient: [
                ['ФИО', p.full_name || '—'],
                ['Карта №', p.mrn || '—'],
                ['Дата услуг', String(visitDay || '').slice(0, 10).split('-').reverse().join('.')],
            ],
            payer: [
                ['Организация', payer ? payer.name : '—'],
                [dms ? 'Полис' : 'Договор', dms ? (String(policyNo || '').trim() || '—') : ('счёт ' + no)],
                ['Покрытие', '100% от суммы акта'],
            ],
            items: Array.isArray(items) ? items : [],
            queue: Array.isArray(queue) ? queue : [],
        },
    };
}

/**
 * Касса: акт по счёту плательщика, который только что выставил сервер.
 * Строки — позиции этого счёта (цена сервера; скидка строки — пакета, в
 * процентах, как её читает бланк), исполнитель и талоны очереди — тем же
 * запросом, что у чека и счёта (receipt-print.js loadInvoiceLines).
 */
export async function printInvoiceAct({ supabase, printableSheet, invoice, items, payer, patient, visitDay, policyNo }) {
    const list = Array.isArray(items) ? items : [];
    const lines = await loadInvoiceLines(supabase, invoice.id, list.map((it) => it.id));
    const actItems = list.map((it, i) => {
        const perf = lines.byItem && lines.byItem[it.id];
        const qty = Number(it.quantity) || 1;
        const price = Number(it.unit_price) || 0;
        const gross = qty * price;
        const off = Number(it.discount_amount) || 0;
        return {
            name: (it.description || 'Услуга') + (perf && perf.performer ? ' · ' + perf.performer : ''),
            qty, price,
            disc: gross > 0 && off > 0 ? Math.round(off / gross * 10000) / 100 : 0,
            _alt: i % 2 === 1,
        };
    });
    printableSheet(actSheet({ invoice, payer, patient, visitDay, policyNo, items: actItems, queue: lines.queue }));
}
/* i18n-exempt-end */
