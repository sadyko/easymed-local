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
//   • флаг «включён» и выбранная гарнитура — localStorage (ошибки хранилища
//     глотаются: приватный режим не должен ронять телефон);
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
import { supabase } from '../supabase.js';
import { tr } from './i18n.js';
import { createSoftphone } from './softphone.js';

const DEVICE_KEY = 'easymed.softphone.';
const OFF = Object.freeze({ state: 'off', reason: '', message: '', extension: '', call: null, lastEnd: null });
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

const storage = {
  getItem(k) { try { return localStorage.getItem(k); } catch { return null; } },
  setItem(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  removeItem(k) { try { localStorage.removeItem(k); } catch { /* приватный режим */ } },
};

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
    rpc: (name, args) => supabase.rpc(name, args),
    media: media(),
    locks: browserLocks(navigator),
    storage,
    inputId: () => savedDevice('in'),
  });
  return instance;
}

/** Телефон страницы, если он уже есть (или подмена); сам не создаёт. */
export function peekSoftphone() {
  return override || instance;
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

// ── Слова ───────────────────────────────────────────────────────────────────
const REASONS = {
  insecure: 'Микрофон на этом компьютере закрыт браузером: один раз запустите файл настройки компьютера EasyMed-ustanovka.cmd от имени администратора, затем закройте все окна браузера и откройте Easy-Med заново.',
  mic_denied: 'Браузер не дал микрофон: разрешите его значком слева от адреса страницы и включите телефон снова.',
  no_mic: 'Микрофон не найден: подключите гарнитуру и включите телефон снова.',
  mic_error: 'Микрофон не открылся. Проверьте гарнитуру и включите телефон снова.',
  other_tab: 'Телефон работает в другой вкладке Easy-Med.',
  register_failed: 'АТС не приняла вход вашего внутреннего номера. Попросите администратора проверить номер в карточке сотрудника или попробуйте позже.',
  network: 'Нет связи с АТС — переподключаемся…',
  load_failed: 'Не удалось загрузить телефон. Обновите страницу.',
};
const SERVER_ERROR = 'Телефония ответила ошибкой. Попробуйте ещё раз через минуту.';

/** Причина из состояния телефона словами; server — слова самого сервера, если он их прислал. */
export function reasonText(reason, message = '') {
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
