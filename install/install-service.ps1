<#
.SYNOPSIS
    Installs Easy-Med Local as a Windows service, running from a versioned
    directory so a later update can be installed by unpacking beside the
    current version and repointing which one is live.

.DESCRIPTION
    Lays out:

        <Root>\
          current              junction -> versions\<version>
          versions\<version>\  server\, public\, node_modules\, package.json
          data\                easymed.db, licence.dat, control.json, storage\, backups\
          logs\                service stdout/stderr

    then registers a Windows service that runs node against
    <Root>\current\server\index.js.

    Re-running this script is safe: it never touches an existing data\, and it
    replaces the target version folder and service registration cleanly.

.PARAMETER Source
    A checkout or unpacked release bundle to install (must contain
    package.json and server\index.js).

.PARAMETER Version
    Defaults to the "version" field in Source's package.json. Only override
    this for a bundle whose package.json is missing or wrong.

.PARAMETER Root
    Where Easy-Med lives on this PC. Defaults to C:\EasyMed. ALWAYS pass a
    scratch path when testing - never run this against a real clinic's C:\EasyMed
    from a test session.

.PARAMETER ServiceName
    Windows service name. Defaults to EasyMed. Use a different name (e.g.
    EasyMedTest) for anything other than a real install.

.PARAMETER Port
    The port Easy-Med listens on. Defaults to 8000.

.EXAMPLE
    .\install-service.ps1 -Source 'C:\Users\me\Desktop\easymed.local'
    A real install onto this PC, using the default C:\EasyMed and service name EasyMed.

.EXAMPLE
    .\install-service.ps1 -Source '.' -Root 'C:\Users\me\AppData\Local\Temp\em-install-test' -ServiceName 'EasyMedTest' -Port 8140
    A throwaway install for testing, isolated from any real install on this PC.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [string]$Version,

    [string]$Root = 'C:\EasyMed',

    [string]$ServiceName = 'EasyMed',

    [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'

# ===========================================================================
# Administrator check
# ===========================================================================

function Test-Administrator {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
    if (Test-Administrator) { return }
    # A clinic manager runs this, not an engineer - the message has to say what
    # to click, not what API call failed.
    Write-Host ''
    Write-Host 'Easy-Med could not be installed: this window is not running as Administrator.' -ForegroundColor Red
    Write-Host 'Installing Easy-Med registers a Windows service, and Windows only allows an' -ForegroundColor Red
    Write-Host 'administrator to do that.' -ForegroundColor Red
    Write-Host ''
    Write-Host 'To fix this:' -ForegroundColor Yellow
    Write-Host '  1. Close this window.'
    Write-Host '  2. Find PowerShell in the Start menu, right-click it, and choose'
    Write-Host '     "Run as administrator".'
    Write-Host '  3. Run this same command again.'
    Write-Host ''
    exit 1
}

# ===========================================================================
# node.exe - resolved once, baked into the service launcher, never trusted to PATH
# ===========================================================================

# ATTACK-YOUR-OWN-CODE — a Windows service normally runs as LocalSystem, whose
# PATH is not this interactive user's PATH (LocalSystem has no user profile, so
# a node.exe installed "for me only" or via nvm-windows into a per-user folder
# is often invisible to it even when it works fine from an ordinary prompt).
# Resolving the full path once, here, at install time, and writing that exact
# path into the shim means the service never depends on PATH at all.
function Resolve-NodeExePath {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )
    if (Test-Path 'env:ProgramFiles(x86)') {
        $candidates += (Join-Path (Get-Item 'env:ProgramFiles(x86)').Value 'nodejs\node.exe')
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }

    throw 'Could not find node.exe anywhere on this PC (checked PATH and the usual Program Files locations). Install Node.js first, then run this installer again.'
}

# Same reasoning as Resolve-NodeExePath: baked in, not trusted to LocalSystem's
# PATH. Windows PowerShell 5.1 ships at a fixed, well-known path on every
# supported Windows version, so the fallback below is not a guess.
function Resolve-PowerShellExePath {
    $cmd = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $fallback = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path $fallback) { return $fallback }

    throw 'Could not find powershell.exe on this PC.'
}

# ===========================================================================
# Step: create the layout, but never touch an existing data\
# ===========================================================================

function Initialize-Layout {
    param([Parameter(Mandatory)][string]$Root)

    # -Force also creates $Root itself if it does not exist yet - there is
    # deliberately no separate "create $Root" step.
    New-Item -ItemType Directory -Path (Join-Path $Root 'versions') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $Root 'logs') -Force | Out-Null

    $dataDir = Join-Path $Root 'data'
    $dataPreExisted = Test-Path $dataDir
    if (-not $dataPreExisted) {
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    }
    # Deliberately NO "else" branch. A clinic's records live here; reinstalling
    # or upgrading must never so much as touch this folder's permissions, let
    # alone its contents. "Leave it alone" means the code does not mention it.
    return $dataPreExisted
}

# ===========================================================================
# Step: stop whatever is running BEFORE we touch the version folder
# ===========================================================================

function Stop-ExistingService {
    param([Parameter(Mandatory)][string]$ServiceName)

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) { return }
    if ($svc.Status -eq 'Stopped') { return }

    Write-Host "Stopping the existing '$ServiceName' service before updating its files..."
    # ATTACK-YOUR-OWN-CODE — this runs even on a re-install of the SAME version
    # number, on purpose. If the target version folder happens to be the one
    # `current` already points at, Copy-AppVersion is about to delete and
    # recreate it; node_modules\*.node files are native DLLs the running
    # process has loaded (LoadLibrary), and Windows will not let those be
    # deleted while they're mapped in. Stopping first, unconditionally,
    # removes that failure mode instead of hoping it never happens.
    Stop-Service -Name $ServiceName -Force
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if ((Get-Service -Name $ServiceName).Status -eq 'Stopped') { return }
        Start-Sleep -Milliseconds 500
    }
    throw "The '$ServiceName' service did not stop within 30 seconds. Stop it manually (Stop-Service $ServiceName) and re-run this installer."
}

# ===========================================================================
# Step: copy the application into versions\<version>\
# ===========================================================================

function Copy-AppVersion {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    if (Test-Path $Destination) {
        # ATTACK-YOUR-OWN-CODE — "what if a version folder for this number
        # already exists?" Three options: refuse, suffix (2.4.0-2), or
        # overwrite. Overwrite is chosen: requirement 7 says re-running this
        # installer must be safe, and the ordinary reason a version folder
        # already exists is a previous attempt at installing this SAME
        # version (interrupted copy, or a rebuilt node_modules for the same
        # version tag) - refusing would break that. Suffixing would leave
        # `current` pointing at a folder name nothing else (switch-version.ps1,
        # a future rollback) expects, for no benefit. It is safe to delete
        # here specifically BECAUSE Stop-ExistingService already ran above,
        # so nothing has these files open.
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null

    # robocopy, not Copy-Item -Recurse: node_modules on a real install is tens
    # of thousands of small files, where Copy-Item -Recurse is dramatically
    # slower and its -Exclude does not reliably match directories the way
    # robocopy's /XD does.
    $roboArgs = @(
        $Source, $Destination,
        '/E',                      # subdirectories, including empty ones
        '/XD', 'data', '.git',     # never copy the old data dir or git metadata
        '/XF', '*.db',             # belt-and-braces: no stray .db file outside data\ either
        '/NFL', '/NDL', '/NJH'     # quiet: no per-file/dir spam, keep the summary
    )
    & robocopy.exe @roboArgs
    # robocopy's exit code is a bitmask, not a boolean: 0-7 all mean success
    # (0 = nothing needed copying, 1 = files copied, ...). 8+ means at least
    # one file failed - that, not "nonzero", is the failure condition.
    if ($LASTEXITCODE -ge 8) {
        throw "Copying '$Source' to '$Destination' failed (robocopy exit code $LASTEXITCODE)."
    }

    if (-not (Test-Path (Join-Path $Destination 'server\index.js'))) {
        throw "'$Source' does not look like an Easy-Med build - server\index.js was not found after copying."
    }
}

# ===========================================================================
# Step: create or repoint the `current` junction
# ===========================================================================

function Set-CurrentJunction {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$VersionDir
    )

    $currentLink = Join-Path $Root 'current'
    if (Test-Path $currentLink) {
        $item = Get-Item -LiteralPath $currentLink -Force
        if ($item.LinkType -ne 'Junction') {
            throw "'$currentLink' already exists and is not a junction (found: $($item.LinkType)). Remove it manually and re-run this installer."
        }
        # VERIFIED (2026-08-21, no admin rights needed to check this): calling
        # .Delete() on a DirectoryInfo that is itself a reparse point removes
        # ONLY the junction/link, never the real folder it points at - the
        # previous version survives untouched. This matters because
        # `Remove-Item -Recurse` on a junction has a long history of instead
        # walking THROUGH the link into the target and deleting its contents,
        # which would destroy the rollback copy this whole layout exists to
        # protect. Tested directly: created a junction, called this, confirmed
        # the target directory and its file were still there afterwards.
        $item.Delete()
    }
    New-Item -ItemType Junction -Path $currentLink -Target $VersionDir | Out-Null
}

# ===========================================================================
# Step: the service launcher
# ===========================================================================

# DECISION — a generated PowerShell launcher in <Root>, not a
# HKLM\...\Services\<name>\Environment REG_MULTI_SZ value, even though sc.exe
# cannot set a service's environment directly and both are workable ways
# around that on their own.
#
# Rejected: the registry Environment value, alone. It would set
# EASYMED_DATA_DIR, but it solves nothing else - a bare node.exe registered
# directly with sc.exe has no console, so nothing written by console.log
# (crucially, the FIRST RUN admin password banner) would go anywhere at all.
# install-service.ps1 is required to surface that password by reading
# <Root>\logs, so something has to redirect stdout/stderr there regardless of
# which mechanism sets the env var - meaning the registry route still needs a
# wrapper for the OTHER half of the problem, and gains nothing by being
# invisible in the registry instead of readable as a plain file in <Root>.
#
# ATTACK-YOUR-OWN-CODE, VERIFIED 2026-08-21 — an earlier version of this
# function generated a three-line .cmd (`set`, `set`, then invoke node with
# `>>` redirection), with sc.exe's binPath pointing at cmd.exe running it.
# That shim was tested end to end and DID work for starting the app and
# capturing its log - but a second, deliberate test (kill only the wrapper
# process, exactly what Stop-Service does to a service that never calls
# StartServiceCtrlDispatcher, and what a future switch-version.ps1 would do
# before repointing `current`) found that node.exe SURVIVED as an orphan,
# still holding the port, indefinitely. Windows does not cascade a kill to
# child processes by default - TerminateProcess targets exactly the process
# named, nothing downstream of it - so "stop the service" would silently NOT
# stop Easy-Med; it would just make Windows lose track of it while it kept
# running. That would break Stop-Service/Start-Service cycles, a future
# version switch, and even this installer's own re-run (Stop-ExistingService
# above assumes stopping the service frees the version folder's files).
#
# The fix: a PowerShell launcher creates a Windows Job Object with
# JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, then starts cmd.exe (running the SAME
# `set` + `set` + node-with->>-redirection line as the original shim - kept
# because it is simple and, unlike what came next, gets the log's line order
# right) as a member of that job. Closing the job's last handle - something
# the OS does automatically while tearing down ANY terminated process, even
# one killed outright with no chance to run its own cleanup code - forces
# every process still in the job to die with it, and child processes of a job
# member automatically join the same job themselves (documented Win32
# behaviour), so node.exe (cmd.exe's child) is covered without being assigned
# to anything directly. Verified repeatedly, killing only the top wrapper:
# cmd.exe and node.exe both die within the same second, every time. No new
# dependency: CreateJobObject/AssignProcessToJobObject are plain Win32 calls,
# reached via Add-Type, part of the .NET Framework every supported Windows
# version already ships.
#
# ATTACK-YOUR-OWN-CODE, ROUND 2 — the first version of this fix assigned
# node.exe DIRECTLY to the job and read its output via .NET's
# RedirectStandardOutput/ErrorDataReceived events instead of routing through
# cmd.exe. It worked for starting the app and for the kill-the-wrapper case,
# but a log inspection caught it producing scrambled, out-of-order lines, and
# separately produced an EMPTY log file for several seconds while the app was
# demonstrably up and answering health checks. Both trace to the same cause:
# PowerShell's Register-ObjectEvent handlers only run when the engine gets an
# idle moment to drain its event queue, and this launcher's last line was a
# single blocking, non-yielding $proc.WaitForExit() - so queued events sat
# unprocessed for as long as node kept running, then arrived in a burst with
# no guaranteed ordering between the separate stdout and stderr streams.
# Switching the actual log redirection back to cmd.exe's own `>>` (which the
# OS performs directly, with no PowerShell event queue involved at all) and
# using the job purely for lifecycle management removes the dependency on
# that queue being pumped altogether.
function New-ServiceLauncher {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][int]$Port
    )

    $launcherPath = Join-Path $Root 'run-easymed.ps1'
    $dataDir = Join-Path $Root 'data'
    $entry = Join-Path $Root 'current\server\index.js'
    $logFile = Join-Path $Root 'logs\service.log'
    $cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'

    # Escaped for embedding inside single-quoted PowerShell string literals in
    # the generated file below (doubling a literal ' is how PS 5.1 escapes one).
    $esc = { param($s) $s -replace "'", "''" }
    $nodeExeLit = & $esc $NodeExe
    $entryLit = & $esc $entry
    $dataDirLit = & $esc $dataDir
    $logFileLit = & $esc $logFile
    $cmdExeLit = & $esc $cmdExe

    # A here-string, not an array of lines like the original .cmd - the C#
    # below needs to stay exactly as written for Add-Type to compile it.
    $template = @'
# SUPERVISED_INSTALL_V1 - generated by install-service.ps1. Do not edit by
# hand; re-run the installer instead, which regenerates this file.
#
# Every value below is an already-resolved absolute path, not a
# PATH-dependent bare name - Windows services run as LocalSystem, whose PATH
# is not this installer's PATH, so nothing here trusts it.
$NodeExe     = '__NODE_EXE__'
$EntryScript = '__ENTRY__'
$DataDir     = '__DATA_DIR__'
$Port        = __PORT__
$LogFile     = '__LOG_FILE__'
$CmdExe      = '__CMD_EXE__'

# A Job Object with KILL_ON_JOB_CLOSE, so that whatever kills THIS launcher
# process (Stop-Service, a crash, switch-version.ps1) also kills cmd.exe AND
# node.exe (which automatically joins the same job as cmd.exe's child) - see
# the New-ServiceLauncher comment in install-service.ps1 for the orphan bug
# this closes. Plain Win32 calls via Add-Type: no new dependency.
$jobObjectSource = @"
using System;
using System.Runtime.InteropServices;

public static class EasyMedJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr a, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public Int64 PerProcessUserTimeLimit;
        public Int64 PerJobUserTimeLimit;
        public UInt32 LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public UInt32 ActiveProcessLimit;
        public UIntPtr Affinity;
        public UInt32 PriorityClass;
        public UInt32 SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public UInt64 ReadOperationCount;
        public UInt64 WriteOperationCount;
        public UInt64 OtherOperationCount;
        public UInt64 ReadTransferCount;
        public UInt64 WriteTransferCount;
        public UInt64 OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public const int JobObjectExtendedLimitInformation = 9;
    public const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    public static IntPtr CreateKillOnCloseJob() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(length);
        Marshal.StructureToPtr(info, ptr, false);
        bool ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)length);
        Marshal.FreeHGlobal(ptr);
        if (!ok) throw new InvalidOperationException("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
        return job;
    }
}
"@
Add-Type -TypeDefinition $jobObjectSource -Language CSharp

$job = [EasyMedJob]::CreateKillOnCloseJob()

# --preserve-symlinks-main IS LOAD-BEARING, not an optimisation - VERIFIED
# 2026-08-21 by actually booting server/index.js through a junction both ways.
# server/index.js only runs its boot sequence when
#   path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
# (isMain - added so importing the file from a test does not also start a
# server). argv[1] is the path as typed on the command line, i.e.
# "...\current\server\index.js". But Node's ESM loader resolves
# import.meta.url THROUGH the `current` junction to its real target,
# "...\versions\<version>\server\index.js" - because that is exactly what a
# junction is, a transparent redirect - so without this flag the two paths
# never match, isMain is false, and node exits instantly and silently: no
# listen(), no console output, no error, exit code 0. It looks like nothing is
# wrong until someone notices the port never opens. --preserve-symlinks-main
# tells Node to keep the entry module's OWN url as given rather than resolving
# it - confirmed with a minimal probe script AND the real server/index.js:
# without the flag isMain is false and nothing boots; with it, isMain is true
# and the app starts normally, including the FIRST RUN banner this log
# depends on. (Plain --preserve-symlinks, the more commonly documented flag,
# was tried first and does NOT fix this - it governs how a module resolves
# ITS OWN dependencies through a symlinked tree, not how the entry file's own
# URL is computed, which is what -main specifically controls.)
#
# cmd.exe does the actual `set` + redirection, exactly like the shim this
# replaced - see the New-ServiceLauncher "ROUND 2" comment for why that,
# rather than .NET-level stream redirection, is what ended up here.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $CmdExe
$psi.Arguments = "/c set ""EASYMED_DATA_DIR=$DataDir"" && set ""PORT=$Port"" && ""$NodeExe"" --preserve-symlinks-main ""$EntryScript"" >> ""$LogFile"" 2>&1"
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)
[EasyMedJob]::AssignProcessToJobObject($job, $proc.Handle) | Out-Null

# Safe to block here: no PowerShell event queue needs pumping (cmd.exe, not
# .NET, is doing the redirection), and if node exits on its own (a crash),
# cmd.exe finishes its chain and exits right behind it, which is what lets
# sc.exe's restart-on-failure policy (registered in Register-EasyMedService)
# notice "the service process died" and act. Verified directly: killing
# node.exe alone reliably makes cmd.exe (and this launcher) exit within the
# same second.
$proc.WaitForExit()
'@

    $content = $template `
        -replace '__NODE_EXE__', $nodeExeLit `
        -replace '__ENTRY__', $entryLit `
        -replace '__DATA_DIR__', $dataDirLit `
        -replace '__PORT__', [string]$Port `
        -replace '__LOG_FILE__', $logFileLit `
        -replace '__CMD_EXE__', $cmdExeLit

    Set-Content -LiteralPath $launcherPath -Value $content -Encoding UTF8
    return $launcherPath
}

# ===========================================================================
# Step: register the service
# ===========================================================================

function Register-EasyMedService {
    param(
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][string]$LauncherPath
    )

    $psExe = Resolve-PowerShellExePath
    # sc.exe's binPath must name a real Windows executable, not a .ps1 - the
    # service "is" powershell.exe, which runs the launcher as its one job. The
    # nested quoting (a quoted powershell.exe path, its arguments, then a
    # quoted launcher path, the whole thing then quoted AGAIN because it
    # contains spaces) is the documented working pattern for sc.exe binPath
    # with paths that have spaces - and this source path has one
    # ("...implementation workflow\easymed.local"), so it was tested against
    # exactly that, not assumed.
    $binPathValue = '"' + $psExe + '" -NoProfile -ExecutionPolicy Bypass -File "' + $LauncherPath + '"'

    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        & sc.exe @('config', $ServiceName, 'binPath=', $binPathValue, 'start=', 'auto', 'DisplayName=', 'Easy-Med Local') | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "sc.exe config failed for '$ServiceName' (exit code $LASTEXITCODE)." }
    } else {
        & sc.exe @('create', $ServiceName, 'binPath=', $binPathValue, 'start=', 'auto', 'DisplayName=', 'Easy-Med Local') | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed for '$ServiceName' (exit code $LASTEXITCODE)." }
    }

    # NOTE — neither powershell.exe nor node.exe here ever calls
    # StartServiceCtrlDispatcher, which is how a real Windows service tells the
    # Service Control Manager "I have started" and later "I am handling your
    # stop request". Stopping this service is therefore a hard kill of the
    # launcher, not a graceful shutdown - it gets no notification at all. That
    # is accepted (see install/README.md - SQLite's WAL mode is crash-safe and
    # the app keeps no unflushed state that a clean shutdown would need to
    # flush). The launcher's Job Object (see New-ServiceLauncher) makes sure
    # that kill actually reaches node.exe too, rather than orphaning it - see
    # that function's comment for the bug this closes. A crash and an
    # operator-requested stop therefore look identical to Windows: both are
    # just the launcher process disappearing, taking node.exe with it. That is
    # exactly what the restart policy below is for - it cannot tell "crashed"
    # from "stopped", so it restarts either way up to the counters below, and a
    # deliberate uninstall must delete the service, not rely on stopping it
    # looking permanent.
    & sc.exe @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/5000/restart/5000/restart/60000') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe failure (restart policy) failed for '$ServiceName' (exit code $LASTEXITCODE)." }

    & sc.exe @('description', $ServiceName, 'Easy-Med Local clinic system. Stopping this service ends the process immediately, not gracefully - see install\README.md.') | Out-Null
}

# ===========================================================================
# Step: start it, and wait for it to actually answer
# ===========================================================================

function Wait-ForEasyMedHealthy {
    param(
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][int]$Port,
        [int]$TimeoutSeconds = 60
    )

    & sc.exe @('start', $ServiceName) | Out-Null
    # sc.exe start's own exit code only reports whether the Service Control
    # Manager ACCEPTED the start request, not whether node.exe went on to open
    # the port.

    # UNVERIFIED, FLAGGED — this whole install could not be tested against a
    # REAL registered service in this session (no administrator rights were
    # available here, confirmed: sc.exe create itself returns "Access is
    # denied"). The one thing that could not be checked as a result: whether
    # Get-Service ever reports 'Running' for a process that never calls
    # StartServiceCtrlDispatcher (which powershell.exe/cmd.exe/node.exe here
    # never do - see Register-EasyMedService). That is a well-known Windows
    # requirement for a service to be considered started, and its absence is
    # what commonly produces "Error 1053: the service did not respond in a
    # timely fashion" for a raw executable registered this way. If Get-Service
    # never flips to Running even though the app is genuinely up underneath,
    # gating on it here would report failure for an install that actually
    # worked - so this polls the health endpoint on its own merits and treats
    # THAT as ground truth, independent of what Get-Service says. Whoever
    # runs this with real admin rights should check Get-Service's status
    # after a successful health check, specifically to see whether it says
    # Running or something else.
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            # 127.0.0.1, NEVER localhost: in a fresh (child) PowerShell, localhost resolves
            # ::1 first, the server listens on IPv4 0.0.0.0 only, and the IPv6 attempt
            # eats the whole -TimeoutSec before any fallback — every health poll "fails"
            # while the clinic is up (reproduced on the owner's machine, 2026-08-23).
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
            if ($resp.ok -eq $true) { return $true }
        } catch {
            # not answering yet - keep polling until the deadline
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Write-FirstRunPasswordIfAny {
    param([Parameter(Mandatory)][string]$Root)

    $logPath = Join-Path $Root 'logs\service.log'
    if (-not (Test-Path $logPath)) { return }

    # The banner in server/index.js prints "username: admin" then
    # "password: <generated>" only on the very first boot against an empty
    # database. Read from the tail, not the whole file, so a long-lived
    # service's log does not have to be scanned end to end every time this
    # runs.
    $tail = Get-Content -LiteralPath $logPath -Tail 200
    $passwordLine = $tail | Select-String 'password:' | Select-Object -Last 1
    if (-not $passwordLine) { return }

    Write-Host ''
    Write-Host 'FIRST RUN - an admin account was created (read from the service log):' -ForegroundColor Green
    Write-Host "  username: admin"
    Write-Host "  $($passwordLine.Line.Trim())"
    Write-Host '  Log in and change this password.'
}

# ===========================================================================
# Main
# ===========================================================================

function Main {
    Assert-Administrator

    Write-Host ''
    Write-Host '=== Easy-Med Local installer ===' -ForegroundColor Cyan

    $resolvedSource = (Resolve-Path -LiteralPath $Source).Path
    $pkgPath = Join-Path $resolvedSource 'package.json'
    if (-not (Test-Path $pkgPath)) {
        throw "'$resolvedSource' does not look like an Easy-Med build - package.json was not found."
    }

    $resolvedVersion = $Version
    if (-not $resolvedVersion) {
        $resolvedVersion = (Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json).version
    }
    if (-not $resolvedVersion) {
        throw "Could not determine a version - pass -Version explicitly, or fix '$pkgPath' to have a version field."
    }

    Write-Host "Source:  $resolvedSource"
    Write-Host "Version: $resolvedVersion"
    Write-Host "Root:    $Root"
    Write-Host "Service: $ServiceName  (port $Port)"

    $nodeExe = Resolve-NodeExePath
    Write-Host "Node:    $nodeExe"

    $dataPreExisted = Initialize-Layout -Root $Root
    if ($dataPreExisted) {
        Write-Host ''
        Write-Host "Existing data at '$Root\data' was found and has been left completely untouched." -ForegroundColor Green
    } else {
        Write-Host "A new, empty data folder was created at '$Root\data'."
    }

    Stop-ExistingService -ServiceName $ServiceName

    $versionDir = Join-Path $Root "versions\$resolvedVersion"
    Write-Host "Copying application files to '$versionDir'..."
    Copy-AppVersion -Source $resolvedSource -Destination $versionDir

    Write-Host "Pointing 'current' at version $resolvedVersion..."
    Set-CurrentJunction -Root $Root -VersionDir $versionDir

    $launcherPath = New-ServiceLauncher -Root $Root -NodeExe $nodeExe -Port $Port
    Register-EasyMedService -ServiceName $ServiceName -LauncherPath $launcherPath

    Write-Host "Starting the '$ServiceName' service..."
    $healthy = Wait-ForEasyMedHealthy -ServiceName $ServiceName -Port $Port

    if ($healthy) {
        Write-Host ''
        Write-Host 'Easy-Med is running.' -ForegroundColor Green
        Write-Host "  Open:  http://localhost:$Port"
        Write-FirstRunPasswordIfAny -Root $Root
        Write-Host ''
        Write-Host "Stopping this service (Stop-Service $ServiceName, or restarting Windows) ends the" -ForegroundColor Yellow
        Write-Host "process immediately - it is not a graceful shutdown. This is fine: the database" -ForegroundColor Yellow
        Write-Host "is crash-safe. See install\README.md." -ForegroundColor Yellow
    } else {
        Write-Host ''
        Write-Host "Easy-Med did not answer at http://localhost:$Port/api/health within the expected time." -ForegroundColor Red
        Write-Host "Check:" -ForegroundColor Red
        Write-Host "  Get-Service $ServiceName"
        Write-Host "  Get-Content '$Root\logs\service.log' -Tail 50"
        exit 1
    }
}

# Only run Main when this file is executed directly - dot-sourcing it (as this
# script's own test suite does) loads the functions above without registering
# anything, so each piece can be exercised on its own against a scratch root.
if ($MyInvocation.InvocationName -ne '.') {
    Main
}
