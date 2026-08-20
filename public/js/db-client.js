// Pure ES module: local Supabase-shaped query-builder client. Runs in both
// the browser (real fetch) and node (fake fetch, for tests) — no DOM/window
// references at module scope. Builds a plain-object "descriptor" that
// matches what server/db/query-compiler.js expects, and POSTs it to `base`
// when awaited.
//
// export function makeDbClient({ fetch, base }) -> { from(table) }

const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'ilike', 'contains', 'in'];

// PostgREST-style .or('a.eq.1,b.in.(2,3),c.is.null') -> [{col,op,val}, ...].
// Parsed on the client into structured OR terms; the server (query-compiler)
// validates every column/op against the registry before it reaches SQL.
function parseOrFilter(spec) {
  return splitTopLevelCommas(String(spec == null ? '' : spec)).map(parseOrTerm).filter(Boolean);
}
// Split on TOP-LEVEL commas only, so the "(1,2,3)" of an `in` term stays whole.
function splitTopLevelCommas(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}
function parseOrTerm(term) {
  const i = term.indexOf('.');
  if (i < 0) return null;
  const j = term.indexOf('.', i + 1);
  if (j < 0) return null;
  const col = term.slice(0, i);
  const op = term.slice(i + 1, j);
  const raw = term.slice(j + 1);
  if (op === 'in') {
    const inner = raw.replace(/^\(/, '').replace(/\)$/, '');
    return { col, op, val: inner === '' ? [] : inner.split(',').map((v) => coerceScalar(v.trim())) };
  }
  return { col, op, val: coerceScalar(raw) };
}
function coerceScalar(v) {
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && /^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function makeDbClient({ fetch, base }) {
  function from(table) {
    const desc = {
      table,
      op: 'select',
      columns: '*',
      filters: [],
      order: [],
    };

    const builder = {
      select(cols = '*', opts) {
        // insert/update/upsert + .select() => returning; otherwise a read projection.
        if (desc.op === 'insert' || desc.op === 'update' || desc.op === 'upsert') {
          desc.returning = true;
        } else {
          desc.op = 'select';
          desc.columns = cols;
        }
        if (opts && opts.count) desc.count = opts.count;
        return builder;
      },
      insert(values) {
        desc.op = 'insert';
        desc.values = values;
        return builder;
      },
      update(values) {
        desc.op = 'update';
        desc.values = values;
        return builder;
      },
      upsert(values, opts) {
        desc.op = 'upsert';
        desc.values = values;
        if (opts) {
          if (opts.onConflict) desc.onConflict = opts.onConflict;
          if (opts.ignoreDuplicates) desc.ignoreDuplicates = true;
        }
        return builder;
      },
      delete() {
        desc.op = 'delete';
        return builder;
      },
      order(col, opts) {
        desc.order.push({ col, asc: !(opts && opts.ascending === false) });
        return builder;
      },
      limit(n) {
        desc.limit = n;
        return builder;
      },
      range(from, to) {
        desc.offset = from;
        desc.limit = to - from + 1;
        return builder;
      },
      or(spec) {
        desc.filters.push({ or: parseOrFilter(spec) });
        return builder;
      },
      single() {
        desc.single = 'single';
        return builder;
      },
      maybeSingle() {
        desc.single = 'maybe';
        return builder;
      },
      then(onFulfilled, onRejected) {
        return run().then(onFulfilled, onRejected);
      },
    };

    for (const op of FILTER_OPS) {
      builder[op] = (col, val) => {
        desc.filters.push({ col, op, val });
        return builder;
      };
    }
    builder.in_ = builder.in;
    // Supabase's negation: .not('doctor_id','is',null), .not('status','in','(a,b)').
    // Encoded as op 'not.<op>'; the compiler wraps the inner term in NOT (...).
    builder.not = (col, op, val) => {
      desc.filters.push({ col, op: 'not.' + op, val });
      return builder;
    };

    async function run() {
      try {
        const res = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(desc),
        });
        const json = await res.json();
        if (!res.ok) {
          // DB_FAIL_LOG_V1 — браузер сам показывает «api/db 400», но не говорит,
          // ЧТО спрашивали. Пишем таблицу, операцию и весь дескриптор: одна
          // строка консоли вместо часа переписки «а какой это был запрос».
          try { console.warn('[db]', res.status, desc.table, desc.op,
            (json.error && json.error.message) || '', JSON.parse(JSON.stringify(desc))); } catch (e) { /* лог не важнее ответа */ }
          return {
            data: null,
            error: json.error || { message: 'Request failed (' + res.status + ')' },
            count: null,
          };
        }
        return { data: json.data ?? null, error: null, count: json.count ?? null };
      } catch (err) {
        return { data: null, error: { message: String(err) }, count: null };
      }
    }

    return builder;
  }

  return { from };
}
