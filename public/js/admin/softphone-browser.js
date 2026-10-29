// SOFTPHONE_V1 (2026-10-29) — БРАУЗЕР ДЛЯ ТЕЛЕФОНА EASY-MED.
//
// softphone.js — состояние телефона без DOM: всё браузерное он получает
// снаружи. Здесь эти провода и подключаются к настоящему браузеру:
//   • JsSIP (250 КБ, public/js/vendor/jssip-3.13.9.mjs) грузится, только когда
//     телефон включают, — у того, кто им не пользуется, страница не тяжелеет;
//   • микрофон — navigator.mediaDevices; на http-адресе без файла настройки
//     компьютера (EasyMed-ustanovka.cmd, PC_SETUP_INSTALL_V1) его у браузера
//     нет вовсе, и причина — «insecure»: совет «настройте компьютер», а не
//     «разрешите микрофон», которого браузер и не спросит;
//   • замок вкладки — Web Locks; в старом браузере без них замок даётся сразу
//     (одна вкладка — один телефон там не гарантируется, но телефон работает);
//   • звук собеседника — один скрытый <audio> на страницу;
//   • флаг «включён» (свой у каждого сотрудника) и выбранная гарнитура (у
//     компьютера) — localStorage (ошибки хранилища глотаются: приватный режим
//     не должен ронять телефон);
//   • RPC — тот же supabase.rpc, что у всех экранов.
//
// ОДИН ТЕЛЕФОН НА СТРАНИЦУ: getSoftphone() создаёт его при первом вызове.
// Без браузера (обвязки тестов экранов) — «пустой» телефон: выключен и ничего
// не делает, поэтому старым стендам панели подставлять его не нужно.
// peekSoftphone() — для выхода и «Войти как сотрудник»: выключить телефон,
// если он есть, не создавая его ради этого.
//
// СЛОВА. softphone.js отдаёт коды; reasonText() и endText() — их слова на
// языке экрана (tr), для панели crm-phone.js.
//
// ГАРНИТУРА (задача 7). Список микрофонов и динамиков, выбор (localStorage),
// динамик для собеседника (setSinkId — где браузер умеет), проверка «запишем
// 5 секунд и проиграем». Всё браузерное приходит через env — по умолчанию
// настоящий браузер, в стендах подставной (как у browserMedia).
import { supabase } from '../supabase.js';
import { tr } from './i18n.js';
import { createSoftphone, SP_FLAG } from './softphone.js';

const DEVICE_KEY = 'easymed.softphone.';
const OFF = Object.freeze({ state: 'off', reason: '', message: '', code: '', extension: '', call: null, lastEnd: null });
const INERT = Object.freeze({
  get: () => OFF,
  subscribe: () => () => {},
  wanted: () => false,
  enable: () => Promise.resolve(),
  disable() {}, call: () => false, answer() {}, decline() {}, hangup() {}, setMuted() {},
  busy: () => false,
});

let instance = null;   // телефон этой страницы
let override = null;   // подмена для стендов
let pageMedia = null;  // браузер этой страницы: микрофон и <audio> собеседника

const hasBrowser = () => typeof window !== 'undefined' && typeof navigator !== 'undefined' && typeof document !== 'undefined';

/** Выбранная в панели гарнитура: 'in' — микрофон, 'out' — динамик. '' — по умолчанию. */
export function savedDevice(kind) {
  try { return localStorage.getItem(DEVICE_KEY + kind) || ''; } catch { return ''; }
}
/** Запомнить выбор гарнитуры на этом компьютере; '' — снова «по умолчанию». */
export function saveDevice(kind, id) {
  try {
    if (id) localStorage.setItem(DEVICE_KEY + kind, String(id));
    else localStorage.removeItem(DEVICE_KEY + kind);
  } catch { /* приватный режим */ }
}

// ПЕРЕКЛЮЧАТЕЛЬ — У КАЖДОГО СОТРУДНИКА (задача 8, решение владельца «Switch per
// operator»). За компьютером клиники сменяются люди: выбор одного не должен
// включать телефон другому. Поэтому флаг включения хранится с номером
// сотрудника, вошедшего на этой странице (window.easymed.state.user — оболочка,
// до неё window.CURRENT_USER), а номер читается при каждом обращении. Сотрудник
// неизвестен (до входа) — флага нет: не читается и не пишется. Гарнитура
// (easymed.softphone.in / out) — у компьютера, её ключи не трогаем. Вкладки
// одного сотрудника видят один и тот же флаг — замок вкладки (softphone.js
// waitLock) работает как прежде.
function operatorId() {
  try {
    const w = typeof window !== 'undefined' ? window : null;
    const u = w && ((w.easymed && w.easymed.state && w.easymed.state.user) || w.CURRENT_USER);
    return u && u.id != null && String(u.id) !== '' ? String(u.id) : '';
  } catch { return ''; }
}
/** Ключ в localStorage: флаг включения — с номером сотрудника; '' — сотрудник неизвестен. */
function keyOf(k) {
  if (k !== SP_FLAG) return k;
  const uid = operatorId();
  return uid ? SP_FLAG + '.' + uid : '';
}

/**
 * Хранилище телефона (createSoftphone({ storage })): ошибки хранилища глотаются,
 * флаг — свой у сотрудника. Прочитать нельзя (хранилище бросает) — undefined,
 * «флаг не прочитан»: ждущая вкладка тогда не гаснет (softphone.js waitLock);
 * флага нет или сотрудник неизвестен — null.
 */
export const softphoneStorage = Object.freeze({
  getItem(k) { const key = keyOf(k); if (!key) return null; try { return localStorage.getItem(key); } catch { return undefined; } },
  setItem(k, v) { const key = keyOf(k); if (!key) return; try { localStorage.setItem(key, v); } catch { /* приватный режим */ } },
  removeItem(k) { const key = keyOf(k); if (!key) return; try { localStorage.removeItem(key); } catch { /* приватный режим */ } },
});

/** JsSIP из vendor — по требованию: import() грузит бандл один раз. */
export function loadJsSIP() {
  return import('../vendor/jssip-3.13.9.mjs').then((m) => m.default || m);
}

/** Web Locks, если они есть; иначе замок даётся сразу (без очереди и без второй вкладки). */
export function browserLocks(nav) {
  const real = nav && nav.locks;
  if (real && typeof real.request === 'function') return real;
  return {
    request(name, opts, cb) {
      const fn = typeof opts === 'function' ? opts : cb;
      try { return Promise.resolve(fn({ name })); } catch (e) { return Promise.reject(e); }
    },
  };
}

/**
 * Микрофон и звук собеседника для createSoftphone({ media }).
 * attachRemote(pc) softphone.js зовёт много раз на одно соединение (каждая
 * дорожка, accepted, confirmed), поэтому поток в <audio> меняется, только
 * когда сменился сам набор звуковых дорожек; иначе звук бы заикался.
 */
export function browserMedia(doc, nav, win) {
  let el = null;
  let shown = [];   // звуковые дорожки, которые сейчас в el.srcObject
  let sinkId = '';  // выбранный динамик ('' — по умолчанию)

  const devices = () => (nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function' ? nav.mediaDevices : null);
  const quiet = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
  function applySink() {
    if (!el || typeof el.setSinkId !== 'function') return Promise.resolve();
    try { return Promise.resolve(el.setSinkId(sinkId)).catch(() => {}); } catch { return Promise.resolve(); } // динамик пропал — звук идёт в обычный
  }
  function audioEl() {
    if (el) return el;
    el = doc.createElement('audio');
    el.autoplay = true;
    el.setAttribute('data-softphone-remote', '');
    el.style.display = 'none';
    doc.body.appendChild(el);
    if (sinkId) applySink();
    return el;
  }

  return {
    // Нет mediaDevices — значит, браузер не считает адрес защищённым (http без
    // настройки компьютера): говорим «insecure», а не «микрофон не открылся».
    get isSecureContext() { return !!(win && win.isSecureContext) && !!devices(); },
    getUserMedia(c) {
      const d = devices();
      if (!d) return Promise.reject(Object.assign(new Error('navigator.mediaDevices is not available'), { name: 'NotSupportedError' }));
      return d.getUserMedia(c);
    },
    attachRemote(pc) {
      let receivers = [];
      try { receivers = pc && typeof pc.getReceivers === 'function' ? pc.getReceivers() : []; } catch { receivers = []; }
      const tracks = [];
      for (const r of receivers || []) {
        const t = r && r.track;
        if (t && t.kind === 'audio' && !tracks.includes(t)) tracks.push(t);
      }
      if (!tracks.length) return; // дорожки ещё не пришли — придёт 'track', позовут снова
      const a = audioEl();
      const same = tracks.length === shown.length && tracks.every((t) => shown.includes(t));
      if (same && !a.paused) return;
      if (!same) {
        const Stream = (win && win.MediaStream) || globalThis.MediaStream;
        a.srcObject = new Stream(tracks);
        shown = tracks;
      }
      // Автозапуск звука браузер может запретить — тогда повторит следующий attachRemote.
      try { quiet(a.play()); } catch { /* старый браузер: play() без обещания */ }
    },
    detachRemote() {
      shown = [];
      if (el) el.srcObject = null;
    },
    /** Динамик для собеседника; выбран до звонка — применится, когда появится <audio>. */
    setSink(id) {
      sinkId = id || '';
      return applySink();
    },
    /** Какой динамик сейчас выбран для собеседника ('' — по умолчанию). */
    get sinkId() { return sinkId; },
  };
}

function media() {
  if (!pageMedia) pageMedia = browserMedia(document, navigator, window);
  return pageMedia;
}

/** Телефон этой страницы (создаётся при первом вызове); без браузера — пустой. */
export function getSoftphone() {
  if (override) return override;
  if (instance) return instance;
  if (!hasBrowser()) return INERT;
  instance = createSoftphone({
    loadJsSIP,
    rpc: phoneRpc,
    media: media(),
    locks: browserLocks(navigator),
    storage: softphoneStorage,
    inputId: () => savedDevice('in'),
  });
  // Динамик, выбранный в прошлый раз, — сразу: первый же звонок звучит в нём.
  const out = savedDevice('out');
  if (out) media().setSink(out);
  // Закрыть или перезагрузить страницу во время звонка — браузер спрашивает
  // (задача 8): иначе разговор с пациентом обрывался бы молча. Один раз — вместе
  // с телефоном страницы.
  try { window.addEventListener('beforeunload', onLeave); } catch { /* без окна — нечего стеречь */ }
  // Вкладку закрыли или перезагрузили — номер выходит из АТС, пока соединение
  // ещё открыто (JsSIP шлёт REGISTER expires=0). pagehide приходит уже после
  // согласия уйти, вопрос beforeunload ему не мешает. Выбор «принимать звонки»
  // остаётся: после перезагрузки телефон включится сам, а вторая вкладка этого
  // сотрудника подхватит его, когда первую закрыли.
  try { window.addEventListener('pagehide', onHide); } catch { /* без окна — нечего снимать */ }
  // Финальное ревью (I3): вышли в другой вкладке или сессии больше нет — телефон
  // этой вкладки выключается (выбор сотрудника остаётся).
  listenLogout();
  return instance;
}
// supabase.rpc сеть не бросает: «сервер не ответил» приходит ошибкой без кода.
// Телефону это «не дошли» — повтор поможет, — поэтому бросаем: softphone.js
// ставит код unreachable. Ответ сервера (с кодом) — как есть.
async function phoneRpc(name, args) {
  const r = await supabase.rpc(name, args);
  if (r && r.error && !r.error.code) throw r.error;
  return r;
}
function onLeave(e) {
  const sp = peekSoftphone();
  if (!sp || typeof sp.busy !== 'function' || !sp.busy()) return;
  e.preventDefault();
  e.returnValue = '';
}
function onHide() {
  const sp = peekSoftphone();
  if (!sp || typeof sp.get !== 'function' || typeof sp.disable !== 'function') return;
  try {
    const s = sp.get();
    if (s && s.state !== 'off') sp.disable({ keepWanted: true });
  } catch { /* страница уходит — молча */ }
}

/** Телефон страницы, если он уже есть (или подмена); сам не создаёт. */
export function peekSoftphone() {
  return override || instance;
}

// ── Выход и вход от имени (задача 8) ────────────────────────────────────────
// Оба кончаются перезагрузкой страницы. Идёт звонок — сначала спросить
// (window.confirm — так спрашивает вся программа, и «Войти как сотрудник» тоже);
// дальше телефон выключается чисто — номер выходит из АТС, — а выбор
// сотрудника «принимать звонки» остаётся до его следующего входа. Телефона на
// странице нет — ничего не создаём и не спрашиваем.

/** Идёт звонок — спросить question (ключ словаря), можно ли его завершить; звонка нет — да. */
export function confirmEndCall(question) {
  const sp = peekSoftphone();
  if (!sp || typeof sp.busy !== 'function' || !sp.busy()) return true;
  try { return !!window.confirm(tr(question)); } catch { return true; }
}
/** Перед перезагрузкой (выход, вход от имени и возврат): выключить телефон, выбор сотрудника оставить. */
export function releasePhone() {
  stopReleaseWait();   // выключаем сейчас — ждать конца разговора больше нечего
  const sp = peekSoftphone();
  if (!sp || typeof sp.disable !== 'function') return;
  try { sp.disable({ keepWanted: true }); } catch { /* перезагрузка всё равно его снимет */ }
}

// ── Выход во всех вкладках (финальное ревью, I3) ────────────────────────────
// Сессия одна на весь браузер: вышли в одной вкладке — в остальных телефон
// остался бы в АТС до их перезагрузки, и звонки шли бы на компьютер, где уже
// никто не вошёл. Поэтому выход объявляется всем вкладкам: BroadcastChannel
// «easymed-softphone», а где его нет — событием storage (ключ ниже). Каждая
// вкладка с телефоном выключает его с выбором сотрудника. И своя вкладка гасит
// телефон, когда сервер ответил 401 (сессии нет) — supabase.js шлёт окну
// событие SESSION_GONE_EVENT.
const CHANNEL = 'easymed-softphone';
const LOGOUT_KEY = 'easymed.softphone.logout';
export const SESSION_GONE_EVENT = 'easymed:session-gone';
let pageChannel = null;   // канал этой вкладки: слушает и через него же объявляет (себе не приходит)

function listenLogout() {
  try {
    if (typeof BroadcastChannel === 'function') {
      pageChannel = new BroadcastChannel(CHANNEL);
      pageChannel.onmessage = (e) => { if (e && e.data && e.data.type === 'logout') releaseWhenIdle(); };
      // Под Node (стенды) открытый канал держал бы процесс; в браузере unref нет.
      if (typeof pageChannel.unref === 'function') pageChannel.unref();
    }
  } catch { pageChannel = null; }
  try { window.addEventListener('storage', (e) => { if (e && e.key === LOGOUT_KEY && e.newValue) releaseWhenIdle(); }); } catch { /* без окна */ }
  try { window.addEventListener(SESSION_GONE_EVENT, releaseWhenIdle); } catch { /* без окна */ }
}

// SOFTPHONE_V1 (ревью 09094415, A) — выход в другой вкладке или конец сессии
// во время разговора его не обрывают: звонок идёт напрямую с АТС, человек его
// договорит. Идёт вызов или разговор — ждём его конца и тогда выключаем телефон
// (один раз, сколько бы сигналов ни пришло); звонит (ещё не ответили) или
// звонка нет — выключаем сразу. Свой выход — по-прежнему вопрос и выключение.
const IN_CALL = new Set(['calling', 'in_call']);
let releaseWait = null;   // { sp, off } — ждём конца разговора этого телефона
function stopReleaseWait() {
  const w = releaseWait;
  releaseWait = null;
  if (w) { try { w.off(); } catch { /* пусть */ } }
}
function releaseWhenIdle() {
  const sp = peekSoftphone();
  if (!sp) return;
  let st = '';
  try { st = typeof sp.get === 'function' ? String((sp.get() || {}).state || '') : ''; } catch { st = ''; }
  if (!IN_CALL.has(st) || typeof sp.subscribe !== 'function') { releasePhone(); return; }
  if (releaseWait && releaseWait.sp === sp) return;   // уже ждём
  stopReleaseWait();
  const wait = { sp, off: () => {} };
  releaseWait = wait;
  const off = sp.subscribe((s) => {
    if (!s || IN_CALL.has(s.state) || releaseWait !== wait) return;
    stopReleaseWait();
    if (s.state !== 'off') releasePhone();   // уже выключен (закрыли вкладку, выключили сами) — выходить не из чего
  });
  wait.off = typeof off === 'function' ? off : () => {};
  if (releaseWait !== wait) { try { wait.off(); } catch { /* пусть */ } }   // кончился прямо при подписке
}

/** Выход объявлен (auth.js signOutAndReload, после вопроса о звонке): другим вкладкам — выключить телефон. */
export function announceLogout() {
  try {
    const ch = pageChannel || (typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null);
    if (ch) { ch.postMessage({ type: 'logout' }); if (ch !== pageChannel) ch.close(); }
  } catch { /* без каналов — остаётся storage */ }
  // Событие storage уходит другим вкладкам при записи; ключ сразу стираем, чтобы
  // он не копился (стирание — тоже событие, но с пустым newValue: его не слушаем).
  try { localStorage.setItem(LOGOUT_KEY, String(Date.now()) + '.' + Math.random().toString(36).slice(2)); localStorage.removeItem(LOGOUT_KEY); } catch { /* приватный режим */ }
}

/** Подмена для стендов: getSoftphone()/peekSoftphone() отдают её; null — снять. */
export function setSoftphoneForTests(fake) {
  override = fake || null;
}

/** Динамик для звука собеседника (setSinkId, где браузер умеет). */
export function setOutputDevice(id) {
  if (!hasBrowser()) return Promise.resolve();
  return media().setSink(id);
}
/** Динамик, выбранный для собеседника на этой странице ('' — по умолчанию или страницы ещё нет). */
export function outputSink() {
  return pageMedia ? pageMedia.sinkId : '';
}

// ── Гарнитура ───────────────────────────────────────────────────────────────
/** Браузер для гарнитуры: настоящий, а поверх — подмены стенда (over). */
function deviceEnv(over) {
  const win = typeof window !== 'undefined' ? window : null;
  const pick = (k) => globalThis[k] || (win && win[k]) || null;
  return {
    nav: typeof navigator !== 'undefined' ? navigator : null,
    win,
    MediaRecorder: pick('MediaRecorder'), Audio: pick('Audio'), URL: pick('URL'), Blob: pick('Blob'),
    setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
    tickMs: 1000,
    phone: peekSoftphone(),
    ...(over || {}),
  };
}
const mediaDevicesOf = (env) => (env.nav && env.nav.mediaDevices) || null;
// 'default' и 'communications' — записи Chrome «по умолчанию — <устройство>»:
// повторяют настоящее устройство (тот же groupId). Повтор не показываем; если
// это не повтор (подписей ещё нет, groupId пуст) — 'default' первым, «По умолчанию».
const PSEUDO = new Set(['default', 'communications']);

function devicesOf(all, kind, word) {
  const list = (all || []).filter((d) => d && d.kind === kind && d.deviceId);
  const real = list.filter((d) => !PSEUDO.has(d.deviceId));
  const dup = (d) => !!d.groupId && real.some((r) => r.groupId === d.groupId);
  const out = [];
  const def = list.find((d) => d.deviceId === 'default');
  if (def && !dup(def)) out.push({ id: 'default', label: tr('По умолчанию') });
  const comm = list.find((d) => d.deviceId === 'communications');
  real.forEach((d, i) => out.push({ id: d.deviceId, label: d.label || tr(word) + ' ' + (i + 1) }));
  if (comm && !dup(comm)) out.push({ id: 'communications', label: comm.label || tr(word) + ' ' + (real.length + 1) });
  return out;
}

/** Микрофоны и динамики этого компьютера: {inputs:[{id,label}], outputs:[{id,label}]}. */
export async function listDevices(over) {
  const md = mediaDevicesOf(deviceEnv(over));
  let all = [];
  try { if (md && typeof md.enumerateDevices === 'function') all = await md.enumerateDevices(); } catch { all = []; }
  return { inputs: devicesOf(all, 'audioinput', 'Микрофон'), outputs: devicesOf(all, 'audiooutput', 'Динамик') };
}

/** Умеет ли браузер выбрать динамик (setSinkId). Firefox — нет: выбора динамика не показываем. */
export function canChooseOutput(over) {
  const { win } = deviceEnv(over);
  try {
    const M = win && win.HTMLMediaElement;
    return !!(M && M.prototype && typeof M.prototype.setSinkId === 'function');
  } catch { return false; }
}

/** Подключили или вынули гарнитуру — fn(); вернуть функцию отписки. */
export function onDeviceChange(fn, over) {
  const md = mediaDevicesOf(deviceEnv(over));
  if (!md || typeof md.addEventListener !== 'function') return () => {};
  const handler = () => { try { fn(); } catch (e) { console.warn('[softphone] devicechange', e); } };
  try { md.addEventListener('devicechange', handler); } catch { return () => {}; }
  return () => { try { md.removeEventListener('devicechange', handler); } catch { /* уже нет */ } };
}

// Ошибка getUserMedia → код причины — те же коды, что у включения телефона (softphone.js micCode).
function micReason(e) {
  const name = (e && e.name) || '';
  if (name === 'NotAllowedError') return 'mic_denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no_mic';
  return 'mic_error';
}

let testing = false;   // проверка гарнитуры — одна за раз

/**
 * Проверка гарнитуры: записать ms миллисекунд с выбранного микрофона и сразу
 * проиграть в выбранный динамик. onPhase('recording', секунд осталось) — каждую
 * секунду; ('playing'); ('done'); ('error', код) — mic_denied / no_mic /
 * mic_error / insecure, а 'busy' — идёт звонок: микрофон звонка не трогаем;
 * ('cancelled') — прервали. Вторая проверка, пока идёт первая, — false без фаз.
 *
 * ПРЕРВАТЬ (ревью задачи 7): over.signal (AbortSignal) — ушли с «Моя трубка»;
 * и сама проверка следит за телефоном (phone.subscribe): зазвонило, набрали,
 * разговор — микрофон закрывается, запись останавливается, проигрывание
 * замолкает и не начинается: проверка не держит микрофон и не играет поверх
 * звонка.
 */
export async function micTest(ms = 5000, onPhase = () => {}, over) {
  const env = deviceEnv(over);
  const say = (...a) => { try { onPhase(...a); } catch (e) { console.warn('[softphone] micTest', e); } };
  const phone = env.phone;
  const phoneBusy = () => !!(phone && typeof phone.busy === 'function' && phone.busy());
  if (phoneBusy()) { say('error', 'busy'); return false; }
  if (testing) return false;
  testing = true;
  let stream = null;
  let url = '';
  let rec = null;
  let el = null;
  let tickHandle = null;
  let wake = null;          // разбудить текущее ожидание (секунды записи, проигрывание)
  let cancelled = false;
  const stopTracks = () => { try { if (stream) for (const t of stream.getTracks()) t.stop(); } catch { /* уже остановлены */ } stream = null; };
  const stopRec = () => { try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* уже остановлена */ } };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    stopTracks();
    stopRec();
    if (tickHandle !== null) { try { env.clearInterval(tickHandle); } catch { /* пусть */ } tickHandle = null; }
    if (el) { try { el.pause(); } catch { /* пусть */ } }
    if (wake) wake();
  };
  const signal = env.signal;
  if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', cancel);
  let unsub = null;
  try { if (phone && typeof phone.subscribe === 'function') unsub = phone.subscribe(() => { if (phoneBusy()) cancel(); }); } catch { unsub = null; }
  if (signal && signal.aborted) cancel();
  try {
    if (cancelled) { say('cancelled'); return false; }
    const md = mediaDevicesOf(env);
    if (!md || typeof md.getUserMedia !== 'function') { say('error', 'insecure'); return false; }
    const id = savedDevice('in');
    try {
      stream = await md.getUserMedia({ audio: id ? { deviceId: { ideal: id } } : true, video: false });
    } catch (e) { if (cancelled) { say('cancelled'); return false; } say('error', micReason(e)); return false; }
    if (cancelled) { stopTracks(); say('cancelled'); return false; }   // микрофон пришёл, когда уже прервали
    if (typeof env.MediaRecorder !== 'function') { say('error', 'mic_error'); return false; }
    const parts = [];
    rec = new env.MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e && e.data && e.data.size !== 0) parts.push(e.data); };
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });
    rec.start();
    let left = Math.max(1, Math.ceil(ms / 1000));
    say('recording', left);
    await new Promise((resolve) => {
      wake = resolve;
      tickHandle = env.setInterval(() => {
        if (cancelled) return;   // прервали — опоздавшая «секунда» ничего не говорит
        left -= 1;
        if (left > 0) { say('recording', left); return; }
        env.clearInterval(tickHandle);
        tickHandle = null;
        resolve();
      }, env.tickMs);
    });
    wake = null;
    if (cancelled) { say('cancelled'); return false; }
    if (rec.state !== 'inactive') { rec.stop(); await stopped; }   // неактивную не останавливаем и не ждём
    stopTracks();   // микрофон закрыт до того, как зазвучит запись
    if (cancelled) { say('cancelled'); return false; }
    const blob = new env.Blob(parts, { type: rec.mimeType || 'audio/webm' });
    if (!parts.length || blob.size === 0) { say('error', 'mic_error'); return false; }   // ничего не записалось — это не «готово»
    url = env.URL.createObjectURL(blob);
    el = new env.Audio(url);
    const out = savedDevice('out');
    if (out && typeof el.setSinkId === 'function') { try { await el.setSinkId(out); } catch { /* динамик пропал — играет в обычный */ } }
    if (cancelled) { say('cancelled'); return false; }
    say('playing');
    await new Promise((resolve) => {
      // 'ended' не пришёл — не висим: звук останавливаем по сроку.
      const safety = env.setTimeout(() => { try { el.pause(); } catch { /* пусть */ } resolve(); }, ms + 3000);
      const end = () => { env.clearTimeout(safety); resolve(); };
      wake = end;   // прервали — срок тоже снимаем
      el.onended = end;
      el.onerror = end;
      try { Promise.resolve(el.play()).catch(end); } catch { end(); }
    });
    wake = null;
    if (cancelled) { say('cancelled'); return false; }
    say('done');
    return true;
  } catch {
    if (cancelled) say('cancelled'); else say('error', 'mic_error');
    return false;
  } finally {
    stopTracks();
    if (url) { try { env.URL.revokeObjectURL(url); } catch { /* пусть */ } }
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', cancel);
    if (unsub) { try { unsub(); } catch { /* пусть */ } }
    testing = false;
  }
}

// ── Слова ───────────────────────────────────────────────────────────────────
const REASONS = {
  insecure: 'Микрофон на этом компьютере закрыт браузером: один раз запустите файл настройки компьютера EasyMed-ustanovka.cmd от имени администратора, затем закройте все окна браузера и откройте Easy-Med заново. Этот же файл включает и звук звонка.',
  mic_denied: 'Браузер не дал микрофон: разрешите его значком слева от адреса страницы и включите телефон снова.',
  no_mic: 'Микрофон не найден: подключите гарнитуру и включите телефон снова.',
  mic_error: 'Микрофон не открылся. Проверьте гарнитуру и включите телефон снова.',
  other_tab: 'Телефон включён в другой вкладке Easy-Med. Чтобы пользоваться им здесь, выключите его в той вкладке.',
  register_failed: 'АТС не приняла вход вашего внутреннего номера. Попросите администратора проверить номер в карточке сотрудника или попробуйте позже.',
  network: 'Нет связи с АТС — переподключаемся…',
  load_failed: 'Не удалось загрузить телефон. Обновите страницу.',
};
const SERVER_ERROR = 'Телефония ответила ошибкой. Попробуйте ещё раз через минуту.';
// Ревью 09094415 (C): до сервера не дошли — в message текст ошибки браузера
// («TypeError: Failed to fetch»), его не показываем. Панель повторяет сама.
const UNREACHABLE = 'Нет связи с сервером Easy-Med. Повторим автоматически.';

/** Причина из состояния телефона словами; server — слова самого сервера, если он их прислал; code unreachable — наша фраза. */
export function reasonText(reason, message = '', code = '') {
  if (reason === 'server' && code === 'unreachable') return tr(UNREACHABLE);
  if (reason === 'server') return tr(message || SERVER_ERROR);
  return Object.prototype.hasOwnProperty.call(REASONS, reason) ? tr(REASONS[reason]) : '';
}

// Итог звонка — по cause JsSIP 3.13.9 (JsSIP_C.causes).
const MIC_END = {
  mic_denied: 'Звонок не принят: браузер не дал микрофон.',
  no_mic: 'Звонок не принят: микрофон не найден.',
  mic_error: 'Звонок не принят: микрофон не открылся.',
};
const NORMAL_END = new Set(['', 'Terminated', 'BYE']);
const OWN_END = { out: 'Canceled', in: 'Rejected' }; // оператор сам сбросил исходящий / отклонил входящий
const MISSED = new Set(['Canceled', 'No Answer', 'Expires']); // входящий: звонивший положил трубку, не дождались ответа
const OUT_END = {
  Busy: 'Занято.',
  Rejected: 'Собеседник отклонил звонок.',
  'No Answer': 'Не дозвонились.',
  Unavailable: 'Не дозвонились.',
  'Request Timeout': 'Не дозвонились.',
  'Not Found': 'Такого номера нет.',
  'Address Incomplete': 'Такого номера нет.',
};
const LINK_LOST = 'Связь с АТС прервалась.';
const CUT_OFF = 'Звонок оборвался.';

/** Короткая строка о том, как кончился последний звонок; '' — кончился как обычно. */
export function endText(lastEnd) {
  if (!lastEnd) return '';
  const { direction, cause = '', media: mic } = lastEnd;
  if (mic && MIC_END[mic]) return tr(MIC_END[mic]);
  if (NORMAL_END.has(cause) || OWN_END[direction] === cause) return '';
  if (cause === 'Connection Error') return tr(LINK_LOST);
  if (direction === 'in' && MISSED.has(cause)) return tr('Пропущенный звонок.');
  if (direction === 'out' && OUT_END[cause]) return tr(OUT_END[cause]);
  return tr(CUT_OFF); // прочий сбой (RTP Timeout, WebRTC Error…) — не молчим
}
