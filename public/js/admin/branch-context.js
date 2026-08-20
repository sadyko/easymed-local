// js/admin/branch-context.js — global branch selection.
// Mirrors clinic-context.js: load → store on globals + localStorage → emit events.
// Available branches = the user's user_branches; admins/owners/super-admins (or users
// BRANCH_ISOLATION_V2: admins/owners/super-admins fall back to ALL active clinic branches;
// a restricted non-admin with no assignment gets an EMPTY available set (sees nothing).

let _available = [];  // [{id, name}]
let _selected = [];   // [id]
let _restricted = false;   // BRANCH_ISOLATION_V1 — true => staff locked to their branch(es)
const LISTENERS = new Set();

function _ids(list) { return (list || []).map((x) => (x && x.id != null ? x.id : x)); }
export function getAvailableBranches()  { return _available.slice(); }
export function getAvailableBranchIds() { return _ids(_available); }
export function getSelectedBranchIds()  { return _selected.slice(); }
export function isAllSelected()  { return _available.length > 0 && _selected.length === _available.length; }
export function isNoneSelected() { return _selected.length === 0; }
export function isBranchRestricted() { return _restricted; }   // BRANCH_ISOLATION_V1

// SOLE_BRANCH_V1 — в клинике доступен ровно ОДИН филиал: выбирать нечего, поэтому
// везде, где требуется филиал, он подставляется сам (сотрудник, пациент, визит).
// Возвращает id этого филиала либо null — если филиалов ноль или больше одного,
// выбор остаётся за человеком и ничего не угадывается.
export function soleBranchId() {
  return _available.length === 1 ? _available[0].id : null;
}

function storageKey() {
  const co = (window.CLINIC && window.CLINIC.id) || 'nocompany';
  const u  = (window.CURRENT_USER && window.CURRENT_USER.id) || 'nouser';
  return `em.branches.${co}.${u}`;
}
function readStored() {
  try { const v = JSON.parse(localStorage.getItem(storageKey())); return Array.isArray(v) ? v : null; }
  catch { return null; }
}
function writeStored(ids) {
  try { localStorage.setItem(storageKey(), JSON.stringify(ids)); } catch {}
}

export function onBranchChange(fn) { LISTENERS.add(fn); return () => LISTENERS.delete(fn); }
function emit() {
  window.SELECTED_BRANCHES = getSelectedBranchIds();
  for (const fn of LISTENERS) { try { fn(getSelectedBranchIds()); } catch (e) { console.warn('[branch] listener', e); } }
  window.dispatchEvent(new CustomEvent('branch:change', { detail: { ids: getSelectedBranchIds() } }));
}

export function setSelectedBranchIds(ids) {
  const valid = new Set(getAvailableBranchIds());
  _selected = (ids || []).filter((id) => valid.has(id));
  writeStored(_selected);
  emit();
}
export function selectAllBranches() { setSelectedBranchIds(getAvailableBranchIds()); }
export function clearBranches()     { setSelectedBranchIds([]); }

// Load the user's available branches and restore selection. user = the authed user row.
export async function initBranchContext(supabase, user) {
  _available = [];
  _selected = [];
  _restricted = false;
  try {
    // BRANCH_ISOLATION_V1 — owners/admins/super-admins see ALL clinic branches; other staff
    // (doctors, nurses, registrators, cashiers) are locked to their assigned branches.
    const role = (user && user.role ? String(user.role).toLowerCase() : '');
    const prole = (user && user.platform_role ? String(user.platform_role).toLowerCase() : '');
    const seesAll = !!(user && (user.is_super_admin || role === 'admin' || role === 'owner'
                               || prole === 'super_admin' || prole === 'admin'));
    // BRANCH_ISOLATION_V2 — a non-admin is ALWAYS restricted to their explicit
    // assignment. user_branches takes precedence; users.branch_id is the legacy
    // single-branch fallback. A non-admin with NO assignment at all is restricted
    // to an EMPTY set (sees nothing) — never the clinic-wide fallback, which was
    // the fail-open that silently defeated isolation.
    let rows = null;
    if (!seesAll && user && user.id) {
      _restricted = true;   // the security boundary — set BEFORE any data shapes it
      const { data } = await supabase
        .from('user_branches')
        .select('branch_id, branches(id, name, active)')
        .eq('user_id', user.id);
      rows = (data || [])
        .map((r) => r.branches)
        .filter((b) => b && b.active !== false)
        .map((b) => ({ id: b.id, name: b.name }));
      // Legacy single-branch fallback when no user_branches rows exist yet.
      if (rows.length === 0 && user.branch_id) {
        const { data: b } = await supabase
          .from('branches')
          .select('id, name, active')
          .eq('id', user.branch_id)
          .maybeSingle();
        if (b && b.active !== false) rows = [{ id: b.id, name: b.name }];
      }
      // rows may legitimately be [] here: restricted user, zero assignment.
      _available = rows;
    } else {
      // Owner / admin / super-admin -> see every active branch in THEIR clinic.
      // Scope by company_id so day-to-day clinic work never surfaces other
      // tenants' branches; only a super admin with no company_id (a true
      // platform user) gets the unscoped list.
      let q = supabase.from('branches').select('id, name').eq('active', true);
      if (user && user.company_id) q = q.eq('company_id', user.company_id);
      const { data } = await q.order('name');
      _available = (data || []).map((b) => ({ id: b.id, name: b.name }));
    }
  } catch (e) {
    console.warn('[branch-context] load failed; degrading to no branch filter', e);
    _available = [];
  }
  // restore selection (validated) or default to all available
  const stored = readStored();
  const validIds = getAvailableBranchIds();
  const validSet = new Set(validIds);
  _selected = stored ? stored.filter((id) => validSet.has(id)) : validIds.slice();
  window.BRANCHES = _available;
  window.SELECTED_BRANCHES = getSelectedBranchIds();
  return { branches: _available, selected: getSelectedBranchIds() };
}

// Test-only seam.
export function _setStateForTest({ available, selected, restricted }) {
  _available = available || [];
  _selected = selected || [];
  _restricted = restricted === true;   // BRANCH_ISOLATION_V2 — exercise the fail-closed guard
}
