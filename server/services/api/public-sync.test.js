// PUBLIC_API_V1 — обмен с публичным сервером (поддельным, в процессе): молчит,
// пока Easy-Med не включил сервер (в лицензии нет отпечатка ключа клиники);
// каждый запрос подписан и несёт лицензию; ключи, снимок, файлы и время уходят,
// когда изменились; заявка из очереди — удержание и карточка, курсор
// подтверждён; события уходят по порядку; нет связи и отказ сервера — не
// бросает, ничего не теряет; адрес по умолчанию — api.easymed.uz. Решения
// владельца 17 и 19 (2026-10-11): лицензия уходит байт в байт (отметку оплаты
// видит сервер); срок держания клиника назначает при приёме и сообщает серверу.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bookingSeed, localAt } from '../../test-helpers/api-booking-seed.js';
import { fakePublicServer } from '../../test-helpers/fake-public-server.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { loadSyncIdentity, SYNC_KEY_FILE } from './sync-identity.js';
import { syncOnce, syncStatus, publicBaseUrl, assertPublicUrlIsTestSafe, DEFAULT_PUBLIC_URL, keyCodeOf, ringRelayStatus } from './public-sync.js';
import { confirmBooking } from './bookings.js';
import { deleteConnection } from './connections.js';   // FIX_318_V1 (C3)
import { seed } from '../../test-helpers/api-connections-seed.js';   // FIX_318_V1 (C3)
import { isoOf } from '../../../public/js/shared/api-booking.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');

function rig({ enabled = true, extra = {}, api = true } = {}) {
  const s = api ? bookingSeed() : seed();   // FIX_318_V1 (C3): api: false — клиника без имени в адресе и подключений
  const dataDir = tmpDir('em-psync-');
  const keyPath = path.join(dataDir, SYNC_KEY_FILE);
  const identity = loadSyncIdentity({ keyPath, create: true });
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({ clinic_id: 'c-000777', install_token: 'TESTONLY' }));
  const payload = { clinic_id: 'c-000777', valid_until: '2030-04-01T00:00:00Z', modules: [], ...extra, ...(enabled ? { api_sync_key: identity.fingerprint } : {}) };
  fs.writeFileSync(path.join(dataDir, 'licence.dat'), JSON.stringify({ payload, sig: 'AAAA' }));
  const fake = fakePublicServer({ signPublic: identity.signPublic });
  let clock = NOW;
  const opts = { fetchImpl: fake.fetchImpl, env: fake.env, now: () => clock, keyPath, kekPath: s.kekPath, storageDir: path.join(dataDir, 'storage') };
  return { ...s, dataDir, keyPath, identity, fake, opts, tick: (ms) => { clock += ms; } };
}
const appt = (r, over = {}) => r.fake.enqueue({
  type: 'appointment.new', public_id: 'rq_sync0001', connection_id: r.connId, received_at: new Date(NOW - 30000).toISOString(),
  data: { external_id: 'med-55', doctor_id: 7, consultation: 'initial', start: new Date(START).toISOString(), lang: 'ru' }, ...over,
}, { name: 'Абдурахмонов Фаррух', phone: '+998901234567', comment: 'Ребёнок 5 лет' });

test('пока Easy-Med не включил публичный сервер — ни одного запроса в сеть; экран говорит «ждём включения»', async () => {
  const r = rig({ enabled: false });
  const out = await syncOnce(r.db, r.dataDir, r.opts);
  assert.deepEqual(out, { ok: false, reason: 'not_enabled' });
  assert.deepEqual(r.fake.state.calls, []);
  assert.equal(syncStatus(r.db, r.dataDir, { keyPath: r.keyPath }).state, 'waiting_vendor');
});

test('первый такт: ключи (с ключом-ящиком), файлы, снимок, время — подписаны, с лицензией; повтор без изменений молчит', async () => {
  const r = rig();
  const out = await syncOnce(r.db, r.dataDir, r.opts);
  assert.equal(out.ok, true);
  assert.deepEqual(r.fake.state.calls, ['PUT /_sync/v1/keys', 'PUT /_sync/v1/snapshot', 'GET /_sync/v1/inbox', 'PUT /_sync/v1/slots']);
  assert.equal(r.fake.state.keys[0].box_key, r.identity.boxPublic);
  assert.equal(r.fake.state.snapshots[0].slug, 'shifo');
  assert.deepEqual(r.fake.state.snapshots[0].doctors.map((d) => d.id), [7, 8]);
  assert.ok(r.fake.state.licences.every((l) => l.includes('c-000777')));
  assert.equal(syncStatus(r.db, r.dataDir, { keyPath: r.keyPath }).state, 'ok');
  r.fake.state.calls.length = 0;
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.deepEqual(r.fake.state.calls, ['GET /_sync/v1/inbox'], 'ничего не изменилось — только сбор заявок');
});

test('выключили подключение — ключи уходят в ближайший такт (быстрый канал); время — раз в минуту и только изменившееся', async () => {
  const r = rig();
  r.tick(60000);   // 09:01 — дальше в тесте ни одно окно сегодняшнего дня не становится прошедшим
  await syncOnce(r.db, r.dataDir, r.opts);
  r.db.prepare('UPDATE api_connections SET active = 0 WHERE id = ?').run(r.connId);
  r.fake.state.calls.length = 0;
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.deepEqual(r.fake.state.calls, ['PUT /_sync/v1/keys', 'GET /_sync/v1/inbox']);
  assert.equal(r.fake.state.keys.at(-1).connections.find((c) => c.id === r.connId).active, false);
  r.fake.state.calls.length = 0;
  r.tick(60000);
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.deepEqual(r.fake.state.calls, ['GET /_sync/v1/inbox'], 'время не изменилось — не шлём, хоть минута и прошла');
  r.fake.state.calls.length = 0;
  r.tick(14 * 60000);   // 09:16 — окно 09:15 прошло: время изменилось; 15 минут — ключи и снимок повторяются для свежести
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.deepEqual(r.fake.state.calls, ['PUT /_sync/v1/keys', 'PUT /_sync/v1/snapshot', 'GET /_sync/v1/inbox', 'PUT /_sync/v1/slots']);
});

test('заявка из очереди: вскрыта ключом клиники — удержание и карточка; курсор подтверждён; время отправлено сразу', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  appt(r);
  r.fake.state.calls.length = 0;
  r.tick(5000);
  const out = await syncOnce(r.db, r.dataDir, r.opts);
  assert.equal(out.applied, 1);
  assert.deepEqual(r.fake.state.calls, ['GET /_sync/v1/inbox', 'POST /_sync/v1/inbox/ack', 'PUT /_sync/v1/slots']);
  const req = r.db.prepare('SELECT * FROM api_requests').get();
  assert.deepEqual([req.status, req.patient_name, req.patient_phone], ['pending', 'Абдурахмонов Фаррух', '+998901234567']);
  assert.deepEqual(r.fake.state.acks, [1]);
  assert.deepEqual(r.fake.state.held, [{ request_id: 'rq_sync0001', hold_until: isoOf(NOW + 5000 + 30 * 60000) }],
    'решение 19: срок держания назначен клиникой при приёме (а не при отправке партнёром) и сообщён серверу');
  const day = r.fake.state.slots.at(-1).doctors[7].days.find((d) => d.date === '2030-03-12');
  assert.equal(day.free[day.starts.indexOf('10:00')], '0', 'партнёры видят время занятым сразу');
  r.fake.state.calls.length = 0;
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM api_requests').get().n, 1, 'подтверждённый курсор — второй раз не принимаем');
});

test('подтверждение регистратором — событие уходит в следующий такт, подписанное секретом подключения; принятые не повторяются', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  appt(r);
  await syncOnce(r.db, r.dataDir, r.opts);
  r.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const id = r.db.prepare('SELECT id FROM api_requests').get().id;
  await confirmBooking(r.db, { id, patientId: 1 }, r.reg, { now: NOW + 60000, kekPath: r.kekPath });
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  const ev = r.fake.state.events.find((e) => e.event === 'booking.confirmed');
  assert.ok(ev && ev.signature.startsWith('sha256=') && ev.webhook_url === 'https://med24.uz/hooks');
  assert.equal(JSON.parse(ev.body).status, 'booked');
  assert.ok(!ev.body.includes('Абдурахмонов'));
  const n = r.fake.state.events.length;
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.equal(r.fake.state.events.length, n);
});

test('нет связи и отказ сервера: не бросает, итог записан, события ждут; 503 — «приостановлено»', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  appt(r);
  await syncOnce(r.db, r.dataDir, r.opts);
  r.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  await confirmBooking(r.db, { id: r.db.prepare('SELECT id FROM api_requests').get().id, patientId: 1 }, r.reg, { now: NOW + 60000, kekPath: r.kekPath });
  r.fake.state.offline = true;
  r.tick(15000);
  assert.deepEqual(await syncOnce(r.db, r.dataDir, r.opts), { ok: false, reason: 'offline' });
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM api_outbox WHERE sent_at IS NULL').get().n, 1);
  const st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.deepEqual([st.state, st.last_error, st.pending_events], ['error', 'offline', 1]);
  r.fake.state.offline = false;
  r.fake.state.refuse = { status: 503, body: { error: { code: 'licence_lapsed' } } };
  r.tick(15000);
  assert.deepEqual(await syncOnce(r.db, r.dataDir, r.opts), { ok: false, reason: 'paused' });
  r.fake.state.refuse = null;
  r.tick(15000);
  assert.equal((await syncOnce(r.db, r.dataDir, r.opts)).ok, true);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM api_outbox WHERE sent_at IS NULL').get().n, 0);
});

test('чужая подпись — сервер отвечает 401, обмен называет это «unauthorized»; адрес — api.easymed.uz; тест без подставного fetch не уходит в сеть', async () => {
  const r = rig();
  const other = loadSyncIdentity({ keyPath: path.join(tmpDir('em-psync-other-'), SYNC_KEY_FILE), create: true });
  const stranger = fakePublicServer({ signPublic: other.signPublic });
  assert.deepEqual(await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl: stranger.fetchImpl }), { ok: false, reason: 'unauthorized' });
  assert.equal(DEFAULT_PUBLIC_URL, 'https://api.easymed.uz');
  assert.equal(publicBaseUrl({}), 'https://api.easymed.uz');
  assert.throws(() => assertPublicUrlIsTestSafe({}, globalThis.fetch), /refusing to reach/);
  assert.doesNotThrow(() => assertPublicUrlIsTestSafe({}, async () => {}));
});

test('решение 17: лицензия уходит в каждом запросе байт в байт — отметку оплаты, вписанную сервером лицензий (8c), публичный сервер видит; своего правила у клиники нет', async () => {
  const r = rig({ extra: { subscription: 'unpaid' } });
  const raw = fs.readFileSync(path.join(r.dataDir, 'licence.dat'), 'utf8');
  await syncOnce(r.db, r.dataDir, r.opts);
  appt(r);
  r.tick(5000);
  const out = await syncOnce(r.db, r.dataDir, r.opts);
  assert.equal(out.applied, 1, 'очередь, принятую от партнёров до отметки, клиника разбирает как обычно');
  assert.ok(r.fake.state.licences.length >= 5);
  assert.ok(r.fake.state.licences.every((l) => l === raw), 'лицензия — как лежит на диске');
  assert.equal(JSON.parse(r.fake.state.licences.at(-1)).payload.subscription, 'unpaid');
});

// ─── РЕВЬЮ 8a, C1: ОДИН ЭЛЕМЕНТ НЕ ДОЛЖЕН ОСТАНАВЛИВАТЬ ВЕСЬ ПРИЁМ ───────────

const quietWarns = async (fn) => {
  const w = console.warn; const msgs = []; console.warn = (...a) => msgs.push(a.join(' '));
  try { await fn(); } finally { console.warn = w; }
  return msgs;
};
const second = (r) => appt(r, { public_id: 'rq_good00002', data: { external_id: 'med-56', doctor_id: 7, consultation: 'initial',
  start: new Date(localAt('2030-03-12', '12:00')).toISOString(), lang: 'ru' } });

test('C1: база отказывает элементу (ограничение) — он пропускается, курсор идёт дальше, запись за ним принята; пропуск помнится, экран «работает»', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  r.db.exec("CREATE TRIGGER zz_poison BEFORE INSERT ON api_requests WHEN NEW.public_id = 'rq_poison001' BEGIN SELECT RAISE(ABORT, 'отказ базы'); END");
  appt(r, { public_id: 'rq_poison001' });
  second(r);
  r.tick(15000);
  let out;
  const warns = await quietWarns(async () => { out = await syncOnce(r.db, r.dataDir, r.opts); });
  assert.equal(out.applied, 1);
  assert.deepEqual(r.fake.state.acks, [2], 'курсор подтверждён за обоими элементами');
  assert.deepEqual(r.db.prepare('SELECT public_id FROM api_requests').all().map((x) => x.public_id), ['rq_good00002']);
  assert.ok(warns.some((w) => w.includes('rq_poison001')), 'в журнале сервера — номер пропущенной заявки');
  assert.ok(!warns.join('\n').includes('Абдурахмонов'), 'без данных пациента');
  const st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.equal(st.state, 'ok', 'обмен идёт');
  assert.deepEqual([st.skipped.failed, st.skipped.last_ids], [1, ['rq_poison001']]);
  assert.ok(st.skipped.last_at);
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.equal(syncStatus(r.db, r.dataDir, { keyPath: r.keyPath }).skipped.failed, 1, 'следующий удачный такт пропуск не стирает');
});

test('C1: сбой программы на элементе — такт на нём стоит, экран «ошибка» (intake_failed), а не «работает»; после 20 попыток элемент пропускается', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  appt(r, { public_id: 'rq_bug000001' });
  second(r);
  const { ingestItem } = await import('./bookings.js');
  const ingestImpl = (db, it, o) => (it.public_id === 'rq_bug000001' ? Promise.reject(new TypeError('сбой программы')) : ingestItem(db, it, o));
  const opts = { ...r.opts, ingestImpl };
  r.tick(15000);
  await quietWarns(async () => { await syncOnce(r.db, r.dataDir, opts); });
  assert.deepEqual(r.fake.state.acks, [], 'курсор стоит: следующий такт попробует снова');
  let st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.deepEqual([st.state, st.last_error], ['error', 'intake_failed']);
  await quietWarns(async () => { for (let i = 0; i < 18; i += 1) { r.tick(15000); await syncOnce(r.db, r.dataDir, opts); } });
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM api_requests').get().n, 0, '19 попыток — ещё ждём');
  r.tick(15000);
  await quietWarns(async () => { await syncOnce(r.db, r.dataDir, opts); });
  assert.deepEqual(r.db.prepare('SELECT public_id FROM api_requests').all().map((x) => x.public_id), ['rq_good00002'], '20-я — пропуск, дальше пошло');
  st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.deepEqual([st.state, st.skipped.failed, st.skipped.last_ids], ['ok', 1, ['rq_bug000001']]);
});

// ─── РЕВЬЮ 8a, I1: «ПРИШЁЛ» НЕ ПОКИДАЕТ КЛИНИКУ БЕЗ ПОДПИСКИ ПАРТНЁРА ───────

test('I1 страж: партнёр не включал «пришёл» — ни одно событие со статусом arrived не уходит на /_sync/v1/events (отметка и оплата)', async () => {
  const { calendarBook } = await import('../rpc/calendar.js');
  for (const how of ['mark', 'payment']) {
    const r = rig();
    await syncOnce(r.db, r.dataDir, r.opts);
    appt(r);
    r.tick(15000);
    await syncOnce(r.db, r.dataDir, r.opts);
    r.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
    const c = await confirmBooking(r.db, { id: r.db.prepare('SELECT id FROM api_requests').get().id, patientId: 1 }, r.reg, { now: NOW + 60000, kekPath: r.kekPath });
    if (how === 'mark') await calendarBook(r.db, { visit_id: c.visit.id, start: c.visit.visit_date, status: 'arrived' }, r.reg);
    else {
      r.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES (1, 'INV-1', ?, 1, 150000, 150000, 150000, 'paid')").run(c.visit.id);
      // Повторная проверка 8a, п. 6: приход — платёж в день визита (cameSurely).
      r.db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (1, 150000, ?, ?)').run('cash', new Date(localAt('2030-03-12', '10:05')).toISOString());
    }
    r.tick(26 * 3600000);   // день визита наступил
    await syncOnce(r.db, r.dataDir, r.opts);
    assert.equal(r.db.prepare('SELECT status FROM api_requests').get().status, 'arrived', how + ': в клинике — «пришёл»');
    const out = r.fake.state.events.filter((e) => e.status === 'arrived' || JSON.parse(e.body).status === 'arrived' || e.event === 'appointment.arrived');
    assert.deepEqual(out, [], how + ': наружу «пришёл» не ушёл');
  }
});

// ─── РЕВЬЮ 8a, I3: ОТКАЗ СНИМКУ НЕ ОСТАНАВЛИВАЕТ СОБЫТИЯ И ОЧЕРЕДЬ ──────────

const refusing = (r, match, status, body) => async (url, o) => (match(new URL(String(url)).pathname)
  ? { ok: false, status, text: async () => JSON.stringify(body || {}), body: null }
  : r.opts.fetchImpl(url, o));

test('I3: 409 slug_taken на снимок — событие подтверждения уходит, очередь собирается; экран называет причину; снимок принят — снова «работает»', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  appt(r);
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  r.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  await confirmBooking(r.db, { id: r.db.prepare('SELECT id FROM api_requests').get().id, patientId: 1 }, r.reg, { now: NOW + 60000, kekPath: r.kekPath });
  r.db.prepare("UPDATE api_settings SET slug = 'zanyato' WHERE id = 1").run();
  second(r);
  const fetchImpl = refusing(r, (p) => p === '/_sync/v1/snapshot', 409, { error: { code: 'slug_taken' } });
  r.tick(15000);
  const out = await quietWarns(async () => { await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl }); });
  void out;
  assert.ok(r.fake.state.events.some((e) => e.event === 'booking.confirmed'), 'подтверждение дошло до партнёра');
  assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM api_requests WHERE public_id = 'rq_good00002'").get().n, 1, 'вторая запись принята');
  let st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.deepEqual([st.state, st.last_error], ['error', 'slug_taken'], 'экран называет причину');
  r.tick(15000);
  const back = await syncOnce(r.db, r.dataDir, r.opts);
  assert.equal(back.ok, true);
  st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.equal(st.state, 'ok');
});

test('I3: сервер не принял один файл (413) — файл пропущен, снимок и очередь идут', async () => {
  const r = rig();
  const dir = path.join(r.opts.storageDir, 'doctor-photos', 'doctors', '7');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'p.png'), Buffer.alloc(4096, 7));
  r.db.prepare("UPDATE users SET photo_url = '/api/storage/doctor-photos/doctors/7/p.png' WHERE id = 7").run();
  const fetchImpl = refusing(r, (p) => /^\/_sync\/v1\/media\/[0-9a-f]{64}\./.test(p), 413, {});
  await quietWarns(async () => { await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl }); });
  assert.equal(r.fake.state.snapshots.length, 1, 'снимок ушёл');
  appt(r);
  r.tick(15000);
  await quietWarns(async () => { await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl }); });
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM api_requests').get().n, 1, 'запись принята');
});

// ─── РЕВЬЮ 8a, I4: ЗАПЕЧАТАННОЕ НЕ ОТКРЫЛОСЬ — СЛЕД И ПРЕДУПРЕЖДЕНИЕ ОСТАЮТСЯ ─

test('I4: заявка, запечатанная прежним ключом клиники, — пропущена и подтверждена (сервер сотрёт), но номер записан в журнал и состояние; экран «работает» с предупреждением, которое не исчезает через такт', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  const old = loadSyncIdentity({ keyPath: path.join(tmpDir('em-psync-old-'), SYNC_KEY_FILE), create: true });
  const { sealFor } = await import('./sync-identity.js');
  r.fake.state.inbox.push({ cursor: '1', type: 'appointment.new', public_id: 'rq_lost00001', connection_id: r.connId, received_at: new Date(NOW).toISOString(),
    data: { external_id: 'med-lost', doctor_id: 7, consultation: 'initial', start: new Date(START).toISOString(), lang: 'ru' },
    sealed: sealFor(old.boxPublic, { name: 'Пациент Потерянный', phone: '+998905550000', comment: '' }) });
  r.tick(15000);
  let out;
  const warns = await quietWarns(async () => { out = await syncOnce(r.db, r.dataDir, r.opts); });
  assert.equal(out.ok, true, 'обмен сам по себе работает');
  assert.deepEqual(r.fake.state.acks, [1], 'курсор подтверждён: открыть это клиника не сможет никогда');
  assert.ok(warns.some((w) => w.includes('rq_lost00001')), 'в журнале сервера — номер заявки');
  assert.ok(!warns.join('\n').includes('Потерянный'));
  for (let i = 0; i < 2; i += 1) {
    const st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
    assert.deepEqual([st.state, st.last_error, st.skipped.sealed, st.skipped.last_ids], ['ok', '', 1, ['rq_lost00001']], 'такт ' + (i + 1));
    r.tick(15000);
    await syncOnce(r.db, r.dataDir, r.opts);
  }
});

// ─── РЕВЬЮ 8a, M4: ОБА ФАЙЛА КЛЮЧА ИСПОРЧЕНЫ — «КЛЮЧ ПОВРЕЖДЁН», А НЕ «ЖДЁМ ВКЛЮЧЕНИЯ» ─

test('M4: испорчены оба файла ключа обмена у включённой клиники — такт «key_broken», экран «ошибка: key_broken»; в сеть ничего; время — часов такта', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  fs.writeFileSync(r.keyPath, 'испорчено');
  fs.writeFileSync(r.keyPath + '.bak', 'испорчено');
  r.fake.state.calls.length = 0;
  r.tick(15000);
  let out;
  await quietWarns(async () => { out = await syncOnce(r.db, r.dataDir, r.opts); });
  assert.deepEqual(out, { ok: false, reason: 'key_broken' });
  assert.deepEqual(r.fake.state.calls, []);
  const st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.deepEqual([st.state, st.reason, st.last_error, st.last_error_at], ['error', 'key_broken', 'key_broken', new Date(NOW + 15000).toISOString().replace('.000', '')]);
  assert.equal(fs.readFileSync(r.keyPath, 'utf8'), 'испорчено', 'новая пара не создана');
});

// ─── ПОВТОРНАЯ ПРОВЕРКА 8a, п. 3: «ИСТЕКЛО» НЕ УХОДИТ РАНЬШЕ, ЧЕМ ПРОЧИТАН ОТВЕТ ─

test('рр-3: приём застрял на другом элементе, срок предложения прошёл, согласие партнёра лежит за ним — «истекло» не уходит; согласие прочитано — ждёт подтверждения', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  appt(r);
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  const id = r.db.prepare("SELECT id FROM api_requests WHERE public_id = 'rq_sync0001'").get().id;
  const { offerOtherTime, ingestItem } = await import('./bookings.js');
  const off = offerOtherTime(r.db, { id, start: new Date(localAt('2030-03-12', '11:00')).toISOString() }, r.reg, { now: NOW + 60000, kekPath: r.kekPath });
  const until = Date.parse(off.offer_until);
  appt(r, { public_id: 'rq_bug000001', data: { external_id: 'med-77', doctor_id: 7, consultation: 'initial', start: new Date(localAt('2030-03-12', '14:00')).toISOString(), lang: 'ru' } });
  r.fake.enqueue({ type: 'offer.accept', public_id: 'rq_sync0001', connection_id: r.connId, received_at: new Date(NOW + 10 * 60000).toISOString() });
  let broken = true;
  const opts = { ...r.opts, ingestImpl: (db, it, o) => (broken && it.public_id === 'rq_bug000001' ? Promise.reject(new TypeError('сбой')) : ingestItem(db, it, o)) };
  let clock = NOW + 15000;
  const go = async (ms) => { r.tick(ms - clock); clock = ms; await quietWarns(async () => { await syncOnce(r.db, r.dataDir, opts); }); };
  await go(NOW + 10 * 60000 + 15000);
  await go(until + 15000);
  await go(until + 30000);
  await go(until + 45000);
  assert.equal(r.db.prepare('SELECT status FROM api_requests WHERE id = ?').get(id).status, 'offered', 'приём стоит — не истекает');
  broken = false;
  await go(until + 60000);
  assert.equal(r.db.prepare('SELECT status FROM api_requests WHERE id = ?').get(id).status, 'pending');
  const told = r.fake.state.events.filter((e) => JSON.parse(e.body).request_id === 'rq_sync0001').map((e) => e.event + ':' + JSON.parse(e.body).status);
  assert.ok(!told.includes('booking.declined:expired'), 'партнёр не получал «истекло»: ' + told.join(', '));
});

test('рр-3: очередь прочитана до срока предложения, такт кончился после — следующий такт не шлёт «истекло», а читает согласие', async () => {
  const r = rig();
  let clock = NOW;
  const go = (ms) => { r.tick(ms - clock); clock = ms; };
  await syncOnce(r.db, r.dataDir, r.opts);
  appt(r);
  go(NOW + 15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  const id = r.db.prepare('SELECT id FROM api_requests').get().id;
  const { offerOtherTime } = await import('./bookings.js');
  const until = Date.parse(offerOtherTime(r.db, { id, start: new Date(localAt('2030-03-12', '11:00')).toISOString() }, r.reg, { now: NOW + 60000, kekPath: r.kekPath }).offer_until);
  go(until - 5000);
  const fetchImpl = async (url, o) => {
    const res = await r.opts.fetchImpl(url, o);
    if (String(o && o.method || 'GET') === 'GET' && new URL(String(url)).pathname === '/_sync/v1/inbox') {
      r.fake.enqueue({ type: 'offer.accept', public_id: 'rq_sync0001', connection_id: r.connId, received_at: new Date(until - 2000).toISOString() });
      go(until + 1000);   // остаток такта кончился после срока
    }
    return res;
  };
  await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl });
  go(until + 16000);
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.equal(r.db.prepare('SELECT status FROM api_requests WHERE id = ?').get(id).status, 'pending');
  assert.ok(!r.fake.state.events.some((e) => e.event === 'booking.declined'), 'партнёр не получал «истекло»');
});

test('проверка исправлений 8b, C: сервер не принял снимок или время по размеру (413) — причина too_large; то же содержимое не шлётся каждый такт, после 15 минут — снова', async () => {
  const r = rig();
  const sent = { snapshot: 0, slots: 0 };
  const fetchImpl = async (url, o) => {
    const p = new URL(String(url)).pathname;
    if (p === '/_sync/v1/snapshot' || p === '/_sync/v1/slots') {
      sent[p.slice('/_sync/v1/'.length)] += 1;
      return { ok: false, status: 413, text: async () => JSON.stringify({ error: { code: 'too_large' } }), body: null };
    }
    return r.opts.fetchImpl(url, o);
  };
  r.tick(2 * 60000);   // 09:02 — до следующего начала окна (09:15) свободное время не меняется
  await quietWarns(async () => { await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl }); });
  const st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.deepEqual([st.state, st.last_error], ['error', 'too_large'], 'экран получает свою причину, а не «ошибка сервера»');
  assert.deepEqual(sent, { snapshot: 1, slots: 1 });
  r.tick(61000);
  await quietWarns(async () => { await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl }); });
  assert.deepEqual(sent, { snapshot: 1, slots: 1 }, 'не принятое по размеру не гоняется каждый такт');
  const again = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.deepEqual([again.state, again.last_error], ['error', 'too_large'], 'причина держится, пока сервер не примет (а не «работает»)');
  r.tick(15 * 60000);
  await quietWarns(async () => { await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl }); });
  assert.deepEqual(sent, { snapshot: 2, slots: 2 }, 'раз в 15 минут — снова (вдруг сервер уже принимает)');
});

test('проверка исправлений 8b, D: сервер после восстановления отдаёт элемент с курсором, равным сохранённому, — клиника всё равно подтверждает (иначе он висит и шифротекст не стирается)', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  r.db.prepare("UPDATE api_sync_state SET inbox_cursor = '1' WHERE id = 1").run();
  appt(r);   // поддельный сервер даёт ему курсор '1' — тот же, что у клиники
  // Сервер 8b отдаёт всё неподтверждённое, не глядя на after (проверка 8b, C3).
  const fetchImpl = async (url, o = {}) => (new URL(String(url)).pathname === '/_sync/v1/inbox' && String(o.method || 'GET') === 'GET'
    ? { ok: true, status: 200, text: async () => JSON.stringify({ items: r.fake.state.inbox }), body: null }
    : r.opts.fetchImpl(url, o));
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl });
  assert.deepEqual(r.fake.state.acks, [1], 'подтверждено, хотя курсор не сдвинулся');
  assert.equal(r.fake.state.inbox.length, 0);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM api_requests').get().n, 1);
});

test('проверка исправлений 8b: неизменное время уходит раз в 15 минут — проверка «изменилось ли» раз в минуту не сдвигает срок повтора', async () => {
  const r = rig();
  let slots = 0;
  const fetchImpl = async (url, o) => {
    if (new URL(String(url)).pathname === '/_sync/v1/slots') slots += 1;
    return r.opts.fetchImpl(url, o);
  };
  r.tick(localAt('2030-03-11', '19:00') - NOW);   // вечер: приём кончился, свободное время до полуночи не меняется
  await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl });
  assert.equal(slots, 1);
  for (let m = 1; m <= 14; m += 1) { r.tick(60000); await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl }); }
  assert.equal(slots, 1, 'до 15 минут — не шлётся');
  r.tick(60000);
  await syncOnce(r.db, r.dataDir, { ...r.opts, fetchImpl });
  assert.equal(slots, 2, 'через 15 минут — снова, хотя ничего не изменилось');
  const st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.equal(st.state, 'ok');
});

// ─── PUBLIC_LICENCE_V1 — РЕВЬЮ 8c: КОД КЛЮЧА ОБМЕНА ДЛЯ ЗВОНКА В EASY-MED ──────
// Клиника сменила компьютер — новый ключ ждёт «Accept new key» в панели. Сотрудник
// Easy-Med спрашивает код, который клиника видит у себя, и вводит его в панели;
// сервер лицензий сверяет его с началом отпечатка нового ключа: первые 8 hex
// отпечатка (sync-identity.js), «xxxx-xxxx» — договор со сборщиком А. Экрану —
// только код: ни открытой половины, ни отпечатка целиком, ни закрытого.

const STATUS_KEYS = ['key_code', 'last_error', 'last_error_at', 'last_ok_at', 'pending_events', 'reason', 'skipped', 'state', 'waiting_requests'];
const codeOf = (fp) => fp.slice(0, 4) + '-' + fp.slice(4, 8);
function onlyTheCode(st, identity, why) {
  assert.deepEqual(Object.keys(st).sort(), STATUS_KEYS, why + ': ответ экрану — ровно эти поля');
  const json = JSON.stringify(st);
  for (const secret of [identity.signPublic, identity.boxPublic, identity.fingerprint, identity.fingerprint.slice(8)]) {
    assert.ok(!json.includes(secret), why + ': в ответе экрану нет ключа и отпечатка целиком');
  }
  assert.doesNotMatch(json, /PRIVATE|BEGIN|"sign|"box/, why);
}

test('PUBLIC_LICENCE_V1, ревью 8c: keyCodeOf — первые 8 hex отпечатка как «xxxx-xxxx»; не отпечаток — пусто', () => {
  assert.equal(keyCodeOf('46de4fe9a62a7f1349bdd3658be1696a'), '46de-4fe9', 'пример договора с панелью');
  for (const bad of ['', null, undefined, 42, {}, '46de4fe9', '46DE4FE9A62A7F1349BDD3658BE1696A', 'zz'.repeat(16), '46de4fe9a62a7f1349bdd3658be1696a0']) {
    assert.equal(keyCodeOf(bad), '', String(bad));
  }
});

test('PUBLIC_LICENCE_V1, ревью 8c: код ключа обмена — в состоянии «ждём Easy-Med», «работает» и «ошибка»; это начало отпечатка ключа клиники; больше ничего о ключе', async () => {
  const off = rig({ enabled: false });
  let st = syncStatus(off.db, off.dataDir, { keyPath: off.keyPath });
  assert.deepEqual([st.state, st.key_code], ['waiting_vendor', codeOf(off.identity.fingerprint)]);
  assert.match(st.key_code, /^[0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.ok(off.identity.fingerprint.startsWith(st.key_code.replace('-', '')), 'код — начало отпечатка, который сервер лицензий вписывает в лицензию');
  onlyTheCode(st, off.identity, 'waiting_vendor');
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.deepEqual([st.state, st.key_code], ['ok', codeOf(r.identity.fingerprint)]);
  onlyTheCode(st, r.identity, 'ok');
  r.fake.state.offline = true;
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.deepEqual([st.state, st.reason, st.key_code], ['error', 'offline', codeOf(r.identity.fingerprint)]);
  onlyTheCode(st, r.identity, 'error');
});

// ─── FIX_318_V1 (C3) — секрет адреса станции и отзыв ключей партнёров без API партнёров ───
//
// Ключи (PUT /keys) несут не только подключения партнёров, но и секрет адреса
// станции (CALL_RING_V1), и только ими публичный сервер узнаёт, что ключ
// партнёра удалён. Раньше они уходили лишь после localBlocker (имя в адресе и
// хоть одно подключение): клиника без API партнёров меняла адрес станции — экран
// говорил «готово», а сервер знал прежний секрет; удалённое последнее
// подключение оставалось действующим на сервере.
const RING_A = 'a1'.repeat(16);
const RING_B = 'b2'.repeat(16);
const setRing = (db, t) => db.prepare('UPDATE telephony_settings SET ring_token = ? WHERE id = 1').run(t);

test('FIX_318_V1 (C3): без API партнёров секрет адреса станции всё равно уходит на сервер; «готово» — только когда дошёл', async () => {
  const r = rig({ api: false });   // ни имени в адресе, ни подключений — API партнёров не настраивали
  const st = () => ringRelayStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  // Ни секрета, ни прежних ключей — сказать серверу нечего: в сеть ни одного запроса (как раньше).
  assert.deepEqual(await syncOnce(r.db, r.dataDir, r.opts), { ok: false, reason: 'no_slug' });
  assert.deepEqual(r.fake.state.calls, []);
  assert.deepEqual([st().ready, st().reason], [false, 'no_token']);
  setRing(r.db, RING_A);
  assert.deepEqual([st().ready, st().reason], [false, 'pending'], 'секрет ещё не ушёл, а экран говорит «готово»');
  const out = await syncOnce(r.db, r.dataDir, r.opts);
  assert.equal(out.reason, 'no_slug', 'экран «API» по-прежнему «выключен»');
  assert.deepEqual(r.fake.state.calls, ['PUT /_sync/v1/keys'], 'кроме ключей — ничего: снимка и очереди без API нет');
  assert.equal(r.fake.state.keys.at(-1).ring_token, RING_A);
  assert.deepEqual(r.fake.state.keys.at(-1).connections, []);
  assert.equal(r.fake.state.keys.at(-1).box_key, r.identity.boxPublic);
  assert.deepEqual(st(), { ready: true, reason: '', error: '', key_code: keyCodeOf(r.identity.fingerprint) });
  // Сменили адрес — «ещё не дошёл», пока такт не донесёт; донёс — «готово».
  setRing(r.db, RING_B);
  assert.deepEqual([st().ready, st().reason], [false, 'pending']);
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.equal(r.fake.state.keys.at(-1).ring_token, RING_B);
  assert.equal(st().ready, true);
  // Ничего не изменилось — молчит; нет связи — экран называет причину.
  r.fake.state.calls.length = 0;
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.deepEqual(r.fake.state.calls, []);
  setRing(r.db, RING_A);
  r.fake.state.offline = true;
  r.tick(15000);
  const off = await syncOnce(r.db, r.dataDir, r.opts);
  assert.deepEqual(off, { ok: false, reason: 'no_slug', keys_error: 'offline' });
  assert.deepEqual([st().ready, st().reason, st().error], [false, 'pending', 'offline']);
  r.fake.state.offline = false;
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.deepEqual([st().ready, st().error], [true, '']);
});

// Через экран последнее подключение не исчезает: имя в адресе заводит подключение
// сайта, а его удалить нельзя — тогда такт обычный, и отзыв уходит им. Здесь —
// установка без подключения сайта (имя в адресе старше него или строка правлена
// рукой): localBlocker говорит no_connections, и раньше такт молчал.
test('FIX_318_V1 (C3): удалили последнее подключение — отзыв ключа всё равно уходит на сервер; дальше обмен молчит', async () => {
  const r = rig();
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.ok(r.fake.state.keys.at(-1).connections.some((c) => c.id === r.connId));
  r.db.prepare(`UPDATE api_connections SET deleted_at = '2030-03-11T04:00:00Z', active = 0, key_hash = '', key_sealed = '', key_tail = '',
      secret_sealed = '', secret_tail = '' WHERE kind = 'site'`).run();
  deleteConnection(r.db, r.connId, r.actor, { confirm: true });
  r.fake.state.calls.length = 0;
  r.tick(15000);
  assert.deepEqual(await syncOnce(r.db, r.dataDir, r.opts), { ok: false, reason: 'no_connections' });
  assert.deepEqual(r.fake.state.calls, ['PUT /_sync/v1/keys'], 'удалённый ключ партнёра остался действующим на сервере');
  assert.deepEqual(r.fake.state.keys.at(-1).connections, []);
  r.fake.state.calls.length = 0;
  r.tick(15000);
  await syncOnce(r.db, r.dataDir, r.opts);
  r.tick(16 * 60000);
  await syncOnce(r.db, r.dataDir, r.opts);
  assert.deepEqual(r.fake.state.calls, [], 'серверу больше нечего сказать — обмен не ходит в сеть');
});

test('FIX_318_V1 (C3): клиника без ключа обмена — ключ заводится ради адреса станции (без сети), экран называет, чего ждать; второе здание — ничего', async () => {
  const s = bookingSeed();
  s.db.prepare("UPDATE api_settings SET slug = '' WHERE id = 1").run();
  const dataDir = tmpDir('em-psync-ring-');
  const keyPath = path.join(dataDir, SYNC_KEY_FILE);
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({ clinic_id: 'c-000777', install_token: 'TESTONLY' }));
  fs.writeFileSync(path.join(dataDir, 'licence.dat'), JSON.stringify({ payload: { clinic_id: 'c-000777', valid_until: '2030-04-01T00:00:00Z', modules: [] }, sig: 'AAAA' }));
  const calls = [];
  const opts = { fetchImpl: async (u) => { calls.push(String(u)); throw new TypeError('must not reach the network'); },
    env: { EASYMED_PUBLIC_URL: 'https://api.test.local' }, now: () => NOW, keyPath, kekPath: s.kekPath };
  const st = () => ringRelayStatus(s.db, dataDir, { keyPath });
  await syncOnce(s.db, dataDir, opts);
  assert.equal(fs.existsSync(keyPath), false, 'без адреса станции ключ обмена заводиться не должен');
  setRing(s.db, RING_A);
  assert.deepEqual([st().ready, st().reason], [false, 'no_sync_key']);
  await syncOnce(s.db, dataDir, opts);
  assert.equal(fs.existsSync(keyPath), true, 'ключ обмена так и не появился — Easy-Med не сможет включить обмен');
  assert.deepEqual(calls, []);
  const id = loadSyncIdentity({ keyPath });
  assert.deepEqual(st(), { ready: false, reason: 'not_enabled', error: '', key_code: keyCodeOf(id.fingerprint) });
  fs.rmSync(path.join(dataDir, 'licence.dat'));
  assert.equal(st().reason, 'not_enrolled');
  // Второе здание: адрес станции передаёт главное — здесь ни ключа, ни сети.
  const r = rig();
  setRing(r.db, RING_A);
  r.db.prepare("UPDATE branch_identity SET role = 'secondary' WHERE id = 1").run();
  assert.deepEqual(await syncOnce(r.db, r.dataDir, r.opts), { ok: false, reason: 'not_main' });
  assert.deepEqual(r.fake.state.calls, []);
  assert.equal(ringRelayStatus(r.db, r.dataDir, { keyPath: r.keyPath }).reason, 'not_main');
});

test('PUBLIC_LICENCE_V1, ревью 8c: нет файла ключа или он испорчен — кода нет (пусто), поля те же', async () => {
  const r = rig();
  fs.rmSync(r.keyPath);
  fs.rmSync(r.keyPath + '.bak', { force: true });
  let st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.equal(st.key_code, '');
  assert.deepEqual(Object.keys(st).sort(), STATUS_KEYS);
  fs.writeFileSync(r.keyPath, 'испорчено');
  fs.writeFileSync(r.keyPath + '.bak', 'испорчено');
  st = syncStatus(r.db, r.dataDir, { keyPath: r.keyPath });
  assert.deepEqual([st.state, st.reason, st.key_code], ['error', 'key_broken', '']);
  assert.deepEqual(Object.keys(st).sort(), STATUS_KEYS);
});
