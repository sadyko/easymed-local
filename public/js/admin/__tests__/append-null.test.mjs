// NULL_IN_APPEND_V1 — пустая ветка не уезжает в родной Element.append.
//
// ЖИВОЙ СЛУЧАЙ. Владелец прислал снимок карточки сотрудника: под галочкой
// «Активен» стояло слово «null». Строка была такая:
//
//     body.append(head(…), grid(…), isEdit ? null : hint('Логин 3–30 символов…'));
//
// В h() так писать МОЖНО: он пустые ветки пропускает (ui.js — `if (c == null ||
// c === false) continue`). А тут не h(), а РОДНОЙ Element.append, и он ведёт
// себя иначе: всё, что не узел, превращается в текст. null становится строкой
// «null» и печатается на экране рядом с полями сотрудника.
//
// ПОЧЕМУ ЭТОГО НЕ ПОЙМАЛИ ТЕСТЫ. Подделка DOM в наших тестах добрее настоящего
// браузера: `append(...cs){ for (const c of cs) if (c) this.children.push(c); }`
// — она пустые значения молча отбрасывает. То есть ровно та разница, из-за
// которой дефект и существует, в подделке стёрта. Поэтому проверка здесь
// статическая: читаем исходники и ищем сам приём, а не его последствие.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = path.resolve(HERE, '..');

function jsFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) jsFiles(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

/** Текст аргументов вызова: считаем скобки, чтобы не обрезать вложенные. */
function argsAt(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (!depth) return src.slice(openIdx + 1, i); }
    }
    return '';
}

/**
 * Аргументы вызова ВЕРХНЕГО уровня. Без этого `h('span', null, 'Всего')`
 * внутри append считался бы находкой — а там null это второй параметр h(),
 * то есть свойства, и он совершенно законен.
 */
const BACKSLASH = String.fromCharCode(92);   // экранирование в heredoc теряется
function topLevelArgs(text) {
    const out = [];
    let depth = 0, quote = null, cur = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i], prev = text[i - 1];
        if (quote) { cur += c; if (c === quote && prev !== BACKSLASH) quote = null; continue; }
        if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out.map((a) => a.trim());
}

const rel = (f) => path.relative(ADMIN, f).split(path.sep).join('/');

test('пустая ветка не передаётся в родной .append() — иначе на экране появится «null»', () => {
    const guilty = [];
    const CALL = /\.append\s*\(/g;   // .append( но НЕ .appendChild(
    for (const file of jsFiles(ADMIN)) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(CALL)) {
            const args = topLevelArgs(argsAt(src, m.index + m[0].length - 1));
            const bad = args.some((a) => /^(null|undefined)$/.test(a)
                || /\?[\s\S]*:\s*(null|undefined)$/.test(a)
                || /^(null|undefined)\s*:/.test(a.replace(/^[\s\S]*?\?/, '')));
            if (bad) guilty.push(rel(file) + ':' + src.slice(0, m.index).split('\n').length);
        }
    }
    assert.deepEqual(guilty, [], 'родной append() превратит пустую ветку в текст «null» — '
        + 'вынесите её из вызова или стройте через h():\n  ' + guilty.join('\n  '));
});
