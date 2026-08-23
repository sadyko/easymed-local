<!-- The standard form (CONTRIBUTING.md). Every box, every PR. -->

## What changed, for a human

<!-- One or two sentences. If a clinic admin will see it, say what THEY see. -->

## The standard-form checklist

- [ ] Started from a fresh `git switch main && git pull` (sync-first — 2–3 machines push here)
- [ ] `npm test` ends **fail 0** (the known port-flake re-run note in CLAUDE.md applies)
- [ ] I read my own `git diff` — no `data/`, no `*.db`, no keys, no secrets, nothing unexpected
- [ ] UI strings go through `tr()` with ru/uz/en entries; icons from `icons.js`; **no emojis**
- [ ] New comments say **why** the line exists, not what it does
- [ ] **No version bump, no tag, no RELEASE_NOTES.md edit in this PR** — releasing is the owner's separate act (CONTRIBUTING.md steps 7–10)

## If this should reach clinics

Nothing in this PR ships by merging. Say here if you think it deserves a release,
and the owner decides: test clinic first, widen only after it looks right there.
