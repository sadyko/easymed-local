import { tableEntry, canRead, canWrite, readableColumns, writableColumns, filterAllowed, embedEntry, jsonColumns } from './schema-registry.js';
import { effectiveRoles } from '../services/roles.js';

export class CompileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CompileError';
    this.status = status;
  }
}

const FILTER_OPS = {
  eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', is: 'IS',
};

// TENANCY_NOOP_V1 — the ORIGINAL easymed.uz admin views are multi-tenant:
// every query filters by company_id and/or branch_id (clinic_id shows up in
// a few older call sites), resolving the tenant via get_clinic_by_slug.
// Easy-Med Local is single-clinic, so those columns are meaningless here.
// Rather than forking every view to strip the filter, a filter on one of
// these three exact columns is silently dropped (not added to WHERE, no
// throw) whenever the table doesn't already allow-list it as a real column
// — on tables that DO allow-list branch_id (patients, visits, invoices, ...)
// it still applies normally, since there it's real per-branch data, not a
// tenancy shim. Every OTHER unknown filter column still throws 400; the
// allow-list stays strict for anything that isn't one of these three.
const TENANCY_IGNORE = new Set(['company_id', 'clinic_id', 'branch_id']);

// Every bound value must be a type SQLite/better-sqlite3 can accept as a
// parameter. Rejects objects/arrays/undefined/functions with a clean 400
// instead of letting better-sqlite3 throw a raw TypeError (-> 500), and
// normalizes booleans (SQLite has no boolean type) to 0/1.
function bindable(v) {
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  throw new CompileError('unsupported value type', 400);
}

// Bind a write value, JSON-serialising object/array values destined for a column
// the registry declares as JSON (SQLite has no jsonb — these are TEXT blobs).
// The route parses them back on read (see meta.json). Scalars pass through
// bindable unchanged, so a client that already stringified still works.
function bindWrite(table, col, v) {
  if (v !== null && typeof v === 'object' && jsonColumns(table).includes(col)) {
    return JSON.stringify(v);
  }
  return bindable(v);
}

// PURE: (descriptor, user) -> { sql, params, meta }. Every identifier that
// ends up interpolated into SQL text has been checked against the registry
// (tableEntry/readableColumns/writableColumns/filterAllowed/embedEntry)
// first — nothing from the request body is ever quoted without that check.
// All values (filter/order/limit values excepted, which are validated types)
// are bound as `?` params, never interpolated.
export function compile(desc, user) {
  const table = validateTable(desc.table);
  const op = desc.op;
  if (!['select', 'insert', 'update', 'delete', 'upsert'].includes(op)) {
    throw new CompileError('unknown op', 400);
  }

  // MULTI_ROLE_SERVER_V1 — authorise against the primary role AND the user's
  // extra_roles, not the primary alone. Reading user.role here was why granting
  // someone a second role widened only their sidebar and not their access.
  const role = effectiveRoles(user);
  if (op === 'select') {
    if (!canRead(table, role)) throw new CompileError('not allowed', 403);
    return compileSelect(desc, table);
  }
  // upsert = insert + update: it needs BOTH permissions (a role that can only
  // insert must not gain an update path through ON CONFLICT DO UPDATE).
  if (op === 'upsert') {
    if (!canWrite(table, 'insert', role) || !canWrite(table, 'update', role)) {
      throw new CompileError('not allowed', 403);
    }
    return compileUpsert(desc, table);
  }
  if (!canWrite(table, op, role)) throw new CompileError('not allowed', 403);
  if (op === 'insert') return compileInsert(desc, table);
  if (op === 'update') return compileUpdate(desc, table);
  return compileDelete(desc, table);
}

function validateTable(name) {
  const entry = tableEntry(name);
  if (!entry) throw new CompileError('unknown table', 403);
  return name;
}

function compileSelect(desc, table) {
  const { projection, joins, embeds, joined } = parseColumns(desc.columns, table);
  // EMBED_FILTER_V1 — фильтр по колонке присоединённой таблицы может ПОТРЕБОВАТЬ
  // соединения, которого нет в проекции (см. compileTerm). Поэтому WHERE
  // собирается ДО того, как строка SQL склеена: compileFilters дописывает
  // недостающие JOIN'ы в `joins`, и только потом они попадают в текст запроса —
  // между FROM и WHERE, как того требует синтаксис.
  const { clause, params } = compileFilters(desc.filters, table, { qualify: true, joins, joined });

  let sql = `SELECT ${projection.join(', ')} FROM "${table}"`;
  for (const j of joins) sql += ` ${j}`;
  if (clause) sql += ` WHERE ${clause}`;

  if (desc.order !== undefined) {
    if (!Array.isArray(desc.order)) throw new CompileError('order must be an array', 400);
    const parts = desc.order.map((o) => {
      if (!readableColumns(table).includes(o.col)) throw new CompileError('unknown column', 400);
      return `"${o.col}" ${o.asc === false ? 'DESC' : 'ASC'}`;
    });
    if (parts.length) sql += ` ORDER BY ${parts.join(', ')}`;
  }

  if (desc.limit !== undefined) {
    // Cap: easymed's own views ask for up to 20000 (the import's existing-row
    // match fetch); FK dropdown caches ask 2000. 100k is a sanity ceiling for
    // a single-clinic LAN DB, not a paging mechanism.
    if (!Number.isInteger(desc.limit) || desc.limit < 0 || desc.limit > 100000) {
      throw new CompileError('invalid limit', 400);
    }
    sql += ` LIMIT ${desc.limit}`;
  }
  if (desc.offset !== undefined) {
    if (!Number.isInteger(desc.offset) || desc.offset < 0) {
      throw new CompileError('invalid offset', 400);
    }
    sql += ` OFFSET ${desc.offset}`;
  }

  return {
    sql,
    params,
    meta: { op: 'select', single: desc.single || null, count: desc.count || null, table, embeds, json: jsonColumns(table) },
  };
}

// Splits a projection string at top-level commas, respecting parenthesis
// depth, so "id,full_name,branches(name)" -> ["id", "full_name", "branches(name)"].
function splitTopLevel(columns) {
  const tokens = [];
  let depth = 0;
  let current = '';
  for (const ch of columns) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      tokens.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

// An embed token is `[alias:]relation(subcols)` — the ORIGINAL easymed
// frontend uses PostgREST-style aliased embeds (`from:from_bed_id(code)`) and
// even TWO embeds of the same underlying table in one select (from/to beds).
// The optional `alias:` prefix and the `relation` are separate identifiers;
// the registry lookup is always by `relation` (embedEntry), but the JOIN
// alias and the flat "name.col" projection prefix use the OUTPUT name, which
// is the alias when present and otherwise the relation itself.
//
// EMBED_INNER_V1 (2026-09-05) — `!inner` И `!left` ПОСЛЕ ИМЕНИ СВЯЗИ.
// PostgREST-модификатор соединения: `visits!inner(visit_date)` — «строки без
// родителя выбросить», `!left` — поведение по умолчанию, записанное явно.
// Раньше регулярное выражение не пропускало `!`, токен переставал быть
// embed'ом и падал в ветку обычной колонки — ответ «unknown column
// "visits!inner(...)"», то есть 400 на ВЕСЬ запрос.
//
// ЦЕНА ЭТОГО ПРОБЕЛА БЫЛА НЕ ТОЛЬКО В ЗАПРОСАХ ИЗ BASELINE, А В branch-filter.js.
// Там записано прямо: чтобы отобрать rooms/beds/payments/invoice_items/
// visit_services по филиалу, вид ОБЯЗАН вклеить `${rel}!inner(${col})` — на этом
// стоит вся видимость «своего корпуса». Компилятор не понимал ни `!inner`, ни
// фильтра `visits.branch_id`, поэтому у сотрудника, ограниченного филиалом, эти
// пять экранов отвечали 400 и рисовали пустой список. Такие запросы собираются
// во время работы, поэтому в BASELINE их нет — их там и не могло быть.
const EMBED_TOKEN = /^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*)(!inner|!left)?\((.+)\)$/;

// NESTED_EMBED_V1 — compile one `[alias:]relation(subcols)` token, recursing
// into sub-embeds. easymed's My-services queue nests up to three levels
// (visit_services → users:doctor_id → rooms → floors), so each level
// LEFT-JOINs its table under a dotted alias equal to the output path
// ("users.rooms.floors") and projects every scalar column as "<path>.<col>";
// the route rebuilds the nested object from those aliases (see routes/db.js
// reshape). Registry lookups walk with the recursion: a sub-embed resolves
// against the PARENT EMBED's table (`rooms(...)` inside `doctor_id(...)` uses
// REGISTRY.users.embed.rooms), so each hop is allow-listed independently.
// `parentQual` is the SQL qualifier the FK lives on — the base table at depth
// 0, the parent's path alias below. Output-name aliasing and same-path merge
// behave exactly as the old single-level code: alias wins over relation, two
// tokens with one path merge columns, two aliases of one table join twice.
function compileEmbed(parentTable, parentQual, parentPath, token, out) {
  const [, alias, relation, bang, subcolsRaw] = token.match(EMBED_TOKEN);
  const embed = embedEntry(parentTable, relation);
  if (!embed) throw new CompileError('unknown embed', 403);
  const outName = alias || relation;
  const path = parentPath ? `${parentPath}.${outName}` : outName;

  let entry = out.embedsMap.get(path);
  if (!entry) {
    entry = { columns: [] };
    out.embedsMap.set(path, entry);
    // EMBED_INNER_V1 — `!inner` делает соединение внутренним: строка без
    // родителя выпадает из выборки. Это и есть смысл модификатора у PostgREST,
    // и ровно на нём стоит фильтр по колонке родителя. Первый токен пути
    // задаёт вид соединения: два токена одного пути сливаются по колонкам
    // (см. комментарий выше), и пересобирать уже выданный JOIN значило бы
    // менять смысл запроса задним числом.
    out.joined.set(path, { table: embed.table, inner: bang === '!inner' });
    out.joins.push(`${bang === '!inner' ? 'INNER' : 'LEFT'} JOIN "${embed.table}" AS "${path}"`
      + ` ON "${parentQual}"."${embed.fk}" = "${path}"."id"`);
  }
  for (const sub of splitTopLevel(subcolsRaw)) {
    if (EMBED_TOKEN.test(sub)) { compileEmbed(embed.table, path, path, sub, out); continue; }
    if (!embed.columns.includes(sub)) throw new CompileError('unknown embed column', 400);
    if (!entry.columns.includes(sub)) entry.columns.push(sub);
    out.projection.push(`"${path}"."${sub}" AS "${path}.${sub}"`);
  }
}

// Base columns are ALWAYS qualified with the base table ("patients"."id" AS
// "id"), even when there is no embed: a bare "id" would be genuinely
// ambiguous the moment a LEFT JOIN adds a same-named column, and SQLite
// throws "ambiguous column name" for that at execution time — a bug the
// original version had, because its test suite only regex-matched the SQL
// string and never actually ran it. Embed columns are aliased
// "outName.col" (SQLite allows dots inside a quoted alias) so the route can
// reshape them into a nested object without guessing at key names. The JOIN
// is ALWAYS aliased ("beds" AS "from"), which lets two embeds of the same
// table coexist without a duplicate-join SQL error and keeps every embed's
// qualifier equal to its output name.
function parseColumns(columns, table) {
  // easymed's views pass multi-line template-string selects; supabase-js strips
  // whitespace from the select string before parsing, and so do we (column and
  // relation identifiers can never contain whitespace).
  columns = String(columns == null ? '' : columns).replace(/\s+/g, '');
  if (columns === '*') {
    return {
      projection: readableColumns(table).map((c) => `"${table}"."${c}" AS "${c}"`),
      joins: [],
      embeds: [],
      joined: new Map(),
    };
  }

  const tokens = splitTopLevel(columns);
  const projection = [];
  const joins = [];
  const embedsMap = new Map(); // outName -> { embed, columns: [] }
  const joined = new Map();    // path -> { table, inner } — что уже соединено (для фильтров)

  for (const token of tokens) {
    if (EMBED_TOKEN.test(token)) {
      compileEmbed(table, table, '', token, { joins, projection, embedsMap, joined });
      continue;
    }

    if (token === '*') {
      for (const c of readableColumns(table)) projection.push(`"${table}"."${c}" AS "${c}"`);
      continue;
    }

    if (!readableColumns(table).includes(token)) throw new CompileError('unknown column', 400);
    projection.push(`"${table}"."${token}" AS "${token}"`);
  }

  const embeds = [...embedsMap.entries()].map(([name, entry]) => ({ name, columns: entry.columns }));
  return { projection, joins, embeds, joined };
}

// `qualify: true` prefixes every filter column with its base table
// ("visits"."id" instead of "id"). SELECT is the only caller that needs
// this: the moment a query embeds another table, that embed's LEFT JOIN
// brings in its own same-named columns (almost always "id", since every
// embed joins on "<embed_table>"."id" — see parseColumns above), and an
// unqualified WHERE "id" then throws SQLite's "ambiguous column name: id"
// at execution time. UPDATE/DELETE never add joins, so their filters are
// left unqualified (unchanged SQL shape, unchanged tests).
// Compile ONE filter term `{col, op, val}` to `{ sql, params }`. Returns null
// when the term targets a tenancy column the table doesn't allow-list (the
// TENANCY_NOOP_V1 shim — see TENANCY_IGNORE) so the caller can drop it. Every
// column is checked against the registry before it reaches the SQL string.
// EMBED_FILTER_V1 (2026-09-05) — ФИЛЬТР ПО КОЛОНКЕ ПРИСОЕДИНЁННОЙ ТАБЛИЦЫ
// (`visits.branch_id`, `invoices.created_at`). PostgREST это умеет, наш
// компилятор — нет: точка не проходила ни один allow-list, и запрос отвергался
// как «unknown filter column». Из-за этого не работал ВЕСЬ branch-filter.js
// (см. EMBED_INNER_V1) и экспорт отчётов за период.
//
// ДВЕ ДВЕРИ, А НЕ ОДНА. Право отфильтровать по `rel.col` требует ОБОИХ
// разрешений сразу: колонка должна быть в списке `columns` ЭТОГО embed'а (то
// есть эта связь её и так отдаёт на чтение) И в списке `filters` САМОЙ
// присоединённой таблицы. Второе условие — не формальность: реестр намеренно
// разделяет «видно» и «по чему можно искать» (patients.notes читается, но не
// фильтруется — иначе фильтр становится оракулом для перебора текста заметки).
// Без второй двери фильтрация через embed обходила бы это различие.
//
// ЧЕГО НЕТ ЛОКАЛЬНО — ТО МОЛЧА ОТБРАСЫВАЕТСЯ. `rooms` тянется к филиалу через
// `floors.branch_id`, а `beds` — через `wards.branch_id`, но ни у floors, ни у
// wards колонки branch_id в локальной схеме НЕТ (этажи и палаты здесь не
// привязаны к зданию). Это тот же случай, что и TENANCY_NOOP_V1 у обычных
// колонок, и ответ тот же: условие отбрасывается, список приходит целиком.
// Бросить 400 значило бы показать сотруднику филиала пустой экран вместо
// данных, которые ему и так все видны.
function resolveEmbedFilter(f, table, env) {
  const dot = f.col.indexOf('.');
  if (dot < 0) return undefined;                    // не точечная колонка — обычный путь
  const rel = f.col.slice(0, dot);
  const leaf = f.col.slice(dot + 1);
  const tenancy = TENANCY_IGNORE.has(leaf);
  const embed = leaf.includes('.') ? null : embedEntry(table, rel);
  // UPDATE/DELETE соединений не строят (env === null): точечный фильтр там
  // выразить нечем, поэтому он либо отбрасывается как tenancy-условие, либо
  // отвергается — форма их SQL остаётся прежней.
  if (!embed || !env) return tenancy ? null : reject();
  if (!embed.columns.includes(leaf) || !filterAllowed(embed.table, leaf)) {
    return tenancy ? null : reject();
  }
  if (!env.joined.has(rel)) {
    // Соединения в проекции нет — добавляем сами, и именно ВНУТРЕННИМ:
    // условие на колонку родителя осмысленно только для строк, у которых
    // родитель есть. Связь всегда «многие к одному» (внешний ключ лежит на
    // базовой таблице и смотрит в первичный ключ родителя), поэтому строк
    // после соединения не прибавляется.
    env.joined.set(rel, { table: embed.table, inner: true });
    env.joins.push(`INNER JOIN "${embed.table}" AS "${rel}" ON "${table}"."${embed.fk}" = "${rel}"."id"`);
  }
  return `"${rel}"."${leaf}"`;
  function reject() { throw new CompileError('unknown filter column', 400); }
}

function compileTerm(f, table, qualify, env = null) {
  const embedded = resolveEmbedFilter(f, table, env);
  if (embedded === null) return null;               // отброшено (tenancy / нет колонки локально)
  if (embedded === undefined && !filterAllowed(table, f.col)) {
    if (TENANCY_IGNORE.has(f.col)) return null;
    throw new CompileError('unknown filter column', 400);
  }

  // Supabase's .not(col, op, val) — op arrives as 'not.<op>'. Compile the
  // inner term and negate it: NOT(x IS NULL) = IS NOT NULL, NOT(x IN (...))
  // = NOT IN, and so on for every operator uniformly.
  if (typeof f.op === 'string' && f.op.startsWith('not.')) {
    const inner = compileTerm({ ...f, op: f.op.slice(4) }, table, qualify, env);
    if (!inner) return null;
    return { sql: `NOT (${inner.sql})`, params: inner.params };
  }

  // Точечная колонка уже разобрана в квалификатор присоединённой таблицы.
  const col = embedded !== undefined ? embedded
    : (qualify ? `"${table}"."${f.col}"` : `"${f.col}"`);

  if (f.op === 'in') {
    // .in() sends an array; .not(col,'in','("a","b")') sends PostgREST's raw
    // paren-list string — accept both.
    let list = f.val;
    if (typeof list === 'string' && /^\(.*\)$/.test(list.trim())) {
      list = list.trim().slice(1, -1).split(',')
        .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
        .filter((s) => s.length > 0);
    }
    if (!Array.isArray(list)) throw new CompileError('unsupported operator', 400);
    const vals = list.map(bindable);
    return { sql: `${col} IN (${vals.map(() => '?').join(', ')})`, params: vals };
  }
  // CYRILLIC_ILIKE_V1 — lower_uni (JS UDF, connection.js) folds Unicode case;
  // bare LIKE only folds ASCII, so Cyrillic search was case-sensitive.
  if (f.op === 'ilike') {
    return { sql: `lower_uni(${col}) LIKE lower_uni(?)`, params: [bindable(f.val)] };
  }
  if (f.op === 'contains') {
    bindable(f.val); // type-check only; the raw value is wrapped in % below
    return { sql: `lower_uni(${col}) LIKE lower_uni(?)`, params: [`%${f.val}%`] };
  }
  if (!Object.prototype.hasOwnProperty.call(FILTER_OPS, f.op)) {
    throw new CompileError('unsupported operator', 400);
  }
  // `is` binds NULL: SQLite's `x IS ?` with a NULL param means `x IS NULL`.
  return { sql: `${col} ${FILTER_OPS[f.op]} ?`, params: [bindable(f.val)] };
}

// A filter entry is either a plain term `{col, op, val}` or an OR group
// `{ or: [term, term, ...] }` (from PostgREST-style `.or('a.eq.1,b.eq.2')`).
// OR groups are wrapped in parens and AND'd with the rest. A group whose every
// term is tenancy-dropped contributes nothing (e.g. the local
// `company_id.is.null,company_id.eq.<cid>` collapses to "no constraint").
function compileFilters(filters, table, { qualify = false, joins = null, joined = null } = {}) {
  if (filters !== undefined && !Array.isArray(filters)) {
    throw new CompileError('filters must be an array', 400);
  }
  // env существует только у SELECT: только он строит соединения (см.
  // resolveEmbedFilter). У UPDATE/DELETE его нет, и точечный фильтр там не
  // компилируется — форма их SQL не меняется.
  const env = (joins && joined) ? { joins, joined } : null;
  const params = [];
  const clauses = [];
  for (const f of filters || []) {
    if (f && Array.isArray(f.or)) {
      const subs = [];
      for (const sub of f.or) {
        const t = compileTerm(sub, table, qualify, env);
        if (t) { subs.push(t.sql); params.push(...t.params); }
      }
      if (subs.length) clauses.push(`(${subs.join(' OR ')})`);
      continue;
    }
    const t = compileTerm(f, table, qualify, env);
    if (t) { clauses.push(t.sql); params.push(...t.params); }
  }
  return { clause: clauses.join(' AND '), params };
}

// Build one single-row INSERT from a payload object. Compat layer: silently
// drop payload keys outside the writable allow-list (legacy admin payloads
// carry stray/non-existent columns) rather than hard-failing the whole write.
// The allow-list still fully governs what CAN be written — dropping is
// strictly less permissive, never more.
function insertStatement(table, values, allowed) {
  const keys = Object.keys(values || {}).filter((k) => allowed.includes(k));
  if (keys.length === 0) throw new CompileError('no writable columns provided', 400);
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  return {
    sql: `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`,
    params: keys.map((k) => bindWrite(table, k, values[k])),
  };
}

function compileInsert(desc, table) {
  const allowed = writableColumns(table, 'insert');
  // values may be a single object or an array of rows — the section importer
  // (Excel) inserts batches of up to 100 with RAGGED keys: it deliberately
  // leaves empty cells out of the payload "so the DB default fires"
  // (section-import-export.js). A uniform multi-row VALUES list would bind
  // NULL over those defaults, so a batch compiles to one statement PER ROW
  // (each with exactly its own keys); the route runs them in one transaction.
  if (Array.isArray(desc.values)) {
    if (desc.values.length === 0) throw new CompileError('no rows to insert', 400);
    const statements = desc.values.map((row) => insertStatement(table, row, allowed));
    return {
      sql: statements[0].sql,
      params: statements[0].params,
      statements,
      meta: { op: 'insert', returning: !!desc.returning, single: desc.single || null, table, multi: true },
    };
  }

  const { sql, params } = insertStatement(table, desc.values || {}, allowed);
  return {
    sql,
    params,
    meta: { op: 'insert', returning: !!desc.returning, single: desc.single || null, table, multi: false },
  };
}

// INSERT ... ON CONFLICT (<target>) DO UPDATE — the compat layer's .upsert().
// The onConflict target is tenancy-stripped (a local table has no company_id,
// so easymed's `company_id,patient_id_a,patient_id_b` becomes the real UNIQUE
// `patient_id_a,patient_id_b`) and every surviving target column is verified to
// be a real column. DO UPDATE re-applies the update-writable provided columns
// (minus the conflict key) from `excluded`; with nothing left to set it is a
// DO NOTHING. Requires both insert and update permission (checked in compile()).
function compileUpsert(desc, table) {
  const insertAllowed = writableColumns(table, 'insert');
  // values may be a single object or an array of rows (bulk upsert).
  const rows = Array.isArray(desc.values) ? desc.values : [desc.values || {}];
  if (rows.length === 0) throw new CompileError('no rows to upsert', 400);
  // One uniform column list for the multi-row INSERT: the union of provided
  // writable keys across all rows (a row missing a column binds NULL).
  const keys = [];
  for (const row of rows) {
    for (const k of Object.keys(row || {})) {
      if (insertAllowed.includes(k) && !keys.includes(k)) keys.push(k);
    }
  }
  if (keys.length === 0) throw new CompileError('no writable columns provided', 400);

  const rawTarget = typeof desc.onConflict === 'string'
    ? desc.onConflict.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  // Strip a tenancy column from the conflict target ONLY when the table doesn't
  // allow-list it (mirrors compileTerm's filter rule): patient_relationships'
  // `company_id,...` collapses to the real unique key, but a table that DOES
  // allow-list company_id (doc_branding) keeps it as `ON CONFLICT (company_id)`.
  const target = rawTarget.filter((c) => !(TENANCY_IGNORE.has(c) && !filterAllowed(table, c)));
  if (target.length === 0) throw new CompileError('upsert requires an onConflict target', 400);
  for (const c of target) {
    if (!readableColumns(table).includes(c)) throw new CompileError('unknown onConflict column', 400);
  }

  const cols = keys.map((k) => `"${k}"`).join(', ');
  const params = [];
  const rowSql = rows.map((row) => {
    for (const k of keys) params.push(bindWrite(table, k, row && row[k] !== undefined ? row[k] : null));
    return `(${keys.map(() => '?').join(', ')})`;
  });

  const updateAllowed = writableColumns(table, 'update');
  const setCols = keys.filter((k) => updateAllowed.includes(k) && !target.includes(k));
  // Supabase's { ignoreDuplicates: true } -> DO NOTHING; likewise when there is
  // nothing update-writable left to set.
  const action = (desc.ignoreDuplicates || setCols.length === 0)
    ? 'DO NOTHING'
    : `DO UPDATE SET ${setCols.map((k) => `"${k}" = excluded."${k}"`).join(', ')}`;
  const targetSql = target.map((c) => `"${c}"`).join(', ');
  const sql = `INSERT INTO "${table}" (${cols}) VALUES ${rowSql.join(', ')} ON CONFLICT (${targetSql}) ${action}`;

  return {
    sql,
    params,
    meta: { op: 'upsert', returning: !!desc.returning, single: desc.single || null, table, conflictTarget: target, multi: Array.isArray(desc.values) },
  };
}

function compileUpdate(desc, table) {
  const values = desc.values || {};
  const allowed = writableColumns(table, 'update');
  // Compat layer: silently drop payload keys outside the writable allow-list
  // (see compileInsert) rather than hard-failing the whole write.
  const keys = Object.keys(values).filter((k) => allowed.includes(k));
  if (keys.length === 0) throw new CompileError('no writable columns provided', 400);
  if (!desc.filters || desc.filters.length === 0) {
    throw new CompileError('update requires a filter', 400);
  }

  const setParts = keys.map((k) => `"${k}" = ?`);
  const params = keys.map((k) => bindWrite(table, k, values[k]));
  if (readableColumns(table).includes('updated_at')) {
    setParts.push(`"updated_at" = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
  }

  const { clause, params: filterParams } = compileFilters(desc.filters, table);
  const sql = `UPDATE "${table}" SET ${setParts.join(', ')} WHERE ${clause}`;
  params.push(...filterParams);

  return {
    sql,
    params,
    meta: { op: 'update', returning: !!desc.returning, single: desc.single || null, table },
  };
}

function compileDelete(desc, table) {
  if (!desc.filters || desc.filters.length === 0) {
    throw new CompileError('delete requires a filter', 400);
  }
  const { clause, params } = compileFilters(desc.filters, table);
  const sql = `DELETE FROM "${table}" WHERE ${clause}`;
  return { sql, params, meta: { op: 'delete', table } };
}
