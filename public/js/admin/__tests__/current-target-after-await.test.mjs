// BUTTON_REENABLE_V1 (2026-10-02) — ГВАРД: event.currentTarget НЕ читается после
// первого await внутри того же async-обработчика.
//
// Браузер обнуляет event.currentTarget сразу по завершении СИНХРОННОЙ фазы
// диспетчеризации события — то есть до того, как async-обработчик возобновится
// после своего первого await. Частый паттерн
//
//   onclick: async (ev) => {
//       ev.currentTarget.disabled = true;
//       try { await something(); }
//       finally { if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false; }
//   }
//
// работает для ПЕРВОГО обращения (до await), но второе — уже после await —
// читает null: кнопка либо тихо не разблокируется (с `?.`), либо падает
// (без `?.`). Если обработчик закрывает окно при успехе, это прячется; при
// ОШИБКЕ сохранения кнопка остаётся мёртвой, пока окно не закроют и не
// откроют снова, теряя правки.
//
// Это не парсер — эвристика на регулярках/скобках, которая, по опыту первого
// прогона по этой базе, обязана:
//   * вырезать комментарии и строки/шаблоны ДО поиска — иначе комментарии,
//     которые ОПИСЫВАЮТ этот самый баг («...после него event.currentTarget...»,
//     «...до первого await...»), сами себя ловят;
//   * у каждого обращения к `currentTarget` найти, КАКАЯ функция владеет его
//     левой частью (ev / e / event — чей это параметр), а не просто «ближайшая
//     async-функция» — иначе любой синхронный onmouseenter/onmouseleave вида
//     `(e) => { e.currentTarget... }`, оказавшийся текстуально ПОСЛЕ чужого
//     await (например, внутри async-колбэка setTimeout, который сначала грузит
//     данные), ложно считается «после await» — хотя у async тут нет ничего:
//     это его СОБСТВЕННЫЙ e из СВЕЖЕЙ, синхронной диспетчеризации;
//   * не путать «await ПОСЛЕ которого» с «await ВЫЗОВА, аргументом которого
//     является currentTarget» — `await foo(ev.currentTarget)` читает его
//     синхронно, ДО того как await успевает что-либо подвесить (аргументы
//     вычисляются до вызова). Но если currentTarget вместо этого лежит внутри
//     ТЕЛА вложенной функции, переданной таким аргументом (колбэк, который
//     вызовут позже, а не вычислят на месте — как `onSlotTaken: (err) => { ...
//     ev.currentTarget... }`), это уже не аргумент, а чужая отложенная
//     продолжение — и флаг должен сработать.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_JS = path.resolve(__dirname, '..', '..');   // .../public/js

function listJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'vendor') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listJsFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

// Comments and string/template contents -> spaces, same length & line breaks,
// so later regexes never match prose, and reported line numbers stay accurate.
function sanitize(src) {
    let out = '';
    const n = src.length;
    let i = 0;
    while (i < n) {
        const c = src[i];
        if (c === '"' || c === '\'' || c === '`') {
            const quote = c; out += ' '; i += 1;
            while (i < n) {
                if (src[i] === '\\') { out += '  '; i += 2; continue; }
                if (src[i] === quote) { out += ' '; i += 1; break; }
                out += (src[i] === '\n' ? '\n' : ' '); i += 1;
            }
            continue;
        }
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { out += ' '; i += 1; } continue; }
        if (c === '/' && src[i + 1] === '*') {
            out += '  '; i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += (src[i] === '\n' ? '\n' : ' '); i += 1; }
            if (i < n) { out += '  '; i += 2; }
            continue;
        }
        out += c; i += 1;
    }
    return out;
}

function findMatchingBrace(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
}

// Every function literal (async or not; `function`, `function name()`, `(a,b) =>`,
// bare `a =>`), as { start, end, isAsync, params } — start/end are the body's
// own `{`/`}` indices. Operates on already-sanitized text.
// [^()]* (not [^)]*) on purpose: a call like `h('button', { onclick: async (ev) => {`
// must NOT let the arrow alternative start-match from `h`'s own `(` — `[^)]*` would
// happily skip over the intervening `(ev` (since `(` isn't excluded) and treat `(ev)`'s
// `)` as ITS closing paren, misreading "onclick" as the param name. Disallowing nested
// parens entirely forces the match to start at the real `(ev)`; the cost is that this
// doesn't see destructured/defaulted params with their own parens, which no event
// handler in this codebase uses.
// No SHARED leading `\b` before the whole alternation: the paren-arrow branch
// starts with `(`, a non-word char, so a word-boundary assertion right before
// it can fail to match at all (e.g. right after whitespace, a non-word ->
// non-word position has no boundary) and silently drop every `(x) => {` match.
// `\b` instead sits only where a branch actually starts with a word char.
const FN_RE = /(\basync\s+)?(?:\bfunction\b\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)|\bfunction\b\s*\(([^()]*)\)|\(([^()]*)\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>)\s*\{/g;
function paramNames(paramsStr) {
    if (!paramsStr) return [];
    return paramsStr.split(',').map((p) => {
        const m = p.trim().match(/^([A-Za-z_$][\w$]*)/);
        return m ? m[1] : null;
    }).filter(Boolean);
}
function findFunctionRanges(sanitized) {
    const ranges = [];
    const re = new RegExp(FN_RE);
    let m;
    while ((m = re.exec(sanitized))) {
        const openIdx = m.index + m[0].length - 1;
        const closeIdx = findMatchingBrace(sanitized, openIdx);
        if (closeIdx !== -1) {
            const paramsStr = m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
            ranges.push({ start: openIdx, end: closeIdx, isAsync: !!m[1], params: paramNames(paramsStr) });
        }
        re.lastIndex = openIdx + 1;   // keep scanning inside, so nested functions are also found
    }
    return ranges;
}

// Does `after` (text right after an `await` token, up to the occurrence) show
// that the awaited expression had ALREADY concluded before reaching the
// occurrence? True => this await disqualifies (occurrence is genuinely past it).
function awaitExpressionConcludedBefore(after) {
    let bal = 0;
    for (const ch of after) {
        if (ch === '(') bal += 1;
        else if (ch === ')') { bal -= 1; if (bal <= 0) return true; }
    }
    return bal <= 0;
}

const CURRENT_TARGET_RE = /([A-Za-z_$][\w$]*)\s*\??\.\s*currentTarget\b/g;
const AWAIT_RE = /\bawait\b/g;

function findSites(sanitized, fnRanges) {
    const sites = [];
    const re = new RegExp(CURRENT_TARGET_RE);
    let m;
    while ((m = re.exec(sanitized))) {
        const idx = m.index;
        const receiver = m[1];
        const containing = fnRanges.filter((r) => r.start <= idx && idx <= r.end)
            .sort((a, b) => (a.end - a.start) - (b.end - b.start));
        // Owner: nearest enclosing function (innermost first) whose OWN parameter
        // is named `receiver` — normal JS shadowing. An onmouseenter's own `(e)`
        // owns `e` even if it sits lexically inside someone else's async body.
        const owner = containing.find((r) => r.params.includes(receiver));
        if (!owner || !owner.isAsync) continue;   // no suspension possible -> safe

        let scope = sanitized.slice(owner.start, idx);
        // Blank out nested ASYNC function bodies that fully precede idx and don't
        // contain it — their own internal awaits don't belong to owner's timeline.
        for (const r of fnRanges) {
            if (r !== owner && r.isAsync && r.start > owner.start && r.end <= idx) {
                const relStart = r.start - owner.start, relEnd = r.end - owner.start;
                scope = scope.slice(0, relStart) + ' '.repeat(relEnd - relStart) + scope.slice(relEnd);
            }
        }

        let disqualified = false;
        const awaitRe = new RegExp(AWAIT_RE);
        let am;
        while ((am = awaitRe.exec(scope))) {
            const afterStart = owner.start + am.index + am[0].length;
            // If a nested function body starts between this await and idx and
            // CONTAINS idx, the occurrence lives in a deferred callback (passed as
            // an argument, invoked later) — not an eagerly-evaluated argument, so
            // this await counts against it regardless of paren balance.
            const nestedBody = fnRanges.find((r) => r.start > afterStart && r.start < idx && idx <= r.end);
            if (nestedBody) { disqualified = true; break; }
            if (awaitExpressionConcludedBefore(sanitized.slice(afterStart, idx))) { disqualified = true; break; }
        }
        if (disqualified) {
            const line = sanitized.slice(0, idx).split('\n').length;
            sites.push(line);
        }
    }
    return sites;
}

test('currentTarget не читается после первого await в том же обработчике', () => {
    const files = listJsFiles(PUBLIC_JS);
    const allSites = [];
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        if (!/currentTarget/.test(src)) continue;
        const sanitized = sanitize(src);
        const fnRanges = findFunctionRanges(sanitized);
        const lines = [...new Set(findSites(sanitized, fnRanges))];
        for (const line of lines) allSites.push(path.relative(PUBLIC_JS, file).replace(/\\/g, '/') + ':' + line);
    }
    assert.deepEqual(allSites, [],
        'currentTarget читается после await — кнопка/элемент не восстановится после ошибки:\n  ' + allSites.join('\n  '));
});
