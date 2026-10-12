// API_DOCS_V1 — СТРАНИЦА ДОКУМЕНТАЦИИ: HTML из текста (docs/content.js), чисел
// (docs/facts.js), словарей кода и записанных ответов сервера
// (docs/generated.js). Одна страница на язык, целиком в одном ответе: стили —
// внутри, ни скриптов, ни шрифтов, ни картинок со стороны (работает без JS и
// без интернета, печатается, читается с телефона). Ни данных клиник, ни ключей,
// ни данных пациентов: клиника — пример «Шифо», ключ — переменная оболочки.
import { SCOPES, SCOPE_INFO, EVENTS, EVENT_INFO, curlCommand } from '../../../public/js/shared/api-connections.js';
import { DECLINE_REASONS, webhookBody } from '../../../public/js/shared/api-booking.js';
import { API_GROUPS, PUBLIC_GROUPS } from '../../../public/js/shared/service-public.js';
import { signBody } from '../../../server/services/api/outbox.js';
import { ERRORS } from '../lib/errors.js';
import { PARTNER_STATUSES } from '../store/requests.js';
import { docFacts } from './facts.js';
import { LABELS, RESPONSES } from './generated.js';
import {
  PAGE, SAMPLE, DOCS_CONTACT, SECTIONS, ENDPOINTS, EXAMPLES, STATUS_TEXT, REASON_TEXT, CLOSED_REASONS, EVENT_TEXT, ERROR_TEXT,
  CLINIC_ONLY_ERRORS, FIELD_ERRORS, LIMIT_ROWS, TABLE_HEAD, KIND_TEXT, WEBHOOK_EXAMPLE, VERIFY_NODE, VERIFY_PHP,
} from './content.js';

export const DOCS_PAGE_LANGS = Object.freeze(['ru', 'uz', 'en']);
const DOCS_PATH = { ru: '/docs', uz: '/docs/uz', en: '/docs/en' };

const UNITS = {
  sec: { ru: ['секунда', 'секунды', 'секунд'], uz: 'soniya', en: ['second', 'seconds'] },
  min: { ru: ['минута', 'минуты', 'минут'], uz: 'daqiqa', en: ['minute', 'minutes'] },
  hour: { ru: ['час', 'часа', 'часов'], uz: 'soat', en: ['hour', 'hours'] },
  day: { ru: ['день', 'дня', 'дней'], uz: 'kun', en: ['day', 'days'] },
  time: { ru: ['раз', 'раза', 'раз'], uz: 'marta', en: ['time', 'times'] },
  attempt: { ru: ['попытка', 'попытки', 'попыток'], uz: 'urinish', en: ['attempt', 'attempts'] },
};
const AND = { ru: ['и', 'или'], uz: ['va', 'yoki'], en: ['and', 'or'] };

/** Число с единицей: 24 часа, 1 минута, 5 urinish, 2 times. */
export function withUnit(n, unit, lang) {
  const u = UNITS[unit];
  if (!u) throw new Error('docs: нет единицы ' + unit);
  if (lang === 'uz') return n + ' ' + u.uz;
  if (lang === 'en') return n + ' ' + u.en[n === 1 ? 0 : 1];
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return n + ' ' + u.ru[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2];
}
/** Список: «1, 5, 10, 30 и 60» / «3, 6 или 12». */
export function listOf(arr, lang, or = false) {
  const word = AND[lang][or ? 1 : 0];
  return arr.length < 2 ? arr.join('') : arr.slice(0, -1).join(', ') + ' ' + word + ' ' + arr[arr.length - 1];
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderDocs({ lang = 'ru', base = SAMPLE.base, uncollectedMaxMs } = {}) {
  if (!DOCS_PAGE_LANGS.includes(lang)) throw new Error('docs: нет языка ' + lang);
  const facts = { ...docFacts({ base, ...(uncollectedMaxMs ? { uncollectedMaxMs } : {}) }), contact: DOCS_CONTACT, secret: WEBHOOK_EXAMPLE.secret };
  const fill = (s) => String(s).replace(/\{\{([a-zA-Z]+)(?::([a-z]+))?(\|or)?\}\}/g, (m, k, unit, or) => {
    if (!(k in facts)) throw new Error('docs: нет числа ' + k);
    const v = facts[k];
    if (Array.isArray(v)) return listOf(v, lang, !!or);
    return unit ? withUnit(v, unit, lang) : String(v);
  });
  const t = (l) => fill(l[lang]);
  // Текст: `код`, [ссылка](#якорь | mailto:…); всё прочее экранируется.
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((#[a-z0-9-]+|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const ti = (l) => inline(t(l));
  const label = (ru) => (lang === 'ru' ? ru : (LABELS[ru] && LABELS[ru][lang]) || ru);
  const code = (s) => '<code>' + esc(s) + '</code>';
  const pre = (s) => '<pre tabindex="0"><code>' + esc(s) + '</code></pre>';
  // У каждой ячейки — подпись её столбца (data-label, текст заголовка без разметки):
  // на телефоне строка таблицы — блоком с подписями над значениями (CSS, уже 600 px).
  const table = (head, rows, name) => {
    const labels = head.map((h) => ti(h).replace(/<[^>]+>/g, ''));
    return '<div class="tw" role="region" tabindex="0" aria-label="' + esc(name) + '"><table>'
      + '<thead><tr>' + head.map((h) => '<th scope="col">' + ti(h) + '</th>').join('') + '</tr></thead><tbody>'
      + rows.map((r) => '<tr>' + r.map((c, i) => '<td data-label="' + labels[i] + '">' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  };
  const epOf = (id) => ENDPOINTS.find((e) => e.id === id);
  // В таблицах путь переносится только после «/».
  const epName = (e) => '<code>' + esc(e.method + ' ' + e.path).split('/').join('/<wbr>') + '</code>';
  const epLink = (e) => '<a href="#ep-' + e.id + '">' + epName(e) + '</a>';
  const toPage = (json) => JSON.stringify(json, null, 2).split(SAMPLE.base).join(base);
  const url = (p) => base + '/' + SAMPLE.slug + '/v1' + p;
  const resolve = (v) => {
    if (typeof v === 'string') return v.replace(/\{([a-z]+)\}/g, (m, k) => (k === 'lang' ? lang : SAMPLE.ids[k] || m));
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object' && Object.keys(v).join() === 'ru,uz,en') return v[lang];
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };

  function example(id, { response = true } = {}) {
    const ex = EXAMPLES.find((x) => x.id === id);
    const r = RESPONSES[lang] && RESPONSES[lang][id];
    if (!ex || !r) throw new Error('docs: нет примера ' + id);
    const path = resolve(ex.path);
    const head = ex.title ? ti(ex.title) + ' — ' : '';
    let out = '<div class="ex" data-example="' + ex.id + '">';
    if (ex.curl === false) out += '<p class="ex-h">' + head + code(ex.method + ' ' + path) + '</p>';
    else {
      out += '<p class="ex-h">' + head + esc(t(PAGE.request)) + '</p>'
        + pre(curlCommand({ method: ex.method, url: url(path), key: SAMPLE.keyVar, body: ex.body === undefined ? undefined : resolve(ex.body) }));
    }
    if (response) {
      out += '<p class="ex-h">' + esc(t(PAGE.response)) + ' · ' + r.status + '</p>' + pre(toPage(r.body));
      if (ex.trim) out += '<p class="note">' + ti(PAGE.trimmed) + '</p>';
    }
    return out + '</div>';
  }

  function endpoint(id) {
    const e = epOf(id);
    const access = e.scopes === null ? esc(t(PAGE.noKey)) : !e.scopes.length ? esc(t(PAGE.anyKey))
      : e.scopes.map((s) => code(s) + ' — ' + esc(label(SCOPE_INFO[s].label))).join(' ' + esc(t(PAGE.orWord)) + ' ');
    const m = e.method.toLowerCase();
    let out = '<section class="ep" id="ep-' + e.id + '" aria-labelledby="ep-' + e.id + '-h">'
      + '<h3 id="ep-' + e.id + '-h"><span class="m m-' + m + '">' + e.method + '</span> ' + code(e.path) + '</h3>'
      + '<p class="meta">' + esc(t(PAGE.scope)) + ': ' + access + '</p><p>' + ti(e.summary) + '</p>';
    if (e.params && e.params.length) {
      out += table(PAGE.paramHead, e.params.map((p) => [code(p.name), esc(t(PAGE.where[p.in])), esc(t(p.req ? PAGE.yes : PAGE.no)), ti(p.value)]),
        t(PAGE.params) + ' ' + e.method + ' ' + e.path);
    }
    if (e.notes) out += '<ul class="notes">' + e.notes.map((n) => '<li>' + ti(n) + '</li>').join('') + '</ul>';
    if (e.table) out += generated(e.table);
    for (const x of e.examples) out += example(x);
    return out + '</section>';
  }

  function generated(name) {
    const head = TABLE_HEAD[name];
    const title = t(head[0]);
    if (name === 'scopes') {
      return table(head, SCOPES.map((s) => [code(s), esc(label(SCOPE_INFO[s].label)), esc(label(SCOPE_INFO[s].desc)),
        ENDPOINTS.filter((e) => e.scopes && e.scopes.includes(s)).map(epLink).join('<br>')]), title);
    }
    if (name === 'groups') return table(head, API_GROUPS.map((g) => [code(g), esc(label(PUBLIC_GROUPS.find((x) => x.api === g).label))]), title);
    if (name === 'statuses') {
      return table(head, PARTNER_STATUSES.map((s) => [code(s), esc(t(KIND_TEXT[STATUS_TEXT[s].kind])), ti(STATUS_TEXT[s].text)]), title);
    }
    if (name === 'reasons') {
      return table(head, [...DECLINE_REASONS, ...CLOSED_REASONS].map((r) => [code(r), code(REASON_TEXT[r].status), ti(REASON_TEXT[r].text)]), title);
    }
    if (name === 'events') {
      return table(head, EVENTS.map((ev) => [code(ev), '<strong>' + esc(label(EVENT_INFO[ev].label)) + '</strong><br>' + esc(label(EVENT_INFO[ev].desc)),
        EVENT_TEXT[ev].statuses.map(code).join(', '), EVENT_TEXT[ev].fields.map(code).join(', ') || '—']), title);
    }
    if (name === 'errors') {
      return table(head, Object.keys(ERRORS).filter((c) => !CLINIC_ONLY_ERRORS.includes(c))
        .map((c) => [String(ERRORS[c].status), code(c), esc(ERRORS[c][lang]), ti(ERROR_TEXT[c])]), title);
    }
    if (name === 'fields') {
      return table(head, FIELD_ERRORS.map((f) => [code(f.field), f.reason ? code(f.reason) : code('404 ' + f.code),
        Object.keys(f.probes).map((id) => epLink(epOf(id))).join('<br>'), ti(f.text)]), title);
    }
    if (name === 'limits') return table(head, LIMIT_ROWS.map(([a, b]) => [ti(a), ti(b)]), title);
    throw new Error('docs: нет таблицы ' + name);
  }

  function webhook() {
    const raw = JSON.stringify(webhookBody(WEBHOOK_EXAMPLE));
    const lines = ['POST ' + WEBHOOK_EXAMPLE.url, 'Content-Type: application/json', 'User-Agent: ' + facts.userAgent,
      'X-EasyMed-Event: ' + WEBHOOK_EXAMPLE.event, 'X-EasyMed-Event-Id: ' + WEBHOOK_EXAMPLE.eventId,
      'X-EasyMed-Signature: ' + signBody(WEBHOOK_EXAMPLE.secret, raw), '', raw];
    return '<div class="ex"><p class="ex-h">' + esc(t(PAGE.hookRequest)) + '</p>' + pre(lines.join('\n')) + '<p class="note">' + ti(PAGE.vector) + '</p></div>';
  }

  function block(b) {
    if (b.p) return '<p>' + ti(b.p) + '</p>';
    if (b.list) return '<ul>' + b.list.map((x) => '<li>' + ti(x) + '</li>').join('') + '</ul>';
    if (b.kv) return '<dl class="kv">' + b.kv.map(([k, v]) => '<dt>' + ti(k) + '</dt><dd>' + ti(v) + '</dd>').join('') + '</dl>';
    if (b.code) return pre(t(b.code));
    if (b.table) return generated(b.table);
    if (b.endpoint) return endpoint(b.endpoint);
    if (b.example) return example(b.example, { response: b.response !== false });
    if (b.webhook) return webhook();
    if (b.verify) return '<p class="ex-h">' + (b.verify === 'node' ? 'Node.js' : 'PHP') + '</p>' + pre(b.verify === 'node' ? VERIFY_NODE : VERIFY_PHP);
    throw new Error('docs: неизвестный блок ' + Object.keys(b).join());
  }

  const langNav = DOCS_PAGE_LANGS.map((l) => '<li><a href="' + DOCS_PATH[l] + '" hreflang="' + l + '" lang="' + l + '"'
    + (l === lang ? ' aria-current="page"' : '') + '>' + esc(PAGE.langName[l]) + '</a></li>').join('');
  const alternates = DOCS_PAGE_LANGS.map((l) => '<link rel="alternate" hreflang="' + l + '" href="' + esc(base + DOCS_PATH[l]) + '">').join('');
  const toc = SECTIONS.map((s) => '<li><a href="#' + s.id + '">' + esc(t(s.title)) + '</a></li>').join('');
  const body = SECTIONS.map((s) => '<section id="' + s.id + '" aria-labelledby="' + s.id + '-h"><h2 id="' + s.id + '-h">' + esc(t(s.title)) + '</h2>'
    + s.blocks.map(block).join('') + '</section>').join('');
  return '<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">'
    + '<title>' + esc(t(PAGE.title)) + '</title><meta name="description" content="' + esc(t(PAGE.description)) + '">'
    + '<link rel="canonical" href="' + esc(base + DOCS_PATH[lang]) + '">' + alternates + '<style>' + CSS + '</style></head><body>'
    + '<a class="skip" href="#main">' + esc(t(PAGE.skip)) + '</a>'
    + '<header class="top"><span class="brand">Easy-Med API v1</span><nav class="langs" aria-label="' + esc(t(PAGE.langs)) + '"><ul>' + langNav + '</ul></nav></header>'
    + '<div class="wrap"><nav class="toc" aria-label="' + esc(t(PAGE.toc)) + '"><p class="toc-h">' + esc(t(PAGE.toc)) + '</p><ol>' + toc + '</ol></nav>'
    + '<main id="main"><h1>' + esc(t(PAGE.title)) + '</h1><p class="lead">' + ti(PAGE.lead) + '</p>' + body + '</main></div>'
    + '<footer><p>' + ti(PAGE.footer) + '</p></footer></body></html>\n';
}

// Шкала размеров программы (12.5 / 13.5 / 15 / 17 / 20 / 24 / 30); цвета — с
// контрастом не ниже 4.5:1 в светлой и тёмной теме.
const CSS = [
  ':root{--bg:#ffffff;--fg:#1b2230;--muted:#4f586a;--line:#d5dbe5;--soft:#f2f5f9;--accent:#0a58a8;--code-bg:#111821;--code-fg:#e8edf3;--get:#0a6a39;--post:#0a58a8;--delete:#a3242a}',
  '@media (prefers-color-scheme:dark){:root{--bg:#0e131a;--fg:#e5e9f0;--muted:#a9b2c1;--line:#2b3442;--soft:#171f2a;--accent:#7ab8ff;--code-bg:#080c11;--code-fg:#e8edf3;--get:#6ad596;--post:#7ab8ff;--delete:#ff9196}}',
  '*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}',
  'a{color:var(--accent)}a:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
  '.skip{position:absolute;left:-9999px;top:8px;background:var(--bg);color:var(--fg);padding:8px 12px;z-index:10}.skip:focus{left:8px}',
  'header.top{border-bottom:1px solid var(--line);padding:12px 16px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}',
  '.brand{font-weight:700;font-size:17px}.langs ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}',
  '.langs a{display:inline-block;padding:6px 12px;min-height:36px;border:1px solid var(--line);border-radius:8px;text-decoration:none}',
  '.langs a[aria-current]{background:var(--accent);border-color:var(--accent);color:var(--bg)}',
  '.wrap{max-width:1180px;margin:0 auto;padding:0 16px 40px;display:grid;gap:32px;grid-template-columns:minmax(0,1fr)}',
  '@media (min-width:960px){.wrap{grid-template-columns:220px minmax(0,1fr)}nav.toc{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto}}',
  '.toc-h{font-weight:700;margin:16px 0 4px}nav.toc ol{padding-left:20px;margin:0}nav.toc li{margin:4px 0}main{min-width:0}',
  'h1{font-size:30px;line-height:1.25;margin:24px 0 8px}h2{font-size:24px;line-height:1.3;margin:40px 0 12px;padding-top:16px;border-top:1px solid var(--line)}',
  'h3{font-size:17px;margin:4px 0 8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}.lead{font-size:17px;color:var(--muted)}',
  'code{font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--soft);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}',
  'pre{background:var(--code-bg);color:var(--code-fg);padding:12px 14px;border-radius:8px;overflow:auto;margin:6px 0 16px;max-height:560px}',
  'pre code{background:none;padding:0;color:inherit;white-space:pre;overflow-wrap:normal}',
  '.m{font:700 12.5px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:5px 8px;border-radius:6px;border:1px solid currentColor}',
  '.m-get{color:var(--get)}.m-post{color:var(--post)}.m-delete{color:var(--delete)}',
  '.ep{border:1px solid var(--line);border-radius:10px;padding:16px;margin:20px 0}.meta,.note{color:var(--muted);font-size:13.5px}.meta{margin:0 0 8px}',
  '.ex-h{font-size:13.5px;font-weight:600;color:var(--muted);margin:16px 0 0}',
  '.tw{overflow-x:auto;margin:8px 0 16px;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;font-size:13.5px}',
  'th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{background:var(--soft);font-weight:600}tbody tr:last-child td{border-bottom:0}td code{overflow-wrap:normal}',
  // Телефон (уже 600 px, только экран): строка таблицы — блоком, над значением — подпись
  // столбца; заголовки скрыты только глазу. Широкий экран и печать — обычная таблица.
  '@media screen and (max-width:599.98px){.tw{position:relative}.tw table,.tw thead,.tw tbody,.tw tr,.tw th,.tw td{display:block}',
  '.tw thead{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}',
  '.tw tr{padding:6px 0;border-bottom:1px solid var(--line)}.tw tbody tr:last-child{border-bottom:0}',
  '.tw td{border-bottom:0;padding:3px 12px}.tw td::before{content:attr(data-label);display:block;font-size:12.5px;font-weight:600;color:var(--muted)}}',
  'dl.kv{display:grid;grid-template-columns:minmax(0,1fr);gap:2px 16px}@media (min-width:640px){dl.kv{grid-template-columns:150px minmax(0,1fr)}}',
  'dl.kv dt{font-weight:600}dl.kv dd{margin:0 0 10px}',
  'footer{border-top:1px solid var(--line);padding:16px;color:var(--muted);font-size:13.5px;max-width:1180px;margin:0 auto}',
  '@media print{.langs,nav.toc,.skip{display:none}.wrap{display:block}body{font-size:12.5px;background:#fff;color:#000}',
  'pre{white-space:pre-wrap;max-height:none;border:1px solid #888;background:#fff;color:#000}pre code{white-space:pre-wrap;word-break:break-all}',
  'h2,h3{break-after:avoid}.ep,pre,table{break-inside:avoid}a[href^="http"]::after{content:" (" attr(href) ")"}}',
].join('');
