#!/usr/bin/env node
// UPDATE_DELIVERY_V1 — the release bundle: what a clinic downloads, verifies, and
// applies to itself. Runs on the maintainer's machine (this task) and later inside
// GitHub Actions (a following task); never on a clinic PC.
//
//   node scripts/build-bundle.mjs --version 2.4.0 --notes "…" --min-from 2.0.0 --key vendor-release-key.pem
//
// A bundle is two files: easymed-<version>.tar.gz and its signed manifest,
// easymed-<version>.manifest.json. The manifest is `{ payload, sig }`, signed
// Ed25519 over `canonical(payload)` — the exact same mechanism the licence uses,
// via the exact same serialiser (server/services/control/canonical.js). This file
// does not implement a second one: a licence and a release manifest that
// disagreed about serialisation would each verify fine alone and only surface the
// mismatch the day someone tried to reuse the code, which is exactly the
// duplicate this project already found and removed once.
//
// SEPARATE SIGNING KEY from the licence (EASYMED_RELEASE_KEY, never the vendor's
// licence key). Two keys, deliberately: this file — or the CI secret that holds
// its private half — is what a build machine leaks first. If it leaked the SAME
// key used to license clinics, whoever holds it could mint themselves a licence,
// not just a bogus update. A leaked release key only lets someone forge an update
// bundle, which still has to pass this project's other controls (ring publishing,
// admin consent, health-checked install) before it reaches a clinic. Losing the
// blast radius of ONE leak to "can build fake updates" instead of "can license
// anyone" is the entire reason two keypairs exist instead of one.
//
// INCLUDE BY ALLOW-LIST, NEVER DENY-LIST (see ALLOWLIST below). A deny-list has to
// be updated every time someone adds a new top-level folder, and forgetting is
// silent — the new folder just ships. An allow-list means a new folder ships only
// because someone decided it should.
//
// VERIFY BEFORE UNPACKING, ALWAYS. verifyBundle() checks the signature first, the
// tarball hash second, and the version floor last — in that order, because
// nothing the manifest claims (including its own sha256 field) may be trusted
// until the signature over it has been checked. Only once all three pass does
// anything downstream get to open the archive.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical } from '../server/services/control/canonical.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // scripts/.. = project root

// ---------------------------------------------------------------------------
// What ships. Exactly these six, and nothing decided by what NOT to name.
// ---------------------------------------------------------------------------

export const ALLOWLIST = Object.freeze([
  'server',
  'public',
  'install',
  'package.json',
  'package-lock.json',
  'node_modules',
]);

/**
 * Which of the allow-listed top-level entries actually exist under sourceDir.
 *
 * Exported on its own (not folded into buildBundle) so a test can run this
 * exact selection logic against the real repository root — the thing that
 * actually matters for "does data/ ever ship" — without paying the cost of
 * tarring 30+ MB of node_modules just to make an assertion about which
 * directory names were chosen.
 */
export function selectEntries(sourceDir) {
  return ALLOWLIST.filter((entry) => fs.existsSync(path.join(sourceDir, entry)));
}

// ---------------------------------------------------------------------------
// Symlinks/junctions inside the source tree.
//
// Measured, not assumed: a directory junction inside the tree that points back
// at an ancestor makes bsdtar (Windows' own tar.exe, System32) recurse into it
// for real — archiving server/loop/server/loop/server/loop/... until a path
// gets too long for the archive format and tar aborts with a half-written,
// useless .tar.gz. A junction pointing OUTSIDE the source tree is worse: tar
// happily follows it and archives whatever is over there, including — if that
// happened to be the clinic's own data directory from a careless local test —
// exactly the leak this file exists to prevent. Neither failure mode is
// something to discover empirically on a build machine, so it is refused here,
// before tar ever runs, by refusing to build at all if any selected entry
// contains one.
// ---------------------------------------------------------------------------

function walkForSymlinks(dir, baseDir, found) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;   // unreadable directory — nothing more to walk; the real fs error surfaces elsewhere
  }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isSymbolicLink()) {
      found.push(path.relative(baseDir, full));
      continue;   // never followed — see comment above
    }
    if (it.isDirectory()) walkForSymlinks(full, baseDir, found);
  }
}

/** Every symlink/junction found inside the selected entries, as paths relative to sourceDir. */
export function findSymlinksInSource(sourceDir, entries) {
  const found = [];
  for (const entry of entries) {
    const full = path.join(sourceDir, entry);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      found.push(entry);   // the allow-listed entry itself is a link
      continue;
    }
    if (st.isDirectory()) walkForSymlinks(full, sourceDir, found);
  }
  return found;
}

// ---------------------------------------------------------------------------
// migrations: the .sql filenames in server/db/migrations/ of the source being
// bundled — not the running project's own migrations directory, so a bundle
// built from an arbitrary source tree (a synthetic one in a test, or an older
// checked-out tag) reports what THAT tree actually contains.
// ---------------------------------------------------------------------------

export function readMigrations(sourceDir) {
  const dir = path.join(sourceDir, 'server', 'db', 'migrations');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];   // a source tree with no migrations directory ships no migrations, not an error
  }
  return names.filter((n) => n.endsWith('.sql')).sort();
}

// ---------------------------------------------------------------------------
// Version comparison, numeric per segment. "2.10.0" must sort after "2.9.0" —
// a plain string compare gets this backwards (comparing "1" to "9" character
// by character, never reaching the "10"). This is the one piece of logic a
// later task (the clinic updater) needs unchanged, so it is exported rather
// than re-derived — the same reasoning canonical() is reused for.
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

const VERSION_RE = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Which tar, exactly — never whichever PATH happens to find.
//
// Windows ships bsdtar in System32 since Win10 1803: it handles C:\ paths
// natively and has no --force-local flag. Git Bash (and plain "tar" on Linux)
// ships GNU tar: given an absolute Windows path anywhere in its argument list —
// including the archive path itself — it reads the "C:" before the colon as a
// remote host name and tries to open an rsh connection to a machine called C,
// failing with "Cannot connect to C: resolve failed" and no other clue.
// Reproduced directly while building this file: the same command line cannot
// serve both tars, and which one the word "tar" means depends on PATH order,
// which differs between this dev machine (Git Bash's GNU tar wins), a plain
// PowerShell session, and a Windows service (bsdtar wins in both). So the
// choice is made explicitly rather than left to PATH, following the identical
// fix already proven in ../symptex local/server/services/updates.js.
// ---------------------------------------------------------------------------

export function tarCommand() {
  const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (process.platform === 'win32' && fs.existsSync(sys)) {
    return { exe: sys, extraFlags: [] };
  }
  return { exe: 'tar', extraFlags: ['--force-local'] };
}

function assertTarAvailable(tar) {
  try {
    execFileSync(tar.exe, [...tar.extraFlags, '--version'], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(
      `tar is not available (tried "${tar.exe}"): ${e.message}\n` +
      'Windows 10+ ships tar.exe (bsdtar) in System32; this project adds no npm ' +
      'dependency to substitute for it, so nothing else can build a bundle.',
    );
  }
}

// child of parent (or equal to it), computed on resolved paths — used to refuse
// an outDir that lands inside the tree being archived.
function isPathInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Warn — never refuse — when the source's own package.json version disagrees
 * with the version being built.
 *
 * This tool is also what the test suite calls, repeatedly, against synthetic
 * source trees whose package.json (if any) has nothing to do with the version
 * under test, and it is a reasonable thing for a maintainer to run locally
 * against an old checkout while exploring a hotfix. A hard refusal here would
 * make it unusable for either. The hard gate belongs to Task 2's GitHub Actions
 * job instead: its trigger IS the git tag, so it can compare tag to
 * package.json before this function is ever invoked, and refuse the release
 * outright — "which version is that?" must have exactly one answer for
 * anything that reaches a clinic, but a local build is not that moment yet.
 */
function warnIfVersionMismatch(resolvedSource, version) {
  let pkgVersion;
  try {
    pkgVersion = JSON.parse(fs.readFileSync(path.join(resolvedSource, 'package.json'), 'utf8')).version;
  } catch {
    return;   // no readable package.json in the source — nothing to compare against
  }
  if (pkgVersion && pkgVersion !== version) {
    console.error(`warning: package.json version (${pkgVersion}) does not match --version (${version})`);
  }
}

/**
 * Build a signed release bundle.
 *
 * @param {object} opts
 * @param {string} opts.sourceDir  the application tree to package
 * @param {string} opts.outDir     where to write the two output files — must NOT
 *                                 be inside sourceDir (see isPathInside above):
 *                                 an output that lands inside the tree it was
 *                                 built from becomes an input to the NEXT bundle.
 * @param {string} opts.version    e.g. "2.4.0"
 * @param {string} [opts.notesRu]  clinic-facing changelog text; defaults to ''
 * @param {string} opts.minFrom    the oldest installed version this bundle may
 *                                 be applied to — required. A release with no
 *                                 declared floor is one nobody deliberately
 *                                 decided could skip whatever migrations lie
 *                                 between; if that is genuinely "any version",
 *                                 say "0.0.0" and mean it, rather than defaulting
 *                                 there silently.
 * @param {string} opts.keyPath    path to the release's Ed25519 private key PEM
 * @returns {{tarPath: string, manifestPath: string}}
 *
 * Throws on any problem — unlike verifyBundle, this runs on the maintainer's own
 * machine (or CI) with someone watching, so a clear thrown Error is more useful
 * than a swallowed failure.
 */
export function buildBundle({ sourceDir, outDir, version, notesRu, minFrom, keyPath }) {
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    throw new Error(`sourceDir does not exist: ${sourceDir}`);
  }
  if (!outDir) throw new Error('outDir is required');
  if (!version || !VERSION_RE.test(version)) {
    throw new Error(`version must look like "2.4.0" (numeric, three parts) — got "${version}"`);
  }
  if (!minFrom || !VERSION_RE.test(minFrom)) {
    throw new Error(`minFrom must look like "2.0.0" (numeric, three parts) — got "${minFrom}". Use "0.0.0" if any installed version may apply this update.`);
  }
  if (!keyPath) throw new Error('keyPath is required — a path to the release Ed25519 private key PEM (EASYMED_RELEASE_KEY)');

  const resolvedSource = path.resolve(sourceDir);
  const resolvedOut = path.resolve(outDir);
  if (isPathInside(resolvedOut, resolvedSource)) {
    throw new Error(
      `outDir ("${outDir}") is inside sourceDir ("${sourceDir}"). Write bundle output ` +
      'somewhere outside the tree being archived — otherwise this build\'s own output ' +
      'files sit there to be swept into the NEXT one.',
    );
  }

  const tar = tarCommand();
  assertTarAvailable(tar);

  let privateKey;
  try {
    privateKey = fs.readFileSync(keyPath, 'utf8');
  } catch {
    throw new Error(`Could not read the release signing key at "${keyPath}". Set EASYMED_RELEASE_KEY, or pass --key <path>.`);
  }

  warnIfVersionMismatch(resolvedSource, version);

  const entries = selectEntries(resolvedSource);
  if (entries.length === 0) {
    throw new Error(`Nothing to bundle: none of [${ALLOWLIST.join(', ')}] exist under ${sourceDir}`);
  }

  const badLinks = findSymlinksInSource(resolvedSource, entries);
  if (badLinks.length) {
    throw new Error(
      `Refusing to build: symlink/junction found inside the source tree: ${badLinks.join(', ')}. ` +
      'A link can point anywhere on disk, including back on itself — it must never be silently ' +
      'followed or archived.',
    );
  }

  fs.mkdirSync(resolvedOut, { recursive: true });
  const tarPath = path.join(resolvedOut, `easymed-${version}.tar.gz`);
  const manifestPath = path.join(resolvedOut, `easymed-${version}.manifest.json`);

  try {
    // -C changes into resolvedSource before archiving, so every entry name inside
    // the tar is relative ("server/index.js"), never an absolute Windows path —
    // required for the archive to unpack correctly on Linux (the clinic runner,
    // CI). Passing the entries by name (never ".") also means anything else
    // sitting in sourceDir — including this very outDir, if it were ever placed
    // inside sourceDir under a name not on the allow-list — is never even looked
    // at, let alone archived.
    execFileSync(tar.exe, [...tar.extraFlags, '-czf', tarPath, '-C', resolvedSource, ...entries], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`tar failed to build the archive: ${e.message}`);
  }

  const tarBytes = fs.readFileSync(tarPath);
  const sha256 = createHash('sha256').update(tarBytes).digest('hex');

  const payload = {
    version,
    released: new Date().toISOString().slice(0, 19) + 'Z',   // seconds precision; matches the manifest example
    notes_ru: notesRu ?? '',
    migrations: readMigrations(resolvedSource),
    min_from: minFrom,
    sha256,
  };

  let sig;
  try {
    sig = sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64');
  } catch {
    throw new Error(`"${keyPath}" does not look like a valid Ed25519 private key.`);
  }

  fs.writeFileSync(manifestPath, JSON.stringify({ payload, sig }, null, 2) + '\n');

  return { tarPath, manifestPath };
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

// ---------------------------------------------------------------------------
// CLI. Arg parsing follows scripts/make-licence.mjs exactly (same pairing loop,
// same opt()/need() shape, same friendly-error discipline) — two release tools
// in this project should not teach two different command-line conventions.
// ---------------------------------------------------------------------------

function runCli() {
  const args = Object.create(null);
  for (let i = 2; i < process.argv.length; i++) {
    const tok = process.argv[i];
    if (!tok.startsWith('--')) continue;   // stray positional token — ignore rather than misalign the rest
    const key = tok.slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;   // consumed as this flag's value
    }
  }
  const opt = (k, fallback = '') => (args[k] === undefined || args[k] === true ? fallback : args[k]);
  const need = (k) => {
    const v = args[k];
    if (v === undefined || v === true) {
      console.error(`Missing --${k} <value>`);
      process.exit(1);
    }
    return v;
  };

  const version = need('version');
  const notes = need('notes');
  const minFrom = need('min-from');

  // --key, or EASYMED_RELEASE_KEY if --key was not given — matching the task's
  // "read from EASYMED_RELEASE_KEY" while still letting a maintainer point at an
  // explicit file for a one-off local build.
  const keyPath = opt('key') || process.env.EASYMED_RELEASE_KEY;
  if (!keyPath) {
    console.error('Missing --key <path> (or set EASYMED_RELEASE_KEY to the same path).');
    process.exit(1);
  }

  const sourceDir = opt('source', ROOT);
  // Default output is a SIBLING of the project, never inside it — see the
  // "outDir inside sourceDir" guard in buildBundle. A maintainer who wants
  // otherwise still has to pass --out explicitly and buildBundle still refuses
  // if that explicit choice lands inside sourceDir.
  const outDir = opt('out', path.resolve(ROOT, '..', 'easymed-bundles'));

  let result;
  try {
    result = buildBundle({ sourceDir, outDir, version, notesRu: notes, minFrom, keyPath });
  } catch (e) {
    console.error('');
    console.error(`  СБОРКА ОСТАНОВЛЕНА: ${e.message}`);
    console.error('');
    process.exit(1);
  }

  const tarBytes = fs.readFileSync(result.tarPath);
  const manifestDoc = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  console.log('');
  console.log('  ' + '='.repeat(60));
  console.log('  РЕЛИЗ СОБРАН');
  console.log('  ' + '-'.repeat(60));
  console.log(`    Версия:    ${version}`);
  console.log(`    Файл:      ${result.tarPath}`);
  console.log(`    Манифест:  ${result.manifestPath}`);
  console.log(`    Размер:    ${(tarBytes.length / 1024 / 1024).toFixed(2)} МБ`);
  console.log(`    sha256:    ${manifestDoc.payload.sha256.slice(0, 32)}…`);
  console.log('  ' + '-'.repeat(60));
  console.log('  ' + '='.repeat(60));
  console.log('');
}

// Compared as REAL paths — see server/index.js's identical guard for why a
// plain string compare of process.argv[1] against import.meta.url is not
// enough once any junction/symlink is involved. Importing this module (as the
// test file does) must never run the CLI as a side effect.
const realPath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = process.argv[1]
  && realPath(path.resolve(process.argv[1])) === realPath(fileURLToPath(import.meta.url));

if (isMain) {
  runCli();
}
