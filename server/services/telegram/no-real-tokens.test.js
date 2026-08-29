import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// NO_REAL_TOKENS_V1 — a live Telegram bot token must never sit in this repo.
//
// One did, for weeks, in six test files: 5125777202 — a REAL, ACTIVE bot
// belonging to a real clinic (verified live against Telegram's own getMe on
// 2026-08-29). GitHub's secret scanner is what caught it, not us. Anyone
// holding that token could read what patients sent that bot and send messages
// back as the clinic.
//
// It was there because a test needed something token-SHAPED and somebody
// pasted a working one. Fixtures now use an obviously fake token of the same
// shape, so format validation is still exercised and nothing real is at risk.
//
// This test is the guard: it scans the source for the Telegram token pattern
// and fails on anything that is not clearly a fixture. It runs in CI, so the
// next paste is caught before it is ever pushed — the previous one survived
// because nothing was looking.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

// <8-10 digits>:<35 chars> — Telegram's own shape.
const TOKEN_RE = /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g;

// A fixture announces itself. Anything else is treated as a real credential.
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

test('no live-looking Telegram bot token anywhere in the source', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    // This file necessarily contains the pattern in its own regex; skip itself.
    if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const hits = text.match(TOKEN_RE);
    if (!hits) continue;
    for (const hit of hits) {
      if (FIXTURE_MARKERS.some((m) => hit.includes(m))) continue;
      offenders.push(`${path.relative(ROOT, file)}: ${hit.slice(0, 12)}…`);
    }
  }
  assert.deepEqual(offenders, [],
    'Telegram bot token(s) found in the source. Revoke them in BotFather FIRST '
    + '(they are live until you do), then replace with a fixture containing '
    + '"TESTONLY". Offenders:\n  ' + offenders.join('\n  '));
});
