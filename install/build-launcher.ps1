# Compiles install/launcher/EasyMed.cs into EasyMed.exe using the C# compiler
# that ships with Windows itself (.NET Framework 4). No SDK, no npm package,
# no download — any clinic PC can rebuild the launcher.
#
#   powershell -ExecutionPolicy Bypass -File install\build-launcher.ps1
#   powershell -ExecutionPolicy Bypass -File install\build-launcher.ps1 -OutDir "D:\easymed.clinic"
#
# Default output: install\launcher\EasyMed.exe (next to the source).
param(
    [string]$OutDir = ""
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot          # repo root (install\..)
$src  = Join-Path $PSScriptRoot 'launcher\EasyMed.cs'
if (-not (Test-Path $src)) { throw "Source not found: $src" }

if ($OutDir -eq "") { $OutDir = Join-Path $PSScriptRoot 'launcher' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }
$exe = Join-Path $OutDir 'EasyMed.exe'

# csc ships in the Framework directory on every Windows 10/11 install.
$csc = "$env:windir\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = "$env:windir\Microsoft.NET\Framework\v4.0.30319\csc.exe"   # 32-bit fallback
}
if (-not (Test-Path $csc)) { throw ".NET Framework compiler (csc.exe) not found on this Windows." }

# A running EasyMed.exe holds a lock on the file and csc's failure message for
# that is cryptic — check first and say it plainly.
if (Test-Path $exe) {
    try {
        $fs = [System.IO.File]::Open($exe, 'Open', 'ReadWrite', 'None')
        $fs.Close()
    } catch {
        throw "EasyMed.exe is locked (likely running). Close the Easy-Med window, then re-run this script."
    }
}

$before = $null
if (Test-Path $exe) { $before = (Get-Item $exe).LastWriteTimeUtc }

& $csc /nologo /target:exe /platform:anycpu /optimize+ /out:"$exe" "$src"
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

# csc can exit 0 yet leave an old exe behind if the path was subtly wrong —
# verify the file actually changed (or newly appeared).
if (-not (Test-Path $exe)) { throw "Compile reported success but $exe does not exist." }
$after = (Get-Item $exe).LastWriteTimeUtc
if ($null -ne $before -and $after -eq $before) { throw "Compile reported success but $exe was not rewritten." }

Write-Host "Built: $exe"
