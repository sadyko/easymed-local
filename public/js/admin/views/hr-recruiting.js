// HR_RECRUIT_V1 (2026-11-27) — «HR → Подбор»: воронка найма для рекрутеров.
//
// Владелец: «build recruiting funnel for recruiters, and in hire status there
// should be button to create employee, which leads to setting place where we
// create employee».
//
//  - ВАКАНСИИ — полоса карточек над доской: «Медсестра · Кардиология — нанято
//    1 из 2, в работе 3». Щелчок по карточке — доска только этой вакансии.
//  - ДОСКА — колонки этапов: Отклик → Отбор → Собеседование → Оффер → Нанят,
//    и «Отказ» последней. Кандидата перетаскивают мышью или двигают кнопками
//    в его карточке. «Отказ» спрашивает причину (сервер без неё не примет).
//  - НАНЯТ → «Создать сотрудника»: переход в «Настройки → Сотрудники», где
//    открывается обычная анкета нового сотрудника с ФИО, телефоном, почтой,
//    категорией и отделом из кандидата и вакансии (employees.js, payload
//    { hire: id }). После её сохранения кандидат запоминает сотрудника, и
//    кнопка сменяется ссылкой «Сотрудник: …».
//
// Право — строка «Ролей» hr_recruiting (сервер: rpc/hr-recruiting.js); кнопки
// правки рисуются по can_edit из ответа доски, а не по догадке экрана.
import { h, Icon, PageHead, clear, toast, field, fmtDate, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { settingsTileLevel } from '../permissions.js';
import { uploadFile, signedUrl } from '../storage.js';   // HR_CANDIDATE_DOCS_V1

export const STAGES = [
    { id: 'new',       label: 'Отклик' },
    { id: 'screening', label: 'Отбор' },
    { id: 'interview', label: 'Собеседование' },
    { id: 'offer',     label: 'Оффер' },
    { id: 'hired',     label: 'Нанят' },
    { id: 'rejected',  label: 'Отказ' },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.id, s.label]));

const SOURCES = [
    { id: 'hh',       label: 'hh.uz' },
    { id: 'telegram', label: 'Telegram' },
    { id: 'referral', label: 'По рекомендации' },
    { id: 'site',     label: 'Сайт клиники' },
    { id: 'walk_in',  label: 'Пришёл сам' },
    { id: 'other',    label: 'Другое' },
];
const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));

const STAFF_TYPES = [
    { id: '',            label: 'Не указана' },
    { id: 'doctor',      label: 'Врачи' },
    { id: 'admin_staff', label: 'Административный персонал' },
    { id: 'mid_low',     label: 'Средний и младший персонал' },
];

// HR_CANDIDATE_DOCS_V1 — виды документов кандидата (сервер: CANDIDATE_DOC_KINDS).
const DOCS_BUCKET = 'hr-docs';
const CANDIDATE_DOC_KINDS = [
    { id: 'passport',       label: 'Паспорт' },
    { id: 'resume',         label: 'Резюме' },
    { id: 'diploma',        label: 'Диплом' },
    { id: 'certificate',    label: 'Сертификат' },
    { id: 'medical',        label: 'Медицинская книжка' },
    { id: 'recommendation', label: 'Рекомендация' },
    { id: 'other',          label: 'Другое' },
];
const DOC_KIND_LABEL = Object.fromEntries(CANDIDATE_DOC_KINDS.map((k) => [k.id, k.label]));

const VACANCY_STATUS = [
    { id: 'open',   label: 'Открыта' },
    { id: 'paused', label: 'На паузе' },
    { id: 'closed', label: 'Закрыта' },
];
const VACANCY_STATUS_LABEL = Object.fromEntries(VACANCY_STATUS.map((s) => [s.id, s.label]));

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || tr('Не удалось выполнить запрос.'));
    return data;
}

// Создавать сотрудника может тот, кому «Сотрудники» открыты на изменение:
// иначе кнопка вела бы в анкету, которую сервер не даст сохранить.
function canCreateEmployee() {
    const lvl = settingsTileLevel('settings.employees');
    return lvl === 'edit' || lvl === 'delete';
}

// «3 дн.» на этапе: сколько кандидат стоит в колонке — первое, что рекрутер
// замечает на доске (кому давно никто не звонил).
function daysSince(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/** Пункт меню «HR → Подбор персонала»: заголовок и доска. */
export async function renderRecruitingPage(container, ctx = {}) {
    clear(container);
    const page = h('div', { class: 'fade-in hr-page', 'data-hr-recruiting': '' });
    container.appendChild(page);
    page.appendChild(PageHead({
        title: tr('Подбор персонала'),
        subtitle: tr('Вакансии и кандидаты: от отклика до найма. Нанятого кандидата — сразу в сотрудники.'),
    }));
    const body = h('div');
    page.appendChild(body);
    await renderRecruiting(body, { onNavigate: ctx.onNavigate });
}

/**
 * Доска «Подбора». `onNavigate` — ctx.onNavigate оболочки: им «Создать
 * сотрудника» уходит в «Настройки → Сотрудники».
 */
export async function renderRecruiting(host, { onNavigate } = {}) {
    clear(host);
    const state = { vacancy: '', q: '', board: null, error: null, loading: true };
    const root = h('div', { class: 'hrr', 'data-hrr': '' });
    host.appendChild(root);
    const toolbarHost = h('div');
    const vacanciesHost = h('div');
    const boardHost = h('div');
    root.append(toolbarHost, vacanciesHost, boardHost);

    async function load() {
        state.loading = true;
        try {
            state.board = await rpc('hr_recruit_board', { vacancy_id: state.vacancy || null, q: state.q || null });
            state.error = null;
        } catch (e) { state.error = e.message; }
        state.loading = false;
        paintToolbar(); paintVacancies(); paintBoard();
    }

    function paintToolbar() {
        clear(toolbarHost);
        const b = state.board;
        const canEdit = !!(b && b.can_edit);
        const search = h('input', { type: 'search', placeholder: tr('ФИО или телефон'), value: state.q, 'data-hrr-q': '' });
        let timer = null;
        search.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => { state.q = search.value.trim(); load(); }, 300);
        });
        const vacancySelect = h('select', { 'data-hrr-vacancy': '', onchange: () => { state.vacancy = vacancySelect.value; load(); } },
            h('option', { value: '' }, tr('Все вакансии')),
            h('option', { value: 'none', selected: state.vacancy === 'none' }, tr('Резерв — без вакансии')),
            ...((b && b.vacancies) || []).map((v) => h('option', { value: String(v.id), selected: state.vacancy === String(v.id) },
                v.title + (v.status === 'open' ? '' : ' — ' + tr(VACANCY_STATUS_LABEL[v.status])))));
        toolbarHost.appendChild(h('div', { class: 'card card-pad-sm hrr-toolbar' },
            h('div', { class: 'hr-f hr-f-q' }, field(tr('Поиск'), search)),
            h('div', { class: 'hr-f' }, field(tr('Вакансия'), vacancySelect)),
            h('div', { class: 'hrr-toolbar-actions' },
                canEdit ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-hrr-new-vacancy': '', onclick: () => openVacancy(null) },
                    Icon('Plus', { size: 14 }), ' ', tr('Вакансия')) : null,
                canEdit ? h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-hrr-new-candidate': '', onclick: () => openCandidateForm(null) },
                    Icon('Plus', { size: 14 }), ' ', tr('Кандидат')) : null)));
    }

    function paintVacancies() {
        clear(vacanciesHost);
        const b = state.board;
        if (!b) return;
        const shown = b.vacancies.filter((v) => v.status !== 'closed' || state.vacancy === String(v.id));
        if (!shown.length && !b.unassigned) return;
        const pick = (id) => { state.vacancy = state.vacancy === id ? '' : id; load(); };
        vacanciesHost.appendChild(h('div', { class: 'hrr-vacancies', 'data-hrr-vacancies': '' },
            ...shown.map((v) => h('div', {
                class: 'hrr-vac' + (state.vacancy === String(v.id) ? ' on' : '') + (v.status !== 'open' ? ' is-' + v.status : ''),
                'data-hrr-vac': String(v.id), role: 'button', tabindex: '0',
                onclick: () => pick(String(v.id)),
                onkeydown: (e) => { if (e.key === 'Enter') pick(String(v.id)); },
            },
                h('div', { class: 'hrr-vac-head' },
                    h('div', { class: 'hrr-vac-title' }, v.title),
                    b.can_edit ? h('button', { type: 'button', class: 'hrr-icon-btn', 'aria-label': tr('Изменить вакансию'), title: tr('Изменить вакансию'),
                        onclick: (e) => { e.stopPropagation(); openVacancy(v); } }, Icon('Edit', { size: 14 })) : null),
                h('div', { class: 'hrr-vac-sub' }, [v.department, v.status === 'open' ? null : tr(VACANCY_STATUS_LABEL[v.status])].filter(Boolean).join(' · ') || ' '),
                h('div', { class: 'hrr-vac-nums' },
                    h('span', { class: v.hired >= v.headcount ? 'hrr-vac-full' : '' }, trf('нанято {n} из {total}', { n: v.hired, total: v.headcount })),
                    h('span', null, trf('в работе {n}', { n: v.active }))))),
            b.unassigned ? h('div', {
                class: 'hrr-vac hrr-vac-reserve' + (state.vacancy === 'none' ? ' on' : ''), 'data-hrr-vac': 'none', role: 'button', tabindex: '0',
                onclick: () => pick('none'), onkeydown: (e) => { if (e.key === 'Enter') pick('none'); },
            },
                h('div', { class: 'hrr-vac-title' }, tr('Резерв')),
                h('div', { class: 'hrr-vac-sub' }, tr('Кандидаты без вакансии')),
                h('div', { class: 'hrr-vac-nums' }, h('span', null, trf('всего {n}', { n: b.unassigned })))) : null));
    }

    function paintBoard() {
        clear(boardHost);
        if (state.loading && !state.board) { boardHost.appendChild(h('div', { class: 'card empty' }, tr('Загрузка…'))); return; }
        if (state.error) { boardHost.appendChild(h('div', { class: 'card error-state' }, state.error)); return; }
        const b = state.board;
        if (!b.candidates.length && !state.q && !state.vacancy) {
            boardHost.appendChild(h('div', { class: 'card empty', 'data-hrr-empty': '' },
                b.can_edit ? tr('Кандидатов пока нет. Заведите вакансию и добавьте первого кандидата.') : tr('Кандидатов пока нет.')));
            return;
        }
        const byStage = Object.fromEntries(STAGES.map((s) => [s.id, []]));
        for (const c of b.candidates) (byStage[c.stage] || byStage.new).push(c);
        boardHost.appendChild(h('div', { class: 'hrr-board', 'data-hrr-board': '' },
            ...STAGES.map((s) => column(s, byStage[s.id], b.can_edit))));
    }

    function column(stage, items, canEdit) {
        const col = h('div', { class: 'hrr-col hrr-col-' + stage.id, 'data-hrr-col': stage.id },
            h('div', { class: 'hrr-col-head' }, h('span', null, tr(stage.label)), h('b', null, String(items.length))),
            h('div', { class: 'hrr-col-body' },
                ...items.map((c) => candidateCard(c, canEdit)),
                items.length ? null : h('div', { class: 'hrr-col-empty' }, '—')));
        if (canEdit) {
            col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('is-drop'); });
            col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('is-drop'); });
            col.addEventListener('drop', (e) => {
                e.preventDefault(); col.classList.remove('is-drop');
                const id = Number(e.dataTransfer.getData('text/plain'));
                const c = state.board.candidates.find((x) => x.id === id);
                if (c && c.stage !== stage.id) moveCandidate(c, stage.id);
            });
        }
        return col;
    }

    function candidateCard(c, canEdit) {
        const days = daysSince(c.stage_changed_at);
        const linked = c.employee_id != null;
        const card = h('div', {
            class: 'hrr-card' + (linked ? ' is-linked' : ''), 'data-hrr-card': String(c.id), tabindex: '0',
            draggable: canEdit && !linked ? 'true' : 'false',
            onclick: () => openCandidate(c.id),
            onkeydown: (e) => { if (e.key === 'Enter') openCandidate(c.id); },
        },
            h('div', { class: 'hrr-card-name' }, c.full_name),
            c.vacancy_title ? h('div', { class: 'hrr-card-sub' }, c.vacancy_title) : null,
            h('div', { class: 'hrr-card-meta' },
                c.phone ? h('span', null, c.phone) : null,
                days != null && c.stage !== 'hired' && c.stage !== 'rejected'
                    ? h('span', { class: days >= 7 ? 'hrr-stale' : '' }, trf('{n} дн. на этапе', { n: days })) : null),
            c.stage === 'interview' && c.interview_at ? h('div', { class: 'hrr-card-sub' }, Icon('Calendar', { size: 12 }), ' ', fmtDateTime(c.interview_at)) : null,
            c.stage === 'rejected' && c.reject_reason ? h('div', { class: 'hrr-card-sub hrr-reason' }, c.reject_reason) : null,
            c.stage === 'hired' ? hireAction(c) : null);
        card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(c.id)); e.dataTransfer.effectAllowed = 'move'; card.classList.add('is-drag'); });
        card.addEventListener('dragend', () => card.classList.remove('is-drag'));
        return card;
    }

    // Кнопка «Создать сотрудника» у нанятого, или — если уже создан — кем он стал.
    function hireAction(c) {
        if (c.employee_id != null) {
            return h('div', { class: 'hrr-card-employee', 'data-hrr-employee': String(c.employee_id) },
                Icon('Check', { size: 12 }), ' ', trf('Сотрудник: {name}', { name: c.employee_name || '—' }));
        }
        if (!canCreateEmployee() || !state.board.can_edit) return null;
        return h('button', { type: 'button', class: 'btn btn-primary btn-sm hrr-create-emp', 'data-hrr-create-emp': String(c.id),
            onclick: (e) => { e.stopPropagation(); createEmployee(c.id); } },
        Icon('User', { size: 14 }), ' ', tr('Создать сотрудника'));
    }

    function createEmployee(candidateId) {
        document.querySelector('[data-hrr-modal]')?.remove();
        if (typeof onNavigate !== 'function') { toast(tr('Не удалось открыть «Сотрудники».'), 'error'); return; }
        onNavigate('employees', { hire: candidateId });
    }

    async function moveCandidate(c, stage, noteFromCard = '') {
        let note = noteFromCard;
        if (stage === 'rejected' && !note) {
            const reason = window.prompt(trf('Причина отказа — {name}:', { name: c.full_name }), '');
            if (reason === null) return false;
            note = reason.trim();
            if (!note) { toast(tr('Напишите причину отказа.'), 'warn'); return false; }
        }
        try {
            await rpc('hr_candidate_move', { id: c.id, stage, note });
            toast(trf('{name} → {stage}', { name: c.full_name, stage: tr(STAGE_LABEL[stage]) }), 'success');
            await load();
            return true;
        } catch (e) { toast(e.message, 'error'); return false; }
    }

    // ---- окна ----
    function modal(title, attrs = {}) {
        document.querySelector('[data-hrr-modal]')?.remove();
        const overlay = h('div', { class: 'modal', 'data-hrr-modal': '', ...attrs });
        const onKey = (ev) => { if (ev.key === 'Escape') close(); };
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const head = h('h2', null, title);
        // HR_CANDIDATE_CARD_V2 — под заголовком строка подписи (вакансия, источник, дата),
        // справа — кнопки окна (actions) перед «Закрыть».
        const sub = h('div', { class: 'hrr-modal-sub' });
        const actions = h('div', { class: 'hrr-head-actions' });
        const body = h('div', { class: 'modal-body' });
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        overlay.appendChild(h('div', { class: 'modal-card hrr-modal', role: 'dialog', 'aria-modal': 'true' },
            h('div', { class: 'modal-head hrr-modal-head' }, h('div', { class: 'hrr-modal-title' }, head, sub),
                h('div', { class: 'hrr-head-right' }, actions, h('button', { class: 'modal-close', type: 'button', 'aria-label': tr('Закрыть'), onclick: close }))),
            body));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey);
        return { body, head, sub, actions, close };
    }

    function openVacancy(v) {
        const m = modal(v ? tr('Вакансия') : tr('Новая вакансия'), { 'data-hrr-vacancy-modal': '' });
        const title = h('input', { type: 'text', maxlength: '200', value: v ? v.title : '', placeholder: tr('Например: Медсестра процедурного кабинета'), 'data-hrr-v-title': '' });
        const staffType = h('select', { 'data-hrr-v-type': '' }, ...STAFF_TYPES.map((t) => h('option', { value: t.id, selected: v ? v.staff_type === t.id : false }, tr(t.label))));
        const dept = h('select', { 'data-hrr-v-dept': '' }, h('option', { value: '' }, tr('Без отдела')),
            ...state.board.departments.map((d) => h('option', { value: String(d.id), selected: v ? v.department_id === d.id : false }, d.name)));
        const headcount = h('input', { type: 'number', min: '1', max: '999', step: '1', value: v ? String(v.headcount) : '1', 'data-hrr-v-count': '' });
        const status = h('select', { 'data-hrr-v-status': '' }, ...VACANCY_STATUS.map((s) => h('option', { value: s.id, selected: (v ? v.status : 'open') === s.id }, tr(s.label))));
        const desc = h('textarea', { rows: '4', maxlength: '4000', placeholder: tr('Требования, график, зарплата…'), 'data-hrr-v-desc': '' }, v ? v.description : '');
        const save = h('button', { type: 'button', class: 'btn btn-primary', 'data-hrr-v-save': '',
            onclick: async () => {
                if (!title.value.trim()) { toast(tr('Напишите название вакансии.'), 'warn'); title.focus(); return; }
                save.disabled = true;
                try {
                    await rpc('hr_vacancy_save', { id: v ? v.id : null, title: title.value, staff_type: staffType.value,
                        department_id: dept.value || null, headcount: Number(headcount.value) || 1, status: status.value, description: desc.value });
                    toast(tr('Вакансия сохранена.'), 'success');
                    m.close(); await load();
                } catch (e) { toast(e.message, 'error'); save.disabled = false; }
            } }, tr('Сохранить'));
        m.body.appendChild(h('div', { class: 'hrr-form' },
            h('div', { class: 'hrr-f-wide' }, field(tr('Название'), title)),
            field(tr('Категория персонала'), staffType),
            field(tr('Отдел'), dept),
            field(tr('Мест'), headcount),
            field(tr('Состояние'), status),
            h('div', { class: 'hrr-f-wide' }, field(tr('Описание'), desc)),
            h('div', { class: 'hrr-f-wide hrr-hint' }, tr('Категория и отдел подставятся в анкету сотрудника, когда кандидата наймут.')),
            h('div', { class: 'hrr-f-wide hrr-actions' }, save)));
        title.focus();
    }

    function candidateFields(c) {
        const f = {
            full_name: h('input', { type: 'text', maxlength: '200', value: c ? c.full_name : '', placeholder: tr('Фамилия Имя Отчество'), 'data-hrr-c-name': '' }),
            phone: h('input', { type: 'tel', maxlength: '50', value: c ? c.phone : '', placeholder: '+998', 'data-hrr-c-phone': '' }),
            email: h('input', { type: 'email', maxlength: '200', value: c ? c.email : '', 'data-hrr-c-email': '' }),
            source: h('select', { 'data-hrr-c-source': '' }, ...SOURCES.map((s) => h('option', { value: s.id, selected: (c ? c.source : 'other') === s.id }, tr(s.label)))),
            vacancy: h('select', { 'data-hrr-c-vacancy': '' }, h('option', { value: '' }, tr('Резерв — без вакансии')),
                ...state.board.vacancies.filter((v) => v.status !== 'closed' || (c && c.vacancy_id === v.id))
                    .map((v) => h('option', { value: String(v.id), selected: c ? c.vacancy_id === v.id
                        : state.vacancy === String(v.id) }, v.title))),
            interview_at: h('input', { type: 'datetime-local', value: c && c.interview_at ? String(c.interview_at).slice(0, 16) : '', 'data-hrr-c-interview': '' }),
            note: h('textarea', { rows: '3', maxlength: '4000', placeholder: tr('Опыт, ожидания по зарплате, впечатление…'), 'data-hrr-c-note': '' }, c ? c.note : ''),
        };
        const payload = () => ({ full_name: f.full_name.value, phone: f.phone.value, email: f.email.value, source: f.source.value,
            vacancy_id: f.vacancy.value || null, interview_at: f.interview_at.value || null, note: f.note.value });
        // HR_CANDIDATE_CARD_V2 — ФИО и вакансия во всю ширину, остальное парами:
        // раньше «Собеседование» стояло в ряду одно, с пустой половиной.
        const form = h('div', { class: 'hrr-form' },
            h('div', { class: 'hrr-f-wide' }, field(tr('ФИО'), f.full_name)),
            field(tr('Телефон'), f.phone),
            field(tr('Почта'), f.email),
            h('div', { class: 'hrr-f-wide' }, field(tr('Вакансия'), f.vacancy)),
            field(tr('Источник'), f.source),
            field(tr('Собеседование'), f.interview_at),
            h('div', { class: 'hrr-f-wide' }, field(tr('Заметка'), f.note)));
        return { f, form, payload };
    }

    function openCandidateForm() {
        const m = modal(tr('Новый кандидат'), { 'data-hrr-candidate-new': '' });
        const { f, form, payload } = candidateFields(null);
        const save = h('button', { type: 'button', class: 'btn btn-primary', 'data-hrr-c-save': '',
            onclick: async () => {
                if (!f.full_name.value.trim()) { toast(tr('Напишите ФИО кандидата.'), 'warn'); f.full_name.focus(); return; }
                save.disabled = true;
                try {
                    await rpc('hr_candidate_save', payload());
                    toast(tr('Кандидат добавлен в «Отклик».'), 'success');
                    m.close(); await load();
                } catch (e) { toast(e.message, 'error'); save.disabled = false; }
            } }, tr('Добавить'));
        m.body.append(form, h('div', { class: 'hrr-actions' }, save));
        f.full_name.focus();
    }

    async function openCandidate(id) {
        const m = modal(tr('Кандидат'), { 'data-hrr-candidate': String(id) });
        m.body.appendChild(h('div', null, tr('Загрузка…')));
        let data;
        try { data = await rpc('hr_candidate_get', { id }); }
        catch (e) { clear(m.body); m.body.appendChild(h('div', { class: 'error-state' }, e.message)); return; }
        const c = data.candidate;
        const canEdit = state.board.can_edit;
        const linked = c.employee_id != null;
        clear(m.head); m.head.append(Icon('User', { size: 16 }), ' ', c.full_name);
        // HR_CANDIDATE_CARD_V2 — подпись под именем вместо строки внизу окна.
        clear(m.sub);
        m.sub.textContent = [c.vacancy_title || tr('Резерв — без вакансии'), tr(SOURCE_LABEL[c.source] || c.source),
            trf('добавлен {date}', { date: fmtDate(c.created_at) })].filter(Boolean).join(' · ');
        clear(m.body);

        // HR_CANDIDATE_CARD_V2 (владелец: «put save button on top as a system blue color
        // and make card more accurate») — «Сохранить» в шапке, синяя (btn-primary),
        // активна, только когда в анкете что-то изменили. Смена этапа с
        // несохранённой анкетой сначала сохраняет её: иначе правка пропала бы при
        // перерисовке карточки.
        let dirty = false;
        let saveAnketa = async () => true;
        const saveBtn = canEdit ? h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: true, 'data-hrr-c-save': '',
            onclick: () => saveAnketa() }, tr('Сохранить')) : null;
        if (saveBtn) { clear(m.actions); m.actions.appendChild(saveBtn); }

        // Этапы — ступени слева направо, «Отказ» — отдельно справа. Текущий залит,
        // пройденные отмечены. У кандидата, из которого уже создан сотрудник,
        // этап не меняется (сервер — 409).
        const flow = STAGES.filter((s) => s.id !== 'rejected');
        const curIdx = flow.findIndex((s) => s.id === c.stage);
        const stepBtn = (s, i) => h('button', {
            type: 'button', 'data-hrr-stage': s.id,
            class: 'hrr-step hrr-stage-' + s.id + (c.stage === s.id ? ' on' : '') + (curIdx >= 0 && i < curIdx ? ' done' : ''),
            disabled: !canEdit || linked || c.stage === s.id,
            onclick: async () => {
                if (dirty && !(await saveAnketa())) return;
                if (await moveCandidate(c, s.id)) openCandidate(id);
            },
        }, tr(s.label));
        m.body.appendChild(h('div', { class: 'hrr-steps-row', 'data-hrr-stages': '' },
            h('div', { class: 'hrr-steps' }, ...flow.map(stepBtn)),
            stepBtn(STAGES.find((s) => s.id === 'rejected'), -1)));

        if (c.stage === 'hired') {
            m.body.appendChild(h('div', { class: 'hrr-hired-box' },
                linked
                    ? h('div', null, Icon('Check', { size: 14 }), ' ', trf('Сотрудник создан: {name}', { name: c.employee_name || '—' }))
                    : canCreateEmployee() && canEdit
                        ? h('div', { class: 'hrr-hired-row' },
                            h('span', null, tr('Кандидат нанят. Заведите его сотрудником: откроется анкета в «Настройки → Сотрудники» с уже заполненными ФИО, телефоном, категорией и отделом.')),
                            h('button', { type: 'button', class: 'btn btn-primary', 'data-hrr-create-emp': String(c.id), onclick: () => { m.close(); createEmployee(c.id); } },
                                Icon('User', { size: 14 }), ' ', tr('Создать сотрудника')))
                        : h('div', null, tr('Кандидат нанят. Сотрудника заводит тот, кому открыты «Настройки → Сотрудники».'))));
        }
        if (c.stage === 'rejected' && c.reject_reason) {
            m.body.appendChild(h('div', { class: 'hrr-reject-box' }, h('b', null, tr('Причина отказа:')), ' ', c.reject_reason));
        }

        // HR_CANDIDATE_DOCS_V1 — окно шире, в две колонки: слева анкета,
        // справа документы (паспорт, резюме, диплом…). На узком экране — одна под другой.
        const leftCol = h('div', { class: 'hrr-cand-main' });
        const docsCol = h('div', { class: 'hrr-cand-docs', 'data-hrr-docs': '' });
        m.body.appendChild(h('div', { class: 'hrr-cand-grid' }, leftCol, docsCol));
        paintDocuments(docsCol, c, data.documents || [], canEdit, () => openCandidate(id));

        const { f, form, payload } = candidateFields(c);
        if (!canEdit) for (const el of Object.values(f)) el.disabled = true;
        leftCol.appendChild(form);
        if (canEdit) {
            const markDirty = () => { dirty = true; saveBtn.disabled = false; };
            for (const el of Object.values(f)) { el.addEventListener('input', markDirty); el.addEventListener('change', markDirty); }
            saveAnketa = async () => {
                if (!f.full_name.value.trim()) { toast(tr('Напишите ФИО кандидата.'), 'warn'); f.full_name.focus(); return false; }
                saveBtn.disabled = true;
                try {
                    await rpc('hr_candidate_save', { id: c.id, ...payload() });
                    dirty = false;
                    clear(m.head); m.head.append(Icon('User', { size: 16 }), ' ', f.full_name.value.trim());
                    toast(tr('Сохранено.'), 'success');
                    load();
                    return true;
                } catch (e) { toast(e.message, 'error'); saveBtn.disabled = false; return false; }
            };
        }

        const historyBox = h('div', { class: 'hrr-history-box' }, h('h3', { class: 'hrr-h3' }, tr('История')));
        m.body.appendChild(historyBox);
        historyBox.appendChild(h('ul', { class: 'hrr-history', 'data-hrr-history': '' },
            ...data.events.map((ev) => h('li', null,
                h('span', { class: 'hrr-history-when' }, fmtDateTime(ev.at)),
                h('span', null,
                    ev.from_stage == null ? tr('Добавлен в воронку')
                        : ev.from_stage === ev.to_stage && ev.to_stage === 'hired' ? tr('Создан сотрудник')
                            : trf('{from} → {to}', { from: tr(STAGE_LABEL[ev.from_stage] || ev.from_stage), to: tr(STAGE_LABEL[ev.to_stage] || ev.to_stage) }),
                    ev.note ? h('span', { class: 'hrr-history-note' }, ' — ', ev.note) : null),
                ev.by_name ? h('span', { class: 'hrr-history-by' }, ev.by_name) : null))));
    }

    // HR_CANDIDATE_DOCS_V1 — блок «Документы» в карточке кандидата: загрузка
    // (вид, название, файл) и список с «Открыть» / «Убрать». Файл — в
    // hr-docs/candidate/<id>/, строку регистрирует hr_candidate_document_add.
    function paintDocuments(host, c, docs, canEdit, reopen) {
        host.appendChild(h('h3', { class: 'hrr-h3 hrr-docs-h' }, Icon('Paperclip', { size: 14 }), ' ', tr('Документы'),
            docs.length ? h('span', { class: 'hrr-docs-count' }, String(docs.length)) : null));
        if (canEdit) {
            const kind = h('select', { 'data-hrr-doc-kind': '' }, ...CANDIDATE_DOC_KINDS.map((k) => h('option', { value: k.id }, tr(k.label))));
            const title = h('input', { type: 'text', maxlength: '200', 'data-hrr-doc-title': '', placeholder: tr('Например: Паспорт, страницы 1–2') });
            const file = h('input', { type: 'file', 'data-hrr-doc-file': '' });
            const add = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-hrr-doc-add': '',
                onclick: async () => {
                    const fl = file.files && file.files[0];
                    if (!fl) { toast(tr('Выберите файл.'), 'warn'); return; }
                    const name = title.value.trim() || tr(DOC_KIND_LABEL[kind.value]);
                    add.disabled = true;
                    try {
                        const up = await uploadFile(DOCS_BUCKET, fl, `candidate/${c.id}/`);
                        await rpc('hr_candidate_document_add', { candidate_id: c.id, kind: kind.value, title: name,
                            file_path: up.path, file_name: up.name, file_size: up.size });
                        toast(tr('Документ приложен.'), 'success');
                        reopen();
                    } catch (e) { toast(e.message || String(e), 'error'); add.disabled = false; }
                } }, Icon('Paperclip', { size: 14 }), ' ', tr('Загрузить'));
            host.appendChild(h('div', { class: 'hrr-doc-form' },
                field(tr('Вид документа'), kind),
                field(tr('Название'), title),
                h('div', { class: 'hrr-f-wide' }, field(tr('Файл'), file)),
                h('div', { class: 'hrr-f-wide hrr-doc-form-btn' }, add)));
        }
        if (!docs.length) {
            host.appendChild(h('div', { class: 'hrr-docs-empty' }, tr('Документов пока нет.')));
            return;
        }
        host.appendChild(h('ul', { class: 'hrr-doc-list' }, ...docs.map((d) => h('li', { 'data-hrr-doc': String(d.id) },
            h('div', { class: 'hrr-doc-main' },
                h('button', { type: 'button', class: 'hr-link', title: d.file_name || '',
                    onclick: async () => {
                        const url = await signedUrl(DOCS_BUCKET, d.file_path);
                        if (url) window.open(url, '_blank', 'noopener'); else toast(tr('Файл не открылся.'), 'error');
                    } }, Icon('Doc', { size: 14 }), ' ', d.title),
                h('div', { class: 'hrr-doc-sub' }, [tr(DOC_KIND_LABEL[d.kind] || d.kind), fmtDate(d.uploaded_at), d.uploaded_by_name].filter(Boolean).join(' · '))),
            canEdit ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-hrr-doc-remove': String(d.id),
                onclick: async () => {
                    if (!window.confirm(trf('Убрать документ «{title}» из карточки?', { title: d.title }))) return;
                    try { await rpc('hr_candidate_document_remove', { id: d.id }); reopen(); }
                    catch (e) { toast(e.message, 'error'); }
                } }, tr('Убрать')) : null))));
    }

    await load();
}
