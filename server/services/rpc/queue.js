// QUEUE_TICKET_V1 — local port of easymed's issue_queue_numbers (Postgres
// migration 122). Allocates queue numbers for freshly registered
// visit_services, atomically, so two registrars printing at the same instant
// can never be handed the same number.
//
// A number belongs to a DESTINATION (per day), not to a service:
//   consultation  -> the doctor          key doc:<doctor_id>:<day>   (per-doctor queue)
//   lab           -> the laboratory      key lab:<day>               (ALL of a patient's
//                                        lab services share one number — one draw window)
//   procedure     -> the doctor if set,  key proc:doc:<id>:<day>
//                    else the room       key proc:room:<day>
//   imaging       -> the apparatus       key img:<service_id>:<day>  (each imaging
//                                        service ≈ its own machine)
//   anything else -> its own service     key oth:<service_id>:<day>
//
// Единственное исключение — ХИРУРГИЯ: операция назначена на время, номером её
// не вызывают, поэтому талон ей не выдаётся вообще (QUEUE_SURGERY_NO_TICKET_V1).
//
// Within one destination+day a PATIENT keeps one number (they stand in that
// line once); a new patient gets MAX+1. Rows already numbered return as-is,
// so reprinting an invoice reuses the same tickets.

import { hasAnyRole, canViewSection } from '../roles.js';
import { today, localDate } from '../domain/day.js';

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const ISSUE_ROLES = ['admin', 'registrar', 'doctor', 'nurse', 'cashier'];

// QUEUE_SURGERY_NO_TICKET_V1 — как узнать операцию. Ровно один источник правды.
// Кириллическая ветка обязательна: «хирург» ни при каком регистре не сводится
// к «surg». `operatsi`/«операц» ловят типы вроде «Малые операции».
export const SURGERY_NAME_RE = /хирург|surger|jarroh|операц|operatsi/i;

export function isSurgery(row) {
  return SURGERY_NAME_RE.test(String((row && row.svc_type_name) || ''));
}

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
}

export function issueQueueNumbers(db, args, user) {
  requireRole(user, ISSUE_ROLES);

  const ids = args && args.p_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((v) => Number.isInteger(v) && v > 0)) {
    throw new RpcError('p_ids must be a non-empty array of positive integers.', 400);
  }

  const run = db.transaction(() => {
    const tickets = [];
    for (const id of ids) {
      const row = db.prepare(`
        SELECT vs.id, vs.queue_key, vs.queue_no, vs.doctor_id, vs.scheduled_at, vs.service_id,
               v.patient_id, v.visit_date,
               ${localDate('COALESCE(vs.scheduled_at, v.visit_date)')} AS day_local,
               s.type AS svc_type, s.is_lab AS svc_is_lab, s.name AS svc_name, s.requires_doctor,
               st.name AS svc_type_name
          FROM visit_services vs
          JOIN visits v ON v.id = vs.visit_id
          LEFT JOIN services s ON s.id = vs.service_id
          LEFT JOIN service_types st ON st.id = s.type_id
         WHERE vs.id = ?
      `).get(id);
      if (!row) throw new RpcError('visit_service ' + id + ' not found.', 400);

      // Reprint: an already-ticketed line returns its existing number.
      if (row.queue_no != null && row.queue_key) {
        tickets.push({ visit_service_id: row.id, queue_key: row.queue_key, label: labelFor(db, row, row.queue_key), number: row.queue_no });
        continue;
      }

      // QUEUE_LOCAL_DAY_V1 — день очереди берётся в МЕСТНОМ времени клиники.
      //
      // Здесь стоял срез строки UTC (slice(0,10)). Услуга, записанная «на
      // 16 августа» без времени, хранится как местная полночь — то есть
      // 2026-08-15T19:00Z в UTC+5, — и срез давал 15 августа. Талон уезжал в
      // очередь ПРЕДЫДУЩЕГО дня: доска за 15-е показывала людей, которые
      // придут 16-го, а их собственный день их не видел. На боевой базе так
      // оказалось 399 талонов из 743.
      //
      // Мастер записи об этой ловушке знал и группировал строки по локальной
      // дате (DATE_ONLY_V1 в visit-wizard.js) — сервер делал ровно то, от чего
      // тот комментарий предостерегает. Теперь дату считает SQLite тем же
      // localDate(), что и весь остальной код (domain/day.js).
      const day = row.day_local || 'no-date';
      const type = String(row.svc_type || '').toLowerCase();
      const isLab = !!row.svc_is_lab || type === 'lab';

      // QUEUE_SURGERY_NO_TICKET_V1 — операция НЕ занимает очередь.
      //
      // Хирургия в каталоге — отдельный тип услуг (service_types «Хирургия»,
      // 183 услуги), но в services.type у всех них стоит 'other', а врач
      // проставлен. Поэтому такая строка попадала в ветку «есть врач» и вставала
      // в его приёмную линию: доска показывала «Исаков Зокир, 6 человек», хотя
      // ни один из них в коридоре не сидел, а номера съедали места у тех, кто
      // действительно ждёт приёма.
      //
      // Операцию не вызывают номером: она назначена на время, и пациент идёт в
      // операционную по записи. Значит талона не должно быть вовсе — ни в
      // линии врача, ни в отдельной. Строка просто не попадает в ответ, и
      // печать чека её в блоке очереди не покажет (все вызывающие идут по
      // ВОЗВРАЩЁННЫМ талонам, а не по списку p_ids).
      //
      // Признак берём у типа КАТАЛОГА, а не у services.type: значения
      // 'surgery' там нет вовсе, и заводить его — это трогать редактор услуг,
      // счета и отчёты. Тот же приём, что LAB_SERVICE_ROUTING_V1 применяет к
      // лаборатории: имя типа решает маршрут.
      //
      // Уже выданные талоны это НЕ отменяет: строка с номером ушла по ветке
      // выше и перепечатывается как была — бумага на руках у пациента остаётся
      // верной.
      //
      // Лаборатория проверяется РАНЬШЕ: гистология операционного материала
      // может лежать под типом «Хирургия», но у окна забора очередь настоящая.
      if (isSurgery(row) && !isLab) continue;

      let key;
      // QUEUE_ONE_DOCTOR_LINE_V1 — у врача ОДНА очередь на весь его день.
      //
      // Приём, процедура и диагностика одного врача считались тремя линиями
      // (doc: / proc:doc: / img:doc:), и каждая начиналась с №1. У ЛОРа это дало
      // двух разных пациентов с талоном №7 на один день — один в приёме, другой
      // на «Кукушке», — и регистратура искала седьмого не в той колонке.
      // Дверь у врача одна, значит и очередь одна: как только у строки есть
      // врач, номер считается в ЕГО линию, чем бы услуга ни была.
      //
      // Лаборатория проверяется ПЕРВОЙ и остаётся сама собой: это место (одно
      // окно забора), а не врач, даже если в строке проставлен назначивший.
      if (isLab)                             key = `lab:${day}`;
      else if (row.doctor_id)                key = `doc:${row.doctor_id}:${day}`;
      else if (type === 'consultation')      key = `doc:0:${day}`;
      else if (type === 'procedure')         key = `proc:room:${day}`;
      // QUEUE_IMG_DOCTOR_V1 — диагностику ведёт ВРАЧ, а не аппарат: строка с
      // врачом ушла в его линию выше. Аппарат без врача (рентген) остаётся сам
      // себе очередью — там очередь действительно к машине.
      else if (type === 'imaging')           key = `img:${row.service_id}:${day}`;
      else key = `oth:${row.service_id}:${day}`;

      // One number per patient per destination+day (they queue there once)…
      const mine = db.prepare(`
        SELECT vs.queue_no FROM visit_services vs
          JOIN visits v ON v.id = vs.visit_id
         WHERE vs.queue_key = ? AND v.patient_id = ? AND vs.queue_no IS NOT NULL
         LIMIT 1
      `).get(key, row.patient_id);
      let number;
      if (mine) number = mine.queue_no;
      else {
        // …otherwise the next place in that destination's line.
        const mx = db.prepare('SELECT MAX(queue_no) m FROM visit_services WHERE queue_key = ?').get(key);
        number = (mx && mx.m ? mx.m : 0) + 1;
      }

      db.prepare('UPDATE visit_services SET queue_key = ?, queue_no = ? WHERE id = ?').run(key, number, row.id);
      tickets.push({ visit_service_id: row.id, queue_key: key, label: labelFor(db, row, key), number });
    }
    return tickets;
  });

  return run();
}

// Human label for the destination — printed above the number on the slip.
export function labelFor(db, row, key) {
  if (key.startsWith('lab:')) return 'Лаборатория';
  if (key.startsWith('doc:') || key.startsWith('proc:doc:')) {
    const doc = row.doctor_id ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(row.doctor_id) : null;
    const name = (doc && doc.full_name) || 'Врач';
    return key.startsWith('proc:') ? 'Процедуры · ' + name : name;
  }
  if (key.startsWith('proc:room:')) return 'Процедурный кабинет';
  // QUEUE_IMG_DOCTOR_V1 — очередь диагностики теперь у врача, поэтому и
  // подпись его, а не название аппарата.
  if (key.startsWith('img:doc:')) {
    const doc = row.doctor_id ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(row.doctor_id) : null;
    return 'Диагностика · ' + ((doc && doc.full_name) || 'Врач');
  }
  if (key.startsWith('img:')) return row.svc_name || 'Диагностика';
  return row.svc_name || 'Услуга';
}

// ---------------------------------------------------------------------------
// QUEUE_BOARD_V1 — читающая сторона очереди: «кто у кого стоит прямо сейчас».
// ---------------------------------------------------------------------------
// Номера выдавались с самого начала (issueQueueNumbers выше) и печатались на
// талоне, но показать их обратно было негде: сотрудник видел очередь только
// глазами в коридоре. Этот RPC собирает доску по назначениям за день.
//
// ДЕНЬ. В queue_key день лежит последним сегментом и берётся как первые 10
// символов scheduled_at/visit_date — то есть ровно та строка, что записана в
// визите. Доска фильтрует по ней же (LIKE '%:'||day), а не пересчитывает дату
// заново: разойдись эти два способа, талон в руках пациента и доска на экране
// показывали бы разные очереди. По умолчанию берём клинический «сегодня»
// (domain/day.js), потому что именно это сотрудник имеет в виду.
const BOARD_KEY = 'queue';

// Порядок групп на доске. Врачи первыми — ради них раздел и заводился;
// процедурная, лаборатория и аппараты идут следом.
const KIND_ORDER = { doctor: 0, procedure: 1, lab: 2, imaging: 3, other: 4 };

function kindOf(key) {
  if (key.startsWith('lab:')) return 'lab';
  if (key.startsWith('proc:')) return 'procedure';   // раньше doc: — 'proc:doc:' тоже процедура
  if (key.startsWith('img:')) return 'imaging';
  if (key.startsWith('doc:')) return 'doctor';
  return 'other';
}

// Состояние ОДНОЙ услуги в талоне. 'collected'/'resulted' — лабораторные
// промежуточные статусы (LAB_HANDLING_V1): проба уже в работе, значит человек
// в очереди больше не стоит.
// FREE_SERVICE_V1 — у бесплатной услуги (total = 0) оплаты не бывает, поэтому
// 'added' у неё значит не «ждёт кассу», а просто «ждёт приёма». Счёт закрывает
// эту строку сам (billing.js), но страховка нужна и здесь: строку могли завести
// вообще без счёта, и тогда она осталась бы «ожидает оплату» навсегда.
function lineState(status, total) {
  const s = String(status || '');
  if (s === 'completed') return 'done';
  if (s === 'in_progress' || s === 'collected' || s === 'resulted') return 'serving';
  if (s === 'added') return Number(total) === 0 ? 'waiting' : 'unpaid';   // номер выдан, счёт ещё не оплачен
  return 'waiting';                     // queued и всё остальное
}

// Состояние ТАЛОНА. Один номер может закрывать несколько услуг (у лаборатории
// это норма: все анализы пациента идут под одним номером), поэтому берём самое
// «активное» из них — талон закрыт только когда закрыто всё.
const STATE_RANK = { serving: 0, waiting: 1, unpaid: 2, done: 3 };
function ticketState(states) {
  return states.slice().sort((a, b) => STATE_RANK[a] - STATE_RANK[b])[0] || 'done';
}

export function queueBoard(db, args, user) {
  if (!canViewSection(db, user, BOARD_KEY)) {
    throw new RpcError('Раздел «Очередь» вам не выдан.', 403);
  }
  const a = args || {};
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(a.day || '')) ? String(a.day) : today(db);

  const rows = db.prepare(`
    SELECT vs.id, vs.queue_key, vs.queue_no, vs.status, vs.total, vs.doctor_id, vs.service_id,
           v.patient_id,
           p.full_name AS patient_name,
           s.name      AS svc_name,
           s.requires_doctor
      FROM visit_services vs
      JOIN visits v        ON v.id = vs.visit_id
      LEFT JOIN patients p ON p.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
     WHERE vs.queue_no IS NOT NULL
       AND vs.queue_key IS NOT NULL
       AND vs.queue_key LIKE ?
     ORDER BY vs.queue_no, vs.id
  `).all('%:' + day);

  // key -> группа, внутри неё номер -> талон.
  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.queue_key);
    if (!g) {
      g = {
        key: r.queue_key,
        kind: kindOf(r.queue_key),
        // Подпись берём у того же labelFor, что печатает талон: пусть экран и
        // бумага в руках пациента называют очередь одинаково.
        label: labelFor(db, r, r.queue_key),
        doctor_id: r.doctor_id || null,
        tickets: new Map(),
      };
      groups.set(r.queue_key, g);
    }
    let t = g.tickets.get(r.queue_no);
    if (!t) {
      t = { number: r.queue_no, patient_id: r.patient_id, patient_name: r.patient_name || '—', services: [], _states: [] };
      g.tickets.set(r.queue_no, t);
    }
    if (r.svc_name) t.services.push(r.svc_name);
    t._states.push(lineState(r.status, r.total));
  }

  const out = [...groups.values()].map((g) => {
    const tickets = [...g.tickets.values()]
      .map((t) => ({
        number: t.number,
        patient_name: t.patient_name,
        services: t.services,
        state: ticketState(t._states),
      }))
      .sort((x, y) => x.number - y.number);

    const count = (st) => tickets.filter((t) => t.state === st).length;
    return {
      key: g.key,
      kind: g.kind,
      label: g.label,
      doctor_id: g.doctor_id,
      // Приглашённых может оказаться больше одного (врач завёл следующего, не
      // закрыв предыдущего) — отдаём списком, а не одним числом, чтобы доска
      // не врала молча.
      now: tickets.filter((t) => t.state === 'serving').map((t) => t.number),
      serving_count: count('serving'),
      waiting_count: count('waiting'),
      unpaid_count: count('unpaid'),
      done_count: count('done'),
      total: tickets.length,
      tickets,
    };
  });

  out.sort((x, y) =>
    (KIND_ORDER[x.kind] - KIND_ORDER[y.kind]) || x.label.localeCompare(y.label, 'ru'));

  return { day, groups: out };
}
