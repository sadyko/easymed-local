// SOURCES_PARSE_V1 — каждый файл public/js обязан быть разбираемым JS.
//
// Тесты импортируют модули с логикой, но НЕ виды: те без DOM не поднимаются.
// Поэтому синтаксическая ошибка во вью проходила весь прогон незамеченной и
// доезжала до браузера — экран просто не открывался, а «872 теста прошли».
// Ровно так чуть не уехала сломанная строка в cashier-desk.js.
//
// Разбираем без выполнения: new vm.SourceTextModule компилирует модуль и
// останавливается до вычисления, поэтому ни DOM, ни сеть не нужны.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const JS_ROOT = path.join(ROOT, 'public', 'js');

// vendor/ — чужие сборки (xlsx, fflate): они наши правила не нарушают и весят
// мегабайты, разбирать их каждый прогон незачем.
const SKIP = new Set(['vendor']);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name), out);
        } else if (/\.m?js$/.test(entry.name)) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

const FILES = walk(JS_ROOT);

test('в public/js есть что проверять', () => {
    assert.ok(FILES.length > 40, 'ожидали десятки файлов, нашли ' + FILES.length);
});

test('каждый файл public/js разбирается как модуль', () => {
    const broken = [];
    for (const file of FILES) {
        const src = fs.readFileSync(file, 'utf8');
        try {
            // eslint-disable-next-line no-new
            new vm.SourceTextModule(src, { identifier: file });
        } catch (e) {
            broken.push(path.relative(ROOT, file) + ' — ' + e.message);
        }
    }
    assert.deepStrictEqual(broken, [], 'файлы не разбираются:\n  ' + broken.join('\n  '));
});

// NUL внутри исходника делает файл «бинарным» для ripgrep и подобных: он молча
// пропадает из ЛЮБОГО поиска по коду. Так дважды терялись реальные места
// (patient-card.js, doc-variants.js) — разделитель ключа писали сырым байтом
// вместо escape-последовательности \0.
test('в исходниках нет сырых NUL-байтов', () => {
    const dirty = FILES.filter((f) => fs.readFileSync(f).includes(0x00)).map((f) => path.relative(ROOT, f));
    assert.deepStrictEqual(dirty, [], 'сырой NUL прячет файл от grep — пишите \\0: ' + dirty.join(', '));
});
