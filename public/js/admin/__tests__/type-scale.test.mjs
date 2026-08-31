import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// TYPE_SCALE_V1 (2026-08-31) — the repo-wide guard that keeps the size zoo
// dead (docs/plans/2026-08-31-onest-typography-design.md, same pattern as
// i18n-coverage.test.mjs: one file that makes the whole CLASS of drift fail
// the build, not a screenshot).
//
// The rule: every SCREEN font-size in px is one of the eight steps
//   12.5 / 13.5 / 15 / 17 / 20 / 24 / 30 / 40
// declared as --fs-1..--fs-8 in admin.css. New code should use the tokens;
// literal snapped px is equally accepted (the 2026-08-31 mass rewrite wrote
// literals; var(--fs-N) carries no number, so this scanner never flags it
// either way). A stray `font-size: 11px` anywhere in scope is a red build.
//
// Scanned forms — the ones that actually occur in this codebase (checked
// against the census that drove the rewrite):
//   font-size: 13px / font-size:13px          (css + inline-style strings)
//   fontSize: '13px' / "13px" / `13px`        (JS style objects)
//   font: 600 13px/1.2 …                      (the font shorthand)
//   font-size="13"                            (SVG attributes — chart labels;
//                                              SVG user units are px)
// NOT scanned, deliberately:
//   - var(--fs-N)/inherit/0 — no number to check; font-size:0 is the classic
//     visually-hide-text idiom (admin.css uses it once), not text sizing;
//   - em/rem/% — relative sizes inherit a snapped base; only three exist,
//     all inside a print file (asserted below so new ones surface);
//   - pt — a PRINT unit; allowed only inside the print exclusions, a pt on
//     screen fails (asserted below);
//   - execCommand('fontSize', N) — a 1..7 rich-text enum, not px.
//
// ---------------------------------------------------------------------------
// NAMED EXCLUSIONS — every one is a decision, not a silent skip.
// Print documents get the FAMILY (Onest, via shared/print-fonts.js) but keep
// their SIZES: their metrics are physically tested (a thermal receipt bumped
// 25% cuts off mid-line; the 12.5 floor is a screen rule — owner decision
// 2026-08-31, the owner test-prints a receipt and a lab sheet per release).
// ---------------------------------------------------------------------------

// (a) Whole files that render ONLY printed output.
const PRINT_DOC_FILES = new Map([
  ['admin/views/doc-variants.js', 'designed printed documents — 11 standalone print shells (заключение, анализы, счёт, чек…)'],
  ['admin/views/receipt-print.js', 'fiscal receipt builder — print payloads only'],
  ['admin/views/lab-doc.js', 'printed lab blank helpers — print payloads only'],
  ['admin/views/lab-barcode.js', 'Code128 label printer — pt-sized thermal labels, nothing on screen'],
  ['shared/doc-render.js', 'the branded printed-sheet renderer (browser print window + server PDF); its “preview” is the same printed sheet in an iframe'],
]);

// (b) Print blocks inside MIXED screen files are fenced in the source with
//     /* type-scale-exempt-start: <reason> */ … /* type-scale-exempt-end */
//     (single line: // type-scale-exempt: <reason> exempts it and the next),
//     mirroring the i18n guard's pragma convention. The fences themselves are
//     validated below: balanced, and a reason after the colon is REQUIRED —
//     the reason is the point.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', '..', '..');   // …/public

const STEPS = new Set([12.5, 13.5, 15, 17, 20, 24, 30, 40]);

function* walkJs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // vendor/ is third-party (xlsx build etc.) — not this product's UI.
      if (e.name !== '__tests__' && e.name !== 'vendor') yield* walkJs(p);
    } else if (/\.(js|mjs)$/.test(e.name) && !/\.test\.(js|mjs)$/.test(e.name)) {
      yield p;
    }
  }
}

function scopeFiles() {
  const files = [];
  for (const f of fs.readdirSync(path.join(PUB, 'css'))) {
    if (f.endsWith('.css')) files.push(path.join(PUB, 'css', f));
  }
  files.push(...walkJs(path.join(PUB, 'js')));
  for (const f of ['admin.html', 'index.html', 'users.html']) files.push(path.join(PUB, f));
  return files;
}

function relName(abs) {
  return path.relative(path.join(PUB, 'js'), abs).split(path.sep).join('/');
}

// Exempt lines: fenced print blocks + single-line pragmas. Raw lines, BEFORE
// comment masking — the fences ARE comments.
function exemptLines(lines) {
  const ex = new Set();
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.includes('type-scale-exempt-start:')) { inBlock = true; ex.add(i); continue; }
    if (L.includes('type-scale-exempt-end')) { inBlock = false; ex.add(i); continue; }
    if (inBlock) { ex.add(i); continue; }
    if (L.includes('type-scale-exempt:')) { ex.add(i); ex.add(i + 1); }
  }
  return ex;
}

// Blank out /* … */ comments so PROSE about sizes (file headers, decision
// comments) can never trip the scanner; newlines survive so line numbers
// stay true. Line comments are left in — a `// font-size: 11px` would fail,
// and commented-out declarations failing is a feature, not a bug.
function maskBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const SIZE_RES = [
  /font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)(px|pt)/gi,
  /fontSize\s*:\s*['"`]([0-9]+(?:\.[0-9]+)?)(px|pt)/g,
  /font:(?:\s*(?:bold|italic|normal|[1-9]00)\s+|\s*)*([0-9]+(?:\.[0-9]+)?)(px|pt)/g,
  /font-size="([0-9]+(?:\.[0-9]+)?)()"/g,   // SVG attr: unitless user units = px
];

function scan() {
  const violations = [];
  const fenced = [];        // matches inside exempt fences (print) — counted, allowed
  const printFileHits = [];  // matches inside whole-file exclusions — counted, allowed
  let scanned = 0;
  let relativeUnits = 0;

  for (const abs of scopeFiles()) {
    const src = fs.readFileSync(abs, 'utf8');
    const rel = relName(abs);
    const isPrintFile = PRINT_DOC_FILES.has(rel);
    const rawLines = src.split(/\r?\n/);
    const ex = exemptLines(rawLines);
    const lines = maskBlockComments(src).split(/\r?\n/);

    relativeUnits += (src.match(/font-size\s*:\s*[0-9.]+(?:em|rem|%)/gi) || []).length;

    lines.forEach((L, i) => {
      for (const re of SIZE_RES) {
        re.lastIndex = 0;
        for (const m of L.matchAll(re)) {
          const v = parseFloat(m[1]);
          const unit = m[2] || 'px';
          if (unit === 'px' && v === 0) continue;   // the hide idiom, not text
          const hit = { file: (rel.startsWith('..') ? path.relative(PUB, abs) : 'js/' + rel).split(path.sep).join('/'), line: i + 1, text: m[0], v, unit };
          if (isPrintFile) { printFileHits.push(hit); continue; }
          if (ex.has(i)) { fenced.push(hit); continue; }
          scanned++;
          if (unit === 'pt' || !STEPS.has(v)) violations.push(hit);
        }
      }
    });
  }
  return { violations, fenced, printFileHits, scanned, relativeUnits };
}

// ---------------------------------------------------------------------------

test('every screen font-size is on the eight-step scale', () => {
  const { violations, scanned } = scan();

  // Sanity floor: this codebase carries ~2600 on-scale screen declarations.
  // A scanner that suddenly "finds" a few dozen has broken (bad glob, moved
  // directory, regex typo) and MUST fail loudly rather than pass vacuously.
  assert.ok(scanned >= 1500,
    `scanner sanity floor: only ${scanned} font-size declarations found — the scanner itself is broken`);

  const msg = violations.slice(0, 40).map((x) => `  ${x.file}:${x.line}  ${x.text}`).join('\n');
  assert.equal(violations.length, 0,
    `${violations.length} font-size value(s) off the 12.5/13.5/15/17/20/24/30/40 scale:\n${msg}${violations.length > 40 ? '\n  …' : ''}\n` +
    'Snap to the nearest step (ties round UP, 12.5 is the floor) or use var(--fs-1..8). ' +
    'If this is genuinely PRINT output, fence it: /* type-scale-exempt-start: <reason> */ … /* type-scale-exempt-end */');
});

test('the print exclusions are real files and actually carry print sizes', () => {
  // A renamed print file would leave a stale exclusion here while its
  // replacement gets scanned — the scan stays correct, but the stale entry
  // would rot into a lie. Every named exclusion must exist.
  for (const [rel, reason] of PRINT_DOC_FILES) {
    assert.ok(fs.existsSync(path.join(PUB, 'js', rel)), `excluded print file missing: ${rel} (${reason})`);
    assert.ok(reason.length > 10, `exclusion ${rel} carries no real reason`);
  }
  const { fenced, printFileHits } = scan();
  // The exclusions exist FOR their sizes; if these ever hit zero the print
  // metrics moved somewhere this test no longer covers — worth a look.
  assert.ok(printFileHits.length >= 200, `print-file exclusions cover only ${printFileHits.length} declarations (expected the doc-variants/doc-render metrics, ~300)`);
  assert.ok(fenced.length >= 20, `fenced print blocks cover only ${fenced.length} declarations (expected ~37 across the mixed files)`);
});

test('every type-scale-exempt fence is balanced and states its reason', () => {
  for (const abs of scopeFiles()) {
    const src = fs.readFileSync(abs, 'utf8');
    const rel = path.relative(PUB, abs);
    let depth = 0;
    src.split(/\r?\n/).forEach((L, i) => {
      const start = L.match(/type-scale-exempt-start:\s*(.*)/);
      if (start) {
        assert.equal(depth, 0, `${rel}:${i + 1}: nested type-scale-exempt-start`);
        depth = 1;
        assert.ok(start[1].replace(/\*\/.*$/, '').trim().length > 3,
          `${rel}:${i + 1}: type-scale-exempt-start without a reason — the reason is the point`);
      } else if (L.includes('type-scale-exempt-end')) {
        assert.equal(depth, 1, `${rel}:${i + 1}: type-scale-exempt-end without a start`);
        depth = 0;
      } else if (/type-scale-exempt:/.test(L)) {
        const m = L.match(/type-scale-exempt:\s*(.*)/);
        assert.ok(m[1].replace(/\*\/.*$/, '').trim().length > 3, `${rel}:${i + 1}: type-scale-exempt without a reason`);
      }
    });
    assert.equal(depth, 0, `${rel}: unclosed type-scale-exempt-start`);
  }
});

test('relative units stay rare and inside print files (em/rem/%)', () => {
  // Three .88em values exist, all in doc-variants.js (a printed <small>
  // relative to its printed parent — correct there). Screen code sizing in
  // em would dodge the scale invisibly, so any growth here needs eyes.
  const { relativeUnits } = scan();
  assert.ok(relativeUnits <= 3,
    `${relativeUnits} em/rem/% font-sizes found (expected ≤3, all in doc-variants.js) — a relative size on screen dodges the scale; use the px steps or extend this test consciously`);
});

test('the scale tokens --fs-1..--fs-8 exist in admin.css and match the steps', () => {
  const css = fs.readFileSync(path.join(PUB, 'css', 'admin.css'), 'utf8');
  const want = [12.5, 13.5, 15, 17, 20, 24, 30, 40];
  want.forEach((v, i) => {
    assert.match(css, new RegExp(`--fs-${i + 1}:\\s*${String(v).replace('.', '\\.')}px`),
      `--fs-${i + 1}: ${v}px missing from admin.css :root`);
  });
});
