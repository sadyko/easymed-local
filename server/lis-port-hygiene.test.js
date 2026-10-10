// LIS_TEST_PORT_V1 (CLINIC_API_STEP5_V1, 2026-10-10) — ТЕСТ НЕ ЗАНИМАЕТ ПОРТ
// АНАЛИЗАТОРОВ ЭТОЙ МАШИНЫ.
//
// startLisListeners слушает 0.0.0.0 на LIS_PORT, по умолчанию 2575, — на этот
// же порт анализаторы шлют результаты Easy-Med, запущенному на этой машине
// (у разработчика он запущен почти всегда). Тест, дошедший до приёма без
// своего порта, забирал 2575 у работающей программы, а при занятом порте
// проверял не то. Так было с services/rpc/index.test.js: обход зовёт КАЖДЫЙ
// обработчик, в том числе lis_restart.
//
// Правило: файл, который может дойти до startLisListeners, задаёт в коде
// LIS_ENABLED (приём выключен) или LIS_PORT (свой свободный порт). Дойти можно:
//   • именем startLisListeners / lisRestart / lisDeviceDelete (импорт, вызов);
//   • RPC 'lis_restart' / 'lis_device_delete' по имени (getRpc, /api/rpc/…);
//   • обходом всей карты RPC с вызовом обработчиков;
//   • запуском server/index.js дочерним процессом.
// Проверяется правило, а не поведение приёма (для него — lis/index.test.js).
// Образец — app-test-hygiene.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

function testFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') testFiles(p, out); }
        else if (/\.test\.(js|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

// Комментарии не в счёт: в них эти имена и объясняются.
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const REACH = [
    ['startLisListeners / lisRestart / lisDeviceDelete', (c) => /\b(?:startLisListeners|lisRestart|lisDeviceDelete)\b/.test(c)],
    ['RPC lis_restart / lis_device_delete по имени', (c) => /['"`/](?:lis_restart|lis_device_delete)['"`]/.test(c)],
    ['обход всей карты RPC с вызовом обработчиков', (c) => /Object\.(?:keys|entries|values)\(\s*RPC\s*\)/.test(c)
        && /(?:getRpc\(\s*[A-Za-z_$][\w$]*\s*\)|RPC\[\s*[A-Za-z_$][\w$]*\s*\])\s*\(/.test(c)],
    ['запуск server/index.js дочерним процессом', (c) => /\b(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\((?:[^()]|\([^()]*\))*?(?:\([^()]*)?index\.js/.test(c)],
];
const SETS_PORT = /process\.env\.LIS_(?:ENABLED|PORT)\s*=(?!=)|process\.env\[\s*['"]LIS_(?:ENABLED|PORT)['"]\s*\]\s*=(?!=)|\bLIS_(?:ENABLED|PORT)\s*:/;

/** Почему файл может дойти до приёма анализаторов; [] — не может. */
export function reachesLis(code) {
    return REACH.filter(([, hit]) => hit(code)).map(([why]) => why);
}
/** Задаёт ли файл LIS_ENABLED или LIS_PORT (присваиванием или в env дочернего процесса). */
export function setsLisPort(code) {
    return SETS_PORT.test(code);
}

const rel = (file) => path.relative(HERE, file).split(path.sep).join('/');

test('ни один тест не поднимает приём анализаторов на порте этой машины', () => {
    const offenders = [];
    for (const file of testFiles(HERE)) {
        if (path.basename(file) === SELF) continue;
        const code = codeOf(fs.readFileSync(file, 'utf8'));
        const why = reachesLis(code);
        if (why.length && !setsLisPort(code)) offenders.push(rel(file) + ' — ' + why.join('; '));
    }
    assert.deepEqual(offenders, [], [
        'Эти тесты доходят до startLisListeners без своего порта и занимают 0.0.0.0:2575 —',
        'порт анализаторов Easy-Med, запущенного на этой машине:',
        ...offenders.map((o) => '  ' + o),
        'Выключите приём: process.env.LIS_ENABLED = \'0\' (и верните в test.after),',
        'или, если тест проверяет сам приём, — свой свободный порт в process.env.LIS_PORT.',
    ].join('\n'));
});

test('страж узнаёт все пути к приёму и не путает с ними безобидное', () => {
    assert.deepEqual(reachesLis("import { lisRestart } from './lis.js';"), ['startLisListeners / lisRestart / lisDeviceDelete']);
    assert.deepEqual(reachesLis("await post(base, cookie, '/api/rpc/lis_restart', {});"), ['RPC lis_restart / lis_device_delete по имени']);
    assert.deepEqual(reachesLis('for (const name of Object.keys(RPC)) await getRpc(name)(db, {}, admin);'), ['обход всей карты RPC с вызовом обработчиков']);
    assert.deepEqual(reachesLis("spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env });"), ['запуск server/index.js дочерним процессом']);
    assert.deepEqual(reachesLis('const known = new Set(Object.keys(RPC));'), [], 'имена карты без вызова — не обход');
    assert.deepEqual(reachesLis("await getRpc('backup_create')(db, {}, admin);"), [], 'RPC по своему имени — не обход');
    assert.deepEqual(reachesLis("fs.writeFileSync(path.join(root, 'server', 'index.js'), '//');"), [], 'файл index.js не запуск');
    assert.equal(setsLisPort("process.env.LIS_ENABLED = '0';"), true);
    assert.equal(setsLisPort('process.env.LIS_PORT = String(port);'), true);
    assert.equal(setsLisPort("spawn(node, args, { env: { ...process.env, LIS_ENABLED: '0' } });"), true);
    assert.equal(setsLisPort("if (process.env.LIS_ENABLED === '0') return;"), false, 'сравнение — не установка');
    assert.equal(codeOf('// await lisRestart(db)\nconst x = 1;').includes('lisRestart'), false, 'комментарий не в счёт');
});

test('страж смотрит на настоящие файлы: известные пути к приёму найдены', () => {
    const files = testFiles(HERE);
    assert.ok(files.length > 50, 'тестов найдено ' + files.length + ' — обход сломан');
    const reaching = files.filter((f) => path.basename(f) !== SELF && reachesLis(codeOf(fs.readFileSync(f, 'utf8'))).length).map(rel);
    for (const known of ['services/rpc/index.test.js', 'services/rpc/lis.test.js', 'lis/index.test.js',
        'lis/lisproxy-device.test.js', 'lis/real-analyzers.e2e.test.js']) {
        assert.ok(reaching.includes(known), known + ' не узнан стражем: ' + reaching.join(', '));
    }
});
