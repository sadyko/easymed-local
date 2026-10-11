// PUBLIC_API_V1 — ПОДДЕЛЬНЫЙ ПУБЛИЧНЫЙ СЕРВЕР для тестов стороны клиники (шаг 8a):
// fetchImpl в процессе, без сокетов (порты Windows — память
// windows-dynamic-port-fetch-bad-port). Говорит протоколом обмена
// /_sync/v1/* так, как его будет говорить настоящий сервер шага 8b:
// проверяет подпись клиники её открытым ключом и наличие лицензии, хранит
// снимок, время, ключи, события и файлы, отдаёт очередь заявок с курсором и
// запечатывает данные пациента ключом-ящиком клиники (box_key из /keys).
//
// Решения владельца 16 и 19 (2026-10-11): подтверждённые курсором элементы
// стираются целиком, с шифротекстом, сразу при подтверждении (как обязан
// стирать сервер 8b); срок держания клиника сообщает в подтверждении (held).
import { verifyRequest, sealFor } from '../services/api/sync-identity.js';

export function fakePublicServer({ signPublic, clinicId = 'c-000777', base = 'https://api.test.local' } = {}) {
  const state = {
    keys: [], snapshots: [], slots: [], events: [], media: new Map(), inbox: [], acks: [], held: [], calls: [],
    offline: false, refuse: null, licences: [],
  };
  let seq = 0;
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    body: null,
  });
  async function fetchImpl(url, opts = {}) {
    if (state.offline) throw new TypeError('fetch failed');
    const u = new URL(String(url));
    if (u.origin !== base) throw new TypeError('unexpected host ' + u.origin);
    const method = String(opts.method || 'GET').toUpperCase();
    const h = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const raw = opts.body == null ? '' : opts.body;
    const p = u.pathname + u.search;
    state.calls.push(method + ' ' + u.pathname);
    if (h['x-easymed-clinic'] !== clinicId || !h['x-easymed-licence'] || h['x-easymed-key'] !== signPublic
      || !verifyRequest(signPublic, { method, path: p, time: h['x-easymed-time'], body: raw }, h['x-easymed-signature'])) {
      return reply(401, { error: { code: 'invalid_signature' } });
    }
    state.licences.push(Buffer.from(h['x-easymed-licence'], 'base64').toString('utf8'));
    if (state.refuse) return reply(state.refuse.status, state.refuse.body || { error: { code: 'refused' } });
    const json = () => JSON.parse(String(raw || '{}'));
    if (method === 'PUT' && u.pathname === '/_sync/v1/keys') { state.keys.push(json()); return reply(200, { ok: true }); }
    if (method === 'PUT' && u.pathname === '/_sync/v1/snapshot') { state.snapshots.push(json()); return reply(200, { ok: true }); }
    if (method === 'PUT' && u.pathname === '/_sync/v1/slots') { state.slots.push(json()); return reply(200, { ok: true }); }
    if (method === 'POST' && u.pathname === '/_sync/v1/media/check') {
      return reply(200, { missing: (json().hashes || []).filter((x) => !state.media.has(x)) });
    }
    const m = /^\/_sync\/v1\/media\/([0-9a-f]{64})\.[a-z]+$/.exec(u.pathname);
    if (method === 'PUT' && m) { state.media.set(m[1], Buffer.from(raw)); return reply(200, { ok: true }); }
    if (method === 'POST' && u.pathname === '/_sync/v1/events') {
      const events = json().events || [];
      state.events.push(...events);
      return reply(200, { accepted: events.map((e) => e.seq) });
    }
    if (method === 'GET' && u.pathname === '/_sync/v1/inbox') {
      const after = Number(u.searchParams.get('after') || 0);
      return reply(200, { items: state.inbox.filter((it) => Number(it.cursor) > after) });
    }
    if (method === 'POST' && u.pathname === '/_sync/v1/inbox/ack') {
      const body = json();
      const c = Number(body.cursor);
      state.acks.push(c);
      if (Array.isArray(body.held)) state.held.push(...body.held);
      state.inbox = state.inbox.filter((it) => Number(it.cursor) > c);
      return reply(200, { ok: true });
    }
    return reply(404, { error: { code: 'not_found' } });
  }
  /** Положить в очередь то, что прислал партнёр; данные пациента — запечатанными ключом клиники. */
  function enqueue(item, patient = null) {
    const keys = state.keys.at(-1);
    const out = { cursor: String(++seq), ...item };
    if (patient) {
      if (!keys || !keys.box_key) throw new Error('fake public server: клиника ещё не прислала box_key');
      out.sealed = sealFor(keys.box_key, patient);
    }
    state.inbox.push(out);
    return out;
  }
  return { fetchImpl, state, enqueue, base, env: { EASYMED_PUBLIC_URL: base } };
}
