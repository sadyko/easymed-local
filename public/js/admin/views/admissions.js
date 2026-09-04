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
//   «Ждут первичного осмотра» (admitted)        — кого не осмотрел главный врач.
// Один список с колонкой «статус» отвечал бы на них хуже всех трёх сразу:
// работа смены — не отчёт.
//
// Состояния и подписи берутся из ОДНОГО источника (shared/admission-status.js),
// который пишет сервер: расходиться экрану и базе в том, что значит «лежит»,
// нельзя (см. шапку того файла).

import { supabase } from '../../supabase.js';
import { IN_BED_STATUSES, OPEN_STATUSES, admissionStatusLabel } from '../../shared/admission-status.js';
import { h, Icon, Tag, clear, PageHead, fmtDateTime, initials } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { isModuleAllowed } from '../permissions.js';
import { openAdmissionOrderModal, openAdmissionBedPicker, openAdmissionCancelModal, openAdmissionCard } from './admission-modal.js?v=inp2';

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

export async function renderAdmissions(container) {
    clear(container);
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);
    await paint(root);
}

async function load() {
    const { data, error } = await supabase.from('admissions')
        .select('*, patients(mrn, full_name, phone), wards(name), beds(code), users(full_name)')
        .in('status', OPEN_STATUSES)
        .order('id', { ascending: false })
        .limit(500);
    if (error) throw error;
    return data || [];
}

async function paint(root) {
    clear(root);
    const reload = () => paint(root);

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
        root.appendChild(h('div', { class: 'card', style: { padding: '18px' } },
            h('div', { class: 'empty' }, trf('Не удалось загрузить: {msg}', { msg: (e && e.message) || e }))));
        return;
    }

    const waitingBed  = rows.filter((r) => r.status === 'ordered');
    const inWard      = rows.filter((r) => IN_BED_STATUSES.includes(r.status));
    const waitingExam = rows.filter((r) => r.status === 'admitted');

    const grid = h('div', { style: { display: 'grid', gap: '16px' } });
    grid.appendChild(waitingBedCard(waitingBed, reload));
    grid.appendChild(inWardCard(inWard, reload));
    grid.appendChild(waitingExamCard(waitingExam, reload));
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
function waitingBedCard(list, reload) {
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
        ], () => openAdmissionCard({ admissionId: a.id, onChange: reload }));
    });
    return listCard(tr('Ждут размещения'), 'Clock', list.length,
        tr('Заявки регистратуры и направления врачей. Койка занимается только здесь.'),
        els, tr('Заявок нет — никого не ждут.'));
}

// ---------------------------------------------------------------------------
// 2. «В отделении» — кто лежит, по палатам
// ---------------------------------------------------------------------------
function inWardCard(list, reload) {
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
                a.users && a.users.full_name ? a.users.full_name : null,
            ].filter(Boolean).join(' · ');
            els.push(patientRow(a, meta, [
                // Подпись состояния — из общей карты (shared/admission-status.js).
                // Именно её отсутствие и делало заявку «Отменено» на прежнем
                // экране: подпись собиралась на месте и знала не все состояния.
                Tag(tr(admissionStatusLabel(a.status)), { kind: 'ok', dot: true }),
            ], () => openAdmissionCard({ admissionId: a.id, onChange: reload })));
        }
    }
    return listCard(tr('В отделении'), 'Bed', list.length,
        tr('Пациенты на койках: за них идёт суточное начисление.'),
        els, tr('В отделении никого нет.'));
}

// ---------------------------------------------------------------------------
// 3. «Ждут первичного осмотра»
// ---------------------------------------------------------------------------
function waitingExamCard(list, reload) {
    const els = list.map((a) => {
        const p = a.patients || {};
        const meta = [
            p.mrn || null,
            (a.wards && a.wards.name) || null,
            a.beds && a.beds.code ? trf('койка {code}', { code: a.beds.code }) : null,
            a.admitted_at ? trf('на койке {since}', { since: sinceLabel(a.admitted_at) || '—' }) : null,
        ].filter(Boolean).join(' · ');
        return patientRow(a, meta, [
            Tag(tr('Ждёт главного врача'), { kind: 'warn', dot: true }),
        ], () => openAdmissionCard({ admissionId: a.id, onChange: reload }));
    });
    return listCard(tr('Ждут первичного осмотра'), 'Stethoscope', list.length,
        tr('Осмотр проводит главный врач: до него лечащего врача и назначений нет.'),
        els, tr('Все осмотрены.'));
}
