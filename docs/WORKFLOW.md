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
                                                    9. the SAME CI run uploads it here
                                                       and publishes it to EVERY clinic
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

`npm start` keeps running until you stop it, and **closing the terminal window does not
stop it.** node stays alive in the background still holding port 8000, so the next start
dies with "port 8000 is already in use" — and by then there is no window left to close.
This has cost real time twice. Stop it with `Ctrl+C` in its window, or, once that window
is gone, run `stop-easymed.bat` (it only ever stops a *node* process on that port, never
whatever else might be using it).

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
- At the chosen hour, in the clinic's own Node process: download → verify signature
  **before** unpacking → unpack beside the running version → database snapshot →
  repoint the `current` junction → restart onto the new version, reported on the next
  check-in. No PowerShell, no service, no administrator rights.
- **If a release goes wrong, the previous version is still on that PC.** `recover.cmd`,
  next to `EasyMed.exe`, is a double-click that points the clinic back at it. There is
  no automatic rollback any more: the old one health-checked the OLD process on a
  launcher install, so it vouched for switches it had never verified.
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

A push to `main` puts code on GitHub. **No clinic can see it yet.** A change reaches
clinics after exactly one more deliberate act: **the owner tags a release.** That one
act now does everything — CI runs the suite, signs the bundle, attaches it to a GitHub
Release, uploads it to `settings.easymed.uz` and publishes it to every clinic. There is
no second manual step in which someone could have a change of heart.

**The standing rule for anyone (or any AI assistant) working in this repo:**

> After pushing changes to GitHub — STOP and ASK the owner:
> *"Push is done. Should I make this a release and make it available to the clinics?"*
> Never tag without the owner saying yes to that specific version. **The tag is the
> release** — after it is pushed there is nothing left to reconsider.

What the owner's "yes" sets in motion:

1. Owner says yes → tag `vX.Y.Z` → CI builds, signs, and publishes it to every clinic.
   (There is no manual pre-tag gate any more: since 2026-08-24 the apply step is
   ordinary Node and CI runs the real thing — CONTRIBUTING.md.)
2. Restart the test clinic's Easy-Med window. Check-in runs ~60 seconds after boot,
   so the offer appears in «Обновления» within a minute or two — the same offer every
   other clinic is now seeing.
3. Confirm the update there, pick the nearest hour. The clinic switches and restarts
   itself; the window reappears on the new version within seconds.
4. Owner clicks through the changed screens on the test clinic. **Do this promptly** —
   real clinics are being offered the same version, and each one installs when its own
   admin consents.
5. If it misbehaves: two reported failures halt it automatically for everyone who has
   not installed yet, and the owner can halt it by hand in the panel at any time. A
   clinic that has not consented never installed anything.

## Status of the machinery (2026-08-23)

| Piece | State |
|---|---|
| Steps 1–6 (git + PR discipline) | in daily use — repo `sadyko/easymed-local`, both machines pushing |
| Bundle builder, CI on tag, rings, clinic updater, consent screen | **built**; v0.1.x releases shipped through the full pipeline |
| Everything the update rides on (licensing, check-in, versioned install, rollback) | **built and tested** |
| Test clinic (`easymed.clinic`, EasyMed.exe package) | built 2026-08-23 — the proving ground for every release |

The whole pipeline is real end to end. The remaining discipline is human: sync first,
push, and never skip the release gate above.
