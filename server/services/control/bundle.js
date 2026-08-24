// UPDATE_DELIVERY_V1 — the half of the release-bundle contract a CLINIC runs.
//
// This file exists because of a bug that made every release un-installable:
// updater.js imported verifyBundle and tarCommand from scripts/build-bundle.mjs,
// but scripts/ is not on that same file's ALLOWLIST, so a CI-built bundle never
// contained it. Unpacking v0.1.1 and starting it died with ERR_MODULE_NOT_FOUND
// before the server bound its port — every clinic left with a `current` pointed
// at a version that cannot start, for every release forever. Signature-verifying
// a tarball is not the same as booting what is inside it, which is why the
// signed v0.1.1 looked fine.
// (This is also the failure recover.cmd exists for: the previous version is
// still on disk, and pointing `current` back at it is one double-click.)
//
// The split is by WHO RUNS IT, not by subject matter:
//   - here, under server/  : verify + unpack, run on a clinic PC, ships
//   - scripts/build-bundle.mjs : BUILD + sign, runs on CI or the maintainer's
//                                machine, deliberately never ships
// build-bundle.mjs imports these back and re-exports them, so there is still
// exactly ONE implementation of each and its existing callers are unchanged —
// the same "never write a second one" discipline canonical.js is held to.
//
// VERIFY BEFORE UNPACKING, ALWAYS. verifyBundle() checks the signature first,
// the tarball hash second, and the version floor last — in that order, because
// nothing the manifest claims (including its own sha256 field) may be trusted
// until the signature over it has been checked.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, verify } from 'node:crypto';
import { canonical } from './canonical.js';

// ---------------------------------------------------------------------------
// Version comparison, numeric per segment. "2.10.0" must sort after "2.9.0" —
// a plain string compare gets this backwards (comparing "1" to "9" character
// by character, never reaching the "10").
// ---------------------------------------------------------------------------

export function compareVersions(a, b) {
  const toParts = (v) => String(v ?? '').split('.').map((seg) => {
    const n = Number(seg);
    return Number.isFinite(n) ? n : 0;   // malformed segment treated as 0 — never throws, see verifyBundle's contract
  });
  const pa = toParts(a);
  const pb = toParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Which tar, exactly — never whichever PATH happens to find.
//
// Windows ships bsdtar in System32 since Win10 1803: it handles C:\ paths
// natively and has no --force-local flag. Git Bash (and plain "tar" on Linux)
// ships GNU tar: given an absolute Windows path anywhere in its argument list —
// including the archive path itself — it reads the "C:" before the colon as a
// remote host name and tries to open an rsh connection to a machine called C,
// failing with "Cannot connect to C: resolve failed" and no other clue.
// Reproduced directly while building this: the same command line cannot serve
// both tars, and which one the word "tar" means depends on PATH order, which
// differs between a dev machine (Git Bash's GNU tar wins), a plain PowerShell
// session, and a Windows service (bsdtar wins in both). So the choice is made
// explicitly rather than left to PATH.
// ---------------------------------------------------------------------------

export function tarCommand() {
  const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (process.platform === 'win32' && fs.existsSync(sys)) {
    return { exe: sys, extraFlags: [] };
  }
  return { exe: 'tar', extraFlags: ['--force-local'] };
}

// Same alphabet check licence.js uses: a base64url signature (as some tools
// emit) fails here as "malformed" instead of being silently mis-decoded as
// base64 and handed to verify() with the wrong bytes.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Verify a release bundle. NEVER throws — this runs on a clinic machine with
 * nobody watching; a bad or tampered bundle must come back as a plain refusal,
 * never a crash.
 *
 * Order matters and is fixed: signature, then hash, then version floor. Nothing
 * the manifest claims — including its own sha256 field — may be trusted before
 * the signature over it has been checked, so the tarball is not even read from
 * disk until the signature has passed.
 *
 * @param {object} opts
 * @param {string} opts.tarPath
 * @param {string} opts.manifestPath
 * @param {string|import('crypto').KeyObject} opts.publicKey  the release public key
 * @param {string} [opts.installedVersion]  omit to skip the min_from gate entirely
 * @returns {{ok: true, manifest: object} | {ok: false, reason: string}}
 *
 * reason is one of: 'malformed' (manifest missing/unreadable/unparseable, or the
 * publicKey itself unusable), 'bad_signature', 'missing_tar' (tarPath unreadable
 * — a truncated or not-yet-arrived download), 'bad_hash', 'min_from' (the
 * release requires a newer floor than installedVersion).
 */
export function verifyBundle({ tarPath, manifestPath, publicKey, installedVersion } = {}) {
  let manifestRaw;
  try {
    manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  let doc;
  try {
    doc = JSON.parse(manifestRaw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'malformed' };

  const { payload, sig } = doc;
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  if (typeof sig !== 'string' || !BASE64_RE.test(sig)) return { ok: false, reason: 'malformed' };

  let canonicalPayload;
  try {
    // canonical() recurses one frame per nesting level with no depth limit — a
    // manifest is exactly the kind of attacker-reachable input that comment in
    // canonical.js warns about, hence the try/catch (mirrors licence.js).
    canonicalPayload = canonical(payload);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  let sigOk = false;
  try {
    sigOk = verify(null, Buffer.from(canonicalPayload, 'utf8'), publicKey, Buffer.from(sig, 'base64'));
  } catch {
    return { ok: false, reason: 'malformed' };   // includes an unusable/missing publicKey — nothing to verify against
  }
  if (!sigOk) return { ok: false, reason: 'bad_signature' };

  // Only now — signature verified — may the tarball or anything payload claims be trusted.
  let tarBytes;
  try {
    tarBytes = fs.readFileSync(tarPath);
  } catch {
    return { ok: false, reason: 'missing_tar' };
  }
  const actualHash = createHash('sha256').update(tarBytes).digest('hex');
  if (typeof payload.sha256 !== 'string' || actualHash !== payload.sha256) {
    return { ok: false, reason: 'bad_hash' };
  }

  if (installedVersion !== undefined && typeof payload.min_from === 'string') {
    if (compareVersions(payload.min_from, installedVersion) > 0) {
      return { ok: false, reason: 'min_from' };
    }
  }

  return { ok: true, manifest: payload };
}
