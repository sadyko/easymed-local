// BRANCH_IDENTITY_V1 — слой RPC экрана «Настройки → Филиалы»: то, что отделяет
// уже работающие сервисы от владельца, вводящего ключ.
//
// Проверяется ровно два свойства, и оба до этой задачи не выполнялись:
//   1. ключ с буквой, введённый на экране, действительно доезжает до базы.
//      Сервисы это умели (pairing.test.js, identity.test.js), а вызов — нет: он
//      не передавал базу, и активация с буквой была невозможна В ПРИНЦИПЕ;
//   2. каждый отказ активации доезжает до владельца СВОЕЙ фразой. Общее «Не
//      удалось выполнить действие» на экране, у которого почти каждый отказ
//      чинится по-разному (взять другой ключ / выпустить заново / позвать
//      поддержку), стоит владельцу вечера и звонка.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { encodeKey, readPairing, writePairing } from '../branch-sync/pairing.js';
import { readIdentity } from '../branch-sync/identity.js';
import { branchSyncPair, reasonText } from './branch-sync.js';

const admin = { id: 1, role: 'admin' };

// Каталог данных в этом процессе один (control/config.js объясняет почему), и
// экранные вызовы читают его сами. Поэтому каждый тест ставит свой.
function inDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-rpc-branch-' + tag + '-'));
  setDataDir(dir);
  return dir;
}

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

const key = (over = {}) => encodeKey({
  group_id: 'BR-AAAAAAAAAAAA', secret: 'sec', main_url: 'http://10.0.0.5:8000',
  letter: 'C', relay_token: 'rt-abc', ...over,
});

test('ключ с буквой, введённый на экране, действительно меняет филиал установки', () => {
  // ГЛАВНОЕ УТВЕРЖДЕНИЕ ЭТОЙ ЗАДАЧИ. Вызов не передавал базу, а pairWithKey без
  // базы отказывает ключу с буквой (identity_unavailable) — и правильно делает:
  // молча связаться, не приняв букву, значит начать печатать A-номера рядом с
  // главным филиалом. Итог был тот, что владелец не мог активировать филиал
  // ВООБЩЕ, как только ключи стали нести букву.
  const dir = inDir('pair-letter');
  const db = freshDb();

  const r = branchSyncPair(db, { key: key() }, admin);
  assert.equal(r.ok, true);
  assert.deepEqual(readIdentity(db), { letter: 'C', role: 'secondary', branch_id: 2 });
  assert.equal(readPairing(dir).role, 'secondary');
  assert.equal(readPairing(dir).relay_token, 'rt-abc',
    'токен резервного канала — единственная учётка филиала у поставщика, и он обязан лечь на диск');

  // То, ради чего буква заведена: номера пациентов этого здания больше не
  // пересекаются с номерами главного филиала.
  db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run();
  assert.match(db.prepare('SELECT mrn FROM patients ORDER BY id DESC LIMIT 1').get().mrn, /^C-/);
  db.close();
});

test('ключ без буквы по-прежнему связывает и базу не трогает', () => {
  // Обратная сторона той же передачи базы: получив базу, вызов не начал ею
  // пользоваться там, где буквы нет. Ключ старого выпуска обязан связывать
  // ровно как до обновления.
  const dir = inDir('pair-noletter');
  const db = freshDb();
  const r = branchSyncPair(db, { key: key({ letter: null, relay_token: null }) }, admin);
  assert.equal(r.ok, true);
  assert.deepEqual(readIdentity(db), { letter: 'A', role: 'main', branch_id: 1 });
  assert.equal(readPairing(dir).role, 'secondary');
  db.close();
});

test('«здесь уже есть свои номера» — отдельная фраза, а не «не удалось выполнить действие»', () => {
  // Самый тяжёлый отказ этапа: установка уже зарегистрировала пациентов под
  // своей буквой, и принять чужую значит оставить эти номера указывающими на
  // чужой филиал. Выход есть (перенумерация с согласия владельца), но его ещё
  // не построили, поэтому фраза обязана описать положение и НЕ обещать кнопку.
  const dir = inDir('numbered');
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run();

  assert.throws(() => branchSyncPair(db, { key: key() }, admin), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.message, reasonText('already_numbered'));
    assert.notEqual(e.message, reasonText('нет такого кода'), 'общая фраза здесь бесполезна');
    return true;
  });
  assert.equal(readPairing(dir), null, 'отказ не оставляет и файла пары');
  db.close();
});

test('занятая буква тоже называется своим именем', () => {
  // 'A' потрачена самой миграцией 080 на главный филиал, поэтому на чистой
  // установке это letter_spent — и владельцу надо услышать «возьмите ключ с
  // другой буквой», а не общую фразу.
  const dir = inDir('spent');
  const db = freshDb();
  assert.throws(() => branchSyncPair(db, { key: key({ letter: 'A' }) }, admin),
    (e) => e.message === reasonText('letter_spent'));
  assert.equal(readPairing(dir), null);
  db.close();
});

test('слишком длинная буква — это про букву, а не про то, что ключ недокопировали', () => {
  const dir = inDir('longletter');
  const db = freshDb();
  assert.throws(() => branchSyncPair(db, { key: key({ letter: 'A'.repeat(9) }) }, admin),
    (e) => e.message === reasonText('bad_letter'));
  assert.equal(readPairing(dir), null);
  db.close();
});

test('уже подключённый филиал слышит про свою букву, а не общую фразу', () => {
  const dir = inDir('already-sec');
  const db = freshDb();
  assert.equal(branchSyncPair(db, { key: key() }, admin).ok, true);
  assert.throws(() => branchSyncPair(db, { key: key({ letter: 'D' }) }, admin),
    (e) => e.message === reasonText('already_secondary'));
  db.close();
});

// --- словарь причин --------------------------------------------------------

test('у каждого кода отказа активации есть своя фраза', () => {
  // Список — закрытый словарь pairWithKey (см. его @returns) плюс коды
  // identity.js, которые проходят сквозь него неизменными. Общая фраза здесь
  // означает, что владелец видит «не удалось выполнить действие» в положении, у
  // которого есть конкретное лекарство.
  const generic = reasonText('это не код причины');
  for (const reason of [
    'empty_key', 'bad_key', 'bad_letter', 'already_main', 'already_secondary', 'write_failed',
    'identity_unavailable', 'already_numbered', 'letter_spent', 'letter_in_mrns',
    'letter_on_branch', 'identity_missing', 'identity_failed', 'rollback_failed',
  ]) {
    assert.notEqual(reasonText(reason), generic, reason + ' не переведён');
    assert.ok(reasonText(reason).length > 20, reason + ': фраза должна что-то объяснять');
  }
});

test('«ключ неверный» и «буква неверная» — разные советы', () => {
  // «Проверьте, что он скопирован целиком» — неверная подсказка для ключа,
  // который скопировали целиком, а буква в нём кириллическая: «С» и «C»
  // выглядят одинаково. Лечится это перевыпуском ключа, а не повторным
  // копированием.
  assert.notEqual(reasonText('bad_key'), reasonText('bad_letter'));
  assert.match(reasonText('bad_key'), /целиком/);
  assert.doesNotMatch(reasonText('bad_letter'), /целиком/);
});

test('несостоявшийся откат не выдаёт себя за занятую букву', () => {
  // rollback_failed означает, что файл пары и база разошлись: назвать это
  // «буква занята» было бы враньём, и владелец пошёл бы за другим ключом вместо
  // того, чтобы позвать поддержку.
  const text = reasonText('rollback_failed');
  for (const other of ['letter_spent', 'letter_on_branch', 'letter_in_mrns', 'bad_key']) {
    assert.notEqual(text, reasonText(other));
  }
  assert.doesNotMatch(text, /букв/i, 'причина не в букве');
  assert.match(text, /поддержк/i, 'это состояние чинит человек');
});

// --- карта соответствий ----------------------------------------------------

test('смена группы стирает карту соответствий, своя группа — нет', () => {
  // Поведение существовало до этой задачи и обязано пережить передачу базы:
  // «строка 7 главного филиала = наша строка 512» осмысленно только внутри той
  // пары (миграция 079).
  const dir = inDir('map');
  const db = freshDb();
  writePairing(dir, {
    role: 'secondary', group_id: 'BR-OLDOLDOLDOLD', secret: 'old',
    main_url: 'http://10.0.0.9:8000', source: 'manual', paired_at: new Date().toISOString(),
  });
  db.prepare('INSERT INTO branch_sync_map (table_name, remote_id, local_id) VALUES (?,?,?)')
    .run('services', 7, 512);

  assert.equal(branchSyncPair(db, { key: key() }, admin).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_sync_map').get().n, 0);
  db.close();
});
