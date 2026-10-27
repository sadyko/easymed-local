// META_LEADS_V1_POLL — опрос Graph API: раз в период, пока включено и модуль CRM
// в лицензии, для каждой выбранной формы читаются заявки новее курсора; каждая
// новая — в журнал и в CRM; курсор двигается вперёд только после удачи по ВСЕМ
// формам (иначе заявки отказавшей формы были бы пропущены навсегда). Отказ
// сети — слово в last_error и следующий проход; недействительный токен
// выключает опрос. Сам проход никогда не бросает.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { pollOnce, nextDelayMs } from './poller.js';
import { storeConnection, saveSettings, publicSettings } from './settings.js';
import { GRAPH_VERSION } from './graph.js';
import { META_SOURCE_KEY } from './leads.js';

const TOKEN = 'EAAGTESTONLYuserToken001';
const PAGE_TOKEN = 'EAAGTESTONLYpageToken002';
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const kek = () => ({ kekPath: path.join(tmpDir('em-meta-kek-'), '.api-secrets-key') });
const res = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const FORMS = [{ id: 'f1', name: 'Консультация', status: 'ACTIVE', leads_count: 1 }, { id: 'f2', name: 'УЗИ', status: 'ACTIVE', leads_count: 1 }];
const lead = (id, t, phone, name = 'Пациент ' + id) => ({
  id, created_time: t, form_id: 'f1', platform: 'ig',
  field_data: [{ name: 'full_name', values: [name] }, { name: 'phone_number', values: [phone] }],
});

function ready(db, o, { pageToken = PAGE_TOKEN } = {}) {
  storeConnection(db, { token: TOKEN, pageToken, page: { id: '777', name: 'P' }, forms: FORMS }, o);
  saveSettings(db, { enabled: true }, 1);
  // Курсор в прошлое, чтобы тестовые даты заявок были «новее».
  db.prepare('UPDATE meta_settings SET since_ts = ? WHERE id = 1').run(1760000000);
}

/** Подмена Graph: ответ по пути формы; запоминает запросы (путь, токен, фильтр). */
function graphStub(byForm, seen = []) {
  return async (url) => {
    const u = new URL(String(url));
    const p = u.pathname.replace('/' + GRAPH_VERSION + '/', '');
    let filtering = null;
    try { filtering = JSON.parse(u.searchParams.get('filtering')); } catch { /* нет фильтра */ }
    seen.push({ path: p, token: u.searchParams.get('access_token'), filtering, fields: u.searchParams.get('fields') });
    const r = byForm[p];
    if (!r) return res({ error: { code: 803, message: 'unknown ' + p } }, 400);
    return typeof r === 'function' ? r(u) : res(r);
  };
}

test('выключено или нет модуля CRM — в сеть не ходим', async () => {
  const db = fresh(); const o = kek();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return res({ data: [] }); };
  await pollOnce(db, { fetchImpl, hasModule: () => true, ...o });
  assert.equal(calls, 0, 'не включено');
  ready(db, o);
  await pollOnce(db, { fetchImpl, hasModule: () => false, ...o });
  assert.equal(calls, 0, 'модуль crm не выдан');
  assert.equal(publicSettings(db).last_poll_at, null, 'без модуля проход даже не отмечается');
});

test('проход: каждая форма — токеном страницы и фильтром по курсору; новые заявки — в CRM и журнал; курсор — на самую свежую', async () => {
  const db = fresh(); const o = kek(); const seen = [];
  const fetchImpl = graphStub({
    'f1/leads': { data: [lead('11', '2026-10-16T09:00:00+0000', '+998901111111'), lead('12', '2026-10-16T09:30:00+0000', '+998902222222')] },
    'f2/leads': { data: [lead('21', '2026-10-16T10:00:00+0000', '+998903333333')] },
  }, seen);
  ready(db, o);
  await pollOnce(db, { fetchImpl, hasModule: () => true, ...o });
  assert.deepEqual(seen.map((x) => x.path).sort(), ['f1/leads', 'f2/leads']);
  for (const x of seen) {
    assert.equal(x.token, PAGE_TOKEN, 'заявки читаются токеном страницы');
    assert.deepEqual(x.filtering, [{ field: 'time_created', operator: 'GREATER_THAN', value: 1760000000 }]);
    assert.ok(x.fields.includes('field_data') && x.fields.includes('created_time'), x.fields);
  }
  const cards = db.prepare('SELECT full_name, phone, source, note FROM crm_requests ORDER BY id').all();
  assert.deepEqual(cards.map((c) => [c.full_name, c.phone, c.source]), [
    ['Пациент 11', '+998901111111', META_SOURCE_KEY], ['Пациент 12', '+998902222222', META_SOURCE_KEY], ['Пациент 21', '+998903333333', META_SOURCE_KEY]]);
  assert.ok(cards[2].note.includes('Форма: «УЗИ»'), 'имя формы — из нашего списка форм: ' + cards[2].note);
  const j = db.prepare('SELECT leadgen_id, status, form_name FROM meta_leads ORDER BY leadgen_id').all();
  assert.deepEqual(j.map((r) => [r.leadgen_id, r.status, r.form_name]), [['11', 'created', 'Консультация'], ['12', 'created', 'Консультация'], ['21', 'created', 'УЗИ']]);
  const s = publicSettings(db);
  assert.equal(s.last_error, '');
  assert.match(s.last_ok_at, /^\d{4}-/);
  assert.equal(s.since_ts, Math.floor(Date.parse('2026-10-16T10:00:00+0000') / 1000));
  assert.equal(s.enabled, true);
});

test('тот же ответ Meta второй раз — ни новых карточек, ни строк журнала', async () => {
  const db = fresh(); const o = kek();
  const body = { 'f1/leads': { data: [lead('11', '2026-10-16T09:00:00+0000', '+998901111111')] }, 'f2/leads': { data: [] } };
  ready(db, o);
  await pollOnce(db, { fetchImpl: graphStub(body), hasModule: () => true, ...o });
  db.prepare('UPDATE meta_settings SET since_ts = ? WHERE id = 1').run(1760000000);   // как будто курсор откатили
  await pollOnce(db, { fetchImpl: graphStub(body), hasModule: () => true, ...o });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_leads').get().n, 1);
});

test('без токена страницы заявки читаются основным токеном; режим «выбранные» опрашивает только отмеченные формы', async () => {
  const db = fresh(); const o = kek(); const seen = [];
  ready(db, o, { pageToken: '' });
  saveSettings(db, { forms_mode: 'selected', forms: [{ id: 'f1', selected: false }] }, 1);
  await pollOnce(db, { fetchImpl: graphStub({ 'f2/leads': { data: [] } }, seen), hasModule: () => true, ...o });
  assert.deepEqual(seen.map((x) => [x.path, x.token]), [['f2/leads', TOKEN]]);
});

test('сеть недоступна — last_error offline, опрос включён, курсор на месте; следующий проход после связи всё забирает', async () => {
  const db = fresh(); const o = kek();
  ready(db, o);
  await pollOnce(db, { fetchImpl: async () => { throw new TypeError('fetch failed'); }, hasModule: () => true, ...o });
  let s = publicSettings(db);
  assert.equal(s.last_error, 'offline');
  assert.equal(s.enabled, true);
  assert.equal(s.since_ts, 1760000000);
  assert.match(s.last_poll_at, /^\d{4}-/);
  assert.equal(s.last_ok_at, null);
  await pollOnce(db, { fetchImpl: graphStub({ 'f1/leads': { data: [lead('11', '2026-10-16T09:00:00+0000', '+998901111111')] }, 'f2/leads': { data: [] } }), hasModule: () => true, ...o });
  s = publicSettings(db);
  assert.equal(s.last_error, '');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 1);
});

test('отказала одна форма — её заявки не потеряны: другая подшита, курсор не двинулся, ошибка записана', async () => {
  const db = fresh(); const o = kek();
  ready(db, o);
  await pollOnce(db, { fetchImpl: graphStub({
    'f1/leads': () => res({ error: { code: 4, message: 'rate' } }, 400),
    'f2/leads': { data: [lead('21', '2026-10-16T10:00:00+0000', '+998903333333')] },
  }), hasModule: () => true, ...o });
  const s = publicSettings(db);
  assert.equal(s.last_error, 'rate_limited');
  assert.equal(s.since_ts, 1760000000, 'курсор ждёт удачи по всем формам');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 1);
});

test('недействительный токен (190) — опрос выключается, причина bad_token; второй проход в сеть не ходит', async () => {
  const db = fresh(); const o = kek();
  ready(db, o);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return res({ error: { code: 190, message: 'expired' } }, 400); };
  await pollOnce(db, { fetchImpl, hasModule: () => true, ...o });
  const s = publicSettings(db);
  assert.equal(s.enabled, false);
  assert.equal(s.last_error, 'bad_token');
  const before = calls;
  await pollOnce(db, { fetchImpl, hasModule: () => true, ...o });
  assert.equal(calls, before);
});

test('одна сломанная заявка (имя не разобрать — пустые поля) не роняет проход: строка журнала со статусом error, остальные подшиты', async () => {
  const db = fresh(); const o = kek();
  ready(db, o);
  const broken = { id: '99', created_time: '2026-10-16T09:10:00+0000', field_data: 'not-an-array' };
  await pollOnce(db, { fetchImpl: graphStub({
    'f1/leads': { data: [broken, lead('11', '2026-10-16T09:00:00+0000', '+998901111111')] },
    'f2/leads': { data: [] },
  }), hasModule: () => true, fileLeadImpl: (db2, l) => { if (l.leadgen_id === '99') throw new Error('boom'); return { status: 'created', crm_request_id: null }; }, ...o });
  const j = db.prepare('SELECT leadgen_id, status, error FROM meta_leads ORDER BY leadgen_id').all();
  assert.deepEqual(j.map((r) => [r.leadgen_id, r.status]), [['99', 'error']]);
  assert.match(j[0].error, /boom/);
  assert.equal(publicSettings(db).last_error, '', 'сломанная заявка — не ошибка опроса');
});

test('nextDelayMs — период из настроек в минутах, не меньше минуты', () => {
  const db = fresh();
  assert.equal(nextDelayMs(db), 2 * 60 * 1000);
  db.prepare('UPDATE meta_settings SET poll_minutes = 7 WHERE id = 1').run();
  assert.equal(nextDelayMs(db), 7 * 60 * 1000);
});
