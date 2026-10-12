// PUBLIC_LICENCE_V1 — СЕРВЕР ЛИЦЕНЗИЙ 8c И НАСТОЯЩИЕ КЛИНИКИ НА ВЫПУСКЕ v3.16.0.
//
// Клиники в работе стоят на v3.16.0 (тег v3.16.0): проверяющий лицензии,
// ежечасная сверка, состояние лицензии и лестница блокировки у них — версии
// тега, а не этого дерева. Тест берёт ИХ код из тега (git show v3.16.0:… во
// временную папку, по цепочке import) и гоняет его против НОВОГО сервера
// лицензий по HTTP:
//   (а) лицензия с новыми полями (subscription, api_sync_key) проверяется и
//       ложится в licence.dat, как прислана; клиника видит то же, что с
//       классической шестиключевой лицензией того же срока;
//   (б) неоплаченная клиника: сервер лицензий 8c, как и прежде, лицензии ей не
//       присылает (licence: null). Клиника v3.16.0 видит и делает РОВНО то же,
//       что при прежнем ответе: тот же день блокировки, те же плашки на каждом
//       дне лестницы, лестница не сбрасывается, тот же список модулей и то же
//       имя (иначе «Система → Проверить обновления» скажет «Лицензия обновлена
//       — страница перезагрузится.») — и когда в панели у неоплаченной меняют
//       модули или имя;
//   (в) лицензия, выданная руками (scripts/make-licence.mjs), не укорачивается.
//
// ПОЧЕМУ ТАК (решение 2026-10-12, план 8c Р14). План сначала выдавал
// неоплаченной клинике лицензию «unpaid» с тем же сроком — ради отметки оплаты
// для публичного сервера. Этот тест показал, что клиника v3.16.0 такую
// лицензию ЗАМЕЧАЕТ: модули и имя из панели доходят до неоплаченной, день
// блокировки сдвигается, если последняя выданная лицензия до клиники не дошла,
// а лицензия, выданная руками на 60 дней, укорачивалась до 14. Отметку оплаты
// публичному серверу теперь несёт только список производителя
// (routes/public-feed.js): неоплаченную партнёры не видят через минуту.
//
// «Как при прежнем ответе» — не догадка, а БЛИЗНЕЦ. Перед сверкой папка
// клиники копируется; копия проходит ту же сверку v3.16.0 с ТЕМ ЖЕ ответом
// сервера, в котором licence заменено на null — ровно прежний ответ
// неоплаченной клинике (subscription 'unpaid', collect и update те же).
// Затем состояние обеих сравнивается в каждый день до блокировки, в миг
// блокировки и после.
//
// Тега нет (CI клонирует без тегов) — тесты пропускаются с причиной.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode } from './enrollment.js';
import { createApp } from '../app.js';
import { listen } from '../test-helpers/listen.js';
import { canonical } from '../../../server/services/control/canonical.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const TAG = 'v3.16.0';
const DAY = 24 * 60 * 60 * 1000;
const FP = 'ab'.repeat(16);

function tagAvailable() {
  try {
    execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', '--quiet', TAG + '^{commit}'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}
const HAVE_TAG = tagAvailable();
const OPTS = HAVE_TAG ? {} : { skip: `тега ${TAG} нет в этом клоне — проверка против выпущенной клиники пропущена` };

const tmpDirs = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };

const vendor = crypto.generateKeyPairSync('ed25519');
const keyFile = path.join(tmp('cp-v3160-key-'), 'vendor-private.pem');
fs.writeFileSync(keyFile, vendor.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const signAsVendor = (payload) => crypto.sign(null, Buffer.from(canonical(payload), 'utf8'), vendor.privateKey).toString('base64');

// --- код клиники v3.16.0 из тега ---------------------------------------------

const IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g;

/** Файлы тега по цепочке относительных import — в dir, с той же раскладкой каталогов. */
function materialise(entries, dir) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = execFileSync('git', ['-C', ROOT, 'show', `${TAG}:${rel}`], { encoding: 'utf8', maxBuffer: 32 << 20 });
    const out = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, src);
    if (!/\.m?js$/.test(rel)) continue;
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2];
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) throw new Error(`${TAG}:${rel} imports "${spec}" — outside the repo it cannot be resolved`);
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
  }
  return [...seen].sort();
}

let v3 = null;
test.before(async () => {
  process.env.EASYMED_SIGNING_KEY = keyFile;
  if (!HAVE_TAG) return;
  const dir = tmp('cp-v3160-code-');
  const files = materialise(['package.json', 'server/services/control/checkin.js', 'server/services/control/state.js',
    'server/services/control/enroll.js'], dir);
  const load = (rel) => import(pathToFileURL(path.join(dir, ...rel.split('/'))).href);
  const checkin = await load('server/services/control/checkin.js');
  const state = await load('server/services/control/state.js');
  const enroll = await load('server/services/control/enroll.js');
  for (const m of [checkin, state, enroll]) m.__setPublicKeyForTests(vendor.publicKey);
  v3 = { files, runCheckin: checkin.runCheckin, controlState: state.controlState, enrollWithCode: enroll.enrollWithCode };
});
test.after(() => {
  delete process.env.EASYMED_SIGNING_KEY;
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** База клиники — только две таблицы, которые трогает лицензия v3.16.0 (миграция 073_licensing.sql тега). */
function clinicDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE control_state (key TEXT PRIMARY KEY, value TEXT NOT NULL,
             updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
           CREATE TABLE module_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, module_key TEXT NOT NULL, requested_by INTEGER,
             requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), sent_at TEXT);`);
  return db;
}

// --- две стороны ----------------------------------------------------------------

async function controlPlane(t) {
  const db = openDb(':memory:');
  migrate(db);
  const server = await listen(createApp(db));
  t.after(() => new Promise((r) => server.close(r)));
  return { db, endpoint: 'http://127.0.0.1:' + server.address().port };
}

let seq = 100;
/** Клиника v3.16.0, зачисленная своим же кодом зачисления через новый сервер лицензий. */
async function enrolV3160(t, cp, { name = 'Шифо', modules = ['crm'] } = {}) {
  const id = 'c-000' + (seq += 1);
  const code = createEnrollmentCode(cp.db, { clinicId: id, name });
  for (const m of modules) cp.db.prepare('INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)').run(id, m);
  const dir = tmp('cp-v3160-clinic-');
  const r = await v3.enrollWithCode(dir, code, { endpoint: cp.endpoint });
  assert.equal(r.ok, true, 'v3.16.0 зачисляется через новый сервер лицензий');
  const db = clinicDb();
  t.after(() => db.close());
  return { id, dir, db };
}

/** Ежечасная сверка v3.16.0 против нового сервера; возвращает ответ сервера, как его получила клиника. */
async function checkIn(clinic, cp) {
  let text = null;
  const fetchImpl = async (url, init) => {
    const res = await fetch(url, init);
    text = await res.text();
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  };
  await v3.runCheckin(clinic.db, clinic.dir, { endpoint: cp.endpoint, fetchImpl, buildStatsPayload: () => ({}) });
  assert.ok(text, 'сверка дошла до сервера');
  return JSON.parse(text);
}

/** Копия папки клиники до сверки — её «прежний» мир. */
function twinOf(t, clinic) {
  const dir = tmp('cp-v3160-twin-');
  for (const f of fs.readdirSync(clinic.dir)) fs.copyFileSync(path.join(clinic.dir, f), path.join(dir, f));
  const db = clinicDb();
  t.after(() => db.close());
  return { dir, db };
}

/** Тот же ответ сервера, каким его давал сервер лицензий до 8c неоплаченной клинике: licence: null. */
async function checkInAsBefore8c(twin, body) {
  assert.equal(body.subscription, 'unpaid', 'близнец — только для ответа неоплаченной клинике');
  const old = JSON.stringify({ ...body, licence: null });
  const fetchImpl = async () => new Response(old, { status: 200, headers: { 'Content-Type': 'application/json' } });
  await v3.runCheckin(twin.db, twin.dir, { endpoint: 'http://127.0.0.1:65000', fetchImpl, buildStatsPayload: () => ({}) });
}

/** Что показывает и разрешает клиника v3.16.0 в миг at (licence_status, плашки, модули, 402). */
function view(dir, at) {
  const db = clinicDb();
  try {
    const { has, ...rest } = v3.controlState(db, dir, new Date(at));
    return rest;
  } finally { db.close(); }
}

/** Вся лестница: каждый день 17 дней вперёд и ±1 с вокруг каждого срока. */
function ladder(dir, from, untils) {
  const points = new Set();
  for (let d = 0; d <= 16; d += 1) points.add(from + d * DAY);
  for (const u of untils) {
    const ms = Date.parse(u);
    if (Number.isFinite(ms)) { points.add(ms - 1000); points.add(ms + 1000); }
  }
  return [...points].sort((a, b) => a - b).map((at) => ({ at: new Date(at).toISOString(), ...view(dir, at) }));
}

const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

// v3.16.0 public/js/admin/views/updates.js, checkNow(): после «Проверить
// обновления» — «Лицензия обновлена — страница перезагрузится.», если
// изменились модули или запертость.
const renewedToast = (before, after) =>
  JSON.stringify(after.modules) !== JSON.stringify(before.modules) || (after.locked === true) !== (before.locked === true);

/** Клиника видит и делает ровно то же, что её близнец с прежним ответом. */
function assertSameAsBefore8c(clinic, twin, what) {
  const now = Date.now();
  assert.deepEqual(readJson(clinic.dir, 'control.json'), readJson(twin.dir, 'control.json'), what + ': control.json');
  const untils = [view(clinic.dir, now).validUntil, view(twin.dir, now).validUntil];
  assert.deepEqual(ladder(clinic.dir, now, untils), ladder(twin.dir, now, untils), what + ': лестница блокировки день за днём');
  assert.equal(renewedToast(view(twin.dir, now), view(clinic.dir, now)), false, what + ': «Лицензия обновлена» не появляется');
}

// --- (а) ------------------------------------------------------------------------

test('(а) лицензия с subscription и api_sync_key: v3.16.0 её проверяет, кладёт в licence.dat как прислана и видит то же, что с шестиключевой того же срока', OPTS, async (t) => {
  const cp = await controlPlane(t);
  const clinic = await enrolV3160(t, cp);
  // Онлайн-запись включена и ключ принят (у v3.16.0 этого не бывает — она ключа
  // не шлёт; здесь — чтобы проверить оба новых поля на её проверяющем).
  cp.db.prepare("UPDATE clinics SET api_enabled = 1, api_sync_key = ?, api_sync_key_accepted_at = '2026-10-12T00:00:00Z' WHERE clinic_id = ?")
    .run(FP, clinic.id);
  const body = await checkIn(clinic, cp);
  assert.deepEqual([body.subscription, body.licence.payload.subscription, body.licence.payload.api_sync_key], ['active', 'active', FP]);
  assert.equal(fs.readFileSync(path.join(clinic.dir, 'licence.dat'), 'utf8'), JSON.stringify(body.licence), 'принята и записана как прислана');

  const six = { ...body.licence.payload };
  delete six.subscription;
  delete six.api_sync_key;
  const classic = tmp('cp-v3160-six-');
  fs.copyFileSync(path.join(clinic.dir, 'control.json'), path.join(classic, 'control.json'));
  fs.writeFileSync(path.join(classic, 'licence.dat'), JSON.stringify({ payload: six, sig: signAsVendor(six) }));
  const now = Date.now();
  const v = view(clinic.dir, now);
  assert.deepEqual([v.locked, v.state, v.modules, v.validUntil], [false, 'ok', ['crm'], body.licence.payload.valid_until]);
  assert.deepEqual(ladder(clinic.dir, now, [v.validUntil]), ladder(classic, now, [v.validUntil]));
});

// --- (б) ------------------------------------------------------------------------

test('(б) «не оплачено» после оплаченной сверки: v3.16.0 видит ровно то же, что при прежнем licence: null — тот же день блокировки, те же плашки, лестница не сбрасывается; и на следующих сверках', OPTS, async (t) => {
  const cp = await controlPlane(t);
  const clinic = await enrolV3160(t, cp);
  const paid = await checkIn(clinic, cp);
  cp.db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = ?").run(clinic.id);
  const twin = twinOf(t, clinic);
  for (let i = 0; i < 3; i += 1) {
    const body = await checkIn(clinic, cp);
    assert.deepEqual([body.subscription, body.licence], ['unpaid', null], 'неоплаченной — лицензии нет, как до 8c (Р14)');
    await checkInAsBefore8c(twin, body);
    assertSameAsBefore8c(clinic, twin, 'сверка ' + (i + 1));
  }
  const lock = Date.parse(paid.licence.payload.valid_until);
  assert.deepEqual([view(clinic.dir, lock - 1000).locked, view(clinic.dir, lock + 1000).locked, view(clinic.dir, lock + 1000).reason],
    [false, true, 'unpaid'], 'запирается в день, когда кончается последняя ОПЛАЧЕННАЯ лицензия, со словами об оплате');

  // Оплатили — со следующей сверки снова 14 дней, слова об оплате уходят.
  cp.db.prepare("UPDATE clinics SET subscription = 'active' WHERE clinic_id = ?").run(clinic.id);
  const back = await checkIn(clinic, cp);
  assert.equal(back.licence.payload.subscription, 'active');
  const v = view(clinic.dir, Date.now());
  assert.deepEqual([v.locked, v.state, v.reason, v.daysLeft, v.modules], [false, 'ok', 'offline', 14, ['crm']]);
});

test('(б) «оплачено до» уже прошло (в колонке active): то же самое', OPTS, async (t) => {
  const cp = await controlPlane(t);
  const clinic = await enrolV3160(t, cp);
  await checkIn(clinic, cp);
  cp.db.prepare("UPDATE clinics SET subscription_until = '2020-01-01' WHERE clinic_id = ?").run(clinic.id);
  const twin = twinOf(t, clinic);
  const body = await checkIn(clinic, cp);
  assert.deepEqual([body.subscription, body.licence], ['unpaid', null]);
  await checkInAsBefore8c(twin, body);
  assertSameAsBefore8c(clinic, twin, 'subscription_until в прошлом');
});

test('(б) не оплачено сразу после зачисления, до первой сверки: лицензии нет, как прежде', OPTS, async (t) => {
  const cp = await controlPlane(t);
  const clinic = await enrolV3160(t, cp);
  cp.db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = ?").run(clinic.id);
  const twin = twinOf(t, clinic);
  const body = await checkIn(clinic, cp);
  assert.equal(body.licence, null);
  await checkInAsBefore8c(twin, body);
  assertSameAsBefore8c(clinic, twin, 'не выдавали после 8c');
});

test('(б) пока клиника не оплачена, в панели ей добавили модуль: v3.16.0 видит то же, что прежде (модуль — только после оплаты)', OPTS, async (t) => {
  const cp = await controlPlane(t);
  const clinic = await enrolV3160(t, cp);
  await checkIn(clinic, cp);
  cp.db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = ?").run(clinic.id);
  cp.db.prepare("INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, 'lab')").run(clinic.id);
  const twin = twinOf(t, clinic);
  const body = await checkIn(clinic, cp);
  await checkInAsBefore8c(twin, body);
  assertSameAsBefore8c(clinic, twin, 'модуль добавлен у неоплаченной');
});

test('(б) пока клиника не оплачена, в панели у неё сняли модуль: v3.16.0 видит то же, что прежде (доживает с прежними модулями)', OPTS, async (t) => {
  const cp = await controlPlane(t);
  const clinic = await enrolV3160(t, cp, { modules: ['crm', 'lab'] });
  await checkIn(clinic, cp);
  cp.db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = ?").run(clinic.id);
  cp.db.prepare("DELETE FROM clinic_modules WHERE clinic_id = ? AND module_key = 'lab'").run(clinic.id);
  const twin = twinOf(t, clinic);
  const body = await checkIn(clinic, cp);
  await checkInAsBefore8c(twin, body);
  assertSameAsBefore8c(clinic, twin, 'модуль снят у неоплаченной');
});

test('(б) пока клиника не оплачена, в панели её переименовали: v3.16.0 видит то же имя, что прежде', OPTS, async (t) => {
  const cp = await controlPlane(t);
  const clinic = await enrolV3160(t, cp);
  await checkIn(clinic, cp);
  cp.db.prepare("UPDATE clinics SET subscription = 'unpaid', name = 'Шифо Плюс' WHERE clinic_id = ?").run(clinic.id);
  const twin = twinOf(t, clinic);
  const body = await checkIn(clinic, cp);
  await checkInAsBefore8c(twin, body);
  assertSameAsBefore8c(clinic, twin, 'переименована у неоплаченной');
});

test('(б) клиника не сохранила последнюю выданную лицензию (ответ потерян в пути), потом «не оплачено»: день блокировки тот же', OPTS, async (t) => {
  const cp = await controlPlane(t);
  const clinic = await enrolV3160(t, cp);
  await checkIn(clinic, cp);
  // Сервер выдал и запомнил ещё одну лицензию, до клиники она не дошла.
  const token = readJson(clinic.dir, 'control.json').install_token;
  const lost = await fetch(cp.endpoint + '/cp/v1/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ install_token: token, version: '3.16.0' }) });
  assert.equal(lost.status, 200);
  await new Promise((r) => setTimeout(r, 25));
  cp.db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = ?").run(clinic.id);
  const twin = twinOf(t, clinic);
  const body = await checkIn(clinic, cp);
  await checkInAsBefore8c(twin, body);
  assertSameAsBefore8c(clinic, twin, 'последняя выданная не дошла');
});

// --- (в) ------------------------------------------------------------------------

test('(в) лицензия, выданная руками (make-licence.mjs issue --days 60), у неоплаченной клиники не укорачивается', OPTS, async (t) => {
  const cp = await controlPlane(t);
  const clinic = await enrolV3160(t, cp);
  await checkIn(clinic, cp);
  cp.db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = ?").run(clinic.id);
  // Запасной путь владельца (панель недоступна, договорились по телефону):
  // настоящий инструмент, тем же ключом производителя.
  const cwd = tmp('cp-v3160-hand-');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-licence.mjs'), 'issue', '--clinic', clinic.id, '--name', 'Шифо',
    '--modules', 'crm', '--days', '60', '--key', keyFile], { cwd, stdio: 'ignore' });
  fs.copyFileSync(path.join(cwd, `licence-${clinic.id}.dat`), path.join(clinic.dir, 'licence.dat'));
  const before = view(clinic.dir, Date.now());
  assert.ok(before.daysLeft >= 59, 'ручная лицензия на 60 дней на месте');
  const twin = twinOf(t, clinic);
  const body = await checkIn(clinic, cp);
  await checkInAsBefore8c(twin, body);
  assertSameAsBefore8c(clinic, twin, 'ручная лицензия у неоплаченной');
});
