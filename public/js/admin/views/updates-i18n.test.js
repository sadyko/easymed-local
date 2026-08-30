import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STRINGS } from '../i18n-strings.js';
import {
  fill, formatScheduled, updateOutcomeMessage, pendingRestartMessage,
  upToDateMessage, progressView,
} from '../updates-logic.js';

// UPDATES_I18N_V1 (2026-08-30) — the test that stops the Updates screen from
// drifting back into Russian.
//
// The owner photographed a clinic running fully in Uzbek — «Tizim»,
// «Yangilanishlarni tekshirish», «Joriy versiya: 0.4.5» — with the status line
// underneath it reading «У вас последняя версия — 0.4.5.» in Russian. The
// screen was 37 bare Cyrillic literals against 12 tr() calls, so every
// non-Russian clinic read a mixture.
//
// A dictionary alone cannot prevent that: tr() PASSES AN UNKNOWN STRING
// THROUGH UNCHANGED (i18n.js, deliberately — an untranslated screen must not
// crash). So a missed literal, or one that no key can ever match because it
// was concatenated, fails silently and looks exactly like a working screen to
// whoever wrote it. The only reliable check is this one: read the view's own
// source and assert the property directly.
//
// It reads SOURCE TEXT rather than importing the view, because views/updates.js
// imports ui.js/supabase.js and needs a DOM. This file needs neither.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = path.join(HERE, 'updates.js');

const CYRILLIC = /[Ѐ-ӿ]/;
const LANGS = ['ru', 'uz', 'en'];

/**
 * Remove comments while respecting string and template literals.
 *
 * A plain /\/\/.*$/ regex would delete half of «Обновление до 2.4.0 не
 * удалось…» at the first slash inside a string, and — worse for THIS test —
 * a rule written the other way round would treat the Russian prose in this
 * file's own header comments as untranslated UI text. Comments are where the
 * reasoning lives in this codebase; they must be excluded exactly.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const BACKSLASH = String.fromCharCode(92);
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === BACKSLASH) { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Every string literal containing Cyrillic, split by whether tr( is what precedes it. */
function collectLiterals(src) {
  const code = stripComments(src);
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  const translated = [];
  const bare = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    const raw = m[2];
    if (!CYRILLIC.test(raw)) continue;
    const before = code.slice(Math.max(0, m.index - 4), m.index);
    const entry = { raw, near: code.slice(Math.max(0, m.index - 70), m.index + 50).replace(/\s+/g, ' ') };
    if (/tr\($/.test(before)) translated.push(entry); else bare.push(entry);
  }
  return { translated, bare };
}

const viewSrc = fs.readFileSync(VIEW_PATH, 'utf8');

test('updates.js: no Cyrillic string reaches the screen without going through tr()', () => {
  const { bare } = collectLiterals(viewSrc);
  assert.deepEqual(
    bare.map((b) => b.raw),
    [],
    'each of these is a literal the Uzbek/English UI would render in Russian:\n' +
      bare.map((b) => `  ${JSON.stringify(b.raw)}\n    near: …${b.near}…`).join('\n'),
  );
});

test('updates.js: every string it hands tr() resolves in the dictionary, in all three languages', () => {
  const { translated } = collectLiterals(viewSrc);
  // The screen is not one or two strings; if this ever collapses to a handful
  // it means the extractor stopped matching, not that the screen got smaller.
  assert.ok(translated.length >= 20, `expected the whole screen to be routed through tr(), found only ${translated.length} calls`);

  const missing = [];
  for (const { raw } of translated) {
    const entry = STRINGS[raw];
    if (!entry) { missing.push(`${JSON.stringify(raw)} — not in STRINGS at all`); continue; }
    for (const lang of LANGS) {
      if (typeof entry[lang] !== 'string' || entry[lang].trim() === '') {
        missing.push(`${JSON.stringify(raw)} — no ${lang}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'tr() returns the SOURCE STRING for anything it cannot find, so these ship in Russian:\n  ' + missing.join('\n  '));
});

// The message templates updates-logic.js actually PRODUCES, gathered by
// calling it rather than by grepping it. A ternary inside `template:` and a
// lookup table of phase sentences both defeat a source regex, and a regex
// that silently matched nothing would turn this whole file into a test that
// passes because it checked nothing.
function everyMessageTemplate() {
  const out = new Set();
  const take = (msg) => {
    if (!msg) return;
    if (msg.template) out.add(msg.template);
    if (msg.extra) out.add(msg.extra);
    if (msg.title) take(msg.title);
    if (msg.detail) take(msg.detail);
    if (msg.note) take(msg.note);
  };

  take(formatScheduled({ hour: 3, scheduled_at: new Date(2026, 7, 21, 3, 0, 0).toISOString() }));
  take(formatScheduled({ hour: null, scheduled_at: '2026-08-23T15:30:00.000Z', immediate: true }));
  take(updateOutcomeMessage({ version: '0.4.6', ok: false, at: '2026-08-21T02:10:00.000Z', db: 'untouched' }, '0.4.5'));
  take(updateOutcomeMessage({ version: '0.4.6', ok: false, db: 'restored' }, '0.4.5'));   // no `at` — the second, undated template
  take(pendingRestartMessage({ ok: true, version: '0.4.6' }, '0.4.5'));
  take(upToDateMessage('0.4.5'));
  take(upToDateMessage(null));

  const base = { version: '0.4.6', bytes: 5 * 1024 * 1024, total: 40 * 1024 * 1024, age_ms: 1000 };
  take(progressView({ ...base, phase: 'downloading' }));
  take(progressView({ ...base, phase: 'downloading', total: null }));     // no Content-Length
  take(progressView({ ...base, phase: 'downloading', age_ms: 10 * 60 * 1000 }));   // stalled
  for (const phase of ['verifying', 'unpacking', 'snapshot', 'switching', 'interrupted', 'failed']) {
    take(progressView({ ...base, phase }));
  }
  return [...out];
}

test('updates-logic.js: every message template it returns is a dictionary key, in all three languages', () => {
  // The view renders these through say() → tr(template) → fill(). A template
  // the dictionary does not know is the same silent Russian passthrough, one
  // module further away from the screen.
  const all = everyMessageTemplate();
  assert.ok(all.length >= 15, `expected the screen's whole sentence set, found ${all.length}`);

  const missing = [];
  for (const raw of all) {
    const entry = STRINGS[raw];
    if (!entry) { missing.push(`${JSON.stringify(raw)} — not in STRINGS at all`); continue; }
    for (const lang of LANGS) {
      if (typeof entry[lang] !== 'string' || entry[lang].trim() === '') missing.push(`${JSON.stringify(raw)} — no ${lang}`);
    }
  }
  assert.deepEqual(missing, [], 'untranslatable message templates:\n  ' + missing.join('\n  '));
});

test('every translation of a template keeps the placeholders its Russian source has', () => {
  // A dropped {version} is how «У вас последняя версия — 0.4.5.» silently
  // becomes «Sizda eng soʻnggi versiya — .» in one language only, which
  // nobody who does not read that language will ever notice.
  const problems = [];
  for (const raw of everyMessageTemplate()) {
    const holes = [...raw.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    if (!holes.length) continue;
    const entry = STRINGS[raw];
    if (!entry) continue;   // reported by the test above
    for (const lang of LANGS) {
      const got = [...String(entry[lang] || '').matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
      if (got.join(',') !== holes.join(',')) {
        problems.push(`${JSON.stringify(raw)} [${lang}] has {${got.join('},{')}} but needs {${holes.join('},{')}}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('no translation is a copy of the Russian source (a transliteration is not a translation)', () => {
  // The Uzbek and English sides of this screen were written, not pasted. A
  // uz/en value identical to the ru one is the tell-tale of a placeholder
  // entry that was never actually filled in.
  const same = [];
  const check = (raw) => {
    const e = STRINGS[raw];
    if (!e) return;
    for (const lang of ['uz', 'en']) {
      if (e[lang] === e.ru) same.push(`${JSON.stringify(raw)} — ${lang} is identical to ru`);
    }
  };
  for (const raw of everyMessageTemplate()) check(raw);
  for (const { raw } of collectLiterals(viewSrc).translated) check(raw);
  assert.deepEqual(same, [], same.join('\n'));
});

test('translating twice is the same as translating once (h() already tr()s its text children)', () => {
  // ui.js's h() runs tr() over every plain-text child and over aria-label, so
  // an explicitly-wrapped tr('…') passed to h() IS translated twice. That is
  // harmless only while no translation is itself a key meaning something
  // else — and STRINGS does contain English keys ("Updated", "Loading…"), so
  // this is a real trap, not a theoretical one. A future entry whose English
  // side collides with another key would silently re-translate this screen's
  // text into something else in one language only.
  //
  // The explicit tr() calls stay: they make the routing visible in the view
  // and cover the paths h() does not touch (toast, textContent, say()). This
  // test is what keeps them safe.
  const used = new Set(everyMessageTemplate());
  for (const { raw } of collectLiterals(viewSrc).translated) used.add(raw);

  const problems = [];
  for (const raw of used) {
    const entry = STRINGS[raw];
    if (!entry) continue;   // reported by the tests above
    for (const lang of LANGS) {
      const once = entry[lang];
      const again = STRINGS[once];
      if (again && again[lang] !== once) {
        problems.push(`${JSON.stringify(raw)} [${lang}] → ${JSON.stringify(once)} → ${JSON.stringify(again[lang])}`);
      }
    }
  }
  assert.deepEqual(problems, [], 'double translation changes these:\n  ' + problems.join('\n  '));
});

test('fill(): the values go back in AFTER translation, and an unknown hole is left visible', () => {
  assert.equal(fill('У вас последняя версия — {version}.', { version: '0.4.5' }), 'У вас последняя версия — 0.4.5.');
  assert.equal(fill('Sizda eng soʻnggi versiya — {version}.', { version: '0.4.5' }), 'Sizda eng soʻnggi versiya — 0.4.5.');
  // Same hole twice — .split/.join, not .replace, which only does the first.
  assert.equal(fill('{a} и {a}', { a: 'x' }), 'x и x');
  // A misspelled placeholder must look broken, never silently swallow the value.
  assert.equal(fill('версия {versoin}', { version: '1' }), 'версия {versoin}');
  assert.equal(fill(null, { a: 1 }), '');
  assert.equal(fill('нет дырок', null), 'нет дырок');
});
