// COOLICONS_V1 → ICONS_LUCIDE_V1 (2026-11-22) — конвейер иконок целиком: карта,
// вендоренный набор Lucide, сгенерированные контуры, разметка на выходе.
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
import { ICON_BODIES, ICON_FILLED } from '../icon-paths.js';
import { iconHtml, hasIcon, ICON_NAMES, I } from '../icons.js';
import { renderModule, extractBody, iconFile, iconSource, ICONS_DIR, HEALTH_DIR, OUT_FILE } from '../../../../scripts/build-icon-paths.mjs';

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
// V3120_FIX — четвёртая форма: помощник карточки card(заголовок, 'Иконка', …)
// (doctor-profile.js, dashboard.js) отдаёт второе слово в Icon(). Так уехали
// 'NotePencil' и 'Link' «Моего профиля» врача — сто ошибок в консоли за один
// проход инспекции, а три формы выше их не видели.
const CARD_RE = /\bcard\(\s*(?:tr\()?(?:'[^']*'|[A-Za-z_.]+)\)?\s*,\s*'([A-Z][A-Za-z0-9_]+)'/g;

/** [{ name, file, line }] — каждое имя иконки во всём public/js, как бы оно ни было записано. */
function collectIconCalls() {
    const calls = [];
    for (const file of jsFilesUnder(PUBLIC_JS)) {
        if (path.basename(file) === 'icons.js') continue;   // сам модуль себя не зовёт
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/);
        lines.forEach((line, i) => {
            for (const re of [CALL_RE, PROP_RE, FALLBACK_RE, CARD_RE]) {
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
    const sample = ['admin/views/reports-hub.js', 'admin/notifications.js', 'admin/setup-checklist.js']   // REPORTS_AUDIT_FIX_V1 — reports-export.js удалён
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

test('вендорятся ровно те иконки, что названы в карте, и с ними едет лицензия', () => {
    // ICONS_LUCIDE_V1 — из 2400 иконок Lucide в релиз едут только нужные: лишний
    // файл — это вес архива клиники без единого пикселя на экране.
    const allUsed = [...new Set(Object.values(ICON_MAP))];
    const files = svgsUnder(ICONS_DIR).map((f) => path.basename(f, '.svg')).sort();
    const used = allUsed.filter((n) => !n.includes('/')).sort();
    assert.deepEqual(files, used, 'в lucide/ лишние или недостающие файлы');
    for (const name of used) assert.equal(iconSource(name), 'lucide');
    // ICONS_HEALTH_V1 — то же правило для Healthicons: только названные в карте.
    const hFiles = svgsUnder(HEALTH_DIR).map((f) => 'healthicons/' + path.basename(f, '.svg')).sort();
    const hUsed = allUsed.filter((n) => n.startsWith('healthicons/')).sort();
    assert.deepEqual(hFiles, hUsed, 'в healthicons/ лишние или недостающие файлы');
    assert.match(fs.readFileSync(path.join(HEALTH_DIR, 'LICENSE'), 'utf8'), /CC0 1\.0 Universal/);
    assert.match(fs.readFileSync(path.join(HEALTH_DIR, 'ATTRIBUTION.md'), 'utf8'), /healthicons\.org/);
    // ISC разрешает копировать и менять ровно при одном условии — уведомление
    // об авторском праве едет вместе с иконками.
    const licence = fs.readFileSync(path.join(ICONS_DIR, 'LICENSE'), 'utf8');
    assert.match(licence, /ISC License/);
    assert.match(licence, /Lucide/);
});

test('указание авторства говорит, что рисунки ИЗМЕНЕНЫ, и живёт не только в файле', () => {
    // Генератор переводит фигуры в контуры и срезает stroke/fill — это изменение
    // набора, и о нём сказано и в файле, и на экране.
    const attribution = fs.readFileSync(path.join(ICONS_DIR, 'ATTRIBUTION.md'), 'utf8');
    assert.match(attribution, /рисунки изменены/i, 'не сказано, что набор изменён');
    assert.match(attribution, /ISC/);
    assert.match(attribution, /lucide\.dev/);
    // Строка внизу экрана «Система» — views/updates.js, paintIconCredit().
    const view = fs.readFileSync(path.join(REPO_ROOT, 'public', 'js', 'admin', 'views', 'updates.js'), 'utf8');
    assert.match(view, /function paintIconCredit\(\)/, 'указание авторства пропало с экрана');
    assert.match(view, /lucide\.dev/, 'на экране не назван источник набора');
    assert.match(view, /'ISC'/, 'на экране не названа лицензия');
    assert.match(view, /tr\('с изменениями'\)/, 'на экране не сказано, что рисунки изменены');
    const credit = view.slice(view.indexOf('function paintIconCredit()'), view.indexOf('function paint(body'));
    assert.doesNotMatch(credit, /coolicons/, 'на экране осталось указание прежнего набора');
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
    // У иконок-заливок (Healthicons) остаётся fill-rule/clip-rule — без него
    // вырезы рисунка залились бы сплошным пятном.
    for (const body of Object.values(ICON_BODIES)) assert.match(body, /^<path d="[^"]+"( fill-rule="evenodd")?( clip-rule="evenodd")?\/>/);
});

test('генератор падает, а не молчит, на непонятном SVG', () => {
    assert.throws(() => extractBody('<svg viewBox="0 0 24 24"><polygon points="1 1"/></svg>', 'x'), /неожиданный элемент/);
    assert.throws(() => extractBody('<svg viewBox="0 0 32 32"><path d="M0 0"/></svg>', 'x'), /viewBox/);
    assert.throws(() => extractBody('<svg viewBox="0 0 24 24"></svg>', 'x'), /нет ни одного/);
});

test('фигуры Lucide переводятся в контуры тем же рисунком', () => {
    // ICONS_LUCIDE_V1 — круг, прямоугольник и линия становятся <path>: остальной
    // код (onboarding.js, проверки) живёт в мире «иконка — одни контуры».
    const body = extractBody('<!-- @license x --><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/>'
        + '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="1" y1="2" x2="3" y2="4"/><path d="M0 0"/></svg>', 'x');
    assert.equal(body, '<path d="M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0"/>'
        + '<path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z"/>'
        + '<path d="M1 2L3 4"/><path d="M0 0"/>');
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

test('медицинские иконки меню — заливкой, без обводки, в подрезанном поле', () => {
    // ICONS_HEALTH_V1 — Healthicons нарисован заливкой: обводка поверх сделала бы
    // фигуру жирной кляксой, а поле 2…22 выравнивает его с линейными соседями.
    assert.ok(ICON_FILLED.length > 0);
    for (const key of ICON_FILLED) assert.equal(iconSource(key), 'healthicons', key);
    const svg = iconHtml('NavDoctor');
    assert.match(svg, /viewBox="2 2 20 20"/);
    assert.match(svg, /fill="currentColor"/);
    assert.match(svg, /stroke="none"/);
    assert.doesNotMatch(svg, /stroke-width=/);
    // А линейные иконки — по-прежнему линией.
    assert.match(iconHtml('NavDashboard'), /fill="none"/);
});

test('пункты меню рисуются своими иконками: медицинские — Healthicons, общие — Lucide', () => {
    const shell = fs.readFileSync(path.join(PUBLIC_JS, 'admin.js'), 'utf8');
    const nav = shell.slice(shell.indexOf('const NAV = ['), shell.indexOf('\n];', shell.indexOf('const NAV = [')));
    const icons = Object.fromEntries([...nav.matchAll(/id: '([^']+)',[^}]*?icon: '([A-Za-z0-9]+)'/g)].map((m) => [m[1], m[2]]));
    for (const id of ['patients', 'consultation', 'labs', 'procedures', 'admissions', 'mar-nurse']) {
        assert.equal(iconSource(ICON_MAP[icons[id]]), 'healthicons', id + ' — не медицинский значок');
    }
    for (const id of ['cashier-shifts', 'inventory', 'dashboard', 'reports-hub']) {
        assert.equal(iconSource(ICON_MAP[icons[id]]), 'lucide', id);
    }
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
    // Но трубка у всех трёх одна и та же — та же, что у простого «Телефона»:
    // иначе строка таблицы читалась бы как три разные иконки, а не одна с меткой.
    const handset = ICON_BODIES[ICON_MAP.Phone];
    for (const svg of [i, o, m]) assert.ok(svg.includes(handset), 'у звонка не та трубка');
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
// Медицинские места рисуются медицинскими значками
// ---------------------------------------------------------------------------
//
// ICONS_LUCIDE_V1 — владелец просил «more medical icons». Клиника ориентируется
// по форме значка, поэтому эти имена стерегутся поимённо: замена стетоскопа на
// «человечка» или койки на «стол» — неправильная подсказка, а не вкусовщина.

const MEDICAL = {
    Stethoscope: 'stethoscope', Pulse: 'heart-pulse', Pill: 'pill', Flask: 'flask-conical',
    Bed: 'bed', Thermo: 'thermometer', Building: 'hospital', Heart: 'heart',
};

test('медицинские имена рисуются медицинскими значками Lucide', () => {
    for (const [name, file] of Object.entries(MEDICAL)) assert.equal(ICON_MAP[name], file, name);
});

test('все иконки — в одной сетке 24×24 и одной толщине, без заливок', () => {
    // Один набор — одна рука: иконка другой толщины или с заливкой выглядела бы
    // вклеенной рядом с соседями.
    const bad = [];
    for (const f of svgsUnder(ICONS_DIR)) {
        const text = fs.readFileSync(f, 'utf8');
        const rel = path.relative(REPO_ROOT, f);
        if (!/viewBox="0 0 24 24"/.test(text)) bad.push(rel + ': не 24×24');
        if (!/stroke-width="2"/.test(text)) bad.push(rel + ': толщина не 2');
        if (!/stroke="currentColor"/.test(text)) bad.push(rel + ': цвет не currentColor');
        for (const m of text.matchAll(/fill="([^"]*)"/g)) if (m[1] !== 'none') bad.push(rel + ': заливка ' + m[1]);
    }
    assert.deepEqual(bad, []);
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
        path.join(HEALTH_DIR, 'ATTRIBUTION.md'),
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
