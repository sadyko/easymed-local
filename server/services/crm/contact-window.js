// ═══════════════════════════════════════════════════════════════════════════
// CRM_UNIFY_V1 (2026-10-09) — ОКНО ПОВТОРНОГО ОБРАЩЕНИЯ (решение владельца 4)
// ═══════════════════════════════════════════════════════════════════════════
//
// Звонок или новая запись в пределах окна от ПОСЛЕДНЕГО ДВИЖЕНИЯ карточки — та
// же карточка, без дублей. После окна открытая карточка возвращается в начало
// воронки (одна карточка, история внутри); закрытая («Пришёл», «Отказ» и прочие
// проигрышные) — заводится новая с тем же пациентом. Закрытая в пределах окна —
// новой нет, и закрытую не трогают (Р5). Приход на уже назначенную запись — не
// новое обращение: окно его не касается (crm/visit-link.js шаг C,
// crm/visit-status.js).
//
// CRM_UNIFY_V1 (ревью задач 5–6, решения контролёра):
//   I-3 — сидовая «Не пришёл» НЕ закрытая: её поставил сервер по отсутствию, и
//         пациент, который перезванивает или перезаписывается, — тот же случай.
//         В окне — та же карточка (запись переводит её в «Колонку записи»),
//         после окна — возвращается в начало, как любая открытая (liveKeys).
//   I-4 — карточка, которая ЖДЁТ будущее (дата сегодня или позже, ждущая строка
//         на сегодня или позже, живая запись сегодня или позже — строкой или
//         привязкой), — «та же» при любой давности: звонок пациента, записанного
//         три недели назад на послезавтра, его карточку в начало не возвращает.
//
// ПОСЛЕДНЕЕ ДВИЖЕНИЕ (Р2) — crm_requests.updated_at, без него — created_at: его
// двигает каждый писатель карточки через /api/db, запись, звонок и приход.
// CRM_UNIFY_V1 (ревью, I-5) — КТО ДВИГАЕТ updated_at (решение контролёра):
//   • ДВИГАЕТ — контакт или работа человека с карточкой: правка через /api/db;
//     запись (visit-link.js шаг G, сверка зеркала touchRequest); приход —
//     стойка, отметка, деньги, работа (visit-status.js, человек в клинике);
//     звонок или запись после окна (reopenLead); привязка новой карты
//     (new-patient-link.js); возврат пустого визита (discard_empty_visit —
//     действие регистратуры сразу после записи).
//   • НЕ ДВИГАЕТ — переходы, которые сервер делает сам: «Не пришёл» проходом
//     (no-show.js) и по календарю, отмена записи (visit-status.js), перенос
//     «Колонки конверсии» (config.js), разовое исправление (unify-repair.js).
//   Звонок в окне и задача — тоже не движение. ОКНО — настройка
// «CRM-канбан» (crm_settings.window_hours, по умолчанию 72; windowHours в
// config.js).
//
// ОДНО ПРАВИЛО, ОДНА ФУНКЦИЯ: «двигалась ли карточка в окне» — inWindowSql
// (SQL; одно место, где сравнивается время) с параметром windowArg. Его зовут:
// звонок (lead-from-call.js через contactDecision), новая запись колл-центра
// (visit-link.js шаг E через contactDecision), стойка (visit-link.js
// deskCloses), ожидание прихода (visit-link.js waitsForDay) и правило прихода
// (visit-status.js settleLineless). Исходящий звонок — работа оператора, окно
// его не касается (Р4).
import { openStageKeys, windowHours, DEFAULT_WINDOW_HOURS, SEED_NO_SHOW_STAGE } from './config.js';
import { localDate, today } from '../domain/day.js';   // CRM_UNIFY_V1 (ревью, I-4)

const holes = (a) => a.map(() => '?').join(',');

/**
 * SQL: карточка `alias` двигалась в окне. Один параметр — windowArg(hours).
 * Сравнение во времени SQLite (julianday): то же, чем пишутся updated_at и
 * created_at, без разбора дат в JS.
 */
export function inWindowSql(alias = 'r') {
  return `julianday(COALESCE(NULLIF(${alias}.updated_at, ''), ${alias}.created_at)) >= julianday('now', ?)`;
}

/** Параметр inWindowSql: '-72 hours'. Пустое или неверное окно — по умолчанию. */
export function windowArg(hours) {
  const h = Number(hours);
  return `-${Number.isFinite(h) && h > 0 ? h : DEFAULT_WINDOW_HOURS} hours`;
}

/** Двигалась ли карточка в окне (hours — по умолчанию из настройки). */
export function leadInWindow(db, requestId, hours = windowHours(db)) {
  return !!db.prepare(`SELECT 1 FROM crm_requests r WHERE r.id = ? AND ${inWindowSql('r')}`).get(requestId, windowArg(hours));
}

/** Первая открытая ВИДИМАЯ колонка — начало воронки («Новый лид» у клиники, Р3). null — некуда. */
export function firstStageKey(db) {
  try {
    const r = db.prepare("SELECT key FROM crm_stages WHERE kind = 'open' AND is_active = 1 ORDER BY position, key LIMIT 1").get();
    return r ? r.key : null;
  } catch { return null; }
}

/**
 * CRM_UNIFY_V1 (ревью, I-3) — колонки, в которых карточка ЖИВА для нового
 * обращения: открытые и сидовая «Не пришёл». Закрыты — конверсия и прочие
 * проигрышные («Отказ», «Нецелевой»).
 */
export function liveKeys(db) {
  return [...new Set([...openStageKeys(db), SEED_NO_SHOW_STAGE])];
}

/**
 * Вернуть ЖИВУЮ карточку (открытую или сидовую «Не пришёл», I-3) в начало
 * воронки: новое обращение после окна — это контакт, поэтому отмечается
 * движением (updated_at), и окно начинается заново. Дата и всё остальное не
 * меняются: одна карточка, история внутри. Закрытую не трогает.
 * @returns {boolean} вернулась ли
 */
export function reopenLead(db, id) {
  const first = firstStageKey(db);
  const live = liveKeys(db);
  if (!first || !live.length) return false;
  return db.prepare(`UPDATE crm_requests SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                      WHERE id = ? AND status IN (${holes(live)})`).run(first, id, ...live).changes > 0;
}

/**
 * CRM_UNIFY_V1 (ревью, I-4) — SQL: карточка `alias` ЖДЁТ сегодня или позже. Один
 * параметр — сегодняшний местный день (today(db)), именованный @today.
 */
function waitsAheadSql(alias = 'r') {
  const live = "v.status NOT IN ('cancelled', 'no_show')";
  return `((${alias}.scheduled_date IS NOT NULL AND ${alias}.scheduled_date <> '' AND date(${alias}.scheduled_date) >= date(@today))
     OR EXISTS (SELECT 1 FROM crm_request_services l WHERE l.request_id = ${alias}.id AND l.status = 'pending'
                   AND date(l.scheduled_date) >= date(@today))
     OR EXISTS (SELECT 1 FROM crm_request_services l JOIN visits v ON v.id = l.visit_id
                 WHERE l.request_id = ${alias}.id AND l.status = 'pending' AND ${live} AND ${localDate('v.visit_date')} >= date(@today))
     OR EXISTS (SELECT 1 FROM crm_booking_links b JOIN visits v ON v.id = b.visit_id
                 WHERE b.request_id = ${alias}.id AND ${live} AND ${localDate('v.visit_date')} >= date(@today)))`;
}

/**
 * Решение по новому обращению человека.
 * @param {Array<number|{id:number}>} leads — ВСЕ его карточки (любые ступени)
 * @returns {{lead: {id:number,status:string}|null, action: 'same'|'reopen'|'closed'|'new'}}
 *   same   — живая карточка (открытая или «Не пришёл», I-3) в окне или ждущая
 *            будущего (I-4): та же, без движения;
 *   reopen — живая после окна и ничего не ждёт: та же, вернуть в начало (reopenLead);
 *   closed — живой нет, закрытая в окне: новой нет, закрытую не трогать;
 *   new    — живой нет, закрытая (если есть) — за окном: новая карточка.
 * Живая важнее закрытой, даже если закрытая свежее; из нескольких — с
 * последним движением.
 */
export function contactDecision(db, leads, { hours = windowHours(db) } = {}) {
  const ids = [...new Set((leads || []).map((l) => Number(l && typeof l === 'object' ? l.id : l)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { lead: null, action: 'new' };
  // Именованные параметры: окно (@win) и сегодня (@today); номера карточек — @i0…
  const named = Object.fromEntries(ids.map((id, i) => ['i' + i, id]));
  const rows = db.prepare(`
    SELECT r.id, r.status, (${inWindowSql('r').replace('?', '@win')}) AS fresh, (${waitsAheadSql('r')}) AS ahead,
           COALESCE(NULLIF(r.updated_at, ''), r.created_at) AS last
      FROM crm_requests r WHERE r.id IN (${ids.map((_, i) => '@i' + i).join(',')})
     ORDER BY julianday(last) DESC, r.id DESC`).all({ win: windowArg(hours), today: today(db), ...named });
  const liveSet = new Set(liveKeys(db));   // CRM_UNIFY_V1 (ревью, I-3) — и «Не пришёл»
  const pick = (r) => ({ id: r.id, status: r.status });
  const live = rows.find((r) => liveSet.has(r.status));
  if (live) return { lead: pick(live), action: live.fresh || live.ahead ? 'same' : 'reopen' };   // I-4 — ждёт будущее
  const last = rows[0];
  if (last && last.fresh) return { lead: pick(last), action: 'closed' };
  return { lead: null, action: 'new' };
}
