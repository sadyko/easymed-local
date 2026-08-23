// TELEPHONY_V1 — read/save for Settings → «Телефония».
//
// Database only, no role checks: the guard lives in rpc/telephony.js at the
// RPC boundary, where every other guard in this codebase stands — so the
// background poller, which has no `user`, can call this module too. The exact
// shape (and reasoning) of telegram/settings.js.

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
