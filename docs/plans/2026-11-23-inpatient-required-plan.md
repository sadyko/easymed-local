# INPATIENT_REQUIRED_V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clinic-controlled switches for what «Стационар» requires (treating doctor only after the admission exam, admitting doctor at placement, diagnosis in the first exam, discharge summary for a discharge request), documents and title-sheet fields marked required / optional, red marks on empty required fields, and an in-app «Сохранить как есть» dialog.

**Architecture:** One settings row + change log (migration 298) read per request by the server gates and the checklist; one shared rules module (`public/js/shared/inpatient-required.js`, no Russian text) used by server and screens; one UI helper (`views/required-marks.js`) that draws the marks and the force-save dialog on every form; one settings page «Настройки → Стационар». Every default reproduces today's behaviour; a database older than 298 reads the defaults.

**Tech Stack:** Node 24, Express, better-sqlite3 (server, `node:test` `*.test.js`), vanilla-JS ES modules (UI, `node:test` `*.test.mjs` with a fake DOM), SQLite migrations in `server/db/migrations/NNN_*.sql`.

**Spec (the contract):** `docs/specs/2026-11-23-inpatient-required-design.md`. Branch `feat/inpatient-required`. Work in this one working tree, one task at a time, in order.

---

## Rules for every task (read before Task 1)

- **Marker.** Every new or changed block carries the comment marker `INPATIENT_REQUIRED_V1`. Code comments are in Russian, like the surrounding code.
- **Strings.** Every new UI string goes into `public/js/admin/i18n-strings.js` with `ru`, `uz`, `en` (uz and en contain **no Cyrillic**; uz uses the same `o‘`/`g‘` apostrophe style as neighbouring entries) **in the same task that uses it**. Add a block near the top of `STRINGS` headed `// INPATIENT_REQUIRED_V1 — …` and end each line with `   // INPATIENT_REQUIRED_V1`. Before adding a key, check it is not already there: `grep -n '^  "<ключ>":' public/js/admin/i18n-strings.js` — add only missing keys (no duplicates). UI code uses `tr()` / `trf()`; `h()` and `toast()` already run `tr()` on plain text children.
- **Server messages are screen text too.** Every new static `new RpcError('…')` message and every `rpcT(RpcError, '…{x}…', …)` template must be a dictionary key with ru/uz/en — `server/i18n-server-messages.test.js` fails otherwise. Assembled messages use `rpcT` (`server/services/server-message.js`), never `` `…${x}…` ``.
- **Icons** only via `Icon(name)` from `public/js/admin/ui.js`; never emoji.
- **Tests.** Server tests: `node:test` files `*.test.js` next to the code. UI tests: `public/js/admin/__tests__/*.test.mjs` with the fake DOM used in `public/js/admin/__tests__/title-sheet.test.mjs` (lines 10–60: `FakeNode`, `mkEl`, `globalThis.document/window/localStorage`). Run single files: `node --test <file>`. A group: `node --test --test-concurrency=4 <file> <file> …`. **Never run the whole suite inside a task.** Tests that open ports must use `test-helpers/listen.js` (none are planned here).
- **Fake data only.** The repo is public: patients like `'Тестов Пациент'`, staff like `'Сотрудник doc5'`, phones like `'+998900000000'`. Never a real-looking name.
- **Commits.** Russian message, written with `printf` into a file, then `git commit -F`. Message ends with a blank line and the trailer. Stage **named files only**. Never `git add -A` / `git add .`, never `git stash`, `git restore`, `git checkout --`, `git reset --hard`. Template:

```bash
cd "C:/Users/user/Desktop/implementation workflow/easymed.symptex"
printf '%s\n' 'Стационар: <что сделано> (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add <path> <path> …
git commit -F .git/INPATIENT_MSG
```

- **Defaults = today.** With no setting changed, every server answer and every gate behaves exactly as before. The only visible change with defaults is the new marks and the «Заполнено не всё» dialog (spec §5).
- **Module stamps.** Import new modules (`./required-marks.js`, `../../shared/inpatient-required.js`) **without** a `?v=` stamp everywhere (one module instance). Do not bump existing `?v=` stamps unless a test demands it.
- **No import cycles between views** (`public/js/admin/__tests__/no-import-cycles.test.mjs`): `required-marks.js` imports no view.

## Decisions this plan makes (not spelled out in the spec)

1. The per-kind section list moves to `public/js/shared/case-doc-sections.js`; `views/case-doc-a4.js` re-exports `KIND_SECTIONS` and `sectionsFor` — one copy for server and screen.
2. `title_required = 0` means **no** title-sheet field is required anywhere (the field list is kept but ignored); the sheet is then a fully optional document.
3. Screens read the rules with `inpatient_settings_get` (`loadInpatientRules()` in `required-marks.js`); patient lists read the four switches from `inpatient_capabilities().required`. Any failure (old server, no right) falls back to the defaults = today.
4. With the treating-doctor switch OFF, a «Первичный осмотр» or «Осмотр приёмного врача» published while the admission is already `active` moves nothing, but stamps `examined_at/examined_by` with `COALESCE` (somebody did examine; the admission card would otherwise say «ещё не проведён» next to a published exam). Assigning the treating doctor without an exam never stamps them.
5. An optional document reports `periods_missing: 0` and is never `overdue`.
6. `inpatient_settings_save` also takes `docs` (per-document `required` / `required_sections`) so the page saves with one button; `case_doc_type_save` carries the same fields through the same function `applyDocRequired`.
7. A required section of a document is opened in the editor and cannot be removed with the section manager.
8. Settings belong to the building (not shipped by branch sync), like `stock_settings` and `case_doc_types`; a test-data wipe keeps them.
9. With the switch OFF, admitted patients without a treating doctor also count in «Ждут лечащего врача» (they stay in «Ждут первичного осмотра» too — they have not been examined).

## File map

| File | Status | Responsibility |
|---|---|---|
| `server/db/migrations/298_inpatient_required.sql` + `298.test.js` | new | storage |
| `server/services/test-data-wipe-plan.js` | modify | wipe keeps the two new tables |
| `public/js/shared/case-doc-sections.js` + `.test.js` | new | per-kind section list (moved) |
| `public/js/shared/inpatient-required.js` + `.test.js` | new | shared rules, no Russian |
| `public/js/shared/title-sheet-rules.js` + `.test.js` | modify | `sheetCompleteness(row, keys, patient)` |
| `public/js/admin/views/case-doc-a4.js` | modify | re-export sections; `richSection` returns `tag` |
| `server/services/rpc/inpatient-settings.js` + `inpatient-settings.test.js` | new | settings RPCs, loader, log |
| `server/services/rpc/index.js`, `server/services/control/gate.js` | modify | registration, read-only list |
| `server/services/rpc/case-doc-types.js` | modify | `required`, `required_sections` |
| `server/services/rpc/inpatient-flow.js` | modify | route `admitted → active` without exam, `required` flags |
| `server/services/rpc/inpatient-reviews.js` | modify | set attending, exam while active, doc set, checklist |
| `server/services/rpc/inpatient.js` | modify | discharge-epicrisis switch |
| `server/services/rpc/title-sheet.js`, `case-overview.js` | modify | clinic field list |
| `server/services/rpc/inpatient-required-gates.test.js` | new | four switches at the server |
| `server/services/rpc/inpatient-required-checklist.test.js` | new | checklist + title sheet RPCs |
| `public/js/admin/views/required-marks.js` + `public/css/admin-views.css` | new / modify | marks, dialog, rules loader, labels |
| `public/js/admin/views/title-sheet.js` | modify | marks, admitting switch, force-save |
| `public/js/admin/views/admission-modal.js`, `case-workspace.js` | modify | editor marks, force-save, attending modal |
| `public/js/admin/views/admissions.js`, `consultation.js`, `doctor-dashboard.js` | modify | attending from `admitted` |
| `public/js/admin/views/case-docs.js`, `case-overview.js` | modify | «по желанию», missing text |
| `public/js/admin/views/inpatient-settings.js` | new | «Настройки → Стационар» |
| `public/js/admin.js`, `public/js/admin/permissions.js`, `public/js/admin/views/settings-hub.js` | modify | route, rule, tile |
| `public/js/admin/i18n-strings.js` | modify | every new string |

---

### Task 1: Migration 298 and the wipe plan

**Files:**
- Create: `server/db/migrations/298_inpatient_required.sql`
- Create: `server/db/migrations/298.test.js`
- Modify: `server/services/test-data-wipe-plan.js` (block `// ── настройки, подключения …`, after `stock_settings_log: keep('settings'),` ~L310)

Check first: `ls server/db/migrations | tail -4` — the highest number must be `297`. If 298 exists, stop and report.

- [ ] **Step 1: Write the failing migration test** — `server/db/migrations/298.test.js`:

```js
// INPATIENT_REQUIRED_V1 — миграция 298: что в стационаре обязательно (одна строка настроек),
// журнал «кто менял» и обязательность документов истории болезни. Умолчания = поведение до 298.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('298 INPATIENT_REQUIRED_V1: одна строка настроек, умолчания — сегодняшнее поведение', () => {
  const db = openDb(':memory:');
  migrate(db);
  const rows = db.prepare('SELECT * FROM inpatient_settings').all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, {
    id: 1, intake_before_attending: 1, admitting_at_placement: 1, primary_needs_diagnosis: 1,
    discharge_needs_epicrisis: 1, title_required: 1,
    title_required_fields: '["height_cm","weight_kg","temp_c","bp_sys","bp_dia","pulse_bpm","pediculosis","sanitation"]',
    updated_at: null, updated_by: null,
  });
  assert.throws(() => db.prepare('INSERT INTO inpatient_settings (id) VALUES (2)').run(), /CHECK/);
  for (const col of ['intake_before_attending', 'admitting_at_placement', 'primary_needs_diagnosis', 'discharge_needs_epicrisis', 'title_required']) {
    assert.throws(() => db.prepare(`UPDATE inpatient_settings SET ${col} = 2`).run(), /CHECK/, col);
  }
  db.close();
});

test('298: журнал — кто, когда, что; время ставится само', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Сотрудник adm','admin')").run();
  db.prepare("INSERT INTO inpatient_settings_log (user_id, field, old_value, new_value) VALUES (1, 'intake_before_attending', '1', '0')").run();
  const r = db.prepare('SELECT * FROM inpatient_settings_log').get();
  assert.match(r.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual([r.user_id, r.field, r.old_value, r.new_value], [1, 'intake_before_attending', '1', '0']);
  db.close();
});

test('298: каждый документ набора (и уже засеянный 115, и новый) — обязательный, без обязательных разделов', () => {
  const db = openDb(':memory:');
  migrate(db);
  const rows = db.prepare('SELECT kind, required, required_sections FROM case_doc_types').all();
  assert.ok(rows.length >= 10, 'встроенный набор 115 на месте');
  for (const r of rows) {
    assert.equal(r.required, 1, r.kind);
    assert.equal(r.required_sections, '[]', r.kind);
  }
  assert.throws(() => db.prepare("UPDATE case_doc_types SET required = 5 WHERE kind = 'intake'").run(), /CHECK/);
  db.prepare("INSERT INTO case_doc_types (kind, title) VALUES ('own_99', 'Тестовый лист')").run();
  assert.deepEqual({ ...db.prepare("SELECT required, required_sections FROM case_doc_types WHERE kind = 'own_99'").get() },
    { required: 1, required_sections: '[]' });
  db.close();
});
```

- [ ] **Step 2: Run it — expect FAIL** (`no such table: inpatient_settings`):

`node --test server/db/migrations/298.test.js`

- [ ] **Step 3: Write the migration** — `server/db/migrations/298_inpatient_required.sql` (plain `CREATE TABLE`, no `IF NOT EXISTS`, no table rebuilds):

```sql
-- INPATIENT_REQUIRED_V1 (2026-11-23) — ЧТО В СТАЦИОНАРЕ ОБЯЗАТЕЛЬНО, РЕШАЕТ КЛИНИКА.
--
-- Владелец: «in the stationary, we have a roadblocks as a unfilled title list,
-- reception doctor filling, and others, we need to make some settings for that
-- so we can switch the setup of the stationary documents lists as a required,
-- not required fields».
--
-- Одна строка настроек: четыре переключателя «что останавливает работу»,
-- обязателен ли титульный лист и какие его поля. Каждое умолчание — то, как
-- программа работала до этой миграции, строка в строку: клиника, которая
-- ничего не трогала, разницы не заметит.
--
-- Настройка — этого здания (как stock_settings и case_doc_types): своё
-- отделение, свои правила; соседям по сети таблицы не ездят.
-- Только CREATE TABLE и ADD COLUMN — пересборок нет (урок 1.1.0).
CREATE TABLE inpatient_settings (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  -- Лечащий врач — только после осмотра приёмного врача (или первичного осмотра).
  intake_before_attending   INTEGER NOT NULL DEFAULT 1 CHECK (intake_before_attending IN (0, 1)),
  -- Приёмный врач обязателен при размещении на койке (решает экран медсестры).
  admitting_at_placement    INTEGER NOT NULL DEFAULT 1 CHECK (admitting_at_placement IN (0, 1)),
  -- Первичный осмотр публикуется только с диагнозом (решает экран врача).
  primary_needs_diagnosis   INTEGER NOT NULL DEFAULT 1 CHECK (primary_needs_diagnosis IN (0, 1)),
  -- Заявку на выписку принимают только по опубликованному выписному эпикризу.
  discharge_needs_epicrisis INTEGER NOT NULL DEFAULT 1 CHECK (discharge_needs_epicrisis IN (0, 1)),
  -- Титульный лист — обязательный документ истории болезни.
  title_required            INTEGER NOT NULL DEFAULT 1 CHECK (title_required IN (0, 1)),
  -- Обязательные поля листа — JSON-список ключей (shared/inpatient-required.js TITLE_FIELDS).
  title_required_fields     TEXT    NOT NULL DEFAULT '["height_cm","weight_kg","temp_c","bp_sys","bp_dia","pulse_bpm","pediculosis","sanitation"]',
  updated_at                TEXT,
  updated_by                INTEGER REFERENCES users(id)
);
INSERT INTO inpatient_settings (id) VALUES (1);

-- Кто и когда менял. Обязательность документа пишется сюда же:
-- field = 'doc:<род>:required' / 'doc:<род>:sections'.
CREATE TABLE inpatient_settings_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  user_id   INTEGER REFERENCES users(id),
  field     TEXT    NOT NULL,
  old_value TEXT    NOT NULL DEFAULT '',
  new_value TEXT    NOT NULL DEFAULT ''
);

-- Документ набора: обязательный или «по желанию», и какие его разделы обязательны
-- (JSON-список ключей разделов этого документа).
ALTER TABLE case_doc_types ADD COLUMN required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1));
ALTER TABLE case_doc_types ADD COLUMN required_sections TEXT NOT NULL DEFAULT '[]';
```

- [ ] **Step 4: Run the migration test — expect PASS.** `node --test server/db/migrations/298.test.js`

- [ ] **Step 5: Run the wipe guard — expect FAIL** («новая таблица? Решите в server/services/test-data-wipe-plan.js»):

`node --test server/services/test-data-wipe-plan.test.js`

- [ ] **Step 6: Teach the wipe plan** — in `server/services/test-data-wipe-plan.js`, right after `stock_settings_log: keep('settings'),`:

```js
  inpatient_settings: keep('settings'),       // INPATIENT_REQUIRED_V1 — что обязательно в стационаре (мигр. 298)
  inpatient_settings_log: keep('settings'),   // INPATIENT_REQUIRED_V1 — кто менял настройки стационара
```

Staff deletion (`server/routes/users.js` `staffHistoryFkRefs`) finds the two new `REFERENCES users(id)` columns by itself; no edit there.

- [ ] **Step 7: Run the guards — expect PASS:**

`node --test --test-concurrency=4 server/db/migrations/298.test.js server/services/test-data-wipe-plan.test.js server/services/test-data-wipe-files.test.js server/db/migrate.test.js`

- [ ] **Step 8: Commit**

```bash
printf '%s\n' 'Стационар: миграция 298 — настройки «что обязательно», журнал изменений, обязательность документов истории болезни; очистка тестовых данных их сохраняет (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add server/db/migrations/298_inpatient_required.sql server/db/migrations/298.test.js server/services/test-data-wipe-plan.js
git commit -F .git/INPATIENT_MSG
```

---

### Task 2: Shared rules — section list moved, `inpatient-required.js`, `sheetCompleteness`

**Files:**
- Create: `public/js/shared/case-doc-sections.js`, `public/js/shared/case-doc-sections.test.js`
- Create: `public/js/shared/inpatient-required.js`, `public/js/shared/inpatient-required.test.js`
- Modify: `public/js/shared/title-sheet-rules.js` (`sheetCompleteness`, last function), `public/js/shared/title-sheet-rules.test.js`
- Modify: `public/js/admin/views/case-doc-a4.js` (L26–50 `KIND_SECTIONS`, L137–146 `sectionsFor`)

No Russian string literals in the two new shared modules (comments are fine).

- [ ] **Step 1: Write the failing tests.**

`public/js/shared/case-doc-sections.test.js`:

```js
// INPATIENT_REQUIRED_V1 — разделы документов истории болезни: одна копия на сервер и экран.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_SECTIONS, SECTION_KEYS, sectionsFor } from './case-doc-sections.js';

test('разделы: пять ключей; у каждого рода есть диагноз; неизвестный род — полный набор', () => {
  assert.deepEqual(SECTION_KEYS, ['complaints', 'objective', 'diagnosis', 'plan', 'body']);
  assert.deepEqual(sectionsFor('operation'), ['diagnosis', 'body']);
  assert.deepEqual(sectionsFor('round'), ['complaints', 'objective', 'diagnosis', 'plan']);
  assert.deepEqual(sectionsFor('own_7'), ['complaints', 'objective', 'diagnosis', 'plan', 'body']);
  for (const kind of Object.keys(KIND_SECTIONS)) assert.ok(sectionsFor(kind).includes('diagnosis'), kind);
});

test('экран не держит второй копии списка: case-doc-a4.js берёт его отсюда', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'admin', 'views', 'case-doc-a4.js'), 'utf8');
  assert.ok(src.includes("from '../../shared/case-doc-sections.js'"), 'case-doc-a4.js должен импортировать общий список');
  assert.ok(!/export const KIND_SECTIONS\s*=\s*Object\.freeze\(\{/.test(src), 'вторая копия KIND_SECTIONS в case-doc-a4.js');
});
```

`public/js/shared/inpatient-required.test.js`:

```js
// INPATIENT_REQUIRED_V1 — общие правила «что обязательно»: поля листа, разделы, правила экрана.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TITLE_FIELDS, TITLE_GROUPS, TITLE_FIELD_KEYS, DEFAULT_TITLE_REQUIRED, SWITCH_KEYS,
  missingTitleFields, cleanTitleRequired, cleanRequiredSections, parseRequiredSections,
  missingSections, rulesFromSettings, DEFAULT_RULES, requiredSectionsOf, waitsForAttending,
} from './inpatient-required.js';
import { REQUIRED_KEYS } from './title-sheet-rules.js';

test('поля листа: группы, где живут, без ФИО, даты рождения, ИМТ и примечания', () => {
  assert.deepEqual(TITLE_GROUPS, ['patient', 'admission', 'measures', 'exam', 'papers']);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'patient').map((f) => f.key),
    ['gender', 'phone', 'address', 'national_id', 'occupation', 'emergency_contact_name', 'emergency_contact_phone', 'blood_type', 'allergies']);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'admission').map((f) => f.key), ['referred_from', 'delivered_by', 'mobility', 'since_onset']);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'measures').map((f) => f.key), ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm']);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'exam').map((f) => f.key), ['pediculosis', 'sanitation']);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'papers').map((f) => [f.key, f.col]),
    [['contract_signed', 'contract_signed_at'], ['consent_signed', 'consent_signed_at'], ['memo_given', 'memo_given_at']]);
  for (const k of ['full_name', 'date_of_birth', 'bmi', 'note']) assert.ok(!TITLE_FIELD_KEYS.includes(k), k);
  assert.deepEqual(DEFAULT_TITLE_REQUIRED, [...REQUIRED_KEYS], 'умолчание — сегодняшние восемь полей');
  assert.deepEqual(SWITCH_KEYS, ['intake_before_attending', 'admitting_at_placement', 'primary_needs_diagnosis', 'discharge_needs_epicrisis', 'title_required']);
});

test('missingTitleFields: лист, карточка пациента и отметка бумаги; «unknown» группы крови — пусто', () => {
  const keys = ['height_cm', 'phone', 'blood_type', 'consent_signed', 'mobility'];
  assert.deepEqual(missingTitleFields({ sheet: null, patient: null }, keys), ['phone', 'blood_type', 'mobility', 'height_cm', 'consent_signed']);
  const sheet = { height_cm: 172, mobility: 'walks', consent_signed_at: '2026-11-23T08:00:00Z' };
  const patient = { phone: '+998900000000', blood_type: 'unknown' };
  assert.deepEqual(missingTitleFields({ sheet, patient }, keys), ['blood_type']);
  // Форма экрана присылает галочку, а не время — это тоже «отмечено».
  assert.deepEqual(missingTitleFields({ sheet: { consent_signed: true }, patient }, ['consent_signed']), []);
  assert.deepEqual(missingTitleFields({ sheet: { consent_signed: false }, patient }, ['consent_signed']), ['consent_signed']);
  // Пробелы — пусто; ноль — значение.
  assert.deepEqual(missingTitleFields({ sheet: { referred_from: '   ', height_cm: 0 } }, ['referred_from', 'height_cm']), ['referred_from']);
  // Неизвестный ключ не требуется.
  assert.deepEqual(missingTitleFields({ sheet: {} }, ['nonsense']), []);
});

test('cleanTitleRequired: только известные ключи, без повторов, в порядке листа; не список — пусто', () => {
  assert.deepEqual(cleanTitleRequired(['pulse_bpm', 'phone', 'pulse_bpm', 'x']), ['phone', 'pulse_bpm']);
  assert.deepEqual(cleanTitleRequired(null), []);
});

test('разделы: cleanRequiredSections / parseRequiredSections / missingSections', () => {
  assert.deepEqual(cleanRequiredSections(['plan', 'diagnosis', 'plan', 'zzz'], ['complaints', 'diagnosis', 'plan']), ['diagnosis', 'plan']);
  assert.deepEqual(parseRequiredSections('["body","plan"]', 'operation'), ['body'], 'у протокола операции нет плана');
  assert.deepEqual(parseRequiredSections('испорчено', 'primary'), []);
  assert.deepEqual(parseRequiredSections(null, 'primary'), []);
  const fields = { complaints: '<p><br></p>', objective: '<p>ясно</p>', diagnosis: '  ', plan: '<table></table>', body: '' };
  assert.deepEqual(missingSections(fields, ['complaints', 'objective', 'diagnosis', 'plan', 'body']), ['complaints', 'diagnosis', 'plan', 'body']);
  assert.deepEqual(missingSections({ diagnosis: 'J18.9' }, ['diagnosis']), []);
  assert.deepEqual(missingSections(null, ['diagnosis']), ['diagnosis']);
});

test('rulesFromSettings: пустой ответ — сегодняшние правила; ответ сервера — как прислан', () => {
  assert.deepEqual(DEFAULT_RULES, rulesFromSettings(null));
  assert.equal(DEFAULT_RULES.intakeBeforeAttending, true);
  assert.equal(DEFAULT_RULES.admittingAtPlacement, true);
  assert.equal(DEFAULT_RULES.primaryNeedsDiagnosis, true);
  assert.equal(DEFAULT_RULES.dischargeNeedsEpicrisis, true);
  assert.equal(DEFAULT_RULES.titleRequired, true);
  assert.deepEqual(DEFAULT_RULES.titleFields, DEFAULT_TITLE_REQUIRED);
  const r = rulesFromSettings({
    settings: { intake_before_attending: 0, admitting_at_placement: 1, primary_needs_diagnosis: 0, discharge_needs_epicrisis: 1, title_required: 0, title_required_fields: ['phone'] },
    docs: [{ kind: 'primary', required: true, required_sections: ['plan'] }, { kind: 'round', required: false, required_sections: [] }],
  });
  assert.equal(r.intakeBeforeAttending, false);
  assert.equal(r.primaryNeedsDiagnosis, false);
  assert.equal(r.titleRequired, false);
  assert.deepEqual(r.titleFields, ['phone']);
  assert.deepEqual(requiredSectionsOf(r, 'primary'), ['plan']);
  assert.deepEqual(requiredSectionsOf(r, 'intake'), []);
  assert.equal(r.docs.round.required, false);
});

test('waitsForAttending: «осмотрен» ждёт всегда; «на койке» — только без обязательного осмотра', () => {
  assert.equal(waitsForAttending({ status: 'examined' }, false), true);
  assert.equal(waitsForAttending({ status: 'admitted' }, false), false);
  assert.equal(waitsForAttending({ status: 'admitted' }, true), true);
  assert.equal(waitsForAttending({ status: 'active' }, true), false);
  assert.equal(waitsForAttending(null, true), false);
});
```

Add to `public/js/shared/title-sheet-rules.test.js` (keep the existing tests unchanged — they are the compatibility proof):

```js
test('INPATIENT_REQUIRED_V1: sheetCompleteness со списком клиники и карточкой пациента', () => {
  const sheet = { height_cm: 172, consent_signed_at: null };
  assert.deepEqual(sheetCompleteness(sheet, ['height_cm', 'phone', 'consent_signed'], { phone: '+998900000000' }),
    { complete: false, missing: ['consent_signed'] });
  assert.deepEqual(sheetCompleteness(Object.assign({}, sheet, { consent_signed_at: '2026-11-23T08:00:00Z' }), ['height_cm', 'phone', 'consent_signed'], { phone: '+998900000000' }),
    { complete: true, missing: [] });
  assert.deepEqual(sheetCompleteness(null, []), { complete: true, missing: [] }, 'ничего не требуется — пустот нет (наличие листа проверяет вызывающий)');
});
```

- [ ] **Step 2: Run — expect FAIL** (modules missing):

`node --test --test-concurrency=4 public/js/shared/case-doc-sections.test.js public/js/shared/inpatient-required.test.js public/js/shared/title-sheet-rules.test.js`

- [ ] **Step 3: Create `public/js/shared/case-doc-sections.js`.** Move `KIND_SECTIONS` (with its comment block) from `case-doc-a4.js` L28–50 and `sectionsFor` (with its comment block, L118–146) here verbatim, plus:

```js
// INPATIENT_REQUIRED_V1 — РАЗДЕЛЫ ДОКУМЕНТОВ ИСТОРИИ БОЛЕЗНИ, ОДНА КОПИЯ НА СЕРВЕР И ЭКРАН.
// Список жил в views/case-doc-a4.js — экранном файле, который сервер импортировать не
// может (он тянет ui.js). Обязательные разделы документа проверяют обе стороны, и две
// копии списка разошлись бы на первой правке. Русского текста здесь нет: подписи
// разделов — у экрана (case-doc-a4.js LABEL) и у сервера (patient-doc-sources.js).

/** Разделы, у которых есть своя колонка в admission_reviews. */
export const SECTION_KEYS = Object.freeze(['complaints', 'objective', 'diagnosis', 'plan', 'body']);
const DEFAULT_SECTIONS = Object.freeze(['complaints', 'objective', 'diagnosis', 'plan', 'body']);
// … KIND_SECTIONS (как было) …
// … sectionsFor(kind) (как было; `KIND_SECTIONS[kind] || DEFAULT_SECTIONS`) …
```

In `case-doc-a4.js` replace the two definitions with:

```js
// INPATIENT_REQUIRED_V1 — список разделов переехал в shared/case-doc-sections.js:
// обязательные разделы проверяет и сервер. Здесь — та же копия, не вторая.
import { KIND_SECTIONS, sectionsFor } from '../../shared/case-doc-sections.js';
export { KIND_SECTIONS, sectionsFor };
```

(The import line goes with the other imports at the top; keep `hasDiagnosis`, `CASE_BLANK_KINDS` etc. working — they use the imported names.)

- [ ] **Step 4: Create `public/js/shared/inpatient-required.js`:**

```js
// INPATIENT_REQUIRED_V1 (2026-11-23) — ЧТО В СТАЦИОНАРЕ ОБЯЗАТЕЛЬНО: ОБЩИЕ ПРАВИЛА СЕРВЕРА И ЭКРАНА.
//
// Сервер по этим правилам считает полноту титульного листа и пустые обязательные
// разделы (rpc/title-sheet.js, rpc/inpatient-reviews.js), экран — рисует отметки
// (views/required-marks.js). Русского текста здесь нет намеренно: подписи полей —
// у экрана (i18n), слова отказов — у сервера.
import { SECTION_KEYS, sectionsFor } from './case-doc-sections.js';
import { richIsEmpty, textIsBlank } from './rich-text.js';

/**
 * Поля титульного листа, которые клиника вправе сделать обязательными.
 * where: 'sheet' — admission_title_sheets, 'patient' — карточка пациента,
 * 'paper' — отметка бумаги (заполнено = время отметки, колонка col).
 * Не предлагаются: ФИО и дата рождения (личность, правится в карточке), ИМТ
 * (вычисляется), примечание.
 */
export const TITLE_FIELDS = Object.freeze([
  ...['gender', 'phone', 'address', 'national_id', 'occupation',
    'emergency_contact_name', 'emergency_contact_phone', 'blood_type', 'allergies']
    .map((key) => ({ key, group: 'patient', where: 'patient' })),
  ...['referred_from', 'delivered_by', 'mobility', 'since_onset'].map((key) => ({ key, group: 'admission', where: 'sheet' })),
  ...['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm'].map((key) => ({ key, group: 'measures', where: 'sheet' })),
  ...['pediculosis', 'sanitation'].map((key) => ({ key, group: 'exam', where: 'sheet' })),
  { key: 'contract_signed', group: 'papers', where: 'paper', col: 'contract_signed_at' },
  { key: 'consent_signed',  group: 'papers', where: 'paper', col: 'consent_signed_at' },
  { key: 'memo_given',      group: 'papers', where: 'paper', col: 'memo_given_at' },
].map(Object.freeze));
export const TITLE_GROUPS = Object.freeze(['patient', 'admission', 'measures', 'exam', 'papers']);
export const TITLE_FIELD_KEYS = Object.freeze(TITLE_FIELDS.map((f) => f.key));
/** Сегодняшние восемь (title-sheet-rules.js REQUIRED_KEYS) — тест держит их равными. */
export const DEFAULT_TITLE_REQUIRED = Object.freeze(['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation']);
/** Переключатели строки inpatient_settings (миграция 298). */
export const SWITCH_KEYS = Object.freeze(['intake_before_attending', 'admitting_at_placement', 'primary_needs_diagnosis', 'discharge_needs_epicrisis', 'title_required']);

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && textIsBlank(v));

/** Заполнено ли одно поле: лист (или форма экрана) и карточка пациента. */
export function titleFieldFilled(def, { sheet = null, patient = null } = {}) {
  if (!def) return true;
  if (def.where === 'patient') {
    const v = patient ? patient[def.key] : null;
    if (def.key === 'blood_type' && String(v || '').trim().toLowerCase() === 'unknown') return false;
    return !blank(v);
  }
  if (!sheet) return false;
  // Бумага: в базе — время отметки, в форме экрана — галочка.
  if (def.where === 'paper') return !blank(sheet[def.col]) || sheet[def.key] === true;
  return !blank(sheet[def.key]);
}

/** Только известные ключи, без повторов, в порядке листа. */
export function cleanTitleRequired(keys) {
  const want = new Set(Array.isArray(keys) ? keys.map(String) : []);
  return TITLE_FIELD_KEYS.filter((k) => want.has(k));
}

/** Какие из обязательных полей пусты — в порядке листа. */
export function missingTitleFields({ sheet = null, patient = null } = {}, requiredKeys = DEFAULT_TITLE_REQUIRED) {
  const want = new Set(cleanTitleRequired(requiredKeys));
  return TITLE_FIELDS.filter((f) => want.has(f.key) && !titleFieldFilled(f, { sheet, patient })).map((f) => f.key);
}

/** Обязательные разделы: только те, что у документа есть, без повторов, в порядке документа. */
export function cleanRequiredSections(list, allowedSections) {
  const want = new Set(Array.isArray(list) ? list.map(String) : []);
  return (Array.isArray(allowedSections) ? allowedSections : []).filter((k) => want.has(k));
}

/** JSON колонки case_doc_types.required_sections → чистый список для рода; испорчено — пусто. */
export function parseRequiredSections(raw, kind) {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const v = JSON.parse(raw);
    return cleanRequiredSections(Array.isArray(v) ? v : [], sectionsFor(kind));
  } catch (e) { return []; }
}

/** Пустые обязательные разделы записи: разметка — по richIsEmpty, диагноз — по тексту. */
export function missingSections(fields, requiredSections) {
  const f = fields || {};
  return (Array.isArray(requiredSections) ? requiredSections : []).filter((key) => {
    if (!SECTION_KEYS.includes(key)) return false;
    return key === 'diagnosis' ? blank(f[key]) : richIsEmpty(f[key]);
  });
}

/** Ответ inpatient_settings_get → правила экрана. Пусто или сбой — сегодняшние правила. */
export function rulesFromSettings(data) {
  const s = (data && data.settings) || {};
  const on = (k) => (s[k] === undefined || s[k] === null ? true : !!Number(s[k]));
  const docs = {};
  for (const d of (data && Array.isArray(data.docs) ? data.docs : [])) {
    if (!d || !d.kind) continue;
    docs[d.kind] = {
      required: !(d.required === false || d.required === 0),
      requiredSections: Array.isArray(d.required_sections) ? d.required_sections.map(String) : [],
    };
  }
  return {
    intakeBeforeAttending: on('intake_before_attending'),
    admittingAtPlacement: on('admitting_at_placement'),
    primaryNeedsDiagnosis: on('primary_needs_diagnosis'),
    dischargeNeedsEpicrisis: on('discharge_needs_epicrisis'),
    titleRequired: on('title_required'),
    titleFields: Array.isArray(s.title_required_fields) ? cleanTitleRequired(s.title_required_fields) : DEFAULT_TITLE_REQUIRED.slice(),
    docs,
  };
}
export const DEFAULT_RULES = Object.freeze(rulesFromSettings(null));

/** Обязательные разделы документа этого рода по правилам экрана. */
export function requiredSectionsOf(rules, kind) {
  const d = rules && rules.docs && rules.docs[kind];
  return d && Array.isArray(d.requiredSections) ? d.requiredSections.slice() : [];
}

/** Обязательные поля листа по правилам экрана: лист не обязателен — не обязательно ничего. */
export function titleKeysOf(rules) {
  const r = rules || DEFAULT_RULES;
  return r.titleRequired ? (r.titleFields || []).slice() : [];
}

/**
 * Ждёт ли госпитализация лечащего врача. withoutExam — переключатель «лечащий врач
 * только после осмотра» выключен: тогда ждёт и пациент, только что положенный на койку.
 */
export function waitsForAttending(row, withoutExam) {
  if (!row) return false;
  return row.status === 'examined' || (withoutExam === true && row.status === 'admitted');
}
```

- [ ] **Step 5: Change `sheetCompleteness` in `public/js/shared/title-sheet-rules.js`** (keep every other export unchanged):

```js
import { missingTitleFields } from './inpatient-required.js';   // INPATIENT_REQUIRED_V1
// …
/**
 * Полон ли лист. INPATIENT_REQUIRED_V1 — список обязательных полей задаёт клиника
 * (лист, карточка пациента, отметки бумаг); без списка — прежние восемь, как было.
 * Есть ли лист вообще, решает вызывающий: без листа и без требований пустот нет.
 */
export function sheetCompleteness(row, keys = REQUIRED_KEYS, patient = null) {
    const missing = missingTitleFields({ sheet: row || null, patient }, keys);
    return { complete: missing.length === 0, missing };
}
```

(`sheetCompleteness(null)` still returns `{ complete: false, missing: REQUIRED_KEYS.slice() }` because every default key is a sheet key — the old test proves it.)

- [ ] **Step 6: Run — expect PASS**, plus the screens' existing guards on the moved list:

`node --test --test-concurrency=4 public/js/shared/case-doc-sections.test.js public/js/shared/inpatient-required.test.js public/js/shared/title-sheet-rules.test.js public/js/admin/__tests__/case-doc-a4.test.mjs`

then `node --test --test-concurrency=4 server/services/rpc/title-sheet.test.js public/js/admin/__tests__/title-sheet.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`

- [ ] **Step 7: Commit**

```bash
printf '%s\n' 'Стационар: общие правила «что обязательно» — поля титульного листа, обязательные разделы, правила экрана; список разделов документов — одна копия в shared (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add public/js/shared/case-doc-sections.js public/js/shared/case-doc-sections.test.js public/js/shared/inpatient-required.js public/js/shared/inpatient-required.test.js public/js/shared/title-sheet-rules.js public/js/shared/title-sheet-rules.test.js public/js/admin/views/case-doc-a4.js
git commit -F .git/INPATIENT_MSG
```

---

### Task 3: Server settings RPCs, licence gate, document set carries `required`

**Files:**
- Create: `server/services/rpc/inpatient-settings.js`, `server/services/rpc/inpatient-settings.test.js`
- Modify: `server/services/rpc/index.js` (imports near L58–63; registry next to `case_doc_types_list` ~L626–630)
- Modify: `server/services/control/gate.js` (READ_ONLY_RPCS, next to `'own_shelf_settings'` ~L244)
- Modify: `server/services/rpc/case-doc-types.js` (`caseDocTypesList`, `parse`, `caseDocTypeSave`)
- Modify: `server/services/rpc/inpatient-reviews.js` (`DOC_SET_SQL` ~L157, `loadCaseDocSet` ~L173)
- Modify: `public/js/admin/i18n-strings.js` (server messages below)

`inpatient-settings.js` must not import `inpatient-flow.js`, `inpatient-reviews.js`, `title-sheet.js` or `case-doc-types.js` (they import it — Task 4/5); it defines its own `RpcError` like `rpc/accommodation.js`.

- [ ] **Step 1: Write the failing test** — `server/services/rpc/inpatient-settings.test.js`:

```js
// INPATIENT_REQUIRED_V1 — «Настройки → Стационар»: кто читает, кто меняет, проверка, журнал, лицензия.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  inpatientSettingsGet, inpatientSettingsSave, loadInpatientSettings, titleRequiredKeys, requiredFlags, DEFAULT_SETTINGS,
} from './inpatient-settings.js';
import { caseDocTypeSave, caseDocTypesList } from './case-doc-types.js';
import { loadCaseDocSet } from './inpatient-reviews.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { RPC } from './index.js';   // реестр RPC (index.js L154 `export const RPC = {`)

const admin = { id: 1, role: 'admin' };
const head  = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const doc   = { id: 5, role: 'doctor' };
const nurse = { id: 3, role: 'nurse' };
const cash  = { id: 7, role: 'cashier' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, u, role] of [[1, 'adm', 'admin'], [3, 'nur', 'nurse'], [4, 'head', 'doctor'], [5, 'doc5', 'doctor'], [7, 'cash', 'cashier']]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)').run(id, u, 'x', 'Сотрудник ' + u, role);
  }
  return db;
}

test('чтение: умолчания = сегодня; читают все, кто ведёт пациента; касса — нет', () => {
  const db = seed();
  const g = inpatientSettingsGet(db, {}, nurse);
  assert.deepEqual(g.settings, {
    intake_before_attending: 1, admitting_at_placement: 1, primary_needs_diagnosis: 1, discharge_needs_epicrisis: 1, title_required: 1,
    title_required_fields: ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation'],
  });
  const primary = g.docs.find((d) => d.kind === 'primary');
  assert.deepEqual(primary, { kind: 'primary', title: '', builtin: true, required: true, required_sections: [], sections: ['complaints', 'objective', 'diagnosis', 'plan', 'body'] });
  assert.deepEqual(g.log, []);
  assert.equal(g.can_edit, false);
  assert.equal(inpatientSettingsGet(db, {}, head).can_edit, true);
  for (const u of [admin, head, doc, nurse]) assert.ok(inpatientSettingsGet(db, {}, u));
  assert.throws(() => inpatientSettingsGet(db, {}, cash), (e) => e.status === 403);
  db.close();
});

test('запись: только главный врач и администратор; пишется лишь изменённое, строка журнала на значение', () => {
  const db = seed();
  for (const u of [doc, nurse, cash]) assert.throws(() => inpatientSettingsSave(db, { intake_before_attending: 0 }, u), (e) => e.status === 403);
  const out = inpatientSettingsSave(db, {
    intake_before_attending: 0, admitting_at_placement: 1,                         // второе не изменилось
    title_required_fields: ['phone', 'height_cm', 'phone'],
    docs: [{ kind: 'round', required: false }, { kind: 'primary', required_sections: ['plan', 'diagnosis'] }],
  }, head);
  assert.equal(out.changed, 4);
  assert.equal(out.settings.intake_before_attending, 0);
  assert.deepEqual(out.settings.title_required_fields, ['phone', 'height_cm']);
  const log = out.log.map((l) => [l.field, l.old_value, l.new_value, l.user_name]);
  assert.deepEqual(log.sort(), [
    ['doc:primary:sections', '[]', '["diagnosis","plan"]', 'Сотрудник head'],
    ['doc:round:required', '1', '0', 'Сотрудник head'],
    ['intake_before_attending', '1', '0', 'Сотрудник head'],
    ['title_required_fields', JSON.stringify(DEFAULT_SETTINGS.title_required_fields), '["phone","height_cm"]', 'Сотрудник head'],
  ].sort());
  const row = db.prepare('SELECT updated_by, updated_at FROM inpatient_settings WHERE id = 1').get();
  assert.equal(row.updated_by, 4);
  assert.ok(row.updated_at);
  // Повтор того же — ничего не пишет.
  assert.equal(inpatientSettingsSave(db, { intake_before_attending: 0 }, admin).changed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inpatient_settings_log').get().n, 4);
  db.close();
});

test('проверка: неизвестный ключ, поле, документ, раздел, не «да/нет» — отказ и НИЧЕГО не записано', () => {
  const db = seed();
  const bad = [
    [{ nonsense: 1 }, /Неизвестная настройка стационара: nonsense/],
    [{ title_required_fields: ['height_cm', 'full_name'] }, /Неизвестное поле титульного листа: full_name/],
    [{ title_required_fields: 'height_cm' }, /список/],
    [{ intake_before_attending: 'может быть' }, /да.*нет/],
    [{ intake_before_attending: 0, docs: [{ kind: 'nope', required: false }] }, /Такого документа в наборе нет: nope/],
    [{ docs: [{ kind: 'operation', required_sections: ['plan'] }] }, /нет раздела: plan/],
    [{ docs: 'x' }, /Список документов/],
  ];
  for (const [args, re] of bad) assert.throws(() => inpatientSettingsSave(db, args, admin), (e) => e.status >= 400 && re.test(e.message), JSON.stringify(args));
  assert.equal(loadInpatientSettings(db).intake_before_attending, 1, 'транзакция откатила частичную запись');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inpatient_settings_log').get().n, 0);
  db.close();
});

test('case_doc_type_save несёт required и required_sections; список их показывает; набор их отдаёт', () => {
  const db = seed();
  caseDocTypeSave(db, { kind: 'head_review', required: 0, required_sections: ['diagnosis'] }, head);
  const t = caseDocTypesList(db, {}, head).types.find((x) => x.kind === 'head_review');
  assert.equal(t.required, false);
  assert.deepEqual(t.required_sections, ['diagnosis']);
  assert.deepEqual(t.sections, ['objective', 'diagnosis', 'plan']);
  const def = loadCaseDocSet(db).find((d) => d.kind === 'head_review');
  assert.equal(def.required, false);
  assert.deepEqual([...def.requiredSections], ['diagnosis']);
  assert.equal(loadCaseDocSet(db).find((d) => d.kind === 'primary').required, true);
  assert.deepEqual(db.prepare("SELECT field FROM inpatient_settings_log ORDER BY id").all().map((r) => r.field),
    ['doc:head_review:required', 'doc:head_review:sections']);
  // Новый свой документ — обязательный по умолчанию, разделы проверяются по полному набору.
  const own = caseDocTypeSave(db, { title: 'Тестовый лист', due_rule: 'none', required_sections: ['body'] }, head).type;
  assert.equal(own.required, true);
  assert.deepEqual(own.required_sections, ['body']);
  db.close();
});

test('база старше 298: умолчания, набор — обязательный, без разделов', () => {
  const db = seed();
  db.exec('DROP TABLE inpatient_settings_log; DROP TABLE inpatient_settings;');
  db.exec('ALTER TABLE case_doc_types DROP COLUMN required_sections; ALTER TABLE case_doc_types DROP COLUMN required;');
  const s = loadInpatientSettings(db);
  assert.equal(s.intake_before_attending, 1);
  assert.deepEqual(titleRequiredKeys(s), [...DEFAULT_SETTINGS.title_required_fields]);
  assert.deepEqual(requiredFlags(s), { intake_before_attending: true, admitting_at_placement: true, primary_needs_diagnosis: true, discharge_needs_epicrisis: true, title_required: true });
  const set = loadCaseDocSet(db);
  assert.ok(set.length >= 10, 'набор клиники читается и без колонок 298');
  assert.ok(set.every((d) => d.required === true && d.requiredSections.length === 0));
  assert.equal(loadInpatientSettings(null).title_required, 1, 'без базы — умолчания');
  db.close();
});

test('лицензия: чтение проходит блокировку, запись — нет; оба имени в реестре RPC', () => {
  assert.equal(isReadOnlyRpc('inpatient_settings_get'), true);
  assert.equal(isReadOnlyRpc('inpatient_settings_save'), false);
  assert.equal(typeof RPC.inpatient_settings_get, 'function');
  assert.equal(typeof RPC.inpatient_settings_save, 'function');
});

test('title_required = 0 — не обязательно ни одно поле листа', () => {
  assert.deepEqual(titleRequiredKeys({ title_required: 0, title_required_fields: ['phone'] }), []);
  assert.deepEqual(titleRequiredKeys({ title_required: 1, title_required_fields: ['phone'] }), ['phone']);
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing): `node --test server/services/rpc/inpatient-settings.test.js`

- [ ] **Step 3: Create `server/services/rpc/inpatient-settings.js`:**

```js
// INPATIENT_REQUIRED_V1 (2026-11-23) — ЧТО В СТАЦИОНАРЕ ОБЯЗАТЕЛЬНО: НАСТРОЙКИ КЛИНИКИ.
//
// Владелец: «in the stationary, we have a roadblocks as a unfilled title list,
// reception doctor filling, and others, we need to make some settings for that so
// we can switch the setup of the stationary documents lists as a required, not
// required fields».
//
// Одна строка настроек и журнал «кто менял» (миграция 298). Читается при КАЖДОМ
// запросе и не кэшируется — то же правило, что у набора документов (loadCaseDocSet):
// сервер живёт неделями, а клиника меняет настройку и ждёт её сразу. База старше 298
// читает умолчания — это поведение до этой правки, строка в строку.
//
// Модуль не импортирует inpatient-flow.js, inpatient-reviews.js, title-sheet.js и
// case-doc-types.js: они читают настройки ОТСЮДА, и обратный импорт замкнул бы кольцо.
import { hasAnyRole } from '../roles.js';
import { rpcT } from '../server-message.js';
import {
  SWITCH_KEYS, DEFAULT_TITLE_REQUIRED, TITLE_FIELD_KEYS,
  cleanTitleRequired, cleanRequiredSections, parseRequiredSections,
} from '../../../public/js/shared/inpatient-required.js';
import { sectionsFor } from '../../../public/js/shared/case-doc-sections.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/** Читают все, кто ведёт пациента в отделении: экранам нужны правила. */
export const SETTINGS_READ_ROLES = ['admin', 'head_doctor', 'doctor', 'nurse', 'senior_nurse'];
/** Меняют те же, кто правит состав истории болезни (DOC_TYPE_WRITE_ROLES). */
export const SETTINGS_WRITE_ROLES = ['admin', 'head_doctor'];

export const DEFAULT_SETTINGS = Object.freeze({
  intake_before_attending: 1, admitting_at_placement: 1, primary_needs_diagnosis: 1,
  discharge_needs_epicrisis: 1, title_required: 1,
  title_required_fields: Object.freeze(DEFAULT_TITLE_REQUIRED.slice()),
  updated_at: null, updated_by: null,
});

function nowUtc(db) {
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
}

function parseFields(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? cleanTitleRequired(v) : DEFAULT_TITLE_REQUIRED.slice();
  } catch (e) { return DEFAULT_TITLE_REQUIRED.slice(); }
}

/** Настройки как простой объект; база старше 298 или без базы — умолчания. */
export function loadInpatientSettings(db) {
  let row = null;
  try { row = db ? db.prepare('SELECT * FROM inpatient_settings WHERE id = 1').get() : null; }
  catch (e) { row = null; }   // база старше миграции 298
  if (!row) return Object.assign({}, DEFAULT_SETTINGS, { title_required_fields: DEFAULT_TITLE_REQUIRED.slice() });
  const out = { title_required_fields: parseFields(row.title_required_fields), updated_at: row.updated_at || null, updated_by: row.updated_by || null };
  for (const k of SWITCH_KEYS) out[k] = row[k] === 0 ? 0 : 1;
  return out;
}

/** Обязательные поля листа: лист не обязателен — не обязательно ничего. */
export function titleRequiredKeys(settings) {
  const s = settings || DEFAULT_SETTINGS;
  return s.title_required ? (s.title_required_fields || []).slice() : [];
}

/** Переключатели для экранов-списков (inpatient_capabilities, admission_flow_state). */
export function requiredFlags(settings) {
  const s = settings || DEFAULT_SETTINGS;
  const out = {};
  for (const k of SWITCH_KEYS) out[k] = !!s[k];
  return out;
}

export function logSettingChange(db, userId, field, oldValue, newValue, at) {
  db.prepare('INSERT INTO inpatient_settings_log (at, user_id, field, old_value, new_value) VALUES (?,?,?,?,?)')
    .run(at, userId || null, field, String(oldValue), String(newValue));
}

function boolArg(v, key) {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  throw rpcT(RpcError, 'Настройка {key}: нужно «да» или «нет».', { key }, 400);
}

/** Действующие документы набора с обязательностью и разделами — для страницы и экранов. */
function docsOf(db) {
  let rows = [];
  try {
    rows = db.prepare('SELECT kind, title, builtin, required, required_sections FROM case_doc_types WHERE active = 1 ORDER BY sort_order, id').all();
  } catch (e) { rows = []; }   // база старше 298
  return rows.map((r) => ({
    kind: r.kind, title: r.title || '', builtin: !!r.builtin, required: r.required !== 0,
    required_sections: parseRequiredSections(r.required_sections, r.kind), sections: sectionsFor(r.kind),
  }));
}

/**
 * Обязательность документа и его обязательные разделы. Пишет только изменённое,
 * каждое изменение — строкой журнала. Зовут оба входа: страница «Стационар»
 * (inpatient_settings_save) и case_doc_type_save. Транзакцию открывает вызывающий.
 * @returns {number} сколько значений изменилось
 */
export function applyDocRequired(db, kind, input, user, at) {
  const a = input || {};
  const row = db.prepare('SELECT kind, required, required_sections FROM case_doc_types WHERE kind = ?').get(kind);
  if (!row) throw rpcT(RpcError, 'Такого документа в наборе нет: {kind}.', { kind }, 404);
  const uid = (user && user.id) || null;
  let changed = 0;
  if (a.required !== undefined && a.required !== null) {
    const next = boolArg(a.required, 'required');
    const prev = row.required === 0 ? 0 : 1;
    if (next !== prev) {
      db.prepare('UPDATE case_doc_types SET required = ? WHERE kind = ?').run(next, kind);
      logSettingChange(db, uid, 'doc:' + kind + ':required', prev, next, at);
      changed += 1;
    }
  }
  if (a.required_sections !== undefined && a.required_sections !== null) {
    if (!Array.isArray(a.required_sections)) throw new RpcError('Обязательные разделы документа — список.', 400);
    const allowed = sectionsFor(kind);
    for (const s of a.required_sections) {
      if (!allowed.includes(String(s))) throw rpcT(RpcError, 'У этого документа нет раздела: {section}.', { section: String(s) }, 400);
    }
    const next = JSON.stringify(cleanRequiredSections(a.required_sections, allowed));
    const prev = JSON.stringify(parseRequiredSections(row.required_sections, kind));
    if (next !== prev) {
      db.prepare('UPDATE case_doc_types SET required_sections = ? WHERE kind = ?').run(next, kind);
      logSettingChange(db, uid, 'doc:' + kind + ':sections', prev, next, at);
      changed += 1;
    }
  }
  return changed;
}

export function inpatientSettingsGet(db, _args, user) {
  if (!hasAnyRole(user, SETTINGS_READ_ROLES)) throw new RpcError('Настройки стационара — недоступно вашей роли.', 403);
  const s = loadInpatientSettings(db);
  let log = [];
  try {
    log = db.prepare(`
      SELECT l.id, l.at, l.user_id, u.full_name AS user_name, l.field, l.old_value, l.new_value
        FROM inpatient_settings_log l LEFT JOIN users u ON u.id = l.user_id
       ORDER BY l.id DESC LIMIT 20`).all();
  } catch (e) { log = []; }
  const settings = {};
  for (const k of SWITCH_KEYS) settings[k] = s[k];
  settings.title_required_fields = s.title_required_fields.slice();
  return { settings, docs: docsOf(db), log, updated_at: s.updated_at, can_edit: hasAnyRole(user, SETTINGS_WRITE_ROLES) };
}

const ALLOWED_KEYS = new Set([...SWITCH_KEYS, 'title_required_fields', 'docs']);

export function inpatientSettingsSave(db, args, user) {
  if (!hasAnyRole(user, SETTINGS_WRITE_ROLES)) throw new RpcError('Настройки стационара меняет главный врач или администратор.', 403);
  const a = args || {};
  for (const key of Object.keys(a)) {
    if (!ALLOWED_KEYS.has(key)) throw rpcT(RpcError, 'Неизвестная настройка стационара: {key}.', { key }, 400);
  }
  // Всё проверяется ДО записи: отказ не оставляет половины изменений.
  const nextSwitch = {};
  for (const k of SWITCH_KEYS) if (a[k] !== undefined && a[k] !== null) nextSwitch[k] = boolArg(a[k], k);
  let nextFields = null;
  if (a.title_required_fields !== undefined && a.title_required_fields !== null) {
    if (!Array.isArray(a.title_required_fields)) throw new RpcError('Обязательные поля титульного листа — список.', 400);
    for (const f of a.title_required_fields) {
      if (!TITLE_FIELD_KEYS.includes(String(f))) throw rpcT(RpcError, 'Неизвестное поле титульного листа: {key}.', { key: String(f) }, 400);
    }
    nextFields = cleanTitleRequired(a.title_required_fields);
  }
  const docs = a.docs === undefined || a.docs === null ? [] : a.docs;
  if (!Array.isArray(docs) || docs.some((d) => !d || typeof d !== 'object')) throw new RpcError('Список документов передан неверно.', 400);

  const run = db.transaction(() => {
    const at = nowUtc(db);
    const uid = (user && user.id) || null;
    const cur = loadInpatientSettings(db);
    let changed = 0;
    // Имя колонки — из SWITCH_KEYS, а не из запроса: SQL из тела запроса не строится.
    for (const k of SWITCH_KEYS) {
      if (!(k in nextSwitch) || cur[k] === nextSwitch[k]) continue;
      db.prepare(`UPDATE inpatient_settings SET ${k} = ? WHERE id = 1`).run(nextSwitch[k]);
      logSettingChange(db, uid, k, cur[k], nextSwitch[k], at);
      changed += 1;
    }
    if (nextFields) {
      const prev = JSON.stringify(cur.title_required_fields);
      const next = JSON.stringify(nextFields);
      if (prev !== next) {
        db.prepare('UPDATE inpatient_settings SET title_required_fields = ? WHERE id = 1').run(next);
        logSettingChange(db, uid, 'title_required_fields', prev, next, at);
        changed += 1;
      }
    }
    for (const d of docs) changed += applyDocRequired(db, String(d.kind || ''), d, user, at);
    if (changed) db.prepare('UPDATE inpatient_settings SET updated_at = ?, updated_by = ? WHERE id = 1').run(at, uid);
    return changed;
  });
  const changed = run();
  return Object.assign(inpatientSettingsGet(db, {}, user), { changed });
}
```

- [ ] **Step 4: Register.** In `server/services/rpc/index.js` add the import (next to the `case-doc-types.js` import):

```js
import { inpatientSettingsGet, inpatientSettingsSave } from './inpatient-settings.js';   // INPATIENT_REQUIRED_V1 — «Настройки → Стационар»
```

and next to `case_doc_types_reorder:` in the registry:

```js
  inpatient_settings_get:         (db, args, user) => inpatientSettingsGet(db, args, user),    // INPATIENT_REQUIRED_V1 — чтение (READ_ONLY_RPCS)
  inpatient_settings_save:        (db, args, user) => inpatientSettingsSave(db, args, user),   // INPATIENT_REQUIRED_V1 — главный врач, администратор
```

In `server/services/control/gate.js` READ_ONLY_RPCS, after `'own_shelf_settings',`:

```js
  // INPATIENT_REQUIRED_V1 — что в стационаре обязательно: чтение правил, по которым
  // экраны рисуют отметки. Заблокированной клинике они нужны, чтобы работать с
  // лежащими пациентами. Сохранение — запись, сюда не входит.
  'inpatient_settings_get',
```

- [ ] **Step 5: Document set carries the flags** — `server/services/rpc/inpatient-reviews.js`:

```js
import { parseRequiredSections } from '../../../public/js/shared/inpatient-required.js';   // INPATIENT_REQUIRED_V1

// INPATIENT_REQUIRED_V1 — колонки 298: обязательный ли документ и его обязательные разделы.
// База 115–297 их не знает — тогда читается прежний запрос (документы обязательны, как были).
const DOC_SET_SQL_V2 = 'SELECT kind, title, due_rule, due_hours, block, required, required_sections FROM case_doc_types WHERE active = 1 ORDER BY sort_order, id';

export function loadCaseDocSet(db) {
  let rows = null;
  try { rows = db.prepare(DOC_SET_SQL_V2).all(); }
  catch (e) {
    try { rows = db.prepare(DOC_SET_SQL).all(); }   // база старше миграции 298
    catch (e2) { rows = null; }                      // база старше миграции 115
  }
  if (!rows || !rows.length) return CASE_DOC_SET;
  return rows.map((r) => Object.freeze({
    kind: r.kind,
    title: r.title || '',
    due: r.due_rule,
    hours: r.due_hours === null || r.due_hours === undefined ? null : Number(r.due_hours),
    block: r.block || undefined,
    required: r.required !== 0,
    requiredSections: Object.freeze(parseRequiredSections(r.required_sections, r.kind)),
  }));
}
```

(`CASE_DOC_SET` itself stays unchanged; Task 5 treats a missing `required` as `true`.)

- [ ] **Step 6: `case-doc-types.js` carries the two fields.**
  - `import { applyDocRequired } from './inpatient-settings.js';   // INPATIENT_REQUIRED_V1`, `import { parseRequiredSections } from '../../../public/js/shared/inpatient-required.js';`, `import { sectionsFor } from '../../../public/js/shared/case-doc-sections.js';`
  - `caseDocTypesList` row map gains: `required: r.required !== 0, required_sections: parseRequiredSections(r.required_sections, r.kind), sections: sectionsFor(r.kind),` (on an old base `r.required` is `undefined` → `true`).
  - `caseDocTypeSave`: wrap the INSERT/UPDATE and the follow-up in `db.transaction(() => { … })()`; after the row is written call `applyDocRequired(db, kindWritten, { required: a.required, required_sections: a.required_sections }, user, at)` where `at` = `db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t`. Absent fields change nothing (CASE_DOC_RENAME_V1 rule «что не прислали, то не меняется»).

- [ ] **Step 7: Dictionary** — add ru/uz/en entries for the new server messages (`server/i18n-server-messages.test.js` requires them):
  - `Настройки стационара — недоступно вашей роли.`
  - `Настройки стационара меняет главный врач или администратор.`
  - `Неизвестная настройка стационара: {key}.`
  - `Неизвестное поле титульного листа: {key}.`
  - `Обязательные поля титульного листа — список.`
  - `Список документов передан неверно.`
  - `Такого документа в наборе нет: {kind}.`
  - `У этого документа нет раздела: {section}.`
  - `Обязательные разделы документа — список.`
  - `Настройка {key}: нужно «да» или «нет».`

- [ ] **Step 8: Run — expect PASS:**

`node --test --test-concurrency=4 server/services/rpc/inpatient-settings.test.js server/services/rpc/case-doc-types.test.js server/i18n-server-messages.test.js server/routes/licence-gate.test.js`

then `node --test --test-concurrency=4 server/services/rpc/case-docs.test.js server/services/rpc/inpatient-reviews.test.js server/services/rpc/client-rpc-coverage.test.js server/services/rpc/admitting-doctor.test.js`

- [ ] **Step 9: Commit**

```bash
printf '%s\n' 'Стационар: RPC настроек «что обязательно» (чтение для отделения, запись — главный врач и администратор, журнал), чтение проходит блокировку лицензии; набор документов несёт обязательность и обязательные разделы (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add server/services/rpc/inpatient-settings.js server/services/rpc/inpatient-settings.test.js server/services/rpc/index.js server/services/control/gate.js server/services/rpc/case-doc-types.js server/services/rpc/inpatient-reviews.js public/js/admin/i18n-strings.js
git commit -F .git/INPATIENT_MSG
```

---

### Task 4: Server gates — attending without exam, exam while active, discharge switch, flags for screens

**Files:**
- Modify: `server/services/rpc/inpatient-flow.js` (`assertCanPrescribe` ~L295, `admissionTransition` ~L373, `admissionFlowState` ~L503, `inpatientCapabilities` ~L555)
- Modify: `server/services/rpc/inpatient-reviews.js` (`admissionReviewSave` publish block ~L498–510 and ~L597–610; `admissionSetAttending` ~L644–700)
- Modify: `server/services/rpc/inpatient.js` (`admissionDischargeRequest`, check 4 ~L1237–1262)
- Create: `server/services/rpc/inpatient-required-gates.test.js`

Readers of `examined_at` / `examined_by` / status `examined` audited for this plan (re-check with `grep -rn "examined" server/services public/js --include=*.js | grep -v test`): `admission-modal.js` card (shows «ещё не проведён» when `examined_at` is null — correct for an admission treated without exam), `admissions.js` / `consultation.js` / `doctor-dashboard.js` queues (Task 9), `inpatient.js` legacy `admit_patient` (untouched), `admissionFlowState` (this task). Nothing else reads them.

- [ ] **Step 1: Write the failing test** — `server/services/rpc/inpatient-required-gates.test.js`:

```js
// INPATIENT_REQUIRED_V1 — четыре переключателя на сервере: включены — как раньше; выключены — шаг не держит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit, admissionDischargeRequest } from './inpatient.js';
import { admissionReviewSave, admissionSetAttending } from './inpatient-reviews.js';
import { admissionTransition, assertCanPrescribe, admissionFlowState, inpatientCapabilities } from './inpatient-flow.js';
import { inpatientSettingsSave } from './inpatient-settings.js';

const admin     = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const nurse     = { id: 3, role: 'nurse' };
const head      = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const admitting = { id: 5, role: 'doctor' };
const other     = { id: 6, role: 'doctor' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, u, role, isDoc] of [[1, 'adm', 'admin', 0], [2, 'reg', 'registrar', 0], [3, 'nur', 'nurse', 0], [4, 'head', 'doctor', 1], [5, 'doc5', 'doctor', 1], [6, 'doc6', 'doctor', 1]]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)').run(id, u, 'x', 'Сотрудник ' + u, role, isDoc);
  }
  const pid = db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Тестов Пациент','T-0001')").run().lastInsertRowid;
  const ward = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
  const bed = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-1', ?, 'free')").run(ward).lastInsertRowid;
  return { db, pid, bed };
}
function placed(ctx, extra = {}) {
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: ctx.pid, department: 'Терапия' }, registrar);
  return admissionAdmit(ctx.db, Object.assign({ admission_id: admission.id, bed_id: ctx.bed }, extra), nurse).admission;
}
const off = (db, key) => inpatientSettingsSave(db, { [key]: 0 }, admin);
const status = (db, id) => db.prepare('SELECT status, attending_doctor_id, examined_at, examined_by FROM admissions WHERE id = ?').get(id);

test('лечащий врач, переключатель включён (умолчание): с койки — отказ, как раньше', () => {
  const ctx = seed();
  const a = placed(ctx);
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head), /не осмотрен/);
  assert.equal(status(ctx.db, a.id).status, 'admitted');
  assert.throws(() => assertCanPrescribe(ctx.db, a.id, head), /не осмотрен главным врачом/);
  assert.equal(inpatientCapabilities(ctx.db, {}, head).required.intake_before_attending, true);
  assert.notEqual(admissionFlowState(ctx.db, { admission_id: a.id }, head).can.active, true);
  ctx.db.close();
});

test('лечащий врач, переключатель выключен: назначают прямо с койки; осмотр никем не записан', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx, { admitting_doctor_id: 5 });
  assert.throws(() => assertCanPrescribe(ctx.db, a.id, head), /Лечащий врач ещё не назначен/);
  assert.equal(admissionFlowState(ctx.db, { admission_id: a.id }, head).can.active, true);
  assert.equal(admissionFlowState(ctx.db, { admission_id: a.id }, head).required.intake_before_attending, false);
  // Чужой врач — нельзя; приёмный врач этого пациента — можно.
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 6 }, other), (e) => e.status === 403);
  const res = admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 6 }, admitting);
  assert.equal(res.admission.status, 'active');
  assert.deepEqual({ ...status(ctx.db, a.id) }, { status: 'active', attending_doctor_id: 6, examined_at: null, examined_by: null });
  assert.ok(assertCanPrescribe(ctx.db, a.id, other), 'лечащий врач ведёт назначения');
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head), /уже назначен/);
  ctx.db.close();
});

test('машина маршрута сама «койка → лечение» не предлагает — и при выключенном переключателе', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx);
  assert.throws(() => admissionTransition(ctx.db, { admission_id: a.id, to: 'active' }, admin), /Нельзя пропустить шаг/);
  assert.equal(status(ctx.db, a.id).status, 'admitted');
  ctx.db.close();
});

test('первичный осмотр во время лечения: выключено — документ (маршрут на месте, осмотр записан); включено — отказ', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx);
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head);
  const r = admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', publish: true }, head);
  assert.ok(r.review.published_at);
  const s = status(ctx.db, a.id);
  assert.equal(s.status, 'active');
  assert.equal(s.examined_by, 4);
  assert.ok(s.examined_at);
  // Включили обратно: уже лечащиеся не двигаются, а новый первичный во время лечения — отказ, как раньше.
  inpatientSettingsSave(ctx.db, { intake_before_attending: 1 }, admin);
  assert.equal(status(ctx.db, a.id).status, 'active');
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.0', publish: true }, head),
    /закрыт назначением лечащего врача/);
  ctx.db.close();
});

test('выписка: включено — без эпикриза отказ; выключено — заявку принимают', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx);
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head);
  assert.throws(() => admissionDischargeRequest(ctx.db, { admission_id: a.id, outcome: 'home' }, head),
    (e) => e.status === 400 && /Выписной эпикриз не написан/.test(e.message));
  off(ctx.db, 'discharge_needs_epicrisis');
  const res = admissionDischargeRequest(ctx.db, { admission_id: a.id, outcome: 'home' }, head);
  assert.equal(res.admission.status, 'discharging');
  ctx.db.close();
});

test('приёмный врач при размещении: сервер, как и раньше, кладёт без него при любом положении', () => {
  const ctx = seed();
  assert.equal(placed(ctx).admitting_doctor_id, null);
  ctx.db.close();
});
```

(`admissionDischargeRequest` returns `{ admission, epicrisis_id, bill, active_orders, balance, from }` — `inpatient.js` ~L1281.)

- [ ] **Step 2: Run — expect FAIL:** `node --test server/services/rpc/inpatient-required-gates.test.js`

- [ ] **Step 3: Route machine** — `server/services/rpc/inpatient-flow.js`:

```js
import { loadInpatientSettings, requiredFlags } from './inpatient-settings.js';   // INPATIENT_REQUIRED_V1
```

In `admissionTransition`, replace step 1 and the role line of step 2:

```js
  // INPATIENT_REQUIRED_V1 — «Лечащий врач — только после осмотра приёмного врача»
  // ВЫКЛЮЧЕН: лечащего назначают прямо с койки, и маршрут идёт admitted → active.
  // Это НЕ стрелка таблицы (domain/lifecycle.js её не знает, admission_transition её
  // не предлагает): пройти её может только admission_set_attending, который сам
  // проверил право и передаёт opts.withoutExam, — и только пока переключатель выключен.
  const withoutExam = !!(opts && opts.withoutExam) && from === 'admitted' && to === 'active';
  if (withoutExam) {
    if (loadInpatientSettings(db).intake_before_attending) throw new RpcError(explainRefusal(from, to), 400);
  } else {
    try {
      assertTransition('admission', from, to);
    } catch (e) {
      if (e instanceof TransitionError) throw new RpcError(explainRefusal(from, to), 400);
      throw e;
    }
  }
  // … (идемпотентный повтор — без изменений) …
  const asAdmitting = !!(opts && opts.admittingDoctorOk)
    && isAdmittingDoctor(adm, user) && (to === 'examined' || to === 'active');
  // Право — то же, что у назначения лечащего врача после осмотра.
  if (!asAdmitting) assertMayTransition(withoutExam ? 'examined' : from, to, user);
```

`examined_by/at` are set only `if (to === 'examined')` — unchanged, so the skip never stamps them.

In `assertCanPrescribe`, the refusal for «рано»:

```js
    // INPATIENT_REQUIRED_V1 — без обязательного осмотра лежащий на койке ждёт лечащего врача, а не осмотра.
    const waitsAttending = have !== undefined && (have >= RANK.get('examined')
      || (adm.status === 'admitted' && !loadInpatientSettings(db).intake_before_attending));
    throw new RpcError(waitsAttending
      ? 'Лечащий врач ещё не назначен — назначения недоступны.'
      : 'Пациент ещё не осмотрен главным врачом — назначения недоступны.', 400);
```

In `admissionFlowState`, before `return`:

```js
  // INPATIENT_REQUIRED_V1 — осмотр перед лечащим врачом выключен: «Назначить лечащего
  // врача» доступен прямо с койки тем же, кто назначает его после осмотра.
  const settings = loadInpatientSettings(db);
  if (adm.status === 'admitted' && !settings.intake_before_attending) {
    can.active = roles.some((r) => TRANSITION_ROLES['examined→active'].includes(r));
  }
```

and add `required: requiredFlags(settings),` to the returned object. In `inpatientCapabilities(db, _args, user)` (rename `_db` → `db`) add `required: requiredFlags(loadInpatientSettings(db))` to the returned object.

- [ ] **Step 4: Set attending** — `admissionSetAttending` in `inpatient-reviews.js` (add `import { loadInpatientSettings } from './inpatient-settings.js';   // INPATIENT_REQUIRED_V1`):

```js
    const adm = loadAdmission(db, a.admission_id);
    // INPATIENT_REQUIRED_V1 — переключатель «только после осмотра» выключен: лечащего
    // назначают сразу после койки. Кто вправе — как и раньше: главный врач,
    // администратор, приёмный врач этого пациента.
    const withoutExam = adm.status === 'admitted' && !loadInpatientSettings(db).intake_before_attending;

    const asAdmitting = isAdmittingDoctor(adm, user);
    if (!asAdmitting) assertMayTransition('examined', 'active', user);

    if (!withoutExam) {
      assertAdmissionAtLeast(db, adm.id, 'examined');
      if (adm.status !== 'examined') {
        throw new RpcError('Лечащий врач уже назначен — смена лечащего врача делается отдельно (главный врач).', 400);
      }
    }
    // … (проверка врача и UPDATE — без изменений) …
    const res = admissionTransition(db, { admission_id: adm.id, to: 'active' }, user, { admittingDoctorOk: asAdmitting, withoutExam });
```

- [ ] **Step 5: Exam published while active** — in `admissionReviewSave`, publish branch for `kind === 'primary'`:

```js
        assertMayTransition('admitted', 'examined', user);
        // INPATIENT_REQUIRED_V1 — лечащего назначили без осмотра (переключатель
        // выключен): первичный осмотр во время лечения — документ, маршрут не двигает.
        const asDocument = adm.status === 'active' && !loadInpatientSettings(db).intake_before_attending;
        if (adm.status !== 'admitted' && adm.status !== 'examined' && !asDocument) {
          throw new RpcError(primaryStateRefusal(db, adm), 400);
        }
```

and in «Что публикация МЕНЯЕТ», after the two existing transition blocks:

```js
      // INPATIENT_REQUIRED_V1 — осмотр, опубликованный уже во время лечения (лечащего
      // назначили без осмотра), маршрут не двигает, но КТО И КОГДА осмотрел —
      // записывается: карточка госпитализации иначе писала бы «ещё не проведён»
      // рядом с опубликованным осмотром. COALESCE — первую подпись не переписываем.
      if ((kind === 'primary' || kind === 'intake') && adm.status === 'active'
          && !loadInpatientSettings(db).intake_before_attending) {
        db.prepare('UPDATE admissions SET examined_at = COALESCE(examined_at, ?), examined_by = COALESCE(examined_by, ?) WHERE id = ?')
          .run(at, (user && user.id) || null, adm.id);
      }
```

- [ ] **Step 6: Discharge switch** — `admissionDischargeRequest` in `inpatient.js` (add `import { loadInpatientSettings } from './inpatient-settings.js';   // INPATIENT_REQUIRED_V1`):

```js
    // INPATIENT_REQUIRED_V1 — «Выписка — только с выписным эпикризом» выключен:
    // заявку принимают без эпикриза, даже если он остаётся в наборе документов.
    const wantsEpicrisis = loadInpatientSettings(db).discharge_needs_epicrisis
      && db.prepare("SELECT 1 FROM case_doc_types WHERE kind = 'discharge' AND active = 1").get();
```

- [ ] **Step 7: Run — expect PASS**, then the route-machine guards:

`node --test --test-concurrency=4 server/services/rpc/inpatient-required-gates.test.js server/services/rpc/inpatient-flow.test.js server/services/domain/lifecycle.test.js server/services/rpc/inpatient-head-scope.test.js`

`node --test --test-concurrency=4 server/services/rpc/admitting-doctor.test.js server/services/rpc/inpatient-reviews.test.js server/services/rpc/discharge.test.js server/services/rpc/case-docs.test.js`

`node --test --test-concurrency=4 server/services/rpc/inpatient.test.js server/services/rpc/case-doc-types.test.js server/i18n-server-messages.test.js server/services/rpc/inpatient-v3120.test.js`

- [ ] **Step 8: Commit**

```bash
printf '%s\n' 'Стационар: переключатели на сервере — лечащий врач прямо с койки без осмотра (маршрут admitted→active только через назначение), первичный осмотр во время лечения как документ, выписка без эпикриза; права и экраны получают положение переключателей (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add server/services/rpc/inpatient-flow.js server/services/rpc/inpatient-reviews.js server/services/rpc/inpatient.js server/services/rpc/inpatient-required-gates.test.js
git commit -F .git/INPATIENT_MSG
```

---

### Task 5: Server checklist, title-sheet RPCs and case overview use the clinic's rules

**Files:**
- Modify: `server/services/rpc/inpatient-reviews.js` (`admissionCaseDocs` ~L1105–1420)
- Modify: `server/services/rpc/title-sheet.js` (`sheetView`, `saveTitleSheet`, `titleSheetCaseItem`)
- Modify: `server/services/rpc/case-overview.js` (`title_sheet:` in the return ~L237)
- Create: `server/services/rpc/inpatient-required-checklist.test.js`

- [ ] **Step 1: Write the failing test** — `server/services/rpc/inpatient-required-checklist.test.js`:

```js
// INPATIENT_REQUIRED_V1 — чек-лист: документы «по желанию», полнота листа по списку клиники, пустые разделы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit } from './inpatient.js';
import { admissionReviewSave, admissionCaseDocs } from './inpatient-reviews.js';
import { admissionTitleSheetGet, admissionTitleSheetSave } from './title-sheet.js';
import { inpatientSettingsSave } from './inpatient-settings.js';

const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const nurse = { id: 3, role: 'nurse' };
const head = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const H = 3600 * 1000;
const NOW = Date.parse('2026-11-23T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, u, role, isDoc] of [[1, 'adm', 'admin', 0], [2, 'reg', 'registrar', 0], [3, 'nur', 'nurse', 0], [4, 'head', 'doctor', 1]]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)').run(id, u, 'x', 'Сотрудник ' + u, role, isDoc);
  }
  const pid = db.prepare("INSERT INTO patients (full_name, mrn, phone) VALUES ('Тестов Пациент','T-0002','+998900000000')").run().lastInsertRowid;
  const ward = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
  const bed = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-1', ?, 'free')").run(ward).lastInsertRowid;
  return { db, pid, bed };
}
function inBed(ctx, hoursAgo) {
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: ctx.pid, department: 'Терапия' }, registrar);
  const a = admissionAdmit(ctx.db, { admission_id: admission.id, bed_id: ctx.bed }, nurse).admission;
  ctx.db.prepare('UPDATE admissions SET admitted_at = ? WHERE id = ?').run(iso(NOW - hoursAgo * H), a.id);
  return a;
}
const docs = (ctx, a) => admissionCaseDocs(ctx.db, { admission_id: a.id, now: iso(NOW) }, head);
const item = (st, kind) => st.items.find((i) => i.kind === kind);

test('умолчания: всё обязательно, как раньше; поля несут optional и missing_sections', () => {
  const ctx = seed();
  const st = docs(ctx, inBed(ctx, 100));
  for (const it of st.items) {
    assert.equal(it.optional, false, it.kind);
    assert.deepEqual(it.missing_sections, [], it.kind);
  }
  assert.equal(item(st, 'title').required, true);
  assert.deepEqual(item(st, 'title').missing, ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation']);
  assert.equal(item(st, 'head_review').state, 'overdue');
  assert.equal(st.discharge_gate.epicrisis_required, true);
  ctx.db.close();
});

test('документ «по желанию»: не просрочен, не следующий шаг, не в прогрессе и не в «не оформлено»', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'head_review', required: false }, { kind: 'intake', required: false }] }, admin);
  const st = docs(ctx, inBed(ctx, 100));
  for (const kind of ['head_review', 'intake']) {
    const it = item(st, kind);
    assert.equal(it.optional, true, kind);
    assert.equal(it.required, false, kind);
    assert.equal(it.state, 'pending', kind);
    assert.ok(!st.discharge_gate.incomplete.includes(kind), kind);
  }
  assert.notEqual(st.next_kind, 'intake');
  assert.notEqual(st.next_kind, 'head_review');
  const required = st.items.filter((i) => i.required).length;
  assert.equal(st.progress.total, required);
  ctx.db.close();
});

test('титульный лист не обязателен: строка «по желанию», не просрочена, не держит набор', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { title_required: 0 }, admin);
  const st = docs(ctx, inBed(ctx, 30));
  const t = item(st, 'title');
  assert.equal(t.required, false);
  assert.equal(t.optional, true);
  assert.equal(t.state, 'pending');
  assert.deepEqual(t.missing, []);
  assert.ok(!st.discharge_gate.incomplete.includes('title'));
  ctx.db.close();
});

test('свой список полей листа: поле карточки и отметка бумаги; filled_at — по списку клиники', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { title_required_fields: ['height_cm', 'phone', 'consent_signed'] }, admin);
  const a = inBed(ctx, 1);
  let v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: { height_cm: '172' } }, nurse);
  assert.deepEqual(v.required_fields, ['phone', 'height_cm', 'consent_signed']);
  assert.deepEqual(v.missing, ['consent_signed']);
  assert.equal(v.complete, false);
  assert.equal(v.sheet.filled_at, null);
  v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: { consent_signed: true } }, nurse);
  assert.equal(v.complete, true);
  assert.ok(v.sheet.filled_at, 'лист заполнен по списку клиники — подпись ставится');
  assert.equal(item(docs(ctx, a), 'title').state, 'published');
  // Без телефона в карточке лист снова неполон (карточку правят из листа же).
  v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, patient: { phone: '' } }, nurse);
  assert.deepEqual(v.missing, ['phone']);
  assert.deepEqual(admissionTitleSheetGet(ctx.db, { admission_id: a.id }, head).missing, ['phone']);
  ctx.db.close();
});

test('missing_sections: опубликованный с пустым обязательным разделом — оформлен, но пробел назван; черновик — тоже', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'primary', required_sections: ['diagnosis', 'plan'] }, { kind: 'intake', required_sections: ['complaints'] }] }, admin);
  const a = inBed(ctx, 1);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', plan: '<p><br></p>', publish: true }, head);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', objective: '<p>ясно</p>' }, head);   // черновик
  const st = docs(ctx, a);
  assert.equal(item(st, 'primary').state, 'published');
  assert.deepEqual(item(st, 'primary').missing_sections, ['plan']);
  assert.deepEqual(item(st, 'intake').missing_sections, ['complaints']);
  assert.deepEqual(item(st, 'round').missing_sections, [], 'документа нет — пробелов не называем');
  ctx.db.close();
});

test('гейт выписки: эпикриз не обязателен — не держит и чек-лист говорит то же', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { discharge_needs_epicrisis: 0 }, admin);
  const st = docs(ctx, inBed(ctx, 1));
  assert.equal(st.discharge_gate.blocked, false);
  assert.equal(st.discharge_gate.epicrisis_required, false);
  ctx.db.close();
});
```

- [ ] **Step 2: Run — expect FAIL:** `node --test server/services/rpc/inpatient-required-checklist.test.js`

- [ ] **Step 3: `title-sheet.js`.** Imports: `import { loadInpatientSettings, titleRequiredKeys } from './inpatient-settings.js';   // INPATIENT_REQUIRED_V1`. Add:

```js
/** INPATIENT_REQUIRED_V1 — поля карточки, которые лист показывает и может требовать. */
function loadPatientForSheet(db, patientId) {
  if (!patientId) return null;
  return db.prepare(`SELECT ${PATIENT_FIELDS.join(', ')} FROM patients WHERE id = ?`).get(patientId) || null;   // имена — из PATIENT_FIELDS, не из запроса
}
```

  - `sheetView`: `const settings = loadInpatientSettings(db); const keys = titleRequiredKeys(settings); const { complete, missing } = sheetCompleteness(sheet, keys, patient);` and return additionally `required_fields: keys, title_required: !!settings.title_required`.
  - `saveTitleSheet`: move the whole «Исправления личных данных — В КАРТОЧКУ» block (the `pin`/`sets`/`UPDATE patients`) **above** `const { complete } = sheetCompleteness(next);` (it needs `now`, already computed above it). Then compute completeness with the clinic list:

```js
  // INPATIENT_REQUIRED_V1 — «заполнен целиком» — по списку клиники: лист, карточка
  // (уже с исправлениями выше) и отметки бумаг.
  const keys = titleRequiredKeys(loadInpatientSettings(db));
  const { complete } = sheetCompleteness(next, keys, loadPatientForSheet(db, adm.patient_id));
```

  - `titleSheetCaseItem(db, adm, baseMs, nowMs, settings = loadInpatientSettings(db))`:

```js
  const row = loadSheet(db, adm.id);
  // INPATIENT_REQUIRED_V1 — обязателен ли лист и какие поля — решает клиника.
  const required = !!settings.title_required;
  const keys = titleRequiredKeys(settings);
  const { complete, missing } = sheetCompleteness(row, keys, loadPatientForSheet(db, adm.patient_id));
  const dueAt = baseMs === null || baseMs === undefined ? null : baseMs + SHEET_DUE_HOURS * MS_HOUR;
  let state;
  if (row && complete) state = 'published';
  else if (required && dueAt !== null && nowMs > dueAt) state = 'overdue';   // «по желанию» не просрочивается
  else if (row) state = 'draft';
  else state = 'pending';
```

and in the returned object: `required, optional: !required, missing, required_fields: keys, missing_sections: [],` and `published_at: row && complete ? (row.filled_at || row.updated_at || row.created_at) : null` (a sheet that became complete because the list was shortened has no `filled_at`).

- [ ] **Step 4: `admissionCaseDocs` in `inpatient-reviews.js`.** Imports: `import { missingSections } from '../../../public/js/shared/inpatient-required.js';` (merge with the Task 3 import) and `loadInpatientSettings` (already imported in Task 4).
  - Right after `const docSet = loadCaseDocSet(db);` add `const settings = loadInpatientSettings(db);   // INPATIENT_REQUIRED_V1 — один раз на чек-лист`.
  - Inside `docSet.map(...)`, after the existing line `if ((def.due === 'at_discharge' || def.due === 'none') && state === 'overdue') state = 'pending';`:

```js
    // INPATIENT_REQUIRED_V1 — документ «по желанию»: стоит в наборе, но никогда не
    // просрочен, не «следующий шаг», не в прогрессе и не в «не оформлено».
    const optional = def.required === false;
    if (optional) {
      periodsMissing = 0;
      if (state === 'overdue') state = 'pending';
    }
```

  - After `const tail = …`:

```js
    // INPATIENT_REQUIRED_V1 — пустые обязательные разделы: в действующей редакции,
    // а нет её — в черновике. Опубликованный с пробелом остаётся оформленным (автор
    // выбрал «Сохранить как есть»), экран называет пробел.
    const reqSecs = Array.isArray(def.requiredSections) ? def.requiredSections : [];
    const secSrc = tail || draft;
    const missingSecs = reqSecs.length && secSrc ? missingSections(secSrc, reqSecs) : [];
```

  - In the returned item: `required: applies && required && !optional,` plus `optional,` and `missing_sections: missingSecs,`.
  - `const titleItem = titleSheetCaseItem(db, adm, base, now, settings);`
  - Discharge gate:

```js
  // INPATIENT_REQUIRED_V1 — «Выписка — только с выписным эпикризом» выключен: гейт
  // не держит, и чек-лист говорит то же, что сервер (admission_discharge_request).
  const epicrisisRequired = !!settings.discharge_needs_epicrisis;
  const blocking = epicrisisRequired && epicrisis && epicrisis.state !== 'published'
    ? [{ kind: 'discharge', reason: epicrisis.has_draft ? 'draft' : 'absent' }]
    : [];
```

and `discharge_gate: { blocked: blocking.length > 0, blocking, incomplete, epicrisis_required: epicrisisRequired },`. (`progress`, `incomplete`, `eligible`, `overdueNext` already filter by `required`; optional items never reach `overdue`.)

- [ ] **Step 5: Case overview** — `server/services/rpc/case-overview.js` return: `title_sheet: { complete: view.complete, bmi: view.bmi, sheet: view.sheet, missing: view.missing, required: view.title_required },   // INPATIENT_REQUIRED_V1`.

- [ ] **Step 6: Run — expect PASS**, then the neighbours:

`node --test --test-concurrency=4 server/services/rpc/inpatient-required-checklist.test.js server/services/rpc/title-sheet.test.js server/services/rpc/case-docs.test.js server/services/rpc/case-overview.test.js`

`node --test --test-concurrency=4 server/services/rpc/admitting-doctor.test.js server/services/rpc/case-file-save.test.js server/services/rpc/inpatient-reviews.test.js server/services/rpc/inpatient-required-gates.test.js`

`node --test --test-concurrency=4 public/js/admin/__tests__/case-docs.test.mjs public/js/admin/__tests__/case-overview.test.mjs server/i18n-server-messages.test.js`

- [ ] **Step 7: Commit**

```bash
printf '%s\n' 'Стационар: чек-лист по правилам клиники — документы «по желанию» не просрочиваются и не держат набор, титульный лист по списку полей клиники (лист, карточка, бумаги), пустые обязательные разделы названы; гейт эпикриза в чек-листе следует переключателю (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add server/services/rpc/inpatient-reviews.js server/services/rpc/title-sheet.js server/services/rpc/case-overview.js server/services/rpc/inpatient-required-checklist.test.js
git commit -F .git/INPATIENT_MSG
```

---

### Task 6: UI helper — marks, «Заполнено не всё» dialog, rules loader, field labels

**Files:**
- Create: `public/js/admin/views/required-marks.js`
- Create: `public/js/admin/__tests__/required-marks.test.mjs`
- Modify: `public/css/admin-views.css` (append a block at the end)
- Modify: `public/js/admin/i18n-strings.js`

The app has no shared confirm helper (`departments.js` keeps a private `askConfirm`, L856); the dialog here follows its markup (`.modal` / `.modal-backdrop` / `.modal-card modal-compact` / `.modal-head` / `.modal-body` / `.modal-foot`) with `zIndex: '200'` so it stands over `inpatientModal`. Never `window.confirm`. Classes are set by rewriting `className` (the test fake DOM's `classList` is a no-op — same reason as `syncSecs` in `admission-modal.js`).

- [ ] **Step 1: Write the failing test** — `public/js/admin/__tests__/required-marks.test.mjs`. Copy the fake DOM of `title-sheet.test.mjs` (L10–60) and add `removeAttribute(k) { delete this.attrs[k]; }` and `scrollIntoView() { this._scrolled = true; }` to `FakeNode`, and keep a `focus() { this._focused = true; }`. Then:

```js
const fs = await import('node:fs');
const { requiredMarks, askSaveAnyway, loadInpatientRules, titleFieldLabel, TITLE_FIELD_LABEL, TITLE_GROUP_LABEL } = await import('../views/required-marks.js');
const { TITLE_FIELD_KEYS, TITLE_GROUPS, DEFAULT_RULES } = await import('../../shared/inpatient-required.js');

function field(key, label, value = '') {
  const lbl = mkEl('label'); lbl._text = label;
  const el = mkEl('input'); el.value = value;
  const box = mkEl('span'); box.appendChild(el);
  return { key, label, el, box, labelEl: lbl, isEmpty: () => !String(el.value || '').trim() };
}

test('отметки: звезда и скрытое «обязательно», красная рамка, aria-invalid, строка сверху — и живое обновление', () => {
  const a = field('a', 'Рост', '172'); const b = field('b', 'Пульс');
  const m = requiredMarks({ fields: [a, b] });
  assert.deepEqual(m.refresh(), ['b']);
  assert.ok(a.labelEl.className.split(' ').includes('rq-req') && b.labelEl.className.split(' ').includes('rq-req'));
  assert.ok(textOf(b.labelEl).includes('обязательно'));
  assert.equal(b.el.getAttribute('aria-required'), 'true');
  assert.ok(b.box.className.split(' ').includes('rq-empty'));
  assert.equal(b.el.getAttribute('aria-invalid'), 'true');
  assert.ok(!a.box.className.split(' ').includes('rq-empty'));
  assert.notEqual(a.el.getAttribute('aria-invalid'), 'true');
  assert.ok(textOf(b.box).includes('Не заполнено'));
  assert.equal(m.summary.hidden, false);
  assert.ok(textOf(m.summary).includes('Пульс') && !textOf(m.summary).includes('Рост'));
  b.el.value = '72'; b.el.dispatchEvent({ type: 'input' });
  assert.ok(!b.box.className.split(' ').includes('rq-empty'), 'рамка снимается по мере ввода');
  assert.notEqual(b.el.getAttribute('aria-invalid'), 'true');
  assert.equal(m.summary.hidden, true);
});

test('имя в строке сверху — кнопка: прокручивает к полю и ставит в него курсор', () => {
  const b = field('b', 'Пульс');
  const m = requiredMarks({ fields: [b] });
  const btn = walk(m.summary).find((e) => e.tagName === 'BUTTON' && textOf(e).includes('Пульс'));
  btn.click();
  assert.equal(b.box._scrolled, true);
  assert.equal(b.el._focused, true);
});

test('setFields меняет список: прежние отметки снимаются', () => {
  const a = field('a', 'Рост'); const b = field('b', 'Пульс');
  const m = requiredMarks({ fields: [a] });
  m.setFields([b]);
  assert.ok(!a.labelEl.className.split(' ').includes('rq-req'));
  assert.ok(!a.box.className.split(' ').includes('rq-empty'));
  assert.deepEqual(m.missing().map((x) => x.key), ['b']);
});

test('«Заполнено не всё»: «Дописать» и «Сохранить как есть»; жёсткий запрет — только «Дописать»', async () => {
  let p = askSaveAnyway({ missing: ['Рост', 'Пульс'] });
  let dlg = BODY.children[BODY.children.length - 1];
  assert.ok(textOf(dlg).includes('Заполнено не всё') && textOf(dlg).includes('Рост, Пульс'));
  findBtn(dlg, 'Сохранить как есть').click();
  assert.equal(await p, 'save');
  p = askSaveAnyway({ missing: ['Рост'] });
  findBtn(BODY.children[BODY.children.length - 1], 'Дописать').click();
  assert.equal(await p, 'fix');
  p = askSaveAnyway({ missing: ['Приёмный врач'], hard: true });
  dlg = BODY.children[BODY.children.length - 1];
  assert.equal(findBtn(dlg, 'Сохранить как есть'), undefined, 'жёсткий запрет не предлагает сохранить');
  findBtn(dlg, 'Дописать').click();
  assert.equal(await p, 'fix');
});

test('правила: сбой сервера — сегодняшние; ответ — как прислан', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 501, json: async () => ({ error: { message: 'нет' } }), headers: { getSetCookie: () => [] } });
  assert.deepEqual(await loadInpatientRules(), DEFAULT_RULES);
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { getSetCookie: () => [] },
    json: async () => ({ data: { settings: { intake_before_attending: 0, title_required_fields: ['phone'] }, docs: [] } }) });
  const r = await loadInpatientRules();
  assert.equal(r.intakeBeforeAttending, false);
  assert.deepEqual(r.titleFields, ['phone']);
});

test('подписи: у каждого поля листа и каждой группы есть подпись', () => {
  for (const k of TITLE_FIELD_KEYS) assert.ok(TITLE_FIELD_LABEL[k], k);
  for (const g of TITLE_GROUPS) assert.ok(TITLE_GROUP_LABEL[g], g);
  assert.equal(titleFieldLabel('height_cm'), 'Рост');
});

test('печать отметок не видит', () => {
  const css = fs.readFileSync(new URL('../../../css/admin-views.css', import.meta.url), 'utf8');
  const print = css.slice(css.indexOf('INPATIENT_REQUIRED_V1'));
  assert.match(print, /@media print\s*\{[^}]*\.rq-summary[^}]*display:\s*none/);
  assert.match(print, /@media print[\s\S]*\.rq-req::after[\s\S]*content:\s*none/);
  assert.match(print, /@media print[\s\S]*\.rq-empty[\s\S]*box-shadow:\s*none/);
});
```

(`walk`, `textOf`, `findBtn` as in `title-sheet.test.mjs`.)

- [ ] **Step 2: Run — expect FAIL:** `node --test public/js/admin/__tests__/required-marks.test.mjs`

- [ ] **Step 3: Create `public/js/admin/views/required-marks.js`:**

```js
// INPATIENT_REQUIRED_V1 (2026-11-23) — ОТМЕТКИ ОБЯЗАТЕЛЬНЫХ ПОЛЕЙ И «СОХРАНИТЬ КАК ЕСТЬ».
//
// Владелец: «in the required fields of the title and other user cannot understand
// which fields he is not filled, cn we add visual cues for that?»
//
// Один помощник на все формы стационара: окно размещения, титульный лист в истории
// болезни, каждый документ истории болезни, выбор лечащего и приёмного врача.
// Обязательная подпись — красная звезда (только экран, CSS) и скрытое «обязательно»
// для читалки; пустое обязательное поле — красная рамка, aria-invalid и «Не заполнено»;
// сверху формы — строка «Не заполнено: …», каждое имя ведёт к своему полю.
// Отметки — только экран: @media print их прячет, печатный HTML их не получает.
//
// Модуль не импортирует ни одного экрана (NO_IMPORT_CYCLES_V1).
import { supabase } from '../../supabase.js';
import { h, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { rulesFromSettings, DEFAULT_RULES } from '../../shared/inpatient-required.js';

/** Подписи полей титульного листа — как на самом листе. */
export const TITLE_FIELD_LABEL = Object.freeze({
    gender: 'Пол', phone: 'Телефон', address: 'Постоянный адрес', national_id: 'Паспорт / ID',
    occupation: 'Место работы, профессия, должность', emergency_contact_name: 'Близкий родственник',
    emergency_contact_phone: 'Телефон родственника', blood_type: 'Группа крови и резус', allergies: 'Аллергия на лекарства',
    referred_from: 'Кем направлен', delivered_by: 'Каким транспортом', mobility: 'Как доставляют по отделению',
    since_onset: 'Сколько прошло от начала болезни',
    height_cm: 'Рост', weight_kg: 'Вес', temp_c: 'Температура', bp_sys: 'АД верхнее', bp_dia: 'АД нижнее', pulse_bpm: 'Пульс',
    pediculosis: 'Осмотр на педикулёз и чесотку', sanitation: 'Санитарная обработка',
    contract_signed: 'Договор на госпитализацию', consent_signed: 'Информированное согласие', memo_given: 'Памятка стационара',
});
export const TITLE_GROUP_LABEL = Object.freeze({
    patient: 'Пациент', admission: 'Поступление', measures: 'Измерения', exam: 'Осмотр медсестры', papers: 'Документы при поступлении',
});
export function titleFieldLabel(key) { return tr(TITLE_FIELD_LABEL[key] || key); }

/** Правила стационара для экрана. Сбой, старый сервер, нет права — сегодняшние правила. */
export async function loadInpatientRules() {
    try {
        const { data, error } = await supabase.rpc('inpatient_settings_get', {});
        if (error || !data) return DEFAULT_RULES;
        return rulesFromSettings(data);
    } catch (e) { return DEFAULT_RULES; }
}

function setClass(el, name, on) {
    if (!el) return;
    const parts = String(el.className || '').split(/\s+/).filter((c) => c && c !== name);
    if (on) parts.push(name);
    el.className = parts.join(' ');
}
const isControl = (el) => !!el && /^(INPUT|SELECT|TEXTAREA)$/.test(String(el.tagName || ''));

/**
 * Отметки формы.
 * @param {{fields: Array<{key:string, label:string, el?:Element, box?:Element, labelEl?:Element,
 *          watch?:Element[], isEmpty:() => boolean}>}} opts
 *   el — поле (фокус, aria-*); box — рамка («Не заполнено» ложится внутрь неё);
 *   labelEl — подпись (звезда); watch — ещё элементы, чьи input/change пересчитывают
 *   отметки (радиокнопки группы).
 */
export function requiredMarks({ fields = [] } = {}) {
    let list = [];
    const summary = h('div', { class: 'rq-summary no-print', role: 'alert' });
    summary.hidden = true;
    const msgs = new Map();

    function focusField(f) {
        const box = f.box || f.el;
        if (box && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (f.el && typeof f.el.focus === 'function') f.el.focus();
    }
    // Подпись раздела переименовывают (textContent) — скрытое «обязательно» возвращается.
    function ensureSr(f) {
        if (!f.labelEl) return;
        if (!f._sr) f._sr = h('span', { class: 'rq-sr' }, tr('обязательно'));
        if (!Array.prototype.includes.call(f.labelEl.children || [], f._sr)) f.labelEl.appendChild(f._sr);
    }
    function refresh() {
        const missing = [];
        for (const f of list) {
            const empty = !!f.isEmpty();
            setClass(f.box, 'rq-empty', empty);
            if (f.el && f.el.setAttribute) {
                if (empty) f.el.setAttribute('aria-invalid', 'true');
                else if (typeof f.el.removeAttribute === 'function') f.el.removeAttribute('aria-invalid');
                else f.el.setAttribute('aria-invalid', 'false');
            }
            let msg = msgs.get(f);
            if (!msg && f.box && !isControl(f.box)) {
                msg = h('span', { class: 'rq-msg no-print' }, tr('Не заполнено'));
                f.box.appendChild(msg);
                msgs.set(f, msg);
            }
            if (msg) msg.hidden = !empty;
            ensureSr(f);
            if (empty) missing.push(f);
        }
        clear(summary);
        summary.hidden = missing.length === 0;
        if (missing.length) {
            summary.appendChild(h('span', { class: 'rq-summary-t' }, tr('Не заполнено:')));
            missing.forEach((f, i) => {
                if (i) summary.appendChild(h('span', null, ', '));
                summary.appendChild(h('button', { class: 'rq-jump', type: 'button', onclick: () => focusField(f) }, f.label));
            });
        }
        return missing.map((f) => f.key);
    }
    const onChange = () => refresh();
    function setFields(next) {
        for (const f of list) {
            setClass(f.box, 'rq-empty', false);
            setClass(f.labelEl, 'rq-req', false);
            if (f.el && typeof f.el.removeAttribute === 'function') { f.el.removeAttribute('aria-required'); f.el.removeAttribute('aria-invalid'); }
            const msg = msgs.get(f); if (msg) msg.hidden = true;
            // Только если ещё на месте: настоящий DOM бросает, когда узла среди детей нет.
            if (f._sr && f.labelEl && Array.prototype.includes.call(f.labelEl.children || [], f._sr)) f.labelEl.removeChild(f._sr);
        }
        list = (next || []).filter(Boolean);
        for (const f of list) {
            setClass(f.labelEl, 'rq-req', true);
            if (f.el && f.el.setAttribute) f.el.setAttribute('aria-required', 'true');
            for (const w of [f.el, ...(f.watch || [])]) {
                if (!w || typeof w.addEventListener !== 'function' || w._rqBound) continue;
                w._rqBound = true;
                w.addEventListener('input', onChange);
                w.addEventListener('change', onChange);
            }
        }
        return refresh();
    }
    setFields(fields);
    return {
        summary, refresh, setFields,
        missing: () => list.filter((f) => f.isEmpty()).map((f) => ({ key: f.key, label: f.label })),
        focusFirst: () => { const f = list.find((x) => x.isEmpty()); if (f) focusField(f); },
    };
}

/**
 * «Заполнено не всё». Мягкий случай — «Дописать» / «Сохранить как есть»;
 * жёсткий (переключатель клиники включён) — только «Дописать».
 * @returns {Promise<'save'|'fix'>}
 */
export function askSaveAnyway({ missing = [], hard = false } = {}) {
    return new Promise((resolve) => {
        const overlay = h('div', { class: 'modal', style: { zIndex: '200' } });
        const done = (v) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(v); };
        const onKey = (ev) => { if (ev && ev.key === 'Escape') done('fix'); };
        document.addEventListener('keydown', onKey);
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => done('fix') }));
        overlay.appendChild(h('div', { class: 'modal-card modal-compact', role: 'alertdialog', 'aria-modal': 'true', style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' }, h('h2', null, tr('Заполнено не всё')),
                h('button', { class: 'modal-close', type: 'button', 'aria-label': tr('Закрыть'), onclick: () => done('fix') }, '×')),
            h('div', { class: 'modal-body' },
                h('p', { style: { margin: 0 } }, trf('Не заполнено: {list}', { list: missing.join(', ') })),
                hard ? h('p', { class: 'muted', style: { margin: '8px 0 0' } }, tr('Без этого сохранить нельзя — так настроено в клинике.')) : null),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),
                hard ? null : h('button', { class: 'btn', type: 'button', onclick: () => done('save') }, tr('Сохранить как есть')),
                h('button', { class: 'btn btn-primary', type: 'button', onclick: () => done('fix') }, tr('Дописать')))));
        document.body.appendChild(overlay);
    });
}
```

- [ ] **Step 4: CSS** — append to `public/css/admin-views.css`:

```css
/* INPATIENT_REQUIRED_V1 — отметки обязательных полей (views/required-marks.js). Только экран. */
.rq-req::after { content: " *"; content: " *" / ""; color: var(--crit-500); font-weight: 700; }
.rq-sr { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.rq-empty { box-shadow: 0 0 0 2px var(--crit-500); background: var(--crit-50); border-radius: 6px; }
.rq-msg { display: block; margin-top: 3px; font-size: 11.5px; font-weight: 600; color: var(--crit-700); }
.f3 .rq-empty { position: relative; }
.f3 .rq-msg { position: absolute; left: 0; top: 100%; margin-top: 1px; font-size: 10px; white-space: nowrap; }   /* бланк 003 держится одной страницы — подпись не добавляет высоты */
.rq-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 8px 12px; margin: 0 0 10px; border-radius: 10px; background: var(--crit-50); color: var(--crit-700); font-size: 13px; }
.rq-summary[hidden] { display: none; }
.rq-summary-t { font-weight: 700; }
.rq-jump { border: 0; background: none; padding: 0; font: inherit; color: inherit; text-decoration: underline; cursor: pointer; }
.rq-jump:focus-visible { outline: 2px solid var(--crit-500); outline-offset: 2px; border-radius: 3px; }
@media print { .rq-summary, .rq-msg, .rq-sr { display: none !important; } .rq-req::after { content: none !important; } .rq-empty { box-shadow: none !important; background: none !important; } }
```

- [ ] **Step 5: Dictionary** — ru/uz/en for: `Не заполнено`, `Не заполнено:`, `Не заполнено: {list}`, `обязательно`, `Заполнено не всё`, `Сохранить как есть`, `Без этого сохранить нельзя — так настроено в клинике.`, and every value of `TITLE_FIELD_LABEL` / `TITLE_GROUP_LABEL` not yet in the dictionary (check each with grep; `Дописать`, `Закрыть`, `Пол`, `Телефон`, `Пульс`, `Температура`, `Договор на госпитализацию` already exist).

- [ ] **Step 6: Run — expect PASS:**

`node --test --test-concurrency=4 public/js/admin/__tests__/required-marks.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs`

- [ ] **Step 7: Commit**

```bash
printf '%s\n' 'Стационар: отметки обязательных полей (звезда, красная рамка, «Не заполнено», строка с переходом к полю), окно «Заполнено не всё» с «Сохранить как есть», правила стационара для экранов; печать отметок не видит (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add public/js/admin/views/required-marks.js public/js/admin/__tests__/required-marks.test.mjs public/css/admin-views.css public/js/admin/i18n-strings.js
git commit -F .git/INPATIENT_MSG
```

---

### Task 7: Title sheet screen — marks, admitting-doctor switch, «Сохранить как есть»

**Files:**
- Modify: `public/js/admin/views/title-sheet.js` (`titleSheetForm` L55–283, `openAdmissionTitleSheetModal` L297–367, `buildTitleSheetEditor` L381–431)
- Modify: `public/js/admin/views/case-workspace.js` (`load()` L102 — rules; `paintPane` ~L583 — pass rules; card ~L630 — `ed.topNote`)
- Modify tests: `public/js/admin/__tests__/title-sheet.test.mjs`, `admissions-window.test.mjs` (~L310, ~L334), `inpatient-route.test.mjs` (~L700), `inpatient-section.test.mjs` (~L517, 561, 595, 626)
- Modify: `public/js/admin/i18n-strings.js`

Behaviour:
- `titleSheetForm()` additionally returns `controls`: an object with an entry for **every** `TITLE_FIELD_KEYS` key → `{ el, box, labelEl, watch }`. How to build it: give each `ctl(el)` wrapper a key (`ctlK(key, el, cls)` records `controls[key] = { el, box }`), keep the `ru('…')` hint of each field in `lbl[key]` (`ruL(key, text)`), and after the rows are built set `controls[k].labelEl = lbl[k]`. Radios (`pediculosis`, `sanitation`, `mobility`): `el` = first radio of the group, `box` = the group `div`, `watch` = all radios of the group (`radioEls.filter((r) => r._tsKey === key)`). Blood pressure: wrap each input in its own `h('span', { class: 'ts-bp-one' }, input)` inside the `f3-ctl ts-bp` span and use those spans as `box` for `bp_sys` / `bp_dia` (one shared label `АД, мм рт. ст.`). Papers: in `paperRow`, record `controls[flag] = { el: cb, box: <the .ts-paper div>, labelEl: <the .ts-paper-name span>, watch: [] }`.
- A local helper builds marks entries: `isEmpty: () => missingTitleFields(form.read(), [key]).length > 0`, `label: titleFieldLabel(key)`. Required keys = `titleKeysOf(rules)` (shared).
- **Placement window** (`openAdmissionTitleSheetModal`): `let rules = DEFAULT_RULES;` then `loadInpatientRules().then((r) => { rules = r; applyMarks(); })`. The marks `summary` is the first body element after the patient anchor. «Приёмный врач» field: `field(tr('Приёмный врач'), docSel)` **without** `{ required: true }`; when `rules.admittingAtPlacement` it joins the marks as `{ key: 'admitting_doctor', label: tr('Приёмный врач'), el: docSel, box: admittingField, labelEl: <the field's label = its first child>, isEmpty: () => doctors.length > 0 && !docSel.value }`. After `form.fill(...)` and after the doctor list arrives call `marks.refresh()`.
- «Положить»: if `rules.admittingAtPlacement && doctors.length && !docSel.value` → `await askSaveAnyway({ missing: <labels of every missing mark>, hard: true }); marks.focusFirst(); return false;`. Else if any missing → `const ans = await askSaveAnyway({ missing: labels }); if (ans !== 'save') { marks.focusFirst(); return false; }`. Then `admission_admit` as today. The final toast uses `sheetCompleteness(data.title_sheet, titleKeysOf(rules), form.read().patient).complete`.
- **Editor** (`buildTitleSheetEditor({ admission, onDone, rules = DEFAULT_RULES })`): marks built at once from `rules`, `marks.refresh()` after each `form.fill`. Returns `topNote: marks.summary`. `submit`: missing → `askSaveAnyway({ missing })`; `'fix'` → `focusFirst`, `return false`; `'save'` → save as today. The status line, when incomplete, names the fields: `trf('Лист заполнен не до конца: {list}.', { list: (view.missing || []).map(titleFieldLabel).join(', ') })`.
- `case-workspace.js`: `load()` adds `loadInpatientRules()` to its `Promise.all` and stores `state.rules`; `paintPane` passes `rules: state.rules || DEFAULT_RULES` to `buildTitleSheetEditor` (and to `buildReviewEditor` — used in Task 8); the card renders `ed.topNote || null` right after the `.a4-toolbar-slot` div.

- [ ] **Step 1: Write the failing tests** — in `title-sheet.test.mjs` extend the fake server: a mutable `let SETTINGS = null;` — `inpatient_settings_get` returns `ok(SETTINGS)` when set, otherwise `fail('нет')`; `admission_attending_candidates` returns `ok({ doctors: DOCTORS })` with `let DOCTORS = [];`. Add:

```js
test('INPATIENT_REQUIRED_V1: форма отдаёт поле, рамку и подпись для КАЖДОГО поля, которое клиника может требовать', async () => {
    const { titleSheetForm } = await import('../views/title-sheet.js');
    const { TITLE_FIELD_KEYS } = await import('../../shared/inpatient-required.js');
    const form = titleSheetForm({ bed: { id: 6, code: 'T-2' } });
    for (const k of TITLE_FIELD_KEYS) {
        assert.ok(form.controls[k] && form.controls[k].el && form.controls[k].box, 'нет поля ' + k);
        assert.ok(form.controls[k].labelEl, 'нет подписи ' + k);
    }
});

test('INPATIENT_REQUIRED_V1: окно размещения — отметки по списку клиники, «Дописать» не кладёт, «Сохранить как есть» кладёт', async () => {
    const { openAdmissionTitleSheetModal } = await import('../views/title-sheet.js');
    SETTINGS = { settings: { admitting_at_placement: 0, title_required_fields: ['height_cm', 'pulse_bpm'] }, docs: [] };
    DOCTORS = [{ id: 77, full_name: 'Сотрудник doc77' }, { id: 78, full_name: 'Сотрудник doc78' }];
    rpcCalls.length = 0;
    openAdmissionTitleSheetModal({ admission: { id: 11, status: 'ordered', patients: { full_name: 'Тестов Пациент' } }, bed: { id: 6, code: 'T-2' } });
    await settle();
    const sheet = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(sheet).includes('Не заполнено:'));
    findBtn(sheet, 'Положить').click();
    await settle();
    let dlg = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(dlg).includes('Заполнено не всё') && textOf(dlg).includes('Рост') && textOf(dlg).includes('Пульс'));
    findBtn(dlg, 'Дописать').click();
    await settle();
    assert.ok(!rpcCalls.some((c) => c.name === 'admission_admit'), '«Дописать» не кладёт');
    findBtn(sheet, 'Положить').click();
    await settle();
    findBtn(BODY.children[BODY.children.length - 1], 'Сохранить как есть').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'admission_admit');
    assert.ok(call, '«Сохранить как есть» кладёт');
    assert.equal(call.args.admitting_doctor_id, null, 'переключатель выключен — без приёмного врача можно');
    SETTINGS = null; DOCTORS = [];
});

test('INPATIENT_REQUIRED_V1: приёмный врач обязателен (умолчание) — окно без «Сохранить как есть»', async () => {
    const { openAdmissionTitleSheetModal } = await import('../views/title-sheet.js');
    DOCTORS = [{ id: 77, full_name: 'Сотрудник doc77' }, { id: 78, full_name: 'Сотрудник doc78' }];
    rpcCalls.length = 0;
    openAdmissionTitleSheetModal({ admission: { id: 11, status: 'ordered', patients: {} }, bed: { id: 6, code: 'T-2' } });
    await settle();
    const sheet = BODY.children[BODY.children.length - 1];
    findBtn(sheet, 'Положить').click();
    await settle();
    const dlg = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(dlg).includes('Приёмный врач'));
    assert.equal(findBtn(dlg, 'Сохранить как есть'), undefined);
    findBtn(dlg, 'Дописать').click();
    await settle();
    assert.ok(!rpcCalls.some((c) => c.name === 'admission_admit'));
    DOCTORS = [];
});

test('INPATIENT_REQUIRED_V1: отметки живые — заполнили рост, и он ушёл из строки «Не заполнено»', async () => {
    const { buildTitleSheetEditor } = await import('../views/title-sheet.js');
    const ed = buildTitleSheetEditor({ admission: { id: 11 } });
    await settle();
    assert.ok(textOf(ed.topNote).includes('Рост'));
    const root = mkEl('div'); for (const f of ed.fields) root.appendChild(f);
    const height = byPlaceholder(root, 'см');
    height.value = '172'; height.dispatchEvent({ type: 'input' });
    assert.ok(!textOf(ed.topNote).includes('Рост'));
});

test('INPATIENT_REQUIRED_V1: редактор — «Сохранить» с пустыми полями спрашивает; «Сохранить как есть» сохраняет', async () => {
    const { buildTitleSheetEditor } = await import('../views/title-sheet.js');
    rpcCalls.length = 0;
    const ed = buildTitleSheetEditor({ admission: { id: 11 } });
    await settle();
    const p = ed.submit();
    await settle();
    findBtn(BODY.children[BODY.children.length - 1], 'Сохранить как есть').click();
    assert.equal(await p, true);
    assert.ok(rpcCalls.some((c) => c.name === 'admission_title_sheet_save'));
});
```

Update the four existing «Положить» tests (title-sheet L187, admissions-window ~L310/L334, inpatient-route ~L700, inpatient-section ~L517/561/595/626): right after the existing «Положить» click + settle, add a step that finds the top overlay and, when it contains «Заполнено не всё», clicks «Сохранить как есть» and settles again — e.g. in each file a helper

```js
// INPATIENT_REQUIRED_V1 — пустой лист спрашивает «Сохранить как есть»; эти проверки — про размещение.
async function saveAnyway() {
    const top = BODY.children[BODY.children.length - 1];
    if (textOf(top).includes('Заполнено не всё')) { findBtn(top, 'Сохранить как есть').click(); await settle(); }
}
```

(use each file's own names for `BODY`/`textOf`/`findBtn`/`settle`/`topOverlay`). If a test there mocks exactly one doctor, the doctor is auto-picked and no hard dialog appears; if it mocks two, pick one in the select before «Положить» or expect the hard dialog — read the test before editing.

- [ ] **Step 2: Run — expect FAIL:** `node --test public/js/admin/__tests__/title-sheet.test.mjs`

- [ ] **Step 3: Implement** the behaviour above in `title-sheet.js` and `case-workspace.js` (imports: `requiredMarks, askSaveAnyway, loadInpatientRules, titleFieldLabel` from `./required-marks.js`; `DEFAULT_RULES, titleKeysOf, missingTitleFields` from `../../shared/inpatient-required.js`).

- [ ] **Step 4: Dictionary** — `Лист заполнен не до конца: {list}.` (and any other new string you used).

- [ ] **Step 5: Run — expect PASS:**

`node --test --test-concurrency=4 public/js/admin/__tests__/title-sheet.test.mjs public/js/admin/__tests__/admissions-window.test.mjs public/js/admin/__tests__/inpatient-route.test.mjs public/js/admin/__tests__/inpatient-section.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/case-file-tabs.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/required-marks.test.mjs`

- [ ] **Step 6: Commit**

```bash
printf '%s\n' 'Стационар: титульный лист — красные отметки обязательных полей по списку клиники, строка «Не заполнено» с переходом к полю, «Сохранить как есть» при размещении и в истории болезни; приёмный врач обязателен только при включённом переключателе (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add public/js/admin/views/title-sheet.js public/js/admin/views/case-workspace.js public/js/admin/__tests__/title-sheet.test.mjs public/js/admin/__tests__/admissions-window.test.mjs public/js/admin/__tests__/inpatient-route.test.mjs public/js/admin/__tests__/inpatient-section.test.mjs public/js/admin/i18n-strings.js
git commit -F .git/INPATIENT_MSG
```

---

### Task 8: Case-document editor — required sections, «Сохранить как есть», diagnosis switch

**Files:**
- Modify: `public/js/admin/views/case-doc-a4.js` (`richSection` returns `{ sec, input, tag }`, ~L233–320)
- Modify: `public/js/admin/views/admission-modal.js` (`buildReviewEditor` L903–1395, `openAdmissionReviewModal` L1398–1418)
- Modify: `public/js/admin/views/case-workspace.js` (`paintPane` passes `rules: state.rules || DEFAULT_RULES` to `buildReviewEditor` — if not already done in Task 7)
- Create: `public/js/admin/__tests__/inpatient-required-editor.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

Behaviour of `buildReviewEditor({ …, rules = DEFAULT_RULES })`:
- `reqSecs = isView ? [] : requiredSectionsOf(rules, kind).filter((k) => secKeys.includes(k))`. Rich required keys (`complaints`, `objective`, `plan`, `body`) are added to `secOn` before the first `syncSecs()`, and **again** at the end of `fill()` (a saved layout must not fold a required section); their `richSection(…, { onRemove })` gets `onRemove: null` (cannot be removed). Keep `madeTags[key] = made.tag`.
- Hard diagnosis: `const dxHard = isPrimary && rules.primaryNeedsDiagnosis && !isView;`. Marks list = required sections (rich: `el: rich[key]`, `box: madeSecs[key]`, `labelEl: madeTags[key]`, `isEmpty: () => !readRich(rich[key])`; diagnosis: `el: diagnosis`, no `box`, `isEmpty: () => !String(diagnosis.value || '').trim()`), plus a diagnosis entry when `dxHard` and `'diagnosis'` is not already in `reqSecs`. Labels: `tr(sectionLabel(kind, key))`, or `secTitles[key]` when the section was renamed.
- `marks.refresh()` after `fill(src)`, after the clinic blank is applied, and after a template is inserted.
- Returned object: `topNote: marks.summary`, `diagnosisRequired: dxHard` (was `isPrimary`).
- `submit`: replaces `if (isPrimary && !diagnosis.value.trim()) { toast(…); return false; }` with:

```js
        // INPATIENT_REQUIRED_V1 — пустые обязательные разделы: спрашиваем «Сохранить как
        // есть». Диагноз первичного осмотра при включённом переключателе — жёсткий запрет.
        const missing = marks.missing();
        if (missing.length) {
            const hard = dxHard && missing.some((m) => m.key === 'diagnosis');
            const ans = await askSaveAnyway({ missing: missing.map((m) => m.label), hard });
            if (hard || ans !== 'save') { marks.focusFirst(); return false; }
        }
```

  The draft (`secondary`) never asks.
- The «Заявку на выписку принимают только по ОПУБЛИКОВАННОМУ эпикризу…» hint shows only when `isDischarge && rules.dischargeNeedsEpicrisis`.
- `openAdmissionReviewModal` becomes `async`: `const rules = opts.rules || await loadInpatientRules(); const ed = buildReviewEditor(Object.assign({}, opts, { rules }));` and puts `ed.topNote` first in the modal body (before `ed.patientCard`).

- [ ] **Step 1: Write the failing test** — `public/js/admin/__tests__/inpatient-required-editor.test.mjs` (fake DOM from `title-sheet.test.mjs`; fake server answering `admission_reviews_list` with `ok({ reviews: [] })`, `admission_review_save` recording `args` and answering `ok({ review: { id: 9 }, admission: { id: 7, status: 'admitted' } })`):

```js
const { buildReviewEditor } = await import('../views/admission-modal.js');
const { rulesFromSettings } = await import('../../shared/inpatient-required.js');
const ADM = { id: 7, patients: { full_name: 'Тестов Пациент' } };
const rules = (settings, docs = []) => rulesFromSettings({ settings, docs });
const secOf = (ed, key) => walk({ children: ed.fields.filter(Boolean) }).find((e) => e.attrs && e.attrs['data-sec'] === key);
const inputOf = (ed, key) => walk({ children: ed.fields.filter(Boolean) }).find((e) => e.attrs && e.attrs['data-field'] === key);

test('обязательный раздел открыт, отмечен, не убирается; строка сверху его называет', async () => {
    const ed = buildReviewEditor({ admission: ADM, kind: 'intake', rules: rules({}, [{ kind: 'intake', required_sections: ['complaints'] }]) });
    await settle();
    const sec = secOf(ed, 'complaints');
    assert.ok(!sec.className.split(' ').includes('a4-sec-off'), 'обязательный раздел свёрнут');
    assert.ok(sec.className.split(' ').includes('rq-empty'));
    assert.ok(!walk(sec).some((e) => e.tagName === 'BUTTON' && (e.attrs['aria-label'] || '') === 'Убрать раздел'), 'обязательный раздел можно убрать');
    assert.ok(textOf(ed.topNote).includes('Жалобы'));
    const inp = inputOf(ed, 'complaints');
    inp.innerHTML = '<p>кашель</p>'; inp.dispatchEvent({ type: 'input' });
    assert.ok(!sec.className.split(' ').includes('rq-empty'));
});

test('«Опубликовать» с пустым обязательным разделом спрашивает; «Дописать» — не публикует; «Сохранить как есть» — публикует; черновик не спрашивает', async () => {
    const ed = buildReviewEditor({ admission: ADM, kind: 'intake', rules: rules({}, [{ kind: 'intake', required_sections: ['complaints'] }]) });
    await settle();
    rpcCalls.length = 0;
    let p = ed.submit(); await settle();
    findBtn(BODY.children[BODY.children.length - 1], 'Дописать').click();
    assert.equal(await p, false);
    assert.ok(!rpcCalls.some((c) => c.name === 'admission_review_save'));
    p = ed.submit(); await settle();
    findBtn(BODY.children[BODY.children.length - 1], 'Сохранить как есть').click();
    assert.equal(await p, true);
    assert.equal(rpcCalls.find((c) => c.name === 'admission_review_save').args.publish, true);
    rpcCalls.length = 0;
    const before = BODY.children.length;
    await ed.secondary(); await settle();
    assert.equal(BODY.children.length, before, 'черновик открыл окно');
    assert.equal(rpcCalls.find((c) => c.name === 'admission_review_save').args.publish, false);
});

test('первичный осмотр: диагноз обязателен (умолчание) — жёсткий запрет; переключатель выключен — публикуется без диагноза', async () => {
    let ed = buildReviewEditor({ admission: ADM, kind: 'primary', rules: rules({}) });
    await settle();
    assert.equal(ed.diagnosisRequired, true);
    const p = ed.submit(); await settle();
    const dlg = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(dlg).includes('Диагноз'));
    assert.equal(findBtn(dlg, 'Сохранить как есть'), undefined);
    findBtn(dlg, 'Дописать').click();
    assert.equal(await p, false);
    ed = buildReviewEditor({ admission: ADM, kind: 'primary', rules: rules({ primary_needs_diagnosis: 0 }) });
    await settle();
    assert.equal(ed.diagnosisRequired, false);
    rpcCalls.length = 0;
    assert.equal(await ed.submit(), true);
    assert.ok(rpcCalls.some((c) => c.name === 'admission_review_save'));
});

test('выписной эпикриз: подсказка «только по опубликованному» — только когда переключатель включён', async () => {
    const on = buildReviewEditor({ admission: ADM, kind: 'discharge', rules: rules({}) });
    const off = buildReviewEditor({ admission: ADM, kind: 'discharge', rules: rules({ discharge_needs_epicrisis: 0 }) });
    const txt = (ed) => ed.fields.filter(Boolean).map(textOf).join(' ');
    assert.ok(txt(on).includes('ОПУБЛИКОВАННОМУ'));
    assert.ok(!txt(off).includes('ОПУБЛИКОВАННОМУ'));
});
```

(If `submit()` after publish opens the attending modal, the fake server's `admission.status: 'admitted'` keeps it closed.)

- [ ] **Step 2: Run — expect FAIL:** `node --test public/js/admin/__tests__/inpatient-required-editor.test.mjs`

- [ ] **Step 3: Implement** — `richSection` returns `{ sec, input, tag }`; then `buildReviewEditor` / `openAdmissionReviewModal` as described (imports: `requiredMarks, askSaveAnyway, loadInpatientRules` from `./required-marks.js`; `DEFAULT_RULES, requiredSectionsOf` from `../../shared/inpatient-required.js`).

- [ ] **Step 4: Run — expect PASS:**

`node --test --test-concurrency=4 public/js/admin/__tests__/inpatient-required-editor.test.mjs public/js/admin/__tests__/case-doc-a4.test.mjs public/js/admin/__tests__/act-as-sign-lab-inpatient.test.mjs public/js/admin/__tests__/admissions-window.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/case-file-tabs.test.mjs public/js/admin/__tests__/case-docs.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs`

- [ ] **Step 5: Commit**

```bash
printf '%s\n' 'Стационар: документы истории болезни — обязательные разделы открыты и отмечены, «Опубликовать» с пустым разделом спрашивает «Сохранить как есть» (черновик — никогда), диагноз первичного осмотра и подсказка эпикриза следуют переключателям (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add public/js/admin/views/case-doc-a4.js public/js/admin/views/admission-modal.js public/js/admin/views/case-workspace.js public/js/admin/__tests__/inpatient-required-editor.test.mjs public/js/admin/i18n-strings.js
git commit -F .git/INPATIENT_MSG
```

---

### Task 9: Treating doctor from «на койке» in the lists; attending picker marks

**Files:**
- Modify: `public/js/admin/views/admissions.js` (`WARD_GROUPS` L333–338 and every `g.pick(` call; `inpatient_capabilities` read ~L155; `actionCell` ~L421)
- Modify: `public/js/admin/views/consultation.js` (`loadInpatientCaps` ~L955; row actions ~L1069–1087; `waitingOf` ~L1128)
- Modify: `public/js/admin/views/doctor-dashboard.js` (`loadWardHead` ~L144–165)
- Modify: `public/js/admin/views/admission-modal.js` (`openAdmissionAttendingModal` ~L1448–1505)
- Modify tests: `public/js/admin/__tests__/inpatient-section.test.mjs` or `admissions-window.test.mjs` (add cases), `inpatient-notifications.test.mjs` only if it breaks

The admission card (`openAdmissionCard`) needs no change — `admission_flow_state.can.active` already comes from the server (Task 4). The case overview head already offers «Назначить» whenever there is no treating doctor.

Behaviour:
- Each screen reads `withoutExam = !!(data && data.required && data.required.intake_before_attending === false)` from the `inpatient_capabilities` answer it already loads (consultation: `state.inpt.withoutExam`; admissions: a local beside `can`; doctor-dashboard: a local in `loadWardHead`).
- `admissions.js`: `WARD_GROUPS` `attending` → `pick: (r, ctx) => waitsForAttending(r, ctx && ctx.withoutExam)`; pass `{ withoutExam }` at every `pick(` call (find them: `grep -n "\.pick(" public/js/admin/views/admissions.js`). `actionCell(a)`: first branch `if (a.status === 'admitted' && withoutExam && (can.set_attending || isAdmitting(a)))` → the existing «Назначить лечащего врача» button (`openAdmissionAttendingModal({ admission: a, onDone: reload })`); otherwise today's `admitted` branch.
- `consultation.js`: same first branch in the row actions (`state.inpt.can.set_attending || mine`); `waitingOf`: `if (r.status === 'admitted') return mine || !!can.examine || (state.inpt.withoutExam && !!can.set_attending);`.
- `doctor-dashboard.js`: `ward.attending = rows.filter((r) => waitsForAttending(r, withoutExam)).length;`.
- Attending picker (`openAdmissionAttendingModal`): `field(tr('Лечащий врач'), sel)` without `{ required: true }`; marks `requiredMarks({ fields: [{ key: 'attending', label: tr('Лечащий врач'), el: sel, box: <the field div>, labelEl: <its label>, isEmpty: () => !sel.value }] })` with `marks.summary` first in the body; on «Назначить» with nothing picked → `await askSaveAnyway({ missing: [tr('Лечащий врач')], hard: true }); marks.focusFirst(); return false;` (replaces the `toast(tr('Выберите врача.'))` line; the `refusal` toast stays).

- [ ] **Step 1: Write failing tests.** In `inpatient-section.test.mjs` (or `admissions-window.test.mjs` — whichever mocks `inpatient_capabilities` for the «Стационар» table; read it first) add: the capabilities mock returns `{ can: { set_attending: true, examine: true }, required: { intake_before_attending: false } }` and one admission `status: 'admitted'` → the row offers «Назначить лечащего врача», and the «Ждут лечащего врача» tile counts it; with `required` absent → the row offers «Провести первичный осмотр» and the tile shows 0 (today). Add a test for `openAdmissionAttendingModal`: click «Назначить» with no doctor → dialog «Заполнено не всё» naming «Лечащий врач», no «Сохранить как есть», `admission_set_attending` not called. For consultation, add to the consultation inpatient test that `waitingOf([{ status: 'admitted', admitting_doctor_id: null }])` is `1` when `state.inpt.withoutExam` and `can.set_attending` — find how existing tests drive `waitingOf` (`grep -rn "waitingOf" public/js/admin/__tests__`); if none, assert on the rendered row instead.

- [ ] **Step 2: Run — expect FAIL** (the files you changed).

- [ ] **Step 3: Implement** (import `waitsForAttending` from `../../shared/inpatient-required.js`; `requiredMarks, askSaveAnyway` from `./required-marks.js` in `admission-modal.js`).

- [ ] **Step 4: Run — expect PASS:**

`node --test --test-concurrency=4 public/js/admin/__tests__/inpatient-section.test.mjs public/js/admin/__tests__/admissions-window.test.mjs public/js/admin/__tests__/inpatient-route.test.mjs public/js/admin/__tests__/inpatient-notifications.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs` plus any `consultation*` / `doctor-dashboard*` test touching the inpatient tab (`ls public/js/admin/__tests__ | grep -iE "consultation|doctor-dash|cabinet-inp"`).

- [ ] **Step 5: Commit**

```bash
printf '%s\n' 'Стационар: без обязательного осмотра «Назначить лечащего врача» — прямо у пациента на койке (стационар, кабинет врача, «Ждут лечащего врача»); окно лечащего врача отмечает пустой выбор (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add public/js/admin/views/admissions.js public/js/admin/views/consultation.js public/js/admin/views/doctor-dashboard.js public/js/admin/views/admission-modal.js public/js/admin/__tests__/inpatient-section.test.mjs public/js/admin/i18n-strings.js
# плюс каждый файл проверок, который вы правили в шаге 1 (admissions-window.test.mjs, тест кабинета врача) — по имени, не `git add -A`
git commit -F .git/INPATIENT_MSG
```

---

### Task 10: Checklist rows and case overview say what is missing

**Files:**
- Modify: `public/js/admin/views/case-docs.js` (`itemRow` L427+, `caseGateText` L169)
- Modify: `public/js/admin/views/case-overview.js` (notes ~L372–373)
- Modify: `public/css/admin-views.css` (two classes)
- Modify tests: `public/js/admin/__tests__/case-docs.test.mjs`, `public/js/admin/__tests__/case-overview.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

Behaviour:
- New exported `caseRowGapText(item)` in `case-docs.js`:

```js
/**
 * INPATIENT_REQUIRED_V1 — что под именем строки: чего не хватает и «по желанию».
 * Владелец просил строку карточки «только имя и кнопка» (CASE_ROW_NAME_ONLY_V1) — но
 * эта строка отвечает на его же вопрос «какие поля не заполнены», и стоит она только там,
 * где есть что сказать. Красной она не бывает: пробел — жёлтый, «по желанию» — серый.
 * @returns {{tone:'warn'|'opt', text:string}|null}
 */
export function caseRowGapText(item) {
    if (!item) return null;
    if (item.kind === 'title' && item.required !== false && item.state !== 'published' && Array.isArray(item.missing) && item.missing.length) {
        return { tone: 'warn', text: trf('не заполнено: {list}', { list: item.missing.map(titleFieldLabel).join(', ') }) };
    }
    if (Array.isArray(item.missing_sections) && item.missing_sections.length) {
        return { tone: 'warn', text: trf('пустые разделы: {list}', { list: item.missing_sections.map((k) => tr(sectionLabel(item.kind, k))).join(', ') }) };
    }
    if (item.optional) return { tone: 'opt', text: tr('по желанию') };
    return null;
}
```

  In `itemRow`, put `h('span', { class: gap.tone === 'opt' ? 'cd-row-opt' : 'cd-row-gap' }, gap.text)` under the name inside the `open` button when `gap` is not null, and append `gap.text` to the row's `title` / `aria-label` state line.
- `caseGateText`: first, `if (!blocked && gate.epicrisis_required === false) return tr('Выписной эпикриз для выписки не обязателен — заявку на выписку примут.');`.
- `case-overview.js`: `sh && !ts.complete && ts.required !== false ? note((ts.missing && ts.missing.length) ? trf('Титульный лист заполнен не до конца: {list}.', { list: ts.missing.map(titleFieldLabel).join(', ') }) : tr('Титульный лист заполнен не до конца.'), 'warn') : null`.
- CSS:

```css
/* INPATIENT_REQUIRED_V1 — строка чек-листа: чего не хватает (жёлтым) и «по желанию» (серым), не красным. */
.cd-row-gap { display: block; margin-top: 2px; font-size: 12px; font-weight: 500; color: var(--warn-700); }
.cd-row-opt { display: block; margin-top: 2px; font-size: 12px; font-weight: 500; color: var(--ink-500); }
```

- [ ] **Step 1: Write failing tests** — in `case-docs.test.mjs`, using its `render(over)` / `caseDocsView({ state })` helpers:

```js
test('INPATIENT_REQUIRED_V1: титульный лист называет пустые поля, документ — пустые разделы, «по желанию» — словами и не красным', () => {
    const { caseRowGapText } = view;
    assert.deepEqual(caseRowGapText({ kind: 'title', required: true, state: 'draft', missing: ['height_cm', 'pulse_bpm'] }),
        { tone: 'warn', text: 'не заполнено: Рост, Пульс' });
    assert.deepEqual(caseRowGapText({ kind: 'primary', state: 'published', missing_sections: ['diagnosis'] }),
        { tone: 'warn', text: 'пустые разделы: Диагноз' });
    assert.deepEqual(caseRowGapText({ kind: 'round', optional: true, state: 'pending', missing_sections: [] }), { tone: 'opt', text: 'по желанию' });
    assert.equal(caseRowGapText({ kind: 'round', state: 'pending', missing_sections: [] }), null);
    // В списке строка «по желанию» видна и не красная.
    const el = render({ items: [{ kind: 'round', group: 'required', order: 1, applies: true, required: false, optional: true, state: 'pending', due_rule: 'period', missing_sections: [] }] });
    assert.ok(textOf(el).includes('по желанию'));
});

test('INPATIENT_REQUIRED_V1: эпикриз не обязателен — гейт так и говорит', () => {
    assert.equal(view.caseGateText({ items: [{ kind: 'discharge' }], discharge_gate: { blocked: false, blocking: [], incomplete: [], epicrisis_required: false } }),
        'Выписной эпикриз для выписки не обязателен — заявку на выписку примут.');
});
```

  (Adapt `render(...)` to how the file builds a state; read L120–160 first.) In `case-overview.test.mjs` add: an overview with `title_sheet: { complete: false, sheet: { height_cm: null }, missing: ['height_cm'], required: true }` shows «Титульный лист заполнен не до конца: Рост.»; with `required: false` the note is absent.

- [ ] **Step 2: Run — expect FAIL**, **Step 3: implement** (imports in `case-docs.js` / `case-overview.js`: `titleFieldLabel` from `./required-marks.js`; `sectionLabel` from `./case-doc-a4.js`), **Step 4: dictionary** (`не заполнено: {list}`, `пустые разделы: {list}`, `по желанию`, `Выписной эпикриз для выписки не обязателен — заявку на выписку примут.`, `Титульный лист заполнен не до конца: {list}.`), **Step 5: run — expect PASS:**

`node --test --test-concurrency=4 public/js/admin/__tests__/case-docs.test.mjs public/js/admin/__tests__/case-overview.test.mjs public/js/admin/__tests__/case-file-tabs.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`

`node --test --test-concurrency=2 public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs`

- [ ] **Step 6: Commit**

```bash
printf '%s\n' 'Стационар: чек-лист и обзор называют, чего не хватает — поля титульного листа, пустые разделы документов; документы «по желанию» подписаны и не красные; гейт выписки говорит, что эпикриз не обязателен (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add public/js/admin/views/case-docs.js public/js/admin/views/case-overview.js public/css/admin-views.css public/js/admin/__tests__/case-docs.test.mjs public/js/admin/__tests__/case-overview.test.mjs public/js/admin/i18n-strings.js
git commit -F .git/INPATIENT_MSG
```

---

### Task 11: Settings page «Настройки → Стационар», route, tile, rule

**Files:**
- Create: `public/js/admin/views/inpatient-settings.js`
- Create: `public/js/admin/__tests__/inpatient-settings-view.test.mjs`
- Modify: `public/js/admin.js` (import ~L115–124; `CRUMBS` ~L362–420; `PARENT_OF` ~L885–905; render `switch` ~L1560–1570)
- Modify: `public/js/admin/permissions.js` (`isRouteAllowed`, next to `if (view === 'visibility-settings') return false;` ~L1271)
- Modify: `public/js/admin/views/settings-hub.js` (`GROUPS` group `key: 'rooms'` ~L408)
- Modify: `public/js/admin/views/act-as-history.js` (RPC labels map ~L80–95)
- Modify: `public/css/admin-views.css`, `public/js/admin/i18n-strings.js`

Page (`renderInpatientSettings(container, ctx)`), patterned on `views/crm-settings.js` / `views/sms-settings.js` (cards, one save button, `isNotImplemented` style for an old server):
- `PageHead({ title: 'Стационар' })` with a one-line subtitle-free head (no explainer text), then four cards (`section.card`):
  1. **«Что останавливает работу»** — four rows: `input type=checkbox role=switch class=ips-switch` + bold label + one muted sentence that changes with the state:
     - `intake_before_attending`: «Лечащий врач — только после осмотра приёмного врача» — ON «Лечащего врача назначают после того, как опубликован осмотр приёмного врача или первичный осмотр.» / OFF «Лечащего врача назначают сразу после размещения на койке; осмотр остаётся в списке как документ.»
     - `admitting_at_placement`: «Приёмный врач — обязателен при размещении на койке» — ON «Медсестра не положит пациента, пока не выберет приёмного врача.» / OFF «Медсестра может разместить пациента без приёмного врача; осмотр при поступлении пишет главный врач.»
     - `primary_needs_diagnosis`: «Первичный осмотр — только с диагнозом» — ON «Первичный осмотр не публикуется без диагноза.» / OFF «Первичный осмотр можно опубликовать без диагноза.»
     - `discharge_needs_epicrisis`: «Выписка — только с выписным эпикризом» — ON «Заявку на выписку принимают только по опубликованному выписному эпикризу.» / OFF «Заявку на выписку принимают и без выписного эпикриза.»
  2. **«Документы истории болезни»** — first row «Титульный лист» with switch «Обязательный» (`title_required`), then each `data.docs` row in order: name `caseDocTitle(kind, title)` (from `./case-docs.js`) · switch «Обязательный» · section chips for `doc.sections` (`button.ips-chip`, `aria-pressed`, text `tr(sectionLabel(kind, key))`) toggling membership in `required_sections`, with a muted hint «Отмеченные разделы обязательны: пустой раздел подсвечивается, публикация спрашивает «Сохранить как есть».».
  3. **«Титульный лист — обязательные поля»** — `fieldset` per `TITLE_GROUPS` (legend `tr(TITLE_GROUP_LABEL[g])`) with a checkbox per field (`checkField(titleFieldLabel(key), cb)` from `ui.js`). When «Титульный лист» is not required, the card shows the muted line «Титульный лист не обязателен — поля не требуются.» and the checkboxes are disabled.
  4. **«Кто менял»** — up to 20 lines from `data.log`, each `logLineText(entry, docs)` → `trf('{when} · {who}: {what} — {from} → {to}', …)`; `what`: the switch label, `title_required` → «Титульный лист — обязательный документ», `title_required_fields` → «Обязательные поля титульного листа», `doc:<kind>:required` → `trf('{doc}: обязательный документ', …)`, `doc:<kind>:sections` → `trf('{doc}: обязательные разделы', …)`; values `'1'`/`'0'` → «да»/«нет», JSON lists → labels joined by «, », empty list → «—». Empty log → «Изменений ещё не было.»
- One «Сохранить» (`btn btn-primary`, `Icon('Check')`), disabled until something changed; dirty line «● Есть несохранённые изменения» (existing string, `employees.js` style). Save sends `settingsDiff(initial, current)` → `inpatient_settings_save`; on success repaint from the answer, toast «Настройки стационара сохранены.»; on error toast the server message and keep the edits.
- Read error / 501: a calm card «Настройки стационара недоступны: {msg}» — no crash (the app-shell test renders every hub route).
- `data.can_edit === false` (should not happen — the route is for admin/head doctor): all controls disabled, no save button.

Exported pure helpers for tests: `settingsDiff(before, after)` → only changed switch keys (0/1), `title_required_fields` when the set changed, `docs: [{ kind, required?, required_sections? }]` only for changed documents (omit `docs` when none); and `logLineText(entry, docs)`.

Wiring:
- `admin.js`: `import { renderInpatientSettings } from './admin/views/inpatient-settings.js';   // INPATIENT_REQUIRED_V1`; `CRUMBS`: `'inpatient-settings': ['Insights', 'Settings', 'Стационар'],   // INPATIENT_REQUIRED_V1`; `PARENT_OF`: `'inpatient-settings': 'settings',   // INPATIENT_REQUIRED_V1 — плитка «Помещений»`; render switch: `case 'inpatient-settings': return void await renderInpatientSettings(viewRoot, ctx);   // INPATIENT_REQUIRED_V1`.
- `permissions.js` `isRouteAllowed`: `// INPATIENT_REQUIRED_V1 — «что обязательно в стационаре» решают главный врач и администратор (сервер — SETTINGS_WRITE_ROLES в rpc/inpatient-settings.js).` then `if (view === 'inpatient-settings') return isModuleAllowed('settings') && hasActorRole(['admin', 'head_doctor']);` (full access already returned `true` above).
- `settings-hub.js` group `rooms`, after «Помещения»: `{ label: 'Стационар', desc: 'Что обязательно: документы истории болезни, поля титульного листа, порядок шагов', icon: 'Bed', live: true, action: nav('inpatient-settings'), route: 'inpatient-settings' },   // INPATIENT_REQUIRED_V1`.
- `act-as-history.js` labels: `inpatient_settings_get: 'Настройки стационара', inpatient_settings_save: 'Изменение настроек стационара',`.
- CSS (prefix `ips-`): rows as a 2-column grid that stacks under 640 px; `.ips-switch { width: 18px; height: 18px; }`; chips: `.ips-chip { border: 1px solid var(--ink-200); border-radius: 999px; padding: 3px 10px; background: var(--white); font: inherit; font-size: 12.5px; cursor: pointer; } .ips-chip[aria-pressed="true"] { border-color: var(--crit-500); background: var(--crit-50); color: var(--crit-700); font-weight: 600; }` (check `--ink-200` exists: `grep -n "\-\-ink-200:" public/css/admin.css`, else use `--ink-100`).

- [ ] **Step 1: Write the failing test** — `public/js/admin/__tests__/inpatient-settings-view.test.mjs` (fake DOM as in `title-sheet.test.mjs`; fake server answering `inpatient_settings_get` with `DATA` and recording `inpatient_settings_save`):

```js
const DATA = {
    settings: { intake_before_attending: 1, admitting_at_placement: 1, primary_needs_diagnosis: 1, discharge_needs_epicrisis: 1, title_required: 1,
        title_required_fields: ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation'] },
    docs: [
        { kind: 'intake', title: '', builtin: true, required: true, required_sections: [], sections: ['complaints', 'objective', 'diagnosis', 'plan'] },
        { kind: 'primary', title: '', builtin: true, required: true, required_sections: [], sections: ['complaints', 'objective', 'diagnosis', 'plan', 'body'] },
        { kind: 'own_7', title: 'Тестовый лист', builtin: false, required: true, required_sections: [], sections: ['complaints', 'objective', 'diagnosis', 'plan', 'body'] },
    ],
    log: [{ id: 1, at: '2026-11-23T08:00:00Z', user_name: 'Сотрудник head', field: 'intake_before_attending', old_value: '1', new_value: '0' }],
    can_edit: true,
};

test('страница: четыре переключателя, документы с разделами, поля листа, журнал', async () => {
    const { renderInpatientSettings } = await import('../views/inpatient-settings.js');
    const root = mkEl('div');
    await renderInpatientSettings(root, {});
    await settle();
    const t = textOf(root);
    for (const s of ['Лечащий врач — только после осмотра приёмного врача', 'Приёмный врач — обязателен при размещении на койке',
        'Первичный осмотр — только с диагнозом', 'Выписка — только с выписным эпикризом', 'Титульный лист', 'Тестовый лист',
        'Рост', 'Санитарная обработка', 'Кто менял', 'Сотрудник head']) assert.ok(t.includes(s), 'нет: ' + s);
});

test('сохраняется только изменённое', async () => {
    const { renderInpatientSettings } = await import('../views/inpatient-settings.js');
    const root = mkEl('div');
    rpcCalls.length = 0;
    await renderInpatientSettings(root, {});
    await settle();
    const sw = walk(root).find((e) => e.tagName === 'INPUT' && e.attrs['data-ips-switch'] === 'intake_before_attending');
    sw.checked = false; sw.dispatchEvent({ type: 'change' });
    const chip = walk(root).find((e) => e.tagName === 'BUTTON' && e.attrs['data-ips-kind'] === 'primary' && e.attrs['data-ips-section'] === 'diagnosis');
    chip.click();
    const height = walk(root).find((e) => e.tagName === 'INPUT' && e.attrs['data-ips-field'] === 'height_cm');
    height.checked = false; height.dispatchEvent({ type: 'change' });
    assert.ok(textOf(root).includes('Есть несохранённые изменения'));
    findBtn(root, 'Сохранить').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'inpatient_settings_save');
    assert.deepEqual(call.args, {
        intake_before_attending: 0,
        title_required_fields: ['weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation'],
        docs: [{ kind: 'primary', required_sections: ['diagnosis'] }],
    });
});

test('settingsDiff и строка журнала', async () => {
    const { settingsDiff, logLineText } = await import('../views/inpatient-settings.js');
    assert.deepEqual(settingsDiff(DATA, DATA), {});
    assert.ok(logLineText(DATA.log[0], DATA.docs).includes('Лечащий врач — только после осмотра приёмного врача'));
    assert.ok(logLineText({ at: '2026-11-23T08:00:00Z', user_name: 'Сотрудник head', field: 'doc:own_7:sections', old_value: '[]', new_value: '["plan"]' }, DATA.docs).includes('Тестовый лист'));
});

test('маршрут: главный врач и администратор — да; регистратура и врач с «Настройками» — нет; плитка в «Помещениях»; оболочка знает маршрут', async () => {
    const perms = await import('../permissions.js');
    const role = (name, sections) => ({ name, permissions: { sections, levels: {} } });
    try {
        perms.setFullAccess('Admin');
        assert.equal(perms.isRouteAllowed('inpatient-settings'), true);
        perms.setEffectiveFromRole(role('head_doctor', ['settings']));
        assert.equal(perms.isRouteAllowed('inpatient-settings'), true);
        perms.setEffectiveFromRole(role('registrar', ['settings']));
        assert.equal(perms.isRouteAllowed('inpatient-settings'), false);
        perms.setEffectiveFromRole(role('doctor', ['settings']));
        assert.equal(perms.isRouteAllowed('inpatient-settings'), false);
    } finally { perms.setFullAccess('Admin'); }
    const { GROUPS } = await import('../views/settings-hub.js');
    assert.ok(GROUPS.find((g) => g.key === 'rooms').items.some((i) => i.route === 'inpatient-settings'));
    const fs = await import('node:fs');
    const shell = fs.readFileSync(new URL('../../admin.js', import.meta.url), 'utf8');
    assert.match(shell, /'inpatient-settings':\s*'settings'/);
    assert.match(shell, /case 'inpatient-settings':/);
    assert.match(shell, /'inpatient-settings':\s*\['Insights', 'Settings', 'Стационар'\]/);
});
```

(The page sets `data-ips-switch`, `data-ips-kind`, `data-ips-section`, `data-ips-field` attributes for these hooks. How `setEffectiveFromRole` learns the role code: check `route-gate.test.mjs` `role()` helper — a role named with a role code is enough there; if not, also call `perms.setActorRoles([code])`.)

- [ ] **Step 2: Run — expect FAIL**, **Step 3: implement** page + wiring, **Step 4: dictionary** (every new string of the page: card titles, the four labels and eight sentences, «Обязательный», chip hint, «Титульный лист — обязательный документ», «Обязательные поля титульного листа», `{doc}: обязательный документ`, `{doc}: обязательные разделы`, `{when} · {who}: {what} — {from} → {to}`, «Изменений ещё не было.», «Титульный лист не обязателен — поля не требуются.», «Настройки стационара сохранены.», `Настройки стационара недоступны: {msg}`, `Что обязательно: документы истории болезни, поля титульного листа, порядок шагов`, «Настройки стационара», «Изменение настроек стационара»).

- [ ] **Step 5: Run — expect PASS**, then the shell and nav guards:

`node --test --test-concurrency=4 public/js/admin/__tests__/inpatient-settings-view.test.mjs public/js/admin/__tests__/route-gate.test.mjs public/js/admin/__tests__/appbar-back.test.mjs public/js/admin/__tests__/app-shell.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/settings-hub-groups.test.mjs public/js/admin/__tests__/settings-hub-fold.test.mjs public/js/admin/__tests__/role-reports-settings.test.mjs public/js/admin/__tests__/admin-rows-grantable.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/nav-visibility-shell.test.mjs public/js/admin/__tests__/nav-visibility-view.test.mjs public/js/admin/__tests__/actor-extra-roles.test.mjs public/js/admin/__tests__/login-roles.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/act-as-employees.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs`

`node --test server/services/rpc/client-rpc-coverage.test.js`

If a guard fails because it lists routes or tiles explicitly, add `inpatient-settings` to that list with an `INPATIENT_REQUIRED_V1` comment — do not weaken the guard.

- [ ] **Step 6: Commit**

```bash
printf '%s\n' 'Стационар: «Настройки → Стационар» — четыре переключателя «что останавливает работу», обязательные документы и их разделы, обязательные поля титульного листа, журнал «кто менял»; одна кнопка «Сохранить»; плитка в «Помещениях», маршрут для главного врача и администратора (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git add public/js/admin/views/inpatient-settings.js public/js/admin/__tests__/inpatient-settings-view.test.mjs public/js/admin.js public/js/admin/permissions.js public/js/admin/views/settings-hub.js public/js/admin/views/act-as-history.js public/css/admin-views.css public/js/admin/i18n-strings.js
# плюс каждый файл проверок из шага 5, в чей список вы добавили 'inpatient-settings' — по имени (git status покажет), не `git add -A`
git commit -F .git/INPATIENT_MSG
```

---

### Task 12: Final sweep — spec coverage, i18n, targeted test groups

**Files:** none new; fixes only where a check fails.

- [ ] **Step 1: Marker and string checks.**
  - `git diff --stat b6aa211c..HEAD` — every changed source file contains `INPATIENT_REQUIRED_V1` (`git diff b6aa211c..HEAD --name-only | xargs grep -L INPATIENT_REQUIRED_V1` lists only test/CSS files that legitimately lack it — add the marker to any source file that does not).
  - No Russian literals in `public/js/shared/inpatient-required.js` / `case-doc-sections.js`: `grep -nP "['\"][^'\"]*[А-Яа-яЁё]" public/js/shared/inpatient-required.js public/js/shared/case-doc-sections.js` → nothing.
  - No emoji in changed UI files; no `window.confirm` / `confirm(` added: `git diff b6aa211c..HEAD | grep -nE "^\+.*\bconfirm\(" ` → nothing.
  - No real-looking patient data in new tests (`git diff b6aa211c..HEAD -- '*.test.*' | grep -nE "^\+.*\+998[0-9]{9}"` shows only `+998900000000`).

- [ ] **Step 2: Server group** (in this order, each line one command):

`node --test --test-concurrency=4 server/db/migrations/298.test.js server/services/test-data-wipe-plan.test.js server/services/test-data-wipe-files.test.js server/db/migrate.test.js`

`node --test --test-concurrency=4 server/services/rpc/inpatient-settings.test.js server/services/rpc/inpatient-required-gates.test.js server/services/rpc/inpatient-required-checklist.test.js server/services/rpc/case-doc-types.test.js`

`node --test --test-concurrency=4 server/services/rpc/inpatient-flow.test.js server/services/domain/lifecycle.test.js server/services/rpc/inpatient-reviews.test.js server/services/rpc/admitting-doctor.test.js`

`node --test --test-concurrency=4 server/services/rpc/case-docs.test.js server/services/rpc/title-sheet.test.js server/services/rpc/case-overview.test.js server/services/rpc/discharge.test.js`

`node --test --test-concurrency=4 server/services/rpc/inpatient.test.js server/services/rpc/inpatient-head-scope.test.js server/services/rpc/case-file-save.test.js server/services/rpc/inpatient-v3120.test.js`

`node --test --test-concurrency=4 server/i18n-server-messages.test.js server/routes/licence-gate.test.js server/services/rpc/client-rpc-coverage.test.js server/services/rpc/inpatient-v3120-final.test.js`

- [ ] **Step 3: UI group:**

`node --test --test-concurrency=4 public/js/shared/inpatient-required.test.js public/js/shared/case-doc-sections.test.js public/js/shared/title-sheet-rules.test.js public/js/admin/__tests__/required-marks.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/title-sheet.test.mjs public/js/admin/__tests__/inpatient-required-editor.test.mjs public/js/admin/__tests__/case-doc-a4.test.mjs public/js/admin/__tests__/case-docs.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/case-overview.test.mjs public/js/admin/__tests__/case-file-tabs.test.mjs public/js/admin/__tests__/admissions-window.test.mjs public/js/admin/__tests__/inpatient-section.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/inpatient-route.test.mjs public/js/admin/__tests__/inpatient-notifications.test.mjs public/js/admin/__tests__/act-as-sign-lab-inpatient.test.mjs public/js/admin/__tests__/inpatient-settings-view.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/route-gate.test.mjs public/js/admin/__tests__/appbar-back.test.mjs public/js/admin/__tests__/app-shell.test.mjs public/js/admin/__tests__/settings-hub-groups.test.mjs`

`node --test --test-concurrency=4 public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/server-messages-i18n.test.mjs`

A failure that is `fetch failed / bad port` in a port-binding file is the known Windows flake (CLAUDE.md) — re-run that file alone. Any assertion failure is real: fix it in the task's spirit and re-run.

- [ ] **Step 4: Spec walk-through.** Open `docs/specs/2026-11-23-inpatient-required-design.md` and tick each line against the code: §1 storage (Task 1), §2 shared rules (Task 2), §3 server (Tasks 3–5), §4 settings screen (Task 11), §5 marks and «save anyway» incl. «Where it applies» — placement window, title-sheet editor, every case-document editor, treating-doctor and placement doctor pickers (Tasks 6–10), §6 languages/icons (every task), Tests list (each has a test above). Write any gap down and fix it before the commit.

- [ ] **Step 5: No release notes.** Do not edit `RELEASE_NOTES.md`, `package.json` version or release tests — this change is not released yet.

- [ ] **Step 6: Commit (only if Steps 1–4 changed something)**

```bash
printf '%s\n' 'Стационар: последняя сверка «что обязательно» со спецификацией — метки, переводы, проверки (INPATIENT_REQUIRED_V1)' '' 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' > .git/INPATIENT_MSG
git status --short          # ровно файлы, которые правили шаги 1–4
git add <каждый из них по имени>
git commit -F .git/INPATIENT_MSG
```
