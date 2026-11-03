// DOCTOR_POOL_V1 — кого предлагать исполнителем услуги.
//
// Основное правило простое: врачи, которым эта услуга назначена в «Сотрудники →
// Услуги и ставки» (users.service_rates).
//
// А вот исключение важнее правила. Если услуга ТРЕБУЕТ врача
// (services.requires_doctor = 1), но исполнителей ей не отметили, пустой список
// превращает мастер визита в тупик: врача выбрать не из кого, без врача строка
// не уходит дальше первого шага, а убрать её из сметы нечем — строка без врача
// в СМЕТУ даже не попадает (visibleCart). Регистратура упирается в стену на
// ровном месте, и чаще всего — на самых ходовых процедурах вроде перевязки или
// внутривенной инъекции, которым исполнителя просто забыли проставить.
//
// Поэтому: нет отмеченных исполнителей у услуги, которая требует врача, —
// показываем всех врачей. Пусть регистратура выберет живого человека, чем
// упрётся в «нет врачей для этой услуги». Тот же приём уже применяется в
// service-picker-modal.js (DOCTOR_FALLBACK_V1) по той же причине.
//
// DIAG_ROUTE_V1 (D1, решение владельца 2026-11-03) — исполнитель нужен КАЖДОЙ
// услуге, кроме групп «Лаборатория» и «Процедуры» (needsPerformer,
// shared/service-route.js): строка кабинета без исполнителя не видна ни одному
// врачу. Фолбэк «все врачи» — по is_doctor, а не по роли (администратор-врач,
// главный врач). Отмеченный исполнитель предлагается при любой роли — медсестра
// или главный врач, которым услугу отметили, выбираются (performerCandidates).
// Услуге лаборатории и процедуре без отмеченных исполнителей пустой список —
// по-прежнему правильный ответ («врач не требуется»).
import { needsPerformer } from '../../shared/service-route.js';
import { isOn } from '../../shared/flags.js';

export { needsPerformer };

export function ratesOf(user) {
    // service_rates приходит из БД как JSON-колонка; у части сотрудников она
    // хранится строкой или битым JSON — падать из-за этого нельзя.
    const raw = user && user.service_rates;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch (_) { return []; }
    }
    return [];
}

export function assignedTo(doctors, serviceId) {
    return (doctors || []).filter(d => ratesOf(d).some(r => r && String(r.service_id) === String(serviceId)));
}

/** Врач для фолбэка: флаг is_doctor; список без этой колонки (старые вызовы) — как есть. */
export function isDoctorUser(u) {
    return !!u && (u.is_doctor === undefined || isOn(u.is_doctor));
}

/**
 * DIAG_ROUTE_V1 — кого грузить в список исполнителей: врачей (is_doctor) и
 * всех, кому отмечена хоть одна услуга («Услуги и ставки»), — так медсестру или
 * главного врача, которым услуга назначена, можно выбрать.
 */
export function performerCandidates(users) {
    return (users || []).filter(u => u && (isOn(u.is_doctor) || ratesOf(u).length > 0));
}

// doctors — список кандидатов; service — {id, requires_doctor, type, is_lab}.
export function doctorPoolFor(doctors, service) {
    if (!service) return [];
    const named = assignedTo(doctors, service.id);
    if (named.length) return named;
    return needsPerformer(service) ? (doctors || []).filter(isDoctorUser) : [];
}

/** DIAG_ROUTE_V1 — исполнитель по умолчанию: только когда кандидат ровно один. */
export function soleCandidate(pool) {
    return Array.isArray(pool) && pool.length === 1 ? pool[0] : null;
}
