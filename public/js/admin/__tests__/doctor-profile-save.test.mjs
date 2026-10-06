// RPC_PORT_V1 (доводка) — «Мой профиль» врача сохраняется одним вызовом
// update_my_doctor_profile, и экран не врёт о том, что сохранил.
//
// Было: после RPC экран сам писал user_specialties и doctor_conditions через
// /api/db. Реестр пускает в user_specialties только admin, а оба insert несли
// company_id, которого среди колонок реестра нет, — «Не удалось сохранить» у
// всех. Поля публичного профиля (биография, образование, соцсети, фото) офлайн
// не хранятся вовсе, а экран говорил «Профиль сохранён».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../i18n-strings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, '..', 'views', 'doctor-profile.js'), 'utf8');

export const NOT_STORED_MSG = 'Профиль сохранён. Биография, образование, соцсети и фото в офлайн-версии не хранятся.';

test('специальности и болезни уходят в RPC, прямых записей в таблицы нет', () => {
    assert.ok(!/from\('user_specialties'\)\s*\.(delete|insert|update)/.test(src), 'экран всё ещё пишет user_specialties сам');
    assert.ok(!/from\('doctor_conditions'\)\s*\.(delete|insert|update)/.test(src), 'экран всё ещё пишет doctor_conditions сам');
    // CLINIC_API_FIX_V1 — наборы едут в том же вызове, но только изменённые
    // (поведение проверяют тесты окна ниже).
    assert.match(src, /rpc\('update_my_doctor_profile', args\)/, 'наборы передаются в том же вызове');
});

test('not_stored — честное сообщение, а не «Профиль сохранён»', () => {
    assert.match(src, /not_stored/, 'ответ RPC про не сохранённые поля не читается');
    assert.ok(src.includes("'" + NOT_STORED_MSG + "'"), 'нет сообщения о полях, которые офлайн не хранятся');
    const e = STRINGS[NOT_STORED_MSG];
    assert.ok(e && e.ru && e.uz && e.en, 'сообщению нужен перевод в i18n-strings.js');
});

test('без медкор-каталога список специальностей берётся из канона, а сбой фото не валит сохранение', () => {
    assert.match(src, /SPECIALTY_ROWS/, 'офлайн каталог gw пуст — нужен канонический список');
    assert.match(src, /try \{ photoUrl = await uploadPendingPhoto\(\); \}/, 'сбой загрузки фото не должен останавливать сохранение');
});

test('M7b: строка специальности без слага узнаётся по каноническому имени, пустые слаги не уходят на сервер', () => {
    assert.match(src, /r\.specialty_slug \|\| slugOfName\(r\.name_ru\)/);
    assert.match(src, /st\.specSlugs\.filter\(Boolean\)\.slice\(0, 4\)/);
});

// V3120_FIX — «Мой профиль» не ходит в облачный шлюз. Офлайн /api/v1 нет:
// два каталога и синхронизация с medcore отвечали 404 на каждое открытие и
// каждое сохранение (инспекция v3.12.0, врач и главный врач).
test('V3120_FIX: профиль врача не зовёт облачный шлюз — каталоги встроенные', () => {
    assert.ok(!/\bgw\(/.test(src), 'экран всё ещё зовёт /api/v1 (gw)');
    assert.ok(!/from '\.\.\/gateway\.js'/.test(src), 'импорт облачного шлюза остался');
    assert.match(src, /st\.specCatalog = SPECIALTY_ROWS\.map/, 'специальности — из встроенного списка');
    const msg = 'Каталог болезней в офлайн-версии не подключён — уже отмеченные сохраняются как были.';
    assert.ok(src.includes("'" + msg + "'"), 'карточка болезней не объясняет, почему списка нет');
    assert.ok(STRINGS[msg] && STRINGS[msg].uz && STRINGS[msg].en, 'сообщению нужен перевод');
});

// ===========================================================================
// CLINIC_API_FIX_V1 (2026-10-06) — «Мой профиль» шлёт только изменённое.
//
// Было: каждое «Сохранить профиль» клало в `p` ВСЕ поля профиля (фото — только
// новое), а специальности и болезни — целыми наборами. Администратор поправил
// карточку врача, пока у врача был открыт «Мой профиль», — врач меняет одну
// строку биографии, и правка администратора молча откатывается. А экран,
// который не загрузился (запрос к базе отклонён), открывался пустым, и
// «Сохранить» стирало весь профиль.
//
// Окно рисуется на поддельном DOM; база и RPC — подменённый fetch.
// ===========================================================================
class F {
    constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._text = ''; this._l = {}; this.dataset = {}; this.value = ''; }
    appendChild(c) {
        this.children.push(c);
        // Как в браузере: текст внутри <textarea> — её значение; у <select>
        // значение — выбранный (или первый) <option>.
        if (this.tagName === 'TEXTAREA' && c && c.nodeType === 3) this.value += c._text;
        if (this.tagName === 'SELECT' && c && c.tagName === 'OPTION') {
            const first = this.children.filter((x) => x.tagName === 'OPTION').length === 1;
            if (first || c.selected || 'selected' in c.attrs) this.value = c.value;
        }
        return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
    get firstChild() { return this.children[0] || null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    focus() {} blur() {} remove() {} scrollIntoView() {}
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
        Object.defineProperty(el, 'innerHTML', { set() { el.content.firstChild = new F('svg'); }, get() { return ''; } });
    }
    return el;
}
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
globalThis.Node = F;
globalThis.document = {
    createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
    head: mk('head'), body: mk('body'), documentElement: mk('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById: (id) => walk(globalThis.document.body).find((n) => n.attrs && n.attrs.id === id) || null,
};
const lsStore = new Map();
globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); }, clear: () => lsStore.clear(),
};
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
    location: { hostname: 'localhost' }, localStorage, addEventListener() {}, dispatchEvent() {},
    easymed: { state: { user: { id: 7, role: 'doctor', is_doctor: true, company_id: 1 } } },
    CLINIC: { id: 1 },
};

const DOC_ROW = {
    id: 7, full_name: 'Каримов Алишер Бахромович', phone: '+998901112233', specialty: 'Кардиолог',
    license_number: '', doctor_category: '', room_id: null,
    full_name_ru: 'Каримов Алишер Бахромович', full_name_uz: 'Karimov Alisher Baxromovich', full_name_en: 'Karimov Alisher',
    academic_title_ru: 'Кандидат медицинских наук', academic_title_uz: 'Tibbiyot fanlari nomzodi', academic_title_en: 'Candidate of Medical Sciences',
    bio_ru: 'Кардиолог, двенадцать лет практики.', bio_uz: 'Kardiolog, o‘n ikki yillik tajriba.', bio_en: 'Cardiologist, twelve years of practice.',
    education_entries: [{ ru: 'ТашМИ', uz: 'ToshTI', en: 'TashMI', title: 'Лечебное дело', year_from: 1995, year_to: 2001 }],
    experience_entries: [{ ru: 'Клиника «Шифо»', uz: '', en: '', title: 'Кардиолог', year_from: 2013, year_to: null }],
    certifications_entries: [{ ru: 'ЭхоКГ', uz: '', en: '', year: 2020 }],
    prof_dev_entries: [],
    experience_years: 12, instagram_url: 'https://instagram.com/dr.karimov', telegram_url: '',
    photo_url: '/api/storage/doctor-photos/doctors/7/a.jpg',
};
const SPECS = [
    { specialty_slug: 'kardiolog', name_ru: 'Кардиолог', is_primary: 1 },
    { specialty_slug: 'terapevt', name_ru: 'Терапевт', is_primary: 0 },
];
const CONDS = [{ kind: 'disease', slug: 'gipertoniya', name_ru: 'Гипертония', name_uz: 'Gipertoniya' }];

let scenario = { user: DOC_ROW, specs: SPECS, conds: CONDS };
const rpcCalls = [];
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === '/api/db') {
        const desc = JSON.parse(opts.body);
        if (desc.table === 'users') {
            if (scenario.user === 'fail') return reply(400, { error: { message: 'unknown column' } });
            return reply(200, { data: JSON.parse(JSON.stringify(scenario.user)) });
        }
        if (desc.table === 'user_specialties') return reply(200, { data: scenario.specs.map((r) => ({ ...r })) });
        if (desc.table === 'doctor_conditions') return reply(200, { data: scenario.conds.map((r) => ({ ...r })) });
        return reply(200, { data: [] });
    }
    if (u === '/api/rpc/update_my_doctor_profile') {
        const body = JSON.parse(opts.body);
        rpcCalls.push(body);
        return reply(200, { data: { ok: true, saved: Object.keys(body.p || {}), not_stored: [] } });
    }
    return reply(200, { data: [] });
};

const { renderDoctorProfile } = await import('../views/doctor-profile.js');

const byClass = (root, c) => walk(root).filter((n) => String(n.className || '').split(/\s+/).includes(c));
const tagsOf = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const toastText = () => { const t = document.getElementById('toast'); return t ? t.textContent : ''; };

async function openProfile(sc = {}) {
    scenario = { user: DOC_ROW, specs: SPECS, conds: CONDS, ...sc };
    rpcCalls.length = 0;
    document.body.children.length = 0;
    const container = mk('div');
    await renderDoctorProfile(container, 7);
    const saveBtn = byClass(container, 'docprof-save')[0];
    assert.ok(saveBtn, 'нет кнопки «Сохранить профиль»');
    const bio = byClass(container, 'docprof-ta');   // биография RU / UZ / EN
    assert.equal(bio.length, 3, 'три поля биографии');
    return {
        container,
        bio: { ru: bio[0], uz: bio[1], en: bio[2] },
        input: (ph) => tagsOf(container, 'input').find((i) => i.attrs.placeholder === ph),
        save: async () => { await saveBtn.onclick(); },
    };
}

test('CLINIC_API_FIX_V1: изменили только биографию RU — в p только bio_ru, специальности и болезни не уходят', async () => {
    const s = await openProfile();
    s.bio.ru.value = 'Кардиолог, тринадцать лет практики.';
    await s.save();
    assert.equal(rpcCalls.length, 1, 'профиль не ушёл на сервер');
    assert.deepEqual(rpcCalls[0].p, { bio_ru: 'Кардиолог, тринадцать лет практики.' });
    assert.ok(!('specialties' in rpcCalls[0]), 'специальности ушли, хотя их не меняли');
    assert.ok(!('conditions' in rpcCalls[0]), 'болезни ушли, хотя их не меняли');
});

test('CLINIC_API_FIX_V1: ничего не меняли — сервер не зовётся, экран говорит «Нет изменений»', async () => {
    const s = await openProfile();
    await s.save();
    assert.equal(rpcCalls.length, 0, 'без правок ушло: ' + JSON.stringify(rpcCalls[0]));
    assert.equal(toastText(), 'Нет изменений');
});

test('CLINIC_API_FIX_V1: убрали специальность — уходят specialties, поля профиля и болезни нет', async () => {
    const s = await openProfile();
    const chips = byClass(s.container, 'docprof-spec-chip');
    assert.equal(chips.length, 2, 'обе специальности на экране');
    tagsOf(chips[1], 'button')[0].click();
    await s.save();
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(rpcCalls[0].p, {});
    assert.deepEqual(rpcCalls[0].specialties, ['kardiolog']);
    assert.ok(!('conditions' in rpcCalls[0]), 'болезни ушли, хотя их не меняли');
});

test('CLINIC_API_FIX_V1: ФИО по-русски не заполнено (виден старый full_name) — правка другого поля его не пишет', async () => {
    const s = await openProfile({ user: { ...DOC_ROW, full_name_ru: '' } });
    s.bio.uz.value = 'Kardiolog.';
    await s.save();
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(rpcCalls[0].p, { bio_uz: 'Kardiolog.' });
});

test('CLINIC_API_FIX_V1: профиль не загрузился — пустой экран не стирает профиль, правка одного поля шлёт только его', async () => {
    const s = await openProfile({ user: 'fail' });
    await s.save();
    assert.equal(rpcCalls.length, 0, 'пустой экран ушёл на сервер: ' + JSON.stringify(rpcCalls[0]));
    assert.equal(toastText(), 'Нет изменений');
    s.input('https://t.me/…').value = 'https://t.me/dr_karimov';
    await s.save();
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(rpcCalls[0].p, { telegram_url: 'https://t.me/dr_karimov' });
});

test('CLINIC_API_FIX_V1: после сохранения точка отсчёта — сохранённое: повтор без правок не шлёт, новая правка шлёт только себя', async () => {
    const s = await openProfile();
    s.bio.ru.value = 'Новый текст.';
    await s.save();
    assert.equal(rpcCalls.length, 1);
    await s.save();
    assert.equal(rpcCalls.length, 1, 'повторное «Сохранить» без правок снова ушло');
    assert.equal(toastText(), 'Нет изменений');
    s.bio.en.value = 'New text.';
    await s.save();
    assert.equal(rpcCalls.length, 2);
    assert.deepEqual(rpcCalls[1].p, { bio_en: 'New text.' });
});

test('CLINIC_API_FIX_V1: «Нет изменений» переведено', () => {
    const e = STRINGS['Нет изменений'];
    assert.ok(e && e.ru && e.uz && e.en, 'строке «Нет изменений» нужен перевод в i18n-strings.js');
});
