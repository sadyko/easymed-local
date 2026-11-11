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
// Станция здесь поддельная, но ведёт себя как настоящая: звонок виден после
// окончания с задержкой (по описанию API — до минуты), запрос по окончанию —
// end_stamp_from/end_stamp_to; прежний запрос (число) — по началу. Часы
// станции — st.now; часы сервера — st.now + st.skew.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { saveProvider, getProviderRow, providerCursor } from './providers.js';
import { pollOnce, recordCall, PBX_CATCHUP_SEC, PBX_CATCHUP_MAX_TRIES } from './poller.js';
import { pbxHistoryByEnd, normalizePbxCall } from './onlinepbx.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const DAY = 86400;

function station(calls, { delay = 5, fail = () => false } = {}) {
  const st = { now: 0, skew: 0, asked: [] };
  st.impl = async (domain, win) => {
    st.asked.push(win);
    if (fail(win, st)) return { ok: false, reason: 'bad_response' };
    const visible = calls.filter((c) => (c.visibleAt ?? c.end + delay) <= st.now);
    const rows = typeof win === 'number'
      ? visible.filter((c) => c.start >= win)
      : visible.filter((c) => c.end >= win.endFrom && (win.endTo == null || c.end <= win.endTo));
    return { ok: true, data: rows.map((c) => ({
      uuid: c.uuid, accountcode: 'inbound', caller_id_number: c.phone || '998901112233', destination_number: '101',
      start_stamp: c.start, end_stamp: c.endStamp ?? c.end, duration: c.end - c.start,
      user_talk_time: c.missed ? 0 : Math.max(1, c.end - c.start - 5), hangup_cause: c.missed ? 'ORIGINATOR_CANCEL' : 'NORMAL_CLEARING',
    })) };
  };
  return st;
}

const tick = (db, st) => pollOnce(db, {
  hasModule: () => true,
  pbxHistoryImpl: st.impl,
  now: () => (st.now + st.skew) * 1000,
  fetchImpl: async () => { throw new Error('Binotel выключен — его не опрашиваем'); },
});
const ids = (db) => db.prepare('SELECT general_call_id FROM calls ORDER BY general_call_id').all().map((r) => r.general_call_id);
const leads = (db) => db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n;
const leadPhones = (db) => db.prepare('SELECT phone FROM crm_requests').all().map((r) => String(r.phone).replace(/\D/g, '')).sort();
const onlinePbx = (db, domain = 'c.onpbx.ru') => saveProvider(db, { kind: 'onlinepbx', enabled: true, config: { domain }, secret: { auth_key: 'A', key_id: 'I', key: 'K' } });
// Подключение, работавшее до обновления: в журнале его звонок, начавшийся в `start`.
const hadCall = (db, p, start) => {
  recordCall(db, normalizePbxCall({ uuid: 'old', accountcode: 'inbound', caller_id_number: '998901119999', destination_number: '101',
    start_stamp: start, duration: 20, user_talk_time: 15 }), 'poll', { id: p.id, kind: 'onlinepbx' });
  db.prepare('DELETE FROM crm_requests').run();
};

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

test('минутная задержка станции: звонок, показанный позже соседа, закончившегося позже, не теряется', async () => {
  const db = fresh();
  onlinePbx(db);
  const T0 = Math.floor(Date.now() / 1000) - 3600;
  const st = station([
    { uuid: 'late', start: T0, end: T0 + 300, visibleAt: T0 + 360, phone: '998901110031' },     // закончился первым, показан через минуту
    { uuid: 'quick', start: T0 + 250, end: T0 + 320, visibleAt: T0 + 325, phone: '998901110032' },
  ]);
  st.now = T0 + 330;
  await tick(db, st);
  assert.deepEqual(ids(db), ['onlinepbx:quick']);
  st.now = T0 + 400;
  await tick(db, st);
  assert.deepEqual(ids(db), ['onlinepbx:late', 'onlinepbx:quick']);
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
  assert.equal(st.asked.length, 1, 'у нового подключения добора нет');
  const c1 = providerCursor(getProviderRow(db, p.id));
  assert.deepEqual(c1, { domain: 'c.onpbx.ru', end_from: T0 + 100 - 120 }, 'следующий запрос — от окончания последнего звонка минус 2 минуты');

  await pollOnce(db, { hasModule: () => true, now: () => st.now * 1000, pbxHistoryImpl: async () => ({ ok: false, reason: 'offline' }) });
  assert.equal(getProviderRow(db, p.id).last_error, 'offline');
  assert.equal(providerCursor(getProviderRow(db, p.id)).end_from, T0 + 100 - 120, 'отказ станции курсор не трогает');

  st.now = T0 + 900;   // новых звонков нет — курсор стоит, назад не уходит
  await tick(db, st);
  assert.equal(st.asked.at(-1).endFrom, T0 + 100 - 120);
  assert.equal(providerCursor(getProviderRow(db, p.id)).end_from, T0 + 100 - 120);
  assert.equal(getProviderRow(db, p.id).last_error, '');
});

test('часы компьютера спешат на полчаса или линия молчит сутки — звонки не теряются', async () => {
  const db = fresh();
  onlinePbx(db);
  const T0 = Math.floor(Date.now() / 1000) - 3 * DAY;
  const calls = [];
  for (let i = 0; i < 20; i++) calls.push({ uuid: 'c' + String(i).padStart(2, '0'), start: T0 + i * 600, end: T0 + i * 600 + 400 });
  calls.push({ uuid: 'after-quiet-day', start: T0 + 2 * DAY, end: T0 + 2 * DAY + 900 });
  const st = station(calls);
  st.skew = 1800;
  for (st.now = T0; st.now <= T0 + 2 * DAY + 1200; st.now += 300) {
    if (st.now > T0 + 12600 && st.now < T0 + 2 * DAY - 600) st.now = T0 + 2 * DAY - 600;   // сутки тишины — один длинный перерыв
    await tick(db, st);
  }
  assert.equal(ids(db).length, 21, 'все 21 звонок в журнале');
});

test('после обновления — разовый добор: потерянные прежним опросом звонки возвращаются, старше суток — без карточек CRM', async () => {
  const db = fresh();
  const p = onlinePbx(db);
  const NOW = Math.floor(Date.now() / 1000);
  hadCall(db, p, NOW - 1800);   // прежний опрос дошёл до звонка, начавшегося полчаса назад
  const st = station([
    { uuid: 'lost-3d', start: NOW - 3 * DAY, end: NOW - 3 * DAY + 900, phone: '998901110003' },     // потерянные прежним опросом
    { uuid: 'lost-5d', start: NOW - 5 * DAY, end: NOW - 5 * DAY + 400, phone: '998901110005' },
    { uuid: 'lost-2h-missed', start: NOW - 7200, end: NOW - 6900, missed: true, phone: '998901110007' },  // за последние сутки: «Перезвонить»
    { uuid: 'straddle', start: NOW - 2400, end: NOW - 1500, phone: '998901110010' },                   // начался до места остановки, кончился после
    { uuid: 'while-off', start: NOW - 1000, end: NOW - 900, phone: '998901110009' },                   // пока компьютер был выключен
    { uuid: 'next', start: NOW + 100, end: NOW + 400, phone: '998901110008' },                         // уже после обновления
  ]);
  st.now = NOW;
  await tick(db, st);
  assert.equal(st.asked.length, 2, 'живой опрос и добор — два отдельных запроса');
  assert.deepEqual(st.asked[0], { endFrom: NOW - 1800 - 120, endTo: null }, 'живой опрос — с места, где остановился прежний');
  assert.deepEqual(st.asked[1], { endFrom: NOW - PBX_CATCHUP_SEC, endTo: NOW - 1800 }, 'добор — 6 дней до того места');
  assert.deepEqual(ids(db), ['onlinepbx:lost-2h-missed', 'onlinepbx:lost-3d', 'onlinepbx:lost-5d', 'onlinepbx:old', 'onlinepbx:straddle', 'onlinepbx:while-off']);
  assert.deepEqual(leadPhones(db), ['998901110007', '998901110009', '998901110010'],
    'старше суток — история; свежие пропущенный, длинный и «пока выключен» — обращения, как раньше');
  assert.equal(providerCursor(getProviderRow(db, p.id)).catchup, undefined, 'добор удался — отметки нет');

  st.now = NOW + 500;
  await tick(db, st);
  assert.equal(st.asked.length, 3, 'добор больше не спрашивается');
  assert.ok(ids(db).includes('onlinepbx:next'));
  assert.equal(leads(db), 4, 'новый звонок после добора заводит карточку, как всегда');
});

test('добор, который станция не отдаёт, не держит живой журнал и после попыток оставляется', async () => {
  const db = fresh();
  const p = onlinePbx(db);
  const NOW = Math.floor(Date.now() / 1000);
  hadCall(db, p, NOW - 1800);
  const st = station([
    { uuid: 'lost-3d', start: NOW - 3 * DAY, end: NOW - 3 * DAY + 900 },
    { uuid: 'live', start: NOW + 10, end: NOW + 60, phone: '998901110040' },
  ], { fail: (win) => win.endTo != null });
  st.now = NOW + 100;
  await tick(db, st);
  assert.ok(ids(db).includes('onlinepbx:live'), 'живой звонок пришёл, хотя добор отказал');
  assert.equal(getProviderRow(db, p.id).last_error, '', 'отказ добора — не ошибка подключения');
  assert.equal(providerCursor(getProviderRow(db, p.id)).catchup.tries, 1);
  for (let i = 1; i < PBX_CATCHUP_MAX_TRIES; i++) { st.now += 30; await tick(db, st); }
  assert.equal(providerCursor(getProviderRow(db, p.id)).catchup, undefined, 'после попыток добор оставлен');
  const asked = st.asked.length;
  st.now += 30;
  await tick(db, st);
  assert.equal(st.asked.length, asked + 1, 'дальше — только живой опрос');
  assert.equal(ids(db).includes('onlinepbx:lost-3d'), false);
});

test('время окончания из будущего (миллисекунды) не запирает курсор', async () => {
  const db = fresh();
  const p = onlinePbx(db);
  const T0 = Math.floor(Date.now() / 1000) - 3600;
  const st = station([
    { uuid: 'bad', start: T0, end: T0 + 50, endStamp: (T0 + 50) * 1000 },
    { uuid: 'good', start: T0 + 400, end: T0 + 500 },
  ]);
  st.now = T0 + 100;
  await tick(db, st);
  assert.ok(providerCursor(getProviderRow(db, p.id)).end_from < T0 + DAY);
  st.now = T0 + 600;
  await tick(db, st);
  assert.ok(ids(db).includes('onlinepbx:good'));
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

test('курсор другой станции не используется: подключение без звонков начинает как новое', async () => {
  const db = fresh();
  const p = onlinePbx(db);
  const NOW = Math.floor(Date.now() / 1000);
  const st = station([]);
  st.now = NOW;
  await tick(db, st);
  saveProvider(db, { id: p.id, config: { domain: 'other.onpbx.ru' } });
  st.now = NOW + 30;
  await tick(db, st);
  assert.equal(st.asked.at(-1).endFrom, NOW + 30 - DAY);
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
