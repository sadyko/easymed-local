// TELEGRAM_CHAT_FILE_V1 — правила вложения, общие для браузера и сервера.

import { test } from 'node:test';
import assert from 'node:assert';
import { isImageName, safeAttachmentName, attachmentError, humanSize,
         MAX_ATTACHMENT_BYTES } from '../../shared/chat-attachment.js';

test('картинка отличается от документа по расширению', () => {
  for (const n of ['снимок.JPG', 'a.jpeg', 'x.png', 'g.GIF', 'w.webp', 'b.bmp']) {
    assert.strictEqual(isImageName(n), true, n);
  }
  for (const n of ['результат.pdf', 'таблица.xlsx', 'file', 'archive.zip']) {
    assert.strictEqual(isImageName(n), false, n);
  }
});

// Telegram не принимает SVG как фото и не везде показывает HEIC. Документом
// они дойдут гарантированно — лучше скачиваемый файл, чем ошибка отправки.
test('svg и heic идут документом, а не фотографией', () => {
  assert.strictEqual(isImageName('схема.svg'), false);
  assert.strictEqual(isImageName('IMG_0001.heic'), false);
});

// Имя видит ПАЦИЕНТ: «Анализ крови.pdf» понятнее обезличенного ключа с диска,
// поэтому кириллицу и пробелы сохраняем.
test('кириллица и пробелы в имени сохраняются', () => {
  assert.strictEqual(safeAttachmentName('Анализ крови 12.05.pdf'), 'Анализ крови 12.05.pdf');
});

test('разделители пути и NUL из имени вырезаются', () => {
  assert.strictEqual(safeAttachmentName('../../etc/passwd'), '.._.._etc_passwd');
  const BS = String.fromCharCode(92);   // обратный слэш, не спрятанный в escape
  assert.strictEqual(safeAttachmentName('a' + BS + 'b.pdf'), 'a_b.pdf');
  assert.strictEqual(safeAttachmentName('до\0после.pdf'), 'до_после.pdf');
});

// Имя уходит в заголовок multipart-формы: перевод строки там позволил бы
// дописать соседние поля запроса к Telegram.
test('перевод строки в имени не доживает до multipart', () => {
  const name = safeAttachmentName('файл.pdf\r\nContent-Disposition: form-data; name="chat_id"');
  assert.ok(!name.includes('\n') && !name.includes('\r'), name);
});

test('пустое и бессмысленное имя заменяется, а не остаётся пустым', () => {
  for (const bad of ['', null, undefined, '   ', '.', '..']) {
    assert.strictEqual(safeAttachmentName(bad), 'file', JSON.stringify(bad));
  }
});

test('длинное имя обрезается', () => {
  assert.strictEqual(safeAttachmentName('я'.repeat(400)).length, 120);
});

// Потолок наш собственный: /api/storage принимает 20 МБ. Отказ должен прийти
// ДО заливки, иначе оператор ждёт минуты ради ошибки.
test('слишком большой файл отбивается с причиной и размером', () => {
  const err = attachmentError({ name: 'снимок.zip', size: MAX_ATTACHMENT_BYTES + 1 });
  assert.ok(err, 'ошибка должна быть');
  assert.ok(err.includes('20 МБ'), err);
});

test('файл ровно по границе принимается', () => {
  assert.strictEqual(attachmentError({ name: 'a.pdf', size: MAX_ATTACHMENT_BYTES }), null);
});

test('пустой файл не отправляется', () => {
  assert.ok(attachmentError({ name: 'a.pdf', size: 0 }));
  assert.ok(attachmentError(null));
});

test('нормальный файл проходит', () => {
  assert.strictEqual(attachmentError({ name: 'Анализ.pdf', size: 250000 }), null);
});

test('размер читается человеком', () => {
  assert.strictEqual(humanSize(500), '500 Б');
  assert.strictEqual(humanSize(2048), '2 КБ');
  assert.strictEqual(humanSize(20 * 1024 * 1024), '20 МБ');
});
