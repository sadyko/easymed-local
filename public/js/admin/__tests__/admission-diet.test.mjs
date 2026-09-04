// DIET_TABLES_V1 — ЛЕЧЕБНЫЙ СТОЛ, НАЗНАЧЕННЫЙ ЧЕЛОВЕКОМ, А НЕ ТЕСТОМ.
//
// До этого файла у пяти написанных RPC стола не было НИ ОДНОГО вызывающего:
// сервер умел назначать стол, порционник умел его печатать, а нажать между ними
// было негде — и кухня получала «Стол не назначен» на каждого пациента навсегда.
// Тесты поэлементно правильных частей этого не ловят, поэтому здесь проверяется
// ровно шов: КНОПКА В КАРТЕ ГОСПИТАЛИЗАЦИИ доходит до строки в admission_diets.
//
// ЧТО ЗДЕСЬ НАСТОЯЩЕЕ. Подделан только транспорт: `fetch` вместо HTTP зовёт
// серверные модули напрямую. НЕ подделаны ни база (better-sqlite3 в памяти,
// прогнанная настоящими миграциями — значит и справочник Певзнера настоящий, с
// дырой на месте №12), ни матрица прав (rpc/diet.js и rpc/inpatient-flow.js
// отвечают те же, что в бою). Поэтому «медсестра стол не меняет» здесь не
// утверждение теста, а следствие серверного списка ролей: поправят его — тест
// поедет вместе с ним, а не мимо.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── минимальный DOM (тот же стенд, что у inpatient-route / mar-nurse) ──────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {}
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; },
            get() { return ''; },
        });
    }
    return el;
}
globalThis.Node = FakeNode;
const BODY = mkEl('body');
// Окна закрываются через overlay.remove(); без родителя «закрыть» ничего бы не
// закрывало, и выбор стола остался бы лежать поверх карточки.
const realAppend = FakeNode.prototype.appendChild;
FakeNode.prototype.appendChild = function (c) { if (c && typeof c === 'object') c._parent = this; return realAppend.call(this, c); };
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
// I18N_LOCALE_PIN_V1 — экран рисуется по-русски независимо от локали машины.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const topOverlay = () => BODY.children.filter((c) => c.className === 'modal').pop() || null;
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── настоящая база и настоящие RPC ─────────────────────────────────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const diet = await import('../../../../server/services/rpc/diet.js');
const flow = await import('../../../../server/services/rpc/inpatient-flow.js');

const ACTORS = {
    doctor:       { id: 1, role: 'doctor', full_name: 'Каримов Рустам' },
    nurse:        { id: 2, role: 'nurse', full_name: 'Медсестра поста' },
    senior_nurse: { id: 5, role: 'nurse', extra_roles: ['senior_nurse'], full_name: 'Старшая медсестра' },
};
let actor = ACTORS.doctor;
const beActor = (name) => { actor = ACTORS[name]; };

// Один пациент в лечении и один — только на койке: разница между ними и есть
// охранник маршрута (стол не назначают до первичного осмотра).
const ACTIVE_ID = 1;
const ADMITTED_ID = 2;

const db = openDb(':memory:');
migrate(db);
{
    const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
    u.run(1, 'doc', 'x', 'Каримов Рустам', 'doctor');
    u.run(2, 'nur', 'x', 'Медсестра поста', 'nurse');
    u.run(5, 'snur', 'x', 'Старшая медсестра', 'nurse');
    db.prepare('INSERT INTO patients (id, mrn, full_name) VALUES (1, ?, ?)').run('M-101', 'Иванов Иван Иванович');
    db.prepare('INSERT INTO patients (id, mrn, full_name) VALUES (2, ?, ?)').run('M-102', 'Петров Пётр');
    db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
    db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'T-1',1,'occupied')").run();
    db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (2,'T-2',1,'occupied')").run();
    const a = db.prepare(`INSERT INTO admissions (id, patient_id, bed_id, ward_id, doctor_id, attending_doctor_id, status)
                          VALUES (?,?,?,1,1,1,?)`);
    a.run(ACTIVE_ID, 1, 1, 'active');
    a.run(ADMITTED_ID, 2, 2, 'admitted');
}

let rpcCalls = [];

const RPC = {
    inpatient_capabilities: (a, u) => flow.inpatientCapabilities(db, a, u),
    admission_flow_state:   (a, u) => flow.admissionFlowState(db, a, u),
    diet_tables_list:       (a, u) => diet.dietTablesList(db, a, u),
    admission_diet_set:     (a, u) => diet.admissionDietSet(db, a, u),
    admission_diet_history: (a, u) => diet.admissionDietHistory(db, a, u),
};

/** Строка госпитализации в том виде, в каком её просит карточка (embed'ы реестра). */
function admissionRow(id) {
    const r = db.prepare(`
        SELECT a.*, p.mrn, p.full_name AS patient_name, w.name AS ward_name, b.code AS bed_code,
               d.full_name AS attending_name
          FROM admissions a
          JOIN patients p ON p.id = a.patient_id
          LEFT JOIN wards w ON w.id = a.ward_id
          LEFT JOIN beds b ON b.id = a.bed_id
          LEFT JOIN users d ON d.id = a.attending_doctor_id
         WHERE a.id = ?`).get(Number(id));
    if (!r) return null;
    return {
        ...r,
        patients: { mrn: r.mrn, full_name: r.patient_name },
        wards: r.ward_name ? { name: r.ward_name } : null,
        beds: r.bed_code ? { code: r.bed_code } : null,
        attending: r.attending_name ? { full_name: r.attending_name, specialty: '' } : null,
        examined: null,
    };
}

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });

    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body, actor: actor.role });
        const fn = RPC[name];
        if (!fn) return ok({});
        try { return ok(fn(body, actor)); }
        catch (e) { return fail(e && e.message ? e.message : String(e)); }
    }
    if (u === '/api/db') {
        if (body.table === 'admissions') {
            const idF = (body.filters || []).find((f) => f.col === 'id');
            const row = idF ? admissionRow(idF.val) : null;
            return ok(body.single ? row : [row].filter(Boolean));
        }
        return ok(body.single ? null : []);
    }
    return ok([]);
};

const modals = await import('../views/admission-modal.js');
const { t } = await import('../i18n.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/** Открыть карточку госпитализации и вернуть её окно. */
async function openCard(admissionId = ACTIVE_ID) {
    BODY.children.length = 0;
    rpcCalls = [];
    modals.openAdmissionCard({ admissionId });
    await settle();
    const card = topOverlay();
    assert.ok(card, 'карточка госпитализации не открылась');
    return card;
}

// ===========================================================================
// 1. Стол виден в карте
// ===========================================================================

test('в карте свежей госпитализации стол назван словом «не назначен», а не пустым местом', async () => {
    beActor('doctor');
    const card = await openCard();
    assert.ok(textOf(card).includes('Иванов Иван Иванович'), 'карточка открылась не на том пациенте');
    assert.ok(textOf(card).includes('Стол не назначен'),
        'пустое место читается как «данные не загрузились»; «не назначен» — это вопрос кухни отделению');
    assert.ok(rpcCalls.some((c) => c.name === 'admission_diet_history'),
        'стол должен ехать вместе с карточкой, а не по отдельной кнопке');
});

test('«Сменить стол» рисует ОТВЕТ СЕРВЕРА: врачу — да, медсестре — нет', async () => {
    beActor('doctor');
    assert.ok(findBtn(await openCard(), 'Сменить стол'), 'лечащий врач не видит смены стола в карте своего пациента');

    // Обычная медсестра стол НЕ МЕНЯЕТ (SET_ROLES в rpc/diet.js) — и кнопки у
    // неё нет не потому, что экран знает её роль, а потому, что can_set пришёл
    // ложью от той же функции, которой сервер потом откажет.
    beActor('nurse');
    assert.equal(findBtn(await openCard(), 'Сменить стол'), undefined,
        'кнопка у того, кому сервер откажет, — обещание, которого программа не выполнит');

    // А старшая — меняет: ночью и в выходной стол переводят на «ноль перед
    // операцией» без врача.
    beActor('senior_nurse');
    assert.ok(findBtn(await openCard(), 'Сменить стол'), 'старшая медсестра стол меняет');
});

test('пациенту, ещё не дошедшему до лечения, стол не предлагают', async () => {
    beActor('doctor');
    const card = await openCard(ADMITTED_ID);
    assert.ok(textOf(card).includes('Петров Пётр'));
    assert.equal(findBtn(card, 'Сменить стол'), undefined,
        'до первичного осмотра никто не знает, чем пациента можно кормить');
});

// ===========================================================================
// 2. Стол назначается, история копится
// ===========================================================================

test('врач выбирает стол из справочника Певзнера — с №0, с №15 и БЕЗ №12', async () => {
    beActor('doctor');
    const card = await openCard();
    findBtn(card, 'Сменить стол').click();
    await settle();

    const picker = topOverlay();
    const txt = textOf(picker);
    assert.ok(txt.includes('Лечебный стол'), 'окно выбора стола не открылось');
    assert.ok(txt.includes('Стол №0'), 'нулевого стола нет в списке — его назначают в первые дни после операции');
    assert.ok(txt.includes('Стол №15'), 'общего стола нет в списке');
    assert.ok(!txt.includes('Стол №12'),
        'стол №12 упразднён в номенклатуре Певзнера: дыра между №11 и №13 правильная (миграция 094)');
    // ПОКАЗАНИЕ рядом с номером: врач выбирает стол по диагнозу, а не по памяти.
    assert.ok(txt.includes('Сахарный диабет'), 'у столов не показаны показания');
});

test('назначение уходит на сервер с выбранным столом и разовостью — и возвращается в карту', async () => {
    beActor('doctor');
    const card = await openCard();
    findBtn(card, 'Сменить стол').click();
    await settle();

    const picker = topOverlay();
    findBtn(picker, 'Стол №9').click();
    walk(picker).find((e) => e.tagName === 'SELECT').value = '5';
    rpcCalls = [];
    findBtn(picker, 'Назначить стол').click();
    await settle();

    const call = rpcCalls.find((c) => c.name === 'admission_diet_set');
    assert.ok(call, 'назначение стола не ушло на сервер');
    assert.equal(call.args.diet_code, '9');
    assert.equal(call.args.meals_per_day, 5);
    assert.equal(call.args.admission_id, ACTIVE_ID);

    // База, а не намерение: один действующий период с автором-нажавшим.
    const row = db.prepare('SELECT * FROM admission_diets WHERE admission_id = ? AND ended_at IS NULL').get(ACTIVE_ID);
    assert.equal(row.diet_code, '9');
    assert.equal(row.meals_per_day, 5);
    assert.equal(row.assigned_by, ACTORS.doctor.id, 'автором пишется ТОТ, КТО НАЖАЛ');

    // И карточка перерисовалась сама — врач видит результат там же, где нажал.
    const txt = textOf(topOverlay());
    assert.ok(txt.includes('Стол №9'), 'назначенный стол не вернулся в карточку');
    assert.ok(txt.includes('Каримов Рустам'), 'стол без автора — запись без подписи');
    assert.ok(txt.includes('5-разовое'), 'разовость питания в карточке не названа');
});

test('смена стола не стирает прежний: в истории остаются ОБА периода', async () => {
    beActor('doctor');
    const card = await openCard();
    findBtn(card, 'Сменить стол').click();
    await settle();
    const picker = topOverlay();
    findBtn(picker, 'Стол №5').click();
    findBtn(picker, 'Назначить стол').click();
    await settle();

    const rows = db.prepare('SELECT diet_code, ended_at FROM admission_diets WHERE admission_id = ? ORDER BY id').all(ACTIVE_ID);
    assert.deepEqual(rows.map((r) => r.diet_code), ['9', '5'], 'период закрывается, а не правится на месте');
    assert.ok(rows[0].ended_at, 'прежний период не закрыт');
    assert.equal(rows[1].ended_at, null);

    // «С какого дня пациент на пятом столе» — вопрос, ради которого таблица
    // заведена историей. Ответ обязан быть НА ВИДУ, а не под раскрывашкой.
    const txt = textOf(topOverlay());
    assert.ok(txt.includes('История стола'), 'истории стола в карточке нет');
    assert.ok(txt.includes('Стол №9') && txt.includes('Стол №5'),
        'в истории видно не оба периода, а только действующий: ' + txt);
});

test('чистые подписи истории читаются и без окна', () => {
    assert.equal(modals.dietAuthorLine(null), '');
    const line = modals.dietAuthorLine({ since: '2026-09-04T11:00:00Z', assigned_by_name: 'Каримов Р.' });
    assert.ok(line.includes('назначен') && line.includes('Каримов Р.'), line);
    // Уволившийся сотрудник — не повод показать «назначен undefined».
    assert.ok(!modals.dietAuthorLine({ since: '2026-09-04T11:00:00Z', assigned_by_name: null }).includes('undefined'));

    assert.ok(modals.dietPeriodLine({ since: '2026-09-04T11:00:00Z', ended_at: null }).includes('действует'),
        'у действующего периода конец — слово, а не пустое место');
    assert.ok(!modals.dietPeriodLine({ since: '2026-09-04T11:00:00Z', ended_at: '2026-09-06T11:00:00Z' }).includes('действует'));
});

test('без права читать стол карточка не ломается, а просто молчит', () => {
    // Регистратуре admission_diet_history отвечает отказом (READ_ROLES) — и
    // тогда блока стола просто нет. Карточка маршрута обязана открыться и без
    // него: она отвечает на вопрос «где пациент», а не только «чем кормят».
    assert.equal(modals.dietSection({ id: 1 }, null, () => {}), null);
});

// ===========================================================================
// 3. Три английских пункта в русском меню
// ===========================================================================

test('«Задачи медсестры», «Лист назначений» и «Порционник» — по-русски, а не по-английски', () => {
    // Сайдбар спрашивает 'sidebar.nav.' + item.id (admin.js). Ключи были
    // camelCase — marNurse / marSheet / kitchenSheet — и не совпадали ни с
    // одним id, поэтому t() возвращал английский fallback В РУССКОМ МЕНЮ.
    const src = read('public/js/admin.js');
    const nav = src.slice(src.indexOf('const NAV = ['), src.indexOf('];', src.indexOf('const NAV = [')));
    const expected = {
        'mar-nurse': 'Задачи медсестры',
        'mar-sheet': 'Лист назначений',
        'kitchen-sheet': 'Порционник',
        'discharge': 'Выписки',   // образец, по которому исправлены три остальных
    };
    for (const [id, ru] of Object.entries(expected)) {
        assert.equal(t('sidebar.nav.' + id, 'FALLBACK'), ru,
            'пункт «' + id + '» показывает в русском интерфейсе не русское слово');
    }
    // Три из четырёх стоят пунктами меню; «Лист назначений» — только крошка:
    // на него ходят из карты пациента, а не из сайдбара.
    for (const id of ['mar-nurse', 'kitchen-sheet', 'discharge']) {
        assert.ok(new RegExp("id: '" + id + "'").test(nav), 'в сайдбаре нет пункта ' + id);
    }
    // И хлебная крошка спрашивает ТОТ ЖЕ ключ — иначе она снова разъедется с меню.
    for (const id of ['mar-nurse', 'mar-sheet', 'kitchen-sheet']) {
        assert.ok(src.includes("t('sidebar.nav." + id + "'"),
            'крошка просит ключ, отличный от id пункта: ' + id);
    }
    assert.ok(!/sidebar\.nav\.(marNurse|marSheet|kitchenSheet)/.test(src),
        'остался ключ, которого нет ни в одном словаре');
});
