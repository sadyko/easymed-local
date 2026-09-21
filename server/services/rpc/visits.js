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
import { DEFAULT_DURATION_MIN, serviceDurationMinutes } from './slot-engine.js';
// CRM_LINKS_V1 — воронка настраивается (миграция 077), поэтому ступени
// спрашиваются у справочника, а не берутся из зашитого списка.
import { openStageKeys, scheduledStageKey, noShowStageKey, SEED_NO_SHOW_STAGE } from '../crm/config.js';

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
const ENSURE_ROLES = ['admin', 'registrar', 'doctor', 'nurse', 'callcenter'];

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
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
  if (!isPositiveInt(doctorId)) throw new RpcError('book.doctor_id must be a positive integer.', 400);
  const startMs = Date.parse(String(book.start || ''));
  if (Number.isNaN(startMs)) throw new RpcError('book.start must be an ISO datetime.', 400);
  const dur = book.duration_minutes === undefined || book.duration_minutes === null || book.duration_minutes === ''
    ? null : Math.round(Number(book.duration_minutes));
  if (dur !== null && (!Number.isFinite(dur) || dur < 5)) {
    throw new RpcError('book.duration_minutes must be at least 5.', 400);
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
//         book?: { doctor_id, start, duration_minutes?, service_id?, room_id?,
//                  emergency?, emergency_reason? } }
// Returns { visit, created, booked, emergency?, cross_branch? }.
export async function ensureVisit(db, args, user) {
  requireRole(user, ENSURE_ROLES);

  const patientId = args && args.patient_id;
  if (!isPositiveInt(patientId)) {
    throw new RpcError('patient_id must be a positive integer.', 400);
  }
  const rawDate = args && typeof args.date === 'string' ? args.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
    throw new RpcError('date must be ISO (YYYY-MM-DD or full datetime).', 400);
  }
  const day = rawDate.slice(0, 10);
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

  // ═══════════════════════════════════════════════════════════════════════
  // CRM_REAL_BOOKING_V1 (2026-09-21) — ЗАПИСЬ ЭТО СЛОТ, А «ПРИШЁЛ» ЭТО ПРИХОД
  // ═══════════════════════════════════════════════════════════════════════
  //
  // ЧТО БЫЛО. Создание визита закрывало строки заявки ('done') и переводило её
  // в «Пришёл». То есть заявка объявлялась дошедшей в тот миг, когда её
  // ЗАПИСАЛИ, — за неделю до приёма, по телефону, ещё до того, как человек
  // вышел из дома. Воронка колл-центра считала конверсией собственную запись, а
  // «Не пришёл» не мог появиться в ней вовсе, если оператор успел записать.
  //
  // Владелец (2026-09-21): «Пришёл» значит, что пациент ФИЗИЧЕСКИ пришёл.
  // Поэтому при создании визита происходит РОВНО ОДНО: строка заявки берёт себе
  // визит, а заявка уезжает в «Записан». Закрытие строк и переход в «Пришёл»
  // переехали на отметку прихода — server/services/crm/visit-status.js, хук
  // внутри calendar_book.
  //
  // СТРОКИ ОСТАЮТСЯ 'pending', И ЭТО НЕ НЕДОДЕЛКА. По ним живёт подстановка
  // регистратуры (pendingCrmLines в crm-lines.js): в день приёма смета обязана
  // собраться сама. Закрой мы строку записью — в четверг регистратура не
  // увидела бы ни услуги, ни врача, к которому человек записан.
  //
  // КАКИЕ СТРОКИ ЗАБИРАЕТ ВИЗИТ: свободные ('pending', ещё без визита) и ЭТОГО
  // дня. Дата сравнивается на РАВЕНСТВО, а не «не позже», и это разница с
  // прежним правилом закрытия: вчерашняя несостоявшаяся запись не должна молча
  // прицепиться к сегодняшнему слоту — у неё был свой, и разбираться с ним
  // человеку. Строка без даты — это «когда придёт», и приход как раз случился.
  //
  // ВРАЧА СТРОКИ НЕ ТРОГАЕМ ВОВСЕ. В строке стоит тот врач, которого пообещали
  // пациенту по телефону (миграция 058), а у визита дня врач свой — первый, кто
  // на этот день попался (backfill ниже). Перепиши мы одним другого —
  // регистратура подставила бы в смету не того, к кому человек записан.
  //
  // РОДИТЕЛЬ ЕДЕТ ТОЛЬКО ВПЕРЁД И ТОЛЬКО ИЗ ЖИВЫХ. «Записан» — это
  // scheduledStageKey(): сидовая колонка, пока она у клиники есть, иначе
  // последняя открытая перед конверсией. Заявка, уже стоящая в «Записан» или
  // дальше («Согласован»), назад не откатывается. Проигрышная не воскресает:
  // «Не пришёл» попадает в выборку, чтобы его строки можно было записать
  // ЗАНОВО, но объявить его снова живым вправе только приход.
  //
  // ДАТА РОДИТЕЛЯ — ЗЕРКАЛО БЛИЖАЙШЕГО ДНЯ (миграция 057): по ней живут
  // карточка, отчёт колл-центра и ночная автоматика «Не пришёл». Пустая или
  // более поздняя заменяется днём этого визита; более ранняя остаётся — там
  // ждёт своего часа строка, которую записали раньше.
  //
  // Молчит при любой ошибке (как и раньше): справочник CRM не вправе отказать
  // в визите.
  const settleCrmOnBooking = (visit) => {
    try {
      const visitId = visit && visit.id;
      if (!visitId) return;
      const noShow = noShowStageKey(db);
      // Те же ступени, что и раньше: все живые плюс сидовая «Не пришёл».
      // Запасной вариант noShowStageKey() отдаёт ПЕРВУЮ проигрышную колонку, и
      // у клиники без сидовой запись цепляла бы строки «Обработки
      // остановленной» — заявки, с которой осознанно перестали работать.
      const lookIn = [...new Set([
        ...openStageKeys(db),
        noShow === SEED_NO_SHOW_STAGE ? noShow : null,
      ].filter(Boolean))];
      if (!lookIn.length) return;
      const holes = lookIn.map(() => '?').join(',');
      const reqs = db.prepare(`
        SELECT id, status, scheduled_date FROM crm_requests
         WHERE patient_id = ? AND status IN (${holes})
      `).all(patientId, ...lookIn);
      if (!reqs.length) return;

      const open = openStageKeys(db);
      const scheduled = scheduledStageKey(db);
      const schedAt = scheduled ? open.indexOf(scheduled) : -1;

      const linkLines = db.prepare(`
        UPDATE crm_request_services
           SET visit_id = ?
         WHERE request_id = ? AND status = 'pending' AND visit_id IS NULL
           AND (scheduled_date IS NULL OR scheduled_date = '' OR date(scheduled_date) = date(?))
      `);
      const moveOn = db.prepare(`
        UPDATE crm_requests
           SET status = ?, scheduled_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?
      `);

      for (const r of reqs) {
        // Заявка, от которой этот визит не взял ни строки, не трогается вовсе:
        // пациент, пришедший сегодня сдать кровь, не «записан» на консультацию
        // следующего месяца — она так и ждёт своего дня в своей колонке.
        if (!linkLines.run(visitId, r.id, day).changes) continue;
        const at = open.indexOf(r.status);
        const status = (schedAt >= 0 && at >= 0 && at < schedAt) ? scheduled : r.status;
        const was = String(r.scheduled_date || '').trim().slice(0, 10);
        const when = (!was || was > day) ? day : was;
        if (status !== r.status || when !== r.scheduled_date) moveOn.run(status, when, r.id);
      }
    } catch (e) {
      console.error('[ensure_visit] заявки CRM не пересчитаны:', e && e.message);
    }
  };

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
  const dayVisit = () => db.prepare(`
    SELECT * FROM visits
     WHERE patient_id = ? AND substr(visit_date, 1, 10) = ?
       AND status NOT IN ('cancelled', 'no_show')
     ORDER BY id LIMIT 1
  `).get(patientId, day);

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
      throw new RpcError('patient not found.', 400);
    }
    // One visit per patient per day: match on the DATE part of visit_date.
    // Cancelled/no-show days don't swallow new bookings — a fresh visit row
    // is opened for the same day instead.
    const existing = db.prepare(`
      SELECT * FROM visits
       WHERE patient_id = ? AND substr(visit_date, 1, 10) = ?
         AND status NOT IN ('cancelled', 'no_show')
       ORDER BY id LIMIT 1
    `).get(patientId, day);
    if (existing) {
      // Backfill a doctor onto a doctor-less day visit (first assigned wins).
      if (doctorId && existing.doctor_id == null) {
        db.prepare('UPDATE visits SET doctor_id = ? WHERE id = ?').run(doctorId, existing.id);
        existing.doctor_id = doctorId;
      }
      if (!book) settleCrmOnBooking(existing);
      return { visit: existing, created: false };
    }

    if (doctorId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(doctorId)) {
      throw new RpcError('doctor not found.', 400);
    }
    const info = db.prepare(`
      INSERT INTO visits (patient_id, doctor_id, branch_id, visit_date, visit_type, status, referral_source_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
    `).run(patientId, doctorId, branchId, whenIso, visitType, sourceId, notes, user.id);
    const fresh = db.prepare('SELECT * FROM visits WHERE id = ?').get(info.lastInsertRowid);
    if (!book) settleCrmOnBooking(fresh);
    return { visit: fresh, created: true };
  });

  const out = run();
  if (!book) return { ...out, booked: false };

  // ─── ЗАПИСЬ И ОТКАТ ───────────────────────────────────────────────────────
  //
  // Время, врача, услугу и длительность свежесозданному визиту ставит
  // calendar_book — та же дверь, что у календаря, с тем же запретом и той же
  // записью причины экстренной записи в visits.notes.
  //
  // Визит дня, который УЖЕ БЫЛ, не двигается: его время — это время первого
  // прихода пациента, и вторая услуга дня ложится своей строкой
  // visit_services. Проверку выбранного времени он всё равно прошёл выше.
  if (out.created) {
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
    } catch (e) {
      // ОТКАТ. Сюда попадает настоящая гонка — соседний оператор занял слот в
      // те миллисекунды, что прошли между проверкой и записью. Строка,
      // созданная секунду назад, удаляется целиком: после отказа не остаётся
      // ни визита-сироты, ни услуги, ни счёта. Строка заявки тоже не берёт
      // себе этот визит — settleCrmOnBooking ниже до неё не доходит.
      try { db.prepare('DELETE FROM visits WHERE id = ?').run(out.visit.id); }
      catch (delErr) { console.error('[ensure_visit] откат визита', out.visit.id, 'не удался:', delErr && delErr.message); }
      throw e;
    }
  }
  settleCrmOnBooking(out.visit);
  return { ...out, booked: !!out.created };
}
