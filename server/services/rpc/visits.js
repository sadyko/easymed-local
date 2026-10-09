// DAY_VISIT_V1 — the visit model: a visit is ONE CALENDAR DAY (00:00–23:59)
// per patient. The UI works in SERVICES; each service lands on the visit of
// its own date, and the visit row exists for statistics (counts, journals).
// ensure_visit is the single entry point: find the patient's visit for the
// given day or create it — so "how many visits" is computed here, in the
// backend, never hand-managed by the client.

import { hasAnyRole } from '../roles.js';
// VISITS_ONE_DOOR_V1 — «свободно ли» и «записать» спрашиваются у тех же двух
// обработчиков, что и у календаря. Своей арифметики расписания здесь нет ни
// строки: calendar_slots — единственный источник занятости на весь продукт,
// calendar_book — единственный, кто ставит визиту время и врача.
import { calendarSlots, calendarBook } from './calendar.js';
import { DEFAULT_DURATION_MIN, serviceDurationMinutes, formatHhmm } from './slot-engine.js';
// BILLING_AUDIT_FIX_V1 (A1) — день визита считается в МЕСТНОМ времени клиники.
import { localDate } from '../domain/day.js';
// CRM_CALENDAR_MIRROR_V1 — запись и заявка — одна запись: строки услуг
// записи сверяются с строками заявки (crm/booking-mirror.js).
import { mirrorVisit, dayVisitMovableFor } from '../crm/booking-mirror.js';
import { crmLinkVisit } from '../crm/visit-link.js';   // CRM_UNIFY_V1

export class RpcError extends Error {
  constructor(msg, status = 400, code = null, params = null) {
    super(msg);
    this.status = status;
    if (code) this.code = code;
    if (params) this.params = params;
  }
}

// CRM_REAL_BOOKING_V1 — колл-центр в этом списке потому, что запись из заявки
// стала НАСТОЯЩЕЙ записью: оператор заводит визит дня и ставит ему время той же
// дверью, что и регистратура (ensure_visit + book). Прежде «Сохранить и
// записать» писало только услугу и дату, и визита не появлялось вовсе —
// оператору эта дверь была не нужна, а пациент оставался без слота.
//
// LIVE_AUDIT_FIX_V1 — медсестры в списке больше нет. Строку визита она вставить
// не может (visit_services.insert — admin/registrar/doctor), поэтому ensure_visit
// давал ей только ПУСТОЙ визит перед отказом на первой строке. Ни одна её дверь
// визит не заводит (мастер и «Добавить услуги» ей не показываются).
const ENSURE_ROLES = ['admin', 'registrar', 'doctor', 'callcenter'];

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Вашей роли это действие недоступно.', 403);
  }
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// VISITS_ONE_DOOR_V1 — ensure_visit БОЛЬШЕ НЕ БЕСКОНТРОЛЬНАЯ ВСТАВКА
// ═══════════════════════════════════════════════════════════════════════════
//
// Мастер визита делал два шага: ensure_visit (вставка без единой проверки) и
// только ПОТОМ calendar_book. Отказ второго оставлял после себя созданный
// scheduled-визит — «сирота»: пациент в базе записан, а в календаре его нет, и
// слот он всё-таки держит. Теперь оба шага — один вызов:
//
//   1. слот проверяется ДО первой записи в базу (calendar_slots — тот же
//      список, которым сетка календаря рисует свободное);
//   2. визит дня заводится;
//   3. время, врач, услуга и длительность ставятся calendar_book — той самой
//      дверью, в которой живёт запрет двойной записи;
//   4. если 3 всё-таки отказал (настоящая гонка: соседний оператор занял слот
//      в те же миллисекунды) — только что созданная строка УДАЛЯЕТСЯ. После
//      отказа не остаётся ни визита, ни услуги, ни счёта.
//
// Отметка CRM «пришёл» при этом сдвинута ЗА успешную запись: закрывать заявку
// пациента, которого мы так и не записали, нельзя.
const BOOK_MIN_REASON = 3;

/** ISO/мс → 'YYYY-MM-DD' МЕСТНОГО дня (сервер стоит в той же клинике). */
function localDayIso(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const minutesOfLocal = (ms) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
const hhmmToMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

/**
 * ЗАНЯТО ЛИ ВЫБРАННОЕ ВРЕМЯ. Спрашивается у calendar_slots — единственной
 * реализации занятости в продукте, — а не считается здесь заново.
 *
 * excludeVisitId — собственный визит дня этого же пациента: он не должен
 * закрывать ему же время (у пациента, уже пришедшего сегодня, визит-контейнер
 * дня существует и стоит на своём часе).
 */
function slotConflict(db, user, { doctorId, startMs, durationMin, excludeVisitId }) {
  const res = calendarSlots(db, {
    doctor_id: doctorId,
    date: localDayIso(startMs),
    duration_minutes: durationMin,
    step_minutes: durationMin,
    exclude_visit_id: excludeVisitId || null,
  }, user);
  const from = minutesOfLocal(startMs);
  const to = from + durationMin;
  const clash = (res.busy || []).find((b) => from < hhmmToMin(b.to) && hhmmToMin(b.from) < to) || null;
  return clash ? { clash, doctorName: (res.resource && res.resource.name) || '' } : null;
}

/** Тот же отказ, что у calendar_book: код, параметры и слова — один в один. */
function conflictError(doctorName, clash) {
  const params = { doctor: doctorName || '—', from: clash.from, to: clash.to };
  // i18n-exempt: сообщение сервера; экран переводит его по коду slot_taken.
  return new RpcError(
    `Это время занято: у врача ${params.doctor} уже есть приём ${clash.from}–${clash.to}. Выберите другое время.`,
    409, 'slot_taken', params,
  );
}

/** Длительность записи — та же, что возьмёт calendar_book: услуга, иначе 15. */
function bookDuration(db, serviceId) {
  if (serviceId) {
    const svc = db.prepare('SELECT duration_minutes FROM services WHERE id = ?').get(serviceId);
    return serviceDurationMinutes(svc, DEFAULT_DURATION_MIN);
  }
  return DEFAULT_DURATION_MIN;
}

/** Разбор args.book. null — записывать нечего (обычный ensure_visit). */
function parseBook(book) {
  if (!book || typeof book !== 'object') return null;
  const doctorId = Number(book.doctor_id);
  if (!isPositiveInt(doctorId)) throw new RpcError('Для записи не выбран врач.', 400);
  const startMs = Date.parse(String(book.start || ''));
  if (Number.isNaN(startMs)) throw new RpcError('Время записи указано неверно.', 400);
  const dur = book.duration_minutes === undefined || book.duration_minutes === null || book.duration_minutes === ''
    ? null : Math.round(Number(book.duration_minutes));
  if (dur !== null && (!Number.isFinite(dur) || dur < 5)) {
    throw new RpcError('Приём должен длиться не меньше 5 минут.', 400);
  }
  const reason = typeof book.emergency_reason === 'string' ? book.emergency_reason.trim() : '';
  return {
    doctorId, startMs,
    durationMin: dur,
    serviceId: book.service_id === undefined || book.service_id === '' ? null : Number(book.service_id) || null,
    roomId: book.room_id === undefined || book.room_id === '' ? null : Number(book.room_id) || null,
    emergency: book.emergency === true || book.emergency === 'true',
    reason,
  };
}

// args: { patient_id, date (ISO datetime or YYYY-MM-DD), doctor_id?,
//         visit_type?, referral_source_id?, branch_id?, notes?,
//         desk?: true (CRM_UNIFY_V1 — регистрация на стойке, только без book),
//         book?: { doctor_id, start, duration_minutes?, service_id?, room_id?,
//                  emergency?, emergency_reason? } }
// Returns { visit, created, booked, emergency?, cross_branch? }.
export async function ensureVisit(db, args, user) {
  requireRole(user, ENSURE_ROLES);

  const patientId = args && args.patient_id;
  if (!isPositiveInt(patientId)) {
    throw new RpcError('Пациент указан неверно.', 400);
  }
  const rawDate = args && typeof args.date === 'string' ? args.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
    throw new RpcError('Дата визита указана неверно.', 400);
  }
  // BILLING_AUDIT_FIX_V1 (A1) — ДЕНЬ ВИЗИТА — МЕСТНЫЙ ДЕНЬ КЛИНИКИ.
  //
  // Здесь стояло rawDate.slice(0, 10) — UTC-дата присланного мгновения. Мастер
  // визита шлёт местную полночь через toISOString(): в UTC+5 это ВЧЕРА 19:00Z,
  // и сегодняшняя услуга ложилась во вчерашний визит пациента (или заводила
  // второй визит «сегодня»). То же с записью колл-центра на время до 05:00.
  // Полное мгновение переводится в местный день той же функцией, что и отчёты
  // (domain/day.js); голая дата 'YYYY-MM-DD' уже местная и берётся как есть.
  let day = rawDate.slice(0, 10);
  if (rawDate.length > 10) {
    const local = db.prepare(`SELECT ${localDate('?')} AS d`).get(rawDate);
    if (!local || !local.d) throw new RpcError('Дата визита указана неверно.', 400);
    day = local.d;
  }
  const whenIso = rawDate.length > 10 ? rawDate : day + 'T09:00:00Z';

  const optInt = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!isPositiveInt(n)) throw new RpcError(name + ' must be a positive integer.', 400);
    return n;
  };
  const doctorId = optInt(args.doctor_id, 'doctor_id');
  const branchId = optInt(args.branch_id, 'branch_id');
  const sourceId = optInt(args.referral_source_id, 'referral_source_id');
  const visitType = typeof args.visit_type === 'string' && args.visit_type ? args.visit_type : 'outpatient';
  const notes = typeof args.notes === 'string' ? args.notes.slice(0, 1000) : '';
  // CRM_UNIFY_V1 (Р1) — «пациент у стойки»: быстрая регистрация и «пришёл
  // сейчас» (registerWalkIn). Действует только без book; кому и на какой день
  // верить, решает шаг связи (crm/visit-link.js, deskArrival).
  const desk = args.desk === true || args.desk === 'true';

  // CRM_UNIFY_V1 — связь с заявками — crm/visit-link.js (crmLinkVisit), после записи.

  // ─── ПРОВЕРКА ДО ПЕРВОЙ ЗАПИСИ В БАЗУ ─────────────────────────────────────
  //
  // Три случая мастера, и ни один из них больше не проходит мимо проверки:
  //
  //   • визит дня СОЗДАЁТСЯ — проверяем и записываем calendar_book'ом ниже;
  //   • визит дня УЖЕ ЕСТЬ (пациент сегодня уже приходил) — двигать его время
  //     под вторую услугу нельзя, но ВЫБРАННОЕ регистратором время всё равно
  //     обязано быть свободным, иначе стойка обещает приём, которого не будет.
  //     Поэтому проверяем и здесь, исключая собственный визит пациента;
  //   • строки без времени (услуга «на дату») и врач с ЖИВОЙ ОЧЕРЕДЬЮ вообще
  //     не присылают book: у них нет слота — не «проверка пропущена», а
  //     проверять нечего. Решает это экран (headTimedLine в visit-wizard.js),
  //     и это единственная честная причина сюда не прийти.
  const book = parseBook(args && args.book);
  // BILLING_AUDIT_FIX_V1 (A1, A8) — визит дня ищется по МЕСТНОМУ дню и только
  // среди СВОИХ визитов: визит, приехавший из соседнего здания (sync_origin),
  // здесь не правится (BRANCH_MONEY_GUARD_V1 — ни счёт, ни услугу в нём не
  // выставить), и пациент, побывавший утром в филиале, получал в этом здании
  // чужой визит, в который ничего нельзя было записать.
  const DAY_VISIT_SQL = `
    SELECT * FROM visits
     WHERE patient_id = ? AND ${localDate('visit_date')} = ?
       AND status NOT IN ('cancelled', 'no_show')
       AND sync_origin IS NULL
     ORDER BY id LIMIT 1`;
  const dayVisit = () => db.prepare(DAY_VISIT_SQL).get(patientId, day);

  if (book) {
    const durationMin = book.durationMin || bookDuration(db, book.serviceId);
    const hit = slotConflict(db, user, {
      doctorId: book.doctorId, startMs: book.startMs, durationMin,
      excludeVisitId: (dayVisit() || {}).id || null,
    });
    if (hit) {
      // Порядок отказов тот же, что у calendar_book: сначала «занято», и
      // только у ЯВНО экстренной записи — «назовите причину». Галочка без
      // причины проверку не снимает: это отсутствие проверки, а не запись.
      if (!book.emergency) throw conflictError(hit.doctorName, hit.clash);
      if (book.reason.length < BOOK_MIN_REASON) {
        // i18n-exempt: сообщение сервера; ключ словаря — тот же текст.
        throw new RpcError('Экстренная запись поверх занятого времени требует причины — укажите её.',
          400, 'emergency_reason_required');
      }
    }
  }

  const run = db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) {
      throw new RpcError('Пациент не найден.', 400);
    }
    // One visit per patient per day: match on the DATE part of visit_date.
    // Cancelled/no-show days don't swallow new bookings — a fresh visit row
    // is opened for the same day instead.
    const existing = db.prepare(DAY_VISIT_SQL).get(patientId, day);
    if (existing) {
      // Backfill a doctor onto a doctor-less day visit (first assigned wins).
      if (doctorId && existing.doctor_id == null) {
        db.prepare('UPDATE visits SET doctor_id = ? WHERE id = ?').run(doctorId, existing.id);
        existing.doctor_id = doctorId;
      }
      return { visit: existing, created: false };
    }

    if (doctorId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(doctorId)) {
      throw new RpcError('Врач не найден.', 400);
    }
    const info = db.prepare(`
      INSERT INTO visits (patient_id, doctor_id, branch_id, visit_date, visit_type, status, referral_source_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
    `).run(patientId, doctorId, branchId, whenIso, visitType, sourceId, notes, user.id);
    const fresh = db.prepare('SELECT * FROM visits WHERE id = ?').get(info.lastInsertRowid);
    return { visit: fresh, created: true };
  });

  const out = run();
  if (!book) {
    // CRM_UNIFY_V1 — строки «без даты» берёт только ensure_visit; desk — только здесь, без записи на время.
    crmLinkVisit(db, out.visit.id, user, { undated: true, desk });
    // CRM_CALENDAR_MIRROR_V1 — строки заявки, которые визит только что взял,
    // становятся строками визита (до прихода). CRM_UNIFY_V1 — на стойке (desk)
    // шаг связи сам зовёт зеркало ДО правила прихода (ревью задачи 3, R1/R2);
    // здесь после прихода остаётся только замена строк зеркала строками
    // регистратуры.
    mirrorVisit(db, out.visit.id, { actorId: user && user.id });
    return { ...out, booked: false };
  }

  // ─── ЗАПИСЬ И ОТКАТ ───────────────────────────────────────────────────────
  //
  // Время, врача, услугу и длительность свежесозданному визиту ставит
  // calendar_book — та же дверь, что у календаря, с тем же запретом и той же
  // записью причины экстренной записи в visits.notes.
  //
  // ВИЗИТ ДНЯ, КОТОРЫЙ УЖЕ БЫЛ, — ДВА РАЗНЫХ СЛУЧАЯ (разбор ревью 2026-09-21).
  //
  // Здесь стояло «не двигается», и выбранное оператором время не занималось
  // НИЧЕМ: ответ приходил с booked:false, карточка считала его успехом, и
  // человеку называли час, на который его никто не ждал. Разница между
  // случаями — БЫЛА ЛИ ПО ЭТОМУ ВИЗИТУ РАБОТА:
  //
  //   ПУСТОЙ (ни строки услуг, ни счёта) — это и есть запись, заведённая
  //   такой же записью: мастером визита или прошлым «Сохранить и записать»
  //   той же заявки. Новое время для неё — ПЕРЕНОС, и делает его тот же
  //   calendar_book, что и всегда (запрет двойной записи живёт внутри него).
  //
  //   С РАБОТОЙ — пациент уже пришёл: услуги в смете, счёт выставлен, и
  //   время визита это время его прихода. Переписать его записью нельзя,
  //   поэтому ответ честно говорит booked:false, называет причину и отдаёт
  //   ВРЕМЯ И ВРАЧА того визита: оператору надо что-то сказать вслух.
  //
  // CRM_CALENDAR_MIRROR_V1 — «ПУСТОЙ» ТЕПЕРЬ ЗНАЧИТ «БЕЗ РАБОТЫ». Запись до
  // прихода держит строки своих услуг ('added', без счёта): их заводит зеркало
  // заявки и колл-центр из календаря. Такая запись по-прежнему только запись —
  // перенос её времени ничего не стирает, строки едут вместе с визитом.
  // Работа — это счёт или строка дальше «в смете» (visitHasWork), либо визит
  // уже не в статусе записи.
  // V3120_FINAL (G3) — и без строк другого врача: запись к Иванову не
  // переезжает под запись к Петрову (dayVisitMovableFor, booking-mirror.js).
  const dayVisitIsBare = (visitId) => dayVisitMovableFor(db, visitId, book && book.doctorId);

  if (!out.created && !dayVisitIsBare(out.visit.id)) {
    // Строки заявки этого дня всё равно связываются с ним: в этот день
    // пациента держит именно он, и в смете регистратуры они нужны. CRM_UNIFY_V1:
    // до прихода — как запись («Записан»); визит уже «Пришёл» — строки берут
    // его и закрываются правилом прихода (crm/visit-link.js).
    crmLinkVisit(db, out.visit.id, user, { undated: true });   // CRM_UNIFY_V1
    mirrorVisit(db, out.visit.id, { actorId: user && user.id });   // CRM_CALENDAR_MIRROR_V1
    const doctor = out.visit.doctor_id
      ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(out.visit.doctor_id)
      : null;
    return {
      ...out,
      booked: false,
      reason: 'day_visit_busy',
      day_visit: {
        id: out.visit.id,
        visit_date: out.visit.visit_date,
        start: formatHhmm(minutesOfLocal(Date.parse(out.visit.visit_date))),
        duration_minutes: out.visit.duration_minutes,
        doctor_id: out.visit.doctor_id,
        doctor_name: (doctor && doctor.full_name) || '',
      },
    };
  }

  // Дальше путь ОДИН на оба случая: свежесозданному визиту calendar_book
  // ставит время, пустому визиту дня — переносит. Сюда доходят только те,
  // кого просили записать (выше стоит ранний возврат без `book`).
  if (book) {
    // Прежние время и врач — ДО переноса, для ответа `from` (см. ниже).
    const wasDoctor = !out.created && out.visit.doctor_id
      ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(out.visit.doctor_id)
      : null;
    const was = out.created ? null : {
      start: formatHhmm(minutesOfLocal(Date.parse(out.visit.visit_date))),
      doctor_id: out.visit.doctor_id,
      doctor_name: (wasDoctor && wasDoctor.full_name) || '',
    };
    try {
      const bk = await calendarBook(db, {
        visit_id: out.visit.id,
        doctor_id: book.doctorId,
        service_id: book.serviceId || undefined,
        room_id: book.roomId || undefined,
        start: new Date(book.startMs).toISOString(),
        duration_minutes: book.durationMin || undefined,
        emergency: book.emergency || undefined,
        emergency_reason: book.reason || undefined,
      }, user);
      out.visit = bk.visit;
      out.emergency = !!bk.emergency;
      if (bk.cross_branch) out.cross_branch = bk.cross_branch;
      // ПЕРЕНОС НАЗЫВАЕТСЯ ПЕРЕНОСОМ И НАЗЫВАЕТ, ОТКУДА: экрану надо сказать
      // оператору не «записано», а «приём перенесён с 16:00 (Иванов) на
      // 09:15» — это разные новости, и вторая половина фразы берётся из
      // `from`. Врач переносится вместе со временем (день пациента — один
      // визит), и если он сменился, прежний тоже назван.
      if (!out.created) { out.moved = true; out.from = was; }
    } catch (e) {
      // ОТКАТ. Сюда попадает настоящая гонка — соседний оператор занял слот в
      // те миллисекунды, что прошли между проверкой и записью. Строка,
      // созданная секунду назад, удаляется целиком: после отказа не остаётся
      // ни визита-сироты, ни услуги, ни счёта. Строка заявки тоже не берёт
      // себе этот визит — crmLinkVisit ниже до неё не доходит (CRM_UNIFY_V1).
      //
      // УДАЛЯЕТСЯ ТОЛЬКО ТО, ЧТО МЫ ЖЕ И ЗАВЕЛИ. Перенос идёт этим же путём,
      // но его визит существовал ДО вызова: отказ переноса обязан оставить
      // запись на прежнем времени, а не стереть её вместе с днём пациента.
      if (out.created) {
        try { db.prepare('DELETE FROM visits WHERE id = ?').run(out.visit.id); }
        catch (delErr) { console.error('[ensure_visit] откат визита', out.visit.id, 'не удался:', delErr && delErr.message); }
      }
      throw e;
    }
  }
  // CRM_UNIFY_V1 — запись связывается с заявкой пациента (crm/visit-link.js);
  // затем строки записи и заявки сверяются.
  crmLinkVisit(db, out.visit.id, user, { undated: true });   // CRM_UNIFY_V1
  mirrorVisit(db, out.visit.id, { actorId: user && user.id });
  return { ...out, booked: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE_AUDIT_FIX_V1 — discard_empty_visit: НЕ ОСТАВЛЯТЬ ПУСТОЙ ВИЗИТ ЗА ОТКАЗОМ
// ═══════════════════════════════════════════════════════════════════════════
//
// Мастер визита заводит визит дня (ensure_visit) и ПОТОМ пишет в него строки
// услуг. Если строки не легли (сбой сети, отказ сервера по строке), за мастером
// оставался визит без единой услуги: в журнале «визит», в календаре занятый
// слот, а работы нет. Удалить его экрану нечем — visits через /api/db удаляет
// только администратор.
//
// Удаляется ТОЛЬКО то, что этот же человек только что завёл и что осталось
// пустым: свой (created_by), в статусе scheduled, без строк услуг и без счёта,
// заведённый не раньше 30 минут назад. Всё остальное — отказ: чужой или
// работающий визит этим путём не стирается никогда.
const DISCARD_WINDOW_MIN = 30;
// FINAL_ROLES_SYNC_FIX_V1 (M4) — таблицы, чьи строки держат визит (внешний ключ
// без ON DELETE): визит с ними не пустой.
const DISCARD_HOLDERS = [
  ['patient_vitals', 'visit_id', 'в нём уже записаны показатели (давление, пульс)'],
  ['visit_documents', 'visit_id', 'по нему уже есть документ'],
  ['service_queue_tickets', 'visit_id', 'по нему уже выдан талон очереди'],
  ['recommended_services', 'source_visit_id', 'из него уже есть рекомендации врача'],
  ['custdev_cards', 'visit_id', 'по нему уже есть карточка опроса'],
  ['invoice_audit_log', 'visit_id', 'по нему уже есть записи журнала счетов'],
];

export function discardEmptyVisit(db, args, user) {
  requireRole(user, ENSURE_ROLES);
  const visitId = args && args.visit_id;
  if (!isPositiveInt(visitId)) throw new RpcError('Не выбран визит.', 400);   // FINAL_ROLES_SYNC_FIX_V1 (M5) — по-русски
  const run = db.transaction(() => {
    const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
    if (!v) return { discarded: false, reason: 'not_found' };
    if (v.created_by == null || Number(v.created_by) !== Number(user.id)) {
      throw new RpcError('Удалить можно только свой только что созданный визит.', 403);
    }
    if (v.status !== 'scheduled') throw new RpcError('Визит уже в работе — удалить его нельзя.', 400);
    const fresh = db.prepare(`SELECT (julianday('now') - julianday(?)) * 1440 <= ? AS ok`).get(v.created_at, DISCARD_WINDOW_MIN).ok;
    if (!fresh) throw new RpcError('Визит заведён давно — удалить его этим путём нельзя.', 400);
    if (db.prepare('SELECT 1 FROM visit_services WHERE visit_id = ? LIMIT 1').get(visitId)
        || db.prepare('SELECT 1 FROM invoices WHERE visit_id = ? LIMIT 1').get(visitId)) {
      throw new RpcError('В визите уже есть услуги или счёт — он не пустой.', 400);
    }
    // FINAL_ROLES_SYNC_FIX_V1 (M4) — ОСТАЛЬНЫЕ СТРОКИ, КОТОРЫЕ ДЕРЖАТ ВИЗИТ.
    // Внешние ключи этих таблиц на visits без ON DELETE: удаление упало бы
    // сырой английской ошибкой базы. Визит с ними — уже не пустой.
    for (const [table, col, why] of DISCARD_HOLDERS) {
      let has = false;
      // CASHIER_HEAD_V1 (ревью) — записи журнала о правках строк кассой
      // (line_*) визит не держат: они о счёте, а не о работе в визите.
      const extra = table === 'invoice_audit_log' ? " AND COALESCE(action, '') NOT LIKE 'line!_%' ESCAPE '!'" : '';
      try { has = !!db.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ?${extra} LIMIT 1`).get(visitId); }
      catch { has = false; }   // таблицы нет в этой сборке — держать нечему
      if (has) throw new RpcError('Визит не пустой: ' + why + ' — удалить его нельзя.', 400);
    }
    // FINAL_ROLES_SYNC_FIX_V1 (M4) — заявка колл-центра, которую эта запись
    // передвинула (crmLinkVisit — CRM_UNIFY_V1), возвращается как была — если с тех
    // пор её никто не трогал (статус и день те, что поставила запись).
    try {
      const undo = db.prepare('SELECT * FROM crm_booking_undo WHERE visit_id = ? ORDER BY id DESC').all(visitId);
      const back = db.prepare(`UPDATE crm_requests SET status = ?, scheduled_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                                WHERE id = ? AND status IS ? AND scheduled_date IS ?`);
      for (const u of undo) back.run(u.prev_status, u.prev_scheduled_date, u.request_id, u.set_status, u.set_scheduled_date);
      db.prepare('DELETE FROM crm_booking_undo WHERE visit_id = ?').run(visitId);
    } catch { /* сборка без 186 — возвращать нечего */ }
    // Строки заявок, которые ensure_visit успел привязать, снова свободны.
    // CRM_UNIFY_V1 (ревью задачи 3, R6) — и снова ждут: закрыть строку пустого
    // визита ('done') мог только приход на стойке по этому же визиту, а визита
    // больше нет. Ступени, которые сменил этот приход, вернул след выше.
    db.prepare(`UPDATE crm_request_services SET visit_id = NULL,
                       status = CASE WHEN status = 'done' THEN 'pending' ELSE status END
                 WHERE visit_id = ?`).run(visitId);
    // CRM_CALENDAR_MIRROR_V1 — и привязка записи к заявке уходит вместе с ней.
    // Разбор ревью (M7): заявку, которую завела САМА эта запись (колл-центр без
    // открытой заявки), убираем тоже — иначе на доске осталась бы «Записан»
    // без записи. Только если к ней с тех пор ничего не прибавилось: ни строки
    // на другой записи, ни другой привязки.
    try {
      const own = db.prepare('SELECT request_id FROM crm_booking_links WHERE visit_id = ? AND created_request = 1').get(visitId);
      db.prepare('DELETE FROM crm_booking_links WHERE visit_id = ?').run(visitId);
      if (own) {
        const busy = db.prepare(`SELECT 1 FROM crm_request_services WHERE request_id = ? AND status <> 'cancelled'
                                    AND (visit_id IS NULL OR visit_id <> ?) LIMIT 1`).get(own.request_id, visitId)
          || db.prepare('SELECT 1 FROM crm_booking_links WHERE request_id = ? LIMIT 1').get(own.request_id);
        if (!busy) {
          db.prepare('DELETE FROM crm_booking_undo WHERE request_id = ?').run(own.request_id);
          db.prepare('DELETE FROM crm_requests WHERE id = ?').run(own.request_id);
        }
      }
    } catch (e) { console.error('[discard_empty_visit] привязка к заявке не убрана:', e && e.message); }
    // CASHIER_HEAD_V1 (ревью) — записи журнала о правках строк кассой визит
    // не держат (см. DISCARD_HOLDERS выше): ссылку отпускают, запись остаётся.
    db.prepare("UPDATE invoice_audit_log SET visit_id = NULL WHERE visit_id = ? AND action LIKE 'line!_%' ESCAPE '!'").run(visitId);
    db.prepare('DELETE FROM visits WHERE id = ?').run(visitId);
    return { discarded: true };
  });
  return run();
}
