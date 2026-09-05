import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STRINGS } from '../i18n-strings.js';

// I18N_COVERAGE_V1 (2026-08-31) — the repo-wide guard that makes the whole
// CLASS of bug die, not one screen's instance of it.
//
// The class has two shapes, and the owner photographed both before any test
// ever did:
//   1. A bare Russian literal missing from i18n-strings.js. tr() (i18n.js)
//      returns an unknown string UNCHANGED — correct for resilience, fatal
//      for detection: the mistake looks exactly like a working screen.
//   2. A sentence assembled at runtime — 'Создан ' + date, or a template
//      literal with ${holes} around Russian text. tr() matches WHOLE strings,
//      so no dictionary entry can ever rescue such a sentence. The cure is
//      the {template}+params pattern (updates-logic.js fill(), commit
//      08ab775; trf() in i18n.js is the same pattern as one call).
//
// This file asserts, over EVERY scoped module, that neither shape exists:
//   - no Cyrillic literal is an operand of `+` next to a non-literal
//     (pure 'а' + 'б' splits are folded first — they are one string);
//   - no template literal with ${holes} carries Cyrillic in its STATIC text;
//   - Cyrillic inside a ${hole} is allowed only wrapped in tr()/trf()/t()
//     (translated BEFORE assembly — the changesLabel precedent);
//   - every remaining Cyrillic literal, unescaped the way the JS engine
//     would read it, is a dictionary key complete in ru, uz and en
//     (tr()'s trim-variant lookup is honoured).
// Plus dictionary-wide invariants on ALL 5000+ entries: complete in three
// languages, every translation keeps its ru key's {holes} (a dropped
// {version} silently swallows the value in one language only), and the
// uz/en of a Cyrillic-keyed entry is never a byte-copy of the ru
// (a transliteration is not a translation).
//
// The two per-screen guards (views/updates-i18n.test.js,
// views/branch-sync-i18n.test.js) stay: they test BEHAVIOUR — that the
// screens' logic produces dictionary-known templates. This file tests
// COVERAGE, so a new screen is born guarded.
//
// ---------------------------------------------------------------------------
// NAMED EXCLUSIONS — every one is a decision, not a silent skip.
// ---------------------------------------------------------------------------

// (a) Print-document builders. Printed blanks (fiscal receipt, lab result
//     sheet, designed document variants) are deliberately Russian or
//     deliberately bilingual ru·uz — the same design decision as the
//     server's Russian REASONS maps. Their vocabulary lives in _RU maps
//     (METHOD_RU, GENDER_RU, ROLE_RU, labSexRu) by design.
const PRINT_DOC_FILES = new Set([
  'views/doc-variants.js',    // renderers of full printed HTML documents
  'views/receipt-print.js',   // fiscal receipt builder (METHOD_RU/GENDER_RU)
  'views/lab-doc.js',         // printed lab blank helpers (labSexRu, М:/Ж:)
]);

// (b) The dictionary itself and the runtime: keys ARE source strings, and
//     i18n.js's inline I18N object IS the translations. Tests are not UI.
const EXCLUDE_FILES = new Set(['i18n-strings.js', 'i18n.js']);

// (c) In-code pragmas. `// i18n-exempt: <reason>` exempts its own line and
//     the next; `/* i18n-exempt-start: <reason> */ … /* i18n-exempt-end */`
//     exempts a block. They mark, in place, the Russian that is NOT screen
//     text: strings written INTO the database (payment notes, activity-log
//     summaries — stored records, read back as data), print-document
//     payloads inside mixed files, console diagnostics, algorithm constants
//     (the ё→е normaliser, the УДАЛИТЬ confirm word, report-totals' column
//     heuristics), the Excel import contract (IMPORT_CONFIGS keys/aliases/
//     values are what the user must literally type in the file), and
//     bilingual catalogue seeds (ICD_SEED). A pragma without a reason after
//     the colon FAILS below — the reason is the point.
//
// (d) console.* lines — developer logs, out of the audit's scope by
//     definition.

// (e) Proper-name placeholder examples. These are sample people/places in
//     input placeholders (`«Чиланзар»`-style); a name is not translated.
//     Every entry here must still OCCUR in the scanned sources — a stale
//     name in this list would hide a future real string, so that is
//     asserted too.
const EXAMPLE_STRINGS = new Set([
  'Иванов Иван',              // api-settings curl / request-fields sample patient
  'Азиза', 'Каримова', 'Рустамовна',   // crm new-lead form placeholders
  'Акмалович', 'Араббек', 'Каюмов',    // employees form placeholders
  'Абдукаюмов Баходир', 'БА',          // pacs placeholder patient + initials
  // 'Каримов Рустам Аброрович' стоял здесь как образец ФИО опекуна в форме
  // регистрации. Раздел опекуна убран ещё OPEKUN_REMOVED_V1, а сама страница —
  // PATIENT_ONE_WINDOW_V1 (2026-09-05); строки в коде больше нет, и держать её
  // в списке нельзя: этот список сам себя проверяет — устаревшее имя спрятало
  // бы будущую настоящую строку.
  'Юнусабад-3',                        // образец адреса в окне заведения пациента
]);
// (The topbar language switcher, for the record, is plain "UZ/RU/EN" markup
// in admin.html — no Cyrillic switcher labels exist in the scoped JS, so no
// exclusion is needed for it.)

const LANGS = ['ru', 'uz', 'en'];
const CYRILLIC = /[Ѐ-ӿ]/;
const BS = String.fromCharCode(92);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== '__tests__') yield* walk(path.join(dir, e.name)); }
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js') && !e.name.endsWith('.test.mjs') && !EXCLUDE_FILES.has(e.name)) yield path.join(dir, e.name);
  }
}

// ---------------------------------------------------------------------------
// Tokenizer. One recursive scanner: comments and regex bodies are blanked
// (a regex like /[&<>"]/ used to desync every naive quote-scanner here and
// HID whole regions of patient-card/procurement from the first audit pass),
// strings and template literals are emitted with positions, and ${holes}
// are parsed recursively — service-workspace's print templates nest
// `${x ? `<i>…</i>` : ''}` arbitrarily deep. `code` keeps src's length, so
// an index in `code` is an index in the file.
// ---------------------------------------------------------------------------
function tokenize(src) {
  const lits = [];
  let out = '';
  let i = 0;

  function regexAhead() {
    const m = out.replace(/[\s]+$/, '');
    if (!m) return true;
    const ch = m[m.length - 1];
    if ('(,=:[!&|?{};+-*%~^<>'.includes(ch)) return true;
    return /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|case|do|else|void|new|delete)$/.test(m);
  }
  function scanLineComment() { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } }
  function scanBlockComment() {
    out += '  '; i += 2;
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
    out += '  '; i += 2;
  }
  function scanRegex() {
    out += ' '; i++;
    let inClass = false;
    while (i < src.length) {
      const r = src[i];
      if (r === BS) { out += '  '; i += 2; continue; }
      if (r === '[') inClass = true;
      else if (r === ']') inClass = false;
      else if (r === '/' && !inClass) { out += ' '; i++; break; }
      else if (r === '\n') { out += '\n'; i++; return; }   // was a division — bail
      out += ' '; i++;
    }
    while (i < src.length && /[a-z]/i.test(src[i])) { out += ' '; i++; }
  }
  function scanString(q) {
    const start = i;
    out += src[i]; i++;
    let raw = '';
    while (i < src.length) {
      if (src[i] === BS) { raw += src[i] + (src[i + 1] || ''); out += src[i] + (src[i + 1] || ''); i += 2; continue; }
      if (src[i] === q) { out += src[i]; i++; break; }
      if (src[i] === '\n') break;
      raw += src[i]; out += src[i]; i++;
    }
    lits.push({ start, end: i, quote: q, raw });
  }
  function scanTemplate() {
    const start = i;
    out += src[i]; i++;
    let raw = '';
    const holes = [];
    while (i < src.length) {
      if (src[i] === BS) { raw += src[i] + (src[i + 1] || ''); out += src[i] + (src[i + 1] || ''); i += 2; continue; }
      if (src[i] === '`') { out += src[i]; i++; break; }
      if (src[i] === '$' && src[i + 1] === '{') {
        raw += '${'; out += '${'; i += 2;
        const holeStart = i;
        scanCode(1);
        const holeText = src.slice(holeStart, i - 1);
        raw += holeText + '}';
        holes.push(holeText);
        continue;
      }
      raw += src[i]; out += src[i]; i++;
    }
    lits.push({ start, end: i, quote: '`', raw, holes });
  }
  function scanCode(depth) {
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { scanLineComment(); continue; }
      if (c === '/' && src[i + 1] === '*') { scanBlockComment(); continue; }
      if (c === "'" || c === '"') { scanString(c); continue; }
      if (c === '`') { scanTemplate(); continue; }
      if (c === '/' && regexAhead()) { scanRegex(); continue; }
      if (c === '{') { depth++; out += c; i++; continue; }
      if (c === '}') { depth--; out += c; i++; if (depth === 0) return; continue; }
      out += c; i++;
    }
  }
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { scanLineComment(); continue; }
    if (c === '/' && src[i + 1] === '*') { scanBlockComment(); continue; }
    if (c === "'" || c === '"') { scanString(c); continue; }
    if (c === '`') { scanTemplate(); continue; }
    if (c === '/' && regexAhead()) { scanRegex(); continue; }
    out += c; i++;
  }
  return { code: out, lits };
}

// Exempt lines: pragmas + console lines. Pragma reasons are validated by a
// dedicated test below.
function exemptLines(src) {
  const lines = src.split(/\r?\n/);
  const ex = new Set();
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.includes('i18n-exempt-start:')) { inBlock = true; ex.add(i + 1); continue; }
    if (L.includes('i18n-exempt-end')) { inBlock = false; ex.add(i + 1); continue; }
    if (inBlock) { ex.add(i + 1); continue; }
    if (L.includes('i18n-exempt:')) { ex.add(i + 1); ex.add(i + 2); }
    if (/console\.(log|warn|error|info|debug|groupCollapsed|table|group)\s*\(/.test(L)) ex.add(i + 1);
  }
  return ex;
}

// The runtime string a literal produces — dictionary keys hold REAL newlines,
// the source holds the two characters backslash-n.
function unescapeLiteral(raw) {
  let s = ''; let k = 0;
  const map = { n: '\n', t: '\t', r: '\r' };
  while (k < raw.length) {
    if (raw[k] === BS && k + 1 < raw.length) {
      const c = raw[k + 1];
      if (c === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(k + 2, k + 6))) { s += String.fromCharCode(parseInt(raw.slice(k + 2, k + 6), 16)); k += 6; continue; }
      s += map[c] !== undefined ? map[c] : c;
      k += 2; continue;
    }
    s += raw[k]; k++;
  }
  return s;
}

function splitTemplate(raw) {
  let statics = ''; const holes = [];
  let k = 0;
  while (k < raw.length) {
    if (raw[k] === '$' && raw[k + 1] === '{') {
      k += 2; let depth = 1; let expr = '';
      while (k < raw.length && depth > 0) {
        if (raw[k] === '{') depth++;
        else if (raw[k] === '}') { depth--; if (!depth) break; }
        expr += raw[k]; k++;
      }
      k++; holes.push(expr);
      continue;
    }
    statics += raw[k]; k++;
  }
  return { statics, holes };
}

function dictComplete(runtime) {
  const e = STRINGS[runtime] || STRINGS[String(runtime).trim()];
  return !!e && LANGS.every((l) => typeof e[l] === 'string' && e[l].trim() !== '');
}

function scanFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ex = exemptLines(src);
  const { code, lits } = tokenize(src);
  const lineStarts = [0];
  for (let k = 0; k < code.length; k++) if (code[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= idx) lo = m; else hi = m - 1; }
    return lo + 1;
  };

  // fold '…' + '…' chains — a long string split over lines is ONE string
  const plain = lits.filter((t) => t.quote !== '`').sort((a, b) => a.start - b.start);
  const folded = [];
  let cur = null;
  for (const t of plain) {
    if (cur) {
      const between = code.slice(cur.end, t.start);
      if (/^\s*\+\s*$/.test(between)) { cur.raw += t.raw; cur.end = t.end; continue; }
      folded.push(cur);
    }
    cur = { ...t };
  }
  if (cur) folded.push(cur);

  const out = { concat: [], tpl: [], missing: [], checked: 0 };
  for (const g of folded) {
    if (!CYRILLIC.test(g.raw)) continue;
    const line = lineOf(g.start);
    if (ex.has(line)) continue;
    const runtime = unescapeLiteral(g.raw);
    if (EXAMPLE_STRINGS.has(runtime.trim())) continue;
    out.checked++;
    const before = code.slice(0, g.start).replace(/\s+$/, '');
    const after = code.slice(g.end).replace(/^\s+/, '');
    if (before.endsWith('+') || after.startsWith('+')) { out.concat.push({ line, raw: runtime.slice(0, 90) }); continue; }
    if (!dictComplete(runtime)) out.missing.push({ line, raw: runtime.slice(0, 120) });
  }
  for (const t of lits) {
    if (t.quote !== '`') continue;
    const line = lineOf(t.start);
    if (ex.has(line)) continue;
    const { statics, holes } = splitTemplate(t.raw);
    if (holes.length && CYRILLIC.test(statics)) { out.tpl.push({ line, raw: t.raw.slice(0, 100) }); continue; }
    if (!holes.length && CYRILLIC.test(statics)) {
      const runtime = unescapeLiteral(t.raw);
      if (EXAMPLE_STRINGS.has(runtime.trim())) continue;
      out.checked++;
      if (!dictComplete(runtime)) out.missing.push({ line, raw: runtime.slice(0, 120) });
    }
    for (const hx of holes) {
      if (!CYRILLIC.test(hx)) continue;
      const naked = hx.replace(/\b(?:tr|trf|t)\(\s*(['"])(?:\\.|(?!\1).)*?\1/g, '__TR__');
      if (CYRILLIC.test(naked)) out.tpl.push({ line, raw: '${' + hx.slice(0, 90) + '}' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The scan itself, once, shared by the tests below.
// ---------------------------------------------------------------------------
const results = [];
let totalChecked = 0;
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  if (PRINT_DOC_FILES.has(rel)) continue;
  const r = scanFile(f);
  totalChecked += r.checked;
  results.push({ file: rel, ...r });
}

test('the scan sees the admin UI (a broken extractor must not pass as a clean one)', () => {
  // ~3000+ Cyrillic literals live in the scoped files. If this ever collapses
  // it means the tokenizer stopped matching, not that the UI shrank.
  assert.ok(results.length >= 90, `expected 90+ scoped files, saw ${results.length}`);
  assert.ok(totalChecked >= 3000, `expected 3000+ checked Cyrillic literals, saw ${totalChecked}`);
});

test('shape 2a: no Russian literal is glued to a value with + (tr() matches whole strings)', () => {
  const bad = [];
  for (const r of results) for (const x of r.concat) bad.push(`  ${r.file}:${x.line}  ${JSON.stringify(x.raw)}`);
  assert.deepEqual(bad, [], 'restructure into trf(\'…{hole}…\', {…}) — translation FIRST, substitution SECOND:\n' + bad.join('\n'));
});

test('shape 2b: no template literal assembles Russian around ${holes}', () => {
  const bad = [];
  for (const r of results) for (const x of r.tpl) bad.push(`  ${r.file}:${x.line}  ${JSON.stringify(x.raw)}`);
  assert.deepEqual(bad, [], 'keep the WHOLE sentence with {holes} as the dictionary key (trf), or tr() each piece before assembly:\n' + bad.join('\n'));
});

test('shape 1: every bare Russian literal is a dictionary key complete in ru, uz and en', () => {
  const bad = [];
  for (const r of results) for (const x of r.missing) bad.push(`  ${r.file}:${x.line}  ${JSON.stringify(x.raw)}`);
  assert.deepEqual(bad, [], 'tr() ships the Russian source for anything it cannot find — add REAL uz/en entries to i18n-strings.js:\n' + bad.join('\n'));
});

test('dictionary invariants: complete languages, hole parity, no ru-copies', () => {
  const bad = [];
  for (const [k, e] of Object.entries(STRINGS)) {
    for (const l of LANGS) {
      if (typeof e[l] !== 'string' || e[l].trim() === '') bad.push(`  ${JSON.stringify(k.slice(0, 60))} — no ${l}`);
    }
    const holes = [...k.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const l of LANGS) {
      const got = [...String(e[l] || '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      if (got !== holes) bad.push(`  ${JSON.stringify(k.slice(0, 60))} [${l}] holes {${got}} ≠ {${holes}} — a dropped hole swallows the value in ONE language`);
    }
    if (CYRILLIC.test(k)) {
      for (const l of ['uz', 'en']) if (e[l] === e.ru) bad.push(`  ${JSON.stringify(k.slice(0, 60))} — ${l} is a copy of ru (a transliteration is not a translation)`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('every i18n-exempt pragma states its reason (an exclusion is a decision, not a skip)', () => {
  const bad = [];
  for (const f of walk(ROOT)) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const m = L.match(/i18n-exempt(?:-start)?:\s*(.*)$/);
      if (m && m[1].replace(/\*\/\s*$/, '').trim().length < 8) bad.push(`  ${rel}:${i + 1} — pragma without a reason`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('the proper-name example list matches reality (a stale name would hide a real string)', () => {
  const all = [];
  for (const f of walk(ROOT)) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (PRINT_DOC_FILES.has(rel)) continue;
    all.push(fs.readFileSync(f, 'utf8'));
  }
  const blob = all.join('\n');
  const stale = [...EXAMPLE_STRINGS].filter((s) => !blob.includes(s));
  assert.deepEqual(stale, [], 'these EXAMPLE_STRINGS no longer occur in the scoped sources — remove them:\n  ' + stale.join('\n  '));
});
