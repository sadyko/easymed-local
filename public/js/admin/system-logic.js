// SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md, Task 3) — every
// display/validation DECISION behind the Settings → «Система» cards
// (views/updates.js and its sibling card modules views/system-*.js), as pure
// functions: no DOM, no clock of their own, no network — the same contract as
// updates-logic.js next door, and for the same reason: these are the parts
// worth unit-testing without a fake DOM (see system-logic.test.js).
//
// The server side (server/services/backup.js + the four RPCs) is being built
// in parallel to the SAME plan, so every function here treats its input as
// possibly-thinner than the contract promises: a missing clinic_id, a listing
// without sizes, a kind nobody taught it — all degrade to an em-dash or a
// calm fallback, never a throw and never "undefined" on a clinic's screen.

import { formatRuDate } from './updates-logic.js';

/** The em-dash the whole app renders for "we do not know" — one constant so a test can assert the exact character. */
export const DASH = '—';

function pad2(n) { return String(n).padStart(2, '0'); }

/** Accepts ms-since-epoch, an ISO string, or a Date; null when unparseable. */
function toDate(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** DD.MM.YYYY HH:mm — the clinic-facing timestamp (formatRuDate plus the time backups actually differ by: two backups on one day are told apart by the hour). */
export function formatRuDateTime(v) {
  const d = toDate(v);
  if (!d) return null;
  return `${formatRuDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Human file size, Russian units, comma decimal. One decimal only under 10
 * of a unit (where it carries real information: "1,2 МБ" vs "1 МБ"), whole
 * numbers above. Garbage/negative/missing → em-dash, never "NaN Б" — the
 * parallel-built server may omit `size` entirely.
 */
export function formatBytes(n) {
  const v = typeof n === 'number' ? n : (typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN);
  if (!Number.isFinite(v) || v < 0) return DASH;
  if (v < 1024) return `${Math.round(v)} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let val = v;
  let i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  const s = val < 10 ? val.toFixed(1).replace('.', ',').replace(/,0$/, '') : String(Math.round(val));
  return `${s} ${units[i]}`;
}

/**
 * The backup kind, preferring the server's own `kind` field and falling back
 * to the filename prefix — the same prefix rule server/services/backup.js
 * derives kinds from (`<kind>-YYYYMMDD-HHmmss.db`), so a listing from an
 * older server that has no `kind` field yet still classifies identically.
 */
export function backupKind(row) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.kind === 'string' && row.kind) return row.kind;
  if (typeof row.name === 'string') {
    const m = /^([a-z]+)-/.exec(row.name);
    if (m) return m[1];
  }
  return null;
}

// Human words for the plan's five filename-prefix kinds, plus `replaced-`
// (what processPendingAction moves the live DB aside as during a restore —
// it lands in the same backups/ directory, so the listing will show it).
// Static Russian literals: they render through h(), whose text-child path
// runs tr(), so the ru/uz/en entries live in i18n-strings.js.
const KIND_LABELS = {
  pre:      'перед обновлением',
  daily:    'ежедневная',
  manual:   'ручная',
  safety:   'страховочная (перед восстановлением)',
  final:    'перед удалением данных',
  replaced: 'заменённая при восстановлении',
};

/**
 * Kind → human label. An UNKNOWN kind shows its raw kind string rather than
 * the em-dash: a future server may add a sixth prefix, and "какая-то копия
 * без подписи" hides information the admin can act on, while the raw word
 * ("weekly") at least identifies the file.
 */
export function backupKindLabel(kind) {
  if (!kind || typeof kind !== 'string') return DASH;
  return KIND_LABELS[kind] || kind;
}

/** DD.MM.YYYY HH:mm for a backup row's mtime; em-dash when the server sent none. */
export function backupDateLabel(mtimeMs) {
  return formatRuDateTime(mtimeMs) || DASH;
}

/**
 * backup_list's reply → a safe array, newest first. The plan promises
 * `[{name, kind, size, mtimeMs}]` but leaves the RPC free to wrap it (a
 * free-space note travels with the listing), so both a bare array and
 * `{backups: [...]}` are accepted; anything else — including the `{}` an
 * older server answers before the RPC exists — degrades to an empty list.
 * Rows without a string `name` are dropped: name is the restore key, and a
 * row that cannot be restored must not offer the button.
 */
export function normalizeBackupList(data) {
  const arr = Array.isArray(data) ? data
    : (data && Array.isArray(data.backups)) ? data.backups
      : [];
  return arr
    .filter((r) => r && typeof r === 'object' && typeof r.name === 'string' && r.name !== '')
    .slice()
    // Newest first even though the server promises that order — a defensive
    // re-sort costs nothing and the table's whole meaning is "most recent
    // state on top". Missing mtimeMs sinks to the bottom, not the top.
    .sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0));
}

/**
 * The quiet free-space line under the backups table — backup_list's reply
 * carries `free_bytes` when the platform could answer cheaply (the RPC's own
 * comment: a courtesy note, never a fact the feature depends on). Null when
 * absent/garbage: no line at all beats «Свободно на диске: —». Dynamic
 * Russian by concatenation, the house no-placeholder convention.
 */
export function freeSpaceNote(data) {
  // Only a real number counts — Number(null) is 0 (the same trap
  // updates-logic.js's coerceHour documents), and a server that answered
  // free_bytes:null must produce NO line, not «Свободно на диске: 0 Б».
  const free = data && typeof data === 'object' && typeof data.free_bytes === 'number'
    ? data.free_bytes : NaN;
  if (!Number.isFinite(free) || free < 0) return null;
  return `Свободно на диске: ${formatBytes(free)}`;
}

/**
 * The typed-confirmation rule for the factory reset: exactly «УДАЛИТЬ»,
 * surrounding whitespace forgiven (an invisible trailing space must not
 * gaslight a frightened admin), case and lookalikes NOT forgiven — the
 * server re-checks the same exact word (factory_reset's own rule is the
 * real one; this one exists so the mismatch is caught BEFORE the scary
 * click, not after).
 */
export function confirmWordOk(input) {
  return typeof input === 'string' && input.trim() === 'УДАЛИТЬ';
}

/** DD.MM.YYYY for licence valid_until (ISO or ms); em-dash when the server has not learned to send it yet. */
export function validUntilLabel(v) {
  const d = toDate(v);
  return d ? formatRuDate(d) : DASH;
}

/**
 * The «Действует до» line: date and days-left folded into ONE honest string,
 * shaped by what the server actually delivered:
 *   both        → «12.09.2026 — осталось 22 дн.»
 *   only days   → «осталось 22 дн.»   (valid_until not shipped yet)
 *   only date   → «12.09.2026»        (locked: days_left is 0, saying
 *                                      "осталось 0 дн." next to a date reads
 *                                      like a countdown, not a fact)
 *   neither     → em-dash
 * Dynamic Russian, built by concatenation — the same no-placeholder
 * convention as updates-logic.js's formatScheduled().
 */
export function validityLabel(lic) {
  if (!lic || typeof lic !== 'object') return DASH;
  const until = validUntilLabel(lic.valid_until);
  const days = Number(lic.days_left);
  const hasDays = Number.isFinite(days) && days > 0;
  if (until !== DASH && hasDays) return `${until} — осталось ${Math.floor(days)} дн.`;
  if (until !== DASH) return until;
  if (hasDays) return `осталось ${Math.floor(days)} дн.`;
  return DASH;
}

/** DD.MM.YYYY HH:mm of the last successful check-in; em-dash before the first one (or before the server ships the field). */
export function lastCheckinLabel(v) {
  return formatRuDateTime(v) || DASH;
}

/** Plain value-or-dash for identity fields (clinic name, clinic id) the extended licence_status may not carry yet. */
export function dashWhenEmpty(v) {
  return (v == null || v === '') ? DASH : String(v);
}

/**
 * The status badge: state+reason → tag kind + wording, mirroring the exact
 * reason distinctions the ladder and activation screen already make — above
 * all the rule that a PAID clinic whose router died is never told it owes
 * money (reason defaults to 'offline' server-side when unsure; see
 * control/ladder.js's own comment). Kinds are ui.js Tag() vocabulary.
 * Dynamic day-count labels are code-built Russian (banner convention in
 * admin.js renderLicenceBanner); the static ones live in i18n-strings.js.
 */
export function subscriptionBadge(lic) {
  if (!lic || typeof lic !== 'object') return { kind: '', label: DASH };
  if (lic.reason === 'not_enrolled') return { kind: 'warn', label: 'Не активирована' };
  // Same `=== true` strictness as licence.js's isLicensed(): only a real
  // boolean true reads as locked, garbage falls through to the state ladder.
  if (lic.locked === true) {
    if (lic.reason === 'unpaid') return { kind: 'crit', label: 'Подписка не активна' };
    if (lic.reason === 'unlicensed') return { kind: 'crit', label: 'Лицензия недействительна' };
    return { kind: 'crit', label: 'Нет связи с Easy-Med — система заблокирована' };
  }
  if (lic.state === 'warn' || lic.state === 'notice') {
    // Floor at 1, same defensive rule as renderLicenceBanner: these rungs are
    // structurally days>0, but a malformed payload must never print «0 дн.».
    const days = Math.max(1, Number(lic.days_left) || 0);
    const label = lic.reason === 'unpaid'
      ? `Подписка заканчивается через ${days} дн.`
      : `Нет связи с Easy-Med ${days} дн.`;
    return { kind: lic.state === 'warn' ? 'warn' : 'info', label };
  }
  // 'ok' — and also the pre-RPC 'unknown' fallback licence.js serves before
  // boot finishes: the badge follows what the rest of the app is already
  // telling the user (no banner, everything open), not a scarier guess.
  return { kind: 'ok', label: 'Подписка активна' };
}

// The modules this card lists by name — the CLIENT's sales vocabulary, same
// two keys as licensed-modules.js (marketing is deliberately absent there
// and therefore here: no screen exists to grant; see that file's own
// comment). Short nouns, not licensed-modules' benefit-led pitch titles —
// this is a settings inventory, not a sales surface.
const MODULE_VOCAB = [
  { key: 'crm', label: 'CRM и call-центр' },
  { key: 'telegram', label: 'Telegram-бот для пациентов' },
];

/**
 * The subscription card's module rows: the known vocabulary first, each
 * marked enabled/absent, then any GRANTED key the vocabulary does not know
 * (a vendor can grant ahead of this client's release — a paid-for module
 * must never be invisible, even if all we can print is its raw key).
 * A malformed `modules` (string, null — seen from hand-edited licences,
 * see licence.js) reads as "nothing enabled", never a throw.
 */
export function moduleRows(modules) {
  const enabled = Array.isArray(modules) ? modules.filter((k) => typeof k === 'string') : [];
  const rows = MODULE_VOCAB.map(({ key, label }) => ({ key, label, enabled: enabled.includes(key) }));
  for (const key of enabled) {
    if (!MODULE_VOCAB.some((m) => m.key === key)) rows.push({ key, label: key, enabled: true });
  }
  return rows;
}

/**
 * The EM- code entry belongs on the settings card ONLY while licence_status
 * says not enrolled — after a factory reset the first-run screen owns entry
 * (the plan's own rule), and an enrolled clinic re-typing a code would only
 * earn licence_enroll's `already_enrolled` refusal.
 */
export function enrollFormVisible(lic) {
  return !!(lic && lic.reason === 'not_enrolled');
}

/**
 * DD.MM.YYYY for module_request's requested_at — same 'ru-RU' rendering as
 * locked-module.js's formatRequestDate (kept in the same shape so the two
 * screens print the same request on the same day identically).
 */
export function requestDateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU');
}
