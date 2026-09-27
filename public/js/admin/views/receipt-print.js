// REPRINT_SERVICE_CHECK_V1 — повторная печать кассового чека по счёту.
//
// Чек нужен не только кассе. Пациент теряет талон, приходит с ним в кабинет,
// просит копию — а перепечатать его можно было ТОЛЬКО из кассы, найдя там счёт.
// Отсюда чек печатается по одной строке услуги в карте пациента.
//
// Здесь же общий сбор талонов очереди: та же логика раньше жила внутри
// cashier-desk.js, поэтому «Печать счёта» кассы очередь вообще не запрашивала —
// номер печатался на чеке и пропадал на счёте.
//
// Модуль НЕ импортирует ui.js: печатью занимается printableSheet, данными —
// supabase, и обе зависимости передаются вызывающим. Так ticketsFor() можно
// проверить тестом без DOM.

// MONTH_WORDS_V1 (2026-09-05) — дата на бланке не зависит от компьютера.
//
// Здесь она собиралась через toLocaleDateString() БЕЗ локали, то есть по языку
// операционной системы: один и тот же счёт печатался «05.09.2026» в одной
// клинике и «05/09/2026» в другой, а на машине без данных для запрошенного
// языка Intl отдаёт корневую форму («1994 M11 15» на снимке владельца).
// dateNumeric — тот же вид, что раньше давал ru-RU, но одинаковый везде.
// Размеры и вёрстка бланка не тронуты: меняется только источник строки.
import { dateNumeric } from '../../shared/date-words.js';

// Ответ issue_queue_numbers -> строки талонов для шаблона.
//
// Не схлопываем услуги с одинаковым номером: все анализы одного чека делят одно
// место в лабораторной очереди, но на бумаге у каждой строки своё название, а
// группировкой по `key` занимается сам бланк (queueBlockHtml / queueBlockA4).
export function ticketsFor(vsRows, tickets) {
    if (!Array.isArray(tickets)) return [];
    const nameByVs = new Map((Array.isArray(vsRows) ? vsRows : [])
        .map((r) => [r.id, (r.services && r.services.name) || '']));
    return tickets.map((t) => ({
        service: nameByVs.get(t.visit_service_id) || 'Услуга',
        label: t.label || '',
        number: t.number,
        key: t.queue_key || '',
    }));
}

// Талоны очереди для счёта. Best-effort: печать чека не должна падать из-за
// очереди, поэтому любая ошибка здесь — это пустой список, а не исключение.
export async function loadInvoiceQueue(supabase, invoiceId, itemIds = null) {
    try {
        let ids = itemIds;
        if (!Array.isArray(ids)) {
            const { data: items } = await supabase.from('invoice_items').select('id').eq('invoice_id', invoiceId);
            ids = (items || []).map((i) => i.id);
        }
        if (!ids.length) return [];
        const { data: vsRows } = await supabase.from('visit_services')
            .select('id, invoice_item_id, queue_key, queue_no, services(name), doctor_id(full_name, specialty, role)')
            .in('invoice_item_id', ids);
        const vsIds = (vsRows || []).map((r) => r.id);
        if (!vsIds.length) return [];
        const { data: tickets, error } = await supabase.rpc('issue_queue_numbers', { p_ids: vsIds });
        if (error) { console.warn('[receipt] queue:', error.message || error); return []; }
        return ticketsFor(vsRows, tickets);
    } catch (e) {
        console.warn('[receipt] queue:', e && e.message);
        return [];
    }
}

// V3120_FIX — «С баланса» и «Подарочная карта» тоже: без них чек печатал код
// способа («wallet», «gift_card») рядом с суммой.
export const METHOD_RU = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод', acquiring: 'Эквайринг', wallet: 'С баланса', gift_card: 'Подарочная карта' };
const GENDER_RU = { male: 'Мужской', female: 'Женский', other: '—' };

// V3120_FIX — одна функция на все бланки (касса собирала свою и прогоняла
// «г.» через перевод интерфейса: на узбекском экране чек печатал узбекское
// слово посреди русского бланка). Дата «ГГГГ-ММ-ДД» читается как МЕСТНАЯ:
// new Date() взял бы полночь по UTC, и западнее Гринвича день рождения
// съезжал бы на вчера.
export function dobAge(iso) {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
    if (isNaN(d)) return '';
    // Возраст СЧИТАЕТСЯ при печати, а не хранится: иначе перепечатанный через
    // год чек называл бы неверный возраст.
    const t = new Date();
    let age = t.getFullYear() - d.getFullYear();
    if (t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) age--;
    const date = dateNumeric(d);
    return (age >= 0 && age < 130) ? `${date} · ${age} г.` : date;
}

// Перепечатать кассовый чек по ИДЕНТИФИКАТОРУ счёта: всё нужное подгружается
// само, вызывающему достаточно знать счёт. Возвращает false, если печатать
// нечего (счёт не найден или в нём нет позиций) — тогда бланк подменился бы
// образцом из doc-variants, и пациент унёс бы чужой чек.
export async function printInvoiceCheck({ supabase, printableSheet, invoiceId, cashierName = '' }) {
    const { data: inv, error } = await supabase.from('invoices')
        .select('id, invoice_number, subtotal, discount_amount, total_amount, paid_amount, patient_id, created_at')
        .eq('id', invoiceId).single();
    if (error || !inv) return { ok: false, reason: 'Счёт не найден.' };

    const { data: items } = await supabase.from('invoice_items')
        .select('id, description, quantity, unit_price, total, discount_amount').eq('invoice_id', inv.id);
    if (!items || !items.length) return { ok: false, reason: 'В счёте нет позиций.' };

    const { data: pat } = await supabase.from('patients')
        .select('full_name, mrn, date_of_birth, gender').eq('id', inv.patient_id).single();
    // V3120_FIX — ВСЕ платежи счёта, каждый своей строкой. Раньше брался способ
    // первого платежа и печатался рядом с суммой ВСЕГО счёта: раздельная оплата
    // «100 000 наличными + 50 000 картой» становилась «Наличные 378 001».
    const { data: pays } = await supabase.from('payments')
        .select('id, amount, method, paid_at').eq('invoice_id', inv.id).order('id', { ascending: true });
    const payList = Array.isArray(pays) ? pays : [];
    // Дата копии — дата ОПЛАТЫ (последнего платежа), а не момент перепечатки.
    const lastPaid = payList.filter((p) => Number(p.amount) > 0 && p.paid_at).map((p) => p.paid_at).sort().pop();

    const queue = await loadInvoiceQueue(supabase, inv.id, items.map((i) => i.id));

    // RECEIPT_DOB_PERFORMER_V1 — кто оказал услугу. Тем же запросом, что и
    // очередь: обе подписи живут на visit_services, и второй поход в базу за
    // тем же набором строк был бы лишним.
    const { data: vsRows } = await supabase.from('visit_services')
        .select('id, invoice_item_id, doctor_id(full_name, specialty, role), service_templates(name)')
        .in('invoice_item_id', items.map((i) => i.id));
    const byItem = performersByItem(vsRows);
    const pkgByItem = packagesByItem(vsRows);   // PACKAGES_V1

    printableSheet({ type: 'fiscal', idLine: inv.invoice_number || String(inv.id), data: {
        docNo: inv.invoice_number || String(inv.id),
        date: dateNumeric(new Date(), { withTime: true }),
        copy: true,
        paidAt: lastPaid ? dateNumeric(new Date(lastPaid), { withTime: true }) : '',
        patientName: (pat && pat.full_name) || '—',
        mrn: (pat && pat.mrn) || '',
        dob: dobAge(pat && pat.date_of_birth),
        sex: GENDER_RU[String((pat && pat.gender) || '').toLowerCase()] || '',
        cashier: cashierName,
        items: items.map((it) => ({
            name: packageItemName(it.description || 'Услуга', pkgByItem[it.id], it.discount_amount), qty: it.quantity, price: it.unit_price,
            ...(byItem[it.id] || {}),   // performer / performerRole, когда исполнитель назначен
        })),
        subtotal: inv.subtotal, discount: inv.discount_amount,
        total: inv.total_amount, paid: Number(inv.paid_amount) || 0,
        payments: paymentLines(payList),
        queue,
    } });
    return { ok: true };
}

// V3120_FIX — платежи счёта -> строки чека { label, amount }. Возврат (минус)
// подписан «Возврат · <способ>», нулевые строки не печатаются.
export function paymentLines(pays) {
    if (!Array.isArray(pays)) return [];
    return pays
        .filter((p) => p && Number(p.amount))
        .map((p) => {
            const amount = Number(p.amount);
            const name = METHOD_RU[p.method] || String(p.method || 'Оплата');
            return { label: amount < 0 ? 'Возврат · ' + name : name, amount };
        });
}

// ---------------------------------------------------------------------------
// V3120_FIX — A4-счёт из СЕРВЕРНЫХ строк. Одна сборка для кассы, окна визита и
// мастера записи.
// ---------------------------------------------------------------------------
// Раньше у каждого экрана была своя: окно визита печатало «Full name / MRN /
// Issued 26 Sept 2026 / Self-pay» (и дату по UTC), мастер многодневной записи —
// счёт №1 со строками ВСЕХ дней и суммой, посчитанной на экране. Здесь
// подписи русские, дата местная, плательщик назван по справочнику, суммы —
// ровно те, что записал сервер, статус — код базы (слово ставит бланк).
// withPerformer — «Услуга · Врач» в самой строке: так печатали окно визита и
// мастер записи (INVOICE_DOCTOR_V1); A4-бланк отдельной графы исполнителя не имеет.
export function invoiceSheetData({ inv, items, patient, payerName = '', methods = [], lines = null, title = '', extraPatient = [], extraBilling = [], withPerformer = false } = {}) {
    inv = inv || {};
    const p = patient || {};
    const lns = lines || {};
    const byItem = lns.byItem || {};
    const pkg = lns.packages || {};
    const created = inv.created_at ? new Date(inv.created_at) : new Date();
    const date = dateNumeric(isNaN(created) ? new Date() : created);
    const total = Number(inv.total_amount) || 0;
    const paid = Number(inv.paid_amount) || 0;
    const methodWords = [...new Set((methods || []).filter(Boolean))].map((m) => METHOD_RU[m] || m);
    const status = inv.status || (paid >= total && total > 0 ? 'paid' : (paid > 0 ? 'partial' : 'unpaid'));
    return {
        title: title || 'Счёт за медицинские услуги',
        docNo: inv.invoice_number || String(inv.id == null ? '' : inv.id),
        issueDate: date,
        status,
        patient: [
            ['ФИО', p.full_name || '—'],
            ['Карта №', p.mrn || '—'],
            ['Дата рождения', dobAge(p.date_of_birth) || '—'],
            ['Телефон', p.phone || '—'],
            ...(extraPatient || []),
        ],
        billing: [
            ['Дата', date],
            ['Плательщик', payerName || 'Пациент'],
            ...(methodWords.length ? [['Оплата', methodWords.join(', ')]] : []),
            ...(extraBilling || []),
        ],
        items: (items || []).map((it, i) => ({
            name: packageItemName(it.description || 'Услуга', pkg[it.id], it.discount_amount)
                + (withPerformer && byItem[it.id] && byItem[it.id].performer ? ' · ' + byItem[it.id].performer : ''),
            qty: it.quantity, price: it.unit_price, _alt: i % 2 === 1,
            ...(byItem[it.id] || {}),
        })),
        queue: lns.queue || [],
        subtotal: inv.subtotal != null ? Number(inv.subtotal) : undefined,
        total, paid,
    };
}

// Печать A4-счёта по id: всё подгружается само. Несуществующий счёт или счёт
// без строк НЕ печатается — бланк без позиций подменился бы образцом.
export async function printInvoiceSheetById({ supabase, printableSheet, invoiceId, title = '', extraPatient = [], extraBilling = [], withPerformer = false }) {
    const { data: inv, error } = await supabase.from('invoices')
        .select('id, invoice_number, subtotal, discount_amount, total_amount, paid_amount, status, patient_id, payer_id, created_at')
        .eq('id', invoiceId).single();
    if (error || !inv) return { ok: false, reason: 'Счёт не найден.' };
    const { data: items } = await supabase.from('invoice_items')
        .select('id, description, quantity, unit_price, total, discount_amount').eq('invoice_id', inv.id);
    if (!items || !items.length) return { ok: false, reason: 'В счёте нет позиций.' };
    let patient = null;
    if (inv.patient_id != null) {
        const { data } = await supabase.from('patients')
            .select('full_name, mrn, date_of_birth, phone').eq('id', inv.patient_id).maybeSingle();
        patient = data || null;
    }
    let payerName = '';
    if (inv.payer_id != null) {
        try {
            const { data } = await supabase.from('payers').select('id, name').eq('id', inv.payer_id).maybeSingle();
            payerName = (data && data.name) || '';
        } catch (e) { /* справочник недоступен — без имени плательщика */ }
    }
    let methods = [];
    try {
        const { data: pays } = await supabase.from('payments').select('method, amount').eq('invoice_id', inv.id);
        methods = (pays || []).filter((x) => Number(x.amount) > 0).map((x) => x.method);
    } catch (e) { /* способ оплаты — не повод не печатать счёт */ }
    const lines = await loadInvoiceLines(supabase, inv.id, items.map((i) => i.id));
    const data = invoiceSheetData({ inv, items, patient, payerName, methods, lines, title, extraPatient, extraBilling, withPerformer });
    printableSheet({ type: 'invoice', idLine: data.docNo, data });
    return { ok: true };
}

// ---------------------------------------------------------------------------
// V3120_FIX — квитанция: продажа подарочной карты / сертификата и депозит.
// ---------------------------------------------------------------------------
const CARD_KIND_RU = { gift_card: 'Подарочная карта', certificate: 'Сертификат' };
function ymdToRu(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
}
function fmtSum(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

// kind 'card'    — { card, buyer, method, cashier, invoiceNumber }
// kind 'deposit' — { deposit, patient, balance, debtCovered, cashier }
export function slipData(o = {}) {
    const now = dateNumeric(new Date(), { withTime: true });
    if (o.kind === 'card') {
        const c = o.card || {};
        const b = o.buyer || {};
        const kindWord = CARD_KIND_RU[c.kind] || 'Подарочная карта';
        const rest = c.remaining != null ? Number(c.remaining) : Number(c.amount);
        return {
            title: 'Квитанция',
            subtitle: 'Продажа · ' + kindWord,
            docNo: c.sale_number || o.invoiceNumber || '',
            date: now, cashier: o.cashier || '',
            rows: [
                ['Покупатель', b.full_name || ''],
                ['Карта пациента №', b.mrn || ''],
                [kindWord, c.name || ''],
                ['Номер карты', c.sale_number || ''],
                ['Действует по', c.valid_until ? ymdToRu(c.valid_until) : 'бессрочно'],
            ],
            amountLabel: 'Номинал',
            amount: Number(c.amount) || 0,
            method: METHOD_RU[o.method] || o.method || '',
            afterRows: [['Остаток на карте', fmtSum(rest)]],
            note: 'Карта на предъявителя: ею может платить любой пациент клиники.',
        };
    }
    const d = o.deposit || {};
    const p = o.patient || {};
    const pending = d.status === 'pending' || !d.method;
    return {
        title: 'Квитанция',
        subtitle: 'Депозит (предоплата)',
        docNo: d.deposit_number || '',
        date: now, cashier: o.cashier || '',
        rows: [
            ['Пациент', p.full_name || ''],
            ['Карта пациента №', p.mrn || ''],
            ['Номер депозита', d.deposit_number || ''],
        ],
        amountLabel: 'Сумма',
        amount: Number(d.amount) || 0,
        method: pending ? '' : (METHOD_RU[d.method] || d.method || ''),
        afterRows: [
            ...(Number(o.debtCovered) > 0 ? [['Закрыт долг по кэшбэку', fmtSum(o.debtCovered)]] : []),
            ...(o.balance != null && !pending ? [['Баланс пациента', fmtSum(o.balance)]] : []),
        ],
        note: pending ? 'Ждёт оплаты в кассе: баланс пополнится после приёма денег.' : '',
    };
}

// Печать квитанции. Best-effort: сбой печати не отменяет проведённую операцию.
export function printSlip(printableSheet, o) {
    try {
        const data = slipData(o);
        printableSheet({ type: 'slip', idLine: data.docNo, data });
        return true;
    } catch (e) {
        console.warn('[receipt] slip:', e && e.message);
        return false;
    }
}

// RECEIPT_DOB_PERFORMER_V1 — кто оказал услугу.
//
// На чеке печатается роль, а не специальность: специальность заполнена только у
// врачей, а ответить надо и за лабораторию, и за процедурный кабинет. Пациент
// с несколькими строками по этой подписи понимает, куда идти с какой.
export const ROLE_RU = {
    doctor: 'Врач', nurse: 'Медсестра', lab: 'Лаборант',
    registrar: 'Регистратура', admin: 'Администратор',
};

// visit_services -> { [invoice_item_id]: { performer, performerRole } }.
//
// Строка без назначенного исполнителя в карту НЕ попадает: процедуру берёт тот,
// кто свободен, и выдумывать имя на чеке нельзя. Неизвестная роль печатает
// только имя — это лучше, чем спрятать реального исполнителя.
export function performersByItem(vsRows) {
    const out = {};
    if (!Array.isArray(vsRows)) return out;
    for (const r of vsRows) {
        const u = r && r.doctor_id;
        const name = u && u.full_name ? String(u.full_name).trim() : '';
        if (!name || r.invoice_item_id == null) continue;
        out[r.invoice_item_id] = { performer: name, performerRole: ROLE_RU[u.role] || '' };
    }
    return out;
}

// PACKAGES_V1 — из какого пакета позиция: visit_services -> { [invoice_item_id]: имя пакета }.
// Нужен embed service_templates(name) в выборке строк визита.
export function packagesByItem(vsRows) {
    const out = {};
    if (!Array.isArray(vsRows)) return out;
    for (const r of vsRows) {
        const p = r && r.service_templates;
        const name = p && p.name ? String(p.name).trim() : '';
        if (name && r.invoice_item_id != null) out[r.invoice_item_id] = name;
    }
    return out;
}

// PACKAGES_V1 — подпись позиции на бланке: «УЗИ · пакет «Осень», скидка −20 000».
// Скидка строки — её собственная (invoice_items.discount_amount); строка без
// пакета и без своей скидки печатается как прежде.
export function packageItemName(name, packageName, discount) {
    const base = String(name || 'Услуга');
    const d = Math.round(Number(discount) || 0);
    const bits = [];
    if (packageName) bits.push('пакет «' + packageName + '»');
    if (d > 0) bits.push('скидка −' + String(d).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
    return bits.length ? base + ' · ' + bits.join(', ') : base;
}

// RECEIPT_DOB_PERFORMER_V1 — очередь И исполнители одним запросом.
//
// Обе подписи живут на одних и тех же visit_services, и раньше каждый экран
// ходил за ними отдельно — а кто-то не ходил вовсе, из-за чего исполнитель
// появился на чеке и не появился на счёте. Один вызов на оба ответа: забыть
// половину теперь нельзя.
export async function loadInvoiceLines(supabase, invoiceId, itemIds = null) {
    try {
        let ids = itemIds;
        if (!Array.isArray(ids)) {
            const { data: items } = await supabase.from('invoice_items').select('id').eq('invoice_id', invoiceId);
            ids = (items || []).map((i) => i.id);
        }
        if (!ids.length) return { queue: [], byItem: {}, packages: {} };
        const { data: vsRows } = await supabase.from('visit_services')
            .select('id, invoice_item_id, queue_key, queue_no, services(name), doctor_id(full_name, specialty, role), service_templates(name)')
            .in('invoice_item_id', ids);
        const byItem = performersByItem(vsRows);
        const packages = packagesByItem(vsRows);   // PACKAGES_V1
        const vsIds = (vsRows || []).map((r) => r.id);
        if (!vsIds.length) return { queue: [], byItem, packages };
        const { data: tickets, error } = await supabase.rpc('issue_queue_numbers', { p_ids: vsIds });
        if (error) { console.warn('[receipt] queue:', error.message || error); return { queue: [], byItem, packages }; }
        return { queue: ticketsFor(vsRows, tickets), byItem, packages };
    } catch (e) {
        console.warn('[receipt] lines:', e && e.message);
        return { queue: [], byItem: {}, packages: {} };
    }
}
