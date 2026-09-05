// LAB_GROUP_V1 (local port) — pure, DOM-free helpers behind the patient-
// grouped laboratory queue. No supabase, no DOM: safe to unit test directly.
//
// Ported from the production LIS (easymed.uz laboratory.js — pluralRu ~527,
// the paintList grouping block ~658-673). The grouping rule is identical:
// one card per patient-VISIT, keyed by visit_id, falling back to
// '_solo_' + id for an order with no visit.

import { originTag } from '../record-origin.js';   // LAB_ONE_CLINIC_V1 — тоже чистый модуль

// Russian plural-form picker: 1 анализ / 2 анализа / 5 анализов.
export function pluralRu(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}

// Group visit_services rows into one card per patient-visit.
//
//   rows       — visit_services rows (each has .id, .visit_id, .services{}).
//   patientMap — visit_id -> { visit_date, patient } (laboratory.js state shape).
//   accessionOf — optional (row) -> string, used to stamp a representative
//                 accession number on the group (the group's first row's
//                 accession, same convention the server uses).
//
// Returns an array of groups, in first-seen order:
//   { key, visitId, patientId, patientName, patientMrn, patientSex,
//     patientDob, accession, originLetter, rows: [visit_services row, ...] }
//
// LAB_ONE_CLINIC_V1 — originLetter: буква филиала, в котором заказ ЗАВЕДЁН
// (record-origin.js, колонка sync_origin), или null для своей работы. Когда
// лаборатория обслуживает всю клинику, в одной очереди стоят пробирки разных
// зданий, и лаборант обязан видеть, где пациента регистрировали, — иначе он
// ищет человека, которого в его корпусе никогда не было. Метка на ГРУППЕ, а не
// на каждой строке: группа — это один визит, а визит целиком сделан в одном
// здании; берётся первая непустая буква группы.
export function groupLabRows(rows, patientMap, accessionOf) {
    const pm = patientMap || {};
    const groups = [];
    const byKey = new Map();
    for (const r of (rows || [])) {
        const key = r.visit_id != null ? r.visit_id : ('_solo_' + r.id);
        let g = byKey.get(key);
        if (!g) {
            const info = pm[r.visit_id] || {};
            const patient = info.patient || {};
            g = {
                key,
                visitId: r.visit_id != null ? r.visit_id : null,
                patientId: patient.id != null ? patient.id : null,
                patientName: patient.full_name || '—',
                patientMrn: patient.mrn || '',
                patientSex: (patient.gender || '').toLowerCase(),
                patientDob: patient.date_of_birth || null,
                accession: accessionOf ? accessionOf(r) : null,
                originLetter: null,
                rows: [],
            };
            byKey.set(key, g);
            groups.push(g);
        }
        if (g.originLetter == null) g.originLetter = originTag(r);
        g.rows.push(r);
    }
    return groups;
}

// LAB_SELECT_OPTIONS_V1 — answer list for a «список» analyte.
//
// Storage format is what the panel editor writes into
// lab_panel_analytes.value_options: options separated by comma (also newline or
// semicolon), e.g. «Отрицательно, Следы, +, ++, +++». A JSON array is accepted
// too — the seeded catalogue (migrations 051/052) uses the comma form, but the
// production LIS this was ported from wrote JSON, so both must read.
export function parseOptions(raw) {
    if (!raw) return [];
    try {
        const j = JSON.parse(raw);
        if (Array.isArray(j)) return j.map(String);
    } catch (e) { /* not JSON — fall through to the comma form */ }
    return String(raw).split(/[,\n;]/).map(s => s.trim()).filter(Boolean);
}

// The options a select control should offer, WITH the already-saved answer
// prepended when the clinic has since edited that option out of the panel.
// Without this, reopening an old result shows «—» and re-saving would blank a
// value a lab tech had already signed off. Shared by both entry forms (the
// single-order modal and the combined worksheet) so they cannot drift.
export function selectOptionsFor(analyte, prev) {
    const opts = parseOptions(analyte && analyte.value_options);
    const saved = prev && prev.value != null ? String(prev.value).trim() : '';
    if (saved && !opts.includes(saved)) return [saved, ...opts];
    return opts;
}

// -----------------------------------------------------------------------------
// LAB_CARD_V3 (2026-09-05) — что карточка пробы говорит и что предлагает сделать.
//
// Владелец: «make a little redesign of the cards of the laboratory». На его
// снимке в одном ряду стояли ДВЕ залитые бирюзой кнопки («Внести результаты» и
// «Подтвердить») и третья, тёмная, на строке анализа. Три равных призыва — это
// ноль призывов: лаборант вынужден каждый раз решать заново, что здесь главное.
//
// Лечится не оформлением, а решением: у карточки ровно ОДНО следующее действие,
// и выбирает его чистая функция — не разметка. Разметка тогда просто красит
// то, что ей сказали, и добавить вторую главную кнопку становится нельзя, не
// изменив это правило (и не уронив тест, который считает главные кнопки).
//
// Состояния — те, в которых лаборант реально застаёт пробу:
//   'unpaid'   счёт не оплачен: лаборатории делать НЕЧЕГО (ждём кассу)
//   'fresh'    оплачено, ни одного результата не внесено
//   'partial'  часть анализов внесена
//   'entered'  внесены все, ждут подтверждения
//   'released' проверено и выдано
// -----------------------------------------------------------------------------
export const LAB_CARD_STATES = ['unpaid', 'fresh', 'partial', 'entered', 'released'];

/**
 * Состояние карточки по её строкам.
 *   rows       — visit_services одного визита
 *   hasResults — (row) -> есть ли у строки внесённые показатели
 *
 * Порядок проверок значим. «Не оплачено» стоит первым: пока касса не провела
 * счёт, статус строки 'added', и любое другое состояние обещало бы работу,
 * которую здесь начинать нельзя. «Выдано» — вторым: закрытая проба закрыта
 * целиком, и считать в ней проценты готовности уже незачем.
 */
export function labCardState(rows, hasResults) {
    const list = rows || [];
    const total = list.length;
    if (!total) return 'unpaid';
    const has = typeof hasResults === 'function' ? hasResults : () => false;
    if (!list.some(r => r.status !== 'added')) return 'unpaid';
    if (list.every(r => r.status === 'completed')) return 'released';
    const done = list.filter(r => has(r)).length;
    if (done === 0) return 'fresh';
    if (done < total) return 'partial';
    return 'entered';
}

/**
 * ЕДИНСТВЕННОЕ главное действие карточки — ключ, а не кнопка: разметка живёт в
 * laboratory.js, решение живёт здесь и проверяется без DOM.
 *
 *   'worksheet' — внести результаты всех анализов одним документом
 *   'verify'    — подтвердить и выдать
 *   'report'    — печать бланка
 *   null        — главного действия нет (счёт не оплачен)
 *
 * 'entered' без единой строки в статусе 'resulted' в жизни не встречается
 * (сохранение результатов само переводит строку в 'resulted'), но если такая
 * карточка всё же соберётся — подтверждать в ней нечего, и главным становится
 * бланк. Молчаливая кнопка «Подтвердить», которой нечего подтверждать, —
 * худший из возможных ответов на «что делать дальше».
 */
export function labPrimaryAction(cardState, opts) {
    const anyToVerify = !!(opts && opts.anyToVerify);
    switch (cardState) {
        case 'fresh':
        case 'partial':   return 'worksheet';
        case 'entered':   return anyToVerify ? 'verify' : 'report';
        case 'released':  return 'report';
        default:          return null;
    }
}

// -----------------------------------------------------------------------------
// Дата рождения — MONTH_WORDS_V1 (2026-09-05).
//
// Здесь жила запасная сборка даты (RU_MONTH_GEN / ymd / isMachineDate): она ловила
// машинную форму Intl «1994 M11 15» и пересобирала её из словаря. Починен
// был один экран из шестидесяти, а остальные продолжали писать «M11».
//
// Теперь месяцы берёт сам общий форматтер (ui.js → fmtDate, MONTH_WORDS_V1),
// и Intl он не спрашивает вовсе — чинить его ответ больше нечем и негде.
// -----------------------------------------------------------------------------
