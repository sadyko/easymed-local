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
import { caseDocsView, assembleCaseFile, canEditDocSet, caseDocSetDrop, caseDocSetAdd,
    caseDocSetRestore, caseDocSetRename, caseDocSetDelete, loadDocTypeSet } from './case-docs.js?v=cw1';
import { buildReviewEditor } from './admission-modal.js?v=inp2';
import { docActionsBar, docHeadIds, docHeadFields } from './case-doc-a4.js';   // CASE_DOC_ACTIONS_V1 / A4_LETTERHEAD_V2
import { CASE_TABS, caseTabsBar, caseExamsPanel, caseSurgeryPanel, caseActPanel,
    actPrintBody, caseMealsPanel, caseInvoicesPanel } from './case-file-tabs.js';   // CASE_FILE_TABS_V1 / ACT_OF_WORKS_V1
import { buildTitleSheetEditor, TITLE_SHEET_KIND } from './title-sheet.js';   // TITLE_SHEET_V1
import { a4Sheet } from './a4-letterhead.js';   // A4_LETTERHEAD_V2
import { dateNumeric } from '../../shared/date-words.js';   // A4_LETTERHEAD_V2 — дата рождения числом
import { shortName, placeLine } from '../../shared/person-name.js';   // PERSON_NAME_SHORT_V1
import { caseHead } from './case-overview.js?v=co1';   // CASE_OVERVIEW_V1 — одна шапка на «Обзор» и «Документы»
import { caseInsertPanel } from './case-doc-insert.js';   // CASE_DOC_A4_V1 — правая панель «Вставить в документ»
import { dxEditor } from './case-dx.js';   // CASE_DX_LIST_V1 — диагнозы списком
import { setupA4Pagination, setupA4Fit } from './a4-paginate.js';   // A4_PAGINATE_V1 / FORM_003_ONE_PAGE_V1

const state = {
    admissionId: null,
    admission: null,
    docs: null,        // ответ admission_case_docs
    open: null,        // {kind, mode, reviewId} — что открыто в центре
    editor: null,      // CASE_DOC_A4_V1 — открытый редактор: правая панель вставляет в него
    disposePagination: null,   // A4_PAGINATE_V1 — отмена слежения за разрывами
    disposeFit: null,          // CASE_FIT_EXACT_V1 — отмена слежения за высотой колонок
    failed: null,
    overview: null,    // CASE_OVERVIEW_V1 — ответ admission_overview для шапки
    charges: null,     // ACT_ADD_SERVICE_V1 — начисленное: им вкладки показывают назначенное
};

function reset(admissionId) {
    state.admissionId = admissionId;
    state.admission = null;
    state.docs = null;
    state.open = null;
    state.editor = null;
    if (state.disposeFit) { try { state.disposeFit(); } catch (e) { /* нечего отменять */ } state.disposeFit = null; }
    state.failed = null;
    state.overview = null;
    state.charges = null;
}

export async function renderCaseWorkspace(container, { payload, onNavigate } = {}) {
    // CASE_ROUTE_SUB_V1 — номер госпитализации едет и в адресе (#case-file/123,
    // payload.sub): перезагрузка страницы возвращает те же документы, а не
    // «Госпитализация не выбрана».
    const admissionId = Number(payload && (payload.admissionId || payload.admission_id || payload.id || payload.sub)) || null;
    if (state.admissionId !== admissionId) reset(admissionId);
    // CASE_OVERVIEW_V1 — главное действие обзора открывает документы НА НУЖНОМ ШАГЕ.
    if (payload && payload.kind) state.open = { kind: String(payload.kind), mode: 'edit', reviewId: null };
    // MAR_IN_CABINET_V1 — адрес умеет открывать нужную вкладку: этим живут
    // переходы «в лист назначений» из карточки госпитализации и от медсестры.
    if (payload && payload.tab && CASE_TABS.some((t) => t.id === payload.tab)) state.tab = String(payload.tab);

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
            // A4_LETTERHEAD_V2 — шапка называет дату рождения: без неё бумагу в
            // стопке не отличить от однофамильца.
            .select('*, patients(mrn, full_name, date_of_birth), wards(name), beds(code), '
                  + 'attending:attending_doctor_id(full_name, specialty)')
            .eq('id', state.admissionId).single(),
        supabase.rpc('admission_overview', { admission_id: state.admissionId }),   // CASE_OVERVIEW_V1 — для шапки
    ]);
    state.overview = ov || null;
    // ACT_ADD_SERVICE_V1 — начисленное нужно вкладкам «Обследования» и
    // «Операция», чтобы показать НАЗНАЧЕННОЕ. Отказ по праву здесь не беда:
    // без акта вкладки просто не покажут этот блок.
    {
        const { data: ch } = await supabase.rpc('admission_charges', { admission_id: state.admissionId });
        state.charges = ch || null;
    }
    // Отказ по праву и сбой — РАЗНЫЕ вещи, и экран обязан их различать: пустой
    // список читается как «документов нет», а это ложь в обе стороны.
    if (docsErr) { state.failed = docsErr.code === 'forbidden' ? 'forbidden' : (docsErr.message || 'error'); return; }
    if (!docs || !Array.isArray(docs.items)) { state.failed = 'error'; return; }
    state.failed = null;
    state.docs = docs;
    state.admission = adm || state.admission;
    // CASE_FILE_TABS_V1 — вкладка помнится между перерисовками: врач, открывший
    // назначения, не должен возвращаться в документы после каждой загрузки.
    if (!state.tab) state.tab = 'documents';
    // CASE_DOC_SET_BACK_V1 — убранные документы едут вместе с чек-листом: они
    // стоят в его конце бледной строкой, и вернуть их можно нажатием.
    state.types = canEditDocSet() ? await loadDocTypeSet() : [];
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

    // CASE_FILE_TABS_V1 — ПОЛОСА ВКЛАДОК ПОД КАРТОЧКОЙ ПАЦИЕНТА. Владелец:
    // «after the card of the patient we need to add tabs for navigation».
    // Пациент один и тот же, работа разная: документы, назначения, анализы,
    // операция. Раньше за каждой из них шли в свой раздел и заново искали
    // пациента.
    root.appendChild(caseTabsBar({
        active: state.tab || 'documents',
        onPick: (id) => { state.tab = id; paint(root, onNavigate); },
        badges: { orders: ((state.overview && state.overview.orders) || []).length },
    }));

    if ((state.tab || 'documents') !== 'documents') {
        paintTab(root, onNavigate);
        return;
    }

    // CASE_DOC_A4_V1 — владелец: «documents of the history left panel right
    // panel». Слева шаги и диагноз, в центре лист, справа — что вставить.
    const rail = h('div', { class: 'cw-rail' });
    const pane = h('div', { class: 'cw-pane' });
    const aside = h('div', { class: 'cw-aside' });
    const grid = h('div', { class: 'cw-grid' }, rail, pane, aside);
    // CASE_FILE_FIT_V1 (2026-09-10) — обёртка нужна, чтобы колонки мерили СВОЮ
    // ширину, а не ширину окна: боковое меню приложения сворачивается, полоса
    // содержимого от этого меняется на 260 px, а @media про это не знает —
    // владелец: «when left panel is closed the layout is breaking».
    root.appendChild(h('div', { class: 'cw-wrap' }, grid));
    // CASE_FIT_EXACT_V1 — высота колонок МЕРЯЕТСЯ, а не угадывается. Прежнее
    // calc(100vh − 150px) считало шапку экрана постоянной, а она не постоянная:
    // имя пациента переносится, полоса реквизитов растёт, и колонка вылезала за
    // экран ровно на разницу — владелец: «its still too big».
    state.disposeFit = fitColumns(grid);

    // Лист рисуется ПЕРВЫМ: карточка «Диагноз» слева показывает поле открытого
    // документа, а его создаёт редактор.
    paintPane(pane, root, onNavigate);
    paintRail(rail, root, onNavigate);
    paintAside(aside);
}

/**
 * НАЧИСЛИТЬ ГОСПИТАЛИЗАЦИИ УСЛУГУ ИЗ СПРАВОЧНИКА.
 *
 * ACT_ADD_SERVICE_V1 — окно выбора услуги здесь ТО ЖЕ, что у направлений из
 * кабинета врача (openServicePickerModal): один справочник, один способ искать,
 * одни и те же цены. Разделы задаёт вызывающий: анализам — лаборатория,
 * диагностика и лучевая, операции — хирургия.
 *
 * Цену берёт СЕРВЕР из справочника; экран посылает только услугу.
 */
async function addAdmissionService(root, onNavigate, { title, types }) {
    const { openServicePickerModal } = await import('./service-picker-modal.js?v=aug17e');
    openServicePickerModal({
        title: tr(title),
        confirmLabel: tr('Назначить'),
        allowedTypeNames: types,
        onPick: async ({ service }) => {
            if (!service || !service.id) return;
            const { error } = await supabase.rpc('admission_service_add', {
                admission_id: state.admissionId, service_id: service.id, quantity: 1,
            });
            if (error) { toast(error.message || tr('Не удалось назначить услугу.'), 'fail'); return; }
            toast(trf('Назначено: {name}', { name: service.name || '' }), 'ok');
            await load();
            paint(root, onNavigate);
        },
    });
}

/**
 * Вкладки, кроме документов. Ничего не считают: показывают то, что уже
 * прислали обзор (назначения, операция) и источники документа (анализы).
 */
function paintTab(root, onNavigate) {
    const tab = state.tab;
    const nav = onNavigate || (typeof window !== 'undefined' && window.easymed && window.easymed.navigate);
    const box = h('div', { class: 'cf-tabwrap' });
    root.appendChild(box);

    // CASE_TABS_FULL_V1 — вкладки эталона владельца. Ни одна из них не считает
    // ничего своего: счета читают готовый обзор, питание — тот же блок стола,
    // что и карточка госпитализации.
    if (tab === 'meals') {
        box.appendChild(caseMealsPanel(state.admissionId, state.overview, {
            onChange: async () => { await load(); paint(root, onNavigate); },
        }));
        return;
    }
    if (tab === 'invoices') {
        box.appendChild(caseInvoicesPanel(state.overview, {
            // Деньги принимает КАССА, и вкладка честно уводит туда, а не заводит
            // второй приём оплат внутри истории болезни.
            onCashier: () => { if (nav) nav('cashier-shifts'); },
        }));
        return;
    }
    if (tab === 'orders') {
        // MAR_IN_CABINET_V1 — владелец: «#mar-sheet we actually dont need that.
        // only in the cabinet. the graph». Здесь стоит САМ ЛИСТ — та же сетка
        // «назначение × час», а не её пересказ списком: два вида одного лечения
        // расходятся, и лечить начинают по тому, который врёт. Поздний импорт —
        // потому что лист тянет карточку госпитализации, а та тянет этот экран.
        const host = h('div');
        box.appendChild(host);
        import('./mar-sheet.js?v=inp5').then(({ renderMarSheet, canOpenMarSheet }) => {
            // ПРАВО ТО ЖЕ, что и у отдельного адреса. Историю болезни открывает
            // более широкий круг (регистратура тоже), и показать ей сетку с
            // кнопками «назначить» и «отметить дозу» значило бы расширить доступ
            // молча — сервер-то откажет, но узнается это после нажатия.
            if (!canOpenMarSheet()) {
                host.appendChild(h('section', { class: 'card cf-pane' },
                    h('div', { class: 'cf-row-m' },
                        tr('Лист назначений ведут врачи и медсёстры отделения.'))));
                return;
            }
            renderMarSheet(host, {
                payload: { admissionId: state.admissionId },
                embedded: true,
                onNavigate,
            });
        });
        return;
    }
    if (tab === 'exams') {
        box.appendChild(caseExamsPanel(state.admissionId, {
            charges: state.charges,
            // ACT_ADD_SERVICE_V1 — анализ и диагностика выбираются из СПРАВОЧНИКА
            // услуг: цену, название и раздел знает он.
            onAdd: () => addAdmissionService(root, onNavigate, {
                title: 'Анализы и диагностика',
                /* i18n-exempt-start: куски названий РАЗДЕЛОВ справочника, а не текст экрана */
                types: ['лаборатор', 'диагностик', 'лучев', 'lab', 'imaging', 'radiolog', 'diagnost'],
                /* i18n-exempt-end */
            }),
        }));
        return;
    }
    if (tab === 'act') {
        box.appendChild(caseActPanel(state.admissionId, {
            // Счёт выставляет ТОТ ЖЕ вызов, что и касса: своя вторая сборка
            // счёта разошлась бы с кассовой на первой же скидке.
            // ACT_TABLE_V1 — строки выбирает КАССА галочками; без выбора счёт
            // выставляется на всё невыставленное, как и раньше.
            onInvoice: async (reload, picked) => {
                let ids = picked;
                if (!ids) {
                    const { data, error } = await supabase.rpc('admission_charges', { admission_id: state.admissionId });
                    if (error) { toast(error.message || tr('Акт не загрузился.'), 'fail'); return; }
                    ids = ((data && data.lines) || []).filter((l) => l.billable && !l.invoice_id).map((l) => l.id);
                }
                if (!ids.length) { toast(tr('Выставлять нечего: всё уже в счетах.'), 'fail'); return; }
                const res = await supabase.rpc('create_invoice_for_admission',
                    { admission_id: state.admissionId, admission_service_ids: ids });
                if (res.error) { toast(res.error.message || tr('Счёт не выставлен.'), 'fail'); return; }
                const no = (res.data && (res.data.invoice_number || (res.data.invoice && res.data.invoice.invoice_number))) || '';
                toast(no ? trf('Счёт {no} передан в кассу.', { no }) : tr('Счёт передан в кассу.'), 'ok');
                await reload();
            },
            // Печать реестра — ОБЩИМ механизмом приложения, тем же, что печатает
            // документы: свой второй принтер уже однажды разошёлся с этим.
            onPrint: async (data) => {
                const { printableSheet } = await import('./doc-settings.js?v=noqr1');
                printableSheet({
                    type: 'case_doc',
                    bodyHtml: actPrintBody(data),
                    head: {
                        title: tr('Акт выполненных работ'),
                        ids: docHeadIds(state.admission),
                        fields: docHeadFields(state.admission),
                    },
                });
            },
            onAddExpense: async (reload) => {
                // Расход списывается СО СКЛАДА тем же окном, что и везде:
                // остаток, партия и цена — его забота, а не этого экрана.
                const { openItemPickerModal } = await import('./item-picker-modal.js?v=billoptin1');
                openItemPickerModal({
                    title: tr('Добавить расход'), confirmLabel: tr('Списать'),
                    onConfirm: async (lines) => {
                        let ok = 0; const fails = [];
                        for (const { item, qty } of lines) {
                            try {
                                const { error } = await supabase.rpc('dispense_admission_item',
                                    { p_admission_id: state.admissionId, p_item_id: item.id, p_qty: Number(qty) });
                                if (error) throw error;
                                ok += 1;
                            } catch (e) { fails.push((item.name || '') + ': ' + ((e && e.message) || e)); }
                        }
                        await reload();
                        // Окно закрывается только при успехе: ошибка на складе —
                        // это разговор с кладовщиком, а не «нажмите ещё раз».
                        if (!ok) throw new Error(fails[0] || tr('Не удалось списать расход.'));
                        toast(trf('Списано позиций: {n}', { n: ok }), 'ok');
                        if (fails.length) toast(fails.join('; '), 'fail');
                    },
                });
            },
        }));
        return;
    }
    if (tab === 'surgery') {
        box.appendChild(caseSurgeryPanel(state.overview, state.docs, {
            charges: state.charges,
            onAdd: () => addAdmissionService(root, onNavigate, {
                title: 'Операция',
                /* i18n-exempt-start: куски названий РАЗДЕЛОВ справочника, а не текст экрана */
                types: ['хирург', 'surg'],
                /* i18n-exempt-end */
            }),
            // Документ операции открывается ТАМ, где документы и пишут: вкладка
            // переключается сама, иначе «Открыть» означало бы разное в разных
            // местах экрана.
            onDoc: (kind, mode, reviewId, docTitle) => {
                state.tab = 'documents';
                state.open = { kind, mode: mode || 'edit', reviewId: reviewId || null, title: docTitle || '' };
                paint(root, onNavigate);
            },
        }));
    }
}

/**
 * Задать колонкам ровно ту высоту, что осталась от экрана под ними.
 * @returns {() => void} отменить слежение
 */
function fitColumns(grid) {
    if (!grid || !grid.getBoundingClientRect) return () => {};
    const apply = () => {
        if (grid.isConnected === false) return;
        const top = grid.getBoundingClientRect().top;
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
        if (!vh) return;
        // Нижнее поле экрана — то же, что у области содержимого.
        const h2 = Math.max(320, Math.round(vh - top - 24));
        grid.style.setProperty('--cw-fit', h2 + 'px');
    };
    apply();
    const timers = [setTimeout(apply, 120), setTimeout(apply, 600)];
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', apply);
    return () => {
        for (const t of timers) clearTimeout(t);
        if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('resize', apply);
    };
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
        // CASE_DX_EVERYWHERE_V1 — панель спрашивает диагноз у КАРТОЧКИ СЛЕВА, а
        // не помнит свой: карточка — владелец значения, панель только вставляет.
        diagnosisNow: () => {
            const ed = state.editor;
            return (ed && ed.diagnosisInput && ed.diagnosisInput.value) || '';
        },
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
        // CASE_FILE_QUIET_V1 — рамка вокруг одной фразы «диагноза ещё нет» —
        // это карточка ни о чём. Возвращаем строку, а не карточку: место в
        // колонке достаётся списку документов.
        return h('div', { class: 'cw-dx-none' }, tr('Диагноз ещё не установлен — его пишут в первичном осмотре.'));
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
    // CASE_DOC_SET_INLINE_V1 — состав набора правится В САМОМ СПИСКЕ: «−» у
    // строки убирает документ, поле внизу заводит новый. Отдельная панель под
    // списком перечисляла те же документы теми же словами — один список в
    // колонке дважды (владелец: «there is duplication of the cards»).
    const mayEditSet = canEditDocSet();
    const reloadAll = async () => { await load(); paint(root, onNavigate); };
    list.appendChild(caseDocsView({
        state: state.docs,
        // Документ ОТКРЫВАЕТСЯ СПРАВА, а не окном поверх: в этом и была вся
        // задача. Выбранный шаг остаётся виден в списке слева.
        onDoc: (kind, mode, reviewId, docTitle) => {
            state.open = { kind, mode: mode || 'edit', reviewId: reviewId || null, title: docTitle || '' };
            paintPane(rail.parentNode.querySelector('.cw-pane'), root, onNavigate);
            paintRail(rail, root, onNavigate);
        },
        // Сборка — не шаг регламента, поэтому и не строка списка: она стоит
        // отдельной кнопкой ПОД списком (assembleFor).
        onAssemble: null,
        activeKind: state.open ? state.open.kind : null,
        onDrop: mayEditSet ? async (kind, name) => { if (await caseDocSetDrop(kind, name)) await reloadAll(); } : null,
        onAdd: mayEditSet ? async (title) => { if (await caseDocSetAdd(title)) await reloadAll(); } : null,
        types: state.types || [],
        onRestore: mayEditSet ? async (kind, name) => { if (await caseDocSetRestore(kind, name)) await reloadAll(); } : null,
        onRename: mayEditSet ? async (kind, title) => { if (await caseDocSetRename(kind, title)) await reloadAll(); } : null,
        onDelete: mayEditSet ? async (kind, name) => { if (await caseDocSetDelete(kind, name)) await reloadAll(); } : null,
    }));
    rail.appendChild(assembleFor(root, onNavigate));
}

/** Полных лет на сегодня — или null, если даты рождения нет. */
function ageYears(dob) {
    if (!dob) return null;
    const d = new Date(dob);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    let n = now.getFullYear() - d.getFullYear();
    const before = now.getMonth() < d.getMonth()
        || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
    if (before) n -= 1;
    return n >= 0 && n < 130 ? n : null;
}

// A4_LETTERHEAD_V2 / CASE_DOC_PRINT_V4 — номера и реквизиты шапки собирает
// case-doc-a4.js: экран и печать обязаны называть пациента одинаково, а две
// копии одного списка расходятся молча.
const docIds = () => docHeadIds(state.admission);
const docFields = () => docHeadFields(state.admission);

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
            // CASE_DOC_OWN_NAME_V1 — имя своего документа знает только чек-лист.
            docTitle: state.open.title || '',
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
    // A4_ONE_TEMPLATE_V1 — панель форматирования стоит СВОЕЙ ПОЛОСОЙ над листом,
    // тем же слотом, что в кабинете врача (.a4-toolbar-slot): один инструмент —
    // одно место, где его ищут.
    const card = h('div', { class: 'cw-doc a4-scroll' },
        // CASE_DOC_ACTIONS_V1 — в слоте над листом стоят ДЕЙСТВИЯ документа
        // (заготовка, печать, черновик, сохранить), а не панель форматирования.
        h('div', { class: 'a4-toolbar-slot' }, docActionsBar(ed)),
        ed.noLetterhead
            // FORM_003_V1 — у бланка 003 своя шапка (министерство, учреждение, приказ).
            ? h('div', { class: 'a4-paper f3-paper' },
                h('div', { class: 'cw-doc-body f3' }, ...ed.fields.filter(Boolean)))
            : a4Sheet({ title: ed.title, ids: docIds(), fields: docFields(), children: [
                h('div', { class: 'cw-doc-body' }, ...ed.fields.filter(Boolean)),
            ] }),
        // TITLE_SHEET_PAPERS_OUT_V1 — то, что относится к документу, но им не
        // является: отдельные бумаги, пульты, отметки. Стоит ПОД листом, как и
        // кнопки действий, и в расчёт разрывов страниц не попадает.
        ...((ed.belowSheet || []).filter(Boolean)),
    );

    // CASE_DOC_ACTIONS_V1 — «Черновик» и «Сохранить» переехали НАВЕРХ, в полосу
    // действий: две одинаковые пары кнопок (сверху и под листом) означали бы,
    // что они разные.
    pane.appendChild(card);

    // A4_PAGINATE_V1 — владелец: «treat every document as a a4 list, with real
    // ui breaks in the window of user». Разрывы считаются по высоте блоков и
    // пересчитываются, пока врач пишет.
    if (state.disposePagination) { try { state.disposePagination(); } catch (e) { /* нечего отменять */ } }
    // FORM_003_ONE_PAGE_V1 — у бланка утверждённой формы страниц не бывает
    // больше одной: он не растёт, он подгоняется. У остальных документов
    // наоборот — сколько написали, столько страниц.
    state.disposePagination = ed.onePage
        ? setupA4Fit(card)
        : setupA4Pagination(card, { label: (pg) => trf('Страница {n}', { n: pg }) });
}

export function resetCaseWorkspace() { reset(null); }
