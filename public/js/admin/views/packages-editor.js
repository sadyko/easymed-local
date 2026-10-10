// SERVICES_PACKAGES_V1 — «ПАКЕТЫ УСЛУГ» (Настройки → Настройки услуг; шаг 6 API
// клиники; макет screen-packages.js). Заменяет общий редактор справочника
// (settings-hub.js LOOKUP_CONFIG.service_packages: название, отметки услуг,
// процент, даты).
//
// Список — только ПАКЕТЫ (is_package = 1): шаблоны сметы живут в окнах
// «Шаблоны» сметы, как раньше. Окно пакета: название на трёх языках, услуги из
// всех пяти групп с ценой каждой в пакете, скидка процентом / суммой / ценой
// пакета, срок, показ на сайте и у партнёров. Все числа — одна функция
// (shared/package-price.js packageCalc): та же, что запишет цену на строку
// визита, выставит счёт и отдаст API.
//
// Права — плитка «Пакеты услуг» в «Ролях»: «Изменение» — название, услуги,
// срок, показ; скидку и цену — с действием «Цены и проценты» (поля, которых
// роль не пишет, не уходят и показаны только для чтения).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { settingsGrantColumns } from '../permissions.js';
import { triGroup, labeled, fieldErr } from './company-fields.js';
import { packageValidityParts } from './service-templates.js?v=tpl1';
import {
    PACKAGE_MODES, PACKAGE_MESSAGES, isPackageRow, packageIds, packageTerms, packageItems, packageCalc,
    packageValueFor, packageProblem, packagePublicState, packageHiddenServices,
} from '../../shared/package-price.js';
import { PUBLIC_GROUPS, serviceGroupOf } from '../../shared/service-public.js';

/** Подпись показа пакета в списке: [метка, вид метки, пояснение или ''] (ключи словаря). */
export const PACKAGE_STATE_TEXT = Object.freeze({
    shown:          ['На сайте', 'ok', ''],
    off:            ['Скрыт с сайта', '', ''],
    expired:        ['Скрыт с сайта', '', 'срок прошёл'],
    upcoming:       ['Скрыт с сайта', '', 'срок ещё не начался'],
    no_uz:          ['Скрыт с сайта', '', 'нет названия на узбекском'],
    empty:          ['Скрыт с сайта', '', 'нет действующих услуг'],
    service_hidden: ['Скрыт с сайта', '', 'в пакете скрытая услуга'],
    retired:        ['Снят с учёта', '', ''],
    not_package:    ['Скрыт с сайта', '', ''],
});
const MODE_LABEL = Object.freeze({ percent: 'Процент', amount: 'Сумма скидки', price: 'Цена пакета' });
const MODE_HINT = Object.freeze({
    percent: 'Например, 15 — скидка 15% на каждую услугу пакета.',
    amount:  'Сколько сум скидки на весь пакет; делим между услугами пропорционально цене.',
    price:   'Итоговая цена пакета; скидку посчитаем сами и разделим между услугами.',
});
const NOTE = 'Партнёры получают обе цены: «без скидки» и «цена пакета». Цена пакета окончательная: личные скидки пациента (категории, ручные) на пакет не действуют. В кассе скидка ложится на каждую услугу, как в колонке «В пакете»; если пациент вернёт одну услугу, ему вернут её цену в пакете, остальные останутся по цене пакета.';

const fmt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const sumText = (n) => trf('{sum} сум', { sum: fmt(n) });
const groupLabel = (s) => (PUBLIC_GROUPS.find((g) => g.key === serviceGroupOf(s)) || PUBLIC_GROUPS[0]).label;
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

/** Черновик окна из строки базы (null — новый пакет: процент 10, показ включён — макет). */
export function draftFromRow(row) {
    if (!row) return { id: null, name: { ru: '', uz: '', en: '' }, items: [], mode: 'percent', value: 10, from: '', to: '', pub: true, active: true };
    const t = packageTerms(row);
    return {
        id: row.id, name: { ru: row.name || '', uz: row.name_uz || '', en: row.name_en || '' }, items: packageIds(row),
        mode: t.mode, value: t.value, from: row.valid_from || '', to: row.valid_until || '',
        pub: Number(row.show_public) === 1 || row.show_public === true, active: !(row.active === 0 || row.active === false),
    };
}

/** Раскладка черновика по прайсу (services — строки services). */
export function draftCalc(draft, services) {
    const row = { service_ids: draft.items };
    return packageCalc({ mode: draft.mode, value: draft.value }, packageItems(row, services).items);
}

/** «Как задать скидку» переключили: значение пересчитано, цена пакета та же (макет). */
export function switchMode(draft, mode, services) {
    if (!PACKAGE_MODES.includes(mode) || mode === draft.mode) return draft;
    const value = packageValueFor(draftCalc(draft, services), mode);
    return { ...draft, mode, value };
}

/** Тело записи для /api/db: только колонки, которые пишет роль (cols — settingsGrantColumns). */
export function draftPayload(draft, calc, cols) {
    const can = (k) => !Array.isArray(cols) || cols.includes(k);
    const text = (v) => String(v == null ? '' : v).trim();
    const p = {};
    if (can('name')) p.name = text(draft.name.ru);
    if (can('name_uz')) p.name_uz = text(draft.name.uz) || null;
    if (can('name_en')) p.name_en = text(draft.name.en) || null;
    if (can('service_ids')) p.service_ids = [...draft.items];
    if (can('valid_from')) p.valid_from = draft.from || null;
    if (can('valid_until')) p.valid_until = draft.to || null;
    if (can('show_public')) p.show_public = draft.pub ? 1 : 0;
    if (can('discount_mode')) p.discount_mode = draft.mode;
    if (can('discount_value')) p.discount_value = Number(draft.value) || 0;
    // Прежняя колонка — процент скидки на день сохранения (для прежних читателей; деньги — discount_mode/value).
    if (can('discount_percent')) p.discount_percent = Math.min(100, Math.max(0, Number(calc && calc.pct) || 0));
    if (!draft.id && can('is_package')) p.is_package = 1;
    return p;
}

/** Строки поиска «Добавить услугу»: действующие, не в пакете, по названию; первые 8 (макет). */
export function pickList(services, draft, q) {
    const needle = String(q || '').trim().toLowerCase();
    return (services || [])
        .filter((s) => !(s.active === 0 || s.active === false) && !draft.items.includes(Number(s.id))
            && (!needle || String(s.name || '').toLowerCase().includes(needle)))
        .slice(0, 8);
}

function chips(name) {
    return h('span', { class: 'pkg-chips' }, ...['ru', 'uz', 'en'].map((l) => {
        const on = !!String((name && name[l]) || '').trim();
        return h('span', { class: 'pkg-chip' + (on ? ' on' : ''), title: on ? 'Есть перевод' : 'Нет перевода' }, document.createTextNode(l.toUpperCase()));
    }));
}

export async function renderPackagesEditor(container, { onBack = null, readOnly = false } = {}) {
    let services = [];
    let rows = [];

    async function load() {
        const [p, s] = await Promise.all([
            supabase.from('service_templates').select('*').eq('is_package', 1).order('name').limit(500),
            supabase.from('services').select('id, name, name_uz, price, type, is_lab, active, online_booking').order('name').limit(5000),
        ]);
        if (p.error) throw p.error;
        if (s.error) throw s.error;
        rows = (p.data || []).filter(isPackageRow);
        services = s.data || [];
    }

    async function showList() {
        clear(container);
        const listBox = h('div', { class: 'pkg-list' }, h('p', { class: 'muted' }, 'Загрузка…'));
        const add = readOnly ? h('span', { class: 'muted pkg-lock' }, Icon('Lock', { size: 14 }), ' ', 'Только просмотр')
            : h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openWindow(null) }, Icon('Plus', { size: 14 }), ' ', 'Добавить');
        container.appendChild(h('div', { class: 'fade-in pkg-page' },
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginBottom: '14px' },
                onclick: () => { if (typeof onBack === 'function') onBack(); } }, Icon('ChevronLeft', { size: 14 }), ' ', 'К плиткам настроек'),
            h('section', { class: 'card' },
                h('div', { class: 'card-header' }, h('h3', null, Icon('Copy', { size: 18 }), ' ', 'Пакеты услуг'), add),
                listBox)));
        try { await load(); } catch (e) {
            clear(listBox);
            listBox.appendChild(h('div', { class: 'empty', role: 'alert' }, 'Не удалось загрузить пакеты — обновите страницу.'));
            return;
        }
        clear(listBox);
        if (!rows.length) { listBox.appendChild(h('p', { class: 'muted pkg-empty' }, 'Пакетов пока нет — добавьте первый.')); return; }
        const day = today();
        const tb = h('tbody');
        const ordered = [...rows.filter((r) => Number(r.active) !== 0), ...rows.filter((r) => Number(r.active) === 0)];
        for (const r of ordered) {
            const c = packageCalc(packageTerms(r), packageItems(r, services).items);
            const st = packagePublicState(r, services, day);
            const [label, kind, why] = PACKAGE_STATE_TEXT[st] || PACKAGE_STATE_TEXT.off;
            const [vt, vp] = packageValidityParts(r, day);
            const hidden = st === 'service_hidden' ? packageHiddenServices(r, services).map((s) => s.name).join(', ') : '';
            const open = () => openWindow(r);
            tb.appendChild(h('tr', { class: 'row-click' + (Number(r.active) === 0 ? ' pkg-off' : ''), tabindex: '0', 'data-package-id': String(r.id),
                onclick: open, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
                h('td', null, h('div', { class: 'pkg-name' }, document.createTextNode(r.name || '—')), chips({ ru: r.name, uz: r.name_uz, en: r.name_en })),
                h('td', { class: 'num' }, document.createTextNode(String(packageIds(r).length))),
                h('td', { class: 'num pkg-r pkg-strike' }, document.createTextNode(fmt(c.full))),
                h('td', { class: 'num pkg-r' }, document.createTextNode('−' + fmt(c.off)), ' ', h('span', { class: 'muted' }, document.createTextNode(String(c.pct).replace('.', ',') + '%'))),
                h('td', { class: 'num pkg-r' }, h('b', null, document.createTextNode(fmt(c.price)))),
                h('td', null, trf(vt, vp)),
                h('td', null, Tag(label, { kind, dot: true }),
                    why ? h('div', { class: 'muted pkg-why' }, why) : null,
                    hidden ? h('div', { class: 'muted pkg-why' }, document.createTextNode(hidden)) : null)));
        }
        listBox.appendChild(h('div', { class: 'pkg-scroll' }, h('table', { class: 'tbl pkg-tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Название'), h('th', null, 'Услуг'), h('th', { class: 'pkg-r' }, 'Без скидки'),
                h('th', { class: 'pkg-r' }, 'Скидка'), h('th', { class: 'pkg-r' }, 'Цена пакета'), h('th', null, 'Действует'), h('th', null, 'Сайт и партнёры'))),
            tb)));
    }

    function openWindow(row) {
        const cols = settingsGrantColumns('service_templates');
        const canMoney = !readOnly && (!Array.isArray(cols) || cols.includes('discount_value'));
        let draft = draftFromRow(row);
        let q = '';
        const isNew = !row;
        const ov = h('div', { class: 'modal', 'data-dialog': 'package' });
        const shut = () => { document.removeEventListener('keydown', onEsc); ov.remove(); };
        const onEsc = (e) => { if (e.key === 'Escape') shut(); };

        const name = triGroup('Название', draft.name, { key: 'pkg-name', markMissing: true, max: 120, disabled: readOnly,
            onInput: (lng, v) => { draft = { ...draft, name: { ...draft.name, [lng]: v } }; } });
        const search = h('input', { type: 'text', class: 'docprof-in', placeholder: 'Поиск услуги…', autocomplete: 'off', disabled: readOnly });
        const searchField = labeled('Добавить услугу', search, { key: 'pkg-q' });
        const pickBox = h('div', { class: 'pkg-pick', role: 'list' });
        const linesBox = h('div', { class: 'pkg-lines' });
        const sumBox = h('div', { class: 'pkg-sum' });
        const servicesErr = fieldErr(null);
        const valueIn = h('input', { type: 'number', class: 'docprof-in pkg-value', min: '0', step: 'any', disabled: !canMoney, 'aria-label': 'Скидка' });
        valueIn.value = String(draft.value);
        const unit = h('span', { class: 'muted' });
        const hint = h('p', { class: 'cpf-hint' });
        const valueErr = fieldErr(valueIn);
        const modeBtns = PACKAGE_MODES.map((m) => ({ m, el: h('button', { type: 'button', class: 'pkg-mode', 'data-mode': m, disabled: !canMoney,
            onclick: () => { draft = switchMode(draft, m, services); valueIn.value = String(draft.value); valueErr.set(''); paint(); } }, MODE_LABEL[m]) }));
        const from = h('input', { type: 'date', class: 'docprof-in', disabled: readOnly });
        const to = h('input', { type: 'date', class: 'docprof-in', disabled: readOnly });
        from.value = draft.from; to.value = draft.to;
        const fromF = labeled('Действует с', from, { key: 'pkg-from', hint: 'Пусто — сразу.' });
        const toF = labeled('Действует по', to, { key: 'pkg-to', hint: 'Пусто — бессрочно. После этой даты пакет сам пропадает с сайта и у партнёров.' });
        const sw = h('button', { type: 'button', class: 'dpp-switch', role: 'switch', 'aria-label': 'Показывать пакет', disabled: readOnly,
            onclick: () => { draft = { ...draft, pub: !draft.pub }; paint(); } });
        const pubWarn = h('p', { class: 'cpf-hint pkg-warn', role: 'note' });

        function paint() {
            const calc = draftCalc(draft, services);
            for (const { m, el } of modeBtns) {
                el.setAttribute('aria-pressed', String(m === draft.mode));
                el.className = 'pkg-mode' + (m === draft.mode ? ' on' : '');
            }
            unit.textContent = draft.mode === 'percent' ? '%' : tr('сум');
            hint.textContent = tr(MODE_HINT[draft.mode]);
            sw.setAttribute('aria-checked', String(!!draft.pub));
            // Поиск: макет — группа и цена, клик добавляет, добавленные пропадают.
            clear(pickBox);
            if (!readOnly) {
                const found = pickList(services, draft, q);
                if (!found.length) pickBox.appendChild(h('div', { class: 'muted pkg-none' }, 'Ничего не нашлось.'));
                for (const s of found) {
                    pickBox.appendChild(h('button', { type: 'button', class: 'pkg-pick-row', role: 'listitem',
                        onclick: () => { draft = { ...draft, items: [...draft.items, Number(s.id)] }; servicesErr.set(''); paint(); } },
                        h('span', null, document.createTextNode(s.name || '—'), ' ', h('span', { class: 'muted' }, '· ', groupLabel(s))),
                        h('span', { class: 'num' }, document.createTextNode(fmt(s.price)))));
                }
            }
            clear(linesBox);
            if (!calc.lines.length) linesBox.appendChild(h('div', { class: 'muted pkg-empty' }, 'Добавьте услуги — цена пакета посчитается сама.'));
            else {
                const tb = h('tbody');
                for (const l of calc.lines) {
                    const s = services.find((x) => Number(x.id) === Number(l.service_id)) || {};
                    tb.appendChild(h('tr', null,
                        h('td', null, document.createTextNode(s.name || '—')),
                        h('td', { class: 'muted' }, groupLabel(s)),
                        h('td', { class: 'num pkg-r pkg-strike' }, document.createTextNode(fmt(l.full))),
                        h('td', { class: 'num pkg-r' }, h('b', null, document.createTextNode(fmt(l.price)))),
                        h('td', { class: 'pkg-x-cell' }, readOnly ? null : h('button', { type: 'button', class: 'pkg-x', 'aria-label': 'Убрать из пакета',
                            onclick: () => { draft = { ...draft, items: draft.items.filter((id) => id !== Number(l.service_id)) }; paint(); } }, Icon('X', { size: 14 })))));
                }
                linesBox.appendChild(h('div', { class: 'pkg-scroll' }, h('table', { class: 'tbl pkg-tbl' },
                    h('thead', null, h('tr', null, h('th', null, 'Услуга'), h('th', null, 'Группа'), h('th', { class: 'pkg-r' }, 'Цена'),
                        h('th', { class: 'pkg-r' }, 'В пакете'), h('th', { 'aria-label': 'Убрать из пакета' }))),
                    tb)));
            }
            clear(sumBox);
            sumBox.appendChild(h('div', null, h('span', null, 'Без скидки'), h('b', null, sumText(calc.full)), h('small', null, 'сумма цен услуг')));
            sumBox.appendChild(h('div', null, h('span', null, 'Скидка'), h('b', null, document.createTextNode('−' + fmt(calc.off) + ' ' + tr('сум'))),
                h('small', null, trf('{pct}% от суммы', { pct: String(calc.pct).replace('.', ',') }))));
            sumBox.appendChild(h('div', { class: 'main' }, h('span', null, 'Цена пакета'), h('b', null, sumText(calc.price)), h('small', null, 'округляем до 1 000 сум')));
            // В10 — пакет с услугой, которую сайт не показывает, партнёры не увидят.
            const hidden = packageHiddenServices({ service_ids: draft.items }, services).map((s) => s.name);
            pubWarn.hidden = !(draft.pub && hidden.length);
            pubWarn.textContent = hidden.length ? trf('Партнёры не увидят пакет, пока скрыты услуги: {names}.', { names: hidden.join(', ') }) : '';
        }
        search.addEventListener('input', () => { q = search.value; paint(); });
        valueIn.addEventListener('input', () => { draft = { ...draft, value: Number(valueIn.value) || 0 }; valueErr.set(''); paint(); });
        from.addEventListener('input', () => { draft = { ...draft, from: from.value }; });
        to.addEventListener('input', () => { draft = { ...draft, to: to.value }; toF.err.set(''); });

        const sec = (title, sub, ...body) => h('section', { class: 'pkg-sec' }, h('h4', null, title, sub ? [' ', h('small', null, sub)] : null), ...body);
        const showErr = (field, message) => {
            if (field === 'name') name.inputs.ru.err.set(message);
            else if (field === 'name_uz') name.inputs.uz.err.set(message);
            else if (field === 'name_en') name.inputs.en.err.set(message);
            else if (field === 'discount_value' || field === 'discount_mode') valueErr.set(message);
            else if (field === 'valid_until' || field === 'valid_from') toF.err.set(message);
            else servicesErr.set(message);
        };
        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: readOnly, onclick: () => save() }, isNew ? 'Добавить' : 'Сохранить');
        async function save(extra = null) {
            const calc = draftCalc(draft, services);
            const payload = extra || draftPayload(draft, calc, cols);
            if (!extra) {
                const p = packageProblem(payload, { insert: isNew, full: calc.full, merged: { ...(row || {}), ...payload } });
                if (p) { showErr(p.field, p.message); return; }
            }
            saveBtn.disabled = true;
            const res = isNew
                ? await supabase.from('service_templates').insert(payload).select().single()
                : await supabase.from('service_templates').update(payload).eq('id', row.id).select().single();
            saveBtn.disabled = false;
            if (res.error) {
                if (res.error.field) showErr(res.error.field, res.error.message);
                else toast(tr(res.error.message || 'Не удалось сохранить пакет.'), 'fail');
                return;
            }
            shut();
            toast(tr(extra ? 'Сохранено' : 'Пакет сохранён'), 'ok');
            await showList();
        }
        const retire = !isNew && !readOnly && (!Array.isArray(cols) || cols.includes('active'))
            ? h('button', { class: 'btn', type: 'button', onclick: () => save({ active: draft.active ? 0 : 1 }) }, draft.active ? 'Снять с учёта' : 'Вернуть в список')
            : null;

        ov.appendChild(h('div', { class: 'modal-backdrop', onclick: shut }));
        ov.appendChild(h('div', { class: 'modal-card pkg-card', role: 'dialog', 'aria-modal': 'true' },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Copy', { size: 18 }), ' ', isNew ? 'Новый пакет услуг' : document.createTextNode(row.name || '')),
                h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Закрыть', onclick: shut }, Icon('X', { size: 16 }))),
            h('div', { class: 'modal-body pkg-body' },
                sec('Название', 'на трёх языках', name.node),
                sec('Услуги пакета', 'из всех пяти групп', readOnly ? null : searchField.node, readOnly ? null : pickBox, servicesErr.node),
                sec('Скидка и цена', '',
                    h('div', { class: 'pkg-mode-row' },
                        h('div', { class: 'pkg-modes', role: 'group', 'aria-label': 'Как задать скидку' }, ...modeBtns.map((b) => b.el)),
                        h('div', { class: 'pkg-value-box' }, valueIn, unit)),
                    hint, valueErr.node,
                    canMoney ? null : h('p', { class: 'cpf-hint' }, 'Скидку и цену пакета меняет роль с правом «Цены и проценты».'),
                    linesBox, sumBox,
                    h('p', { class: 'cpf-note pkg-note', role: 'note' }, Icon('Info', { size: 16 }), h('span', null, NOTE))),
                sec('Срок действия', '', h('div', { class: 'pkg-grid2' }, fromF.node, toF.node)),
                sec('Публикация', '',
                    h('div', { class: 'dpp-switch-row' }, sw,
                        h('div', { class: 'dpp-switch-text' }, h('b', null, 'Показывать пакет на сайте и у партнёров'),
                            h('span', { class: 'muted' }, 'Нужно название на русском и узбекском.'))),
                    pubWarn)),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', type: 'button', onclick: shut }, 'Отмена'), retire, h('span', { class: 'grow' }), saveBtn)));
        document.addEventListener('keydown', onEsc);
        document.body.appendChild(ov);
        paint();
        return ov;
    }

    await showList();
    return { openWindow, reload: showList };
}
