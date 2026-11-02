// QUEUE_FRESH_V1 (3.21.0) — ЗАВЕРШЁННЫЙ ПРИЁМ НЕ ВИСИТ В ОЧЕРЕДИ.
//
// queue-fresh.js — маленькая почта между окном приёма и кабинетом врача: окно
// сообщает «строка N получила статус S» сразу после записи на сервер, кабинет и
// «Мой день» подписаны. Здесь — сама почта: подписка, отписка, сбой одного
// подписчика не мешает другим, пустое сообщение никого не зовёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noteLineStatus, onLineStatus } from '../queue-fresh.js';

// --- Ревью m4: СТРАЖ «ОДИН ЭКЗЕМПЛЯР ПОЧТЫ» ---------------------------------
// Адрес модуля с ?v= (или любым ?/#) — второй экземпляр queue-fresh.js со своими
// подписчиками: окно приёма пишет в один, кабинет слушает другой, и сообщение
// молча не доходит. Страж читает КАЖДЫЙ импорт почты под public/js — статический
// (from '…'), побочный (import '…') и динамический (import('…')).
const JS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');   // public/js
const MAIL = resolve(JS_ROOT, 'admin', 'queue-fresh.js');
const MAIL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`\n]*queue-fresh\.js[^'"`\n]*)\1/g;

/** Импорты почты в тексте модуля: [{ spec, bad }] — bad, если в адресе есть ? или #. */
function mailImports(src) {
    const out = [];
    for (const m of String(src).matchAll(MAIL_IMPORT)) out.push({ spec: m[2], bad: /[?#]/.test(m[2]) });
    return out;
}

function jsFiles(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) jsFiles(p, out);
        else if (/\.(m?js)$/.test(e.name)) out.push(p);
    }
    return out;
}

test('страж: детектор находит импорт почты с ?v= — статический, побочный и динамический', () => {
    const n = 'queue-fresh';   // имя собрано из частей: сам этот файл стражу не попадается
    const sample = [
        `import { onLineStatus } from '../${n}.js';`,
        `import { noteLineStatus } from '../${n}.js?v=abc';`,
        `import '../${n}.js#x';`,
        `const m = await import("./admin/${n}.js?v=2");`,
    ].join('\n');
    assert.deepEqual(mailImports(sample).map((x) => x.bad), [false, true, true, true]);
    assert.deepEqual(mailImports(`// Импорт — только '../${n}.js' без ?v=`), [], 'комментарий принят за импорт');
});

test('страж: каждый импорт queue-fresh.js под public/js — без ?v= и ведёт к одному файлу', () => {
    const found = [];
    for (const file of jsFiles(JS_ROOT)) {
        for (const { spec, bad } of mailImports(readFileSync(file, 'utf8'))) {
            const rel = file.slice(JS_ROOT.length + 1).replace(/\\/g, '/');
            assert.ok(!bad, `${rel}: импорт почты с адресом «${spec}» — второй экземпляр модуля, сообщения не дойдут`);
            if (spec.startsWith('.')) assert.equal(resolve(dirname(file), spec), MAIL, `${rel}: «${spec}» — не admin/queue-fresh.js`);
            found.push(rel);
        }
    }
    // Страж не проходит «вхолостую»: почту грузят окно приёма, кабинет и «Мой день».
    for (const must of ['admin/views/service-workspace.js', 'admin/views/consultation.js', 'admin/views/doctor-dashboard.js']) {
        assert.ok(found.includes(must), 'страж не нашёл импорт почты в ' + must);
    }
});

test('подписчики получают номер строки и статус; отписка работает; сбой одного не мешает другим', () => {
    const got = [];
    const offA = onLineStatus(() => { throw new Error('сбой подписчика'); });
    const offB = onLineStatus((id, s) => got.push([id, s]));
    const warn = console.warn;
    console.warn = () => {};
    try { noteLineStatus(41, 'completed'); } finally { console.warn = warn; }
    assert.deepEqual(got, [[41, 'completed']]);
    offA(); offB();
    noteLineStatus(42, 'completed');
    assert.deepEqual(got, [[41, 'completed']], 'отписка не сработала');
});

test('пустой номер или статус — никого не зовут; подписка не-функцией — безвредна', () => {
    const got = [];
    const off = onLineStatus((id, s) => got.push([id, s]));
    noteLineStatus(null, 'completed');
    noteLineStatus('', 'completed');
    noteLineStatus(5, '');
    off();
    assert.deepEqual(got, []);
    const noop = onLineStatus('не функция');
    assert.equal(typeof noop, 'function');
    noop();
});
