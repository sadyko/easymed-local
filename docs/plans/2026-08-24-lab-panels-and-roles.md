# Plan: lab panels without Settings access + fix the roles screen

Owner's assignment (2026-08-24): «laboratory panels editing section so laborant not
gets access to the settings, but can edit the panels of the laboratory. also we need
to fix the roles and permissions. the functions and the ui and ux.»
Reviewed against: web-interface-guidelines, sn-ui-checklist, copywriting.

## Part 1 — panels move into Лаборатория

**The problem is already documented in our own code.** `permissions.js` LOCAL_ROLES_V1:

> "the production LAB_ROLE_SETTINGS_V1 implication (any Laboratory-edit role also
> opens Settings, to manage lab panels) is dropped locally: this app's Settings is
> the FULL clinic-config hub … Otherwise a Lab/Doctor role would reach all config."

So today a lab technician who must edit panels can only get there by being granted
the whole Settings hub — staff accounts, price lists, licence, danger zone. The owner
is asking for exactly the missing piece: panel editing that lives in Лаборатория.

- `views/laboratory.js` gains a two-way switch in its page head: **Очередь** (today's
  queue, unchanged and the default) / **Панели**. Not a new route — a mode inside the
  module, so the sidebar keeps one Лаборатория entry.
- The panels mode renders the panel editor already written in `views/lab-settings.js`.
  Extract that editor into `views/lab-panels.js` and have BOTH mount it: Settings →
  «Лаборатория и диагностика» keeps working for admins, Лаборатория → Панели serves
  the technician. One implementation, two entry points — never a copy.
- Visibility: the switch renders only when `canManageLabSettings()` (already exists,
  already true for a labs-edit role). A read-only lab user sees only Очередь.
- URL state: `#labs` and `#labs/panels` so the mode is linkable and survives reload
  (guidelines: "URL reflects state", "deep-link all stateful UI").

## Part 2 — the roles screen

Findings from reading `settings-hub.js:821-900`:

1. **It is in ENGLISH, inside a Russian-first app.** "Roles & permissions", "Save
   role", "Back to settings", "— module access", "Choose what each staff role sees in
   the app." Every other screen is Russian. This is the single biggest defect on the
   screen and it is not cosmetic: the person configuring roles is a clinic
   administrator, not a developer.
2. **The level `<select>` has no label** — a bare dropdown next to a checkbox
   (guidelines: "Form controls need `<label>` or `aria-label`").
3. **`disabled` select with no explanation.** Unchecking a module greys its level with
   no statement of why.
4. **No empty/loading/error discipline**: "Loading…" is a bare string; a failed load
   toasts and then renders an empty matrix that looks like "this role has nothing",
   which is a dangerous lie on a permissions screen.
5. **One `saveBtn` node is re-parented into every role's card** — switching roles
   moves the same button around; it is also never disabled during save, so a
   double-click double-writes.
6. **No unsaved-changes guard.** Switching role after ticking boxes silently discards
   them (guidelines: "Warn before navigation with unsaved changes").
7. **Inline styles throughout**, inconsistent with the app's scoped-CSS convention.

Copywriting pass (skill: lead with the outcome, second person, no jargon):
- Title «Роли и права» · subtitle «Кто что видит и может менять. У администратора
  всегда полный доступ.»
- The explainer card, today a wall about "UI-access layer", becomes: «Здесь вы
  выбираете, какие разделы видит сотрудник. Доступ к данным дополнительно проверяет
  сервер — это не единственный замок.»
- Button «Сохранить роль» (verb + object, never "Save").
- Level names in Russian, stated as what the person can DO, not as system roles.

**Marketing-psychology skill: deliberately not applied.** It is a conversion-surface
toolkit — social proof, scarcity, anchoring. On an internal permissions screen for a
clinic administrator those principles are either meaningless or manipulative. The one
transferable idea is its JTBD lens, and the job here is: *"I hired a lab technician
this morning; let her enter results without letting her see salaries."* Both parts of
this plan are aimed at exactly that sentence.

## Tasks

1. Extract `views/lab-panels.js`; mount it from Settings AND from a new Панели mode in
   `views/laboratory.js`, gated on `canManageLabSettings()`, with `#labs/panels`.
2. Roles screen: translate fully (ru/uz/en through `tr()`), label the level control,
   real loading/error/empty states, disable save while saving, warn on unsaved
   changes when switching role, move inline styles into a scoped CSS block.
3. Tests for both; full suite; owner reviews on dev before any push.
