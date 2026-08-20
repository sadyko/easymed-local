// TELEGRAM_BROADCAST_IMG_V1 — картинка 16:9 в рассылке.
//
// Три вещи здесь стоят теста, и все три — про то, что пациент реально получит:
//   1. текст НЕ обрезается под лимит подписи (1024 против 4096 у сообщения);
//   2. картинка загружается в Telegram ОДИН раз, дальше уходит по file_id;
//   3. путь к файлу не выпускает чтение за пределы своей корзины.
//
// Собственная ловушка сети, а не из broadcast.test.js: та разбирает КАЖДОЕ тело
// как JSON, а загрузка файла уходит multipart'ом и на JSON.parse падает.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runBroadcast, readBroadcastImage } from './broadcast.js';
import { photoFileId } from './api.js';

const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const BIG_FILE_ID = 'FILE_ID_BIG';

function seed(chats = ['100', '200', '300']) {
  const db = openDb(':memory:');
  migrate(db);
  const bc = db.prepare(
    "INSERT INTO telegram_broadcasts (text_ru, audience_count) VALUES ('Тест', 3) RETURNING id").get();
  for (const chat of chats) {
    db.prepare('INSERT INTO telegram_broadcast_targets (broadcast_id, chat_id) VALUES (?,?)').run(bc.id, chat);
  }
  return { db, bcId: bc.id };
}

// Ловушка вместо сети: понимает и JSON, и multipart.
function harness() {
  const calls = [];
  return {
    calls,
    of: (method) => calls.filter((c) => c.method === method),
    deps: {
      fetchImpl: async (url, opts) => {
        const method = String(url).split('/').pop();
        let params = {};
        let multipart = false;
        if (typeof FormData !== 'undefined' && opts.body instanceof FormData) {
          multipart = true;
          for (const [k, v] of opts.body.entries()) params[k] = typeof v === 'string' ? v : '<binary>';
        } else {
          params = JSON.parse(opts.body);
        }
        calls.push({ method, multipart, params });
        // sendPhoto отвечает лестницей превью — самый крупный последний.
        const result = method === 'sendPhoto'
          ? {
              message_id: calls.length,
              photo: [
                { file_id: 'FILE_ID_THUMB', width: 90, file_size: 800 },
                { file_id: BIG_FILE_ID, width: 1280, file_size: 90000 },
              ],
            }
          : { message_id: calls.length };
        return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
      },
    },
  };
}

const image = () => ({ buffer: Buffer.from('fake-jpeg-bytes'), filename: 'banner.jpg' });

test('короткий текст уходит ПОДПИСЬЮ к картинке — одним сообщением', async () => {
  const { db, bcId } = seed(['100']);
  const hx = harness();

  const res = await runBroadcast(db, 'tok', bcId, 'Клиника работает до 18:00', hx.deps, image());

  assert.deepEqual(res, { sent: 1, failed: 0 });
  assert.equal(hx.of('sendPhoto').length, 1);
  assert.equal(hx.of('sendMessage').length, 0, 'второе сообщение здесь лишнее');
  assert.equal(hx.of('sendPhoto')[0].params.caption, 'Клиника работает до 18:00');
  db.close();
});

test('длинный текст НЕ обрезается: картинка, следом полный текст отдельно', async () => {
  const { db, bcId } = seed(['100']);
  const hx = harness();
  const long = 'я'.repeat(1500);   // больше лимита подписи в 1024

  await runBroadcast(db, 'tok', bcId, long, hx.deps, image());

  const photos = hx.of('sendPhoto');
  const messages = hx.of('sendMessage');
  assert.equal(photos.length, 1);
  assert.equal(messages.length, 1, 'текст обязан уйти вторым сообщением, а не пропасть');
  assert.ok(!photos[0].params.caption, 'подпись не ставим — она бы не влезла');
  assert.equal(messages[0].params.text, long, 'текст клиники уходит ЦЕЛИКОМ');
  assert.equal(messages[0].params.text.length, 1500);
  db.close();
});

test('картинка загружается один раз, остальным уходит по file_id', async () => {
  const { db, bcId } = seed(['100', '200', '300']);
  const hx = harness();

  const res = await runBroadcast(db, 'tok', bcId, 'Короткий текст', hx.deps, image());
  assert.equal(res.sent, 3);

  const photos = hx.of('sendPhoto');
  assert.equal(photos.length, 3);

  const uploads = photos.filter((c) => c.multipart);
  assert.equal(uploads.length, 1, 'один и тот же баннер не должен грузиться трижды');
  assert.equal(photos[0].multipart, true, 'первым идёт multipart с файлом');

  for (const later of photos.slice(1)) {
    assert.equal(later.multipart, false, 'повторные отправки идут обычным JSON');
    assert.equal(later.params.photo, BIG_FILE_ID, 'и ссылаются на уже загруженный файл');
  }
  db.close();
});

test('без картинки поведение прежнее — обычное текстовое сообщение', async () => {
  const { db, bcId } = seed(['100', '200']);
  const hx = harness();

  const res = await runBroadcast(db, 'tok', bcId, 'Просто текст', hx.deps);

  assert.deepEqual(res, { sent: 2, failed: 0 });
  assert.equal(hx.of('sendPhoto').length, 0);
  assert.equal(hx.of('sendMessage').length, 2);
  db.close();
});

test('рассылка с картинкой видна в ленте переписки', async () => {
  const { db, bcId } = seed(['100']);
  const hx = harness();

  await runBroadcast(db, 'tok', bcId, 'Акция', hx.deps, image());

  const msg = db.prepare("SELECT * FROM telegram_messages WHERE chat_id='100'").get();
  assert.ok(msg, 'сотрудник должен видеть, что пациенту уже писала клиника');
  assert.ok(msg.text.includes('Акция'));
  assert.ok(msg.text.startsWith('🖼'), 'наличие картинки должно быть заметно в ленте');
  db.close();
});

test('file_id берётся от самого крупного размера, а не от превью', () => {
  const result = {
    photo: [
      { file_id: 'thumb', width: 90, file_size: 800 },
      { file_id: 'mid', width: 320, file_size: 9000 },
      { file_id: 'full', width: 1280, file_size: 90000 },
    ],
  };
  assert.equal(photoFileId(result), 'full', 'иначе остальным уйдёт размытое превью');
  assert.equal(photoFileId({}), null);
  assert.equal(photoFileId({ photo: [] }), null);
});

test('путь к картинке не выпускает чтение за пределы своей корзины', () => {
  const bucketDir = path.join(ROOT, 'data', 'storage', 'telegram-media');
  const outsideDir = path.join(ROOT, 'data', 'storage');
  const outside = path.join(outsideDir, 'lis-ingest-escape-probe.txt');

  fs.mkdirSync(bucketDir, { recursive: true });
  fs.writeFileSync(outside, 'секрет');
  try {
    // Файл СУЩЕСТВУЕТ — и всё равно недоступен, потому что лежит выше корзины.
    assert.equal(readBroadcastImage('../lis-ingest-escape-probe.txt'), null);
    assert.equal(readBroadcastImage('..\\lis-ingest-escape-probe.txt'), null);
    assert.equal(readBroadcastImage('broadcast/../../lis-ingest-escape-probe.txt'), null);
    assert.equal(readBroadcastImage(''), null);
    assert.equal(readBroadcastImage(null), null);
    assert.equal(readBroadcastImage('нет-такого.jpg'), null, 'отсутствующий файл — это null, а не исключение');
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('существующая картинка внутри корзины читается', () => {
  const dir = path.join(ROOT, 'data', 'storage', 'telegram-media', 'broadcast');
  const name = 'test-probe.jpg';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'bytes');
  try {
    const img = readBroadcastImage('broadcast/' + name);
    assert.ok(img, 'путь внутри корзины обязан читаться');
    assert.equal(img.filename, name);
    assert.equal(img.buffer.toString(), 'bytes');
  } finally {
    fs.rmSync(path.join(dir, name), { force: true });
  }
});
