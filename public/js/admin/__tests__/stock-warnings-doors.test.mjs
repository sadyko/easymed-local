// EXPIRY_BALANCE_V1 — ПРЕДУПРЕЖДЕНИЕ О ПРОСРОЧКЕ ПОКАЗЫВАЮТ ВСЕ ДВЕРИ ИЛИ НИ
// ОДНА.
//
// Владелец (23.09): «выдача и списание просроченного предупреждают». Сервер
// честно кладёт `warnings` в ответ КАЖДОЙ двери (rpc/inventory.js,
// rpc/holdings.js, rpc/procurement.js — expiryWarnings), а экраны разошлись:
// три показывали, пять молча выбрасывали — счёт визита и история болезни даже
// не разбирали ответ дальше `{ error }`.
//
// Это хуже, чем не предупреждать вовсе. Предупреждение, которое приходит на
// одном экране и не приходит на другом, учит не доверять ему: человек,
// увидевший вчера жёлтую плашку у койки и не увидевший её сегодня в кабинете,
// заключает не «партия свежая», а «эта штука иногда не работает». Тогда
// плашку перестают читать и там, где она есть.
//
// ФОРМА ПРОВЕРКИ — сторожевой тест ПО ИСХОДНИКУ (как booking-doors.test.mjs):
// он не спрашивает у экранов, что они нарисовали, а спрашивает у файлов, кто
// зовёт дверь склада. Поведение каждой двери закреплено своим тестом экрана;
// здесь закреплено ПРАВИЛО — новая дверь рождается с предупреждением, а не
// вспоминает о нём через полгода.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.join(HERE, '..', 'views');

// Комментарий — не вызов. Без этого файл, который лишь УПОМИНАЕТ дверь в
// шапке (inventory.js, item-picker-modal.js, inventory-products.js), считался
// бы нарушителем, и список исключений разбух бы из-за разметки, а не из-за
// решений.
function stripComments(src) {
    let out = '', i = 0; const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
        if (c === '/' && src[i + 1] === '*') {
            out += '  '; i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
            out += '  '; i += 2; continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            const q = c; out += c; i++;
            while (i < n) { if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; } out += src[i]; if (src[i] === q) { i++; break; } i++; }
            continue;
        }
        out += c; i++;
    }
    return out;
}

// Двери склада: всё, что уносит товар с остатка и потому может уносить
// ПРОСРОЧЕННУЮ партию. `void_*` сюда не попадает намеренно — возврат товара
// ничего не расходует.
const DOOR_RE = /rpc\('(dispense_[a-z_]+|issue_stock_lines)'/;

// ИСКЛЮЧЕНИЯ — КАЖДОЕ РЕШЕНИЕ, А НЕ МОЛЧАЛИВЫЙ ПРОПУСК. Ключ — имя файла,
// значение — причина, по которой этой двери предупреждать НЕ надо. Пустой
// список и есть ответ на сегодня: предупреждают все восемь.
const EXCLUDED = {
    // (пример формы записи, если однажды понадобится)
    // 'файл.js': 'почему этой двери предупреждение не нужно',
};

const files = fs.readdirSync(VIEWS)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .filter((f) => DOOR_RE.test(stripComments(fs.readFileSync(path.join(VIEWS, f), 'utf8'))));

test('дверей склада в экранах вообще несколько — иначе проверять нечего', () => {
    assert.ok(files.length >= 5, 'найдено дверей: ' + files.length + ' — тест смотрит не туда');
});

test('КАЖДАЯ дверь склада показывает предупреждение о просроченной партии', () => {
    const silent = [];
    for (const f of files) {
        if (f in EXCLUDED) continue;
        const code = stripComments(fs.readFileSync(path.join(VIEWS, f), 'utf8'));
        if (!/toastStockWarnings\s*\(/.test(code)) silent.push(f);
    }
    assert.deepEqual(silent, [], 'двери списания молча выбрасывают warnings сервера:\n  ' + silent.join('\n  '));
});

test('слова предупреждения приходят из ОДНОГО места — иначе одна беда читалась бы как восемь', () => {
    const own = [];
    for (const f of files) {
        if (f in EXCLUDED) continue;
        const src = fs.readFileSync(path.join(VIEWS, f), 'utf8');
        if (!/from\s+'\.\/stock-warnings\.js'/.test(src)) own.push(f);
    }
    assert.deepEqual(own, [], 'экран завёл СВОЮ формулировку просрочки вместо общей (views/stock-warnings.js):\n  ' + own.join('\n  '));
});

test('исключение объясняет себя и ссылается на живую дверь', () => {
    for (const [f, why] of Object.entries(EXCLUDED)) {
        assert.ok(String(why || '').trim().length > 10, 'исключение без причины: ' + f);
        assert.ok(files.includes(f), 'исключение ссылается на файл, который дверью склада больше не является: ' + f);
    }
});
