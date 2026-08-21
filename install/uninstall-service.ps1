<#
.SYNOPSIS
    Removes the Easy-Med Windows service. Does NOT touch the clinic's data.

.DESCRIPTION
    This script removes only the Windows service registration created by
    install-service.ps1. It never deletes <Root>\data, and it never deletes
    <Root>\versions, <Root>\current or <Root>\logs either - only the service
    entry itself goes away. A clinic uninstalling the auto-start behaviour can
    still run the app by hand later (npm start against <Root>\current), and
    re-running install-service.ps1 rebuilds the service against the same,
    untouched data.

.PARAMETER Root
    Where Easy-Med lives on this PC. Defaults to C:\EasyMed. Pass a scratch
    path when testing.

.PARAMETER ServiceName
    Windows service name. Defaults to EasyMed.

.EXAMPLE
    .\uninstall-service.ps1
    Removes the real EasyMed service from C:\EasyMed, leaving C:\EasyMed\data in place.
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\EasyMed',

    [string]$ServiceName = 'EasyMed'
)

$ErrorActionPreference = 'Stop'

function Test-Administrator {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
    if (Test-Administrator) { return }
    Write-Host ''
    Write-Host 'Easy-Med could not be uninstalled: this window is not running as Administrator.' -ForegroundColor Red
    Write-Host 'Removing a Windows service is something only an administrator can do.' -ForegroundColor Red
    Write-Host ''
    Write-Host 'To fix this:' -ForegroundColor Yellow
    Write-Host '  1. Close this window.'
    Write-Host '  2. Find PowerShell in the Start menu, right-click it, and choose'
    Write-Host '     "Run as administrator".'
    Write-Host '  3. Run this same command again.'
    Write-Host ''
    exit 1
}

function Remove-EasyMedService {
    param([Parameter(Mandatory)][string]$ServiceName)

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Host "No '$ServiceName' service was found - nothing to remove."
        return
    }

    if ($svc.Status -ne 'Stopped') {
        Write-Host "Stopping the '$ServiceName' service..."
        # See install-service.ps1's Register-EasyMedService comment: this is a
        # hard kill, not a graceful shutdown, because a bare node.exe process
        # never registered to handle service control messages. Accepted
        # because SQLite's WAL mode is crash-safe - see install/README.md.
        Stop-Service -Name $ServiceName -Force
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline -and (Get-Service -Name $ServiceName).Status -ne 'Stopped') {
            Start-Sleep -Milliseconds 500
        }
    }

    Write-Host "Deleting the '$ServiceName' service registration..."
    # Windows PowerShell 5.1 has no Remove-Service cmdlet (added in PowerShell
    # 6+); sc.exe delete works on every version and is what install-service.ps1
    # already uses for create/config, so uninstall stays consistent with it.
    & sc.exe @('delete', $ServiceName) | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "sc.exe delete failed for '$ServiceName' (exit code $LASTEXITCODE). The service may still be marked for deletion - a reboot clears that."
    }
}

function Main {
    Assert-Administrator

    Write-Host ''
    Write-Host '=== Easy-Med Local uninstaller ===' -ForegroundColor Cyan
    Write-Host "Root:    $Root"
    Write-Host "Service: $ServiceName"
    Write-Host ''

    Remove-EasyMedService -ServiceName $ServiceName

    $dataDir = Join-Path $Root 'data'
    Write-Host ''
    Write-Host 'The Windows service has been removed. Easy-Med will no longer start automatically.' -ForegroundColor Green
    Write-Host ''
    if (Test-Path $dataDir) {
        Write-Host '*** Your clinic records have NOT been deleted. ***' -ForegroundColor Green
        Write-Host "They are still here:  $dataDir" -ForegroundColor Green
        Write-Host 'That folder (patients, visits, the licence, uploaded files, and the pre-update' -ForegroundColor Green
        Write-Host "backups in $dataDir\backups) is untouched by this script. Copy it to back it up." -ForegroundColor Green
    } else {
        Write-Host "No data folder was found at $dataDir - there may never have been one, or it lives" -ForegroundColor Yellow
        Write-Host 'somewhere else if EASYMED_DATA_DIR was customised.' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host "The application files under $Root (versions, current, logs) were left in place too -"
    Write-Host 'only the Windows service entry was removed. Delete the rest by hand if you are'
    Write-Host 'decommissioning this PC entirely; otherwise re-running install-service.ps1 will'
    Write-Host 'reinstall the service against this same, untouched data.'
}

if ($MyInvocation.InvocationName -ne '.') {
    Main
}
