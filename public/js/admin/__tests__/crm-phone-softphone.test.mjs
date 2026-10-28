// SOFTPHONE_V1 (2026-10-29) — телефон Easy-Med в панели «Телефон» на стенде доски.
// Владелец: «can we build a softphone in the easymed inside?» — спецификация
// docs/specs/2026-10-29-softphone-design.md, план — задачи 5 и 6. Сам телефон
// (JsSIP, микрофон, замок вкладки) здесь подменён: панель получает его состояние
// и зовёт его действия, а проверяется то, что видит оператор.
//
// Задача 5 — переключатель «Принимать звонки в Easy-Med» и состояние: кому он
// виден, когда он неактивен и почему (подсказка строкой, а не только в title),
// что включается само (флаг этого компьютера) и что нет, причина словами и
// ссылка на файл настройки компьютера, итог последнего звонка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S, RPC, mk, textOf, byAttr, hasClass, tick } from './crm-harness.mjs';

const { resetCrmPhone, mountPhoneButton } = await import('../views/crm-phone.js');
const { setSoftphoneForTests, reasonText, endText } = await import('../softphone-browser.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', '..', '..');   // …/public

// Тестовые люди и номера — выдуманные.
const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const ME = { id: 7, full_name: 'Админ', extension: '108', softphone_extension: '108', line: 'onlinepbx',
  seen_extensions: ['107', '108'], may_dial: true, may_log: true, may_hear: true };

// ── Подставной телефон: состояние, подписчики, журнал вызовов ────────────────
const IDLE = Object.freeze({ state: 'off', reason: '', message: '', extension: '', call: null, lastEnd: null });
function fakePhone({ wanted = false } = {}) {
  let st = IDLE;
  const subs = new Set();
  const f = {
    flag: wanted,
    calls: [],
    count: (name) => f.calls.filter((c) => c[0] === name).length,
    get: () => st,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    wanted: () => f.flag,
    enable() { f.calls.push(['enable']); f.flag = true; return Promise.resolve(); },
    disable() { f.calls.push(['disable']); f.flag = false; f.push(IDLE); },
    call(n) { f.calls.push(['call', n]); return true; },
    answer() { f.calls.push(['answer']); },
    decline() { f.calls.push(['decline']); },
    hangup() { f.calls.push(['hangup']); },
    setMuted(on) { f.calls.push(['setMuted', on]); if (st.call) f.push({ call: { ...st.call, muted: !!on } }); },
    busy: () => ['ringing', 'calling', 'in_call'].includes(st.state),
    /** Телефон сменил состояние — подписчики узнают сразу, как от настоящего. */
    push(patch) { st = Object.freeze({ ...st, ...patch }); for (const fn of [...subs]) fn(st); },
    listeners: () => subs.size,
  };
  return f;
}

const NAV = [];
async function shell({ fake, user = ADMIN, me = ME, live = [] } = {}) {
  resetCrmPhone();
  setSoftphoneForTests(fake);
  RPC.length = 0; NAV.length = 0;
  window.easymed.state.user = user;
  S.leads = []; S.phoneMe = me; S.callLog = []; S.extensions = []; S.dialError = null; S.live = live;
  document.body.children.length = 0;
  const viewRoot = mk('div');
  const btn = mountPhoneButton({ onNavigate: (v, p) => NAV.push([v, p]), shiftTarget: viewRoot, livePollMs: 25, spTickMs: 20 });
  await tick(40);
  return { viewRoot, btn };
}
const drawer = () => document.body.children.find((n) => n.attrs && 'data-cph-drawer' in n.attrs);
const open = async (btn) => { btn.click(); await tick(40); return drawer(); };
const toggle = (d) => byAttr(d, 'data-cph-sp-toggle')[0];
const one = (d, a) => byAttr(d, a)[0];

test.afterEach(() => { resetCrmPhone(); setSoftphoneForTests(null); });

// ---------------------------------------------------------------------------
// Задача 5 — переключатель и состояние
// ---------------------------------------------------------------------------

test('оператор с правом набора и назначенным номером: строка «Принимать звонки в Easy-Med», переключатель выключен', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  const row = one(d, 'data-cph-sp-row');
  assert.ok(row, 'строки телефона Easy-Med нет');
  assert.notEqual(row.hidden, true, 'строка спрятана');
  const sw = toggle(d);
  assert.ok(sw, 'переключателя нет');
  assert.equal(sw.tagName, 'INPUT');
  assert.equal(sw.getAttribute('type'), 'checkbox');
  assert.equal(sw.parentNode.tagName, 'LABEL', 'подпись не нажимается вместе с переключателем');
  assert.match(textOf(sw.parentNode), /Принимать звонки в Easy-Med/);
  assert.equal(sw.hasAttribute('checked'), false, 'телефон выключен, а переключатель включён');
  assert.equal(sw.hasAttribute('disabled'), false);
  assert.equal(byAttr(d, 'data-cph-sp-hint').length, 0, 'подсказка «почему нельзя» тому, кому можно');
  assert.equal(fake.count('enable'), 0, 'флага на компьютере нет — телефон сам не включается');
});

test('щелчок включает телефон; «Подключение к АТС…», затем «Телефон Easy-Med включён»; второй щелчок выключает', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  toggle(d).click();
  assert.equal(fake.count('enable'), 1);
  fake.push({ state: 'connecting' });
  assert.match(textOf(one(d, 'data-cph-sp-state')), /Подключение к АТС…/);
  fake.push({ state: 'ready', extension: '108' });
  const st = one(d, 'data-cph-sp-state');
  assert.equal(textOf(st), 'Телефон Easy-Med включён');
  assert.ok(hasClass(st, 'ready'), 'слово состояния без цвета «готов»');
  assert.ok(toggle(d).hasAttribute('checked'), 'телефон включён, а переключатель — нет');
  assert.equal(byAttr(d, 'data-cph-sp-reason').length, 0);
  toggle(d).click();
  assert.equal(fake.count('disable'), 1);
  assert.equal(toggle(d).hasAttribute('checked'), false);
  assert.equal(byAttr(d, 'data-cph-sp-state').length, 0, 'выключенный телефон всё ещё говорит о состоянии');
});

test('не включился из-за адреса без защиты: причина словами и ссылка «Скачать файл настройки компьютера» на файл, который отдаёт сервер', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  fake.push({ state: 'error', reason: 'insecure' });
  const st = one(d, 'data-cph-sp-state');
  assert.equal(textOf(st), 'Телефон не включился');
  assert.ok(hasClass(st, 'error'));
  assert.equal(textOf(one(d, 'data-cph-sp-reason')), reasonText('insecure'));
  const link = one(d, 'data-cph-sp-setup');
  assert.ok(link, 'ссылки на файл настройки нет');
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('href'), '/setup/EasyMed-ustanovka.cmd');
  assert.ok(link.hasAttribute('download'), 'файл откроется страницей, а не скачается');
  assert.match(textOf(link), /Скачать файл настройки компьютера/);
  // Адрес ссылки — файл из public/: его отдаёт express.static (проверено в pc-setup-install.test.mjs).
  assert.ok(fs.existsSync(path.join(PUB, ...link.getAttribute('href').split('/').filter(Boolean))), 'по ссылке нет файла');
  // Переключатель остаётся включённым: выключить и включить снова — это и есть «попробовать ещё раз».
  assert.ok(toggle(d).hasAttribute('checked'));
  // Другие причины — без ссылки на файл.
  fake.push({ state: 'error', reason: 'mic_denied' });
  assert.equal(textOf(one(d, 'data-cph-sp-reason')), reasonText('mic_denied'));
  assert.equal(byAttr(d, 'data-cph-sp-setup').length, 0);
});

test('телефон включён в другой вкладке — так и сказано, с объяснением, как пользоваться им здесь', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  fake.push({ state: 'other_tab', reason: 'other_tab' });
  assert.equal(textOf(one(d, 'data-cph-sp-state')), 'Телефон включён в другой вкладке');
  assert.equal(textOf(one(d, 'data-cph-sp-reason')), reasonText('other_tab'));
  assert.match(reasonText('other_tab'), /выключите его в той вкладке/);
});

test('без права набора строки телефона Easy-Med нет', async () => {
  const fake = fakePhone({ wanted: true });
  const { btn } = await shell({ fake, me: { ...ME, may_dial: false } });
  const d = await open(btn);
  assert.equal(byAttr(d, 'data-cph-sp-toggle').length, 0, 'переключатель тому, кто звонить не может');
  const row = one(d, 'data-cph-sp-row');
  assert.ok(!row || row.hidden === true);
  assert.equal(fake.count('enable'), 0);
});

test('номер для телефона не назначен: переключатель неактивен, подсказка видна строкой', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake, me: { ...ME, softphone_extension: '' } });
  const d = await open(btn);
  assert.ok(toggle(d).hasAttribute('disabled'));
  assert.equal(textOf(one(d, 'data-cph-sp-hint')), 'Номер для телефона в Easy-Med назначает администратор в карточке сотрудника.');
});

test('назначен один номер, выбран другой: переключатель неактивен, подсказка называет назначенный номер', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake, me: { ...ME, extension: '107', softphone_extension: '108' } });
  const d = await open(btn);
  assert.ok(toggle(d).hasAttribute('disabled'));
  assert.equal(textOf(one(d, 'data-cph-sp-hint')),
    'Администратор назначил вам номер 108 — выберите его в «Моя трубка», чтобы принимать звонки в Easy-Med.');
});

test('администратор работает от имени сотрудника: переключатель неактивен, подсказка «от чужого имени»', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake, user: { ...ADMIN, id: 12, full_name: 'Сотрудник', role: 'callcenter', acting_admin: { id: 7, full_name: 'Админ' } } });
  const d = await open(btn);
  assert.ok(toggle(d).hasAttribute('disabled'));
  assert.equal(textOf(one(d, 'data-cph-sp-hint')), 'Принимать звонки от чужого имени нельзя — вернитесь к своей учётной записи.');
});

test('флаг этого компьютера и всё можно: телефон включается сам, один раз — без открытия панели и при повторном монтаже кнопки', async () => {
  const fake = fakePhone({ wanted: true });
  const { btn, viewRoot } = await shell({ fake });
  assert.equal(fake.count('enable'), 1, 'телефон не включился после перезагрузки страницы');
  assert.equal(drawer(), undefined, 'ради включения телефона панель не нужна');
  await open(btn);
  mountPhoneButton({ onNavigate: () => {}, shiftTarget: viewRoot, livePollMs: 25, spTickMs: 20 });   // смена языка
  await tick(40);
  assert.equal(fake.count('enable'), 1, 'включение повторилось');
  assert.equal(fake.listeners(), 1, 'панель подписалась на телефон дважды');
});

test('флаг есть, но нельзя (нет права, нет назначенного номера, выбран другой, от чужого имени) — сам не включается никогда', async () => {
  const cases = [
    [{ ...ME, may_dial: false }, ADMIN],
    [{ ...ME, softphone_extension: '' }, ADMIN],
    [{ ...ME, extension: '107' }, ADMIN],
    [ME, { ...ADMIN, acting_admin: { id: 1, full_name: 'Другой админ' } }],
  ];
  for (const [me, user] of cases) {
    const fake = fakePhone({ wanted: true });
    const { btn } = await shell({ fake, me, user });
    await open(btn);
    assert.equal(fake.count('enable'), 0, 'включился, хотя нельзя: ' + JSON.stringify({ me, acting: !!user.acting_admin }));
  }
});

test('в «Моя трубка» выбран не назначенный номер при включённом телефоне: телефон выключается, переключатель неактивен с подсказкой', async () => {
  const fake = fakePhone({ wanted: true });
  const { btn } = await shell({ fake });
  fake.push({ state: 'ready', extension: '108' });
  S.extensions = ['107', '108'];
  const d = await open(btn);
  one(d, 'data-cph-ext').click();
  await tick(40);
  const sel = one(d, 'data-cph-ext-select');
  sel.value = '107';
  one(d, 'data-cph-ext-save').click();
  await tick(40);
  assert.deepEqual(RPC.find((r) => r.name === 'telephony_my_extension').body, { extension: '107' });
  assert.equal(fake.count('disable'), 1, 'телефон остался включённым на чужом номере');
  assert.ok(toggle(d).hasAttribute('disabled'));
  assert.match(textOf(one(d, 'data-cph-sp-hint')), /назначил вам номер 108/);
});

test('итог звонка («Занято.») — строкой под переключателем; со следующим звонком строка уходит', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  const lastEnd = { direction: 'out', cause: 'Busy', media: null };
  fake.push({ state: 'ready', extension: '108', lastEnd });
  assert.equal(textOf(one(d, 'data-cph-sp-end')), endText(lastEnd));
  assert.equal(endText(lastEnd), 'Занято.');
  fake.push({ state: 'calling', lastEnd: null, call: { direction: 'out', number: '998901112233', startedAt: null, muted: false } });
  assert.equal(byAttr(d, 'data-cph-sp-end').length, 0, 'итог прошлого звонка висит во время нового');
  // Обычный конец разговора — без строки.
  fake.push({ state: 'ready', call: null, lastEnd: { direction: 'out', cause: 'Terminated', media: null } });
  assert.equal(byAttr(d, 'data-cph-sp-end').length, 0);
});
