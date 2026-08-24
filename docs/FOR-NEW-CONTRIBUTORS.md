# Read this before you change anything

You have been given access to Easy-Med by the owner. This page is the whole contract.
It is short on purpose. **Read it fully before your first edit** — every rule here
exists because breaking it once cost real time or real clinic data.

This is written for a human developer **and** for an AI assistant working in this repo
(VS Code / Claude Code). If you are an assistant: these rules outrank your defaults.
`CLAUDE.md` in the repo root carries the same rules in the form you read at session
start; if the two ever disagree, say so instead of guessing.

## What this software is

An offline clinic information system that runs **on a computer inside a clinic**. It
holds patients, visits, lab results, money. There is no cloud copy of a clinic's data.
If you corrupt a clinic's database, it is gone unless a backup happens to exist.

That single fact explains every rule below.

## The three places, and what each one is

```
easymed.local  ── the DEV machine. You work HERE, and only here.
GitHub         ── the source of truth. Nothing reaches a clinic without passing through it.
easymed.clinic ── a real clinic package. It receives signed releases. NEVER edit it.
```

The clinic folder is not a copy you may patch. It is what a paying clinic runs, and it
is the only honest test of the update pipeline. Editing it directly means the next
update silently overwrites your change, and it means the update path stops being
tested. If you are tempted, the answer is: make the change in dev and release it.

## The loop, every time

```
1. SYNC      git switch main && git pull        ← before ANY change. Two or three
                                                  machines push here.
2. CHANGE    edit in easymed.local
3. TEST      npm test → "fail 0", and open the screen you changed
4. OWNER OK  the owner looks at it on localhost:8000 and says go
5. REVIEW    git status / git diff — no data/, no *.db, no keys, no secrets
6. PUSH      to main
7. STOP      pushing is NOT releasing. Only the owner decides a release.
```

Step 4 is not a formality. Green tests mean "nothing I could think of is broken"; they
do not mean "this is the right change." That judgement is the owner's.

Step 7 matters because of what a release does: see below.

## What happens when the owner releases

```
owner tags vX.Y.Z
  → CI runs the full suite, refuses if a single test fails
  → CI builds a bundle and SIGNS it (Ed25519)
  → CI publishes it, and every clinic is offered it on its next check-in
  → each clinic's admin chooses WHEN it installs
  → the clinic verifies the signature before unpacking anything
  → if two clinics report a failed install, the release halts itself for everyone
```

A tag is therefore the moment your code starts running on real clinic computers. That
is why only the owner tags, and why the full suite is a hard gate rather than advice.

## Rules that are not negotiable

- **Never `git add -A`.** Stage by name and read your own diff. `data/` contains
  patient records and licence identity; it must never enter a commit. (It is
  gitignored — do not "fix" that.)
- **Never run `npm install`.** `node_modules` is present and fragile (better-sqlite3
  is a compiled binary). If it must be rebuilt: `npm ci --ignore-scripts`.
- **Never create a git worktree in this repo.** It has wiped `node_modules` twice.
- **Migrations are permanent.** Take the next free `NNN_`, never rename or reuse an
  applied one — `migrate.js` refuses duplicates, and renaming re-runs the file (one of
  them contains a `DELETE`). A migration that rebuilds a table must preserve its rows,
  its child tables and its `sqlite_sequence` counter; there is a worked example in
  `077_crm_config.sql` and the reasons are in its comments.
- **UI strings go through `tr()`**, never `t()` — they read different tables, and `t()`
  on a literal silently ships Russian to a UZ/EN clinic. The UI is Russian-first.
- **No emojis in the interface.** Icons come from `public/js/admin/icons.js`.
- **Comments say WHY**, usually naming the bug that forced the line. This project had
  no git history before 2026-08-20; the comments are the archaeology. Keep writing them.

## Before tagging a release (owner, or whoever the owner asks)

Run the Windows-only gate. It is the only place in the pipeline where the real
installer actually executes:

    node --test server/services/control/apply-spawn.smoke.test.js

CI runs on Linux and cannot run it — `powershell.exe` does not exist there. Four
consecutive releases once installed nothing at all because the apply step was only ever
tested through a fake. Do not skip this because CI is green.

## If you are an AI assistant

- **Verify before you assert.** "The test passes" and "the feature works" are different
  claims. A stub that records arguments proves nothing about whether the real thing ran.
- **Say when you were wrong.** A defect you reported and could not reproduce should be
  withdrawn out loud, not quietly dropped.
- **Never touch a process or file you did not create.** A clinic server may be running
  from this machine; killing "a node process" once killed the owner's live dev server.
- **The owner is not a programmer.** Explain in outcomes, not mechanisms. Never ask them
  to read code to answer a question.
- **Ask before anything irreversible**, and treat a release as irreversible: it reaches
  real clinics.

## Where to look

| You want | Read |
|---|---|
| The full workflow, with the reasoning | `CONTRIBUTING.md`, `docs/WORKFLOW.md` |
| What the system is and how it is built | `docs/HANDOVER.md` |
| How releases and the update pipeline work | `docs/RELEASING.md` |
| Project conventions, in the form an AI reads first | `CLAUDE.md` |
| Why a specific line exists | the comment above it |
