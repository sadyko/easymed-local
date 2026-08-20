// TELEGRAM_CHAT_FILE_V1 — оператор отвечает пациенту файлом.
//
// Проверяется не «файл ушёл», а то, на чём это ломается молча: картинка должна
// уйти фотографией (иначе пациент видит «скачать файл» вместо снимка), путь из
// браузера не должен выводить за корзину, право на отправку файла то же, что на
// текст, и отправленное должно остаться в ленте вместе с тем, ГДЕ оно лежит.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { sendChatFile } from './chat.js';
import { telegramChatSendFile } from '../rpc/telegram.js';
import { encryptToken, loadOrCreateKey } from './crypto.js';

process.env.EASYMED_TELEGRAM_KEY_PATH =
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'em-tg-file-')), '.telegram-key');
const ENC_TOKEN = encryptToken('1000000001:TESTONLYtestonlyTESTONLYtestonly123', loadOrCreateKey());

const editorUser = { id: 6, role: 'callcenter', full_name: 'Оператор Оксана' };
const viewerUser = { id: 5, role: 'lab' };

const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const BUCKET = path.join(ROOT, 'data', 'storage', 'telegram-media');

// Файлы кладём в ту же корзину, куда их кладёт браузер: читать их будет
// настоящий readMedia(), а не подделка, — иначе проверка обхода каталога
// осталась бы непроверенной.
const madeFiles = [];
function tempFile(name, bytes = Buffer.from('%PDF-1.4 fake')) {
  const dir = path.join(BUCKET, 'chat-test');
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, bytes);
  madeFiles.push(abs);
  return 'chat-test/' + name;
}
test.after(() => { for (const f of madeFiles) { try { fs.unlinkSync(f); } catch { /* уже нет */ } } });

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(5, 'lab1', 'x', 'Лаборант', 'lab');
  u.run(6, 'op', 'x', 'Оператор Оксана', 'callcenter');
  db.prepare("INSERT INTO telegram_links (chat_id, phone, tg_name) VALUES ('100','998901112233','Алишер')").run();
  db.prepare('UPDATE telegram_settings SET enabled=1, bot_token_enc=? WHERE id=1').run(ENC_TOKEN);
  return db;
}

// Подставной транспорт: запоминает, каким методом Bot API и с какой формой
// ушёл каждый запрос. В сеть тесты не ходят.
function recorder() {
  const calls = [];
  return {
    calls,
    deps: {
      fetchImpl: async (url, opts) => {
        const method = String(url).split('/').pop();
        const body = opts && opts.body;
        const form = {};
        if (body && typeof body.entries === 'function') {
          for (const [k, v] of body.entries()) {
            form[k] = (v && typeof v === 'object' && 'size' in v)
              ? { file: true, size: v.size, name: v.name }
              : v;
          }
        } else if (typeof body === 'string') {
          Object.assign(form, JSON.parse(body));
        }
        calls.push({ method, form });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
      },
    },
  };
}

test('картинка уходит фотографией, а не файлом на скачивание', async () => {
  const db = seed();
  const r = recorder();
  const rel = tempFile('снимок.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00]));

  await sendChatFile(db, 'T', '100', { path: rel, name: 'снимок.jpg' }, editorUser, r.deps);

  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].method, 'sendPhoto', 'jpg должен уйти через sendPhoto');
  db.close();
});

test('всё остальное уходит документом под именем, которое дал оператор', async () => {
  const db = seed();
  const r = recorder();
  const rel = tempFile('res.pdf');

  await sendChatFile(db, 'T', '100', { path: rel, name: 'Анализ крови.pdf' }, editorUser, r.deps);

  assert.equal(r.calls[0].method, 'sendDocument');
  // Пациент видит осмысленное имя, а не обезличенный ключ с диска.
  assert.equal(r.calls[0].form.document.name, 'Анализ крови.pdf');
  db.close();
});

test('подпись — текст оператора, подписанный его именем', async () => {
  const db = seed();
  const r = recorder();
  const rel = tempFile('c.pdf');

  await sendChatFile(db, 'T', '100',
    { path: rel, name: 'c.pdf', caption: 'Ваши результаты готовы' }, editorUser, r.deps);

  assert.match(r.calls[0].form.caption, /Ваши результаты готовы/);
  assert.match(r.calls[0].form.caption, /Оператор Оксана/, 'пациент должен видеть, кто ему ответил');
  db.close();
});

// Текст оператора — не HTML. «температура < 37» с parse_mode=HTML Telegram
// разобрать не может и отвечает ошибкой: сообщение просто не уходит.
test('угловые скобки в подписи не ломают отправку', async () => {
  const db = seed();
  const r = recorder();
  const rel = tempFile('d.pdf');

  await sendChatFile(db, 'T', '100',
    { path: rel, name: 'd.pdf', caption: 'температура < 37 & норма' }, editorUser, r.deps);

  assert.match(r.calls[0].form.caption, /&lt; 37 &amp; норма/);
  db.close();
});

// Обрезать написанное клиникой нельзя: длинный текст уходит отдельным
// сообщением ЦЕЛИКОМ, файл — следом.
test('подпись длиннее 1024 символов уходит отдельным сообщением, а не обрезается', async () => {
  const db = seed();
  const r = recorder();
  const rel = tempFile('e.pdf');
  const longText = 'а'.repeat(1200);

  await sendChatFile(db, 'T', '100', { path: rel, name: 'e.pdf', caption: longText }, editorUser, r.deps);

  assert.equal(r.calls.length, 2, 'сначала текст, потом файл');
  assert.equal(r.calls[0].method, 'sendMessage');
  assert.ok(r.calls[0].form.text.includes(longText), 'текст ушёл целиком');
  assert.equal(r.calls[1].method, 'sendDocument');
  assert.ok(!r.calls[1].form.caption, 'второй раз тот же текст пациенту не шлём');
  db.close();
});

test('отправленный файл остаётся в ленте вместе с путём к нему', async () => {
  const db = seed();
  const r = recorder();
  const rel = tempFile('f.pdf');

  await sendChatFile(db, 'T', '100', { path: rel, name: 'Направление.pdf' }, editorUser, r.deps);

  const m = db.prepare("SELECT * FROM telegram_messages WHERE chat_id='100' ORDER BY id DESC LIMIT 1").get();
  assert.equal(m.kind, 'document');
  assert.equal(m.text, 'Направление.pdf');
  assert.equal(m.file_path, rel, 'без пути «что мы вчера отправили» уже не открыть');
  assert.equal(m.sent_by, 6, 'видно, кто отправил');
  db.close();
});

test('путь с обходом каталога файл не выдаёт', async () => {
  const db = seed();
  const r = recorder();
  const escapes = [
    '../../data/easymed.db',
    '..' + String.fromCharCode(92) + 'easymed.db',
    'chat-test/../../../secret',
    '',
    null,
  ];
  for (const bad of escapes) {
    await assert.rejects(
      () => sendChatFile(db, 'T', '100', { path: bad, name: 'x.pdf' }, editorUser, r.deps),
      /не найден|не загружен/i, JSON.stringify(bad));
  }
  assert.equal(r.calls.length, 0, 'в Telegram при этом ничего не ушло');
  db.close();
});

// Проверка размера в браузере — удобство, а не защита: обойти её ничего не
// стоит, поэтому тот же предел стоит на сервере, по факту с диска.
test('файл больше 20 МБ сервер не отправляет, даже если браузер согласился', async () => {
  const db = seed();
  const r = recorder();
  const rel = tempFile('huge.bin', Buffer.alloc(20 * 1024 * 1024 + 1));

  await assert.rejects(
    () => sendChatFile(db, 'T', '100', { path: rel, name: 'huge.bin' }, editorUser, r.deps),
    /больше 20 МБ/);
  assert.equal(r.calls.length, 0);
  db.close();
});

test('в отвязанный чат файл не уходит', async () => {
  const db = seed();
  const r = recorder();
  const rel = tempFile('g.pdf');
  db.prepare("UPDATE telegram_links SET revoked_at='2026-01-01T00:00:00Z' WHERE chat_id='100'").run();

  await assert.rejects(
    () => sendChatFile(db, 'T', '100', { path: rel, name: 'g.pdf' }, editorUser, r.deps), /отвязан/);
  assert.equal(r.calls.length, 0);
  db.close();
});

test('заблокировавшему бота пациенту файл не уходит', async () => {
  const db = seed();
  const r = recorder();
  const rel = tempFile('h.pdf');
  db.prepare("UPDATE telegram_links SET blocked_at='2026-01-01T00:00:00Z' WHERE chat_id='100'").run();

  await assert.rejects(
    () => sendChatFile(db, 'T', '100', { path: rel, name: 'h.pdf' }, editorUser, r.deps), /заблокировал/);
  db.close();
});

// Отправить файл от имени клиники — это ответ от имени клиники, а не просмотр.
test('уровень «только чтение» файл отправить не может', async () => {
  const db = seed();
  const rel = tempFile('i.pdf');
  db.prepare(`UPDATE role_permissions SET permissions =
      json_set(json_insert(permissions,'$.sections[#]','telegram-chat'),'$.levels.telegram-chat','viewer')
      WHERE role='lab'`).run();

  await assert.rejects(
    () => telegramChatSendFile(db, { chat_id: '100', path: rel, name: 'i.pdf' }, viewerUser),
    /только чтение/);
  db.close();
});

test('при выключенном боте файл не отправляется', async () => {
  const db = seed();
  const rel = tempFile('j.pdf');
  db.prepare('UPDATE telegram_settings SET enabled=0 WHERE id=1').run();

  await assert.rejects(
    () => telegramChatSendFile(db, { chat_id: '100', path: rel, name: 'j.pdf' }, editorUser),
    /выключен/);
  db.close();
});
