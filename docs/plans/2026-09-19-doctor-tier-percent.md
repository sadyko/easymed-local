# Doctor share volume tier (DOCTOR_TIER_V1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per service, a threshold (services per calendar month) and a tier percent; for each doctor the lines of one exact service in one month are numbered in performance order, and lines above the threshold are paid at MAX(personal %, tier %). Defaults 0 = nothing changes.

**Architecture:** Two new columns on `services` (migration 140). One SQL ranking fragment (`TIER_RANK_SQL`) in `server/services/rpc/reports.js` feeds both the salary/revenue reports (via the existing `ITEM_FEE_SQL`) and a new read-only RPC `doctor_tier_positions` that the doctor cabinet calls; the cabinet only applies the split with a pure function `tierShare()` next to `serviceShare()` — it never re-derives positions. Spec: `docs/plans/2026-09-19-doctor-tier-percent-design.md`.

**Tech Stack:** Node 24 ESM, better-sqlite3 13 (SQLite 3.53, window functions OK), `node --test`, vanilla-JS SPA with `h()` DOM builder and a fake-DOM test harness, PostgREST-style `supabase.rpc()` over `/api/rpc/<name>`.

**Repo rules that apply:** work directly in `C:\Users\user\Desktop\implementation workflow\easymed.local` on branch `feat/doctor-tier-percent` — **never create a git worktree of this repo** (it wipes `node_modules`). Stage files by name, never `git add -A`. Run a single test file with `node --test <path>` from the repo root. New Russian UI literals in SPA views must be added to `public/js/admin/i18n-strings.js` with `ru`, `uz`, `en` (guard: `public/js/admin/__tests__/i18n-coverage.test.mjs`). Commit messages: Russian, conventional prefix, marker `(DOCTOR_TIER_V1)`, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility in this feature |
|---|---|
| `server/db/migrations/140_doctor_tier.sql` (create) | the two columns |
| `server/db/migrations/140.test.js` (create) | columns, defaults, registry, idempotence |
| `server/db/schema-registry.js` (modify ~215-229) | read/insert/update lists for `services` |
| `public/js/admin/views/section-import-export.js` (modify ~451) | Excel columns |
| `server/services/branch-sync/catalogue.js` (modify ~100) | columns travel with the price list |
| `server/services/branch-sync/catalogue.test.js` (modify, append) | pin that they travel |
| `server/services/rpc/reports.js` (modify ~282-350, ~372, ~803) | `TIER_RANK_SQL`, per-line pieces, fee, RPC |
| `server/services/rpc/reports.doctor-tier.test.js` (create) | the money tests |
| `server/services/rpc/index.js` (modify ~9, ~141) | register the RPC |
| `server/services/control/gate.js` (modify ~20) | RPC is read-only |
| `server/services/rpc/service-save.js` (modify ~143, ~245, ~267) | accept + validate the pair |
| `server/services/rpc/service-save.test.js` (modify, append) | validation tests |
| `public/js/admin/views/service-editor.js` (modify ~161, ~257, ~369) | two inputs |
| `public/js/admin/views/doctor-dashboard.js` (modify after `serviceShare`) | `tierShare()` |
| `public/js/admin/__tests__/doctor-dashboard.test.mjs` (modify, append) | `tierShare` arithmetic |
| `public/js/admin/views/consultation.js` (modify ~81, ~26-33, ~1529, ~1580, ~1667, ~1947, ~2223) | positions load, salary, progress rows |
| `public/js/admin/__tests__/doctor-pay.test.mjs` (modify ~131, append) | cabinet uses positions |
| `public/js/admin/i18n-strings.js` (modify, append entries) | dictionary |

---

### Task 1: Migration 140 + schema registry + Excel columns

**Files:**
- Create: `server/db/migrations/140_doctor_tier.sql`
- Create: `server/db/migrations/140.test.js`
- Modify: `server/db/schema-registry.js:215-229`
- Modify: `public/js/admin/views/section-import-export.js:451`

- [ ] **Step 1: Write the failing migration test**

`server/db/migrations/140.test.js`:

```js
// DOCTOR_TIER_V1 — ступень доли врача по объёму: порог услуг в месяц и доля
// выше порога живут на УСЛУГЕ. Нули = ступени нет, поведение прежнее.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { writableColumns, readableColumns } from '../schema-registry.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));
const COLS = ['doctor_tier_from', 'doctor_tier_percent'];

test('колонки ступени есть, по умолчанию 0, реестр их читает и пишет', () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
        const info = db.prepare('PRAGMA table_info(services)').all();
        for (const c of COLS) {
            const col = info.find((x) => x.name === c);
            assert.ok(col, 'нет колонки services.' + c);
            assert.equal(col.notnull, 1, c + ' должна быть NOT NULL');
            assert.equal(String(col.dflt_value), '0', c + ' по умолчанию 0');
            assert.ok(readableColumns('services').includes(c), c + ' не читается');
            assert.ok(writableColumns('services', 'insert').includes(c), c + ' не принимается при вставке');
            assert.ok(writableColumns('services', 'update').includes(c), c + ' не принимается при правке');
        }
        db.prepare("INSERT INTO services (name, price) VALUES ('Приём', 100000)").run();
        const row = db.prepare('SELECT doctor_tier_from, doctor_tier_percent FROM services').get();
        assert.deepEqual(row, { doctor_tier_from: 0, doctor_tier_percent: 0 });
    } finally { db.close(); }
});

test('миграция проходит на базе с услугами и не трогает их долю по умолчанию', () => {
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig140-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (parseInt(f, 10) >= 140 || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO services (name, price, default_doctor_percent) VALUES ('Приём', 100000, 35)").run();

    migrate(db);
    migrate(db);   // повторный прогон — ничего не ломает

    const row = db.prepare('SELECT default_doctor_percent, doctor_tier_from, doctor_tier_percent FROM services').get();
    assert.deepEqual(row, { default_doctor_percent: 35, doctor_tier_from: 0, doctor_tier_percent: 0 });
    db.close();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test server/db/migrations/140.test.js`
Expected: FAIL — `нет колонки services.doctor_tier_from`.

- [ ] **Step 3: Write the migration**

`server/db/migrations/140_doctor_tier.sql`:

```sql
-- 140_doctor_tier.sql — DOCTOR_TIER_V1: СТУПЕНЬ ДОЛИ ВРАЧА ПО ОБЪЁМУ.
--
-- Владелец (2026-09-19): «by default we setup 30% but if doctor performs this
-- type of service more than 25 we need to make 40%» — «apply only above the
-- threshold services», «per exact service», «both» (оплаченные и начатые
-- строки считаются).
--
-- Правило живёт на УСЛУГЕ (политика клиники, едет с прайсом в филиалы, как
-- default_doctor_percent из 081): порог — число услуг в календарном месяце,
-- доля выше порога — процент, который применяется к строкам врача по этой
-- услуге НАЧИНАЯ со следующей после порога. Личный процент ступень никогда не
-- понижает: действует MAX(личный, ступень). Нумерацию строк считает ОДНО место
-- — TIER_RANK_SQL в services/rpc/reports.js; кабинет врача берёт её оттуда.
--
-- Нули = ступени нет: ни один существующий отчёт не меняет ни одной цифры,
-- пока клиника не заполнит пару полей в карточке услуги.
--
-- ТОЛЬКО ADD COLUMN.
ALTER TABLE services ADD COLUMN doctor_tier_from    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN doctor_tier_percent REAL    NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Add the columns to the schema registry**

In `server/db/schema-registry.js`, in the `services:` entry, add `'doctor_tier_from','doctor_tier_percent'` right after `'default_doctor_percent'` in **all three** lists: `read.columns` (~line 217), `write.insert.columns` (~line 224) and `write.update.columns` (~line 228). Append to the trailing comment on line 219: `; doctor_tier_from/doctor_tier_percent: DOCTOR_TIER_V1 (mig 140) — written by service_save and the Excel importer`.

- [ ] **Step 5: Add the Excel columns**

In `public/js/admin/views/section-import-export.js`, directly after the `default_doctor_percent` row (~line 451) add:

```js
            { key: 'doctor_tier_from',    coerce: 'int', hint: 'Ступень: порог услуг в месяц (0 или пусто — ступени нет)' },
            { key: 'doctor_tier_percent', coerce: 'num', hint: 'Ступень: доля исполнителя выше порога, % (задаётся вместе с порогом)' },
```

- [ ] **Step 6: Run the tests**

Run: `node --test server/db/migrations/140.test.js server/db/schema-registry.test.js server/db/star-meets-schema.test.js`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add server/db/migrations/140_doctor_tier.sql server/db/migrations/140.test.js server/db/schema-registry.js public/js/admin/views/section-import-export.js
git commit -m "feat(услуги): колонки ступени доли врача по объёму — порог и доля выше порога (DOCTOR_TIER_V1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The two columns travel with the price list (branch sync)

**Files:**
- Modify: `server/services/branch-sync/catalogue.js:100`
- Modify: `server/services/branch-sync/catalogue.test.js` (append)

- [ ] **Step 1: Write the failing test** (append to `catalogue.test.js`; the helpers `fresh`, `seedMain`, `receiver`, `apply`, `exportCatalogue` already exist in that file)

```js
test('DOCTOR_TIER_V1: порог и доля ступени едут с прайсом и приземляются', () => {
  const main = seedMain(fresh());
  main.prepare("UPDATE services SET doctor_tier_from = 25, doctor_tier_percent = 40 WHERE code='S-CARD'").run();
  const dst = receiver();
  apply(dst, exportCatalogue(main));
  const svc = dst.prepare("SELECT doctor_tier_from, doctor_tier_percent FROM services WHERE code='S-CARD'").get();
  assert.deepEqual(svc, { doctor_tier_from: 25, doctor_tier_percent: 40 });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test server/services/branch-sync/catalogue.test.js`
Expected: the new test FAILS with `{ doctor_tier_from: 0, doctor_tier_percent: 0 }`.

- [ ] **Step 3: Add the columns to the services spec**

In `catalogue.js` after line 100 (`'default_doctor_percent',`) add:

```js
      // DOCTOR_TIER_V1 (миграция 140) — ступень по объёму ЕДЕТ по той же
      // причине: политика оплаты клиники, а не факт здания.
      'doctor_tier_from', 'doctor_tier_percent',
```

- [ ] **Step 4: Run the tests**

Run: `node --test server/services/branch-sync/catalogue.test.js`
Expected: PASS (including the pre-081 compatibility tests — a missing key still means "old exporter").

- [ ] **Step 5: Commit**

```bash
git add server/services/branch-sync/catalogue.js server/services/branch-sync/catalogue.test.js
git commit -m "feat(филиалы): ступень доли врача едет с прайсом (DOCTOR_TIER_V1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Server ranking and the fee

**Files:**
- Modify: `server/services/rpc/reports.js` (block 282-350, line 372, line 803)
- Create: `server/services/rpc/reports.doctor-tier.test.js`

- [ ] **Step 1: Write the failing tests**

`server/services/rpc/reports.doctor-tier.test.js`:

```js
// DOCTOR_TIER_V1 — ступень доли врача по объёму. Порядок, зафиксированный
// владельцем: считается ТОЧНАЯ услуга, календарный месяц по дате визита,
// ступень — только у строк ВЫШЕ порога, считаются строки оплаченные ИЛИ
// начатые/завершённые врачом, ступень никого не понижает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorTierPositions } from './reports.js';

const user = { id: 1, role: 'admin' };
const SEP = { from: '2026-09-01', to: '2026-09-30' };

// Один врач, одна услуга 100 000, налог 0 (чтобы цифры читались глазами).
function clinic({ pct = 30, tierFrom = 25, tierPct = 40, fix = null, taxRate = 0 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const rates = JSON.stringify([{ service_id: 1, pct, ...(fix == null ? {} : { fix }) }]);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, service_rates)
              VALUES (1,'doc','x','doctor','Доктор Д.', ?)`).run(rates);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare('INSERT INTO services (id, name, price, tax_rate, doctor_tier_from, doctor_tier_percent) VALUES (1,?,?,?,?,?)')
    .run('Приём', 100000, taxRate, tierFrom, tierPct);
  let seq = 0;
  // Одна строка = один визит с одной услугой; paid → оплаченный счёт с датой дня.
  const line = ({ day = '2026-09-05', status = 'added', paid = true, invoiceStatus = 'paid', qty = 1, price = 100000 } = {}) => {
    const id = ++seq;
    db.prepare('INSERT INTO visits (id, patient_id, visit_date) VALUES (?,1,?)').run(id, day + 'T09:00:00Z');
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
                VALUES (?,?,1,1,?,?,?,?)`).run(id, id, qty, price, price * qty, status);
    if (paid) {
      const sub = price * qty;
      db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                  VALUES (?,?,?,1,?,0,?,?,?,?)`).run(id, 'INV-' + id, id, sub, sub, invoiceStatus === 'paid' ? sub : 0, invoiceStatus, day + 'T10:00:00Z');
      db.prepare(`INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total)
                  VALUES (?,?,1,'Приём',?,?,?)`).run(id, id, qty, price, sub);
      db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(id, id);
    }
    return id;
  };
  const lines = (n, opts) => { for (let i = 0; i < n; i++) line(opts); };
  return { db, line, lines };
}

const fee = (db, range = SEP) => {
  const r = runReport(db, { kind: 'doctor_salaries', ...range }, user);
  return r.rows.length ? r.rows[0][r.columns.indexOf('Доля врача (гонорар)')] : 0;
};

test('до порога — личный процент: 25 строк × 30 000', () => {
  const c = clinic(); c.lines(25);
  assert.equal(fee(c.db), 750000);
});

test('26-я строка — по ступени 40 %, первые 25 — нет', () => {
  const c = clinic(); c.lines(26);
  assert.equal(fee(c.db), 25 * 30000 + 40000);
});

test('без ступени ничего не меняется', () => {
  const c = clinic({ tierFrom: 0, tierPct: 0 }); c.lines(26);
  assert.equal(fee(c.db), 26 * 30000);
});

test('оплаченная, но ещё не начатая строка считается в нумерации', () => {
  // все строки status=added, но оплачены — это и есть «плати в кассе, потом к врачу»
  const c = clinic(); c.lines(26, { status: 'added' });
  assert.equal(fee(c.db), 25 * 30000 + 40000);
});

test('начатая, но не оплаченная строка занимает номер, но не оплачивается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'in_progress', paid: false });   // номер 1
  c.lines(25);                                                          // номера 2..26
  // оплачены номера 2..26: 24 строки по 30 % и одна (26-я) по 40 %
  assert.equal(fee(c.db), 24 * 30000 + 40000);
});

test('не начатая и не оплаченная строка не считается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'added', paid: false });
  c.lines(25);
  assert.equal(fee(c.db), 25 * 30000);
});

test('отменённый счёт не считается', () => {
  const c = clinic();
  c.line({ day: '2026-09-03', status: 'added', invoiceStatus: 'void' });
  c.lines(25);
  assert.equal(fee(c.db), 25 * 30000);
});

test('ступень никого не понижает: врач на 45 % остаётся на 45 %', () => {
  const c = clinic({ pct: 45 }); c.lines(26);
  assert.equal(fee(c.db), 26 * 45000);
});

test('фиксированная ставка: ступень не трогает', () => {
  const c = clinic({ fix: 15000 }); c.lines(26);
  assert.equal(fee(c.db), 26 * 15000);
});

test('количество 3 на границе делится по единицам', () => {
  const c = clinic();
  c.lines(24);
  c.line({ qty: 3 });   // running 24 → 27: 1 единица по 30 %, 2 по 40 %
  // 24 × 30 000 + 300 000 × (30·1 + 40·2)/3 / 100 = 720 000 + 110 000
  assert.equal(fee(c.db), 830000);
});

test('октябрь начинает счёт заново', () => {
  const c = clinic(); c.lines(26);
  c.line({ day: '2026-10-01' });
  assert.equal(fee(c.db, { from: '2026-10-01', to: '2026-10-31' }), 30000);
});

test('недельный отчёт внутри месяца видит ступень всего месяца', () => {
  const c = clinic(); c.lines(25);
  c.line({ day: '2026-09-20' });   // 26-я в месяце
  assert.equal(fee(c.db, { from: '2026-09-15', to: '2026-09-21' }), 40000);
});

test('«Общая выручка» показывает ту же долю, что зарплатный отчёт', () => {
  const c = clinic(); c.lines(26);
  const rev = runReport(c.db, { kind: 'total_revenue', ...SEP }, user);
  const col = rev.columns.indexOf('Доля врача');
  const sum = rev.rows.reduce((s, r) => s + Number(r[col] || 0), 0);
  assert.equal(Math.round(sum), fee(c.db));
});

test('doctor_tier_positions отдаёт ту же нумерацию, что отчёт', () => {
  const c = clinic(); c.lines(24); c.line({ qty: 3 });
  const { rows } = doctorTierPositions(c.db, { doctor_id: 1, month: '2026-09' }, user);
  assert.equal(rows.length, 25);
  assert.deepEqual(rows.map((r) => r.units_above).slice(0, 24), Array(24).fill(0));
  const last = rows[24];
  assert.equal(last.units, 3);
  assert.equal(last.units_above, 2);
  assert.equal(last.count_so_far, 27);
  assert.equal(last.tier_from, 25);
  assert.equal(last.tier_percent, 40);
  assert.equal(last.service_name, 'Приём');
  // те же деньги, что в отчёте, если применить позиции руками
  const money = rows.reduce((s, r) => s + 100000 * r.units * (30 * (r.units - r.units_above) + 40 * r.units_above) / r.units / 100, 0);
  assert.equal(money, fee(c.db));
});

test('doctor_tier_positions: без ступени — пусто; кривые аргументы — 400', () => {
  const c = clinic({ tierFrom: 0, tierPct: 0 }); c.lines(3);
  assert.deepEqual(doctorTierPositions(c.db, { doctor_id: 1, month: '2026-09' }, user).rows, []);
  assert.throws(() => doctorTierPositions(c.db, { doctor_id: 1, month: 'сентябрь' }, user), (e) => e.status === 400);
  assert.throws(() => doctorTierPositions(c.db, { month: '2026-09' }, user), (e) => e.status === 400);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test server/services/rpc/reports.doctor-tier.test.js`
Expected: FAIL at import — `doctorTierPositions` is not exported (and the 26-line test would give 780000).

- [ ] **Step 3: Add `TIER_RANK_SQL` and the per-line pieces to `reports.js`**

Insert **before** `const ITEM_DOCTOR_JOIN` (~line 282):

```js
// DOCTOR_TIER_V1 — нумерация строк врача по ТОЧНОЙ услуге внутри календарного
// месяца (по дате визита, местное время; хвост — по id строки). Считается
// строка, которая ОПЛАЧЕНА или которую врач НАЧАЛ/ЗАВЕРШИЛ — что раньше
// (владелец: «both»). running — накопленное количество единиц; у строки, чьё
// running перешагнуло порог, за порог выходит units_above единиц — они и идут
// по ступени, остальные — по личной ставке. В выборке только услуги со
// ступенью: без неё подзапрос пуст и отчёты не меняют ни одной цифры.
// Одно место на всю систему: и отчёты, и кабинет (doctor_tier_positions).
export const TIER_RANK_SQL = `
  SELECT r.id AS visit_service_id, r.doctor_id, r.service_id, r.qty, r.ym,
         s.doctor_tier_from AS tier_from, s.doctor_tier_percent AS tier_percent,
         SUM(r.qty) OVER (PARTITION BY r.doctor_id, r.service_id, r.ym
                          ORDER BY r.visit_date, r.id
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
    FROM (
      SELECT vs.id, vs.doctor_id, vs.service_id,
             MAX(COALESCE(vs.quantity, 1), 1) AS qty,
             v.visit_date, ${localMonth('v.visit_date')} AS ym
        FROM visit_services vs
        JOIN visits v ON v.id = vs.visit_id
        LEFT JOIN invoice_items ti ON ti.id = vs.invoice_item_id
        LEFT JOIN invoices tinv ON tinv.id = ti.invoice_id
       WHERE vs.doctor_id IS NOT NULL AND vs.service_id IS NOT NULL
         AND (tinv.status = 'paid' OR vs.status IN ('in_progress', 'completed'))
    ) r
    JOIN services s ON s.id = r.service_id AND s.doctor_tier_from > 0
`;
```

Change the `vs` subquery inside `ITEM_DOCTOR_JOIN` to also carry the visit-service id, and add the tier join after the `dr` join:

```js
const ITEM_DOCTOR_JOIN = `
  LEFT JOIN (SELECT invoice_item_id, MIN(doctor_id) AS doctor_id, MIN(id) AS visit_service_id
               FROM visit_services
              WHERE invoice_item_id IS NOT NULL AND doctor_id IS NOT NULL
              GROUP BY invoice_item_id) vs ON vs.invoice_item_id = ii.id
  LEFT JOIN users doc ON doc.id = vs.doctor_id
  LEFT JOIN (SELECT doctor_id, service_id, MAX(percent) AS percent, MAX(fix) AS fix FROM (
               ... (unchanged) ...
             ) GROUP BY doctor_id, service_id) dr
         ON dr.doctor_id = vs.doctor_id AND dr.service_id = ii.service_id
  LEFT JOIN (${TIER_RANK_SQL}) tr ON tr.visit_service_id = vs.visit_service_id
`;
```

After `const ITEM_FIX_SQL = \`dr.fix\`;` add:

```js
// DOCTOR_TIER_V1 — кусочки строки. Единицы строки — не меньше 1, чтобы деление
// ниже никогда не было на ноль.
const ITEM_QTY_SQL = `MAX(COALESCE(ii.quantity, 1), 1)`;
// Единицы, ушедшие за порог: 0..qty. Без ступени (tr пуст) MIN даёт NULL → 0.
const ITEM_ABOVE_SQL = `COALESCE(MAX(0, MIN(${ITEM_QTY_SQL}, tr.running - tr.tier_from)), 0)`;
// Процент ступени — не ниже личного: ступень никого не понижает.
const ITEM_TIER_PCT_SQL = `MAX(${ITEM_PCT_SQL}, COALESCE(tr.tier_percent, 0))`;
// Действующий процент строки — смесь по единицам: до порога личный, выше — ступень.
const ITEM_EFF_PCT_SQL = `((${ITEM_PCT_SQL} * (${ITEM_QTY_SQL} - ${ITEM_ABOVE_SQL}) + ${ITEM_TIER_PCT_SQL} * ${ITEM_ABOVE_SQL}) / (${ITEM_QTY_SQL} * 1.0))`;
```

Change the percent branch of `ITEM_FEE_SQL`:

```js
const ITEM_FEE_SQL = `CASE
  WHEN ${ITEM_FIX_SQL} IS NOT NULL THEN ${ITEM_FIX_SQL} * COALESCE(ii.quantity, 1)
  ELSE ${ITEM_NET_SQL} * ${ITEM_EFF_PCT_SQL} / 100.0
END`;
```

Line ~372 (`itemRowsQuery`): `${ITEM_PCT_SQL} AS doctor_pct,` → `${ITEM_EFF_PCT_SQL} AS doctor_pct,`.
Line ~803 (`doctorSalariesReport`): `AVG(CASE WHEN ${ITEM_FIX_SQL} IS NULL THEN ${ITEM_PCT_SQL} END) AS avg_pct,` → use `${ITEM_EFF_PCT_SQL}` inside the CASE.

- [ ] **Step 4: Add the RPC function** (append near `runReport`, still in `reports.js`)

```js
// DOCTOR_TIER_V1 — позиции строк врача за месяц 'YYYY-MM': кабинет получает
// ГОТОВУЮ нумерацию и не считает её сам — две нумерации разошлись бы молча,
// тот же довод, что у serviceShare/ITEM_FEE_SQL. Читает любой вошедший, как и
// отчёты (шапка файла). Пусто — у врача в этом месяце нет строк по услугам со
// ступенью.
export function doctorTierPositions(db, args, _user) {
  const doctorId = Number(args && args.doctor_id);
  if (!Number.isInteger(doctorId) || doctorId <= 0) throw new RpcError('doctor_id must be a positive integer.', 400);
  const month = String((args && args.month) || '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new RpcError('month must be YYYY-MM.', 400);
  const rows = db.prepare(`
    SELECT t.visit_service_id, t.service_id, s.name AS service_name,
           t.qty AS units,
           MAX(0, MIN(t.qty, t.running - t.tier_from)) AS units_above,
           t.tier_from, t.tier_percent, t.running AS count_so_far
      FROM (${TIER_RANK_SQL}) t
      JOIN services s ON s.id = t.service_id
     WHERE t.doctor_id = ? AND t.ym = ?
     ORDER BY t.service_id, t.running, t.visit_service_id
  `).all(doctorId, month);
  return { month, rows };
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test server/services/rpc/reports.doctor-tier.test.js server/services/rpc/reports.doctor-share.test.js server/services/rpc/reports.test.js`
Expected: all PASS. If SQLite complains about the window function inside a LEFT JOIN subquery, wrap `TIER_RANK_SQL` as `(SELECT * FROM (...))` — but SQLite 3.53 accepts it as written.

- [ ] **Step 6: Commit**

```bash
git add server/services/rpc/reports.js server/services/rpc/reports.doctor-tier.test.js
git commit -m "feat(зарплата): ступень доли врача по объёму — нумерация строк в месяце и доля выше порога (DOCTOR_TIER_V1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Register the RPC as read-only

**Files:**
- Modify: `server/services/rpc/index.js:9` (import) and the `RPC` map next to `run_report` (~line 141)
- Modify: `server/services/control/gate.js:20-34` (`READ_ONLY_RPCS`)

- [ ] **Step 1: Write the failing test** (append to `server/services/rpc/reports.doctor-tier.test.js`)

```js
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

test('doctor_tier_positions зарегистрирован и считается чтением', () => {
  assert.equal(typeof RPC.doctor_tier_positions, 'function');
  assert.ok(isReadOnlyRpc('doctor_tier_positions'), 'кабинет врача при просроченной лицензии обязан читать свои позиции');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test server/services/rpc/reports.doctor-tier.test.js`
Expected: FAIL — `RPC.doctor_tier_positions` is undefined.

- [ ] **Step 3: Register**

`index.js` line 9: add `doctorTierPositions` to the import from `./reports.js`. In the `RPC` map, right after `run_report:` add:

```js
  doctor_tier_positions:    (db, args, user) => doctorTierPositions(db, args, user),   // DOCTOR_TIER_V1 — позиции строк для кабинета врача
```

`gate.js` `READ_ONLY_RPCS`: after `'report_freshness',` add:

```js
  // DOCTOR_TIER_V1 — нумерация строк врача по ступени; чистое чтение, как
  // run_report рядом: кабинет показывает прогресс и при просроченной лицензии.
  'doctor_tier_positions',
```

- [ ] **Step 4: Run the tests**

Run: `node --test server/services/rpc/reports.doctor-tier.test.js server/services/control/gate.test.js server/routes/rpc.test.js`
Expected: PASS (if `server/routes/rpc.test.js` does not exist, run `node --test server/services/control/` instead).

- [ ] **Step 5: Commit**

```bash
git add server/services/rpc/index.js server/services/control/gate.js server/services/rpc/reports.doctor-tier.test.js
git commit -m "feat(rpc): doctor_tier_positions — позиции строк врача за месяц, чтение (DOCTOR_TIER_V1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `service_save` accepts and validates the pair

**Files:**
- Modify: `server/services/rpc/service-save.js` (~143 validation; ~245 and ~267 the `cols`/`sets` objects)
- Modify: `server/services/rpc/service-save.test.js` (append; `freshDb()`, `admin`, `baseArgs(over)` and `serviceSave` already exist in that file — lines 17-39)

- [ ] **Step 1: Write the failing tests** (append)

```js
test('DOCTOR_TIER_V1: пара порог+доля сохраняется, нули = ступени нет', () => {
  const db = freshDb();
  const { id } = serviceSave(db, baseArgs({ doctor_tier_from: 25, doctor_tier_percent: 40 }), admin);
  assert.deepEqual(db.prepare('SELECT doctor_tier_from, doctor_tier_percent FROM services WHERE id = ?').get(id),
    { doctor_tier_from: 25, doctor_tier_percent: 40 });
  serviceSave(db, baseArgs({ id, doctor_tier_from: '', doctor_tier_percent: '' }), admin);
  assert.deepEqual(db.prepare('SELECT doctor_tier_from, doctor_tier_percent FROM services WHERE id = ?').get(id),
    { doctor_tier_from: 0, doctor_tier_percent: 0 });
});

test('DOCTOR_TIER_V1: одно без другого, дробный порог и доля > 100 — отказ 400', () => {
  const db = freshDb();
  for (const bad of [
    { doctor_tier_from: 25 },                             // без доли
    { doctor_tier_percent: 40 },                          // без порога
    { doctor_tier_from: 2.5, doctor_tier_percent: 40 },   // не целое
    { doctor_tier_from: -1, doctor_tier_percent: 40 },
    { doctor_tier_from: 25, doctor_tier_percent: 101 },
  ]) {
    assert.throws(() => serviceSave(db, baseArgs(bad), admin), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM services').get().n, 0, 'отказ ничего не создаёт');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test server/services/rpc/service-save.test.js`
Expected: the first new test FAILS (`{ doctor_tier_from: 0, doctor_tier_percent: 0 }` after saving 25/40); the second fails on the first `assert.throws`.

- [ ] **Step 3: Validate and store**

In `serviceSave`, right after `const defaultPct = clampPct(a.default_doctor_percent);` add:

```js
  // DOCTOR_TIER_V1 — ступень доли по объёму: порог (целое ≥ 0, 0 = нет) и
  // доля выше порога (0–100). Одно без другого — ошибка ввода, а не «половина
  // настройки»: экран не должен притворяться, что ступень есть.
  const optNum = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));
  const tierFrom = optNum(a.doctor_tier_from);
  if (!Number.isInteger(tierFrom) || tierFrom < 0) throw new RpcError('Порог ступени — целое число услуг в месяц (0 — без ступени).', 400);
  const tierPct = optNum(a.doctor_tier_percent);
  if (!Number.isFinite(tierPct) || tierPct < 0 || tierPct > 100) throw new RpcError('Доля выше порога — от 0 до 100 %.', 400);
  if ((tierFrom > 0) !== (tierPct > 0)) throw new RpcError('Ступень задаётся парой: порог услуг в месяц И доля выше порога.', 400);
```

In both the `cols` (insert) and `sets` (update) objects, after `default_doctor_percent: defaultPct, room_id: roomId,` add:

```js
        doctor_tier_from: tierFrom, doctor_tier_percent: tierPct,   // DOCTOR_TIER_V1
```

Update the JSDoc `args:` line to list `doctor_tier_from?, doctor_tier_percent?  (DOCTOR_TIER_V1, pair)`.

- [ ] **Step 4: Run the tests**

Run: `node --test server/services/rpc/service-save.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/rpc/service-save.js server/services/rpc/service-save.test.js
git commit -m "feat(услуги): service_save принимает ступень доли — пара порог+процент, иначе 400 (DOCTOR_TIER_V1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Service editor — two fields

**Files:**
- Modify: `public/js/admin/views/service-editor.js` (~161 inputs; ~257 payload; ~369 layout)
- Modify: `public/js/admin/i18n-strings.js` (append entries)
- Modify: `public/js/admin/__tests__/services-catalog.test.mjs` (append). The file already has: `SVC` (the one service row, `requires_doctor: 1`), `paint(user)` → renders the page and returns the container, `tags(root, 'tr'|'input'|'button')`, `buttonWith(root, text)`, `flush()`, and a fetch stub that records every `/api/rpc/<name>` call into `rpcCalls` as `{ name, args }` (lines 67-92). The editor mounts its overlay on `document.body`.

- [ ] **Step 1: Write the failing test** (append to `services-catalog.test.mjs`)

```js
test('DOCTOR_TIER_V1: в редакторе услуги есть порог и доля выше порога, и они уходят в service_save', async () => {
  SVC.requires_doctor = 0;   // без исполнителей: страж «отметьте исполнителя» не должен мешать этому тесту
  try {
    const c = await paint();
    tags(c, 'tr').find((r) => r.className.includes('row-click')).click();
    await flush();
    const inputs = tags(document.body, 'input');
    const from = inputs.find((i) => i.attrs.placeholder === '0 — нет');
    const pct  = inputs.find((i) => i.attrs.placeholder === 'напр. 40');
    assert.ok(from && pct, 'поля ступени не нарисованы');
    from.value = '25'; pct.value = '40';
    buttonWith(document.body, 'Сохранить').click();
    await flush();
    const save = rpcCalls.find((r) => r.name === 'service_save');
    assert.ok(save, 'service_save не вызван: ' + rpcCalls.map((r) => r.name).join(','));
    assert.equal(save.args.doctor_tier_from, 25);
    assert.equal(save.args.doctor_tier_percent, 40);
  } finally { SVC.requires_doctor = 1; }
});
```

If the fetch stub's `service_save` answer (`jsonOk({})`) makes the editor complain, extend the stub with `if (name === 'service_save') return jsonOk({ id: SVC.id, created: false, refs: {}, created_refs: [] });`.

- [ ] **Step 2: Run to see it fail**

Run: `node --test public/js/admin/__tests__/services-catalog.test.mjs`
Expected: FAIL — `поля ступени не нарисованы`.

- [ ] **Step 3: Add the inputs, payload and layout**

After `const pctInp = ...` (~line 161):

```js
    // DOCTOR_TIER_V1 — ступень доли по объёму (владелец: «more than 25 → 40 %»).
    // Пара полей; пустые — ступени нет. Правило и нумерацию считает сервер
    // (rpc/reports.js TIER_RANK_SQL); здесь только ввод.
    const tierFromInp = h('input', { type: 'number', step: '1', min: '0', value: row && row.doctor_tier_from ? row.doctor_tier_from : '', placeholder: '0 — нет' });
    const tierPctInp  = h('input', { type: 'number', step: '0.01', min: '0', max: '100', value: row && row.doctor_tier_percent ? row.doctor_tier_percent : '', placeholder: 'напр. 40' });
```

In the `args` payload after `default_doctor_percent: numOrNull(pctInp.value) ?? 0,`:

```js
            doctor_tier_from: numOrNull(tierFromInp.value) ?? 0,      // DOCTOR_TIER_V1
            doctor_tier_percent: numOrNull(tierPctInp.value) ?? 0,
```

In the layout, inside `grp('Цена и время', ...)` after the `grid(2, checkField(...reqDoc), unitField('Доля исполнителя по умолчанию', pctInp, '%'))` call add two more children:

```js
                h('div', { class: 'svc-ed-note' }, 'Ступень по объёму: начиная со следующей после порога услуги в календарном месяце доля исполнителя — не ниже указанной. Пусто — ступени нет.'),
                grid(2,
                    unitField('Порог, услуг в месяц', tierFromInp, 'шт.'),
                    unitField('Доля выше порога', tierPctInp, '%')),
```

If the editor has a `readOnly` branch that disables inputs (search `readOnly` in the file), include the two new inputs there the same way as `pctInp`.

- [ ] **Step 4: Dictionary entries** — append to the `STRINGS` object in `i18n-strings.js` (keep the file's existing key order convention; the coverage test tells you if it must be sorted):

```js
  "Порог, услуг в месяц": {"en":"Threshold, services per month","ru":"Порог, услуг в месяц","uz":"Chegara, oyiga xizmatlar"},
  "Доля выше порога": {"en":"Share above the threshold","ru":"Доля выше порога","uz":"Chegaradan yuqori ulush"},
  "0 — нет": {"en":"0 — none","ru":"0 — нет","uz":"0 — yo‘q"},
  "напр. 40": {"en":"e.g. 40","ru":"напр. 40","uz":"masalan, 40"},
  "Ступень по объёму: начиная со следующей после порога услуги в календарном месяце доля исполнителя — не ниже указанной. Пусто — ступени нет.": {"en":"Volume tier: starting from the service after the threshold within a calendar month, the performer's share is not lower than this. Empty — no tier.","ru":"Ступень по объёму: начиная со следующей после порога услуги в календарном месяце доля исполнителя — не ниже указанной. Пусто — ступени нет.","uz":"Hajm bo‘yicha pog‘ona: kalendar oyida chegaradan keyingi xizmatdan boshlab ijrochi ulushi ko‘rsatilganidan kam bo‘lmaydi. Bo‘sh — pog‘ona yo‘q."},
  "шт.": {"en":"pcs","ru":"шт.","uz":"dona"},
```

(Skip any key that already exists — grep first.)

- [ ] **Step 5: Run the tests**

Run: `node --test public/js/admin/__tests__/services-catalog.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/service-editor-lab-block.test.mjs public/js/admin/__tests__/service-editor-logic.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/js/admin/views/service-editor.js public/js/admin/i18n-strings.js public/js/admin/__tests__/services-catalog.test.mjs
git commit -m "feat(услуги): в редакторе услуги — порог услуг в месяц и доля выше порога (DOCTOR_TIER_V1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `tierShare()` — the cabinet's arithmetic

**Files:**
- Modify: `public/js/admin/views/doctor-dashboard.js` (after `serviceShare`, ~line 231)
- Modify: `public/js/admin/__tests__/doctor-dashboard.test.mjs` (append; `dash`, `DOCTOR_A`, `A_SERVICES` exist there)

- [ ] **Step 1: Write the failing test** (append)

```js
test('DOCTOR_TIER_V1: tierShare без позиции = serviceShare; с units_above делит по единицам и не понижает', () => {
  const rateMap = dash.serviceRateMap(DOCTOR_A);
  const s = { serviceId: A_SERVICES[0].serviceId, total: 300000, discount: 0, taxRate: 0 };
  const base = dash.serviceShare(s, rateMap);
  assert.strictEqual(dash.tierShare(s, rateMap, null), base);
  assert.strictEqual(dash.tierShare(s, rateMap, { units: 3, units_above: 0, tier_percent: 40 }), base);
  const pct = rateMap.get(String(s.serviceId)).percentage;
  // 3 единицы, 2 выше порога по 40 %: 300000 × (pct·1 + 40·2) / 3 / 100
  const expect = 300000 * (pct * 1 + 40 * 2) / 3 / 100;
  assert.strictEqual(Math.round(dash.tierShare(s, rateMap, { units: 3, units_above: 2, tier_percent: 40 })), Math.round(expect));
  // ступень ниже личного процента ничего не понижает
  assert.strictEqual(dash.tierShare(s, rateMap, { units: 1, units_above: 1, tier_percent: 1 }), base);
  // чужая услуга — 0, как у serviceShare
  assert.strictEqual(dash.tierShare({ serviceId: 's-99', total: 1000, discount: 0, taxRate: 0 }, rateMap, { units: 1, units_above: 1, tier_percent: 90 }), 0);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test public/js/admin/__tests__/doctor-dashboard.test.mjs`
Expected: FAIL — `dash.tierShare is not a function`.

- [ ] **Step 3: Implement** (right after `serviceShare`)

```js
/**
 * DOCTOR_TIER_V1 — доля строки с учётом ступени по объёму. pos — строка ответа
 * doctor_tier_positions для этой visit_service ({units, units_above,
 * tier_percent}) или null. Нумерацию считает СЕРВЕР; здесь только смесь по
 * единицам — та же формула, что ITEM_EFF_PCT_SQL в rpc/reports.js. Без
 * позиции, без единиц за порогом или при фиксированной ставке равна
 * serviceShare().
 */
export function tierShare(s, rateMap, pos) {
    const rate = rateMap.get(String(s.serviceId));
    if (!rate) return 0;
    if (rate.price) return serviceShare(s, rateMap);
    const units = pos && Number(pos.units) > 0 ? Number(pos.units) : 0;
    const above = units ? Math.max(0, Math.min(units, Number(pos.units_above) || 0)) : 0;
    if (!above) return serviceShare(s, rateMap);
    const base = Math.max(0, Number(s.total || 0) - Number(s.discount || 0));
    const taxRate = s.taxRate != null ? Number(s.taxRate) : 0;
    const net = base * (1 - taxRate / 100);
    const pct = rate.percentage || 0;
    const tierPct = Math.max(pct, Number(pos.tier_percent) || 0);
    return net * (pct * (units - above) + tierPct * above) / units / 100;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test public/js/admin/__tests__/doctor-dashboard.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/js/admin/views/doctor-dashboard.js public/js/admin/__tests__/doctor-dashboard.test.mjs
git commit -m "feat(кабинет): tierShare — доля строки со ступенью по позициям сервера (DOCTOR_TIER_V1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Cabinet «Зарплата» uses the positions and shows progress

**Files:**
- Modify: `public/js/admin/views/consultation.js` — `state.dash` init (~81), import list (~26-33), services mapping (~1529), after the discount block (~1580), `computeSalary` (~1667), `salaryConfigCard` (~1947), salary details row (~2223)
- Modify: `public/js/admin/__tests__/doctor-pay.test.mjs` (~131 fetch stub; append test)
- Modify: `public/js/admin/i18n-strings.js` (append entries)

- [ ] **Step 1: Write the failing test** (in `doctor-pay.test.mjs`)

Change the `/api/rpc/` stub at line ~131 to:

```js
  if (u.startsWith('/api/rpc/doctor_tier_positions')) {
    return { ok: true, json: async () => ({ data: TIER_RESPONSE }) };
  }
  if (u.startsWith('/api/rpc/')) return { ok: true, json: async () => ({ data: null }) };
```

Add near the seed constants (default: no tier; a test swaps it):

```js
let TIER_RESPONSE = { month: '', rows: [] };
```

Append the test (the file's `openPay()` at line ~147 renders the «Зарплата» tab for `DOC` and returns the host; `textOf(host)` flattens the text with normal spaces):

```js
test('DOCTOR_TIER_V1: позиции сервера меняют сумму и рисуют прогресс ступени', async () => {
  // sv-1 — 26-я строка месяца: 1 единица по ступени 50 % вместо личных 40 %.
  TIER_RESPONSE = { month: 'any', rows: [
    { visit_service_id: 'sv-1', service_id: 's-1', service_name: 'Приём', units: 1, units_above: 1, tier_from: 25, tier_percent: 50, count_so_far: 26 },
    { visit_service_id: 'sv-2', service_id: 's-1', service_name: 'Приём', units: 1, units_above: 0, tier_from: 25, tier_percent: 50, count_so_far: 25 },
  ] };
  try {
    const root = await openPay();
    const txt = textOf(root);
    // 100 000 × 50 % + 100 000 × 40 % = 90 000 (без ступени было бы 80 000)
    assert.ok(/90 000/.test(txt), 'сумма не учла ступень: ' + txt.slice(0, 300));
    assert.ok(/Ступень: Приём/.test(txt), 'нет строки прогресса ступени');
    assert.ok(/26 из 25/.test(txt), 'прогресс не показывает счёт месяца');
  } finally { TIER_RESPONSE = { month: '', rows: [] }; }
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test public/js/admin/__tests__/doctor-pay.test.mjs`
Expected: FAIL — `сумма не учла ступень` (80 000 shown).

- [ ] **Step 3: Wire the cabinet**

(a) Import: add `tierShare` to the list imported from `./doctor-dashboard.js` (~line 26-33).

(b) `state.dash` initialiser (~line 81): add `tierPos: new Map(), tierProgress: [],`.

(c) Services mapping (~line 1529): add `visitDate: r.visits?.visit_date || r.created_at,` to the mapped object.

(d) After the discount `try { ... } catch` block (~line 1580) add:

```js
    // DOCTOR_TIER_V1 — позиции строк по ступеням за каждый затронутый месяц.
    // Нумерацию считает сервер (doctor_tier_positions); кабинет только
    // применяет её тем же правилом, что отчёт (tierShare). Текущий месяц
    // запрашивается всегда — прогресс «18 из 25» нужен и когда за выбранный
    // период строк нет.
    state.dash.tierPos = new Map();
    state.dash.tierProgress = [];
    try {
        const nowKey = localMonthKey(new Date());
        const months = new Set(state.dash.services.map(s => localMonthKey(s.visitDate)).filter(Boolean));
        months.add(nowKey);
        for (const month of months) {
            const { data, error } = await supabase.rpc('doctor_tier_positions', { doctor_id: docId, month });
            if (error || !data || !Array.isArray(data.rows)) continue;
            for (const p of data.rows) state.dash.tierPos.set(String(p.visit_service_id), p);
            if (month !== nowKey) continue;
            const byService = new Map();
            for (const p of data.rows) {
                const key = String(p.service_id);
                const cur = byService.get(key);
                if (!cur || Number(p.count_so_far) > cur.count) {
                    byService.set(key, { serviceName: p.service_name || '', count: Number(p.count_so_far) || 0,
                                         from: Number(p.tier_from) || 0, pct: Number(p.tier_percent) || 0 });
                }
            }
            state.dash.tierProgress = [...byService.values()];
        }
    } catch (e) { console.warn('[dash] tier positions:', e && e.message); }
```

and add the helper next to `periodRange`:

```js
// DOCTOR_TIER_V1 — местный 'YYYY-MM' даты: календарный месяц ступени считается
// по местному времени клиники, как localMonth() в отчётах.
function localMonthKey(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d)) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
```

(e) `computeSalary` (~line 1667):

```js
    const variableComponent = earning.reduce((sum, s) => sum + tierShare(s, rateMap, state.dash.tierPos.get(String(s.id)) || null), 0);
```

Also line ~1887 (`row.services += serviceShare(s, rateMap)`) → `tierShare(s, rateMap, state.dash.tierPos.get(String(s.id)) || null)`, so the chart adds up to the tile (CABINET_REDESIGN_V1 rule 1).

(f) `salaryConfigCard` (~line 1947), after the `Показатели KPI` row add:

```js
        ...state.dash.tierProgress.map(p => kvRow(
            trf('Ступень: {service}', { service: p.serviceName }),
            p.count > p.from
                ? trf('{count} из {from} в этом месяце · ступень {pct}% действует', { count: p.count, from: p.from, pct: p.pct })
                : trf('{count} из {from} в этом месяце · с {next}-й доля {pct}%', { count: p.count, from: p.from, next: p.from + 1, pct: p.pct }))),
```

(g) Salary details row (~line 2223): `const share = Math.round(serviceShare(s, rateMap));` → `const pos = state.dash.tierPos.get(String(s.id)) || null; const share = Math.round(tierShare(s, rateMap, pos));` and, where the share cell is built, append a marker when `pos && Number(pos.units_above) > 0`: `h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '6px' } }, tr('ступень'))`.

- [ ] **Step 4: Dictionary entries** (append to `i18n-strings.js`)

```js
  "Ступень: {service}": {"en":"Tier: {service}","ru":"Ступень: {service}","uz":"Pog‘ona: {service}"},
  "{count} из {from} в этом месяце · ступень {pct}% действует": {"en":"{count} of {from} this month · {pct}% tier active","ru":"{count} из {from} в этом месяце · ступень {pct}% действует","uz":"Shu oyda {from} dan {count} · {pct}% pog‘ona amalda"},
  "{count} из {from} в этом месяце · с {next}-й доля {pct}%": {"en":"{count} of {from} this month · from the {next}th the share is {pct}%","ru":"{count} из {from} в этом месяце · с {next}-й доля {pct}%","uz":"Shu oyda {from} dan {count} · {next}-chisidan ulush {pct}%"},
  "ступень": {"en":"tier","ru":"ступень","uz":"pog‘ona"},
```

- [ ] **Step 5: Run the tests**

Run: `node --test public/js/admin/__tests__/doctor-pay.test.mjs public/js/admin/__tests__/doctor-dashboard.test.mjs public/js/admin/__tests__/head-doctor-cabinet.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/js/admin/views/consultation.js public/js/admin/__tests__/doctor-pay.test.mjs public/js/admin/i18n-strings.js
git commit -m "feat(кабинет): вкладка «Зарплата» считает по позициям ступени и показывает прогресс «N из M» (DOCTOR_TIER_V1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Whole suite, plan checkboxes

- [ ] **Step 1: Run everything**

Run: `npm test` (10–15 minutes). Expected: all green. Fix anything red before continuing; a red test is never "unrelated" until proven so.

- [ ] **Step 2: Tick the checkboxes in this plan** and commit the plan file:

```bash
git add docs/plans/2026-09-19-doctor-tier-percent.md
git commit -m "docs(зарплата): план ступени доли врача — выполнен (DOCTOR_TIER_V1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Not in this plan (owner's decision, see `CONTRIBUTING.md`): merging to `main`, pushing, tagging, `RELEASE_NOTES.md`.
