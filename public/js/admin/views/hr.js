// HR_DEPT_V1 (2026-11-26, владелец: «create a HR section in here, then I will
// explain what to create next») — раздел «HR» в верхней полосе, между
// «Закупками» и «Настройками».
//
// HR_STAFF_V1 (2026-11-26) — первое наполнение раздела. Владелец: «list of
// workers with the filter based on what position, doctor, administrative or
// middle low, and based on what field, when hired, if hired documents
// uploading place for each staff, and place to assign using materials like
// laptop or phone or so on».
//
//  - СПИСОК сотрудников: категория чипами (Врачи · Административный персонал ·
//    Средний и младший персонал), отдел, специальность, должность, дата приёма
//    «с — по», поиск по ФИО и телефону, «показать уволенных».
//  - КАРТОЧКА сотрудника (окно по щелчку строки): вкладка «Документы» —
//    загрузка сканов (паспорт, диплом, договор…), вкладка «Техника» — что
//    выдано (ноутбук, телефон…) и отметка возврата.
//
// Анкету (категорию, должность, отдел, дату приёма) здесь НЕ правят: она
// живёт в «Сотрудниках», и вторая форма правки тех же колонок разошлась бы с
// первой. Сервер — rpc/hr.js, корзина файлов — `hr-docs` (routes/storage.js),
// таблицы — миграция 302. Раздел открыт только администратору.
import { h, Icon, PageHead, clear, toast, field, fmtDate } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { uploadFile, signedUrl } from '../storage.js';

const BUCKET = 'hr-docs';

const CATEGORIES = [
    { id: 'doctor',      label: 'Врачи' },
    { id: 'admin_staff', label: 'Административный персонал' },
    { id: 'mid_low',     label: 'Средний и младший персонал' },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

const DOC_KINDS = [
    { id: 'passport',    label: 'Паспорт' },
    { id: 'diploma',     label: 'Диплом' },
    { id: 'contract',    label: 'Трудовой договор' },
    { id: 'certificate', label: 'Сертификат' },
    { id: 'medical',     label: 'Медицинская книжка' },
    { id: 'order',       label: 'Приказ' },
    { id: 'other',       label: 'Другое' },
];
const DOC_LABEL = Object.fromEntries(DOC_KINDS.map((k) => [k.id, k.label]));

const ASSET_KINDS = [
    { id: 'laptop',  label: 'Ноутбук' },
    { id: 'desktop', label: 'Компьютер' },
    { id: 'phone',   label: 'Телефон' },
    { id: 'tablet',  label: 'Планшет' },
    { id: 'monitor', label: 'Монитор' },
    { id: 'sim',     label: 'SIM-карта' },
    { id: 'uniform', label: 'Форма' },
    { id: 'key',     label: 'Ключ / пропуск' },
    { id: 'other',   label: 'Другое' },
];
const ASSET_LABEL = Object.fromEntries(ASSET_KINDS.map((k) => [k.id, k.label]));

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || tr('Не удалось выполнить запрос.'));
    return data;
}

const dateOnly = (v) => (v ? String(v).slice(0, 10) : '');
const showDate = (v) => (v ? fmtDate(dateOnly(v)) : '—');

// HR_RECRUIT_V1 — пункт меню зовётся «Сотрудники»; воронка найма — свой пункт
// «Подбор персонала» (views/hr-recruiting.js), а не вкладка этого экрана.
export async function renderHr(container) {
    clear(container);
    const page = h('div', { class: 'fade-in hr-page', 'data-hr': '' });
    container.appendChild(page);
    page.appendChild(PageHead({
        title: tr('Сотрудники'),
        subtitle: tr('Сотрудники клиники: категория, отдел, дата приёма, документы и выданная техника.'),
    }));
    const body = h('div');
    page.appendChild(body);
    await renderStaffTab(body);
}

async function renderStaffTab(container) {
    clear(container);
    const state = {
        category: '', department_id: '', specialty: '', position: '',
        hired_from: '', hired_to: '', q: '', inactive: false,
        items: [], options: { departments: [], specialties: [], positions: [] }, error: null, loading: true,
    };
    const root = h('div', { 'data-hr-staff': '' });
    container.appendChild(root);
    const chipsHost = h('div');
    const filtersHost = h('div');
    const listHost = h('div');
    root.append(chipsHost, filtersHost, listHost);

    // Категория фильтруется на экране, остальное — сервером: так у чипов
    // честные числа «сколько таких среди отобранных остальными фильтрами».
    async function load() {
        state.loading = true; paintList();
        try {
            const res = await rpc('hr_staff_list', {
                department_id: state.department_id || null, specialty: state.specialty || null,
                position: state.position || null, hired_from: state.hired_from || null,
                hired_to: state.hired_to || null, q: state.q || null, inactive: state.inactive,
            });
            state.items = res.items || [];
            state.options = res.options || state.options;
            state.error = null;
        } catch (e) { state.error = e.message; state.items = []; }
        state.loading = false;
        paintChips(); paintFilters(); paintList();
    }

    function visible() {
        if (!state.category) return state.items;
        if (state.category === 'none') return state.items.filter((u) => !u.category);
        return state.items.filter((u) => u.category === state.category);
    }

    function paintChips() {
        clear(chipsHost);
        const count = (id) => (id === '' ? state.items.length
            : id === 'none' ? state.items.filter((u) => !u.category).length
                : state.items.filter((u) => u.category === id).length);
        const chip = (id, label) => h('button', {
            type: 'button', class: 'cn-chip' + (state.category === id ? ' on' : ''), 'data-hr-cat': id || 'all',
            onclick: () => { state.category = id; paintChips(); paintList(); },
        }, h('span', null, tr(label)), h('b', null, String(count(id))));
        const none = count('none');
        chipsHost.appendChild(h('div', { class: 'cn-chips hr-chips' },
            chip('', 'Все'),
            ...CATEGORIES.map((c) => chip(c.id, c.label)),
            none ? chip('none', 'Категория не указана') : null));
    }

    function paintFilters() {
        clear(filtersHost);
        const select = (key, placeholder, opts) => {
            const s = h('select', { 'data-hr-f': key, onchange: () => { state[key] = s.value; load(); } },
                h('option', { value: '' }, tr(placeholder)),
                ...opts.map((o) => h('option', { value: String(o.v), selected: String(state[key]) === String(o.v) }, o.t)));
            return s;
        };
        const search = h('input', { type: 'search', 'data-hr-f': 'q', placeholder: tr('ФИО или телефон'), value: state.q });
        let timer = null;
        search.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => { state.q = search.value.trim(); load(); }, 300);
        });
        const date = (key) => h('input', { type: 'date', 'data-hr-f': key, value: state[key],
            onchange: (e) => { state[key] = e.target.value; load(); } });
        const inactive = h('input', { type: 'checkbox', checked: state.inactive, 'data-hr-f': 'inactive',
            onchange: (e) => { state.inactive = e.target.checked; load(); } });
        const any = state.department_id || state.specialty || state.position || state.hired_from || state.hired_to || state.q || state.inactive;
        const o = state.options;
        filtersHost.appendChild(h('div', { class: 'card card-pad-sm hr-filters' },
            h('div', { class: 'hr-f hr-f-q' }, field(tr('Поиск'), search)),
            h('div', { class: 'hr-f' }, field(tr('Отдел'), select('department_id', 'Все отделы', o.departments.map((d) => ({ v: d.id, t: d.name })))) ),
            h('div', { class: 'hr-f' }, field(tr('Специальность'), select('specialty', 'Все специальности', o.specialties.map((v) => ({ v, t: v }))))),
            o.positions.length ? h('div', { class: 'hr-f' }, field(tr('Должность'), select('position', 'Все должности', o.positions.map((v) => ({ v, t: v }))))) : null,
            h('div', { class: 'hr-f hr-f-date' }, field(tr('Принят с'), date('hired_from'))),
            h('div', { class: 'hr-f hr-f-date' }, field(tr('Принят по'), date('hired_to'))),
            h('label', { class: 'hr-f-check' }, inactive, ' ', tr('Показать уволенных')),
            any ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-hr-reset': '',
                onclick: () => {
                    Object.assign(state, { department_id: '', specialty: '', position: '', hired_from: '', hired_to: '', q: '', inactive: false });
                    load();
                } }, tr('Сбросить')) : null));
    }

    function paintList() {
        clear(listHost);
        if (state.loading && !state.items.length) { listHost.appendChild(h('div', { class: 'card empty' }, tr('Загрузка…'))); return; }
        if (state.error) { listHost.appendChild(h('div', { class: 'card error-state' }, state.error)); return; }
        const rows = visible();
        if (!rows.length) { listHost.appendChild(h('div', { class: 'card empty', 'data-hr-empty': '' }, tr('Сотрудников по этим условиям нет.'))); return; }
        listHost.appendChild(h('div', { class: 'card hr-table-wrap' }, h('table', { class: 'tbl hr-table' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Сотрудник')), h('th', null, tr('Категория')), h('th', null, tr('Должность / специальность')),
                h('th', null, tr('Отдел')), h('th', null, tr('Принят')), h('th', { class: 'num' }, tr('Документы')), h('th', { class: 'num' }, tr('Техника')))),
            h('tbody', null, ...rows.map((u) => h('tr', {
                class: 'hr-row' + (u.is_active ? '' : ' is-inactive'), 'data-hr-row': String(u.id), tabindex: '0',
                onclick: () => openCard(u.id),
                onkeydown: (e) => { if (e.key === 'Enter') openCard(u.id); },
            },
                h('td', null, h('div', { class: 'hr-name' }, u.full_name || '—'),
                    h('div', { class: 'hr-sub' }, u.phone || '', u.is_active ? null : h('span', { class: 'hr-fired' }, ' · ', tr('уволен')))),
                h('td', null, u.category ? tr(CATEGORY_LABEL[u.category]) : h('span', { class: 'hr-muted' }, '—')),
                h('td', null, [u.position, u.specialty].filter(Boolean).join(' · ') || h('span', { class: 'hr-muted' }, '—')),
                h('td', null, u.department || h('span', { class: 'hr-muted' }, '—')),
                h('td', null, showDate(u.hire_date)),
                h('td', { class: 'num' }, u.documents ? String(u.documents) : h('span', { class: 'hr-muted' }, '0')),
                h('td', { class: 'num' }, u.assets ? String(u.assets) : h('span', { class: 'hr-muted' }, '0')))))),
        ));
    }

    // ---- карточка сотрудника ----
    async function openCard(userId) {
        document.querySelector('[data-hr-modal]')?.remove();
        const overlay = h('div', { class: 'modal', 'data-hr-modal': '' });
        const onKey = (ev) => { if (ev.key === 'Escape') close(); };
        let dirty = false;   // что-то изменили — список перечитается при закрытии (числа в строке)
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); if (dirty) load(); };
        const head = h('h2');
        const bodyHost = h('div', { class: 'modal-body hr-card-body' }, tr('Загрузка…'));
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        overlay.appendChild(h('div', { class: 'modal-card hr-modal', role: 'dialog', 'aria-modal': 'true' },
            h('div', { class: 'modal-head' }, head,
                h('button', { class: 'modal-close', type: 'button', 'aria-label': tr('Закрыть'), onclick: close })),
            bodyHost));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey);

        let tab = 'documents';
        let card = null;
        async function reload() {
            try { card = await rpc('hr_staff_card', { user_id: userId }); }
            catch (e) { clear(bodyHost); bodyHost.appendChild(h('div', { class: 'error-state' }, e.message)); return; }
            paint();
        }
        function paint() {
            const s = card.staff;
            clear(head);
            head.append(Icon('ID', { size: 16 }), ' ', s.full_name || '—');
            clear(bodyHost);
            const facts = [
                s.category ? tr(CATEGORY_LABEL[s.category]) : null,
                s.position || null, s.specialty || null, s.department || null,
                s.hire_date ? trf('принят {date}', { date: showDate(s.hire_date) }) : null,
                s.is_active ? null : tr('уволен'),
            ].filter(Boolean);
            bodyHost.appendChild(h('div', { class: 'hr-facts' }, facts.join(' · ') || '—'));
            const tabBtn = (id, label, n) => h('button', {
                type: 'button', class: tab === id ? 'on' : '', 'data-hr-tab': id,
                onclick: () => { tab = id; paint(); },
            }, tr(label), n ? ' ' + n : '');
            const activeAssets = card.assets.filter((a) => !a.returned_on).length;
            bodyHost.appendChild(h('div', { class: 'segmented hr-tabs' },
                tabBtn('documents', 'Документы', card.documents.length),
                tabBtn('assets', 'Техника', activeAssets)));
            bodyHost.appendChild(tab === 'documents' ? documentsPane() : assetsPane());
        }

        function documentsPane() {
            const pane = h('div', { class: 'hr-pane', 'data-hr-pane': 'documents' });
            const kind = h('select', { 'data-hr-doc-kind': '' }, ...DOC_KINDS.map((k) => h('option', { value: k.id }, tr(k.label))));
            const title = h('input', { type: 'text', maxlength: '200', 'data-hr-doc-title': '', placeholder: tr('Например: Паспорт, страницы 1–2') });
            kind.addEventListener('change', () => { if (!title.value.trim() || title.dataset.auto) { title.value = tr(DOC_LABEL[kind.value]); title.dataset.auto = '1'; } });
            title.addEventListener('input', () => { delete title.dataset.auto; });
            const until = h('input', { type: 'date', 'data-hr-doc-until': '' });
            const file = h('input', { type: 'file', 'data-hr-doc-file': '' });
            const add = h('button', { type: 'button', class: 'btn btn-primary', 'data-hr-doc-add': '',
                onclick: async () => {
                    const f = file.files && file.files[0];
                    if (!f) { toast(tr('Выберите файл.'), 'warn'); return; }
                    const name = title.value.trim() || tr(DOC_LABEL[kind.value]);
                    add.disabled = true;
                    try {
                        const up = await uploadFile(BUCKET, f, `staff/${userId}/`);
                        await rpc('hr_document_add', { user_id: userId, kind: kind.value, title: name, file_path: up.path,
                            file_name: up.name, file_size: up.size, valid_until: until.value || null });
                        toast(tr('Документ приложен.'), 'success');
                        dirty = true; await reload();
                    } catch (e) { toast(e.message || String(e), 'error'); add.disabled = false; }
                } }, Icon('Paperclip', { size: 14 }), ' ', tr('Загрузить'));
            pane.appendChild(h('div', { class: 'hr-form' },
                h('div', { class: 'hr-f' }, field(tr('Вид документа'), kind)),
                h('div', { class: 'hr-f hr-f-wide' }, field(tr('Название'), title)),
                h('div', { class: 'hr-f hr-f-date' }, field(tr('Действует до (необязательно)'), until)),
                h('div', { class: 'hr-f hr-f-wide' }, field(tr('Файл'), file)),
                h('div', { class: 'hr-f hr-f-btn' }, add)));
            if (!card.documents.length) {
                pane.appendChild(h('div', { class: 'empty hr-empty-sm' }, tr('Документов пока нет.')));
                return pane;
            }
            const expired = (d) => d.valid_until && d.valid_until < card.today;
            pane.appendChild(h('table', { class: 'tbl hr-sub-table' },
                h('thead', null, h('tr', null, h('th', null, tr('Документ')), h('th', null, tr('Вид')), h('th', null, tr('Действует до')),
                    h('th', null, tr('Загружен')), h('th', null, ''))),
                h('tbody', null, ...card.documents.map((d) => h('tr', { 'data-hr-doc': String(d.id) },
                    h('td', null, h('button', { type: 'button', class: 'hr-link', title: d.file_name || '',
                        onclick: async () => {
                            const url = await signedUrl(BUCKET, d.file_path);
                            if (url) window.open(url, '_blank', 'noopener'); else toast(tr('Файл не открылся.'), 'error');
                        } }, Icon('Doc', { size: 14 }), ' ', d.title)),
                    h('td', null, tr(DOC_LABEL[d.kind] || d.kind)),
                    h('td', { class: expired(d) ? 'hr-expired' : '' }, d.valid_until ? showDate(d.valid_until) : '—', expired(d) ? ' · ' + tr('истёк') : ''),
                    h('td', null, showDate(d.uploaded_at), d.uploaded_by_name ? h('div', { class: 'hr-sub' }, d.uploaded_by_name) : null),
                    h('td', { class: 'num' }, h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-hr-doc-remove': String(d.id),
                        onclick: async () => {
                            if (!window.confirm(trf('Убрать документ «{title}» из карточки?', { title: d.title }))) return;
                            try { await rpc('hr_document_remove', { id: d.id }); dirty = true; await reload(); }
                            catch (e) { toast(e.message, 'error'); }
                        } }, tr('Убрать'))))))));
            return pane;
        }

        function assetsPane() {
            const pane = h('div', { class: 'hr-pane', 'data-hr-pane': 'assets' });
            const kind = h('select', { 'data-hr-asset-kind': '' }, ...ASSET_KINDS.map((k) => h('option', { value: k.id }, tr(k.label))));
            const name = h('input', { type: 'text', maxlength: '200', 'data-hr-asset-name': '', placeholder: tr('Модель, например: Lenovo ThinkPad T14') });
            const serial = h('input', { type: 'text', maxlength: '100', 'data-hr-asset-serial': '' });
            const inv = h('input', { type: 'text', maxlength: '100', 'data-hr-asset-inv': '' });
            const on = h('input', { type: 'date', 'data-hr-asset-on': '', value: card.today || '' });
            const note = h('input', { type: 'text', maxlength: '1000', 'data-hr-asset-note': '', placeholder: tr('Комплектация, состояние…') });
            const issue = h('button', { type: 'button', class: 'btn btn-primary', 'data-hr-asset-issue': '',
                onclick: async () => {
                    if (!name.value.trim()) { toast(tr('Напишите, что выдано: модель или название.'), 'warn'); name.focus(); return; }
                    issue.disabled = true;
                    try {
                        await rpc('hr_asset_issue', { user_id: userId, kind: kind.value, name: name.value, serial_no: serial.value,
                            inventory_no: inv.value, issued_on: on.value || null, note: note.value });
                        toast(tr('Выдача записана.'), 'success');
                        dirty = true; await reload();
                    } catch (e) { toast(e.message, 'error'); issue.disabled = false; }
                } }, Icon('Plus', { size: 14 }), ' ', tr('Выдать'));
            pane.appendChild(h('div', { class: 'hr-form' },
                h('div', { class: 'hr-f' }, field(tr('Что'), kind)),
                h('div', { class: 'hr-f hr-f-wide' }, field(tr('Название'), name)),
                h('div', { class: 'hr-f' }, field(tr('Серийный номер'), serial)),
                h('div', { class: 'hr-f' }, field(tr('Инвентарный номер'), inv)),
                h('div', { class: 'hr-f hr-f-date' }, field(tr('Дата выдачи'), on)),
                h('div', { class: 'hr-f hr-f-wide' }, field(tr('Примечание'), note)),
                h('div', { class: 'hr-f hr-f-btn' }, issue)));
            if (!card.assets.length) {
                pane.appendChild(h('div', { class: 'empty hr-empty-sm' }, tr('Техника не выдавалась.')));
                return pane;
            }
            pane.appendChild(h('table', { class: 'tbl hr-sub-table' },
                h('thead', null, h('tr', null, h('th', null, tr('Что')), h('th', null, tr('Серийный / инвентарный №')),
                    h('th', null, tr('Выдано')), h('th', null, tr('Возвращено')), h('th', null, ''))),
                h('tbody', null, ...card.assets.map((a) => h('tr', { class: a.returned_on ? 'is-returned' : '', 'data-hr-asset': String(a.id) },
                    h('td', null, h('div', { class: 'hr-name' }, a.name), h('div', { class: 'hr-sub' }, tr(ASSET_LABEL[a.kind] || a.kind), a.note ? ' · ' + a.note : '')),
                    h('td', null, [a.serial_no, a.inventory_no].filter(Boolean).join(' / ') || '—'),
                    h('td', null, showDate(a.issued_on), a.issued_by_name ? h('div', { class: 'hr-sub' }, a.issued_by_name) : null),
                    h('td', null, a.returned_on ? showDate(a.returned_on) : h('span', { class: 'hr-onhand' }, tr('на руках')),
                        a.return_note ? h('div', { class: 'hr-sub' }, a.return_note) : null),
                    h('td', { class: 'num' }, a.returned_on ? null : h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-hr-asset-return': String(a.id),
                        onclick: async () => {
                            const comment = window.prompt(trf('Отметить возврат «{name}» сегодняшним днём? Можно оставить примечание о состоянии.', { name: a.name }), '');
                            if (comment === null) return;
                            try { await rpc('hr_asset_return', { id: a.id, return_note: comment }); dirty = true; await reload(); }
                            catch (e) { toast(e.message, 'error'); }
                        } }, tr('Возврат'))))))));
            return pane;
        }

        await reload();
    }

    await load();
}
