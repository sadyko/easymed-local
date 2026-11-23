// INPATIENT_REQUIRED_V1 (2026-11-23) — «Настройки → Стационар»: страница, сохранение, маршрут.
//
// Владелец: «we need to make some settings for that so we can switch the setup of the
// stationary documents lists as a required, not required fields».
//
// Поддельный DOM — тот же, что в title-sheet.test.mjs; «сервер» отвечает
// inpatient_settings_get и записывает inpatient_settings_save.
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── минимальный DOM (тот же, что в title-sheet.test.mjs) ───────────────────
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
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { }
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
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
const winListeners = {};
globalThis.window = {
    location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} },
    addEventListener(t, fn) { (winListeners[t] || (winListeners[t] = [])).push(fn); },
    open: () => null,
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const settle = () => new Promise((r) => setTimeout(r, 30));
const byAttr = (root, tag, name, value) => walk(root).find((e) => e.tagName === tag && e.attrs[name] === value);
const sw = (root, key) => byAttr(root, 'INPUT', 'data-ips-switch', key);
const docSw = (root, kind) => byAttr(root, 'INPUT', 'data-ips-doc-required', kind);
const field = (root, key) => byAttr(root, 'INPUT', 'data-ips-field', key);
const chip = (root, kind, section) => walk(root).find((e) => e.tagName === 'BUTTON' && e.attrs['data-ips-kind'] === kind && e.attrs['data-ips-section'] === section);
const toggle = (el, on) => { el.checked = on; el.dispatchEvent({ type: 'change' }); };
const toastText = () => { const t = BODY.children.find((c) => c.attrs && c.attrs.id === 'toast'); return t ? t._text : ''; };

// ─── «сервер» ───────────────────────────────────────────────────────────────
const DATA = {
    settings: { intake_before_attending: 1, admitting_at_placement: 1, primary_needs_diagnosis: 1, discharge_needs_epicrisis: 1, title_required: 1,
        title_required_fields: ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation'] },
    docs: [
        { kind: 'intake', title: '', builtin: true, required: true, required_sections: [], sections: ['complaints', 'objective', 'diagnosis', 'plan'] },
        { kind: 'primary', title: '', builtin: true, required: true, required_sections: [], sections: ['complaints', 'objective', 'diagnosis', 'plan', 'body'] },
        { kind: 'own_7', title: 'Тестовый лист', builtin: false, required: true, required_sections: [], sections: ['complaints', 'objective', 'diagnosis', 'plan', 'body'] },
        { kind: 'discharge', title: '', builtin: true, required: false, required_sections: [], sections: ['complaints', 'objective', 'diagnosis', 'plan', 'body'] },
    ],
    log: [{ id: 1, at: '2026-11-23T08:00:00Z', user_name: 'Сотрудник head', field: 'intake_before_attending', old_value: '1', new_value: '0' }],
    can_edit: true,
};
const clone = (v) => JSON.parse(JSON.stringify(v));
let SERVER = clone(DATA);
let FAIL_GET = null;
let FAIL_SAVE = null;
const rpcCalls = [];
function applySave(args) {
    let changed = 0;
    for (const [k, v] of Object.entries(args)) {
        if (k === 'docs') {
            for (const d of v) {
                const row = SERVER.docs.find((x) => x.kind === d.kind);
                if ('required' in d) { row.required = !!d.required; changed += 1; }
                if ('required_sections' in d) { row.required_sections = d.required_sections.slice(); changed += 1; }
            }
        } else { SERVER.settings[k] = Array.isArray(v) ? v.slice() : v; changed += 1; }
    }
    SERVER.log.unshift({ id: SERVER.log.length + 1, at: '2026-11-23T09:00:00Z', user_name: 'Сотрудник head', field: 'intake_before_attending', old_value: '1', new_value: '0' });
    return changed;
}
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message, status = 400) => ({ ok: false, status, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });
    if (!u.startsWith('/api/rpc/')) return fail('unexpected ' + u);
    const name = u.slice('/api/rpc/'.length);
    rpcCalls.push({ name, args: body });
    if (name === 'inpatient_settings_get') return FAIL_GET ? fail(FAIL_GET, 501) : ok(clone(SERVER));
    if (name === 'inpatient_settings_save') {
        if (FAIL_SAVE) return fail(FAIL_SAVE, 403);
        const changed = applySave(body);
        return ok(Object.assign(clone(SERVER), { changed }));
    }
    return fail('unknown rpc ' + name);
};

function reset() { SERVER = clone(DATA); FAIL_GET = null; FAIL_SAVE = null; rpcCalls.length = 0; }
async function mount() {
    const { renderInpatientSettings } = await import('../views/inpatient-settings.js');
    const root = mkEl('div');
    await renderInpatientSettings(root, {});
    await settle();
    return root;
}

test('страница: четыре переключателя, документы с разделами, поля листа, журнал', async () => {
    reset();
    const root = await mount();
    const t = textOf(root);
    for (const s of ['Лечащий врач — только после осмотра приёмного врача', 'Приёмный врач — обязателен при размещении на койке',
        'Первичный осмотр — только с диагнозом', 'Выписка — только с выписным эпикризом', 'Титульный лист', 'Тестовый лист',
        'Рост', 'Санитарная обработка', 'Кто менял', 'Сотрудник head']) assert.ok(t.includes(s), 'нет: ' + s);
    // По одной простой фразе на состояние: всё включено — фразы «включено».
    assert.ok(t.includes('Первичный осмотр не публикуется без диагноза.'));
    assert.ok(!t.includes('Первичный осмотр можно опубликовать без диагноза.'));
    // Заголовки карточек и подсказка у разделов.
    for (const s of ['Что останавливает работу', 'Документы истории болезни', 'Титульный лист — обязательные поля',
        'Первичный осмотр и план лечения', 'Жалобы', 'Диагноз']) assert.ok(t.includes(s), 'нет: ' + s);
    assert.ok(t.includes('Отмеченные разделы обязательны'), 'подсказка у разделов');
    // Группы полей листа — как в TITLE_GROUPS.
    for (const g of ['Пациент', 'Поступление в стационар', 'Измерения', 'Осмотр медсестры', 'Документы при поступлении']) assert.ok(t.includes(g), 'группа ' + g);
    // Без изменений сохранять нечего.
    assert.equal(findBtn(root, 'Сохранить').disabled, true, '«Сохранить» доступна без изменений');
    assert.ok(!t.includes('Есть несохранённые изменения'));
});

test('доступность: переключатели — флажки role=switch с подписью; разделы — кнопки aria-pressed', async () => {
    reset();
    const root = await mount();
    for (const k of ['intake_before_attending', 'admitting_at_placement', 'primary_needs_diagnosis', 'discharge_needs_epicrisis', 'title_required']) {
        const el = sw(root, k);
        assert.ok(el, 'нет переключателя ' + k);
        assert.equal(el.attrs.type, 'checkbox');
        assert.equal(el.attrs.role, 'switch');
        assert.equal(el.checked, true, k + ' включён');
        const id = el.attrs.id;
        assert.ok(id, k + ': у флажка нет id');
        assert.ok(walk(root).some((e) => e.tagName === 'LABEL' && e.attrs.for === id), k + ': нет <label for>');
    }
    const req = docSw(root, 'primary');
    assert.equal(req.attrs.role, 'switch');
    assert.match(req.attrs['aria-label'] || '', /Первичный осмотр и план лечения/);
    const c = chip(root, 'primary', 'diagnosis');
    assert.equal(c.attrs['aria-pressed'], 'false');
    assert.equal(c.attrs.type, 'button');
    c.click();
    assert.equal(c.attrs['aria-pressed'], 'true', 'раздел не стал обязательным');
    c.click();
    assert.equal(c.attrs['aria-pressed'], 'false');
    // У документа — только его разделы: «Дополнительно» есть у первичного, у приёмного — нет.
    assert.ok(chip(root, 'primary', 'body'));
    assert.equal(chip(root, 'intake', 'body'), undefined, 'у осмотра приёмного врача раздела «Дополнительно» нет');
    // Значки — только Icon(), без эмодзи.
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(textOf(root)), 'эмодзи на странице');
});

test('переключатель меняет свою фразу на месте', async () => {
    reset();
    const root = await mount();
    toggle(sw(root, 'primary_needs_diagnosis'), false);
    const t = textOf(root);
    assert.ok(t.includes('Первичный осмотр можно опубликовать без диагноза.'));
    assert.ok(!t.includes('Первичный осмотр не публикуется без диагноза.'));
    toggle(sw(root, 'intake_before_attending'), false);
    assert.ok(textOf(root).includes('Лечащего врача назначают сразу после размещения на койке; осмотр остаётся в списке как документ.'));
    assert.ok(textOf(root).includes('Есть несохранённые изменения'));
});

test('сохраняется только изменённое', async () => {
    reset();
    const root = await mount();
    rpcCalls.length = 0;
    toggle(sw(root, 'intake_before_attending'), false);
    chip(root, 'primary', 'diagnosis').click();
    toggle(field(root, 'height_cm'), false);
    assert.ok(textOf(root).includes('Есть несохранённые изменения'));
    assert.equal(findBtn(root, 'Сохранить').disabled, false);
    findBtn(root, 'Сохранить').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'inpatient_settings_save');
    assert.deepEqual(call.args, {
        intake_before_attending: 0,
        title_required_fields: ['weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation'],
        docs: [{ kind: 'primary', required_sections: ['diagnosis'] }],
    });
});

test('после сохранения: страница — по ответу сервера, тост, отметка «несохранённые» ушла', async () => {
    reset();
    const root = await mount();
    toggle(docSw(root, 'own_7'), false);
    findBtn(root, 'Сохранить').click();
    await settle();
    assert.equal(toastText(), 'Настройки стационара сохранены.');
    assert.equal(SERVER.docs.find((d) => d.kind === 'own_7').required, false, 'сервер не получил изменение');
    assert.equal(docSw(root, 'own_7').checked, false, 'после сохранения документ снова «обязательный»');
    assert.ok(!textOf(root).includes('Есть несохранённые изменения'), 'после сохранения осталась отметка');
    assert.equal(findBtn(root, 'Сохранить').disabled, true);
    // Журнал перерисован: в ответе две строки.
    assert.equal(walk(root).filter((e) => e.attrs && e.attrs['data-ips-log'] !== undefined && e.tagName === 'LI').length, 2);
});

test('отказ сервера: сообщение в тосте, правки остаются на экране', async () => {
    reset();
    const root = await mount();
    toggle(sw(root, 'admitting_at_placement'), false);
    FAIL_SAVE = 'Настройки стационара меняет главный врач или администратор.';
    findBtn(root, 'Сохранить').click();
    await settle();
    assert.equal(toastText(), 'Настройки стационара меняет главный врач или администратор.');
    assert.equal(sw(root, 'admitting_at_placement').checked, false, 'правку стёрли');
    assert.ok(textOf(root).includes('Есть несохранённые изменения'));
    assert.equal(findBtn(root, 'Сохранить').disabled, false, 'кнопку не вернули');
    // Повтор после отказа шлёт то же самое.
    FAIL_SAVE = null;
    rpcCalls.length = 0;
    findBtn(root, 'Сохранить').click();
    await settle();
    assert.deepEqual(rpcCalls.find((c) => c.name === 'inpatient_settings_save').args, { admitting_at_placement: 0 });
});

test('выписной эпикриз: пока включена «Выписка — только с выписным эпикризом», его переключатель включён и заблокирован', async () => {
    reset();
    const root = await mount();
    const d = docSw(root, 'discharge');
    assert.equal(d.checked, true, 'при включённом переключателе выписки эпикриз показан «по желанию»');
    assert.equal(d.disabled, true, 'переключатель эпикриза можно трогать, а решает выписка');
    assert.ok(textOf(root).includes('Обязателен, пока включено «Выписка — только с выписным эпикризом».'));
    // Выписку выключили — решает сам документ (на сервере он «по желанию»).
    toggle(sw(root, 'discharge_needs_epicrisis'), false);
    const d2 = docSw(root, 'discharge');
    assert.equal(d2.disabled, false);
    assert.equal(d2.checked, false, 'показан не флаг самого документа');
    assert.ok(!textOf(root).includes('Обязателен, пока включено'));
    toggle(d2, true);
    rpcCalls.length = 0;
    findBtn(root, 'Сохранить').click();
    await settle();
    assert.deepEqual(rpcCalls.find((c) => c.name === 'inpatient_settings_save').args,
        { discharge_needs_epicrisis: 0, docs: [{ kind: 'discharge', required: true }] });
});

test('титульный лист не обязателен — поля серые, с пометкой; снова обязателен — поля работают', async () => {
    reset();
    const root = await mount();
    assert.equal(field(root, 'height_cm').disabled, false);
    assert.ok(!textOf(root).includes('Титульный лист не обязателен — поля не требуются.'));
    toggle(sw(root, 'title_required'), false);
    assert.equal(field(root, 'height_cm').disabled, true, 'поля листа можно отмечать, хотя лист не обязателен');
    assert.equal(field(root, 'phone').disabled, true);
    assert.ok(textOf(root).includes('Титульный лист не обязателен — поля не требуются.'));
    toggle(sw(root, 'title_required'), true);
    assert.equal(field(root, 'height_cm').disabled, false);
    assert.ok(!textOf(root).includes('Титульный лист не обязателен — поля не требуются.'));
    // Сервер с выключенным листом — страница открывается сразу с серыми полями.
    reset();
    SERVER.settings.title_required = 0;
    const root2 = await mount();
    assert.equal(sw(root2, 'title_required').checked, false);
    assert.equal(field(root2, 'height_cm').disabled, true);
    assert.equal(field(root2, 'height_cm').checked, true, 'список полей хранится, просто не действует');
});

test('только просмотр (can_edit: false): всё погашено, «Сохранить» нет', async () => {
    reset();
    SERVER.can_edit = false;
    const root = await mount();
    const controls = walk(root).filter((e) => (e.tagName === 'INPUT' && e.attrs.type === 'checkbox') || (e.tagName === 'BUTTON' && e.attrs['data-ips-section']));
    assert.ok(controls.length > 20, 'элементов управления не нашлось');
    assert.deepEqual(controls.filter((e) => !e.disabled).map((e) => e.attrs['data-ips-switch'] || e.attrs['data-ips-field'] || e.attrs['data-ips-section'] || e.attrs['data-ips-doc-required']), []);
    assert.equal(findBtn(root, 'Сохранить'), undefined, 'кнопка «Сохранить» у только просмотра');
    assert.ok(textOf(root).includes('Настройки стационара меняет главный врач или администратор.'));
    assert.ok(textOf(root).includes('Кто менял'), 'журнал виден и в просмотре');
});

test('ошибка чтения (старый сервер, 501): спокойная карточка, без падения', async () => {
    reset();
    FAIL_GET = 'RPC not implemented: inpatient_settings_get';
    const root = await mount();
    assert.ok(textOf(root).includes('Настройки стационара недоступны: RPC not implemented: inpatient_settings_get'));
    assert.equal(findBtn(root, 'Сохранить'), undefined);
});

test('журнал пуст — так и сказано', async () => {
    reset();
    SERVER.log = [];
    const root = await mount();
    assert.ok(textOf(root).includes('Изменений ещё не было.'));
});

test('уход со страницы с несохранёнными правками — браузер переспрашивает', async () => {
    reset();
    const root = await mount();
    const fire = () => { let prevented = false; const e = { type: 'beforeunload', preventDefault() { prevented = true; }, returnValue: undefined }; for (const fn of winListeners.beforeunload || []) fn(e); return prevented; };
    assert.equal(fire(), false, 'без правок уход не спрашивают');
    toggle(sw(root, 'intake_before_attending'), false);
    assert.equal(fire(), true, 'правки есть — уход не переспросили');
});

test('settingsDiff и строка журнала', async () => {
    const { settingsDiff, logLineText } = await import('../views/inpatient-settings.js');
    assert.deepEqual(settingsDiff(DATA, DATA), {});
    assert.ok(logLineText(DATA.log[0], DATA.docs).includes('Лечащий врач — только после осмотра приёмного врача'));
    assert.ok(logLineText(DATA.log[0], DATA.docs).includes('Сотрудник head'));
    assert.match(logLineText(DATA.log[0], DATA.docs), /включён → выключен/);
    const sec = logLineText({ at: '2026-11-23T08:00:00Z', user_name: 'Сотрудник head', field: 'doc:own_7:sections', old_value: '[]', new_value: '["plan"]' }, DATA.docs);
    assert.ok(sec.includes('Тестовый лист'));
    assert.match(sec, /— → План обследования и лечения/);
    const flds = logLineText({ at: '2026-11-23T08:00:00Z', user_name: 'Сотрудник head', field: 'title_required_fields', old_value: '["height_cm"]', new_value: '["height_cm","pulse_bpm"]' }, DATA.docs);
    assert.match(flds, /Обязательные поля титульного листа — Рост → Рост, Пульс/);
    const tr1 = logLineText({ at: '2026-11-23T08:00:00Z', user_name: 'Сотрудник head', field: 'title_required', old_value: '1', new_value: '0' }, DATA.docs);
    assert.match(tr1, /Титульный лист — обязательный документ — включён → выключен/);
    const dreq = logLineText({ at: '2026-11-23T08:00:00Z', user_name: 'Сотрудник head', field: 'doc:primary:required', old_value: '1', new_value: '0' }, DATA.docs);
    assert.match(dreq, /Первичный осмотр и план лечения: обязательный документ — включён → выключен/);
    // Изменения документов: только изменённое, без лишних ключей.
    const after = clone(DATA);
    after.docs[0].required = false;
    after.docs[2].required_sections = ['plan', 'complaints'];
    after.settings.title_required = 0;
    assert.deepEqual(settingsDiff(DATA, after), {
        title_required: 0,
        docs: [{ kind: 'intake', required: false }, { kind: 'own_7', required_sections: ['complaints', 'plan'] }],
    });
});

test('маршрут: главный врач и администратор — да; регистратура, врач, медсёстры с «Настройками» — нет; плитка в «Помещениях»; оболочка знает маршрут', async () => {
    const perms = await import('../permissions.js');
    const role = (name, sections) => ({ name, permissions: { sections, levels: {} } });
    try {
        perms.setFullAccess('Admin');
        assert.equal(perms.isRouteAllowed('inpatient-settings'), true);
        perms.setEffectiveFromRole(role('head_doctor', ['settings']));
        assert.equal(perms.isRouteAllowed('inpatient-settings'), true);
        perms.setEffectiveFromRole(role('head_doctor', ['patients']));
        assert.equal(perms.isRouteAllowed('inpatient-settings'), false, 'главному врачу без «Настроек» открылась страница настроек');
        for (const code of ['registrar', 'doctor', 'nurse', 'senior_nurse', 'cashier']) {
            perms.setEffectiveFromRole(role(code, ['settings']));
            assert.equal(perms.isRouteAllowed('inpatient-settings'), false, code + ': страница открылась');
        }
    } finally { perms.setFullAccess('Admin'); }
    const { GROUPS } = await import('../views/settings-hub.js');
    const rooms = GROUPS.find((g) => g.key === 'rooms');
    assert.ok(rooms.items.some((i) => i.route === 'inpatient-settings'));
    const tile = rooms.items.find((i) => i.route === 'inpatient-settings');
    assert.equal(tile.label, 'Стационар');
    assert.equal(tile.icon, 'Bed');
    assert.equal(rooms.items.findIndex((i) => i.route === 'inpatient-settings'), rooms.items.findIndex((i) => i.route === 'rooms-setup') + 1, 'плитка — сразу за «Помещениями»');
    const fs = await import('node:fs');
    const shell = fs.readFileSync(new URL('../../admin.js', import.meta.url), 'utf8');
    assert.match(shell, /'inpatient-settings':\s*'settings'/);
    assert.match(shell, /case 'inpatient-settings':/);
    assert.match(shell, /'inpatient-settings':\s*\['Insights', 'Settings', 'Стационар'\]/);
    assert.match(shell, /import \{ renderInpatientSettings \} from '\.\/admin\/views\/inpatient-settings\.js';/);
});

test('правило маршрута — те же роли, что у сервера (SETTINGS_WRITE_ROLES)', async () => {
    const fs = await import('node:fs');
    const server = fs.readFileSync(new URL('../../../../server/services/rpc/inpatient-settings.js', import.meta.url), 'utf8');
    const perms = fs.readFileSync(new URL('../permissions.js', import.meta.url), 'utf8');
    const srv = server.match(/export const SETTINGS_WRITE_ROLES = \[([^\]]*)\]/);
    const cli = perms.match(/if \(view === 'inpatient-settings'\) return isModuleAllowed\('settings'\) && hasActorRole\(\[([^\]]*)\]\);/);
    assert.ok(srv, 'SETTINGS_WRITE_ROLES не найден на сервере');
    assert.ok(cli, 'правило inpatient-settings не найдено в permissions.js');
    const list = (s) => s.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
    assert.deepEqual(list(cli[1]), list(srv[1]), 'экран и сервер разошлись в том, кто меняет настройки стационара');
});
