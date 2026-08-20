// DOMAIN_DRIFT_GUARD_V1 — the rule that keeps domain/ meaningful.
//
// Extracting clinicDay and invoiceStatusFor only helps if the next module to be
// written calls them instead of quietly writing its own copy. That is exactly
// how the three definitions of "today" and the three copies of the paid/partial
// ladder appeared in the first place: each was reasonable on its own, and
// nothing objected when they drifted apart.
//
// So this test reads the RPC sources and fails on a re-derivation. When it
// fires, the fix is to import from domain/ — not to add an exemption.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RPC_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'rpc');

function rpcSources() {
  return fs.readdirSync(RPC_DIR)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(RPC_DIR, f), 'utf8') }));
}

// Strip comments so a rule QUOTED in an explanatory comment (this codebase
// documents its reasoning heavily) is not mistaken for a live re-derivation.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('no module derives "today" for itself — date(\'now\') without localtime is a UTC day', () => {
  const offenders = [];
  for (const { file, src } of rpcSources()) {
    const code = stripComments(src);
    // date('now') / datetime('now') NOT immediately qualified with 'localtime'.
    // cashier.js legitimately writes date('now', 'localtime') and passes.
    const re = /\b(?:date|datetime)\(\s*'now'\s*(?!\s*,\s*'localtime')\s*[,)]/g;
    for (const m of code.matchAll(re)) {
      // strftime('%Y-%m-%dT%H:%M:%SZ','now') is the STORAGE format — always UTC
      // by design — and is matched by a different pattern, so it is not caught here.
      offenders.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'use domain/day.js (today/isLocalToday/inLocalRange) instead of a bare date(\'now\'):\n' + offenders.join('\n'));
});

test('no module re-derives the invoice paid/partial/unpaid ladder', () => {
  const offenders = [];
  for (const { file, src } of rpcSources()) {
    const code = stripComments(src);
    if (/'partial'\s*:\s*'unpaid'/.test(code) || /\?\s*'paid'\s*:/.test(code)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [],
    'use invoiceStatusFor() from domain/money.js instead of an inline ladder:\n' + offenders.join('\n'));
});

test('no module hard-codes the outstanding-status list', () => {
  const offenders = [];
  for (const { file, src } of rpcSources()) {
    const code = stripComments(src);
    // A status IN (...) list containing 'unpaid' — the shape that silently
    // omitted 'debt' in both the dashboard and the reports overview.
    if (/status\s+IN\s*\([^)]*'unpaid'[^)]*\)/i.test(code)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'use outstandingWhere() from domain/money.js instead of an inline status list:\n' + offenders.join('\n'));
});
