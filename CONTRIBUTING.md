# The standard form — how every change moves through this repo

Two or three machines push here. One clinic-visible mistake ships to real clinics.
So every workflow — human or AI, this machine or the colleague's — follows ONE form.
The full story is [docs/WORKFLOW.md](docs/WORKFLOW.md); this page is the contract.

**Just been given access?** Start with [docs/FOR-NEW-CONTRIBUTORS.md](docs/FOR-NEW-CONTRIBUTORS.md) — it is the short version of everything that can hurt a real clinic, written for a human developer and for an AI assistant working in this repo alike.

## The form

```
1. SYNC        git switch main && git pull        ← before ANY change, every time
2. CHANGE      edit in the dev folder only        (the test clinic receives releases,
                                                   never edits — it has no git)
3. TEST        npm test → "fail 0"                + look at the actual screen
4. OWNER OK    the owner tests it on dev          localhost:8000 - green tests are not
               (localhost:8000) and says go       the same claim as "this is right"
5. REVIEW      git status / git diff              no data/, no *.db, no keys, no secrets
6. PUSH        branch → Pull Request → merge      (see the PR checklist template)
7. STOP        pushing is NOT releasing.          Ask the owner before anything
                                                   release-shaped. Nobody tags but the owner.
```

## Releasing (owner only)

```
8. NOTES       RELEASE_NOTES.md = what the clinic admin reads, in plain Russian
               («Появился раздел…»), never developer language
9. BUMP        package.json "version" in its own commit, pushed to main
10. TAG        run the Windows gate first (see below), then
               git tag vX.Y.Z && git push origin vX.Y.Z
               → CI runs the full suite, builds and SIGNS the bundle, attaches it
                 to a GitHub Release (tag must sit on main and match the version)
11. PUBLISH    settings.easymed.uz/cp/ → publish the release to a ring:
               TEST CLINIC FIRST, always. Widen only after the owner has clicked
               through the test clinic. A bad release is simply never widened.
12. RECEIVE    the clinic admin sees the offer (check-in ~60s after boot or the
               «Проверить обновления» button), consents, picks the hour; launcher
               installs pick up the new version on the next window restart.
```

## Why the update pipeline needs a LOCAL gate (learned 2026-08-24)

For four releases no clinic update ever installed itself. Download, signature
check and unpack all worked; the final install step silently never launched
(`detached: true` on Windows = no console = powershell dies instantly). Four
separate safety nets all failed to notice, and every one of them is structural:

| Layer | Why it could not catch it |
|---|---|
| The dev folder | a git checkout is a *dev layout*: `updater.js` deliberately SKIPS the apply step there. The broken step cannot run on a developer's machine at all. |
| The test suite | every apply test injects a fake `spawn` and asserts the ARGUMENTS. "We called spawn correctly" passed forever while "the child actually ran" was never asserted. |
| CI | runs on `ubuntu-latest`. `powershell.exe` does not exist there, so the Windows-only failure mode is invisible to it by construction. |
| Ring 0 / auto-halt | halts a release after two REPORTED failures. A silent failure reports nothing, so the release looked healthy forever. (Made worse by a second bug found the same day: PowerShell writes the outcome file with a BOM, `JSON.parse` threw on it, and the clinic therefore never reported ANY outcome - the halt could never fire.) |

**So: before tagging a release, run the local Windows gate.** It is the only
place in the whole pipeline where the real installer actually executes:

    node --test server/services/control/apply-spawn.smoke.test.js

It spawns the real `apply-update.ps1` against a scratch install and asserts the
outcome file appears AND is readable by the app's own reader. It skips on
non-Windows machines - which is precisely why it cannot live in CI, and why
this line is in the instructions instead.

After publishing to the test clinic, confirm the install actually happened -
the version on screen changed, or `data\update-apply.log` says why not. Never
widen a release to real clinics on the strength of "no failures reported".

## Iron rules

- **Sync first.** Skipping step 1 is how two machines diverge and work gets lost.
- **Never `git add -A`.** Stage files by name; read the diff you are about to push.
- **`data/` never leaves the machine.** No database, no licence files, no keys in
  any commit — CI's bundle allow-list enforces this for releases, YOU enforce it
  for the repo.
- **Only a tag ships.** Merging to main ships nothing; clinics can only ever
  receive a tagged, CI-signed, ring-published release. That is why pushing is
  safe and tagging is the owner's single irreversible act.
- **Version discipline.** The tag, package.json, and RELEASE_NOTES.md move
  together in the release commit(s); CI refuses a tag that disagrees with
  package.json or sits off main.
