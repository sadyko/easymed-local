// SOFTPHONE_V1 (2026-10-29) — состояние телефона поверх JsSIP: подставной JsSIP,
// подставные микрофон, замок вкладки, хранилище и RPC. Браузер не нужен.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSoftphone, SP, SP_FLAG } from '../softphone.js';

const tick = () => new Promise((r) => setImmediate(r));

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

class Emitter { constructor() { this.h = {}; } on(n, f) { (this.h[n] ||= []).push(f); return this; } emit(n, e) { for (const f of this.h[n] || []) f(e); } }
// terminate() — как у JsSIP: до ответа сразу 'failed' (входящий — Rejected,
// исходящий — Canceled), в разговоре — 'ended' (Terminated); у завершённой
// сессии — InvalidStateError.
class FakeSession extends Emitter {
  constructor(dir, number) { super(); this.direction = dir; this.remote_identity = { uri: { user: number } }; this.done = []; this.status = 'new'; }
  emit(n, e) {
    if (n === 'accepted' || n === 'confirmed') this.status = 'confirmed';
    if (n === 'ended' || n === 'failed') this.status = 'terminated';
    super.emit(n, e);
  }
  answer(o) { this.done.push(['answer', o]); }
  terminate(o) {
    this.done.push(['terminate', o]);
    if (this.status === 'terminated') throw Object.assign(new Error('Invalid status: 8'), { name: 'InvalidStateError' });
    if (this.status === 'confirmed') this.emit('ended', { originator: 'local', cause: 'Terminated' });
    else this.emit('failed', { originator: 'local', cause: this.direction === 'incoming' ? 'Rejected' : 'Canceled' });
  }
  mute(o) { this.done.push(['mute', o]); } unmute(o) { this.done.push(['unmute', o]); }
}
class FakePC {
  constructor() { this.l = {}; }
  addEventListener(n, f) { (this.l[n] ||= []).push(f); }
  fire(n, e = {}) { for (const f of this.l[n] || []) f(e); }
  getReceivers() { return []; }
}
function makeJsSIP({ withConnection = false } = {}) {
  const made = [];
  class UA extends Emitter { constructor(cfg) { super(); this.cfg = cfg; this.started = false; this.connected = true; this.isReg = false; this.registers = 0; made.push(this); } start() { this.started = true; } stop() { this.stopped = true; }
    isConnected() { return this.connected; } isRegistered() { return this.isReg; } register() { this.registers++; }
    call(target, o) { const s = new FakeSession('outgoing', target); s.target = target; s.opts = o; if (withConnection) s.connection = new FakePC(); this.lastCall = s; return s; } }
  class WebSocketInterface { constructor(url) { this.url = url; } }
  return { JsSIP: { UA, WebSocketInterface }, made };
}
const CREDS = { extension: '108', user: '108', password: 'secret', ws_url: 'wss://pbx.example:8082', sip_domain: 'pbx.example' };

function makeMedia(over = {}) {
  const log = [];
  return {
    log,
    isSecureContext: true,
    getUserMedia: async (c) => { log.push(['gum', c]); return { getTracks: () => [{ stop() { log.push(['stop']); } }] }; },
    attachRemote: (pc) => log.push(['attach', pc]),
    detachRemote: () => log.push(['detach']),
    ...over,
  };
}

// Замок по образцу Web Locks: ifAvailable → null, если занят; обычный запрос ждёт
// очереди; signal снимает запрос из очереди (запрос отвечает AbortError); замок
// держится, пока не решится обещание, которое вернул обработчик; обещание самого
// request() решается, когда замок уже отпущен. Обработчик, как в браузере,
// зовётся НЕ внутри request(), а позже (setImmediate).
// closeHolder() — вкладку, что держит замок, закрыли: браузер отпускает её замок сам.
function makeLocks() {
  let held = false; let close = null; let requested = 0; const queue = [];
  const grant = (item) => {
    held = true;
    const closed = new Promise((r) => { close = r; });
    const done = (fn) => (v) => { held = false; close = null; const next = queue.shift(); if (next) grant(next); fn(v); };
    setImmediate(() => {
      Promise.race([Promise.resolve().then(() => item.cb({ name: 'easymed-softphone' })), closed]).then(done(item.resolve), done(item.reject));
    });
  };
  return {
    get held() { return held; },
    get queued() { return queue.length; },
    get requested() { return requested; },
    closeHolder() { if (close) close(); },
    request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      requested++;
      return new Promise((resolve, reject) => {
        const item = { cb, resolve, reject };
        if (!held) { grant(item); return; }
        if (opts.ifAvailable) { setImmediate(() => Promise.resolve().then(() => cb(null)).then(resolve, reject)); return; }
        queue.push(item);
        opts.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(item);
          if (i >= 0) { queue.splice(i, 1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
        });
      });
    },
  };
}

// Подставные часы для повторного входа: таймеры не идут сами, fire() запускает.
function makeTimers() {
  const list = new Map(); let id = 0;
  return {
    setTimer: (fn, ms) => { const t = ++id; list.set(t, { fn, ms }); return t; },
    clearTimer: (t) => { list.delete(t); },
    get count() { return list.size; },
    get delays() { return [...list.values()].map((x) => x.ms); },
    fire() { const all = [...list.values()]; list.clear(); for (const x of all) x.fn(); },
  };
}

function deps(over = {}, { withConnection = false } = {}) {
  const { JsSIP, made } = makeJsSIP({ withConnection });
  const store = new Map();
  const media = makeMedia();
  const calls = { rpc: [], load: 0 };
  const timers = makeTimers();
  return {
    made, store, media, calls, JsSIP, timers,
    d: {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      loadJsSIP: async () => { calls.load++; return JsSIP; },
      rpc: async (name, args) => { calls.rpc.push([name, args]); return name === 'telephony_webrtc_me' ? { data: { ...CREDS }, error: null } : { data: null, error: { message: 'x' } }; },
      media,
      locks: makeLocks(),
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
      now: () => 1000,
      ...over,
    },
  };
}

async function ready(over, opts) {
  const x = deps(over, opts);
  const sp = createSoftphone(x.d);
  await sp.enable();
  x.made[0].emit('registered');
  return { ...x, sp, ua: x.made[0] };
}

test('enable: проверка микрофона → вход своим номером → «готов»', async () => {
  const { d, made, store, calls, media } = deps();
  const sp = createSoftphone(d);
  assert.equal(sp.wanted(), false);
  await sp.enable();
  assert.equal(made.length, 1);
  assert.equal(made[0].cfg.uri, 'sip:108@pbx.example');
  assert.equal(made[0].cfg.sockets[0].url, 'wss://pbx.example:8082');
  assert.equal(made[0].cfg.password, 'secret');
  assert.equal(made[0].cfg.register, true);
  assert.equal(made[0].cfg.session_timers, false);
  assert.equal(made[0].started, true);
  assert.deepEqual(calls.rpc, [['telephony_webrtc_me', {}]]);
  assert.equal(calls.load, 1);
  assert.deepEqual(media.log.slice(0, 2), [['gum', { audio: true, video: false }], ['stop']], 'пробный поток микрофона закрыт');
  assert.equal(sp.get().state, SP.CONNECTING);
  assert.equal(sp.get().extension, '108');
  made[0].emit('registered');
  assert.equal(sp.get().state, SP.READY);
  assert.equal(store.get(SP_FLAG), '1');
  assert.equal(sp.wanted(), true);
  assert.equal(sp.busy(), false);
});

test('JsSIP грузится только при включении', async () => {
  const { d, calls } = deps();
  const sp = createSoftphone(d);
  assert.equal(calls.load, 0);
  assert.equal(sp.get().state, SP.OFF);
  await sp.enable();
  assert.equal(calls.load, 1);
});

test('незащищённый адрес — ошибка insecure, в АТС не входим, замок отпущен', async () => {
  const { d, made, calls } = deps({ media: makeMedia({ isSecureContext: false, getUserMedia: async () => { throw new Error('no'); } }) });
  const sp = createSoftphone(d);
  await sp.enable();
  assert.deepEqual([sp.get().state, sp.get().reason], [SP.ERROR, 'insecure']);
  assert.equal(made.length, 0);
  assert.equal(calls.rpc.length, 0);
  await tick();
  assert.equal(d.locks.held, false);
});

test('микрофон запрещён / не найден / другое — свои причины, замок отпущен', async () => {
  for (const [name, reason] of [['NotAllowedError', 'mic_denied'], ['NotFoundError', 'no_mic'], ['OverconstrainedError', 'no_mic'], ['NotReadableError', 'mic_error']]) {
    const err = Object.assign(new Error(name), { name });
    const { d, made } = deps({ media: makeMedia({ getUserMedia: async () => { throw err; } }) });
    const sp = createSoftphone(d);
    await sp.enable();
    assert.deepEqual([sp.get().state, sp.get().reason], [SP.ERROR, reason]);
    assert.equal(made.length, 0);
    await tick();
    assert.equal(d.locks.held, false, reason);
  }
});

test('сервер отказал (нет номера) — ошибка server с его словами', async () => {
  const { d, made } = deps({ rpc: async () => ({ data: null, error: { message: 'Сначала выберите свой внутренний номер' } }) });
  const sp = createSoftphone(d);
  await sp.enable();
  assert.equal(sp.get().state, SP.ERROR);
  assert.equal(sp.get().reason, 'server');
  assert.match(sp.get().message, /внутренний номер/);
  assert.equal(made.length, 0);
  await tick();
  assert.equal(d.locks.held, false);
});

test('RPC бросил (нет сети до сервера) — ошибка server, замок отпущен', async () => {
  const { d, made, calls } = deps({ rpc: async () => { throw new Error('Failed to fetch'); } });
  const sp = createSoftphone(d);
  await sp.enable();
  assert.deepEqual([sp.get().state, sp.get().reason, sp.get().message], [SP.ERROR, 'server', 'Failed to fetch']);
  assert.equal(made.length, 0);
  assert.equal(calls.load, 0);
  await tick();
  assert.equal(d.locks.held, false);
});

// Финальное ревью (I1): панель повторяет вход сама, если сбой временный. Для этого
// состояние несёт код отказа сервера (code): station_unavailable — АТС не
// ответила; unreachable — до сервера не дошли (rpc бросил); прочее — как есть.
test('код отказа сервера — в состоянии (code): временный сбой АТС, «не дошли», постоянный отказ; удачный вход код сбрасывает', async () => {
  const cases = [
    [async () => ({ data: null, error: { message: 'Нет связи с телефонией.', code: 'station_unavailable' } }), 'station_unavailable'],
    [async () => ({ data: null, error: { message: 'Номер не назначен', code: 'forbidden' } }), 'forbidden'],
    [async () => { throw new Error('Failed to fetch'); }, 'unreachable'],
    [async () => ({ data: { ...CREDS, ws_url: '' }, error: null }), ''],
  ];
  for (const [rpc, code] of cases) {
    const { d } = deps({ rpc });
    const sp = createSoftphone(d);
    await sp.enable();
    assert.deepEqual([sp.get().state, sp.get().reason, sp.get().code], [SP.ERROR, 'server', code]);
  }
  // Ошибка с кодом, потом удачный вход — кода больше нет.
  let fail = true;
  const x = deps({ rpc: async () => (fail ? { data: null, error: { message: 'x', code: 'station_unavailable' } } : { data: { ...CREDS }, error: null }) });
  const sp = createSoftphone(x.d);
  await sp.enable();
  assert.equal(sp.get().code, 'station_unavailable');
  fail = false;
  await sp.enable();
  x.made[0].emit('registered');
  assert.deepEqual([sp.get().state, sp.get().code], [SP.READY, '']);
});

test('сервер вернул неполные данные входа — ошибка server, в АТС не входим', async () => {
  for (const missing of ['ws_url', 'user', 'sip_domain']) {
    const creds = { ...CREDS };
    delete creds[missing];
    const { d, made, calls } = deps({ rpc: async () => ({ data: creds, error: null }) });
    const sp = createSoftphone(d);
    await sp.enable();
    assert.deepEqual([sp.get().state, sp.get().reason], [SP.ERROR, 'server'], missing);
    assert.equal(made.length, 0, missing);
    assert.equal(calls.load, 0, missing);
    await tick();
    assert.equal(d.locks.held, false, missing);
  }
});

test('библиотека не загрузилась — load_failed, замок отпущен', async () => {
  const { d } = deps({ loadJsSIP: async () => { throw new Error('404'); } });
  const sp = createSoftphone(d);
  await sp.enable();
  assert.deepEqual([sp.get().state, sp.get().reason], [SP.ERROR, 'load_failed']);
  await tick();
  assert.equal(d.locks.held, false);
});

test('JsSIP не принял настройку — register_failed без текста ошибки (в нём мог быть пароль)', async () => {
  const { d, JsSIP } = deps();
  d.loadJsSIP = async () => ({ ...JsSIP, UA: class { constructor(cfg) { throw new Error('Invalid value "' + cfg.password + '" for parameter "password"'); } } });
  const sp = createSoftphone(d);
  await sp.enable();
  assert.deepEqual([sp.get().state, sp.get().reason], [SP.ERROR, 'register_failed']);
  assert.equal(JSON.stringify(sp.get()).includes('secret'), false);
  await tick();
  assert.equal(d.locks.held, false);
});

test('другая вкладка держит телефон — other_tab', async () => {
  const { d, made } = deps({ locks: { request: async (_n, o, cb) => cb(null) } });
  const sp = createSoftphone(d);
  await sp.enable();
  assert.deepEqual([sp.get().state, sp.get().reason], [SP.OTHER_TAB, 'other_tab']);
  assert.equal(made.length, 0);
});

test('двойное enable() без ожидания — один UA, без ложной «другой вкладки»', async () => {
  const { d, made } = deps();
  const sp = createSoftphone(d);
  const seen = [];
  sp.subscribe((s) => seen.push(s.state));
  const a = sp.enable();
  const b = sp.enable();
  await Promise.all([a, b]);
  await tick();
  assert.equal(made.length, 1);
  assert.equal(seen.includes(SP.OTHER_TAB), false);
  assert.equal(sp.get().state, SP.CONNECTING);
  await sp.enable();
  assert.equal(made.length, 1, 'включённый телефон не входит второй раз');
});

// Двойной щелчок по переключателю: замок ещё не пришёл, а телефон уже выключили.
async function untilRequested(locks) {
  for (let i = 0; i < 50 && !locks.requested; i++) await Promise.resolve();
  assert.equal(locks.requested, 1, 'запрос замка ушёл');
}

test('enable(); disable() сразу — off, UA нет, замок свободен, в очереди пусто', async () => {
  const { d, made, calls } = deps();
  const sp = createSoftphone(d);
  sp.enable(); sp.disable();
  await settle();
  assert.equal(sp.get().state, SP.OFF);
  assert.equal(made.length, 0);
  assert.equal(calls.rpc.length, 0);
  assert.equal(d.locks.held, false);
  assert.equal(d.locks.queued, 0);
});

test('enable(); disable(), пока ответ замка в пути — замок отдан сразу, UA нет', async () => {
  const { d, made, calls } = deps();
  const sp = createSoftphone(d);
  sp.enable();
  await untilRequested(d.locks);
  assert.equal(d.locks.held, true, 'замок выдан, обработчик ещё не позван');
  sp.disable();
  await settle();
  assert.equal(sp.get().state, SP.OFF);
  assert.equal(made.length, 0);
  assert.equal(calls.rpc.length, 0);
  assert.equal(d.locks.held, false);
  assert.equal(d.locks.queued, 0);
});

test('enable(); disable(); enable() — ровно один UA, без «другой вкладки»', async () => {
  for (const inFlight of [false, true]) {
    const { d, made } = deps();
    const sp = createSoftphone(d);
    const seen = [];
    sp.subscribe((s) => seen.push(s.state));
    sp.enable();
    if (inFlight) await untilRequested(d.locks);
    sp.disable();
    const p = sp.enable();
    await p;
    await settle();
    assert.equal(made.length, 1, 'inFlight=' + inFlight);
    assert.equal(made[0].started, true);
    assert.equal(seen.includes(SP.OTHER_TAB), false, 'inFlight=' + inFlight);
    assert.equal(sp.get().state, SP.CONNECTING);
    assert.equal(d.locks.held, true);
  }
});

test('disable() и снова enable(), пока первое включение ждёт сервер — новое включение, один UA', async () => {
  const answers = [];
  const { d, made } = deps({ rpc: () => new Promise((r) => { answers.push(r); }) });
  const sp = createSoftphone(d);
  sp.enable();
  await settle();
  assert.equal(answers.length, 1);
  sp.disable();
  const p = sp.enable();
  await settle();
  assert.equal(answers.length, 2, 'второе включение дошло до сервера само');
  answers[0]({ data: { ...CREDS }, error: null });
  answers[1]({ data: { ...CREDS }, error: null });
  await p;
  await settle();
  assert.equal(made.length, 1);
  assert.equal(sp.get().state, SP.CONNECTING);
});

test('подписчик зовёт enable() из первого уведомления — то же включение', async () => {
  const { sp, ua, made } = await ready();
  ua.emit('registrationFailed', { cause: 'Authentication Error' }); // повтор пойдёт со своим замком — без ожиданий
  let inner = null;
  sp.subscribe((s) => { if (s.state === SP.CONNECTING && !inner) inner = sp.enable(); });
  const outer = sp.enable();
  await outer;
  await settle();
  assert.equal(inner, outer);
  assert.equal(made.length, 2);
  assert.equal(sp.get().state, SP.CONNECTING);
});

test('disable() пока enable() ждёт сервер — UA не создан, состояние off, замок отпущен', async () => {
  let answer;
  const { d, made, calls } = deps({ rpc: () => new Promise((r) => { answer = r; }) });
  const sp = createSoftphone(d);
  const p = sp.enable();
  await settle();
  assert.equal(typeof answer, 'function', 'дошли до RPC');
  sp.disable();
  answer({ data: { ...CREDS }, error: null });
  await p;
  await tick();
  assert.equal(made.length, 0);
  assert.equal(calls.load, 0);
  assert.equal(sp.get().state, SP.OFF);
  assert.equal(d.locks.held, false);
  assert.equal(sp.wanted(), false);
});

test('disable() пока грузится JsSIP — UA не создан и не запущен', async () => {
  let loaded;
  const { d, made, JsSIP } = deps();
  d.loadJsSIP = () => new Promise((r) => { loaded = () => r(JsSIP); });
  const sp = createSoftphone(d);
  const p = sp.enable();
  await settle();
  assert.equal(typeof loaded, 'function', 'дошли до загрузки JsSIP');
  sp.disable();
  loaded();
  await p;
  assert.equal(made.length, 0);
  assert.equal(sp.get().state, SP.OFF);
  await tick();
  assert.equal(d.locks.held, false);
});

test('выключили и сразу включили — без ложной «другой вкладки»', async () => {
  const { d, made } = deps();
  const sp = createSoftphone(d);
  const seen = [];
  sp.subscribe((s) => seen.push(s.state));
  await sp.enable(); made[0].emit('registered');
  sp.disable();
  await sp.enable();
  await tick();
  assert.equal(seen.includes(SP.OTHER_TAB), false);
  assert.equal(made.length, 2);
  assert.equal(made[0].stopped, true);
  assert.equal(sp.get().state, SP.CONNECTING);
});

test('входящий: звонит → принять → разговор → завершить → готов', async () => {
  const { sp, ua } = await ready();
  const s = new FakeSession('incoming', '998901112233');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  assert.equal(sp.get().state, SP.RINGING);
  assert.deepEqual(sp.get().call, { direction: 'in', number: '998901112233', startedAt: null, muted: false });
  assert.equal(sp.busy(), true);
  sp.answer();
  assert.equal(s.done[0][0], 'answer');
  s.emit('confirmed');
  assert.equal(sp.get().state, SP.IN_CALL);
  assert.equal(sp.get().call.startedAt, 1000);
  assert.equal(sp.busy(), true);
  sp.hangup();
  assert.equal(s.done.at(-1)[0], 'terminate');
  assert.equal(sp.get().state, SP.READY);
  assert.equal(sp.get().call, null);
  assert.deepEqual(sp.get().lastEnd, { direction: 'in', cause: 'Terminated', media: null });
  assert.equal(sp.busy(), false);
});

test('время начала разговора ставится один раз', async () => {
  let t = 1000;
  const { sp, ua } = await ready({ now: () => t });
  const seen = [];
  sp.subscribe((st) => seen.push(st.state));
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  sp.answer();
  s.emit('accepted');
  t = 5000;
  s.emit('confirmed');
  assert.equal(sp.get().call.startedAt, 1000);
  assert.deepEqual(seen, [SP.RINGING, SP.IN_CALL], 'accepted и confirmed — одна смена');
});

test('запоздалое событие прошлого звонка не трогает текущий', async () => {
  const { sp, ua } = await ready();
  const a = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: a });
  sp.answer(); a.emit('confirmed'); a.emit('ended');
  const b = new FakeSession('incoming', '222');
  ua.emit('newRTCSession', { originator: 'remote', session: b });
  a.emit('failed', {});
  a.emit('confirmed');
  assert.equal(sp.get().state, SP.RINGING);
  assert.equal(sp.get().call.number, '222');
});

test('входящий: отклонить — 603; второй входящий во время звонка — 486 «занято»', async () => {
  const { sp, ua } = await ready();
  const a = new FakeSession('incoming', '111111111');
  ua.emit('newRTCSession', { originator: 'remote', session: a });
  const b = new FakeSession('incoming', '222222222');
  ua.emit('newRTCSession', { originator: 'remote', session: b });
  assert.deepEqual(b.done[0], ['terminate', { status_code: 486, reason_phrase: 'Busy Here' }]);
  assert.equal(sp.get().call.number, '111111111');
  b.emit('failed', { cause: 'Busy' });
  assert.equal(sp.get().state, SP.RINGING, 'конец чужой сессии не трогает текущий звонок');
  sp.decline();
  assert.deepEqual(a.done[0], ['terminate', { status_code: 603, reason_phrase: 'Decline' }]);
  assert.equal(sp.get().state, SP.READY, 'JsSIP шлёт failed прямо из terminate()');
  assert.equal(sp.get().call, null);
  assert.deepEqual(sp.get().lastEnd, { direction: 'in', cause: 'Rejected', media: null });
});

test('входящий, пока наш исходящий ещё звонит, — 486, исходящий не тронут', async () => {
  const { sp, ua } = await ready();
  sp.call('901112233');
  const out = ua.lastCall;
  const inc = new FakeSession('incoming', '222');
  ua.emit('newRTCSession', { originator: 'remote', session: inc });
  assert.deepEqual(inc.done, [['terminate', { status_code: 486, reason_phrase: 'Busy Here' }]]);
  assert.deepEqual(out.done, []);
  assert.equal(sp.get().state, SP.CALLING);
  assert.deepEqual(sp.get().call, { direction: 'out', number: '901112233', startedAt: null, muted: false });
  out.emit('confirmed');
  assert.equal(sp.get().state, SP.IN_CALL);
});

test('decline() / hangup(): terminate() бросил — всё равно «готов»', async () => {
  for (const act of ['decline', 'hangup']) {
    const { sp, ua, media } = await ready();
    const s = new FakeSession('incoming', '111');
    s.terminate = () => { throw Object.assign(new Error('Invalid status: 8'), { name: 'InvalidStateError' }); };
    ua.emit('newRTCSession', { originator: 'remote', session: s });
    if (act === 'hangup') { sp.answer(); s.emit('confirmed'); }
    sp[act]();
    assert.equal(sp.get().state, SP.READY, act);
    assert.equal(sp.get().call, null, act);
    assert.deepEqual(media.log.at(-1), ['detach'], act);
  }
});

test('итог звонка (lastEnd): занято, отбой, микрофон; новый звонок сбрасывает', async () => {
  const { sp, ua } = await ready();
  sp.call('901112233');
  ua.lastCall.emit('failed', { originator: 'remote', cause: 'Busy' });
  assert.equal(sp.get().state, SP.READY);
  assert.deepEqual(sp.get().lastEnd, { direction: 'out', cause: 'Busy', media: null });
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  assert.equal(sp.get().lastEnd, null, 'новый звонок — итог прошлого убран');
  s.emit('failed', { originator: 'remote', cause: 'Canceled' });
  assert.deepEqual(sp.get().lastEnd, { direction: 'in', cause: 'Canceled', media: null });
});

test('ответили, а микрофона не дали — «готов», lastEnd.media mic_denied; getusermediafailed уточняет', async () => {
  const { sp, ua } = await ready();
  // JsSIP: getUserMedia внутри answer() не удался → сначала failed, потом getusermediafailed с ошибкой.
  const failingAnswer = (s, gumName) => {
    s.answer = (o) => {
      s.done.push(['answer', o]);
      s.emit('failed', { originator: 'local', cause: 'User Denied Media Access' });
      if (gumName) s.emit('getusermediafailed', Object.assign(new Error(gumName), { name: gumName }));
    };
    return s;
  };
  const cases = [[null, 'mic_denied'], ['NotAllowedError', 'mic_denied'], ['NotFoundError', 'no_mic'], ['OverconstrainedError', 'no_mic'], ['NotReadableError', 'mic_error']];
  const sessions = [];
  for (const [gumName, want] of cases) {
    const s = failingAnswer(new FakeSession('incoming', '111'), gumName);
    sessions.push(s);
    ua.emit('newRTCSession', { originator: 'remote', session: s });
    sp.answer();
    assert.equal(sp.get().state, SP.READY, String(gumName));
    assert.equal(sp.get().call, null);
    assert.deepEqual(sp.get().lastEnd, { direction: 'in', cause: 'User Denied Media Access', media: want }, String(gumName));
  }
  sessions[0].emit('getusermediafailed', Object.assign(new Error('x'), { name: 'NotFoundError' }));
  assert.equal(sp.get().lastEnd.media, 'mic_error', 'запоздалая ошибка прошлого звонка не трогает итог последнего');
});

test('answer() и decline() — только пока звонит', async () => {
  const { sp, ua } = await ready();
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  sp.answer();
  s.emit('confirmed');
  sp.answer();
  sp.decline();
  assert.deepEqual(s.done.map((x) => x[0]), ['answer']);
});

test('«Микрофон выкл.» — только в разговоре', async () => {
  const { sp, ua } = await ready();
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  sp.setMuted(true);
  assert.deepEqual(s.done, []);
  assert.equal(sp.get().call.muted, false);
  s.emit('ended');
  sp.setMuted(true);
  assert.equal(sp.get().call, null);
});

test('JsSIP отказал в ua.call сразу — call() false, остаёмся «готов»', async () => {
  const { sp, ua } = await ready();
  ua.call = () => { throw new Error('Invalid target'); };
  assert.equal(sp.call('901112233'), false);
  assert.equal(sp.get().state, SP.READY);
  assert.equal(sp.get().call, null);
});

test('исходящий: номер → sip:цифры@домен, звонок → разговор; микрофон выкл./вкл.', async () => {
  const { sp, ua } = await ready();
  assert.equal(sp.call('+998 90 111-22-33'), true);
  const s = ua.lastCall;
  assert.equal(s.target, 'sip:998901112233@pbx.example');
  assert.equal(sp.get().state, SP.CALLING);
  assert.deepEqual(sp.get().call, { direction: 'out', number: '998901112233', startedAt: null, muted: false });
  ua.emit('newRTCSession', { originator: 'local', session: s });
  s.emit('confirmed');
  assert.equal(sp.get().state, SP.IN_CALL);
  sp.setMuted(true);
  assert.deepEqual(s.done.at(-1), ['mute', { audio: true }]);
  assert.equal(sp.get().call.muted, true);
  sp.setMuted(false);
  assert.deepEqual(s.done.at(-1), ['unmute', { audio: true }]);
  assert.equal(sp.get().call.muted, false);
});

test('исходящий: JsSIP шлёт newRTCSession внутри ua.call — сессия подключается один раз', async () => {
  const { sp, ua } = await ready();
  const seen = [];
  sp.subscribe((st) => seen.push(st.state));
  const orig = ua.call.bind(ua);
  ua.call = (target, o) => { const s = orig(target, o); ua.emit('newRTCSession', { originator: 'local', session: s }); return s; };
  assert.equal(sp.call('901112233'), true);
  const s = ua.lastCall;
  assert.deepEqual(seen, [SP.CALLING], 'одна смена на звонок');
  assert.equal(s.h.confirmed.length, 1, 'обработчики навешены один раз');
  assert.equal(sp.get().call.number, '901112233');
});

test('call() — только когда «готов» и есть цифры', async () => {
  const { d, made } = deps();
  const sp = createSoftphone(d);
  assert.equal(sp.call('901112233'), false, 'выключен');
  await sp.enable();
  assert.equal(sp.call('901112233'), false, 'ещё подключается');
  made[0].emit('registered');
  assert.equal(sp.call('---'), false, 'нет цифр');
  assert.equal(made[0].lastCall, undefined);
  assert.equal(sp.call('901112233'), true);
  assert.equal(sp.call('901112244'), false, 'уже звоним');
});

test('answer() и call(): pcConfig без STUN и выбранный микрофон (ideal — отключили гарнитуру, берётся обычный)', async () => {
  const { sp, ua, media } = await ready({ inputId: () => 'mic-2' });
  const want = { mediaConstraints: { audio: { deviceId: { ideal: 'mic-2' } }, video: false }, pcConfig: { iceServers: [] } };
  assert.deepEqual(media.log[0], ['gum', { audio: { deviceId: { ideal: 'mic-2' } }, video: false }], 'проверка — тем же микрофоном');
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  sp.answer();
  assert.deepEqual(s.done[0], ['answer', want]);
  s.emit('ended');
  sp.call('901112233');
  assert.deepEqual(ua.lastCall.opts, want);
});

test('answer() и call() без выбранного микрофона — audio: true', async () => {
  const { sp, ua } = await ready();
  sp.call('901112233');
  assert.deepEqual(ua.lastCall.opts, { mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: [] } });
});

test('звук собеседника: исходящий — connection уже есть, track → attachRemote; конец → detachRemote', async () => {
  const { sp, ua, media } = await ready({}, { withConnection: true });
  sp.call('901112233');
  const s = ua.lastCall;
  ua.emit('newRTCSession', { originator: 'local', session: s });
  media.log.length = 0;
  s.connection.fire('track', { track: {} });
  assert.deepEqual(media.log, [['attach', s.connection]]);
  assert.equal(s.connection.l.track.length, 1, 'на одно соединение — один слушатель');
  media.log.length = 0;
  s.emit('confirmed');
  assert.deepEqual(media.log, [['attach', s.connection]], 'и при соединении — звук мог прийти раньше');
  s.emit('ended');
  assert.deepEqual(media.log.at(-1), ['detach']);
  assert.equal(sp.get().state, SP.READY);
});

test('звук собеседника: запоздалый track от соединения прошлого звонка не включает звук', async () => {
  const { sp, ua, media } = await ready({}, { withConnection: true });
  sp.call('901112233');
  const first = ua.lastCall;
  first.emit('confirmed');
  first.emit('ended');
  media.log.length = 0;
  first.connection.fire('track', { track: {} });
  assert.deepEqual(media.log, [], 'после конца звонка');
  sp.call('901112244');
  const second = ua.lastCall;
  media.log.length = 0;
  first.connection.fire('track', { track: {} });
  assert.deepEqual(media.log, [], 'во время следующего звонка');
  second.connection.fire('track', { track: {} });
  assert.deepEqual(media.log, [['attach', second.connection]]);
});

test('звук собеседника: входящий — peerconnection при ответе, затем track', async () => {
  const { sp, ua, media } = await ready();
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  sp.answer();
  const pc = new FakePC();
  s.connection = pc;
  s.emit('peerconnection', { peerconnection: pc });
  media.log.length = 0;
  pc.fire('track', { track: {} });
  assert.deepEqual(media.log, [['attach', pc]]);
  s.emit('failed', { cause: 'Terminated' });
  assert.deepEqual(media.log.at(-1), ['detach']);
  assert.equal(sp.get().call, null);
});

test('потеря связи — «переподключаемся», сама входит снова; вход не удался — register_failed', async () => {
  const { sp, ua } = await ready();
  ua.emit('disconnected');
  assert.deepEqual([sp.get().state, sp.get().reason], [SP.CONNECTING, 'network']);
  ua.emit('registered');
  assert.deepEqual([sp.get().state, sp.get().reason], [SP.READY, '']);
  ua.emit('unregistered', {});
  assert.deepEqual([sp.get().state, sp.get().reason], [SP.CONNECTING, 'network']);
  ua.emit('registrationFailed', { cause: 'Authentication Error' });
  assert.deepEqual([sp.get().state, sp.get().reason, sp.get().message], [SP.ERROR, 'register_failed', 'Authentication Error']);
});

test('отказ АТС, а следом unregistered (так шлёт JsSIP) — остаётся ошибка', async () => {
  const { sp, ua } = await ready();
  ua.emit('registrationFailed', { cause: 'Rejected' });
  ua.emit('unregistered', { cause: 'Rejected' });
  ua.emit('disconnected', {});
  assert.deepEqual([sp.get().state, sp.get().reason, sp.get().message], [SP.ERROR, 'register_failed', 'Rejected']);
});

test('registrationFailed из-за сети — переподключаемся, не ошибка', async () => {
  for (const cause of ['Connection Error', 'Request Timeout', 'Unavailable']) {
    const { d, made } = deps();
    const sp = createSoftphone(d);
    await sp.enable();
    made[0].emit('registrationFailed', { cause });
    assert.deepEqual([sp.get().state, sp.get().reason], [SP.CONNECTING, 'network'], cause);
    made[0].emit('registered');
    assert.equal(sp.get().state, SP.READY, cause);
  }
});

// B1: REGISTER остался без ответа при живом сокете — JsSIP сам не повторяет
// (только после переподключения сокета), запись в АТС истекает, входящих нет.
test('повторный вход: Request Timeout / Unavailable — через 30 с register(), если сокет жив и не вошли', async () => {
  for (const cause of ['Request Timeout', 'Unavailable']) {
    const { sp, ua, timers } = await ready();
    ua.emit('registrationFailed', { cause });
    assert.deepEqual(timers.delays, [30000], cause);
    assert.equal(ua.registers, 0, 'не сразу');
    timers.fire();
    assert.equal(ua.registers, 1, cause);
    assert.equal(timers.count, 0);
    assert.equal(sp.get().state, SP.CONNECTING);
  }
});

test('повторный вход: сокет лежит или уже вошли — register() не зовём', async () => {
  const a = await ready();
  a.ua.emit('registrationFailed', { cause: 'Request Timeout' });
  a.ua.connected = false;
  a.timers.fire();
  assert.equal(a.ua.registers, 0, 'сокет лежит — JsSIP войдёт сам при переподключении');
  const b = await ready();
  b.ua.emit('registrationFailed', { cause: 'Request Timeout' });
  b.ua.isReg = true;
  b.timers.fire();
  assert.equal(b.ua.registers, 0, 'уже вошли');
});

test('повторный вход: registered и disable() снимают таймер; таймер всегда один', async () => {
  const a = await ready();
  a.ua.emit('registrationFailed', { cause: 'Request Timeout' });
  a.ua.emit('registrationFailed', { cause: 'Request Timeout' });
  assert.equal(a.timers.count, 1, 'один таймер');
  a.ua.emit('registered');
  assert.equal(a.timers.count, 0, 'вошли — таймер снят');
  a.ua.emit('registrationFailed', { cause: 'Request Timeout' });
  a.timers.fire();
  a.ua.emit('registrationFailed', { cause: 'Request Timeout' });
  assert.equal(a.timers.count, 1, 'второй тайм-аут — снова таймер');
  a.sp.disable();
  assert.equal(a.timers.count, 0, 'выключили — таймер снят');

  const b = await ready();
  b.ua.emit('registrationFailed', { cause: 'Request Timeout' });
  b.ua.emit('registrationFailed', { cause: 'Authentication Error' });
  assert.equal(b.timers.count, 0, 'отказ АТС — повторять нечего');

  const c = await ready();
  c.ua.emit('registrationFailed', { cause: 'Connection Error' });
  assert.equal(c.timers.count, 0, 'сокет упал — JsSIP войдёт сам после переподключения');
});

test('связь пропала во время разговора — разговор не прерывается, после него — переподключаемся', async () => {
  const { sp, ua } = await ready();
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  sp.answer(); s.emit('confirmed');
  ua.emit('disconnected');
  ua.emit('registrationFailed', { cause: 'Connection Error' });
  assert.equal(sp.get().state, SP.IN_CALL);
  assert.equal(sp.get().call.number, '111');
  s.emit('ended');
  assert.deepEqual([sp.get().state, sp.get().reason, sp.get().call], [SP.CONNECTING, 'network', null]);
  ua.emit('registered');
  assert.equal(sp.get().state, SP.READY);
});

test('после ошибки входа enable() начинает заново: старый UA остановлен, замок свой', async () => {
  const { sp, ua, made, d } = await ready();
  ua.emit('registrationFailed', { cause: 'Authentication Error' });
  assert.equal(sp.get().state, SP.ERROR);
  const seen = [];
  sp.subscribe((s) => seen.push(s.state));
  await sp.enable();
  assert.equal(ua.stopped, true);
  assert.equal(made.length, 2);
  assert.equal(made[1].started, true);
  assert.equal(seen.includes(SP.OTHER_TAB), false);
  assert.equal(sp.get().state, SP.CONNECTING);
  ua.emit('registered');
  assert.equal(sp.get().state, SP.CONNECTING, 'события старого UA не слушаем');
  ua.emit('registrationFailed', { cause: 'Authentication Error' });
  assert.equal(sp.get().state, SP.CONNECTING, 'и отказ старого UA тоже');
  const stale = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: stale });
  assert.equal(sp.get().state, SP.CONNECTING, 'и звонок через старый UA');
  assert.deepEqual(stale.done, []);
  made[1].emit('registered');
  assert.equal(sp.get().state, SP.READY);
  assert.equal(d.locks.held, true);
});

test('после ошибки микрофона enable() пробует снова', async () => {
  let deny = true;
  const { d, made } = deps();
  d.media.getUserMedia = async () => { if (deny) throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); return { getTracks: () => [] }; };
  const sp = createSoftphone(d);
  await sp.enable();
  assert.equal(sp.get().reason, 'mic_denied');
  deny = false;
  await sp.enable();
  assert.equal(made.length, 1);
  assert.equal(sp.get().state, SP.CONNECTING);
});

test('disable — разговор завершён, UA остановлен, флаг снят, звук отключён, состояние off', async () => {
  const { sp, ua, store, media, d } = await ready();
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  sp.answer(); s.emit('confirmed');
  sp.disable();
  assert.equal(s.done.at(-1)[0], 'terminate');
  assert.equal(ua.stopped, true);
  assert.equal(store.has(SP_FLAG), false);
  assert.equal(sp.wanted(), false);
  assert.deepEqual(media.log.at(-1), ['detach']);
  assert.deepEqual(sp.get(), { state: SP.OFF, reason: '', message: '', code: '', extension: '', call: null, lastEnd: null });
  s.emit('ended');
  ua.emit('unregistered', {});
  ua.emit('disconnected', {});
  assert.equal(sp.get().state, SP.OFF, 'события после выключения не будят телефон');
  await tick();
  assert.equal(d.locks.held, false);
});

// Задача 8 — выход и вход от имени: телефон выключается чисто (номер выходит из
// АТС), а выбор сотрудника «принимать звонки» остаётся до его следующего входа.
test('disable({ keepWanted: true }) — всё как у disable(), только флаг остаётся', async () => {
  const { sp, ua, store, media, d } = await ready();
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  sp.answer(); s.emit('confirmed');
  sp.disable({ keepWanted: true });
  assert.equal(s.done.at(-1)[0], 'terminate', 'разговор не завершён');
  assert.equal(ua.stopped, true, 'UA не остановлен');
  assert.deepEqual(media.log.at(-1), ['detach']);
  assert.deepEqual(sp.get(), { state: SP.OFF, reason: '', message: '', code: '', extension: '', call: null, lastEnd: null });
  assert.equal(store.get(SP_FLAG), '1', 'флаг снят');
  assert.equal(sp.wanted(), true);
  await tick();
  assert.equal(d.locks.held, false, 'замок не отпущен');
  ua.emit('registered');
  assert.equal(sp.get().state, SP.OFF, 'события после выключения не будят телефон');
  sp.disable();
  assert.equal(store.has(SP_FLAG), false, 'обычный disable() флаг снимает');
});

// Финальное ревью (M6): «хранилище недоступно — не мешаем» — ждущая вкладка не
// гаснет из-за того, что флаг прочитать нельзя.
test('одна вкладка: хранилище недоступно (бросает) — ждущая вкладка не гаснет, а входит, когда первую закрыли', async () => {
  const locks = makeLocks();
  const store = new Map();
  const broken = { getItem: () => { throw new Error('SecurityError'); }, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const A = deps({ locks, storage: broken });
  const B = deps({ locks, storage: broken });
  const a = createSoftphone(A.d);
  const b = createSoftphone(B.d);
  await a.enable(); A.made[0].emit('registered');
  await b.enable();
  assert.equal(b.get().state, SP.OTHER_TAB);
  locks.closeHolder();
  await settle();
  assert.equal(B.made.length, 1, 'вкладка погасла из-за недоступного хранилища');
  assert.equal(b.get().state, SP.CONNECTING);
});

test('одна вкладка: B ждёт, пока A не выключит, и сама входит', async () => {
  const locks = makeLocks();
  const A = deps({ locks });
  const B = deps({ locks });
  let answerB;
  const rpcB = B.d.rpc;
  B.d.rpc = (name, args) => new Promise((r) => { answerB = () => r(rpcB(name, args)); });
  const a = createSoftphone(A.d);
  const b = createSoftphone(B.d);
  await a.enable(); A.made[0].emit('registered');
  assert.equal(a.get().state, SP.READY);
  await b.enable();
  assert.deepEqual([b.get().state, b.get().reason], [SP.OTHER_TAB, 'other_tab']);
  assert.equal(B.made.length, 0);
  assert.equal(locks.queued, 1);
  await b.enable();
  assert.equal(locks.queued, 1, 'повторное enable() не ставит второй запрос');
  a.disable();
  await settle();
  assert.equal(typeof answerB, 'function', 'B получил замок и дошёл до сервера');
  assert.equal(b.get().state, SP.CONNECTING);
  const seen = [];
  b.subscribe((s) => seen.push(s.state));
  const again = b.enable(); // во время перехода — то же включение, не новое
  answerB();
  await again;
  await tick();
  assert.equal(B.made.length, 1, 'B вошёл сам и один раз');
  assert.equal(B.made[0].started, true);
  assert.equal(seen.includes(SP.OTHER_TAB), false);
  assert.equal(b.get().state, SP.CONNECTING);
  B.made[0].emit('registered');
  assert.equal(b.get().state, SP.READY);
  assert.equal(locks.held, true);
});

function sharedStorage() {
  const store = new Map();
  return { store, storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) } };
}

test('одна вкладка, общее хранилище: вкладку A закрыли — B входит сам', async () => {
  const locks = makeLocks();
  const { storage, store } = sharedStorage();
  const A = deps({ locks, storage });
  const B = deps({ locks, storage });
  const a = createSoftphone(A.d);
  const b = createSoftphone(B.d);
  await a.enable(); A.made[0].emit('registered');
  await b.enable();
  assert.equal(b.get().state, SP.OTHER_TAB);
  locks.closeHolder(); // вкладку A закрыли, флаг на компьютере остался
  await settle();
  assert.equal(B.made.length, 1);
  assert.equal(B.made[0].started, true);
  assert.equal(b.get().state, SP.CONNECTING);
  assert.equal(store.get(SP_FLAG), '1');
});

test('одна вкладка, общее хранилище: в A телефон выключили — B не подхватывает, гаснет', async () => {
  const locks = makeLocks();
  const { storage } = sharedStorage();
  const A = deps({ locks, storage });
  const B = deps({ locks, storage });
  const a = createSoftphone(A.d);
  const b = createSoftphone(B.d);
  await a.enable(); A.made[0].emit('registered');
  await b.enable();
  assert.equal(b.get().state, SP.OTHER_TAB);
  a.disable(); // переключатель — один на компьютер
  await settle();
  assert.equal(B.made.length, 0);
  assert.equal(B.calls.rpc.length, 0);
  assert.equal(b.get().state, SP.OFF);
  assert.equal(b.wanted(), false);
  assert.equal(locks.held, false);
  await b.enable(); // а включили снова уже здесь — B телефон
  assert.equal(B.made.length, 1);
  assert.equal(b.get().state, SP.CONNECTING);
});

test('одна вкладка: B выключили, пока он ждал, — запрос снят, B не входит', async () => {
  const locks = makeLocks();
  const A = deps({ locks });
  const B = deps({ locks });
  const a = createSoftphone(A.d);
  const b = createSoftphone(B.d);
  await a.enable();
  await b.enable();
  assert.equal(b.get().state, SP.OTHER_TAB);
  b.disable();
  assert.equal(locks.queued, 0, 'запрос в очереди отменён');
  assert.equal(b.get().state, SP.OFF);
  a.disable();
  await settle();
  assert.equal(B.made.length, 0);
  assert.equal(locks.held, false);
});

test('подписчики слышат каждую смену; упавший подписчик не мешает другим', async () => {
  const { d, made } = deps();
  const sp = createSoftphone(d);
  const seen = [];
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a);
  const offBoom = sp.subscribe(() => { throw new Error('boom'); });
  const off = sp.subscribe((s) => seen.push(s.state));
  try { await sp.enable(); made[0].emit('registered'); } finally { console.warn = warn; offBoom(); }
  assert.deepEqual(seen.slice(-2), [SP.CONNECTING, SP.READY]);
  assert.ok(warned.length > 0, 'ошибка подписчика видна в консоли');
  off();
  made[0].emit('disconnected');
  assert.equal(seen.at(-1), SP.READY, 'отписанный не слышит');
});

test('пароль АТС нигде в состоянии: ни на одном шаге, ни у подписчиков', async () => {
  const { d, made } = deps({}, { withConnection: true });
  const sp = createSoftphone(d);
  const dumps = [];
  const look = () => dumps.push(JSON.stringify(sp.get()));
  sp.subscribe((s) => dumps.push(JSON.stringify(s)));
  await sp.enable(); look();
  const ua = made[0];
  ua.emit('registered'); look();
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s }); look();
  sp.answer(); s.emit('confirmed'); sp.setMuted(true); look();
  s.emit('ended');
  sp.call('901112233'); ua.lastCall.emit('confirmed'); look();
  ua.lastCall.emit('ended');
  ua.emit('registrationFailed', { cause: 'Authentication Error' }); look();
  sp.disable(); look();
  assert.ok(dumps.length > 10);
  for (const x of dumps) assert.equal(x.includes('secret'), false, x);
});

test('состояние нельзя испортить снаружи', async () => {
  const { sp, ua } = await ready();
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  const st = sp.get();
  assert.throws(() => { st.state = SP.OFF; }, TypeError);
  assert.throws(() => { st.call.number = '0'; }, TypeError);
  assert.equal(sp.get().state, SP.RINGING);
  s.emit('failed', { cause: 'Canceled' });
  assert.throws(() => { sp.get().lastEnd.cause = 'x'; }, TypeError);
});

test('без перемен — без уведомления', async () => {
  const { sp, ua } = await ready();
  const seen = [];
  sp.subscribe((s) => seen.push(s.state));
  ua.emit('registered');
  ua.emit('registered');
  assert.deepEqual(seen, [], 'уже «готов»');
  ua.emit('disconnected');
  ua.emit('unregistered', {});
  assert.deepEqual(seen, [SP.CONNECTING], 'дважды «переподключаемся» — одно уведомление');
  sp.disable();
  sp.disable();
  assert.deepEqual(seen, [SP.CONNECTING, SP.OFF]);
});

test('«Микрофон выкл.» дважды — одно уведомление', async () => {
  const { sp, ua } = await ready();
  const s = new FakeSession('incoming', '111');
  ua.emit('newRTCSession', { originator: 'remote', session: s });
  sp.answer(); s.emit('confirmed');
  let n = 0;
  sp.subscribe(() => { n++; });
  sp.setMuted(true);
  sp.setMuted(true);
  assert.equal(n, 1);
});
