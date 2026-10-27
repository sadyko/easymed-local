import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// META_LEADS_V1 — a live Meta access token must never sit in this repo.
//
// The same guard as telegram/no-real-tokens.test.js, for the same reason: a
// test once needed something token-SHAPED and a working one got pasted. A Meta
// token opens every lead the clinic's page ever received and lets the holder
// act as the page's ad account. Fixtures here carry the TESTONLY marker and are
// far too short to be real; anything token-shaped without a marker fails CI.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

// Meta user/page/system-user tokens: "EAA" + app-id prefix + ≥ 80 base64url-ish chars.
const TOKEN_RE = /\bEAA[A-Za-z0-9]{80,}\b/g;
const FIXTURE_MARKERS = ['TESTONLY', 'testonly', 'EXAMPLE', 'XXXXXXXX'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'releases', 'versions', 'dist']);
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.sql', '.yml', '.yaml', '.ps1', '.cmd', '.html', '.css']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (SCAN_EXT.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

test('no live-looking Meta access token anywhere in the source', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const hits = text.match(TOKEN_RE);
    if (!hits) continue;
    for (const hit of hits) {
      if (FIXTURE_MARKERS.some((m) => hit.includes(m))) continue;
      offenders.push(path.relative(ROOT, file) + ': ' + hit.slice(0, 12) + '…');
    }
  }
  assert.deepEqual(offenders, [], 'похоже на настоящий токен Meta — отзовите его и замените заглушкой с пометкой TESTONLY');
});

test('the fixtures this feature uses are marked and obviously fake', () => {
  const fixtures = ['EAAGTESTONLYuserToken001', 'EAAGTESTONLYpageToken002', 'EAAGTESTONLYtokenForView01'];
  for (const f of fixtures) {
    assert.ok(FIXTURE_MARKERS.some((m) => f.includes(m)), f);
    assert.ok(!TOKEN_RE.test(f), 'заглушка короче настоящего токена: ' + f);
  }
});
