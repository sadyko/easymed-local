# Easy-Med Control Plane

The vendor's service at `settings.easymed.uz`. It replaces the current process
of issuing licences with a command-line tool and hand-delivering them on a USB
stick: clinics call in once a day, this service tells them what they're
entitled to and for how long, and it is where the owner will (in later tasks)
turn modules on and off, set a paid-until date, and see who has asked for
what.

It holds **no patient data of any kind**. It is the vendor's registry of
clinics — who they are, what they're entitled to, when they last checked in —
never anything a clinic's patients did. See the schema comments in
`server/db/migrations/001_registry.sql` for why that boundary is treated as
load-bearing rather than incidental.

## Why this is a separate top-level directory, not part of the clinic app

`control-plane/` deploys to a different machine, for a different audience
(vendor staff, not clinic staff), on a different lifecycle (the vendor
upgrades it whenever; a clinic upgrades on its own schedule, often much
later). It is versioned in the **same repository** as the clinic app,
deliberately, because the licence format is a contract between the two: the
clinic's verifier (`server/services/control/licence.js`) and the vendor's
signer (`control-plane/server/services/signing.js`, added in a later task)
must agree forever about what a valid licence looks like. Keeping both in one
repo is what makes that agreement testable — a change to one side can import
and exercise the other side directly in a test, across the directory
boundary, instead of trusting that two deployed services happen to agree.

## Dependencies: this directory borrows the parent's `node_modules`

`control-plane/package.json` declares the same three dependencies as the
clinic app (`better-sqlite3`, `express`, `bcryptjs`) so the file is truthful
about what the service actually needs to run — but **do not run `npm
install` inside `control-plane/` during development in this repo layout**.

Node's module resolution walks **up** the directory tree looking for
`node_modules`, so `import Database from 'better-sqlite3'` inside
`control-plane/server/db/connection.js` resolves to
`easymed.local/node_modules/better-sqlite3` automatically, without a
`control-plane/node_modules` ever existing. This was verified directly: a
throwaway script placed at `control-plane/server/db/` importing
`better-sqlite3` and opening an in-memory database ran successfully with no
local `node_modules` present anywhere under `control-plane/`.

This matters because `npm install` on this machine tries to compile
`better-sqlite3` from source and fails — there are no Visual Studio build
tools installed here. Borrowing the parent's already-built native module
sidesteps that entirely for local development and for `npm test` run from
the repository root (which is how the control-plane tests are actually
exercised day to day, since the root test script auto-discovers
`*.test.js` everywhere, including here).

**This does not hold once the directory is deployed on its own.** When
`control-plane/` is copied to a separate machine (or otherwise separated
from `easymed.local`'s `node_modules`), it needs its own, real `npm install`
run on a machine that can build `better-sqlite3` from source (or an
`npm ci` against a prebuilt/cached native binary for that machine's Node
ABI). The declared dependencies in `control-plane/package.json` are exactly
what that install needs — that's the point of declaring them truthfully even
though they currently resolve from elsewhere.

## Why this must not live behind the EasyMed CORE gateway

The EasyMed CORE gateway hung twice in August 2026 and took `symptex.uz` down
with it both times (see the circuit breaker fix that followed). That gateway
is a shared, general-purpose piece of infrastructure with its own failure
modes, unrelated to this service's job.

Every clinic holds a licence that is valid for 14 more days at all times, on
the design principle that a day of the control plane being unreachable must
be invisible to a clinic. That guarantee only holds if check-in is reachable
independently of everything else that can go wrong on shared infrastructure.
If the control plane sat behind the CORE gateway and the gateway hung the way
it did in August, check-in would go down for every clinic in the country at
once — and unlike a single clinic's own outage, that would start every
clinic's 14-day countdown on the same day, turning one infrastructure
incident into a nationwide deadline. That is a materially worse failure than
anything this service could cause on its own.

**Do not consolidate this behind the CORE gateway for tidiness.** It must
keep its own, independent path to the internet.

## Serving releases (`/releases/`) — what the vendor server must provide

Since AUTO_ROLLOUT_V1, GitHub Actions posts each signed bundle to
`POST /cp/v1/deploy/release` (bearer token, publish-only — see
`server/routes/deploy.js` for why CI pushes here rather than this server
pulling from GitHub). This service writes the `.tar.gz` to disk and registers
the release at ring 2, so every clinic is offered it at its next check-in.

**It does not serve those files.** Clinics download
`/releases/<version>/easymed-<version>.tar.gz` from `settings.easymed.uz` as an
ordinary static file, and the clinic updater refuses any URL that leaves that
origin (`server/services/control/updater.js`). So nginx must serve
`EASYMED_CP_RELEASES_DIR` at `/releases/` — read-only, no directory listing. If
that `location` and this env var ever disagree, clinics are offered a URL that
404s, and the symptom shows up at the clinics, not here.

| Variable | Default | Notes |
|---|---|---|
| `EASYMED_CP_DEPLOY_TOKEN` | none | Without it the endpoint answers 404 and is invisible. Minimum 32 characters; a shorter one is ignored, with a loud line in the log |
| `EASYMED_CP_RELEASES_DIR` | `control-plane/releases` | Must match the nginx `location /releases/`. Writable by this service, readable by nginx |
| `EASYMED_CP_RELEASES_URL_BASE` | `/releases` | Only if nginx serves that directory at some other path |
| `EASYMED_CP_MAX_BUNDLE_BYTES` | 32 MB | The largest bundle accepted |

## The branch-sync relay (`/cp/v1/relay/:relayId`) — bytes this service cannot read

BRANCH_SYNC_RELAY_V1. A clinic with two branches on unrelated internet
connections cannot sync them directly (Route A), so the main branch PUTs an
encrypted catalogue here and the other branch GETs it. One blob per branch
group, replaced wholesale, never parsed.

**This service cannot decrypt what it stores, and no change may make it able
to.** The key is AES-256, generated inside the clinic when it is activated
(`server/services/branch-sync/sync-group.js`), and reaches the second branch
only inside the pairing key the owner carries by hand. It is never sent to this
server — not at enrollment, not at check-in, never.

The consequence has to be said out loud, because a clinic will eventually ask:
**if a clinic loses its key, nobody can recover that data, including us.** The
clinic's own screen says so before the owner turns the fallback on.

What this server does learn: which install uploaded or downloaded, when, how
many bytes, and that some set of installs share one relay id. Nothing about
services, prices, patients or money.

Authentication is the clinic's `install_token` — the same credential the daily
check-in presents, looked up the same way, with the same single generic 401 for
missing, malformed, unknown and deactivated. Mounted above the 100kb JSON
parser (like `/cp/v1/deploy`) because the body is megabytes and the router
authenticates before it buffers a byte.

Nothing needs to be configured for it to work; it stores blobs in the registry
database (migration `005_relay_blobs.sql`), not on disk, so there is no nginx
`location` to keep in step.

| Variable | Default | Notes |
|---|---|---|
| `EASYMED_CP_MAX_RELAY_BYTES` | 12 MB | The largest encrypted catalogue accepted |
| `EASYMED_CP_RELAY_RETENTION_DAYS` | 30 | A blob untouched (neither uploaded nor downloaded) for this long is deleted. Swept on every upload — there is no scheduler |

## Development

From the repository root:

```
npm test
```

This discovers and runs `control-plane/**/*.test.js` alongside the clinic
app's own tests, using the root `package.json`'s test script
(`node --experimental-vm-modules --test`). There is no need to `cd` into
`control-plane/` or install anything separately for this.

The `test` script in `control-plane/package.json` is declared for when this
directory is deployed and tested standalone — see the dependencies note
above for what that requires first.
