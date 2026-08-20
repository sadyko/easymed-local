// LAB_SERVICE_ROUTING_V1 — the single answer to "is this service lab work?"
//
// Ported from production easymed.uz (views/laboratory.js loadOrders), where the
// test is three-way:
//
//   const labRegex = /^lab|laborator|лаборатор/i;
//   const _isLab = (r) => r.services?.type === 'lab'
//       || r.services?.departments?.kind === 'laboratory'
//       || labRegex.test(r.services?.service_types?.name || '');
//
// This build previously checked only the first branch (plus the older is_lab
// flag), so a clinic that routed a service to the lab the way the server teaches
// — by putting it in the Laboratory DEPARTMENT, or giving it a service TYPE
// named «Лаборатория» — got a service that never reached the lab queue and could
// not usefully carry a panel. Both of those routes were additionally dead here
// because migration 038 seeded no laboratory department and service_types ships
// empty; migration 049 fixes the first.
//
// Local cannot express the server's two-hop embed (`services(departments(kind))`)
// — the query compiler does one hop — so the caller loads the two small lookup
// tables once and passes them in as maps. Keeping the rule in one pure function
// means the queue and the panel picker can never disagree about what a lab
// service is, which is exactly how they drifted apart before.

// Matches Лаборатория / Laboratory / Lab. The explicit Cyrillic branch is
// deliberate: `лаборатор` does not fold to `lab` under any case rule.
export const LAB_NAME_RE = /^lab|laborator|лаборатор/i;

/**
 * @param service   a `services` row (needs type / is_lab, optionally
 *                  department_id and type_id)
 * @param lookups   { deptKindById, typeNameById, hasPanel } — any may be omitted
 * @returns {boolean}
 */
export function isLabService(service, lookups = {}) {
    if (!service) return false;
    const { deptKindById = {}, typeNameById = {}, hasPanel = null } = lookups;

    // 1. the routing enum the Services editor writes, and the older boolean that
    //    migration 048's triggers now keep in step with it
    if (service.type === 'lab' || service.is_lab === 1 || service.is_lab === true) return true;

    // 2. the department the service belongs to is a laboratory
    if (service.department_id != null && deptKindById[service.department_id] === 'laboratory') return true;

    // 3. the service's catalogue type is named like a laboratory
    if (service.type_id != null && LAB_NAME_RE.test(typeNameById[service.type_id] || '')) return true;

    // 4. local addition: a linked panel IS a declaration that this produces a lab
    //    result. The server has no equivalent because there every panel is linked
    //    to an already-lab service; here a clinic can link one first.
    if (typeof hasPanel === 'function' ? hasPanel(service.id) : hasPanel === true) return true;

    return false;
}

/** Builds `{id: kind}` from a departments list. */
export function deptKindMap(departments) {
    const m = {};
    for (const d of departments || []) if (d && d.id != null) m[d.id] = d.kind || '';
    return m;
}

/** Builds `{id: name}` from a service_types list. */
export function typeNameMap(serviceTypes) {
    const m = {};
    for (const t of serviceTypes || []) if (t && t.id != null) m[t.id] = t.name || '';
    return m;
}
