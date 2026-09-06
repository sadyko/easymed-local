// LICENCE_FIXTURE_V1 (2026-09-06) — ТЕСТ НЕ ИМЕЕТ ПРАВА ЗАВИСЕТЬ ОТ МАШИНЫ,
// НА КОТОРОЙ ЗАПУЩЕН.
//
// Как это стоило одного выпуска. v0.9.0 был помечен тегом на зелёном прогоне:
// 4591 тест, ноль падений — на машине разработчика. В сборке те же два теста
// упали с 402 «Система не активирована», выпуск не собрался, и ни одна клиника
// его не увидела.
//
// Причина не в лицензировании и не в сборке. createApp(db) без dataDir берёт
// НАСТОЯЩУЮ папку ./data проекта (правильное умолчание для server/index.js в
// работе). На машине разработчика она активирована — там живёт настоящая
// клиника; на чистой сборочной машине control.json нет, и лицензионный шлюз в
// routes/db.js отвечает 402 на КАЖДУЮ запись. Тест, который пишет в базу, у
// себя проходит, а в сборке падает — и разница не в коде, а в том, чья это
// машина.
//
// Поймать это глазами нельзя: вызов выглядит совершенно обычно, и разница
// видна только там, где её уже поздно исправлять. Поэтому проверяется НЕ
// поведение шлюза (для него есть routes/licence-gate.test.js), а само правило:
// каталог данных в тестах задаётся явно. Готовая фикстура — licensedDataDir()
// из services/control/licensed-fixture.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function testFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') testFiles(p, out); }
        else if (/\.test\.(js|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

test('ни один тест не поднимает приложение с каталогом данных самой машины', () => {
    const offenders = [];
    // Себя страж не проверяет: в его собственном тексте вызов упоминается и в
    // объяснении, и в подсказке — он поймал бы сам себя и говорил бы об этом
    // вместо настоящих нарушений.
    const SELF = path.basename(fileURLToPath(import.meta.url));
    for (const file of testFiles(HERE)) {
        if (path.basename(file) === SELF) continue;
        const src = fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')     // комментарии не в счёт: в них
            .replace(/^\s*\/\/.*$/gm, '');        // этот самый вызов и объясняется
        // Вызов целиком, вместе со скобками: аргумент может быть на своей
        // строке, и построчный поиск нашёл бы «createApp(db,» без содержимого.
        for (const m of src.matchAll(/createApp\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
            const args = m[1];
            if (/dataDir/.test(args)) continue;
            offenders.push(path.relative(HERE, file) + ': createApp(' + args.trim().slice(0, 60) + ')');
        }
    }
    assert.deepEqual(offenders, [], [
        'createApp() без dataDir берёт настоящую папку ./data этой машины.',
        'У разработчика она активирована, в сборке — нет, и тест падает только там:',
        ...offenders.map((o) => '  ' + o),
        'Передайте каталог явно: createApp(db, { dataDir: licensedDataDir() })',
        '(services/control/licensed-fixture.js).',
    ].join('\n'));
});

test('страж смотрит на настоящие файлы, а не в пустоту', () => {
    const files = testFiles(HERE);
    assert.ok(files.length > 50, 'тестов найдено ' + files.length + ' — обход сломан');
    const withApp = files.filter((f) => /createApp\s*\(/.test(fs.readFileSync(f, 'utf8')));
    assert.ok(withApp.length > 5,
        'файлов с createApp() найдено ' + withApp.length + ' — правило проверять не на чем');
});
