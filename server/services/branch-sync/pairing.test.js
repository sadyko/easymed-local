// BRANCH_SYNC_V1 — связывание филиалов: ключ, файл на диске, подпись запроса.
//
// Проверяется то же, что enroll.test.js проверяет у активации: установка либо
// получает целую запись, либо остаётся ровно такой, какой была, и ни одна
// испорченная запись не выглядит рабочей.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  makeMainKey, pairWithKey, parseKey, encodeKey, readPairing, writePairing, clearPairing,
  normalizeUrl, signRequest, verifySignature, skewMs, lanAddresses, suggestMainUrl,
  pairingPath, CATALOGUE_PATH, MAX_SKEW_MS,
  relayEnabled, decodeGroupKey, GROUP_KEY_BYTES,   // BRANCH_SYNC_RELAY_V1
  encodeLegacyV1, b64url,                          // BRANCH_IDENTITY_V1
} from './pairing.js';
// BRANCH_IDENTITY_V1 — активация трогает и базу: связывание ключом, несущим
// букву, обязано оставить установку либо целиком подключённой, либо ровно такой,
// какой она была, и проверить это можно только против настоящей схемы.
import { readIdentity } from './identity.js';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'em-branch-' + tag + '-'));

test('главный филиал выпускает ключ, вторичный его принимает', () => {
  const mainDir = tmp('main');
  const secDir = tmp('sec');

  const made = makeMainKey(mainDir, { url: '10.0.0.5:8000' });
  assert.equal(made.ok, true);
  assert.equal(made.record.role, 'main');
  assert.equal(made.record.main_url, 'http://10.0.0.5:8000');
  assert.match(made.record.group_id, /^BR-[0-9A-F]{12}$/);

  const paired = pairWithKey(secDir, made.key);
  assert.equal(paired.ok, true);
  assert.equal(paired.record.role, 'secondary');
  assert.equal(paired.record.group_id, made.record.group_id);
  assert.equal(paired.record.secret, made.record.secret, 'обе стороны держат один секрет');
  assert.equal(paired.record.main_url, 'http://10.0.0.5:8000');

  assert.equal(readPairing(secDir).role, 'secondary');
});

test('ключ переживает перенос через мессенджер: пробелы и переводы строк', () => {
  const dir = tmp('ws');
  const made = makeMainKey(dir, { url: 'http://127.0.0.1:8000' });
  const mangled = made.key.slice(0, 20) + '\n  ' + made.key.slice(20, 40) + ' \r\n' + made.key.slice(40);
  const parsed = parseKey(mangled);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.secret, made.record.secret);
});

test('повторный вызов НЕ перевыпускает секрет — иначе связывание второго филиала рвало бы первый', () => {
  const dir = tmp('again');
  const first = makeMainKey(dir, { url: '10.0.0.5:8000' });
  const second = makeMainKey(dir, { url: '10.0.0.9:8000' });
  assert.equal(second.record.secret, first.record.secret);
  assert.equal(second.record.group_id, first.record.group_id);
  assert.equal(second.record.main_url, 'http://10.0.0.9:8000', 'адрес обновить можно — он не тайна');
});

test('установка не может быть одновременно источником и приёмником', () => {
  const mainDir = tmp('role1');
  const secDir = tmp('role2');
  const made = makeMainKey(mainDir, { url: '10.0.0.5:8000' });

  assert.equal(pairWithKey(mainDir, made.key).reason, 'already_main');

  pairWithKey(secDir, made.key);
  assert.equal(makeMainKey(secDir, { url: '10.0.0.6:8000' }).reason, 'already_secondary');
  assert.equal(readPairing(secDir).role, 'secondary', 'отказ не должен ничего переписывать');
});

test('испорченный ключ отвергается и НИЧЕГО не пишет на диск', () => {
  const dir = tmp('bad');
  const cases = ['', '   ', 'не ключ', 'EMB1-', 'EMB1-@@@@', 'EMB1-' + Buffer.from('{"v":9}').toString('base64url')];
  for (const c of cases) {
    const r = pairWithKey(dir, c);
    assert.equal(r.ok, false, JSON.stringify(c));
    assert.ok(['empty_key', 'bad_key'].includes(r.reason), c + ' -> ' + r.reason);
  }
  assert.equal(fs.existsSync(pairingPath(dir)), false, 'отказ не создаёт файл пары');
  assert.equal(readPairing(dir), null);
});

test('ключ без адреса или без секрета — не ключ', () => {
  assert.equal(parseKey(encodeKey({ group_id: 'BR-1', secret: 's', main_url: '' })).ok, false);
  assert.equal(parseKey(encodeKey({ group_id: '', secret: 's', main_url: 'http://x:1' })).ok, false);
  assert.equal(parseKey(encodeKey({ group_id: 'BR-1', secret: '', main_url: 'http://x:1' })).ok, false);
});

test('адрес нормализуется, а логин с паролем в URL отбрасывается', () => {
  assert.equal(normalizeUrl('10.0.0.5:8000'), 'http://10.0.0.5:8000');
  assert.equal(normalizeUrl('  https://branch.clinic.uz/  '), 'https://branch.clinic.uz');
  assert.equal(normalizeUrl('http://host:8000/some/path?x=1'), 'http://host:8000', 'остаётся только origin');
  // Ключ связывания не должен уметь переносить чужие учётные данные.
  assert.equal(normalizeUrl('http://user:pass@host:8000'), null);
  assert.equal(normalizeUrl('file:///C:/windows'), null);
  assert.equal(normalizeUrl('ftp://host'), null);
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl(null), null);
});

test('битый или неполный файл пары читается как «не спарено», а не как авария', () => {
  const dir = tmp('corrupt');
  const bad = [
    'не json',
    '[]',
    '{}',
    JSON.stringify({ role: 'main' }),
    JSON.stringify({ role: 'секретарь', group_id: 'g', secret: 's' }),
    // вторичный без адреса: экран показал бы «связан», а ходить было бы некуда
    JSON.stringify({ role: 'secondary', group_id: 'g', secret: 's' }),
    JSON.stringify({ role: 'secondary', group_id: 'g', secret: 's', main_url: 'не адрес' }),
  ];
  for (const content of bad) {
    fs.writeFileSync(pairingPath(dir), content);
    assert.equal(readPairing(dir), null, content);
  }
  // BOM от блокнота не должен превращать рабочую пару в «не спарено».
  fs.writeFileSync(pairingPath(dir), '\uFEFF' + JSON.stringify({ role: 'main', group_id: 'g', secret: 's', main_url: 'http://h:1' }));
  assert.equal(readPairing(dir).role, 'main');
});

test('подпись сходится только с тем же секретом, группой, временем и путём', () => {
  const base = { secret: 'shared-secret', groupId: 'BR-ABC', ts: '1756000000000', requestPath: CATALOGUE_PATH };
  const sig = signRequest(base);

  assert.equal(verifySignature({ ...base, sig }), true);
  assert.equal(verifySignature({ ...base, secret: 'другой', sig }), false, 'чужой секрет');
  assert.equal(verifySignature({ ...base, groupId: 'BR-XYZ', sig }), false, 'чужая группа');
  assert.equal(verifySignature({ ...base, ts: '1756000000001', sig }), false, 'другая метка времени');
  assert.equal(verifySignature({ ...base, requestPath: '/api/branch-sync/other', sig }), false, 'другой путь');
  // Ни одна из этих форм не должна ни пройти, ни бросить.
  for (const junk of ['', null, undefined, '@@@', sig.slice(0, 10), sig + 'AA', 0, {}]) {
    assert.equal(verifySignature({ ...base, sig: junk }), false, String(junk));
  }
});

test('секрет никогда не уходит в сеть — в подписи его нет', () => {
  const secret = 'CAT-secret-value-that-must-not-travel';
  const sig = signRequest({ secret, groupId: 'BR-ABC', ts: '1', requestPath: CATALOGUE_PATH });
  assert.equal(sig.includes(secret), false);
  assert.equal(Buffer.from(sig, 'base64').toString('utf8').includes(secret), false);
});

test('окно по времени ограничивает повтор перехваченного запроса', () => {
  const now = 1_756_000_000_000;
  assert.equal(skewMs(String(now), now), 0);
  assert.equal(skewMs(String(now - 60_000), now), 60_000);
  assert.ok(skewMs(String(now - MAX_SKEW_MS - 1), now) > MAX_SKEW_MS);
  assert.ok(skewMs(String(now + MAX_SKEW_MS + 1), now) > MAX_SKEW_MS, 'часы вперёд считаются так же');
  for (const junk of ['', 'вчера', null, undefined, NaN]) {
    assert.equal(skewMs(junk, now), Number.POSITIVE_INFINITY, String(junk));
  }
});

test('«Отвязать» стирает файл пары, повторный вызов не падает', () => {
  const dir = tmp('unpair');
  makeMainKey(dir, { url: '10.0.0.5:8000' });
  assert.equal(clearPairing(dir), true);
  assert.equal(readPairing(dir), null);
  assert.equal(clearPairing(dir), false, 'второй раз просто нечего стирать');
});

test('запись атомарна: временный файл не остаётся рядом', () => {
  const dir = tmp('atomic');
  writePairing(dir, { role: 'main', group_id: 'g', secret: 's', main_url: 'http://h:1' });
  assert.deepEqual(fs.readdirSync(dir), ['branch-sync.json']);
});

test('подсказка адреса берёт первый внешний IPv4 и молчит, когда его нет', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth0: [{ family: 'IPv6', internal: false, address: 'fe80::1' }, { family: 'IPv4', internal: false, address: '10.4.1.19' }],
  };
  assert.deepEqual(lanAddresses({ interfaces: ifaces }), ['10.4.1.19']);
  assert.equal(suggestMainUrl({ port: 8000, interfaces: ifaces }), 'http://10.4.1.19:8000');
  assert.equal(suggestMainUrl({ port: 8000, interfaces: { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] } }), null);
});

// --- BRANCH_SYNC_RELAY_V1: ключ группы внутри ключа подключения -------------
//
// Ключ подключения — ЕДИНСТВЕННЫЙ путь, которым ключ шифрования попадает во
// второй филиал. Он переносится руками и не проходит через сервер поставщика,
// поэтому всё, что этот раздел проверяет, сводится к двум вопросам: доезжает ли
// он целым и что происходит, когда его нет.

const KEY32 = 'A'.repeat(43);   // 43 символа base64url — ровно 32 байта

test('ключ группы едет в ключе подключения и приземляется в записи филиала', () => {
  const mainDir = tmp('relay-main');
  const secDir = tmp('relay-sec');

  const made = makeMainKey(mainDir, { url: '10.0.0.5:8000', groupId: 'BR-ABCDEF012345', groupKey: KEY32 });
  assert.equal(made.ok, true);
  assert.equal(made.record.group_id, 'BR-ABCDEF012345', 'группа берётся из ключа, выписанного при активации');
  assert.equal(made.record.group_key, KEY32);

  const parsed = parseKey(made.key);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.group_key, KEY32);

  const paired = pairWithKey(secDir, made.key);
  assert.equal(paired.ok, true);
  assert.equal(paired.record.group_key, KEY32, 'оба филиала работают ОДНИМ ключом, иначе блоб не расшифровать');
});

test('ключ подключения без ключа группы — это Маршрут А, а не поломка', () => {
  // Ровно то, что лежит на диске у клиник, спаренных до Маршрута Б: связь
  // работает, резервный канал просто недоступен.
  const secDir = tmp('relay-old');
  const old = encodeKey({ group_id: 'BR-000000000001', secret: 'sss', main_url: 'http://10.0.0.5:8000' });
  const parsed = parseKey(old);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.group_key, null);

  const paired = pairWithKey(secDir, old);
  assert.equal(paired.ok, true);
  assert.equal('group_key' in paired.record, false, 'пустого поля на диске быть не должно — его отсутствие и есть ответ');
});

test('ключ группы не той длины отбрасывается, а не записывается огрызком', () => {
  // Обрезанный при копировании ключ зашифровал бы одну сторону и не расшифровал
  // другую, и выяснилось бы это через неделю. Лучше остаться без резервного
  // канала сразу.
  const short = encodeKey({ group_id: 'g', secret: 's', main_url: 'http://h:1', group_key: 'AAAA' });
  assert.equal(parseKey(short).group_key, null);
  const notText = encodeKey({ group_id: 'g', secret: 's', main_url: 'http://h:1' });
  assert.equal(parseKey(notText).group_key, null);
});

test('повторная выдача ключа не трогает ни секрет, ни ключ группы', () => {
  // Ключ печатают, пересылают и вводят не в один присест: «нажал ещё раз —
  // старый ключ умер» рвало бы связь уже подключённым филиалам.
  const dir = tmp('relay-stable');
  const first = makeMainKey(dir, { url: '10.0.0.5:8000', groupId: 'BR-111111111111', groupKey: KEY32 });
  const second = makeMainKey(dir, { url: '10.0.0.9:8000', groupId: 'BR-222222222222', groupKey: 'B'.repeat(43) });
  assert.equal(second.record.secret, first.record.secret);
  assert.equal(second.record.group_key, KEY32, 'ключ группы у существующей пары не подменяется');
  assert.equal(second.record.group_id, 'BR-111111111111');
  assert.equal(second.record.main_url, 'http://10.0.0.9:8000', 'а адрес обновить можно — он не тайна');
});

test('перевыпуск меняет ВСЁ: и ключ группы, и секрет подписи', () => {
  // Обещание экрана — «отключит все филиалы». Если бы менялся только ключ
  // шифрования, старые филиалы продолжали бы забирать справочник напрямую, и
  // обещание было бы правдой наполовину.
  const dir = tmp('relay-rotate');
  const before = makeMainKey(dir, { url: '10.0.0.5:8000', groupId: 'BR-111111111111', groupKey: KEY32 });
  const after = makeMainKey(dir, {
    url: '10.0.0.5:8000', groupId: 'BR-333333333333', groupKey: 'C'.repeat(43), rotate: true,
  });
  assert.notEqual(after.record.secret, before.record.secret);
  assert.equal(after.record.group_key, 'C'.repeat(43));
  assert.equal(after.record.group_id, 'BR-333333333333');
  // Старый ключ подключения после этого не подходит ни одним из двух путей.
  assert.notEqual(parseKey(after.key).secret, parseKey(before.key).secret);
});

test('согласие на резервный канал: главный — молчит, подключённый — соглашается', () => {
  // Умолчания разные, и это не небрежность. Главный филиал ОТДАЁТ байты наружу
  // — за него такое не решают. Подключённый ничего не отдаёт, только берёт уже
  // лежащее, и берёт лишь тогда, когда прямой путь не удался.
  assert.equal(relayEnabled({ role: 'main' }), false, 'выгрузка наружу — только по явному согласию владельца');
  assert.equal(relayEnabled({ role: 'main', relay: true }), true);
  assert.equal(relayEnabled({ role: 'secondary' }), true);
  assert.equal(relayEnabled({ role: 'secondary', relay: false }), false);
  assert.equal(relayEnabled(null), false);
});

test('согласие переживает повторную выдачу ключа', () => {
  const dir = tmp('relay-consent');
  makeMainKey(dir, { url: '10.0.0.5:8000', groupId: 'BR-111111111111', groupKey: KEY32 });
  writePairing(dir, { ...readPairing(dir), relay: true });
  const again = makeMainKey(dir, { url: '10.0.0.5:8000' });
  assert.equal(again.record.relay, true, 'нажатие «показать ключ» не должно молча выключать резервный канал');
});

test('ключ группы читается и как строка, и как байты, и только нужной длины', () => {
  assert.equal(GROUP_KEY_BYTES, 32, 'AES-256');
  assert.equal(decodeGroupKey(KEY32).length, 32);
  assert.equal(decodeGroupKey('AAAA'), null);
  assert.equal(decodeGroupKey(null), null);
  assert.equal(decodeGroupKey(Buffer.alloc(32)).length, 32);
  assert.equal(decodeGroupKey(Buffer.alloc(31)), null);
});

// --- BRANCH_IDENTITY_V1: буква филиала и токен резервного канала в ключе -----

test('EMB2 keys carry the branch letter and the relay token', () => {
  const key = encodeKey({
    group_id: 'g1', secret: 's1', main_url: 'http://10.0.0.5:8000',
    group_key: 'k'.repeat(43), letter: 'C', relay_token: 'rt-abc',
  });
  assert.match(key, /^EMB2-/);
  const parsed = parseKey(key);
  assert.equal(parsed.letter, 'C');
  assert.equal(parsed.relay_token, 'rt-abc');
});

test('an EMB1 key from an older release still parses, with no letter', () => {
  // Clinics paired before this release hold EMB1 keys. Refusing them would
  // silently un-pair every existing branch on upgrade.
  const legacy = encodeLegacyV1({ group_id: 'g1', secret: 's1', main_url: 'http://10.0.0.5:8000' });
  const parsed = parseKey(legacy);
  assert.equal(parsed.group_id, 'g1');
  assert.equal(parsed.letter, null, 'no letter in a v1 key - the caller must allocate one');
});

// --- BRANCH_IDENTITY_V1: активация владеет ДВУМЯ записями ---------------------
//
// pairWithKey перестал быть «записать файл»: ключ с буквой означает, что филиал
// одновременно принимает identity в базе (identity.js). Файл переписываем,
// identity — нет, поэтому проверяется здесь ровно одно: что после отказа или
// обрыва не остаётся ни половины.

function identityDb() { const db = openDb(':memory:'); migrate(db); return db; }

const v2key = (over = {}) => encodeKey({
  group_id: 'BR-AAAAAAAAAAAA', secret: 'sec', main_url: 'http://10.0.0.5:8000',
  letter: 'C', relay_token: 'rt-abc', ...over,
});

// Ключ, собранный МИМО encodeKey. Нужен именно такой: encodeKey не кладёт в
// ключ пустое поле, а проверять надо поведение при поле, которое ПРИСУТСТВУЕТ и
// испорчено — такой ключ приезжает не от нашего кода, а от того, кто его правил.
const rawV2 = (over) => 'EMB2-' + b64url(Buffer.from(JSON.stringify({
  v: 2, g: 'BR-AAAAAAAAAAAA', s: 'sec', u: 'http://10.0.0.5:8000', ...over,
}), 'utf8'));

test('ключ с буквой принимает identity в базе и пишет файл пары', () => {
  const dir = tmp('id-ok');
  const db = identityDb();
  const r = pairWithKey(dir, v2key(), { db });
  assert.equal(r.ok, true);
  assert.equal(r.identity.letter, 'C');
  assert.equal(r.identity.role, 'secondary');
  assert.equal(readPairing(dir).role, 'secondary');
  assert.equal(readPairing(dir).relay_token, 'rt-abc', 'токен резервного канала — единственная учётка вторичного филиала');
  db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run();
  assert.match(db.prepare('SELECT mrn FROM patients ORDER BY id DESC LIMIT 1').get().mrn, /^C-/);
});

test('отказ базы не оставляет НИЧЕГО: ни файла пары, ни записи identity', () => {
  // 'A' занята главным филиалом в самой миграции 080, поэтому на чистой
  // установке это отказ letter_spent.
  const dir = tmp('id-refuse');
  const db = identityDb();
  const r = pairWithKey(dir, v2key({ letter: 'A' }), { db });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'letter_spent');
  assert.equal(fs.existsSync(pairingPath(dir)), false, 'файл пары должен быть откачен');
  assert.equal(readIdentity(db).role, 'main', 'база не тронута');
});

test('отказ базы возвращает ПРЕЖНИЙ файл пары, а не стирает его', () => {
  // Владелец вводит второй ключ на уже подключённом филиале — обычное дело
  // (сменился адрес главного). Если ключ окажется негодным, связь, которая
  // работала минуту назад, обязана остаться работать.
  const dir = tmp('id-restore');
  const db = identityDb();
  pairWithKey(dir, encodeLegacyV1({ group_id: 'BR-OLD', secret: 'old', main_url: 'http://10.0.0.1:8000' }), { db });
  const before = fs.readFileSync(pairingPath(dir), 'utf8');

  const r = pairWithKey(dir, v2key({ letter: 'A', group_id: 'BR-NEW' }), { db });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(pairingPath(dir), 'utf8'), before, 'старая пара уцелела дословно');
});

test('обрыв МЕЖДУ записями: файл лёг, база не успела — повтор доводит дело до конца', () => {
  // Порядок «файл, потом база» выбран ради этого случая: переиграть можно
  // только то, что не потратило букву. Свет выключили после writeAtomic —
  // воспроизводим именно это, поэтому файл кладётся руками, а база чистая.
  const dir = tmp('id-crash1');
  const db = identityDb();
  writePairing(dir, { role: 'secondary', group_id: 'BR-AAAAAAAAAAAA', secret: 'sec', main_url: 'http://10.0.0.5:8000' });
  assert.equal(readIdentity(db).letter, 'A', 'база ещё думает, что она главный филиал');

  const again = pairWithKey(dir, v2key(), { db });
  assert.equal(again.ok, true);
  assert.equal(again.identity.letter, 'C');
});

test('обрыв ПОСЛЕ записи в базу: повторный ввод того же ключа не тратит вторую букву', () => {
  // Идемпотентность becomeSecondary (Задача 3) проверяется здесь сквозняком:
  // владелец жмёт кнопку ещё раз, потому что ответа он не увидел.
  const dir = tmp('id-crash2');
  const db = identityDb();
  const first = pairWithKey(dir, v2key(), { db });
  const second = pairWithKey(dir, v2key(), { db });
  assert.equal(second.ok, true);
  assert.deepEqual(second.identity, first.identity);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branches WHERE letter='C'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branch_letters_spent WHERE letter='C'").get().n, 1);
});

test('чужая буква на уже подключённом филиале отвергается, и пара остаётся прежней', () => {
  const dir = tmp('id-other');
  const db = identityDb();
  pairWithKey(dir, v2key(), { db });
  const before = fs.readFileSync(pairingPath(dir), 'utf8');
  // Другая группа и другой адрес — иначе «файл не изменился» проходило бы даром.
  const r = pairWithKey(dir, v2key({ letter: 'D', group_id: 'BR-OTHER', main_url: 'http://10.9.9.9:9' }), { db });
  assert.equal(r.reason, 'already_secondary');
  assert.equal(fs.readFileSync(pairingPath(dir), 'utf8'), before);
  assert.equal(readIdentity(db).letter, 'C');
});

test('already_numbered доезжает до вызывающего целым — на нём висит экран Задачи 6', () => {
  // Установка неделю работала сама по себе и напечатала номера под своей
  // буквой. Отказ терминальный до Задачи 6, поэтому код обязан дойти неизменным.
  const dir = tmp('id-numbered');
  const db = identityDb();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run();
  const r = pairWithKey(dir, v2key(), { db });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_numbered');
  assert.equal(fs.existsSync(pairingPath(dir)), false);
});

test('ключ с буквой, но БЕЗ базы — отказ, а не тихо пропущенная identity', () => {
  // Вызывающий, забывший db, иначе получил бы связанный филиал, который
  // продолжает печатать A-номера рядом с главным. Отказ виден сразу.
  const dir = tmp('id-nodb');
  const r = pairWithKey(dir, v2key());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'identity_unavailable');
  assert.equal(fs.existsSync(pairingPath(dir)), false);
});

test('ключ БЕЗ буквы базу не трогает: букву выдаёт главный филиал, а не мы', () => {
  // Ключ старого выпуска связывает как раньше. Своя выдача здесь означала бы
  // 'B' из собственного журнала — букву, которую главный уже отдал другому зданию.
  const dir = tmp('id-v1');
  const db = identityDb();
  const r = pairWithKey(dir, encodeLegacyV1({ group_id: 'g1', secret: 's1', main_url: 'http://10.0.0.5:8000' }), { db });
  assert.equal(r.ok, true);
  assert.equal(r.identity, null, 'null — «в ключе буквы не было», а не «у установки нет identity»');
  assert.deepEqual(readIdentity(db), { letter: 'A', role: 'main', branch_id: 1 });
  assert.equal(readPairing(dir).role, 'secondary');
});

test('ключ с буквой, но без токена — это Маршрут А, а не поломка', () => {
  // Достижимо: главный филиал выпускает ключ без интернета, и выписать токен
  // на сервере поставщика в этот момент нечем.
  const dir = tmp('id-notoken');
  const db = identityDb();
  const r = pairWithKey(dir, v2key({ relay_token: null }), { db });
  assert.equal(r.ok, true);
  assert.equal(r.identity.letter, 'C');
  assert.equal('relay_token' in readPairing(dir), false, 'пустого поля на диске быть не должно');
});

test('буква-подделка в ключе отвергается разбором и до базы не доходит', () => {
  // Кириллическая «С» неотличима от латинской на экране, а в номере пациента
  // это символ, который потом никто не наберёт в поиске.
  const dir = tmp('id-hostile');
  const db = identityDb();
  // 'A'.repeat(9) — не выдумка: ни миграция 080, ни identity.js букву по длине
  // не проверяют (080 проверяет только алфавит), так что тысяча «A» стала бы
  // префиксом каждого номера пациента. Единственная граница стоит в разборе.
  for (const bad of ['С', '1', 'C-', '', ' ', 'C;DROP', 'ß', 'A'.repeat(9), 42, {}, [], true]) {
    const r = pairWithKey(dir, rawV2({ l: bad, t: 'rt-abc' }), { db });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.reason, 'bad_key', JSON.stringify(bad) + ' -> ' + r.reason);
  }
  assert.equal(fs.existsSync(pairingPath(dir)), false);
  assert.equal(readIdentity(db).role, 'main');

  // А вот ЯВНЫЙ null — это «буквы нет», ровно как её отсутствие: так выглядит
  // ключ главного филиала, выписанный до того, как буквы начали раздавать.
  assert.equal(parseKey(rawV2({ l: null })).letter, null);
});

test('токен резервного канала не может протащить перевод строки в заголовок Authorization', () => {
  // Он уходит как `Authorization: Bearer <token>`; CR/LF там — это инъекция
  // заголовка. Отбрасывается так же, как ключ группы не той длины: связь важнее
  // резервного канала.
  for (const bad of ['rt\r\nX-Evil: 1', 'rt abc', '', '   ', 'x'.repeat(1000), 42, null, {}]) {
    const parsed = parseKey(rawV2({ l: 'C', t: bad }));
    assert.equal(parsed.ok, true, 'связь важнее: ключ остаётся годным');
    assert.equal(parsed.relay_token, null, JSON.stringify(bad));
    assert.equal(parsed.letter, 'C', 'и буква из того же ключа доезжает');
  }
});
