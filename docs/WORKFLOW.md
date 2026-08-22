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

## Status of the machinery (2026-08-22)

| Piece | State |
|---|---|
| Steps 1–6 (git + PR discipline) | ready the moment the `easymed-local` repo exists |
| Bundle builder | in progress (Plan 4 Task 1) |
| CI on tag, distribution, rings, clinic updater, consent screen | Plan 4 Tasks 2–6, not yet built |
| Everything the update rides on (licensing, check-in, versioned install, rollback) | **built and tested** |

Until Plan 4 completes, the pipeline's front half (dev → PR → merge → tag) is real and
should be used from day one; the back half (clinic receives it) is the remaining work.
