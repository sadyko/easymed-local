// API_DOCS_V1 — СТРАЖ «ДОКУМЕНТАЦИЯ НЕ РАСХОДИТСЯ С КОДОМ». Страница /docs
// строится из docs/content.js и словарей кода; здесь — то, что связывает их:
//   • каждый адрес, который сервер партнёров регистрирует, описан, и ничего лишнего;
//   • права, статусы, причины, события, коды ошибок — те же списки, что в коде;
//   • каждая причина поля, которую может вернуть код, — в таблице полей;
//   • события клиники (каждый вызов enqueueEvent / emit в server/services) несут
//     те статусы и поля, что написаны в таблице событий;
//   • переходы статусов на странице — каждый, который делает код: клиника, ответы
//     партнёра, закрытие сервером (ревью шага 9, п. 1);
//   • числа без постоянной в коде (ритм и пределы клиники) — те, что у программы
//     клиники; цифр руками в тексте нет — только {{число}} из docs/facts.js;
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
import { WINDOW_MS } from '../lib/rate-limit.js';
import { PARTNER_STATUSES } from '../store/requests.js';
import { SCOPES, EVENTS, API_DOCS_PATH } from '../../../public/js/shared/api-connections.js';
import { DECLINE_REASONS, PARTNER_STATUS, WEBHOOK_DETAIL_KEYS, EV, webhookBody, KINDS, STATUSES, bookingActions } from '../../../public/js/shared/api-booking.js';
import { signBody } from '../../../server/services/api/outbox.js';
import { POLL_MS, SLOTS_EVERY_MS } from '../../../server/services/api/public-sync.js';
import { RECHECK_CALLBACK_DAYS } from '../../../server/services/api/visit-events.js';
import * as C from './content.js';
import { CLINIC_RHYTHM, CLINIC_LIMITS } from './facts.js';

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

// Вызовы событий клиники: enqueueEvent(db, { event: EV.x, status: 'y', details: {…} })
// и обёртка visit-events.js emit(row, EV.x, 'y'[, {…}]) — во ВСЕХ рабочих файлах
// server/services. Определения (enqueueEvent в outbox.js, const emit = …) — не вызовы.
// Ревью шага 9, п. 3: короткий emit без полей разбирается, и каждый вызов обязан
// разобраться — иначе новый вызов (другой формы или в другом файле) прошёл бы мимо.
const keysOf = (d) => (d ? d.split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean) : []);
function clinicEventCalls() {
  const files = fs.readdirSync(path.join(REPO, 'server/services'), { recursive: true })
    .map((f) => 'server/services/' + String(f).replace(/\\/g, '/')).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).sort();
  const found = [];
  let calls = 0;
  for (const f of files) {
    const s = src(f).split('\n').filter((l) => !/export function enqueueEvent\(|const emit = \(/.test(l)).join('\n');
    calls += [...s.matchAll(/\benqueueEvent\(|(?<![.\w])emit\(/g)].length;
    for (const m of s.matchAll(/event: EV\.(\w+), status(?:: '(\w+)')?,\s*(?:details: \{([^}]*)\})?/g)) found.push({ file: f, ev: EV[m[1]], status: m[2], keys: keysOf(m[3]) });
    for (const m of s.matchAll(/EV\.(\w+), '(\w+)'(?:, \{([^}]*)\})?\)/g)) found.push({ file: f, ev: EV[m[1]], status: m[2], keys: keysOf(m[3]) });
  }
  return { found, calls };
}

test('события: словарь шага 7; статусы и поля — как их шлёт клиника (каждый вызов enqueueEvent / emit в server/services)', () => {
  assert.deepEqual(Object.keys(C.EVENT_TEXT), [...EVENTS]);
  for (const [ev, v] of Object.entries(C.EVENT_TEXT)) {
    for (const s of v.statuses) assert.ok(PARTNER_STATUSES.includes(s), ev + ': ' + s);
    for (const f of v.fields) assert.ok(WEBHOOK_DETAIL_KEYS.includes(f), ev + ': ' + f);
  }
  const { found, calls } = clinicEventCalls();
  assert.ok(calls >= 14, 'вызовов событий не найдено: ' + calls);
  assert.equal(found.length, calls, 'каждый вызов enqueueEvent / emit разобран (иначе новый вызов прошёл бы мимо стража): ' + found.length + ' из ' + calls);
  for (const { file, ev, status, keys } of found) {
    const doc = C.EVENT_TEXT[ev];
    assert.ok(doc, file + ': событие без строки: ' + ev);
    if (status) assert.ok(doc.statuses.includes(PARTNER_STATUS[status]), file + ': ' + ev + ' шлёт ' + PARTNER_STATUS[status]);
    for (const k of keys) assert.ok(doc.fields.includes(k), file + ': ' + ev + ' шлёт поле ' + k);
  }
  assert.match(src('server/services/api/outbox.js'), /occurredAt: isoOf\(now\)/, 'occurred_at — в UTC, как написано');
  assert.match(C.WEBHOOK_EXAMPLE.occurredAt, /Z$/);
});

// Ревью шага 9, п. 1: переходы статусов на странице (content.js FLOWS) — каждый,
// который делает код. Откуда что берётся:
//   • действия клиники — bookingActions программы (из каких её статусов можно
//     подтвердить, предложить другое время, отказать, взять в работу);
//   • фон клиники — истечение (bookings.js expireDue), запись по карточке
//     «перезвоните» и судьба визита (visit-events.js);
//   • ответы партнёра — store/requests.js partnerCancel, partnerAnswerOffer;
//   • закрытие сервером — store/requests.js closeOverdue.
test('переходы статусов: на странице — каждый, который делает код (клиника, ответы партнёра, закрытие сервером)', () => {
  const doc = new Set();
  for (const f of C.FLOWS) {
    assert.ok(KINDS.includes(f.kind), f.kind);
    for (const s of f.steps) {
      assert.ok(PARTNER_STATUSES.includes(s.from), s.from);
      for (const [to] of s.to) { assert.ok(PARTNER_STATUSES.includes(to), to); doc.add(f.kind + ': ' + s.from + ' → ' + to); }
    }
  }
  const need = new Set();
  const kindsOf = (st) => (C.STATUS_TEXT[st].kind === 'both' ? [...KINDS] : [C.STATUS_TEXT[st].kind]);
  const add = (kinds, from, to) => { for (const k of kinds) need.add(k + ': ' + from + ' → ' + to); };
  const lits = (s) => [...s.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  // действия клиники: каждое действие bookingActions — и во что оно переводит
  const ACTION_STATUS = { confirm: 'confirmed', offer: 'offered', decline: 'declined', accept: 'accepted' };
  const future = new Date(Date.UTC(2100, 0, 1)).toISOString();
  assert.deepEqual(Object.keys(bookingActions({}, 0)).sort(), Object.keys(ACTION_STATUS).sort(), 'новое действие клиники — допишите его статус');
  for (const kind of KINDS) {
    for (const st of STATUSES) {
      const can = bookingActions({ kind, status: st, hold_until: future, offer_until: future }, 0);
      for (const [action, ok] of Object.entries(can)) if (ok) add([kind], PARTNER_STATUS[st], PARTNER_STATUS[ACTION_STATUS[action]]);
    }
  }
  // фон клиники: истечение
  const expire = /export function expireDue[\s\S]*?status IN \(([^)]*)\)/.exec(src('server/services/api/bookings.js'));
  for (const st of lits(expire[1])) add(kindsOf(PARTNER_STATUS[st]), PARTNER_STATUS[st], 'expired');
  // фон клиники: «перезвоните» записали на визит; записанный визит перенесли, отменили, пациент пришёл
  const visits = src('server/services/api/visit-events.js');
  const callbacks = /kind = 'request' AND status IN \(([^)]*)\)/.exec(visits);
  for (const st of lits(callbacks[1])) add(['request'], PARTNER_STATUS[st], 'booked');
  const bound = /WHERE r\.status = '(\w+)'/.exec(visits);
  const outcomes = [...new Set([...visits.matchAll(/EV\.\w+, '(\w+)'/g)].map((m) => PARTNER_STATUS[m[1]]))];
  for (const to of outcomes) add(kindsOf(PARTNER_STATUS[bound[1]]), PARTNER_STATUS[bound[1]], to);
  // ответы партнёра
  const store = src('public-server/server/store/requests.js');
  const cancel = /export function partnerCancel[\s\S]*?\[([^\]]*)\]\.includes\(row\.status\)/.exec(store);
  for (const st of lits(cancel[1]).filter((x) => x !== 'booked')) add(['appointment'], st, 'cancelled');   // записанная остаётся booked с cancel_requested
  const answer = /export function partnerAnswerOffer[\s\S]*?row\.status !== '(\w+)'/.exec(store);
  add(['appointment'], answer[1], 'pending');
  add(['appointment'], answer[1], 'cancelled');
  // закрытие сервером
  for (const m of store.matchAll(/SET status = 'closed', reason = '(\w+)'[\s\S]*?WHERE([^`]*)`/g)) {
    const from = [...m[2].matchAll(/status = '(\w+)'|status IN \(([^)]*)\)/g)].flatMap((x) => (x[1] ? [x[1]] : lits(x[2])));
    assert.ok(from.length, 'closeOverdue ' + m[1]);
    for (const st of from) add(kindsOf(st), st, 'closed');
  }
  assert.ok(need.size >= 20, 'разбор переходов сломался: ' + need.size);
  for (const t of need) assert.ok(doc.has(t), 'переход не описан на странице: ' + t);
  // каждый статус, который несут события, на странице куда-то ведёт
  for (const [ev, v] of Object.entries(C.EVENT_TEXT)) for (const st of v.statuses) assert.ok([...doc].some((t) => t.endsWith('→ ' + st)), ev + ': ' + st);
  assert.ok(![...doc].some((t) => t.includes('no_show')), '«не пришёл» партнёрам не уходит — в переходах его нет');
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
  // top — то же поле, присланное на верхнем уровне (POST /requests): ошибка — без «patient.» (ревью шага 9, п. 4).
  const documented = new Set(C.FIELD_ERRORS.flatMap((f) => [f.field, ...(f.top ? [f.top] : [])].map((x) => x + '/' + (f.reason || f.code))));
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
    // patientOf(…, prefix): prefix — «patient.» (поля объектом patient) или «» (на верхнем уровне) — обе пары
    if (/^prefix \+ '/.test(args)) for (const r of lits.slice(1)) pairs.push('patient.' + lits[0] + '/' + r, lits[0] + '/' + r);
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

test('ритм и пределы клиники в тексте — те, что у программы клиники; окно лимитов — минута, как пишет таблица лимитов', () => {
  assert.equal(CLINIC_RHYTHM.pollSec * 1000, POLL_MS);
  assert.equal(CLINIC_RHYTHM.slotsEverySec * 1000, SLOTS_EVERY_MS);
  assert.equal(CLINIC_LIMITS.callbackBookDays, RECHECK_CALLBACK_DAYS, 'visit-events.js: «перезвоните» ищет запись по карточке столько дней');
  const cap = /specialties: \[[^\n]*\.slice\(0, (\d+)\)/.exec(src('server/services/api/snapshot.js'));
  assert.ok(cap, 'snapshot.js: предел специальностей врача');
  assert.equal(CLINIC_LIMITS.specialtiesMax, Number(cap[1]), 'snapshot.js отдаёт партнёрам столько специальностей');
  assert.equal(WINDOW_MS, 60000, 'таблица лимитов говорит «в минуту» — окно лимитера (lib/rate-limit.js) должно быть минутой');
});

// Р2 плана: руками на странице чисел нет. В тексте content.js цифры — только
// {{число}} из docs/facts.js, в `коде` (примеры значений) и в названиях.
test('цифр руками в тексте нет: только {{число}} из docs/facts.js, `код` и названия (UTF-8, HMAC-SHA256)', () => {
  const bad = [];
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, where + '[' + i + ']'));
    if (!v || typeof v !== 'object') return;
    if (Object.keys(v).join() === 'ru,uz,en') {
      for (const l of ['ru', 'uz', 'en']) {
        const rest = v[l].replace(/`[^`]*`/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/UTF-8|HMAC-SHA256/g, '');
        if (/\d/.test(rest)) bad.push(where + ' ' + l + ': ' + v[l]);
      }
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, where + '.' + k);
  };
  // Запросы примеров (EXAMPLES, WEBHOOK_EXAMPLE) — данные, не текст страницы.
  for (const [k, v] of Object.entries(C)) if (!['EXAMPLES', 'WEBHOOK_EXAMPLE', 'SAMPLE'].includes(k)) walk(v, k);
  assert.deepEqual(bad, []);
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
