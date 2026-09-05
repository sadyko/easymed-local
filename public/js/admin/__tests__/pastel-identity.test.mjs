// PASTEL_IDENTITY_V1 (2026-09-05) — ЧТО ИМЕННО ЗАДАЁТ ЦВЕТ НА ТРЁХ ДОСКАХ.
//
// Владелец: «make cards of the kanban and the calendar bookings and the queue
// colorful. using pastel colors». Соседний файл contrast-badge-hatch.test.mjs
// считает ЧИСЛА (контраст всей шкалы, рамка и тень рабочего окна) — там цвет
// проверяется как цвет. Здесь проверяется другое, и без этого раскраска
// бесполезна или вредна:
//
//   1. Цвет ДЕТЕРМИНИРОВАН и привязан к сущности. «Красиво и по-разному» —
//      это не раскраска, это шум: если врач сегодня мятный, а завтра сиреневый,
//      смотреть на цвет незачем.
//   2. Цвет НЕ ЗАБРАЛ СЕБЕ СМЫСЛ СТАТУСА. Состояния талона (принимают / ждёт /
//      ожидает оплату / принят) остались на семантических токенах и по-прежнему
//      различимы между собой. Это тот случай, который ломается молча: доска
//      становится нарядной, а «не оплачено» перестаёт быть видно.
//   3. Словарь ОДИН. Три экрана берут оттенки из одного модуля, и он совпадает
//      со шкалой в CSS — иначе «мятный» на календаре и «мятный» в очереди
//      разъедутся при первой правке, и цвет снова перестанет что-либо значить.
//
// Модуль pastel.js чистый (ни DOM, ни сети, ни часов), поэтому импортируется
// напрямую. Экраны — нет: они тянут supabase и ui.js, которым нужен документ;
// их вклад читается из исходников, как это делает type-scale.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PASTEL_HUES, hueOf, pastelFor, pastelAt, pastelClass, QUEUE_KIND_HUE, pastelForQueueKind } from '../pastel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8').replace(/\r\n/g, '\n');

const CSS = read('css/admin.css');
const RCAL = read('js/admin/views/room-calendar.js');
const QUEUE = read('js/admin/views/queue.js');
const CRM = read('js/admin/views/crm.js');

// ---------------------------------------------------------------------------
// 1. Словарь один
// ---------------------------------------------------------------------------

test('шкала в CSS и список оттенков в pastel.js — это ОДИН список, а не два похожих', () => {
    const root = CSS.slice(CSS.indexOf(':root'), CSS.indexOf('}', CSS.indexOf(':root')));
    const inCss = [...root.matchAll(/--pastel-([a-z0-9]+)-bg\s*:/g)].map((m) => m[1]);
    assert.deepEqual([...PASTEL_HUES].sort(), [...inCss].sort(),
        'оттенки в pastel.js разошлись со шкалой в admin.css — экран запросит класс, которого нет, и карточка молча останется белой');
    // Порядок в JS значим (по нему красится воронка), поэтому он тоже фиксируется.
    assert.equal(PASTEL_HUES.length, new Set(PASTEL_HUES).size, 'оттенок в списке дважды');
});

test('класс оттенка выдаётся только на известный оттенок', () => {
    for (const h of PASTEL_HUES) assert.equal(pastelClass(h), 'pastel-' + h);
    // Неизвестный оттенок — пустая строка, а не «pastel-undefined»: класс,
    // которого нет в CSS, покрасил бы карточку в ничто и молча.
    for (const bad of ['', 'chartreuse', undefined, null, 42]) assert.equal(pastelClass(bad), '');
});

// ---------------------------------------------------------------------------
// 2. Цвет устойчив и принадлежит сущности
// ---------------------------------------------------------------------------

test('один и тот же ключ ВСЕГДА даёт один и тот же оттенок', () => {
    for (const seed of [7, '7', 'karimov', 512, 'doctor-99']) {
        const first = hueOf(seed);
        for (let i = 0; i < 5; i++) assert.equal(hueOf(seed), first, 'оттенок ключа ' + seed + ' поехал между вызовами');
        assert.ok(PASTEL_HUES.includes(first), 'оттенок вне шкалы: ' + first);
    }
    // Число и его же строка — один врач, а не два: id приезжает то тем, то
    // другим (JSON из базы против значения <select>).
    assert.equal(hueOf(7), hueOf('7'));
});

test('разные врачи получают разные оттенки — и шкала используется целиком', () => {
    // Пара, которая живёт в стенде календаря (room-calendar.test.mjs).
    assert.notEqual(hueOf(7), hueOf(9), 'двум разным врачам достался один цвет');

    // Не «в среднем разные»: на сотне подряд идущих id обязаны встретиться ВСЕ
    // восемь оттенков. Хэш, попадающий в три из восьми, — это раскраска в три
    // цвета, сколько бы оттенков ни лежало в :root.
    const seen = new Set();
    for (let id = 1; id <= 100; id++) seen.add(hueOf(id));
    assert.equal(seen.size, PASTEL_HUES.length,
        `на сотне врачей использовано ${seen.size} оттенков из ${PASTEL_HUES.length}: ${[...seen].join(', ')}`);
});

test('пустой ключ оттенка НЕ получает — «врач не назначен» это не чей-то цвет', () => {
    for (const empty of ['', null, undefined]) {
        assert.equal(hueOf(empty), '', 'пустой ключ получил оттенок');
        assert.equal(pastelFor(empty), '', 'пустой ключ получил класс');
    }
    // А непустой — получает, и класс собран правильно.
    assert.equal(pastelFor(7), 'pastel-' + hueOf(7));
});

test('воронка красится по ПОЗИЦИИ: соседние ступени никогда не совпадают', () => {
    for (let i = 0; i < PASTEL_HUES.length * 2; i++) {
        assert.notEqual(pastelAt(i), pastelAt(i + 1), `ступени ${i} и ${i + 1} одного цвета`);
    }
    // Ряд длиннее шкалы замыкается, а не обрывается: воронку могут настроить
    // и на десять колонок (crm_stages редактируется владельцем).
    assert.equal(pastelAt(0), pastelAt(PASTEL_HUES.length));
    assert.ok(PASTEL_HUES.every((h, i) => pastelAt(i) === 'pastel-' + h), 'позиции разошлись со списком');
    for (const bad of [-1, NaN, 'x', '0', null, undefined, 1.5]) assert.equal(pastelAt(bad), '', 'мусорная позиция получила цвет: ' + String(bad));
});

test('очередь: у каждого вида назначения свой оттенок, и все они из шкалы', () => {
    // Виды берутся из САМОГО экрана: новый вид, добавленный в KIND_TITLE и
    // забытый в таблице оттенков, покрасился бы «как прочее» и молча.
    const block = QUEUE.match(/const KIND_TITLE = \{([\s\S]*?)\};/);
    assert.ok(block, 'в queue.js не найден KIND_TITLE — виды назначений переименовали');
    const kinds = [...block[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
    assert.ok(kinds.length >= 5, 'видов назначения меньше пяти: ' + kinds.join(', '));

    for (const k of kinds) {
        assert.ok(QUEUE_KIND_HUE[k], `вид назначения «${k}» без оттенка — доска покрасит его как «прочее»`);
        assert.ok(PASTEL_HUES.includes(QUEUE_KIND_HUE[k]), `оттенок вида «${k}» вне шкалы`);
        assert.equal(pastelForQueueKind(k), 'pastel-' + QUEUE_KIND_HUE[k]);
    }
    const hues = kinds.map((k) => QUEUE_KIND_HUE[k]);
    assert.equal(hues.length, new Set(hues).size, 'два вида назначения одного цвета: ' + hues.join(', '));
    // Неизвестный вид не остаётся без цвета — он «прочее», а не пустота.
    assert.equal(pastelForQueueKind('newfangled'), 'pastel-' + QUEUE_KIND_HUE.other);
});

// ---------------------------------------------------------------------------
// 3. Семантика не отдана пастели
// ---------------------------------------------------------------------------

test('состояния талона остались СЕМАНТИКОЙ и по-прежнему различимы', () => {
    const block = QUEUE.match(/const STATE_STYLE = \{([\s\S]*?)\n\};/);
    assert.ok(block, 'в queue.js не найден STATE_STYLE — состояния талона переписали');

    const rows = [...block[1].matchAll(/^\s*([a-z]+):\s*\{\s*label:\s*'([^']*)',\s*bg:\s*'([^']*)',\s*fg:\s*'([^']*)'/gm)]
        .map((m) => ({ state: m[1], label: m[2], bg: m[3], fg: m[4] }));
    assert.deepEqual(rows.map((r) => r.state), ['serving', 'waiting', 'unpaid', 'done'],
        'набор состояний талона изменился: ' + rows.map((r) => r.state).join(', '));

    for (const r of rows) {
        // Ни одно состояние не красится пастелью: пастель — про «чьё это»,
        // состояние — про «что с ним». Один цвет с двумя смыслами и есть
        // способ потерять оба.
        assert.ok(!/--pastel-|--p-bg|--p-fg/.test(r.bg + r.fg),
            `состояние «${r.state}» покрасили пастелью — тяжесть и личность смешались`);
        assert.ok(r.label.trim(), `у состояния «${r.state}» пропала подпись — цвет остался единственным сообщением`);
    }
    // И они различимы между собой: одинаковая пара (фон, текст) у двух
    // состояний означает, что одно из них перестало существовать на экране.
    const pairs = rows.map((r) => r.bg + '|' + r.fg);
    assert.equal(pairs.length, new Set(pairs).size, 'два состояния талона выглядят одинаково: ' + pairs.join(' · '));
});

test('статус приёма остался ОТДЕЛЬНОЙ полоской, а не заливкой', () => {
    // Пять статусов, каждый со своим цветом, и цвет уходит в border-left —
    // ровно то, что позволяет отменённому приёму сохранить цвет своего врача.
    const meta = RCAL.match(/const STATUS_META = \{([\s\S]*?)\n\};/);
    assert.ok(meta, 'STATUS_META пропал из room-calendar.js');
    const colors = [...meta[1].matchAll(/color:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.equal(colors.length, 5, 'статусов приёма должно быть пять: ' + colors.join(', '));
    assert.equal(colors.length, new Set(colors).size, 'два статуса приёма одного цвета: ' + colors.join(', '));
    for (const c of colors) {
        assert.ok(!/--pastel-|--p-bg/.test(c), 'статус приёма покрасили пастелью — он перестал быть статусом');
    }
    assert.match(RCAL, /borderLeft:\s*`3px solid \$\{meta\.color\}`/,
        'цвет статуса больше не уходит в полоску слева — значит он где-то в заливке, а заливка занята врачом');
});

// ---------------------------------------------------------------------------
// 4. Экраны действительно подключены — и к тому, к чему надо
// ---------------------------------------------------------------------------

test('календарь красит карточку по ВРАЧУ (а не по услуге и не по статусу)', () => {
    assert.match(RCAL, /import \{ pastelFor \} from '\.\.\/pastel\.js/, 'календарь не берёт оттенок из общего модуля');
    assert.match(RCAL, /\(a\.doctorId \? ' ' \+ pastelFor\(a\.doctorId\) : ''\)/,
        'оттенок карточки приёма считается не от врача — тогда цвет колонки перестанет быть цветом врача');
    assert.ok(!/pastelFor\(a\.(status|service|serviceId)/.test(RCAL),
        'оттенок карточки считается от статуса или услуги — это подменяет собой семантику');
});

test('очередь красит карточку по ВИДУ НАЗНАЧЕНИЯ, по которому доска и сгруппирована', () => {
    assert.match(QUEUE, /import \{ pastelForQueueKind \} from '\.\.\/pastel\.js/, 'очередь не берёт оттенок из общего модуля');
    assert.match(QUEUE, /pastelForQueueKind\(g\.kind\)/, 'оттенок карточки очереди считается не от вида назначения');
    assert.match(QUEUE, /class: 'q-head'/, 'шапка карточки очереди потеряла класс — красить будет нечего');
});

test('канбан красит колонку по ПОЗИЦИИ в воронке и живёт внутри белого окна', () => {
    assert.match(CRM, /import \{ pastelAt \} from '\.\.\/pastel\.js/, 'канбан не берёт оттенок из общего модуля');
    assert.match(CRM, /pastelAt\(colIndex\)/, 'колонка воронки красится не по позиции');
    assert.match(CRM, /class: \('card crm-col ' \+ pastelAt\(colIndex\)\)\.trim\(\)/, 'колонка потеряла класс .crm-col');
    // Доска внутри рабочего окна: пастель и серый грунт страницы обе светлые,
    // и без белой подложки оттенок ступени был бы неразличим.
    assert.match(CRM, /class: 'card card-pad-sm crm-board-window'/, 'доска канбана больше не лежит в белом рабочем окне');
    // Карточка заявки остаётся белой и несёт свои метки.
    assert.match(CRM, /background: 'var\(--white, #fff\)'/, 'карточка заявки перестала быть белой — колонка и карточка сольются');
});
