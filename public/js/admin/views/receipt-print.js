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

const METHOD_RU = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод', acquiring: 'Эквайринг' };
const GENDER_RU = { male: 'Мужской', female: 'Женский', other: '—' };

function dobAge(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    // Возраст СЧИТАЕТСЯ при печати, а не хранится: иначе перепечатанный через
    // год чек называл бы неверный возраст.
    const age = Math.floor((Date.now() - d.getTime()) / 31557600000);
    const date = d.toLocaleDateString('ru-RU');
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
        .select('id, description, quantity, unit_price, total').eq('invoice_id', inv.id);
    if (!items || !items.length) return { ok: false, reason: 'В счёте нет позиций.' };

    const { data: pat } = await supabase.from('patients')
        .select('full_name, mrn, date_of_birth, gender').eq('id', inv.patient_id).single();
    const { data: pays } = await supabase.from('payments').select('method').eq('invoice_id', inv.id);
    const method = (pays && pays.length) ? pays[0].method : 'cash';

    const queue = await loadInvoiceQueue(supabase, inv.id, items.map((i) => i.id));

    // RECEIPT_DOB_PERFORMER_V1 — кто оказал услугу. Тем же запросом, что и
    // очередь: обе подписи живут на visit_services, и второй поход в базу за
    // тем же набором строк был бы лишним.
    const { data: vsRows } = await supabase.from('visit_services')
        .select('id, invoice_item_id, doctor_id(full_name, specialty, role)')
        .in('invoice_item_id', items.map((i) => i.id));
    const byItem = performersByItem(vsRows);

    printableSheet({ type: 'fiscal', idLine: inv.invoice_number || String(inv.id), data: {
        docNo: inv.invoice_number || String(inv.id),
        date: new Date().toLocaleString('ru-RU').slice(0, 17),
        patientName: (pat && pat.full_name) || '—',
        mrn: (pat && pat.mrn) || '',
        dob: dobAge(pat && pat.date_of_birth),
        sex: GENDER_RU[String((pat && pat.gender) || '').toLowerCase()] || '',
        cashier: cashierName,
        items: items.map((it) => ({
            name: it.description || 'Услуга', qty: it.quantity, price: it.unit_price,
            ...(byItem[it.id] || {}),   // performer / performerRole, когда исполнитель назначен
        })),
        subtotal: inv.subtotal, discount: inv.discount_amount,
        total: inv.total_amount, paid: inv.paid_amount,
        method: METHOD_RU[method] || method, payMethod: METHOD_RU[method] || method,
        queue,
    } });
    return { ok: true };
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
        if (!ids.length) return { queue: [], byItem: {} };
        const { data: vsRows } = await supabase.from('visit_services')
            .select('id, invoice_item_id, queue_key, queue_no, services(name), doctor_id(full_name, specialty, role)')
            .in('invoice_item_id', ids);
        const byItem = performersByItem(vsRows);
        const vsIds = (vsRows || []).map((r) => r.id);
        if (!vsIds.length) return { queue: [], byItem };
        const { data: tickets, error } = await supabase.rpc('issue_queue_numbers', { p_ids: vsIds });
        if (error) { console.warn('[receipt] queue:', error.message || error); return { queue: [], byItem }; }
        return { queue: ticketsFor(vsRows, tickets), byItem };
    } catch (e) {
        console.warn('[receipt] lines:', e && e.message);
        return { queue: [], byItem: {} };
    }
}
