// ═══════════════════════════════════════════════════════════════════════════
// DIAG_ROUTE_V1 (2026-11-03) — КУДА УХОДИТ СТРОКА УСЛУГИ: РЕШАЕТ ГРУППА
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец (3.21.0): «маршрут решает ГРУППА услуги, а не название». Группа —
// services.type, одна из пяти (редактор: «Группа — одна из пяти, задаёт
// маршрут»): Консультации · Лаборатория · Процедуры · Диагностика · Хирургия
// (+ старая 'radiology' — это та же «Диагностика»).
//
//   'lab'                                  → Лаборатория
//   'procedure'                            → Процедуры
//   'imaging' / 'radiology' / 'other'      → кабинет врача
//   'consultation'                         → кабинет врача, если отделение и тип
//                                            каталога не ведут в лабораторию /
//                                            процедуры (см. ИСКЛЮЧЕНИЕ ниже)
//
// Прежде у «группы» было два соперника, и оба побеждали её молча:
//   • ТИП каталога (service_types.name), похожий на лабораторию
//     (/^lab|laborator|лаборатор/i): «Лабораторная диагностика»,
//     «Laboratoriya va diagnostika» — УЗИ группы «Диагностика» уходило в
//     лабораторию, и врач-диагност его не видел;
//   • ВИД ОТДЕЛЕНИЯ (departments.kind 'laboratory' / 'procedure'): клиника
//     завела «Кабинет функциональной диагностики» видом «Процедурный» — ЭКГ
//     уходило в «Процедуры».
// Теперь тип и отделение маршрут НЕ меняют. Они спрашиваются только у строки
// без группы (старые данные, ответ без колонки type) — прежним правилом.
//
// ИСКЛЮЧЕНИЕ — группа «Консультации» (поправка ревью 2026-11-03). 'consultation'
// — УМОЛЧАНИЕ колонки services.type с миграции 023: многие клиники так и
// оставили в ней настоящие анализы и процедуры, а в лабораторию (в процедуры)
// они приходят только отделением «Лаборатория» («Процедурный») или «лабораторным»
// типом каталога. У группы «Консультации» эти подсказки спрашиваются ТАК ЖЕ, как
// у строки без группы (groupDecides); «Диагностика», «Лаборатория», «Процедуры»
// и «Хирургия»/«Прочее» решают сами — УЗИ и ЭКГ группы «Диагностика» всегда
// остаются в кабинете врача.
//
// is_lab — зеркало группы 'lab' (миграция 048, триггеры в обе стороны): им
// пользуются лаборатория и приём результатов анализаторов (server/lis/ingest.js
// пишет только в строку с is_lab = 1). Панель лаборатории маршрут не меняет —
// она лишь открывает строке ввод показателей в лаборатории (lab-service.js
// isLabService: УЗИ с панелью «Измерения» остаётся у врача и вносится в
// лаборатории).
//
// Чистый модуль, без DOM и базы: его берут и экраны, и сервер.

/** Группы услуги (CHECK миграции 023). */
export const SERVICE_GROUPS = Object.freeze(['consultation', 'lab', 'procedure', 'imaging', 'radiology', 'other']);

/** Тип каталога «похож на лабораторию» — только для строки без группы. */
export const LAB_NAME_RE = /^lab|laborator|лаборатор/i;

/** Группа услуги или '' — если её нет или она неизвестна. */
export function serviceGroup(svc) {
    const g = String((svc && svc.type) == null ? '' : svc.type).trim().toLowerCase();
    return SERVICE_GROUPS.includes(g) ? g : '';
}

/**
 * Группы, которые маршрут НЕ решают: у них, как у строки без группы, решают
 * вид отделения и имя типа каталога. Только «Консультации» — умолчание колонки
 * (миграция 023), под которым клиники держат и анализы.
 */
export const HINTED_GROUPS = Object.freeze(['consultation']);

/** Группа решает маршрут сама (есть и не из HINTED_GROUPS). */
export function groupDecides(svc) {
    const g = serviceGroup(svc);
    return !!g && !HINTED_GROUPS.includes(g);
}

const isOne = (v) => v === true || v === 1 || v === '1';

/** Вид отделения строки: встроенный (services.departments.kind / dept_kind) или из справочника. */
function deptKindOf(svc, lookups) {
    if (svc.departments && svc.departments.kind) return String(svc.departments.kind);
    if (svc.dept_kind) return String(svc.dept_kind);
    const map = lookups && lookups.deptKindById;
    return map && svc.department_id != null ? String(map[svc.department_id] || '') : '';
}

/** Имя типа каталога строки: встроенное (services.service_types.name) или из справочника. */
function typeNameOf(svc, lookups) {
    if (svc.service_types && svc.service_types.name) return String(svc.service_types.name);
    const map = lookups && lookups.typeNameById;
    return map && svc.type_id != null ? String(map[svc.type_id] || '') : '';
}

/**
 * Маршрут строки: 'lab' | 'procedure' | 'cabinet'.
 * @param svc      строка services (type, is_lab; для строки без группы и группы
 *                 «Консультации» — department_id / type_id или встроенные
 *                 departments / service_types)
 * @param lookups  { deptKindById, typeNameById } — нужны только строке без
 *                 группы и группе «Консультации»
 */
export function serviceRoute(svc, lookups = {}) {
    if (!svc) return 'cabinet';
    if (isOne(svc.is_lab)) return 'lab';
    const g = serviceGroup(svc);
    if (g === 'lab') return 'lab';
    if (g === 'procedure') return 'procedure';
    if (groupDecides(svc)) return 'cabinet';
    // Строка без группы и группа «Консультации» — прежнее правило
    // (SERVICE_ROUTING_V3 · LAB_SERVICE_ROUTING_V1).
    const kind = deptKindOf(svc, lookups);
    if (kind === 'laboratory' || LAB_NAME_RE.test(typeNameOf(svc, lookups))) return 'lab';
    if (kind === 'procedure') return 'procedure';
    return 'cabinet';
}

/** Строка уходит в кабинет врача? */
export const goesToCabinet = (svc, lookups) => serviceRoute(svc, lookups) === 'cabinet';

/**
 * DIAG_ROUTE_V1 (D1, решение владельца 2026-11-03) — НУЖЕН ЛИ СТРОКЕ ИСПОЛНИТЕЛЬ.
 * Строка кабинета без исполнителя не видна никому (SERVICE_SCOPE_V3: кабинет
 * показывает только назначенное), поэтому регистратура выбирает исполнителя
 * у КАЖДОЙ услуги, кроме групп «Лаборатория» и «Процедуры». Галочка «Услугу
 * оказывает специалист» (requires_doctor) требует исполнителя всегда.
 * Маршрут — тот же serviceRoute: анализ группы «Консультации» из отделения
 * «Лаборатория» исполнителя не требует (строке нужны встроенные departments(kind)
 * / service_types(name) или lookups — экраны записи грузят их вместе с услугой,
 * ROUTE_SELECT).
 */
export function needsPerformer(svc, lookups = {}) {
    if (!svc) return false;
    if (isOne(svc.requires_doctor)) return true;
    return serviceRoute(svc, lookups) === 'cabinet';
}

/**
 * LAB_NO_DOCTOR_V1 (3.23.0) — ОБЯЗАН ЛИ РЕГИСТРАТОР ВЫБРАТЬ ИСПОЛНИТЕЛЯ, чтобы пройти
 * дальше. То же, что needsPerformer, но у строки без группы и у группы «Консультации»
 * (умолчание колонки — под ним клиники держат и анализы, HINTED_GROUPS) решает флаг
 * «нужен врач»: requires_doctor = 0 — анализ, оставленный в «Консультациях» без
 * подсказок отделения и типа, — исполнитель по желанию, «Далее» он не держит.
 * Группы, которые решают маршрут сами («Диагностика», «Прочее»), — как прежде (D1):
 * их строку без исполнителя не увидит ни один врач. Флаг не прислан — как прежде.
 */
export function performerRequired(svc, lookups = {}) {
    if (!needsPerformer(svc, lookups)) return false;
    if (isOne(svc.requires_doctor) || groupDecides(svc)) return true;
    const rd = svc.requires_doctor;
    return !(rd === 0 || rd === '0' || rd === false);
}

/**
 * Колонки услуги для маршрута на экранах записи (select /api/db): группа,
 * зеркало is_lab и подсказки для группы «Консультации» — одним ответом.
 */
export const ROUTE_SELECT = 'type, is_lab, department_id, type_id, service_types(name), departments(kind)';

// ─── то же правило для SQL сервера ──────────────────────────────────────────
const GROUPS_SQL = "('" + SERVICE_GROUPS.join("','") + "')";
const HINTED_SQL = "('" + HINTED_GROUPS.join("','") + "')";
/** Строка без группы (SQL): колонка пуста или значение неизвестно. */
export const noGroupSql = (s = 's') => `COALESCE(${s}.type, '') NOT IN ${GROUPS_SQL}`;
/**
 * Группа маршрут НЕ решает (SQL) — строка без группы или группа «Консультации»:
 * у неё решают вид отделения и имя типа каталога (то же, что !groupDecides).
 */
export const hintedSql = (s = 's') => `(${noGroupSql(s)} OR ${s}.type IN ${HINTED_SQL})`;
/**
 * «Это процедура» (SQL) — группа 'procedure'; вид отделения — только у строки
 * без группы и у группы «Консультации». s — псевдоним services, d — псевдоним
 * departments (LEFT JOIN).
 */
export const procedureSql = (s = 's', d = 'd') => `(${s}.type = 'procedure' OR (${hintedSql(s)} AND ${d}.kind = 'procedure'))`;
