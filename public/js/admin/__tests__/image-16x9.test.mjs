// TELEGRAM_BROADCAST_IMG_V1 — кадрирование под 16:9.
//
// Тестируем математику кадра, а не <canvas>: рисование проверить в node нечем,
// а вот «какой кусок исходника попадёт в баннер» — это чистая функция, и
// именно она решает, окажется ли лицо человека за краем кадра.

import test from 'node:test';
import assert from 'node:assert/strict';
import { centerCrop16x9, outputSize, TARGET_W, TARGET_H } from '../views/image-16x9.js';

const ratio = ({ sw, sh }) => sw / sh;
const RATIO = TARGET_W / TARGET_H;

test('уже 16:9 — кадрировать нечего', () => {
    const c = centerCrop16x9(1920, 1080);
    assert.deepEqual(c, { sx: 0, sy: 0, sw: 1920, sh: 1080 });
});

test('широкую картинку режем по бокам, симметрично', () => {
    const c = centerCrop16x9(3000, 1000);   // 3:1 — шире, чем надо
    assert.equal(c.sh, 1000, 'высота берётся целиком');
    assert.ok(Math.abs(ratio(c) - RATIO) < 0.01, 'результат должен быть 16:9');
    assert.equal(c.sx, Math.round((3000 - c.sw) / 2), 'обрезка поровну слева и справа');
    assert.equal(c.sy, 0);
});

test('высокую картинку режем сверху и снизу, симметрично', () => {
    const c = centerCrop16x9(1000, 3000);   // портрет с телефона
    assert.equal(c.sw, 1000, 'ширина берётся целиком');
    assert.ok(Math.abs(ratio(c) - RATIO) < 0.01, 'результат должен быть 16:9');
    assert.equal(c.sy, Math.round((3000 - c.sh) / 2), 'обрезка поровну сверху и снизу');
    assert.equal(c.sx, 0);
});

test('кадр никогда не выходит за пределы исходника', () => {
    for (const [w, h] of [[100, 100], [4032, 3024], [640, 4000], [1, 1], [2, 7], [7, 2]]) {
        const c = centerCrop16x9(w, h);
        assert.ok(c.sx >= 0 && c.sy >= 0, `${w}x${h}: смещение не может быть отрицательным`);
        assert.ok(c.sx + c.sw <= w, `${w}x${h}: кадр вылез за правый край`);
        assert.ok(c.sy + c.sh <= h, `${w}x${h}: кадр вылез за нижний край`);
        assert.ok(c.sw >= 1 && c.sh >= 1, `${w}x${h}: пустой кадр`);
    }
});

test('мусорные размеры не роняют расчёт', () => {
    for (const bad of [0, -5, NaN, undefined, null]) {
        const c = centerCrop16x9(bad, bad);
        assert.ok(c.sw >= 1 && c.sh >= 1, 'всегда остаётся хоть один пиксель');
    }
});

test('большую картинку ужимаем до 1280 по ширине', () => {
    assert.deepEqual(outputSize(4000), { w: TARGET_W, h: TARGET_H });
});

test('маленькую картинку НЕ растягиваем — апскейл это только вес и мыло', () => {
    const out = outputSize(640);
    assert.equal(out.w, 640);
    assert.equal(out.h, 360, '640x360 — те же 16:9');
});
