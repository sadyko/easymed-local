// SOFTPHONE_V1 (2026-10-29) — состояние телефона поверх JsSIP: подставной JsSIP,
// подставные микрофон, замок вкладки, хранилище и RPC. Браузер не нужен.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSoftphone, SP, SP_FLAG } from '../softphone.js';

const tick = () => new Promise((r) => setImmediate(r));

class Emitter { constructor() { this.h = {}; } on(n, f) { (this.h[n] ||= []).push(f); return this; } emit(n, e) { for (const f of this.h[n] || []) f(e); } }
class FakeSession extends Emitter {
  constructor(dir, number) { super(); this.direction = dir; this.remote_identity = { uri: { user: number } }; this.done = []; }
  answer(o) { this.done.push(['answer', o]); } terminate(o) { this.done.push(['terminate', o]); } mute(o) { this.done.push(['mute', o]); } unmute(o) { this.done.push(['unmute', o]); }
}
class FakePC {
  constructor() { this.l = {}; }
  addEventListener(n, f) { (this.l[n] ||= []).push(f); }
  fire(n, e = {}) { for (const f of this.l[n] || []) f(e); }
  getReceivers() { return []; }
}
function makeJsSIP({ withConnection = false } = {}) {
  const made = [];
  class UA extends Emitter { constructor(cfg) { super(); this.cfg = cfg; this.started = false; made.push(this); } start() { this.started = true; } stop() { this.stopped = true; }
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
// request() решается, когда замок уже отпущен.
// closeHolder() — вкладку, что держит замок, закрыли: браузер отпускает её замок сам.
function makeLocks() {
  let held = false; let close = null; const queue = [];
  const grant = (item) => {
    held = true;
    const closed = new Promise((r) => { close = r; });
    const done = (fn) => (v) => { held = false; close = null; const next = queue.shift(); if (next) grant(next); fn(v); };
    Promise.race([Promise.resolve(item.cb({ name: 'easymed-softphone' })), closed]).then(done(item.resolve), done(item.reject));
  };
  return {
    get held() { return held; },
    get queued() { return queue.length; },
    closeHolder() { if (close) close(); },
    request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      return new Promise((resolve, reject) => {
        const item = { cb, resolve, reject };
        if (!held) { grant(item); return; }
        if (opts.ifAvailable) { Promise.resolve(cb(null)).then(resolve, reject); return; }
        queue.push(item);
        opts.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(item);
          if (i >= 0) { queue.splice(i, 1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
        });
      });
    },
  };
}

function deps(over = {}, { withConnection = false } = {}) {
  const { JsSIP, made } = makeJsSIP({ withConnection });
  const store = new Map();
  const media = makeMedia();
  const calls = { rpc: [], load: 0 };
  return {
    made, store, media, calls, JsSIP,
    d: {
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
  for (const [name, reason] of [['NotAllowedError', 'mic_denied'], ['NotFoundError', 'no_mic'], ['NotReadableError', 'mic_error']]) {
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

test('disable() пока enable() ждёт сервер — UA не создан, состояние off, замок отпущен', async () => {
  let answer;
  const { d, made, calls } = deps({ rpc: () => new Promise((r) => { answer = r; }) });
  const sp = createSoftphone(d);
  const p = sp.enable();
  await tick();
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
  await tick();
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
  s.emit('ended');
  assert.equal(sp.get().state, SP.READY);
  assert.equal(sp.get().call, null);
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
  a.emit('failed', { cause: 'Rejected' });
  assert.equal(sp.get().state, SP.READY);
  assert.equal(sp.get().call, null);
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

test('answer() и call(): pcConfig без STUN и выбранный микрофон', async () => {
  const { sp, ua, media } = await ready({ inputId: () => 'mic-2' });
  const want = { mediaConstraints: { audio: { deviceId: { exact: 'mic-2' } }, video: false }, pcConfig: { iceServers: [] } };
  assert.deepEqual(media.log[0], ['gum', { audio: { deviceId: { exact: 'mic-2' } }, video: false }], 'проверка — тем же микрофоном');
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
  for (const cause of ['Connection Error', 'Request Timeout']) {
    const { d, made } = deps();
    const sp = createSoftphone(d);
    await sp.enable();
    made[0].emit('registrationFailed', { cause });
    assert.deepEqual([sp.get().state, sp.get().reason], [SP.CONNECTING, 'network'], cause);
    made[0].emit('registered');
    assert.equal(sp.get().state, SP.READY, cause);
  }
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
  assert.deepEqual(sp.get(), { state: SP.OFF, reason: '', message: '', extension: '', call: null });
  s.emit('ended');
  ua.emit('unregistered', {});
  ua.emit('disconnected', {});
  assert.equal(sp.get().state, SP.OFF, 'события после выключения не будят телефон');
  await tick();
  assert.equal(d.locks.held, false);
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
  await tick(); await tick();
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
  await tick(); await tick();
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
  await tick(); await tick();
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
  await tick(); await tick();
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
});
