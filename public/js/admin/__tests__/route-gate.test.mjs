// CASE_OVERVIEW_ROUTE_V1 + ROUTE_GATE_COVERS_PARENT_OF_V1 (2026-09-21) — У КАЖДОГО
// ПОДЭКРАНА ЕСТЬ ПРАВИЛО ДОСТУПА, А НЕ ПАДЕНИЕ НА НЕСУЩЕСТВУЮЩИЙ КЛЮЧ.
//
// Что случилось (тестовая клиника, роль «Врач»): #case-overview/1 — «Обзор
// госпитализации», экран ВРАЧА — показывал «Нет доступа». Администратор видел
// его нормально. В permissions.js isRouteAllowed() есть строка для соседней
// вкладки (`case-file` → isModuleAllowed('case-file')), а для `case-overview`
// строки не было, и маршрут падал на общий хвост `_effective.has(view)`.
// Ключа `case-overview` нет ни в одной роли и быть не может — редактор ролей
// его не предлагает, — так что проверка не могла пройти НИ У КОГО, кроме
// полного доступа. Сервер (rpc/case-overview.js, OVERVIEW_ROLES + грант
// inpatient.patients) врача пускает; отказывала только оболочка.
//
// Это ТРЕТИЙ раз, когда класс ошибки бьёт по живой клинике: `doctor-room`
// (ROLE_KEYS_V2), `documents-settings` (COMPANY_ROUTE_GRANT_V1), теперь
// `case-overview`. Поэтому второй тест здесь — не про один маршрут, а про
// класс: он читает таблицу PARENT_OF из admin.js (каждый подэкран там назван —
// appbar-back.test.mjs это требует) и для каждого подэкрана, чей адрес не
// является грантовым ключом, проверяет, что роль, которой открыт РОДИТЕЛЬ,
// открывает и подэкран. Либо маршрут стоит в коротком списке «намеренно только
// полный доступ» с названной причиной — и тогда тест проверяет обратное, чтобы
// список не протухал.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.window = { localStorage: { getItem: () => 'ru', setItem() {}, removeItem() {} }, location: { hostname: 'localhost' } };
globalThis.localStorage = globalThis.window.localStorage;

const perms = await import('../permissions.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, '..', '..', 'admin.js');
const shellSrc = fs.readFileSync(SHELL, 'utf8');

/** Таблица «чей это подэкран» — из самого файла оболочки (как в appbar-back.test.mjs). */
function parentTable() {
    const at = shellSrc.indexOf('const PARENT_OF = {');
    assert.notEqual(at, -1, 'таблицу PARENT_OF переименовали — тест смотрит не туда');
    const block = shellSrc.slice(at, shellSrc.indexOf('\n};', at));
    const out = {};
    for (const m of block.matchAll(/'([^']+)':\s*'([^']+)'/g)) out[m[1]] = m[2];
    return out;
}

const role = (name, sections, levels = {}) => ({ name, permissions: { sections, levels } });

// ===========================================================================
// 1. CASE_OVERVIEW_ROUTE_V1 — обзор госпитализации открывается тем же ключом,
//    что и документы: это две вкладки ОДНОЙ истории болезни (общий caseHead).
// ===========================================================================

test('CASE_OVERVIEW_ROUTE_V1: врач с кабинетом (без beds/admissions) открывает обзор и документы госпитализации', () => {
    perms.setEffectiveFromRole(role('doctor', ['patients', 'consultation'], { consultation: 'editor' }));
    assert.equal(perms.isRouteAllowed('case-file'), true, 'документы истории болезни закрылись от врача');
    assert.equal(perms.isRouteAllowed('case-overview'), true,
        '«Обзор госпитализации» (#case-overview) отказывает врачу — у маршрута нет правила в isRouteAllowed, и он падает на несуществующий ключ');
    assert.equal(perms.isModuleAllowed('case-overview'), perms.isModuleAllowed('case-file'),
        'меню/«назад» и маршрут отвечают про обзор по-разному');
    perms.setFullAccess('Admin');
});

test('CASE_OVERVIEW_ROUTE_V1: медсестра с beds — да; кассир без стационара и кабинета — нет; полный доступ — да', () => {
    perms.setEffectiveFromRole(role('nurse', ['patients', 'procedures', 'beds'], { beds: 'editor' }));
    assert.equal(perms.isRouteAllowed('case-overview'), true, 'медсестре отделения закрыт обзор лежащего');
    assert.equal(perms.isRouteAllowed('case-file'), true);

    perms.setEffectiveFromRole(role('cashier', ['cashier', 'patients'], { cashier: 'admin' }));
    assert.equal(perms.isRouteAllowed('case-overview'), false, 'кассиру открылась история болезни');
    assert.equal(perms.isRouteAllowed('case-file'), false);
    assert.equal(perms.isModuleAllowed('case-overview'), false);

    perms.setFullAccess('Admin');
    assert.equal(perms.isRouteAllowed('case-overview'), true);
});

// ===========================================================================
// 2. ROUTE_GATE_COVERS_PARENT_OF_V1 — класс, а не случай.
// ===========================================================================

// Маршруты, которые НАМЕРЕННО не открываются ключами родителя — только полному
// доступу (администратор клиники / супер-админ). Каждый — с причиной; тест
// проверяет, что они и вправду закрыты, иначе запись протухла и её надо снять.
const FULL_ACCESS_ONLY = {
    // Явное `return false` в isRouteAllowed: токен бота = вся переписка с пациентами.
    'telegram-settings':  'TELEGRAM_BOT_V1 — раздел админский целиком, включая чтение',
    // Явное `return false`: ключи Binotel/onlinePBX открывают журнал звонков всей клиники.
    'telephony-settings': 'TELEPHONY_V1 — раздел админский целиком, включая чтение',
    // Явное `return false`: экран задаёт саму воронку CRM; ошибка ломает CRM всей клиники.
    'crm-settings':       'CRM_CONFIG_V1 — раздел админский целиком, включая чтение',
    // Весь /api/users стоит за requireRole(\'admin\') (server/routes/users.js):
    // настроенной роли сервер откажет на первом же запросе списка.
    'employees':          'EMPLOYEE_EDITOR — REST /api/users только для admin',
    // Страница владельца — активация Symptex; кнопку в сайдбаре прячет тот же
    // ключ (admin.js: isModuleAllowed(\'public-site\')).
    'public-site':        'PUBLIC_SITE — страница владельца, всё через gw() от имени клиники',
    // ROLE_AUDIT_V2 — только явный ключ `docs-archive`, не по `patients`: архив
    // подписанных документов всего филиала. Локальный редактор ролей ключа не
    // предлагает, так что сегодня это полный доступ.
    'docs-archive':       'ROLE_AUDIT_V2 — только явный грант, не по родителю',
    // Заглушки «Скоро» (renderComingSoon): экрана нет, из меню недостижимы —
    // роли показывать нечего.
    'pacs':               'COMING_SOON_V1 — заглушка',
    'pharmacy':           'COMING_SOON_V1 — заглушка',
    'marketing':          'COMING_SOON_V1 — заглушка',
    'callcenter':         'COMING_SOON_V1 — заглушка',
};

const GRANTABLE = perms.allPermissionKeys();
const isGrantable = (key) => GRANTABLE.includes(key) || key.startsWith('settings:');

/** Грантовые ключи, каждый из которых в одиночку открывает пункт меню `parent`
 *  (admissions → beds, cashier-shifts → cashier, settings → settings + settings:*). */
function openersOf(parent) {
    return GRANTABLE.filter((k) => {
        perms.setEffectiveFromRole(role('x', [k]));
        return perms.isModuleAllowed(parent);
    });
}

/** Открывается ли подэкран роли, которой открыт родитель, — хоть под одним из
 *  кодов ролей (экраны стационара спрашивают ещё и роль, INPATIENT_ROLE_GATE_V1). */
function reachableViaParent(child, openers) {
    return [...perms.ROLE_CODES, 'Своя роль'].some((code) => {
        perms.setEffectiveFromRole(role(code, openers));
        return perms.isRouteAllowed(child);
    });
}

test('ROUTE_GATE_COVERS_PARENT_OF_V1: у каждого подэкрана из PARENT_OF есть правило в isRouteAllowed — роль, которой открыт родитель, открывает и его', () => {
    const parents = parentTable();
    const fallen = [];
    const stale = [];
    try {
        for (const [child, parent] of Object.entries(parents)) {
            if (isGrantable(child)) continue;   // сам себе ключ (beds, registration) — редактор ролей его предлагает
            const openers = openersOf(parent);
            assert.ok(openers.length,
                'родитель «' + parent + '» подэкрана «' + child + '» не открывается ни одним грантовым ключом — это отдельная ошибка isModuleAllowed');
            const ok = reachableViaParent(child, openers);
            if (child in FULL_ACCESS_ONLY) {
                if (ok) stale.push(child + ' — открывается ключами родителя «' + parent + '», а записан как «только полный доступ»');
            } else if (!ok) {
                const keys = openers.length > 3 ? openers.slice(0, 2).join('/') + '/… (+' + (openers.length - 2) + ')' : openers.join('/');
                fallen.push('#' + child + ' (родитель «' + parent + '», ключи ' + keys + ')');
            }
        }
    } finally {
        perms.setFullAccess('Admin');
    }
    assert.deepEqual(fallen, [],
        'эти маршруты закрыты для КАЖДОЙ настроенной роли: в permissions.js isRouteAllowed() нет правила для них, '
        + 'и проверка падает на `_effective.has(view)` с ключом, которого редактор ролей не предлагает '
        + '(тот же класс, что COMPANY_ROUTE_GRANT_V1 и CASE_OVERVIEW_ROUTE_V1). '
        + 'Добавьте строку `if (view === \'<маршрут>\') return …` рядом с соседями, или внесите маршрут в FULL_ACCESS_ONLY с причиной:\n  '
        + fallen.join('\n  '));
    assert.deepEqual(stale, [],
        'список FULL_ACCESS_ONLY протух — снимите запись:\n  ' + stale.join('\n  '));
});

test('ROUTE_GATE_COVERS_PARENT_OF_V1: список «только полный доступ» ссылается на живые подэкраны', () => {
    const parents = parentTable();
    const ghosts = Object.keys(FULL_ACCESS_ONLY).filter((k) => !(k in parents));
    assert.deepEqual(ghosts, [], 'в FULL_ACCESS_ONLY есть маршруты, которых нет в PARENT_OF: ' + ghosts.join(', '));
});

// ===========================================================================
// 3. MY_STOCK_V1 — ДВА ЛИЧНЫХ ПУНКТА МЕНЮ: «МОИ ЗАПАСЫ» И «МОЙ ОТДЕЛ».
//
// Владелец (23.09): «личный экран "Мои запасы" … плюс пункт меню на карточку
// отдела для медсестры и заведующей».
//
// Оба пункта — не грантовые ключи, и это главное, что здесь закреплено. «Мои
// запасы» показывает ТОЛЬКО самого вошедшего (отбор считает сервер), поэтому
// маршрут открыт, а меню решает РОЛЬ: галочка-право означала бы, что врач не
// видит того, что сам же тратит, пока администратор не обойдёт все роли
// поимённо. «Мой отдел» и вовсе не про право: пункт ведёт на карточку СВОЕГО
// отдела, и человеку без отдела вести туда некуда — даже с полным доступом.
// ===========================================================================

/** Идентификаторы пунктов бокового меню — из самой таблицы NAV (как в appbar-back). */
function navIds() {
    const at = shellSrc.indexOf('const NAV =');
    const block = shellSrc.slice(at, shellSrc.indexOf('\nconst CRUMBS', at));
    return new Set([...block.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]));
}
/** Маршруты, которые роутер умеет открыть. */
function routedViews() {
    const at = shellSrc.indexOf('switch (state.view) {');
    return new Set([...shellSrc.slice(at, shellSrc.indexOf('\n        }', at)).matchAll(/case '([^']+)':/g)].map((m) => m[1]));
}
/** Крошки — по ним оболочка узнаёт маршрут при перезагрузке (isKnownView). */
function crumbKeys() {
    const at = shellSrc.indexOf('const CRUMBS = {');
    return new Set([...shellSrc.slice(at, shellSrc.indexOf('\n};', at)).matchAll(/^\s*'?([A-Za-z-]+)'?:\s*\[/gm)].map((m) => m[1]));
}

const withDepartment = (id, fn) => {
    const was = globalThis.window.easymed;
    globalThis.window.easymed = { state: { user: { id: 7, role: 'nurse', department_id: id } } };
    try { return fn(); } finally { globalThis.window.easymed = was; }
};

test('MY_STOCK_V1: оба экрана — пункты меню: есть в NAV, есть в роутере, есть в крошках и НЕ в PARENT_OF', () => {
    const nav = navIds();
    const routed = routedViews();
    const crumbs = crumbKeys();
    const parents = parentTable();
    for (const view of ['my-stock', 'my-department']) {
        assert.ok(nav.has(view), view + ' пропал из бокового меню');
        assert.ok(routed.has(view), 'у ' + view + ' нет ветки маршрута — адрес провалится в «неизвестный экран»');
        assert.ok(crumbs.has(view), view + ' не назван в CRUMBS — перезагрузка и прямая ссылка уведут на домашний экран');
        assert.equal(view in parents, false,
            'у пункта бокового меню появилась кнопка «назад» — это лишний орган управления: ' + view);
    }
    // «Мой отдел» пересылает на карточку отдела, и у ТОЙ кнопка «назад» осталась.
    assert.equal(parents['departments'], 'settings', 'карточка отдела потеряла путь назад');
});

test('MY_STOCK_V1: «Мои запасы» видят те, кому склад выдаёт под отчёт, и не видит тот, кому не выдаёт', () => {
    const sees = (code, sections) => { perms.setEffectiveFromRole(role(code, sections)); return perms.isModuleAllowed('my-stock'); };
    try {
        for (const code of ['doctor', 'nurse', 'senior_nurse', 'head_doctor']) {
            assert.equal(sees(code, ['patients']), true, 'пункт «Мои запасы» не виден роли ' + code + ' — она держит товар на руках');
        }
        for (const code of ['cashier', 'registrar', 'lab', 'callcenter']) {
            assert.equal(sees(code, ['patients', 'cashier']), false,
                'пункт «Мои запасы» показан роли ' + code + ': товар на руки ей не выдают, экран был бы всегда пустым');
        }
        // Раздел «Закупки» этим НЕ расширяется и не требуется.
        perms.setEffectiveFromRole(role('nurse', ['patients']));
        assert.equal(perms.isModuleAllowed('inventory'), false, 'права склада разъехались: медсестре открылись «Закупки»');
        // Заведующая отделом видит пункт даже с ролью вне списка — у неё есть отдел.
        assert.equal(withDepartment(11, () => sees('lab', ['labs'])), true,
            'сотруднику отдела «Мои запасы» не видны — а отдел ему выдают под отчёт');
    } finally { perms.setFullAccess('Admin'); }
});

test('MY_STOCK_V1: маршрут «Мои запасы» открыт всем — чужого за ним нет, отбор считает сервер', () => {
    try {
        perms.setEffectiveFromRole(role('cashier', ['cashier']));
        assert.equal(perms.isRouteAllowed('my-stock'), true,
            'адрес закрыт роли, у которой экран всё равно показал бы только её саму');
        assert.equal(perms.isModuleAllowed('my-stock'), false, 'меню и маршрут обязаны отвечать по-разному: пункт — по роли, адрес — открыт');
        perms.setEffectiveFromRole(role('nurse', ['patients']));
        assert.equal(perms.isRouteAllowed('my-stock'), true);
    } finally { perms.setFullAccess('Admin'); }
});

test('MY_STOCK_V1: «Мой отдел» — только у того, у кого отдел есть; полный доступ этого не меняет', () => {
    try {
        perms.setFullAccess('Admin');
        assert.equal(perms.isModuleAllowed('my-department'), false,
            'администратору без отдела показан «Мой отдел» — он открывает чужой справочник, а свои отделы живут в настройках');
        assert.equal(withDepartment(11, () => perms.isModuleAllowed('my-department')), true);

        perms.setEffectiveFromRole(role('nurse', ['patients']));
        assert.equal(perms.isModuleAllowed('my-department'), false, 'отдела нет — пункта нет');
        assert.equal(withDepartment(11, () => perms.isModuleAllowed('my-department')), true,
            'медсестра отделения не видит пункта на карточку своего отдела');
        // Право то же, что у «Отделов»: карточку чужого отдела сервер всё равно не отдаст.
        assert.equal(perms.isRouteAllowed('my-department'), perms.isRouteAllowed('departments'));
    } finally { perms.setFullAccess('Admin'); }
});
