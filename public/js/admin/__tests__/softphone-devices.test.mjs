// SOFTPHONE_V1 (2026-10-29) — гарнитура телефона Easy-Med (softphone-browser.js,
// задача 7): список микрофонов и динамиков (с подписями и без, записи Chrome
// «по умолчанию»), умеет ли браузер выбрать динамик, выбор помнит компьютер,
// выбранный динамик применяется, как только появляется телефон страницы,
// проверка «запишем 5 секунд и проиграем» по фазам, её ошибки — теми же кодами,
// что у включения, отказ во время звонка, одна проверка за раз, подписка на
// «гарнитуру подключили/вынули». Браузер подставной.
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
const CYR = /[Ѐ-ӿ]/;

const dev = (kind, deviceId, label = '', groupId = '') => ({ kind, deviceId, label, groupId });
const navWith = (list) => ({ mediaDevices: { enumerateDevices: async () => list } });

// ── Список ───────────────────────────────────────────────────────────────────
test('список с подписями: только звук; записи Chrome «default»/«communications», повторяющие устройство, не показываются', async () => {
  const list = [
    dev('audioinput', 'default', 'По умолчанию — Гарнитура', 'g1'),
    dev('audioinput', 'communications', 'Связь — Гарнитура', 'g1'),
    dev('audioinput', 'mic-1', 'Headset Mic', 'g1'),
    dev('audioinput', 'mic-2', 'Webcam Mic', 'g2'),
    dev('videoinput', 'cam-1', 'Webcam', 'g2'),
    dev('audiooutput', 'default', 'По умолчанию — Гарнитура', 'g1'),
    dev('audiooutput', 'spk-1', 'Headset', 'g1'),
    dev('audiooutput', 'spk-2', 'Speakers', 'g3'),
  ];
  const r = await B.listDevices({ nav: navWith(list) });
  assert.deepEqual(r.inputs, [{ id: 'mic-1', label: 'Headset Mic' }, { id: 'mic-2', label: 'Webcam Mic' }]);
  assert.deepEqual(r.outputs, [{ id: 'spk-1', label: 'Headset' }, { id: 'spk-2', label: 'Speakers' }]);
});

test('список без подписей (до разрешения микрофона): «Микрофон 1», «Динамик 1»; «default», не повторяющий устройство, — первым «По умолчанию»; пустые id отброшены', async () => {
  const list = [
    dev('audioinput', 'default'), dev('audioinput', 'm-a', '', 'x'), dev('audioinput', 'm-b', '', 'y'), dev('audioinput', ''),
    dev('audiooutput', 'o-a', '', 'z'),
  ];
  const r = await B.listDevices({ nav: navWith(list) });
  assert.deepEqual(r.inputs, [{ id: 'default', label: 'По умолчанию' }, { id: 'm-a', label: 'Микрофон 1' }, { id: 'm-b', label: 'Микрофон 2' }]);
  assert.deepEqual(r.outputs, [{ id: 'o-a', label: 'Динамик 1' }]);
  try {
    for (const lang of ['uz', 'en']) {
      setLang(lang);
      const t = await B.listDevices({ nav: navWith(list) });
      for (const d of [...t.inputs, ...t.outputs]) assert.ok(!CYR.test(d.label), lang + ': ' + d.label);
    }
  } finally { setLang('ru'); }
});

test('список: нет mediaDevices или enumerateDevices бросает — пустые списки, без ошибки', async () => {
  for (const nav of [null, {}, { mediaDevices: {} }, { mediaDevices: { enumerateDevices: async () => { throw new Error('нет'); } } }]) {
    assert.deepEqual(await B.listDevices({ nav }), { inputs: [], outputs: [] });
  }
});

// ── Динамик ──────────────────────────────────────────────────────────────────
test('выбор динамика: есть setSinkId — можно; нет (Firefox) или нет окна — нельзя', () => {
  const Media = function () {};
  Media.prototype.setSinkId = function () {};
  assert.equal(B.canChooseOutput({ win: { HTMLMediaElement: Media } }), true);
  assert.equal(B.canChooseOutput({ win: { HTMLMediaElement: function () {} } }), false);
  assert.equal(B.canChooseOutput({ win: {} }), false);
  assert.equal(B.canChooseOutput({ win: null }), false);
});

test('выбор помнит компьютер: saveDevice пишет localStorage, пустой — «по умолчанию»; сбой хранилища не роняет', () => {
  B.saveDevice('in', 'mic-2');
  B.saveDevice('out', 'spk-2');
  assert.equal(store.get('easymed.softphone.in'), 'mic-2');
  assert.equal(B.savedDevice('out'), 'spk-2');
  B.saveDevice('in', '');
  assert.equal(store.has('easymed.softphone.in'), false);
  assert.equal(B.savedDevice('in'), '');
  const keep = globalThis.localStorage;
  globalThis.localStorage = { setItem() { throw new Error('QuotaExceeded'); }, removeItem() { throw new Error('x'); }, getItem() { return null; } };
  try { assert.doesNotThrow(() => B.saveDevice('in', 'x')); assert.doesNotThrow(() => B.saveDevice('in', '')); } finally { globalThis.localStorage = keep; store.delete('easymed.softphone.out'); }
});

test('динамик, выбранный в прошлый раз, применяется, как только создан телефон страницы; новый выбор — сразу; звук собеседника — через setSinkId', async () => {
  const made = [];
  const keep = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator };
  globalThis.window = { isSecureContext: true, MediaStream: class { constructor(t) { this.t = t; } getTracks() { return this.t; } }, dispatchEvent() {}, addEventListener() {} };
  globalThis.document = {
    documentElement: { lang: 'ru' },
    body: { appendChild(el) { return el; } },
    createElement(tag) {
      const el = { tag, style: {}, sinks: [], paused: true, setAttribute() {}, play() { return Promise.resolve(); }, setSinkId(id) { this.sinks.push(id); return Promise.resolve(); } };
      made.push(el);
      return el;
    },
  };
  setNavigator({ languages: ['ru'], mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
  store.set('easymed.softphone.out', 'spk-9');
  try {
    assert.equal(B.outputSink(), '', 'до телефона страницы выбирать некуда');
    B.getSoftphone();
    assert.equal(B.outputSink(), 'spk-9', 'сохранённый динамик не применён при создании телефона');
    await B.setOutputDevice('spk-2');
    assert.equal(B.outputSink(), 'spk-2');
    // Звук собеседника появляется — элемент получает выбранный динамик.
    const m = B.browserMedia(globalThis.document, globalThis.navigator, globalThis.window);
    await m.setSink('spk-2');
    m.attachRemote({ getReceivers: () => [{ track: { kind: 'audio' } }] });
    assert.deepEqual(made.at(-1).sinks, ['spk-2']);
  } finally {
    globalThis.window = keep.window;
    globalThis.document = keep.document;
    setNavigator(keep.navigator);
    store.delete('easymed.softphone.out');
  }
});

// ── «Гарнитуру подключили / вынули» ──────────────────────────────────────────
test('onDeviceChange: подписка на devicechange и отписка; без mediaDevices — пустая отписка', () => {
  const ls = new Set();
  const md = { addEventListener: (t, f) => { assert.equal(t, 'devicechange'); ls.add(f); }, removeEventListener: (t, f) => { ls.delete(f); } };
  let n = 0;
  const off = B.onDeviceChange(() => { n++; }, { nav: { mediaDevices: md } });
  assert.equal(ls.size, 1);
  for (const f of ls) f();
  assert.equal(n, 1);
  off();
  assert.equal(ls.size, 0, 'не отписались');
  const noop = B.onDeviceChange(() => {}, { nav: {} });
  assert.equal(typeof noop, 'function');
  assert.doesNotThrow(noop);
});

// ── Проверка гарнитуры ───────────────────────────────────────────────────────
/** Подставной браузер для проверки: микрофон, запись, проигрывание, ручные «секунды». */
function testEnv({ gumError = null, busy = false, recorder = true, data = 'chunk', startsInactive = false } = {}) {
  const e = { gum: [], stopped: 0, recStops: 0, revoked: [], audios: [], ticks: [], cleared: [], timeouts: [], clearedTimeouts: [], phases: [], subs: new Set(), busy };
  const track = { stop: () => { e.stopped++; } };
  e.env = {
    nav: { mediaDevices: { getUserMedia: async (c) => { e.gum.push(c); if (gumError) throw gumError; return { getTracks: () => [track] }; } } },
    MediaRecorder: recorder ? class {
      constructor(stream) { this.stream = stream; this.mimeType = 'audio/webm'; this.state = 'inactive'; }
      start() { if (!startsInactive) this.state = 'recording'; }
      stop() { e.recStops++; this.state = 'inactive'; this.ondataavailable({ data }); setImmediate(() => this.onstop()); }
    } : null,
    Blob: class { constructor(parts, o) { this.parts = parts; this.type = o.type; this.size = parts.length; } },
    URL: { createObjectURL: (b) => { e.blob = b; return 'blob:test'; }, revokeObjectURL: (u) => { e.revoked.push(u); } },
    Audio: class {
      constructor(src) { this.src = src; this.sinks = []; this.paused = true; e.audios.push(this); }
      setSinkId(id) { this.sinks.push(id); return Promise.resolve(); }
      play() { this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
    },
    setInterval: (fn) => { e.ticks.push(fn); return e.ticks.length; },
    clearInterval: (t) => { e.cleared.push(t); },
    setTimeout: (fn) => { e.timeouts.push(fn); return e.timeouts.length; }, clearTimeout: (h) => { e.clearedTimeouts.push(h); },
    // Телефон страницы: busy() по заказу, подписчики — как у настоящего.
    phone: { busy: () => e.busy, subscribe: (fn) => { e.subs.add(fn); return () => e.subs.delete(fn); } },
  };
  e.onPhase = (...a) => e.phases.push(a);
  e.second = () => { for (const f of [...e.ticks]) f(); };
  e.ring = () => { e.busy = true; for (const f of [...e.subs]) f({ state: 'ringing' }); };
  return e;
}
const flush = () => new Promise((r) => setImmediate(r));

test('проверка гарнитуры: «говорите» каждую секунду, микрофон закрыт до проигрывания, запись — в выбранный динамик, затем «готово»; ссылка на запись освобождена', { timeout: 5000 }, async () => {
  const t = testEnv();
  store.set('easymed.softphone.in', 'mic-2');
  store.set('easymed.softphone.out', 'spk-2');
  try {
    const run = B.micTest(3000, t.onPhase, t.env);
    await flush();
    assert.deepEqual(t.gum, [{ audio: { deviceId: { ideal: 'mic-2' } }, video: false }], 'микрофон не выбранный или не «ideal»');
    assert.deepEqual(t.phases, [['recording', 3]]);
    t.second(); assert.deepEqual(t.phases.at(-1), ['recording', 2]);
    t.second(); assert.deepEqual(t.phases.at(-1), ['recording', 1]);
    assert.equal(t.stopped, 0, 'микрофон закрыт раньше конца записи');
    t.second();
    await flush(); await flush();
    assert.equal(t.stopped, 1, 'микрофон не закрыт после записи');
    assert.equal(t.audios.length, 1);
    assert.equal(t.audios[0].src, 'blob:test');
    assert.deepEqual(t.audios[0].sinks, ['spk-2'], 'запись играет не в выбранный динамик');
    assert.deepEqual(t.blob.parts, ['chunk']);
    assert.deepEqual(t.phases.at(-1), ['playing']);
    t.audios[0].onended();
    assert.equal(await run, true);
    assert.deepEqual(t.phases.map((p) => p[0]), ['recording', 'recording', 'recording', 'playing', 'done']);
    assert.deepEqual(t.revoked, ['blob:test']);
  } finally {
    store.delete('easymed.softphone.in');
    store.delete('easymed.softphone.out');
  }
});

test('проверка гарнитуры: ошибки микрофона — теми же кодами, что у включения; без mediaDevices — «insecure»; без записи — mic_error', { timeout: 5000 }, async () => {
  const cases = [['NotAllowedError', 'mic_denied'], ['NotFoundError', 'no_mic'], ['OverconstrainedError', 'no_mic'], ['NotReadableError', 'mic_error'], ['', 'mic_error']];
  for (const [name, code] of cases) {
    const t = testEnv({ gumError: Object.assign(new Error('x'), { name }) });
    assert.equal(await B.micTest(3000, t.onPhase, t.env), false);
    assert.deepEqual(t.phases, [['error', code]], name);
  }
  const insecure = testEnv();
  insecure.env.nav = {};
  await B.micTest(3000, insecure.onPhase, insecure.env);
  assert.deepEqual(insecure.phases, [['error', 'insecure']]);
  const noRec = testEnv({ recorder: false });
  await B.micTest(3000, noRec.onPhase, noRec.env);
  assert.deepEqual(noRec.phases, [['error', 'mic_error']]);
  assert.equal(noRec.stopped, 1, 'микрофон остался открытым');
});

test('проверка гарнитуры во время звонка — отказ «busy», микрофон звонка не трогаем', { timeout: 5000 }, async () => {
  const t = testEnv({ busy: true });
  assert.equal(await B.micTest(3000, t.onPhase, t.env), false);
  assert.deepEqual(t.phases, [['error', 'busy']]);
  assert.equal(t.gum.length, 0);
});

test('проверка гарнитуры — одна за раз; после конца — снова можно', { timeout: 5000 }, async () => {
  const t = testEnv();
  const first = B.micTest(1000, t.onPhase, t.env);
  const t2 = testEnv();
  assert.equal(await B.micTest(1000, t2.onPhase, t2.env), false, 'вторая проверка поверх первой');
  assert.equal(t2.gum.length, 0);
  await flush();
  t.second();
  await flush(); await flush();
  t.audios[0].onended();
  assert.equal(await first, true);
  const t3 = testEnv({ gumError: Object.assign(new Error('x'), { name: 'NotAllowedError' }) });
  await B.micTest(1000, t3.onPhase, t3.env);
  assert.equal(t3.gum.length, 1, 'после первой проверки вторая не началась');
});

// ── Проверку прерывают (ревью задачи 7) ──────────────────────────────────────
// Звонок пришёл или ушли с экрана — микрофон закрыт, запись не играет поверх
// звонка, ссылка освобождена, фаза 'cancelled'.
test('звонок во время записи: микрофон закрыт, запись остановлена, проигрывания нет — «cancelled»; подписка на телефон снята', { timeout: 5000 }, async () => {
  const t = testEnv();
  const run = B.micTest(3000, t.onPhase, t.env);
  await flush();
  assert.deepEqual(t.phases, [['recording', 3]]);
  assert.equal(t.subs.size, 1, 'проверка не следит за телефоном');
  t.ring();
  assert.equal(await run, false);
  assert.deepEqual(t.phases.at(-1), ['cancelled']);
  assert.equal(t.stopped, 1, 'микрофон остался открытым');
  assert.equal(t.recStops, 1, 'запись не остановлена');
  assert.ok(t.cleared.length >= 1, 'секунды идут дальше');
  t.second(); await flush(); await flush();
  assert.equal(t.audios.length, 0, 'запись заиграла поверх звонка');
  assert.equal(t.subs.size, 0);
});

test('прервали через AbortSignal (ушли с экрана) во время проигрывания: звук остановлен, ссылка освобождена', { timeout: 5000 }, async () => {
  const t = testEnv();
  const ac = new AbortController();
  const run = B.micTest(1000, t.onPhase, { ...t.env, signal: ac.signal });
  await flush();
  t.second();
  await flush(); await flush();
  assert.deepEqual(t.phases.at(-1), ['playing']);
  assert.equal(t.audios[0].paused, false);
  ac.abort();
  assert.equal(await run, false);
  assert.equal(t.audios[0].paused, true, 'запись играет дальше');
  assert.ok(t.clearedTimeouts.includes(t.timeouts.length), 'срок проигрывания остался взведённым после прерывания');
  assert.deepEqual(t.phases.at(-1), ['cancelled']);
  assert.deepEqual(t.revoked, ['blob:test']);
});

test('прервали ещё до микрофона (сигнал уже снят) — микрофон не держим', { timeout: 5000 }, async () => {
  const t = testEnv();
  const ac = new AbortController();
  ac.abort();
  assert.equal(await B.micTest(1000, t.onPhase, { ...t.env, signal: ac.signal }), false);
  assert.deepEqual(t.phases, [['cancelled']]);
  assert.equal(t.stopped, t.gum.length, 'микрофон открыт и не закрыт');
});

test('ничего не записалось — «mic_error», а не «готово»; запись, которая уже не идёт, повторно не останавливаем', { timeout: 5000 }, async () => {
  const empty = testEnv({ data: null });
  const run = B.micTest(1000, empty.onPhase, empty.env);
  await flush(); empty.second(); await flush(); await flush();
  assert.equal(await run, false);
  assert.deepEqual(empty.phases.at(-1), ['error', 'mic_error']);
  assert.equal(empty.audios.length, 0);
  const idle = testEnv({ startsInactive: true });
  const run2 = B.micTest(1000, idle.onPhase, idle.env);
  await flush(); idle.second(); await flush(); await flush();
  assert.equal(await run2, false);
  assert.equal(idle.recStops, 0, 'stop() у неактивной записи');
  assert.deepEqual(idle.phases.at(-1), ['error', 'mic_error']);
});

test('запись не сообщила о конце — по сроку звук остановлен, ссылка освобождена', { timeout: 5000 }, async () => {
  const t = testEnv();
  const run = B.micTest(1000, t.onPhase, t.env);
  await flush(); t.second(); await flush(); await flush();
  assert.deepEqual(t.phases.at(-1), ['playing']);
  t.timeouts.at(-1)();   // срок ms + 3 с
  assert.equal(await run, true);
  assert.equal(t.audios[0].paused, true, 'по сроку звук не остановлен');
  assert.deepEqual(t.revoked, ['blob:test']);
});
