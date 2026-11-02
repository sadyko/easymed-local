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
