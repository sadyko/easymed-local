import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tagToVersion, checkTagVersion, readPackageVersion } from './check-tag-version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'check-tag-version.mjs');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// tagToVersion — pure, no filesystem
// ---------------------------------------------------------------------------

test('tagToVersion: strips the "v" prefix', () => {
  assert.equal(tagToVersion('v2.4.0'), '2.4.0');
});

test('tagToVersion: accepts a bare version with no prefix', () => {
  assert.equal(tagToVersion('2.4.0'), '2.4.0');
});

test('tagToVersion: accepts the full "refs/tags/vX.Y.Z" ref form', () => {
  assert.equal(tagToVersion('refs/tags/v2.4.0'), '2.4.0');
});

test('tagToVersion: refs/tags/ with no "v" prefix also works', () => {
  assert.equal(tagToVersion('refs/tags/2.4.0'), '2.4.0');
});

test('tagToVersion: garbage returns null, never throws', () => {
  assert.equal(tagToVersion('release-candidate'), null);
  assert.equal(tagToVersion('v2.4'), null);          // two segments, not three
  assert.equal(tagToVersion('v2.4.0.1'), null);      // four segments
  assert.equal(tagToVersion(''), null);
  assert.equal(tagToVersion(undefined), null);
  assert.equal(tagToVersion(null), null);
  assert.equal(tagToVersion(42), null);
});

// ---------------------------------------------------------------------------
// checkTagVersion — pure comparison, no filesystem
// ---------------------------------------------------------------------------

test('checkTagVersion: match', () => {
  const r = checkTagVersion('v2.4.0', '2.4.0');
  assert.equal(r.ok, true);
  assert.equal(r.version, '2.4.0');
});

test('checkTagVersion: mismatch reports both versions in a plain message', () => {
  const r = checkTagVersion('v2.4.0', '2.3.9');
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('2.4.0'));
  assert.ok(r.message.includes('2.3.9'));
});

test('checkTagVersion: v-prefix stripped before comparing', () => {
  assert.equal(checkTagVersion('v1.0.0', '1.0.0').ok, true);
});

test('checkTagVersion: full ref form matches the same way as the bare tag', () => {
  assert.equal(checkTagVersion('refs/tags/v1.0.0', '1.0.0').ok, true);
});

test('checkTagVersion: a garbage tag fails cleanly, with a message, never a thrown error', () => {
  assert.doesNotThrow(() => checkTagVersion('not-a-version', '1.0.0'));
  const r = checkTagVersion('not-a-version', '1.0.0');
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('not-a-version'));
});

test('checkTagVersion: a malformed package.json version also fails cleanly', () => {
  const r = checkTagVersion('v1.0.0', 'garbage');
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('garbage'));
});

// ---------------------------------------------------------------------------
// readPackageVersion — filesystem, but against a synthetic root (never this
// repo's real package.json in this section)
// ---------------------------------------------------------------------------

test('readPackageVersion: reads version from an arbitrary root', () => {
  const dir = mkTmp('em-tagver-pkg-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    assert.equal(readPackageVersion(dir), '9.9.9');
  } finally {
    rm(dir);
  }
});

// ---------------------------------------------------------------------------
// CLI — exercises the real command line release.yml calls
// ("node scripts/check-tag-version.mjs \"$GITHUB_REF_NAME\""), against THIS
// repo's own package.json. The CLI has no --root override (the workflow's
// one real invocation shape takes a single positional tag, nothing else), so
// tags here are derived from the live version rather than hardcoded — this
// file does not need editing every time a maintainer bumps package.json.
// ---------------------------------------------------------------------------

const LIVE_VERSION = readPackageVersion();   // this repo's real package.json, read the same way the CLI does

test('CLI: matching tag exits 0 and names the version', () => {
  const out = execFileSync(process.execPath, [SCRIPT, `v${LIVE_VERSION}`], { stdio: 'pipe' }).toString();
  assert.ok(out.includes(LIVE_VERSION));
});

test('CLI: "v" prefix is stripped through the real command line', () => {
  // Throws (execFileSync) on a non-zero exit — reaching this line is the assertion.
  execFileSync(process.execPath, [SCRIPT, `v${LIVE_VERSION}`], { stdio: 'pipe' });
});

test('CLI: full "refs/tags/vX.Y.Z" ref form works through the real command line', () => {
  execFileSync(process.execPath, [SCRIPT, `refs/tags/v${LIVE_VERSION}`], { stdio: 'pipe' });
});

test('CLI: mismatched tag exits 1 with a plain message, not a stack trace', () => {
  try {
    execFileSync(process.execPath, [SCRIPT, 'v999.999.999'], { stdio: 'pipe' });
    assert.fail('expected a non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    const stderr = String(e.stderr);
    assert.ok(stderr.includes('999.999.999'));
    assert.ok(stderr.includes(LIVE_VERSION));
    assert.doesNotMatch(stderr, /at Object\.<anonymous>|node:internal|    at /);   // no stack trace
  }
});

test('CLI: a garbage tag exits 1 with a clean error, not a stack trace', () => {
  try {
    execFileSync(process.execPath, [SCRIPT, 'not-a-real-tag'], { stdio: 'pipe' });
    assert.fail('expected a non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    const stderr = String(e.stderr);
    assert.ok(stderr.includes('not-a-real-tag'));
    assert.doesNotMatch(stderr, /at Object\.<anonymous>|node:internal|    at /);
  }
});

test('CLI: no tag argument exits 1 with a usage message', () => {
  try {
    execFileSync(process.execPath, [SCRIPT], { stdio: 'pipe' });
    assert.fail('expected a non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.ok(String(e.stderr).includes('Usage'));
  }
});
