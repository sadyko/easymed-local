// BRANCH_REISSUE_V1 — переустановленный компьютер филиала снова активируется.
//
// Проверяется не «ручка отвечает 200», а пять свойств, каждое из которых и
// есть смысл этой ручки:
//   1. новый код РАБОТАЕТ, а старый — нет, и оба ведут в ОДИН И ТОТ ЖЕ
//      clinic_id (иначе филиал вернулся бы новым клиентом с новым счётом);
//   2. прежняя установка гаснет: старый install_token больше не проходит
//      check-in — один филиал, один компьютер, а не две машины на одной
//      лицензии;
//   3. всё остальное на строке цело: подписка, unlock_secret, модули, имя,
//      родитель — филиал возвращается тем же самым филиалом;
//   4. чужой филиал, несуществующий id и погашенный филиал неотличимы снаружи
//      (один 404 на три случая) — иначе по различию ответов сеть перебирала бы
//      чужие clinic_id;
//   5. строк ручка не создаёт НИКОГДА, ни на успехе, ни на отказе.
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
import { listen } from '../test-helpers/listen.js';

// Харнесс — копия branch.route.test.js, до последней строчки: те же временные
// каталоги, тот же одноразовый ключ подписи, тот же listen(). Специально не
// вынесен в общий модуль — это тестовые леса двух соседних файлов, а не API.
const tmpDirs = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function useSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const p = path.join(tmpDir('cp-reissue-'), 'key.pem');
  fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = p;
}
test.after(() => {
  delete process.env.EASYMED_SIGNING_KEY;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

async function harness(t) {
  useSigningKey();
  const db = openDb(':memory:');
  migrate(db);
  const server = await listen(createApp(db));
  t.after(() => server.close());
  return { db, base: `http://127.0.0.1:${server.address().port}` };
}
function post(base, path_, body) {
  return fetch(base + path_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
// Главная клиника — заведена и активирована через сервис, тем же коротким
// путём, что и в branch.route.test.js.
function enrolMain(db, clinicId = 'c-main', name = 'Главная клиника') {
  const code = createEnrollmentCode(db, { clinicId, name });
  return redeemEnrollmentCode(db, { code }).install_token;
}
const makeBranch = (base, body) => post(base, '/cp/v1/branch', body);
const reissue = (base, clinicId, body) => post(base, `/cp/v1/branch/${clinicId}/reissue`, body);
const enroll = (base, code) => post(base, '/cp/v1/enroll', { code, fingerprint: 'fp-branch-pc' });
const checkin = (base, token) => post(base, '/cp/v1/checkin', { install_token: token, version: '1.0.0' });
const clinicCount = (db) => db.prepare('SELECT COUNT(*) n FROM clinics').get().n;

// Главная клиника + заведённый и УЖЕ АКТИВИРОВАННЫЙ филиал — то состояние, из
// которого филиал переустанавливают. Активация настоящая, через /cp/v1/enroll:
// именно она сжигает код, из-за чего вся эта ручка и существует.
async function withActivatedBranch(t) {
  const { db, base } = await harness(t);
  const mainToken = enrolMain(db);
  const created = await (await makeBranch(base, { install_token: mainToken, name: 'Филиал на Чиланзаре' })).json();
  const enrolled = await (await enroll(base, created.enrollment_code)).json();
  return { db, base, mainToken, branchId: created.clinic_id, oldCode: created.enrollment_code, oldToken: enrolled.install_token };
}

test('переустановленный филиал активируется новым кодом и остаётся тем же филиалом', async (t) => {
  const { db, base, mainToken, branchId, oldCode, oldToken } = await withActivatedBranch(t);
  const before = db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get(branchId);
  assert.equal(before.enrollment_code, null, 'код сгорел при первой активации — иначе тест ничего не доказывает');
  assert.equal(before.install_token, oldToken);
  const rowsBefore = clinicCount(db);

  const res = await reissue(base, branchId, { install_token: mainToken });
  assert.equal(res.status, 200);
  const body = await res.json();

  // Ответ той же формы, что и у создания филиала: клиенту нечего разбирать
  // по-новому, он показывает ключ связывания ровно так же.
  assert.deepEqual(Object.keys(body).sort(), ['clinic_id', 'enrollment_code', 'name']);
  assert.equal(body.clinic_id, branchId);
  assert.equal(body.name, 'Филиал на Чиланзаре');
  assert.match(body.enrollment_code, /^EM-[^-]{4}-[^-]{4}$/, 'тот же формат, что и при создании');
  assert.notEqual(body.enrollment_code, oldCode);

  const after = db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get(branchId);
  assert.equal(after.enrollment_code, body.enrollment_code);
  assert.equal(after.install_token, null, 'прежняя установка больше не может представиться этим филиалом');
  assert.equal(clinicCount(db), rowsBefore, 'перевыпуск не создаёт строк');

  // Старый код мёртв, новый — работает, и оба про ОДНУ клинику.
  assert.equal((await enroll(base, oldCode)).status, 400, 'сгоревший код так и остаётся сгоревшим');
  const second = await enroll(base, body.enrollment_code);
  assert.equal(second.status, 200);
  const activated = await second.json();
  assert.equal(activated.clinic_id, branchId, 'вернулся ТОТ ЖЕ филиал, а не новый клиент');
  assert.notEqual(activated.install_token, oldToken, 'у новой установки свой токен');
});

test('после перевыпуска старая установка перестаёт проходить check-in', async (t) => {
  const { base, mainToken, branchId, oldToken } = await withActivatedBranch(t);
  assert.equal((await checkin(base, oldToken)).status, 200, 'до перевыпуска старый компьютер жив');

  const { enrollment_code: fresh } = await (await reissue(base, branchId, { install_token: mainToken })).json();

  const dark = await checkin(base, oldToken);
  assert.equal(dark.status, 401, 'старый компьютер темнеет — иначе две машины делили бы один филиал');
  assert.deepEqual(await dark.json(), {
    error: { code: 'invalid_token', message: 'This install is not recognised.' },
  });

  // А новая установка живёт: перевыпуск не «ломает филиал», он его передаёт.
  const newToken = (await (await enroll(base, fresh)).json()).install_token;
  assert.equal((await checkin(base, newToken)).status, 200);
});

test('перевыпуск не трогает подписку, секрет разблокировки, модули, имя и родителя', async (t) => {
  const { db, base, mainToken, branchId } = await withActivatedBranch(t);
  db.prepare("UPDATE clinics SET subscription = 'unpaid', subscription_until = '2026-12-31' WHERE clinic_id = ?").run(branchId);
  db.prepare("INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, 'lab')").run(branchId);
  const before = db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get(branchId);

  // Неоплаченный филиал перевыпускается: 402 есть только у СОЗДАНИЯ филиала
  // («неоплаченная сеть не наращивает филиалы»), а поднять упавший компьютер
  // уже существующего филиала оплата не блокирует.
  const res = await reissue(base, branchId, { install_token: mainToken });
  assert.equal(res.status, 200);

  const after = db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get(branchId);
  assert.equal(after.unlock_secret, before.unlock_secret, 'телефонная разблокировка продолжает работать');
  assert.equal(after.subscription, 'unpaid', 'счёт филиала не обнуляется перевыпуском');
  assert.equal(after.subscription_until, before.subscription_until);
  assert.equal(after.name, before.name);
  assert.equal(after.parent_clinic_id, 'c-main');
  assert.equal(after.active, 1);
  assert.deepEqual(
    db.prepare('SELECT module_key FROM clinic_modules WHERE clinic_id = ?').all(branchId),
    [{ module_key: 'lab' }],
    'купленные модули на месте',
  );
});

test('чужой филиал, неизвестный id и погашенный филиал — один и тот же 404', async (t) => {
  const { db, base, mainToken, branchId } = await withActivatedBranch(t);
  const otherToken = enrolMain(db, 'c-other', 'Другая сеть');
  const rowsBefore = clinicCount(db);

  const foreign = await reissue(base, branchId, { install_token: otherToken });
  const unknown = await reissue(base, 'c-main-b99', { install_token: mainToken });
  const notABranch = await reissue(base, 'c-main', { install_token: mainToken }); // сама себе не филиал

  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(notABranch.status, 404);
  const bodies = await Promise.all([foreign.json(), unknown.json(), notABranch.json()]);
  assert.deepEqual(bodies[0], { error: 'not_found' });
  assert.deepEqual(bodies[0], bodies[1], 'по различию ответов нельзя перебирать чужие clinic_id');
  assert.deepEqual(bodies[1], bodies[2]);

  // Чужой сети отказали — и код филиала при этом остался нетронутым.
  assert.equal(db.prepare('SELECT enrollment_code FROM clinics WHERE clinic_id = ?').get(branchId).enrollment_code, null);
  assert.equal(clinicCount(db), rowsBefore, 'отказ ничего не создаёт');
});

test('погашенный филиал не перевыпускается', async (t) => {
  const { db, base, mainToken, branchId } = await withActivatedBranch(t);
  db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run(branchId);

  const res = await reissue(base, branchId, { install_token: mainToken });
  assert.equal(res.status, 404, 'снятый с обслуживания филиал не оживает через перевыпуск');
  assert.deepEqual(await res.json(), { error: 'not_found' });
  assert.equal(db.prepare('SELECT enrollment_code FROM clinics WHERE clinic_id = ?').get(branchId).enrollment_code, null);
});

test('филиал не перевыпускает коды — ни себе, ни соседям', async (t) => {
  const { db, base, mainToken, branchId, oldToken: branchToken } = await withActivatedBranch(t);
  const sibling = await (await makeBranch(base, { install_token: mainToken })).json();

  const self = await reissue(base, branchId, { install_token: branchToken });
  const neighbour = await reissue(base, sibling.clinic_id, { install_token: branchToken });
  assert.equal(self.status, 404, 'у филиала нет филиалов — значит и перевыпускать ему нечего');
  assert.equal(neighbour.status, 404);
  assert.equal(
    db.prepare('SELECT enrollment_code FROM clinics WHERE clinic_id = ?').get(sibling.clinic_id).enrollment_code,
    sibling.enrollment_code,
    'код соседнего филиала не сменился',
  );
});

test('чужой и пустой install_token получают тот же 401, что и при создании филиала', async (t) => {
  const { base, mainToken, branchId } = await withActivatedBranch(t);

  const unknown = await reissue(base, branchId, { install_token: 'not-a-real-token' });
  const missing = await reissue(base, branchId, {});
  const create401 = await makeBranch(base, {});

  assert.equal(unknown.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(create401.status, 401);
  const bodies = await Promise.all([unknown.json(), missing.json(), create401.json()]);
  assert.deepEqual(bodies[0], bodies[1],
    'по различию ответов нельзя перебирать живые install_token');
  assert.deepEqual(bodies[1], bodies[2],
    'та же аутентификация, что и у создания филиала — значит и тот же отказ');

  // Отказ в аутентификации происходит ДО поиска филиала: неизвестный токен
  // получает 401, а не 404, поэтому чужак не может даже проверить, существует
  // ли такой clinic_id.
  const probe = await reissue(base, 'c-nobody-b1', { install_token: 'not-a-real-token' });
  assert.equal(probe.status, 401);
});
