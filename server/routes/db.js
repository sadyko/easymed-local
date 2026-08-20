import { Router } from 'express';
import { compile, CompileError } from '../db/query-compiler.js';
import { readableColumns } from '../db/schema-registry.js';

// The one HTTP door onto the database: every request is compiled through
// the allow-list registry (query-compiler.js) before it touches SQLite.
// Nothing here ever builds SQL text from the request body directly.
export function dbRoutes(db) {
  const r = Router();

  r.post('/', (req, res) => {
    let compiled;
    try {
      compiled = compile(req.body || {}, req.user);
    } catch (e) {
      if (e instanceof CompileError) {
        const status = e.status || 400;
        return res.status(status).json({ error: { code: status === 403 ? 'forbidden' : 'bad_request', message: e.message } });
      }
      throw e;
    }

    try {
      const { sql, params, meta } = compiled;

      if (meta.op === 'select') {
        const rows = db.prepare(sql).all(...params);
        const count = meta.count === 'exact' ? countMatching(db, req.body, req.user) : null;
        return respondRows(res, rows, meta, count);
      }

      if (meta.op === 'insert') {
        // Batch (array) inserts — the Excel importer — compile to one statement
        // per row (ragged keys keep their DB defaults); all-or-nothing in a
        // transaction, and the importer never asks for returning on batches.
        if (meta.multi) {
          db.transaction(() => {
            for (const st of compiled.statements) db.prepare(st.sql).run(...st.params);
          })();
          return res.json({ data: null });
        }
        const info = db.prepare(sql).run(...params);
        if (!meta.returning) return res.json({ data: null });
        const row = db.prepare(
          `SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`
        ).get(info.lastInsertRowid);
        return respondRows(res, [row], meta, null);
      }

      if (meta.op === 'upsert') {
        db.prepare(sql).run(...params);
        // A bulk (array) upsert has no single row to hand back; callers that use
        // it don't request returning. Single-row upsert re-selects below.
        if (!meta.returning || meta.multi) return res.json({ data: null });
        // Re-select by the conflict-target values so `returning` reflects the
        // upserted row whether the write inserted or updated (lastInsertRowid
        // is unreliable on the DO UPDATE path).
        const vals = req.body.values || {};
        const filters = meta.conflictTarget.map((c) => ({ col: c, op: 'eq', val: vals[c] }));
        const sel = compile({ table: meta.table, op: 'select', columns: '*', filters }, req.user);
        const rows = db.prepare(sel.sql).all(...sel.params);
        return respondRows(res, rows, meta, null);
      }

      if (meta.op === 'update') {
        db.prepare(sql).run(...params);
        if (!meta.returning) return res.json({ data: null });
        // Re-select the affected rows using the SAME filters that scoped the
        // update (never the whole table) so `returning` reflects only what
        // was actually touched.
        const sel = compile({ table: req.body.table, op: 'select', columns: '*', filters: req.body.filters }, req.user);
        const rows = db.prepare(sel.sql).all(...sel.params);
        return respondRows(res, rows, meta, null);
      }

      if (meta.op === 'delete') {
        db.prepare(sql).run(...params);
        return res.json({ data: null });
      }
    } catch (e) {
      // DB_CONSTRAINT_ERRORS_V1 — a violated constraint is the CALLER's problem,
      // and the caller is the only one who can fix it. Flattening it into
      // 500 «Query failed.» sent the reason to the server console and left the
      // user with nothing: a laborant linking a service another panel already
      // owns (UNIQUE index, migration 048) simply saw the save fail forever.
      //
      // The detail names a table and column the client already knows from the
      // registry, so echoing it leaks nothing and lets the UI say what happened.
      // Anything that is NOT a constraint stays an opaque 500 — an unexpected
      // failure must not describe the server's internals.
      const code = e && e.code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return res.status(409).json({ error: { code: 'conflict', message: e.message } });
      }
      if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return res.status(409).json({ error: { code: 'conflict', message: e.message } });
      }
      if (code === 'SQLITE_CONSTRAINT_NOTNULL' || code === 'SQLITE_CONSTRAINT_CHECK') {
        return res.status(400).json({ error: { code: 'bad_request', message: e.message } });
      }
      console.error('[db query failed]', e.message);
      return res.status(500).json({ error: { code: 'internal', message: 'Query failed.' } });
    }
  });

  return r;
}

// Shapes the row list according to desc.single: 'single' requires exactly
// one row (406 otherwise), 'maybe' allows zero-or-one, anything else
// returns the full array (plus count, for list views). Embeds are nested
// first so single/maybe/plain/returning all get the same supabase-style
// { ...row, branches: { name } } shape.
function respondRows(res, rows, meta, count) {
  const shaped = parseJsonColumns(reshape(rows, meta), meta);
  if (meta.single === 'single') {
    if (shaped.length !== 1) {
      return res.status(406).json({ error: { code: 'not_single', message: 'Expected exactly one row.' } });
    }
    return res.json({ data: shaped[0] });
  }
  if (meta.single === 'maybe') {
    return res.json({ data: shaped[0] ?? null });
  }
  return res.json({ data: shaped, count });
}

// JSON columns (registry `json: [...]`, e.g. doc_branding.settings) are stored
// as TEXT; parse them back into objects on the way out so callers get the same
// shape Supabase's jsonb gave them. Non-JSON strings / already-parsed values are
// left untouched, and a malformed blob degrades to null rather than throwing.
function parseJsonColumns(rows, meta) {
  const cols = meta.json;
  if (!cols || cols.length === 0) return rows;
  for (const row of rows) {
    if (!row) continue;
    for (const c of cols) {
      if (typeof row[c] === 'string') {
        try { row[c] = JSON.parse(row[c]); } catch { row[c] = null; }
      }
    }
  }
  return rows;
}

// The compiler projects embed columns as flat "path.col" aliases, where path
// is the dotted embed chain ("services.service_types" — NESTED_EMBED_V1 in
// query-compiler.js). Turn those back into the nested supabase-style shape:
// row.services.service_types.name. Deepest paths build first so each parent
// can absorb its children and decide null-collapse over the WHOLE subtree: a
// LEFT JOIN miss returns `null` for that relation (supabase represents an
// absent to-one relation as null, not {col: null}), and a parent whose scalar
// columns AND children are all null collapses to null too.
export function reshape(rows, meta) {   // exported for tests (NESTED_EMBED_V1)
  if (!meta.embeds || meta.embeds.length === 0) return rows;
  const byDepth = [...meta.embeds].sort((a, b) => b.name.split('.').length - a.name.split('.').length);
  return rows.map((row) => {
    const built = new Map();   // path -> nested object | null, children pending absorption
    for (const { name: path, columns } of byDepth) {
      const nested = {};
      let allNull = true;
      for (const col of columns) {
        const key = `${path}.${col}`;
        const val = row[key];
        nested[col] = val === undefined ? null : val;
        if (val !== null && val !== undefined) allNull = false;
        delete row[key];
      }
      for (const [childPath, childObj] of built) {
        if (childPath.startsWith(path + '.') && !childPath.slice(path.length + 1).includes('.')) {
          nested[childPath.slice(path.length + 1)] = childObj;
          if (childObj !== null) allNull = false;
          built.delete(childPath);
        }
      }
      built.set(path, allNull ? null : nested);
    }
    for (const [path, obj] of built) row[path] = obj;   // only top-level paths remain
    return row;
  });
}

// Counts rows matching the request's filters, ignoring limit/offset/order,
// for `count:'exact'` pagination. Reuses the compiler so the count is
// governed by the exact same allow-list as the page it's counting.
function countMatching(db, body, user) {
  const compiled = compile({ table: body.table, op: 'select', columns: 'id', filters: body.filters }, user);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM (${compiled.sql})`).get(...compiled.params);
  return row.n;
}
