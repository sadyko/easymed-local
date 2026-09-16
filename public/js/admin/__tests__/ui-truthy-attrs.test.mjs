// UI_TRUTHY_ATTRS_V1 (2026-09-16) — «ВЫБРАНО» ОТМЕЧАЮТ ИСТИНОЙ, А НЕ ПУСТОЙ
// СТРОКОЙ.
//
// h() (admin/ui.js) ставит `checked`, `disabled` и `selected` ТОЛЬКО когда
// значение истинно: `if (v) el.setAttribute(k, '')`. Пустая строка ложна,
// поэтому запись `selected: x === y ? '' : null` не отмечает НИЧЕГО — и
// браузер показывает первый пункт списка.
//
// Цена ошибки — не косметика. Так был сломан календарь даты рождения (список
// открывался на «Феврале 2031»), и так же вели себя списки в скидках: правка
// скидки показывала «Процент» у суммовой скидки, а сохранение переписывало вид
// скидки на показанный. Тот же приём — в приборах лаборатории: галочка
// «Включён» никогда не выглядела отмеченной.
//
// Тест статический: он читает исходники, а не запускает экраны, — зато видит
// ВСЕ такие места сразу, включая те, до которых ни один тест не доходит.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_ROOT = path.join(HERE, '..', '..');   // public/js

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== '__tests__') walk(p, out); }
        else if (e.name.endsWith('.js') && !e.name.includes('.test.')) out.push(p);
    }
    return out;
}

test('ни один экран не отмечает checked/selected/disabled пустой строкой', () => {
    const bad = [];
    const rx = /(checked|selected|disabled)\s*:\s*[^,}\n]*\?\s*''\s*:/g;
    for (const file of walk(JS_ROOT)) {
        const src = fs.readFileSync(file, 'utf8');
        const lines = src.split('\n');
        lines.forEach((line, i) => {
            rx.lastIndex = 0;
            if (rx.test(line)) bad.push(path.relative(JS_ROOT, file).replace(/\\/g, '/') + ':' + (i + 1) + '  ' + line.trim().slice(0, 90));
        });
    }
    assert.deepEqual(bad, [],
        'пустая строка здесь значит «не отмечено» — пишите `? true : null`:\n' + bad.join('\n'));
});

test('h() действительно ставит эти атрибуты только по истинному значению', () => {
    // Правило проверяется у ИСТОЧНИКА: если h() однажды научится понимать '',
    // тест выше станет лишним — и об этом надо узнать здесь, а не гадать.
    const ui = fs.readFileSync(path.join(JS_ROOT, 'admin', 'ui.js'), 'utf8');
    assert.match(ui, /k === 'checked' \|\| k === 'disabled' \|\| k === 'selected'\) \{ if \(v\)/,
        'изменилось правило h() для checked/disabled/selected — проверьте тест выше');
});
