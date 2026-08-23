// TELEPHONY_V1 — Binotel's two webhook receivers (call ringing / call done).
//
// Mounted in app.js at /api/telephony/binotel BEFORE session auth, the same
// slot as /api/auth: Binotel sends no cookies, so anything behind requireAuth
// would 401 every real webhook. The router does its own gating instead —
// settings toggle, licensed module, source-IP allowlist, Company ID — and
// every refusal is the SAME non-advertising 404 the app gives unknown /api
// paths: an endpoint that answered 403 would be telling the internet that a
// telephony receiver lives here.
//
// Bodies arrive as application/x-www-form-urlencoded, NOT JSON — corrected
// mid-build by Binotel support's letter to the owner (2026-08), which
// outranks the archived docs where they differ. The urlencoded parser is
// mounted here with extended:true so their bracket keys
// (callDetails[generalCallID]) nest into an object; JSON is still accepted
// defensively because the /api-level parser already handled it before the
// letter arrived, and a vendor that switches formats must not break us.

import express, { Router } from 'express';
import { readSettingsRow } from './settings.js';
import { recordCall } from './poller.js';
import { findPatientsByPhone } from '../telegram/documents.js';

// The vendor's published webhook source addresses.
//
// SOURCE: developers.binotel.ua — the security note on the API CALL SETTINGS
// WebHook page ("accept requests only from IP addresses of Binotel servers",
// ~26 addresses; the archived 2024-05-20 copy is what the plan studied).
// Pasted 2026-08-23 from the archived vendor docs the owner supplied
// (web.archive.org/web/20240520185732/http://developers.binotel.ua): all 26
// addresses of the «принимайте запросы … только с серверов Binotel» note,
// verbatim. If Binotel ever announces new addresses, THIS array is the only
// place they go. Polling, the normal mode for a local install, does not
// depend on this list at all.
//
// THIS ARRAY IS THE ONLY PLACE THE ADDRESSES GO. Never a settings row: an
// allowlist an operator can edit from a screen is an allowlist an attacker
// with the admin password can edit too. The co-located test pins the shape
// (frozen, IPv4 dotted-quads only) so pasted garbage screams immediately.
export const BINOTEL_SOURCE_IPS = Object.freeze([
  '194.88.218.114', '194.88.218.116', '194.88.218.117', '194.88.218.118',
  '194.88.218.119', '194.88.218.120',
  '194.88.219.67', '194.88.219.70', '194.88.219.71', '194.88.219.72',
  '194.88.219.78', '194.88.219.79', '194.88.219.80', '194.88.219.81',
  '194.88.219.82', '194.88.219.83', '194.88.219.84', '194.88.219.85',
  '194.88.219.86', '194.88.219.87', '194.88.219.88', '194.88.219.89',
  '194.88.219.92',
  '185.100.66.145', '185.100.66.146', '185.100.66.147',
]);

// Byte-identical to app.js's unknown-endpoint answer ON PURPOSE — see the
// header: a refusal must be indistinguishable from the endpoint not existing.
const NOT_FOUND = { error: { code: 'not_found', message: 'Unknown API endpoint.' } };

// Node reports IPv4 peers on a dual-stack socket as '::ffff:a.b.c.d'; the
// allowlist speaks plain IPv4, so the mapped prefix is stripped before
// comparing — otherwise a legitimate Binotel address would never match on
// exactly the machines that bind '::'.
export function normalizeIp(addr) {
  const s = String(addr || '');
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/**
 * @param {Database} db
 * @param {object} [opts]
 * @param {string[]} [opts.allowedIps]  test seam; production always uses BINOTEL_SOURCE_IPS
 */
export function telephonyWebhooks(db, { allowedIps = BINOTEL_SOURCE_IPS } = {}) {
  const r = Router();
  // Small and route-local: the 100kb budget matches the app-wide /api JSON
  // limit — a webhook describes one phone call, never a dataset.
  r.use(express.urlencoded({ extended: true, limit: '100kb' }));

  r.post('/', (req, res) => {
    try {
      handle(db, req, res, allowedIps);
    } catch (e) {
      // Never answer success for a call we failed to file: Binotel retries a
      // non-success apiCallCompleted (7 times over 38 hours per the docs),
      // which is exactly right for a transient bug here.
      console.warn('[telephony] webhook failed:', e && e.message);
      res.status(500).json({ error: { code: 'internal', message: 'Server error.' } });
    }
  });

  // Anything but POST / — probes, crawlers, misconfigured URLs — gets the
  // same non-advertising answer as every other refusal.
  r.use((req, res) => res.status(404).json(NOT_FOUND));
  return r;
}

function handle(db, req, res, allowedIps) {
  const row = readSettingsRow(db);
  if (!row || !row.webhooks_enabled) return res.status(404).json(NOT_FOUND);

  // The licensed-module gate — the same question the poller asks every tick.
  // req.control is attachControl's per-request answer; the mount order in
  // app.js (after attachControl) is what makes it present here.
  if (!req.control || !req.control.has('callcenter')) return res.status(404).json(NOT_FOUND);

  // req.socket.remoteAddress, NEVER X-Forwarded-For: that header is written
  // by whoever sends the request, so honouring it would let anyone on the
  // internet claim a Binotel address — the socket peer is the one thing the
  // sender cannot forge. Deliberate consequence: a clinic fronting this
  // server with its own reverse proxy sees the proxy's address here and must
  // enforce the allowlist AT the proxy instead.
  const ip = normalizeIp(req.socket && req.socket.remoteAddress);
  if (!allowedIps.includes(ip)) {
    // One warn line, not silence: "webhooks configured but nothing arrives"
    // is a support call, and this is the answer to it.
    console.warn('[telephony] webhook from non-Binotel address refused:', ip);
    return res.status(404).json(NOT_FOUND);
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Tenant check (Binotel support's letter): when the clinic's Company ID is
  // saved, a payload for any OTHER company id — including none at all — is
  // refused. Empty setting = don't check: an install issued no id must not
  // lose webhooks over a field it cannot fill in.
  if (row.company_id && String(body.companyID ?? '') !== row.company_id) {
    console.warn('[telephony] webhook for a different companyID refused');
    return res.status(404).json(NOT_FOUND);
  }

  if (body.requestType === 'apiCallSettings') return callSettings(db, row, body, res);
  if (body.requestType === 'apiCallCompleted') return callCompleted(db, body, res);
  // An unknown requestType is either a Binotel feature we do not speak yet or
  // a probe; both get the same non-advertising answer.
  return res.status(404).json(NOT_FOUND);
}

// Call ringing: Binotel wants to know who is calling before an operator picks
// up. Response keys per Binotel support's letter (name, customerData with
// assignedToEmployeeNumber / assignedToEmployeeEmail / linkToCrmUrl), sent as
// JSON in the docs' response structure.
function callSettings(db, row, body, res) {
  const matches = findPatientsByPhone(db, String(body.externalNumber || ''), 1);
  if (!matches.length) {
    // Unknown caller: a generic empty-name answer, never an error — the PBX
    // shows whatever comes back, and an error would put a scary popup on the
    // operator's screen for every first-time patient.
    return res.json({ name: '' });
  }
  const p = matches[0];
  const base = String(row.public_base_url || '').replace(/\/+$/, '');
  return res.json({
    name: p.full_name || '',
    customerData: {
      // No per-patient operator assignment exists in Phase 1; the keys are
      // still present (Binotel's letter lists them as expected) with empty
      // values, which their side treats as "no routing hint".
      assignedToEmployeeNumber: '',
      assignedToEmployeeEmail: '',
      // '#patient=<id>' — the SPA has no hash deep-links today (admin.js
      // navigates in memory), so the fragment is a forward-compatible hint
      // the app simply ignores: the link opens Easy-Med now and can start
      // opening the card itself the day admin.js learns to read it.
      linkToCrmUrl: base ? `${base}/admin#patient=${p.id}` : '',
      linkToCrmTitle: base ? `Карта пациента: ${p.full_name || ''}` : '',
    },
  });
}

function callCompleted(db, body, res) {
  const details = body.callDetails && typeof body.callDetails === 'object' ? body.callDetails : null;
  // recordCall is the poller's own writer — one implementation of "a call
  // becomes a row", so poll and webhook can never disagree (see poller.js).
  // A malformed or unfileable payload still answers success: retrying it for
  // 38 hours cannot make it fileable. Only a genuine failure HERE (a thrown
  // db error, caught by the route wrapper) refuses, because a retry CAN fix
  // that.
  if (details) recordCall(db, details, 'webhook');
  // EXACTLY this string. The docs demand the literal {"status":"success"};
  // anything else — reordered keys, added whitespace — is treated as failure
  // and retried 7 times over 38 hours. res.json() would re-serialize; send()
  // of the literal cannot drift.
  return res.type('application/json').send('{"status":"success"}');
}
