// FIX_318_V1 (DOC_RICH_FORMAT_V1) — ПЛАВАЮЩИЕ ПАНЕЛИ ЛИСТА ПРИ МАСШТАБЕ.
//
// Смоук-тест в настоящем браузере: при масштабе листа 130% (DOC_ZOOM_V1, по
// умолчанию) панель оформления вставала поверх поля, которое врач правит.
// Лист увеличен через body.style.zoom; getBoundingClientRect отдаёт координаты
// на экране (уже с масштабом), а left/top панели внутри увеличенного body
// браузер умножает на масштаб ещё раз. Выбор размера таблицы и панель таблицы
// считались той же формулой.
//
// Здесь — перевод экранной точки в координаты панели (floatAt) и место панели
// оформления (placeFormatBar) на поддельных размерах; в настоящем Chrome при
// 75/100/130/150% — отчёт FIX_318_V1 (headless).
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './cabinet-harness.mjs';

installFakeDom();
const WS = await import('../views/service-workspace.js');

/** Плавающий элемент при масштабе k: ширина в разметке w, на экране — w·k; left/top — в его px. */
function floating(k, w = 300, hgt = 33) {
    const style = {};
    const px = (v) => parseFloat(v) || 0;
    return {
        style, offsetWidth: w, offsetHeight: hgt,
        // где он на экране: начало документа (0,0) минус прокрутка + left/top × k
        getBoundingClientRect() {
            const left = px(style.left) * k - (this.__sx || 0), top = px(style.top) * k - (this.__sy || 0);
            return { left, top, width: w * k, height: hgt * k, right: left + w * k, bottom: top + hgt * k };
        },
    };
}
const rectEl = (r) => ({ getBoundingClientRect: () => ({ ...r, right: r.left + (r.width || 0), bottom: r.top + (r.height || 0) }) });
const docAt = (sx = 0, sy = 0) => ({ documentElement: { scrollLeft: sx, scrollTop: sy }, body: { scrollLeft: 0, scrollTop: 0 } });

test('FIX_318_V1: масштаб плавающего элемента — ширина на экране / ширина в разметке; без размеров — 1', () => {
    assert.ok(Math.abs(WS.floatScale(floating(1.3)) - 1.3) < 1e-9);
    assert.ok(Math.abs(WS.floatScale(floating(0.75)) - 0.75) < 1e-9);
    assert.equal(WS.floatScale(floating(1)), 1);
    assert.equal(WS.floatScale({ offsetWidth: 0, getBoundingClientRect: () => ({ width: 0 }) }), 1, 'скрытый — 1');
    assert.equal(WS.floatScale(null), 1);
});

test('FIX_318_V1: floatAt ставит элемент в экранную точку при любом масштабе и прокрутке; не ближе 6 px к краю', () => {
    for (const k of [0.75, 1, 1.3, 1.5]) {
        for (const [sx, sy] of [[0, 0], [0, 400]]) {
            const el = floating(k); el.__sx = sx; el.__sy = sy;
            WS.floatAt(el, 210, 380, { sx, sy });
            const r = el.getBoundingClientRect();
            assert.ok(Math.abs(r.left - 210) < 0.01 && Math.abs(r.top - 380) < 0.01, `k=${k} sy=${sy}: ${r.left},${r.top}`);
        }
        const el = floating(k);
        WS.floatAt(el, -50, -50);
        assert.equal(parseFloat(el.style.left), 6);
        assert.equal(parseFloat(el.style.top), 6);
    }
});

test('FIX_318_V1: панель оформления — над полем, не поверх него, при 75/100/130/150%', () => {
    for (const k of [0.75, 1, 1.3, 1.5]) {
        const fbar = floating(k, 420, 33);
        const fld = rectEl({ left: 160 * k, top: 700 * k, width: 600 * k, height: 60 * k });   // поле на увеличенном листе
        WS.placeFormatBar(docAt(), fbar, fld);
        const b = fbar.getBoundingClientRect(), f = fld.getBoundingClientRect();
        assert.ok(b.bottom <= f.top, `k=${k}: панель (низ ${b.bottom}) заходит на поле (верх ${f.top})`);
        assert.ok(f.top - b.bottom <= 12, `k=${k}: панель далеко от поля (${f.top - b.bottom} px)`);
        assert.ok(Math.abs(b.left - f.left) < 0.01, `k=${k}: панель не у левого края поля`);
    }
});

test('FIX_318_V1: выбор размера и панель таблицы считают место через floatAt, а не сырыми координатами', () => {
    const src = fs.readFileSync(new URL('../views/service-workspace.js', import.meta.url), 'utf8');
    const start = src.indexOf('function _blankWireTables(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.ok(start > 0 && body.length > 1000, 'не найден _blankWireTables');
    // перед замером окно ставится в начало документа ('0px') — иначе место только через floatAt
    assert.doesNotMatch(body, /(pick|panel)\.style\.(left|top)\s*=(?!\s*'0px')/, 'место окна размера и панели — только через floatAt');
    assert.match(body, /floatAt\(pick,/);
    assert.match(body, /floatAt\(panel,/);
});
