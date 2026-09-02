import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonFile } from '../control/checkin.js';
import { exportCatalogue } from './catalogue.js';
import { readPairing, writePairing, relayEnabled } from './pairing.js';
import { ensureSyncGroup } from './sync-group.js';
import { readIdentity } from './identity.js';
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

// BRANCH_IDENTITY_V1 — где ГЛАВНЫЙ филиал выписывает учётку для нового филиала
// (control-plane/server/routes/relay-token.js, RELAY_TOKEN_MOUNT). Тот же приём,
// что и строкой выше, и по той же причине: разъехавшись на один символ, две
// стороны дадут 404, который на экране неотличим от «поставщик не умеет
// резервный канал».
export const RELAY_TOKEN_PATH = '/cp/v1/relay-token';

const DEFAULT_ENDPOINT = 'https://settings.easymed.uz';

// Те же бюджеты, что у checkin.js: мёртвая сеть обязана отказать быстро, а не
// висеть. Выгрузка больше check-in-а на порядки, поэтому и времени ей больше.
const UPLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
// Выписка учётки — один INSERT на той стороне и полсотни байт ответа, поэтому
// бюджет короткий: владелец в этот момент СМОТРИТ на кнопку «Добавить филиал»,
// и минута ожидания ради необязательного резервного канала — это сломанная
// кнопка, а не терпение.
const MINT_TIMEOUT_MS = 15_000;

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
// занималась филиалами.
//
// BRANCH_SYNC_HOURLY_V1 — дальше раз в ЧАС, было раз в 6 часов. Решение
// владельца 2026-09-02: «1 hour syncronization period for the entire system».
// Шесть часов ставились, когда единственным грузом был справочник, который
// меняют редко; теперь по этому же каналу владелец ждёт данные для отчётов, и
// «свежесть до шести часов» перестала быть свежестью. Дороже это почти не
// стоит: пустой прогон — один SELECT и сравнение хэша, выгрузка происходит
// только при изменившемся содержимом.
const INITIAL_DELAY_MS = 90_000;
const INTERVAL_MS = 60 * 60 * 1000;

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

/** Туда же, но за учёткой для филиала. */
export function relayTokenUrl(env = process.env) {
  const base = String((env && env.EASYMED_CONTROL_URL) || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  return base + RELAY_TOKEN_PATH;
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
 * ключа выписан ЭТОМУ филиалу, действует только на выписанных ему адресах
 * (Задача 7a: справочник, свой узел и узлы соседей — и ничего сверх) и гасится
 * одной строкой у поставщика (relay_tokens.revoked_at). Победи здесь install_token —
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
 *   relay_branch_no_token | relay_offline | relay_branch_revoked | relay_empty |
 *   relay_too_large | relay_server_error | relay_bad_key | relay_bad_response
 *
 * BRANCH_IDENTITY_V1 — relay_branch_no_token и relay_branch_revoked заменили
 * здесь общие relay_not_enrolled и relay_unauthorized. Коды разошлись потому,
 * что разошлись ЛЕКАРСТВА: у главного филиала это «проверьте активацию
 * клиники», у подключённого — «возьмите новый ключ подключения в главном
 * филиале». Ветки по роли не понадобилось: эта функция и так только для
 * подключённого (первая же проверка), а publishCatalogue — только для главного.
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
  // ОТДЕЛЬНЫЙ КОД, А НЕ relay_not_enrolled, и это правка про лекарство, а не про
  // оттенок формулировки. Эта функция по построению работает только у
  // ПОДКЛЮЧЁННОГО филиала (проверка role выше), а подключённый филиал у
  // поставщика не активирован и активирован не будет — он подключался к
  // клинике. Фраза «клиника не активирована через Easy-Med» отправляла его
  // владельца проверять активацию, то есть чинить то, что не сломано; настоящее
  // лекарство — взять в главном филиале новый ключ подключения, потому что
  // учётка резервного канала приезжает ВНУТРИ ключа.
  if (!token) return { ok: false, reason: 'relay_branch_no_token' };

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
    // И здесь тоже свой код, по той же причине. 401 у подключённого филиала
    // означает ровно одно из двух: главный филиал отозвал его учётку
    // (relay_tokens.revoked_at) или перевыпустил ключ синхронизации, отчего
    // адрес на сервере сменился вместе с ключом группы. Оба чинятся ОДНИМ
    // действием и на ДРУГОЙ машине — новым ключом подключения, — а «проверьте
    // активацию клиники» не чинится ничем.
    //
    // Третий случай — адрес вне области токена — с Задачи 7a чинится ТЕМ ЖЕ
    // действием: область выписывается по буквам, известным главной клинике, так
    // что филиал, заведённый после выдачи ключа, в чужую область не входит, и
    // новый ключ — ровно то, что нужно. До Задачи 7a этот же 401 приходил на
    // СОБСТВЕННЫЙ адрес филиала, и никакой ключ его не чинил: это была ошибка
    // кода, а совет владельцу — неверный.
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'relay_branch_revoked' };
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
 * МОЖЕТ ЛИ эта установка выписать учётку резервного канала — да/нет, без сети.
 *
 * Существует ради ЭКРАНА, а не ради выписки: список филиалов должен решить,
 * показывать ли кнопку «Выдать доступ» у филиала без учётки. У клиники,
 * которой резервный канал недоступен в принципе (не активирована, нет ключа
 * группы), эта кнопка отказывала бы всегда — а кнопка, которая никогда не
 * срабатывает, хуже её отсутствия.
 *
 * ТЕ ЖЕ ТРИ УСЛОВИЯ, что и в начале mintRelayToken, и разъехаться им нельзя:
 * иначе экран либо прячет работающую кнопку, либо показывает мёртвую. Их
 * держит вместе тест «предсказание кнопки совпадает с тем, что делает выписка»
 * (relay.test.js), который прогоняет обе функции по одним и тем же установкам.
 * Отдельная функция, а не флаг из mintRelayToken, потому что mintRelayToken
 * ходит в сеть, а открытие экрана ходить в сеть не должно.
 */
export function relayMintable(dataDir) {
  const pairing = readPairing(dataDir);
  if (!pairing || pairing.role !== 'main') return false;
  if (!relayIdFor(pairing.group_key)) return false;
  return !!installToken(dataDir);
}

// BRANCH_RECORDS_V1 (Задача 7a) — сколько адресов помещается в один токен.
//
// То же число, что MAX_SCOPE в control-plane/server/routes/relay-token.js, и
// держать их в согласии обязательно: запрос шире получает 400, а филиал остаётся
// БЕЗ ТОКЕНА ВОВСЕ. Ровно поэтому здесь обрезка, а не отправка «как есть»:
// выбор между «токен без нескольких дальних соседей» и «токена нет» очевиден, и
// сеть такого размера сегодня не существует — буквы филиалов считают единицами.
const MAX_SCOPE = 64;

/**
 * Адреса, которые токен филиала должен уметь трогать.
 *
 * Справочник (адрес группы) — ПЕРВЫМ и всегда: с него начинается любая
 * синхронизация, и сервер кладёт первый адрес в relay_tokens.relay_id. Дальше по
 * адресу узла на каждую букву: свою филиал пишет, соседские читает.
 *
 * Мусор в буквах не отказ, а пропуск. Буквы приходят из таблицы branches, куда
 * пишет не только этот код: NULL, пустые строки и пробелы там встречаются
 * (rpc/branch-sync.js фильтрует их запросом, но эта функция экспортируемому
 * контракту не хозяйка), а собственная буква клиники приезжает дважды. Повтор
 * адреса на той стороне — нарушение первичного ключа, то есть 500 вместо
 * выписки; отказ из-за пустой строки — филиал без резервного канала. Ни то ни
 * другое не стоит одной кривой строки в списке филиалов.
 */
function relayScope(groupKey, catalogueId, letters) {
  const ids = [catalogueId];
  for (const raw of Array.isArray(letters) ? letters : []) {
    if (ids.length >= MAX_SCOPE) break;
    const id = relayIdFor(groupKey, typeof raw === 'string' ? raw.trim() : '');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * BRANCH_IDENTITY_V1 — выписать НОВОМУ ФИЛИАЛУ учётку резервного канала.
 *
 * Сторона ГЛАВНОГО филиала, и только его: он единственный в группе, кто
 * активирован у поставщика, поэтому он единственный, кому есть чем
 * представиться. Выписанный токен уезжает во второй филиал ВНУТРИ ключа
 * подключения, который владелец переносит руками, — через сервер поставщика он
 * не проходит ни разу.
 *
 * НИКОГДА НЕ БРОСАЕТ и ничему не мешает. Ключ подключения выпускается и без
 * токена: Маршрут А (филиал ходит к главному напрямую) от поставщика не зависит
 * вовсе, и клиника без интернета обязана уметь завести филиал. Отказ здесь —
 * это «резервный канал у этого филиала пока не работает», а не «филиал не
 * заведён», и экран говорит именно это.
 *
 * ОБЛАСТЬ (BRANCH_RECORDS_V1, Задача 7a) — `letters`: буквы ВСЕХ узлов группы,
 * какими их знает главная клиника (таблица branches, где буква проставлена).
 * Токен выписывается на справочник ПЛЮС адрес узла каждой из них, потому что в
 * Фазе 2 филиал пишет журнал по СВОЕМУ адресу и читает адреса соседей. Без
 * `letters` просится ровно один адрес — справочник, — то есть в точности то, что
 * эта функция делала до Фазы 2: старая форма вызова обязана остаться рабочей.
 *
 * reason: relay_not_main | relay_no_key | relay_not_enrolled | relay_offline |
 *   relay_unauthorized | relay_too_many_tokens | relay_server_error |
 *   relay_bad_response
 *
 * @param {string[]} [options.letters] буквы узлов группы; своя тоже
 * @returns {Promise<{ok:true, token:string, relay_id:string, relay_ids:string[]}
 *   |{ok:false, reason:string}>}
 */
export async function mintRelayToken(dataDir, {
  fetchImpl = globalThis.fetch,
  timeoutMs = MINT_TIMEOUT_MS,
  env = process.env,
  letters = [],
} = {}) {
  const pairing = readPairing(dataDir);
  // Токены ВЫПИСЫВАЕТ главный филиал. У подключённого своего install_token-а
  // нет, и попытка выписать закончилась бы 401, который на экране выглядит как
  // отозванный доступ — жалоба на поломку там, где просто не та машина.
  if (!pairing || pairing.role !== 'main') return { ok: false, reason: 'relay_not_main' };

  // Адрес справочника выводится из ключа группы: без ключа выписывать нечего и
  // не на что. Он же идёт ПЕРВЫМ в области — это «основной» адрес токена, тот
  // самый, который сервер кладёт в relay_tokens.relay_id.
  const relayId = relayIdFor(pairing.group_key);
  if (!relayId) return { ok: false, reason: 'relay_no_key' };
  const relayIds = relayScope(pairing.group_key, relayId, letters);

  // Клиника, лицензированная по телефону и никогда не ходившая к поставщику,
  // резервным каналом пользоваться не может — ни сама, ни через филиалы.
  const token = installToken(dataDir);
  if (!token) return { ok: false, reason: 'relay_not_enrolled' };

  let res;
  try {
    res = await fetchImpl(relayTokenUrl(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // ОБА ПОЛЯ, и это про порядок обновлений, а не про вкус. Панель поставщика
      // обновляется отдельно от клиник — руками, по SSH, — так что клиника,
      // обновившаяся первой, какое-то время разговаривает со СТАРЫМ сервером.
      // Старый читает relay_id и выписывает ровно то, что выписывал вчера
      // (справочник); новый видит relay_ids и выписывает область. Отправлять
      // только relay_ids значило бы получить 400 на всю сеть до тех пор, пока
      // владелец не обновит сервер, — то есть уронить работающее.
      body: JSON.stringify({ relay_id: relayId, relay_ids: relayIds }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Клиника офлайновая по построению: нет интернета — не поломка.
    return { ok: false, reason: 'relay_offline' };
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'relay_unauthorized' };
    // 409 — упёрлись в потолок живых токенов клиники (см. MAX_LIVE_TOKENS_PER_CLINIC
    // в control-plane/server/routes/relay-token.js). Отдельный код, потому что
    // лекарство своё и оно есть: отозвать учётки филиалов, которых больше нет.
    if (res.status === 409) return { ok: false, reason: 'relay_too_many_tokens' };
    return { ok: false, reason: 'relay_server_error' };
  }

  let body;
  try { body = await res.json(); }
  catch { return { ok: false, reason: 'relay_bad_response' }; }
  const minted = body && typeof body.token === 'string' ? body.token.trim() : '';
  // Пустая строка — это ОТСУТСТВИЕ токена, а не токен: записав её в ключ, мы
  // выдали бы филиалу гарантированный 401 под видом рабочей учётки.
  if (!minted) return { ok: false, reason: 'relay_bad_response' };
  // relay_ids — то, что ПОПРОСИЛИ, а не то, что вернул сервер: старая панель
  // этого поля не отдаёт вовсе, и вызывающему нужна одна форма ответа, а не две.
  return { ok: true, token: minted, relay_id: relayId, relay_ids: relayIds };
}

/**
 * Ставит фоновую выгрузку в расписание. Зеркало scheduleCheckin(): два
 * unref()'нутых таймера, каждый тик в своём try/catch, ничего не держит процесс
 * открытым — клиника, которую выключают вечером, не ждёт синхронизацию.
 *
 * Установка, не назначенная главным филиалом или не давшая согласия, здесь
 * ничего не делает: maybePublish() отвечает relay_disabled и выходит.
 */
// BRANCH_RELAY_ON_BY_DEFAULT_V1 — у сети, где филиалы УЖЕ заведены, канал тоже
// включается сам.
//
// Заведение филиала включает канал при создании — но это не помогает тем, кто
// связал филиалы раньше. Ровно в это упёрся владелец 2026-09-02: главная
// клиника обновилась до версии с автовключением, а канал остался выключенным,
// потому что филиал заведён ДО неё, и relay_blobs на сервере так и остался
// нулём — при живом филиале, который весь день просил копию.
//
// Различаем ТРИ состояния, а не два. undefined — человек никогда не выбирал, и
// за него решаем мы: есть филиалы с ключами — значит канал нужен. false —
// человек выключил ОСОЗНАННО, и включать обратно за его спиной нельзя: это его
// данные и его решение, отправлять ли копию на чужой сервер.
function adoptRelayForExistingBranches(db, dataDir) {
  try {
    const pairing = readPairing(dataDir);
    if (!pairing || pairing.role !== 'main') return;
    if (pairing.relay !== undefined && pairing.relay !== null) return;   // выбор уже сделан
    // ЧУЖИЕ филиалы, а не любые строки с буквой. Собственная строка клиники
    // тоже имеет букву (A) — считать её значило бы включать канал одиночной
    // клинике, которой не с кем синхронизироваться.
    let selfBranchId = null;
    try { selfBranchId = readIdentity(db).branch_id; } catch (e) { selfBranchId = null; }
    const row = db.prepare(
      "SELECT COUNT(*) n FROM branches WHERE letter IS NOT NULL AND letter <> '' AND id IS NOT ?"
    ).get(selfBranchId);
    if (!row || row.n < 1) return;   // филиалов нет — включать нечего и незачем
    ensureSyncGroup(dataDir);
    writePairing(dataDir, { ...readPairing(dataDir), relay: true });
    console.log('[branch-sync] relay switched on: this clinic has branches and nobody had chosen');
  } catch (e) {
    console.warn('[branch-sync] could not adopt the relay setting:', e && e.message);
  }
}

export function scheduleRelayPublish(db, dataDir, opts = {}) {
  const { initialDelayMs = INITIAL_DELAY_MS, intervalMs = INTERVAL_MS, ...runOpts } = opts;
  const run = () => {
    adoptRelayForExistingBranches(db, dataDir);
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

// BRANCH_SELF_SERVICE_V1 — попросить control plane завести филиал этой сети.
//
// Тот же приём, что и mintRelayToken выше, и по той же причине: предъявляем
// install_token ГЛАВНОЙ клиники — единственной машины в группе, у которой есть
// чем доказать вендору, кто она. Отличие одно: relay-token делегирует узкий
// доступ, а здесь создаётся НОВАЯ клиника со своей подпиской и своим счётом.
//
// Возвращает код активации филиала. Он не сохраняется на этой машине: код
// одноразовый и принадлежит филиалу — здесь он живёт ровно до того, как ляжет
// в ключ связывания (pairing.js, encodeKey → body.e).
//
// Ошибки НЕ глотаем в успех: ключ без кода — это ключ, которым филиал не
// активируется, и выдать такой молча значит отправить человека ставить систему,
// которая не заведётся. Причина возвращается вызывающему словом.
export async function createBranchOnControlPlane(dataDir, {
  name = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = MINT_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const token = installToken(dataDir);
  if (!token) return { ok: false, reason: 'branch_not_enrolled' };

  const base = String((env && env.EASYMED_CONTROL_URL) || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  let res;
  try {
    res = await fetchImpl(base + '/cp/v1/branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install_token: token, name: name || undefined }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: 'branch_offline' };
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'branch_unauthorized' };
    if (res.status === 402) return { ok: false, reason: 'branch_parent_unpaid' };
    if (res.status === 409) return { ok: false, reason: 'branch_of_branch' };
    return { ok: false, reason: 'branch_server_error' };
  }

  let body;
  try { body = await res.json(); } catch { return { ok: false, reason: 'branch_server_error' }; }
  const code = body && typeof body.enrollment_code === 'string' ? body.enrollment_code.trim() : '';
  if (!code) return { ok: false, reason: 'branch_server_error' };
  return { ok: true, enrollment_code: code, clinic_id: body.clinic_id || null, name: body.name || null };
}
