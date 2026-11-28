// STAFF_ATTENDANCE_V1 — вендоренный qrcode-generator 1.4.4: один файл без внешних импортов, лицензия MIT рядом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../qrcode-generator-1.4.4.cjs', import.meta.url));

test('qrcode-generator: файл есть, внешних require/import и сети нет', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.ok(src.length > 40000);
  assert.equal(/\brequire\(/.test(src) || /\bfrom\s+['"]/.test(src), false);
  assert.equal(/fetch\(|XMLHttpRequest/.test(src), false);
});

test('qrcode-generator: строит код со ссылкой на бота', () => {
  const qrcode = createRequire(import.meta.url)(FILE);
  const qr = qrcode(0, 'M');
  qr.addData('https://t.me/clinic_staff_bot?start=a_1_88000000_AAAAAAAAAAAAAAAA');
  qr.make();
  assert.ok(qr.getModuleCount() >= 25);
});

test('лицензия MIT лежит рядом', () => {
  const lic = fs.readFileSync(fileURLToPath(new URL('../qrcode-generator-LICENSE.md', import.meta.url)), 'utf8');
  assert.match(lic, /Permission is hereby granted/);
});
