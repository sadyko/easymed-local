// APPBAR_BACK_V1 (2026-09-06) — С КАЖДОГО ПОДЭКРАНА ЕСТЬ ПУТЬ НАЗАД.
//
// Владелец: «in some places there is back to settings buttons but in some
// places there is no. please add to everywhere a navigation buttons».
//
// Разбор дал числа: маршрутов 52, из них 18 — пункты бокового меню, 34 —
// подэкраны, на которые из меню не попасть. Кнопку «назад» рисовали ЧЕТЫРЕ из
// тридцати четырёх, каждый свою: «Настройки», «Назад в настройки», «Back to
// settings» (по-английски посреди русского интерфейса), «Пациенты». С
// остальных тридцати вернуться можно было только через боковое меню, то есть
// заново сообразив, частью чего был экран.
//
// Этот тест читает НАСТОЯЩИЙ роутер оболочки, а не список маршрутов, набранный
// рядом: список рядом разошёлся бы с роутером в тот же день, когда добавят
// экран, — то есть ровно тогда, когда тест и нужен.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, '..', '..', 'admin.js');
const src = fs.readFileSync(SHELL, 'utf8');

/** Идентификаторы пунктов бокового меню — из самой таблицы NAV. */
function navIds() {
    const at = src.indexOf('const NAV =');
    const block = src.slice(at, src.indexOf('\nconst CRUMBS', at));
    return new Set([...block.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]));
}

/** Все маршруты, которые роутер умеет открыть. */
function routedViews() {
    const at = src.indexOf('switch (state.view) {');
    const block = src.slice(at, src.indexOf('\n        }', at));
    return [...block.matchAll(/case '([^']+)':/g)].map((m) => m[1]);
}

/** Таблица «чей это подэкран» — из самого файла оболочки. */
function parentTable() {
    const at = src.indexOf('const PARENT_OF = {');
    assert.notEqual(at, -1, 'таблицу PARENT_OF переименовали — тест смотрит не туда');
    const block = src.slice(at, src.indexOf('\n};', at));
    const out = {};
    for (const m of block.matchAll(/'([^']+)':\s*'([^']+)'/g)) out[m[1]] = m[2];
    return out;
}

test('у каждого подэкрана назван родитель — иначе с него некуда вернуться', () => {
    const nav = navIds();
    const parents = parentTable();
    const orphans = routedViews().filter((v) => !nav.has(v) && !parents[v]);
    assert.deepEqual(orphans, [],
        'эти экраны открываются, но вернуться с них некуда — добавьте их в PARENT_OF:\n  ' + orphans.join('\n  '));
});

test('родитель — это настоящий пункт меню, а не выдуманный адрес', () => {
    const nav = navIds();
    const bad = Object.entries(parentTable())
        .filter(([, parent]) => !nav.has(parent))
        .map(([child, parent]) => child + ' → ' + parent);
    assert.deepEqual(bad, [],
        '«назад» ведёт туда, чего нет в меню — кнопка уведёт в никуда:\n  ' + bad.join('\n  '));
});

test('пункт меню родителя не получает — ему некуда возвращаться', () => {
    const nav = navIds();
    const wrong = Object.keys(parentTable()).filter((v) => nav.has(v));
    assert.deepEqual(wrong, [],
        'у пункта бокового меню появилась кнопка «назад» — это лишний орган управления: ' + wrong.join(', '));
});

test('кнопка живёт в оболочке, и экраны свою больше не рисуют', () => {
    // Кнопка в верхней панели — одна на все подэкраны. Пока экраны рисовали
    // свои, их было четыре разных вида и одна по-английски. Возвраты ВНУТРИ
    // экрана (из справочника к плиткам настроек, из карточки товара к списку)
    // — другое дело: они ведут не на другой маршрут и остаются на месте.
    assert.match(src, /id="section-back"|getElementById\('section-back'\)/,
        'оболочка потеряла кнопку возврата');
    assert.match(src, /function renderBackControl\(\)/);

    const VIEWS = path.resolve(HERE, '..', 'views');
    const offenders = [];
    for (const f of fs.readdirSync(VIEWS)) {
        if (!f.endsWith('.js') || f.endsWith('.test.js')) continue;
        const s = fs.readFileSync(path.join(VIEWS, f), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // Признак экранной кнопки «назад на другой маршрут»: обращение к
        // onNavigate('settings') рядом со стрелкой влево.
        if (/onNavigate\s*&&\s*onNavigate\('settings'\)/.test(s) && /ChevronLeft/.test(s)) {
            offenders.push(f);
        }
    }
    assert.deepEqual(offenders, [],
        'экран снова рисует свою кнопку «назад в настройки» — их станет опять четыре разных: ' + offenders.join(', '));
});
