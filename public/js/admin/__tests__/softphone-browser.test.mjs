// SOFTPHONE_V1 (2026-10-29) — браузер для телефона Easy-Med (softphone-browser.js):
// один телефон на страницу, подмена для стендов, «пустой» телефон без браузера,
// звук собеседника в одном скрытом <audio> (повторные attachRemote ничего не
// трогают), замок вкладки без Web Locks, причины и итог звонка словами на трёх
// языках. Причины звонка — ровно те строки, что в JsSIP 3.13.9 (берём из бандла).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Глобальные объекты браузера: i18n.js читает их при загрузке ──────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
store.set('admin.lang', 'ru');
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const setNavigator = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true, enumerable: true });
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.document = { documentElement: { lang: 'ru' } };
setNavigator({ languages: ['ru'], language: 'ru' });

const B = await import('../softphone-browser.js');
const { setLang } = await import('../i18n.js');

// ── Причины конца звонка — из самого JsSIP ───────────────────────────────────
const bundle = fs.readFileSync(path.join(HERE, '..', '..', 'vendor', 'jssip-3.13.9.mjs'), 'utf8');
const causesSrc = /causes:\{([^}]*)\}/.exec(bundle);
assert.ok(causesSrc, 'в бандле JsSIP нет таблицы causes');
const C = Object.fromEntries([...causesSrc[1].matchAll(/([A-Z_]+):"([^"]*)"/g)].map((m) => [m[1], m[2]]));

const CYR = /[Ѐ-ӿ]/;

// ── Подставной браузер ───────────────────────────────────────────────────────
class FakeStream { constructor(tracks) { this.tracks = [...tracks]; } getTracks() { return this.tracks; } }
function makeDoc() {
  const made = [];
  const body = { children: [], appendChild(el) { this.children.push(el); return el; } };
  return {
    made, body, documentElement: { lang: 'ru' },
    createElement(tag) {
      const el = {
        tag, attrs: {}, style: {}, autoplay: false, paused: true, plays: 0, sets: [], sinks: [],
        setAttribute(k, v) { this.attrs[k] = String(v); },
        play() { this.plays++; return Promise.reject(Object.assign(new Error('autoplay'), { name: 'NotAllowedError' })); },
        setSinkId(id) { this.sinks.push(id); return Promise.reject(new Error('no such device')); },
      };
      let src = null;
      Object.defineProperty(el, 'srcObject', { get() { return src; }, set(v) { src = v; el.sets.push(v); }, enumerable: true });
      made.push(el);
      return el;
    },
  };
}
const audio = (id) => ({ id, kind: 'audio' });
const video = (id) => ({ id, kind: 'video' });
const pcOf = (tracks) => ({ tracks, getReceivers() { return this.tracks.map((track) => ({ track })); } });
const tick = () => new Promise((r) => setImmediate(r));

// ── Один телефон на страницу ─────────────────────────────────────────────────
test('подмена для стендов: getSoftphone и peekSoftphone отдают её; null снимает', () => {
  const fake = { get: () => ({ state: 'off' }) };
  B.setSoftphoneForTests(fake);
  assert.equal(B.getSoftphone(), fake);
  assert.equal(B.getSoftphone(), fake);
  assert.equal(B.peekSoftphone(), fake);
  B.setSoftphoneForTests(null);
  assert.equal(B.peekSoftphone(), null, 'подмена снята, а свой телефон ещё никто не создавал');
});

test('без браузера (нет window/navigator/document) — пустой телефон, и он не запоминается', async () => {
  const keep = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator };
  delete globalThis.window;
  delete globalThis.document;
  setNavigator(undefined);
  try {
    const sp = B.getSoftphone();
    assert.ok(Object.isFrozen(sp));
    assert.deepEqual(sp.get(), { state: 'off', reason: '', message: '', code: '', extension: '', call: null, lastEnd: null });
    assert.equal(sp.wanted(), false);
    assert.equal(sp.busy(), false);
    await sp.enable();
    const unsub = sp.subscribe(() => { throw new Error('пустой телефон не зовёт подписчиков'); });
    assert.equal(typeof unsub, 'function');
    unsub();
    for (const m of ['disable', 'call', 'answer', 'decline', 'hangup', 'setMuted']) assert.doesNotThrow(() => sp[m]('1'), m);
    assert.equal(B.peekSoftphone(), null, 'пустой телефон — не экземпляр страницы');
  } finally {
    globalThis.window = keep.window;
    globalThis.document = keep.document;
    setNavigator(keep.navigator);
  }
});

test('peekSoftphone() телефон не создаёт', () => {
  assert.equal(B.peekSoftphone(), null);
  assert.equal(B.peekSoftphone(), null);
});

// ── Звук собеседника ─────────────────────────────────────────────────────────
test('attachRemote: один <audio> на страницу, srcObject — только когда сменились дорожки', async () => {
  const doc = makeDoc();
  const m = B.browserMedia(doc, { mediaDevices: { getUserMedia: async () => ({}) } }, { isSecureContext: true, MediaStream: FakeStream });
  assert.equal(doc.made.length, 0, 'до звонка <audio> не нужен');
  const a1 = audio('a1');
  const pc = pcOf([a1, video('v1')]);
  m.attachRemote(pc); m.attachRemote(pc); m.attachRemote(pc);
  assert.equal(doc.made.length, 1, 'элемент создан один раз');
  const el = doc.made[0];
  assert.equal(el.tag, 'audio');
  assert.equal(el.autoplay, true);
  assert.ok('data-softphone-remote' in el.attrs);
  assert.deepEqual(doc.body.children, [el], 'и добавлен в body один раз');
  assert.equal(el.sets.length, 1, 'srcObject поставлен один раз');
  assert.ok(el.srcObject instanceof FakeStream);
  assert.deepEqual(el.srcObject.getTracks(), [a1], 'только звук, без видео');
  await tick(); // отказ play() (автозапуск) проглочен — иначе здесь был бы unhandledRejection

  // Дорожка того же звонка пришла заново (тот же объект в новом приёмнике) — ничего не меняем.
  m.attachRemote(pcOf([a1]));
  assert.equal(el.sets.length, 1);

  // Новая дорожка — поток заменён.
  const a2 = audio('a2');
  pc.tracks.push(a2);
  m.attachRemote(pc);
  assert.equal(el.sets.length, 2);
  assert.deepEqual(el.srcObject.getTracks(), [a1, a2]);
  m.attachRemote(pc);
  assert.equal(el.sets.length, 2);

  // Конец звонка — тишина; следующий звонок ставит поток заново в тот же элемент.
  m.detachRemote();
  assert.equal(el.srcObject, null);
  m.attachRemote(pcOf([audio('b1')]));
  assert.equal(doc.made.length, 1);
  assert.equal(el.sets.length, 4);
  await tick();
});

test('attachRemote: соединение без дорожек и без getReceivers — без ошибок и без <audio>', () => {
  const doc = makeDoc();
  const m = B.browserMedia(doc, {}, { isSecureContext: true, MediaStream: FakeStream });
  assert.doesNotThrow(() => m.attachRemote(null));
  assert.doesNotThrow(() => m.attachRemote({}));
  assert.doesNotThrow(() => m.attachRemote(pcOf([])));
  assert.doesNotThrow(() => m.detachRemote());
  assert.equal(doc.made.length, 0);
});

test('динамик: setSinkId, если браузер умеет; ошибка проглочена; выбор до звонка применяется к новому <audio>', async () => {
  const doc = makeDoc();
  const m = B.browserMedia(doc, {}, { isSecureContext: true, MediaStream: FakeStream });
  await m.setSink('spk-1'); // элемента ещё нет — только запомнили
  assert.equal(doc.made.length, 0);
  m.attachRemote(pcOf([audio('a1')]));
  const el = doc.made[0];
  assert.deepEqual(el.sinks, ['spk-1']);
  await m.setSink('spk-2'); // setSinkId отвечает отказом — не бросаем
  assert.deepEqual(el.sinks, ['spk-1', 'spk-2']);
  delete el.setSinkId; // браузер без выбора динамика
  await assert.doesNotReject(m.setSink('spk-3'));
  await tick();
});

test('микрофон: http без настройки компьютера (нет mediaDevices) — «небезопасно», а не отказ микрофона', async () => {
  const doc = makeDoc();
  const http = B.browserMedia(doc, {}, { isSecureContext: false, MediaStream: FakeStream });
  assert.equal(http.isSecureContext, false);
  const odd = B.browserMedia(doc, {}, { isSecureContext: true, MediaStream: FakeStream });
  assert.equal(odd.isSecureContext, false, 'без mediaDevices микрофона нет — честнее «настройте компьютер»');
  await assert.rejects(odd.getUserMedia({ audio: true }), (e) => e.name === 'NotSupportedError');
  const seen = [];
  const win = { isSecureContext: true, MediaStream: FakeStream };
  const ok = B.browserMedia(doc, { mediaDevices: { getUserMedia: async (c) => { seen.push(c); return 'stream'; } } }, win);
  assert.equal(ok.isSecureContext, true);
  win.isSecureContext = false;
  assert.equal(ok.isSecureContext, false, 'читается каждый раз, а не один раз при создании');
  assert.equal(await ok.getUserMedia({ audio: true }), 'stream');
  assert.deepEqual(seen, [{ audio: true }]);
});

test('замок вкладки: Web Locks, если есть; иначе замок даётся сразу', async () => {
  const real = { request() {} };
  assert.equal(B.browserLocks({ locks: real }), real);
  const fb = B.browserLocks({});
  assert.equal(await fb.request('easymed-softphone', { ifAvailable: true }, (l) => l && l.name), 'easymed-softphone');
  let released = false;
  const held = fb.request('easymed-softphone', { ifAvailable: true }, () => new Promise((r) => setImmediate(() => { released = true; r('done'); })));
  assert.equal(await held, 'done', 'запрос решается, когда отпущен замок — как у Web Locks');
  assert.equal(released, true);
  for (const nav of [undefined, { locks: null }, { locks: {} }]) {
    assert.equal(await B.browserLocks(nav).request('x', {}, (l) => l.name), 'x', 'старый браузер — замок без очереди');
  }
});

test('выбранная гарнитура: savedDevice читает localStorage и не падает без него', () => {
  store.set('easymed.softphone.in', 'mic-7');
  assert.equal(B.savedDevice('in'), 'mic-7');
  assert.equal(B.savedDevice('out'), '');
  const keep = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('SecurityError'); } };
  try { assert.equal(B.savedDevice('in'), ''); } finally { globalThis.localStorage = keep; store.delete('easymed.softphone.in'); }
});

test('JsSIP грузится по требованию из vendor', async () => {
  const J = await B.loadJsSIP();
  assert.equal(typeof J.UA, 'function');
  assert.equal(typeof J.WebSocketInterface, 'function');
});

// ── Настоящий телефон страницы ───────────────────────────────────────────────
test('getSoftphone() в браузере: настоящий телефон, один на страницу, провода — браузерные', async () => {
  const doc = makeDoc();
  const gum = [];
  let gumError = null;
  const keep = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, fetch: globalThis.fetch };
  // Вошедший сотрудник — флаг включения хранится с его номером (задача 8).
  globalThis.window = { isSecureContext: false, MediaStream: FakeStream, dispatchEvent() {}, addEventListener() {}, easymed: { state: { user: { id: 5 } } } };
  globalThis.document = doc;
  setNavigator({ languages: ['ru'], mediaDevices: { getUserMedia: async (c) => { gum.push(c); if (gumError) throw gumError; return { getTracks: () => [] }; } } }); // без navigator.locks
  const rpcs = [];
  globalThis.fetch = async (url, init) => {
    rpcs.push([url, JSON.parse(init.body)]);
    return { ok: false, status: 403, json: async () => ({ error: { message: 'Телефон Easy-Med включается только на внутреннем номере, который администратор назначил вам в карточке сотрудника.' } }) };
  };
  store.set('easymed.softphone.in', 'mic-7');
  try {
    const sp = B.getSoftphone();
    assert.equal(B.getSoftphone(), sp, 'один на страницу');
    assert.equal(B.peekSoftphone(), sp);
    assert.equal(Object.isFrozen(sp), false, 'это не пустой телефон');
    assert.equal(sp.get().state, 'off');
    assert.equal(sp.wanted(), false);

    // http без настройки компьютера → «insecure»; флаг включения запомнен в localStorage — у сотрудника.
    await sp.enable();
    assert.equal(sp.get().state, 'error');
    assert.equal(sp.get().reason, 'insecure');
    assert.equal(sp.wanted(), true);
    assert.equal(store.get('easymed.softphone.on.5'), '1');

    // Микрофон — через navigator.mediaDevices, выбранный в панели (localStorage).
    globalThis.window.isSecureContext = true;
    gumError = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    await sp.enable();
    assert.equal(sp.get().reason, 'mic_denied');
    assert.deepEqual(gum.at(-1), { audio: { deviceId: { ideal: 'mic-7' } }, video: false });

    // Вход — RPC через supabase.rpc (/api/rpc/…); отказ сервера — его словами.
    gumError = null;
    await sp.enable();
    assert.deepEqual(rpcs, [['/api/rpc/telephony_webrtc_me', {}]]);
    assert.equal(sp.get().reason, 'server');
    assert.match(B.reasonText(sp.get().reason, sp.get().message), /назначил вам в карточке сотрудника/);

    sp.disable();
    assert.equal(sp.wanted(), false);
    assert.equal(sp.get().state, 'off');
    assert.equal(doc.made.length, 0, 'без звонка <audio> не создаётся');
  } finally {
    globalThis.window = keep.window;
    globalThis.document = keep.document;
    setNavigator(keep.navigator);
    globalThis.fetch = keep.fetch;
    store.delete('easymed.softphone.in');
  }
});

// ── Слова ────────────────────────────────────────────────────────────────────
const RU_REASONS = {
  insecure: 'Микрофон на этом компьютере закрыт браузером: один раз запустите файл настройки компьютера EasyMed-ustanovka.cmd от имени администратора, затем закройте все окна браузера и откройте Easy-Med заново. Этот же файл включает и звук звонка.',
  mic_denied: 'Браузер не дал микрофон: разрешите его значком слева от адреса страницы и включите телефон снова.',
  no_mic: 'Микрофон не найден: подключите гарнитуру и включите телефон снова.',
  mic_error: 'Микрофон не открылся. Проверьте гарнитуру и включите телефон снова.',
  other_tab: 'Телефон включён в другой вкладке Easy-Med. Чтобы пользоваться им здесь, выключите его в той вкладке.',
  register_failed: 'АТС не приняла вход вашего внутреннего номера. Попросите администратора проверить номер в карточке сотрудника или попробуйте позже.',
  network: 'Нет связи с АТС — переподключаемся…',
  load_failed: 'Не удалось загрузить телефон. Обновите страницу.',
  server: 'Телефония ответила ошибкой. Попробуйте ещё раз через минуту.',
};

test('причины словами — каждый код', () => {
  setLang('ru');
  for (const [code, text] of Object.entries(RU_REASONS)) assert.equal(B.reasonText(code), text, code);
  assert.equal(B.reasonText('server', 'Слова сервера'), 'Слова сервера', 'сервер объяснил сам — его слова');
  assert.equal(B.reasonText('insecure', 'не показывать'), RU_REASONS.insecure, 'текст ошибки браузера не показываем');
  assert.equal(B.reasonText('что-то новое'), '');
  assert.equal(B.reasonText(''), '');
  assert.equal(B.reasonText(undefined), '');
  // Шаблон, который ищет панель (план задачи 5).
  assert.match(B.reasonText('insecure'), /EasyMed-ustanovka\.cmd/);
});

// Ревью 09094415 (C): до сервера Easy-Med не дошли (код unreachable) — в
// сообщении был бы текст ошибки браузера («TypeError: Failed to fetch»); вместо
// него — наша фраза. Прочие коды сервера — по-прежнему его слова.
test('до сервера Easy-Med не дошли (unreachable) — наша фраза на трёх языках, а не текст ошибки браузера', () => {
  const UNREACHABLE = 'Нет связи с сервером Easy-Med. Повторим автоматически.';
  try {
    setLang('ru');
    assert.equal(B.reasonText('server', 'TypeError: Failed to fetch', 'unreachable'), UNREACHABLE);
    assert.equal(B.reasonText('server', '', 'unreachable'), UNREACHABLE);
    assert.equal(B.reasonText('server', 'Слова сервера', 'station_unavailable'), 'Слова сервера', 'прочие коды — слова сервера');
    assert.equal(B.reasonText('server', 'Слова сервера'), 'Слова сервера');
    for (const lang of ['uz', 'en']) {
      setLang(lang);
      const s = B.reasonText('server', 'TypeError: Failed to fetch', 'unreachable');
      assert.ok(s && !CYR.test(s) && !/Failed to fetch/.test(s), lang + ': ' + s);
    }
    setLang('en');
    assert.equal(B.reasonText('server', 'TypeError: Failed to fetch', 'unreachable'), 'No connection to the Easy-Med server. We will retry automatically.');
  } finally {
    setLang('ru');
  }
});

const end = (direction, cause, media = null) => ({ direction, cause, media });

test('итог звонка: обычный конец и свой отбой — без строки', () => {
  setLang('ru');
  assert.equal(B.endText(null), '');
  assert.equal(B.endText(undefined), '');
  assert.equal(B.endText(end('in', C.BYE)), '', 'разговор закончился (Terminated)');
  assert.equal(B.endText(end('out', C.BYE)), '');
  assert.equal(B.endText(end('out', 'BYE')), '');
  assert.equal(B.endText(end('out', C.CANCELED)), '', 'оператор сам сбросил исходящий');
  assert.equal(B.endText(end('in', C.REJECTED)), '', 'оператор сам отклонил входящий');
  assert.equal(B.endText(end('in', '')), '');
});

test('итог звонка: причины JsSIP словами', () => {
  setLang('ru');
  assert.equal(C.BUSY, 'Busy'); // бандл и тест говорят об одном
  assert.equal(B.endText(end('out', C.BUSY)), 'Занято.');
  assert.equal(B.endText(end('out', C.REJECTED)), 'Собеседник отклонил звонок.');
  for (const c of [C.NO_ANSWER, C.UNAVAILABLE, C.REQUEST_TIMEOUT]) assert.equal(B.endText(end('out', c)), 'Не дозвонились.', c);
  for (const c of [C.NOT_FOUND, C.ADDRESS_INCOMPLETE]) assert.equal(B.endText(end('out', c)), 'Такого номера нет.', c);
  assert.equal(B.endText(end('out', C.CONNECTION_ERROR)), 'Связь с АТС прервалась.');
  assert.equal(B.endText(end('in', C.CONNECTION_ERROR)), 'Связь с АТС прервалась.');
  assert.equal(B.endText(end('in', C.CANCELED)), 'Пропущенный звонок.', 'звонивший положил трубку до ответа');
  assert.equal(B.endText(end('in', C.NO_ANSWER)), 'Пропущенный звонок.', 'не ответили за отведённое время');
  assert.equal(B.endText(end('out', C.RTP_TIMEOUT)), 'Звонок оборвался.', 'прочий сбой не молчит');
  assert.equal(B.endText(end('in', C.WEBRTC_ERROR)), 'Звонок оборвался.');
});

test('итог звонка: микрофон важнее причины', () => {
  setLang('ru');
  assert.equal(B.endText(end('in', C.USER_DENIED_MEDIA_ACCESS, 'mic_denied')), 'Звонок не принят: браузер не дал микрофон.');
  assert.equal(B.endText(end('out', C.USER_DENIED_MEDIA_ACCESS, 'no_mic')), 'Звонок не принят: микрофон не найден.');
  assert.equal(B.endText(end('in', C.USER_DENIED_MEDIA_ACCESS, 'mic_error')), 'Звонок не принят: микрофон не открылся.');
});

test('узбекский и английский экран: причины и итог звонка переведены (без кириллицы)', () => {
  try {
    for (const lang of ['uz', 'en']) {
      setLang(lang);
      for (const code of Object.keys(RU_REASONS)) {
        const s = B.reasonText(code);
        assert.ok(s && !CYR.test(s), lang + ' ' + code + ': ' + s);
      }
      for (const e of [end('out', C.BUSY), end('out', C.REJECTED), end('out', C.NO_ANSWER), end('out', C.NOT_FOUND),
        end('in', C.CONNECTION_ERROR), end('in', C.CANCELED), end('in', C.RTP_TIMEOUT),
        end('in', C.USER_DENIED_MEDIA_ACCESS, 'mic_denied'), end('in', C.USER_DENIED_MEDIA_ACCESS, 'no_mic'), end('in', C.USER_DENIED_MEDIA_ACCESS, 'mic_error')]) {
        const s = B.endText(e);
        assert.ok(s && !CYR.test(s), lang + ' ' + e.cause + ': ' + s);
      }
      assert.match(B.reasonText('insecure'), /EasyMed-ustanovka\.cmd/, lang + ': имя файла то же');
    }
    setLang('en');
    assert.equal(B.endText(end('out', C.BUSY)), 'Busy.');
    assert.equal(B.reasonText('other_tab'), 'The phone is turned on in another Easy-Med tab. To use it here, turn it off in that tab.');
    setLang('uz');
    assert.equal(B.reasonText('other_tab'), 'Telefon boshqa Easy-Med varag‘ida yoqilgan. Undan shu yerda foydalanish uchun o‘sha varaqda uni o‘chiring.');
  } finally {
    setLang('ru');
  }
});
