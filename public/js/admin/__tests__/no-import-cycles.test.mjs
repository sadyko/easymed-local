// NO_IMPORT_CYCLES_V1 (2026-09-10) — КОЛЬЦО ИМПОРТОВ МЕЖДУ ЭКРАНАМИ ЗАПРЕЩЕНО.
//
// Цена известна поимённо. Я подключил библиотеку шаблонов кабинета врача в
// документ истории болезни обычным импортом сверху — и замкнул кольцо:
//
//     admission-modal.js → service-workspace.js → patient-card.js → admission-modal.js
//
// Браузер такое кольцо не ломает с ошибкой: он оставляет один из модулей
// недоинициализированным, и экран продолжает работать по КОДУ, ЗАГРУЖЕННОМУ
// РАНЬШЕ. Владелец три раза подряд писал «its still not applied» — правки
// уезжали на диск, сервер их отдавал, а на экране ничего не менялось.
//
// Тесты этого не ловили и не могли: node --test грузит модули поодиночке и в
// другом порядке, и кольцо у него разрешается молча. Поэтому проверка не
// исполняет код, а читает импорты и ищет цикл — как их видит браузер.
//
// ЧТО ДЕЛАТЬ, ЕСЛИ ТЕСТ УПАЛ. Не «развязать как-нибудь», а выбрать одно из:
//   • общий кусок вынести в свой модуль, который не знает про экраны;
//   • подгружать чужой экран динамически В МОМЕНТ ДЕЙСТВИЯ:
//     `const { openX } = await import('./other-screen.js')` — динамический
//     импорт в статический граф не входит и кольца не образует.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');

/** Статические импорты соседних экранов: только `from './имя.js'`. */
function staticImports(file) {
    const src = fs.readFileSync(path.join(VIEWS, file), 'utf8');
    const out = new Set();
    // Динамический import() сюда НЕ попадает намеренно: он и есть разрешённый
    // способ позвать соседний экран, не заводя кольца.
    const re = /(?:^|\n)\s*import\s[^;]*?from\s+'\.\/([A-Za-z0-9_.-]+\.js)(?:\?[^']*)?'/g;
    let m;
    while ((m = re.exec(src))) out.add(m[1]);
    return [...out];
}

function findCycle(files) {
    const state = new Map();   // file -> 'busy' | 'done'
    const stack = [];
    const walk = (file) => {
        if (state.get(file) === 'busy') return stack.slice(stack.indexOf(file)).concat(file);
        if (state.get(file) === 'done') return null;
        state.set(file, 'busy');
        stack.push(file);
        let deps = [];
        try { deps = staticImports(file); } catch (e) { deps = []; }
        for (const d of deps) {
            if (!files.includes(d)) continue;   // модуль вне экранов
            const found = walk(d);
            if (found) return found;
        }
        stack.pop();
        state.set(file, 'done');
        return null;
    };
    for (const f of files) {
        const found = walk(f);
        if (found) return found;
    }
    return null;
}

test('NO_IMPORT_CYCLES_V1: экраны не ссылаются друг на друга по кругу', () => {
    const files = fs.readdirSync(VIEWS).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 40, 'экранов должно быть много — проверка смотрит не туда');

    const cycle = findCycle(files);
    assert.equal(cycle, null, cycle
        ? 'кольцо импортов: ' + cycle.join(' → ')
          + ' — в браузере один из этих модулей останется недоинициализированным,'
          + ' и экран будет работать по старому коду. Вынесите общий кусок в свой'
          + ' модуль или зовите соседний экран динамическим import() в момент действия.'
        : '');
});

test('NO_IMPORT_CYCLES_V1: проверка ВИДИТ кольцо, а не молчит всегда', () => {
    // Проверка, которая ничего не находит по ошибке, хуже отсутствия проверки:
    // она успокаивает. Собираем заведомое кольцо на выдуманных именах.
    const fake = {
        'a.js': ['b.js'],
        'b.js': ['c.js'],
        'c.js': ['a.js'],
    };
    const stack = [];
    const seen = new Set();
    const walk = (f) => {
        if (stack.includes(f)) return stack.slice(stack.indexOf(f)).concat(f);
        if (seen.has(f)) return null;
        seen.add(f); stack.push(f);
        for (const d of fake[f] || []) { const r = walk(d); if (r) return r; }
        stack.pop();
        return null;
    };
    assert.deepEqual(walk('a.js'), ['a.js', 'b.js', 'c.js', 'a.js']);
});
