// DOCTOR_REFERRAL_DESK_V1 (2026-11-02) — «НАПРАВЛЕНИЯ ВРАЧА» В ОКНАХ РЕГИСТРАЦИИ.
//
// Одно чтение и одни подписи на оба окна — быструю регистрацию и мастер визита (две копии
// одного чтения уже расходились у строк «из заявки», crm-lines.js). Без DOM.
//
// Сервер (rpc/referral-orders.js patient_referral_orders) отдаёт открытые строки, на
// которые направил врач (сегодня и вперёд, своё здание), и открытые рекомендации; здесь —
// какой это вид строки для стойки и как его назвать (шаблон + параметры: перевод — у
// вызывающего, trf).
import { supabase } from '../supabase.js';

const EMPTY = () => ({ lines: [], recommendations: [], today: null });

/** Направления врача пациента. Бросает при отказе сервера (пустой ответ ≠ «не загрузилось»). */
export async function loadDoctorOrders(patientId) {
    const id = Number(patientId);
    if (!Number.isInteger(id) || id <= 0) return EMPTY();
    const { data, error } = await supabase.rpc('patient_referral_orders', { patient_id: id });
    if (error) throw new Error(error.message || String(error));
    if (!data) return EMPTY();
    return {
        lines: Array.isArray(data.lines) ? data.lines : [],
        recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
        today: data.today || null,
    };
}

/**
 * Вид строки для стойки: 'ready' — сегодня и без счёта (окно оформляет её само, второй строки
 * нет); 'future' — без счёта, другой день; 'billed' — в счёте, ждёт кассу; 'paid' — оплачено.
 */
export function orderKind(line, todayIso) {
    if (!line) return null;
    const st = line.bill && line.bill.state;
    if (st === 'paid') return 'paid';
    if (st === 'invoiced') return 'billed';
    return line.day === todayIso ? 'ready' : 'future';
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY'. */
export function dmyOf(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** Состояние строки словами — { template, params } (переводит вызывающий через trf). */
export function orderStateText(line, todayIso) {
    const kind = orderKind(line, todayIso);
    const no = line && line.bill ? line.bill.invoice_number : null;
    if (kind === 'paid') return { template: 'оплачено, счёт № {no}', params: { no } };
    if (kind === 'billed') return { template: 'ждёт оплаты в кассе, счёт № {no}', params: { no } };
    if (kind === 'future') return { template: 'на {day}', params: { day: dmyOf(line.day) } };
    return { template: 'сегодня — к оформлению', params: {} };
}

/**
 * Кому бонус за строку — имена (сумм окно не знает); без получателей — null.
 * Ревью U10 LOW-7 — ifOther (bonus_if_other рекомендации): врач-рекомендатель получит бонус,
 * только если услугу выполнит другой врач (исполнитель ещё не выбран) — названо условием.
 * Ревью полировки L2 — ifSelf (bonus_if_self): направивший визита, которому платят, только если
 * рекомендатель выполнит услугу сам (вариант «б»: иначе строку получает рекомендатель). Бывает лишь
 * вместе с ifOther — у рекомендателя есть свой источник; подпись называет всех, кому могут заплатить.
 */
export function bonusText(names, ifOther = null, ifSelf = null) {
    const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n.trim());
    const doctor = typeof ifOther === 'string' && ifOther.trim() ? ifOther.trim() : null;
    const self = doctor && typeof ifSelf === 'string' && ifSelf.trim() ? ifSelf.trim() : null;
    if (self && list.length) {
        return { template: 'Бонус: {names}; {doctor} — если услугу выполняет другой врач; {self} — если выполняет сам {doctor}',
            params: { names: list.join(', '), doctor, self } };
    }
    if (self) return { template: 'Бонус: {doctor} — если услугу выполняет другой врач; {self} — если выполняет сам {doctor}', params: { doctor, self } };
    if (doctor && list.length) {
        return { template: 'Бонус: {names}; {doctor} — если услугу выполняет другой врач', params: { names: list.join(', '), doctor } };
    }
    if (doctor) return { template: 'Бонус: {doctor} — если услугу выполняет другой врач', params: { doctor } };
    return list.length ? { template: 'Бонус: {names}', params: { names: list.join(', ') } } : null;
}

/** Номера строк визита — направлений врача (строки «из записи» с ними второй раз не берутся). */
export function orderVsIds(orders) {
    return new Set(((orders && orders.lines) || []).map((l) => Number(l.visit_service_id)).filter(Number.isInteger));
}
