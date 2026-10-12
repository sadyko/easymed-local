// API_DOCS_V1 — ПРИМЕРЫ ДОКУМЕНТАЦИИ НА НАСТОЯЩЕМ СЕРВЕРЕ. Запросы примеров
// (docs/content.js EXAMPLES) уходят настоящим адресам партнёров стенда с миром
// клиники «Шифо» (docs-world.js) — так же, как их отправит curl со страницы.
// Ответы записывает `node public-server/scripts/docs-build.mjs` в
// server/docs/generated.js; страж docs/examples.http.test.js спрашивает заново
// и сверяет файл с тем, что сервер отвечает сейчас.
//
// Номера заявок сервер выдаёт случайно — в записанное они попадают номерами
// страницы (SAMPLE.ids), чтобы файл не менялся от прогона к прогону.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { partnerStand } from './partner-stand.js';
import { docsSnapshot, docsSlots, DOCS_ORIGIN } from './docs-world.js';
import { NOW } from './fixture.js';
import { EXAMPLES, SAMPLE } from '../docs/content.js';
import { ackInbox, applyEvents } from '../store/requests.js';
import { isoOf } from '../lib/time.js';
import { webhookBody } from '../../../public/js/shared/api-booking.js';
import { SCOPE_INFO, EVENT_INFO, API_DOCS_LANGS } from '../../../public/js/shared/api-connections.js';
import { PUBLIC_GROUPS } from '../../../public/js/shared/service-public.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';

export const GENERATED_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'generated.js');
export const WRONG_KEY = 'em_live_wrong';

/** Стенд партнёров с миром примеров: адрес сервера — как на странице, сайт подключения — partner.example. */
export const docsStand = (over = {}) => partnerStand({ snapshot: docsSnapshot(), slots: docsSlots(), baseUrl: SAMPLE.base,
  connection: { origins: [DOCS_ORIGIN] }, ...over });
/** Лимиты не мешают пробам: их проверяют тесты 8b (partner-read / partner-write). */
export const NO_LIMITS = Object.freeze({ hit: () => ({ ok: true, remaining: 1 }) });

const isTri = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).join() === 'ru,uz,en';
/** Значение примера на языке lang: {lang} и {имя} номера заявки в строках, L(…) — строка языка. */
export function resolve(v, lang, ids) {
  if (typeof v === 'string') return v.replace(/\{([a-z]+)\}/g, (m, k) => (k === 'lang' ? lang : ids[k] || m));
  if (Array.isArray(v)) return v.map((x) => resolve(x, lang, ids));
  if (isTri(v)) return v[lang];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, lang, ids)]));
  return v;
}

/** Длинные списки — первыми n строками: { countries: 2, 'cities.districts': 2 }. */
export function trimmed(value, spec = {}) {
  const cut = (v, keys, n) => {
    if (!v || typeof v !== 'object') return v;
    const [k, ...rest] = keys;
    if (!Array.isArray(v[k])) return v;
    return { ...v, [k]: rest.length ? v[k].map((x) => cut(x, rest, n)) : v[k].slice(0, n) };
  };
  return Object.entries(spec).reduce((v, [p, n]) => cut(v, p.split('.'), n), value);
}

const swapIds = (v, map) => {
  if (typeof v === 'string') return map.has(v) ? map.get(v) : v;
  if (Array.isArray(v)) return v.map((x) => swapIds(x, map));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swapIds(x, map)]));
  return v;
};

// Что клиника делает между примерами (её шаги обмена с сервером, 8a) и сколько
// проходит времени: страница показывает утро одного понедельника.
const MIN = 60000;
export const CLINIC_STEPS = Object.freeze({
  // 09:01 — клиника забрала очередь и держит время онлайн-записи 30 минут.
  'request-held': (s, ids) => {
    s.setClock(NOW + MIN);
    const c = s.db.prepare('SELECT MAX(cursor) AS c FROM inbox WHERE clinic_id = ?').get(s.clinicId).c;
    ackInbox(s.db, s.clinicId, String(c), [{ request_id: ids.appointment, hold_until: isoOf(NOW + 31 * MIN) }], NOW + MIN);
  },
  // 09:05 — регистратор предложил 10:00 вместо 09:45; ответ ждут 30 минут.
  'request-offered': (s, ids) => {
    s.setClock(NOW + 5 * MIN);
    const body = webhookBody({ eventId: 'ev_0a1b2c3d4e5f60718293a4b5', event: 'booking.offered_other_time', publicId: ids.appointment, externalId: 'bk-2002',
      status: 'offered', occurredAt: isoOf(NOW + 5 * MIN), details: { doctor_id: 7, offered_start: '2030-03-12T10:00:00+05:00', offer_until: '2030-03-11T09:35:00+05:00' } });
    applyEvents(s.db, s.clinicId, [{ seq: 1, event: body.event, status: 'offered', body: JSON.stringify(body), webhook_url: '', signature: '' }], NOW + 5 * MIN);
  },
  'offer-accept': (s) => s.setClock(NOW + 7 * MIN),   // 09:07 — пациент согласился
  'appointment-cancel': (s) => s.setClock(NOW + 10 * MIN),   // 09:10 — пациент передумал
});

/** Запрос примера: метод, путь от /<клиника>/v1, тело, ключ. */
export function exampleRequest(ex, lang, ids) {
  return { method: ex.method, path: resolve(ex.path, lang, ids), body: ex.body === undefined ? undefined : resolve(ex.body, lang, ids),
    wrongKey: ex.key === 'wrong' };
}

/** Отправить запрос примера на стенд → { status, body }. */
export async function sendExample(s, req) {
  const headers = { Authorization: 'Bearer ' + (req.wrongKey ? WRONG_KEY : s.key) };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(s.base + '/' + SAMPLE.slug + '/v1' + req.path, { method: req.method, headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body) });
  return { status: res.status, body: await res.json() };
}

/** Все примеры на языке lang, по порядку, на свежем стенде → { id: {status, body} } с номерами страницы. */
export async function runExamples(lang) {
  const s = await docsStand();
  try {
    const ids = {};
    const real = new Map();
    const out = {};
    for (const ex of EXAMPLES) {
      if (CLINIC_STEPS[ex.id]) CLINIC_STEPS[ex.id](s, ids);
      const r = await sendExample(s, exampleRequest(ex, lang, ids));
      if (ex.saveAs && r.body.request_id) {
        ids[ex.saveAs] = r.body.request_id;
        real.set(r.body.request_id, SAMPLE.ids[ex.saveAs]);
      }
      out[ex.id] = { status: r.status, body: trimmed(r.body, ex.trim) };
    }
    return swapIds(out, real);
  } finally { await s.close(); }
}

/** Переводы подписей словарей программы, которые показывает страница: русская подпись → {uz, en}. */
export function docLabels() {
  const ru = [...Object.values(SCOPE_INFO).flatMap((v) => [v.label, v.desc]), ...Object.values(EVENT_INFO).flatMap((v) => [v.label, v.desc]),
    ...PUBLIC_GROUPS.map((g) => g.label)];
  return Object.fromEntries(ru.map((k) => {
    const e = STRINGS[k];
    if (!e || !e.uz || !e.en) throw new Error('нет перевода в i18n-strings.js: ' + k);
    return [k, { uz: e.uz, en: e.en }];
  }));
}

/** Текст server/docs/generated.js. */
export async function buildGenerated() {
  const responses = {};
  for (const lang of API_DOCS_LANGS) responses[lang] = await runExamples(lang);
  return [
    '// API_DOCS_V1 — СОЗДАН `node public-server/scripts/docs-build.mjs`; руками не править.',
    '//',
    '// RESPONSES — что публичный сервер ответил на запросы примеров документации',
    '// (docs/content.js EXAMPLES) для клиники-примера «Шифо» (test-helpers/docs-world.js);',
    '// LABELS — переводы подписей прав, событий и групп услуг из словаря программы',
    '// (public/js/admin/i18n-strings.js): страница говорит теми же словами, что экран',
    '// клиники. Страж docs/examples.http.test.js пересобирает файл и сверяет.',
    'export const LABELS = ' + JSON.stringify(docLabels(), null, 2) + ';',
    '',
    'export const RESPONSES = ' + JSON.stringify(responses, null, 2) + ';',
    '',
  ].join('\n');
}
