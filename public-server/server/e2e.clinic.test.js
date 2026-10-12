// PUBLIC_SERVER_V1 — СКВОЗНОЙ ПРОГОН: НАСТОЯЩАЯ КЛИНИКА ↔ НАСТОЯЩИЙ ПУБЛИЧНЫЙ
// СЕРВЕР ↔ ПАРТНЁР. Обе стороны в одном процессе, сервер — на случайном порту
// (listen), клиника говорит с ним настоящим обменом шага 8a
// (server/services/api/public-sync.js syncOnce) по протоколу §10 — тем же, что
// проверял поддельный сервер 8a. Партнёр — настоящими запросами с ключом,
// выпущенным клиникой. Часы общие и подставные (2030 год).
//
// Сценарий: снимок и время доходят до партнёра; две записи на одно время —
// вторая получает 409 на сервере; клиника принимает первую и держит время
// (held → hold_until у партнёра), шифротекст стёрт; регистратор подтверждает —
// «booked» и уведомление, подписанное секретом подключения; пациент отменяет у
// партнёра — визит отменён календарём клиники, «cancelled»; другое время —
// согласие партнёра доходит до клиники и снова держится; «перезвоните» —
// «взять в работу»; «не оплачено» в подписанной лицензии — партнёрам 503, канал
// клиники открыт. И всё это — без данных пациента в базе сервера и в журнале.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bookingSeed, localAt } from '../../server/test-helpers/api-booking-seed.js';
import { tmpDir } from '../../server/test-helpers/tmpdir.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { loadSyncIdentity, SYNC_KEY_FILE } from '../../server/services/api/sync-identity.js';
import { syncOnce } from '../../server/services/api/public-sync.js';
import { confirmBooking, offerOtherTime, acceptRequest } from '../../server/services/api/bookings.js';
import { SCOPES } from '../../public/js/shared/api-connections.js';
import { createPublicServer } from './app.js';
import { deliverDue } from './store/deliveries.js';
import { testDb, testVendor, signTestLicence } from './test-helpers/fixture.js';
import { localIso } from './lib/time.js';

process.env.LIS_ENABLED = '0';
const NOW = localAt('2030-03-11', '09:00');
const OFFSET = -new Date(NOW).getTimezoneOffset();   // клиника в этом процессе считает в его поясе
const MARKS = ['ИМЯ_ПЕРВОГО', 'ИМЯ_ВТОРОГО', 'ИМЯ_ТРЕТЬЕГО', 'ИМЯ_ЧЕТВЁРТОГО', '998901111111', '998902222222', '998903333333',
  '998904444444', 'КОММЕНТАРИЙ_ПАЦИЕНТА'];

test('настоящая клиника и настоящий публичный сервер: запись, держание, подтверждение, отмена, другое время, заявка, неоплата — без данных пациента на сервере', async (t) => {
  const logged = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[m] = console[m];
    console[m] = (...a) => { logged.push(a.map(String).join(' ')); orig[m](...a); };
  }
  t.after(() => { for (const m of Object.keys(orig)) console[m] = orig[m]; });

  // ── клиника ──
  const s = bookingSeed();
  // Все права (и «Отмена записи»); срок ключа — без срока: часы прогона — 2030 год, а ключ партнёра выпущен на год от сегодня.
  s.db.prepare('UPDATE api_connections SET scopes = ?, key_expires_at = NULL WHERE id = ?').run(JSON.stringify([...SCOPES]), s.connId);
  const dataDir = tmpDir('em-pub-e2e-');
  const keyPath = path.join(dataDir, SYNC_KEY_FILE);
  const identity = loadSyncIdentity({ keyPath, create: true });
  const vendor = testVendor();
  const licence = (issuedAt, subscription) => fs.writeFileSync(path.join(dataDir, 'licence.dat'), signTestLicence(vendor, {
    clinic_id: 'c-000777', clinic_name: 'Шифо', modules: [], valid_until: '2030-04-01T00:00:00Z', issued_at: issuedAt, nonce: issuedAt,
    api_sync_key: identity.fingerprint, ...(subscription ? { subscription } : {}) }));
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({ clinic_id: 'c-000777' }));
  licence('2030-03-10T00:00:00Z');

  // ── публичный сервер ──
  let clock = NOW;
  const pub = testDb();
  const { app } = createPublicServer({ db: pub.db, dataDir: pub.dir, now: () => clock, licencePublicKey: vendor.publicKey, offsetMin: OFFSET,
    baseUrl: 'https://api.test', requireHttps: false, trustProxy: false, version: 'e2e' });
  const server = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const sync = async () => {
    const r = await syncOnce(s.db, dataDir, { fetchImpl: globalThis.fetch, env: { EASYMED_PUBLIC_URL: base }, now: () => clock, keyPath,
      kekPath: s.kekPath, storageDir: path.join(dataDir, 'storage') });
    clock += 15000;
    return r;
  };
  const partner = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + s.key, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const clinicRequest = (publicId) => s.db.prepare('SELECT * FROM api_requests WHERE public_id = ?').get(publicId);
  const serverRequest = (id) => pub.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);

  // 1. Снимок, время и ключи доходят до партнёра.
  assert.deepEqual(await sync(), { ok: true, applied: 0, sent: 0 });
  const docs = await partner('GET', '/shifo/v1/doctors?lang=ru');
  assert.equal(docs.status, 200);
  assert.ok(docs.body.doctors.some((d) => d.id === 7 && d.name === 'Петров Пётр Петрович'));
  const slots = await partner('GET', '/shifo/v1/slots?doctor_id=7&date=2030-03-12&consultation=initial');
  assert.ok(slots.body.slots.some((w) => w.start === '10:00'), 'клиника отдала 10:00 свободным');

  // 2. Две записи на одно время: вторая — 409 на сервере, не доходя до клиники.
  const START = localAt('2030-03-12', '10:00');
  const book = (ext, name, phone, startMs = START) => partner('POST', '/shifo/v1/appointments', { doctor_id: 7, consultation: 'initial',
    start: localIso(startMs, OFFSET), patient: { name, phone, comment: 'КОММЕНТАРИЙ_ПАЦИЕНТА' }, external_id: ext });
  const first = await book('med-1', 'ИМЯ_ПЕРВОГО', '+998901111111');
  assert.deepEqual([first.status, first.body.status, first.body.hold_until], [201, 'pending', undefined]);
  const second = await book('med-2', 'ИМЯ_ВТОРОГО', '+998902222222');
  assert.deepEqual([second.status, second.body.error.code], [409, 'slot_taken']);
  const id1 = first.body.request_id;

  // 3. Клиника забирает: держит время, срок — серверу (held); шифротекст стёрт.
  assert.equal((await sync()).applied, 1);
  assert.equal(clinicRequest(id1).status, 'pending');
  assert.equal(clinicRequest(id1).patient_name, 'ИМЯ_ПЕРВОГО', 'клиника открыла запечатанное своим ключом');
  assert.equal(serverRequest(id1).hold_until, clinicRequest(id1).hold_until);
  assert.equal(pub.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0, 'шифротекст стёрт при подтверждении курсора');
  const held = await partner('GET', '/shifo/v1/requests/' + id1);
  assert.equal(held.body.hold_until, localIso(Date.parse(clinicRequest(id1).hold_until), OFFSET));

  // 4. Регистратор подтверждает: «booked» и подписанное клиникой уведомление.
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'ИМЯ_ПЕРВОГО', '+998901111111')").run();
  const confirmed = await confirmBooking(s.db, { id: clinicRequest(id1).id, patientId: 1 }, s.reg, { now: clock, kekPath: s.kekPath });
  await sync();
  assert.equal((await partner('GET', '/shifo/v1/requests/' + id1)).body.status, 'booked');
  const sent = [];
  const fake = async (m) => { sent.push(m); return { status: 200 }; };
  const wave = await deliverDue(pub.db, { now: clock, send: fake });
  assert.ok(wave.delivered >= 1);
  const hook = sent.find((m) => JSON.parse(m.body).event === 'booking.confirmed');
  assert.equal(hook.url, 'https://med24.uz/hooks');
  assert.equal(hook.headers['X-EasyMed-Signature'], 'sha256=' + crypto.createHmac('sha256', s.secret).update(hook.body).digest('hex'),
    'партнёр проверит подпись секретом клиники — сервер её не ставил и подделать не может');

  // 5. Пациент отменяет у партнёра: визит отменён календарём клиники.
  const del = await partner('DELETE', '/shifo/v1/appointments/' + id1);
  assert.deepEqual([del.status, del.body.status, del.body.cancel_requested], [200, 'booked', true]);
  await sync();
  assert.equal(s.db.prepare('SELECT status FROM visits WHERE id = ?').get(confirmed.visit.id).status, 'cancelled');
  assert.equal((await partner('GET', '/shifo/v1/requests/' + id1)).body.status, 'cancelled');

  // 6. Другое время: клиника предлагает, партнёр соглашается, клиника снова держит.
  const third = await book('med-3', 'ИМЯ_ТРЕТЬЕГО', '+998903333333', localAt('2030-03-12', '11:00'));
  assert.equal(third.status, 201);
  await sync();
  const OTHER = localAt('2030-03-12', '12:00');
  offerOtherTime(s.db, { id: clinicRequest(third.body.request_id).id, start: new Date(OTHER).toISOString() }, s.reg, { now: clock, kekPath: s.kekPath });
  await sync();
  const offered = await partner('GET', '/shifo/v1/requests/' + third.body.request_id);
  assert.deepEqual([offered.body.status, offered.body.offered_start], ['offered', localIso(OTHER, OFFSET)]);
  const accepted = await partner('POST', '/shifo/v1/appointments/' + third.body.request_id + '/accept');
  assert.deepEqual([accepted.status, accepted.body.status, accepted.body.start], [200, 'pending', localIso(OTHER, OFFSET)]);
  await sync();
  assert.equal(clinicRequest(third.body.request_id).status, 'pending');
  assert.equal(Date.parse(clinicRequest(third.body.request_id).start_at), OTHER);
  assert.equal(serverRequest(third.body.request_id).hold_until, clinicRequest(third.body.request_id).hold_until, 'срок держания — от клиники');

  // 7. «Перезвоните»: в CRM клиники; «взять в работу» — партнёру «accepted».
  const cb = await partner('POST', '/shifo/v1/requests', { name: 'ИМЯ_ЧЕТВЁРТОГО', phone: '+998904444444', comment: 'КОММЕНТАРИЙ_ПАЦИЕНТА', external_id: 'cb-1' });
  assert.deepEqual([cb.status, cb.body.status], [201, 'new']);
  await sync();
  acceptRequest(s.db, { id: clinicRequest(cb.body.request_id).id }, s.reg, { now: clock, kekPath: s.kekPath });
  await sync();
  assert.equal((await partner('GET', '/shifo/v1/requests/' + cb.body.request_id)).body.status, 'accepted');

  // 8. Данных пациента нет ни в одной ячейке базы сервера, ни в её файлах, ни в журнале процесса.
  pub.db.pragma('wal_checkpoint(TRUNCATE)');
  const cells = [];
  for (const { name } of pub.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const row of pub.db.prepare(`SELECT * FROM ${name}`).all()) cells.push(...Object.values(row).map(String));
  }
  const files = fs.readdirSync(pub.dir).filter((f) => f.startsWith('public.db')).map((f) => fs.readFileSync(path.join(pub.dir, f)));
  for (const mark of MARKS) {
    assert.ok(!cells.some((c) => c.includes(mark)), 'в базе сервера: ' + mark);
    assert.ok(!files.some((b) => b.includes(Buffer.from(mark, 'utf8'))), 'в файле базы сервера: ' + mark);
    assert.ok(!logged.some((l) => l.includes(mark)), 'в журнале процесса: ' + mark);
  }

  // 9. «Не оплачено» в подписанной лицензии (8c): партнёрам 503, канал клиники открыт.
  licence('2030-03-11T05:00:00Z', 'unpaid');
  assert.equal((await sync()).ok, true, 'клиника продолжает обмен — события по принятым записям дойдут');
  const off = await partner('GET', '/shifo/v1/doctors');
  assert.deepEqual([off.status, off.body.error.code], [503, 'licence_lapsed']);
  licence('2030-03-09T00:00:00Z');
  await sync();
  assert.equal((await partner('GET', '/shifo/v1/doctors')).status, 503, 'старая лицензия без отметки «не оплачено» не снимает её');
});

test('проверка исправлений 8b: здоровая клиника с неизменным временем — партнёр не видит stale вечером и ночью; клиника замолчала — stale', async (t) => {
  const s = bookingSeed();
  s.db.prepare('UPDATE api_connections SET scopes = ?, key_expires_at = NULL WHERE id = ?').run(JSON.stringify([...SCOPES]), s.connId);
  const dataDir = tmpDir('em-pub-e2e-quiet-');
  const keyPath = path.join(dataDir, SYNC_KEY_FILE);
  const identity = loadSyncIdentity({ keyPath, create: true });
  const vendor = testVendor();
  fs.writeFileSync(path.join(dataDir, 'licence.dat'), signTestLicence(vendor, {
    clinic_id: 'c-000777', clinic_name: 'Шифо', modules: [], valid_until: '2030-04-01T00:00:00Z', issued_at: '2030-03-10T00:00:00Z', nonce: 'q',
    api_sync_key: identity.fingerprint }));
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({ clinic_id: 'c-000777' }));
  const EVENING = localAt('2030-03-11', '19:00');   // приём кончился — свободное время до полуночи не меняется
  const off = -new Date(EVENING).getTimezoneOffset();
  let clock = EVENING;
  const pub = testDb();
  const { app } = createPublicServer({ db: pub.db, dataDir: pub.dir, now: () => clock, licencePublicKey: vendor.publicKey, offsetMin: off,
    baseUrl: 'https://api.test', requireHttps: false, trustProxy: false, version: 'e2e' });
  const server = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const sync = () => syncOnce(s.db, dataDir, { fetchImpl: globalThis.fetch, env: { EASYMED_PUBLIC_URL: base }, now: () => clock, keyPath,
    kekPath: s.kekPath, storageDir: path.join(dataDir, 'storage') });
  const stale = async () => (await (await fetch(base + '/shifo/v1/slots?doctor_id=7', { headers: { Authorization: 'Bearer ' + s.key } })).json()).stale;
  assert.equal((await sync()).ok, true);
  for (let m = 1; m <= 50; m += 1) { clock += 60000; assert.equal((await sync()).ok, true); }   // 50 минут обычной работы, раз в минуту
  assert.equal(await stale(), false, 'неизменное время клиника присылает раз в 15 минут — для партнёра оно свежее');
  clock += 11 * 60000;   // клиника замолчала
  assert.equal(await stale(), true, 'клиника молчит дольше 10 минут — stale');
});
