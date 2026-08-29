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
import { encodeKey, parseKey, readPairing, writePairing } from '../branch-sync/pairing.js';
import { readIdentity } from '../branch-sync/identity.js';
import { branchRows } from '../../../public/js/admin/branch-sync-logic.js';
import {
  branchSyncPair, branchSyncStatus, branchSyncMakeKey, branchSyncBranches,
  branchSyncAddBranch, branchSyncBranchKey, branchSyncRegenerateKey,
  branchSyncUnpair, reasonText,
} from './branch-sync.js';

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
    (e) => e.message === reasonText('already_other_branch'));
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
    'already_other_branch', 'identity_is_branch',
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

// --- BRANCH_IDENTITY_V1: список филиалов и ПОСТОЯННЫЕ ключи ----------------
//
// Требование владельца дословно: «in the branch list should be only the branch
// name. and activation key (not one time generated)». Проверяется здесь именно
// НЕОДНОРАЗОВОСТЬ: тот же ключ обязан читаться сколько угодно раз и не меняться
// между чтениями, потому что филиальный компьютер переустанавливают, а код,
// показанный однажды, к этому моменту потерян.

// Учётка резервного канала выписывается у поставщика по сети. В этих тестах
// сети нет: подставляем выписку, чтобы проверять СВОЙ код, а не чужой сервер.
const mintOk = async () => ({ ok: true, token: 'relay-tok-1', relay_id: 'a'.repeat(32) });
const mintOk2 = async () => ({ ok: true, token: 'relay-tok-2', relay_id: 'b'.repeat(32) });
const mintOffline = async () => ({ ok: false, reason: 'relay_offline' });

function asMain(url = 'http://10.0.0.5:8000') {
  const db = freshDb();
  assert.equal(branchSyncMakeKey(db, { url }, admin).ok, true);
  return db;
}

test('список филиалов даёт имя, букву и ключ, а главному филиалу — честное «ключа нет»', () => {
  inDir('list');
  const db = asMain();
  const list = branchSyncBranches(db, {}, admin);
  assert.equal(list.role, 'main');
  assert.equal(list.can_issue, true);
  assert.equal(list.branches.length, 1, 'на чистой установке филиал ровно один — она сама');

  const self = list.branches[0];
  assert.equal(self.is_self, true);
  assert.equal(self.letter, 'A');
  assert.equal(self.key, null, 'подключать установку к самой себе не к чему');
  db.close();
});

test('ключ филиала читается сколько угодно раз и не меняется — это и просил владелец', async () => {
  inDir('permanent');
  const db = asMain();
  const added = await branchSyncAddBranch(db, { name: 'Чиланзар' }, admin, { mintImpl: mintOk });
  assert.equal(added.ok, true);
  assert.equal(added.branch.letter, 'B', 'A занята главным филиалом ещё миграцией 080');
  assert.ok(added.branch.key, 'ключ выдаётся сразу, а не «покажется один раз»');

  // ТО САМОЕ СВОЙСТВО: второе и третье чтение отдают ТУ ЖЕ строку. Одноразовый
  // код, который никто не записал, превращает переустановку филиала в звонок
  // поставщику.
  const again = branchSyncBranches(db, {}, admin).branches.find((b) => b.id === added.branch.id);
  const third = branchSyncBranches(db, {}, admin).branches.find((b) => b.id === added.branch.id);
  assert.equal(again.key, added.branch.key);
  assert.equal(third.key, added.branch.key);

  // И это рабочий ключ, а не строка для показа: он разбирается, несёт букву и
  // учётку резервного канала.
  const parsed = parseKey(added.branch.key);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.letter, 'B');
  assert.equal(parsed.relay_token, 'relay-tok-1');
  assert.equal(parsed.main_url, 'http://10.0.0.5:8000');
  db.close();
});

test('буква тратится безвозвратно, поэтому двойное нажатие ловится по названию', async () => {
  inDir('dup');
  const db = asMain();
  await branchSyncAddBranch(db, { name: 'Юнусабад' }, admin, { mintImpl: mintOk });
  await assert.rejects(
    () => branchSyncAddBranch(db, { name: 'юнусабад' }, admin, { mintImpl: mintOk }),
    (e) => e.message === reasonText('branch_duplicate_name'),
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branches').get().n, 2, 'вторая строка не завелась');
  // И буква на неё не потрачена: очередь клиники не должна худеть от опечатки.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branch_letters_spent WHERE kind = 'issue'").get().n, 2);
  db.close();
});

test('без интернета филиал всё равно заводится, а про резервный канал сказано прямо', async () => {
  // Маршрут А (филиал ходит к главному напрямую) от поставщика не зависит
  // вовсе. Сорвать заведение филиала из-за недоступного сервера значило бы
  // сделать офлайновую клинику заложником чужого сервера.
  inDir('offline-mint');
  const db = asMain();
  const added = await branchSyncAddBranch(db, { name: 'Себзар' }, admin, { mintImpl: mintOffline });
  assert.equal(added.ok, true);
  assert.ok(added.branch.key, 'ключ выдан');
  assert.equal(added.relay.ok, false);
  assert.equal(added.relay.reason, 'relay_offline');
  assert.equal(added.relay.message, reasonText('relay_offline'));
  assert.equal(parseKey(added.branch.key).relay_token, null, 'учётки нет — и в ключе её нет');
  db.close();
});

test('филиал без буквы — не тупик: ключ ему выдаётся отдельной кнопкой', async () => {
  // Достижимо и обычно: строки в списке филиалов заводили и до появления букв,
  // и заводят через общий редактор того же экрана, который про буквы не знает.
  inDir('letterless');
  const db = asMain();
  const id = db.prepare("INSERT INTO branches (name) VALUES ('Старый филиал')").run().lastInsertRowid;

  const before = branchSyncBranches(db, {}, admin).branches.find((b) => b.id === id);
  assert.equal(before.letter, null);
  assert.equal(before.key, null);

  const issued = await branchSyncBranchKey(db, { branch_id: id }, admin, { mintImpl: mintOk });
  assert.equal(issued.branch.letter, 'B');
  assert.equal(parseKey(issued.branch.key).letter, 'B');
  db.close();
});

test('себе ключ не выдаётся, и это сказано словами', async () => {
  inDir('self-key');
  const db = asMain();
  await assert.rejects(
    () => branchSyncBranchKey(db, { branch_id: 1 }, admin, { mintImpl: mintOk }),
    (e) => e.message === reasonText('branch_is_self'),
  );
  db.close();
});

test('ОТВЯЗАННЫЙ ФИЛИАЛ НЕ СТАНОВИТСЯ ВТОРЫМ РАЗДАТЧИКОМ БУКВ', async () => {
  // САМАЯ ДОРОГАЯ ОШИБКА ЭТОГО ЭТАПА, и она стоила ровно того, ради чего буква
  // заведена. «Отвязать» стирает ФАЙЛ пары и намеренно не трогает
  // branch_identity: буква потрачена, и отменить её нельзя. Но обе проверки
  // «я главный?» смотрели в стёртый файл, а не в базу, поэтому филиал C после
  // отвязки объявлял себя главным и начинал раздавать буквы из СВОЕЙ истории
  // (A, B, C потрачены -> выдаёт D), пока настоящий главный выдавал D другому
  // зданию. Два здания, одна буква, одинаковые номера пациентов, и ни одна
  // проверка не срабатывает.
  //
  // Измерено через настоящие вызовы, а не подстановкой строк в таблицы.
  const dir = inDir('ex-secondary');
  const db = freshDb();
  // Установка стала филиалом C по ключу главного филиала...
  assert.equal(branchSyncPair(db, { key: key() }, admin).letter, 'C');
  // ...и владелец её отвязал. Файл ушёл, буква осталась — так и задумано.
  assert.equal(branchSyncUnpair(db, {}, admin).ok, true);
  assert.equal(readPairing(dir), null, 'файл пары стёрт');
  assert.deepEqual(readIdentity(db), { letter: 'C', role: 'secondary', branch_id: 2 },
    'буква НЕ отменяется отвязкой: она уже напечатана на карточках');

  // Отказ читается из БАЗЫ, а не из файла, которого больше нет.
  assert.throws(() => branchSyncMakeKey(db, { url: 'http://10.0.0.9:8000' }, admin),
    (e) => e.message === reasonText('identity_is_branch'));
  // И фраза обязана объяснять ПОЧЕМУ: «сначала отвяжите» здесь — невыполнимый
  // совет, отвязка уже произошла и ничего не изменила.
  assert.doesNotMatch(reasonText('identity_is_branch'), /отвяж/i);
  assert.match(reasonText('identity_is_branch'), /C|букв/,
    'владелец должен услышать, каким филиалом эта установка является');

  // Вторая дверь в ту же комнату: выдача буквы новому филиалу.
  await assert.rejects(
    () => branchSyncAddBranch(db, { name: 'Самозванец' }, admin, { mintImpl: mintOk }),
    (e) => e.message === reasonText('identity_is_branch'),
  );
  // Ни одна буква не потрачена сверх той, что установка приняла.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branch_letters_spent WHERE kind = 'issue'").get().n, 2,
    'A от миграции и C, принятая этой установкой — больше ничего');
  db.close();
});

test('«отвяжите сначала» и «эта установка — филиал C» это РАЗНЫЕ отказы', () => {
  // Один код на два положения означал невыполнимый совет в одном из них.
  // Файловый отказ чинится отвязкой; отказ из базы — не чинится ничем, кроме
  // чистой установки, и говорить про отвязку в нём нельзя.
  assert.notEqual(reasonText('already_secondary'), reasonText('identity_is_branch'));
  assert.match(reasonText('already_secondary'), /отвяж/i);
  assert.match(reasonText('identity_is_branch'), /установ/i);

  // То же и на стороне принятия чужой буквы: база отказывает своим кодом.
  inDir('other-letter');
  const db = freshDb();
  assert.equal(branchSyncPair(db, { key: key() }, admin).ok, true);
  branchSyncUnpair(db, {}, admin);
  assert.throws(() => branchSyncPair(db, { key: key({ letter: 'D' }) }, admin),
    (e) => e.message === reasonText('already_other_branch'));
  assert.doesNotMatch(reasonText('already_other_branch'), /отвяж/i,
    'отвязка уже произошла и ничего не изменила — советовать её нельзя');
  db.close();
});

test('бывший филиал не предлагает ключ на чужую строку своего списка', async () => {
  // Следствие той же дыры: строка 1 «Main Branch» с буквой A досталась установке
  // от миграции, своей она никогда не была (branch_identity.branch_id = 2), и
  // ключ на неё несёт букву A, которую отвергнет любая установка на свете.
  inDir('foreign-row');
  const db = freshDb();
  branchSyncPair(db, { key: key() }, admin);
  branchSyncUnpair(db, {}, admin);
  const list = branchSyncBranches(db, {}, admin);
  assert.equal(list.can_issue, false, 'эта установка ключей не выдаёт вовсе');
  for (const b of list.branches) assert.equal(b.key, null, JSON.stringify(b));
  db.close();
});

test('не главный филиал ключей не выдаёт и не делает вид, что может', async () => {
  inDir('not-main');
  const db = freshDb();
  const list = branchSyncBranches(db, {}, admin);
  assert.equal(list.role, 'none');
  assert.equal(list.can_issue, false);
  assert.equal(list.branches[0].key, null);
  await assert.rejects(
    () => branchSyncAddBranch(db, { name: 'Новый' }, admin, { mintImpl: mintOk }),
    (e) => e.message === reasonText('branch_not_main'),
  );
  db.close();
});

test('после перевыпуска ключа филиал ВИДНО и доступ выписывается заново', async () => {
  // ИЗМЕРЕННЫЙ ТУПИК, а не гипотеза: перевыпуск гасит учётки филиалов (они
  // привязаны к адресу, который умер вместе с ключом группы), и это правильно.
  // Не хватало второй половины — способа выписать их снова. Строка с буквой
  // всегда выглядела как 'key', экран не предлагал ничего, и владелец, сделав
  // ровно то, что этот же экран ему советует, раздавал дальше ключи без
  // резервного канала и не знал об этом.
  const dir = inDir('reissue-cure');
  fs.writeFileSync(path.join(dir, 'control.json'),
    JSON.stringify({ clinic_id: 'c-1', install_token: 'tok-AAAA' }));
  const db = asMain();
  const added = await branchSyncAddBranch(db, { name: 'Чиланзар' }, admin, { mintImpl: mintOk });
  assert.equal(parseKey(added.branch.key).relay_token, 'relay-tok-1');

  branchSyncRegenerateKey(db, {}, admin);

  const after = branchSyncBranches(db, {}, admin);
  const row = after.branches.find((b) => b.id === added.branch.id);
  assert.equal(after.can_relay, true, 'клиника активирована — выписать учётку она может');
  assert.equal(row.has_relay_token, false, 'мёртвая учётка стёрта вместе с адресом');
  // ТО, ЧЕГО НЕ БЫЛО: экран отличает такую строку от исправной.
  assert.equal(branchRows(after).find((r) => r.id === row.id).state, 'key_no_relay');

  // И лекарство работает: тот же вызов выписывает учётку заново.
  const fixed = await branchSyncBranchKey(db, { branch_id: row.id }, admin, { mintImpl: mintOk2 });
  assert.equal(fixed.relay.ok, true);
  assert.equal(parseKey(fixed.branch.key).relay_token, 'relay-tok-2');
  const healed = branchSyncBranches(db, {}, admin);
  assert.equal(branchRows(healed).find((r) => r.id === row.id).state, 'key');
  db.close();
});

test('филиал, заведённый без интернета, получает доступ, когда интернет вернулся', async () => {
  // Та же дыра с другой стороны, и она делала фразу relay_branch_no_token
  // невыполнимой: филиал просил «возьмите новый ключ подключения в главном
  // филиале», а главный отдавал ровно тот же ключ без учётки, сколько бы раз
  // его ни показывали.
  const dir = inDir('offline-cure');
  fs.writeFileSync(path.join(dir, 'control.json'),
    JSON.stringify({ clinic_id: 'c-1', install_token: 'tok-AAAA' }));
  const db = asMain();
  const added = await branchSyncAddBranch(db, { name: 'Себзар' }, admin, { mintImpl: mintOffline });
  assert.equal(added.relay.ok, false);
  assert.equal(parseKey(added.branch.key).relay_token, null);

  const before = branchSyncBranches(db, {}, admin);
  assert.equal(branchRows(before).find((r) => r.id === added.branch.id).state, 'key_no_relay',
    'экран обязан показать кнопку, иначе филиал остаётся без канала навсегда');

  const fixed = await branchSyncBranchKey(db, { branch_id: added.branch.id }, admin, { mintImpl: mintOk });
  assert.equal(parseKey(fixed.branch.key).relay_token, 'relay-tok-1');
  db.close();
});

test('неактивированной клинике кнопку не показывают: выписать учётку ей нечем', async () => {
  // Без control.json резервный канал недоступен КЛИНИКЕ, а не филиалу, и
  // кнопка отказывала бы всегда.
  inDir('no-enrol');
  const db = asMain();
  const added = await branchSyncAddBranch(db, { name: 'Мирзо' }, admin, { mintImpl: mintOffline });
  const list = branchSyncBranches(db, {}, admin);
  assert.equal(list.can_relay, false);
  assert.equal(branchRows(list).find((r) => r.id === added.branch.id).state, 'key');
  db.close();
});

test('перевыпуск ключа синхронизации гасит и учётки филиалов', async () => {
  // Учётка филиала выписана НА АДРЕС, выведенный из ключа группы. Ключ группы
  // сменился — адреса больше нет, и старая учётка в свежем ключе дала бы филиалу
  // 401 вместо честного «учётки нет».
  inDir('regen');
  const db = asMain();
  const added = await branchSyncAddBranch(db, { name: 'Мирзо' }, admin, { mintImpl: mintOk });
  assert.equal(parseKey(added.branch.key).relay_token, 'relay-tok-1');

  assert.equal(branchSyncRegenerateKey(db, {}, admin).ok, true);
  const after = branchSyncBranches(db, {}, admin).branches.find((b) => b.id === added.branch.id);
  assert.equal(parseKey(after.key).relay_token, null, 'мёртвая учётка не должна ехать в новом ключе');
  db.close();
});

test('подключение возвращает ПРИНЯТУЮ БУКВУ, чтобы экран подтвердил ею, а не «готово»', () => {
  // Владелец только что ввёл длинный ключ, выпущенный на другой машине. Буква —
  // единственное, что он может сверить глазами.
  inDir('pair-letter-back');
  const db = freshDb();
  assert.equal(branchSyncPair(db, { key: key() }, admin).letter, 'C');
  db.close();
});

test('ключ без буквы возвращает null, а не выдуманную букву', () => {
  inDir('pair-noletter-back');
  const db = freshDb();
  const r = branchSyncPair(db, { key: key({ letter: null, relay_token: null }) }, admin);
  assert.equal(r.ok, true);
  assert.equal(r.letter, null, 'установка осталась при своей прежней букве — выдумывать нечего');
  db.close();
});

test('статус называет букву этой установки — её спрашивает регистратура, а не администратор', () => {
  inDir('status-letter');
  const db = freshDb();
  assert.equal(branchSyncPair(db, { key: key() }, admin).ok, true);
  const st = branchSyncStatus(db, {}, admin);
  assert.equal(st.letter, 'C');
  assert.equal(st.identity_role, 'secondary');
  db.close();
});

// --- две правки формулировок, которые 6a отложила --------------------------

test('подключённому филиалу больше не советуют активировать клинику', () => {
  // Он у поставщика не активирован и активирован не будет: он подключался к
  // клинике. Единственная его учётка приезжает ВНУТРИ ключа подключения,
  // поэтому оба совета обязаны вести в главный филиал.
  const generic = reasonText('это не код причины');
  for (const reason of ['relay_branch_no_token', 'relay_branch_revoked']) {
    const text = reasonText(reason);
    assert.notEqual(text, generic, reason + ' не переведён');
    assert.match(text, /ключ[а-я]* подключения/, reason + ': лекарство — новый ключ');
    assert.match(text, /главном филиале/, reason + ': и берут его на другой машине');
    assert.doesNotMatch(text, /активирована|активацию/, reason + ': активация клиники здесь ни при чём');
  }
  // А у ГЛАВНОГО филиала прежние фразы остаются верными и не смешиваются с этими.
  assert.match(reasonText('relay_not_enrolled'), /не активирована/);
  assert.notEqual(reasonText('relay_unauthorized'), reasonText('relay_branch_revoked'));
});

test('у каждого нового кода списка филиалов есть своя фраза', () => {
  const generic = reasonText('это не код причины');
  for (const reason of [
    'branch_not_main', 'branch_no_url', 'branch_no_name', 'branch_duplicate_name',
    'branch_unknown', 'branch_is_self', 'branch_letters_gone', 'branch_add_failed',
    'relay_too_many_tokens',
  ]) {
    assert.notEqual(reasonText(reason), generic, reason + ' не переведён');
    assert.ok(reasonText(reason).length > 20, reason + ': фраза должна что-то объяснять');
  }
});
