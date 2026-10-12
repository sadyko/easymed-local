// API_DOCS_V1 — СТРАЖ «ДОКУМЕНТАЦИЯ НЕ РАСХОДИТСЯ С КОДОМ». Страница /docs
// строится из docs/content.js и словарей кода; здесь — то, что связывает их:
//   • каждый адрес, который сервер партнёров регистрирует, описан, и ничего лишнего;
//   • права, статусы, причины, события, коды ошибок — те же списки, что в коде;
//   • каждая причина поля, которую может вернуть код, — в таблице полей;
//   • события клиники (services/api/bookings.js, visit-events.js) несут те статусы
//     и поля, что написаны в таблице событий;
//   • числа без постоянной в коде (ритм клиники) — те, что у программы клиники;
//   • пример проверки подписи считает ту же подпись, что ставит клиника;
//   • узбекский и английский — без кириллицы, узбекский апостроф — «‘».
// Что сервер на самом деле отвечает на примеры и пробы — docs/examples.http.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { partnerRouter } from '../routes/partner.js';
import { ERRORS } from '../lib/errors.js';
import { PARTNER_STATUSES } from '../store/requests.js';
import { SCOPES, EVENTS, API_DOCS_PATH } from '../../../public/js/shared/api-connections.js';
import { DECLINE_REASONS, PARTNER_STATUS, WEBHOOK_DETAIL_KEYS, EV, webhookBody } from '../../../public/js/shared/api-booking.js';
import { signBody } from '../../../server/services/api/outbox.js';
import { POLL_MS, SLOTS_EVERY_MS } from '../../../server/services/api/public-sync.js';
import * as C from './content.js';
import { CLINIC_RHYTHM } from './facts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const REPO = path.resolve(SERVER, '..', '..');
const src = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const literals = (s) => [...s.matchAll(/'([A-Za-z_.]+)'/g)].map((m) => m[1]);

test('адреса: каждый маршрут сервера партнёров описан ровно один раз, описанное — есть у сервера', () => {
  const r = partnerRouter({ db: null, dataDir: '', now: () => 0, offsetMin: 300, baseUrl: 'https://api.easymed.uz' });
  const served = r.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => m.toUpperCase() + ' ' + l.route.path)).sort();
  const documented = C.ENDPOINTS.map((e) => e.method + ' ' + e.path.replace(/\{(\w+)\}/g, ':$1')).sort();
  assert.deepEqual(documented, served);
  const placed = C.SECTIONS.flatMap((s) => s.blocks.filter((b) => b.endpoint).map((b) => b.endpoint)).sort();
  assert.deepEqual(placed, C.ENDPOINTS.map((e) => e.id).sort(), 'каждый адрес — в одном разделе страницы');
  assert.equal(API_DOCS_PATH, '/docs', 'ссылка программы клиники ведёт на адрес страницы (routes/docs.js)');
});

test('примеры: каждый показан на странице, каждый показанный — есть', () => {
  const used = [...C.ENDPOINTS.flatMap((e) => e.examples), ...C.SECTIONS.flatMap((s) => s.blocks.filter((b) => b.example).map((b) => b.example))];
  const ids = C.EXAMPLES.map((x) => x.id);
  assert.deepEqual([...new Set(used)].sort(), [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
});

test('права: у каждого права есть адрес, у каждого адреса — права из словаря шага 7', () => {
  for (const e of C.ENDPOINTS) if (e.scopes) for (const s of e.scopes) assert.ok(SCOPES.includes(s), e.id + ': ' + s);
  for (const s of SCOPES) assert.ok(C.ENDPOINTS.some((e) => e.scopes && e.scopes.includes(s)), 'право без адреса: ' + s);
});

test('статусы и причины: те же, что у сервера; причины closed ставит только сервер', () => {
  assert.deepEqual(Object.keys(C.STATUS_TEXT), [...PARTNER_STATUSES]);
  for (const s of Object.values(PARTNER_STATUS)) assert.ok(PARTNER_STATUSES.includes(s), 'статус клиники без строки: ' + s);
  assert.deepEqual(Object.keys(C.REASON_TEXT), [...DECLINE_REASONS, ...C.CLOSED_REASONS]);
  const set = [...new Set([...src('public-server/server/store/requests.js').matchAll(/reason = '(\w+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(set, [...C.CLOSED_REASONS].sort());
  for (const [r, v] of Object.entries(C.REASON_TEXT)) assert.ok(PARTNER_STATUSES.includes(v.status), r);
});

test('события: словарь шага 7; статусы и поля — как их шлёт клиника (bookings.js, visit-events.js)', () => {
  assert.deepEqual(Object.keys(C.EVENT_TEXT), [...EVENTS]);
  for (const [ev, v] of Object.entries(C.EVENT_TEXT)) {
    for (const s of v.statuses) assert.ok(PARTNER_STATUSES.includes(s), ev + ': ' + s);
    for (const f of v.fields) assert.ok(WEBHOOK_DETAIL_KEYS.includes(f), ev + ': ' + f);
  }
  const keysOf = (d) => (d ? d.split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean) : []);
  const found = [];
  const bookings = src('server/services/api/bookings.js');
  for (const m of bookings.matchAll(/event: EV\.(\w+), status(?:: '(\w+)')?,\s*(?:details: \{([^}]*)\})?/g)) found.push([EV[m[1]], m[2], keysOf(m[3])]);
  for (const m of src('server/services/api/visit-events.js').matchAll(/EV\.(\w+), '(\w+)', \{([^}]*)\}/g)) found.push([EV[m[1]], m[2], keysOf(m[3])]);
  assert.ok(found.length >= 14, 'разбор вызовов enqueueEvent/emit сломался: ' + found.length);
  for (const [ev, status, keys] of found) {
    const doc = C.EVENT_TEXT[ev];
    assert.ok(doc, 'событие без строки: ' + ev);
    if (status) assert.ok(doc.statuses.includes(PARTNER_STATUS[status]), ev + ' шлёт ' + PARTNER_STATUS[status]);
    for (const k of keys) assert.ok(doc.fields.includes(k), ev + ' шлёт поле ' + k);
  }
  assert.match(src('server/services/api/outbox.js'), /occurredAt: isoOf\(now\)/, 'occurred_at — в UTC, как написано');
  assert.match(C.WEBHOOK_EXAMPLE.occurredAt, /Z$/);
});

test('коды ошибок: каждый код lib/errors.js — либо в таблице партнёра, либо только у канала клиники; код партнёрских адресов — в таблице', () => {
  const partner = Object.keys(C.ERROR_TEXT);
  assert.deepEqual([...partner, ...C.CLINIC_ONLY_ERRORS].sort(), Object.keys(ERRORS).sort());
  assert.equal(new Set([...partner, ...C.CLINIC_ONLY_ERRORS]).size, Object.keys(ERRORS).length, 'код и там и там');
  const files = ['routes/partner.js', 'routes/partner-auth.js', 'routes/partner-read.js', 'routes/partner-write.js', 'lib/errors.js', 'app.js', 'store/requests.js'];
  for (const f of files) {
    const s = src('public-server/server/' + f);
    const codes = [...s.matchAll(/sendError\([^,]+, [^,]+, '(\w+)'/g), ...s.matchAll(/FieldError\('(\w+)'/g), ...s.matchAll(/error: '(\w+)'/g)].map((m) => m[1]);
    for (const c of codes) assert.ok(partner.includes(c), f + ': код ' + c + ' не описан для партнёров');
  }
});

test('причины полей: каждую, которую может вернуть код чтения и записи, описывает таблица полей', () => {
  const documented = new Set(C.FIELD_ERRORS.map((f) => f.field + '/' + (f.reason || f.code)));
  const docReasons = new Set(C.FIELD_ERRORS.map((f) => f.reason).filter(Boolean));
  const pairs = [];
  const read = src('public-server/server/routes/partner-read.js');
  for (const m of read.matchAll(/\bbad\(req, res, ([^)]*)\)/g)) {
    const [field, ...reasons] = literals(m[1]);
    for (const r of reasons) pairs.push(field + '/' + r);
  }
  for (const m of read.matchAll(/'not_found', \{ field: '(\w+)' \}/g)) pairs.push(m[1] + '/not_found');
  const write = src('public-server/server/routes/partner-write.js');
  const wild = [];
  for (const m of write.matchAll(/\bfield\(([^)]*)\)/g)) {
    const args = m[1].trim();
    const lits = literals(args);
    if (/^prefix \+ '/.test(args)) for (const r of lits.slice(1)) pairs.push('patient.' + lits[0] + '/' + r);
    else if (/^'/.test(args)) for (const r of lits.slice(1)) pairs.push(lits[0] + '/' + r);
    else wild.push(...lits);   // pick(name): field(name, 'format')
  }
  for (const m of write.matchAll(/pick\('(\w+)', (null|[^)]*)\)/g)) {
    pairs.push(m[1] + '/format');
    if (m[2] !== 'null') pairs.push(m[1] + '/not_found');
  }
  assert.ok(pairs.length >= 30, 'разбор кода полей сломался: ' + pairs.length);
  for (const p of pairs) assert.ok(documented.has(p), 'причина поля не описана: ' + p);
  for (const r of wild) assert.ok(docReasons.has(r), 'причина не описана: ' + r);
  for (const f of C.FIELD_ERRORS) {
    assert.ok(f.reason || f.code === 'not_found', f.field);
    for (const ep of Object.keys(f.probes)) assert.ok(C.ENDPOINTS.some((e) => e.id === ep), f.field + ': ' + ep);
  }
});

test('ритм клиники в тексте — тот, что у программы клиники (public-sync.js)', () => {
  assert.equal(CLINIC_RHYTHM.pollSec * 1000, POLL_MS);
  assert.equal(CLINIC_RHYTHM.slotsEveryMin * 60000, SLOTS_EVERY_MS, 'текст говорит «раз в минуту»');
  assert.equal(SLOTS_EVERY_MS, 60000);
});

test('уведомление: тело — webhookBody программы, заголовки — те, что шлёт доставка; пример проверки подписи принимает подпись клиники', () => {
  const raw = JSON.stringify(webhookBody(C.WEBHOOK_EXAMPLE));
  const body = JSON.parse(raw);
  assert.ok(EVENTS.includes(body.event) && C.EVENT_TEXT[body.event].statuses.includes(body.status));
  for (const k of Object.keys(C.WEBHOOK_EXAMPLE.details)) assert.ok(C.EVENT_TEXT[body.event].fields.includes(k), k);
  const sent = src('public-server/server/store/deliveries.js');
  for (const h of ["'Content-Type': 'application/json'", "'X-EasyMed-Signature'", "'X-EasyMed-Event'", "'X-EasyMed-Event-Id'"]) assert.ok(sent.includes(h), h);
  const signatureOk = new Function('require', C.VERIFY_NODE + '\nreturn signatureOk;')((m) => (m === 'node:crypto' ? crypto : null));
  const sig = signBody(C.WEBHOOK_EXAMPLE.secret, raw);
  assert.equal(signatureOk(Buffer.from(raw), sig, C.WEBHOOK_EXAMPLE.secret), true);
  assert.equal(signatureOk(Buffer.from(raw + ' '), sig, C.WEBHOOK_EXAMPLE.secret), false);
  assert.equal(signatureOk(Buffer.from(raw), undefined, C.WEBHOOK_EXAMPLE.secret), false);
  for (const s of ["hash_hmac('sha256', $raw, $secret)", 'hash_equals(', 'HTTP_X_EASYMED_SIGNATURE', "'sha256='"]) assert.ok(C.VERIFY_PHP.includes(s), s);
});

test('тексты: у каждого ru / uz / en; узбекский и английский — без кириллицы; узбекский апостроф — «‘»', () => {
  const bad = [];
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, where + '[' + i + ']'));
    if (!v || typeof v !== 'object') return;
    if (Object.keys(v).join() === 'ru,uz,en') {
      if (!v.ru || !v.uz || !v.en) bad.push(where + ': пусто');
      for (const l of ['uz', 'en']) if (/[Ѐ-ӿ]/.test(v[l])) bad.push(where + ' ' + l + ': ' + v[l]);
      if (/[oOgG]['ʻ]/.test(v.uz)) bad.push(where + ' uz апостроф: ' + v.uz);
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, where + '.' + k);
  };
  for (const [k, v] of Object.entries(C)) walk(v, k);
  assert.deepEqual(bad, []);
});
