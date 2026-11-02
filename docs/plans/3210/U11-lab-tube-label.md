# U11 — Этикетка на пробирку, номер не меняется (LAB_TUBE_LABEL_V1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the card's «Штрих-код» in Лаборатория prints one label per tube (not one per visit with the newest line's number); the label number is the oldest open line of the tube and does not change when tests are added; the label lists short test names; label time is the clinic PC's local time; the barcode has a quiet zone. The owner's photo case (visit 20: blood + urine in two invoices) — the blood tube's label leads BC-780 to the blood line.

**Architecture:** one pure module `public/js/admin/views/lab-tube.js` (`tubeGroups(rows, opts)` + helpers, no DOM) decides tubes; `laboratory.js` only wires it to the card and the print window. The tube key copies the ingest's own rules, so a tube is exactly the set ingest fills from one sample: local day (as `orderAge`), analyzer feeding the service (`lab_panels.device_id`, as `orderSide`), material (`specimenKey`, as D3). `specimenKey` moves verbatim from `server/lis/ingest.js` to `public/js/shared/specimen-key.js` (ingest re-exports it — no behaviour change). `lab-barcode.js`: Code128 set C for even-length all-digit values (all 8-digit labels), 10-module quiet zone inside the SVG, several labels in one print window. **Ingest rules do not change** (Task U11.5 proves the photo case with the unchanged ingest).

**Tech Stack:** Node 24 ESM, better-sqlite3, vanilla-JS SPA (`h()`, `Icon()`, `tr()`), `node:test`.

**Spec:** `docs/specs/2026-11-02-3210-batch-design.md`, section U11 and owner rule **К4** (section «К», added in `5fa59531`). Base: `rc/3.21.0` at `5fa59531` (= `347bfd3d` + that spec section; no code changed in between).

**Verified before writing:** every code block below was applied to a scratch copy of `5fa59531` (no `data/`, no git) and run: all new tests pass, and each edit's exact old text was checked to occur exactly once. Line numbers are for `347bfd3d`; edits are anchored by text.

## File map

| File | Change |
|---|---|
| `public/js/shared/specimen-key.js` | **new** — `specimenKey` moved from ingest.js verbatim (pure, no imports) |
| `server/lis/ingest.js` | import + re-export `specimenKey` (`:45`, `:790-798`); nothing else |
| `server/lis/specimen-key-shared.test.js` | **new** — ingest and shared module export the same function |
| `public/js/admin/views/lab-barcode.js` | Code128 set C for digit pairs; `QUIET_MODULES`; `printBarcodeLabels` (one window, many labels, «tests» line); `printBarcodeLabel` delegates |
| `public/js/admin/__tests__/lab-barcode.test.mjs` | **new** — python-barcode vectors, standard vector for «99», round trip, quiet zone, print window |
| `public/js/admin/views/lab-tube.js` | **new** — `tubeGroups`, `tubeDeviceMap`, `tubeDay`, `localDay`, `shortTestName`, `tubeLabelStamp`, `TUBE_STATUSES` |
| `public/js/admin/__tests__/lab-tube.test.mjs` | **new** — pure rules, photo case, order independence, later lines, local day |
| `server/lis/tube-label.test.js` | **new** — photo case through the real ingest: label from `tubeGroups` → BC-780 → blood line |
| `public/js/admin/views/laboratory.js` | panels select `device_id`; `state.deviceByService`; `paintRows` builds `byVisit`; card «Штрих-код» → `printTubeLabels`; card «Проба» = first tube; row label local time + test name; «Забор пробы» uses `printLabel` |
| `public/js/admin/i18n-strings.js` | three entries: the new button title (U11.6), two К4 cashier sentences (U11.8) |
| `public/js/admin/__tests__/lab-card.test.mjs` | `released` card loses «Штрих-код» (no open tube) |
| `public/js/admin/__tests__/lab-tube-label.test.mjs` | **new** — mounted queue: labels per tube, one window, local time, tab independence, refunded line (К4), row label |
| `public/js/admin/views/cashier-line-fix.js` | К4: `openRefundSwap` tells `onDone` whether a lab test was swapped (`:532`) |
| `public/js/admin/views/cashier-desk.js` | К4: `afterRefundSwap` adds «Перепечатайте этикетку пробирки…» (`:2417`) |
| `public/js/admin/__tests__/refund-swap.test.mjs` | К4: one test appended |

## Rules

- Repo `C:\Users\user\Desktop\implementation workflow\easymed.api5`, branch `rc/3.21.0`. Run every command from the repo root. Never open `data/` or any real `.db`.
- Tests: `node --experimental-vm-modules --test <explicit file paths>` (Windows, Node 24 — explicit files, no folders). The LIS files (`server/lis/*`) run WITHOUT `LIS_ENABLED=0`.
- Edits only with Edit/Write (no heredoc in Bash — it eats backslashes; `lab-barcode.js` and `specimen-key.js` contain `\d` / `\s`).
- Commits: check `git diff --cached --name-only` is empty first; `git add` only the named files; message in Russian in a file (`.git/U11-<n>.msg`, written with Write), `git commit -F .git/U11-<n>.msg`; last line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. LF line endings.
- Marker `LAB_TUBE_LABEL_V1` in a Russian comment on every change. New UI text → ru/uz/en in `i18n-strings.js` (no Cyrillic in uz/en). Icons only via `Icon()`.
- Time zone in tests: `process.env.TZ = 'Asia/Tashkent'` before the first `Date`. **Not** `'UZT-5'`: on Windows Node 24 the POSIX string is silently read as UTC for JS `Date` (checked: `UZT-5` → 14:06, `Asia/Tashkent` → 19:06). The `UZT-5` in other tests is for SQLite `localtime`, a different thing.

## Design corrections (read before the tasks)

1. **«Group by analyzer» needs material inside the analyzer.** One BS-200 runs serum and urine (`tube-anchor.test.js` `twoMaterialClinic`); one label for both would be one number for two tubes. The key is analyzer **and** material (`specimenKey`) — exactly the set ingest D3 fills from one sample (`siblingSides` filters by `specimenKey`). No analyzer → material; no material → one label per line (as designed).
2. **«Oldest line of the group» must be the oldest OPEN PAID line** (`queued`, `collected`, `in_progress`, `resulted`). The label carries a bare 8-digit number; ingest refuses a bare number of a closed order (`bareIdRefusal`, `ingest.js:194-204`) and gates an unpaid one (`gateRefusal`, `:162-166`). `added`, `completed`, cancelled and refunded-without-result lines are not in any tube.
3. **The day is part of the key.** A long (inpatient) visit keeps open lines for days; without the day, today's tube would get the number of a forgotten line from last week (ingest would put today's values there — tier 0 takes its codes — or refuse it as older than 7 days). Day = latest of created / scheduled / visit day, not later than today, local — the same rule as `orderAge` (`ingest.js:214-223`). Over-splitting is harmless: every label number is a line the analyzer feeds.
4. **«The analyzer that feeds the line» = the service's panel device** (`lab_panels.device_id`, one panel per service — unique index, migration 048; ingest `orderSide` takes the active panel, first by id). `lab_panel_analytes.device_code` / `LIS_MINDRAY_CODES_V1` map analytes, not lines. Only services with `is_lab = 1` group by analyzer: ingest refuses a non-`is_lab` order outright (`ingest.js:1288-1292`), whatever the label.
5. **Ingest needs no change** and should NOT be taught «prefer the label line's own group/invoice»: a new label always names a line its analyzer feeds, so ingest never takes the `tubeAnchor` path for it; `planTube` gives the tube order its own codes first, so a duplicate blood line (#31) stays empty instead of «неоднозначно». Old labels (00000032 on tubes already in the lab) stay «неоднозначно» by the owner's M1 rule (no guessing) — the lab uses «Привязать». Pinned in U11.5.
6. **Short test names do not exist in the catalogue** (`services` has `name`/`code`; panel `code` is a slug like `obschiy-analiz-krovi`). `shortTestName` derives one: an abbreviation in the name («АМГ»), else the first item in brackets («ОАК»), else the name cut to 18 characters.
7. **The card's «Проба LAB-…» had the same bug** (`groupLabRows` stamps the first visible row = newest). It now shows the first tube's number (same digits as its label); with no open tube — as before.
8. **Code128 set C** is chosen for even-length all-digit values: 79 modules instead of 123 for 8 digits, so on the same 58 mm label each bar is 1.45× wider (≈4 dots instead of ≈3 at 203 dpi). Decoders treat A/B/C as one symbology and output the same digits; printed B labels keep reading. Vectors: python-barcode 0.16.1 — **except a leading «99» pair, which python-barcode drops** (`99999999` → `999999`); that one is checked against the standard. Procurement batch labels (`procurement.js:3754`, same `barcodeSVG`) also get set C for digit-only batch codes and the quiet zone.
9. **Per-line labels keep the line's own number** («Печать этикетки», «Забор пробы»): that number always points at its own line, which is the most precise; they only get local time and the test name.
10. **К4 (owner, 2026-11-02, spec section «К»).** (a) Tubes never take returned, released-with-refund or cancelled lines: cancelled are not in the lab query at all; «услуга возвращена» lines (rpc `refunded_lines` → `state.refundedIds`, the set the queue already marks) are passed as `skipIds` — pinned by a pure test (U11.4) and a mounted one (U11.6). (b) After «Заменить услугу» in «Платежи» touches a lab test (old or new service), the cashier's notice ends with «Перепечатайте этикетку пробирки.» (ordinary swap: same line number, different test in the tube) or «… у нового анализа новый номер.» («Вернуть эту услугу и выставить новую»: new line) — Task U11.8. The head cashier's «Исправить услуги» paid swap (`openLineFix` → `openSwapConfirm`) is not one of the two «Платежи» doors К4 names; left as is (see Risks).

---

### Task U11.1: one material rule for ingest and labels

**Files:**
- Create: `public/js/shared/specimen-key.js`
- Modify: `server/lis/ingest.js` (`:45` import; `:790-798` function → re-export)
- Test: `server/lis/specimen-key-shared.test.js` (new)

- [ ] **Step 1: Write the failing test** — create `server/lis/specimen-key-shared.test.js`:

```js
// LAB_TUBE_LABEL_V1 — материал пробирки один для приёма и для этикетки.
//
// Очередь лаборатории теперь делит строки визита на пробирки (этикетка на
// каждую), а приём делит заказы визита между пробирками (D3) — по одному и тому
// же ключу материала. Две копии правила разошлись бы при первой правке, и
// этикетка назвала бы пробирку, которую приём заполняет по-другому. Поэтому
// правило одно (public/js/shared/specimen-key.js), а ingest.js его реэкспортирует.
import test from 'node:test';
import assert from 'node:assert/strict';
import { specimenKey as fromIngest } from './ingest.js';
import { specimenKey as fromShared } from '../../public/js/shared/specimen-key.js';

test('приём берёт правило материала из общего модуля — это одна и та же функция', () => {
  assert.equal(typeof fromShared, 'function');
  assert.equal(fromIngest, fromShared);
});

test('правило прежнее: моча, плазма, сыворотка, кровь — по слову; прочее — текстом; пусто — не указан', () => {
  assert.deepEqual(
    ['Моча', 'Плазма крови (цитрат)', 'Сыворотка крови', 'Цельная кровь (ЭДТА)', 'whole blood', '  Мокрота ', null, '', '   '].map(fromShared),
    ['urine', 'plasma', 'serum', 'blood', 'blood', 'мокрота', '', '', ''],
  );
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `node --experimental-vm-modules --test server/lis/specimen-key-shared.test.js`
Expected: the file fails to load — `ERR_MODULE_NOT_FOUND` … `public/js/shared/specimen-key.js`.

- [ ] **Step 3: Create `public/js/shared/specimen-key.js`**

```js
// LAB_TUBE_LABEL_V1 — материал услуги словом-ключом. ОДНО правило для двух мест:
//   • приём результатов (server/lis/ingest.js, D3 «одна пробирка — все услуги»):
//     какие заказы визита заполняет одна пробирка;
//   • очередь лаборатории (admin/views/lab-tube.js): какие строки визита идут в
//     одну пробирку и получают одну этикетку.
// Разойтись им нельзя: этикетка назвала бы пробирку, которую приём заполняет
// по-другому. Перенесено из ingest.js без изменений (там — реэкспорт).
//
// LIS_PROXY_V1 (ревью C1) — материал услуги (services.specimen, свободный текст
// «Материал (кровь, моча…)») для «одна пробирка — все услуги» (D3): моча,
// плазма, сыворотка, кровь — по слову (плазма и сыворотка раньше крови:
// «плазма крови», «сыворотка крови»); прочее — сам текст без регистра и лишних
// пробелов; пусто — '' (не указан). Делят пробирку только заказы с одним
// ключом: не указан у обоих — делят (клиника, которая поле не заполняет,
// ничего не теряет); у одного — не делят (значение — «не использованы», его
// видно). Кровь и сыворотка — разные пробирки (ЭДТА и сыворотка), хотя BS-200
// обе называет serum (lisproxy-form.js biomaterialOf): HbA1c из цельной крови
// не идёт в рабочий список пробирки сыворотки.
//
// Модуль чистый: без DOM, без сети, без импортов — его грузят и сервер, и браузер.
export function specimenKey(specimen) {
    const s = String(specimen == null ? '' : specimen).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return '';
    if (/моч|urine/.test(s)) return 'urine';
    if (/плазм|plasma/.test(s)) return 'plasma';
    if (/сыворот|serum/.test(s)) return 'serum';
    if (/кров|blood/.test(s)) return 'blood';
    return s;
}
```

- [ ] **Step 4: Make ingest use it.** Two edits in `server/lis/ingest.js`.

Edit 1 of 2 in `server/lis/ingest.js` — old_string:

```js
import { refundedWithoutResult } from '../services/domain/pay-releases.js';   // REFUND_ANY_V1 — «по заказу возврат»
```

new_string:

```js
import { refundedWithoutResult } from '../services/domain/pay-releases.js';   // REFUND_ANY_V1 — «по заказу возврат»
import { specimenKey } from '../../public/js/shared/specimen-key.js';   // LAB_TUBE_LABEL_V1 — одно правило материала для приёма и этикетки
```

Edit 2 of 2 in `server/lis/ingest.js` — old_string:

```js
export function specimenKey(specimen) {
  const s = String(specimen == null ? '' : specimen).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (/моч|urine/.test(s)) return 'urine';
  if (/плазм|plasma/.test(s)) return 'plasma';
  if (/сыворот|serum/.test(s)) return 'serum';
  if (/кров|blood/.test(s)) return 'blood';
  return s;
}
```

new_string:

```js
// LAB_TUBE_LABEL_V1 — само правило живёт в public/js/shared/specimen-key.js:
// им же очередь лаборатории делит строки визита на пробирки (этикетка на
// пробирку, номер — самая старая строка), и делить они обязаны одинаково.
// Экспорт отсюда оставлен — его берут specimen-share.test.js и прочие.
export { specimenKey };
```

(The doc comment above the old function stays — it still describes the rule.)

- [ ] **Step 5: Run — expect PASS**

Run: `node --experimental-vm-modules --test server/lis/specimen-key-shared.test.js server/lis/specimen-share.test.js`
Expected: `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 6: Commit** — write `.git/U11-1.msg`:

```
Этикетка на пробирку (LAB_TUBE_LABEL_V1), шаг 1: правило материала пробирки — в общем модуле

specimenKey перенесён без изменений из server/lis/ingest.js в
public/js/shared/specimen-key.js: им же очередь лаборатории будет делить
строки визита на пробирки. Приём импортирует и реэкспортирует его —
поведение то же.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git diff --cached --name-only
git add public/js/shared/specimen-key.js server/lis/ingest.js server/lis/specimen-key-shared.test.js
git commit -F .git/U11-1.msg
```

---

### Task U11.2: Code128 set C for the label number, quiet zone

**Files:**
- Modify: `public/js/admin/views/lab-barcode.js` (`:1-5` header, `:9-40` encoder and SVG)
- Test: `public/js/admin/__tests__/lab-barcode.test.mjs` (new)

- [ ] **Step 1: Write the failing test** — create `public/js/admin/__tests__/lab-barcode.test.mjs`:

```js
// LAB_TUBE_LABEL_V1 (решение владельца 2026-11-02) — штрих-код этикетки пробирки.
//
// Номер этикетки — 8 цифр (LAB_BARCODE_DIGITS_V1). Теперь он кодируется набором C
// Code128 (пара цифр — один знак: символ короче, полоски шире) и окружён тихой
// зоной в 10 модулей. Прочие строки — набором B, как было. Несколько этикеток
// (пробирки визита) печатаются одним окном.
//
// Эталоны — python-barcode 0.16.1 (им же когда-то сверена таблица). Он теряет
// ВЕДУЩУЮ пару «99» в наборе C (99999999 → 999999), поэтому «00000099» и
// «99999999» сверены по стандарту (ISO/IEC 15417), а не по нему.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const printed = [];
let opened = 0;
globalThis.window = { open: () => { opened++; return { document: { write(s) { printed.push(String(s)); }, close() {} } }; } };
globalThis.alert = (m) => { throw new Error('alert: ' + m); };

const { code128Modules, barcodeSVG, printBarcodeLabels, printBarcodeLabel, QUIET_MODULES } = await import('../views/lab-barcode.js');

const START_B = '11010010000';
const START_C = '11010011100';
const STOP = '1100011101011';

// python-barcode 0.16.1, Code128 (сам выбрал набор C).
const PY_C = {
    '00000028': '1101001110011011001100110110011001101100110011100110100110001001001100011101011',
    '00000032': '1101001110011011001100110110011001101100110011000110110111011001001100011101011',
    '12345678': '1101001110010110011100100010110001110001011011000010100100011101101100011101011',
    '17874421': '1101001110010011100110111100101001000110111011011100100101111011101100011101011',   // контрольный знак 100
};
// python-barcode 0.16.1, чистый набор B — прежний вид не изменился.
const PY_B = {
    'ABCDEF': '11010010000101000110001000101100010001000110101100010001000110100010001100010101100011101100011101011',
    'LAB-9': '110100100001000110111010100011000100010110001001101110011100101100100101111001100011101011',
};

test('номер этикетки (8 цифр) — набор C, побайтово как у python-barcode', () => {
    for (const [code, want] of Object.entries(PY_C)) assert.equal(code128Modules(code), want, code);
    assert.equal(code128Modules('00000028').length, 79, 'Start C + 4 пары + контрольный + Stop');
});

test('пара «99» — по стандарту: Start C, 00 00 00 99, контрольный (105 + 4·99) mod 103 = 89, Stop', () => {
    const want = START_C + '11011001100'.repeat(3) + '10111011110' + '11011011110' + STOP;
    assert.equal(code128Modules('00000099'), want);
});

test('всё, кроме чётного числа одних цифр, — набор B, как было', () => {
    for (const [code, want] of Object.entries(PY_B)) assert.equal(code128Modules(code), want, code);
    for (const code of ['0000003', 'LAB-000032', '00000028 ', '', null]) {
        assert.ok(code128Modules(code).startsWith(START_B), JSON.stringify(code) + ' — набор B');
    }
});

// Рисунки знаков 0…99 — из самого кодировщика (таблица прибита эталонами выше);
// 100…102 бывают только контрольным знаком — по стандарту.
const PAIR = Array.from({ length: 100 }, (_, v) => code128Modules(String(v).padStart(2, '0')).slice(11, 22));
const HIGH = { 100: '10111101110', 101: '11101011110', 102: '11110101110' };
const symbol = (v) => (v < 100 ? PAIR[v] : HIGH[v]);

test('набор C читается обратно для номеров 1…3000 и крайних: те же цифры, контрольный знак по стандарту', () => {
    assert.equal(new Set(PAIR).size, 100, 'у каждой пары свой рисунок');
    const nums = [...Array.from({ length: 3000 }, (_, i) => i + 1), 9999999, 10000000, 99999999];
    for (const n of nums) {
        const code = String(n).padStart(8, '0');
        const m = code128Modules(code);
        assert.equal(m.length, 79, code);
        assert.ok(m.startsWith(START_C) && m.endsWith(STOP), code);
        const vals = [0, 1, 2, 3].map((i) => PAIR.indexOf(m.slice(11 + 11 * i, 22 + 11 * i)));
        assert.equal(vals.map((v) => String(v).padStart(2, '0')).join(''), code, 'прочитано не то: ' + code);
        const check = (105 + vals.reduce((s, v, i) => s + (i + 1) * v, 0)) % 103;
        assert.equal(m.slice(55, 66), symbol(check), 'контрольный знак: ' + code);
    }
});

test('тихая зона: 10 модулей пустоты с каждой стороны, растягивается вместе с полосками', () => {
    assert.equal(QUIET_MODULES, 10);
    const svg = barcodeSVG('00000028', { moduleW: 1.4, height: 48 });
    const w = parseFloat(/ width="([\d.]+)"/.exec(svg)[1]);
    const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)].map((m) => [parseFloat(m[1]), parseFloat(m[2])]);
    assert.ok(Math.abs(w - (79 + 20) * 1.4) < 0.05, 'ширина — символ и две зоны: ' + w);
    assert.ok(Math.abs(rects[0][0] - 14) < 0.005, 'слева 10 модулей: ' + rects[0][0]);
    const [lx, lw] = rects[rects.length - 1];
    assert.ok(Math.abs(w - (lx + lw) - 14) < 0.05, 'справа 10 модулей: ' + (w - lx - lw));
    assert.match(svg, /viewBox="0 0 138\.6 48"/);
    assert.match(barcodeSVG('00000028', { moduleW: 1.4, quiet: 0 }), /<rect x="0\.00"/, 'quiet: 0 — без зоны');
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-barcode.test.mjs`
Expected: `ℹ pass 1`, `ℹ fail 4` — the set-C vectors (the old encoder starts with Start B `11010010000`), «99», round trip, quiet zone (`QUIET_MODULES` is `undefined`). «всё, кроме чётного числа одних цифр, — набор B» passes already (it pins the old behaviour).

- [ ] **Step 3: Implement** — two edits in `public/js/admin/views/lab-barcode.js` (the `C128` table line 6 stays as is).

Edit 1 — old_string (`:1-5`):

```js
// lab-barcode.js — self-contained Code128-B generator + printer-agnostic label printer.
// (единственный import — локальный модуль шрифтов печати; CDN по-прежнему нет.)
import { PRINT_FONT_FACE_CSS } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1
// No external deps / no CDN (CSP-safe). Pattern table + checksum validated byte-for-byte
// against python-barcode 0.16.1 (pure-B vectors "ABCDEF", "LAB-9").
```

new_string:

```js
// lab-barcode.js — self-contained Code128 generator + printer-agnostic label printer.
// (единственный import — локальный модуль шрифтов печати; CDN по-прежнему нет.)
import { PRINT_FONT_FACE_CSS } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1
// No external deps / no CDN (CSP-safe). Pattern table + checksum validated byte-for-byte
// against python-barcode 0.16.1 (pure-B vectors "ABCDEF", "LAB-9"; set-C vectors
// "00000028", "00000032", "12345678", "17874421" — __tests__/lab-barcode.test.mjs).
```

Edit 2 — old_string (`:9-40`, the encoder and `barcodeSVG`):

```js
// Code128-B module string ("1"=bar, "0"=space). Encodes printable ASCII 32..126.
export function code128Modules(text) {
    const s = String(text == null ? "" : text);
    const vals = [104];                 // Start B
    let sum = 104;
    for (let i = 0; i < s.length; i++) {
        let v = s.charCodeAt(i) - 32;
        if (v < 0 || v > 94) v = 0;     // out-of-range -> space (safe)
        vals.push(v);
        sum += (i + 1) * v;             // weighted, 1-based
    }
    vals.push(sum % 103);               // checksum
    let out = "";
    for (const v of vals) out += C128[v];
    return out + STOP;
}

// Render the code as crisp SVG bars (runs of "1" merged into single rects).
export function barcodeSVG(text, opts) {
    const { height = 42, moduleW = 1.5, color = "#000" } = opts || {};
    const mods = code128Modules(text);
    const w = mods.length * moduleW;
    let rects = "", i = 0;
    while (i < mods.length) {
        if (mods[i] === "1") {
            let j = i; while (j < mods.length && mods[j] === "1") j++;
            rects += `<rect x="${(i * moduleW).toFixed(2)}" y="0" width="${((j - i) * moduleW).toFixed(2)}" height="${height}" fill="${color}"/>`;
            i = j;
        } else i++;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}" height="${height}" viewBox="0 0 ${w.toFixed(1)} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges">${rects}</svg>`;
}
```

new_string:

```js
// LAB_TUBE_LABEL_V1 — номер этикетки (8 цифр, LAB_BARCODE_DIGITS_V1) кодируется
// НАБОРОМ C: пара цифр — один знак. Символ короче, чем в наборе B (79 модулей
// против 123), и на той же этикетке 58 мм каждая полоска в 1,45 раза шире:
// термопринтер 203 dpi рисует узкую полоску 4 точками, а не 3, и сканер
// анализатора читает увереннее. Сканер отдаёт те же цифры — Code128 один, A/B/C —
// его наборы; напечатанные раньше этикетки (набор B) читаются, как прежде.
// Набор C — только для чётного числа одних цифр; всё прочее — набор B, как было.
// Эталоны набора C сверены с python-barcode 0.16.1, КРОМЕ ведущей пары «99»: он
// её теряет (99999999 → 999999); она сверена по стандарту (ISO/IEC 15417).
const DIGIT_PAIRS = /^(?:\d\d)+$/;

// Code128 module string ("1"=bar, "0"=space). Set B encodes printable ASCII 32..126.
export function code128Modules(text) {
    const s = String(text == null ? "" : text);
    const vals = [];
    if (DIGIT_PAIRS.test(s)) {          // LAB_TUBE_LABEL_V1 — Start C, затем пары цифр
        vals.push(105);
        for (let i = 0; i < s.length; i += 2) vals.push(Number(s.slice(i, i + 2)));
    } else {
        vals.push(104);                 // Start B
        for (let i = 0; i < s.length; i++) {
            let v = s.charCodeAt(i) - 32;
            if (v < 0 || v > 94) v = 0; // out-of-range -> space (safe)
            vals.push(v);
        }
    }
    let sum = vals[0];
    for (let i = 1; i < vals.length; i++) sum += i * vals[i];   // weighted, 1-based
    vals.push(sum % 103);               // checksum
    let out = "";
    for (const v of vals) out += C128[v];
    return out + STOP;
}

// LAB_TUBE_LABEL_V1 — ТИХАЯ ЗОНА: 10 модулей пустоты с каждой стороны (ISO/IEC
// 15417 — не меньше 10X). Раньше полоски шли от края до края картинки, а её
// растягивают на всю ширину этикетки: сканер не видел, где символ начинается, а
// сдвиг этикетки в принтере на миллиметр съедал крайнюю полоску. Зона — часть
// картинки, поэтому растягивается вместе с полосками и всегда равна 10 модулям.
export const QUIET_MODULES = 10;

// Render the code as crisp SVG bars (runs of "1" merged into single rects).
export function barcodeSVG(text, opts) {
    const { height = 42, moduleW = 1.5, color = "#000", quiet = QUIET_MODULES } = opts || {};
    const mods = code128Modules(text);
    const q = Math.max(0, Math.floor(Number(quiet) || 0));
    const w = (mods.length + 2 * q) * moduleW;
    let rects = "", i = 0;
    while (i < mods.length) {
        if (mods[i] === "1") {
            let j = i; while (j < mods.length && mods[j] === "1") j++;
            rects += `<rect x="${((i + q) * moduleW).toFixed(2)}" y="0" width="${((j - i) * moduleW).toFixed(2)}" height="${height}" fill="${color}"/>`;
            i = j;
        } else i++;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}" height="${height}" viewBox="0 0 ${w.toFixed(1)} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges">${rects}</svg>`;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-barcode.test.mjs`
Expected: `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 5: Commit** — write `.git/U11-2.msg`:

```
Этикетка на пробирку (LAB_TUBE_LABEL_V1), шаг 2: номер этикетки — набором C, тихая зона

Восемь цифр номера кодируются набором C Code128 (пара цифр — один знак):
символ короче, полоски на той же этикетке в 1,45 раза шире. Прочие строки —
набором B, как было; напечатанные этикетки читаются, как прежде. Вокруг
штрих-кода — 10 модулей пустоты с каждой стороны (тихая зона), внутри
картинки, поэтому растягивается вместе с полосками.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git diff --cached --name-only
git add public/js/admin/views/lab-barcode.js public/js/admin/__tests__/lab-barcode.test.mjs
git commit -F .git/U11-2.msg
```

---

### Task U11.3: several labels in one print window, «what is in the tube» line

**Files:**
- Modify: `public/js/admin/views/lab-barcode.js` (`:42-81`, from `const _esc` to the end)
- Test: `public/js/admin/__tests__/lab-barcode.test.mjs` (append)

- [ ] **Step 1: Append the failing tests** to the end of `public/js/admin/__tests__/lab-barcode.test.mjs` (after one blank line):

```js
test('несколько этикеток — одним окном печати; на каждой номер, время, пациент и что в пробирке', () => {
    printed.length = 0; opened = 0;
    const ok = printBarcodeLabels([
        { code: '00000028', patientName: 'Тестов <Пациент>', mrn: 'P-1', dateStr: '02.11.2026, 19:06', tests: 'ОАК, СОЭ' },
        { code: '00000029', patientName: 'Тестов <Пациент>', mrn: 'P-1', dateStr: '02.11.2026, 19:07', tests: 'ОАМ' },
    ]);
    assert.equal(ok, true);
    assert.equal(opened, 1, 'второе окно подряд браузер заблокирует — одно окно на все этикетки');
    const html = printed[0];
    assert.equal((html.match(/<div class="lbl">/g) || []).length, 2);
    assert.match(html, /class="acc">№ 00000028</);
    assert.match(html, /class="acc">№ 00000029</);
    assert.match(html, /class="tests">ОАК, СОЭ</);
    assert.match(html, /class="date">02\.11\.2026, 19:06</);
    assert.match(html, /Тестов &lt;Пациент&gt;/);
    assert.match(html, /<rect x="14\.00"/, 'штрих-код с тихой зоной');
});

test('одна этикетка — прежний вызов, то же окно; без tests и mrn этих строк нет; пустой список — окна нет', () => {
    printed.length = 0; opened = 0;
    printBarcodeLabel({ code: '00000031', patientName: 'Тестов', mrn: '', dateStr: '02.11.2026, 19:06' });
    assert.equal(opened, 1);
    assert.equal((printed[0].match(/<div class="lbl">/g) || []).length, 1);
    assert.ok(!printed[0].includes('class="tests"'));
    assert.ok(!printed[0].includes('class="mrn"'));
    assert.equal(printBarcodeLabels([]), false);
    assert.equal(opened, 1);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-barcode.test.mjs`
Expected: `ℹ pass 5`, `ℹ fail 2` — `TypeError: printBarcodeLabels is not a function`.

- [ ] **Step 3: Implement** — in `public/js/admin/views/lab-barcode.js` replace everything from `const _esc = …` to the end of the file (`:42-81`).

old_string:

```js
const _esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Printer-agnostic sample label: opens a label-sized print window and calls window.print()
// so the user picks any installed printer (Xprinter XP-365B or other). One label per call.
export function printBarcodeLabel(o) {
    const { code = "", patientName = "", mrn = "", dateStr = "", widthMm = 58, heightMm = 40, copies = 1 } = o || {};
    const svg = barcodeSVG(code, { height: Math.max(28, Math.round(heightMm * 1.2)), moduleW: 1.4 });
    const one = `
      <div class="lbl">
        <div class="top"><span class="acc">№ ${_esc(code)}</span><span class="date">${_esc(dateStr)}</span></div>
        <div class="name" title="${_esc(patientName)}">${_esc(patientName)}</div>
        ${mrn ? `<div class="mrn">ID: ${_esc(mrn)}</div>` : ""}
        <div class="bc">${svg}</div>
        <div class="bcnum">${_esc(code)}</div>
      </div>`;
    const pages = Array.from({ length: Math.max(1, copies) }, () => one).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${_esc(code)}</title><style>
${PRINT_FONT_FACE_CSS}
      @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
      * { box-sizing: border-box; }
      html,body { margin:0; padding:0; background:#fff; }
      .lbl { width:${widthMm}mm; height:${heightMm}mm; padding:1.5mm 2.5mm; overflow:hidden;
             display:flex; flex-direction:column; justify-content:space-between;
             page-break-after:always; font-family:'Onest',Arial,Helvetica,sans-serif; color:#000; }
      .top { display:flex; justify-content:space-between; align-items:baseline; gap:4px; }
      .acc { font-size:12pt; font-weight:700; }
      .date { font-size:8pt; color:#000; }
      .name { font-size:10.5pt; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .mrn { font-size:8pt; margin-top:-1mm; }
      .bc { text-align:center; line-height:0; }
      .bc svg { width:100%; height:auto; max-height:${Math.round(heightMm * 0.42)}mm; }
      .bcnum { text-align:center; font-size:8pt; letter-spacing:2px; margin-top:0.3mm; }
    </style></head><body>${pages}
    <script>window.onload=function(){(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){try{window.focus();window.print();}catch(e){}setTimeout(function(){window.close();},400);});};<\/script>
    </body></html>`;
    const win = window.open("", "_blank", "width=460,height=380");
    if (!win) { alert("Разрешите всплывающие окна, чтобы печатать этикетки."); return; }
    win.document.write(html);
    win.document.close();
}
```

new_string:

```js
const _esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// One label's markup. LAB_TUBE_LABEL_V1 — строка «tests»: что в пробирке (короткие названия).
function labelHtml(o, heightMm) {
    const { code = "", patientName = "", mrn = "", dateStr = "", tests = "" } = o || {};
    const svg = barcodeSVG(code, { height: Math.max(28, Math.round(heightMm * 1.2)), moduleW: 1.4 });
    return `
      <div class="lbl">
        <div class="top"><span class="acc">№ ${_esc(code)}</span><span class="date">${_esc(dateStr)}</span></div>
        <div class="name" title="${_esc(patientName)}">${_esc(patientName)}</div>
        ${mrn ? `<div class="mrn">ID: ${_esc(mrn)}</div>` : ""}
        ${tests ? `<div class="tests">${_esc(tests)}</div>` : ""}
        <div class="bc">${svg}</div>
        <div class="bcnum">${_esc(code)}</div>
      </div>`;
}

// Printer-agnostic sample labels: opens ONE label-sized print window and calls window.print()
// so the user picks any installed printer (Xprinter XP-365B or other).
// LAB_TUBE_LABEL_V1 — этикетки всех пробирок визита — одним окном и одной печатью:
// второе window.open подряд браузер блокирует как всплывающее окно.
export function printBarcodeLabels(list, opts) {
    const labels = (Array.isArray(list) ? list : []).filter(Boolean);
    if (!labels.length) return false;
    const { widthMm = 58, heightMm = 40 } = opts || {};
    const pages = labels.map((o) => Array.from({ length: Math.max(1, Number(o.copies) || 1) }, () => labelHtml(o, heightMm)).join("")).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${_esc(labels.map((o) => o.code).join(" "))}</title><style>
${PRINT_FONT_FACE_CSS}
      @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
      * { box-sizing: border-box; }
      html,body { margin:0; padding:0; background:#fff; }
      .lbl { width:${widthMm}mm; height:${heightMm}mm; padding:1.5mm 2.5mm; overflow:hidden;
             display:flex; flex-direction:column; justify-content:space-between;
             page-break-after:always; font-family:'Onest',Arial,Helvetica,sans-serif; color:#000; }
      .top { display:flex; justify-content:space-between; align-items:baseline; gap:4px; }
      .acc { font-size:12pt; font-weight:700; }
      .date { font-size:8pt; color:#000; }
      .name { font-size:10.5pt; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .mrn { font-size:8pt; margin-top:-1mm; }
      .tests { font-size:7.5pt; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .bc { text-align:center; line-height:0; }
      .bc svg { width:100%; height:auto; max-height:${Math.round(heightMm * 0.42)}mm; }
      .bcnum { text-align:center; font-size:8pt; letter-spacing:2px; margin-top:0.3mm; }
    </style></head><body>${pages}
    <script>window.onload=function(){(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){try{window.focus();window.print();}catch(e){}setTimeout(function(){window.close();},400);});};<\/script>
    </body></html>`;
    const win = window.open("", "_blank", "width=460,height=380");
    if (!win) { alert("Разрешите всплывающие окна, чтобы печатать этикетки."); return false; }
    win.document.write(html);
    win.document.close();
    return true;
}

// One label (строка очереди: «Печать этикетки», «Забор пробы») — то же окно, что раньше.
export function printBarcodeLabel(o) {
    const { widthMm = 58, heightMm = 40 } = o || {};
    return printBarcodeLabels([o || {}], { widthMm, heightMm });
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-barcode.test.mjs`
Expected: `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 5: Commit** — write `.git/U11-3.msg`:

```
Этикетка на пробирку (LAB_TUBE_LABEL_V1), шаг 3: несколько этикеток — одним окном

printBarcodeLabels печатает этикетки всех пробирок визита одним окном и одной
печатью (второе окно подряд браузер блокирует). На этикетке — строка «что в
пробирке» (короткие названия анализов). printBarcodeLabel — прежний вызов
одной этикетки, то же окно.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git diff --cached --name-only
git add public/js/admin/views/lab-barcode.js public/js/admin/__tests__/lab-barcode.test.mjs
git commit -F .git/U11-3.msg
```

---

### Task U11.4: `lab-tube.js` — which lines share a tube, its number, its text

**Files:**
- Create: `public/js/admin/views/lab-tube.js`
- Test: `public/js/admin/__tests__/lab-tube.test.mjs` (new)

- [ ] **Step 1: Write the failing test** — create `public/js/admin/__tests__/lab-tube.test.mjs`:

```js
// LAB_TUBE_LABEL_V1 (решение владельца 2026-11-02) — этикетка на пробирку.
//
// Чистые правила views/lab-tube.js: какие строки визита идут в одну пробирку,
// какой у пробирки номер, что на этикетке написано и в каком поясе время.
//
// Часовой пояс — до первого обращения к Date. На Windows Node понимает только
// имя IANA: POSIX-строку «UZT-5» он молча читает как UTC.
process.env.TZ = 'Asia/Tashkent';

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { tubeGroups, tubeDeviceMap, tubeDay, localDay, shortTestName, tubeLabelStamp, TUBE_STATUSES } = await import('../views/lab-tube.js');

const BLOOD = { name: 'Анализ крови', is_lab: 1, specimen: null };
const URINE = { name: 'Анализ мочи', is_lab: 1, specimen: null };
const TODAY = '2026-11-02';
const line = (id, serviceId, services, status = 'queued', extra = {}) => ({
    id, visit_id: 20, service_id: serviceId, status,
    created_at: '2026-11-02T13:50:00Z', scheduled_at: null, sample_collected_at: null,
    services, ...extra,
});
const BC780 = { 40: 3 };   // «Анализ крови» (услуга 40) кормит BC-780 (lab_devices.id = 3); у мочи прибора нет
// Снимок владельца, в порядке очереди (новые первыми): счёт А — № 28 кровь, № 29 моча; счёт Б — № 31, № 32.
const PHOTO = () => [line(32, 41, URINE), line(31, 40, BLOOD), line(29, 41, URINE), line(28, 40, BLOOD)];
const summary = (tubes) => tubes.map((t) => [t.labelId, t.rowIds, t.tests]);

test('снимок владельца: кровь двух счетов — одна пробирка с номером самой старой строки (28); моча без прибора и материала — этикетка на строку', () => {
    const tubes = tubeGroups(PHOTO(), { deviceByService: BC780, today: TODAY });
    assert.deepEqual(summary(tubes), [
        [28, [28, 31], ['Анализ крови']],
        [29, [29], ['Анализ мочи']],
        [32, [32], ['Анализ мочи']],
    ]);
    assert.equal(tubes[0].code, '00000028');
    assert.equal(tubes[0].deviceId, 3);
    assert.ok(!tubes.some((t) => t.rowIds.includes(28) && t.code === '00000032'), 'кровь с номером мочи — ровно ошибка со снимка');
});

test('номер не зависит от порядка выборки', () => {
    const want = summary(tubeGroups(PHOTO(), { deviceByService: BC780, today: TODAY }));
    const rows = PHOTO();
    for (const order of [rows.slice().reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
        assert.deepEqual(summary(tubeGroups(order, { deviceByService: BC780, today: TODAY })), want);
    }
});

test('строки, добавленные позже, номер этикетки не меняют', () => {
    const later = PHOTO().concat([line(35, 40, BLOOD), line(36, 41, URINE)]);
    const tubes = tubeGroups(later, { deviceByService: BC780, today: TODAY });
    assert.equal(tubes[0].labelId, 28);
    assert.deepEqual(tubes[0].rowIds, [28, 31, 35]);
    assert.deepEqual(tubes.map((t) => t.labelId), [28, 29, 32, 36]);
});

test('без прибора — по материалу (ключ приёма specimenKey); без материала — этикетка на строку', () => {
    const rows = [
        line(10, 1, { name: 'Общий анализ мочи', is_lab: 1, specimen: 'Моча' }),
        line(11, 2, { name: 'Нечипоренко', is_lab: 1, specimen: 'моча (утренняя)' }),
        line(12, 3, { name: 'Глюкоза', is_lab: 1, specimen: 'Сыворотка крови' }),
        line(13, 4, { name: 'Коагулограмма', is_lab: 1, specimen: '' }),
        line(14, 5, { name: 'СОЭ', is_lab: 1, specimen: null }),
    ];
    assert.deepEqual(tubeGroups(rows, { today: TODAY }).map((t) => [t.labelId, t.rowIds, t.material]), [
        [10, [10, 11], 'urine'], [12, [12], 'serum'], [13, [13], ''], [14, [14], ''],
    ]);
});

test('прибор — первый ключ, материал внутри прибора — второй: BS-200 гонит сыворотку и мочу — две пробирки', () => {
    const rows = [
        line(20, 9, { name: 'Биохимия', is_lab: 1, specimen: 'Сыворотка' }),
        line(21, 13, { name: 'Общий анализ мочи', is_lab: 1, specimen: 'Моча' }),
        line(22, 14, { name: 'Креатинин', is_lab: 1, specimen: 'Сыворотка' }),
        line(23, 15, { name: 'Мочевина', is_lab: 1, specimen: 'Сыворотка' }),   // сыворотка, но прибора у услуги нет
    ];
    const tubes = tubeGroups(rows, { deviceByService: { 9: 1, 13: 1, 14: 1 }, today: TODAY });
    assert.deepEqual(tubes.map((t) => [t.labelId, t.rowIds, t.deviceId]), [[20, [20, 22], 1], [21, [21], 1], [23, [23], null]]);
});

test('два прибора — две пробирки, даже при одном материале', () => {
    const rows = [line(30, 40, BLOOD), line(31, 50, { name: 'HbA1c', is_lab: 1, specimen: null })];
    assert.deepEqual(tubeGroups(rows, { deviceByService: { 40: 3, 50: 4 }, today: TODAY }).map((t) => t.labelId), [30, 31]);
});

test('услуга без флага «лабораторная» прибором не группируется: такой заказ приём не заполняет', () => {
    const rows = [line(40, 40, BLOOD), line(41, 60, { name: 'Кровь (отдел)', is_lab: 0, specimen: null })];
    const tubes = tubeGroups(rows, { deviceByService: { 40: 3, 60: 3 }, today: TODAY });
    assert.deepEqual(tubes.map((t) => [t.labelId, t.rowIds, t.deviceId]), [[40, [40], 3], [41, [41], null]]);
});

test('в пробирку — только открытые оплаченные строки; номер — самая старая ОТКРЫТАЯ', () => {
    assert.deepEqual([...TUBE_STATUSES], ['queued', 'collected', 'in_progress', 'resulted']);
    const rows = [
        line(50, 40, BLOOD, 'completed'), line(51, 40, BLOOD, 'added'), line(52, 40, BLOOD, 'cancelled'),
        line(53, 40, BLOOD, 'resulted'), line(54, 40, BLOOD, 'in_progress'), line(55, 40, BLOOD, 'queued'),
    ];
    assert.deepEqual(summary(tubeGroups(rows, { deviceByService: BC780, today: TODAY })), [[53, [53, 54, 55], ['Анализ крови']]]);
    assert.deepEqual(tubeGroups([line(60, 40, BLOOD, 'added'), line(61, 40, BLOOD, 'completed')], { deviceByService: BC780, today: TODAY }), [],
        'клеить нечего — этикеток нет');
});

test('строка «услуга возвращена» (без результата) — не пробирка', () => {
    const tubes = tubeGroups(PHOTO(), { deviceByService: BC780, skipIds: new Set([28]), today: TODAY });
    const blood = tubes.find((t) => t.deviceId === 3);
    assert.deepEqual([blood.labelId, blood.rowIds], [31, [31]]);
});

test('местный день: 00:30 по Ташкенту (19:30 UTC прошлых суток) — уже другой день и другая пробирка', () => {
    assert.equal(localDay('2026-11-01T19:30:00Z'), '2026-11-02');
    assert.equal(localDay('2026-11-01T18:30:00Z'), '2026-11-01');
    assert.equal(localDay('2026-11-02'), '2026-11-02', 'дата без времени — сама собой');
    assert.equal(localDay(''), '');
    assert.equal(localDay('вчера'), '');
    const rows = [
        line(70, 40, BLOOD, 'queued', { created_at: '2026-11-01T18:30:00Z' }),   // 1 ноября, 23:30
        line(71, 40, BLOOD, 'queued', { created_at: '2026-11-01T19:30:00Z' }),   // 2 ноября, 00:30
        line(72, 40, BLOOD, 'queued', { created_at: '2026-11-02T06:00:00Z' }),   // 2 ноября, 11:00
    ];
    assert.deepEqual(tubeGroups(rows, { deviceByService: BC780, today: TODAY }).map((t) => t.rowIds), [[70], [71, 72]]);
});

test('день строки — как у приёма (orderAge): позднейшее из «создана», «записана», «день визита», не позже сегодня', () => {
    const visitDate = '2026-11-02T04:00:00Z';
    const ahead = line(80, 40, BLOOD, 'queued', { created_at: '2026-10-30T10:00:00Z' });   // запись колл-центра: строка заведена заранее
    const desk = line(81, 40, BLOOD, 'queued', { created_at: '2026-11-02T06:00:00Z' });    // добавлена в день визита
    assert.equal(tubeDay(ahead, { visitDate, today: TODAY }), TODAY);
    assert.deepEqual(tubeGroups([ahead, desk], { deviceByService: BC780, visitDate, today: TODAY }).map((t) => t.rowIds), [[80, 81]]);
    // Запись на завтра день строки вперёд не двигает.
    assert.equal(tubeDay(line(82, 40, BLOOD, 'queued', { scheduled_at: '2026-11-03T05:00:00Z' }), { visitDate, today: TODAY }), TODAY);
    // Долгий (стационарный) визит: забытый открытый ОАК трёхдневной давности — своя пробирка;
    // номер сегодняшней пробирки — сегодняшняя строка, а не он.
    const old = line(78, 40, BLOOD, 'queued', { created_at: '2026-10-30T06:00:00Z' });
    assert.deepEqual(tubeGroups([old, desk], { deviceByService: BC780, visitDate: '2026-10-28T06:00:00Z', today: TODAY }).map((t) => t.labelId), [78, 81]);
});

test('прибор услуги — панель услуги, как у приёма (активная, первая по номеру); панель без прибора — null', () => {
    const map = tubeDeviceMap([
        { id: 9, service_id: 40, device_id: 3 },
        { id: 5, service_id: 41, device_id: null },
        { id: 12, service_id: 40, device_id: 4 },
        { id: 2, service_id: 42, device_id: 5, active: 0 },
    ]);
    assert.deepEqual(map, { 40: 3, 41: null });
});

test('короткое название: сокращение из имени, иначе из скобок, иначе имя до 18 знаков', () => {
    const cases = [
        ['Анализ крови', 'Анализ крови'],
        ['Общий анализ крови (ОАК, клинический анализ крови без лейкоцитарной формулы)', 'ОАК'],
        ['Скорость оседания эритроцитов (СОЭ, РОЭ, ESR)', 'СОЭ'],
        ['Антимюллеров гормон АМГ (ИФА)', 'АМГ'],
        ['Гемоглобин (Hb, гемоглобин крови)', 'Hb'],
        ['Тиреотропный гормон  ТТГ  (TSH)', 'ТТГ'],
        ['Витамин D (25-OH витамин D, кальциферол)', 'Витамин D (25-OH…'],
        ['Время свертываемости крови (Корел)', 'Время свертываемо…'],
        ['', ''], [null, ''],
    ];
    for (const [name, want] of cases) assert.equal(shortTestName(name), want, String(name));
});

test('время на этикетке — местное, числом: 14:06 UTC — «02.11.2026, 19:06»', () => {
    assert.equal(tubeLabelStamp('2026-11-02T14:06:00Z'), '02.11.2026, 19:06');
    assert.equal(tubeLabelStamp(null, new Date('2026-11-02T14:06:00Z')), '02.11.2026, 19:06', 'забора нет — время печати, тоже местное');
    const tubes = tubeGroups([
        line(90, 40, BLOOD, 'collected', { sample_collected_at: '2026-11-02T14:20:00Z' }),
        line(91, 40, BLOOD, 'collected', { sample_collected_at: '2026-11-02T14:06:00Z' }),
    ], { deviceByService: BC780, today: TODAY });
    assert.equal(tubes[0].collectedAt, '2026-11-02T14:06:00Z', 'время пробирки — первый забор');
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-tube.test.mjs`
Expected: the file fails to load — `ERR_MODULE_NOT_FOUND` … `views/lab-tube.js`.

- [ ] **Step 3: Create `public/js/admin/views/lab-tube.js`**

```js
// LAB_TUBE_LABEL_V1 (решение владельца 2026-11-02) — ЭТИКЕТКА НА ПРОБИРКУ.
//
// Было: «Штрих-код» карточки очереди печатал ОДНУ этикетку на визит — с номером
// rows[0], а строки очереди идут по id desc, то есть с номером САМОЙ НОВОЙ
// строки, и номер менялся, как только выставляли ещё один анализ. На снимке
// владельца № 00000032 — «Анализ мочи» второго счёта; кровь с этим номером BC-780
// не разложил («неоднозначно»: две открытые «Анализ крови»).
//
// Стало: строки визита делятся на пробирки, этикетка — на каждую.
//   • Ключ пробирки — день строки, прибор и материал:
//       день     — как у приёма (ingest.js orderAge): позднейшее из «создана»,
//                  «записана», «день визита», не позже сегодня, местный;
//       прибор   — тот, что кормит услугу: панель услуги (lab_panels.device_id),
//                  как у приёма (ingest.js orderSide); только у услуги с флагом
//                  «лабораторная» — заказ без него приём не заполняет;
//       материал — specimenKey (shared/specimen-key.js) — тот же ключ, которым
//                  приём делит пробирку между заказами визита (D3).
//     Без прибора — по материалу; без материала — своя этикетка у строки.
//   • Номер этикетки — САМАЯ СТАРАЯ строка пробирки: строки, добавленные позже,
//     номер не меняют. Прибор этот заказ кормит сам, поэтому приём кладёт пробу
//     в него, а остальные строки пробирки заполняет D3 — та же группа.
//   • В пробирку идут только открытые оплаченные строки (queued … resulted):
//     голый номер выданного заказа приём отказывает (bareIdRefusal), неоплаченного —
//     ворота (gateRefusal). Возвращённые без результата (skipIds) — тоже нет.
// Модуль чистый: без DOM и сети — его тестирует node --test, его же берёт тест
// приёма (server/lis/tube-label.test.js).
import { specimenKey } from '../../shared/specimen-key.js';
import { labBarcodeValue } from './lab-doc.js?v=labshared1';   // тот же адрес, что у laboratory.js — один экземпляр модуля
import { dateNumeric } from '../../shared/date-words.js';

export const TUBE_STATUSES = Object.freeze(['queued', 'collected', 'in_progress', 'resulted']);

const isOn = (v) => v === true || Number(v) === 1;
const pad2 = (n) => String(n).padStart(2, '0');

/** Местный календарный день 'YYYY-MM-DD' (Date | ISO | 'YYYY-MM-DD'); '' — не разобрать. */
export function localDay(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * День строки для пробирки — как у приёма (ingest.js orderAge): позднейшее из
 * «создана», «записана», «день визита», не позже сегодня. '' — не известен.
 */
export function tubeDay(r, { visitDate = null, today = localDay(new Date()) } = {}) {
    const days = [r && r.created_at, r && r.scheduled_at, visitDate].map(localDay).filter((d) => d && d <= today);
    return days.length ? days.sort().pop() : '';
}

// Короткое название анализа для этикетки (в справочнике короткого имени нет):
// сокращение в самом имени («Антимюллеров гормон АМГ (ИФА)» → «АМГ»), иначе
// первое в скобках («Общий анализ крови (ОАК, …)» → «ОАК»), иначе имя,
// обрезанное до 18 знаков. Сокращение — до 10 знаков, не меньше двух заглавных
// (или из 2–3 знаков с заглавной: «Hb»; одна буква — «Витамин D» — не сокращение).
const SHORT_MAX = 18;
const ABBR = /^[\p{Lu}\d][\p{L}\d%#.+\-]{0,9}$/u;
const capsOf = (w) => (w.match(/\p{Lu}/gu) || []).length;
const isAbbr = (w) => ABBR.test(w) && (capsOf(w) >= 2 || (w.length >= 2 && w.length <= 3 && capsOf(w) >= 1));
export function shortTestName(name) {
    const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    if (s.length <= SHORT_MAX) return s;
    const outside = s.replace(/\([^()]*\)/g, ' ').split(' ').find(isAbbr);
    if (outside) return outside;
    for (const m of s.matchAll(/\(([^()]*)\)/g)) {
        const head = m[1].split(/[,;]/)[0].trim();
        if (isAbbr(head)) return head;
    }
    return s.slice(0, SHORT_MAX - 1).trimEnd() + '…';
}

/**
 * service_id → прибор панели услуги (lab_panels.device_id; null — панель без
 * прибора). Как у приёма (orderSide): активная панель, первая по номеру.
 */
export function tubeDeviceMap(panels) {
    const out = {};
    const list = (panels || []).filter((p) => p && p.service_id != null && (p.active === undefined || isOn(p.active)))
        .slice().sort((a, b) => Number(a.id) - Number(b.id));
    for (const p of list) {
        if (Object.prototype.hasOwnProperty.call(out, p.service_id)) continue;
        out[p.service_id] = p.device_id == null || p.device_id === '' ? null : p.device_id;
    }
    return out;
}

/**
 * Пробирки визита.
 * @param {object[]} rows  лабораторные строки ОДНОГО визита (visit_services + services{name, specimen, is_lab})
 * @param {{deviceByService?: object|Map, skipIds?: Set<number>, visitDate?: string|null, today?: string}} [opts]
 * @returns {Array<{key:string, labelId:number, code:string, rowIds:number[], tests:string[],
 *                  collectedAt:string|null, deviceId:any, material:string, day:string}>}
 *          по возрастанию номера этикетки
 */
export function tubeGroups(rows, opts = {}) {
    const devices = opts.deviceByService || {};
    const skip = opts.skipIds instanceof Set ? opts.skipIds : new Set();
    const visitDate = opts.visitDate || null;
    const today = opts.today || localDay(new Date());
    const deviceOf = (sid) => {
        const v = devices instanceof Map ? devices.get(sid) : devices[sid];
        return v == null || v === '' ? null : v;
    };
    const open = (rows || [])
        .filter((r) => r && r.id != null && TUBE_STATUSES.includes(r.status) && !skip.has(Number(r.id)))
        .slice().sort((a, b) => Number(a.id) - Number(b.id));
    const byKey = new Map();
    for (const r of open) {
        const svc = r.services || {};
        const material = specimenKey(svc.specimen);
        const deviceId = isOn(svc.is_lab) ? deviceOf(r.service_id) : null;
        const day = tubeDay(r, { visitDate, today });
        const key = deviceId != null ? day + '|d' + deviceId + '|m' + material
            : material ? day + '|m' + material
            : day + '|r' + r.id;
        let g = byKey.get(key);
        if (!g) {
            // Строки идут по возрастанию номера: группу заводит её САМАЯ СТАРАЯ строка.
            g = { key, labelId: Number(r.id), code: labBarcodeValue(r.id), rowIds: [], tests: [], collectedAt: null, deviceId, material, day };
            byKey.set(key, g);
        }
        g.rowIds.push(Number(r.id));
        const t = shortTestName(svc.name);
        if (t && !g.tests.includes(t)) g.tests.push(t);
        const c = r.sample_collected_at ? String(r.sample_collected_at) : '';
        if (c && (!g.collectedAt || c < g.collectedAt)) g.collectedAt = c;
    }
    return [...byKey.values()];
}

/**
 * Время на этикетке — местное (часы компьютера клиники), числом, как в печатных
 * бланках: «02.11.2026, 19:06». Нет отметки забора — сейчас.
 */
export function tubeLabelStamp(value, now = new Date()) {
    return dateNumeric(value || now, { withTime: true });
}
```

Notes: `./lab-doc.js?v=labshared1` is the exact URL `laboratory.js:72` uses (one module instance in the browser). `../../shared/date-words.js` is the URL every view uses for `dateNumeric` (`admissions.js:52`, `patient-card.js:34`). No Cyrillic string literals in this file (the i18n guard scans `views/`; regex bodies and comments are ignored).

- [ ] **Step 4: Run — expect PASS**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-tube.test.mjs`
Expected: `ℹ pass 14`, `ℹ fail 0`.

- [ ] **Step 5: Commit** — write `.git/U11-4.msg`:

```
Этикетка на пробирку (LAB_TUBE_LABEL_V1), шаг 4: какие строки визита — одна пробирка

views/lab-tube.js (чистый модуль): ключ пробирки — местный день строки (как у
приёма, orderAge), прибор панели услуги (как orderSide) и материал (как D3);
без прибора — материал, без материала — этикетка на строку. Номер — самая
старая открытая оплаченная строка пробирки: строки, добавленные позже, его не
меняют. Короткие названия анализов, время этикетки — местное.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git diff --cached --name-only
git add public/js/admin/views/lab-tube.js public/js/admin/__tests__/lab-tube.test.mjs
git commit -F .git/U11-4.msg
```

---

### Task U11.5: the owner's photo case through the real ingest (pin, no ingest change)

**Files:**
- Test: `server/lis/tube-label.test.js` (new)

This task is a proof, not a feature: it computes the label with the screen's own module and sends a BC-780 message with that number through the unchanged `ingestMessage`. **Expected to pass on the first run.** If it fails, stop and report — design correction 5 would be wrong and ingest would need «prefer the label line's group».

- [ ] **Step 1: Write the test** — create `server/lis/tube-label.test.js`:

```js
// LAB_TUBE_LABEL_V1 (решение владельца 2026-11-02) — этикетка, которую печатает
// карточка очереди, ведёт пробу в нужный заказ.
//
// Снимок владельца (тестовая клиника, визит 20): четыре лабораторные строки —
// № 28 «Анализ крови» и № 29 «Анализ мочи» (счёт А), № 31 «Анализ крови» и
// № 32 «Анализ мочи» (счёт Б). «Штрих-код» печатал ОДНУ этикетку с номером самой
// новой строки — 00000032, мочи счёта Б. BC-780 прислал кровь с этим номером:
// заказ № 32 он не кормит, а заказов крови, которые кормит, два открытых (№ 28 и
// № 31) — «неоднозначно» (LAB_TUBE_ANCHOR_V1, ревью 3.17.1 M1), не записано ничего.
//
// Теперь номер считает views/lab-tube.js — тот же модуль, что у экрана: пробирка
// крови — № 28, самая старая её строка, и прибор этот заказ кормит сам. Приём НЕ
// меняется: заказ номера кормит прибор — проба в нём, остальное делит D3; старые
// этикетки читаются, как прежде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMessage, worklistLines } from './ingest.js';
import { freshDb, bindPanel, lastRow, blank } from '../test-helpers/lisproxy-clinic.js';
import { tubeGroups, tubeDeviceMap } from '../../public/js/admin/views/lab-tube.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const seg = (...s) => s.join('\r');
const statusOf = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;

// BC-780 — провод гематологии Mindray (как dial.test.js): номер пробы — OBR-3.
const BC780 = (sample, wbc = '7.25') => seg(
  'MSH|^~\\&|BC-780|Mindray|||20261102140600||ORU^R01|1|P|2.3.1||||||UNICODE',
  'PID|1||^^^^MR',
  'PV1|1',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261102140600`,
  `OBX|1|NM|6690-2^WBC^LN||${wbc}|10*9/L|4.0-10.0|N|||F`,
);

/** Визит 20 со снимка: кровь (услуга 40, панель на BC-780 № 3, WBC подтверждён) и моча (41, панели нет); материал не указан. */
function photoClinic() {
  const db = freshDb();
  db.exec(`
    INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed)
      VALUES (3, 'BC-780', 'mindray-bc-780', 'mllp', '10.0.0.50', NULL, 1, 0, 1, 1);
    INSERT INTO patients (id, full_name) VALUES (7, 'Тестов');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, ${NOW}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES (40, 'Анализ крови', 1, NULL), (41, 'Анализ мочи', 1, NULL);
    INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES
      (28, 20, 40, 'queued', ${NOW}), (29, 20, 41, 'queued', ${NOW}),
      (31, 20, 40, 'queued', ${NOW}), (32, 20, 41, 'queued', ${NOW});
  `);
  bindPanel(db, { id: 40, serviceId: 40, deviceId: 3, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC']] });
  return db;
}

/** Пробирки визита — модулем экрана, из строк в порядке очереди (новые первыми). */
function tubesOf(db, visitId) {
  const rows = db.prepare(`SELECT vs.*, s.name AS s_name, s.specimen AS s_specimen, s.is_lab AS s_is_lab
                             FROM visit_services vs JOIN services s ON s.id = vs.service_id
                            WHERE vs.visit_id = ? ORDER BY vs.id DESC`).all(visitId)
    .map(({ s_name, s_specimen, s_is_lab, ...vs }) => ({ ...vs, services: { name: s_name, specimen: s_specimen, is_lab: s_is_lab } }));
  const visit = db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(visitId);
  const deviceByService = tubeDeviceMap(db.prepare('SELECT id, service_id, device_id, active FROM lab_panels').all());
  return tubeGroups(rows, { deviceByService, visitDate: visit.visit_date });
}

test('снимок владельца: этикетка пробирки крови — № 28, и BC-780 кладёт кровь в № 28', () => {
  const db = photoClinic();
  const tubes = tubesOf(db, 20);
  assert.deepEqual(tubes.map((t) => [t.code, t.rowIds]), [['00000028', [28, 31]], ['00000029', [29]], ['00000032', [32]]]);
  const blood = tubes.find((t) => t.rowIds.includes(31));
  assert.equal(ingestMessage(db, BC780(blood.code), '10.0.0.50', 3), 'AA');
  const m = lastRow(db);
  assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 28, '00000028'], m.detail);
  assert.deepEqual(blank(db, 28), { 'Лейкоциты': '7.25' });
  assert.deepEqual(blank(db, 31), {}, 'вторая строка крови той же пробирки значений не получает: заказ пробирки берёт свои коды первым (planTube)');
  assert.equal(statusOf(db, 28), 'resulted');
  for (const id of [29, 31, 32]) assert.equal(statusOf(db, id), 'queued', 'заказ № ' + id);
  // Рабочий список по той же этикетке (LIS Proxy, запрос прибора) — тесты пробирки крови.
  assert.deepEqual(worklistLines(db, { deviceId: 3, orderId: blood.labelId, bare: true, shown: blood.code }).codes, ['WBC']);
  db.close();
});

test('строка крови, добавленная позже, номер пробирки не меняет — проба по-прежнему в № 28', () => {
  const db = photoClinic();
  db.exec(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (35, 20, 40, 'queued', ${NOW})`);
  const blood = tubesOf(db, 20)[0];
  assert.deepEqual([blood.code, blood.rowIds], ['00000028', [28, 31, 35]]);
  ingestMessage(db, BC780(blood.code), '10.0.0.50', 3);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 28], lastRow(db).detail);
  db.close();
});

test('старые этикетки — как прежде: 00000032 (моча) — «неоднозначно», ничего не записано; LAB-000028 — в № 28', () => {
  const db = photoClinic();
  ingestMessage(db, BC780('00000032'), '10.0.0.50', 3);
  const m = lastRow(db);
  assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null], m.detail);
  assert.match(m.detail, /^неоднозначно: номер пробы — заказ № 32 «Анализ мочи»/);
  assert.match(m.detail, /одни и те же анализы/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results').get().c, 0);
  ingestMessage(db, BC780('LAB-000028'), '10.0.0.50', 3);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 28], lastRow(db).detail);
  db.close();
});
```

- [ ] **Step 2: Run — expect PASS**

Run: `node --experimental-vm-modules --test server/lis/tube-label.test.js`
Expected: `ℹ pass 3`, `ℹ fail 0` (about 6 s).

- [ ] **Step 3: Commit** — write `.git/U11-5.msg`:

```
Этикетка на пробирку (LAB_TUBE_LABEL_V1), шаг 5: случай со снимка владельца — тест приёма

Визит 20: кровь и моча в двух счетах. Номер этикетки считает модуль экрана
(lab-tube.js): пробирка крови — № 28, самая старая её строка; BC-780 с этим
номером кладёт кровь в № 28 (приём не менялся). Строка крови, добавленная
позже, номер не меняет. Старые этикетки — как прежде: 00000032 —
«неоднозначно», LAB-000028 — в № 28.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git diff --cached --name-only
git add server/lis/tube-label.test.js
git commit -F .git/U11-5.msg
```

---

### Task U11.6: card «Штрих-код» — a label per tube; card «Проба» — the first tube

**Files:**
- Modify: `public/js/admin/views/laboratory.js` (`:37`, `:147`, `:711`, `:721-724`, `:875-876`, `:1029`, `:1045-1047`, `:1065-1066`, `:1124`, before `:1194`)
- Modify: `public/js/admin/i18n-strings.js` (after `:5918`)
- Modify: `public/js/admin/__tests__/lab-card.test.mjs` (`:537`)
- Test: `public/js/admin/__tests__/lab-tube-label.test.mjs` (new)

- [ ] **Step 1: Write the failing test** — create `public/js/admin/__tests__/lab-tube-label.test.mjs` (harness copied from `lab-card.test.mjs:34-149`, plus `lab_panels` and `lab_results` fixtures, an `rpc refunded_lines` answer and a print-window stub):

```js
// LAB_TUBE_LABEL_V1 (решение владельца 2026-11-02) — «Штрих-код» карточки очереди
// печатает этикетку на КАЖДУЮ пробирку визита, номер этикетки — самая старая
// строка пробирки, время — местное.
//
// Снимок владельца: тестовая клиника, визит 20, два счёта, в каждом «Анализ
// крови» + «Анализ мочи» (№ 28, 29 и № 31, 32). Кнопка печатала одну этикетку
// № 00000032 (моча второго счёта — самая новая строка) со временем 14:06 (UTC)
// вместо 19:06.
//
// Поддельный DOM и /api/db — те же, что в lab-card.test.mjs; плюс панели
// (lab_panels.device_id — какой прибор кормит услугу) и окно печати, которое
// запоминает написанный в него HTML.
import { test } from 'node:test';
import assert from 'node:assert';

// Время на этикетке — местное. На Windows Node понимает только имя IANA
// («UZT-5» молча читается как UTC) — пояс задаётся до первого Date.
process.env.TZ = 'Asia/Tashkent';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} closest(){return null;}
 querySelector(){return null;} querySelectorAll(){return [];}
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
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
const fakeBody = mk('body');
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:fakeBody,documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта вида

// Окно печати этикеток: сколько открыто и что в него написано.
let printed = [];
let opened = 0;
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener(){}, dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => false,
  open: () => { opened++; return { document: { write(s) { printed.push(String(s)); }, close() {} } }; },
};
globalThis.confirm = () => false;
globalThis.alert = (m) => { throw new Error('alert: ' + m); };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { clipboard: { writeText: async () => {} } },
});

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const clean = (b) => textOf(b).replace(/<[^>]*>/g, '').trim();

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- поддельный /api/db ------------------------------------------------------
const PATIENT = { id: 'p-20', full_name: 'Тестов Пациент Тестович', mrn: 'P-26-00020', gender: 'female', date_of_birth: '1990-02-03' };
const VISITS = [{ id: 20, visit_date: '2026-11-02T13:45:00Z', patients: PATIENT }];
let VISIT_SERVICES = [];
let LAB_PANELS = [];
let LAB_RESULTS = [];   // К4 — результат у возвращённой строки
let REFUNDED = [];      // К4 — номера строк «услуга возвращена» (rpc refunded_lines)
function statusFilter(body) {
  for (const f of (body && body.filters) || []) if (f && f.col === 'status') return f;
  return null;
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    let rows = {
      visit_services: VISIT_SERVICES, visits: VISITS, lab_results: LAB_RESULTS, admissions: [],
      lab_panels: LAB_PANELS, lab_panel_analytes: [], services: [],
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }],
      service_types: [], doc_settings: [],
    }[table] || [];
    if (table === 'visit_services') {
      const f = statusFilter(body);
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (u.startsWith('/api/rpc/refunded_lines')) return { ok: true, json: async () => ({ data: { line_ids: REFUNDED } }) };
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderLaboratory } = await import('../views/laboratory.js');
const { setFullAccess } = await import('../permissions.js');
setFullAccess(true);

// --- фикстуры ---------------------------------------------------------------
const BLOOD = { name: 'Анализ крови', is_lab: 1, type: 'lab', specimen: null, tube_color: null, department_id: 'd-1' };
const URINE = { name: 'Анализ мочи', is_lab: 1, type: 'lab', specimen: null, tube_color: null, department_id: 'd-1' };
const line = (id, svc, status, extra = {}) => ({
  id, visit_id: 20, service_id: svc === BLOOD ? 40 : 41, status, sync_origin: null,
  created_at: '2026-11-02T13:50:00Z', scheduled_at: null, sample_collected_at: null,
  services: svc, ...extra,
});
// В порядке очереди (новые первыми). № 28 уже взят в 14:06 UTC — 19:06 по Ташкенту.
const PHOTO = () => [
  line(32, URINE, 'queued'), line(31, BLOOD, 'queued'), line(29, URINE, 'queued'),
  line(28, BLOOD, 'collected', { sample_collected_at: '2026-11-02T14:06:00Z' }),
];
// Панель «Анализа крови» кормит BC-780 (lab_devices.id = 3); у мочи панели нет.
const PANELS = [{ id: 7, name: 'ОАК', code: '', service_id: 40, has_narrative: 0, device_id: 3 }];

async function mount(rows, { filter = null, panels = PANELS } = {}) {
  VISIT_SERVICES = rows;
  LAB_PANELS = panels;
  printed = []; opened = 0; toastMsg = null;
  fakeBody.children.length = 0;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  if (filter) {
    const chip = buttons(root).find((b) => textOf(b).startsWith(filter));
    assert.ok(chip, 'фильтр «' + filter + '» пропал из шапки очереди');
    chip.click();
    await tick();
  }
  const cards = byClass(root, 'lq-card');
  assert.strictEqual(cards.length, 1, 'ожидалась одна карточка, получено ' + cards.length);
  return cards[0];
}
const barcodeBtn = (c) => buttons(byClass(c, 'lq-do')[0]).find((b) => clean(b) === 'Штрих-код');
const labelsOf = (html) => html.split('<div class="lbl">').slice(1).map((part) => ({
  code: (/class="acc">№ (\d+)</.exec(part) || [])[1],
  date: (/class="date">([^<]*)</.exec(part) || [])[1],
  tests: (/class="tests">([^<]*)</.exec(part) || [])[1] || '',
}));

// ═══ Карточка: этикетка на каждую пробирку ══════════════════════════════════

test('снимок владельца: «Штрих-код» — этикетка на каждую пробирку одним окном; кровь — № 00000028, 19:06', async () => {
  const c = await mount(PHOTO());
  const btn = barcodeBtn(c);
  assert.ok(btn, 'кнопка «Штрих-код» пропала');
  assert.strictEqual(btn.getAttribute('title'), 'Этикетки на пробирки — по одной на пробирку');
  btn.click();
  await tick();
  assert.strictEqual(opened, 1, 'этикетки визита — одним окном печати');
  const labels = labelsOf(printed[0]);
  assert.deepStrictEqual(labels.map((l) => l.code), ['00000028', '00000029', '00000032']);
  assert.deepStrictEqual(labels.map((l) => l.tests), ['Анализ крови', 'Анализ мочи', 'Анализ мочи']);
  assert.strictEqual(labels[0].date, '02.11.2026, 19:06', 'забор в 14:06 UTC — на этикетке 19:06 по Ташкенту');
  for (const l of labels.slice(1)) assert.match(l.date, /^\d\d\.\d\d\.\d{4}, \d\d:\d\d$/, 'проба не взята — время печати, числом');
  assert.ok(printed[0].includes(PATIENT.full_name), 'на этикетке нет пациента');
});

test('номер пробы на карточке — номер первой пробирки (как на её этикетке), а не самой новой строки', async () => {
  const c = await mount(PHOTO());
  const acc = textOf(byClass(c, 'lq-acc')[0]);
  assert.ok(acc.includes('LAB-000028'), acc);
  assert.ok(!acc.includes('LAB-000032'), acc);
});

test('добавили анализ крови позже — номер пробирки крови тот же', async () => {
  const c = await mount([line(35, BLOOD, 'queued'), ...PHOTO()]);
  barcodeBtn(c).click();
  await tick();
  const labels = labelsOf(printed[0]);
  assert.deepStrictEqual(labels.map((l) => l.code), ['00000028', '00000029', '00000032']);
  assert.strictEqual(labels[0].tests, 'Анализ крови');
});

test('номер не зависит от вкладки: под «В работе» видна одна строка, пробирки — те же', async () => {
  const c = await mount(PHOTO(), { filter: 'В работе' });
  assert.strictEqual(byClass(c, 'lq-item').length, 1, 'под «В работе» — только взятая проба № 28');
  barcodeBtn(c).click();
  await tick();
  assert.deepStrictEqual(labelsOf(printed[0]).map((l) => l.code), ['00000028', '00000029', '00000032']);
});

test('панель без прибора — пробирка по материалу (не указан — этикетка на строку); выданный визит — этикеток нет', async () => {
  const c = await mount(PHOTO(), { panels: [] });
  barcodeBtn(c).click();
  await tick();
  assert.deepStrictEqual(labelsOf(printed[0]).map((l) => l.code), ['00000028', '00000029', '00000031', '00000032']);

  const done = await mount([line(28, BLOOD, 'completed', { sample_collected_at: '2026-11-02T14:06:00Z' })], { filter: 'Все' });
  assert.ok(!barcodeBtn(done), 'открытых пробирок нет — клеить нечего (голый номер выданного заказа приём не примет)');
});

test('К4: строка «услуга возвращена» в пробирку не идёт — номер пробирки крови даёт следующая строка', async () => {
  // № 28: результат внесён, потом касса вернула деньги — строка видна с пометкой, но пробирки у неё нет.
  REFUNDED = [28];
  LAB_RESULTS = [{ id: 1, visit_service_id: 28, parameter: 'Лейкоциты', value: '6.2', unit: '', flag: 'normal', notes: null, entered_at: '2026-11-02T14:30:00Z' }];
  try {
    const c = await mount([line(32, URINE, 'queued'), line(31, BLOOD, 'queued'), line(29, URINE, 'queued'),
      line(28, BLOOD, 'resulted', { sample_collected_at: '2026-11-02T14:06:00Z' })]);
    assert.strictEqual(byClass(c, 'lq-refunded').length, 1, 'возвращённая строка с результатом видна с пометкой');
    barcodeBtn(c).click();
    await tick();
    assert.deepStrictEqual(labelsOf(printed[0]).map((l) => l.code), ['00000029', '00000031', '00000032']);
  } finally {
    REFUNDED = [];
    LAB_RESULTS = [];
  }
});
```

- [ ] **Step 2: Update the existing expectation** in `public/js/admin/__tests__/lab-card.test.mjs` (a released visit has no open tube, so no «Штрих-код»):

Edit 1 of 1 in `public/js/admin/__tests__/lab-card.test.mjs` — old_string:

```js
    released: ['Бланк', 'Внести результаты', 'Штрих-код'],
```

new_string:

```js
    // LAB_TUBE_LABEL_V1 — у выданного визита открытых пробирок нет: этикеток не
    // печатают (голый номер выданного заказа приём не примет — bareIdRefusal);
    // перепечатка этикетки строки — на самой строке («Печать этикетки»).
    released: ['Бланк', 'Внести результаты'],
```

- [ ] **Step 3: Run — expect FAIL**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-tube-label.test.mjs public/js/admin/__tests__/lab-card.test.mjs`
Expected: `ℹ fail 7` — in the new file all 6 (first: `actual: 'Печать штрих-кода образца'`; card shows `LAB-000032`; after adding line 35 the only label is `['00000035']` — the bug), in `lab-card.test.mjs` «все действия карточки на месте…» (`released` still has «Штрих-код»).

- [ ] **Step 4: Implement** — edits in `public/js/admin/views/laboratory.js`, in this order:

Edit 1 of 10 in `public/js/admin/views/laboratory.js` — old_string:

```js
import { printBarcodeLabel } from './lab-barcode.js';
```

new_string:

```js
import { printBarcodeLabel, printBarcodeLabels } from './lab-barcode.js';   // LAB_TUBE_LABEL_V1 — этикетки визита одним окном печати
import { tubeGroups, tubeDeviceMap, tubeLabelStamp } from './lab-tube.js';   // LAB_TUBE_LABEL_V1 — этикетка на пробирку (чистые правила)
```

Edit 2 of 10 in `public/js/admin/views/laboratory.js` — old_string:

```js
    panelByService: {},// service_id -> lab_panels row
```

new_string:

```js
    panelByService: {},// service_id -> lab_panels row
    deviceByService: {},   // LAB_TUBE_LABEL_V1 — service_id -> прибор панели услуги (lab_panels.device_id), как у приёма
```

Edit 3 of 10 in `public/js/admin/views/laboratory.js` — old_string:

```js
supabase.from('lab_panels').select('id, name, code, service_id, has_narrative').eq('active', true).limit(500),
```

new_string:

```js
supabase.from('lab_panels').select('id, name, code, service_id, has_narrative, device_id').eq('active', true).limit(500),   // device_id: LAB_TUBE_LABEL_V1 — пробирка по прибору
```

Edit 4 of 10 in `public/js/admin/views/laboratory.js` — old_string:

```js
        state.panelByService = {};
        for (const p of (panels || [])) {
            if (p.service_id != null) state.panelByService[p.service_id] = p;
        }
```

new_string:

```js
        state.panelByService = {};
        for (const p of (panels || [])) {
            if (p.service_id != null) state.panelByService[p.service_id] = p;
        }
        state.deviceByService = tubeDeviceMap(panels);   // LAB_TUBE_LABEL_V1
```

Edit 5 of 10 in `public/js/admin/views/laboratory.js` — old_string:

```js
    const groups = groupLabRows(visible, state.patientMap, accession);
    for (const g of groups) refs.list.appendChild(labGroupCard(g));
```

new_string:

```js
    // LAB_TUBE_LABEL_V1 — пробирки визита считаются по ВСЕМ его строкам в очереди,
    // а не по оставленным фильтром: номер этикетки не зависит от вкладки.
    const byVisit = new Map();
    for (const r of state.rows) {
        if (r.visit_id == null) continue;
        if (!byVisit.has(r.visit_id)) byVisit.set(r.visit_id, []);
        byVisit.get(r.visit_id).push(r);
    }
    const groups = groupLabRows(visible, state.patientMap, accession);
    for (const g of groups) refs.list.appendChild(labGroupCard(g, byVisit));
```

Edit 6 of 10 in `public/js/admin/views/laboratory.js` — old_string:

```js
function labGroupCard(g) {
```

new_string:

```js
function labGroupCard(g, byVisit = new Map()) {
```

Edit 7 of 10 in `public/js/admin/views/laboratory.js` — old_string:

```js
    const patient = info.patient || {};

    const sexTxt
```

new_string:

```js
    const patient = info.patient || {};
    // LAB_TUBE_LABEL_V1 — пробирки визита (lab-tube.js): этикетка на каждую,
    // номер — самая старая открытая строка пробирки.
    const tubes = visitTubes(g, byVisit, info);

    const sexTxt
```

Edit 8 of 10 in `public/js/admin/views/laboratory.js` — old_string:

```js
        anyActive ? ['barcode', 'Штрих-код', 'Scan',
            'Печать штрих-кода образца', () => printLabel(rows[0], patient)] : null,
```

new_string:

```js
        // LAB_TUBE_LABEL_V1 — этикетка на каждую пробирку (было: одна, rows[0] — самая новая строка).
        tubes.length ? ['barcode', 'Штрих-код', 'Scan',
            'Этикетки на пробирки — по одной на пробирку', () => printTubeLabels(tubes, patient)] : null,
```

Edit 9 of 10 in `public/js/admin/views/laboratory.js` — old_string:

```js
            accessionButton(g.accession),
```

new_string:

```js
            accessionButton(tubes.length ? labAccession(tubes[0].labelId) : g.accession),   // LAB_TUBE_LABEL_V1 — номер первой пробирки, тот же, что на её этикетке
```

Edit 10 of 10 in `public/js/admin/views/laboratory.js` — old_string:

```js
function printLabel(r, patient) {
```

new_string:

```js
// LAB_TUBE_LABEL_V1 — пробирки визита карточки: все его лабораторные строки в
// очереди (byVisit); возвращённые без результата — не пробирка (refundedIds).
function visitTubes(g, byVisit, info) {
    const rows = g.visitId != null ? (byVisit.get(g.visitId) || g.rows) : g.rows;
    return tubeGroups(rows, {
        deviceByService: state.deviceByService,
        skipIds: state.refundedIds,
        visitDate: (info && info.visit_date) || null,
    });
}

// LAB_TUBE_LABEL_V1 — этикетки всех пробирок визита ОДНИМ окном: второе окно
// подряд браузер блокирует как всплывающее. Время — местное.
function printTubeLabels(tubes, patient) {
    printBarcodeLabels(tubes.map((t) => ({
        code: t.code,
        patientName: patient.full_name || '',
        mrn: patient.mrn || '',
        dateStr: tubeLabelStamp(t.collectedAt),
        tests: t.tests.join(', '),
    })));
}

function printLabel(r, patient) {
```

- [ ] **Step 5: Dictionary entry** in `public/js/admin/i18n-strings.js`:

Edit 1 of 1 in `public/js/admin/i18n-strings.js` — old_string:

```js
  "Печать этикетки": {"en":"Print the label","ru":"Печать этикетки","uz":"Etiketkani chop etish"},
```

new_string:

```js
  "Печать этикетки": {"en":"Print the label","ru":"Печать этикетки","uz":"Etiketkani chop etish"},
  "Этикетки на пробирки — по одной на пробирку": {"en":"Tube labels — one per tube","ru":"Этикетки на пробирки — по одной на пробирку","uz":"Probirkalar uchun etiketkalar — har bir probirkaga bittadan"},   // LAB_TUBE_LABEL_V1
```

- [ ] **Step 6: Run — expect PASS**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-tube-label.test.mjs public/js/admin/__tests__/lab-card.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs`
Expected: `ℹ fail 0` (`lab-tube-label` 6, `lab-card` 30).

- [ ] **Step 7: Commit** — write `.git/U11-6.msg`:

```
Этикетка на пробирку (LAB_TUBE_LABEL_V1), шаг 6: «Штрих-код» — этикетка на каждую пробирку

Карточка лаборатории печатала одну этикетку на визит с номером самой новой
строки (rows[0]) — номер менялся с каждым новым анализом, а на снимке
владельца кровь ушла с номером мочи. Теперь — этикетка на каждую пробирку
визита (lab-tube.js), все одним окном; пробирки считаются по всем строкам
визита в очереди, не по вкладке. Номер пробы на карточке — номер первой
пробирки. У выданного визита открытых пробирок нет — кнопки нет.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git diff --cached --name-only
git add public/js/admin/views/laboratory.js public/js/admin/i18n-strings.js public/js/admin/__tests__/lab-card.test.mjs public/js/admin/__tests__/lab-tube-label.test.mjs
git commit -F .git/U11-6.msg
```

---

### Task U11.7: row label — local time and the test name; «Забор пробы» prints the same label

**Files:**
- Modify: `public/js/admin/views/laboratory.js` (import line from U11.6; `printLabel` `:1199`; `collectDialog` `:1307-1314`)
- Test: `public/js/admin/__tests__/lab-tube-label.test.mjs` (append)

- [ ] **Step 1: Append the failing tests** to the end of `public/js/admin/__tests__/lab-tube-label.test.mjs` (after one blank line):

```js
// ═══ Строка: «Печать этикетки» и «Забор пробы» ═════════════════════════════

test('«Печать этикетки» строки — её номер, местное время и название анализа', async () => {
  const c = await mount(PHOTO());
  const item = byClass(c, 'lq-item').find((n) => buttons(n).some((b) => b.getAttribute('title') === 'Печать этикетки'));
  assert.ok(item, 'у взятой пробы нет «Печать этикетки»');
  buttons(item).find((b) => b.getAttribute('title') === 'Печать этикетки').click();
  await tick();
  assert.strictEqual(opened, 1);
  assert.deepStrictEqual(labelsOf(printed[0]), [{ code: '00000028', date: '02.11.2026, 19:06', tests: 'Анализ крови' }]);
});

test('«Забор пробы» с галочкой печатает этикетку строки: её номер, название, время — местное, числом', async () => {
  const c = await mount(PHOTO());
  const item = byClass(c, 'lq-item').find((n) => buttons(n).some((b) => clean(b) === 'Забор пробы') && textOf(n).includes('Анализ крови'));
  assert.ok(item, 'нет строки крови с «Забор пробы»');
  buttons(item).find((b) => clean(b) === 'Забор пробы').click();
  await tick();
  const ok = buttons(fakeBody).find((b) => clean(b) === 'Проба взята');
  assert.ok(ok, 'окно «Забор пробы» не открылось');
  // В браузере setAttribute('checked') включает галочку; у поддельного DOM свойства нет — ставим, как браузер.
  for (const n of walk(fakeBody)) if (n.tagName === 'INPUT' && n.attrs.type === 'checkbox') n.checked = n.hasAttribute('checked');
  ok.click();
  await tick(80);
  assert.strictEqual(opened, 1, 'этикетка не напечатана');
  const [l] = labelsOf(printed[0]);
  assert.strictEqual(l.code, '00000031');
  assert.strictEqual(l.tests, 'Анализ крови');
  assert.match(l.date, /^\d\d\.\d\d\.\d{4}, \d\d:\d\d$/, 'время — местное, числом, а не ISO в UTC: ' + l.date);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-tube-label.test.mjs`
Expected: `ℹ pass 6`, `ℹ fail 2` — `actual: [ { code: '00000028', date: '2026-11-02 14:06', tests: '' } ]` (UTC, no test name); the «Забор пробы» label has no test name either (`actual: ''`) and an ISO-like UTC time.

- [ ] **Step 3: Implement** — edits in `public/js/admin/views/laboratory.js`:

Edit 1 of 3 in `public/js/admin/views/laboratory.js` — old_string:

```js
import { tubeGroups, tubeDeviceMap, tubeLabelStamp } from './lab-tube.js';
```

new_string:

```js
import { tubeGroups, tubeDeviceMap, tubeLabelStamp, shortTestName } from './lab-tube.js';
```

Edit 2 of 3 in `public/js/admin/views/laboratory.js` — old_string:

```js
        dateStr: (r.sample_collected_at || nowIso()).slice(0, 16).replace('T', ' '),
    });
```

new_string:

```js
        // LAB_TUBE_LABEL_V1 — время местное («02.11.2026, 19:06»): раньше печатался
        // UTC из ISO-строки — 14:06 вместо 19:06.
        dateStr: tubeLabelStamp(r.sample_collected_at),
        tests: shortTestName((r.services || {}).name),   // LAB_TUBE_LABEL_V1 — что в пробирке
    });
```

Edit 3 of 3 in `public/js/admin/views/laboratory.js` — old_string:

```js
        if (printCb.checked) {
            printBarcodeLabel({
                code: labBarcodeValue(r.id),   // LAB_BARCODE_DIGITS_V1 — только цифры номера заказа
                patientName: patient.full_name || '',
                mrn: patient.mrn || '',
                dateStr: stamp.slice(0, 16).replace('T', ' '),
            });
        }
```

new_string:

```js
        if (printCb.checked) {
            // LAB_TUBE_LABEL_V1 — та же этикетка строки, что «Печать этикетки»: местное время и название анализа.
            printLabel({ ...r, sample_collected_at: stamp }, patient);
        }
```

(`labBarcodeValue` stays imported — `printLabel` still uses it; `nowIso` stays — it stamps the database in UTC, which is right for storage.)

- [ ] **Step 4: Run — expect PASS**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-tube-label.test.mjs public/js/admin/__tests__/lab-card.test.mjs`
Expected: `ℹ fail 0` (8 + 30).

- [ ] **Step 5: Commit** — write `.git/U11-7.msg`:

```
Этикетка на пробирку (LAB_TUBE_LABEL_V1), шаг 7: этикетка строки — местное время и название

«Печать этикетки» и «Забор пробы» печатали время из ISO-строки в UTC (14:06
вместо 19:06). Теперь — местное время компьютера клиники числом
(«02.11.2026, 19:06», shared/date-words.js dateNumeric) и короткое название
анализа. «Забор пробы» печатает ту же этикетку, что «Печать этикетки».

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git diff --cached --name-only
git add public/js/admin/views/laboratory.js public/js/admin/__tests__/lab-tube-label.test.mjs
git commit -F .git/U11-7.msg
```

---

### Task U11.8: К4 — the cashier reminds to reprint the tube label after a lab swap

**Files:**
- Modify: `public/js/admin/views/cashier-line-fix.js` (`openRefundSwap`, `:532`)
- Modify: `public/js/admin/views/cashier-desk.js` (`afterRefundSwap`, `:2417`)
- Modify: `public/js/admin/i18n-strings.js` (two entries after the U11.6 one)
- Test: `public/js/admin/__tests__/refund-swap.test.mjs` (append)

`openRefundSwap` already knows both sides: `oldLab` (`:343`) and the picked `svc` with `is_lab`/`type` (`:115`, `isLabService` `:324`). It passes `lab` to `onDone`; `afterRefundSwap` adds one sentence to its single notice (review A3 of 3.19.0: one notice, a second one would erase the sum).

- [ ] **Step 1: Append the failing test** to the end of `public/js/admin/__tests__/refund-swap.test.mjs` (after one blank line):

```js
// LAB_TUBE_LABEL_V1 (К4, владелец 2026-11-02) — заменили анализ в окне «Платежи»:
// касса напоминает перепечатать этикетку пробирки. Обычная замена — номер строки
// тот же, но в пробирке другой анализ; «Вернуть эту услугу и выставить новую» —
// у новой строки новый номер. Не анализ на не анализ — без напоминания.
test('К4: замена анализа — «Перепечатайте этикетку пробирки»; возврат с новой — «новый номер»; не анализ — без напоминания', async () => {
    asRole('cashier');
    const REPRINT = ' · Перепечатайте этикетку пробирки.';
    const REPRINT_NEW = ' · Перепечатайте этикетку пробирки: у нового анализа новый номер.';
    const commit = async (serviceId, label, world_) => {
        world_();
        closeAll();
        const win = await openAndPick(serviceId, 21);
        buttonByText(win, label).click();
        await tick(150);
        return TOASTS.at(-1) || '';
    };
    // Неначатый анализ → другой анализ: обычная замена, номер строки тот же.
    assert.ok((await commit(5, 'Заменить и вернуть 70 000 сум', () => world({ lab: true })))
        .endsWith(REPRINT), TOASTS.join(' | '));
    // Проба взята → «Вернуть эту услугу и выставить новую»: новый номер.
    assert.ok((await commit(5, 'Вернуть эту услугу и выставить новую', () => world({ lab: true, lineStatus: 'collected', performed: true })))
        .endsWith(REPRINT_NEW), TOASTS.join(' | '));
    // Приём → анализ: новый анализ встаёт в пробирку — тоже напоминание.
    assert.ok((await commit(5, 'Заменить и вернуть 70 000 сум', () => world()))
        .endsWith(REPRINT), TOASTS.join(' | '));
    // Анализ → не анализ: этикетка с прежним анализом устарела.
    assert.ok((await commit(2, 'Заменить и вернуть 70 000 сум', () => world({ lab: true })))
        .endsWith(REPRINT), TOASTS.join(' | '));
    // Не анализ → не анализ — без напоминания (как было).
    assert.equal(await commit(2, 'Заменить и вернуть 70 000 сум', () => world()), 'Пациенту возвращено 70 000 сум.');
    closeAll();
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/refund-swap.test.mjs`
Expected: `ℹ pass 14`, `ℹ fail 1` — the К4 test (`actual: false`: the notice ends without the reminder).

- [ ] **Step 3: Implement**

Edit 1 of 1 in `public/js/admin/views/cashier-line-fix.js` — old_string:

```js
        if (onDone) await onDone({ ...(data || {}), rebill: rebill || !!(data && data.rebill) });
```

new_string:

```js
        // LAB_TUBE_LABEL_V1 (К4) — в замене анализ (прежняя или новая услуга): касса
        // напомнит перепечатать этикетку пробирки (cashier-desk.js afterRefundSwap).
        if (onDone) await onDone({ ...(data || {}), rebill: rebill || !!(data && data.rebill), lab: oldLab || isLabService(svc) });
```

Edit 1 of 1 in `public/js/admin/views/cashier-desk.js` — old_string:

```js
    if (r.rebill) note += ' · ' + tr('Прежняя услуга возвращена: работа осталась в карте пациента и врачу не оплачивается.');
```

new_string:

```js
    if (r.rebill) note += ' · ' + tr('Прежняя услуга возвращена: работа осталась в карте пациента и врачу не оплачивается.');
    // LAB_TUBE_LABEL_V1 (К4) — заменили анализ: этикетка пробирки устарела. Обычная
    // замена — номер строки тот же, но в пробирке другой анализ; «Вернуть эту
    // услугу и выставить новую» — у новой строки новый номер.
    if (r.lab) {
        note += ' · ' + (r.rebill
            ? tr('Перепечатайте этикетку пробирки: у нового анализа новый номер.')
            : tr('Перепечатайте этикетку пробирки.'));
    }
```

Edit 1 of 1 in `public/js/admin/i18n-strings.js` — old_string:

```js
  "Этикетки на пробирки — по одной на пробирку": {"en":"Tube labels — one per tube","ru":"Этикетки на пробирки — по одной на пробирку","uz":"Probirkalar uchun etiketkalar — har bir probirkaga bittadan"},   // LAB_TUBE_LABEL_V1
```

new_string:

```js
  "Этикетки на пробирки — по одной на пробирку": {"en":"Tube labels — one per tube","ru":"Этикетки на пробирки — по одной на пробирку","uz":"Probirkalar uchun etiketkalar — har bir probirkaga bittadan"},   // LAB_TUBE_LABEL_V1
  "Перепечатайте этикетку пробирки.": {"en":"Reprint the tube label.","ru":"Перепечатайте этикетку пробирки.","uz":"Probirka etiketkasini qayta chop eting."},   // LAB_TUBE_LABEL_V1 (К4)
  "Перепечатайте этикетку пробирки: у нового анализа новый номер.": {"en":"Reprint the tube label: the new test has a new number.","ru":"Перепечатайте этикетку пробирки: у нового анализа новый номер.","uz":"Probirka etiketkasini qayta chop eting: yangi tahlilning raqami yangi."},   // LAB_TUBE_LABEL_V1 (К4)
```

- [ ] **Step 4: Run — expect PASS**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/refund-swap.test.mjs public/js/admin/__tests__/cashier-paid-swap.test.mjs public/js/admin/__tests__/cashier-line-fix.test.mjs public/js/admin/__tests__/cashier-refund-any.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs`
Expected: `ℹ fail 0` (`refund-swap` 15).

- [ ] **Step 5: Commit** — write `.git/U11-8.msg`:

```
Этикетка на пробирку (LAB_TUBE_LABEL_V1), шаг 8 (К4): касса напоминает перепечатать этикетку

После «Заменить услугу» в окне «Платежи», если в замене анализ (прежняя или
новая услуга), уведомление кассы заканчивается словами «Перепечатайте этикетку
пробирки.» — при обычной замене номер строки тот же, но в пробирке другой
анализ; у «Вернуть эту услугу и выставить новую» — «у нового анализа новый номер».

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git diff --cached --name-only
git add public/js/admin/views/cashier-line-fix.js public/js/admin/views/cashier-desk.js public/js/admin/i18n-strings.js public/js/admin/__tests__/refund-swap.test.mjs
git commit -F .git/U11-8.msg
```

---

### Task U11.9: neighbours and guards (no new code)

- [ ] **Step 1: Screens and guards**

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/type-scale.test.mjs public/js/admin/__tests__/uzbek-dates.test.mjs public/js/admin/__tests__/print-auto.test.mjs public/js/admin/views/lab-grouping.test.js public/js/admin/__tests__/refund-any-lab-list.test.mjs public/js/admin/__tests__/lab-separation.test.mjs public/js/admin/__tests__/act-as-sign-lab-inpatient.test.mjs public/js/admin/__tests__/lab-panels-mode.test.mjs public/js/admin/__tests__/lab-doc.test.mjs public/js/admin/views/lab-scope.test.js public/js/admin/__tests__/lab-panels-real-analyzers.test.mjs public/js/admin/__tests__/lab-panels-device-codes.test.mjs public/js/admin/__tests__/app-shell.test.mjs`
Expected: `ℹ fail 0` (238 tests on the scratch copy).

- [ ] **Step 2: Bundle import guard** (ingest now imports from `public/`, which ships)

Run: `node --experimental-vm-modules --test --test-name-pattern="nothing under server/" scripts/build-bundle.test.js`
Expected: `ℹ pass 1`.

- [ ] **Step 2b: Cashier screens** (К4 touched `cashier-desk.js` / `cashier-line-fix.js`; spec К6 — both cashier windows)

Run: `node --experimental-vm-modules --test public/js/admin/__tests__/cancelled-invoice-debt.test.mjs public/js/admin/__tests__/card-sale-desk.test.mjs public/js/admin/__tests__/cashier-line-fix.test.mjs public/js/admin/__tests__/cashier-paid-swap.test.mjs public/js/admin/__tests__/cashier-refund-any.test.mjs public/js/admin/__tests__/cashier-unbilled.test.mjs public/js/admin/__tests__/cashier-v3120.test.mjs public/js/admin/__tests__/deposit-accept-modal.test.mjs public/js/admin/__tests__/payer-act.test.mjs public/js/admin/__tests__/picker-attach-estimate.test.mjs public/js/admin/__tests__/print-v3120.test.mjs public/js/admin/__tests__/receipt-print.test.mjs public/js/admin/__tests__/refund-swap.test.mjs public/js/admin/__tests__/sources-parse.test.mjs public/js/admin/__tests__/visit-refund-door.test.mjs public/js/admin/__tests__/visit-refund-window.test.mjs`
Expected: `ℹ fail 0` (≈170 tests on the scratch copy).

- [ ] **Step 3: Analyzer intake** (`specimenKey` moved)

Run: `node --experimental-vm-modules --test server/lis/tube-anchor.test.js server/lis/specimen-share.test.js server/lis/specimen-key-shared.test.js server/lis/tube-label.test.js server/lis/lisproxy-label-digits.test.js server/lis/ingest.test.js`
Expected: `ℹ fail 0` (170 tests; `tube-anchor.test.js` alone takes about 90 s — normal).

- [ ] **Step 4:** If anything failed, fix it in the task that introduced it and commit that fix with a message naming `LAB_TUBE_LABEL_V1`. Nothing to commit otherwise.

**Notes for R (release notes, plain Russian):** «Лаборатория: кнопка «Штрих-код» печатает этикетку на каждую пробирку визита (кровь, моча — отдельно), все сразу одним окном. Номер этикетки — первая строка пробирки и больше не меняется, когда добавляют анализ; на этикетке — что в пробирке и местное время. Штрих-код стал короче и толще, с полями по краям — сканер читает увереннее. Уже наклеенные этикетки читаются, как прежде».

## Risks / implementer must check

- **Scanner reading set C.** Every Code128 decoder reads A/B/C as one symbology, but nobody has scanned a set-C label from this printer on the clinic's BC-780 and PC scanner yet. Before tagging, the owner prints one label (manual check below). If a reader refuses, the fallback is one line: make `DIGIT_PAIRS` never match (`/^$/`) — everything goes back to set B, quiet zone stays.
- **Do not regenerate set-C vectors with python-barcode 0.16.1 for numbers starting with «99»** — it drops the leading pair. Labels reach «99…» only at visit_services id 99 000 000; but the test still pins `99999999` by the standard.
- **Duplicate blood lines (#28/#31).** With the new label, the result fills #28 only; #31 stays empty in «Открытые» (ingest gives the tube order its own codes first). That is correct for one tube; U9 (DUP_STOP_V1) stops new duplicates. The lab enters #31 by hand or the duplicate is cancelled.
- **Old labels already on tubes** (number of the newest line, e.g. 00000032 urine) behave exactly as before: «неоднозначно» when two open lines of the analyzer exist — use «Привязать». Not changed on purpose (owner rule M1).
- **Shared files.** `i18n-strings.js` and `laboratory.js` are touched by other units: anchors are text, not line numbers; keep the dictionary line right after «Печать этикетки».
- **`state.rows` scope.** Tubes use the visit's lines in the queue (`state.rows`, lab scope «вся клиника/своё здание»); with «только своё здание» a visit's lines from another building are not in the tube (same as the card today).
- **Popup after «Забор пробы».** That label prints after `await advance(...)` (unchanged behaviour); the card button prints synchronously inside the click, so many labels never trip the popup blocker.
- **Forwarder (`new lis`) — checked read-only:** F4 rewrites only 1–5-digit numbers; 8-digit labels pass untouched. If the BC-780 drops leading zeros, that is the separate lab request in the spec (photos of barcode/LIS settings).
- **«Исправить услуги» (head cashier) paid swap has no reminder.** К4 names the two «Платежи» doors only; `openLineFix` → `openSwapConfirm` can also swap a not-yet-started paid lab line whose tube label may already be printed (labels can be printed for «queued» lines now). If the owner wants it there too: `loadInvoiceState` must read `services(is_lab, type)` for lines and `afterSwap` add the same sentence.
- **Other units append to `refund-swap.test.mjs`** (К6 asks every unit to test the cashier windows): an end-of-file conflict is trivial — keep both tests.
- **`tube_color` is not a key** (data almost always empty, like `specimen`). If the owner wants «по цвету пробирки», it is one more key part in `tubeGroups`.

## Manual check for the owner

1. Лаборатория → визит с «Анализ крови» и «Анализ мочи» в двух счетах → «Штрих-код»: в одном окне несколько этикеток; на этикетке крови — номер первой строки крови и «Анализ крови», время — как на часах компьютера.
2. Добавить пациенту ещё один анализ крови и снова нажать «Штрих-код» — номер этикетки крови тот же. В кассе «Платежи» заменить анализ на другой — касса напишет «Перепечатайте этикетку пробирки».
3. Наклеить новую этикетку на пробирку крови и прогнать на BC-780 (и отсканировать сканером компьютера в поиске лаборатории): результат ложится в строку крови, без «неоднозначно».
