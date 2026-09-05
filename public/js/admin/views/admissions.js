// ADMISSION_ORDER_V1 — «Стационар»: окно медсестры (Задача 2 плана
// docs/plans/2026-09-04-inpatient-workflow.md).
//
// ─── ЗАЧЕМ ЭТОТ ЭКРАН ВООБЩЕ ПОЯВИЛСЯ ───────────────────────────────────────
// Заявка на госпитализацию существовала и до него: врач оформлял её из кабинета
// (`request_admission`), окно обещало «Заявка появится в стационаре для
// оформления» — и НЕ ПОЯВЛЯЛАСЬ НИГДЕ. Доска коек грузила госпитализации
// «в койке», а у заявки койки нет по определению; вкладка «Госпитализации»
// показывала историю, где заявку было не отличить от отменённой. Обещание в
// окне врача не было ложью — экрана, который его выполняет, просто не
// существовало. Это он.
//
// ─── ПОЧЕМУ ПАЦИЕНТ — ЯКОРЬ ─────────────────────────────────────────────────
// «Ошибка "не тот пациент" — то, против чего построен экран медсестры»
// (раздел «Ловушки» плана). Отсюда правило раскладки, а не украшение: ИМЯ
// ПАЦИЕНТА — САМОЕ КРУПНОЕ НА СТРОКЕ, крупнее номера койки, палаты, времени и
// названия действия. Медсестра ведёт пальцем по именам; всё остальное —
// подпись под именем. Порядок в строке тот же: сначала «кто», потом «где»,
// потом «что сделать».
//
// ─── ТРИ СПИСКА, А НЕ ОДНА ТАБЛИЦА ──────────────────────────────────────────
// Каждый отвечает на свой вопрос смены:
//   «Ждут размещения»        (ordered)          — кого положить прямо сейчас;
//   «В отделении»            (в койке, по палатам) — кто у меня лежит;
//   «Ждут первичного осмотра» (admitted)        — кого не осмотрел главный врач;
//   «Ждут лечащего врача»     (examined)         — кто осмотрен, но не лечится.
// Один список с колонкой «статус» отвечал бы на них хуже всех четырёх сразу:
// работа смены — не отчёт.
//
// ЧЕТВЁРТАЯ ОЧЕРЕДЬ ПОЯВИЛАСЬ ВМЕСТЕ С ОСМОТРОМ (Задача 3) и не для симметрии.
// Между «осмотрен» и «лечится» стоит отдельное решение главного врача — кто
// ведёт пациента; пока оно не принято, у пациента нет ни назначений, ни стола,
// а суточное за койку уже идёт. Не показать этих людей отдельным списком
// значило бы спрятать единственное состояние маршрута, в котором пациент лежит
// и НЕ лечится.
//
// Состояния и подписи берутся из ОДНОГО источника (shared/admission-status.js),
// который пишет сервер: расходиться экрану и базе в том, что значит «лежит»,
// нельзя (см. шапку того файла).
//
// ─── INPATIENT_ONE_SECTION_V1 (2026-09-05) — И ХОСТ РАЗДЕЛА ТОЖЕ ЗДЕСЬ ───────
// Владелец: «the stationary requests: #admissions / #beds — i guess it should
// be in one section». Ниже, после очередей, живёт renderInpatient() — полоса
// вкладок раздела «Стационар» и три её лица. Почему именно три и почему хост
// лежит в этом файле — в шапке над ним.

import { supabase } from '../../supabase.js';
import { IN_BED_STATUSES, OPEN_STATUSES, admissionStatusLabel } from '../../shared/admission-status.js';
import { h, Icon, Tag, clear, PageHead, fmtDateTime, initials } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { isModuleAllowed } from '../permissions.js';
import { openAdmissionOrderModal, openAdmissionBedPicker, openAdmissionCancelModal, openAdmissionCard,
         openAdmissionReviewModal, openAdmissionAttendingModal, goToMarSheet } from './admission-modal.js?v=inp5';
// Те же адреса модулей, что у admin.js: одна строка импорта — один экземпляр
// модуля (у ward-beds.js есть свой `state`, и второй экземпляр развёл бы
// фильтры доски на две копии).
import { renderWardBeds, admissionsHistoryCard } from './ward-beds.js?v=board4';
// MOTION_REVEAL_V1 — переход между вкладками: панель проявляется, полоса
// вкладок возвращается в поле зрения. Общий помощник, не свой на экран.
import { animateIn, smoothScrollTo } from '../motion.js?v=mo1';

// Раздел живёт под ключом `beds` («Стационар и палаты»): окно медсестры и доска
// коек — две стороны одной работы, и раздавать их порознь значило бы выдать
// медсестре право класть на койку и не дать увидеть, свободна ли она.
// Миграция 092 выдаёт этот ключ медсестре, старшей медсестре, главному врачу и
// регистратуре; permissions.js признаёт 'admissions' синонимом 'beds'
// (тот же приём, что у 'cashier-shifts' → 'cashier').
export function canOpenAdmissions() {
    return isModuleAllowed('admissions');
}

const TYPE_LABEL = { planned: 'Плановая', emergency: 'Экстренная' };
const MODE_LABEL = { round: 'Круглосуточно', day: 'Дневной стационар' };

function sinceLabel(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return null;
    const hours = Math.floor(ms / 3600000);
    if (hours < 1) return trf('{n} мин назад', { n: Math.max(1, Math.floor(ms / 60000)) });
    if (hours < 48) return trf('{n} ч назад', { n: hours });
    return trf('{n} сут назад', { n: Math.floor(hours / 24) });
}

/**
 * Очереди смены — первая вкладка раздела «Стационар».
 *
 * Своя шапка у неё ОСТАЁТСЯ, хотя раздел уже назван сверху: имя из неё снимает
 * оболочка (ONE_NAME_PER_SCREEN_V1, dedupeSectionHeading в admin.js), а
 * подзаголовок и две кнопки — «Обновить» и «Заявка на госпитализацию» — это
 * работа, а не украшение заголовка. Снимать шапку здесь руками значило бы
 * заводить второй механизм против дубля рядом с тем, который уже есть и уже
 * проверен тестом.
 */
export async function renderAdmissions(container, ctx = {}) {
    clear(container);
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);
    await paint(root, ctx.onNavigate || null);
}

async function load() {
    const { data, error } = await supabase.from('admissions')
        // КТО ОСМОТРЕЛ и КТО ЛЕЧИТ — два разных JOIN'а на users в той же строке
        // (алиасные embed'ы реестра): очередь обязана называть лечащего врача,
        // иначе «в отделении» отвечает «где пациент» и молчит о том, к кому идти.
        //
        // ADMISSION_EMBED_FIX (2026-09-05) — здесь стояло `patients(mrn,
        // full_name, phone)`, и из-за одного лишнего слова раздел «Стационар»
        // НЕ ОТКРЫВАЛСЯ НИ У КОГО с самого первого дня (a8bea2d). Реестр
        // (server/db/schema-registry.js) разрешает у этого embed'а ровно
        // ['id','mrn','full_name'], а компилятор на неразрешённое поле отвечает
        // не «пропущу», а отказом всему запросу: `unknown embed column`, 400
        // (query-compiler.js, «if (!embed.columns.includes(sub)) throw»).
        // load() бросал, экран рисовал «Не удалось загрузить» — и три очереди
        // смены выглядели как пустой, сломанный раздел.
        //
        // Телефон здесь НЕ НУЖЕН: на строке очереди его никто не показывает
        // (см. patientRow ниже) — он был запрошен и ни разу не прочитан.
        // Поэтому лишнее слово снято, а не разрешено в реестре: соседние
        // экраны стационара (ward-beds.js, mar-sheet.js) спрашивают ровно
        // `patients(mrn, full_name)` и работали всегда.
        .select('*, patients(mrn, full_name), wards(name), beds(code), users(full_name), '
              + 'attending:attending_doctor_id(full_name), examined:examined_by(full_name)')
        .in('status', OPEN_STATUSES)
        .order('id', { ascending: false })
        .limit(500);
    if (error) throw error;
    return data || [];
}

async function paint(root, onNavigate = null) {
    clear(root);
    const reload = () => paint(root, onNavigate);

    // ЧТО ЭТОТ ЧЕЛОВЕК ВПРАВЕ ДЕЛАТЬ — спрашиваем СЕРВЕР, один раз на экран.
    // Матрица прав живёт в rpc/inpatient-flow.js, и вторая её копия здесь
    // разошлась бы с первой в тот день, когда матрицу поправят: кнопка
    // «Провести первичный осмотр» появилась бы у того, кому сервер откажет, —
    // или, что хуже, пропала бы у того, кто вправе. По строке спрашивать
    // нельзя: право на шаг зависит от роли, а не от пациента, и это были бы
    // десятки одинаковых запросов на один список.
    let can = {};
    try {
        const { data } = await supabase.rpc('inpatient_capabilities', {});
        can = (data && data.can) || {};
    } catch (e) { can = {}; }

    root.appendChild(PageHead({
        title: 'Стационар',
        subtitle: 'Заявки на госпитализацию, размещение на койках и очередь первичного осмотра',
        right: [
            h('button', { class: 'btn btn-sm', type: 'button', onclick: reload }, Icon('Refresh', { size: 13 }), ' ', tr('Обновить')),
            h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => openAdmissionOrderModal({ onDone: reload }),
            }, Icon('Plus', { size: 13 }), ' ', tr('Заявка на госпитализацию')),
        ],
    }));

    let rows;
    try { rows = await load(); }
    catch (e) {
        // ОТКАЗ — ЭТО НЕ ПУСТОТА. Раздел, упавший на запросе, выглядел ровно
        // как раздел без пациентов: одна серая строка. Владелец так и сообщил
        // — «заявки стационара недоступны», — и по экрану нельзя было
        // отличить «никого не ждут» от «экран сломан». Здесь сказано словами:
        // это сбой, вот причина, вот кнопка повторить.
        root.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
            h('div', { style: { fontSize: '15px', fontWeight: 700, color: 'var(--ink-900)', marginBottom: '6px' } },
                tr('Список госпитализаций не загрузился')),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginBottom: '14px' } },
                tr('Это сбой запроса, а не пустой отдел: заявки и пациенты на койках могут быть на месте.')),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '14px' } },
                trf('Причина: {msg}', { msg: (e && e.message) || String(e) })),
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: reload },
                Icon('Refresh', { size: 13 }), ' ', tr('Повторить загрузку'))));
        return;
    }

    const waitingBed  = rows.filter((r) => r.status === 'ordered');
    const inWard      = rows.filter((r) => IN_BED_STATUSES.includes(r.status));
    const waitingExam = rows.filter((r) => r.status === 'admitted');
    const waitingDoc  = rows.filter((r) => r.status === 'examined');

    const grid = h('div', { style: { display: 'grid', gap: '16px' } });
    grid.appendChild(waitingBedCard(waitingBed, reload, onNavigate));
    grid.appendChild(inWardCard(inWard, reload, onNavigate));
    grid.appendChild(waitingExamCard(waitingExam, reload, can, onNavigate));
    grid.appendChild(waitingAttendingCard(waitingDoc, reload, can, onNavigate));
    root.appendChild(grid);
}

// ---------------------------------------------------------------------------
// Строка пациента — общая форма всех трёх списков
// ---------------------------------------------------------------------------
// `meta` — подпись ПОД именем, `right` — действия. Имя рисуется здесь и только
// здесь, одним размером на весь экран: разъедься эти размеры по трём спискам,
// и «якорь» перестал бы быть якорем ровно в том списке, который забыли.
function patientRow(adm, meta, right, onOpen) {
    const p = adm.patients || {};
    const name = (p.full_name || '').trim() || tr('без имени');
    return h('div', {
        style: {
            display: 'flex', alignItems: 'center', gap: '14px',
            padding: '14px 16px', borderBottom: '1px solid var(--ink-100)',
        },
    },
        h('span', {
            style: {
                width: '44px', height: '44px', borderRadius: '999px', flex: '0 0 44px',
                background: 'var(--primary-600, #1f7a72)', color: '#fff',
                display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '15px',
            },
        }, initials(name)),
        h('button', {
            type: 'button',
            title: tr('Открыть карточку госпитализации'),
            onclick: () => onOpen && onOpen(),
            style: {
                flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent',
                border: '0', padding: '0', cursor: 'pointer', font: 'inherit',
            },
        },
            // ИМЯ — САМОЕ КРУПНОЕ НА СТРОКЕ. См. шапку файла: это защита от
            // «не того пациента», а не типографика.
            h('div', { style: { fontSize: '17px', fontWeight: 800, color: 'var(--ink-900)', lineHeight: 1.25 } }, name),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '3px' } }, meta)),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none', flexWrap: 'wrap' } }, ...right.filter(Boolean)),
    );
}

function listCard(title, icon, count, hint, rowsEls, emptyText) {
    const card = h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon(icon, { size: 16 }), ' ', title),
            h('span', { class: 'grow', style: { flex: 1 } }),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, trf('пациентов: {n}', { n: count }))),
        hint ? h('div', { class: 'muted', style: { padding: '0 16px 8px', fontSize: '12.5px' } }, hint) : null,
    );
    if (!rowsEls.length) {
        card.appendChild(h('div', { class: 'empty', style: { padding: '26px' } }, emptyText));
        return card;
    }
    for (const el of rowsEls) card.appendChild(el);
    return card;
}

// ---------------------------------------------------------------------------
// 1. «Ждут размещения» — заявки
// ---------------------------------------------------------------------------
function waitingBedCard(list, reload, onNavigate) {
    const els = list.map((a) => {
        const p = a.patients || {};
        const meta = [
            p.mrn || null,
            tr(TYPE_LABEL[a.admission_type] || TYPE_LABEL.planned),
            a.stay_mode === 'day' ? tr(MODE_LABEL.day) : null,
            a.department || (a.wards && a.wards.name) || null,
            a.planned_at ? trf('на {when}', { when: fmtDateTime(a.planned_at) }) : null,
            a.ordered_at ? sinceLabel(a.ordered_at) : null,
        ].filter(Boolean).join(' · ');
        // Экстренная заявка не должна теряться среди плановых: она красная и
        // называет себя словом, а не оттенком строки — оттенок не читается на
        // проекторе поста медсестры.
        const flag = a.admission_type === 'emergency' ? Tag(tr('Экстренная'), { kind: 'crit', dot: true }) : null;
        return patientRow(a, meta, [
            flag,
            h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => openAdmissionBedPicker({ admission: a, onDone: reload }),
            }, Icon('Bed', { size: 13 }), ' ', tr('Положить на койку')),
            h('button', {
                class: 'btn btn-sm', type: 'button',
                onclick: () => openAdmissionCancelModal({ admission: a, onDone: reload }),
            }, tr('Отменить')),
        ], () => openAdmissionCard({ admissionId: a.id, onChange: reload, onNavigate }));
    });
    return listCard(tr('Ждут размещения'), 'Clock', list.length,
        tr('Заявки регистратуры и направления врачей. Койка занимается только здесь.'),
        els, tr('Заявок нет — никого не ждут.'));
}

// ---------------------------------------------------------------------------
// 2. «В отделении» — кто лежит, по палатам
// ---------------------------------------------------------------------------
function inWardCard(list, reload, onNavigate) {
    const byWard = new Map();
    for (const a of list) {
        const key = (a.wards && a.wards.name) || tr('Без палаты');
        if (!byWard.has(key)) byWard.set(key, []);
        byWard.get(key).push(a);
    }
    const els = [];
    for (const [wardName, wardRows] of [...byWard.entries()].sort((x, y) => String(x[0]).localeCompare(String(y[0])))) {
        els.push(h('div', {
            style: {
                padding: '9px 16px', background: 'var(--ink-25, #f7f8fa)',
                borderBottom: '1px solid var(--ink-100)', fontSize: '12.5px', fontWeight: 700,
                color: 'var(--ink-700)', display: 'flex', gap: '8px', alignItems: 'center',
            },
        }, wardName, h('span', { class: 'muted', style: { fontWeight: 400 } }, trf('· коек занято: {n}', { n: wardRows.length }))));
        for (const a of wardRows) {
            const p = a.patients || {};
            const meta = [
                p.mrn || null,
                a.beds && a.beds.code ? trf('койка {code}', { code: a.beds.code }) : tr('койка не указана'),
                a.admitted_at ? sinceLabel(a.admitted_at) : null,
                // КТО ЛЕЧИТ — на строке, а не только в карточке. «Лечащий врач
                // не назначен» у лежащего пациента это не пустое поле, а
                // недоделанная работа отделения, и видно её должно быть отсюда.
                a.attending && a.attending.full_name
                    ? trf('лечащий: {name}', { name: a.attending.full_name })
                    : tr('лечащий врач не назначен'),
            ].filter(Boolean).join(' · ');
            els.push(patientRow(a, meta, [
                // Подпись состояния — из общей карты (shared/admission-status.js).
                // Именно её отсутствие и делало заявку «Отменено» на прежнем
                // экране: подпись собиралась на месте и знала не все состояния.
                Tag(tr(admissionStatusLabel(a.status)), { kind: 'ok', dot: true }),
                // MAR_SHEET_V1 — лист назначений СО СТРОКИ, а не только из
                // карточки: во время обхода к нему возвращаются чаще, чем ко
                // всему остальному в окне госпитализации.
                (a.status === 'active' || a.status === 'discharging')
                    ? h('button', {
                        class: 'btn btn-sm', type: 'button',
                        onclick: (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); goToMarSheet(a.id, onNavigate); },
                    }, Icon('Pill', { size: 13 }), ' ', tr('Лист назначений'))
                    : null,
            ], () => openAdmissionCard({ admissionId: a.id, onChange: reload, onNavigate })));
        }
    }
    return listCard(tr('В отделении'), 'Bed', list.length,
        tr('Пациенты на койках: за них идёт суточное начисление.'),
        els, tr('В отделении никого нет.'));
}

// ---------------------------------------------------------------------------
// 3. «Ждут первичного осмотра»
// ---------------------------------------------------------------------------
// Кнопка осмотра видна ТОЛЬКО тому, кто вправе её нажать (can.examine — ответ
// сервера, см. paint). Обычный врач её не видит, и это не косметика: первичный
// осмотр проводит главный врач, а кнопка, которая ответит отказом, отправляет
// человека в тупик вместо того, чтобы сказать, кого звать.
function waitingExamCard(list, reload, can, onNavigate) {
    const els = list.map((a) => {
        const p = a.patients || {};
        const meta = [
            p.mrn || null,
            (a.wards && a.wards.name) || null,
            a.beds && a.beds.code ? trf('койка {code}', { code: a.beds.code }) : null,
            a.admitted_at ? trf('на койке {since}', { since: sinceLabel(a.admitted_at) || '—' }) : null,
        ].filter(Boolean).join(' · ');
        return patientRow(a, meta, [
            can.examine
                ? h('button', {
                    class: 'btn btn-primary btn-sm', type: 'button',
                    onclick: () => openAdmissionReviewModal({ admission: a, onDone: reload }),
                }, Icon('Stethoscope', { size: 13 }), ' ', tr('Провести первичный осмотр'))
                : Tag(tr('Ждёт главного врача'), { kind: 'warn', dot: true }),
        ], () => openAdmissionCard({ admissionId: a.id, onChange: reload, onNavigate }));
    });
    return listCard(tr('Ждут первичного осмотра'), 'Stethoscope', list.length,
        tr('Осмотр проводит главный врач: до него лечащего врача и назначений нет.'),
        els, tr('Все осмотрены.'));
}

// ---------------------------------------------------------------------------
// 4. «Ждут лечащего врача»
// ---------------------------------------------------------------------------
// Самое дорогое состояние маршрута: пациент осмотрен, койка занята, суточное
// начисление идёт — а лечения нет, потому что не назначен тот, кто его ведёт.
// Список существует затем, чтобы это не длилось сутки.
function waitingAttendingCard(list, reload, can, onNavigate) {
    const els = list.map((a) => {
        const p = a.patients || {};
        const meta = [
            p.mrn || null,
            (a.wards && a.wards.name) || null,
            a.beds && a.beds.code ? trf('койка {code}', { code: a.beds.code }) : null,
            a.examined && a.examined.full_name ? trf('осмотрел: {name}', { name: a.examined.full_name }) : null,
            a.examined_at ? trf('осмотрен {since}', { since: sinceLabel(a.examined_at) || '—' }) : null,
        ].filter(Boolean).join(' · ');
        return patientRow(a, meta, [
            can.set_attending
                ? h('button', {
                    class: 'btn btn-primary btn-sm', type: 'button',
                    onclick: () => openAdmissionAttendingModal({ admission: a, onDone: reload }),
                }, Icon('User', { size: 13 }), ' ', tr('Назначить лечащего врача'))
                : Tag(tr('Ждёт лечащего врача'), { kind: 'warn', dot: true }),
        ], () => openAdmissionCard({ admissionId: a.id, onChange: reload, onNavigate }));
    });
    return listCard(tr('Ждут лечащего врача'), 'User', list.length,
        tr('Осмотр проведён. Пока лечащий врач не назначен, назначений и стола у пациента нет.'),
        els, tr('У всех есть лечащий врач.'));
}

// ===========================================================================
// INPATIENT_ONE_SECTION_V1 — «Стационар» ОДНИМ РАЗДЕЛОМ
// ===========================================================================
// Владелец (2026-09-05): «the stationary requests: #admissions / #beds — i
// guess it should be in one section».
//
// Так и было: два пункта меню, «Inpatient ward» и «Ward & beds», на ОДНОМ
// ключе прав `beds` — то есть у кого есть один, у того всегда есть и второй.
// Два входа в одну работу, между которыми весь день ходили пешком: медсестра
// смотрела заявку в первом, свободную койку — во втором, и возвращалась.
// Пункт меню — это вопрос, на который раздел отвечает; здесь вопрос был один.
//
// ─── ПОЧЕМУ ВКЛАДОК ТРИ, А НЕ ДВЕ ───────────────────────────────────────────
// Очевидное деление — «заявки» и «койки». Но доска коек УЖЕ носила внутри себя
// сегментный переключатель «Койки / Госпитализации», и полоса вкладок над ним
// дала бы два переключателя на одном экране — ровно тот дубль, который
// владелец и просил убрать, только этажом ниже. Поэтому третье лицо поднято
// сюда, и вкладки отвечают на три РАЗНЫХ вопроса смены:
//
//   «Заявки»         — кого положить, кто лежит, кого не осмотрели, у кого нет
//                      лечащего врача. Работа, которую делают ПРЯМО СЕЙЧАС;
//                      здесь же оформляют новую заявку. Вкладка по умолчанию.
//   «Койки»          — коечный ФОНД: палаты, занятость, состояние койки,
//                      деньги и переводы по конкретной койке.
//   «Госпитализации» — ЖУРНАЛ: все, включая выписанных и отменённых, которых
//                      на доске нет по определению.
//
// ─── ПОЧЕМУ ХОСТ ЛЕЖИТ В ЭТОМ ФАЙЛЕ ─────────────────────────────────────────
// Раздел и его первая вкладка — одна и та же работа и один и тот же маршрут
// `admissions`; отдельный файл-хост здесь означал бы третий файл, который надо
// открыть, чтобы понять, из чего состоит «Стационар». Две другие вкладки
// остаются своими экранами в своих файлах — хост их только зовёт.
//
// ─── МАРШРУТ ────────────────────────────────────────────────────────────────
// Раздел живёт по СТАРОМУ адресу `#admissions`, а не по новому: у него уже
// есть пункт меню, крошка, ключ прав и перевод во всех трёх языках
// («Стационар» / «Statsionar» / «Inpatient ward»), и заводить рядом четвёртое
// имя значило бы переводить всё это заново ради того же слова. Вкладка живёт в
// адресе как '#admissions/beds' (договор HASH_SUBROUTE_V1, копия laboratory.js
// и patients-hub.js): payload.sub + history.replaceState +
// window.easymedSetTabSub, потому что адресной строки мало — следующий
// navigate() в раздел перепишет хеш из payload панели.
//
// Старый `#beds` цел: оболочка (LEGACY_ROUTES в admin.js) отвечает на него
// этим разделом, открытым на вкладке «Койки». Закладка ведёт туда же, куда
// вела, — просто теперь рядом видно и очередь.
//
// ─── ПРАВА ──────────────────────────────────────────────────────────────────
// У вкладок своего гейта нет, и это решение: три вкладки — ОДИН раздел, и
// открыть его вправе тот, кому выдан ключ `beds` (оболочка спрашивает
// isRouteAllowed('admissions') до нас, а permissions.js признаёт 'admissions'
// синонимом 'beds'). Отдельный ключ вкладке значил бы, что у КАЖДОЙ настроенной
// сегодня роли раздел молча недосчитается двух третей.
// ---------------------------------------------------------------------------

const TABS = [
    { id: 'orders',  label: 'Заявки',         icon: 'Clock' },
    { id: 'beds',    label: 'Койки',          icon: 'Bed'   },
    { id: 'history', label: 'Госпитализации', icon: 'Doc'   },
];
const DEFAULT_TAB = 'orders';

/**
 * Хост раздела «Стационар». `ctx` — то же, что оболочка даёт любому экрану:
 * { onNavigate, payload, tabId }. `payload.sub` называет вкладку.
 */
export async function renderInpatient(container, ctx = {}) {
    clear(container);
    const tabId = ctx.tabId || null;
    const sub = ctx.payload && ctx.payload.sub;

    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);

    // Полоса вкладок — те же .reg-tabs/.reg-tab, что у «Пациентов»: один язык
    // выделения на всю оболочку, а не свой на каждую полосу.
    const strip = h('div', { class: 'reg-tabs', role: 'tablist', 'aria-label': tr('Стационар') });
    const buttons = {};
    const hosts = {};
    for (const t of TABS) {
        hosts[t.id] = h('div', {
            id: 'inp-panel-' + t.id, role: 'tabpanel',
            'aria-labelledby': 'inp-tab-' + t.id, 'data-tab-panel': t.id,
            style: { display: 'none' },
        });
        buttons[t.id] = h('button', {
            class: 'reg-tab', type: 'button', role: 'tab',
            id: 'inp-tab-' + t.id, 'aria-controls': 'inp-panel-' + t.id,
            'aria-selected': 'false', tabindex: '-1', 'data-tab': t.id,
            onclick: () => { select(t.id); },
            onkeydown: (ev) => moveByKey(ev, t.id),
        }, Icon(t.icon, { size: 14 }), h('span', null, tr(t.label)));
        strip.appendChild(buttons[t.id]);
    }
    root.appendChild(strip);
    for (const t of TABS) root.appendChild(hosts[t.id]);

    let active = TABS.some((t) => t.id === sub) ? sub : DEFAULT_TAB;
    // Два быстрых нажатия по разным вкладкам не должны дорисовать первую поверх
    // второй: доска и очереди грузятся запросом, и опоздавший ответ рисовал бы
    // в панель, которую уже переключили.
    let mountSeq = 0;

    // Полоса объявлена как tablist, а в tablist по стрелкам ходят: из порядка
    // обхода Tab вынуты все кнопки, кроме активной, и без этого обработчика до
    // двух вкладок из трёх нельзя было бы добраться с клавиатуры вовсе.
    function moveByKey(ev, id) {
        const key = ev && ev.key;
        const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
        let next = null;
        if (step) {
            const i = TABS.findIndex((t) => t.id === id);
            next = TABS[(i + step + TABS.length) % TABS.length];
        } else if (key === 'Home') next = TABS[0];
        else if (key === 'End') next = TABS[TABS.length - 1];
        if (!next) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        select(next.id);
        buttons[next.id].focus();
    }

    function paintStrip({ animate = false } = {}) {
        for (const t of TABS) {
            const on = t.id === active;
            const b = buttons[t.id];
            b.className = 'reg-tab' + (on ? ' on' : '');
            b.setAttribute('aria-selected', on ? 'true' : 'false');
            b.setAttribute('tabindex', on ? '0' : '-1');
            hosts[t.id].style.display = on ? '' : 'none';
            if (on && animate) animateIn(hosts[t.id]);
        }
    }

    // URL отражает состояние: вкладка лежит в адресе, поэтому F5 её сохраняет,
    // а ссылку можно отдать коллеге. replaceState, а не pushState — переход
    // между вкладками одного раздела не новое место в истории.
    function syncSubUrl() {
        try {
            const nextSub = active === DEFAULT_TAB ? null : active;
            if (typeof history !== 'undefined' && history.replaceState) {
                history.replaceState({ view: 'admissions', payload: nextSub ? { sub: nextSub } : null },
                    '', '#admissions' + (nextSub ? '/' + nextSub : ''));
            }
            // Оболочке — тоже: адресной строки мало, потому что navigate()
            // перепишет хеш из payload ПАНЕЛИ, когда в раздел зайдут снова.
            if (typeof window !== 'undefined' && typeof window.easymedSetTabSub === 'function') {
                window.easymedSetTabSub(tabId, nextSub);
            }
        } catch (e) {
            // Браузер в жёстком режиме может отказать в записи истории. Вкладки
            // продолжают работать, просто перестают быть ссылками.
        }
    }

    // ВКЛАДКА ПЕРЕЧИТЫВАЕТСЯ ПРИ КАЖДОМ ПОКАЗЕ, а не монтируется один раз, как
    // у «Пациентов». Довод один и он несущий: положив пациента на койку на
    // вкладке «Заявки», человек тут же переходит на «Койки» — и обязан увидеть
    // там ЗАНЯТУЮ койку, а не ту, что была свободна минуту назад. Сохранять
    // здесь нечего: ни у очередей, ни у журнала нет ни поиска, ни страницы, ни
    // наполовину введённой формы.
    async function mount(id) {
        const seq = ++mountSeq;
        const host = hosts[id];
        try {
            if (id === 'orders') {
                await renderAdmissions(host, { onNavigate: ctx.onNavigate });
            } else if (id === 'beds') {
                await renderWardBeds(host, { onNavigate: ctx.onNavigate, embedded: true });
            } else {
                clear(host);
                host.appendChild(await admissionsHistoryCard());
            }
        } catch (e) {
            // Вкладка обязана СМОНТИРОВАТЬСЯ в любом случае и сказать словами,
            // что именно недоступно: пустая вкладка без объяснения читается как
            // сломанная программа, а исключение отсюда унесло бы весь раздел.
            if (seq !== mountSeq) return;
            clear(host);
            host.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
                h('div', { style: { fontSize: '15px', fontWeight: 700, color: 'var(--ink-900)', marginBottom: '6px' } },
                    tr('Список госпитализаций не загрузился')),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    trf('Причина: {msg}', { msg: (e && e.message) || String(e) }))));
        }
    }

    async function select(id, { initial = false } = {}) {
        if (!TABS.some((t) => t.id === id)) id = DEFAULT_TAB;
        if (!initial && id === active) return;
        active = id;
        paintStrip({ animate: !initial });
        // Вкладку переключили из середины длинного списка — полоса вкладок
        // обязана снова оказаться на глазах.
        if (!initial) smoothScrollTo(strip, { block: 'start' });
        if (!initial) syncSubUrl();
        await mount(id);
    }

    await select(active, { initial: true });

    return { activeTab: () => active, select };
}
