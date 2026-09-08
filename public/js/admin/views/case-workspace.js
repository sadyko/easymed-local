// CASE_WORKSPACE_V1 (2026-09-06) — ИСТОРИЯ БОЛЕЗНИ КАК РАБОЧИЙ ЭКРАН, А НЕ КАК
// ОКНО ПОВЕРХ ОКНА.
//
// Владелец: «can we make this, as a doctors cabinet type document editing? in
// the left panel step by step documents. and when the pressed the collect
// history, its will be saved in the documents section of the patient».
//
// КАК БЫЛО. Чек-лист жил внутри карточки госпитализации (сама по себе окно), а
// документ открывался ВТОРЫМ окном поверх первого. Чтобы оформить историю
// болезни из семи бумаг, врач семь раз открывал и закрывал окно поверх окна, и
// после каждой возвращался искать, где он остановился. Список шагов при этом
// был виден только до того, как открыл документ, — то есть ровно тогда, когда
// он уже не нужен.
//
// КАК СТАЛО. Слева — те же шаги по регламенту, всегда на виду: что просрочено,
// что следующее, что уже оформлено. Справа — редактор выбранного документа. Это
// тот же самый редактор, что и в окне (buildReviewEditor в admission-modal.js):
// правила публикации, исправления и черновика существуют в ОДНОМ месте, иначе
// два экрана однажды разошлись бы в том, что считается опубликованным.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ЭКРАН, А НЕ ДВЕ ПОЛОВИНЫ ВНУТРИ КАРТОЧКИ. Оформление истории
// болезни — это работа на полчаса с десятком бумаг, а карточка госпитализации
// открывается на минуту, чтобы посмотреть койку и лечащего врача. Работа
// длиной в полчаса не живёт в модальном окне: её прерывают, к ней возвращаются,
// на неё дают ссылку — всё это умеет адрес, и ничего из этого не умеет окно.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, PageHead } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { caseDocsView, assembleCaseFile } from './case-docs.js?v=cw1';
import { buildReviewEditor } from './admission-modal.js?v=inp2';
import { buildTitleSheetEditor, TITLE_SHEET_KIND } from './title-sheet.js';   // TITLE_SHEET_V1
import { a4Sheet } from './a4-letterhead.js';   // A4_LETTERHEAD_V1
import { caseHead } from './case-overview.js?v=co1';   // CASE_OVERVIEW_V1 — одна шапка на «Обзор» и «Документы»
import { caseInsertPanel } from './case-doc-insert.js';   // CASE_DOC_A4_V1 — правая панель «Вставить в документ»
import { dxEditor } from './case-dx.js';   // CASE_DX_LIST_V1 — диагнозы списком
import { setupA4Pagination } from './a4-paginate.js';   // A4_PAGINATE_V1 — разрывы страниц в редакторе

const state = {
    admissionId: null,
    admission: null,
    docs: null,        // ответ admission_case_docs
    filter: 'all',
    open: null,        // {kind, mode, reviewId} — что открыто в центре
    editor: null,      // CASE_DOC_A4_V1 — открытый редактор: правая панель вставляет в него
    disposePagination: null,   // A4_PAGINATE_V1 — отмена слежения за разрывами
    failed: null,
    overview: null,    // CASE_OVERVIEW_V1 — ответ admission_overview для шапки
};

function reset(admissionId) {
    state.admissionId = admissionId;
    state.admission = null;
    state.docs = null;
    state.filter = 'all';
    state.open = null;
    state.editor = null;
    state.failed = null;
    state.overview = null;
}

export async function renderCaseWorkspace(container, { payload, onNavigate } = {}) {
    // CASE_ROUTE_SUB_V1 — номер госпитализации едет и в адресе (#case-file/123,
    // payload.sub): перезагрузка страницы возвращает те же документы, а не
    // «Госпитализация не выбрана».
    const admissionId = Number(payload && (payload.admissionId || payload.admission_id || payload.id || payload.sub)) || null;
    if (state.admissionId !== admissionId) reset(admissionId);
    // CASE_OVERVIEW_V1 — главное действие обзора открывает документы НА НУЖНОМ ШАГЕ.
    if (payload && payload.kind) state.open = { kind: String(payload.kind), mode: 'edit', reviewId: null };

    clear(container);
    const root = h('div', { class: 'fade-in cw' });
    container.appendChild(root);

    if (!admissionId) {
        root.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
            h('div', { style: { fontSize: '15px', fontWeight: '600', color: 'var(--ink-900)' } },
                tr('Госпитализация не выбрана')),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '6px' } },
                tr('Историю болезни открывают из карточки госпитализации в разделе «Стационар».'))));
        return;
    }

    await load();
    paint(root, onNavigate);
}

async function load() {
    // Госпитализация читается ТЕМ ЖЕ запросом, что и в карточке
    // (admission-modal.js): пациент, палата, койка и лечащий врач приезжают
    // связями. Отдельного RPC для карточки не существует — я сперва позвал
    // несуществующий `admission_card`, и шапка молча осталась бы без имени
    // пациента, а редактор — без его данных.
    const [{ data: docs, error: docsErr }, { data: adm }, { data: ov }] = await Promise.all([
        supabase.rpc('admission_case_docs', { admission_id: state.admissionId }),
        supabase.from('admissions')
            .select('*, patients(mrn, full_name), wards(name), beds(code), '
                  + 'attending:attending_doctor_id(full_name, specialty)')
            .eq('id', state.admissionId).single(),
        supabase.rpc('admission_overview', { admission_id: state.admissionId }),   // CASE_OVERVIEW_V1 — для шапки
    ]);
    state.overview = ov || null;
    // Отказ по праву и сбой — РАЗНЫЕ вещи, и экран обязан их различать: пустой
    // список читается как «документов нет», а это ложь в обе стороны.
    if (docsErr) { state.failed = docsErr.code === 'forbidden' ? 'forbidden' : (docsErr.message || 'error'); return; }
    if (!docs || !Array.isArray(docs.items)) { state.failed = 'error'; return; }
    state.failed = null;
    state.docs = docs;
    state.admission = adm || state.admission;
}

function paint(root, onNavigate) {
    clear(root);
    if (state.failed === 'forbidden') {
        root.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
            h('div', { style: { fontSize: '15px', fontWeight: '600' } }, tr('История болезни закрыта для вашей роли')),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '6px' } },
                tr('Её ведут врачи и медсёстры отделения. Доступ открывает администратор клиники.'))));
        return;
    }
    if (state.failed) {
        root.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
            h('div', { style: { fontSize: '15px', fontWeight: '600', color: 'var(--crit-700)' } },
                tr('История болезни не загрузилась')),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '6px' } },
                trf('Это сбой запроса, а не пустая история: {msg}', { msg: state.failed })),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginTop: '12px' },
                onclick: async () => { await load(); paint(root, onNavigate); } }, tr('Повторить'))));
        return;
    }

    const a = state.admission || {};
    const p = a.patients || {};
    const who = [p.mrn, a.department, a.admission_no].filter(Boolean).join(' · ');

    // CASE_OVERVIEW_V1 — та же шапка, что у «Обзора»: пациент, стрелки по
    // соседям, вкладки, главное действие. Без обзора (старый ответ, отказ) —
    // прежняя подпись экрана, чтобы документы открывались в любом случае.
    if (state.overview) {
        root.appendChild(caseHead(state.overview, {
            active: 'documents', onNavigate,
            onReload: async () => { await load(); paint(root, onNavigate); },
        }));
    } else {
        root.appendChild(PageHead({ title: p.full_name || tr('История болезни'), subtitle: who || null }));
    }

    // CASE_DOC_A4_V1 — владелец: «documents of the history left panel right
    // panel». Слева шаги и диагноз, в центре лист, справа — что вставить.
    const rail = h('div', { class: 'cw-rail' });
    const pane = h('div', { class: 'cw-pane' });
    const aside = h('div', { class: 'cw-aside' });
    root.appendChild(h('div', { class: 'cw-grid' }, rail, pane, aside));

    // Лист рисуется ПЕРВЫМ: карточка «Диагноз» слева показывает поле открытого
    // документа, а его создаёт редактор.
    paintPane(pane, root, onNavigate);
    paintRail(rail, root, onNavigate);
    paintAside(aside);
}

// Правая панель живёт ОТДЕЛЬНО от листа: она читает свои источники один раз и
// не перерисовывается при каждом переключении документа — вставка идёт в тот
// редактор, который открыт сейчас (state.editor).
function paintAside(aside) {
    if (!aside) return;
    clear(aside);
    aside.appendChild(caseInsertPanel({
        admissionId: state.admissionId,
        onInsert: (html) => !!(state.editor && state.editor.insert && state.editor.insert(html)),
    }));
}

// Левая колонка: диагноз госпитализации, выбор документа и шаги по регламенту.
// CASE_DX_PICK_V1 — диагноз ОТКРЫТОГО документа пишется здесь: своими словами
// или кодом из справочника МКБ-10 (подсказки — icdSuggest). Ниже, мелким —
// диагнозы самой госпитализации: клинический и при направлении, чтобы не
// вспоминать их по памяти, переходя между документами.
function diagnosisCard() {
    const dg = (state.overview && state.overview.diagnosis) || {};
    const ed = state.editor;
    const card = h('section', { class: 'card cw-dx', 'aria-label': tr('Диагноз') },
        h('div', { class: 'cw-dx-h' }, Icon('Stethoscope', { size: 14 }), ' ', tr('Диагноз')));

    if (ed && ed.diagnosisInput) {
        // CASE_DX_LIST_V1 — поле редактора хранит строку, карточка показывает
        // список: чипы с ролью, справочник МКБ-10 и «свой диагноз».
        card.appendChild(dxEditor({ carrier: ed.diagnosisInput, required: ed.diagnosisRequired }));
    }

    const refs = [
        dg.clinical ? ['Клинический', dg.clinical] : null,
        dg.referral ? ['При направлении', dg.referral] : null,
    ].filter(Boolean);
    if (refs.length) {
        card.appendChild(h('div', { class: 'cw-dx-refs' }, ...refs.map(([label, value]) => h('div', { class: 'cw-dx-ref' },
            h('span', { class: 'cw-dx-ref-l' }, tr(label)),
            h('span', { class: 'cw-dx-ref-v' }, value)))));
    } else if (!(ed && ed.diagnosisInput)) {
        card.appendChild(h('div', { class: 'cw-dx-empty' }, tr('Диагноз ещё не установлен — его пишут в первичном осмотре.')));
    }
    return card;
}

// CASE_RAIL_ASSEMBLE_V1 — выпадающего списка документов здесь больше нет.
// Он перечислял РОВНО ТО ЖЕ, что чек-лист строкой ниже, только без сроков и
// состояний: два способа выбрать одно и то же занимали половину колонки и
// заставляли её прокручиваться. Владелец: «we dont need in the left panel
// scrolling options».

// Сборка истории — из списка документов, поэтому и кнопка под ним.
function assembleFor(root, onNavigate) {
    return h('button', {
        class: 'btn btn-primary cw-assemble', type: 'button',
        onclick: async () => {
            const saved = await assembleCaseFile(state.admissionId);
            // Подшили — значит список «сколько оформлено» мог измениться.
            if (saved) { await load(); paint(root, onNavigate); }
        },
    }, Icon('Doc', { size: 14 }), ' ', tr('Собрать историю'));
}

function paintRail(rail, root, onNavigate) {
    clear(rail);
    rail.appendChild(diagnosisCard());
    const list = h('div', { class: 'card cw-steps' });
    rail.appendChild(list);
    list.appendChild(caseDocsView({
        state: state.docs,
        filter: state.filter,
        onFilter: (key) => { state.filter = key; paintRail(rail, root, onNavigate); },
        // Документ ОТКРЫВАЕТСЯ СПРАВА, а не окном поверх: в этом и была вся
        // задача. Выбранный шаг остаётся виден в списке слева.
        onDoc: (kind, mode, reviewId) => {
            state.open = { kind, mode: mode || 'edit', reviewId: reviewId || null };
            paintPane(rail.parentNode.querySelector('.cw-pane'), root, onNavigate);
            paintRail(rail, root, onNavigate);
        },
        // Сборка — не шаг регламента, поэтому и не строка списка: она стоит
        // отдельной кнопкой ПОД списком (assembleFor).
        onAssemble: null,
        activeKind: state.open ? state.open.kind : null,
    }));
    rail.appendChild(assembleFor(root, onNavigate));
}

function paintPane(pane, root, onNavigate) {
    if (!pane) return;
    clear(pane);
    if (!state.open) {
        pane.appendChild(h('div', { class: 'card cw-empty' },
            Icon('Doc', { size: 22 }),
            h('div', { class: 'cw-empty-t' }, tr('Выберите документ слева')),
            h('div', { class: 'cw-empty-s' },
                tr('Список идёт по регламенту: сверху то, что просрочено, ниже — что оформляют дальше.'))));
        return;
    }

    const onDone = async () => {
        await load();
        paint(root, onNavigate);
    };
    // TITLE_SHEET_V1 — титульный лист медсестры: своя форма, тот же лист A4.
    const ed = state.open.kind === TITLE_SHEET_KIND
        ? buildTitleSheetEditor({ admission: Object.assign({}, state.admission, { id: state.admissionId }), onDone })
        : buildReviewEditor({
            admission: Object.assign({}, state.admission, { id: state.admissionId }),
            kind: state.open.kind,
            mode: state.open.mode,
            reviewId: state.open.reviewId,
            onDone,
        });
    if (!ed) return;
    state.editor = ed;   // CASE_DOC_A4_V1 — правая панель вставляет в него

    // A4_LETTERHEAD_V1 — документ на ЛИСТЕ, а не в карточке (владелец: «treat
    // this section as an A4 list with the header of the clinic from the
    // documents section»). Это документ истории болезни: его потом печатают, и
    // на экране он должен выглядеть как тот же лист — с шапкой клиники из
    // window.CLINIC, откуда её берут и печатные бланки. Классы .a4-* общие с
    // кабинетом врача (service-workspace.js). Кнопки действий на лист не
    // кладутся — это не часть документа, они стоят под ним.
    const card = h('div', { class: 'cw-doc a4-scroll' },
        // CASE_DOC_A4_V1 — панель форматирования НАД листом: она инструмент, а
        // не часть документа, и на печать не идёт.
        ed.toolbar || null,
        ed.noLetterhead
            // FORM_003_V1 — у бланка 003 своя шапка (министерство, учреждение, приказ).
            ? h('div', { class: 'a4-paper f3-paper' },
                h('div', { class: 'cw-doc-body f3' }, ...ed.fields.filter(Boolean)))
            : a4Sheet({ title: ed.title, children: [
                h('div', { class: 'cw-doc-body' }, ...ed.fields.filter(Boolean)),
            ] }),
        // TITLE_SHEET_PAPERS_OUT_V1 — то, что относится к документу, но им не
        // является: отдельные бумаги, пульты, отметки. Стоит ПОД листом, как и
        // кнопки действий, и в расчёт разрывов страниц не попадает.
        ...((ed.belowSheet || []).filter(Boolean)),
    );

    const foot = h('div', { class: 'cw-doc-foot' });
    if (ed.secondaryLabel) {
        foot.appendChild(h('button', { class: 'btn btn-outline', type: 'button',
            onclick: () => ed.secondary && ed.secondary() }, ed.secondaryLabel));
    }
    if (ed.submitLabel) {
        foot.appendChild(h('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                try { await ed.submit(); } finally { btn.disabled = false; }
            },
        }, ed.submitLabel));
    }
    if (foot.children.length) card.appendChild(foot);
    pane.appendChild(card);

    // A4_PAGINATE_V1 — владелец: «treat every document as a a4 list, with real
    // ui breaks in the window of user». Разрывы считаются по высоте блоков и
    // пересчитываются, пока врач пишет.
    if (state.disposePagination) { try { state.disposePagination(); } catch (e) { /* нечего отменять */ } }
    state.disposePagination = setupA4Pagination(card, { label: (pg) => trf('Страница {n}', { n: pg }) });
}

export function resetCaseWorkspace() { reset(null); }
