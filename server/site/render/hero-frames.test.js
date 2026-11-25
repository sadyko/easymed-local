// HERO_SLIDESHOW_V1 — какие кадры показывает заголовок.

import test from 'node:test';
import assert from 'node:assert/strict';
import { heroFrames } from './home.js';

test('список фотографий используется, когда он заведён', () => {
  assert.deepEqual(heroFrames({ photos: ['a.png', 'b.png', 'c.png'] }), ['a.png', 'b.png', 'c.png']);
});

// Пара img1/img2 должна продолжать работать: у владельца УЖЕ загружено одно
// фото этим способом, и пустой заголовок после обновления был бы поломкой.
test('без списка берётся прежняя пара img1/img2', () => {
  assert.deepEqual(heroFrames({ img1: 'one.png', img2: 'two.png' }), ['one.png', 'two.png']);
  assert.deepEqual(heroFrames({ img1: 'one.png' }), ['one.png']);
});

test('список главнее пары: он заведён именно под слайдшоу', () => {
  assert.deepEqual(heroFrames({ photos: ['s.png'], img1: 'old.png' }), ['s.png']);
});

// Элементы списка могут прийти и строкой, и объектом с path — редактор
// изображений в админке хранит путь, но форма списка со временем обрастает.
test('элемент списка принимается и строкой, и объектом', () => {
  assert.deepEqual(heroFrames({ photos: ['a.png', { path: 'b.png' }] }), ['a.png', 'b.png']);
});

test('пустые значения отбрасываются, а не превращаются в пустые кадры', () => {
  assert.deepEqual(heroFrames({ photos: ['a.png', '', null, { path: '' }] }), ['a.png']);
  assert.deepEqual(heroFrames({ img1: '', img2: 'b.png' }), ['b.png']);
});

test('без фотографий кадров нет', () => {
  for (const raw of [{}, null, undefined, { photos: [] }, { photos: 'не массив' }]) {
    assert.deepEqual(heroFrames(raw), [], JSON.stringify(raw));
  }
});
