// V3120_I18N — СТОРОЖ СООБЩЕНИЙ СЕРВЕРА.
//
// Экран переводит сообщение сервера через tr(), а tr() узнаёт только ЦЕЛУЮ
// строку словаря (public/js/admin/i18n-strings.js). Отсюда два способа
// показать человеку не его язык:
//   1. английская фраза сервера без словарной статьи — русский экран
//      показывает английский («Query failed.», «not allowed»);
//   2. русская фраза без uz/en — узбекский и английский экраны показывают
//      русский.
// Инспекция v3.12.0 насчитала 235 первых и 383 вторых. Этот тест находит
// сообщения там, где сервер их отдаёт экрану, и требует для каждой статической
// фразы полную статью словаря.
//
// Где ищем (статический строковый литерал сразу после):
//   new XxxError(          — RpcError и доменные ошибки со статусом; голый
//                            Error/TypeError/RangeError — только если рядом
//                            ставится .status (иначе это 500 «Ошибка сервера»)
//   throw helper(          — refusal()/tabError()/conflictError() …
//   error: { … message:    — ответы маршрутов
//   code: 'x', message:    — то же, в другой записи
//   bad(res, … / refuse(res, …
//   reason: / refusal:     — отказы, которые маршрут отдаёт как message
//   ok: false, message:    — валидация routes/users.js
//   rpcT(Ctor, / withTemplate(new Ctor(…), — ШАБЛОНЫ собранных фраз
//
// Собранная фраза (`… ${x} …`, 'текст ' + x) словарём не переводится вовсе —
// её лечат шаблоном (server/services/server-message.js: rpcT/withTemplate), а
// не статьёй. Такие фразы тест не требует, но и не прячет: их число печатается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const { STRINGS } = await import(pathToFileURL(path.join(REPO, 'public', 'js', 'admin', 'i18n-strings.js')).href);

// Временных исключений больше нет: reports.js, day.js и rpc/index.js сняты
// вместе с проходом V3120_PERF (собранные фразы отчётов — через rpcT). Набор
// оставлен пустым как место для такого исключения — не расширять без причины.
const PENDING_FILES = new Set([]);

// Решения, а не пропуски: каждое — с причиной.
const EXEMPT = [
  // Отказы усыновления буквы филиала: английский текст — ДИАГНОСТИКА для
  // лога (см. комментарий к refusal() в identity.js); экран получает
  // русскую фразу по коду причины (rpc/branch-sync.js reasonText).
  (r) => r.file === 'server/services/branch-sync/identity.js' && r.kind === 'throwFn',
];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'test-helpers' && e.name !== 'migrations') yield* walk(p);
    } else if (e.name.endsWith('.js') && !/\.test\./.test(e.name)) yield p;
  }
}

// Строковый литерал с позиции i (кавычка). { text, end, dyn } или null.
function readLit(src, i) {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let out = ''; let dyn = false; let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { const n = src[j + 1]; out += n === 'n' ? '\n' : n; j += 2; continue; }
    if (c === q) return { text: out, end: j + 1, dyn };
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      dyn = true; let depth = 1; j += 2; out += '{…}';
      while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      continue;
    }
    if (q !== '`' && c === '\n') return null;
    out += c; j++;
  }
  return null;
}

const CYR = /[Ѐ-ӿ]/;
const PREFIX = [
  ['newErr', /new\s+([A-Za-z]*Error)\s*\(\s*(?:\d{3}\s*,\s*)?/g],
  ['throwFn', /throw\s+(?!new\b)([a-zA-Z_]\w*)\s*\(\s*(?:\d{3}\s*,\s*)?(?:'[a-z_]+'\s*,\s*)?/g],
  ['jsonErr', /error\s*:\s*\{[^{}]*?message\s*:\s*/g],
  ['codeMsg', /\bcode\s*:\s*'[a-z_]+'\s*,\s*message\s*:\s*/g],
  ['badRes', /\b(bad|refuse)\s*\(\s*res\s*,\s*(?:\d{3}\s*,\s*)?(?:'[a-z_]+'\s*,\s*)?/g],
  ['reason', /\b(reason|refusal)\s*:\s*/g],
  ['okFalse', /\bok\s*:\s*false\s*,\s*(?:message|error)\s*:\s*/g],
  ['rpcT', /\brpcT\(\s*\w+\s*,\s*/g],
  ['withT', /withTemplate\(\s*new\s+\w+\([^)]*\)\s*,\s*/g],
  // Функции-отказы, возвращающие текст (…Refusal(), managedRefusal …): берём
  // только законченное предложение, а не подписи и коды.
  ['return', /\breturn\s+(?=['"])/g],
  // Отказ, собранный объектом ({ allowed: false, message: '…' }, предупреждения
  // с message) — только русские законченные фразы: английский `message:` в
  // сервере — это в основном журнал и диагностика.
  ['message', /\bmessage\s*:\s*/g],
];

function scan() {
  const found = [];
  for (const f of walk(path.join(REPO, 'server'))) {
    const file = path.relative(REPO, f).split(path.sep).join('/');
    const src = fs.readFileSync(f, 'utf8');
    for (const [kind, rx] of PREFIX) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(src))) {
        const ident = m[1] || '';
        const lit = readLit(src, m.index + m[0].length);
        if (!lit) continue;
        const after = src.slice(lit.end, lit.end + 200);
        const s = lit.text;
        if (!s.trim()) continue;
        // Голый Error без статуса — это 500 «Ошибка сервера», и его текст
        // человеку не виден… если он английский. Русский текст в голом Error
        // пишут для человека: его показывают обёртки (asRpcError, walletGuard),
        // поэтому русский голый Error проверяется наравне с RpcError.
        if (kind === 'newErr' && /^(Error|TypeError|RangeError)$/.test(ident)
          && !CYR.test(s) && !/\.status\s*=|status\s*:\s*\d/.test(after)) continue;
        if (kind === 'message' && !(CYR.test(s) && /[.!?]$/.test(s))) continue;
        if (kind === 'return' && !(s.length > 15 && /[.!?]$/.test(s) && /^\s*;/.test(after))) continue;
        const cyr = CYR.test(s);
        // Коды и идентификаторы ('bad_letter', 'no_phone') — не фразы.
        if (!cyr && !/[A-Za-z]{2,}[^]*[\s.:]/.test(s)) continue;
        const r = {
          file, kind, text: s, cyr,
          line: src.slice(0, m.index).split('\n').length,
          assembled: lit.dyn || /^\s*\+/.test(after),
        };
        if (EXEMPT.some((fn) => fn(r))) continue;
        found.push(r);
      }
    }
  }
  return found;
}

const FOUND = scan();
const where = (r) => `  ${r.file}:${r.line}  ${JSON.stringify(r.text.slice(0, 110))}`;
const complete = (s) => { const e = STRINGS[s] || STRINGS[s.trim()]; return !!(e && e.ru && e.uz && e.en); };

test('сторож видит сообщения сервера (сломанный разбор не должен сойти за чистоту)', () => {
  assert.ok(FOUND.length > 800, 'нашлось всего ' + FOUND.length + ' сообщений — разбор сломан?');
  assert.ok(FOUND.some((r) => r.kind === 'rpcT'), 'не видно ни одного шаблона rpcT()');
  assert.ok(FOUND.some((r) => r.file === 'server/routes/auth.js'), 'не видно routes/auth.js');
});

test('ни одной английской фразы сервера без перевода: русский экран не показывает английский', () => {
  const bad = FOUND.filter((r) => !r.cyr && !PENDING_FILES.has(r.file) && !(r.assembled ? false : complete(r.text)));
  assert.deepEqual(bad.map(where), [],
    'английская фраза сервера дойдёт до человека как есть. Напишите её по-русски (и статью uz/en в блок '
    + '«V3120_I18N — сообщения сервера» i18n-strings.js) или, если это машинный словарь, дайте статью ru/uz:\n'
    + bad.map(where).join('\n'));
});

test('каждая статическая русская фраза сервера переведена на узбекский и английский', () => {
  const bad = FOUND.filter((r) => r.cyr && !r.assembled && !PENDING_FILES.has(r.file) && !complete(r.text));
  const uniq = [...new Map(bad.map((r) => [r.text, r])).values()];
  assert.deepEqual(uniq.map(where), [],
    'узбекский и английский экраны покажут эти фразы по-русски — добавьте статьи (ключ — фраза целиком) '
    + 'в блок «V3120_I18N — сообщения сервера» i18n-strings.js:\n' + uniq.map(where).join('\n'));
});

test('шаблоны собранных фраз (rpcT/withTemplate) — ключи словаря с теми же дырками', () => {
  const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const bad = [];
  for (const r of FOUND.filter((x) => x.kind === 'rpcT' || x.kind === 'withT')) {
    if (r.assembled) { bad.push(where(r) + ' — шаблон сам собран из кусков'); continue; }
    const e = STRINGS[r.text];
    if (!e) { bad.push(where(r) + ' — нет статьи'); continue; }
    for (const l of ['uz', 'en']) if (holes(e[l]) !== holes(r.text)) bad.push(where(r) + ` — дырки [${l}] не совпадают`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('отчёт: собранные фразы без шаблона (переводятся только на русском экране)', () => {
  const assembled = FOUND.filter((r) => r.cyr && r.assembled && !PENDING_FILES.has(r.file));
  // Не падение, а видимость долга: число должно только уменьшаться.
  console.log(`[i18n-server] собранных русских фраз без шаблона: ${assembled.length}`);
  assert.ok(assembled.length < 200, 'собранных фраз стало больше — новые пишите через rpcT()');
});
