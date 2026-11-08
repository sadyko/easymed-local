// REFERRAL_SOURCE_FORM_V2 + REFERRAL_SERVICE_RATES_V1 (2026-11-07) — карточка
// источника направления по словам владельца: «Surname, Name, Middle Name, then
// phone, speciality, region, place of work, then type of payment (cash — no
// card number, card — card number), then category (not internal employee)…
// give me possibility to provide more % for some services».
//
// Что закреплено:
//   * порядок полей на экране — порядок владельца, разделами;
//   * поля «Номер» в форме нет (номер — триггер базы, мигр. 121), но он в
//     заголовке окна правки;
//   * «Номер карты» виден и обязателен только при «На карту», при другом
//     типе beforeSave стирает прежний номер;
//   * «Категория» — без внутренней (is_internal);
//   * особые ставки по услугам: таблица рисует, добавляет, убирает и отдаёт
//     ровно то, что показано; чужую запись не теряет.
//
// Fake-DOM harness — из __tests__/settings-hub-groups.test.mjs, включая
// 'admin.lang'='ru' ДО импорта вида (i18n.js выбирает язык один раз).
import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}   // REFERRAL_RATE_CAP_V1 — граница поля процента снимается у суммы
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
localStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта видов
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener(){},
  easymed: { state: { user: { id: 'u-1', full_name: 'Администратор', role: 'admin', is_super_admin: true } } },
  CLINIC: { id: 1 },
  confirm: () => true,
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byClass = (root, cls) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(cls));

const OWNER_ORDER = ['last_name', 'first_name', 'middle_name', 'phone', 'specialty', 'district', 'workplace',
                     'payment_type', 'card_number', 'category_id', 'representative_id'];

test('карточка источника: разделы в порядке владельца, «Номера» в форме нет, он в заголовке правки', async () => {
  const { lookupConfig } = await import('../views/settings-hub.js');
  const cfg = lookupConfig('referral_sources');
  const keys = cfg.fields.map((f) => f.key);
  assert.ok(!keys.includes('code'), 'поле «Номер» убрано из формы: номер присваивает триггер');
  assert.ok(cfg.columns.some((c) => c.key === 'code'), 'в СПИСКЕ колонка «Номер» осталась');
  const shown = cfg.groups.flatMap((g) => g.fields);
  assert.deepStrictEqual(shown.slice(0, OWNER_ORDER.length), OWNER_ORDER, 'порядок полей на экране — порядок владельца');
  assert.deepStrictEqual(shown.slice(OWNER_ORDER.length),
    ['reward_mode', 'own_percent', 'own_rates', 'service_rates', 'inpatient_bonus_enabled', 'inpatient_pct', 'inpatient_fixed'],
    'вознаграждение — последним разделом, особые ставки между своими ставками и стационаром');
  for (const k of keys) assert.ok(shown.includes(k), 'поле «' + k + '» названо в каком-то разделе');
  for (const k of shown) assert.ok(keys.includes(k), 'раздел не ссылается на несуществующее поле «' + k + '»');
  assert.deepStrictEqual(cfg.groups.map((g) => g.title),
    ['Кто направляет', 'Выплата вознаграждения', 'Категория и представитель', 'Вознаграждение за направления']);
  assert.equal(cfg.groups[0].cols, '1fr 1fr 1fr', 'ФИО — в одну строку');
  assert.equal(cfg.fields.find((f) => f.key === 'workplace').full, true, 'место работы — во всю ширину');
  assert.equal(cfg.editTitle({ code: '0012' }), 'Источник направления № 0012');
  assert.equal(cfg.editTitle({}), 'Источник направления');
  assert.equal(cfg.addTitle, 'Новый источник направления');
  assert.equal(cfg.modalCols, undefined, 'общая сетка заменена разделами');
});

test('карточка источника: номер карты — только при «На карту», и тогда обязателен; иначе стирается', async () => {
  const { lookupConfig } = await import('../views/settings-hub.js');
  const cfg = lookupConfig('referral_sources');
  const card = cfg.fields.find((f) => f.key === 'card_number');
  assert.equal(card.visibleWhen({ payment_type: 'card' }), true);
  assert.equal(card.visibleWhen({ payment_type: 'cash' }), false);
  assert.equal(card.visibleWhen({ payment_type: '' }), false);
  assert.equal(card.requiredWhen({ payment_type: 'card' }), true);
  assert.equal(card.requiredWhen({ payment_type: 'transfer' }), false);
  const pay = cfg.fields.find((f) => f.key === 'payment_type');
  assert.deepStrictEqual(pay.options.map(([v]) => v), ['cash', 'card', 'transfer'], 'варианты типа оплаты не менялись');

  // beforeSave: тип не «карта» — прежний номер стирается (на правке — null,
  // на вставке колонка просто не уходит); «карта» — номер остаётся.
  const edit = { first_name: 'Анвар', payment_type: 'cash', card_number: '8600 1234' };
  assert.equal(cfg.beforeSave(edit, { isEdit: true, row: { name: 'Анвар' } }), undefined);
  assert.strictEqual(edit.card_number, null);
  const ins = { first_name: 'Анвар', payment_type: 'cash', card_number: '8600 1234' };
  cfg.beforeSave(ins, { isEdit: false });
  assert.ok(!('card_number' in ins));
  const keep = { first_name: 'Анвар', payment_type: 'card', card_number: '8600 1234' };
  cfg.beforeSave(keep, { isEdit: true, row: {} });
  assert.equal(keep.card_number, '8600 1234');
  assert.equal(keep.name, 'Анвар', 'ФИО по-прежнему собирается в name');
});

// REFERRAL_FORM_NO_MONEY_EDIT_V1 (3.22.0, ревью) — роль с «Список источников: Изменение»
// без «Цен и процентов» видит в окне только колонки без денег (grantColumns плитки):
// «Тип оплаты» ей не показан и в запись не уходит. beforeSave всё равно ставил
// card_number = null («тип не карта»), и сервер отвечал 403 «Поле card_number меняет
// только администратор.» — такая роль не могла сохранить НИ ОДНОЙ правки источника.
// Номер карты стирается только тогда, когда тип оплаты действительно прислан.
test('карточка источника: правка без «Цен и процентов» — без номера карты в записи, и сервер её принимает', async () => {
  const { lookupConfig } = await import('../views/settings-hub.js');
  const { catalogByKey } = await import('../../shared/permission-catalog.js');
  const { openDb } = await import('../../../../server/db/connection.js');
  const { migrate } = await import('../../../../server/db/migrate.js');
  const { compile } = await import('../../../../server/db/query-compiler.js');
  const cfg = lookupConfig('referral_sources');
  const grantCols = catalogByKey().get('settings.referral_sources').grantColumns.referral_sources;

  const db = openDb(':memory:');
  migrate(db);
  try {
    const grant = (grants) => {
      const r = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get('registrar');
      const p = r ? JSON.parse(r.permissions) : { sections: [], levels: {} };
      p.grants = { ...(p.grants || {}), ...grants };
      if (r) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), 'registrar');
      else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('registrar', JSON.stringify(p));
    };
    grant({ settings: 'view', 'settings.referral_sources': 'edit' });
    const id = Number(db.prepare("INSERT INTO referral_sources (name, first_name, payment_type, card_number) VALUES ('Партнёр', 'Партнёр', 'card', '8600 1234')").run().lastInsertRowid);
    const row = db.prepare('SELECT * FROM referral_sources WHERE id = ?').get(id);
    const REG = { id: 51, role: 'registrar', extra_roles: [] };
    const update = (values) => compile({ table: 'referral_sources', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] }, REG, { db });

    // Что собирает окно этой роли: поля плитки без денег (как renderEditor с grantCols), «Активен» правки.
    const fields = cfg.fields.filter((f) => grantCols.includes(f.key) && !f.saveVia && f.type !== 'readonly');
    assert.ok(!fields.some((f) => f.key === 'payment_type' || f.key === 'card_number'), 'денежных полей в окне нет');
    const payload = { active: 1 };
    for (const f of fields) if (row[f.key] != null && row[f.key] !== '') payload[f.key] = row[f.key];
    payload.phone = '+998901112233';
    assert.equal(cfg.beforeSave(payload, { isEdit: true, row }), undefined);
    assert.ok(!('card_number' in payload), 'номер карты роли без денег не трогается');
    assert.doesNotThrow(() => update(payload), 'правка роли с «Изменением» проходит');

    // С «Ценами и процентами» тип оплаты в окне есть: сменили на наличные — номер стирается, сервер принимает.
    grant({ 'settings.referral_sources.money': 'edit' });
    const money = { ...payload, payment_type: 'cash', card_number: '8600 1234' };
    cfg.beforeSave(money, { isEdit: true, row });
    assert.strictEqual(money.card_number, null);
    assert.doesNotThrow(() => update(money));
  } finally { db.close(); }
});

test('карточка источника: категория — только внешняя (is_internal = 0)', async () => {
  const { lookupConfig } = await import('../views/settings-hub.js');
  const cat = lookupConfig('referral_sources').fields.find((f) => f.key === 'category_id');
  assert.equal(cat.type, 'fk');
  assert.equal(cat.fkTable, 'referral_source_categories');
  assert.deepStrictEqual(cat.fkFilter, { is_internal: 0 });
});

test('modalGroups: раздел на группу, пустой раздел не рисуется, неназванные поля и «Активен» — хвостом', async () => {
  const { modalGroups } = await import('../views/settings-hub.js');
  const fields = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  const els = fields.map((f) => { const d = mk('div'); d._t = 'поле ' + f.key; return d; });
  const tail = mk('div'); tail._t = 'Активен';
  const body = modalGroups({ groups: [
    { title: 'Первый', cols: '1fr 1fr 1fr', fields: ['a', 'zzz'] },
    { title: 'Пустой', fields: ['zzz'] },
  ] }, fields, els, tail);
  const sections = byClass(body, 'mg-section');
  assert.equal(sections.length, 2, 'раздел «Первый» и хвост; «Пустой» не рисуется');
  assert.ok(textOf(sections[0]).includes('Первый') && textOf(sections[0]).includes('поле a'));
  assert.ok(!textOf(body).includes('Пустой'));
  const grid0 = byClass(sections[0], 'mg-grid')[0];
  assert.equal(grid0.style.gridTemplateColumns, '1fr 1fr 1fr');
  const tailText = textOf(sections[1]);
  assert.ok(tailText.includes('поле b') && tailText.includes('поле c') && tailText.includes('Активен'));
});

test('особые ставки по услугам: рисует, добавляет по выбору, убирает, отдаёт показанное; чужую запись не теряет', async () => {
  const { serviceRatesControl } = await import('../views/settings-hub.js');
  const foreign = { group: 'lab', unit: 'pct', value: 4 };   // не про услугу — переносится как была
  const ctl = serviceRatesControl(JSON.stringify([
    { service_id: 2, unit: 'fix', value: 70000 }, { service_id: 99, unit: 'pct', value: 5 }, foreign,
  ]), 'подсказка');
  await ctl.load({ services: [{ id: 1, name: 'Приём', type: 'consultation' }, { id: 2, name: 'УЗИ', type: 'imaging' }] });

  const text = textOf(ctl);
  assert.ok(text.includes('УЗИ') && text.includes('Диагностика'), 'услуга и её группа подписаны');
  assert.ok(text.includes('Услуга № 99 (не найдена)'), 'услуги нет в справочнике — сказано, а не спрятано');
  assert.ok(text.includes('подсказка'));
  assert.deepStrictEqual(ctl.value, [foreign,
    { service_id: 2, unit: 'fix', value: 70000 }, { service_id: 99, unit: 'pct', value: 5 }]);

  // Выбор услуги в списке сразу добавляет строку; пустая ставка — записи нет.
  const pick = walk(ctl).find((n) => n.tagName === 'SELECT' && 'data-service-pick' in n.attrs);
  assert.ok(pick, 'список услуг на месте');
  pick.options = pick.children;
  pick.value = '1';
  pick.dispatchEvent({ type: 'change' });
  assert.equal(pick.value, '', 'список очищен под следующий выбор');
  assert.ok(textOf(ctl).includes('Приём'));
  assert.equal(ctl.value.length, 3, 'строка без ставки ещё не запись');
  const inp = walk(ctl).find((n) => n.tagName === 'INPUT' && n.attrs['data-rate-service'] === '1');
  inp.value = '15';
  assert.ok(ctl.value.some((e) => e.service_id === 1 && e.unit === 'pct' && e.value === 15));

  // Та же услуга второй раз — не дублируется.
  pick.value = '1';
  pick.dispatchEvent({ type: 'change' });
  assert.equal(ctl.value.filter((e) => e.service_id === 1).length, 1);

  // «Убрать» снимает строку — и запись.
  const rm = walk(ctl).find((n) => n.tagName === 'BUTTON' && n.attrs['data-rate-remove'] === '2');
  rm.click();
  assert.ok(!ctl.value.some((e) => e.service_id === 2));
  // Таблица разбирала JSON, поэтому сравнение — по содержимому, не по ссылке.
  assert.ok(ctl.value.some((e) => e.group === 'lab' && e.unit === 'pct' && e.value === 4), 'чужая запись по-прежнему на месте');

  // Отрицательная или нечисловая ставка — не запись.
  inp.value = '-3';
  assert.ok(!ctl.value.some((e) => e.service_id === 1));
});

// REFERRAL_RATE_CAP_V1 (3.22.0, ревью) — процент — от 0 до 100, сумма — не меньше нуля:
// таблица называет ошибку (`problem`), и «Сохранить» её не пропускает (то же правило,
// что у сервера — shared/referral-reward.js serviceRatesProblem).
test('особые ставки по услугам: процент больше 100 и отрицательная ставка — ошибка формы, а не молчаливый пропуск', async () => {
  const { serviceRatesControl } = await import('../views/settings-hub.js');
  const ctl = serviceRatesControl(JSON.stringify([{ service_id: 2, unit: 'pct', value: 25 }]), '');
  await ctl.load({ services: [{ id: 2, name: 'УЗИ', type: 'imaging' }] });
  assert.equal(ctl.problem, null);
  const inp = walk(ctl).find((n) => n.tagName === 'INPUT' && n.attrs['data-rate-service'] === '2');
  const unit = walk(ctl).find((n) => n.tagName === 'SELECT' && n.attrs['data-rate-unit-service'] === '2');
  assert.equal(inp.attrs.max, '100', 'у процента — верхняя граница поля');
  inp.value = '250';
  assert.equal(ctl.problem, 'Особая ставка в процентах — от 0 до 100.');
  inp.value = '100';
  assert.equal(ctl.problem, null);
  inp.value = '-3';
  assert.equal(ctl.problem, 'Особая ставка в процентах — от 0 до 100.');
  unit.value = 'fix';
  unit.dispatchEvent({ type: 'change' });
  assert.equal(ctl.problem, 'Особая ставка суммой не может быть меньше нуля.');
  assert.equal(inp.attrs.max, undefined, 'у суммы верхней границы нет');
  inp.value = '250000';
  assert.equal(ctl.problem, null, 'сумма больше 100 — не ошибка');
  inp.value = '';
  assert.equal(ctl.problem, null, 'пустая ставка — записи нет, ошибки нет');

  // «Сохранить» окна справочника спрашивает таблицу до записи (как обязательные поля).
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../views/settings-hub.js', import.meta.url), 'utf8');
  const save = src.slice(src.indexOf('async function save()'), src.indexOf('saveBtn.disabled = true;', src.indexOf('async function save()')));
  assert.match(save, /controls\[f\.key\]\.problem/, 'save() проверяет ошибку таблицы особых ставок');
});

test('особые ставки по услугам: без строк — так и сказано; испорченный JSON — пусто, а не падение', async () => {
  const { serviceRatesControl } = await import('../views/settings-hub.js');
  const ctl = serviceRatesControl('{oops', '');
  await ctl.load({ services: [] });
  assert.ok(textOf(ctl).includes('Особых ставок нет'));
  assert.deepStrictEqual(ctl.value, []);
});

// REFERRAL_SPECIALTY_SELECT_V1 (владелец, 2026-11-07: «speciality should be dropdown») —
// «Специальность» врача-источника — список «Сотрудников», а не свободный текст;
// старая запись «не из списка» не теряется, прежнее написание («ЛОР») выбирает пункт списка.
test('REFERRAL_SPECIALTY_SELECT_V1: «Специальность» — выпадающий список общего справочника', async () => {
  const { lookupConfig } = await import('../views/settings-hub.js');
  const f = lookupConfig('referral_sources').fields.find((x) => x.key === 'specialty');
  assert.strictEqual(f.type, 'select');
  const vals = (row) => f.options(row).map(([v]) => v);
  assert.ok(vals(null).includes('Акушер-гинеколог'), 'пункты общего списка');
  assert.ok(!vals(null).includes(''), 'пустой пункт ставит сам выпадающий список («—»), второго нет');
  assert.ok(vals({ specialty: 'Иглорефлексотерапевт-самоучка' }).includes('Иглорефлексотерапевт-самоучка'), 'старое значение не из списка остаётся пунктом');
  assert.strictEqual(f.canon('ЛОР'), 'Отоларинголог (ЛОР)', 'прежнее написание выбирает пункт списка');
});
