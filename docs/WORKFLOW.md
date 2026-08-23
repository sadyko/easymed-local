# The workflow: dev → GitHub → clinics

The whole path a change travels, from an edit in the dev folder to a clinic running it.
Two people develop; **only the owner can ship.** Clinics never see GitHub.

```
 you / colleague          GitHub                    settings.easymed.uz          clinic PC
 ───────────────          ──────                    ───────────────────          ─────────
 1. pull latest
 2. branch + edit
 3. test locally
 4. push branch ───────►  5. Pull Request
                          6. review + merge to main
                          7. owner tags v2.4.0 ──►  8. CI builds + signs bundle
                                                    9. vendor publishes to a ring
                                                   10. clinic's daily check-in ──►  sees the offer
                                                                                   11. admin confirms
                                                                                       + picks the hour
                                                                                   12. installs at that hour,
                                                                                       rolls back if unwell
```

## The daily loop (steps 1–4) — both developers

**1. Read what is on GitHub before you change anything.** This is the step that prevents
two people silently diverging:

    git switch main
    git pull

If the pull brings changes, run `npm test` once before building on top of them.

**2. Branch — never work on `main`:**

    git switch -c fix/lab-print-cutoff

**3. Make the change, then confirm it:**

    npm test        # must end 0 failing (the port-flake note in CLAUDE.md applies)
    npm start       # look at the actual screen you changed

**4. Review your own diff before pushing — confirm the changes are only what you meant:**

    git status      # nothing unexpected? no data/, no *.db, no keys?
    git diff        # read it. If a hunk surprises you, so will it surprise the reviewer.
    git push -u origin fix/lab-print-cutoff

Then open the Pull Request on GitHub. The other person reads it and merges. The ruleset
blocks direct pushes to `main`, so this order is enforced, not just agreed.

## Releasing (steps 7–9) — owner only

Merging a PR ships **nothing**. A clinic can only ever receive a tagged release:

    git switch main && git pull
    npm test                                  # green before you tag, every time
    # bump "version" in package.json in its own commit if not already done
    git tag v2.4.0
    git push origin v2.4.0

CI then builds the signed bundle (`scripts/build-bundle.mjs` — Ed25519, allow-listed
contents, a leak test proving no database or key can be inside). The tag ruleset means
only the owner can do this; a colleague's push can never reach a clinic.

Release notes are written for the clinic manager who reads them in the update dialog:
`"Печать направлений больше не обрывается"` — never `"fixed null pointer in doc-render"`.

## What the clinic sees (steps 10–12)

- Its daily check-in to settings.easymed.uz returns the offer for its ring.
- The admin sees the version, the notes, and **one action that includes the time**:
  tonight at 03:00 by default, tomorrow night, or any hour they pick. Nothing installs
  without that consent — there is no forced channel.
- At the chosen hour: download → verify signature **before** unpacking → database
  backed up → version switched → health check → **automatic rollback to the previous
  version if the health check fails**, reported on the next check-in.
- A clinic that never confirms simply keeps running its current version, forever.

## The owner's machine: two folders, two roles

```
Desktop\implementation workflow\
├─ easymed.local     THE DEV SERVER — every change is made and tested HERE (:8000)
└─ easymed.clinic    THE TEST CLINIC — a real clinic package (EasyMed.exe), :8712
                     pinned by its port.txt so it can never take dev's port.
                     Receives changes ONLY as signed releases, like a real
                     clinic would. It has no git. Never edit files in it —
                     the next update would silently overwrite them.
```

Why this design: **two or three machines push to this GitHub repo.** If anyone edits
without pulling first, two versions of the truth diverge and someone's work gets lost in
a merge. So the iron ordering is: *sync from GitHub → change in dev → test in dev →
push to GitHub → only then think about clinics.*

## Pushing is not releasing — the gate

A push to `main` puts code on GitHub. **No clinic can see it yet.** A change only
reaches clinics after two more deliberate acts: the owner tags a release (CI builds and
signs the bundle) and the vendor publishes it to a ring in the panel.

**The standing rule for anyone (or any AI assistant) working in this repo:**

> After pushing changes to GitHub — STOP and ASK the owner:
> *"Push is done. Should I make this a release and make it available to the clinics?"*
> Never tag, never publish a ring, never touch the panel's releases page without the
> owner saying yes to that specific version.

The owner's answer usually follows this test loop:

1. Owner says yes → tag `vX.Y.Z` → CI builds the signed bundle → publish in the panel
   **to the test ring only** (the test clinic `easymed.clinic`).
2. Restart the test clinic's Easy-Med window. Check-in runs ~60 seconds after boot,
   so the offer appears in «Обновления» within a minute or two.
3. Confirm the update there, pick the nearest hour. After it applies, close and reopen
   the window (launcher installs pick up the new version on restart — HANDOVER §7).
4. Owner clicks through the changed screens on the test clinic.
5. Only when the test clinic looks right does the owner widen the release to the real
   clinic rings. A release that misbehaves is simply never widened — real clinics keep
   their current version.

## Status of the machinery (2026-08-23)

| Piece | State |
|---|---|
| Steps 1–6 (git + PR discipline) | in daily use — repo `sadyko/easymed-local`, both machines pushing |
| Bundle builder, CI on tag, rings, clinic updater, consent screen | **built**; v0.1.x releases shipped through the full pipeline |
| Everything the update rides on (licensing, check-in, versioned install, rollback) | **built and tested** |
| Test clinic (`easymed.clinic`, EasyMed.exe package) | built 2026-08-23 — the proving ground for every release |

The whole pipeline is real end to end. The remaining discipline is human: sync first,
push, and never skip the release gate above.
