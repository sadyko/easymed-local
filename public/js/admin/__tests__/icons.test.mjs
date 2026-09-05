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
import { renderModule, extractBody, iconFile, iconSource, ICONS_DIR, LOCAL_ICONS_DIR, OUT_FILE } from '../../../../scripts/build-icon-paths.mjs';

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
//
// ICON_GUARD_V2 (2026-09-05) — КАВЫЧКИ ЛЮБЫЕ. Здесь стояла одна одинарная
// кавычка, и проверка молча пропускала всё, что написано двойными. На 800
// вызовов таких файлов оказалось мало — но среди них setup-checklist.js, то
// есть шапка карточки «Настройка клиники»: Icon("Rocket") прошёл мимо теста и
// рисовал перечёркнутый круг «иконки нет» на ПЕРВОМ экране новой клиники.
// Проверка, которая зависит от того, какой кавычкой автор набрал строку, —
// это не проверка.
const CALL_RE = /\b(?:Icon|iconHtml|icon)\(\s*['"`]([A-Za-z0-9_]+)['"`]/g;

// ICON_GUARD_V2 — два способа назвать иконку, мимо которых проходит любая
// регулярка по вызову, потому что имя стоит не в скобках Icon():
//
//   icon: 'Trend'          — описание карточки или пункта меню, которое кто-то
//                            другой позже отдаёт в Icon(rep.icon). Так уехало
//                            'TrendingUp' в reports-export.js — имя ФАЙЛА
//                            набора вместо имени из карты, при том что
//                            соседний reports-hub.js для той же карточки писал
//                            'Trend'.
//   Icon(n.icon || 'Info') — запасное имя. Тот единственный случай, когда
//                            иконка обязана нарисоваться, потому что своей у
//                            записи нет, — и именно он не рисовался.
const PROP_RE = /\bicon\s*:\s*['"`]([A-Za-z0-9_]+)['"`]/g;
const FALLBACK_RE = /\b(?:Icon|iconHtml)\([^)\n]*?\|\|\s*['"`]([A-Za-z0-9_]+)['"`]/g;

/** [{ name, file, line }] — каждое имя иконки во всём public/js, как бы оно ни было записано. */
function collectIconCalls() {
    const calls = [];
    for (const file of jsFilesUnder(PUBLIC_JS)) {
        if (path.basename(file) === 'icons.js') continue;   // сам модуль себя не зовёт
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/);
        lines.forEach((line, i) => {
            for (const re of [CALL_RE, PROP_RE, FALLBACK_RE]) {
                for (const m of line.matchAll(re)) {
                    calls.push({ name: m[1], file: path.relative(REPO_ROOT, file), line: i + 1 });
                }
            }
        });
    }
    return calls;
}

test('каждое имя иконки, которое зовёт приложение, доезжает до файла набора', () => {
    const calls = collectIconCalls();
    assert.ok(calls.length > 300, `ожидалось много вызовов иконок, найдено ${calls.length} — регулярка перестала ловить`);
    // ICON_GUARD_V2 — три формы записи, и каждая обязана хоть что-то находить:
    // если одна перестанет ловить, тест продолжит зеленеть на двух остальных, и
    // целый способ назвать иконку снова окажется непроверенным.
    const sample = ['admin/views/reports-export.js', 'admin/notifications.js', 'admin/setup-checklist.js']
        .map((f) => fs.readFileSync(path.join(PUBLIC_JS, ...f.split('/')), 'utf8')).join('\n');
    for (const [why, re] of [['Icon(…)', CALL_RE], ["icon: '…'", PROP_RE], ['Icon(x || …)', FALLBACK_RE]]) {
        assert.ok([...sample.matchAll(re)].length > 0, `форма записи ${why} больше не ловится`);
    }

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

function svgsUnder(dir) {
    const out = [];
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) out.push(...svgsUnder(full));
        else if (it.name.endsWith('.svg')) out.push(full);
    }
    return out;
}

test('набор вендорится целиком и лежит там, откуда его берёт генератор', () => {
    const svgs = svgsUnder(ICONS_DIR);
    assert.equal(svgs.length, 442, 'в наборе coolicons v4.1 ровно 442 SVG');

    // Указание авторства обязано ехать вместе с иконками: CC BY 4.0 разрешает
    // использование ровно при этом условии.
    const attribution = fs.readFileSync(path.join(ICONS_DIR, 'ATTRIBUTION.md'), 'utf8');
    assert.match(attribution, /CC BY 4\.0/);
    assert.match(attribution, /Kryston Schwarze/);
    assert.match(attribution, /coolicons\.cool/);
});

test('указание авторства говорит, что рисунки ИЗМЕНЕНЫ, и живёт не только в файле', () => {
    // CC BY 4.0, п. 3(a)(1)(B): если работа изменена — об этом надо сказать.
    // Она изменена, и делает это генератор: build-icon-paths.mjs срезает с
    // контуров id и собственные stroke/fill, иначе иконка не взяла бы цвет из
    // темы. Файл же об этом молчал.
    const attribution = fs.readFileSync(path.join(ICONS_DIR, 'ATTRIBUTION.md'), 'utf8');
    assert.match(attribution, /рисунки изменены/i, 'не сказано, что набор изменён');
    assert.match(attribution, /id/, 'не сказано, ЧТО именно изменено');

    // И второе условие той же лицензии: указание должно доезжать до человека,
    // который программой ПОЛЬЗУЕТСЯ, а не только до того, кто распаковал архив.
    // Строка внизу экрана «Система» — views/updates.js, paintIconCredit().
    const view = fs.readFileSync(path.join(REPO_ROOT, 'public', 'js', 'admin', 'views', 'updates.js'), 'utf8');
    assert.match(view, /function paintIconCredit\(\)/, 'указание авторства пропало с экрана');
    assert.match(view, /coolicons\.cool/, 'на экране не назван источник набора');
    assert.match(view, /creativecommons\.org\/licenses\/by\/4\.0/, 'на экране не названа лицензия');
    assert.match(view, /Kryston Schwarze/, 'на экране не назван автор');
    assert.match(view, /tr\('с изменениями'\)/, 'на экране не сказано, что рисунки изменены');
    // Строка рисуется в wrap, а не в body: paint() чистит body на каждой
    // перерисовке, и указание исчезло бы после первой же смены состояния.
    assert.match(view, /wrap\.appendChild\(paintIconCredit\(\)\)/, 'указание попало в очищаемую часть экрана');
});

test('среди иконок не лежит служебного мусора файловой системы', () => {
    // .DS_Store лежал в coolicons/ и уезжал в архив клиники вместе с папкой:
    // scripts/build-bundle.mjs копирует public/ целиком и точечные файлы не
    // отсеивает, а express.static потом честно отдаёт его по HTTP. 8 КБ чужой
    // операционной системы, которые ничего не рисуют. .gitignore от этого не
    // спасает: файл не попадает в коммит, но остаётся на диске у того, кто
    // распаковал свежую поставку набора на macOS, — и уезжает в релиз.
    const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/i;
    const found = [];
    const walk = (dir) => {
        for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
            if (it.isDirectory()) { walk(path.join(dir, it.name)); continue; }
            if (JUNK.test(it.name)) found.push(path.relative(REPO_ROOT, path.join(dir, it.name)));
        }
    };
    walk(path.join(REPO_ROOT, 'public', 'assets', 'icons'));
    assert.deepEqual(found, [], 'удалите: иначе уедет в архив клиники и будет отдаваться по HTTP');
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
    // Droplet и Drop — два имени одной капли, и это единственная такая пара.
    assert.equal(iconHtml('Drop'), iconHtml('Droplet'));
});

test('входящий, исходящий и пропущенный звонок различаются рисунком', () => {
    // Ради этого всё и рисовалось: до замены три имени указывали на одну трубку
    // набора, и строки журнала звонков различались только подписью.
    const [i, o, m] = ['PhoneIn', 'PhoneOut', 'PhoneMissed'].map((n) => iconHtml(n));
    assert.notEqual(i, o);
    assert.notEqual(o, m);
    assert.notEqual(i, m);
    // Но трубка у всех трёх одна и та же: иначе строка таблицы читалась бы как
    // три разные иконки, а не как одна с меткой.
    const handset = (svg) => svg.match(/<path d="(M3 .*?Z)/);
    assert.ok(handset(i), 'первый контур — общая трубка');
    assert.equal(handset(i)[1], handset(o)[1]);
    assert.equal(handset(i)[1], handset(m)[1]);
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
// Свой набор: public/assets/icons/easymed/
// ---------------------------------------------------------------------------
//
// coolicons — общий интерфейсный набор, медицинская иконка в нём одна. Клиника
// ориентируется по форме значка, поэтому таблетка-чемоданчик и койка-стол были
// не «примерно то», а неправильная подсказка. Эти иконки нарисованы здесь, и
// тесты ниже стерегут ровно то, из-за чего дорисовка могла выглядеть вклеенной:
// та же сетка, та же толщина, те же атрибуты — и отдельная лицензия.

/** Имена, которые обязаны рисоваться нашим файлом, а не приближением набора. */
const DRAWN_HERE = [
    'Bed', 'Bot', 'Coins', 'Flask', 'Key', 'Megaphone', 'PhoneIn', 'PhoneMissed',
    'PhoneOut', 'Pill', 'Pulse', 'Rocket', 'Stethoscope', 'Target',
];

test('свои иконки нарисованы по правилам набора: 24x24, currentColor, без заливок и id', () => {
    const files = svgsUnder(LOCAL_ICONS_DIR);
    assert.ok(files.length >= DRAWN_HERE.length, `в easymed/ ${files.length} файлов на ${DRAWN_HERE.length} имён`);

    const bad = [];
    for (const f of files) {
        const rel = path.relative(REPO_ROOT, f);
        const text = fs.readFileSync(f, 'utf8');
        const say = (why) => bad.push(`${rel}: ${why}`);

        if (!/viewBox="0 0 24 24"/.test(text)) say('нет viewBox="0 0 24 24" — иконка не встанет в общую сетку');
        if (!/width="24"/.test(text) || !/height="24"/.test(text)) say('не 24x24');
        // Цвет обязан приходить снаружи: иначе иконка не почернеет вместе с темой.
        if (!/stroke="currentColor"/.test(text)) say('нет stroke="currentColor"');
        if (/stroke="(?!currentColor)/.test(text)) say('свой цвет контура');
        // Заливок в наборе нет вообще — только контуры.
        for (const m of text.matchAll(/fill="([^"]*)"/g)) if (m[1] !== 'none') say(`fill="${m[1]}" — набор рисует только контуром`);
        // id="Vector" в авторских файлах — источник десятков одинаковых id в
        // одном документе; у своих файлов его нет вовсе.
        if (/\sid=/.test(text)) say('атрибут id — в одном документе иконок десятки');
        if (!/stroke-width="2"/.test(text)) say('толщина не 2 — рисунок будет другого веса');
        if (!/stroke-linecap="round"/.test(text) || !/stroke-linejoin="round"/.test(text)) say('скругления не round');

        const els = [...text.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]);
        for (const el of els) if (!['svg', 'g', 'path'].includes(el)) say(`элемент <${el}> — генератор умеет только svg/g/path`);
    }
    assert.deepEqual(bad, []);
});

test('свои иконки рисуются в тех же 24 клетках, что и иконки набора', () => {
    // Оптический размер: если рисунок занимает заметно меньше или больше поля,
    // чем соседи, он выглядит вклеенным даже при верной толщине. Считаем по
    // опорным точкам контура — приближённо, но достаточно, чтобы поймать
    // иконку, нарисованную «в половину клетки» или вылезшую за поле.
    const off = [];
    for (const f of svgsUnder(LOCAL_ICONS_DIR)) {
        const nums = [...fs.readFileSync(f, 'utf8').matchAll(/ d="([^"]+)"/g)]
            .flatMap((m) => m[1].match(/-?\d+(?:\.\d+)?/g).map(Number));
        const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
        const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        const rel = path.relative(LOCAL_ICONS_DIR, f);
        if (Math.min(...nums) < 1.5 || Math.max(...nums) > 22.5) off.push(`${rel}: выходит за поле (${Math.min(...nums)}…${Math.max(...nums)})`);
        if (span < 14) off.push(`${rel}: рисунок занимает ${span.toFixed(1)} клеток — мельче соседей по набору`);
    }
    assert.deepEqual(off, []);
});

test('имена, ради которых всё рисовалось, берутся из easymed, а не из coolicons', () => {
    const wrong = DRAWN_HERE
        .map((name) => [name, ICON_MAP[name]])
        .filter(([, coolPath]) => !coolPath || iconSource(coolPath) !== 'easymed')
        .map(([name, coolPath]) => `${name} → ${coolPath}`);
    assert.deepEqual(wrong, [], 'должны рисоваться своим файлом: ' + wrong.join('; '));
    // И ни одно из них больше не «приближение».
    for (const name of DRAWN_HERE) assert.equal(NO_EXACT_MATCH.includes(name), false, `${name} нарисован, но всё ещё помечен «~»`);
});

test('в easymed нет файлов, которые никто не рисует', () => {
    const used = new Set(Object.values(ICON_MAP));
    const dead = svgsUnder(LOCAL_ICONS_DIR)
        .map((f) => path.relative(LOCAL_ICONS_DIR, f).split(path.sep).join('/').replace(/\.svg$/, ''))
        .filter((name) => !used.has(name));
    assert.deepEqual(dead, [], 'нарисовано и забыто — либо подключить в icon-map.js, либо удалить');
});

test('лицензия своих иконок отделена от лицензии набора', () => {
    // CC BY 4.0 требует указания авторства; ATTRIBUTION.md набора не должен
    // выглядеть распространяющимся на наш рисунок, поэтому наборы лежат в
    // разных папках, и у каждой свой файл о происхождении.
    assert.notEqual(LOCAL_ICONS_DIR, ICONS_DIR);
    assert.equal(fs.existsSync(path.join(LOCAL_ICONS_DIR, 'ATTRIBUTION.md')), false,
        'указание авторства coolicons не должно лежать среди наших файлов');
    const origin = fs.readFileSync(path.join(LOCAL_ICONS_DIR, 'ORIGIN.md'), 'utf8');
    assert.match(origin, /не входят в набор coolicons/);
    assert.match(origin, /ATTRIBUTION\.md/);
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
        path.join(LOCAL_ICONS_DIR, 'ORIGIN.md'),
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
