// INPATIENT_ONE_SECTION_V1 (2026-09-05) — «Стационар» одним разделом, и койка
// выбирается как на доске.
//
// Владелец: «the stationary requests: #admissions / #beds — i guess it should
// be in one section and, and admission request are filled with dialogue window
// of the stationary. selecting beds or rooms like in the ui of the beds».
//
// Что здесь проверяется — по предложению на решение:
//
//   * ОДИН ПУНКТ МЕНЮ вместо двух, и оба старых адреса живы: '#admissions'
//     открывает раздел, '#beds' — тот же раздел на вкладке «Койки». Проверяется
//     по САМИМ таблицам оболочки, а не по пересказу: пропадёт ветка маршрута —
//     упадёт этот тест, а не закладка у медсестры через месяц.
//   * ТРИ ВКЛАДКИ монтируются и показывают СВОЁ: очереди смены, коечный фонд,
//     журнал госпитализаций.
//   * ПОДМАРШРУТ живёт в адресе: '#admissions/beds' открывает свою вкладку, а
//     переключение пишется через replaceState (вкладка — не новое место для
//     кнопки «Назад») и сообщается оболочке через easymedSetTabSub, иначе
//     следующий navigate() в раздел перепишет хеш из payload панели.
//   * ОКНО ВЫБОРА КОЙКИ — ЭТО ДОСКА: палаты карточками с занятостью, койки
//     плитками; занятая, убираемая и ремонтируемая ВИДНЫ, не нажимаются и
//     называют причину; койка чужой палаты не предлагается вовсе. И рисует его
//     ТА ЖЕ функция, что доску, — не копия.
//   * РАЗМЕЩЕНИЕ ВИДНО НА ДОСКЕ: положили на вкладке «Заявки» — перешли на
//     «Койки» и видим там занятую койку с этим пациентом. Ради этого вкладка и
//     перечитывается при каждом показе.
//   * ПРАВА НЕ ТРОНУТЫ: медсестра видит раздел, кассир — нет.
//   * РАЗДЕЛ НЕ НАЗЫВАЕТ СЕБЯ ДВАЖДЫ: хост не пишет собственного заголовка, а
//     заголовки вкладок написаны так, что оболочка их снимает (h1.page-title).

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// Поддельный DOM. textContent — ВЕСЬ текст поддерева, как в настоящем: оболочка
// окна (inpatientModal) запоминает подпись кнопки через textContent и вернёт её
// после отказа сервера; с наивным геттером кнопка «Положить» осталась бы
// безымянной, и тест сообщил бы о несуществующей ошибке.
// ---------------------------------------------------------------------------
class F {
    constructor(t) {
        this.tagName = String(t).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {}; this.value = '';
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children[0] || null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    focus() {} blur() {} scrollTo() {} scrollIntoView() {} remove() {} select() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mk(t) {
    const el = new F(t);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new F('svg'); s._text = String(v); el.content.firstChild = s; }, get() { return ''; },
        });
    }
    return el;
}
globalThis.Node = F;
const BODY = mk('body');
globalThis.document = {
    createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
    head: mk('head'), body: BODY, documentElement: mk('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
};

const store = new Map([['admin.lang', 'ru']]);   // I18N_LOCALE_PIN_V1 — язык до импорта экранов
const fakeStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeStorage;

// HASH_SUBROUTE_V1 — мост в оболочку записывается, а не заглушается: глубокая
// ссылка И ЕСТЬ проверяемое свойство.
let tabSubCalls = [];
globalThis.window = {
    location: { hostname: 'localhost', hash: '' }, localStorage: fakeStorage,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    scrollTo() {}, scrollY: 0, confirm: () => true,
    easymed: { state: { user: { id: 2, full_name: 'Медсестра поста', role: 'nurse', company_id: 'c-1' } } },
    easymedSetTabSub: (tabId, sub) => { tabSubCalls.push([tabId, sub]); },
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.cancelAnimationFrame = () => {};

let historyUrl = null;
let pushes = 0, replaces = 0;
globalThis.history = {
    state: null,
    replaceState(st, _text, url) { this.state = st; historyUrl = url; replaces++; },
    pushState(st, _text, url) { this.state = st; historyUrl = url; pushes++; },
};

// ---------------------------------------------------------------------------
// Маленький «сервер» в памяти. Палаты, койки, госпитализации — ровно столько,
// сколько нужно, чтобы доска и окно выбора отвечали на свои вопросы.
// ---------------------------------------------------------------------------
const WORLD = {
    patients: [
        { id: 101, mrn: 'M-101', full_name: 'Иванов Иван Иванович' },
        { id: 102, mrn: 'M-102', full_name: 'Петрова Мария' },
        { id: 103, mrn: 'M-103', full_name: 'Сидоров Сидор' },
    ],
    wards: [
        { id: 1, name: 'Терапия', type: 'general', billing_mode: 'daily', price_per_day: 200000, price_per_hour: 0, color: '', active: 1 },
        { id: 2, name: 'Хирургия', type: 'surgery', billing_mode: 'daily', price_per_day: 350000, price_per_hour: 0, color: '', active: 1 },
    ],
    beds: [
        { id: 5, code: 'T-1', status: 'occupied', ward_id: 1, type: 'standard', active: 1, price_per_day: 0, price_per_hour: 0 },
        { id: 6, code: 'T-2', status: 'free',     ward_id: 1, type: 'standard', active: 1, price_per_day: 0, price_per_hour: 0 },
        { id: 7, code: 'T-3', status: 'cleaning', ward_id: 1, type: 'standard', active: 1, price_per_day: 0, price_per_hour: 0 },
        { id: 8, code: 'S-1', status: 'free',     ward_id: 2, type: 'standard', active: 1, price_per_day: 0, price_per_hour: 0 },
    ],
    admissions: [
        { id: 11, admission_no: 'ADM-00011', status: 'ordered', patient_id: 101, ward_id: 1, bed_id: null,
          department: 'Терапевтическое', admission_type: 'planned', stay_mode: 'round', planned_at: null,
          ordered_at: '2026-09-04T08:00:00Z', admitted_at: null, examined_at: null, examined_by: null,
          attending_doctor_id: null, discharged_at: null, charge_amount: null },
        { id: 13, admission_no: 'ADM-00013', status: 'admitted', patient_id: 103, ward_id: 1, bed_id: 5,
          department: '', admission_type: 'planned', stay_mode: 'round', planned_at: null,
          ordered_at: '2026-09-03T07:00:00Z', admitted_at: '2026-09-03T08:00:00Z', examined_at: null, examined_by: null,
          attending_doctor_id: null, discharged_at: null, charge_amount: null },
        // Заявка БЕЗ палаты — регистратура оставила выбор медсестре. Это второй
        // случай владельца («selecting beds or rooms»): сначала палата, потом
        // койка в ней. Стоит последней, чтобы не сдвигать первую заявку.
        { id: 12, admission_no: 'ADM-00012', status: 'ordered', patient_id: 102, ward_id: null, bed_id: null,
          department: '', admission_type: 'emergency', stay_mode: 'round', planned_at: null,
          ordered_at: '2026-09-04T09:00:00Z', admitted_at: null, examined_at: null, examined_by: null,
          attending_doctor_id: null, discharged_at: null, charge_amount: null },
    ],
};
const ORIGINAL = JSON.parse(JSON.stringify(WORLD));
function resetWorld() {
    WORLD.patients = JSON.parse(JSON.stringify(ORIGINAL.patients));
    WORLD.wards = JSON.parse(JSON.stringify(ORIGINAL.wards));
    WORLD.beds = JSON.parse(JSON.stringify(ORIGINAL.beds));
    WORLD.admissions = JSON.parse(JSON.stringify(ORIGINAL.admissions));
}

function embed(a) {
    const p = WORLD.patients.find((x) => x.id === a.patient_id) || {};
    const w = WORLD.wards.find((x) => x.id === a.ward_id) || null;
    const b = WORLD.beds.find((x) => x.id === a.bed_id) || null;
    return {
        ...a,
        patients: { mrn: p.mrn, full_name: p.full_name },
        wards: w ? { name: w.name } : null,
        beds: b ? { code: b.code } : null,
        users: null, attending: null, examined: null,
    };
}

function dbRead(desc) {
    const t = desc.table;
    let rows;
    if (t === 'admissions') rows = WORLD.admissions.map(embed);
    else if (t === 'beds') rows = WORLD.beds.map((b) => ({ ...b, wards: { name: (WORLD.wards.find((w) => w.id === b.ward_id) || {}).name } }));
    else if (t === 'wards') rows = WORLD.wards.slice();
    else if (t === 'patients') rows = WORLD.patients.slice();
    else rows = [];   // rooms / users — в этом мире их нет, и доска это переживает
    for (const f of desc.filters || []) {
        if (f.op === 'eq') rows = rows.filter((r) => String(r[f.col]) === String(f.val));
        else if (f.op === 'in') rows = rows.filter((r) => (f.val || []).map(String).includes(String(r[f.col])));
    }
    return desc.single ? (rows[0] || null) : rows;
}

let rpcCalls = [];
let admitRefusal = null;   // строка — сервер отказывает этими словами
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });

    if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        if (name === 'inpatient_capabilities') {
            return ok({ roles: ['nurse'], can: { admit: true, cancel_order: true, examine: false, set_attending: false } });
        }
        if (name === 'admission_admit') {
            if (admitRefusal) return fail(admitRefusal);
            const a = WORLD.admissions.find((x) => x.id === body.admission_id);
            const bed = WORLD.beds.find((x) => x.id === body.bed_id);
            a.status = 'admitted'; a.bed_id = bed.id; a.ward_id = bed.ward_id;
            a.admitted_at = '2026-09-05T09:00:00Z';
            bed.status = 'occupied';
            return ok({ admission: a, bed });
        }
        return ok({});
    }
    if (u.startsWith('/api/db')) return ok(dbRead(body));
    return ok([]);
};

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
const { renderInpatient, renderAdmissions } = await import('../views/admissions.js');
const wardBeds = await import('../views/ward-beds.js?v=board4');
const perms = await import('../permissions.js');

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const hasClass = (n, c) => String((n && n.className) || '').split(/\s+/).includes(c);
const tabButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON' && n.attrs.role === 'tab');
// Подпись вкладки — БЕЗ значка: Icon() приезжает разобранной <svg>, и её
// разметка попала бы в текст кнопки.
const tabLabel = (b) => walk(b).filter((n) => n.tagName !== 'SVG').map((n) => n._text || '').join('').trim();
const panelFor = (root, id) => walk(root).find((n) => n.attrs['data-tab-panel'] === id);
const visiblePanels = (root) => walk(root).filter((n) => n.attrs['data-tab-panel'] && n.style.display !== 'none');
const btns = (root, label) => walk(root).filter((n) => n.tagName === 'BUTTON' && textOf(n).includes(label));
const topOverlay = () => BODY.children.filter((c) => c.className === 'modal').pop() || null;
const lastToast = () => {
    const t = BODY.children.filter((c) => c.attrs && c.attrs.id === 'toast').pop();
    return t ? t.textContent : '';
};

async function mountSection(payload = null) {
    BODY.children.length = 0;
    tabSubCalls = []; rpcCalls = []; historyUrl = null; pushes = 0; replaces = 0;
    perms.setFullAccess('Admin');
    const container = mk('div');
    BODY.appendChild(container);
    const api = await renderInpatient(container, { onNavigate: () => {}, payload, tabId: 'admissions' });
    await settle(60);
    return { container, api };
}

// ===========================================================================
// 1. ОДИН РАЗДЕЛ, ОБА СТАРЫХ АДРЕСА ЖИВЫ
// ===========================================================================
const SHELL = read('public/js/admin.js');

test('в меню один «Стационар», а не два пункта на одном ключе прав', () => {
    const nav = SHELL.slice(SHELL.indexOf('const NAV = ['), SHELL.indexOf('// Live nav badges'));
    assert.ok(/\{\s*id:\s*'admissions',\s*label:\s*'Inpatient ward'/.test(nav),
        'из меню пропал сам раздел «Стационар»');
    assert.ok(!/\{\s*id:\s*'beds',\s*label:/.test(nav),
        'в меню остался второй вход в тот же раздел — а ключ прав у них ОДИН (`beds`), '
        + 'то есть разделить их между людьми всё равно нельзя');
});

test('старые адреса резолвятся: #admissions — раздел, #beds — его вкладка «Койки»', () => {
    assert.ok(/case 'admissions':\s*return void await renderInpatient\(/.test(SHELL),
        'маршрут #admissions больше не открывает раздел');
    assert.ok(/renderInpatient\s*\}\s*from '\.\/admin\/views\/admissions\.js/.test(SHELL),
        'хост раздела не импортирован оболочкой');
    // '#beds' отвечает тот же раздел, открытый на вкладке коек.
    const legacy = SHELL.slice(SHELL.indexOf('const LEGACY_ROUTES = {'), SHELL.indexOf('function navigate('));
    assert.ok(/beds:\s*\{\s*view:\s*'admissions',\s*sub:\s*'beds'\s*\}/.test(legacy),
        'закладка на #beds перестала открывать коечный фонд');
    // И пол под маршрутом: ветка на месте, чтобы адрес не проваливался в
    // «выберите раздел в меню», если карту устаревших маршрутов когда-нибудь
    // почистят.
    assert.ok(/case 'beds':\s*return void await renderWardBeds\(/.test(SHELL),
        'у маршрута #beds не осталось ни карты, ни ветки — он стал неизвестным экраном');
    // Крошки обоих маршрутов целы: CRUMBS — ещё и список известных адресов
    // при загрузке (isKnownView).
    assert.ok(/\badmissions:\s*\['Clinical', 'Inpatient ward'\]/.test(SHELL), 'нет крошки у раздела');
    assert.ok(/\bbeds:\s*\['Clinical', 'Ward & beds'\]/.test(SHELL), 'нет крошки у #beds — адрес перестанет быть известным');
});

test('окно выбора койки рисует ДОСКУ, а не свой список — и той же функцией', () => {
    const modal = read('public/js/admin/views/admission-modal.js');
    assert.ok(/import \{ loadBedFund, bedBoardEl, wardPillsEl \} from '\.\/ward-beds\.js\?v=board4'/.test(modal),
        'окно снова рисует койки само — копия разойдётся с доской при первой же правке доски');
    // Один экземпляр модуля на всё приложение: у ward-beds.js свой `state`.
    for (const [file, src] of [['admin.js', SHELL], ['views/admissions.js', read('public/js/admin/views/admissions.js')], ['views/admission-modal.js', modal]]) {
        const tags = [...src.matchAll(/ward-beds\.js\?v=([\w-]+)/g)].map((m) => m[1]);
        for (const tagValue of tags) {
            assert.equal(tagValue, 'board4', file + ' импортирует ward-beds.js другим ?v= — это ВТОРОЙ экземпляр модуля со своим состоянием');
        }
    }
    // И сама доска экспортирует то, чем её зовут.
    for (const name of ['loadBedFund', 'wardPillsEl', 'bedBoardEl', 'admissionsHistoryCard']) {
        assert.equal(typeof wardBeds[name], 'function', 'ward-beds.js больше не отдаёт ' + name);
    }
});

// ===========================================================================
// 2. ТРИ ВКЛАДКИ
// ===========================================================================

test('раздел монтируется тремя вкладками, и открыт на «Заявках»', async () => {
    resetWorld();
    const { container, api } = await mountSection();
    assert.deepEqual(tabButtons(container).map(tabLabel),
        ['Заявки', 'Койки', 'Госпитализации'], 'состав вкладок раздела изменился');
    assert.equal(api.activeTab(), 'orders');
    assert.deepEqual(visiblePanels(container).map((p) => p.attrs['data-tab-panel']), ['orders'],
        'видно не ровно одну вкладку');

    // «Заявки» — это очереди смены со всеми четырьмя списками и заявкой.
    const orders = textOf(panelFor(container, 'orders'));
    for (const list of ['Ждут размещения', 'В отделении', 'Ждут первичного осмотра', 'Ждут лечащего врача']) {
        assert.ok(orders.includes(list), 'из очередей пропал список «' + list + '»');
    }
    assert.ok(orders.includes('Иванов Иван Иванович'), 'заявка не видна на своей вкладке');
    assert.ok(btns(panelFor(container, 'orders'), 'Заявка на госпитализацию').length,
        'оформить заявку из раздела больше нельзя');
});

test('каждая вкладка показывает СВОЁ: очереди, коечный фонд, журнал', async () => {
    resetWorld();
    const { container, api } = await mountSection();

    await api.select('beds');
    await settle(60);
    const beds = textOf(panelFor(container, 'beds'));
    assert.ok(beds.includes('Терапия') && beds.includes('Хирургия'), 'на доске нет палат');
    assert.ok(beds.includes('T-2') && beds.includes('S-1'), 'на доске нет коек');
    assert.ok(beds.includes('Все койки'), 'с доски пропала полоса состояний коечного фонда');
    // Сегментного переключателя «Койки / Госпитализации» во вкладке быть не
    // должно: его работу делает полоса вкладок над ней.
    assert.equal(btns(panelFor(container, 'beds'), 'Госпитализации').length, 0,
        'внутри вкладки остался второй переключатель на те же лица раздела');

    await api.select('history');
    await settle(60);
    const history = textOf(panelFor(container, 'history'));
    assert.ok(history.includes('ADM-00011') && history.includes('ADM-00013'),
        'журнал не показывает госпитализации');

    assert.deepEqual(visiblePanels(container).map((p) => p.attrs['data-tab-panel']), ['history'],
        'после переключения видна не одна вкладка');
});

test('раздел не называет себя дважды: заголовки пишут вкладки, и написаны они так, что оболочка их снимет', async () => {
    resetWorld();
    const { container, api } = await mountSection();
    await api.select('beds');
    await settle(60);

    // Каждый <h1> внутри раздела — h1.page-title, то есть ровно то, что
    // dedupeSectionHeading() в admin.js умеет снять. Заголовок с любым другим
    // классом оболочка не найдёт, и раздел назовёт себя во второй раз.
    const h1s = walk(container).filter((n) => n.tagName === 'H1');
    assert.ok(h1s.length, 'ни одна вкладка не называет себя — снимать оболочке будет нечего, а имя останется только в меню');
    for (const el of h1s) assert.ok(hasClass(el, 'page-title'), 'заголовок вкладки написан мимо page-title: оболочка его не снимет');

    // Сам хост своего заголовка не пишет — иначе снятие одного оставило бы второй.
    const strip = walk(container).find((n) => n.attrs.role === 'tablist');
    assert.ok(strip, 'у раздела нет полосы вкладок');
    assert.equal(walk(strip).filter((n) => n.tagName === 'H1').length, 0, 'полоса вкладок обзавелась собственным заголовком');
});

// ===========================================================================
// 3. ВКЛАДКА ЖИВЁТ В АДРЕСЕ
// ===========================================================================

test('глубокая ссылка открывает свою вкладку: #admissions/beds и #admissions/history', async () => {
    resetWorld();
    let s = await mountSection({ sub: 'beds' });
    assert.equal(s.api.activeTab(), 'beds', 'ссылка на коечный фонд открыла не ту вкладку');
    assert.ok(textOf(panelFor(s.container, 'beds')).includes('T-2'), 'вкладка открыта, но пустая');

    s = await mountSection({ sub: 'history' });
    assert.equal(s.api.activeTab(), 'history');

    // Незнакомый подмаршрут — не повод показать пустоту: раздел открывается на
    // вкладке по умолчанию.
    s = await mountSection({ sub: 'ерунда' });
    assert.equal(s.api.activeTab(), 'orders');
});

test('переключение вкладки переписывает адрес (replaceState) и сообщается оболочке', async () => {
    resetWorld();
    const { api } = await mountSection();
    assert.equal(replaces, 0, 'начальная отрисовка не должна трогать историю');

    await api.select('beds');
    await settle(60);
    assert.equal(historyUrl, '#admissions/beds', 'вкладка не попала в адрес — по F5 она потеряется');
    assert.equal(pushes, 0, 'вкладка записана как НОВОЕ место в истории: выйти из раздела «Назад» станет втрое дольше');
    assert.deepEqual(tabSubCalls.at(-1), ['admissions', 'beds'],
        'оболочке не сказали про вкладку — следующий navigate() в раздел перепишет хеш из payload панели');

    await api.select('orders');
    await settle(60);
    assert.equal(historyUrl, '#admissions', 'возврат на вкладку по умолчанию не очистил адрес');
    assert.deepEqual(tabSubCalls.at(-1), ['admissions', null]);
});

// ===========================================================================
// 4. ВЫБОР КОЙКИ — ЭТО ДОСКА
// ===========================================================================

test('окно «Положить на койку» — палаты карточками, койки плитками, с настоящим состоянием', async () => {
    resetWorld();
    const { container } = await mountSection();
    btns(panelFor(container, 'orders'), 'Положить на койку')[0].click();
    await settle(60);

    const picker = topOverlay();
    assert.ok(picker, 'окно выбора койки не открылось');
    const txt = textOf(picker);

    // Пациент — якорь: подтверждают действие именно здесь.
    assert.ok(txt.includes('Иванов Иван Иванович'), 'в окне выбора койки не видно, КОГО кладут');
    // Палата — карточкой доски, с занятостью и ценой, а не строкой списка.
    assert.ok(txt.includes('Терапия'), 'палата не названа');
    assert.ok(txt.includes('занято 1 из 3'), 'в окне не видно занятости палаты — а именно за этим на доску и смотрят');
    // Заявка оформлена в «Терапию» — чужая палата не предлагается: сервер
    // откажет в койке из другой палаты.
    assert.ok(!txt.includes('S-1'), 'предложена койка чужой палаты — сервер такую не примет');

    // Все три койки палаты ВИДНЫ, каждая названа своим состоянием.
    const t1 = btns(picker, 'T-1')[0];
    const t2 = btns(picker, 'T-2')[0];
    const t3 = btns(picker, 'T-3')[0];
    assert.ok(t1 && t2 && t3, 'койки палаты показаны не все — экран выглядит сломанным');

    assert.ok(t1.hasAttribute('disabled'), 'занятую койку дали нажать');
    assert.ok(textOf(t1).includes('Занята'), 'занятая койка не называет причину');
    assert.ok(textOf(t1).includes('Сидоров Сидор'), 'на занятой койке не видно, КЕМ она занята');
    assert.equal(t1.getAttribute('title'), 'Занята', 'причина не подсказывается при наведении');

    assert.ok(t3.hasAttribute('disabled'), 'койку на уборке дали нажать');
    assert.ok(textOf(t3).includes('Уборка'), 'койка на уборке не называет причину');

    assert.ok(!t2.hasAttribute('disabled'), 'свободную койку не дали нажать');
    assert.ok(textOf(t2).includes('Свободна'));

    // Нажатие на занятую койку не выбирает её — и «Положить» честно скажет, что
    // койка не выбрана, вместо того чтобы отправить чужую.
    t1.click();
    await settle();
    btns(picker, 'Положить').filter((b) => textOf(b).trim() === 'Положить')[0].click();
    await settle(60);
    assert.match(lastToast(), /Выберите койку/);
    assert.equal(rpcCalls.filter((c) => c.name === 'admission_admit').length, 0,
        'занятая койка всё-таки ушла на сервер');
});

test('выбранная койка отмечается, и «Положить» уходит с этой заявкой и этой койкой', async () => {
    resetWorld();
    const { container } = await mountSection();
    btns(panelFor(container, 'orders'), 'Положить на койку')[0].click();
    await settle(60);
    const picker = topOverlay();

    btns(picker, 'T-2')[0].click();
    await settle();
    // Доска перерисована — выбранная плитка отмечена, и отмечена ОДНА.
    const marked = walk(topOverlay()).filter((n) => n.attrs['aria-pressed'] === 'true');
    assert.equal(marked.length, 1, 'выбор койки не виден (или отмечено несколько)');
    assert.ok(textOf(marked[0]).includes('T-2'));

    btns(topOverlay(), 'Положить').filter((b) => textOf(b).trim() === 'Положить')[0].click();
    await settle(80);

    const call = rpcCalls.find((c) => c.name === 'admission_admit');
    assert.ok(call, 'размещение не ушло на сервер');
    assert.deepEqual(call.args, { admission_id: 11, bed_id: 6 });
});

test('заявка без палаты: сначала выбирают ПАЛАТУ полосой доски, потом койку в ней', async () => {
    // Владелец назвал и койки, и палаты («selecting beds or rooms»). Палату
    // выбирают ровно тем же органом, что на доске, — полосой палат; койку —
    // плиткой внутри выбранной палаты.
    resetWorld();
    const { container } = await mountSection();
    const orders = panelFor(container, 'orders');
    const row = btns(orders, 'Положить на койку')[1];
    assert.ok(row, 'заявки без палаты нет в очереди размещения');
    row.click();
    await settle(60);

    let picker = topOverlay();
    assert.ok(textOf(picker).includes('Петрова Мария'), 'открыли не ту заявку');
    assert.ok(textOf(picker).includes('Палата в заявке не указана'), 'окно не сказало, что палату выбирают здесь');

    // Полоса палат — и обе палаты в ней, с числом коек.
    const wardPill = (name) => btns(picker, name).find((b) => hasClass(b, 'segmented-btn'));
    assert.ok(wardPill('Все палаты'), 'полосы палат нет — палату выбрать нечем');
    assert.ok(wardPill('Терапия') && wardPill('Хирургия'), 'в полосе не все палаты');

    // Пока не выбрана палата — видны койки обеих.
    assert.ok(textOf(picker).includes('T-2') && textOf(picker).includes('S-1'));

    wardPill('Хирургия').click();
    await settle(60);
    picker = topOverlay();
    assert.ok(textOf(picker).includes('S-1'), 'выбранная палата не показала свои койки');
    assert.ok(!textOf(picker).includes('T-2'), 'после выбора палаты остались койки чужой палаты');

    btns(picker, 'S-1')[0].click();
    await settle();
    btns(topOverlay(), 'Положить').filter((b) => textOf(b).trim() === 'Положить')[0].click();
    await settle(80);
    const call = rpcCalls.find((c) => c.name === 'admission_admit');
    assert.ok(call, 'размещение не ушло на сервер');
    assert.deepEqual(call.args, { admission_id: 12, bed_id: 8 });
});

test('полоса вкладок доступна с клавиатуры: стрелки, Home и End', async () => {
    resetWorld();
    const { container, api } = await mountSection();
    const [orders, beds, history] = tabButtons(container);

    // В tablist из порядка обхода Tab вынуты все кнопки, кроме активной.
    assert.deepEqual([orders, beds, history].map((b) => b.getAttribute('tabindex')), ['0', '-1', '-1']);

    const key = (btn, k) => btn.dispatchEvent({ type: 'keydown', key: k, currentTarget: btn, preventDefault() {}, stopPropagation() {} });
    key(orders, 'ArrowRight');
    await settle(60);
    assert.equal(api.activeTab(), 'beds');
    key(beds, 'End');
    await settle(60);
    assert.equal(api.activeTab(), 'history');
    key(history, 'Home');
    await settle(60);
    assert.equal(api.activeTab(), 'orders');
    assert.deepEqual(tabButtons(container).map((b) => b.getAttribute('aria-selected')), ['true', 'false', 'false']);
});

test('отказ сервера доходит словами, окно не закрывается, койку можно выбрать другую', async () => {
    resetWorld();
    admitRefusal = 'Койка на уборке — сначала подтвердите уборку.';
    try {
        const { container } = await mountSection();
        btns(panelFor(container, 'orders'), 'Положить на койку')[0].click();
        await settle(60);
        btns(topOverlay(), 'T-2')[0].click();
        await settle();
        btns(topOverlay(), 'Положить').filter((b) => textOf(b).trim() === 'Положить')[0].click();
        await settle(80);

        assert.match(lastToast(), /Койка на уборке/);
        const submit = btns(topOverlay(), 'Положить').filter((b) => textOf(b).trim() === 'Положить')[0];
        assert.ok(submit && !submit.hasAttribute('disabled'), 'после отказа кнопку надо вернуть в работу');
    } finally { admitRefusal = null; }
});

// ===========================================================================
// 5. ПОЛОЖИЛИ НА ВКЛАДКЕ «ЗАЯВКИ» — ВИДНО НА ВКЛАДКЕ «КОЙКИ»
// ===========================================================================

test('размещение, сделанное в окне, тут же видно на доске коек', async () => {
    resetWorld();
    const { container, api } = await mountSection();

    // До: койка свободна и на доске.
    await api.select('beds');
    await settle(60);
    assert.ok(!textOf(btns(panelFor(container, 'beds'), 'T-2')[0]).includes('Иванов'),
        'мир начинается не с той койки');

    await api.select('orders');
    await settle(60);
    btns(panelFor(container, 'orders'), 'Положить на койку')[0].click();
    await settle(60);
    btns(topOverlay(), 'T-2')[0].click();
    await settle();
    btns(topOverlay(), 'Положить').filter((b) => textOf(b).trim() === 'Положить')[0].click();
    await settle(90);

    // После: перешли на доску — койка занята ЭТИМ пациентом. Ради этого
    // вкладка и перечитывается при каждом показе, а не монтируется однажды.
    await api.select('beds');
    await settle(80);
    const t2 = btns(panelFor(container, 'beds'), 'T-2')[0];
    assert.ok(t2, 'койки не стало на доске');
    assert.ok(textOf(t2).includes('Занята'), 'койка на доске всё ещё свободна');
    assert.ok(textOf(t2).includes('Иванов Иван Иванович'), 'на койке не видно, кого туда положили');
    assert.ok(textOf(panelFor(container, 'beds')).includes('занято 2 из 3'), 'занятость палаты не пересчиталась');
});

// ===========================================================================
// 6. ПРАВА НЕ ИЗМЕНИЛИСЬ
// ===========================================================================

test('медсестра видит раздел, кассир — нет; оба старых маршрута под тем же ключом', () => {
    const nurse = { name: 'Медсестра', permissions: { sections: ['patients', 'procedures', 'beds'], levels: { beds: 'editor' } } };
    const cashier = { name: 'Кассир', permissions: { sections: ['cashier', 'patients'], levels: { cashier: 'admin' } } };

    perms.setEffectiveFromRole(nurse);
    assert.equal(perms.isModuleAllowed('admissions'), true, 'медсестра осталась без «Стационара»');
    assert.equal(perms.isRouteAllowed('admissions'), true);
    assert.equal(perms.isRouteAllowed('beds'), true, 'закладка на #beds стала отказом');

    perms.setEffectiveFromRole(cashier);
    assert.equal(perms.isModuleAllowed('admissions'), false, 'кассир увидел стационар');
    assert.equal(perms.isRouteAllowed('admissions'), false);
    assert.equal(perms.isRouteAllowed('beds'), false, 'кассиру открылась доска коек');

    perms.setFullAccess('Admin');
});

// ===========================================================================
// 7. ОТДЕЛЬНЫЙ ЭКРАН ОЧЕРЕДЕЙ ЦЕЛ
// ===========================================================================

test('очереди смены рисуются и сами по себе — со своей шапкой раздела', async () => {
    resetWorld();
    BODY.children.length = 0;
    perms.setFullAccess('Admin');
    const box = mk('div');
    BODY.appendChild(box);
    await renderAdmissions(box, {});
    await settle(60);
    const head = walk(box).find((n) => hasClass(n, 'page-head'));
    assert.ok(head, 'у экрана очередей пропала шапка');
    assert.ok(textOf(head).includes('Стационар'), 'шапка перестала называть раздел');
    assert.ok(textOf(box).includes('Ждут размещения'));
});
