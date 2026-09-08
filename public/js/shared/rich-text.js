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
const STYLE_PROPS = new Set(['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'text-align']);

/** Единственный разрешённый класс — таблица вставленных результатов. */
const CLASS_OK = new Set(['a4-restbl']);

const VOID = new Set(['br']);

function cleanStyle(value) {
  const out = [];
  for (const part of String(value).split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop)) continue;
    // url(), выражения и схемы-скрипты в значении не нужны ни одному из свойств.
    if (/(url\(|javascript:|vbscript:|expression\()/i.test(val)) continue;
    if (/[<>"']/.test(val)) continue;
    out.push(prop + ': ' + val);
  }
  return out.join('; ');
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
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const text = raw.slice(i, m.index);
    i = re.lastIndex;
    if (!dropDepth) out += text;
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
    if (!ALLOWED.has(tag)) continue;   // тег вырезан, содержимое остаётся
    if (closing) { if (!VOID.has(tag)) out += '</' + tag + '>'; continue; }
    out += '<' + tag + cleanAttrs(m[2] || '') + (VOID.has(tag) ? '>' : '>');
  }
  if (!dropDepth) out += raw.slice(i);
  return out.trim();
}

/** Есть ли в значении хоть какой-то текст (пустые <p><br></p> не считаются). */
export function richIsEmpty(html) {
  return htmlToText(html).trim() === '';
}

/**
 * Читаемый текст из разметки — для списков, поиска и мест, где разметки быть
 * не должно (диагноз, подписи, короткие сводки).
 */
export function htmlToText(input) {
  const raw = String(input == null ? '' : input);
  if (!raw) return '';
  return raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h3|h4)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
