// NAV_VISIBILITY_V1 (2026-10-26) — «Настройки → Основное → Видимость разделов».
//
// Владелец (снимок хаба и бокового меню): «in here build visibility setting of
// functions from here, only setting block can not be unvisible». Галочка на
// каждом пункте бокового меню; снятая — раздел исчезает из меню у всех
// сотрудников клиники и по прямой ссылке показывает «раздел скрыт». Права
// ролей это не меняет: это «чего в клинике нет», а не «кому что можно».
// «Настройки» — всегда, иначе негде было бы вернуть остальное.
//
// Список пунктов — тот же NAV, что рисует меню (admin.js открывает его наружу
// как window.easymed.NAV, как и для сводки прав в «Ролях»): второй копии
// списка нет, новый пункт меню появляется здесь сам.
import { h, Icon, PageHead, Tag, clear, toast, checkField } from '../ui.js';
import { t, tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { navGroups, canHide, withHidden, normalizeHidden } from '../nav-visibility-logic.js';

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return data;
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// FIX_318_V1 (B4) — подэкраны раздела знает оболочка (window.easymed.subViewsOf —
// из её PARENT_OF), подписи — здесь. Названия: у кого есть своё имя в меню
// (sidebar.nav.*: «Регистратура», «Документы», «Лист назначений»…), то и берём;
// у трёх экранов своего имени нет — для них подпись ниже; остальным — заголовок
// раздела оболочки (лист CRUMBS, переведён — app-shell.test.mjs это стережёт).
const SUB_LABEL = {
    'patient-card': 'Карта пациента',
    registration: 'Регистрация пациента',
    'service-workspace': 'Приём пациента',
    'case-file': 'История болезни',
};
function subViewsOf(id) {
    const fn = typeof window !== 'undefined' && window.easymed && window.easymed.subViewsOf;
    const list = typeof fn === 'function' ? fn(id) : [];
    return Array.isArray(list) ? list : [];
}
function subViewLabel(id) {
    if (SUB_LABEL[id]) return tr(SUB_LABEL[id]);
    const key = 'sidebar.nav.' + id;
    const own = t(key, null);
    if (own && own !== key) return own;
    const titleFor = typeof window !== 'undefined' && window.easymed && window.easymed.sectionTitleFor;
    return tr(typeof titleFor === 'function' ? titleFor(id, null) : id);
}

export async function renderNavVisibility(container, ctx = {}) {
    clear(container);
    const root = h('div', { class: 'fade-in navvis' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'Видимость разделов',
        subtitle: 'Какие разделы меню есть в этой клинике. Снятый раздел исчезает из бокового меню у всех сотрудников, какие бы права у них ни были; права ролей это не меняет. «Настройки» скрыть нельзя.',
    }));
    const body = h('div');
    root.appendChild(body);
    body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));

    const nav = (typeof window !== 'undefined' && window.easymed && Array.isArray(window.easymed.NAV)) ? window.easymed.NAV : [];
    const state = { hidden: [], saved: [], busy: false };
    try {
        const res = await rpc('nav_visibility_get');
        state.hidden = normalizeHidden(res && res.hidden);
        state.saved = [...state.hidden];
    } catch (e) {
        clear(body);
        body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, trf('Не удалось загрузить: {msg}', { msg: (e && e.message) || String(e) })));
        return;
    }
    const foot = h('div', { class: 'navvis-foot' });
    paint();

    function paint() {
        clear(body);
        for (const g of navGroups(nav)) {
            const rows = g.items.map((it) => {
                const locked = !canHide(it.id);
                const hidden = state.hidden.includes(it.id);
                const cb = h('input', { type: 'checkbox', checked: locked || !hidden, disabled: locked, 'data-nav-toggle': it.id,
                    onchange: () => { state.hidden = withHidden(state.hidden, it.id, !cb.checked); paintRowTag(row, it.id); paintRowWarn(row, it.id); paintFoot(); } });
                const row = h('div', { class: 'navvis-row', 'data-nav-row': it.id },
                    h('div', { class: 'navvis-row-main' },
                        checkField(t('sidebar.nav.' + it.id, it.label), cb),
                        it.foldsInto ? h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 0 26px' } },
                            'У большинства ролей этот пункт — вкладка внутри другого раздела, отдельной строки в меню у них нет.') : null,
                        h('div', { class: 'navvis-row-warn' })),
                    h('div', { class: 'navvis-row-tag' }, locked ? Tag(tr('всегда'), { kind: 'ok' }) : (hidden ? Tag(tr('скрыт'), { kind: 'warn' }) : null)));
                paintRowWarn(row, it.id);
                return row;
            });
            body.appendChild(h('div', { class: 'card', style: { marginBottom: '14px' } },
                h('div', { class: 'card-header' }, h('h3', null, g.section ? t('sidebar.sections.' + g.section, g.section) : tr('Прочее'))),
                h('div', { style: { padding: '10px 18px 6px' } }, ...rows)));
        }
        body.appendChild(foot);
        paintFoot();
    }

    function paintRowTag(row, id) {
        const slot = row.querySelector ? row.querySelector('.navvis-row-tag') : null;
        if (!slot) return;
        clear(slot);
        if (state.hidden.includes(id)) slot.appendChild(Tag(tr('скрыт'), { kind: 'warn' }));
    }

    // FIX_318_V1 (B4) — снятый раздел уносит и экраны внутри себя (PARENT_OF
    // оболочки): скрытые «Пациенты» — карту пациента, регистрацию,
    // «Регистратуру», архив документов, и ссылки на них из CRM и блока «Звонит»
    // открывают «Раздел скрыт». Говорим это у самой галочки, до сохранения.
    function paintRowWarn(row, id) {
        const slot = row.querySelector ? row.querySelector('.navvis-row-warn') : null;
        if (!slot) return;
        clear(slot);
        if (!state.hidden.includes(id)) return;
        const labels = [...new Set(subViewsOf(id).map(subViewLabel))];
        if (!labels.length) return;
        slot.appendChild(h('div', { 'data-nav-warn': id, role: 'note', style: { fontSize: '12.5px', margin: '2px 0 6px 26px', color: 'var(--warn-800)' } },
            trf('Вместе с разделом скроются и экраны внутри него: {list}. Ссылки на них из других разделов будут открывать «Раздел скрыт».', { list: labels.join(', ') })));
    }

    function paintFoot() {
        clear(foot);
        const dirty = !same(state.hidden, state.saved);
        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: !dirty, 'data-nav-save': '',
            onclick: () => run(saveBtn, async () => {
                const res = await rpc('nav_visibility_save', { hidden: state.hidden });
                state.hidden = normalizeHidden(res && res.hidden);
                state.saved = [...state.hidden];
                if (typeof window !== 'undefined' && window.easymed && typeof window.easymed.setNavHidden === 'function') window.easymed.setNavHidden(state.saved);
                toast('Сохранено. Меню обновлено у вас сразу, у остальных — после перезагрузки страницы.', 'success');
                paint();
            }) }, Icon('Check', { size: 13 }), ' ', tr('Сохранить'));
        const allBtn = h('button', { class: 'btn btn-outline', type: 'button', disabled: !state.hidden.length, 'data-nav-show-all': '',
            onclick: () => { state.hidden = []; paint(); } }, tr('Показать все'));
        foot.appendChild(h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            saveBtn, allBtn, h('span', { class: 'grow' }),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                dirty ? tr('Есть несохранённые изменения.') : trf('Скрыто разделов: {n}', { n: state.saved.length }))));
    }

    async function run(btn, fn) {
        if (state.busy) return;
        state.busy = true;
        const label = btn.textContent;
        btn.disabled = true; btn.textContent = '…';
        try { await fn(); }
        catch (e) { toast((e && e.message) || tr('Не удалось сохранить.'), 'error'); }
        finally { state.busy = false; try { btn.disabled = false; btn.textContent = label; } catch (_) { /* перерисовано */ } }
    }
}
