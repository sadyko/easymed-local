// TELEPHONY_V1 — the Binotel REST client (docs/plans/2026-08-23-binotel-telephony.md).
//
// Outbound HTTPS only — the same network posture as the Telegram bot: a LAN
// clinic with internet can poll Binotel; one without simply gets
// {ok:false, reason:'offline'} and tries again next tick.
//
// Two promises this module keeps, and why:
//   1. It NEVER throws. Every failure resolves to a FIXED reason vocabulary
//      (bad_credentials | offline | server_error | bad_response) so callers
//      switch on words, not on error classes — the checkin.js rule that a
//      flaky vendor must cost a skipped attempt, never a crashed loop.
//   2. It NEVER logs. The secret travels in the request body, so the only way
//      to be SURE no code path can leak it into a console (and from there
//      into a service log file) is for this file to write nothing at all.
//      Callers log the returned reason instead, which by construction
//      contains no request data. Pinned by the console-capture test.

import { readBounded } from '../control/checkin.js';

export const BINOTEL_API_BASE = 'https://api.binotel.com/api/4.0/';

// Phase 2 breadcrumb (per Binotel support's letter, 2026-08): click-to-call
// is one more method through this same client — 'internal-number-to-external-number'
// with {internalNumber, externalNumber} (key/secret merged the same way).
// Deliberately NOT implemented in Phase 1: no call management in scope.

// Bounds mirror control/checkin.js's own (see the comments there): a stats
// answer for one polling window is a few KB; 15s is generous for a JSON
// exchange but nothing like an unbounded hang; 1MB is the backstop against a
// misbehaving endpoint — enforced by the SAME readBounded that bounds
// check-in responses, one implementation, never two.
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1_000_000;

/**
 * One Binotel API call: POST https://api.binotel.com/api/4.0/<method>.json.
 *
 * @param {string} method  e.g. 'stats/all-incoming-calls-since'
 * @param {object} params  method parameters (e.g. {timestamp})
 * @param {object} opts    {key, secret, fetchImpl, timeoutMs, maxBytes} —
 *                         fetchImpl is DI so tests never touch the network.
 * @returns {Promise<{ok:true, data:object}|{ok:false, reason:string}>}
 */
export async function binotelCall(method, params, {
  key = '',
  secret = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
  maxBytes = MAX_BYTES,
} = {}) {
  let res;
  try {
    res = await fetchImpl(BINOTEL_API_BASE + method + '.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // key/secret merged into the JSON body — that IS Binotel's auth
      // contract (no headers, no query string), per the vendor docs cited in
      // the plan. Spread first so a params object can never override them.
      body: JSON.stringify({ ...params, key, secret }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // DNS failure, refused connection, timeout — all "somebody is
    // unreachable". Deliberately not distinguished further: the caller's only
    // remedy for every one of them is "try again later".
    return { ok: false, reason: 'offline' };
  }

  // 401/403 can only mean the credentials. Everything else the server did
  // wrong is its own class, so the settings screen can say "Binotel has a
  // problem" instead of blaming the admin's typing.
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'bad_credentials' };
  if (!res.ok) return { ok: false, reason: 'server_error' };

  let text;
  try { text = await readBounded(res, maxBytes); } catch { return { ok: false, reason: 'bad_response' }; }
  if (text === null) return { ok: false, reason: 'bad_response' };   // over the size bound — discarded unread

  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, reason: 'bad_response' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'bad_response' };

  // Binotel answers HTTP 200 with status:'success'|'error' in the BODY; a
  // wrong key is an in-body error, not a 401. Sniffing the message for
  // credential words is the only way to tell "bad key" from "their bug" at
  // HTTP 200 — fragile by nature, so anything unrecognised deliberately
  // defaults to server_error: under-accuse the admin, the same rule
  // control/gate.js applies to its locked messages.
  if (body.status !== 'success') {
    const msg = String(body.message || '');
    return { ok: false, reason: /key|secret|auth/i.test(msg) ? 'bad_credentials' : 'server_error' };
  }
  return { ok: true, data: body };
}
