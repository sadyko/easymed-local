// PUBLIC_API_V1 — ежечасная сверка с сервером лицензий несёт ОТКРЫТУЮ половину
// ключа подписи клиники для публичного сервера, если ключ уже создан; закрытой
// половины в теле нет; нет файла или он испорчен — поля нет, сверка идёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { runCheckin } from './checkin.js';
import { loadSyncIdentity, SYNC_KEY_FILE } from '../api/sync-identity.js';

function clinic() {
  const dir = tmpDir('em-checkin-sync-');
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ clinic_id: 'c-000047', install_token: 'TESTONLY-token' }));
  const db = openDb(':memory:');
  migrate(db);
  return { dir, db };
}
async function sentBody(c) {
  let body = null;
  const fetchImpl = async (_url, opts) => { body = JSON.parse(opts.body); return { ok: false, status: 500, text: async () => '', body: null }; };
  await runCheckin(c.db, c.dir, { fetchImpl, endpoint: 'https://cp.test.local' });
  return body;
}

test('ключа нет — поля нет; ключ есть — открытая половина; закрытой половины в теле нет', async () => {
  const c = clinic();
  const before = await sentBody(c);
  assert.equal(before.install_token, 'TESTONLY-token');
  assert.equal('api_sync_public_key' in before, false);
  const id = loadSyncIdentity({ keyPath: path.join(c.dir, SYNC_KEY_FILE), create: true });
  const after = await sentBody(c);
  assert.equal(after.api_sync_public_key, id.signPublic);
  const file = JSON.parse(fs.readFileSync(path.join(c.dir, SYNC_KEY_FILE), 'utf8'));
  const raw = JSON.stringify(after);
  assert.ok(!raw.includes(file.sign) && !raw.includes(file.box), 'закрытые половины не уходят');
});

test('файл ключа испорчен — сверка идёт без поля', async () => {
  const c = clinic();
  fs.writeFileSync(path.join(c.dir, SYNC_KEY_FILE), 'испорчено');
  fs.writeFileSync(path.join(c.dir, SYNC_KEY_FILE + '.bak'), 'испорчено');
  const body = await sentBody(c);
  assert.equal(body.install_token, 'TESTONLY-token');
  assert.equal('api_sync_public_key' in body, false);
});
