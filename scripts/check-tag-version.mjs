#!/usr/bin/env node
// UPDATE_DELIVERY_V1 — refuses a release build whose tag disagrees with
// package.json's version. Runs as a CI gate (release.yml, before tests and
// before signing): "which version is that?" must have exactly one answer for
// anything that reaches a clinic (docs/plans/2026-08-20-update-delivery.md,
// Task 2).
//
//   node scripts/check-tag-version.mjs v2.4.0
//   node scripts/check-tag-version.mjs refs/tags/v2.4.0     # the full ref form works too
//
// build-bundle.mjs only WARNS on this same mismatch (warnIfVersionMismatch),
// deliberately — it also runs locally against synthetic trees and old
// checkouts where no tag is even in play. This script is the other half: the
// hard gate belongs to CI, where the trigger IS the tag, so refusing outright
// is correct there and would not be here.
//
// Exits 0 on a match. Exits 1 with one plain line on a mismatch or a
// malformed tag — never a stack trace, so a release-morning CI log reads as
// a decision, not a crash.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // scripts/.. = project root

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Strip a git ref down to the bare "X.Y.Z" it encodes, or null if it isn't
 * one. Accepts a bare tag ("v2.4.0" or "2.4.0") and the full ref form
 * ("refs/tags/v2.4.0") the same way — GITHUB_REF_NAME never carries the
 * refs/tags/ prefix but GITHUB_REF does, and this is the one place that
 * distinction is handled so the two inputs can never quietly disagree.
 *
 * Never throws — a hostile or merely malformed tag string is exactly the
 * kind of input this function exists to turn into "null", not an exception.
 */
export function tagToVersion(tag) {
  if (typeof tag !== 'string') return null;
  const stripped = tag.trim().replace(/^refs\/tags\//, '').replace(/^v/, '');
  return VERSION_RE.test(stripped) ? stripped : null;
}

/** package.json's version field, read from `root` (defaults to this project's own root). */
export function readPackageVersion(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return pkg.version;
}

/**
 * Compare a tag to a package.json version. Never throws — the whole point of
 * this function (and the CLI built on it) is a plain-English pass/fail, not
 * a stack trace someone has to read while cutting a release.
 *
 * @returns {{ok: true, version: string} | {ok: false, message: string}}
 */
export function checkTagVersion(tag, pkgVersion) {
  const tagVersion = tagToVersion(tag);
  if (tagVersion === null) {
    return { ok: false, message: `Not a valid version tag: "${tag}" (expected "vX.Y.Z" or "X.Y.Z")` };
  }
  if (typeof pkgVersion !== 'string' || !VERSION_RE.test(pkgVersion)) {
    return { ok: false, message: `package.json version is not a valid "X.Y.Z" version: "${pkgVersion}"` };
  }
  if (tagVersion !== pkgVersion) {
    return {
      ok: false,
      message: `Tag ${tag} (version ${tagVersion}) does not match package.json version ${pkgVersion}. ` +
        'Bump package.json in its own commit on main before tagging (docs/RELEASING.md).',
    };
  }
  return { ok: true, version: tagVersion };
}

function runCli() {
  const tag = process.argv[2];
  if (!tag) {
    console.error('Usage: node scripts/check-tag-version.mjs <tag>');
    process.exit(1);
  }

  let pkgVersion;
  try {
    pkgVersion = readPackageVersion();
  } catch (e) {
    // A CI misconfiguration (wrong working directory, missing checkout) should
    // read as plainly as a version mismatch — not as a raw ENOENT/JSON stack.
    console.error(`Could not read package.json: ${e.message}`);
    process.exit(1);
  }

  const result = checkTagVersion(tag, pkgVersion);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(`OK: tag ${tag} matches package.json version ${result.version}`);
}

// Same real-path guard as build-bundle.mjs's isMain — importing this module
// for its unit tests must never also run the CLI as a side effect.
const realPath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = process.argv[1]
  && realPath(path.resolve(process.argv[1])) === realPath(fileURLToPath(import.meta.url));

if (isMain) {
  runCli();
}
