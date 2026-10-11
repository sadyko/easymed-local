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
import { syncOnce, syncStatus, publicBaseUrl, assertPublicUrlIsTestSafe, DEFAULT_PUBLIC_URL } from './public-sync.js';
import { confirmBooking } from './bookings.js';
import { isoOf } from '../../../public/js/shared/api-booking.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');

function rig({ enabled = true, extra = {} } = {}) {
  const s = bookingSeed();
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
    else r.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES (1, 'INV-1', ?, 1, 150000, 150000, 150000, 'paid')").run(c.visit.id);
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
