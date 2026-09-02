// BRANCH_IDENTITY_V1 — что карточка «Синхронизация филиалов» РИСУЕТ, а не что
// она решает. Решения проверяет branch-sync-logic.test.mjs (чистые функции, без
// DOM); здесь проверяется провод между решением и экраном, потому что именно
// провод и был оборван: becomeMainState существовать могла бы и раньше — блок
// «Этот филиал — главный» всё равно рисовался безусловно.
//
// ОДНО СВОЙСТВО НА ВЕСЬ ФАЙЛ: кнопка «Сделать главным филиалом» есть ровно там,
// где сервер её примет. Установке, которая уже является филиалом (буква принята
// и отменить её нельзя), и установке, которая не смогла прочитать свою
// служебную запись, branch_sync_make_key отказывает ВСЕГДА — а кнопка, которую
// показали и которая всегда отказывает, хуже отсутствующей: владелец нажимает,
// читает отказ и идёт искать свою ошибку там, где её нет.
//
// Fake-DOM harness — тот же, что в __tests__/settings-hub-groups.test.mjs
// (оттуда же и пин localStorage 'admin.lang'='ru' ДО импорта экрана: i18n.js
// выбирает язык один раз, при загрузке модуля, и все русские утверждения ниже
// держатся на этом).

import { test } from 'node:test';
import assert from 'node:assert';
import {
  KEY_REISSUE_WARNING, KEY_LOSS_WARNING, LETTER_PERMANENCE_WARNING,
  UNLINK_WARNING_MAIN, RELAY_ACCESS_ISSUED,
} from '../branch-sync-logic.js';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
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
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage, addEventListener() {},
  easymed: { state: { user: { id: 'u-1', full_name: 'Администратор', role: 'admin' } } },
  CLINIC: { id: 1 },
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');

// В состоянии «не связаны» эта карточка делает ровно один вызов: список
// филиалов грузится только у главного. branches остаётся null для тех трёх
// тестов, и попытка его позвать там по-прежнему взрывается.
let status = null;
let branches = null;
const calls = [];
globalThis.fetch = async (url) => {
  const name = String(url).replace('/api/rpc/', '');
  calls.push(name);
  if (name === 'branch_sync_status') return { ok: true, json: async () => ({ data: status }) };
  if (name === 'branch_sync_branches' && branches) return { ok: true, json: async () => ({ data: branches }) };
  throw new Error('экран не должен звать ' + name + ' в этом состоянии');
};

// BRANCH_LIST_V2 — окно подтверждения теперь ЕДИНСТВЕННЫЙ адрес всего
// необратимого на этом экране, поэтому тест его записывает.
let confirms = [];
let confirmAnswer = true;
globalThis.window.confirm = (text) => { confirms.push(String(text)); return confirmAnswer; };
// navigator в Node 24 — геттер без сеттера: присвоение бросает.
const copied = [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (v) => { copied.push(String(v)); } } },
});

const { renderBranchSyncCard } = await import('../views/branch-sync.js');

/** Список догружается без await — даём микрозадачам дойти. */
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }

let card = null;
async function paint(st, br = null) {
  status = st;
  branches = br;
  calls.length = 0;
  confirms = [];
  confirmAnswer = true;
  const container = mk('div');
  await renderBranchSyncCard(container);
  await flush();
  card = container;
  return textOf(container);
}

const all = (root) => walk(root);
const tags = (root, tag) => all(root).filter((n) => n.tagName === String(tag).toUpperCase());
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));

const BUTTON = 'Сделать главным филиалом';
const PAIR = 'Подключить к главному';

test('новой установке кнопку «сделать главным» показывают', async () => {
  // Обычный случай, ради которого блок и существует: миграция 080 ставит
  // identity_role = 'main', пары ещё нет.
  const text = await paint({ role: 'none', identity_role: 'main', letter: 'A', suggested_url: '10.0.0.5:8000' });
  assert.ok(text.includes(BUTTON), 'кнопка обязана быть: сервер её примет');
  assert.ok(text.includes('Адрес этого компьютера'), 'поле адреса живёт вместе с кнопкой');
  assert.ok(text.includes(PAIR));
});

test('ОТВЯЗАННОМУ ФИЛИАЛУ КНОПКИ НЕТ — сервер откажет ей всегда', async () => {
  // «Отвязать» стирает файл пары и НЕ трогает принятую букву: она напечатана на
  // карточках пациентов. Установка выглядит несвязанной (role: 'none') и при
  // этом навсегда остаётся филиалом C, а branch_sync_make_key отвечает ей
  // identity_is_branch — сколько бы раз её ни нажали.
  const text = await paint({ role: 'none', identity_role: 'secondary', letter: 'C', suggested_url: '10.0.0.5:8000' });
  assert.ok(!text.includes(BUTTON), 'кнопки, которая всегда отказывает, на экране быть не должно');
  assert.ok(!text.includes('Адрес этого компьютера'), 'поле адреса существует ради этой кнопки');
  assert.ok(text.includes('Эта установка — филиал'), 'вместо кнопки — объяснение');
  assert.ok(text.includes('C-26-00042'), 'и буква объяснена номером, который видит регистратура');
  // ЛЕКАРСТВО ОСТАЁТСЯ НА ЭКРАНЕ: связаться заново ключом с той же буквой —
  // единственное, что этой установке доступно.
  assert.ok(text.includes(PAIR));
});

test('установке, потерявшей служебную запись, кнопки тоже нет, и сказано почему', async () => {
  // identity_role: null — статус не смог прочитать branch_identity (строку
  // удалили, база повреждена). Сервер в этом состоянии отказывает кодом
  // identity_missing, поэтому кнопки нет и здесь; но состояние ОТДЕЛЬНОЕ, а не
  // «филиал»: филиалу помогает ключ подключения, а тут — только восстановление
  // базы, и фраза обязана вести туда.
  const text = await paint({ role: 'none', identity_role: null, letter: null, suggested_url: '10.0.0.5:8000' });
  assert.ok(!text.includes(BUTTON));
  assert.ok(text.includes('Установка не знает своего филиала'));
  assert.match(text, /Восстановите базу из резервной копии/);
  assert.match(text, /регистрировать пациентов/, 'та же запись держит и регистратуру');
  assert.ok(!text.includes('Эта установка — филиал'), 'это не филиал — это неизвестность');
  // Ключ БЕЗ буквы базу не трогает и связывает как прежде, так что блок
  // подключения здесь мёртвой кнопкой не становится и остаётся на экране.
  assert.ok(text.includes(PAIR));
});

// ===========================================================================
// BRANCH_LIST_V2 (2026-08-30) — ЖАЛОБА ВЛАДЕЛЬЦА, ПЕРЕВЕДЁННАЯ В ТЕСТЫ.
//
// Дословно: «can we remove the unnecessary information and make clear list of
// main branch, and and the list of branches keys etc, all the sloppy text that
// no one will read is unnecessary». На экране главного филиала стояло около
// пятнадцати строк прозы вокруг шести кнопок: абзац под ключом, абзац под
// полем названия, три строки под строкой филиала без резервного канала, два
// абзаца у резервного канала, абзац у перевыпуска, абзац у отвязки.
//
// Здесь проверяются ДВА свойства, и второе важнее первого:
//   1. на экране больше нет стоячей прозы;
//   2. ни одно предупреждение при этом не выброшено — каждое встречает то
//      нажатие, которое делает его правдой.
// Без второго первое тривиально достигается удалением, а удалить
// предупреждение о безвозвратно потраченной букве нельзя.
// ===========================================================================


const MAIN_STATUS = {
  role: 'main', identity_role: 'main', main_url: '10.0.0.5:8000', group_id: 'grp-1',
  relay_ready: true, relay_enabled: true, sync_key_present: true,
  sync_key_created_at: '2026-08-12T10:00:00Z',
};
const MAIN_BRANCHES = {
  ok: true, role: 'main', can_issue: true, can_relay: true,
  branches: [
    { id: 1, name: 'Головной офис', letter: 'A', key: null, is_self: true },
    { id: 2, name: 'Чиланзар', letter: 'B', key: 'EMB2-BBBB-2222', has_relay_token: true },
    { id: 3, name: 'Юнусабад', letter: 'C', key: 'EMB2-CCCC-3333', has_relay_token: false },
    { id: 4, name: 'Старый', letter: null, key: null },
  ],
};

test('филиалы показаны СПИСКОМ: имя · буква · ключ · действие, все разом', async () => {
  // Требование владельца — «make clear list of main branch, and the list of
  // branches keys etc». Прежняя колода карточек с абзацем под каждой
  // показывала два филиала на экран.
  await paint(MAIN_STATUS, MAIN_BRANCHES);
  const table = tags(card, 'table')[0];
  assert.ok(table, 'филиалы обязаны быть таблицей, а не колодой карточек');
  const head = textOf(tags(table, 'thead')[0]);
  for (const col of ['Филиал', 'Буква', 'Ключ подключения', 'Действие']) {
    assert.ok(head.includes(col), `в шапке нет колонки «${col}»`);
  }
  // Четыре филиала — четыре строки, и ни одной лишней.
  const rows = tags(tags(table, 'tbody')[0], 'tr');
  assert.equal(rows.length, 4, 'каждый филиал — ровно одна строка');

  // Ключи читаются целиком и в любой момент, без «показать один раз».
  const values = tags(table, 'input').map((i) => i.value);
  assert.ok(values.includes('EMB2-BBBB-2222'), 'ключ филиала должен лежать в строке целиком');
  assert.ok(values.includes('EMB2-CCCC-3333'));
  // Каждое поле ключа названо ИМЕНЕМ СВОЕГО ФИЛИАЛА: «Ключ подключения» пять
  // раз подряд не различает для программы чтения с экрана ничего.
  const labels = tags(table, 'input').map((i) => i.getAttribute('aria-label') || '');
  assert.ok(labels.some((l) => l.includes('Чиланзар')), 'aria-label обязан называть филиал');
  assert.ok(labels.every((l) => l.trim()), 'поле ключа без имени — поле без подписи');
});

test('ГЛАВНЫЙ ФИЛИАЛ ПОМЕЧЕН КАК ЭТА УСТАНОВКА и ключа не имеет', async () => {
  await paint(MAIN_STATUS, MAIN_BRANCHES);
  const table = tags(card, 'table')[0];
  const [selfRow, otherRow] = tags(tags(table, 'tbody')[0], 'tr');

  assert.ok(textOf(selfRow).includes('Головной офис'));
  assert.ok(textOf(selfRow).includes('Эта установка'), 'строка этой установки обязана называть себя');
  assert.equal(tags(selfRow, 'input').length, 0, 'подключать установку к самой себе не к чему — ключа нет');
  assert.equal(tags(selfRow, 'button').length, 0, 'и делать с ней на этом экране нечего');
  // И она ОТЛИЧАЕТСЯ ВИДОМ, а не только словами: класс строки несёт подложку
  // и полосу слева (admin-views.css .bsync-tr-self).
  assert.ok(selfRow.classList.contains('bsync-tr-self'), 'эта установка обязана быть видна с одного взгляда');
  assert.equal(otherRow.classList.contains('bsync-tr-self'), false, 'метка ровно одна на список');
});

test('состояния строк — короткие слова и метки, а не абзацы', async () => {
  await paint(MAIN_STATUS, MAIN_BRANCHES);
  const rows = tags(tags(tags(card, 'table')[0], 'tbody')[0], 'tr');
  const [, , noRelay, noLetter] = rows;

  // Было три строки объяснения; стало восемь слов и кнопка.
  assert.ok(textOf(noRelay).includes('Без резервного канала'));
  assert.ok(buttonWith(noRelay, 'Выдать доступ'), 'лекарство остаётся на строке');
  assert.equal(textOf(noRelay).includes('Так бывает после перевыпуска'), false,
    'прежний трёхстрочный абзац не должен вернуться');
  assert.ok(tags(noRelay, 'input')[0], 'ключ у этой строки рабочий и показан целиком');

  assert.ok(textOf(noLetter).includes('Буквы и ключа ещё нет'));
  assert.ok(buttonWith(noLetter, 'Выдать ключ'));
});

test('НА ЭКРАНЕ БОЛЬШЕ НЕТ СТОЯЧЕЙ ПРОЗЫ', async () => {
  // Ровно то, на что владелец пожаловался. Каждая строка ниже стояла на экране
  // при каждой отрисовке, никем не прочитанная.
  const text = await paint(MAIN_STATUS, MAIN_BRANCHES);
  const gone = {
    'предупреждение о перевыпуске': KEY_REISSUE_WARNING,
    'про потерянный ключ': KEY_LOSS_WARNING,
    'про несменяемость буквы': LETTER_PERMANENCE_WARNING,
    'последствия отвязки': UNLINK_WARNING_MAIN,
    'про постоянство ключа филиала': 'Ключ филиала не меняется',
    'про передачу ключа лично': 'через сервер Easy-Med он не проходит',
    'про подключение к самой себе': 'подключать её к самой себе не нужно',
  };
  for (const [what, phrase] of Object.entries(gone)) {
    assert.equal(text.includes(phrase), false, `${what} всё ещё стоит абзацем на экране`);
  }
  // «Добавить филиал» — ПОЛЕ И КНОПКА, и больше ничего.
  assert.ok(text.includes('Название филиала') && text.includes('Добавить филиал'));
});

test('ПРЕДУПРЕЖДЕНИЯ НЕ УДАЛЕНЫ — они переехали в окно подтверждения', async () => {
  // Вторая половина, без которой первая ничего не стоит: экран стал короче
  // потому, что предупреждения ПЕРЕЕХАЛИ, а не потому, что их выбросили.
  await paint(MAIN_STATUS, MAIN_BRANCHES);
  confirmAnswer = false;   // владелец передумал — RPC не должен позваться

  // 1. Перевыпуск ключа: оба предупреждения в одном окне.
  confirms = [];
  calls.length = 0;
  buttonWith(card, 'Перевыпустить ключ синхронизации').click();
  assert.equal(confirms.length, 1, 'необратимое действие обязано спросить');
  assert.ok(confirms[0].includes(KEY_REISSUE_WARNING), 'филиалы отвалятся — об этом надо сказать');
  assert.ok(confirms[0].includes(KEY_LOSS_WARNING), 'и что старый ключ не восстановит никто, включая Easy-Med');
  assert.equal(calls.includes('branch_sync_regenerate_key'), false, '«отмена» обязана отменять');

  // 2. Отвязка — единственное необратимое действие, у которого вопроса не было
  //    вовсе: последствие стояло абзацем рядом с кнопкой.
  confirms = [];
  calls.length = 0;
  buttonWith(card, 'Отвязать').click();
  assert.equal(confirms.length, 1);
  assert.ok(confirms[0].includes(UNLINK_WARNING_MAIN));
  assert.equal(calls.includes('branch_sync_unpair'), false);

  // 3. Выдача ключа филиалу без буквы: буква тратится безвозвратно.
  confirms = [];
  calls.length = 0;
  const rows = tags(tags(tags(card, 'table')[0], 'tbody')[0], 'tr');
  buttonWith(rows[3], 'Выдать ключ').click();
  assert.equal(confirms.length, 1);
  assert.ok(confirms[0].includes(LETTER_PERMANENCE_WARNING));
  assert.ok(confirms[0].includes('Старый'), 'владелец должен видеть, какому филиалу выдаёт ключ');
  assert.equal(calls.includes('branch_sync_branch_key'), false);

  // 4. Добавление филиала: тот же расход буквы, то же окно.
  confirms = [];
  calls.length = 0;
  const nameInput = tags(card, 'input').find((i) => i.getAttribute('placeholder') === 'Чиланзар');
  assert.ok(nameInput, 'поле названия филиала');
  nameInput.value = 'Сергели';
  buttonWith(card, 'Добавить филиал').click();
  assert.equal(confirms.length, 1);
  assert.ok(confirms[0].includes(LETTER_PERMANENCE_WARNING));
  assert.ok(confirms[0].includes('Сергели'));
  assert.equal(calls.includes('branch_sync_add_branch'), false);
});

test('выписать резервный доступ можно молча — окно только там, где тратится буква', async () => {
  // Подтверждение на всё подряд приучает закрывать окна не читая, и тогда
  // перестают читать и то единственное, ради которого окно заведено. Учётку
  // резервного канала можно выписывать сколько угодно раз.
  await paint(MAIN_STATUS, MAIN_BRANCHES);
  confirms = [];
  calls.length = 0;
  const rows = tags(tags(tags(card, 'table')[0], 'tbody')[0], 'tr');
  buttonWith(rows[2], 'Выдать доступ').click();
  assert.deepEqual(confirms, [], 'обратимое действие не спрашивает');
  // А то, что осталось сделать руками, говорится ПОСЛЕ нажатия.
  assert.match(RELAY_ACCESS_ISSUED, /ключ заново/);
});

test('h() вешает обработчики через addEventListener — btn.onclick не существует', async () => {
  // Этот экран уже ломали так однажды: код звал btn.onclick(), а h() (ui.js)
  // вешает обработчики через addEventListener, поэтому onclick остаётся
  // undefined и вызов падает. Тест держит это свойство на виду.
  await paint(MAIN_STATUS, MAIN_BRANCHES);
  const btn = buttonWith(card, 'Отвязать');
  assert.equal(btn.onclick, undefined, 'обработчик живёт в addEventListener, а не в .onclick');
  confirmAnswer = false;
  confirms = [];
  btn.click();   // dispatchEvent — единственный работающий путь
  assert.equal(confirms.length, 1, 'клик обязан дойти до обработчика');
});

test('ключ копируется ЦЕЛИКОМ, сколь бы узкой ни была колонка', async () => {
  // Прежний комментарий в CSS запрещал таблицу: длинный ключ «в ячейке жмётся
  // в колонку и копируется обрезанным». Копируется box.value, а не видимый
  // кусок, — это и есть ответ на то возражение.
  await paint(MAIN_STATUS, MAIN_BRANCHES);
  const rows = tags(tags(tags(card, 'table')[0], 'tbody')[0], 'tr');
  copied.length = 0;
  buttonWith(rows[1], 'Копировать').click();
  await flush();
  assert.deepEqual(copied, ['EMB2-BBBB-2222'], 'в буфер уходит ключ целиком');
});

test('список филиалов не загрузился — таблица говорит это, а не показывает пустоту', async () => {
  // branches: null — мок взрывается на branch_sync_branches, как и в трёх
  // тестах выше. Экран обязан пережить это словами.
  const text = await paint(MAIN_STATUS, null);
  assert.ok(text.includes('Не удалось прочитать список филиалов'), 'пустая таблица читается как «сломалось молча»');
  // И карточка при этом жива. Раньше свидетелем была строка «Главный филиал»,
  // но с BRANCH_SETTINGS_LEAN_V1 роль на главной клинике не печатается: в
  // списке ниже собственная строка и так подписана «Эта установка». Свидетелем
  // стал заголовок карточки — он рисуется до всех вызовов и переживает любой
  // отказ, а именно это тест и проверяет.
  assert.ok(text.includes('Синхронизация филиалов'), 'карточка отрисована: ' + text);
});

// ===========================================================================
// Задача 7f — ПРОВОД ПЕРВИЧНОЙ ЗАГРУЗКИ. seedLine существовала с Задачи 7e и
// не вызывалась ниоткуда: сервер считал страницы, экран о них молчал. Ровно
// тот же класс обрыва, ради которого написан весь этот файл.
// ===========================================================================

test('7f: филиал, которому идёт первичная загрузка, видит номер страницы', async () => {
  const text = await paint({
    role: 'secondary', identity_role: 'secondary', letter: 'C',
    main_url: '10.0.0.5:8000', group_id: 'grp-1',
    seed: { receiving: { from: 'B', page: 3, pages: 12 } },
  });
  assert.ok(text.includes('Первичная загрузка из филиала B: страница 3 из ~12.'),
    'страницы на экране нет — «идёт синхронизация» неотличимо от «зависло»: ' + text);
});

test('7f: главная клиника видит, в какие филиалы идёт первичная загрузка', async () => {
  const text = await paint(
    { ...MAIN_STATUS, seed: { sending: [{ letter: 'B', page: 5 }, { letter: 'C', page: 3 }] } },
    MAIN_BRANCHES,
  );
  assert.ok(text.includes('Идёт первичная загрузка в филиалы: B, C (страница 3).'),
    'загрузка идёт отсюда, и это должно быть видно отсюда: ' + text);
});

test('7f: засева нет — строки о нём на экране тоже нет', async () => {
  const text = await paint(MAIN_STATUS, MAIN_BRANCHES);
  assert.ok(!text.includes('Первичная загрузка'), 'постоянная строка «загрузка не идёт» учит не читать это место');
});
