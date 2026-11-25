// WS_PRIMARY_VISIBLE_V1 (2026-11-23) — «Направить на услуги» под листом приёма
// была невидимой: белый текст на почти белой подложке (снимок владельца).
//
// Причина: панель действий рисуется ВНУТРИ iframe листа, а стили этого iframe
// пишутся строкой в service-workspace.js — admin.css туда не грузится. Правка
// 22.11 (новый набор значков) заменила сплошной цвет кнопки на
// `var(--brand-gradient)`, а эта переменная живёт только в admin.css. В iframe
// она не определена, фон кнопки становится прозрачным, и остаётся белый текст
// на #f8fafc.
//
// Правило: каждая переменная темы в стилях iframe — либо с запасным значением,
// либо определена в самом iframe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'service-workspace.js'), 'utf8');

test('кнопка ws-primary не опирается на переменную темы без запасного значения', () => {
  const rules = src.split('\n').filter((l) => l.includes('button.ws-primary'));
  assert.ok(rules.length >= 2, 'правила ws-primary на месте');
  for (const l of rules) {
    assert.doesNotMatch(l, /var\(--brand-gradient(-hover)?\)/,
      'var(--brand-gradient) без запасного значения — в iframe листа его нет, кнопка становится невидимой');
  }
});

test('iframe листа получает цвета темы с главной страницы', () => {
  assert.ok(src.includes("getPropertyValue('--brand-gradient')"),
    'переменная темы не переносится из главной страницы в iframe листа');
});
