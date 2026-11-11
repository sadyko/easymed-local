// PBX_END_CURSOR_V1 (2026-11-11, владелец: «recordings more than 3 minutes are
// not fetched») — длинный разговор onlinePBX не терялся бы, если бы журнал
// спрашивал станцию по ВРЕМЕНИ ОКОНЧАНИЯ звонка.
//
// Что было: курсор опроса — самое позднее НАЧАЛО звонка в журнале минус 2
// минуты, а станция показывает звонок только после того, как он закончился.
// Длинный звонок, во время которого кто-то другой позвонил и успел положить
// трубку, оказывался «до курсора» и в журнал не попадал никогда (на живой
// станции клиники 09–10.11: из звонков дольше 5 минут не пришли 21 из 25).
//
// Станция здесь поддельная, но ведёт себя как настоящая: звонок виден через
// несколько секунд после окончания (до минуты — по описанию API), запрос по
// окончанию — end_stamp_from/end_stamp_to; прежний запрос (число) — по началу.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { saveProvider, getProviderRow, providerCursor } from './providers.js';
import { pollOnce, recordCall } from './poller.js';
import { pbxHistoryByEnd, normalizePbxCall } from './onlinepbx.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const DAY = 86400;

function station(calls) {
  const st = { now: 0, asked: [] };
  st.impl = async (domain, win) => {
    st.asked.push(win);
    const visible = calls.filter((c) => (c.visibleAt ?? c.end + 5) <= st.now);
    const rows = typeof win === 'number'
      ? visible.filter((c) => c.start >= win)
      : visible.filter((c) => c.end >= win.endFrom && (win.endTo == null || c.end <= win.endTo));
    return { ok: true, data: rows.map((c) => ({
      uuid: c.uuid, accountcode: 'inbound', caller_id_number: c.phone || '998901112233', destination_number: '101',
      start_stamp: c.start, end_stamp: c.end, duration: c.end - c.start, user_talk_time: Math.max(1, c.end - c.start - 5),
      hangup_cause: 'NORMAL_CLEARING',
    })) };
  };
  return st;
}

const tick = (db, st) => pollOnce(db, {
  hasModule: () => true,
  pbxHistoryImpl: st.impl,
  now: () => st.now * 1000,
  fetchImpl: async () => { throw new Error('Binotel выключен — его не опрашиваем'); },
});
const ids = (db) => db.prepare('SELECT general_call_id FROM calls ORDER BY general_call_id').all().map((r) => r.general_call_id);
const leads = (db) => db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n;
const onlinePbx = (db) => saveProvider(db, { kind: 'onlinepbx', enabled: true, config: { domain: 'c.onpbx.ru' }, secret: { auth_key: 'A', key_id: 'I', key: 'K' } });

test('длинный звонок, пока шёл короткий, всё равно попадает в журнал', async () => {
  const db = fresh();
  onlinePbx(db);
  const T0 = Math.floor(Date.now() / 1000) - 3600;
  const st = station([
    { uuid: 'long', start: T0, end: T0 + 600, phone: '998901110001' },        // 10 минут разговора
    { uuid: 'short', start: T0 + 200, end: T0 + 230, phone: '998901110002' }, // позвонили и положили трубку во время длинного
  ]);
  st.now = T0 + 300;   // длинный ещё идёт — станция его не показывает
  await tick(db, st);
  assert.deepEqual(ids(db), ['onlinepbx:short']);
  st.now = T0 + 700;   // длинный закончился
  await tick(db, st);
  assert.deepEqual(ids(db), ['onlinepbx:long', 'onlinepbx:short'], 'длинный разговор не потерян');
});

test('курсор — по окончанию звонков, хранится у подключения, только вперёд; неудачный тик его не двигает', async () => {
  const db = fresh();
  const p = onlinePbx(db);
  const T0 = Math.floor(Date.now() / 1000) - 3600;
  const st = station([{ uuid: 'a', start: T0, end: T0 + 100 }]);
  st.now = T0 + 200;
  await tick(db, st);
  assert.equal(st.asked[0].endTo, null, 'живое окно открыто справа');
  assert.equal(st.asked[0].endFrom, st.now - DAY, 'новое подключение смотрит сутки назад, как раньше');
  const c1 = providerCursor(getProviderRow(db, p.id));
  assert.equal(c1.domain, 'c.onpbx.ru');
  assert.equal(c1.end_from, T0 + 100 - 120, 'следующий запрос — от окончания последнего звонка минус 2 минуты');

  await pollOnce(db, { hasModule: () => true, now: () => st.now * 1000, pbxHistoryImpl: async () => ({ ok: false, reason: 'offline' }) });
  assert.equal(getProviderRow(db, p.id).last_error, 'offline');
  assert.equal(providerCursor(getProviderRow(db, p.id)).end_from, T0 + 100 - 120, 'отказ станции курсор не трогает');

  st.now = T0 + 900;   // новых звонков нет — курсор стоит, назад не уходит
  await tick(db, st);
  assert.equal(st.asked.at(-1).endFrom, T0 + 100 - 120);
  assert.equal(providerCursor(getProviderRow(db, p.id)).end_from, T0 + 100 - 120);
  assert.equal(getProviderRow(db, p.id).last_error, '');
});

test('после обновления — разовый добор недели по дням; потерянные прежде звонки в журнале, но карточек CRM не заводят', async () => {
  const db = fresh();
  const p = onlinePbx(db);
  const NOW = Math.floor(Date.now() / 1000);
  // Подключение работало и до обновления: в журнале уже есть его звонок — до
  // этого места прежний опрос дошёл (полчаса назад: компьютер потом выключили).
  recordCall(db, normalizePbxCall({ uuid: 'old', accountcode: 'inbound', caller_id_number: '998901119999', destination_number: '101',
    start_stamp: NOW - 1800, duration: 20, user_talk_time: 15 }), 'poll', { id: p.id, kind: 'onlinepbx' });
  db.prepare('DELETE FROM crm_requests').run();
  const st = station([
    { uuid: 'lost-3d', start: NOW - 3 * DAY, end: NOW - 3 * DAY + 900, phone: '998901110003' },  // потерянные прежним опросом
    { uuid: 'lost-6d', start: NOW - 6 * DAY, end: NOW - 6 * DAY + 400, phone: '998901110006' },
    { uuid: 'lost-1h', start: NOW - 3600, end: NOW - 3000, phone: '998901110007' },
    // Звонок, пока компьютер был выключен: прежний опрос взял бы его при
    // включении и завёл карточку — новый тоже заводит.
    { uuid: 'while-off', start: NOW - 1000, end: NOW - 900, phone: '998901110009' },
    { uuid: 'next', start: NOW + 100, end: NOW + 400, phone: '998901110008' },                     // звонок уже после обновления
  ]);
  st.now = NOW;
  await tick(db, st);
  const first = st.asked[0];
  assert.ok(first.endFrom <= NOW - 6 * DAY - 400 && first.endFrom >= NOW - 7 * DAY, 'добор начинается неделей назад — столько станция отдаёт');
  assert.equal(first.endTo, first.endFrom + DAY, 'прошлое — кусками по суткам');
  for (let i = 0; i < 12 && st.asked.at(-1).endTo != null; i++) { st.now += 30; await tick(db, st); }
  assert.equal(st.asked.at(-1).endTo, null, 'добор дошёл до живого окна');
  assert.deepEqual(ids(db), ['onlinepbx:lost-1h', 'onlinepbx:lost-3d', 'onlinepbx:lost-6d', 'onlinepbx:old', 'onlinepbx:while-off']);
  const leadPhones = () => db.prepare('SELECT phone FROM crm_requests ORDER BY id').all().map((r) => String(r.phone).replace(/\D/g, ''));
  assert.deepEqual(leadPhones(), ['998901110009'], 'потерянные прошлые звонки — история; звонок после места, где остановился прежний опрос, — обращение, как раньше');

  st.now = NOW + 500;
  await tick(db, st);
  assert.ok(ids(db).includes('onlinepbx:next'));
  assert.equal(leads(db), 2, 'новый звонок после добора заводит карточку, как всегда');
  assert.equal(providerCursor(getProviderRow(db, p.id)).catchup_until, undefined, 'отметка добора снята, когда он закончился');
});

test('новое подключение: сутки назад и карточки CRM — как было', async () => {
  const db = fresh();
  onlinePbx(db);
  const NOW = Math.floor(Date.now() / 1000);
  const st = station([{ uuid: 'today', start: NOW - 3600, end: NOW - 3500, phone: '998901110010' }]);
  st.now = NOW;
  await tick(db, st);
  assert.deepEqual(ids(db), ['onlinepbx:today']);
  assert.equal(leads(db), 1);
});

test('другая станция в том же подключении — курсор прежней не используется', async () => {
  const db = fresh();
  const p = onlinePbx(db);
  const NOW = Math.floor(Date.now() / 1000);
  const st = station([]);
  st.now = NOW;
  await tick(db, st);
  saveProvider(db, { id: p.id, config: { domain: 'other.onpbx.ru' } });
  st.now = NOW + 30;
  await tick(db, st);
  assert.equal(st.asked.at(-1).endFrom, NOW + 30 - DAY, 'новая станция — как новое подключение');
  assert.equal(providerCursor(getProviderRow(db, p.id)).domain, 'other.onpbx.ru');
});

test('recordCall { lead: false } — строка в журнале без карточки; по умолчанию карточка как раньше', () => {
  const db = fresh();
  const p = onlinePbx(db);
  const call = (uuid, phone) => normalizePbxCall({ uuid, accountcode: 'inbound', caller_id_number: phone, destination_number: '101',
    start_stamp: Math.floor(Date.now() / 1000) - 60, duration: 40, user_talk_time: 30 });
  assert.equal(recordCall(db, call('q', '998901110020'), 'poll', { id: p.id, kind: 'onlinepbx' }, { lead: false }), true);
  assert.equal(leads(db), 0);
  assert.equal(recordCall(db, call('l', '998901110021'), 'poll', { id: p.id, kind: 'onlinepbx' }), true);
  assert.equal(leads(db), 1);
});

test('pbxHistoryByEnd: спрашивает по окончанию, окно не старше недели, без start_stamp', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(new URLSearchParams(init.body)); return new Response(JSON.stringify({ status: '1', data: [] }), { status: 200 }); };
  const o = { creds: { key_id: 'a', key: 'b' }, fetchImpl };
  const now = Math.floor(Date.now() / 1000);
  await pbxHistoryByEnd('clinic.onpbx.ru', { endFrom: now - 3600 }, o);
  assert.equal(Number(bodies[0].get('end_stamp_from')), now - 3600);
  assert.equal(bodies[0].has('end_stamp_to'), false);
  assert.equal(bodies[0].has('start_stamp_from'), false);
  await pbxHistoryByEnd('clinic.onpbx.ru', { endFrom: 1, endTo: 1 + DAY }, o);
  const from = Number(bodies[1].get('end_stamp_from'));
  assert.ok(from >= now - 7 * DAY, 'старше недели станция не отдаёт — окно подрезано');
  assert.ok(Number(bodies[1].get('end_stamp_to')) >= from, 'конец окна не раньше начала');
});
