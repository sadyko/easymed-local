// DEPT_ICONS_V1 — иконка отделения для плитки на главной.

import test from 'node:test';
import assert from 'node:assert/strict';
import { deptIcon, hasDeptIcon } from './dept-icons.js';

// Все двенадцать отделений клиники должны быть опознаны: общая иконка на
// половине блока выглядела бы как поломка, а не как оформление.
const LIVE = ['ambulatornyy', 'ginekologiya', 'diagnostika', 'laboratoriya', 'lor',
              'neyrohirurgiya', 'radiologiya', 'statsionar', 'travmatologiya',
              'urologiya', 'flebologiya', 'endokrinologiya'];

test('у каждого заведённого отделения своя иконка', () => {
  for (const slug of LIVE) {
    assert.equal(hasDeptIcon(slug), true, 'без иконки осталось: ' + slug);
  }
});

test('иконки отделений не повторяются', () => {
  const seen = new Map();
  for (const slug of LIVE) {
    const icon = deptIcon(slug);
    assert.equal(seen.has(icon), false,
      slug + ' и ' + seen.get(icon) + ' получили одну и ту же картинку');
    seen.set(icon, slug);
  }
});

// Ключ — slug, а не название: название переводится, и привязка к нему означала
// бы, что на узбекской версии сайта иконки пропадут.
test('регистр и язык названия на выбор не влияют', () => {
  assert.equal(deptIcon('GINEKOLOGIYA'), deptIcon('ginekologiya'));
});

// Отделение, заведённое позже под похожим именем, должно получить осмысленную
// иконку без правки кода.
test('похожий slug получает ту же осмысленную иконку', () => {
  assert.equal(deptIcon('detskaya-urologiya'), deptIcon('urologiya'));
  assert.equal(deptIcon('ginekologiya-2'), deptIcon('ginekologiya'));
});

// Незнакомому отделению даём общую иконку, а НЕ пустоту: пустая ячейка в ряду
// оформленных читается как сломанная вёрстка.
test('незнакомое отделение получает общую иконку, а не пустоту', () => {
  for (const bad of ['kosmetologiya', '', null, undefined, 42]) {
    const icon = deptIcon(bad);
    assert.match(icon, /^<svg /, JSON.stringify(bad));
    assert.equal(hasDeptIcon(bad), false, JSON.stringify(bad));
  }
});

// Иконка вставляется в HTML как есть — в ней не должно быть ничего, что
// закроет svg и откроет что-то другое.
test('иконка — это только svg, без посторонней разметки', () => {
  for (const slug of LIVE.concat(['неизвестно'])) {
    const icon = deptIcon(slug);
    assert.match(icon, /^<svg [^>]*>[\s\S]*<\/svg>$/, slug);
    assert.equal(icon.includes('<script'), false, slug);
    assert.equal(icon.includes('</svg><'), false, slug);
  }
});

// Блок оформлен в той же манере, что «почему мы» (VALUE_ICONS в home.js):
// иначе один ряд на странице выглядел бы чужим.
test('манера рисунка совпадает с остальными иконками сайта', () => {
  const icon = deptIcon('lor');
  assert.match(icon, /viewBox="0 0 24 24"/);
  assert.match(icon, /stroke="currentColor"/);
  assert.match(icon, /stroke-width="1\.6"/);
  assert.match(icon, /aria-hidden="true"/, 'для читалки экрана иконка — украшение');
});
