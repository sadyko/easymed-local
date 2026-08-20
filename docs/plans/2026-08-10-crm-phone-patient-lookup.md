# CRM Phone Patient Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the CRM lead modal, typing a phone number surfaces matching clinic patients in a dropdown; picking one links the lead to that patient (same as the existing ФИО picker).

**Architecture:** Pure matching logic (digits extraction, `ilike` pattern building, contiguous-digits post-filter) lives in a new co-located module `crm-phone-match.js`, unit-tested with `node:test` — the same pattern as `lab-grouping.js`. The DOM wiring (dropdown under the Телефон input inside `editorPopup()` in `crm.js`) reuses the existing ФИО-typeahead construction verbatim and is verified manually.

**Tech Stack:** Vanilla ES modules (no build step), `node --test` runner, local supabase-shaped shim (`supabase.from(...).ilike(...)` → `/api/db` query compiler; `ilike` is already allow-listed on `patients.phone`).

**Spec:** `docs/specs/2026-08-10-crm-phone-patient-lookup-design.md`

**Why not plain substring match:** patient phones are stored formatted (`+998 90 961 00 04`, see `phoneInput`/`fmtPhone` in `registration.js`), managers type raw (`+998950768008`). Matching must compare digits only, and the SQL `LIKE` digit-pattern alone is a *subsequence* match, so a client-side contiguous post-filter is required.

---

### Task 1: Pure matching helpers (`crm-phone-match.js`)

**Files:**
- Create: `public/js/admin/views/crm-phone-match.js`
- Test: `public/js/admin/views/crm-phone-match.test.js`

- [ ] **Step 1: Write the failing tests**

Create `public/js/admin/views/crm-phone-match.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { digitsOf, phoneLikePattern, filterPhoneMatches, MIN_PHONE_DIGITS } from './crm-phone-match.js';

// ---------------------------------------------------------------------------
// digitsOf
// ---------------------------------------------------------------------------
test('digitsOf: strips every non-digit', () => {
  assert.equal(digitsOf('+998 90 961-00-04'), '998909610004');
  assert.equal(digitsOf('(90) 961.00.04'), '909610004');
});

test('digitsOf: null/undefined/empty -> empty string', () => {
  assert.equal(digitsOf(null), '');
  assert.equal(digitsOf(undefined), '');
  assert.equal(digitsOf(''), '');
});

// ---------------------------------------------------------------------------
// phoneLikePattern
// ---------------------------------------------------------------------------
test('phoneLikePattern: interleaves % so any stored formatting matches', () => {
  assert.equal(phoneLikePattern('9610'), '%9%6%1%0%');
});

// ---------------------------------------------------------------------------
// filterPhoneMatches
// ---------------------------------------------------------------------------
const rows = [
  { id: 1, full_name: 'Иванов', phone: '+998 90 961 00 04' },
  { id: 2, full_name: 'Петрова', phone: '+998 95 076 80 08' },
  { id: 3, full_name: 'Безномера', phone: null },
];

test('filterPhoneMatches: typed digits must be a CONTIGUOUS run of stored digits', () => {
  assert.deepEqual(filterPhoneMatches(rows, '998909610004').map(r => r.id), [1]);
  assert.deepEqual(filterPhoneMatches(rows, '950768008').map(r => r.id), [2]);
  assert.deepEqual(filterPhoneMatches(rows, '9610').map(r => r.id), [1]);
});

test('filterPhoneMatches: subsequence-only match is rejected', () => {
  // '9899' is a subsequence of 998909610004 (SQL %9%8%9%9% would match it)
  // but not a contiguous run — the post-filter must drop it.
  assert.deepEqual(filterPhoneMatches(rows, '9899'), []);
});

test('filterPhoneMatches: tolerates null phones and null/undefined row list', () => {
  assert.deepEqual(filterPhoneMatches(null, '9610'), []);
  assert.deepEqual(filterPhoneMatches(undefined, '9610'), []);
});

test('filterPhoneMatches: caps the result at 6 rows', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: i, phone: '+998 90 961 00 04' }));
  assert.equal(filterPhoneMatches(many, '9610').length, 6);
});

test('MIN_PHONE_DIGITS is 4', () => {
  assert.equal(MIN_PHONE_DIGITS, 4);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test public/js/admin/views/crm-phone-match.test.js`
Expected: FAIL — `Cannot find module ... crm-phone-match.js`

- [ ] **Step 3: Write the implementation**

Create `public/js/admin/views/crm-phone-match.js`:

```js
// CRM_V8 — телефонный поиск пациента в форме заявки. Телефоны в базе хранятся
// В ФОРМАТЕ («+998 90 961 00 04» — fmtPhone в registration.js), а менеджер
// вводит подряд («+998950768008»), поэтому сравнение — только по цифрам:
//  1) phoneLikePattern даёт SQL-шаблон `%9%6%1%0%` — LIKE пропускает любые
//     разделители МЕЖДУ цифрами, значит найдёт номер в любом формате;
//  2) LIKE-шаблон матчит и ПОДпоследовательности (лишние цифры между),
//     поэтому filterPhoneMatches оставляет только те строки, где введённые
//     цифры идут в номере ПОДРЯД.
// Чистые функции без DOM — тестируются node --test (как lab-grouping.js).

export const MIN_PHONE_DIGITS = 4;   // короче — почти вся база «совпадает»
const MAX_RESULTS = 6;               // как у подсказки в поле ФИО

export function digitsOf(s) {
    return String(s == null ? '' : s).replace(/\D/g, '');
}

export function phoneLikePattern(digits) {
    return '%' + String(digits).split('').join('%') + '%';
}

export function filterPhoneMatches(rows, digits) {
    return (rows || [])
        .filter((r) => digitsOf(r.phone).includes(digits))
        .slice(0, MAX_RESULTS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test public/js/admin/views/crm-phone-match.test.js`
Expected: PASS — 8 tests, 0 failures

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all tests pass (same count as before this task, plus 8 new)

- [ ] **Step 6: Commit**

```bash
git add public/js/admin/views/crm-phone-match.js public/js/admin/views/crm-phone-match.test.js
git commit -m "Add digit-normalized phone matching helpers for the CRM lead form"
```

---

### Task 2: Wire the dropdown into the lead modal (`crm.js`)

**Files:**
- Modify: `public/js/admin/views/crm.js` (imports at top; `editorPopup()` — the block after `if (linkedPatient) paintLinked();` near line 456; the Телефон row in the modal body near line 550)

The dropdown is a verbatim clone of the ФИО typeahead's construction (`patResults`/`paintPatResults`, lines 394–455 of `crm.js`): same styles, same `onmousedown` selection (fires before blur), same 250 ms debounce, same stale-response sequence guard, same «Пациенты клиники» header. On pick it runs the SAME link action as the ФИО picker — sets `linkedPatient`, repaints the chip — and leaves the typed phone untouched (the manager is on the phone; what they typed is ground truth).

- [ ] **Step 1: Add the import**

In `public/js/admin/views/crm.js`, after the existing imports (line 8):

```js
import { digitsOf, phoneLikePattern, filterPhoneMatches, MIN_PHONE_DIGITS } from './crm-phone-match.js';
```

- [ ] **Step 2: Add the phone typeahead block**

Inside `editorPopup()`, directly after the line `if (linkedPatient) paintLinked();` (line 456), insert:

```js
        // CRM_V8 — Телефон = тоже поиск по базе: у менеджера в руках прежде
        // всего НОМЕР звонящего. Совпадение считается по цифрам (см.
        // crm-phone-match.js — формат хранения «+998 90 …» ≠ формату ввода),
        // клик привязывает пациента так же, как выбор в поле ФИО. Введённый
        // номер НЕ перезаписывается номером из карты.
        const phoneResults = h('div', { style: { display: 'none', position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 41, maxHeight: '230px', overflow: 'auto', background: 'var(--white, #fff)', border: '1px solid var(--ink-200)', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' } });
        const phoneWrap = h('div', { style: { position: 'relative' } }, phoneInp, phoneResults);
        let phoneSeq = 0;
        async function paintPhoneResults() {
            const digits = digitsOf(phoneInp.value);
            if (linkedPatient || digits.length < MIN_PHONE_DIGITS) { phoneResults.style.display = 'none'; return; }
            const my = ++phoneSeq;
            const { data } = await supabase.from('patients').select('id, full_name, mrn, phone')
                .ilike('phone', phoneLikePattern(digits)).order('full_name').limit(30);
            if (my !== phoneSeq) return;
            clear(phoneResults);
            const pool = filterPhoneMatches(data, digits);
            if (!pool.length) { phoneResults.style.display = 'none'; return; }
            phoneResults.style.display = '';
            phoneResults.appendChild(h('div', { style: { padding: '7px 12px 4px', fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-400)' } }, 'Пациенты клиники'));
            for (const p of pool) {
                phoneResults.appendChild(h('div', {
                    class: 'row', style: { gap: '8px', alignItems: 'center', padding: '8px 12px', cursor: 'pointer', fontSize: '13px' },
                    onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                    onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                    onmousedown: (e) => {
                        e.preventDefault();
                        linkedPatient = p;
                        phoneResults.style.display = 'none';
                        paintLinked();
                    },
                }, h('b', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.full_name),
                   p.mrn ? Tag(p.mrn, { kind: 'ok' }) : null,
                   h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: 'auto' } }, p.phone || '')));
            }
            phoneResults.appendChild(h('div', { class: 'muted', style: { padding: '5px 12px 8px', fontSize: '11.5px', borderTop: '1px solid var(--ink-50, #eef1f3)' } },
                'Не он? Просто продолжайте вводить номер — заявка создастся как новый лид.'));
        }
        let phoneTimer = null;
        phoneInp.addEventListener('input', () => { clearTimeout(phoneTimer); phoneTimer = setTimeout(paintPhoneResults, 250); });
        phoneInp.addEventListener('blur', () => setTimeout(() => { phoneResults.style.display = 'none'; }, 150));
```

- [ ] **Step 3: Mount the wrapper in the modal body**

Still in `editorPopup()`, in the modal body (line ~550), change:

```js
                    h('div', { style: { flex: 1 } }, field('Телефон', phoneInp, { required: true })),
```

to:

```js
                    h('div', { style: { flex: 1 } }, field('Телефон', phoneWrap, { required: true })),
```

(Only the line inside the `isEdit`-agnostic modal body around line 550 — the OTHER `field('Телефон', phoneInp, …)` near line 359 belongs to `convertPopup`, the patient-registration popup; leave it untouched.)

- [ ] **Step 4: Syntax check and full suite**

Run: `node --check public/js/admin/views/crm.js && npm test`
Expected: no syntax error; all tests pass

- [ ] **Step 5: Manual verification in the running app**

Run: `npm start` → http://localhost:8000, log in, open CRM → «Новая заявка»:

1. Type a known patient's phone digits into Телефон (with or without `+998`, no spaces) → dropdown lists that patient (name + MRN + stored phone).
2. Click the row → green «пациент клиники» chip appears in ФИО; the phone stays exactly as typed; save → the lead row shows the linked patient.
3. Chip × (отвязать) → typing in Телефон again re-offers matches.
4. Unknown number → no dropdown, lead saves as a plain new lead.
5. Open an existing linked lead → typing in Телефон shows NO dropdown (patient already linked).

- [ ] **Step 6: Commit**

```bash
git add public/js/admin/views/crm.js
git commit -m "CRM: find and link clinic patients by phone in the lead form"
```

---

## Self-review notes

- **Spec coverage:** trigger/debounce/threshold (Task 2 Step 2), digit-normalized two-stage matching (Task 1 + query in Task 2), dropdown UI + pick-to-link + phone kept as typed (Task 2 Step 2), no-match silence and error silence (`data` falsy → `filterPhoneMatches(null)` → `[]` → hidden), create+edit both covered (single code path), linked-patient suppression (guard in `paintPhoneResults`). Out-of-scope items untouched.
- **Types:** helper names/signatures identical across tasks (`digitsOf`, `phoneLikePattern`, `filterPhoneMatches`, `MIN_PHONE_DIGITS`).
- The `.order('full_name')` + `limit(30)` before post-filtering means >30 raw LIKE hits could theoretically hide a match; with a 4+ digit pattern on a single-clinic DB this is acceptable (documented cap, same spirit as the ФИО picker's `limit(6)`).
