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
import { createHash, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical } from '../server/services/control/canonical.js';

// The clinic-side half of this contract lives under server/ because it has to
// SHIP: scripts/ is not on the ALLOWLIST below, and updater.js importing these
// two from here meant an unpacked release could not start at all
// (ERR_MODULE_NOT_FOUND before the port was ever bound). Imported back and
// re-exported so this file's public API is unchanged and there is still exactly
// one implementation of each — see server/services/control/bundle.js.
import { verifyBundle, tarCommand, compareVersions } from '../server/services/control/bundle.js';

export { verifyBundle, tarCommand, compareVersions };

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
//
// Narrowed to those two actual risks (link resolves to a DIRECTORY — the
// recursion risk — or resolves OUTSIDE sourceDir — the leak risk), not every
// symlink on sight: `npm ci` on Linux/macOS creates a real file symlink in
// node_modules/.bin for every dependency that declares a "bin" entry —
// bcryptjs does — pointing at a sibling file already inside the same tree.
// That link can neither loop (it's not a directory) nor leak (its target is
// already in the bundle), so it is not one of the two things this refusal
// exists to catch. Flagging it anyway meant this project's own release build
// could never once succeed on the ubuntu-latest CI runner — first found when
// CI ran on Linux for the first time (Windows npm makes a .cmd shim, not a
// symlink, so this never showed up building locally).
// ---------------------------------------------------------------------------

function isRiskySymlink(full, baseDir) {
  let real;
  try {
    real = fs.realpathSync(full);   // follows the link to its ultimate target
  } catch {
    return true;   // broken link — cannot prove it's safe, so refuse rather than guess
  }
  const rel = path.relative(baseDir, real);
  const escapesTree = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
  if (escapesTree) return true;
  let st;
  try {
    st = fs.statSync(full);   // follows the link; throws only if it's already broken (handled above)
  } catch {
    return true;
  }
  return st.isDirectory();   // a directory link/junction — the recursion risk
}

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
      if (isRiskySymlink(full, baseDir)) found.push(path.relative(baseDir, full));
      continue;   // never followed either way — see comment above
    }
    if (it.isDirectory()) walkForSymlinks(full, baseDir, found);
  }
}

/** Every risky symlink/junction found inside the selected entries, as paths relative to sourceDir. */
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
      if (isRiskySymlink(full, sourceDir)) found.push(entry);   // the allow-listed entry itself is a risky link
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

// Exported since AUTO_ROLLOUT_V1: the control plane's CI-facing publish route
// (control-plane/server/routes/deploy.js) turns a version string into a
// directory and a filename, so it must accept exactly what this file is
// willing to BUILD — one vocabulary, not two regexes that could drift.
export const VERSION_RE = /^\d+\.\d+\.\d+$/;

// compareVersions() and tarCommand() moved to server/services/control/bundle.js
// (imported and re-exported at the top of this file) — both are needed by the
// clinic-side updater, and scripts/ does not ship.

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

// verifyBundle() moved to server/services/control/bundle.js — it runs ON A
// CLINIC PC (updater.js calls it before unpacking anything), so it must be
// inside the bundle. Imported and re-exported at the top of this file.

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
