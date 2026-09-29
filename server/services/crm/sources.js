// CRM_MULTI_SOURCE_V1 (2026-09-29) — НЕСКОЛЬКО ИСТОЧНИКОВ У ЗАЯВКИ: СЕРВЕР.
//
// Правило чтения одно на экран и сервер (public/js/admin/crm-sources.js,
// leadSources): источники = sources, если это непустой массив, иначе [source],
// иначе ['other']. Здесь — его SQL-запись для json_each (отчёт колл-центра).
// Обе записи проверяет одна таблица примеров (sources.test.js).

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
