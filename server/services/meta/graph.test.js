// META_LEADS_V1_GRAPH — тонкий клиент Graph API: адрес строится из версии и
// пути, параметры-объекты уходят JSON-ом (так Meta принимает `filtering`),
// ответ — либо данные, либо ОДНО СЛОВО причины из закрытого словаря. Токен не
// попадает ни в причину, ни в сообщение, ни в журнал — нигде, кроме запроса.
import test from 'node:test';
import assert from 'node:assert/strict';
import { graphGet, graphGetAll, reasonFromError, scrubToken, GRAPH_VERSION, GRAPH_BASE } from './graph.js';

const TOKEN = 'EAAGTESTONLYtokenXYZ123';
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

test('graphGet: адрес из базы, версии и пути; параметры и токен — в строке запроса; объекты — JSON', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), init }); return jsonRes(200, { data: [1] }); };
  const r = await graphGet('123/leads', { fields: 'id,created_time', limit: 50, filtering: [{ field: 'time_created', operator: 'GREATER_THAN', value: 1700000000 }] },
    { token: TOKEN, fetchImpl });
  assert.deepEqual(r, { ok: true, data: { data: [1] } });
  assert.equal(seen.length, 1);
  const u = new URL(seen[0].url);
  assert.equal(u.origin + u.pathname, `${GRAPH_BASE}/${GRAPH_VERSION}/123/leads`);
  assert.equal(u.searchParams.get('fields'), 'id,created_time');
  assert.equal(u.searchParams.get('limit'), '50');
  assert.deepEqual(JSON.parse(u.searchParams.get('filtering')), [{ field: 'time_created', operator: 'GREATER_THAN', value: 1700000000 }]);
  assert.equal(u.searchParams.get('access_token'), TOKEN);
  assert.ok(seen[0].init && seen[0].init.signal, 'запрос с таймаутом (AbortSignal)');
});

test('graphGet: ошибка Meta — причина одним словом, код сохранён, токена в сообщении нет', async () => {
  const body = { error: { message: 'Error validating access token: Session has expired ' + TOKEN, type: 'OAuthException', code: 190, error_subcode: 463, fbtrace_id: 'Abc' } };
  const r = await graphGet('me', {}, { token: TOKEN, fetchImpl: async () => jsonRes(400, body) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_token');
  assert.equal(r.code, 190);
  assert.equal(r.subcode, 463);
  assert.ok(!String(r.message).includes(TOKEN), 'токен вычищен из сообщения: ' + r.message);
  assert.ok(!JSON.stringify(r).includes(TOKEN), 'токена нет нигде в ответе клиента');
});

test('reasonFromError: словарь причин по кодам Meta', () => {
  const of = (code, sub) => reasonFromError({ code, error_subcode: sub });
  assert.equal(of(190), 'bad_token');
  assert.equal(of(102), 'bad_token');
  assert.equal(of(10), 'no_permission');
  assert.equal(of(200), 'no_permission');
  assert.equal(of(299), 'no_permission');
  assert.equal(of(4), 'rate_limited');
  assert.equal(of(17), 'rate_limited');
  assert.equal(of(32), 'rate_limited');
  assert.equal(of(613), 'rate_limited');
  assert.equal(of(80004), 'rate_limited');
  assert.equal(of(1), 'server_error');
  assert.equal(of(2), 'server_error');
  assert.equal(of(100), 'bad_request');
  assert.equal(of(803), 'not_found');
  assert.equal(of(12345), 'server_error');
});

test('graphGet: сеть недоступна — offline; 5xx без JSON — server_error; не-JSON с 200 — bad_response; 404 — not_found', async () => {
  const off = await graphGet('me', {}, { token: TOKEN, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(off.ok, false); assert.equal(off.reason, 'offline');
  const five = await graphGet('me', {}, { token: TOKEN, fetchImpl: async () => ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' }) });
  assert.equal(five.reason, 'server_error');
  const junk = await graphGet('me', {}, { token: TOKEN, fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }) });
  assert.equal(junk.reason, 'bad_response');
  const nf = await graphGet('me', {}, { token: TOKEN, fetchImpl: async () => ({ ok: false, status: 404, text: async () => '{}' }) });
  assert.equal(nf.reason, 'not_found');
});

test('graphGetAll: идёт по paging.next, собирает data, останавливается на пределе страниц', async () => {
  const pages = {
    first: { data: [{ id: 'a' }, { id: 'b' }], paging: { cursors: {}, next: GRAPH_BASE + '/' + GRAPH_VERSION + '/1/leads?after=2&access_token=' + TOKEN } },
    [GRAPH_BASE + '/' + GRAPH_VERSION + '/1/leads?after=2&access_token=' + TOKEN]: { data: [{ id: 'c' }], paging: { next: 'https://graph.facebook.com/x?after=3' } },
    'https://graph.facebook.com/x?after=3': { data: [{ id: 'd' }], paging: { next: 'https://graph.facebook.com/x?after=4' } },
  };
  const urls = [];
  const fetchImpl = async (url) => { const u = String(url); urls.push(u); return jsonRes(200, pages[u] || pages.first); };
  const r = await graphGetAll('1/leads', { fields: 'id' }, { token: TOKEN, fetchImpl, maxPages: 3 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.equal(r.truncated, true, 'предел страниц достигнут — об этом сказано');
  assert.equal(urls.length, 3);
  // Вторая страница запрошена ровно по next, без повторной сборки адреса.
  assert.equal(urls[1], pages.first.paging.next);
});

test('graphGetAll: отказ на второй странице — отказ всего обхода с той же причиной; первая страница не теряется', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return jsonRes(200, { data: [{ id: 'a' }], paging: { next: 'https://graph.facebook.com/x?after=2' } });
    return jsonRes(400, { error: { code: 4, message: 'rate' } });
  };
  const r = await graphGetAll('1/leads', {}, { token: TOKEN, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate_limited');
  assert.deepEqual(r.data.map((x) => x.id), ['a']);
});

test('scrubToken: токен исчезает из адреса и из текста, остальное цело', () => {
  assert.equal(scrubToken('https://graph.facebook.com/v1/me?access_token=' + TOKEN + '&fields=id', TOKEN),
    'https://graph.facebook.com/v1/me?access_token=***&fields=id');
  assert.equal(scrubToken('bad token ' + TOKEN + ' here', TOKEN), 'bad token *** here');
  assert.equal(scrubToken('nothing', ''), 'nothing');
  assert.equal(scrubToken(null, TOKEN), '');
});
