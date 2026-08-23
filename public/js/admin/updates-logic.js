// UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 6) — every
// display/scheduling DECISION behind the update-approval screen
// (views/updates.js) and its banner (admin.js renderUpdateBanner), as pure
// functions: no DOM, no clock of their own (every "now" is a parameter), no
// network. That is what makes the midnight-crossing question below testable
// without a fake DOM or a mocked Date global — see updates-logic.test.js.
//
// nextRunAtLocal()/scheduleChoices() MIRROR server/services/control/
// update-schedule.js's nextRunAt() rule exactly (strict `>` boundary, local
// Y/M/D, setDate()-based "+1 day" so a DST jump can't skip or repeat an
// hour). They do not IMPORT it: this file ships to the browser under
// public/js/admin/, and server/ is never reachable from there —
// server/app.js serves only express.static(path.join(ROOT, 'public'), …), so
// there is no URL a <script type=module> could import
// server/services/control/update-schedule.js from. If that file's rule ever
// changes, this one (and its test) must change with it by hand — its own
// header comment says the same thing back, so the coupling is visible from
// either side.

function pad2(n) { return String(n).padStart(2, '0'); }

/** Russian-style date, e.g. 20.08.2026 — this codebase's convention (see CLAUDE.md / house rules). */
export function formatRuDate(date) {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** Russian-style hour, e.g. 03:00 — this system only ever schedules on the hour. */
export function formatRuHour(hour) {
  return `${pad2(Number(hour))}:00`;
}

/**
 * 08:00–19:59 local — the heuristic for "the clinic is probably open right
 * now". Used to WARN, never to block: a 24-hour clinic may have a good
 * reason to install at 10:00, and it is their clinic.
 */
export function isWorkingHour(hour) {
  const h = Number(hour);
  return Number.isInteger(h) && h >= 8 && h <= 19;
}

// Same coercion + validation as update-schedule.js's own nextRunAt() and
// updates.js's update_approve RPC: Number(null) and Number('') are both 0, so
// only a real number or a non-blank numeric string (the shape an <input> or a
// picker hands back) is coerced — everything else becomes NaN and is refused.
function coerceHour(hour) {
  return typeof hour === 'number'
    ? hour
    : (typeof hour === 'string' && hour.trim() !== '' ? Number(hour) : NaN);
}

/** True if `hour` is a real 0-23 integer (or a numeric string) — lets the view disable "Approve" on garbage input instead of letting nextRunAtLocal's throw reach a click handler. */
export function isValidHour(hour) {
  const h = coerceHour(hour);
  return Number.isInteger(h) && h >= 0 && h <= 23;
}

/**
 * The next moment `hour:00` LOCAL time occurs, at or after `now`. Mirror of
 * update-schedule.js's nextRunAt() — see this file's header for why this is
 * a mirror, not an import. "Today if still ahead, else tomorrow", boundary
 * instant counts as already arrived (strict `>`, not `>=`).
 *
 * @param {number|string} hour  0-23, local
 * @param {Date} [now]
 * @returns {Date}
 */
export function nextRunAtLocal(hour, now = new Date()) {
  const h = coerceHour(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    throw new Error(`hour must be an integer 0-23, got ${JSON.stringify(hour)}`);
  }
  // Built from now's own local Y/M/D — never UTC — so a clinic in any
  // timezone gets ITS midnight-to-midnight, exactly like the server mirror.
  const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0);
  if (todayAt.getTime() > now.getTime()) return todayAt;
  // setDate (not "+24h in ms"), same DST-safety reasoning as the server file:
  // "the same local wall-clock time, one calendar day later".
  const tomorrowAt = new Date(todayAt.getTime());
  tomorrowAt.setDate(tomorrowAt.getDate() + 1);
  return tomorrowAt;
}

/** Everything the view needs to show and act on ONE candidate hour. */
export function resolveHour(hour, now = new Date()) {
  const at = nextRunAtLocal(hour, now);
  return {
    hour: Number(coerceHour(hour)),
    at,
    dateLabel: formatRuDate(at),
    hourLabel: formatRuHour(hour),
    isWorking: isWorkingHour(hour),
  };
}

/**
 * The two named choices the approval screen leads with — «сегодня ночью» /
 * «завтра ночью» — computed against `now`, plus the default hour a free
 * hour-picker should start from.
 *
 * `tomorrow` is always exactly ONE CALENDAR DAY after whatever `tonight`
 * resolved to (resolveHour → nextRunAtLocal once, then plain setDate on the
 * result) — never a second, independent nextRunAtLocal() call at a shifted
 * `now`. That second call could disagree with the first about the hour
 * across a DST transition (or simply drift for no visible reason), which
 * would put the two buttons at odds with each other. Reusing the already-
 * resolved instant and stepping it by one calendar day is the same
 * technique nextRunAt() itself already uses for its own "+1 day", applied
 * here a second time rather than reimplemented.
 *
 * ATTACK-YOUR-OWN-CODE — "does the label lie at 23:xx?": the button text
 * ("tonight") is a colloquialism that spans past midnight; the INSTANT it
 * schedules is always computed by the exact tested nextRunAt rule above,
 * and every screen that shows the outcome (formatScheduled below) prints
 * the real resolved calendar date, never just the word "tonight" — so
 * nothing hidden or wrong ever reaches the clinic, whatever the button
 * happened to be called at the moment it was clicked.
 *
 * @param {Date} [now]
 * @param {number} [defaultHour]  the night hour offered as "tonight"/"tomorrow night"
 */
export function scheduleChoices(now = new Date(), defaultHour = 3) {
  const tonight = resolveHour(defaultHour, now);
  const tomorrowAt = new Date(tonight.at.getTime());
  tomorrowAt.setDate(tomorrowAt.getDate() + 1);
  const tomorrow = {
    hour: Number(defaultHour),
    at: tomorrowAt,
    dateLabel: formatRuDate(tomorrowAt),
    hourLabel: formatRuHour(defaultHour),
    isWorking: isWorkingHour(defaultHour),
  };
  return { defaultHour: Number(defaultHour), tonight, tomorrow };
}

/**
 * True when the stored offer is for the version already running — a narrow
 * window that can exist right after a successful install and before the
 * next daily check-in clears/replaces the offer (see
 * server/services/control/checkin.js, which deletes or overwrites
 * `update_offer` only on the NEXT check-in response). Treated as "nothing to
 * offer" so the screen calmly says "up to date" instead of asking a clinic
 * to update to the exact version it is already on.
 */
export function offerIsCurrent(offer, currentVersion) {
  return !!(offer && currentVersion && offer.version === currentVersion);
}

/**
 * The confirmation sentence once an hour is approved — «Обновление
 * установится <date> в <hour>:00. Компьютер должен быть включён.» Built as
 * a plain concatenated Russian string, not looked up through tr()'s STRINGS
 * table: this codebase's own convention for a sentence with a dynamic
 * value spliced in (see admin.js's renderLicenceBanner, and reports-hub.js's
 * "N дн." tiles) — there is no {date}/{hour} placeholder mechanism in
 * STRINGS to hook into instead, so the whole sentence renders in Russian
 * regardless of the active language, same as those two precedents.
 *
 * @param {{hour: number|null, scheduled_at: string|null}} consent — the
 *   relevant slice of update_status's response (hour/scheduled_at sit at
 *   its top level, not nested under a "consent" key — this parameter name
 *   describes what they MEAN, not their literal shape on the wire).
 * @returns {string|null} null when nothing is actually scheduled
 */
export function formatScheduled(consent) {
  const hour = consent && consent.hour;
  const scheduledAt = consent && consent.scheduled_at;
  // «Обновить сейчас»: immediate consent has hour null BY DESIGN (see
  // update_approve's own comment) — an instant, not a wall-clock hour, so
  // the sentence promises minutes, not a time of day. Checked before the
  // hour==null guard below, which otherwise reads immediate as "nothing
  // scheduled" and leaves the screen blank right after the click.
  if (consent && consent.immediate === true && scheduledAt) {
    return 'Обновление устанавливается. Обычно это занимает несколько минут — не выключайте компьютер.';
  }
  if (hour == null || !scheduledAt) return null;
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return null;
  return `Обновление установится ${formatRuDate(d)} в ${formatRuHour(hour)}. Компьютер должен быть включён.`;
}

/**
 * The plain, unavoidable notice for a failed-and-rolled-back update — «a
 * clinic must not discover from the vendor that its update failed» (the
 * plan's own words). Never fires for a SUCCESSFUL last_result — that is
 * whatsNewState()'s job below, not this one's.
 *
 * `lastResult` is install/apply-update.ps1's outcome file
 * (`Write-UpdateOutcome`): `{version, from, ok, db, at, detail}`. Every field
 * but `ok` is treated as possibly-missing/malformed — that file is still
 * under active development on another branch of this same task, and a
 * corrupt or half-written outcome file must never crash this screen (same
 * defensive posture as updates.js's own readLastResult()).
 *
 * @param {object|null} lastResult
 * @param {string|null} currentVersion  what update_status.current_version says NOW — the version the clinic rolled back TO, not `lastResult.from` (the server is the live source of truth for what is actually running)
 */
export function updateOutcomeMessage(lastResult, currentVersion) {
  if (!lastResult || typeof lastResult !== 'object' || lastResult.ok !== false) return null;
  const failedVersion = lastResult.version || '?';
  const d = lastResult.at ? new Date(lastResult.at) : null;
  const dateFragment = d && !Number.isNaN(d.getTime()) ? ' ' + formatRuDate(d) : '';
  const rolledTo = currentVersion || '?';
  const base = `Обновление до ${failedVersion} не удалось${dateFragment} — система вернулась к ${rolledTo} и работает. Мы попробуем снова после следующего одобрения.`;
  // apply-update.ps1's `db` vocabulary: only 'restored' means PATIENT DATA
  // itself was rolled back, not just code — material enough to a clinic
  // manager that it must never be buried in a console log they will never
  // open (see the plan's own "restoring it destroys anything entered since
  // the backup" warning).
  if (lastResult.db === 'restored') {
    return base + ' База данных также была восстановлена из резервной копии, сделанной перед обновлением.';
  }
  return base;
}

/**
 * Decide whether to show a one-time "what's new" note: `currentVersion` must
 * have actually CHANGED since the last version THIS BROWSER saw (persisted
 * in localStorage by the view — see updates.js's LAST_SEEN_KEY). A brand-new
 * install (no `lastSeenVersion` yet) has nothing to compare against and is
 * not shown a note about its own first boot.
 *
 * @param {string|null} currentVersion
 * @param {string|null} lastSeenVersion
 * @param {object} [offerNotesByVersion] — {version: notes_ru}, a small
 *   client-persisted cache the view fills in every time update_status
 *   returns an offer. It has to be cached in advance: the moment a version
 *   installs, ITS OWN offer/notes_ru is already gone or superseded by
 *   whatever comes next — nothing server-side still has yesterday's notes
 *   lying around by then.
 */
export function whatsNewState(currentVersion, lastSeenVersion, offerNotesByVersion) {
  if (!currentVersion) return { show: false, version: null, notes: null };
  if (!lastSeenVersion || lastSeenVersion === currentVersion) {
    return { show: false, version: currentVersion, notes: null };
  }
  const map = (offerNotesByVersion && typeof offerNotesByVersion === 'object' && !Array.isArray(offerNotesByVersion))
    ? offerNotesByVersion : {};
  const notes = typeof map[currentVersion] === 'string' && map[currentVersion] ? map[currentVersion] : null;
  return { show: true, version: currentVersion, notes };
}
