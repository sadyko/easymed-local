// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25, ревью I2/I3/M3) — ПРАВИЛА СЛИЯНИЯ ДУБЛЕЙ,
// ОДНА КОПИЯ НА СЕРВЕР И ЭКРАН.
//
// Сервер (services/rpc/crm-merge.js) по ним решает, что предложить и что
// разрешить; окно «Дубликаты» (views/crm-duplicates.js) — какие карточки можно
// выбрать оставшейся, когда человек снимает галочки. Второй копии правил быть
// не может: разойдись они — экран предлагал бы то, от чего сервер отказывает.
//
// Чистые функции: без DOM, сети и часов. Карточка — { id, status, stage_kind
// ('open'|'won'|'lost'), stage_pos, patient_id, created_at, full_name }.
//
// ЖИВАЯ ЗАЯВКА НЕ ХОРОНИТСЯ В ЗАКРЫТОЙ (ревью I2). Если среди сливаемых есть
// карточка в работе (ступень вида open), остаться может ТОЛЬКО карточка в
// работе — и предлагается самая НОВАЯ из них: по ней сейчас звонят. Иначе
// свежий лид вливался в прошлогоднюю «Пришёл», пропадал с живых колонок и
// переписывал дату обращения задним числом.

import { nameKey, digitsOf } from './crm-phone-match.js';

export const isOpenCard = (c) => !!c && c.stage_kind === 'open';

/** Кого можно оставить: живые, если среди выбранных есть живые, иначе любую. */
export function allowedSurvivors(cards) {
    const list = Array.isArray(cards) ? cards : [];
    const open = list.filter(isOpenCard);
    return open.length ? open : list;
}

const byNewest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || (b.id - a.id);
const byOldest = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || (a.id - b.id);

// Закрытые — выигранная дальше проигранной, дальше по воронке — дальше.
function closedRank(c) {
    const pos = Number(c && c.stage_pos) || 0;
    return (c && c.stage_kind === 'won' ? 1000 : 0) + pos;
}

/**
 * Какую карточку предложить оставить. Есть живые — самую новую живую. Все
 * закрыты — дошедшую; затем с пациентом; затем дальше по воронке; затем самую
 * раннюю. Экран только предлагает — выбирает человек (из allowedSurvivors).
 */
export function suggestSurvivor(cards) {
    const list = Array.isArray(cards) ? cards : [];
    if (!list.length) return null;
    const open = list.filter(isOpenCard);
    if (open.length) return open.slice().sort(byNewest)[0].id;
    return list.slice().sort((a, b) => {
        const wa = a.stage_kind === 'won' ? 1 : 0;
        const wb = b.stage_kind === 'won' ? 1 : 0;
        if (wa !== wb) return wb - wa;
        const pa = a.patient_id != null ? 1 : 0;
        const pb = b.patient_id != null ? 1 : 0;
        if (pa !== pb) return pb - pa;
        const ra = closedRank(a);
        const rb = closedRank(b);
        if (ra !== rb) return rb - ra;
        return byOldest(a, b);
    })[0].id;
}

/** Разные пациенты среди выбранных — слияние запрещено (только по ВЫБРАННЫМ, ревью M3). */
export function patientConflict(cards) {
    return new Set((cards || []).map((c) => c && c.patient_id).filter((x) => x != null)).size > 1;
}

/**
 * Имя заявки как ИМЯ ЧЕЛОВЕКА — или '' . Лид из звонка неизвестного кладёт в
 * full_name сам номер (crm/lead-from-call.js): это не имя, и сравнивать его с
 * именами — значит поднимать ложную тревогу у каждой группы.
 */
export function personName(c) {
    const s = String((c && c.full_name) || '').trim();
    if (!s) return '';
    if (/^[\d\s+()\-.]+$/.test(s) && digitsOf(s).length >= 7) return '';
    return s;
}

/** Разные имена среди выбранных (без учёта регистра и пробелов) — предупреждение, не запрет (ревью I3). */
export function namesDiffer(cards) {
    return new Set((cards || []).map(personName).filter(Boolean).map(nameKey)).size > 1;
}
