// PUBLIC_LICENCE_V1 — СКВОЗНОЙ ПРОГОН ТРЁХ СЛУЖБ ЧЕРЕЗ ГРАНИЦЫ КАТАЛОГОВ: НАСТОЯЩИЙ
// СЕРВЕР ЛИЦЕНЗИЙ (control-plane/, приложение целиком на случайном порту, панель
// по HTTP) ↔ НАСТОЯЩАЯ КЛИНИКА (сверка server/services/control/checkin.js и обмен
// 8a public-sync.js) ↔ НАСТОЯЩИЙ ПУБЛИЧНЫЙ СЕРВЕР (public-server/, список
// производителя store/feed.js). Подпись — одноразовым ключом «производителя»:
// сервер лицензий подписывает (EASYMED_SIGNING_KEY), клиника и публичный сервер
// проверяют его открытой половиной. Часы — настоящие (лицензию подписывает
// настоящее время). Ни интернета, ни настоящих портов.
//
// Сценарий: обмен молчит, пока Easy-Med не включил онлайн-запись → включили — в
// лицензии отпечаток ключа клиники, партнёр видит клинику → срочный отзыв ключа
// партнёра и снятие → «не оплачено»: партнёрам 503 по списку, ещё до сверки;
// новой лицензии неоплаченная клиника не получает (решение контролёра 8c: сверка
// отвечает licence: null, как до 8c), так что без списка партнёры её видят до
// конца последней лицензии; срок клиники не продлён → оплатили → новый ПК:
// новый ключ ждёт подтверждения, принят → ключ обмена отозван: канал закрыт,
// партнёрам 503. На сервере лицензий — ни ключа партнёра, ни открытой половины
// ключа клиники, только отпечатки.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bookingSeed } from '../../server/test-helpers/api-booking-seed.js';
import { tmpDir } from '../../server/test-helpers/tmpdir.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { loadSyncIdentity, SYNC_KEY_FILE } from '../../server/services/api/sync-identity.js';
import { syncOnce, syncStatus } from '../../server/services/api/public-sync.js';
import { runCheckin, __setPublicKeyForTests as checkinKey } from '../../server/services/control/checkin.js';
import { controlState, __setPublicKeyForTests as stateKey } from '../../server/services/control/state.js';
import { keyHash } from '../../server/services/api/secret-box.js';
import { openDb as openCpDb } from '../../control-plane/server/db/connection.js';
import { migrate as migrateCp } from '../../control-plane/server/db/migrate.js';
import { createApp as createControlPlane } from '../../control-plane/server/app.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../control-plane/server/services/enrollment.js';
import { signLicence } from '../../control-plane/server/services/signing.js';
import { hashPassword } from '../../control-plane/server/services/vendor-auth.js';
import { createPublicServer } from './app.js';
import { emptyFeed, pullFeed } from './store/feed.js';
import { testDb } from './test-helpers/fixture.js';

process.env.LIS_ENABLED = '0';
const FEED_TOKEN = 'TESTONLY-feed-token-0123456789abcdef';

test('сервер лицензий ↔ клиника ↔ публичный сервер: переключатель, отзыв ключей, «не оплачено», новый ПК — по подписанной лицензии и списку производителя', async (t) => {
  // ── «производитель»: одноразовая пара; закрытая — серверу лицензий, открытая — клинике и публичному серверу ──
  const vendor = crypto.generateKeyPairSync('ed25519');
  const keyDir = tmpDir('em-8c-vendor-');
  const keyFile = path.join(keyDir, 'vendor-private.pem');
  fs.writeFileSync(keyFile, vendor.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = keyFile;
  checkinKey(vendor.publicKey);
  stateKey(vendor.publicKey);
  t.after(() => { delete process.env.EASYMED_SIGNING_KEY; checkinKey(null); stateKey(null); });

  // ── сервер лицензий: реестр, продавец, клиника зачислена ──
  const cp = openCpDb(':memory:');
  migrateCp(cp);
  cp.prepare('INSERT INTO vendor_users (username, password_hash, full_name) VALUES (?,?,?)').run('vendor', hashPassword('secret123'), 'Vendor');
  const enrolled = redeemEnrollmentCode(cp, { code: createEnrollmentCode(cp, { clinicId: 'c-000777', name: 'Шифо' }) },
    { beforeCommit: ({ clinicId, clinicName, modules }) => signLicence({ clinicId, clinicName, modules }) });
  process.env.EASYMED_CP_FEED_TOKEN = FEED_TOKEN;
  const cpApp = createControlPlane(cp);
  delete process.env.EASYMED_CP_FEED_TOKEN;
  const cpServer = await listen(cpApp);
  t.after(() => new Promise((r) => cpServer.close(r)));
  const cpBase = 'http://127.0.0.1:' + cpServer.address().port;
  const login = await fetch(cpBase + '/cp/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'vendor', password: 'secret123' }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const panel = async (method, p, body) => {
    const res = await fetch(cpBase + '/cp/v1/admin' + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  // ── клиника: стенд онлайн-записи 8a, файлы сверки на «диске клиники» ──
  const s = bookingSeed();
  const dataDir = tmpDir('em-8c-clinic-');
  const keyPath = path.join(dataDir, SYNC_KEY_FILE);
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({ clinic_id: 'c-000777', install_token: enrolled.install_token, subscription: 'active' }));
  fs.writeFileSync(path.join(dataDir, 'licence.dat'), JSON.stringify(enrolled.licence));
  const licence = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'licence.dat'), 'utf8')).payload;
  const controlFile = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8'));
  const checkin = () => runCheckin(s.db, dataDir, { endpoint: cpBase });

  // ── публичный сервер ──
  const pub = testDb();
  const ps = createPublicServer({ db: pub.db, dataDir: pub.dir, licencePublicKey: vendor.publicKey, requireHttps: false, trustProxy: false });
  const pubServer = await listen(ps.app);
  t.after(() => new Promise((r) => pubServer.close(r)));
  const pubBase = 'http://127.0.0.1:' + pubServer.address().port;
  const sync = () => syncOnce(s.db, dataDir, { fetchImpl: globalThis.fetch, env: { EASYMED_PUBLIC_URL: pubBase }, keyPath, kekPath: s.kekPath,
    storageDir: path.join(dataDir, 'storage') });
  const pull = () => pullFeed(pub.db, ps.ctx.feed, { url: cpBase + '/cp/v1/public-feed', token: FEED_TOKEN, publicKey: vendor.publicKey, now: Date.now() });
  const partner = async (p) => {
    const res = await fetch(pubBase + p, { headers: { Authorization: 'Bearer ' + s.key } });
    return { status: res.status, body: await res.json() };
  };

  // 1. Онлайн-запись не включена: ключ клиники создан и уходит со сверкой, но лицензия без отпечатка — обмен молчит.
  assert.deepEqual(await sync(), { ok: false, reason: 'not_enabled' });
  const identity = loadSyncIdentity({ keyPath });
  await checkin();
  assert.equal('api_sync_key' in licence(), false);
  assert.equal(licence().subscription, 'active', 'подписанная отметка оплаты — с первой сверки после 8c');
  assert.equal((await panel('GET', '/clinics/c-000777')).body.clinic.api.sync_key, identity.fingerprint, 'первый ключ принят сам');
  assert.deepEqual(await sync(), { ok: false, reason: 'not_enabled' });

  // 2. Включили в панели: со сверкой — отпечаток в лицензии, обмен пошёл, партнёр видит клинику.
  assert.equal((await panel('POST', '/clinics/c-000777/api', { enabled: true })).status, 200);
  await checkin();
  assert.equal(licence().api_sync_key, identity.fingerprint);
  assert.equal((await sync()).ok, true);
  assert.equal((await partner('/shifo/v1/clinic')).status, 200);
  assert.deepEqual(await pull(), { ok: true, changed: true });
  assert.equal((await partner('/shifo/v1/clinic')).status, 200, 'видимая клиника не в clinics_off');

  // 3. Срочный отзыв ключа партнёра (панель шлёт SHA-256) — через минуту у публичного сервера; снятие — так же.
  const blocked = await panel('POST', '/clinics/c-000777/revocations', { kind: 'partner_key', value: keyHash(s.key), note: 'ключ утёк' });
  assert.equal(blocked.status, 201);
  await pull();
  assert.deepEqual([(await partner('/shifo/v1/clinic')).body.error.code], ['key_disabled']);
  assert.equal((await panel('DELETE', '/clinics/c-000777/revocations/' + blocked.body.id)).status, 200);
  await pull();
  assert.equal((await partner('/shifo/v1/clinic')).status, 200);

  // 4. «Не оплачено» (решение 17): партнёрам 503 по списку — ещё до сверки клиники.
  const paid = licence();
  const paidUntil = paid.valid_until;
  assert.equal((await panel('POST', '/clinics/c-000777/subscription', { subscription: 'unpaid', subscription_until: null })).status, 200);
  await pull();
  assert.equal(ps.ctx.feed.clinicsOff.has('c-000777'), true, 'клиника — в clinics_off списка производителя');
  const unpaid = await partner('/shifo/v1/clinic');
  assert.deepEqual([unpaid.status, unpaid.body.error.code], [503, 'licence_lapsed']);
  //    Сверка: новой лицензии нет (решение контролёра 8c: licence: null, как до 8c) — у клиники прежняя,
  //    оплаченная, с отпечатком; обмен клиники открыт.
  await checkin();
  assert.equal(controlFile().subscription, 'unpaid', 'сверка прошла: отметку «не оплачено» клиника получила');
  assert.deepEqual(licence(), paid, 'неоплаченной клинике сервер лицензий новой лицензии не выдаёт');
  assert.equal((await sync()).ok, true, 'канал клиники открыт: события по принятым записям дойдут');
  //    Отметку «не оплачено» публичный сервер знает только из списка: без него (сервер лицензий недоступен
  //    с запуска) партнёры видят клинику до конца её последней лицензии — поэтому feed_age_s под наблюдением.
  const kept = ps.ctx.feed;
  ps.ctx.feed = emptyFeed();
  assert.equal((await partner('/shifo/v1/clinic')).status, 200);
  ps.ctx.feed = kept;
  assert.equal((await partner('/shifo/v1/clinic')).status, 503);
  //    Сама клиника работает до конца оплаченного срока и запирается в тот же день, что и раньше.
  assert.equal(controlState(s.db, dataDir).locked, false);
  assert.equal(controlState(s.db, dataDir, new Date(Date.parse(paidUntil) + 1000)).locked, true);

  // 5. Оплатили: сверка — снова «active» на 14 дней; партнёр снова видит клинику.
  await panel('POST', '/clinics/c-000777/subscription', { subscription: 'active', subscription_until: null });
  await checkin();
  assert.equal(licence().subscription, 'active');
  await sync();
  await pull();
  assert.equal((await partner('/shifo/v1/clinic')).status, 200);

  // 6. Новый ПК (папка данных без файла ключа): новый ключ ждёт подтверждения, лицензия несёт прежний — обмен молчит.
  fs.rmSync(keyPath);
  fs.rmSync(keyPath + '.bak');
  assert.deepEqual(await sync(), { ok: false, reason: 'not_enabled' });
  const fresh = loadSyncIdentity({ keyPath });
  await checkin();
  assert.equal(licence().api_sync_key, identity.fingerprint);
  const pending = (await panel('GET', '/clinics/c-000777')).body.clinic.api;
  //    Перепроверка 8c, F4: панель не несёт отпечатка нового ключа — один кандидат, без соперников.
  assert.deepEqual([pending.key_pending, pending.key_competing, pending.candidates.length], [true, false, 1]);
  assert.equal((await panel('GET', '/clinics')).body.clinics[0].api_key_pending, true);
  //    Ревью 8c: сотрудник Easy-Med вводит код, который клиника читает со своего экрана «API» (api_sync_status key_code).
  const code = syncStatus(s.db, dataDir, { keyPath }).key_code;
  assert.equal(code, fresh.fingerprint.slice(0, 4) + '-' + fresh.fingerprint.slice(4, 8));
  assert.equal((await panel('POST', '/clinics/c-000777/api/accept-key', { fingerprint: fresh.fingerprint, code })).status, 200);
  await checkin();
  assert.equal(licence().api_sync_key, fresh.fingerprint);
  assert.equal((await sync()).ok, true);
  assert.equal(pub.db.prepare('SELECT key_fp FROM clinics').get().key_fp, fresh.fingerprint, 'публичный сервер узнал новый ключ из новой лицензии');

  // 7. Ключ обмена отозван (ПК украден): канал отвечает 401, партнёры — 503, следующая лицензия — без отпечатка.
  assert.equal((await panel('POST', '/clinics/c-000777/revocations', { kind: 'sync_key', value: fresh.fingerprint })).status, 201);
  await pull();
  assert.deepEqual(await sync(), { ok: false, reason: 'unauthorized' });
  assert.equal((await partner('/shifo/v1/clinic')).status, 503);
  await checkin();
  assert.equal('api_sync_key' in licence(), false);

  // 8. На сервере лицензий — только отпечатки: ни ключа партнёра, ни открытой половины ключа клиники.
  const dump = ['clinics', 'checkins', 'revocations'].map((tbl) => JSON.stringify(cp.prepare('SELECT * FROM ' + tbl).all())).join('\n');
  for (const secret of [s.key, s.secret, identity.signPublic, fresh.signPublic]) assert.ok(!dump.includes(secret));
  assert.ok(dump.includes(keyHash(s.key)) && dump.includes(fresh.fingerprint));
});
