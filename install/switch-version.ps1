<#
.SYNOPSIS
    Switches the running Easy-Med version by repointing `current`, with an
    automatic roll-back to the previous version if the new one fails its
    health check.

.DESCRIPTION
    This is the mechanism a remote update rides on: install-service.ps1 lays
    a version down and points `current` at it once; from then on, moving
    between already-installed versions - forward for an update, backward for
    a rollback - is this script, and only this script.

    In order:
      1. Refuse if <Root>\versions\<Version> does not exist. List what does.
      2. Record what `current` points at right now - that recording IS the
         entire rollback plan for this run. Refuse if it cannot be pinned
         down safely (missing, or not a junction - see below).
      3. Refuse (cleanly, exit 0) if the target is already current.
      4. Stop the service.
      5. Repoint `current` at the target.
      6. Start the service.
      7. Poll http://localhost:<Port>/api/health until it answers
         {"ok":true} or -TimeoutSeconds elapses.
      8. On failure, repoint `current` back to what was recorded in step 2,
         restart, confirm health, and report the rollback. Exit non-zero.

    CODE ONLY IS ROLLED BACK HERE. A migration that ran while the failed
    version was briefly current may have been perfectly correct - the new
    version might simply be crashing for an unrelated reason. Automatically
    reverting the DATABASE on a failed health check could destroy real work
    (e.g. patients registered in the few seconds the new version was up) to
    "fix" a problem that was never in the data at all. Restoring a database
    backup (see server/db/backup.js, and <Root>\data\backups\) is a separate,
    deliberate act for a human or a later, smarter update client to decide on
    - this script must never do it silently, and does not.

    Reuses install-service.ps1's Stop-ExistingService (stopping) and
    Set-CurrentJunction (repointing) rather than reimplementing junction
    handling or the Job-Object kill-on-close mechanism that makes "stop"
    actually kill node - see that script for both.

.PARAMETER Version
    The version to switch to. Must already exist under <Root>\versions\.

.PARAMETER Root
    Where Easy-Med lives on this PC. Defaults to C:\EasyMed. ALWAYS pass a
    scratch path when testing.

.PARAMETER ServiceName
    Windows service name. Defaults to EasyMed.

.PARAMETER Port
    The port Easy-Med listens on. Defaults to 8000.

.PARAMETER TimeoutSeconds
    How long to wait for /api/health to answer before deciding the switch
    failed (and, separately, how long to wait for it to answer again during
    the roll-back itself). Defaults to 60.

.EXAMPLE
    .\switch-version.ps1 -Version 2.4.0
    Switch the real, installed Easy-Med to version 2.4.0, rolling back
    automatically if it does not come up healthy.

.EXAMPLE
    .\switch-version.ps1 -Version 2.3.1 -Root 'C:\Users\me\AppData\Local\Temp\em-test' -ServiceName 'EasyMedTest' -Port 8151 -TimeoutSeconds 15
    A throwaway switch for testing, isolated from any real install.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$Root = 'C:\EasyMed',

    [string]$ServiceName = 'EasyMed',

    [int]$Port = 8000,

    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

# ===========================================================================
# Reuse install-service.ps1's helpers instead of reimplementing junction
# handling or the Job-Object kill-on-close mechanism.
#
# Dot-sourcing a script runs its param block IN THIS SCOPE (dot-sourcing opens
# no new scope), so install-service.ps1's own -Source/-Version/-Root/
# -ServiceName/-Port would otherwise silently overwrite this script's
# variables of the same name. The fix: pass this script's OWN values straight
# back in, so the "overwrite" sets each variable to the value it already had.
# -Source is mandatory on that script but is never actually read unless ITS
# OWN Main runs - which happens only when IT is executed directly, never when
# it is dot-sourced (see its own trailing guard) - so any already-valid path
# is a harmless placeholder here; $PSScriptRoot always exists and is never
# read for this purpose.
# ===========================================================================
. (Join-Path $PSScriptRoot 'install-service.ps1') -Source $PSScriptRoot -Version $Version -Root $Root -ServiceName $ServiceName -Port $Port

# ===========================================================================
# Step: what is installed, for the "you mistyped it" message
# ===========================================================================

function Get-EasyMedVersions {
    param([Parameter(Mandatory)][string]$Root)
    $versionsDir = Join-Path $Root 'versions'
    if (-not (Test-Path -LiteralPath $versionsDir)) { return @() }
    Get-ChildItem -LiteralPath $versionsDir -Directory -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Name | Sort-Object
}

# ===========================================================================
# Step: record where `current` points now - the entire rollback plan
# ===========================================================================

function Get-CurrentVersionInfo {
    param([Parameter(Mandatory)][string]$Root)

    # ATTACK-YOUR-OWN-CODE — three ways this can fail to produce a safe answer,
    # each refused with its own reason rather than folded into one generic
    # message, because the fix is different for each:
    #   - nothing at <Root>\current at all (Easy-Med was never installed here)
    #   - `current` exists but is a REAL folder, not a junction (a botched
    #     manual install/recovery) - repointing would mean deleting a real
    #     directory that might be the live version's own files
    #   - `current` is a junction but Windows reports no target for it
    $currentLink = Join-Path $Root 'current'
    if (-not (Test-Path -LiteralPath $currentLink)) {
        return [pscustomobject]@{
            Ok     = $false
            Reason = "'$currentLink' does not exist. Has Easy-Med been installed on this PC (install-service.ps1)?"
        }
    }

    $item = Get-Item -LiteralPath $currentLink -Force
    if ($item.LinkType -ne 'Junction') {
        # LinkType is $null (not an empty string) for an ordinary directory, which would
        # otherwise print as a blank "(found: )" - naming it plainly instead.
        $foundKind = if ($item.LinkType) { $item.LinkType } else { 'a plain directory, not a link at all' }
        return [pscustomobject]@{
            Ok     = $false
            Reason = "'$currentLink' exists but is NOT a junction (found: $foundKind). " +
                     "This looks like a botched manual install or recovery. Repointing it here " +
                     "could delete a real folder rather than just a link, so this script refuses " +
                     "to touch it - fix '$currentLink' by hand first, then try again."
        }
    }

    $target = $item.Target | Select-Object -First 1
    if (-not $target) {
        return [pscustomobject]@{
            Ok     = $false
            Reason = "'$currentLink' is a junction but Windows reports no target for it. There is nothing safe to roll back to."
        }
    }

    return [pscustomobject]@{ Ok = $true; Name = (Split-Path -Leaf $target); Target = $target }
}

# ===========================================================================
# Step: a lock, because this operation's window is minutes wide, not
# milliseconds
# ===========================================================================

function Enter-SwitchLock {
    param([Parameter(Mandatory)][string]$Root)

    # ATTACK-YOUR-OWN-CODE — "is a lock warranted, or is the window too small
    # to matter?" It is warranted: a single run of this script can take up to
    # -TimeoutSeconds polling health, TWICE in the failure path (once for the
    # target, once for the rollback) - minutes, not a moment. If a second
    # invocation started in that window (an operator re-running by hand while
    # a scheduled update is mid-flight is the realistic case, not a contrived
    # one), both would read the SAME recorded `current`, both would stop/
    # repoint/start, and each one's health poll could observe the OTHER run's
    # process coming up - one run could report success for a switch it never
    # made, or roll back a switch the other run just performed, leaving
    # `current` pointed at whichever run happened to finish last with neither
    # script's rollback logic aware the other existed.
    #
    # An exclusive, atomic file create (not Test-Path-then-write, which has
    # the identical race baked into it) - the second run's open fails
    # immediately with an IOException.
    #
    # Left in place if this process is killed outright (Ctrl+C mid-poll, a
    # crash, the console window closed) rather than cleared on a timer. That
    # is deliberate: silently expiring a lock re-introduces exactly the race
    # this exists to prevent, and a wrong guess about "how stale is too stale"
    # is worse than an operator seeing a clear message and deciding by hand.
    $lockPath = Join-Path $Root 'switch.lock'
    try {
        $stream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $writer = New-Object System.IO.StreamWriter($stream)
            $writer.WriteLine("pid=$PID started=$(Get-Date -Format o)")
            $writer.Flush()
        } finally {
            $stream.Dispose()
        }
        return $lockPath
    } catch [System.IO.IOException] {
        $existing = ''
        try { $existing = (Get-Content -LiteralPath $lockPath -Raw).Trim() } catch { }
        throw "Another switch-version.ps1 appears to be running already ('$lockPath' exists: $existing). " +
              "If you are certain nothing is actually running (e.g. after a crash), delete that file and try again."
    }
}

function Exit-SwitchLock {
    param([Parameter(Mandatory)][string]$LockPath)
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}

# ===========================================================================
# Step: stop / start - thin wrappers so the health poll (step 7) is its own
# step, separate from "start" (step 6), unlike install-service.ps1's
# Wait-ForEasyMedHealthy which fuses them. That split is what lets a failed
# poll be attributed and acted on (roll back) without re-issuing a second
# start request it never needed.
# ===========================================================================

function Stop-EasyMedForSwitch {
    param([Parameter(Mandatory)][string]$ServiceName)
    # Stop-ExistingService (install-service.ps1) already no-ops if the service
    # is not registered, or already stopped - exactly "what if the service is
    # already stopped when we go to stop it?" answered by reuse, not by a
    # second copy of the same guard.
    Stop-ExistingService -ServiceName $ServiceName
}

function Start-EasyMedForSwitch {
    param([Parameter(Mandatory)][string]$ServiceName)
    # Deliberately just the "ask Windows to start it" half of install-service.
    # ps1's Wait-ForEasyMedHealthy. Its own exit code only reports whether the
    # Service Control Manager ACCEPTED the request, not whether node went on
    # to open the port - same caveat as there. The health poll below is what
    # actually decides anything.
    & sc.exe @('start', $ServiceName) | Out-Null
}

function Wait-ForEasyMedHealthOrTimeout {
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )

    # ATTACK-YOUR-OWN-CODE — "does the health poll distinguish 'not up yet'
    # from 'up and broken'?" A connection refused (nothing listening) and an
    # HTTP error response (something IS listening and answering, just badly)
    # are different facts. They currently lead to the same PASS/FAIL decision
    # here (keep polling either way until the timeout, then declare failure) -
    # a version that is merely slow to bind the port and one that is up and
    # returning 500 the whole time both deserve the full timeout before being
    # given up on, and both are equally "not healthy" at the end of it. But
    # they are recorded separately so the final report can say WHICH one
    # happened, rather than a flat "did not respond" that would mislead
    # whoever reads this at 3am into checking the wrong thing (is the process
    # even running? vs. is it crashing on every request?).
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastSymptom = 'never connected'
    while ((Get-Date) -lt $deadline) {
        try {
            # 127.0.0.1, NEVER localhost: in a fresh (child) PowerShell, localhost resolves
            # ::1 first, the server listens on IPv4 0.0.0.0 only, and the IPv6 attempt
            # eats the whole -TimeoutSec before any fallback — every health poll "fails"
            # while the clinic is up (reproduced on the owner's machine, 2026-08-23).
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
            if ($resp.ok -eq $true) {
                return [pscustomobject]@{ Healthy = $true; Symptom = $null }
            }
            $lastSymptom = 'answered, but reported ok is not true'
        } catch {
            # Invoke-RestMethod throws for BOTH a connection refused and a
            # non-2xx HTTP status. A response object is only present for the
            # latter - use that to tell them apart.
            $webResponse = $_.Exception.Response
            if ($webResponse) {
                $lastSymptom = "answered with HTTP $([int]$webResponse.StatusCode) instead of a healthy response"
            } else {
                $lastSymptom = 'connection refused / nothing listening yet'
            }
        }
        Start-Sleep -Seconds 1
    }
    return [pscustomobject]@{ Healthy = $false; Symptom = $lastSymptom }
}

# ===========================================================================
# Main
# ===========================================================================

function Invoke-VersionSwitch {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )

    Write-Host ''
    Write-Host '=== Easy-Med version switch ===' -ForegroundColor Cyan
    Write-Host "Root:    $Root"
    Write-Host "Service: $ServiceName  (port $Port)"
    Write-Host "Target:  $Version"

    # Step 1 — refuse if the target does not exist. No lock needed yet:
    # nothing has been read or touched that another run could race with.
    $targetDir = Join-Path $Root "versions\$Version"
    if (-not (Test-Path -LiteralPath $targetDir)) {
        $available = Get-EasyMedVersions -Root $Root
        Write-Host ''
        Write-Host "Refused: version '$Version' is not installed (no folder at '$targetDir')." -ForegroundColor Red
        if ($available.Count) {
            Write-Host 'Versions that ARE available on this PC:' -ForegroundColor Yellow
            foreach ($v in $available) { Write-Host "  - $v" }
        } else {
            Write-Host "No versions at all are installed under '$Root\versions'." -ForegroundColor Yellow
        }
        return 1
    }

    # Everything from here on reads or mutates shared state (`current`, the
    # service) - see Enter-SwitchLock for why this is the boundary.
    $lockPath = Enter-SwitchLock -Root $Root
    try {
        try {
            # Step 2 — record where `current` points now.
            $currentInfo = Get-CurrentVersionInfo -Root $Root
            if (-not $currentInfo.Ok) {
                Write-Host ''
                Write-Host 'Refused: could not determine what version is currently running.' -ForegroundColor Red
                Write-Host $currentInfo.Reason -ForegroundColor Red
                return 1
            }
            Write-Host "Currently running: $($currentInfo.Name)"

            # Step 3 — a no-op must not look like a failure.
            if ($currentInfo.Name -ieq $Version) {
                Write-Host ''
                Write-Host "Already running version '$Version' - nothing to do." -ForegroundColor Green
                return 0
            }

            # Step 4 — stop.
            Write-Host "Stopping '$ServiceName'..."
            Stop-EasyMedForSwitch -ServiceName $ServiceName

            # Step 5 — repoint. Set-CurrentJunction (install-service.ps1) also
            # refuses if `current` is not a junction, and its .Delete() call
            # removes only the reparse point, never the target's contents -
            # see that function's own comment.
            Write-Host "Pointing 'current' at '$Version'..."
            Set-CurrentJunction -Root $Root -VersionDir $targetDir

            # Step 6 — start.
            Write-Host "Starting '$ServiceName'..."
            Start-EasyMedForSwitch -ServiceName $ServiceName

            # Step 7 — health-check.
            Write-Host "Waiting for http://localhost:$Port/api/health (up to ${TimeoutSeconds}s)..."
            $result = Wait-ForEasyMedHealthOrTimeout -Port $Port -TimeoutSeconds $TimeoutSeconds

            if ($result.Healthy) {
                Write-Host ''
                Write-Host "Easy-Med switched to version '$Version' and is healthy." -ForegroundColor Green
                Write-Host "  Open:  http://localhost:$Port"
                return 0
            }

            # Step 8 — roll back CODE ONLY. See the file header for why the
            # database is never touched here - repeated at the point it
            # matters most, because this is the line a well-meaning future
            # edit is most likely to "improve" by accident.
            Write-Host ''
            Write-Host "Version '$Version' did not become healthy ($($result.Symptom))." -ForegroundColor Red
            Write-Host "Rolling back to '$($currentInfo.Name)'..." -ForegroundColor Yellow

            Stop-EasyMedForSwitch -ServiceName $ServiceName
            Set-CurrentJunction -Root $Root -VersionDir $currentInfo.Target
            Start-EasyMedForSwitch -ServiceName $ServiceName
            $rollbackResult = Wait-ForEasyMedHealthOrTimeout -Port $Port -TimeoutSeconds $TimeoutSeconds

            if ($rollbackResult.Healthy) {
                Write-Host ''
                Write-Host "Rolled back: Easy-Med is running version '$($currentInfo.Name)' again and is healthy." -ForegroundColor Yellow
                Write-Host "Only the CODE for '$Version' was reverted. If it ran any database migrations" -ForegroundColor Yellow
                Write-Host 'before failing, those were NOT undone - restoring the database is a separate,' -ForegroundColor Yellow
                Write-Host "deliberate step using the backup in '$Root\data\backups\'. See install\README.md." -ForegroundColor Yellow
                return 1
            }

            # ATTACK-YOUR-OWN-CODE — "what if the rollback itself fails?" This
            # is the single worst outcome this script can produce: the new
            # version would not come up, and now neither will the old one -
            # the clinic is down with no working version, and there is no
            # third option to fall back to. It must not be silent, and it
            # must not be dressed up as anything other than what it is.
            Write-Host ''
            Write-Host '*** ROLLBACK FAILED. Easy-Med is DOWN. ***' -ForegroundColor Red
            Write-Host "Neither '$Version' nor '$($currentInfo.Name)' answered a health check." -ForegroundColor Red
            Write-Host "Last symptom while rolling back: $($rollbackResult.Symptom)" -ForegroundColor Red
            $whereNow = Get-CurrentVersionInfo -Root $Root
            if ($whereNow.Ok) {
                Write-Host "'current' is now pointed at: $($whereNow.Name)" -ForegroundColor Red
            }
            Write-Host "Check '$Root\logs\service.log' and get a person involved now - this is not" -ForegroundColor Red
            Write-Host 'something this script can recover from by itself.' -ForegroundColor Red
            return 2
        } catch {
            # Anything unexpected (a thrown Set-CurrentJunction refusal mid-
            # rollback, a permissions error, ...) must still say plainly where
            # things were left, not leak a raw stack trace to a clinic manager
            # and stop.
            Write-Host ''
            Write-Host '*** UNEXPECTED ERROR while switching versions. ***' -ForegroundColor Red
            Write-Host $_.Exception.Message -ForegroundColor Red
            $whereNow = $null
            try { $whereNow = Get-CurrentVersionInfo -Root $Root } catch { }
            if ($whereNow -and $whereNow.Ok) {
                Write-Host "'current' is currently pointed at: $($whereNow.Name)" -ForegroundColor Red
            } else {
                Write-Host "'current' could not be read either - check '$Root\current' by hand." -ForegroundColor Red
            }
            Write-Host 'Get a person involved - this script cannot safely continue on its own.' -ForegroundColor Red
            return 2
        }
    } finally {
        Exit-SwitchLock -LockPath $lockPath
    }
}

# Only run when this file is executed directly - dot-sourcing it (as this
# script's own test harness does, exactly like install-service.ps1) loads the
# functions above without acting on anything, so the stop/start seam can be
# swapped for a test double while every other line of logic here runs for
# real.
if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-VersionSwitch -Version $Version -Root $Root -ServiceName $ServiceName -Port $Port -TimeoutSeconds $TimeoutSeconds)
}
