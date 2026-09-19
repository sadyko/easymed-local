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
// ГДЕ ПРОХОДИТ ГРАНИЦА С СЕРВЕРОМ. Окна, которые заводят визит через
// ensure_visit (мастер визита, быстрая регистрация), НЕ закрывают строки сами:
// это делает сервер, в одной транзакции с визитом (rpc/visits.js →
// settleCrmForVisit). Здесь остаются ровно те два пути, которые до ensure_visit
// не доходят:
//   • привязка сметы к УЖЕ существующему визиту (окно услуг визита) — RPC там
//     нет вовсе, строки пишутся прямо в visit_services;
//   • запись из каталога услуг, которая идёт через calendar_book, а тот про
//     CRM не знает ничего.
// Без этого модуля обе оставляли бы заявку «Записан» с прошедшей датой.
//
// Модуль не знает про экраны (нет DOM, нет тостов) — только про базу: его зовут
// два мастера, и он не должен тащить за собой половину продукта.
import { supabase } from '../supabase.js';
// CRM_LINKS_V1 — ступени берутся ПО ВИДУ из настроенной воронки (миграция 077),
// а не по сидовым именам: клиника вправе переименовать «Пришёл» и завести свою
// колонку, и закрытие заявок обязано это пережить.
import { crmStageKeys } from './crm-stages.js';

/**
 * ЧТО ЖДЁТ ЭТОГО ПАЦИЕНТА В ЭТОТ ДЕНЬ — одно чтение на оба мастера.
 *
 * Два шага, потому что отбор идёт по РОДИТЕЛЮ (пациент, живая ступень) и по
 * РЕБЁНКУ (дата, 'pending'), а компилятор запроса фильтрует только базовую
 * таблицу. Копия этого чтения стояла и в мастере записи, и в каталоге услуг, и
 * копии уже разошлись: одна молча отдавала пустоту при отказе сервера, вторая
 * нет; у одной в выборке не было doctor_id, из-за чего услуга с requires_doctor
 * не доходила до сметы. Два ответа на один вопрос — это две разные кнопки.
 *
 * БРОСАЕТ при отказе сервера, а не отдаёт пустой список: пустая смета
 * неотличима от «записей нет», и именно это стоило трёх кругов отладки (сервер
 * не перезапущен после добавления таблицы в реестр — таблица есть, процесс о
 * ней не знает). Что именно отказало, называет `.where`: 'requests' | 'lines'.
 *
 * @returns {Promise<Array<{id, request_id, service_id, scheduled_date, status, doctor_id}>>}
 */
export async function pendingCrmLines(patientId, dayIso) {
    const day = String(dayIso || '').slice(0, 10);
    // Без дня сверять дату строки не с чем — молчим, а не берём что попало.
    if (!patientId || !day) return [];
    const fail = (where, msg) => { const e = new Error(String(msg)); e.where = where; return e; };

    const { open } = await crmStageKeys();
    if (!open.length) return [];
    const { data: reqs, error: reqErr } = await supabase.from('crm_requests')
        .select('id').eq('patient_id', patientId).in('status', open);
    if (reqErr) throw fail('requests', reqErr.message || reqErr);
    if (!reqs || !reqs.length) return [];

    const { data: lines, error: lineErr } = await supabase.from('crm_request_services')
        .select('id, request_id, service_id, scheduled_date, status, doctor_id')
        .in('request_id', reqs.map((r) => r.id))
        .eq('scheduled_date', day)
        .eq('status', 'pending');
    if (lineErr) throw fail('lines', lineErr.message || lineErr);
    return lines || [];
}

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
        const parents = [...new Set((requestIds || []).filter((x) => x != null))];
        const { won } = parents.length ? await crmStageKeys() : { won: null };
        for (const rid of parents) {
            const { data: left } = await supabase.from('crm_request_services')
                .select('id').eq('request_id', rid).eq('status', 'pending').limit(1);
            if (!left || !left.length) {
                await supabase.from('crm_requests').update({ status: won }).eq('id', rid);
            }
        }
        return ids.length;
    } catch (e) {
        console.warn('[crm-lines] строки заявки не закрыты:', e && e.message);
        return 0;
    }
}

// ЗДЕСЬ БЫЛА closeCrmLinesForPatient(patientId, dayIso) — «закрыть все
// ожидающие строки этого пациента на этот день», для окна быстрой регистрации.
// Удалена, потому что не работала НИ РАЗУ: её звали ПОСЛЕ ensure_visit, а
// родителей она отбирала по ОТКРЫТЫМ ступеням — к тому моменту сервер уже
// переводил заявку в «Пришёл», открытых не находилось, и строки оставались
// «pending» навсегда. Теперь это делает сам ensure_visit (rpc/visits.js →
// settleCrmForVisit), в одной транзакции с визитом и без гонки с клиентом.
