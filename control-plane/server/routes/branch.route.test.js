// BRANCH_SELF_SERVICE_V1 — главная клиника заводит филиал сама.
//
// Здесь проверяется не «ручка отвечает 200», а четыре свойства, каждое из
// которых легко потерять при следующей правке:
//   1. филиал — ОТДЕЛЬНАЯ клиника со своей подпиской и своим кодом активации
//      (иначе «у филиала своя подписка» перестанет быть правдой, а счёт сети
//      молча схлопнется в один);
//   2. выданный код действительно активирует — он проходит обычный enroll;
//   3. чужой/пустой install_token получает ТОТ ЖЕ 401, что и неизвестный —
//      иначе по различию ответов можно перебирать живые токены;
//   4. неоплаченная сеть не наращивает филиалы, и филиал не заводит филиалов.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../services/enrollment.js';
import { createApp } from '../app.js';

const tmpDirs = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function useSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const p = path.join(tmpDir('cp-branch-'), 'key.pem');
  fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = p;
}
test.after(() => {
  delete process.env.EASYMED_SIGNING_KEY;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
async function harness(t) {
  useSigningKey();
  const db = openDb(':memory:');
  migrate(db);
  const server = await listen(createApp(db));
  t.after(() => server.close());
  return { db, base: `http://127.0.0.1:${server.address().port}` };
}
function enrol(db, clinicId = 'c-main', name = 'Главная клиника') {
  const code = createEnrollmentCode(db, { clinicId, name });
  return redeemEnrollmentCode(db, { code }).install_token;
}
const makeBranch = (base, body) => fetch(base + '/cp/v1/branch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('филиал создаётся отдельной клиникой со своей подпиской и своим кодом', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);

  const res = await makeBranch(base, { install_token: token, name: 'Филиал на Чиланзаре' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.match(body.clinic_id, /^c-main-b1$/);
  assert.equal(body.name, 'Филиал на Чиланзаре');
  assert.match(body.enrollment_code, /^EM-/);

  const row = db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get(body.clinic_id);
  assert.equal(row.parent_clinic_id, 'c-main', 'видно, чей это филиал');
  assert.equal(row.subscription, 'active');
  assert.notEqual(row.unlock_secret, null, 'у филиала свой секрет разблокировки');
  // Своя строка — значит и свой счёт: подписку филиала можно закрыть, не трогая сеть.
  assert.notEqual(row.clinic_id, 'c-main');
});

test('выданный код действительно активирует филиал', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  const { enrollment_code: code } = await (await makeBranch(base, { install_token: token })).json();

  const redeemed = redeemEnrollmentCode(db, { code });
  assert.ok(redeemed && redeemed.install_token, 'код проходит обычный enroll');
  assert.notEqual(redeemed.install_token, token, 'у филиала СВОЙ install_token');
});

test('второй филиал получает следующий номер', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  const a = await (await makeBranch(base, { install_token: token })).json();
  const b = await (await makeBranch(base, { install_token: token })).json();
  assert.equal(a.clinic_id, 'c-main-b1');
  assert.equal(b.clinic_id, 'c-main-b2');
});

test('чужой и пустой install_token получают одинаковый 401', async (t) => {
  const { base } = await harness(t);
  const unknown = await makeBranch(base, { install_token: 'not-a-real-token' });
  const missing = await makeBranch(base, {});
  assert.equal(unknown.status, 401);
  assert.equal(missing.status, 401);
  assert.deepEqual(await unknown.json(), await missing.json(),
    'по различию ответов нельзя перебирать живые токены');
});

test('неоплаченная сеть не наращивает филиалы', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = 'c-main'").run();
  const res = await makeBranch(base, { install_token: token });
  assert.equal(res.status, 402);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clinics').get().n, 1, 'ничего не создано');
});

test('филиал не заводит филиалов', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  const { enrollment_code: code } = await (await makeBranch(base, { install_token: token })).json();
  const branchToken = redeemEnrollmentCode(db, { code }).install_token;

  const res = await makeBranch(base, { install_token: branchToken });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'branch_of_branch' });
});
