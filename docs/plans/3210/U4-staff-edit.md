# U4. Администратор меняет логин, данные и пароль сотрудника (STAFF_EDIT_V1) — план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (или executing-plans). Шаги — чекбоксы `- [ ]`.

**Goal:** администратор меняет сотруднику логин (не при филиалах и не «от имени»); карточка шлёт только изменённое, и старое неверное значение больше не блокирует сохранение; любая установка пароля снимает блокировку входа; пароль отключённому — с предупреждением; в своей карточке нет поля «Новый пароль»; «Врачи» не снимают роль администратора.

**Architecture:** сервер — `server/routes/users.js` PATCH: `loginChange()` (только администратор, то же правило, что у POST, занятость `COLLATE NOCASE`, гонка UNIQUE → 400, `readPairing(dataDir)` → 409), `withoutUnchanged()` (enum/дата/число, равные хранимым, выпадают из разбора), `clearLoginLocks()` из `services/auth.js` на каждой установке пароля, `password_inactive` в ответе. `app.js` передаёт `dataDir` в `userRoutes`. Клиент — `views/employees.js`: `payloadOf()` (один источник полей) + снимок при открытии + `changedOnly()`; поле «Логин» администратору, отказ под полем; своя карточка без поля пароля; `autocomplete="new-password"`; `pickCategory` не трогает роль администратора; `password-change.js` и карточка показывают предупреждение отключённому. Тексты — ключи `i18n-strings.js` (ru/uz/en).

**Состояние на старте:** ветка `rc/3.21.0`, HEAD 347bfd3d (3.20.0 эти файлы не трогал). Все номера строк — приблизительные, правки привязаны к тексту.

## Карта файлов

| Файл | Что |
|---|---|
| `server/services/auth.js` | + `export function clearLoginLocks(username)`; `changeOwnPassword` снимает блокировку |
| `server/services/auth.login-locks.test.js` | новый: блокировка снимается (функция и своя смена) |
| `server/routes/users.js` | константы и `loginChange()`, `withoutUnchanged()`/`sameAsStored()`, PATCH: логин, UNIQUE, блокировки, `password_inactive`; POST берёт общие константы; `userRoutes(db, { dataDir })` |
| `server/app.js` | `userRoutes(db, { dataDir })` |
| `server/routes/users.staff-edit.test.js` | новый: всё серверное U4 |
| `public/js/admin/i18n-strings.js` | 5 новых фраз |
| `public/js/admin/views/employees.js` | только изменённое, логин, своя карточка, autocomplete, «Врачи» у администратора, предупреждение |
| `public/js/admin/password-change.js` | `INACTIVE_PASSWORD_WARNING`, окно «Сменить пароль» предупреждает |
| `public/js/admin/__tests__/employees-staff-edit.test.mjs` | новый: всё клиентское U4 |
| `public/js/admin/__tests__/employees-card-save.test.mjs`, `employees-profile-save.test.mjs`, `employees-softphone-extension.test.mjs`, `employees-inpatient-rates.test.mjs` | правка ожиданий: нетронутое поле больше не уходит |

Тесты U4 — в новых соседних файлах (`users.*.test.js` уже так устроены), а не дописываются в `users.test.js`: меньше столкновений с другими задачами выпуска.

Сообщение коммита каждой задачи пишется инструментом Write в `.git/U4_MSG.txt` (файл внутри `.git` не попадает в индекс) и коммитится `git commit -F .git/U4_MSG.txt`. Все команды — из корня репозитория `C:\Users\user\Desktop\implementation workflow\easymed.api5`.

---

### Task U4.1: `clearLoginLocks` — новый пароль снимает блокировку входа (служба)

**Files:**
- Modify: `server/services/auth.js`
- Create: `server/services/auth.login-locks.test.js`

- [ ] **Step 1: failing test** — создать `server/services/auth.login-locks.test.js`:

```js
// STAFF_EDIT_V1 (2026-11-02) — НОВЫЙ ПАРОЛЬ СНИМАЕТ БЛОКИРОВКУ ВХОДА.
//
// Пять неверных паролей запирают вход «логин + адрес» на 5 минут
// (services/auth.js login). Сотрудник, забывший пароль, просил администратора
// сбросить его — и с НОВЫМ паролем получал «Слишком много попыток»: блокировка
// переживала сброс. Теперь любая установка пароля (сброс администратором и своя
// смена) снимает блокировку этого логина со всех адресов: clearLoginLocks.
// Карта блокировок — в памяти процесса и общая для файла: у тестов свои логины.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { login, hashPassword, changeOwnPassword, clearLoginLocks } from './auth.js';

function dbWith(...names) {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)');
  for (const n of names) ins.run(n, hashPassword('secret123'), n, 'nurse');
  return db;
}
const lock = (db, name, ip) => { for (let i = 0; i < 5; i += 1) login(db, name, 'bad', { ip }); };

test('clearLoginLocks снимает блокировку логина со всех адресов и не трогает чужие', () => {
  const db = dbWith('lk.alpha', 'lk.beta');
  lock(db, 'lk.alpha', '10.0.0.1');
  lock(db, 'lk.alpha', '10.0.0.2');
  lock(db, 'lk.beta', '10.0.0.1');
  assert.equal(login(db, 'lk.alpha', 'secret123', { ip: '10.0.0.1' }).error, 'locked');
  assert.equal(clearLoginLocks(' LK.Alpha '), 2, 'по записи блокировки на каждый адрес');
  assert.ok(login(db, 'lk.alpha', 'secret123', { ip: '10.0.0.1' }).session, 'с первого адреса вход открыт');
  assert.ok(login(db, 'lk.alpha', 'secret123', { ip: '10.0.0.2' }).session, 'со второго — тоже');
  assert.equal(login(db, 'lk.beta', 'secret123', { ip: '10.0.0.1' }).error, 'locked', 'чужая блокировка снята');
  assert.equal(clearLoginLocks(''), 0);
  assert.equal(clearLoginLocks(null), 0);
});

test('своя смена пароля снимает блокировку входа', () => {
  const db = dbWith('lk.self');
  const { id } = db.prepare("SELECT id FROM users WHERE username = 'lk.self'").get();
  lock(db, 'lk.self', '10.0.0.3');
  assert.equal(login(db, 'lk.self', 'secret123', { ip: '10.0.0.3' }).error, 'locked');
  assert.deepEqual(changeOwnPassword(db, id, 'secret123', 'fresh1'), { ok: true });
  assert.ok(login(db, 'lk.self', 'fresh1', { ip: '10.0.0.3' }).session, 'новый пароль не впустили — блокировка пережила смену');
});
```

- [ ] **Step 2: run — FAIL**

`node --experimental-vm-modules --test server/services/auth.login-locks.test.js`
Ожидается: `SyntaxError: The requested module './auth.js' does not provide an export named 'clearLoginLocks'`.

- [ ] **Step 3: implement** — `server/services/auth.js`.

3a. Сразу после функции `noteFailure` (заканчивается строкой `  return locked ? 'locked' : 'invalid';\n}`) вставить:

```js

/**
 * STAFF_EDIT_V1 — снять блокировку входа этого логина со ВСЕХ адресов.
 *
 * Зовётся при каждой установке пароля: сброс администратором (routes/users.js
 * PATCH) и своя смена (changeOwnPassword ниже). Без этого сотрудник, забывший
 * пароль, с новым паролем ещё 5 минут получал «Слишком много попыток».
 * Логин приводится так же, как при входе (обрезка пробелов, нижний регистр).
 * Предел попыток на адрес (routes/auth.js) не трогается: он про компьютер,
 * а не про человека.
 *
 * @returns {number} сколько записей снято
 */
export function clearLoginLocks(username) {
  const name = String(username ?? '').trim().toLowerCase();
  if (!name) return 0;
  const prefix = name + '|';
  let n = 0;
  for (const key of [...failedAttempts.keys()]) {
    if (key.startsWith(prefix)) { failedAttempts.delete(key); n += 1; }
  }
  return n;
}
```

3b. В `changeOwnPassword` заменить

```js
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1').get(userId);
```
на
```js
  const row = db.prepare('SELECT username, password_hash FROM users WHERE id = ? AND is_active = 1').get(userId);   // STAFF_EDIT_V1 — username для clearLoginLocks
```

и заменить

```js
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, keepSessionId);
  return { ok: true };
```
на
```js
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, keepSessionId);
  clearLoginLocks(row.username);   // STAFF_EDIT_V1 — новый пароль снимает блокировку входа
  return { ok: true };
```

- [ ] **Step 4: run — PASS**

`node --experimental-vm-modules --test server/services/auth.login-locks.test.js server/services/auth.test.js server/routes/auth.test.js`

- [ ] **Step 5: commit** — `.git/U4_MSG.txt`:

```
STAFF_EDIT_V1: clearLoginLocks — новый пароль снимает блокировку входа

Блокировка «5 неверных паролей → 5 минут» переживала смену пароля.
services/auth.js: clearLoginLocks(username) снимает её со всех адресов;
своя смена пароля (changeOwnPassword) зовёт её. Тест:
server/services/auth.login-locks.test.js.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/auth.js server/services/auth.login-locks.test.js
git commit -F .git/U4_MSG.txt
```

---

### Task U4.2: сброс администратором снимает блокировку; пароль отключённому — `password_inactive`

**Files:**
- Modify: `server/routes/users.js`
- Create: `server/routes/users.staff-edit.test.js`

- [ ] **Step 1: failing test** — создать `server/routes/users.staff-edit.test.js`:

```js
// STAFF_EDIT_V1 (2026-11-02) — АДМИНИСТРАТОР МЕНЯЕТ ЛОГИН, ДАННЫЕ И ПАРОЛЬ СОТРУДНИКА.
//
// Спецификация — docs/specs/2026-11-02-3210-batch-design.md, U4. Здесь — сервер
// (routes/users.js PATCH):
//   • сброс пароля снимает блокировку входа (5 ошибок → 5 минут);
//   • пароль отключённому — ответ с признаком password_inactive;
//   • значения, равные сохранённым, не проверяются: старое неверное значение не
//     держит сохранение;
//   • логин меняет администратор (не «вход как сотрудник»): правило заведения,
//     занятость без учёта регистра, гонка UNIQUE, другой регистр — ничего,
//     подключены филиалы — 409.
// Блокировка входа живёт в памяти процесса (services/auth.js) и общая для всех
// тестов файла — поэтому у каждого теста свои логины.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { writePairing, clearPairing } from '../services/branch-sync/pairing.js';

const BOSS = 1, REG = 2, NURSE = 3;

function addGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  const pw = hashPassword('password1');
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, extra_roles, must_change_password) VALUES (?,?,?,?,?,?,0)');
  ins.run(BOSS, 'boss', pw, 'Петров П.', 'admin', '[]');
  ins.run(REG, 'reg', pw, 'Регистратор Р.', 'registrar', '[]');
  ins.run(NURSE, 'nurse.a', pw, 'Медсестра А.', 'nurse', '[]');
  // Регистратуре выдано «Сотрудники: Изменение» — отказ ей должен прийти от
  // правила логина, а не от раздела.
  addGrants(db, 'registrar', { settings: 'view', 'settings.employees': 'edit' });
  const dataDir = licensedDataDir();
  const server = await listen(createApp(db, { dataDir }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base, dataDir };
}

// Вкладка, работающая от имени сотрудника, шлёт номер входа от имени (X-Em-Act-As).
const TAB = new Map();
async function call(base, cookie, method, path, body) {
  const tab = cookie && TAB.has(cookie) ? { 'X-Em-Act-As': String(TAB.get(cookie)) } : {};
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...tab },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
async function tryLogin(base, username, password = 'password1') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  return { status: res.status, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}
async function login(base, username, password = 'password1') {
  const r = await tryLogin(base, username, password);
  assert.equal(r.status, 200, 'вход ' + username);
  return r.cookie;
}
const usernameOf = (db, id) => db.prepare('SELECT username FROM users WHERE id = ?').get(id).username;

test('STAFF_EDIT_V1: сброс пароля администратором снимает блокировку входа', async () => {
  const { db, server, base } = await startServer();
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (20, 'lock.reset', ?, 'Забывчивая З.', 'nurse')")
      .run(hashPassword('old-pass'));
    const boss = await login(base, 'boss');
    for (let i = 0; i < 4; i += 1) assert.equal((await tryLogin(base, 'lock.reset', 'wrong')).status, 401);
    assert.equal((await tryLogin(base, 'lock.reset', 'wrong')).status, 429, 'пятая ошибка запирает вход');
    assert.equal((await tryLogin(base, 'lock.reset', 'old-pass')).status, 429, 'и верный пароль не пускает');
    const r = await call(base, boss, 'PATCH', '/api/users/20', { password: 'new-pass' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await tryLogin(base, 'lock.reset', 'new-pass')).status, 200, 'с новым паролем — сразу, без пяти минут ожидания');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: пароль отключённому — признак password_inactive; включённому и без пароля — нет', async () => {
  const { db, server, base } = await startServer();
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active) VALUES (21, 'gone.one', 'x', 'Уволенный У.', 'nurse', 0)").run();
    const boss = await login(base, 'boss');
    let r = await call(base, boss, 'PATCH', '/api/users/21', { password: 'pw-1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.password_inactive, true, 'экран не узнает, что сотрудник не войдёт');
    assert.equal((await tryLogin(base, 'gone.one', 'pw-1')).status, 401, 'отключённый не входит — потому и предупреждение');
    r = await call(base, boss, 'PATCH', '/api/users/21', { password: 'pw-2', is_active: true });
    assert.equal(r.status, 200);
    assert.ok(!('password_inactive' in r.json), 'включили в том же сохранении — предупреждать не о чем');
    r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { password: 'pw-3' });
    assert.ok(!('password_inactive' in r.json));
    r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { phone: '+998901234567' });
    assert.ok(!('password_inactive' in r.json), 'без пароля признака нет');
  } finally { server.close(); }
});
```

- [ ] **Step 2: run — FAIL**

`node --experimental-vm-modules --test server/routes/users.staff-edit.test.js`
Ожидается: первый тест — `с новым паролем — сразу…` (`429 !== 200`), второй — `экран не узнает…` (`undefined !== true`).

- [ ] **Step 3: implement** — `server/routes/users.js`.

3a. Импорт (строка 2) заменить

```js
import { hashPassword, validPassword } from '../services/auth.js';
```
на
```js
import { hashPassword, validPassword, clearLoginLocks } from '../services/auth.js';   // STAFF_EDIT_V1 — clearLoginLocks
```

3b. В PATCH заменить

```js
    const outView = withSpecialties(db, employeeView(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
    res.json({ user: employeeMoneyAllowed(db, req.user) ? outView : stripMoney(outView) });
```
на
```js
    // STAFF_EDIT_V1 — новый пароль снимает блокировку входа (5 ошибок → 5 минут,
    // services/auth.js): сотрудник, забывший пароль, входит с новым сразу.
    if (password !== undefined) clearLoginLocks(user.username);
    const outRow = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const outView = withSpecialties(db, employeeView(outRow));
    // STAFF_EDIT_V1 — пароль поставлен, а сотрудник отключён: войти он не сможет,
    // и экран обязан сказать это, а не «Пароль изменён».
    const inactive = password !== undefined && !outRow.is_active ? { password_inactive: true } : {};
    res.json({ user: employeeMoneyAllowed(db, req.user) ? outView : stripMoney(outView), ...inactive });
```

- [ ] **Step 4: run — PASS**

`node --experimental-vm-modules --test server/routes/users.staff-edit.test.js server/routes/users.test.js server/routes/password-change-v2.test.js`

- [ ] **Step 5: commit** — `.git/U4_MSG.txt`:

```
STAFF_EDIT_V1: сброс пароля снимает блокировку; пароль отключённому — признак

PATCH /api/users/:id с паролем снимает блокировку входа этого логина
(clearLoginLocks) и, если сотрудник отключён, отвечает password_inactive:
true — экран предупредит, что сотрудник не войдёт.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/routes/users.js server/routes/users.staff-edit.test.js
git commit -F .git/U4_MSG.txt
```

---

### Task U4.3: значения, равные сохранённым, не проверяются (сервер)

**Files:**
- Modify: `server/routes/users.js`
- Modify: `server/routes/users.staff-edit.test.js`

- [ ] **Step 1: failing test** — дописать в конец `server/routes/users.staff-edit.test.js`:

```js
test('STAFF_EDIT_V1: значения, равные сохранённым, не проверяются — старое неверное не мешает сменить телефон', async () => {
  const { db, server, base } = await startServer();
  try {
    db.prepare(`INSERT INTO users (id, username, password_hash, full_name, last_name, first_name, role, staff_type, is_doctor,
                  hire_date, doctor_category, employment_type, salary_percent, phone)
                VALUES (30, 'old.doc', 'x', 'Каримов Анвар', 'Каримов', 'Анвар', 'doctor', 'Врач', 1,
                  '15.01.2020', 'Высшая', 'штат', 150, '+998901112233')`).run();
    const boss = await login(base, 'boss');
    // Старая вкладка карточки (и импорт) шлёт всё, что хранится, — и неверное тоже.
    const stale = { hire_date: '15.01.2020', doctor_category: 'Высшая', employment_type: 'штат', staff_type: 'Врач', salary_percent: 150 };
    let r = await call(base, boss, 'PATCH', '/api/users/30', { ...stale, phone: '+998901112244' });
    assert.equal(r.status, 200, 'посторонний отказ: ' + JSON.stringify(r.json));
    const row = db.prepare('SELECT phone, hire_date, doctor_category, employment_type, staff_type, salary_percent, is_doctor FROM users WHERE id = 30').get();
    assert.equal(row.phone, '+998901112244');
    assert.deepEqual([row.hire_date, row.doctor_category, row.employment_type, row.staff_type, row.salary_percent, row.is_doctor],
      ['15.01.2020', 'Высшая', 'штат', 'Врач', 150, 1], 'нетронутые значения переписаны или признак врача сброшен');
    // Изменённое по-прежнему проверяется.
    r = await call(base, boss, 'PATCH', '/api/users/30', { hire_date: '16.01.2020' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.message, 'Дата указана неверно.');
    r = await call(base, boss, 'PATCH', '/api/users/30', { doctor_category: 'Первая' });
    assert.equal(r.status, 400);
    r = await call(base, boss, 'PATCH', '/api/users/30', { salary_percent: 151 });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});
```

- [ ] **Step 2: run — FAIL**

`node --experimental-vm-modules --test server/routes/users.staff-edit.test.js`
Ожидается: `посторонний отказ: {"error":{"code":"bad_request","message":"Неизвестная категория врача."}}` (`400 !== 200`).

- [ ] **Step 3: implement** — `server/routes/users.js`.

3a. Сразу после функции `parseEmployeeFields` (заканчивается `  return { ok: true, fields };\n}`) и перед `const MAX_RATE_ENTRIES = 5000;` вставить:

```js

// STAFF_EDIT_V1 — ЗНАЧЕНИЯ, РАВНЫЕ СОХРАНЁННЫМ, НЕ ПРОВЕРЯЮТСЯ И НЕ ПЕРЕПИСЫВАЮТСЯ.
//
// Карточка сотрудника теперь шлёт только изменённое, но старая вкладка, импорт
// из Excel и любой другой клиент шлют всё, что хранится. Значение, записанное
// до нынешних правил (дата «15.01.2020», категория «Высшая», процент 150),
// отказывало ВСЕМУ сохранению сообщением о поле, которого никто не трогал.
// Поля ниже, равные хранимым, из разбора выпадают; изменённое проверяется как
// прежде. pbx_extension здесь нет: его «не трогали» решает assignExtension
// (назначение номера, совпавшего с самовыбранным, — это правка). staff_type не
// выпадает, если рядом прислан is_doctor: категория остаётся источником признака.
const UNCHANGED_SKIP_KEYS = ['doctor_category', 'employment_type', 'salary_type', 'hire_date', 'license_expiry_date',
  'salary_fixed', 'salary_percent', 'staff_type', 'scheduling_mode', 'department_id', 'branch_id',
  'service_rate_default', 'referral_rate_default', 'inpatient_referral_pct', 'inpatient_referral_fixed', 'booking_days'];
const blankValue = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
/** Равно ли присланное хранимому (пустое — пустому, число — числу, текст — без пробелов по краям). */
export function sameAsStored(sent, stored) {
  if (blankValue(sent) || blankValue(stored)) return blankValue(sent) && blankValue(stored);
  if (typeof sent === 'number' || typeof stored === 'number') return Number(sent) === Number(stored);
  return String(sent).trim() === String(stored).trim();
}
/** Копия тела без полей, равных хранимым в строке row (UNCHANGED_SKIP_KEYS). */
export function withoutUnchanged(body, row) {
  const out = { ...(body || {}) };
  if (!row) return out;
  for (const k of UNCHANGED_SKIP_KEYS) {
    if (out[k] === undefined) continue;
    if (k === 'staff_type' && out.is_doctor !== undefined) continue;
    if (sameAsStored(out[k], row[k])) delete out[k];
  }
  return out;
}
```

3b. В PATCH заменить

```js
    const parsed = parseEmployeeFields(req.body, db, user.role, user.id);   // CLINIC_API_FIX_V1 — фото только из папки этого сотрудника
```
на
```js
    // STAFF_EDIT_V1 — поля, равные хранимым, не проверяются (withoutUnchanged).
    // Проверки прав выше читают req.body как есть — они строже.
    const parsed = parseEmployeeFields(withoutUnchanged(req.body, user), db, user.role, user.id);   // CLINIC_API_FIX_V1 — фото только из папки этого сотрудника
```

- [ ] **Step 4: run — PASS**

`node --experimental-vm-modules --test server/routes/users.staff-edit.test.js server/routes/users.test.js server/routes/users.softphone.test.js server/routes/users.inpatient.test.js server/routes/users.public-profile.test.js server/routes/users.specialties.test.js server/routes/data-transfer.test.js`

- [ ] **Step 5: commit** — `.git/U4_MSG.txt`:

```
STAFF_EDIT_V1: поля, равные сохранённым, не проверяются

Старое неверное значение (дата «15.01.2020», категория «Высшая»,
процент 150), присланное без изменений, больше не отказывает всему
сохранению карточки. routes/users.js: withoutUnchanged/sameAsStored
перед parseEmployeeFields; изменённое проверяется как прежде.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/routes/users.js server/routes/users.staff-edit.test.js
git commit -F .git/U4_MSG.txt
```

---

### Task U4.4: смена логина — только администратор, правило, занятость, гонка, филиалы

**Files:**
- Modify: `server/routes/users.js`
- Modify: `server/app.js`
- Modify: `server/routes/users.staff-edit.test.js`

- [ ] **Step 1: failing tests** — дописать в конец `server/routes/users.staff-edit.test.js`:

```js
const RULE_MSG = 'Логин — от 3 до 30 символов: латинские буквы, цифры, точка, _ и -.';
const TAKEN_MSG = 'Такой логин уже занят.';
const ADMIN_ONLY_MSG = 'Логин меняет только администратор.';
const BRANCH_MSG = 'Логин нельзя менять, пока подключены филиалы: филиалы узнают сотрудника по логину.';

test('STAFF_EDIT_V1: администратор меняет логин — новый входит, старый нет; пробелы и регистр приводятся; сеанс сотрудника жив', async () => {
  const { db, server, base } = await startServer();
  try {
    const nurse = await login(base, 'nurse.a');
    const boss = await login(base, 'boss');
    // Под будущим логином кто-то ошибался, пока такого логина не было: эта
    // блокировка к сотруднику отношения не имеет и снимается вместе со сменой.
    for (let i = 0; i < 5; i += 1) await tryLogin(base, 'nurse.b', 'wrong');
    const r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: '  Nurse.B ' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.user.username, 'nurse.b');
    assert.equal(usernameOf(db, NURSE), 'nurse.b');
    assert.equal((await tryLogin(base, 'nurse.a')).status, 401, 'старый логин всё ещё входит');
    assert.equal((await tryLogin(base, 'nurse.b')).status, 200, 'новый логин не входит');
    const me = await call(base, nurse, 'GET', '/api/auth/me');
    assert.equal(me.status, 200, 'открытый сеанс сотрудника закрылся');
    assert.equal(me.json.user.username, 'nurse.b');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: тот же логин в другом регистре — ничего не меняется', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    const r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'NURSE.A' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(usernameOf(db, NURSE), 'nurse.a');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: занятый логин (другой регистр, пробелы) и неверный — 400 с полем username', async () => {
  const { db, server, base } = await startServer();
  try {
    db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('taken.one', 'x', 'Занятый З.', 'nurse')").run();
    const boss = await login(base, 'boss');
    let r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: ' TAKEN.ONE ' });
    assert.equal(r.status, 400);
    assert.deepEqual([r.json.error.message, r.json.error.field], [TAKEN_MSG, 'username']);
    for (const bad of ['ab', 'имя.фамилия', 'a b c', 'x'.repeat(31), '']) {
      r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.deepEqual([r.json.error.message, r.json.error.field], [RULE_MSG, 'username'], JSON.stringify(bad));
    }
    assert.equal(usernameOf(db, NURSE), 'nurse.a');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: логин заняли между проверкой и записью — 400 «Такой логин уже занят.», ничего не записано', async () => {
  const { db, server, base } = await startServer();
  try {
    // Второй администратор «успевает» завести 'racer' ровно в миг записи:
    // триггер вставляет его перед обновлением строки, UNIQUE срабатывает на записи.
    db.exec(`CREATE TRIGGER race_login BEFORE UPDATE OF username ON users WHEN NEW.username = 'racer'
             BEGIN INSERT INTO users (username, password_hash, full_name, role) VALUES ('racer', 'x', 'Гонщик Г.', 'nurse'); END;`);
    const boss = await login(base, 'boss');
    const r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'racer', phone: '+998901234567' });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.deepEqual([r.json.error.message, r.json.error.field], [TAKEN_MSG, 'username']);
    assert.equal(usernameOf(db, NURSE), 'nurse.a');
    assert.notEqual(db.prepare('SELECT phone FROM users WHERE id = ?').get(NURSE).phone, '+998901234567', 'правка записалась наполовину');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: логин меняет только администратор — не-администратору с «Сотрудники: Изменение» 403', async () => {
  const { db, server, base } = await startServer();
  try {
    const reg = await login(base, 'reg');
    let r = await call(base, reg, 'PATCH', '/api/users/' + NURSE, { username: 'nurse.z' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.message, ADMIN_ONLY_MSG);
    r = await call(base, reg, 'PATCH', '/api/users/' + REG, { username: 'reg.z' });
    assert.equal(r.status, 403, 'свой логин — тоже через администратора');
    assert.equal(r.json.error.message, ADMIN_ONLY_MSG);
    assert.deepEqual([usernameOf(db, REG), usernameOf(db, NURSE)], ['reg', 'nurse.a']);
    // Тот же логин (старая вкладка, импорт) — не смена и не отказ.
    r = await call(base, reg, 'PATCH', '/api/users/' + REG, { username: 'REG', phone: '+998901234567' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: работая от имени сотрудника, логин не меняется', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    const start = await call(base, boss, 'POST', '/api/auth/act-as', { user_id: REG });
    assert.equal(start.status, 200, JSON.stringify(start.json));
    TAB.set(boss, start.json.act_as_id);
    let r = await call(base, boss, 'PATCH', '/api/users/' + REG, { username: 'reg.z' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.message, ADMIN_ONLY_MSG);
    r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'nurse.z' });
    assert.equal(r.status, 403);
    assert.deepEqual([usernameOf(db, REG), usernameOf(db, NURSE)], ['reg', 'nurse.a']);
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: пока установка в группе филиалов — 409 и логин прежний; связь сняли — меняется', async () => {
  const { db, server, base, dataDir } = await startServer();
  try {
    writePairing(dataDir, { role: 'main', group_id: 'BR-TEST', secret: 's3cret' });
    const boss = await login(base, 'boss');
    let r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'nurse.b' });
    assert.equal(r.status, 409);
    assert.deepEqual([r.json.error.message, r.json.error.field], [BRANCH_MSG, 'username']);
    assert.equal(usernameOf(db, NURSE), 'nurse.a');
    r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'nurse.a', phone: '+998901234567' });
    assert.equal(r.status, 200, 'тот же логин при филиалах — не отказ');
    clearPairing(dataDir);
    r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'nurse.b' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(usernameOf(db, NURSE), 'nurse.b');
  } finally { server.close(); }
});
```

- [ ] **Step 2: run — FAIL**

`node --experimental-vm-modules --test server/routes/users.staff-edit.test.js`
Ожидается: падают все семь новых (логин сейчас молча игнорируется: `r.json.user.username` — `'nurse.a'`, статусы 200 вместо 400/403/409; у теста не-администратора — другой текст 403 или 200).

- [ ] **Step 3: implement**

3a. `server/routes/users.js`, импорты: после строки

```js
import { ACT_AS_MESSAGES } from '../../public/js/shared/act-as.js';   // ADMIN_ACT_AS_V1 (R6)
```
вставить
```js
import { readPairing } from '../services/branch-sync/pairing.js';   // STAFF_EDIT_V1 — в группе ли филиалов (смена логина)
import { getDataDir } from '../services/control/config.js';         // STAFF_EDIT_V1 — каталог данных, если app.js его не передал
```

3b. Заменить строку `export function userRoutes(db) {` на:

```js
// STAFF_EDIT_V1 (2026-11-02) — ЛОГИН СОТРУДНИКА МЕНЯЕТ АДМИНИСТРАТОР.
//
// Прежде поле «Логин» в карточке было заблокировано, PATCH его не слал, а
// сервер не читал (200 и ничего): опечатку в логине нельзя было исправить,
// кроме как завести сотрудника заново. Теперь:
//   • только администратор (isAdminUser) и не «вход как сотрудник»: логин
//     решает, кто входит в программу, — то же, что пароль;
//   • правило то же, что при заведении (POST ниже): обрезка пробелов, нижний
//     регистр, 3–30 знаков латиницей, цифрами, «.», «_», «-»;
//   • тот же логин в другом регистре — не смена: ничего не делается;
//   • занятость — без учёта регистра и без самой строки; заняли в тот же миг
//     (UNIQUE при записи) — тот же отказ «Такой логин уже занят.»;
//   • пока установка в группе филиалов (data/branch-sync.json, readPairing:
//     главная или филиал) — 409: сеть узнаёт сотрудника по логину
//     (branch-sync/catalogue.js — естественный ключ username, отсутствующих
//     отключает; врач в записях едет логином, journal.js). Смена логина на
//     главной завела бы у филиалов нового сотрудника и отключила прежнего.
// Открытые сеансы сотрудника остаются: сессия держится за id, а не за логин.
export const LOGIN_RE = /^[a-z0-9._-]{3,30}$/;
export const LOGIN_RULE_MESSAGE = 'Логин — от 3 до 30 символов: латинские буквы, цифры, точка, _ и -.';
export const LOGIN_TAKEN_MESSAGE = 'Такой логин уже занят.';
export const LOGIN_ADMIN_ONLY_MESSAGE = 'Логин меняет только администратор.';
export const LOGIN_BRANCHES_MESSAGE = 'Логин нельзя менять, пока подключены филиалы: филиалы узнают сотрудника по логину.';

/**
 * STAFF_EDIT_V1 — что делать с присланным логином.
 * @returns {{ username?: string, status?: number, error?: { code: string, message: string, field?: string } }}
 *   {} — логин прежний; { username } — новый логин; { status, error } — отказ.
 */
function loginChange(db, actor, row, sent, dataDir) {
  if (sent === undefined) return {};
  const name = String(sent ?? '').trim().toLowerCase();
  if (name === String(row.username || '').trim().toLowerCase()) return {};
  if (!isAdminUser(actor) || (actor && actor.acting_admin)) {
    return { status: 403, error: { code: 'forbidden', message: LOGIN_ADMIN_ONLY_MESSAGE } };
  }
  if (!LOGIN_RE.test(name)) return { status: 400, error: { code: 'bad_request', message: LOGIN_RULE_MESSAGE, field: 'username' } };
  if (readPairing(dataDir)) return { status: 409, error: { code: 'conflict', message: LOGIN_BRANCHES_MESSAGE, field: 'username' } };
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id <> ?').get(name, row.id)) {
    return { status: 400, error: { code: 'bad_request', message: LOGIN_TAKEN_MESSAGE, field: 'username' } };
  }
  return { username: name };
}

// STAFF_EDIT_V1 — dataDir: где лежит data/branch-sync.json (app.js передаёт свой).
export function userRoutes(db, { dataDir } = {}) {
```

3c. POST — заменить

```js
    if (!/^[a-z0-9._-]{3,30}$/.test(name)) return bad(res, 'Логин — от 3 до 30 символов: латинские буквы, цифры, точка, _ и -.');
```
на
```js
    if (!LOGIN_RE.test(name)) return bad(res, LOGIN_RULE_MESSAGE);   // STAFF_EDIT_V1 — правило одно с PATCH
```
и
```js
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return bad(res, 'Такой логин уже занят.');
```
на
```js
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return bad(res, LOGIN_TAKEN_MESSAGE);   // STAFF_EDIT_V1 — текст один с PATCH
```

3d. PATCH — сразу после

```js
    if (password !== undefined && req.user.acting_admin && user.id === req.user.id) {
      return forbid(res, ACT_AS_MESSAGES.passwordWhileActing);
    }
```
вставить
```js
    // STAFF_EDIT_V1 — смена логина (loginChange выше). До прочих проверок: не-администратор
    // получает ответ про логин, а не про чужую роль.
    const loginStep = loginChange(db, req.user, user, req.body ? req.body.username : undefined, dataDir || getDataDir());
    if (loginStep.error) return res.status(loginStep.status).json({ error: loginStep.error });
    const newUsername = loginStep.username;   // undefined — логин прежний
```

3e. PATCH, список SET — заменить

```js
      'full_name     = COALESCE(?, full_name)',
      'role          = COALESCE(?, role)',
```
на
```js
      'full_name     = COALESCE(?, full_name)',
      'username      = COALESCE(?, username)',   // STAFF_EDIT_V1
      'role          = COALESCE(?, role)',
```
и значения — заменить
```js
      finalFullName !== undefined ? finalFullName : null,
      roleToWrite ?? null,
```
на
```js
      finalFullName !== undefined ? finalFullName : null,
      newUsername ?? null,   // STAFF_EDIT_V1
      roleToWrite ?? null,
```

3f. PATCH, транзакция — заменить

```js
    db.transaction(() => {
      db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...values, user.id);
      if (specs.list) writeSpecialties(db, user.id, specs.list);
    })();
```
на
```js
    try {
      db.transaction(() => {
        db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...values, user.id);
        if (specs.list) writeSpecialties(db, user.id, specs.list);
      })();
    } catch (e) {
      // STAFF_EDIT_V1 — логин заняли между проверкой и записью (два администратора разом).
      if (newUsername !== undefined && e && e.code === 'SQLITE_CONSTRAINT_UNIQUE' && /users\.username/.test(String(e.message))) {
        return bad(res, LOGIN_TAKEN_MESSAGE, 'username');
      }
      throw e;
    }
```

3g. PATCH — заменить строку из U4.2

```js
    if (password !== undefined) clearLoginLocks(user.username);
```
на
```js
    if (password !== undefined) clearLoginLocks(user.username);
    // Новый логин — тоже: чужие ошибки под этим именем, пока его не было, к сотруднику отношения не имеют.
    if (newUsername !== undefined) clearLoginLocks(newUsername);
```

3h. `server/app.js` — заменить

```js
  app.use('/api/users', actAsRouterGuard(db, 'users'), userRoutes(db));
```
на
```js
  app.use('/api/users', actAsRouterGuard(db, 'users'), userRoutes(db, { dataDir }));   // STAFF_EDIT_V1 — dataDir: в группе ли филиалов
```

- [ ] **Step 4: run — PASS**

`node --experimental-vm-modules --test server/routes/users.staff-edit.test.js server/routes/users.test.js server/routes/act-as.test.js server/routes/data-transfer.test.js server/routes/staff-sync-readonly.test.js server/routes/branch-sync.test.js`

- [ ] **Step 5: commit** — `.git/U4_MSG.txt`:

```
STAFF_EDIT_V1: администратор меняет логин сотрудника

PATCH /api/users/:id принимает username: только администратор (не «от
имени сотрудника»), то же правило, что при заведении, занятость без
учёта регистра, гонка UNIQUE — «Такой логин уже занят.», другой
регистр — ничего; пока установка в группе филиалов — 409. Сеансы
сотрудника остаются. app.js передаёт dataDir в userRoutes.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/routes/users.js server/app.js server/routes/users.staff-edit.test.js
git commit -F .git/U4_MSG.txt
```

---

### Task U4.5: тексты — ru/uz/en; заготовка клиентского теста

**Files:**
- Modify: `public/js/admin/i18n-strings.js`
- Create: `public/js/admin/__tests__/employees-staff-edit.test.mjs`
- Modify: `server/routes/users.staff-edit.test.js`

- [ ] **Step 1: failing tests**

1a. Создать `public/js/admin/__tests__/employees-staff-edit.test.mjs` (харнесс — копия `employees-card-save.test.mjs`; `remove()` убирает узел из `document.body`; тосты перехватываются, как в `act-as-employees.test.mjs`):

```js
// STAFF_EDIT_V1 (2026-11-02) — КАРТОЧКА СОТРУДНИКА: ЛОГИН, ТОЛЬКО ИЗМЕНЁННОЕ, ПАРОЛЬ.
//
// Спецификация — docs/specs/2026-11-02-3210-batch-design.md, U4. Проверяется:
//   • новые фразы — на трёх языках (uz и en без кириллицы);
//   • у существующего сотрудника уходят только изменённые поля: старое неверное
//     значение (дата «15.01.2020», категория «Высшая», процент 150) не уходит и
//     не держит сохранение; новый сотрудник — вся карточка, как прежде;
//   • логин правит администратор: уходит изменённый (без пробелов, нижним
//     регистром), другой регистр — не смена; отказ сервера — под полем;
//     не-администратору и «от имени сотрудника» поле закрыто;
//   • своя карточка — без поля «Новый пароль»; autocomplete="new-password";
//   • «Врачи» на карточке администратора не снимают роль администратора;
//   • пароль отключённому — предупреждение «включите «Активен»».
//
// Поддельный DOM — тот же, что в employees-card-save.test.mjs; тосты
// перехватываются, как в act-as-employees.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../i18n-strings.js';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.children.push(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);
   if (k === 'checked') this.checked = true;
   if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);}
 getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} select(){}
 remove(){ this.removed = true; const i = document.body.children.indexOf(this); if (i > -1) document.body.children.splice(i, 1); }
 querySelectorAll(sel){const m=String(sel).match(/^(\w+)\[([\w-]+)(?:="([^"]*)")?\]$/);if(!m)return [];const out=[];
   const go=(e)=>{for(const c of e.children||[]){if(c.tagName===m[1].toUpperCase()&&(m[3]===undefined?(m[2] in (c.attrs||{})):(c.attrs||{})[m[2]]===m[3]))out.push(c);go(c);}};go(this);return out;}
 querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
const toasts = [];
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return ''; }, set(v) { toasts.push(String(v)); } });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: (id) => (id === 'toast' ? toastEl : null),
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
localStorage.setItem('admin.lang', 'ru');
const ADMIN_ME = { id: 2, role: 'admin', is_admin: true };
globalThis.window = {
  location: { hostname: 'localhost', reload() {} }, localStorage, addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: ADMIN_ME } },
  CLINIC: { id: 1 },
  confirm: () => true,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const NEW_STRINGS = [
  'Логин меняет только администратор.',
  'Логин нельзя менять, пока подключены филиалы: филиалы узнают сотрудника по логину.',
  'Пароль изменён, но сотрудник отключён — включите «Активен», иначе он не войдёт.',
  'Новый логин действует со следующего входа; открытые входы сотрудника не закрываются.',
  'Администратор остаётся администратором: «Врачи» добавляет ему приём пациентов, права администратора не снимаются.',
];
const [, BRANCH_MSG, INACTIVE_MSG, LOGIN_HINT, ADMIN_DOCTOR_HINT] = NEW_STRINGS;

const base = { is_active: true, is_local: true, extra_roles: [], middle_name: '', email: '', branch_id: 1,
  service_rates: [], referral_rates: [], inpatient_rates: [], scheduling_mode: 'schedulable' };
// Врач со значениями, записанными до нынешних правил: каждое из них сервер
// отверг бы, если бы карточка прислала его снова.
const OLD_DOC = { ...base, id: 80, username: 'old.doc', full_name: 'Каримов Анвар', last_name: 'Каримов', first_name: 'Анвар',
  phone: '+998901112233', role: 'doctor', staff_type: 'doctor', is_doctor: true, specialty: 'Терапевт',
  hire_date: '15.01.2020', doctor_category: 'Высшая', employment_type: 'штат', salary_percent: 150 };
const ME = { ...base, id: 2, username: 'boss', full_name: 'Петров Пётр', last_name: 'Петров', first_name: 'Пётр',
  phone: '+998901110000', role: 'admin', staff_type: 'admin_staff', is_doctor: false };
const CHIEF = { ...base, id: 3, username: 'chief', full_name: 'Алиев Бобур', last_name: 'Алиев', first_name: 'Бобур',
  phone: '+998901110001', role: 'admin', staff_type: 'admin_staff', is_doctor: false };
const NURSE = { ...base, id: 4, username: 'nurse.k', full_name: 'Каримова Дилноза', last_name: 'Каримова', first_name: 'Дилноза',
  phone: '+998901110002', role: 'nurse', staff_type: 'mid_low', is_doctor: false };

const writes = [];
let nextAnswer = null;   // { status, json } — ответ на ближайшую запись /api/users
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  if (u === '/api/users' && method === 'GET') return { ok: true, status: 200, json: async () => ({ users: [OLD_DOC, ME, CHIEF, NURSE] }) };
  if (u.startsWith('/api/users')) {
    writes.push({ u, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const a = nextAnswer || { status: 200, json: { user: {} } };
    nextAnswer = null;
    return { ok: a.status < 400, status: a.status, json: async () => a.json };
  }
  if (u === '/api/db') {
    const desc = opts.body ? JSON.parse(opts.body) : {};
    const rows = desc.table === 'branches' ? [{ id: 1, name: 'Чиланзар' }] : [];
    return { ok: true, status: 200, json: async () => ({ data: rows }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: [] }) };
};

const { renderEmployees } = await import('../views/employees.js');
const { openEmployeePasswordModal } = await import('../password-change.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const byClass = (root, c) => walk(root).filter((n) => String(n.className || '').split(/\s+/).includes(c));
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };
const pick = (sel, v) => { sel.value = v; sel.dispatchEvent({ type: 'change' }); };
const byPh = (card, ph) => tags(card, 'input').find((i) => i.attrs.placeholder === ph);
const loginInput = (card) => byPh(card, 'login');
const passwordInputs = (card) => tags(card, 'input').filter((i) => i.attrs.type === 'password');
const isDisabled = (el) => el.hasAttribute('disabled') || el.disabled === true;
const categorySelect = (card) => tags(card, 'select').find((s) => s.children.some((o) => o.attrs && o.attrs.value === 'admin_staff'));
const setPhone = (card, v) => {
  const ph = byClass(card, 'ph-wrap')[0];
  ph.input.value = v; ph.input.dispatchEvent({ type: 'input' }); ph.dispatchEvent({ type: 'input' });
};
const textNodes = (el) => walk(el).filter((n) => n.tagName === '#TEXT').map((n) => n._t).join('').trim();
const loginErrorText = (card) => { const a = walk(card).find((n) => n.attrs && 'data-login-error' in n.attrs); return a ? textNodes(a) : null; };
const activeCheckbox = (card) => tags(byClass(card, 'checkbox').find((n) => textOf(n).includes('Активен')), 'input')[0];
const topModal = () => document.body.children.filter((c) => c.className === 'modal').at(-1);

let container;
async function openList() {
  document.body.children.length = 0;
  writes.length = 0;
  toasts.length = 0;
  nextAnswer = null;
  container = mk('div');
  await renderEmployees(container);
  await flush();
}
async function openCard(username) {
  await openList();
  const row = tags(container, 'tr').find((r) => textOf(r).includes('@' + username));
  assert.ok(row, 'нет строки @' + username);
  row.dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  return document.body.children.find((c) => c.className === 'modal');
}
async function openNew() {
  await openList();
  buttonWith(container, 'Новый сотрудник').click();
  await flush();
  return document.body.children.find((c) => c.className === 'modal');
}
async function tab(card, label) {
  const item = walk(card).filter((n) => n._l && n._l.click && textOf(n).includes(label)).pop();
  assert.ok(item, 'нет раздела «' + label + '» в рейке');
  item.click();
  await flush();
}
async function save(card) {
  buttonWith(card, 'Сохранить сотрудника').click();
  await flush();
}

test('STAFF_EDIT_V1: новые фразы — на трёх языках, в uz и en нет кириллицы', () => {
  for (const key of NEW_STRINGS) {
    const e = STRINGS[key];
    assert.ok(e, 'нет в словаре: ' + key);
    assert.equal(e.ru, key);
    for (const lang of ['uz', 'en']) {
      assert.ok(e[lang] && e[lang] !== key, lang + ' не переведено: ' + key);
      assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, lang + ' с кириллицей: ' + e[lang]);
    }
  }
});
```

1b. `server/routes/users.staff-edit.test.js` — после строки
```js
import { writePairing, clearPairing } from '../services/branch-sync/pairing.js';
```
вставить
```js
import { STRINGS } from '../../public/js/admin/i18n-strings.js';   // STAFF_EDIT_V1 — отказы переводятся экраном
import { LOGIN_RULE_MESSAGE, LOGIN_TAKEN_MESSAGE, LOGIN_ADMIN_ONLY_MESSAGE, LOGIN_BRANCHES_MESSAGE } from './users.js';
```
и дописать в конец файла:
```js
test('STAFF_EDIT_V1: отказы смены логина — ключи словаря на трёх языках', () => {
  for (const m of [LOGIN_RULE_MESSAGE, LOGIN_TAKEN_MESSAGE, LOGIN_ADMIN_ONLY_MESSAGE, LOGIN_BRANCHES_MESSAGE]) {
    const e = STRINGS[m];
    assert.ok(e && e.ru === m && e.uz && e.en, 'нет перевода: ' + m);
  }
});
```

- [ ] **Step 2: run — FAIL**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs server/routes/users.staff-edit.test.js`
Ожидается: `нет в словаре: Логин меняет только администратор.` и `нет перевода: Логин меняет только администратор.`.

- [ ] **Step 3: implement** — `public/js/admin/i18n-strings.js`: после строки

```js
  "Такой логин уже занят.": {"en":"This username is already taken.","ru":"Такой логин уже занят.","uz":"Bu login allaqachon band."},
```
вставить
```js
  // STAFF_EDIT_V1 — карточка сотрудника: смена логина, пароль отключённому, администратор-врач (routes/users.js, views/employees.js, password-change.js)
  "Логин меняет только администратор.": {"en":"Only an administrator can change the login.","ru":"Логин меняет только администратор.","uz":"Loginni faqat administrator o‘zgartira oladi."},   // STAFF_EDIT_V1
  "Логин нельзя менять, пока подключены филиалы: филиалы узнают сотрудника по логину.": {"en":"The login cannot be changed while branches are connected: branches recognise the employee by the login.","ru":"Логин нельзя менять, пока подключены филиалы: филиалы узнают сотрудника по логину.","uz":"Filiallar ulanganida loginni o‘zgartirib bo‘lmaydi: filiallar xodimni login orqali taniydi."},   // STAFF_EDIT_V1
  "Пароль изменён, но сотрудник отключён — включите «Активен», иначе он не войдёт.": {"en":"The password has been changed, but the employee is deactivated — turn on “Active”, otherwise they will not be able to sign in.","ru":"Пароль изменён, но сотрудник отключён — включите «Активен», иначе он не войдёт.","uz":"Parol o‘zgartirildi, lekin xodim o‘chirilgan — «Faol» belgisini yoqing, aks holda u tizimga kira olmaydi."},   // STAFF_EDIT_V1
  "Новый логин действует со следующего входа; открытые входы сотрудника не закрываются.": {"en":"The new login works from the next sign-in; the employee’s open sessions stay open.","ru":"Новый логин действует со следующего входа; открытые входы сотрудника не закрываются.","uz":"Yangi login keyingi kirishdan boshlab ishlaydi; xodimning ochiq seanslari yopilmaydi."},   // STAFF_EDIT_V1
  "Администратор остаётся администратором: «Врачи» добавляет ему приём пациентов, права администратора не снимаются.": {"en":"An administrator stays an administrator: “Doctors” adds seeing patients, and administrator rights are not removed.","ru":"Администратор остаётся администратором: «Врачи» добавляет ему приём пациентов, права администратора не снимаются.","uz":"Administrator administrator bo‘lib qoladi: «Shifokorlar» unga bemorlarni qabul qilishni qo‘shadi, administrator huquqlari olib tashlanmaydi."},   // STAFF_EDIT_V1
```

- [ ] **Step 4: run — PASS**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs server/routes/users.staff-edit.test.js public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs`

- [ ] **Step 5: commit** — `.git/U4_MSG.txt`:

```
STAFF_EDIT_V1: тексты смены логина и пароля — ru/uz/en

Пять фраз в i18n-strings.js: отказы смены логина, предупреждение о
пароле отключённому, подсказки карточки. Заготовка клиентского теста
employees-staff-edit.test.mjs; сервер сверяет свои отказы со словарём.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/i18n-strings.js public/js/admin/__tests__/employees-staff-edit.test.mjs server/routes/users.staff-edit.test.js
git commit -F .git/U4_MSG.txt
```

---

### Task U4.6: карточка шлёт только изменённое

**Files:**
- Modify: `public/js/admin/views/employees.js`
- Modify: `public/js/admin/__tests__/employees-staff-edit.test.mjs`
- Modify: `public/js/admin/__tests__/employees-card-save.test.mjs`, `employees-profile-save.test.mjs`, `employees-softphone-extension.test.mjs`, `employees-inpatient-rates.test.mjs`

Решение по объёму (см. «Риски»): списки ставок (`service_rates`, `referral_rates`, `inpatient_rates`) уходят целиком, как прежде; части имени — по правилу EMPLOYEE_CARD_SAVE_V1 (`sendNames`); специальности — по своему правилу; отметка `assign_extension` — всегда. Остальное — только изменённое. Значения, которые карточка подставляет сама (единственный филиал SOLE_BRANCH_V1, категория «Врачи» из `is_doctor`), сравниваются с хранимым и потому уходят, как уходили.

- [ ] **Step 1: failing test** — дописать в конец `employees-staff-edit.test.mjs`:

```js
test('уходят только изменённые поля: старая дата, категория и процент 150 не уходят и не держат сохранение', async () => {
  const card = await openCard('old.doc');
  setPhone(card, '+998 90 111 22 44');
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  const body = writes[0].body;
  assert.equal(writes[0].method, 'PATCH');
  assert.ok(body.phone.replace(/\D/g, '').endsWith('901112244'), body.phone);
  for (const k of ['hire_date', 'doctor_category', 'employment_type', 'salary_percent', 'salary_fixed', 'salary_type', 'staff_type',
    'role', 'custom_role_code', 'is_active', 'extra_roles', 'working_hours', 'branch_id', 'department_id', 'email',
    'scheduling_mode', 'pbx_extension', 'license_number', 'license_expiry_date', 'specialties', 'specialty',
    'inpatient_referral_pct', 'inpatient_referral_fixed']) {
    assert.ok(!(k in body), k + ' ушло, хотя его не трогали: ' + JSON.stringify(body[k]));
  }
  assert.equal(body.assign_extension, true, 'отметка новой карточки — всегда');
  assert.ok(!toasts.some((t) => /неверно|Неизвестн/.test(t)), 'посторонний отказ: ' + toasts.join(' | '));
});

// Охрана: роль и своя роль клиники уходят вместе (сервер выводит роль из своей роли).
test('«Врачи» у медсестры: роль «Врач» уходит вместе со своей ролью клиники', async () => {
  const card = await openCard('nurse.k');
  await tab(card, 'Должность');
  pick(categorySelect(card), 'doctor');
  await flush();
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  const body = writes[0].body;
  assert.deepEqual([body.staff_type, body.role, body.custom_role_code], ['doctor', 'doctor', '']);
});

// Охрана: новому сотруднику уходит вся карточка (POST), как прежде.
test('новый сотрудник: уходит вся карточка', async () => {
  const card = await openNew();
  type(byPh(card, 'Каюмов'), 'Каюмов');
  type(byPh(card, 'Араббек'), 'Араббек');
  setPhone(card, '+998 90 961 00 04');
  await tab(card, 'Должность');
  pick(categorySelect(card), 'mid_low');
  await flush();
  await tab(card, 'Вход и доступ');
  type(loginInput(card), 'new.nurse');
  type(passwordInputs(card)[0], '1');
  await save(card);
  assert.equal(writes.length, 1, 'новый сотрудник не ушёл');
  assert.deepEqual([writes[0].u, writes[0].method], ['/api/users', 'POST']);
  const body = writes[0].body;
  assert.equal(body.username, 'new.nurse');
  for (const k of ['staff_type', 'role', 'is_active', 'extra_roles', 'hire_date', 'doctor_category', 'working_hours', 'service_rates']) {
    assert.ok(k in body, k + ' не ушло у нового сотрудника');
  }
});
```

- [ ] **Step 2: run — FAIL**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs`
Ожидается: первый тест — `hire_date ушло, хотя его не трогали: "15.01.2020"`. Два охранных теста проходят уже сейчас.

- [ ] **Step 3: implement** — `public/js/admin/views/employees.js`.

3a. После строки

```js
const MONEY_SECTIONS = ['salary', 'services', 'inpatient', 'referral'];
```
вставить
```js

// STAFF_EDIT_V1 (2026-11-02) — КАРТОЧКА СУЩЕСТВУЮЩЕГО СОТРУДНИКА ШЛЁТ ТОЛЬКО ИЗМЕНЁННОЕ.
//
// Прежде save() слал ВСЕ поля, и сервер заново проверял каждое: значение,
// записанное до нынешних правил (дата «15.01.2020», категория «Высшая»,
// процент 150), отказывало всему сохранению сообщением о поле, которого никто
// не трогал, — хотя меняли телефон. Теперь уходит то, что стало не таким,
// каким карточка открылась. Свои правила — у частей имени (employeeSaveGaps →
// sendNames), специальностей (specsAtOpen) и отметки assign_extension; списки
// ставок уходят целиком, как прежде: сервер переписывает список целиком, а
// старого неверного значения в них не бывает (их чистил сам сервер, parseRates).
const OWN_RULE_KEYS = new Set([...NAME_KEYS, 'specialties', 'specialty', 'assign_extension',
    'service_rates', 'referral_rates', 'inpatient_rates']);
function sameSent(a, b) {
    if (a === b) return true;
    const blank = (v) => v == null || v === '';
    if (blank(a) || blank(b)) return blank(a) && blank(b);
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return String(a) === String(b);
}
function changedOnly(payload, opened) {
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
        if (OWN_RULE_KEYS.has(k) || !opened || !(k in opened) || !sameSent(v, opened[k])) out[k] = v;
    }
    return out;
}
```

3b. После строки

```js
    const specsAtOpen = specKey(emp.specialties);
```
вставить
```js
    // STAFF_EDIT_V1 — с чем карточка открылась, в том виде, в каком уходит на сервер
    // (payloadOf ниже); save() шлёт только поля, ставшие не такими (changedOnly).
    // Подставленное самой карточкой — не «как было»: SOLE_BRANCH_V1 вписывает
    // единственный филиал давнему сотруднику без филиала, категорию «Врачи»
    // карточка выводит из is_doctor. Точка отсчёта для них — хранимое, и они
    // уходят, как уходили.
    const openedPayload = isEdit ? JSON.parse(JSON.stringify(payloadOf())) : null;
    if (openedPayload) {
        openedPayload.branch_id = user.branch_id != null && user.branch_id !== '' ? Number(user.branch_id) : null;
        openedPayload.staff_type = user.staff_type || '';
    }
```
(`payloadOf` — объявление функции внутри `openEditor`, поднимается; `emp` к этой строке уже собран.)

3c. Перед строкой `    async function save() {` вставить:

```js
    // STAFF_EDIT_V1 — поля карточки в том виде, в каком они уходят на сервер.
    // Один источник для сохранения (save) и для точки отсчёта «что изменилось»
    // (openedPayload): два списка полей разошлись бы в первый же выпуск.
    function payloadOf() {
        return {
            last_name: emp.last_name.trim(), first_name: emp.first_name.trim(), middle_name: emp.middle_name.trim(),
            phone: emp.phone.trim(), email: emp.email.trim(), staff_type: emp.staff_type, scheduling_mode: emp.scheduling_mode || 'schedulable',
            // CALL_FROM_CRM_V1 — внутренний номер. Пустая строка здесь ОСМЫСЛЕННА:
            // сервер понимает её как «стереть номер» (routes/users.js), поэтому
            // сотрудника можно снять с телефона, не заводя для этого отдельного
            // действия.
            pbx_extension: String(emp.pbx_extension || '').trim(),
            // SOFTPHONE_V1 — номер в поле — назначенный: отметка говорит серверу, что это
            // новая карточка (старая во вкладке до обновления слала выбор «Моя трубка»).
            // Назначит он, только если номер поменял администратор (routes/users.js).
            assign_extension: true,
            // `position` is deliberately NOT sent: the field is gone from the UI,
            // and PATCH only writes keys it receives, so any value an existing
            // record already carries is left untouched rather than blanked.
            department_id: emp.department_id ? Number(emp.department_id) : null,
            specialty: String(emp.specialty || '').trim(), doctor_category: emp.doctor_category || '', hire_date: emp.hire_date || '',
            // MULTI_SPECIALTY_V1 — the whole list; the server takes the first as users.specialty
            specialties: (emp.specialties || []).map((v) => String(v || '').trim()).filter(Boolean)
                .map((name) => ({ name, slug: (SPECIALTY_ROWS.find((r) => r.ru === name) || {}).slug || null })),
            license_number: emp.license_number.trim(), license_expiry_date: emp.license_expiry_date || '',
            branch_id: emp.branch_id ? Number(emp.branch_id) : null, employment_type: emp.employment_type || '', salary_type: emp.salary_type || '',
            salary_fixed: Number(emp.salary_fixed) || 0, salary_percent: Number(emp.salary_percent) || 0, working_hours: JSON.stringify(emp.working_hours || {}),
            service_rates: asArr(emp.service_rates), referral_rates: asArr(emp.referral_rates),
            // INPATIENT_BONUS_V1 — вкладка «Стационар»; пустое поле бонуса — 0.
            inpatient_rates: asArr(emp.inpatient_rates),
            inpatient_referral_pct: Number(emp.inpatient_referral_pct) || 0,
            inpatient_referral_fixed: Number(emp.inpatient_referral_fixed) || 0,
            role: emp.role, custom_role_code: emp.custom_role_code || '', extra_roles: (emp.extra_roles || []).filter(r => r !== emp.role), is_active: !!emp.is_active,
        };
    }

```

3d. В `save()` заменить весь литерал `const payload = { … };` (от `        const payload = {` до закрывающей `        };` — 30 строк, тот же текст, что теперь внутри `payloadOf`) вместе со следующей строкой `        if (String(emp.password).trim()) payload.password = emp.password;` на:

```js
        // STAFF_EDIT_V1 — у существующего сотрудника уходит только изменённое
        // (changedOnly): нетронутое старое значение больше не держит сохранение.
        const full = payloadOf();
        const payload = isEdit ? changedOnly(full, openedPayload) : full;
        // Роль и своя роль клиники — вместе: сервер выводит роль из своей роли
        // (routes/users.js resolveCustomRole), и одна без другой развела бы их.
        if (isEdit && ('role' in payload || 'custom_role_code' in payload)) {
            payload.role = full.role;
            payload.custom_role_code = full.custom_role_code;
        }
        if (String(emp.password).trim()) payload.password = emp.password;
```

3e. Ожидания прежних тестов (нетронутое поле больше не уходит):

`public/js/admin/__tests__/employees-card-save.test.mjs` — заменить
```js
  assert.equal(body.phone, '');
```
на
```js
  assert.ok(!('phone' in body), 'телефон не трогали — не уходит (STAFF_EDIT_V1)');
```
и
```js
  assert.equal(body.staff_type, '');
```
на
```js
  assert.ok(!('staff_type' in body), 'категорию не трогали — не уходит (STAFF_EDIT_V1)');
```
(`assert.equal(body.staff_type, 'doctor');` у демо-врача остаётся: категорию «Врачи» карточка выводит из `is_doctor`, а хранится пустая — она уходит.)

`public/js/admin/__tests__/employees-profile-save.test.mjs` — заменить
```js
  assert.deepEqual([body.booking_days, body.scheduling_mode], [30, 'schedulable']);
```
на
```js
  assert.equal(body.booking_days, 30);
  assert.ok(!('scheduling_mode' in body), 'режим приёма не трогали — не уходит (STAFF_EDIT_V1)');
```

`public/js/admin/__tests__/employees-softphone-extension.test.mjs` — заменить
```js
test('сохранение без правки поля уходит с назначенным номером (сервер ничего не назначит)', async () => {
```
на
```js
test('сохранение без правки поля: номер не уходит вовсе (сервер ничего не назначит)', async () => {
```
и
```js
  assert.equal(writes[0].body.pbx_extension, '108', 'ушёл самовыбранный номер — сохранение назначило бы его');
```
на
```js
  assert.ok(!('pbx_extension' in writes[0].body), 'номер не трогали — не уходит, и самовыбранный не назначится (STAFF_EDIT_V1)');
```

`public/js/admin/__tests__/employees-inpatient-rates.test.mjs` — заменить
```js
  assert.equal(body.inpatient_referral_pct, 5);
```
на
```js
  assert.ok(!('inpatient_referral_pct' in body), 'бонус без правок ушёл (STAFF_EDIT_V1: уходит только изменённое)');
```

- [ ] **Step 4: run — PASS**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs public/js/admin/__tests__/employees-card-save.test.mjs public/js/admin/__tests__/employees-profile-save.test.mjs public/js/admin/__tests__/employees-softphone-extension.test.mjs public/js/admin/__tests__/employees-inpatient-rates.test.mjs public/js/admin/__tests__/employees-rates-mode.test.mjs public/js/admin/__tests__/employees-default-rate.test.mjs public/js/admin/__tests__/employees-rates-honest.test.mjs public/js/admin/__tests__/employees-referral-tab.test.mjs public/js/admin/__tests__/employees-specialties-save.test.mjs public/js/admin/__tests__/employees-managed.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`

Если упадёт другой тест с ожиданием «нетронутое поле в теле» — правка ожидания та же (`!('<поле>' in body)`): не уходит — значит сервер оставит хранимое. Возвращать отправку всех полей нельзя.

- [ ] **Step 5: commit** — `.git/U4_MSG.txt`:

```
STAFF_EDIT_V1: карточка сотрудника шлёт только изменённое

views/employees.js: payloadOf — один источник полей; снимок при
открытии и changedOnly — у существующего сотрудника уходят только
изменённые поля (списки ставок, части имени, специальности — по своим
правилам, как прежде). Старая дата/категория/процент больше не держат
сохранение. Ожидания четырёх тестов: нетронутое поле не уходит.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/employees.js public/js/admin/__tests__/employees-staff-edit.test.mjs public/js/admin/__tests__/employees-card-save.test.mjs public/js/admin/__tests__/employees-profile-save.test.mjs public/js/admin/__tests__/employees-softphone-extension.test.mjs public/js/admin/__tests__/employees-inpatient-rates.test.mjs
git commit -F .git/U4_MSG.txt
```

---

### Task U4.7: поле «Логин» — администратору; отказ под полем

**Files:**
- Modify: `public/js/admin/views/employees.js`
- Modify: `public/js/admin/__tests__/employees-staff-edit.test.mjs`

- [ ] **Step 1: failing tests** — дописать в конец `employees-staff-edit.test.mjs`:

```js
test('логин: администратор правит — уходит изменённый, без пробелов и нижним регистром; другой регистр — не смена', async () => {
  let card = await openCard('nurse.k');
  await tab(card, 'Вход и доступ');
  const inp = loginInput(card);
  assert.ok(inp, 'нет поля «Логин»');
  assert.ok(!isDisabled(inp), 'администратору поле «Логин» закрыто');
  assert.equal(inp.getAttribute('autocomplete'), 'off');
  assert.ok(textOf(card).includes(LOGIN_HINT), 'не сказано, что будет с открытыми входами');
  type(inp, '  Nurse.Karimova ');
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].body.username, 'nurse.karimova');

  card = await openCard('nurse.k');
  await tab(card, 'Вход и доступ');
  type(loginInput(card), 'NURSE.K');
  await save(card);
  assert.equal(writes.length, 1);
  assert.ok(!('username' in writes[0].body), 'тот же логин в другом регистре ушёл сменой');
});

test('логин: отказ сервера — под полем, карточка открыта, тоста нет; правка логина снимает отказ', async () => {
  const card = await openCard('nurse.k');
  await tab(card, 'Вход и доступ');
  type(loginInput(card), 'nurse2');
  nextAnswer = { status: 409, json: { error: { code: 'conflict', message: BRANCH_MSG, field: 'username' } } };
  await save(card);
  assert.equal(writes.length, 1);
  assert.ok(!card.removed, 'карточка закрылась после отказа');
  assert.equal(loginErrorText(card), BRANCH_MSG, 'отказ не под полем «Логин»');
  assert.ok(!toasts.includes(BRANCH_MSG), 'отказ показан тостом, а не под полем');
  type(loginInput(card), 'nurse3');
  assert.equal(loginErrorText(card), null, 'отказ остался после правки логина');
});

// Охрана: поле не открывается шире, чем решено.
test('логин: не-администратору с «Сотрудники: Изменение» и «от имени сотрудника» поле закрыто', async () => {
  const P = await import('../permissions.js');
  window.easymed.state.user = { id: 5, role: 'nurse', extra_roles: [] };
  P.setEffectiveFromRole({ name: 'nurse', permissions: { sections: ['settings'], levels: {}, grants: { settings: 'view', 'settings.employees': 'edit' } } });
  try {
    const card = await openCard('nurse.k');
    await tab(card, 'Вход и доступ');
    assert.ok(isDisabled(loginInput(card)), 'не-администратору логин открыт');
  } finally {
    P.setFullAccess();
    window.easymed.state.user = ADMIN_ME;
  }
  window.easymed.state.user = { ...ADMIN_ME, acting_admin: { id: 9, full_name: 'Петров П.' } };
  try {
    const card = await openCard('nurse.k');
    await tab(card, 'Вход и доступ');
    assert.ok(isDisabled(loginInput(card)), 'от имени сотрудника логин правится');
  } finally { window.easymed.state.user = ADMIN_ME; }
});
```

- [ ] **Step 2: run — FAIL**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs`
Ожидается: `администратору поле «Логин» закрыто` и `отказ не под полем «Логин»` (`null !== '…'`). Охранный тест проходит уже сейчас.

- [ ] **Step 3: implement** — `public/js/admin/views/employees.js`.

3a. После строки

```js
    const readOnly = managed || !acc.canEdit;
```
вставить
```js
    // STAFF_EDIT_V1 — логин существующего сотрудника меняет администратор из своей
    // учётной записи (не «вход как сотрудник»); сервер проверит то же
    // (routes/users.js loginChange). Отказ сервера — под полем «Логин».
    const canRenameLogin = isEdit && acc.admin && !isActingNow() && !readOnly;
    let loginError = '';
    const loginErrorBox = h('div');
    function paintLoginError() {
        clear(loginErrorBox);
        if (loginError) loginErrorBox.appendChild(h('div', { class: 'cpf-err', role: 'alert', 'data-login-error': '' }, Icon('Warning', { size: 13 }), ' ', loginError));
    }
```

3b. Заменить строку поля «Логин»

```js
                grid(field('Логин', (() => { const i = h('input', { type: 'text', value: emp.username, placeholder: 'login', disabled: isEdit }); i.addEventListener('input', () => markDirty({ username: i.value })); ctrls.username = i; return i; })(), { required: true }),
```
на
```js
                // STAFF_EDIT_V1 — логин правит администратор (canRenameLogin). Уходит, только
                // если изменён; отказ сервера (занят, неверный, подключены филиалы) — под полем.
                grid(field('Логин', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, (() => {
                    const i = h('input', { type: 'text', value: emp.username, placeholder: 'login', autocomplete: 'off', disabled: isEdit && !canRenameLogin });
                    i.addEventListener('input', () => { loginError = ''; paintLoginError(); markDirty({ username: i.value }); });
                    ctrls.username = i; return i;
                })(), loginErrorBox), { required: true }),
```

3c. Заменить

```js
            if (!isEdit) {
                body.append(hint('Логин 3–30 символов (латиница, цифры, . _ -). Пароль — любой, длину выбирает клиника.'));
            }
```
на
```js
            if (!isEdit) {
                body.append(hint('Логин 3–30 символов (латиница, цифры, . _ -). Пароль — любой, длину выбирает клиника.'));
            }
            // STAFF_EDIT_V1 — что будет со сменой логина: сеанс держится за сотрудника, не за логин.
            if (canRenameLogin) {
                body.append(hint('Новый логин действует со следующего входа; открытые входы сотрудника не закрываются.'));
            }
```

3d. В `save()` после строки

```js
        if (String(emp.password).trim()) payload.password = emp.password;
```
вставить
```js
        // STAFF_EDIT_V1 — логин: только если изменён — без пробелов и нижним регистром,
        // как его хранит сервер; тот же логин в другом регистре — не смена.
        if (canRenameLogin) {
            const loginNow = String(emp.username || '').trim().toLowerCase();
            if (loginNow !== String(user.username || '').trim().toLowerCase()) payload.username = loginNow;
        }
```

3e. В `catch (e)` функции `save()` перед строкой

```js
            // DOCTOR_PROFILE_V1 (ревью шага 5, №11) — отказ сервера, названный полем
```
вставить
```js
            // STAFF_EDIT_V1 — отказ логину (занят, неверный, подключены филиалы) — под полем «Логин».
            if (e && e.field === 'username') {
                loginError = e.message;
                active = 'access'; renderRail(); renderBody(); paintLoginError();
                return;
            }
```

- [ ] **Step 4: run — PASS**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs public/js/admin/__tests__/employees-card-save.test.mjs public/js/admin/__tests__/employees-managed.test.mjs public/js/admin/__tests__/act-as-employees.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/english-literals-v3120.test.mjs`

- [ ] **Step 5: commit** — `.git/U4_MSG.txt`:

```
STAFF_EDIT_V1: поле «Логин» в карточке — администратору

Администратор (не «от имени сотрудника») правит логин; уходит, только
если изменён, без пробелов и нижним регистром. Отказ сервера — под
полем, карточка остаётся открытой; правка логина снимает отказ.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/employees.js public/js/admin/__tests__/employees-staff-edit.test.mjs
git commit -F .git/U4_MSG.txt
```

---

### Task U4.8: своя карточка без «Новый пароль»; `autocomplete="new-password"`

**Files:**
- Modify: `public/js/admin/views/employees.js`
- Modify: `public/js/admin/__tests__/employees-staff-edit.test.mjs`

- [ ] **Step 1: failing test** — дописать в конец `employees-staff-edit.test.mjs`:

```js
test('своя карточка: поля «Новый пароль» нет, «Сменить пароль» — есть; у чужой и у нового — autocomplete="new-password"', async () => {
  let card = await openCard('boss');
  await tab(card, 'Вход и доступ');
  assert.equal(passwordInputs(card).length, 0, 'своя карточка меняет пароль без текущего');
  assert.ok(buttonWith(card, 'Сменить пароль'), 'кнопка смены своего пароля пропала');
  card = await openCard('nurse.k');
  await tab(card, 'Вход и доступ');
  const [pw] = passwordInputs(card);
  assert.ok(pw, 'у чужой карточки поле пароля пропало');
  assert.equal(pw.getAttribute('autocomplete'), 'new-password', 'браузер подставит сюда сохранённый пароль');
  card = await openNew();
  await tab(card, 'Вход и доступ');
  assert.equal(passwordInputs(card)[0].getAttribute('autocomplete'), 'new-password');
});
```

- [ ] **Step 2: run — FAIL**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs`
Ожидается: `своя карточка меняет пароль без текущего` (`1 !== 0`).

- [ ] **Step 3: implement** — `public/js/admin/views/employees.js`.

3a. Перенести `isSelf` выше: после блока, вставленного в U4.7 (строка `    const canRenameLogin = isEdit && acc.admin && !isActingNow() && !readOnly;`), вставить

```js
    // STAFF_EDIT_V1 — своя ли это карточка: решает поле пароля (renderBody) и окно
    // «Сменить пароль» (ниже). Перенесено сюда из подвала карточки.
    const isSelf = isEdit && selfUserId() != null && String(selfUserId()) === String(user.id);
```
и заменить прежнее определение

```js
    const isSelf = isEdit && selfUserId() != null && String(selfUserId()) === String(user.id);
    // ADMIN_ACT_AS_V1 (R6) — работая от имени сотрудника, его пароль не меняют:
```
на
```js
    // isSelf — выше, рядом с readOnly (STAFF_EDIT_V1).
    // ADMIN_ACT_AS_V1 (R6) — работая от имени сотрудника, его пароль не меняют:
```

3b. Заменить строку поля пароля

```js
                    field(isEdit ? 'Новый пароль (пусто — не менять)' : 'Пароль', (() => { const i = h('input', { type: 'password', value: '', placeholder: '••••••••' }); i.addEventListener('input', () => markDirty({ password: i.value })); ctrls.password = i; return i; })(), { required: !isEdit })),
```
на
```js
                    // STAFF_EDIT_V1 — в СВОЕЙ карточке поля пароля нет: свой пароль меняют кнопкой
                    // «Сменить пароль» с текущим (PATCH без текущего — право администратора на
                    // чужую учётную запись). autocomplete="new-password": браузер не подставит
                    // сюда сохранённый пароль того, кто сидит за компьютером.
                    isSelf ? null : field(isEdit ? 'Новый пароль (пусто — не менять)' : 'Пароль', (() => { const i = h('input', { type: 'password', value: '', placeholder: '••••••••', autocomplete: 'new-password' }); i.addEventListener('input', () => markDirty({ password: i.value })); ctrls.password = i; return i; })(), { required: !isEdit })),
```
(`grid()` отбрасывает `null` — `els.filter(Boolean)`.)

3c. В `save()` заменить

```js
        if (String(emp.password).trim()) payload.password = emp.password;
```
на
```js
        if (!isSelf && String(emp.password).trim()) payload.password = emp.password;   // STAFF_EDIT_V1 — своя карточка пароль не шлёт
```

- [ ] **Step 4: run — PASS**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs public/js/admin/__tests__/password-change.test.mjs public/js/admin/__tests__/act-as-employees.test.mjs public/js/admin/__tests__/employees-card-save.test.mjs public/js/admin/__tests__/password-rule-one-place.test.mjs`

- [ ] **Step 5: commit** — `.git/U4_MSG.txt`:

```
STAFF_EDIT_V1: своя карточка без поля «Новый пароль»

Свой пароль меняется только кнопкой «Сменить пароль» с текущим. У поля
пароля чужой и новой карточки — autocomplete="new-password", браузер
не подставит сохранённый пароль.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/employees.js public/js/admin/__tests__/employees-staff-edit.test.mjs
git commit -F .git/U4_MSG.txt
```

---

### Task U4.9: «Врачи» на карточке администратора не снимают роль администратора

**Files:**
- Modify: `public/js/admin/views/employees.js`
- Modify: `public/js/admin/__tests__/employees-staff-edit.test.mjs`

- [ ] **Step 1: failing test** — дописать в конец `employees-staff-edit.test.mjs`:

```js
test('«Врачи» на карточке администратора: роль остаётся «Администратор», уходит категория врача', async () => {
  const card = await openCard('chief');
  await tab(card, 'Должность');
  assert.ok(textOf(card).includes(ADMIN_DOCTOR_HINT), 'администратору не сказано, что роль останется');
  pick(categorySelect(card), 'doctor');
  await flush();
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  const body = writes[0].body;
  assert.equal(body.staff_type, 'doctor');
  assert.ok(!('role' in body), 'роль ушла — администратор перестал бы быть администратором: ' + body.role);
});
```

- [ ] **Step 2: run — FAIL**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs`
Ожидается: `администратору не сказано, что роль останется`.

- [ ] **Step 3: implement** — `public/js/admin/views/employees.js`.

3a. В `pickCategory` заменить

```js
        if (becomingDoctor && emp.role !== 'doctor') patch.role = 'doctor';
```
на
```js
        // STAFF_EDIT_V1 — администратор, ставший врачом, остаётся администратором: роль
        // не трогается, врачом его делает категория (сервер выводит is_doctor из
        // staff_type, ADMIN_DOCTOR_V1). Прежде «Врачи» молча ставили роль «Врач», и
        // сохранение снимало права администратора.
        if (becomingDoctor && emp.role !== 'doctor' && emp.role !== 'admin') patch.role = 'doctor';
```

3b. В разделе «Должность» заменить

```js
                hint('Врачи получают роль доступа «Врач», попадают в список врачей клиники, и для них открываются разделы Лицензия / Услуги и ставки / Вознаграждение за направления.'),
```
на
```js
                hint('Врачи получают роль доступа «Врач», попадают в список врачей клиники, и для них открываются разделы Лицензия / Услуги и ставки / Вознаграждение за направления.'),
                // STAFF_EDIT_V1 — у администратора «Врачи» роль не меняют (pickCategory).
                ...(emp.role === 'admin' ? [hint('Администратор остаётся администратором: «Врачи» добавляет ему приём пациентов, права администратора не снимаются.')] : []),
```

- [ ] **Step 4: run — PASS**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs public/js/admin/__tests__/employees-card-save.test.mjs public/js/admin/__tests__/admin-doctor-local.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`

- [ ] **Step 5: commit** — `.git/U4_MSG.txt`:

```
STAFF_EDIT_V1: «Врачи» не снимают роль администратора

На карточке администратора категория «Врачи» оставляет роль
«Администратор» и делает его врачом признаком (ADMIN_DOCTOR_V1);
подсказка в «Должности» говорит это прямо.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/employees.js public/js/admin/__tests__/employees-staff-edit.test.mjs
git commit -F .git/U4_MSG.txt
```

---

### Task U4.10: пароль отключённому — предупреждение (окно и карточка)

**Files:**
- Modify: `public/js/admin/password-change.js`
- Modify: `public/js/admin/views/employees.js`
- Modify: `public/js/admin/__tests__/employees-staff-edit.test.mjs`

- [ ] **Step 1: failing tests** — дописать в конец `employees-staff-edit.test.mjs`:

```js
test('окно «Сменить пароль»: отключённому — предупреждение «включите «Активен»», включённому — как прежде', async () => {
  document.body.children.length = 0;
  writes.length = 0;
  toasts.length = 0;
  nextAnswer = { status: 200, json: { user: {}, password_inactive: true } };
  openEmployeePasswordModal({ id: 4 });
  let modal = topModal();
  for (const inp of tags(modal, 'input')) inp.value = '1';
  buttonWith(modal, 'Сохранить').click();
  await flush();
  assert.equal(writes.at(-1).u, '/api/users/4');
  assert.ok(toasts.includes(INACTIVE_MSG), 'нет предупреждения: ' + toasts.join(' | '));
  assert.equal(toastEl.dataset.kind, 'warn');

  openEmployeePasswordModal({ id: 4 });
  modal = topModal();
  for (const inp of tags(modal, 'input')) inp.value = '2';
  buttonWith(modal, 'Сохранить').click();
  await flush();
  assert.equal(toasts.at(-1), 'Пароль сотрудника изменён.');
  assert.equal(toastEl.dataset.kind, 'ok');
});

test('карточка: пароль и снятый «Активен» в одном сохранении — предупреждение вместо «сохранён»', async () => {
  const card = await openCard('nurse.k');
  await tab(card, 'Вход и доступ');
  type(passwordInputs(card)[0], '1');
  const active = activeCheckbox(card);
  active.checked = false;
  active.dispatchEvent({ type: 'change' });
  nextAnswer = { status: 200, json: { user: {}, password_inactive: true } };
  await save(card);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].body.password, writes[0].body.is_active], ['1', false]);
  assert.ok(toasts.includes(INACTIVE_MSG), 'нет предупреждения: ' + toasts.join(' | '));
  assert.ok(!toasts.includes('Сотрудник сохранён'), 'сказали «сохранён» вместо предупреждения');
});
```

- [ ] **Step 2: run — FAIL**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs`
Ожидается: оба — `нет предупреждения: …`.

- [ ] **Step 3: implement**

3a. `public/js/admin/password-change.js` — после строки

```js
export const MIN_PASSWORD_LENGTH = 1;
```
вставить
```js

/** STAFF_EDIT_V1 — пароль поставлен отключённому сотруднику (ответ сервера password_inactive): войти он не сможет. */
export const INACTIVE_PASSWORD_WARNING = 'Пароль изменён, но сотрудник отключён — включите «Активен», иначе он не войдёт.';
```

в `send()` заменить
```js
    if (res.ok) return { ok: true };
```
на
```js
    if (res.ok) return { ok: true, inactive: !!(json && json.password_inactive) };   // STAFF_EDIT_V1
```

в `openPasswordModal` заменить
```js
            close();
            toast(done, 'ok');
```
на
```js
            close();
            // STAFF_EDIT_V1 — сотрудник отключён: «Пароль изменён» умолчало бы о главном.
            if (res.inactive) toast(INACTIVE_PASSWORD_WARNING, 'warn');
            else toast(done, 'ok');
```

3b. `public/js/admin/views/employees.js` — импорт заменить

```js
import { openEmployeePasswordModal, openChangeOwnPasswordModal } from '../password-change.js';   // PASSWORD_CHANGE_V2
```
на
```js
import { openEmployeePasswordModal, openChangeOwnPasswordModal, INACTIVE_PASSWORD_WARNING } from '../password-change.js';   // PASSWORD_CHANGE_V2 · STAFF_EDIT_V1 — предупреждение отключённому
```

в `save()` заменить
```js
            if (isEdit) await api('/' + user.id, { method: 'PATCH', body: JSON.stringify(payload) });
            else await api('', { method: 'POST', body: JSON.stringify({ ...payload, username: emp.username.trim() }) });
```
на
```js
            let saved = null;   // STAFF_EDIT_V1 — ответ PATCH: password_inactive
            if (isEdit) saved = await api('/' + user.id, { method: 'PATCH', body: JSON.stringify(payload) });
            else await api('', { method: 'POST', body: JSON.stringify({ ...payload, username: emp.username.trim() }) });
```
и
```js
            toast('Сотрудник сохранён', 'ok'); close(); await paint(root);
```
на
```js
            // STAFF_EDIT_V1 — пароль поставлен, а сотрудник отключён: сказать, что он не войдёт.
            if (saved && saved.password_inactive) toast(INACTIVE_PASSWORD_WARNING, 'warn');
            else toast('Сотрудник сохранён', 'ok');
            close(); await paint(root);
```

- [ ] **Step 4: run — PASS**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs public/js/admin/__tests__/password-change.test.mjs public/js/admin/__tests__/employees-rates-mode.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/english-literals-v3120.test.mjs`

- [ ] **Step 5: commit** — `.git/U4_MSG.txt`:

```
STAFF_EDIT_V1: пароль отключённому — предупреждение

Окно «Сменить пароль» и сохранение карточки, получив password_inactive,
говорят: «Пароль изменён, но сотрудник отключён — включите «Активен»,
иначе он не войдёт.» вместо «изменён»/«сохранён».

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/password-change.js public/js/admin/views/employees.js public/js/admin/__tests__/employees-staff-edit.test.mjs
git commit -F .git/U4_MSG.txt
```

---

### Task U4.11: прогон затронутого

**Files:** —

- [ ] **Step 1: сервер**

`node --experimental-vm-modules --test server/services/auth.test.js server/services/auth.login-locks.test.js server/services/admin-rows-grantable.test.js server/middleware/act-as.test.js server/routes/auth.test.js server/routes/users.test.js server/routes/users.staff-edit.test.js server/routes/users.softphone.test.js server/routes/users.inpatient.test.js server/routes/users.public-profile.test.js server/routes/users.specialties.test.js server/routes/act-as.test.js server/routes/password-change-v2.test.js server/routes/licence-gate.test.js server/routes/data-transfer.test.js server/routes/staff-sync-readonly.test.js server/routes/branch-sync.test.js`

- [ ] **Step 2: клиент**

`node --experimental-vm-modules --test public/js/admin/__tests__/employees-staff-edit.test.mjs public/js/admin/__tests__/employees-card-save.test.mjs public/js/admin/__tests__/employees-default-rate.test.mjs public/js/admin/__tests__/employees-inpatient-rates.test.mjs public/js/admin/__tests__/employees-managed.test.mjs public/js/admin/__tests__/employees-profile-save.test.mjs public/js/admin/__tests__/employees-rates-honest.test.mjs public/js/admin/__tests__/employees-rates-mode.test.mjs public/js/admin/__tests__/employees-referral-tab.test.mjs public/js/admin/__tests__/employees-softphone-extension.test.mjs public/js/admin/__tests__/employees-specialties-save.test.mjs public/js/admin/__tests__/act-as-employees.test.mjs public/js/admin/__tests__/admin-rows-grantable.test.mjs public/js/admin/__tests__/admin-doctor-local.test.mjs public/js/admin/__tests__/password-change.test.mjs public/js/admin/__tests__/password-rule-one-place.test.mjs public/js/admin/__tests__/doctor-profile-save.test.mjs public/js/admin/__tests__/week-hours.test.mjs public/js/admin/__tests__/table-setup.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/english-literals-v3120.test.mjs`

Ожидается: всё зелёное. Коммита нет (полный прогон ru/en — задача R).

---

## Риски / что проверить исполнителю

1. **«Подключены филиалы» = установка в группе филиалов.** Сервер знает только `data/branch-sync.json` (`readPairing`: роль `main` или `secondary`) — так же решает экран «Филиалы». Главная клиника пишет этот файл, когда выпускает ключ, ещё до подключения первого филиала, и держит его до «Отвязать». Значит, на главной логин не меняется с момента выпуска ключа. Другого признака «филиал реально подключён» в коде нет.
2. **«Только изменённое» — с исключениями, намеренно:** списки ставок уходят целиком (сервер переписывает список целиком, `parseRates` их уже чистил; четыре файла тестов на этом стоят), части имени — по `sendNames`, специальности — по `specsAtOpen`, `assign_extension` — всегда; роль и `custom_role_code` уходят парой; подставленное самой карточкой (единственный филиал, «Врачи» из `is_doctor`) уходит, как раньше. Если упадёт ещё какой-нибудь тест с ожиданием «нетронутое поле в теле» — поменять ожидание на «не уходит», а не возвращать отправку всех полей.
3. **Сервер `withoutUnchanged`:** если `staff_type` равен хранимому, `is_doctor` из него больше не выводится (кроме случая, когда `is_doctor` прислан рядом). Старая вкладка, присылавшая `staff_type: ''` врачу с `is_doctor = 1`, больше не снимет признак врача — это исправление, но прогоните `users*.test.js` (U4.11). `pbx_extension` намеренно не в списке.
4. **Блокировки** — `Map` на уровне модуля, общая для тестов одного файла: у каждого теста свои логины (уже так написано). Предел попыток на адрес (`routes/auth.js`, 10 ошибок в минуту на компьютер) сброс пароля не снимает — так задумано; блокировка живёт меньше минуты. Сверх замысла: смена логина снимает и блокировку нового логина.
5. **Сервер по-прежнему принимает `PATCH {password}` на свою учётную запись без текущего пароля** — это закреплено `password-change-v2.test.js`; замысел просил изменить только экран. Если владелец хочет и серверное правило — это отдельная задача.
6. **Импорт из Excel** сопоставляет сотрудников по логину (`section-import-export.js` `matchField: 'username'`) и шлёт `username` в PATCH: если логин совпадает (в любом регистре) — ничего не меняется и отказа нет. Но выгрузка, сделанная ДО смены логина, при повторном импорте заведёт сотрудника со старым логином как нового — сказать владельцу.
7. **Автозаполнение:** у «Логина» `autocomplete="off"` (Chrome иногда это игнорирует). Если браузер подставит логин администратора, сервер ответит «Такой логин уже занят.» под полем — молча логин не сменится.
8. **Привязки правок:** `server/app.js` (строка `app.use('/api/users', …)`) и `i18n-strings.js` (строка `"Такой логин уже занят."`) могут трогать и другие задачи выпуска — правки привязаны к тексту; если якорь сдвинулся, ищите по тексту. Старая карточка `views/employee-editor.js` (section-crud) этой задачей не трогается.
9. **Гонка UNIQUE в тесте** воспроизводится триггером `BEFORE UPDATE OF username`: UPDATE в PATCH теперь всегда несёт `username` в SET (`COALESCE(?, username)`), поэтому `AFTER UPDATE OF … username` (мигр. 122, источник направлений врача) срабатывает на каждой правке — как и раньше из-за `full_name`; поведение не меняется.

## Проверка владельцем (вручную)

1. «Сотрудники» → карточка медсестры → «Вход и доступ» → поменять логин → сохранить. Войти под новым логином; старый не пускает.
2. У сотрудника со старой датой приёма или категорией поменять телефон — сохраняется без ошибки.
3. Пять раз неверный пароль сотрудника → «Сменить пароль» в его карточке → он сразу входит с новым. Отключённому — жёлтое предупреждение «включите «Активен»».
4. В своей карточке поля «Новый пароль» нет; у администратора выбор «Врачи» оставляет роль «Администратор».
