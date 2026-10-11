// PUBLIC_API_V1 — RPC онлайн-записи через настоящее приложение: при живой
// лицензии регистратура видит и подтверждает; при непродлённой — видит, но
// решения отвечают 402 (как любая запись); удержание чужой заявки из браузера
// не снять — ensure_visit с присланным номером удержания отвечает «время занято».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createApp } from '../app.js';
import { hashPassword } from '../services/auth.js';
import { canonical } from '../services/control/canonical.js';
import { __setPublicKeyForTests } from '../services/control/state.js';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { bookingSeed, localAt, apptItem } from '../test-helpers/api-booking-seed.js';
import { ingestItem } from '../services/api/bookings.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
__setPublicKeyForTests(publicKey);
function dataDir(validUntil) {
  const dir = tmpDir('em-apibk-http-');
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ clinic_id: 'c-1', unlock_secret: 's', subscription: 'active' }));
  const payload = { clinic_id: 'c-1', clinic_name: 'T', modules: [], valid_until: validUntil, issued_at: '2026-08-01T00:00:00Z', nonce: 'n' };
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify({ payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64') }));
  return dir;
}
const day = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const START = localAt(day, '10:00');

async function start(validUntil) {
  const s = bookingSeed();
  s.db.prepare('UPDATE users SET booking_days = 30 WHERE id = 7').run();
  s.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = 2').run(hashPassword('password2'));
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: Date.now() - 1000 }), { kekPath: s.kekPath });
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const server = await listen(createApp(s.db, { dataDir: dataDir(validUntil) }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reg', password: 'password2' }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const rpc = async (name, body) => {
    const res = await fetch(base + '/api/rpc/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body || {}) });
    return { status: res.status, json: await res.json() };
  };
  const card = s.db.prepare('SELECT crm_request_id AS c FROM api_requests WHERE id = ?').get(r.id).c;
  return { s, server, rpc, id: r.id, card };
}

test('живая лицензия: регистратура видит и подтверждает; присланный номер удержания в ensure_visit — не действует', async (t) => {
  const x = await start('2099-01-01T00:00:00Z');
  t.after(() => x.server.close());
  const list = await x.rpc('api_booking_list', { crm_request_id: x.card });
  assert.equal(list.status, 200);
  assert.equal(list.json.data.items[0].status, 'pending');
  const hold = x.s.db.prepare('SELECT id FROM slot_holds WHERE api_request_id = ?').get(x.id).id;
  const sneak = await x.rpc('ensure_visit', { patient_id: 1, date: day, book: { doctor_id: 7, start: new Date(START).toISOString(), duration_minutes: 30, exclude_hold_id: hold } });
  assert.equal(sneak.status, 409);
  assert.equal(sneak.json.error.code, 'slot_taken');
  const ok = await x.rpc('api_booking_confirm', { id: x.id, patient_id: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.status, 'confirmed');
});

test('лицензия не продлена: видно, но решения — 402', async (t) => {
  const x = await start('2020-01-01T00:00:00Z');
  t.after(() => x.server.close());
  assert.equal((await x.rpc('api_booking_list', { crm_request_id: x.card })).status, 200);
  assert.equal((await x.rpc('api_board_marks', {})).status, 200);
  const res = await x.rpc('api_booking_confirm', { id: x.id, patient_id: 1 });
  assert.equal(res.status, 402);
  assert.equal(res.json.error.code, 'licence_locked');
  assert.equal(x.s.db.prepare('SELECT status FROM api_requests WHERE id = ?').get(x.id).status, 'pending');
});
