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

/**
 * UPDATES_I18N_V1 (2026-08-30) — put the values back into a template AFTER
 * tr() has translated it.
 *
 * tr() (i18n.js) looks up the WHOLE string in STRINGS, so a sentence built by
 * concatenation — `'У вас последняя версия' + ' — ' + v + '.'` — can never
 * match a dictionary key and shipped in Russian to every clinic whatever
 * language they had picked. That is the bug the owner photographed on
 * 2026-08-29: a fully Uzbek screen with a Russian status line under it.
 *
 * So every dynamic sentence below returns a TEMPLATE — the complete Russian
 * phrase with `{name}` holes still in it, which IS its dictionary key — plus
 * the values to put back. The view calls tr(template) first, fill() second.
 * Precedent: branch-picker.js already does `.replace('{n}', …)` on a
 * translated string.
 *
 * A placeholder with no matching value is left standing rather than blanked:
 * a translation that misspells `{versoin}` must look obviously broken to
 * whoever reads it, not silently swallow the version number.
 */
export function fill(template, params) {
  let out = String(template == null ? '' : template);
  if (!params) return out;
  for (const [key, value] of Object.entries(params)) {
    out = out.split('{' + key + '}').join(String(value));
  }
  return out;
}

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
 * «У вас последняя версия — 0.4.5.» — THE line from the owner's 2026-08-29
 * screenshot: an Uzbek screen («Tizim», «Yangilanishlarni tekshirish»,
 * «Joriy versiya») with this one sentence still in Russian, because the view
 * concatenated it instead of handing tr() a whole string.
 *
 * Two templates, not one with an empty hole: a clinic whose server has not
 * reported a version yet gets a sentence that reads properly in every
 * language instead of «У вас последняя версия —  .»
 *
 * @param {string|null} currentVersion
 * @returns {{template: string, params: object}}
 */
export function upToDateMessage(currentVersion) {
  return currentVersion
    ? { template: 'У вас последняя версия — {version}.', params: { version: currentVersion } }
    : { template: 'У вас последняя версия.', params: {} };
}

/**
 * The confirmation sentence once an hour is approved — «Обновление
 * установится <date> в <hour>:00. Компьютер должен быть включён.»
 *
 * UPDATES_I18N_V1 — returns a {template, params} DESCRIPTOR, not a finished
 * string. It used to concatenate the date straight into Russian, and that is
 * exactly why an Uzbek clinic read this line in Russian: tr() matches whole
 * strings only. The template is the dictionary key; see fill() above.
 *
 * @param {{hour: number|null, scheduled_at: string|null}} consent — the
 *   relevant slice of update_status's response (hour/scheduled_at sit at
 *   its top level, not nested under a "consent" key — this parameter name
 *   describes what they MEAN, not their literal shape on the wire).
 * @returns {{template: string, params: object}|null} null when nothing is
 *   actually scheduled
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
    // No placeholders at all — a fully literal sentence is still returned as
    // a descriptor so the view has ONE code path for every message.
    return { template: 'Обновление устанавливается. Обычно это занимает несколько минут — не выключайте компьютер.', params: {} };
  }
  if (hour == null || !scheduledAt) return null;
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return null;
  return {
    template: 'Обновление установится {date} в {hour}. Компьютер должен быть включён.',
    params: { date: formatRuDate(d), hour: formatRuHour(hour) },
  };
}

/**
 * The plain, unavoidable notice for a failed-and-rolled-back update — «a
 * clinic must not discover from the vendor that its update failed» (the
 * plan's own words). Never fires for a SUCCESSFUL last_result — that is
 * whatsNewState()'s job below, not this one's.
 *
 * `lastResult` is the updater's own outcome file, `data/update-result.json`
 * (server/services/control/updater.js, `writeOutcome`): `{version, from, ok,
 * db, at, detail}`. The shape is unchanged from the retired apply-update.ps1's
 * `Write-UpdateOutcome` on purpose — files that script wrote still sit on
 * clinic disks and must keep rendering. Every field but `ok` is treated as
 * possibly-missing/malformed: a corrupt or half-written outcome file must
 * never crash this screen (same defensive posture as updates.js's own
 * readLastResult()).
 *
 * UPDATES_I18N_V1 — a {template, params, extra} descriptor, see fill().
 *
 * TWO templates rather than one with an optional `{date}` hole: a date
 * fragment that is sometimes empty forces every translator to guess where a
 * blank belongs in their own word order, and Uzbek does not put it where
 * Russian does. Two complete phrases translate cleanly; there are only two.
 *
 * @param {object|null} lastResult
 * @param {string|null} currentVersion  what update_status.current_version says NOW — the version the clinic rolled back TO, not `lastResult.from` (the server is the live source of truth for what is actually running)
 * @returns {{template: string, params: object, extra: string|null}|null}
 */
export function updateOutcomeMessage(lastResult, currentVersion) {
  if (!lastResult || typeof lastResult !== 'object' || lastResult.ok !== false) return null;
  const d = lastResult.at ? new Date(lastResult.at) : null;
  const dated = !!(d && !Number.isNaN(d.getTime()));
  const params = {
    version: lastResult.version || '?',
    current: currentVersion || '?',
  };
  if (dated) params.date = formatRuDate(d);
  // The outcome file's `db` vocabulary: only 'restored' means PATIENT DATA
  // itself was rolled back, not just code — material enough to a clinic
  // manager that it must never be buried in a console log they will never
  // open (see the plan's own "restoring it destroys anything entered since
  // the backup" warning). Nothing produces 'restored' any more — the Node
  // apply never touches the database, it only snapshots it before switching —
  // but old outcome files on clinic disks still can, so this stays.
  //
  // Carried as `extra` — a SEPARATE, complete sentence with its own
  // dictionary entry — rather than doubling the number of templates above.
  const extra = lastResult.db === 'restored'
    ? 'База данных также была восстановлена из резервной копии, сделанной перед обновлением.'
    : null;
  return {
    template: dated
      ? 'Обновление до {version} не удалось {date} — система вернулась к {current} и работает. Мы попробуем снова после следующего одобрения.'
      : 'Обновление до {version} не удалось — система вернулась к {current} и работает. Мы попробуем снова после следующего одобрения.',
    params,
    extra,
  };
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
/**
 * Numeric-per-segment version compare — the SAME rule the server's
 * bundle.js and build-bundle.mjs use, restated here because the frontend
 * cannot import server modules. A string compare gets 0.10.0 vs 0.9.0
 * backwards, which is exactly the case this function exists to get right.
 *
 * @returns {number} <0 if a is older, 0 if equal, >0 if a is newer
 */
export function compareVersions(a, b) {
  const parts = (v) => String(v || '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * «Установлено, но ещё не работает» — the notice for an update that applied
 * successfully while the OLD code is still the running process.
 *
 * This was the normal launcher case: the retired apply-update.ps1 repointed
 * the `current` junction, but a launcher install has no Windows service to
 * stop and start, so the already-running Node kept serving the previous
 * version until the Easy-Med window was closed and reopened. Without this
 * message the screen showed the OLD version number and no explanation — which
 * is indistinguishable from the update having failed, and cost the owner a
 * day of "why is nothing updating?" on 2026-08-24.
 *
 * KEPT although applyUpdate() now exits 75 and the launcher relaunches within
 * seconds: a clinic mid-upgrade (still on a version whose updater was the
 * PowerShell one), or one whose window was closed at exactly the wrong moment,
 * still lands here — and this message is the only thing that tells them the
 * update worked.
 *
 * Deliberately requires the finished version to be NEWER than the running
 * one, not merely different: a stale result file from an older update (the
 * clinic has since moved past it) must not claim a restart is pending.
 *
 * UPDATES_I18N_V1 — a {template, params} descriptor, see fill().
 *
 * @param {object|null} lastResult   the updater's outcome file
 * @param {string|null} currentVersion  what the running server reports
 * @returns {{template: string, params: object}|null}
 */
export function pendingRestartMessage(lastResult, currentVersion) {
  if (!lastResult || typeof lastResult !== 'object' || lastResult.ok !== true) return null;
  const installed = typeof lastResult.version === 'string' ? lastResult.version : '';
  if (!installed || !currentVersion) return null;
  if (compareVersions(installed, currentVersion) <= 0) return null;
  return {
    template: 'Обновление до {version} установлено. Чтобы оно заработало, закройте окно Easy-Med и откройте его снова.',
    params: { version: installed },
  };
}
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

// ---------------------------------------------------------------------------
// UPDATE_PROGRESS_V1 (2026-08-30, owner: «can we show status of the
// downloading of the last update please fix that») — turning the server's
// progress record into the words on the screen.
//
// The screen used to jump from «Доступно обновление» straight to «установлено»
// with nothing in between, so a clinic on a slow line could not tell a 40 MB
// download from a hung socket. Everything below is the DECISION half of the
// answer; views/updates.js only builds DOM from it.
//
// The record's shape is written by server/services/control/update-progress.js:
// {version, phase, bytes, total, started_at, at, age_ms, reason}. `total` is
// null whenever the server sent no Content-Length — that case is not an error
// and must never become a made-up percentage.
// ---------------------------------------------------------------------------

/**
 * How long a record may sit unchanged before this screen stops calling it
 * progress. MIRRORS update-progress.js's STALL_MS — same "mirror, never
 * import" situation as nextRunAtLocal above: server/ is not reachable from a
 * browser module. Progress writes are throttled to ~2s server-side, so 90s of
 * silence is not a slow line, it is a socket that stopped delivering. That
 * distinction IS the owner's question: slow, or stuck?
 */
export const PROGRESS_STALL_MS = 90 * 1000;

const MB = 1024 * 1024;

/** Megabytes, one decimal — enough resolution for a bundle, and no locale-specific decimal comma to get wrong in three languages. */
export function formatMb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0.0';
  return (n / MB).toFixed(1);
}

// The five phases runPipeline reports, in order, each as ONE complete
// sentence — tr() looks up whole strings, so a phase name assembled from
// fragments would be exactly the untranslatable shape this whole change
// exists to remove.
const PHASE_DETAIL = {
  verifying: 'Проверка подписи обновления…',
  unpacking: 'Распаковка файлов…',
  snapshot: 'Резервная копия базы данных…',
  switching: 'Переключение на новую версию…',
};
const LIVE = new Set(['downloading', 'verifying', 'unpacking', 'snapshot', 'switching']);

/**
 * Everything the progress card shows, or {show:false} when there is nothing
 * honest to say.
 *
 * @param {object|null} progress  update_status.progress, verbatim
 * @param {object} [opts]
 * @param {number} [opts.stallMs]
 * @returns {{show: boolean, phase: string|null, tone: 'busy'|'warn',
 *   stalled: boolean, percent: number|null,
 *   title: {template: string, params: object}|null,
 *   detail: {template: string, params: object}|null,
 *   note: {template: string, params: object}|null}}
 */
export function progressView(progress, { stallMs = PROGRESS_STALL_MS } = {}) {
  const none = { show: false, phase: null, tone: 'busy', stalled: false, percent: null, title: null, detail: null, note: null };
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return none;
  const phase = typeof progress.phase === 'string' ? progress.phase : null;
  if (!phase) return none;

  const version = progress.version || '?';
  const title = { template: 'Устанавливается обновление {version}', params: { version } };

  // ── The two terminal states a clinic still needs told about ──────────────
  if (phase === 'interrupted') {
    // Written by reconcileProgressAtBoot: the update was mid-flight when the
    // process ended. Said plainly, because the alternative the owner would
    // otherwise see is a frozen bar — "worse than nothing".
    return {
      ...none, show: true, phase, tone: 'warn',
      title: { template: 'Обновление {version} не завершилось', params: { version } },
      note: { template: 'Установка прервалась — компьютер или программа были выключены. Мы попробуем снова.', params: {} },
    };
  }
// UPDATE_FAILURE_REASON_V1 - say WHAT went wrong.
//
// Раньше на любой отказ печаталось «проверьте подключение к интернету» —
// одиннадцать разных причин под одной фразой. Владелец 2026-09-02 читал совет
// проверить интернет на машине, которая в ту же минуту исправно ходила на
// сервер каждую минуту. Совет, который нельзя выполнить, хуже молчания: он
// отправляет чинить исправное и прячет сломанное.
//
// Причина у нас уже есть (update-progress.js кладёт её в record.reason) — её
// просто выбрасывали. Неизвестная причина по-прежнему сводится к общей фразе:
// придумывать объяснение опаснее, чем признать, что его нет.
const FAIL_NOTE = {
  network:          'Не удалось скачать обновление — связь прервалась. Мы попробуем снова.',
  http_status:      'Сервер обновлений ответил отказом. Мы попробуем снова; если это повторится, сообщите в Easy-Med.',
  too_large:        'Обновление оказалось больше допустимого — мы его не приняли. Сообщите в Easy-Med.',
  disk:             'На диске не хватило места для обновления. Освободите место, и мы попробуем снова.',
  stream_error:     'Загрузка оборвалась на середине. Мы попробуем снова.',
  no_body:          'Сервер обновлений прислал пустой ответ. Мы попробуем снова.',
  manifest_write:   'Не удалось записать файлы обновления — проверьте место на диске и права доступа.',
  bundle_refused:   'Обновление не прошло проверку подлинности и не было установлено. Сообщите в Easy-Med.',
  version_mismatch: 'Обновление не совпало с обещанной версией и не было установлено. Сообщите в Easy-Med.',
  unpack:           'Не удалось распаковать обновление — проверьте место на диске. Мы попробуем снова.',
};

function failNote(reason) {
  const key = typeof reason === 'string' ? reason : '';
  return FAIL_NOTE[key] || 'Не удалось установить обновление. Мы попробуем снова.';
}

  if (phase === 'failed') {
    return {
      ...none, show: true, phase, tone: 'warn',
      title: { template: 'Обновление {version} не установилось', params: { version } },
      note: { template: failNote(progress.reason), params: {} },
    };
  }
  if (!LIVE.has(phase)) return none;   // an unknown phase from a newer server: say nothing rather than something wrong

  // ── In flight ────────────────────────────────────────────────────────────
  const bytes = Number.isFinite(Number(progress.bytes)) ? Number(progress.bytes) : 0;
  const total = Number.isFinite(Number(progress.total)) && Number(progress.total) > 0 ? Number(progress.total) : null;
  const age = Number.isFinite(Number(progress.age_ms)) ? Number(progress.age_ms) : null;
  const stalled = age != null && age > stallMs;

  let detail = null;
  let percent = null;
  if (phase === 'downloading') {
    if (total) {
      // Clamped: a server whose Content-Length disagrees with what it
      // actually sent must not produce «загружено 143%».
      percent = Math.max(0, Math.min(100, Math.floor((bytes / total) * 100)));
      detail = { template: 'Загружено {done} МБ из {total} МБ', params: { done: formatMb(bytes), total: formatMb(total) } };
    } else {
      // No Content-Length — an honest byte count and NO bar. A percentage
      // that cannot exist is the one thing this must never invent.
      detail = { template: 'Загружено {done} МБ', params: { done: formatMb(bytes) } };
    }
  } else {
    detail = { template: PHASE_DETAIL[phase], params: {} };
  }

  return {
    show: true, phase, tone: stalled ? 'warn' : 'busy', stalled, percent, title, detail,
    note: stalled
      ? { template: 'Ничего не происходит уже несколько минут — возможно, пропала связь. Мы попробуем снова.', params: {} }
      : null,
  };
}
