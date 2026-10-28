// NAV_GROUPS_V1 (2026-10-17) — боковое меню: четыре группы в порядке владельца,
// три из них свёрнуты, и всё меню помещается в окно без прокрутки.
//
// Владелец: «Block Clinical … Money Section (it should be Folded) … Operations
// (it should be Folded) … Settings (it should be Folded) … Reports (it should be
// Folded)», «All of them should fit, and no need for scrolling» и, посмотрев
// на dev: «put the cashier and head cashier to operations».
//
// admin.js не импортируется (он монтирует оболочку при загрузке), поэтому
// состав NAV читается из исходника теми же регулярками, что в
// app-shell.test.mjs; логика раскрытия — чистые функции admin/nav-fold.js.
// Сам замер «без прокрутки» — в браузере на dev-сервере (см. спек), здесь
// проверяется только то, что плотность задана там, где решено.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeSectionOf, isNavSectionOpen, setNavSectionOpen, navFitsOpen, groupBadge } from '../nav-fold.js';   // navFitsOpen, groupBadge — FIX_318_V1

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, '..', '..', '..', '..', rel), 'utf8');
const SHELL = read('public/js/admin.js');
const NAV_SRC = SHELL.slice(SHELL.indexOf('const NAV = ['), SHELL.indexOf('// Live nav badges'));
const MAIN_CSS = read('public/css/admin.css');

// Группы и пункты в порядке объявления: [{ section, fold, ids }].
function parseNav(src) {
    const groups = [];
    const re = /\{\s*section:\s*'([^']+)'([^}]*)\}|\{\s*id:\s*'([^']+)',\s*label:/g;
    for (const m of src.matchAll(re)) {
        if (m[1]) groups.push({ section: m[1], fold: /\bfold:\s*true\b/.test(m[2]), ids: [] });
        else groups[groups.length - 1].ids.push(m[3]);
    }
    return groups;
}
const GROUPS = parseNav(NAV_SRC);

// Порядок владельца. «Очередь» (queue) не в его списке — у администратора её
// нет в меню (foldsInto: 'patients'); она остаётся под «Кабинетом врача», как
// требует её комментарий. «Мой отдел» (my-department) тоже не назван —
// виден только сотруднику с отделом — и едет вместе с «Моими запасами».
const OWNER_ORDER = [
    ['Clinical',   false, ['patients', 'consultation', 'queue', 'labs', 'procedures', 'admissions',
                           'mar-nurse', 'kitchen-sheet', 'discharge', 'patient-documents']],
    // REFERRALS_NAV_V1 (2026-10-26) — «Реферирование» своим пунктом сразу за CRM (владелец:
    // «it should be separate section in operation block»).
    ['Operations', true,  ['crm', 'referrals', 'telegram-chat', 'cashier-shifts', 'cashier-head', 'inventory', 'my-stock', 'my-department']],
    ['Settings',   true,  ['settings']],
    ['Insights',   true,  ['dashboard', 'reports-hub']],
];

test('разбор NAV не пустой (сломанный разбор не должен пройти за чистый)', () => {
    assert.ok(GROUPS.length >= 4, 'групп разобрано: ' + GROUPS.length);
    assert.ok(GROUPS.reduce((n, g) => n + g.ids.length, 0) >= 15, 'пунктов разобрано мало');
});

test('четыре группы в порядке владельца, и в каждой — его пункты в его порядке', () => {
    assert.deepEqual(GROUPS.map((g) => g.section), OWNER_ORDER.map((g) => g[0]));
    for (const [section, , ids] of OWNER_ORDER) {
        const got = GROUPS.find((g) => g.section === section);
        assert.deepEqual(got.ids, ids, 'состав или порядок группы ' + section);
    }
});

test('сворачиваемы три группы (по умолчанию раскрыты — NAV_UNFOLDED_V1), «Клиника» — нет', () => {
    assert.deepEqual(GROUPS.map((g) => [g.section, g.fold]), OWNER_ORDER.map((g) => [g[0], g[1]]));
});

test('заголовок новой группы «Настройки» переведён на три языка, «Деньги» убраны', () => {
    // i18n.js при импорте трогает document, а fake-DOM здесь не нужен: словарь
    // секций — три литерала `sections: {…}` (en, ru, uz), и у каждого должны
    // быть оба новых ключа. Полную проверку через hasKey() по ВСЕМ секциям NAV
    // делает app-shell.test.mjs («каждый пункт и каждая секция меню…»).
    const I18N = read('public/js/admin/i18n.js');
    const maps = [...I18N.matchAll(/sections:\s*\{([^}]*)\}/g)].map((m) => m[1]);
    assert.equal(maps.length, 3, 'словарей секций должно быть три (en, ru, uz)');
    for (const body of maps) {
        assert.match(body, /\bSettings:\s*'[^']+'/, 'нет Settings: ' + body.trim());
        assert.doesNotMatch(body, /\bMoney:/, 'группа «Деньги» убрана владельцем, перевод не должен висеть мёртвым');
    }
    assert.match(maps[1], /Settings:\s*'Настройки'/, 'русский заголовок группы настроек');
});

test('activeSectionOf — группа пункта, который несёт открытый экран', () => {
    const nav = [
        { section: 'Clinical' }, { id: 'patients' },
        { section: 'Settings', fold: true }, { id: 'settings' },
        { section: 'Operations', fold: true }, { id: 'inventory' },
    ];
    assert.equal(activeSectionOf(nav, (it) => it.id === 'inventory'), 'Operations');
    assert.equal(activeSectionOf(nav, (it) => it.id === 'patients'), 'Clinical');
    assert.equal(activeSectionOf(nav, () => false), null, 'ничей экран — нет группы');
    assert.equal(activeSectionOf([{ id: 'orphan' }], (it) => it.id === 'orphan'), null, 'пункт до первого заголовка — вне групп');
});

test('isNavSectionOpen — без fold всегда открыта; с fold — раскрыта по умолчанию (NAV_UNFOLDED_V1), свёрнута щелчком, группа открытого экрана — всегда', () => {
    const clinical = { section: 'Clinical' };
    const ops = { section: 'Operations', fold: true };
    assert.equal(isNavSectionOpen(clinical, { opened: new Set(), activeSection: 'Operations' }), true);
    assert.equal(isNavSectionOpen(ops, { closed: new Set(), activeSection: null }), true, 'раскрыта по умолчанию — владелец: «make this unfolded»');
    assert.equal(isNavSectionOpen(ops, { closed: new Set(['Operations']), activeSection: null }), false, 'свёрнута щелчком');
    assert.equal(isNavSectionOpen(ops, { closed: new Set(['Operations']), activeSection: 'Operations' }), true, 'в ней открытый экран — раскрыта и свёрнутая');
    assert.equal(isNavSectionOpen(ops, { closed: new Set(['Operations']), activeSection: 'Clinical' }), false, 'открытый экран в другой группе — остаётся свёрнутой');
    assert.equal(isNavSectionOpen(ops), true, 'без контекста — раскрыта');
});

test('setNavSectionOpen — класс на списке, класс и aria-expanded на заголовке', () => {
    const el = () => {
        const classes = new Set(); const attrs = {};
        return { classes, attrs,
            classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) },
            setAttribute: (k, v) => { attrs[k] = v; } };
    };
    const header = el(), nav = el();
    setNavSectionOpen(header, nav, false);
    assert.ok(nav.classes.has('nav--folded'));
    assert.ok(header.classes.has('nav-section--folded'));
    assert.equal(header.attrs['aria-expanded'], 'false');
    setNavSectionOpen(header, nav, true);
    assert.ok(!nav.classes.has('nav--folded'));
    assert.ok(!header.classes.has('nav-section--folded'));
    assert.equal(header.attrs['aria-expanded'], 'true');
});

test('renderSidebar: свёрнутая группа — кнопка с шевроном, решает nav-fold, аккордеона «Soon» нет', () => {
    // Комментарии снимаем: запись «здесь стоял аккордеон Soon» обязана остаться
    // в коде, а проверяется то, что исполняется.
    const body = SHELL.slice(SHELL.indexOf('function renderSidebar()'), SHELL.indexOf('sidebarEl.appendChild(sidebarClock())'))
        .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.match(body, /if \(item\.fold\)/, 'ветка свёрнутой группы читает флаг fold');
    assert.match(body, /h\('button', \{ class: 'nav-section nav-section--toggle'/, 'заголовок свёрнутой группы — кнопка');
    // NAV_UNFOLDED_V1 + FIX_318_V1 (B2) — щелчок запоминается в обе стороны
    // (closed / opened), короткое окно (compact) сворачивает по умолчанию.
    assert.match(body, /isNavSectionOpen\(item, \{ closed: navClosed, opened: navOpened, activeSection, compact: navCompact \}\)/);
    assert.match(body, /activeSectionOf\(NAV, navItemOwns\)/, 'группа открытого экрана считается до цикла');
    assert.ok(!/easymed_soon_collapsed|=== 'Soon'/.test(body), 'мёртвый аккордеон Soon остался');
    assert.ok(!/localStorage/.test(body), 'состояние групп не пишется в localStorage (решение спека)');
});

test('CSS: свёрнутый список скрыт, на рейке (sidebar-collapsed) показан; шеврон поворачивается', () => {
    assert.match(MAIN_CSS, /^\.sidebar-body \.nav\.nav--folded \{ display: none; \}/m);
    assert.match(MAIN_CSS, /^\.sidebar-collapsed \.sidebar-body \.nav\.nav--folded \{ display: flex; \}/m);
    assert.match(MAIN_CSS, /^\.nav-section--folded \.nav-section-chev \{ transform: rotate\(-90deg\); \}/m);
});

test('CSS: плотность меню задана через .sidebar .nav-item, а общий .nav-item не тронут', () => {
    const at = MAIN_CSS.indexOf('\n.nav-item {');
    const base = MAIN_CSS.slice(at, MAIN_CSS.indexOf('}', at));
    assert.match(base, /padding: 9px 12px;/, 'общий .nav-item (рейки lab-panels, section-crud) должен остаться 9px');
    const at2 = MAIN_CSS.indexOf('\n.sidebar .nav-item {');
    const scoped = MAIN_CSS.slice(at2, MAIN_CSS.indexOf('}', at2));
    assert.match(scoped, /padding-top: 7px;/);
    assert.match(scoped, /padding-bottom: 7px;/);
    assert.match(MAIN_CSS, /\.sidebar-body \.nav \{ display: flex; flex-direction: column; gap: 1px; \}/);
    // FIX_318_V1 (B2) — ступень поднята с 760px до 800px (1440×900 с панелями
    // браузера, 1366×768 во весь экран) и добавлена вторая, 680px (1366×768 в
    // браузере, окно ~657px), — по замеру в браузере.
    assert.match(MAIN_CSS, /@media \(max-height: 800px\) \{[\s\S]*?\.sidebar \.nav-item \{ padding-top: 5px; padding-bottom: 5px; \}/, 'ступень для ноутбука 768p и окна 900p');
    assert.match(MAIN_CSS, /@media \(max-height: 680px\) \{[\s\S]*?\.sidebar \.nav-item \{ padding-top: 4px; padding-bottom: 4px; \}/, 'ступень для окна браузера на 768p');
    assert.ok(!/@media \(max-height: 760px\)/.test(MAIN_CSS), 'старая ступень 760px осталась рядом с новой');
});

// ===========================================================================
// FIX_318_V1 (B2) — «БЕЗ ПРОКРУТКИ» ДОЛЖНО БЫТЬ ПРАВДОЙ И НА НОУТБУКЕ.
//
// NAV_UNFOLDED_V1 раскрыл все группы, а ступень max-height:760px считалась под
// СВЁРНУТЫЕ группы: на 1366×768 (окно ~657px) меню прокручивалось, на 1280×720 и
// 1440×900 — тоже. Теперь: если раскрытое меню не входит в окно (compact),
// группы без открытого экрана по умолчанию свёрнуты. Щелчок человека — в обе
// стороны — сильнее умолчания.
// ===========================================================================
test('FIX_318_V1: isNavSectionOpen на коротком окне — свёрнута по умолчанию; группа экрана и раскрытая щелчком — раскрыты', () => {
    const ops = { section: 'Operations', fold: true };
    const clinical = { section: 'Clinical' };
    assert.equal(isNavSectionOpen(ops, { compact: true }), false, 'не входит в окно — сворачиваемая группа свёрнута');
    assert.equal(isNavSectionOpen(clinical, { compact: true }), true, '«Клиника» не сворачивается никогда');
    assert.equal(isNavSectionOpen(ops, { compact: true, activeSection: 'Operations' }), true, 'группа открытого экрана раскрыта');
    assert.equal(isNavSectionOpen(ops, { compact: true, opened: new Set(['Operations']) }), true, 'раскрыта щелчком — выбор человека сильнее');
    assert.equal(isNavSectionOpen(ops, { compact: false, closed: new Set(['Operations']) }), false, 'свёрнута щелчком на высоком окне');
    assert.equal(isNavSectionOpen(ops, { compact: false }), true, 'входит в окно — раскрыта (NAV_UNFOLDED_V1)');
});

test('FIX_318_V1: navFitsOpen меряет меню с РАСКРЫТЫМИ группами и возвращает классы на место; без раскладки — null', () => {
    const navEl = (items) => {
        const cls = new Set();
        return { items, cls, classList: { contains: (c) => cls.has(c), toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } } };
    };
    const ops = navEl(7), ins = navEl(2);
    ops.cls.add('nav--folded');   // свёрнута сейчас
    const groups = [{ navEl: ops }, { navEl: ins }];
    const body = (client) => ({
        clientHeight: client,
        get scrollHeight() { return 300 + groups.reduce((n, g) => n + (g.navEl.cls.has('nav--folded') ? 0 : g.navEl.items * 30), 0); },
    });
    assert.equal(navFitsOpen(body(500), groups), false, '300 + 9×30 = 570 не входит в 500');
    assert.ok(ops.cls.has('nav--folded') && !ins.cls.has('nav--folded'), 'замер не вернул классы на место');
    assert.equal(navFitsOpen(body(600), groups), true);
    assert.equal(navFitsOpen(body(0), groups), null, 'нет раскладки (вкладка скрыта, тест без DOM) — не решаем');
    assert.equal(navFitsOpen(null, groups), null);
});

// FIX_318_V1 (B6) — у свёрнутой группы заголовок несёт сумму счётчиков её
// пунктов: просроченные задачи CRM, неоплаченные счета, непрочитанный чат,
// обновление в «Настройках» не прячутся в свёрнутой группе.
test('FIX_318_V1: groupBadge — сумма счётчиков пунктов; красная, если красен хоть один ненулевой', () => {
    assert.equal(groupBadge([]), null);
    assert.equal(groupBadge([{ count: 0, alert: true }, { count: null, alert: true }]), null, 'ничего не ждёт — бейджа нет');
    assert.deepEqual(groupBadge([{ count: 3, alert: true }, { count: 2, alert: false }]), { total: 5, alert: true });
    assert.deepEqual(groupBadge([{ count: 4, alert: false }]), { total: 4, alert: false });
    assert.deepEqual(groupBadge([{ count: 0, alert: true }, { count: 4, alert: false }]), { total: 4, alert: false });
});

test('FIX_318_V1: CSS — бейдж заголовка виден только у свёрнутой группы и не на рейке', () => {
    assert.match(MAIN_CSS, /^\.nav-section-badge \{[^}]*display: none;/m, 'у раскрытой группы бейдж заголовка дублировал бы бейджи пунктов');
    assert.match(MAIN_CSS, /^\.nav-section--folded \.nav-section-badge \{[^}]*display: inline-flex;/m);
    assert.match(MAIN_CSS, /^\.nav-section-badge\.alert \{/m, 'красный бейдж заголовка');
});
