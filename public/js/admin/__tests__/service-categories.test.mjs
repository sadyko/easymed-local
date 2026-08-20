// SERVICE_CATALOG_FILTER_V1 — отбор каталога услуг.
import { test } from 'node:test';
import assert from 'node:assert';
import { categoryOf, CAT_ORDER, doctorPerformsService, filterCatalog, categoryCounts } from '../../shared/service-categories.js';

const S = [
    { id: 1, name: 'Консультация гинеколога', price: 100000 },
    { id: 2, name: 'УЗИ брюшной полости', price: 90000 },
    { id: 3, name: 'Общий анализ крови', price: 40000, is_lab: 1 },
    { id: 4, name: 'Перевязка (ЛОР)', price: 30000 },
    { id: 5, name: 'Операция аппендэктомия', price: 900000 },
    { id: 6, name: 'Прокат костылей', price: 5000 },
];

test('услуги раскладываются по разделам', () => {
    assert.strictEqual(categoryOf(S[0]), 'Консультации');
    assert.strictEqual(categoryOf(S[1]), 'Диагностика');
    assert.strictEqual(categoryOf(S[2]), 'Лаборатория');
    assert.strictEqual(categoryOf(S[3]), 'Процедуры');
    assert.strictEqual(categoryOf(S[4]), 'Хирургия');
    assert.strictEqual(categoryOf(S[5]), 'Прочее');
});

// is_lab важнее названия: «Консультация» с флагом лаборатории — это лаборатория.
test('признак лаборатории сильнее названия', () => {
    assert.strictEqual(categoryOf({ name: 'Консультация', is_lab: 1 }), 'Лаборатория');
});

test('пустая или сломанная услуга не роняет раскладку', () => {
    for (const bad of [null, undefined, {}, { name: null }]) assert.strictEqual(categoryOf(bad), 'Прочее');
});

test('поиск и раздел сужают вместе', () => {
    assert.deepStrictEqual(filterCatalog(S, { query: 'уз' }).map(x => x.id), [2]);
    assert.deepStrictEqual(filterCatalog(S, { category: 'Процедуры' }).map(x => x.id), [4]);
    assert.deepStrictEqual(filterCatalog(S, { query: 'консульт', category: 'Диагностика' }), []);
});

// Врач берётся из своего же списка ставок — отдельного справочника нет.
test('врач сужает каталог до своих услуг', () => {
    const doc = { id: 9, service_rates: [{ service_id: 1, pct: 40 }, { service_id: 4 }] };
    assert.deepStrictEqual(filterCatalog(S, { doctor: doc }).map(x => x.id), [1, 4]);
    assert.strictEqual(doctorPerformsService(doc, 1), true);
    assert.strictEqual(doctorPerformsService(doc, 2), false);
});

// id из <option> приходит строкой, в каталоге — числом.
test('id сравниваются через строку', () => {
    assert.strictEqual(doctorPerformsService({ service_rates: [{ service_id: '1' }] }, 1), true);
});

// Врач без ставок — пустой список, а не весь каталог: иначе услугу запишут на
// того, кто её не делает.
test('врач без ставок не открывает весь каталог', () => {
    for (const rates of [[], null, undefined, 'nope']) {
        assert.deepStrictEqual(filterCatalog(S, { doctor: { id: 9, service_rates: rates } }), [], JSON.stringify(rates));
    }
});

test('счётчики чипов считаются по текущему поиску и врачу', () => {
    const c = categoryCounts(S);
    assert.strictEqual(c[''], 6);
    assert.strictEqual(c['Лаборатория'], 1);
    assert.strictEqual(c['Прочее'], 1);
    const withQ = categoryCounts(S, { query: 'консульт' });
    assert.strictEqual(withQ[''], 1);
    assert.strictEqual(withQ['Консультации'], 1);
    assert.strictEqual(withQ['Диагностика'], 0);
});

test('все разделы присутствуют в счётчиках, даже пустые', () => {
    const c = categoryCounts([]);
    for (const cat of CAT_ORDER) assert.strictEqual(c[cat], 0, cat);
});
