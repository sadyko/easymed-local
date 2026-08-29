import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeAtomic } from '../control/checkin.js';
import { b64url, decodeGroupKey, GROUP_KEY_BYTES } from './pairing.js';

// BRANCH_SYNC_RELAY_V1 — КЛЮЧ СИНХРОНИЗАЦИИ КЛИНИКИ, созданный при активации.
//
// Решение владельца (2026-08-29), дословно: «когда активируем клинику,
// генерируется уникальный ключ для синхронизации, который создан вместе с
// активацией, и генерирует + добавляет филиал». То есть ключ не выдумывается
// отдельной церемонией «настройте шифрование» — он появляется ровно там, где
// установка получает свою личность: в services/control/enroll.js, в ту же
// секунду, что control.json и licence.dat.
//
// ЧТО ЭТО ЗА ФАЙЛ. data/sync-group.json — 32 случайных байта и идентификатор
// группы. Он лежит рядом с control.json и licence.dat, в каталоге данных
// клиники, который .gitignore закрывает и который обновление не трогает.
//
// КУДА ОН НЕ ПОПАДАЕТ. Никуда. Не в запрос активации (enroll.js отправляет код
// и отпечаток машины, и всё), не в ежедневный check-in, не в статистику, не в
// экранный статус. Поставщик не может расшифровать блоб на своём же диске — и
// это же означает, что он не может и помочь клинике, которая ключ потеряла.
// Экран говорит об этом прямым текстом ДО того, как владелец на это положится.
//
// ЛЕНИВОЕ СОЗДАНИЕ — не удобство, а обязанность. Установки, активированные до
// этого изменения, файла не имеют; без ленивого создания они остались бы без
// резервного канала навсегда, и «обновились — стало хуже» было бы честным
// описанием релиза. Поэтому ensureSyncGroup() заводит ключ при первом же
// обращении к синхронизации филиалов.
//
// ПРАВИЛА ФАЙЛА — те же, что у checkin.js/enroll.js/pairing.js: никогда не
// бросать наружу, ничего не писать наполовину (только writeAtomic), испорченную
// запись читать как «ключа нет», а не как аварию.

const FILE = 'sync-group.json';

// Идентификатор группы. Владелец видит его на экране («Группа филиалов»),
// поэтому он короткий и читаемый; за неугадываемость отвечает не он, а адрес
// блоба, выведенный из самого ключа (см. relay-crypto.js relayIdFor).
const newGroupId = () => 'BR-' + randomBytes(6).toString('hex').toUpperCase();

export function syncGroupPath(dataDir) { return path.join(dataDir, FILE); }

/**
 * Ключ синхронизации этой установки, либо null.
 *
 * НИКОГДА не бросает. Проверка полная: запись без ключа нужной длины хуже
 * отсутствующей — экран показал бы «ключ есть», а шифрование молча не работало
 * бы (тот же довод, что у readPairing про половинчатую пару).
 */
export function readSyncGroup(dataDir, { readFileSync = fs.readFileSync } = {}) {
  let raw;
  try { raw = readFileSync(syncGroupPath(dataDir), 'utf8'); } catch { return null; }
  let v;
  try { v = JSON.parse(typeof raw === 'string' && raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); }
  catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.group_id !== 'string' || !v.group_id) return null;
  if (!decodeGroupKey(v.key)) return null;
  return v;
}

function writeSyncGroup(dataDir, record, { writeFileSync, renameSync } = {}) {
  writeAtomic(syncGroupPath(dataDir), JSON.stringify(record, null, 2), { writeFileSync, renameSync });
  return record;
}

function mint(now) {
  return {
    group_id: newGroupId(),
    key: b64url(randomBytes(GROUP_KEY_BYTES)),
    created_at: now().toISOString(),
  };
}

/**
 * Ключ синхронизации — создав его, если файла ещё нет.
 *
 * Вызывается из двух мест: при активации клиники (enroll.js — основной путь,
 * ради которого всё это) и из экрана «Филиалы» (для установок, активированных
 * раньше). Оба вызова обязаны быть безопасны при повторе: существующий ключ
 * НИКОГДА не перезаписывается — перезапись означала бы, что подключённые
 * филиалы молча перестали расшифровывать блоб, а на экране ничего не изменилось.
 *
 * @returns {object|null} запись, либо null если записать на диск не удалось.
 *   null — это «резервный канал недоступен», а не повод сорвать активацию.
 */
export function ensureSyncGroup(dataDir, { now = () => new Date(), writeFileSync, renameSync } = {}) {
  const existing = readSyncGroup(dataDir);
  if (existing) return existing;
  const record = mint(now);
  try { return writeSyncGroup(dataDir, record, { writeFileSync, renameSync }); }
  catch (e) {
    console.warn('[branch-sync] could not write the sync group key:', e && e.message);
    return null;
  }
}

/**
 * Перевыпустить ключ: новая группа, новые 32 байта.
 *
 * ЭТО ОТКЛЮЧАЕТ ВСЕ ФИЛИАЛЫ, и по-другому быть не может: ключ у них старый.
 * Функция ничего не спрашивает — спрашивает экран, до вызова, прямым текстом
 * (см. views/branch-sync.js). Восстановить старый ключ невозможно НИКОМУ,
 * включая поставщика: он его никогда не видел.
 *
 * @returns {object|null} новая запись, либо null при неудачной записи.
 */
export function regenerateSyncGroup(dataDir, { now = () => new Date(), writeFileSync, renameSync } = {}) {
  const record = mint(now);
  try { return writeSyncGroup(dataDir, record, { writeFileSync, renameSync }); }
  catch (e) {
    console.warn('[branch-sync] could not rewrite the sync group key:', e && e.message);
    return null;
  }
}
