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
// Услуге, которой врач НЕ нужен, фолбэк не даём: там пустой список — это
// правильный ответ («врач не требуется»), а не тупик.

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

// doctors — список врачей; service — {id, requires_doctor}.
export function doctorPoolFor(doctors, service) {
    if (!service) return [];
    const named = assignedTo(doctors, service.id);
    if (named.length) return named;
    return service.requires_doctor ? (doctors || []).slice() : [];
}
