// CRM_CALENDAR_MIRROR_V1 — ДВЕРЬ /api/db ТОЖЕ ЗЕРКАЛИТ.
//
// Строки визита вставляют, правят и удаляют ЧЕТЫРЕ экрана (мастер записи,
// окно визита, кабинет врача, счёт визита), строки заявки — карточка CRM. Все
// они ходят через /api/db (routes/db.js), и правило, поставленное в одном
// экране, соблюдалось бы тремя из четырёх. Поэтому зеркало стоит здесь — в
// единственной двери, — а само правило живёт в booking-mirror.js.
//
// Два шага на запрос: mirrorBefore() — ДО записи (что заденет правка: какие
// строки, какие записи; и отказ, если правка трогает то, что уже в счёте или
// в работе), mirrorAfter() — ПОСЛЕ записи (сверка задетых записей). Второй шаг
// молчит при любой ошибке: запись в базу уже состоялась.
import { compile } from '../../db/query-compiler.js';
import {
  mirrorVisit, visitsOfLines, isRefusalStage, cancellableBookingsOf, isEmptyBooking, PRE_ARRIVAL, repriceOwnLine,
} from './booking-mirror.js';
import { calendarBook } from '../rpc/calendar.js';
import { localDate } from '../domain/day.js';
// V3120_FIX — работа над неоплаченной услугой и право «CRM: изменение».
import { unpaidWorkRefusal } from '../visit-status-guard.js';
import { grantAllowsOr } from '../grants.js';
import { sectionLevel } from '../roles.js';

const LINE_KEYS = ['status', 'scheduled_date', 'doctor_id', 'service_id', 'visit_id', 'consultation_type_id'];

function targetIds(db, body, user) {
  const sel = compile({ table: body.table, op: 'select', columns: 'id', filters: body.filters }, user, { db });
  return db.prepare(sel.sql).all(...sel.params).map((r) => r.id);
}

const holes = (a) => a.map(() => '?').join(',');

/**
 * ОТКАЗ ПРАВКЕ СТРОКИ ЗАЯВКИ, ЧЬЯ УСЛУГА УЖЕ НЕ ЗАПИСЬ. Пациент пришёл (строка
 * закрыта), или её строка визита уже в счёте или в работе. Заявка больше не
 * сторона этой услуги — её правят касса и регистратура. Отказ только тогда,
 * когда правка действительно что-то меняет: сохранение карточки ради
 * комментария пишет те же значения и проходить обязано.
 */
function lockedLineRefusal(db, ids, values) {
  if (!ids.length || !values || typeof values !== 'object') return null;
  const keys = LINE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(values, k));
  if (!keys.length) return null;
  const rows = db.prepare(`
    SELECT l.*, vs.status AS vs_status, vs.invoice_item_id AS vs_invoice,
           COALESCE(s.name, ct.name_ru, ct.name) AS service_name
      FROM crm_request_services l
      LEFT JOIN visit_services vs ON vs.id = l.visit_service_id
      LEFT JOIN services s ON s.id = l.service_id
      LEFT JOIN consultation_types ct ON ct.id = l.consultation_type_id
     WHERE l.id IN (${holes(ids)})`).all(...ids);
  for (const r of rows) {
    const changes = keys.some((k) => String(values[k] ?? '') !== String(r[k] ?? ''));
    if (!changes) continue;
    const name = r.service_name || 'услуга';
    if (r.status === 'done') {
      return `Пациент уже пришёл за услугой «${name}» — строку заявки не меняют.`;
    }
    if (r.visit_id != null && r.vs_status != null && (r.vs_status !== 'added' || r.vs_invoice != null)) {
      return `Услуга «${name}» уже в счёте или в работе — изменить её из заявки нельзя.`;
    }
  }
  return null;
}

// V3120_FIX — ТАБЛИЦЫ ДОСКИ ЗАЯВОК. Роль с «CRM: просмотр» видит доску, но не
// ведёт её: не двигает карточки, не берёт их себе, не заводит и не правит
// строки, задачи и метки. Реестр (schema-registry) пускает запись по ШТАТНОЙ
// роли (регистратура, колл-центр), а уровень раздела — свойство роли клиники в
// базе (role_permissions), поэтому проверяется здесь, в единственной двери
// записи, как и остальные правила этой двери.
const CRM_TABLES = new Set(['crm_requests', 'crm_request_services', 'crm_tasks', 'crm_request_tags']);

/**
 * Может ли человек ВЕСТИ заявки. Настроенный ключ «crm» (матрица прав) — его
 * уровень; не настроенный — прежний уровень раздела (sections/levels): только
 * явный «просмотр» закрывает запись. Ненастроенная роль пишет, как и раньше, —
 * по списку ролей реестра.
 */
export function canEditCrm(db, user) {
  try {
    return grantAllowsOr(db, user, 'crm', 'edit', () => sectionLevel(db, user, 'crm') !== 'viewer');
  } catch {
    return true;   // права не прочитались — решает реестр, как до этой проверки
  }
}

/** До записи: что заденет правка. { refusal? } — отказ по-русски. */
export function mirrorBefore(db, meta, body, user) {
  const ctx = { table: meta && meta.table, op: meta && meta.op, ids: [], visits: new Set(), cancelVisits: new Set(), lost: [] };
  if (!meta || meta.op === 'select') return ctx;
  if (CRM_TABLES.has(meta.table) && !canEditCrm(db, user)) {
    ctx.refusal = 'Раздел «CRM · Заявки» выдан вам только на просмотр — менять заявки нельзя.';
    return ctx;
  }
  try {
    if (meta.table === 'visit_services' && (meta.op === 'update' || meta.op === 'delete')) {
      ctx.ids = targetIds(db, body, user);
      // V3120_FIX — неоплаченную услугу в работу не берут (visit-status-guard.js).
      const next = meta.op === 'update' && body && body.values && !Array.isArray(body.values) ? body.values.status : undefined;
      if (next !== undefined && ctx.ids.length) {
        const refusal = unpaidWorkRefusal(db, ctx.ids, next);
        if (refusal) { ctx.refusal = refusal; return ctx; }
      }
      if (ctx.ids.length) {
        for (const r of db.prepare(`SELECT DISTINCT visit_id FROM visit_services WHERE id IN (${holes(ctx.ids)})`).all(...ctx.ids)) {
          if (r.visit_id) ctx.visits.add(r.visit_id);
        }
      }
    } else if (meta.table === 'crm_request_services' && meta.op === 'update') {
      ctx.ids = targetIds(db, body, user);
      const values = (body && body.values) || {};
      ctx.refusal = lockedLineRefusal(db, ctx.ids, values);
      for (const v of visitsOfLines(db, ctx.ids)) ctx.visits.add(v);
      if (values.status === 'cancelled' && ctx.ids.length) {
        // Отмена, снявшая последнюю услугу записанного дня, отменяет и саму
        // запись — но только ту, на которой строка стояла (а не ту, с которой
        // она раньше уехала на другой день).
        for (const r of db.prepare(`SELECT DISTINCT visit_id FROM crm_request_services
                                     WHERE id IN (${holes(ctx.ids)}) AND status = 'pending' AND visit_id IS NOT NULL`).all(...ctx.ids)) {
          ctx.cancelVisits.add(r.visit_id);
        }
      }
    } else if (meta.table === 'crm_requests' && meta.op === 'update') {
      const status = body && body.values && body.values.status;
      if (isRefusalStage(db, status)) {
        const ids = targetIds(db, body, user);
        if (ids.length) {
          ctx.lost = db.prepare(`SELECT id FROM crm_requests WHERE id IN (${holes(ids)}) AND status <> ?`)
            .all(...ids, status).map((r) => r.id);
        }
      }
    }
  } catch (e) {
    console.error('[crm-mirror] правка не разобрана:', e && e.message);
  }
  return ctx;
}

/** Отменить запись той же дверью, что и календарь (calendar_book). */
function cancelBooking(db, v, user) {
  try {
    calendarBook(db, { visit_id: v.id, start: v.visit_date, status: 'cancelled' }, user)
      .catch((e) => console.error('[crm-mirror] запись', v.id, 'не отменена:', e && e.message));
  } catch (e) {
    console.error('[crm-mirror] запись', v.id, 'не отменена:', e && e.message);
  }
}

/** После записи: сверка задетых записей. Не бросает. */
export function mirrorAfter(db, ctx, meta, body, user, { insertedId = null } = {}) {
  if (!meta || meta.op === 'select') return;
  try {
    const actorId = user && user.id;
    const values = (body && body.values) || {};
    const rows = Array.isArray(values) ? values : [values];

    if (meta.table === 'visit_services') {
      if (meta.op === 'insert' || meta.op === 'upsert') {
        for (const r of rows) if (r && r.visit_id) ctx.visits.add(Number(r.visit_id));
      }
      // Врача строки визита сменили в окне визита — строка заявки следует за ним.
      if (meta.op === 'update' && Object.prototype.hasOwnProperty.call(values, 'doctor_id') && ctx.ids.length) {
        db.prepare(`UPDATE crm_request_services SET doctor_id = ?
                     WHERE visit_service_id IN (${holes(ctx.ids)}) AND status = 'pending'`)
          .run(values.doctor_id || null, ...ctx.ids);
      }
      for (const v of ctx.visits) mirrorVisit(db, v, { actorId });
      return;
    }

    if (meta.table === 'crm_request_services') {
      if (meta.op === 'insert') {
        for (const r of rows) if (r && r.visit_id) ctx.visits.add(Number(r.visit_id));
        if (insertedId) {
          const row = db.prepare('SELECT visit_id FROM crm_request_services WHERE id = ?').get(insertedId);
          if (row && row.visit_id) ctx.visits.add(row.visit_id);
        }
      }
      if (meta.op === 'update') {
        for (const v of visitsOfLines(db, ctx.ids)) ctx.visits.add(v);
        // Врача строки заявки сменили в карточке — свободная строка визита
        // следует за ним. Цена меняется только у строки, заведённой зеркалом
        // (M5, booking-mirror.js isOwnLine); чужую пересчитает касса.
        if (Object.prototype.hasOwnProperty.call(values, 'doctor_id') && ctx.ids.length) {
          const linked = db.prepare(`
            SELECT vs.*, v.patient_id, ${localDate('v.visit_date')} AS day, v.status AS visit_status, v.sync_origin AS visit_origin
              FROM crm_request_services l
              JOIN visit_services vs ON vs.id = l.visit_service_id
              JOIN visits v ON v.id = vs.visit_id
             WHERE l.id IN (${holes(ctx.ids)}) AND l.status = 'pending'`).all(...ctx.ids);
          for (const vs of linked) {
            const doc = values.doctor_id || null;
            if (Number(vs.doctor_id || 0) === Number(doc || 0)) continue;
            if (!PRE_ARRIVAL.includes(vs.visit_status) || vs.visit_origin != null) continue;
            if (vs.status !== 'added' || vs.invoice_item_id != null || vs.sync_origin != null) continue;
            if (vs.service_id == null && vs.consultation_type_id == null) continue;
            db.prepare('UPDATE visit_services SET doctor_id = ? WHERE id = ?').run(doc, vs.id);
            repriceOwnLine(db, vs.id);
          }
        }
      }
      for (const v of ctx.visits) mirrorVisit(db, v, { actorId });
      for (const id of ctx.cancelVisits) {
        if (!isEmptyBooking(db, id)) continue;
        const v = db.prepare('SELECT id, visit_date FROM visits WHERE id = ?').get(id);
        if (v) cancelBooking(db, v, user);
      }
      return;
    }

    if (meta.table === 'crm_requests' && ctx.lost.length) {
      // ОТКАЗ В CRM = ОТМЕНА ЗАПИСИ. Заявку перевели в проигрышную колонку
      // («Отказ», «Обработка остановлена» — не «Не пришёл»): её записи до
      // прихода отменяются той же дверью, что в календаре. Запись, в которой
      // есть работа, деньги или строки другой заявки, остаётся — её судьбу
      // решает регистратура.
      for (const rid of ctx.lost) {
        for (const v of cancellableBookingsOf(db, rid)) cancelBooking(db, v, user);
      }
    }
  } catch (e) {
    console.error('[crm-mirror] правка не отражена:', e && e.message);
  }
}
