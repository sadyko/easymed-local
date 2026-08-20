# Platform Console — dump of the LIVE setting.easymed.uz

**Dumped:** 2026-08-20 from `https://setting.easymed.uz`
**Source last modified:** 2026-07-18
**Status:** live vendor console, currently in production. **This is a read-only reference copy.**
Editing files here changes nothing on the live site.

---

## What this is

The vendor-side console for the **cloud** Easy-Med SaaS. It is gated to `super_admin` users and
reads live data straight from Supabase with the signed-in user's JWT (super admins bypass RLS via
`current_user_is_super_admin()` in the policies).

Vanilla ES modules, no build step — the same house style as the clinic app.

**5,204 lines across 19 modules.**

| View | Lines | What it does |
|---|---:|---|
| `setting.js` | 710 | Boot, multi-tab shell, view registry, sidebar |
| `views/settings.js` | 815 | Platform settings hub |
| `views/platform-team.js` | 380 | Vendor staff accounts |
| `views/support.js` | 382 | Support tickets |
| `views/payments.js` | 318 | Payment records |
| `views/service-catalog.js` | 313 | Shared medcore services catalogue |
| `views/users.js` | 258 | All users across all clinics |
| `views/tariffs.js` | 241 | Plan definitions and pricing |
| `views/dashboard.js` | 237 | KPI counts |
| `views/verifications.js` | 231 | Clinic licence-document review |
| `views/signup-requests.js` | 225 | New-clinic applications |
| `views/clinics.js` | 223 | Clinic list, change plan, suspend, reactivate |
| `views/refdata.js` | 193 | Countries / regions / districts |
| `views/service-requests.js` | 190 | Clinic requests for new catalogue services |
| `views/upgrade-requests.js` | 180 | **Clinics asking to upgrade their plan** |
| `views/symptex-clinics.js` | 129 | Which clinics are published to Symptex |
| `views/audit.js` | 98 | Audit trail |
| `gateway.js` | 16 | Calls the FastAPI gateway at `/api/v1` with the Supabase JWT |

## What is deliberately NOT here

`js/config.js` — it holds `SUPABASE_URL` and `SUPABASE_ANON_KEY`. It was never downloaded and must
never be committed. The dump therefore does not run as-is, which is intentional: this is reference
material, not a deployable copy.

---

## The finding that matters for licensing

**This console has no feature or module entitlement machinery whatsoever.** That was checked
directly, not assumed — a search across all 19 modules for `modules`, `entitle`, `licen`,
`feature_flags` returns nothing relevant.

What it actually has is a **single plan string per clinic**:

```js
// views/clinics.js:63
.select('id, name, slug, plan, trial_ends_at, is_active, active, created_at, email, phone')

// plan ∈ trial | starter | growth | enterprise | suspended
```

and suspension is one column write:

```js
// views/clinics.js:147
if (act === 'suspend') return updatePlan(c, { plan: 'suspended', is_active: false }, …);
```

`tariffs.features` looks promising until you read it — it is an array of **marketing bullet
points** for the pricing page (`"Up to 3 users"`, `"1 branch"`), typed into a textarea. It is not
machine-readable and nothing enforces it.

### Why that works today and cannot work for local installs

The cloud console can enforce a subscription by writing one column because **the database belongs
to the vendor**. Supabase RLS reads `is_active` and the clinic simply stops working.

A local install has none of that. Its SQLite file sits on the clinic's own PC, behind their own
router, often with no internet. There is no column for the vendor to flip.

That gap is the entire reason for the signed-licence design in
`docs/specs/2026-08-20-control-plane-design.md`. The two enforcement models are genuinely
different and both are needed while cloud and local clinics coexist.

---

## What to reuse, and what still has to be built

**Reuse — this is real, working, production-tested code:**

- the console shell, multi-tab UX, sidebar and CSS (285 lines)
- super-admin auth gating
- `clinics` / `companies` as the clinic registry
- `tariffs` as the pricing presets — a "tier" in the new design is exactly a saved preset
- `upgrade_requests` — **the "clinic asks for more" inbox already exists**, with
  `clinic_name, manager_name, phone, requested_plan, message, status, reviewed_at, review_notes`.
  The «Подключить модуль» button in the new locked-module screen should feed this table rather
  than inventing a second inbox.
- `payments`, `support`, `verifications`, `audit`

**Still to be built (none of this exists):**

| Needed | Exists? |
|---|---|
| Machine-readable per-clinic module entitlements | No |
| Ed25519 licence signing service | No |
| Clinic enrollment / install identity | No |
| A check-in endpoint local installs can call | No |
| Installed-version tracking | No |
| Release distribution and rollout rings | No |
| Non-PII statistics from local installs | No |

## Consequence for the design

Spec §8 assumed the vendor panel would be built from scratch. It should not be — this console is
the panel, and the work is **extending it**, which is cheaper and keeps one place for the vendor
to look.

But spec §1's reasoning still stands and is now sharper: this console is Supabase-backed and
behind the same Cloudflare and gateway estate that hung twice in August 2026. The **licence
signing key and the check-in endpoint must not live inside it.** The console is the user
interface; a small, boring, independent service holds the key and answers check-ins. If the
console is down, the vendor cannot administer clinics for an hour — annoying. If the check-in
endpoint is down, every clinic in the country starts a 14-day countdown.

Split them.
