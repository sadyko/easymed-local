// QUEUE_FRESH_V1 (3.21.0, ревью m7) — «В ОДИН ЭКРАН» НЕ ДЕРЖИТ СНЯТЫЕ СТРАНИЦЫ.
//
// fitViewport (dash-kpi.js, DASH_ONE_SCREEN_V1) вешает на окно слушатель resize —
// по одному на элемент. Кабинет врача рисует «Мои приёмы» заново на каждом возврате,
// «Обновить» и смене фильтра (новый корень — новый слушатель), и снятые со страницы
// корни оставались в памяти навсегда: слушатель держал их своей замыкающей ссылкой.
// Теперь слушатель снимает себя сам, как только его элемент не на странице.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- окно с подсчётом слушателей (без DOM) -----------------------------------
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
};
globalThis.document = { documentElement: {}, addEventListener() {}, removeEventListener() {} };
const LISTENERS = { resize: new Set() };
globalThis.window = {
    innerHeight: 800,
    addEventListener(type, fn) { (LISTENERS[type] || (LISTENERS[type] = new Set())).add(fn); },
    removeEventListener(type, fn) { if (LISTENERS[type]) LISTENERS[type].delete(fn); },
    dispatchEvent() { return true; },
};
const resize = () => { for (const fn of [...LISTENERS.resize]) fn({ type: 'resize' }); };

const { fitViewport } = await import('../views/dash-kpi.js');

function page(top = 100) {
    return { isConnected: true, style: {}, getBoundingClientRect: () => ({ top }) };
}

test('слушатель resize снимает себя, когда его страница снята; живые страницы подгоняются, как прежде', () => {
    LISTENERS.resize.clear();
    const pages = Array.from({ length: 5 }, () => page());
    for (const p of pages) fitViewport(p, { min: 520 });
    fitViewport(pages[4], { min: 520 });   // та же страница второй раз — слушатель не второй
    assert.equal(LISTENERS.resize.size, 5, 'по слушателю на страницу');
    assert.equal(pages[4].style.height, '676px', 'высота = окно − верх − зазор');
    // Четыре прежние перерисовки сняты со страницы (clear(root) / вытеснение из кэша).
    for (const p of pages.slice(0, 4)) p.isConnected = false;
    window.innerHeight = 900;
    resize();
    assert.equal(LISTENERS.resize.size, 1, 'снятые страницы держатся слушателями окна');
    assert.equal(pages[4].style.height, '776px', 'живая страница не подогналась под новое окно');
    assert.equal(pages[0].style.height, '676px', 'снятая страница подгонялась');
    window.innerHeight = 800;
});

test('страница, снова поставленная на место, подгоняется заново при следующем fitViewport', () => {
    LISTENERS.resize.clear();
    const p = page(50);
    fitViewport(p, { min: 520 });
    p.isConnected = false;
    resize();
    assert.equal(LISTENERS.resize.size, 0);
    p.isConnected = true;
    fitViewport(p, { min: 520 });
    assert.equal(LISTENERS.resize.size, 1, 'страница, вернувшаяся на место, осталась без слушателя');
    window.innerHeight = 1000;
    resize();
    assert.equal(p.style.height, '926px');
    window.innerHeight = 800;
});

// QUEUE_FRESH_V1 (ревью-2) — слушатель снимал себя ТОЛЬКО при resize. Кабинет врача зовёт
// fitViewport на каждой перерисовке «Мои приёмы» (новый корень), и 50 перерисовок без
// единого resize оставляли 50 слушателей окна — 49 из них держали снятые экраны.
test('50 перерисовок без resize — у окна не больше двух слушателей, снятые экраны не держатся', () => {
    LISTENERS.resize.clear();
    const all = [];
    for (let i = 0; i < 50; i++) {
        if (all.length) all[all.length - 1].isConnected = false;   // clear(root): прежний корень снят до новой подгонки
        const p = page();
        all.push(p);
        fitViewport(p, { min: 520 });
    }
    assert.ok(LISTENERS.resize.size <= 2, 'слушателей окна после 50 перерисовок: ' + LISTENERS.resize.size);
    const live = all[all.length - 1];
    window.innerHeight = 900;
    resize();
    assert.equal(live.style.height, '776px', 'живой экран не подогнался под новое окно');
    // Снятый без resize экран, вернувшийся на место, снова получает слушателя.
    all[10].isConnected = true;
    const before = LISTENERS.resize.size;
    fitViewport(all[10], { min: 520 });
    assert.equal(LISTENERS.resize.size, before + 1, 'вернувшийся экран остался без слушателя');
    window.innerHeight = 800;
});
