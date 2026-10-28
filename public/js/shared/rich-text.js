// CASE_DOC_A4_V1 — разметка документа: одна санитария на браузер и сервер.
//
// Документ истории болезни пишется форматируемым текстом (лист A4 с разделами,
// как в кабинете врача), то есть в базу едет HTML. Всё, что попадает в базу
// разметкой, однажды возвращается в чужой браузер через innerHTML — и потому
// проходит здесь.
//
// ПОЧЕМУ НЕ DOMParser. Тот санитайзер уже есть (admin/sanitize.js) и работает
// в браузере, но у сервера DOM нет: RPC admission_review_save обязан чистить
// значение САМ, не полагаясь на то, что запрос пришёл из нашего экрана
// (/api/rpc открыт curl'ом с любого компьютера клиники). Поэтому здесь —
// разбор без DOM, по списку разрешённого, и он общий для обеих сторон.
//
// СПИСОК РАЗРЕШЁННОГО, А НЕ ЗАПРЕЩЁННОГО. Запрещать перечислением — гонка,
// которую проигрывают: завтра появится тег, о котором список не знал. Здесь
// наоборот: всё, чего нет в списке, вырезается.

/** Теги оформления текста и таблицы результатов — всё остальное вырезается. */
const ALLOWED = new Set([
  'p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'span', 'h3', 'h4',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

/** Теги, которые вырезаются ВМЕСТЕ С СОДЕРЖИМЫМ: их текст — не текст документа. */
const DROP_WHOLE = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
  'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'noscript',
]);

/** Свойства style, которые врач действительно ставит форматированием. */
// DOC_RICH_FORMAT_V1 (F4) — и размер (A+/A−), и text-decoration-line: так Chrome
// со styleWithCSS пишет подчёркивание и зачёркивание.
const STYLE_PROPS = new Set(['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'text-align', 'font-size']);

// DOC_RICH_FORMAT_V1 (F4) — размер шрифта только ключевым словом: пиксели и
// проценты ломали бы бланк, а -webkit-xxx-large — не размер документа.
const FONT_SIZE_OK = new Set(['x-small', 'small', 'medium', 'large', 'x-large', 'xx-large']);
// <font size="1…7"> — те же ключевые слова; 7 у документа — самый крупный, xx-large.
const FONT_SIZE_BY_NUM = ['', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xx-large'];

/** Разрешённые классы — таблица вставленных результатов и таблица документа (DOC_RICH_FORMAT_V1, F6). */
const CLASS_OK = new Set(['a4-restbl', 'a4-tbl']);

const VOID = new Set(['br']);

// DOC_RICH_FORMAT_V1 (ревью T1, HIGH 1) — ЗНАЧЕНИЕ STYLE, КОТОРОЕ БРАУЗЕР
// ПРОЧТЁТ ИНАЧЕ, ЧЕМ ЕГО ПРОВЕРИЛИ, выбрасывается, а не чинится. Атрибут
// браузер сначала расшифровывает: «&#59» без «;» — это «;» (ещё одно свойство:
// position:fixed поверх листа), «&#117rl(» — «url(» (запрос из Chrome Telegram
// к сети клиники или file://). CSS сам понимает «\75rl(» и комментарии «/**/»
// посреди слова. Поэтому в значении нет места ни «&», ни «\», ни «/», ни
// кавычкам; из функций — только цвета rgb()/hsl(). Проверка — и до, и после
// расшифровки сущностей.
const STYLE_VALUE_OK = /^[a-z0-9#.,%()\s-]*$/i;
const STYLE_VALUE_BAD = /url\s*\(|expression\s*\(|image-set|@import|javascript:|vbscript:|behavior|-moz-binding|[\u0000-\u001f]/i;
const STYLE_FN_OK = /^(?:rgba?|hsla?)$/i;
const NAMED_REF = { semi: ';', colon: ':', lpar: '(', rpar: ')', sol: '/', bsol: '\\', comma: ',', period: '.', quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', num: '#', excl: '!', tab: '\t', newline: '\n' };
function decodeRefs(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16) || 0, 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(parseInt(d, 10) || 0, 0x10ffff)))
    .replace(/&([a-z]+);?/gi, (m, n) => (Object.prototype.hasOwnProperty.call(NAMED_REF, n.toLowerCase()) ? NAMED_REF[n.toLowerCase()] : m));
}
function styleValueSafe(val) {
  for (const v of [val, decodeRefs(val)]) {
    if (!STYLE_VALUE_OK.test(v) || STYLE_VALUE_BAD.test(v)) return false;
    for (const fn of v.matchAll(/([a-z-]*)\s*\(/gi)) if (!STYLE_FN_OK.test(fn[1])) return false;
  }
  return true;
}

function cleanStyle(value) {
  const out = [];
  for (const part of String(value).split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop)) continue;
    // url(), выражения и схемы-скрипты в значении не нужны ни одному из свойств.
    // DOC_RICH_FORMAT_V1 (ревью T1) — и сущности, экранирование, комментарии (styleValueSafe).
    if (!val || !styleValueSafe(val)) continue;
    if (prop === 'font-size' && !FONT_SIZE_OK.has(val.toLowerCase())) continue;   // DOC_RICH_FORMAT_V1
    out.push(prop + ': ' + val);
  }
  return out.join('; ');
}

/**
 * DOC_RICH_FORMAT_V1 (F4) — прежний <font color size> (execCommand без
 * styleWithCSS) → атрибуты <span style>. Цвет — только #hex, rgb()/rgba() или
 * имя цвета; размер — по таблице 1–7. Всё прочее (face, on*, выражения) уходит.
 */
function fontToSpanAttrs(raw) {
  let color = '';
  let size = '';
  const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    const value = String(m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] || ''))).trim();
    if (name === 'color' && /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%]+\)|[a-z]{3,20})$/i.test(value)) color = value;
    else if (name === 'size' && /^[1-7]$/.test(value)) size = FONT_SIZE_BY_NUM[Number(value)];
  }
  const style = [color ? 'color: ' + color : '', size ? 'font-size: ' + size : ''].filter(Boolean).join('; ');
  return style ? ' style="' + style + '"' : '';
}

// DOC_RICH_FORMAT_V1 — «<» и «>» текста, не ставшие тегом, экранируются.
// Раньше «<img src=x onerror=…» без закрывающей «>» уходил сырым текстом, а
// в листе за ним стоит «</div>» — и браузер дочитывал тег до него.
// DOC_RICH_FORMAT_V1 (ревью T1, HIGH 2) — и «&», не начинающий сущность: прежний
// простой текст («AT&T», «a &copy b») в разметке значит ровно то, что набрано, а
// очищенное — стабильно: второй проход его не меняет.
function escText(text) {
  return text.replace(/&(?!(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanAttrs(raw) {
  const out = [];
  const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] || ''));
    if (name === 'style') {
      const style = cleanStyle(value);
      if (style) out.push('style="' + style + '"');
    } else if (name === 'class') {
      const keep = String(value).split(/\s+/).filter((c) => CLASS_OK.has(c));
      if (keep.length) out.push('class="' + keep.join(' ') + '"');
    }
    // Всё прочее — включая on*, href, src, id — не проходит.
  }
  return out.length ? ' ' + out.join(' ') : '';
}

/**
 * Разметка документа, очищенная до оформления.
 *
 * @param {string} input сырой HTML из редактора или из базы
 * @returns {string} HTML только из разрешённых тегов и атрибутов
 */
export function sanitizeStoredHtml(input) {
  const raw = String(input == null ? '' : input);
  if (!raw) return '';
  let out = '';
  let i = 0;
  let dropDepth = 0;
  let dropTag = '';
  // DOC_RICH_FORMAT_V1 (ревью T1, LOW 6) — РАЗМЕТКА ВЫХОДИТ ЗАКРЫТОЙ. Закрывающий
  // тег без открытого (лишний «</font>» стал бы «</span>» и закрыл чужой span
  // раньше времени) выбрасывается; незакрытое закрывается в конце — иначе
  // жирный раздела «протекал» бы на следующие разделы листа.
  // В стеке — исходные имена: «font» закрывается своим «</font>» (а пишется </span>),
  // «</span>» закрывает только настоящий span.
  const open = [];
  const closeTo = (t) => {
    const k = open.lastIndexOf(t);
    if (k < 0) return;
    while (open.length > k) { const o = open.pop(); out += '</' + (o === 'font' ? 'span' : o) + '>'; }
  };
  const top = () => open[open.length - 1];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const text = raw.slice(i, m.index);
    i = re.lastIndex;
    if (!dropDepth) out += escText(text);
    const tag = (m[1] || '').toLowerCase();
    if (!tag) continue;   // комментарий или директива — просто выброшены
    const closing = m[0][1] === '/';
    if (dropDepth) {
      if (tag === dropTag) dropDepth += closing ? -1 : 1;
      if (dropDepth <= 0) { dropDepth = 0; dropTag = ''; }
      continue;
    }
    if (DROP_WHOLE.has(tag)) {
      if (!closing && !/\/\s*>$/.test(m[0])) { dropDepth = 1; dropTag = tag; }
      continue;
    }
    // DOC_RICH_FORMAT_V1 (F4) — <font> становится <span style>, пара сохраняется.
    const isFont = tag === 'font';
    if (!isFont && !ALLOWED.has(tag)) continue;   // тег вырезан, содержимое остаётся
    const t = tag;
    if (closing) { if (!VOID.has(t)) closeTo(t); continue; }
    // Пункт, ячейка и строка без закрывающего тега закрываются следующими, как в HTML.
    if (t === 'li' && top() === 'li') closeTo('li');
    if ((t === 'td' || t === 'th' || t === 'tr') && (top() === 'td' || top() === 'th')) closeTo(top());
    if (t === 'tr' && top() === 'tr') closeTo('tr');
    out += isFont ? '<span' + fontToSpanAttrs(m[2] || '') + '>' : '<' + t + cleanAttrs(m[2] || '') + '>';
    if (!VOID.has(t)) open.push(t);
  }
  if (!dropDepth) out += escText(raw.slice(i));
  while (open.length) { const o = open.pop(); out += '</' + (o === 'font' ? 'span' : o) + '>'; }
  return out.trim();
}

/**
 * DOC_RICH_FORMAT_V1 (ревью T1, MEDIUM 3) — «\n» текста разметки — строка (<br>).
 * Редактор шаблона — pre-wrap, и Shift+Enter пишет там «\n»; лист рисует
 * разметку white-space:normal, где «\n» — пробел, и «Почки: норма\nПечень: норма»
 * печаталось одной строкой. Пробелы между блоками (ul, li, таблица) — не строка
 * документа, их «\n» не трогается; «\n» сразу после <br> — оформление исходника.
 */
const BLOCK_EDGE_RE = /^<\/?(?:p|div|ul|ol|li|table|thead|tbody|tfoot|tr|th|td|h3|h4)\b/i;
export function textBreaks(html) {
  const parts = String(html == null ? '' : html).split(/(<[^<>]*>)/);
  return parts.map((s, k) => {
    if (k % 2 || s.indexOf('\n') < 0) return s;
    const prev = parts[k - 1] || '';
    const next = parts[k + 1] || '';
    if (!/\S/.test(s) && (k === 0 || k === parts.length - 1 || BLOCK_EDGE_RE.test(prev) || BLOCK_EDGE_RE.test(next))) return s;
    const body = /^<br\b/i.test(prev) ? s.replace(/^\r?\n/, '') : s;
    return body.replace(/\r?\n/g, '<br>');
  }).join('');
}

/**
 * DOC_RICH_FORMAT_V1 (T3) — есть ли что хранить: текст или таблица. Пустая
 * таблица (только что вставленная, ячейки ещё не заполнены) — содержание
 * раздела, её не стирают. Для вопроса «есть ли в разделе ТЕКСТ» (пустой
 * документ, переподпись) — richIsEmpty: таблица без текста — не текст.
 */
export function richHasContent(html) {
  return !richIsEmpty(html) || /<table\b/i.test(String(html == null ? '' : html));
}

/**
 * DOC_RICH_FORMAT_V1 — разметка ли это документа: есть хоть один тег
 * оформления целиком, с «>». Прежний простой текст с «<» («SpO2 <95%», «a < b»)
 * разметкой не считается и показывается, как раньше, текстом.
 */
const MARKUP_RE = /<\/?(?:p|div|br|b|strong|i|em|u|s|sub|sup|ul|ol|li|span|h3|h4|table|thead|tbody|tr|th|td|font)(?:\s[^<>]*)?\/?>/i;
export function hasMarkup(input) {
  return MARKUP_RE.test(String(input == null ? '' : input));
}

/** Есть ли в значении хоть какой-то текст (пустые <p><br></p> не считаются). */
export function richIsEmpty(html) {
  return htmlToText(html).trim() === '';
}

/**
 * Читаемый текст из разметки — для списков, поиска и мест, где разметки быть
 * не должно (диагноз, подписи, короткие сводки).
 *
 * DOC_RICH_FORMAT_V1 — одно правило строк на всё приложение (то, что кабинет
 * держал в _blankStrip, CABINET_FIX_V1_R3 F10 и R4 п. 9): граница блока —
 * один перевод строки, и начало блока после текста тоже («код<div>текст</div>»
 * — две строки, а не «кодтекст»); пустой блок (<div><br></div>) — пустая
 * строка; <br> перед блоком — не лишняя пустая строка. Списки и таблицы
 * прозрачны: пункт и строка таблицы — строка, ячейки — через табуляцию (F8).
 * «&amp;» расшифровывается последним: набранное «&lt;» остаётся «&lt;».
 */
export function htmlToText(input) {
  const raw = String(input == null ? '' : input);
  if (!raw) return '';
  return raw
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:ul|ol|table|thead|tbody|tfoot)\b[^<>]*>/gi, '')
    .replace(/<\/(?:td|th)\s*>/gi, '\t')
    .replace(/<(div|p|li|tr|h3|h4)\b[^<>]*>\s*<br\s*\/?>\s*<\/\1\s*>/gi, '\u0002\u0001')
    .replace(/<br\s*\/?>\s*(?=<(?:div|p|li|tr|h3|h4)\b|\u0002)/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(?:div|p|li|tr|h3|h4)\b[^<>]*>/gi, '\u0002').replace(/<\/(?:div|p|li|tr|h3|h4)\s*>/gi, '\u0001')
    .replace(/\u0001\u0002/g, '\n').replace(/[\u0001\u0002]/g, '\n')
    .replace(/<[^<>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
