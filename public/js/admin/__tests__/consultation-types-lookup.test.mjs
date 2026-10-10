// DOCTOR_PROFILE_V1 (ревью шага 5, №6) — «Настройки → Виды консультаций»: стёртое
// узбекское или английское название вида стирается и в базе. Общее окно
// справочника пустые текстовые поля не шлёт (skip empties), и прежнее название
// оставалось — его видели окно записи на uz / en и («Что увидят партнёры»)
// партнёры. Стенд — настоящий сервер с базой в памяти за подменённым fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, El, TOASTS } from './cabinet-harness.mjs';

installFakeDom();
for (const [k, fn] of Object.entries({
    click() { this.dispatch('click'); },
    dispatchEvent(e) { this.dispatch(e.type, e); return true; },
    replaceChildren(...cs) { this.children = []; cs.forEach((c) => this.appendChild(c)); },
    contains() { return false; }, scrollTo() {}, select() {},
})) if (!(k in El.prototype)) El.prototype[k] = fn;
globalThis.window.CLINIC = { id: 1, name: 'Клиника' };
globalThis.window.easymed = { state: { user: { id: 1, full_name: 'Админ', role: 'admin' } } };
globalThis.window.dispatchEvent = () => true;
globalThis.window.confirm = () => true;
globalThis.history = { state: null, replaceState() {}, pushState() {} };

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { hashPassword } = await import('../../../../server/services/auth.js');
const { createApp } = await import('../../../../server/app.js');
const { licensedDataDir } = await import('../../../../server/services/control/licensed-fixture.js');
const { listen } = await import('../../../../control-plane/server/test-helpers/listen.js');

const DB = openDb(':memory:');
migrate(DB);
DB.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)').run(1, 'boss', hashPassword('password1'), 'Админ Клиники', 'admin');
DB.prepare("INSERT INTO consultation_types (id, name, name_ru, name_uz, name_en, price, sort_order, active) VALUES (5,'Первичный приём','Первичный приём','Birlamchi','Initial visit',80000,1,1)").run();

const realFetch = globalThis.fetch;
const server = await listen(createApp(DB, { dataDir: licensedDataDir() }));
const BASE = `http://127.0.0.1:${server.address().port}`;
const login = await realFetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'password1' }) });
const COOKIE = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
globalThis.fetch = (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('/')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return realFetch(BASE + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: COOKIE } });
};
test.after(() => { globalThis.fetch = realFetch; server.closeAllConnections?.(); server.close(); });

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await settle(20); } }
function syncValues(root) {   // browser: <input value="x">.value === 'x'; <select> reads its selected option
    for (const el of root.querySelectorAll('input')) if (el.value === '' && el.getAttribute('value') != null) el.value = el.getAttribute('value');
    for (const el of root.querySelectorAll('select')) { const o = el.children.find((c) => c.tagName === 'OPTION' && c.hasAttribute('selected')); if (o) el.value = o.getAttribute('value'); }
}
const ct = () => DB.prepare('SELECT name_uz, name_en, price FROM consultation_types WHERE id = 5').get();

// Окно вида консультации из «Настроек»: строка справочника → окно правки.
async function openEditor() {
    const perms = await import('../permissions.js');
    perms.setFullAccess('Admin');
    const { renderSettingsHub } = await import('../views/settings-hub.js');
    const hub = new El('div');
    await renderSettingsHub(hub, {});
    hub.querySelectorAll('.set-row-link').find((n) => n.textContent.includes('Консультации врачей')).dispatch('click');
    const row = await until(() => hub.querySelectorAll('tr').find((r) => r.textContent.includes('Первичный приём') && r.classList.contains('row-click')));
    assert.ok(row, 'нет строки «Первичный приём» в справочнике');
    document.body.children = [];
    row.dispatch('click');
    const modal = document.body.children.find((c) => c.classList && c.classList.contains('modal'));
    assert.ok(modal, 'окно правки не открылось');
    syncValues(modal);
    const inputs = modal.querySelectorAll('input');
    return {
        en: inputs.find((i) => i.value === 'Initial visit'),
        uz: inputs.find((i) => i.value === 'Birlamchi'),
        price: inputs.filter((i) => i.getAttribute('type') === 'number')[0],
        all: inputs,
        async save() {
            const btn = modal.querySelectorAll('button').find((b) => /^(Save|Сохранить)$/.test(b.textContent.trim()));
            btn.dispatch('click');
            await btn._pending;
            await settle();
        },
    };
}
const reset = () => DB.prepare("UPDATE consultation_types SET name_uz = 'Birlamchi', name_en = 'Initial visit', price = 80000 WHERE id = 5").run();

test('DOCTOR_PROFILE_V1: стёртые «Название (UZ)» и «Название (EN)» вида консультации стираются в базе', async () => {
    reset();
    const f = await openEditor();
    assert.ok(f.en && f.uz, 'названия не подставились в окно: ' + f.all.map((i) => i.value).join('|'));
    f.en.value = '';
    f.uz.value = '';
    f.price.value = '90000';   // вторая, видимая правка — доказательство, что сохранение дошло
    await f.save();
    assert.equal(ct().price, 90000, 'сохранение не дошло до сервера: ' + TOASTS.slice(-3).join(' | '));
    assert.equal(ct().name_en, null, 'английское название не стёрто — осталось «' + ct().name_en + '»');
    assert.equal(ct().name_uz, null, 'узбекское название не стёрто — осталось «' + ct().name_uz + '»');
});

test('DOCTOR_PROFILE_V1: правка без названий — узбекское и английское названия остаются', async () => {
    reset();
    const f = await openEditor();
    f.price.value = '95000';
    await f.save();
    assert.deepEqual({ ...ct() }, { name_uz: 'Birlamchi', name_en: 'Initial visit', price: 95000 });
});
