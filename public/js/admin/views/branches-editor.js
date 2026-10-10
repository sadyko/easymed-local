// BRANCH_PROFILE_V1 — «ФИЛИАЛЫ»: здания клиники списком и страница здания
// (branch-page.js). Заменяет общий редактор справочника (settings-hub.js
// LOOKUP_CONFIG.branches: название, телефон, адрес) и облачную форму
// #settings:branches (admin.js LEGACY_ROUTES уводит её в хаб). План
// docs/plans/2026-10-10-clinic-api-4-branches.md, задача 15.
//
// Список — карточками (решение Р12): на телефоне один столбец, без прокрутки
// вбок. Своё здание (window.CLINIC.own_branch_id) помечено «Это здание»; в
// главном его адрес для партнёров, карта и телефон — из «Компании»
// (overlayOwnBuilding): одно место на адрес здания. Название — на языке
// интерфейса (name_uz / name_en, иначе RU); вся остальная программа
// показывает прежнее name (решение плана Р4).
//
// Список не прочитался — объяснение и «Добавить филиал» нет: не видя
// существующих, здание завели бы второй раз.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag } from '../ui.js';
import { tr, getLang } from '../i18n.js';
import { hasRestriction, actorIsAdmin } from '../permissions.js';
import { renderBranchPage } from './branch-page.js';
import { DAY_LABEL } from './branch-hours-card.js';
import { placeName } from '../../shared/clinic-profile.js';
import { BRANCH_MESSAGES, OWN_FROM_COMPANY, overlayOwnBuilding } from '../../shared/branch-profile.js';
import { readBranchHours, hoursGroups } from '../../shared/branch-hours.js';

const clinic = () => (typeof window !== 'undefined' && window.CLINIC) || {};
// «Компания» не прочиталась: у своего здания адреса, карты и телефона не
// видно — подставлять старое из строки branches значило бы показать второй адрес.
const NO_COMPANY = Object.freeze(Object.fromEntries(OWN_FROM_COMPANY.map((c) => [c, ''])));

/** «Пн–Пт 09:00–18:00, Сб 09:00–15:00» / «Круглосуточно» / «Без ограничений». */
export function hoursText(row) {
    const hrs = readBranchHours(row.working_hours, row.is_24_7);
    if (hrs.mode === 'allday') return tr('Круглосуточно');
    if (hrs.mode === 'none') return tr('Без ограничений');
    return hoursGroups(hrs).map((g) => tr(DAY_LABEL[g.from]) + (g.to !== g.from ? '–' + tr(DAY_LABEL[g.to]) : '') + ' ' + g.hours).join(', ');
}

const line = (icon, text) => h('span', { class: 'brf-line' }, Icon(icon, { size: 14 }), h('span', null, document.createTextNode(text)));
function chips(row) {
    const done = { ru: row.name && row.street_ru, uz: row.name_uz && row.street_uz, en: row.name_en && row.street_en };
    return h('span', { class: 'brf-chips' }, ...['ru', 'uz', 'en'].map((l) => {
        const on = !!String(done[l] || '').trim();
        return h('span', { class: 'brf-chip' + (on ? ' on' : ''), title: on ? 'Есть перевод' : 'Нет перевода' }, document.createTextNode(l.toUpperCase()));
    }));
}
// legacy — показывать ли прежний адрес (branches.address), пока улицы нет. У
// своего здания главного его нет ни на странице, ни в «Компании»: там адрес
// один — из «Компании» (ревью шага 4, находка 7).
function itemEl(row, { own, onOpen, legacy = true }) {
    const off = Number(row.active) === 0;
    const shown = Number(row.show_public ?? 1) !== 0;
    const addr = [row.street_ru, row.landmark_ru].map((s) => String(s || '').trim()).filter(Boolean).join(', ')
        || (legacy ? String(row.address || '').trim() : '') || '—';
    return h('button', { type: 'button', class: 'brf-item' + (off ? ' brf-off' : ''), onclick: onOpen },
        h('span', { class: 'brf-head' },
            h('b', null, document.createTextNode(placeName(row, getLang()) || '—')),
            own ? Tag('Это здание', { kind: 'teal' }) : null,
            Tag(off ? 'Отключён' : 'Работает', { kind: off ? '' : 'ok' }),
            Tag(shown ? 'На сайте' : 'Скрыт с сайта', { kind: shown ? 'ok' : '' })),
        line('MapPin', addr),
        line('Phone', String(row.phone || '').trim() || '—'),
        line('Clock', hoursText(row)),
        h('span', { class: 'brf-line' }, Icon('Flag', { size: 14 }), h('span', null, row.maps_url ? 'Есть карта' : 'Нет карты')),
        chips(row));
}

export async function renderBranchesEditor(container, { onBack = null, onNavigate = null, readOnly = false, renderSyncCard = null } = {}) {
    const secondary = clinic().building_role === 'secondary';
    const ownId = clinic().own_branch_id;
    let company = null;
    let pageLeave = null;   // CLINIC_API_STEP7_V1 (ревью слияния №4) — защита открытой страницы здания
    async function showList() {
        pageLeave = null;
        clear(container);
        const listBox = h('div', { class: 'brf-list' });
        const actions = h('div', { class: 'page-head-actions' });
        // ROLE_REPORTS_SETTINGS_V1 (ревью C1) — связь зданий зовёт админские RPC: только полному доступу.
        const syncSlot = typeof renderSyncCard === 'function' && (!hasRestriction() || actorIsAdmin()) ? h('div', { class: 'brf-sync' }) : null;
        container.appendChild(h('div', { class: 'fade-in brf-list-page' },
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginBottom: '14px' },
                onclick: () => { if (typeof onBack === 'function') onBack(); } }, Icon('ChevronLeft', { size: 14 }), ' ', 'К плиткам настроек'),
            h('div', { class: 'page-head' },
                h('div', null, h('h1', { class: 'page-title' }, 'Филиалы'),
                    h('p', { class: 'page-subtitle' }, 'Здания клиники. Название, адрес, карта и часы работы на трёх языках получат сайт клиники, Symptex и партнёры.')),
                actions),
            secondary ? h('p', { class: 'cpf-note brf-note', role: 'note' }, Icon('Building', { size: 16 }), h('span', null, BRANCH_MESSAGES.mainOnly)) : null,
            syncSlot,
            listBox));
        if (syncSlot) renderSyncCard(syncSlot).catch((e) => console.warn('[branch-sync] card failed:', e && e.message));
        let rows = [];
        let loadFailed = false;
        try {
            const { data, error } = await supabase.from('branches').select('*').order('name').limit(500);
            if (error) throw error;
            rows = Array.isArray(data) ? data : [];
        } catch (e) {
            loadFailed = true;
            toast(tr('Не удалось загрузить филиалы.') + ' ' + tr((e && e.message) || ''), 'fail');
        }
        company = null;
        if (!loadFailed && !secondary && ownId != null && rows.some((r) => Number(r.id) === Number(ownId))) {
            try {
                const { data, error } = await supabase.from('doc_settings').select('*').eq('id', 1).maybeSingle();
                if (error) throw error;
                company = data && typeof data === 'object' && !Array.isArray(data) ? data : NO_COMPANY;
            } catch (e) {
                company = NO_COMPANY;
                toast(tr('Не удалось загрузить данные компании.') + ' ' + tr((e && e.message) || ''), 'fail');
            }
        }
        if (readOnly) actions.appendChild(h('span', { class: 'muted brf-lock' }, Icon('Lock', { size: 14 }), ' ', 'Только просмотр'));
        else if (!secondary && !loadFailed) {
            actions.appendChild(h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => showPage(null, false) },
                Icon('Plus', { size: 14 }), ' ', 'Добавить филиал'));
        }
        if (loadFailed) {
            listBox.appendChild(h('div', { class: 'empty', role: 'alert' }, 'Не удалось загрузить филиалы — обновите страницу.'));
            return;
        }
        if (!rows.length) listBox.appendChild(h('p', { class: 'muted' }, 'Филиалов пока нет.'));
        for (const r of rows) {
            const own = ownId != null && Number(r.id) === Number(ownId);
            const shown = own && !secondary ? overlayOwnBuilding(r, company) : r;
            listBox.appendChild(itemEl(shown, { own, legacy: !(own && !secondary), onOpen: () => showPage(r, own) }));   // ревью 7
        }
    }
    async function showPage(row, own) {
        await renderBranchPage(container, { row, own: !!own && !secondary, company, readOnly, secondary,
            onBack: showList, onDone: showList, onNavigate, registerLeave: (fn) => { pageLeave = fn; } });
    }
    await showList();
    // CLINIC_API_STEP7_V1 (ревью слияния №4) — «к списку» извне: со страницы здания —
    // через её защиту (несохранённое — вопрос, отказ — страница остаётся); со списка —
    // ничего не меняется.
    return {
        toList() { if (pageLeave) pageLeave(() => { showList(); }); },
    };
}
