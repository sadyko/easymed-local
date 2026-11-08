import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askControlPlane, AI_PATH } from './cp-client.js';

function dataDirWith(identity) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-ai-cp-'));
  if (identity) fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(identity));
  return dir;
}
const payload = { channel: 'telegram', transcript: [{ from: 'patient', text: 'hi' }], patient_name: 'A', post_text: '', facts: {} };

test('нет install_token — запроса нет', async () => {
  let called = 0;
  const r = await askControlPlane(payload, { dataDir: dataDirWith(null), endpoint: 'http://cp', fetchImpl: async () => { called++; } });
  assert.deepEqual(r, { error: 'not_enrolled' });
  assert.equal(called, 0);
});

test('отправляет install_token и разбирает ответ и отказы', async () => {
  const seen = [];
  const mk = (status, body) => async (url, opts) => { seen.push({ url, body: JSON.parse(opts.body), headers: opts.headers }); return { ok: status < 400, status, json: async () => body }; };
  const dir = dataDirWith({ install_token: 'tok' });
  const ok = await askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp/', fetchImpl: mk(200, { outcome: 'reply', text: 'Здравствуйте' }) });
  assert.deepEqual(ok, { outcome: 'reply', text: 'Здравствуйте' });
  assert.equal(seen[0].url, 'http://cp' + AI_PATH);
  assert.equal(seen[0].headers['X-Install-Token'], 'tok');
  assert.ok(!('install_token' in seen[0].body), 'токена в теле нет');
  assert.deepEqual(await askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp', fetchImpl: mk(402, { error: { code: 'limit' } }) }), { error: 'limit' });
  assert.deepEqual(await askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp', fetchImpl: mk(402, { error: { code: 'no_module' } }) }), { error: 'no_module' });
  assert.deepEqual(await askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), { error: 'network' });
  assert.deepEqual(await askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp', fetchImpl: mk(200, { outcome: 'dance' }) }), { error: 'bad_response' });
});

test('413 — слишком большой запрос; кривая форма ответа — bad_response', async () => {
  const dir = dataDirWith({ install_token: 'tok' });
  const mk = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
  const ask = (status, body) => askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp', fetchImpl: mk(status, body) });
  assert.deepEqual(await ask(413, {}), { error: 'too_large' });
  // 400 не пройдёт и при повторе (нет реплики пациента и т. п.) — передача, без повтора;
  // 503 и прочие 5xx — сбой у Anthropic или сервера управления, очередь повторит.
  assert.deepEqual(await ask(400, { error: { code: 'bad_request' } }), { error: 'bad_response' });
  assert.deepEqual(await ask(503, { error: { code: 'upstream' } }), { error: 'network' });
  assert.deepEqual(await ask(500, null), { error: 'network' });
  const good = [
    { outcome: 'reply', text: 'Да' },
    { outcome: 'reply_comment', public_text: 'a', private_text: 'b' },
    { outcome: 'create_lead', text: 'ok', name: '', phone: '', wish: '' },
    { outcome: 'hand_off', text: '' },
  ];
  for (const g of good) assert.deepEqual(await ask(200, g), g);
  const bad = [
    { outcome: 'reply' }, { outcome: 'reply', text: '  ' }, { outcome: 'reply', text: 5 },
    { outcome: 'reply_comment', public_text: 'a' }, { outcome: 'reply_comment', public_text: '', private_text: 'b' },
    { outcome: 'create_lead', text: 'ok', name: 'x', phone: 'y' }, { outcome: 'create_lead', text: '', name: '', phone: '', wish: '' },
    { outcome: 'hand_off' }, { outcome: 'hand_off', text: null },
  ];
  for (const b of bad) assert.deepEqual(await ask(200, b), { error: 'bad_response' }, JSON.stringify(b));
});
