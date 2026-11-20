# Rep bot: full doctor questionnaire + attach-existing claims — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** The medical-representative Telegram bot collects every required doctor field (specialty from the clinic list, workplace, district, payment type + card number) and, when the phone already belongs to an existing external doctor, files an attach request that an administrator approves (moving the doctor to the requester) or rejects.

**Spec:** `docs/superpowers/specs/2026-11-20-rep-bot-full-doctor-and-claims-design.md` — read it fully; it is the source of truth for behaviour and texts.

**Architecture:** extend `server/services/rep-bot/flow.js` (questionnaire state machine in `rep_bot_drafts`), add table `rep_bot_claims` (migration **293** — number fixed; 290 is the last on origin/main and another local session holds up to 292), add RPCs next to the existing rep-bot RPCs, and a list on the «Бот представителей» tab (`public/js/admin/views/referrals-rep-bot.js`).

## Ground rules
- Work only in the worktree `C:\Users\Desinger\Desktop\Easymed Original\em-rep`, branch `feat/rep-bot-claims`. Never touch `...\easymed.local` (another session's uncommitted work + the owner's dev server). Never link node_modules into a worktree; never `git worktree remove`; never push/tag; stage files by name.
- TDD; tests co-located; run with explicit file paths (`node --test a.test.js b.test.js`).
- Russian WHY-comments with marker `REP_BOT_CLAIMS_V1`; bot texts bilingual ru + uz like the existing `T` object; every admin-UI and thrown server string needs ru/uz/en in `public/js/admin/i18n-strings.js` (`i18n-coverage.test.mjs`, `server/i18n-server-messages.test.js`); no emojis; font sizes ≥12.5px from the scale.
- Commits in Russian ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- ~10 source-parsing tests fail locally under CRLF and pass on CI (memory `crlf-source-parsing-test-failures`); compare with `origin/main` before calling a failure a regression.

## Task 1: Migration 293 `rep_bot_claims`
- [ ] Find the rep-bot tables' migration (`git grep -n "CREATE TABLE rep_bot_links" server/db/migrations`) to match style and FK targets (`referral_sources(id)`, `users(id)`, `rep_bot_links(id)`).
- [ ] Test `server/db/migrations/293.test.js` first: table exists with the spec's columns; a second `pending` claim for the same (referral_source_id, user_id) is refused; a `pending` + an `approved` for the same pair is allowed; status CHECK rejects unknown values.
- [ ] `server/db/migrations/293_rep_bot_claims.sql`: the table, `CHECK (status IN ('pending','approved','rejected','void'))`, partial unique index `ON rep_bot_claims(referral_source_id, user_id) WHERE status = 'pending'`, index on `(status, created_at)`.
- [ ] Check the test-data wipe plan coverage (`server/services/test-data-wipe-plan.js` + its tests): give the new table a decision consistent with `rep_bot_links` / `rep_bot_additions`.
- [ ] Commit.

## Task 2: Questionnaire in `server/services/rep-bot/flow.js`
- [ ] Read the whole file and `flow.test.js` first.
- [ ] Steps after `name`: `phone` → `specialty` → `workplace` → `district` → `payment` → (`card` only if payment = card) → `confirm`. All required: remove `T.skipBtn` from these steps (keep `T.cancelBtn`); `/skip` and the skip text are treated as an invalid answer with the step's re-ask.
- [ ] Specialty: free text is a SEARCH over `SPECIALTY_ROWS` from `public/js/shared/specialty-list.js` (match ru, uz and en labels case-insensitively, substring); reply with up to 8 inline buttons `callback_data: 'sp:<index into SPECIALTY_ROWS>'`; no match → re-ask. The callback handler validates the index range and that the chat's draft is at step `specialty`; store `SPECIALTY_ROWS[i].ru` (what the Settings dropdown stores — confirm by reading `public/js/admin/specialties.js` / `canonicalSpecialty`).
- [ ] Payment: inline buttons `pay:cash` / `pay:card` / `pay:transfer`; card → step `card`: digits only after removing spaces/dashes, exactly 16 digits, stored as digits.
- [ ] Summary shows specialty, workplace, district, payment type (Russian label), card number (masked except last 4 is fine — decide and test).
- [ ] `saveDraftedSource` writes `payment_type` and `card_number` too (check the real column names on `referral_sources`: `git grep -n "payment_type\|card_number" server/db/migrations`).
- [ ] A stored draft whose step no longer exists → drop it, show the menu (the existing `idx < 0` path).
- [ ] Update/extend `flow.test.js` for every new step, invalid answers, and the callbacks (`sp:` out of range, wrong step, `pay:` unknown).
- [ ] Commit.

## Task 3: Claims — bot side + RPCs
- [ ] Bot (`flow.js`): at the `phone` step and again in `saveDraftedSource`, when `findSourceWithPhone` finds a doctor: if `representative_id === rep.id` → tell «уже закреплён за вами», drop the draft, no claim; else insert a `pending` claim (or reuse the open one for the pair — catch the unique index) with `entered_name = draft.name`, reply with the spec's text (bilingual), drop the draft.
- [ ] Find the existing rep-bot RPC module (`git grep -n "rep_bot_links_list" server/services/rpc`) and the server function behind `referrals_assign_representative` (`server/services/rpc/referrals.js`). Add:
  - `rep_bot_claims_list` — open claims with doctor (id, code, name, phone), requester (id, full_name), current representative (id, full_name or null), created_at. Same permission as the other rep-bot RPCs (admin).
  - `rep_bot_claim_decide({ id, decision: 'approve' | 'reject' })` — admin; a write (not in READ_ONLY_RPCS; licence-locked clinic refused by gate.js as for other writes). Approve: in ONE transaction re-check claim `pending`, doctor exists (external, `doctor_id IS NULL`), requester active with the representative role (reuse `representativeCodes`), then attach via the SAME server rule as `referrals_assign_representative` (call its function; do not duplicate the SQL), record `prev_representative_id`, `decided_by`, `decided_at`, status `approved`. Failed re-check → status `void`, return a clear error/flag. Reject → `rejected`.
  - Register both in `server/services/rpc/index.js`; `rep_bot_claims_list` in READ_ONLY_RPCS (`server/services/control/gate.js`) like `rep_bot_links_list` (check how that one is classified and match it).
- [ ] Notifications after the transaction, best-effort (catch and log, never fail the RPC): to the requester's active confirmed link chat — approved / rejected texts; on approve, if a different previous representative has an active confirmed link — «передан другому представителю». Use the rep bot's token the same way the rest of rep-bot sends (`server/services/rep-bot/settings.js` / `index.js`); inject a sender for tests.
- [ ] Tests: bot-side (claim created once, reuse, «уже за вами», duplicate found at save time), RPC (list shape, approve attaches + moves + records prev, reject, void when requester lost role, non-admin refused, notifications called with the right chats, notification failure doesn't break approval).
- [ ] Commit.

## Task 4: Admin list on «Бот представителей»
- [ ] `public/js/admin/views/referrals-rep-bot.js`: load `rep_bot_claims_list` with the other lists; render «Заявки на закрепление» (shown only when there are open claims, or with an empty-state line — follow how «Ожидают подтверждения» renders) with doctor №/ФИО/телефон, «Заявитель», «Сейчас закреплён» (or «не закреплён»), date, buttons «Подтвердить» / «Отклонить» calling `rep_bot_claim_decide`, then reload lists; toast the server message on error. Reuse the tab's existing row/table styles.
- [ ] i18n ru/uz/en for every new string; view test (find the tab's existing test, e.g. `ls public/js/admin/__tests__ | grep -i rep`) covering render + approve call + error toast.
- [ ] Update the tab's demo/preview text if the tab shows a scripted example of the bot dialogue (grep the view for «ФИО врача»).
- [ ] Commit.

## Task 5: Check
- [ ] Run all touched test files plus `server/services/rep-bot/*.test.js`, `server/services/rpc/referrals*.test.js`, wipe-plan tests, i18n-coverage, type-scale, `server/i18n-server-messages.test.js`, `server/services/control/gate.test.js`.
- [ ] Report to the controller. Do not push.
