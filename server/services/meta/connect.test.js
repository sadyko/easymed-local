// META_LEADS_V1_GRAPH (подключение) — проверка токена и привязка страницы:
// «кто я» (/me), страницы пользователя (/me/accounts) и формы выбранной
// страницы (/{page}/leadgen_forms). Токен страницы из /me/accounts, если Meta
// его выдала, хранится отдельно — именно им читаются заявки. Токен страницы,
// вставленный напрямую, — сам себе страница. Отказ Meta ничего не сохраняет.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { connect } from './connect.js';
import { publicSettings, getTokens, saveSettings } from './settings.js';
import { GRAPH_VERSION } from './graph.js';

const TOKEN = 'EAAGTESTONLYuserToken001';
const PAGE_TOKEN = 'EAAGTESTONLYpageToken002';
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const kek = () => ({ kekPath: path.join(tmpDir('em-meta-kek-'), '.api-secrets-key') });
const res = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const FORMS = { data: [{ id: 'f1', name: 'Консультация', status: 'ACTIVE', leads_count: 12 }, { id: 'f2', name: 'УЗИ', status: 'ARCHIVED', leads_count: 3 }] };

/** Подмена Graph: маршруты по пути после версии, с проверкой токена в запросе. */
function graphStub(routes, seen = []) {
  return async (url) => {
    const u = new URL(String(url));
    const p = u.pathname.replace('/' + GRAPH_VERSION + '/', '');
    seen.push({ path: p, token: u.searchParams.get('access_token'), fields: u.searchParams.get('fields') });
    const r = routes[p];
    if (!r) return res({ error: { code: 803, message: 'unknown path ' + p } }, 400);
    return typeof r === 'function' ? r(u) : res(r);
  };
}

test('connect: токен пользователя — страница из /me/accounts, её токен — отдельно, формы страницы записаны', async () => {
  const db = fresh(); const o = kek(); const seen = [];
  const fetchImpl = graphStub({
    me: { id: 'u1', name: 'Нодир' },
    'me/accounts': { data: [{ id: '777', name: 'Клиника Нур', access_token: PAGE_TOKEN }] },
    '777/leadgen_forms': FORMS,
  }, seen);
  const r = await connect(db, { token: TOKEN }, { fetchImpl, ...o });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.page, { id: '777', name: 'Клиника Нур' });
  assert.deepEqual(r.pages, [{ id: '777', name: 'Клиника Нур' }]);
  assert.equal(r.forms.length, 2);
  const s = publicSettings(db);
  assert.equal(s.token_set, true);
  assert.equal(s.page_id, '777');
  assert.equal(s.page_name, 'Клиника Нур');
  assert.deepEqual(s.forms.map((f) => [f.id, f.selected]), [['f1', true], ['f2', true]]);
  assert.deepEqual(getTokens(db, o), { token: TOKEN, pageToken: PAGE_TOKEN });
  // Формы читаются токеном СТРАНИЦЫ — у него есть leads_retrieval на неё.
  assert.equal(seen.find((x) => x.path === '777/leadgen_forms').token, PAGE_TOKEN);
  assert.ok(!JSON.stringify(r).includes(TOKEN) && !JSON.stringify(r).includes(PAGE_TOKEN), 'токенов в ответе нет');
});

test('connect: токен страницы напрямую — /me и есть страница, /me/accounts пуст, токен страницы не нужен', async () => {
  const db = fresh(); const o = kek();
  const fetchImpl = graphStub({
    me: { id: '777', name: 'Клиника Нур' },
    'me/accounts': { data: [] },
    '777/leadgen_forms': FORMS,
  });
  const r = await connect(db, { token: TOKEN }, { fetchImpl, ...o });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.page, { id: '777', name: 'Клиника Нур' });
  assert.deepEqual(getTokens(db, o), { token: TOKEN, pageToken: '' });
});

test('connect: несколько страниц — берётся первая, остальные перечислены; page_id выбирает другую; сохранённый токен используется без повторного ввода', async () => {
  const db = fresh(); const o = kek();
  const routes = {
    me: { id: 'u1', name: 'Нодир' },
    'me/accounts': { data: [{ id: '1', name: 'Первая', access_token: 'EAAGTESTONLYp1' }, { id: '2', name: 'Вторая', access_token: 'EAAGTESTONLYp2' }] },
    '1/leadgen_forms': { data: [{ id: 'a', name: 'A', status: 'ACTIVE', leads_count: 0 }] },
    '2/leadgen_forms': { data: [{ id: 'b', name: 'B', status: 'ACTIVE', leads_count: 0 }] },
  };
  const r1 = await connect(db, { token: TOKEN }, { fetchImpl: graphStub(routes), ...o });
  assert.equal(r1.page.id, '1');
  assert.deepEqual(r1.pages.map((p) => p.id), ['1', '2']);
  assert.deepEqual(publicSettings(db).forms.map((f) => f.id), ['a']);
  const r2 = await connect(db, { pageId: '2' }, { fetchImpl: graphStub(routes), ...o });   // без token — из хранилища
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.page.id, '2');
  assert.equal(publicSettings(db).page_id, '2');
  assert.deepEqual(publicSettings(db).forms.map((f) => f.id), ['b']);
  assert.deepEqual(getTokens(db, o), { token: TOKEN, pageToken: 'EAAGTESTONLYp2' });
});

test('connect: отказ Meta — причина словом, ничего не сохранено; без токена вовсе — отказ до сети', async () => {
  const db = fresh(); const o = kek();
  const bad = await connect(db, { token: 'EAAGTESTONLYbad' }, { fetchImpl: graphStub({ me: () => res({ error: { code: 190, message: 'Invalid OAuth access token' } }, 400) }), ...o });
  assert.deepEqual([bad.ok, bad.reason], [false, 'bad_token']);
  assert.equal(publicSettings(db).token_set, false);
  const none = await connect(db, {}, { fetchImpl: async () => { throw new Error('must not be called'); }, ...o });
  assert.deepEqual([none.ok, none.reason], [false, 'no_token']);
  const off = await connect(db, { token: TOKEN }, { fetchImpl: async () => { throw new TypeError('fetch failed'); }, ...o });
  assert.deepEqual([off.ok, off.reason], [false, 'offline']);
});

test('connect: повторная проверка не трогает включённость и снятые галочки форм', async () => {
  const db = fresh(); const o = kek();
  const routes = { me: { id: '777', name: 'P' }, 'me/accounts': { data: [] }, '777/leadgen_forms': FORMS };
  await connect(db, { token: TOKEN }, { fetchImpl: graphStub(routes), ...o });
  saveSettings(db, { enabled: true, forms_mode: 'selected', forms: [{ id: 'f2', selected: false }] }, 1);
  const r = await connect(db, {}, { fetchImpl: graphStub(routes), ...o });
  assert.equal(r.ok, true);
  const s = publicSettings(db);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.forms.map((f) => [f.id, f.selected]), [['f1', true], ['f2', false]]);
});

// FIX_318_V1 (L3) — у страницы бывает больше 100 форм: список читается по всем
// страницам ответа (paging.next), а не обрывается на первой.
test('connect: формы страницы — по всем страницам ответа', async () => {
  const db = fresh(); const o = kek(); const seen = [];
  const next = `https://graph.facebook.com/${GRAPH_VERSION}/777/leadgen_forms?after=p2&access_token=${PAGE_TOKEN}`;
  const fetchImpl = graphStub({
    me: { id: 'u1', name: 'Нодир' },
    'me/accounts': { data: [{ id: '777', name: 'Клиника Нур', access_token: PAGE_TOKEN }] },
    '777/leadgen_forms': (u) => res(u.searchParams.get('after') === 'p2'
      ? { data: [{ id: 'f101', name: 'Сто первая', status: 'ACTIVE', leads_count: 0 }] }
      : { data: FORMS.data, paging: { next } }),
  }, seen);
  const r = await connect(db, { token: TOKEN }, { fetchImpl, ...o });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.forms.map((f) => f.id), ['f1', 'f2', 'f101']);
  assert.deepEqual(publicSettings(db).forms.map((f) => f.id), ['f1', 'f2', 'f101']);
  assert.ok(!JSON.stringify(r).includes(PAGE_TOKEN), 'адрес следующей страницы несёт токен — наружу он не попадает');
});

// FIX_318_V1 (L3) — опрос выключился сам из-за недействительного токена;
// удачная проверка нового токена включает его обратно.
test('connect: удачная проверка после «токен недействителен» включает опрос обратно', async () => {
  const db = fresh(); const o = kek();
  const routes = { me: { id: '777', name: 'P' }, 'me/accounts': { data: [] }, '777/leadgen_forms': FORMS };
  await connect(db, { token: TOKEN }, { fetchImpl: graphStub(routes), ...o });
  saveSettings(db, { enabled: true }, 1);
  db.prepare("UPDATE meta_settings SET enabled = 0, last_error = 'bad_token' WHERE id = 1").run();   // как после recordPoll bad_token
  const r = await connect(db, { token: 'EAAGTESTONLYfresh005' }, { fetchImpl: graphStub(routes), ...o });
  assert.equal(r.ok, true);
  assert.equal(publicSettings(db).enabled, true);
  assert.equal(publicSettings(db).last_error, '');
});
