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
import { dayFrame, dayStartFits } from '../../shared/slot-pack.js';   // JOIN_EXTENDS_BOOKING_V1 — то же правило, что у сервера

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

// ═══════════════════════════════════════════════════════════════════════════
// BOOKED_JOIN_V1 (решение владельца 2026-11-07) — УСЛУГА К ВРАЧУ, К КОТОРОМУ
// ПАЦИЕНТ УЖЕ ЗАПИСАН В ЭТОТ ДЕНЬ, ИДЁТ В ЭТУ ЗАПИСЬ.
// ═══════════════════════════════════════════════════════════════════════════
//
// Колл-центр (карточка CRM или календарь) записал пациента к врачу. Регистратор
// добавлял к тому же врачу ещё услугу — и окно отвечало «у врача нет свободного
// времени»: время врача держала сама запись (строка записи в смете занимает
// свой слот, а у калькулятора и вся запись — в занятости врача). Теперь такая
// услуга ложится в ту же запись: тот же визит, время записи, свой слот ей не
// нужен. Запрет повтора той же услуги в визите (DUP_STOP_V1) действует как
// прежде — это другая проверка.

/**
 * Записи пациента на дни [сегодня, сегодня + days): живые визиты своего здания
 * («Записан», «Подтверждён», «Пришёл» — те, что держат время врача) — врач и
 * время визита, а также строки визита с врачом и своим временем (вторая услуга
 * к другому врачу в тот же день).
 * @returns {Promise<Array<{visitId:number, doctorId:number, when:string, day:string, durationMin?:number, head?:boolean}>>}
 *   when — местное 'YYYY-MM-DDTHH:MM'. Пустой список при отказе сервера —
 *   регистратор тогда выбирает время, как прежде.
 *   JOIN_EXTENDS_BOOKING_V1 — у записи-визита (head) её длительность: окно
 *   называет, удлинится ли запись на присоединённую услугу.
 */
export async function loadPatientBookings(patientId, { now = new Date(), days = 15 } = {}) {
  if (!isPosInt(patientId)) return [];
  const { from } = localDayBounds(now);
  const end = new Date(now); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + days);
  const { data: visits, error } = await supabase.from('visits').select('id, visit_date, doctor_id, status, duration_minutes, booked_at')
    .eq('patient_id', Number(patientId)).in('status', ['scheduled', 'confirmed', 'arrived']).is('sync_origin', null)
    .gte('visit_date', from).lt('visit_date', end.toISOString()).order('visit_date').limit(50);
  if (error || !Array.isArray(visits) || !visits.length) return [];
  const out = [];
  for (const v of visits) {
    const when = localSlot(v.visit_date);
    // CRM_JOIN_NOT_MOVE_V1 (ревью L4) — присоединяют только к НАСТОЯЩЕЙ записи (время ей ставил
    // calendar_book — booked_at, как у сервера isSameBooking) или к пришедшему пациенту. Визит дня
    // без времени (ensure_visit без book: 09:00Z и 30 минут по умолчанию) записью не предлагается.
    if (v.status !== 'arrived' && !String(v.booked_at || '').trim()) continue;
    if (when && isPosInt(v.doctor_id)) {
      out.push({ visitId: Number(v.id), doctorId: Number(v.doctor_id), when, day: when.slice(0, 10),
        durationMin: Math.max(5, Number(v.duration_minutes) || 15), head: true, status: v.status || '' });   // JOIN_EXTENDS_BOOKING_V1 · CRM_JOIN_NOT_MOVE_V1
    }
  }
  const { data: lines, error: lErr } = await supabase.from('visit_services')
    .select('visit_id, doctor_id, scheduled_at, status')
    .in('visit_id', visits.map((v) => Number(v.id))).neq('status', 'cancelled').limit(500);
  if (!lErr && Array.isArray(lines)) {
    for (const l of lines) {
      if (!isPosInt(l.doctor_id) || !l.scheduled_at) continue;
      const when = localSlot(l.scheduled_at);
      if (!when || when.endsWith('T00:00')) continue;   // строка «на дату» времени врача не держит
      if (out.some((b) => b.visitId === Number(l.visit_id) && b.doctorId === Number(l.doctor_id) && b.when === when)) continue;
      out.push({ visitId: Number(l.visit_id), doctorId: Number(l.doctor_id), when, day: when.slice(0, 10) });
    }
  }
  return out;
}

/**
 * BOOKED_JOIN_V1 — запись пациента к врачу `doctorId` в день `dayIso`: самая
 * ранняя, { visitId, doctorId, when, day } — или null.
 * @param {Array<{visitId:number, doctorId:number, when:string}>} bookings when — местное 'YYYY-MM-DDTHH:MM'
 */
export function bookedJoinFor(bookings, doctorId, dayIso) {
  if (!isPosInt(doctorId) || !dayIso) return null;
  const hits = (bookings || []).filter((b) => b && Number(b.doctorId) === Number(doctorId)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(b.when || ''))
    && String(b.when).slice(0, 10) === String(dayIso));
  if (!hits.length) return null;
  return hits.slice().sort((a, b) => String(a.when).localeCompare(String(b.when)))[0];
}

/** BOOKED_JOIN_V1 — минуты от местной полуночи времени записи ('…THH:MM'), или null. */
export function joinMinutes(join) {
  const m = /T(\d{2}):(\d{2})$/.exec(String((join && join.when) || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * JOIN_EXTENDS_BOOKING_V1 (3.23.0) — УДЛИНИТСЯ ЛИ ЗАПИСЬ НА ПРИСОЕДИНЁННЫЕ УСЛУГИ.
 * Правило сервера (rpc/visits.js extendJoined): время за записью свободно —
 * внутри приёма врача и ни с кем не пересекается; иначе запись остаётся своей
 * длины. Экран говорит это ДО записи, в списке времени.
 * @param {{when:string, durationMin?:number}} join   запись (bookedJoinFor)
 * @param {object} day   ответ calendar_slots этого врача и дня БЕЗ самой записи (patientId — EXCLUDE_OWN_VISIT_V1)
 * @param {number} addMin   длительность присоединяемых услуг
 * @returns {{fits:boolean, ends:string, next:string|null, until:string|null}|null}
 *   null — не из чего считать (нет записи или ответа сервера)
 */
export function joinExtension(join, day, addMin) {
  const start = joinMinutes(join);
  const add = Math.max(0, Math.round(Number(addMin) || 0));
  if (start == null || !day || !add) return null;
  const endMin = start + Math.max(5, Number(join.durationMin) || 15);
  const fmt = (m) => pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60);
  const out = { fits: false, ends: fmt(endMin + add), next: null, until: null };
  if (endMin + add <= 24 * 60 && dayStartFits(day, add, endMin)) return { ...out, fits: true };
  const frame = dayFrame(day);
  const next = ((frame && frame.busy) || []).map((b) => b.from).filter((m) => m >= endMin && m < endMin + add).sort((a, b) => a - b)[0];
  if (next != null) return { ...out, next: fmt(next) };
  const seg = ((frame && frame.segments) || []).find((g) => g.from <= endMin && endMin < g.to);
  return { ...out, until: fmt(seg ? seg.to : endMin) };
}

/**
 * JOIN_EXTENDS_BOOKING_V1 — пометка списка времени: запись не удлинится (пусто — удлинится
 * или нечего сказать). trf — переводчик вызывающего: модуль без i18n.js (его берут и тесты
 * сервера, где нет DOM).
 */
export function joinExtensionNote(ext, trf) {
  if (!ext || ext.fits) return '';
  if (ext.next) return trf('приём закончится в {end}, следующая запись в {next}', { end: ext.ends, next: ext.next });
  return trf('приём закончится в {end}, а врач принимает до {to}', { end: ext.ends, to: ext.until || '—' });
}

/** Подпись строки «из записи»: статус записи словами (переводит вызывающий через tr). */
export function bookedStatusLabel(status) {
  return status === 'confirmed' ? 'Подтверждён' : 'Записан';
}

/**
 * DIAG_ROUTE_V1 (ревью M-1) — ИСПОЛНИТЕЛЬ СТРОКИ, КОТОРАЯ УЖЕ В ВИЗИТЕ. Строка записи
 * (календарь до 3.21, касса «Без врача», CRM, бот) лежит в визите без исполнителя — её не
 * видит ни один кабинет (SERVICE_SCOPE_V3). Регистратура ставит исполнителя той же дверью,
 * что «Сменить врача» карты пациента (patient_card_set_doctor): только строка не в счёте,
 * не закрытый месяц начислений, живой исполнитель — правила сервера, не экрана.
 * → null — записано; иначе текст отказа (сервера — его словами; переводит вызывающий).
 */
export async function setLinePerformer({ patientId, vsId, doctorId }) {
  if (!isPosInt(vsId) || !isPosInt(doctorId)) return 'Исполнитель указан неверно.';
  const { error } = await supabase.rpc('patient_card_set_doctor', {
    patient_id: isPosInt(patientId) ? Number(patientId) : null, visit_service_id: Number(vsId), doctor_id: Number(doctorId),
  });
  return error ? String(error.message || error.msg || error) : null;
}
