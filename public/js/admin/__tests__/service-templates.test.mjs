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
