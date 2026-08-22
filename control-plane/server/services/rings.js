// UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 3) —
// pure decision logic: which release (if any) a clinic should be offered, and
// whether a release's own failure reports have crossed the line that freezes
// it. No database, no clock beyond what's passed in — same discipline as
// ladder.js: everything a rule needs is an argument, so every rung of it is a
// one-line test instead of a fixture (see rings.test.js).

import { compareVersions } from '../../../scripts/build-bundle.mjs';

/**
 * Which release (if any) a clinic should be offered at check-in.
 *
 * ELIGIBLE requires ALL of:
 *
 *   - published to a ring the clinic can see: `release.ring >= clinic.ring`.
 *     Get the direction right, and see rings.test.js for both directions
 *     pinned: a release "published to ring N" reaches every clinic in ring
 *     0..N (ring 2 is the widest audience, "everyone"). So a release
 *     published to ring 0 must NOT reach a ring-2 clinic (0 < 2, excluded),
 *     but a release published to ring 2 DOES reach a ring-0 clinic (0 <= 2,
 *     included) — "everyone" includes the vendor's own install. The
 *     comparison is therefore `clinic.ring <= release.ring`, not the other
 *     way round.
 *   - `release.ring !== -1` — registered but never published is never
 *     offered. This already falls out of the arithmetic above for every real
 *     clinic ring (0/1/2 is never <= -1), but it is spelled out because
 *     "-1 means never offered" is the entire reason that sentinel exists,
 *     not an accident of it.
 *   - not halted.
 *   - strictly newer than `installedVersion` (numeric-segment compare via
 *     compareVersions — reused from scripts/build-bundle.mjs rather than a
 *     second implementation, per this task's own instruction). A clinic
 *     already on the release, or ahead of it, is offered nothing.
 *   - not blocked by `pinnedVersion`. PIN IS A CEILING, NOT A LOCK TO ONE
 *     EXACT BUILD: a release strictly newer than the pin is never offered; a
 *     release AT OR BELOW the pin is still offered as long as it also clears
 *     installedVersion. Concretely — installed 2.3.0, pinned 2.4.0:
 *       - release 2.4.0 published -> OFFERED. It is not newer than the pin,
 *         and it IS newer than installed. "Hold this clinic here" has to
 *         mean "you may still reach the pinned version itself" — the other
 *         reading (block everything from the pin onward, including the pin)
 *         would make pinning a clinic to the version it is about to receive
 *         indistinguishable from pinning it to stay on 2.3.0 forever, which
 *         is not what an admin asking to hold a clinic AT 2.4.0 intended.
 *       - release 2.5.0 published -> NOT offered (newer than the pin).
 *
 * Among everything eligible, the NEWEST wins, deterministically — never
 * order-dependent. If two releases are simultaneously eligible (e.g. 2.4.0
 * and 2.5.0, both published and unhalted), the response is always the single
 * newest one regardless of which order `releases` is passed in.
 *
 * @param {object} args
 * @param {Array<{version:string, ring:number, halted:boolean|number}>} args.releases
 * @param {{ring:number, pinnedVersion?:string|null}} args.clinic
 * @param {string|null|undefined} args.installedVersion
 * @returns {{version:string, ring:number, halted:boolean|number}|null}
 *   the winning release row (exactly as given), or null if nothing qualifies
 */
export function offerFor({ releases, clinic, installedVersion } = {}) {
  if (!Array.isArray(releases) || !clinic) return null;

  const clinicRing = Number(clinic.ring);
  if (!Number.isFinite(clinicRing)) return null; // a clinic with no sane ring is offered nothing, not a crash

  const pinned = clinic.pinnedVersion ?? null;

  let best = null;
  for (const release of releases) {
    if (!release || typeof release.version !== 'string' || !release.version) continue; // malformed row — skipped, never thrown

    const releaseRing = Number(release.ring);
    if (!Number.isFinite(releaseRing) || releaseRing === -1) continue; // never published

    if (clinicRing > releaseRing) continue; // see this function's own header for the direction
    if (release.halted) continue;
    if (compareVersions(release.version, installedVersion) <= 0) continue; // not strictly newer
    if (pinned && compareVersions(release.version, pinned) > 0) continue; // pin is a ceiling — see header

    if (!best || compareVersions(release.version, best.version) > 0) best = release;
  }
  return best;
}

// Halt when failures reach the threshold AND outnumber successes. Both
// conditions matter, and each guards a different mistake:
//
//   - `failures >= threshold` alone would eventually halt any release that
//     ever gets used enough, however overwhelmingly it succeeds — a release
//     installed at 500 clinics with 2 flaky failures and 498 clean installs
//     is not a broken release, and must never freeze on that basis.
//   - `failures > successes` alone (no floor) would halt on a single lone
//     failure with zero successes yet reported — the very first clinic in a
//     ring to check in AT ALL, before anyone has had a chance to succeed,
//     would freeze the release for everyone else in that ring on one data
//     point. THRESHOLD exists specifically so "the very first report happens
//     to be a failure" cannot alone trip it.
//
// Together: a release only auto-halts once there is a real floor of evidence
// (>= threshold failures) AND that evidence is not simply outnumbered by
// success — which is exactly the acceptance scenario this task specifies:
// two failures from a ring-2 clinic, zero successes, halts it.
export const DEFAULT_HALT_THRESHOLD = 2;

/**
 * The automatic stop. Pure arithmetic over already-counted outcomes — no
 * database here; services/checkin.js is what counts and calls this.
 *
 * BOUNDARY IS EXACT AND DELIBERATE: `failures >= threshold`, not `>`. An
 * off-by-one in either direction is the exact failure mode this task warns
 * about — `>` would mean "threshold" failures alone never halt (it never
 * halts until one MORE than what was configured), while a threshold that is
 * accidentally 0 or negative would halt on the first-ever failure report
 * regardless of what the vendor configured. See rings.test.js's boundary
 * tests, which pin `threshold - 1` failures as never halting and exactly
 * `threshold` failures (with fewer successes) as always halting.
 *
 * @param {object} args
 * @param {{failures?:number, successes?:number}} args.outcomes
 * @param {number} [args.threshold] defaults to DEFAULT_HALT_THRESHOLD
 * @returns {boolean}
 */
export function shouldHalt({ outcomes, threshold = DEFAULT_HALT_THRESHOLD } = {}) {
  // Coerced defensively, never thrown — this runs inside a check-in
  // transaction (services/checkin.js) where "never fail the call" is the
  // rule for everything derived from clinic-reported data.
  const failures = Number(outcomes?.failures);
  const successes = Number(outcomes?.successes);
  const t = Number(threshold);
  if (!Number.isFinite(failures) || !Number.isFinite(successes) || !Number.isFinite(t)) return false;

  return failures >= t && failures > successes;
}
