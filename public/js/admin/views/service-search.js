// CRM_SERVICE_FILTER_V1 — choosing services from a 511-row catalogue.
//
// Two pure functions behind the call centre's «Интересующие услуги» box and the
// counted category rail above it. They are the same two questions the
// registrar's picker asks (service-picker-modal.js paintCatGroups/paintCatList),
// lifted out of that view so the call centre can ask them too without a second,
// drifting copy of the logic.
//
// Grouping is delegated ENTIRELY to service-group.js. That module exists because
// pickers used to compare `svc.type_id === groupId` directly against a column
// that is NULL for most of the catalogue, which silently emptied every category.
// Nothing here may reintroduce that comparison.
//
// DOM- and network-free on purpose, like service-group.js — see
// service-search.test.js.

import { serviceInGroup, resolveTypeId } from './service-group.js';

const idSet = (ids) => new Set((ids || []).map((v) => String(v)));

/**
 * The services to offer, in catalogue order.
 *
 * The category is applied BEFORE the text match, which is the whole contract:
 * once the operator picks «Лаборатория», typing searches inside Лаборатория and
 * cannot surface a consultation.
 *
 * @param {Array}  catalog          services rows
 * @param {string} opts.query       free text matched against the name, case-insensitive
 * @param {string} opts.groupId     service_types id, '' for all groups
 * @param {Array}  opts.chosen      service ids already added to the request
 * @param {Array}  opts.types       loaded service_types rows
 * @param {number} opts.limit       cap applied last; 0/omitted means no cap
 */
export function filterServicePool(catalog, opts = {}) {
    const { query = '', groupId = '', chosen = [], types = [], limit = 0 } = opts;
    const skip = idSet(chosen);
    const q = String(query || '').trim().toLowerCase();
    const out = (catalog || []).filter((sv) => sv
        && !skip.has(String(sv.id))
        && serviceInGroup(sv, groupId, types)
        && (!q || String(sv.name || '').toLowerCase().includes(q)));
    return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * Chip-rail counts: { total, byGroup: { <type_id>: n } }.
 *
 * Counts ignore the search box — a rail that renumbered itself on every
 * keystroke could not be used to navigate — but they DO exclude services
 * already added, so the numbers keep matching what is still on offer.
 *
 * A service whose group cannot be resolved at all is counted in `total` and in
 * no chip, so the rail never claims more than it can show.
 */
export function serviceGroupCounts(catalog, opts = {}) {
    const { chosen = [], types = [] } = opts;
    const skip = idSet(chosen);
    const byGroup = {};
    let total = 0;
    for (const sv of catalog || []) {
        if (!sv || skip.has(String(sv.id))) continue;
        total += 1;
        const g = resolveTypeId(sv, types);
        if (g) byGroup[g] = (byGroup[g] || 0) + 1;
    }
    return { total, byGroup };
}
