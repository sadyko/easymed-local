# Inpatient Title Sheet (Титульный лист) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the nurse places a patient in a bed, she fills the title sheet (personal data from the card + admission measurements) in the same step; the sheet is the first document of the case history and its first printed page.

**Architecture:** One new table (`admission_title_sheets`, 1:1 with `admissions`) reached only through RPCs in a new `rpc/title-sheet.js`; `admission_admit` saves the sheet in its own transaction; `admission_case_docs` prepends a synthetic `title` item; the client gets a shared form (`views/title-sheet.js`) used by the placement modal and the case-file editor, and a print section (`views/title-sheet-print.js`) that replaces the assembled history's cover. Validation rules (ranges, completeness, BMI) live once in `public/js/shared/title-sheet-rules.js`, imported by server and client.

**Tech Stack:** Node 24 ESM, better-sqlite3, `node --test`; vanilla-DOM client (`h()` from `ui.js`), fake-DOM test harnesses in `public/js/admin/__tests__/`.

Spec: `docs/specs/2026-09-08-inpatient-title-sheet-design.md`. Repo: `C:/Users/user/Desktop/implementation workflow/easymed.local` — every command below runs from there.

---

## File map

| File | Responsibility |
|---|---|
| `public/js/shared/title-sheet-rules.js` (new) | numeric ranges, required keys, `numOrNull`, `bmiOf`, `sheetCompleteness` — no Cyrillic (shared module) |
| `server/db/migrations/110_admission_title_sheets.sql` (new) + `110.test.js` | the table; guard test on a DB with referencing rows |
| `server/services/rpc/title-sheet.js` (new) + `title-sheet.test.js` | `sheetView`, `saveTitleSheet`, `admissionTitleSheetGet/Save`, `titleSheetCaseItem`; Russian error texts |
| `server/services/rpc/inpatient.js` | `admission_admit` accepts `title_sheet` |
| `server/services/rpc/inpatient-reviews.js` | `admission_case_docs` prepends the title item; `admission_case_file` carries `title_sheet` |
| `server/services/rpc/index.js` | registers the two RPCs |
| `public/js/admin/views/inpatient-modal.js` (new) | `inpatientModal`, `patientAnchor` moved out of `admission-modal.js` (breaks the import cycle) |
| `public/js/admin/views/title-sheet-print.js` (new) | `titleSheetPrintSection`, `titleSheetPrintCss`, `titleSheetPrintHtml` |
| `public/js/admin/views/title-sheet.js` (new) | `titleSheetForm`, `openAdmissionTitleSheetModal`, `buildTitleSheetEditor`, `printTitleSheet` |
| `public/js/admin/views/admission-modal.js` | bed picker → «Далее» → title-sheet modal |
| `public/js/admin/views/case-docs.js` | title `Титульный лист`; print cover = title sheet |
| `public/js/admin/views/case-workspace.js` | `kind === 'title'` → `buildTitleSheetEditor` |
| `public/css/admin-views.css` | `.ts-*` styles |
| `public/js/admin/i18n-strings.js` | ru/uz/en for every new string |
| tests: `__tests__/title-sheet.test.mjs` (new), `admissions-window.test.mjs`, `inpatient-route.test.mjs`, `rpc/case-docs.test.js` | see tasks |

---

### Task 1: Shared rules module

**Files:**
- Create: `public/js/shared/title-sheet-rules.js`
- Test: `public/js/shared/title-sheet-rules.test.js`

- [ ] **Step 1: Write the failing test**

```js
// public/js/shared/title-sheet-rules.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { numOrNull, bmiOf, sheetCompleteness, MEASURES, REQUIRED_KEYS } from './title-sheet-rules.js';

test('numOrNull: запятая = точка, пусто = null, мусор = NaN', () => {
    assert.equal(numOrNull('72,5'), 72.5);
    assert.equal(numOrNull(' 172 '), 172);
    assert.equal(numOrNull(''), null);
    assert.equal(numOrNull(null), null);
    assert.ok(Number.isNaN(numOrNull('abc')));
    assert.ok(Number.isNaN(numOrNull('1.2.3')));
});

test('bmiOf: одна цифра после запятой, без роста или веса — null', () => {
    assert.equal(bmiOf(172, 80), 27.0);
    assert.equal(bmiOf('172', '72,5'), 24.5);
    assert.equal(bmiOf('', 80), null);
    assert.equal(bmiOf(172, ''), null);
    assert.equal(bmiOf('x', 80), null);
});

test('sheetCompleteness: шесть измерений и два ответа медсестры', () => {
    assert.deepEqual(REQUIRED_KEYS, ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation']);
    assert.deepEqual(sheetCompleteness(null), { complete: false, missing: REQUIRED_KEYS.slice() });
    const full = { height_cm: 172, weight_kg: 80, temp_c: 36.6, bp_sys: 120, bp_dia: 80, pulse_bpm: 72, pediculosis: 'none', sanitation: 'full', note: '' };
    assert.deepEqual(sheetCompleteness(full), { complete: true, missing: [] });
    assert.deepEqual(sheetCompleteness(Object.assign({}, full, { weight_kg: null, sanitation: '' })),
        { complete: false, missing: ['weight_kg', 'sanitation'] });
});

test('диапазоны — те, что в спецификации', () => {
    assert.deepEqual(Object.keys(MEASURES), ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm']);
    assert.deepEqual([MEASURES.height_cm.min, MEASURES.height_cm.max], [30, 250]);
    assert.deepEqual([MEASURES.bp_dia.min, MEASURES.bp_dia.max, MEASURES.bp_dia.int], [20, 200, true]);
});
```

- [ ] **Step 2: Run it — expect module-not-found**

Run: `node --test public/js/shared/title-sheet-rules.test.js`
Expected: FAIL `Cannot find module … title-sheet-rules.js`

- [ ] **Step 3: Write the module**

```js
// public/js/shared/title-sheet-rules.js
// TITLE_SHEET_V1 — правила титульного листа, ОБЩИЕ для сервера и экрана.
//
// Диапазоны, обязательный состав и ИМТ живут в одном месте, потому что их
// спрашивают с двух сторон: сервер отказывает по ним (rpc/title-sheet.js), а
// экран считает ИМТ по мере ввода (views/title-sheet.js). Две копии разошлись
// бы на первой правке диапазона. Здесь нет русского текста намеренно: слова
// отказов — у сервера, подписи полей — у экрана (i18n).
export const MEASURES = Object.freeze({
    height_cm: { min: 30, max: 250, int: false },
    weight_kg: { min: 1,  max: 400, int: false },
    temp_c:    { min: 30, max: 45,  int: false },
    bp_sys:    { min: 40, max: 300, int: true  },
    bp_dia:    { min: 20, max: 200, int: true  },
    pulse_bpm: { min: 20, max: 250, int: true  },
});
export const MEASURE_KEYS = Object.freeze(Object.keys(MEASURES));
export const PEDICULOSIS = Object.freeze(['', 'none', 'found']);
export const SANITATION  = Object.freeze(['', 'full', 'partial', 'none']);
export const REQUIRED_KEYS = Object.freeze([...MEASURE_KEYS, 'pediculosis', 'sanitation']);
/** Поля карточки пациента, которые титульный лист вправе поправить. ФИО и дата рождения — нет: это личность, её правят в карточке. */
export const PATIENT_FIELDS = Object.freeze([
    'gender', 'phone', 'address', 'national_id', 'occupation',
    'emergency_contact_name', 'emergency_contact_phone', 'blood_type', 'allergies',
]);

/** '72,5' → 72.5; '' / null / undefined → null; не число → NaN. */
export function numOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const s = String(v).trim().replace(',', '.');
    if (s === '') return null;
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** ИМТ с одной цифрой после запятой; без роста или веса — null. */
export function bmiOf(heightCm, weightKg) {
    const hgt = numOrNull(heightCm);
    const wgt = numOrNull(weightKg);
    if (!hgt || !wgt || Number.isNaN(hgt) || Number.isNaN(wgt) || hgt <= 0) return null;
    const m = hgt / 100;
    return Math.round((wgt / (m * m)) * 10) / 10;
}

/** Полон ли лист: все измерения и оба ответа медсестры на месте. */
export function sheetCompleteness(row) {
    if (!row) return { complete: false, missing: REQUIRED_KEYS.slice() };
    const missing = REQUIRED_KEYS.filter((k) => row[k] === null || row[k] === undefined || row[k] === '');
    return { complete: missing.length === 0, missing };
}
```

- [ ] **Step 4: Run the test — expect PASS (4/4)**

Run: `node --test public/js/shared/title-sheet-rules.test.js`

- [ ] **Step 5: Commit**

```bash
git add public/js/shared/title-sheet-rules.js public/js/shared/title-sheet-rules.test.js
git commit -m "feat(inpatient): правила титульного листа — общий модуль (TITLE_SHEET_V1)"
```

---

### Task 2: Migration 110

**Files:**
- Create: `server/db/migrations/110_admission_title_sheets.sql`
- Test: `server/db/migrations/110.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/db/migrations/110.test.js
// TITLE_SHEET_V1 — таблица титульного листа: одна на госпитализацию, без пересборок.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

function seedAdmission(db) {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'nurse1','x','Медсестра','nurse')").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (10, 1, 'admitted')").run();
}

test('таблица есть, и на одну госпитализацию — один лист', () => {
    const db = fresh();
    try {
        seedAdmission(db);
        const cols = db.prepare('PRAGMA table_info(admission_title_sheets)').all().map((c) => c.name);
        for (const c of ['admission_id', 'referred_from', 'height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm',
            'pediculosis', 'sanitation', 'note', 'filled_by', 'filled_at', 'created_at', 'updated_at']) {
            assert.ok(cols.includes(c), 'нет колонки ' + c);
        }
        db.prepare("INSERT INTO admission_title_sheets (admission_id, height_cm) VALUES (10, 172)").run();
        assert.throws(() => db.prepare("INSERT INTO admission_title_sheets (admission_id) VALUES (10)").run(), /UNIQUE/);
        assert.throws(() => db.prepare("INSERT INTO admission_title_sheets (admission_id, pediculosis) VALUES (11, 'maybe')").run(), /CHECK|FOREIGN KEY/);
        assert.throws(() => db.prepare("UPDATE admission_title_sheets SET sanitation='yes' WHERE admission_id=10").run(), /CHECK/);
    } finally { db.close(); }
});

test('миграция проходит на базе, где уже лежат пациенты со ссылками', () => {
    // Урок 1.1.0: пересборка таблицы при включённых внешних ключах роняет
    // запуск клиники. Здесь пересборки нет — только CREATE TABLE, — и этот
    // тест стоит сторожем, чтобы она не появилась.
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig110-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (f.startsWith('110_') || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    seedAdmission(db);
    db.prepare("INSERT INTO admission_reviews (admission_id, kind, diagnosis, published_at) VALUES (10,'primary','J18.9','2026-09-08T10:00:00Z')").run();
    db.prepare("INSERT INTO wards (id, name) VALUES (1,'Терапия')").run();
    db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'T-1',1,'occupied')").run();
    db.prepare('UPDATE admissions SET bed_id=1, ward_id=1 WHERE id=10').run();

    migrate(db);   // 110 поверх базы со ссылками

    assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_reviews').get().n, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'миграция порвала ссылки');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='admission_title_sheets'").get().n, 1);
    db.close();
});
```

- [ ] **Step 2: Run — expect FAIL (`no such table: admission_title_sheets`)**

Run: `node --test server/db/migrations/110.test.js`

- [ ] **Step 3: Write the migration**

```sql
-- 110_admission_title_sheets.sql — TITLE_SHEET_V1: титульный лист истории болезни.
--
-- Владелец: «when request of hospitalization is accepted and patient is
-- admitting to the bed, nurse should collect the title list, with personal
-- information and anthropometric data of the patient, and it goes as a title
-- list when history is collected».
--
-- ─── ПОЧЕМУ СВОЯ ТАБЛИЦА, А НЕ ДВЕНАДЦАТЫЙ ДОКУМЕНТ ───────────────────────
-- Документы истории болезни (admission_reviews, 095/104) — пять текстовых
-- полей врача. Титульный лист — это ЧИСЛА медсестры: рост, вес, температура,
-- давление, пульс. Записать их текстом в `body` значило бы потерять ИМТ,
-- проверку диапазонов и любую возможность спросить «а сколько он весил при
-- поступлении» иначе, чем глазами. Поэтому — свои колонки.
--
-- ─── ЧЕГО ЗДЕСЬ НЕТ: ЛИЧНЫХ ДАННЫХ ─────────────────────────────────────────
-- ФИО, дата рождения, адрес, телефон, группа крови, аллергии живут в
-- `patients` и НЕ КОПИРУЮТСЯ: лист показывает их из карточки и пишет
-- исправления обратно в карточку (rpc/title-sheet.js). Копия разошлась бы с
-- карточкой в первый же день.
--
-- ─── ПОЧЕМУ БЕЗ ИМТ ────────────────────────────────────────────────────────
-- ИМТ — вычисление от роста и веса (public/js/shared/title-sheet-rules.js).
-- Хранимая копия разошлась бы с исходными числами при первой правке веса.
--
-- Только CREATE TABLE. Пересборки нет и быть не должно: миграция 109 (1.1.0)
-- показала, что DROP при включённых внешних ключах роняет запуск клиники.
CREATE TABLE admission_title_sheets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id  INTEGER NOT NULL UNIQUE REFERENCES admissions(id),

  referred_from TEXT NOT NULL DEFAULT '',        -- «Кем направлен»

  height_cm     REAL,                            -- 30–250
  weight_kg     REAL,                            -- 1–400
  temp_c        REAL,                            -- 30–45
  bp_sys        INTEGER,                         -- 40–300
  bp_dia        INTEGER,                         -- 20–200, меньше bp_sys
  pulse_bpm     INTEGER,                         -- 20–250

  -- Осмотр на педикулёз и чесотку: '' — не отвечено, none — не выявлено, found — выявлено.
  pediculosis   TEXT NOT NULL DEFAULT '' CHECK (pediculosis IN ('', 'none', 'found')),
  -- Санитарная обработка: '' — не отвечено, full — полная, partial — частичная, none — не проводилась.
  sanitation    TEXT NOT NULL DEFAULT '' CHECK (sanitation IN ('', 'full', 'partial', 'none')),

  note          TEXT NOT NULL DEFAULT '',

  -- Кто и когда ВПЕРВЫЕ заполнил лист целиком. Ставится один раз.
  filled_by     INTEGER REFERENCES users(id),
  filled_at     TEXT,

  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT
);
```

- [ ] **Step 4: Run — expect PASS (2/2)**

Run: `node --test server/db/migrations/110.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/db/migrations/110_admission_title_sheets.sql server/db/migrations/110.test.js
git commit -m "feat(inpatient): таблица титульного листа — миграция 110 (TITLE_SHEET_V1)"
```

---

### Task 3: Server module `rpc/title-sheet.js`

**Files:**
- Create: `server/services/rpc/title-sheet.js`
- Test: `server/services/rpc/title-sheet.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// server/services/rpc/title-sheet.test.js
// TITLE_SHEET_V1 — титульный лист: правила, роли, дописывание, карточка.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit } from './inpatient.js';
import { admissionTitleSheetGet, admissionTitleSheetSave, titleSheetCaseItem, SHEET_DUE_HOURS } from './title-sheet.js';
import { RpcError } from './inpatient-flow.js';

const admin     = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const nurse     = { id: 3, role: 'nurse' };
const doctor    = { id: 5, role: 'doctor' };
const cashier   = { id: 7, role: 'cashier' };
const senior    = { id: 9, role: 'nurse', extra_roles: ['senior_nurse'] };

function seed() {
    const db = openDb(':memory:');
    migrate(db);
    const users = [[1, 'admin1', 'admin'], [2, 'reg1', 'registrar'], [3, 'nurse1', 'nurse'], [5, 'doc1', 'doctor'], [7, 'cash1', 'cashier'], [9, 'senior1', 'nurse']];
    for (const [id, username, role] of users) {
        db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)').run(id, username, 'x', 'Сотрудник ' + username, role);
    }
    const patientId = db.prepare("INSERT INTO patients (full_name, mrn, date_of_birth, gender, phone) VALUES ('Иванов Иван Иванович','ID-1','1994-11-15','male','+998901112233')").run().lastInsertRowid;
    const wardId = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
    const bedId = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-1', ?, 'free')").run(wardId).lastInsertRowid;
    return { db, patientId, wardId, bedId };
}
function ordered(ctx) {
    return admissionOrderCreate(ctx.db, { patient_id: ctx.patientId, department: 'Терапия', admission_diagnosis: 'J18.9' }, registrar).admission;
}
function inBed(ctx) {
    const adm = ordered(ctx);
    return admissionAdmit(ctx.db, { admission_id: adm.id, bed_id: ctx.bedId }, nurse).admission;
}
const FULL = { height_cm: 172, weight_kg: '72,5', temp_c: 36.6, bp_sys: 120, bp_dia: 80, pulse_bpm: 72, pediculosis: 'none', sanitation: 'full' };

test('get: личные данные из карточки, лист пуст, срок — 2 часа от размещения', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const v = admissionTitleSheetGet(ctx.db, { admission_id: adm.id }, doctor);
    assert.equal(v.patient.full_name, 'Иванов Иван Иванович');
    assert.equal(v.patient.phone, '+998901112233');
    assert.equal(v.admission.bed_code, 'T-1');
    assert.equal(v.admission.ward_name, 'Терапия');
    assert.equal(v.sheet, null);
    assert.equal(v.complete, false);
    assert.equal(v.missing.length, 8);
    assert.equal(Date.parse(v.due_at) - Date.parse(adm.admitted_at), SHEET_DUE_HOURS * 3600 * 1000);
});

test('save: запятая принимается, ИМТ считается, лист полон, подпись ставится один раз', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const v = admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: FULL }, nurse);
    assert.equal(v.sheet.weight_kg, 72.5);
    assert.equal(v.bmi, 24.5);
    assert.equal(v.complete, true);
    assert.deepEqual(v.missing, []);
    assert.equal(v.sheet.filled_by, nurse.id);
    assert.ok(v.sheet.filled_at);
    const again = admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { note: 'спит' } }, senior);
    assert.equal(again.sheet.filled_by, nurse.id, 'подпись первого заполнения не переписывается');
    assert.equal(again.sheet.note, 'спит');
    assert.equal(again.sheet.height_cm, 172, 'незатронутые поля остались');
});

test('save: неполный лист сохраняется и называет, чего не хватает', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const v = admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { height_cm: 172, pediculosis: 'none' } }, nurse);
    assert.equal(v.complete, false);
    assert.deepEqual(v.missing, ['weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'sanitation']);
    assert.equal(v.sheet.filled_at, null);
});

test('save: невозможное значение отвергается словами, называющими поле', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const bad = [
        [{ height_cm: 2 }, /Рост: укажите от 30 до 250 см/],
        [{ weight_kg: 'много' }, /Вес: нужно число/],
        [{ pulse_bpm: 72.5 }, /Пульс: нужно целое число/],
        [{ bp_sys: 80, bp_dia: 120 }, /нижнее давление должно быть меньше верхнего/],
        [{ pediculosis: 'maybe' }, /Осмотр на педикулёз/],
        [{ sanitation: 'yes' }, /Санитарная обработка/],
    ];
    for (const [sheet, re] of bad) {
        assert.throws(() => admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet }, nurse),
            (e) => e instanceof RpcError && e.status === 400 && re.test(e.message), 'не отвергнуто: ' + JSON.stringify(sheet));
    }
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM admission_title_sheets').get().n, 0, 'отвергнутый лист не должен сохраняться');
});

test('save: исправления личных данных уходят в карточку, ФИО и дата рождения — нет', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const v = admissionTitleSheetSave(ctx.db, {
        admission_id: adm.id, sheet: {},
        patient: { phone: '+998900000000', address: 'Ташкент, Чиланзар 5', occupation: 'учитель', blood_type: 'O(I) Rh+', full_name: 'Другой', date_of_birth: '2000-01-01' },
    }, nurse);
    assert.equal(v.patient.phone, '+998900000000');
    assert.equal(v.patient.address, 'Ташкент, Чиланзар 5');
    assert.equal(v.patient.blood_type, 'O(I) Rh+');
    assert.equal(v.patient.full_name, 'Иванов Иван Иванович');
    assert.equal(v.patient.date_of_birth, '1994-11-15');
    const row = ctx.db.prepare('SELECT phone, address FROM patients WHERE id = ?').get(ctx.patientId);
    assert.equal(row.phone, '+998900000000');
    assert.throws(() => admissionTitleSheetSave(ctx.db, { admission_id: adm.id, patient: { gender: 'x' } }, nurse), /Пол/);
});

test('роли: пишут медсестра, старшая, администратор; врач и кассир — нет; читают все, кто ведёт историю', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    for (const who of [nurse, senior, admin]) admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { note: 'ok' } }, who);
    for (const who of [doctor, cashier, registrar]) {
        assert.throws(() => admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { note: 'x' } }, who),
            (e) => e instanceof RpcError && e.status === 403 && /медсестра, старшая медсестра, администратор/.test(e.message));
    }
    for (const who of [nurse, senior, admin, doctor]) admissionTitleSheetGet(ctx.db, { admission_id: adm.id }, who);
    assert.throws(() => admissionTitleSheetGet(ctx.db, { admission_id: adm.id }, cashier), (e) => e.status === 403);
});

test('до койки листа нет: у заявки его не сохранить', () => {
    const ctx = seed();
    const adm = ordered(ctx);
    assert.throws(() => admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: FULL }, nurse), /ещё не размещён/);
});

test('admission_admit с листом — одна операция: плохой лист не кладёт пациента, хороший кладёт и сохраняет', () => {
    const ctx = seed();
    const adm = ordered(ctx);
    assert.throws(() => admissionAdmit(ctx.db, { admission_id: adm.id, bed_id: ctx.bedId, title_sheet: { sheet: { height_cm: 2 } } }, nurse), /Рост/);
    assert.equal(ctx.db.prepare('SELECT status FROM admissions WHERE id = ?').get(adm.id).status, 'ordered', 'пациент не должен быть размещён');
    assert.equal(ctx.db.prepare('SELECT status FROM beds WHERE id = ?').get(ctx.bedId).status, 'free', 'койка не должна быть занята');

    const res = admissionAdmit(ctx.db, { admission_id: adm.id, bed_id: ctx.bedId, title_sheet: { sheet: FULL, patient: { phone: '+998911111111' } } }, nurse);
    assert.equal(res.admission.status, 'admitted');
    assert.equal(res.title_sheet.height_cm, 172);
    assert.equal(res.title_sheet.filled_by, nurse.id);
    assert.equal(ctx.db.prepare('SELECT phone FROM patients WHERE id = ?').get(ctx.patientId).phone, '+998911111111');
});

test('строка чек-листа: pending → overdue по часам, draft при неполном, published при полном', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const base = Date.parse(adm.admitted_at);
    const H = 3600 * 1000;
    const item = (now) => titleSheetCaseItem(ctx.db, ctx.db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id), base, now);
    assert.equal(item(base + 1 * H).state, 'pending');
    assert.equal(item(base + 3 * H).state, 'overdue');
    assert.equal(item(base + 1 * H).kind, 'title');
    assert.equal(item(base + 1 * H).order, -1);
    admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { height_cm: 172 } }, nurse);
    assert.equal(item(base + 1 * H).state, 'draft');
    assert.equal(item(base + 3 * H).state, 'overdue', 'неполный и просроченный — просрочен');
    admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: FULL }, nurse);
    const done = item(base + 3 * H);
    assert.equal(done.state, 'published');
    assert.ok(done.published_at);
    assert.equal(done.author_name, 'Сотрудник nurse1');
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `node --test server/services/rpc/title-sheet.test.js`

- [ ] **Step 3: Write the module**

```js
// server/services/rpc/title-sheet.js
// ═══════════════════════════════════════════════════════════════════════════
// TITLE_SHEET_V1 (2026-09-08) — ТИТУЛЬНЫЙ ЛИСТ ИСТОРИИ БОЛЕЗНИ
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «when request of hospitalization is accepted and patient is
// admitting to the bed, nurse should collect the title list, with personal
// information and anthropometric data of the patient, and it goes as a title
// list when history is collected».
//
// Титульный лист — документ МЕДСЕСТРЫ, а не врача: его заполняют при
// размещении на койке (admission_admit — тем же вызовом, в той же
// транзакции), дописывают из истории болезни, и он идёт первой страницей
// собранной истории (admission_case_file → title_sheet).
//
// Личные данные НЕ КОПИРУЮТСЯ (миграция 110): лист показывает их из
// `patients` и пишет исправления обратно — только разрешённые поля
// (PATIENT_FIELDS в shared/title-sheet-rules.js). ФИО и дату рождения лист не
// правит: это личность, её правят в карточке пациента.
//
// Правила чисел (диапазоны, обязательный состав, ИМТ) — в
// public/js/shared/title-sheet-rules.js, общем с экраном. Здесь — только
// СЛОВА отказов: они русские по той же причине, что и остальные REASONS
// сервера.
import { RpcError, loadAdmission } from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';
import {
  MEASURES, MEASURE_KEYS, PEDICULOSIS, SANITATION, PATIENT_FIELDS,
  numOrNull, bmiOf, sheetCompleteness,
} from '../../../public/js/shared/title-sheet-rules.js';

export const SHEET_READ_ROLES  = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];
export const SHEET_WRITE_ROLES = ['nurse', 'senior_nurse', 'admin'];
/** Срок на лист — как у согласия и осмотра приёмного врача (CASE_DOC_SET): два часа от размещения. */
export const SHEET_DUE_HOURS = 2;
export const TITLE_KIND = 'title';

const LABEL = {
  height_cm: ['Рост', 'см'],
  weight_kg: ['Вес', 'кг'],
  temp_c:    ['Температура', '°C'],
  bp_sys:    ['АД верхнее', 'мм рт. ст.'],
  bp_dia:    ['АД нижнее', 'мм рт. ст.'],
  pulse_bpm: ['Пульс', 'уд/мин'],
};
const PATIENT_MAX = {
  gender: 10, phone: 40, address: 300, national_id: 40, occupation: 200,
  emergency_contact_name: 200, emergency_contact_phone: 40, blood_type: 20, allergies: 1000,
};
const GENDERS = ['male', 'female', 'other'];
const MS_HOUR = 3600 * 1000;

function nowUtc(db) {
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
}
function isoOf(ms) {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function str(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}
function requireRead(user) {
  if (!hasAnyRole(user, SHEET_READ_ROLES)) throw new RpcError('Титульный лист — недоступно вашей роли.', 403);
}
function requireWrite(user) {
  if (!hasAnyRole(user, SHEET_WRITE_ROLES)) {
    throw new RpcError('Титульный лист — недоступно вашей роли. Это делает: медсестра, старшая медсестра, администратор.', 403);
  }
}

/** Одно измерение: число в диапазоне, null для пустого, отказ словами для остального. */
function parseMeasure(key, raw) {
  const [label, unit] = LABEL[key];
  const def = MEASURES[key];
  const n = numOrNull(raw);
  if (n === null) return null;
  if (Number.isNaN(n)) throw new RpcError(`${label}: нужно число.`, 400);
  if (def.int && !Number.isInteger(n)) throw new RpcError(`${label}: нужно целое число.`, 400);
  if (n < def.min || n > def.max) throw new RpcError(`${label}: укажите от ${def.min} до ${def.max} ${unit}.`, 400);
  return n;
}

export function loadSheet(db, admissionId) {
  return db.prepare(`
    SELECT s.*, u.full_name AS filled_by_name
      FROM admission_title_sheets s
      LEFT JOIN users u ON u.id = s.filled_by
     WHERE s.admission_id = ?`).get(admissionId) || null;
}

/** Всё, что нужно экрану и печати: обложка госпитализации, пациент, лист, ИМТ, полнота, срок. */
export function sheetView(db, adm) {
  const admission = db.prepare(`
    SELECT a.id, a.admission_no, a.status, a.department, a.admitted_at, a.admitted_by, a.discharged_at,
           a.admission_type, a.stay_mode, a.admission_diagnosis, a.chief_complaint,
           w.name AS ward_name, b.code AS bed_code, doc.full_name AS attending_name
      FROM admissions a
      LEFT JOIN wards w ON w.id = a.ward_id
      LEFT JOIN beds b ON b.id = a.bed_id
      LEFT JOIN users doc ON doc.id = a.attending_doctor_id
     WHERE a.id = ?`).get(adm.id);
  const patient = db.prepare(`
    SELECT id, full_name, mrn, date_of_birth, gender, phone, address, national_id, occupation,
           emergency_contact_name, emergency_contact_phone, blood_type, allergies
      FROM patients WHERE id = ?`).get(adm.patient_id) || null;
  const sheet = loadSheet(db, adm.id);
  const { complete, missing } = sheetCompleteness(sheet);
  // Точка отсчёта — размещение, и спрашивается она у состояния, не у колонки
  // (admitted_at заполнена и у заявки — см. admissionCaseDocs).
  const placed = !['ordered', 'cancelled'].includes(adm.status);
  const base = placed && adm.admitted_at ? Date.parse(adm.admitted_at) : NaN;
  return {
    admission, patient, sheet,
    bmi: sheet ? bmiOf(sheet.height_cm, sheet.weight_kg) : null,
    complete, missing,
    due_at: isoOf(Number.isFinite(base) ? base + SHEET_DUE_HOURS * MS_HOUR : null),
  };
}

/**
 * Сохранить лист (внутренняя половина — без проверки роли: её делает вызывающий
 * RPC, а admission_admit уже проверил право размещать). Поля, которых нет во
 * входе, не трогаются — так лист можно дописывать по одному полю.
 */
export function saveTitleSheet(db, adm, input, user) {
  if (adm.status === 'ordered') throw new RpcError('Титульный лист заполняют при размещении на койке — пациент ещё не размещён.', 400);
  if (adm.status === 'cancelled') throw new RpcError('Заявка отменена — титульный лист не нужен.', 400);

  const src = (input && input.sheet && typeof input.sheet === 'object') ? input.sheet : {};
  const existing = db.prepare('SELECT * FROM admission_title_sheets WHERE admission_id = ?').get(adm.id) || null;
  const next = Object.assign({
    referred_from: '', height_cm: null, weight_kg: null, temp_c: null, bp_sys: null, bp_dia: null, pulse_bpm: null,
    pediculosis: '', sanitation: '', note: '',
  }, existing || {});

  for (const key of MEASURE_KEYS) if (src[key] !== undefined) next[key] = parseMeasure(key, src[key]);
  if (src.pediculosis !== undefined) {
    const v = str(src.pediculosis, 10);
    if (!PEDICULOSIS.includes(v)) throw new RpcError('Осмотр на педикулёз и чесотку: выберите «не выявлено» или «выявлено».', 400);
    next.pediculosis = v;
  }
  if (src.sanitation !== undefined) {
    const v = str(src.sanitation, 10);
    if (!SANITATION.includes(v)) throw new RpcError('Санитарная обработка: выберите «полная», «частичная» или «не проводилась».', 400);
    next.sanitation = v;
  }
  if (src.referred_from !== undefined) next.referred_from = str(src.referred_from, 300);
  if (src.note !== undefined) next.note = str(src.note, 2000);
  if (next.bp_sys !== null && next.bp_dia !== null && next.bp_dia >= next.bp_sys) {
    throw new RpcError('АД: нижнее давление должно быть меньше верхнего.', 400);
  }

  const now = nowUtc(db);
  const { complete } = sheetCompleteness(next);
  // Подпись — кто ВПЕРВЫЕ заполнил лист целиком; дальше не переписывается.
  const filledBy = existing && existing.filled_at ? existing.filled_by : (complete ? ((user && user.id) || null) : null);
  const filledAt = existing && existing.filled_at ? existing.filled_at : (complete ? now : null);

  if (existing) {
    db.prepare(`
      UPDATE admission_title_sheets
         SET referred_from = ?, height_cm = ?, weight_kg = ?, temp_c = ?, bp_sys = ?, bp_dia = ?, pulse_bpm = ?,
             pediculosis = ?, sanitation = ?, note = ?, filled_by = ?, filled_at = ?, updated_at = ?
       WHERE id = ?`).run(
      next.referred_from, next.height_cm, next.weight_kg, next.temp_c, next.bp_sys, next.bp_dia, next.pulse_bpm,
      next.pediculosis, next.sanitation, next.note, filledBy, filledAt, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO admission_title_sheets
        (admission_id, referred_from, height_cm, weight_kg, temp_c, bp_sys, bp_dia, pulse_bpm,
         pediculosis, sanitation, note, filled_by, filled_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      adm.id, next.referred_from, next.height_cm, next.weight_kg, next.temp_c, next.bp_sys, next.bp_dia, next.pulse_bpm,
      next.pediculosis, next.sanitation, next.note, filledBy, filledAt, now, now);
  }

  // Исправления личных данных — В КАРТОЧКУ, и только разрешённые поля.
  const pin = (input && input.patient && typeof input.patient === 'object') ? input.patient : {};
  const sets = [];
  const vals = [];
  for (const f of PATIENT_FIELDS) {
    if (pin[f] === undefined) continue;
    const v = str(pin[f], PATIENT_MAX[f]);
    if (f === 'gender' && !GENDERS.includes(v)) throw new RpcError('Пол: выберите мужской, женский или другое.', 400);
    sets.push(`${f} = ?`);
    vals.push(v);
  }
  if (sets.length && adm.patient_id) {
    sets.push('updated_at = ?');
    vals.push(now, adm.patient_id);
    db.prepare(`UPDATE patients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return loadSheet(db, adm.id);
}

export function admissionTitleSheetGet(db, args, user) {
  requireRead(user);
  const adm = loadAdmission(db, args && args.admission_id);
  return sheetView(db, adm);
}

export function admissionTitleSheetSave(db, args, user) {
  requireWrite(user);
  const run = db.transaction(() => {
    const adm = loadAdmission(db, args && args.admission_id);
    saveTitleSheet(db, adm, args, user);
    return sheetView(db, adm);
  });
  return run();
}

/**
 * Строка чек-листа документов (admission_case_docs) — той же формы, что у
 * врачебных документов, чтобы список рисовал её той же строкой. Состояние:
 * полон — published (подпись = filled_at); есть неполная запись — draft;
 * ничего и срок вышел — overdue; иначе pending.
 */
export function titleSheetCaseItem(db, adm, baseMs, nowMs) {
  const row = loadSheet(db, adm.id);
  const { complete, missing } = sheetCompleteness(row);
  const dueAt = baseMs === null || baseMs === undefined ? null : baseMs + SHEET_DUE_HOURS * MS_HOUR;
  let state;
  if (row && complete) state = 'published';
  else if (dueAt !== null && nowMs > dueAt) state = 'overdue';
  else if (row) state = 'draft';
  else state = 'pending';
  return {
    kind: TITLE_KIND, group: 'nurse', order: -1, applies: true, required: true, state,
    due_rule: 'clock', due_at: isoOf(dueAt), period_hours: null, periods_missing: 0,
    entries: row && complete ? 1 : 0, block: null,
    review_id: null,
    published_at: row && complete ? row.filled_at : null,
    author_name: row && complete ? (row.filled_by_name || '') : '',
    revisions: [], revision_count: 0,
    draft_id: null, has_draft: !!row && !complete,
    missing,
  };
}
```

- [ ] **Step 4: Register the RPCs and extend `admission_admit`**

`server/services/rpc/index.js` — next to the `inpatient-flow.js` import (line 12) add:

```js
import { admissionTitleSheetGet, admissionTitleSheetSave } from './title-sheet.js';   // TITLE_SHEET_V1
```

and in the map, right after the `admission_admit:` line (211):

```js
  admission_title_sheet_get:      (db, args, user) => admissionTitleSheetGet(db, args, user),    // TITLE_SHEET_V1
  admission_title_sheet_save:     (db, args, user) => admissionTitleSheetSave(db, args, user),
```

`server/services/rpc/inpatient.js` — add the import after line 23 (`import { isDoctorRow } …`):

```js
import { saveTitleSheet } from './title-sheet.js';   // TITLE_SHEET_V1 — лист в той же транзакции, что и койка
```

and in `admissionAdmit`, replace the final `return { admission: res.admission, bed: … }` inside the transaction with:

```js
    // TITLE_SHEET_V1 — титульный лист медсестры В ТОЙ ЖЕ транзакции: плохое
    // значение в листе откатывает и койку, чтобы пациент не оказался размещён
    // без листа «наполовину». Без листа (старый вызов) — как раньше.
    let titleSheet = null;
    if (args.title_sheet && typeof args.title_sheet === 'object') {
      titleSheet = saveTitleSheet(db, res.admission, args.title_sheet, user);
    }

    return { admission: res.admission, bed: db.prepare('SELECT * FROM beds WHERE id = ?').get(bedId), title_sheet: titleSheet };
```

- [ ] **Step 5: Run — expect PASS (9/9)**

Run: `node --test server/services/rpc/title-sheet.test.js`

- [ ] **Step 6: Run the neighbours to be sure nothing moved**

Run: `node --test server/services/rpc/inpatient.test.js server/services/rpc/inpatient-flow.test.js server/services/rpc/inpatient-reviews.test.js`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/services/rpc/title-sheet.js server/services/rpc/title-sheet.test.js server/services/rpc/index.js server/services/rpc/inpatient.js
git commit -m "feat(inpatient): титульный лист — RPC, правила, размещение одним вызовом (TITLE_SHEET_V1)"
```

---

### Task 4: Case-docs integration (server)

**Files:**
- Modify: `server/services/rpc/inpatient-reviews.js` (`admissionCaseDocs` ~851–1040, `admissionCaseFile` ~1119+)
- Test: `server/services/rpc/case-docs.test.js` (append)

- [ ] **Step 1: Append failing tests to `case-docs.test.js`**

```js
// ── TITLE_SHEET_V1 ─────────────────────────────────────────────────────────
import { admissionTitleSheetSave } from './title-sheet.js';

test('TITLE_SHEET_V1: титульный лист — первая строка чек-листа, считается в прогрессе, но не «следующий шаг» врача', () => {
  const ctx = seed();
  const adm = inBedHoursAgo(ctx, 1);
  const docs = admissionCaseDocs(ctx.db, { admission_id: adm.id }, doctor);
  assert.equal(docs.items[0].kind, 'title');
  assert.equal(docs.items[0].state, 'pending');
  assert.equal(docs.items[0].order, -1);
  assert.notEqual(docs.next_kind, 'title', '«следующий шаг» — врачебный, лист — дело медсестры');
  assert.equal(docs.progress.total, CASE_DOC_SET.filter((d) => d.due !== 'surgical').length + 1 - 1 /* interim не обязателен в первый день */,
    'лист должен считаться в обязательном наборе');
  assert.ok(docs.discharge_gate.incomplete.includes('title'));

  const late = admissionCaseDocs(ctx.db, { admission_id: adm.id, now: at(3) }, doctor);
  assert.equal(late.items[0].state, 'overdue');

  admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: {
    height_cm: 172, weight_kg: 80, temp_c: 36.6, bp_sys: 120, bp_dia: 80, pulse_bpm: 72, pediculosis: 'none', sanitation: 'full',
  } }, nurse);
  const done = admissionCaseDocs(ctx.db, { admission_id: adm.id, now: at(3) }, doctor);
  assert.equal(done.items[0].state, 'published');
  assert.ok(!done.discharge_gate.incomplete.includes('title'));
});

test('TITLE_SHEET_V1: врачебная запись рода title не принимается — это не документ врача', () => {
  const ctx = seed();
  const adm = inBedHoursAgo(ctx, 1);
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'title', body: 'x', publish: true }, headDoctor),
    (e) => e instanceof RpcError && /Неизвестный род/.test(e.message));
});

test('TITLE_SHEET_V1: собранная история несёт титульный лист — тот же снимок идёт на бумагу', () => {
  const ctx = seed();
  const adm = inBedHoursAgo(ctx, 1);
  admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { height_cm: 172, weight_kg: 80 } }, nurse);
  const file = admissionCaseFile(ctx.db, { admission_id: adm.id }, doctor);
  assert.ok(file.title_sheet, 'в снимке нет титульного листа');
  assert.equal(file.title_sheet.sheet.height_cm, 172);
  assert.equal(file.title_sheet.bmi, 27.0);
  assert.equal(file.title_sheet.patient.full_name, 'Салимбоев Шухрат');
  assert.equal(file.title_sheet.complete, false);
});
```

Note: the `progress.total` expectation depends on how many `CASE_DOC_SET` entries are required on day one; if the assertion above is off by one when first run, replace it with the simpler invariant `assert.equal(docs.progress.total, before.progress.total + 1)` where `before` is computed by temporarily filtering — **preferred form**:

```js
  const requiredDoctorDocs = docs.items.slice(1).filter((it) => it.required).length;
  assert.equal(docs.progress.total, requiredDoctorDocs + 1, 'лист должен считаться в обязательном наборе');
```

Use the preferred form; delete the first `progress.total` assertion.

- [ ] **Step 2: Run — expect the three new tests to FAIL**

Run: `node --test server/services/rpc/case-docs.test.js`

- [ ] **Step 3: Implement in `inpatient-reviews.js`**

Add the import after line 60 (`import { hasAnyRole, effectiveRoles } …`):

```js
import { titleSheetCaseItem, sheetView } from './title-sheet.js';   // TITLE_SHEET_V1
```

In `admissionCaseDocs`, right after the `const items = CASE_DOC_SET.map(…)` block ends (just before the `// «Прочие документы»` comment), add:

```js
  // TITLE_SHEET_V1 — титульный лист медсестры: ПЕРВОЙ строкой, в прогрессе и в
  // списке «не оформлено», но НЕ в «следующем шаге»: «следующий» — одно
  // заметное действие ВРАЧА, а лист — дело поста.
  const titleItem = titleSheetCaseItem(db, adm, base, now);
```

Replace the `progress` block and the `incomplete` line:

```js
  const allItems = [titleItem, ...items];
  const progress = {
    done: allItems.filter((it) => it.required && it.state === 'published').length,
    total: allItems.filter((it) => it.required).length,
    overdue: allItems.filter((it) => it.state === 'overdue').length,
    draft: allItems.filter((it) => it.state === 'draft' || it.state === 'next').length,
  };
```

```js
  const incomplete = allItems.filter((it) => it.required && it.state !== 'published').map((it) => it.kind);
```

and in the return object change `items,` to `items: allItems,`.

In `admissionCaseFile`, find the `return {` of the file object (it contains `cover`, `documents`, `gaps`, …) and add one property:

```js
    title_sheet: sheetView(db, adm),   // TITLE_SHEET_V1 — первая страница собранной истории
```

- [ ] **Step 4: Run — expect PASS**

Run: `node --test server/services/rpc/case-docs.test.js server/services/rpc/case-file-save.test.js server/services/rpc/title-sheet.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/services/rpc/inpatient-reviews.js server/services/rpc/case-docs.test.js
git commit -m "feat(inpatient): титульный лист — первая строка чек-листа и первая страница собранной истории"
```

---

### Task 5: Move the modal chrome out of `admission-modal.js`

Why: `title-sheet.js` needs `inpatientModal`/`patientAnchor`, and `admission-modal.js` needs `openAdmissionTitleSheetModal` — importing each other would be a cycle the codebase deliberately avoids.

**Files:**
- Create: `public/js/admin/views/inpatient-modal.js`
- Modify: `public/js/admin/views/admission-modal.js:90-145` (inpatientModal) and `:166-192` (patientAnchor)

- [ ] **Step 1: Create `inpatient-modal.js` with the two functions moved verbatim**

```js
// INPATIENT_MODAL_V1 — окно и «якорь пациента» стационара, вынесены из
// admission-modal.js (TITLE_SHEET_V1): титульному листу нужно то же окно, а
// окну койки нужен титульный лист — импорт друг в друга был бы кольцом.
import { h, Icon, toast, initials } from '../ui.js';
import { tr } from '../i18n.js';

export function inpatientModal(title, icon, bodyEls, submitLabel, onSubmit, { width = 520, secondaryLabel = null, onSecondary = null } = {}) {
    …(lines 90–145 of admission-modal.js, unchanged)…
}

export function patientAnchor(name, sub) {
    …(lines 166–192 of admission-modal.js, unchanged)…
}
```

- [ ] **Step 2: In `admission-modal.js` replace both function bodies with re-exports**

Delete lines 90–145 and 166–192; add after the `import { tr, trf } …` line:

```js
import { inpatientModal, patientAnchor } from './inpatient-modal.js';   // TITLE_SHEET_V1 — вынесено, чтобы не было кольца
export { inpatientModal, patientAnchor };
```

Keep `const modal = inpatientModal;`. Remove `initials` from the `../ui.js` import if nothing else in the file uses it (`grep -n "initials(" admission-modal.js`).

- [ ] **Step 3: Syntax + existing tests**

Run: `node --check public/js/admin/views/admission-modal.js && node --check public/js/admin/views/inpatient-modal.js && node --test public/js/admin/__tests__/admissions-window.test.mjs public/js/admin/__tests__/inpatient-route.test.mjs public/js/admin/__tests__/inpatient-section.test.mjs`
Expected: all pass (pure move).

- [ ] **Step 4: Commit**

```bash
git add public/js/admin/views/inpatient-modal.js public/js/admin/views/admission-modal.js
git commit -m "refactor(inpatient): окно и якорь пациента — отдельный модуль (без кольца импортов)"
```

---

### Task 6: Print section `title-sheet-print.js`

**Files:**
- Create: `public/js/admin/views/title-sheet-print.js`
- Test: `public/js/admin/__tests__/title-sheet.test.mjs` (first tests; the file grows in Task 7)

- [ ] **Step 1: Write the failing test**

```js
// public/js/admin/__tests__/title-sheet.test.mjs
// TITLE_SHEET_V1 — титульный лист: печать, форма, окно размещения, редактор.
import test from 'node:test';
import assert from 'node:assert/strict';

const VIEW = {
    admission: { id: 11, admission_no: 'H-7', status: 'admitted', department: 'Терапия', admitted_at: '2026-09-08T09:00:00Z',
        admission_type: 'emergency', admission_diagnosis: 'J18.9', chief_complaint: 'кашель', ward_name: 'Терапия', bed_code: 'T-2' },
    patient: { id: 101, full_name: 'Иванов Иван Иванович', mrn: 'ID-1', date_of_birth: '1994-11-15', gender: 'male', phone: '+998901112233',
        address: 'Ташкент', national_id: 'AA1234567', occupation: 'учитель', emergency_contact_name: 'Иванова А.', emergency_contact_phone: '+998900000000',
        blood_type: 'O(I) Rh+', allergies: 'пенициллин' },
    sheet: { height_cm: 172, weight_kg: 80, temp_c: 36.6, bp_sys: 120, bp_dia: 80, pulse_bpm: 72, pediculosis: 'none', sanitation: 'full',
        referred_from: 'Поликлиника №3', note: '', filled_by_name: 'Медсестра Петрова', filled_at: '2026-09-08T09:20:00Z' },
    bmi: 27.0, complete: true, missing: [],
};

test('печать: шапка клиники, номер истории, три блока, подпись медсестры', async () => {
    globalThis.window = { CLINIC: { name_ru: 'Клиника Тест', legal_name: 'ООО Тест', address: 'Ташкент, ул. Мира 1', phone: '+998 71 200 00 00', logo_url: '' } };
    const { titleSheetPrintSection, titleSheetPrintHtml } = await import('../views/title-sheet-print.js');
    const s = titleSheetPrintSection(VIEW);
    for (const piece of ['Клиника Тест', 'ООО Тест', 'ул. Мира 1', 'История болезни № H-7', 'Титульный лист',
        'Иванов Иван Иванович', '15.11.1994', 'Мужской', 'AA1234567', 'O(I) Rh+', 'пенициллин',
        'Экстренная', 'J18.9', 'Поликлиника №3', 'T-2',
        '172', '80', '27', '36.6', '120/80', '72', 'не выявлено', 'полная',
        'Медсестра Петрова']) {
        assert.ok(s.includes(piece), 'в печати нет: ' + piece);
    }
    const html = titleSheetPrintHtml(VIEW, { fontFaceCss: '/*font*/' });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('/*font*/'));
    assert.ok(html.includes('@page { size: A4'));
});

test('печать: незаполненный лист говорит об этом, а не рисует пустые клетки как факт', async () => {
    const { titleSheetPrintSection } = await import('../views/title-sheet-print.js');
    const s = titleSheetPrintSection(Object.assign({}, VIEW, { sheet: null, bmi: null, complete: false, missing: ['height_cm'] }));
    assert.ok(s.includes('Титульный лист не заполнен'));
    assert.ok(!s.includes('Медсестра Петрова'));
    assert.ok(s.includes('Иванов Иван Иванович'), 'личные данные из карточки печатаются и без листа');
});

test('печать: значения экранируются', async () => {
    const { titleSheetPrintSection } = await import('../views/title-sheet-print.js');
    const s = titleSheetPrintSection(Object.assign({}, VIEW, { patient: Object.assign({}, VIEW.patient, { address: '<b>x</b>' }) }));
    assert.ok(s.includes('&lt;b&gt;x&lt;/b&gt;'));
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `node --test public/js/admin/__tests__/title-sheet.test.mjs`

- [ ] **Step 3: Write the print module**

```js
// public/js/admin/views/title-sheet-print.js
// TITLE_SHEET_V1 — титульный лист НА БУМАГЕ: сам по себе («Печать» на листе) и
// первой страницей собранной истории болезни (case-docs.js, caseFilePrintHtml).
//
// Отдельный модуль без окон и запросов: его импортируют и case-docs.js, и
// title-sheet.js, а те друг друга — нет. Шапка клиники — та же, что у листа на
// экране (a4-letterhead.js → window.CLINIC): бумага и экран показывают одну
// клинику.
import { tr, trf } from '../i18n.js';
import { fmtDate, fmtDateTime } from '../ui.js';
import { clinicLetterheadData } from './a4-letterhead.js';

export function esc(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const GENDER = { male: 'Мужской', female: 'Женский', other: 'Другое' };
const PEDICULOSIS_WORD = { none: 'не выявлено', found: 'выявлено' };
const SANITATION_WORD = { full: 'полная', partial: 'частичная', none: 'не проводилась' };

export function genderWord(g) { return GENDER[g] ? tr(GENDER[g]) : ''; }
export function pediculosisWord(v) { return PEDICULOSIS_WORD[v] ? tr(PEDICULOSIS_WORD[v]) : ''; }
export function sanitationWord(v) { return SANITATION_WORD[v] ? tr(SANITATION_WORD[v]) : ''; }

const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v || '—')}</span></div>`;
const num = (v) => (v === null || v === undefined || v === '' ? '' : String(v));

/**
 * Лист как <section>: шапка клиники, заголовок, три блока, подпись.
 * @param {{admission:object, patient:object, sheet:object|null, bmi:number|null, complete:boolean}} view
 * @param {{extra?: string}} opts — HTML, который сборка истории кладёт под лист (пробелы комплекта).
 */
export function titleSheetPrintSection(view, { extra = '' } = {}) {
    const a = (view && view.admission) || {};
    const p = (view && view.patient) || {};
    const s = (view && view.sheet) || null;
    const d = clinicLetterheadData();
    const placed = a.admitted_at && !['ordered', 'cancelled'].includes(a.status);
    const bp = s && s.bp_sys != null && s.bp_dia != null ? `${s.bp_sys}/${s.bp_dia}` : '';
    const sign = s && view.complete
        ? `<div class="sign">${esc(trf('Титульный лист заполнил(а): {who} · {when}', { who: s.filled_by_name || '', when: s.filled_at ? fmtDateTime(s.filled_at) : '' }))}</div>`
        : `<div class="sign warn">${esc(tr('Титульный лист не заполнен'))}</div>`;

    return `
<section class="ts">
  <div class="ts-band"></div>
  <div class="ts-head">
    <div class="ts-clinic">
      ${d.logo ? `<img class="ts-logo" src="${esc(d.logo)}" alt="">` : ''}
      <div><b>${esc(d.name)}</b>${d.legal ? `<small>${esc(d.legal)}</small>` : ''}${d.addr ? `<small>${esc(d.addr)}</small>` : ''}${d.phone ? `<small>${esc(d.phone)}</small>` : ''}</div>
    </div>
    <div class="ts-doc">
      <h1>${esc(a.admission_no ? trf('История болезни № {no}', { no: a.admission_no }) : tr('История болезни'))}</h1>
      <div class="ts-sub">${esc(tr('Титульный лист'))}</div>
    </div>
  </div>
  <h2>${esc(tr('Пациент'))}</h2>
  <div class="grid">
    ${kv(tr('ФИО'), p.full_name)}
    ${kv(tr('Дата рождения'), p.date_of_birth ? fmtDate(p.date_of_birth) : '')}
    ${kv(tr('Пол'), genderWord(p.gender))}
    ${kv(tr('Телефон'), p.phone)}
    ${kv(tr('Адрес'), p.address)}
    ${kv(tr('Паспорт / ID'), p.national_id)}
    ${kv(tr('Место работы'), p.occupation)}
    ${kv(tr('Контактное лицо'), [p.emergency_contact_name, p.emergency_contact_phone].filter(Boolean).join(' · '))}
    ${kv(tr('Группа крови и резус'), p.blood_type && p.blood_type !== 'unknown' ? p.blood_type : '')}
    ${kv(tr('Аллергии'), p.allergies)}
  </div>
  <h2>${esc(tr('Поступление'))}</h2>
  <div class="grid">
    ${kv(tr('Дата и время'), placed ? fmtDateTime(a.admitted_at) : '')}
    ${kv(tr('Отделение'), a.department)}
    ${kv(tr('Палата · койка'), [a.ward_name, a.bed_code].filter(Boolean).join(' · '))}
    ${kv(tr('Вид госпитализации'), a.admission_type === 'emergency' ? tr('Экстренная') : tr('Плановая'))}
    ${kv(tr('Диагноз при направлении'), a.admission_diagnosis)}
    ${kv(tr('Жалобы'), a.chief_complaint)}
    ${kv(tr('Кем направлен'), s ? s.referred_from : '')}
    ${kv(tr('Лечащий врач'), a.attending_name)}
  </div>
  <h2>${esc(tr('Осмотр медсестры при поступлении'))}</h2>
  <div class="grid">
    ${kv(tr('Рост, см'), s ? num(s.height_cm) : '')}
    ${kv(tr('Вес, кг'), s ? num(s.weight_kg) : '')}
    ${kv(tr('ИМТ'), num(view && view.bmi))}
    ${kv(tr('Температура, °C'), s ? num(s.temp_c) : '')}
    ${kv(tr('АД, мм рт. ст.'), bp)}
    ${kv(tr('Пульс, уд/мин'), s ? num(s.pulse_bpm) : '')}
    ${kv(tr('Осмотр на педикулёз и чесотку'), s ? pediculosisWord(s.pediculosis) : '')}
    ${kv(tr('Санитарная обработка'), s ? sanitationWord(s.sanitation) : '')}
    ${kv(tr('Примечание'), s ? s.note : '')}
  </div>
  ${sign}
  ${extra}
</section>`;
}

export function titleSheetPrintCss() {
    return `
.ts { page-break-after: always; }
.ts-band { height: 6px; background: #1f7a72; border-radius: 3px; margin-bottom: 14px; }
.ts-head { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; border-bottom: 2px solid #16232b; padding-bottom: 12px; margin-bottom: 14px; }
.ts-clinic { display: flex; gap: 12px; align-items: flex-start; font-size: 12px; color: #55636d; }
.ts-clinic b { display: block; font-size: 15px; color: #16232b; margin-bottom: 2px; }
.ts-clinic small { display: block; font-size: 11.5px; }
.ts-logo { max-height: 48px; max-width: 140px; object-fit: contain; }
.ts-doc { text-align: right; }
.ts-doc h1 { font-size: 20px; margin: 0; }
.ts-sub { font-size: 13px; font-weight: 600; color: #55636d; margin-top: 2px; }
.ts h2 { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: #55636d; margin: 14px 0 6px; }
.ts .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; }
.ts .kv { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px dotted #d3d9de; font-size: 13px; }
.ts .kv .k { color: #55636d; min-width: 150px; }
.ts .kv .v { font-weight: 600; }
.ts .sign { margin-top: 14px; font-size: 12px; color: #55636d; text-align: right; }
.ts .sign.warn { color: #b45309; font-weight: 600; }
`;
}

/** Лист отдельной страницей — кнопка «Печать» на самом листе. */
export function titleSheetPrintHtml(view, { fontFaceCss = '' } = {}) {
    const a = (view && view.admission) || {};
    return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(tr('Титульный лист'))} · ${esc(a.admission_no || '')}</title>
<style>
${fontFaceCss}
@page { size: A4; margin: 14mm; }
body { font-family: 'Onest', -apple-system, 'Segoe UI', Roboto, sans-serif; color: #16232b; margin: 0; }
${titleSheetPrintCss()}
.ts { page-break-after: auto; }
</style></head><body>
${titleSheetPrintSection(view)}
<script>window.onload=function(){(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){try{window.focus();window.print();}catch(e){}});};</scr` + `ipt>
</body></html>`;
}
```

- [ ] **Step 4: Run — expect PASS (3/3)**

Run: `node --test public/js/admin/__tests__/title-sheet.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add public/js/admin/views/title-sheet-print.js public/js/admin/__tests__/title-sheet.test.mjs
git commit -m "feat(inpatient): титульный лист на бумаге — шапка клиники, три блока, подпись"
```

---

### Task 7: Form, placement modal, editor — `title-sheet.js`

**Files:**
- Create: `public/js/admin/views/title-sheet.js`
- Modify: `public/css/admin-views.css` (append)
- Test: `public/js/admin/__tests__/title-sheet.test.mjs` (append; needs the fake DOM — copy the harness block from `admissions-window.test.mjs` lines 1–125: `FakeNode`, `mkEl`, `BODY`, `document`, `window`, `fetch` stub with `rpcCalls`)

- [ ] **Step 1: Append failing tests (after installing the fake DOM harness at the top of the file, before the print tests, exactly as `admissions-window.test.mjs` does — including `globalThis.fetch` returning `ok({...})` for `admission_title_sheet_get` → `VIEW` with `sheet: null`, `admission_admit` → `{ admission: { id: 11, status: 'admitted' }, title_sheet: body.title_sheet ? { height_cm: 172 } : null }`, `admission_title_sheet_save` → `Object.assign({}, VIEW, { complete: true })`)**

```js
const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const inputs = (root) => walk(root).filter((e) => e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT');
const byPlaceholder = (root, ph) => inputs(root).find((e) => (e.attrs.placeholder || '') === ph);
const settle = () => new Promise((r) => setTimeout(r, 30));

test('форма: личные данные подставляются из карточки, ИМТ считается по мере ввода, чтение отдаёт лист и пациента', async () => {
    const { titleSheetForm } = await import('../views/title-sheet.js');
    const form = titleSheetForm({ bed: { id: 6, code: 'T-2', ward_name: 'Терапия' } });
    form.fill(Object.assign({}, VIEW, { sheet: null, bmi: null }));
    const root = mkEl('div');
    for (const f of form.fields) root.appendChild(f);
    assert.equal(form.inputs.phone.value, '+998901112233');
    assert.ok(textOf(root).includes('T-2'), 'палата · койка из выбранной койки');
    assert.ok(textOf(root).includes('Экстренная'));

    form.inputs.height.value = '172';
    form.inputs.height.dispatchEvent({ type: 'input' });
    form.inputs.weight.value = '72,5';
    form.inputs.weight.dispatchEvent({ type: 'input' });
    assert.equal(form.inputs.bmi.value, '24.5');

    const ped = walk(root).find((e) => e.tagName === 'INPUT' && e.attrs.type === 'radio' && e.attrs.value === 'none');
    ped.dispatchEvent({ type: 'change' });
    const out = form.read();
    assert.equal(out.sheet.height_cm, '172');
    assert.equal(out.sheet.weight_kg, '72,5');
    assert.equal(out.sheet.pediculosis, 'none');
    assert.equal(out.sheet.sanitation, '');
    assert.equal(out.patient.phone, '+998901112233');
    assert.equal(out.patient.gender, 'male');
    assert.ok(!('full_name' in out.patient), 'ФИО лист не отправляет');
});

test('окно размещения: «Положить» шлёт admission_admit с койкой и листом; «Назад» зовёт onBack', async () => {
    const { openAdmissionTitleSheetModal } = await import('../views/title-sheet.js');
    rpcCalls.length = 0;
    let done = 0; let back = 0;
    openAdmissionTitleSheetModal({
        admission: { id: 11, status: 'ordered', department: 'Терапия', patients: { full_name: 'Иванов Иван Иванович', mrn: 'ID-1' } },
        bed: { id: 6, code: 'T-2', ward_name: 'Терапия' },
        onDone: async () => { done += 1; }, onBack: () => { back += 1; },
    });
    await settle();
    const overlay = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(overlay).includes('Титульный лист'));
    assert.ok(textOf(overlay).includes('Иванов Иван Иванович'));
    const height = byPlaceholder(overlay, 'см');
    height.value = '172';
    findBtn(overlay, 'Положить').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'admission_admit');
    assert.ok(call, 'admission_admit не вызван');
    assert.equal(call.args.admission_id, 11);
    assert.equal(call.args.bed_id, 6);
    assert.equal(call.args.title_sheet.sheet.height_cm, '172');
    assert.equal(done, 1);

    rpcCalls.length = 0;
    openAdmissionTitleSheetModal({ admission: { id: 11, status: 'ordered', patients: {} }, bed: { id: 6, code: 'T-2' }, onBack: () => { back += 1; } });
    await settle();
    findBtn(BODY.children[BODY.children.length - 1], 'Назад').click();
    await settle();
    assert.equal(back, 1);
});

test('редактор в истории болезни: «Сохранить» шлёт admission_title_sheet_save, есть «Печать»', async () => {
    const { buildTitleSheetEditor } = await import('../views/title-sheet.js');
    rpcCalls.length = 0;
    let done = 0;
    const ed = buildTitleSheetEditor({ admission: { id: 11 }, onDone: async () => { done += 1; } });
    await settle();
    assert.equal(ed.title, 'Титульный лист');
    assert.equal(ed.submitLabel, 'Сохранить');
    assert.equal(ed.secondaryLabel, 'Печать');
    const root = mkEl('div');
    for (const f of ed.fields) root.appendChild(f);
    assert.equal(byPlaceholder(root, 'см').value, '', 'листа ещё нет — поле пустое');
    byPlaceholder(root, 'см').value = '170';
    const ok = await ed.submit();
    assert.equal(ok, true);
    const call = rpcCalls.find((c) => c.name === 'admission_title_sheet_save');
    assert.ok(call);
    assert.equal(call.args.admission_id, 11);
    assert.equal(call.args.sheet.height_cm, '170');
    assert.equal(done, 1);
});
```

- [ ] **Step 2: Run — expect the three new tests to FAIL (module not found)**

Run: `node --test public/js/admin/__tests__/title-sheet.test.mjs`

- [ ] **Step 3: Write `title-sheet.js`**

```js
// public/js/admin/views/title-sheet.js
// ═══════════════════════════════════════════════════════════════════════════
// TITLE_SHEET_V1 — ТИТУЛЬНЫЙ ЛИСТ НА ЭКРАНЕ
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «when request of hospitalization is accepted and patient is
// admitting to the bed, nurse should collect the title list, with personal
// information and anthropometric data of the patient, and it goes as a title
// list when history is collected». Решения владельца: лист — В ТОМ ЖЕ шаге,
// что и койка (пустые измерения допустимы и дописываются позже); измерения —
// рост, вес, ИМТ, температура, АД, пульс + осмотр на педикулёз и санобработка.
//
// Одна форма (titleSheetForm) — два места: окно размещения (после выбора
// койки; «Положить» шлёт admission_admit с листом — одним вызовом) и редактор
// в истории болезни (buildTitleSheetEditor — той же формы, что
// buildReviewEditor, чтобы case-workspace рисовал его тем же листом A4).
//
// Числа проверяет СЕРВЕР (rpc/title-sheet.js) и отвечает словами, называющими
// поле; экран лишь считает ИМТ по мере ввода (shared/title-sheet-rules.js).
import { supabase } from '../../supabase.js';
import { h, toast, field, fmtDate, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { inpatientModal, patientAnchor } from './inpatient-modal.js';
import { a4Sheet } from './a4-letterhead.js';
import { bmiOf, sheetCompleteness } from '../../shared/title-sheet-rules.js';
import { titleSheetPrintHtml } from './title-sheet-print.js';

export const TITLE_SHEET_KIND = 'title';

const val = (el) => String(el.value === null || el.value === undefined ? '' : el.value).trim();

/**
 * Форма листа. Возвращает поля для листа A4, fill(view) и read() → {sheet, patient}.
 * @param {{bed?: {id:number, code:string, ward_name?:string}|null}} opts — койка, выбранная в окне размещения.
 */
export function titleSheetForm({ bed = null } = {}) {
    const inp = (attrs = {}) => h('input', Object.assign({ type: 'text' }, attrs));
    const fullName = inp({ readonly: '' });
    const dob      = inp({ readonly: '' });
    const gender   = h('select', null,
        ...[['male', 'Мужской'], ['female', 'Женский'], ['other', 'Другое']].map(([v, l]) => h('option', { value: v }, tr(l))));
    const phone      = inp({ inputmode: 'tel' });
    const address    = inp();
    const nationalId = inp();
    const occupation = inp();
    const ecName     = inp();
    const ecPhone    = inp({ inputmode: 'tel' });
    const blood      = inp({ placeholder: 'напр. O(I) Rh+' });
    const allergies  = h('textarea', { rows: '2' });
    const referred   = inp();
    const height = inp({ inputmode: 'decimal', placeholder: 'см' });
    const weight = inp({ inputmode: 'decimal', placeholder: 'кг' });
    const bmi    = inp({ readonly: '', class: 'ts-bmi' });
    const temp   = inp({ inputmode: 'decimal', placeholder: '°C' });
    const bpSys  = inp({ inputmode: 'numeric', placeholder: 'верхнее' });
    const bpDia  = inp({ inputmode: 'numeric', placeholder: 'нижнее' });
    const pulse  = inp({ inputmode: 'numeric', placeholder: 'уд/мин' });
    const note   = h('textarea', { rows: '2' });

    // Ответы медсестры — радиокнопки; выбранное держим в замыкании, а не
    // спрашиваем DOM: проверка «checked» по группе радио на разных браузерах
    // и в тестовой обвязке ведёт себя по-разному, а замыкание — одинаково.
    const picked = { pediculosis: '', sanitation: '' };
    const uid = Math.random().toString(36).slice(2, 8);
    const radioEls = [];
    const radios = (key, options) => h('div', { class: 'ts-radios' }, ...options.map(([v, label]) => {
        const r = h('input', { type: 'radio', name: 'ts-' + key + '-' + uid, value: v, onchange: () => { picked[key] = v; } });
        r._tsKey = key; r._tsValue = v;
        radioEls.push(r);
        return h('label', null, r, ' ', tr(label));
    }));
    const pedRadios = radios('pediculosis', [['none', 'не выявлено'], ['found', 'выявлено']]);
    const sanRadios = radios('sanitation', [['full', 'полная'], ['partial', 'частичная'], ['none', 'не проводилась']]);

    const recalc = () => { const b = bmiOf(val(height), val(weight)); bmi.value = b === null ? '' : String(b); };
    height.addEventListener('input', recalc);
    weight.addEventListener('input', recalc);

    const info = {};
    const infoRow = (key, label) => {
        info[key] = h('span', { class: 'ts-v' }, '—');
        return h('div', { class: 'ts-kv' }, h('span', { class: 'ts-k' }, tr(label)), info[key]);
    };
    const block = (title, ...kids) => h('div', { class: 'ts-block' },
        h('div', { class: 'ts-block-t' }, tr(title)),
        h('div', { class: 'ts-grid' }, ...kids));

    const fields = [
        block('Пациент',
            field(tr('ФИО'), fullName),
            field(tr('Дата рождения'), dob),
            field(tr('Пол'), gender),
            field(tr('Телефон'), phone),
            field(tr('Адрес'), address),
            field(tr('Паспорт / ID'), nationalId),
            field(tr('Место работы'), occupation),
            field(tr('Контактное лицо'), ecName),
            field(tr('Телефон контактного лица'), ecPhone),
            field(tr('Группа крови и резус'), blood),
            field(tr('Аллергии'), allergies)),
        h('div', { class: 'muted ts-hint' }, tr('ФИО и дата рождения исправляются в карточке пациента.')),
        block('Поступление',
            infoRow('admitted_at', 'Дата и время'),
            infoRow('department', 'Отделение'),
            infoRow('place', 'Палата · койка'),
            infoRow('type', 'Вид госпитализации'),
            infoRow('diagnosis', 'Диагноз при направлении'),
            infoRow('complaint', 'Жалобы'),
            field(tr('Кем направлен'), referred)),
        block('Осмотр медсестры при поступлении',
            field(tr('Рост, см'), height),
            field(tr('Вес, кг'), weight),
            field(tr('ИМТ'), bmi),
            field(tr('Температура, °C'), temp),
            field(tr('АД, мм рт. ст.'), h('div', { class: 'ts-bp' }, bpSys, h('span', null, '/'), bpDia)),
            field(tr('Пульс, уд/мин'), pulse),
            field(tr('Осмотр на педикулёз и чесотку'), pedRadios),
            field(tr('Санитарная обработка'), sanRadios),
            field(tr('Примечание'), note)),
    ];

    function fill(view) {
        const p = (view && view.patient) || {};
        const a = (view && view.admission) || {};
        const s = (view && view.sheet) || {};
        fullName.value = p.full_name || '';
        dob.value = p.date_of_birth ? fmtDate(p.date_of_birth) : '';
        gender.value = ['male', 'female', 'other'].includes(p.gender) ? p.gender : 'other';
        phone.value = p.phone || '';
        address.value = p.address || '';
        nationalId.value = p.national_id || '';
        occupation.value = p.occupation || '';
        ecName.value = p.emergency_contact_name || '';
        ecPhone.value = p.emergency_contact_phone || '';
        blood.value = p.blood_type && p.blood_type !== 'unknown' ? p.blood_type : '';
        allergies.value = p.allergies || '';
        referred.value = s.referred_from || '';
        for (const [el, key] of [[height, 'height_cm'], [weight, 'weight_kg'], [temp, 'temp_c'], [bpSys, 'bp_sys'], [bpDia, 'bp_dia'], [pulse, 'pulse_bpm']]) {
            el.value = s[key] === null || s[key] === undefined ? '' : String(s[key]);
        }
        recalc();
        picked.pediculosis = s.pediculosis || '';
        picked.sanitation = s.sanitation || '';
        for (const r of radioEls) r.checked = picked[r._tsKey] === r._tsValue;
        note.value = s.note || '';

        const placed = a.admitted_at && !['ordered', 'cancelled'].includes(a.status);
        info.admitted_at.textContent = placed ? fmtDateTime(a.admitted_at) : tr('при размещении');
        info.department.textContent = a.department || '—';
        info.place.textContent = [
            (bed && bed.ward_name) || a.ward_name,
            (bed && bed.code) || a.bed_code,
        ].filter(Boolean).join(' · ') || '—';
        info.type.textContent = a.admission_type === 'emergency' ? tr('Экстренная') : tr('Плановая');
        info.diagnosis.textContent = a.admission_diagnosis || '—';
        info.complaint.textContent = a.chief_complaint || '—';
    }

    function read() {
        return {
            sheet: {
                referred_from: val(referred),
                height_cm: val(height), weight_kg: val(weight), temp_c: val(temp),
                bp_sys: val(bpSys), bp_dia: val(bpDia), pulse_bpm: val(pulse),
                pediculosis: picked.pediculosis, sanitation: picked.sanitation,
                note: val(note),
            },
            patient: {
                gender: val(gender) || 'other',
                phone: val(phone), address: val(address), national_id: val(nationalId), occupation: val(occupation),
                emergency_contact_name: val(ecName), emergency_contact_phone: val(ecPhone),
                blood_type: val(blood), allergies: val(allergies),
            },
        };
    }

    return { fields, fill, read, inputs: { height, weight, bmi, temp, bpSys, bpDia, pulse, phone, referred } };
}

function sheetOnPaper(form) {
    return h('div', { class: 'a4-scroll ts-modal' },
        a4Sheet({ title: tr('Титульный лист'), children: [h('div', { class: 'ts-body' }, ...form.fields)] }));
}

/**
 * Шаг 2 размещения: койка выбрана — заполнить лист и положить. «Положить» —
 * ОДИН вызов admission_admit с листом: плохое значение не кладёт пациента.
 */
export function openAdmissionTitleSheetModal({ admission, bed, onDone, onBack } = {}) {
    if (!admission || !admission.id) { toast(tr('Заявка не найдена.'), 'fail'); return null; }
    if (!bed || !bed.id) { toast(tr('Выберите койку.'), 'fail'); return null; }
    const p = admission.patients || {};
    const form = titleSheetForm({ bed });
    form.fill({ patient: p, admission, sheet: null });
    (async () => {
        const { data } = await supabase.rpc('admission_title_sheet_get', { admission_id: admission.id });
        if (data) form.fill(Object.assign({}, data, { admission: Object.assign({}, data.admission, { status: admission.status }) }));
    })();

    let m = null;
    m = inpatientModal(tr('Титульный лист'), 'Doc', [
        patientAnchor(p.full_name || '', [p.mrn, admission.department, bed.code ? trf('койка {code}', { code: bed.code }) : null].filter(Boolean).join(' · ')),
        sheetOnPaper(form),
    ], tr('Положить'), async () => {
        const { data, error } = await supabase.rpc('admission_admit', { admission_id: admission.id, bed_id: bed.id, title_sheet: form.read() });
        if (error) { toast(error.message || tr('Не удалось положить на койку.'), 'fail'); return false; }
        const complete = !!(data && data.title_sheet && sheetCompleteness(data.title_sheet).complete);
        toast(complete
            ? tr('Пациент размещён на койке. Титульный лист заполнен.')
            : tr('Пациент размещён на койке. Титульный лист заполнен не до конца — допишите его в истории болезни.'),
        complete ? 'ok' : 'warn');
        if (onDone) await onDone();
        return true;
    }, {
        width: 860,
        secondaryLabel: tr('Назад'),
        onSecondary: async () => { if (m) m.close(); if (onBack) onBack(); },
    });
    return m;
}

export async function printTitleSheet(view) {
    const { PRINT_FONT_FACE_CSS } = await import('../../shared/print-fonts.js');
    const html = titleSheetPrintHtml(view, { fontFaceCss: PRINT_FONT_FACE_CSS });
    const w = window.open('', '_blank');
    if (!w) { toast(tr('Для печати разрешите всплывающие окна.'), 'warn'); return false; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    return true;
}

/** Редактор для истории болезни — той же формы, что buildReviewEditor. */
export function buildTitleSheetEditor({ admission, onDone } = {}) {
    if (!admission || !admission.id) { toast(tr('Госпитализация не найдена.'), 'fail'); return null; }
    const form = titleSheetForm();
    const status = h('div', { class: 'muted ts-hint' });
    let view = null;
    const showStatus = () => {
        if (!view) { status.textContent = ''; return; }
        status.textContent = view.complete && view.sheet
            ? trf('Заполнен: {who} · {when}', { who: view.sheet.filled_by_name || '', when: view.sheet.filled_at ? fmtDateTime(view.sheet.filled_at) : '' })
            : tr('Лист заполнен не до конца — пустые поля можно дописать и сохранить.');
    };
    const load = async () => {
        const { data, error } = await supabase.rpc('admission_title_sheet_get', { admission_id: admission.id });
        if (error) { toast(error.message || tr('Титульный лист не загрузился.'), 'fail'); return; }
        view = data;
        form.fill(data);
        showStatus();
    };
    load();

    return {
        title: tr('Титульный лист'),
        icon: 'Doc',
        fields: [status, ...form.fields],
        submitLabel: tr('Сохранить'),
        submit: async () => {
            const { data, error } = await supabase.rpc('admission_title_sheet_save', Object.assign({ admission_id: admission.id }, form.read()));
            if (error) { toast(error.message || tr('Не удалось сохранить титульный лист.'), 'fail'); return false; }
            view = data;
            showStatus();
            toast(data && data.complete ? tr('Титульный лист сохранён.') : tr('Титульный лист сохранён, но заполнен не до конца.'),
                data && data.complete ? 'ok' : 'warn');
            if (onDone) await onDone();
            return true;
        },
        secondaryLabel: tr('Печать'),
        secondary: async () => {
            if (!view) await load();
            if (view) await printTitleSheet(view);
        },
    };
}
```

- [ ] **Step 4: Append the styles to `public/css/admin-views.css`**

```css
/* ── TITLE_SHEET_V1 — титульный лист ─────────────────────────────────────── */
.ts-block{margin-top:14px}
.ts-block-t{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-500);margin:0 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line-200,#e3e8ec)}
.ts-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px}
.ts-grid .field{margin:0}
.ts-kv{display:flex;gap:8px;padding:6px 0;border-bottom:1px dotted var(--line-200,#d3d9de);font-size:13px;align-items:baseline}
.ts-kv .ts-k{color:var(--ink-500);flex:0 0 150px}
.ts-kv .ts-v{font-weight:600;min-width:0}
.ts-radios{display:flex;gap:14px;flex-wrap:wrap;padding:6px 0}
.ts-radios label{display:inline-flex;gap:6px;align-items:center;font-size:13px;cursor:pointer}
.ts-bp{display:flex;gap:6px;align-items:center}
.ts-bp input{width:86px}
.ts-bmi{font-weight:700;background:var(--surface-50,#f6f8f9)}
.ts-hint{font-size:12.5px;margin-top:6px}
.ts-modal{max-height:66vh;overflow:auto}
.ts-modal .a4-paper{margin:0 auto}
@media (max-width:720px){.ts-grid{grid-template-columns:1fr}}
```

- [ ] **Step 5: Run — expect PASS (6/6)**

Run: `node --test public/js/admin/__tests__/title-sheet.test.mjs`

- [ ] **Step 6: Commit**

```bash
git add public/js/admin/views/title-sheet.js public/css/admin-views.css public/js/admin/__tests__/title-sheet.test.mjs
git commit -m "feat(inpatient): титульный лист на экране — форма, окно размещения, редактор"
```

---

### Task 8: Wire the bed picker, the case file and the print cover

**Files:**
- Modify: `public/js/admin/views/admission-modal.js:310-379` (`openAdmissionBedPicker`)
- Modify: `public/js/admin/views/case-workspace.js:172-185` (`paintPane`)
- Modify: `public/js/admin/views/case-docs.js:50-63` (`CASE_DOC_TITLE`), `:547-620` (`caseFilePrintHtml`)
- Tests: `public/js/admin/__tests__/admissions-window.test.mjs:277-322`, `inpatient-route.test.mjs:665-683`, `title-sheet.test.mjs` (print-cover test)

- [ ] **Step 1: Update the window test (277–322) to the two-step flow**

Replace the body after `bedBtn.click();` in the first test with:

```js
    bedBtn.click();
    findBtn(overlay, 'Далее').click();   // TITLE_SHEET_V1 — койка выбрана, дальше лист
    await settle();
    const sheet = BODY.children[BODY.children.length - 1];
    assert.notEqual(sheet, overlay, 'после «Далее» должно открыться окно листа');
    assert.ok(textOf(sheet).includes('Титульный лист'));
    assert.ok(textOf(sheet).includes('T-2'), 'лист называет выбранную койку');
    findBtn(sheet, 'Положить').click();
    await settle();

    const call = rpcCalls.find((c) => c.name === 'admission_admit');
    assert.ok(call, 'admission_admit не вызван');
    assert.equal(call.args.admission_id, 11);
    assert.equal(call.args.bed_id, 6);
    assert.ok(call.args.title_sheet && call.args.title_sheet.sheet, 'лист должен уйти вместе с койкой');
```

In the second test («отказ сервера…») replace `findBtn(overlay, 'Положить').click();` with:

```js
    findBtn(overlay, 'Далее').click();
    await settle();
    const sheet = BODY.children[BODY.children.length - 1];
    findBtn(sheet, 'Положить').click();
```

and the final two lines with `const submit = findBtn(sheet, 'Положить');` (same assertion). Add to the fake `fetch` (after `admission_admit`):

```js
        if (name === 'admission_title_sheet_get') {
            return ok({ admission: { id: body.admission_id, status: 'ordered', department: 'Терапия', admission_type: 'planned' },
                patient: { id: 101, full_name: 'Иванов Иван Иванович', mrn: 'ID-1', gender: 'male' }, sheet: null, bmi: null, complete: false, missing: [], due_at: null });
        }
```

- [ ] **Step 2: Update the route test (665–683): after `findBtn(picker, 'Положить').click()` becomes two steps**

```js
        bedBtn.click();
        findBtn(picker, 'Далее').click();
        await settle();
        // TITLE_SHEET_V1 — второй шаг: титульный лист; медсестра вписывает рост и вес.
        const sheet = topOverlay();
        assert.ok(textOf(sheet).includes('Титульный лист'), 'после койки должен открыться титульный лист');
        walk(sheet).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '') === 'см').value = '172';
        walk(sheet).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '') === 'кг').value = '80';
        findBtn(sheet, 'Положить').click();
        await settle();

        const call = rpcCalls.find((c) => c.name === 'admission_admit');
        assert.ok(call, 'размещение не ушло на сервер');
        assert.equal(call.args.bed_id, 6);
        assert.equal(call.args.title_sheet.sheet.height_cm, '172');
        assert.equal(adm().status, 'admitted');
```

and in the fake rpc switch add before `case 'admission_admit'`:

```js
        case 'admission_title_sheet_get': {
            const row = adm();
            return { ok: true, data: { admission: row, patient: WORLD.patients.find((p) => p.id === row.patient_id) || {}, sheet: WORLD.titleSheet || null, bmi: null, complete: false, missing: [], due_at: null } };
        }
```

and inside `case 'admission_admit'` store the sheet: `if (a.title_sheet) WORLD.titleSheet = Object.assign({ admission_id: row.id }, a.title_sheet.sheet);` (add `titleSheet: null` to `WORLD` and to `resetWorld` if one exists — check `grep -n "WORLD.reviews = \[\]"`).

- [ ] **Step 3: Add the print-cover test to `title-sheet.test.mjs`**

```js
test('собранная история начинается титульным листом, а список пробелов остаётся', async () => {
    const { caseFilePrintHtml } = await import('../views/case-docs.js');
    const html = caseFilePrintHtml({ cover: { admission_no: 'H-7', assembled_by: 'Врач', assembled_at: '2026-09-08T12:00:00Z' },
        documents: [], gaps: ['consent'], title_sheet: VIEW });
    assert.ok(html.indexOf('Титульный лист') < html.indexOf('В комплекте не хватает'), 'лист должен идти первым');
    assert.ok(html.includes('Клиника Тест'));
    assert.ok(html.includes('Медсестра Петрова'));
    assert.ok(html.includes('Согласие на госпитализацию'), 'пробелы комплекта пропали');
    // Старый снимок без листа печатается прежней обложкой — без падения.
    const old = caseFilePrintHtml({ cover: { admission_no: 'H-1' }, documents: [], gaps: [] });
    assert.ok(old.includes('H-1'));
});
```

- [ ] **Step 4: Run the three test files — expect the updated/added tests to FAIL**

Run: `node --test public/js/admin/__tests__/admissions-window.test.mjs public/js/admin/__tests__/inpatient-route.test.mjs public/js/admin/__tests__/title-sheet.test.mjs`

- [ ] **Step 5: Bed picker → two steps (`admission-modal.js`)**

Add the import next to the other view imports:

```js
import { openAdmissionTitleSheetModal } from './title-sheet.js';   // TITLE_SHEET_V1
```

Replace the tail of `openAdmissionBedPicker` from `], tr('Положить'), async () => {` to the end of the function with:

```js
    ], tr('Далее'), async () => {
        if (!chosenBed) { toast(tr('Выберите койку.'), 'fail'); return false; }
        // TITLE_SHEET_V1 — койка выбрана; размещение делает окно листа, ОДНИМ
        // вызовом admission_admit с листом. «Назад» возвращает сюда же.
        const ward = data && Array.isArray(data.wards) ? data.wards.find((w) => w.id === chosenBed.ward_id) : null;
        openAdmissionTitleSheetModal({
            admission,
            bed: { id: chosenBed.id, code: chosenBed.code, ward_name: ward ? ward.name : '' },
            onDone,
            onBack: () => openAdmissionBedPicker({ admission, onDone }),
        });
        return true;
    }, { width: 820 });
}
```

Check `loadBedFund()`'s return shape in `ward-beds.js` (`grep -n "wards" public/js/admin/views/ward-beds.js | head`); if the wards array has another name, use it.

- [ ] **Step 6: Case workspace branch (`case-workspace.js`)**

Add the import:

```js
import { buildTitleSheetEditor, TITLE_SHEET_KIND } from './title-sheet.js';   // TITLE_SHEET_V1
```

Replace `const ed = buildReviewEditor({ … });` in `paintPane` with:

```js
    const onDone = async () => { await load(); paint(root, onNavigate); };
    // TITLE_SHEET_V1 — титульный лист медсестры: своя форма, тот же лист A4.
    const ed = state.open.kind === TITLE_SHEET_KIND
        ? buildTitleSheetEditor({ admission: Object.assign({}, state.admission, { id: state.admissionId }), onDone })
        : buildReviewEditor({
            admission: Object.assign({}, state.admission, { id: state.admissionId }),
            kind: state.open.kind,
            mode: state.open.mode,
            reviewId: state.open.reviewId,
            onDone,
        });
```

- [ ] **Step 7: Title and print cover (`case-docs.js`)**

Add `title: 'Титульный лист',` as the first entry of `CASE_DOC_TITLE`. Add the import:

```js
import { titleSheetPrintSection, titleSheetPrintCss } from './title-sheet-print.js';   // TITLE_SHEET_V1
```

In `caseFilePrintHtml`, build the gaps/drafts fragments once and choose the cover:

```js
    const gapsHtml = gaps.length ? `<div class="gaps"><b>${esc(tr('В комплекте не хватает:'))}</b><ul>${
        gaps.map((k) => `<li>${esc(caseDocTitle(k))}</li>`).join('')
    }</ul></div>` : `<p class="ok">${esc(tr('Обязательный комплект документов полный.'))}</p>`;
    const draftsHtml = file && file.drafts_excluded
        ? `<p class="note">${esc(trf('Черновиков не включено: {n}. Черновик — не документ и в историю болезни не подшивается.', { n: file.drafts_excluded }))}</p>`
        : '';
    const assembledHtml = `<p class="note">${esc(tr('Собрал'))}: ${esc([c.assembled_by, dt(c.assembled_at)].filter(Boolean).join(' · ') || '—')}</p>`;

    // TITLE_SHEET_V1 — первая страница собранной истории — титульный лист
    // медсестры. Снимок без листа (собран до этой версии) печатается прежней
    // обложкой.
    const cover = file && file.title_sheet
        ? titleSheetPrintSection(file.title_sheet, { extra: gapsHtml + draftsHtml + assembledHtml })
        : `<section class="cover"> …(the existing cover markup, with its ${gaps…} and drafts fragments replaced by ${gapsHtml}${draftsHtml})… </section>`;
```

and append `${titleSheetPrintCss()}` to the `<style>` block (after `.sign { … }`).

- [ ] **Step 8: Run — expect PASS**

Run: `node --test public/js/admin/__tests__/admissions-window.test.mjs public/js/admin/__tests__/inpatient-route.test.mjs public/js/admin/__tests__/title-sheet.test.mjs public/js/admin/__tests__/inpatient-section.test.mjs public/js/admin/__tests__/inpatient-notifications.test.mjs`

- [ ] **Step 9: Commit**

```bash
git add public/js/admin/views/admission-modal.js public/js/admin/views/case-workspace.js public/js/admin/views/case-docs.js public/js/admin/__tests__/admissions-window.test.mjs public/js/admin/__tests__/inpatient-route.test.mjs public/js/admin/__tests__/title-sheet.test.mjs
git commit -m "feat(inpatient): койка → титульный лист → размещение; лист первым в истории и на печати"
```

---

### Task 9: Translations

**Files:**
- Modify: `public/js/admin/i18n-strings.js` (append before the closing `};`)

- [ ] **Step 1: Run the coverage test to list the missing keys**

Run: `node --test public/js/admin/__tests__/i18n-coverage.test.mjs`
Expected: FAIL listing every new Russian literal from `title-sheet.js`, `title-sheet-print.js`, `case-docs.js`.

- [ ] **Step 2: Append entries (one line each, same format as the file). Complete list:**

```js
  "Титульный лист": {"en":"Title sheet","ru":"Титульный лист","uz":"Titul varag'i"},
  "Пациент": {"en":"Patient","ru":"Пациент","uz":"Bemor"},
  "ФИО": {"en":"Full name","ru":"ФИО","uz":"F.I.Sh."},
  "Дата рождения": {"en":"Date of birth","ru":"Дата рождения","uz":"Tug'ilgan sana"},
  "Пол": {"en":"Sex","ru":"Пол","uz":"Jinsi"},
  "Мужской": {"en":"Male","ru":"Мужской","uz":"Erkak"},
  "Женский": {"en":"Female","ru":"Женский","uz":"Ayol"},
  "Другое": {"en":"Other","ru":"Другое","uz":"Boshqa"},
  "Телефон": {"en":"Phone","ru":"Телефон","uz":"Telefon"},
  "Адрес": {"en":"Address","ru":"Адрес","uz":"Manzil"},
  "Паспорт / ID": {"en":"Passport / ID","ru":"Паспорт / ID","uz":"Pasport / ID"},
  "Место работы": {"en":"Workplace","ru":"Место работы","uz":"Ish joyi"},
  "Контактное лицо": {"en":"Emergency contact","ru":"Контактное лицо","uz":"Aloqa uchun shaxs"},
  "Телефон контактного лица": {"en":"Emergency contact phone","ru":"Телефон контактного лица","uz":"Aloqa shaxsining telefoni"},
  "Группа крови и резус": {"en":"Blood group and Rh","ru":"Группа крови и резус","uz":"Qon guruhi va rezus"},
  "напр. O(I) Rh+": {"en":"e.g. O(I) Rh+","ru":"напр. O(I) Rh+","uz":"masalan, O(I) Rh+"},
  "Аллергии": {"en":"Allergies","ru":"Аллергии","uz":"Allergiyalar"},
  "ФИО и дата рождения исправляются в карточке пациента.": {"en":"Name and date of birth are corrected in the patient card.","ru":"ФИО и дата рождения исправляются в карточке пациента.","uz":"F.I.Sh. va tug'ilgan sana bemor kartochkasida tuzatiladi."},
  "Поступление": {"en":"Admission","ru":"Поступление","uz":"Qabul"},
  "Дата и время": {"en":"Date and time","ru":"Дата и время","uz":"Sana va vaqt"},
  "при размещении": {"en":"at placement","ru":"при размещении","uz":"joylashtirishda"},
  "Отделение": {"en":"Department","ru":"Отделение","uz":"Bo'lim"},
  "Палата · койка": {"en":"Ward · bed","ru":"Палата · койка","uz":"Palata · koyka"},
  "Вид госпитализации": {"en":"Admission type","ru":"Вид госпитализации","uz":"Gospitalizatsiya turi"},
  "Плановая": {"en":"Planned","ru":"Плановая","uz":"Rejali"},
  "Экстренная": {"en":"Emergency","ru":"Экстренная","uz":"Shoshilinch"},
  "Диагноз при направлении": {"en":"Referral diagnosis","ru":"Диагноз при направлении","uz":"Yo'llanmadagi tashxis"},
  "Жалобы": {"en":"Complaints","ru":"Жалобы","uz":"Shikoyatlar"},
  "Кем направлен": {"en":"Referred by","ru":"Кем направлен","uz":"Kim yo'llagan"},
  "Лечащий врач": {"en":"Attending doctor","ru":"Лечащий врач","uz":"Davolovchi shifokor"},
  "Осмотр медсестры при поступлении": {"en":"Nurse's admission examination","ru":"Осмотр медсестры при поступлении","uz":"Qabulda hamshira ko'rigi"},
  "Рост, см": {"en":"Height, cm","ru":"Рост, см","uz":"Bo'y, sm"},
  "Вес, кг": {"en":"Weight, kg","ru":"Вес, кг","uz":"Vazn, kg"},
  "ИМТ": {"en":"BMI","ru":"ИМТ","uz":"TVI"},
  "Температура, °C": {"en":"Temperature, °C","ru":"Температура, °C","uz":"Harorat, °C"},
  "АД, мм рт. ст.": {"en":"BP, mmHg","ru":"АД, мм рт. ст.","uz":"AQB, mm sim. ust."},
  "Пульс, уд/мин": {"en":"Pulse, bpm","ru":"Пульс, уд/мин","uz":"Puls, zarba/min"},
  "см": {"en":"cm","ru":"см","uz":"sm"},
  "кг": {"en":"kg","ru":"кг","uz":"kg"},
  "верхнее": {"en":"systolic","ru":"верхнее","uz":"yuqori"},
  "нижнее": {"en":"diastolic","ru":"нижнее","uz":"pastki"},
  "уд/мин": {"en":"bpm","ru":"уд/мин","uz":"zarba/min"},
  "Осмотр на педикулёз и чесотку": {"en":"Pediculosis / scabies check","ru":"Осмотр на педикулёз и чесотку","uz":"Pedikulyoz va qo'tirga ko'rik"},
  "не выявлено": {"en":"not found","ru":"не выявлено","uz":"aniqlanmadi"},
  "выявлено": {"en":"found","ru":"выявлено","uz":"aniqlandi"},
  "Санитарная обработка": {"en":"Sanitary treatment","ru":"Санитарная обработка","uz":"Sanitar ishlov"},
  "полная": {"en":"full","ru":"полная","uz":"to'liq"},
  "частичная": {"en":"partial","ru":"частичная","uz":"qisman"},
  "не проводилась": {"en":"not done","ru":"не проводилась","uz":"o'tkazilmadi"},
  "Примечание": {"en":"Note","ru":"Примечание","uz":"Izoh"},
  "койка {code}": {"en":"bed {code}","ru":"койка {code}","uz":"koyka {code}"},
  "Положить": {"en":"Place","ru":"Положить","uz":"Joylashtirish"},
  "Далее": {"en":"Next","ru":"Далее","uz":"Keyingi"},
  "Назад": {"en":"Back","ru":"Назад","uz":"Orqaga"},
  "Печать": {"en":"Print","ru":"Печать","uz":"Chop etish"},
  "Сохранить": {"en":"Save","ru":"Сохранить","uz":"Saqlash"},
  "Пациент размещён на койке. Титульный лист заполнен.": {"en":"Patient placed in the bed. Title sheet completed.","ru":"Пациент размещён на койке. Титульный лист заполнен.","uz":"Bemor koykaga joylashtirildi. Titul varag'i to'ldirildi."},
  "Пациент размещён на койке. Титульный лист заполнен не до конца — допишите его в истории болезни.": {"en":"Patient placed in the bed. The title sheet is incomplete — finish it in the case history.","ru":"Пациент размещён на койке. Титульный лист заполнен не до конца — допишите его в истории болезни.","uz":"Bemor koykaga joylashtirildi. Titul varag'i to'liq emas — uni kasallik tarixida to'ldiring."},
  "Для печати разрешите всплывающие окна.": {"en":"Allow pop-up windows to print.","ru":"Для печати разрешите всплывающие окна.","uz":"Chop etish uchun qalqib chiquvchi oynalarga ruxsat bering."},
  "Заполнен: {who} · {when}": {"en":"Completed: {who} · {when}","ru":"Заполнен: {who} · {when}","uz":"To'ldirildi: {who} · {when}"},
  "Лист заполнен не до конца — пустые поля можно дописать и сохранить.": {"en":"The sheet is incomplete — fill in the empty fields and save.","ru":"Лист заполнен не до конца — пустые поля можно дописать и сохранить.","uz":"Varaq to'liq emas — bo'sh maydonlarni to'ldirib saqlang."},
  "Титульный лист не загрузился.": {"en":"The title sheet did not load.","ru":"Титульный лист не загрузился.","uz":"Titul varag'i yuklanmadi."},
  "Не удалось сохранить титульный лист.": {"en":"Could not save the title sheet.","ru":"Не удалось сохранить титульный лист.","uz":"Titul varag'ini saqlab bo'lmadi."},
  "Титульный лист сохранён.": {"en":"Title sheet saved.","ru":"Титульный лист сохранён.","uz":"Titul varag'i saqlandi."},
  "Титульный лист сохранён, но заполнен не до конца.": {"en":"Title sheet saved, but it is incomplete.","ru":"Титульный лист сохранён, но заполнен не до конца.","uz":"Titul varag'i saqlandi, lekin to'liq emas."},
  "Титульный лист заполнил(а): {who} · {when}": {"en":"Title sheet completed by: {who} · {when}","ru":"Титульный лист заполнил(а): {who} · {when}","uz":"Titul varag'ini to'ldirdi: {who} · {when}"},
  "Титульный лист не заполнен": {"en":"Title sheet not completed","ru":"Титульный лист не заполнен","uz":"Titul varag'i to'ldirilmagan"},
  "История болезни № {no}": {"en":"Case history No. {no}","ru":"История болезни № {no}","uz":"Kasallik tarixi № {no}"},
  "Собрал": {"en":"Assembled by","ru":"Собрал","uz":"Yig'di"},
```

Some of these keys may already exist (e.g. `Телефон`, `Адрес`, `Отделение`, `Жалобы`, `Собрал`, `Экстренная`, `Лечащий врач`, `Печать`, `Сохранить`, `Назад`, `Далее`): check each with `grep -c '^  "Телефон":' public/js/admin/i18n-strings.js` and add only the missing ones — a duplicate key is a silent override.

- [ ] **Step 3: Run — expect PASS**

Run: `node --test public/js/admin/__tests__/i18n-coverage.test.mjs`

- [ ] **Step 4: Commit**

```bash
git add public/js/admin/i18n-strings.js
git commit -m "i18n(inpatient): титульный лист — ru/uz/en"
```

---

### Task 10: Full suite, then push

- [ ] **Step 1: Syntax check of every touched module**

Run: `for f in public/js/shared/title-sheet-rules.js server/services/rpc/title-sheet.js public/js/admin/views/title-sheet.js public/js/admin/views/title-sheet-print.js public/js/admin/views/inpatient-modal.js public/js/admin/views/admission-modal.js public/js/admin/views/case-docs.js public/js/admin/views/case-workspace.js server/services/rpc/inpatient.js server/services/rpc/inpatient-reviews.js; do node --check "$f" || echo "BROKEN $f"; done`

- [ ] **Step 2: Full suite (background), require `REAL_EXIT=0` and `ℹ fail 0`**

Run: `node --experimental-vm-modules --test > "$TEMP/full-title.log" 2>&1; echo "REAL_EXIT=$?" >> "$TEMP/full-title.log"`
Then: `grep -E "^ℹ (tests|pass|fail)|^REAL_EXIT=" "$TEMP/full-title.log"` — fix anything red (likely candidates: an RPC-catalog test listing RPC names; a CSS/type-scale lint; the section-title subtitle test).

- [ ] **Step 3: Push (no tag — release is the owner's word)**

```bash
git push origin main
```

---

## Self-review against the spec

- Timing (same step as the bed, blanks allowed): Task 7 modal + Task 8 picker; server accepts partial (Task 3). ✔
- Measurements incl. hygiene checks and blood group: Task 1 rules, Task 2 columns, Task 7 form. ✔
- Personal data from the card, write-back of allowed fields only: Task 3 `saveTitleSheet`, test «исправления личных данных». ✔
- Case file first line, 2-hour deadline, states, excluded from next: Task 4. ✔
- Assembly/print cover = title sheet with letterhead; gaps list kept; «Печать» button: Tasks 6, 7, 8. ✔
- Roles: Task 3. Admissions already in beds get pending/overdue: Task 4 (no row → pending/overdue). ✔
- Migration guard with referencing rows: Task 2. ✔
- Translations: Task 9. Not in schema registry / SHIPPED: nothing to do (RPC-only). ✔
