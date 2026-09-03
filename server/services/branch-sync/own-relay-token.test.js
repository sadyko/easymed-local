// BRANCH_SELF_TOKEN_V1 — ФИЛИАЛ САМ БЕРЁТ СЕБЕ ДОСТУП К ЗАПИСЯМ.
//
// ЧТО СЛОМАЛОСЬ. Учётки резервного канала, выписанные ДО Задачи 7a, имеют
// область из одного адреса — справочника. Записи же ездят по адресам УЗЛОВ
// (relayIdFor(ключ, буква)), и на каждый такой запрос поставщик отвечает 401.
// Филиал владельца 2026-09-02: справочник забирает (адрес в области), журнал не
// выкладывает и не читает — «доступ отозван» на каждом часовом прогоне, при
// живом ключе и живой подписке. Единственным лекарством был перевыпуск ключа
// подключения и поездка в другое здание.
//
// ЧТО ЧИНИТ ЭТОТ ФАЙЛ. Вторичный филиал — тоже АКТИВИРОВАННАЯ клиника у
// поставщика (у него свой install_token: control-plane/server/routes/branch.js
// заводит филиалу собственный clinic_id вида c-…-bN). Маршрут выписки пускает
// любую активированную клинику и выдаёт права на те адреса, которые попросили,
// а адреса выводятся из ключа группы, который у филиала и так есть, — значит
// филиал может выписать учётку СЕБЕ, и нового доступа он этим не получает.
//
// Здесь — решения, которых не видно в сквозном тесте: КОГДА выписка случается,
// сколько раз, и что остаётся на экране, когда и она не удалась. Настоящий
// поставщик и настоящие записи — в последнем тесте файла.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { b64url, writePairing, readPairing, encodeKey, GROUP_KEY_BYTES } from './pairing.js';
import { relayIdFor } from './relay-crypto.js';
import {
  publishJournal, fetchJournals, fetchCatalogue, ensureOwnRelayToken,
  OWN_TOKEN_KEY, OWN_TOKEN_TRY_KEY,
} from './relay.js';
import { branchSyncPairAdopt } from '../rpc/branch-sync.js';

import { openDb as openCpDb } from '../../../control-plane/server/db/connection.js';
import { migrate as migrateCp } from '../../../control-plane/server/db/migrate.js';
import { createApp as createCpApp } from '../../../control-plane/server/app.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../../control-plane/server/services/enrollment.js';
import { listen as listenOnFreePort } from '../../../control-plane/server/test-helpers/listen.js';

const KEY = b64url(randomBytes(GROUP_KEY_BYTES));
const CATALOGUE = relayIdFor(KEY);
const KEY_TOKEN = 'key-CATALOGUE-ONLY';       // учётка старого выпуска: один адрес
const INSTALL = 'tok-B2';                     // install_token САМОГО филиала
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'em-own-' + tag + '-'));

/**
 * Установка филиала: своя база, свой каталог данных, учётка из ключа и —
 * главное — СВОЙ install_token, как у настоящего c-…-bN.
 */
function node(tag, {
  role = 'secondary', install = INSTALL, keyToken = KEY_TOKEN, letters = [], key = KEY,
} = {}) {
  const dir = tmp(tag);
  const db = openDb(':memory:');
  migrate(db);
  if (install) {
    fs.writeFileSync(path.join(dir, 'control.json'),
      JSON.stringify({ clinic_id: 'c-000005-b2', install_token: install }));
  }
  const record = {
    role, group_id: 'BR-OWN000000001', secret: 'ssssssssssssssssssssssssssssssss',
    main_url: 'http://10.0.0.5:8000', relay: true,
  };
  if (key) record.group_key = key;
  if (keyToken) record.relay_token = keyToken;
  writePairing(dir, record);
  // Строка A засеяна миграцией 080 — это главная клиника, сосед по умолчанию.
  for (const L of letters) {
    db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run('Филиал ' + L, L);
  }
  return { dir, db };
}

const stateOf = (db, key) => db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
const storedToken = (db) => {
  const raw = stateOf(db, OWN_TOKEN_KEY);
  return raw ? JSON.parse(raw).token : null;
};

/**
 * Подставной поставщик, у которого ПРАВА ПРОВЕРЯЮТСЯ ПО-НАСТОЯЩЕМУ: у каждой
 * учётки своя область, и запрос на адрес вне её — 401, ровно как на живом
 * сервере (control-plane/server/routes/relay.js).
 */
function vendor({
  scopes = { [KEY_TOKEN]: [CATALOGUE] },
  installs = { [INSTALL]: 'c-000005-b2' },
  mintStatus = 201,
  mintOffline = false,
} = {}) {
  const grants = new Map(Object.entries(scopes).map(([t, ids]) => [t, new Set(ids)]));
  const store = new Map();
  const calls = [];
  const mints = [];
  let n = 0;

  const bin = (status, bytes = null) => ({
    ok: status >= 200 && status < 300,
    status,
    body: null,
    arrayBuffer: async () => (bytes
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : new ArrayBuffer(0)),
  });

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const token = (/^Bearer[ \t]+(\S+)$/.exec(String((init.headers || {}).Authorization || '')) || [])[1] || null;

    if (url.endsWith('/cp/v1/relay-token')) {
      mints.push({ token, body: init.body ? JSON.parse(init.body) : null });
      if (mintOffline) throw new Error('ECONNREFUSED');
      if (!token || !installs[token]) return { ok: false, status: 401, json: async () => ({}) };
      if (mintStatus !== 201) return { ok: false, status: mintStatus, json: async () => ({}) };
      n += 1;
      const minted = 'own-' + n;
      const ids = mints[mints.length - 1].body.relay_ids;
      grants.set(minted, new Set(ids));
      return { ok: true, status: 201, json: async () => ({ token: minted, relay_id: ids[0], relay_ids: ids }) };
    }

    const id = url.split('/').pop();
    calls.push({ method, id, token });
    const allowed = grants.get(token);
    // Область проверяется на КАЖДОМ запросе и по адресу ИМЕННО ЭТОГО запроса —
    // в этом и была вся поломка.
    if (!allowed || !allowed.has(id)) return bin(401);
    if (method === 'PUT') { store.set(id, Buffer.from(init.body)); return bin(200); }
    const found = store.get(id);
    return found ? bin(200, found) : bin(404);
  };

  return { fetchImpl, calls, mints, store, grants };
}

// ---------------------------------------------------------------------------

test('филиал со старой учёткой сам выписывает себе новую и выкладывает журнал', async () => {
  const { dir, db } = node('heal-pub');
  const cp = vendor();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов Иван')").run();

  const r = await publishJournal(db, dir, { self: 'B', fetchImpl: cp.fetchImpl, env: {} });

  assert.equal(r.ok, true, 'после починки выгрузка обязана состояться: ' + JSON.stringify(r));
  // Первая попытка — учёткой из ключа, и это 401 на СВОЁМ адресе узла.
  assert.deepEqual(cp.calls.map((c) => c.token), [KEY_TOKEN, 'own-1']);
  assert.equal(cp.calls[0].id, relayIdFor(KEY, 'B'));
  assert.equal(cp.calls[1].id, relayIdFor(KEY, 'B'), 'повтор идёт по тому же адресу');

  // Филиал представился СВОИМ install_token-ом — тем самым, что выдал ему
  // поставщик при активации филиала.
  assert.equal(cp.mints.length, 1);
  assert.equal(cp.mints[0].token, INSTALL);
  const asked = cp.mints[0].body.relay_ids;
  assert.equal(asked.length, 27, 'справочник и весь алфавит узлов, как у выписки главной клиники');
  assert.equal(asked[0], CATALOGUE, 'справочник первым — он становится основным адресом учётки');
  for (const letter of ['A', 'B', 'C', 'Z']) {
    assert.ok(asked.includes(relayIdFor(KEY, letter)), 'адрес узла ' + letter + ' обязан быть в области');
  }
  // Старое поле тоже отправлено: панель поставщика обновляется отдельно.
  assert.equal(cp.mints[0].body.relay_id, CATALOGUE);

  assert.equal(storedToken(db), 'own-1', 'учётка сохранена — иначе она потеряна навсегда');

  // Следующий прогон идёт СРАЗУ новой учёткой: 401 больше не нужен, выписки нет.
  const again = await publishJournal(db, dir, { self: 'B', fetchImpl: cp.fetchImpl, env: {} });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(cp.mints.length, 1, 'вторая выписка означала бы новую строку у поставщика на каждый прогон');
  assert.deepEqual(cp.calls.slice(2).map((c) => c.token), ['own-1']);
});

test('выписка не удалась — на экране остаётся прежняя причина, и попытка ровно одна', async () => {
  const { dir, db } = node('heal-offline');
  const cp = vendor({ mintOffline: true });
  db.prepare("INSERT INTO patients (full_name) VALUES ('Петров Пётр')").run();

  const r = await publishJournal(db, dir, { self: 'B', fetchImpl: cp.fetchImpl, env: {} });

  // Ровно то, что владелец читал до этой правки: лекарство не изменилось, если
  // и вторая попытка не удалась.
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'relay_branch_revoked');
  assert.equal(cp.mints.length, 1, 'один поход за учёткой на вызов — не цикл');
  assert.equal(stateOf(db, OWN_TOKEN_KEY), null, 'неудачная выписка ничего не сохраняет');
  assert.equal(cp.calls.length, 1, 'повторять запрос той же учёткой незачем');
});

test('филиал, который у поставщика не активирован, за учёткой не ходит вовсе', async () => {
  // Ключ подключения перенесли руками, а установку никогда не активировали:
  // install_token-а нет, предъявить нечего. Поход к поставщику кончился бы 401
  // и только задержал бы ответ на экране.
  const { dir, db } = node('no-install', { install: null });
  const cp = vendor();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Сидоров')").run();

  const r = await publishJournal(db, dir, { self: 'B', fetchImpl: cp.fetchImpl, env: {} });

  assert.equal(r.reason, 'relay_branch_revoked', 'фраза та же, что и была');
  assert.deepEqual(cp.mints, [], 'без install_token выписка невозможна — и не пробуется');
});

test('сломанная установка не выписывает учётку каждый час: не чаще раза в час', async () => {
  // Поставщик отвечает 500 на выписку: филиал, у которого что-то сломано
  // навсегда, обязан перестать долбиться. Иначе каждый часовой прогон — новая
  // строка в реестре, а их у клиники всего 64.
  const { dir, db } = node('throttle');
  const cp = vendor({ mintStatus: 500 });
  db.prepare("INSERT INTO patients (full_name) VALUES ('Каримов')").run();

  const t0 = new Date('2026-09-03T10:00:00Z');
  const first = await publishJournal(db, dir, { self: 'B', fetchImpl: cp.fetchImpl, env: {}, now: () => t0 });
  assert.equal(first.reason, 'relay_branch_revoked');
  assert.equal(cp.mints.length, 1);

  const t1 = new Date('2026-09-03T10:30:00Z');
  const second = await publishJournal(db, dir, { self: 'B', fetchImpl: cp.fetchImpl, env: {}, now: () => t1 });
  assert.equal(second.reason, 'relay_branch_revoked', 'причина не меняется от того, что мы не пошли за учёткой');
  assert.equal(cp.mints.length, 1, 'вторая попытка внутри часа не идёт к поставщику');

  // А через час — идёт: поломка могла быть и временной.
  const t2 = new Date('2026-09-03T11:30:00Z');
  await publishJournal(db, dir, { self: 'B', fetchImpl: cp.fetchImpl, env: {}, now: () => t2 });
  assert.equal(cp.mints.length, 2);
  assert.ok(stateOf(db, OWN_TOKEN_TRY_KEY), 'отметка попытки и есть весь предохранитель');
});

test('главная клиника себе учёток не выписывает — она и так предъявляет install_token', async () => {
  // У главной клиники 401 означает совсем другое (её собственная активация), и
  // лекарство у неё другое. Выписка здесь была бы починкой того, что не сломано.
  const { dir, db } = node('main', { role: 'main', keyToken: null, install: 'tok-MAIN', letters: ['B'] });
  const cp = vendor({ scopes: {}, installs: { 'tok-MAIN': 'c-000005' } });
  db.prepare("INSERT INTO patients (full_name) VALUES ('Юлдашев')").run();

  const r = await publishJournal(db, dir, { self: 'A', fetchImpl: cp.fetchImpl, env: {} });

  assert.equal(r.reason, 'relay_unauthorized', 'фраза главной клиники, а не филиала');
  assert.deepEqual(cp.mints, []);
  assert.equal(stateOf(db, OWN_TOKEN_KEY), null);
});

test('приём журналов: одна выписка на прогон, и новая учётка идёт ко всем соседям', async () => {
  // У филиала два соседа. Выписка на КАЖДЫЙ 401 означала бы столько строк у
  // поставщика, сколько зданий в сети, — и всё это за один часовой прогон.
  const { dir, db } = node('heal-fetch', { letters: ['C'] });
  const cp = vendor();

  const r = await fetchJournals(db, dir, { self: 'B', fetchImpl: cp.fetchImpl, env: {} });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(cp.mints.length, 1, 'учётка берётся один раз на прогон, а не на каждого соседа');
  assert.deepEqual(cp.calls.map((c) => c.token), [KEY_TOKEN, 'own-1', 'own-1'],
    'починившись на первом соседе, новую учётку несём и второму');
  // Ни у кого ничего не выложено — это не отказ доступа, а обычное «сосед молчит».
  assert.deepEqual(Object.values(r.peers).map((p) => p.reason), ['relay_empty', 'relay_empty']);
});

test('справочник у филиала чинится так же — но только там, где есть база', async () => {
  const { dir, db } = node('heal-cat');
  // Область учётки из ключа не покрывает даже справочник (ключ группы
  // перевыпустили): 401 приходит и на него.
  const cp = vendor({ scopes: { [KEY_TOKEN]: [] } });

  const healed = await fetchCatalogue(dir, { db, fetchImpl: cp.fetchImpl, env: {} });
  assert.equal(cp.mints.length, 1);
  // Копии на сервере нет — но дошли мы до неё уже новой учёткой.
  assert.equal(healed.reason, 'relay_empty');
  assert.deepEqual(cp.calls.map((c) => c.token), [KEY_TOKEN, 'own-1']);

  // Без базы (старая форма вызова) поведение ровно прежнее: хранить учётку
  // некуда, и выписывать её ради одного запроса значило бы терять её каждый раз.
  const { dir: dir2 } = node('heal-cat-nodb');
  const cp2 = vendor({ scopes: { [KEY_TOKEN]: [] } });
  const plain = await fetchCatalogue(dir2, { fetchImpl: cp2.fetchImpl, env: {} });
  assert.equal(plain.reason, 'relay_branch_revoked');
  assert.deepEqual(cp2.mints, []);
});

test('своя учётка сильнее той, что приехала в ключе, но только на своём ключе группы', async () => {
  const { dir, db } = node('precedence');
  const cp = vendor({ scopes: { [KEY_TOKEN]: [CATALOGUE] } });

  const minted = await ensureOwnRelayToken(db, dir, { fetchImpl: cp.fetchImpl, env: {} });
  assert.equal(minted.ok, true, JSON.stringify(minted));
  assert.equal(minted.token, 'own-1');

  // Первый же запрос идёт своей учёткой: 401 для этого не нужен.
  const r = await fetchCatalogue(dir, { db, fetchImpl: cp.fetchImpl, env: {} });
  assert.equal(r.reason, 'relay_empty', 'копии нет, но доступ есть: ' + JSON.stringify(r));
  assert.deepEqual(cp.calls.map((c) => c.token), ['own-1']);

  // ПЕРЕВЫПУСК КЛЮЧА ГРУППЫ. Адреса сменились вместе с ключом, и сохранённая
  // учётка выписана на СТАРЫЕ — предъявлять её бессмысленно, а вот учётка из
  // нового ключа подключения рабочая. Забыть про это значило бы отвечать 401 на
  // ровно то действие, которым владелец только что всё починил.
  const NEW_KEY = b64url(randomBytes(GROUP_KEY_BYTES));
  writePairing(dir, { ...readPairing(dir), group_key: NEW_KEY, relay_token: 'key-AFTER-REISSUE' });
  const cp2 = vendor({ scopes: { 'key-AFTER-REISSUE': [relayIdFor(NEW_KEY)] } });
  const after = await fetchCatalogue(dir, { db, fetchImpl: cp2.fetchImpl, env: {} });
  assert.equal(after.reason, 'relay_empty');
  assert.deepEqual(cp2.calls.map((c) => c.token), ['key-AFTER-REISSUE']);
  assert.deepEqual(cp2.mints, [], 'ключом всё уже починено — ходить за учёткой незачем');
});

test('связывание ключом сразу берёт учётку — отказ для этого не нужен', async () => {
  // Свежеподключённому филиалу незачем ждать первого 401 через час: ключ
  // введён, install_token есть, значит учётку можно взять сейчас же.
  const dir = tmp('adopt');
  setDataDir(dir);
  const db = openDb(':memory:');
  migrate(db);
  fs.writeFileSync(path.join(dir, 'control.json'),
    JSON.stringify({ clinic_id: 'c-000005-b2', install_token: INSTALL }));

  const asked = [];
  const ownTokenImpl = async (gotDb, gotDir, opts) => {
    asked.push({ sameDb: gotDb === db, dir: gotDir, opts });
    return { ok: true, token: 'own-1' };
  };
  const key = encodeKey({
    group_id: 'BR-OWN000000001', secret: 'ssssssssssssssssssssssssssssssss',
    main_url: 'http://10.0.0.5:8000', group_key: KEY, letter: 'C', relay_token: KEY_TOKEN,
  });

  const paired = await branchSyncPairAdopt(db, { key }, { id: 1, role: 'admin' }, { ownTokenImpl });

  assert.equal(paired.role, 'secondary');
  assert.equal(asked.length, 1, 'учётка берётся ровно один раз, при связывании');
  assert.equal(asked[0].sameDb, true);
  assert.equal(asked[0].dir, dir);
  assert.equal(asked[0].opts.force, true, 'ручное действие человека не ждёт часового предохранителя');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('неудача выписки при связывании не ломает связывание', async () => {
  // Ключ введён, пара записана — и она работает по Маршруту А без всякого
  // поставщика. Уронить связывание из-за недоступного сервера значило бы
  // сделать офлайновую клинику заложником чужой сети.
  const dir = tmp('adopt-fail');
  setDataDir(dir);
  const db = openDb(':memory:');
  migrate(db);
  fs.writeFileSync(path.join(dir, 'control.json'),
    JSON.stringify({ clinic_id: 'c-000005-b2', install_token: INSTALL }));
  const key = encodeKey({
    group_id: 'BR-OWN000000001', secret: 'ssssssssssssssssssssssssssssssss',
    main_url: 'http://10.0.0.5:8000', group_key: KEY, letter: 'C', relay_token: KEY_TOKEN,
  });

  const paired = await branchSyncPairAdopt(db, { key }, { id: 1, role: 'admin' }, {
    ownTokenImpl: async () => { throw new Error('поставщик недоступен'); },
  });

  assert.equal(paired.ok, true);
  assert.equal(paired.letter, 'C');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// СКВОЗНОЙ ТЕСТ: настоящий поставщик, настоящая проверка области, настоящие
// записи. Ровно та установка, что стоит у владельца сейчас, — филиал с учёткой
// старого выпуска, — обязана начать обмениваться записями сама.
// ===========================================================================

test('BRANCH_SELF_TOKEN_V1: филиал с учёткой старого выпуска сам чинится и довозит пациента', async (t) => {
  const cpDb = openCpDb(':memory:');
  migrateCp(cpDb);
  const server = await listenOnFreePort(createCpApp(cpDb));
  const base = `http://127.0.0.1:${server.address().port}`;

  const prev = process.env.EASYMED_CONTROL_URL;
  process.env.EASYMED_CONTROL_URL = base;

  // Главная клиника и филиал — ДВЕ активированные клиники у поставщика, как в
  // жизни: филиал заводят через /cp/v1/branch, и он получает свой c-…-bN.
  const mainToken = redeemEnrollmentCode(cpDb, {
    code: createEnrollmentCode(cpDb, { clinicId: 'cp-own', name: 'Сеть' }),
  }).install_token;
  const branchToken = redeemEnrollmentCode(cpDb, {
    code: createEnrollmentCode(cpDb, { clinicId: 'cp-own-b1', name: 'Чиланзар' }),
  }).install_token;

  const groupKey = b64url(randomBytes(GROUP_KEY_BYTES));
  const A = { dir: tmp('e2e-a'), db: openDb(':memory:') };
  const B = { dir: tmp('e2e-b'), db: openDb(':memory:') };
  migrate(A.db);
  migrate(B.db);

  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    cpDb.close();
    A.db.close();
    B.db.close();
    fs.rmSync(A.dir, { recursive: true, force: true });
    fs.rmSync(B.dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.EASYMED_CONTROL_URL;
    else process.env.EASYMED_CONTROL_URL = prev;
  });

  fs.writeFileSync(path.join(A.dir, 'control.json'),
    JSON.stringify({ clinic_id: 'cp-own', install_token: mainToken }));
  fs.writeFileSync(path.join(B.dir, 'control.json'),
    JSON.stringify({ clinic_id: 'cp-own-b1', install_token: branchToken }));

  // УЧЁТКА СТАРОГО ВЫПУСКА: просим ОДИН адрес — справочник, — то есть ровно то,
  // что выписывала главная клиника до Задачи 7a. Это и есть состояние всех
  // выданных до 2026-09-02 ключей.
  const minted = await fetch(base + '/cp/v1/relay-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mainToken}` },
    body: JSON.stringify({ relay_id: relayIdFor(groupKey) }),
  }).then((r) => r.json());
  assert.ok(minted.token, JSON.stringify(minted));

  const pairing = {
    role: 'main', group_id: 'BR-OWN0000000E2', secret: 'ssssssssssssssssssssssssssssssss',
    main_url: 'http://127.0.0.1:65535', group_key: groupKey, relay: true,
  };
  writePairing(A.dir, pairing);
  A.db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run('Чиланзар', 'B');
  writePairing(B.dir, { ...pairing, role: 'secondary', relay_token: minted.token });
  B.db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run('Чиланзар', 'B');
  B.db.prepare("UPDATE branch_identity SET letter = 'B', role = 'secondary' WHERE id = 1").run();

  // Пациент заведён В ФИЛИАЛЕ — до этой правки он не уезжал никуда.
  B.db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Алиев Азиз', '+998901112233')").run();

  const published = await publishJournal(B.db, B.dir, { self: 'B' });
  assert.equal(published.ok, true, 'филиал обязан выложить журнал сам: ' + JSON.stringify(published));
  assert.ok(storedToken(B.db), 'учётка, которую филиал выписал себе, сохранена');

  // Главная клиника забирает — тем же обменом, что и всегда.
  const got = await fetchJournals(A.db, A.dir, { self: 'A' });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.peers.B.applied > 0, true, 'записи филиала доехали: ' + JSON.stringify(got.peers));
  assert.deepEqual(
    A.db.prepare('SELECT full_name FROM patients').all().map((r) => r.full_name),
    ['Алиев Азиз'],
  );
});
