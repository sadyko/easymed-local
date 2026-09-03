// BRANCH_REISSUE_V1 — обе половины починки переустановленного филиала, со
// стороны экрана.
//
// ПОЛОВИНА ПЕРВАЯ, главная клиника: кнопка «Перевыпустить ключ». Код активации
// одноразовый, а ключ филиала главная клиника собирает из СОХРАНЁННОГО кода —
// значит после первой активации ключ в списке навсегда мёртв, и
// переустановленный компьютер филиала им не заводится. Проверено на тестовом
// филиале владельца 2026-09-02.
//
// ПОЛОВИНА ВТОРАЯ, компьютер филиала: тот же ключ, введённый на установке,
// которую по ошибке активировали как ОТДЕЛЬНУЮ клинику, теперь делает её
// филиалом. Это и есть выход, которым владелец воспользовался в тот день, —
// и который до сих пор оставлял ноутбук с чужой личностью и без синхронизации.
//
// СЕТИ ЗДЕСЬ НЕТ: и control plane, и погашение кода подставные. Что именно
// уезжает к поставщику, проверяет branch-sync/relay-reissue.test.js; здесь —
// порядок действий, права доступа и то, какой фразой каждый отказ доезжает до
// владельца.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { encodeKey, parseKey, readPairing } from '../branch-sync/pairing.js';
import { branchRows } from '../../../public/js/admin/branch-sync-logic.js';
import {
  branchSyncMakeKey, branchSyncBranches, branchSyncAddBranch, branchSyncReissueKey,
  branchSyncPairAdopt, backfillBranchClinicIds, reasonText,
} from './branch-sync.js';

const admin = { id: 1, role: 'admin' };
const nurse = { id: 2, role: 'nurse' };

// Каталог данных в этом процессе один (control/config.js объясняет почему).
function inDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-reissue-rpc-' + tag + '-'));
  setDataDir(dir);
  return dir;
}
function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

/** Активированная клиника: без install_token перевыпуск не с чем предъявить. */
function enrolled(dir, clinicId = 'c-000005') {
  fs.writeFileSync(path.join(dir, 'control.json'),
    JSON.stringify({ clinic_id: clinicId, install_token: 'tok-MAIN', unlock_secret: 's', subscription: 'active' }));
}

const pubOk = async () => ({ ok: true, bytes: 1024 });
const mintOk = async () => ({ ok: true, token: 'relay-tok-1', relay_id: 'a'.repeat(32) });
const mintOk2 = async () => ({ ok: true, token: 'relay-tok-2', relay_id: 'b'.repeat(32) });

/** Подставной control plane: раздаёт номера филиалов так же, как настоящий. */
function fakeCp(parent = 'c-000005') {
  let n = 0;
  const created = [];
  const branchImpl = async (dataDir, { name } = {}) => {
    n += 1;
    created.push({ n, name });
    return { ok: true, enrollment_code: `EM-CODE-${n}`, clinic_id: `${parent}-b${n}`, name };
  };
  return { branchImpl, created };
}

/** Перевыпуск: запоминает, КОГО просили перевыпустить. */
function fakeReissue(result = null) {
  const asked = [];
  const reissueImpl = async (dataDir, { clinicId } = {}) => {
    asked.push(clinicId);
    return result || { ok: true, enrollment_code: 'EM-FRESH-9', clinic_id: clinicId, name: 'Чиланзар' };
  };
  return { reissueImpl, asked };
}

function asMain(dir, url = 'http://10.0.0.5:8000') {
  const db = freshDb();
  enrolled(dir);
  assert.equal(branchSyncMakeKey(db, { url }, admin).ok, true);
  return db;
}

// ===========================================================================
// ГЛАВНАЯ КЛИНИКА: «Перевыпустить ключ»
// ===========================================================================

test('перевыпуск даёт филиалу НОВЫЙ код, новую учётку и новый ключ — тому самому филиалу', async () => {
  const dir = inDir('happy');
  const db = asMain(dir);
  const cp = fakeCp();
  const added = await branchSyncAddBranch(db, { name: 'Чиланзар' }, admin,
    { mintImpl: mintOk, branchImpl: cp.branchImpl, publishImpl: pubOk });
  const before = added.branch.key;
  assert.equal(parseKey(before).enroll_code, 'EM-CODE-1');

  const cpr = fakeReissue();
  const r = await branchSyncReissueKey(db, { branch_id: added.branch.id }, admin,
    { reissueImpl: cpr.reissueImpl, mintImpl: mintOk2 });

  assert.equal(r.ok, true);
  // АДРЕСАТ — тот номер, под которым филиал заведён у поставщика, и он взят из
  // записи, а не угадан.
  assert.deepEqual(cpr.asked, ['c-000005-b1']);

  const parsed = parseKey(r.key);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.enroll_code, 'EM-FRESH-9', 'ключ обязан нести НОВЫЙ код');
  assert.equal(parsed.letter, 'B', 'филиал остаётся тем же филиалом: буква та же');
  assert.notEqual(r.key, before, 'ключ, который не изменился, — ключ, который не чинит');
  // Учётка резервного канала перевыпускается вместе с кодом: старый компьютер
  // уносит с собой рабочую копию ключа, а с ней и доступ к узлам группы.
  assert.equal(parsed.relay_token, 'relay-tok-2');
  assert.equal(r.relay.ok, true);

  // И это состояние, а не разовый ответ: список отдаёт тот же новый ключ.
  const listed = branchSyncBranches(db, {}, admin).branches.find((b) => b.id === added.branch.id);
  assert.equal(listed.key, r.key);
  assert.equal(listed.has_enroll_code, true);
  assert.equal(listed.has_relay_token, true);
  db.close();
});

test('отказ поставщика НИЧЕГО не меняет: старый ключ остаётся рабочим ключом', async () => {
  const dir = inDir('cp-fail');
  const db = asMain(dir);
  const cp = fakeCp();
  const added = await branchSyncAddBranch(db, { name: 'Юнусабад' }, admin,
    { mintImpl: mintOk, branchImpl: cp.branchImpl, publishImpl: pubOk });
  const before = added.branch.key;

  for (const [reason, text] of [
    ['branch_offline', reasonText('branch_offline')],
    ['branch_unauthorized', reasonText('branch_unauthorized')],
    ['reissue_not_found', reasonText('reissue_not_found')],
    ['branch_server_error', reasonText('branch_server_error')],
  ]) {
    const cpr = fakeReissue({ ok: false, reason });
    await assert.rejects(
      () => branchSyncReissueKey(db, { branch_id: added.branch.id }, admin,
        { reissueImpl: cpr.reissueImpl, mintImpl: mintOk2 }),
      (e) => { assert.equal(e.status, 400); assert.equal(e.message, text); return true; },
      reason,
    );
    const listed = branchSyncBranches(db, {}, admin).branches.find((b) => b.id === added.branch.id);
    assert.equal(listed.key, before, `${reason}: ключ не должен был измениться`);
  }
  db.close();
});

test('каждый отказ перевыпуска говорит своей фразой, а не общей', () => {
  // «Не удалось выполнить действие» здесь стоит владельцу вечера: не найден —
  // это в поддержку, не признан — это проверить активацию, старая версия — это
  // завести филиал заново. Три разных действия.
  for (const code of ['reissue_not_found', 'reissue_unknown_branch', 'enroll_code_used',
    'enroll_offline', 'enroll_server_error', 'enroll_too_many']) {
    assert.notEqual(reasonText(code), reasonText('нет такого кода'), code);
    assert.ok(reasonText(code).length > 20, code);
  }
  assert.match(reasonText('enroll_code_used'), /Перевыпустить ключ/,
    'фраза обязана называть кнопку, которую надо нажать');
});

test('перевыпускает только администратор главной клиники и только чужой филиал', async () => {
  const dir = inDir('guards');
  const db = asMain(dir);
  const cp = fakeCp();
  const added = await branchSyncAddBranch(db, { name: 'Себзар' }, admin,
    { mintImpl: mintOk, branchImpl: cp.branchImpl, publishImpl: pubOk });
  const cpr = fakeReissue();
  const opts = { reissueImpl: cpr.reissueImpl, mintImpl: mintOk2 };

  await assert.rejects(() => branchSyncReissueKey(db, { branch_id: added.branch.id }, nurse, opts),
    (e) => e.status === 403);
  await assert.rejects(() => branchSyncReissueKey(db, { branch_id: 1 }, admin, opts),
    (e) => e.message === reasonText('branch_is_self'));
  await assert.rejects(() => branchSyncReissueKey(db, { branch_id: 999 }, admin, opts),
    (e) => e.message === reasonText('branch_unknown'));
  await assert.rejects(() => branchSyncReissueKey(db, {}, admin, opts),
    (e) => e.message === reasonText('branch_unknown'));
  assert.deepEqual(cpr.asked, [], 'ни один отказ не должен был дойти до поставщика');
  db.close();
});

test('подключённый филиал ключей не перевыпускает — это делают в главной клинике', async () => {
  const dir = inDir('secondary');
  const db = freshDb();
  const key = encodeKey({
    group_id: 'BR-AAAAAAAAAAAA', secret: 'sec', main_url: 'http://10.0.0.5:8000', letter: 'C',
  });
  assert.equal(branchSyncPairAdopt(db, { key }, admin) instanceof Promise, true);
  await branchSyncPairAdopt(db, { key }, admin);
  const cpr = fakeReissue();
  await assert.rejects(
    () => branchSyncReissueKey(db, { branch_id: 2 }, admin, { reissueImpl: cpr.reissueImpl }),
    (e) => e.message === reasonText('branch_not_main'),
  );
  db.close();
});

// ===========================================================================
// НОМЕР ФИЛИАЛА У ПОСТАВЩИКА: запоминание и восстановление
// ===========================================================================

test('номер филиала запоминается при заведении, и по нему адресуется перевыпуск', async () => {
  const dir = inDir('remember');
  const db = asMain(dir);
  const cp = fakeCp();
  const one = await branchSyncAddBranch(db, { name: 'Первый' }, admin,
    { mintImpl: mintOk, branchImpl: cp.branchImpl, publishImpl: pubOk });
  const two = await branchSyncAddBranch(db, { name: 'Второй' }, admin,
    { mintImpl: mintOk, branchImpl: cp.branchImpl, publishImpl: pubOk });

  const cpr = fakeReissue();
  await branchSyncReissueKey(db, { branch_id: two.branch.id }, admin,
    { reissueImpl: cpr.reissueImpl, mintImpl: mintOk2 });
  await branchSyncReissueKey(db, { branch_id: one.branch.id }, admin,
    { reissueImpl: cpr.reissueImpl, mintImpl: mintOk2 });

  assert.deepEqual(cpr.asked, ['c-000005-b2', 'c-000005-b1'],
    'каждый филиал перевыпускается СВОЙ — промах здесь гасит чужое здание');
  db.close();
});

test('филиалам, заведённым до этой версии, номер восстанавливается ПО ПОРЯДКУ ПОЛУЧЕНИЯ КОДА', async () => {
  // Так филиалы и заведены у владельца: код есть, номера нет. Восстановить его
  // можно потому, что поставщик выдаёт номера детерминированно —
  // '<родитель>-b<N>' по количеству уже существующих детей
  // (control-plane/server/routes/branch.js nextBranchId), а строки филиалов у
  // него не удаляются.
  //
  // ПОРЯДОК СЧИТАЕТСЯ ПО ВРЕМЕНИ ПОЛУЧЕНИЯ КОДА, А НЕ ПО НОМЕРУ СТРОКИ, и
  // здесь это нарочно разведено: филиал, заведённый без интернета, получает
  // код ПОЗЖЕ соседа, заведённого после него (кнопка «Получить код»
  // дочинивает старую строку). По id порядок был бы обратным настоящему.
  const dir = inDir('backfill');
  const db = asMain(dir);
  const b1 = db.prepare("INSERT INTO branches (name, letter) VALUES ('Ранняя строка','B')").run().lastInsertRowid;
  const b2 = db.prepare("INSERT INTO branches (name, letter) VALUES ('Поздняя строка','C')").run().lastInsertRowid;
  const put = (id, code, at) => db.prepare(
    'INSERT INTO control_state (key, value, updated_at) VALUES (?,?,?)'
  ).run('branch_sync.enroll.' + id, code, at);
  // Строка b2 получила код ПЕРВОЙ — значит у поставщика она и есть -b1.
  put(b2, 'EM-OLD-2', '2026-08-01T10:00:00Z');
  put(b1, 'EM-OLD-1', '2026-08-30T09:00:00Z');

  assert.deepEqual(backfillBranchClinicIds(db, dir), { ok: true, filled: 2 });

  const cpr = fakeReissue();
  await branchSyncReissueKey(db, { branch_id: b2 }, admin, { reissueImpl: cpr.reissueImpl, mintImpl: mintOk });
  await branchSyncReissueKey(db, { branch_id: b1 }, admin, { reissueImpl: cpr.reissueImpl, mintImpl: mintOk });
  assert.deepEqual(cpr.asked, ['c-000005-b1', 'c-000005-b2']);
  db.close();
});

test('восстановление идемпотентно и НИКОГДА не переписывает известный номер', async () => {
  const dir = inDir('idem');
  const db = asMain(dir);
  const cp = fakeCp();
  await branchSyncAddBranch(db, { name: 'Первый' }, admin,
    { mintImpl: mintOk, branchImpl: cp.branchImpl, publishImpl: pubOk });

  assert.deepEqual(backfillBranchClinicIds(db, dir), { ok: true, filled: 0 });
  assert.deepEqual(backfillBranchClinicIds(db, dir), { ok: true, filled: 0 });
  assert.equal(
    db.prepare("SELECT value FROM control_state WHERE key = 'branch_sync.clinic.2'").get().value,
    'c-000005-b1',
  );
  db.close();
});

test('не сошлось с известным номером — НЕ ГАДАЕМ, и перевыпуск честно недоступен', async () => {
  // Единственный случай, когда догадка неверна: у поставщика есть ребёнок, о
  // котором эта клиника не знает (ответ не доехал, запись не удалась). Тогда
  // все следующие номера съезжают, и филиал, чей номер известен точно, с
  // вычисленным не совпадёт. Промолчать здесь значило бы перевыпустить ЧУЖОЙ
  // филиал — то есть выключить работающий компьютер в другом здании.
  const dir = inDir('mismatch');
  const db = asMain(dir);
  const b1 = db.prepare("INSERT INTO branches (name, letter) VALUES ('Старая','B')").run().lastInsertRowid;
  const b2 = db.prepare("INSERT INTO branches (name, letter) VALUES ('Новая','C')").run().lastInsertRowid;
  const put = (key, value, at) => db.prepare(
    'INSERT INTO control_state (key, value, updated_at) VALUES (?,?,?)'
  ).run(key, value, at);
  put('branch_sync.enroll.' + b1, 'EM-1', '2026-08-01T10:00:00Z');
  put('branch_sync.enroll.' + b2, 'EM-2', '2026-08-02T10:00:00Z');
  // ЯКОРЬ: у второй строки номер известен точно — и он третий, а не второй.
  put('branch_sync.clinic.' + b2, 'c-000005-b3', '2026-08-02T10:00:00Z');

  assert.deepEqual(backfillBranchClinicIds(db, dir), { ok: false, reason: 'reissue_unknown_branch' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM control_state WHERE key = 'branch_sync.clinic.' || ?").get(b1).n, 0,
    'ни одной догадки записано быть не должно');

  const cpr = fakeReissue();
  await assert.rejects(
    () => branchSyncReissueKey(db, { branch_id: b1 }, admin, { reissueImpl: cpr.reissueImpl }),
    (e) => e.message === reasonText('reissue_unknown_branch'),
  );
  assert.deepEqual(cpr.asked, [], 'до поставщика такой перевыпуск доходить не должен');
  // А филиал с известным номером перевыпускается как ни в чём не бывало.
  await branchSyncReissueKey(db, { branch_id: b2 }, admin, { reissueImpl: cpr.reissueImpl, mintImpl: mintOk });
  assert.deepEqual(cpr.asked, ['c-000005-b3']);
  db.close();
});

test('неактивированная клиника номеров филиалов не знает — и не выдумывает их', async () => {
  const dir = inDir('unenrolled');
  const db = freshDb();
  assert.equal(branchSyncMakeKey(db, { url: 'http://10.0.0.5:8000' }, admin).ok, true);
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Старая','B')").run();
  db.prepare("INSERT INTO control_state (key, value, updated_at) VALUES ('branch_sync.enroll.2','EM-1','2026-08-01T10:00:00Z')").run();

  assert.deepEqual(backfillBranchClinicIds(db, dir), { ok: false, reason: 'branch_not_enrolled' });
  const cpr = fakeReissue();
  await assert.rejects(
    () => branchSyncReissueKey(db, { branch_id: 2 }, admin, { reissueImpl: cpr.reissueImpl }),
    (e) => e.message === reasonText('reissue_unknown_branch'),
  );
  db.close();
});

test('список говорит экрану, известен ли номер, — и кнопка есть ровно там', async () => {
  // Кнопка, которую показали и которая всегда отказывает, хуже отсутствующей:
  // владелец нажимает, читает отказ и идёт искать свою ошибку там, где её нет.
  const dir = inDir('list');
  const db = asMain(dir);
  const cp = fakeCp();
  const known = await branchSyncAddBranch(db, { name: 'Известный' }, admin,
    { mintImpl: mintOk, branchImpl: cp.branchImpl, publishImpl: pubOk });
  // Строка «из старой версии»: код есть, номера нет — и восстановить его
  // нельзя, потому что якорь выше уже занял -b1.
  const old = db.prepare("INSERT INTO branches (name, letter) VALUES ('Старый','C')").run().lastInsertRowid;
  db.prepare("INSERT INTO control_state (key, value, updated_at) VALUES (?,?,?)")
    .run('branch_sync.enroll.' + old, 'EM-OLD', '2020-01-01T00:00:00Z');

  const list = branchSyncBranches(db, {}, admin);
  const rows = branchRows(list);
  const byName = (n) => rows.find((r) => r.name === n);

  assert.equal(byName('Известный').reissue.label, 'Перевыпустить ключ');
  assert.equal(byName('Старый').reissue, null, 'старой строке перевыпуск недоступен — и кнопки нет');
  assert.equal(rows.find((r) => r.state === 'self').reissue, null, 'этой установке перевыпускать нечего');
  assert.equal(
    list.branches.find((b) => b.id === known.branch.id).has_clinic_id, true,
  );
  db.close();
});

test('строка филиала без ключа кнопку перевыпуска не показывает', () => {
  // Перевыпускать нечего: ключа нет, потому что нет буквы. Сначала «Выдать ключ».
  const rows = branchRows({
    role: 'main', can_issue: true, can_relay: true,
    branches: [{ id: 4, name: 'Без буквы', letter: null, key: null, has_clinic_id: true }],
  });
  assert.equal(rows[0].reissue, null);
  assert.equal(rows[0].action.label, 'Выдать ключ');
});

test('не главная клиника кнопок не показывает вовсе', () => {
  const rows = branchRows({
    role: 'main', can_issue: false, can_relay: true,
    branches: [{ id: 2, name: 'Чиланзар', letter: 'B', key: 'EMB2-x', has_clinic_id: true, has_relay_token: true }],
  });
  assert.equal(rows[0].reissue, null);
});

// ===========================================================================
// КОМПЬЮТЕР ФИЛИАЛА: ключ переселяет установку в филиал
// ===========================================================================

/** Установка, активированная как ОТДЕЛЬНАЯ клиника (ошибка владельца 2026-09-02). */
function standalone(dir, clinicId = 'c-000077') {
  fs.writeFileSync(path.join(dir, 'control.json'),
    JSON.stringify({ clinic_id: clinicId, install_token: 'tok-WRONG', unlock_secret: 's', subscription: 'active' }));
}

function fakeEnroll(result = null) {
  const calls = [];
  const enrollImpl = async (dataDir, code, opts) => {
    calls.push({ dataDir, code, opts });
    return result || { ok: true, clinic_id: 'c-000005-b2', clinic_name: 'Чиланзар' };
  };
  return { enrollImpl, calls };
}

const branchKey = (over = {}) => encodeKey({
  group_id: 'BR-AAAAAAAAAAAA', secret: 'sec', main_url: 'http://10.0.0.5:8000',
  letter: 'C', relay_token: 'rt-abc', enroll_code: 'EM-FRESH-9', ...over,
});

test('ключ на установке, активированной как отдельная клиника, делает её филиалом', async () => {
  const dir = inDir('adopt');
  const db = freshDb();
  standalone(dir);
  const fake = fakeEnroll();

  const r = await branchSyncPairAdopt(db, { key: branchKey() }, admin, { enrollImpl: fake.enrollImpl });

  assert.equal(r.ok, true);
  assert.equal(r.letter, 'C', 'буква принята — установка стала филиалом C');
  assert.deepEqual(r.adopted, { clinic_id: 'c-000005-b2', clinic_name: 'Чиланзар' });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].code, 'EM-FRESH-9', 'гасится тот код, что приехал В КЛЮЧЕ');
  assert.equal(fake.calls[0].opts.replace, true,
    'без replace погашение упёрлось бы в already_enrolled — ту самую стену, ради которой всё это');
  assert.equal(readPairing(dir).role, 'secondary');
  db.close();
});

test('УЖЕ ФИЛИАЛ ключом не переселяется: «возьмите новый ключ подключения» — обычная починка', async () => {
  // Эта фраза стоит в пяти отказах экрана (учётка отозвана, ключ группы
  // перевыпущен, копия не расшифровалась). Код в таком ключе почти всегда уже
  // погашен — ЭТОЙ ЖЕ установкой, — и попытка обязательно уперлась бы в 400.
  // Владелец чинил бы связь и получал бы красным «код уже использован» на
  // успешное действие.
  const dir = inDir('already-branch');
  const db = freshDb();
  standalone(dir, 'c-000005-b3');
  const fake = fakeEnroll();

  const r = await branchSyncPairAdopt(db, { key: branchKey() }, admin, { enrollImpl: fake.enrollImpl });

  assert.equal(r.ok, true);
  assert.equal(r.adopted, undefined);
  assert.deepEqual(fake.calls, [], 'ни одного обращения к поставщику');
  assert.equal(readPairing(dir).role, 'secondary', 'связывание при этом произошло');
  db.close();
});

test('НЕ АКТИВИРОВАННАЯ установка проходит мимо: активацией занимается экран активации', async () => {
  // Экран активации связывает ключом, а потом сам зовёт licence_enroll с
  // вложенным кодом. Полезли бы сюда — второй шаг получал бы already_enrolled.
  const dir = inDir('fresh-install');
  const db = freshDb();
  const fake = fakeEnroll();

  const r = await branchSyncPairAdopt(db, { key: branchKey() }, admin, { enrollImpl: fake.enrollImpl });

  assert.equal(r.ok, true);
  assert.deepEqual(fake.calls, []);
  assert.equal(readPairing(dir).role, 'secondary');
  db.close();
});

test('ключ старого выпуска (без кода) связывает и ничего больше', async () => {
  const dir = inDir('no-code');
  const db = freshDb();
  standalone(dir);
  const fake = fakeEnroll();

  const r = await branchSyncPairAdopt(db, { key: branchKey({ enroll_code: null }) }, admin,
    { enrollImpl: fake.enrollImpl });

  assert.equal(r.ok, true);
  assert.deepEqual(fake.calls, []);
  assert.equal(readPairing(dir).role, 'secondary');
  db.close();
});

test('погашенный код — своя фраза, называющая кнопку в главной клинике; связь при этом СОХРАНЕНА', async () => {
  const dir = inDir('used-code');
  const db = freshDb();
  standalone(dir);
  const fake = fakeEnroll({ ok: false, reason: 'invalid_code' });

  await assert.rejects(
    () => branchSyncPairAdopt(db, { key: branchKey() }, admin, { enrollImpl: fake.enrollImpl }),
    (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.message, reasonText('enroll_code_used'));
      return true;
    },
  );
  // ЛУЧШЕЕ ИЗ ДОСТУПНОГО: справочник и записи поедут, даже если личность
  // осталась прежней. Отменять связывание из-за погашенного кода значило бы
  // отнять у филиала и то, что работало.
  assert.equal(readPairing(dir).role, 'secondary');
  db.close();
});

test('офлайн — тоже своя фраза, и повторять погашение никто не будет', async () => {
  // Отложенное погашение означало бы, что установка однажды сменит личность
  // сама, без человека, в неизвестный момент. Цена выше сэкономленного нажатия,
  // поэтому лекарство простое и сказано словами: ввести ключ ещё раз.
  const dir = inDir('adopt-offline');
  const db = freshDb();
  standalone(dir);
  const fake = fakeEnroll({ ok: false, reason: 'offline' });

  await assert.rejects(
    () => branchSyncPairAdopt(db, { key: branchKey() }, admin, { enrollImpl: fake.enrollImpl }),
    (e) => e.message === reasonText('enroll_offline'),
  );
  assert.equal(readPairing(dir).role, 'secondary');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8')).clinic_id, 'c-000077',
    'личность не тронута');
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM control_state WHERE key LIKE 'branch_sync.pending%'").get().n, 0,
    'никакой отложенной попытки не заводится',
  );
  db.close();
});

test('каждый отказ погашения доезжает своей фразой', async () => {
  for (const [reason, code] of [
    ['too_many_attempts', 'enroll_too_many'],
    ['server_error', 'enroll_server_error'],
    ['bad_response', 'enroll_server_error'],
    ['write_failed', 'write_failed'],
  ]) {
    const dir = inDir('adopt-' + reason);
    const db = freshDb();
    standalone(dir);
    const fake = fakeEnroll({ ok: false, reason });
    await assert.rejects(
      () => branchSyncPairAdopt(db, { key: branchKey() }, admin, { enrollImpl: fake.enrollImpl }),
      (e) => e.message === reasonText(code),
      reason,
    );
    db.close();
  }
});

test('отказ СВЯЗЫВАНИЯ до погашения не доходит вовсе', async () => {
  // Личность меняет только тот ключ, который установка приняла целиком, вместе
  // с буквой. Ключ с занятой буквой отвергается — и код в нём не тратится.
  const dir = inDir('pair-refused');
  const db = freshDb();
  standalone(dir);
  const fake = fakeEnroll();

  await assert.rejects(
    () => branchSyncPairAdopt(db, { key: branchKey({ letter: 'A' }) }, admin, { enrollImpl: fake.enrollImpl }),
    (e) => e.message === reasonText('letter_spent'),
  );
  assert.deepEqual(fake.calls, []);
  assert.equal(readPairing(dir), null, 'отказ не оставляет и файла пары');
  db.close();
});
