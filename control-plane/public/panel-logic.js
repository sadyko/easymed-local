// CONTROL_PLANE_PANEL_V1 — every decision the panel makes, kept pure and DOM-
// free so it is testable with plain `node --test`, no browser/jsdom needed.
// panel-clinics.js / panel-requests.js / panel.js call these; they hold no
// decisions of their own beyond "call the right pure function and paint the
// result" — see panel-logic.test.js for the behaviour this pins.

// STALE_CLINIC_V1 — a clinic that hasn't checked in for 3+ days is quietly in
// trouble (offline install, a dead cron, a clinic that gave up on paying) and
// that is worth a red flag in the list rather than one more grey timestamp
// nobody scans. "Older than 3 days" is exclusive of the boundary itself: a
// clinic checking in once a day that happens to land at exactly 72h is still
// behaving normally.
export const STALE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

// Mirrors SELLABLE_MODULES in server/services/rpc/licence.js (the one real
// vocabulary the clinic app and admin.js both key off). There is no admin
// route today that publishes this list to the panel over HTTP, so this is a
// small, deliberately duplicated constant rather than a derived one — if
// SELLABLE_MODULES ever grows a key, this needs a matching edit.
//
// That prediction came true on 2026-08-23: 'callcenter' was added server-side
// with the Binotel integration, and the panel — holding this stale copy —
// showed no toggle for it, so the owner could not sell the module even though
// every server route already accepted it. The duplication is the cost of
// having no list-publishing route; the fix is to edit BOTH places in the same
// commit, always. (A /cp/v1/admin/modules route that derives this list would
// retire the problem — worth doing the next time this file is touched.)
//
// Passed through moduleToggles() UNFILTERED (marketing included) so that
// function's own exclusion is what actually gets exercised, rather than
// trusting every caller to remember to filter first.
export const SELLABLE_MODULES = ['crm', 'telegram', 'marketing', 'callcenter'];

function parseDate(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function asMs(now) {
  return now instanceof Date ? now.getTime() : new Date(now).getTime();
}

/** 'ok' | 'stale' | 'never' — drives the clinics-list row highlight. */
export function lastSeenSeverity(lastSeenIso, now = new Date()) {
  const t = parseDate(lastSeenIso);
  if (t === null) return 'never';
  const diff = asMs(now) - t;
  return diff > STALE_THRESHOLD_MS ? 'stale' : 'ok';
}

/** "2 h ago" / "5 days ago" / "never" — human-readable, never a raw ISO string. */
export function formatLastSeen(lastSeenIso, now = new Date()) {
  const t = parseDate(lastSeenIso);
  if (t === null) return 'never';
  const diffMs = Math.max(0, asMs(now) - t);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const MODULE_LABELS = { crm: 'CRM', telegram: 'Telegram', callcenter: 'Колл-центр' };

function moduleLabel(key) {
  return MODULE_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
}

// MARKETING_NOT_OFFERABLE_V1 (panel side) — mirrors OFFERABLE_MODULES in
// server/routes/admin.js: no screen exists for it in the clinic app, and the
// API rejects granting it even if this UI somehow offered it. Filtered here,
// unconditionally, so a stray marketing entry in either `allSellable` or
// `granted` can never produce a chip that always fails when clicked.
export function moduleToggles(allSellable, granted) {
  const grantedSet = new Set(Array.isArray(granted) ? granted : (granted instanceof Set ? granted : []));
  return [...(allSellable || [])]
    .filter((key) => key !== 'marketing')
    .sort()
    .map((key) => ({ key, label: moduleLabel(key), granted: grantedSet.has(key) }));
}

// LEGACY_MARKETING_VISIBILITY_V1 — moduleToggles() above never renders a
// marketing chip, by design. But server/routes/admin.js's revoke path
// deliberately checks the FULL sellable vocabulary, not the offerable
// subset — so if a stray 'marketing' grant ever exists (hand-edited data, a
// bug elsewhere), the SERVER still lets it be revoked even though this panel
// gives it no toggle. This flag lets the detail view say so as a read-only
// fact instead of either silently hiding it or offering a button that
// implies it could be re-granted.
export function hasUnmanageableMarketingGrant(granted) {
  if (Array.isArray(granted)) return granted.includes('marketing');
  if (granted instanceof Set) return granted.has('marketing');
  return false;
}

// MARKETING_NOT_OFFERABLE_V1 (requests inbox) — a lead can legitimately ask
// for 'marketing' (module_request's own vocabulary is the full
// SELLABLE_MODULES set), but POST /requests/:id/grant always 400s for it —
// see admin.js's own attack test. The inbox must not render a Grant button
// that is guaranteed to fail; this is the one-key version of the same rule
// moduleToggles() enforces for the whole clinic-detail vocabulary.
export function isGrantable(moduleKey) {
  return moduleKey !== 'marketing';
}

function todayStr(now) {
  const d = now instanceof Date ? now : new Date(now);
  return d.toISOString().slice(0, 10);
}

/**
 * { label, tone } for the subscription column/badge. `tone` is 'ok' | 'danger'.
 *
 * subscription_until is inclusive of the day itself (matches
 * services/checkin.js's own isEntitled) — only a date strictly before today
 * is actually a problem. An 'active' row whose date HAS lapsed must read as
 * a problem, never as a healthy "Active" — that is the whole reason this
 * function exists instead of the view just echoing the raw column.
 */
export function subscriptionBadge(subscription, until, now = new Date()) {
  if (subscription !== 'active') return { label: 'Unpaid', tone: 'danger' };
  if (!until) return { label: 'Active', tone: 'ok' };
  if (until < todayStr(now)) return { label: `Active — expired ${until}`, tone: 'danger' };
  return { label: `Active · paid until ${until}`, tone: 'ok' };
}

// Codes read aloud over a phone (enrollment: EM-XXXX-XXXX, unlock:
// XXXXX-XXXXX — see enrollment.js / control/unlock.js) are shown "large,
// monospaced, letter-spaced", grouped exactly as the server formatted them —
// never reflowed into a different grouping than what the owner is meant to
// read out.
export function codeGroups(code) {
  return String(code || '').split('-').filter(Boolean);
}

// EMPTY_MEANS_NO_DATE_V1 — an <input type="date"> reports '' when cleared.
// That must serialise to null (no end date), never to "" and never silently
// to today — an admin who explicitly picks today's date in the picker IS
// saying "paid through today", which is a different, distinguishable fact
// from never having set a date at all.
export function subscriptionUntilPayload(rawValue) {
  const v = typeof rawValue === 'string' ? rawValue.trim() : '';
  return v === '' ? null : v;
}

// --- STATS_V1 (docs/plans/2026-08-22-statistics.md) -------------------------
//
// The Statistics card: a checkbox list editing collect_set, and the latest
// reported numbers. Same split as everything above — the view (panel-clinic-
// detail.js) only calls these and paints the result.

// Which of the CURRENT catalogue's counter names should render checked, given
// a clinic's own collect_set. null/undefined means "never touched" — the
// server-side default is every known counter (see services/checkin.js's
// resolveCollectSet), so the checkbox list must show that same default as
// all-checked, not all-UNchecked — an empty picklist would look identical to
// "collect nothing", which is a real, different, explicit choice (a real
// array, even an empty one). Filtered against counterNames on the way in too:
// a stale collect_set entry naming a since-removed counter must not produce
// a checkbox for a row that no longer exists in the list being rendered.
export function counterCheckedState(counterNames, collectSet) {
  const names = Array.isArray(counterNames) ? counterNames : [];
  if (collectSet === null || collectSet === undefined) return new Set(names);
  const picked = Array.isArray(collectSet) ? collectSet : [];
  return new Set(picked.filter((n) => names.includes(n)));
}

// Turns a clinic's latest_stats object (from GET /admin/clinics/:id) plus the
// current /admin/counters catalogue into rows ready to render, sorted by
// name for a stable display order. A reported name the catalogue no longer
// has (removed in a later release — see this task's own attack list) still
// gets a row: its raw key stands in for the missing describe text, rather
// than the row vanishing or the view throwing on a lookup miss.
export function statsRows(latestStats, counters) {
  const describeByName = new Map((Array.isArray(counters) ? counters : []).map((c) => [c.name, c.describe]));
  const stats = latestStats && typeof latestStats === 'object' ? latestStats : {};
  return Object.keys(stats)
    .sort()
    .map((name) => ({ name, describe: describeByName.get(name) || name, value: stats[name] }));
}
