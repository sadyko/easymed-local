// PUBLIC_API_V1 — СКВОЗНОЙ ПРОГОН СТОРОНЫ КЛИНИКИ с поддельным публичным
// сервером: логотип уходит файлом по отпечатку; два партнёра на одно время —
// первый держит, второй получает отказ в том же такте; регистратор
// подтверждает — один визит той же дверью, что у регистратуры, партнёр
// получает подписанное уведомление; пациент отменяет у партнёра — визит
// отменён календарём, партнёр получает «appointment.cancelled». Данные
// пациента не уходят наружу ни в одном запросе.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bookingSeed, localAt } from '../../test-helpers/api-booking-seed.js';
import { fakePublicServer } from '../../test-helpers/fake-public-server.js';
import { fakePng } from '../../test-helpers/fake-png.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { loadSyncIdentity, SYNC_KEY_FILE } from './sync-identity.js';
import { syncOnce } from './public-sync.js';
import { confirmBooking } from './bookings.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');

test('сквозной прогон: файлы, две заявки на одно время, подтверждение, отмена пациентом; наружу — без данных пациента', async () => {
  const s = bookingSeed();
  const dataDir = tmpDir('em-psync-e2e-');
  const keyPath = path.join(dataDir, SYNC_KEY_FILE);
  const identity = loadSyncIdentity({ keyPath, create: true });
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({ clinic_id: 'c-000777' }));
  fs.writeFileSync(path.join(dataDir, 'licence.dat'), JSON.stringify({ payload: { clinic_id: 'c-000777', valid_until: '2030-04-01T00:00:00Z', api_sync_key: identity.fingerprint }, sig: 'AAAA' }));
  const storage = path.join(dataDir, 'storage');
  fs.mkdirSync(path.join(storage, 'clinic-logos', 'square'), { recursive: true });
  const png = fakePng(256, 256);
  fs.writeFileSync(path.join(storage, 'clinic-logos', 'square', 'l.png'), png);
  s.db.prepare("UPDATE doc_settings SET logo_square_path = 'square/l.png' WHERE id = 1").run();
  const fake = fakePublicServer({ signPublic: identity.signPublic });
  let clock = NOW;
  const opts = { fetchImpl: fake.fetchImpl, env: fake.env, now: () => clock, keyPath, kekPath: s.kekPath, storageDir: storage };
  const wire = [];
  const spy = async (url, o) => { wire.push(String(o && o.body != null ? (Buffer.isBuffer(o.body) ? '' : o.body) : '')); return fake.fetchImpl(url, o); };
  const run = () => syncOnce(s.db, dataDir, { ...opts, fetchImpl: spy });

  await run();
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  assert.ok(fake.state.calls.includes('POST /_sync/v1/media/check'));
  assert.deepEqual(fake.state.media.get(sha), png);
  assert.equal(fake.state.snapshots[0].clinic.logo.square, 'media/' + sha + '.png');

  const item = (pub, ext, name, phone) => fake.enqueue({ type: 'appointment.new', public_id: pub, connection_id: s.connId,
    received_at: new Date(clock - 20000).toISOString(),
    data: { external_id: ext, doctor_id: 7, consultation: 'initial', start: new Date(START).toISOString() } }, { name, phone, comment: 'КОММЕНТАРИЙ_ПАЦИЕНТА' });
  item('rq_first0001', 'med-1', 'ИМЯ_ПЕРВОГО', '+998901111111');
  item('rq_secnd0001', 'med-2', 'ИМЯ_ВТОРОГО', '+998902222222');
  clock += 15000;
  const t2 = await run();
  assert.equal(t2.applied, 2);
  const declined = fake.state.events.find((e) => JSON.parse(e.body).request_id === 'rq_secnd0001');
  assert.deepEqual([declined.event, JSON.parse(declined.body).reason], ['booking.declined', 'slot_taken'], 'второй — отказ в том же такте');

  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'ИМЯ_ПЕРВОГО', '+998901111111')").run();
  const first = s.db.prepare("SELECT id FROM api_requests WHERE public_id = 'rq_first0001'").get().id;
  const c = await confirmBooking(s.db, { id: first, patientId: 1 }, s.reg, { now: clock, kekPath: s.kekPath });
  clock += 15000;
  await run();
  const confirmed = fake.state.events.find((e) => e.event === 'booking.confirmed');
  assert.equal(confirmed.signature, 'sha256=' + crypto.createHmac('sha256', s.secret).update(confirmed.body).digest('hex'),
    'партнёр проверит подпись секретом, который ему передал администратор');

  fake.enqueue({ type: 'appointment.cancel', public_id: 'rq_first0001', connection_id: s.connId });
  clock += 15000;
  await run();
  assert.equal(s.db.prepare('SELECT status FROM visits WHERE id = ?').get(c.visit.id).status, 'cancelled');
  assert.ok(fake.state.events.some((e) => e.event === 'appointment.cancelled' && JSON.parse(e.body).request_id === 'rq_first0001'));
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 1, 'ровно один визит за весь прогон');

  const out = wire.join('\n');
  for (const mark of ['ИМЯ_ПЕРВОГО', 'ИМЯ_ВТОРОГО', '998901111111', '998902222222', 'КОММЕНТАРИЙ_ПАЦИЕНТА', 'P-1']) {
    assert.ok(!out.includes(mark), 'наружу ушло: ' + mark);
  }
});
