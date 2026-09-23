// ROLE_REACH_V1 (2026-09-06) — «что роль видит, словами».
//
// Владелец выбрал это из трёх предложений: «tell me what a role can reach, in
// words. The hard part of roles isn't the ticks, it's knowing what a role ends
// up seeing».
//
// ЧТО ЗДЕСЬ ЗАКРЕПЛЕНО, ПО ВАЖНОСТИ.
//
// 1. СВОДКА НЕ ИМЕЕТ ПРАВА РАСХОДИТЬСЯ С ВОРОТАМИ. Описание прав, посчитанное
//    отдельно от того, как их проверяет интерфейс, врёт уверенным голосом —
//    и это худший вид ошибки именно на экране прав. Поэтому проверяется не
//    «текст похож на правду», а совпадение с ответами isModuleAllowed() на
//    тех же данных.
// 2. ПОДМЕНА СОСТОЯНИЯ НЕ ТЕЧЁТ. Сводка на секунду примеряет чужую роль на
//    общий модуль прав. Если состояние не вернуть — вошедший сотрудник
//    останется с правами чужой роли до перезагрузки страницы. Проверяется и
//    обычный ход, и исключение внутри.
// 3. ЧЕСТНОСТЬ ПРО «ЗАВИСИТ ОТ СОТРУДНИКА». Лист назначений, задачи медсестры,
//    порционник и выписка открываются ключом `beds`/`consultation`, но видит
//    их только человек нужной роли. Сводка обязана говорить это отдельной
//    строкой, а не записывать экран в «открыт».

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { localStorage: { getItem: () => 'ru', setItem() {}, removeItem() {} }, location: { hostname: 'localhost' } };
globalThis.localStorage = globalThis.window.localStorage;

const perms = await import('../permissions.js');
const { roleReach, reachSentences, landingScreen } = await import('../role-reach.js');

// Порядок как в боковом меню (admin.js NAV, без секций-заголовков).
const NAV = ['patients', 'crm', 'consultation', 'queue', 'labs', 'procedures', 'admissions',
    'mar-nurse', 'kitchen-sheet', 'discharge', 'patient-documents', 'telegram-chat',
    'cashier-shifts', 'cashier-head', 'inventory', 'dashboard', 'reports-hub', 'settings'];
const LABEL = (id) => id;

const role = (sections, extra = {}) => ({
    name: 'Тестовая роль',
    permissions: { sections, levels: extra.levels || {}, patient_tabs: extra.tabs || {} },
});

test('сводка совпадает с настоящими воротами, а не пересказывает ключи', () => {
    const r = role(['patients', 'labs'], { levels: { patients: 'viewer', labs: 'editor' } });
    const reach = roleReach(r, NAV, LABEL);

    // Тот же вопрос, заданный напрямую воротам.
    const direct = perms.previewRole(r, () => NAV.filter((id) => perms.isModuleAllowed(id)));
    const said = [...reach.opens, ...reach.conditional].map((m) => m.id);
    assert.deepEqual(said.sort(), direct.sort(),
        'сводка перечисляет не то, что откроют настоящие ворота');
    assert.deepEqual(reach.closed.map((m) => m.id).sort(),
        NAV.filter((id) => !direct.includes(id)).sort());

    const open = Object.fromEntries(reach.opens.map((m) => [m.id, m.level]));
    assert.equal(open.patients, 'viewer', 'уровень взят не из роли');
    assert.equal(open.labs, 'editor');
});

test('состояние прав возвращается на место — и после ошибки тоже', () => {
    perms.setFullAccess('Администратор');
    const before = perms.getEffectiveSet();
    assert.equal(before, null, 'подготовка: полный доступ');

    roleReach(role(['labs']), NAV, LABEL);
    assert.equal(perms.getEffectiveSet(), null,
        'после сводки вошедший остался с правами ЧУЖОЙ роли');
    assert.equal(perms.currentRoleLabel(), 'Администратор', 'подпись роли не вернулась');

    assert.throws(() => perms.previewRole(role(['labs']), () => { throw new Error('внутри сломалось'); }),
        /внутри сломалось/);
    assert.equal(perms.getEffectiveSet(), null,
        'исключение внутри оставило чужие права в силе — это и есть худший случай');
});

test('экраны стационара названы отдельно: ключ открывает, но роль сотрудника решает', () => {
    const reach = roleReach(role(['beds', 'patients']), NAV, LABEL);
    const cond = Object.fromEntries(reach.conditional.map((m) => [m.id, m.roles]));

    assert.ok(cond['mar-nurse'], 'задачи медсестры записаны в «открыто» без оговорки');
    assert.ok(cond['kitchen-sheet'], 'порционник записан в «открыто» без оговорки');
    assert.ok(cond['discharge'], 'выписка записана в «открыто» без оговорки');
    assert.ok(cond['discharge'].includes('старшая медсестра'),
        'не сказано, кому именно откроется выписка: ' + JSON.stringify(cond['discharge']));
    assert.ok(!reach.opens.some((m) => m.id === 'mar-nurse'),
        'условный экран не может стоять в списке безусловно открытых');
});

// MY_STOCK_V1 / I3 — СВОДКА НЕ РАССКАЗЫВАЕТ РОЛИ БИОГРАФИЮ ЧИТАТЕЛЯ.
//
// «Мои запасы» и «Мой отдел» открываются ещё и ФАКТОМ — состоит ли человек в
// отделе. Предпросмотр подменял только права и роль, а отдел молча оставался
// от того, кто смотрит: администратор, состоящий в отделе, выбирал «Кассир» —
// и сводка сообщала, что кассирам открыты оба личных экрана. Неправда о роли,
// сказанная уверенным голосом, и притом правда о самом читателе.
test('предпросмотр роли НЕ наследует отдел читателя — и называет условие словами', () => {
    const was = globalThis.window.easymed;
    // Читатель — администратор, состоящий в отделе 11. Именно так это и врало.
    globalThis.window.easymed = { state: { user: { id: 1, role: 'admin', department_id: 11 } } };
    try {
        const NAV_P = [...NAV, 'my-stock', 'my-department'];
        // Роль названа КОДОМ: «Мои запасы» спрашивают роль (MY_STOCK_ROLES), и
        // безымянная роль отвечала бы «неизвестна — не мешаем», то есть
        // условие про отдел не проявилось бы вовсе.
        const reach = roleReach({ name: 'cashier', permissions: { sections: ['cashier', 'my-stock'], levels: {}, patient_tabs: {} } }, NAV_P, LABEL);

        assert.ok(!reach.opens.some((m) => m.id === 'my-stock' || m.id === 'my-department'),
            'сводка обещала кассирам личные экраны безусловно — это отдел ЧИТАТЕЛЯ, а не свойство роли');
        const cond = Object.fromEntries(reach.conditional.map((m) => [m.id, m]));
        assert.ok(cond['my-stock'] && cond['my-stock'].needsDepartment,
            '«Мои запасы» не названы условными: кассиру они откроются только с отделом');
        assert.ok(cond['my-department'] && cond['my-department'].needsDepartment,
            '«Мой отдел» не назван условным');

        const said = reachSentences(reach).map((l) => l.template);
        assert.ok(said.some((t) => /состоит в отделе|состоящему в отделе/.test(t)),
            'условие про отдел не названо словами: ' + JSON.stringify(said));

        // У медсестры «Мои запасы» открыты И БЕЗ отдела — по роли; условие
        // читается как ИЛИ, а не как второе обязательное требование.
        const nurseReach = roleReach({ name: 'nurse', permissions: { sections: ['patients', 'my-stock'], levels: {}, patient_tabs: {} } }, NAV_P, LABEL);
        const nurseCond = Object.fromEntries(nurseReach.conditional.map((m) => [m.id, m]));
        assert.equal(nurseCond['my-stock'].needsDepartment, undefined,
            'медсестре подотчёт открыт по роли — условие про отдел здесь лишнее');
        assert.ok(nurseCond['my-department'].needsDepartment, 'а карточка отдела без отдела не открывается никому');

        // И состояние не течёт: отдел читателя на месте после предпросмотра.
        assert.equal(perms.ownDepartmentId(), 11, 'предпросмотр не вернул отдел вошедшего на место');
    } finally { globalThis.window.easymed = was; perms.setFullAccess('Admin'); }
});

test('роль без единого раздела названа неработающей, а не «почти настроенной»', () => {
    const reach = roleReach(role([]), NAV, LABEL);
    assert.equal(reach.opens.length, 0);
    const lines = reachSentences(reach);
    assert.equal(lines.length, 1, 'у пустой роли одна строка — и та про то, что работать нельзя');
    assert.equal(lines[0].tone, 'crit');
    assert.match(lines[0].template, /не сможет работать/);
});

test('сказано, куда сотрудник попадёт после входа', () => {
    // ROLE_HOME_V1 — журнал «Визиты» удалён: роль с картотекой входит в картотеку,
    // администратор с дашбордом — в «Дашборд», как в оболочке.
    const withPatients = roleReach(role(['patients']), NAV, LABEL);
    assert.equal(withPatients.landing.id, 'patients', 'у роли с картотекой вход открывается картотекой');
    assert.equal(withPatients.landing.kind, 'nav');
    const admin = roleReach({ name: 'admin', permissions: { sections: ['patients', 'dashboard'], levels: {}, patient_tabs: {} } }, ['patients', 'dashboard'], LABEL);
    assert.equal(admin.landing.id, 'dashboard', 'администратор входит в «Дашборд», хотя картотека стоит в меню раньше');
    const headDoc = roleReach({ name: 'head_doctor', permissions: { sections: ['patients', 'dashboard'], levels: {}, patient_tabs: {} } }, ['patients', 'dashboard'], LABEL);
    assert.equal(headDoc.landing.id, 'patients', 'дашборд открыт, но правило «сразу в дашборд» — только для admin');

    const labOnly = roleReach(role(['labs']), NAV, LABEL);
    assert.equal(labOnly.landing.id, 'labs', 'иначе — первый доступный пункт меню');

    const sentences = reachSentences(labOnly).map((l) => l.template);
    assert.ok(sentences.some((t) => /После входа открывается/.test(t)));
});

test('вкладки карты пациента перечисляются ТОЛЬКО когда они ограничены', () => {
    const plain = roleReach(role(['patients']), NAV, LABEL);
    assert.deepEqual(plain.tabs, [],
        'список из шести «полный доступ» прячет единственную важную строку среди пяти неважных');

    const limited = roleReach(role(['patients'], { tabs: { billing: 'none', docs: 'view' } }), NAV, LABEL);
    const byTab = Object.fromEntries(limited.tabs.map((t) => [t.id, t.level]));
    assert.equal(byTab.billing, 'none');
    assert.equal(byTab.docs, 'view');
    assert.ok(!('labs' in byTab), 'неограниченная вкладка попала в список ограничений');
});

// MY_STOCK_V1 — ЛИЧНЫЙ ЭКРАН НЕ ДОМАШНИЙ, И ЭТО ГЛАВНОЕ ПРО ПОРЯДОК МЕНЮ.
//
// «Мои запасы» стоят в клиническом блоке — раньше кассы, закупок и дашборда, —
// и открываются всякому, у кого есть отдел. Пока firstAllowedView()/
// landingScreen() просто брали первый доступный пункт, кассир с отделом входил
// в свой подотчёт вместо кассы, главный врач — вместо дашборда, кладовщик —
// вместо «Закупок», а эта самая сводка уверенно сообщала владельцу, что дом
// кассира — «Мои запасы».
//
// Порядок пунктов берётся ИЗ ОБОЛОЧКИ, а не переписывается сюда: беда была
// именно в порядке, и список, списанный руками, перестал бы её ловить на
// первой же перестановке пункта меню.
const SHELL_NAV_IDS = await (async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '..', '..', 'admin.js'), 'utf8');
    const at = src.indexOf('const NAV = [');
    const block = src.slice(at, src.indexOf('\nconst CRUMBS', at));
    return [...block.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
})();

test('MY_STOCK_V1: личный экран не бывает домашним — ни у кассира с отделом, ни у главного врача, ни у кладовщика', () => {
    const was = globalThis.window.easymed;
    // У вошедшего ЕСТЬ отдел: ровно так «Мои запасы» и становились домом.
    globalThis.window.easymed = { state: { user: { id: 7, role: 'nurse', department_id: 11 } } };
    try {
        assert.ok(SHELL_NAV_IDS.indexOf('my-stock') < SHELL_NAV_IDS.indexOf('cashier-shifts'),
            'подготовка: «Мои запасы» обязаны стоять в меню РАНЬШЕ кассы — иначе тест ничего не ловит');

        // Спрашивается САМА landingScreen на ЖИВОМ состоянии прав — то есть
        // ровно то положение, в котором работает оболочка: вошедший человек,
        // его отдел, его роль. Через previewRole() этот случай не проверить: в
        // предпросмотре отдела нарочно нет (I3 ниже), и «Мои запасы» кассиру
        // там не откроются вовсе — тест был бы зелёным и на сломанном коде.
        const landing = (name, sections) => {
            perms.setEffectiveFromRole({ name, permissions: { sections, levels: {}, patient_tabs: {} } });
            return landingScreen(SHELL_NAV_IDS);
        };

        assert.equal(landing('cashier', ['cashier', 'my-stock']).id, 'cashier-shifts',
            'кассир с отделом входит в свой подотчёт вместо кассы');
        assert.equal(landing('head_doctor', ['dashboard', 'reports-hub', 'my-stock']).id, 'dashboard',
            'главный врач входит в «Мои запасы» вместо дашборда');
        assert.equal(landing('inventory', ['inventory', 'dashboard', 'my-stock']).id, 'inventory',
            'кладовщик входит в «Мои запасы» вместо «Закупок»');

        // И «Мой отдел» тоже не дом: роль, у которой открыт ТОЛЬКО он, дома не
        // имеет — это честнее, чем обещать личный экран как рабочее место.
        assert.equal(landing('nurse', ['my-stock']), null,
            'роль без единого рабочего раздела получила домом личный экран');

        // При этом сами пункты остаются ОТКРЫТЫМИ — их прячут от ДОМА, а не от
        // человека: медсестра со своим подотчётом его по-прежнему видит.
        perms.setEffectiveFromRole({ name: 'nurse', permissions: { sections: ['patients', 'my-stock'], levels: {} } });
        assert.equal(perms.isModuleAllowed('my-stock'), true,
            'личный экран пропал вовсе — его убирают из ДОМАШНИХ, а не из доступных');
        assert.equal(landingScreen(SHELL_NAV_IDS).id, 'patients');
    } finally { globalThis.window.easymed = was; perms.setFullAccess('Admin'); }
});

test('правило «куда попадёт» не разошлось с оболочкой', async () => {
    // Правило продублировано в role-reach.js намеренно (иначе вид настроек
    // тянул бы оболочку и получал круговую зависимость). Дубликат прикрыт
    // здесь: если admin.js перестанет открывать вход журналом визитов, сводка
    // начнёт обещать не тот экран — и об этом скажет тест, а не сотрудник.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '..', '..', 'admin.js'), 'utf8');
    const at = src.indexOf('function firstAllowedView()');
    assert.notEqual(at, -1, 'в оболочке больше нет firstAllowedView — правило искать негде');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.match(body, /actorRoleCodes\(\)\.includes\('admin'\)/, 'оболочка больше не отправляет администратора в дашборд, а сводка обещает именно это');
    assert.match(body, /isModuleAllowed\('dashboard'\)/);
    assert.ok(!/isRouteAllowed\('visits'\)/.test(body), 'журнал визитов удалён — оболочка не должна его обещать');
    // MY_STOCK_V1 — и тот же пропуск личных экранов: без него оболочка сажала
    // бы кассира с отделом в «Мои запасы», а сводка обещала бы кассу.
    assert.match(body, /PERSONAL_VIEWS\.has\(item\.id\)/,
        'оболочка снова предлагает личный экран как домашний');
});
