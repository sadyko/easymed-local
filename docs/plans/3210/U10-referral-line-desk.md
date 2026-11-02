# U10a + U10b. Бонус врачу за направление — по строке (REFERRAL_LINE_V1) и «Направления врача» в окне регистрации (DOCTOR_REFERRAL_DESK_V1) — план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (или executing-plans). Шаги — чекбоксы `- [ ]`.

**Goal (U10a):** направивший — признак СТРОКИ визита (`visit_services.referred_by_source_id`, ставит сервер), и вознаграждение по оплаченной строке получают ОБА: источник визита/пациента (как прежде) и источник строки, если он другой; тот же источник — один раз; своя строка врача — без бонуса; закрытые месяцы не двигаются. «Реферирование» считает направления и по строкам. Надпись «начисляется при выполнении» — правда («когда счёт оплачен»).

**Goal (U10b):** регистратура видит направления врача пациента (сегодня и вперёд, своё здание) отдельной группой «Направления врача» в быстрой регистрации и в мастере визита: невыставленные сегодняшние — готовые строки (путь строк «из записи», R7a), выставленные — «ждёт оплаты в кассе, счёт № …», рекомендации врача — «Добавить» (сервер закрывает рекомендацию и ставит направившего). Мастер направления врача — поле «Рекомендация для регистратуры». В календаре — метка «от врача».

**Architecture:**
- Миграция 270: `visit_services.referred_by_source_id` (FK `referral_sources`), `visit_services.referral_note` (CHECK ≤ 500), частичный индекс; `recommended_services.visit_service_id` (FK, `ON DELETE SET NULL`) — какой строкой закрыта рекомендация (нужно, чтобы «Внутренние врачи» не считали одно направление дважды).
- Новый модуль `server/services/domain/line-referral.js`: `lineReferralStamp(db, user, row)` (кто ставит) и `lineBeneficiaries(base, line, performer)` (кому платить) — одно правило на дверь `/api/db`, отчёты и окно регистрации.
- Штамп реестра с вычислением: `visit_services.stamps.referred_by_source_id = { on: 'insert', resolve: 'line_referral' }`. Компилятор (`server/db/query-compiler.js` `stampValues`) зовёт резолвер; колонки НЕТ ни в одном списке записи (врач её не пишет никогда; стойка — только явно, через тот же резолвер; правкой — никто). `routes/db.js` не меняется.
- `reports.js` `referralLines`: на строку счёта — список получателей (`lineBeneficiaries`), каждый своей строкой; ключ закрытого месяца уже «строка счёта | получатель». Все потребители (`Рефералы`, детализация, кабинет врача, «Зарплаты врачей», закрытие месяца, корректировки, «Реферирование») берут строки отсюда.
- `rpc/referrals.js`: «Внутренние врачи» — рекомендации + строки (без строк, которыми закрыта рекомендация); внешние экраны — визиты по источнику визита ИЛИ строки.
- Новый `server/services/rpc/referral-orders.js`: `patient_referral_orders` (чтение), `referral_recommendation_attach` (запись), `referral_visit_links` (чтение, метка календаря); оба чтения — в `READ_ONLY_RPCS`.
- Клиент: `public/js/admin/doctor-orders.js` (одно чтение и подписи на оба окна, без DOM); `fast-registration.js` + `walk-in-booking.js`; `visit-wizard.js`; `visit-modal.js` (рекомендация закрывается сервером); `room-calendar.js` (метка).

**Сверено с кодом (поправки к фактам задания):**
- `created_by` строки визита сервер ставит сам (`schema-registry.js` `stamps`, `query-compiler.js` `stampValues` ~:799); `compileUpsert` штампов не ставит вовсе — значит колонка вне списков записи через upsert не пишется никем.
- Внутренний источник врача заводит триггер мигр. 122 ТОЛЬКО для `role = 'doctor'` (`referral_sources_for_new_doctor`), один на врача (UNIQUE `idx_referral_sources_doctor`). У администратора-врача (`role = 'admin'`, `is_doctor = 1`) источника нет — ставить нечего.
- Ветка `visit_services` в обмене зданий — только `quantity`, `status` (`branch-sync/journal.js` `SHIPPED`); новые колонки — местные (id `referral_sources` у соседа другой), журнал-триггеры мигр. 084 их не видят. Решение — комментарием в `journal.js`.
- `test-data-wipe-plan.js` решает по ТАБЛИЦАМ: `visit_services`, `recommended_services` — `delete`, `referral_sources` — `keep`; новые FK (`visit_services → referral_sources`, `recommended_services → visit_services ON DELETE SET NULL`) проверку `danglingRefs` проходят. Правка не нужна — только прогон теста.
- «Полной выгрузки/загрузки» строк визита нет (`section-import-export.js` их не знает, копия базы — файлом). Правка не нужна.
- `ensure_visit` ставит `referral_source_id` только новому визиту (`rpc/visits.js` ~:268-281) — не меняем: строка несёт своего направившего.
- `visit_set_doctor_referrer` (REPORTS_V2) по-прежнему ставит врача ИСТОЧНИКОМ ВИЗИТА, если у визита и пациента его нет — не меняем (см. «Риски»).

## Карта файлов

| Файл | Что |
|---|---|
| `server/db/migrations/270_referral_line.sql`, `270.test.js` | новые: колонки, индексы |
| `server/services/branch-sync/journal.js` | комментарий: новые колонки не ездят |
| `server/services/domain/line-referral.js`, `line-referral.test.js` | новые: штамп и получатели |
| `server/db/schema-registry.js` | `visit_services`: чтение двух колонок, вставка `referral_note`, штамп-резолвер; `recommended_services`: чтение `visit_service_id` |
| `server/db/query-compiler.js` | `stampValues` понимает `resolve` |
| `server/db/schema-registry.test.js` | + проверка реестра |
| `server/routes/referral-line-stamp.test.js` | новый: дверь `/api/db` на настоящем приложении |
| `server/services/rpc/billing.js` | «возврат с новой услугой» переносит направившего |
| `server/services/rpc/refund-swap-rebill.test.js` | + тест |
| `server/services/rpc/reports.js` | `referralLines`, `lineSourcesOf`, примечание; журнал: источник строки |
| `server/services/rpc/reports.referral-line.test.js` | новый |
| `server/services/rpc/reports.v2.test.js` | правка ожидания I7 (вид отбора в SQL) |
| `server/services/rpc/referrals.js` | «Внутренние врачи», подробности врача, внешние экраны |
| `server/services/rpc/referrals.line.test.js` | новый |
| `server/services/domain/journal-rules.js`, `journal-rules.test.js` | `referrerOf`: источник строки первым |
| `server/services/rpc/referral-autofill.js` | только комментарий |
| `public/js/admin/views/service-workspace.js` | надпись о бонусе |
| `public/js/admin/views/referral-line-texts.test.js` | новый (текстом файлов) |
| `server/services/rpc/referral-orders.js` | новый: три RPC |
| `server/routes/doctor-referral-desk.test.js` | новый |
| `server/services/rpc/index.js`, `server/services/control/gate.js` | регистрация, чтения |
| `public/js/admin/views/act-as-history.js` | подписи трёх RPC |
| `public/js/admin/doctor-orders.js`, `__tests__/doctor-orders.test.mjs` | новые |
| `public/js/admin/views/walk-in-booking.js` | «Код отправителя» в строку, рекомендация |
| `public/js/admin/views/fast-registration.js` | группа, готовые строки, «Добавить» |
| `public/js/admin/__tests__/doctor-orders-desk-live.test.mjs` | новый (настоящий сервер) |
| `public/js/admin/views/visit-wizard.js` | группа, строка «от врача», поле рекомендации, источник строки, привязка |
| `public/js/admin/views/visit-modal.js` | рекомендация закрывается сервером |
| `public/js/admin/views/doctor-orders-wizard.test.js` | новый (текстом файлов) |
| `public/js/admin/views/room-calendar.js`, `__tests__/room-calendar.test.mjs` | метка «от врача» |
| `public/js/admin/i18n-strings.js` | блоки `// REFERRAL_LINE_V1` и `// DOCTOR_REFERRAL_DESK_V1` |

**Общее.** Все команды — из корня `C:\Users\user\Desktop\implementation workflow\easymed.api5`. Тесты — `node --experimental-vm-modules --test <файлы>` (явные пути). Правки — инструментами Edit/Write, привязка к ТЕКСТУ (номера строк приблизительные; U5/U6/U8/U9 правят те же файлы раньше — если «было» не находится дословно, найти то же место по смыслу и сохранить обе правки). Сообщение коммита пишется инструментом Write в `.git/U10_MSG.txt` (внутри `.git` — не в индексе), коммит `git commit -F .git/U10_MSG.txt`; перед `git add` — `git diff --cached --name-only` пуст. Словарь: новые статьи — перед последней строкой файла `};` (единственная строка, равная `};`), каждый блок со своей меткой; чужие блоки не трогать. Маркеры в русских комментариях: `REFERRAL_LINE_V1` (U10a), `DOCTOR_REFERRAL_DESK_V1` (U10b).

Порядок: U10a.1 → … → U10a.8 → U10b.1 → … → U10b.9.

---

## U10a — REFERRAL_LINE_V1

### Task U10a.1: миграция 270 — направивший строки, рекомендация для регистратуры, связь рекомендации со строкой

**Files:**
- Create: `server/db/migrations/270_referral_line.sql`, `server/db/migrations/270.test.js`
- Modify: `server/services/branch-sync/journal.js` (комментарий)

- [ ] **Step 1: failing test** — создать `server/db/migrations/270.test.js`:

```js
// REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1 — миграция 270: направивший строки визита,
// рекомендация врача для регистратуры, строка, которой закрыта рекомендация.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Тест')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1, 1, '2026-11-02T09:00:00Z')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'УЗИ', 100)").run();
  const src = Number(db.prepare("INSERT INTO referral_sources (name) VALUES ('Партнёр')").run().lastInsertRowid);
  return { db, src };
}

test('мигр. 270: колонки и индексы на месте, у прежних строк пусто', () => {
  const { db } = fresh();
  const vs = db.prepare('PRAGMA table_info(visit_services)').all().map((c) => c.name);
  assert.ok(vs.includes('referred_by_source_id'));
  assert.ok(vs.includes('referral_note'));
  const rs = db.prepare('PRAGMA table_info(recommended_services)').all().map((c) => c.name);
  assert.ok(rs.includes('visit_service_id'));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_visit_services_referred_by'));
  assert.ok(idx.includes('idx_recommended_services_vs'));
  const id = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (1, 1, 'added')").run().lastInsertRowid);
  assert.deepEqual(db.prepare('SELECT referred_by_source_id, referral_note FROM visit_services WHERE id = ?').get(id),
    { referred_by_source_id: null, referral_note: null });
});

test('мигр. 270: источник строки — существующий источник; рекомендация не длиннее 500 знаков', () => {
  const { db, src } = fresh();
  db.prepare("INSERT INTO visit_services (visit_id, service_id, status, referred_by_source_id, referral_note) VALUES (1, 1, 'added', ?, 'натощак')").run(src);
  assert.throws(() => db.prepare("INSERT INTO visit_services (visit_id, service_id, status, referred_by_source_id) VALUES (1, 1, 'added', 99999)").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO visit_services (visit_id, service_id, status, referral_note) VALUES (1, 1, 'added', ?)").run('x'.repeat(501)), /CHECK/);
  db.prepare("INSERT INTO visit_services (visit_id, service_id, status, referral_note) VALUES (1, 1, 'added', ?)").run('ж'.repeat(500));
});

test('мигр. 270: удалённая строка визита снимает ссылку рекомендации, рекомендация остаётся', () => {
  const { db } = fresh();
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (1, 1, 'added')").run().lastInsertRowid);
  const rec = Number(db.prepare("INSERT INTO recommended_services (patient_id, service_id, status, visit_service_id) VALUES (1, 1, 'done', ?)").run(vs).lastInsertRowid);
  db.prepare('DELETE FROM visit_services WHERE id = ?').run(vs);
  assert.deepEqual(db.prepare('SELECT status, visit_service_id FROM recommended_services WHERE id = ?').get(rec), { status: 'done', visit_service_id: null });
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/db/migrations/270.test.js`
  Ожидается FAIL: `includes('referred_by_source_id')` — false (колонки нет).

- [ ] **Step 3: implement** — создать `server/db/migrations/270_referral_line.sql`:

```sql
-- REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1 (мигр. 270, 2026-11-02, выпуск 3.21.0).
--
-- НАПРАВИВШИЙ — ПРИЗНАК СТРОКИ, А НЕ ТОЛЬКО ВИЗИТА. До сих пор направивший был у
-- визита (visits.referral_source_id, иначе у карточки пациента), и ensure_visit ставил
-- его только при СОЗДАНИИ визита: врач направил пациента на УЗИ в день, когда у того
-- уже был визит (его собственная консультация), — направивший молча терялся (dev:
-- врач №18, 4 выставленные строки, бонус 0). Решение владельца 2026-11-02 — «бонус
-- обоим»: партнёр, приведший пациента, получает своё, врач, направивший на услугу, —
-- своё за строки, на которые направил.
--
--   visit_services.referred_by_source_id — внутренний источник направившего врача (или
--     источник «Кто направил» стойки). Ставит СЕРВЕР (domain/line-referral.js через штамп
--     реестра); через /api/db браузер его не пишет ни вставкой, ни правкой. Пусто — у всех
--     строк до этой миграции: прошлые строки не дозаполняются (закрытые месяцы не двигаются).
--     Без ON DELETE: источники не удаляют, их выключают (active = 0).
--   visit_services.referral_note — «Рекомендация для регистратуры» из мастера направления
--     врача (натощак, к какому часу…). Не длиннее 500 знаков (CHECK — запасной замок).
--   recommended_services.visit_service_id — строка, которой рекомендацию закрыли
--     (referral_recommendation_attach). «Реферирование → Внутренние врачи» считает такую
--     строку той же рекомендацией, а не вторым направлением. Пишет только сервер.
--
-- По филиалам ничего нового не ездит (branch-sync/journal.js SHIPPED): id источника у
-- соседа другой, а вознаграждение считает здание, выставившее счёт.
ALTER TABLE visit_services ADD COLUMN referred_by_source_id INTEGER REFERENCES referral_sources(id);
ALTER TABLE visit_services ADD COLUMN referral_note TEXT CHECK (referral_note IS NULL OR length(referral_note) <= 500);
CREATE INDEX idx_visit_services_referred_by ON visit_services(referred_by_source_id) WHERE referred_by_source_id IS NOT NULL;
ALTER TABLE recommended_services ADD COLUMN visit_service_id INTEGER REFERENCES visit_services(id) ON DELETE SET NULL;
CREATE INDEX idx_recommended_services_vs ON recommended_services(visit_service_id) WHERE visit_service_id IS NOT NULL;
```

В `server/services/branch-sync/journal.js` заменить

```js
  visits: ['visit_date', 'duration_minutes', 'visit_kind', 'visit_type', 'status', 'notes', 'booked_at'],
  visit_services: ['quantity', 'status'],
```

на

```js
  visits: ['visit_date', 'duration_minutes', 'visit_kind', 'visit_type', 'status', 'notes', 'booked_at'],
  // REFERRAL_LINE_V1 (мигр. 270) — referred_by_source_id и referral_note НЕ ЕЗДЯТ: id
  // источника направления у соседа другой (справочник источников не синхронизируется), а
  // вознаграждение за строку считает здание, выставившее счёт. Окно регистрации видит
  // направления только своего здания.
  visit_services: ['quantity', 'status'],
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/db/migrations/270.test.js server/db/schema-registry-conformance.test.js server/services/test-data-wipe-plan.test.js server/services/branch-sync/journal.test.js server/db/migration-order.test.js`
  Ожидается PASS (все).

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10a.1: миграция 270 — направивший у строки визита

visit_services.referred_by_source_id (ставит сервер) и referral_note
(рекомендация врача для регистратуры, не длиннее 500 знаков),
recommended_services.visit_service_id — какой строкой закрыта
рекомендация. Прошлые строки не дозаполняются. В обмен зданий колонки
не идут (комментарий в journal.js).

REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/db/migrations/270_referral_line.sql server/db/migrations/270.test.js server/services/branch-sync/journal.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10a.2: `domain/line-referral.js` — кто ставит направившего строки и кому платить

**Files:**
- Create: `server/services/domain/line-referral.js`, `server/services/domain/line-referral.test.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: failing test** — создать `server/services/domain/line-referral.test.js`:

```js
// REFERRAL_LINE_V1 — правило «кто ставит направившего строки» и «кому вознаграждение за строку».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { lineReferralStamp, lineBeneficiaries, isDeskActor, isDoctorActor, LineReferralError } from './line-referral.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 1);
  u.run(2, 'reg', 'x', 'registrar', 'Регистратор', 0);
  u.run(10, 'doc', 'x', 'doctor', 'Иванов', 1);    // триггер мигр. 122 заводит внутренний источник
  u.run(12, 'doc2', 'x', 'doctor', 'Петров', 1);
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (900, 'Партнёр')").run();
  db.prepare("INSERT INTO referral_sources (id, name, active) VALUES (901, 'Выключен', 0)").run();
  const src = (id) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(id).id;
  return { db, src };
}
const doctor = { id: 10, role: 'doctor', extra_roles: [], is_doctor: true };
const registrar = { id: 2, role: 'registrar', extra_roles: [], is_doctor: false };
const adminDoctor = { id: 1, role: 'admin', extra_roles: [], is_doctor: true };
const nurse = { id: 5, role: 'nurse', extra_roles: [] };

test('кто есть кто: стойка — администратор и регистратура (и дополнительной ролью); врач — флаг или роль', () => {
  assert.equal(isDeskActor(registrar), true);
  assert.equal(isDeskActor({ id: 3, role: 'doctor', extra_roles: ['registrar'] }), true);
  assert.equal(isDeskActor(doctor), false);
  assert.equal(isDoctorActor(doctor), true);
  assert.equal(isDoctorActor({ id: 4, role: 'nurse', extra_roles: ['head_doctor'] }), true);
  assert.equal(isDoctorActor(nurse), false);
});

test('врач: свой включённый источник, присланное браузером не читается; своя строка — пусто', () => {
  const { db, src } = fresh();
  assert.equal(lineReferralStamp(db, doctor, { doctor_id: 12, referred_by_source_id: 900 }), src(10));
  assert.equal(lineReferralStamp(db, doctor, { doctor_id: null }), src(10));
  assert.equal(lineReferralStamp(db, doctor, { doctor_id: 10 }), null);
  db.prepare('UPDATE referral_sources SET active = 0 WHERE doctor_id = 10').run();
  assert.equal(lineReferralStamp(db, doctor, { doctor_id: 12 }), null);
});

test('стойка: только явно; неверный или выключенный — отказ словами; источник самого исполнителя — пусто', () => {
  const { db, src } = fresh();
  assert.equal(lineReferralStamp(db, registrar, { doctor_id: 12 }), null);
  assert.equal(lineReferralStamp(db, registrar, { referred_by_source_id: '' }), null);
  assert.equal(lineReferralStamp(db, registrar, { referred_by_source_id: 900 }), 900);
  assert.equal(lineReferralStamp(db, registrar, { referred_by_source_id: '900' }), 900);
  assert.throws(() => lineReferralStamp(db, registrar, { referred_by_source_id: 'abc' }),
    (e) => e instanceof LineReferralError && e.status === 400);
  assert.throws(() => lineReferralStamp(db, registrar, { referred_by_source_id: 901 }), /не найден или выключен/);
  assert.throws(() => lineReferralStamp(db, registrar, { referred_by_source_id: 99999 }), /не найден или выключен/);
  assert.equal(lineReferralStamp(db, registrar, { doctor_id: 12, referred_by_source_id: src(12) }), null);
  // Администратор-врач — стойка: свой источник сам не ставится (и его у него нет: триггер мигр. 122 — только role 'doctor').
  assert.equal(lineReferralStamp(db, adminDoctor, { doctor_id: 12 }), null);
});

test('прочие роли и вызов без базы или без сессии — пусто', () => {
  const { db } = fresh();
  assert.equal(lineReferralStamp(db, nurse, { referred_by_source_id: 900 }), null);
  assert.equal(lineReferralStamp(null, registrar, { referred_by_source_id: 900 }), null);
  assert.equal(lineReferralStamp(db, null, { referred_by_source_id: 900 }), null);
});

test('кому вознаграждение: источник визита/пациента — как прежде; источник строки — ещё и ему, если другой и строка не его', () => {
  const P = { id: 900, doctor_id: null };
  const S1 = { id: 5, doctor_id: 10 };
  const S1copy = { id: 6, doctor_id: 10 };   // тот же сотрудник другим источником
  const via = (list) => list.map((b) => b.via + ':' + b.source.id);
  assert.deepEqual(via(lineBeneficiaries(P, null, 12)), ['visit:900']);
  assert.deepEqual(via(lineBeneficiaries(null, S1, 12)), ['line:5']);
  assert.deepEqual(via(lineBeneficiaries(P, S1, 12)), ['visit:900', 'line:5']);
  assert.deepEqual(via(lineBeneficiaries(S1, S1, 12)), ['visit:5']);
  assert.deepEqual(via(lineBeneficiaries(S1, S1copy, 12)), ['visit:5']);
  assert.deepEqual(via(lineBeneficiaries(P, S1, 10)), ['visit:900'], 'своя строка врача — без бонуса источнику строки');
  assert.deepEqual(via(lineBeneficiaries(null, null, null)), []);
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/domain/line-referral.test.js`
  Ожидается FAIL: `Cannot find module '.../line-referral.js'`.

- [ ] **Step 3: implement** — создать `server/services/domain/line-referral.js`:

```js
// REFERRAL_LINE_V1 (2026-11-02, выпуск 3.21.0; решение владельца — «бонус обоим»)
// НАПРАВИВШИЙ НА СТРОКЕ ВИЗИТА: visit_services.referred_by_source_id (мигр. 270).
//
// Прежде направивший был признаком ВИЗИТА (visits.referral_source_id, иначе карточки
// пациента), и ensure_visit ставил его только при СОЗДАНИИ визита: направление врача в
// день, когда у пациента уже был визит (его собственная консультация), теряло
// направившего — dev: врач №18, 4 выставленные строки, бонус 0.
//
// КТО СТАВИТ — lineReferralStamp, одно место: компилятор /api/db (штамп реестра
// `resolve: 'line_referral'`, db/query-compiler.js stampValues):
//   • стойка (администратор, регистратура — и дополнительной ролью) — ТОЛЬКО ЯВНО:
//     «Кто направил» мастера визита, «Код отправителя» быстрой регистрации. Источник
//     обязан существовать и быть включён, иначе отказ словами; не прислала — пусто.
//     Администратор-врач у стойки — стойка: свой источник сам не ставится;
//   • врач (is_doctor или роль врача / главного врача) без роли стойки — САМ СЕРВЕР:
//     его включённый внутренний источник (referral_sources.doctor_id, мигр. 122).
//     Присланное браузером врача значение не читается вовсе — иначе врач засчитывал бы
//     себе или коллеге чужую работу;
//   • своя строка — пусто: исполнитель строки — сам врач источника.
// Остальные роли строк визита через /api/db не вставляют (реестр).
//
// КОМУ ВОЗНАГРАЖДЕНИЕ — lineBeneficiaries, одно правило на отчёты (rpc/reports.js
// referralLines) и окно регистрации (rpc/referral-orders.js «кому бонус»): источник
// визита/пациента — как прежде; источник строки — ЕЩЁ И ЕМУ, если он другой (не тот же
// источник и не тот же сотрудник) и строка не своя для врача источника строки.
import { hasAnyRole } from '../roles.js';

export class LineReferralError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const DESK_ROLES = Object.freeze(['admin', 'registrar']);
export const DOCTOR_ROLES = Object.freeze(['doctor', 'head_doctor']);
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** Стойка: администратор или регистратура (основной или дополнительной ролью). */
export function isDeskActor(user) { return hasAnyRole(user, DESK_ROLES); }

/** Врач: признак is_doctor (ADMIN_DOCTOR_V1) или роль врача / главного врача. */
export function isDoctorActor(user) {
  return !!user && (user.is_doctor === true || Number(user.is_doctor) === 1 || hasAnyRole(user, DOCTOR_ROLES));
}

/** Включённый внутренний источник сотрудника (один на врача — мигр. 122) или null. */
export function ownReferralSource(db, userId) {
  const id = posInt(userId);
  if (!db || !id) return null;
  return db.prepare('SELECT id, doctor_id FROM referral_sources WHERE doctor_id = ? AND active = 1 ORDER BY id LIMIT 1').get(id) || null;
}

/**
 * Направивший новой строки визита — id источника или null. Бросает LineReferralError
 * (status 400) на явный неверный или выключенный источник стойки.
 * @param {object|null} db
 * @param {object|null} user — сессия (role, extra_roles, is_doctor)
 * @param {object} row — то, что прислал экран (doctor_id — исполнитель строки)
 */
export function lineReferralStamp(db, user, row) {
  if (!db || !user) return null;
  const performer = posInt(row && row.doctor_id);
  let src = null;
  if (isDeskActor(user)) {
    const raw = row ? row.referred_by_source_id : undefined;
    if (raw === undefined || raw === null || raw === '') return null;
    const id = posInt(raw);
    if (!id) throw new LineReferralError('Источник направления указан неверно.');
    src = db.prepare('SELECT id, doctor_id, active FROM referral_sources WHERE id = ?').get(id) || null;
    if (!src || Number(src.active) !== 1) {
      throw new LineReferralError('Источник направления не найден или выключен — выберите другой.');
    }
  } else if (isDoctorActor(user)) {
    src = ownReferralSource(db, user.id);
    if (!src) return null;
  } else {
    return null;
  }
  if (src.doctor_id != null && performer != null && Number(src.doctor_id) === performer) return null;   // своя строка
  return Number(src.id);
}

/**
 * Получатели вознаграждения за строку: [{ source, via: 'visit' | 'line' }].
 * @param {{id:number|null, doctor_id:number|null}|null} base — источник визита/пациента
 * @param {{id:number, doctor_id:number|null}|null} line — источник самой строки
 * @param {number|null} performer — исполнитель строки (visit_services.doctor_id)
 */
export function lineBeneficiaries(base, line, performer) {
  const out = [];
  if (base) out.push({ source: base, via: 'visit' });
  if (!line) return out;
  const sameSource = base && base.id != null && Number(base.id) === Number(line.id);
  const sameEmployee = base && base.doctor_id != null && line.doctor_id != null && Number(base.doctor_id) === Number(line.doctor_id);
  const ownLine = line.doctor_id != null && performer != null && Number(line.doctor_id) === Number(performer);
  if (!sameSource && !sameEmployee && !ownLine) out.push({ source: line, via: 'line' });
  return out;
}
```

В `public/js/admin/i18n-strings.js` перед последней строкой `};` вставить:

```js
  // REFERRAL_LINE_V1 — направивший строки визита (server/services/domain/line-referral.js)
  "Источник направления указан неверно.": {"en":"The referral source is invalid.","ru":"Источник направления указан неверно.","uz":"Yo‘llanma manbasi noto‘g‘ri ko‘rsatilgan."},   // REFERRAL_LINE_V1
  "Источник направления не найден или выключен — выберите другой.": {"en":"The referral source was not found or is switched off — choose another one.","ru":"Источник направления не найден или выключен — выберите другой.","uz":"Yo‘llanma manbasi topilmadi yoki o‘chirilgan — boshqasini tanlang."},   // REFERRAL_LINE_V1
  // /REFERRAL_LINE_V1
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/domain/line-referral.test.js server/i18n-server-messages.test.js`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10a.2: правило направившего строки и получателей бонуса

domain/line-referral.js: стойка ставит источник только явно и только
включённый; врач — сервер ставит его внутренний источник, присланное
браузером не читается; своя строка — без источника. lineBeneficiaries —
одно правило «кому платить» для отчётов и окна регистрации.

REFERRAL_LINE_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/domain/line-referral.js server/services/domain/line-referral.test.js public/js/admin/i18n-strings.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10a.3: реестр и компилятор — направившего ставит сервер, браузер его не пишет

**Files:**
- Modify: `server/db/schema-registry.js`, `server/db/query-compiler.js`, `server/db/schema-registry.test.js`
- Create: `server/routes/referral-line-stamp.test.js`

- [ ] **Step 1: failing tests**

Дописать в конец `server/db/schema-registry.test.js`:

```js
test('REFERRAL_LINE_V1: направивший строки читается, но ни вставкой, ни правкой не пишется — его ставит сервер', () => {
  for (const c of ['referred_by_source_id', 'referral_note']) assert.ok(readableColumns('visit_services').includes(c), 'чтение ' + c);
  assert.ok(!writableColumns('visit_services', 'insert').includes('referred_by_source_id'), 'вставка referred_by_source_id');
  assert.ok(!writableColumns('visit_services', 'update').includes('referred_by_source_id'), 'правка referred_by_source_id');
  assert.ok(writableColumns('visit_services', 'insert').includes('referral_note'), 'рекомендация для регистратуры пишется вставкой');
  assert.ok(!writableColumns('visit_services', 'update').includes('referral_note'));
  assert.deepEqual(REGISTRY.visit_services.stamps.referred_by_source_id, { on: 'insert', resolve: 'line_referral' });
  assert.deepEqual(REGISTRY.visit_services.stamps.created_by, { on: 'insert' });
  assert.ok(readableColumns('recommended_services').includes('visit_service_id'));
  assert.ok(!writableColumns('recommended_services', 'insert').includes('visit_service_id'));
  assert.ok(!writableColumns('recommended_services', 'update').includes('visit_service_id'));
});
```

Создать `server/routes/referral-line-stamp.test.js`:

```js
// REFERRAL_LINE_V1 — направившего СТРОКИ визита ставит сервер: дверь /api/db, компилятор
// запросов, штамп реестра `resolve: 'line_referral'` (domain/line-referral.js). Настоящее
// приложение и настоящие сессии (стенд crm-unify-app.js: boss — админ, reg — регистратура,
// doc — врач №10 «Иванов» со своим внутренним источником).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at } from '../test-helpers/crm-unify-app.js';

const TODAY = localDay(0);
const srcOf = (db, doctorId) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(doctorId).id;
const lastVs = (db) => db.prepare('SELECT MAX(id) id FROM visit_services').get().id;
const stampOf = (db, id) => db.prepare('SELECT referred_by_source_id AS src, referral_note AS note FROM visit_services WHERE id = ?').get(id);

function seed(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12,'doc2','x','Петров','doctor',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ',80000,'imaging')").run();
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (900, 'Клиника Партнёр')").run();
  db.prepare("INSERT INTO referral_sources (id, name, active) VALUES (901, 'Выключенный партнёр', 0)").run();
}
// Каждая строка — в своём визите: одна услуга дважды в одном визите — отказ (DUP_STOP_V1).
function visit(db) {
  return Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, ?, 'arrived')").run(at(TODAY, 9)).lastInsertRowid);
}
async function insertLine(t, who, values) {
  const before = lastVs(t.db);
  const r = await t.dbq(who, { table: 'visit_services', op: 'insert',
    values: { visit_id: visit(t.db), quantity: 1, unit_price: 1, total: 1, status: 'added', ...values } });
  const id = lastVs(t.db);
  return { status: r.status, text: r.text, id: id !== before ? id : null };
}
const updateLine = (t, who, id, values) => t.dbq(who, { table: 'visit_services', op: 'update', values,
  filters: [{ col: 'id', op: 'eq', val: id }] });

test('врач: строка к другому исполнителю — его внутренний источник; присланный браузером чужой — не читается', async () => {
  const t = await startCrmApp(seed);
  try {
    const r = await insertLine(t, 'doc', { service_id: 50, doctor_id: 12, referred_by_source_id: srcOf(t.db, 12) });
    assert.equal(r.status, 200, r.text);
    assert.equal(stampOf(t.db, r.id).src, srcOf(t.db, 10));
    const lab = await insertLine(t, 'doc', { service_id: 40, referred_by_source_id: 900 });
    assert.equal(lab.status, 200, lab.text);
    assert.equal(stampOf(t.db, lab.id).src, srcOf(t.db, 10), 'анализ без исполнителя — направление врача');
  } finally { t.close(); }
});

test('врач: своя строка — без направившего; его источник выключен — без направившего', async () => {
  const t = await startCrmApp(seed);
  try {
    const own = await insertLine(t, 'doc', { service_id: 30, doctor_id: 10 });
    assert.equal(own.status, 200, own.text);
    assert.equal(stampOf(t.db, own.id).src, null);
    t.db.prepare('UPDATE referral_sources SET active = 0 WHERE doctor_id = 10').run();
    const off = await insertLine(t, 'doc', { service_id: 50, doctor_id: 12 });
    assert.equal(off.status, 200, off.text);
    assert.equal(stampOf(t.db, off.id).src, null);
  } finally { t.close(); }
});

test('стойка: «Кто направил» — явно и только включённый; без него — пусто; источник самого исполнителя — пусто', async () => {
  const t = await startCrmApp(seed);
  try {
    const set = await insertLine(t, 'reg', { service_id: 40, referred_by_source_id: 900 });
    assert.equal(set.status, 200, set.text);
    assert.equal(stampOf(t.db, set.id).src, 900);
    const none = await insertLine(t, 'reg', { service_id: 40 });
    assert.equal(none.status, 200, none.text);
    assert.equal(stampOf(t.db, none.id).src, null);
    const off = await insertLine(t, 'reg', { service_id: 40, referred_by_source_id: 901 });
    assert.equal(off.status, 400, off.text);
    assert.match(off.text, /не найден или выключен/);
    assert.equal(off.id, null, 'строка с выключенным источником легла');
    const ownLine = await insertLine(t, 'boss', { service_id: 50, doctor_id: 12, referred_by_source_id: srcOf(t.db, 12) });
    assert.equal(ownLine.status, 200, ownLine.text);
    assert.equal(stampOf(t.db, ownLine.id).src, null, 'врачу-исполнителю — «за направление» на свою же строку');
  } finally { t.close(); }
});

test('правкой направившего не меняет ни врач, ни стойка', async () => {
  const t = await startCrmApp(seed);
  try {
    const r = await insertLine(t, 'doc', { service_id: 50, doctor_id: 12 });
    assert.equal(r.status, 200, r.text);
    for (const who of ['doc', 'reg']) {
      const upd = await updateLine(t, who, r.id, { status: 'added', referred_by_source_id: 900 });
      assert.equal(upd.status, 200, who + ': ' + upd.text);
      assert.equal(stampOf(t.db, r.id).src, srcOf(t.db, 10), who + ' поменял направившего правкой');
    }
  } finally { t.close(); }
});

test('рекомендация для регистратуры пишется; длиннее 500 знаков — отказ, строки нет', async () => {
  const t = await startCrmApp(seed);
  try {
    const ok = await insertLine(t, 'doc', { service_id: 50, doctor_id: 12, referral_note: 'натощак, к 9:00' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(stampOf(t.db, ok.id).note, 'натощак, к 9:00');
    const long = await insertLine(t, 'doc', { service_id: 50, doctor_id: 12, referral_note: 'x'.repeat(501) });
    assert.ok(long.status >= 400 && long.status < 500, long.status + ' ' + long.text);
    assert.equal(long.id, null);
  } finally { t.close(); }
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/db/schema-registry.test.js server/routes/referral-line-stamp.test.js`
  Ожидается FAIL: реестр — `чтение referred_by_source_id`; дверь — `stampOf(...).src` = `null`, ожидалось id источника врача 10 (колонку никто не ставит; `referral_note` молча отброшен — `note` = null).

- [ ] **Step 3: implement**

`server/db/schema-registry.js`, `visit_services` — чтение. Заменить

```js
             'price_tier','package_id',
             'package_full','package_price'] },
```

на

```js
             'price_tier','package_id',
             'referred_by_source_id','referral_note',   // REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1 (мигр. 270) — направивший строки (ставит сервер, stamps ниже) и рекомендация врача для регистратуры
             'package_full','package_price'] },
```

Штамп. Заменить

```js
    stamps: { created_by: { on: 'insert' } },
    write: { insert: { roles: ['admin','registrar','doctor'], columns: ['visit_id',
```

на

```js
    // REFERRAL_LINE_V1 (мигр. 270) — направившего строки тоже ставит СЕРВЕР, но не «я», а
    // вычислением (domain/line-referral.js lineReferralStamp): врачу — его включённый
    // внутренний источник (присланное браузером не читается), стойке — только явно
    // присланный и включённый источник; своя строка — пусто. В списках записи колонки нет:
    // правкой её не меняет никто, upsert её не пишет (компилятор штампов в upsert не ставит).
    stamps: { created_by: { on: 'insert' }, referred_by_source_id: { on: 'insert', resolve: 'line_referral' } },
    write: { insert: { roles: ['admin','registrar','doctor'], columns: ['visit_id',
```

Вставка `referral_note`. Заменить

```js
                       'package_full','package_price'] },
             // V3120_FIX (M2) — doctor_id отсюда убран:
```

на

```js
                       'package_full','package_price',
                       'referral_note'] },   // DOCTOR_REFERRAL_DESK_V1 (мигр. 270) — «Рекомендация для регистратуры» мастера направления врача
             // V3120_FIX (M2) — doctor_id отсюда убран:
```

`recommended_services` — чтение. Заменить

```js
             'recommended_by_name','source_visit_id','notes','status','closed_at','created_at'] },
```

на

```js
             'recommended_by_name','source_visit_id','notes','status','closed_at','created_at',
             'visit_service_id'] },   // DOCTOR_REFERRAL_DESK_V1 (мигр. 270) — строка, которой закрыта рекомендация; пишет только referral_recommendation_attach
```

`server/db/query-compiler.js` — импорт. После строки `import { withTemplate } from '../services/server-message.js';   // V3120_I18N` добавить:

```js
import { lineReferralStamp } from '../services/domain/line-referral.js';   // REFERRAL_LINE_V1 — штамп «направивший строки»
```

`stampValues`. Заменить

```js
function stampValues(table, op, values, user) {
  const stamps = actorStamps(table);
  if (!stamps) return { values, extra: [] };
  const me = user && Number.isFinite(Number(user.id)) ? Number(user.id) : null;
  const out = { ...(values || {}) };
  const extra = [];
  for (const [col, rule] of Object.entries(stamps)) {
    delete out[col];
```

на

```js
// REFERRAL_LINE_V1 — штампы, значение которых СЕРВЕР ВЫЧИСЛЯЕТ по сессии и присланной
// строке (а не номер сотрудника): { on: 'insert', resolve: '<имя>' }. null — колонка в
// INSERT не попадает (SQL такой же, как без штампа). Отказ резолвера (e.status) — отказ
// компилятора его словами (400).
const STAMP_RESOLVERS = Object.freeze({ line_referral: lineReferralStamp });
function resolveStamp(name, db, user, row) {
  const fn = STAMP_RESOLVERS[name];
  if (typeof fn !== 'function') throw new Error('stamp resolver missing: ' + name);   // ошибка реестра, не запроса — 500
  try { return fn(db, user, row || {}); }
  catch (e) { if (e && e.status) throw new CompileError(e.message, e.status); throw e; }
}
function stampValues(table, op, values, user, db = null) {
  const stamps = actorStamps(table);
  if (!stamps) return { values, extra: [] };
  const me = user && Number.isFinite(Number(user.id)) ? Number(user.id) : null;
  const out = { ...(values || {}) };
  const extra = [];
  for (const [col, rule] of Object.entries(stamps)) {
    delete out[col];
    if (rule.resolve) {   // REFERRAL_LINE_V1 — присланное значение читает только резолвер (из values), не запись
      if (rule.on === op) {
        const v = resolveStamp(rule.resolve, db, user, values);
        if (v != null) { out[col] = v; extra.push(col); }
      }
      continue;
    }
```

В `compileInsert` заменить

```js
    const { values, extra } = stampValues(table, 'insert', row, user);
```

на

```js
    const { values, extra } = stampValues(table, 'insert', row, user, db);   // REFERRAL_LINE_V1 — резолверу нужна база
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/db/schema-registry.test.js server/routes/referral-line-stamp.test.js server/db/schema-registry-conformance.test.js server/db/crm-ownership.test.js server/db/query-compiler.test.js server/routes/package-stamp.test.js server/routes/referral-bill-flow.test.js`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10a.3: направившего строки ставит сервер — штамп реестра

visit_services.referred_by_source_id — в чтении, ни в одном списке
записи; компилятор зовёт резолвер line_referral: врачу — его источник
(присланное браузером не читается), стойке — только явный включённый
источник, своя строка — пусто. referral_note пишется вставкой;
recommended_services.visit_service_id — только чтение.

REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/db/schema-registry.js server/db/query-compiler.js server/db/schema-registry.test.js server/routes/referral-line-stamp.test.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10a.4: «Вернуть эту услугу и выставить новую» переносит направившего на новую строку

**Files:**
- Modify: `server/services/rpc/billing.js`, `server/services/rpc/refund-swap-rebill.test.js`

- [ ] **Step 1: failing test** — дописать в конец `server/services/rpc/refund-swap-rebill.test.js`:

```js
// REFERRAL_LINE_V1 — «Вернуть эту услугу и выставить новую»: позиция счёта уходит к НОВОЙ строке
// визита — с ней и направивший строки, и рекомендация врача. Иначе вознаграждение
// направившего за эту позицию пропало бы вместе со старой строкой.
test('REFERRAL_LINE_V1: возврат с новой услугой переносит направившего и рекомендацию на новую строку', () => {
  const { db, pid, CONS, USG } = clinic();
  const a = started(db, pid, CONS, DOC);
  const src = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(DOC2).id;
  db.prepare("UPDATE visit_services SET referred_by_source_id = ?, referral_note = 'натощак' WHERE id = ?").run(src, a.vs);
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC }, cashier);
  const nl = vsRow(db, r.line.id);
  assert.notEqual(nl.id, a.vs);
  assert.deepEqual([nl.referred_by_source_id, nl.referral_note], [src, 'натощак']);
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/rpc/refund-swap-rebill.test.js`
  Ожидается FAIL: `[null, null]` вместо `[src, 'натощак']`.

- [ ] **Step 3: implement** — в `server/services/rpc/billing.js` (`swapPaidLineTx`, ветка `rebill`) заменить

```js
    lineId = Number(db.prepare(`
      INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier, invoice_item_id, scheduled_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'added', ?, ?, ?, ?)`)
      .run(vs.visit_id, newServiceId, targetDoctor, vs.quantity || 1, unit, lineTotal, tier, item.id, vs.scheduled_at || null, user.id).lastInsertRowid);
```

на

```js
    // REFERRAL_LINE_V1 — направивший и рекомендация врача идут с позицией счёта к новой строке.
    lineId = Number(db.prepare(`
      INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier, invoice_item_id, scheduled_at, created_by,
                                  referred_by_source_id, referral_note)
      VALUES (?, ?, ?, ?, ?, ?, 'added', ?, ?, ?, ?, ?, ?)`)
      .run(vs.visit_id, newServiceId, targetDoctor, vs.quantity || 1, unit, lineTotal, tier, item.id, vs.scheduled_at || null, user.id,
        vs.referred_by_source_id ?? null, vs.referral_note ?? null).lastInsertRowid);
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/rpc/refund-swap-rebill.test.js server/services/rpc/cashier-paid-swap.test.js`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10a.4: возврат с новой услугой сохраняет направившего строки

Новая строка визита, к которой уходит позиция счёта, получает
referred_by_source_id и referral_note прежней строки.

REFERRAL_LINE_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/rpc/billing.js server/services/rpc/refund-swap-rebill.test.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10a.5: «Рефералы» — вознаграждение и источнику строки (обоим), один источник — один раз

**Files:**
- Modify: `server/services/rpc/reports.js`, `server/services/rpc/reports.v2.test.js`, `public/js/admin/i18n-strings.js`
- Create: `server/services/rpc/reports.referral-line.test.js`

- [ ] **Step 1: failing tests**

Создать `server/services/rpc/reports.referral-line.test.js`:

```js
// REFERRAL_LINE_V1 — вознаграждение за направление ПО СТРОКЕ (решение владельца 2026-11-02 —
// «обоим»): источник визита/пациента получает своё, источник строки визита — своё, если он
// другой; тот же источник — один раз; своя строка врача — без бонуса; закрытый месяц не
// двигается. Одни строки на «Рефералы», детализацию, кабинет врача и «Зарплаты врачей».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorReferralReward, doctorPaySummary, payPeriodClose, __setReportsPushDown } from './reports.js';

const admin = { id: 9, role: 'admin' };
const FROM = '2026-08-01';
const TO = '2026-08-31';

// Врач 1 «Направлялов» направляет (внутренний источник S1, категория «Внутренние врачи» 5 %),
// врач 2 «Узистов» исполняет УЗИ 200 000; партнёр «Клиника Х» (категория «Партнёры» 10 %).
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'ref', 'x', 'doctor', 'Направлялов Н.Н.', 1);
  u.run(2, 'uzi', 'x', 'doctor', 'Узистов У.У.', 1);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0);
  const internalCat = db.prepare('SELECT id FROM referral_source_categories WHERE is_internal = 1').get().id;
  db.prepare('UPDATE referral_source_categories SET standard_percent = 5 WHERE id = ?').run(internalCat);
  const extCat = Number(db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 10)").run().lastInsertRowid);
  const P = Number(db.prepare("INSERT INTO referral_sources (name, category_id) VALUES ('Клиника Х', ?)").run(extCat).lastInsertRowid);
  const S1 = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 1').get().id;
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (2, 'УЗИ', 200000, 'imaging')").run();
  return { db, S1, P, internalCat };
}
let N = 0;
const patient = (db, name, src = null) => Number(db.prepare('INSERT INTO patients (full_name, referral_source_id) VALUES (?, ?)').run(name, src).lastInsertRowid);
// Счёт на одну строку визита (УЗИ 200 000, исполнитель performer) от 05.08.2026.
function line(db, { pt, visitSource = null, lineSource = null, performer = 2, status = 'paid' }) {
  N += 1;
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, referral_source_id) VALUES (?, '2026-08-05T09:00:00Z', ?)").run(pt, visitSource).lastInsertRowid);
  const inv = Number(db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                                 VALUES (?, ?, ?, 200000, 0, 200000, ?, ?, '2026-08-05T10:00:00Z')`)
    .run('INV-L' + N, vid, pt, status === 'paid' ? 200000 : 0, status).lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, 2, 'УЗИ', 1, 200000, 200000)").run(inv).lastInsertRowid);
  db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id, referred_by_source_id)
              VALUES (?, 2, ?, 1, 200000, 200000, 'completed', ?, ?)`).run(vid, performer, item, lineSource);
  return { vid, inv, item };
}
const run = (db, kind, extra = {}) => runReport(db, { kind, from: FROM, to: TO, ...extra }, admin);
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const bySource = (db, kind = 'referrals') => Object.fromEntries(objects(run(db, kind)).map((o) => [o['Источник'], o]));

test('направление в день, когда визит уже был (у визита источника нет): строка со своим источником — бонус врачу', () => {
  const { db, S1 } = seed();
  line(db, { pt: patient(db, 'Азизов'), lineSource: S1 });
  const own = bySource(db)['Направлялов Н.Н.'];
  assert.ok(own, 'направивший строки не попал в «Рефералы»');
  assert.equal(own['Вид'], 'Внутренний');
  assert.equal(own['Услуг'], 1);
  assert.equal(own['Вознаграждение'], 10000);   // 5 % от 200 000
});

test('партнёр пациента + врач строки — оба, каждый по своей ставке', () => {
  const { db, S1, P } = seed();
  line(db, { pt: patient(db, 'Бобоев', P), lineSource: S1 });
  const rows = bySource(db);
  assert.equal(rows['Клиника Х']['Вознаграждение'], 20000);
  assert.equal(rows['Направлялов Н.Н.']['Вознаграждение'], 10000);
  assert.ok(run(db, 'referrals').notes.some((n) => n.includes('получают оба')), 'правило «обоим» не объяснено под отчётом');
});

test('врач — источник и визита, и строки: платится один раз', () => {
  const { db, S1 } = seed();
  line(db, { pt: patient(db, 'Валиев'), visitSource: S1, lineSource: S1 });
  const rows = objects(run(db, 'referrals'));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]['Источник'], rows[0]['Услуг'], rows[0]['Вознаграждение']], ['Направлялов Н.Н.', 1, 10000]);
  assert.equal(objects(run(db, 'referrals_detail')).length, 1);
});

test('своя строка врача (он же исполнитель) — без бонуса', () => {
  const { db, S1 } = seed();
  line(db, { pt: patient(db, 'Гафуров'), lineSource: S1, performer: 1 });
  assert.deepEqual(objects(run(db, 'referrals')), []);
});

test('неоплаченный счёт — в суммах, но без вознаграждения', () => {
  const { db, S1 } = seed();
  line(db, { pt: patient(db, 'Давлатов'), lineSource: S1, status: 'unpaid' });
  const own = bySource(db)['Направлялов Н.Н.'];
  assert.deepEqual([own['Сумма услуг'], own['Оплачено'], own['Вознаграждение']], [200000, 0, 0]);
});

test('кабинет врача, «Зарплаты врачей» и «Рефералы» — одна сумма', () => {
  const { db, S1, P } = seed();
  line(db, { pt: patient(db, 'Бобоев', P), lineSource: S1 });
  line(db, { pt: patient(db, 'Азизов'), lineSource: S1 });
  const report = bySource(db)['Направлялов Н.Н.']['Вознаграждение'];
  assert.equal(report, 20000);
  assert.equal(doctorReferralReward(db, { doctor_id: 1, from: FROM, to: TO }, admin).reward, report);
  assert.equal(doctorPaySummary(db, { doctor_id: 1, from: FROM, to: TO }, admin).referral.reward, report);
});

test('закрытый месяц не меняется: правка ставки после закрытия не двигает ни врача строки, ни партнёра', () => {
  const { db, S1, P, internalCat } = seed();
  line(db, { pt: patient(db, 'Бобоев', P), lineSource: S1 });
  payPeriodClose(db, { month: '2026-08' }, admin);
  db.prepare('UPDATE referral_source_categories SET standard_percent = 50 WHERE id = ?').run(internalCat);
  const rows = bySource(db);
  assert.equal(rows['Направлялов Н.Н.']['Вознаграждение'], 10000);
  assert.equal(rows['Клиника Х']['Вознаграждение'], 20000);
  assert.equal(doctorReferralReward(db, { doctor_id: 1, from: FROM, to: TO }, admin).reward, 10000);
});

test('push-down и без него — одни и те же строки вознаграждения', () => {
  const { db, S1, P } = seed();
  line(db, { pt: patient(db, 'Бобоев', P), lineSource: S1 });
  line(db, { pt: patient(db, 'Валиев'), visitSource: S1, lineSource: S1 });
  line(db, { pt: patient(db, 'Гафуров'), lineSource: S1, performer: 1 });
  const fast = JSON.stringify(objects(run(db, 'referrals_detail')));
  __setReportsPushDown(false);
  try { assert.equal(JSON.stringify(objects(run(db, 'referrals_detail'))), fast); }
  finally { __setReportsPushDown(true); }
});
```

Правка ожидания в `server/services/rpc/reports.v2.test.js` (тест «I7: кабинет отбирает строки своего источника в SQL…») — отбор теперь «источник визита ИЛИ источник строки визита этого счёта». Заменить

```js
  assert.match(q, /AND rs\.doctor_id = \?/);
```

на

```js
  // REFERRAL_LINE_V1 — источник визита ИЛИ источник строки визита этого счёта, оба в SQL.
  assert.match(q, /AND \(rs\.doctor_id = \? OR EXISTS/);
  assert.match(q, /lrs\.doctor_id = \?/);
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/rpc/reports.referral-line.test.js server/services/rpc/reports.v2.test.js`
  Ожидается FAIL: «направивший строки не попал в «Рефералы»» (строка без источника визита отчётом пропускается), I7 — `AND \(rs\.doctor_id` не найдено.

- [ ] **Step 3: implement** — `server/services/rpc/reports.js`.

Импорт. Заменить

```js
import { resolveReferralRate, rewardForLine, referralGroupOf } from '../../../public/js/shared/referral-reward.js';
```

на

```js
import { resolveReferralRate, rewardForLine, referralGroupOf } from '../../../public/js/shared/referral-reward.js';
import { lineBeneficiaries } from '../domain/line-referral.js';   // REFERRAL_LINE_V1 — кому платить за строку (одно правило с окном регистрации)
```

Функцию `referralLines` целиком — от JSDoc

```js
/**
 * Строки счетов, пришедшие по направлению, с посчитанным вознаграждением.
 * @param {{doctorId?: number}} [opts] — только направления этого сотрудника
 *   (его источник, referral_sources.doctor_id) — для кабинета врача.
 */
function referralLines(db, args, ctx, { doctorId = null } = {}) {
```

до её закрывающей `}` перед комментарием `// INPATIENT_BONUS_V1 (владелец, 26.09) — ВОЗНАГРАЖДЕНИЕ ЗА НАПРАВЛЕНИЕ В СТАЦИОНАР.` — заменить на:

```js
// REFERRAL_LINE_V1 — у счёта есть строка визита со своим источником. Условие — на СЧЁТ i:
// выборка счетов itemDoctorScope (WITH sc_inv) не знает алиаса строки счёта ii; какая
// именно строка счёта — решает цикл ниже (lineSourcesOf).
const LINE_SOURCE_EXISTS_SQL = (cond = null) => `EXISTS (SELECT 1 FROM invoice_items lxi
     JOIN visit_services lx ON lx.invoice_item_id = lxi.id${cond ? `
     JOIN referral_sources lrs ON lrs.id = lx.referred_by_source_id` : ''}
    WHERE lxi.invoice_id = i.id AND lx.referred_by_source_id IS NOT NULL${cond ? ' AND ' + cond : ''})`;

// REFERRAL_LINE_V1 — источник строки визита по строке счёта: Map invoice_item_id →
// { source_id, performer }. Нет ни одной строки с источником — пустая карта без прохода.
function lineSourcesOf(db, rows) {
  const out = new Map();
  if (!rows.length) return out;
  if (!db.prepare('SELECT 1 FROM visit_services WHERE referred_by_source_id IS NOT NULL LIMIT 1').get()) return out;
  const ids = [...new Set(rows.map((r) => Number(r.invoice_item_id)).filter(Number.isInteger))];
  for (let k = 0; k < ids.length; k += 500) {
    const part = ids.slice(k, k + 500);
    for (const x of db.prepare(`SELECT invoice_item_id, MIN(referred_by_source_id) AS source_id, MIN(doctor_id) AS performer
                                  FROM visit_services
                                 WHERE referred_by_source_id IS NOT NULL AND invoice_item_id IN (${part.map(() => '?').join(',')})
                                 GROUP BY invoice_item_id`).all(...part)) {
      out.set(Number(x.invoice_item_id), { source_id: Number(x.source_id), performer: x.performer == null ? null : Number(x.performer) });
    }
  }
  return out;
}

/**
 * Строки счетов, пришедшие по направлению, с посчитанным вознаграждением.
 * @param {{doctorId?: number}} [opts] — только направления этого сотрудника
 *   (его источник, referral_sources.doctor_id) — для кабинета врача.
 *
 * REFERRAL_LINE_V1 (решение владельца 2026-11-02 — «обоим») — у строки счёта получателей
 * может быть ДВА: источник визита/пациента (как прежде) и источник САМОЙ строки визита
 * (visit_services.referred_by_source_id: врач направил из кабинета, «Кто направил» стойки),
 * если он другой и строка не своя для его врача. Кому — lineBeneficiaries
 * (domain/line-referral.js), то же правило, что у окна регистрации. Каждый получатель —
 * своей строкой со своей ставкой (referral_via: 'visit' | 'line'); ключ строки в записи
 * закрытого месяца уже «строка счёта | получатель», поэтому закрытые месяцы не двигаются,
 * а прошлые строки (до мигр. 270) источника строки не имеют.
 */
function referralLines(db, args, ctx, { doctorId = null } = {}) {
  const scope = referrerScope(args);
  const sources = new Map(db.prepare(
    'SELECT id, name, code, category_id, reward_mode, own_percent, own_rates, doctor_id FROM referral_sources').all()
    .map((r) => [r.id, r]));
  const categories = new Map(db.prepare(
    'SELECT id, name, standard_percent, rates, is_internal FROM referral_source_categories').all()
    .map((r) => [r.id, r]));
  const out = [];
  // Кабинет врача — только строки его источника, отбором в SQL (REPORTS_V2, ревью I7):
  // источник визита ИЛИ источник строки визита этого счёта (REFERRAL_LINE_V1).
  const extra = doctorId != null
    ? { clause: ` AND (rs.doctor_id = ? OR ${LINE_SOURCE_EXISTS_SQL('lrs.doctor_id = ?')})`, params: [Number(doctorId), Number(doctorId)] }
    : { clause: '', params: [] };
  // V3120_PERF — строки без источника направления (ни у визита/пациента, ни у строки
  // визита — REFERRAL_LINE_V1) и строки госпитализации цикл ниже пропускает первыми же
  // проверками; тот же отбор в SQL, чтобы деньги не считались для выбрасываемых строк.
  if (PUSH_DOWN) extra.clause += ` AND (COALESCE(rs.name, '') <> '' OR ${LINE_SOURCE_EXISTS_SQL()}) AND i.admission_id IS NULL`;
  const rows = itemRowsQuery(db, args, ctx, extra);
  const lineSrc = lineSourcesOf(db, rows);
  for (const r of rows) {
    // INPATIENT_BONUS_V1 — строка счёта ГОСПИТАЛИЗАЦИИ по обычным ставкам групп
    // больше не платится никому: у стационара своё вознаграждение
    // (inpatientReferralLines ниже) — только у партнёра с переключателем.
    if (r.admission_id != null) continue;
    const ls = lineSrc.get(Number(r.invoice_item_id)) || null;
    const lsRow = ls ? (sources.get(ls.source_id) || null) : null;
    const bens = lineBeneficiaries(
      r.referral ? { id: r.referral_source_id, doctor_id: r.referral_doctor_id ?? null } : null,
      lsRow ? { id: lsRow.id, doctor_id: lsRow.doctor_id ?? null } : null,
      ls ? ls.performer : null);
    for (const b of bens) {
      const lcat = b.via === 'line' && lsRow.category_id != null ? (categories.get(lsRow.category_id) || null) : null;
      const row = b.via === 'visit' ? r : {
        ...r,
        referral: lsRow.name, referral_source_id: lsRow.id, referral_code: lsRow.code || '',
        referral_category: (lcat && lcat.name) || '', referral_internal: lcat ? lcat.is_internal : 0,
        referral_doctor_id: lsRow.doctor_id ?? null,
      };
      const internal = isInternalReferral(row);
      if (scope === 'internal' && !internal) continue;
      if (scope === 'external' && internal) continue;
      if (doctorId != null && Number(row.referral_doctor_id) !== Number(doctorId)) continue;
      const src = row.referral_source_id != null ? sources.get(row.referral_source_id) : null;
      const cat = src && src.category_id != null ? categories.get(src.category_id) : null;
      // GROUPS_FIVE_REFERRAL_V1 — ставка по ГРУППЕ услуги (services.type, одна
      // из пяти), а не по строке справочника типов. Строка без услуги — без группы.
      const serviceGroup = row.service_id != null ? referralGroupOf(row.service_group) : null;
      const rate = resolveReferralRate({ source: src, category: cat, serviceGroup });
      // V3120_FIX — частичный возврат уменьшает вознаграждение пропорционально.
      const factor = referralPayFactor(row);
      const paid = factor > 0;
      // PAY_GOODS_NONE_V1 (владелец, 27.09) — «на товары процента нет»: строка
      // счёта без услуги (медикамент, расходник) вознаграждения ВРАЧУ-направившему
      // не даёт. Внешнему партнёру — по его ставкам, как прежде.
      // FINAL_MONEY_FIX_V1 (C1) — консультация (строка без услуги с видом
      // приёма) — не товар: её вознаграждение врачу-направившему возвращено.
      const goodsToDoctor = row.referral_doctor_id != null && Number(row.is_goods) === 1;
      out.push({
        ...row,
        internal,
        category_name: (cat && cat.name) || row.referral_category || '',
        mode: src && src.reward_mode === 'own' ? 'Своя' : 'По категории',
        rate,
        paid,
        pay_factor: factor,
        goods_to_doctor: goodsToDoctor,
        after_discount: row.amount - row.discount,
        // V3120_FINAL (C1) — фикс за услугу уменьшается скидкой после продажи (процент — сам).
        reward: paid && !goodsToDoctor ? rewardForLine(rate, { amount: row.amount, discount: row.discount, qty: row.qty }) * factor * fixKeep(rate, row) : 0,
        where: 'out',
        beneficiary_doctor_id: row.referral_doctor_id ?? null,
        referral_via: b.via,   // REFERRAL_LINE_V1 — 'visit' (источник визита/пациента) | 'line' (источник строки)
      });
    }
  }
  return out;
}
```

Примечание под отчётом. Заменить

```js
function referralNotes(db, lines) {
  const notes = [REFERRAL_BASE_NOTE];
```

на

```js
// REFERRAL_LINE_V1 — правило «обоим» словами (только когда такие строки есть в отчёте).
const REFERRAL_LINE_NOTE = 'Если врач направил на услугу из кабинета, а у визита или пациента уже есть свой направивший, вознаграждение за эту строку получают оба — каждый по своей ставке; один и тот же источник за строку получает один раз; за свою услугу врач вознаграждения не получает.';
function referralNotes(db, lines) {
  const notes = [REFERRAL_BASE_NOTE];
  if (lines.some((r) => r.referral_via === 'line')) notes.push(REFERRAL_LINE_NOTE);   // REFERRAL_LINE_V1
```

`public/js/admin/i18n-strings.js` — перед последней строкой `};`:

```js
  // REFERRAL_LINE_V1 — примечание «Рефералов» (server/services/rpc/reports.js)
  "Если врач направил на услугу из кабинета, а у визита или пациента уже есть свой направивший, вознаграждение за эту строку получают оба — каждый по своей ставке; один и тот же источник за строку получает один раз; за свою услугу врач вознаграждения не получает.": {"en":"If a doctor referred the patient to a service from the consulting room while the visit or the patient already has another referrer, both get the reward for this line — each at their own rate; the same source is paid once per line; a doctor gets no reward for their own service.","ru":"Если врач направил на услугу из кабинета, а у визита или пациента уже есть свой направивший, вознаграждение за эту строку получают оба — каждый по своей ставке; один и тот же источник за строку получает один раз; за свою услугу врач вознаграждения не получает.","uz":"Agar shifokor xizmatga kabinetdan yo‘llagan bo‘lsa, tashrif yoki bemorda esa boshqa yo‘llovchi bo‘lsa, bu qator uchun mukofotni ikkalasi oladi — har biri o‘z stavkasi bo‘yicha; bitta manba qator uchun bir marta oladi; o‘z xizmati uchun shifokor mukofot olmaydi."},   // REFERRAL_LINE_V1
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/rpc/reports.referral-line.test.js server/services/rpc/reports.v2.test.js server/services/rpc/reports.v3120-pay.test.js server/services/rpc/reports.v3120-perf.test.js server/services/rpc/reports.inpatient-bonus.test.js server/services/rpc/reports.money-review.test.js server/services/rpc/referrals.test.js`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10a.5: «Рефералы» — бонус и направившему строки, один источник один раз

referralLines: на строку счёта — получатели по lineBeneficiaries:
источник визита/пациента и источник строки визита, если он другой и
строка не своя для врача. Отбор кабинета врача и push-down — с
источником строки. Примечание под отчётом. Закрытые месяцы — по ключу
«строка | получатель», не двигаются.

REFERRAL_LINE_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/rpc/reports.js server/services/rpc/reports.referral-line.test.js server/services/rpc/reports.v2.test.js public/js/admin/i18n-strings.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10a.6: «Реферирование» — направления врача и по строкам; внешние врачи — тоже

**Files:**
- Modify: `server/services/rpc/referrals.js`
- Create: `server/services/rpc/referrals.line.test.js`

- [ ] **Step 1: failing test** — создать `server/services/rpc/referrals.line.test.js`:

```js
// REFERRAL_LINE_V1 — экран «Реферирование» считает направления и по строкам визита:
// «Внутренние врачи» — рекомендации + строки с источником врача (строка, которой закрыта
// рекомендация, — та же рекомендация); внешние — визит «по источнику», если источник у
// визита/пациента ИЛИ у живой строки визита (тогда суммы сходятся со строками «Рефералов»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { referralsInternal, referralsDoctorDetail, referralsRepresentatives, referralsSourceDetail, referralsActivity } from './referrals.js';

const ymd = (daysAgo) => {
  const d = new Date(); d.setDate(d.getDate() - daysAgo);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const atNoon = (daysAgo) => new Date(ymd(daysAgo) + 'T12:00:00').toISOString();
const admin = { id: 1, role: 'admin' };
const period = { from: ymd(30), to: ymd(0) };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, specialty) VALUES (?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Администратор', '');
  u.run(3, 'doc', 'x', 'doctor', 'Врач Внутренний', 'Невролог');
  u.run(4, 'uzi', 'x', 'doctor', 'Исполнитель', 'УЗИ');
  const internal = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 3').get().id;
  const B = Number(db.prepare("INSERT INTO referral_sources (name, first_name) VALUES ('Набиев Ойбек', 'Ойбек')").run().lastInsertRowid);
  db.prepare("INSERT INTO services (id, name, price) VALUES (50, 'УЗИ', 80000), (51, 'ЭКГ', 50000)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (10, 'Пациент Первый'), (11, 'Пациент Второй')").run();
  const vis = db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (?, 4, ?, 'arrived')");
  const v1 = Number(vis.run(10, atNoon(1)).lastInsertRowid);
  const v2 = Number(vis.run(10, atNoon(2)).lastInsertRowid);
  const v3 = Number(vis.run(11, atNoon(3)).lastInsertRowid);
  const line = db.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id, status, referred_by_source_id, created_at) VALUES (?, ?, 4, ?, ?, ?)');
  line.run(v1, 50, 'added', internal, atNoon(1));                                  // ждёт
  line.run(v2, 50, 'completed', internal, atNoon(2));                              // выполнено
  const fromRec = Number(line.run(v2, 51, 'added', internal, atNoon(2)).lastInsertRowid);   // этой строкой закрыта рекомендация
  db.prepare("INSERT INTO recommended_services (patient_id, service_id, service_name, recommended_by, status, created_at, visit_service_id) VALUES (10, 51, 'ЭКГ', 3, 'done', ?, ?)")
    .run(atNoon(2), fromRec);
  line.run(v3, 50, 'added', B, atNoon(3));                                         // внешний врач — только строкой
  return { db, B, v3 };
}

test('«Внутренние врачи»: рекомендации + строки с его источником; строка рекомендации — один раз', () => {
  const { db } = fresh();
  const out = referralsInternal(db, period, admin);
  const d = out.doctors.find((r) => r.id === 3);
  assert.deepEqual([d.referrals, d.done, d.waiting, d.cancelled, d.patients], [3, 2, 1, 0, 1]);
  assert.equal(out.totals.doctors_referring, 1);
  const other = out.doctors.find((r) => r.id === 4);
  assert.deepEqual([other.referrals, other.done, other.waiting], [0, 0, 0]);
});

test('подробности врача: строки направлений рядом с рекомендациями, новые сначала', () => {
  const { db } = fresh();
  const det = referralsDoctorDetail(db, { doctor_id: 3, ...period }, admin);
  assert.deepEqual(det.referrals.map((r) => [r.service, r.status]), [['УЗИ', 'pending'], ['ЭКГ', 'done'], ['УЗИ', 'done']]);
});

test('внешний врач, направивший только строкой: визит в «Представителях», «Подробнее» и активности', () => {
  const { db, B, v3 } = fresh();
  const rep = referralsRepresentatives(db, period, admin);
  const row = rep.sources.find((s) => s.id === B);
  assert.deepEqual([row.visits, row.patients], [1, 1]);
  assert.equal(rep.totals.patients, 1);
  assert.deepEqual(referralsSourceDetail(db, { source_id: B, ...period }, admin).visits.map((v) => v.visit_id), [v3]);
  const act = referralsActivity(db, {}, admin).sources.find((s) => s.id === B);
  assert.equal(act.last_visit, ymd(3));
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/rpc/referrals.line.test.js`
  Ожидается FAIL: `[1, 1, 0, 0, 1]` вместо `[3, 2, 1, 0, 1]`; у внешнего `[0, 0]`.

- [ ] **Step 3: implement** — `server/services/rpc/referrals.js`.

Шапка: заменить

```js
// внешние и внутренние врачи — те же строки referral_sources, направления
// внутреннего врача — те же recommended_services, деньги — те же строки отчёта
```

на

```js
// внешние и внутренние врачи — те же строки referral_sources, направления
// внутреннего врача — те же recommended_services и строки визитов с его источником
// (REFERRAL_LINE_V1, visit_services.referred_by_source_id), деньги — те же строки отчёта
```

После `const VISIT_LIVE = "v.status NOT IN ('cancelled', 'no_show')";` добавить:

```js

// REFERRAL_LINE_V1 — визит «по источнику»: источник визита (иначе карточки пациента) ИЛИ
// источник живой строки этого визита (visit_services.referred_by_source_id — «Кто направил»
// стойки, направление врача). Пара (визит, источник) — один раз. rangeSql — условие на
// v.visit_date (его параметры передаются ДВАЖДЫ: оно стоит в обеих ветках).
function sourceVisitsSql(rangeSql = '1=1') {
  return `SELECT v.id AS visit_id, ${SOURCE_OF_VISIT} AS source_id
            FROM visits v JOIN patients pt ON pt.id = v.patient_id
           WHERE ${SOURCE_OF_VISIT} IS NOT NULL AND (${rangeSql})
          UNION
          SELECT v.id AS visit_id, vs.referred_by_source_id AS source_id
            FROM visit_services vs JOIN visits v ON v.id = vs.visit_id
           WHERE vs.referred_by_source_id IS NOT NULL AND vs.status NOT IN ('cancelled', 'removed') AND (${rangeSql})`;
}

// REFERRAL_LINE_V1 — направления врача строками визита: строка с его внутренним источником,
// заведённая в период. Строка, которой закрыта рекомендация (recommended_services
// .visit_service_id), — та же рекомендация и второй раз не считается.
function lineReferrals(db, from, to, doctorId = null) {
  const lw = localRangeWhere('vs.created_at', from, to);
  return db.prepare(`
    SELECT rs.doctor_id AS doctor_id, v.patient_id, vs.status, ${localDate('vs.created_at')} AS date,
           pt.full_name AS patient, COALESCE(s.name, ct.name_ru, ct.name, '') AS service
      FROM visit_services vs
      JOIN referral_sources rs ON rs.id = vs.referred_by_source_id
      JOIN visits v ON v.id = vs.visit_id
      LEFT JOIN patients pt ON pt.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN consultation_types ct ON ct.id = vs.consultation_type_id
     WHERE rs.doctor_id IS NOT NULL${doctorId != null ? ' AND rs.doctor_id = ?' : ''}
       AND ${lw.sql}
       AND NOT EXISTS (SELECT 1 FROM recommended_services rr WHERE rr.visit_service_id = vs.id)
     ORDER BY vs.created_at DESC, vs.id DESC`).all(...(doctorId != null ? [Number(doctorId)] : []), ...lw.params);
}
// Состояние строки направления словами рекомендации: выполнена — «Выполнено»,
// отменена — «Отменено», иначе «Ожидает».
const LINE_KIND = (s) => (s === 'completed' ? 'done' : (s === 'cancelled' || s === 'removed') ? 'cancelled' : 'waiting');
const KIND_STATUS = { done: 'done', waiting: 'pending', cancelled: 'cancelled' };
const REC_KIND = { done: 'done', pending: 'waiting', cancelled: 'cancelled' };
```

`visitAggregates`. Заменить

```js
  const w = localRangeWhere('v.visit_date', from, to);
  const rows = db.prepare(`
    SELECT ${SOURCE_OF_VISIT} AS source_id, COUNT(*) AS visits, COUNT(DISTINCT v.patient_id) AS patients
      FROM visits v JOIN patients pt ON pt.id = v.patient_id
     WHERE ${VISIT_LIVE} AND ${SOURCE_OF_VISIT} IS NOT NULL AND ${w.sql}
     GROUP BY source_id`).all(...w.params);
```

на

```js
  const w = localRangeWhere('v.visit_date', from, to);
  // REFERRAL_LINE_V1 — и визиты, где источник только у строки.
  const rows = db.prepare(`
    SELECT sv.source_id AS source_id, COUNT(*) AS visits, COUNT(DISTINCT v.patient_id) AS patients
      FROM (${sourceVisitsSql(w.sql)}) sv
      JOIN visits v ON v.id = sv.visit_id
     WHERE ${VISIT_LIVE}
     GROUP BY sv.source_id`).all(...w.params, ...w.params);
```

«Представители» — пациенты. Заменить

```js
  const patients = db.prepare(`
    SELECT COUNT(DISTINCT v.patient_id) AS n
      FROM visits v JOIN patients pt ON pt.id = v.patient_id
      JOIN referral_sources rs ON rs.id = ${SOURCE_OF_VISIT}
     WHERE rs.doctor_id IS NULL AND ${VISIT_LIVE} AND ${w.sql}`).get(...w.params).n;
```

на

```js
  const patients = db.prepare(`
    SELECT COUNT(DISTINCT v.patient_id) AS n
      FROM (${sourceVisitsSql(w.sql)}) sv
      JOIN visits v ON v.id = sv.visit_id
      JOIN referral_sources rs ON rs.id = sv.source_id
     WHERE rs.doctor_id IS NULL AND ${VISIT_LIVE}`).get(...w.params, ...w.params).n;   // REFERRAL_LINE_V1
```

«Внутренние врачи» — счётчики. Заменить

```js
  const w = localRangeWhere('r.created_at', from, to);
  const counts = new Map(db.prepare(`
    SELECT r.recommended_by AS doctor_id,
           COUNT(*) AS referrals,
           SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS waiting,
           SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
           COUNT(DISTINCT r.patient_id) AS patients
      FROM recommended_services r
     WHERE r.recommended_by IS NOT NULL AND ${w.sql}
     GROUP BY r.recommended_by`).all(...w.params).map((r) => [r.doctor_id, r]));
```

на

```js
  const w = localRangeWhere('r.created_at', from, to);
  // REFERRAL_LINE_V1 — направления врача: рекомендации и строки визитов с его источником
  // (lineReferrals: строка, которой закрыта рекомендация, не считается второй раз).
  const counts = new Map();
  const bump = (doctorId, patientId, kind) => {
    if (doctorId == null) return;
    const c = counts.get(doctorId) || { referrals: 0, done: 0, waiting: 0, cancelled: 0, patients: new Set() };
    c.referrals += 1;
    if (kind) c[kind] += 1;
    if (patientId != null) c.patients.add(patientId);
    counts.set(doctorId, c);
  };
  for (const r of db.prepare(`SELECT r.recommended_by AS doctor_id, r.patient_id, r.status FROM recommended_services r
                               WHERE r.recommended_by IS NOT NULL AND ${w.sql}`).all(...w.params)) {
    bump(r.doctor_id, r.patient_id, REC_KIND[r.status] || null);
  }
  for (const l of lineReferrals(db, from, to)) bump(l.doctor_id, l.patient_id, LINE_KIND(l.status));
```

и в той же функции заменить

```js
      cancelled: c ? num(c.cancelled) : 0, patients: c ? num(c.patients) : 0,
```

на

```js
      cancelled: c ? num(c.cancelled) : 0, patients: c ? c.patients.size : 0,   // REFERRAL_LINE_V1 — разные пациенты обоих видов
```

Активность. Заменить

```js
  for (const r of db.prepare(`
      SELECT ${SOURCE_OF_VISIT} AS source_id, ${localDate('v.visit_date')} AS day
        FROM visits v JOIN patients pt ON pt.id = v.patient_id
       WHERE ${VISIT_LIVE} AND ${SOURCE_OF_VISIT} IS NOT NULL`).all()) {
```

на

```js
  for (const r of db.prepare(`
      SELECT sv.source_id AS source_id, ${localDate('v.visit_date')} AS day
        FROM (${sourceVisitsSql()}) sv JOIN visits v ON v.id = sv.visit_id
       WHERE ${VISIT_LIVE}`).all()) {   // REFERRAL_LINE_V1 — и визиты, где источник только у строки
```

«Подробнее» внешнего врача. Заменить

```js
     WHERE ${VISIT_LIVE} AND ${SOURCE_OF_VISIT} = ? AND ${w.sql}
     ORDER BY v.visit_date DESC`).all(sourceId, ...w.params);
```

на

```js
     WHERE ${VISIT_LIVE} AND v.id IN (SELECT sv.visit_id FROM (${sourceVisitsSql(w.sql)}) sv WHERE sv.source_id = ?) AND ${w.sql}
     ORDER BY v.visit_date DESC`).all(...w.params, ...w.params, sourceId, ...w.params);   // REFERRAL_LINE_V1
```

«Подробнее» врача клиники. Заменить

```js
  const referrals = db.prepare(`
    SELECT ${localDate('r.created_at')} AS date, r.status, r.patient_id, pt.full_name AS patient,
           COALESCE(s.name, r.service_name, '') AS service
      FROM recommended_services r
      LEFT JOIN patients pt ON pt.id = r.patient_id
      LEFT JOIN services s ON s.id = r.service_id
     WHERE r.recommended_by = ? AND ${w.sql}
     ORDER BY r.created_at DESC`).all(doctorId, ...w.params);
```

на

```js
  const recRows = db.prepare(`
    SELECT ${localDate('r.created_at')} AS date, r.status, r.patient_id, pt.full_name AS patient,
           COALESCE(s.name, r.service_name, '') AS service
      FROM recommended_services r
      LEFT JOIN patients pt ON pt.id = r.patient_id
      LEFT JOIN services s ON s.id = r.service_id
     WHERE r.recommended_by = ? AND ${w.sql}
     ORDER BY r.created_at DESC`).all(doctorId, ...w.params);
  // REFERRAL_LINE_V1 — и строки визитов с источником врача; новые сначала (сортировка
  // устойчивая: в один день рекомендации идут раньше строк).
  const lineRows = lineReferrals(db, from, to, doctorId).map((l) => ({
    date: l.date, status: KIND_STATUS[LINE_KIND(l.status)], patient_id: l.patient_id, patient: l.patient, service: l.service,
  }));
  const referrals = [...recRows, ...lineRows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/rpc/referrals.line.test.js server/services/rpc/referrals.test.js`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10a.6: «Реферирование» считает направления и по строкам визита

«Внутренние врачи» и «Подробнее» — рекомендации плюс строки с
источником врача (строка, которой закрыта рекомендация, — та же
рекомендация). Внешние врачи: визит «по источнику», если источник у
визита/пациента или у живой строки визита — числа сходятся со
строками «Рефералов».

REFERRAL_LINE_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/rpc/referrals.js server/services/rpc/referrals.line.test.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10a.7: журнал услуг — «Кто направил» берёт направившего строки первым

**Files:**
- Modify: `server/services/domain/journal-rules.js`, `server/services/domain/journal-rules.test.js`, `server/services/rpc/reports.js`

- [ ] **Step 1: failing test** — дописать в конец `server/services/domain/journal-rules.test.js`:

```js
test('REFERRAL_LINE_V1: у строки свой направивший — он и есть «Кто направил», раньше рекомендации и источника визита', () => {
  const recs = indexRecommendations([{ patient_id: 1, service_id: 1, day: '2026-03-05', doctor_id: 2, name: 'Терапевт Т.Т.' }]);
  const line = { admission_id: null, patient_id: 1, service_id: 1, day: '2026-03-09', visit_source: 'Клиника «Шифо»', visit_source_doctor_id: null };
  assert.deepEqual(referrerOf({ ...line, line_source: 'Хирург Х.Х.', line_source_doctor_id: 7 }, recs, null), { text: 'Хирург Х.Х.', doctorId: 7 });
  assert.deepEqual(referrerOf({ ...line, line_source: '  ' }, recs, null), { text: 'Терапевт Т.Т.', doctorId: 2 });
  assert.deepEqual(referrerOf({ admission_id: 3, line_source: 'Хирург Х.Х.' }, recs, { attending: 'Лечащий Л.Л.', attending_doctor_id: 3 }),
    { text: 'Лечащий Л.Л.', doctorId: 3 });
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/domain/journal-rules.test.js`
  Ожидается FAIL: `{ text: 'Терапевт Т.Т.', doctorId: 2 }` вместо `{ text: 'Хирург Х.Х.', doctorId: 7 }`.

- [ ] **Step 3: implement**

`server/services/domain/journal-rules.js` — заменить

```js
 * «сам». doctorId — врач направившего (для диагноза консультации) или null.
 */
export function referrerOf(line, recIndex, adm) {
```

на

```js
 * «сам». doctorId — врач направившего (для диагноза консультации) или null.
 * REFERRAL_LINE_V1 — у амбулаторной строки свой направивший (line_source: врач направил
 * из кабинета, «Кто направил» стойки) — он и есть ответ, раньше рекомендации и источника визита.
 */
export function referrerOf(line, recIndex, adm) {
```

и заменить

```js
  const recs = (recIndex && recIndex.get(line.patient_id + '|' + line.service_id)) || [];
```

на

```js
  const own = String(line.line_source || '').trim();   // REFERRAL_LINE_V1
  if (own) return { text: own, doctorId: line.line_source_doctor_id ?? null };
  const recs = (recIndex && recIndex.get(line.patient_id + '|' + line.service_id)) || [];
```

`server/services/rpc/reports.js` (`journalVisitLines`) — заменить

```js
           rs.name AS visit_source, rs.doctor_id AS visit_source_doctor_id,
```

на

```js
           rs.name AS visit_source, rs.doctor_id AS visit_source_doctor_id,
           lrs.name AS line_source, lrs.doctor_id AS line_source_doctor_id,   -- REFERRAL_LINE_V1 — направивший строки
```

и заменить

```js
      LEFT JOIN referral_sources rs ON rs.id = v.referral_source_id
```

на

```js
      LEFT JOIN referral_sources rs ON rs.id = v.referral_source_id
      LEFT JOIN referral_sources lrs ON lrs.id = vs.referred_by_source_id   -- REFERRAL_LINE_V1
```

`journalAdmissionLines` — заменить

```js
           NULL AS visit_source, NULL AS visit_source_doctor_id,
```

на

```js
           NULL AS visit_source, NULL AS visit_source_doctor_id,
           NULL AS line_source, NULL AS line_source_doctor_id,   -- REFERRAL_LINE_V1 — у стационара своего направившего строки нет
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/domain/journal-rules.test.js server/services/rpc/reports.service-journal.test.js server/services/rpc/reports.journals-pool.test.js server/routes/journals-http.test.js`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10a.7: журнал — «Кто направил» берёт направившего строки

У амбулаторной строки свой направивший (мигр. 270) — он и есть ответ,
раньше рекомендации «по услуге» и источника визита.

REFERRAL_LINE_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/domain/journal-rules.js server/services/domain/journal-rules.test.js server/services/rpc/reports.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10a.8: надпись о бонусе в кабинете — правда; комментарий о прежнем пределе модели

**Files:**
- Modify: `public/js/admin/views/service-workspace.js`, `server/services/rpc/referral-autofill.js` (комментарий), `public/js/admin/i18n-strings.js`
- Create: `public/js/admin/views/referral-line-texts.test.js`

- [ ] **Step 1: failing test** — создать `public/js/admin/views/referral-line-texts.test.js`:

```js
// REFERRAL_LINE_V1 — надпись под «Рекомендациями» кабинета говорила «Реферальный бонус
// начисляется при выполнении», а правило — оплаченные счета (reports.js referralLines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.readFileSync(path.join(HERE, 'service-workspace.js'), 'utf8');

test('кабинет: бонус за направление — «когда счёт оплачен», а не «при выполнении»', () => {
  assert.ok(!ws.includes('начисляется при выполнении'), 'неправдивая надпись осталась');
  const at = ws.indexOf('function recsCard(ctx)');
  assert.ok(at > 0, 'карточка «Рекомендации» не найдена');
  assert.match(ws.slice(at, at + 1400), /Бонус за направление начисляется, когда счёт оплачен\./);
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/views/referral-line-texts.test.js`
  Ожидается FAIL: «неправдивая надпись осталась».

- [ ] **Step 3: implement**

`public/js/admin/views/service-workspace.js` — заменить

```js
            'Реферальный бонус начисляется при выполнении.'),
```

на

```js
            'Бонус за направление начисляется, когда счёт оплачен.'),   // REFERRAL_LINE_V1 — правило «Рефералов»: оплаченные счета (было «при выполнении» — неправда)
```

`server/services/rpc/referral-autofill.js` — заменить

```js
// «направивший на визите».
import { hasAnyRole, effectiveRoles } from '../roles.js';
```

на

```js
// «направивший на визите».
// REFERRAL_LINE_V1 (3.21.0) — этот предел снят на уровне СТРОКИ: строка, заведённая по
// рекомендации, получает направившего сама (visit_services.referred_by_source_id —
// rpc/referral-orders.js referral_recommendation_attach), и «Рефералы» платят ему за неё
// (reports.js referralLines). Здесь по-прежнему — только источник визита.
import { hasAnyRole, effectiveRoles } from '../roles.js';
```

`public/js/admin/i18n-strings.js` — перед последней строкой `};`:

```js
  // REFERRAL_LINE_V1 — карточка «Рекомендации» кабинета врача (views/service-workspace.js)
  "Бонус за направление начисляется, когда счёт оплачен.": {"en":"The referral bonus accrues once the invoice is paid.","ru":"Бонус за направление начисляется, когда счёт оплачен.","uz":"Yo‘llanma uchun bonus hisob to‘langanda hisoblanadi."},   // REFERRAL_LINE_V1
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/views/referral-line-texts.test.js public/js/admin/__tests__/i18n-coverage.test.mjs`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10a.8: кабинет — «бонус начисляется, когда счёт оплачен»

Надпись под «Рекомендациями» говорила «при выполнении», а правило —
оплаченные счета. Комментарий referral-autofill.js о снятом пределе
модели «направивший на визите».

REFERRAL_LINE_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/service-workspace.js public/js/admin/views/referral-line-texts.test.js server/services/rpc/referral-autofill.js public/js/admin/i18n-strings.js
git commit -F .git/U10_MSG.txt
```

---

## U10b — DOCTOR_REFERRAL_DESK_V1

### Task U10b.1: RPC `patient_referral_orders`, `referral_recommendation_attach`, `referral_visit_links`

**Files:**
- Create: `server/services/rpc/referral-orders.js`, `server/routes/doctor-referral-desk.test.js`
- Modify: `server/services/rpc/index.js`, `server/services/control/gate.js`, `public/js/admin/views/act-as-history.js`, `public/js/admin/i18n-strings.js`

- [ ] **Step 1: failing test** — создать `server/routes/doctor-referral-desk.test.js`:

```js
// DOCTOR_REFERRAL_DESK_V1 — направления врача для окна регистрации: чтение (сегодня и вперёд,
// своё здание, состояние счёта, кому бонус — без сумм), привязка рекомендации к строке и метка
// календаря. Настоящее приложение и сессии (crm-unify-app.js): doc — врач №10 «Иванов».
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at } from '../test-helpers/crm-unify-app.js';
import { isReadOnlyRpc } from '../services/control/gate.js';

const TODAY = localDay(0);
const TOMORROW = localDay(1);
const srcOf = (db, doctorId) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(doctorId).id;
const lastVs = (db) => db.prepare('SELECT MAX(id) id FROM visit_services').get().id;
const recInsert = (db, { service = 60, by = 10, notes = 'к 9:00' } = {}) => Number(db.prepare(
  "INSERT INTO recommended_services (patient_id, service_id, service_name, recommended_by, notes, status) VALUES (77, ?, 'ЭКГ', ?, ?, 'pending')")
  .run(service, by, notes).lastInsertRowid);

function seed(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12,'doc2','x','Петров','doctor',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ',80000,'imaging'), (60,'ЭКГ',50000,'procedure')").run();
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (900, 'Клиника Партнёр')").run();
  db.prepare('UPDATE patients SET referral_source_id = 900 WHERE id = 77').run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (500, 77, ?, 'arrived')").run(at(TODAY, 9));
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (501, 77, ?, 'scheduled')").run(at(TOMORROW, 10));
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (503, 77, ?, 'scheduled')").run(at(localDay(2), 10));
}
async function doctorLine(t, values) {
  const r = await t.dbq('doc', { table: 'visit_services', op: 'insert', values: { quantity: 1, unit_price: 1, total: 1, status: 'added', ...values } });
  assert.equal(r.status, 200, r.text);
  return lastVs(t.db);
}
async function fixture() {
  const t = await startCrmApp(seed);
  const A = await doctorLine(t, { visit_id: 500, service_id: 40, referral_note: 'натощак' });     // сегодня, без счёта
  const B = await doctorLine(t, { visit_id: 500, service_id: 50, doctor_id: 12 });                // сегодня, в счёте
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: 500, visit_service_ids: [B], discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  const C = await doctorLine(t, { visit_id: 501, service_id: 50, doctor_id: 12 });                // завтра
  await doctorLine(t, { visit_id: 500, service_id: 30, doctor_id: 10 });                          // своя консультация — не направление
  const E = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 501, service_id: 40, quantity: 1, unit_price: 1, total: 1, status: 'added' } });
  assert.equal(E.status, 200, E.text);                                                             // строка стойки — не направление
  // Чужое здание: визит и строка, приехавшие из филиала B.
  t.db.prepare("INSERT INTO visits (id, patient_id, visit_date, status, sync_origin) VALUES (502, 77, ?, 'scheduled', 'B')").run(at(TOMORROW, 11));
  t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, status, created_by, sync_origin) VALUES (502, 50, 12, 'added', 10, 'B')").run();
  const rec = recInsert(t.db);
  return { t, A, B, C, rec, invoice: inv.json.data.invoice };
}

test('чтение: сегодня и вперёд, своё здание, состояние счёта, рекомендации, кому бонус — без сумм', async () => {
  const { t, A, B, C, rec, invoice } = await fixture();
  try {
    const r = await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 });
    assert.equal(r.status, 200, r.text);
    const d = r.json.data;
    assert.equal(d.today, TODAY);
    assert.deepEqual(d.lines.map((l) => l.visit_service_id), [A, B, C]);
    assert.ok(!d.lines.some((l) => l.visit_id === 502), 'строка чужого здания в списке');
    const [a, b, c] = d.lines;
    assert.deepEqual([a.day, a.bill.state, a.referrer_name, a.referral_note], [TODAY, 'none', 'Иванов', 'натощак']);
    assert.deepEqual([b.bill.state, b.bill.invoice_number], ['invoiced', invoice.invoice_number]);
    assert.deepEqual([c.day, c.bill.state, c.doctor_name], [TOMORROW, 'none', 'Петров']);
    assert.deepEqual(a.bonus_to, ['Клиника Партнёр', 'Иванов']);
    assert.deepEqual(d.recommendations.map((x) => [x.recommendation_id, x.name, x.referrer_name, x.notes]), [[rec, 'ЭКГ', 'Иванов', 'к 9:00']]);
    assert.deepEqual(d.recommendations[0].bonus_to, ['Клиника Партнёр', 'Иванов']);
    assert.ok(!/reward|percent|own_rates|"rate"/.test(r.text), 'регистратору ушли суммы или ставки бонуса: ' + r.text);
    const bad = await t.rpc('patient_referral_orders', 'reg', { patient_id: 'x' });
    assert.equal(bad.status, 400);
  } finally { t.close(); }
});

test('выставленное направление второй раз не выставляется', async () => {
  const { t, B } = await fixture();
  try {
    const again = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: 500, visit_service_ids: [B], discount_amount: 0, payer_id: null });
    assert.equal(again.status, 400, again.text);
    assert.match(again.json.error.message, /уже в счёте/);
  } finally { t.close(); }
});

test('«Добавить» рекомендацию: строка стойки привязана сервером — рекомендация закрыта, направивший — врач', async () => {
  const { t, A, C, rec } = await fixture();
  try {
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: 60, quantity: 1, unit_price: 1, total: 1, status: 'added' } });
    assert.equal(ins.status, 200, ins.text);
    const X = lastVs(t.db);
    assert.equal(t.db.prepare('SELECT referred_by_source_id s FROM visit_services WHERE id = ?').get(X).s, null, 'стойка без «Кто направил» направившего не ставит');
    assert.equal((await t.rpc('referral_recommendation_attach', 'kassa', { recommendation_id: rec, visit_service_id: X })).status, 403);
    const wrong = await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: rec, visit_service_id: A });
    assert.equal(wrong.status, 400, 'строка другой услуги');
    const ok = await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: rec, visit_service_id: X });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.data.referred_by_source_id, srcOf(t.db, 10));
    assert.deepEqual(t.db.prepare('SELECT referred_by_source_id, referral_note FROM visit_services WHERE id = ?').get(X),
      { referred_by_source_id: srcOf(t.db, 10), referral_note: 'к 9:00' });
    assert.deepEqual(t.db.prepare('SELECT status, visit_service_id FROM recommended_services WHERE id = ?').get(rec), { status: 'done', visit_service_id: X });
    assert.equal((await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: rec, visit_service_id: X })).status, 409);
    const after = (await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 })).json.data;
    assert.equal(after.recommendations.length, 0);
    assert.ok(after.lines.some((l) => l.visit_service_id === X), 'строка по рекомендации — направление врача');
    // Врач привязывает только свою рекомендацию.
    const foreign = recInsert(t.db, { service: 50, by: 12, notes: '' });
    assert.equal((await t.rpc('referral_recommendation_attach', 'doc', { recommendation_id: foreign, visit_service_id: C })).status, 403);
  } finally { t.close(); }
});

test('метка календаря: визиты с направлением врача и имя направившего', async () => {
  const { t } = await fixture();
  try {
    const r = await t.rpc('referral_visit_links', 'reg', { visit_ids: [500, 501, 503] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.data, [{ visit_id: 500, doctor_name: 'Иванов' }, { visit_id: 501, doctor_name: 'Иванов' }]);
  } finally { t.close(); }
});

test('лицензия: оба чтения — в READ_ONLY_RPCS, привязка — запись', () => {
  assert.equal(isReadOnlyRpc('patient_referral_orders'), true);
  assert.equal(isReadOnlyRpc('referral_visit_links'), true);
  assert.equal(isReadOnlyRpc('referral_recommendation_attach'), false);
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/routes/doctor-referral-desk.test.js`
  Ожидается FAIL: `patient_referral_orders` — 501 `rpc_not_implemented`; `isReadOnlyRpc` — false.

- [ ] **Step 3: implement** — создать `server/services/rpc/referral-orders.js`:

```js
// DOCTOR_REFERRAL_DESK_V1 (2026-11-02, выпуск 3.21.0) — НАПРАВЛЕНИЯ ВРАЧА В ОКНЕ РЕГИСТРАЦИИ.
//
// Регистратура видела записи колл-центра («из записи», booked-rows.js) и заявки CRM («из
// заявки»), а направление врача — уже выставленное и в очереди — мастер визита молча
// пропускал, быстрая регистрация писала лишь «По записи уже в счёте»; будущие дни и визиты
// «Пришёл» — ничего; «от врача» нигде не было. Рекомендации врача (recommended_services)
// были видны только во вкладке «Услуги» окна визита.
//
// Три вызова:
//   patient_referral_orders({ patient_id }) — ЧТЕНИЕ: открытые строки визитов пациента
//     (своё здание, визит не отменён и не «не пришёл», день визита — сегодня и вперёд,
//     строка не выполнена, не отменена, её счёт не отменён), НАПРАВЛЕННЫЕ ВРАЧОМ: у строки
//     внутренний источник врача (REFERRAL_LINE_V1) или её завёл врач к ДРУГОМУ исполнителю;
//     плюс открытые рекомендации. В строке — услуга, кто направил, день, состояние счёта
//     (нет / в счёте № / оплачено), рекомендация врача и КОМУ бонус — ИМЕНА, сумм и ставок
//     нет вовсе (решение владельца 2026-11-02: регистратор видит, кому, но не сколько).
//   referral_recommendation_attach({ recommendation_id, visit_service_id }) — ЗАПИСЬ: строка,
//     заведённая по рекомендации, привязывается к ней — рекомендация закрывается («done»,
//     visit_service_id), строке ставится направивший (включённый внутренний источник
//     рекомендовавшего врача; не на его же строку) и рекомендация врача. Доказательство —
//     открытая рекомендация того же пациента и той же услуги (как у visit_set_doctor_referrer).
//     Строку, по которой платили, не трогают: её деньги уже поделены.
//   referral_visit_links({ visit_ids }) — ЧТЕНИЕ: метка «от врача» календаря — номер визита
//     и имя направившего, без услуг и денег.
//
// «Кому бонус» — lineBeneficiaries (domain/line-referral.js), то же правило, что у отчётов.
import { hasAnyRole, effectiveRoles } from '../roles.js';
import { today, localDate } from '../domain/day.js';
import { lineBeneficiaries } from '../domain/line-referral.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Окна регистрации открывают стойка и врач; касса и медсёстры видят то же (только чтение).
const ORDER_ROLES = ['admin', 'registrar', 'doctor', 'head_doctor', 'cashier', 'nurse', 'senior_nurse'];
// Привязку делают те, кто добавляет услуги из рекомендации в визит (как visit_set_doctor_referrer).
const ATTACH_ROLES = ['admin', 'registrar', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];
// Чужую рекомендацию привязывают только стойка и медсёстры; врач — свою.
const ATTACH_DESK_ROLES = ['admin', 'registrar', 'nurse', 'senior_nurse'];
const LINKS_MAX = 500;
const NOTE_MAX = 500;
const isPosInt = (v) => Number.isInteger(v) && v > 0;

// Строка — «направление врача»: у неё внутренний источник врача, или её завёл врач к ДРУГОМУ
// исполнителю (у врача без источника направившего нет, но направление — есть). Алиасы: vs —
// строка, lrs — её источник, cu — кто завёл.
const DOCTOR_ORDER_SQL = `((lrs.id IS NOT NULL AND lrs.doctor_id IS NOT NULL)
   OR ((cu.is_doctor = 1 OR cu.role = 'doctor') AND COALESCE(vs.doctor_id, 0) <> cu.id))`;

function billOf(r) {
  if (r.invoice_id == null) return { state: 'none', invoice_id: null, invoice_number: null };
  return { state: r.invoice_status === 'paid' ? 'paid' : 'invoiced', invoice_id: r.invoice_id,
           invoice_number: r.invoice_number || String(r.invoice_id) };
}
const namesOf = (bens, baseName, lineName) => bens.map((b) => (b.via === 'visit' ? baseName : lineName)).filter(Boolean);

/** patient_referral_orders({ patient_id }) → { patient_id, today, lines, recommendations } */
export function patientReferralOrders(db, args, user) {
  if (!hasAnyRole(user, ORDER_ROLES)) throw new RpcError('Направления врача вашей роли недоступны.', 403);
  const patientId = Number(args && args.patient_id);
  if (!isPosInt(patientId)) throw new RpcError('Пациент указан неверно.', 400);
  const day = today(db);
  const lines = db.prepare(`
    SELECT vs.id AS visit_service_id, vs.visit_id, ${localDate('v.visit_date')} AS day,
           vs.scheduled_at, v.status AS visit_status, vs.service_id, vs.consultation_type_id,
           COALESCE(s.name, ct.name_ru, ct.name, '') AS name, vs.quantity, vs.unit_price, vs.doctor_id,
           COALESCE(NULLIF(pu.full_name, ''), pu.username) AS doctor_name,
           vs.status, vs.referral_note, vs.referred_by_source_id,
           lrs.name AS line_source_name, lrs.doctor_id AS line_source_doctor_id,
           COALESCE(lrs.doctor_id, vs.created_by) AS referrer_id,
           COALESCE(NULLIF(ru.full_name, ''), ru.username, lrs.name, '') AS referrer_name,
           bs.id AS base_source_id, bs.name AS base_source_name, bs.doctor_id AS base_source_doctor_id,
           i.id AS invoice_id, i.invoice_number, i.status AS invoice_status
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      JOIN patients pt ON pt.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN consultation_types ct ON ct.id = vs.consultation_type_id
      LEFT JOIN users pu ON pu.id = vs.doctor_id
      LEFT JOIN users cu ON cu.id = vs.created_by
      LEFT JOIN referral_sources lrs ON lrs.id = vs.referred_by_source_id
      LEFT JOIN users ru ON ru.id = COALESCE(lrs.doctor_id, vs.created_by)
      LEFT JOIN referral_sources bs ON bs.id = COALESCE(v.referral_source_id, pt.referral_source_id)
      LEFT JOIN invoice_items ii ON ii.id = vs.invoice_item_id
      LEFT JOIN invoices i ON i.id = ii.invoice_id
     WHERE v.patient_id = ?
       AND v.sync_origin IS NULL AND vs.sync_origin IS NULL
       AND v.status NOT IN ('cancelled', 'no_show')
       AND ${localDate('v.visit_date')} >= ?
       AND vs.clinic_item_id IS NULL
       AND vs.status NOT IN ('completed', 'cancelled', 'removed')
       AND (i.id IS NULL OR i.status NOT IN ('void', 'refunded'))
       AND ${DOCTOR_ORDER_SQL}
     ORDER BY day, COALESCE(vs.scheduled_at, v.visit_date), vs.id`).all(patientId, day)
    .map((r) => ({
      visit_service_id: r.visit_service_id, visit_id: r.visit_id, day: r.day, scheduled_at: r.scheduled_at || null,
      visit_status: r.visit_status, service_id: r.service_id ?? null, consultation_type_id: r.consultation_type_id ?? null,
      name: r.name || '', quantity: Number(r.quantity) || 1, unit_price: Number(r.unit_price) || 0,
      doctor_id: r.doctor_id ?? null, doctor_name: r.doctor_name || '', status: r.status,
      referrer_id: r.referrer_id ?? null, referrer_name: r.referrer_name || '',
      referral_note: r.referral_note || '',
      bill: billOf(r),
      bonus_to: namesOf(lineBeneficiaries(
        r.base_source_id != null ? { id: r.base_source_id, doctor_id: r.base_source_doctor_id } : null,
        r.referred_by_source_id != null ? { id: r.referred_by_source_id, doctor_id: r.line_source_doctor_id } : null,
        r.doctor_id), r.base_source_name, r.line_source_name),
    }));
  const recommendations = db.prepare(`
    SELECT r.id AS recommendation_id, r.service_id, COALESCE(s.name, r.service_name, '') AS name,
           r.recommended_by AS referrer_id,
           COALESCE(NULLIF(u.full_name, ''), NULLIF(r.recommended_by_name, ''), u.username, '') AS referrer_name,
           r.created_at, r.notes, r.source_visit_id,
           rs.id AS rec_source_id, rs.name AS rec_source_name, rs.doctor_id AS rec_source_doctor_id,
           ps.id AS base_source_id, ps.name AS base_source_name, ps.doctor_id AS base_source_doctor_id
      FROM recommended_services r
      JOIN patients pt ON pt.id = r.patient_id
      LEFT JOIN services s ON s.id = r.service_id
      LEFT JOIN users u ON u.id = r.recommended_by
      LEFT JOIN referral_sources rs ON rs.doctor_id = r.recommended_by AND rs.active = 1
      LEFT JOIN referral_sources ps ON ps.id = pt.referral_source_id
     WHERE r.patient_id = ? AND r.closed_at IS NULL AND COALESCE(r.status, '') NOT IN ('done', 'cancelled')
     ORDER BY r.created_at DESC, r.id DESC`).all(patientId)
    .map((r) => ({
      recommendation_id: r.recommendation_id, service_id: r.service_id ?? null, name: r.name || '',
      referrer_id: r.referrer_id ?? null, referrer_name: r.referrer_name || '', created_at: r.created_at,
      notes: r.notes || '', source_visit_id: r.source_visit_id ?? null,
      bonus_to: namesOf(lineBeneficiaries(
        r.base_source_id != null ? { id: r.base_source_id, doctor_id: r.base_source_doctor_id } : null,
        r.rec_source_id != null ? { id: r.rec_source_id, doctor_id: r.rec_source_doctor_id } : null,
        null), r.base_source_name, r.rec_source_name),
    }));
  return { patient_id: patientId, today: day, lines, recommendations };
}

/** referral_recommendation_attach({ recommendation_id, visit_service_id }) → { attached, …, referred_by_source_id } */
export function referralRecommendationAttach(db, args, user) {
  if (!hasAnyRole(user, ATTACH_ROLES)) {
    throw new RpcError('Добавлять рекомендации врача в визит может регистратура, врач, медсестра или администратор.', 403);
  }
  const recId = Number(args && args.recommendation_id);
  const vsId = Number(args && args.visit_service_id);
  if (!isPosInt(recId)) throw new RpcError('Рекомендация указана неверно.', 400);
  if (!isPosInt(vsId)) throw new RpcError('Строка услуги указана неверно.', 400);
  const run = db.transaction(() => {
    const rec = db.prepare('SELECT * FROM recommended_services WHERE id = ?').get(recId);
    if (!rec) throw new RpcError('Рекомендация не найдена.', 404);
    if (rec.closed_at != null || rec.status === 'done' || rec.status === 'cancelled') {
      throw new RpcError('Рекомендация уже закрыта — её добавили в визит или убрали.', 409);
    }
    if (!hasAnyRole(user, ATTACH_DESK_ROLES) && Number(rec.recommended_by) !== Number(user && user.id)) {
      throw new RpcError('Врач может добавить в визит только свою рекомендацию.', 403);
    }
    const line = db.prepare(`SELECT vs.*, v.patient_id AS visit_patient_id, v.sync_origin AS visit_origin
                               FROM visit_services vs JOIN visits v ON v.id = vs.visit_id WHERE vs.id = ?`).get(vsId);
    if (!line) throw new RpcError('Строка услуги не найдена.', 404);
    if (Number(line.visit_patient_id) !== Number(rec.patient_id)) throw new RpcError('Строка услуги — у другого пациента.', 400);
    if (rec.service_id == null || Number(line.service_id) !== Number(rec.service_id)) {
      throw new RpcError('Услуга строки не та, что в рекомендации.', 400);
    }
    if (line.visit_origin != null || line.sync_origin != null) {
      throw new RpcError('Строка услуги заведена в другом здании — привязать рекомендацию можно только там.', 400);
    }
    const paid = line.invoice_item_id != null && db.prepare(`SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.id = ? AND (COALESCE(i.paid_amount, 0) > 0 OR i.status IN ('paid', 'partial'))`).get(line.invoice_item_id);
    if (paid) throw new RpcError('По этой строке уже есть оплата — направившего у неё не меняют.', 409);
    let stamped = line.referred_by_source_id ?? null;
    if (stamped == null && rec.recommended_by != null) {
      const src = db.prepare('SELECT id, doctor_id FROM referral_sources WHERE doctor_id = ? AND active = 1 ORDER BY id LIMIT 1').get(rec.recommended_by);
      if (src && !(line.doctor_id != null && Number(line.doctor_id) === Number(src.doctor_id))) {
        db.prepare('UPDATE visit_services SET referred_by_source_id = ? WHERE id = ? AND referred_by_source_id IS NULL').run(src.id, vsId);
        stamped = src.id;
      }
    }
    const note = typeof rec.notes === 'string' ? rec.notes.trim().slice(0, NOTE_MAX) : '';
    if (note && (line.referral_note == null || line.referral_note === '')) {
      db.prepare('UPDATE visit_services SET referral_note = ? WHERE id = ?').run(note, vsId);
    }
    db.prepare(`UPDATE recommended_services SET status = 'done', closed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), visit_service_id = ?
                 WHERE id = ?`).run(vsId, recId);
    return { attached: true, recommendation_id: recId, visit_service_id: vsId, referred_by_source_id: stamped };
  });
  return run();
}

/** referral_visit_links({ visit_ids }) → [{ visit_id, doctor_name }] */
export function referralVisitLinks(db, args, user) {
  if (!user || !effectiveRoles(user).length) throw new RpcError('Метки направлений врача вашей роли недоступны.', 403);
  const raw = Array.isArray(args && args.visit_ids) ? args.visit_ids : [];
  const ids = [...new Set(raw.map(Number).filter(isPosInt))].slice(0, LINKS_MAX);
  if (!ids.length) return [];
  return db.prepare(`
    SELECT vs.visit_id AS visit_id, MIN(COALESCE(NULLIF(ru.full_name, ''), ru.username, lrs.name, '')) AS doctor_name
      FROM visit_services vs
      LEFT JOIN users cu ON cu.id = vs.created_by
      LEFT JOIN referral_sources lrs ON lrs.id = vs.referred_by_source_id
      LEFT JOIN users ru ON ru.id = COALESCE(lrs.doctor_id, vs.created_by)
     WHERE vs.visit_id IN (${ids.map(() => '?').join(',')})
       AND vs.clinic_item_id IS NULL
       AND vs.status NOT IN ('cancelled', 'removed')
       AND ${DOCTOR_ORDER_SQL}
     GROUP BY vs.visit_id
     ORDER BY vs.visit_id`).all(...ids);
}
```

`server/services/rpc/index.js` — импорт. Заменить

```js
import { visitSetDoctorReferrer } from './referral-autofill.js';   // REPORTS_V2 — направивший врач на визите по рекомендации
```

на

```js
import { visitSetDoctorReferrer } from './referral-autofill.js';   // REPORTS_V2 — направивший врач на визите по рекомендации
import { patientReferralOrders, referralRecommendationAttach, referralVisitLinks } from './referral-orders.js';   // DOCTOR_REFERRAL_DESK_V1 — «Направления врача» у стойки
```

Карта RPC. Заменить начало строки

```js
  visit_set_doctor_referrer: (db, args, user) => visitSetDoctorReferrer(db, args, user),
```

на

```js
  patient_referral_orders:   (db, args, user) => patientReferralOrders(db, args, user),          // DOCTOR_REFERRAL_DESK_V1 — направления врача пациента (чтение)
  referral_recommendation_attach: (db, args, user) => referralRecommendationAttach(db, args, user),   // DOCTOR_REFERRAL_DESK_V1 — строка по рекомендации
  referral_visit_links:      (db, args, user) => referralVisitLinks(db, args, user),             // DOCTOR_REFERRAL_DESK_V1 — метка «от врача» календаря
  visit_set_doctor_referrer: (db, args, user) => visitSetDoctorReferrer(db, args, user),
```

(хвост прежней строки `visit_set_doctor_referrer` с её комментарием остаётся как был.)

`server/services/control/gate.js` (`READ_ONLY_RPCS`) — заменить

```js
  // …и метка «из заявки» на записях календаря (crm_visit_links) — чтение.
  'crm_visit_links',
```

на

```js
  // …и метка «из заявки» на записях календаря (crm_visit_links) — чтение.
  'crm_visit_links',
  // DOCTOR_REFERRAL_DESK_V1 — направления врача пациента у стойки и метка «от врача»
  // календаря — чтения. Привязка рекомендации к строке (referral_recommendation_attach) — запись.
  'patient_referral_orders', 'referral_visit_links',
```

`public/js/admin/views/act-as-history.js` (`RPC_LABELS`) — заменить

```js
    referrals_representative_options: 'Реферирование: список медпредставителей',   // REFERRAL_REP_ON_CREATE_V1
```

на

```js
    referrals_representative_options: 'Реферирование: список медпредставителей',   // REFERRAL_REP_ON_CREATE_V1
    patient_referral_orders: 'Направления врача пациента',          // DOCTOR_REFERRAL_DESK_V1
    referral_recommendation_attach: 'Рекомендация врача — в визит', // DOCTOR_REFERRAL_DESK_V1
    referral_visit_links: 'Метки «от врача» в календаре',            // DOCTOR_REFERRAL_DESK_V1
```

`public/js/admin/i18n-strings.js` — перед последней строкой `};`:

```js
  // DOCTOR_REFERRAL_DESK_V1 — отказы rpc/referral-orders.js и подписи журнала «входа от имени»
  "Направления врача вашей роли недоступны.": {"en":"Doctor referrals are not available for your role.","ru":"Направления врача вашей роли недоступны.","uz":"Shifokor yo‘llanmalari sizning rolingiz uchun ochiq emas."},   // DOCTOR_REFERRAL_DESK_V1
  "Добавлять рекомендации врача в визит может регистратура, врач, медсестра или администратор.": {"en":"Doctor recommendations can be added to a visit by the front desk, a doctor, a nurse or an administrator.","ru":"Добавлять рекомендации врача в визит может регистратура, врач, медсестра или администратор.","uz":"Shifokor tavsiyalarini tashrifga registratura, shifokor, hamshira yoki administrator qo‘sha oladi."},   // DOCTOR_REFERRAL_DESK_V1
  "Рекомендация не найдена.": {"en":"Recommendation not found.","ru":"Рекомендация не найдена.","uz":"Tavsiya topilmadi."},   // DOCTOR_REFERRAL_DESK_V1
  "Рекомендация уже закрыта — её добавили в визит или убрали.": {"en":"The recommendation is already closed — it was added to a visit or removed.","ru":"Рекомендация уже закрыта — её добавили в визит или убрали.","uz":"Tavsiya allaqachon yopilgan — u tashrifga qo‘shilgan yoki olib tashlangan."},   // DOCTOR_REFERRAL_DESK_V1
  "Врач может добавить в визит только свою рекомендацию.": {"en":"A doctor can add only their own recommendation to a visit.","ru":"Врач может добавить в визит только свою рекомендацию.","uz":"Shifokor tashrifga faqat o‘z tavsiyasini qo‘sha oladi."},   // DOCTOR_REFERRAL_DESK_V1
  "Строка услуги — у другого пациента.": {"en":"The service line belongs to another patient.","ru":"Строка услуги — у другого пациента.","uz":"Xizmat qatori boshqa bemorga tegishli."},   // DOCTOR_REFERRAL_DESK_V1
  "Услуга строки не та, что в рекомендации.": {"en":"The line's service is not the recommended one.","ru":"Услуга строки не та, что в рекомендации.","uz":"Qatordagi xizmat tavsiyadagi xizmat emas."},   // DOCTOR_REFERRAL_DESK_V1
  "Строка услуги заведена в другом здании — привязать рекомендацию можно только там.": {"en":"The service line was created in another building — the recommendation can be linked only there.","ru":"Строка услуги заведена в другом здании — привязать рекомендацию можно только там.","uz":"Xizmat qatori boshqa binoda kiritilgan — tavsiyani faqat o‘sha yerda bog‘lash mumkin."},   // DOCTOR_REFERRAL_DESK_V1
  "По этой строке уже есть оплата — направившего у неё не меняют.": {"en":"This line has already been paid — its referrer is not changed.","ru":"По этой строке уже есть оплата — направившего у неё не меняют.","uz":"Bu qator bo‘yicha to‘lov allaqachon bor — uning yo‘llovchisi o‘zgartirilmaydi."},   // DOCTOR_REFERRAL_DESK_V1
  "Метки направлений врача вашей роли недоступны.": {"en":"Doctor referral marks are not available for your role.","ru":"Метки направлений врача вашей роли недоступны.","uz":"Shifokor yo‘llanmasi belgilari sizning rolingiz uchun ochiq emas."},   // DOCTOR_REFERRAL_DESK_V1
  "Направления врача пациента": {"en":"Patient's doctor referrals","ru":"Направления врача пациента","uz":"Bemorning shifokor yo‘llanmalari"},   // DOCTOR_REFERRAL_DESK_V1
  "Рекомендация врача — в визит": {"en":"Doctor's recommendation added to the visit","ru":"Рекомендация врача — в визит","uz":"Shifokor tavsiyasi — tashrifga"},   // DOCTOR_REFERRAL_DESK_V1
  "Метки «от врача» в календаре": {"en":"“From doctor” marks in the calendar","ru":"Метки «от врача» в календаре","uz":"Kalendardagi «shifokordan» belgilari"},   // DOCTOR_REFERRAL_DESK_V1
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/routes/doctor-referral-desk.test.js server/routes/licence-gate.test.js server/i18n-server-messages.test.js server/services/rpc/client-rpc-coverage.test.js`
  Ожидается PASS. (Обход всех RPC `server/services/rpc/index.test.js` идёт 10–15 минут — прогнать один раз в U10b.9.)

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10b.1: направления врача для стойки — чтение, привязка рекомендации, метка

patient_referral_orders: строки, направленные врачами (свой источник
врача или завёл врач к другому исполнителю), сегодня и вперёд, своё
здание, состояние счёта, рекомендация врача, кому бонус — имена без
сумм; открытые рекомендации. referral_recommendation_attach закрывает
рекомендацию строкой и ставит ей направившего. referral_visit_links —
метка «от врача». Оба чтения — в READ_ONLY_RPCS.

DOCTOR_REFERRAL_DESK_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/rpc/referral-orders.js server/routes/doctor-referral-desk.test.js server/services/rpc/index.js server/services/control/gate.js public/js/admin/views/act-as-history.js public/js/admin/i18n-strings.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10b.2: клиентский модуль `doctor-orders.js` — одно чтение и одни подписи на оба окна

**Files:**
- Create: `public/js/admin/doctor-orders.js`, `public/js/admin/__tests__/doctor-orders.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/doctor-orders.test.mjs`:

```js
// DOCTOR_REFERRAL_DESK_V1 — «Направления врача»: одно чтение и одни подписи на оба окна
// регистрации (быстрая регистрация, мастер визита). Модуль без DOM — стенд: фальшивый fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CALLS = [];
let ANSWER = { data: null };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  CALLS.push({ u, body });
  if (u.startsWith('/api/rpc/patient_referral_orders')) return { ok: !ANSWER.error, json: async () => ANSWER };
  return { ok: true, json: async () => ({ data: null }) };
};
const { loadDoctorOrders, orderKind, orderStateText, bonusText, orderVsIds, dmyOf } = await import('../doctor-orders.js');

test('спрашивает сервер о направлениях именно этого пациента; пустой ответ — пустые списки', async () => {
  CALLS.length = 0; ANSWER = { data: null };
  const o = await loadDoctorOrders(77);
  assert.deepEqual(CALLS.map((c) => [c.u, c.body]), [['/api/rpc/patient_referral_orders', { patient_id: 77 }]]);
  assert.deepEqual(o, { lines: [], recommendations: [], today: null });
  assert.deepEqual(await loadDoctorOrders(0), { lines: [], recommendations: [], today: null });
  assert.equal(CALLS.length, 1, 'без пациента сервер не спрашивают');
});

test('отказ сервера — исключение со словами сервера, а не «направлений нет»', async () => {
  ANSWER = { error: { message: 'Направления врача вашей роли недоступны.' } };
  await assert.rejects(loadDoctorOrders(77), /недоступны/);
  ANSWER = { data: null };
});

test('вид строки: сегодня без счёта — к оформлению; другой день; в счёте — ждёт кассу; оплачено', () => {
  const T = '2026-11-02';
  const line = (over) => ({ day: T, bill: { state: 'none', invoice_number: null }, ...over });
  assert.equal(orderKind(line({}), T), 'ready');
  assert.equal(orderKind(line({ day: '2026-11-03' }), T), 'future');
  assert.equal(orderKind(line({ bill: { state: 'invoiced', invoice_number: 'A-12' } }), T), 'billed');
  assert.equal(orderKind(line({ bill: { state: 'paid', invoice_number: 'A-12' } }), T), 'paid');
  assert.deepEqual(orderStateText(line({ bill: { state: 'invoiced', invoice_number: 'A-12' } }), T),
    { template: 'ждёт оплаты в кассе, счёт № {no}', params: { no: 'A-12' } });
  assert.deepEqual(orderStateText(line({ bill: { state: 'paid', invoice_number: 'A-12' } }), T),
    { template: 'оплачено, счёт № {no}', params: { no: 'A-12' } });
  assert.deepEqual(orderStateText(line({ day: '2026-11-03' }), T), { template: 'на {day}', params: { day: '03.11.2026' } });
  assert.deepEqual(orderStateText(line({}), T), { template: 'сегодня — к оформлению', params: {} });
});

test('кому бонус — имена через запятую; без получателей подписи нет; номера строк направлений', () => {
  assert.deepEqual(bonusText(['Клиника Х', 'Иванов']), { template: 'Бонус: {names}', params: { names: 'Клиника Х, Иванов' } });
  assert.equal(bonusText([]), null);
  assert.equal(bonusText(['', null]), null);
  assert.deepEqual([...orderVsIds({ lines: [{ visit_service_id: 5 }, { visit_service_id: '7' }] })], [5, 7]);
  assert.equal(orderVsIds(null).size, 0);
  assert.equal(dmyOf('2026-11-03'), '03.11.2026');
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/doctor-orders.test.mjs`
  Ожидается FAIL: `Cannot find module '.../doctor-orders.js'`.

- [ ] **Step 3: implement** — создать `public/js/admin/doctor-orders.js`:

```js
// DOCTOR_REFERRAL_DESK_V1 (2026-11-02) — «НАПРАВЛЕНИЯ ВРАЧА» В ОКНАХ РЕГИСТРАЦИИ.
//
// Одно чтение и одни подписи на оба окна — быструю регистрацию и мастер визита (две копии
// одного чтения уже расходились у строк «из заявки», crm-lines.js). Без DOM.
//
// Сервер (rpc/referral-orders.js patient_referral_orders) отдаёт открытые строки, на
// которые направил врач (сегодня и вперёд, своё здание), и открытые рекомендации; здесь —
// какой это вид строки для стойки и как его назвать (шаблон + параметры: перевод — у
// вызывающего, trf).
import { supabase } from '../supabase.js';

const EMPTY = () => ({ lines: [], recommendations: [], today: null });

/** Направления врача пациента. Бросает при отказе сервера (пустой ответ ≠ «не загрузилось»). */
export async function loadDoctorOrders(patientId) {
    const id = Number(patientId);
    if (!Number.isInteger(id) || id <= 0) return EMPTY();
    const { data, error } = await supabase.rpc('patient_referral_orders', { patient_id: id });
    if (error) throw new Error(error.message || String(error));
    if (!data) return EMPTY();
    return {
        lines: Array.isArray(data.lines) ? data.lines : [],
        recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
        today: data.today || null,
    };
}

/**
 * Вид строки для стойки: 'ready' — сегодня и без счёта (окно оформляет её само, второй строки
 * нет); 'future' — без счёта, другой день; 'billed' — в счёте, ждёт кассу; 'paid' — оплачено.
 */
export function orderKind(line, todayIso) {
    if (!line) return null;
    const st = line.bill && line.bill.state;
    if (st === 'paid') return 'paid';
    if (st === 'invoiced') return 'billed';
    return line.day === todayIso ? 'ready' : 'future';
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY'. */
export function dmyOf(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** Состояние строки словами — { template, params } (переводит вызывающий через trf). */
export function orderStateText(line, todayIso) {
    const kind = orderKind(line, todayIso);
    const no = line && line.bill ? line.bill.invoice_number : null;
    if (kind === 'paid') return { template: 'оплачено, счёт № {no}', params: { no } };
    if (kind === 'billed') return { template: 'ждёт оплаты в кассе, счёт № {no}', params: { no } };
    if (kind === 'future') return { template: 'на {day}', params: { day: dmyOf(line.day) } };
    return { template: 'сегодня — к оформлению', params: {} };
}

/** Кому бонус за строку — имена (сумм окно не знает); без получателей — null. */
export function bonusText(names) {
    const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n.trim());
    return list.length ? { template: 'Бонус: {names}', params: { names: list.join(', ') } } : null;
}

/** Номера строк визита — направлений врача (строки «из записи» с ними второй раз не берутся). */
export function orderVsIds(orders) {
    return new Set(((orders && orders.lines) || []).map((l) => Number(l.visit_service_id)).filter(Number.isInteger));
}
```

`public/js/admin/i18n-strings.js` — перед последней строкой `};`:

```js
  // DOCTOR_REFERRAL_DESK_V1 — подписи «Направлений врача» (public/js/admin/doctor-orders.js)
  "оплачено, счёт № {no}": {"en":"paid, invoice No. {no}","ru":"оплачено, счёт № {no}","uz":"to‘langan, hisob № {no}"},   // DOCTOR_REFERRAL_DESK_V1
  "ждёт оплаты в кассе, счёт № {no}": {"en":"awaiting payment at the cash desk, invoice No. {no}","ru":"ждёт оплаты в кассе, счёт № {no}","uz":"kassada to‘lov kutilmoqda, hisob № {no}"},   // DOCTOR_REFERRAL_DESK_V1
  "на {day}": {"en":"for {day}","ru":"на {day}","uz":"{day} kuniga"},   // DOCTOR_REFERRAL_DESK_V1
  "сегодня — к оформлению": {"en":"today — ready to register","ru":"сегодня — к оформлению","uz":"bugun — rasmiylashtirishga tayyor"},   // DOCTOR_REFERRAL_DESK_V1
  "Бонус: {names}": {"en":"Bonus: {names}","ru":"Бонус: {names}","uz":"Bonus: {names}"},   // DOCTOR_REFERRAL_DESK_V1
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/doctor-orders.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10b.2: doctor-orders.js — чтение и подписи направлений врача

Одно чтение patient_referral_orders и одни подписи (вид строки,
состояние счёта, кому бонус) на быструю регистрацию и мастер визита.

DOCTOR_REFERRAL_DESK_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/doctor-orders.js public/js/admin/__tests__/doctor-orders.test.mjs public/js/admin/i18n-strings.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10b.3: `registerWalkIn` — «Код отправителя» и в строку; строка по рекомендации привязывается

**Files:**
- Modify: `public/js/admin/views/walk-in-booking.js`
- Create: `public/js/admin/__tests__/doctor-orders-desk-live.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/doctor-orders-desk-live.test.mjs`. **Стенд** — дословная копия из `public/js/admin/__tests__/booked-rows-live.test.mjs`: от строки `import { test } from 'node:test';` до конца функции `async function save(dlg) { … }` включительно (фальшивый DOM, тосты, `live(seed)` с входом регистратора, перехват `fetch` на настоящее приложение `crm-unify-app.js`, импорты `startCrmApp`, `localDay`, `callcenterBook`, `vsOf`, `openFastRegistrationDialog`, `registerWalkIn`, `attachPackagePrices`, `supabase`, `setFullAccess`, помощники `TODAY`, `tick`, `walk`, `textOf`, `hasClass`, `buttons`, `btnByText`, `digits`, `seedEkg`, `writesOf`, `moneySnap`, `pickPatient`, `waitCatalog`, `save`). Сверху — своя шапка:

```js
// DOCTOR_REFERRAL_DESK_V1 · REFERRAL_LINE_V1 — НАПРАВЛЕНИЯ ВРАЧА В ОКНЕ РЕГИСТРАЦИИ НА НАСТОЯЩЕМ
// СЕРВЕРЕ. Стенд — тот же, что у booked-rows-live.test.mjs (скопирован ниже без изменений):
// быстрая регистрация и registerWalkIn ходят в настоящее приложение (crm-unify-app.js) под
// сессией регистратора, врач №10 «Иванов» (у него свой внутренний источник) заводит строки
// дверью /api/db под своей сессией.
```

После стенда дописать:

```js
const srcOf = (db, doctorId) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(doctorId).id;
const seedDoc = (db) => {
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ',80000,'imaging'), (60,'ЭКГ',50000,'procedure')").run();
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (900, 'Клиника Партнёр')").run();
};
const visitToday = (t, status = 'arrived') => Number(t.db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (77, ?, ?)')
  .run(new Date().toISOString(), status).lastInsertRowid);
async function doctorLine(t, values) {
  const r = await t.dbq('doc', { table: 'visit_services', op: 'insert', values: { quantity: 1, unit_price: 80000, total: 80000, status: 'added', ...values } });
  assert.equal(r.status, 200, r.text);
  return t.db.prepare('SELECT MAX(id) id FROM visit_services').get().id;
}
async function recOf(t, values) {
  const r = await t.dbq('doc', { table: 'recommended_services', op: 'insert',
    values: { patient_id: 77, service_name: 'ЭКГ', recommended_by: 10, status: 'pending', ...values } });
  assert.equal(r.status, 200, r.text);
  return t.db.prepare('SELECT MAX(id) id FROM recommended_services').get().id;
}

test('REFERRAL_LINE_V1 (настоящий сервер): «Код отправителя» стойки ложится и в строку — визит дня уже был без источника', async () => {
  const t = await live(seedDoc);
  try {
    const vid = visitToday(t);
    const out = await registerWalkIn({ patientId: 77, actorRole: 'registrar', createdBy: 2, referralSourceId: 900,
      lines: [{ service: { id: 40, name: 'Анализ крови', price: 40000, requires_doctor: 0 }, doctorId: null }] });
    assert.equal(out.visit.id, vid, 'визит дня не тот');
    assert.equal(t.db.prepare('SELECT referral_source_id s FROM visits WHERE id = ?').get(vid).s, null, 'визиту источник дописан — проверяется не то');
    assert.equal(t.db.prepare('SELECT referred_by_source_id s FROM visit_services WHERE id = ?').get(out.lines[0].visitServiceId).s, 900);
  } finally { t.close(); }
});

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): строка по рекомендации — рекомендация закрыта, направивший — врач, а не «Код отправителя»', async () => {
  const t = await live(seedDoc);
  try {
    const rec = await recOf(t, { service_id: 60, notes: 'к 9:00' });
    const out = await registerWalkIn({ patientId: 77, actorRole: 'registrar', createdBy: 2, referralSourceId: 900,
      lines: [{ service: { id: 60, name: 'ЭКГ', price: 50000, requires_doctor: 0 }, doctorId: null, recommendationId: rec }] });
    assert.ok(!out.attachError, out.attachError);
    const vs = out.lines[0].visitServiceId;
    assert.deepEqual(t.db.prepare('SELECT status, visit_service_id FROM recommended_services WHERE id = ?').get(rec), { status: 'done', visit_service_id: vs });
    assert.deepEqual(t.db.prepare('SELECT referred_by_source_id, referral_note FROM visit_services WHERE id = ?').get(vs),
      { referred_by_source_id: srcOf(t.db, 10), referral_note: 'к 9:00' });
  } finally { t.close(); }
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/doctor-orders-desk-live.test.mjs`
  Ожидается FAIL: первая — `null` вместо `900`; вторая — рекомендация `{ status: 'pending', visit_service_id: null }`.

- [ ] **Step 3: implement** — `public/js/admin/views/walk-in-booking.js`.

JSDoc. Заменить

```js
 * lines: [{ service: {id, price, requires_doctor, name}, doctorId: number|null,
 *           bookedVsId?: number, bookedUnitPrice?: number }]
```

на

```js
 * lines: [{ service: {id, price, requires_doctor, name}, doctorId: number|null,
 *           bookedVsId?: number, bookedUnitPrice?: number, recommendationId?: number }]
 *   DOCTOR_REFERRAL_DESK_V1 — recommendationId: строка по рекомендации врача — после вставки
 *   сервер закрывает рекомендацию и ставит строке направившего (referral_recommendation_attach);
 *   сбой — out.attachError (строка уже в визите, счёт выставляется как обычно).
```

Список. Заменить

```js
    const saved = [];
    const vsIds = [];
```

на

```js
    const saved = [];
    const vsIds = [];
    const recJobs = [];   // DOCTOR_REFERRAL_DESK_V1 — строки по рекомендации врача: { recommendation_id, visit_service_id }
```

Вставка строки. Заменить

```js
        if (isPosInt(createdBy)) row.created_by = Number(createdBy);
```

на

```js
        if (isPosInt(createdBy)) row.created_by = Number(createdBy);
        // REFERRAL_LINE_V1 — «Код отправителя» стойки — и направивший СТРОКИ (сервер примет его
        // от стойки и проверит, что источник включён): визит дня мог быть заведён раньше без
        // него, и тогда направление терялось. Строке по рекомендации врача направившего ставит
        // сервер по самой рекомендации (ниже).
        if (isPosInt(referralSourceId) && !isPosInt(line.recommendationId)) row.referred_by_source_id = Number(referralSourceId);
```

После записи строки. Заменить

```js
        saved.push({ visitServiceId: res.data.id, serviceId: ident.service_id, consultationTypeId: ident.consultation_type_id, doctorId, unitPrice, tier: consult ? null : tier });
```

на

```js
        saved.push({ visitServiceId: res.data.id, serviceId: ident.service_id, consultationTypeId: ident.consultation_type_id, doctorId, unitPrice, tier: consult ? null : tier });
        if (isPosInt(line.recommendationId)) recJobs.push({ recommendation_id: Number(line.recommendationId), visit_service_id: Number(res.data.id) });   // DOCTOR_REFERRAL_DESK_V1
```

Перед счётом. Заменить

```js
    // 5. Счёт пациенту.
```

на

```js
    // DOCTOR_REFERRAL_DESK_V1 — рекомендации врача, оформленные этой регистрацией: сервер
    // закрывает рекомендацию и ставит строке направившего (доказательство — открытая
    // рекомендация). Сбой — предупреждение: строка уже в визите, счёт выставляется как обычно.
    let attachError = null;
    for (const job of recJobs) {
        const { error } = await supabase.rpc('referral_recommendation_attach', job);
        if (error) attachError = attachError ? attachError + '; ' + msgOf(error) : msgOf(error);
    }

    // 5. Счёт пациенту.
```

Ответ. Заменить

```js
    if (quoteError) out.quoteError = quoteError;
```

на

```js
    if (quoteError) out.quoteError = quoteError;
    if (attachError) out.attachError = attachError;   // DOCTOR_REFERRAL_DESK_V1
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/doctor-orders-desk-live.test.mjs public/js/admin/__tests__/walk-in-booking.test.mjs public/js/admin/__tests__/booked-rows-live.test.mjs`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10b.3: быстрая регистрация — «Код отправителя» и в строку, рекомендация закрывается

registerWalkIn ставит выбранный источник и новым строкам (визит дня мог
быть заведён раньше без него); строка по рекомендации врача — без
источника стойки, после вставки сервер закрывает рекомендацию и ставит
направившего-врача; сбой — attachError.

REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/walk-in-booking.js public/js/admin/__tests__/doctor-orders-desk-live.test.mjs
git commit -F .git/U10_MSG.txt
```

---

### Task U10b.4: быстрая регистрация — группа «Направления врача», готовые строки «от врача», «Добавить»

**Files:**
- Modify: `public/js/admin/views/fast-registration.js`, `public/js/admin/__tests__/doctor-orders-desk-live.test.mjs`, `public/js/admin/i18n-strings.js`

- [ ] **Step 1: failing tests** — дописать в конец `public/js/admin/__tests__/doctor-orders-desk-live.test.mjs`:

```js
async function pickPatientOrders(dlg) {
  dlg.searchInput.value = 'Пациент';
  dlg.searchInput.fireInput();
  for (let i = 0; i < 60 && !walk(dlg.card).some((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')); i++) await tick(50);
  walk(dlg.card).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')).click();
  for (let i = 0; i < 60 && !dlg.state.doctorOrders; i++) await tick(50);
  assert.ok(dlg.state.doctorOrders, 'направления врача не загрузились: ' + JSON.stringify(toasts));
}
const node = (dlg, attr, val) => walk(dlg.card).find((n) => n.attrs && n.attrs[attr] === String(val));

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): сегодняшнее направление без счёта — готовая строка «от врача»; сохранение выставляет её, второй строки нет', async () => {
  const t = await live(seedDoc);
  try {
    const vid = visitToday(t);
    const a = await doctorLine(t, { visit_id: vid, service_id: 50, referral_note: 'натощак' });
    const dlg = openFastRegistrationDialog({});
    await waitCatalog(dlg);
    await pickPatientOrders(dlg);
    const row = dlg.state.rows.find((r) => r.booked && r.booked.vsId === a);
    assert.ok(row && row.booked.doctorOrder, 'направление не встало готовой строкой: ' + JSON.stringify(dlg.state.rows.map((r) => r.booked)));
    assert.ok(/от врача · Иванов/.test(textOf(dlg.table)), 'нет пометки «от врача»: ' + textOf(dlg.table));
    assert.ok(/натощак/.test(textOf(dlg.table)), 'рекомендация врача не видна регистратору');
    await save(dlg);
    assert.deepEqual(t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 50').all(vid).map((r) => r.id), [a], 'вставлена вторая строка');
    assert.ok(t.db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(a).i != null, 'направление не выставлено');
    dlg.close();
  } finally { t.close(); }
});

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): выставленное направление — только чтение «ждёт оплаты в кассе, счёт № …», строкой не встаёт', async () => {
  const t = await live(seedDoc);
  try {
    const vid = visitToday(t);
    const b = await doctorLine(t, { visit_id: vid, service_id: 50 });
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: [b], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const no = inv.json.data.invoice.invoice_number;
    const dlg = openFastRegistrationDialog({});
    await waitCatalog(dlg);
    await pickPatientOrders(dlg);
    assert.ok(!dlg.state.rows.some((r) => r.booked && r.booked.vsId === b), 'выставленное направление встало строкой — выставилось бы второй раз');
    const grp = node(dlg, 'data-doctor-order', b);
    assert.ok(grp, 'выставленного направления нет в группе «Направления врача»');
    assert.ok(textOf(grp).includes('ждёт оплаты в кассе, счёт № ' + no), textOf(grp));
    assert.ok(!/По записи уже в счёте/.test(textOf(dlg.card)), 'направление врача названо записью');
    dlg.close();
  } finally { t.close(); }
});

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): рекомендация врача — «Добавить»; после сохранения рекомендация закрыта, у строки направивший', async () => {
  const t = await live(seedDoc);
  try {
    const rec = await recOf(t, { service_id: 60, notes: 'к 9:00' });
    const dlg = openFastRegistrationDialog({});
    await waitCatalog(dlg);
    await pickPatientOrders(dlg);
    const add = node(dlg, 'data-doctor-rec-add', rec);
    assert.ok(add, 'нет кнопки «Добавить» у рекомендации: ' + textOf(dlg.card));
    add.click();
    assert.ok(dlg.state.rows.some((x) => x.fromRec === rec), 'рекомендация не встала строкой');
    assert.ok(!node(dlg, 'data-doctor-rec', rec), 'добавленная рекомендация осталась в группе');
    const res = await save(dlg);
    const vs = res.lines.find((l) => Number(l.serviceId) === 60).visitServiceId;
    assert.deepEqual(t.db.prepare('SELECT status, visit_service_id FROM recommended_services WHERE id = ?').get(rec), { status: 'done', visit_service_id: vs });
    assert.equal(t.db.prepare('SELECT referred_by_source_id s FROM visit_services WHERE id = ?').get(vs).s, srcOf(t.db, 10));
    dlg.close();
  } finally { t.close(); }
});

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): направление на другой день — в группе с подсказкой, в сегодняшнюю регистрацию не встаёт', async () => {
  const t = await live(seedDoc);
  try {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, ?, 'scheduled')").run(d.toISOString()).lastInsertRowid);
    const c = await doctorLine(t, { visit_id: vid, service_id: 50 });
    const dlg = openFastRegistrationDialog({});
    await waitCatalog(dlg);
    await pickPatientOrders(dlg);
    assert.ok(!dlg.state.rows.some((r) => r.booked && r.booked.vsId === c));
    const grp = node(dlg, 'data-doctor-order', c);
    assert.ok(grp && /оформляется в мастере визита/.test(textOf(grp)), grp ? textOf(grp) : 'нет в группе');
    dlg.close();
  } finally { t.close(); }
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/doctor-orders-desk-live.test.mjs`
  Ожидается FAIL: «направления врача не загрузились» (`dlg.state.doctorOrders` нет).

- [ ] **Step 3: implement** — `public/js/admin/views/fast-registration.js`.

Импорт. Заменить

```js
import { loadTodayBooking, bookedStatusLabel, isBookedTwin } from './booked-rows.js';   // CRM_LINK_ALL_V1 (R7a) — строки «из записи»
```

на

```js
import { loadTodayBooking, bookedStatusLabel, isBookedTwin } from './booked-rows.js';   // CRM_LINK_ALL_V1 (R7a) — строки «из записи»
import { loadDoctorOrders, orderKind, orderStateText, bonusText, orderVsIds } from '../doctor-orders.js';   // DOCTOR_REFERRAL_DESK_V1 — «Направления врача»
```

Состояние. Заменить

```js
        dropBooked: [],
        addLine, applyTemplate, removeLine,
```

на

```js
        dropBooked: [],
        doctorOrders: null,   // DOCTOR_REFERRAL_DESK_V1 — направления врача пациента (patient_referral_orders)
        addLine, applyTemplate, removeLine,
```

Группа над таблицей. Заменить

```js
    const discountLine = h('div', {
        class: 'muted',
        style: { display: 'none', padding: '8px 14px 10px', fontSize: '12.5px', textAlign: 'right' },
    });
```

на

```js
    // DOCTOR_REFERRAL_DESK_V1 — группа «Направления врача» над таблицей: выставленные,
    // оплаченные, на другой день и ожидающие рекомендации врача (сегодняшние без счёта —
    // строками таблицы с пометкой «от врача»).
    const doctorOrdersEl = h('div', {
        'data-doctor-orders': '',
        style: { display: 'none', margin: '8px 14px', padding: '9px 12px', background: 'var(--info-50, #eef4ff)', border: '1px solid var(--info-200, #c7dcfd)', borderRadius: '10px' },
    });
    const discountLine = h('div', {
        class: 'muted',
        style: { display: 'none', padding: '8px 14px 10px', fontSize: '12.5px', textAlign: 'right' },
    });
```

и заменить

```js
        table, bookedNote, discountLine);
```

на

```js
        doctorOrdersEl, table, bookedNote, discountLine);   // DOCTOR_REFERRAL_DESK_V1 — группа над таблицей
```

Подпись строки в таблице. Заменить

```js
                    // CRM_LINK_ALL_V1 (R7a) — строка уже в визите записи: подпись и статус записи.
                    row.booked ? h('div', { 'data-booked-row': String(row.booked.vsId), class: 'muted', style: { fontWeight: '400', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' } },
                        Icon('Calendar', { size: 12 }), tr('из записи') + ' · ' + tr(bookedStatusLabel(row.booked.status))) : null,
```

на

```js
                    // DOCTOR_REFERRAL_DESK_V1 — строка направления врача: «от врача · ФИО», кому бонус, рекомендация врача.
                    row.booked && row.booked.doctorOrder ? h('div', { 'data-doctor-order-row': String(row.booked.vsId), class: 'muted', style: { fontWeight: '400', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' } },
                        Icon('Stethoscope', { size: 12 }), orderMeta([
                            trf('от врача · {name}', { name: row.booked.referrerName || '—' }),
                            bonusText(row.booked.bonus) ? trf(bonusText(row.booked.bonus).template, bonusText(row.booked.bonus).params) : null,
                            row.booked.note || null])) : null,
                    // DOCTOR_REFERRAL_DESK_V1 — строка, добавленная из рекомендации врача.
                    row.fromRec ? h('div', { 'data-rec-row': String(row.fromRec), class: 'muted', style: { fontWeight: '400', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '4px' } },
                        Icon('Flag', { size: 12 }), tr('рекомендация врача')) : null,
                    // CRM_LINK_ALL_V1 (R7a) — строка уже в визите записи: подпись и статус записи.
                    row.booked && !row.booked.doctorOrder ? h('div', { 'data-booked-row': String(row.booked.vsId), class: 'muted', style: { fontWeight: '400', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' } },
                        Icon('Calendar', { size: 12 }), tr('из записи') + ' · ' + tr(bookedStatusLabel(row.booked.status))) : null,
```

Убрать строку. Заменить

```js
        const gone = state.rows[i];
        if (gone && gone.booked) state.dropBooked.push(gone.booked.vsId);
        state.rows.splice(i, 1);
        paintTable();
    }
```

на

```js
        // DOCTOR_REFERRAL_DESK_V1 — строка направления врача остаётся в визите: её назначил
        // врач, она возвращается в группу «Направления врача».
        const gone = state.rows[i];
        if (gone && gone.booked && !gone.booked.doctorOrder) state.dropBooked.push(gone.booked.vsId);
        state.rows.splice(i, 1);
        paintTable();
        paintDoctorOrders();
    }
```

Смена пациента. Заменить

```js
    function clearBookedRows() {
        state.rows = state.rows.filter((r) => !r.booked);
        state.dropBooked = [];
        state.bookedVisitId = null;
        bookedNote.textContent = '';
        bookedNote.style.display = 'none';
        paintTable();
    }
```

на

```js
    function clearBookedRows() {
        state.rows = state.rows.filter((r) => !r.booked && !r.fromRec);   // DOCTOR_REFERRAL_DESK_V1 — и строки из рекомендаций прежнего пациента
        state.dropBooked = [];
        state.bookedVisitId = null;
        state.doctorOrders = null;   // DOCTOR_REFERRAL_DESK_V1
        bookedNote.textContent = '';
        bookedNote.style.display = 'none';
        paintTable();
        paintDoctorOrders();   // DOCTOR_REFERRAL_DESK_V1
    }
```

`showBookedRows` — направления врача «из записи» не берутся. Заменить

```js
        state.bookedVisitId = b.visit.id;
        const unpacked = [];   // CRM_LINK_ALL_V1 (ревью денег S3) — пакет снят со строки, ставшей строкой записи
        for (const r of b.rows) {
            if (r.billed) continue;
```

на

```js
        state.bookedVisitId = b.visit.id;
        const unpacked = [];   // CRM_LINK_ALL_V1 (ревью денег S3) — пакет снят со строки, ставшей строкой записи
        const skip = orderVsIds(state.doctorOrders);   // DOCTOR_REFERRAL_DESK_V1 — направления врача — своей группой
        for (const r of b.rows) {
            if (skip.has(Number(r.vsId))) continue;
            if (r.billed) continue;
```

и заменить

```js
        const billed = b.rows.filter((r) => r.billed).map((r) => r.name).filter(Boolean);
```

на

```js
        const billed = b.rows.filter((r) => r.billed && !skip.has(Number(r.vsId))).map((r) => r.name).filter(Boolean);   // DOCTOR_REFERRAL_DESK_V1
```

Новые функции — вставить ПЕРЕД строкой `    async function usePatient(p, { load = false } = {}) {`:

```js
    /** DOCTOR_REFERRAL_DESK_V1 — подпись строки направления: части через « · ». */
    function orderMeta(parts) {
        return parts.filter(Boolean).join(' · ');
    }

    // DOCTOR_REFERRAL_DESK_V1 — НАПРАВЛЕНИЯ ВРАЧА ПАЦИЕНТА (patient_referral_orders: своё
    // здание, сегодня и вперёд). Сегодняшние без счёта — готовые строки таблицы тем же
    // путём, что строки «из записи» (R7a): второй строки нет, счёт — на них. Остальное —
    // группой над таблицей: выставленные «ждёт оплаты в кассе», оплаченные, на другой день
    // (быстрая регистрация пишет только сегодняшний визит — их оформляет мастер визита),
    // рекомендации — «Добавить».
    async function showDoctorOrders(patientId) {
        let o;
        try { o = await loadDoctorOrders(patientId); }
        catch (e) {
            toast(trf('Направления врача не загрузились: {msg}', { msg: (e && e.message) || e }), 'warn');
            return;
        }
        if (!state.patient || state.patient.id !== patientId) return;
        state.doctorOrders = o;
        let otherVisit = false;
        for (const l of o.lines) {
            if (orderKind(l, o.today) !== 'ready') continue;
            const consult = l.service_id == null && l.consultation_type_id != null;
            if (l.service_id == null && !consult) continue;
            if (state.bookedVisitId && Number(state.bookedVisitId) !== Number(l.visit_id)) { otherVisit = true; continue; }
            const service = consult
                ? { id: 'c|' + (l.doctor_id || '') + '|' + l.consultation_type_id, __consult: true, consultation_type_id: l.consultation_type_id,
                    __consultDoctorId: l.doctor_id, name: l.name, price: l.unit_price, requires_doctor: 1 }
                : ((state.catalog || []).find((s) => Number(s.id) === Number(l.service_id))
                    || { id: Number(l.service_id), name: l.name, price: Number(l.unit_price) || 0, requires_doctor: l.doctor_id ? 1 : 0, tax_rate: 0 });
            const bk = rowKey(service, l.doctor_id);
            const twin = state.rows.find((x) => !x.booked && isBookedTwin(rowKey(x.service, x.doctorId), bk));
            const row = twin || pushRow(service, l.doctor_id ? { id: l.doctor_id } : null);
            if (twin && l.doctor_id && Number(twin.doctorId) !== Number(l.doctor_id)) { twin.doctorId = Number(l.doctor_id); twin.doctor = null; }
            if (twin && twin.package) delete twin.package;   // строку не вставляют второй раз — пакета ей не дать
            row.booked = { vsId: Number(l.visit_service_id), status: l.visit_status, unitPrice: Number(l.unit_price) || 0,
                doctorOrder: true, referrerName: l.referrer_name || '', note: l.referral_note || '', bonus: l.bonus_to || [] };
            state.bookedVisitId = Number(l.visit_id);
        }
        if (otherVisit) toast(tr('Направления врача из другого визита — оформите их в окне визита.'), 'warn');
        paintTable();
        paintDoctorOrders();
    }

    function paintDoctorOrders() {
        clear(doctorOrdersEl);
        const o = state.doctorOrders;
        const inTable = new Set(state.rows.filter((r) => r.booked).map((r) => Number(r.booked.vsId)));
        const added = new Set(state.rows.filter((r) => r.fromRec).map((r) => Number(r.fromRec)));
        const lines = o ? o.lines.filter((l) => !inTable.has(Number(l.visit_service_id))) : [];
        const recs = o ? o.recommendations.filter((r) => !added.has(Number(r.recommendation_id))) : [];
        doctorOrdersEl.style.display = lines.length || recs.length ? '' : 'none';
        if (!lines.length && !recs.length) return;
        const rowCss = { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '6px 0', borderTop: '1px solid var(--info-100, #dbeafe)' };
        doctorOrdersEl.appendChild(h('div', { class: 'cell-strong', style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', marginBottom: '4px' } },
            Icon('Stethoscope', { size: 14 }), tr('Направления врача')));
        for (const l of lines) {
            const st = orderStateText(l, o.today);
            const bonus = bonusText(l.bonus_to);
            doctorOrdersEl.appendChild(h('div', { 'data-doctor-order': String(l.visit_service_id), style: rowCss },
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '13.5px' } }, l.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, orderMeta([
                        trf('от врача · {name}', { name: l.referrer_name || '—' }), trf(st.template, st.params),
                        bonus ? trf(bonus.template, bonus.params) : null])),
                    l.referral_note ? h('div', { class: 'muted', style: { fontSize: '12.5px', fontStyle: 'italic' } }, l.referral_note) : null),
                orderKind(l, o.today) === 'future'
                    ? h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, tr('оформляется в мастере визита'))
                    : null));
        }
        for (const r of recs) {
            const bonus = bonusText(r.bonus_to);
            doctorOrdersEl.appendChild(h('div', { 'data-doctor-rec': String(r.recommendation_id), style: rowCss },
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '13.5px' } }, r.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, orderMeta([
                        trf('от врача · {name}', { name: r.referrer_name || '—' }), tr('рекомендация врача'),
                        bonus ? trf(bonus.template, bonus.params) : null])),
                    r.notes ? h('div', { class: 'muted', style: { fontSize: '12.5px', fontStyle: 'italic' } }, r.notes) : null),
                r.service_id != null && !locked()
                    ? h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-doctor-rec-add': String(r.recommendation_id),
                        onclick: () => addRecRow(r) }, Icon('Plus', { size: 12 }), ' ', tr('Добавить'))
                    : null));
        }
    }

    /** DOCTOR_REFERRAL_DESK_V1 — «Добавить» рекомендацию: строка таблицы, помнящая рекомендацию. */
    function addRecRow(r) {
        if (locked()) return;
        const service = (state.catalog || []).find((s) => Number(s.id) === Number(r.service_id));
        if (!service) { toast(tr('Услуги рекомендации нет в каталоге — добавьте её вручную.'), 'warn'); return; }
        const row = addLine(service, null);
        if (row && !row.booked) row.fromRec = Number(r.recommendation_id);
        paintTable();
        paintDoctorOrders();
    }

```

Выбор пациента. Заменить

```js
        await showBookedRows(chosen.id);   // CRM_LINK_ALL_V1 (R7a)
```

на

```js
        // DOCTOR_REFERRAL_DESK_V1 — сначала направления врача: их строки «из записи» не берёт.
        // У карты, заведённой здесь же, направлений нет — сервер не спрашиваем.
        if (!patientCreatedHere) await showDoctorOrders(chosen.id);
        await showBookedRows(chosen.id);   // CRM_LINK_ALL_V1 (R7a)
```

Строки в `registerWalkIn`. Заменить

```js
                    bookedVsId: r.booked ? r.booked.vsId : null, bookedUnitPrice: r.booked ? r.booked.unitPrice : null })),
```

на

```js
                    bookedVsId: r.booked ? r.booked.vsId : null, bookedUnitPrice: r.booked ? r.booked.unitPrice : null,
                    recommendationId: r.fromRec || null })),   // DOCTOR_REFERRAL_DESK_V1 — строка по рекомендации врача
```

Ответ. Заменить

```js
        if (res.queueError) toast(trf('Номера очереди не выданы: {msg}', { msg: res.queueError }), 'warn');
```

на

```js
        if (res.queueError) toast(trf('Номера очереди не выданы: {msg}', { msg: res.queueError }), 'warn');
        if (res.attachError) toast(trf('Рекомендация врача не закрыта: {msg}', { msg: res.attachError }), 'warn');   // DOCTOR_REFERRAL_DESK_V1
```

Возврат окна. Заменить

```js
        table, saveBtn, printBtn, addServicesBtn, addPackagesBtn, referralSel, searchInput,
```

на

```js
        table, saveBtn, printBtn, addServicesBtn, addPackagesBtn, referralSel, searchInput,
        doctorOrdersEl,   // DOCTOR_REFERRAL_DESK_V1
```

`public/js/admin/i18n-strings.js` — перед последней строкой `};`:

```js
  // DOCTOR_REFERRAL_DESK_V1 — «Направления врача» в окнах регистрации (fast-registration.js, visit-wizard.js)
  "от врача · {name}": {"en":"from doctor · {name}","ru":"от врача · {name}","uz":"shifokordan · {name}"},   // DOCTOR_REFERRAL_DESK_V1
  "рекомендация врача": {"en":"doctor's recommendation","ru":"рекомендация врача","uz":"shifokor tavsiyasi"},   // DOCTOR_REFERRAL_DESK_V1
  "Направления врача не загрузились: {msg}": {"en":"Doctor referrals did not load: {msg}","ru":"Направления врача не загрузились: {msg}","uz":"Shifokor yo‘llanmalari yuklanmadi: {msg}"},   // DOCTOR_REFERRAL_DESK_V1
  "оформляется в мастере визита": {"en":"registered in the visit wizard","ru":"оформляется в мастере визита","uz":"tashrif ustasida rasmiylashtiriladi"},   // DOCTOR_REFERRAL_DESK_V1
  "Направления врача из другого визита — оформите их в окне визита.": {"en":"Doctor referrals from another visit — register them in the visit window.","ru":"Направления врача из другого визита — оформите их в окне визита.","uz":"Boshqa tashrifdagi shifokor yo‘llanmalari — ularni tashrif oynasida rasmiylashtiring."},   // DOCTOR_REFERRAL_DESK_V1
  "Услуги рекомендации нет в каталоге — добавьте её вручную.": {"en":"The recommended service is not in the catalogue — add it manually.","ru":"Услуги рекомендации нет в каталоге — добавьте её вручную.","uz":"Tavsiya etilgan xizmat katalogda yo‘q — uni qo‘lda qo‘shing."},   // DOCTOR_REFERRAL_DESK_V1
  "Рекомендация врача не закрыта: {msg}": {"en":"The doctor's recommendation was not closed: {msg}","ru":"Рекомендация врача не закрыта: {msg}","uz":"Shifokor tavsiyasi yopilmadi: {msg}"},   // DOCTOR_REFERRAL_DESK_V1
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/doctor-orders-desk-live.test.mjs public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/booked-rows-live.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10b.4: быстрая регистрация — «Направления врача»

Сегодняшние направления без счёта — готовые строки «от врача · ФИО»
(путь строк «из записи», второй строки нет, при удалении из таблицы
строка остаётся в визите); выставленные — «ждёт оплаты в кассе, счёт
№ …», на другой день — «оформляется в мастере визита»; рекомендации —
«Добавить». Кому бонус — имена. «По записи уже в счёте» направлений не
называет.

DOCTOR_REFERRAL_DESK_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/fast-registration.js public/js/admin/__tests__/doctor-orders-desk-live.test.mjs public/js/admin/i18n-strings.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10b.5: мастер визита — группа «Направления врача», строка «от врача», «Рекомендация для регистратуры», направивший строк

**Files:**
- Modify: `public/js/admin/views/visit-wizard.js`, `public/js/admin/i18n-strings.js`
- Create: `public/js/admin/views/doctor-orders-wizard.test.js`

- [ ] **Step 1: failing test** — создать `public/js/admin/views/doctor-orders-wizard.test.js`:

```js
// DOCTOR_REFERRAL_DESK_V1 · REFERRAL_LINE_V1 — мастер визита и окно визита (текстом файлов:
// экраны тянут DOM и supabase — тот же приём, что в doctor-refer-wizard.test.js). Поведение
// двери — на сервере (server/routes/doctor-referral-desk.test.js, referral-line-stamp.test.js),
// окна стойки — на настоящем сервере (__tests__/doctor-orders-desk-live.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wiz = fs.readFileSync(path.join(HERE, 'visit-wizard.js'), 'utf8');
const slice = (src, from, len) => {
  const at = src.indexOf(from);
  assert.ok(at >= 0, 'не найдено: ' + from);
  return src.slice(at, at + len);
};

test('строка мастера несёт направившего стойки и рекомендацию врача; строка из рекомендации — без явного источника', () => {
  const body = slice(wiz, 'if (uid != null) row.created_by = uid;', 900);
  assert.match(body, /const lineSrc = lineReferralSource\(\);/);
  assert.match(body, /if \(lineSrc && !c\.fromRec\) row\.referred_by_source_id = lineSrc;/);
  assert.match(body, /row\.referral_note = /);
});

test('после вставки строки из рекомендации мастер зовёт referral_recommendation_attach', () => {
  assert.match(slice(wiz, 'lineByVsId.set(res.data.id, c);', 700), /referral_recommendation_attach/);
});

test('«Направления врача» — только у стойки и раньше строк «из записи»', () => {
  assert.match(wiz, /if \(!referralMode\) await prefillFromDoctorOrders\(\);[^\n]*\n\s*await prefillFromBooking\(\);/);
  assert.match(slice(wiz, 'async function prefillFromBooking() {', 1500), /wiz\.doctorOrderVsIds && wiz\.doctorOrderVsIds\.has\(Number\(r\.vsId\)\)/);
});

test('убранная из сметы строка направления врача не снимается с визита', () => {
  assert.match(slice(wiz, 'function removeCartLine(c) {', 400), /c\.booked && !c\.booked\.doctorOrder/);
});

test('поле «Рекомендация для регистратуры» — только в мастере направления врача', () => {
  const at = wiz.indexOf("tr('Рекомендация для регистратуры')");
  assert.ok(at > 0, 'поля нет');
  assert.match(wiz.slice(Math.max(0, at - 1500), at), /if \(referralMode\) \{/);
});

test('строки направления врача и рекомендации подписаны в смете', () => {
  assert.match(wiz, /'data-doctor-order-line'/);
  assert.match(wiz, /'data-rec-line'/);
  assert.match(wiz, /'data-doctor-orders'/);
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/views/doctor-orders-wizard.test.js`
  Ожидается FAIL: «/const lineSrc = lineReferralSource\(\);/» не найдено.

- [ ] **Step 3: implement** — `public/js/admin/views/visit-wizard.js`.

Импорт. Заменить

```js
import { loadTodayBooking, bookedStatusLabel, isBookedTwin } from './booked-rows.js';   // CRM_LINK_ALL_V1 (R7a) — строки «из записи»
```

на

```js
import { loadTodayBooking, bookedStatusLabel, isBookedTwin, localSlot } from './booked-rows.js';   // CRM_LINK_ALL_V1 (R7a) — строки «из записи»; localSlot — DOCTOR_REFERRAL_DESK_V1
import { loadDoctorOrders, orderKind, orderStateText, bonusText, orderVsIds } from '../doctor-orders.js';   // DOCTOR_REFERRAL_DESK_V1 — «Направления врача»
```

Стиль пометки. Заменить

```js
const REF_UNCAT = '—  без категории';
```

на

```js
const REF_UNCAT = '—  без категории';
// DOCTOR_REFERRAL_DESK_V1 — пометки строк сметы «от врача» и «рекомендация врача» — той же
// формы, что «из записи».
const ORDER_CHIP_CSS = { flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12.5px', fontWeight: 700,
    color: 'var(--info-700, #1d4ed8)', background: 'var(--info-50, #eef4ff)', borderRadius: '999px', padding: '1px 7px', whiteSpace: 'nowrap' };
```

Режим направления. Заменить

```js
    const canSavePatientPayer = hasActorRole(PATIENT_PAYER_ROLES);
```

на

```js
    const canSavePatientPayer = hasActorRole(PATIENT_PAYER_ROLES);
    // DOCTOR_REFERRAL_DESK_V1 — мастер открыт из кабинета («Направить на услуги»): направляет врач.
    const referralMode = opts.referrerDoctorId != null && opts.referrerDoctorId !== '';
```

Поля мастера. Заменить

```js
        dropBooked: [],      // CRM_LINK_ALL_V1 (R7a) — visit_service_id строк «из записи», которые убрали
```

на

```js
        dropBooked: [],      // CRM_LINK_ALL_V1 (R7a) — visit_service_id строк «из записи», которые убрали
        doctorOrders: null,       // DOCTOR_REFERRAL_DESK_V1 — «Направления врача» пациента (patient_referral_orders)
        doctorOrderVsIds: null,   // DOCTOR_REFERRAL_DESK_V1 — их строки «из записи» второй раз не подставляются
        referralNote: '',         // DOCTOR_REFERRAL_DESK_V1 — «Рекомендация для регистратуры» (мастер направления врача)
```

Порядок подстановки. Заменить

```js
    await prefillFromBooking();   // CRM_LINK_ALL_V1 (R7a) — сначала то, что уже в визите записи
```

на

```js
    if (!referralMode) await prefillFromDoctorOrders();   // DOCTOR_REFERRAL_DESK_V1 — сначала направления врача: их строки «из записи» не подставляются
    await prefillFromBooking();   // CRM_LINK_ALL_V1 (R7a) — сначала то, что уже в визите записи
```

`prefillFromBooking` — пропуск. Заменить

```js
        for (const r of b.rows) {
            if (r.billed || r.serviceId == null) continue;
```

на

```js
        for (const r of b.rows) {
            if (wiz.doctorOrderVsIds && wiz.doctorOrderVsIds.has(Number(r.vsId))) continue;   // DOCTOR_REFERRAL_DESK_V1 — это направление врача
            if (r.billed || r.serviceId == null) continue;
```

`removeCartLine` и новые функции. Заменить

```js
    function removeCartLine(c) {
        if (c && c.booked) wiz.dropBooked.push(c.booked.vsId);
        wiz.cart = wiz.cart.filter(x => x !== c);
    }
```

на

```js
    function removeCartLine(c) {
        // DOCTOR_REFERRAL_DESK_V1 — строка направления врача остаётся в визите: регистратор её
        // сейчас не оформил, но врач её назначил — она вернётся в группу «Направления врача».
        if (c && c.booked && !c.booked.doctorOrder) wiz.dropBooked.push(c.booked.vsId);
        wiz.cart = wiz.cart.filter(x => x !== c);
    }

    // REFERRAL_LINE_V1 — направивший НОВЫХ строк этой записи: «Кто направил» шага
    // «Направление», а в мастере направления из кабинета — внутренний источник направляющего
    // врача. Сервер берёт его только у стойки (врачу ставит его источник сам) и проверяет, что
    // источник включён (domain/line-referral.js).
    function lineReferralSource() {
        if (wiz.hasReferral && wiz.sourceId) return Number(wiz.sourceId);
        if (!referralMode) return null;
        const s = (wiz.sources || []).find(x => x && x.doctor_id != null && String(x.doctor_id) === String(opts.referrerDoctorId));
        return s ? Number(s.id) : null;
    }

    // DOCTOR_REFERRAL_DESK_V1 — НАПРАВЛЕНИЯ ВРАЧА У СТОЙКИ (patient_referral_orders: своё
    // здание, сегодня и вперёд). Сегодняшние без счёта встают в смету сами — строками «от
    // врача» тем же путём, что строки «из записи» (R7a): второй строки нет, счёт — на них.
    // Остальное — группой над сметой (doctorOrdersRail). В мастере направления из кабинета
    // группы нет: врач направляет, а не оформляет чужие направления.
    async function prefillFromDoctorOrders() {
        if (!patient.id) return;
        let o;
        try { o = await loadDoctorOrders(patient.id); }
        catch (e) {
            toast(trf('Направления врача не загрузились: {msg}', { msg: (e && e.message) || e }), 'warn');
            return;
        }
        wiz.doctorOrders = o;
        wiz.doctorOrderVsIds = orderVsIds(o);
        const names = [];
        for (const l of o.lines) {
            if (orderKind(l, o.today) !== 'ready' || l.service_id == null) continue;
            if (addOrderLine(l)) names.push(l.name);
        }
        if (names.length) {
            refreshTiers();
            toast(trf('Из направлений врача: {names}', { names: names.join(', ') }), 'ok');
        }
        paint();
    }

    /** DOCTOR_REFERRAL_DESK_V1 — строка направления врача → строка сметы со своим днём, врачом и временем. */
    function addOrderLine(l) {
        const svc = wiz.services.find(sv => Number(sv.id) === Number(l.service_id));
        if (!svc) { toast(tr('Услуги направления нет в каталоге — оформите её в окне визита.'), 'warn'); return false; }
        const inCart = wiz.cart.find(c => String(c.svc.id) === String(svc.id));
        if (inCart && inCart.booked) return false;
        if (inCart && inCart.doctorId && l.doctor_id && Number(inCart.doctorId) !== Number(l.doctor_id)) return false;   // другой врач — другая строка
        const d0 = new Date(String(l.day) + 'T00:00'); d0.setHours(0, 0, 0, 0);
        const line = inCart || { svc, qty: 1, doctorId: null, when: null, ui: { day: d0.getTime(), pickDoc: false } };
        line.booked = { vsId: Number(l.visit_service_id), visitId: Number(l.visit_id), status: l.visit_status, when: null,
            doctorOrder: true, referrerName: l.referrer_name || '', note: l.referral_note || '' };
        line.qty = Number(l.quantity) || 1;
        if (l.doctor_id != null) line.doctorId = Number(l.doctor_id);
        line.ui = { ...(line.ui || {}), day: d0.getTime() };
        if (!svc.requires_doctor) { line.dateOnly = true; line.when = String(l.day) + 'T00:00'; }
        else line.when = l.scheduled_at ? localSlot(l.scheduled_at) : String(l.day) + 'T00:00';
        line.booked.when = line.when;   // bookedKeepsSlot: время строки уже её — слот заново не занимается
        if (!inCart) wiz.cart.push(line);
        return true;
    }

    /** DOCTOR_REFERRAL_DESK_V1 — «Добавить» рекомендацию врача: услуга в смету, помнящая рекомендацию. */
    function addRecToCart(r) {
        const svc = wiz.services.find(sv => Number(sv.id) === Number(r.service_id));
        if (!svc) { toast(tr('Услуги рекомендации нет в каталоге — добавьте её вручную.'), 'warn'); return; }
        if (wiz.cart.some(c => String(c.svc.id) === String(svc.id))) {
            toast(trf('«{name}» уже в смете — эту услугу можно добавить только один раз за визит.', { name: svc.name }), 'info');
            return;
        }
        addToCart(svc);
        const line = wiz.cart.find(c => c.svc.id === svc.id);
        if (line) line.fromRec = { id: Number(r.recommendation_id), referrerId: r.referrer_id ?? null };
        repaintRail();
        if (wiz.step === 1) paint();
    }
```

Группа над сметой. Заменить

```js
    function repaintRail() {
        if (!railEl) return;
```

на

```js
    // DOCTOR_REFERRAL_DESK_V1 — группа «Направления врача» над сметой: выставленные (ждут кассу)
    // и оплаченные — только чтение; без счёта — «Добавить» (строка встаёт в смету со своим
    // днём и врачом, второй строки не будет); ожидающие рекомендации — «Добавить».
    // Сегодняшние без счёта уже в смете (пометка «от врача»), здесь их нет.
    function doctorOrdersRail() {
        const o = wiz.doctorOrders;
        if (!o || wiz.creating) return null;
        const inCartVs = new Set(wiz.cart.filter(c => c.booked).map(c => Number(c.booked.vsId)));
        const inCartRec = new Set(wiz.cart.filter(c => c.fromRec).map(c => Number(c.fromRec.id)));
        const lines = (o.lines || []).filter(l => !inCartVs.has(Number(l.visit_service_id)));
        const recs = (o.recommendations || []).filter(r => !inCartRec.has(Number(r.recommendation_id)));
        if (!lines.length && !recs.length) return null;
        const box = h('div', { 'data-doctor-orders': '', style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '9px 10px', background: 'var(--info-50, #eef4ff)', border: '1px solid var(--info-200, #c7dcfd)', borderRadius: '10px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 700, color: 'var(--info-700, #1d4ed8)' } },
                Icon('Stethoscope', { size: 13 }), tr('Направления врача')));
        const sub = (parts) => h('div', { class: 'muted', style: { fontSize: '12.5px' } }, parts.filter(Boolean).join(' · '));
        const rowCss = { display: 'flex', alignItems: 'flex-start', gap: '8px' };
        for (const l of lines) {
            const st = orderStateText(l, o.today);
            const bonus = bonusText(l.bonus_to);
            const kind = orderKind(l, o.today);
            const canAdd = (kind === 'future' || kind === 'ready') && l.service_id != null;
            box.appendChild(h('div', { 'data-doctor-order': String(l.visit_service_id), style: rowCss },
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                    h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, l.name || '—'),
                    sub([trf('от врача · {name}', { name: l.referrer_name || '—' }), trf(st.template, st.params), bonus ? trf(bonus.template, bonus.params) : null]),
                    l.referral_note ? h('div', { class: 'muted', style: { fontSize: '12.5px', fontStyle: 'italic' } }, l.referral_note) : null),
                canAdd ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-doctor-order-add': String(l.visit_service_id),
                    onclick: () => { if (addOrderLine(l)) { refreshTiers(); repaintRail(); if (wiz.step === 1) paint(); } } },
                    Icon('Plus', { size: 12 }), ' ', tr('Добавить')) : null));
        }
        for (const r of recs) {
            const bonus = bonusText(r.bonus_to);
            box.appendChild(h('div', { 'data-doctor-rec': String(r.recommendation_id), style: rowCss },
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                    h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, r.name || '—'),
                    sub([trf('от врача · {name}', { name: r.referrer_name || '—' }), tr('рекомендация врача'), bonus ? trf(bonus.template, bonus.params) : null]),
                    r.notes ? h('div', { class: 'muted', style: { fontSize: '12.5px', fontStyle: 'italic' } }, r.notes) : null),
                r.service_id != null ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-doctor-rec-add': String(r.recommendation_id),
                    onclick: () => addRecToCart(r) }, Icon('Plus', { size: 12 }), ' ', tr('Добавить')) : null));
        }
        return box;
    }

    function repaintRail() {
        if (!railEl) return;
```

В `repaintRail` перед сметой. Заменить

```js
        const shownCart = visibleCart();
```

на

```js
        const ordersBox = doctorOrdersRail();   // DOCTOR_REFERRAL_DESK_V1
        if (ordersBox) railEl.appendChild(ordersBox);
        const shownCart = visibleCart();
```

Пометки строк сметы. Заменить начало выражения

```js
                    c.booked ? h('span', { 'data-booked-line': String(c.booked.vsId),
```

на

```js
                    // DOCTOR_REFERRAL_DESK_V1 — строка из рекомендации врача и строка направления врача.
                    c.fromRec ? h('span', { 'data-rec-line': String(c.fromRec.id), style: ORDER_CHIP_CSS },
                        Icon('Flag', { size: 12 }), tr('рекомендация врача')) : null,
                    c.booked && c.booked.doctorOrder ? h('span', { 'data-doctor-order-line': String(c.booked.vsId), title: c.booked.note || null, style: ORDER_CHIP_CSS },
                        Icon('Stethoscope', { size: 12 }), trf('от врача · {name}', { name: c.booked.referrerName || '—' })) : null,
                    c.booked && !c.booked.doctorOrder ? h('span', { 'data-booked-line': String(c.booked.vsId),
```

(остаток прежнего выражения — `style: {…} }, Icon('Calendar', …), tr('из записи') + …) : null,` — без изменений.)

Поле рекомендации. Заменить

```js
        railEl.appendChild(footer);
```

на

```js
        // DOCTOR_REFERRAL_DESK_V1 — «Рекомендация для регистратуры»: что врач передаёт стойке
        // (натощак, к какому часу, что принести). Ложится в каждую новую строку направления
        // (visit_services.referral_note) и видна регистратору в группе «Направления врача».
        if (referralMode) {
            const note = h('textarea', {
                rows: '2', maxlength: '500', 'data-referral-note': '',
                placeholder: 'Например: натощак, к 9:00',
                style: { width: '100%', resize: 'vertical', fontSize: '13.5px', padding: '7px 9px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit' },
            });
            note.value = wiz.referralNote;
            note.addEventListener('input', () => { wiz.referralNote = note.value; });
            railEl.appendChild(h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '10px', fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-600)' } },
                tr('Рекомендация для регистратуры'), note));
        }
        railEl.appendChild(footer);
```

`createVisit`. Заменить

```js
            const booked = [];
```

на

```js
            const booked = [];
            const attachFail = [];   // DOCTOR_REFERRAL_DESK_V1 — рекомендации, которые сервер не закрыл
```

Строка. Заменить

```js
                    if (uid != null) row.created_by = uid;
```

на

```js
                    if (uid != null) row.created_by = uid;
                    // REFERRAL_LINE_V1 — направивший строки (сервер примет его только от стойки и
                    // проверит, что источник включён; врачу ставит его источник сам). Строке из
                    // рекомендации направившего ставит сервер по самой рекомендации — ниже.
                    const lineSrc = lineReferralSource();
                    if (lineSrc && !c.fromRec) row.referred_by_source_id = lineSrc;
                    // DOCTOR_REFERRAL_DESK_V1 — «Рекомендация для регистратуры» мастера направления врача.
                    const refNote = String(wiz.referralNote || '').trim();
                    if (refNote) row.referral_note = refNote.slice(0, 500);
```

После записи строки. Заменить

```js
                    lineByVsId.set(res.data.id, c);
```

на

```js
                    lineByVsId.set(res.data.id, c);
                    // DOCTOR_REFERRAL_DESK_V1 — строка по рекомендации врача: сервер закрывает
                    // рекомендацию и ставит строке направившего (доказательство — сама рекомендация).
                    if (c.fromRec) {
                        const { error: aErr } = await supabase.rpc('referral_recommendation_attach',
                            { recommendation_id: Number(c.fromRec.id), visit_service_id: Number(res.data.id) });
                        if (aErr) attachFail.push(c.svc.name + ': ' + (aErr.message || aErr));
                    }
```

Перед номерами очереди. Заменить

```js
            let queueRows = [];
```

на

```js
            if (attachFail.length) toast(trf('Рекомендация врача не закрыта: {msg}', { msg: attachFail.join('; ') }), 'warn');   // DOCTOR_REFERRAL_DESK_V1
            let queueRows = [];
```

`public/js/admin/i18n-strings.js` — перед последней строкой `};`:

```js
  // DOCTOR_REFERRAL_DESK_V1 — мастер визита (views/visit-wizard.js)
  "Из направлений врача: {names}": {"en":"From doctor referrals: {names}","ru":"Из направлений врача: {names}","uz":"Shifokor yo‘llanmalaridan: {names}"},   // DOCTOR_REFERRAL_DESK_V1
  "Услуги направления нет в каталоге — оформите её в окне визита.": {"en":"The referred service is not in the catalogue — register it in the visit window.","ru":"Услуги направления нет в каталоге — оформите её в окне визита.","uz":"Yo‘llanmadagi xizmat katalogda yo‘q — uni tashrif oynasida rasmiylashtiring."},   // DOCTOR_REFERRAL_DESK_V1
  "Рекомендация для регистратуры": {"en":"Note for the front desk","ru":"Рекомендация для регистратуры","uz":"Registratura uchun tavsiya"},   // DOCTOR_REFERRAL_DESK_V1
  "Например: натощак, к 9:00": {"en":"For example: on an empty stomach, by 9:00","ru":"Например: натощак, к 9:00","uz":"Masalan: och qoringa, soat 9:00 gacha"},   // DOCTOR_REFERRAL_DESK_V1
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/views/doctor-orders-wizard.test.js public/js/admin/views/doctor-refer-wizard.test.js public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/wizard-desk.test.mjs public/js/admin/__tests__/wizard-templates.test.mjs public/js/admin/__tests__/booking-doors.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
  Ожидается PASS. Если стенд какого-то теста мастера отвечает на незнакомый RPC ошибкой и новое предупреждение «Направления врача не загрузились» роняет проверку «без предупреждений» — дописать в его фальшивый fetch ответ `patient_referral_orders` → `{ data: { lines: [], recommendations: [], today: null } }` (это стенд, не поведение).

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10b.5: мастер визита — «Направления врача», «от врача», рекомендация для регистратуры

У стойки: сегодняшние направления без счёта встают в смету строками
«от врача» (второй строки нет, убранная остаётся в визите), остальные —
группой над сметой с «Добавить»; рекомендации — «Добавить», после записи
сервер закрывает рекомендацию. Новые строки несут направившего (явный
источник стойки или источник врача мастера направления) и рекомендацию
для регистратуры — поле только в мастере направления врача.

REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/visit-wizard.js public/js/admin/views/doctor-orders-wizard.test.js public/js/admin/i18n-strings.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10b.6: окно визита — рекомендацию закрывает сервер и ставит направившего строки

**Files:**
- Modify: `public/js/admin/views/visit-modal.js`, `public/js/admin/views/doctor-orders-wizard.test.js`

- [ ] **Step 1: failing test** — дописать в конец `public/js/admin/views/doctor-orders-wizard.test.js`:

```js
const modal = fs.readFileSync(path.join(HERE, 'visit-modal.js'), 'utf8');

test('окно визита: рекомендацию закрывает сервер (referral_recommendation_attach) по номеру вставленной строки', () => {
  const body = slice(modal, 'async function attachRecommendation(', 4500);
  assert.match(body, /from\('visit_services'\)\.insert\(\{[\s\S]*?\}\)\.select\(\)\.single\(\)/);
  assert.match(body, /referral_recommendation_attach/);
  assert.match(body, /visit_set_doctor_referrer[\s\S]*referral_recommendation_attach/, 'направивший визита — до закрытия рекомендации (он требует открытую)');
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/views/doctor-orders-wizard.test.js`
  Ожидается FAIL: `from('visit_services').insert(...).select().single()` не найдено.

- [ ] **Step 3: implement** — `public/js/admin/views/visit-modal.js` (`attachRecommendation`). Заменить

```js
    const price = Number(rec.__service_price || 0);
    const { error: insErr } = await insertVisitServiceRow({
        visit_id:   state.visit.id,
        service_id: rec.service_id,
        doctor_id:  chosenDoctorId || rec.recommended_by || null,
        quantity:   1,
        unit_price: price,
        total:      price,
    });
    if (insErr) { toast(trf('Не удалось добавить: {msg}', { msg: insErr.message }), 'fail'); return; }
```

на

```js
    const price = Number(rec.__service_price || 0);
    // DOCTOR_REFERRAL_DESK_V1 — номер строки нужен серверу, чтобы привязать к ней рекомендацию
    // (referral_recommendation_attach ниже); created_by ставит сервер (реестр, stamps).
    const { data: insRow, error: insErr } = await supabase.from('visit_services').insert({
        visit_id:   state.visit.id,
        service_id: rec.service_id,
        doctor_id:  chosenDoctorId || rec.recommended_by || null,
        quantity:   1,
        unit_price: price,
        total:      price,
    }).select().single();
    if (insErr) { toast(trf('Не удалось добавить: {msg}', { msg: insErr.message }), 'fail'); return; }
```

и заменить

```js
    await activateVisitIfPending(state);

    const { error: upErr } = await supabase.from('recommended_services')
        .update({ status: 'done', closed_at: new Date().toISOString() })
        .eq('id', rec.id);
    if (upErr) console.warn('[recommendation status]', upErr.message);
```

на

```js
    await activateVisitIfPending(state);

    // DOCTOR_REFERRAL_DESK_V1 — рекомендацию закрывает СЕРВЕР: связывает её со строкой
    // (recommended_services.visit_service_id) и ставит строке направившего — включённый
    // внутренний источник рекомендовавшего врача (REFERRAL_LINE_V1), если строка не его.
    // Отказ — прежняя правка статуса, чтобы рекомендация не осталась «ожидающей» и её не
    // добавили второй раз.
    const { error: attErr } = await supabase.rpc('referral_recommendation_attach',
        { recommendation_id: rec.id, visit_service_id: insRow && insRow.id });
    if (attErr) {
        console.warn('[recommendation attach]', attErr.message || attErr);
        const { error: upErr } = await supabase.from('recommended_services')
            .update({ status: 'done', closed_at: new Date().toISOString() })
            .eq('id', rec.id);
        if (upErr) console.warn('[recommendation status]', upErr.message);
    }
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/views/doctor-orders-wizard.test.js public/js/admin/__tests__/admin-doctor-local.test.mjs`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10b.6: окно визита — рекомендацию закрывает сервер

«Add to visit» вставляет строку с возвратом номера и зовёт
referral_recommendation_attach: рекомендация закрыта этой строкой, у
строки направивший — рекомендовавший врач. Отказ — прежняя правка
статуса.

DOCTOR_REFERRAL_DESK_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/visit-modal.js public/js/admin/views/doctor-orders-wizard.test.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10b.7: календарь — метка «от врача» у записи с направлением врача

**Files:**
- Modify: `public/js/admin/views/room-calendar.js`, `public/js/admin/__tests__/room-calendar.test.mjs`, `public/js/admin/i18n-strings.js`

- [ ] **Step 1: failing tests** — `public/js/admin/__tests__/room-calendar.test.mjs`.

Посев. Заменить

```js
function seed({ doctorOff = false, cross = false, stale = false, nodoc = false, cancelled = false, liveQueue = false, manyDoctors = false, crm = false, lines = false } = {}) {
```

на

```js
function seed({ doctorOff = false, cross = false, stale = false, nodoc = false, cancelled = false, liveQueue = false, manyDoctors = false, crm = false, lines = false, docref = false } = {}) {
```

и сразу после блока `if (crm) { … }` (перед комментарием `// CRM_CALENDAR_MIRROR_V1 — у записи несколько услуг`) вставить:

```js
  // DOCTOR_REFERRAL_DESK_V1 — НАПРАВЛЕНИЕ ВРАЧА: строку визита завёл врач Сидоров (у него
  // свой внутренний источник — триггер мигр. 122) к другому исполнителю.
  if (docref) {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (8,'sid','x','Сидоров Сидор','doctor',1)").run();
    const src = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 8').get().id;
    db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, status, created_by, referred_by_source_id) VALUES (55, 21, 7, 'added', 8, ?)").run(src);
  }
```

Отрисовка. Заменить

```js
async function render({ doctorOff = false, failTable = null, cross = false, stale = false, nodoc = false, cancelled = false, liveQueue = false, manyDoctors = false, workingSet = null, crm = false, lines = false } = {}) {
  const s = seed({ doctorOff, cross, stale, nodoc, cancelled, liveQueue, manyDoctors, crm, lines });
```

на

```js
async function render({ doctorOff = false, failTable = null, cross = false, stale = false, nodoc = false, cancelled = false, liveQueue = false, manyDoctors = false, workingSet = null, crm = false, lines = false, docref = false } = {}) {
  const s = seed({ doctorOff, cross, stale, nodoc, cancelled, liveQueue, manyDoctors, crm, lines, docref });
```

Дописать в конец файла:

```js
// ═══════════════════════════════════════════════════════════════════════════
// DOCTOR_REFERRAL_DESK_V1 (2026-11-02) — «ОТ ВРАЧА»: В ЗАПИСИ УСЛУГА ПО НАПРАВЛЕНИЮ ВРАЧА
// ═══════════════════════════════════════════════════════════════════════════
test('НАПРАВЛЕНИЕ ВРАЧА: запись с услугой, на которую направил врач, помечена «от врача» с его именем', async () => {
  document.body.children.length = 0;
  const { box } = await render({ docref: true });
  const card = byClass(box, 'rcal-appt').find((c) => /10:00–10:30/.test(textOf(c)));
  assert.ok(card, 'запись пропала из сетки');
  const badge = byClass(card, 'rcal-appt-ref')[0];
  assert.ok(badge, 'на блоке нет метки «от врача»: ' + textOf(card));
  assert.ok(/от врача/.test(textOf(badge)));
  assert.match(String(badge.attrs.title || ''), /Сидоров Сидор/);
});

test('обычная запись метки «от врача» не несёт', async () => {
  document.body.children.length = 0;
  const { box } = await render();
  const card = byClass(box, 'rcal-appt').find((c) => /10:00–10:30/.test(textOf(c)));
  assert.ok(card, 'запись пропала из сетки');
  assert.equal(byClass(card, 'rcal-appt-ref').length, 0, 'метка «от врача» на записи без направления');
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/room-calendar.test.mjs`
  Ожидается FAIL: «на блоке нет метки «от врача»».

- [ ] **Step 3: implement** — `public/js/admin/views/room-calendar.js`.

Состояние. Заменить

```js
        crmByVisit: {},
    };
```

на

```js
        crmByVisit: {},
        // DOCTOR_REFERRAL_DESK_V1 — в каких записях услуга по направлению врача: id визита -> имя
        // направившего. Одним ответом на всё видимое окно (referral_visit_links).
        refByVisit: {},
    };
```

Загрузка. Заменить

```js
        await loadCrmLinks(visits.map((v) => v.id));
    }
```

на

```js
        await loadCrmLinks(visits.map((v) => v.id));
        await loadReferralLinks(visits.map((v) => v.id));   // DOCTOR_REFERRAL_DESK_V1
    }
```

Функции. Заменить

```js
    /** Номер заявки колл-центра, из которой эта запись (или null). */
    function crmRequestOf(a) {
```

на

```js
    // DOCTOR_REFERRAL_DESK_V1 — «ОТ ВРАЧА»: в визите есть услуга, на которую направил врач
    // (строка со своим направившим или заведённая врачом к другому исполнителю). Тем же
    // порядком, что метка колл-центра: одним RPC на окно, пачками; отказ — не «направлений
    // нет», а строка «Не загрузилось».
    async function loadReferralLinks(visitIds) {
        state.refByVisit = {};
        const ids = [...new Set((visitIds || []).filter(Boolean))];
        if (!ids.length) return;
        for (let i = 0; i < ids.length; i += CRM_LINK_CHUNK) {
            const { data, error } = await supabase.rpc('referral_visit_links', { visit_ids: ids.slice(i, i + CRM_LINK_CHUNK) });
            if (error) { state.failed = [...new Set([...state.failed, tr('направления врача')])]; return; }
            for (const l of (data || [])) {
                if (l.visit_id != null && state.refByVisit[l.visit_id] == null) state.refByVisit[l.visit_id] = l.doctor_name || '';
            }
        }
    }

    /** Имя врача, направившего на услугу этой записи, или null. */
    function referralOf(a) {
        const n = a && a.id != null ? state.refByVisit[a.id] : undefined;
        return n === undefined ? null : n;
    }

    /** Номер заявки колл-центра, из которой эта запись (или null). */
    function crmRequestOf(a) {
```

Метка. Заменить

```js
                        }, 'колл-центр')
                        : null,
```

на

```js
                        }, 'колл-центр')
                        : null,
                    // DOCTOR_REFERRAL_DESK_V1 — в записи услуга по направлению врача; кто — в подсказке.
                    referralOf(a) != null
                        ? h('span', {
                            class: 'rcal-appt-ref', title: trf('Направил: {name}', { name: referralOf(a) || '—' }),
                            style: { marginLeft: '5px', padding: '0 4px', borderRadius: '4px', fontWeight: 700, fontSize: '12.5px', background: 'var(--info-50, #eef4ff)', color: 'var(--info-700, #1d4ed8)' },
                        }, 'от врача')
                        : null,
```

`public/js/admin/i18n-strings.js` — перед последней строкой `};`:

```js
  // DOCTOR_REFERRAL_DESK_V1 — календарь записи (views/room-calendar.js)
  "от врача": {"en":"from doctor","ru":"от врача","uz":"shifokordan"},   // DOCTOR_REFERRAL_DESK_V1
  "Направил: {name}": {"en":"Referred by: {name}","ru":"Направил: {name}","uz":"Yo‘llagan: {name}"},   // DOCTOR_REFERRAL_DESK_V1
  "направления врача": {"en":"doctor referrals","ru":"направления врача","uz":"shifokor yo‘llanmalari"},   // DOCTOR_REFERRAL_DESK_V1
  // /DOCTOR_REFERRAL_DESK_V1
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/room-calendar.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
  Ожидается PASS.

- [ ] **Step 5: commit** — Write `.git/U10_MSG.txt`:

```
U10b.7: календарь — метка «от врача»

Запись, в которой есть услуга по направлению врача, помечена «от
врача», в подсказке — кто направил (referral_visit_links одним вызовом
на окно, как метка колл-центра).

DOCTOR_REFERRAL_DESK_V1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/room-calendar.js public/js/admin/__tests__/room-calendar.test.mjs public/js/admin/i18n-strings.js
git commit -F .git/U10_MSG.txt
```

---

### Task U10b.8: сторожа словаря и прав — полный набор U10

**Files:** — (только прогон; правки — если что-то упало)

- [ ] **Step 1: run** — сторожа:
  `node --experimental-vm-modules --test public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/english-literals-v3120.test.mjs server/i18n-server-messages.test.js server/services/rpc/client-rpc-coverage.test.js server/routes/licence-gate.test.js server/db/schema-registry-conformance.test.js server/services/test-data-wipe-plan.test.js server/services/rpc/patient-merge.test.js`
  Ожидается PASS. Упало — недостающая статья словаря (uz/en без кириллицы, `{дырки}` те же) или забытый маркер; исправить и закоммитить отдельным коммитом `U10b.8: …`.

- [ ] **Step 2: run** — все тесты U10:
  `node --experimental-vm-modules --test server/db/migrations/270.test.js server/services/domain/line-referral.test.js server/db/schema-registry.test.js server/routes/referral-line-stamp.test.js server/services/rpc/refund-swap-rebill.test.js server/services/rpc/reports.referral-line.test.js server/services/rpc/reports.v2.test.js server/services/rpc/referrals.line.test.js server/services/rpc/referrals.test.js server/services/domain/journal-rules.test.js public/js/admin/views/referral-line-texts.test.js server/routes/doctor-referral-desk.test.js public/js/admin/__tests__/doctor-orders.test.mjs public/js/admin/__tests__/doctor-orders-desk-live.test.mjs public/js/admin/views/doctor-orders-wizard.test.js public/js/admin/__tests__/room-calendar.test.mjs`
  Ожидается PASS.

### Task U10b.9: обход всех RPC и соседние наборы денег

- [ ] **Step 1: run** — `node --experimental-vm-modules --test server/services/rpc/index.test.js` (10–15 минут: зовёт каждый обработчик — три новых обязаны отказывать словами, а не ReferenceError).
- [ ] **Step 2: run** — соседние денежные наборы: `node --experimental-vm-modules --test server/services/rpc/reports.v3120-pay.test.js server/services/rpc/reports.v3120-perf.test.js server/services/rpc/reports.pay-basis.test.js server/services/rpc/reports.pay-rules.test.js server/services/rpc/reports.test.js server/services/rpc/billing.referral-bill.test.js server/routes/referral-bill-flow.test.js server/services/rpc/referral-autofill.test.js server/routes/security-v3120.test.js public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/walk-in-booking.test.mjs public/js/admin/__tests__/crm-card.test.mjs`
  Ожидается PASS. По желанию — ещё раз с английской предзагрузкой: `--import "file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs"`.

---

## Риски / что проверить исполнителю

1. **Чужие правки тех же мест.** U5 (PICK_DAY) и U9 (DUP_STOP) меняют `visit-wizard.js` `createVisit`/`addToCart`, U6 (INVOICE_APPEND) — `create_invoice_for_visit`, U8 — `calendar_book`. Якоря U10 — текст; если «было» уже другое, вставить по смыслу. **U9:** клиентская проверка «уже назначено в этом визите» обязана пропускать строки сметы с `c.booked` (строки «от врача» — это существующие строки визита, их не вставляют) — проверить после слияния. **U8:** если `calendar_book` начнёт вставлять строку консультации за ДРУГОГО врача, звать там `lineReferralStamp` (сейчас серверные вставки — касса, колл-центр, зеркало CRM — направившего не ставят, и это верно).
2. **Прошлые строки не дозаполняются.** Строки до мигр. 270 (dev: врач №18, 4 строки) остаются без направившего — бонуса за них не будет. Дозаполнение по `created_by`-врачу — отдельное решение владельца: в закрытых месяцах оно породило бы строки «Корректировка за …».
3. **Визитный направивший REPORTS_V2 не тронут.** `visit_set_doctor_referrer` (окно визита, рекомендация) по-прежнему ставит врача источником ВИЗИТА, если у визита и пациента его нет, — тогда врач получает бонус и за остальные строки этого визита (старое правило, не «по строке»). Двойной оплаты нет (тот же источник — один раз).
4. **Стойка и «Кто направил».** Выбранный регистратором источник теперь ложится и в новые строки: партнёр, выбранный при уже существующем визите с другим источником, получит своё рядом с прежним («обоим»). Это расширение решения владельца на стойку — сказать в заметках к выпуску.
5. **Администраторы-врачи** внутреннего источника не имеют (триггер мигр. 122 — только `role = 'doctor'`): их направления бонуса не дают. Завести им источник — отдельное решение.
6. **Стенды тестов мастера/быстрой регистрации**, отвечающие на незнакомый RPC ошибкой, покажут новое предупреждение «Направления врача не загрузились» — дописать ответ `patient_referral_orders` в стенд (см. U10b.5, Step 4).
7. **Не расширялись:** счётчики «Рефералы» на дашбордах (`dashboard-overview*.js` считают визиты по источнику визита), «Мои направления» кабинета (`consultation.js` — только рекомендации), «Ждут счёта» кассы — пометки «от врача» там нет.
8. **Производительность отчётов:** лишний запрос `lineSourcesOf` идёт, только если в базе есть хоть одна строка с источником (частичный индекс); `EXISTS` по `invoice_items(invoice_id)` и `visit_services(invoice_item_id)` — по индексам.
9. **Удалённая строка по рекомендации** (снята врачом/кассой) оставляет рекомендацию «done» с `visit_service_id = NULL` — как и прежде с правкой статуса; вернуть её в «ожидает» никто не просил.
10. **Словарь** — все блоки в конце `i18n-strings.js`; при слиянии с другими задачами выпуска сохранить все блоки целиком.

## Проверка владельцем (вручную)

1. Врач в кабинете: «Направить на услуги» пациенту, у которого сегодня уже есть его приём, → касса оплатила → «Отчёты → Рефералы»: у врача бонус за эту услугу; если пациента привёл партнёр — бонус и у партнёра.
2. Регистратура: быстрая регистрация этого пациента — группа «Направления врача»; невыставленное стоит строкой «от врача · ФИО» с рекомендацией врача, выставленное — «ждёт оплаты в кассе, счёт № …», рекомендация врача — кнопка «Добавить».
3. Врач в мастере направления пишет «Рекомендация для регистратуры» («натощак») — регистратор видит этот текст под строкой.
4. Календарь: у записи с услугой по направлению врача — метка «от врача», в подсказке — кто направил.
