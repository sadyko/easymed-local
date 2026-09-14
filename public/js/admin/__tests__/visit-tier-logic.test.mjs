// VISIT_TIER_PRICING_V1 — the screen's side: the quote lands on cart lines,
// detaching the patient restores catalog prices, and the wizard / editor /
// doctor's workspace all go through service_price_quote (static checks —
// these views have no DOM harness of their own).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tierLabel, tierApplies, quotableIds, applyQuotes, resetQuotes, priceTierOf } from '../visit-tier-logic.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

const cart = () => [
    { service: { id: 5, name: 'Приём невролога', price: 200000 } },
    { service: { id: 7, name: 'УЗИ', price: 90000 } },
    { service: { id: 'ct-1', name: 'Консультация', price: 120000, __consult: true } },
    { service: { id: 5, name: 'Приём невролога', price: 200000 } },
];

test('quotableIds: catalog services only, consultation pseudo-services skipped, no duplicates', () => {
    assert.deepEqual(quotableIds(cart()), [5, 7]);
    assert.deepEqual(quotableIds([]), []);
    assert.deepEqual(quotableIds(null), []);
});

test('applyQuotes puts the tier and the quoted price on the line, keeps the catalog price for undo; resetQuotes restores it', () => {
    const items = cart();
    const n = applyQuotes(items, {
        5: { tier: 'secondary', price: 60000, base_price: 200000, days_since: 3, prev_day: '2026-09-11' },
        7: { tier: 'primary', price: 90000, base_price: 90000, days_since: null, prev_day: null },
    });
    assert.equal(n, 2, 'two lines changed price (both «Приём» lines)');
    assert.equal(items[0].service.price, 60000);
    assert.equal(items[0].service.__base_price, 200000);
    assert.deepEqual(items[0].tier, { tier: 'secondary', price: 60000, base_price: 200000, days_since: 3, prev_day: '2026-09-11' });
    assert.equal(items[1].service.price, 90000, 'primary — unchanged');
    assert.equal(items[1].tier.tier, 'primary');
    assert.equal(items[2].tier, undefined, 'consultation untouched');
    assert.equal(priceTierOf(items[0]), 'secondary');
    assert.equal(priceTierOf(items[1]), 'primary');
    assert.equal(priceTierOf(items[2]), null);

    // A second quote (patient changed) re-bases from the CATALOG price, not the previous quote.
    applyQuotes(items, { 5: { tier: 'repeat', price: 0, base_price: 200000, days_since: 1 } });
    assert.equal(items[0].service.price, 0);
    assert.equal(items[0].tier.base_price, 200000);

    resetQuotes(items);
    assert.equal(items[0].service.price, 200000);
    assert.equal(items[0].service.__base_price, undefined);
    assert.equal(items[0].tier, undefined);
    assert.equal(items[1].service.price, 90000);
});

test('tierLabel / tierApplies: only second and repeat visits get a chip', () => {
    assert.equal(tierLabel('secondary'), 'Второй визит');
    assert.equal(tierLabel('repeat'), 'Повторный визит');
    assert.equal(tierLabel('primary'), '');
    assert.equal(tierApplies({ tier: 'secondary' }), true);
    assert.equal(tierApplies({ tier: 'primary' }), false);
    assert.equal(tierApplies(null), false);
});

test('the editor sends the four tier fields; the wizard, attach path and doctor workspace store the tier on the line', () => {
    const editor = read('views/service-editor.js');
    for (const key of ['price_secondary', 'secondary_days_from', 'secondary_days_to', 'price_repeat']) {
        assert.match(editor, new RegExp(key + '\\s*:\\s*numOrNull\\('), 'редактор не отправляет ' + key);
    }
    assert.ok(editor.includes('Цена по счёту визита'), 'секция цен по визиту в редакторе');
    const wizard = read('views/service-picker-modal.js');
    assert.match(wizard, /rpc\('service_price_quote'/, 'смета спрашивает цену у сервера');
    assert.match(wizard, /price_tier:\s*isConsult \? null : priceTierOf\(a\)/, 'строка визита несёт ступень');
    assert.match(wizard, /onPick\(\{[^}]*price_tier: priceTierOf\(a\)/, 'режим «добавить к визиту» отдаёт ступень вызывающему');
    const vm = read('views/visit-modal.js');
    assert.match(vm, /price_tier:\s*price_tier \|\| null/, 'visit-modal кладёт ступень в строку');
    const ws = read('views/service-workspace.js');
    assert.match(ws, /rpc\('service_price_quote'/, 'кабинет врача идёт через ту же котировку');
});
