# Собирает easymedSetup-<версия>.exe — ОДИН файл, который ставит клинику.
#
#   powershell -ExecutionPolicy Bypass -File install\make-setup-exe.ps1 `
#       -Package "C:\...\easymed-package-0.6.8" `
#       -OutDir  "C:\...\Desktop"
#
# Внутрь кладётся готовый пакет клиники (install\make-clinic-package.ps1),
# то есть раскладка versions\<v> + data\ + EasyMed.exe + runtime\, которая
# УМЕЕТ обновляться. Установщик ничего не выдумывает — он распаковывает уже
# проверенное.
#
# ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Клиники ставили сторонним easymedSetup.exe,
# раскладывавшим приложение плоско в одну папку. Обновление работает как
# «распаковать рядом и переставить current», поэтому такая установка не могла
# принять НИ ОДНОГО обновления: переставлять было нечего. Ошибка не видна на
# машине, где клиника поставлена службой, — там всё обновлялось, — и стоила
# целого дня поисков 2026-09-02.
#
# Пакет внутрь берётся ГОТОВЫЙ, а не собирается здесь: make-clinic-package.ps1
# уже проверяет подпись релиза и отказывается паковать непроверенное. Двух
# мест, умеющих раскладывать клинику, быть не должно — разойдутся.
param(
    [Parameter(Mandatory=$true)][string]$Package,
    [string]$OutDir = ".",
    [string]$Name
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Package)) { throw "Package folder not found: $Package" }
$pkg = (Resolve-Path $Package).Path

# Пакет обязан быть НАСТОЯЩИМ пакетом клиники. Проверяем то, без чего установка
# не сможет обновляться, — ровно ту раскладку, ради которой всё написано.
foreach ($need in @('EasyMed.exe', 'versions', 'runtime')) {
    if (-not (Test-Path (Join-Path $pkg $need))) {
        throw "Not a clinic package: $need is missing from $pkg"
    }
}
$versionDirs = Get-ChildItem -Directory (Join-Path $pkg 'versions')
if ($versionDirs.Count -ne 1) {
    throw "Expected exactly one folder under versions\, found $($versionDirs.Count) — package the release cleanly"
}
$version = $versionDirs[0].Name
if (-not (Test-Path (Join-Path $versionDirs[0].FullName 'server\index.js'))) {
    throw "versions\$version\server\index.js is missing — wrong or half-built package"
}
Write-Host "Package: $pkg (version $version)"

if (-not $Name) { $Name = "easymedSetup-$version.exe" }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }
$outPath = Join-Path (Resolve-Path $OutDir).Path $Name

# ── 1. Пакет в zip ────────────────────────────────────────────────────────────
# data\ НЕ кладём: она пустая в пакете, а на машине клиники может быть полной, и
# ни одна её строка не должна приехать из установщика. Установщик создаст пустую
# data\ сам, если её нет.
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("em-setup-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
$zipPath = Join-Path $tmp 'payload.zip'
try {
    $items = Get-ChildItem -Force $pkg | Where-Object { $_.Name -ne 'data' }
    Compress-Archive -Path $items.FullName -DestinationPath $zipPath -CompressionLevel Optimal -Force
    $zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    Write-Host "Payload: $zipMb MB"

    # ── 2. Компиляция ─────────────────────────────────────────────────────────
    # csc из .NET Framework — он есть на любой Windows 10/11, как и у лаунчера.
    $csc = "$env:windir\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path $csc)) { $csc = "$env:windir\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
    if (-not (Test-Path $csc)) { throw ".NET Framework compiler (csc.exe) not found on this Windows." }

    $src = Join-Path $PSScriptRoot 'setup\EasyMedSetup.cs'
    if (-not (Test-Path $src)) { throw "Installer source not found: $src" }

    if (Test-Path $outPath) { Remove-Item $outPath -Force }

    & $csc -nologo -optimize+ -platform:anycpu -target:exe `
        -r:System.IO.Compression.dll -r:System.IO.Compression.FileSystem.dll `
        -resource:"$zipPath,payload.zip" `
        -out:"$outPath" "$src"
    if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$outMb = [math]::Round((Get-Item $outPath).Length / 1MB, 1)
Write-Host ""
Write-Host "Готово: $outPath ($outMb MB, версия $version)"
Write-Host "Отдайте этот ОДИН файл клинике. Двойной клик — и система установлена."
