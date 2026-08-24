// TELEPHONY_V1 — read/save for Settings → «Телефония».
//
// Database only, no role checks: the guard lives in rpc/telephony.js at the
// RPC boundary, where every other guard in this codebase stands — so the
// background poller, which has no `user`, can call this module too. The exact
// shape (and reasoning) of telegram/settings.js.

// TELEPHONY_ROUTING_V1 — listDispositions() below reads the routing table the
// CRM owns. READ ONLY, and through crm/config.js rather than a second SELECT
// of its own: crm_call_routing is keyed by (provider, disposition) there, and
// a private copy of that query here is how the two would drift the day a
// second PBX vendor arrives. Nothing in this file writes it — the storage
// model and crm_config_save's contract stay where they belong.
import { listRouting, DEFAULT_PROVIDER } from '../crm/config.js';

export class SettingsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const MIN_POLL_INTERVAL_SEC = 10;
export const MAX_POLL_INTERVAL_SEC = 3600;

export function readSettingsRow(db) {
  return db.prepare('SELECT * FROM telephony_settings WHERE id = 1').get();
}

// The ONLY settings shape that ever reaches the browser. The secret is not in
// it and cannot be: the RPC reports whether one is saved (api_secret_set),
// never the value — write-only semantics per the plan. The key is different:
// it is an account identifier, not a password, and the admin needs to see
// which account is wired up.
export function publicSettings(db) {
  const row = readSettingsRow(db) || {};
  return {
    enabled: !!row.enabled,
    provider: row.provider || 'binotel',
    api_key: row.api_key || '',
    api_secret_set: !!row.api_secret,
    poll_interval_sec: row.poll_interval_sec || 30,
    webhooks_enabled: !!row.webhooks_enabled,
    public_base_url: row.public_base_url || '',
    company_id: row.company_id || '',
    last_poll_at: row.last_poll_at || null,
    last_call_at: row.last_call_at || null,
    last_error: row.last_error || '',
    updated_at: row.updated_at || null,
  };
}

// Patch semantics: an absent field means "keep what is saved", so the screen
// can save one toggle without re-sending (and re-validating) everything else.
export function saveSettings(db, args = {}, userId = null) {
  const row = readSettingsRow(db);
  if (!row) throw new SettingsError('Настройки телефонии не инициализированы.', 500);

  const patch = {
    enabled: args.enabled === undefined ? row.enabled : (args.enabled ? 1 : 0),
    webhooks_enabled: args.webhooks_enabled === undefined ? row.webhooks_enabled : (args.webhooks_enabled ? 1 : 0),
    api_key: args.api_key === undefined ? row.api_key : String(args.api_key).trim().slice(0, 200),
    api_secret: row.api_secret,
    poll_interval_sec: row.poll_interval_sec,
    // Trailing slashes are stripped once, here, so URL-building call sites
    // (webhooks.js linkToCrmUrl, the screen's webhook-URL line) never have to
    // agree on who strips them.
    public_base_url: args.public_base_url === undefined
      ? row.public_base_url
      : String(args.public_base_url).trim().replace(/\/+$/, '').slice(0, 300),
    // Binotel's Company ID for this clinic — settings data by decree (the
    // vendor issues a different one to every customer), used by webhooks.js
    // as a tenant check. Stored as text: it is an identifier, not a number.
    company_id: args.company_id === undefined ? row.company_id : String(args.company_id).trim().slice(0, 50),
  };

  // Secret: '' (or null) means "keep what is saved", a non-empty string
  // replaces it. The masked password-style field posts '' on an ordinary
  // save, and that must never wipe a working secret — the classic
  // empty-password-field bug telegram/settings.js documents for its token.
  if (args.api_secret !== undefined && args.api_secret !== null && String(args.api_secret).trim() !== '') {
    patch.api_secret = String(args.api_secret).trim().slice(0, 200);
  }

  if (args.poll_interval_sec !== undefined) {
    const n = Number(args.poll_interval_sec);
    if (!Number.isFinite(n)) throw new SettingsError('Интервал опроса — это число секунд.');
    // Clamped, not refused — checkinIntervalMs's rule: a typo must degrade to
    // a sane pace, never to hammering Binotel (floor) or to a poller that
    // looks alive but answers hourly (ceiling).
    patch.poll_interval_sec = Math.min(MAX_POLL_INTERVAL_SEC, Math.max(MIN_POLL_INTERVAL_SEC, Math.floor(n)));
  }

  // Turning polling on without credentials would show «включено» over a
  // poller with nothing to poll with — the same honesty rule as the telegram
  // bot's enable-without-token refusal.
  if (patch.enabled && (!patch.api_key || !patch.api_secret)) {
    throw new SettingsError('Сначала введите ключ и секрет Binotel, потом включайте опрос.');
  }

  db.prepare(`UPDATE telephony_settings SET
      enabled = @enabled, webhooks_enabled = @webhooks_enabled,
      api_key = @api_key, api_secret = @api_secret,
      poll_interval_sec = @poll_interval_sec, public_base_url = @public_base_url,
      company_id = @company_id,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = @updated_by
    WHERE id = 1`).run({ ...patch, updated_by: userId });

  return publicSettings(db);
}

// Server-only: the poller and «Проверить подключение» need the real secret.
// Never called from anything that builds an HTTP response.
export function getCredentials(db) {
  const row = readSettingsRow(db) || {};
  return { key: row.api_key || '', secret: row.api_secret || '' };
}

// The poller's proof-of-life, written after EVERY attempt: last_poll_at says
// "the loop is alive", last_error says what went wrong ('' = nothing). The
// error is one word from binotel.js's fixed vocabulary — the screen maps it
// to a human sentence, so nothing request-shaped can ever land here.
export function recordPoll(db, { ok, error = '' } = {}) {
  db.prepare(`UPDATE telephony_settings SET
      last_poll_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      last_error = @error
    WHERE id = 1`).run({ error: ok ? '' : String(error || '').slice(0, 300) });
}

// Newest call the system has seen, from either source. MAX, not overwrite:
// the poller re-reads a 120s overlap window and a webhook can deliver an
// older call after a newer one was polled — the status line must never move
// backwards. ISO-8601 UTC strings compare correctly as text.
export function noteCallSeen(db, startedAtIso) {
  db.prepare(`UPDATE telephony_settings SET
      last_call_at = CASE WHEN last_call_at IS NULL OR last_call_at < @t THEN @t ELSE last_call_at END
    WHERE id = 1`).run({ t: String(startedAtIso) });
}

// --------------------------------------------------------------------------
// TELEPHONY_ROUTING_V1 — which call outcomes this clinic actually has
// (docs/plans/2026-08-24-telephony-owns-its-routing.md, task 3)
// --------------------------------------------------------------------------

/**
 * Every call outcome the «Звонки → заявки» card must offer, merged from the
 * only two honest sources there are:
 *
 *   OBSERVED   — what this clinic's own PBX has actually reported (the calls
 *                table). Binotel publishes no "list every disposition"
 *                endpoint, so this is the real answer to «какие статусы мы
 *                получаем», and it costs no API call.
 *   DOCUMENTED — the vendor list already seeded into crm_call_routing, so a
 *                rule can be set for an outcome BEFORE it happens once.
 *
 * Each row carries its own current rule, so the screen needs ONE call rather
 * than a second read it would have to join in the browser.
 *
 * `documented` answers both of the screen's questions at once, and that is not
 * a shortcut: the documented list IS the seeded routing table, so «the vendor
 * documented it» and «a rule row exists for it» are the same fact. A false
 * here therefore means BOTH «Binotel invented this one after the install» and
 * «no rule yet» — which is exactly the row the card badges «новое».
 *
 * @returns {{disposition:string, seen_count:number, last_seen_at:string|null,
 *            documented:boolean, action:'create'|'ignore', stage_key:string|null}[]}
 */
export function listDispositions(db, provider) {
  // Which PBX the clinic runs — data, not a constant (leadFromCall reads the
  // same field for the same reason: a rule is keyed by (provider, disposition),
  // so 'ANSWER' can mean different things to different vendors).
  const row = readSettingsRow(db);
  const prov = String(provider || (row && row.provider) || DEFAULT_PROVIDER);

  // UPPER + TRIM, and grouped by the same expression: leadFromCall uppercases
  // the disposition before it looks the rule up, and saveRouting stores it
  // uppercased — so «answer» and «ANSWER» are ONE rule. Two rows here would
  // offer the owner a second rule that can never fire.
  //
  // The empty disposition is excluded: calls.disposition DEFAULTs to '' (mig
  // 076) for a call recorded before it ended, and DISPOSITION_RE forbids an
  // empty key — a rule for it could not be saved even if it were offered.
  const observed = db.prepare(`
    SELECT UPPER(TRIM(disposition)) AS disposition,
           COUNT(*)                 AS seen_count,
           MAX(started_at)          AS last_seen_at
      FROM calls
     WHERE TRIM(disposition) <> ''
     GROUP BY UPPER(TRIM(disposition))`).all();

  const byCode = new Map();
  for (const r of observed) {
    byCode.set(r.disposition, {
      disposition: r.disposition,
      seen_count: Number(r.seen_count) || 0,
      last_seen_at: r.last_seen_at || null,
      // Until a rule is found below, an outcome nobody has configured creates
      // nothing. That is leadFromCall's own behaviour for a rule it does not
      // have — the card must show what the system actually does, not a
      // friendlier guess.
      documented: false,
      action: 'ignore',
      stage_key: null,
    });
  }

  for (const rule of listRouting(db, prov)) {
    const code = String(rule.disposition || '').trim().toUpperCase();
    if (!code) continue;
    const seen = byCode.get(code);
    byCode.set(code, {
      disposition: code,
      seen_count: seen ? seen.seen_count : 0,
      last_seen_at: seen ? seen.last_seen_at : null,
      documented: true,
      action: rule.action === 'create' ? 'create' : 'ignore',
      stage_key: rule.stage_key || null,
    });
  }

  // Outcomes this clinic actually GETS come first, busiest first: those are
  // the rules worth setting. Everything unseen has seen_count 0, so the same
  // comparison sinks it — sorted alphabetically among itself so the order is
  // stable between loads (a list that reshuffles itself reads as broken).
  return [...byCode.values()].sort((a, b) => (a.seen_count !== b.seen_count)
    ? b.seen_count - a.seen_count
    : a.disposition.localeCompare(b.disposition));
}
