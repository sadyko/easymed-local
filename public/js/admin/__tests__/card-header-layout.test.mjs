// CARD_HEADER_GROUP_V1 (2026-11-20) — шапка карточки: заголовок слева, кнопки
// одной группой справа.
//
// Снимок владельца («correct such design errors»): «Список источников» —
// Шаблон, Импорт, Экспорт и Добавить стояли через всю ширину шапки на равных
// расстояниях. Причина — общее правило .card-header в admin.css:
// `justify-content: space-between` раскладывает ВСЕХ детей поровну, и пока
// детей два (заголовок и кнопка), это выглядит правильно, а с тремя и больше —
// нет. Чинится там же, для всех шапок разом: первый ребёнок (заголовок)
// забирает свободное место (`margin-right: auto`), остальное прижимается
// вправо через обычный gap. С двумя детьми раскладка не меняется ни на пиксель.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'admin.css'), 'utf8').replace(/\r\n/g, '\n');

test('первый элемент шапки карточки забирает свободное место — кнопки собираются справа', () => {
  const m = /\.card-header\s*>\s*:first-child\s*\{([^}]*)\}/.exec(css);
  assert.ok(m, 'нет правила .card-header > :first-child');
  assert.match(m[1], /margin-right:\s*auto/, 'заголовок не отталкивает кнопки вправо');
});

test('кнопки шапки на узком экране переносятся, а не вылезают за край', () => {
  const m = /\.card-header\s*\{([^}]*)\}/.exec(css);
  assert.ok(m, 'нет правила .card-header');
  assert.match(m[1], /flex-wrap:\s*wrap/, 'шапка не переносит кнопки на узком экране');
});
