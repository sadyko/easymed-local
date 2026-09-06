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

test('роль без единого раздела названа неработающей, а не «почти настроенной»', () => {
    const reach = roleReach(role([]), NAV, LABEL);
    assert.equal(reach.opens.length, 0);
    const lines = reachSentences(reach);
    assert.equal(lines.length, 1, 'у пустой роли одна строка — и та про то, что работать нельзя');
    assert.equal(lines[0].tone, 'crit');
    assert.match(lines[0].template, /не сможет работать/);
});

test('сказано, куда сотрудник попадёт после входа', () => {
    const withPatients = roleReach(role(['patients']), NAV, LABEL);
    assert.equal(withPatients.landing.kind, 'visits',
        'у роли с картотекой вход открывается журналом визитов — как в оболочке');

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
    assert.match(body, /isRouteAllowed\('visits'\)/,
        'оболочка больше не открывает вход журналом визитов, а сводка обещает именно его');
});
