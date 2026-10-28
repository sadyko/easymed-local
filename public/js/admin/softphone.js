// SOFTPHONE_V1 (2026-10-29) — ТЕЛЕФОН В EASY-MED: ВНУТРЕННИЙ НОМЕР ОПЕРАТОРА ВХОДИТ В АТС ИЗ БРАУЗЕРА.
//
// Владелец: «can we build a softphone in the easymed inside?» — спецификация
// docs/specs/2026-10-29-softphone-design.md. С переключателем «Принимать звонки
// в Easy-Med» внутренний номер оператора (onlinePBX) входит в АТС из этой
// вкладки через WebRTC (JsSIP): входящий звонит здесь, «Позвонить» идёт через
// гарнитуру компьютера, без «сначала зазвонит ваша трубка».
//
// ЗДЕСЬ — только состояние телефона и JsSIP. Браузер (сама библиотека,
// микрофон, замок вкладки, звук собеседника, хранилище, RPC) приходит снаружи
// из softphone-browser.js, поэтому модуль без DOM и проверяется подставным
// JsSIP (__tests__/softphone.test.mjs). Слов для экрана здесь нет: причины —
// коды, слова к ним подбирает панель crm-phone.js.
//
// ПАРОЛЬ АТС живёт только внутри JsSIP UA этой вкладки: в состояние, журнал и
// хранилище не попадает. Текст ошибок JsSIP наружу тоже не идёт: в ошибке
// настройки JsSIP повторяет значение поля, то есть и пароль.
//
// ОДНА ВКЛАДКА — ОДИН ТЕЛЕФОН: замок Web Locks «easymed-softphone». Вторая
// вкладка говорит «в другой вкладке» и стоит в очереди за замком: закрыли или
// выключили первую — вторая входит сама.

export const SP = Object.freeze({
  OFF: 'off', CONNECTING: 'connecting', READY: 'ready', RINGING: 'ringing',
  CALLING: 'calling', IN_CALL: 'in_call', ERROR: 'error', OTHER_TAB: 'other_tab',
});
/** Переключатель «Принимать звонки в Easy-Med» — помнит этот компьютер (localStorage). */
export const SP_FLAG = 'easymed.softphone.on';
const LOCK = 'easymed-softphone';
// Причины registrationFailed, после которых JsSIP переподключается и входит сам.
// Всё остальное (неверный пароль, отказ, нет такого номера…) — ошибка, её называем.
const NETWORK_CAUSES = new Set(['Connection Error', 'Request Timeout']);
const IDLE = Object.freeze({ state: SP.OFF, reason: '', message: '', extension: '', call: null });

export function createSoftphone({ loadJsSIP, rpc, media, locks, storage, now = () => Date.now(), inputId = () => '' }) {
  let st = IDLE;
  let line = { state: SP.CONNECTING, reason: '', message: '' }; // что говорит вход в АТС; звонок рисуется поверх
  let ua = null;            // JsSIP UA этой вкладки — в нём и только в нём пароль
  let domain = '';
  let session = null;       // текущий звонок (JsSIP RTCSession)
  let dialing = '';         // номер, пока идёт ua.call(): JsSIP шлёт newRTCSession изнутри
  let gen = 0;              // поколение включения: после disable() старые ожидания ничего не делают
  let inflight = null;      // идущее включение — второе enable() ждёт его же
  let lockRelease = null;   // отпустить замок, который держит эта вкладка
  let lockGone = null;      // решится, когда прежний замок вкладки действительно отпущен
  let lockWait = null;      // AbortController запроса в очереди за замком
  const subs = new Set();
  const hooked = new WeakSet(); // соединения, на которые уже навешан 'track'

  const safe = (fn) => { try { return fn(); } catch { return undefined; } };
  function set(patch) {
    st = Object.freeze({ ...st, ...patch });
    for (const fn of [...subs]) { try { fn(st); } catch (e) { console.warn('[softphone] listener', e); } }
  }
  const setCall = (state, patch) => set({ state, call: Object.freeze({ ...st.call, ...patch }) });
  function setLine(state, reason = '', message = '') {
    line = { state, reason, message };
    if (!session) set({ ...line, call: null }); // во время звонка экран показывает звонок
  }

  // Микрофон — выбранный в панели (Task 7), иначе любой.
  function audio() {
    const id = safe(inputId) || '';
    return { audio: id ? { deviceId: { exact: id } } : true, video: false };
  }
  // Без внешнего STUN: у клиники может не быть пути к нему, и JsSIP ждал бы сбора адресов.
  const callOpts = () => ({ mediaConstraints: audio(), pcConfig: { iceServers: [] } });

  // ── Замок вкладки ──────────────────────────────────────────────────────────
  // Web Locks держит замок, пока не решится обещание обработчика; его resolve —
  // наш lockRelease. Телефон уже выключили — замок сразу отдаём.
  function hold(lock, g) {
    if (!lock || g !== gen) return undefined;
    return new Promise((release) => { lockRelease = release; });
  }
  function releaseLock() {
    if (lockRelease) { lockRelease(); lockRelease = null; }
  }
  // 'mine' — замок наш; 'busy' — держит другая вкладка; 'none' — замков в браузере нет.
  async function tryLock(g) {
    if (!locks || typeof locks.request !== 'function') return 'none';
    if (lockGone) await lockGone; // выключили и сразу включили: свой замок мог ещё не освободиться
    if (g !== gen) return 'busy';
    return new Promise((resolve) => {
      try {
        const p = Promise.resolve(locks.request(LOCK, { ifAvailable: true }, (lock) => {
          const h = hold(lock, g);
          resolve(h ? 'mine' : 'busy');
          return h;
        }));
        lockGone = p.catch(() => {});
        p.catch(() => resolve('none'));
      } catch { resolve('none'); }
    });
  }
  // Другая вкладка держит телефон — встаём в очередь. Замок придёт сюда, когда
  // ту вкладку закроют (или её включение не удалось), и включение продолжится
  // само. Переключатель общий для всех вкладок компьютера (localStorage): если
  // там телефон ВЫКЛЮЧИЛИ, флага уже нет — эта вкладка не подхватывает, а гаснет.
  function waitLock(g) {
    const ac = new AbortController();
    lockWait = ac;
    try {
      const p = locks.request(LOCK, { signal: ac.signal }, (lock) => {
        if (lockWait === ac) lockWait = null;
        if (!lock || g !== gen) return undefined;
        const flag = safe(() => storage.getItem(SP_FLAG)); // undefined — хранилище недоступно, не мешаем
        if (flag !== undefined && flag !== '1') { set(IDLE); return undefined; }
        const h = hold(lock, g);
        if (h) track(proceed(g));
        return h;
      });
      lockGone = Promise.resolve(p).catch(() => {}); // отмена отвечает AbortError — это не ошибка
    } catch { lockWait = null; }
  }

  // ── Включение ──────────────────────────────────────────────────────────────
  function track(p) {
    inflight = p;
    const clear = () => { if (inflight === p) inflight = null; };
    p.then(clear, clear);
    return p;
  }
  function quit(g, reason, message = '') {
    if (g !== gen) return false;
    releaseLock();
    set({ state: SP.ERROR, reason, message, call: null });
    return false;
  }
  function dropUa() {
    const u = ua; ua = null;
    if (u) safe(() => u.stop());
  }

  async function start(g) {
    dropUa(); // повтор после ошибки входа: прежний UA останавливаем, свой замок оставляем
    if (!lockRelease) {
      const got = await tryLock(g);
      if (g !== gen) return;
      if (got === 'busy') {
        set({ ...IDLE, state: SP.OTHER_TAB, reason: 'other_tab' });
        waitLock(g);
        return;
      }
    }
    await proceed(g);
  }

  async function micOk(g) {
    if (!media || !media.isSecureContext) return quit(g, 'insecure');
    let stream;
    try {
      stream = await media.getUserMedia(audio());
    } catch (e) {
      const name = (e && e.name) || '';
      const reason = name === 'NotAllowedError' ? 'mic_denied'
        : (name === 'NotFoundError' || name === 'OverconstrainedError') ? 'no_mic' // выбранную гарнитуру отключили — тоже «нет микрофона»
          : 'mic_error';
      return quit(g, reason, String((e && e.message) || name));
    }
    safe(() => { for (const t of stream.getTracks()) t.stop(); }); // это была проба — микрофон сразу закрываем
    return g === gen;
  }

  async function proceed(g) {
    set({ ...IDLE, state: SP.CONNECTING });
    if (!(await micOk(g))) return;
    let res;
    try { res = await rpc('telephony_webrtc_me', {}); } catch (e) { res = { data: null, error: e }; }
    if (g !== gen) return;
    const creds = res && !res.error ? res.data : null;
    if (!creds || !creds.ws_url || !creds.user || !creds.sip_domain) {
      quit(g, 'server', String((res && res.error && res.error.message) || ''));
      return;
    }
    let JsSIP;
    try { JsSIP = await loadJsSIP(); } catch { JsSIP = null; }
    if (g !== gen) return;
    if (!JsSIP || typeof JsSIP.UA !== 'function') { quit(g, 'load_failed'); return; }
    let u;
    try {
      u = new JsSIP.UA({
        sockets: [new JsSIP.WebSocketInterface(creds.ws_url)],
        uri: 'sip:' + creds.user + '@' + creds.sip_domain,
        password: creds.password,
        register: true,
        session_timers: false,
      });
    } catch {
      quit(g, 'register_failed'); // без текста ошибки — см. шапку
      return;
    }
    ua = u;
    domain = creds.sip_domain;
    line = { state: SP.CONNECTING, reason: '', message: '' };
    listen(u);
    set({ ...line, extension: String(creds.extension || creds.user), call: null });
    try { u.start(); } catch { ua = null; safe(() => u.stop()); quit(g, 'register_failed'); }
  }

  // ── События UA ─────────────────────────────────────────────────────────────
  // События остановленного UA не слушаем: после stop() JsSIP ещё шлёт unregistered/disconnected.
  function listen(u) {
    const mine = () => ua === u;
    u.on('registered', () => { if (mine()) setLine(SP.READY); });
    // Связь пропала — JsSIP переподключится и войдёт сам. Отказ АТС этим не затираем:
    // после registrationFailed JsSIP сразу шлёт и unregistered.
    const lost = () => { if (mine() && line.state !== SP.ERROR) setLine(SP.CONNECTING, 'network'); };
    u.on('unregistered', lost);
    u.on('disconnected', lost);
    u.on('registrationFailed', (e) => {
      if (!mine()) return;
      const cause = String((e && e.cause) || '');
      if (NETWORK_CAUSES.has(cause)) setLine(SP.CONNECTING, 'network');
      else setLine(SP.ERROR, 'register_failed', cause);
    });
    u.on('newRTCSession', (e) => { if (mine()) onSession(e); });
  }

  function onSession(e) {
    const s = e && e.session;
    if (!s || s === session) return; // свой исходящий уже подключён
    if (e.originator === 'remote') {
      // Второй входящий во время звонка — «занято»; onlinePBX ведёт его дальше сам.
      if (session) { safe(() => s.terminate({ status_code: 486, reason_phrase: 'Busy Here' })); return; }
      wire(s, 'in', String((s.remote_identity && s.remote_identity.uri && s.remote_identity.uri.user) || ''));
    } else if (!session) {
      wire(s, 'out', dialing);
    }
  }

  const attach = (pc) => { if (pc) safe(() => media.attachRemote(pc)); };
  function hook(s, pc) {
    if (!pc || hooked.has(pc) || typeof pc.addEventListener !== 'function') return;
    hooked.add(pc);
    pc.addEventListener('track', () => { if (session === s) attach(pc); });
  }
  function finish(s) {
    if (session !== s) return; // конец чужой («занято») или уже снятой сессии
    session = null;
    safe(() => media.detachRemote());
    set(ua ? { ...line, call: null } : IDLE);
  }

  function wire(s, direction, number) {
    session = s;
    set({ state: direction === 'in' ? SP.RINGING : SP.CALLING, reason: '', message: '', call: Object.freeze({ direction, number, startedAt: null, muted: false }) });
    // Исходящий: JsSIP создаёт соединение и шлёт 'peerconnection' ещё внутри ua.call(),
    // раньше, чем сюда успевают подписаться, — поэтому смотрим session.connection сразу.
    // Входящий: соединение появится при ответе — с событием 'peerconnection'.
    hook(s, s.connection);
    s.on('peerconnection', (ev) => hook(s, ev && ev.peerconnection));
    const up = () => {
      if (session !== s) return;
      attach(s.connection); // дорожки могли прийти раньше, чем навесили 'track'
      if (st.state !== SP.IN_CALL) setCall(SP.IN_CALL, { startedAt: st.call.startedAt ?? now() });
    };
    s.on('accepted', up);
    s.on('confirmed', up);
    s.on('ended', () => finish(s));
    s.on('failed', () => finish(s));
  }

  // ── Действия ───────────────────────────────────────────────────────────────
  function enable() {
    safe(() => storage.setItem(SP_FLAG, '1'));
    if (inflight) return inflight;                              // включение уже идёт
    if (lockWait) return Promise.resolve();                     // ждём замок другой вкладки
    if (ua && st.state !== SP.ERROR) return Promise.resolve();  // уже включён
    return track(start(++gen));
  }

  function disable() {
    gen++;
    inflight = null;
    safe(() => storage.removeItem(SP_FLAG));
    const s = session; session = null;
    if (s) safe(() => s.terminate());
    dropUa();
    if (lockWait) { const ac = lockWait; lockWait = null; safe(() => ac.abort()); }
    releaseLock();
    safe(() => media.detachRemote());
    line = { state: SP.CONNECTING, reason: '', message: '' };
    set(IDLE);
  }

  function call(number) {
    const digits = String(number ?? '').replace(/\D/g, '');
    if (!ua || session || st.state !== SP.READY || !digits) return false;
    let s = null;
    dialing = digits;
    try { s = ua.call('sip:' + digits + '@' + domain, callOpts()); } catch { s = null; } finally { dialing = ''; }
    if (!s) { if (session) finish(session); return false; } // JsSIP отказал сразу
    if (session !== s) wire(s, 'out', digits); // подставной JsSIP newRTCSession может и не прислать
    return true;
  }

  function answer() {
    if (session && st.state === SP.RINGING) { const s = session; safe(() => s.answer(callOpts())); }
  }
  function decline() {
    if (!session || st.state !== SP.RINGING) return;
    const s = session;
    try { s.terminate({ status_code: 603, reason_phrase: 'Decline' }); } catch { finish(s); }
  }
  function hangup() {
    if (!session) return;
    const s = session;
    try { s.terminate(); } catch { finish(s); } // JsSIP бросает, если звонок уже кончился
  }
  // «Микрофон выкл.» — только в разговоре: до ответа у JsSIP ещё нет соединения.
  function setMuted(on) {
    if (!session || !st.call || st.state !== SP.IN_CALL) return;
    const s = session;
    try { if (on) s.mute({ audio: true }); else s.unmute({ audio: true }); } catch { return; }
    setCall(st.state, { muted: !!on });
  }

  return {
    get: () => st,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    wanted: () => safe(() => storage.getItem(SP_FLAG)) === '1',
    enable, disable, call, answer, decline, hangup, setMuted,
    busy: () => st.state === SP.RINGING || st.state === SP.CALLING || st.state === SP.IN_CALL,
  };
}
