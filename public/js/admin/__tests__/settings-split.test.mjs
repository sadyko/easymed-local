// SETTINGS_SPLIT_V1 (2026-08-29, owner: «in the subcription settings we need
// only left with subscription and modules status (with request). and in the
// system only the version and last updated "wahts new". in the company the
// company info.»).
//
// This file guards the SHAPE of the split — what each screen shows and, just
// as importantly, what it must NOT show. The cards' own behaviour (module
// requests, restore contracts, the reset confirm word) is system-view.test.mjs's
// business and is deliberately not repeated here.
//
// What is nailed down:
//   * «Подписка» renders the subscription state + the modules list with
//     «Запросить», and carries NO backups, NO danger zone, NO update UI;
//   * «Система» renders the version, the offer/approve UI and the what's-new
//     note, and carries NO subscription, NO backups, NO danger zone;
//   * backups and the danger zone are still REACHABLE — «Данные клиники»
//     renders both. This is the assertion that matters most: the owner asked
//     for two screens to be trimmed, not for the clinic's only backup/restore
//     and only data-erase controls to disappear;
//   * «Компания» shows company information and no print-template controls —
//     and its save writes only the company columns, so the print values a
//     clinic once chose stay in the database rather than being reset by a form
//     that no longer displays them;
//   * the retired '#updates/subscription' deep link still lands on the
//     subscription screen, so bookmarks and browser history keep working.
//
// Fake-DOM harness copied from __tests__/system-view.test.mjs (itself from
// updates-view.test.mjs / activation.test.mjs) INCLUDING the localStorage
// 'admin.lang'='ru' pin BEFORE the view imports: i18n.js picks its language
// once at module load, and every Russian assertion below depends on it.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){}
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

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — must stand BEFORE the view imports below.
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = { location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){}, easymed: { state: { user: null } } };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const findAllButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findAllButtons(root).find((b) => re.test(textOf(b)));

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });

// --- fake server ----------------------------------------------------------
// An offer is pending, so the «Система» screen has real approve UI to show;
// the backup listing is non-empty so «Данные клиники» has a real table.
let updateStatus;
let backupListCalls;
// The doc_settings row as a clinic that HAS used the old print controls would
// have it — so the «Компания» assertions below can prove those values survive.
let docSettingsRow;
let lastDocUpdate;

function resetServer() {
  backupListCalls = 0;
  lastDocUpdate = null;
  docSettingsRow = {
    id: 1, clinic_name: 'Нурафшон Мед', address: 'Ташкент, ул. Амира Темура, 12',
    phone: '+998 71 200 12 00', email: 'info@nurafshon.uz', license: 'LIC-77',
    logo_data_url: null, accent_color: '#167873',
    paper_size: 'A5', show_watermark: 1, footer_note: 'Спасибо за визит.', legal_note: 'Электронный документ.',
  };
  updateStatus = {
    current_version: '2.3.0',
    offer: { version: '2.4.0', notes_ru: 'Ускорен список чатов.' },
    approved: false, hour: null, scheduled_at: null, last_result: null,
  };
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/update_status')) return jsonOk(updateStatus);
  if (u.startsWith('/api/rpc/backup_list')) {
    backupListCalls++;
    return jsonOk({ backups: [{ name: 'daily-20260828-030000.db', kind: 'daily', size: 15 * 1024 * 1024, mtimeMs: new Date(2026, 7, 28, 3, 0).getTime() }] });
  }
  if (u === '/api/db') {
    const desc = opts && opts.body ? JSON.parse(opts.body) : {};
    if (desc.op === 'update') {
      lastDocUpdate = desc.values;
      // The server writes only the columns it was given — the whole point of
      // the assertion in the «Компания» test below.
      docSettingsRow = { ...docSettingsRow, ...desc.values };
    }
    return jsonOk(docSettingsRow);
  }
  if (u.startsWith('/api/health')) return jsonOk({ ok: true });
  return jsonOk({});
};

const { renderUpdates } = await import('../views/updates.js');
const { renderSubscription } = await import('../views/subscription.js');
const { renderClinicData } = await import('../views/clinic-data.js');
const { renderDocumentsSettings } = await import('../views/documents-settings.js');
const { setLicence } = await import('../licence.js');

function setUser(u) { globalThis.window.easymed.state.user = u; }
const ADMIN = { id: 1, role: 'admin', is_admin: true, is_super_admin: false };

// One module owned, one not — so the modules list has both a «Подключён» row
// and a «Запросить» button to find.
const LIC = {
  state: 'ok', locked: false, reason: null, days_left: 22, modules: ['crm'],
  clinic_name: 'Нурафшон Мед', clinic_id: 'c-000051',
  valid_until: new Date(2026, 8, 12).toISOString(), last_checkin: new Date(2026, 7, 28, 9, 0).toISOString(),
};

test.beforeEach(() => {
  resetServer();
  setUser(ADMIN);
  setLicence(LIC);
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');
  document.body.children.length = 0;
});

// --- «Подписка» --------------------------------------------------------------

test('«Подписка»: состояние подписки и модули с «Запросить» — и НИЧЕГО больше', async () => {
  const root = mk('div');
  await renderSubscription(root);
  const text = textOf(root);

  // Owner's list, item by item.
  assert.match(text, /Подписка/, 'заголовок экрана');
  assert.match(text, /Нурафшон Мед/, 'клиника');
  assert.match(text, /c-000051/, 'ID клиники');
  assert.match(text, /Подписка активна/, 'статус');
  assert.match(text, /12\.09\.2026 — осталось 22 дн\./, 'срок действия и сколько осталось');
  assert.match(text, /28\.08\.2026 09:00/, 'последняя связь');
  assert.match(text, /Модули/, 'список модулей');
  assert.match(text, /Подключён/, 'подключённый модуль виден как подключённый');
  assert.ok(findButtonByText(root, /Запросить/), 'у неподключённого модуля есть «Запросить»');

  // And nothing that belongs to the other two screens.
  assert.doesNotMatch(text, /Резервные копии/, 'копии здесь не место — они в «Данных клиники»');
  assert.doesNotMatch(text, /Опасная зона/, 'опасной зоны здесь нет');
  assert.doesNotMatch(text, /Доступно обновление/, 'предложения обновления здесь нет');
  assert.doesNotMatch(text, /Текущая версия/, 'версии здесь нет — это «Система»');
  assert.strictEqual(backupListCalls, 0, 'экран подписки не должен даже спрашивать список копий');
});

// --- «Система» ---------------------------------------------------------------

test('«Система»: версия, экран подтверждения обновления и «что нового» — и НИЧЕГО больше', async () => {
  // Версия сменилась с той, что этот браузер видел в прошлый раз → «что нового».
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.2.0');
  fakeLocalStorage.setItem('em.updates.notesCache', JSON.stringify({ '2.3.0': 'Починена печать направлений.' }));

  const root = mk('div');
  await renderUpdates(root);
  const text = textOf(root);

  assert.match(text, /Система/, 'заголовок экрана');
  assert.match(text, /Текущая версия/, 'текущая версия названа');
  assert.match(text, /2\.3\.0/, 'и её номер тоже');
  assert.match(text, /Что нового в версии 2\.3\.0/, '«что нового» по последнему обновлению');
  assert.match(text, /Починена печать направлений\./, 'с текстом заметок, а не пустой рамкой');
  assert.match(text, /Доступно обновление/, 'предложение обновиться — ради него экран и существует');
  assert.ok(findButtonByText(root, /Обновить сейчас/), 'кнопка подтверждения установки на месте');

  assert.doesNotMatch(text, /Активация и подписка/, 'подписка уехала на свой экран');
  assert.doesNotMatch(text, /Модули/, 'список модулей — тоже');
  assert.doesNotMatch(text, /Резервные копии/, 'копии уехали в «Данные клиники»');
  assert.doesNotMatch(text, /Опасная зона/, 'опасная зона — туда же');
  assert.strictEqual(backupListCalls, 0, 'экран обновлений больше не читает список копий');
});

// --- копии и опасная зона не потерялись ---------------------------------------

test('копии и опасная зона по-прежнему достижимы — обе на «Данных клиники»', async () => {
  const root = mk('div');
  await renderClinicData(root);
  const text = textOf(root);

  assert.match(text, /Данные клиники/, 'заголовок экрана');
  assert.match(text, /Резервные копии/, 'карточка копий');
  assert.ok(findButtonByText(root, /Создать копию сейчас/), 'создать копию можно');
  assert.ok(findButtonByText(root, /Восстановить/), 'восстановить из копии можно');
  assert.strictEqual(backupListCalls, 1, 'список копий действительно запрошен');
  assert.match(text, /Опасная зона/, 'карточка удаления данных');
  assert.ok(findButtonByText(root, /Удалить все данные клиники/), 'удалить данные можно');

  assert.doesNotMatch(text, /Активация и подписка/, 'подписки здесь нет');
  assert.doesNotMatch(text, /Текущая версия/, 'версии здесь нет');
});

// --- «Компания» ---------------------------------------------------------------

test('«Компания»: только сведения о клинике — настроек печатного шаблона на экране нет', async () => {
  const root = mk('div');
  await renderDocumentsSettings(root, { onNavigate: () => {} });
  const text = textOf(root);

  assert.match(text, /Компания/, 'заголовок совпадает с плиткой, а не «Documents»');
  for (const label of ['Название клиники', 'Адрес', 'Телефон', 'Электронная почта', 'Номер лицензии', 'Фирменный цвет', 'Логотип']) {
    assert.ok(text.includes(label), 'поле «' + label + '» должно быть на экране');
  }
  assert.match(text, /Нурафшон Мед/, 'значения из doc_settings подставлены, а не заглушки');

  // Проверяем ОТСУТСТВИЕ элементов управления, а не слов: подсказка внизу
  // экрана нарочно называет размер бумаги и водяной знак, чтобы админ знал,
  // куда они переехали.
  const nodes = walk(root);
  assert.strictEqual(nodes.filter((n) => n.tagName === 'SELECT').length, 0, 'выбор размера бумаги — настройка шаблона, ей здесь не место');
  assert.strictEqual(nodes.filter((n) => n.tagName === 'TEXTAREA').length, 0, 'колонтитул и юридическая сноска — тоже настройки шаблона');
  assert.strictEqual(nodes.filter((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox').length, 0, 'галочки водяного знака больше нет');
  assert.doesNotMatch(text, /Medical Certificate|Patient:/, 'предпросмотр перестал изображать печатный бланк');
  assert.match(text, /настраиваются в разделе «Документы»/, 'сказано, куда они переехали');
});

test('«Компания»: сохранение шлёт ТОЛЬКО свои колонки — настройки печати в базе не затираются', async () => {
  const root = mk('div');
  await renderDocumentsSettings(root, { onNavigate: () => {} });

  findButtonByText(root, /Сохранить/).click();
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(lastDocUpdate, 'запрос на обновление ушёл');
  assert.deepStrictEqual(Object.keys(lastDocUpdate).sort(),
    ['accent_color', 'address', 'clinic_name', 'email', 'license', 'logo_data_url', 'phone'],
    'ровно семь колонок компании — и ни одной колонки печатного шаблона');
  // Именно это и есть «не удалили, а перестали редактировать»: клиника,
  // однажды выбравшая A5 и водяной знак, сохраняет их после правки названия.
  assert.strictEqual(docSettingsRow.paper_size, 'A5', 'размер бумаги в базе не тронут');
  assert.strictEqual(docSettingsRow.show_watermark, 1, 'водяной знак в базе не тронут');
  assert.strictEqual(docSettingsRow.footer_note, 'Спасибо за визит.', 'колонтитул в базе не тронут');
  assert.strictEqual(docSettingsRow.legal_note, 'Электронный документ.', 'юридическая сноска в базе не тронута');
});

// --- старая ссылка ------------------------------------------------------------

test('старая ссылка #updates/subscription приводит на подписку, а не на «Систему»', async () => {
  const labelCalls = [];
  globalThis.window.easymedSetTabLabel = (tabId, label) => labelCalls.push([tabId, label]);

  const root = mk('div');
  await renderUpdates(root, { payload: { sub: 'subscription' }, tabId: 'updates' });
  const text = textOf(root);

  assert.match(text, /Активация и подписка/, 'карточка подписки отрисована');
  assert.match(text, /Нурафшон Мед/, 'с данными лицензии');
  assert.doesNotMatch(text, /Текущая версия/, 'экран обновлений при этом НЕ отрисован');
  assert.doesNotMatch(text, /Резервные копии/, 'и копии тоже нет');
  // Одна карточка, а не две: экран подписки импортирует ту же самую, а не копию.
  assert.strictEqual(text.split('Активация и подписка').length - 1, 1, 'карточка ровно одна');
  assert.deepStrictEqual(labelCalls, [['updates', 'Подписка']],
    'вкладка переименована — иначе полоса вкладок сказала бы «Система» над экраном подписки');

  delete globalThis.window.easymedSetTabLabel;
});

test('старая ссылка работает и без моста переименования вкладок (прямой вызов, старый admin.js)', async () => {
  // Мост — косметика. Его отсутствие не должно мешать экрану открыться.
  assert.strictEqual(globalThis.window.easymedSetTabLabel, undefined, 'моста нет');
  const root = mk('div');
  await renderUpdates(root, { payload: { sub: 'subscription' } });
  assert.match(textOf(root), /Активация и подписка/);
});
