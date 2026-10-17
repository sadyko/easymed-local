// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (редакция 2, 2026-10-16) — «ЗАПИСИ ПАЦИЕНТА» В КАРТОЧКЕ ЗАЯВКИ CRM
// ═══════════════════════════════════════════════════════════════════════════
//
// «Показывать, а не копировать»: услуги записей пациента карточка больше не
// копирует себе строками (копии становились двойным счётом). Она показывает
// свои записи списком — каждый визит, который она держит строкой или привязкой
// (RPC crm_card_bookings, server/services/rpc/crm-card-bookings.js): день и
// время, врач, состояние записи (Записан / Подтверждён / Пришёл / Не пришёл /
// Отменён) и услуги. Цен нет. Править запись — в календаре: «Открыть в
// календаре» уводит туда на день записи (calendar-focus.js).
//
// Пустой список — блок скрыт. Отказ сервера — одна приглушённая строка: окно
// карточки работает дальше. Данные (имена услуг и врачей) — текстом, не tr().
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';

/** Состояние записи → подпись (ключ словаря) и тон метки. */
export const BOOKING_STATE = Object.freeze({
    scheduled: Object.freeze({ label: 'Записан', kind: 'info' }),
    confirmed: Object.freeze({ label: 'Подтверждён', kind: 'teal' }),
    arrived: Object.freeze({ label: 'Пришёл', kind: 'ok' }),
    no_show: Object.freeze({ label: 'Не пришёл', kind: 'crit' }),
    cancelled: Object.freeze({ label: 'Отменён', kind: '' }),
});

const txt = (s) => document.createTextNode(String(s == null ? '' : s));

// Имя обёртки начинается с «rpc»: страж client-rpc-coverage видит имя RPC.
async function rpcCardBookings(requestId) {
    const { data, error } = await supabase.rpc('crm_card_bookings', { request_id: requestId });
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return (data && Array.isArray(data.bookings)) ? data.bookings : [];
}

/** Услуги записи одной строкой: «Консультация терапевта, Анализ крови ×2». */
export function servicesLine(services) {
    return (Array.isArray(services) ? services : [])
        .map((s) => String((s && s.name) || '') + (Number(s && s.quantity) > 1 ? ' ×' + Number(s.quantity) : ''))
        .filter(Boolean).join(', ');
}

function row(b, { onOpenCalendar }) {
    const st = BOOKING_STATE[b.status] || BOOKING_STATE.scheduled;
    const services = servicesLine(b.services);
    return h('div', {
        'data-booking': String(b.visit_id), 'data-booking-status': String(b.status || ''),
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', padding: '8px 0', borderTop: '1px solid var(--ink-100, #eef0f2)' },
    },
        h('div', { style: { flex: '1 1 220px', minWidth: 0 } },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } },
                txt(fmtDateTime(b.start)), Tag(tr(st.label), { kind: st.kind })),
            (b.doctor && b.doctor.name) ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, txt(b.doctor.name)) : null,
            services ? h('div', { class: 'muted', style: { fontSize: '12.5px', overflowWrap: 'anywhere' } }, txt(services)) : null),
        onOpenCalendar ? h('button', {
            type: 'button', class: 'btn btn-ghost btn-sm', 'data-booking-open': String(b.visit_id),
            style: { fontSize: '12.5px', display: 'inline-flex', alignItems: 'center', gap: '4px' },
            onclick: () => onOpenCalendar(b),
        }, Icon('Calendar', { size: 13 }), tr('Открыть в календаре')) : null);
}

/**
 * Блок «Записи пациента» карточки `requestId`. onOpenCalendar(booking) — переход в
 * календарь (вызывающий закрывает окно и уводит экран). Возвращает узел сразу;
 * список дорисовывается, когда ответит сервер.
 */
export function cardBookingsBox(requestId, { onOpenCalendar = null } = {}) {
    const box = h('div', { 'data-card-bookings': String(requestId), style: { display: 'none', margin: '4px 0 12px' } });
    const paint = (bookings, err) => {
        clear(box);
        if (err) {
            box.style.display = '';
            box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, trf('Записи пациента не загрузились: {msg}', { msg: tr(err) })));
            return;
        }
        if (!bookings.length) { box.style.display = 'none'; return; }
        box.style.display = '';
        box.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-800)', marginBottom: '2px' } },
            Icon('Calendar', { size: 14 }), tr('Записи пациента')));
        for (const b of bookings) box.appendChild(row(b, { onOpenCalendar }));
    };
    rpcCardBookings(Number(requestId))
        .then((list) => paint(list, null))
        .catch((e) => paint([], (e && e.message) || String(e)));
    return box;
}
