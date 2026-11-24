// WS_FRAME_COLOURS_V1 (2026-11-24) — владелец: «кнопка направления пропала» (кабинет врача,
// «Направить на услуги» — белая надпись на пустом фоне).
//
// ПРИЧИНА. Бланк кабинета живёт в своём iframe: туда пишется HTML шаблона и стиль,
// который кабинет вставляет сам (_wireBlankPreview / _wireBlankEditing). admin.css в
// iframe НЕ грузится — его переменных (--brand-gradient, --primary-600, …) там нет.
// Слияние 806279ee (v3.27.0) заменило у кнопки сплошной #355c7d на var(--brand-gradient)
// без запасного значения: в iframe переменная не определена → фон прозрачный, текст белый.
//
// ПРАВИЛО. В стиле, который кабинет вставляет в iframe бланка, у каждой var(--…) есть
// запасное значение — переменные админки там не существуют.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../views/service-workspace.js', import.meta.url), 'utf8');

function frameStyle(fnName) {
    const at = src.indexOf('function ' + fnName + '(');
    assert.ok(at > 0, fnName + ' на месте');
    const from = src.indexOf("const st = doc.createElement('style')", at);
    const to = src.indexOf('doc.head.appendChild(st)', from);
    assert.ok(from > at && to > from, fnName + ': стиль iframe найден');
    return src.slice(from, to);
}

for (const fn of ['_wireBlankPreview', '_wireBlankEditing']) {
    test(`${fn}: у каждой var(--…) в стиле iframe есть запасное значение`, () => {
        const bare = frameStyle(fn).match(/var\(--[\w-]+\)/g) || [];
        assert.deepEqual(bare, [], 'переменные админки в iframe бланка не определены — нужен запасной цвет');
    });
}

test('«Направить на услуги» (.ws-primary) — с настоящим цветом фона и при наведении', () => {
    const css = frameStyle('_wireBlankEditing');
    const rule = (sel) => {
        const m = css.match(new RegExp(sel.replace(/[.[\]]/g, '\\$&') + '\\{([^}]*)\\}'));
        assert.ok(m, sel + ' есть');
        return m[1];
    };
    for (const sel of ['[data-ws-actions] button.ws-primary', '[data-ws-actions] button.ws-primary:hover']) {
        const body = rule(sel);
        assert.match(body, /background:[^;]*#[0-9a-f]{6}/i, sel + ': фон с запасным цветом');
        assert.match(body, /color:#fff|border-color:transparent/, sel + ': оформление на месте');
    }
});
