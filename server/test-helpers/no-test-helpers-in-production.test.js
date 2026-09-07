// TEST_TMPDIR_V1 — помощники ТЕСТОВ не попадают в рабочий код.
//
// Живой промах, ради которого этот сторож и заведён. Массовый перевод фикстур
// на самоубирающуюся временную папку прошёлся по всем файлам со словом
// mkdtempSync — и зацепил server/services/telegram/render.js, который никакой
// не тест, а печать PDF на работающем сервере.
//
// Вреда там было ровно два, и оба неочевидные:
//   • рабочий код начал зависеть от каталога test-helpers, которого в поставке
//     клинике может и не быть;
//   • уборка в помощнике привязана к КОНЦУ ПРОЦЕССА. Для теста это в самый
//     раз — процесс живёт секунды. Для сервера, который работает месяцами, это
//     означает, что папка каждого напечатанного PDF копится до перезапуска, —
//     а render.js убирал за собой сразу, в finally, и делал это правильно.
//
// Отсюда правило: под test-helpers лежит то, что зовут только тесты.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function sources(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) sources(p, out);
        else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

const isTest = (p) => /\.test\.(js|mjs)$/.test(p)
    || p.includes(`${path.sep}__tests__${path.sep}`)
    || p.includes(`${path.sep}test-helpers${path.sep}`)
    || /fixture/i.test(path.basename(p));

test('test-helpers зовут только тесты', () => {
    const guilty = [];
    for (const f of sources(path.join(ROOT, 'server')).concat(sources(path.join(ROOT, 'public')))) {
        if (isTest(f)) continue;
        if (fs.readFileSync(f, 'utf8').includes('test-helpers/')) {
            guilty.push(path.relative(ROOT, f).replace(/\\/g, '/'));
        }
    }
    assert.deepEqual(guilty, [],
        'рабочий код тянет тестовый помощник — уборка «в конце процесса» на сервере значит «никогда»: '
        + guilty.join(', '));
});
