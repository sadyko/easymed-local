// ROLES_MATRIX_V1 (2026-09-18) — МАТРИЦА ПРАВ ПО СПРАВОЧНИКУ: раздел → окно → действие.
//
// Владелец: «can we make a useful/understandable ui and functions for the roles
// and permissions so user who assigns the functions and roles understands what
// he's doing».
//
// ЧТО РИСУЕТСЯ. Для каждого раздела из permission-catalog.js — строка с
// уровнем (Нет / Просмотр / Изменение / Удаление), под ней окна раздела и его
// действия, каждое со своим уровнем. У строки показаны только те уровни,
// которые в ней что-то значат. Под каждой — одна фраза, что даёт выбранный
// уровень: человек видит последствие галочки в момент, когда её ставит.
//
// ЧИСТАЯ ЛОГИКА ОТДЕЛЬНО ОТ ЭКРАНА. grantsFromLegacy / legacyFromGrants /
// collectGrants не трогают DOM — их проверяет тест без браузера. Экран рисует
// paintCatalog и только он.
//
// ДВА ЯЗЫКА ХРАНЕНИЯ, ОДНА ПРАВДА. Старые ворота читают permissions.sections /
// levels (ключи NAV_MODULES: 'beds', 'consultation'…), новые — permissions.grants
// (ключи справочника: 'inpatient.vitals'…). Экран работает с grants, а при
// сохранении ВЫВОДИТ из них старые поля — чтобы ни одни ворота не остались
// без ответа. И наоборот: роль, у которой grants ещё нет, получает их из
// старых полей при открытии — экран показывает то, что действует сейчас, а не
// пустую матрицу, которая читалась бы как «у роли нет ничего».
import { h, Icon } from './ui.js';
import { tr, trf } from './i18n.js';
import { CATALOG, LEVELS, LEVEL_LABELS, levelAllows } from '../shared/permission-catalog.js';

// Старый уровень ↔ новый.
const LEGACY_TO_GRANT = { viewer: 'view', editor: 'edit', admin: 'delete' };
const GRANT_TO_LEGACY = { view: 'viewer', edit: 'editor', delete: 'admin' };
const RANK = { none: 0, view: 1, edit: 2, delete: 3 };
const maxLevel = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b);

/** Самый высокий уровень, который у строки вообще есть. */
function capOf(row) {
    return (row.levels || ['none', 'view']).slice(-1)[0];
}
function clampTo(row, lvl) {
    const allowed = row.levels || ['none', 'view'];
    if (allowed.includes(lvl)) return lvl;
    // Уровня нет у строки — берём ближайший снизу из существующих.
    let best = 'none';
    for (const l of allowed) if ((RANK[l] || 0) <= (RANK[lvl] || 0)) best = maxLevel(best, l);
    return best;
}

/**
 * grants из старых полей — для роли, у которой grants ещё нет.
 * Раздел получает уровень старого ключа; окна и действия внутри —
 * ТОТ ЖЕ уровень, срезанный до того, что у строки существует. Это ровно то,
 * что действует сегодня: ворота действий ещё живут по спискам ролей, но для
 * экрана «раздел выдан» означает «всё внутри доступно, как было».
 */
export function grantsFromLegacy(perms) {
    const sections = new Set((perms && perms.sections) || []);
    const levels = (perms && perms.levels) || {};
    const grants = {};
    for (const s of CATALOG) {
        const legacy = s.legacy;
        const on = legacy && sections.has(legacy);
        const lvl = on ? (LEGACY_TO_GRANT[levels[legacy]] || 'delete') : 'none';
        grants[s.key] = clampTo(s, lvl);
        for (const w of s.windows || []) grants[w.key] = on ? clampTo(w, lvl) : 'none';
        for (const a of s.actions || []) grants[a.key] = on ? clampTo(a, lvl) : 'none';
    }
    return grants;
}

/**
 * Старые поля из grants — чтобы прежние ворота продолжали работать.
 * Несколько разделов справочника могут делить один старый ключ ('beds' у
 * стационара, листа медсестры, порционника и выписок): он выдан, если выдан
 * хоть один из них, с самым высоким уровнем.
 *
 * `prev` — прежние sections/levels: ключи, которых справочник не знает
 * ('registration', 'custdev', 'queue'…), переносятся как есть — сохранение
 * роли не должно молча стирать настройку, сделанную другим экраном.
 */
export function legacyFromGrants(grants, prev = {}) {
    const known = new Set(CATALOG.map((s) => s.legacy).filter(Boolean));
    const sections = [];
    const levels = {};
    for (const key of (prev.sections || [])) {
        if (!known.has(key)) { sections.push(key); if (prev.levels && prev.levels[key]) levels[key] = prev.levels[key]; }
    }
    const best = {};
    for (const s of CATALOG) {
        if (!s.legacy) continue;
        const lvl = grants[s.key] || 'none';
        if (lvl === 'none') continue;
        best[s.legacy] = maxLevel(best[s.legacy] || 'none', lvl);
    }
    // Производные старые ключи, которых в справочнике нет как разделов.
    if ((grants['patients'] || 'none') !== 'none' && levelAllows(grants['patients'], 'edit')) best.registration = maxLevel(best.registration || 'none', 'edit');
    if ((grants['patients.queue'] || 'none') !== 'none') best.queue = maxLevel(best.queue || 'none', 'view');
    for (const [key, lvl] of Object.entries(best)) {
        if (!sections.includes(key)) sections.push(key);
        levels[key] = GRANT_TO_LEGACY[lvl] || 'admin';
    }
    return { sections, levels };
}

/**
 * grants из нарисованных переключателей — С ОГЛЯДКОЙ НА ЗАКРЫТЫЙ РАЗДЕЛ.
 *
 * ЧТО ЧИНИМ. Раздел, поставленный в «Нет», гасит свои окна и действия
 * (levelPicker disable), но погашенный переключатель ЗНАЧЕНИЯ не теряет: он
 * так и стоит на прежнем уровне. Прочитанные как есть, они уезжали в базу
 * строкой «custdev: Нет, custdev.list: Просмотр, custdev.rate: Изменение» — и
 * сервер, спрошенный про ОКНО, пускал на доску закрытого раздела, хотя до
 * появления строк матрицы одна галочка раздела отказывала. Погасить — это про
 * экран; ОТНЯТЬ — это про то, что уезжает в базу.
 *
 * ЧТО СЧИТАЕТСЯ РЕШЕНИЕМ. «Нет» у раздела бывает ВЫВЕДЕННЫМ: у роли, которой
 * миграция выдала ключ точечно (crm.dial колл-центру), раздел CRM рисуется из
 * старой галочки, и она может быть не отмечена. Решение — это `explicit`
 * (ключи, записанные у роли САМИ, perms.grants) и `closed` (разделы, которые
 * закрыли ЗДЕСЬ И СЕЙЧАС). Всё остальное — догадка экрана, и с ней делается
 * две вещи, обе обязательные:
 *
 *   1. по ней НИЧЕГО не обнуляется — иначе сохранение молча отняло бы у роли
 *      выданный телефон, хотя администратор ничего не закрывал;
 *   2. она и сама НЕ ЗАПИСЫВАЕТСЯ. Это второе важнее первого и стоило
 *      отдельного разбора: сохранение пишет матрицу ЦЕЛИКОМ, и уехавшее в неё
 *      `crm: none` сервер от решения уже не отличит (grants.js: раздел закрыт,
 *      когда его уровень настроен ЯВНО) — он закроет по нему все ключи
 *      телефонии, а экран будет показывать «Позвонить пациенту: Изменение».
 *      Беда приходила через шаг: достаточно было открыть роль, поправить
 *      постороннее и нажать «Сохранить».
 *
 * Раздел, закрытый здесь и сейчас, обнуляет свои строки сразу (paintCatalog),
 * поэтому сюда они приходят уже нулями; clamp ниже — страховка и починка тех
 * записей, что сделаны до этой правки.
 */
export function collectGrants(controls, { explicit = {}, closed = null } = {}) {
    const out = {};
    for (const [key, ctl] of Object.entries(controls)) out[key] = ctl.value();
    for (const s of CATALOG) {
        if (!(s.key in out) || out[s.key] !== 'none') continue;
        const decided = (s.key in (explicit || {})) || !!(closed && closed.has(s.key));
        if (!decided) { delete out[s.key]; continue; }
        for (const r of [...(s.windows || []), ...(s.actions || [])]) {
            if (r.key in out) out[r.key] = 'none';
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Экран
// ---------------------------------------------------------------------------
//
// ROLES_MATRIX_LEAN_V1 (2026-09-18) — владелец, глядя на первую версию: «its
// still not understandable, i guess there is too many text. can we make the
// line between lines».
//
// Было: под каждой строкой — описание строки И по фразе на КАЖДЫЙ уровень
// (три-четыре строки текста на одну галочку). Стало: у строки одна подпись —
// что даёт ВЫБРАННЫЙ уровень; пока уровень «Нет» — что это за окно или
// действие. Остальные уровни объясняются подсказкой на самой таблетке.
// Между строками — линия: глаз идёт по строкам, а не по абзацам.

// CALLCENTER_OPERATOR_V1 — СПРАВОЧНИК ГОВОРИТ НА ЯЗЫКЕ ЭКРАНА.
//
// permission-catalog.js лежит в public/js/shared и общей проверкой переводов
// (__tests__/i18n-coverage.test.mjs) не охвачен: она ходит только по
// public/js/admin. Поэтому подписи справочника печатались по-русски и в
// узбекском, и в английском экране — ошибка, которую ни один тест не поймал
// бы. Переводятся они ЗДЕСЬ, в месте отрисовки: tr() отдаёт неизвестную строку
// как есть, поэтому строка без перевода остаётся читаемой, а не пустой.

/** Одна подпись строки: что даёт выбранный уровень, а при «Нет» — что это. */
function lineFor(row, lvl) {
    const d = row.levelDesc && row.levelDesc[lvl];
    return tr(d || row.desc || '');
}

/** Переключатель уровня: одна группа radio на строку, только существующие уровни. */
function levelPicker(row, value, onChange, { disabled = false } = {}) {
    const name = 'grant:' + row.key;
    const box = h('div', { class: 'rm-levels', role: 'radiogroup', 'aria-label': tr('Уровень доступа') });
    const inputs = [];
    for (const lvl of row.levels || ['none', 'view']) {
        const id = 'rm-' + row.key.replace(/[^a-z0-9]/gi, '-') + '-' + lvl;
        const inp = h('input', { type: 'radio', name, id, value: lvl, checked: value === lvl ? true : null, disabled: disabled ? true : null });
        inp.addEventListener('change', () => onChange(lvl));
        inputs.push(inp);
        // Подсказка на таблетке — что даст этот уровень, если его выбрать.
        const tip = row.levelDesc && row.levelDesc[lvl];
        box.appendChild(h('label', { class: 'rm-pill is-' + lvl, for: id, title: tip ? tr(tip) : null }, inp, h('span', null, tr(LEVEL_LABELS[lvl]))));
    }
    return {
        el: box,
        value: () => { const on = inputs.find((i) => i.checked); return on ? on.value : 'none'; },
        set: (lvl) => { for (const i of inputs) i.checked = i.value === lvl; },
        disable: (on) => { for (const i of inputs) i.disabled = !!on; },
    };
}

/** Подпись строки — перерисовать под новый уровень. */
function paintNote(box, row, lvl) {
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(h('span', null, lineFor(row, lvl)));
}

// ROLES_ACCORDION_V1 (2026-09-18) — владелец: «make the sections (modules) in
// the roles section a collapsible (accordion like)».
//
// Семнадцать разделов с окнами и действиями — это экран на несколько
// прокруток; свёрнутый раздел занимает одну строку: имя, уровень и счёт
// «Окна 2 из 3 · Действия 4 из 6», чтобы и в закрытом виде было видно, что
// внутри уже открыто. Какие разделы раскрыты — помнится между ролями, пока
// экран открыт (`openSections` держит редактор ролей): администратор
// сравнивает две роли по одному и тому же разделу, не раскрывая его заново;
// новый заход на экран начинается свёрнутым списком. Смена уровня самого
// раздела раскрывает его: строки внутри должны быть перед глазами, а не за
// шевроном.
//
// РАЗДЕЛ БЕЗ ОКОН И ДЕЙСТВИЙ (касса, отчёты, настройки…) не раскрывается
// вовсе: у него нет шеврона и нет тела. Владелец раскрыл «Настройки», увидел
// пустоту и написал «nothing is found» — шеврон, за которым ничего нет, это
// обещание, которое экран не держит. Всё, что про такой раздел можно сказать,
// уже в его строке: подпись и уровень справа.

/** Счёт открытого внутри раздела — для свёрнутой строки. */
function paintCount(box, s, controls) {
    while (box.firstChild) box.removeChild(box.firstChild);
    const parts = [];
    const tally = (rows, template) => {
        if (!rows || !rows.length) return;
        const on = rows.filter((r) => controls[r.key] && controls[r.key].value() !== 'none').length;
        parts.push(trf(template, { on, all: rows.length }));
    };
    tally(s.windows, 'Окна {on} из {all}');
    tally(s.actions, 'Действия {on} из {all}');
    if (parts.length) box.appendChild(h('span', null, parts.join(' · ')));
}

/**
 * Нарисовать матрицу в `host`. `grants` — текущие значения. Возвращает
 * controls (ключ → {value, set, disable}) для collectGrants.
 * `onAnyChange` зовётся после каждого переключения — для сводки словами.
 * `openSections` — Set ключей раскрытых разделов; экран отдаёт один и тот же
 * на все свои перерисовки, чтобы раскрытое пережило смену роли.
 * `closedSections` — Set, куда складываются разделы, закрытые В ЭТОТ ЗАХОД:
 * по нему collectGrants отличает решение администратора от «Нет», выведенного
 * из старых полей. Его заводят на КАЖДУЮ роль заново — решение, принятое про
 * одну роль, про соседнюю ничего не значит.
 */
export function paintCatalog(host, grants, { onAnyChange = null, openSections = new Set(), closedSections = null } = {}) {
    const controls = {};
    const panels = [];   // [{key, open(bool)}] — для «Развернуть все / Свернуть все»
    // Уровни строк, обнулённых закрытием раздела: закрыть и тут же передумать —
    // обычное движение руки, и оно не должно стоить всей настройки раздела.
    const closedLevels = new Map();

    host.appendChild(h('div', { class: 'rm-toolbar' },
        h('button', { type: 'button', class: 'link-btn rm-toolbar-btn', onclick: () => { for (const p of panels) p.open(true); } }, tr('Развернуть все')),
        h('span', { class: 'rm-toolbar-sep', 'aria-hidden': 'true' }, '·'),
        h('button', { type: 'button', class: 'link-btn rm-toolbar-btn', onclick: () => { for (const p of panels) p.open(false); } }, tr('Свернуть все'))));

    for (const s of CATALOG) {
        const sectionLvl = grants[s.key] || 'none';
        const block = h('div', { class: 'rm-section' + (sectionLvl === 'none' ? ' is-off' : ''), dataset: { section: s.key } });
        const kids = [];
        const body = h('div', { class: 'rm-body' });
        const count = h('span', { class: 'rm-count muted' });

        const note = h('span', { class: 'rm-note' });
        paintNote(note, s, sectionLvl);
        const picker = levelPicker(s, sectionLvl, (lvl) => {
            paintNote(note, s, lvl);
            block.classList.toggle('is-off', lvl === 'none');
            // Раздел закрыт — окна и действия в нём ничего не значат: гасим их,
            // ОБНУЛЯЕМ и говорим почему, вместо галочек, которые не работают.
            // Обнулять обязательно: погашенный переключатель сохраняет прежний
            // уровень, и «Нет» у раздела при «Просмотре» у его окна — это не
            // выдумка, а ровно то, что уезжало в базу (см. collectGrants).
            // Открыли обратно — строки возвращаются: передумать администратору
            // не должно стоить всей настройки раздела.
            for (const k of kids) { k.disable(lvl === 'none'); if (lvl === 'none') k.close(); else k.reopen(); }
            // Закрытие ЗДЕСЬ И СЕЙЧАС — решение, и только оно уезжает в базу как
            // «Нет» раздела (collectGrants).
            if (closedSections) { if (lvl === 'none') closedSections.add(s.key); else closedSections.delete(s.key); }
            paintCount(count, s, controls);
            hint.hidden = lvl !== 'none' || !kids.length;
            setOpen(true);
            if (onAnyChange) onAnyChange();
        });
        controls[s.key] = picker;

        const hasInner = !!((s.windows || []).length || (s.actions || []).length);
        const name = h('span', { class: 'rm-name' },
            h('span', { class: 'rm-title' }, tr(s.label)),
            h('span', { class: 'rm-desc' }, note, count));
        // Раздел без окон и действий — просто строка: шеврон, за которым пусто,
        // обещал бы то, чего нет.
        const toggle = hasInner
            ? h('button', {
                type: 'button', class: 'rm-toggle', 'aria-expanded': 'false',
                title: 'Показать окна и действия раздела',
                onclick: () => setOpen(body.hidden),
            }, h('span', { class: 'rm-chev' }, Icon('ChevronRight', { size: 14 })), name)
            : h('div', { class: 'rm-toggle is-static' }, h('span', { class: 'rm-chev is-blank', 'aria-hidden': 'true' }), name);
        const setOpen = (on) => {
            if (!hasInner) return;
            body.hidden = !on;
            toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
            toggle.setAttribute('title', tr(on ? 'Свернуть раздел' : 'Показать окна и действия раздела'));
            block.classList.toggle('is-open', on);
            if (on) openSections.add(s.key); else openSections.delete(s.key);
        };
        if (hasInner) panels.push({ key: s.key, open: setOpen });

        block.appendChild(h('div', { class: 'rm-row rm-row-section' }, toggle, picker.el));

        const hint = h('div', { class: 'rm-hint muted' }, tr('Сначала откройте раздел — тогда можно выбрать, что в нём доступно.'));
        hint.hidden = sectionLvl !== 'none' || !((s.windows || []).length || (s.actions || []).length);
        body.appendChild(hint);

        const sub = (title, rows) => {
            if (!rows || !rows.length) return;
            body.appendChild(h('div', { class: 'rm-subhead' }, title));
            for (const r of rows) {
                const lvl = grants[r.key] || 'none';
                const rnote = h('div', { class: 'rm-desc' });
                paintNote(rnote, r, lvl);
                const p = levelPicker(r, lvl, (l) => { paintNote(rnote, r, l); paintCount(count, s, controls); if (onAnyChange) onAnyChange(); },
                    { disabled: sectionLvl === 'none' });
                controls[r.key] = p;
                kids.push({
                    disable: (on) => p.disable(on),
                    close: () => {
                        const was = p.value();
                        if (was !== 'none') closedLevels.set(r.key, was);
                        p.set('none'); paintNote(rnote, r, 'none');
                    },
                    // Возвращаем только то, что сами же и обнулили, и только если
                    // строка так и стоит в «Нет»: чужого выбора трогать нельзя.
                    reopen: () => {
                        const was = closedLevels.get(r.key);
                        if (!was || p.value() !== 'none') return;
                        p.set(was); paintNote(rnote, r, was);
                    },
                });
                body.appendChild(h('div', { class: 'rm-row rm-row-sub' },
                    h('div', { class: 'rm-name' },
                        h('div', { class: 'rm-title' }, tr(r.label)),
                        rnote),
                    p.el));
            }
        };
        sub(tr('Окна раздела'), s.windows);
        sub(tr('Действия'), s.actions);
        paintCount(count, s, controls);

        if (hasInner) {
            block.appendChild(body);
            setOpen(openSections.has(s.key));
        }
        host.appendChild(block);
    }
    return controls;
}
