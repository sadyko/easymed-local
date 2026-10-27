// META_LEADS_V1 — RPC экрана «Meta: заявки из рекламы».
//
// Правила — те же, что у rpc/telephony.js и rpc/telegram.js: раздел выдаётся
// из «Ролей» ключом settings.meta, роль без настройки — только администратор
// (с учётом надстроечных ролей); токен не пересекает границу RPC ни в каком
// виде — только token_set и хвост (и хвост — только администратору);
// ошибки проверки — 400, а не 500; подключение и опрос подменяют сеть через deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { metaSettingsGet, metaSettingsSave, metaConnect, metaTokenClear, metaPollNow, metaLeadsRecent, RpcError } from './meta.js';
import { getRpc } from './index.js';
import { GRAPH_VERSION } from '../meta/graph.js';

const TOKEN = 'EAAGTESTONLYuserToken001';
const PAGE_TOKEN = 'EAAGTESTONLYpageToken002';
const fresh = () => {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin');
  ins.run(2, 'docadm', 'x', 'doctor');
  ins.run(3, 'reg', 'x', 'registrar');
  return db;
};
const admin = { id: 1, role: 'admin' };
const doctorAdmin = { id: 2, role: 'doctor', extra_roles: ['admin'] };
const registrar = { id: 3, role: 'registrar' };
const kek = () => ({ kekPath: path.join(tmpDir('em-meta-rpc-'), '.api-secrets-key') });
const res = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
function graphStub(routes) {
  return async (url) => {
    const u = new URL(String(url));
    const p = u.pathname.replace('/' + GRAPH_VERSION + '/', '');
    const r = routes[p];
    if (!r) return res({ error: { code: 803, message: 'unknown ' + p } }, 400);
    return typeof r === 'function' ? r(u) : res(r);
  };
}
const ROUTES = {
  me: { id: 'u1', name: 'Нодир' },
  'me/accounts': { data: [{ id: '777', name: 'Клиника Нур', access_token: PAGE_TOKEN }] },
  '777/leadgen_forms': { data: [{ id: 'f1', name: 'Консультация', status: 'ACTIVE', leads_count: 2 }] },
  'f1/leads': { data: [{ id: 'L1', created_time: '2026-10-16T09:00:00+0000', form_id: 'f1', platform: 'ig',
    field_data: [{ name: 'full_name', values: ['Азиз'] }, { name: 'phone_number', values: ['+998901234567'] }] }] },
};

test('каждый RPC раздела — только администратор (с учётом надстроечных ролей); роль без ключа — 403', async () => {
  const db = fresh(); const o = kek();
  for (const fn of [metaSettingsGet, metaLeadsRecent]) {
    assert.throws(() => fn(db, {}, registrar), (e) => e instanceof RpcError && e.status === 403);
    fn(db, {}, doctorAdmin);
  }
  assert.throws(() => metaSettingsSave(db, {}, registrar), (e) => e.status === 403);
  assert.throws(() => metaTokenClear(db, {}, registrar), (e) => e.status === 403);
  await assert.rejects(() => metaConnect(db, { token: TOKEN }, registrar, { fetchImpl: graphStub(ROUTES), ...o }), (e) => e.status === 403);
  await assert.rejects(() => metaPollNow(db, {}, registrar, { fetchImpl: graphStub(ROUTES), hasModule: () => true, ...o }), (e) => e.status === 403);
});

test('все шесть имён зарегистрированы в реестре RPC', () => {
  for (const n of ['meta_settings_get', 'meta_settings_save', 'meta_connect', 'meta_token_clear', 'meta_poll_now', 'meta_leads_recent']) {
    assert.equal(typeof getRpc(n), 'function', n);
  }
});

test('connect: проверяет токен, сохраняет подключение, отдаёт страницу и формы — токена в ответе нет; отказ Meta — ok:false с причиной, не исключение', async () => {
  const db = fresh(); const o = kek();
  const r = await metaConnect(db, { token: TOKEN }, admin, { fetchImpl: graphStub(ROUTES), ...o });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.page, { id: '777', name: 'Клиника Нур' });
  assert.equal(r.settings.token_set, true);
  assert.equal(r.settings.token_tail, TOKEN.slice(-4));
  assert.deepEqual(r.settings.forms.map((f) => f.id), ['f1']);
  const txt = JSON.stringify(r);
  assert.ok(!txt.includes(TOKEN) && !txt.includes(PAGE_TOKEN), 'токенов в ответе нет');
  const bad = await metaConnect(db, { token: 'EAAGTESTONLYbad' }, admin, { fetchImpl: graphStub({ me: () => res({ error: { code: 190, message: 'nope' } }, 400) }), ...o });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_token');
  assert.match(bad.message, /токен/i, 'причина — человеческой фразой');
  assert.equal(bad.settings.token_set, true, 'прежнее подключение цело');
  // Пустой токен без сохранённого — 400, а не поход в сеть.
  const db2 = fresh();
  await assert.rejects(() => metaConnect(db2, { token: '   ' }, admin, { fetchImpl: async () => { throw new Error('no'); }, ...o }), (e) => e instanceof RpcError && e.status === 400);
});

test('get: хвост токена видит только администратор; строки настроек без шифртекста', async () => {
  const db = fresh(); const o = kek();
  await metaConnect(db, { token: TOKEN }, admin, { fetchImpl: graphStub(ROUTES), ...o });
  const out = metaSettingsGet(db, {}, admin);
  assert.equal(out.token_set, true);
  assert.equal(out.token_tail, TOKEN.slice(-4));
  assert.ok(!('token_sealed' in out) && !JSON.stringify(out).includes(TOKEN));
  const asDocAdmin = metaSettingsGet(db, {}, doctorAdmin);
  assert.equal(asDocAdmin.token_tail, TOKEN.slice(-4), 'надстроечный администратор — администратор');
});

test('save: включить без токена — 400; период — 400 при мусоре; удача пишет updated_by и возвращает настройки', async () => {
  const db = fresh(); const o = kek();
  assert.throws(() => metaSettingsSave(db, { enabled: true }, admin), (e) => e instanceof RpcError && e.status === 400);
  assert.throws(() => metaSettingsSave(db, { poll_minutes: 'x' }, admin), (e) => e instanceof RpcError && e.status === 400);
  await metaConnect(db, { token: TOKEN }, admin, { fetchImpl: graphStub(ROUTES), ...o });
  const s = metaSettingsSave(db, { enabled: true, poll_minutes: 3, forms_mode: 'selected', forms: [{ id: 'f1', selected: true }] }, admin);
  assert.equal(s.enabled, true);
  assert.equal(s.poll_minutes, 3);
  assert.equal(db.prepare('SELECT updated_by FROM meta_settings WHERE id = 1').get().updated_by, 1);
});

test('poll_now: один проход сейчас с подменённой сетью — заявка в CRM; days сдвигает курсор назад; ответ — настройки и счётчики', async () => {
  const db = fresh(); const o = kek();
  await metaConnect(db, { token: TOKEN }, admin, { fetchImpl: graphStub(ROUTES), ...o });
  metaSettingsSave(db, { enabled: true }, admin);
  const r = await metaPollNow(db, { days: 7 }, admin, { fetchImpl: graphStub(ROUTES), hasModule: () => true, ...o });
  assert.equal(r.settings.last_error, '');
  assert.equal(r.created, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM crm_requests WHERE source = 'meta_ads'").get().n, 1);
  await assert.rejects(() => metaPollNow(db, { days: 400 }, admin, { fetchImpl: graphStub(ROUTES), hasModule: () => true, ...o }), (e) => e instanceof RpcError && e.status === 400);
  // Выключено — проход не идёт, но ответ честный.
  metaSettingsSave(db, { enabled: false }, admin);
  const r2 = await metaPollNow(db, {}, admin, { fetchImpl: async () => { throw new Error('must not fetch'); }, hasModule: () => true, ...o });
  assert.equal(r2.settings.enabled, false);
  assert.equal(r2.created, 0);
});

test('leads_recent: последние заявки новыми вперёд, с колонкой CRM и её этапом; limit ограничен', async () => {
  const db = fresh(); const o = kek();
  await metaConnect(db, { token: TOKEN }, admin, { fetchImpl: graphStub(ROUTES), ...o });
  metaSettingsSave(db, { enabled: true }, admin);
  await metaPollNow(db, {}, admin, { fetchImpl: graphStub(ROUTES), hasModule: () => true, ...o });
  db.prepare("INSERT INTO meta_leads (leadgen_id, full_name, phone, status, error, received_at) VALUES ('L0', 'Старая', '', 'error', 'boom', '2026-01-01T00:00:00Z')").run();
  const rows = metaLeadsRecent(db, { limit: 10 }, admin);
  assert.deepEqual(rows.map((r) => [r.leadgen_id, r.status]), [['L1', 'created'], ['L0', 'error']]);
  assert.equal(rows[0].full_name, 'Азиз');
  assert.equal(rows[0].phone, '+998901234567');
  assert.equal(rows[0].form_name, 'Консультация');
  assert.ok(rows[0].crm_request_id > 0);
  assert.equal(typeof rows[0].crm_stage_label, 'string');
  assert.equal(rows[1].error, 'boom');
  assert.equal(metaLeadsRecent(db, { limit: 1 }, admin).length, 1);
  assert.ok(!('field_data_json' in rows[0]), 'сырые ответы формы в списке не нужны — они уже в комментарии карточки');
});
