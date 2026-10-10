// SERVICES_PACKAGES_V1 — «УСЛУГИ ДЛЯ САЙТА И ПАРТНЁРОВ» (Настройки → Настройки
// услуг; шаг 6 API клиники; макет screen-services.js): какие услуги и цены видят
// пациенты на сайте клиники, в Symptex и у партнёров — по пяти группам прайса.
//
//   • вкладки пяти групп с числами (у «Консультаций» — число врачей);
//   • «Консультации» — врачи: консультации с ценами по общему правилу
//     (shared/consultation-price.js), их услуги-консультации из прайса и показ
//     врача (переключатель — в карточке врача); ниже — услуги прайса группы
//     «Консультации» с теми, кто их оказывает (решение владельца 12) и
//     предупреждением «нет врача»;
//   • остальные группы — услуги: названия RU / UZ / EN, цена, переключатель
//     показа (прежний флаг online_booking; без названия на узбекском —
//     «Нужно название на узбекском» вместо переключателя); «Показать всю группу».
//
// Данные — RPC services_public_overview (тем же правилом, что отдаст API в шаге
// 8); показ — services_set_online (только администратор, в филиале — нет).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag } from '../ui.js';
import { tr, trf, getLang } from '../i18n.js';
import { specialtyLabel } from '../specialties.js?v=spec2';
import { SERVICE_PUBLIC_MESSAGES, bulkShowPlan } from '../../shared/service-public.js';

const fmt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const pickName = (names) => {
    const n = names || {};
    const l = getLang();
    return String((l !== 'ru' && n[l]) || n.ru || '').trim();
};

/** Цена консультации на экране: «Бесплатно» — своя строка с 0; пустая — «0 сум · цена не введена» (решение 13). */
export function consultPriceText(c) {
    if (c && c.empty) return trf('{sum} сум', { sum: '0' }) + ' · ' + tr('цена не введена');
    if (c && c.own && Number(c.price) === 0) return tr('Бесплатно');
    return trf('{sum} сум', { sum: fmt(c && c.price) });
}

/** Подпись показа врача: [метка, вид, пояснение] — как «Сотрудники» (шаг 5). */
export function doctorStateText(state) {
    if (state === 'shown') return ['На сайте', 'ok', ''];
    if (state === 'branch_hidden') return ['Скрыт с сайта', '', 'филиал скрыт с сайта'];
    return ['Скрыт с сайта', '', 'врач скрыт в своей карточке'];
}

export async function renderServicesPublic(container, { onBack = null, onOpenConsultTypes = null } = {}) {
    let data = null;
    let group = 'consultation';
    let busy = false;

    async function load() {
        const { data: d, error } = await supabase.rpc('services_public_overview', {});
        if (error) throw error;
        data = d;
    }

    function switchFor(s) {
        if (s.state === 'no_uz') return h('span', { class: 'svp-miss' }, SERVICE_PUBLIC_MESSAGES.needUz);
        const sw = h('button', { type: 'button', class: 'dpp-switch', role: 'switch', 'aria-checked': String(!!s.online),
            'aria-label': 'Показывать услугу', disabled: !data.can_edit || busy,
            onclick: () => setOnline([s.id], !s.online) });
        return h('div', { class: 'svp-row' }, sw, h('span', { class: 'svp-small' }, s.online ? 'На сайте' : 'Скрыта с сайта'));
    }
    function chips(name) {
        return h('span', { class: 'pkg-chips' }, ...['ru', 'uz', 'en'].map((l) => {
            const on = !!String((name && name[l]) || '').trim();
            return h('span', { class: 'pkg-chip' + (on ? ' on' : ''), title: on ? 'Есть перевод' : 'Нет перевода' }, document.createTextNode(l.toUpperCase()));
        }));
    }
    function serviceCell(s) {
        return h('td', null, h('div', { class: 'pkg-name' }, document.createTextNode(s.name.ru || '—')),
            h('span', { class: 'muted svp-sub' }, document.createTextNode((s.name.uz || '—') + ' · ' + (s.name.en || '—'))));
    }
    function servicesTable(list, { performers = false } = {}) {
        const tb = h('tbody');
        for (const s of list) {
            const cells = [serviceCell(s), h('td', null, chips(s.name)), h('td', { class: 'num pkg-r' }, document.createTextNode(fmt(s.price)))];
            if (performers) {
                const names = (s.performers || []).map((p) => p.name).filter(Boolean);
                cells.push(h('td', null,
                    names.length ? h('span', null, document.createTextNode(names.join(', '))) : null,
                    s.warning ? h('div', { class: 'svp-miss' }, SERVICE_PUBLIC_MESSAGES[s.warning]) : null));
            }
            cells.push(h('td', null, switchFor(s)));
            tb.appendChild(h('tr', { 'data-service-id': String(s.id) }, ...cells));
        }
        const head = [h('th', null, 'Услуга'), h('th', null, 'Языки названия'), h('th', { class: 'pkg-r' }, 'Цена')];
        if (performers) head.push(h('th', null, 'Кто оказывает'));
        head.push(h('th', null, 'Сайт и партнёры'));
        return h('div', { class: 'pkg-scroll' }, h('table', { class: 'tbl pkg-tbl' }, h('thead', null, h('tr', null, ...head)), tb));
    }
    function doctorsTable() {
        const tb = h('tbody');
        for (const d of data.doctors) {
            const [label, kind, why] = doctorStateText(d.state);
            const consult = d.consultations.map((c) => h('div', { class: 'svp-price-row' },
                h('span', null, document.createTextNode(pickName(c.name) || '—')), h('b', { class: 'num' }, document.createTextNode(consultPriceText(c)))));
            const fromPrice = (d.services || []).map((s) => h('div', { class: 'svp-price-row' },
                h('span', null, document.createTextNode(pickName(s.name) || '—'), ' ', Tag(s.online ? 'На сайте' : 'Не показывается', { kind: s.online ? 'ok' : '' })),
                h('b', { class: 'num' }, document.createTextNode(trf('{sum} сум', { sum: fmt(s.price) })))));
            tb.appendChild(h('tr', { 'data-doctor-id': String(d.id) },
                h('td', null, h('div', { class: 'pkg-name' }, document.createTextNode(d.name || '—')),
                    h('span', { class: 'muted svp-sub' }, document.createTextNode(specialtyLabel({ slug: d.specialty_slug, name: d.specialty }) || '—'), ' · ',
                        d.mode === 'live_queue' ? 'живая очередь' : 'по записи')),
                h('td', null, ...consult, fromPrice.length ? h('div', { class: 'muted svp-from' }, 'Из прайса') : null, ...fromPrice,
                    !consult.length && !fromPrice.length ? h('span', { class: 'muted' }, 'Не ведёт консультаций') : null),
                h('td', null, Tag(label, { kind, dot: true }), why ? h('div', { class: 'muted pkg-why' }, why) : null)));
        }
        return h('div', { class: 'pkg-scroll' }, h('table', { class: 'tbl pkg-tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Врач'), h('th', null, 'Консультации и цены'), h('th', null, 'Сайт и партнёры'))), tb));
    }

    async function setOnline(ids, on) {
        if (busy || !data.can_edit) return;
        busy = true;
        const { data: r, error } = await supabase.rpc('services_set_online', { ids, on });
        busy = false;
        if (error) { toast(tr(error.message || 'Не удалось сохранить.'), 'fail'); paint(); return null; }
        try { await load(); } catch (_) { /* оставим прежнее */ }
        paint();
        return r;
    }
    async function showGroup() {
        const plan = bulkShowPlan(data.services.map((s) => ({ id: s.id, type: s.group, name: s.name.ru, name_uz: s.name.uz,
            online_booking: s.online ? 1 : 0, active: 1 })), group);
        if (!plan.on.length && !plan.skipped.length) { toast(tr('Вся группа видна пациентам'), 'ok'); return; }
        const r = plan.on.length ? await setOnline(plan.on, true) : { skipped: [] };
        if (!r) return;
        const skipped = plan.skipped.length;
        toast(skipped ? trf('Показали группу. Без узбекского названия пропущено: {n}.', { n: skipped }) : tr('Вся группа видна пациентам'), skipped ? 'warn' : 'ok');
    }

    const root = h('div', { class: 'fade-in svp-page' });
    function paint() {
        clear(root);
        root.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginBottom: '14px' },
            onclick: () => { if (typeof onBack === 'function') onBack(); } }, Icon('ChevronLeft', { size: 14 }), ' ', 'К плиткам настроек'));
        root.appendChild(h('div', { class: 'page-head' }, h('div', null,
            h('h1', { class: 'page-title' }, 'Услуги для сайта и партнёров'),
            h('p', { class: 'page-subtitle' }, 'Какие услуги и цены видят пациенты на сайте клиники, в Symptex и у партнёров. Группы те же пять, что в прейскуранте.'))));
        if (!data) { root.appendChild(h('div', { class: 'empty', role: 'alert' }, 'Не удалось загрузить услуги — обновите страницу.')); return; }
        if (data.secondary) root.appendChild(h('p', { class: 'cpf-note', role: 'note' }, Icon('Building', { size: 16 }), h('span', null, SERVICE_PUBLIC_MESSAGES.mainOnly)));
        else if (!data.can_edit) root.appendChild(h('p', { class: 'cpf-note', role: 'note' }, Icon('Lock', { size: 16 }), h('span', null, SERVICE_PUBLIC_MESSAGES.adminOnly)));
        const f = data.facts;
        root.appendChild(h('dl', { class: 'svp-facts' },
            h('div', null, h('dt', null, 'Показываем услуг'), h('dd', { class: 'num' }, trf('{n} из {total}', { n: f.services_shown, total: f.services_total }))),
            h('div', null, h('dt', null, 'Врачей с ценами консультаций'), h('dd', { class: 'num' }, trf('{n} из {total}', { n: f.doctors_shown, total: f.doctors_total }))),
            h('div', null, h('dt', null, 'Без перевода на английский'), h('dd', null, trf('{n} — партнёры покажут русское название', { n: f.no_en })))));
        const tabs = data.groups.map((g) => h('button', { type: 'button', class: 'svp-tab' + (g.key === group ? ' on' : ''), role: 'tab',
            'aria-selected': String(g.key === group), 'data-group': g.key, onclick: () => { group = g.key; paint(); } },
            g.label, ' ', h('span', { class: 'muted num' }, document.createTextNode(String(g.count)))));
        const bulk = group !== 'consultation' && data.can_edit
            ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => showGroup() }, 'Показать всю группу') : null;
        const body = [];
        if (group === 'consultation') {
            body.push(data.doctors.length ? doctorsTable() : h('p', { class: 'muted pkg-empty' }, 'Врачей пока нет.'));
            body.push(h('div', { class: 'svp-foot' },
                h('p', { class: 'cpf-note', role: 'note' }, Icon('Info', { size: 16 }), h('span', null, 'Цену и название консультации для каждого врача задают в «Консультации врачей». Консультация видна, если виден сам врач.')),
                typeof onOpenConsultTypes === 'function'
                    ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => onOpenConsultTypes() }, Icon('Edit', { size: 14 }), ' ', 'Открыть «Консультации врачей»')
                    : null));
            const own = data.services.filter((s) => s.group === 'consultation');
            body.push(h('h4', { class: 'svp-h4' }, 'Услуги прайса в группе «Консультации»'));
            body.push(h('p', { class: 'muted svp-sub' }, 'Партнёры видят такую услугу в профиле врача, который её оказывает (вкладка «Услуги и ставки» в карточке услуги).'));
            body.push(own.length ? servicesTable(own, { performers: true }) : h('p', { class: 'muted pkg-empty' }, 'Таких услуг в прайсе нет.'));
        } else {
            const list = data.services.filter((s) => s.group === group);
            body.push(list.length ? servicesTable(list) : h('p', { class: 'muted pkg-empty' }, 'В этой группе услуг нет.'));
        }
        root.appendChild(h('section', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Layers', { size: 18 }), ' ', 'Услуги по группам'), bulk),
            h('div', { class: 'svp-tabs', role: 'tablist' }, ...tabs),
            ...body));
    }

    clear(container);
    container.appendChild(root);
    root.appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
    try { await load(); } catch (e) { data = null; toast(tr((e && e.message) || 'Не удалось загрузить услуги — обновите страницу.'), 'fail'); }
    paint();
    return { reload: async () => { await load(); paint(); } };
}
