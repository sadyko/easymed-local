// SERVICE_GROUPS_V1 — which group ("тип услуги") a service belongs to.
//
// A service carries its group in TWO places and they are not equally reliable:
//
//   services.type     — the routing column. Populated for every row, and
//                       CHECK-constrained to a fixed set (migration 023), so it
//                       cannot be blank or misspelt.
//   services.type_id  — FK to `service_types`, the table Settings → «Типы услуг»
//                       edits. This is what every picker filters on... and it was
//                       NULL for all 513 services, because the import that
//                       created them only mapped `type`.
//
// The result was that group filtering silently did nothing: the recommend
// picker showed one «Прочее» chip for the whole catalogue, and clicking any
// group in the service picker returned an empty list, because `NULL === id` is
// never true. Migration 056 backfills type_id, but a future import can
// reintroduce NULLs, so the UI must not depend on it being set. This module is
// the single place that answers "which group is this service in", preferring
// type_id when present and deriving it from `type` when not.
//
// It is deliberately free of DOM and network imports so it can be unit-tested.

// The canonical routing values and the service_types name each maps to. This
// mirrors migration 056 — if the two disagree, a backfilled service and a
// freshly-imported one land in different groups.
export const TYPE_TO_GROUP_NAME = {
    consultation: 'Консультации',
    lab:          'Лаборатория',
    procedure:    'Процедуры',
    imaging:      'Диагностика',
    radiology:    'Лучевая диагностика',
    other:        'Хирургия',
};

// Fallback when a service has neither a usable type_id nor a known `type`.
const DEFAULT_GROUP_NAME = 'Консультации';

// The routing value for a service, never blank. `is_lab` wins over a missing or
// contradictory `type` because the two agree on every row in practice and
// is_lab is what the lab module itself trusts (lab-service.js isLabService).
export function serviceTypeKey(svc) {
    if (!svc) return 'consultation';
    const t = String(svc.type || '').trim().toLowerCase();
    if (t && TYPE_TO_GROUP_NAME[t]) return t;
    if (svc.is_lab) return 'lab';
    return 'consultation';
}

/**
 * The service_types id a service belongs to, as a STRING (picker state stores
 * ids as strings) or '' when it cannot be resolved at all.
 *
 * @param {object} svc    a services row
 * @param {Array}  types  the loaded service_types rows [{id, name}]
 */
export function resolveTypeId(svc, types) {
    if (!svc) return '';
    // A real, non-null type_id is authoritative — an admin may have moved this
    // service into a group by hand, and that must outrank the derivation.
    if (svc.type_id != null && svc.type_id !== '') return String(svc.type_id);
    if (!Array.isArray(types) || !types.length) return '';
    const wanted = TYPE_TO_GROUP_NAME[serviceTypeKey(svc)] || DEFAULT_GROUP_NAME;
    const hit = types.find(t => t && String(t.name || '').trim().toLowerCase() === wanted.toLowerCase());
    return hit ? String(hit.id) : '';
}

/**
 * Human label for a service's group — used for chip rails built by name rather
 * than by id. Falls back to the derived name so a NULL type_id never renders as
 * «Прочее» for the entire catalogue.
 */
export function serviceGroupLabel(svc, types) {
    if (!svc) return DEFAULT_GROUP_NAME;
    const id = svc.type_id != null && svc.type_id !== '' ? String(svc.type_id) : null;
    if (id && Array.isArray(types)) {
        const hit = types.find(t => t && String(t.id) === id);
        if (hit && hit.name) return hit.name;
    }
    // The embedded row (services.service_types(name)) when the caller selected it.
    if (svc.service_types && svc.service_types.name) return svc.service_types.name;
    return TYPE_TO_GROUP_NAME[serviceTypeKey(svc)] || DEFAULT_GROUP_NAME;
}

/**
 * Does a service belong to the given group id? The comparison every picker
 * needs. An empty/blank groupId means "all groups" and matches everything.
 */
export function serviceInGroup(svc, groupId, types) {
    if (groupId === null || groupId === undefined || groupId === '') return true;
    return resolveTypeId(svc, types) === String(groupId);
}
