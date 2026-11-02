// ═══════════════════════════════════════════════════════════════════════════
// DUP_STOP_V1 (2026-11-02) — «УЖЕ НАЗНАЧЕНО В ЭТОМ ВИЗИТЕ»: ЭКРАНЫ СПРАШИВАЮТ ДО ЗАПИСИ
// ═══════════════════════════════════════════════════════════════════════════
//
// Сервер отказывает повтору той же услуги в том же визите (409 duplicate_order —
// routes/db.js, RPC кассы). Экраны записи спрашивают об этом заранее (RPC
// visit_dup_check, только чтение):
//   • каталоги гасят уже назначенное («уже назначено») — loadVisitOrders, orderedMatch;
//   • мастер, калькулятор и быстрая регистрация проверяют смету ДО ensure_visit и
//     calendar_book — precheckOrders: отказ не оставляет ни пустого визита, ни счёта;
//   • администратор и главный врач назначают повтор с причиной (askRepeatReason) —
//     она уходит в строку полем __repeat_reason (withRepeatReason) и в журнал счёта.
// Сервер не ответил — экран не отказывает: последнее слово за дверью записи.
import { supabase } from '../../supabase.js';
import { h, Icon, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { orderKey, repeatableLine, REPEAT_REASON_KEY, REPEAT_REASON_MIN } from '../../shared/dup-order.js';

const isPosInt = (v) => v != null && String(v).trim() !== '' && Number.isInteger(Number(v)) && Number(v) > 0;
const EMPTY = Object.freeze({ visitId: null, ordered: [], canOverride: false });

function target({ visitId = null, patientId = null, day = null } = {}) {
    if (isPosInt(visitId)) return { visit_id: Number(visitId) };
    if (isPosInt(patientId) && typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day)) return { patient_id: Number(patientId), date: day };
    return null;
}

/** Назначенное в визите (id визита или пациент + местный день 'YYYY-MM-DD'). Сбой — пусто. */
export async function loadVisitOrders(where = {}) {
    const args = target(where);
    if (!args) return { ...EMPTY };
    try {
        const { data, error } = await supabase.rpc('visit_dup_check', { ...args, lines: [] });
        if (error || !data) return { ...EMPTY };
        return { visitId: data.visit_id ?? null, ordered: Array.isArray(data.ordered) ? data.ordered : [], canOverride: !!data.can_override };
    } catch (_) { return { ...EMPTY }; }
}

/**
 * Выбор каталога против назначенного. svc — услуга каталога ({id, type}) или консультация
 * врача ({__consult, consultation_type_id, __consultDoctorId}). → null | { blocked, row }:
 * blocked — повтор запрещён; не blocked — та же услуга-консультация у другого врача (можно,
 * но экран называет, у кого она уже есть).
 */
export function orderedMatch(svc, ordered, doctorId = null) {
    if (!svc || !Array.isArray(ordered) || !ordered.length) return null;
    if (svc.__consult) {
        const key = orderKey({ consultationTypeId: svc.consultation_type_id, doctorId: svc.__consultDoctorId ?? doctorId });
        const hit = key && ordered.find((o) => o.key === key);
        return hit ? { blocked: true, row: hit } : null;
    }
    if (repeatableLine({ serviceType: svc.type || null })) return null;
    const rows = ordered.filter((o) => o.service_id != null && Number(o.service_id) === Number(svc.id));
    if (!rows.length) return null;
    if (svc.type !== 'consultation') return { blocked: true, row: rows[0] };
    const mine = isPosInt(doctorId) ? rows.find((o) => Number(o.doctor_id) === Number(doctorId)) : null;
    return mine ? { blocked: true, row: mine } : { blocked: false, row: rows[0] };
}

/** Подпись строки каталога. */
export function orderedLabel(match) {
    if (!match) return '';
    const doc = match.row && match.row.doctor_name;
    return !match.blocked && doc ? trf('уже назначено: {doctor}', { doctor: doc }) : tr('уже назначено');
}

/** id для excludeServiceIds каталога (service-picker-modal): услуги и консультации врача, повтор которых запрещён. */
export function blockedPickIds(ordered) {
    const out = [];
    for (const o of ordered || []) {
        if (o.service_id != null) {
            if (o.service_type !== 'consultation' && o.service_type !== 'procedure') out.push(Number(o.service_id));
        } else if (o.consultation_type_id != null && o.doctor_id != null) {
            out.push(`c|${o.doctor_id}|${o.consultation_type_id}`);
        }
    }
    return [...new Set(out)];
}

/** Строке — причина обхода (сервер снимет поле до записи и положит причину в журнал). */
export function withRepeatReason(row, reason) {
    if (row && typeof reason === 'string' && reason.trim()) row[REPEAT_REASON_KEY] = reason.trim();
    return row;
}

/**
 * Проверка ДО первой записи. lines — [{ service_id?, consultation_type_id?, doctor_id? }].
 * → { ok: true, reason } — писать (reason — причина обхода или null);
 *   { ok: false, text } — не писать; text — отказ словами (null — человек сам отказался).
 * Ничего не показывает: что сказать и где — решает экран.
 */
export async function precheckOrders({ visitId = null, patientId = null, day = null, lines = [], excludeIds = [] } = {}) {
    const want = (lines || []).filter(Boolean);
    const args = target({ visitId, patientId, day });
    if (!want.length || !args) return { ok: true, reason: null };
    let data = null;
    try {
        const res = await supabase.rpc('visit_dup_check', { ...args, lines: want, exclude_ids: (excludeIds || []).filter(isPosInt).map(Number) });
        if (res.error || !res.data) return { ok: true, reason: null };
        data = res.data;
    } catch (_) { return { ok: true, reason: null }; }
    const hits = Array.isArray(data.duplicates) ? data.duplicates : [];
    if (!hits.length) return { ok: true, reason: null };
    const text = hits.map((d) => (d.template ? trf(d.template, d.params || {}) : tr(d.message || ''))).join('\n');
    if (!data.can_override) return { ok: false, text };
    const reason = await askRepeatReason(text);
    return reason ? { ok: true, reason } : { ok: false, text: null };
}

/**
 * Обход с причиной (администратор, главный врач): тот же вид окна, что у экстренной записи
 * (service-picker-modal.js askEmergencyReason). Promise<string|null>.
 */
export function askRepeatReason(conflictText) {
    return new Promise((resolve) => {
        const overlay = h('div', { class: 'modal', style: { zIndex: '190' } });
        let done = false;
        const finish = (v) => { if (done) return; done = true; overlay.remove(); document.removeEventListener('keydown', onEsc); resolve(v); };
        const onEsc = (e) => { if (e.key === 'Escape') finish(null); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => finish(null) }));
        const reason = h('textarea', { class: 'rcal-reason', rows: '3', dataset: { repeatReason: '' },
            placeholder: tr('Например: контрольный анализ по просьбе врача') });
        overlay.appendChild(h('div', { class: 'modal-card', style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Warning', { size: 16 }), ' ', tr('Повторное назначение')),
                h('button', { class: 'modal-close', type: 'button', onclick: () => finish(null) }, '×')),
            h('div', { class: 'modal-body' },
                h('div', { class: 'rcal-conflict', style: { whiteSpace: 'pre-line' } }, conflictText),
                h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '12px 0 6px' } },
                    tr('Повтор услуги в том же визите назначают только с причиной — она останется в журнале счёта.')),
                reason),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),
                h('button', { class: 'btn btn-outline', type: 'button', onclick: () => finish(null) }, tr('Отмена')),
                h('button', {
                    class: 'btn btn-primary', type: 'button', dataset: { repeatConfirm: '' }, onclick: () => {
                        const text = (reason.value || '').trim();
                        if (text.length < REPEAT_REASON_MIN) { toast(tr('Укажите причину повторного назначения.'), 'fail'); return; }
                        finish(text);
                    },
                }, tr('Назначить повторно')))));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onEsc);
        reason.focus();
    });
}
