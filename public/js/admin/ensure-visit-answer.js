// ENSURE_VISIT_ANSWER_V1 (CRM_REAL_BOOKING_V1, 2026-09-21) — ЧТО ОТВЕТИЛ
// ensure_visit, КОГДА ЕГО ПРОСИЛИ ЗАНЯТЬ ВРЕМЯ.
//
// У ensure_visit с `book:` (server/services/rpc/visits.js) три разных исхода,
// и визит есть во всех трёх — поэтому «есть id визита, значит записано» это
// та самая ошибка, которую разбор ревью нашёл в карточке заявки:
//
//   booked:true                        — визит дня завели и время заняли;
//   booked:true, moved:true, from:{…}  — визит дня БЫЛ ПУСТ (ни услуг, ни
//                                        счёта) и ПЕРЕНЕСЁН на выбранное
//                                        время; `from` — откуда: прежний час
//                                        и прежний врач;
//   booked:false,
//   reason:'day_visit_busy',
//   day_visit:{start, doctor_name, …}  — по визиту дня УЖЕ БЫЛА работа: время
//                                        ему не меняли, и выбранный час НИКЕМ
//                                        НЕ ЗАНЯТ. Оператору надо сказать
//                                        пациенту, во сколько его уже ждут.
//
// Без `book:` ответ приходит с booked:false и БЕЗ reason — это обычное «визит
// дня переиспользован», и здесь оно называется 'reused'.
//
// ТРИ ДВЕРИ — ОДНО ЧТЕНИЕ. Карточка заявки, мастер визита и быстрая
// регистрация зовут ensure_visit каждая из своего окна; разбирать ответ в
// каждом по копии — значит, что одна дверь честна, а две молча обещают
// пациенту незанятый час. Слова тоже одни: и отказ, и перенос читаются
// одинаково во всех трёх окнах.
//
// Модуль не знает про экраны (нет DOM, нет тостов) — только про ответ и его
// слова; тосты показывает вызывающий.
import { trf } from './i18n.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** 'ЧЧ:ММ' по местному времени из ISO визита; пусто, если не разобрать. */
function hhmmOf(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/**
 * @param {object} ev — data из ответа ensure_visit ({ visit, created, booked, … })
 * @param {{ time?: string }} [opts] — 'ЧЧ:ММ', которое просили; без него новое
 *   время переноса читается из самого визита ответа.
 * @returns {{ kind: 'booked'|'moved'|'busy'|'reused', ok: boolean,
 *             moved: boolean, busy: boolean, text: string,
 *             dayVisit: object|null, from: object|null }}
 *   ok — можно считать день записанным (время занято или визит дня взят как
 *   есть); text — что сказать человеку (пусто, когда говорить нечего).
 */
export function readEnsureVisit(ev, opts = {}) {
    const d = ev && typeof ev === 'object' ? ev : {};
    if (d.booked === false && d.reason === 'day_visit_busy') {
        const dv = d.day_visit && typeof d.day_visit === 'object' ? d.day_visit : {};
        // Врач приписывается к фразе уже ПЕРЕВЕДЁННЫМ куском: склеивать
        // русское слово с именем нельзя, tr() ищет строку целиком
        // (I18N_COVERAGE_V1).
        const doc = dv.doctor_name ? ' ' + trf('у {doc}', { doc: dv.doctor_name }) : '';
        return {
            kind: 'busy', ok: false, moved: false, busy: true, dayVisit: dv, from: null,
            text: trf('В этот день у пациента уже есть приём в {t}{doc} — время не занято, откройте календарь',
                { t: dv.start || '—', doc }),
        };
    }
    if (d.booked && d.moved) {
        const from = d.from && typeof d.from === 'object' ? d.from : {};
        // Прежний врач — в скобках и без слов: «с 16:00 (Иванов) на 09:15».
        const doc0 = from.doctor_name ? ' (' + from.doctor_name + ')' : '';
        const t1 = (opts && opts.time) || hhmmOf(d.visit && d.visit.visit_date) || '—';
        return {
            kind: 'moved', ok: true, moved: true, busy: false, dayVisit: null, from,
            text: trf('Приём перенесён с {t0}{doc0} на {t1}', { t0: from.start || '—', doc0, t1 }),
        };
    }
    if (d.booked) return { kind: 'booked', ok: true, moved: false, busy: false, dayVisit: null, from: null, text: '' };
    return { kind: 'reused', ok: true, moved: false, busy: false, dayVisit: null, from: null, text: '' };
}
