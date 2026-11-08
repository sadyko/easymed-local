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
  const mk = (status, body) => async (url, opts) => { seen.push({ url, body: JSON.parse(opts.body) }); return { ok: status < 400, status, json: async () => body }; };
  const dir = dataDirWith({ install_token: 'tok' });
  const ok = await askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp/', fetchImpl: mk(200, { outcome: 'reply', text: 'Здравствуйте' }) });
  assert.deepEqual(ok, { outcome: 'reply', text: 'Здравствуйте' });
  assert.equal(seen[0].url, 'http://cp' + AI_PATH);
  assert.equal(seen[0].body.install_token, 'tok');
  assert.deepEqual(await askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp', fetchImpl: mk(402, { error: { code: 'limit' } }) }), { error: 'limit' });
  assert.deepEqual(await askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp', fetchImpl: mk(402, { error: { code: 'no_module' } }) }), { error: 'no_module' });
  assert.deepEqual(await askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), { error: 'network' });
  assert.deepEqual(await askControlPlane(payload, { dataDir: dir, endpoint: 'http://cp', fetchImpl: mk(200, { outcome: 'dance' }) }), { error: 'bad_response' });
});
