// REFERENCE_LISTS_V1 (полировка, 2026-10-10) — КОДЫ ГЕОГРАФИИ НЕ МЕНЯЮТСЯ.
//
// Партнёры по API клиники получают КОДЫ страны, города и района (миграция 132;
// встроенный список и его порядок — public/js/shared/geo-codes.js). Код,
// изменённый в одной клинике, перестал бы совпадать у партнёра, а удалённая
// строка бланка — исчезла бы из адреса. До этой правки /api/db пускал любого
// администратора клиники менять, стирать и удалять эти строки вместе с кодами.
//
// Правила (одна дверь — /api/db, routes/db.js; до записи, база не тронута):
//   • ПРАВКА: код строки, у которой он есть, не меняется и не стирается. Та же
//     правка с тем же кодом проходит — форма «Географии» для страны шлёт
//     name / code / active целиком. Строка без кода (заведена в «Географии»)
//     может получить код, если он не занят и не из бланка.
//   • УДАЛЕНИЕ: строку с кодом бланка удалить нельзя — её выключают (active);
//     свои строки удаляются, как раньше.
//   • ВСТАВКА: новый код не повторяет занятый, код бланка и соседа по пачке.
// Названия и «активна» меняются свободно: переименованная строка сохраняет код
// (так и сказано на экране «Справочники»).
//
// Синхронизация зданий этих таблиц не возит; миграции пишут в базу напрямую —
// страж стоит только на двери /api/db.
import { compile } from '../db/query-compiler.js';
import { isBuiltinGeoCode } from '../../public/js/shared/geo-codes.js';

export const GEO_TABLES = Object.freeze(['countries', 'regions', 'districts']);

// Ключи словаря (public/js/admin/i18n-strings.js): экран переводит их tr().
export const GEO_CODE_MESSAGES = Object.freeze({
  fixed:   'Код в справочнике не меняется никогда: по нему партнёры узнают страну, город и район. Название поменять можно — код останется прежним.',
  taken:   'Такой код в справочнике уже есть — у каждой строки свой код.',
  builtin: 'Строку встроенного справочника удалить нельзя: её код получают партнёры. Её можно выключить.',
});

const norm = (v) => (v == null ? '' : String(v).trim());
const carries = (row, key) => !!row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, key);

// Строки, которых коснётся правка или удаление: тот же отбор, что у записи.
// null — прочитать не вышло (тогда страж отказывает: код дороже правки).
function matchedRows(db, table, body, user) {
  try {
    const sel = compile({ table, op: 'select', columns: 'id, code', filters: (body && body.filters) || [] }, user, { db });
    return db.prepare(sel.sql).all(...sel.params);
  } catch {
    return null;
  }
}

// Код уже стоит у другой строки этой таблицы (кроме строк из except)?
function codeTaken(db, table, code, except = []) {
  const skip = new Set(except.map(Number));
  return db.prepare(`SELECT id FROM "${table}" WHERE TRIM(code) = ?`).all(code).some((r) => !skip.has(Number(r.id)));
}

/** Текст отказа (ключ словаря) или null — запись в справочник географии можно выполнять. */
export function geoCodeRefusal(db, meta, body, user) {
  if (!meta || !GEO_TABLES.includes(meta.table)) return null;
  const table = meta.table;

  if (meta.op === 'insert' || meta.op === 'upsert') {
    const v = body && body.values;
    const seen = new Set();
    for (const row of Array.isArray(v) ? v : [v]) {
      if (!carries(row, 'code')) continue;
      const code = norm(row.code);
      if (!code) continue;
      if (seen.has(code) || isBuiltinGeoCode(table, code) || codeTaken(db, table, code)) return GEO_CODE_MESSAGES.taken;
      seen.add(code);
    }
    return null;
  }

  if (meta.op === 'update') {
    const values = body && body.values;
    if (!carries(values, 'code')) return null;
    const next = norm(values.code);
    const rows = matchedRows(db, table, body, user);
    if (rows === null) return GEO_CODE_MESSAGES.fixed;
    // Код, который у строки есть, — только тот же самый.
    if (rows.some((r) => norm(r.code) && norm(r.code) !== next)) return GEO_CODE_MESSAGES.fixed;
    // Остались строки без кода: получают код, если он один на строку и свободен.
    const fresh = rows.filter((r) => !norm(r.code));
    if (!next || !fresh.length) return null;
    if (rows.length > 1 || isBuiltinGeoCode(table, next) || codeTaken(db, table, next, rows.map((r) => r.id))) return GEO_CODE_MESSAGES.taken;
    return null;
  }

  if (meta.op === 'delete') {
    const rows = matchedRows(db, table, body, user);
    if (rows === null) return GEO_CODE_MESSAGES.builtin;
    return rows.some((r) => isBuiltinGeoCode(table, r.code)) ? GEO_CODE_MESSAGES.builtin : null;
  }
  return null;
}
