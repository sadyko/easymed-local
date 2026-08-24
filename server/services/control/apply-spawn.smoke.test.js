import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applySpawnPlan } from './updater.js';
import { readJsonFile } from './checkin.js';

// THE TEST THAT WAS MISSING — and its absence is the whole reason clinic
// updates never installed themselves for the first four releases.
//
// Every other test of the apply step injects a fake `spawn` and asserts the
// ARGUMENTS. All of them passed, for weeks, while the real child never ran:
// production used `detached: true`, which on Windows means DETACHED_PROCESS —
// no console — and powershell.exe is a console host, so it died at startup,
// silently, with stdio set to 'ignore'. "We called spawn with the right
// arguments" and "the child actually ran" are different claims, and only the
// first one was ever being tested.
//
// So this test executes the REAL plan with the REAL child_process.spawn and
// asserts the one thing a stub can never tell you: apply-update.ps1 got far
// enough to write its outcome file. It deliberately targets a version that is
// NOT staged, so the script refuses at its first precondition and writes the
// refusal — nothing is ever installed, switched, or stopped by this test.
//
// Windows-only by nature (it spawns powershell.exe). CI runs ubuntu, so this
// is a LOCAL gate: docs/RELEASING.md requires it before tagging, because CI
// structurally cannot cover the platform the clinics actually run on.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function scratchInstall() {
  // A minimal but REAL versioned layout: root/versions/<v>/install/ holding
  // the actual scripts from this checkout (apply-update.ps1 dot-sources
  // switch-version.ps1 from its own folder, and that one needs
  // install-service.ps1 — so all three are copied, exactly as a bundle ships
  // them).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-apply-smoke-'));
  const installDir = path.join(root, 'versions', '1.0.0', 'install');
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  for (const f of ['apply-update.ps1', 'switch-version.ps1', 'install-service.ps1']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'install', f), path.join(installDir, f));
  }
  // `current` must exist for the fallback branch of applySpawnPlan; a plain
  // directory is enough — this test never resolves it as a junction.
  fs.mkdirSync(path.join(root, 'current', 'install'), { recursive: true });
  for (const f of ['apply-update.ps1', 'switch-version.ps1', 'install-service.ps1']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'install', f), path.join(root, 'current', 'install', f));
  }
  return root;
}

function runPlan(plan, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(plan.cmd, plan.args, plan.opts);
    let settled = false;
    const done = (how) => { if (!settled) { settled = true; resolve(how); } };
    child.on('error', (e) => done('error:' + (e.code || e.message)));
    child.on('exit', (code) => done('exit:' + code));
    setTimeout(() => done('timeout'), timeoutMs).unref();
  });
}

test('the apply plan actually RUNS a real child process (not just "we called spawn")',
  { skip: process.platform !== 'win32' ? 'Windows-only: spawns powershell.exe' : false },
  async () => {
    const root = scratchInstall();
    const dataDir = path.join(root, 'data');
    // 9.9.9 is deliberately never staged: apply-update.ps1 refuses at its
    // precondition step and writes THAT as its outcome. Reaching the outcome
    // file is the proof the child ran at all — which is the entire point.
    const plan = applySpawnPlan({ root, version: '9.9.9', port: 65000, dataDir });

    // Guard the two options that silently broke this for four releases,
    // before spending 90 seconds finding out the hard way.
    assert.notEqual(plan.opts.detached, true, 'detached on Windows gives powershell no console — it dies instantly');
    assert.notEqual(plan.opts.stdio, 'ignore', 'ignored stdio is what made the failure invisible');

    const how = await runPlan(plan);
    const resultPath = path.join(dataDir, 'update-result.json');
    assert.ok(
      fs.existsSync(resultPath),
      `apply-update.ps1 never ran (child ${how}) — no update-result.json. `
      + 'This is the exact production failure of 2026-08-24: the spawn returned a pid and nothing happened.',
    );

    // The app's OWN reader, deliberately — not a bare JSON.parse. This is
    // where the BOM bug surfaced: PowerShell writes this file with a UTF-8
    // BOM, JSON.parse throws on it, and both production readers swallowed
    // the throw as 'no result'. Asserting through readJsonFile means the
    // test proves the contract that actually matters: the clinic can read
    // the outcome its own installer just wrote.
    const outcome = readJsonFile(resultPath);
    assert.ok(outcome, 'the outcome file must be readable by the app itself (BOM and all)');
    assert.equal(outcome.version, '9.9.9');
    assert.equal(outcome.ok, false, 'an unstaged version must be refused, not installed');
    assert.equal(outcome.db, 'untouched', 'a refused precondition must never have touched the database');

    fs.rmSync(root, { recursive: true, force: true });
  });

test('the apply plan names the STAGED version’s script, so a release can fix the updater that installs it', () => {
  const root = scratchInstall();
  const plan = applySpawnPlan({ root, version: '1.0.0', port: 8000, dataDir: path.join(root, 'data') });
  const fileArg = plan.args[plan.args.indexOf('-File') + 1];
  assert.ok(fileArg.includes(path.join('versions', '1.0.0', 'install')), fileArg);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the apply plan falls back to current/install when a bundle ships without install/', () => {
  const root = scratchInstall();
  const plan = applySpawnPlan({ root, version: '2.0.0', port: 8000, dataDir: path.join(root, 'data') });
  const fileArg = plan.args[plan.args.indexOf('-File') + 1];
  assert.ok(fileArg.includes(path.join('current', 'install')), fileArg);
  fs.rmSync(root, { recursive: true, force: true });
});
