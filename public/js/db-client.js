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
// Exported (SCHEMA_FAIL_LOUD_V1): the build-time query check
// (admin/__tests__/db-query-schema.test.mjs) must read an .or() spec with the
// SAME parser the browser uses, or it would validate columns nobody sends.
export function parseOrFilter(spec) {
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

// =========================================================================
// SCHEMA_FAIL_LOUD_V1 (2026-09-05) -- ОТКЛОНЁННЫЙ ЗАПРОС БОЛЬШЕ НЕ
// ПРИТВОРЯЕТСЯ ПУСТЫМ СПИСКОМ.
//
// Три раза подряд экран был пустым по одной и той же причине: запрос просил
// колонку, которой нет в реестре (`patients(mrn, full_name, phone)`,
// `visits.room_id`, `users.license_number`), компилятор отвечал 400 на ВЕСЬ
// запрос, клиент возвращал `{ data: null }`, а вид писал `(data || [])` — и
// ошибка становилась пустотой. Пустота выглядит как «данных ещё нет», поэтому
// календарь записи два года не показывал НИ ОДНОЙ записи, и никто не понял,
// что он сломан.
//
// ПОЧЕМУ НЕ «БРОСАТЬ ИСКЛЮЧЕНИЕ ПО УМОЛЧАНИЮ». Соблазн большой и он неверен.
// Около ста видов написаны как `.then(({ data }) => ...)` — без catch. Если
// отклонённый запрос начнёт бросать, то в день обновления любой запрос,
// который сегодня «просто пустой» (в том числе 403 у роли, у которой честно
// нет доступа, и обрыв сети в клинике на LAN), превратится в необработанный
// reject и уронит экран целиком — вместо пустого списка врач получит белую
// страницу посреди приёма. Это клиника, а не CI: цена «упасть громко» здесь
// выше цены «показать пусто».
//
// ЧТО СДЕЛАНО ВМЕСТО ЭТОГО. Форма результата НЕ ИЗМЕНИЛАСЬ: по-прежнему
// `{ data, error, count }`, по-прежнему `data: null` при ошибке. Ни один из
// ~100 видов не меняет поведения — они так же получат `null` и так же
// нарисуют пустой список. Изменилось то, что рядом с этой пустотой теперь
// ВСЕГДА есть видимый сигнал:
//
//   1. ОШИБКИ РАЗДЕЛЕНЫ ПО ПРИРОДЕ (`error.kind`, см. classifyDbError):
//      'schema' — запрос просит то, чего реестр не отдаёт. Это ВСЕГДА баг
//      программы: он не зависит ни от данных клиники, ни от прав, ни от сети,
//      и воспроизводится у каждого клиента одинаково.
//      'permission' | 'conflict' | 'network' | 'server' | 'request' — всё
//      остальное: законные состояния, на которые виды уже умеют реагировать.
//   2. ТОЛЬКО 'schema' ПОКАЗЫВАЕТСЯ ЧЕЛОВЕКУ — плашкой поверх экрана
//      (schemaBanner ниже): «раздел не загрузился, это ошибка программы».
//      Она не заменяет и не ломает разметку вида, не отменяет ни одного
//      действия, закрывается крестиком, показывается не более трёх раз за
//      сеанс и дедуплицируется по (таблица + сообщение) — сломанный экран,
//      шлющий пятьдесят запросов, даст одну плашку, а не пятьдесят.
//      403/сеть/500 плашки НЕ дают: там пустота — законный ответ, и пугать
//      регистратуру каждым обрывом Wi-Fi нельзя.
//   3. В консоли — console.error с полным дескриптором (было console.warn на
//      всё подряд), плюс указание, каким тестом это ловится.
//   4. onDbQueryFailure(fn) — точка, куда оболочка может повесить свой тост,
//      не трогая этот файл.
//   5. .throwOnError() — явное «мне нужен взрыв» для НОВОГО кода (и для
//      тестов). По умолчанию выключено; включает его только автор вызова.
//
// Настоящая же гарантия — не здесь, а в сборке: admin/__tests__/db-query-schema
// прогоняет КАЖДЫЙ .select() из public/js через настоящий компилятор, и запрос
// к несуществующей колонке падает у нас, а не пустым списком у клиники. Этот
// файл — второй рубеж, на случай запроса, который тест разобрать не смог.
// =========================================================================

// Сообщения query-compiler'а, означающие «запрос сформулирован неверно».
// Держатся строкой, а не кодом ответа, потому что статус их не различает:
// 'unknown table' и 'unknown embed' отвечают 403 — тем же кодом, что и
// честное «этой роли не положено».
const SCHEMA_ERROR_MESSAGES = new Set([
  'unknown table',
  'unknown column',
  'unknown embed',
  'unknown embed column',
  'unknown filter column',
  'unknown onconflict column',
  'unsupported operator',
  'unknown op',
]);

export function classifyDbError(status, message) {
  const m = String(message == null ? '' : message).trim().toLowerCase();
  if (SCHEMA_ERROR_MESSAGES.has(m)) return 'schema';
  if (status === 0) return 'network';
  if (status === 403) return 'permission';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server';
  return 'request';
}

// Куда оболочка может подписаться на неудачные запросы (свой тост, свой лог).
// Один слушатель — этого хватает и не даёт накопить утечку подписок при
// перерисовке видов.
let failureSink = null;
export function onDbQueryFailure(fn) {
  failureSink = typeof fn === 'function' ? fn : null;
  return () => { if (failureSink === fn) failureSink = null; };
}

const BANNER_LIMIT = 3;
const seenSchemaFailures = new Set();
let bannersShown = 0;

// Видимая, но безобидная плашка. Ничего не перерисовывает, ничего не отменяет
// и не зависит ни от ui.js, ни от оболочки — иначе она не работала бы ровно
// на тех экранах, которые сломаны. В node (тесты) молча ничего не делает.
function schemaBanner(info) {
  if (typeof document === 'undefined' || !document.body) return;
  if (bannersShown >= BANNER_LIMIT) return;
  bannersShown++;

  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
    'max-width:420px', 'box-sizing:border-box', 'padding:12px 40px 12px 14px',
    'border:1px solid #d97706', 'border-left:4px solid #d97706', 'border-radius:8px',
    'background:#fffbeb', 'color:#78350f', 'box-shadow:0 6px 24px rgba(0,0,0,.14)',
    'font:13.5px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
  ].join(';');

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;margin-bottom:4px';
  title.textContent = 'Раздел не загрузился: запрос к базе отклонён';
  box.appendChild(title);

  const body = document.createElement('div');
  body.textContent = 'Это ошибка программы, а не ваших данных — список пуст не потому, '
    + 'что записей нет. Сообщите в поддержку: «' + info.table + ' — ' + info.message + '».';
  box.appendChild(body);

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть');
  close.textContent = '×';
  close.style.cssText = 'position:absolute;top:6px;right:8px;border:0;background:none;'
    + 'font-size:20px;line-height:1;cursor:pointer;color:inherit';
  close.addEventListener('click', () => { try { box.remove(); } catch (e) { /* уже снята */ } });
  box.appendChild(close);

  document.body.appendChild(box);
}

// Единственное место, где о неудаче узнаёт мир. Никогда не бросает: отчёт об
// ошибке, уронивший запрос, был бы хуже самой ошибки.
function reportFailure(info, showBanner) {
  try {
    const line = ['[db]', info.status, info.table, info.op, info.kind, info.message];
    if (info.kind === 'schema') {
      console.error(...line, '— ЗАПРОС НЕВЕРЕН (баг программы, а не данные клиники);'
        + ' ловится тестом public/js/admin/__tests__/db-query-schema.test.mjs', info.descriptor);
    } else {
      console.warn(...line, info.descriptor);
    }
  } catch (e) { /* лог не важнее ответа */ }
  try { if (failureSink) failureSink(info); } catch (e) { /* чужой обработчик нам не судья */ }
  if (info.kind !== 'schema' || !showBanner) return;
  const key = info.table + ' ' + info.message;
  if (seenSchemaFailures.has(key)) return;
  seenSchemaFailures.add(key);
  try { schemaBanner(info); } catch (e) { /* без плашки, но с логом */ }
}

// Только для тестов: сбросить дедупликацию, счётчик плашек и подписку.
export function _resetFailureNotices() {
  seenSchemaFailures.clear();
  bannersShown = 0;
  failureSink = null;
}

export function makeDbClient({ fetch, base, banner = true }) {
  function from(table) {
    const desc = {
      table,
      op: 'select',
      columns: '*',
      filters: [],
      order: [],
    };

    let wantsThrow = false;

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
      // Явное «мне нужен взрыв, а не пустой список» — для НОВОГО кода и для
      // тестов. По умолчанию выключено: включить его глобально значило бы
      // уронить сотню существующих видов в день обновления (см. заголовок
      // SCHEMA_FAIL_LOUD_V1).
      throwOnError() {
        wantsThrow = true;
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
      let res, json;
      try {
        res = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(desc),
        });
        json = await res.json();
      } catch (err) {
        // Сеть / нечитаемый ответ: статус 0 — «до сервера не дошло».
        return fail(0, { message: String(err) });
      }
      if (!res.ok) return fail(res.status, json && json.error);
      return { data: json.data ?? null, error: null, count: json.count ?? null, ok: true };
    }

    // Ошибка -> результат ПРЕЖНЕЙ формы (`data: null`), но опознаваемый:
    // `ok:false` и `error.kind`. Виды, читающие только `data`, не замечают
    // разницы; всё, что хочет отличить «пусто» от «отказано», теперь может.
    function fail(status, rawError) {
      const message = (rawError && rawError.message)
        || (status ? 'Request failed (' + status + ')' : 'Request failed');
      const kind = classifyDbError(status, message);
      let descriptor = null;
      try { descriptor = JSON.parse(JSON.stringify(desc)); } catch (e) { /* не сериализуется — переживём */ }
      reportFailure({ status, kind, table: desc.table, op: desc.op, message, descriptor }, banner);
      const error = { ...(rawError || {}), message, kind, status };
      if (wantsThrow) {
        const e = new Error('[db] ' + desc.table + ' ' + desc.op + ': ' + message);
        e.dbError = error;
        e.descriptor = descriptor;
        throw e;
      }
      return { data: null, error, count: null, ok: false };
    }

    return builder;
  }

  return { from };
}
