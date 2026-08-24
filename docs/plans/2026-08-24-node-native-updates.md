# Plan: apply updates in Node, delete the PowerShell layer

Owner (2026-08-24): «can you make easymed work like symptex project updates. its
causing so much pain in the system updating and installation.»

## The evidence

| | EasyMed | Symptex |
|---|---|---|
| Update machinery | **2,425 lines** (updater.js + 3 .ps1) | **290 lines** (updates.js + its route) |
| Releases shipped | 6, four of which needed a human mid-flight | **49** |
| Applies via | PowerShell child process | Node, in-process |

Every defect that cost this week lived in the PowerShell layer, and only there:

1. the apply step never ran — `detached: true` gives a Windows console app no console
2. the wrong port was health-checked — a script argument was never passed
3. a healthy clinic read as down — `localhost` resolving to ::1 inside PowerShell
4. the outcome file was unreadable, so auto-halt could never fire — PowerShell writes a BOM

Symptex's own comment states the design that avoids all four: *"an update is
'replace some files inside the application folder and restart', and nothing more:
no installer, no service, no registry, no Program Files, no firewall change."*

## The decision that makes this cheap

**Node can create and repoint a Windows junction with no elevation** —
`fs.symlinkSync(target, link, 'junction')`, verified on this machine before writing
this plan. That was the only reason PowerShell was ever involved in the switch.

So EasyMed keeps its versioned layout and gains Symptex's simplicity:

- `versions/<v>/` + a `current` junction — **unchanged**, so the already-deployed
  `EasyMed.exe` keeps working. This matters more than anything else here: the
  launcher is the ONE component no update can replace (Windows locks a running
  exe), so a layout change would strand every installed clinic.
- Rollback stays instant and free: the previous version is still on disk, and
  reverting is repointing the junction back.
- The Ed25519 signature stays. Symptex verifies a checksum from an HTTPS manifest,
  so its trust rests on the server; ours means a compromised update server still
  cannot push code into a clinic. It already runs in Node and costs nothing to keep.

## What changes

`updater.js` — after the bundle is verified and unpacked into `versions/<version>/`
(all of which already happens in Node today), replace the PowerShell hand-off with:

1. snapshot the database (the same `backupBeforeMigrate` the boot path uses)
2. repoint `current` at the new version with `fs.symlinkSync(..., 'junction')`
3. write the outcome file **from Node** — JSON, no BOM, so the clinic and the
   vendor can finally read it
4. `process.exit(75)` — the launcher relaunches, exactly as it already does after
   `staleAfterSwitch`

Deleted: `install/apply-update.ps1`, `install/switch-version.ps1`, and the spawn
plan that called them. `install/install-service.ps1` is retired too — the Windows
service was never once successfully registered (HANDOVER §1), the launcher is what
every install actually uses, and a service needs the elevation Symptex's design
deliberately refuses.

## What we lose, stated plainly

**Automatic rollback when a new version will not boot.** Today apply-update.ps1
health-checks after the switch and reverts. That check has been vacuous on launcher
installs for its whole life (it polled the OLD process, which was still answering),
so what is being removed is closer to theatre than protection. Replacement:
`recover.cmd` in the package root — a double-click that repoints `current` at the
previous version. Documented in the clinic README, and the previous version is
already on disk.

**Keeps working unchanged:** signed bundles, admin consent and the chosen hour,
«Обновить сейчас», the daily check-in, `staleAfterSwitch`, the page auto-reload,
outcome reporting and the two-failure auto-halt.

## Tasks

1. Node apply in `updater.js`; delete the two .ps1 and the spawn plan; retire
   install-service.ps1 with a comment saying why.
2. `recover.cmd` + a line in the clinic README.
3. Tests: a REAL end-to-end apply (build a scratch versioned layout, run the apply,
   assert the junction moved and the outcome file is readable by the app's own
   reader). Unlike the PowerShell smoke test this one runs everywhere, so CI covers
   it — the gap that let four releases ship broken.
4. Update RELEASING.md / HANDOVER.md / CONTRIBUTING.md where they describe the
   PowerShell path, including retiring the Windows-only gate that exists only
   because the apply step used to be untestable in CI.
