// NO_STRAY_GLOBALS_V1 (2026-09-09) — ПРИСВАИВАНИЕ НЕОБЪЯВЛЕННОЙ ПЕРЕМЕННОЙ.
//
// Экраны — модули, а модули строги: `foo = 1` без объявления бросает
// ReferenceError В МОМЕНТ ВЫПОЛНЕНИЯ строки, а не при загрузке. Такая строка
// проходит и импорт, и все тесты, которые до неё не доходят, — и падает у врача.
//
// ТАК И СЛУЧИЛОСЬ. Расчёт разрывов страниц A4 переехал из кабинета врача в
// общий модуль (views/a4-paginate.js). Переменная модуля `_a4Sig` уехала вместе
// с ним, а строка `_a4Sig = ''` в открытии приёма осталась. Кабинет врача
// перестал открываться вовсе: «Ko'rinishni yuklashda xatolik. _a4Sig is not
// defined». Ни один тест этого не увидел: service-workspace.js целиком не
// поднимается в обвязке без браузера.
//
// ПРАВИЛО. Имя, которому присваивают ОТДЕЛЬНОЙ СТРОКОЙ, обязано встречаться в
// файле ещё где-нибудь: у переменной есть объявление, у поля — чтение. Имя,
// встреченное во всём файле РОВНО ОДИН РАЗ и именно в этом присваивании, — это
// остаток переезда, и он гарантированно упадёт.
//
// Сторож нарочно грубый В СВОЮ ПОЛЬЗУ: он смотрит только на присваивания с
// начала строки и считает вхождения по сырому тексту, вместе с комментариями.
// Он молчит на всём, что хоть как-то упомянуто дважды, — и потому не выдумывает
// нарушений там, где их нет. Пропустить он может, соврать — нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = path.join(HERE, '..');

function jsFiles(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
            if (name === '__tests__' || name === 'node_modules') continue;
            out.push(...jsFiles(full));
        } else if (name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

/** Имена, которым присваивают отдельной строкой: `    name = …`. */
function assignedNames(src) {
    const names = new Set();
    for (const line of src.split('\n')) {
        // Отступ обязателен: присваивание в начале строки без отступа — это
        // почти всегда объявление уровня модуля, которое ниже и объявлено.
        //
        // Пробелы вокруг «=» обязательны тоже, и это не про вкус: `name="…"`
        // без пробелов — атрибут HTML внутри шаблонной строки (в ui.js так
        // рисуется SVG), а не присваивание в коде.
        const m = /^\s+([A-Za-z_$][\w$]*)\s+=\s(?!=|>)/.exec(line);
        if (!m) continue;
        const name = m[1];
        if (/^(const|let|var|function|class|return|typeof|new|await|else|case|default|export|import)$/.test(name)) continue;
        names.add(name);
    }
    return names;
}

/**
 * Текст без ЦЕЛИКОМ-комментарийных строк.
 *
 * Считать вхождения вместе с комментариями нельзя: объяснение поломки,
 * написанное рядом с ней, называет то же имя — и сторож замолкает ровно там,
 * где он нужнее всего. Проверено на этом самом файле: комментарий про `_a4Sig`
 * скрыл `_a4Sig`.
 *
 * Выкидываются только строки, которые комментарий ЦЕЛИКОМ: разбирать строковые
 * литералы небезопасно (одиночная кавычка внутри шаблона съедает пол-файла), а
 * целая строка комментария опознаётся однозначно.
 */
function withoutCommentLines(src) {
    return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

test('NO_STRAY_GLOBALS_V1: ни один экран не присваивает необъявленной переменной', () => {
    const bad = [];
    for (const file of jsFiles(ADMIN)) {
        const src = fs.readFileSync(file, 'utf8');
        const code = withoutCommentLines(src);
        for (const name of assignedNames(code)) {
            const uses = (code.match(new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g')) || []).length;
            if (uses <= 1) bad.push(path.relative(ADMIN, file).replace(/\\/g, '/') + '  →  ' + name);
        }
    }
    assert.deepEqual(bad, [],
        'присваивание имени, которого в файле больше нигде нет. В модуле это ReferenceError '
        + 'в момент выполнения строки, и экран не откроется. Объявите переменную или уберите строку:\n  '
        + bad.join('\n  '));
});

test('NO_STRAY_GLOBALS_V1: сторож ловит ту самую строку, из-за которой он написан, и молчит на здоровом коде', () => {
    // Сторож, который ничего не ловит, выглядит точно так же, как чистый код,
    // поэтому проверяется он сам — на образце поломки и на образце нормы.
    const broken = ['function open(container) {', "    _a4Sig = '';", '    setup(container);', '}'].join('\n');
    assert.ok(assignedNames(broken).has('_a4Sig'), 'сторож не видит присваивания вовсе');
    const uses = (broken.match(/\b_a4Sig\b/g) || []).length;
    assert.equal(uses, 1, 'примета поломки — единственное упоминание имени во всём файле');

    // Норма: объявленная переменная, параметр по умолчанию и поле объекта.
    const healthy = [
        'function open({ extra = "" } = {}) {',
        '    let sig = "";',
        '    sig = "x";',
        '    state.tab = "work";',
        '    return sig + extra;',
        '}',
    ].join('\n');
    for (const name of assignedNames(healthy)) {
        const uses2 = (healthy.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
        assert.ok(uses2 > 1, 'сторож ошибся на здоровом коде: ' + name);
    }
});
