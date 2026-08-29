// TELEGRAM_BOT_V1 — шифрование токена бота.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateKey, encryptToken, decryptToken, looksLikeBotToken, tokenHint } from './crypto.js';

const TOKEN = '1000000001:TESTONLYtestonlyTESTONLYtestonly123';

function tmpKeyPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'em-tg-')), '.telegram-key');
}

test('токен переживает круг шифрование → расшифровка', () => {
  const key = loadOrCreateKey(tmpKeyPath());
  assert.equal(decryptToken(encryptToken(TOKEN, key), key), TOKEN);
});

test('шифротекст не содержит токен и различается при каждом вызове', () => {
  const key = loadOrCreateKey(tmpKeyPath());
  const a = encryptToken(TOKEN, key);
  const b = encryptToken(TOKEN, key);
  assert.ok(!Buffer.from(a, 'base64').toString('utf8').includes('AAFeAwoH'),
    'секрет не должен читаться в сохранённой строке');
  assert.notEqual(a, b, 'случайный IV: одинаковый токен даёт разные шифротексты');
});

test('ключ создаётся один раз и переиспользуется', () => {
  const p = tmpKeyPath();
  const first = loadOrCreateKey(p);
  const packed = encryptToken(TOKEN, first);
  // Второй вызов обязан вернуть ТОТ ЖЕ ключ — перегенерация тихо превратила бы
  // уже сохранённый токен в мусор.
  assert.equal(decryptToken(packed, loadOrCreateKey(p)), TOKEN);
});

test('битый файл ключа — это ошибка, а не тихая перегенерация', () => {
  const p = tmpKeyPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'не ключ');
  assert.throws(() => loadOrCreateKey(p), /повреждён/);
});

test('подмена байта в базе ловится, а не отдаёт испорченный токен', () => {
  const key = loadOrCreateKey(tmpKeyPath());
  const buf = Buffer.from(encryptToken(TOKEN, key), 'base64');
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => decryptToken(buf.toString('base64'), key));
});

test('чужой ключ не расшифровывает токен', () => {
  const packed = encryptToken(TOKEN, loadOrCreateKey(tmpKeyPath()));
  assert.throws(() => decryptToken(packed, loadOrCreateKey(tmpKeyPath())));
});

test('обрезанные и пустые значения не проходят как токен', () => {
  const key = loadOrCreateKey(tmpKeyPath());
  assert.throws(() => decryptToken('', key), /повреждён/);
  assert.throws(() => decryptToken('YWJj', key), /повреждён/);
  assert.throws(() => encryptToken('', key), /Пустой/);
});

test('форма токена BotFather проверяется до сохранения', () => {
  assert.ok(looksLikeBotToken(TOKEN));
  assert.ok(looksLikeBotToken('  ' + TOKEN + '  '), 'скопированный с пробелами токен валиден');
  assert.ok(!looksLikeBotToken('просто строка'));
  assert.ok(!looksLikeBotToken('5125777202'), 'без секрета');
  assert.ok(!looksLikeBotToken('5125777202:short'));
  assert.ok(!looksLikeBotToken(''));
});

test('подсказка — это только хвост, никогда не секрет', () => {
  assert.equal(tokenHint(TOKEN), 'y123');
  assert.equal(tokenHint('abc'), '');
  assert.equal(tokenHint(''), '');
});
