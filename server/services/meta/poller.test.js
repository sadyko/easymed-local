// META_LEADS_V1_POLL — опрос Graph API: раз в период, пока включено и модуль CRM
// в лицензии, для каждой выбранной формы читаются заявки новее курсора; каждая
// новая — в журнал и в CRM. FIX_318_V1 (H1) — курсор у КАЖДОЙ формы свой и
// двигается только удачей этой формы (с перекрытием 10 минут); режим «все
// формы» перечитывает формы страницы каждый проход — новая форма опрашивается
// сразу и с начала. Отказ сети — слово в last_error и следующий проход;
// недействительный токен выключает опрос. Сам проход никогда не бросает.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { pollOnce, nextDelayMs, CURSOR_OVERLAP_S } from './poller.js';
import { storeConnection, saveSettings, publicSettings, readFormCursors, rewindSince, clearToken, recordPoll } from './settings.js';
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

/**
 * Подмена Graph: ответ по пути формы; запоминает запросы (путь, токен, фильтр).
 * FIX_318_V1 (H1) — в режиме «все формы» опрос каждый проход перечитывает формы
 * страницы (/777/leadgen_forms); без своего ответа страница отдаёт FORMS.
 */
function graphStub(byForm, seen = []) {
  return async (url) => {
    const u = new URL(String(url));
    const p = u.pathname.replace('/' + GRAPH_VERSION + '/', '');
    let filtering = null;
    try { filtering = JSON.parse(u.searchParams.get('filtering')); } catch { /* нет фильтра */ }
    seen.push({ path: p, token: u.searchParams.get('access_token'), filtering, fields: u.searchParams.get('fields') });
    const r = byForm[p] || (p === '777/leadgen_forms' ? { data: FORMS } : null);
    if (!r) return res({ error: { code: 803, message: 'unknown ' + p } }, 400);
    return typeof r === 'function' ? r(u) : res(r);
  };
}
const leadPaths = (seen) => seen.map((x) => x.path).filter((p) => p.endsWith('/leads'));
const ts = (iso) => Math.floor(Date.parse(iso) / 1000);

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

test('проход: каждая форма — токеном страницы и фильтром по курсору; новые заявки — в CRM и журнал; курсор формы — на её самую свежую', async () => {
  const db = fresh(); const o = kek(); const seen = [];
  const fetchImpl = graphStub({
    'f1/leads': { data: [lead('11', '2026-10-16T09:00:00+0000', '+998901111111'), lead('12', '2026-10-16T09:30:00+0000', '+998902222222')] },
    'f2/leads': { data: [lead('21', '2026-10-16T10:00:00+0000', '+998903333333')] },
  }, seen);
  ready(db, o);
  await pollOnce(db, { fetchImpl, hasModule: () => true, ...o });
  assert.deepEqual(leadPaths(seen).sort(), ['f1/leads', 'f2/leads']);
  assert.equal(seen[0].path, '777/leadgen_forms', 'режим «все»: сначала — формы страницы, как они есть сейчас');
  assert.equal(seen[0].token, PAGE_TOKEN);
  for (const x of seen.filter((s) => s.path.endsWith('/leads'))) {
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
  // FIX_318_V1 (H1) — общий since_ts — нижняя граница «забирать с», опрос его не двигает;
  // у каждой формы — своя отметка.
  assert.equal(s.since_ts, 1760000000);
  assert.deepEqual(Object.fromEntries(readFormCursors(db)), { f1: ts('2026-10-16T09:30:00+0000'), f2: ts('2026-10-16T10:00:00+0000') });
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
  assert.deepEqual(seen.map((x) => [x.path, x.token]), [['f2/leads', TOKEN]], '«выбранные» — список из настроек, формы страницы не перечитываются');
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
  assert.equal(s.since_ts, 1760000000);
  // FIX_318_V1 (H1) — отметка отказавшей формы стоит, удачная форма свою двигает.
  assert.deepEqual(Object.fromEntries(readFormCursors(db)), { f2: ts('2026-10-16T10:00:00+0000') });
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

// ---------------------------------------------------------------------------
// FIX_318_V1 (H1) — ревью 3.18.0, повтор R1: форма, созданная после
// подключения, в режиме «все» не опрашивалась вовсе, а её заявки, старше
// общего курсора, терялись навсегда. Подмена Graph здесь честно выполняет
// фильтр GREATER_THAN, как настоящий.
// ---------------------------------------------------------------------------
function honestGraph(pages, leadsOf, seen = []) {
  return async (url) => {
    const u = new URL(String(url));
    const p = u.pathname.replace('/' + GRAPH_VERSION + '/', '');
    let filtering = null;
    try { filtering = JSON.parse(u.searchParams.get('filtering')); } catch { /* нет фильтра */ }
    seen.push({ path: p, after: u.searchParams.get('after'), filtering });
    if (p.endsWith('/leadgen_forms')) {
      const list = pages[p.split('/')[0]];
      if (!list) return res({ error: { code: 803, message: 'unknown ' + p } }, 400);
      return res(typeof list === 'function' ? list(u) : list);
    }
    const form = p.split('/')[0];
    const since = filtering ? filtering[0].value : 0;
    return res({ data: (leadsOf[form] || []).filter((l) => ts(l.created_time) > since) });
  };
}

test('H1: режим «все» — форма, созданная после подключения, опрашивается со следующего прохода, и её ранние заявки не теряются за отметкой другой формы', async () => {
  const db = fresh(); const o = kek(); const seen = [];
  storeConnection(db, { token: TOKEN, pageToken: PAGE_TOKEN, page: { id: '7', name: 'P' }, forms: [{ id: 'f1', name: 'Старая' }] }, o);
  saveSettings(db, { enabled: true }, 1);
  db.prepare('UPDATE meta_settings SET since_ts = 1760000000 WHERE id = 1').run();
  assert.equal(publicSettings(db).forms_mode, 'all');
  const leadsOf = {
    f1: [{ ...lead('L-old', '2026-10-20T10:00:00+0000', '+998900000001'), form_id: 'f1' }],
    f2: [{ ...lead('L-new', '2026-10-20T09:00:00+0000', '+998900000002'), form_id: 'f2' }],   // РАНЬШЕ заявки старой формы
  };
  const pages = { 7: { data: [{ id: 'f1', name: 'Старая' }, { id: 'f2', name: 'Новая', status: 'ACTIVE', leads_count: 1 }] } };
  await pollOnce(db, { fetchImpl: honestGraph(pages, leadsOf, seen), hasModule: () => true, ...o });
  assert.deepEqual(seen.map((x) => x.path), ['7/leadgen_forms', 'f1/leads', 'f2/leads'], 'новая форма страницы опрошена без «Проверить связь»');
  const got = db.prepare('SELECT leadgen_id, form_name FROM meta_leads ORDER BY leadgen_id').all();
  assert.deepEqual(got.map((r) => [r.leadgen_id, r.form_name]), [['L-new', 'Новая'], ['L-old', 'Старая']]);
  assert.equal(publicSettings(db).last_error, '');
  assert.deepEqual(publicSettings(db).forms.map((f) => [f.id, f.name, f.selected]), [['f1', 'Старая', true], ['f2', 'Новая', true]],
    'список форм на экране тоже знает новую форму');
});

test('H1: у каждой формы своя отметка, следующий проход просит «новее отметки минус 10 минут»; повтор заявок в перекрытии — без вторых карточек', async () => {
  const db = fresh(); const o = kek(); const seen = [];
  ready(db, o);
  const leadsOf = {
    f1: [lead('a1', '2026-10-16T09:00:00+0000', '+998901111111')],
    f2: [{ ...lead('b1', '2026-10-16T11:00:00+0000', '+998902222222'), form_id: 'f2' }],
  };
  const pages = { 777: { data: FORMS } };
  await pollOnce(db, { fetchImpl: honestGraph(pages, leadsOf), hasModule: () => true, ...o });
  assert.equal(CURSOR_OVERLAP_S, 600);
  // Заявка, которую Meta показала с опозданием: создана за 5 минут до отметки f1.
  leadsOf.f1.push(lead('a0', '2026-10-16T08:55:00+0000', '+998903333333'));
  await pollOnce(db, { fetchImpl: honestGraph(pages, leadsOf, seen), hasModule: () => true, ...o });
  const asked = Object.fromEntries(seen.filter((x) => x.path.endsWith('/leads')).map((x) => [x.path, x.filtering[0].value]));
  assert.deepEqual(asked, { 'f1/leads': ts('2026-10-16T09:00:00+0000') - 600, 'f2/leads': ts('2026-10-16T11:00:00+0000') - 600 });
  assert.deepEqual(db.prepare('SELECT leadgen_id FROM meta_leads ORDER BY leadgen_id').all().map((r) => r.leadgen_id), ['a0', 'a1', 'b1'],
    'опоздавшая заявка подшита, повторы — нет');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 3);
});

test('H1 + L3: формы страницы читаются по всем страницам ответа (больше 100)', async () => {
  const db = fresh(); const o = kek(); const seen = [];
  ready(db, o);
  const pages = {
    777: (u) => (u.searchParams.get('after') === 'p2'
      ? { data: [{ id: 'f2', name: 'УЗИ' }, { id: 'f3', name: 'Анализы' }] }
      : { data: [{ id: 'f1', name: 'Консультация' }], paging: { next: `https://graph.facebook.com/${GRAPH_VERSION}/777/leadgen_forms?after=p2&access_token=${PAGE_TOKEN}` } }),
  };
  await pollOnce(db, { fetchImpl: honestGraph(pages, {}, seen), hasModule: () => true, ...o });
  assert.deepEqual(leadPaths(seen), ['f1/leads', 'f2/leads', 'f3/leads']);
  assert.deepEqual(publicSettings(db).forms.map((f) => f.id), ['f1', 'f2', 'f3']);
});

test('H1: формы страницы не прочитались (не токен) — известные формы всё равно опрошены, причина на экране; недействительный токен — стоп', async () => {
  const db = fresh(); const o = kek(); const seen = [];
  ready(db, o);
  const leadsOf = { f1: [lead('11', '2026-10-16T09:00:00+0000', '+998901111111')] };
  await pollOnce(db, { fetchImpl: honestGraph({ 777: () => ({ error: { code: 4, message: 'rate' } }) }, leadsOf, seen), hasModule: () => true, ...o });
  assert.deepEqual(leadPaths(seen), ['f1/leads', 'f2/leads']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_leads').get().n, 1);
  assert.equal(publicSettings(db).last_error, 'rate_limited');
  assert.deepEqual(Object.fromEntries(readFormCursors(db)), { f1: ts('2026-10-16T09:00:00+0000') }, 'удачные формы свои отметки двигают');
});

test('H1: «Забрать заявки за последние N дней» опускает отметки форм; «Удалить токен» их стирает', async () => {
  const db = fresh(); const o = kek();
  ready(db, o);
  await pollOnce(db, { fetchImpl: honestGraph({ 777: { data: FORMS } }, { f1: [lead('11', new Date().toISOString().replace(/\.\d{3}Z$/, '+0000'), '+998901111111')] }), hasModule: () => true, ...o });
  const before = readFormCursors(db).get('f1');
  assert.ok(before > 1760000000);
  const t = rewindSince(db, 3);
  assert.ok(readFormCursors(db).get('f1') <= t, 'отметка формы — не позже «3 дня назад»');
  assert.ok(publicSettings(db).since_ts <= t, 'и нижняя граница новых форм');
  clearToken(db, 1);
  assert.equal(readFormCursors(db).size, 0);
});

test('L3: недействительный токен выключил опрос — проверенный новый токен включает его обратно; выключенный человеком — остаётся выключенным', async () => {
  const db = fresh(); const o = kek();
  ready(db, o);
  recordPoll(db, { ok: false, error: 'bad_token' });
  assert.deepEqual([publicSettings(db).enabled, publicSettings(db).last_error], [false, 'bad_token']);
  storeConnection(db, { token: 'EAAGTESTONLYnewToken003', pageToken: PAGE_TOKEN, page: { id: '777', name: 'P' }, forms: FORMS }, o);
  assert.deepEqual([publicSettings(db).enabled, publicSettings(db).last_error], [true, ''], 'выключил опрос сам — сам и включает');
  saveSettings(db, { enabled: false }, 1);
  storeConnection(db, { token: 'EAAGTESTONLYnewToken004', pageToken: PAGE_TOKEN, page: { id: '777', name: 'P' }, forms: FORMS }, o);
  assert.equal(publicSettings(db).enabled, false, 'решение человека «выключить» токен не отменяет');
});
