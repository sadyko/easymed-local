// PC_SETUP_INSTALL_V1 (2026-10-03) — проверки файла настройки компьютера клиники
// public/setup/EasyMed-ustanovka.cmd.
//
// Файл пишет политику браузера OverrideSecurityRestrictionsOnInsecureOrigin,
// чтобы на компьютерах клиники (http://10.x.x.x:8000 — не «защищённый» адрес)
// появился значок «Установить» в адресной строке. Что здесь проверяется:
//
//   * ФАЙЛ ДОЕДЕТ И ЗАПУСТИТСЯ: загрузочная часть — чистый ASCII (cmd читает
//     её в кодовой странице консоли), без BOM, строки CRLF и правило
//     .gitattributes, которое держит их CRLF в каждой поставке; маркер
//     встроенного скрипта один и стоит после exit /b;
//   * СЕРВЕР ОТДАЁТ ЕГО БЕЗ ВХОДА — как скачивание, байт в байт; поставка
//     (ALLOWLIST/BUNDLE_EXCLUDES) его не вырезает;
//   * РАЗБОР АДРЕСА — каждая форма из задачи и каждая ошибка с понятным
//     русским ответом, включая русскую раскладку («10ю4ю1ю36Ж8000»);
//   * АДРЕС ИЗ Zone.Identifier — подсказка по умолчанию, когда файл скачан
//     с сервера, и молчание, когда подсказывать нечего;
//   * НАСТОЯЩИЙ ЗАПУСК через cmd.exe → PowerShell, с вводом из трубы и
//     русским текстом на выходе: добавить, повторить (ничего не двоится),
//     чужие значения целы, отмена из меню и ключом /remove, подраздел удалён
//     только опустевший; путь с кириллицей, пробелами, скобками и «&».
//
// Реестр — ТОЛЬКО HKCU\Software\EasyMedSetupTest\<прогон>: переменная
// EM_SETUP_TEST_RUN сама включает режим проверки (без прав администратора и
// без HKLM). Ключ /selftest передаётся тоже, но опираться на него нельзя:
// Git Bash превращает «/selftest» в путь, и первый ручной прогон из-за этого
// дошёл до окна UAC. Подраздел прогона удаляется в after.
//
// Части с PowerShell и реестром — только на Windows; на CI (ubuntu) они
// пропускаются, остальное идёт везде.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', '..');          // …/public
const ROOT = path.resolve(PUB, '..');
const FILE = path.join(PUB, 'setup', 'EasyMed-ustanovka.cmd');
const URL_PATH = '/setup/EasyMed-ustanovka.cmd';
const MARKER = '##EM-PS1-BEGIN##';
const WIN = process.platform === 'win32';
const SKIP_WIN = WIN ? false : 'нужен Windows (PowerShell 5.1 и реестр)';
const RUN = 'node' + process.pid + 'x' + Date.now();   // свой подраздел — параллельные прогоны не мешают
const TEST_KEY = 'Software\\EasyMedSetupTest\\' + RUN;
const POLICY = 'OverrideSecurityRestrictionsOnInsecureOrigin';
const CHROME = 'Google\\Chrome\\' + POLICY;
const EDGE = 'Microsoft\\Edge\\' + POLICY;
const YANDEX = 'YandexBrowser\\' + POLICY;

// ---------------------------------------------------------------------------
// PowerShell и cmd.
// ---------------------------------------------------------------------------
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function ps(script, env = {}) {
  const prelude = '$ErrorActionPreference = "Stop"\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n';
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(prelude + script, 'utf16le').toString('base64')], { env: { ...process.env, ...env }, timeout: 60000 });
  const out = r.stdout.toString('utf8');
  assert.equal(r.status, 0, 'PowerShell упал: ' + r.stderr.toString('utf8') + out);
  return out;
}

// Настоящий запуск файла так, как его запускает Windows: cmd.exe /c "файл".
// EM_SETUP_TEST_RUN ставится ВСЕГДА — это и есть выключатель режима проверки.
function runSetup(input, { args = ['/selftest'], file = FILE } = {}) {
  const line = '/d /s /c ""' + file + '"' + (args.length ? ' ' + args.join(' ') : '') + '"';
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', [line], {
    windowsVerbatimArguments: true,
    input: Buffer.from(input.replace(/\r?\n/g, '\r\n'), 'utf8'),
    env: { ...process.env, EM_SETUP_TEST_RUN: RUN, EM_SETUP_LIBONLY: '' },
    timeout: 60000,
  });
  const out = r.stdout.toString('utf8');
  assert.match(out, /\[ПРОВЕРКА\] Пишу в HKCU\\Software\\EasyMedSetupTest\\/, 'режим проверки не включился:\n' + out + r.stderr.toString('utf8'));
  return { status: r.status, out, err: r.stderr.toString('utf8') };
}

// Снимок подраздела прогона: { 'Google\\Chrome\\…': { '1': '…' } }.
function dump() {
  const json = ps(`
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
    $res = @{}
    function Walk($k, $rel) {
      if ($k.ValueCount -gt 0) { $v = @{}; foreach ($n in $k.GetValueNames()) { $v[$n] = [string]$k.GetValue($n) }; $res[$rel] = $v }
      foreach ($s in $k.GetSubKeyNames()) { $c = $k.OpenSubKey($s); $r2 = if ($rel) { $rel + '\\' + $s } else { $s }; Walk $c $r2; $c.Close() }
    }
    $root = $base.OpenSubKey($env:EM_KEY)
    if ($root) { Walk $root ''; $root.Close() }
    $res | ConvertTo-Json -Depth 5 -Compress
  `, { EM_KEY: TEST_KEY });
  return JSON.parse(json.trim() || '{}');
}

function seed(rel, values) {
  ps(`
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
    $k = $base.CreateSubKey($env:EM_KEY)
    $vals = $env:EM_VALS | ConvertFrom-Json
    foreach ($p in $vals.PSObject.Properties) { $k.SetValue($p.Name, [string]$p.Value, [Microsoft.Win32.RegistryValueKind]::String) }
    $k.Close()
  `, { EM_KEY: TEST_KEY + '\\' + rel, EM_VALS: JSON.stringify(values) });
}

function dropTestKey() {
  ps(`
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
    $base.DeleteSubKeyTree($env:EM_KEY, $false)
    $parent = $base.OpenSubKey('Software\\EasyMedSetupTest')
    if ($parent) {
      $empty = ($parent.SubKeyCount -eq 0 -and $parent.ValueCount -eq 0); $parent.Close()
      if ($empty) { $base.DeleteSubKey('Software\\EasyMedSetupTest', $false) }
    }
  `, { EM_KEY: TEST_KEY });
}

if (WIN) after(() => dropTestKey());

// ---------------------------------------------------------------------------
// Файл как файл — везде, включая CI.
// ---------------------------------------------------------------------------
test('загрузочная часть — ASCII без BOM, строки CRLF, маркер один и после exit /b', () => {
  const buf = fs.readFileSync(FILE);
  assert.notEqual(buf[0], 0xef, 'BOM в начале: cmd увидит «\u00ef\u00bb\u00bf@echo» и не запустит файл');
  const text = buf.toString('utf8');
  const at = text.indexOf(MARKER);
  assert.ok(at > 0, 'нет маркера встроенного скрипта');
  assert.equal(text.split(MARKER).length, 2, 'маркер встречается больше одного раза');
  const boot = text.slice(0, at);
  assert.ok(!/[^\x00-\x7f]/.test(boot), 'в загрузочной части не-ASCII: cmd прочтёт её в кодовой странице 866');
  assert.match(boot, /\r\nexit \/b %ERRORLEVEL%\r\n$/, 'перед маркером должен стоять exit /b — иначе cmd полезет в PowerShell-часть');
  assert.ok(!/[^\r]\n/.test(text), 'есть строки без CR: cmd с LF-строками ненадёжен');
  const attrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\*\.cmd\s+text\s+eol=crlf\s*$/m, '.gitattributes больше не держит *.cmd в CRLF');
});

test('поставка его не вырезает: public в ALLOWLIST, исключения не задевают setup/*.cmd', async () => {
  const { ALLOWLIST, BUNDLE_EXCLUDES } = await import('../../../scripts/build-bundle.mjs');
  assert.ok(ALLOWLIST.includes('public'));
  for (const p of BUNDLE_EXCLUDES) {
    assert.ok(!/cmd|setup/i.test(p), 'исключение поставки задевает файл настройки: ' + p);
  }
});

test('сервер отдаёт файл без входа — как скачивание, байт в байт', async (t) => {
  const { openDb } = await import('../../../server/db/connection.js');
  const { migrate } = await import('../../../server/db/migrate.js');
  const { createApp } = await import('../../../server/app.js');
  const { licensedDataDir } = await import('../../../server/services/control/licensed-fixture.js');
  const { listen } = await import('../../../control-plane/server/test-helpers/listen.js');
  const db = openDb(':memory:');
  migrate(db);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  t.after(() => { server.close(); db.close(); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}${URL_PATH}`);   // без cookie
  assert.equal(res.status, 200);
  const type = res.headers.get('content-type') || '';
  assert.ok(!/text\/html|text\/plain/.test(type), 'браузер покажет файл как страницу, а не скачает: ' + type);
  assert.equal(res.headers.get('content-encoding'), null, 'файл не должен уходить сжатым');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(FILE));
});

// ---------------------------------------------------------------------------
// Разбор адреса — функции встроенного скрипта, без запуска main.
// ---------------------------------------------------------------------------
const OK = [
  ['10.4.1.36', 'http://10.4.1.36:8000'],
  ['10.4.1.36:8000', 'http://10.4.1.36:8000'],
  ['http://10.4.1.36:8000/admin.html', 'http://10.4.1.36:8000'],
  ['  HTTP://10.4.1.36:8000/admin?tab=1#x  ', 'http://10.4.1.36:8000'],
  ['10.4.1.36:8000/', 'http://10.4.1.36:8000'],
  ['«10.4.1.36»', 'http://10.4.1.36:8000'],
  ['"10.4.1.36:8000"', 'http://10.4.1.36:8000'],
  ['10.4.1.36:8001', 'http://10.4.1.36:8001'],
  ['10.4.1.36:80', 'http://10.4.1.36'],
  ['clinic-server', 'http://clinic-server:8000'],
  ['Clinic-Server.local:8000', 'http://clinic-server.local:8000'],
  ['http://reg_pc2/admin', 'http://reg_pc2:8000'],
  ['10ю4ю1ю36Ж8000', 'http://10.4.1.36:8000'],          // русская раскладка: «.» = ю, «:» = Ж
  ['10Ю4Ю1Ю36ж8000/', 'http://10.4.1.36:8000'],
];
const BAD = [
  ['', /не введён/],
  ['    ', /не введён/],
  ['https://10.4.1.36:8000', /https/],
  ['https://clinic.example', /https/],
  ['ftp://10.4.1.36', /Не похоже на адрес/],
  ['http//10.4.1.36', /с ошибкой/],
  ['http:10.4.1.36', /с ошибкой/],
  ['10.4.1.300', /не IP-адрес/],
  ['10.4.1', /не IP-адрес/],
  ['010.4.1.36', /не IP-адрес/],
  ['10.4.1.36:99999', /порта/],
  ['10.4.1.36:abc', /порта/],
  ['10.4.1.36:', /порта/],
  ['localhost', /сервера «изнутри»/],
  ['localhost:8000', /сервера «изнутри»/],
  ['127.0.0.1', /сервера «изнутри»/],
  ['http://127.0.0.1:8000/admin', /сервера «изнутри»/],
  ['привет', /раскладк/],
  ['10.4.1. 36', /пробелы/],
  ['user@10.4.1.36', /Не похоже на адрес/],
  ['[::1]:8000', /IPv6/],
  ['a:b:c', /Не похоже на адрес/],
  ['-bad-.host', /Не похоже на адрес/],
  ['0.0.0.0', /Не похоже на адрес/],
];

test('разбор адреса: все формы из задачи — в http://ХОСТ:ПОРТ, ошибки — понятным русским текстом', { skip: SKIP_WIN }, () => {
  const cases = [...OK.map(([i]) => i), ...BAD.map(([i]) => i)];
  const json = ps(`
    $env:EM_SETUP_LIBONLY = '1'
    $t = [IO.File]::ReadAllText($env:EM_FILE, [Text.Encoding]::UTF8)
    $m = '#' + '#EM-PS1-BEGIN##'
    . ([ScriptBlock]::Create($t.Substring($t.IndexOf($m) + $m.Length)))
    $out = @()
    $cases = $env:EM_CASES | ConvertFrom-Json   # 5.1 отдаёт массив одним объектом — через переменную он перечисляется
    foreach ($c in $cases) {
      $r = ConvertTo-EmOrigin $c 8000
      $out += [pscustomobject]@{ input = $c; ok = $r.Ok; origin = $r.Origin; error = $r.Error }
    }
    ConvertTo-Json -InputObject $out -Depth 3 -Compress
  `, { EM_FILE: FILE, EM_CASES: JSON.stringify(cases) });
  const got = JSON.parse(json);
  assert.equal(got.length, cases.length);
  OK.forEach(([input, origin], i) => {
    assert.equal(got[i].ok, true, JSON.stringify(input) + ' отвергнут: ' + got[i].error);
    assert.equal(got[i].origin, origin, JSON.stringify(input));
  });
  BAD.forEach(([input, re], j) => {
    const r = got[OK.length + j];
    assert.equal(r.ok, false, JSON.stringify(input) + ' принят как ' + r.origin);
    assert.match(String(r.error), re, JSON.stringify(input) + ': ' + r.error);
    assert.match(String(r.error), /[А-Яа-я]/, 'ответ не по-русски');
  });
});

test('адрес из Zone.Identifier: подсказка, когда файл скачан с сервера; молчание — когда нечего подсказать', { skip: SKIP_WIN }, async () => {
  const { tmpDir } = await import('../../../server/test-helpers/tmpdir.js');
  const dir = tmpDir('em-pcsetup-zone-');
  const json = ps(`
    $env:EM_SETUP_LIBONLY = '1'
    $t = [IO.File]::ReadAllText($env:EM_FILE, [Text.Encoding]::UTF8)
    $m = '#' + '#EM-PS1-BEGIN##'
    . ([ScriptBlock]::Create($t.Substring($t.IndexOf($m) + $m.Length)))
    $f = Join-Path $env:EM_DIR 'x.cmd'
    Set-Content -LiteralPath $f -Value 'x'
    $res = [ordered]@{}
    $res.none = Get-EmDownloadOrigin $f
    $zone = { param($body) Set-Content -LiteralPath $f -Stream 'Zone.Identifier' -Value ("[ZoneTransfer]\`r\`nZoneId=3\`r\`n" + $body) }
    & $zone "ReferrerUrl=http://10.4.1.36:8000/admin\`r\`nHostUrl=http://10.4.1.36:8000/setup/EasyMed-ustanovka.cmd"
    $res.host = Get-EmDownloadOrigin $f
    & $zone "HostUrl=http://clinic-srv/setup/EasyMed-ustanovka.cmd"
    $res.port80 = Get-EmDownloadOrigin $f
    & $zone "ReferrerUrl=http://10.4.1.9:8000/admin\`r\`nHostUrl=about:internet"
    $res.referrer = Get-EmDownloadOrigin $f
    & $zone "HostUrl=http://localhost:8000/setup/EasyMed-ustanovka.cmd"
    $res.loopback = Get-EmDownloadOrigin $f
    $res.same = ((Get-EmOriginKey 'HTTP://10.4.1.36:8000/') -eq (Get-EmOriginKey 'http://10.4.1.36:8000')) -and ((Get-EmOriginKey 'http://srv:80/') -eq (Get-EmOriginKey 'http://srv'))
    $res | ConvertTo-Json -Compress
  `, { EM_FILE: FILE, EM_DIR: dir });
  assert.deepEqual(JSON.parse(json), {
    none: null,
    host: 'http://10.4.1.36:8000',
    port80: 'http://clinic-srv',               // в Zone.Identifier точный URL: без порта — это 80
    referrer: 'http://10.4.1.9:8000',
    loopback: null,                            // скачан на самом сервере — не подсказываем
    same: true,
  });
});

// ---------------------------------------------------------------------------
// Настоящий запуск: cmd.exe → PowerShell, ввод из трубы.
// ---------------------------------------------------------------------------
test('добавить, повторить, сохранить чужое, отменить — через настоящий cmd.exe', { skip: SKIP_WIN }, () => {
  dropTestKey();
  // Чужие значения в списке Chrome — с дыркой в номерах и с не-числовым именем.
  seed(CHROME, { 1: 'http://other.example:9000', 3: '*.corp.example', note: 'не наше' });

  // 1. Добавить (меню: Enter = «1»; адрес — голый IP).
  let r = runSetup('\n10.4.1.36\n');
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /EasyMed — настройка этого компьютера/);
  assert.match(r.out, /Разрешаю адрес http:\/\/10\.4\.1\.36:8000/);
  assert.match(r.out, /Google Chrome — готово/);
  assert.match(r.out, /Яндекс Браузер — готово \(поддержка в Яндекс Браузере не проверена\)/);
  assert.match(r.out, /Закройте ВСЕ окна браузера/);
  assert.match(r.out, /Управляется вашей/);
  assert.match(r.out, /http:\/\/10\.4\.1\.36:8000\/admin/);
  const added = dump();
  assert.deepEqual(added[CHROME], { 1: 'http://other.example:9000', 3: '*.corp.example', note: 'не наше', 4: 'http://10.4.1.36:8000' });
  assert.deepEqual(added[EDGE], { 1: 'http://10.4.1.36:8000' });
  assert.deepEqual(added[YANDEX], { 1: 'http://10.4.1.36:8000' });

  // 2. Повтор тем же адресом в другой записи — ничего не двоится и не меняется.
  r = runSetup('1\nhttp://10.4.1.36:8000/admin.html\n');
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /Google Chrome — уже было, ничего не менял/);
  assert.match(r.out, /Microsoft Edge — уже было/);
  assert.deepEqual(dump(), added);

  // 3. Плохие адреса — объясняет и спрашивает снова; потом второй сервер.
  r = runSetup('1\nhttps://10.4.1.36\n\n10ю4ю1ю37\n');
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /настройка не нужна/);
  assert.match(r.out, /Адрес не введён/);
  assert.match(r.out, /Разрешаю адрес http:\/\/10\.4\.1\.37:8000/);
  const two = dump();
  assert.equal(two[CHROME][5], 'http://10.4.1.37:8000');
  assert.equal(two[EDGE][2], 'http://10.4.1.37:8000');

  // 4. Отмена из меню — уходит только наш адрес; чужое и второй сервер целы.
  r = runSetup('2\n10.4.1.36:8000\n');
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /Google Chrome — убрано/);
  const afterUndo = dump();
  assert.deepEqual(afterUndo[CHROME], { 1: 'http://other.example:9000', 3: '*.corp.example', note: 'не наше', 5: 'http://10.4.1.37:8000' });
  assert.deepEqual(afterUndo[EDGE], { 2: 'http://10.4.1.37:8000' });

  // 5. Отмена ключом /remove — без меню; опустевшие подразделы удалены,
  //    подраздел Chrome с чужими значениями — нет.
  r = runSetup('10.4.1.37\n', { args: ['/selftest', '/remove'] });
  assert.equal(r.status, 0, r.out + r.err);
  assert.doesNotMatch(r.out, /Что сделать\?/, '/remove не должен спрашивать меню');
  const final = dump();
  assert.deepEqual(final[CHROME], { 1: 'http://other.example:9000', 3: '*.corp.example', note: 'не наше' });
  assert.equal(final[EDGE], undefined, 'пустой подраздел Edge должен быть удалён');
  assert.equal(final[YANDEX], undefined, 'пустой подраздел Яндекса должен быть удалён');

  // 6. Повторная отмена — честно «не было», ничего не ломает.
  r = runSetup('2\n10.4.1.37\n');
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /этого адреса там не было/);
  assert.match(r.out, /менять нечего/);
  assert.deepEqual(dump(), final);
});

test('ввод оборвался — выход с кодом 1, в реестре ничего', { skip: SKIP_WIN }, () => {
  dropTestKey();
  let r = runSetup('1\n');
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.out, /ничего не изменено/);
  r = runSetup('');
  assert.equal(r.status, 1, r.out + r.err);
  assert.deepEqual(dump(), {});
});

test('скачанный файл в папке с кириллицей, пробелами, скобками и «&»: адрес с сервера — по Enter', { skip: SKIP_WIN }, async () => {
  dropTestKey();
  const { tmpDir } = await import('../../../server/test-helpers/tmpdir.js');
  const dir = path.join(tmpDir('em-pcsetup-run-'), "Администратор (1) & d'Arc");
  fs.mkdirSync(dir);
  const copy = path.join(dir, 'EasyMed-ustanovka (1).cmd');
  fs.copyFileSync(FILE, copy);
  ps(`Set-Content -LiteralPath $env:EM_COPY -Stream 'Zone.Identifier' -Value "[ZoneTransfer]\`r\`nZoneId=3\`r\`nHostUrl=http://10.4.1.36:8000/setup/EasyMed-ustanovka.cmd"`, { EM_COPY: copy });
  const r = runSetup('\n\n', { file: copy });
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /Этот файл скачан с адреса http:\/\/10\.4\.1\.36:8000/);
  assert.match(r.out, /Разрешаю адрес http:\/\/10\.4\.1\.36:8000/);
  assert.equal(dump()[CHROME][1], 'http://10.4.1.36:8000');
  dropTestKey();
});
