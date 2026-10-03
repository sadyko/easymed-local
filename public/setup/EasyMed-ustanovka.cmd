@echo off
rem ===========================================================================
rem  EasyMed - one-time setup of a clinic PC (PC_SETUP_INSTALL_V1).
rem
rem  Lets Chrome / Edge / Yandex show the "Install" icon in the address bar for
rem  the EasyMed server on the clinic network (http://10.x.x.x:8000), which the
rem  browser otherwise refuses: a plain-http LAN address is not a "secure
rem  context". The fix is the browser policy
rem  OverrideSecurityRestrictionsOnInsecureOrigin, written machine-wide.
rem
rem  THIS PART IS ASCII ON PURPOSE. cmd.exe reads a batch file in the console
rem  codepage (866 on a Russian Windows), so Russian text here would turn into
rem  garbage. All the work - and every word the user sees - is the PowerShell
rem  script below the marker line. cmd never reaches it (exit /b comes first);
rem  PowerShell reads this same file back as UTF-8 and runs only what follows
rem  the marker. Run as:  EasyMed-ustanovka.cmd          (menu)
rem                       EasyMed-ustanovka.cmd /remove  (undo)
rem  The path travels in an environment variable, not on a command line, so
rem  spaces, brackets, apostrophes or "&" in the download folder cannot break
rem  the quoting.
rem ===========================================================================
setlocal
set "EM_SELF=%~f0"
set "EM_A1=%~1"
set "EM_A2=%~2"
set "EM_A3=%~3"
set "EM_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "EM_PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%EM_PS%" -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:EM_SELF,[Text.Encoding]::UTF8);$m='#'+'#EM-PS1-BEGIN##';$i=$t.IndexOf($m);if($i -lt 0){exit 9};& ([ScriptBlock]::Create($t.Substring($i+$m.Length)))"
exit /b %ERRORLEVEL%
##EM-PS1-BEGIN##
# ============================================================================
# PC_SETUP_INSTALL_V1 — настройка компьютера клиники, один раз.
#
# Зачем. EasyMed ставится как приложение значком «Установить» справа в
# адресной строке (PWA_ADDRESS_BAR_ONLY_V1). На самом сервере
# (http://localhost:8000) значок есть и так. На других компьютерах клиники
# адрес — http://10.x.x.x:8000, и Chrome отвечает «not-from-secure-origin»:
# http по IP в сети — не «защищённый» адрес, значит ни сервис-воркера, ни
# значка. Проверено Chrome'овским Page.getInstallabilityErrors: с флагом
# --unsafely-treat-insecure-origin-as-secure=<адрес> ошибок установки нет.
# Тот же флаг, но постоянный и для всех пользователей компьютера, — политика
# браузера OverrideSecurityRestrictionsOnInsecureOrigin. Её этот файл и пишет.
#
# Куда (сверено с документацией 2026-10-03):
#   HKLM\SOFTWARE\Policies\Google\Chrome\OverrideSecurityRestrictionsOnInsecureOrigin
#   HKLM\SOFTWARE\Policies\Microsoft\Edge\OverrideSecurityRestrictionsOnInsecureOrigin
#   HKLM\SOFTWARE\Policies\YandexBrowser\OverrideSecurityRestrictionsOnInsecureOrigin
# Политика — СПИСОК: подраздел с именем политики, в нём строковые (REG_SZ)
# значения «1», «2», … — по одному адресу. Chrome: chromeenterprise.google
# (policy_templates, тип list) и генератор шаблонов Chromium
# (Software\Policies\Google\Chrome\<Политика>\1 = "…"); Edge: learn.microsoft.com,
# «Value name: 1, 2, 3, … Value type: List of REG_SZ»; Яндекс: справка
# «Браузера для организаций» — тот же вид списка в
# HKLM\SOFTWARE\Policies\YandexBrowser. Работает ли политика в обычном
# (не корпоративном) Яндекс Браузере — НЕ проверено, поэтому пишем и туда, но
# честно говорим об этом. Загрузчик Chromium берёт все числовые имена подряд
# и на пропусках не спотыкается (registry_dict.cc), поэтому:
#   * чужие значения не трогаем никогда, свой адрес второй раз не пишем;
#   * новый адрес — под номером (наибольший + 1);
#   * отмена убирает ТОЛЬКО значения с нашим адресом, а сам подраздел — только
#     если после этого он опустел.
# Пишем через .NET (CreateSubKey / OpenSubKey), а не New-Item -Force: у
# реестра New-Item -Force на существующем разделе пересоздаёт его ПУСТЫМ —
# то есть стёр бы чужие адреса и чужие политики.
#
# Проверка без настоящего реестра: переменная EM_SETUP_TEST_RUN=<имя> (или
# скрытый ключ /selftest) — пишем в HKCU\Software\EasyMedSetupTest\<имя> и
# прав администратора не просим. EM_SETUP_LIBONLY=1 — только объявить функции (для проверки
# разбора адреса). Проверки: public/setup/__tests__/pc-setup-install.test.mjs.
# ============================================================================

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
try { [Console]::InputEncoding  = New-Object System.Text.UTF8Encoding($false) } catch {}
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$EmPolicyName  = 'OverrideSecurityRestrictionsOnInsecureOrigin'
$EmDefaultPort = 8000
$EmBrowsers = @(
    @{ Name = 'Google Chrome';  Key = 'Google\Chrome';  Unverified = $false },
    @{ Name = 'Microsoft Edge'; Key = 'Microsoft\Edge'; Unverified = $false },
    @{ Name = 'Яндекс Браузер'; Key = 'YandexBrowser';  Unverified = $true }
)
$EmMaxTries = 5

function New-EmResult([bool]$Ok, [string]$Origin, [string]$Message) {
    [pscustomobject]@{ Ok = $Ok; Origin = $Origin; Error = $Message }
}

# Адрес — в «происхождение» http://ХОСТ:ПОРТ, ровно как его ждёт политика.
# Принимает 10.4.1.36, 10.4.1.36:8000, http://10.4.1.36:8000/admin.html и имя
# компьютера. Без порта — 8000 (так EasyMed работает в каждой клинике); для
# адреса из Zone.Identifier файла порт по умолчанию передаётся 80 — там записан
# точный URL, и «без порта» значит именно 80.
function ConvertTo-EmOrigin {
    param([AllowNull()][AllowEmptyString()][string]$Text, [int]$DefaultPort = 8000)
    $generic = 'Не похоже на адрес. Введите его так, как он виден в адресной строке, например 10.4.1.36 или 10.4.1.36:8000.'
    $s = if ($null -eq $Text) { '' } else { [string]$Text }
    $s = $s.Trim().Trim([char[]]('"', "'", '<', '>', [char]0x00AB, [char]0x00BB)).Trim()
    if ($s -eq '') { return New-EmResult $false $null 'Адрес не введён.' }
    # Русская раскладка: точка на английской клавиатуре — это «ю», двоеточие — «Ж».
    $s = $s.Replace([string][char]0x044E, '.').Replace([string][char]0x042E, '.')
    $s = $s.Replace([string][char]0x0436, ':').Replace([string][char]0x0416, ':')
    if ($s -match '\p{IsCyrillic}') {
        return New-EmResult $false $null 'В адресе русские буквы — похоже, включена русская раскладка. Переключите на английскую (Alt+Shift) и введите адрес ещё раз.'
    }
    if ($s -match '[^\x21-\x7E]') {
        return New-EmResult $false $null 'В адресе пробелы или лишние знаки. Введите его так, как в адресной строке, например 10.4.1.36:8000.'
    }
    if ($s -match '^(?i)https://') {
        return New-EmResult $false $null 'Адрес начинается с https:// — для такого адреса настройка не нужна: браузер и так покажет значок установки. Этот файл нужен только для адресов вида http://10.4.1.36:8000.'
    }
    if ($s -match '^(?i)http://') { $s = $s.Substring(7) }
    elseif ($s -match '^[A-Za-z][A-Za-z0-9+.-]*://') { return New-EmResult $false $null $generic }
    if ($s -match '^(?i)https?(:|/|$)') {
        return New-EmResult $false $null 'Адрес записан с ошибкой: после http должно идти «://». Проще всего ввести без него, например 10.4.1.36:8000.'
    }
    $cut = $s.IndexOfAny([char[]]('/', '?', '#', '\'))
    if ($cut -ge 0) { $s = $s.Substring(0, $cut) }
    if ($s -eq '' -or $s.Contains('@')) { return New-EmResult $false $null $generic }
    if ($s.StartsWith('[')) {
        return New-EmResult $false $null 'Адреса IPv6 не поддерживаются. Введите адрес вида 10.4.1.36 или имя компьютера-сервера.'
    }
    $hostPart = $s
    $port = $DefaultPort
    $bits = $s.Split(':')
    if ($bits.Count -gt 2) { return New-EmResult $false $null $generic }
    if ($bits.Count -eq 2) {
        $hostPart = $bits[0]
        $p = $bits[1]
        if ($p -notmatch '^\d{1,5}$' -or [int]$p -lt 1 -or [int]$p -gt 65535) {
            return New-EmResult $false $null ('Неверный номер порта «:' + $p + '». Обычно это :8000 — например 10.4.1.36:8000.')
        }
        $port = [int]$p
    }
    $h = $hostPart.ToLowerInvariant().TrimEnd('.')
    if ($h -eq '') { return New-EmResult $false $null $generic }
    $loop = 'Это адрес самого сервера «изнутри» (localhost / 127.0.0.1). На сервере эта настройка не нужна — там значок есть и так. Введите адрес сервера в сети — тот, что в адресной строке на ЭТОМ компьютере, например 10.4.1.36:8000.'
    if ($h -match '^[0-9.]+$') {
        $oct = $h.Split('.')
        $bad = ($oct.Count -ne 4)
        foreach ($o in $oct) { if ($o -notmatch '^(0|[1-9]\d{0,2})$' -or [int]$o -gt 255) { $bad = $true } }
        if ($bad) {
            return New-EmResult $false $null ('«' + $hostPart + '» — не IP-адрес: нужно четыре числа от 0 до 255 через точку, например 10.4.1.36.')
        }
        if ($oct[0] -eq '127') { return New-EmResult $false $null $loop }
        if ($oct[0] -eq '0') { return New-EmResult $false $null $generic }
    } else {
        if ($h.Length -gt 253) { return New-EmResult $false $null $generic }
        foreach ($label in $h.Split('.')) {
            if ($label -notmatch '^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$') { return New-EmResult $false $null $generic }
        }
        if ($h -eq 'localhost' -or $h.EndsWith('.localhost')) { return New-EmResult $false $null $loop }
    }
    $origin = if ($port -eq 80) { 'http://' + $h } else { 'http://' + $h + ':' + $port }
    return New-EmResult $true $origin $null
}

# Значение из реестра — к виду для сравнения: регистр, хвостовой «/», :80.
function Get-EmOriginKey([AllowNull()]$Value) {
    $x = ([string]$Value).Trim().TrimEnd('/').ToLowerInvariant()
    if ($x -match '^(http://[^/:]+):80$') { $x = $Matches[1] }
    return $x
}

# Chrome при скачивании записывает в поток Zone.Identifier файла, откуда он
# скачан (HostUrl=…). Если файл открыли с сервера клиники — это и есть нужный
# адрес: предложим его по умолчанию. Потока нет (флешка, «Разблокировать»,
# другой браузер) или там localhost — просто спросим без подсказки.
function Get-EmDownloadOrigin([string]$Path) {
    if (-not $Path) { return $null }
    try { $lines = @(Get-Content -LiteralPath $Path -Stream 'Zone.Identifier' -ErrorAction Stop) } catch { return $null }
    foreach ($name in @('HostUrl', 'ReferrerUrl')) {
        foreach ($line in $lines) {
            if ($line -match ('^\s*' + $name + '\s*=\s*(\S+)\s*$')) {
                $r = ConvertTo-EmOrigin $Matches[1] 80
                if ($r.Ok) { return $r.Origin }
            }
        }
    }
    return $null
}

function Open-EmHive([bool]$Test) {
    $hive = if ($Test) { [Microsoft.Win32.RegistryHive]::CurrentUser } else { [Microsoft.Win32.RegistryHive]::LocalMachine }
    # 64-битное представление явно: даже если файл запустит 32-битный процесс,
    # запись ляжет туда, где её читает браузер.
    return [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)
}

function Add-EmOrigin($Hive, [string]$SubPath, [string]$Origin) {
    $want = Get-EmOriginKey $Origin
    $k = $Hive.CreateSubKey($SubPath)   # открывает существующий или создаёт — никогда не очищает
    try {
        $max = 0
        foreach ($n in @($k.GetValueNames())) {
            if ($n -notmatch '^\d+$') { continue }
            if ((Get-EmOriginKey $k.GetValue($n)) -eq $want) {
                return [pscustomobject]@{ Status = 'present'; Slot = $n }
            }
            if ($n.Length -le 9 -and [int]$n -gt $max) { $max = [int]$n }
        }
        $slot = [string]($max + 1)
        $k.SetValue($slot, $Origin, [Microsoft.Win32.RegistryValueKind]::String)
        return [pscustomobject]@{ Status = 'added'; Slot = $slot }
    } finally { $k.Close() }
}

function Remove-EmOrigin($Hive, [string]$SubPath, [string]$Origin) {
    $want = Get-EmOriginKey $Origin
    $k = $Hive.OpenSubKey($SubPath, $true)
    if ($null -eq $k) { return [pscustomobject]@{ Removed = 0; KeyDeleted = $false } }
    $removed = 0
    try {
        foreach ($n in @($k.GetValueNames())) {
            if ($n -match '^\d+$' -and (Get-EmOriginKey $k.GetValue($n)) -eq $want) { $k.DeleteValue($n); $removed++ }
        }
        $empty = ($k.ValueCount -eq 0 -and $k.SubKeyCount -eq 0)
    } finally { $k.Close() }
    $deleted = $false
    if ($removed -gt 0 -and $empty) { $Hive.DeleteSubKey($SubPath, $false); $deleted = $true }
    return [pscustomobject]@{ Removed = $removed; KeyDeleted = $deleted }
}

function Test-EmAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($env:EM_SETUP_LIBONLY -eq '1') { return }

# Режим проверки включают ДВА выключателя: переменная EM_SETUP_TEST_RUN (её
# ставит только проверка) или ключ /selftest. Переменная — главный: ключ с «/»
# в начале Git Bash молча превращает в путь (C:/Program Files/Git/selftest), и
# 2026-10-03 первый ручной прогон из-за этого пошёл обычной дорогой — к окну
# UAC. Переменную так не испортить, а на компьютере клиники её не бывает.
$EmFlags = @(@($env:EM_A1, $env:EM_A2, $env:EM_A3) | Where-Object { $_ } | ForEach-Object { $_.Trim().ToLowerInvariant() })
$EmTest = ($EmFlags -contains '/selftest') -or [bool]$env:EM_SETUP_TEST_RUN

# ---------------------------------------------------------------------------
# Разговор с человеком.
# ---------------------------------------------------------------------------
function Say([string]$Text = '', [string]$Color = '') {
    if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
}

function Read-EmLine([string]$Prompt) {
    Write-Host -NoNewline $Prompt
    return Read-Host
}

function Wait-EmClose([bool]$Test) {
    if ($Test) { return }
    Say
    try { [void](Read-Host 'Нажмите Enter, чтобы закрыть это окно') } catch {}
}

function Read-EmMode {
    Say 'Что сделать?'
    Say '   1 — включить установку EasyMed в браузере (обычный выбор)'
    Say '   2 — отменить эту настройку (вернуть как было)'
    for ($try = 0; $try -lt $EmMaxTries; $try++) {
        $a = Read-EmLine 'Введите 1 или 2 и нажмите Enter (просто Enter — это 1): '
        if ($null -eq $a) { return $null }
        $a = $a.Trim()
        if ($a -eq '' -or $a -eq '1') { return 'add' }
        if ($a -eq '2') { return 'remove' }
        Say ('Не понял «' + $a + '». Нужно 1 или 2.') 'Yellow'
    }
    return $null
}

function Read-EmOrigin([AllowNull()][string]$Default) {
    Say
    Say 'Введите адрес сервера EasyMed — так, как он виден в адресной строке'
    Say 'браузера на ЭТОМ компьютере, например 10.4.1.36 (или 10.4.1.36:8000).'
    if ($Default) {
        Say ('Этот файл скачан с адреса ' + $Default + ' — чтобы взять его, просто нажмите Enter.')
    }
    for ($try = 0; $try -lt $EmMaxTries; $try++) {
        $a = Read-EmLine 'Адрес сервера: '
        if ($null -eq $a) { return $null }
        if ($Default -and $a.Trim() -eq '') { return $Default }
        $r = ConvertTo-EmOrigin $a $EmDefaultPort
        if ($r.Ok) { return $r.Origin }
        Say $r.Error 'Yellow'
    }
    return $null
}

function Invoke-EmSetup {
    $flags = $EmFlags
    $test = $EmTest
    $removeFlag = $flags -contains '/remove'
    try { $Host.UI.RawUI.WindowTitle = 'EasyMed — настройка компьютера' } catch {}

    Say
    Say '  ============================================================' 'Cyan'
    Say '    EasyMed — настройка этого компьютера (один раз)' 'Cyan'
    Say '  ============================================================' 'Cyan'
    Say 'Файл разрешает браузеру установить EasyMed как приложение:'
    Say 'значок «Установить» появится справа в адресной строке.'
    Say

    if ($test) {
        $run = if ($env:EM_SETUP_TEST_RUN) { $env:EM_SETUP_TEST_RUN } else { 'default' }
        if ($run -notmatch '^[A-Za-z0-9_-]{1,64}$') { Say 'Неверный EM_SETUP_TEST_RUN.' 'Red'; return 8 }
        $base = 'Software\EasyMedSetupTest\' + $run
        $shown = 'HKCU\' + $base
        Say ('[ПРОВЕРКА] Пишу в ' + $shown + ' — настоящие настройки браузеров не трогаются.') 'Magenta'
    } else {
        $base = 'SOFTWARE\Policies'
        $shown = 'HKLM\SOFTWARE\Policies'
        if (-not (Test-EmAdmin)) {
            Say 'Нужны права администратора. Сейчас Windows спросит разрешение — нажмите «Да».'
            $childArgs = @($flags | Where-Object { $_ -eq '/remove' })
            try {
                if ($childArgs.Count -gt 0) {
                    Start-Process -FilePath $env:EM_SELF -ArgumentList $childArgs -Verb RunAs | Out-Null
                } else {
                    Start-Process -FilePath $env:EM_SELF -Verb RunAs | Out-Null
                }
            } catch {
                Say
                Say 'Windows не дал прав администратора — без них настроить браузер нельзя.' 'Red'
                Say 'Скорее всего, в окне «Разрешить этому приложению вносить изменения?»'
                Say 'нажали «Нет», или у этой учётной записи нет прав администратора.'
                Say 'Что сделать: щёлкните файл правой кнопкой мыши — «Запуск от имени'
                Say 'администратора» — и нажмите «Да». Если Windows просит пароль, нужен'
                Say 'пароль администратора этого компьютера.'
                Wait-EmClose $false
                return 2
            }
            Say 'Продолжение — в новом окне «Администратор».'
            return 0
        }
    }

    $mode = if ($removeFlag) { 'remove' } else { Read-EmMode }
    if ($null -eq $mode) { Say 'Ничего не изменено.' 'Yellow'; Wait-EmClose $test; return 1 }
    if ($mode -eq 'remove') { Say; Say 'Отмена настройки: уберу адрес сервера EasyMed из настроек браузеров.' }

    $origin = Read-EmOrigin (Get-EmDownloadOrigin $env:EM_SELF)
    if ($null -eq $origin) { Say; Say 'Адрес так и не введён — ничего не изменено. Запустите файл ещё раз.' 'Yellow'; Wait-EmClose $test; return 1 }

    $hive = Open-EmHive $test
    $changed = 0
    Say
    try {
        if ($mode -eq 'add') {
            Say ('Разрешаю адрес ' + $origin + ':')
            foreach ($b in $EmBrowsers) {
                $r = Add-EmOrigin $hive ($base + '\' + $b.Key + '\' + $EmPolicyName) $origin
                $note = if ($b.Unverified) { ' (поддержка в Яндекс Браузере не проверена)' } else { '' }
                if ($r.Status -eq 'added') { $changed++; Say ('   ' + $b.Name + ' — готово' + $note) 'Green' }
                else { Say ('   ' + $b.Name + ' — уже было, ничего не менял' + $note) }
            }
        } else {
            Say ('Убираю адрес ' + $origin + ':')
            foreach ($b in $EmBrowsers) {
                $r = Remove-EmOrigin $hive ($base + '\' + $b.Key + '\' + $EmPolicyName) $origin
                if ($r.Removed -gt 0) { $changed++; Say ('   ' + $b.Name + ' — убрано') 'Green' }
                else { Say ('   ' + $b.Name + ' — этого адреса там не было') }
            }
        }
    } catch [System.UnauthorizedAccessException], [System.Security.SecurityException] {
        Say
        Say ('Нет доступа к настройкам браузеров: ' + $_.Exception.Message) 'Red'
        Say 'Запустите файл правой кнопкой мыши — «Запуск от имени администратора».'
        Wait-EmClose $test
        return 3
    } finally { $hive.Close() }
    Say ('Записано в реестр: ' + $shown + '\<браузер>\' + $EmPolicyName)

    Say
    if ($mode -eq 'add') {
        Say 'Что дальше:' 'Cyan'
        Say '   1. Закройте ВСЕ окна браузера (Chrome, Edge, Яндекс) — полностью.'
        Say ('   2. Откройте EasyMed заново: ' + $origin + '/admin')
        Say '   3. Справа в адресной строке появится значок «Установить»'
        Say '      (монитор со стрелкой) — нажмите его и подтвердите.'
        Say '   Значка нет? Перезагрузите компьютер и откройте EasyMed ещё раз.'
        Say
        Say 'В меню браузера теперь может быть надпись «Управляется вашей'
        Say 'организацией» — так и должно быть: это и есть эта настройка.'
    } elseif ($changed -gt 0) {
        Say 'Готово. Закройте все окна браузера и откройте его заново —'
        Say 'настройка перестанет действовать.'
    } else {
        Say 'Этого адреса не было ни в одном браузере — менять нечего.'
    }
    Wait-EmClose $test
    return 0
}

$code = 3
try { $code = Invoke-EmSetup }
catch {
    Say
    Say ('Что-то пошло не так: ' + $_.Exception.Message) 'Red'
    Say 'Ничего страшного: запустите файл ещё раз. Если повторится — сфотографируйте это окно и отправьте в поддержку EasyMed.'
    Wait-EmClose $EmTest
    $code = 3
}
exit $code
