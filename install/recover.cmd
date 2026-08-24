@echo off
rem ===========================================================================
rem  Easy-Med — вернуться к предыдущей версии.
rem
rem  NODE_NATIVE_UPDATES_V1 (docs/plans/2026-08-24-node-native-updates.md).
rem  Это замена автоматического отката, который делал apply-update.ps1. Тот
rem  откат опрашивал СТАРЫЙ процесс (в установке через EasyMed.exe нет службы,
rem  которую можно остановить), поэтому он подтверждал переходы, которых не
rem  проверял. Настоящая страховка проще: предыдущая версия никуда не делась,
rem  она лежит рядом в versions\, и вернуться к ней — это переставить ссылку
rem  `current` обратно.
rem
rem  Обычный cmd, без PowerShell и без прав администратора: mklink /J создаёт
rem  junction без повышения прав (то же самое делает сам EasyMed.exe при первом
rem  запуске). rmdir БЕЗ /s снимает только ссылку и никогда не трогает папку,
rem  на которую она указывает — проверено; ошибка здесь удалила бы саму
rem  программу клиники, а не ярлык на неё.
rem ===========================================================================
chcp 65001 >nul
setlocal EnableDelayedExpansion
title Easy-Med - возврат к предыдущей версии

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo   Easy-Med — возврат к предыдущей версии
echo   =========================================================
echo   Папка: %ROOT%
echo.

if not exist "%ROOT%\versions" goto :no_versions

rem Куда сейчас указывает `current`. В выводе dir /a:l путь стоит в
rem квадратных скобках — это не зависит от языка Windows.
set "CURTARGET="
for /f "tokens=2 delims=[]" %%T in ('dir /a:l "%ROOT%" 2^>nul ^| findstr /i /c:"current"') do set "CURTARGET=%%T"
set "CURNAME="
if defined CURTARGET for %%D in ("!CURTARGET!") do set "CURNAME=%%~nxD"

if defined CURNAME (
  echo   Сейчас работает версия:  !CURNAME!
) else (
  echo   Текущую версию определить не удалось ^(ссылка current отсутствует
  echo   или повреждена^) — выберите версию из списка ниже вручную.
)

rem Самая свежая по времени папка, кроме текущей. Сортировка по дате, а не по
rem имени: имена версий строкой сравниваются неправильно (0.9.0 "больше"
rem 0.10.0), а папки появляются здесь ровно в порядке установки.
set "PREV="
echo.
echo   Версии на этом компьютере:
for /f "delims=" %%V in ('dir /b /a:d /o:-d "%ROOT%\versions" 2^>nul') do (
  if exist "%ROOT%\versions\%%V\server\index.js" (
    if /i "%%V"=="!CURNAME!" (echo     - %%V   ^(работает сейчас^)) else (echo     - %%V)
    if not defined PREV if /i not "%%V"=="!CURNAME!" set "PREV=%%V"
  )
)

if not defined PREV goto :no_previous

echo.
set "ANSWER=%PREV%"
set /p "ANSWER=  К какой версии вернуться? [%PREV%]: "
if not defined ANSWER set "ANSWER=%PREV%"
if not exist "%ROOT%\versions\%ANSWER%\server\index.js" goto :bad_choice
if /i "%ANSWER%"=="!CURNAME!" goto :already

echo.
echo   Переключаю на версию %ANSWER%...

rem Снимаем ТОЛЬКО ссылку. Без /s — так rmdir физически не может пройти
rem внутрь и удалить саму версию.
if exist "%ROOT%\current" rmdir "%ROOT%\current" 2>nul
if exist "%ROOT%\current" goto :cannot_remove

mklink /J "%ROOT%\current" "%ROOT%\versions\%ANSWER%" >nul
if errorlevel 1 goto :mklink_failed
if not exist "%ROOT%\current\server\index.js" goto :mklink_failed

echo.
echo   Готово. Easy-Med снова будет работать на версии %ANSWER%.
echo.
echo   ЧТО СДЕЛАТЬ СЕЙЧАС:
echo     1. Закройте чёрное окно Easy-Med, если оно открыто.
echo     2. Запустите EasyMed.exe заново.
echo.
echo   Данные клиники (папка data) не затронуты. Копия базы, сделанная
echo   перед обновлением, лежит в data\backups\.
goto :done

:no_versions
echo   Не найдена папка versions — этот файл должен лежать рядом с
echo   EasyMed.exe, внутри папки Easy-Med.
goto :done

:no_previous
echo.
echo   Другой установленной версии на этом компьютере нет — возвращаться
echo   не к чему. Обратитесь к поставщику системы.
goto :done

:bad_choice
echo.
echo   Версия "%ANSWER%" на этом компьютере не установлена. Ничего не изменено.
goto :done

:already
echo.
echo   Версия %ANSWER% и так работает сейчас. Ничего не изменено.
goto :done

:cannot_remove
echo.
echo   Не удалось снять ссылку "current". Скорее всего Easy-Med сейчас
echo   запущен — закройте его окно и запустите этот файл ещё раз.
echo   Ничего не изменено.
goto :done

:mklink_failed
echo.
echo   Не удалось переключить версию. Ничего не удалено: все версии
echo   по-прежнему лежат в папке versions\. Запустите EasyMed.exe — он
echo   сам восстановит ссылку на самую свежую версию.
goto :done

:done
echo.
pause
endlocal
