// CLINIC_PROFILE_V1 — правила логотипов клиники: одни для экрана «Компания» до
// отправки и для хранилища после (routes/storage.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pngInfo, logoRefusal, isSquarePngDataUrl, LOGO_TEMPLATES, MAX_LOGO_BYTES } from './clinic-logo-rules.js';
import { fakePng, pngDataUrl } from '../../../server/test-helpers/fake-png.js';
import { STRINGS } from '../admin/i18n-strings.js';

test('pngInfo: размеры и прозрачность из заголовка; не PNG — null', () => {
  assert.deepEqual(pngInfo(fakePng(512, 512)), { width: 512, height: 512, hasAlpha: true });
  assert.deepEqual(pngInfo(fakePng(600, 800, { colorType: 2 })), { width: 600, height: 800, hasAlpha: false });
  assert.equal(pngInfo(fakePng(300, 300, { colorType: 3, trns: true })).hasAlpha, true, 'палитра с tRNS — прозрачная');
  assert.equal(pngInfo(fakePng(300, 300, { colorType: 3 })).hasAlpha, false, 'палитра без tRNS — непрозрачная');
  assert.equal(pngInfo(Buffer.from('GIF89a......................................')), null);
  assert.equal(pngInfo(new Uint8Array(10)), null);
});

test('квадратный: PNG, прозрачный, стороны равны (±2%), 256–2048 px, до 1 МБ', () => {
  const ok = (w, h, o) => logoRefusal({ kind: 'square', name: 'logo.png', bytes: fakePng(w, h, o) });
  assert.equal(ok(512, 512), null);
  assert.equal(ok(512, 520), null, 'в пределах 2%');
  assert.equal(ok(600, 500).code, 'logo_not_square');
  assert.equal(ok(512, 512, { colorType: 2 }).code, 'logo_not_transparent');
  assert.equal(ok(200, 200).code, 'logo_bad_size');
  assert.equal(ok(3000, 3000).code, 'logo_bad_size');
  assert.equal(logoRefusal({ kind: 'square', name: 'logo.jpg', bytes: fakePng(512, 512) }).code, 'logo_not_png');
  assert.equal(logoRefusal({ kind: 'square', name: 'logo.png', bytes: Buffer.from('not a png at all, really not, no no no no') }).code, 'logo_not_png');
  assert.equal(logoRefusal({ kind: 'square', name: 'logo.png', bytes: fakePng(512, 512, { pad: MAX_LOGO_BYTES }) }).code, 'file_too_large');
  assert.equal(logoRefusal({ kind: 'square', name: 'logo.png', bytes: Buffer.alloc(0) }).code, 'file_empty');
});

test('вертикальный: высота больше ширины', () => {
  assert.equal(logoRefusal({ kind: 'portrait', name: 'p.png', bytes: fakePng(600, 800) }), null);
  assert.equal(logoRefusal({ kind: 'portrait', name: 'p.png', bytes: fakePng(800, 800) }).code, 'logo_not_portrait');
});

test('отказ несёт шаблон и подстановки для перевода на экране', () => {
  const bad = logoRefusal({ kind: 'square', name: 'logo.png', bytes: fakePng(600, 500) });
  assert.equal(bad.template, LOGO_TEMPLATES.notSquare);
  assert.deepEqual(bad.params, { w: '600', h: '500' });
});

test('печатная копия: квадратная ли PNG-картинка в data URL — для знака в шапке программы', () => {
  assert.equal(isSquarePngDataUrl(pngDataUrl(fakePng(220, 220))), true);
  assert.equal(isSquarePngDataUrl(pngDataUrl(fakePng(220, 80))), false);
  assert.equal(isSquarePngDataUrl('data:image/jpeg;base64,AAAA'), false);
  assert.equal(isSquarePngDataUrl(''), false);
});

test('каждый отказ — шаблон словаря на ru / uz / en с теми же {дырками}', () => {
  for (const t of Object.values(LOGO_TEMPLATES)) {
    const e = STRINGS[t];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи: ' + t);
    for (const hole of t.match(/\{\w+\}/g) || []) assert.ok(e.uz.includes(hole) && e.en.includes(hole), t + ' теряет ' + hole);
  }
});
