# «Роли» показывают правду, «Сохранить роль» пишет тронутое (ROLES_SAVE_TRUTH_V1) — план

> **Для исполнителя:** задачи по порядку, каждая — TDD: падающий тест → запуск (красный) →
> код → запуск (зелёный) → коммит. Шаги отмечены `- [ ]`.

**Цель:** экран «Роли» рисует то, что у роли есть СЕЙЧАС (правда сервера вместо
догадки из старой галочки раздела), а «Сохранить роль» пишет в роль только то,
что тронули; уже расширенные роли получают плашку «Проверьте права этой роли»;
прослушивание записей объясняет себя словами.

**Архитектура:** новый RPC `role_effective_grants` — сервер считает уровень
каждой строки справочника с серверными воротами теми же воротами, что пускают
человека. Экран накладывает его на вывод из старых полей, запоминает показанное
при открытии (`initial`), и `collectGrants` пишет только записанное, тронутое и
сдвинутое тронутым разделом; старые поля меняются только там, где сдвинулся их
вывод. Миграция 230 записывает в `role_grant_reviews` ключи выше стандарта
основы — прав не меняет.

**Стек:** Node 24 ESM, better-sqlite3, express; клиент — vanilla JS без сборки;
тесты — `node --test` (фальшивая DOM, настоящий сервер через `createApp`).

**Спецификация:** `docs/specs/2026-09-29-roles-save-truth-design.md` (49aec77) — договор.

---

## Что проверено до плана (и где спецификация уточнена)

Прототип алгоритма прогнан на свежей базе и, только на чтение, на базах dev и
тестовой клиники :8712: пустое сохранение не меняет ни одной роли, тронутое окно
или действие добавляет ровно себя.

1. **Разделы в ответе RPC.** Спецификация: «Разделы и окна-маршруты оболочки
   серверных ворот не имеют и в ответ не входят». Единственный раздел с
   воротами — `procurement` (FALLBACK_FN). Его в ответ НЕ включаем: иначе
   пустое сохранение переписывало бы старый уровень `inventory` (врач с
   `inventory: editor` → `viewer`). Раздел выводится, как и прежде.
2. **Старые поля «как сейчас» теряют сведения.** `legacyFromGrants` на свежей
   базе не возвращает записанное у 7 ролей из 10: «Кабинет врача» — строка
   «Нет / Просмотр», и `consultation: editor` возвращается `viewer`;
   «Пациенты: Изменение» дописывает `registration` врачу, кассе, медсестре,
   главному врачу и старшей медсестре; `queue` — лаборанту и главному врачу;
   `crm: admin` → `editor`. Раньше окна врача спасала запись матрицы целиком;
   теперь нетронутые окна не пишутся, и «viewer» отнял бы у врача
   «Мои визиты: Изменение». Поэтому `legacyFromGrants(shown, prev, initial)`:
   старый ключ меняется, только если его вывод сдвинулся от открытия; остальные
   — ровно как записаны. Это и держит «тест 2: sections/levels те же».
3. **Тронутый раздел сдвигает свою «семью».** Если правка раздела сдвинула его
   старый ключ, оболочка и сервер заново выведут из него НЕЗАПИСАННЫЕ строки:
   открыли «Отчёты» лаборанту и отметили одну группу — сервер отдал бы все группы
   («Отчёты» выданы — видны все); открыли «Кабинет врача» медсестре — все окна
   врача стали бы «Просмотром»; экран при этом показывал «Нет». Поэтому при
   сдвиге старого ключа пишутся все строки разделов с этим ключом — такими,
   какими их видно (кроме строк «только администратор»). Тест 3 («тронул один
   ключ — добавился ровно он») — для окон и действий; раздел добавляет свою
   семью, это проверено отдельно.
4. **Плашка** показывает строку проверки, только пока ключ стоит так, как его
   нашла миграция (приём `roles-review.js`: изменённое руками — уже решено);
   «Убрать эти права» перечитывает роль и снимает только такие ключи.
5. **Реестр `role_grant_reviews`:** `write.grant: 'settings.roles'` — читать
   может «Роли: Просмотр» (readGrantAllows), отмечать решение — администратор и
   «Роли: Изменение». Таблица — в `MAIN_CLINIC_TABLES` («живёт в главном здании»).
6. **Переводы:** в словарь идут и новые фразы сервера и EasyPhone (у EasyPhone
   нет переключателя языка, фразы там русские, но запись в словаре есть).
7. На dev и :8712 миграция 230 ничего не отмечает: там роли ещё не пересохраняли.
   Номер 230 свободен и в дереве, и в `origin/main` (последняя там — 219).

## Правила работы

- Ветка `feat/stock-own-shelf-suppliers-vat`. В индекс — только названные файлы.
- Перед КАЖДЫМ коммитом: `git log -3 --oneline`, `git status --short`,
  `git diff --cached --name-only` — пусто (иначе ждать, чужое не трогать).
- Общие файлы (`public/js/admin/i18n-strings.js`, `server/services/rpc/index.js`,
  `server/services/control/gate.js`, `public/js/admin.js`) — только свои куски:
  метка `ROLES_SAVE_TRUTH_V1` на добавленной строке каждого куска, затем
  ```
  git diff -U0 -- F | node "$SCRATCH/keep-hunks-v2.mjs" ROLES_SAVE_TRUTH_V1 > own.patch
  git apply --cached --check --unidiff-zero own.patch && git apply --cached --unidiff-zero own.patch
  git diff --cached -- F      # мой кусок на месте
  git diff -U0 -- F           # остались только чужие
  ```
  (`$SCRATCH` — папка scratchpad сессии.) Нет чужих правок в файле — обычный `git add -- F`.
- Никаких `checkout -- / restore / stash / reset / switch / merge`. Файлы — LF.
- Тесты — `node --test <файлы>`, не папкой. Сообщения коммитов — по-русски,
  хвост `(ROLES_SAVE_TRUTH_V1)` и строка `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Словарь: все мои записи — один блок `// ROLES_SAVE_TRUTH_V1 … — BEGIN … END`
  сразу после записи `"Журнал звонков этого человека в карточке заявки: …"`, у
  каждой записи хвост `// ROLES_SAVE_TRUTH_V1`. Не в конце файла: там дописывают
  другие сессии, и соседние вставки склеились бы в один кусок.

## Файлы

| Файл | Что |
|---|---|
| `server/services/rpc/roles-effective.js` (новый) | `role_effective_grants`, `effectiveGrantsOf`, `pseudoUserOfRole` |
| `server/services/rpc/roles-effective.test.js` (новый) | тест 1 |
| `server/services/rpc/index.js` | регистрация RPC |
| `server/services/control/gate.js` | `READ_ONLY_RPCS` |
| `server/services/gate-fallbacks.test.js` | исключение для `effectiveLevel(…, row.key, …)` |
| `public/js/admin/roles-matrix.js` | `collectGrants(…, { initial })`, `legacyFromGrants(…, initial)` |
| `public/js/admin/__tests__/roles-save-collect.test.mjs` (новый) | чистая логика сбора |
| `public/js/admin/views/roles-editor.js` | правда сервера, `initial`, только чтение при сбое, плашка |
| `public/js/admin/__tests__/roles-editor.test.mjs` | сервер-заглушка отвечает RPC; договор записи обновлён |
| `public/js/admin/__tests__/roles-save-truth.test.mjs` (новый) | тесты 2–5 на настоящем сервере |
| `server/db/migrations/230_role_grant_reviews.sql` + `230.test.js` (новые) | тест 6, сервер |
| `server/db/schema-registry.js` | `role_grant_reviews`, `MAIN_CLINIC_TABLES` |
| `public/js/admin/views/roles-grant-review.js` + `__tests__/roles-grant-review.test.mjs` (новые) | тест 6, плашка |
| `server/services/rpc/telephony.js` + `telephony.test.js` | `can_listen` |
| `public/js/admin/views/crm.js`, `__tests__/crm-harness.mjs`, `__tests__/crm-lead-calls.test.mjs` (новый) | карточка заявки |
| `phone/index.js`, `phone/index.test.js`, `phone/public/app.js`, `phone/public/index.html`, `phone/app.test.js` (новый) | EasyPhone |
| `public/js/shared/permission-catalog.js` | «Журнал звонков» |
| `public/js/admin/i18n-strings.js` | переводы |
| штампы: `roles-editor.js` (`roles-matrix.js?v=rm7`), `settings-hub.js` (`roles-editor.js?v=roles3`, в задаче 6 — `roles4`), `admin.js` (`settings-hub.js?v=rst1`, в задаче 6 — `rst2`; `crm.js?v=rst1`) | кеш браузера |

---

### Задача 1. RPC `role_effective_grants` (тест 1)

**Файлы:** создать `server/services/rpc/roles-effective.js`,
`server/services/rpc/roles-effective.test.js`; изменить
`server/services/rpc/index.js`, `server/services/control/gate.js`,
`server/services/gate-fallbacks.test.js`, `public/js/admin/i18n-strings.js`.

- [ ] **Шаг 1. Падающий тест** `server/services/rpc/roles-effective.test.js`:

```js
// ROLES_SAVE_TRUTH_V1 (2026-09-29) — role_effective_grants: что у роли есть
// СЕЙЧАС по каждой строке справочника с серверными воротами (спецификация
// docs/specs/2026-09-29-roles-save-truth-design.md, «Тесты», п. 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { roleEffectiveGrants, effectiveGrantsOf } from './roles-effective.js';
import { customRoleCreate } from './custom-roles.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { fallbackLevel } from '../gate-fallbacks.js';
import { catalogRows } from '../../../public/js/shared/permission-catalog.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const NURSE = { id: 2, role: 'nurse', extra_roles: [] };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin');
  ins.run(2, 'nurse1', 'x', 'nurse');
  return db;
}
function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const levelsOf = (db, role) => roleEffectiveGrants(db, { role }, ADMIN).levels;

test('оператор колл-центра: «Видит все заявки» — нет, прослушивание — да, журнал — просмотр', () => {
  const db = fresh();
  try {
    const l = levelsOf(db, 'callcenter');
    assert.equal(l['crm.all'], 'none', 'экран снова нарисует оператору чужие заявки');
    assert.equal(l['crm.recording'], 'edit');
    assert.equal(l['crm.calls'], 'view');
  } finally { db.close(); }
});

test('регистратор: измерения, назначения, отметки и выписка стационара и crm.all — нет', () => {
  const db = fresh();
  try {
    const l = levelsOf(db, 'registrar');
    for (const k of ['inpatient.vitals', 'inpatient.prescriptions', 'inpatient.marks', 'inpatient.discharge', 'crm.all']) {
      assert.equal(l[k], 'none', k + ': экран снова раздаст регистратуре то, чего ворота не дают');
    }
  } finally { db.close(); }
});

test('медсестра: измерения — изменение', () => {
  const db = fresh();
  try { assert.equal(levelsOf(db, 'nurse')['inpatient.vitals'], 'edit'); } finally { db.close(); }
});

test('своя роль на основе оператора — ровно как оператор', () => {
  const db = fresh();
  try {
    customRoleCreate(db, { code: 'senior-op', name: 'Старший оператор', base_role: 'callcenter' }, ADMIN);
    assert.deepEqual(levelsOf(db, 'senior-op'), levelsOf(db, 'callcenter'));
  } finally { db.close(); }
});

test('своя роль на основе администратора — верхние уровни, пока ключ не настроен; своё «Нет» — нет', () => {
  const db = fresh();
  try {
    customRoleCreate(db, { code: 'deputy', name: 'Заместитель', base_role: 'admin' }, ADMIN);
    const byKey = new Map(catalogRows().map((r) => [r.key, r]));
    for (const [k, v] of Object.entries(levelsOf(db, 'deputy'))) {
      const levels = byKey.get(k).levels;
      assert.equal(v, levels[levels.length - 1], k + ': у роли на основе администратора не верхний уровень');
    }
    setGrants(db, 'deputy', { 'crm.all': 'none' });
    assert.equal(levelsOf(db, 'deputy')['crm.all'], 'none', 'своё «Нет» роли на основе администратора не прочиталось');
  } finally { db.close(); }
});

test('закрытый раздел даёт «Нет» внутри; записанный уровень — как записан, не выше уровней строки', () => {
  const db = fresh();
  try {
    setGrants(db, 'nurse', { inpatient: 'none' });
    const l = levelsOf(db, 'nurse');
    for (const k of ['inpatient.vitals', 'inpatient.marks', 'inpatient.services', 'inpatient.history']) assert.equal(l[k], 'none', k);
    setGrants(db, 'lab', { 'crm.all': 'delete', 'inpatient.vitals': 'view' });
    const lab = levelsOf(db, 'lab');
    assert.equal(lab['crm.all'], 'edit', 'уровень выше строки не срезан до её уровней');
    assert.equal(lab['inpatient.vitals'], 'view', 'записанный уровень не прочитался');
  } finally { db.close(); }
});

test('кто спрашивает: без «Ролей» — 403, с «Роли: Просмотр» — ответ; без входа — 401; нет роли — 404/400', () => {
  const db = fresh();
  try {
    assert.throws(() => roleEffectiveGrants(db, { role: 'callcenter' }, NURSE), (e) => e.status === 403);
    setGrants(db, 'nurse', { 'settings.roles': 'view' });
    assert.equal(roleEffectiveGrants(db, { role: 'callcenter' }, NURSE).levels['crm.all'], 'none');
    assert.throws(() => roleEffectiveGrants(db, { role: 'callcenter' }, null), (e) => e.status === 401);
    assert.throws(() => roleEffectiveGrants(db, { role: 'nobody' }, ADMIN), (e) => e.status === 404);
    assert.throws(() => roleEffectiveGrants(db, {}, ADMIN), (e) => e.status === 400);
  } finally { db.close(); }
});

test('в ответе — ровно строки с серверными воротами, без разделов и маршрутов; RPC — чистое чтение', () => {
  const db = fresh();
  try {
    const pseudo = { id: 0, role: 'nurse', extra_roles: [], custom_role_code: null };
    const want = catalogRows()
      .filter((r) => r.kind !== 'section' && !r.locked && fallbackLevel(db, pseudo, r.key, 'all') !== null)
      .map((r) => r.key).sort();
    assert.deepEqual(Object.keys(levelsOf(db, 'nurse')).sort(), want);
    for (const k of ['crm.all', 'inpatient.vitals', 'custdev.rate', 'reports.revenue', 'settings.roles', 'cashier.lines']) assert.ok(want.includes(k), k);
    for (const k of ['procurement', 'patients', 'patients.list', 'doctor.visits', 'mar.inpatient']) assert.ok(!want.includes(k), k + ' — без серверных ворот');
    assert.equal(typeof getRpc('role_effective_grants'), 'function');
    assert.equal(isReadOnlyRpc('role_effective_grants'), true, 'при запертой лицензии «Роли» не откроются');
    assert.deepEqual(effectiveGrantsOf(db, 'nurse'), levelsOf(db, 'nurse'));
  } finally { db.close(); }
});
```

- [ ] **Шаг 2. Запуск — красный.** `node --test server/services/rpc/roles-effective.test.js`
  → `Cannot find module …/roles-effective.js`.

- [ ] **Шаг 3. Код** `server/services/rpc/roles-effective.js`:

```js
// ROLES_SAVE_TRUTH_V1 (2026-09-29) — ЧТО У РОЛИ ЕСТЬ СЕЙЧАС, СЛОВАМИ СЕРВЕРА.
//
// Владелец: «Yes, fix it» — экран «Роли» показывает то, что у роли есть
// сейчас, а «Сохранить роль» меняет только то, что тронули
// (docs/specs/2026-09-29-roles-save-truth-design.md).
//
// ЧТО БЫЛО. Экран рисовал `{...grantsFromLegacy(perms), ...perms.grants}`: у
// ключа, который роль не настраивала, уровень ВЫВОДИЛСЯ из старой галочки
// раздела («раздел выдан — внутри всё»). А сервер для такого ключа пускает по
// списку ролей в коде (gate-fallbacks.js). Первое же «Сохранить роль» писало
// догадку экрана в базу настоящим правом: оператор колл-центра получал
// `crm.all` и читал чужие заявки, регистратура — измерения стационара.
//
// ЧТО ЗДЕСЬ. Для каждой строки справочника с серверными воротами
// (fallbackLevel(...) !== null) — наивысший уровень строки, который пускают те
// же ворота, что пустят человека с этой ролью:
//   • ключ записан у роли — записанный уровень, с правилом «закрытый раздел
//     закрывает всё» (grants.js);
//   • не записан — то, что дают ворота по списку ролей основы (fallbackLevel,
//     режим 'all': у уровня с несколькими воротами засчитан тот, что пускают ВСЕ);
//   • своя роль на основе администратора — администратор проходит, пока его
//     роль ключ не настроила.
// Разделы и окна-маршруты оболочки в ответ не входят: их экран выводит, как и
// прежде, тем же выводом, что оболочка. Единственный раздел с воротами —
// «Закупки» (FALLBACK_FN) — тоже: его уровень пишется в старый ключ
// `inventory`, и правда ворот вместо вывода переписала бы его при пустом
// сохранении.
import { grantAllowsAdminOr, effectiveLevel } from '../grants.js';
import { fallbackLevel } from '../gate-fallbacks.js';
import { VALID_ROLES } from '../roles.js';
import { catalogRows } from '../../../public/js/shared/permission-catalog.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const RANK = { none: 0, view: 1, edit: 2, delete: 3 };

function customRoleOf(db, code) {
  try { return db.prepare('SELECT code, base_role FROM custom_roles WHERE code = ?').get(code) || null; }
  catch { return null; }
}

/** Человек «с этой ролью»: штатная роль — она сама; своя роль клиники — основа и код. */
export function pseudoUserOfRole(db, role) {
  const custom = customRoleOf(db, role);
  return custom
    ? { id: 0, role: custom.base_role, extra_roles: [], custom_role_code: custom.code }
    : { id: 0, role, extra_roles: [], custom_role_code: null };
}

// Уровень, срезанный до тех, что у строки есть: «Удаление» у строки
// «Нет / Изменение» — это «Изменение».
function clampToRow(row, lvl) {
  let best = 'none';
  for (const l of row.levels || ['none', 'view']) {
    if ((RANK[l] || 0) <= (RANK[lvl] || 0) && (RANK[l] || 0) >= (RANK[best] || 0)) best = l;
  }
  return best;
}

/** { ключ: уровень } — что у роли есть сейчас по каждой строке с серверными воротами. */
export function effectiveGrantsOf(db, role) {
  const pseudo = pseudoUserOfRole(db, role);
  const levels = {};
  for (const row of catalogRows()) {
    if (row.kind === 'section' || row.locked) continue;
    const standard = fallbackLevel(db, pseudo, row.key, 'all');
    if (standard === null) continue;   // маршрут оболочки — серверных ворот нет
    levels[row.key] = clampToRow(row, effectiveLevel(db, pseudo, row.key, standard));
  }
  return levels;
}

/** args: { role } → { levels }. Спрашивает тот, кто открывает «Роли». */
export function roleEffectiveGrants(db, args, user) {
  if (!user) throw new RpcError('Войдите в систему.', 401);
  if (!grantAllowsAdminOr(db, user, 'settings.roles', 'view')) {
    throw new RpcError('Права ролей видят администратор и роль с «Роли: Просмотр».', 403);
  }
  const role = String((args && args.role) || '').trim();
  if (!role) throw new RpcError('Не указана роль.', 400);
  if (!VALID_ROLES.includes(role) && !customRoleOf(db, role)) throw new RpcError('Такой роли нет.', 404);
  return { levels: effectiveGrantsOf(db, role) };
}
```

`server/services/rpc/index.js` (общий файл, метка на каждой вставке) — после
строки импорта `customRoleCreate`:

```js
import { roleEffectiveGrants } from './roles-effective.js';   // ROLES_SAVE_TRUTH_V1 — что у роли есть сейчас
```

и после `custom_role_create: …`:

```js
  // ROLES_SAVE_TRUTH_V1 — «Роли»: что у роли есть сейчас по строкам с серверными
  // воротами (правда сервера вместо догадки экрана). Чистое чтение (READ_ONLY_RPCS).
  role_effective_grants:    (db, args, user) => roleEffectiveGrants(db, args, user),
```

`server/services/control/gate.js`, в конец `READ_ONLY_RPCS` (после `'stock_pending_count',`):

```js
  // ROLES_SAVE_TRUTH_V1 — «Роли»: что у роли есть сейчас. Чистое чтение: экран
  // прав открывается и при просроченной лицензии, только ничего не сохраняет.
  'role_effective_grants',
```

`server/services/gate-fallbacks.test.js`, в `ALLOW` после строк `services/role-guard.js`:

```js
  // ROLES_SAVE_TRUTH_V1 — role_effective_grants: уровень каждой строки с воротами, теми же воротами.
  'services/rpc/roles-effective.js|effectiveLevel|row.key': { n: 1, why: 'role_effective_grants: что у роли есть сейчас — effectiveLevel по каждой строке справочника с fallbackLevel !== null' },
```

Словарь (`i18n-strings.js`) — новый блок сразу после записи
`"Журнал звонков этого человека в карточке заявки: …"`:

```js
  // ROLES_SAVE_TRUTH_V1 — «Роли» показывают правду; «Сохранить роль» пишет тронутое — BEGIN
  "Права ролей видят администратор и роль с «Роли: Просмотр».": {"en":"Role permissions are visible to the administrator and to a role with «Roles: View».","ru":"Права ролей видят администратор и роль с «Роли: Просмотр».","uz":"Rol huquqlarini administrator va «Rollar: Ko'rish» huquqi bor rol ko'radi."},   // ROLES_SAVE_TRUTH_V1
  "Не указана роль.": {"en":"No role is given.","ru":"Не указана роль.","uz":"Rol ko'rsatilmagan."},   // ROLES_SAVE_TRUTH_V1
  "Такой роли нет.": {"en":"There is no such role.","ru":"Такой роли нет.","uz":"Bunday rol yo'q."},   // ROLES_SAVE_TRUTH_V1
  // ROLES_SAVE_TRUTH_V1 — END
```

- [ ] **Шаг 4. Запуск — зелёный.**
  `node --test server/services/rpc/roles-effective.test.js server/services/gate-fallbacks.test.js public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs`

- [ ] **Шаг 5. Коммит.** `roles-effective.js`, `roles-effective.test.js`,
  `gate-fallbacks.test.js` — `git add --`; `rpc/index.js`, `control/gate.js`,
  `i18n-strings.js` — своими кусками. Сообщение:
  «Роли: RPC role_effective_grants — что у роли есть сейчас по строкам с серверными воротами, теми же воротами; чистое чтение (ROLES_SAVE_TRUTH_V1)».

### Задача 2. Стенд «открыл и сохранил» на настоящем сервере (тесты 2–5) — сначала красный

**Файл:** создать `public/js/admin/__tests__/roles-save-truth.test.mjs`.

- [ ] **Шаг 1. Тест.** Файл целиком:

```js
// ROLES_SAVE_TRUTH_V1 (2026-09-29) — «ОТКРЫЛ И СОХРАНИЛ — НИЧЕГО НЕ ИЗМЕНИЛОСЬ»,
// НАСТОЯЩИЙ ЭКРАН «РОЛИ» НА НАСТОЯЩЕМ СЕРВЕРЕ.
//
// Доказанная ошибка (docs/specs/2026-09-29-roles-save-truth-design.md): экран
// рисовал у ключа, который роль не настраивала, СВОЮ ДОГАДКУ из старой галочки
// раздела, а «Сохранить роль» писал матрицу целиком — и первое же сохранение
// без единой правки делало догадку настоящим правом. Оператор колл-центра
// получал `crm.all` и читал чужую заявку, регистратор — измерения стационара
// (admission_vitals_add: 403 → 200).
//
// ПОЧЕМУ СТЕНД НАСТОЯЩИЙ. Экран — тот же roles-editor.js на фальшивой DOM
// (приём roles-editor.test.mjs), а всё, что он спрашивает и пишет, уходит
// HTTP-запросом в НАСТОЯЩИЙ сервер (createApp) на базе после всех миграций:
// /api/db с защитой «Ролей», /api/rpc с воротами лицензии. Заглушка сервера
// дала бы зелёный тест и на старом коде — ломалось всё на границе «экран —
// сервер».
//
// Пункты 2–5 раздела «Тесты» спецификации:
//   2 — открыл и сохранил: grants, sections/levels и уровни ворот те же — у
//       каждой строки role_permissions свежей базы, которую экран открывает,
//       и у четырёх синтетических ролей;
//   3 — тронул одно окно или действие: в grants добавилось ровно оно;
//   4 — сторож: у незаписанного ключа с воротами экран показывает ответ сервера;
//   5 — два доказанных сценария, сквозь сервер.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Фальшивая DOM — копия из roles-editor.test.mjs (там объяснено, зачем каждая часть).
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this._v=null;this._chk=null;this.disabled=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if(k==='value')this._v=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get checked(){return this._chk===null?('checked' in this.attrs):this._chk;} set checked(v){this._chk=!!v;}
 get value(){
   if(this.tagName!=='SELECT')return this._v===null?'':this._v;
   if(this._v!==null)return this._v;
   const on=this.children.find(c=>c.tagName==='OPTION'&&'selected' in c.attrs);
   return on?String(on.attrs.value??''):(this.children[0]?String(this.children[0].attrs.value??''):'');
 }
 set value(v){this._v=String(v);}
 get classList(){const s=this;return{
   contains:c=>String(s.className).split(/\s+/).includes(c),
   add(c){if(!this.contains(c))s.className=(s.className+' '+c).trim();},
   remove(c){s.className=String(s.className).split(/\s+/).filter(x=>x&&x!==c).join(' ');},
   toggle(c,on){if(on)this.add(c);else this.remove(c);},
 };}
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
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
localStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта вида
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener(){}, easymed: { state: { user: null } }, confirm: () => true };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const tagsOf = (root, tag) => walk(root).filter((n) => n.tagName === tag);
const byClass = (root, cls) => walk(root).filter((n) => n.classList.contains(cls));
const findButtonByText = (root, re) => tagsOf(root, 'BUTTON').find((b) => re.test(textOf(b)));
const roleButton = (root, key) => tagsOf(root, 'BUTTON').find((b) => b.dataset.role === key);
const radiosFor = (root, key) => tagsOf(root, 'INPUT').filter((n) => n.attrs.type === 'radio' && n.attrs.name === 'grant:' + key);
const chosen = (root, key) => { const on = radiosFor(root, key).find((n) => n.checked); return on ? on.attrs.value : null; };
const pick = (root, key, lvl) => {
  const r = radiosFor(root, key).find((n) => n.attrs.value === lvl);
  for (const x of radiosFor(root, key)) x.checked = x === r;
  r.dispatchEvent({ type: 'change' });
};

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- настоящий сервер ---------------------------------------------------------
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { createApp } = await import('../../../../server/app.js');
const { licensedDataDir } = await import('../../../../server/services/control/licensed-fixture.js');
const { listen } = await import('../../../../control-plane/server/test-helpers/listen.js');
const { effectiveGrantsOf } = await import('../../../../server/services/rpc/roles-effective.js');
const { customRoleCreate } = await import('../../../../server/services/rpc/custom-roles.js');
const { fallbackLevel } = await import('../../../../server/services/gate-fallbacks.js');
const { tabRankOfPerms, PATIENT_CARD_TABS } = await import('../../../../server/services/roles.js');
const { catalogRows, grantsFromLegacy } = await import('../../shared/permission-catalog.js');

// Экран ходит относительными адресами (/api/db, /api/rpc/…) — их везём на
// сервер стенда, с сессией администратора.
const realFetch = globalThis.fetch;
let BASE = '';
let COOKIE = '';
globalThis.fetch = (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('/')) return realFetch(url, opts);
  return realFetch(BASE + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: COOKIE } });
};

const { renderRolesEditor } = await import('../views/roles-editor.js');

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Роли, которые экран открывает (roles-editor.js ROLE_LIST), — с подписью карточки.
const SCREEN_ROLES = [
  ['registrar', 'Регистратор'], ['doctor', 'Врач'], ['cashier', 'Кассир'], ['lab', 'Лаборант'],
  ['nurse', 'Медсестра'], ['inventory', 'Склад'], ['callcenter', 'Оператор колл-центра'],
  ['head_doctor', 'Главный врач'], ['senior_nurse', 'Старшая медсестра'], ['head_cashier', 'Старший кассир'],
];
// Синтетические роли спецификации.
//   legacy-only — только старые поля, и в них всё, что вывод теряет: «Кабинет
//     врача: editor» (строка «Нет / Просмотр»), «Пациенты: editor» без
//     registration и queue, CRM «admin», «Закупки» у врача, раздел без уровня;
//   written — записанные ключи: выше основы (crm.all, inpatient.marks), ниже
//     (crm.dial), раздел «Нет» с незаписанными окнами (mar), строка «только
//     администратор» (settings.api), окна разделов, закрытых по выводу
//     (reports.cashier, procurement.issue), раздел, записанный без старого поля (settings).
const LEGACY_ONLY = {
  sections: ['patients', 'consultation', 'labs', 'inventory', 'beds', 'crm', 'reports-hub', 'settings', 'custdev', 'my-stock'],
  levels: { patients: 'editor', consultation: 'editor', labs: 'admin', inventory: 'editor', beds: 'viewer', crm: 'admin', 'reports-hub': 'viewer', settings: 'viewer', custdev: 'editor' },
};
const WRITTEN = {
  sections: ['patients', 'crm', 'beds', 'queue', 'registration', 'patient-documents'],
  levels: { patients: 'editor', crm: 'editor', beds: 'editor', queue: 'viewer', registration: 'editor', 'patient-documents': 'viewer' },
  grants: { 'crm.all': 'edit', 'crm.dial': 'none', 'inpatient.vitals': 'view', 'inpatient.marks': 'edit', mar: 'none',
    settings: 'view', 'settings.api': 'view', 'reports.cashier': 'view', 'patients.calendar': 'view', 'procurement.issue': 'edit', 'cashier.lines': 'edit' },
};
const SYNTHETIC = [['op-senior', 'Старший оператор'], ['deputy', 'Заместитель'], ['legacy-only', 'Только старые поля'], ['written', 'Записанные ключи']];

async function world(t) {
  const db = openDb(':memory:');
  migrate(db);
  const scols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  const sid = {};
  for (const [id, name, role] of [[1, 'adm', 'admin'], [2, 'op1', 'callcenter'], [3, 'op2', 'callcenter'], [4, 'reg', 'registrar']]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)').run(id, name, 'x', name, role);
    const cols = ['id', 'user_id', 'expires_at'];
    const vals = ['sid-' + name, id, iso(Date.now() + 8 * 3600e3)];
    if (scols.includes('last_seen_at')) { cols.push('last_seen_at'); vals.push(iso(Date.now())); }
    db.prepare(`INSERT INTO sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    sid[name] = 'emsid=sid-' + name;
  }
  customRoleCreate(db, { code: 'op-senior', name: 'Старший оператор', base_role: 'callcenter' }, ADMIN);
  customRoleCreate(db, { code: 'deputy', name: 'Заместитель', base_role: 'admin' }, ADMIN);
  for (const [code, name, base, perms] of [['legacy-only', 'Только старые поля', 'doctor', LEGACY_ONLY], ['written', 'Записанные ключи', 'registrar', WRITTEN]]) {
    db.prepare('INSERT INTO custom_roles (code, name, base_role, active) VALUES (?,?,?,1)').run(code, name, base);
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code, JSON.stringify(perms));
  }
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  BASE = `http://127.0.0.1:${server.address().port}`;
  COOKIE = sid.adm;
  t.after(() => new Promise((r) => server.close(() => { db.close(); r(); })));
  return { db, sid };
}

async function until(cond, what, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('не дождались: ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function render() {
  const root = mk('div');
  await renderRolesEditor(root, {});
  await until(() => byClass(root, 'roles-card').length > 0, 'экран «Роли»');
  return root;
}
async function openRole(root, role, label) {
  roleButton(root, role).click();
  await until(() => {
    const card = byClass(root, 'roles-card')[0];
    return !!card && textOf(card).includes('· ' + label) && radiosFor(card, 'patients').length > 0;
  }, 'роль ' + role);
}
async function saveRole(root) {
  toastMsg = null;
  const btn = findButtonByText(root, /^Сохранить роль$/);
  assert.ok(btn, 'нет кнопки «Сохранить роль»');
  assert.equal(btn.disabled, false, '«Сохранить роль» заперта');
  btn.click();
  await until(() => toastMsg !== null, 'ответ на «Сохранить роль»');
  assert.match(String(toastMsg), /Права сохранены/, String(toastMsg));
}
const permsOf = (db, role) => JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);
const sorted = (o) => Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const gateSnapshot = (db, role, perms) => ({
  server: effectiveGrantsOf(db, role),
  shell: sorted({ ...grantsFromLegacy(perms), ...(perms.grants || {}) }),
  tabs: PATIENT_CARD_TABS.map((tab) => tabRankOfPerms(perms, tab)),
});

test('открыл и сохранил — ничего не изменилось: каждая роль свежей базы и четыре синтетические', async (t) => {
  const { db } = await world(t);
  const synthetic = new Set(SYNTHETIC.map(([code]) => code));
  const fresh = db.prepare('SELECT role FROM role_permissions').all().map((r) => r.role).filter((r) => !synthetic.has(r));
  // Строку администратора экран не открывает (её нет в списке ролей: у
  // администратора всегда полный доступ) — остальные открываются все.
  assert.deepEqual(fresh.filter((r) => r !== 'admin').sort(), SCREEN_ROLES.map(([k]) => k).sort(),
    'в свежей базе строка роли, которой нет на экране, — её «пустое сохранение» не проверено');
  const root = await render();
  for (const [role, label] of [...SCREEN_ROLES, ...SYNTHETIC]) {
    const before = permsOf(db, role);
    const gates = gateSnapshot(db, role, before);
    await openRole(root, role, label);
    await saveRole(root);
    const after = permsOf(db, role);
    assert.deepEqual(sorted(after.grants), sorted(before.grants), role + ': grants изменились от пустого сохранения');
    assert.deepEqual([...(after.sections || [])].sort(), [...(before.sections || [])].sort(), role + ': sections изменились');
    assert.deepEqual(sorted(after.levels), sorted(before.levels), role + ': levels изменились');
    assert.deepEqual(gateSnapshot(db, role, after), gates, role + ': изменилось то, что дают ворота');
  }
});

// Окно или действие, которое можно тронуть: раздел открыт, у роли не записано,
// и выводом старого поля оно не служит (patients.queue выводит ключ queue).
function touchable(root, explicit, gated) {
  const rows = catalogRows().filter((r) => r.kind !== 'section' && !r.locked && r.key !== 'patients.queue' && !(r.key in explicit));
  rows.sort((a, b) => Number(gated.has(b.key)) - Number(gated.has(a.key)));
  for (const r of rows) {
    if ((chosen(root, r.parent) || 'none') === 'none') continue;
    const cur = chosen(root, r.key);
    const lvl = (r.levels || ['none', 'view']).find((l) => l !== cur);
    if (lvl) return { key: r.key, lvl };
  }
  return null;
}

test('тронул одно окно или действие — в grants добавилось ровно оно, старые поля не тронуты', async (t) => {
  const { db } = await world(t);
  const root = await render();
  for (const [role, label] of [...SCREEN_ROLES, ...SYNTHETIC]) {
    const before = permsOf(db, role);
    await openRole(root, role, label);
    const touch = touchable(root, before.grants || {}, new Set(Object.keys(effectiveGrantsOf(db, role))));
    assert.ok(touch, role + ': нечего тронуть');
    pick(root, touch.key, touch.lvl);
    await saveRole(root);
    const after = permsOf(db, role);
    assert.deepEqual(sorted(after.grants), sorted({ ...(before.grants || {}), [touch.key]: touch.lvl }), `${role}: тронули ${touch.key} → ${touch.lvl}`);
    assert.deepEqual([...(after.sections || [])].sort(), [...(before.sections || [])].sort(), role + ': sections');
    assert.deepEqual(sorted(after.levels), sorted(before.levels), role + ': levels');
  }
});

test('сторож: у незаписанного ключа с воротами экран показывает ответ сервера, а сервер отвечает про все такие ключи', async (t) => {
  const { db } = await world(t);
  const root = await render();
  for (const [role, label] of SCREEN_ROLES) {
    const res = await fetch('/api/rpc/role_effective_grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
    assert.equal(res.status, 200, role);
    const { levels } = (await res.json()).data;
    const pseudo = { id: 0, role, extra_roles: [], custom_role_code: null };
    const gated = catalogRows().filter((r) => r.kind !== 'section' && !r.locked && fallbackLevel(db, pseudo, r.key, 'all') !== null).map((r) => r.key).sort();
    assert.deepEqual(Object.keys(levels).sort(), gated, role + ': сервер ответил не про все ключи с воротами');
    const explicit = permsOf(db, role).grants || {};
    await openRole(root, role, label);
    for (const k of gated) {
      if (k in explicit) continue;
      assert.equal(chosen(root, k), levels[k], `${role}: «${k}» — экран показывает не то, что дают ворота`);
    }
  }
});

test('доказанные сценарии сквозь сервер: после пустого сохранения оператор не читает чужую заявку, регистратор не пишет измерения', async (t) => {
  const { db, sid } = await world(t);
  const lead = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, assigned_to) VALUES ('Чужая заявка', '+998901112233', 3)").run().lastInsertRowid);
  const as = async (who, path, body) => {
    const r = await realFetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sid[who] }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const operatorSeesLead = async () => {
    const r = await as('op1', '/api/db', { table: 'crm_requests', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: lead }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.data.length > 0;
  };
  const registrarVitals = async () => (await as('reg', '/api/rpc/admission_vitals_add', { admission_id: 1, pulse_bpm: 72 })).status;

  assert.equal(await operatorSeesLead(), false, 'до сохранения оператор уже видит чужую заявку — стенд неверен');
  assert.equal(await registrarVitals(), 403, 'до сохранения регистратор уже пишет измерения — стенд неверен');

  const root = await render();
  await openRole(root, 'callcenter', 'Оператор колл-центра');
  await saveRole(root);
  await openRole(root, 'registrar', 'Регистратор');
  await saveRole(root);

  assert.ok(!('crm.all' in (permsOf(db, 'callcenter').grants || {})), 'пустое сохранение записало оператору crm.all');
  assert.equal(await operatorSeesLead(), false, 'после пустого сохранения оператор читает чужую заявку');
  const g = permsOf(db, 'registrar').grants || {};
  for (const k of ['inpatient.vitals', 'inpatient.prescriptions', 'inpatient.marks', 'inpatient.discharge', 'crm.all']) {
    assert.ok(!(k in g), 'пустое сохранение записало регистратору ' + k);
  }
  assert.equal(await registrarVitals(), 403, 'после пустого сохранения admission_vitals_add регистратора — не 403');

  // Проверка самой проверки: будь право записано — обе двери открылись бы.
  const put = (role, grants) => {
    const p = permsOf(db, role);
    p.grants = { ...(p.grants || {}), ...grants };
    db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), role);
  };
  put('callcenter', { 'crm.all': 'edit' });
  assert.equal(await operatorSeesLead(), true, 'стенд не отличает: с crm.all оператор видит чужую заявку');
  put('registrar', { 'inpatient.vitals': 'edit' });
  assert.notEqual(await registrarVitals(), 403, 'стенд не отличает: с измерениями регистратор проходит ворота');
});
```

- [ ] **Шаг 2. Запуск — красный.** `node --test public/js/admin/__tests__/roles-save-truth.test.mjs`
  → «grants изменились от пустого сохранения» (матрица целиком), сторож:
  `crm.all` — экран `edit`, ворота `none`; сценарий — оператор читает чужую
  заявку. Не коммитить: файл уходит вместе с задачей 4.

### Задача 3. `collectGrants` и `legacyFromGrants` с `initial` (чистая логика)

**Файлы:** изменить `public/js/admin/roles-matrix.js`; создать
`public/js/admin/__tests__/roles-save-collect.test.mjs`.

- [ ] **Шаг 1. Падающий тест** — файл целиком:

```js
// ROLES_SAVE_TRUTH_V1 (2026-09-29) — СБОР МАТРИЦЫ: ПИШЕТСЯ ТОЛЬКО РЕШЁННОЕ.
//
// Чистая логика roles-matrix.js без экрана: collectGrants с `initial`
// (показанное при открытии) и legacyFromGrants с `initial`. Экран и сервер
// целиком — в roles-save-truth.test.mjs; здесь каждое правило отдельно, чтобы
// поломка называла себя.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Минимальная фальшивая DOM: roles-matrix.js тянет ui.js и i18n.js.
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;}
 addEventListener(){} removeEventListener(){} querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){return{contains:()=>false,add(){},remove(){},toggle(){}};}}
class TX extends F{constructor(t){super('#text');this._t=String(t);}}
function mk(t){const el=new F(t);if(el.tagName==='TEMPLATE'){el.content={firstChild:null};Object.defineProperty(el,'innerHTML',{set(v){const s=new F('svg');s._t=String(v);el.content.firstChild=s;},get(){return '';}});}return el;}
globalThis.Node=F;
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
const store=new Map();
globalThis.localStorage={getItem:(k)=>(store.has(k)?store.get(k):null),setItem:(k,v)=>store.set(k,String(v)),removeItem:(k)=>store.delete(k),clear:()=>store.clear()};
localStorage.setItem('admin.lang','ru');
globalThis.window={location:{hostname:'localhost'},localStorage:globalThis.localStorage,addEventListener(){},easymed:{state:{user:null}}};
globalThis.MutationObserver=class{observe(){}disconnect(){}};

const { collectGrants, legacyFromGrants, grantsFromLegacy } = await import('../roles-matrix.js');
const { catalogRows, CATALOG } = await import('../../shared/permission-catalog.js');

// То, что стоит на переключателях: вывод из старых полей, поверх — правда
// сервера, поверх — записанное; уровень, которого у строки нет, — «Нет».
function shownFor(perms, truth = {}) {
  const g = { ...grantsFromLegacy(perms), ...truth, ...(perms.grants || {}) };
  const out = {};
  for (const r of catalogRows()) {
    if (r.locked) continue;
    out[r.key] = (r.levels || ['none', 'view']).includes(g[r.key]) ? g[r.key] : 'none';
  }
  return out;
}
const controlsOf = (values) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: () => v }]));
const kidsOf = (key) => { const s = CATALOG.find((x) => x.key === key); return [...(s.windows || []), ...(s.actions || [])].map((r) => r.key); };

const REG = { sections: ['patients', 'crm', 'beds', 'dashboard'], levels: { patients: 'editor', crm: 'editor', beds: 'editor', dashboard: 'viewer' }, grants: { 'crm.dial': 'edit' } };
const TRUTH = { 'crm.all': 'none', 'inpatient.vitals': 'none', 'inpatient.marks': 'none', 'crm.calls': 'view' };

test('ничего не тронуто — пишется только записанное у роли', () => {
  const shown = shownFor(REG, TRUTH);
  assert.deepEqual(collectGrants(controlsOf(shown), { explicit: REG.grants, initial: shown }), { 'crm.dial': 'edit' });
});

test('тронутый ключ пишется, возвращённый назад — нет; записанный пишется всегда', () => {
  const shown = shownFor(REG, TRUTH);
  const cur = { ...shown, 'crm.all': 'edit' };
  assert.deepEqual(collectGrants(controlsOf(cur), { explicit: REG.grants, initial: shown }), { 'crm.dial': 'edit', 'crm.all': 'edit' });
  assert.deepEqual(collectGrants(controlsOf({ ...shown }), { explicit: REG.grants, initial: shown }), { 'crm.dial': 'edit' }, 'вернули как было — не пишется');
});

test('закрытый здесь раздел: «Нет» у него и у всех его строк', () => {
  const shown = shownFor(REG, TRUTH);
  const cur = { ...shown, crm: 'none' };
  for (const k of kidsOf('crm')) cur[k] = 'none';   // paintCatalog обнуляет строки закрытого раздела
  const out = collectGrants(controlsOf(cur), { explicit: REG.grants, closed: new Set(['crm']), initial: shown });
  assert.equal(out.crm, 'none');
  for (const k of kidsOf('crm')) assert.equal(out[k], 'none', k);
  assert.ok(!('patients' in out), 'закрытие задело соседний раздел');
});

test('унаследованное «раздел Нет, окно Просмотр» чинится при сохранении', () => {
  const perms = { sections: ['patients'], levels: { patients: 'editor' }, grants: { custdev: 'none', 'custdev.list': 'view', 'custdev.rate': 'edit' } };
  const shown = shownFor(perms);
  const out = collectGrants(controlsOf(shown), { explicit: perms.grants, initial: shown });
  assert.deepEqual(out, { custdev: 'none', 'custdev.list': 'none', 'custdev.rate': 'none' });
});

test('открытый раздел пишет свои строки такими, какими их видно, кроме строк «только администратор»', () => {
  // Лаборант без «Отчётов»: открыли раздел и отметили одну группу. Незаписанные
  // группы сервер вывел бы из нового «reports-hub» — все сразу.
  const lab = { sections: ['labs', 'patients', 'dashboard'], levels: { labs: 'editor', patients: 'viewer', dashboard: 'viewer' } };
  const truth = Object.fromEntries(kidsOf('reports').map((k) => [k, 'none']));
  const shown = shownFor(lab, truth);
  const cur = { ...shown, reports: 'view', 'reports.cashier': 'view' };
  const out = collectGrants(controlsOf(cur), { explicit: {}, initial: shown });
  assert.equal(out.reports, 'view');
  assert.equal(out['reports.cashier'], 'view');
  for (const k of kidsOf('reports')) {
    if (k === 'reports.cashier') continue;
    if (k === 'reports.telegram') { assert.ok(!(k in out), 'строка «только администратор» записана'); continue; }
    assert.equal(out[k], 'none', k + ': неотмеченная группа не записана «Нет» — сервер открыл бы её по «Отчётам»');
  }
  assert.ok(!('labs' in out), 'чужой раздел записан');
});

test('строка «только администратор»: нетронутая не пишется, тронутая — пишется', () => {
  const shown = shownFor(REG, { ...TRUTH, 'settings.api': 'none', 'cashier.lines': 'none' });
  assert.ok(!('settings.api' in collectGrants(controlsOf(shown), { explicit: {}, initial: shown })));
  const out = collectGrants(controlsOf({ ...shown, 'settings.api': 'view' }), { explicit: {}, initial: shown });
  assert.equal(out['settings.api'], 'view');
});

test('без initial — прежнее правило: матрица целиком, без несвершённых «Нет» и нетронутых строк администратора', () => {
  const shown = shownFor(REG);
  const out = collectGrants(controlsOf(shown), { explicit: REG.grants });
  assert.equal(out.patients, 'edit');
  assert.equal(out['inpatient.vitals'], shown['inpatient.vitals'], 'прежний сбор писал всю матрицу');
  assert.ok(!('reports' in out), 'несвершённое «Нет» раздела записано');
  assert.ok(!('settings.api' in out), 'нетронутая строка «только администратор» записана');
});

// Вывод старых полей ТЕРЯЕТ сведения — так записано у врача свежей базы.
const DOCTOR = { sections: ['patients', 'consultation', 'labs', 'dashboard', 'patient-documents', 'queue', 'my-stock'],
  levels: { patients: 'editor', consultation: 'editor', labs: 'editor', dashboard: 'viewer', 'patient-documents': 'editor', queue: 'viewer', 'my-stock': 'viewer' } };

test('старые поля: без правок — ровно записанное, даже там, где вывод теряет сведения', () => {
  const shown = shownFor(DOCTOR);
  const plain = legacyFromGrants(shown, DOCTOR);
  assert.ok(plain.sections.includes('registration') && plain.levels.consultation === 'viewer',
    'вывод «как сейчас» больше не теряет — пересмотрите, нужен ли `initial`');
  const got = legacyFromGrants(shown, DOCTOR, shown);
  assert.deepEqual([...got.sections].sort(), [...DOCTOR.sections].sort());
  assert.deepEqual(got.levels, DOCTOR.levels);
});

test('старые поля: тронутый раздел меняет свой ключ; «Пациенты: Изменение» дописывает registration, queue — как был', () => {
  const lab = { sections: ['labs', 'patients', 'dashboard'], levels: { labs: 'editor', patients: 'viewer', dashboard: 'viewer' } };
  const shown = shownFor(lab);
  const got = legacyFromGrants({ ...shown, patients: 'edit' }, lab, shown);
  assert.equal(got.levels.patients, 'editor');
  assert.ok(got.sections.includes('registration'), '«Пациенты: Изменение» не открыли регистрацию');
  assert.equal(got.levels.registration, 'editor');
  assert.ok(!got.sections.includes('queue'), 'очередь дописана, хотя её вывод не сдвинулся');
  assert.equal(got.levels.labs, 'editor');
  const closed = legacyFromGrants({ ...shown, labs: 'none' }, lab, shown);
  assert.ok(!closed.sections.includes('labs') && !('labs' in closed.levels), 'закрытая лаборатория осталась в старых полях');
});
```

- [ ] **Шаг 2. Запуск — красный.** `node --test public/js/admin/__tests__/roles-save-collect.test.mjs`
  → `initial` не знают: пишется матрица целиком, `legacyFromGrants` дописывает `registration`.

- [ ] **Шаг 3. Код** (`public/js/admin/roles-matrix.js`). Прежнее тело
  `legacyFromGrants` переименовать в `deriveLegacy(grants, prev = {})` (без
  изменений), а поверх:

```js
export function legacyFromGrants(grants, prev = {}, initial = null) {
    const now = deriveLegacy(grants, prev);
    if (!initial) return now;
    const was = deriveLegacy(initial, prev);
    const pSec = Array.isArray(prev.sections) ? prev.sections : [];
    const pLv = (prev.levels && typeof prev.levels === 'object') ? prev.levels : {};
    const keys = [...new Set([...pSec, ...now.sections, ...was.sections, ...Object.keys(pLv), ...Object.keys(now.levels), ...Object.keys(was.levels)])];
    const sections = [];
    const levels = {};
    for (const k of keys) {
        const moved = was.sections.includes(k) !== now.sections.includes(k) || was.levels[k] !== now.levels[k];
        const on = moved ? now.sections.includes(k) : pSec.includes(k);
        const lvl = moved ? now.levels[k] : pLv[k];
        if (on) sections.push(k);
        if (lvl !== undefined) levels[k] = lvl;
    }
    return { sections, levels };
}
```

`collectGrants` — новая ветка `initial` и семья сдвинутого раздела:

```js
export function collectGrants(controls, { explicit = {}, closed = null, initial = null } = {}) {
    const cur = {};
    for (const [key, ctl] of Object.entries(controls)) cur[key] = ctl.value();
    const exp = explicit || {};
    let out;
    if (initial) {
        out = {};
        for (const [key, v] of Object.entries(cur)) {
            if (key in exp || v !== (key in initial ? initial[key] : 'none')) out[key] = v;
        }
        for (const key of movedFamilyKeys(initial, cur)) out[key] = cur[key];
    } else {
        out = { ...cur };
        for (const r of catalogRows()) {
            if (r.adminDefault && out[r.key] === 'none' && !(r.key in exp)) delete out[r.key];
        }
    }
    for (const s of CATALOG) {
        if (!(s.key in out) || out[s.key] !== 'none') continue;
        const decided = (s.key in exp) || !!(closed && closed.has(s.key));
        if (!decided) { delete out[s.key]; continue; }
        for (const r of [...(s.windows || []), ...(s.actions || [])]) {
            if (r.key in out) out[r.key] = 'none';
        }
    }
    return out;
}

function movedFamilyKeys(initial, cur) {
    const was = deriveLegacy(initial, {});
    const now = deriveLegacy(cur, {});
    const moved = new Set();
    for (const k of new Set([...was.sections, ...now.sections])) {
        if (was.sections.includes(k) !== now.sections.includes(k) || was.levels[k] !== now.levels[k]) moved.add(k);
    }
    const keys = [];
    for (const s of CATALOG) {
        if (!s.legacy || !moved.has(s.legacy)) continue;
        for (const r of [s, ...(s.windows || []), ...(s.actions || [])]) {
            if (!r.adminDefault && !r.locked && r.key in cur) keys.push(r.key);
        }
    }
    return keys;
}
```

- [ ] **Шаг 4. Зелёный:** `node --test public/js/admin/__tests__/roles-save-collect.test.mjs public/js/admin/__tests__/role-reports-settings.test.mjs public/js/admin/__tests__/admin-rows-grantable.test.mjs public/js/admin/__tests__/roles-editor.test.mjs`
  (вызовы без `initial` ведут себя как прежде; экран ещё не передаёт `initial`).
- [ ] **Шаг 5. Коммит:** `roles-matrix.js`, `roles-save-collect.test.mjs`.
  «Роли, сбор матрицы: с `initial` пишутся записанное, тронутое и строки раздела, чей старый ключ сдвинулся; старые поля меняются только там, где сдвинулся их вывод (ROLES_SAVE_TRUTH_V1)».

### Задача 4. Экран «Роли»: правда сервера, `initial`, только чтение при сбое

**Файлы:** `public/js/admin/views/roles-editor.js`,
`public/js/admin/__tests__/roles-editor.test.mjs`,
`public/js/admin/__tests__/roles-save-truth.test.mjs` (из задачи 2), штампы,
словарь.

- [ ] **Шаг 1. Тесты** в `roles-editor.test.mjs`. Сервер-заглушка:

```js
// ROLES_SAVE_TRUTH_V1 — «что у роли есть сейчас» (role_effective_grants). По
// умолчанию сервер не называет ни одного ключа: экран рисует прежний вывод из
// старых полей, и прежние проверки экрана остаются о своём. Своя правда — в
// EFFECTIVE, сбой — в effectiveRespond.
const EFFECTIVE = {};
let effectiveRespond = null;
// в resetServer(): effectiveRespond = null;
// в globalThis.fetch, первым:
  if (u.startsWith('/api/rpc/role_effective_grants')) {
    if (effectiveRespond) return effectiveRespond(desc);
    return jsonOk({ levels: EFFECTIVE[desc && desc.role] || {} });
  }
```

Договор записи там, где он был «матрица целиком»:
- «сохранение: кнопка заперта…» — `written.grants` → `{}`, `sections` →
  `['patients', 'dashboard']`, `levels` → `{ patients: 'editor', dashboard: 'viewer' }`;
- «явное «Нет»…» — `crm.calls` не записан;
- «раздел, поставленный в «Нет»…» — `patients` не записан, в `sections` остался, `levels.patients === 'editor'`;
- «раздел, закрытый и снова открытый…» — `crm` не записан, `levels.crm === 'admin'`;
- «закрыть → открыть → снять право…» — `custdev.list` и `custdev` не записаны.

Новые:

```js
test('ROLES_SAVE_TRUTH_V1: правда сервера перекрывает догадку экрана, записанное — всё; пустое сохранение пишет только записанное', async () => {
  resetServer();
  SAVED.registrar = { sections: ['patients', 'crm', 'beds'], levels: { patients: 'editor', crm: 'editor', beds: 'editor' }, grants: { 'inpatient.marks': 'view' } };
  EFFECTIVE.registrar = { 'crm.all': 'none', 'inpatient.vitals': 'none', 'inpatient.marks': 'none', 'crm.calls': 'view' };
  try {
    const root = await render();
    const chosen = (key) => ((radiosFor(root, key).find((n) => n.checked) || {}).attrs || {}).value;
    assert.equal(chosen('crm.all'), 'none', 'догадка «раздел выдан — внутри всё» перебила сервер');
    assert.equal(chosen('inpatient.vitals'), 'none');
    assert.equal(chosen('inpatient.marks'), 'view', 'записанное у роли перебито ответом сервера');
    assert.equal(chosen('crm'), 'edit', 'раздел выводится из старых полей, как и прежде');
    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    const saved = JSON.parse(lastUpdate.values.permissions);
    assert.deepStrictEqual(saved.grants, { 'inpatient.marks': 'view' }, 'пустое сохранение записало то, чего не трогали');
    assert.deepStrictEqual([...saved.sections].sort(), ['beds', 'crm', 'patients']);
    assert.deepStrictEqual(saved.levels, { patients: 'editor', crm: 'editor', beds: 'editor' });
  } finally {
    SAVED.registrar = { sections: ['patients', 'dashboard'], levels: { patients: 'editor', dashboard: 'viewer' } };
    delete EFFECTIVE.registrar;
  }
});

test('ROLES_SAVE_TRUTH_V1: сервер не сказал, что у роли есть сейчас — только чтение, «Сохранить роль» заперта', async () => {
  resetServer();
  effectiveRespond = () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'database is locked' } }) });
  const root = await render();
  const text = textOf(root);
  assert.ok(text.includes('Не удалось узнать, какие права у роли сейчас, — сохранять нельзя. Обновите страницу.'), 'нет предупреждения');
  assert.ok(text.includes('database is locked'), 'причина не показана');
  const btn = findButtonByText(root, /Сохранить роль/);
  assert.ok(btn && btn.disabled === true, '«Сохранить роль» не заперта');
  btn.click();
  await tick();
  assert.strictEqual(updateCalls, 0, 'без правды сервера роль сохранилась — вернулась бы прежняя ошибка');
  assert.ok(radios(root).length && radios(root).every((n) => n.disabled), 'переключатели живые');
  assert.ok(tabBoxes(root).every((n) => n.disabled), 'галочки вкладок живые');
});

test('ROLES_SAVE_TRUTH_V1: тронутый раздел пишет свои окна такими, как их видно; старые поля следуют выводу только там, где он сдвинулся', async () => {
  resetServer();
  SAVED.lab = { sections: ['labs', 'patients', 'dashboard'], levels: { labs: 'editor', patients: 'viewer', dashboard: 'viewer' } };
  try {
    const root = await render();
    roleButton(root, 'lab').click();
    await tick();
    pick(root, 'patients', 'edit');
    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    const saved = JSON.parse(lastUpdate.values.permissions);
    assert.equal(lastUpdate.role, 'lab');
    assert.deepStrictEqual(saved.grants, { patients: 'edit', 'patients.list': 'view', 'patients.queue': 'view', 'patients.calendar': 'view' },
      'окна раздела не записаны такими, какими их видно — «Записи» вывелись бы из нового «editor» в «Изменение»');
    assert.ok(saved.sections.includes('registration'), '«Пациенты: Изменение» не открыли регистрацию');
    assert.ok(!saved.sections.includes('queue'), 'очередь дописана, хотя её вывод не сдвинулся');
    assert.equal(saved.levels.patients, 'editor');
    assert.equal(saved.levels.labs, 'editor', 'чужой раздел тронут');
  } finally { delete SAVED.lab; }
});
```

- [ ] **Шаг 2. Красный:** `node --test public/js/admin/__tests__/roles-editor.test.mjs`.

- [ ] **Шаг 3. Код** (`roles-editor.js`):

```js
import { paintCatalog, collectGrants, grantsFromLegacy, legacyFromGrants } from '../roles-matrix.js?v=rm7';
```

в `state`:

```js
        initialGrants: null,   // ROLES_SAVE_TRUTH_V1 — показанное при открытии роли: пишется только отличное от него
        truthLost: false,      // ROLES_SAVE_TRUTH_V1 — сервер не сказал, что у роли есть сейчас: только чтение
```

`collect()` и помощник:

```js
    // ROLES_SAVE_TRUTH_V1 — то, что сейчас стоит на переключателях матрицы.
    function shownGrants() {
        const out = {};
        for (const [key, ctl] of Object.entries(state.grantControls || {})) out[key] = ctl.value();
        return out;
    }

    function collect() {
        const initial = state.initialGrants || null;
        const grants = collectGrants(state.grantControls || {}, {
            explicit: state.explicitGrants || {},
            closed: state.closedSections,
            initial,
        });
        const { sections, levels } = legacyFromGrants(shownGrants(), state.prevLegacy || {}, initial);
        // … patient_tabs — как было …
    }
```

`selectRole`: сбросить `state.initialGrants = null`; до чтения строки роли
начать `const truthReq = supabase.rpc('role_effective_grants', { role: key });`,
после — `const truth = await readTruth(truthReq);` и `paintMatrix(perms, truth)`:

```js
    // ROLES_SAVE_TRUTH_V1 — ответ role_effective_grants или причина, почему его нет.
    async function readTruth(req) {
        try {
            const { data, error } = await req;
            if (!error && data && data.levels && typeof data.levels === 'object') return { levels: data.levels, why: '' };
            return { levels: null, why: (error && error.message) || '' };
        } catch (e) {
            return { levels: null, why: (e && e.message) || String(e) };
        }
    }
```

`paintMatrix(perms, truth = { levels: null, why: '' })`: после создания
`saveBtn` — `const truthLost = !(truth && truth.levels); state.truthLost = truthLost; if (truthLost) saveBtn.disabled = true;`;
сразу под шапкой карточки:

```js
        if (truthLost) {
            card.appendChild(h('div', { class: 'card roles-error', role: 'alert' },
                h('div', { class: 'roles-error-head' },
                    h('span', { class: 'roles-error-ico' }, Icon('Warning', { size: 16 })),
                    h('strong', null, 'Не удалось узнать, какие права у роли сейчас, — сохранять нельзя. Обновите страницу.')),
                truth && truth.why ? h('p', { class: 'roles-error-why' }, String(truth.why)) : null));
        }
```

матрица: `const grants = { ...grantsFromLegacy(perms), ...(truthLost ? {} : truth.levels), ...(perms.grants || {}) };`,
после `paintCatalog` — `state.initialGrants = shownGrants();`, в конце —
`if (lockWhy || truthLost) { …погасить всё… }`.

`save()`: `if (state.busy || state.truthLost) return;` и после удачной записи:

```js
            state.explicitGrants = { ...grants };
            state.initialGrants = shownGrants();
            state.prevLegacy = { sections, levels };
            if (state.closedSections) state.closedSections.clear();
```

Штампы: `settings-hub.js` — `./roles-editor.js?v=roles3`; `admin.js` —
`./admin/views/settings-hub.js?v=rst1` (+ `ROLES_SAVE_TRUTH_V1` в хвосте строки).
Словарь:

```js
  "Не удалось узнать, какие права у роли сейчас, — сохранять нельзя. Обновите страницу.": {"en":"Could not find out what rights this role has right now — saving is disabled. Refresh the page.","ru":"Не удалось узнать, какие права у роли сейчас, — сохранять нельзя. Обновите страницу.","uz":"Rolning hozirgi huquqlarini aniqlab bo'lmadi — saqlab bo'lmaydi. Sahifani yangilang."},   // ROLES_SAVE_TRUTH_V1
```

- [ ] **Шаг 4. Зелёный:** `node --test public/js/admin/__tests__/roles-editor.test.mjs public/js/admin/__tests__/roles-save-truth.test.mjs public/js/admin/__tests__/roles-save-collect.test.mjs public/js/admin/__tests__/roles-review.test.mjs public/js/admin/__tests__/role-reports-settings.test.mjs public/js/admin/__tests__/admin-rows-grantable.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
- [ ] **Шаг 5. Коммит:** `roles-editor.js`, `roles-editor.test.mjs`,
  `roles-save-truth.test.mjs`, `settings-hub.js`; `admin.js`, `i18n-strings.js` —
  своими кусками. «Роли: экран рисует правду сервера, пустое «Сохранить роль» ничего не меняет, без ответа сервера — только чтение; стенд на настоящем сервере (ROLES_SAVE_TRUTH_V1)».

### Задача 5. Миграция 230 и реестр (тест 6, сервер)

**Файлы:** создать `server/db/migrations/230_role_grant_reviews.sql`,
`server/db/migrations/230.test.js`; изменить `server/db/schema-registry.js`,
словарь.

- [ ] **Шаг 1. Тест** `230.test.js`:

```js
// ROLES_SAVE_TRUTH_V1 (мигр. 230) — ключи, у которых записанный уровень выше
// стандарта основы роли (того, что дают ворота по списку ролей в коде): так их
// мог выдать сам экран «Роли» до этого выпуска. Миграция права НЕ меняет —
// отличить догадку экрана от права, выданного нарочно, нельзя, — а записывает
// такие пары в role_grant_reviews; решает в «Ролях» администратор.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { hashPassword } from '../../services/auth.js';
import { createApp } from '../../app.js';
import { licensedDataDir } from '../../services/control/licensed-fixture.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { GATE_FALLBACK, fallbackLevel } from '../../services/gate-fallbacks.js';
import { VALID_ROLES } from '../../services/roles.js';
import { MAIN_CLINIC_TABLES } from '../schema-registry.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '230_role_grant_reviews.sql'), 'utf8');

function setup(rows = {}, custom = []) {
  const db = openDb(':memory:');
  migrate(db);
  for (const [code, base] of custom) db.prepare('INSERT INTO custom_roles (code, name, base_role, active) VALUES (?,?,?,1)').run(code, code, base);
  const put = db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)');
  for (const [role, p] of Object.entries(rows)) put.run(role, JSON.stringify(p));
  return db;
}
const rowsOf = (db) => db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all();
const reviewsOf = (db) => db.prepare('SELECT role, key, level, standard, resolution FROM role_grant_reviews ORDER BY role, key').all();
const withGrants = (grants) => ({ sections: ['patients'], levels: { patients: 'editor' }, grants });

test('230: таблица стандартов = fallbackLevel для каждой основы × ключа ворот', () => {
  const got = {};
  for (const m of SQL.matchAll(/\('([a-z_]+)', '([a-z._]+)', '(none|view|edit|delete)'\)/g)) got[m[1] + '|' + m[2]] = m[3];
  const db = openDb(':memory:');
  try {
    const want = {};
    for (const base of VALID_ROLES.filter((r) => r !== 'admin')) {
      for (const key of Object.keys(GATE_FALLBACK)) want[base + '|' + key] = fallbackLevel(db, { id: 0, role: base, extra_roles: [] }, key, 'all');
    }
    assert.deepEqual(got, want, 'стандарты миграции разошлись с воротами: пересоберите VALUES по gate-fallbacks.js');
  } finally { db.close(); }
});

test('230: на проверку — ровно расширенные пары (роль, ключ); администратор и роли на его основе пропущены; права не меняются', () => {
  const db = setup({
    registrar: withGrants({ 'crm.all': 'edit', 'inpatient.vitals': 'edit', 'inpatient.services': 'edit', 'crm.calls': 'view', 'inpatient.beds': 'edit', 'crm.dial': 'none' }),
    callcenter: withGrants({ 'crm.all': 'edit', 'crm.recording': 'edit' }),
    nurse: withGrants({ 'inpatient.vitals': 'delete', 'inpatient.prescriptions': 'edit', 'inpatient.marks': 'edit' }),
    lab: withGrants({ 'crm.all': 'admin', 'inpatient.vitals': 7 }),
    admin: withGrants({ 'crm.all': 'edit' }),
    'senior-op': withGrants({ 'crm.all': 'edit' }),
    deputy: withGrants({ 'crm.all': 'edit', 'inpatient.vitals': 'delete' }),
  }, [['senior-op', 'callcenter'], ['deputy', 'admin']]);
  try {
    const before = rowsOf(db);
    db.exec(SQL);
    assert.deepEqual(rowsOf(db), before, 'миграция тронула права');
    assert.deepEqual(reviewsOf(db), [
      { role: 'callcenter', key: 'crm.all', level: 'edit', standard: 'none', resolution: null },
      { role: 'nurse', key: 'inpatient.prescriptions', level: 'edit', standard: 'view', resolution: null },
      { role: 'nurse', key: 'inpatient.vitals', level: 'delete', standard: 'edit', resolution: null },
      { role: 'registrar', key: 'crm.all', level: 'edit', standard: 'none', resolution: null },
      { role: 'registrar', key: 'inpatient.services', level: 'edit', standard: 'view', resolution: null },
      { role: 'registrar', key: 'inpatient.vitals', level: 'edit', standard: 'none', resolution: null },
      { role: 'senior-op', key: 'crm.all', level: 'edit', standard: 'none', resolution: null },
    ]);
  } finally { db.close(); }
});

test('230: повторный накат ничего не добавляет и решений не сбрасывает; свежая база — ни одной строки', () => {
  const db = setup({ callcenter: withGrants({ 'crm.all': 'edit' }) });
  try {
    db.exec(SQL);
    assert.equal(reviewsOf(db).length, 1);
    db.prepare("UPDATE role_grant_reviews SET resolution = 'kept', resolved_at = '2026-09-29T10:00:00Z'").run();
    db.exec(SQL);
    assert.deepEqual(reviewsOf(db).map((r) => r.resolution), ['kept']);
  } finally { db.close(); }
  const fresh = openDb(':memory:');
  try {
    migrate(fresh);
    assert.equal(fresh.prepare('SELECT COUNT(*) n FROM role_grant_reviews').get().n, 0, 'штатные роли свежей базы попали на проверку');
  } finally { fresh.close(); }
});

test('230: строки проверки читают и отмечают администратор и «Роли: Изменение»; «Просмотр» — только читает; кто решил — из сессии', async (t) => {
  const db = setup({
    callcenter: withGrants({ 'crm.all': 'edit' }),
    lab: withGrants({ 'settings.roles': 'edit' }),
    inventory: withGrants({ 'settings.roles': 'view' }),
  });
  db.exec(SQL);
  const pw = hashPassword('password1');
  const ids = {};
  for (const [u, role] of [['admin', 'admin'], ['nurse', 'nurse'], ['editor', 'lab'], ['viewer', 'inventory']]) {
    ids[u] = Number(db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run(u, pw, u, role).lastInsertRowid);
  }
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); });
  const cookie = {};
  for (const u of Object.keys(ids)) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'password1' }) });
    cookie[u] = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const q = async (who, desc) => {
    const r = await fetch(base + '/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie[who] }, body: JSON.stringify(desc) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const read = { table: 'role_grant_reviews', op: 'select', columns: 'id,role,key,level,standard,resolution', filters: [] };
  for (const who of ['admin', 'editor', 'viewer']) assert.equal((await q(who, read)).status, 200, who + ' не читает');
  assert.equal((await q('nurse', read)).status, 403);
  const id = (await q('admin', read)).json.data[0].id;
  const mark = (who) => q(who, { table: 'role_grant_reviews', op: 'update', values: { resolution: 'kept', resolved_at: '2026-09-29T10:00:00Z' }, filters: [{ col: 'id', op: 'in', val: [id] }] });
  assert.equal((await mark('nurse')).status, 403);
  assert.equal((await mark('viewer')).status, 403, '«Роли: Просмотр» отметил решение');
  const ok = await mark('editor');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const row = db.prepare('SELECT resolution, resolved_by FROM role_grant_reviews WHERE id = ?').get(id);
  assert.equal(row.resolution, 'kept');
  assert.equal(row.resolved_by, ids.editor, 'кто решил — из сессии');
  assert.equal(typeof MAIN_CLINIC_TABLES.role_grant_reviews, 'string', 'проверку прав решает главная клиника');
});
```

- [ ] **Шаг 2. Красный:** `node --test server/db/migrations/230.test.js` (файла SQL нет).

- [ ] **Шаг 3. Код.** `230_role_grant_reviews.sql`:

```sql
-- ROLES_SAVE_TRUTH_V1 (2026-09-29) — «ПРОВЕРЬТЕ ПРАВА ЭТОЙ РОЛИ»: ПРАВА ВЫШЕ ОБЫЧНЫХ ДЛЯ ОСНОВЫ.
-- (почему — в шапке файла и в спецификации docs/specs/2026-09-29-roles-save-truth-design.md, §4)
CREATE TABLE IF NOT EXISTS role_grant_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role        TEXT NOT NULL,
  key         TEXT NOT NULL,
  level       TEXT NOT NULL,
  standard    TEXT NOT NULL,
  found_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  resolution  TEXT CHECK (resolution IS NULL OR resolution IN ('restored', 'kept')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  UNIQUE (role, key)
);

WITH standards(base, key, standard) AS (VALUES
  ('registrar', 'inpatient.services', 'view'),
  -- … все 160 пар: 10 основ (VALID_ROLES без admin) × 16 ключей GATE_FALLBACK,
  --   сгенерированы по fallbackLevel(db, { role: основа }, ключ, 'all') …
  ('head_cashier', 'crm.convert', 'none')
),
roles AS (
  SELECT rp.role AS role, COALESCE(cr.base_role, rp.role) AS base, rp.permissions AS permissions
    FROM role_permissions rp
    LEFT JOIN custom_roles cr ON cr.code = rp.role
)
INSERT OR IGNORE INTO role_grant_reviews (role, key, level, standard)
SELECT r.role, s.key, json_extract(r.permissions, '$.grants."' || s.key || '"'), s.standard
  FROM roles r
  JOIN standards s ON s.base = r.base
 WHERE r.role <> 'admin' AND r.base <> 'admin'
   AND json_valid(r.permissions)
   AND json_type(r.permissions, '$.grants."' || s.key || '"') = 'text'
   AND (CASE json_extract(r.permissions, '$.grants."' || s.key || '"')
          WHEN 'view' THEN 1 WHEN 'edit' THEN 2 WHEN 'delete' THEN 3 ELSE 0 END)
     > (CASE s.standard WHEN 'view' THEN 1 WHEN 'edit' THEN 2 WHEN 'delete' THEN 3 ELSE 0 END);
```

Кортежи — вывод скрипта:

```js
const bases = VALID_ROLES.filter((r) => r !== 'admin');
for (const base of bases) for (const key of Object.keys(GATE_FALLBACK))
  console.log(`  ('${base}', '${key}', '${fallbackLevel(db, { id: 0, role: base, extra_roles: [] }, key, 'all')}'),`);
```

Реестр (`schema-registry.js`, после `role_permission_reviews`):

```js
  // ROLES_SAVE_TRUTH_V1 (мигр. 230) — ключи, у которых записанный уровень выше
  // стандарта основы роли: так их мог выдать сам экран «Роли» до этого
  // выпуска. Заводит только миграция; решает администратор или «Роли:
  // Изменение» — «Убрать эти права» / «Оставить как есть»
  // (views/roles-grant-review.js); отметка решения — единственная правка.
  // Читает и «Роли: Просмотр» (write.grant → readGrantAllows).
  role_grant_reviews: {
    read:  { roles: ['admin'], columns: ['id','role','key','level','standard','found_at','resolution','resolved_at','resolved_by'] },
    write: { grant: 'settings.roles',
             insert: { roles: [] },
             update: { roles: ['admin'], columns: ['resolution','resolved_at'] },
             delete: { roles: [] } },
    stamps: { resolved_by: { with: 'resolved_at' } },
    filters: ['id','role','key','resolution'], embed: {},
  },
```

и в `MAIN_CLINIC_TABLES`:

```js
  // ROLES_SAVE_TRUTH_V1 — проверка прав ролей живёт там же, где сами права.
  role_grant_reviews: 'Проверку прав ролей ведёт главная клиника — там же решайте, убрать права или оставить.',
```

Словарь:

```js
  "Проверку прав ролей ведёт главная клиника — там же решайте, убрать права или оставить.": {"en":"Role permission reviews are handled by the main clinic — decide there whether to remove the rights or keep them.","ru":"Проверку прав ролей ведёт главная клиника — там же решайте, убрать права или оставить.","uz":"Rol huquqlarini tekshirishni bosh klinika olib boradi — huquqlarni olib tashlash yoki qoldirishni o'sha yerda hal qiling."},   // ROLES_SAVE_TRUTH_V1
```

- [ ] **Шаг 4. Зелёный:** `node --test server/db/migrations/230.test.js server/db/schema-registry-conformance.test.js server/db/write-grant.test.js server/db/migrations/215.test.js server/db/migration-order.test.js`
- [ ] **Шаг 5. Коммит:** `230_role_grant_reviews.sql`, `230.test.js`,
  `schema-registry.js`; `i18n-strings.js` — своим куском. «Роли: миграция 230 — ключи выше стандарта основы на проверку администратору, права не меняются; таблица стандартов сверена с fallbackLevel (ROLES_SAVE_TRUTH_V1, мигр. 230)».

### Задача 6. Плашка «Проверьте права этой роли» (тест 6, экран)

**Файлы:** создать `public/js/admin/views/roles-grant-review.js`,
`public/js/admin/__tests__/roles-grant-review.test.mjs`; изменить
`roles-editor.js`, `roles-editor.test.mjs`, штампы (`settings-hub.js`: `roles4`;
`admin.js`: `rst2`), словарь.

- [ ] **Шаг 1. Тест** `roles-grant-review.test.mjs` (фальшивая DOM — как в
  `roles-review.test.mjs`; сервер с состоянием):

```js
let ROW; let REVIEWS; let calls;
const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const filterVal = (desc, col) => (desc.filters.find((f) => f.col === col) || {}).val;
globalThis.fetch = async (url, opts) => {
  const desc = opts && opts.body ? JSON.parse(opts.body) : null;
  if (!desc) return jsonOk(null);
  calls.push(desc);
  if (desc.table === 'role_grant_reviews' && desc.op === 'select') return jsonOk(REVIEWS.filter((r) => r.role === filterVal(desc, 'role') && r.resolution == null));
  if (desc.table === 'role_grant_reviews' && desc.op === 'update') {
    const ids = filterVal(desc, 'id');
    for (const r of REVIEWS) if (ids.includes(r.id)) Object.assign(r, desc.values);
    return jsonOk([]);
  }
  if (desc.table === 'role_permissions' && desc.op === 'select') return jsonOk({ permissions: JSON.stringify(ROW) });
  if (desc.table === 'role_permissions' && desc.op === 'update') { ROW = JSON.parse(desc.values.permissions); return jsonOk({ id: 1 }); }
  return jsonOk([]);
};
const review = await import('../views/roles-grant-review.js');

const WIDE = { sections: ['patients', 'crm', 'beds'], levels: { patients: 'editor', crm: 'editor', beds: 'editor' },
  grants: { 'crm.all': 'edit', 'inpatient.vitals': 'edit', 'inpatient.marks': 'view', 'crm.dial': 'edit' } };
const rowsFor = () => [
  { id: 1, role: 'registrar', key: 'crm.all', level: 'edit', standard: 'none', resolution: null },
  { id: 2, role: 'registrar', key: 'inpatient.vitals', level: 'edit', standard: 'none', resolution: null },
  // С тех пор поменяли руками («Изменение» → «Просмотр») — решено на экране.
  { id: 3, role: 'registrar', key: 'inpatient.marks', level: 'edit', standard: 'none', resolution: null },
];
const fresh = () => { calls = []; ROW = JSON.parse(JSON.stringify(WIDE)); REVIEWS = rowsFor(); };
const notice = async (onDone) => { const box = review.roleGrantReviewNotice('registrar', ROW, { onDone }); await tick(); return box; };

test('показываются строки, чей ключ всё ещё стоит, как нашла миграция', async () => {
  fresh();
  assert.deepStrictEqual((await review.openGrantReviews('registrar', ROW)).map((r) => r.id), [1, 2]);
});

test('плашка: заголовок, права словами справочника, две кнопки', async () => {
  fresh();
  const box = await notice();
  const text = textOf(box);
  assert.ok(text.includes('Проверьте права этой роли'));
  assert.ok(text.includes('У роли есть права выше обычных для её основы: «CRM · Заявки → Видит все заявки и передаёт их», «Стационар → Измерения». До этого обновления экран «Роли» мог выдать их сам — при любом сохранении роли. Если вы выдали их нарочно, оставьте как есть.'), text);
  assert.ok(!text.includes('Отметки о введении'), 'показано то, что уже решено на экране');
  assert.deepStrictEqual(buttons(box).map((b) => textOf(b)), ['Убрать эти права', 'Оставить как есть']);
});

test('«Убрать эти права»: роль перечитана, сняты только названные ключи, отметка restored; плашка больше не появляется', async () => {
  fresh();
  let done = 0;
  const box = await notice(() => { done++; });
  ROW.grants['crm.dial'] = 'none';   // пока плашка висела, роль правили — запись перечитывается
  buttons(box).find((b) => textOf(b).includes('Убрать эти права')).click();
  await tick();
  assert.strictEqual(done, 1);
  assert.ok(!('crm.all' in ROW.grants) && !('inpatient.vitals' in ROW.grants), 'названные ключи не сняты');
  assert.strictEqual(ROW.grants['inpatient.marks'], 'view', 'снят ключ, которого в плашке не было');
  assert.strictEqual(ROW.grants['crm.dial'], 'none', 'запись роли не перечитана — затёрта свежая правка');
  assert.deepStrictEqual(ROW.sections, WIDE.sections, 'старые поля тронуты');
  const up = calls.find((d) => d.table === 'role_grant_reviews' && d.op === 'update');
  assert.strictEqual(up.values.resolution, 'restored');
  assert.deepStrictEqual(up.filters, [{ col: 'id', op: 'in', val: [1, 2] }]);
  assert.strictEqual((await notice()).children.length, 0, 'после решения плашка снова появилась');
});

test('«Оставить как есть»: права не тронуты, отметка kept; плашка больше не появляется', async () => {
  fresh();
  const box = await notice();
  buttons(box).find((b) => textOf(b).includes('Оставить как есть')).click();
  await tick();
  assert.ok(!calls.some((d) => d.table === 'role_permissions' && d.op === 'update'), 'права тронуты');
  assert.deepStrictEqual(ROW, WIDE);
  assert.strictEqual(calls.find((d) => d.table === 'role_grant_reviews' && d.op === 'update').values.resolution, 'kept');
  assert.strictEqual((await notice()).children.length, 0);
});

test('ключ, изменённый после того, как плашка нарисована, не снимается', async () => {
  fresh();
  const box = await notice();
  ROW.grants['inpatient.vitals'] = 'view';
  buttons(box).find((b) => textOf(b).includes('Убрать эти права')).click();
  await tick();
  assert.strictEqual(ROW.grants['inpatient.vitals'], 'view', 'снят ключ, который уже решили руками');
  assert.ok(!('crm.all' in ROW.grants));
});

test('нет строк проверки — нет и плашки', async () => {
  fresh(); REVIEWS = [];
  assert.strictEqual((await notice()).children.length, 0);
});
```

В `roles-editor.test.mjs`: заглушка отвечает `role_grant_reviews` из
`GRANT_REVIEWS` (по роли и `resolution IS NULL`) и тест: у администратора
плашка с «CRM · Заявки → Видит все заявки и передаёт их» есть, на «Просмотре» — нет.

- [ ] **Шаг 2. Красный:** `node --test public/js/admin/__tests__/roles-grant-review.test.mjs public/js/admin/__tests__/roles-editor.test.mjs`

- [ ] **Шаг 3. Код** `public/js/admin/views/roles-grant-review.js`:

```js
// ROLES_SAVE_TRUTH_V1 (2026-09-29) — «ПРОВЕРЬТЕ ПРАВА ЭТОЙ РОЛИ»: ПРАВА ВЫШЕ ОБЫЧНЫХ ДЛЯ ОСНОВЫ.
//
// До этого выпуска экран «Роли» писал в роль СВОЮ ДОГАДКУ о ключах, которые
// роль не настраивала, и первое же «Сохранить роль» давало права выше тех, что
// дают ворота основы. Миграция 230 нашла такие ключи (role_grant_reviews) и
// прав не меняла: отличить догадку экрана от права, выданного нарочно, нельзя.
// Решает тот, кто вправе менять роль:
//   «Убрать эти права» — названные ключи снимаются из grants, решает основа;
//   «Оставить как есть» — права не трогаются, вопрос больше не задаётся.
// Ключ, который с тех пор поменяли руками, не показывается и не снимается:
// решение уже принято на самом экране (тот же приём, что у roles-review.js).
import { supabase } from '../../supabase.js';
import { h, Icon, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { CATALOG } from '../../shared/permission-catalog.js';

function parse(p) {
    if (typeof p === 'string') { try { return JSON.parse(p); } catch { return null; } }
    return p && typeof p === 'object' ? p : null;
}
const grantsOf = (perms) => { const p = parse(perms) || {}; return (p.grants && typeof p.grants === 'object') ? p.grants : {}; };

/** Строка справочника словами экрана: «Стационар → Измерения». */
export function grantKeyLabel(key) {
    for (const s of CATALOG) {
        for (const r of [...(s.windows || []), ...(s.actions || [])]) {
            if (r.key === key) return tr(s.label) + ' → ' + tr(r.label);
        }
    }
    return key;
}

/** Нерешённые строки проверки по роли — только те, чей ключ стоит, как его нашла миграция. */
export async function openGrantReviews(role, perms) {
    try {
        const { data, error } = await supabase.from('role_grant_reviews')
            .select('id, role, key, level, standard, resolution').eq('role', role).is('resolution', null);
        if (error || !Array.isArray(data)) return [];
        const g = grantsOf(perms);
        return data.filter((r) => g[r.key] === r.level);
    } catch (e) { return []; }
}

async function resolve(items, resolution) {
    const { error } = await supabase.from('role_grant_reviews')
        .update({ resolution, resolved_at: new Date().toISOString() })
        .in('id', items.map((i) => i.id)).select();
    if (error) throw new Error(error.message || String(error));
}

/** «Убрать эти права»: строка роли перечитывается, снимаются только ключи, стоящие как найдено. */
export async function removeReviewedGrants(role, items) {
    const { data, error } = await supabase.from('role_permissions').select('permissions').eq('role', role).maybeSingle();
    if (error) throw new Error(error.message || String(error));
    const p = parse(data && data.permissions) || {};
    const grants = { ...grantsOf(p) };
    let changed = false;
    for (const it of items) {
        if (grants[it.key] === it.level) { delete grants[it.key]; changed = true; }
    }
    if (changed) {
        const up = await supabase.from('role_permissions').update({ permissions: JSON.stringify({ ...p, grants }) }).eq('role', role).select().single();
        if (up.error) throw new Error(up.error.message || String(up.error));
    }
    await resolve(items, 'restored');
}

/** Врезка в карточку роли. `onDone` — после решения (экран перечитывает роль). */
export function roleGrantReviewNotice(role, perms, { onDone } = {}) {
    const box = h('div', { class: 'roles-review' });
    openGrantReviews(role, perms).then((items) => {
        if (!items.length) return;
        const removeBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Убрать эти права');
        const keepBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Оставить как есть');
        const act = async (fn, okText) => {
            removeBtn.disabled = true; keepBtn.disabled = true;
            try { await fn(); toast(tr(okText), 'ok'); if (onDone) onDone(); }
            catch (e) { toast(tr('Не удалось сохранить решение.') + ' ' + ((e && e.message) || ''), 'fail'); removeBtn.disabled = false; keepBtn.disabled = false; }
        };
        removeBtn.addEventListener('click', () => act(() => removeReviewedGrants(role, items), 'Права убраны — решает основа роли.'));
        keepBtn.addEventListener('click', () => act(() => resolve(items, 'kept'), 'Права оставлены как есть.'));
        const list = items.map((i) => '«' + grantKeyLabel(i.key) + '»').join(', ');
        box.appendChild(h('div', { class: 'card roles-note', role: 'status', dataset: { grantReview: role } },
            h('span', { class: 'roles-note-ico' }, Icon('Warning', { size: 15 })),
            h('div', { class: 'roles-note-txt' },
                h('strong', null, 'Проверьте права этой роли'),
                h('div', { class: 'muted' }, trf('У роли есть права выше обычных для её основы: {list}. До этого обновления экран «Роли» мог выдать их сам — при любом сохранении роли. Если вы выдали их нарочно, оставьте как есть.', { list })),
                h('div', { class: 'roles-review-acts' }, removeBtn, ' ', keepBtn)),
        ));
    });
    return box;
}
```

`roles-editor.js`: импорт
`import { roleGrantReviewNotice } from './roles-grant-review.js';`, и в
`paintMatrix` после плашки 215:

```js
        // ROLES_SAVE_TRUTH_V1 — «Проверьте права этой роли» (мигр. 230): права
        // выше обычных для основы — возможно, выданные самим экраном. Решает
        // тот, кто вправе менять эту роль; без правды сервера — не предлагаем.
        if (!lockWhy && !truthLost) {
            card.appendChild(roleGrantReviewNotice(state.selected, perms, { onDone: () => { state.baseline = null; selectRole(state.selected); } }));
        }
```

Словарь:

```js
  "Убрать эти права": {"en":"Remove these rights","ru":"Убрать эти права","uz":"Bu huquqlarni olib tashlash"},   // ROLES_SAVE_TRUTH_V1
  "У роли есть права выше обычных для её основы: {list}. До этого обновления экран «Роли» мог выдать их сам — при любом сохранении роли. Если вы выдали их нарочно, оставьте как есть.": {"en":"The role has rights above the usual ones for its base: {list}. Before this update the «Roles» screen could grant them by itself — whenever the role was saved. If you granted them on purpose, keep them as they are.","ru":"У роли есть права выше обычных для её основы: {list}. До этого обновления экран «Роли» мог выдать их сам — при любом сохранении роли. Если вы выдали их нарочно, оставьте как есть.","uz":"Rolda uning asosi uchun odatdagidan yuqori huquqlar bor: {list}. Ushbu yangilanishgacha «Rollar» ekrani ularni o'zi berishi mumkin edi — rol har safar saqlanganda. Agar ularni ataylab bergan bo'lsangiz, o'z holicha qoldiring."},   // ROLES_SAVE_TRUTH_V1
  "Права убраны — решает основа роли.": {"en":"The rights are removed — the role's base decides now.","ru":"Права убраны — решает основа роли.","uz":"Huquqlar olib tashlandi — endi rol asosi hal qiladi."},   // ROLES_SAVE_TRUTH_V1
```

- [ ] **Шаг 4. Зелёный:** `node --test public/js/admin/__tests__/roles-grant-review.test.mjs public/js/admin/__tests__/roles-editor.test.mjs public/js/admin/__tests__/roles-save-truth.test.mjs public/js/admin/__tests__/roles-review.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
- [ ] **Шаг 5. Коммит:** новый модуль и тест, `roles-editor.js`,
  `roles-editor.test.mjs`, `settings-hub.js`; `admin.js`, `i18n-strings.js` —
  своими кусками. «Роли: плашка «Проверьте права этой роли» — «Убрать эти права» снимает только названные ключи, «Оставить как есть» — отметка; после решения не появляется (ROLES_SAVE_TRUTH_V1)».

### Задача 7. Карточка заявки: «Прослушать» только при `can_listen` (тест 7)

**Файлы:** `server/services/rpc/telephony.js`, `server/services/rpc/telephony.test.js`,
`public/js/admin/views/crm.js`, `public/js/admin/__tests__/crm-harness.mjs`,
`public/js/admin/__tests__/crm-lead-calls.test.mjs` (новый), `admin.js` (штамп
`crm.js?v=rst1`), словарь.

- [ ] **Шаг 1. Тесты.** `telephony.test.js`:

```js
// ROLES_SAVE_TRUTH_V1 — у каждой строки журнала can_listen: карточка рисует
// «Прослушать» только тому, кому нажатие не откажут (те же ворота crm.recording).
test('журнал в карточке говорит строке, можно ли её слушать (can_listen)', () => {
  const db = fresh();
  db.prepare("INSERT INTO calls (general_call_id, started_at, external_number, billsec, recording_url) VALUES ('1','2026-09-20T08:00:00Z','998901112233',42,'https://rec/1.mp3')").run();
  assert.equal(crmLeadCalls(db, { phone: '+998901112233' }, registrar)[0].can_listen, true, 'по прежнему правилу регистратура слушает');
  setGrants(db, 'registrar', { 'crm.calls': 'view', 'crm.recording': 'none' });
  const [row] = crmLeadCalls(db, { phone: '+998901112233' }, registrar);
  assert.equal(row.can_listen, false);
  assert.equal(row.recording_url, null);
});
```

`crm-harness.mjs`: в `S` — `leadCalls: []`; ответ RPC —
`if (name === 'crm_lead_calls') return jsonOk(S.leadCalls || []);`.
`crm-lead-calls.test.mjs`:

```js
// ROLES_SAVE_TRUTH_V1 (2026-09-29) — «Прослушать» в карточке заявки только тому,
// кому слушать можно (can_listen у каждой строки журнала — те же ворота, что
// у telephony_call_recording). Остальным — одна строка под списком: почему
// кнопки нет и где это право выдают (спецификация, п. 5, «Тесты», п. 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, mk, walk, textOf, byClass, tick } from './crm-harness.mjs';

const { renderCrm } = await import('../views/crm.js');

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const LEAD = { id: 1, full_name: 'Каримова Азиза', phone: '+998942846494', status: 'in_process', source: 'call',
  created_at: '2026-09-03T10:12:00Z', assigned_to: 12, users: { full_name: 'Оператор Лола' } };
const TALK = { id: 11, started_at: '2026-09-20T08:00:00Z', call_type: 0, billsec: 42, waitsec: 5, disposition: 'ANSWER',
  internal_number: '101', operator_name: 'Лола', recording_url: null, has_recording: true };
const DENIED = 'Слушать записи разговоров вашей роли не разрешено — право «Прослушать запись» в «Роли».';

async function card(calls) {
  window.easymed.state.user = ADMIN;
  S.leads = [LEAD];
  S.leadCalls = calls;
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  const c = byClass(root, 'crm-card')[0];
  c.dispatchEvent({ type: 'click', target: c, currentTarget: c, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно заявки не открылось');
  return modal;
}
const playButtons = (modal) => walk(modal).filter((n) => n.tagName === 'BUTTON' && /Прослушать/.test(textOf(n)));
const count = (s, part) => s.split(part).length - 1;

test('без права слушать: кнопки «Прослушать» нет, под списком — одна строка, где его выдают', async () => {
  const modal = await card([{ ...TALK, can_listen: false }, { ...TALK, id: 12, can_listen: false }]);
  assert.equal(playButtons(modal).length, 0, 'кнопка, которую сервер всё равно отклонит');
  assert.equal(count(textOf(modal), DENIED), 1, 'строки-пояснения нет или она у каждого звонка');
});

test('с правом слушать: «Прослушать» у каждого разговора, пояснения нет', async () => {
  const modal = await card([{ ...TALK, can_listen: true }, { ...TALK, id: 12, can_listen: true }]);
  assert.equal(playButtons(modal).length, 2);
  assert.equal(count(textOf(modal), DENIED), 0);
});

test('звонки без разговора: слушать нечего — ни кнопки, ни пояснения про право', async () => {
  const modal = await card([{ ...TALK, billsec: 0, can_listen: false }]);
  assert.equal(playButtons(modal).length, 0);
  assert.equal(count(textOf(modal), DENIED), 0);
  assert.ok(textOf(modal).includes('Разговора не было — записывать нечего.'));
});
```

- [ ] **Шаг 2. Красный:** `node --test server/services/rpc/telephony.test.js public/js/admin/__tests__/crm-lead-calls.test.mjs`

- [ ] **Шаг 3. Код.** `telephony.js` (`crmLeadCalls`, последняя строка):

```js
  // ROLES_SAVE_TRUTH_V1 — can_listen: те же ворота, что у прослушивания, чтобы
  // карточка рисовала «Прослушать» только тому, кому нажатие не откажут.
  return rows.map((c) => ({ ...c, recording_url: mayHear ? c.recording_url : null, has_recording: !!c.recording_url, can_listen: mayHear }));
```

`crm.js` (блок «Звонки по этому номеру»): перед циклом `let listenDenied = false;`,
в цикле `if (Number(c.billsec) > 0 && !c.can_listen) listenDenied = true;` и
кнопка — только при `Number(c.billsec) > 0 && c.can_listen`; после цикла:

```js
                if (listenDenied) {
                    callsList.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' }, dataset: { listenDenied: '1' } },
                        'Слушать записи разговоров вашей роли не разрешено — право «Прослушать запись» в «Роли».'));
                }
```

`admin.js`: `./admin/views/crm.js?v=rst1` (+ `ROLES_SAVE_TRUTH_V1` в хвосте строки).
Словарь:

```js
  "Слушать записи разговоров вашей роли не разрешено — право «Прослушать запись» в «Роли».": {"en":"Your role may not listen to call recordings — the «Listen to the recording» right in «Roles».","ru":"Слушать записи разговоров вашей роли не разрешено — право «Прослушать запись» в «Роли».","uz":"Rolingizga suhbat yozuvlarini tinglash ruxsat etilmagan — «Rollar»dagi «Yozuvni tinglash» huquqi."},   // ROLES_SAVE_TRUTH_V1
```

- [ ] **Шаг 4. Зелёный:** `node --test server/services/rpc/telephony.test.js public/js/admin/__tests__/crm-lead-calls.test.mjs public/js/admin/__tests__/crm-tasks.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
- [ ] **Шаг 5. Коммит.** «CRM, карточка заявки: «Прослушать» — только тому, кому слушать можно (can_listen), остальным — строка, где выдают право (ROLES_SAVE_TRUTH_V1)».

### Задача 8. EasyPhone: `may_hear` и отказ текстом (тест 7)

**Файлы:** `phone/index.js`, `phone/index.test.js`, `phone/public/app.js`,
`phone/public/index.html`, `phone/app.test.js` (новый), словарь.

- [ ] **Шаг 1. Тесты.** `phone/index.test.js`:

```js
// ROLES_SAVE_TRUTH_V1 — экран рисует «Прослушать» только тому, кому слушать можно:
// журнал говорит это одним флагом, теми же воротами, что у /api/recording.
test('журнал говорит экрану, можно ли слушать записи (may_hear); отказ журнала называет строку «Журнал звонков»', async () => {
  await withApp(async ({ get }) => {
    assert.equal((await (await get('/api/calls', 'watcher')).json()).may_hear, false);
    assert.equal((await (await get('/api/calls', 'listener')).json()).may_hear, true);
    assert.equal((await (await get('/api/calls', 'adm')).json()).may_hear, true);
    const denied = await (await get('/api/calls', 'dialer')).json();
    assert.match(denied.error.message, /«Журнал звонков»/);
  });
});
```

`phone/app.test.js`:

```js
// ROLES_SAVE_TRUTH_V1 (2026-09-29) — EasyPhone: «Прослушать» только тому, кому
// слушать можно (`may_hear` журнала); отказ станции или прав — текстом в
// строке, а не только в подсказке под мышью (спецификация, п. 5, «Тесты», п. 7).
import test from 'node:test';
import assert from 'node:assert/strict';

// Крошечная DOM ровно под phone/public/app.js.
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.style = {}; this.attrs = {}; this._t = ''; this._l = {}; this.hidden = false; this.disabled = false; this.className = ''; this.title = ''; this.value = ''; }
  appendChild(c) { const n = typeof c === 'string' ? new Txt(c) : c; n.parentNode = this; this.children.push(n); return n; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  replaceWith(n) { const p = this.parentNode; const i = p.children.indexOf(this); p.children.splice(i, 1, n); n.parentNode = p; this.parentNode = null; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  click() { for (const fn of this._l.click || []) fn({ type: 'click', preventDefault() {} }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  querySelector() { return new El('span'); }
  set innerHTML(v) { this.children = []; this._t = ''; const text = String(v || '').replace(/<[^>]*>/g, ''); if (text) this.appendChild(new Txt(text)); }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._t = String(v); this.children = []; }
}
class Txt extends El { constructor(t) { super('#text'); this._t = String(t); } }
const walk = (e, o = []) => { o.push(e); for (const c of e.children) walk(c, o); return o; };
const buttons = (el) => walk(el).filter((n) => n.tagName === 'BUTTON');

let ids = {};
globalThis.document = {
  createElement: (t) => new El(t),
  getElementById: (id) => ids[id] || (ids[id] = new El('div')),
  querySelector: () => null,
  addEventListener() {},
};
globalThis.setInterval = () => 0;   // экран обновляется сам — в тесте незачем
const flush = () => new Promise((r) => setTimeout(r, 25));

const CALL = { id: 5, started_at: new Date().toISOString(), call_type: 0, external_number: '998901112233', internal_number: '101',
  billsec: 42, patient_name: 'Каримова Азиза', has_recording: true, recording_url: null };
let reply = () => ({ status: 404, body: {} });
globalThis.fetch = async (path) => {
  const r = reply(String(path));
  return { ok: r.status < 400, status: r.status, json: async () => r.body };
};
async function boot(name, { mayHear, recording }) {
  ids = {};
  reply = (path) => {
    if (path === '/api/me') return { status: 200, body: { id: 1, full_name: 'Оператор', extension: '', line: null, seen_extensions: [] } };
    if (path === '/api/extensions') return { status: 200, body: { extensions: [] } };
    if (path.startsWith('/api/calls')) return { status: 200, body: { may_hear: mayHear, calls: [CALL] } };
    if (path.startsWith('/api/recording')) return recording;
    return { status: 404, body: { error: { message: 'нет такого маршрута' } } };
  };
  await import('./public/app.js?case=' + name);
  await flush();
  return { rec: ids.rows.children[0].children[5], note: ids.recNote };
}

test('без права слушать: «Прослушать» не рисуется, под журналом сказано почему', async () => {
  const { rec, note } = await boot('deny', { mayHear: false });
  assert.equal(buttons(rec).length, 0, 'кнопка «Прослушать» у того, кому слушать нельзя');
  assert.equal(note.hidden, false, 'не сказано, почему нет кнопки');
  assert.match(note.textContent, /«Прослушать запись»/);
});

test('с правом — кнопка есть; отказ виден текстом в строке, кнопку можно нажать снова', async () => {
  const message = 'Слушать записи — недоступно вашей роли. Права выдаёт администратор в «Настройки → Роли».';
  const { rec, note } = await boot('allow', { mayHear: true, recording: { status: 403, body: { error: { message } } } });
  assert.equal(note.hidden, true);
  const [b] = buttons(rec);
  assert.ok(b && b.textContent === 'Прослушать', 'кнопки «Прослушать» нет');
  b.click();
  await flush();
  assert.ok(rec.textContent.includes(message), 'причина отказа не видна в строке: ' + rec.textContent);
  assert.equal(b.textContent, 'Прослушать', 'кнопка осталась «Не вышло» — повторить нельзя');
});
```

- [ ] **Шаг 2. Красный:** `node --test phone/index.test.js phone/app.test.js`

- [ ] **Шаг 3. Код.** `phone/index.js`: отказ журнала —
  `'Журнал звонков открыт тем, кому выдано право «Журнал звонков» («Настройки → Роли»).'`;
  `/api/calls` → `res.json({ may_hear: mayHear, calls: … })` (с комментарием
  ROLES_SAVE_TRUTH_V1). `phone/public/app.js` (`loadCalls`):

```js
  const { calls, may_hear: mayHear } = await api('/api/calls?limit=60');
  const rows = $('rows');
  rows.innerHTML = '';
  // ROLES_SAVE_TRUTH_V1 — почему нет «Прослушать»: одной строкой под журналом.
  const note = $('recNote');
  note.textContent = 'Слушать записи разговоров вашей роли не разрешено — право «Прослушать запись» в «Роли».';
  note.hidden = !!mayHear || !calls.some((c) => Number(c.billsec) > 0);
  …
    const rec = document.createElement('td');
    if (answered && mayHear) {
      const b = document.createElement('button');
      b.textContent = 'Прослушать';
      // ROLES_SAVE_TRUTH_V1 — отказ и ошибка текстом в строке, а не в подсказке.
      const why = document.createElement('div');
      why.className = 'rec-msg';
      b.addEventListener('click', async () => {
        holdUntil = Date.now() + 60000;
        b.disabled = true; b.textContent = 'Ищем…'; why.textContent = '';
        try {
          const r = await api('/api/recording?call_id=' + encodeURIComponent(c.id));
          if (!r.url) { b.textContent = 'Записи нет'; return; }
          const a = document.createElement('audio');
          a.controls = true; a.autoplay = true; a.src = r.url;
          b.replaceWith(a);
        } catch (e) { b.textContent = 'Прослушать'; why.textContent = e.message; }
        finally { b.disabled = false; }
      });
      rec.appendChild(b);
      rec.appendChild(why);
    } else {
      rec.textContent = '—';
    }
```

`phone/public/index.html`: под таблицей журнала
`<p class="rec-note" id="recNote" hidden></p>`, стили
`.rec-note { margin: 0; padding: 10px 16px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted); }`
и `.rec-msg { margin-top: 4px; font-size: 12.5px; color: var(--stop); }`.
Словарь:

```js
  "Журнал звонков открыт тем, кому выдано право «Журнал звонков» («Настройки → Роли»).": {"en":"The call log is open to those granted the «Call log» right («Settings → Roles»).","ru":"Журнал звонков открыт тем, кому выдано право «Журнал звонков» («Настройки → Роли»).","uz":"Qo‘ng‘iroqlar jurnali «Qo‘ng‘iroqlar jurnali» huquqi berilganlarga ochiq («Sozlamalar → Rollar»)."},   // ROLES_SAVE_TRUTH_V1
```

- [ ] **Шаг 4. Зелёный:** `node --test phone/index.test.js phone/app.test.js public/js/admin/__tests__/i18n-coverage.test.mjs`
- [ ] **Шаг 5. Коммит.** «EasyPhone: «Прослушать» только при may_hear, отказ и ошибка — текстом в строке журнала (ROLES_SAVE_TRUTH_V1)».

### Задача 9. «Журнал звонков» в «Ролях» (п. 5 спецификации, тест 8)

**Файлы:** `public/js/shared/permission-catalog.js`, словарь.

- [ ] **Шаг 1.** Справочник (`crm.calls`):

```js
      { key: 'crm.calls', label: 'Журнал звонков', desc: 'Журнал звонков этого человека в карточке заявки: кто звонил, когда и сколько говорили. Слушать записи — отдельная строка «Прослушать запись».', levels: ['none', 'view'], enforced: 'rpc:crm_lead_calls' },
```

- [ ] **Шаг 2. Красный:** `node --test public/js/admin/__tests__/i18n-coverage.test.mjs`
  → «строки справочника прав про работу оператора»: `crm.calls  "Журнал звонков"`.
- [ ] **Шаг 3.** В словаре две прежние записи (`"Звонки и записи разговоров"`,
  прежнее описание) заменены:

```js
  "Журнал звонков": {"en": "Call log", "ru": "Журнал звонков", "uz": "Qo‘ng‘iroqlar jurnali"},   // ROLES_SAVE_TRUTH_V1 — была «Звонки и записи разговоров»: журнал записи не открывает
  "Журнал звонков этого человека в карточке заявки: кто звонил, когда и сколько говорили. Слушать записи — отдельная строка «Прослушать запись».": {"en": "This person’s call log inside the lead card: who called, when, and how long they talked. Listening to recordings is a separate row — «Listen to the recording».", "ru": "Журнал звонков этого человека в карточке заявки: кто звонил, когда и сколько говорили. Слушать записи — отдельная строка «Прослушать запись».", "uz": "Shu odamning ariza kartochkasidagi qo‘ng‘iroqlar jurnali: kim qo‘ng‘iroq qilgan, qachon va qancha gaplashgan. Yozuvlarni tinglash — alohida qator: «Yozuvni tinglash»."},   // ROLES_SAVE_TRUTH_V1
```

- [ ] **Шаг 4. Зелёный:** `node --test public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/roles-editor.test.mjs phone/index.test.js`
- [ ] **Шаг 5. Коммит:** `permission-catalog.js`; `i18n-strings.js` — своим куском.
  «Роли: строка crm.calls — «Журнал звонков», в описании — слушать записи отдельной строкой (ROLES_SAVE_TRUTH_V1)».

### Задача 10. Полный прогон и сквозная проверка

- [ ] `npm test` один раз — точные числа в отчёт (известный долгий файл —
  `server/services/rpc/index.test.js`, ~2 мин 41 с).
- [ ] Стенд Playwright из scratchpad: `node rec-vitals-widen.mjs`,
  `node rec-crmall-save.mjs` — `crm.all` не записан, оператор чужую заявку не
  читает; `admission_vitals_add` регистратора после пустого сохранения — 403.

## Самопроверка плана по спецификации

| Пункт спецификации | Где |
|---|---|
| §1 RPC, псевдо-пользователь, кто спрашивает, лицензия | задача 1 |
| §2 экран: правда сервера поверх догадки, записанное — всё; только чтение при сбое | задача 4 |
| §3 пишется записанное и отличное от показанного; закрыли/открыли раздел; старые поля из всех показанных; «Изменено?» тем же `collect()`; подпись `collectGrants(…, { explicit, closed, initial })`; защита «Ролей» не меняется | задачи 3–4 |
| §4 миграция 230, стандарты = `fallbackLevel`, `INSERT OR IGNORE`, права не меняются; плашка, «Убрать» / «Оставить», реестр | задачи 5–6 |
| §5 `can_listen`; EasyPhone `may_hear` и текст ошибки; «Журнал звонков» | задачи 7–9 |
| Тесты 1 / 2–5 / 6 / 7 / 8 | задачи 1 / 2+4 / 5+6 / 7+8 / 1, 4–9 |

## Исполнение: что разошлось с планом

- **Задача 4, стенд (тест 3).** «Старшему кассиру» миграция 218 записала все
  три его строки, и незаписанного окна под открытым разделом у него нет.
  Выбор ключа в `touchable` теперь ранжирует: сначала незаписанное с
  воротами, потом любое незаписанное, и только потом записанное; проверка та
  же — `grants` = прежние + ровно новое значение тронутого ключа.
- **Задача 6, стенд.** В `roles-save-truth.test.mjs` добавлен пятый тест —
  плашка миграции 230 сквозь настоящий сервер: расширенный оператор →
  миграция → плашка → «Убрать эти права» → `crm.all` снят, `restored`,
  `resolved_by` из сессии, плашки нет, чужая заявка оператору не видна.
  Миграция на этом стенде ставит на проверку и синтетическую роль «Записанные
  ключи» (её `crm.all`, отметки, измерения и выдача выше основы-регистратора)
  — так и должно быть; проверка сужена до строки оператора.

### Ревью (4 Major + 4 minor), исправлено тестом вперёд

- **M1.** Правка семьи раздела писала строки с воротами по списку ролей
  (16 ключей `GATE_FALLBACK`) — у регистратуры и кассы «Услуги в стационаре:
  Просмотр» отнимали добавление услуги у койки. Флаг `roleListGate` в
  справочнике (тест: флаги = `Object.keys(GATE_FALLBACK)`), `movedFamilyKeys`
  их пропускает. Оговорка: у раздела, записанного «Нет», строки рисуются
  такими, какими станут, если раздел открыть, — RPC отвечает `if_open`.
- **M2.** Плитки «Настроек» без своих ворот (не `adminDefault`, не
  `FALLBACK_FN`) RPC больше не называет — экран рисует их правилом оболочки.
- **M3.** Плашку миграции 230 видит и решает только администратор.
- **M4.** Миграция 230 ставит на проверку и ключи `FALLBACK_FN`: стандарт
  считается по разделам самой роли (CTE `legacy`/`fn`), тест сверяет его с
  `fallbackLevel` на всех состояниях разделов. Кроме «Оплаты врачей» тот же
  класс нашёлся у раздела «Закупки» (старый экран выводил `edit` из «Склада»,
  ворота заявок всех отделов — администратор и снабженец) — тоже на проверке.
- **m1.** `role_grant_reviews` в реестре — только администратору (без
  `write.grant`). **m2.** В филиале строки проверки через `/api/db` не видны
  (`read.where`). **m5.** Записанный ключ без строки на экране переносится как
  есть. **m8.** «Восстановлено» — только у снятых ключей.
- **Оставлено как известное:** m3 (строки закрытого раздела пустое сохранение
  пишет «Нет» — по замыслу), m4 (записанный уровень вне уровней строки), m6
  (`settings.departments`), m7 (соседние разделы с общим старым ключом:
  `mar.*` у раздела, закрытого явно, и соседи кассы — было до выпуска).
