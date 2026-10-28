# SOFTPHONE_V1 — телефон внутри Easy-Med. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the «Телефон» panel becomes a real phone. With «Принимать звонки в Easy-Med» on, the operator's internal number registers from the browser over WebRTC (onlinePBX), incoming calls ring in Easy-Med (Принять / Отклонить / Завершить, таймер, «Микрофон выкл.»), and «Позвонить» calls through the computer headset.

**Architecture:** a vendored JsSIP bundle (ESM, one file) and three new units:
1. **Server.** RPC `telephony_webrtc_me` in `rpc/phone.js` hands the user ONLY their own extension's WebRTC credentials, read from onlinePBX `user/get.json` (`fields:"num,name,enabled,webrtc"`). RPC `telephony_caller` names a caller by number with the same lookup «Звонит» uses.
2. **`public/js/admin/softphone.js`.** A DOM-free state machine around a JsSIP UA. All browser services are injected, so it is tested with fakes.
3. **`public/js/admin/softphone-browser.js`.** Wires the real browser services: JsSIP bundle, `navigator.mediaDevices`, `navigator.locks`, `localStorage`, `supabase.rpc`, a hidden `<audio>`.

`views/crm-phone.js` draws the states.

**Changes made during the build (2026-10-28). These override the task text below:**
- **CSP.** `connect-src 'self' wss://*.onpbx.ru:*` (Task 2, Step 3b); otherwise the browser blocks the WebSocket to the PBX.
- **Station errors.** A station error returns **400** with the fixed `dialMessage(reason)` sentence, not 502. `routes/rpc.js` hides every ≥500 behind «Ошибка сервера», and `telephonyDial` already uses 400.
- **Licence gate.** `telephony_webrtc_me` is in no gate list: closed when the licence is locked, and it counts as an action in the act-as journal. The station host must match `*.onpbx.ru[:port]`, otherwise 409.
- **Number ownership.** Task 2b was added (owner decision: the softphone works only on the number the admin assigned).
- **`createSoftphone` loads JsSIP itself.** It takes `loadJsSIP: async () => JsSIP` (called in `enable()`) instead of `JsSIP`; a getter would be captured once at creation. A failed load gives reason `load_failed`. Task 4 passes `loadJsSIP: () => import('../vendor/jssip-3.13.9.mjs').then((m) => m.default || m)` and does NOT wrap `enable`.
- **Remote audio.** `media.attachRemote(pc)` receives the RTCPeerConnection, and the browser layer builds the stream from `pc.getReceivers()`; `media.detachRemote()` runs at call end. For outgoing calls JsSIP emits `peerconnection` inside `ua.call()` before listeners attach, so the session's `connection` is hooked directly.
- **ICE.** `call()` and `answer()` pass `pcConfig: { iceServers: [] }`: no public STUN, since clinics may have no route to it.
- **One tab.** It works through Web Locks. A tab that finds the lock taken shows `other_tab`, then queues a waiting request (abortable) and takes over by itself when the other tab lets go.
- **Retries.** `enable()` is idempotent while in flight, `disable()` during `enable()` wins, and `registrationFailed` with 'Connection Error' or 'Request Timeout' means `network`, not `register_failed`.

**Tech Stack:** Node 24 ESM, express 5, better-sqlite3, node:test; vanilla-JS SPA with `h()`/`Icon()`/`tr()`; JsSIP 3.13.9 (MIT) bundled with esbuild into `public/js/vendor/jssip-3.13.9.mjs`.

**Spec:** `docs/specs/2026-10-29-softphone-design.md`. Branch `feat/softphone` in `easymed.api5`, base `8c96b9a9`. That base is the merged 3.18.0 plus fixes; `act_as` is migration 255 and the highest migration is 258.

**Facts verified 2026-10-28:**
- onlinePBX returns `webrtc:{host:"pbx38631.onpbx.ru:8082", user:"108", password:<32>}` only when `fields` is a comma STRING (an array is ignored).
- `wss://<host>/` answers 101 with subprotocol `sip`, with a valid certificate.

**Rules for every task:**
- TDD: failing test first.
- Never `git stash/checkout/restore/reset/rebase/push`. Stage named files only, after checking that `git diff --cached --name-only` is empty.
- Commit messages in Russian, written to a file with the Write tool and committed with `git commit -F <file>`, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- LF line endings. Russian comments, with marker `SOFTPHONE_V1`.
- All UI text goes through `tr()` with ru/uz/en entries in `public/js/admin/i18n-strings.js`, with no Cyrillic in uz/en. Server refusal texts need dictionary entries too (guard `server-messages-i18n.test.mjs`).
- Icons only via `Icon()`. Font sizes from the type scale (guard `type-scale.test.mjs`).
- Never print or log the WebRTC password.
- Test commands:
  - server: `LIS_ENABLED=0 node --test <file>`;
  - client: `node --experimental-vm-modules --test <file>`;
  - en-US: add `--import "file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs"`.

---

## File structure

| File | Responsibility |
|---|---|
| `public/js/vendor/jssip-3.13.9.mjs` (+ `jssip-LICENSE.md`) | JsSIP as one ESM module; exports `UA`, `WebSocketInterface`, `debug` |
| `scripts/vendor-jssip.md` | how the bundle was built (reproducible) |
| `server/services/rpc/phone.js` | + `telephonyWebrtcMe`, `telephonyCaller` |
| `server/services/telephony/live.js` | export the existing `enrich` as `callerInfo` |
| `server/services/rpc/index.js` | register the 2 RPCs |
| `server/services/control/gate.js` | `telephony_caller` → `READ_ONLY_RPCS`; `telephony_webrtc_me` deliberately NOT |
| `public/js/admin/softphone.js` | DOM-free state machine (`createSoftphone`) |
| `public/js/admin/softphone-browser.js` | real browser deps + singleton `getSoftphone()`, `setSoftphoneForTests()` |
| `public/js/admin/views/crm-phone.js` | switch, incoming / in-call / outgoing UI, headset section, guards |
| `public/css/admin-views.css` | styles for the new panel parts (`.cph-sp-*`) |
| tests | `server/services/rpc/phone-webrtc.test.js`, `public/js/admin/__tests__/softphone.test.mjs`, `public/js/admin/__tests__/crm-phone-softphone.test.mjs`, `public/js/vendor/__tests__/jssip-bundle.test.mjs` |

---

### Task 1: Vendor JsSIP as one ESM file

**Files:**
- Create: `public/js/vendor/jssip-3.13.9.mjs`, `public/js/vendor/jssip-LICENSE.md`, `scripts/vendor-jssip.md`
- Test: `public/js/vendor/__tests__/jssip-bundle.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// public/js/vendor/__tests__/jssip-bundle.test.mjs
// SOFTPHONE_V1 — бандл JsSIP: один ESM-файл без внешних импортов, отдаёт UA и WebSocketInterface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../jssip-3.13.9.mjs', import.meta.url));

test('бандл JsSIP: файл есть, импортов наружу нет', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.ok(src.length > 100000, 'бандл подозрительно мал');
  assert.equal(/\bfrom\s+['"](?!\.)/.test(src) || /\brequire\(/.test(src), false, 'внешних import/require быть не должно');
});

test('бандл JsSIP: UA и WebSocketInterface — конструкторы', async () => {
  const m = await import('../jssip-3.13.9.mjs');
  const J = m.default || m;
  assert.equal(typeof J.UA, 'function');
  assert.equal(typeof J.WebSocketInterface, 'function');
  assert.match(String(J.version || ''), /^3\.13\./);
});

test('лицензия MIT лежит рядом', () => {
  const lic = fs.readFileSync(fileURLToPath(new URL('../jssip-LICENSE.md', import.meta.url)), 'utf8');
  assert.match(lic, /MIT|Permission is hereby granted/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run `node --test public/js/vendor/__tests__/jssip-bundle.test.mjs`. Expected: FAIL (`ENOENT` for `jssip-3.13.9.mjs`).

- [ ] **Step 3: Build the bundle** in a scratch folder (NOT in the repo):

```bash
SP="C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/jssip-build"
mkdir -p "$SP" && cd "$SP"
npm init -y >/dev/null
npm install --no-audit --no-fund jssip@3.13.9 events@3.3.0 esbuild@0.24.0
printf "import * as JsSIP from 'jssip';\nexport default JsSIP;\nexport const { UA, WebSocketInterface, version } = JsSIP;\n" > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --platform=browser --minify --legal-comments=eof --outfile=jssip-3.13.9.mjs
```

Copy `jssip-3.13.9.mjs` to `public/js/vendor/` and `node_modules/jssip/LICENSE.md` to `public/js/vendor/jssip-LICENSE.md`. Then write `scripts/vendor-jssip.md` containing exactly the commands above, plus one sentence: «Бандл собран 2026-10-29 из jssip@3.13.9 (MIT); пересобирать теми же командами при смене версии.»

- [ ] **Step 4: Run the test and watch it pass**

Run `node --test public/js/vendor/__tests__/jssip-bundle.test.mjs`. Expected: 3 pass. If `debug` in the bundle needs `process`, add `--define:process.env.NODE_ENV='"production"'` and rebuild.

- [ ] **Step 5: Check bundle size and that it isn't shipped twice.** Ensure `public/js/vendor/` is not excluded by the release bundle allow-list (`scripts/build-bundle*`, test `not-shipped`). Then run:

```bash
node --test scripts/*.test.* public/js/admin/__tests__/no-stray-globals.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

`git add public/js/vendor/jssip-3.13.9.mjs public/js/vendor/jssip-LICENSE.md public/js/vendor/__tests__/jssip-bundle.test.mjs scripts/vendor-jssip.md`, then commit with the message «Телефон в Easy-Med: JsSIP 3.13.9 (MIT) одним ESM-файлом в vendor (SOFTPHONE_V1)».

---

### Task 2: Server — own WebRTC credentials and the caller lookup

**Files:**
- Modify: `server/services/telephony/live.js` (export `callerInfo`)
- Modify: `server/services/rpc/phone.js` (2 functions)
- Modify: `server/services/rpc/index.js` (register)
- Modify: `server/services/control/gate.js` (`telephony_caller` → `READ_ONLY_RPCS`)
- Modify: `public/js/admin/i18n-strings.js` (3 refusal texts)
- Modify: `server/app.js` (CSP `connect-src`: add `wss://*.onpbx.ru:*`; without it the browser blocks the WebSocket to the PBX)
- Test: `server/services/rpc/phone-webrtc.test.js`, plus one CSP assertion (see Step 3b)

- [ ] **Step 1: Write the failing test**

```js
// server/services/rpc/phone-webrtc.test.js
// SOFTPHONE_V1 — вход телефона Easy-Med в АТС: только СВОЙ внутренний номер, только с правом набора,
// не от чужого имени; пароль не выходит никуда, кроме ответа владельцу номера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telephonyWebrtcMe, telephonyCaller } from './phone.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

function seed({ ext = '108' } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension) VALUES (1,'op','x','Оператор','registrar',?)").run(ext);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'doc','x','Врач','doctor')").run();
  db.prepare(`INSERT INTO telephony_providers (kind, name, enabled, config, secret)
              VALUES ('onlinepbx', 'АТС', 1, '{"domain":"pbx38631.onpbx.ru"}', '{"auth_key":"k"}')`).run();
  return db;
}
const OP = { id: 1, role: 'registrar', full_name: 'Оператор', acting_admin: null };
const DOC = { id: 2, role: 'doctor', full_name: 'Врач', acting_admin: null };

function fakePbx(reply) {
  const calls = [];
  const impl = async (domain, path, params) => { calls.push({ domain, path, params }); return reply; };
  return { impl, calls };
}

test('свой номер: host, user, password, ws_url и sip_domain; поля — СТРОКОЙ через запятую', async () => {
  const db = seed();
  const pbx = fakePbx({ ok: true, data: [{ num: '108', name: 'x', enabled: true, webrtc: { host: 'pbx38631.onpbx.ru:8082', user: '108', password: 'p'.repeat(32) } }] });
  const r = await telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: pbx.impl });
  assert.deepEqual(r, { extension: '108', user: '108', password: 'p'.repeat(32), ws_url: 'wss://pbx38631.onpbx.ru:8082', sip_domain: 'pbx38631.onpbx.ru' });
  assert.equal(pbx.calls[0].path, 'user/get.json');
  assert.deepEqual(pbx.calls[0].params, { num: '108', fields: 'num,name,enabled,webrtc' });
});

test('без внутреннего номера — 400 со словами; без права набора — 403; от чужого имени — 403', async () => {
  await assert.rejects(telephonyWebrtcMe(seed({ ext: null }), {}, OP, { pbxCallImpl: fakePbx({ ok: true, data: [] }).impl }),
    (e) => e.status === 400 && /внутренний номер/.test(e.message));
  await assert.rejects(telephonyWebrtcMe(seed(), {}, DOC, { pbxCallImpl: fakePbx({ ok: true, data: [] }).impl }),
    (e) => e.status === 403);
  await assert.rejects(telephonyWebrtcMe(seed(), {}, { ...OP, acting_admin: { id: 9, full_name: 'Адм' } }, { pbxCallImpl: fakePbx({ ok: true, data: [] }).impl }),
    (e) => e.status === 403 && /чужого имени/.test(e.message));
});

test('станция не дала webrtc номеру — 409 со словами, пароль не придуман', async () => {
  const pbx = fakePbx({ ok: true, data: [{ num: '108', enabled: true }] });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl }),
    (e) => e.status === 409 && /браузер/.test(e.message));
});

test('станция ответила ошибкой — 502 с её причиной, не 500', async () => {
  const pbx = fakePbx({ ok: false, reason: 'bad_credentials' });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl }), (e) => e.status === 502);
});

test('кто звонит: пациент и заявка по номеру; дверь — право набора или журнала', () => {
  const db = seed();
  db.prepare("INSERT INTO patients (id, full_name, phone, mrn) VALUES (5, 'Каримова Азиза', '+998901112233', 'A-12')").run();
  const r = telephonyCaller(db, { number: '998901112233' }, OP);
  assert.equal(r.patient.id, 5);
  assert.equal(r.patient.mrn, 'A-12');
  assert.throws(() => telephonyCaller(db, { number: '998901112233' }, DOC), (e) => e.status === 403);
});

test('регистрация RPC и ворота лицензии', () => {
  assert.equal(typeof getRpc('telephony_webrtc_me'), 'function');
  assert.equal(typeof getRpc('telephony_caller'), 'function');
  assert.equal(isReadOnlyRpc('telephony_caller'), true);
  assert.equal(isReadOnlyRpc('telephony_webrtc_me'), false, 'при блокировке телефон закрыт, как экран «Телефония»');
});
```

If `getRpc` / `isReadOnlyRpc` have different export names, use the ones `phone.test.js` and `licence-gate.test.js` use.

- [ ] **Step 2: Run it and watch it fail**

Run `LIS_ENABLED=0 node --test server/services/rpc/phone-webrtc.test.js`. Expected: FAIL (`telephonyWebrtcMe` is not exported).

- [ ] **Step 3: Implement**

In `server/services/telephony/live.js`, after `function enrich(db, number) {…}`, add:

```js
/** SOFTPHONE_V1 — тот же «кто звонит», что у «Звонит»: пациент по номеру и открытая заявка. */
export const callerInfo = (db, number) => enrich(db, number);
```

In `server/services/rpc/phone.js`, add the imports and the two functions after `telephonyMyExtension`:

```js
import { callerInfo } from '../telephony/live.js';
import { isActing } from '../../../public/js/shared/act-as.js';

// SOFTPHONE_V1 — тексты отказов (ru — ключ словаря; uz/en — в i18n-strings.js).
const SP_NO_EXT = 'Сначала выберите свой внутренний номер в «Моя трубка» — телефон Easy-Med входит в АТС под ним.';
const SP_ACTING = 'Принимать звонки от чужого имени нельзя — вернитесь к своей учётной записи.';
const SP_NO_WEBRTC = 'АТС не дала этому внутреннему номеру вход из браузера — включите его в кабинете onlinePBX или выберите другой номер.';

/**
 * SOFTPHONE_V1 — вход телефона Easy-Med в АТС под СВОИМ внутренним номером.
 * Номер — из users.pbx_extension (не из запроса): чужой номер — чужие звонки.
 * Пароль не пишется ни в журнал, ни в базу: он только уходит владельцу номера.
 */
export async function telephonyWebrtcMe(db, _args, user, { pbxCallImpl = pbxCall } = {}) {
  if (isActing(user)) throw new RpcError(SP_ACTING, 403);
  if (!mayDial(db, user)) throw new RpcError(DENY_DIAL, 403);
  const me = db.prepare('SELECT pbx_extension FROM users WHERE id = ?').get(user.id) || {};
  const ext = String(me.pbx_extension || '').trim();
  if (!ext) throw new RpcError(SP_NO_EXT, 400);
  const line = (listProviders(db) || []).find((p) => p.enabled && p.kind === 'onlinepbx');
  if (!line) throw new RpcError('Линия onlinePBX не подключена («Настройки → Телефония»).', 400);
  const row = getProviderRow(db, line.id);
  // Поля — СТРОКОЙ через запятую: массивом onlinePBX webrtc не отдаёт (проверено 2026-10-28).
  const r = await pbxCallImpl(providerConfig(row).domain, 'user/get.json', { num: ext, fields: 'num,name,enabled,webrtc' }, pbxOptions(db, row));
  if (!r.ok) throw new RpcError('АТС не ответила: ' + String(r.comment || r.reason || 'ошибка'), 502);
  const u = (Array.isArray(r.data) ? r.data : []).find((x) => x && String(x.num) === ext);
  const w = u && u.webrtc;
  if (!w || !w.host || !w.user || !w.password) throw new RpcError(SP_NO_WEBRTC, 409);
  const host = String(w.host);
  return { extension: ext, user: String(w.user), password: String(w.password), ws_url: 'wss://' + host, sip_domain: host.replace(/:\d+$/, '') };
}

/** SOFTPHONE_V1 — кто звонит на мой телефон Easy-Med: пациент и заявка по номеру, как у «Звонит». */
export function telephonyCaller(db, args, user) {
  if (!mayDial(db, user) && !mayLog(db, user)) throw new RpcError(DENY_WORKPLACE, 403);
  const number = String((args && args.number) || '').replace(/[^\d+]/g, '');
  if (!number) return { patient: null, lead: null };
  return callerInfo(db, number);
}
```

In `server/services/rpc/index.js`:
- add `telephonyWebrtcMe, telephonyCaller` to the `./phone.js` import;
- under `telephony_call_log` add:

```js
  // SOFTPHONE_V1 — телефон Easy-Med: вход своего номера в АТС и «кто звонит».
  telephony_webrtc_me:       (db, args, user) => telephonyWebrtcMe(db, args, user),
  telephony_caller:          (db, args, user) => telephonyCaller(db, args, user),
```

In `server/services/control/gate.js`, add `'telephony_caller'` to `READ_ONLY_RPCS`, with comment `// SOFTPHONE_V1 — «кто звонит»: чтение`.

Add the three texts plus «Линия onlinePBX не подключена («Настройки → Телефония»).» to `i18n-strings.js` with uz/en (no Cyrillic in uz/en). The server-messages guard tells you the format.

- [ ] **Step 3b: Let the page reach the PBX — CSP.** `server/app.js` sends `connect-src 'self'` (V3120_FIX M6), and that blocks `new WebSocket('wss://pbx38631.onpbx.ru:8082')`. Widen it to the onlinePBX domain family only:

```js
    "connect-src 'self' wss://*.onpbx.ru:*",
```

Add one line to the M6 comment above the list: «• SOFTPHONE_V1 — плюс wss к onlinePBX (*.onpbx.ru): телефон Easy-Med входит в АТС из браузера; другие внешние адреса закрыты по-прежнему.»

Test it first, next to the existing CSP check in `server/routes/storage-v3120.test.js` (`assert.match(csp, /connect-src 'self'/)`):

```js
  // SOFTPHONE_V1 — телефон Easy-Med: только wss к onlinePBX, ни http, ни чужие домены.
  const connect = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src'));
  assert.equal(connect, "connect-src 'self' wss://*.onpbx.ru:*");
```

- [ ] **Step 4: Run tests and watch them pass**

```bash
LIS_ENABLED=0 node --test server/routes/storage-v3120.test.js server/services/rpc/phone-webrtc.test.js server/services/rpc/phone.test.js server/routes/licence-gate.test.js server/services/rpc/client-rpc-coverage.test.js
node --experimental-vm-modules --test public/js/admin/__tests__/server-messages-i18n.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs
```

Expected: all PASS.

- [ ] **Step 5: Commit**

Commit the files above with the message «Телефон в Easy-Med: вход своего номера в АТС (telephony_webrtc_me) и «кто звонит» (SOFTPHONE_V1)».

---

### Task 2b: Number for the phone — assigned by the administrator only (owner decision 2026-10-28)

The review of Task 2 found that any user with the dial right could pick another person's number in «Моя трубка» and then receive that number's SIP password. Owner: «Only admin assigns».

- Migration `259_softphone_assigned_extension.sql` adds `users.pbx_extension_assigned TEXT` (NULL by default, **no backfill**: existing numbers may have been self-picked).
- The employee card (`server/routes/users.js`, the `body.pbx_extension` branch, reached only by people allowed to edit employees) writes the same value to both `pbx_extension` and `pbx_extension_assigned`. Clearing the field clears both. «Моя трубка» (`telephony_my_extension`) still changes only `pbx_extension`.
- `telephony_webrtc_me` also requires `pbx_extension === pbx_extension_assigned`. Otherwise it returns 403 «Телефон Easy-Med включается только на внутреннем номере, который администратор назначил вам в карточке сотрудника.», and the PBX is not asked.
- `telephony_phone_me` adds `softphone_extension` (the assigned number, or ''), so the panel can explain why the switch is off.
- Employee card: a hint under the number field: «На этом номере сотрудник сможет принимать звонки прямо в Easy-Med».
- Tests:
  - the migration leaves existing numbers unassigned;
  - the card sets both columns, and clearing clears both;
  - a self-pick of another number makes the phone refuse, and the reviewer's steal scenario (set 107, ask for webrtc) is refused;
  - picking the assigned number again restores the phone;
  - a non-admin can't set `pbx_extension_assigned` through any users route.

### Task 3: The softphone state machine (DOM-free)

**Files:**
- Create: `public/js/admin/softphone.js`
- Test: `public/js/admin/__tests__/softphone.test.mjs`

- [ ] **Step 1: Write the failing test.** Fakes: `FakeUA` (records config; `start`/`stop`/`call`; emits events), `FakeSession` (`answer`/`terminate`/`mute`/`unmute`; emits `progress`/`accepted`/`confirmed`/`ended`/`failed`/`peerconnection`), plus fake `rpc`, `media`, `locks` and `storage`.

```js
// public/js/admin/__tests__/softphone.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSoftphone, SP } from '../softphone.js';

class Emitter { constructor() { this.h = {}; } on(n, f) { (this.h[n] ||= []).push(f); return this; } emit(n, e) { for (const f of this.h[n] || []) f(e); } }
class FakeSession extends Emitter {
  constructor(dir, number) { super(); this.direction = dir; this.remote_identity = { uri: { user: number } }; this.done = []; }
  answer(o) { this.done.push(['answer', o]); } terminate(o) { this.done.push(['terminate', o]); } mute(o) { this.done.push(['mute', o]); } unmute(o) { this.done.push(['unmute', o]); }
}
function makeJsSIP() {
  const made = [];
  class UA extends Emitter { constructor(cfg) { super(); this.cfg = cfg; this.started = false; made.push(this); } start() { this.started = true; } stop() { this.stopped = true; }
    call(target, o) { const s = new FakeSession('outgoing', target); s.target = target; s.opts = o; this.lastCall = s; return s; } }
  class WebSocketInterface { constructor(url) { this.url = url; } }
  return { JsSIP: { UA, WebSocketInterface }, made };
}
const CREDS = { extension: '108', user: '108', password: 'secret', ws_url: 'wss://pbx.example:8082', sip_domain: 'pbx.example' };
function deps(over = {}) {
  const { JsSIP, made } = makeJsSIP();
  const store = new Map();
  return {
    made,
    d: {
      JsSIP,
      rpc: async (name) => (name === 'telephony_webrtc_me' ? { data: CREDS, error: null } : { data: null, error: { message: 'x' } }),
      media: { isSecureContext: true, getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }), attachRemote: () => {} },
      locks: { request: async (_n, o, cb) => cb({ name: 'easymed-softphone' }) },
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
      now: () => 1000,
      ...over,
    },
    store,
  };
}

test('enable: проверка микрофона → вход своим номером → «готов»', async () => {
  const { d, made, store } = deps();
  const sp = createSoftphone(d);
  await sp.enable();
  assert.equal(made.length, 1);
  assert.equal(made[0].cfg.uri, 'sip:108@pbx.example');
  assert.equal(made[0].cfg.sockets[0].url, 'wss://pbx.example:8082');
  assert.equal(made[0].started, true);
  assert.equal(sp.get().state, SP.CONNECTING);
  made[0].emit('registered');
  assert.equal(sp.get().state, SP.READY);
  assert.equal(store.get('easymed.softphone.on'), '1');
});

test('незащищённый адрес — ошибка insecure, в АТС не входим', async () => {
  const { d, made } = deps({ media: { isSecureContext: false, getUserMedia: async () => { throw new Error('no'); } } });
  const sp = createSoftphone(d);
  await sp.enable();
  assert.deepEqual([sp.get().state, sp.get().reason], [SP.ERROR, 'insecure']);
  assert.equal(made.length, 0);
});

test('микрофон запрещён / не найден — свои причины', async () => {
  for (const [name, reason] of [['NotAllowedError', 'mic_denied'], ['NotFoundError', 'no_mic']]) {
    const err = Object.assign(new Error(name), { name });
    const { d } = deps({ media: { isSecureContext: true, getUserMedia: async () => { throw err; } } });
    const sp = createSoftphone(d);
    await sp.enable();
    assert.deepEqual([sp.get().state, sp.get().reason], [SP.ERROR, reason]);
  }
});

test('сервер отказал (нет номера) — ошибка server с его словами', async () => {
  const { d } = deps({ rpc: async () => ({ data: null, error: { message: 'Сначала выберите свой внутренний номер' } }) });
  const sp = createSoftphone(d);
  await sp.enable();
  assert.equal(sp.get().reason, 'server');
  assert.match(sp.get().message, /внутренний номер/);
});

test('другая вкладка держит телефон — other_tab', async () => {
  const { d } = deps({ locks: { request: async (_n, o, cb) => cb(null) } });
  const sp = createSoftphone(d);
  await sp.enable();
  assert.equal(sp.get().state, SP.OTHER_TAB);
});

test('входящий: звонит → принять → разговор → завершить → готов', async () => {
  const { d, made } = deps();
  const sp = createSoftphone(d);
  await sp.enable(); made[0].emit('registered');
  const s = new FakeSession('incoming', '998901112233');
  made[0].emit('newRTCSession', { originator: 'remote', session: s });
  assert.equal(sp.get().state, SP.RINGING);
  assert.equal(sp.get().call.number, '998901112233');
  sp.answer();
  assert.equal(s.done[0][0], 'answer');
  s.emit('confirmed');
  assert.equal(sp.get().state, SP.IN_CALL);
  assert.equal(sp.get().call.startedAt, 1000);
  sp.hangup();
  assert.equal(s.done.at(-1)[0], 'terminate');
  s.emit('ended');
  assert.equal(sp.get().state, SP.READY);
  assert.equal(sp.get().call, null);
});

test('входящий: отклонить — 603; второй входящий во время разговора — 486 «занято»', async () => {
  const { d, made } = deps();
  const sp = createSoftphone(d);
  await sp.enable(); made[0].emit('registered');
  const a = new FakeSession('incoming', '111111111');
  made[0].emit('newRTCSession', { originator: 'remote', session: a });
  const b = new FakeSession('incoming', '222222222');
  made[0].emit('newRTCSession', { originator: 'remote', session: b });
  assert.deepEqual(b.done[0], ['terminate', { status_code: 486, reason_phrase: 'Busy Here' }]);
  sp.decline();
  assert.deepEqual(a.done[0], ['terminate', { status_code: 603, reason_phrase: 'Decline' }]);
});

test('исходящий: номер → sip:цифры@домен, звонок → разговор; микрофон выкл./вкл.', async () => {
  const { d, made } = deps();
  const sp = createSoftphone(d);
  await sp.enable(); made[0].emit('registered');
  sp.call('+998 90 111-22-33');
  const s = made[0].lastCall;
  assert.equal(s.target, 'sip:998901112233@pbx.example');
  assert.equal(sp.get().state, SP.CALLING);
  made[0].emit('newRTCSession', { originator: 'local', session: s });
  s.emit('confirmed');
  assert.equal(sp.get().state, SP.IN_CALL);
  sp.setMuted(true);
  assert.deepEqual(s.done.at(-1), ['mute', { audio: true }]);
  assert.equal(sp.get().call.muted, true);
  sp.setMuted(false);
  assert.deepEqual(s.done.at(-1), ['unmute', { audio: true }]);
});

test('потеря связи — «переподключаемся», вход не удался — register_failed', async () => {
  const { d, made } = deps();
  const sp = createSoftphone(d);
  await sp.enable(); made[0].emit('registered');
  made[0].emit('disconnected');
  assert.deepEqual([sp.get().state, sp.get().reason], [SP.CONNECTING, 'network']);
  made[0].emit('registrationFailed', { cause: 'Authentication Error' });
  assert.deepEqual([sp.get().state, sp.get().reason], [SP.ERROR, 'register_failed']);
});

test('disable — UA остановлен, флаг снят, состояние off', async () => {
  const { d, made, store } = deps();
  const sp = createSoftphone(d);
  await sp.enable(); made[0].emit('registered');
  sp.disable();
  assert.equal(made[0].stopped, true);
  assert.equal(store.has('easymed.softphone.on'), false);
  assert.equal(sp.get().state, SP.OFF);
});

test('подписчики слышат каждую смену; пароль в состоянии не хранится', async () => {
  const { d, made } = deps();
  const sp = createSoftphone(d);
  const seen = [];
  sp.subscribe((s) => seen.push(s.state));
  await sp.enable(); made[0].emit('registered');
  assert.deepEqual(seen.slice(-2), [SP.CONNECTING, SP.READY]);
  assert.equal(JSON.stringify(sp.get()).includes('secret'), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run `node --experimental-vm-modules --test public/js/admin/__tests__/softphone.test.mjs`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `public/js/admin/softphone.js`**

```js
// SOFTPHONE_V1 (2026-10-29) — ТЕЛЕФОН EASY-MED: ВНУТРЕННИЙ НОМЕР ОПЕРАТОРА ВХОДИТ В АТС ИЗ БРАУЗЕРА.
//
// Владелец: «can we build a softphone in the easymed inside?» (спецификация
// docs/specs/2026-10-29-softphone-design.md). Здесь — только состояние и JsSIP;
// браузер (микрофон, замок вкладки, звук, хранилище, RPC) приходит снаружи
// (softphone-browser.js), поэтому модуль проверяется без DOM.
//
// Пароль АТС живёт только внутри JsSIP UA этой вкладки: в состояние, журнал и
// хранилище не попадает.
export const SP = Object.freeze({
  OFF: 'off', CONNECTING: 'connecting', READY: 'ready', RINGING: 'ringing',
  CALLING: 'calling', IN_CALL: 'in_call', ERROR: 'error', OTHER_TAB: 'other_tab',
});
export const SP_FLAG = 'easymed.softphone.on';
const LOCK = 'easymed-softphone';

export function createSoftphone({ JsSIP, rpc, media, locks, storage, now = () => Date.now() }) {
  let st = { state: SP.OFF, reason: '', message: '', call: null };
  let ua = null; let domain = ''; let session = null; let releaseLock = null;
  const subs = new Set();
  const set = (patch) => { st = { ...st, ...patch }; for (const f of subs) { try { f(st); } catch { /* подписчик не роняет телефон */ } } };
  const fail = (reason, message = '') => set({ state: SP.ERROR, reason, message, call: null });
  const audio = () => ({ audio: true, video: false });

  async function micOk() {
    if (!media || !media.isSecureContext) { fail('insecure'); return false; }
    try {
      const s = await media.getUserMedia(audio());
      for (const t of s.getTracks()) t.stop();
      return true;
    } catch (e) {
      fail(e && e.name === 'NotFoundError' ? 'no_mic' : e && e.name === 'NotAllowedError' ? 'mic_denied' : 'mic_error', String((e && e.message) || ''));
      return false;
    }
  }

  function wire(s, direction, number) {
    session = s;
    set({ state: direction === 'in' ? SP.RINGING : SP.CALLING, reason: '', call: { direction, number, startedAt: null, muted: false } });
    s.on('accepted', () => set({ state: SP.IN_CALL, call: { ...st.call, startedAt: st.call.startedAt ?? now() } }));
    s.on('confirmed', () => set({ state: SP.IN_CALL, call: { ...st.call, startedAt: st.call.startedAt ?? now() } }));
    const done = () => { if (session === s) { session = null; set({ state: ua ? SP.READY : SP.OFF, call: null }); } };
    s.on('ended', done);
    s.on('failed', done);
    s.on('peerconnection', (e) => {
      const pc = e && e.peerconnection;
      if (pc && media.attachRemote) pc.addEventListener?.('track', (ev) => media.attachRemote(ev.streams && ev.streams[0]));
    });
  }

  function onSession(e) {
    const s = e.session;
    if (e.originator === 'remote') {
      if (session) { s.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); return; }
      wire(s, 'in', String((s.remote_identity && s.remote_identity.uri && s.remote_identity.uri.user) || ''));
    } else if (session !== s) {
      wire(s, 'out', st.call ? st.call.number : '');
    }
  }

  async function enable() {
    storage.setItem(SP_FLAG, '1');
    if (ua) return;
    // Одна вкладка — один телефон: замок держится, пока вкладка жива.
    const got = await new Promise((resolve) => {
      locks.request(LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise((r) => { releaseLock = r; });
      });
    });
    if (!got) { set({ state: SP.OTHER_TAB, reason: 'other_tab', call: null }); return; }
    if (!(await micOk())) { releaseLock && releaseLock(); releaseLock = null; return; }
    const { data, error } = await rpc('telephony_webrtc_me', {});
    if (error || !data) { releaseLock && releaseLock(); releaseLock = null; fail('server', String((error && error.message) || '')); return; }
    domain = data.sip_domain;
    set({ state: SP.CONNECTING, reason: '', message: '' });
    ua = new JsSIP.UA({
      sockets: [new JsSIP.WebSocketInterface(data.ws_url)],
      uri: 'sip:' + data.user + '@' + data.sip_domain,
      password: data.password,
      register: true,
      session_timers: false,
    });
    ua.on('registered', () => set({ state: session ? st.state : SP.READY, reason: '' }));
    ua.on('unregistered', () => { if (!session && ua) set({ state: SP.CONNECTING, reason: 'network' }); });
    ua.on('disconnected', () => { if (!session) set({ state: SP.CONNECTING, reason: 'network' }); });
    ua.on('registrationFailed', (e) => fail('register_failed', String((e && e.cause) || '')));
    ua.on('newRTCSession', onSession);
    ua.start();
  }

  function disable() {
    storage.removeItem(SP_FLAG);
    if (session) { try { session.terminate(); } catch { /* уже завершён */ } session = null; }
    if (ua) { try { ua.stop(); } catch { /* уже остановлен */ } ua = null; }
    if (releaseLock) { releaseLock(); releaseLock = null; }
    set({ state: SP.OFF, reason: '', message: '', call: null });
  }

  function call(number) {
    const digits = String(number || '').replace(/\D/g, '');
    if (!ua || st.state !== SP.READY || !digits) return false;
    set({ state: SP.CALLING, call: { direction: 'out', number: digits, startedAt: null, muted: false } });
    const s = ua.call('sip:' + digits + '@' + domain, { mediaConstraints: audio() });
    if (s && session !== s) wire(s, 'out', digits);
    return true;
  }
  const answer = () => { if (session && st.state === SP.RINGING) session.answer({ mediaConstraints: audio() }); };
  const decline = () => { if (session && st.state === SP.RINGING) session.terminate({ status_code: 603, reason_phrase: 'Decline' }); };
  const hangup = () => { if (session) session.terminate(); };
  function setMuted(on) {
    if (!session || !st.call) return;
    if (on) session.mute({ audio: true }); else session.unmute({ audio: true });
    set({ call: { ...st.call, muted: !!on } });
  }

  return {
    get: () => st,
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    wanted: () => storage.getItem(SP_FLAG) === '1',
    enable, disable, call, answer, decline, hangup, setMuted,
    busy: () => [SP.RINGING, SP.CALLING, SP.IN_CALL].includes(st.state),
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run `node --experimental-vm-modules --test public/js/admin/__tests__/softphone.test.mjs`. Expected: 11 pass. If the outgoing test fails because the fake emits no `newRTCSession` before `confirmed`, keep the `wire()` call in `call()`: JsSIP emits `newRTCSession` synchronously inside `ua.call`, and the guard `session !== s` prevents double wiring.

- [ ] **Step 5: Commit**

`git add public/js/admin/softphone.js public/js/admin/__tests__/softphone.test.mjs`, then commit with the message «Телефон в Easy-Med: состояние телефона поверх JsSIP — вход, входящий, исходящий, занято, микрофон выкл. (SOFTPHONE_V1)».

---

### Task 4: Browser wiring and singleton

**Files:**
- Create: `public/js/admin/softphone-browser.js`
- Test: `public/js/admin/__tests__/softphone-browser.test.mjs`

- [ ] **Step 1: Write the failing test.** It checks that `getSoftphone()` returns one instance, that `setSoftphoneForTests(fake)` replaces it, and that `reasonText(reason, message)` returns the right Russian texts.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
const B = await import('../softphone-browser.js');

test('одна вкладка — один экземпляр; подмена для стендов', () => {
  const fake = { get: () => ({ state: 'off' }) };
  B.setSoftphoneForTests(fake);
  assert.equal(B.getSoftphone(), fake);
  assert.equal(B.getSoftphone(), fake);
  B.setSoftphoneForTests(null);
});

test('причины словами', () => {
  assert.match(B.reasonText('insecure'), /Настроить компьютер/);
  assert.match(B.reasonText('mic_denied'), /разрешите/i);
  assert.match(B.reasonText('no_mic'), /гарнитур/);
  assert.match(B.reasonText('other_tab'), /другой вкладке/);
  assert.match(B.reasonText('register_failed'), /АТС не приняла/);
  assert.match(B.reasonText('network'), /переподключ/i);
  assert.equal(B.reasonText('server', 'Слова сервера'), 'Слова сервера');
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement**

```js
// SOFTPHONE_V1 — браузер для телефона Easy-Med: JsSIP из vendor, микрофон, замок вкладки,
// звук собеседника в скрытом <audio>, флаг в localStorage, RPC через supabase.
import { supabase } from '../supabase.js';
import { tr } from './i18n.js';
import { createSoftphone } from './softphone.js';

let instance = null;
let override = null;
let remoteEl = null;
let sinkId = '';

export function setSoftphoneForTests(fake) { override = fake; }

function remoteAudio() {
  if (remoteEl) return remoteEl;
  remoteEl = document.createElement('audio');
  remoteEl.autoplay = true;
  remoteEl.setAttribute('data-softphone-remote', '');
  remoteEl.style.display = 'none';
  document.body.appendChild(remoteEl);
  return remoteEl;
}

export async function setOutputDevice(id) {
  sinkId = id || '';
  const el = remoteAudio();
  if (typeof el.setSinkId === 'function') { try { await el.setSinkId(sinkId); } catch { /* устройство пропало — остаётся по умолчанию */ } }
}

export function getSoftphone() {
  if (override) return override;
  if (instance) return instance;
  const lazy = {};
  instance = createSoftphone({
    get JsSIP() { return lazy.JsSIP; },
    rpc: (name, args) => supabase.rpc(name, args),
    media: {
      get isSecureContext() { return !!window.isSecureContext; },
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      attachRemote: (stream) => { const el = remoteAudio(); el.srcObject = stream || null; el.play?.().catch(() => {}); },
    },
    locks: navigator.locks || { request: async (_n, _o, cb) => cb({ name: 'no-locks' }) },
    storage: { getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
               setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
               removeItem: (k) => { try { localStorage.removeItem(k); } catch { /* приватный режим */ } } },
  });
  const enable = instance.enable;
  instance.enable = async () => {
    if (!lazy.JsSIP) { const m = await import('../vendor/jssip-3.13.9.mjs'); lazy.JsSIP = m.default || m; }
    return enable();
  };
  return instance;
}

const REASONS = {
  insecure: 'Микрофон на этом компьютере закрыт браузером: один раз запустите «Настроить компьютер» (EasyMed-ustanovka.cmd) от имени администратора и перезапустите браузер.',
  mic_denied: 'Браузер не дал микрофон: разрешите его значком замка слева от адреса и включите телефон снова.',
  no_mic: 'Микрофон не найден: подключите гарнитуру и включите телефон снова.',
  mic_error: 'Микрофон не открылся. Проверьте гарнитуру и включите телефон снова.',
  other_tab: 'Телефон работает в другой вкладке Easy-Med.',
  register_failed: 'АТС не приняла вход вашего внутреннего номера. Проверьте номер в «Моя трубка» или попробуйте позже.',
  network: 'Нет связи с АТС — переподключаемся…',
};
export function reasonText(reason, message = '') {
  if (reason === 'server') return message || tr('Телефония ответила ошибкой. Попробуйте ещё раз через минуту.');
  return REASONS[reason] ? tr(REASONS[reason]) : '';
}
```

Add every `REASONS` text to `i18n-strings.js` (ru/uz/en).

`media.devices()` and `enumerateDevices` come in Task 7. Keep `JsSIP` lazy, so the 300 KB bundle loads only when the phone is switched on.

- [ ] **Step 4: Run it and the i18n guards; all PASS.**

- [ ] **Step 5: Commit** with the message «Телефон в Easy-Med: браузер для телефона — JsSIP по требованию, микрофон, замок вкладки, звук собеседника (SOFTPHONE_V1)».

---

### Task 5: Panel — the switch and the status

**Files:**
- Modify: `public/js/admin/views/crm-phone.js`
- Modify: `public/css/admin-views.css`
- Test: `public/js/admin/__tests__/crm-phone-softphone.test.mjs` (uses `crm-harness.mjs`, as `crm-phone.test.mjs` does)

- [ ] **Step 1: Write the failing test.** A fake softphone holds an observable state `{state, reason, message, call}` and records method calls. Install it with `setSoftphoneForTests(fake)` before `mountPhoneButton`, then cover these cases:
  - **Switch present.** An operator with `may_dial: true, extension: '108'` gets a switch row (`[data-cph-sp-toggle]`) with the label «Принимать звонки в Easy-Med», unchecked.
  - **Switch on.** Clicking it calls `fake.enable()`. When the fake state becomes `ready`, the status reads «Телефон Easy-Med включён».
  - **Error with text.** If the fake moves to `error` with reason `insecure`, `[data-cph-sp-reason]` shows the «Настроить компьютер» text.
  - **No dial right.** With `may_dial: false` there is no switch row.
  - **No extension.** With `extension: ''` the switch is disabled, and `title` gives the «Сначала выберите свой внутренний номер» hint.
  - **Acting as someone.** With `window.easymed.state.user.acting_admin` set, the switch is disabled with the «от чужого имени» hint.
  - **Auto-enable.** `fake.wanted()` returning `true` at mount makes `loadMe()` call `fake.enable()` once.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement in `crm-phone.js`**
  - `import { getSoftphone, reasonText } from '../softphone-browser.js';`, plus `SP` from `'../softphone.js'`.
  - In `P` add `sp: null, spUnsub: null, spTick: null`.
  - In `mount()`, after `P.els` is built:

    ```js
    P.sp = getSoftphone();
    P.spUnsub = P.sp.subscribe(() => { onSoftChange(); });
    ```

    In `teardown()`, call `P.spUnsub && P.spUnsub()`. Do NOT stop the phone on teardown: it lives as long as the page.
  - In `loadMe()`, after flags are set:

    ```js
    if (P.sp && P.mayDial && P.me.extension && !isActingUser() && P.sp.wanted() && P.sp.get().state === SP.OFF) P.sp.enable().catch(() => {});
    ```

    with `const isActingUser = () => !!(window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.acting_admin);`.
  - New `paintSoftRow()`, called from `paintStatus()`:

    ```js
    function paintSoftRow() {
        if (!P.els || !P.els.spRow) return;
        clear(P.els.spRow);
        if (!P.mayDial) { P.els.spRow.style.display = 'none'; return; }
        P.els.spRow.style.display = '';
        const s = P.sp ? P.sp.get() : { state: 'off' };
        const on = s.state !== SP.OFF;
        const noExt = !(P.me && P.me.extension);
        const acting = isActingUser();
        const sw = h('input', { type: 'checkbox', 'data-cph-sp-toggle': '', checked: on, disabled: noExt || acting,
            title: acting ? tr('Принимать звонки от чужого имени нельзя — вернитесь к своей учётной записи.')
                 : noExt ? tr('Сначала выберите свой внутренний номер в «Моя трубка» — телефон Easy-Med входит в АТС под ним.') : '',
            onchange: (ev) => { if (ev.target.checked) P.sp.enable().catch(() => {}); else P.sp.disable(); } });
        const label = h('label', { class: 'cph-sp-sw' }, sw, h('span', null, tr('Принимать звонки в Easy-Med')));
        const word = { ready: 'Телефон Easy-Med включён', connecting: 'Подключение к АТС…', other_tab: 'Телефон работает в другой вкладке',
            ringing: 'Входящий звонок', calling: 'Вызов…', in_call: 'Разговор', error: 'Телефон не включился' }[s.state];
        put(P.els.spRow, label,
            word ? h('span', { class: 'cph-sp-st ' + s.state, 'data-cph-sp-state': s.state }, tr(word)) : null,
            s.reason ? h('div', { class: 'cph-sp-reason', 'data-cph-sp-reason': s.reason }, reasonText(s.reason, s.message)) : null);
    }
    function onSoftChange() { paintSoftRow(); paintPhone(); paintChrome(); }
    ```

  - Create `P.els.spRow = h('div', { class: 'cph-sp-row', 'data-cph-sp-row': '' })` in `mount()`, directly under the status line, and keep it in `P.els`.
  - CSS (`admin-views.css`, next to `.cph-*`): `.cph-sp-row`, `.cph-sp-sw` (switch look like existing toggles), `.cph-sp-st.ready` (ok colour), `.cph-sp-st.error` (crit colour), `.cph-sp-reason` (crit background box). Use type-scale sizes only.
  - Add all new texts to `i18n-strings.js` (ru/uz/en).

- [ ] **Step 4: Run tests.**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/crm-phone-softphone.test.mjs public/js/admin/__tests__/crm-phone.test.mjs public/js/admin/__tests__/type-scale.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs
```

Run them in ru and en. Expected: PASS. The existing `crm-phone.test.mjs` must stay green: the harness has no softphone, so `getSoftphone()` must survive a missing `navigator`. Guard with `typeof navigator === 'undefined'` and return an inert object whose `get()` gives `{state:'off'}` and whose `wanted()` gives `false`.

- [ ] **Step 5: Commit** with the message «Телефон в Easy-Med: переключатель «Принимать звонки в Easy-Med» и состояние в панели (SOFTPHONE_V1)».

---

### Task 6: Panel — incoming call, in-call controls, outgoing through the softphone

**Files:** Modify `public/js/admin/views/crm-phone.js`, `public/css/admin-views.css`. Test: extend `crm-phone-softphone.test.mjs`.

- [ ] **Step 1: Write the failing tests:**
  - **Incoming opens the panel.** The fake goes to `ringing` with call `{direction:'in', number:'998901112233'}`; the panel opens by itself (`P.open`).
  - **Incoming shows the caller.** `[data-cph-sp-card="ringing"]` shows the name from `telephony_caller` (the harness RPC stub returns `{patient:{id:5, full_name:'Каримова Азиза', mrn:'A-12'}}`).
  - **Incoming buttons.** `[data-cph-sp-answer]` calls `fake.answer()`, `[data-cph-sp-decline]` calls `fake.decline()`, and `[data-cph-sp-patient]` navigates to the patient card.
  - **In call.** Fake state `in_call` with `startedAt` shows `[data-cph-sp-timer]` reading `00:00`.
    - Advance the harness clock 65 s and repaint: it shows `01:05`.
    - `[data-cph-sp-mute]` toggles `fake.setMuted(true)` and its label changes to «Микрофон вкл.».
    - `[data-cph-sp-hangup]` calls `fake.hangup()`.
  - **Outgoing via softphone.** With the fake `ready`, `dial('998901112233')` calls `fake.call('998901112233')` and NOT `telephony_dial`. The hint under the keypad reads «Звонок пойдёт через гарнитуру этого компьютера».
  - **Fallback.** With the fake `off`, `dial()` still uses `telephony_dial` (old behaviour).
  - **Priority.** The softphone call screen wins over the «Звонит» ring screen: with both present, `[data-cph-sp-card]` is drawn.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement**
  - In `paintPhone()`, first branch: `const sp = P.sp && P.sp.get(); if (sp && sp.call && [SP.RINGING, SP.CALLING, SP.IN_CALL].includes(sp.state)) { paintSoftCall(sp); paintStatus(); return; }`
  - `paintSoftCall(s)`:

    ```js
    function paintSoftCall(s) {
        const c = s.call;
        const digits = digitsOf(c.number);
        const who = P.spWho && P.spWho.number === digits ? P.spWho : null;
        const name = (who && who.patient && who.patient.full_name) || (who && who.lead && who.lead.full_name) || '';
        const head = [
            h('div', { class: 'cph-ava' + (s.state === SP.RINGING ? ' ring' : '') }, name ? initialsOf(name) : '#'),
            h('h2', { class: 'cph-inc-name' }, name || formatPhone(digits)),
            h('div', { class: 'cph-pn' }, name ? formatPhone(digits) : (c.direction === 'in' ? tr('Входящий') : tr('Исходящий'))),
        ];
        const acts = [];
        if (who && who.patient && P.ctx && typeof P.ctx.onNavigate === 'function' && isRouteAllowed('patient-card')) {
            acts.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-sp-patient': '',
                onclick: () => P.ctx.onNavigate('patient-card', { id: who.patient.id, full_name: who.patient.full_name || '' }) }, Icon('User', { size: 13 }), tr('Открыть карту')));
        }
        if (s.state === SP.RINGING) {
            put(P.els.body, h('div', { class: 'cph-inc cph-sp', 'data-cph-sp-card': 'ringing' }, ...head,
                h('div', { class: 'cph-sp-btns' },
                    h('button', { class: 'cph-sp-ans', type: 'button', 'data-cph-sp-answer': '', onclick: () => P.sp.answer() }, Icon('Phone', { size: 22 }), tr('Принять')),
                    h('button', { class: 'cph-sp-dec', type: 'button', 'data-cph-sp-decline': '', onclick: () => P.sp.decline() }, Icon('PhoneOff', { size: 22 }), tr('Отклонить'))),
                acts.length ? h('div', { class: 'cph-sum' }, ...acts) : null));
            return;
        }
        const t = c.startedAt ? Math.max(0, Math.floor((Date.now() - c.startedAt) / 1000)) : 0;
        const mm = String(Math.floor(t / 60)).padStart(2, '0'); const ss = String(t % 60).padStart(2, '0');
        put(P.els.body, h('div', { class: 'cph-inc cph-sp', 'data-cph-sp-card': s.state }, ...head,
            h('div', { class: 'cph-tm', 'data-cph-sp-timer': '' }, s.state === SP.CALLING ? tr('Вызов…') : mm + ':' + ss),
            h('div', { class: 'cph-sp-btns' },
                h('button', { class: 'cph-sp-mute' + (c.muted ? ' on' : ''), type: 'button', 'data-cph-sp-mute': '', 'aria-pressed': c.muted ? 'true' : 'false',
                    onclick: () => P.sp.setMuted(!c.muted) }, Icon(c.muted ? 'MicOff' : 'Mic', { size: 18 }), tr(c.muted ? 'Микрофон вкл.' : 'Микрофон выкл.')),
                h('button', { class: 'cph-sp-dec', type: 'button', 'data-cph-sp-hangup': '', onclick: () => P.sp.hangup() }, Icon('PhoneOff', { size: 22 }), tr('Завершить'))),
            acts.length ? h('div', { class: 'cph-sum' }, ...acts) : null));
    }
    ```

    If `Icon` lacks `PhoneOff`, `Mic` or `MicOff`, add them to the icon set (lucide paths, same format as the existing icons) and include that file in the commit.
  - Extend `onSoftChange()`:

    ```js
    function onSoftChange() {
        const s = P.sp.get();
        if (s.call && s.call.direction === 'in' && s.state === SP.RINGING) {
            if (!P.open) openDrawer();
            lookupCaller(digitsOf(s.call.number));
            startSoftRing();
        } else stopSoftRing();
        if (s.state === SP.IN_CALL && !P.spTick) P.spTick = setInterval(() => paintPhone(), 1000);
        if (s.state !== SP.IN_CALL && P.spTick) { clearInterval(P.spTick); P.spTick = null; }
        if (s.state === SP.READY && s.call === null) setTimeout(() => { loadCalls().catch(() => {}); }, 4000);
        paintSoftRow(); paintPhone(); paintChrome();
    }
    async function lookupCaller(number) {
        if (P.spWho && P.spWho.number === number) return;
        P.spWho = { number, patient: null, lead: null };
        const { data } = await supabase.rpc('telephony_caller', { number });
        if (data && P.spWho && P.spWho.number === number) { P.spWho = { number, ...data }; paintPhone(); }
    }
    ```

  - Ringtone: `startSoftRing()` / `stopSoftRing()` reuse `ringTone` / `audioContextOf` from `crm-ring-logic.js`, the same as `onLiveChanged`. Repeat every 2 s while ringing; respect `P.muted` (the existing sound switch).
  - `dial(number)`: at the top, after validation:

    ```js
    const sps = P.sp && P.sp.get();
    if (sps && sps.state === SP.READY) { P.typed = ''; P.sp.call(phone); paintPhone(); return; }
    ```

  - Hint in `paintIdle()`: when the softphone state is `ready` and `canDial(P.typed)`, the hint reads «Звонок пойдёт через гарнитуру этого компьютера».
  - CSS: `.cph-sp-btns`; `.cph-sp-ans` (round, ok colour); `.cph-sp-dec` (round, crit colour); `.cph-sp-mute.on`. Type-scale sizes; no new colours outside the tokens.
  - i18n: every new text in ru/uz/en.

- [ ] **Step 4: Run tests** (the Task 5 command, plus `crm-ring*.test.mjs`) in ru and en: PASS.

- [ ] **Step 5: Commit** with the message «Телефон в Easy-Med: входящий (принять/отклонить), разговор (таймер, микрофон выкл., завершить), исходящий через гарнитуру (SOFTPHONE_V1)».

---

### Task 7: Headset — choose microphone and speaker, and a 5-second test

**Files:** Modify `public/js/admin/softphone-browser.js`, `public/js/admin/views/crm-phone.js`, `public/css/admin-views.css`. Test: extend `crm-phone-softphone.test.mjs` and `softphone-browser.test.mjs`.

- [ ] **Step 1: Failing tests**
  - **Device list.** `listDevices()` with a fake `navigator.mediaDevices.enumerateDevices` (2 `audioinput`, 2 `audiooutput`) returns `{inputs:[{id,label}], outputs:[…]}`. Missing labels become «Микрофон 1» / «Динамик 1».
  - **Headset section.** The picker screen («Моя трубка») shows `[data-cph-sp-devices]` with two selects when the phone switch is on.
  - **Saving the choice.** Choosing an output calls `setOutputDevice(id)` and stores `easymed.softphone.out`. Choosing an input stores `easymed.softphone.in`, which the softphone reads for the next call's `mediaConstraints`.
  - **Test button.** «Проверить» (`[data-cph-sp-test]`) calls `micTest()` with 5000 ms and shows «Говорите… 5 с», then «Слушайте запись».

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement**
  - `softphone-browser.js`:

    ```js
    export async function listDevices() {
        const all = await navigator.mediaDevices.enumerateDevices();
        const pick = (kind, word) => all.filter((d) => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: d.label || tr(word) + ' ' + (i + 1) }));
        return { inputs: pick('audioinput', 'Микрофон'), outputs: pick('audiooutput', 'Динамик') };
    }
    export function savedDevice(kind) { try { return localStorage.getItem('easymed.softphone.' + kind) || ''; } catch { return ''; } }
    export function saveDevice(kind, id) { try { localStorage.setItem('easymed.softphone.' + kind, id || ''); } catch { /* приватный режим */ } }
    export async function micTest(ms = 5000) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: savedDevice('in') ? { deviceId: { exact: savedDevice('in') } } : true });
        const rec = new MediaRecorder(stream); const parts = [];
        rec.ondataavailable = (e) => parts.push(e.data);
        const done = new Promise((r) => { rec.onstop = r; });
        rec.start(); await new Promise((r) => setTimeout(r, ms)); rec.stop(); await done;
        for (const t of stream.getTracks()) t.stop();
        const el = new Audio(URL.createObjectURL(new Blob(parts)));
        if (savedDevice('out') && el.setSinkId) await el.setSinkId(savedDevice('out')).catch(() => {});
        await el.play();
    }
    ```

  - `softphone.js`: `audio()` uses an injected `inputId()`:

    ```js
    const audio = () => ({ audio: inputId && inputId() ? { deviceId: { exact: inputId() } } : true, video: false });
    ```

    In `softphone-browser.js`, pass `inputId: () => savedDevice('in')`. Apply the saved output once at enable: `setOutputDevice(savedDevice('out'))`.
  - `crm-phone.js`: in `paintPicker()`, below the extension select, when `P.sp.get().state !== SP.OFF`:
    - title «Гарнитура»;
    - two selects filled from `listDevices()`, which runs after permission, so labels are present;
    - the «Проверить» button with a status line.

    Selection handlers call `saveDevice` / `setOutputDevice`.
  - i18n for every new text.

- [ ] **Step 4: Run tests** in ru and en: PASS.

- [ ] **Step 5: Commit** with the message «Телефон в Easy-Med: выбор микрофона и динамика, проверка гарнитуры за 5 секунд (SOFTPHONE_V1)».

---

### Task 8: Guards — closing during a call, act-as, logout

**Files:** Modify `public/js/admin/views/crm-phone.js` (or `softphone-browser.js`), `public/js/admin.js` (logout path). Test: extend `crm-phone-softphone.test.mjs`.

- [ ] **Step 1: Failing tests**
  - **Closing guard.** With the fake in `in_call` (and in `ringing`), a dispatched `beforeunload` event gets `preventDefault()` called and `returnValue` set. In `ready` it doesn't.
  - **Act-as.** When act-as starts while the phone is on (the shell sets `acting_admin`), `fake.disable()` is called before the reload. The act-as start path reloads the page anyway; assert that `enable()` is not called after a reload with `acting_admin` set (Task 5 already disables the switch).
  - **Logout.** `signOutAndReload` stops the phone (`fake.disable()`) before reloading, so the extension unregisters cleanly.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement**
  - In `softphone-browser.js`, register once on the first `getSoftphone()`:

    ```js
    window.addEventListener('beforeunload', (e) => {
        if (instance && instance.busy()) { e.preventDefault(); e.returnValue = ''; }
    });
    ```

  - In `admin/auth.js` `signOutAndReload` (or wherever logout reloads), before the reload:

    ```js
    try { const m = await import('./softphone-browser.js'); const sp = m.peekSoftphone && m.peekSoftphone(); if (sp) sp.disable(); } catch { /* без телефона — нечего останавливать */ }
    ```

    with `export const peekSoftphone = () => override || instance;` in `softphone-browser.js`. Use the same call in `act-as-client.js` `startActAs` before its reload.
  - Do not keep the flag when stopping for logout or act-as. `disable()` clears it, so the operator turns it on again after the next login; the switch is a conscious choice per session.

- [ ] **Step 4: Run tests** plus `act-as-*.test.mjs` and `app-shell.test.mjs`, in ru and en: PASS.

- [ ] **Step 5: Commit** with the message «Телефон в Easy-Med: вопрос при закрытии во время разговора, выключение при выходе и входе от имени (SOFTPHONE_V1)».

---

### Task 9: Real-browser check with a fake SIP server

**Files:** Create `scripts/softphone-e2e/` (NOT shipped; add it to the not-shipped list if the guard requires it): `fake-sip.mjs`, `run.mjs`.

- [ ] **Step 1: Build a tiny fake SIP-over-WebSocket server** (`ws` package if present in `node_modules`; otherwise a raw `node:http` upgrade with a minimal frame parser). It must:
  - answer `REGISTER` with `200 OK` (no auth);
  - send an `INVITE` to the registered contact on command, with an SDP offer from a second headless Chrome page acting as the «patient» (use JsSIP in that page too, registered as `998901112233`).
- [ ] **Step 2: Drive two headless Chrome pages with Playwright** (global install `C:\Users\user\AppData\Roaming\npm\node_modules\playwright`):
  1. Page A is the Easy-Med panel, served by an isolated `createApp` on 127.0.0.1:8124 with a copy of a test DB and `telephony_webrtc_me` stubbed to point at the fake server. Launch it with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`.
  2. Page B is the «patient» caller.
  3. Assert on page A: the switch goes on → state `ready` → page B calls → the card «Входящий» shows → «Принять» → timer runs → «Микрофон выкл.» → «Завершить» → `ready`.
  4. Then assert an outgoing call from A to B.

  Take a screenshot at each step into the scratchpad.
- [ ] **Step 3: Record the results.** Write them to `scripts/softphone-e2e/RESULTS.md`, with scratchpad paths only and no data. Fix any real defect found, with a unit test first.
- [ ] **Step 4: Commit** with the message «Телефон в Easy-Med: проверка в настоящем браузере на подставном SIP-сервере (SOFTPHONE_V1)».

---

### Task 10: Full suite, dev server, live test with the owner

- [ ] **Step 1: Full suite.**
  - Run `npm test` (ru). Then run the force-en run:

    ```bash
    node --experimental-vm-modules --import "file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs" --test
    ```

  - Use the scratchpad `suite-rc3180.sh` (REPO `easymed.api5`); its disk guard stops tests under 150 MB.
  - Expected: 0 failures in both runs.
- [ ] **Step 2: Update the dev server.**
  1. Back up `easymed.local/data/easymed.db*` into `data/backup-before-restart-<stamp>`.
  2. Fast-forward `easymed.local` to the branch head (fetch from `easymed.api5`, `git merge --ff-only`).
  3. Restart `node server/index.js` hidden, logging to the scratchpad.
  4. Check `/api/health` returns 200.
  5. Check no migration ran (none is expected).
- [ ] **Step 3: Live test with the owner on number 108.** The owner runs «Настроить компьютер» on their PC if it isn't the server, switches «Принимать звонки в Easy-Med» on, and makes:
  1. an incoming call they answer;
  2. an incoming call they decline;
  3. an outgoing call;
  4. «Микрофон выкл.» during a call.

  They also report sound quality both ways. Check the onlinePBX call history shows the calls on 108.
- [ ] **Step 4: Report** to the owner in plain words. Push or release only on their word.
