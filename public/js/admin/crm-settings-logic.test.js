// CRM_CONFIG_V1 (docs/plans/2026-08-24-crm-kanban-settings.md) — tests for
// every pure decision behind Настройки → «CRM-канбан» and behind the board
// that obeys it. Pure node, no fake DOM, no locale pin: nothing here touches
// i18n.js — every label is asserted as the literal Russian source string these
// functions return (translation happens later, in h()'s text-child path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    COLORS, isValidColor, tagKind, colorLabel, normalizeColor,
    UNDELETABLE_STAGE_KEYS, UNDELETABLE_SOURCE_KEYS, LABEL_MAX,
    DEFAULT_STAGES, DEFAULT_SOURCES, FALLBACK_CONVERT_STAGE,
    KEY_RE, isValidKey, deriveKey,
    moveItem, withPositions, sortByPosition, truthy,
    validateStages, validateSources, validateRouting,
    dispositionRu, ROUTING_ACTIONS,
    shapeConfig, boardConfig, isNotImplemented,
} from './crm-settings-logic.js';

// --- colour vocabulary -------------------------------------------------------

test('colours are the seven house tokens and nothing else — no free hex', () => {
    // Exactly STAGE_COLORS in server/services/crm/config.js and migration
    // 077's CHECK: the neutral colour is the EMPTY STRING, not the word.
    assert.deepEqual(COLORS.map((c) => c.token), ['info', 'warn', 'purple', 'teal', 'ok', 'crit', '']);
    for (const c of COLORS) assert.ok(isValidColor(c.token), JSON.stringify(c.token));
    for (const bad of ['#ff0000', 'red', 'primary', null, undefined, 7]) {
        assert.equal(isValidColor(bad), false, String(bad));
    }
});

test('normalizeColor: the plan’s «none» is an alias the server also accepts; the empty string is what is stored', () => {
    assert.equal(normalizeColor('none'), '');
    assert.equal(normalizeColor(''), '');
    assert.equal(normalizeColor('warn'), 'warn');
    assert.ok(isValidColor('none'), 'алиас проходит проверку — экран не обязан знать, какое написание пришло');
});

test('tagKind: a token passes through, the neutral one and anything unknown become the grey tag', () => {
    assert.equal(tagKind('warn'), 'warn');
    assert.equal(tagKind('purple'), 'purple');
    assert.equal(tagKind(''), '');
    assert.equal(tagKind('none'), '');
    assert.equal(tagKind('#abcdef'), '');
    assert.equal(tagKind(undefined), '');
});

test('colorLabel: Russian names for the swatches; an unknown token still names itself', () => {
    assert.equal(colorLabel('ok'), 'Зелёный');
    assert.equal(colorLabel(''), 'Серый');
    assert.equal(colorLabel('none'), 'Серый');
    assert.equal(colorLabel('nonsense'), 'nonsense');
});

test('the undeletable rows mirror the server’s list exactly — the screen must not offer a button that always 409s', () => {
    // server/services/crm/config.js: UNDELETABLE_STAGE_KEYS / _SOURCE_KEYS.
    assert.deepEqual(UNDELETABLE_STAGE_KEYS, ['in_process']);
    assert.deepEqual(UNDELETABLE_SOURCE_KEYS, ['call', 'telephony']);
    assert.equal(LABEL_MAX, 64, 'та же длина, что normLabel обрезает на сервере');
});

// --- the fallback board ------------------------------------------------------

test('the fallback board is byte-for-byte the vocabulary crm.js hardcoded before this change', () => {
    assert.deepEqual(DEFAULT_STAGES.map((s) => s.key),
        ['in_process', 'recall', 'scheduled', 'approved', 'came', 'no_show', 'stopped', 'not_qualified']);
    assert.deepEqual(DEFAULT_STAGES.map((s) => [s.label, tagKind(s.color)]), [
        ['В обработке', 'info'], ['Перезвонить', 'warn'], ['Записан', 'purple'], ['Подтверждён', 'teal'],
        ['Пришёл', 'ok'], ['Не пришёл', 'crit'], ['Обработка остановлена', ''], ['Нецелевой', ''],
    ]);
    // The seed in migration 077 is asserted row-for-row by 077.test.js; this
    // fallback has to be the same list or a 501 would redraw a different board.
    assert.deepEqual(DEFAULT_STAGES.map((s) => s.color),
        ['info', 'warn', 'purple', 'teal', 'ok', 'crit', '', '']);
    assert.deepEqual(DEFAULT_SOURCES.map((s) => [s.key, s.label]), [
        ['call', 'Звонок'], ['instagram', 'Instagram'], ['telegram', 'Telegram'],
        ['website', 'Сайт'], ['walk_in', 'Пришёл сам'], ['referral', 'Рекомендация'], ['other', 'Другое'],
    ]);
    // The behaviours migration 046 froze in code: came = conversion,
    // in_process/recall/scheduled/approved = open, the rest = lost.
    assert.equal(DEFAULT_STAGES.filter((s) => s.kind === 'won').length, 1);
    assert.equal(DEFAULT_STAGES.find((s) => s.kind === 'won').key, FALLBACK_CONVERT_STAGE);
    assert.deepEqual(DEFAULT_STAGES.filter((s) => s.kind === 'lost').map((s) => s.key),
        ['no_show', 'stopped', 'not_qualified']);
    assert.ok(validateStages(DEFAULT_STAGES).ok, 'the fallback must itself be savable');
    assert.ok(validateSources(DEFAULT_SOURCES).ok);
});

// --- keys --------------------------------------------------------------------

test('isValidKey: lower-case latin, digits and underscore, 1..32', () => {
    assert.ok(KEY_RE.test('in_process'));
    for (const good of ['a', 'x9', 'in_process', 'a'.repeat(32)]) assert.ok(isValidKey(good), good);
    for (const bad of ['', 'A', 'В_обработке', 'has space', 'has-dash', 'a'.repeat(33), null, 7]) {
        assert.equal(isValidKey(bad), false, String(bad));
    }
});

test('deriveKey: a Russian label transliterates into a readable key', () => {
    assert.equal(deriveKey('В обработке'), 'v_obrabotke');
    assert.equal(deriveKey('Перезвонить'), 'perezvonit');
    assert.equal(deriveKey('Не пришёл'), 'ne_prishel');
    assert.equal(deriveKey('Ждём оплату'), 'zhdem_oplatu');
    assert.equal(deriveKey('Счёт выставлен'), 'schet_vystavlen');
    assert.equal(deriveKey('Instagram Direct'), 'instagram_direct');
    // Punctuation, doubled and edge spaces collapse rather than survive.
    assert.equal(deriveKey('  Отказ — дорого!  '), 'otkaz_dorogo');
    assert.ok(isValidKey(deriveKey('Обработка остановлена')));
});

test('deriveKey: a label with nothing transliterable falls back to a STABLE generated key', () => {
    assert.equal(deriveKey('!!!'), 'col_1');
    assert.equal(deriveKey('++', ['col_1']), 'col_2');
    assert.equal(deriveKey('中文', [], 'src'), 'src_1');
    // Stable, not random: the same label on two machines gives the same key.
    assert.equal(deriveKey('???'), deriveKey('...'));
});

test('deriveKey: collisions get a numeric suffix and the result still fits 32 characters', () => {
    assert.equal(deriveKey('Перезвонить', ['perezvonit']), 'perezvonit_2');
    assert.equal(deriveKey('Перезвонить', ['perezvonit', 'perezvonit_2']), 'perezvonit_3');
    const long = deriveKey('Очень длинное название колонки которое не влезет', []);
    assert.ok(isValidKey(long), long);
    const collided = deriveKey('Очень длинное название колонки которое не влезет', [long]);
    assert.ok(isValidKey(collided), collided);
    assert.notEqual(collided, long);
});

// --- reordering --------------------------------------------------------------

test('moveItem: up/down move one row and never wrap around the ends', () => {
    const a = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
    assert.deepEqual(moveItem(a, 1, -1).map((r) => r.key), ['b', 'a', 'c']);
    assert.deepEqual(moveItem(a, 1, 1).map((r) => r.key), ['a', 'c', 'b']);
    assert.deepEqual(moveItem(a, 0, -1).map((r) => r.key), ['a', 'b', 'c'], '«↑» на первой строке — ничего');
    assert.deepEqual(moveItem(a, 2, 1).map((r) => r.key), ['a', 'b', 'c'], '«↓» на последней — ничего');
    assert.deepEqual(a.map((r) => r.key), ['a', 'b', 'c'], 'исходный массив не тронут');
});

test('withPositions: the array order becomes 1-based positions', () => {
    const out = withPositions([{ key: 'b', position: 9 }, { key: 'a', position: 3 }]);
    assert.deepEqual(out, [{ key: 'b', position: 1 }, { key: 'a', position: 2 }]);
});

test('sortByPosition: numeric order; missing/garbage positions sink, ties break by key', () => {
    const out = sortByPosition([
        { key: 'c', position: 3 }, { key: 'a', position: 1 },
        { key: 'z' }, { key: 'b', position: 'x' }, { key: 'd', position: 2 },
    ]);
    assert.deepEqual(out.map((r) => r.key), ['a', 'd', 'c', 'b', 'z']);
});

test('truthy: SQLite 1/0 and JSON true/false both read the same way', () => {
    for (const yes of [1, '1', true, 'yes']) assert.equal(truthy(yes), true, String(yes));
    for (const no of [0, '0', false, null, undefined, '']) assert.equal(truthy(no), false, String(no));
});

// --- validation --------------------------------------------------------------

const stage = (over = {}) => ({ key: 'k1', label: 'Колонка', color: 'info', position: 1, is_active: 1, kind: 'open', ...over });

test('validateStages: the happy path, and an empty list is refused', () => {
    assert.deepEqual(validateStages([stage(), stage({ key: 'k2', kind: 'won' })]), { ok: true });
    assert.equal(validateStages([]).ok, false);
    assert.equal(validateStages(null).ok, false);
});

test('validateStages: exactly one conversion column — never zero, never two', () => {
    assert.match(validateStages([stage()]).error, /колонка конверсии/i);
    const two = validateStages([stage({ kind: 'won' }), stage({ key: 'k2', kind: 'won' })]);
    assert.match(two.error, /ровно одна/);
});

test('validateStages: the conversion column cannot be hidden — registering a patient goes through it', () => {
    const r = validateStages([stage({ key: 'w', label: 'Пришёл', kind: 'won', is_active: 0 })]);
    assert.equal(r.ok, false);
    assert.match(r.error, /Пришёл/, 'отказ называет колонку, а не «одна из колонок»');
    assert.match(r.error, /не может быть скрыта/);
});

test('validateStages: unique keys, key format, non-empty labels, known colour, known kind', () => {
    assert.match(validateStages([stage({ key: 'dup', kind: 'won' }), stage({ key: 'dup' })]).error, /уже занят/);
    assert.match(validateStages([stage({ key: 'Плохой Ключ', kind: 'won' })]).error, /Ключ колонки/);
    assert.match(validateStages([stage({ label: '   ', kind: 'won' })]).error, /должно быть название/);
    assert.match(validateStages([stage({ color: '#fff', kind: 'won' })]).error, /неизвестный цвет/);
    assert.ok(validateStages([stage({ color: '', kind: 'won' })]).ok, 'нейтральный цвет — это пустая строка, а не «нет цвета»');
    assert.match(validateStages([stage({ kind: 'maybe' })]).error, /не задан тип/);
});

test('validateStages: at least one visible column — a settings screen must not be able to blank the board', () => {
    const r = validateStages([stage({ is_active: 0 }), stage({ key: 'w', kind: 'won', is_active: 1 })]);
    assert.equal(r.ok, true, 'скрыть обычную колонку можно');
    // Every non-won column hidden while won stays visible is still fine; the
    // refusal is for the case where nothing at all is left.
    assert.equal(validateStages([stage({ is_active: 0 }), stage({ key: 'x', is_active: 0 })]).ok, false);
});

test('validateSources: same key rules, no kind, at least one visible', () => {
    const src = (over = {}) => ({ key: 's1', label: 'Звонок', position: 1, is_active: 1, ...over });
    assert.deepEqual(validateSources([src()]), { ok: true });
    assert.equal(validateSources([]).ok, false);
    assert.match(validateSources([src({ label: '' })]).error, /должно быть название/);
    assert.match(validateSources([src(), src()]).error, /уже занят/);
    assert.match(validateSources([src({ key: 'ДА' })]).error, /Ключ источника/);
    assert.match(validateSources([src({ is_active: 0 })]).error, /хотя бы один источник/i);
});

test('validateRouting: «создать заявку» must name a VISIBLE column, or a call lands nowhere', () => {
    const stages = [stage({ key: 'open1' }), stage({ key: 'hidden1', is_active: 0 }), stage({ key: 'w', kind: 'won' })];
    assert.deepEqual(validateRouting([{ disposition: 'ANSWER', action: 'create', stage_key: 'open1' }], stages), { ok: true });
    assert.deepEqual(validateRouting([{ disposition: 'SMS-SENT', action: 'ignore', stage_key: null }], stages), { ok: true });

    const missing = validateRouting([{ disposition: 'NOANSWER', action: 'create', stage_key: null }], stages);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /Не ответили/, 'отказ на человеческом языке, а не «NOANSWER»');

    const hidden = validateRouting([{ disposition: 'ANSWER', action: 'create', stage_key: 'hidden1' }], stages);
    assert.equal(hidden.ok, false);
    assert.match(hidden.error, /видимая колонка/);

    assert.equal(validateRouting([{ disposition: 'ANSWER', action: 'maybe' }], stages).ok, false);
    assert.deepEqual(validateRouting([], stages), { ok: true });
});

// --- dispositions ------------------------------------------------------------

test('dispositionRu: the vocabulary the plan names, in words a receptionist reads', () => {
    assert.equal(dispositionRu('ANSWER'), 'Ответили');
    assert.equal(dispositionRu('NOANSWER'), 'Не ответили');
    assert.equal(dispositionRu('CANCEL'), 'Отменён');
    assert.equal(dispositionRu('TRANSFER'), 'Переведён');
    assert.equal(dispositionRu('ONLINE'), 'Идёт разговор');
    assert.equal(dispositionRu('CONGESTION'), 'Не удалось соединить');
    assert.equal(dispositionRu('CHANUNAVAIL'), 'Не удалось соединить');
    assert.equal(dispositionRu('VM'), 'Голосовая почта');
    assert.equal(dispositionRu('VM-SUCCESS'), 'Голосовая почта');
    assert.equal(dispositionRu('SUCCESS'), 'Факс');
    assert.equal(dispositionRu('FAILED'), 'Факс');
});

test('dispositionRu: BUSY is «Линия занята», not the bare «Занято» that already means an occupied BED', () => {
    // i18n-strings.js keys translations by the SOURCE string, and "Занято" is
    // already the bed board's Occupied — a busy phone line would have been
    // translated as an occupied bed in EN/UZ.
    assert.equal(dispositionRu('BUSY'), 'Линия занята');
});

test('dispositionRu: the whole SMS-* family is one rule; unknown codes show raw; missing → dash', () => {
    for (const c of ['SMS', 'SMS-SENT', 'SMS-DELIVERED', 'SMS-FAILED', 'sms-queued']) {
        assert.equal(dispositionRu(c), 'SMS', c);
    }
    assert.equal(dispositionRu('answer'), 'Ответили', 'регистр не важен');
    assert.equal(dispositionRu('SOMETHING_NEW'), 'SOMETHING_NEW', 'неизвестный код показывает себя, а не тире');
    for (const bad of ['', '   ', null, undefined, 7]) assert.equal(dispositionRu(bad), '—', String(bad));
});

test('ROUTING_ACTIONS: exactly the create/ignore choice the plan asks for', () => {
    assert.deepEqual(ROUTING_ACTIONS, [
        { value: 'create', label: 'Создать заявку' },
        { value: 'ignore', label: 'Не создавать' },
    ]);
});

// --- shapeConfig -------------------------------------------------------------

const SERVER_REPLY = {
    stages: [
        { key: 'came', label: 'Пришёл', color: 'ok', position: 5, is_active: 1, kind: 'won' },
        { key: 'in_process', label: 'В обработке', color: 'info', position: 1, is_active: 1, kind: 'open' },
        { key: 'not_qualified', label: 'Нецелевой', color: 'none', position: 8, is_active: 0, kind: 'lost' },
    ],
    sources: [
        { key: 'telephony', label: 'Телефония', position: 8, is_active: 1 },
        { key: 'call', label: 'Звонок', position: 1, is_active: 1 },
    ],
    routing: [
        { provider: 'binotel', disposition: 'ANSWER', action: 'create', stage_key: 'in_process' },
        { provider: 'binotel', disposition: 'SMS-SENT', action: 'ignore', stage_key: null },
    ],
};

test('shapeConfig: the reply is sorted by position and renumbered 1..n', () => {
    const cfg = shapeConfig(SERVER_REPLY);
    assert.deepEqual(cfg.stages.map((s) => [s.key, s.position]), [['in_process', 1], ['came', 2], ['not_qualified', 3]]);
    assert.deepEqual(cfg.sources.map((s) => [s.key, s.position]), [['call', 1], ['telephony', 2]]);
    assert.equal(cfg.stages.find((s) => s.key === 'not_qualified').is_active, 0);
    assert.deepEqual(cfg.routing, SERVER_REPLY.routing);
});

test('shapeConfig: an empty/absent/501-shaped reply degrades to today’s board, never to an empty form', () => {
    for (const thin of [null, undefined, {}, { stages: [], sources: null }, { stages: 'nope' }]) {
        const cfg = shapeConfig(thin);
        assert.deepEqual(cfg.stages.map((s) => s.key), DEFAULT_STAGES.map((s) => s.key), JSON.stringify(thin));
        assert.deepEqual(cfg.sources.map((s) => s.key), DEFAULT_SOURCES.map((s) => s.key));
        assert.deepEqual(cfg.routing, []);
    }
});

test('shapeConfig: unusable rows are dropped, thin ones are healed with harmless defaults', () => {
    const cfg = shapeConfig({
        stages: [
            { key: 'ok1', label: 'Колонка' },                       // no color, no kind, no is_active
            { key: '', label: 'Безымянная' },                       // no key — unusable
            { key: 'x', label: '   ' },                             // no label — unusable
            null,
            { key: 'weird', label: 'Цвет', color: '#ff0000', kind: 'nonsense' },
        ],
        sources: [{ key: 's', label: 'И' }],
        routing: [{ disposition: 'ANSWER', action: 'nonsense' }, { disposition: '  ' }, 'junk'],
    });
    assert.deepEqual(cfg.stages.map((s) => s.key), ['ok1', 'weird']);
    assert.equal(cfg.stages[0].color, '', 'нет цвета — нейтральный токен');
    assert.equal(cfg.stages[0].kind, 'open', 'нет типа — обычная колонка: ни конверсия, ни потеря');
    assert.equal(cfg.stages[0].is_active, 1, 'строка, которая молчит про is_active, — видимая: иначе старый сервер опустошил бы доску');
    assert.equal(cfg.stages[1].color, '', 'свободный hex не проходит даже на чтении');
    assert.equal(shapeConfig({ stages: [{ key: 'a', label: 'А', color: 'none' }] }).stages[0].color, '',
        'алиас «none» сворачивается в хранимый токен — обратно уходит уже он');
    // Only an explicit 0/false hides a row.
    assert.equal(shapeConfig({ stages: [{ key: 'a', label: 'А', is_active: null }] }).stages[0].is_active, 1);
    assert.equal(shapeConfig({ stages: [{ key: 'a', label: 'А', is_active: 0 }] }).stages[0].is_active, 0);
    assert.equal(shapeConfig({ stages: [{ key: 'a', label: 'А', is_active: false }] }).stages[0].is_active, 0);
    assert.deepEqual(cfg.routing, [{ provider: 'binotel', disposition: 'ANSWER', action: 'ignore', stage_key: null }],
        'неизвестное действие читается как «не создавать» — лишняя карточка хуже её отсутствия');
});

// --- boardConfig -------------------------------------------------------------

test('boardConfig: the shapes crm.js already expects, so the board did not have to be rewritten', () => {
    const b = boardConfig(SERVER_REPLY);
    assert.deepEqual(b.statuses, [['in_process', 'В обработке', 'info'], ['came', 'Пришёл', 'ok']],
        'колонки — только видимые, в порядке position');
    assert.deepEqual(b.sources, [['call', 'Звонок'], ['telephony', 'Телефония']]);
    assert.equal(b.convertStatus, 'came');
    assert.deepEqual(b.activeStatuses, ['in_process']);
});

test('boardConfig: hidden stages keep their label — a card already sitting there must not show its raw key', () => {
    const b = boardConfig(SERVER_REPLY);
    assert.deepEqual(b.statusRu.not_qualified, ['Нецелевой', ''], 'скрытая колонка всё ещё знает своё название');
    assert.equal(b.statuses.some(([k]) => k === 'not_qualified'), false, 'но колонкой на доске уже не является');
    // …and a lead lost in a retired column is still a lost lead in the funnel.
    assert.deepEqual(b.lostStatuses, ['not_qualified']);
});

test('boardConfig: no reply at all = exactly today’s board', () => {
    const b = boardConfig(null);
    assert.deepEqual(b.statuses, [
        ['in_process', 'В обработке', 'info'], ['recall', 'Перезвонить', 'warn'],
        ['scheduled', 'Записан', 'purple'], ['approved', 'Подтверждён', 'teal'],
        ['came', 'Пришёл', 'ok'], ['no_show', 'Не пришёл', 'crit'],
        ['stopped', 'Обработка остановлена', ''], ['not_qualified', 'Нецелевой', ''],
    ]);
    assert.deepEqual(b.sources.map(([k]) => k), ['call', 'instagram', 'telegram', 'website', 'walk_in', 'referral', 'other']);
    assert.equal(b.convertStatus, 'came');
    assert.deepEqual(b.activeStatuses, ['in_process', 'recall', 'scheduled', 'approved']);
    assert.deepEqual(b.lostStatuses, ['no_show', 'stopped', 'not_qualified']);
});

test('boardConfig: a config with no conversion column still has one — CONVERT_STATUS can never be undefined', () => {
    const b = boardConfig({ stages: [{ key: 'a', label: 'А', kind: 'open', is_active: 1, position: 1 }] });
    assert.equal(b.convertStatus, FALLBACK_CONVERT_STAGE);
});

// --- 501 ---------------------------------------------------------------------

test('isNotImplemented is the same 501 rule the telephony screen uses', () => {
    assert.equal(isNotImplemented({ code: 'rpc_not_implemented' }), true);
    assert.equal(isNotImplemented({ message: 'RPC failed (501)' }), true);
    assert.equal(isNotImplemented({ message: 'нет доступа' }), false);
    assert.equal(isNotImplemented(null), false);
});
