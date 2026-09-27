// LIVE_AUDIT_FIX_V1 — СТРОКА ВИЗИТА ИЗ ВЫБОРА КАТАЛОГА: ОДНО ПРАВИЛО НА ВСЕ ДВЕРИ.
//
// Каталог услуг (service-picker-modal.js) отдаёт два вида строк:
//   • услугу каталога — { id: <число>, … };
//   • консультацию врача — { id: 'c|<врач>|<тип>', __consult: true,
//     consultation_type_id, __consultDoctorId, … }: это не строка services, а
//     приём конкретного врача по типу консультации.
// Кабинет врача разбирал это правильно (service_id NULL + consultation_type_id),
// а окно визита и быстрая регистрация писали 'c|7|3' прямо в service_id —
// внешний ключ отказывал (409), а быстрая регистрация отвечала «Строка без
// услуги» уже ПОСЛЕ того, как карта пациента была заведена.
//
// Второе правило — ИСПОЛНИТЕЛЬ ПО УМОЛЧАНИЮ. Врач визита/приёма подставляется
// исполнителем только врачебной услуге. Процедура, анализ и услуга «без врача»
// (services.requires_doctor = 0) выполняются процедурным кабинетом или
// лабораторией: врач визита у такой строки делал её «его» услугой — в его
// очереди и в его начислениях.

import { supabase } from '../../supabase.js';
import { tr } from '../i18n.js';
import { IN_BED_STATUSES } from '../../shared/admission-status.js';

const isPosInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0 && String(v).trim() !== '';

/** Консультация врача из каталога (не строка services). */
export function isConsultPick(svc) {
    return !!(svc && svc.__consult);
}

/**
 * Ключи строки visit_services для выбранного: { service_id, consultation_type_id }
 * — или null, если выбор не годится ни как услуга, ни как консультация.
 */
export function lineIdentity(svc) {
    if (!svc) return null;
    if (isConsultPick(svc)) {
        const ct = svc.consultation_type_id;
        return isPosInt(ct) ? { service_id: null, consultation_type_id: Number(ct) } : null;
    }
    return isPosInt(svc.id) ? { service_id: Number(svc.id), consultation_type_id: null } : null;
}

/** Врач консультации, выбранной в каталоге (у неё врач — часть самого выбора). */
export function consultDoctorId(svc) {
    return isConsultPick(svc) && isPosInt(svc.__consultDoctorId) ? Number(svc.__consultDoctorId) : null;
}

/**
 * Может ли врач визита/приёма стать исполнителем этой строки, если в смете
 * врача не выбрали. Консультация — да (её врач и так в выборе); услуга «без
 * врача», анализ и процедура — нет.
 */
export function visitDoctorMayPerform(svc) {
    if (!svc) return false;
    if (isConsultPick(svc)) return true;
    if (svc.requires_doctor === false || svc.requires_doctor === 0 || svc.requires_doctor === '0') return false;
    if (svc.is_lab === true || svc.is_lab === 1) return false;
    const t = String(svc.type || '').toLowerCase();
    return t !== 'lab' && t !== 'procedure';
}

/**
 * Исполнитель строки: выбранный в смете врач → врач консультации → врач
 * визита (только если visitDoctorMayPerform) → никого.
 */
export function linePerformer(svc, pickedDoctorId, visitDoctorId) {
    if (isPosInt(pickedDoctorId)) return Number(pickedDoctorId);
    const cd = consultDoctorId(svc);
    if (cd) return cd;
    if (isPosInt(visitDoctorId) && visitDoctorMayPerform(svc)) return Number(visitDoctorId);
    return null;
}

/** Та же строка уже в визите? Консультации сравниваются по типу и врачу. */
export function sameLine(existing, svc, doctorId) {
    const id = lineIdentity(svc);
    if (!id || !existing) return false;
    if (id.service_id != null) return String(existing.service_id) === String(id.service_id);
    return String(existing.consultation_type_id) === String(id.consultation_type_id)
        && String(existing.doctor_id || '') === String(doctorId || '');
}

// ─── LIVE_AUDIT_FIX_V1 (A5) — ХИРУРГИЯ БЕЗ КОЙКИ ОТКАЗЫВАЕТ ДО ВИЗИТА ─────────
//
// Сервер отказывает строке хирургии (services.type 'other') у пациента не на
// койке (routes/db.js refuseSurgeryWithoutBed) — но только на ВСТАВКЕ СТРОКИ,
// то есть когда визит дня уже заведён. Двери записи спрашивают то же самое
// заранее, до ensure_visit/calendar_book: отказ не оставляет пустого визита.
// Последнее слово остаётся за сервером; не удалось спросить — не отказываем.
export const SURGERY_NEEDS_BED_TEXT = 'Хирургия оформляется на госпитализацию: сначала положите пациента на койку, '
    + 'иначе счёт за операцию окажется вне истории лечения.';

export function isSurgeryPick(svc) {
    return !!svc && !isConsultPick(svc) && String(svc.type || '').toLowerCase() === 'other';
}

export async function surgeryBedRefusal(patientId, services) {
    if (!(services || []).some(isSurgeryPick)) return null;
    if (!isPosInt(patientId)) return null;
    try {
        const { data, error } = await supabase.from('admissions').select('id')
            .eq('patient_id', Number(patientId)).in('status', IN_BED_STATUSES).limit(1);
        if (error) return null;
        return data && data.length ? null : tr(SURGERY_NEEDS_BED_TEXT);
    } catch (_) { return null; }
}
