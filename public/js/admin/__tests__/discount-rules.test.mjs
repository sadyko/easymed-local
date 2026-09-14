// DISCOUNT_RULES_V1 — срок, группа пациентов, услуги; сумма скидки по строкам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discountBlockReason, eligibleDiscounts, discountValue, discountOptionParts, serviceScope, localYmd } from '../discount-rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

const T = '2026-09-14';
const base = { id: 1, name: 'chegirma', kind: 'promo', percent: 10, amount: 0, active: 1, valid_from: null, valid_until: null, category_id: null, service_ids: [] };

test('без ограничений скидка подходит всем и всегда', () => {
    assert.equal(discountBlockReason(base, { today: T, categoryId: null, serviceIds: [5] }), '');
    assert.equal(discountBlockReason({ ...base, service_ids: null, category_id: '' }, { today: T }), '');
});

test('срок: до «с» — ещё не действует, после «по» — истекла; границы включительно', () => {
    assert.equal(discountBlockReason({ ...base, valid_from: '2026-09-15' }, { today: T }), 'not_yet');
    assert.equal(discountBlockReason({ ...base, valid_from: '2026-09-14' }, { today: T }), '');
    assert.equal(discountBlockReason({ ...base, valid_until: '2026-09-13' }, { today: T }), 'expired');
    assert.equal(discountBlockReason({ ...base, valid_until: '2026-09-14' }, { today: T }), '');
    assert.equal(discountBlockReason({ ...base, valid_until: '2026-09-14T00:00:00Z' }, { today: T }), '', 'дата с временем читается как день');
});

test('группа: скидка для группы 3 не подходит пациенту без группы или из группы 4', () => {
    assert.equal(discountBlockReason({ ...base, category_id: 3 }, { today: T, categoryId: null }), 'other_group');
    assert.equal(discountBlockReason({ ...base, category_id: 3 }, { today: T, categoryId: 4 }), 'other_group');
    assert.equal(discountBlockReason({ ...base, category_id: 3 }, { today: T, categoryId: 3 }), '');
    assert.equal(discountBlockReason({ ...base, category_id: '3' }, { today: T, categoryId: 3 }), '', 'id строкой из базы — то же число');
});

test('услуги: скидка «на выбранные услуги» подходит, только если хоть одна из них в смете', () => {
    const scoped = { ...base, service_ids: [5, 7] };
    assert.equal(discountBlockReason(scoped, { today: T, serviceIds: [9] }), 'no_matching_service');
    assert.equal(discountBlockReason(scoped, { today: T, serviceIds: [7, 9] }), '');
    assert.deepEqual(serviceScope({ service_ids: ['5', 7, 'x', 0] }), [5, 7]);
    assert.equal(discountBlockReason({ ...base, active: 0 }, { today: T }), 'inactive');
});

test('eligibleDiscounts отбирает по всем правилам сразу и хранит порядок', () => {
    const rows = [
        { ...base, id: 1 },
        { ...base, id: 2, valid_until: '2026-01-01' },
        { ...base, id: 3, category_id: 9 },
        { ...base, id: 4, service_ids: [5] },
    ];
    assert.deepEqual(eligibleDiscounts(rows, { today: T, categoryId: 9, serviceIds: [5] }).map((r) => r.id), [1, 3, 4]);
    assert.deepEqual(eligibleDiscounts(rows, { today: T, categoryId: null, serviceIds: [8] }).map((r) => r.id), [1]);
});

test('сумма: процент — от строк, которых скидка касается; фиксированная — не больше их суммы', () => {
    const lines = [{ service_id: 5, total: 200000 }, { service_id: 7, total: 90000 }];
    assert.equal(discountValue({ ...base, percent: 10 }, lines), 29000, 'на весь счёт');
    assert.equal(discountValue({ ...base, percent: 10, service_ids: [5] }, lines), 20000, 'только по услуге 5');
    assert.equal(discountValue({ ...base, percent: 0, amount: 50000, service_ids: [7] }, lines), 50000);
    assert.equal(discountValue({ ...base, percent: 0, amount: 500000, service_ids: [7] }, lines), 90000, 'сумма не больше строк, которых касается');
    assert.equal(discountValue({ ...base, percent: 0, amount: 50000, service_ids: [9] }, lines), 0, 'своих услуг в смете нет — нечего скидывать');
    assert.equal(discountValue(null, lines), 0);
});

test('подпись варианта: имя, величина, отметка «на выбранные услуги» — без текста интерфейса в модуле', () => {
    assert.deepEqual(discountOptionParts({ ...base, percent: 10 }, (n) => String(n)), { name: 'chegirma', value: '−10%', scoped: false });
    assert.deepEqual(discountOptionParts({ ...base, percent: 0, amount: 50000, service_ids: [5] }, (n) => '50 000'), { name: 'chegirma', value: '−50 000', scoped: true });
    assert.match(localYmd(new Date(2026, 8, 14)), /^2026-09-14$/);
});

test('оба мастера идут через одно правило, а список скидок в мастере записи — выпадающий', () => {
    const vw = read('views/visit-wizard.js');
    assert.match(vw, /eligibleDiscounts\(wiz\.discounts/, 'мастер записи отбирает скидки общим правилом');
    assert.match(vw, /discountValue\(wiz\.promo, promoLines\(\)\)/, 'сумма промокода — по строкам');
    assert.ok(!/placeholder: 'Промокод \/ карта \/ сертификат'/.test(vw), 'поле для набора кода осталось — а должен быть список');
    assert.match(vw, /wiz\.discountPct = wiz\.categoryPct/, 'скидка группы подставляется в лояльность');
    const spm = read('views/service-picker-modal.js');
    assert.match(spm, /discountBlockReason\(row, \{ today: localYmd\(\)/, 'калькулятор проверяет срок/группу/услуги тем же правилом');
    assert.match(spm, /discountValue\(pr, lines\)/, 'калькулятор считает скидку по строкам');
});
