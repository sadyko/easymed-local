// NAV_VISIBILITY_V1 — оболочка уважает скрытые разделы: меню, домашний экран,
// прямая ссылка, загрузка списка до первой отрисовки. admin.js монтирует себя
// при импорте, поэтому — по исходнику, как app-shell.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, '..', '..', '..', '..', rel), 'utf8');
const SHELL = read('public/js/admin.js');
const PERMS = read('public/js/admin/permissions.js');
const HUB = read('public/js/admin/views/settings-hub.js');
const exec = (src) => src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
const fnBody = (src, name) => { const i = src.indexOf(name); assert.ok(i >= 0, name + ' не найдена'); return exec(src.slice(i, i + 6000)); };

test('меню и домашний экран пропускают скрытые пункты', () => {
    assert.match(fnBody(SHELL, 'function renderSidebar()'), /if \(navHidden\.has\(item\.id\)\) continue;/, 'renderSidebar не пропускает скрытые');
    assert.match(fnBody(SHELL, 'function firstAllowedView()'), /if \(navHidden\.has\(item\.id\)\) continue;/, 'firstAllowedView не пропускает скрытые');
});

test('прямая ссылка на скрытый экран — спокойная заглушка, а не экран; подэкран скрыт вместе с родителем', () => {
    const body = fnBody(SHELL, 'async function renderViewInner(');
    const hiddenAt = body.indexOf('navHiddenFor(viewName)');
    const allowedAt = body.indexOf('isRouteAllowed(viewName)');
    assert.ok(hiddenAt >= 0, 'renderViewInner не спрашивает navHiddenFor');
    assert.ok(hiddenAt < allowedAt, 'скрытость проверяется раньше прав — иначе роль без права увидит «нет доступа» вместо «скрыт»');
    assert.match(exec(SHELL), /function navHiddenFor\(view\) \{\s*return isHiddenView\(view, navHidden, parentViewOf\);/);
});

test('список скрытых грузится после прав и до запуска оболочки; экран настроек меняет меню сразу', () => {
    const body = fnBody(SHELL, 'async function onAuthed(');
    const perms = body.indexOf('await applyActorPermissions(state.user);');
    const load = body.indexOf('await loadNavVisibility();');
    const start = body.indexOf('startApp({ fresh });');
    assert.ok(perms >= 0 && load > perms && start > load, 'порядок: права → скрытые → startApp');
    assert.match(exec(SHELL), /window\.easymed = \{[^}]*setNavHidden/, 'экран «Видимость разделов» зовёт window.easymed.setNavHidden');
});

test('маршрут visibility-settings: крошки, родитель «Настройки», ветка роутера, только полный доступ, плитка в «Основном»', () => {
    const src = exec(SHELL);
    assert.match(src, /'visibility-settings': \['Insights', 'Settings', 'Видимость разделов'\]/);
    assert.match(src, /'visibility-settings': 'settings'/);
    assert.match(src, /case 'visibility-settings':/);
    assert.match(exec(PERMS), /if \(view === 'visibility-settings'\) return false;/, 'настроенным ролям — нет; полный доступ проходит раньше');
    const hub = exec(HUB);
    const tile = hub.indexOf("route: 'visibility-settings'");
    const basics = hub.indexOf("title: 'Основное'");
    const next = hub.indexOf("title: 'Системные настройки'");
    assert.ok(tile > basics && tile < next, 'плитка стоит в группе «Основное»');
});

// FIX_318_V1 (B3) — список пунктов меню, по которому сервер проверяет «что можно
// скрыть», живёт в чистом модуле (admin.js сервер импортировать не может). Он
// обязан совпадать с NAV оболочки — иначе новый пункт меню нельзя будет скрыть,
// а удалённый останется скрываемым.
test('FIX_318_V1: NAV_IDS логики видимости совпадает с NAV оболочки, в том же порядке', async () => {
    const { NAV_IDS } = await import('../nav-visibility-logic.js');
    const at = SHELL.indexOf('const NAV = [');
    const block = SHELL.slice(at, SHELL.indexOf('\n];', at));
    const shellIds = [...exec(block).matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(shellIds.length >= 15, 'NAV не разобран');
    assert.deepEqual([...NAV_IDS], shellIds);
});
