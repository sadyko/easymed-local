import test from 'node:test';
import assert from 'node:assert/strict';
import { t, pickContent, langUrl, otherLangs } from './i18n.js';

test('t: все три языка отвечают на каждый ключ формы', () => {
  for (const lang of ['uz', 'ru', 'en']) {
    for (const key of ['form.name', 'form.phone', 'form.submit', 'cta.book', 'nav.doctors']) {
      const v = t(lang, key);
      assert.ok(v && v !== key, `${lang}:${key} должен быть переведён`);
    }
  }
});

test('t: неизвестный ключ возвращает сам ключ, не падает', () => {
  assert.equal(t('uz', 'no.such.key'), 'no.such.key');
});

test('pickContent: цепочка фолбэков и устойчивость к мусору', () => {
  const json = JSON.stringify({ ru: { name: 'Хирургия', body: 'Т' }, uz: { name: 'Jarrohlik' } });
  assert.equal(pickContent(json, 'uz').name, 'Jarrohlik');
  assert.equal(pickContent(json, 'uz').body, 'Т', 'недостающее поле берётся из другого языка');
  assert.equal(pickContent(json, 'en').name, 'Jarrohlik', 'en падает на uz');
  assert.deepEqual(pickContent('not json', 'uz'), {});
  assert.deepEqual(pickContent(null, 'uz'), {});
});

test('langUrl и otherLangs', () => {
  assert.equal(langUrl('ru', '/uz/doctors/aliev'), '/ru/doctors/aliev');
  assert.deepEqual(otherLangs('uz'), ['ru', 'en']);
});
