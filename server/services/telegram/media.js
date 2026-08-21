// TELEGRAM_MEDIA_V1 — чтение файла из корзины telegram-media.
//
// В эту корзину браузер кладёт всё, что клиника отправляет пациенту через
// бота: баннер рассылки и вложение оператора в переписке. Путь до файла
// приходит ИЗ БРАУЗЕРА (сначала в базу, потом сюда), то есть снаружи, поэтому
// перед чтением он проверяется так же строго, как в routes/storage.js: имя
// корзины наше, но сегменты пути — нет, и '..' в них вывел бы чтение за
// пределы папки, к базе клиники в data/.
//
// Функция одна на обоих потребителей нарочно. Раньше эта проверка жила внутри
// broadcast.js, и вторая её копия — для вложений в чате — разошлась бы с
// первой при первой же правке; расхождение в проверке обхода каталога стоит
// дороже, чем в чём угодно другом здесь.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataDir } from '../control/config.js';   // SUPERVISED_INSTALL_V1

const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
export const MEDIA_BUCKET = 'telegram-media';

// Абсолютный путь внутри корзины — или null, если он оттуда выводит.
// Отдельно от чтения, чтобы проверку можно было применить и там, где файл ещё
// не нужен целиком (например, узнать размер).
export function resolveMedia(relPath) {
  const segments = String(relPath || '').split('/').filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((s) => s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) return null;
  // SUPERVISED_INSTALL_V1 — see crypto.js. Patient documents received over
  // Telegram must survive an update.
  const baseDir = path.resolve(getDataDir(), 'storage', MEDIA_BUCKET);
  const abs = path.resolve(baseDir, ...segments);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return null;
  return abs;
}

// Байты файла — или null, если путь плохой либо файла нет.
//
// Отсутствие файла — это null, а НЕ исключение: администратор мог удалить
// картинку с диска, и рассылка должна сказать «загрузите заново», а не упасть.
export function readMedia(relPath) {
  const abs = resolveMedia(relPath);
  if (!abs || !fs.existsSync(abs)) return null;
  return { buffer: fs.readFileSync(abs), filename: path.basename(abs) };
}
