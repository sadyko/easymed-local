// ═══════════════════════════════════════════════════════════════════════════
// CRM_UNIFY_V1 (2026-10-09) — ОКНО ПОВТОРНОГО ОБРАЩЕНИЯ (решение владельца 4)
// ═══════════════════════════════════════════════════════════════════════════
//
// Звонок или новая запись в пределах окна от ПОСЛЕДНЕГО ДВИЖЕНИЯ карточки — та
// же карточка, без дублей. После окна открытая карточка возвращается в начало
// воронки (одна карточка, история внутри); закрытая («Пришёл», «Отказ», «Не
// пришёл») — заводится новая с тем же пациентом. Закрытая в пределах окна —
// новой нет, и закрытую не трогают (Р5). Приход на уже назначенную запись — не
// новое обращение: окно его не касается (crm/visit-link.js шаг C,
// crm/visit-status.js).
//
// ПОСЛЕДНЕЕ ДВИЖЕНИЕ (Р2) — crm_requests.updated_at, без него — created_at: его
// двигает каждый писатель карточки (/api/db и каждый серверный переход). Звонок
// и задача — не движение карточки. ОКНО — настройка «CRM-канбан»
// (crm_settings.window_hours, по умолчанию 72; windowHours в config.js).
//
// ОДНО ПРАВИЛО, ОДНА ФУНКЦИЯ: «двигалась ли карточка в окне» — inWindowSql
// (SQL; одно место, где сравнивается время) с параметром windowArg. Его зовут:
// звонок (lead-from-call.js через contactDecision), новая запись колл-центра
// (visit-link.js шаг E через contactDecision), стойка (visit-link.js
// deskCloses), ожидание прихода (visit-link.js waitsForDay) и правило прихода
// (visit-status.js settleLineless). Исходящий звонок — работа оператора, окно
// его не касается (Р4).
import { openStageKeys, windowHours, DEFAULT_WINDOW_HOURS } from './config.js';

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
 * Вернуть ОТКРЫТУЮ карточку в начало воронки: новое обращение после окна.
 * Отмечается движением (updated_at) — окно начинается заново. Дата и всё
 * остальное не меняются: одна карточка, история внутри. Закрытую не трогает.
 * @returns {boolean} вернулась ли
 */
export function reopenLead(db, id) {
  const first = firstStageKey(db);
  const open = openStageKeys(db);
  if (!first || !open.length) return false;
  return db.prepare(`UPDATE crm_requests SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                      WHERE id = ? AND status IN (${holes(open)})`).run(first, id, ...open).changes > 0;
}

/**
 * Решение по новому обращению человека.
 * @param {Array<number|{id:number}>} leads — ВСЕ его карточки (любые ступени)
 * @returns {{lead: {id:number,status:string}|null, action: 'same'|'reopen'|'closed'|'new'}}
 *   same   — открытая карточка в окне: та же, без движения;
 *   reopen — открытая после окна: та же, вернуть в начало (reopenLead);
 *   closed — открытой нет, закрытая в окне: новой нет, закрытую не трогать;
 *   new    — открытой нет, закрытая (если есть) — за окном: новая карточка.
 * Открытая важнее закрытой, даже если закрытая свежее; из нескольких — с
 * последним движением.
 */
export function contactDecision(db, leads, { hours = windowHours(db) } = {}) {
  const ids = [...new Set((leads || []).map((l) => Number(l && typeof l === 'object' ? l.id : l)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { lead: null, action: 'new' };
  const rows = db.prepare(`
    SELECT r.id, r.status, (${inWindowSql('r')}) AS fresh, COALESCE(NULLIF(r.updated_at, ''), r.created_at) AS last
      FROM crm_requests r WHERE r.id IN (${holes(ids)})
     ORDER BY julianday(last) DESC, r.id DESC`).all(windowArg(hours), ...ids);
  const open = new Set(openStageKeys(db));
  const pick = (r) => ({ id: r.id, status: r.status });
  const live = rows.find((r) => open.has(r.status));
  if (live) return { lead: pick(live), action: live.fresh ? 'same' : 'reopen' };
  const last = rows[0];
  if (last && last.fresh) return { lead: pick(last), action: 'closed' };
  return { lead: null, action: 'new' };
}
