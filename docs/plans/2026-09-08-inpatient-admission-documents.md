# Admission Documents (Документы при поступлении) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three admission papers (contract, informed consent, memo) printable from the placement window and the case-history title sheet, with their text editable in the «Документы» designer, and the patient's signing recorded on the title sheet.

**Architecture:** The papers are three new document types of the existing designer (`shared/doc-render.js` renders, `doc_branding.settings` stores the text, `printableSheet()` prints). The title-sheet form (`views/title-sheet.js`) gains a fourth block with print buttons and ticks; ticks map to three timestamp columns added to `admission_title_sheets` (migration 111). Summary text for "signed / not signed" lives once in `title-sheet-print.js` and is used by the printed sheet, the case-history list and the editor status line.

**Tech Stack:** as the title-sheet plan (Node 24 ESM, better-sqlite3, `node --test`, fake-DOM harness).

Spec: `docs/specs/2026-09-08-inpatient-admission-documents-design.md`. Repo: `C:/Users/user/Desktop/implementation workflow/easymed.local`.

---

### Task 1: Renderer — three document bodies (`shared/doc-render.js`)

**Files:** Modify `public/js/shared/doc-render.js`; Test `public/js/shared/doc-render.inpatient.test.js`.

- [ ] Test (write first):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetHtml, INPATIENT_DOC_TYPES, INPATIENT_DOC_META, INPATIENT_DOC_DEFAULT_TEXT, inpatientDocText } from './doc-render.js';

const S = { clinicName: 'Клиника Тест', tagline: '', address: 'Ташкент', phone: '+998', email: '', web: '', accent: '#167873', accentSoft: '#effaf8', ink: '#0b1418', paperBg: '#fff',
    showWatermark: false, showStamp: false, showSignature: false, showQR: false, language: 'ru', paperSize: 'A4', fontPair: 'modern', cornerStyle: 'rounded', footerNote: '', legalNote: '', variant: {} };
const D = { patientName: 'Иванов Иван Иванович', department: 'Терапия', ward: 'Т-1', bed: 'T-2', doctorName: '', date: '08.09.2026' };

test('три бумаги: заголовок, узбекский подзаголовок, текст по умолчанию, пациент, подписи', () => {
    assert.deepEqual(INPATIENT_DOC_TYPES, ['inpatient_contract', 'inpatient_consent', 'inpatient_memo']);
    for (const type of INPATIENT_DOC_TYPES) {
        const html = buildSheetHtml({ type, s: S, data: D });
        const m = INPATIENT_DOC_META[type];
        for (const piece of [m.titleRu, m.titleUz, 'Иванов Иван Иванович', 'Терапия', 'Т-1 / T-2', 'Пациент / Bemor', 'Врач / Shifokor', 'Клиника Тест', '08.09.2026']) {
            assert.ok(html.includes(piece), type + ': нет ' + piece);
        }
        const firstPara = INPATIENT_DOC_DEFAULT_TEXT[m.textKey].split(/\n\s*\n/)[0].slice(0, 40);
        assert.ok(html.includes(firstPara), type + ': текста по умолчанию нет');
    }
});

test('текст клиники из настроек вытесняет текст по умолчанию; пустой — нет', () => {
    const s = Object.assign({}, S, { inpatientContractText: 'Пункт первый.\n\nПункт второй.' });
    const html = buildSheetHtml({ type: 'inpatient_contract', s, data: D });
    assert.ok(html.includes('Пункт первый.') && html.includes('Пункт второй.'));
    assert.ok(!html.includes('Предмет договора'));
    assert.equal(inpatientDocText(Object.assign({}, S, { inpatientContractText: '   ' }), 'inpatient_contract'), INPATIENT_DOC_DEFAULT_TEXT.inpatientContractText);
});

test('без данных — образец для предпросмотра; без врача — линия для подписи', () => {
    const html = buildSheetHtml({ type: 'inpatient_memo', s: S });
    assert.ok(html.includes('Пациент / Bemor'));
    const noDoc = buildSheetHtml({ type: 'inpatient_consent', s: S, data: Object.assign({}, D, { doctorName: '' }) });
    assert.ok(noDoc.includes('Врач / Shifokor'));
});
```

- [ ] Implement: exports `INPATIENT_DOC_TYPES`, `INPATIENT_DOC_META`, `INPATIENT_DOC_DEFAULT_TEXT`, `inpatientDocText(s, type)`; `sampleInpatientDoc()`; `inpatientDocBody(s, d, type)` (header → title block → four fields with blank underline for empty → paragraphs → two signature lines → footer); `renderBuiltinBody` cases; `titleFor` entries.
- [ ] Run `node --test public/js/shared/doc-render.inpatient.test.js` → 3/3. Commit.

### Task 2: Designer — three tabs and the text card

**Files:** Modify `views/doc-settings.js` (`DEFAULT_DOC_SETTINGS`, `DOC_VARIANTS`), `views/documents.js` (`DOC_TYPES`, `settingsPanel`).

- [ ] `doc-settings.js`: import `INPATIENT_DOC_DEFAULT_TEXT` from `../../shared/doc-render.js`; add `...INPATIENT_DOC_DEFAULT_TEXT` before `variant: {}`; add the three `DOC_VARIANTS` entries `[{ key: 'classic', label: 'Классический' }]`.
- [ ] `documents.js`: import `INPATIENT_DOC_TYPES, INPATIENT_DOC_META` from `../../shared/doc-render.js`; append to `DOC_TYPES`:
  `{ id: 'inpatient_contract', label: 'Договор на госпитализацию', icon: 'Doc', sub: 'Стационар · подпись пациента', paper: 'A4' }`, `{ id: 'inpatient_consent', label: 'Информированное согласие', icon: 'Doc', sub: 'Стационар · подпись пациента', paper: 'A4' }`, `{ id: 'inpatient_memo', label: 'Памятка стационара', icon: 'Doc', sub: 'Стационар · выдаётся пациенту', paper: 'A4' }`.
  In `settingsPanel()` after `variantCard(),` insert `inpatientTextCard(),` where:

```js
// INPATIENT_DOCS_V1 — текст бумаги при поступлении редактируется здесь же.
function inpatientTextCard() {
    if (!INPATIENT_DOC_TYPES.includes(state.active)) return null;
    const key = INPATIENT_DOC_META[state.active].textKey;
    return editorCard('Текст документа', 'Doc', [
        h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', lineHeight: '1.45' } },
            tr('Абзацы разделяются пустой строкой. Шапка клиники, данные пациента и подписи подставляются сами.')),
        h('textarea', {
            value: state.s[key] || '',
            rows: '16',
            style: { ...fieldStyle(true), minHeight: '260px' },
            oninput: (e) => set({ [key]: e.target.value }, { skipRepaint: true }),
        }),
    ]);
}
```
- [ ] Test (`public/js/admin/__tests__/inpatient-docs.test.mjs`, fake-DOM harness copied from `title-sheet.test.mjs`): `DOC_VARIANTS` has the three keys; `DEFAULT_DOC_SETTINGS.inpatientMemoText` equals the default. Run, commit.

### Task 3: Server — ticks on the title sheet

**Files:** Create `server/db/migrations/111_admission_title_sheet_papers.sql` + `111.test.js`; modify `server/services/rpc/title-sheet.js`; extend `title-sheet.test.js`.

- [ ] Migration: three `ALTER TABLE admission_title_sheets ADD COLUMN … TEXT;` with a header comment. Test: columns exist; migrate on a DB with an existing sheet row keeps the row.
- [ ] `title-sheet.js`: `PAPERS = { contract_signed: 'contract_signed_at', consent_signed: 'consent_signed_at', memo_given: 'memo_given_at' }`; in `saveTitleSheet` defaults `contract_signed_at: null, …`; for each `[flag, col]`: if `src[flag] !== undefined` → `next[col] = truthy(src[flag]) ? (next[col] || now) : null`; add the three columns to UPDATE/INSERT; `titleSheetCaseItem` returns `papers: row ? { contract_signed_at: row.contract_signed_at, consent_signed_at: row.consent_signed_at, memo_given_at: row.memo_given_at } : { contract_signed_at: null, consent_signed_at: null, memo_given_at: null }`.
- [ ] Tests: tick sets timestamp; second save without the flag keeps it; `false` clears; strings `'true'/'1'` count as ticked; case item carries `papers`. Run title-sheet + case-docs tests, commit.

### Task 4: Client — fourth block, print, summaries

**Files:** Modify `views/title-sheet.js`, `views/title-sheet-print.js`, `views/case-docs.js`; extend `__tests__/title-sheet.test.mjs`.

- [ ] `title-sheet-print.js`: export `PAPERS_UI = [['contract_signed', 'contract_signed_at', 'Договор', 'подписан', 'не подписан'], ['consent_signed', 'consent_signed_at', 'Согласие', 'подписано', 'не подписано'], ['memo_given', 'memo_given_at', 'Памятка', 'выдана', 'не выдана']]` and `papersSummary(papers, { withDates = true } = {})` → `'Договор — подписан 08.09.2026 12:10 · Согласие — не подписано · Памятка — выдана …'` built with `tr()`/`trf('{doc} — {state}', …)` and `fmtDateTime`. In `titleSheetPrintSection`, before `${sign}`, add `<div class="kv papers"><span class="k">Документы при поступлении</span><span class="v">${esc(papersSummary(s))}</span></div>` when `s` exists.
- [ ] `title-sheet.js`: import `printableSheet` from `./doc-settings.js?v=noqr1` and `INPATIENT_DOC_TYPES` … from `../../shared/doc-render.js`; `export function printInpatientDoc(type, data) { printableSheet({ type, data }); }`; `titleSheetForm({ bed = null, onPrint = printInpatientDoc })`; keep `current = { patient, admission }` updated in `fill()`; add block «Документы при поступлении» with rows `[type, flagKey, label, tickLabel]` = `[['inpatient_contract','contract_signed','Договор на госпитализацию','подписан'], ['inpatient_consent','consent_signed','Информированное согласие','подписано'], ['inpatient_memo','memo_given','Памятка стационара','выдана']]`: name · button «Печать» (`onclick: () => onPrint(type, docData())`) · checkbox + label; `docData()` = `{ patientName, department, ward, bed, doctorName: attending_name, date: dateNumeric(new Date()) }`; `picked.papers[flag]` from `!!s[col]` in `fill`, sent in `read().sheet`.
- [ ] `case-docs.js` `itemRow`: after the meta span, when `item.kind === 'title' && item.papers`, add a line `h('span', { style: { display: 'block', fontSize: '12.5px', marginTop: '2px', color: 'var(--ink-500)' } }, papersSummary(item.papers, { withDates: false }))`.
- [ ] `buildTitleSheetEditor` status: append `' · ' + papersSummary(view.sheet, { withDates: false })` when a sheet exists.
- [ ] Tests: block renders three «Печать» buttons; click → `onPrint('inpatient_contract', { patientName: 'Иванов Иван Иванович', department: 'Терапия', ward: 'Терапия', bed: 'T-2', … })`; tick → `read().sheet.contract_signed === true`; print section includes «Документы при поступлении» and «не подписан»; `papersSummary` with dates. Run title-sheet, case-docs (client), i18n; commit.

### Task 5: i18n, full suite, push

- [ ] Add missing ru/uz/en entries reported by `i18n-coverage.test.mjs` (labels above, tab labels/subs, card title/hint, summary words).
- [ ] `node --check` touched modules; full suite in background; push on `REAL_EXIT=0` + `fail 0`.
