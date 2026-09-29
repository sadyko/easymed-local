// CRM_MULTI_SOURCE_V1 (2026-09-29) — НЕСКОЛЬКО ИСТОЧНИКОВ У ЗАЯВКИ: СЕРВЕР.
//
// Правило чтения одно на экран и сервер (public/js/admin/crm-sources.js,
// leadSources): источники = sources, если это непустой массив, иначе [source],
// иначе ['other']. Здесь — его SQL-запись для json_each (отчёт колл-центра).
// Обе записи проверяет одна таблица примеров (sources.test.js).

import { leadSources, MAX_LEAD_SOURCES } from '../../../public/js/admin/crm-sources.js';
import { rpcT } from '../server-message.js';   // V3120_I18N — собранные фразы переводятся на экране
import { compile } from '../../db/query-compiler.js';

/** Отказ записи источников: маршрут отвечает 400 словами (с шаблоном перевода). */
export class CrmSourcesError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Проверить присланный `sources` и вернуть его копией.
 *   • массив непустых строк — иначе отказ;
 *   • 1..MAX_LEAD_SOURCES ключей, без повторов;
 *   • каждый ключ — из справочника crm_sources; СКРЫТЫЙ ключ проходит, только
 *     если он уже стоит у каждой заявки, которую правят (`held()` — их
 *     источники по правилу чтения; у новой заявки их нет).
 * @param {() => string[][]} held
 */
function checkSources(db, value, held) {
  if (!Array.isArray(value) || value.some((k) => typeof k !== 'string' || k === '')) {
    throw new CrmSourcesError('Источники заявки — это список ключей из справочника источников.');
  }
  if (!value.length) throw new CrmSourcesError('Нужен хотя бы один источник.');
  if (value.length > MAX_LEAD_SOURCES) {
    throw rpcT(CrmSourcesError, 'У заявки может быть не больше {max} источников.', { max: MAX_LEAD_SOURCES }, 400);
  }
  const seen = new Set();
  for (const k of value) {
    if (seen.has(k)) throw rpcT(CrmSourcesError, 'Источник «{key}» указан дважды.', { key: k }, 400);
    seen.add(k);
  }
  const dict = new Map(db.prepare('SELECT key, label, is_active FROM crm_sources').all().map((s) => [s.key, s]));
  let rows = null;
  for (const k of value) {
    const s = dict.get(k);
    if (!s) throw rpcT(CrmSourcesError, 'Источника «{key}» нет в справочнике.', { key: k }, 400);
    if (s.is_active) continue;
    if (rows === null) rows = held();
    if (!rows.length || !rows.every((have) => have.includes(k))) {
      throw rpcT(CrmSourcesError, 'Источник «{label}» скрыт в настройках — его оставляют только у заявок, где он уже стоит.', { label: s.label }, 400);
    }
  }
  return value.slice();
}

/**
 * Источники заявок, которые задевает правка, — тем же compile(), что и сама
 * правка: те же права, тот же отбор (оператору — свои и ничьи).
 * @returns {string[][]}
 */
function heldSources(db, body, user) {
  try {
    const sel = compile({ table: 'crm_requests', op: 'select', columns: 'id,source,sources', filters: body.filters }, user, { db });
    return db.prepare(sel.sql).all(...sel.params).map(leadSources);
  } catch { return []; }
}

/**
 * ЗАПИСЬ ИСТОЧНИКОВ ЗАЯВКИ — единственная дверь /api/db (routes/db.js).
 *
 * Держит равенство «source = sources[0]» на сервере, а не на экране:
 *   • в строке есть `sources` — проверить (checkSources) и поставить
 *     `source = sources[0]`, что бы ни прислали в source;
 *   • есть только непустой `source` — `sources = [source]`: старый экран и
 *     соседи пишут одно поле, и два поля не должны разойтись;
 *   • нет ни того, ни другого — строка не трогается.
 * Строки тела правятся НА МЕСТЕ; вызывающий перекомпилирует запрос, если
 * вернулось true. Отказ — CrmSourcesError (маршрут отвечает 400).
 * @returns {boolean} тело поправлено
 */
export function crmSourcesWrite(db, meta, body, user) {
  if (!meta || meta.table !== 'crm_requests') return false;
  if (meta.op !== 'insert' && meta.op !== 'update' && meta.op !== 'upsert') return false;
  const rows = Array.isArray(body && body.values) ? body.values : (body && body.values ? [body.values] : []);
  // Уже стоящие источники нужны только правке (у вставки их нет) и только
  // когда пришёл скрытый ключ — один запрос на всё тело.
  let heldCache = null;
  const held = () => {
    if (meta.op !== 'update') return [];
    if (heldCache === null) heldCache = heldSources(db, body, user);
    return heldCache;
  };
  let changed = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (own(row, 'sources')) {
      const keys = checkSources(db, row.sources, held);
      row.sources = keys;
      row.source = keys[0];
      changed = true;
    } else if (own(row, 'source') && row.source != null && String(row.source) !== '') {
      row.sources = [String(row.source)];
      changed = true;
    }
  }
  return changed;
}

/**
 * JSON-массив источников заявки по правилу чтения — SQL-выражение над строкой
 * crm_requests с псевдонимом `alias`. В массиве `sources` в счёт идут только
 * непустые строки (как в leadSources); если такой нет ни одной — [source],
 * без source — ["other"]. Повторы убирает потребитель (COUNT(DISTINCT r.id)).
 * @param {string} alias псевдоним crm_requests в запросе (только буквы/_)
 */
export function leadSourcesSql(alias = 'r') {
  if (!/^[A-Za-z_]\w*$/.test(alias)) throw new Error('leadSourcesSql: bad alias');
  const s = `${alias}.sources`;
  const one = `CAST(${alias}.source AS TEXT)`;
  return `(CASE WHEN json_valid(${s}) AND json_type(${s}) = 'array'
                     AND EXISTS (SELECT 1 FROM json_each(${s}) AS _s0 WHERE _s0.type = 'text' AND _s0.value <> '')
                THEN ${s}
                WHEN COALESCE(${one}, '') <> '' THEN json_array(${one})
                ELSE json_array('other') END)`;
}

/**
 * Заявка — строками по источнику: `FROM crm_requests r, ${join} WHERE … AND ${ok}`.
 * `ok` отбрасывает то, что правило чтения не считает ключом (не строка, пусто).
 * @returns {{join: string, ok: string}}
 */
export function sourceEachSql(alias = 'r', as = 'src') {
  if (!/^[A-Za-z_]\w*$/.test(as)) throw new Error('sourceEachSql: bad alias');
  return {
    join: `json_each(${leadSourcesSql(alias)}) AS ${as}`,
    ok: `${as}.type = 'text' AND ${as}.value <> ''`,
  };
}
