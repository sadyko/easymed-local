// js/admin/branch-filter.js — apply the global branch selection to a Supabase query.
import { getSelectedBranchIds, getAvailableBranchIds, isBranchRestricted } from './branch-context.js?v=bc3';

// table -> how it links to a branch.
//   direct: row has branch_id
//   embed:  filter via an inner-joined parent relation; the VIEW's .select() MUST
//           include `${rel}!inner(${col})` for `${rel}.${col}` to be filterable.
export const BRANCH_PATHS = {
  patients: { kind: 'direct', col: 'branch_id' },
  visits:   { kind: 'direct', col: 'branch_id' },
  invoices: { kind: 'direct', col: 'branch_id' },
  services:  { kind: 'direct', col: 'branch_id' },   // BRANCH_CLINIC_V1
  // BRANCH_ISOLATION_V2 — settings sections that carry branch_id directly:
  users:    { kind: 'direct', col: 'branch_id' },    // Employees (users.branch_id = primary branch)
  floors:   { kind: 'direct', col: 'branch_id' },
  wards:    { kind: 'direct', col: 'branch_id' },
  departments: { kind: 'direct', col: 'branch_id' },
  // BRANCH_ISOLATION_V2 — settings sections that reach a branch via a parent FK.
  // The VIEW's .select() MUST inner-join the parent (see section-crud loadRows).
  rooms:    { kind: 'embed', rel: 'floors', col: 'branch_id' },   // rooms.floor_id -> floors.branch_id
  beds:     { kind: 'embed', rel: 'wards',  col: 'branch_id' },   // beds.ward_id  -> wards.branch_id
  // Phase 2 consumers (embed):
  payments:       { kind: 'embed', rel: 'invoices', col: 'branch_id' },
  invoice_items:  { kind: 'embed', rel: 'invoices', col: 'branch_id' },
  visit_services: { kind: 'embed', rel: 'visits',   col: 'branch_id' },
};

// True only when the selection is a non-empty PROPER subset of available branches.
export function branchSelectionNarrows() {
  const sel = getSelectedBranchIds();
  const all = getAvailableBranchIds();
  return sel.length > 0 && sel.length < all.length;
}

// BRANCH_FILTER_ACTIVE_V1 — true exactly when branchScope() will actually constrain a
// query: restricted staff are always confined; owners/admins only when they narrow the
// picker to a proper subset. Consumers (section-crud embed select) mirror branchScope's
// predicate via this single source so the inner-join is added iff filtering is on.
export function branchFilterActive() {
  return isBranchRestricted() || branchSelectionNarrows();
}

// Apply the branch filter. Empty selection must be handled by the caller (empty state)
// BEFORE calling this. All-selected => unchanged (preserves null-branch rows).
export function branchScope(query, table) {
  // BRANCH_ISOLATION_V2 — restricted staff are ALWAYS confined to their branches (the security
  // boundary); owners/admins only filter when they narrow the picker to a proper subset.
  const restricted = isBranchRestricted();
  if (!branchFilterActive()) return query;
  const path = BRANCH_PATHS[table];
  const ids = getSelectedBranchIds();
  if (!ids.length) {
    // A restricted user with no selectable branch must see NOTHING (the fail-closed
    // boundary). Callers that can short-circuit to an empty-state should do so before
    // calling branchScope; this guard is the defence in depth. id=0 matches no row
    // (branch ids are uuids) so the list returns empty rather than the whole clinic.
    if (restricted) {
      const col = (path && path.kind === 'direct') ? path.col
                : (path && path.kind === 'embed')  ? `${path.rel}.${path.col}`
                : 'branch_id';
      return query.eq(col, '00000000-0000-0000-0000-000000000000');
    }
    return query;   // owner narrowed to nothing -> unchanged (handled as all)
  }
  if (!path) { console.warn(`[branch-filter] no path for '${table}' — unfiltered`); return query; }
  // Include legacy untagged rows (branch_id IS NULL) so data created before per-branch tagging
  // never disappears for branch staff during rollout.
  if (path.kind === 'direct') return query.or(`${path.col}.in.(${ids.join(',')}),${path.col}.is.null`);
  if (path.kind === 'embed')  return query.in(`${path.rel}.${path.col}`, ids);
  console.warn(`[branch-filter] bad path kind for '${table}'`); return query;
}
