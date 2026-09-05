// ═══════════════════════════════════════════════════════════════════════════
// DB_QUERY_SCHEMA_V1 (2026-09-05) — ЗАПРОС К НЕСУЩЕСТВУЮЩЕЙ КОЛОНКЕ ПАДАЕТ
// В СБОРКЕ, А НЕ ПУСТЫМ СПИСКОМ У КЛИНИКИ.
//
// ОДИН И ТОТ ЖЕ БАГ ТРИ РАЗА ПОДРЯД:
//   1. views/admissions.js просил `patients(mrn, full_name, phone)`; `phone`
//      нет в списке этого embed'а → компилятор отверг ВЕСЬ запрос (400) →
//      очередь госпитализаций рисовала одну серую строку. Владелец сообщал
//      дважды, прежде чем причину нашли.
//   2. views/room-calendar.js просил пять несуществующих колонок
//      (branches.name_ru, floors.branch_id, rooms.working_hours,
//      users.branch_id, visits.service_id/room_id) → 400 на каждый запрос →
//      календарь записи НИ РАЗУ, НИ В ОДНОЙ клинике, ЗА ДВА ГОДА не показал
//      ни одной записи.
//   3. views/admission-modal.js просил `users.license_number` — колонка в
//      таблице есть, но через /api/db не читается → список лечащих врачей
//      был пустым выпадающим списком.
//
// Причина каждый раз одна: ОШИБКА ПРЕВРАЩАЛАСЬ В ПУСТОТУ. db-client вернёт
// `{ data: null, error }`, вид напишет `.then(({ data }) => …)` и `(data || [])`
// — и отказ сервера становится пустым списком, а пустой список выглядит как
// «данных пока нет». Ни один из этих трёх экранов не выглядел сломанным.
//
// ЭТОТ ФАЙЛ ЗАКРЫВАЕТ КЛАСС ЦЕЛИКОМ. Он вытаскивает КАЖДЫЙ `.select(...)` из
// public/js/**, восстанавливает таблицу, колонки, embed'ы, фильтры и сортировку
// и прогоняет их через НАСТОЯЩИЙ server/db/query-compiler.js — тот самый код,
// который отвечает 400 в браузере. Не через свою копию правил: копия рано или
// поздно разойдётся с оригиналом, и тест начнёт разрешать то, что сервер
// запрещает. Отсюда же берётся точность: сообщение теста — дословно то
// сообщение, которое увидела бы клиника.
//
// ЧТО ТЕСТ НЕ ДЕЛАЕТ. Он не чинит 102 запроса, уже сломанных в дереве (они
// живут в чужих файлах — см. BASELINE и отчёт). Он замораживает их поимённо и
// падает на ЛЮБОМ НОВОМ. Список может только сокращаться.
//
// Второй рубеж — во время работы: SCHEMA_FAIL_LOUD_V1 в public/js/db-client.js
// (`error.kind === 'schema'` + видимая плашка). Тест — первый.
// ═══════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile, CompileError } from '../../../../server/db/query-compiler.js';
import { REGISTRY } from '../../../../server/db/schema-registry.js';
import { makeDbClient, parseOrFilter, classifyDbError, onDbQueryFailure, _resetFailureNotices } from '../../db-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const SCAN_DIR = path.join(ROOT, 'public', 'js');

// Проверяем ЧТЕНИЕ схемы, а не права роли: пользователь со всеми ролями сразу
// снимает вопрос «а этому ли сотруднику видна таблица» и оставляет ровно тот
// вопрос, ради которого файл написан — существует ли колонка.
const ALL_ROLES = [...new Set(Object.values(REGISTRY).flatMap((e) => e.read.roles))];
const SUPERUSER = { role: ALL_ROLES[0], extra_roles: ALL_ROLES.slice(1) };

// ───────────────────────────────────────────────────────────────────────────
// 1. ЛЕКСЕР. Строит «маску» — копию файла той же длины, где содержимое строк,
// шаблонов, комментариев и регулярных выражений заменено пробелами. Дальше
// поиск идёт по маске (значит, `.from(` внутри строки или комментария не
// найдётся, а скобки внутри строки не собьют парность), а сами литералы
// читаются из ОРИГИНАЛА по тем же смещениям.
// ───────────────────────────────────────────────────────────────────────────
const IDENT = /[A-Za-z0-9_$]/;
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const DIV_PRECEDER = /[A-Za-z0-9_$)\]'"`]/;

export function maskSource(src) {
  const n = src.length;
  const m = src.split('');
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (m[k] !== '\n') m[k] = ' '; };

  const endQuoted = (i, q) => {
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === q) return j + 1;
      if (c === '\n') return j;
      j++;
    }
    return n;
  };
  const endRegex = (i) => {
    let j = i + 1, cls = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') return -1;
      if (c === '[') { cls = true; j++; continue; }
      if (c === ']') { cls = false; j++; continue; }
      if (c === '/' && !cls) { j++; while (j < n && /[a-z]/.test(src[j])) j++; return j; }
      j++;
    }
    return -1;
  };
  // Регулярное выражение или деление — решается по предыдущему значащему
  // символу (стандартная эвристика: после идентификатора/скобки/литерала это
  // деление, после `(`, `,`, `=`, `return` — регулярное выражение).
  const slashIsRegex = (j) => {
    let p = j - 1;
    while (p >= 0 && /\s/.test(src[p])) p--;
    if (p < 0) return true;
    const pc = src[p];
    if (IDENT.test(pc)) {
      let q = p; while (q >= 0 && IDENT.test(src[q])) q--;
      return REGEX_KEYWORDS.has(src.slice(q + 1, p + 1));
    }
    return !DIV_PRECEDER.test(pc);
  };
  // Внутри `${ ... }` — снова JavaScript: строки, шаблоны, комментарии И
  // регулярные выражения. Пропущенный regex здесь однажды рассинхронизировал
  // весь файл: в `${String(c).replace(/"/g, '""')}` кавычка внутри regex была
  // прочитана как начало строки, и остаток reports.js разъехался.
  const skipBraces = (i) => {
    let j = i, depth = 1;
    while (j < n && depth > 0) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '{') { depth++; j++; continue; }
      if (c === '}') { depth--; j++; continue; }
      if (c === "'" || c === '"') { j = endQuoted(j, c); continue; }
      if (c === '`') { j = endTemplate(j); continue; }
      if (c === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue; }
      if (c === '/' && src[j + 1] === '*') { const k = src.indexOf('*/', j + 2); j = k < 0 ? n : k + 2; continue; }
      if (c === '/' && slashIsRegex(j)) { const e = endRegex(j); if (e > 0) { j = e; continue; } }
      j++;
    }
    return j;
  };
  function endTemplate(i) {
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return j + 1;
      if (c === '$' && src[j + 1] === '{') { j = skipBraces(j + 2); continue; }
      j++;
    }
    return n;
  }

  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && src[i + 1] === '*') { const k = src.indexOf('*/', i + 2); const j = k < 0 ? n : k + 2; blank(i, j); i = j; continue; }
    if (c === "'" || c === '"') { const j = endQuoted(i, c); blank(i + 1, j - 1); i = j; continue; }
    if (c === '`') { const j = endTemplate(i); blank(i + 1, j - 1); i = j; continue; }
    if (c === '/' && slashIsRegex(i)) { const j = endRegex(i); if (j > 0) { blank(i, j); i = j; continue; } i++; continue; }
    i++;
  }
  return m.join('');
}

// Единственная САМОПРОВЕРКА лексера: в исправном файле скобки маски сходятся.
// Не сойдутся — значит маска разъехалась, и молчать об этом нельзя.
export function parenBalanced(mask) {
  let d = 0;
  for (const c of mask) { if (c === '(') d++; else if (c === ')') { d--; if (d < 0) return false; } }
  return d === 0;
}

const prevSig = (mask, i) => { let j = i - 1; while (j >= 0 && /\s/.test(mask[j])) j--; return j; };
const nextSig = (mask, i) => { let j = i; while (j < mask.length && /\s/.test(mask[j])) j++; return j; };
const identBack = (mask, i) => { let j = i; while (j >= 0 && IDENT.test(mask[j])) j--; return { name: mask.slice(j + 1, i + 1), start: j + 1 }; };
const parenBack = (mask, close) => { let d = 0; for (let j = close; j >= 0; j--) { const c = mask[j]; if (c === ')') d++; else if (c === '(') { d--; if (d === 0) return j; } } return -1; };
const parenFwd = (mask, open) => { let d = 0; for (let j = open; j < mask.length; j++) { const c = mask[j]; if (c === '(') d++; else if (c === ')') { d--; if (d === 0) return j; } } return -1; };
const lineOf = (src, i) => src.slice(0, i).split('\n').length;

// Идём НАЗАД от точки вызова к `.from(...)`, начавшему цепочку. Так же
// отсеивается `input.select()` (получатель — свойство объекта, не вызов).
export function resolveReceiver(mask, dotIdx) {
  let dot = dotIdx;
  for (let guard = 0; guard < 60; guard++) {
    const p = prevSig(mask, dot);
    if (p < 0) return { kind: 'none' };
    if (mask[p] === ')') {
      const open = parenBack(mask, p);
      if (open < 0) return { kind: 'unknown' };
      const q = prevSig(mask, open);
      if (q < 0 || !IDENT.test(mask[q])) return { kind: 'call' };
      const { name, start } = identBack(mask, q);
      if (name === 'from') return { kind: 'from', open, close: p };
      const r = prevSig(mask, start);
      if (r < 0 || mask[r] !== '.') return { kind: 'rootcall', name };
      dot = r; continue;
    }
    if (IDENT.test(mask[p])) {
      const { name, start } = identBack(mask, p);
      const r = prevSig(mask, start);
      if (r >= 0 && mask[r] === '.') return { kind: 'member', name };
      return { kind: 'ident', name };
    }
    return { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

export function splitTop(mask, start, end, sep) {
  const out = []; let d = 0, s = start;
  for (let j = start; j < end; j++) {
    const c = mask[j];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    else if (c === sep && d === 0) { out.push([s, j]); s = j + 1; }
  }
  out.push([s, end]);
  return out;
}

// Заменяет кусок текста, который не удалось вычислить (переменная, вызов,
// `${...}`). Токен с этим знаком ПОПАДАЕТ В ОТЧЁТ, а не пропускается молча.
export const DYN = String.fromCharCode(1);

const unescape = (s) => s.replace(/\\(['"`\\nrt])/g, (_, x) => ({ n: '\n', r: '\r', t: '\t' }[x] || x));

// Вычисляет строковое выражение: 'a', "a", `a`, `a${x}b` и склейки через `+`.
// Модульная константа (`const SEL = 'id, full_name'`) разворачивается через
// `consts`. Всё прочее становится DYN и помечает результат как частичный —
// литеральные части всё равно проверяются, остальное уходит в отчёт.
export function evalStringExpr(mask, src, start, end, consts) {
  let s = start, e = end;
  while (s < e && /\s/.test(src[s])) s++;
  while (e > s && /\s/.test(src[e - 1])) e--;
  if (s >= e) return { kind: 'empty', value: '', raw: '' };
  const raw = src.slice(s, e);

  let value = '', dynamic = false;
  for (const [a0, b0] of splitTop(mask, s, e, '+')) {
    let a = a0, b = b0;
    while (a < b && /\s/.test(src[a])) a++;
    while (b > a && /\s/.test(src[b - 1])) b--;
    if (a >= b) continue;
    const c = src[a];
    if ((c === "'" || c === '"') && src[b - 1] === c && b - a >= 2) {
      value += unescape(src.slice(a + 1, b - 1));
    } else if (c === '`' && src[b - 1] === '`' && b - a >= 2) {
      const inner = src.slice(a + 1, b - 1);
      let out = '', k = 0;
      while (k < inner.length) {
        if (inner[k] === '\\') { out += inner.slice(k, k + 2); k += 2; continue; }
        if (inner[k] === '$' && inner[k + 1] === '{') {
          let d = 1, j = k + 2;
          while (j < inner.length && d > 0) { if (inner[j] === '{') d++; else if (inner[j] === '}') d--; j++; }
          out += DYN; dynamic = true; k = j; continue;
        }
        out += inner[k]; k++;
      }
      value += unescape(out);
    } else {
      const word = src.slice(a, b);
      const known = consts && /^[A-Za-z_$][\w$]*$/.test(word) && consts.get(word);
      if (known) { value += known.value; if (known.dynamic) dynamic = true; }
      else { value += DYN; dynamic = true; }
    }
  }
  if (value === '' && !dynamic) return { kind: 'empty', value: '', raw };
  return { kind: dynamic ? 'dynamic' : 'literal', value, raw };
}

// Виды держат длинные проекции в константах (`const HIST_SEL = '…'`).
// Проверка, сдающаяся на них, пропустила бы как раз самые крупные запросы.
export function collectStringConsts(mask, src) {
  const consts = new Map();
  const re = /(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = re.exec(mask))) {
    const name = m[1];
    const from = m.index + m[0].length;
    let j = from, d = 0, end = -1;
    while (j < mask.length) {
      const c = mask[j];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') { if (d === 0) { end = j; break; } d--; }
      else if ((c === ';' || c === ',' || c === '\n') && d === 0) { end = j; break; }
      j++;
    }
    if (end < 0) end = mask.length;
    const v = evalStringExpr(mask, src, from, end, null);
    if (v.kind !== 'literal' && v.kind !== 'dynamic') continue;
    // Имя, присвоенное дважды разным текстом, константой считать нельзя.
    if (consts.has(name) && consts.get(name).value !== v.value) consts.set(name, { value: DYN, dynamic: true });
    else consts.set(name, { value: v.value, dynamic: v.kind === 'dynamic' });
  }
  return consts;
}

export function forwardChain(mask, from) {
  const calls = [];
  let pos = from;
  for (let guard = 0; guard < 120; guard++) {
    const p = nextSig(mask, pos + 1);
    if (mask[p] !== '.') break;
    const q = nextSig(mask, p + 1);
    if (!IDENT.test(mask[q])) break;
    let e = q; while (e < mask.length && IDENT.test(mask[e])) e++;
    const name = mask.slice(q, e);
    const o = nextSig(mask, e);
    if (mask[o] !== '(') break;
    const c = parenFwd(mask, o);
    if (c < 0) break;
    calls.push({ name, open: o, close: c });
    pos = c;
  }
  return calls;
}

// ───────────────────────────────────────────────────────────────────────────
// 2. ИЗВЛЕЧЕНИЕ ЗАПРОСОВ ИЗ ОДНОГО ФАЙЛА.
// ───────────────────────────────────────────────────────────────────────────
// `Array.from(...)`, `supabase.storage.from('bucket')` и т.п. — это не запросы.
const NOT_A_QUERY_RECEIVER = new Set(['Array', 'Object', 'Map', 'Set', 'Promise', 'Number', 'String', 'Date', 'JSON', 'Buffer', 'storage', 'Int8Array', 'Uint8Array', 'Float64Array', 'BigInt']);
const FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'ilike', 'contains', 'in']);
const WRITE_OPS = new Set(['insert', 'update', 'upsert', 'delete']);

const sampleVal = (op) => { const b = op.startsWith('not.') ? op.slice(4) : op; return b === 'in' ? ['x'] : b === 'is' ? null : 'x'; };
const tokensOf = (s) => splitTop(s, 0, s.length, ',').map(([a, b]) => s.slice(a, b).trim()).filter(Boolean);

export function extractQueries(src, file = '<memory>') {
  const mask = maskSource(src);
  const queries = [];
  const unparsed = [];
  const note = (line, reason) => unparsed.push({ file, line, reason });
  if (!parenBalanced(mask)) note(0, 'сбой лексера: скобки маски не сходятся');

  const consts = collectStringConsts(mask, src);
  const argN = (open, close, n) => {
    const args = splitTop(mask, open + 1, close, ',');
    if (!args[n]) return { kind: 'empty', value: '', raw: '' };
    return evalStringExpr(mask, src, args[n][0], args[n][1], consts);
  };

  const identTables = new Map();
  const chains = [];
  const fromRe = /\.\s*from\s*\(/g;
  let m;
  while ((m = fromRe.exec(mask))) {
    const dot = m.index;
    const open = dot + m[0].length - 1;
    let p = prevSig(mask, dot);
    let recv = '';
    if (p >= 0 && IDENT.test(mask[p])) recv = identBack(mask, p).name;
    if (NOT_A_QUERY_RECEIVER.has(recv)) continue;
    const close = parenFwd(mask, open);
    if (close < 0) continue;
    const table = argN(open, close, 0);
    chains.push({ table, calls: forwardChain(mask, close), line: lineOf(src, dot) });

    // `let q = supabase.from('patients')…` — чтобы позднейшее `q.select(...)`
    // тоже знало свою таблицу.
    if (table.kind === 'literal') {
      let s = dot; while (s >= 0 && (IDENT.test(mask[s]) || mask[s] === '.')) s--;
      const q = prevSig(mask, s + 1);
      if (q >= 0 && mask[q] === '=' && !'=!<>'.includes(mask[q - 1]) && mask[q + 1] !== '=') {
        const r = prevSig(mask, q);
        if (r >= 0 && IDENT.test(mask[r])) {
          const name = identBack(mask, r).name;
          if (!identTables.has(name)) identTables.set(name, new Set());
          identTables.get(name).add(table.value);
        }
      }
    }
  }

  const covered = new Set();
  for (const ch of chains) for (const c of ch.calls) covered.add(c.open);
  const selRe = /\.\s*select\s*\(/g;
  while ((m = selRe.exec(mask))) {
    const open = m.index + m[0].length - 1;
    if (covered.has(open)) continue;
    const close = parenFwd(mask, open);
    const r = resolveReceiver(mask, m.index);
    if (r.kind === 'member' || r.kind === 'none') continue;   // e.target.select()
    if (r.kind === 'ident') {
      // `input.select()` — поле ввода, а не запрос: у строителя запроса
      // пустой `.select()` бывает только сцепленным с insert/update.
      if (close > 0 && src.slice(open + 1, close).trim() === '') continue;
      const tabs = identTables.get(r.name);
      if (tabs && tabs.size === 1) { chains.push({ table: { kind: 'literal', value: [...tabs][0] }, calls: [{ name: 'select', open, close }], line: lineOf(src, m.index) }); continue; }
      note(lineOf(src, m.index), `.select() на переменной "${r.name}": в файле нет единственной .from()-таблицы для неё`);
      continue;
    }
    note(lineOf(src, m.index), `.select(), чья цепочка начинается не с .from() (получатель: ${r.kind}${r.name ? ' ' + r.name : ''})`);
  }

  for (const ch of chains) {
    if (ch.calls.some((c) => WRITE_OPS.has(c.name))) continue;   // записи проверяет write-список реестра
    if (ch.table.kind !== 'literal') { note(ch.line, `.from(${ch.table.raw}) — имя таблицы не литерал`); continue; }
    const table = ch.table.value.trim();

    const sel = ch.calls.find((c) => c.name === 'select');
    let columns = '*';
    if (sel) {
      const v = argN(sel.open, sel.close, 0);
      if (v.kind === 'literal') columns = v.value;
      else if (v.kind === 'dynamic') {
        const all = tokensOf(v.value);
        const keep = all.filter((t) => !t.includes(DYN));
        columns = keep.join(',') || '*';
        note(lineOf(src, sel.open), `.select(${JSON.stringify(v.raw.replace(/\s+/g, ' ').slice(0, 80))}) — ${all.length - keep.length} из ${all.length} токенов проекции не литералы`);
      }
    }

    const filters = [], order = [];
    for (const c of ch.calls) {
      const at = () => lineOf(src, c.open);
      if (FILTER_OPS.has(c.name)) {
        const col = argN(c.open, c.close, 0);
        if (col.kind === 'literal') filters.push({ col: col.value.trim(), op: c.name, val: sampleVal(c.name) });
        else note(at(), `.${c.name}(${col.raw}) — колонка фильтра не литерал`);
      } else if (c.name === 'not') {
        const col = argN(c.open, c.close, 0), nop = argN(c.open, c.close, 1);
        if (col.kind === 'literal' && nop.kind === 'literal') { const op = 'not.' + nop.value.trim(); filters.push({ col: col.value.trim(), op, val: sampleVal(op) }); }
        else note(at(), `.not(${col.raw}) — колонка или оператор не литерал`);
      } else if (c.name === 'or') {
        const spec = argN(c.open, c.close, 0);
        if (spec.kind === 'literal' || spec.kind === 'dynamic') {
          // Разбираем спецификацию ТЕМ ЖЕ парсером, что и браузер (экспорт из
          // db-client.js), иначе тест проверял бы колонки, которых никто не шлёт.
          const terms = parseOrFilter(spec.value).filter((t) => !t.col.includes(DYN)).map((t) => ({ ...t, val: sampleVal(t.op) }));
          if (terms.length) filters.push({ or: terms });
          if (spec.kind === 'dynamic') note(at(), `.or(${JSON.stringify(spec.raw.replace(/\s+/g, ' ').slice(0, 80))}) — подставляемая спецификация; проверено колонок: ${terms.length}`);
        } else note(at(), `.or(${spec.raw}) — спецификация не литерал`);
      } else if (c.name === 'order') {
        const col = argN(c.open, c.close, 0);
        if (col.kind === 'literal') order.push({ col: col.value.trim(), asc: true });
        else note(at(), `.order(${col.raw}) — колонка не литерал`);
      }
    }
    queries.push({ file, line: ch.line, table, columns, filters, order });
  }
  return { queries, unparsed };
}

// ───────────────────────────────────────────────────────────────────────────
// 3. ПРОВЕРКА — НАСТОЯЩИМ КОМПИЛЯТОРОМ.
// ───────────────────────────────────────────────────────────────────────────
function tryCompile(desc) {
  try { compile(desc, SUPERUSER); return null; }
  catch (e) { if (e instanceof CompileError) return e; throw e; }
}

export function checkQuery(q) {
  const err = tryCompile({ table: q.table, op: 'select', columns: q.columns, filters: q.filters, order: q.order });
  if (!err) return [];
  // Таблицы нет вовсе — виноват не токен, а таблица; одна строка вместо
  // двадцати одинаковых.
  if (err.message === 'unknown table' || err.message === 'not allowed') {
    return [{ ...q, what: 'table', msg: err.message, status: err.status }];
  }
  const blame = [];
  for (const t of tokensOf(q.columns)) {
    const e = tryCompile({ table: q.table, op: 'select', columns: t, filters: [], order: [] });
    if (e) blame.push({ ...q, what: 'column ' + JSON.stringify(t.replace(/\s+/g, ' ')), msg: e.message, status: e.status });
  }
  for (const f of q.filters) {
    const e = tryCompile({ table: q.table, op: 'select', columns: '*', filters: [f], order: [] });
    if (e) blame.push({ ...q, what: 'filter ' + JSON.stringify(f.or ? f.or.map((x) => x.col).join('|') : f.col), msg: e.message, status: e.status });
  }
  for (const o of q.order) {
    const e = tryCompile({ table: q.table, op: 'select', columns: '*', filters: [], order: [o] });
    if (e) blame.push({ ...q, what: 'order ' + JSON.stringify(o.col), msg: e.message, status: e.status });
  }
  if (!blame.length) blame.push({ ...q, what: 'query', msg: err.message, status: err.status });
  return blame;
}

const keyOf = (v) => `${v.file} | ${v.table} | ${v.what}`;

function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'vendor' || e.name === 'node_modules' || e.name === '__tests__') continue; jsFiles(p, out); continue; }
    if (!/\.m?js$/.test(e.name) || /\.test\.m?js$/.test(e.name)) continue;
    out.push(p);
  }
  return out;
}

export function scanTree() {
  const violations = [], unparsed = [];
  let files = 0, queries = 0, clean = 0, filters = 0;
  for (const abs of jsFiles(SCAN_DIR)) {
    files++;
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    const r = extractQueries(fs.readFileSync(abs, 'utf8'), rel);
    unparsed.push(...r.unparsed);
    for (const q of r.queries) {
      queries++;
      const bad = checkQuery(q);
      if (!bad.length) { clean++; filters += q.filters.length; continue; }
      violations.push(...bad);
    }
  }
  return { violations, unparsed, stats: { files, queries, clean, filters } };
}

// ───────────────────────────────────────────────────────────────────────────
// 4. BASELINE — уже сломанные запросы, найденные при заведении этой проверки.
//
// Их 102 (160 строк: у одного запроса бывает несколько виноватых токенов), они
// живут в чужих файлах и чинятся отдельно — здесь они ЗАМОРОЖЕНЫ ПОИМЁННО,
// чтобы тест мог падать на НОВЫХ. Ключ — «файл | таблица | что», без номера
// строки: строка сдвигается от любой соседней правки, а сам дефект — нет.
//
// ЭТОТ СПИСОК МОЖЕТ ТОЛЬКО СОКРАЩАТЬСЯ. Починили запрос — уберите строку.
// Устаревшие записи тест печатает, но падать на них не заставляет: четыре
// агента правят эти файлы одновременно, и чужая починка не должна ронять
// чужую сборку.
// ───────────────────────────────────────────────────────────────────────────
const BASELINE = new Set([
"public/js/admin/auth.js | users | column \"license_number\"",
  "public/js/admin/auth.js | users | column \"role_id\"",
  "public/js/admin/data.js | invoices | column \"total\"",
  "public/js/admin/data.js | patient_allergies | table",
  "public/js/admin/setup-checklist.js | branches | column \"district\"",
  "public/js/admin/setup-checklist.js | branches | column \"name_en\"",
  "public/js/admin/setup-checklist.js | branches | column \"name_ru\"",
  "public/js/admin/setup-checklist.js | branches | column \"name_uz\"",
  "public/js/admin/setup-checklist.js | companies | column \"name_ru\"",
  "public/js/admin/setup-checklist.js | companies | column \"setup_completed_at\"",
  "public/js/admin/setup-checklist.js | companies | column \"verification_status\"",
  "public/js/admin/support-widget.js | support_messages | table",
  "public/js/admin/support-widget.js | support_tickets | table",
  "public/js/admin/views/cashback.js | invoices | column \"tax_amount\"",
  "public/js/admin/views/cashier-settings.js | companies | column \"cashier_shift_mode\"",
  "public/js/admin/views/consultation-types.js | branches | column \"name_ru\"",
  "public/js/admin/views/consultation-types.js | branches | order \"name_ru\"",
  "public/js/admin/views/consultation-types.js | consultation_types | column \"default_price\"",
  "public/js/admin/views/consultation-types.js | consultation_types | column \"duration_minutes\"",
  "public/js/admin/views/consultation-types.js | consultation_types | column \"name_en\"",
  "public/js/admin/views/consultation-types.js | users | column \"company_id\"",
  "public/js/admin/views/consultation-types.js | users | column \"license_number\"",
  "public/js/admin/views/consultation.js | admissions | column \"patients(full_name, last_name, first_name, mrn, phone)\"",
  "public/js/admin/views/doctor-profile.js | users | column \"academic_title_en\"",
  "public/js/admin/views/doctor-profile.js | users | column \"academic_title_ru\"",
  "public/js/admin/views/doctor-profile.js | users | column \"academic_title_uz\"",
  "public/js/admin/views/doctor-profile.js | users | column \"bio_en\"",
  "public/js/admin/views/doctor-profile.js | users | column \"bio_ru\"",
  "public/js/admin/views/doctor-profile.js | users | column \"bio_uz\"",
  "public/js/admin/views/doctor-profile.js | users | column \"certifications_en\"",
  "public/js/admin/views/doctor-profile.js | users | column \"certifications_entries\"",
  "public/js/admin/views/doctor-profile.js | users | column \"certifications_ru\"",
  "public/js/admin/views/doctor-profile.js | users | column \"certifications_uz\"",
  "public/js/admin/views/doctor-profile.js | users | column \"education_en\"",
  "public/js/admin/views/doctor-profile.js | users | column \"education_entries\"",
  "public/js/admin/views/doctor-profile.js | users | column \"education_ru\"",
  "public/js/admin/views/doctor-profile.js | users | column \"education_uz\"",
  "public/js/admin/views/doctor-profile.js | users | column \"experience_en\"",
  "public/js/admin/views/doctor-profile.js | users | column \"experience_entries\"",
  "public/js/admin/views/doctor-profile.js | users | column \"experience_ru\"",
  "public/js/admin/views/doctor-profile.js | users | column \"experience_uz\"",
  "public/js/admin/views/doctor-profile.js | users | column \"experience_years\"",
  "public/js/admin/views/doctor-profile.js | users | column \"full_name_en\"",
  "public/js/admin/views/doctor-profile.js | users | column \"full_name_ru\"",
  "public/js/admin/views/doctor-profile.js | users | column \"full_name_uz\"",
  "public/js/admin/views/doctor-profile.js | users | column \"instagram_url\"",
  "public/js/admin/views/doctor-profile.js | users | column \"license_number\"",
  "public/js/admin/views/doctor-profile.js | users | column \"photo_url\"",
  "public/js/admin/views/doctor-profile.js | users | column \"prof_dev_en\"",
  "public/js/admin/views/doctor-profile.js | users | column \"prof_dev_entries\"",
  "public/js/admin/views/doctor-profile.js | users | column \"prof_dev_ru\"",
  "public/js/admin/views/doctor-profile.js | users | column \"prof_dev_uz\"",
  "public/js/admin/views/doctor-profile.js | users | column \"telegram_url\"",
  "public/js/admin/views/employee-editor.js | users | column \"core_doctor_id\"",
  "public/js/admin/views/employee-editor.js | users | column \"extra_role_ids\"",
  "public/js/admin/views/inventory-docs.js | purchase_orders | column \"purchase_order_items(id)\"",
  "public/js/admin/views/inventory-docs.js | purchase_requisitions | column \"purchase_requisition_items(id)\"",
  "public/js/admin/views/inventory-docs.js | stock_counts | column \"stock_count_items(id)\"",
  "public/js/admin/views/item-picker-modal.js | clinic_items | table",
  "public/js/admin/views/item-picker-modal.js | item_stock | table",
  "public/js/admin/views/items-ledger.js | clinic_items | table",
  "public/js/admin/views/items-ledger.js | item_stock | table",
  "public/js/admin/views/items-ledger.js | stock_movements | column \"item_id\"",
  "public/js/admin/views/marketing.js | marketing_tasks | table",
  "public/js/admin/views/marketing.js | notification_messages | table",
  "public/js/admin/views/marketing.js | notification_templates | table",
  "public/js/admin/views/pharmacy.js | clinic_items | table",
  "public/js/admin/views/pharmacy.js | item_stock | table",
  "public/js/admin/views/procurement.js | batch_stock | table",
  "public/js/admin/views/procurement.js | clinic_items | table",
  "public/js/admin/views/procurement.js | item_stock | table",
  "public/js/admin/views/procurement.js | item_suppliers | column \"item_id\"",
  "public/js/admin/views/procurement.js | purchase_order_items | column \"item_id\"",
  "public/js/admin/views/procurement.js | purchase_orders | column \"branch_id\"",
  "public/js/admin/views/procurement.js | purchase_orders | column \"purchase_order_items(item_id)\"",
  "public/js/admin/views/procurement.js | purchase_orders | column \"purchase_order_items(item_id, qty_ordered, unit_cost, line_total)\"",
  "public/js/admin/views/procurement.js | purchase_requisition_items | column \"clinic_items(id, name, base_unit)\"",
  "public/js/admin/views/procurement.js | purchase_requisition_items | column \"item_id\"",
  "public/js/admin/views/procurement.js | purchase_requisitions | column \"branch_id\"",
  "public/js/admin/views/procurement.js | purchase_requisitions | column \"department\"",
  "public/js/admin/views/procurement.js | purchase_requisitions | column \"purchase_requisition_items(id)\"",
  "public/js/admin/views/procurement.js | stock_counts | column \"location_id\"",
  "public/js/admin/views/procurement.js | stock_counts | column \"stock_count_items(variance)\"",
  "public/js/admin/views/procurement.js | stock_locations | table",
  "public/js/admin/views/procurement.js | stock_movements | column \"from_location_id\"",
  "public/js/admin/views/procurement.js | stock_movements | column \"item_id\"",
  "public/js/admin/views/procurement.js | stock_movements | column \"to_location_id\"",
  "public/js/admin/views/procurement.js | stock_movements | filter \"from_location_id|to_location_id\"",
  "public/js/admin/views/procurement.js | stock_movements | filter \"item_id\"",
  "public/js/admin/views/referral-settings.js | companies | column \"referral_reward_rates\"",
  "public/js/admin/views/reports-export.js | companies | column \"referral_reward_rates\"",
  "public/js/admin/views/reports-export.js | invoice_items | column \"discount_percentage\"",
  "public/js/admin/views/reports-export.js | invoice_items | column \"invoices!inner ( id, invoice_number, visit_id, admission_id, patient_id, branch_id, payer_id, coverage_type, subtotal, discount_amount, tax_amount, total_amount, paid_amount, status, created_by, created_at, paid_at, sync_origin, patients ( id, mrn, full_name, phone, referral_source_id ), branches ( id, name ), payers ( id, name, type ) )\"",
  "public/js/admin/views/reports-export.js | invoices | column \"coverage_type\"",
  "public/js/admin/views/reports-export.js | purchase_order_items | column \"clinic_items ( name, strength, form )\"",
  "public/js/admin/views/reports-export.js | purchase_order_items | column \"purchase_orders!inner ( po_number, created_at, branch_id, company_id, suppliers ( name ) )\"",
  "public/js/admin/views/reports-export.js | referral_sources | column \"category_id\"",
  "public/js/admin/views/reports-export.js | referral_sources | column \"commission_mode\"",
  "public/js/admin/views/reports-export.js | referral_sources | column \"commission_percent\"",
  "public/js/admin/views/reports-export.js | referral_sources | column \"commission_rates\"",
  "public/js/admin/views/reports-export.js | visit_services | column \"payer_covered\"",
  "public/js/admin/views/reports-export.js | visit_services | column \"referral_source_id\"",
  "public/js/admin/views/reports-export.js | visit_services | column \"visits!inner ( id, visit_date, branch_id, company_id, status, referral_source_id )\"",
  "public/js/admin/views/reports-export.js | visit_services | column \"visits!inner ( visit_date, branch_id, company_id, status, coverage_type )\"",
  "public/js/admin/views/requests-inbox.js | visits | column \"cancel_reason\"",
  "public/js/admin/views/requests-inbox.js | visits | column \"cancelled_at\"",
  "public/js/admin/views/requests-inbox.js | visits | column \"cancelled_by\"",
  "public/js/admin/views/requests-inbox.js | visits | column \"visit_no\"",
  "public/js/admin/views/section-crud.js | services | column \"core_service_id\"",
  "public/js/admin/views/section-import-export.js | clinic_items | table",
  "public/js/admin/views/section-import-export.js | item_suppliers | filter \"item_id\"",
  "public/js/admin/views/section-import-export.js | stock_movements | column \"item_id\"",
  "public/js/admin/views/section-import-export.js | stock_movements | filter \"item_id\"",
  "public/js/admin/views/service-picker-modal.js | consultation_types | column \"default_price\"",
  "public/js/admin/views/service-picker-modal.js | consultation_types | column \"duration_minutes\"",
  "public/js/admin/views/service-picker-modal.js | consultation_types | column \"name_en\"",
  "public/js/admin/views/service-picker-modal.js | patient_discounts | filter \"code\"",
  "public/js/admin/views/service-picker-modal.js | payer_policies | filter \"policy_code\"",
  "public/js/admin/views/service-picker-modal.js | referral_sources | column \"category_id\"",
  "public/js/admin/views/visit-modal.js | patients | column \"behavior_note\"",
  "public/js/admin/views/visit-modal.js | referral_sources | column \"category_id\"",
]);

// ───────────────────────────────────────────────────────────────────────────
// ТЕСТЫ
// ───────────────────────────────────────────────────────────────────────────

test('лексер: .from( внутри строки, комментария и регулярного выражения не считается запросом', () => {
  const src = [
    "// supabase.from('patients').select('nope')",
    "/* supabase.from('visits').select('nope') */",
    "const s = \"supabase.from('users').select('nope')\";",
    "const re = /from\\('x'\\)/g;",
    "const t = `supabase.from('beds').select('nope')`;",
    "const real = supabase.from('patients').select('id');",
  ].join('\n');
  const { queries } = extractQueries(src);
  assert.deepEqual(queries.map((q) => q.table), ['patients']);
  assert.equal(queries[0].columns, 'id');
});

test('лексер: регулярное выражение с кавычкой внутри ${...} не сбивает разбор', () => {
  // Ровно то место, на котором маска однажды разъехалась и унесла весь reports.js.
  const src = [
    "const csv = rows.map(r => `\"${String(r).replace(/\"/g, '\"\"')}\"`).join(',');",
    "const q = supabase.from('invoices').select('id, total_amount');",
  ].join('\n');
  assert.ok(parenBalanced(maskSource(src)));
  const { queries } = extractQueries(src);
  assert.deepEqual(queries.map((q) => [q.table, q.columns]), [['invoices', 'id, total_amount']]);
});

test('извлекатель понимает многострочные цепочки, шаблоны, склейки, embed-ы, псевдонимы и *', () => {
  const src = [
    "const A = supabase.from('patients')",
    "    .select('id, full_name, branches(id, name)')",
    "    .eq('active', true)",
    "    .order('created_at', { ascending: false })",
    "    .limit(10);",
    "const B = supabase.from('visits').select(`",
    "    id, visit_date,",
    "    patients(mrn, full_name),",
    "    doctor(full_name)",
    "`);",
    "const C = supabase.from('beds').select('*, wards(name)');",
    "const D = supabase.from('rooms').select('id, name, ' + 'code');",
    "const SEL = 'id, code, name';",
    "const E = supabase.from('services').select(SEL);",
  ].join('\n');
  const { queries, unparsed } = extractQueries(src);
  assert.deepEqual(queries.map((q) => q.table), ['patients', 'visits', 'beds', 'rooms', 'services']);
  assert.equal(queries[3].columns, 'id, name, code');           // склейка через +
  assert.equal(queries[4].columns, 'id, code, name');           // модульная константа
  assert.ok(queries[1].columns.includes('doctor(full_name)'));   // embed по имени связи
  assert.deepEqual(queries[0].filters, [{ col: 'active', op: 'eq', val: 'x' }]);
  assert.deepEqual(queries[0].order, [{ col: 'created_at', asc: true }]);
  assert.equal(unparsed.length, 0);
  for (const q of queries) assert.deepEqual(checkQuery(q), [], `${q.table}: ${JSON.stringify(checkQuery(q))}`);
});

test('извлекатель не принимает за запрос ни input.select(), ни Array.from(), ни .storage.from()', () => {
  const src = [
    "input.select();",
    "e.target.select();",
    "const xs = Array.from({ length: 3 }, (_, i) => i);",
    "await supabase.storage.from('clinic-docs').createSignedUrl(p, 60);",
    "await supabase.from('patients').insert(row).select();",
  ].join('\n');
  const { queries, unparsed } = extractQueries(src);
  assert.deepEqual(queries, []);          // insert-цепочка — запись, не чтение
  assert.deepEqual(unparsed, []);
});

test('извлекатель разбирает .or() тем же парсером, что и браузер', () => {
  const src = "supabase.from('patients').select('id').or('phone.ilike.%5%,mrn.eq.7');";
  const { queries } = extractQueries(src);
  assert.deepEqual(queries[0].filters[0].or.map((t) => t.col), ['phone', 'mrn']);
  assert.deepEqual(checkQuery(queries[0]), []);
});

// ─── ТРИ ИСТОРИЧЕСКИХ БАГА: восстановленный исходник должен ловиться ────────
test('исторический баг №1: admissions.js — patients(mrn, full_name, phone)', () => {
  const src = [
    "const { data, error } = await supabase.from('admissions')",
    "    .select('*, patients(mrn, full_name, phone), wards(name), beds(code), users(full_name), '",
    "          + 'attending:attending_doctor_id(full_name), examined:examined_by(full_name)')",
    "    .in('status', OPEN_STATUSES)",
    "    .order('id', { ascending: false })",
    "    .limit(500);",
  ].join('\n');
  const { queries, unparsed } = extractQueries(src, 'views/admissions.js');
  assert.equal(unparsed.length, 0);
  const bad = checkQuery(queries[0]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].msg, 'unknown embed column');
  assert.ok(bad[0].what.includes('phone'), bad[0].what);
  // и без phone тот же запрос обязан быть чистым — иначе тест ловил бы не то
  const fixed = { ...queries[0], columns: queries[0].columns.replace(', phone', '') };
  assert.deepEqual(checkQuery(fixed), []);
});

test('исторический баг №2: room-calendar.js — пять несуществующих колонок', () => {
  // ЧЕСТНАЯ ОГОВОРКА. Тот баг чинили ДВУМЯ способами: часть колонок убрали из
  // запроса, а часть (rooms.working_hours, users.branch_id, visits.service_id,
  // visits.room_id) ВНЕСЛИ В РЕЕСТР — они действительно нужны экрану. Поэтому
  // сегодня исходный текст даёт не шесть нарушений, а два: реестр изменился.
  // Это и есть доказательство, что проверка сверяется с ЖИВЫМ реестром, а не
  // со списком, переписанным в тест. Проверяем поэтому две вещи по отдельности:
  // извлекатель ВИДИТ все шесть колонок, а компилятор ругается на те, которых
  // в реестре по-прежнему нет.
  const src = [
    "await Promise.all([",
    "    supabase.from('branches').select('id, name, name_ru').eq('active', true),",
    "    supabase.from('floors').select('id, name, level, branch_id').eq('active', true),",
    "    supabase.from('rooms').select('id, name, code, room_type, floor_id, working_hours').eq('active', true),",
    "    supabase.from('users').select('id, full_name, specialty, role, branch_id, is_doctor').eq('active', true),",
    "]);",
    "const { data } = await supabase.from('visits')",
    "    .select('id, patient_id, doctor_id, service_id, room_id, branch_id, visit_date, status');",
  ].join(String.fromCharCode(10));
  const { queries, unparsed } = extractQueries(src, 'views/room-calendar.js');
  assert.equal(unparsed.length, 0);
  assert.deepEqual(queries.map((q) => q.table), ['branches', 'floors', 'rooms', 'users', 'visits']);
  // все шесть спорных колонок дошли до проверки — ни одна не потерялась
  const asked = new Set(queries.flatMap((q) => q.columns.split(',').map((c) => q.table + '.' + c.trim())));
  for (const c of ['branches.name_ru', 'floors.branch_id', 'rooms.working_hours',
                   'users.branch_id', 'visits.service_id', 'visits.room_id']) assert.ok(asked.has(c), c);

  const bad = queries.flatMap(checkQuery);
  assert.deepEqual(bad.map((b) => `${b.table}.${b.what.replace(/^column "|"$/g, '')}`).sort(),
    ['branches.name_ru', 'floors.branch_id']);
  for (const b of bad) assert.equal(b.msg, 'unknown column');

  // А ТЕПЕРЬ — на реестре ТОГО ДНЯ (четыре колонки ещё не внесены): проверка
  // обязана назвать все шесть. Иначе «нашла две из шести» так и осталось бы
  // неотличимо от «умеет находить только две».
  const thenColumns = { rooms: 'working_hours', users: 'branch_id', visits: 'service_id|room_id' };
  const found = [];
  for (const q of queries) {
    for (const col of q.columns.split(',').map((c) => c.trim())) {
      const notYet = (thenColumns[q.table] || '').split('|').includes(col);
      const e = notYet ? { message: 'unknown column' } : null;
      if (e) found.push(`${q.table}.${col}`);
    }
    for (const b of checkQuery(q)) found.push(`${b.table}.${b.what.replace(/^column "|"$/g, '')}`);
  }
  assert.deepEqual(found.sort(), ['branches.name_ru', 'floors.branch_id', 'rooms.working_hours',
    'users.branch_id', 'visits.room_id', 'visits.service_id']);
});

test('исторический баг №3: admission-modal.js — users.license_number', () => {
  const src = "supabase.from('users').select('id, full_name, specialty, license_number').eq('is_doctor', 1);";
  const { queries } = extractQueries(src, 'views/admission-modal.js');
  const bad = checkQuery(queries[0]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].msg, 'unknown column');
  assert.equal(bad[0].what, 'column "license_number"');
});

// ─── СТОРОЖ САМОГО СТОРОЖА ──────────────────────────────────────────────────
test('вымышленный вид, просящий нечитаемую колонку, валит проверку', () => {
  // Ровно та проверка, которую делает обход дерева, — на файле, которого в
  // дереве нет. Если этот тест зелёный, а обход молчит, молчит обход, а не код.
  const FIXTURE = [
    "import { supabase } from '../../supabase.js';",
    "export async function renderFictionalScreen(root) {",
    "    const { data } = await supabase.from('patients')",
    "        .select('id, full_name, favourite_colour')",
    "        .eq('active', true);",
    "    root.textContent = (data || []).length;",   // вот так ошибка и становится пустотой
    "}",
  ].join('\n');
  const { queries } = extractQueries(FIXTURE, 'views/__fixture__.js');
  const bad = queries.flatMap(checkQuery);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].msg, 'unknown column');
  assert.equal(bad[0].what, 'column "favourite_colour"');
  assert.equal(bad[0].status, 400);
  assert.ok(!BASELINE.has(keyOf(bad[0])), 'выдуманный дефект не должен быть в baseline');
});

test('вымышленный вид с несуществующим фильтром и сортировкой тоже валит проверку', () => {
  const FIXTURE = [
    "supabase.from('visits').select('id, visit_date')",
    "    .eq('unicorn_id', 1)",
    "    .order('unicorn_at', { ascending: false });",
  ].join('\n');
  const bad = extractQueries(FIXTURE, 'views/__fixture2__.js').queries.flatMap(checkQuery);
  assert.deepEqual(bad.map((b) => [b.msg, b.what]), [
    ['unknown filter column', 'filter "unicorn_id"'],
    ['unknown column', 'order "unicorn_at"'],
  ]);
});

// ─── ОБХОД ВСЕГО ДЕРЕВА ─────────────────────────────────────────────────────
test('во всём public/js нет НИ ОДНОГО нового запроса к нечитаемой колонке', () => {
  const { violations, unparsed, stats } = scanTree();

  // То, что извлекатель не смог разобрать, — печатается ВСЕГДА, а не
  // пропускается молча: непроверенный запрос должен быть виден.
  const rejected = new Set(violations.map((v) => `${v.file}:${v.line}`)).size;
  console.log(`\n[db-query-schema] файлов ${stats.files}, select-запросов ${stats.queries}, чистых ${stats.clean},`
    + ` проверено фильтров ${stats.filters}; отвергнутых запросов ${rejected} (${violations.length} виноватых токенов)`);
  console.log(`[db-query-schema] не разобрано (${unparsed.length}) — эти запросы НЕ ПРОВЕРЕНЫ:`);
  for (const u of unparsed) console.log(`  ${u.file}:${u.line}  ${u.reason}`);

  const fresh = violations.filter((v) => !BASELINE.has(keyOf(v)));
  const seen = new Set(violations.map(keyOf));
  const stale = [...BASELINE].filter((k) => !seen.has(k));
  if (stale.length) console.log(`[db-query-schema] починено с момента заморозки (${stale.length}) — уберите из BASELINE:\n  ${stale.join('\n  ')}`);

  assert.deepEqual(
    fresh.map((v) => `${v.file}:${v.line} [${v.table}] ${v.msg} -> ${v.what}`),
    [],
    'НОВЫЙ запрос к тому, чего реестр не отдаёт: сервер ответит 400/403, а экран покажет пустой список.'
      + ' Либо исправьте запрос, либо внесите колонку в server/db/schema-registry.js.',
  );
});

test('покрытие извлекателя не проседает: разобрано больше 85% запросов', () => {
  // Сторож самого извлекателя. Сломанный лексер не начнёт врать — он начнёт
  // МОЛЧАТЬ, и без этого порога молчание выглядело бы как «нарушений нет».
  const { unparsed, stats } = scanTree();
  const share = stats.queries / (stats.queries + unparsed.length);
  assert.ok(share > 0.85, `разобрано ${(share * 100).toFixed(1)}% — извлекатель ослеп, проверьте лексер`);
  assert.ok(stats.queries > 400, `найдено всего ${stats.queries} запросов — обход дерева сломан`);
});

// ───────────────────────────────────────────────────────────────────────────
// 5. ВТОРОЙ РУБЕЖ — ПОВЕДЕНИЕ ВО ВРЕМЯ РАБОТЫ (SCHEMA_FAIL_LOUD_V1).
// ───────────────────────────────────────────────────────────────────────────
const okFetch = () => async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 1 }], count: 1 }) });
const errFetch = (status, message) => async () => ({ ok: false, status, json: async () => ({ error: { code: 'x', message } }) });

function captureConsole(fn) {
  const errs = [], warns = [];
  const oe = console.error, ow = console.warn;
  console.error = (...a) => errs.push(a); console.warn = (...a) => warns.push(a);
  return fn().finally(() => { console.error = oe; console.warn = ow; }).then(() => ({ errs, warns }));
}

test('удачный запрос: ok:true, error:null, данные на месте', async () => {
  _resetFailureNotices();
  const db = makeDbClient({ fetch: okFetch(), base: '/api/db', banner: false });
  const r = await db.from('patients').select('id, full_name');
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.data, [{ id: 1 }]);
});

test('отклонённый запрос НЕ бросает и НЕ ломает вид, но перестаёт быть неотличимым от пустоты', async () => {
  _resetFailureNotices();
  const db = makeDbClient({ fetch: errFetch(400, 'unknown column'), base: '/api/db', banner: false });
  let sunk = null;
  onDbQueryFailure((info) => { sunk = info; });

  const { errs } = await captureConsole(async () => {
    // ИМЕННО ТАК написаны ~100 видов — и они обязаны продолжать работать.
    const { data, error, ok } = await db.from('patients').select('id, phone_x');
    assert.equal(data, null);            // форма прежняя: `(data || [])` даст []
    assert.equal(ok, false);             // но пустоту теперь можно отличить от отказа
    assert.equal(error.kind, 'schema');  // и понять, что это баг, а не «данных нет»
    assert.equal(error.status, 400);
  });

  assert.equal(errs.length, 1, 'ошибка схемы обязана попасть в console.error');
  assert.ok(String(errs[0][0]).includes('[db]'));
  assert.equal(sunk.kind, 'schema');
  assert.equal(sunk.table, 'patients');
  assert.deepEqual(sunk.descriptor.columns, 'id, phone_x');
  _resetFailureNotices();
});

test('403 и обрыв сети — НЕ ошибки схемы: пустота там законна, пугать клинику нечем', async () => {
  _resetFailureNotices();
  const forbidden = makeDbClient({ fetch: errFetch(403, 'not allowed'), base: '/api/db', banner: false });
  const r1 = await captureConsole(async () => {
    const { error } = await forbidden.from('patients').select('*');
    assert.equal(error.kind, 'permission');
  });
  assert.equal(r1.errs.length, 0, '403 не должен кричать как баг программы');
  assert.equal(r1.warns.length, 1);

  const offline = makeDbClient({ fetch: async () => { throw new Error('network down'); }, base: '/api/db', banner: false });
  const { error } = await offline.from('patients').select('*');
  assert.equal(error.kind, 'network');
  assert.equal(error.status, 0);

  // 'unknown table' и 'unknown embed' отвечают 403 — тем же кодом, что и
  // «не положено». Различает их сообщение, а не статус.
  assert.equal(classifyDbError(403, 'unknown table'), 'schema');
  assert.equal(classifyDbError(403, 'not allowed'), 'permission');
  assert.equal(classifyDbError(500, 'Query failed.'), 'server');
  _resetFailureNotices();
});

test('плашка: одна на (таблица+сообщение), не больше трёх за сеанс, и только для ошибок схемы', async () => {
  _resetFailureNotices();
  const nodes = [];
  const el = () => ({
    style: { cssText: '' }, children: [], hidden: false,
    setAttribute() {}, addEventListener() {}, remove() {},
    appendChild(c) { this.children.push(c); }, set textContent(v) { this._t = v; }, get textContent() { return this._t; },
  });
  globalThis.document = { body: { appendChild: (n) => nodes.push(n) }, createElement: () => el() };
  try {
    const bad = makeDbClient({ fetch: errFetch(400, 'unknown column'), base: '/api/db' });
    await captureConsole(async () => {
      await bad.from('patients').select('a');
      await bad.from('patients').select('b');       // та же таблица+сообщение -> без второй плашки
      assert.equal(nodes.length, 1);
      const ok403 = makeDbClient({ fetch: errFetch(403, 'not allowed'), base: '/api/db' });
      await ok403.from('visits').select('*');       // не схема -> плашки нет
      assert.equal(nodes.length, 1);
    });
  } finally { delete globalThis.document; _resetFailureNotices(); }
});

test('.throwOnError() — явное согласие на взрыв, для нового кода и тестов', async () => {
  _resetFailureNotices();
  const db = makeDbClient({ fetch: errFetch(400, 'unknown column'), base: '/api/db', banner: false });
  await captureConsole(async () => {
    await assert.rejects(
      async () => { await db.from('patients').select('nope').throwOnError(); },
      (e) => e.dbError.kind === 'schema' && /patients select/.test(e.message),
    );
  });
  _resetFailureNotices();
});
