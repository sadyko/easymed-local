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
//   'consultation' / 'imaging' / 'radiology' / 'other' → кабинет врача
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
 * @param svc      строка services (type, is_lab; для строки без группы —
 *                 department_id / type_id или встроенные departments / service_types)
 * @param lookups  { deptKindById, typeNameById } — нужны только строке без группы
 */
export function serviceRoute(svc, lookups = {}) {
    if (!svc) return 'cabinet';
    if (isOne(svc.is_lab)) return 'lab';
    const g = serviceGroup(svc);
    if (g === 'lab') return 'lab';
    if (g === 'procedure') return 'procedure';
    if (g) return 'cabinet';
    // Строка без группы — прежнее правило (SERVICE_ROUTING_V3 · LAB_SERVICE_ROUTING_V1).
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
 */
export function needsPerformer(svc) {
    if (!svc) return false;
    if (isOne(svc.requires_doctor)) return true;
    return serviceRoute(svc) === 'cabinet';
}

// ─── то же правило для SQL сервера ──────────────────────────────────────────
const GROUPS_SQL = "('" + SERVICE_GROUPS.join("','") + "')";
/** Строка без группы (SQL): колонка пуста или значение неизвестно. */
export const noGroupSql = (s = 's') => `COALESCE(${s}.type, '') NOT IN ${GROUPS_SQL}`;
/**
 * «Это процедура» (SQL) — группа 'procedure'; вид отделения — только у строки
 * без группы. s — псевдоним services, d — псевдоним departments (LEFT JOIN).
 */
export const procedureSql = (s = 's', d = 'd') => `(${s}.type = 'procedure' OR (${noGroupSql(s)} AND ${d}.kind = 'procedure'))`;
