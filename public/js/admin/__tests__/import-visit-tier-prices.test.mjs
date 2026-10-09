// CLINIC_API_FIX_V1 — импорт Excel не обнуляет цены второго и повторного визита.
//
// price_secondary / price_repeat и их окна (мигр. 127, 130) ПУСТЫЕ, пока
// клиника их не задала: пусто — «как первый визит». Импорт писал в них 0 и
// когда колонок в листе нет, и когда ячейка пустая (а выгрузка пишет пустую
// ячейку у каждой услуги без ступеней). Для цены визита 0 — это «бесплатно»:
// visit-tier.js видит у услуги ступени, окно 0…0 дней, и второй визит в тот
// же день выставлялся по 0. Здесь — что попадает в строку и что из неё
// насчитает касса.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Minimal DOM so the view module (and i18n it pulls) can load; nothing renders here.
class F { constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this.dataset = {}; this.value = ''; }
    appendChild(c) { this.children.push(c); return c; } removeChild() {} setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener() {} removeEventListener() {} querySelector() { return null; } querySelectorAll() { return []; } remove() {}
    get textContent() { return this._t; } set textContent(v) { this._t = String(v); }
    get classList() { return { contains: () => false, add() {}, remove() {}, toggle() {} }; } }
const mk = (t) => new F(t);
globalThis.Node = F;
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => { const e = mk('#text'); e._t = String(t); return e; }, head: mk('head'), body: mk('body'), documentElement: mk('html'), addEventListener() {}, removeEventListener() {}, getElementById() { return null; } };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
const { buildImportRow } = await import('../views/section-import-export.js');
const { tierFor } = await import('../../../../server/services/domain/visit-tier.js');

const BASE = { name: 'Приём кардиолога', group: 'Консультация', price: 200000 };
const TIER_KEYS = ['price_secondary', 'secondary_days_from', 'secondary_days_to', 'price_repeat', 'repeat_days_from', 'repeat_days_to'];
const EMPTY_TIERS = Object.fromEntries(TIER_KEYS.map((k) => [k, '']));

// Цена строки визита по услуге, собранной из импортированной строки: второй
// визит в тот же день после первичного.
const sameDaySecond = (payload) => tierFor({ ...payload }, { day: '2026-10-06', tier: 'primary' }, '2026-10-06');

test('колонок цен визита в листе нет — цены и окна не трогаются (старый файл не обнуляет настройку)', () => {
    const row = buildImportRow('services', { ...BASE });
    for (const k of TIER_KEYS) assert.ok(!(k in row.payload), k + ' попал в строку: ' + JSON.stringify(row.payload[k]));
    assert.strictEqual(row.status, 'ok');
});

test('пустые ячейки под своими заголовками — «не задано» (null), а не 0; второй визит в тот же день — по полной цене', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS });
    for (const k of TIER_KEYS) assert.strictEqual(row.payload[k], null, k);
    const q = sameDaySecond(row.payload);
    assert.strictEqual(q.price, 200000, 'второй визит выставлен по ' + q.price + ' — пустая ячейка стала «бесплатно»');
    assert.strictEqual(q.tier, 'primary');
});

test('заполненные ячейки читаются как раньше; 0 в цене повторного визита — осознанное «бесплатно»', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS,
        price_secondary: '60 000', secondary_days_from: 1, secondary_days_to: 6, price_repeat: 0, repeat_days_from: '', repeat_days_to: '' });
    assert.strictEqual(row.payload.price_secondary, 60000);
    assert.strictEqual(row.payload.secondary_days_from, 1);
    assert.strictEqual(row.payload.secondary_days_to, 6);
    assert.strictEqual(row.payload.price_repeat, 0);
    assert.strictEqual(row.payload.repeat_days_from, null);
    assert.strictEqual(row.payload.repeat_days_to, null);
    const q = tierFor({ ...row.payload }, { day: '2026-10-03', tier: 'primary' }, '2026-10-06');
    assert.deepStrictEqual([q.tier, q.price], ['secondary', 60000]);
});

// CLINIC_API_FIX_V1 (ревью итога, решение) — цена визита — деньги: не число
// в ней у НОВОЙ услуги строку не ввозит (как цена); в днях окна — «не задано».
test('не число в днях окна («abc») — «не задано», а не бесплатно', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, price_secondary: 60000, secondary_days_from: 1, secondary_days_to: 'abc' });
    assert.strictEqual(row.payload.secondary_days_to, null);
    assert.notStrictEqual(row.status, 'error');
});

test('не число в цене визита («—», «нет») у новой услуги — строка не ввозится, а не «бесплатно» и не «не задано» молча', () => {
    for (const cells of [{ price_secondary: '—' }, { price_repeat: 'нет' }]) {
        const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, ...cells });
        assert.strictEqual(row.status, 'error', JSON.stringify(row.notes));
    }
});

// CLINIC_API_FIX_V1 (ревью) — ячейка не число: строка ГОВОРИТ об этом (номер
// строки и колонка), а не молча ставит полную цену. (Ревью итога: у новой
// услуги — ошибкой, строка не ввозится.)
test('не число в ячейке цены визита — ошибка с номером строки и колонкой', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, price_secondary: '—' }, { rowNum: 4 });
    assert.strictEqual(row.status, 'error');
    const note = row.notes.find((n) => /price_secondary/.test(String(n)));
    assert.ok(note, JSON.stringify(row.notes));
    assert.match(String(note), /Строка 4\b/);
    assert.match(String(note), /не число/);
});

// CLINIC_API_FIX_V1 (ревью) — правила окна услуги (service_save,
// VISIT_TIER_PRICING_V1 / REPEAT_WINDOW_V1): цена — неотрицательное число,
// дни — целые неотрицательные, «по» не раньше «с», окно без цены не задаётся.
// Строка, нарушившая правило, цен второго и повторного визита из файла не
// пишет (остаются прежние / не заданы) и говорит почему; остальное ложится.
const tierDropped = (row) => TIER_KEYS.every((k) => !(k in row.payload));
const CASES = [
    ['отрицательная цена', { price_secondary: -5000, secondary_days_from: 1, secondary_days_to: 6 }, /price_secondary — неотрицательное число/],
    ['дробные дни', { price_secondary: 60000, secondary_days_from: 1.5, secondary_days_to: 6 }, /secondary_days_from — целое неотрицательное число дней/],
    ['отрицательные дни', { price_repeat: 0, repeat_days_from: -1 }, /repeat_days_from — целое неотрицательное число дней/],
    ['окно второго визита наоборот', { price_secondary: 60000, secondary_days_from: 6, secondary_days_to: 1 }, /Окно второго визита: «по день» не может быть раньше «со дня»/],
    ['окно повторного визита наоборот', { price_repeat: 0, repeat_days_from: 10, repeat_days_to: 3 }, /Окно повторного визита: «не позже чем через» не может быть раньше «не раньше чем через»/],
    // CLINIC_API_FIX_V1 (ревью 4) — окно без цены в той же строке — полступени:
    // не пишется эта ступень, предупреждение «неполная ступень».
    ['окно второго визита без цены', { secondary_days_from: 1, secondary_days_to: 6 }, /неполная ступень/, ['price_secondary', 'secondary_days_from', 'secondary_days_to']],
    ['окно повторного визита без цены', { repeat_days_from: 7 }, /неполная ступень/, ['price_repeat', 'repeat_days_from', 'repeat_days_to']],
];
for (const [what, cells, re, dropKeys] of CASES) {
    test('правило окна услуги: ' + what + ' — цены визитов строки не пишутся, предупреждение', () => {
        const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, ...cells, tax_rate: 12 }, { rowNum: 9 });
        assert.ok(dropKeys ? dropKeys.every((k) => !(k in row.payload)) : tierDropped(row), 'цены визитов записаны: ' + JSON.stringify(row.payload));
        assert.strictEqual(row.payload.price, 200000, 'остальная строка ложится');
        assert.strictEqual(row.status, 'warn');
        const note = row.notes.find((n) => re.test(String(n)));
        assert.ok(note, JSON.stringify(row.notes));
        assert.match(String(note), /Строка 9\b/);
        assert.ok(String(note).includes('Приём кардиолога'));
    });
}

test('обновление: правило проверяется по тому, что окажется у услуги (файл поверх сохранённого)', () => {
    const stored = (extra) => ({ __wantUpdate: true, __stored: new Map([['приём кардиолога', {
        name: 'Приём кардиолога', price_secondary: 60000, secondary_days_from: 1, secondary_days_to: 6, price_repeat: null, repeat_days_from: null, repeat_days_to: null, ...extra }]]) });
    // CLINIC_API_FIX_V1 (ревью 4) — ступень визита — одно целое (цена + дни):
    // все её ячейки в листе пусты — ступень снимается целиком (цена и оба дня
    // — NULL), окно без цены не остаётся.
    const cleared = buildImportRow('services', { ...BASE, price_secondary: '' }, { rowNum: 3, lookups: stored() });
    assert.deepStrictEqual(['price_secondary', 'secondary_days_from', 'secondary_days_to'].map((k) => cleared.payload[k]), [null, null, null], JSON.stringify(cleared.payload));
    assert.notStrictEqual(cleared.status, 'error');
    assert.ok(!cleared.notes.some((n) => /Укажите цену второго визита/.test(String(n))), JSON.stringify(cleared.notes));
    // Окно по сохранённой цене — проходит, если с ним всё в порядке.
    const ok = buildImportRow('services', { ...BASE, secondary_days_to: 10 }, { rowNum: 3, lookups: stored() });
    assert.strictEqual(ok.payload.secondary_days_to, 10);
    assert.strictEqual(ok.status, 'ok', JSON.stringify(ok.notes));
    // Файл сдвигает «по день» раньше сохранённого «со дня» — отказ.
    const order = buildImportRow('services', { ...BASE, secondary_days_to: 0 }, { rowNum: 3, lookups: stored({ secondary_days_from: 2 }) });
    assert.ok(tierDropped(order));
    assert.ok(order.notes.some((n) => /«по день» не может быть раньше «со дня»/.test(String(n))), JSON.stringify(order.notes));
});

test('допустимые значения — как раньше, без предупреждений', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, price_secondary: 60000, secondary_days_from: 0, secondary_days_to: 6,
        price_repeat: 0, repeat_days_from: 7, repeat_days_to: 30 });
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
    assert.deepStrictEqual(TIER_KEYS.map((k) => row.payload[k]), [60000, 0, 6, 0, 7, 30]);
});

// ---------------------------------------------------------------------------
// CLINIC_API_FIX_V1 (ревью 4, C1) — СТУПЕНЬ ВИЗИТА — ОДНО ЦЕЛОЕ: цена + «со
// дня» + «по день». Правило ревью 3 оставляло пустую цену второго визита
// сохранённой, а её пустые дни писало как NULL; visit-tier.js читает «по
// день» = NULL как «без предела», и скидка второго визита действовала
// вечно — со статусом «готово». Теперь:
//   • все ячейки ступени пусты — ступень снимается (цена и дни — NULL),
//     как обещает подсказка «пусто — как первый»;
//   • цена заполнена — как раньше;
//   • цена пуста, а день заполнен (полступени) — не пишется ни одна ячейка
//     ступени, строка с предупреждением «неполная ступень — оставлено как было».
// ---------------------------------------------------------------------------
const C1_STORED = () => ({ __wantUpdate: true, __stored: new Map([['приём кардиолога', {
    name: 'Приём кардиолога', price: 200000, price_secondary: 50000, secondary_days_from: 1, secondary_days_to: 7,
    price_repeat: null, repeat_days_from: null, repeat_days_to: null }]]) });
const SECOND = ['price_secondary', 'secondary_days_from', 'secondary_days_to'];
const afterUpdate = (stored, payload) => ({ ...stored, ...Object.fromEntries(Object.entries(payload).filter(([k]) => k in stored)) });

test('C1: у обновляемой услуги все три ячейки второго визита пусты — ступень снята, а не «цена навсегда»', () => {
    const lookups = C1_STORED();
    const row = buildImportRow('services', { ...BASE, price_secondary: '', secondary_days_from: '', secondary_days_to: '' }, { rowNum: 5, lookups });
    assert.deepStrictEqual(SECOND.map((k) => row.payload[k]), [null, null, null], JSON.stringify(row.payload));
    assert.notStrictEqual(row.status, 'error', JSON.stringify(row.notes));
    // Касса после обновления: через 3, 60 и 400 дней — полная цена.
    const svc = afterUpdate(lookups.__stored.get('приём кардиолога'), row.payload);
    for (const prevDay of ['2026-10-06', '2026-08-10', '2025-09-04']) {
        assert.strictEqual(tierFor(svc, { day: prevDay, tier: 'primary' }, '2026-10-09').price, 200000, 'второй визит после ' + prevDay + ' не по полной цене');
    }
});

test('C1: до правки (цена сохранена, дни NULL) касса брала бы 50 000 и через год — стенд', () => {
    const broken = { price: 200000, price_secondary: 50000, secondary_days_from: null, secondary_days_to: null };
    assert.strictEqual(tierFor(broken, { day: '2025-09-04', tier: 'primary' }, '2026-10-09').price, 50000);
});

test('полступени: цена пуста, а дни заполнены — ступень не пишется, строка с предупреждением', () => {
    const row = buildImportRow('services', { ...BASE, price_secondary: '', secondary_days_from: 1, secondary_days_to: 7 }, { rowNum: 6, lookups: C1_STORED() });
    for (const k of SECOND) assert.ok(!(k in row.payload), k + ' записано: ' + JSON.stringify(row.payload[k]));
    assert.strictEqual(row.status, 'warn');
    assert.ok(row.notes.some((n) => String(n).includes('неполная ступень — оставлено как было')), JSON.stringify(row.notes));
    // Новая услуга с полступени — тоже ничего не пишется и предупреждение.
    const fresh = buildImportRow('services', { ...BASE, price_repeat: '', repeat_days_from: 7 }, { rowNum: 6 });
    assert.ok(!('price_repeat' in fresh.payload) && !('repeat_days_from' in fresh.payload), JSON.stringify(fresh.payload));
    assert.strictEqual(fresh.status, 'warn');
});

test('цена второго визита заполнена — пишется как раньше; пустые дни — «не задано»', () => {
    const row = buildImportRow('services', { ...BASE, price_secondary: 60000, secondary_days_from: '', secondary_days_to: '' }, { lookups: C1_STORED() });
    assert.deepStrictEqual(SECOND.map((k) => row.payload[k]), [60000, null, null]);
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

// CLINIC_API_FIX_V1 (ревью 5) — колонки, которой нет в листе, импорт не меняет:
// снять ступень можно только пустой ячейкой ЦЕНЫ. Нет колонки цены — пустые
// дни ничего не меняют (было: стирали и сохранённую цену); заполненный день
// пишется, пустой — остаётся как был (не «без предела» под сохранённой ценой).
test('колонки цены второго визита в листе нет — пустые дни ничего не меняют, с замечанием', () => {
    const row = buildImportRow('services', { ...BASE, secondary_days_from: '', secondary_days_to: '' }, { rowNum: 7, lookups: C1_STORED() });
    for (const k of SECOND) assert.ok(!(k in row.payload), k + ' записано: ' + JSON.stringify(row.payload[k]));
    assert.notStrictEqual(row.status, 'error');
    assert.ok(row.notes.some((n) => String(n).includes('без колонки price_secondary')), JSON.stringify(row.notes));
});

test('колонки цены нет: «со дня» заполнено, «по день» пусто — пишется «со дня», «по день» остаётся сохранённым', () => {
    const row = buildImportRow('services', { ...BASE, secondary_days_from: 2, secondary_days_to: '' }, { lookups: C1_STORED() });
    assert.strictEqual(row.payload.secondary_days_from, 2);
    assert.ok(!('secondary_days_to' in row.payload), 'сохранённое «по день» 7 стёрто: ' + JSON.stringify(row.payload.secondary_days_to));
    assert.ok(!('price_secondary' in row.payload));
});

test('подпись «неполная ступень» — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    const k = 'Строка {n}, «{service}»: {cols} — неполная ступень — оставлено как было.';
    const e = STRINGS[k];
    assert.ok(e && e.ru === k && e.uz && e.en, 'нет перевода: ' + k);
});

// ---------------------------------------------------------------------------
// CLINIC_API_FIX_V1 (ревью 5) — ЦЕНА ВИЗИТА БЕЗ ОКНА. visit-tier.js: второй
// визит идёт по окну второго визита (нет «по день» — без предела) и, если цены
// второго визита нет, берёт цену повторного; повторный — по своему окну, а без
// своего — по окну второго. Снятая ступень второго визита оставляла цену
// повторного (0 или 30 000) без окна — и она действовала со второго визита
// всегда. Одно правило (shared/visit-tier-rules.js) у окна услуги и у импорта:
// такое состояние — ошибка с понятной причиной; импорт ступени не пишет
// (сохранённые остаются), строка с предупреждением.
// ---------------------------------------------------------------------------
const STORED_WITH = (extra) => ({ __wantUpdate: true, __stored: new Map([['приём кардиолога', {
    name: 'Приём кардиолога', price: 200000, price_secondary: 50000, secondary_days_from: 1, secondary_days_to: 7,
    price_repeat: null, repeat_days_from: null, repeat_days_to: null, ...extra }]]) });
const CLEAR_SECOND = { price_secondary: '', secondary_days_from: '', secondary_days_to: '' };

for (const [what, extra] of [
    ['повторный визит бесплатно, общее окно', { price_repeat: 0 }],
    ['повторный 30 000 со своим окном 1–30', { price_repeat: 30000, repeat_days_from: 1, repeat_days_to: 30 }],
]) {
    test('снять второй визит, когда есть ' + what + ' — не пишется, предупреждение, касса как была', () => {
        const lookups = STORED_WITH(extra);
        const row = buildImportRow('services', { ...BASE, ...CLEAR_SECOND }, { rowNum: 4, lookups });
        assert.ok(TIER_KEYS.every((k) => !(k in row.payload)), 'ступени записаны: ' + JSON.stringify(row.payload));
        assert.strictEqual(row.status, 'warn');
        assert.ok(row.notes.some((n) => String(n).includes('без срока')), JSON.stringify(row.notes));
        const svc = lookups.__stored.get('приём кардиолога');
        assert.strictEqual(tierFor(svc, { day: '2025-09-04', tier: 'primary' }, '2026-10-09').price, 200000, 'через 400 дней — не полная цена');
    });
}

test('цена повторного визита со своим «не раньше», но без «не позже» при ограниченном втором визите — не пишется', () => {
    const row = buildImportRow('services', { ...BASE, price_repeat: 20000, repeat_days_from: 1, repeat_days_to: '' }, { rowNum: 4, lookups: STORED_WITH({}) });
    assert.ok(TIER_KEYS.every((k) => !(k in row.payload)), JSON.stringify(row.payload));
    assert.strictEqual(row.status, 'warn');
    assert.ok(row.notes.some((n) => String(n).includes('«не позже чем через»')), JSON.stringify(row.notes));
});

test('цена второго визита, набранная без «по день», — «без предела» по подсказке (одна ступень), пишется', () => {
    const row = buildImportRow('services', { ...BASE, price_secondary: 60000, secondary_days_from: 1, secondary_days_to: '' }, { lookups: STORED_WITH({}) });
    assert.strictEqual(row.payload.price_secondary, 60000);
    assert.strictEqual(row.payload.secondary_days_to, null);
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

test('правило — одно: импорт и окно услуги зовут shared/visit-tier-rules.js', () => {
    const imp = fs.readFileSync(new URL('../views/section-import-export.js', import.meta.url), 'utf8');
    const srv = fs.readFileSync(new URL('../../../../server/services/rpc/service-save.js', import.meta.url), 'utf8');
    assert.match(imp, /from '\.\.\/\.\.\/shared\/visit-tier-rules\.js'/);
    assert.match(srv, /shared\/visit-tier-rules\.js'/);
    assert.match(imp, /visitTierStateProblem\(/);
    assert.match(srv, /visitTierStateProblem\(/);
});

test('сообщения правила цен визитов — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    const { VISIT_TIER_MESSAGES } = await import('../../shared/visit-tier-rules.js');
    for (const k of Object.values(VISIT_TIER_MESSAGES)) {
        const e = STRINGS[k];
        assert.ok(e && e.uz && e.en, 'нет перевода: ' + k);
    }
});

// CLINIC_API_FIX_V1 (ревью 7) — как у окна услуги: состояние цен визитов
// проверяется, только когда СТРОКА меняет хоть одно их поле. Услуга, уже
// сохранённая в состоянии «без срока», и файл «название + цена» (без колонок
// цен визитов) — строка обычная, без предупреждения «цены визитов из этой строки
// не сохранены»: строка их и не трогает.
const STORED_BAD = () => ({ __wantUpdate: true, __stored: new Map([['только повтор', {
    name: 'Только повтор', type: 'consultation', price: 150000, tax_rate: 12, default_doctor_percent: 0,
    price_secondary: null, secondary_days_from: null, secondary_days_to: null, price_repeat: 0, repeat_days_from: 1, repeat_days_to: 14 }]]) });
test('сохранённое «без срока» + файл без колонок цен визитов — строка без предупреждения', () => {
    for (const raw of [{ name: 'Только повтор', group: 'Консультация', price: 160000 }, { name: 'Только повтор', group: 'Консультация', code: 'X-1' }]) {
        const row = buildImportRow('services', raw, { rowNum: 2, lookups: STORED_BAD() });
        assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
        assert.ok(TIER_KEYS.every((k) => !(k in row.payload)));
    }
});

test('сохранённое «без срока» + те же значения цен визитов (свой экспорт) — без изменений и без предупреждения', () => {
    const row = buildImportRow('services', { name: 'Только повтор', group: 'Консультация', price: 150000,
        price_secondary: '', secondary_days_from: '', secondary_days_to: '', price_repeat: 0, repeat_days_from: 1, repeat_days_to: 14 }, { rowNum: 2, lookups: STORED_BAD() });
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

test('сохранённое «без срока» + правка цены повторного визита (всё ещё «без срока») — не пишется, предупреждение', () => {
    const row = buildImportRow('services', { name: 'Только повтор', group: 'Консультация', price: 150000, price_repeat: 10000 }, { rowNum: 2, lookups: STORED_BAD() });
    assert.ok(TIER_KEYS.every((k) => !(k in row.payload)), JSON.stringify(row.payload));
    assert.strictEqual(row.status, 'warn');
});

// CLINIC_API_FIX_V1 (ревью 7) — без колонки цены визита не число в дне
// называется ОДИН раз и точно («не число — не записано»), а не ещё и как
// «пустые … ничего не меняют».
test('без колонки цены: не число в дне — одно точное сообщение о нём', () => {
    const row = buildImportRow('services', { name: 'Новая', group: 'Консультация', price: 1000, secondary_days_from: 'нет', secondary_days_to: 5 }, { rowNum: 2 });
    const about = row.notes.map(String).filter((n) => n.includes('secondary_days_from'));
    assert.deepStrictEqual(about, ['Строка 2: в колонке secondary_days_from не число («нет») — не записано.'], JSON.stringify(row.notes));
});

test('комментарий MRN_BEYOND_99999_V1 стоит у импорта mrnSeriesRefusal', () => {
    const src = fs.readFileSync(new URL('../views/section-import-export.js', import.meta.url), 'utf8');
    assert.match(src, /import \{ mrnSeriesRefusal \} from '\.\.\/patient-duplicates\.js';\s*\/\/ MRN_BEYOND_99999_V1/);
    assert.ok(!/visit-tier-rules\.js';[^\n]*MRN_BEYOND_99999_V1/.test(src), 'комментарий MRN остался у чужого импорта');
});
