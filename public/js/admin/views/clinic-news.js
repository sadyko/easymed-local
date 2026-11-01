// CLINIC_NEWS_V1 (2026-10-31) — «Информационная доска» клиники.
//
// Владелец: «add here informative dashboard button too, where can be added
// daily news of clinic, about foreign doctors coming, some equipment is not
// working place and so on». Карточка на витрине «Коммерческие инструменты»
// (commerce-hub.js) открывает этот экран по адресу #clinic-news.
//
// Читают все сотрудники; администратор видит сверху форму «Новое объявление»,
// а у каждого объявления — «Изменить» и «Снять». Снятые и истёкшие — во
// вкладке «Архив» (сервер: rpc/clinic-news.js, таблица — мигр. 266).
import { h, Icon, Tag, PageHead, clear, toast, field, checkField } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { actorIsAdmin } from '../permissions.js';

export const KINDS = [
    { id: 'news',         label: 'Новости',        icon: 'Megaphone',   tone: 'info' },
    { id: 'doctor_visit', label: 'Приезжий врач',  icon: 'Stethoscope', tone: 'ok' },
    { id: 'equipment',    label: 'Оборудование',   icon: 'Warning',     tone: 'crit' },
    { id: 'other',        label: 'Другое',         icon: 'Info',        tone: '' },
];
const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[KINDS.length - 1];

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || tr('Не удалось выполнить запрос.'));
    return data;
}

// CLINIC_NEWS_STRIP_V1 — полоса «Новости клиники» у стойки перечитывается
// сразу после публикации и снятия (мост в admin.js; в тестах его нет).
function refreshStrip() {
    try { if (typeof window !== 'undefined' && typeof window.easymedRefreshNewsStrip === 'function') window.easymedRefreshNewsStrip(); } catch (_) { /* полоса — не повод ронять доску */ }
}

/** «31.10.2026» из 'YYYY-MM-DD' или ISO. */
export function dmy(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
    if (!m) return '';
    if (String(v).length > 10) {   // ISO со временем — по местному времени
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    }
    return `${m[3]}.${m[2]}.${m[1]}`;
}

export async function renderClinicNews(container) {
    clear(container);
    const isAdmin = actorIsAdmin();
    const state = { archive: false, kind: 'all', items: [], error: null };
    const root = h('div', { class: 'fade-in cn-page', 'data-clinic-news': '' });
    container.appendChild(root);
    // CLINIC_NEWS_MODAL_V1 (2026-10-31, владелец: «make it as a pop up just
    // leave butto to publish news») — карточки «Новое объявление» на странице
    // больше нет: в шапке одна кнопка «Опубликовать новость», форма открывается
    // окном. «Изменить» у объявления открывает то же окно, заполненное.
    root.appendChild(PageHead({
        title: 'Информационная доска',
        subtitle: 'Новости клиники для сотрудников: приезжие врачи, неработающее оборудование, объявления дня.',
        right: isAdmin ? h('button', { class: 'btn btn-primary', type: 'button', 'data-cn-new': '', onclick: () => openForm(null) },
            Icon('Megaphone', { size: 14 }), ' ', tr('Опубликовать новость')) : null,
    }));
    const barHost = h('div');
    const listHost = h('div');
    root.append(barHost, listHost);

    async function load() {
        state.error = null;
        try { state.items = (await rpc('clinic_news_list', { archive: state.archive })).items || []; }
        catch (e) { state.error = e.message; state.items = []; }
        paintBar(); paintList();
    }

    // ---- форма (только администратор) — окно CLINIC_NEWS_MODAL_V1 ----
    function openForm(ed) {
        if (!isAdmin) return;
        document.querySelector('[data-cn-modal]')?.remove();
        const overlay = h('div', { class: 'modal', 'data-cn-modal': '' });
        const onKey = (ev) => { if (ev.key === 'Escape') close(); };
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const kindSel = h('select', { 'data-cn-kind': '' }, ...KINDS.map((k) => h('option', { value: k.id, selected: ed ? ed.kind === k.id : k.id === 'news' }, tr(k.label))));
        const title = h('input', { type: 'text', maxlength: '200', 'data-cn-title': '', placeholder: tr('Например: С 3 по 5 ноября принимает кардиолог из Турции'), value: ed ? ed.title : '' });
        const body = h('textarea', { rows: '3', maxlength: '4000', 'data-cn-body': '', placeholder: tr('Подробности: кто, когда, куда записывать, что делать вместо…') });
        body.value = ed ? ed.body || '' : '';
        const until = h('input', { type: 'date', 'data-cn-until': '', value: ed && ed.show_until ? ed.show_until : '' });
        const pinned = h('input', { type: 'checkbox', checked: !!(ed && ed.pinned), 'data-cn-pinned': '' });
        // CLINIC_NEWS_IMPORTANT_V1 (владелец: «add important button where that
        // will be yellow with important text») — кнопка-переключатель, а не
        // ещё одна галочка: включённая она светло-красная (было жёлтым,
        // CLINIC_NEWS_IMPORTANT_RED_V1), и так же объявление встанет на доску —
        // администратор видит результат до публикации.
        let important = !!(ed && ed.important);
        const importantBtn = h('button', {
            type: 'button', class: 'cn-imp-toggle', 'data-cn-important': '', 'aria-pressed': String(important),
            title: tr('Выделить объявление красным: его заметят первым'),
            onclick: () => { important = !important; importantBtn.setAttribute('aria-pressed', String(important)); },
        }, Icon('Warning', { size: 14 }), h('span', null, tr('Важно')));
        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-cn-save': '',
            onclick: async () => {
                if (!title.value.trim()) { toast(tr('Напишите заголовок объявления.'), 'warn'); title.focus(); return; }
                saveBtn.disabled = true;
                try {
                    await rpc('clinic_news_save', { id: ed ? ed.id : undefined, kind: kindSel.value, title: title.value, body: body.value, show_until: until.value || null, pinned: pinned.checked, important });
                    toast(ed ? tr('Объявление исправлено.') : tr('Объявление опубликовано.'), 'success');
                    state.archive = false;
                    close(); await load(); refreshStrip();
                } catch (e) { toast(e.message, 'error'); saveBtn.disabled = false; }
            } }, Icon(ed ? 'Check' : 'Megaphone', { size: 14 }), ' ', ed ? tr('Сохранить') : tr('Опубликовать'));
        const cancelBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: close }, tr('Отмена'));

        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        overlay.appendChild(h('div', { class: 'modal-card cn-modal', role: 'dialog', 'aria-modal': 'true' },
            h('div', { class: 'modal-head' },
                h('h2', null, Icon(ed ? 'Edit' : 'Megaphone', { size: 16 }), ' ', ed ? tr('Изменить объявление') : tr('Новое объявление')),
                h('button', { class: 'modal-close', type: 'button', 'aria-label': tr('Закрыть'), onclick: close })),
            h('div', { class: 'modal-body cn-form-body' },
                h('div', { class: 'cn-form-row' },
                    h('div', { class: 'cn-f-kind' }, field(tr('Вид'), kindSel)),
                    h('div', { class: 'cn-f-title' }, field(tr('Заголовок'), title))),
                field(tr('Текст'), body),
                h('div', { class: 'cn-form-row' },
                    h('div', { class: 'cn-f-until' }, field(tr('Показывать до (необязательно)'), until)),
                    importantBtn,
                    checkField(tr('Закрепить сверху'), pinned))),
            h('div', { class: 'modal-foot' }, cancelBtn, saveBtn)));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey);
        setTimeout(() => title.focus(), 0);
    }

    // ---- фильтры ----
    function paintBar() {
        clear(barHost);
        const chip = (id, label, icon, count) => h('button', {
            type: 'button', class: 'cn-chip' + (state.kind === id ? ' on' : ''), 'data-cn-filter': id,
            onclick: () => { state.kind = id; paintBar(); paintList(); },
        }, icon ? Icon(icon, { size: 13 }) : null, h('span', null, tr(label)), count != null ? h('b', null, String(count)) : null);
        const count = (id) => state.items.filter((n) => id === 'all' || n.kind === id).length;
        barHost.appendChild(h('div', { class: 'cn-bar' },
            h('div', { class: 'cn-chips' },
                chip('all', 'Все', null, count('all')),
                ...KINDS.map((k) => chip(k.id, k.label, k.icon, count(k.id)))),
            h('div', { class: 'segmented' },
                h('button', { class: 'segmented-btn' + (!state.archive ? ' on' : ''), type: 'button', onclick: () => { if (state.archive) { state.archive = false; load(); } } }, tr('На доске')),
                h('button', { class: 'segmented-btn' + (state.archive ? ' on' : ''), type: 'button', 'data-cn-archive': '', onclick: () => { if (!state.archive) { state.archive = true; load(); } } }, tr('Архив')))));
    }

    // ---- список ----
    function paintList() {
        clear(listHost);
        if (state.error) { listHost.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, state.error)); return; }
        const items = state.items.filter((n) => state.kind === 'all' || n.kind === state.kind);
        if (!items.length) {
            listHost.appendChild(h('div', { class: 'card empty cn-empty' },
                Icon('Megaphone', { size: 26 }),
                h('div', null, state.archive ? tr('В архиве пусто.') : tr('На доске пока нет объявлений.')),
                !state.archive && isAdmin ? h('div', { class: 'muted' }, tr('Напишите первое в форме выше — его увидят все сотрудники.')) : null));
            return;
        }
        listHost.appendChild(h('div', { class: 'cn-list' }, ...items.map(newsCard)));
    }

    function newsCard(n) {
        const k = kindOf(n.kind);
        const meta = [n.author, dmy(n.created_at)].filter(Boolean).join(' · ');
        const actions = isAdmin && !state.archive ? h('div', { class: 'cn-actions' },
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-cn-edit': n.id,
                onclick: () => openForm(n) },   // CLINIC_NEWS_MODAL_V1 — то же окно, заполненное
                Icon('Edit', { size: 13 }), ' ', tr('Изменить')),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-cn-remove': n.id,
                onclick: async () => {
                    if (!window.confirm(tr('Снять объявление с доски? Оно останется в архиве.'))) return;
                    try { await rpc('clinic_news_archive', { id: n.id }); toast(tr('Объявление снято с доски.'), 'success'); await load(); refreshStrip(); }
                    catch (e) { toast(e.message, 'error'); }
                } }, Icon('Trash', { size: 13 }), ' ', tr('Снять'))) : null;
        return h('article', { class: 'card cn-card cn-kind-' + n.kind + (n.pinned && !state.archive ? ' is-pinned' : '') + (n.important ? ' is-important' : ''), 'data-cn-item': n.id },
            h('span', { class: 'cn-ico' }, Icon(k.icon, { size: 18 })),
            h('div', { class: 'cn-main' },
                h('div', { class: 'cn-top' },
                    n.important ? h('span', { class: 'cn-imp' }, Icon('Warning', { size: 12 }), tr('Важно')) : null,   // CLINIC_NEWS_IMPORTANT_V1
                    Tag(tr(k.label), { kind: k.tone }),
                    n.pinned && !state.archive ? h('span', { class: 'cn-pin' }, tr('Закреплено')) : null,
                    n.show_until ? h('span', { class: 'cn-until muted' }, trf('до {date}', { date: dmy(n.show_until) })) : null),
                h('h4', { class: 'cn-title' }, n.title),
                n.body ? h('div', { class: 'cn-body' }, n.body) : null,
                h('div', { class: 'cn-meta muted' }, meta)),
            actions);
    }

    await load();
}
