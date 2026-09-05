import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildBundle,
  verifyBundle,
  selectEntries,
  findSymlinksInSource,
  readMigrations,
  compareVersions,
  tarCommand,
  ALLOWLIST,
} from './build-bundle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'build-bundle.mjs');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// One throwaway release keypair for this whole file — no private key is ever
// committed to this repo, same discipline as licence.test.js.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KEY_DIR = mkTmp('em-bundle-key-');
const KEY_PATH = path.join(KEY_DIR, 'release-private.pem');
fs.writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }));
after(() => rm(KEY_DIR));

// A small source tree exercising every rule at once: the six allow-listed
// entries actually present (so a bundle has something in it), PLUS everything
// that must never ship — data/, .git/, a stray root .db — each carrying the
// ZZLEAKCHECK marker so the leak test can grep for it byte-for-byte.
function buildSourceTree(root) {
  fs.mkdirSync(path.join(root, 'server', 'db', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'index.js'), 'console.log("server");\n');
  fs.writeFileSync(path.join(root, 'server', 'db', 'migrations', '002_more.sql'), '-- more\n');
  fs.writeFileSync(path.join(root, 'server', 'db', 'migrations', '001_init.sql'), '-- init\n');
  fs.writeFileSync(path.join(root, 'server', 'db', 'migrations', '001.test.js'), '// not a migration, must not appear in manifest.migrations\n');

  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'index.html'), '<html></html>\n');

  fs.mkdirSync(path.join(root, 'install'), { recursive: true });
  fs.writeFileSync(path.join(root, 'install', 'setup.ps1'), '# setup\n');

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'synthetic', version: '2.4.0' }, null, 2));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'synthetic' }, null, 2));

  fs.mkdirSync(path.join(root, 'node_modules', 'dummy-pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dummy-pkg', 'index.js'), 'module.exports = {};\n');

  // Must never ship. This is the whole point of the leak test below.
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'easymed.db'), 'ZZLEAKCHECK-db-bytes');
  fs.writeFileSync(path.join(root, 'data', 'licence.dat'), 'ZZLEAKCHECK-licence-bytes');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), 'ZZLEAKCHECK-git-config');
  fs.writeFileSync(path.join(root, 'backup.db'), 'ZZLEAKCHECK-stray-backup');
}

function tarList(tarPath) {
  const tar = tarCommand();
  return execFileSync(tar.exe, [...tar.extraFlags, '-tzf', tarPath]).toString().trim().split('\n').filter(Boolean);
}
function tarExtract(tarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = tarCommand();
  execFileSync(tar.exe, [...tar.extraFlags, '-xzf', tarPath, '-C', destDir]);
}
// Reads the archive's own bytes without writing anything to disk — a check
// that does not depend on extraction having gone perfectly.
function tarConcatenatedContents(tarPath) {
  const tar = tarCommand();
  return execFileSync(tar.exe, [...tar.extraFlags, '-xzf', tarPath, '-O'], { maxBuffer: 256 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// 1. Round trip
// ---------------------------------------------------------------------------

test('round trip: build, verify, unpack — included files match, excluded ones absent', () => {
  const src = mkTmp('em-bundle-src-');
  const out = mkTmp('em-bundle-out-');
  const dest = mkTmp('em-bundle-unpack-');
  try {
    buildSourceTree(src);

    const { tarPath, manifestPath } = buildBundle({
      sourceDir: src, outDir: out, version: '2.4.0', notesRu: 'Тест', minFrom: '2.0.0', keyPath: KEY_PATH,
    });
    assert.ok(fs.existsSync(tarPath));
    assert.ok(fs.existsSync(manifestPath));
    assert.equal(path.basename(tarPath), 'easymed-2.4.0.tar.gz');
    assert.equal(path.basename(manifestPath), 'easymed-2.4.0.manifest.json');

    const r = verifyBundle({ tarPath, manifestPath, publicKey });
    assert.equal(r.ok, true);
    assert.equal(r.manifest.version, '2.4.0');
    assert.equal(r.manifest.notes_ru, 'Тест');
    assert.equal(r.manifest.min_from, '2.0.0');
    // .test.js is not a migration; migrations sorted, only the two real .sql files
    assert.deepEqual(r.manifest.migrations, ['001_init.sql', '002_more.sql']);
    assert.match(r.manifest.sha256, /^[0-9a-f]{64}$/);

    tarExtract(tarPath, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'server', 'index.js'), 'utf8'), 'console.log("server");\n');
    assert.equal(fs.readFileSync(path.join(dest, 'public', 'index.html'), 'utf8'), '<html></html>\n');
    assert.ok(fs.existsSync(path.join(dest, 'install', 'setup.ps1')));
    assert.ok(fs.existsSync(path.join(dest, 'package.json')));
    assert.ok(fs.existsSync(path.join(dest, 'package-lock.json')));
    assert.ok(fs.existsSync(path.join(dest, 'node_modules', 'dummy-pkg', 'index.js')));
    // the migration test file DOES ship (allow-list is directory-granularity —
    // see the comment in build-bundle.mjs); only the six top-level names are filtered.
    assert.ok(fs.existsSync(path.join(dest, 'server', 'db', 'migrations', '001.test.js')));

    assert.ok(!fs.existsSync(path.join(dest, 'data')));
    assert.ok(!fs.existsSync(path.join(dest, '.git')));
    assert.ok(!fs.existsSync(path.join(dest, 'backup.db')));
  } finally {
    rm(src); rm(out); rm(dest);
  }
});

test('tar entries are forward-slash, relative paths — never absolute or backslashed', () => {
  const src = mkTmp('em-bundle-src-fmt-');
  const out = mkTmp('em-bundle-out-fmt-');
  try {
    buildSourceTree(src);
    const { tarPath } = buildBundle({ sourceDir: src, outDir: out, version: '1.0.0', minFrom: '0.0.0', keyPath: KEY_PATH });
    const names = tarList(tarPath);
    assert.ok(names.length > 5);
    for (const name of names) {
      assert.ok(!name.includes('\\'), `entry has a backslash: ${name}`);
      assert.ok(!/^[A-Za-z]:/.test(name), `entry looks like an absolute Windows path: ${name}`);
      assert.ok(!name.startsWith('/'), `entry looks absolute: ${name}`);
      assert.ok(!name.startsWith('./'), `entry has a leading ./ : ${name}`);
    }
  } finally {
    rm(src); rm(out);
  }
});

// ---------------------------------------------------------------------------
// 2-4. Tampering
// ---------------------------------------------------------------------------

test('a tampered tarball (one flipped byte) fails sha256, not the signature', () => {
  const src = mkTmp('em-bundle-src-tamper1-');
  const out = mkTmp('em-bundle-out-tamper1-');
  try {
    buildSourceTree(src);
    const { tarPath, manifestPath } = buildBundle({ sourceDir: src, outDir: out, version: '1.0.0', minFrom: '0.0.0', keyPath: KEY_PATH });

    const bytes = fs.readFileSync(tarPath);
    bytes[bytes.length - 1] ^= 0xFF;
    fs.writeFileSync(tarPath, bytes);

    const r = verifyBundle({ tarPath, manifestPath, publicKey });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_hash');
  } finally {
    rm(src); rm(out);
  }
});

test('a tampered manifest payload fails the signature', () => {
  const src = mkTmp('em-bundle-src-tamper2-');
  const out = mkTmp('em-bundle-out-tamper2-');
  try {
    buildSourceTree(src);
    const { tarPath, manifestPath } = buildBundle({ sourceDir: src, outDir: out, version: '1.0.0', minFrom: '0.0.0', keyPath: KEY_PATH });

    const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    doc.payload.notes_ru = 'подделано после подписи';   // exactly what an attacker (or a bug) would try
    fs.writeFileSync(manifestPath, JSON.stringify(doc));

    const r = verifyBundle({ tarPath, manifestPath, publicKey });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_signature');
  } finally {
    rm(src); rm(out);
  }
});

test('a bundle verified with the wrong public key is refused', () => {
  const src = mkTmp('em-bundle-src-wrongkey-');
  const out = mkTmp('em-bundle-out-wrongkey-');
  try {
    buildSourceTree(src);
    const { tarPath, manifestPath } = buildBundle({ sourceDir: src, outDir: out, version: '1.0.0', minFrom: '0.0.0', keyPath: KEY_PATH });

    const other = generateKeyPairSync('ed25519');
    const r = verifyBundle({ tarPath, manifestPath, publicKey: other.publicKey });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_signature');
  } finally {
    rm(src); rm(out);
  }
});

// ---------------------------------------------------------------------------
// 5. min_from — numeric per segment, and the exact ordering
// ---------------------------------------------------------------------------

test('compareVersions is numeric per segment: 2.10.0 > 2.9.0 (a string compare gets this backwards)', () => {
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1);
  assert.equal(compareVersions('2.9.0', '2.10.0'), -1);
  assert.equal(compareVersions('2.9.0', '2.9.0'), 0);
  // proof a naive string compare would disagree with the assertions above:
  assert.ok('2.10.0' < '2.9.0');   // JS string comparison — the wrong answer, kept here as a witness
});

test('min_from newer than installedVersion is refused', () => {
  const src = mkTmp('em-bundle-src-mf1-');
  const out = mkTmp('em-bundle-out-mf1-');
  try {
    buildSourceTree(src);
    const { tarPath, manifestPath } = buildBundle({ sourceDir: src, outDir: out, version: '2.6.0', minFrom: '2.5.0', keyPath: KEY_PATH });
    const r = verifyBundle({ tarPath, manifestPath, publicKey, installedVersion: '2.4.0' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'min_from');
  } finally {
    rm(src); rm(out);
  }
});

test('min_from equal to installedVersion is accepted', () => {
  const src = mkTmp('em-bundle-src-mf2-');
  const out = mkTmp('em-bundle-out-mf2-');
  try {
    buildSourceTree(src);
    const { tarPath, manifestPath } = buildBundle({ sourceDir: src, outDir: out, version: '2.6.0', minFrom: '2.5.0', keyPath: KEY_PATH });
    const r = verifyBundle({ tarPath, manifestPath, publicKey, installedVersion: '2.5.0' });
    assert.equal(r.ok, true);
  } finally {
    rm(src); rm(out);
  }
});

test('min_from older than installedVersion is accepted', () => {
  const src = mkTmp('em-bundle-src-mf3-');
  const out = mkTmp('em-bundle-out-mf3-');
  try {
    buildSourceTree(src);
    const { tarPath, manifestPath } = buildBundle({ sourceDir: src, outDir: out, version: '2.6.0', minFrom: '2.5.0', keyPath: KEY_PATH });
    const r = verifyBundle({ tarPath, manifestPath, publicKey, installedVersion: '3.0.0' });
    assert.equal(r.ok, true);
  } finally {
    rm(src); rm(out);
  }
});

test('the 2.10.0 / 2.9.0 pair specifically, through verifyBundle end to end', () => {
  const src = mkTmp('em-bundle-src-mf4-');
  const out = mkTmp('em-bundle-out-mf4-');
  try {
    buildSourceTree(src);
    const { tarPath, manifestPath } = buildBundle({ sourceDir: src, outDir: out, version: '3.0.0', minFrom: '2.10.0', keyPath: KEY_PATH });

    // A clinic on 2.9.0 must be refused: 2.10.0 is NEWER than 2.9.0, even though
    // it sorts first as a string. A string-based implementation would wrongly
    // accept this.
    const refused = verifyBundle({ tarPath, manifestPath, publicKey, installedVersion: '2.9.0' });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'min_from');

    const acceptedEqual = verifyBundle({ tarPath, manifestPath, publicKey, installedVersion: '2.10.0' });
    assert.equal(acceptedEqual.ok, true);

    const acceptedNewer = verifyBundle({ tarPath, manifestPath, publicKey, installedVersion: '2.11.0' });
    assert.equal(acceptedNewer.ok, true);
  } finally {
    rm(src); rm(out);
  }
});

// ---------------------------------------------------------------------------
// 6. THE LEAK TEST
// ---------------------------------------------------------------------------

test('LEAK TEST: data/, .git/, and a stray root .db never reach the archive — by name or by byte', () => {
  const src = mkTmp('em-bundle-src-leak-');
  const out = mkTmp('em-bundle-out-leak-');
  const dest = mkTmp('em-bundle-unpack-leak-');
  try {
    buildSourceTree(src);   // includes data/easymed.db, data/licence.dat, .git/config, backup.db — all marked ZZLEAKCHECK

    const { tarPath } = buildBundle({ sourceDir: src, outDir: out, version: '1.0.0', minFrom: '0.0.0', keyPath: KEY_PATH });

    const names = tarList(tarPath);
    for (const n of names) {
      assert.ok(!n.startsWith('data/') && n !== 'data', `leaked path: ${n}`);
      assert.ok(!n.startsWith('.git/') && n !== '.git', `leaked path: ${n}`);
      assert.ok(n !== 'backup.db', `leaked path: ${n}`);
      assert.ok(!n.includes('easymed.db'), `leaked path: ${n}`);
      assert.ok(!n.includes('licence.dat'), `leaked path: ${n}`);
    }

    // Byte-level: read the archive's own contents without trusting extraction
    // to have gone perfectly.
    const raw = tarConcatenatedContents(tarPath);
    assert.ok(!raw.includes('ZZLEAKCHECK'), 'the ZZLEAKCHECK marker was found in the archive bytes');

    // And on-disk, for good measure.
    tarExtract(tarPath, dest);
    let foundOnDisk = false;
    (function walk(dir) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) { walk(full); continue; }
        if (fs.readFileSync(full, 'utf8').includes('ZZLEAKCHECK')) foundOnDisk = true;
      }
    })(dest);
    assert.equal(foundOnDisk, false, 'the ZZLEAKCHECK marker was found on disk after extraction');
  } finally {
    rm(src); rm(out); rm(dest);
  }
});

// ---------------------------------------------------------------------------
// 7. Selection logic against the REAL repo — no tarring, cheap and fast
// ---------------------------------------------------------------------------

test('against the real repo: selection is exactly the six allow-listed entries, never data/.git/control-plane/releases/docs', () => {
  const entries = selectEntries(REPO_ROOT);
  for (const e of ALLOWLIST) {
    assert.ok(entries.includes(e), `expected "${e}" to be selected from the real repo (it exists there today)`);
  }
  for (const bad of ['data', '.git', 'control-plane', 'releases', 'docs']) {
    assert.ok(!entries.includes(bad), `must never select "${bad}"`);
  }
  assert.deepEqual([...entries].sort(), [...ALLOWLIST].sort());
});

test('the real repo\'s allow-listed entries contain no symlinks/junctions today', () => {
  const entries = selectEntries(REPO_ROOT);
  const links = findSymlinksInSource(REPO_ROOT, entries);
  assert.deepEqual(links, []);
});

// ---------------------------------------------------------------------------
// 8. Malformed inputs
// ---------------------------------------------------------------------------

test('buildBundle refuses clearly when the key file is missing', () => {
  const src = mkTmp('em-bundle-src-nokey-');
  const out = mkTmp('em-bundle-out-nokey-');
  try {
    buildSourceTree(src);
    assert.throws(
      () => buildBundle({ sourceDir: src, outDir: out, version: '1.0.0', minFrom: '0.0.0', keyPath: path.join(out, 'nope.pem') }),
      /Could not read the release signing key/,
    );
  } finally {
    rm(src); rm(out);
  }
});

test('verifyBundle on garbage or missing files returns {ok:false}, never throws', () => {
  const dir = mkTmp('em-bundle-garbage-');
  try {
    const garbageManifest = path.join(dir, 'garbage.manifest.json');
    fs.writeFileSync(garbageManifest, 'not json at all {{{');
    const noPayloadManifest = path.join(dir, 'nopayload.manifest.json');
    fs.writeFileSync(noPayloadManifest, JSON.stringify({ sig: 'AAAA' }));
    const badSigCharsManifest = path.join(dir, 'badsig.manifest.json');
    fs.writeFileSync(badSigCharsManifest, JSON.stringify({ payload: { a: 1 }, sig: '!!!not-base64!!!' }));
    const missingManifest = path.join(dir, 'does-not-exist.manifest.json');
    const missingTar = path.join(dir, 'does-not-exist.tar.gz');
    const emptyTar = path.join(dir, 'empty.tar.gz');
    fs.writeFileSync(emptyTar, '');

    const scenarios = [
      undefined,
      {},
      { tarPath: missingTar, manifestPath: missingManifest, publicKey },
      { tarPath: missingTar, manifestPath: garbageManifest, publicKey },
      { tarPath: emptyTar, manifestPath: garbageManifest, publicKey },
      { tarPath: emptyTar, manifestPath: noPayloadManifest, publicKey },
      { tarPath: emptyTar, manifestPath: badSigCharsManifest, publicKey },
      { tarPath: emptyTar, manifestPath: garbageManifest, publicKey: undefined },
      { tarPath: emptyTar, manifestPath: garbageManifest, publicKey: 'not a key at all' },
      { tarPath: emptyTar, manifestPath: garbageManifest, publicKey: null },
    ];
    for (const s of scenarios) {
      let r;
      assert.doesNotThrow(() => { r = verifyBundle(s); }, `verifyBundle threw for scenario: ${JSON.stringify(s)}`);
      assert.equal(r.ok, false);
    }
  } finally {
    rm(dir);
  }
});

test('a well-signed manifest with a missing tarball returns missing_tar, not a throw', () => {
  const src = mkTmp('em-bundle-src-notar-');
  const out = mkTmp('em-bundle-out-notar-');
  try {
    buildSourceTree(src);
    const { tarPath, manifestPath } = buildBundle({ sourceDir: src, outDir: out, version: '1.0.0', minFrom: '0.0.0', keyPath: KEY_PATH });
    fs.rmSync(tarPath);
    const r = verifyBundle({ tarPath, manifestPath, publicKey });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing_tar');
  } finally {
    rm(src); rm(out);
  }
});

// ---------------------------------------------------------------------------
// Self-attack: things the plan explicitly asked to check empirically
// ---------------------------------------------------------------------------

test('a --version that disagrees with the source package.json warns but still builds — the hard gate is Task 2\'s CI, not this tool', () => {
  const src = mkTmp('em-bundle-src-mismatch-');
  const out = mkTmp('em-bundle-out-mismatch-');
  try {
    buildSourceTree(src);   // package.json version is "2.4.0"
    const result = buildBundle({ sourceDir: src, outDir: out, version: '9.9.9', minFrom: '0.0.0', keyPath: KEY_PATH });
    assert.ok(fs.existsSync(result.tarPath));
    const r = verifyBundle({ tarPath: result.tarPath, manifestPath: result.manifestPath, publicKey });
    assert.equal(r.ok, true);
    assert.equal(r.manifest.version, '9.9.9');
  } finally {
    rm(src); rm(out);
  }
});

test('a junction inside the source tree is refused outright, not followed or looped into', (t) => {
  const src = mkTmp('em-bundle-src-junction-');
  const out = mkTmp('em-bundle-out-junction-');
  const outsideDir = mkTmp('em-bundle-outside-');
  try {
    buildSourceTree(src);
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'ZZLEAKCHECK-outside-the-tree');
    try {
      // 'junction' works on Windows without admin rights (unlike a plain symlink);
      // elsewhere a directory symlink is unprivileged too.
      fs.symlinkSync(outsideDir, path.join(src, 'server', 'linked-out'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      t.skip(`could not create a symlink/junction on this system: ${e.message}`);
      return;
    }
    assert.throws(
      () => buildBundle({ sourceDir: src, outDir: out, version: '1.0.0', minFrom: '0.0.0', keyPath: KEY_PATH }),
      /symlink\/junction/,
    );
  } finally {
    rm(src); rm(out); rm(outsideDir);
  }
});

test('an outDir inside sourceDir is refused — it would be swept into the NEXT bundle', () => {
  const src = mkTmp('em-bundle-src-outdir-');
  try {
    buildSourceTree(src);
    assert.throws(
      () => buildBundle({ sourceDir: src, outDir: path.join(src, 'public', 'releases'), version: '1.0.0', minFrom: '0.0.0', keyPath: KEY_PATH }),
      /outDir .* is inside sourceDir/,
    );
    assert.throws(
      () => buildBundle({ sourceDir: src, outDir: src, version: '1.0.0', minFrom: '0.0.0', keyPath: KEY_PATH }),
      /outDir .* is inside sourceDir/,
    );
  } finally {
    rm(src);
  }
});

test('readMigrations reflects the SOURCE tree being bundled, sorted, .sql only', () => {
  const src = mkTmp('em-bundle-src-migs-');
  try {
    buildSourceTree(src);
    assert.deepEqual(readMigrations(src), ['001_init.sql', '002_more.sql']);
    assert.deepEqual(readMigrations(path.join(src, 'nope')), []);   // no migrations dir at all — empty, not thrown
  } finally {
    rm(src);
  }
});

test('minFrom and version must be well-formed, or buildBundle refuses before touching tar', () => {
  const src = mkTmp('em-bundle-src-ver-');
  const out = mkTmp('em-bundle-out-ver-');
  try {
    buildSourceTree(src);
    assert.throws(() => buildBundle({ sourceDir: src, outDir: out, version: 'not-a-version', minFrom: '0.0.0', keyPath: KEY_PATH }), /version must look like/);
    assert.throws(() => buildBundle({ sourceDir: src, outDir: out, version: '1.0.0', minFrom: '', keyPath: KEY_PATH }), /minFrom must look like/);
    assert.throws(() => buildBundle({ sourceDir: src, outDir: out, version: '1.0', minFrom: '0.0.0', keyPath: KEY_PATH }), /version must look like/);
  } finally {
    rm(src); rm(out);
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI: a missing required flag exits non-zero with a friendly message, not a stack trace', () => {
  try {
    execFileSync(process.execPath, [SCRIPT], { stdio: 'pipe' });
    assert.fail('expected a non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Missing --version/);
  }
});

test('CLI: a full build round-trips through the actual command line, including EASYMED_RELEASE_KEY', () => {
  const src = mkTmp('em-bundle-cli-src-');
  const out = mkTmp('em-bundle-cli-out-');
  try {
    buildSourceTree(src);
    execFileSync(process.execPath, [
      SCRIPT,
      '--version', '3.1.0',
      '--notes', 'CLI смоук-тест',
      '--min-from', '0.0.0',
      '--source', src,
      '--out', out,
    ], {
      env: { ...process.env, EASYMED_RELEASE_KEY: KEY_PATH },
      stdio: 'pipe',
    });
    const tarPath = path.join(out, 'easymed-3.1.0.tar.gz');
    const manifestPath = path.join(out, 'easymed-3.1.0.manifest.json');
    assert.ok(fs.existsSync(tarPath));
    const r = verifyBundle({ tarPath, manifestPath, publicKey });
    assert.equal(r.ok, true);
    assert.equal(r.manifest.notes_ru, 'CLI смоук-тест');
  } finally {
    rm(src); rm(out);
  }
});

// ---------------------------------------------------------------------------
// The shipped tree may not import anything the bundle leaves behind
//
// FINDING — server/services/control/updater.js carried a static top-level
// `import { verifyBundle, tarCommand } from '../../../scripts/build-bundle.mjs'`,
// but scripts/ is not on the ALLOWLIST above, so a CI-built bundle never
// contained it. Unpacking v0.1.1 and starting it died with ERR_MODULE_NOT_FOUND
// before the server bound its port — every release would have failed its health
// check and rolled straight back. Nothing caught it: the suite runs in the full
// repo where scripts/ exists, and verifying a tarball's signature is not the
// same as booting what is inside it.
//
// A static scan of the import graph rather than a real boot, deliberately:
// booting an unpacked tree needs node_modules copied or linked and a free port,
// and would prove this for one entry point only. Reading the imports proves it
// for every runtime file at once, in milliseconds, and names the offending line.
//
// *.test.js is excluded on purpose. Test files DO ship (they are co-located
// under server/), but nothing imports them at runtime, so one reaching into
// scripts/ cannot stop a clinic starting — updater.test.js does exactly that,
// and is right to.
// ---------------------------------------------------------------------------

function runtimeJsFilesUnder(dir) {
  const out = [];
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      out.push(...runtimeJsFilesUnder(full));
      continue;
    }
    if (!/\.(js|mjs)$/.test(it.name)) continue;
    if (/\.test\.(js|mjs)$/.test(it.name)) continue;
    out.push(full);
  }
  return out;
}

// Static relative specifiers only — `import x from '...'`, `export x from '...'`,
// and the bare `import '...'` side-effect form. Those are resolved at load time,
// which is what decides whether the process starts at all. A bare specifier
// (an npm package) is not relative and is covered by node_modules shipping.
const RELATIVE_SPECIFIER_RE = /\bfrom\s*['"](\.[^'"]*)['"]|\bimport\s*['"](\.[^'"]*)['"]/g;

test('nothing under server/ imports outside the allow-listed bundle contents', () => {
  const offenders = [];

  for (const file of runtimeJsFilesUnder(path.join(REPO_ROOT, 'server'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(RELATIVE_SPECIFIER_RE)) {
      const spec = m[1] ?? m[2];
      const resolved = path.resolve(path.dirname(file), spec);
      const topLevel = path.relative(REPO_ROOT, resolved).split(path.sep)[0];
      if (!ALLOWLIST.includes(topLevel)) {
        offenders.push(`${path.relative(REPO_ROOT, file)} imports "${spec}" (resolves to "${topLevel}", which is not shipped)`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These runtime imports escape the bundle, so an unpacked release cannot start:\n  ' + offenders.join('\n  '),
  );
});

// BUNDLE_NO_SYMLINKS_V1 — в архиве не должно быть символических ссылок.
//
// Не гигиена, а работоспособность обновлений. Сборка идёт на Linux, где
// `npm ci` заводит в node_modules/.bin настоящий symlink на каждую
// зависимость с полем "bin". Windows не даёт обычному пользователю создавать
// ссылки, поэтому распаковка такого архива падала:
//
//   node_modules/.bin/bcrypt: Can't create '...': Invalid argument
//   tar.exe: Error exit delayed from previous errors.
//
// Клиника, поставленная службой (LocalSystem), право на ссылки имеет и
// обновлялась нормально — поэтому дыру не замечали. Установка, запущенная
// обычным пользователем, не могла принять НИ ОДНО обновление и показывала при
// этом «проверьте подключение к интернету».
test('bundle: no symbolic links in the archive — a non-admin Windows user cannot unpack them', function (t) {
  let linked = false;
  const src = mkTmp('em-bundle-link-src-');
  const out = mkTmp('em-bundle-link-out-');
  try {
    buildSourceTree(src);
    const binDir = path.join(src, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    try {
      // Ровно то, что делает npm ci на Linux: ссылка на файл ВНУТРИ дерева.
      fs.symlinkSync(path.join('..', 'dummy-pkg', 'index.js'), path.join(binDir, 'bcrypt'));
      linked = true;
    } catch (e) {
      // Windows без прав на ссылки — ровно та машина, ради которой всё это.
      // Проверять нечего: создать ссылку здесь нельзя в принципе.
      t.skip('this machine cannot create symlinks: ' + e.code);
      return;
    }

    const { tarPath } = buildBundle({
      sourceDir: src, outDir: out, version: '2.4.0', minFrom: '2.0.0', keyPath: KEY_PATH,
    });

    // -v печатает тип записи: у ссылки строка начинается с 'l'.
    const TAR = tarCommand();
    const listing = execFileSync(TAR.exe, [...TAR.extraFlags, '-tvzf', tarPath], { encoding: 'utf8' });
    const links = listing.split(/\r?\n/).filter((l) => /^l/.test(l));
    assert.deepStrictEqual(links, [], 'archive contains symbolic links: ' + links.join(', '));
    // И содержимое доехало: dereference кладёт копию, а не выбрасывает запись.
    assert.match(listing, /node_modules\/\.bin\/bcrypt/, 'ссылка должна стать файлом, а не исчезнуть');
  } finally {
    if (!linked) { /* nothing built */ }
  }
});

// ---------------------------------------------------------------------------
// 10. COOLICONS_V1 — набор иконок обязан ехать в комплекте
//
// Владелец сформулировал требование так: иконки должны «сохраняться при
// обновлении версии». Клиника обновляется заменой папки из релизного архива, и
// иконки не устанавливаются отдельно ничем — значит если их нет в архиве, то
// после обновления их нет вообще. Отдельного пункта в ALLOWLIST для них не
// нужно (они лежат внутри public/), и именно поэтому это надо проверить: связь
// «иконки едут» ↔ «public/ в списке» нигде не записана и рвётся молча.
// ---------------------------------------------------------------------------

test('релизный архив везёт вендоренный набор иконок и сгенерированные контуры', () => {
  const src = mkTmp('em-bundle-icons-src-');
  const out = mkTmp('em-bundle-icons-out-');
  const dest = mkTmp('em-bundle-icons-dest-');
  try {
    buildSourceTree(src);
    // Настоящие файлы из этого репозитория, а не выдуманные: проверяем, что
    // именно они попадают в архив по своим настоящим путям.
    fs.cpSync(
      path.join(REPO_ROOT, 'public', 'assets', 'icons'),
      path.join(src, 'public', 'assets', 'icons'),
      { recursive: true },
    );
    fs.mkdirSync(path.join(src, 'public', 'js', 'admin'), { recursive: true });
    for (const f of ['icons.js', 'icon-map.js', 'icon-paths.js']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'public', 'js', 'admin', f), path.join(src, 'public', 'js', 'admin', f));
    }

    const { tarPath } = buildBundle({
      sourceDir: src, outDir: out, version: '2.4.0', minFrom: '2.0.0', keyPath: KEY_PATH,
    });
    // Пути внутри архива всегда с прямыми слэшами; .trim() — потому что
    // Windows-tar заканчивает строки списка на \r\n, а tarList режет только по
    // \n (остальным проверкам в этом файле хвостовой \r не мешает, они не
    // якорят конец строки, а этой — мешает).
    const listing = tarList(tarPath).map((l) => l.trim());

    const svgs = listing.filter((l) => /^public\/assets\/icons\/coolicons\/.+\.svg$/.test(l));
    assert.equal(svgs.length, 442, 'в архиве должны быть все 442 иконки набора');
    for (const must of [
      'public/assets/icons/coolicons/ATTRIBUTION.md',   // CC BY 4.0 — условие использования
      'public/assets/icons/coolicons/Interface/Check.svg',
      'public/js/admin/icon-paths.js',
      'public/js/admin/icon-map.js',
      'public/js/admin/icons.js',
    ]) {
      assert.ok(listing.includes(must), `в архиве нет ${must}`);
    }

    // И это настоящие файлы, а не пустые записи: распаковываем и читаем.
    tarExtract(tarPath, dest);
    const check = fs.readFileSync(path.join(dest, 'public', 'assets', 'icons', 'coolicons', 'Interface', 'Check.svg'), 'utf8');
    assert.match(check, /<svg/);
    const paths = fs.readFileSync(path.join(dest, 'public', 'js', 'admin', 'icon-paths.js'), 'utf8');
    assert.match(paths, /export const ICON_BODIES/);
  } finally {
    rm(src); rm(out); rm(dest);
  }
});

test('иконки едут потому, что public/ в ALLOWLIST — если это изменится, тест выше врёт', () => {
  assert.ok(ALLOWLIST.includes('public'));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'public', 'assets', 'icons', 'coolicons', 'ATTRIBUTION.md')));
});
