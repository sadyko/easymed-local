// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (2026-10-16) — R7a, ДЕФЕКТ G7: «ИЗ ЗАПИСИ» — ЗАПИСАННЫЕ УСЛУГИ
// СЕГОДНЯШНЕГО ВИЗИТА — ГОТОВЫЕ СТРОКИ РЕГИСТРАЦИИ
// ═══════════════════════════════════════════════════════════════════════════
//
// Пациента записали на сегодня (календарь, колл-центр, карточка CRM): в его
// визите дня уже стоят строки услуг 'added'. Быстрая регистрация и мастер визита
// вставляли ту же услугу второй строкой — визит и счёт держали её дважды. Окна
// регистрации теперь показывают эти строки сами («из записи», со статусом
// записи) и регистрируют ИХ: второй строки не вставляют, счёт выставляют на
// строку записи. Убранная регистратором строка записи снимается с визита так
// же, как это делает календарь (booking_line_remove).
//
// Одно чтение на оба окна. Без DOM. Бросает при отказе сервера (пустой ответ
// неотличим от «записи нет»).
import { supabase } from '../../supabase.js';
import { screenTakesBooked } from '../../shared/same-service.js';   // CRM_LINK_ALL_V1 (ревью денег S1) — одно правило с сетью R7b

const isPosInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
const pad = (n) => String(n).padStart(2, '0');

/** Границы МЕСТНОГО дня `now` в ISO (visits.visit_date хранится в UTC ISO). */
export function localDayBounds(now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const next = new Date(d); next.setDate(next.getDate() + 1);
  return { from: d.toISOString(), to: next.toISOString() };
}

/** ISO-мгновение → местное 'YYYY-MM-DDTHH:MM' (так мастер визита хранит время строки). */
export function localSlot(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Запись пациента на СЕГОДНЯ: визит своего здания «Записан»/«Подтверждён» и его
 * строки-услуги «в смете» ('added', не товар).
 * @returns {Promise<{visit: {id:number, status:string, visit_date:string}|null,
 *   rows: Array<{vsId:number, serviceId:number|null, consultationTypeId:number|null, doctorId:number|null,
 *                quantity:number, unitPrice:number, billed:boolean, name:string, service:object|null,
 *                consultation:object|null, when:string|null, needsDoctor:boolean}>}>}
 */
export async function loadTodayBooking(patientId, { now = new Date() } = {}) {
  if (!isPosInt(patientId)) return { visit: null, rows: [] };
  const { from, to } = localDayBounds(now);
  const { data: visits, error } = await supabase.from('visits').select('id, status, visit_date')
    .eq('patient_id', Number(patientId)).in('status', ['scheduled', 'confirmed']).is('sync_origin', null)
    .gte('visit_date', from).lt('visit_date', to).order('id').limit(1);
  if (error) throw new Error(error.message || String(error));
  const visit = (visits || [])[0] || null;
  if (!visit) return { visit: null, rows: [] };
  const { data: lines, error: lErr } = await supabase.from('visit_services')
    .select('id, service_id, consultation_type_id, doctor_id, quantity, unit_price, status, invoice_item_id, clinic_item_id, scheduled_at, services(id, name, price, tax_rate, type), consultation_types(id, name, name_ru, name_uz, price)')
    .eq('visit_id', visit.id).eq('status', 'added').order('id');
  if (lErr) throw new Error(lErr.message || String(lErr));
  const rows = (lines || [])
    .filter((l) => l.clinic_item_id == null && (l.service_id != null || l.consultation_type_id != null))
    .map((l) => {
      const svc = l.services || null;
      const ct = l.consultation_types || null;
      return {
        vsId: Number(l.id),
        serviceId: l.service_id != null ? Number(l.service_id) : null,
        consultationTypeId: l.service_id == null && l.consultation_type_id != null ? Number(l.consultation_type_id) : null,
        doctorId: isPosInt(l.doctor_id) ? Number(l.doctor_id) : null,
        quantity: Number(l.quantity) || 1,
        unitPrice: Number(l.unit_price) || 0,
        billed: l.invoice_item_id != null,
        name: (svc && svc.name) || (ct && (ct.name_ru || ct.name)) || '',
        service: svc,
        consultation: ct,
        when: localSlot(l.scheduled_at || visit.visit_date),
        // CRM_LINK_ALL_V1 (ревью денег S1) — услуге нужен врач: правило «та же услуга» сравнивает его только
        // тогда. Вид приёма — всегда; у услуги каталога requires_doctor добавляет окно из своего каталога
        // (вложенная выборка services его не отдаёт — «unknown embed column»).
        needsDoctor: l.service_id == null && l.consultation_type_id != null,
      };
    });
  return { visit, rows };
}

/**
 * CRM_LINK_ALL_V1 (редакция 2) — СТРОКА ЭКРАНА — ТА ЖЕ УСЛУГА, ЧТО СТРОКА ЗАПИСИ `b`.
 * Такая строка не вставляется второй: она и есть строка записи (окна прицепляют
 * её к записи), иначе сеть R7b убрала бы строку записи, которую экран выставляет
 * в счёт.
 * CRM_LINK_ALL_V1 (повторное ревью денег, S1) — правило ОДНО с сетью R7b
 * (shared/same-service.js): у услуги, которой врач не нужен, врач не сравнивается
 * (ЭКГ у исполнителя 11 — та же ЭКГ, что записана к исполнителю 10); у услуги с
 * врачом — тот же врач, или у строки записи его нет; строка, врач которой ещё не
 * выбран, — тоже строка записи.
 * @param {{serviceId?:number|null, consultationTypeId?:number|null, doctorId?:number|null, needsDoctor?:boolean}} line
 * @param {{serviceId?:number|null, consultationTypeId?:number|null, doctorId?:number|null, needsDoctor?:boolean}} b
 *   needsDoctor — услуге нужен врач (services.requires_doctor); довольно у одной из двух
 */
export function isBookedTwin(line, b) {
  if (!line || !b) return false;
  return screenTakesBooked(line, b, { needsDoctor: !!(line.needsDoctor || b.needsDoctor) });
}

/** Подпись строки «из записи»: статус записи словами (переводит вызывающий через tr). */
export function bookedStatusLabel(status) {
  return status === 'confirmed' ? 'Подтверждён' : 'Записан';
}
