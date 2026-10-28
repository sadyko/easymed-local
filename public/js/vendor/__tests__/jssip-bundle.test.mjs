// SOFTPHONE_V1 — бандл JsSIP: один ESM-файл без внешних импортов, отдаёт UA и WebSocketInterface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../jssip-3.13.9.mjs', import.meta.url));

test('бандл JsSIP: файл есть, импортов наружу нет', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.ok(src.length > 100000, 'бандл подозрительно мал');
  assert.equal(/\bfrom\s+['"](?!\.)/.test(src) || /\brequire\(/.test(src), false, 'внешних import/require быть не должно');
});

test('бандл JsSIP: UA и WebSocketInterface — конструкторы', async () => {
  const m = await import('../jssip-3.13.9.mjs');
  const J = m.default || m;
  assert.equal(typeof J.UA, 'function');
  assert.equal(typeof J.WebSocketInterface, 'function');
  assert.match(String(J.version || ''), /^3\.13\./);
});

test('лицензия MIT лежит рядом', () => {
  const lic = fs.readFileSync(fileURLToPath(new URL('../jssip-LICENSE.md', import.meta.url)), 'utf8');
  assert.match(lic, /MIT|Permission is hereby granted/);
});
