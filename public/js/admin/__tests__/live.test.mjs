// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — клиент живых экранов (live.js):
// один поток на вкладку, тишина ~700 мс перед перечитыванием, переподключение с
// паузой, запасной опрос, скрытая вкладка, правило занятости экрана.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, FakeES, fakeDocument, flush } from './live-fakes.mjs';
import {
    createLiveClient, watchScreen, dialogOpen, editingInside, screenBusy, BUSY_SELECTOR,
    DEBOUNCE_MS, POLL_MS, HIDDEN_CLOSE_MS, RECHECK_MS, SILENCE_MS, onLive, __setLiveClientForTests,
} from '../live.js';
import { LIVE_RELEVANCE, liveRelevant } from '../live-relevance.js';

function setup({ es = true, fetchImpl = null } = {}) {
    FakeES.reset();
    const clock = fakeClock();
    const doc = fakeDocument();
    const win = { _l: {}, addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }, fire(t) { for (const fn of this._l[t] || []) fn({}); } };
    const fetches = [];
    // По умолчанию сервер отвечает «ничего нового» для того номера, что спросили.
    const fetch = fetchImpl || (async (url) => {
        fetches.push(url);
        const m = /since=(\d+)/.exec(String(url));
        return { ok: true, status: 200, json: async () => (m ? { v: Number(m[1]), tables: [], rpc: [] } : { v: 100 }) };
    });
    const client = createLiveClient({
        EventSource: es ? FakeES : undefined, fetch: (url, o) => { if (fetchImpl) fetches.push(url); return fetch(url, o); },
        document: doc, window: win,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random: () => 0.5,
    });
    return { clock, doc, win, client, fetches };
}
const change = (v, tables, rpc = []) => ({ v, tables, rpc });

test('один поток на вкладку, сколько бы экранов ни подписалось; последний ушёл — поток закрыт', async () => {
    const { client } = setup();
    const offA = client.onLive(() => true, () => {});
    const offB = client.onLive(() => true, () => {});
    assert.equal(FakeES.all.length, 1, 'один EventSource');
    assert.equal(FakeES.all[0].url, '/api/live', 'первое подключение — без номера: сервер пришлёт hello');
    offA();
    assert.equal(FakeES.live().length, 1, 'второй экран ещё слушает');
    offB();
    assert.equal(FakeES.live().length, 0, 'никто не слушает — поток закрыт');
    assert.equal(client.status().mode, 'off');
});

test('тишина ~700 мс: всплеск — один вызов с объединением; чужое изменение — ни одного', async () => {
    const { client, clock } = setup();
    const got = [];
    client.onLive(liveRelevant('cashier'), (c) => got.push(c));
    const es = FakeES.all[0];
    es.open();
    es.emit('hello', { v: 10 });
    es.emit('change', change(11, ['invoices'], ['create_invoice_for_visit']));
    await clock.advance(300);
    es.emit('change', change(12, ['payments'], ['record_payment']));
    await clock.advance(DEBOUNCE_MS - 10);
    assert.equal(got.length, 0, 'ещё не тихо');
    await clock.advance(20);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0], { tables: ['invoices', 'payments'], rpc: ['create_invoice_for_visit', 'record_payment'], reset: false });
    es.emit('change', change(13, ['crm_tasks'], ['crm_task_save']));
    await clock.advance(2000);
    assert.equal(got.length, 1, 'изменение не для кассы её не будит');
    es.emit('change', change(13, ['invoices']));   // повтор той же версии
    await clock.advance(2000);
    assert.equal(got.length, 1, 'повтор версии не исполняется');
});

test('непрерывный поток событий не откладывает перечитывание дольше ~3 с', async () => {
    const { client, clock } = setup();
    let n = 0;
    client.onLive(() => true, () => { n++; });
    const es = FakeES.all[0];
    es.open();
    es.emit('hello', { v: 1 });
    for (let i = 2; i <= 9; i++) { es.emit('change', change(i, ['visits'])); await clock.advance(400); }
    assert.ok(n >= 1, 'при событиях каждые 400 мс экран всё равно обновился');
});

test('обрыв: закрытый поток — опрос /api/live/version раз в 15 с, переподключение с паузой и номером версии', async () => {
    const { client, clock, fetches } = setup();
    const got = [];
    client.onLive(() => true, (c) => got.push(c));
    const es = FakeES.all[0];
    es.open();
    es.emit('hello', { v: 50 });
    es.fail(true);   // сервер закрыл поток
    assert.equal(es.closed, true);
    assert.equal(client.status().mode, 'poll');
    await clock.advance(900);   // пауза 1 с ± 20 % (random = 0,5 → ровно 1 с)
    assert.equal(FakeES.all.length, 1, 'не раньше паузы');
    await clock.advance(200);
    assert.equal(FakeES.all.length, 2, 'переподключился');
    assert.equal(FakeES.all[1].url, '/api/live?since=50', 'с номером последней версии — сервер пришлёт пропущенное');
    FakeES.all[1].fail(true);
    await clock.advance(1500);
    assert.equal(FakeES.all.length, 2, 'вторая пауза длиннее (2 с)');
    await clock.advance(600);
    assert.equal(FakeES.all.length, 3);
    // Пока потока нет, идёт запасной опрос.
    await clock.advance(POLL_MS);
    assert.ok(fetches.some((u) => u === '/api/live/version?since=50'), 'опрос с номером: ' + fetches.join(', '));
    // Поток поднялся — опрос стоп, пропущенное пришло событием.
    FakeES.all[2].open();
    const before = fetches.length;
    FakeES.all[2].emit('change', change(51, ['visits']));
    await clock.advance(POLL_MS * 2);
    assert.equal(fetches.length, before, 'поток жив — опроса нет');
    assert.equal(got.length, 1);
});

test('зависший поток (ПК спал, Wi-Fi без разрыва): тишина дольше 70 с — переподключение с номером; ping держит поток', async () => {
    const { client, clock } = setup();
    client.onLive(() => true, () => {});
    const es = FakeES.all[0];
    es.open();
    es.emit('hello', { v: 40 });
    for (let i = 0; i < 6; i++) { await clock.advance(25_000); es.emit('ping', { v: 40 }); }
    assert.equal(es.closed, false, 'пульс идёт — поток живёт (2,5 минуты)');
    await clock.advance(SILENCE_MS + 10);
    assert.equal(es.closed, true, 'тишина — поток закрыт');
    await clock.advance(1500);
    const es2 = FakeES.all[1];
    assert.ok(es2 && !es2.closed, 'подключился заново');
    assert.equal(es2.url, '/api/live?since=40', 'с номером: сервер пришлёт пропущенное');
});

test('три ошибки подряд без закрытия — берём переподключение на себя', async () => {
    const { client, clock } = setup();
    client.onLive(() => true, () => {});
    const es = FakeES.all[0];
    es.fail(false); es.fail(false);
    assert.equal(es.closed, false, 'две ошибки — браузер переподключается сам');
    es.fail(false);
    assert.equal(es.closed, true, 'третья — закрыли');
    await clock.advance(10_000);
    assert.ok(FakeES.all.length >= 2, 'и подключились снова');
});

test('EventSource нет — опрос: сразу за номером, потом раз в 15 с; изменения доходят', async () => {
    let answer = { v: 7 };
    const { client, clock, fetches } = setup({ es: false, fetchImpl: async () => ({ ok: true, status: 200, json: async () => answer }) });
    const got = [];
    client.onLive(liveRelevant('laboratory'), (c) => got.push(c));
    await clock.advance(0);
    assert.deepEqual(fetches, ['/api/live/version'], 'первый опрос — без номера');
    answer = { v: 9, tables: ['lab_results'], rpc: [] };
    await clock.advance(POLL_MS);
    assert.equal(fetches[1], '/api/live/version?since=7');
    await clock.advance(DEBOUNCE_MS + 10);
    assert.deepEqual(got, [{ tables: ['lab_results'], rpc: [], reset: false }]);
    answer = { v: 9, tables: [], rpc: [] };
    await clock.advance(POLL_MS + DEBOUNCE_MS);
    assert.equal(got.length, 1, 'ничего нового — ничего не зовётся');
});

test('новая версия без списка имён — экран перечитывается целиком (сброс), а не пропускает изменения', async () => {
    let answer = { v: 7 };
    const { client, clock } = setup({ es: false, fetchImpl: async () => ({ ok: true, status: 200, json: async () => answer }) });
    const got = [];
    client.onLive(liveRelevant('cashier'), (c) => got.push(c));
    await clock.advance(0);
    answer = { v: 12 };
    await clock.advance(POLL_MS + DEBOUNCE_MS + 10);
    assert.equal(got.length, 1);
    assert.equal(got[0].reset, true);
});

test('401 на опросе — поток и опрос остановлены до перезагрузки страницы', async () => {
    const { client, clock, fetches } = setup({ es: false, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    client.onLive(() => true, () => {});
    await clock.advance(POLL_MS * 3);
    assert.equal(fetches.length, 1);
    assert.equal(client.status().mode, 'gone');
});

test('сессия кончилась (событие easymed:session-gone) — поток закрыт, переподключений нет', async () => {
    const { client, clock, win } = setup();
    client.onLive(() => true, () => {});
    win.fire('easymed:session-gone');
    assert.equal(FakeES.live().length, 0);
    await clock.advance(120_000);
    assert.equal(FakeES.all.length, 1);
});

test('скрытая вкладка: изменения копятся и срабатывают один раз при показе; через 10 с скрытости поток закрыт', async () => {
    const { client, clock, doc } = setup();
    const got = [];
    client.onLive(() => true, (c) => got.push(c));
    const es = FakeES.all[0];
    es.open();
    es.emit('hello', { v: 1 });
    doc.setHidden(true);
    es.emit('change', change(2, ['visits']));
    es.emit('change', change(3, ['invoices']));
    await clock.advance(DEBOUNCE_MS * 3);
    assert.equal(got.length, 0, 'скрытая вкладка не перечитывает');
    doc.setHidden(false);
    await clock.advance(DEBOUNCE_MS + 10);
    assert.equal(got.length, 1, 'один раз при показе');
    assert.deepEqual(got[0].tables, ['invoices', 'visits']);
    // Долгая скрытость — поток закрывается; показ — поток с номером, пропущенное — событием.
    doc.setHidden(true);
    await clock.advance(HIDDEN_CLOSE_MS + 10);
    assert.equal(es.closed, true, 'фоновая вкладка не держит соединение');
    assert.equal(client.status().mode, 'paused');
    doc.setHidden(false);
    const es2 = FakeES.all[1];
    assert.ok(es2 && es2.url === '/api/live?since=3', 'переподключился с номером: ' + (es2 && es2.url));
    es2.open();
    es2.emit('change', { v: 6, tables: ['payments'], rpc: [] });   // сервер: «пока вас не было»
    await clock.advance(DEBOUNCE_MS + 10);
    assert.equal(got.length, 2);
    assert.deepEqual(got[1].tables, ['payments']);
});

test('сброс от сервера («могло измениться всё») будит каждый экран', async () => {
    const { client, clock } = setup();
    const got = [];
    client.onLive(liveRelevant('procedures'), (c) => got.push(c));
    const es = FakeES.all[0];
    es.open();
    es.emit('hello', { v: 500 });
    es.emit('change', { v: 20, reset: true, tables: [], rpc: [] });   // сервер перезапущен: номер меньше, но сброс
    await clock.advance(DEBOUNCE_MS + 10);
    assert.equal(got.length, 1);
    assert.equal(got[0].reset, true);
});

// ---- правило занятости и watchScreen ------------------------------------------
function screenRoot(doc) {
    const kids = new Set();
    return { isConnected: true, style: {}, contains: (n) => kids.has(n), _kids: kids, doc };
}

test('занятость: окно, мастер «Направить на услуги», выпадающий список; курсор в текстовом поле экрана', () => {
    for (const probe of ['.modal-backdrop', '.modal', '[data-visit-wizard]', '.uisel-pop', '.uidate-pop', '[aria-modal="true"]']) {
        assert.ok(BUSY_SELECTOR.includes(probe), probe);
    }
    const doc = { querySelector: (s) => (s === BUSY_SELECTOR ? { className: 'modal' } : null) };
    assert.equal(dialogOpen(doc), true);
    assert.equal(dialogOpen({ querySelector: () => null }), false);
    const root = screenRoot();
    const input = { tagName: 'INPUT', type: 'search' };
    const box = { tagName: 'INPUT', type: 'checkbox' };
    const outside = { tagName: 'TEXTAREA' };
    root._kids.add(input); root._kids.add(box);
    assert.equal(editingInside(root, { activeElement: input }), true, 'поиск экрана в фокусе — занят');
    assert.equal(editingInside(root, { activeElement: box }), false, 'флажок после щелчка — не занят');
    assert.equal(editingInside(root, { activeElement: outside }), false, 'поле вне экрана — не его дело');
    assert.equal(editingInside(root, { activeElement: { tagName: 'SELECT' } }), false);
    assert.equal(screenBusy(root, { activeElement: input, querySelector: () => null }), true);
});

test('watchScreen: своё изменение перечитывает; занятый экран ждёт, пока освободится; вынутый — отписан', async () => {
    const { client, clock, doc } = setup();
    const root = screenRoot();
    let reloads = 0;
    const stop = watchScreen({ root, screen: 'cashier', reload: () => { reloads++; }, client });
    const es = FakeES.all[0];
    es.open();
    es.emit('hello', { v: 1 });
    es.emit('change', change(2, ['invoices']));
    await clock.advance(DEBOUNCE_MS + 10);
    assert.equal(reloads, 1, 'счёт выставлен — касса перечиталась');
    es.emit('change', change(3, ['lab_results']));
    await clock.advance(DEBOUNCE_MS + 10);
    assert.equal(reloads, 1, 'результат анализа кассу не трогает');
    // Окно оплаты открыто — ждём.
    doc.modal = true;
    es.emit('change', change(4, ['payments']));
    await clock.advance(DEBOUNCE_MS + RECHECK_MS * 3);
    assert.equal(reloads, 1, 'под открытым окном не перечитывается');
    doc.modal = false;
    await clock.advance(RECHECK_MS + 10);
    assert.equal(reloads, 2, 'окно закрыли — перечиталось в ближайшую проверку');
    // Скрытая оболочкой панель — тоже ждёт.
    root.style.display = 'none';
    es.emit('change', change(5, ['visits']));
    await clock.advance(DEBOUNCE_MS + RECHECK_MS * 2);
    assert.equal(reloads, 2);
    root.style.display = '';
    await clock.advance(RECHECK_MS + 10);
    assert.equal(reloads, 3);
    // Экран вынули из документа — подписка снята, поток закрыт.
    root.isConnected = false;
    es.emit('change', change(6, ['visits']));
    await clock.advance(DEBOUNCE_MS + 10);
    assert.equal(reloads, 3);
    assert.equal(client.status().subscribers, 0, 'подписка снята сама');
    assert.equal(FakeES.live().length, 0);
    stop();   // повторный stop безвреден
});

test('watchScreen: экран вынут без событий — подписка снимается проверкой раз в 30 с', async () => {
    const { client, clock } = setup();
    const root = screenRoot();
    watchScreen({ root, screen: 'laboratory', reload: () => {}, client });
    assert.equal(client.status().subscribers, 1);
    root.isConnected = false;
    await clock.advance(31_000);
    assert.equal(client.status().subscribers, 0);
});

test('watchScreen: перечитывание не накладывается — пришедшее во время чтения выполняется после', async () => {
    const { client, clock } = setup();
    const root = screenRoot();
    let release;
    let started = 0;
    watchScreen({ root, screen: 'cabinet', reload: () => { started++; return new Promise((r) => { release = r; }); }, client });
    const es = FakeES.all[0];
    es.open(); es.emit('hello', { v: 1 });
    es.emit('change', change(2, ['visit_services']));
    await clock.advance(DEBOUNCE_MS + 10);
    assert.equal(started, 1);
    es.emit('change', change(3, ['visits']));
    await clock.advance(DEBOUNCE_MS + 10);
    assert.equal(started, 1, 'второе чтение не стартует поверх первого');
    release(); await flush();
    assert.equal(started, 2, 'отложенное выполнено после первого');
});

test('не настоящая страница (экраны в тестах под Node) — общего клиента нет: ни потока, ни опроса, ни таймеров', () => {
    FakeES.reset();
    __setLiveClientForTests(undefined);
    let reloads = 0;
    const stop = watchScreen({ root: screenRoot(), screen: 'cashier', reload: () => { reloads++; } });
    const off = onLive(() => true, () => {});
    assert.equal(typeof stop, 'function');
    assert.equal(typeof off, 'function');
    assert.equal(FakeES.all.length, 0);
    stop(); off();
    assert.equal(reloads, 0);
});

test('правила экранов: касса — счета и оплаты; лаборатория — результаты; процедуры — палатные строки', () => {
    const is = (screen, tables) => liveRelevant(screen)({ tables, rpc: [] });
    assert.equal(is('cashier', ['invoices']), true);
    assert.equal(is('cashier', ['visit_services']), true, '«Ждут счёта» — направленный пациент');
    assert.equal(is('cashier', ['lab_results']), false);
    assert.equal(is('cabinet', ['visit_services']), true, 'пациента направили к врачу');
    assert.equal(is('cabinet', ['payments']), true, 'касса отпустила к осмотру');
    assert.equal(is('cabinet', ['cash_movements']), false);
    assert.equal(is('laboratory', ['lab_results']), true);
    assert.equal(is('laboratory', ['cash_shifts']), false);
    assert.equal(is('procedures', ['admission_services']), true);
    assert.equal(is('procedures', ['invoices']), false);
    assert.equal(liveRelevant('cashier')({ reset: true, tables: [], rpc: [] }), true);
    assert.equal(liveRelevant('нет-такого')({ tables: ['invoices'] }), false);
    assert.deepEqual(Object.keys(LIVE_RELEVANCE).sort(), ['cabinet', 'cashier', 'laboratory', 'procedures']);
});
