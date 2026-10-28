// SOFTPHONE_V1 (задача 9) — ТЕЛЕФОН EASY-MED В НАСТОЯЩЕМ БРАУЗЕРЕ НА ПОДСТАВНОМ SIP-СЕРВЕРЕ.
//
//   node scripts/softphone-e2e/run.mjs [--out <папка>] [--headed]
//
// Поднимает Easy-Med на свежей базе (оператор с номером 108, линия onlinePBX,
// выдуманная пациентка «Тестова Пациентка» +998 90 111 22 33), вешает на тот же
// http-сервер подставной SIP-сервер с паролем (fake-sip.mjs, ws://127.0.0.1:<порт>/fake-sip)
// и гоняет в Chromium (Playwright из глобальной установки npm) сценарии 0–9:
// включение (и политика страницы для ws/wss), входящий принят (звук, «Микрофон
// выкл.»), отклонён, исходящий, «занято», перезагрузка, отбой до ответа с обеих
// сторон, неверный пароль, вторая вкладка. События станции о тех же звонках
// кладутся в живую ленту — блока «Звонит» поверх телефона быть не должно.
// Снимки — в --out (по умолчанию %TEMP%/easymed-sp-e2e); база удаляется в конце.
// Выход 0 — все сценарии прошли.
//
// Подмены — только в этом процессе: telephony_webrtc_me отдаёт адрес реле вместо
// onlinePBX; fetch и https наружу закрыты (станция и любые внешние адреса падают
// сразу), а браузер отводит *.onpbx.ru на 127.0.0.1. Рабочий код не меняется.
// В поставку scripts/ не едет (build-bundle.mjs).
//
// ЗАМЕР В ВКЛАДКЕ ОПЕРАТОРА. Звук собеседника проверяется по скрытому
// audio[data-softphone-remote] (живая дорожка), байты — getStats() соединения.
// Соединение вкладка наружу не отдаёт, поэтому стенд оборачивает
// window.RTCPeerConnection скриптом Playwright (addInitScript) — это обвязка
// проверки, в программе таких крючков нет.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
const OUT = path.resolve(arg('--out') || process.env.SOFTPHONE_E2E_OUT || path.join(os.tmpdir(), 'easymed-sp-e2e'));
const HEADED = argv.includes('--headed');
const DATA = path.join(OUT, 'run-data');
const SIP_LOG = path.join(OUT, 'fake-sip.log');
const CONSOLE_LOG = path.join(OUT, 'console.log');
const OPERATOR = 2;
const PATIENT_NAME = 'Тестова Пациентка';   // выдуманная
const PATIENT_NUM = '998901112233';
const THIRD_NUM = '998900000000';

// ── Наружу — ничего ─────────────────────────────────────────────────────────
// До загрузки сервера: модуль, запомнивший fetch при импорте, получит уже подмену.
const blocked = [];
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/i;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let host = '';
  try { host = new URL(String((input && input.url) || input)).hostname; } catch { host = '?'; }
  if (LOOPBACK.test(host)) return realFetch(input, init);
  blocked.push(host);
  throw new TypeError('fetch failed: проверка закрыла выход наружу (' + host + ')');
};
for (const k of ['request', 'get']) {
  const real = https[k];
  https[k] = function (...a) {
    const o = a.find((x) => x && typeof x === 'object' && !(x instanceof URL)) || {};
    const u = a.find((x) => typeof x === 'string' || x instanceof URL);
    const host = u ? new URL(String(u)).hostname : (o.hostname || o.host || '');
    if (!LOOPBACK.test(host)) { blocked.push(host); throw new Error('проверка закрыла выход наружу (' + host + ')'); }
    return real.apply(this, a);
  };
}

const { openDb } = await import('../../server/db/connection.js');
const { migrate } = await import('../../server/db/migrate.js');
const { createApp } = await import('../../server/app.js');
const { RPC } = await import('../../server/services/rpc/index.js');
const { hashPassword, login } = await import('../../server/services/auth.js');
const { canonical } = await import('../../server/services/control/canonical.js');
const { __setPublicKeyForTests } = await import('../../server/services/control/state.js');
const { listen } = await import('../../control-plane/server/test-helpers/listen.js');
const { attachFakeSip } = await import('./fake-sip.mjs');
const { noteEvent } = await import('../../server/services/telephony/live.js');
const { normalizePbxEvent } = await import('../../server/services/telephony/pbx-event.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
for (const f of [SIP_LOG, CONSOLE_LOG]) fs.writeFileSync(f, '');
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f));

// ── Лицензия: свой ключ, свой файл — как server/services/control/licensed-fixture.js ──
function writeLicence(dir) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  __setPublicKeyForTests(publicKey);
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ clinic_id: 'e2e-softphone', unlock_secret: 'e2e', subscription: 'active' }));
  const payload = { clinic_id: 'e2e-softphone', clinic_name: 'E2E', modules: ['crm', 'callcenter'],
    valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-10-01T00:00:00Z', nonce: 'e2e-softphone' };
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify({ payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64') }));
}

// ── База ─────────────────────────────────────────────────────────────────────
function seed(db) {
  const pw = hashPassword('password1');
  const ins = db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, extra_roles, must_change_password, pbx_extension, pbx_extension_assigned)
                          VALUES (?,?,?,?,?,'[]',0,?,?)`);
  ins.run(1, 'admin', pw, 'Администратор', 'admin', null, null);
  ins.run(OPERATOR, 'operator', pw, 'Оператор Проверка', 'registrar', '108', '108');
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get('registrar');
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), 'crm.dial': 'edit', 'crm.calls': 'view' };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), 'registrar');
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('registrar', JSON.stringify(perms));
  db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret, poll_interval_sec)
              VALUES ('onlinepbx', 'onlinepbx', 'АТС', 1, ?, ?, 30)`)
    .run(JSON.stringify({ domain: 'pbx-e2e.onpbx.ru' }), JSON.stringify({ auth_key: 'k', key_id: 'kid', key: 'kv' }));
  db.prepare('INSERT INTO patients (full_name, phone, branch_id) VALUES (?, ?, 1)').run(PATIENT_NAME, '+' + PATIENT_NUM);
}

writeLicence(DATA);
const db = openDb(path.join(DATA, 'easymed.db'));
migrate(db);
seed(db);
const app = createApp(db, { dataDir: DATA });
app.get('/e2e-patient.html', (req, res) => res.type('html').send(fs.readFileSync(path.join(HERE, 'patient.html'), 'utf8')));
const server = await listen(app);
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;
const SIP_PASSWORD = 'test-only';
const relay = attachFakeSip(server, { path: '/fake-sip', logFile: SIP_LOG, password: SIP_PASSWORD });
// Начало TLS (wss://) на этом простом http-сервере — непонятный запрос: так стенд видит,
// что браузер действительно пошёл соединяться (политика страницы его пропустила).
let tlsAttempts = 0;
server.on('clientError', (err, sock) => {
  tlsAttempts++;
  sock.destroy();
});

// Вход в АТС — к реле, а не к onlinePBX; и только оператору (как настоящий: свой номер).
// wrongPassword — сценарий «АТС не приняла вход».
let wrongPassword = false;
const realWebrtcMe = RPC.telephony_webrtc_me;
RPC.telephony_webrtc_me = (d, args, user) => {
  if (!user || user.id !== OPERATOR) return realWebrtcMe(d, args, user);
  return { extension: '108', user: '108', password: wrongPassword ? 'wrong' : SIP_PASSWORD,
    ws_url: 'ws://127.0.0.1:' + PORT + '/fake-sip', sip_domain: '127.0.0.1' };
};
const sipLog = () => fs.readFileSync(SIP_LOG, 'utf8');
// Станция видит тот же звонок и шлёт свои события («звонит», «ответили», «конец») с
// опозданием, как onlinePBX: кладём их в живую ленту этого процесса (telephony/live.js),
// откуда панель берёт блок «Звонит» (telephony_live раз в 2 с).
function station(event, uuid, caller = PATIENT_NUM) {
  const now = Date.now();
  noteEvent(db, normalizePbxEvent({ event, uuid, caller: '+' + caller, callee: '108' }, { now }), now);
}
const session = login(db, 'operator', 'password1');
if (!session.session) throw new Error('вход оператора не удался: ' + session.error);

// ── Браузер ──────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_DIR || path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'playwright');
const { chromium } = require(PW);
const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    // Имена станции и проверочного чужого адреса — на этот компьютер: браузер наружу не ходит.
    '--host-resolver-rules=MAP *.onpbx.ru 127.0.0.1, MAP *.example.com 127.0.0.1'],
});
const consoleLines = [];
let cspViolations = 0;
const CSP_PROBE_DENIED = 'wss://csp-probe.example.com:8082/';   // чужой адрес: политика страницы обязана его закрыть
function watch(page, tag) {
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('csp-probe.example.com') || t.includes('pbx-e2e.onpbx.ru')) return;   // ожидаемые отказы проверки политики (сценарий 0)
    if (/Content Security Policy|Refused to connect/i.test(t)) cspViolations++;
    if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(tag + ' ' + m.type() + ': ' + t.slice(0, 300));
  });
  page.on('pageerror', (e) => consoleLines.push(tag + ' pageerror: ' + String((e && e.message) || e).slice(0, 300)));
}
async function context() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });
  await ctx.grantPermissions(['microphone'], { origin: BASE });
  return ctx;
}

const ctxA = await context();
await ctxA.addCookies([{ name: 'emsid', value: session.session, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
await ctxA.addInitScript(({ uid }) => {
  // Тур первого входа закрыл бы панель — помечаем его пройденным (тот же ключ, что у onboarding.js).
  try {
    localStorage.setItem('em-onboarding:v1:' + uid, JSON.stringify({ version: 1, welcomeDone: true, neverShow: true, completedTours: {}, completedTips: {}, helpMode: false }));
  } catch { /* без хранилища — закроем кнопкой */ }
  // Обвязка проверки: соединения вкладки — для getStats() (см. шапку run.mjs).
  const Orig = window.RTCPeerConnection;
  if (Orig && !window.__e2ePcs) {
    window.__e2ePcs = [];
    window.RTCPeerConnection = class extends Orig {
      constructor(...a) { super(...a); window.__e2ePcs.push(this); }
    };
  }
  // Блок «Звонит» станции или всплывашка «Звонит: …» хоть на миг — считаем.
  window.__e2eStationRing = 0;
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((list) => {
      if (document.querySelector('[data-cph-ring]')) window.__e2eStationRing++;
      for (const m of list) for (const node of m.addedNodes) if (node.textContent && node.textContent.includes('Звонит: ')) window.__e2eStationRing++;
    }).observe(document.body, { childList: true, subtree: true });
  });
}, { uid: OPERATOR });
const dialRequests = [];
function wireA(page) {
  watch(page, 'A');
  page.on('request', (r) => { if (/\/api\/rpc\/telephony_dial(\?|$)/.test(r.url())) dialRequests.push(r.url()); });
  return page;
}
let pageA = wireA(await ctxA.newPage());   // в сценарии 9 её место займёт вторая вкладка

/**
 * Открыть WebSocket со страницы оператора: закрыла ли его политика страницы
 * (securitypolicyviolation). Имена *.onpbx.ru и *.example.com браузер отводит на
 * 127.0.0.1 (--host-resolver-rules), так что наружу не уходит ничего. Соединение не
 * откроется (TLS этот сервер не понимает), но его clientError (tlsAttempts) и есть
 * знак, что политика браузер пропустила.
 */
const wsProbe = (url) => pageA.evaluate((u) => new Promise((resolve) => {
  let violated = '';
  let finished = false;
  const onV = (e) => { violated = e.effectiveDirective || e.violatedDirective || 'csp'; };
  document.addEventListener('securitypolicyviolation', onV);
  const done = (how) => {
    if (finished) return;
    finished = true;
    setTimeout(() => { document.removeEventListener('securitypolicyviolation', onV); resolve({ violated, how }); }, 300);
  };
  setTimeout(() => done('timeout'), 3000);
  let ws;
  try { ws = new WebSocket(u, 'sip'); } catch (e) { done('threw ' + e.name); return; }
  ws.onopen = () => { ws.close(); done('open'); };
  ws.onerror = () => done('error');
  ws.onclose = () => done('close');
}), url);

async function patientPage(num) {
  const ctx = await context();
  const page = await ctx.newPage();
  watch(page, num === PATIENT_NUM ? 'B' : 'C');
  await page.goto(BASE + '/e2e-patient.html?user=' + num);
  await page.waitForFunction(() => window.state === 'registered', null, { timeout: 15000 })
    .catch(async () => { throw new Error('страница ' + num + ' не вошла в реле: ' + await page.evaluate(() => window.state)); });
  return { ctx, page };
}

// ── Помощники ────────────────────────────────────────────────────────────────
let shotNo = 0;
const shots = [];
async function shot(name) {
  const file = path.join(OUT, String(++shotNo).padStart(2, '0') + '-' + name + '.png');
  await sleep(400);   // панель выезжает и сдвигает экран — снимаем после движения
  await pageA.screenshot({ path: file });
  shots.push(file);
}
async function waitA(fn, arg, what, timeout = 10000) {
  try { await pageA.waitForFunction(fn, arg, { timeout, polling: 100 }); }
  catch { throw new Error('A: не дождались — ' + what); }
}
const sel = (s) => pageA.evaluate((q) => !!document.querySelector(q), s);
const textOf = (s) => pageA.evaluate((q) => { const e = document.querySelector(q); return e ? e.textContent.trim() : null; }, s);
/** Что сейчас у телефона на экране: состояние и причина словами (для текста ошибки). */
const spNow = () => pageA.evaluate(() => {
  const s = document.querySelector('[data-cph-sp-state]');
  const r = document.querySelector('[data-cph-sp-reason]');
  return (s ? s.getAttribute('data-cph-sp-state') : 'off') + (r ? ' — ' + r.textContent.trim() : '');
}).catch(() => '?');
async function waitCall(page, states, what, timeout = 10000) {
  try { await page.waitForFunction((s) => window.call && s.includes(window.call.state), states, { timeout, polling: 100 }); }
  catch { throw new Error(what + ': не дождались ' + states.join('/') + ', сейчас ' + JSON.stringify(await page.evaluate(() => window.call))); }
  return page.evaluate(() => ({ ...window.call }));
}
async function waitReadyA(what, timeout = 10000) {
  try {
    await waitA(() => {
      const st = document.querySelector('[data-cph-sp-state]');
      return st && st.getAttribute('data-cph-sp-state') === 'ready' && !document.querySelector('[data-cph-sp-card]');
    }, null, what, timeout);
  } catch (e) { throw new Error(e.message + ' (сейчас: ' + await spNow() + ')'); }
}
const drawerOpen = () => pageA.evaluate(() => { const d = document.querySelector('[data-cph-drawer]'); return !!d && !d.classList.contains('cph-closed'); });
async function statsA() {
  return pageA.evaluate(async () => {
    const pcs = (window.__e2ePcs || []).filter((p) => p.connectionState !== 'closed');
    const pc = pcs[pcs.length - 1];
    if (!pc) return null;
    let o = null;
    (await pc.getStats()).forEach((x) => {
      if (x.type === 'inbound-rtp' && x.kind === 'audio') o = { bytesReceived: x.bytesReceived || 0, packetsReceived: x.packetsReceived || 0, totalAudioEnergy: x.totalAudioEnergy || 0 };
    });
    return o;
  });
}
const statsOf = (page) => page.evaluate(() => window.stats());
const remoteAudio = () => pageA.evaluate(() => {
  const a = document.querySelector('audio[data-softphone-remote]');
  if (!a) return { element: false };
  const s = a.srcObject;
  const t = s && typeof s.getAudioTracks === 'function' ? s.getAudioTracks() : [];
  return { element: true, tracks: t.length, live: t.filter((x) => x.readyState === 'live').length, paused: a.paused };
});
/** Прирост за ms: байты и энергия звука входящей стороны. */
async function growth(get, ms) {
  const a = await get();
  await sleep(ms);
  const b = await get();
  if (!a || !b) return null;
  return { bytes0: a.bytesReceived, bytes1: b.bytesReceived, bytes: b.bytesReceived - a.bytesReceived, energy: b.totalAudioEnergy - a.totalAudioEnergy };
}
function check(ok, what, notes) {
  notes.push((ok ? 'да: ' : 'НЕТ: ') + what);
  if (!ok) throw new Error(what);
}

const results = [];
let current = null;   // идущий сценарий — его и покажет сторож, если проверка зависнет
async function flow(name, fn) {
  const notes = [];
  const t0 = Date.now();
  current = { name, notes };
  try {
    await fn(notes);
    results.push({ name, ok: true, notes, ms: Date.now() - t0 });
  } catch (e) {
    notes.push('ОШИБКА: ' + ((e && e.message) || e));
    try { await shot('fail'); } catch { /* страница могла упасть */ }
    results.push({ name, ok: false, notes, ms: Date.now() - t0 });
  }
  console.log((results[results.length - 1].ok ? 'PASS ' : 'FAIL ') + name);
  for (const n of notes) console.log('     ' + n);
}
/** После упавшего сценария — положить все трубки, чтобы следующий начинался с покоя. */
async function settle(...pages) {
  for (const p of pages) await p.evaluate(() => window.hangup()).catch(() => {});
  await pageA.evaluate(() => {
    for (const q of ['[data-cph-sp-hangup]', '[data-cph-sp-decline]']) { const b = document.querySelector(q); if (b) b.click(); }
  }).catch(() => {});
  await sleep(500);
}

// ── Сценарии ─────────────────────────────────────────────────────────────────
let B = null;
let C = null;
let exitCode = 1;
const watchdog = setTimeout(() => {
  console.error('проверка зависла — выходим' + (current ? ': ' + current.name + '\n     ' + current.notes.join('\n     ') : ''));
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* база открыта — уберёт следующий запуск */ }
  process.exit(2);
}, 6 * 60 * 1000);
try {
  await flow('0. Вход: страница, панель, переключатель → готов', async (n) => {
    await pageA.goto(BASE + '/admin.html');
    await waitA(() => !!document.querySelector('[data-crm-phone]'), null, 'кнопки «Телефон» в верхней панели', 20000);
    const skip = pageA.locator('.em-onb-btn', { hasText: 'Пропустить' });
    if (await skip.count()) await skip.first().click();
    await pageA.click('[data-crm-phone]');
    await waitA(() => !!document.querySelector('[data-cph-sp-toggle]'), null, 'переключателя «Принимать звонки в Easy-Med»');
    await pageA.click('[data-cph-sp-toggle]');
    await waitReadyA('состояния ready', 15000);
    check(await textOf('[data-cph-sp-state]') === 'Телефон Easy-Med включён', 'слово состояния «Телефон Easy-Med включён»', n);
    check(cspViolations === 0, 'политика страницы не закрыла ws://127.0.0.1:' + PORT + '/fake-sip (connect-src \'self\')', n);
    // Реле с паролем: 200 на REGISTER номера 108 бывает только после верного ответа на 401.
    const log = sipLog();
    check(/REGISTER → 401 \(пароль\)/.test(log) && /\(108\) REGISTER → 200/.test(log) && !/→ 403/.test(log),
      'пароль из telephony_webrtc_me дошёл до JsSIP: 401 → ответ Digest → 200', n);
    await shot('ready');
    // Контроль стенда: звонок станции мимо телефона Easy-Med панель показывает блоком
    // «Звонит» — значит, «блока нет» в сценариях ниже чего-то стоит.
    station('call_start', 'st-control', THIRD_NUM);
    await waitA(() => !!document.querySelector('[data-cph-ring="ringing"]'), null, 'контрольного блока «Звонит» станции', 6000);
    station('call_end', 'st-control', THIRD_NUM);
    await waitA(() => !!document.querySelector('[data-cph-ring-hide]'), null, 'кнопки «Скрыть» у блока станции', 6000);
    await pageA.click('[data-cph-ring-hide]');
    await waitA(() => !document.querySelector('[data-cph-ring]'), null, 'блок станции скрыт');
    await pageA.evaluate(() => { window.__e2eStationRing = 0; });
    n.push('да: контроль — звонок станции мимо телефона Easy-Med панель показывает блоком «Звонит»');
    // Политика страницы в браузере: адрес АТС, как его строит telephony_webrtc_me
    // (wss://<станция>.onpbx.ru:<порт>), пропускается; чужой wss — нет.
    const pbxUrl = 'wss://pbx-e2e.onpbx.ru:' + PORT + '/';   // имя станции отведено на этот же сервер
    const tls0 = tlsAttempts;
    const okPbx = await wsProbe(pbxUrl);
    check(!okPbx.violated && tlsAttempts > tls0, 'connect-src пропускает ' + pbxUrl + ' (wss://*.onpbx.ru:*): браузер начал TLS, отказа политики нет', n);
    const deny = await wsProbe(CSP_PROBE_DENIED);
    check(!!deny.violated, 'connect-src закрывает чужой ' + CSP_PROBE_DENIED + ' (' + deny.violated + ')', n);
    B = await patientPage(PATIENT_NUM);
    C = await patientPage(THIRD_NUM);
    n.push('«пациент» B (' + PATIENT_NUM + ') и третий C (' + THIRD_NUM + ') вошли в реле');
  });

  if (B && C) {
    await flow('1. Входящий, принят: имя, «Открыть карту», звук, микрофон выкл., завершить', async (n) => {
      await pageA.click('[data-cph-close]');
      await sleep(300);
      check(!(await drawerOpen()), 'панель перед звонком закрыта', n);
      await B.page.evaluate(() => window.callOperator('108'));
      await waitA(() => !!document.querySelector('[data-cph-sp-card="ringing"]'), null, 'карточки входящего');
      check(await drawerOpen(), 'входящий сам открыл панель', n);
      await waitA((name) => { const c = document.querySelector('[data-cph-sp-card="ringing"]'); return !!c && c.textContent.includes(name); }, PATIENT_NAME, 'имени пациентки на карточке', 5000);
      n.push('да: на карточке имя пациентки');
      check(await sel('[data-cph-sp-patient]'), 'кнопка «Открыть карту» есть', n);
      station('call_start', 'st-1');   // станция: «звонит» тот же звонок
      await sleep(2300);               // оператор берёт трубку не сразу — панель успевает спросить станцию
      await shot('incoming-ringing');
      await pageA.click('[data-cph-sp-answer]');
      const bc = await waitCall(B.page, ['confirmed'], 'B после «Принять»');
      check(bc.state === 'confirmed', 'у B звонок подтверждён (confirmed)', n);
      await waitA(() => !!document.querySelector('[data-cph-sp-card="in_call"]'), null, 'карточки разговора');
      station('call_answered', 'st-1');
      const t0 = await textOf('[data-cph-sp-timer]');
      await waitA(() => { const t = document.querySelector('[data-cph-sp-timer]'); return !!t && t.textContent.trim() !== '00:00'; }, null, 'таймер ушёл с 00:00', 2500);
      n.push('да: таймер пошёл (' + t0 + ' → ' + await textOf('[data-cph-sp-timer]') + ')');
      // Звук: живая дорожка в скрытом <audio> у A; байты растут у обеих сторон.
      await sleep(1000);
      const ra = await remoteAudio();
      check(ra.element && ra.tracks >= 1 && ra.live >= 1, 'у A audio[data-softphone-remote]: дорожек ' + ra.tracks + ', живых ' + ra.live + ', paused=' + ra.paused, n);
      const ga = await growth(statsA, 1500);
      const gb = await growth(() => statsOf(B.page), 1500);
      check(!!ga && ga.bytes > 0, 'A получает звук: bytesReceived ' + (ga && ga.bytes0) + ' → ' + (ga && ga.bytes1), n);
      check(!!gb && gb.bytes > 0, 'B получает звук: bytesReceived ' + (gb && gb.bytes0) + ' → ' + (gb && gb.bytes1), n);
      // Энергию звука Chrome считает только у звука, который куда-то выводится: > 0 у A —
      // значит, скрытый <audio> (attachRemote) действительно играет собеседника.
      check(!!ga && ga.energy > 0, 'A проигрывает звук собеседника: энергия звука за 1,5 с ' + (ga ? ga.energy.toFixed(4) : '?'), n);
      await shot('in-call');
      // Микрофон выкл.
      const loud = await growth(() => statsOf(B.page), 2000);
      await pageA.click('[data-cph-sp-mute]');
      await waitA(() => { const b = document.querySelector('[data-cph-sp-mute]'); return !!b && b.getAttribute('aria-pressed') === 'true'; }, null, 'aria-pressed="true" у «Микрофон выкл.»', 3000);
      check(await sel('[data-cph-sp-muted]'), '«Микрофон выкл.»: aria-pressed="true" и строка «Микрофон выключен — собеседник вас не слышит.»', n);
      await sleep(600);
      const quiet = await growth(() => statsOf(B.page), 2000);
      check(!!loud && !!quiet && loud.energy > 0 && quiet.energy < loud.energy * 0.2,
        'B перестал слышать оператора: за 2 с с микрофоном байт ' + (loud ? loud.bytes : '?') + ', энергия ' + (loud ? loud.energy.toFixed(4) : '?')
        + '; без микрофона байт ' + (quiet ? quiet.bytes : '?') + ', энергия ' + (quiet ? quiet.energy.toFixed(4) : '?'), n);
      await shot('muted');
      await pageA.click('[data-cph-sp-mute]');
      await waitA(() => { const b = document.querySelector('[data-cph-sp-mute]'); return !!b && b.getAttribute('aria-pressed') === 'false' && !document.querySelector('[data-cph-sp-muted]'); }, null, 'микрофон снова включён', 3000);
      await sleep(600);
      const again = await growth(() => statsOf(B.page), 2000);
      check(!!again && again.energy > quiet.energy, 'повторное нажатие включает микрофон: B снова слышит (энергия ' + (again ? again.energy.toFixed(4) : '?') + ')', n);
      await pageA.click('[data-cph-sp-hangup]');
      const end = await waitCall(B.page, ['ended'], 'B после «Завершить»');
      check(end.originator === 'remote', 'у B звонок кончился со стороны оператора (' + end.cause + ')', n);
      await waitReadyA('возврата в ready после «Завершить»');
      const after = await remoteAudio();
      check(!after.element || after.tracks === 0, 'звук собеседника снят (srcObject пуст)', n);
      await sleep(1000);
      station('call_end', 'st-1');     // станция сообщает конец с опозданием
      await sleep(4500);               // два опроса telephony_live
      check(await pageA.evaluate(() => window.__e2eStationRing) === 0,
        'события станции о том же звонке («звонит», «ответили», «конец») не показали блок «Звонит» и всплывашку ни на миг', n);
      await shot('after-hangup');
    });
    await settle(B.page, C.page);

    await flow('2. Входящий, отклонён', async (n) => {
      await B.page.evaluate(() => window.callOperator('108'));
      await waitA(() => !!document.querySelector('[data-cph-sp-card="ringing"]'), null, 'карточки входящего');
      station('call_start', 'st-2');
      await shot('incoming-to-decline');
      await pageA.click('[data-cph-sp-decline]');
      const bc = await waitCall(B.page, ['failed', 'ended'], 'B после «Отклонить»');
      check(bc.state === 'failed' && (bc.cause === 'Rejected' || bc.status === 603), 'у B звонок отклонён: ' + bc.cause + ', код ' + bc.status, n);
      await waitReadyA('возврата в ready после «Отклонить»');
      const end = await textOf('[data-cph-sp-end]');
      n.push('строка итога у A: ' + (end === null ? 'нет (своё «Отклонить» — не сбой)' : '«' + end + '»'));
      await sleep(800);
      station('call_end', 'st-2');     // для станции — неотвеченный: без «тишины» был бы блок «Пропущен»
      await sleep(4500);
      check(await pageA.evaluate(() => window.__e2eStationRing) === 0, 'станция («звонит» → «конец» без ответа) не показала блок «Звонит»/«Пропущен»', n);
      await shot('after-decline');
    });
    await settle(B.page, C.page);

    await flow('3. Исходящий через гарнитуру (без telephony_dial)', async (n) => {
      await B.page.evaluate(() => { window.autoAnswer = true; });
      if (!(await drawerOpen())) await pageA.click('[data-crm-phone]');
      await waitA(() => !!document.querySelector('.cph-pad [data-k="9"]'), null, 'клавиатуры набора');
      for (const d of PATIENT_NUM) await pageA.click('.cph-pad [data-k="' + d + '"]');
      const hint = await textOf('[data-cph-hint]');
      check(hint === 'Звонок пойдёт через гарнитуру этого компьютера', 'подсказка «Звонок пойдёт через гарнитуру этого компьютера»', n);
      await shot('typed');
      const before = dialRequests.length;
      await pageA.click('[data-cph-call]');
      await waitA(() => !!document.querySelector('[data-cph-sp-card="calling"], [data-cph-sp-card="in_call"]'), null, 'карточки вызова');
      const bc = await waitCall(B.page, ['confirmed'], 'B (автоответ)');
      check(bc.direction === 'in', 'B получил входящий от оператора', n);
      await waitA(() => !!document.querySelector('[data-cph-sp-card="in_call"]'), null, 'разговора у A');
      await waitA(() => { const t = document.querySelector('[data-cph-sp-timer]'); return !!t && t.textContent.trim() !== '00:00'; }, null, 'таймер ушёл с 00:00', 2500);
      n.push('да: у A разговор и таймер (' + await textOf('[data-cph-sp-timer]') + ')');
      check(await pageA.evaluate((name) => document.querySelector('[data-cph-sp-card="in_call"]').textContent.includes(name), PATIENT_NAME), 'на карточке исходящего имя пациентки', n);
      await sleep(500);
      const ra = await remoteAudio();
      check(ra.element && ra.live >= 1, 'у A audio[data-softphone-remote]: живых дорожек ' + ra.live, n);
      const ga = await growth(statsA, 1500);
      check(!!ga && ga.bytes > 0 && ga.energy > 0, 'A слышит пациентку: bytesReceived ' + (ga && ga.bytes0) + ' → ' + (ga && ga.bytes1)
        + ', энергия звука ' + (ga ? ga.energy.toFixed(4) : '?'), n);
      await shot('outgoing-in-call');
      await B.page.evaluate(() => window.hangup());
      await waitReadyA('возврата в ready после отбоя B');
      const end = await textOf('[data-cph-sp-end]');
      n.push('строка итога у A: ' + (end === null ? 'нет (обычный конец)' : '«' + end + '»'));
      check(dialRequests.length === before && dialRequests.length === 0, '/api/rpc/telephony_dial не вызывался ни разу', n);
      await shot('outgoing-ended');
    });
    await B.page.evaluate(() => { window.autoAnswer = false; }).catch(() => {});
    await settle(B.page, C.page);

    await flow('4. Занято: третий звонит во время разговора — 486', async (n) => {
      await B.page.evaluate(() => window.callOperator('108'));
      await waitA(() => !!document.querySelector('[data-cph-sp-card="ringing"]'), null, 'карточки входящего');
      await pageA.click('[data-cph-sp-answer]');
      await waitCall(B.page, ['confirmed'], 'B после «Принять»');
      await waitA(() => !!document.querySelector('[data-cph-sp-card="in_call"]'), null, 'разговора у A');
      await C.page.evaluate(() => window.callOperator('108'));
      const cc = await waitCall(C.page, ['failed', 'ended'], 'C');
      check(cc.state === 'failed' && cc.status === 486, 'C получил ' + cc.status + ' (' + cc.cause + ')', n);
      check(await sel('[data-cph-sp-card="in_call"]'), 'у A разговор с B продолжается', n);
      const bc = await B.page.evaluate(() => ({ ...window.call }));
      check(bc.state === 'confirmed', 'у B звонок не оборвался', n);
      await shot('busy-third-caller');
      await pageA.click('[data-cph-sp-hangup]');
      await waitCall(B.page, ['ended'], 'B после «Завершить»');
      await waitReadyA('возврата в ready');
    });
    await settle(B.page, C.page);

    await flow('5. Перезагрузка страницы: телефон включается сам', async (n) => {
      await pageA.reload();
      await waitA(() => !!document.querySelector('[data-crm-phone]'), null, 'кнопки «Телефон» после перезагрузки', 20000);
      await pageA.click('[data-crm-phone]');
      await waitReadyA('ready без щелчка по переключателю', 15000);
      check(await pageA.evaluate(() => document.querySelector('[data-cph-sp-toggle]').checked), 'переключатель включён сам', n);
      await shot('after-reload-ready');
      await B.page.evaluate(() => window.callOperator('108'));
      await waitA(() => !!document.querySelector('[data-cph-sp-card="ringing"]'), null, 'входящего после перезагрузки');
      n.push('да: входящий после перезагрузки звонит');
      await pageA.click('[data-cph-sp-decline]');
      await waitCall(B.page, ['failed'], 'B после «Отклонить»');
      await waitReadyA('возврата в ready');
      const st = await pageA.evaluate(() => window.__e2eStationRing);
      n.push('блок станции после перезагрузки (недавний звонок станции из сценария 2): ' + (st ? 'показывался' : 'нет') + ' (сведения)');
    });
    await settle(B.page, C.page);

    await flow('6. Звонивший положил трубку до ответа (CANCEL) — пропущенный', async (n) => {
      await B.page.evaluate(() => window.callOperator('108'));
      await waitA(() => !!document.querySelector('[data-cph-sp-card="ringing"]'), null, 'карточки входящего');
      const seen = await pageA.evaluate(() => window.__e2eStationRing);
      station('call_start', 'st-6');
      await sleep(2300);
      await B.page.evaluate(() => window.hangup());
      const bc = await waitCall(B.page, ['failed'], 'B после отбоя до ответа');
      check(bc.cause === 'Canceled', 'у B вызов отменён (' + bc.cause + ')', n);
      await waitReadyA('возврата в ready');
      check(/CANCEL → ws\d+\(108\)/.test(sipLog()), 'CANCEL дошёл до оператора тем же путём, что INVITE', n);
      check(await textOf('[data-cph-sp-end]') === 'Пропущенный звонок.', 'строка итога «Пропущенный звонок.»', n);
      await sleep(800);
      station('call_end', 'st-6');
      await sleep(4500);
      check(await pageA.evaluate(() => window.__e2eStationRing) === seen, 'станция не показала второй блок «Пропущен» поверх строки телефона', n);
      await shot('missed');
    });
    await settle(B.page, C.page);

    await flow('7. Оператор сбросил исходящий до ответа', async (n) => {
      await waitA(() => !!document.querySelector('.cph-pad [data-k="9"]'), null, 'клавиатуры набора');
      for (const d of PATIENT_NUM) await pageA.click('.cph-pad [data-k="' + d + '"]');
      await pageA.click('[data-cph-call]');
      await waitA(() => !!document.querySelector('[data-cph-sp-card="calling"]'), null, 'карточки «Вызов…»');
      await waitCall(B.page, ['new', 'progress'], 'B звонит');
      check(await pageA.evaluate(() => document.querySelector('[data-cph-sp-mute]').disabled), '«Микрофон выкл.» до ответа неактивна', n);
      await shot('outgoing-calling');
      await pageA.click('[data-cph-sp-hangup]');
      const bc = await waitCall(B.page, ['failed'], 'B после сброса оператором');
      check(bc.cause === 'Canceled', 'у B вызов отменён (' + bc.cause + ')', n);
      await waitReadyA('возврата в ready');
      check(await textOf('[data-cph-sp-end]') === null, 'своя отмена — без строки итога', n);
      check(dialRequests.length === 0, '/api/rpc/telephony_dial не вызывался', n);
    });
    await settle(B.page, C.page);

    await flow('8. Неверный пароль АТС — причина словами, затем снова включается', async (n) => {
      wrongPassword = true;
      await pageA.click('[data-cph-sp-toggle]');
      await waitA(() => !document.querySelector('[data-cph-sp-state]'), null, 'телефон выключен');
      await pageA.click('[data-cph-sp-toggle]');
      await waitA(() => !!document.querySelector('[data-cph-sp-state="error"]'), null, 'состояния error');
      const reason = await textOf('[data-cph-sp-reason="register_failed"]');
      check(!!reason && reason.startsWith('АТС не приняла вход'), 'причина: «' + reason + '»', n);
      await shot('wrong-password');
      wrongPassword = false;
      await pageA.click('[data-cph-sp-toggle]');
      await waitA(() => !document.querySelector('[data-cph-sp-state]'), null, 'телефон выключен');
      await pageA.click('[data-cph-sp-toggle]');
      await waitReadyA('ready с верным паролем', 15000);
      n.push('да: с верным паролем снова «Телефон Easy-Med включён»');
    });
  }
  if (B && C) {
    await settle(B.page, C.page);
    await flow('9. Вторая вкладка: «в другой вкладке»; закрыли первую — вторая входит сама', async (n) => {
      const tab2 = wireA(await ctxA.newPage());
      await tab2.goto(BASE + '/admin.html');
      await tab2.waitForFunction(() => !!document.querySelector('[data-crm-phone]'), null, { timeout: 20000 });
      await tab2.click('[data-crm-phone]');
      await tab2.waitForFunction(() => !!document.querySelector('[data-cph-sp-state="other_tab"]'), null, { timeout: 10000 })
        .catch(() => { throw new Error('вторая вкладка: нет состояния other_tab'); });
      check(await tab2.evaluate(() => (document.querySelector('[data-cph-sp-reason]') || {}).textContent || '').then((t) => t.startsWith('Телефон включён в другой вкладке')),
        'вторая вкладка: «Телефон включён в другой вкладке…» (Web Locks)', n);
      const first = pageA;
      pageA = tab2;
      await shot('second-tab');
      await first.close();
      await waitReadyA('вторая вкладка вошла сама после закрытия первой', 15000);
      n.push('да: первую закрыли — вторая «Телефон Easy-Med включён» без щелчка');
      await B.page.evaluate(() => window.callOperator('108'));
      await waitA(() => !!document.querySelector('[data-cph-sp-card="ringing"]'), null, 'входящего во второй вкладке');
      await pageA.click('[data-cph-sp-decline]');
      await waitCall(B.page, ['failed'], 'B после «Отклонить»');
      n.push('да: входящий звонит во второй вкладке');
    });
  }
  exitCode = results.every((r) => r.ok) && results.length === 10 ? 0 : 1;
} finally {
  clearTimeout(watchdog);
  fs.writeFileSync(CONSOLE_LOG, consoleLines.join('\n') + (consoleLines.length ? '\n' : ''));
  await browser.close().catch(() => {});
  relay.close();
  await new Promise((r) => server.close(() => r()));
  db.close();
  try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.error('базу удалить не вышло: ' + e.message); }
}

console.log('');
console.log('Итог: ' + results.filter((r) => r.ok).length + ' из ' + results.length + ' сценариев прошли.');
console.log('Внешние адреса, закрытые проверкой: ' + (blocked.length ? [...new Set(blocked)].join(', ') : 'нет обращений'));
console.log('Ошибок и предупреждений консоли: ' + consoleLines.length + ' (' + CONSOLE_LOG + ')');
console.log('Журнал реле: ' + SIP_LOG);
console.log('Снимки (' + shots.length + '): ' + OUT);
process.exit(exitCode);
