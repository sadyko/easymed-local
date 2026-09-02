import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { b64url, decodeGroupKey, GROUP_KEY_BYTES } from './pairing.js';
import { relayIdFor, sealPayload, openPayload, RELAY_ID_RE } from './relay-crypto.js';

// BRANCH_SYNC_RELAY_V1 — обещание, которое проверяет этот файл: то, что уезжает
// на сервер поставщика, поставщик прочитать не может, а то, что вернулось не
// тем ключом или с изменённым байтом, не применяется НИКОГДА и НИКАК.

const newKey = () => b64url(randomBytes(GROUP_KEY_BYTES));

const MARKER = 'ZZPATIENTMARKER';
const body = (extra = {}) => ({
  ok: true,
  group_id: 'BR-ABCDEF012345',
  generated_at: '2026-08-29T10:00:00Z',
  catalogue: { services: [{ id: 1, name: 'Приём кардиолога', price: 250000 }] },
  ...extra,
});

test('запечатать и распечатать своим ключом — то же самое, что положили', () => {
  const key = newKey();
  const sealed = sealPayload(key, body());
  assert.ok(Buffer.isBuffer(sealed));
  const opened = openPayload(key, sealed);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.deepEqual(opened.payload, body());
});

test('в шифротексте нет ни одного узнаваемого байта исходных данных', () => {
  const key = newKey();
  const sealed = sealPayload(key, body({ catalogue: { services: [{ id: 1, name: MARKER + ' услуга' }] } }));
  const asText = sealed.toString('latin1');
  assert.equal(asText.includes(MARKER), false, 'маркер не должен просматриваться в блобе');
  assert.equal(asText.includes('услуга'), false);
  assert.equal(asText.includes('catalogue'), false, 'даже имена полей не видны');
  // Единственное, что читается снаружи — метка формата: она и должна читаться,
  // по ней приёмник понимает, что это вообще наш блоб.
  assert.equal(sealed.subarray(0, 4).toString('ascii'), 'EMR1');
});

test('чужой ключ не расшифровывает — и это отдельная причина, а не «испорчено»', () => {
  const sealed = sealPayload(newKey(), body());
  const wrong = openPayload(newKey(), sealed);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'bad_key', 'экран обязан сказать «ключи филиалов не совпадают»');
});

test('подменённый на сервере байт отвергается целиком', () => {
  const key = newKey();
  const sealed = sealPayload(key, body());
  // Правим последний байт шифротекста — ровно то, что мог бы сделать
  // недобросовестный или сломанный сервер хранения.
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 0x01;
  const r = openPayload(key, tampered);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_key', 'подмена и чужой ключ неразличимы — и действие одно: не применять');
});

test('подменённый тег аутентификации тоже не проходит', () => {
  const key = newKey();
  const sealed = sealPayload(key, body());
  const tampered = Buffer.from(sealed);
  tampered[20] ^= 0xff;   // байт внутри тега (4 метка + 12 IV = 16..31)
  assert.equal(openPayload(key, tampered).ok, false);
});

test('обрезанный или чужого формата блоб — bad_blob, а не исключение', () => {
  const key = newKey();
  assert.equal(openPayload(key, Buffer.alloc(0)).reason, 'bad_blob');
  assert.equal(openPayload(key, Buffer.alloc(10)).reason, 'bad_blob');
  assert.equal(openPayload(key, Buffer.from('это вообще не блоб, а текст')).reason, 'bad_blob');
  // Верный размер, неверная метка формата.
  const fake = Buffer.concat([Buffer.from('XXXX'), randomBytes(64)]);
  assert.equal(openPayload(key, fake).reason, 'bad_blob');
});

test('без ключа не запечатывается и не распечатывается ничего', () => {
  assert.equal(sealPayload(null, body()), null);
  assert.equal(sealPayload('', body()), null);
  // Ключ не той длины — не ключ. Огрызок, записанный на диск, дал бы «не
  // расшифровывается» через неделю вместо честного отказа сейчас.
  assert.equal(sealPayload(b64url(randomBytes(16)), body()), null);
  assert.equal(openPayload(null, Buffer.alloc(100)).reason, 'no_key');
});

test('ключ читается и из строки base64url, и из сырых байтов', () => {
  const raw = randomBytes(GROUP_KEY_BYTES);
  assert.deepEqual(decodeGroupKey(b64url(raw)), raw);
  assert.deepEqual(decodeGroupKey(raw), raw);
  assert.equal(decodeGroupKey(randomBytes(31)), null);
  assert.equal(decodeGroupKey(undefined), null);
  // Ключ, скопированный с переводом строки по краям, — обычная судьба строки,
  // которую переносят через мессенджер.
  assert.deepEqual(decodeGroupKey('  ' + b64url(raw) + '\n'), raw);
});

test('адрес блоба выводится из ключа: одинаков у обоих филиалов и неугадываем', () => {
  const key = newKey();
  const id = relayIdFor(key);
  assert.match(id, RELAY_ID_RE);
  assert.equal(relayIdFor(key), id, 'оба филиала обязаны прийти к одному адресу');
  assert.notEqual(relayIdFor(newKey()), id, 'у другой группы — другой адрес');
  assert.equal(relayIdFor(null), null);
  // Главное свойство: по адресу нельзя восстановить ключ. Проверяем то, что
  // проверяемо — адрес не содержит ключа ни в каком виде.
  assert.equal(id.includes(key.slice(0, 8)), false);
});

test('у каждого узла свой адрес блоба, и он выводится из ключа группы', () => {
  const key = 'k'.repeat(43);
  const b = relayIdFor(key, 'B');
  const c = relayIdFor(key, 'C');
  assert.match(b, /^[0-9a-f]{32}$/);
  assert.notEqual(b, c, 'иначе филиалы затирали бы журналы друг друга');
  assert.equal(relayIdFor(key, 'B'), b, 'адрес постоянен: его не с кем согласовывать');
  assert.equal(relayIdFor(key, 'b'), b, 'буква нормализуется: b и B — один узел');
});

test('без узла адрес прежний — справочник лежит там же, где лежал', () => {
  const key = 'k'.repeat(43);
  assert.equal(relayIdFor(key).length, 32);
  assert.notEqual(relayIdFor(key), relayIdFor(key, 'B'));
});

test('адреса заморожены: справочник и узел B — байт в байт', () => {
  // Значения зафиксированы, а не выведены заново расчётом внутри теста: цель —
  // поймать будущий рефакторинг (смена HMAC-конструкции, замена разделителя,
  // перестановка аргументов внутри update), который тихо переселил бы блоб уже
  // работающей группы на новый адрес. Такой блоб на сервере поставщика никто
  // не переносит — установки просто перестали бы находить свою же копию.
  const key = 'k'.repeat(43);
  assert.equal(relayIdFor(key), '335a62fe023b253286a0efdde7f1c316');
  assert.equal(relayIdFor(key, 'B'), 'a3e146e85247f72beb44254d542f3c00');
});

test('буква узла проверяется по форме: не буква — не адрес', () => {
  const key = 'k'.repeat(43);
  assert.match(relayIdFor(key, 'b'), /^[0-9a-f]{32}$/, 'строчная буква — нормальный узел');
  assert.equal(relayIdFor(key, 'ß'), null, 'после верхнего регистра ß даёт SS — это не A-Z, это подделка формы');
  assert.equal(relayIdFor(key, 'B1'), null, 'цифра в узле — не буква филиала');
  assert.equal(relayIdFor(key, ''), relayIdFor(key), 'пустая строка — то же самое, что узла нет: адрес справочника');
  assert.equal(relayIdFor(key, undefined), relayIdFor(key));
});

test('перевыпуск ключа уводит группу на другой адрес — старый блоб становится сиротой', () => {
  const before = relayIdFor(newKey());
  const after = relayIdFor(newKey());
  assert.notEqual(before, after);
});

test('большой справочник сжимается перед шифрованием', () => {
  const key = newKey();
  // Логотип клиники в doc_settings — это data-URL на сотни килобайт, и он же
  // главная причина, по которой блоб вообще сжимается.
  const big = body({ catalogue: { doc_settings: { logo_data_url: 'A'.repeat(400_000) } } });
  const sealed = sealPayload(key, big);
  assert.ok(sealed.length < 20_000, 'повторяющиеся данные обязаны сжаться, иначе на чужом диске лежат сотни килобайт зря');
  assert.deepEqual(openPayload(key, sealed).payload, big);
});

test('распакованное не разворачивается в память без предела', () => {
  // Собран вручную: это НЕ то, что может прислать наш главный филиал (он не
  // умеет делать такой payload), а проверка того, что предел вообще стоит.
  // Ограничение действует уже ПОСЛЕ проверки тега, то есть является вторым
  // рубежом, а не первым.
  const key = newKey();
  const huge = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x41));
  // Запечатываем «руками», подсовывая в качестве открытого текста уже готовый
  // gzip-бомб: sealPayload сжал бы сам, поэтому используем его же формат.
  const sealed = sealRaw(key, huge);
  const r = openPayload(key, sealed);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_payload', 'слишком большой распакованный поток отвергается, а не съедает память');
});

// Тот же формат, что у sealPayload, но с уже готовым «сжатым» телом — нужен
// ровно одному тесту выше и намеренно живёт здесь, а не в рабочем коде.
function sealRaw(key, gzipped) {
  const iv = randomBytes(12);
  const magic = Buffer.from('EMR1', 'ascii');
  const cipher = createCipheriv('aes-256-gcm', decodeGroupKey(key), iv);
  cipher.setAAD(magic);
  const encrypted = Buffer.concat([cipher.update(gzipped), cipher.final()]);
  return Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted]);
}
