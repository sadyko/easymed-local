# The standard form — how every change moves through this repo

Two or three machines push here. One clinic-visible mistake ships to real clinics.
So every workflow — human or AI, this machine or the colleague's — follows ONE form.
The full story is [docs/WORKFLOW.md](docs/WORKFLOW.md); this page is the contract.

## The form

```
1. SYNC        git switch main && git pull        ← before ANY change, every time
2. CHANGE      edit in the dev folder only        (the test clinic receives releases,
                                                   never edits — it has no git)
3. TEST        npm test → "fail 0"                + look at the actual screen
4. REVIEW      git status / git diff              no data/, no *.db, no keys, no secrets
5. PUSH        branch → Pull Request → merge      (see the PR checklist template)
6. STOP        pushing is NOT releasing.          Ask the owner before anything
                                                   release-shaped. Nobody tags but the owner.
```

## Releasing (owner only)

```
7. NOTES       RELEASE_NOTES.md = what the clinic admin reads, in plain Russian
               («Появился раздел…»), never developer language
8. BUMP        package.json "version" in its own commit, pushed to main
9. TAG         git tag vX.Y.Z && git push origin vX.Y.Z
               → CI runs the full suite, builds and SIGNS the bundle, attaches it
                 to a GitHub Release (tag must sit on main and match the version)
10. PUBLISH    settings.easymed.uz/cp/ → publish the release to a ring:
               TEST CLINIC FIRST, always. Widen only after the owner has clicked
               through the test clinic. A bad release is simply never widened.
11. RECEIVE    the clinic admin sees the offer (check-in ~60s after boot or the
               «Проверить обновления» button), consents, picks the hour; launcher
               installs pick up the new version on the next window restart.
```

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
