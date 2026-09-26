// WIZ_TEMPLATES_LOCAL_V1 — шаблоны сметы, data layer.
//
// Kept free of any DOM/ui.js import so it can be tested directly: the modals
// that use it live in the view, the rules about what a template IS live here.
//
// The `service_ids` string case below is not hypothetical. The registry did not
// declare service_ids as a json column, so the API returned the raw TEXT
// "[1,2]". Array.isArray() rejects that, so every template rendered as
// «услуг: 0» and applying one added nothing. The registry is fixed, and
// resolveTemplate stays defensive so a stale row can never resurrect that.

import { test } from 'node:test';
import assert from 'node:assert';
import { resolveTemplate, createTemplate, retireTemplate, listTemplates } from '../views/service-templates.js';

const CATALOG = [
  { id: 1, name: 'Консультация кардиолога', price: 100000 },
  { id: 2, name: 'С-реактивный белок', price: 35000 },
  { id: 3, name: 'Гомоцистеин', price: 90000 },
];

// Chainable supabase double recording every call.
function mockSupabase(result = { data: [], error: null }) {
  const calls = [];
  const q = {
    insert(v) { calls.push(['insert', v]); return q; },
    update(v) { calls.push(['update', v]); return q; },
    delete() { calls.push(['delete']); return q; },
    select(c) { calls.push(['select', c]); return q; },
    eq(c, v) { calls.push(['eq', c, v]); return q; },
    order(c) { calls.push(['order', c]); return q; },
    then(res, rej) { return Promise.resolve(result).then(res, rej); },
  };
  return { calls, from(t) { calls.push(['from', t]); return q; } };
}

test('resolveTemplate maps ids to catalogue services, in template order', () => {
  const out = resolveTemplate({ service_ids: [3, 1] }, CATALOG);
  assert.deepStrictEqual(out.services.map(s => s.id), [3, 1]);
  assert.strictEqual(out.missing, 0);
});

test('a service deleted since the template was saved is counted, not crashed on', () => {
  const out = resolveTemplate({ service_ids: [1, 999] }, CATALOG);
  assert.deepStrictEqual(out.services.map(s => s.id), [1]);
  assert.strictEqual(out.missing, 1);
});

// The exact shape that made every template show «услуг: 0».
test('service_ids arriving as a JSON string is still understood', () => {
  const out = resolveTemplate({ service_ids: '[1,2]' }, CATALOG);
  assert.deepStrictEqual(out.services.map(s => s.id), [1, 2]);
  assert.strictEqual(out.missing, 0);
});

test('a malformed or empty template yields nothing rather than throwing', () => {
  for (const bad of [null, undefined, {}, { service_ids: null }, { service_ids: 'not json' }, { service_ids: 42 }]) {
    const out = resolveTemplate(bad, CATALOG);
    assert.deepStrictEqual(out.services, [], JSON.stringify(bad));
    assert.strictEqual(out.missing, 0, JSON.stringify(bad));
  }
});

test('ids match across string/number, since json columns and inputs disagree', () => {
  const out = resolveTemplate({ service_ids: ['1', 2] }, CATALOG);
  assert.deepStrictEqual(out.services.map(s => s.id), [1, 2]);
});

test('createTemplate refuses a blank name without touching the server', async () => {
  const supabase = mockSupabase();
  const res = await createTemplate(supabase, { name: '   ', serviceIds: [1] });
  assert.ok(res.error, 'a nameless template is unfindable — it must be refused');
  assert.strictEqual(supabase.calls.length, 0, 'nothing may be sent');
});

test('createTemplate refuses an empty смета', async () => {
  const supabase = mockSupabase();
  const res = await createTemplate(supabase, { name: 'Пусто', serviceIds: [] });
  assert.ok(res.error);
  assert.strictEqual(supabase.calls.length, 0);
});

test('createTemplate sends the name and the ids as an array', async () => {
  const supabase = mockSupabase({ data: null, error: null });
  await createTemplate(supabase, { name: '  Первичный приём  ', serviceIds: [1, 2] });
  assert.deepStrictEqual(supabase.calls[0], ['from', 'service_templates']);
  const [, payload] = supabase.calls[1];
  assert.strictEqual(payload.name, 'Первичный приём', 'name is trimmed');
  assert.deepStrictEqual(payload.service_ids, [1, 2], 'ids go as an ARRAY — the json column serialises it');
  assert.strictEqual(payload.active, true);
});

// Retiring must never hard-delete: DELETE is admin-only, and a template the
// registrar retires should stay recoverable.
test('retireTemplate soft-deletes via active=false', async () => {
  const supabase = mockSupabase({ data: null, error: null });
  await retireTemplate(supabase, 7);
  assert.deepStrictEqual(supabase.calls[1], ['update', { active: false }]);
  assert.deepStrictEqual(supabase.calls[2], ['eq', 'id', 7]);
  assert.ok(!supabase.calls.some(c => c[0] === 'delete'), 'must not hard-delete');
});

test('listTemplates asks only for active ones, by name', async () => {
  const supabase = mockSupabase({ data: [], error: null });
  await listTemplates(supabase);
  assert.ok(supabase.calls.some(c => c[0] === 'eq' && c[1] === 'active' && c[2] === true));
  assert.ok(supabase.calls.some(c => c[0] === 'order' && c[1] === 'name'));
});

// --- PACKAGES_V1 — пакет: скидка и окно предложения -------------------------
import { packageState, packageValidOn, packageDiscount, packageValidityParts, localToday } from '../views/service-templates.js';

test('окно пакета включительно с обеих сторон; пустая граница — без ограничения', () => {
  const t = { valid_from: '2026-09-01', valid_until: '2026-09-30' };
  assert.strictEqual(packageState(t, '2026-08-31'), 'upcoming');
  assert.strictEqual(packageState(t, '2026-09-01'), 'active');
  assert.strictEqual(packageState(t, '2026-09-30'), 'active');
  assert.strictEqual(packageState(t, '2026-10-01'), 'expired');
  assert.ok(packageValidOn({}, '2030-01-01'), 'прежний шаблон без дат действует всегда');
  assert.ok(packageValidOn({ valid_until: '2026-09-30' }, '2000-01-01'));
  assert.ok(!packageValidOn({ valid_from: '2026-09-30' }, '2026-09-29'));
});

test('скидка пакета: 0..100, испорченное значение — 0', () => {
  assert.strictEqual(packageDiscount({ discount_percent: 20 }), 20);
  assert.strictEqual(packageDiscount({ discount_percent: 150 }), 100);
  for (const v of [null, undefined, 'abc', -5]) assert.strictEqual(packageDiscount({ discount_percent: v }), 0);
});

test('подпись срока в списке настроек: действует до / истёк / ещё не начался / бессрочно', () => {
  assert.deepStrictEqual(packageValidityParts({ valid_until: '2026-09-30' }, '2026-09-10'), ['действует до {date}', { date: '30.09.2026' }]);
  assert.deepStrictEqual(packageValidityParts({ valid_until: '2026-08-31' }, '2026-09-10'), ['истёк {date}', { date: '31.08.2026' }]);
  assert.deepStrictEqual(packageValidityParts({ valid_from: '2026-10-01' }, '2026-09-10'), ['ещё не начался — с {date}', { date: '01.10.2026' }]);
  assert.deepStrictEqual(packageValidityParts({ valid_from: '2026-09-01' }, '2026-09-10'), ['действует с {date}', { date: '01.09.2026' }]);
  assert.deepStrictEqual(packageValidityParts({}, '2026-09-10'), ['бессрочно', {}]);
});

test('listTemplates отдаёт только пакеты, действующие в названный день; on:null — все', async () => {
  const rows = [
    { id: 1, name: 'A', service_ids: [1], valid_until: '2026-09-30' },
    { id: 2, name: 'B', service_ids: [1], valid_until: '2026-09-01' },
    { id: 3, name: 'C', service_ids: [1] },
  ];
  const supabase = mockSupabase({ data: rows, error: null });
  const res = await listTemplates(supabase, { on: '2026-09-10' });
  assert.deepStrictEqual(res.data.map((r) => r.id), [1, 3]);
  assert.ok(supabase.calls.some((c) => c[0] === 'select' && /discount_percent/.test(c[1]) && /valid_until/.test(c[1])), 'скидку и срок не спросили');
  const all = await listTemplates(mockSupabase({ data: rows, error: null }), { on: null });
  assert.strictEqual(all.data.length, 3);
  assert.match(localToday(new Date(2026, 8, 5)), /^2026-09-05$/);
});

test('смета, сохранённая шаблоном, — пакет без скидки и без дат (сервер ставит 0 и NULL сам)', async () => {
  const supabase = mockSupabase();
  await createTemplate(supabase, { name: 'Смета', serviceIds: [1] });
  const ins = supabase.calls.find((c) => c[0] === 'insert')[1];
  assert.deepStrictEqual(Object.keys(ins).sort(), ['active', 'name', 'service_ids']);
});
