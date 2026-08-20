# CRM: patient lookup by phone in the lead form — design

**Date:** 2026-08-10
**Status:** approved (design approved in-session)
**Scope:** `public/js/admin/views/crm.js` (lead editor modal only)

## Problem

The lead modal's ФИО field already has a patient typeahead: matches drop down,
picking one links the lead to the patient (`patient_id`) and shows the green
«пациент клиники» chip. The Телефон field has no lookup, yet the phone number
is what a call-center manager has first. If an existing patient calls, the
manager types the number and creates a duplicate lead with no patient link.

A naive `ilike '%typed%'` search would not fix this: patient phones are stored
formatted (`+998 90 961 00 04`, see `phoneInput`/`fmtPhone` in
`registration.js`), while managers type raw numbers (`+998950768008`). The
formats disagree, so substring matching on the raw input misses most patients.

## Design

When the manager types into Телефон in the lead modal (create or edit):

- **Trigger:** debounced 250 ms; runs only when the input contains ≥ 4 digits
  and no patient is currently linked (`linkedPatient == null`). A stale-response
  guard (sequence counter, same as the ФИО picker) discards out-of-order
  results.
- **Matching (digit-normalized, two stages):**
  1. Strip the input to digits. Query
     `patients.select('id, full_name, mrn, phone').ilike('phone', p).limit(30)`
     where `p` = `'%' + digits.split('').join('%') + '%'`
     (e.g. `%9%9%8%9%5%0%…%`). LIKE lets arbitrary characters sit between the
     digits, so any stored formatting matches. No server changes: the query
     compiler already allow-lists `ilike` on `patients.phone`.
  2. The SQL pattern is a *subsequence* match (looser than intended), so
     post-filter client-side: keep rows where
     `row.phone.replace(/\D/g, '').includes(digits)` — the typed digits must be
     a contiguous run of the stored phone's digits. Show the first 6.
- **Dropdown UI:** same construction as the existing ФИО dropdown, anchored
  under the phone input: «Пациенты клиники» header; rows of full name +
  MRN `Tag` + stored phone; `onmousedown` select (fires before blur);
  hidden on blur after 150 ms; hidden when there are no matches.
- **On pick:** `linkedPatient = p; paintLinked();` — identical to the ФИО
  picker, so the green chip appears in ФИО and the lead saves with
  `patient_id`. The phone input keeps exactly what the manager typed (they are
  on the phone with the caller; the typed number is ground truth). Unlinking
  via the chip's × behaves as today.
- **No matches / new caller:** nothing appears; the manager continues filling
  the form and the lead is created unlinked, as today.

## Components

One new self-contained block inside `editorPopup()` next to the existing ФИО
typeahead: a results container element, a `paintPhoneResults()` function, and
input/blur listeners on the existing `phoneInp`. A small pure helper
`digitsOf(s)` shared by pattern-building and post-filtering. No schema, route,
or registry changes.

## Error handling

Query errors degrade silently (no dropdown), matching the ФИО picker's
behavior — lookup is an assist, never a blocker. The stale-response guard
prevents a slow early query from overwriting results of a later keystroke.

## Testing

- `server/db/query-compiler` behavior for `ilike` on `patients.phone` is
  already covered; no server tests needed.
- The digit-pattern/post-filter logic is the risky part. It lives as small
  pure steps; verify manually against stored formatted phones
  (`+998 90 961 00 04` found by typing `998909610004`, `909610004`, partial
  runs like `9610`), plus the negative case (subsequence-only match must NOT
  appear: typing `9899` must not surface `+998 90 961 00 04`).
- Manual UI pass: pick → chip + `patient_id` on save; blur hides; unlink works;
  edit modal behaves the same; linked patient suppresses further lookups.

## Out of scope

- Fixing the ФИО picker's own phone matching (same formatting mismatch) — the
  user chose to keep this change scoped to the phone field.
- Server-side normalized-phone column/RPC — unnecessary at local single-clinic
  scale.
