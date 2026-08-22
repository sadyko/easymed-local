# Setting up a second development computer

For a colleague joining development of Easy-Med Local. One-time setup, ~20 minutes.
The workflow at the end is the rule, not a suggestion: **`main` is what ships to clinics.**

## 1. What the owner does first (once, in the browser)

1. On GitHub: repository → **Settings → Collaborators → Add people** → the colleague's
   GitHub username → role **Write**. They accept the email invite.
2. **Settings → Rules → Rulesets → New branch ruleset** targeting `main`:
   tick *Require a pull request before merging*. Now nobody — including the owner —
   pushes to `main` directly; everything arrives by reviewed PR.
3. A second ruleset for **tags** matching `v*`, restricted to the owner. A push can
   never reach a clinic; only a tag can — and only the owner can tag.

## 2. What the colleague installs

- **Git for Windows** (gitforwindows.org) — accept the defaults; they include the
  Credential Manager, which handles GitHub login.
- **Node.js 24** (nodejs.org). Check: `node --version` → v24.x.

## 3. Getting the code

```
git clone https://github.com/sadyko/easymed-local.git
cd easymed-local
npm ci --ignore-scripts
npm test
```

**`--ignore-scripts` is not optional.** A plain `npm install` tries to compile
better-sqlite3 from source and fails on any machine without Visual Studio build
tools. `npm ci --ignore-scripts` uses the prebuilt Windows binary and needs
internet only this once.

`npm test` should end with **0 failing** (1,600+ tests). Known quirk: roughly one
full run in three shows 2–3 `fetch failed / bad port` errors in tests that bind
network ports. That is a Windows port-allocation flake, not a real failure —
re-run; only assertion failures are real.

Then `npm start` → http://localhost:8000. First run creates an empty database and
prints a one-time admin password.

## 4. How pushing works with your own GitHub account

Nothing to configure. **The first time you push, a browser window opens — sign in
with YOUR GitHub account.** Git Credential Manager (installed with Git) stores the
token; you are never asked again. Never share tokens or accounts between people —
each person authenticates as themselves, which is also what makes the history's
"who changed this" mean something.

**Two accounts on ONE machine** (e.g. the owner also has a work account): pin the
account per repository so the credential manager stops guessing:

```
git config credential.username THE-ACCOUNT-FOR-THIS-REPO
```

## 5. The working rules

1. **Never commit to `main`.** Branch (`git switch -c fix/lab-print`), commit, push,
   open a Pull Request. The ruleset enforces this even if you forget.
2. **Run `npm test` before every push.** A red suite in a PR wastes the reviewer's
   time; a red suite in a release is blocked by CI anyway.
3. **Releases are tags, and only the owner tags.** Merging a PR ships nothing.
   `v2.4.0` on `main` is what starts the build that clinics are eventually offered.
4. **Never commit anything from `data/`** — it is gitignored because it holds real
   clinic records on development machines. If `git status` ever shows a `.db` file,
   stop and ask.
5. The comment style in this codebase explains *why a line exists* — usually the
   bug that forced it. Keep writing them that way; they are the project's memory.

## 6. What a clinic never has

No clinic machine has Git, a GitHub account, or this repository. Clinics receive
signed, built packages through the vendor's own infrastructure, with the admin's
consent, on the clinic's schedule. If you find yourself typing `git` on a clinic
PC, something has gone wrong.
