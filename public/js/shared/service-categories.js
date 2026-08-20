// SERVICE_CATALOG_FILTER_V1 — категории каталога услуг и отбор по ним.
//
// Раскладка по разделам («Диагностика», «Консультации», …) жила приватно внутри
// visit-wizard.js, поэтому второй каталог — добавление услуг госпитализации —
// вынужден был бы завести СВОЮ копию правил. Две копии разошлись бы, и одна и
// та же услуга попадала бы в разные разделы на двух экранах.
//
// Чистый модуль: ни DOM, ни supabase — правила проверяются тестом.

// Порядок фиксирован: чипы не должны прыгать от того, каких услуг сегодня
// больше.
export const CAT_ORDER = ['Диагностика', 'Консультации', 'Лаборатория', 'Процедуры', 'Хирургия', 'Прочее'];

// Раздел услуги. У services нет колонки категории, поэтому раздел выводится:
// сначала по явному признаку лаборатории, дальше по названию.
export function categoryOf(s) {
    if (!s) return 'Прочее';
    if (s.is_lab) return 'Лаборатория';
    const n = (s.name || '').toLowerCase();
    if (/консульт|consult|приём|prием/.test(n)) return 'Консультации';
    if (/хирург|операц|surg|operat/.test(n)) return 'Хирургия';
    if (/узи|мрт|рентген|диагност|экг|ээг|эхо|доплер|томограф|x-ray|скрининг/.test(n)) return 'Диагностика';
    if (/процедур|инъекц|укол|капельниц|массаж|физио|перевязк/.test(n)) return 'Процедуры';
    return 'Прочее';
}

// Делает ли врач эту услугу. Источник — его же список ставок
// (users.service_rates): там перечислены услуги, которые он оказывает, вместе с
// процентом. Отдельного справочника «врач ↔ услуга» в базе нет.
export function doctorPerformsService(doctor, serviceId) {
    const rates = doctor && doctor.service_rates;
    if (!Array.isArray(rates)) return false;
    return rates.some((r) => r && String(r.service_id) === String(serviceId));
}

// Отбор каталога: строка поиска И раздел И врач. Пустой фильтр не сужает.
//
// Врач сужает жёстко: если у него в ставках нет ни одной услуги, список пуст —
// это честнее, чем показать весь каталог и дать записать услугу на врача,
// который её не делает.
export function filterCatalog(services, { query = '', category = '', doctor = null } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const list = Array.isArray(services) ? services : [];
    return list.filter((s) => {
        if (q && !(s.name || '').toLowerCase().includes(q)) return false;
        if (category && categoryOf(s) !== category) return false;
        if (doctor && !doctorPerformsService(doctor, s.id)) return false;
        return true;
    });
}

// Счётчики для чипов — по тому же отбору, что и список, но БЕЗ учёта самого
// раздела: иначе на выбранном чипе стояло бы его же число, а на остальных нули.
export function categoryCounts(services, { query = '', doctor = null } = {}) {
    const pool = filterCatalog(services, { query, doctor });
    const counts = { '': pool.length };
    for (const c of CAT_ORDER) counts[c] = 0;
    for (const s of pool) counts[categoryOf(s)] = (counts[categoryOf(s)] || 0) + 1;
    return counts;
}
