# Cutting a release

This is the maintainer's runbook — the exact steps to turn code on `main` into a
signed update every clinic can eventually receive. For the big picture (who does
what, from a code change to a clinic's screen), see `docs/WORKFLOW.md`. This
document is the detail behind steps 7–9 of that picture: tagging, and what
happens after you push the tag.

**You do not need to read `.github/workflows/release.yml` to cut a release.**
This document is written so you never have to.

---

## One-time setup

Do this once, before the first release is ever cut. If it's already done, skip to
"Cutting a release" below.

### 1. Generate the release signing key — a SEPARATE key from the licence key

Easy-Med Local already has one signing key: `vendor-private.pem`, which licenses
clinics (`node scripts/make-licence.mjs keygen`). **The release key must be a
different key.** If the same key signed both licences and releases, anyone who
stole the CI secret below — a build machine is exactly the kind of thing that
gets compromised first — could not only forge a fake update, they could license
themselves a clinic for free, forever, with no way for you to revoke it. Two
keys means a leaked release key only lets someone forge an update bundle, which
still has to pass every other control in this system (ring publishing, an
admin's explicit consent, a health-checked install) before it could ever reach
a real clinic.

The licence tool's `keygen` command is reused to make this key too — it is the
same Ed25519 mechanism, it just needs to end up as a different file:

1. In an empty temporary folder (**not** inside this repository, so there is no
   chance of it landing next to, or overwriting, the real `vendor-private.pem`):

   ```
   node <path-to-repo>/scripts/make-licence.mjs keygen
   ```

   This always writes a file literally named `vendor-private.pem` — that name is
   fixed by the tool, which was built for the licence key. That's fine; the next
   step is exactly why the temp folder was empty.

2. Rename it immediately, before it can be confused with anything:

   ```
   mv vendor-private.pem easymed-release-private.pem
   ```

3. The command also printed a **public** key. Save that output somewhere safe —
   a later task (the clinic's own updater) will need to hard-code it the same
   way `VENDOR_PUBLIC_KEY_PEM` is hard-coded in
   `server/services/control/licence.js` today. Until that exists, keep the
   printed public key wherever you keep other release records.

4. On GitHub: repository → **Settings → Secrets and variables → Actions → New
   repository secret**.
   - Name: `EASYMED_RELEASE_KEY`
   - Value: the full contents of `easymed-release-private.pem`, including the
     `-----BEGIN PRIVATE KEY-----` / `-----END-----` lines.

5. Delete the local copy of `easymed-release-private.pem` and the temp folder
   once the secret is saved. Back the key up offline, in two places, exactly
   like `vendor-private.pem` — and never put it on a clinic machine. If it is
   lost, no future release can be signed under it, and every clinic's trusted
   public key would need replacing to move to a new one; there is no
   in-place recovery.

### 2. Restrict `v*` tags to you

If this repository was set up following `docs/ONBOARDING.md`, this is already
done (§1, step 3): a tag ruleset on `v*` restricted to the owner. Confirm it
under **Settings → Rules → Rulesets**. Without it, a colleague's push could tag
a release — the entire point of "tagging is a separate, deliberate act from
pushing" (see `docs/WORKFLOW.md`) depends on this ruleset actually existing.

### 3. Confirm the version floor

`release.config.json` at the repository root holds the oldest installed version
a build is allowed to update:

```json
{ "min_from": "0.1.0" }
```

This is deliberately a file you can see in a diff and review, not a default
buried in the workflow — a floor nobody consciously chose is a floor nobody can
be sure is safe. Raise it only when you are certain no clinic still needs to
cross whatever migrations lie below the new number.

---

## Cutting a release

Every time, in this order:

1. **Get the latest, and prove it's green:**

   ```
   git switch main && git pull
   npm test
   ```

   Do not tag on top of a suite you have not personally watched pass.

2. **Bump the version, in its own commit** — nothing else in that commit:

   ```json
   // package.json
   "version": "2.4.0",
   ```

   ```
   git add package.json
   git commit -m "chore: version 2.4.0"
   git push
   ```

3. **Write `RELEASE_NOTES.md` at the repository root — in Russian, for the
   clinic manager who will read it, not for another developer.**

   Say what changed for them, in their words:

   ```
   Печать направлений больше не обрывается.
   Список чатов открывается быстрее.
   ```

   Never write something like `"fixed null pointer in doc-render"` — a clinic
   manager has no use for that sentence, and it will be shown to them verbatim
   on the update-approval screen once that screen exists (Plan 4, Task 6).

   Commit it:

   ```
   git add RELEASE_NOTES.md
   git commit -m "docs: release notes for 2.4.0"
   git push
   ```

4. **Tag exactly the commit you just tested and pushed, and push the tag:**

   ```
   git tag v2.4.0
   git push origin v2.4.0
   ```

   The tag's version number **must** match `package.json`'s, with the leading
   `v` being the only difference — CI refuses the release otherwise
   (`scripts/check-tag-version.mjs`, step 3 below). This is not a formality:
   without it, "which version is that clinic running?" stops having an answer.

5. **Watch it build:** GitHub → **Actions**. The `Release` workflow runs:
   - checks the tag is really on `main` (never a stray branch);
   - installs dependencies and runs the full test suite (one automatic retry —
     see "If the suite fails" below);
   - checks the tag against `package.json` again, server-side, so a mismatch
     can never slip past a local mistake;
   - builds and signs the bundle with `EASYMED_RELEASE_KEY`;
   - publishes a GitHub Release with the bundle, its manifest, and your
     `RELEASE_NOTES.md` attached.

   A green run means a signed release now exists. Nothing has reached a clinic
   yet — GitHub is the build system, not the distribution channel.

6. **Publish it to ring 0** in the `settings.easymed.uz` panel (the
   control-plane side of this project, built separately — see
   `docs/plans/2026-08-20-update-delivery.md`, Task 3). Ring 0 is your own
   install; only after it looks right there do you promote the release to
   ring 1 (a couple of friendly clinics) and then ring 2 (everyone). Nothing
   in `.github/workflows/release.yml` does this step for you — publishing to a
   ring is a separate, deliberate decision, same reasoning as tagging being
   separate from pushing.

---

## If something goes wrong

### You tagged and pushed, but forgot to write `RELEASE_NOTES.md`

The workflow does **not** fail. It prints a loud warning in the Actions log and
publishes the GitHub Release with `--generate-notes` instead — GitHub's own
auto-generated notes, which is to say: a list of commit titles and PR numbers,
in whatever language your commit messages happen to be in. **That is not
clinic-facing text**, and if Task 6's approval screen goes live before you fix
it, a clinic admin will see raw commit titles instead of Russian.

This was a deliberate choice, not an oversight: refusing the whole release over
missing prose would block a real code fix — the reason you're releasing at
all — behind a writing task, which is a worse failure mode than a badly-worded
release. The fix is cheap and safe:

- The **GitHub Release's description** can be edited directly afterward (Edit
  release, in the GitHub UI) — this touches only display text, never the signed
  bundle or manifest, so there is no risk in fixing it late.
- The bundle's own `notes_ru` field (what the approval screen will eventually
  show) is baked into the signed manifest and **cannot** be edited after the
  fact — fixing that requires cutting a new release. So: the safety net exists,
  but write the notes before tagging anyway.

### You re-run the workflow after fixing something

`gh release create` refuses if a release for that tag already exists. The
workflow handles this itself: if it finds an existing release for the tag it is
about to publish, it deletes that release first (never the tag — the workflow
only ever deletes the *release*, and does so explicitly without
`--cleanup-tag`) and recreates it. A re-run behaves like a first run. You do not
need to delete anything by hand before re-running.

### The signing key secret is empty, missing, or wrong

The build step checks for this before it does anything else and fails with a
plain `EASYMED_RELEASE_KEY secret is empty or not set` — it will never silently
sign a bundle with nothing. If the key file itself is present but not a real
Ed25519 private key, `scripts/build-bundle.mjs` fails with its own plain
message instead of a stack trace. Either way: check the secret under
**Settings → Secrets and variables → Actions**, re-paste it if needed
(including the `BEGIN`/`END` lines), and re-run.

### The suite fails

`npm test` runs once, and if it fails, once more, printing a loud warning
before the retry. This project's own known flake is ephemeral-port errors that
should not occur on a single Linux CI runner the way they do on a shared
Windows dev machine — but if the warning appears, do not assume it was "just
the flake." Open the log above it and read what actually failed before trusting
the release that follows. If the retry also fails, the release is refused —
there is no second retry.

### The tag isn't on `main`

The workflow refuses before installing anything, with a clear error naming the
tag and commit. This happens if a tag was made on a branch that was never
merged, or on an old `main` before a later merge. Delete the tag
(`git push --delete origin vX.Y.Z` and `git tag -d vX.Y.Z`), make sure `main` has
what you meant to ship, and tag again from an up-to-date `main`.
