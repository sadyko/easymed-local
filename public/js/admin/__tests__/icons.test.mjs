// COOLICONS_V1 — конвейер иконок целиком: карта, вендоренный набор,
// сгенерированные контуры, разметка на выходе.
//
// Главный тест здесь — первый: он обходит ВСЕ вызовы Icon('…') в public/js и
// требует, чтобы каждое имя доехало до настоящего файла набора. Именно он
// делает опечатку в имени иконки ошибкой сборки, а не пустым квадратом на
// экране у клиники: до замены четыре имени (Copy, Drop, Key, Minus) звались с
// экранов, не существовали в наборе и годами рисовались безымянным кружком —
// потому что проверять это было нечем.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ICON_MAP, NO_EXACT_MATCH } from '../icon-map.js';
import { ICON_BODIES } from '../icon-paths.js';
import { iconHtml, hasIcon, ICON_NAMES, I } from '../icons.js';
import { renderModule, extractBody, iconFile, ICONS_DIR, OUT_FILE } from '../../../../scripts/build-icon-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const PUBLIC_JS = path.join(REPO_ROOT, 'public', 'js');

// ---------------------------------------------------------------------------
// Обход исходников: где и как код зовёт иконку
// ---------------------------------------------------------------------------

function jsFilesUnder(dir) {
    const out = [];
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
            if (it.name === '__tests__' || it.name === 'vendor') continue;
            out.push(...jsFilesUnder(full));
        } else if (it.name.endsWith('.js') && !it.name.endsWith('.test.js')) {
            out.push(full);
        }
    }
    return out;
}

// Icon('X') из ui.js, icon('X') и iconHtml('X') из самого модуля. \b перед
// icon не даёт этой же альтернативе поймать хвост слова Icon.
const CALL_RE = /\b(?:Icon|iconHtml|icon)\(\s*'([A-Za-z0-9_]+)'/g;

/** [{ name, file, line }] — каждый вызов иконки по имени во всём public/js. */
function collectIconCalls() {
    const calls = [];
    for (const file of jsFilesUnder(PUBLIC_JS)) {
        if (path.basename(file) === 'icons.js') continue;   // сам модуль себя не зовёт
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/);
        lines.forEach((line, i) => {
            for (const m of line.matchAll(CALL_RE)) {
                calls.push({ name: m[1], file: path.relative(REPO_ROOT, file), line: i + 1 });
            }
        });
    }
    return calls;
}

test('каждое имя иконки, которое зовёт приложение, доезжает до файла набора', () => {
    const calls = collectIconCalls();
    assert.ok(calls.length > 300, `ожидалось много вызовов иконок, найдено ${calls.length} — регулярка перестала ловить`);

    const broken = [];
    for (const c of calls) {
        const coolPath = ICON_MAP[c.name];
        if (!coolPath) { broken.push(`${c.file}:${c.line} — Icon('${c.name}') нет в icon-map.js`); continue; }
        const file = iconFile(coolPath);
        if (!fs.existsSync(file)) broken.push(`${c.file}:${c.line} — Icon('${c.name}') → ${coolPath}.svg, файла нет`);
        if (!ICON_BODIES[coolPath]) broken.push(`${c.file}:${c.line} — Icon('${c.name}') → ${coolPath}, нет в icon-paths.js`);
        if (!hasIcon(c.name)) broken.push(`${c.file}:${c.line} — hasIcon('${c.name}') === false`);
    }
    assert.deepEqual(broken, [], 'иконки без рисунка:\n' + broken.join('\n'));
});

test('каждая строка карты указывает на существующий файл набора', () => {
    const missing = Object.entries(ICON_MAP)
        .filter(([, coolPath]) => !fs.existsSync(iconFile(coolPath)))
        .map(([name, coolPath]) => `${name} → ${coolPath}.svg`);
    assert.deepEqual(missing, []);
    assert.equal(ICON_NAMES.length, Object.keys(ICON_MAP).length);
});

test('набор вендорится целиком и лежит там, откуда его берёт генератор', () => {
    const svgs = [];
    const walk = (d) => {
        for (const it of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, it.name);
            if (it.isDirectory()) walk(full);
            else if (it.name.endsWith('.svg')) svgs.push(full);
        }
    };
    walk(ICONS_DIR);
    assert.equal(svgs.length, 442, 'в наборе coolicons v4.1 ровно 442 SVG');

    // Указание авторства обязано ехать вместе с иконками: CC BY 4.0 разрешает
    // использование ровно при этом условии.
    const attribution = fs.readFileSync(path.join(ICONS_DIR, 'ATTRIBUTION.md'), 'utf8');
    assert.match(attribution, /CC BY 4\.0/);
    assert.match(attribution, /Kryston Schwarze/);
    assert.match(attribution, /coolicons\.cool/);
});

// ---------------------------------------------------------------------------
// Свежесть сгенерированного файла
// ---------------------------------------------------------------------------

test('icon-paths.js совпадает с тем, что сейчас генерируется из SVG и карты', () => {
    // Сравниваем с нормализованными переводами строк, а не байт в байт: в
    // репозитории core.autocrlf=true, то есть на свежем клоне под Windows этот
    // файл лежит с CRLF, а генератор пишет LF. Побайтовое сравнение объявило
    // бы «файл устарел» на ровном месте — и первым это увидел бы второй
    // разработчик, а не тот, кто это писал.
    const lf = (s) => s.replace(/\r\n/g, '\n');
    assert.equal(
        lf(renderModule()), lf(fs.readFileSync(OUT_FILE, 'utf8')),
        'public/js/admin/icon-paths.js устарел — выполните node scripts/build-icon-paths.mjs',
    );
});

test('контуры очищены: ни id, ни собственных цвета и толщины', () => {
    // id="Vector" стоит в КАЖДОМ авторском файле; десятки иконок на экране дали
    // бы десятки одинаковых id в одном документе — невалидный DOM.
    // stroke/fill на контуре перебили бы внешний <svg> и убили и currentColor,
    // и параметр { stroke } у Icon().
    const dirty = Object.entries(ICON_BODIES)
        .filter(([, body]) => /\sid=|\sstroke=|\sstroke-width=|\sfill=|<g\b/.test(body))
        .map(([k]) => k);
    assert.deepEqual(dirty, []);
    for (const body of Object.values(ICON_BODIES)) assert.match(body, /^<path d="[^"]+"\/>/);
});

test('генератор падает, а не молчит, на непонятном SVG', () => {
    assert.throws(() => extractBody('<svg viewBox="0 0 24 24"><circle cx="1"/></svg>', 'x'), /неожиданный элемент/);
    assert.throws(() => extractBody('<svg viewBox="0 0 32 32"><path d="M0 0"/></svg>', 'x'), /viewBox/);
    assert.throws(() => extractBody('<svg viewBox="0 0 24 24"></svg>', 'x'), /нет ни одного/);
});

// ---------------------------------------------------------------------------
// Разметка на выходе — та же, что была до замены
// ---------------------------------------------------------------------------

test('по умолчанию: размер 18, толщина 1.75, цвет из currentColor', () => {
    const svg = iconHtml('Check');
    assert.match(svg, /width="18"/);
    assert.match(svg, /height="18"/);
    assert.match(svg, /stroke-width="1.75"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, /fill="none"/);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /^<svg /);
    assert.match(svg, /<path d="/);
});

test('доступность: иконка не читается скринридером и не ловит фокус', () => {
    const svg = iconHtml('Trash', { size: 13 });
    assert.match(svg, /aria-hidden="true"/);
    assert.match(svg, /focusable="false"/);
});

test('размер и толщина слушаются вызывающего', () => {
    const svg = iconHtml('Plus', { size: 42, stroke: 2.5 });
    assert.match(svg, /width="42"/);
    assert.match(svg, /height="42"/);
    assert.match(svg, /stroke-width="2.5"/);
    // Толщина живёт только на внешнем <svg> — иначе её нечем было бы задать.
    assert.equal(svg.match(/stroke-width=/g).length, 1);
});

test('прокси I рисует то же самое, что iconHtml', () => {
    assert.equal(I.Calendar({ size: 16 }), iconHtml('Calendar', { size: 16 }));
});

test('иконки, у которых один и тот же рисунок, действительно одинаковы', () => {
    // Droplet и Drop — два имени одной капли; PhoneIn/PhoneOut/PhoneMissed
    // делят единственную трубку набора (см. пометки в icon-map.js).
    assert.equal(iconHtml('Drop'), iconHtml('Droplet'));
    assert.equal(iconHtml('PhoneIn'), iconHtml('PhoneOut'));
});

// ---------------------------------------------------------------------------
// Неизвестное имя
// ---------------------------------------------------------------------------

test('неизвестное имя вне браузера — исключение, а не пустой квадрат', () => {
    assert.throws(() => iconHtml('НетТакой'), /неизвестное имя иконки/);
    assert.throws(() => iconHtml('Trsh'), /icon-map\.js/);
    assert.equal(hasIcon('Trsh'), false);
});

test('в браузере — заметная заглушка и крик в консоль, но экран не падает', () => {
    const errors = [];
    const origError = console.error;
    const origStrict = globalThis.EASYMED_ICONS_STRICT;
    console.error = (m) => errors.push(String(m));
    globalThis.EASYMED_ICONS_STRICT = false;   // как в браузере
    try {
        const svg = iconHtml('НетТакой', { size: 20 });
        assert.match(svg, /width="20"/);
        assert.match(svg, /<circle/, 'заглушка обязана быть видимой, а не пустым <svg>');
        assert.match(svg, /<path d="M6 6l12 12"\/>/, 'перечёркнутый круг: видно, что это ошибка');
        assert.equal(errors.length, 1);
        assert.match(errors[0], /НетТакой/);
    } finally {
        console.error = origError;
        if (origStrict === undefined) delete globalThis.EASYMED_ICONS_STRICT;
        else globalThis.EASYMED_ICONS_STRICT = origStrict;
    }
});

// ---------------------------------------------------------------------------
// Список «нет точного аналога» обязан оставаться правдой
// ---------------------------------------------------------------------------

test('NO_EXACT_MATCH совпадает с пометками «~» в самом файле карты', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'icon-map.js'), 'utf8');
    const lines = src.split(/\r?\n/);
    const marked = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*\/\/ ~/.test(lines[i])) continue;
        // Пометка стоит над одной или несколькими строками карты подряд.
        for (let j = i + 1; j < lines.length; j++) {
            if (/^\s*\/\/\s{3}/.test(lines[j])) continue;           // продолжение пояснения
            const m = lines[j].match(/^\s*([A-Za-z0-9_]+):\s*'/);
            if (!m) break;
            marked.push(m[1]);
        }
    }
    assert.deepEqual([...new Set(marked)].sort(), [...NO_EXACT_MATCH].sort());
    for (const n of NO_EXACT_MATCH) assert.ok(ICON_MAP[n], `${n} помечен, но не сопоставлен`);
});

// ---------------------------------------------------------------------------
// Домашнее правило: в интерфейсе нет эмодзи
// ---------------------------------------------------------------------------

test('в конвейере иконок нет ни одного эмодзи', () => {
    const EMOJI = /\p{Extended_Pictographic}/u;
    const files = [
        path.join(HERE, '..', 'icons.js'),
        path.join(HERE, '..', 'icon-map.js'),
        path.join(HERE, '..', 'icon-paths.js'),
        path.join(ICONS_DIR, 'ATTRIBUTION.md'),
        path.join(REPO_ROOT, 'scripts', 'build-icon-paths.mjs'),
        fileURLToPath(import.meta.url),
    ];
    for (const f of files) {
        const text = fs.readFileSync(f, 'utf8');
        const hit = text.match(EMOJI);
        assert.equal(hit, null, `${path.relative(REPO_ROOT, f)}: эмодзи «${hit && hit[0]}» — иконки берутся из набора, а не из шрифта эмодзи`);
    }
    for (const body of Object.values(ICON_BODIES)) assert.equal(EMOJI.test(body), false);
});
