# Assembles a self-contained clinic package: a folder the vendor copy-pastes onto
# a clinic PC, where double-clicking EasyMed.exe is the whole installation.
#
#   powershell -ExecutionPolicy Bypass -File install\make-clinic-package.ps1 `
#       -Dest "D:\easymed.clinic" `
#       -Tar "C:\Downloads\easymed-0.1.3.tar.gz" `
#       -Manifest "C:\Downloads\easymed-0.1.3.manifest.json"
#
# Resulting layout (data\ stays OUTSIDE versions\ so updates never touch records):
#   EasyMed.exe            the launcher (built here from install\launcher\EasyMed.cs)
#   runtime\node.exe       bundled Node — the clinic PC needs nothing preinstalled
#   versions\<v>\          the application, exactly as the signed release shipped it
#   data\                  empty; the clinic's DB + licence identity appear on first run
#   recover.cmd            double-click: point `current` back at the previous version
#   README-УСТАНОВКА.txt   for the person doing the copy-paste
#
# The `current` junction is NOT created here on purpose: junctions do not survive
# copy-paste between machines, so the launcher builds it on the clinic PC instead.
param(
    [Parameter(Mandatory=$true)][string]$Dest,
    [Parameter(Mandatory=$true)][string]$Tar,
    [Parameter(Mandatory=$true)][string]$Manifest,
    [string]$NodeExe = "",
    # Pins this package to its own port via port.txt (the launcher's precedence:
    # arg > EASYMED_PORT > port.txt > 8000). Two Easy-Med installs on one
    # machine MUST differ here or the second silently answers for the first —
    # the owner's dev(:8000)-vs-test-clinic collision of 2026-08-23. Pick an
    # uncommon port (e.g. 8712), not 8000/8080/3000 that other software grabs.
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $Tar))      { throw "Bundle not found: $Tar" }
if (-not (Test-Path $Manifest)) { throw "Manifest not found: $Manifest" }

# ── 1. Verify the release BEFORE unpacking anything ─────────────────────────────
# Same rule as the in-app updater: signature first, and against the SAME key the
# clinics trust — extracted from updater.js itself, so this script can never
# quietly verify against a different key than the fleet does.
$verifyScript = Join-Path $env:TEMP "easymed-verify-$PID.mjs"
@'
import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [,, repoRoot, tarPath, manifestPath] = process.argv;
const { verifyBundle } = await import(pathToFileURL(repoRoot + '/server/services/control/bundle.js'));
const src = readFileSync(repoRoot + '/server/services/control/updater.js', 'utf8');
const m = src.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/);
if (!m) { console.error('no release public key found in updater.js'); process.exit(1); }
const r = verifyBundle({ tarPath, manifestPath, publicKey: createPublicKey(m[0]) });
if (!r.ok) { console.error('VERIFY FAILED: ' + r.reason); process.exit(1); }
console.log(r.manifest.version);
'@ | Set-Content -Path $verifyScript -Encoding utf8

try {
    $version = (& node $verifyScript $repoRoot (Resolve-Path $Tar).Path (Resolve-Path $Manifest).Path) | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0) { throw "Release verification FAILED — refusing to package. See message above." }
} finally {
    Remove-Item $verifyScript -Force -ErrorAction SilentlyContinue
}
$version = "$version".Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Unexpected version from manifest: '$version'" }
Write-Host "Verified release $version (signature + sha256 OK against the clinic-trusted key)"

# ── 2. Unpack into versions\<v> ────────────────────────────────────────────────
$versionDir = Join-Path $Dest "versions\$version"
if (Test-Path (Join-Path $versionDir 'server\index.js')) {
    Write-Host "versions\$version already present — leaving it as is"
} else {
    New-Item -ItemType Directory -Force $versionDir | Out-Null
    # System32 tar explicitly: Git Bash's GNU tar on the same PATH reads "C:" as a
    # hostname and fails in ways that look like a corrupt archive.
    & "$env:windir\System32\tar.exe" -xzf (Resolve-Path $Tar).Path -C $versionDir
    if ($LASTEXITCODE -ne 0) { throw "tar extraction failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path (Join-Path $versionDir 'server\index.js'))) {
        throw "Extraction finished but versions\$version\server\index.js is missing — wrong archive?"
    }
    Write-Host "Unpacked to versions\$version"
}

# ── 3. Build the launcher into the package root ────────────────────────────────
& (Join-Path $PSScriptRoot 'build-launcher.ps1') -OutDir $Dest

# NODE_NATIVE_UPDATES_V1 — the manual way back, in the package ROOT where a
# clinic manager can find it, not buried in versions\<v>\install\. It replaces
# apply-update.ps1's automatic post-switch rollback, which polled the OLD
# process on a launcher install and therefore vouched for switches it never
# verified. Copied from the repo (never generated here) so there is exactly one
# copy to maintain. It is deliberately NOT updated by a release: an update
# bundle unpacks into versions\<v>\, and the root copy is the one thing that
# must keep working even when the newest version does not.
Copy-Item (Join-Path $PSScriptRoot 'recover.cmd') (Join-Path $Dest 'recover.cmd') -Force
Write-Host "Added recover.cmd (roll back to the previous version, no admin rights needed)"

# ── 4. Bundled Node runtime ────────────────────────────────────────────────────
# node.exe alone is a complete runtime for this app (no npm needed at the clinic);
# taking it from THIS machine means the package runs the same Node it was tested on.
if ($NodeExe -eq "") {
    try { $NodeExe = (Get-Command node -ErrorAction Stop).Source } catch { $NodeExe = "C:\Program Files\nodejs\node.exe" }
}
if (-not (Test-Path $NodeExe)) { throw "node.exe not found (looked at: $NodeExe). Pass -NodeExe explicitly." }
New-Item -ItemType Directory -Force (Join-Path $Dest 'runtime') | Out-Null
Copy-Item $NodeExe (Join-Path $Dest 'runtime\node.exe') -Force
Write-Host "Bundled runtime\node.exe ($([math]::Round((Get-Item $NodeExe).Length / 1MB)) MB, $(& $NodeExe --version))"

# ── 5. Empty data\ ─────────────────────────────────────────────────────────────
# Deliberately empty: the first boot creates a fresh DB with the default admin
# login, and enrollment (the EM-XXXX-XXXX code) gives THIS clinic its own identity.
# A package that shipped with a pre-made data\ would clone one clinic's identity
# onto every install.
New-Item -ItemType Directory -Force (Join-Path $Dest 'data') | Out-Null

# Pinned port, if requested — one number in a file a technician can edit in
# Notepad. Written BEFORE the README so the README below can tell the truth
# about which port this install actually uses.
$docPort = 8000
if ($Port -gt 0) {
    Set-Content -Path (Join-Path $Dest 'port.txt') -Value $Port -Encoding ascii
    $docPort = $Port
}

# ── 6. README for the person doing the install ─────────────────────────────────
$readme = @'
EASY-MED — УСТАНОВКА В КЛИНИКЕ
================================================================

ЧТО ЭТО
  Полный комплект системы Easy-Med. Ничего устанавливать не нужно:
  ни Node.js, ни баз данных — всё уже внутри этой папки.

УСТАНОВКА (один раз)
  1. Скопируйте ВСЮ эту папку на компьютер клиники,
     например в  C:\EasyMed
     (не на рабочий стол другого пользователя и не в Program Files).
  2. Откройте папку и запустите  EasyMed.exe  двойным щелчком.
  3. Браузер откроется сам. Первый вход:
        логин:   admin
        пароль:  123456789
     Система сразу попросит придумать новый пароль.
  4. Введите код активации (вида EM-XXXX-XXXX), который выдал
     поставщик. Код вводится один раз.

КАЖДЫЙ ДЕНЬ
  Запустить систему  — двойной щелчок по EasyMed.exe.
  Остановить систему — закрыть чёрное окно Easy-Med.
  Пока окно открыто, система работает.

ДРУГИЕ КОМПЬЮТЕРЫ КЛИНИКИ
  Они открывают в браузере адрес   http://<этот-компьютер>:8000
  Если не подключаются — на главном компьютере один раз выполните
  от имени администратора:
      netsh advfirewall firewall add rule name="EasyMed (clinic network)" dir=in action=allow protocol=TCP localport=8000
  (Окно Easy-Med само напомнит эту команду, если она нужна.)

ЕСЛИ ПОРТ 8000 ЗАНЯТ
  Создайте рядом с EasyMed.exe файл  port.txt  с одним числом,
  например  8010  — и запустите заново.

ДАННЫЕ КЛИНИКИ
  Всё лежит в папке  data\  (база, документы, лицензия).
  Резервная копия = копия папки data\ при ЗАКРЫТОЙ системе.
  При обновлениях системы папка data\ не затрагивается.

ОБНОВЛЕНИЯ
  Приходят сами. Администратор видит предложение в разделе
  «Обновления», подтверждает и выбирает удобный час. Ничего
  скачивать вручную не нужно.
  Обновление применяется при следующем запуске окна Easy-Med.

ЕСЛИ ПОСЛЕ ОБНОВЛЕНИЯ ЧТО-ТО НЕ ТАК
  Закройте окно Easy-Med и запустите  recover.cmd  (лежит рядом с
  EasyMed.exe) — система вернётся к предыдущей версии, она никуда
  не удаляется. Права администратора не нужны, данные клиники не
  затрагиваются. После этого снова запустите EasyMed.exe.
'@
# Every 8000 in the template is a port reference, so a blanket replace keeps
# the whole README truthful for a pinned-port package with one line.
$readme = $readme -replace '8000', "$docPort"
[System.IO.File]::WriteAllText((Join-Path $Dest 'README-УСТАНОВКА.txt'), $readme, (New-Object System.Text.UTF8Encoding $true))

Write-Host ""
Write-Host "Package ready: $Dest"
Write-Host "  EasyMed.exe + runtime\node.exe + versions\$version + data\ (empty) + README"
Write-Host "  Copy the WHOLE folder to the clinic PC and double-click EasyMed.exe."
