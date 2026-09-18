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
import { h } from './ui.js';
import { tr } from './i18n.js';
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

/** grants из нарисованных переключателей. */
export function collectGrants(controls) {
    const out = {};
    for (const [key, ctl] of Object.entries(controls)) out[key] = ctl.value();
    return out;
}

// ---------------------------------------------------------------------------
// Экран
// ---------------------------------------------------------------------------

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
        box.appendChild(h('label', { class: 'rm-pill is-' + lvl, for: id }, inp, h('span', null, LEVEL_LABELS[lvl])));
    }
    return {
        el: box,
        value: () => { const on = inputs.find((i) => i.checked); return on ? on.value : 'none'; },
        set: (lvl) => { for (const i of inputs) i.checked = i.value === lvl; },
        disable: (on) => { for (const i of inputs) i.disabled = !!on; },
    };
}

/**
 * Что даёт КАЖДЫЙ уровень строки — все строки сразу, текущий выделен.
 * Администратор решает, какой уровень выдать, ДО того как его выбрал: значит,
 * последствия всех вариантов должны быть перед глазами, а не по одному после
 * щелчка. Уровни, у которых своего описания нет, не выдумываются.
 */
function paintNote(box, row, lvl) {
    while (box.firstChild) box.removeChild(box.firstChild);
    const lines = [];
    for (const l of (row.levels || [])) {
        if (l === 'none') continue;
        const d = row.levelDesc && row.levelDesc[l];
        if (!d) continue;
        lines.push([l, d]);
    }
    // У строки без своих описаний уровней (окно, которое можно только открыть)
    // описание уже стоит под названием — повторять его строкой «Просмотр» незачем.
    for (const [l, d] of lines) {
        box.appendChild(h('div', { class: 'rm-note-line' + (l === lvl ? ' is-on' : '') + (levelAllows(lvl, l) ? ' is-in' : '') },
            h('span', { class: 'rm-note-lvl' }, LEVEL_LABELS[l]), h('span', null, d)));
    }
    if (lvl === 'none') box.appendChild(h('div', { class: 'rm-note-line is-none' }, tr('Сейчас: недоступно.')));
}

/**
 * Нарисовать матрицу в `host`. `grants` — текущие значения. Возвращает
 * controls (ключ → {value, set, disable}) для collectGrants.
 * `onAnyChange` зовётся после каждого переключения — для сводки словами.
 */
export function paintCatalog(host, grants, { onAnyChange = null } = {}) {
    const controls = {};

    for (const s of CATALOG) {
        const sectionLvl = grants[s.key] || 'none';
        const block = h('div', { class: 'rm-section' + (sectionLvl === 'none' ? ' is-off' : '') });
        const kids = [];

        const note = h('div', { class: 'rm-note' });
        paintNote(note, s, sectionLvl);
        const picker = levelPicker(s, sectionLvl, (lvl) => {
            paintNote(note, s, lvl);
            block.classList.toggle('is-off', lvl === 'none');
            // Раздел закрыт — окна и действия в нём ничего не значат: гасим их и
            // говорим почему, вместо галочек, которые не работают.
            for (const k of kids) k.disable(lvl === 'none');
            hint.hidden = lvl !== 'none' || !kids.length;
            if (onAnyChange) onAnyChange();
        });
        controls[s.key] = picker;

        block.appendChild(h('div', { class: 'rm-row rm-row-section' },
            h('div', { class: 'rm-name' },
                h('div', { class: 'rm-title' }, s.label),
                h('div', { class: 'rm-desc' }, s.desc || '')),
            picker.el));
        block.appendChild(note);

        const hint = h('div', { class: 'rm-hint muted' }, tr('Сначала откройте раздел — тогда можно выбрать, что в нём доступно.'));
        hint.hidden = sectionLvl !== 'none' || !((s.windows || []).length || (s.actions || []).length);
        block.appendChild(hint);

        const sub = (title, rows) => {
            if (!rows || !rows.length) return;
            block.appendChild(h('div', { class: 'rm-subhead' }, title));
            for (const r of rows) {
                const lvl = grants[r.key] || 'none';
                const rnote = h('div', { class: 'rm-note rm-note-sub' });
                paintNote(rnote, r, lvl);
                const p = levelPicker(r, lvl, (l) => { paintNote(rnote, r, l); if (onAnyChange) onAnyChange(); },
                    { disabled: sectionLvl === 'none' });
                controls[r.key] = p;
                kids.push(p);
                block.appendChild(h('div', { class: 'rm-row rm-row-sub' },
                    h('div', { class: 'rm-name' },
                        h('div', { class: 'rm-title' }, r.label),
                        h('div', { class: 'rm-desc' }, r.desc || '')),
                    p.el));
                block.appendChild(rnote);
            }
        };
        sub(tr('Окна раздела'), s.windows);
        sub(tr('Действия'), s.actions);

        host.appendChild(block);
    }
    return controls;
}
