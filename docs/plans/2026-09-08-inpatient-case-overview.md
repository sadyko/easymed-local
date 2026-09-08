# Case Overview (Обзор госпитализации) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing a hospitalized patient opens the doctor's dashboard (status, diagnosis, diet, prescriptions, services, operation, bill, documents progress, discharge) with a shared header that navigates between patients, whose main action opens the documents to fill; the discharge button also generates the hospitalization bill.

**Architecture:** One read RPC `admission_overview` (`rpc/case-overview.js`) assembles everything from existing tables. `admission_discharge_request` gains `generate_bill` (accommodation up to now + all unbilled services → one invoice via the role-free half of `createInvoiceForAdmission`). Client: new route `case-overview` (`views/case-overview.js`) with `caseHead()` shared with `case-file`; ward rows and the history table navigate there.

**Tech Stack:** as before. Spec: `docs/specs/2026-09-08-inpatient-case-overview-design.md`.

---

### Task 1: Server — `admission_overview` (+ `buildAdmissionInvoice`, bill on discharge)

**Files:** Create `server/services/rpc/case-overview.js`, `server/services/rpc/admission-bill.js`, `server/services/rpc/case-overview.test.js`; modify `rpc/billing.js` (split `createInvoiceForAdmission` → `buildAdmissionInvoice`), `rpc/inpatient.js` (`admissionDischargeRequest`: `generate_bill`), `rpc/index.js` (register `admission_overview`).

- [ ] Tests first (`case-overview.test.js`): overview of a freshly placed patient (status, days = 1, referral diagnosis, empty orders/services, operation `none`, `neighbours` 1 of 1, `docs.next_kind`); after treatment (clinical diagnosis from the primary exam, one active order with `today.due` = slots, diet current, two services unbilled, operation `planned` via surgery service, `done` after the protocol); neighbours for a plain doctor (own patients only) vs head doctor (all, prev/next); cashier refused; discharge with `generate_bill` → invoice number, every service invoiced, `bill` null when nothing to bill, request still refused without epicrisis.
- [ ] Implement `admissionOverview` exactly as the spec's shape; `generateAdmissionBill(db, admissionId, user)`; `buildAdmissionInvoice(db, admissionId, ids, user)`; hook into the discharge request transaction; register the RPC.
- [ ] Run `node --test server/services/rpc/case-overview.test.js server/services/rpc/inpatient.test.js server/services/rpc/billing.test.js server/services/rpc/discharge.test.js` → green. Commit.

### Task 2: Client — `views/case-overview.js`, route, navigation from lists

**Files:** Create `views/case-overview.js`, `__tests__/case-overview.test.mjs`; modify `admission-modal.js` (`goToCaseOverview`, discharge modal `generateBill`), `admissions.js` (`inWardCard` → overview), `ward-beds.js` (history rows clickable), `case-workspace.js` (head + `payload.kind`), `admin.js` (route, crumbs, parent), `admin-views.css` (`.co-*` styles), `i18n-strings.js`.

- [ ] Tests first (fake-DOM harness as in `title-sheet.test.mjs`, fetch stub for `admission_overview` returning a fixture): header shows name, «3-й день», ward · bed, attending, allergy strip; «‹»/«›» call `onNavigate('case-overview', { admissionId: prev/next })`, counter «2 из 3»; avatar click → `onNavigate('case-file', { admissionId })`; main action → `onNavigate('case-file', { admissionId, kind: 'consent' })`; blocks render diagnosis/diet/orders/services/operation/bill/docs texts; «Выписка» opens the request modal that sends `generate_bill: true` and toasts the invoice number; `inWardCard` row → `case-overview`.
- [ ] Implement `renderCaseOverview`, `caseHead`, blocks; wire lists, workspace head, route, styles, translations.
- [ ] Run the client inpatient tests + i18n + type-scale → green. Commit.

### Task 3: Full suite, push

- [ ] `node --check` touched modules; full suite in background; push on green.
