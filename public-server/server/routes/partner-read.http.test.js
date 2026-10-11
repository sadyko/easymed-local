// PUBLIC_SERVER_V1 — адреса партнёров, чтение и вход: ответы по документации
// макета (?lang, адрес из справочника, as_of, stale), ключ по отпечатку, права,
// IP, сайт, лимиты с Retry-After, 503 при лицензии и молчащей клинике, файлы
// снимка без ключа, журнал запросов без присланного.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { partnerStand } from '../test-helpers/partner-stand.js';
import { NOW } from '../test-helpers/fixture.js';
import { admitClinic, saveSnapshot, clinicRow } from '../store/clinics.js';
import { putMedia } from '../store/media.js';
import { fakePng } from '../../../server/test-helpers/fake-png.js';
import { isoOf } from '../lib/time.js';

const json = async (res) => ({ status: res.status, body: await res.json(), headers: res.headers });

test('клиника, филиалы, врачи, услуги, пакеты: ?lang, пустой перевод — русский, адрес из справочника, as_of', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const clinic = await json(await s.get('/shifo/v1/clinic?lang=uz'));
  assert.equal(clinic.status, 200);
  assert.equal(clinic.body.name, 'Shifo');
  assert.equal(clinic.body.about, 'Семейная клиника', 'пустой узбекский — русский');
  assert.equal(clinic.body.address, 'Toshkent shahri, Yunusobod tumani, Mira ko‘chasi, 1');
  assert.equal(clinic.body.as_of, '2030-03-11T09:00:00+05:00');
  const all = await json(await s.get('/shifo/v1/clinic'));
  assert.deepEqual(all.body.name, { ru: 'Шифо', uz: 'Shifo', en: 'Шифо' });
  assert.equal(all.body.address.ru, 'город Ташкент, Юнусабадский район, ул. Мира, 1');
  const br = await json(await s.get('/shifo/v1/branches?district=mirobod&lang=ru'));
  assert.deepEqual(br.body.branches.map((b) => b.id), [2]);
  assert.deepEqual(br.body.branches[0].hours.sun, null);
  const docs = await json(await s.get('/shifo/v1/doctors?specialty=pediatr&lang=en'));
  assert.deepEqual(docs.body.doctors.map((d) => d.id), [7]);
  assert.equal(docs.body.doctors[0].consultations[0].price, 150000);
  assert.equal(docs.body.doctors[0].consultations[0].name, 'Первичный приём', 'пустой английский — русский');
  assert.deepEqual((await json(await s.get('/shifo/v1/doctors?district=mirobod'))).body.doctors.map((d) => d.id), [8]);
  const svc = await json(await s.get('/shifo/v1/services?group=lab'));
  assert.deepEqual(svc.body.services.map((x) => [x.id, x.group, x.price]), [[301, 'lab', 45000]]);
  assert.equal((await s.get('/shifo/v1/services?group=chto')).status, 400);
  const pk = await json(await s.get('/shifo/v1/packages'));
  assert.deepEqual(pk.body.packages.map((p) => p.id), [4], 'истёкший пакет не приходит');
  assert.equal((await s.get('/shifo/v1/doctors?lang=de')).status, 400);
});

test('свободное время: окна дня, приём N окон подряд, без даты — все дни, живая очередь, stale через 10 минут', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const day = await json(await s.get('/shifo/v1/slots?doctor_id=7&date=2030-03-12'));
  assert.deepEqual(day.body.slots.map((w) => [w.start, w.free]), [['09:00', true], ['09:15', true], ['09:30', true], ['09:45', false], ['10:00', true], ['10:15', true]]);
  assert.equal(day.body.stale, false);
  const fit = await json(await s.get('/shifo/v1/slots?doctor_id=7&date=2030-03-12&consultation=initial'));
  assert.deepEqual(fit.body.slots.map((w) => w.start), ['09:00', '09:15', '10:00'], '30 минут — два свободных окна подряд');
  const days = await json(await s.get('/shifo/v1/slots?doctor_id=7'));
  assert.deepEqual(days.body.days.map((d) => d.date), ['2030-03-12']);
  const live = await json(await s.get('/shifo/v1/slots?doctor_id=8'));
  assert.deepEqual([live.body.reception, live.body.queue_now, live.body.hours.mon], ['live_queue', 3, ['08:00', '14:00']]);
  assert.equal((await s.get('/shifo/v1/slots?doctor_id=99')).status, 404);
  assert.equal((await s.get('/shifo/v1/slots')).status, 400);
  assert.equal((await s.get('/shifo/v1/slots?doctor_id=7&consultation=repeat')).status, 200);
  s.setClock(NOW + 11 * 60000);
  const old = await json(await s.get('/shifo/v1/slots?doctor_id=7&date=2030-03-12'));
  assert.equal(old.body.stale, true, 'клиника молчит дольше 10 минут — последнее известное с пометкой');
  assert.equal(old.body.as_of, '2030-03-11T09:00:00+05:00');
});

test('справочники — любым ключом, с ?lang', async (t) => {
  const s = await partnerStand({ scopes: ['clinic'] });
  t.after(s.close);
  const geo = await json(await s.get('/shifo/v1/reference/geo?lang=en'));
  assert.equal(geo.body.cities.find((c) => c.slug === 'tashkent-city').name, 'Tashkent city');
  const sp = await json(await s.get('/shifo/v1/reference/specialties'));
  assert.ok(sp.body.specialties.find((x) => x.slug === 'pediatr').name.uz);
});

test('ключ: нет, чужой, выключен, истёк — 401 своим кодом; права — 403; клиники нет — 404', async (t) => {
  const s = await partnerStand({ scopes: ['clinic', 'doctors'] });
  t.after(s.close);
  const code = async (res) => (await res.json()).error.code;
  assert.equal(await code(await s.get('/shifo/v1/clinic', { auth: false })), 'invalid_key');
  assert.equal(await code(await s.get('/shifo/v1/clinic', { auth: false, headers: { Authorization: 'Bearer em_live_TESTONLYxxxxxxxxxxxxxxxxxxxxxxxxx' } })), 'invalid_key');
  const scoped = await json(await s.get('/shifo/v1/services'));
  assert.deepEqual([scoped.status, scoped.body.error.code, scoped.body.error.scope], [403, 'forbidden_scope', 'services']);
  assert.equal((await s.get('/nikto/v1/clinic')).status, 404);
  s.setConnection({ active: false });
  const off = await json(await s.get('/shifo/v1/clinic'));
  assert.deepEqual([off.status, off.body.error.code], [401, 'key_disabled']);
  s.setConnection({ key_expires_at: isoOf(NOW - 1000) });
  assert.equal(await code(await s.get('/shifo/v1/clinic')), 'key_expired');
});

test('«Разрешённые IP» (за nginx — X-Forwarded-For) и сайт (CORS): чужой — 403; свой — да, с Access-Control-Allow-Origin', async (t) => {
  const s = await partnerStand({ trustProxy: 'loopback', connection: { ip_allow: ['203.0.113.0/24'] } });
  t.after(s.close);
  assert.equal((await s.get('/shifo/v1/clinic', { headers: { 'X-Forwarded-For': '203.0.113.7' } })).status, 200);
  const deny = await json(await s.get('/shifo/v1/clinic', { headers: { 'X-Forwarded-For': '198.51.100.9' } }));
  assert.deepEqual([deny.status, deny.body.error.code], [403, 'ip_not_allowed']);
  const site = await s.get('/shifo/v1/clinic', { headers: { 'X-Forwarded-For': '203.0.113.7', Origin: 'https://med24.uz' } });
  assert.deepEqual([site.status, site.headers.get('access-control-allow-origin')], [200, 'https://med24.uz']);
  const evil = await json(await s.get('/shifo/v1/clinic', { headers: { 'X-Forwarded-For': '203.0.113.7', Origin: 'https://evil.example' } }));
  assert.deepEqual([evil.status, evil.body.error.code, evil.headers.get('access-control-allow-origin')], [403, 'origin_not_allowed', null]);
  const pre = await fetch(s.base + '/shifo/v1/appointments', { method: 'OPTIONS', headers: { Origin: 'https://med24.uz', 'Access-Control-Request-Method': 'POST' } });
  assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-headers')],
    [204, 'https://med24.uz', 'Authorization, Content-Type']);
  assert.equal((await fetch(s.base + '/shifo/v1/clinic', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('лимит ключа: сверх rate_limit в минуту — 429 с Retry-After; неверные ключи с одного IP — тоже', async (t) => {
  const s = await partnerStand({ connection: { rate_limit: 30 } });
  t.after(s.close);
  for (let i = 0; i < 30; i += 1) assert.equal((await s.get('/shifo/v1/clinic')).status, 200, 'запрос ' + (i + 1));
  const over = await json(await s.get('/shifo/v1/clinic'));
  assert.deepEqual([over.status, over.body.error.code], [429, 'rate_limited']);
  assert.ok(Number(over.headers.get('retry-after')) >= 1);
  let last;
  for (let i = 0; i < 31; i += 1) last = await s.get('/shifo/v1/clinic', { auth: false });
  assert.equal(last.status, 429, 'перебор ключей с одного адреса');
});

test('503: «не оплачено» в лицензии, срок вышел, клиника молчит 7 суток — «временно недоступна» с телефоном клиники', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const auth = (licence) => ({ clinicId: s.clinicId, fingerprint: s.clinic.identity.fingerprint, licence });
  admitClinic(s.db, auth({ issued_at: '2030-03-10T12:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'unpaid' }), NOW);
  const unpaid = await json(await s.get('/shifo/v1/doctors'));
  assert.deepEqual([unpaid.status, unpaid.body.error.code, unpaid.body.error.phone], [503, 'licence_lapsed', '+998712000000']);
  assert.ok(!/оплат/i.test(unpaid.body.error.message), 'не «не оплатила» — «временно недоступна»');
  admitClinic(s.db, auth({ issued_at: '2030-03-10T13:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active' }), NOW);
  assert.equal((await s.get('/shifo/v1/doctors')).status, 200, 'продлили — снова видна');
  s.setClock(Date.parse('2030-04-01T00:00:01Z'));
  assert.equal((await json(await s.get('/shifo/v1/doctors'))).body.error.code, 'licence_lapsed');
  s.db.prepare("UPDATE clinics SET licence_valid_until = '2031-01-01T00:00:00Z'").run();
  s.setClock(NOW + 8 * 86400000);
  assert.equal((await json(await s.get('/shifo/v1/doctors'))).body.error.code, 'clinic_offline');
});

test('файлы снимка: без ключа, только из текущего снимка, вид не угадывается; прежнее имя клиники 30 дней', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const png = fakePng(16, 16);
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  putMedia(s.db, s.dir, s.clinicId, sha, 'png', png, NOW);
  assert.equal((await fetch(s.base + '/shifo/v1/media/' + sha + '.png')).status, 404, 'в снимке ещё нет');
  const snap = JSON.parse(clinicRow(s.db, s.clinicId).snapshot);
  saveSnapshot(s.db, s.clinicId, { ...snap, generated_at: isoOf(NOW + 1000), slug: 'shifo-med', clinic: { ...snap.clinic, logo: { square: 'media/' + sha + '.png', portrait: null } } }, NOW + 1000);
  const clinic = await json(await s.get('/shifo-med/v1/clinic'));
  assert.equal(clinic.body.logo.square, 'https://api.test/shifo-med/v1/media/' + sha + '.png');
  const img = await fetch(s.base + '/shifo/v1/media/' + sha + '.png');
  assert.deepEqual([img.status, img.headers.get('content-type'), img.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
});

test('журнал запросов: известный путь и параметры верного вида; присланное сверх — нет', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  await s.get('/shifo/v1/doctors?lang=ru&specialty=pediatr&name=ИМЯ_ПАЦИЕНТА');
  await s.get('/shifo/v1/ИМЯ_В_ПУТИ');
  await s.get('/shifo/v1/clinic', { auth: false });
  // Город, район, специальность — в журнал только кодом справочника: телефон в фильтре похож на «верный вид» [a-z0-9-].
  await s.get('/shifo/v1/doctors?specialty=998907654321&district=998907654321&city=tashkent-city');
  const rows = s.db.prepare('SELECT connection_id, method, path, status FROM access_log ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.connection_id, r.path, r.status]), [
    [3, '/shifo/v1/doctors?lang=ru&specialty=pediatr', 200],
    [3, '/shifo/v1/?', 404],
    [null, '/shifo/v1/clinic', 401],
    [3, '/shifo/v1/doctors?city=tashkent-city', 200],
  ]);
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM access_log').all()).includes('ИМЯ'));
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM access_log').all()).includes('998907654321'));
  assert.ok(s.db.prepare('SELECT last_used_at FROM connections').get().last_used_at, '«последний запрос» отмечен');
});

test('только https: за nginx — X-Forwarded-Proto: https; иначе 400', async (t) => {
  const s = await partnerStand({ requireHttps: true, trustProxy: 'loopback' });
  t.after(s.close);
  assert.equal((await s.get('/shifo/v1/clinic')).status, 400);
  assert.equal((await s.get('/shifo/v1/clinic', { headers: { 'X-Forwarded-Proto': 'https' } })).status, 200);
});
