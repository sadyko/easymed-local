// API_DOCS_V1 — СТРАЖ «ПРИМЕРЫ СТРАНИЦЫ РАБОТАЮТ». Настоящий сервер партнёров
// в процессе (стенд, случайный порт 127.0.0.1, мир клиники «Шифо»):
//   • docs/generated.js — то, что сервер отвечает сейчас (иначе: пересобрать
//     `node public-server/scripts/docs-build.mjs`), подписи — из словаря программы;
//   • каждая строка таблицы полей воспроизводится своим запросом, границы полей
//     пациента — те, что написаны;
//   • права: без права адреса — 403 с этим правом, с любым из названных — не 403;
//     справочники — любому ключу, файлы — без ключа;
//   • коды тела, CORS и Max-Age — как написано.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildGenerated, GENERATED_FILE, docsStand, exampleRequest, sendExample, resolve, WRONG_KEY, NO_LIMITS } from '../test-helpers/docs-run.js';
import { DOCS_ORIGIN } from '../test-helpers/docs-world.js';
import { EXAMPLES, ENDPOINTS, FIELD_ERRORS } from './content.js';
import { LABELS } from './generated.js';
import { PATIENT_RULES, CORS_MAX_AGE_SEC, docFacts } from './facts.js';
import { SCOPES, SCOPE_INFO, EVENT_INFO } from '../../../public/js/shared/api-connections.js';
import { PUBLIC_GROUPS } from '../../../public/js/shared/service-public.js';

test('docs/generated.js — ответы сервера сейчас (иначе: node public-server/scripts/docs-build.mjs)', async () => {
  assert.equal(await buildGenerated(), fs.readFileSync(GENERATED_FILE, 'utf8'),
    'ответы партнёрам или примеры изменились — пересоберите: node public-server/scripts/docs-build.mjs');
  const labels = [...Object.values(SCOPE_INFO).flatMap((v) => [v.label, v.desc]), ...Object.values(EVENT_INFO).flatMap((v) => [v.label, v.desc]),
    ...PUBLIC_GROUPS.map((g) => g.label)];
  for (const l of labels) assert.ok(LABELS[l] && LABELS[l].uz && LABELS[l].en, 'нет перевода подписи: ' + l);
});

test('таблица полей: каждая строка — тем запросом, что в её пробах, на каждом названном адресе', async (t) => {
  const s = await docsStand({ limiter: NO_LIMITS });
  t.after(s.close);
  const appt = EXAMPLES.find((x) => x.id === 'appointment-new');
  const own = await sendExample(s, exampleRequest({ ...appt, body: { ...appt.body, start: '2030-03-13T14:00:00+05:00', external_id: 'probe-own' } }, 'ru', {}));
  assert.equal(own.status, 201);
  const bodyOf = { 'requests-create': EXAMPLES.find((x) => x.id === 'request-new').body, 'appointments-create': appt.body, 'offer-accept': {}, 'offer-decline': {} };
  let n = 0;
  for (const f of FIELD_ERRORS) {
    for (const [ep, probe] of Object.entries(f.probes)) {
      const e = ENDPOINTS.find((x) => x.id === ep);
      const req = probe.path
        ? { method: 'GET', path: probe.path }
        : { method: e.method, path: e.path.replace('{id}', own.body.request_id), body: resolve({ ...bodyOf[ep], ...probe.body }, 'ru', {}) };
      const r = await sendExample(s, req);
      const want = f.reason ? [400, 'invalid_field', f.field, f.reason] : [404, 'not_found', f.field, undefined];
      assert.deepEqual([r.status, r.body.error && r.body.error.code, r.body.error && r.body.error.field, r.body.error && r.body.error.reason], want,
        ep + ' ' + f.field + '/' + (f.reason || f.code));
      n += 1;
    }
  }
  assert.ok(n >= 50, 'проб меньше, чем строк: ' + n);
});

test('поля пациента и номер партнёра: граница — та, что написана (на границе — принято, за ней — 400)', async (t) => {
  const s = await docsStand();
  t.after(s.close);
  const R = PATIENT_RULES;
  const send = (body) => sendExample(s, { method: 'POST', path: '/requests', body });
  const okPhone = '+' + '9'.repeat(R.phoneMax - 1);
  const cases = [
    [{ patient: { name: 'x'.repeat(R.nameMax), phone: okPhone, comment: 'x'.repeat(R.commentMax) }, external_id: 'e'.repeat(R.externalMax) }, 201],
    [{ patient: { name: 'Aziza', phone: '+' + '9'.repeat(R.phoneMax) }, external_id: 'p1' }, 400],
    [{ patient: { name: 'Aziza', phone: '1'.repeat(R.phoneDigitsMin) }, external_id: 'p2' }, 201],
    [{ patient: { name: 'Aziza', phone: '1'.repeat(R.phoneDigitsMin - 1) }, external_id: 'p3' }, 400],
    [{ patient: { name: 'Aziza', phone: okPhone }, external_id: 'e'.repeat(R.externalMax + 1) }, 400],
  ];
  for (const [body, status] of cases) assert.equal((await send(body)).status, status, JSON.stringify(body).slice(0, 80));
});

test('права: без права адреса — 403 с этим правом; с любым из названных — не 403; справочники — любому ключу; файлы — без ключа', async (t) => {
  const s = await docsStand({ limiter: NO_LIMITS });
  t.after(s.close);
  const call = (e, headers = {}) => fetch(s.base + '/shifo/v1' + e.path.replace('{id}', 'rq_unknown1').replace('{file}', 'a'.repeat(64) + '.png')
    + (e.id === 'slots' ? '?doctor_id=7' : ''), { method: e.method, headers: { Authorization: 'Bearer ' + s.key, 'Content-Type': 'application/json', ...headers },
    body: e.method === 'POST' ? '{}' : undefined });
  for (const e of ENDPOINTS) {
    if (e.scopes === null) {
      const r = await fetch(s.base + '/shifo/v1' + e.path.replace('{file}', 'a'.repeat(64) + '.png'));
      assert.equal(r.status, 404, e.id + ': без ключа — не 401 (файла нет — 404)');
      continue;
    }
    const others = SCOPES.filter((x) => !e.scopes.includes(x));
    s.setConnection({ scopes: e.scopes.length ? others : ['cancel'], rate_limit: 300 });
    const denied = await call(e);
    if (e.scopes.length) {
      const body = await denied.json();
      assert.deepEqual([denied.status, body.error.code, body.error.scope], [403, 'forbidden_scope', e.scopes[0]], e.id);
    } else assert.notEqual(denied.status, 403, e.id + ': любой ключ');
    for (const sc of e.scopes) {
      s.setConnection({ scopes: [sc], rate_limit: 300 });
      assert.notEqual((await call(e)).status, 403, e.id + ' с правом ' + sc);
    }
  }
});

test('тело и браузер: bad_json, bad_request, too_large, unsupported_encoding; CORS — методы, заголовки, Max-Age, Retry-After', async (t) => {
  const s = await docsStand();
  t.after(s.close);
  const post = (body, headers = {}) => fetch(s.base + '/shifo/v1/requests', { method: 'POST', body,
    headers: { Authorization: 'Bearer ' + s.key, 'Content-Type': 'application/json', ...headers } }).then(async (r) => [r.status, (await r.json()).error.code]);
  assert.deepEqual(await post('{"patient":'), [400, 'bad_json']);
  assert.deepEqual(await post('[]'), [400, 'bad_request']);
  const kb = docFacts().bodyKb;
  assert.deepEqual(await post(JSON.stringify({ patient: { name: 'x', phone: '+998901234567', comment: 'x'.repeat(kb * 1024) } })), [413, 'too_large']);
  assert.deepEqual(await post(zlib.deflateSync('{}'), { 'Content-Encoding': 'compress' }), [415, 'unsupported_encoding']);
  const pre = await fetch(s.base + '/shifo/v1/doctors', { method: 'OPTIONS', headers: { Origin: DOCS_ORIGIN, 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-max-age'), String(CORS_MAX_AGE_SEC));
  assert.match(pre.headers.get('access-control-allow-methods'), /^GET, POST, DELETE\b/);
  assert.equal(pre.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  const get = await fetch(s.base + '/shifo/v1/doctors', { headers: { Authorization: 'Bearer ' + s.key, Origin: DOCS_ORIGIN } });
  assert.equal(get.headers.get('access-control-expose-headers'), 'Retry-After');
  const other = await fetch(s.base + '/shifo/v1/doctors', { headers: { Authorization: 'Bearer ' + s.key, Origin: 'https://other.example' } });
  assert.deepEqual([other.status, (await other.json()).error.code], [403, 'origin_not_allowed']);
  const wrong = await fetch(s.base + '/shifo/v1/clinic', { headers: { Authorization: 'Bearer ' + WRONG_KEY } });
  assert.equal(wrong.status, 401);
});
