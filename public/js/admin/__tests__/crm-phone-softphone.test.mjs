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
//
// Задача 6 — звонок: входящий сам открывает панель и показывает, кто звонит
// (telephony_caller, один запрос на звонок), «Принять» / «Отклонить» / «Открыть
// карту»; разговор — таймер, «Микрофон выкл.», «Завершить»; «Позвонить» при
// включённом телефоне идёт через гарнитуру, а не через telephony_dial; карточка
// телефона важнее блока «Звонит»; сигнал звонка слушается колокольчика панели;
// на узбекском и английском экране — ни одной кириллической буквы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S, RPC, mk, walk, textOf, byAttr, hasClass, tick, TOASTS } from './crm-harness.mjs';

const { resetCrmPhone, mountPhoneButton } = await import('../views/crm-phone.js');
const { setSoftphoneForTests, reasonText, endText } = await import('../softphone-browser.js');
const { setLang } = await import('../i18n.js');
const { ICON_BODIES } = await import('../icon-paths.js');
const { ICON_MAP } = await import('../icon-map.js');

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

// Кто звонит — ответ telephony_caller на стенде.
const CALLER = { patient: { id: 5, full_name: 'Каримова Азиза', mrn: 'A-12' }, lead: null };
const call = (over) => ({ direction: 'in', number: '998901112233', startedAt: null, muted: false, ...over });

const NAV = [];
const CTX = { livePollMs: 25, spTickMs: 20, spRefreshMs: 30 };
async function shell({ fake, user = ADMIN, me = ME, live = [], calls = [], caller = CALLER, ctx = {}, wait = 40 } = {}) {
  resetCrmPhone();
  setSoftphoneForTests(fake);
  RPC.length = 0; NAV.length = 0; TOASTS.length = 0;
  window.easymed.state.user = user;
  // Копия: стенд отдаёт панели сам объект, а «Моя трубка» меняет в нём extension.
  S.leads = []; S.phoneMe = me && { ...me }; S.callLog = calls; S.extensions = []; S.dialError = null; S.live = live; S.caller = caller;
  document.body.children.length = 0;
  const viewRoot = mk('div');
  const btn = mountPhoneButton({ onNavigate: (v, p) => NAV.push([v, p]), shiftTarget: viewRoot, ...CTX, ...ctx });
  if (wait) await tick(wait);
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
  mountPhoneButton({ onNavigate: () => {}, shiftTarget: viewRoot, ...CTX });   // смена языка
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

// ---------------------------------------------------------------------------
// Задача 6 — входящий, разговор, исходящий через гарнитуру
// ---------------------------------------------------------------------------
const key = (d, k) => byAttr(d, 'data-k').find((b) => b.getAttribute('data-k') === k).click();
const callerAsks = () => RPC.filter((r) => r.name === 'telephony_caller');

test('входящий: закрытая панель открывается сама; карточка называет пациента (telephony_caller), «Принять», «Отклонить», «Открыть карту»', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  fake.push({ state: 'ready', extension: '108' });
  one(d, 'data-cph-close').click();
  assert.ok(String(d.className).includes('cph-closed'));
  fake.push({ state: 'ringing', call: call() });
  assert.ok(!String(d.className).includes('cph-closed'), 'панель не открылась на входящий');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  await tick(40);
  const card = one(d, 'data-cph-sp-card');
  assert.ok(card, 'карточки входящего нет');
  assert.equal(card.getAttribute('data-cph-sp-card'), 'ringing');
  assert.match(textOf(card), /Каримова Азиза/);
  assert.match(textOf(card), /\+998 90 111 22 33/);
  assert.match(textOf(card), /Входящий звонок/);
  assert.match(textOf(card), /Карта A-12/);
  assert.deepEqual(callerAsks().map((r) => r.body), [{ number: '998901112233' }]);
  assert.equal(byAttr(d, 'data-k').length, 0, 'клавиатура поверх входящего');
  assert.match(textOf(one(d, 'data-cph-status')), /Звонит/);
  assert.equal(byAttr(d, 'data-cph-sp-hangup').length, 0, '«Завершить» до ответа');
  one(d, 'data-cph-sp-answer').click();
  assert.equal(fake.count('answer'), 1);
  one(d, 'data-cph-sp-decline').click();
  assert.equal(fake.count('decline'), 1);
  one(d, 'data-cph-sp-patient').click();
  assert.deepEqual(NAV, [['patient-card', { id: 5, full_name: 'Каримова Азиза' }]]);
  assert.equal(fake.count('answer'), 1, '«Открыть карту» ответила на звонок');
});

test('входящий, а панель ещё ни разу не открывали: она появляется сама, с карточкой звонка', async () => {
  const fake = fakePhone({ wanted: true });
  const { btn } = await shell({ fake });
  assert.equal(drawer(), undefined);
  fake.push({ state: 'ready', extension: '108' });
  fake.push({ state: 'ringing', call: call() });
  const d = drawer();
  assert.ok(d, 'панели нет');
  assert.ok(!String(d.className).includes('cph-closed'), 'панель закрыта');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  await tick(40);
  assert.equal(one(d, 'data-cph-sp-card').getAttribute('data-cph-sp-card'), 'ringing');
  assert.match(textOf(one(d, 'data-cph-sp-card')), /Каримова Азиза/);
});

test('незнакомый номер: номер вместо имени, «Номер не знаком», без «Открыть карту»', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake, caller: { patient: null, lead: null } });
  const d = await open(btn);
  fake.push({ state: 'ringing', call: call({ number: '998935550199' }) });
  await tick(40);
  const card = one(d, 'data-cph-sp-card');
  assert.match(textOf(card), /\+998 93 555 01 99/);
  assert.match(textOf(card), /Номер не знаком/);
  assert.equal(byAttr(d, 'data-cph-sp-patient').length, 0);
});

test('повторное «звонит» о том же номере не спрашивает telephony_caller снова', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  fake.push({ state: 'ringing', call: call() });
  await tick(40);
  fake.push({ state: 'ringing', call: call() });
  fake.push({ state: 'ringing', reason: '', call: call() });
  await tick(40);
  assert.equal(callerAsks().length, 1, 'кто звонит — спросили ' + callerAsks().length + ' раза');
  assert.match(textOf(one(d, 'data-cph-sp-card')), /Каримова Азиза/);
});

test('разговор: таймер 00:00 → 01:05, «Микрофон выкл.» (нажата — выключен, строка под таймером), «Завершить»; конец разговора — журнал обновляется', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  const realNow = Date.now;
  const base = realNow();
  try {
    Date.now = () => base;
    fake.push({ state: 'ringing', call: call() });
    fake.push({ state: 'in_call', call: call({ startedAt: base }) });
    const card = one(d, 'data-cph-sp-card');
    assert.equal(card.getAttribute('data-cph-sp-card'), 'in_call');
    assert.equal(textOf(one(d, 'data-cph-sp-timer')), '00:00');
    assert.match(textOf(one(d, 'data-cph-status')), /Разговор идёт/);
    assert.equal(byAttr(d, 'data-cph-sp-answer').length, 0, '«Принять» в разговоре');
    Date.now = () => base + 65000;
    await tick(60);   // таймер панели — раз в spTickMs
    assert.equal(textOf(one(d, 'data-cph-sp-timer')), '01:05');
  } finally {
    Date.now = realNow;
  }
  // «Микрофон выкл.» — подпись постоянная; состояние — aria-pressed, значок и строка под таймером.
  const MIC = ICON_BODIES[ICON_MAP.Mic];
  const MIC_OFF = ICON_BODIES[ICON_MAP.MicOff];
  const mute = one(d, 'data-cph-sp-mute');
  assert.match(textOf(mute), /Микрофон выкл\./);
  assert.equal(mute.getAttribute('aria-pressed'), 'false');
  assert.ok(textOf(mute).includes(MIC) && !textOf(mute).includes(MIC_OFF), 'микрофон работает — значок должен быть «микрофон»');
  assert.equal(byAttr(d, 'data-cph-sp-muted').length, 0);
  mute.click();
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'setMuted'), [['setMuted', true]]);
  const muted = one(d, 'data-cph-sp-mute');
  assert.match(textOf(muted), /Микрофон выкл\./, 'подпись кнопки-переключателя не должна меняться');
  assert.equal(muted.getAttribute('aria-pressed'), 'true');
  assert.ok(textOf(muted).includes(MIC_OFF) && !textOf(muted).includes(MIC), 'микрофон выключен — значок должен быть перечёркнутым');
  assert.ok(textOf(one(d, 'data-cph-sp-muted')).endsWith('Микрофон выключен — собеседник вас не слышит.'));
  muted.click();
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'setMuted').pop(), ['setMuted', false]);
  assert.equal(one(d, 'data-cph-sp-mute').getAttribute('aria-pressed'), 'false');
  assert.equal(byAttr(d, 'data-cph-sp-muted').length, 0, 'микрофон включён, а строка «выключен» осталась');
  one(d, 'data-cph-sp-hangup').click();
  assert.equal(fake.count('hangup'), 1);
  // Звонок кончился: карточка уходит, журнал спрашивается снова (через spRefreshMs).
  const logBefore = RPC.filter((r) => r.name === 'telephony_call_log').length;
  fake.push({ state: 'ready', call: null, lastEnd: { direction: 'in', cause: 'Terminated', media: null } });
  assert.equal(byAttr(d, 'data-cph-sp-card').length, 0);
  assert.equal(byAttr(d, 'data-k').length, 12, 'после разговора нет клавиатуры');
  await tick(80);
  assert.ok(RPC.filter((r) => r.name === 'telephony_call_log').length > logBefore, 'журнал не обновился после звонка');
});

test('исходящий при включённом телефоне: «Позвонить» уходит в телефон, а не в telephony_dial; подсказка — про гарнитуру; «Перезвонить» из журнала — туда же', async () => {
  const fake = fakePhone();
  const CALLS = [{ id: 1, started_at: new Date().toISOString(), call_type: 0, external_number: '998977012345', internal_number: '108', billsec: 30, disposition: 'ANSWER',
    patient_id: null, patient_name: null, patient_mrn: null, operator_name: null, recording_url: null, has_recording: false }];
  const { btn } = await shell({ fake, calls: CALLS });
  const d = await open(btn);
  fake.push({ state: 'ready', extension: '108' });
  for (const k of '998901112233') key(d, k);
  assert.equal(textOf(one(d, 'data-cph-hint')), 'Звонок пойдёт через гарнитуру этого компьютера');
  one(d, 'data-cph-call').click();
  await tick(40);
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'call'), [['call', '998901112233']]);
  assert.equal(RPC.filter((r) => r.name === 'telephony_dial').length, 0, 'набор ушёл и в станцию');
  assert.equal(byAttr(d, 'data-cph-card').length, 0, 'карточка «Сначала зазвонит ваша трубка» при звонке через гарнитуру');
  fake.push({ state: 'calling', call: call({ direction: 'out' }) });
  const card = one(d, 'data-cph-sp-card');
  assert.equal(card.getAttribute('data-cph-sp-card'), 'calling');
  assert.equal(textOf(one(d, 'data-cph-sp-timer')), 'Вызов…');
  assert.ok(one(d, 'data-cph-sp-hangup'), 'нечем сбросить исходящий');
  // Пока идёт звонок, «Перезвонить» из журнала не набирает ни так, ни этак.
  one(d, 'data-cph-cb').click();
  await tick(20);
  assert.equal(fake.count('call'), 1);
  assert.equal(RPC.filter((r) => r.name === 'telephony_dial').length, 0);
  assert.ok(TOASTS.some((t) => /Сначала завершите текущий звонок/.test(t)), 'отказ без слов');
  fake.push({ state: 'ready', call: null, lastEnd: { direction: 'out', cause: 'Canceled', media: null } });
  one(d, 'data-cph-cb').click();
  await tick(20);
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'call').pop(), ['call', '998977012345']);
  assert.equal(RPC.filter((r) => r.name === 'telephony_dial').length, 0);
});

test('телефон выключен — «Позвонить» по-старому: telephony_dial и «Сначала зазвонит ваша трубка»', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  for (const k of '998901112233') key(d, k);
  assert.match(textOf(one(d, 'data-cph-hint')), /Сначала зазвонит ваша трубка/);
  one(d, 'data-cph-call').click();
  await tick(40);
  assert.deepEqual(RPC.find((r) => r.name === 'telephony_dial').body, { phone: '998901112233' });
  assert.equal(fake.count('call'), 0);
  assert.equal(one(d, 'data-cph-card').getAttribute('data-cph-card'), 'ringing');
});

test('карточка телефона Easy-Med важнее блока «Звонит» станции', async () => {
  const fake = fakePhone();
  const live = [{ uuid: 'r1', direction: 'in', state: 'ringing', was_answered: false, caller: '998901112233', callee: '108', number: '998901112233',
    since: new Date().toISOString(), updated: Date.now(), patient: CALLER.patient, lead: null }];
  const { btn } = await shell({ fake, live });
  const d = await open(btn);
  await tick(60);
  assert.ok(one(d, 'data-cph-ring'), 'блок «Звонит» станции не нарисовался — проверять нечего');
  fake.push({ state: 'ringing', call: call() });
  await tick(60);
  assert.ok(one(d, 'data-cph-sp-card'), 'карточки телефона нет');
  assert.equal(byAttr(d, 'data-cph-ring').length, 0, 'блок «Звонит» поверх телефона Easy-Med');
});

// Подставной WebAudio: считает осцилляторы (один писк ringTone — два).
function fakeAudio() {
  const n = { tones: 0 };
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createOscillator() { n.tones++; return { type: '', frequency: { value: 0 }, connect: (g) => g, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({}) }; }
  };
  return n;
}

test('сигнал входящего: звучит сразу и повторяется, пока звонит; в разговоре молчит; слушается колокольчика панели', async () => {
  const n = fakeAudio();
  try {
    const fake = fakePhone();
    const { btn } = await shell({ fake, ctx: { spRingMs: 20 } });
    const d = await open(btn);
    fake.push({ state: 'ready', extension: '108' });
    assert.equal(n.tones, 0);
    fake.push({ state: 'ringing', call: call() });
    assert.ok(n.tones > 0, 'входящий без звука');
    const first = n.tones;
    await tick(70);
    assert.ok(n.tones > first, 'сигнал не повторяется, пока звонит');
    fake.push({ state: 'in_call', call: call({ startedAt: Date.now() }) });
    const after = n.tones;
    await tick(70);
    assert.equal(n.tones, after, 'сигнал звучит и в разговоре');
    fake.push({ state: 'ready', call: null });
    await tick(70);
    assert.equal(n.tones, after, 'сигнал звучит после звонка');
    // Колокольчик выключен — входящий без сигнала.
    one(d, 'data-cph-mute').click();
    fake.push({ state: 'ringing', call: call({ number: '998935550199' }) });
    await tick(70);
    assert.equal(n.tones, after, 'звук выключен, а сигнал звучит');
  } finally {
    delete window.AudioContext;
    localStorage.removeItem('easymed.phone.mute');
  }
});

test('узбекский и английский экран: строка телефона и карточка звонка без кириллицы', async () => {
  const CYR = /[А-Яа-яЁёҚқҒғЎўҲҳ]/;
  const leaks = (root) => walk(root).filter((n) => n.tagName !== 'SVG').flatMap((n) => [n._t || '', ...['title', 'aria-label'].map((a) => (n.attrs && n.attrs[a]) || '')])
    .filter((s) => CYR.test(s));
  const latin = { ...ADMIN, full_name: 'Admin' };
  // setLang шлёт событие окну — в стенде окна-события нет.
  const keep = { dispatch: window.dispatchEvent, CE: globalThis.CustomEvent };
  window.dispatchEvent = () => true;
  if (!globalThis.CustomEvent) globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
  try {
    for (const lang of ['uz', 'en']) {
      setLang(lang);
      const fake = fakePhone();
      const { btn } = await shell({ fake, user: latin, me: { ...ME, full_name: 'Admin' },
        caller: { patient: { id: 5, full_name: 'Karimova Aziza', mrn: 'A-12' }, lead: null } });
      const d = await open(btn);
      const found = [];
      const look = (where) => { for (const s of leaks(one(d, 'data-cph-sp-row'))) found.push(where + ' row: ' + s); for (const s of leaks(one(d, 'data-cph-body'))) found.push(where + ' body: ' + s); };
      look('off');
      for (const patch of [{ state: 'connecting', reason: 'network' }, { state: 'ready' }, { state: 'error', reason: 'insecure' }, { state: 'other_tab', reason: 'other_tab' },
        { state: 'ready', reason: '', lastEnd: { direction: 'out', cause: 'Busy', media: null } }]) {
        fake.push(patch);
        look(patch.state + (patch.reason ? '/' + patch.reason : ''));
      }
      // Не готов — подсказка под клавиатурой и отказ набора.
      fake.push({ state: 'connecting', reason: 'network', lastEnd: null });
      for (const k of '998901112233') key(d, k);
      look('not-ready hint');
      one(d, 'data-cph-call').click();
      for (const t of TOASTS) if (CYR.test(t)) found.push('toast: ' + t);
      for (let i = 0; i < 12; i++) one(d, 'data-cph-del').click();
      fake.push({ state: 'ringing', reason: '', lastEnd: null, call: call() });
      await tick(40);
      look('ringing');
      assert.ok(textOf(bodyEl('data-cph-sp-live')), lang + ': входящий не объявлен');
      for (const s of leaks(bodyEl('data-cph-sp-live'))) found.push('live: ' + s);
      fake.push({ state: 'in_call', call: call({ startedAt: Date.now() }) });
      look('in_call');
      fake.push({ state: 'in_call', call: call({ startedAt: Date.now(), muted: true }) });
      look('in_call muted');
      fake.push({ state: 'calling', call: call({ direction: 'out', number: '998935550199' }) });
      await tick(40);
      look('calling');
      fake.push({ state: 'ringing', call: call({ number: '105' }) });
      await tick(40);
      look('internal');
      // Нельзя включить — подсказки.
      for (const [me, user] of [[{ ...ME, full_name: 'Admin', softphone_extension: '' }, latin], [{ ...ME, full_name: 'Admin', extension: '107' }, latin],
        [{ ...ME, full_name: 'Admin' }, { ...latin, acting_admin: { id: 1, full_name: 'Boss' } }]]) {
        const f2 = fakePhone();
        const s2 = await shell({ fake: f2, me, user });
        const d2 = await open(s2.btn);
        for (const s of leaks(one(d2, 'data-cph-sp-row'))) found.push('hint: ' + s);
      }
      assert.deepEqual(found, [], lang + ': кириллица на экране');
    }
  } finally {
    setLang('ru');
    window.dispatchEvent = keep.dispatch;
    globalThis.CustomEvent = keep.CE;
  }
});

// ---------------------------------------------------------------------------
// Правки ревью задач 5 и 6
// ---------------------------------------------------------------------------
const STATION = (over) => ({ uuid: 'r1', direction: 'in', state: 'ringing', was_answered: false, caller: '998901112233', callee: '108', number: '998901112233',
  since: new Date().toISOString(), updated: Date.now(), patient: CALLER.patient, lead: null, ...over });
const JOURNAL = [{ id: 1, started_at: new Date().toISOString(), call_type: 0, external_number: '998977012345', internal_number: '108', billsec: 30, disposition: 'ANSWER',
  patient_id: null, patient_name: null, patient_mrn: null, operator_name: null, recording_url: null, has_recording: false }];
const bodyEl = (attr) => document.body.children.find((n) => n.attrs && attr in n.attrs);
const CSS = fs.readFileSync(path.join(PUB, 'css', 'admin-views.css'), 'utf8');

test('телефон включён, но не готов (подключается, ошибка, другая вкладка): набор отказывает с причиной — ни станции, ни телефона', async () => {
  for (const patch of [{ state: 'connecting', reason: '' }, { state: 'connecting', reason: 'network' }, { state: 'error', reason: 'mic_denied' }, { state: 'other_tab', reason: 'other_tab' }]) {
    const fake = fakePhone();
    const { btn } = await shell({ fake, calls: JOURNAL });
    const d = await open(btn);
    fake.push(patch);
    const want = 'Телефон Easy-Med не готов: ' + (reasonText(patch.reason) || 'Подключение к АТС…');
    for (const k of '998901112233') key(d, k);
    const where = patch.state + '/' + patch.reason;
    assert.equal(textOf(one(d, 'data-cph-hint')), want, where + ': подсказка под клавиатурой');
    assert.doesNotMatch(textOf(one(d, 'data-cph-hint')), /Сначала зазвонит ваша трубка/);
    assert.ok(one(d, 'data-cph-call').hasAttribute('disabled'), where + ': «Позвонить» активна');
    one(d, 'data-cph-call').click();   // стенд нажимает и неактивную кнопку — проверяем сам набор
    one(d, 'data-cph-cb').click();     // «Перезвонить» из журнала
    await tick(30);
    assert.equal(RPC.filter((r) => r.name === 'telephony_dial').length, 0, where + ': набор ушёл на трубку');
    assert.equal(fake.count('call'), 0, where + ': набор ушёл в телефон');
    assert.ok(TOASTS.includes(want), where + ': отказ без слов: ' + TOASTS.join(' | '));
  }
});

test('звонок поверх окон: пока идёт звонок, панель и пилюля выше модальных окон (но ниже уведомлений); после звонка — на своём месте', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  const mini = () => bodyEl('data-cph-mini');
  assert.ok(!hasClass(d, 'cph-on-call'));
  fake.push({ state: 'ringing', call: call() });
  assert.ok(hasClass(d, 'cph-on-call'), 'входящий под окном заявки');
  assert.ok(hasClass(mini(), 'cph-on-call'));
  fake.push({ state: 'in_call', call: call({ startedAt: Date.now() }) });
  assert.ok(hasClass(d, 'cph-on-call'));
  fake.push({ state: 'ready', call: null });
  assert.ok(!hasClass(d, 'cph-on-call'), 'после звонка панель осталась поверх окон');
  assert.ok(!hasClass(mini(), 'cph-on-call'));
  // Слой: окна (.modal) — 100…200 (свой z-index у части окон), уведомления — 12000.
  const z = Number((/\.cph-drawer\.cph-on-call[^{]*\{[^}]*z-index:\s*(\d+)/.exec(CSS) || [])[1]);
  assert.ok(z > 200 && z < 1000, 'слой панели при звонке: ' + z);
});

test('«Отклонить»: блок «Звонит» станции о том же звонке не всплывает и не пищит — ни сразу, ни когда станция догонит', async () => {
  const n = fakeAudio();
  try {
    const fake = fakePhone();
    const { btn } = await shell({ fake, live: [STATION()] });
    const d = await open(btn);
    await tick(60);
    fake.push({ state: 'ready', extension: '108' });
    fake.push({ state: 'ringing', call: call() });
    await tick(60);
    fake.push({ state: 'ready', call: null, lastEnd: { direction: 'in', cause: 'Rejected', media: null } });
    const t0 = n.tones;
    await tick(100);
    assert.equal(byAttr(d, 'data-cph-ring').length, 0, 'блок «Звонит» станции после «Отклонить»');
    assert.equal(n.tones, t0, 'станция пищит после «Отклонить»');
    assert.doesNotMatch(textOf(one(d, 'data-cph-status')), /Звонит/);
    // Станция прислала тот же звонок позже, новой записью.
    S.live = [STATION({ uuid: 'r1-late', updated: Date.now() })];
    await tick(100);
    assert.equal(byAttr(d, 'data-cph-ring').length, 0, 'запоздавшая запись станции всплыла');
    assert.equal(n.tones, t0);
  } finally {
    delete window.AudioContext;
  }
});

test('после тишины новый звонок станции с того же номера снова виден', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake, live: [STATION()], ctx: { spHushMs: 60 } });
  const d = await open(btn);
  fake.push({ state: 'ringing', call: call() });
  fake.push({ state: 'ready', call: null, lastEnd: { direction: 'in', cause: 'Rejected', media: null } });
  S.live = [];
  await tick(120);
  S.live = [STATION({ uuid: 'r2', updated: Date.now() })];
  await tick(80);
  assert.ok(one(d, 'data-cph-ring'), 'новый звонок станции спрятан навсегда');
});

test('тишина после звонка — только при готовом телефоне: связь пропала или телефон выключили — перезвон того же номера станция показывает', async () => {
  const ends = [
    ['связь пропала', { state: 'connecting', reason: 'network', call: null, lastEnd: { direction: 'in', cause: 'Connection Error', media: null } }],
    ['телефон выключили', { ...IDLE }],
  ];
  for (const [why, after] of ends) {
    const fake = fakePhone();
    const { btn } = await shell({ fake, ctx: { spHushMs: 5000 } });
    const d = await open(btn);
    fake.push({ state: 'in_call', call: call({ startedAt: Date.now() }) });
    await tick(30);
    fake.push(after);
    await tick(30);
    S.live = [STATION({ uuid: 'cb1', updated: Date.now() })];   // пациент перезванивает внутри окна тишины
    await tick(80);
    assert.ok(one(d, 'data-cph-ring'), why + ': перезвон спрятан, хотя телефон Easy-Med его не примет');
  }
});

test('«Завершить»: блок «Звонит» станции «Разговор идёт» о том же звонке не всплывает', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake, live: [STATION({ uuid: 'r3', state: 'answered', was_answered: true, patient: null })] });
  const d = await open(btn);
  await tick(40);
  fake.push({ state: 'in_call', call: call({ startedAt: Date.now() }) });
  await tick(40);
  fake.push({ state: 'ready', call: null, lastEnd: { direction: 'in', cause: 'Terminated', media: null } });
  await tick(80);
  assert.equal(byAttr(d, 'data-cph-ring').length, 0, 'после «Завершить» — «Разговор идёт» станции');
  assert.doesNotMatch(textOf(one(d, 'data-cph-status')), /Разговор идёт/);
});

test('пока звонит телефон Easy-Med, станция не пищит поверх — ни о том же звонке, ни о другом', async () => {
  const n = fakeAudio();
  try {
    const fake = fakePhone();
    const { btn } = await shell({ fake, ctx: { spRingMs: 10000 } });
    const d = await open(btn);
    fake.push({ state: 'ringing', call: call() });
    const t0 = n.tones;
    assert.ok(t0 > 0);
    S.live = [STATION(), STATION({ uuid: 'r9', caller: '998935550177', number: '998935550177', patient: null, updated: Date.now() + 1 })];
    await tick(100);
    assert.equal(n.tones, t0, 'станция пищит поверх телефона Easy-Med');
    assert.ok(one(d, 'data-cph-sp-card'));
  } finally {
    delete window.AudioContext;
  }
});

test('звонок кончился — следующий с того же номера снова спрашивает, кто звонит (карту могли завести)', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  await open(btn);
  fake.push({ state: 'ringing', call: call() });
  await tick(40);
  fake.push({ state: 'ready', call: null, lastEnd: { direction: 'in', cause: 'Canceled', media: null } });
  fake.push({ state: 'ringing', call: call(), lastEnd: null });
  await tick(40);
  assert.equal(callerAsks().length, 2);
});

test('«кто звонит» не ответил: только номер — без «Номер не знаком» и «Новая заявка»', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake, caller: () => { throw new Error('сервер недоступен'); } });
  const d = await open(btn);
  fake.push({ state: 'ringing', call: call() });
  await tick(60);
  const card = one(d, 'data-cph-sp-card');
  assert.match(textOf(card), /\+998 90 111 22 33/);
  assert.doesNotMatch(textOf(card), /Номер не знаком/, 'сбой сервера выдан за незнакомый номер');
  assert.equal(byAttr(d, 'data-cph-sp-new').length, 0);
});

test('внутренний звонок (короткий номер): без «кто звонит», «Номер не знаком» и «Новая заявка» — номер и «Внутренний звонок»', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  fake.push({ state: 'ringing', call: call({ number: '105' }) });
  await tick(40);
  const card = one(d, 'data-cph-sp-card');
  assert.equal(callerAsks().length, 0, 'внутренний номер спросили у сервера');
  assert.equal(textOf(card.children.find((c) => c.tagName === 'H2')), '105');
  assert.match(textOf(card), /Внутренний звонок/);
  assert.doesNotMatch(textOf(card), /Номер не знаком/);
  assert.equal(byAttr(d, 'data-cph-sp-new').length, 0);
});

test('во время звонка переключатель неактивен: «Выключить телефон можно после разговора.»', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  fake.push({ state: 'ready', extension: '108' });
  for (const patch of [{ state: 'ringing', call: call() }, { state: 'calling', call: call({ direction: 'out' }) }, { state: 'in_call', call: call({ startedAt: Date.now() }) }]) {
    fake.push(patch);
    const sw = toggle(d);
    assert.ok(sw.hasAttribute('disabled'), patch.state + ': переключатель активен');
    assert.ok(sw.hasAttribute('checked'));
    assert.equal(textOf(one(d, 'data-cph-sp-hint')), 'Выключить телефон можно после разговора.');
    sw.click();
    assert.equal(fake.count('disable'), 0, patch.state + ': щелчок положил трубку');
  }
  fake.push({ state: 'ready', call: null });
  assert.equal(toggle(d).hasAttribute('disabled'), false);
  assert.equal(byAttr(d, 'data-cph-sp-hint').length, 0);
});

test('читалка экрана: входящий объявляется один раз — «Входящий звонок: имя»; причина связана с переключателем', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  const d = await open(btn);
  const live = () => bodyEl('data-cph-sp-live');
  assert.ok(live(), 'нет области объявлений');
  assert.equal(live().getAttribute('aria-live'), 'polite');
  assert.equal(textOf(live()), '');
  fake.push({ state: 'ringing', call: call() });
  await tick(60);
  assert.equal(textOf(live()), 'Входящий звонок: Каримова Азиза');
  live().textContent = 'уже объявлено';
  fake.push({ state: 'ringing', call: call() });
  await tick(60);
  assert.equal(textOf(live()), 'уже объявлено', 'тот же звонок объявлен второй раз');
  fake.push({ state: 'ready', call: null });
  assert.equal(textOf(live()), '', 'звонок кончился, а объявление осталось — следующий такой же не прозвучит');
  fake.push({ state: 'error', reason: 'mic_denied' });
  const ids = String(toggle(d).getAttribute('aria-describedby') || '').split(/\s+/);
  const reason = one(d, 'data-cph-sp-reason');
  assert.ok(reason.getAttribute('id') && ids.includes(reason.getAttribute('id')), 'причина не связана с переключателем');
});

test('фокус клавиатуры переживает перерисовку: «Микрофон выкл.» и переключатель; фокус вне панели не трогаем', async () => {
  const proto = Object.getPrototypeOf(mk('div'));
  const keep = proto.focus;
  proto.focus = function () { document.activeElement = this; };
  try {
    const fake = fakePhone();
    const { btn } = await shell({ fake });
    const d = await open(btn);
    fake.push({ state: 'in_call', call: call({ startedAt: Date.now() }) });
    const m1 = one(d, 'data-cph-sp-mute');
    m1.focus();
    fake.push({ state: 'in_call', call: call({ startedAt: Date.now(), muted: true }) });
    const m2 = one(d, 'data-cph-sp-mute');
    assert.notEqual(m2, m1, 'кнопку не перерисовали — проверять нечего');
    assert.equal(document.activeElement, m2, 'фокус ушёл с «Микрофон выкл.»');
    fake.push({ state: 'ready', call: null });
    const t1 = toggle(d);
    t1.focus();
    fake.push({ state: 'connecting' });
    const t2 = toggle(d);
    assert.notEqual(t2, t1);
    assert.equal(document.activeElement, t2, 'фокус ушёл с переключателя');
    const outside = mk('button');
    outside.focus();
    fake.push({ state: 'ready' });
    assert.equal(document.activeElement, outside, 'панель забрала фокус у чужого поля');
  } finally {
    proto.focus = keep;
    delete document.activeElement;
  }
});

test('смена языка при выключенном телефоне перерисовывает подпись переключателя', async () => {
  const keep = { dispatch: window.dispatchEvent, CE: globalThis.CustomEvent };
  window.dispatchEvent = () => true;
  if (!globalThis.CustomEvent) globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
  try {
    const fake = fakePhone();
    const { btn, viewRoot } = await shell({ fake });
    const d = await open(btn);
    assert.match(textOf(one(d, 'data-cph-sp-row')), /Принимать звонки в Easy-Med/);
    setLang('en');
    mountPhoneButton({ onNavigate() {}, shiftTarget: viewRoot, ...CTX });   // оболочка ставит кнопку заново при смене языка
    await tick(20);
    assert.match(textOf(one(d, 'data-cph-sp-row')), /Take calls in Easy-Med/);
  } finally {
    setLang('ru');
    window.dispatchEvent = keep.dispatch;
    globalThis.CustomEvent = keep.CE;
  }
});

test('«кто я» не ответил при загрузке: телефон включится сам после удачного опроса станции, повторы не чаще meRetryMs', async () => {
  const realFetch = globalThis.fetch;
  let asks = 0;
  let failing = true;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/telephony_phone_me')) {
      asks++;
      if (failing) return { ok: false, json: async () => ({ error: { message: 'сервер перезапускается' } }) };
    }
    return realFetch(url, opts);
  };
  try {
    const fake = fakePhone({ wanted: true });
    await shell({ fake, ctx: { meRetryMs: 60 }, wait: 200 });
    assert.equal(fake.count('enable'), 0);
    assert.ok(asks >= 2, 'после сбоя «кто я» больше не спрашивали');
    assert.ok(asks <= 5, '«кто я» спрашивают на каждом опросе: ' + asks);
    failing = false;
    await tick(150);
    assert.equal(fake.count('enable'), 1, 'телефон так и не включился');
    assert.equal(drawer(), undefined, 'ради включения панель открывать не нужно');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('включение само — один раз за страницу, даже если «кто я» спросили дважды подряд', async () => {
  const fake = fakePhone({ wanted: true });
  const { btn } = await shell({ fake, wait: 0 });
  btn.click();   // панель открыли, пока первый ответ ещё в пути — второй loadMe
  await tick(60);
  assert.ok(RPC.filter((r) => r.name === 'telephony_phone_me').length >= 2, 'второго «кто я» не было — проверять нечего');
  assert.equal(fake.count('enable'), 1);
});

test('снятие панели отписывается от телефона и не выключает его', async () => {
  const fake = fakePhone();
  const { btn } = await shell({ fake });
  await open(btn);
  fake.push({ state: 'in_call', call: call({ startedAt: Date.now() }) });
  assert.equal(fake.listeners(), 1);
  resetCrmPhone();
  assert.equal(fake.listeners(), 0, 'панель осталась подписана');
  assert.equal(fake.count('disable'), 0, 'снятие панели выключило телефон');
  fake.push({ state: 'ready', call: null });   // телефон живёт дальше — панель об этом уже не знает
});

test('кнопки звонка различимы: «Принять» и «Отклонить»/«Завершить» на тёмных заливках (контраст значка ≥ 3:1)', () => {
  assert.match(CSS, /\.cph-sp-btn\.ok i \{[^}]*background: var\(--ok-700\)/);
  assert.match(CSS, /\.cph-sp-btn\.crit i \{[^}]*background: var\(--crit-700\)/);
});
