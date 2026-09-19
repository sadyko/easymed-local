// CRM_LINKS_V1 (2026-09-20) — ЗАКРЫТИЕ СТРОК ЗАЯВКИ КОЛЛ-ЦЕНТРА, ОДНО НА ВСЕХ.
//
// Колл-центр записывает пациента строкой в crm_request_services: услуга, день,
// иногда врач. Пациент пришёл и услугу оформили — строку надо закрыть. Не
// закрытая, она:
//   • остаётся «Записан» с прошедшей датой, и ночная автоматика уносит
//     ПРИШЕДШЕГО пациента в «Не пришёл»;
//   • снова подставляется в смету при следующем открытии окна — регистратура
//     видит услугу, за которую уже взяли деньги.
//
// Правило закрытия одно и то же во всех окнах, поэтому и живёт оно здесь, а не
// в каждом по копии: строки → 'done', а РОДИТЕЛЬСКАЯ заявка переходит в «Пришёл»
// ТОЛЬКО когда в ней не осталось ни одной незакрытой строки. Заявка на три дня
// обязана пережить первый визит — иначе остальные два дня исчезнут у
// регистратуры.
//
// Модуль не знает про экраны (нет DOM, нет тостов) — только про базу: его зовут
// и мастер записи, и окно быстрой регистрации, и он не должен тащить за собой
// половину продукта.
import { supabase } from '../supabase.js';

// Ступени, на которых заявка ещё ЖИВАЯ, и ступень «пациент дошёл». Сид миграции
// 077; настраиваемая воронка подменяет их (см. crm-stages.js).
const OPEN_STAGES = ['scheduled', 'approved', 'in_process', 'recall'];
const WON_STAGE = 'came';

/**
 * Закрыть НАЗВАННЫЕ строки и, если в заявке больше нечего ждать, — саму заявку.
 * Лучшая попытка: услуги уже сохранены, и сбой здесь не должен выглядеть как
 * «не удалось записать».
 *
 * @returns {Promise<number>} сколько строк закрыто
 */
export async function closeCrmLines(lineIds, requestIds = []) {
    const ids = [...new Set((lineIds || []).filter((x) => x != null))];
    if (!ids.length) return 0;
    try {
        await supabase.from('crm_request_services').update({ status: 'done' }).in('id', ids);
        for (const rid of [...new Set((requestIds || []).filter((x) => x != null))]) {
            const { data: left } = await supabase.from('crm_request_services')
                .select('id').eq('request_id', rid).eq('status', 'pending').limit(1);
            if (!left || !left.length) {
                await supabase.from('crm_requests').update({ status: WON_STAGE }).eq('id', rid);
            }
        }
        return ids.length;
    } catch (e) {
        console.warn('[crm-lines] строки заявки не закрыты:', e && e.message);
        return 0;
    }
}

/**
 * Закрыть ВСЕ ожидающие строки этого пациента на этот день.
 *
 * Для окон, которые оформляют услуги, не проходя через подстановку из заявки
 * (быстрая регистрация: пришедшего без записи заводят и сразу выставляют счёт).
 * Пациент записывался на сегодня и пришёл — его заявка обязана закрыться так
 * же, как если бы услугу подставил мастер.
 */
export async function closeCrmLinesForPatient(patientId, dayIso) {
    const day = String(dayIso || '').slice(0, 10);
    if (!patientId || !day) return 0;
    try {
        const { data: reqs, error } = await supabase.from('crm_requests')
            .select('id').eq('patient_id', patientId).in('status', OPEN_STAGES);
        if (error || !reqs || !reqs.length) return 0;
        const reqIds = reqs.map((r) => r.id);
        const { data: lines, error: lineErr } = await supabase.from('crm_request_services')
            .select('id, request_id').in('request_id', reqIds)
            .eq('scheduled_date', day).eq('status', 'pending');
        if (lineErr || !lines || !lines.length) return 0;
        return await closeCrmLines(lines.map((l) => l.id), lines.map((l) => l.request_id));
    } catch (e) {
        console.warn('[crm-lines] заявка пациента не закрыта:', e && e.message);
        return 0;
    }
}
