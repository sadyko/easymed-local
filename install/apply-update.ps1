<#
.SYNOPSIS
    Applies a staged Easy-Med update: switches to it, confirms it stays healthy,
    and decides - loudly, and only in the one place it is ever safe to - what
    happens to the database if it does not.

.DESCRIPTION
    This is the last of four steps in an update: a signed bundle is built (Plan
    4 Task 1), offered to a clinic through check-in (Task 3), downloaded and
    unpacked at <Root>\versions\<Version> by the clinic updater (Task 4) - and
    THIS script performs the actual switch and reports what happened.

    It does not stop, repoint, start, health-check, or roll back the CODE
    itself - switch-version.ps1 already does all of that, including its own
    automatic roll-back on a failed health check, and is called here rather
    than reimplemented. This script's own job starts where that one's ends:
    interpreting its exit code, deciding the DATABASE question (which
    switch-version.ps1 deliberately never touches), and writing the outcome
    file the clinic reports on its next check-in.

    In order:
      1. Preconditions - refuse loudly, before touching anything, if:
           - the staged version is missing or incomplete,
           - the CURRENTLY RUNNING version is not answering health right now
             (applying an update on top of an already-broken clinic turns one
             problem into two).
         Whether a Windows service is registered for -ServiceName is checked
         too, but only as context for a failure message - it is not itself a
         hard gate, because scratch testing (no administrator rights) has no
         registered service at all and drives a dot-sourced launcher instead;
         the health check above is the real gate either way, since nothing
         can answer health without SOMETHING running it.
      2. Record where `current` points right now - the pre-update version.
      3. Call switch-version.ps1 with pass-through parameters. It owns stop /
         repoint / start / health-check / code-rollback entirely.
      4. Interpret its exit code (0 / 1 / 2 - see switch-version.ps1's own
         header) and decide the database question:
           0 - switched, but a migration crash AFTER the first successful
               health check is rare but real, so this polls for continued
               liveness over ~15s before believing it.
           1 - switch-version.ps1 already rolled the CODE back and confirmed
               the OLD version healthy. The only remaining question is
               whether the FAILED version's migrations ran before it fell
               over (see server/db/backup.js): if no pre-<target> backup
               appeared during THIS attempt, they never started and the
               database is untouched; if one did appear, the schema may have
               moved but the old code already runs fine against it (SQLite
               tolerates additive columns/tables) - so the database is
               deliberately left alone either way.
           2 - switch-version.ps1's OWN rollback also failed: neither version
               answers health. This is the ONE place this script touches the
               database - and only if a migration backup for this attempt
               actually exists to restore FROM. The file it replaces is
               always moved aside, never deleted.
      5. Write <Root>\data\update-result.json in EVERY path (including the
         worst one) - Task 4's updater reports this on its next check-in, and
         the vendor's ring auto-halt logic depends on failures actually being
         visible, not silently missing.

    EXIT CODES (this script's own, distinct from switch-version.ps1's):
      0 - applied, and confirmed to stay healthy.
      1 - not applied, or cleanly rolled back; a known-good version is
          confirmed running. Nothing about the database changed.
      2 - the database WAS restored from a pre-migration backup as part of
          recovering the clinic, and the recovery succeeded (a version is
          confirmed running again).
      3 - the clinic could not be brought back up automatically. Manual
          intervention is needed now; restore-by-hand instructions (if a
          database question was involved) are printed.

    TIMEOUT RECONCILIATION - attack-your-own-code note: switch-version.ps1 has
    its OWN -TimeoutSeconds, and this script's must never be smaller, or it
    would declare a switch a failure while migrations are still legitimately
    running. This is reconciled by construction, not by a runtime comparison:
    this script's -TimeoutSeconds is the ONLY value ever passed to
    switch-version.ps1 below (never its default of 60) - the two can never
    diverge because there is only ever one number in play. The default here
    is 120, not 60, because migrations on a multi-MB database plus boot need
    more headroom than a plain code switch.

.PARAMETER Version
    The version to apply. Must already be staged (unpacked) at
    <Root>\versions\<Version>\ by the updater - this script never downloads
    or unpacks anything itself.

.PARAMETER Root
    Where Easy-Med lives on this PC. Defaults to C:\EasyMed. ALWAYS pass a
    scratch path when testing.

.PARAMETER ServiceName
    Windows service name. Defaults to EasyMed.

.PARAMETER Port
    The port Easy-Med listens on. Defaults to 8000.

.PARAMETER TimeoutSeconds
    Passed straight through to switch-version.ps1 (see the reconciliation
    note above). Defaults to 120 - migrations on a 36 MB database plus boot
    need more headroom than a plain switch's default of 60.

.EXAMPLE
    .\apply-update.ps1 -Version 2.4.0
    Apply a staged update to the real, installed Easy-Med.

.EXAMPLE
    .\apply-update.ps1 -Version 2.4.0 -Root 'C:\Users\me\AppData\Local\Temp\em-test' -ServiceName 'EasyMedTest' -Port 8251 -TimeoutSeconds 30
    A throwaway apply for testing, isolated from any real install.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$Root = 'C:\EasyMed',

    [string]$ServiceName = 'EasyMed',

    [int]$Port = 8000,

    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

# ===========================================================================
# Reuse switch-version.ps1's helpers rather than re-reading the `current`
# junction or re-implementing a health poll a second way.
#
# Dot-sourcing runs switch-version.ps1's own param block AND its own
# dot-source of install-service.ps1 IN THIS SCOPE, but its trailing guard
# (`if ($MyInvocation.InvocationName -ne '.') { exit (Invoke-VersionSwitch ...) }`)
# means Invoke-VersionSwitch never actually runs here - dot-sourcing sets
# InvocationName to '.', so only the function DEFINITIONS load: Get-
# CurrentVersionInfo, Get-EasyMedVersions, Wait-ForEasyMedHealthOrTimeout,
# Stop-EasyMedForSwitch, Start-EasyMedForSwitch. The actual switch itself is
# still performed by calling the FILE below via `&`, in its own invocation -
# never by calling the dot-sourced Invoke-VersionSwitch function directly,
# which would skip its own lock file and "already on this version" handling.
#
# Its own mandatory -Version is satisfied with this script's OWN value - see
# switch-version.ps1's header for why passing values straight back in like
# this is harmless (nothing here reads them for anything other than being
# valid parameters).
. (Join-Path $PSScriptRoot 'switch-version.ps1') -Version $Version -Root $Root -ServiceName $ServiceName -Port $Port -TimeoutSeconds $TimeoutSeconds

# ===========================================================================
# Step: what changed in data\backups\ since a snapshot taken earlier - reused
# for both the exit-1 (was it migrated?) and exit-2 (what to restore from)
# branches.
# ===========================================================================

function Get-BackupFileNames {
    param([Parameter(Mandatory)][string]$Root)
    $backupsDir = Join-Path $Root 'data\backups'
    # ATTACK-YOUR-OWN-CODE, VERIFIED — a pipeline that matches ZERO objects
    # collapses to $null, and one that matches exactly ONE collapses to a bare
    # scalar, not a one-element array - both reproduced directly. A backups\
    # folder that does not exist yet (or is empty) is the NORMAL case for a
    # first-ever update, so this WILL run with zero matches in ordinary use.
    # @(...) here guarantees this function's own result is always a real
    # array. That alone is NOT the whole fix, though: assigning a function
    # call's result to a variable (`$x = Get-BackupFileNames ...`) re-collapses
    # an empty array back to $null at the CALL SITE regardless of what this
    # function returns internally - every caller below also wraps its OWN
    # assignment in @(...) for exactly that reason. Both wrappings are
    # required; this one alone would not have caught the bug that this
    # comment now documents.
    @(
        Get-ChildItem -LiteralPath $backupsDir -Filter '*.db' -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Name
    )
}

function Get-NewTargetBackups {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Before
    )
    # ATTACK-YOUR-OWN-CODE — a RETRIED update sees the FIRST attempt's
    # pre-<target> backup sitting in the folder already. Comparing against
    # mere existence of a 'pre-<target>*' name would make the second attempt
    # believe migrations ran when they had not (yet) run THIS time. Comparing
    # against the listing taken in step 1, before switch-version.ps1 was
    # called this run, is what tells the two attempts apart. The name must
    # also match this target specifically (server/db/backup.js's own
    # convention: pre-<version>.db, or pre-<version>.<n>.db when the plain
    # name is already claimed) - belt-and-braces against something unrelated
    # appearing in the same window.
    $escaped = [regex]::Escape($Version)
    # @(...) again - same reasoning as Get-BackupFileNames above. Its callers
    # (Resolve-SwitchFailedCleanly, Resolve-ClinicDown) ALSO wrap their own
    # `$newBackups = ...` assignment in @(...) - the collapse-to-$null on zero
    # matches happens again at THAT assignment, independent of this wrapping.
    @(
        Get-BackupFileNames -Root $Root |
            Where-Object { $Before -notcontains $_ } |
            Where-Object { $_ -match "^pre-$escaped(\.\d+)?\.db$" }
    )
}

# ===========================================================================
# Step: the outcome file - written in EVERY path, including the worst ones.
# ===========================================================================

function Write-UpdateOutcome {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Version,
        [AllowNull()][string]$From,
        [Parameter(Mandatory)][bool]$Ok,
        [Parameter(Mandatory)][string]$DbState,
        [Parameter(Mandatory)][string]$Detail
    )

    # "db" vocabulary, for whoever reads this JSON next (Task 4's updater):
    #   untouched                      - the database was never touched
    #   migrated-but-old-version-healthy - schema may have moved, left alone on purpose
    #   restored                       - the database WAS restored from a backup
    #   restore-failed                 - a restore was attempted and threw
    #   unknown                        - genuinely unclear (see detail)
    #   current                        - no rollback question applies; the running
    #                                     version is the one this database is for
    $outcome = [ordered]@{
        version = $Version
        from    = $From
        ok      = $Ok
        db      = $DbState
        at      = (Get-Date).ToUniversalTime().ToString('o')
        detail  = $Detail
    }

    # Printed FIRST and unconditionally, single line, grep-able - if the file
    # write below fails (disk full is plausible right after unpacking a
    # multi-MB bundle), the outcome must still exist SOMEWHERE. A vendor's
    # ring auto-halt logic cannot count a failure it never saw.
    $jsonCompact = $outcome | ConvertTo-Json -Compress -Depth 5
    Write-Host "UPDATE_RESULT $jsonCompact" -ForegroundColor Cyan

    $outPath = Join-Path $Root 'data\update-result.json'
    try {
        $dir = Split-Path -Parent $outPath
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        # Pretty-printed in the file itself - a clinic manager might open this
        # in Notepad; the grep-able single line above already covers the
        # "must never vanish" requirement.
        ($outcome | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $outPath -Encoding UTF8
        Write-Host "Outcome written to '$outPath'."
    } catch {
        Write-Host "*** Could not write '$outPath': $($_.Exception.Message) ***" -ForegroundColor Red
        Write-Host 'The UPDATE_RESULT line above is the authoritative record until this is fixed.' -ForegroundColor Red
    }
}

# ===========================================================================
# Step 1: preconditions
# ===========================================================================

function Test-ApplyPreconditions {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][int]$Port
    )

    $problems = @()

    $targetDir = Join-Path $Root "versions\$Version"
    $targetEntry = Join-Path $targetDir 'server\index.js'
    if (-not (Test-Path -LiteralPath $targetEntry)) {
        $available = Get-EasyMedVersions -Root $Root
        $availText = if ($available.Count) { "Staged versions on this PC: $($available -join ', ')" } else { 'No versions at all are staged on this PC.' }
        $problems += "Staged version '$Version' is missing or incomplete - '$targetEntry' was not found. The updater should have unpacked it there before calling this script. $availText"
    }

    # Soft check only, deliberately not a hard gate - see the file header for
    # why. Scratch testing (no administrator rights, confirmed: sc.exe create
    # returns Access Denied) never has a registered service; a real clinic
    # install always does. Either way the health check below is the actual
    # gate: nothing can answer health without something running it.
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Host "Service '$ServiceName' is registered (status: $($svc.Status))."
    } else {
        Write-Host "Note: no Windows service named '$ServiceName' is registered on this PC (expected in scratch testing; a real clinic install always has one)." -ForegroundColor Yellow
    }

    # A short poll, not the full -TimeoutSeconds - this is "is it up RIGHT
    # NOW", not "wait patiently for it to come up", and a broken clinic
    # should be reported back quickly, not after two minutes of polling.
    $healthNow = Wait-ForEasyMedHealthOrTimeout -Port $Port -TimeoutSeconds 5
    $currentHealthy = $healthNow.Healthy
    if (-not $currentHealthy) {
        $problems += "The CURRENTLY RUNNING version is not answering http://localhost:$Port/api/health right now ($($healthNow.Symptom)). Applying an update on top of an already-broken clinic turns one problem into two - fix why the current version is down before retrying this update."
    }

    return [pscustomobject]@{
        Problems       = $problems
        CurrentHealthy = $currentHealthy
    }
}

# ===========================================================================
# Step 4, exit code 0: switched - confirm it STAYS healthy, migrations can
# crash after the first successful check.
# ===========================================================================

function Resolve-SwitchSucceeded {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Version,
        [AllowNull()][string]$From,
        [Parameter(Mandatory)][int]$Port
    )

    Write-Host ''
    Write-Host "Switched to '$Version'. Confirming it stays up while migrations finish (~15s)..." -ForegroundColor Cyan

    # A SEPARATE, small window from switch-version.ps1's own -TimeoutSeconds
    # (already spent proving the FIRST health answer) - this is specifically
    # "did it fall over again right after that", which is rare but real.
    $deadline = (Get-Date).AddSeconds(15)
    $stableFailure = $null
    while ((Get-Date) -lt $deadline) {
        $r = Wait-ForEasyMedHealthOrTimeout -Port $Port -TimeoutSeconds 3
        if (-not $r.Healthy) { $stableFailure = $r.Symptom; break }
        Start-Sleep -Seconds 2
    }

    if ($stableFailure) {
        # ATTACK-YOUR-OWN-CODE — switch-version.ps1 already returned 0 and
        # will not retry or roll back for a failure that happens AFTER it
        # declared success; `current` still points at '$Version'. A second,
        # automatic switch back to '$From' was deliberately NOT attempted
        # here: switch-version.ps1's OWN rollback-on-failure would trigger a
        # SECOND time if '$From' also failed to come up, and it would try to
        # roll back to whatever `current` says NOW (the broken '$Version'),
        # not to where this attempt actually started - a confusing bounce for
        # a case already labelled rare. Reporting plainly and stopping is
        # safer than guessing.
        Write-Host ''
        Write-Host "*** '$Version' answered health once but then stopped answering ($stableFailure). ***" -ForegroundColor Red
        Write-Host "'current' still points at '$Version' - no automatic recovery was attempted for this case. Check '$Root\logs\service.log' and get a person involved now." -ForegroundColor Red
        Write-UpdateOutcome -Root $Root -Version $Version -From $From -Ok $false -DbState 'unknown' `
            -Detail "Health passed once after switching to '$Version' but then failed ($stableFailure). 'current' still points at '$Version' and no automatic recovery was attempted - manual investigation needed now."
        return 3
    }

    Write-Host "'$Version' is healthy and stayed healthy." -ForegroundColor Green
    Write-UpdateOutcome -Root $Root -Version $Version -From $From -Ok $true -DbState 'current' `
        -Detail "Switched from '$From' to '$Version' and confirmed continued health for 15s."
    return 0
}

# ===========================================================================
# Step 4, exit code 1: switch-version.ps1 already rolled the CODE back and
# confirmed the OLD version healthy. Only the database question remains.
# ===========================================================================

function Resolve-SwitchFailedCleanly {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Version,
        [AllowNull()][string]$From,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$BeforeBackups
    )

    Write-Host ''
    Write-Host "'$Version' failed to switch cleanly; switch-version.ps1 already rolled the CODE back to '$From' and confirmed it is healthy." -ForegroundColor Yellow

    $newBackups = @(Get-NewTargetBackups -Root $Root -Version $Version -Before $BeforeBackups)

    if ($newBackups.Count -eq 0) {
        Write-Host "No pre-'$Version' backup appeared during this attempt - migrations never started. The database is untouched." -ForegroundColor Green
        Write-UpdateOutcome -Root $Root -Version $Version -From $From -Ok $false -DbState 'untouched' `
            -Detail "'$Version' did not become healthy; code rolled back to '$From' (confirmed healthy). No migration backup appeared during this attempt - the database was never touched."
        return 1
    }

    Write-Host "A backup appeared during this attempt ($($newBackups -join ', ')) - '$Version' likely ran its migrations before falling over." -ForegroundColor Yellow
    Write-Host "The OLD version ('$From') is confirmed healthy by switch-version.ps1's own rollback check." -ForegroundColor Yellow
    Write-Host 'Leaving the database exactly as it is: SQLite tolerates additive columns/tables, and destroying anything entered since the backup to undo a migration the old code already tolerates is the worse trade.' -ForegroundColor Yellow
    Write-UpdateOutcome -Root $Root -Version $Version -From $From -Ok $false -DbState 'migrated-but-old-version-healthy' `
        -Detail "'$Version' did not become healthy; code rolled back to '$From' (confirmed healthy). A migration backup appeared during this attempt ($($newBackups -join ', ')), so the schema may have moved, but the database was deliberately left alone because the old version runs fine against it."
    return 1
}

# ===========================================================================
# Step 4, exit code 2: switch-version.ps1's OWN rollback also failed. Neither
# version answers health. This is the ONLY place this script touches the
# database.
# ===========================================================================

function Resolve-ClinicDown {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Version,
        [AllowNull()][string]$From,
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$BeforeBackups
    )

    Write-Host ''
    Write-Host '*** switch-version.ps1 reports the clinic is DOWN: neither the new nor the old version is healthy. ***' -ForegroundColor Red
    Write-Host 'This is the one situation where this script touches the database.' -ForegroundColor Red

    $dataDir = Join-Path $Root 'data'
    $dbPath = Join-Path $dataDir 'easymed.db'
    $backupsDir = Join-Path $dataDir 'backups'

    # Best-effort, belt-and-braces: switch-version.ps1 already tried stopping
    # twice (once for the target, once for its own rollback attempt) before
    # giving up - this is not a first attempt, so quietly doing nothing if
    # there is genuinely nothing left running is fine. Reuses the SAME
    # Stop-EasyMedForSwitch switch-version.ps1 itself uses, rather than a
    # second hand-rolled Get-Service/Stop-Service pair.
    try { Stop-EasyMedForSwitch -ServiceName $ServiceName } catch { }

    $newBackups = @(Get-NewTargetBackups -Root $Root -Version $Version -Before $BeforeBackups)

    if ($newBackups.Count -eq 0) {
        # No migration ever ran - the database is already in the state the
        # old version expects. The clinic being down is a process problem,
        # not a data problem, and there is nothing here to restore FROM.
        # Nothing was fixed either, though - this is still exit 3.
        Write-Host 'No migration backup appeared during this attempt - the database was never touched, so there is nothing to restore.' -ForegroundColor Yellow
        Write-Host "*** Clinic is DOWN. Database is untouched. Check '$Root\logs\service.log' and get a person involved now. ***" -ForegroundColor Red
        Write-UpdateOutcome -Root $Root -Version $Version -From $From -Ok $false -DbState 'untouched' `
            -Detail "Rollback of '$Version' failed and the clinic is down, but no migration backup appeared - the database is untouched. This is a process problem, not a data problem, and was NOT resolved automatically. Check '$Root\logs\service.log' and get a person involved now."
        return 3
    }

    # Newest of the ones that appeared THIS attempt - if more than one exists
    # (a retry within this very attempt hit the counter-suffix path), the
    # freshest capture is the right one.
    $newestBackup = $newBackups |
        ForEach-Object { Get-Item -LiteralPath (Join-Path $backupsDir $_) } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    Write-Host "Restoring database from '$($newestBackup.Name)'..." -ForegroundColor Yellow

    $failedAsideName = 'easymed.db.failed-{0}' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
    $failedAsidePath = Join-Path $dataDir $failedAsideName
    $actions = @()
    try {
        # Move the current file aside rather than deleting it - "never delete
        # anything" - so a person can inspect or recover it later even after
        # this restores the backup over its place.
        if (Test-Path -LiteralPath $dbPath) {
            Move-Item -LiteralPath $dbPath -Destination $failedAsidePath -Force
            $actions += "moved '$dbPath' aside to '$failedAsidePath' (not deleted)"
            Write-Host "Moved the current database aside to '$failedAsidePath' (not deleted)." -ForegroundColor Yellow
        } else {
            $actions += "no '$dbPath' existed to move aside"
        }

        Copy-Item -LiteralPath $newestBackup.FullName -Destination $dbPath -Force
        $actions += "copied '$($newestBackup.FullName)' to '$dbPath'"
        Write-Host "Copied '$($newestBackup.Name)' into place as '$dbPath'." -ForegroundColor Yellow

        # Also move aside the WAL/SHM sidecars if present - restoring the .db
        # file alone while a stale -wal from the damaged run still sits next
        # to it would let SQLite replay THAT wal onto the restored file on
        # next open, silently reintroducing exactly what was just moved away.
        foreach ($ext in @('-wal', '-shm')) {
            $sidecar = "$dbPath$ext"
            if (Test-Path -LiteralPath $sidecar) {
                $asideSidecar = "$failedAsidePath$ext"
                Move-Item -LiteralPath $sidecar -Destination $asideSidecar -Force
                $actions += "moved sidecar '$sidecar' aside to '$asideSidecar'"
            }
        }
    } catch {
        Write-Host ''
        Write-Host "*** Restoring the database FAILED: $($_.Exception.Message) ***" -ForegroundColor Red
        Write-Host 'RESTORE BY HAND:' -ForegroundColor Red
        Write-Host "  1. Stop the '$ServiceName' service if it is running." -ForegroundColor Red
        Write-Host "  2. If '$dbPath' still exists, move it aside (do not delete it)." -ForegroundColor Red
        Write-Host "  3. Copy '$($newestBackup.FullName)' to '$dbPath'." -ForegroundColor Red
        Write-Host "  4. Start the '$ServiceName' service and confirm http://localhost:$Port/api/health answers." -ForegroundColor Red
        Write-UpdateOutcome -Root $Root -Version $Version -From $From -Ok $false -DbState 'restore-failed' `
            -Detail "Rollback of '$Version' failed and the clinic is down. A migration backup existed ('$($newestBackup.Name)') but restoring it threw: $($_.Exception.Message). Actions attempted: $($actions -join '; '). Manual restore needed - see the printed instructions."
        return 3
    }

    # Restart the OLD version against the now-restored database. Reuses
    # switch-version.ps1's own thin wrapper rather than a second `sc.exe
    # start` line written by hand.
    Write-Host "Starting '$ServiceName' (old version '$From') against the restored database..."
    Start-EasyMedForSwitch -ServiceName $ServiceName
    $restoredHealth = Wait-ForEasyMedHealthOrTimeout -Port $Port -TimeoutSeconds $TimeoutSeconds

    if ($restoredHealth.Healthy) {
        Write-Host ''
        Write-Host "Recovered: '$From' is running and healthy against the restored database." -ForegroundColor Green
        Write-UpdateOutcome -Root $Root -Version $Version -From $From -Ok $false -DbState 'restored' `
            -Detail "Rollback of '$Version' failed and the clinic went down. Restored the database from '$($newestBackup.Name)' (previous file moved aside to '$failedAsidePath', not deleted) and '$From' is now running and healthy. Actions: $($actions -join '; ')."
        return 2
    }

    Write-Host ''
    Write-Host "*** '$From' STILL does not answer health even after restoring the database ($($restoredHealth.Symptom)). ***" -ForegroundColor Red
    Write-Host 'RESTORE BY HAND (already attempted automatically, but the clinic is still down):' -ForegroundColor Red
    Write-Host "  - The database WAS restored to '$dbPath' from '$($newestBackup.FullName)'." -ForegroundColor Red
    Write-Host "  - The previous file is preserved at '$failedAsidePath'." -ForegroundColor Red
    Write-Host "  - Check '$Root\logs\service.log', confirm Node.js is installed, and get a person involved now." -ForegroundColor Red
    Write-UpdateOutcome -Root $Root -Version $Version -From $From -Ok $false -DbState 'restored' `
        -Detail "Rollback of '$Version' failed and the clinic is down. Database WAS restored from '$($newestBackup.Name)' (previous file at '$failedAsidePath'), but '$From' still does not answer health ($($restoredHealth.Symptom)). Manual intervention required now."
    return 3
}

# ===========================================================================
# Main
# ===========================================================================

function Invoke-ApplyUpdate {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )

    Write-Host ''
    Write-Host '=== Easy-Med update apply ===' -ForegroundColor Cyan
    Write-Host "Root:    $Root"
    Write-Host "Service: $ServiceName  (port $Port)"
    Write-Host "Target:  $Version"

    # Step 2 — recorded ahead of the precondition gate, purely as an
    # observation (nothing is touched yet): the outcome file needs a 'from'
    # even when preconditions refuse the update outright.
    $currentInfo = Get-CurrentVersionInfo -Root $Root
    $from = if ($currentInfo.Ok) { $currentInfo.Name } else { $null }

    # Step 1 — preconditions.
    Write-Host ''
    Write-Host 'Checking preconditions...'
    $check = Test-ApplyPreconditions -Root $Root -Version $Version -ServiceName $ServiceName -Port $Port
    if ($check.Problems.Count -gt 0) {
        Write-Host ''
        Write-Host 'Refused: this update was NOT applied.' -ForegroundColor Red
        foreach ($p in $check.Problems) { Write-Host "  - $p" -ForegroundColor Red }
        # A clinic that was ALREADY down before this update was even
        # attempted is a more urgent situation than "update refused, clinic
        # fine" (e.g. the staged version being missing) - the exit code says
        # which one happened, not just that something did.
        $exitCode = if ($check.CurrentHealthy) { 1 } else { 3 }
        Write-UpdateOutcome -Root $Root -Version $Version -From $from -Ok $false -DbState 'untouched' `
            -Detail ('Preconditions not met: ' + ($check.Problems -join ' | '))
        return $exitCode
    }
    Write-Host 'Preconditions OK.' -ForegroundColor Green

    if (-not $currentInfo.Ok) {
        # Should not happen if the health check above passed (something must
        # be serving it from SOMEWHERE) - Get-CurrentVersionInfo failing for
        # its OWN structural reasons (missing/non-junction `current`) is a
        # distinct, worse problem than "not healthy", so it is refused
        # distinctly rather than folded into the generic precondition list.
        Write-Host ''
        Write-Host "Refused: $($currentInfo.Reason)" -ForegroundColor Red
        Write-UpdateOutcome -Root $Root -Version $Version -From $null -Ok $false -DbState 'untouched' `
            -Detail "Could not determine the running version: $($currentInfo.Reason)"
        return 3
    }
    Write-Host "Currently running: $from"

    # Snapshot of backups\ BEFORE the switch - compared against later, not
    # mere existence of a 'pre-<target>*' name, so a RETRIED update does not
    # misread the FIRST attempt's backup as this attempt's migrations having run.
    $beforeBackups = @(Get-BackupFileNames -Root $Root)

    # Step 3 — the actual switch. switch-version.ps1 owns stop / repoint /
    # start / health / rollback entirely; this only calls it and reads what
    # it decided.
    #
    # Invoked via `&`, not dot-sourced. ATTACK-YOUR-OWN-CODE — PowerShell
    # exit-code propagation differs between the two: switch-version.ps1's own
    # trailing guard only calls `exit (Invoke-VersionSwitch ...)` when
    # $MyInvocation.InvocationName -ne '.', which is FALSE when dot-sourced -
    # dot-sourcing it here (as was done above, deliberately, to reuse its
    # helper FUNCTIONS) would silently skip Invoke-VersionSwitch entirely,
    # never touch anything, and leave $LASTEXITCODE holding whatever it held
    # before. `&` runs the file as its own script invocation, so the guard's
    # condition is true, Invoke-VersionSwitch actually runs, and `exit N`
    # sets $LASTEXITCODE the normal way - verified directly against this
    # exact call below, not assumed (see the Task 5 verification notes).
    Write-Host ''
    Write-Host 'Calling switch-version.ps1...'
    $switchScript = Join-Path $PSScriptRoot 'switch-version.ps1'
    & $switchScript -Version $Version -Root $Root -ServiceName $ServiceName -Port $Port -TimeoutSeconds $TimeoutSeconds
    $code = $LASTEXITCODE
    Write-Host "switch-version.ps1 exited with code $code."

    switch ($code) {
        0 { return (Resolve-SwitchSucceeded -Root $Root -Version $Version -From $from -Port $Port) }
        1 { return (Resolve-SwitchFailedCleanly -Root $Root -Version $Version -From $from -BeforeBackups $beforeBackups) }
        2 { return (Resolve-ClinicDown -Root $Root -Version $Version -From $from -ServiceName $ServiceName -Port $Port -TimeoutSeconds $TimeoutSeconds -BeforeBackups $beforeBackups) }
        default {
            Write-Host ''
            Write-Host "*** switch-version.ps1 exited with an UNEXPECTED code ($code) - treating as failure. ***" -ForegroundColor Red
            Write-UpdateOutcome -Root $Root -Version $Version -From $from -Ok $false -DbState 'unknown' `
                -Detail "switch-version.ps1 returned unexpected exit code $code"
            return 3
        }
    }
}

# Only run when this file is executed directly - dot-sourcing it loads the
# functions above without acting on anything, the same pattern switch-
# version.ps1 and install-service.ps1 both use for their own testability.
if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-ApplyUpdate -Version $Version -Root $Root -ServiceName $ServiceName -Port $Port -TimeoutSeconds $TimeoutSeconds)
}
