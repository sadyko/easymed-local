import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonFile } from '../control/checkin.js';
import { exportCatalogue } from './catalogue.js';
import { readPairing, relayEnabled } from './pairing.js';
import { relayIdFor, sealPayload, openPayload } from './relay-crypto.js';

// BRANCH_SYNC_RELAY_V1 — МАРШРУТ Б: справочник едет через сервер поставщика,
// который не может его прочитать.
//
// Зачем он вообще есть. Маршрут А (филиалы ходят друг к другу напрямую) —
// основной и остаётся основным: данные не покидают машин клиники. Но он требует
// того, чего у клиники может не быть: два здания на разных интернет-каналах без
// VPN друг друга не видят вовсе. Тогда единственная общая точка — сервер
// поставщика, и вопрос сводится к тому, читает ли поставщик то, что через него
// проходит. Здесь — не читает: шифрование делает КЛИНИКА, ключ у неё, на сервер
// уходит непрозрачный блоб.
//
// ЧТО ЕЗДИТ. РОВНО ТОТ ЖЕ справочник, что и по Маршруту А: exportCatalogue()
// вызывается отсюда без изменений и без второй копии перечня таблиц. Это и есть
// гарантия — перечень в catalogue.js один, физически неспособен отдать
// пациентов и счета, и Маршрут Б не заводит собственного пути в обход него.
//
// НАПРАВЛЕНИЕ. Главный филиал ВЫГРУЖАЕТ (PUT), подключённый ЗАБИРАЕТ (GET).
// Иначе и быть не может: подключённый филиал именно потому и здесь, что до
// главного не дотягивается — попросить его отдать справочник в момент
// синхронизации невозможно. Отсюда единственная честная цена Маршрута Б:
// приезжает КОПИЯ НА МОМЕНТ ВЫГРУЗКИ, а не сегодняшнее состояние. Возраст копии
// показывается на экране, потому что владелец должен видеть разницу.
//
// СОГЛАСИЕ. Выгрузка не включается сама: на главном филиале это переключатель,
// по умолчанию выключенный (см. relayEnabled в pairing.js).

// Тот же путь, что монтирует control-plane/server/routes/relay.js. Одно место
// на обе стороны — разъехавшись на один символ, они дали бы 404, который
// выглядит как «сервер поставщика не умеет резервный канал».
export const RELAY_PATH_PREFIX = '/cp/v1/relay/';

const DEFAULT_ENDPOINT = 'https://settings.easymed.uz';

// Те же бюджеты, что у checkin.js: мёртвая сеть обязана отказать быстро, а не
// висеть. Выгрузка больше check-in-а на порядки, поэтому и времени ей больше.
const UPLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

// Потолок на то, что мы готовы принять с сервера поставщика. Справочник в
// сжатом виде — сотни килобайт даже с логотипом клиники; 12 МБ это «очень
// большая клиника» и одновременно ровно тот предел, который принимает сам
// маршрут на той стороне.
export const MAX_BLOB_BYTES = 12 * 1024 * 1024;

// Как часто главный филиал обновляет копию на сервере, даже если справочник не
// менялся. Смысл не в свежести (её даёт сравнение хэша), а в удержании: сервер
// поставщика чистит блобы, к которым не обращались, и группа, работающая раз в
// полгода, не должна однажды обнаружить пустоту. Сутки — с большим запасом
// внутри 30-дневного окна удержания.
const REFRESH_MS = 24 * 60 * 60 * 1000;

// Планировщик: первый прогон через 90 секунд после старта — ПОСЛЕ check-in-а
// (у того 60 с), чтобы свежая установка сначала получила лицензию, а уже потом
// занималась филиалами. Дальше раз в 6 часов: справочник меняют редко, а
// пустой прогон стоит одного SELECT-а и сравнения хэша.
const INITIAL_DELAY_MS = 90_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

// Ключ в control_state, где лежит запись о последней выгрузке. Экспортирован,
// потому что его стирает ещё и перевыпуск ключа (rpc/branch-sync.js): запись
// про блоб, до которого больше нет адреса, дезинформирует экран.
export const LAST_PUBLISH_KEY = 'branch_sync_relay_publish';
const LAST_PUBLISH = LAST_PUBLISH_KEY;

/** Куда ходить. Читает окружение при каждом вызове — как checkinUrl(). */
export function relayUrl(relayId, env = process.env) {
  const base = String((env && env.EASYMED_CONTROL_URL) || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  return base + RELAY_PATH_PREFIX + relayId;
}

/**
 * Чем клиника доказывает серверу поставщика, что она клиника.
 *
 * Тот же install_token, что и в ежедневном check-in-е, из того же control.json.
 * Вторая схема аутентификации здесь была бы вторым способом ошибиться: у
 * клиники ровно одна личность у поставщика, и резервный канал не повод выдавать
 * ей ещё одну.
 */
function installToken(dataDir) {
  const identity = readJsonFile(path.join(dataDir, 'control.json'));
  const token = identity && typeof identity.install_token === 'string' ? identity.install_token : '';
  return token || null;
}

/**
 * BRANCH_IDENTITY_V1 — учётка ЭТОЙ установки для резервного канала.
 *
 * Оговорка к абзацу выше, и появилась она, когда появились настоящие филиалы.
 * Вторичный филиал у поставщика НЕ АКТИВИРОВАН и активирован не будет: он
 * подключался к клинике, а не к поставщику, поэтому control.json у него без
 * install_token-а, и по одному только этому файлу резервный канал ему закрыт
 * навсегда — он отвечал бы «Клиника не активирована», жалуясь на то, чего от
 * него никто и не требует. Учётку ему выписывает ГЛАВНЫЙ филиал своим
 * install_token-ом (control-plane/server/routes/relay-token.js) и кладёт в ключ
 * подключения, который владелец переносит руками; pairing.js сохраняет её в
 * записи как `relay_token`. До этой правки её никто не читал, и весь механизм
 * Задач 4 и 5 оканчивался записью на диск.
 *
 * ПОРЯДОК: токен из ключа СИЛЬНЕЕ install_token-а, если на машине оказались оба
 * (каталог данных скопирован с активированной установки — так ставят второй
 * компьютер). Решает отзыв, а не аккуратность. install_token — учётка КЛИНИКИ:
 * он открывает на резервном канале любой адрес, он же обслуживает check-in, и
 * отобрать его у одного филиала нельзя, не отключив клинику целиком. Токен из
 * ключа выписан ЭТОМУ филиалу, действует на одном адресе и гасится одной
 * строкой у поставщика (relay_tokens.revoked_at). Победи здесь install_token —
 * отзыв токена филиала не делал бы ровно ничего, и филиал, у которого отобрали
 * доступ, продолжал бы забирать справочник. Отзыв, который молча не
 * срабатывает, хуже отсутствующего.
 *
 * Правило одно на обе стороны канала и без ветки по роли: главный филиал токены
 * ВЫПИСЫВАЕТ, а не носит, поэтому в его записи их не бывает, и лишняя ветка
 * охраняла бы состояние, которого этот код не создаёт.
 *
 * Пустая строка и пробелы — это ОТСУТСТВИЕ токена, а не токен: «Bearer  » даёт
 * гарантированный 401, который на экране не отличить от «сервер не принял
 * установку», тогда как правильный ответ — «учётки нет» (relay_not_enrolled).
 */
function relayCredential(dataDir, pairing) {
  const fromKey = pairing && typeof pairing.relay_token === 'string' ? pairing.relay_token.trim() : '';
  return fromKey || installToken(dataDir);
}

// control_state — те же две строчки, что в rpc/branch-sync.js и checkin.js.
// Отдельного модуля ради них не заводится: это буквально один SELECT и один
// UPSERT, и общий модуль стоил бы больше, чем экономил.
function getState(db, key) {
  try { return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null; }
  catch { return null; }
}
function putState(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}

/** Последняя удачная выгрузка: {at, hash, bytes} — либо null. */
export function readLastPublish(db) {
  const raw = getState(db, LAST_PUBLISH);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/**
 * Читает тело ответа как БАЙТЫ, не больше maxBytes.
 *
 * Своя копия readBounded() из checkin.js по одной причине: та собирает текст, а
 * здесь тело — шифротекст, и превращать его в строку по дороге значило бы его
 * испортить. Приём тот же и по той же причине: поток читается кусками и
 * обрывается на превышении, а не буферизуется целиком, чтобы потом проверить
 * длину.
 *
 * @returns {Promise<Buffer|null>} null — тело переросло потолок.
 */
async function readBoundedBytes(res, maxBytes) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  }
  let total = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ответ всё равно выбрасывается */ }
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Тело, которое запечатывается и уезжает. БАЙТ В БАЙТ то же, что Маршрут А
 * отдаёт по HTTP (routes/branch-sync.js), плюс дата выгрузки: приёмник обязан
 * разбирать одно и то же независимо от того, каким путём это приехало, иначе
 * два маршрута начнут расходиться в поведении на первой же правке.
 */
function relayBody(db, pairing, now) {
  return {
    ok: true,
    group_id: pairing.group_id,
    generated_at: now().toISOString(),
    catalogue: exportCatalogue(db),
  };
}

/**
 * Выгрузить зашифрованный справочник на сервер поставщика. Сторона ГЛАВНОГО
 * филиала.
 *
 * НИКОГДА не бросает. reason — закрытый словарь, который rpc/branch-sync.js
 * переводит в русские фразы:
 *   relay_not_main | relay_disabled | relay_no_key | relay_not_enrolled |
 *   relay_offline | relay_unauthorized | relay_too_large | relay_server_error
 *
 * @returns {Promise<{ok:true, bytes:number, at:string, hash:string}|{ok:false, reason:string}>}
 */
export async function publishCatalogue(db, dataDir, {
  fetchImpl = globalThis.fetch,
  timeoutMs = UPLOAD_TIMEOUT_MS,
  maxBlobBytes = MAX_BLOB_BYTES,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const pairing = readPairing(dataDir);
  // Раздаёт справочник главный филиал — он же и выгружает копию. Вторичный
  // выгружать не должен: он бы затёр чужой блоб своим, ещё не обновлённым
  // справочником, и главный филиал перестал бы быть источником правды.
  if (!pairing || pairing.role !== 'main') return { ok: false, reason: 'relay_not_main' };
  if (!relayEnabled(pairing)) return { ok: false, reason: 'relay_disabled' };

  const relayId = relayIdFor(pairing.group_key);
  if (!relayId) return { ok: false, reason: 'relay_no_key' };

  const token = relayCredential(dataDir, pairing);
  // Клиника, активированная по телефону и никогда не ходившая к поставщику,
  // резервным каналом пользоваться не может — и это честный отказ, а не молчание:
  // маршрут на той стороне пускает только активированные установки.
  if (!token) return { ok: false, reason: 'relay_not_enrolled' };

  const body = relayBody(db, pairing, now);
  const sealed = sealPayload(pairing.group_key, body);
  if (!sealed) return { ok: false, reason: 'relay_no_key' };
  if (sealed.length > maxBlobBytes) return { ok: false, reason: 'relay_too_large' };

  let res;
  try {
    res = await fetchImpl(relayUrl(relayId, env), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${token}`,
      },
      body: sealed,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Нет интернета — для клиники это норма, а не поломка: она офлайновая по
    // построению. Копия просто не обновилась, попробуем в следующий раз.
    return { ok: false, reason: 'relay_offline' };
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'relay_unauthorized' };
    if (res.status === 413) return { ok: false, reason: 'relay_too_large' };
    return { ok: false, reason: 'relay_server_error' };
  }

  // Хэш ОТКРЫТОГО тела, а не блоба: у блоба каждый раз новый IV, поэтому байты
  // отличаются всегда, даже когда справочник не менялся, и сравнивать их было
  // бы бессмысленно.
  const hash = contentHash(body);
  const at = now().toISOString();
  try { putState(db, LAST_PUBLISH, JSON.stringify({ at, hash, bytes: sealed.length })); }
  catch (e) {
    // Журнал выгрузок — не то, ради чего стоит объявлять неудачной уже
    // состоявшуюся выгрузку. Худшее следствие — лишняя выгрузка в следующий раз.
    console.warn('[branch-sync] could not record the relay publish:', e && e.message);
  }
  return { ok: true, bytes: sealed.length, at, hash };
}

/**
 * Отпечаток СОДЕРЖИМОГО справочника — то, по чему фоновый прогон решает, есть
 * ли смысл гнать мегабайты заново.
 *
 * Две даты выброшены, и обе не по мелочи:
 *   * body.generated_at — момент выгрузки, он новый всегда;
 *   * catalogue.generated_at — его же ставит exportCatalogue() ВНУТРЬ
 *     справочника. Пока он входил в отпечаток, отпечаток не совпадал НИКОГДА,
 *     «ничего не изменилось» не срабатывало ни разу, и фоновый прогон
 *     перезаливал весь справочник каждые шесть часов на любом канале, включая
 *     мобильный. Ошибка была невидимой — всё «работало», просто дороже, чем
 *     задумано. Поймано тестом «фоновая выгрузка молчит, пока справочник не
 *     изменился».
 */
function contentHash(body) {
  const { generated_at: _ignored, ...catalogue } = body.catalogue || {};
  return createHash('sha256')
    .update(JSON.stringify({ group_id: body.group_id, catalogue }))
    .digest('hex');
}

/**
 * Выгрузить, ЕСЛИ есть смысл. Решение планировщика, вынесенное из
 * publishCatalogue: кнопка «Отправить сейчас» обязана отправлять всегда (иначе
 * владелец нажимает и не понимает, произошло ли что-нибудь), а фоновый прогон
 * не должен гонять мегабайты каждые шесть часов ради неизменившегося прайса.
 *
 * @returns {Promise<{ok:true, skipped:true}|object>} skipped — ничего не
 *   изменилось и копия свежая.
 */
export async function maybePublish(db, dataDir, opts = {}) {
  const { now = () => new Date() } = opts;
  const pairing = readPairing(dataDir);
  if (!pairing || pairing.role !== 'main' || !relayEnabled(pairing)) return { ok: false, reason: 'relay_disabled' };
  if (!relayIdFor(pairing.group_key)) return { ok: false, reason: 'relay_no_key' };

  const last = readLastPublish(db);
  if (last && last.hash) {
    const fresh = last.at && (now().getTime() - Date.parse(last.at)) < REFRESH_MS;
    if (fresh && last.hash === contentHash(relayBody(db, pairing, now))) {
      return { ok: true, skipped: true };
    }
  }
  return publishCatalogue(db, dataDir, opts);
}

/**
 * Забрать зашифрованный справочник с сервера поставщика. Сторона ПОДКЛЮЧЁННОГО
 * филиала, и только как запасной путь — сначала всегда пробуется прямой
 * (см. rpc/branch-sync.js branchSyncNow).
 *
 * НИКОГДА не бросает, НИЧЕГО не пишет в базу: решение о применении принимает
 * вызывающий, получив ok:true. Блоб, не сошедшийся по тегу, отвергается целиком
 * — половина справочника хуже, чем ни одной.
 *
 * reason: relay_not_secondary | relay_disabled | relay_no_key |
 *   relay_not_enrolled | relay_offline | relay_unauthorized | relay_empty |
 *   relay_too_large | relay_server_error | relay_bad_key | relay_bad_response
 *
 * @returns {Promise<{ok:true, group_id, catalogue, generated_at}|{ok:false, reason:string}>}
 */
export async function fetchCatalogue(dataDir, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  maxBlobBytes = MAX_BLOB_BYTES,
  env = process.env,
} = {}) {
  const pairing = readPairing(dataDir);
  if (!pairing || pairing.role !== 'secondary') return { ok: false, reason: 'relay_not_secondary' };
  if (!relayEnabled(pairing)) return { ok: false, reason: 'relay_disabled' };

  const relayId = relayIdFor(pairing.group_key);
  if (!relayId) return { ok: false, reason: 'relay_no_key' };

  const token = relayCredential(dataDir, pairing);
  if (!token) return { ok: false, reason: 'relay_not_enrolled' };

  let res;
  try {
    res = await fetchImpl(relayUrl(relayId, env), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: 'relay_offline' };
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'relay_unauthorized' };
    // 404 — блоба нет. Самый обычный случай: главный филиал не включал выгрузку
    // либо ещё ни разу не выгружался. Отдельная причина, потому что чинится это
    // на ДРУГОЙ машине, и владелец должен услышать именно это.
    if (res.status === 404) return { ok: false, reason: 'relay_empty' };
    return { ok: false, reason: 'relay_server_error' };
  }

  const bytes = await readBoundedBytes(res, maxBlobBytes).catch(() => null);
  if (bytes === null) return { ok: false, reason: 'relay_too_large' };

  const opened = openPayload(pairing.group_key, bytes);
  if (!opened.ok) {
    // bad_key — тег не сошёлся. На экране это «ключи филиалов не совпадают»:
    // почти всегда владелец перевыпустил ключ в главном филиале и не разнёс его
    // по остальным. Подменённые сервером байты дают ровно тот же отказ, и это
    // правильно — действие в обоих случаях одно: не применять ничего.
    return { ok: false, reason: opened.reason === 'bad_key' ? 'relay_bad_key' : 'relay_bad_response' };
  }

  const payload = opened.payload;
  const catalogue = payload.catalogue;
  if (payload.ok !== true || !catalogue || typeof catalogue !== 'object' || Array.isArray(catalogue)) {
    return { ok: false, reason: 'relay_bad_response' };
  }
  // Та же дешёвая проверка на рассинхронизацию, что в pull.js: подпись (здесь —
  // тег) уже доказала происхождение, но блоб мог остаться от прошлой группы.
  if (typeof payload.group_id === 'string' && payload.group_id && payload.group_id !== pairing.group_id) {
    return { ok: false, reason: 'relay_bad_response' };
  }

  return {
    ok: true,
    group_id: pairing.group_id,
    catalogue,
    generated_at: typeof payload.generated_at === 'string' ? payload.generated_at : null,
  };
}

/**
 * Ставит фоновую выгрузку в расписание. Зеркало scheduleCheckin(): два
 * unref()'нутых таймера, каждый тик в своём try/catch, ничего не держит процесс
 * открытым — клиника, которую выключают вечером, не ждёт синхронизацию.
 *
 * Установка, не назначенная главным филиалом или не давшая согласия, здесь
 * ничего не делает: maybePublish() отвечает relay_disabled и выходит.
 */
export function scheduleRelayPublish(db, dataDir, opts = {}) {
  const { initialDelayMs = INITIAL_DELAY_MS, intervalMs = INTERVAL_MS, ...runOpts } = opts;
  const run = () => {
    maybePublish(db, dataDir, runOpts)
      .then((r) => {
        if (r && r.ok === false && r.reason !== 'relay_disabled' && r.reason !== 'relay_no_key') {
          console.warn('[branch-sync] relay publish did not happen:', r.reason);
        }
      })
      .catch((e) => console.warn('[branch-sync] scheduled relay publish failed:', e && e.message));
  };
  const initial = setTimeout(run, initialDelayMs);
  initial.unref();
  const interval = setInterval(run, intervalMs);
  interval.unref();
  return { initial, interval };
}
