import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { isManifestShaped } from './admin.js';
// AUTO_ROLLOUT_V1 — the ONE definition of what a version string may look like,
// imported rather than re-typed: the same regex CI's build-bundle.mjs enforces
// when it NAMES the file is what this route enforces before accepting one.
// Two copies could drift, and the day they drifted the symptom would be a
// release CI can build but the control plane refuses (or worse, the reverse).
// The path-containment assertion in writeTarball() below is deliberately NOT
// derived from this import — see its own comment.
import { VERSION_RE } from '../../../scripts/build-bundle.mjs';

// AUTO_ROLLOUT_V1 — the step that used to be a human being.
//
// THE PROBLEM THIS SOLVES. Until now a release reached clinics like this: CI
// signed a bundle, then a person downloaded the asset from GitHub, scp'd it to
// the vendor server, registered it through the panel, and published it to a
// ring. Four manual steps, every one of them skippable by being busy — and a
// release that is built but never published is indistinguishable, from a
// clinic's point of view, from a release that was never cut at all.
//
// WHY THE STEP CANNOT SIMPLY BE DELETED. The GitHub repository is PRIVATE. A
// clinic PC has no credentials for it and must never be given any — one
// compromised clinic machine would otherwise expose the entire source. So the
// signed bundle has to be served from settings.easymed.uz, which means
// SOMETHING has to move it from GitHub to this server. That something is now
// this route instead of a person.
//
// WHY CI PUSHES HERE, rather than the alternatives:
//   - an SSH key in GitHub Actions would give a compromised workflow a shell
//     on the vendor server — the machine that signs every clinic's licence.
//   - a GitHub token on the vendor server would mean a compromised server
//     could read the private source.
//   - ONE narrow bearer token that can do nothing but publish a release is the
//     smallest blast radius of the three. And a leaked one still cannot forge
//     an update: clinics verify the Ed25519 signature against the public key
//     compiled into them, and the release PRIVATE key lives in a separate
//     GitHub secret this route never sees and could not use.
//
// WHAT STILL STANDS BETWEEN A BAD RELEASE AND EVERY CLINIC (this route removes
// none of it): the clinic verifies the signature before unpacking; the clinic
// ADMIN consents to the version and picks the hour; the install health-checks
// itself and rolls back; and two reported failures auto-halt the release for
// everyone else (services/checkin.js + services/rings.js). That halt is now
// the only automatic brake, because there is no staging ring in the middle any
// more — nothing here may ever weaken it, which is why a re-run of this route
// never clears `halted` (see the handler).

// The full path, exported so tests and documentation cannot drift from the
// mount point in app.js.
export const DEPLOY_MOUNT = '/cp/v1/deploy';
export const DEPLOY_PATH = `${DEPLOY_MOUNT}/release`;

// A token that can publish to every clinic in the country must not be short
// enough to guess. A shorter one is treated as NOT CONFIGURED (404, endpoint
// invisible) rather than accepted — an operator who set a weak token gets an
// endpoint that does not work and a loud line in the log, never a working
// endpoint with a weak lock on it. 32 characters is what
// `randomBytes(24).toString('base64url')` produces, which is what
// docs/RELEASING.md tells the owner to generate.
export const MIN_TOKEN_CHARS = 32;

// The hard cap: nothing above this is buffered at all — express.json refuses
// with 413 before the body is read. A ~15 MB bundle is ~20 MB once base64'd,
// so this leaves the bundle room to roughly double before anyone has to think
// about it, while still being a fixed ceiling rather than "however much RAM
// the process has".
const BODY_HARD_CAP = '48mb';

// The cap on the DECODED tarball, checked from the base64 length before a byte
// is decoded. Deliberately lower than BODY_HARD_CAP (which has to cover base64
// expansion plus the JSON envelope) and well under the clinic updater's own
// 100 MB download ceiling — a bundle this side accepted but no clinic could
// download would be the worst of both. Read per request so it can be raised on
// a running server without a code change.
const DEFAULT_MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

// notes_ru is shown to a clinic admin on the approval screen. Any real release
// note is a few hundred characters; this only exists so a malformed CI run
// cannot put megabytes of prose in the registry.
const MAX_NOTES_CHARS = 20_000;

// Publishing to ring 2 IS the feature: a clinic is offered a release iff
// clinic.ring <= release.ring (services/rings.js:offerFor), and every clinic
// enrolls at ring 2 by default (migration 004). So ring 2 means "every clinic,
// including the ones that enroll next month" — which is exactly the owner's
// model: dev, GitHub, clinics, and no rings in between.
const RING_EVERYONE = 2;

// control-plane/server/routes/deploy.js -> server/ -> control-plane/
const CONTROL_PLANE_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/**
 * Where the .tar.gz files live on disk.
 *
 * These are served as STATIC FILES by nginx on the vendor host, not by this
 * process: the clinic updater downloads `/releases/<version>/easymed-<v>.tar.gz`
 * relative to https://settings.easymed.uz (see server/services/control/updater.js's
 * resolveDownloadUrl — a clinic refuses any URL that leaves that origin). This
 * route's whole filesystem job is to put the bytes where that nginx location
 * already points. Hence an env var: the directory is a property of the SERVER
 * this runs on, and the default only has to be sane for a dev machine.
 */
export function releasesDir(env = process.env) {
  const raw = String(env.EASYMED_CP_RELEASES_DIR || '').trim();
  // Resolved against this service's own root, never the cwd — same reasoning
  // as index.js's EASYMED_CP_DATA_DIR: a service started by systemd or by the
  // Windows SCM has a cwd nobody chose.
  return raw ? path.resolve(CONTROL_PLANE_ROOT, raw) : path.join(CONTROL_PLANE_ROOT, 'releases');
}

/** The public path prefix nginx serves that directory at. */
export function releasesUrlBase(env = process.env) {
  const raw = String(env.EASYMED_CP_RELEASES_URL_BASE || '/releases').trim();
  return raw.replace(/\/+$/, '');
}

function maxBundleBytes(env = process.env) {
  const n = Number(env.EASYMED_CP_MAX_BUNDLE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BUNDLE_BYTES;
}

/** The configured token, or null when this install has none. */
function configuredToken(env = process.env) {
  const raw = String(env.EASYMED_CP_DEPLOY_TOKEN || '').trim();
  return raw.length >= MIN_TOKEN_CHARS ? raw : null;
}

// `Authorization: Bearer <token>` and nothing else. The scheme is compared
// case-insensitively (RFC 7235 says it is case-insensitive) but the token
// itself never is.
function bearerToken(header) {
  const m = /^Bearer[ \t]+(\S+)$/i.exec(String(header || ''));
  return m ? m[1] : null;
}

/**
 * Constant-time token comparison.
 *
 * A plain `===` on a secret leaks it: string comparison stops at the first
 * differing byte, so an attacker who can time the response can recover the
 * token one character at a time. timingSafeEqual does not stop early — but it
 * THROWS on buffers of different lengths, so the length guard below is
 * mandatory, not decorative.
 *
 * The guard is itself a fast path, which would leak the token's LENGTH. That
 * matters more here than it does in unlock.js (where the code's length is a
 * published format), so a wrong-length guess still pays for one full
 * comparison before being refused.
 */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// Byte-identical to app.js's catch-all for an unknown /cp path. An install
// with no deploy token configured must not be distinguishable from one where
// this endpoint was never built — copied deliberately rather than falling
// through to that handler, because falling through would first hand the body
// to the 100kb JSON parser and answer 413 for a large upload, which is itself
// a tell.
const NOT_FOUND_BODY = { error: { code: 'not_found', message: 'Unknown API endpoint.' } };

/**
 * Write the tarball atomically: a temp file in the same directory, then a
 * rename. A downloading clinic must never see a half-written bundle — it would
 * fail its sha256 check, report a failure, and (twice over) halt a release
 * that was never actually broken.
 */
function writeTarball(dir, version, bytes) {
  const root = path.resolve(dir);
  const versionDir = path.join(root, version);
  const finalPath = path.join(versionDir, `easymed-${version}.tar.gz`);

  // Belt and braces. VERSION_RE has already made traversal impossible, but the
  // regex lives in another file (scripts/build-bundle.mjs) that could be
  // relaxed one day by someone thinking only about what CI may BUILD. The
  // guarantee that a request body can never write outside this directory is
  // asserted HERE, on the resolved path, where it cannot be loosened from a
  // distance.
  if (!finalPath.startsWith(root + path.sep)) {
    throw new Error('refusing to write outside the releases directory');
  }

  fs.mkdirSync(versionDir, { recursive: true });
  const tmpPath = path.join(versionDir, `.${path.basename(finalPath)}.${randomBytes(6).toString('hex')}.part`);
  try {
    fs.writeFileSync(tmpPath, bytes);
    fs.renameSync(tmpPath, finalPath);   // replaces an existing file on both Windows and Linux
  } catch (e) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup of a failed write */ }
    throw e;
  }
  return finalPath;
}

export function deployRoutes(db, { env = process.env } = {}) {
  const r = Router();

  const token = configuredToken(env);
  if (!token && String(env.EASYMED_CP_DEPLOY_TOKEN || '').trim()) {
    console.error(`[control-plane] EASYMED_CP_DEPLOY_TOKEN is shorter than ${MIN_TOKEN_CHARS} characters and is being IGNORED — ${DEPLOY_PATH} will answer 404 and CI cannot publish. See docs/RELEASING.md.`);
  }

  // Authentication runs BEFORE the body parser below, on purpose: an
  // unauthenticated caller must never make this process buffer tens of
  // megabytes. It also means a refused request cannot possibly have written
  // anything, because nothing has even been read yet.
  r.use((req, res, next) => {
    if (!token) return res.status(404).json(NOT_FOUND_BODY);
    if (!tokenMatches(bearerToken(req.headers.authorization), token)) {
      // One message for missing, malformed and wrong — same discipline as
      // routes/checkin.js's GENERIC_FAILURE_BODY. Nothing here should help
      // someone work out how close they got.
      return fail(res, 401, 'unauthorized', 'A valid deploy token is required.');
    }
    next();
  });

  // Mounted INSIDE this router (and this router is mounted in app.js ahead of
  // the global 100kb parser) so that exactly one path in the control plane
  // accepts a large body, and every other endpoint keeps its 100kb ceiling.
  r.use(express.json({ limit: BODY_HARD_CAP }));

  r.post('/release', (req, res) => {
    const { version, notes_ru, manifest, tar_base64 } = req.body || {};

    // --- validate before anything is decoded, hashed or written -------------

    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      return fail(res, 400, 'bad_request', 'version must be exactly N.N.N — it becomes a directory and a filename.');
    }
    if (!isManifestShaped(manifest)) {
      return fail(res, 400, 'bad_request', 'manifest must be a {payload, sig} object — the CLINIC verifies the signature, not this API.');
    }
    if (notes_ru !== undefined && notes_ru !== null && (typeof notes_ru !== 'string' || notes_ru.length > MAX_NOTES_CHARS)) {
      return fail(res, 400, 'bad_request', `notes_ru must be a string of at most ${MAX_NOTES_CHARS} characters.`);
    }
    if (typeof tar_base64 !== 'string' || !tar_base64) {
      return fail(res, 400, 'bad_request', 'tar_base64 must be the base64 of the .tar.gz bundle.');
    }

    // Refuse from the ENCODED length, before allocating the decoded buffer:
    // base64 is 4 characters per 3 bytes, so this over-estimates slightly and
    // never under-estimates.
    const cap = maxBundleBytes(env);
    if (tar_base64.length / 4 * 3 > cap) {
      return fail(res, 413, 'too_large', `The bundle is larger than this server accepts (${cap} bytes).`);
    }

    const bytes = Buffer.from(tar_base64, 'base64');
    if (bytes.length > cap) {
      return fail(res, 413, 'too_large', `The bundle is larger than this server accepts (${cap} bytes).`);
    }
    // Buffer.from(..., 'base64') silently DISCARDS anything that is not
    // base64 rather than failing, so a corrupted or truncated upload arrives
    // here as a short, valid-looking buffer. The gzip magic number is the
    // cheapest real check that what arrived is a .tar.gz at all — without it
    // a mangled upload would be stored, hashed, published, and only discovered
    // when clinics started failing to verify it (and, at two failures, halting
    // a release that was never broken).
    if (bytes.length < 3 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
      return fail(res, 400, 'bad_request', 'tar_base64 did not decode to a gzip stream — the upload is corrupt or not a bundle.');
    }

    // The hash is computed from the bytes RECEIVED. It is never read from the
    // request and never read from the manifest: the manifest is signed data
    // this service deliberately treats as opaque (see routes/admin.js's POST
    // /releases), and a sha256 taken from the same request as the bytes would
    // certify nothing at all.
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const url = `${releasesUrlBase(env)}/${version}/easymed-${version}.tar.gz`;
    const dir = releasesDir(env);

    // --- idempotency --------------------------------------------------------
    //
    // Re-running a workflow is normal (a flake after the release step, a
    // re-run after fixing something later in the job), and a re-run must not
    // fail. So: same version + same bytes = success, nothing changed. Same
    // version + DIFFERENT bytes = refused, because that means two different
    // bundles are claiming to be one version — the exact situation where
    // "which code is that clinic running?" stops having an answer.
    const existing = db.prepare('SELECT version, sha256, ring, halted FROM releases WHERE version = ?').get(version);
    if (existing) {
      if (existing.sha256 !== sha256) {
        return fail(res, 409, 'version_conflict',
          `Version ${version} is already registered with a different bundle (sha256 ${String(existing.sha256).slice(0, 12)}…, this upload ${sha256.slice(0, 12)}…). Two different bundles cannot share one version — bump the version.`);
      }

      // Self-healing, and only that: the row is already correct, so the file
      // is (re)written in case it was lost, and the ring is nudged to 2 in
      // case a first run failed between insert and publish. `halted` is NEVER
      // touched — a release halted by two reported failures (or by hand) must
      // not come back to life because someone clicked "re-run job". That is
      // the only automatic brake left in this pipeline.
      writeTarball(dir, version, bytes);
      if (!existing.halted && existing.ring !== RING_EVERYONE) {
        db.prepare('UPDATE releases SET ring = ? WHERE version = ?').run(RING_EVERYONE, version);
      }
      const ring = existing.halted ? existing.ring : RING_EVERYONE;
      return res.status(200).json({ ok: true, already: true, version, ring, halted: !!existing.halted, url, sha256 });
    }

    // --- register and publish ----------------------------------------------
    //
    // File first, row second. A release row is what makes clinics start asking
    // for a URL, so a row must never exist before the bytes it points at do;
    // the other order would offer every clinic a 404 for as long as the write
    // took.
    writeTarball(dir, version, bytes);

    try {
      // Registered and published to ring 2 in ONE statement — the same columns
      // POST /releases and POST /releases/:version/publish write, deliberately
      // not two round trips: a crash between them would leave a release
      // registered but reaching nobody, which is precisely the silent
      // half-published state this whole feature exists to abolish.
      db.prepare(
        'INSERT INTO releases (version, notes_ru, url, sha256, manifest, ring) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(version, typeof notes_ru === 'string' ? notes_ru : null, url, sha256, JSON.stringify(manifest), RING_EVERYONE);
    } catch (e) {
      // Two CI runs racing on the same tag: the loser sees the winner's row.
      // Same rule as above — identical bundle is success, different bundle is
      // a conflict.
      const raced = db.prepare('SELECT sha256 FROM releases WHERE version = ?').get(version);
      if (raced) {
        if (raced.sha256 === sha256) return res.status(200).json({ ok: true, already: true, version, ring: RING_EVERYONE, halted: false, url, sha256 });
        return fail(res, 409, 'version_conflict', `Version ${version} is already registered with a different bundle. Two different bundles cannot share one version — bump the version.`);
      }
      throw e;
    }

    // The one log line that matters on this server: which version went out to
    // everyone, and when. Never the token, never the body.
    console.log(`[control-plane] release ${version} published to ring ${RING_EVERYONE} (sha256 ${sha256.slice(0, 12)}…, ${bytes.length} bytes)`);

    res.status(201).json({ ok: true, already: false, version, ring: RING_EVERYONE, halted: false, url, sha256 });
  });

  return r;
}
