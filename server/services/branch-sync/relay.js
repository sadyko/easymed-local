import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonFile } from '../control/checkin.js';
import { assertControlUrlIsTestSafe } from '../control/prod-guard.js';   // PROD_GUARD_V1
import { exportCatalogue } from './catalogue.js';
import { readPairing, writePairing, relayEnabled } from './pairing.js';
import { ensureSyncGroup } from './sync-group.js';
import { readIdentity } from './identity.js';
import { relayIdFor, sealPayload, openPayload } from './relay-crypto.js';
// BRANCH_RECORDS_V1 (Задача 7) — журнал изменений ездит тем же каналом, что и справочник.
import { buildBatch, markPublished, markConfirmed, SHIPPED } from './journal.js';
import { applyBatch, sliceAlreadyApplied } from './records.js';
// Резервная копия перед применением чужих записей — то же правило, что у справочника.
import { createBackup, pruneBackupsByKind } from '../backup.js';

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

// BRANCH_SELF_TOKEN_V1 — учётка, которую филиал выписывает СЕБЕ САМ.
//
// ЧТО СЛОМАЛОСЬ. Учётки, выписанные до Задачи 7a, имеют область из ОДНОГО
// адреса — справочника (control-plane/server/db/migrations/008_relay_token_scopes.sql
// выкачена 2026-09-02, а ключи выдавались и раньше). Записи Фазы 2 ездят по
// адресам УЗЛОВ, поэтому поставщик отвечает 401 на каждую выгрузку журнала и
// каждое чтение чужого, а экран филиала говорит «доступ отозван» — неверный
// совет на ошибку кода. До этой правки лекарство было одно: перевыпустить ключ
// подключения и отвезти его в другое здание.
//
// ПОЧЕМУ ФИЛИАЛ ВПРАВЕ ВЫПИСАТЬ ЕЁ СЕБЕ. Вторичный филиал — тоже
// АКТИВИРОВАННАЯ клиника у поставщика: /cp/v1/branch заводит ему собственный
// clinic_id вида c-…-bN и собственный install_token (проверено на филиале
// владельца, c-000005-b2). Маршрут выписки пускает ЛЮБУЮ активированную
// клинику (`SELECT clinic_id FROM clinics WHERE install_token = ? AND active = 1`
// в control-plane/server/routes/relay-token.js) и выдаёт права на те адреса,
// которые попросили; сами адреса выводятся из ключа группы, который у филиала и
// так есть (relay-crypto.js relayIdFor). Значит выписка не даёт филиалу НИЧЕГО,
// чего у него не было: тем же install_token-ом он и так открывает на релее
// любой адрес, который знает (routes/relay.js, первая ветка аутентификации).
//
// ЧТО ЭТО МЕНЯЕТ В ОТЗЫВЕ, сказано прямо. Отзыв учётки филиала
// (relay_tokens.revoked_at — руками в базе поставщика, кнопки для этого нет)
// перестаёт что-либо значить для АКТИВИРОВАННОГО филиала: он выпишет себе
// новую. Он и раньше значил немногое — install_token того же филиала открывает
// те же адреса, — но теперь это происходит само. Рычаг, который работает:
// снять активацию с клиники филиала (`clinics.active = 0` гасит и её
// install_token, и все выписанные ей учётки — и мы, и clinicForRelayToken
// смотрят на active) либо перевыпустить ключ группы в главной клинике (сменятся
// все адреса сразу). Для филиала БЕЗ активации — того самого, которому ключ
// привезли руками, — отзыв работает ровно как работал: выписывать ему нечем.
export const OWN_TOKEN_KEY = 'branch_sync_own_relay_token';
// Отметка ПОПЫТКИ выписки — предохранитель от установки, сломанной навсегда.
export const OWN_TOKEN_TRY_KEY = 'branch_sync_own_relay_token_try';
// Не чаще раза в час, то есть не чаще одного часового прогона. Потолок у
// поставщика — 64 живых учётки на клинику (MAX_LIVE_TOKENS_PER_CLINIC), и
// выписка на каждый отказ съела бы его за трое суток, после чего 409 закрыл бы
// филиалу и этот путь.
const OWN_TOKEN_RETRY_MS = 60 * 60 * 1000;

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
function relayCredential(db, dataDir, pairing) {
  // BRANCH_SELF_TOKEN_V1 — СВОЯ выписанная учётка сильнее приехавшей в ключе, и
  // это следствие того, зачем она заводится: та, что в ключе, может не знать
  // адресов узлов вовсе (выписана до Задачи 7a), и предпочесть её значило бы
  // чинить 401 ровно до следующего запроса. Обратный порядок дал бы вечный
  // цикл «отказ → выписка → отказ». Учётку из ключа при этом НЕ ТРОГАЕМ: она
  // остаётся запасной и остаётся доказательством связывания.
  const own = ownRelayToken(db, pairing);
  if (own) return own;
  const fromKey = pairing && typeof pairing.relay_token === 'string' ? pairing.relay_token.trim() : '';
  return fromKey || installToken(dataDir);
}

/**
 * Сохранённая СВОЯ учётка филиала — или null.
 *
 * ТОЛЬКО У ВТОРИЧНОГО ФИЛИАЛА: главная клиника предъявляет install_token и
 * ветки для неё здесь не заводится (её путь этой правкой не меняется вовсе).
 *
 * И ТОЛЬКО НА ТОМ КЛЮЧЕ ГРУППЫ, НА КОТОРЫЙ ВЫПИСАНА. Перевыпуск ключа группы
 * меняет все адреса разом, и учётка, выписанная на прежние, мертва — а вот
 * учётка из НОВОГО ключа подключения рабочая. Не сверив адрес, мы бы
 * предъявляли мёртвую и отвечали 401 на ровно то действие, которым владелец
 * всё починил. Сверяется адрес справочника: он первый в области и выводится из
 * ключа группы так же, как остальные.
 */
function ownRelayToken(db, pairing) {
  if (!db || !pairing || pairing.role !== 'secondary') return null;
  const raw = getState(db, OWN_TOKEN_KEY);
  if (!raw) return null;
  let rec = null;
  try { rec = JSON.parse(raw); } catch { rec = null; }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const token = typeof rec.token === 'string' ? rec.token.trim() : '';
  if (!token) return null;
  const relayId = relayIdFor(pairing.group_key);
  if (typeof rec.relay_id === 'string' && rec.relay_id && rec.relay_id !== relayId) return null;
  return token;
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

  const token = relayCredential(db, dataDir, pairing);
  // Клиника, активированная по телефону и никогда не ходившая к поставщику,
  // резервным каналом пользоваться не может — и это честный отказ, а не молчание:
  // маршрут на той стороне пускает только активированные установки.
  if (!token) return { ok: false, reason: 'relay_not_enrolled' };

  const body = relayBody(db, pairing, now);
  const sealed = sealPayload(pairing.group_key, body);
  if (!sealed) return { ok: false, reason: 'relay_no_key' };
  if (sealed.length > maxBlobBytes) return { ok: false, reason: 'relay_too_large' };

  assertControlUrlIsTestSafe(env, fetchImpl);   // PROD_GUARD_V1
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
    // ЗДЕСЬ ПОЧИНКИ УЧЁТКОЙ НЕТ, и это не пропуск (BRANCH_SELF_TOKEN_V1).
    // Выгружает справочник только ГЛАВНАЯ клиника, а она предъявляет
    // install_token — учётку, у которой области нет вовсе: 401 у неё означает
    // не «адрес вне области», а «поставщик не признал эту установку», и
    // выписывать по такому отказу нечем и незачем.
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
  now = () => new Date(),
  // BRANCH_SELF_TOKEN_V1 — база НЕОБЯЗАТЕЛЬНА и по умолчанию её нет: эта
  // функция ничего в базу не пишет по построению (решение о применении
  // принимает вызывающий), и менять это ради починки учётки не стоит.
  // Передали — филиал умеет выписать себе новую и сохранить её; не передали —
  // поведение ровно прежнее. Выписывать учётку, которую негде сохранить,
  // значило бы терять её на каждом запросе.
  db = null,
} = {}) {
  const pairing = readPairing(dataDir);
  if (!pairing || pairing.role !== 'secondary') return { ok: false, reason: 'relay_not_secondary' };
  if (!relayEnabled(pairing)) return { ok: false, reason: 'relay_disabled' };

  const relayId = relayIdFor(pairing.group_key);
  if (!relayId) return { ok: false, reason: 'relay_no_key' };

  let token = relayCredential(db, dataDir, pairing);
  // ОТДЕЛЬНЫЙ КОД, А НЕ relay_not_enrolled, и это правка про лекарство, а не про
  // оттенок формулировки. Эта функция по построению работает только у
  // ПОДКЛЮЧЁННОГО филиала (проверка role выше), а подключённый филиал у
  // поставщика не активирован и активирован не будет — он подключался к
  // клинике. Фраза «клиника не активирована через Easy-Med» отправляла его
  // владельца проверять активацию, то есть чинить то, что не сломано; настоящее
  // лекарство — взять в главном филиале новый ключ подключения, потому что
  // учётка резервного канала приезжает ВНУТРИ ключа.
  if (!token) return { ok: false, reason: 'relay_branch_no_token' };

  assertControlUrlIsTestSafe(env, fetchImpl);   // PROD_GUARD_V1
  const heal = selfHealToken(db, dataDir, pairing, { fetchImpl, env, now });
  let res;
  for (;;) {
    try {
      res = await fetchImpl(relayUrl(relayId, env), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: 'relay_offline' };
    }
    if (res.ok || (res.status !== 401 && res.status !== 403)) break;
    // BRANCH_SELF_TOKEN_V1 — ОДИН ПОВТОР, и только своей выпиской. heal()
    // отвечает второй раз null по построению, поэтому цикла здесь быть не может.
    const fresh = await heal();
    if (!fresh || fresh === token) break;
    token = fresh;
  }

  if (!res.ok) {
    // И здесь тоже свой код, по той же причине. 401 у подключённого филиала
    // означает ровно одно из двух: главный филиал отозвал его учётку
    // (relay_tokens.revoked_at) или перевыпустил ключ синхронизации, отчего
    // адрес на сервере сменился вместе с ключом группы. Оба чинятся ОДНИМ
    // действием и на ДРУГОЙ машине — новым ключом подключения, — а «проверьте
    // активацию клиники» не чинится ничем.
    //
    // ТРЕТИЙ СЛУЧАЙ — «адрес вне области токена» — ВСЁ-ТАКИ СУЩЕСТВУЕТ, и
    // здесь стояло обратное. Область в весь алфавит сразу (relayScope) выдаётся
    // с Задачи 7a, но только тем, кого выписали ПОСЛЕ неё: учётки, уехавшие в
    // ключах раньше, знают один адрес — этот самый справочник. Такой филиал
    // забирает копию и не может ни выложить свой журнал, ни прочитать чужой, а
    // новый ключ подключения его НЕ ЧИНИТ: ключ собирается из СОХРАНЁННОГО
    // токена (rpc/branch-sync.js branchKeyFor), а выписка повторно не идёт
    // никогда (ensureBranchToken). Поэтому филиал выписывает учётку себе сам —
    // цикл выше, BRANCH_SELF_TOKEN_V1. Сюда мы доходим, только если и это не
    // вышло, и тогда совет прежний и верный.
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

// ===========================================================================
// BRANCH_RECORDS_V1 (Задача 7) — ЖУРНАЛЫ ФИЛИАЛОВ ПО ТОМУ ЖЕ КАНАЛУ.
//
// Всё, что выше, возит СПРАВОЧНИК: один блоб на группу, пишет его главная
// клиника, читают остальные. Записи так возить нельзя — их пишут ВСЕ узлы
// сразу, и общий адрес означал бы, что филиалы затирают выгрузки друг друга.
// Отсюда адрес НА УЗЕЛ (Задача 6, relayIdFor(ключ, буква)) и область токена на
// весь алфавит (Задача 7a), уже выкаченная на живую панель поставщика.
//
// ОДИН БЛОБ НА УЗЕЛ, А НЕ НА ПАРУ. Порции по построению разные для разных
// соседей (у каждого свой sent_seq), поэтому напрашивался блоб на пару
// «отправитель → получатель». Это N² адресов, N² выгрузок в час и N² строк
// удержания у поставщика: сеть из восьми зданий — 56 выгрузок в час вместо 8.
// Поэтому узел выкладывает ОДИН блоб со срезами для всех соседей:
//
//   { v: 1, from: 'B', generated_at: '…',
//     acks: { A: {upto: 4120, seed_page: 0}, C: {…} },
//     batches: { A: {records, upto, seed?, seed_page?}, C: {…} } }
//
// acks — КВИТАНЦИИ (Задача 7b): докуда B применил журнал каждого соседа.
// Лежат в общем блобе, а не в срезе, ровно потому же, почему и всё остальное:
// адрес на узел один, и заводить второй ради одного числа незачем.
//
// Каждый сосед читает СВОЙ срез. Деление здесь — про то, кому какие записи
// АДРЕСОВАНЫ, а не про секреты внутри клиники: ключ группы один на всех, и
// весь блоб виден каждому соседу в любом случае.  Пустой срез не кладётся
// вовсе — сосед, которому нечего слать, не должен раздувать блоб.
//
// ЧТО ЗДЕСЬ НЕ ХУЖЕ СПРАВОЧНИКА. Тот же sealPayload тем же ключом группы:
// поставщик видит длину и ритм выгрузок, и больше ничего. Согласие владельца —
// то же самое (relayEnabled), и это принципиально: по этому каналу теперь едут
// ПАЦИЕНТЫ, а не прайс, и включать его молча нельзя.
//
// РОЛИ ЗДЕСЬ НЕТ. Справочник раздаёт главная клиника — записи пишут все, и
// главная клиника в этом обмене такой же узел, как любой филиал. Ветки по роли
// в этих двух функциях нет намеренно: она означала бы, что пациент, заведённый
// в филиале, не доедет до главной.

// Порция журнала на одну выгрузку — то же число, что у buildBatch по умолчанию.
const JOURNAL_LIMIT = 5000;
// Ниже этого порция не ужимается. Если и сотня записей не влезает в предел
// блоба, дело не в размере страницы, а в одной чудовищной строке — её надо
// увидеть отказом, а не резать страницу до нуля бесконечным делением.
const MIN_JOURNAL_LIMIT = 100;
// СТРАНИЦА ЗАСЕВА — крупнее обычной (Задача 7e, I-3). Страница подтверждается
// соседом, а такт у сети часовой, поэтому каждая страница стоит примерно трёх
// часов: выложили — забрал — подтвердил. При 5000 строк на страницу клиника на
// 70 000 пациентов (со всеми визитами и результатами это ~250 000 строк)
// засевала бы филиал больше месяца. Двадцать тысяч строк на страницу и
// десятиминутный такт на время засева сводят это к нескольким часам.
// Предел блоба по-прежнему главнее: не влезло — страница делится пополам.
const SEED_LIMIT = 20000;
// Пока кого-то засеваем, обмен идёт не раз в час, а раз в десять минут — и на
// той, и на другой стороне. Ускорение временное: закончился засев — вернулись
// к часовому ритму, ради которого всё и строилось.
export const SEEDING_INTERVAL_MS = 10 * 60 * 1000;
// Отметка «нас сейчас засевают»: её ставит приём, когда разобрал страницу
// засева. Филиалу больше неоткуда узнать, что первичная загрузка идёт, — а
// торопиться нужно именно ему.
export const SEEDING_KEY = 'branch_sync_seeding';

/** Идёт ли первичная загрузка — в любую сторону. Читается расписаниями. */
export function seedingNow(db, { now = () => new Date() } = {}) {
  try {
    const mine = db.prepare('SELECT 1 FROM sync_peers WHERE seed_floor IS NOT NULL LIMIT 1').get();
    if (mine) return true;
    const raw = getState(db, SEEDING_KEY);
    if (!raw) return false;
    // Свежесть, а не флаг: «засев кончился» приёмнику никто не объявляет, он
    // просто перестаёт получать страницы. Полчаса тишины — значит кончился.
    const seen = Date.parse(String(raw));
    return Number.isFinite(seen) && (now().getTime() - seen) < 30 * 60 * 1000;
  } catch {
    return false;
  }
}

// Запись о последней выгрузке ЖУРНАЛА — отдельно от LAST_PUBLISH_KEY
// (справочник): у них разные адреса, разное содержимое и разные поводы
// повторить. Экспортирован по той же причине, что и тот: перевыпуск ключа
// группы обязан её стереть, иначе keep-alive считает свежей копию по адресу,
// которого больше нет.
// ПРИЧИНЫ, КОТОРЫЕ НЕ НАДО ПОКАЗЫВАТЬ И НЕ НАДО ЛОГИРОВАТЬ.
//
// Все четыре значат одно: у этой установки канала для журналов нет и не
// должно быть — одиночная клиника (нет соседей), несвязанная установка,
// выключенный владельцем канал или пара без ключа группы (Маршрут А без
// Маршрута Б). Ни одна из них не поломка, а строка в журнале каждый час
// превращает журнал в шум, в котором настоящую поломку уже не видно.
export const QUIET_JOURNAL_REASONS = new Set([
  'relay_no_pairing', 'relay_disabled', 'relay_no_peers', 'relay_no_key',
]);

export const LAST_JOURNAL_KEY = 'branch_sync_relay_journal';
// Докуда дошла первичная загрузка ЭТОГО узла — для экрана: {from, page, pages}.
export const SEED_PROGRESS_KEY = 'branch_sync_seed_progress';

/** Последняя удачная выгрузка журнала: {at, bytes, peers} — либо null. */
export function readLastJournal(db) {
  const raw = getState(db, LAST_JOURNAL_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/**
 * Буквы СОСЕДЕЙ — все узлы группы, кроме этого.
 *
 * `letter IS NOT NULL AND letter <> ''` — фильтр обязательный, а не
 * косметический (тот же, что в ensureBranchToken и в списке сети справочника):
 * строки без буквы в этой таблице обычны — филиалы заводили и до появления
 * букв, — а пустая буква дала бы адрес СПРАВОЧНИКА (relayIdFor без узла), то
 * есть узел молча выгружал бы журнал поверх справочника главной клиники.
 *
 * DISTINCT и своя буква вон: обе ошибки стоили бы одинаково дорого — выгрузка
 * самому себе и двойное применение одной и той же порции.
 *
 * ОТКУДА У ФИЛИАЛА БЕРУТСЯ СОСЕДИ. Свою строку филиал заводит сам при
 * активации (identity.js becomeSecondary), строка главной приезжает засеянной
 * (миграция 080, буква A), а остальные — списком сети в справочнике
 * (catalogue.js roster). Без этого списка филиал B знал бы только главную и
 * никогда не прочитал бы журнал филиала C.
 */
export function journalPeers(db, self) {
  const me = String(self == null ? '' : self).trim().toUpperCase();
  let rows;
  try {
    rows = db.prepare(
      "SELECT letter FROM branches WHERE letter IS NOT NULL AND letter <> '' ORDER BY letter"
    ).all();
  } catch (e) {
    console.warn('[branch-sync] could not list the group letters:', e && e.message);
    return [];
  }
  const out = [];
  for (const row of rows) {
    const letter = String(row.letter || '').trim().toUpperCase();
    if (!letter || letter === me || out.includes(letter)) continue;
    out.push(letter);
  }
  return out;
}

/**
 * КВИТАНЦИИ, которые уедут в нашем блобе: сосед → докуда мы применили ЕГО
 * журнал (sync_peers.recv_upto, пишет его applyBatch той же транзакцией, что
 * и сами записи). Нули не кладутся: «ничего не применили» — это отсутствие
 * квитанции, и слать его незачем.
 */
function journalAcks(db) {
  const out = {};
  try {
    const rows = db.prepare(
      'SELECT node, recv_upto, recv_seed_page FROM sync_peers WHERE recv_upto > 0 OR recv_seed_page > 0'
    ).all();
    for (const row of rows) {
      const letter = String(row.node || '').trim().toUpperCase();
      // ОБЪЕКТ, а не число: у засева номер страницы — единственное, чем его
      // страницы различаются (upto у всех один, замороженный пол). Сборка до
      // Задачи 7b читала здесь число; получив объект, она просто не двигает
      // свой sent_seq — то есть повторяет срез, но ничего не теряет.
      if (letter) out[letter] = { upto: row.recv_upto, seed_page: row.recv_seed_page };
    }
  } catch (e) {
    // Квитанции — не повод сорвать выгрузку: без них сосед просто повторит
    // срез ещё раз, а вот не уехавшие записи никто не повторит.
    console.warn('[branch-sync] could not read the journal receipts:', e && e.message);
  }
  return out;
}

/** Те же квитанции, что в прошлый раз? Только ради решения «выгружаться ли». */
function sameAcks(prev, next) {
  const a = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(a).length) return false;
  return keys.every((k) => a[k] && next[k]
    && a[k].upto === next[k].upto && a[k].seed_page === next[k].seed_page);
}

/** Этому соседу сейчас идёт засев? (строки нет — значит, ещё предстоит) */
function isSeedingPeer(db, peer) {
  try {
    const row = db.prepare('SELECT last_ok, seed_floor FROM sync_peers WHERE node = ?').get(peer);
    return !row || row.last_ok == null || row.seed_floor != null;
  } catch { return false; }
}

/**
 * Сколько страниц засева примерно осталось. Считается по числу строк в самих
 * таблицах — тех же, что читает seedPage, — и делится на размер отданной
 * страницы. Оценка грубая (строки прибавляются по ходу), поэтому и «~».
 *
 * СПИСОК ТАБЛИЦ БЕРЁТСЯ ИЗ SHIPPED (journal.js), А НЕ ПЕРЕЧИСЛЯЕТСЯ ЗДЕСЬ.
 * Своя копия списка уже разошлась однажды: Фаза 3 отправила в путь invoices,
 * invoice_items и payments, а здесь остались прежние четыре таблицы записей —
 * и строка «Первичная загрузка: страница 9 из ~4» на экране синхронизации
 * обещала конец раньше, чем он наступал. Пересчитать деньги было некому:
 * список знает journal.js, а не этот файл. Теперь добавленная там таблица
 * попадает в оценку сама.
 */
export function seedPagesEstimate(db, pageRows) {
  if (!pageRows) return 0;
  try {
    // Имена таблиц — из константы модуля, не из запроса: подставлять их в SQL
    // текстом здесь безопасно, а COUNT по каждой берётся тем же условием
    // uid IS NOT NULL, каким их читает seedPage.
    const counts = Object.keys(SHIPPED)
      .map((t) => `(SELECT COUNT(*) FROM ${t} WHERE uid IS NOT NULL)`)
      .concat('(SELECT COUNT(*) FROM sync_tombstones)')   // вторая фаза засева
      .join(' + ');
    const n = db.prepare(`SELECT ${counts} AS n`).get().n;
    return Math.max(1, Math.ceil(n / pageRows));
  } catch { return 0; }
}

/** Буква ЭТОГО узла. Нет служебной записи — нет и обмена: подписаться нечем. */
function selfLetter(db) {
  try {
    const letter = readIdentity(db).letter;
    return letter ? String(letter).trim().toUpperCase() : null;
  } catch (e) {
    console.warn('[branch-sync] this install does not know which branch it is:', e && e.message);
    return null;
  }
}

/**
 * Общие для обеих функций проверки: пара, согласие владельца, ключ группы,
 * учётка. Одним местом, потому что разъехавшись, выгрузка и загрузка отвечали
 * бы разными причинами на одно и то же состояние установки.
 *
 * @returns {{ok:true, pairing:object, self:string, token:string}|{ok:false, reason:string}}
 */
function journalContext(db, dataDir, self) {
  const pairing = readPairing(dataDir);
  // Установка вне группы журналами не обменивается: соседей нет по построению.
  if (!pairing) return { ok: false, reason: 'relay_no_pairing' };
  if (!relayEnabled(pairing)) return { ok: false, reason: 'relay_disabled' };

  const me = (self ? String(self).trim().toUpperCase() : '') || selfLetter(db);
  if (!me) return { ok: false, reason: 'relay_no_identity' };
  // Ключ группы — он же адрес: без него канала нет вовсе (установка, связанная
  // ключом до Маршрута Б). Маршрут А при этом работает — это не поломка.
  if (!relayIdFor(pairing.group_key, me)) return { ok: false, reason: 'relay_no_key' };

  const token = relayCredential(db, dataDir, pairing);
  if (!token) {
    // Те же два разных лекарства, что у справочника: главной клинике —
    // «проверьте активацию», филиалу — «возьмите новый ключ подключения».
    return { ok: false, reason: pairing.role === 'main' ? 'relay_not_enrolled' : 'relay_branch_no_token' };
  }
  return { ok: true, pairing, self: me, token };
}

/** 401/403 — разный совет у главной клиники и у филиала (см. fetchCatalogue). */
const unauthorizedReason = (pairing) => (pairing.role === 'main' ? 'relay_unauthorized' : 'relay_branch_revoked');

/**
 * ЧТО ЗНАЧИТ ЗДЕСЬ «ОТДАНО СОСЕДУ» — И ЧЕГО ЭТО НЕ ЗНАЧИТ (Задача 7b).
 *
 * У Маршрута А (филиал отдаёт порцию прямо соседу по HTTP) ответ 2xx означает
 * «сосед ПРИНЯЛ И ПРИМЕНИЛ». У релея 2xx означает только «блоб лежит на
 * сервере»: блоб ОДИН на узел и ЗАМЕЩАЕТСЯ следующей выгрузкой. Узел,
 * выключенный на ночь, чужую вечернюю выгрузку не увидит вовсе — а раньше
 * отправитель по этому 2xx уже сдвигал единственную отметку и второй раз
 * содержимое не слал. Так терялись вечерние анализы филиала, молча.
 *
 * ТЕПЕРЬ СОБЫТИЙ ДВА, и у каждого своя отметка в sync_peers (шапка
 * markPublished в journal.js — там же, почему одной не хватает):
 *
 *   1. ВЫЛОЖЕНО (2xx) → `markPublished` двигает pub_seq. Он снимает защиту
 *      местной неотправленной правки: наше авторство теперь видно соседу.
 *   2. ПОДТВЕРЖДЕНО → `markConfirmed` двигает sent_seq. Двигает его только
 *      КВИТАНЦИЯ соседа, а по sent_seq собирается срез и чистится журнал.
 *
 * КВИТАНЦИЯ ЕДЕТ В БЛОБЕ, отдельного канала не заводится: у каждого узла и
 * так есть свой адрес и своя выгрузка раз в час.
 *
 *   { v: 1, from: 'B', generated_at: '…',
 *     acks: { A: 4120, C: 3970 },              // докуда B применил ИХ журналы
 *     batches: { A: {records, upto, seed?}, C: {…} } }
 *
 * `upto` — номер журнала отправителя, до которого доходит срез; сосед,
 * применив его, кладёт это число в свой `acks[отправитель]`. Пока число не
 * вернулось, срез собирается ОТ ТОГО ЖЕ sent_seq и повторяется в каждом
 * следующем блобе — вот и вся починка. Оба узла выкладываются и забирают раз
 * в час, поэтому подтверждение отстаёт на один такт, не больше.
 *
 * ЧТО НЕ ЗАКРЫТО. Курсор ХОЛОДНОГО ЗАСЕВА по-прежнему двигается по выгрузке:
 * все его страницы несут один и тот же upto (замороженный пол журнала), и по
 * квитанции их не различить. Пропущенная страница засева повторена не будет.
 * Это окно первого знакомства с соседом, а не ежедневная работа, и закрывать
 * его надо отдельным номером страницы в квитанции — отдельной задачей.
 */

/**
 * Выложить свой журнал на сервер поставщика — ОДИН блоб со срезами для всех
 * соседей. Сторона ЛЮБОГО узла.
 *
 * НИКОГДА не бросает. `markSent` вызывается ТОЛЬКО после ответа 2xx и отдельно
 * на каждого соседа: не долетевшая до сервера порция обязана уехать снова, а
 * сдвинутая заранее отметка это запретила бы навсегда.
 *
 * ПУСТОЙ СРЕЗ ТОЖЕ ОТМЕЧАЕТСЯ, и это не мелочь. Соседу, которому нечего слать,
 * ничего и не кладётся в блоб, но отметка ему нужна: без неё узел, у которого
 * на момент первой выгрузки не было ни строки, остаётся для соседа ХОЛОДНЫМ
 * навсегда, и первая же его правка уезжает не правкой, а ЗАСЕВОМ — снимком
 * всей строки под авторством '*', затирающим у соседа его собственные колонки.
 * Поймано сквозным тестом: адрес, исправленный в C, возвращался туда пустым.
 *
 * РАЗМЕР. Блоб больше предела не режется по строкам — уменьшается СТРАНИЦА
 * (limit), и порция собирается заново, вдвое меньше, до MIN_JOURNAL_LIMIT.
 * Холодный засев большой клиники так и доезжает: страницами, по одной за
 * выгрузку, то есть за несколько часовых прогонов. Это осознанная цена —
 * альтернативой был бы блоб на десятки мегабайт, который узкий канал филиала
 * не вытянет ни разу.
 *
 * ПОВОД ВЫГРУЗИТЬ. Отпечаток содержимого, как у справочника, здесь не нужен:
 * журнал сам знает, что нового, — buildBatch отдаёт только то, что выше
 * sent_seq. Непустая порция = новое содержимое. Пустая — выгружаем всё равно,
 * но не чаще REFRESH_MS: поставщик сметает блобы, к которым не обращались
 * (удержание), и группа, работающая раз в полгода, не должна однажды
 * обнаружить, что её адреса больше нет.
 *
 * reason: relay_no_pairing | relay_disabled | relay_no_identity | relay_no_key |
 *   relay_not_enrolled | relay_branch_no_token | relay_no_peers | relay_offline |
 *   relay_unauthorized | relay_branch_revoked | relay_too_large | relay_server_error
 *
 * peers — сколько строк уехало КАЖДОМУ соседу; rows — сколько их было РАЗНЫХ
 * (одна карта пациента едет в том же блобе всем сразу, и сумма по соседям
 * говорит не «сколько записей отправлено», а «сколько раз»).
 *
 * @returns {Promise<{ok:true, at:string, bytes:number, peers:object, rows:number}
 *   |{ok:true, skipped:true, peers:object, rows:number}|{ok:false, reason:string}>}
 */
export async function publishJournal(db, dataDir, {
  fetchImpl = globalThis.fetch,
  timeoutMs = UPLOAD_TIMEOUT_MS,
  maxBlobBytes = MAX_BLOB_BYTES,
  env = process.env,
  now = () => new Date(),
  limit = null,
  self = null,
} = {}) {
  const ctx = journalContext(db, dataDir, self);
  if (!ctx.ok) return ctx;

  const peers = journalPeers(db, ctx.self);
  // Одиночная клиника и клиника, где филиалы ещё не заведены: выкладывать
  // некому. Это не отказ канала, поэтому вызывающий такую причину не показывает.
  if (!peers.length) return { ok: false, reason: 'relay_no_peers' };

  // КВИТАНЦИИ (Задача 7b) считаются ДО срезов и не зависят от них: узел,
  // которому сегодня нечего сказать, обязан всё равно отчитаться о том, что
  // принял, — иначе сосед будет вечно повторять уже полученное, а его журнал
  // никогда не вычистится.
  const acks = journalAcks(db);

  // ЯВНО ЗАДАННЫЙ РАЗМЕР СТРАНИЦЫ УВАЖАЕТСЯ (ревью 7/7b, I3). Раньше здесь
  // стоял Math.max(MIN_JOURNAL_LIMIT, …), и вызов с limit: 2 молча превращался
  // в 5000: сквозной тест «засев страницами» отдавал всё ОДНОЙ выгрузкой и
  // ничего постраничного не проверял. MIN_JOURNAL_LIMIT — это дно ДЕЛЕНИЯ
  // пополам при слишком большом блобе, а не запрет на маленькую страницу.
  // Явно заданный размер страницы уважается КАК ЕСТЬ — и множитель засева к
  // нему тоже не применяется: вызывающий, попросивший две строки, просит две.
  const explicitLimit = limit != null;
  const requested = Math.max(1, Math.floor(Number(limit) || JOURNAL_LIMIT));
  const smallest = Math.min(MIN_JOURNAL_LIMIT, requested);
  let page = requested;
  let built;
  let carrying;
  let sealed;
  for (;;) {
    built = [];
    carrying = 0;
    const batches = {};
    for (const peer of peers) {
      let batch;
      try {
        // Засеваемому соседу — крупная страница; делится пополам она вместе с
        // обычной, поэтому предел блоба остаётся главным.
        const seedingPeer = !explicitLimit && isSeedingPeer(db, peer);
        const peerLimit = seedingPeer ? Math.max(1, Math.round(page * (SEED_LIMIT / JOURNAL_LIMIT))) : page;
        batch = buildBatch(db, { self: ctx.self, peer, limit: peerLimit });
      } catch (e) {
        // Один негодный сосед не отменяет выгрузку остальным: его срез просто
        // не поедет, и это видно в журнале сервера.
        console.warn('[branch-sync] could not build the journal batch for', peer, ':', e && e.message);
        continue;
      }
      built.push({ peer, batch });
      if (!batch.records.length) continue;   // пустой срез в блоб не кладётся
      carrying++;
      // seed — пометка страницы ХОЛОДНОГО ЗАСЕВА. Приёмнику она нужна, чтобы
      // не отсечь страницу как «уже применённую»: у ВСЕХ страниц засева upto
      // один и тот же — замороженный пол журнала (см. buildBatch).
      batches[peer] = batch.seed
        ? {
          records: batch.records, upto: batch.upto, seed: true, seed_page: batch.seed.page,
          // Сколько всего страниц примерно будет. Нужно ТОЛЬКО для экрана
          // филиала: «страница 3 из ~12» — это ожидание, а «идёт загрузка» без
          // числа неотличимо от «зависло».
          seed_pages: seedPagesEstimate(db, batch.records.length),
        }
        : { records: batch.records, upto: batch.upto };
    }
    // generated_at — как у справочника: возраст копии виден получателю.
    sealed = sealPayload(ctx.pairing.group_key, {
      v: 1, from: ctx.self, generated_at: now().toISOString(), acks, batches,
    });
    if (!sealed) return { ok: false, reason: 'relay_no_key' };
    if (sealed.length <= maxBlobBytes) break;
    if (page <= smallest) return { ok: false, reason: 'relay_too_large' };
    page = Math.max(smallest, Math.floor(page / 2));
  }

  if (!carrying) {
    const last = readLastJournal(db);
    const at = last && last.at ? Date.parse(last.at) : NaN;
    // Свежая копия и нечего сказать — молчим. Иначе выгружаем пустой блоб:
    // это и есть keep-alive против удержания на той стороне.
    //
    // НОВАЯ КВИТАНЦИЯ — ЕСТЬ ЧТО СКАЗАТЬ (Задача 7b), даже когда своих записей
    // нет. Промолчав, мы оставили бы соседа без подтверждения на сутки
    // (REFRESH_MS): он всё это время повторял бы нам уже применённое и не мог
    // бы вычистить свой журнал. Сравнение — с квитанциями ПОСЛЕДНЕЙ выгрузки,
    // а не с датой: изменились они или нет, видно только так.
    if (Number.isFinite(at) && (now().getTime() - at) < REFRESH_MS && sameAcks(last && last.acks, acks)) {
      return { ok: true, skipped: true, peers: {}, rows: 0 };
    }
  }

  assertControlUrlIsTestSafe(env, fetchImpl);   // PROD_GUARD_V1
  // BRANCH_SELF_TOKEN_V1 — ИМЕННО ЗДЕСЬ ЖИЛА ПОЛОМКА: адрес узла (relayIdFor с
  // буквой) в область старой учётки не входит, и 401 приходил на КАЖДУЮ
  // выгрузку журнала. Филиал берёт себе новую учётку и повторяет запрос ОДИН
  // раз; не вышло — прежняя причина и прежняя фраза на экране.
  const heal = selfHealToken(db, dataDir, ctx.pairing, { fetchImpl, env, now });
  let token = ctx.token;
  let res;
  for (;;) {
    try {
      res = await fetchImpl(relayUrl(relayIdFor(ctx.pairing.group_key, ctx.self), env), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
        body: sealed,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Офлайновая клиника — норма, а не поломка: порция уедет в следующий раз,
      // и уедет ЦЕЛИКОМ, потому что markSent ниже не выполнился.
      return { ok: false, reason: 'relay_offline' };
    }
    if (res.ok || (res.status !== 401 && res.status !== 403)) break;
    const fresh = await heal();
    if (!fresh || fresh === token) break;
    token = fresh;
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, reason: unauthorizedReason(ctx.pairing) };
    if (res.status === 413) return { ok: false, reason: 'relay_too_large' };
    return { ok: false, reason: 'relay_server_error' };
  }

  // ТОЛЬКО ТЕПЕРЬ, и только ВЫЛОЖЕНО. markPublished двигает pub_seq (снимает
  // защиту местной правки) и курсор засева; sent_seq, по которому собирается
  // срез и чистится журнал, ждёт КВИТАНЦИИ соседа — её приносит fetchJournals.
  // Смысл этого разделения — в абзаце над функцией. Каждому соседу своя
  // отметка: срезы лежат в одном блобе, но горизонты у каждого свои, и общая
  // отметка потеряла бы разницу.
  //
  // МЕТКИ РАЗНЫХ СРЕЗОВ. buildBatch читает часы из базы и НЕ пишет их, поэтому
  // порции всем соседям чеканятся от ОДНОГО состояния часов: одна и та же
  // строка может уехать к A с меткой …-0003, а к C с …-0004. Значения при этом
  // одинаковы (снимок один), расходится только счётчик внутри миллисекунды, и
  // дальше он никуда не распространяется — принятая запись в журнал не
  // возвращается (applyBatch чистит свой хвост). Приближение названо здесь, а
  // не спрятано: точное решение — писать часы между срезами, но тогда сосед,
  // оказавшийся вторым в списке, получал бы метки НОВЕЕ первого без всякой на
  // то причины.

  // СКОЛЬКО СТРОК УЕХАЛО НА САМОМ ДЕЛЕ — не сумма по соседям (BRANCH_MAIN_PUSH_V1,
  // ревью). Блоб один, и одна и та же карта пациента едет в нём КАЖДОМУ соседу:
  // сложив срезы, экран показывал бы «отправлено 36» там, где клиника завела 12
  // строк, — и рядом честное «получено 5». Считаем РАЗНЫЕ строки (таблица+uid);
  // сумму по соседям по-прежнему видно поимённо в peers.
  const rows = new Set();
  for (const { batch } of built) {
    for (const r of batch.records) rows.add(r.tbl + ' ' + r.uid);
  }

  const applied = {};
  for (const { peer, batch } of built) {
    try {
      markPublished(db, peer, batch.upto, batch.clock, batch.seed);
      if (batch.records.length) applied[peer] = batch.records.length;
    } catch (e) {
      // Порция доставлена, отметка не сдвинулась: сосед получит её ещё раз.
      // Повтор безвреден (приём идемпотентен), молчание — нет.
      console.warn('[branch-sync] journal delivered but not marked published for', peer, ':', e && e.message);
    }
  }

  const at = now().toISOString();
  try { putState(db, LAST_JOURNAL_KEY, JSON.stringify({ at, bytes: sealed.length, peers: applied, acks })); }
  catch (e) {
    // Худшее следствие — лишняя выгрузка через час. Ради него уже
    // состоявшуюся выгрузку неудачной не объявляют.
    console.warn('[branch-sync] could not record the journal publish:', e && e.message);
  }
  return { ok: true, at, bytes: sealed.length, peers: applied, rows: rows.size };
}

/**
 * Форма приехавшего журнала. Проверяется так же придирчиво, как у справочника,
 * и по той же причине: тег GCM доказал происхождение блоба, но не его смысл —
 * блоб мог остаться от прошлой версии, от другой группы или от сбоя сборки.
 *
 * @returns {{records:Array, upto:number, seed:boolean, ack:number}|null}
 *   records [] — среза нет (норма); null — форма не та. ack — КВИТАНЦИЯ
 *   соседа: докуда он применил НАШ журнал (Задача 7b).
 */
function journalSlice(payload, peer, self) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.v !== 1) return null;
  // from — подпись отправителя ВНУТРИ блоба. Не сойдясь с адресом, по которому
  // мы его взяли, она означает перепутанный адрес или чужую выгрузку; применять
  // такое нельзя: origin решает, чью защиту снимать при слиянии.
  if (typeof payload.from !== 'string' || payload.from.trim().toUpperCase() !== peer) return null;
  const batches = payload.batches;
  if (!batches || typeof batches !== 'object' || Array.isArray(batches)) return null;
  // Квитанция читается ОТДЕЛЬНО от среза и раньше него: сосед, которому
  // сегодня нечего нам слать, всё равно обязан отчитаться о полученном, и
  // пустой блоб с одной квитанцией — совершенно нормальный блоб.
  const acks = payload.acks;
  const mine = acks && typeof acks === 'object' && !Array.isArray(acks) ? acks[self] : null;
  // ЧИСЛО — квитанция соседа сборки до страниц засева: в ней есть только
  // «докуда по журналу». Объект — нынешняя форма. Принимаются обе: узлы в
  // сети обновляются не одновременно.
  const ackUpto = Number(mine && typeof mine === 'object' ? mine.upto : mine);
  const ackPage = Number(mine && typeof mine === 'object' ? mine.seed_page : 0);
  const head = {
    upto: 0, seed: false, seedPage: 0, seedPages: 0,
    ack: Number.isFinite(ackUpto) && ackUpto > 0 ? Math.floor(ackUpto) : 0,
    ackPage: Number.isFinite(ackPage) && ackPage > 0 ? Math.floor(ackPage) : 0,
  };

  const slice = batches[self];
  if (slice === undefined || slice === null) return { ...head, records: [] };
  // Массив — форма ДО Задачи 7b (сборка без заголовка среза), объект
  // {records, upto, seed} — та, что кладёт publishJournal. Принимаются обе:
  // узлы в сети обновляются не одновременно, и срез без upto просто
  // применяется без проверки на повтор — ровно как применялся раньше.
  if (Array.isArray(slice)) return { ...head, records: slice };
  if (typeof slice === 'object' && Array.isArray(slice.records)) {
    const upto = Number(slice.upto);
    const seedPage = Number(slice.seed_page);
    return {
      ...head,
      records: slice.records,
      upto: Number.isFinite(upto) && upto > 0 ? Math.floor(upto) : 0,
      seed: slice.seed === true,
      seedPage: Number.isFinite(seedPage) && seedPage > 0 ? Math.floor(seedPage) : 0,
      seedPages: Number.isFinite(Number(slice.seed_pages)) && Number(slice.seed_pages) > 0
        ? Math.floor(Number(slice.seed_pages)) : 0,
    };
  }
  return null;
}

/**
 * «Ничего делать не пришлось» в той же форме, что и статистика приёма: у
 * читающего ответ не должно быть двух разных фигур для одного «ноль работы».
 * already — срез уже был применён (неподтверждённый повтор соседа).
 */
const noWork = (skipped = 0, already = false) => {
  const stats = { applied: 0, released: 0, skipped, deferred: 0, deleted: 0, refused: 0 };
  return already ? { ...stats, already: true } : stats;
};

/**
 * Скачать и распечатать журнал ОДНОГО соседа. Ничего не пишет в базу.
 *
 * BRANCH_SELF_TOKEN_V1 — `auth` общий на весь обмен и `heal` тоже: учётка
 * берётся ОДИН раз на прогон, а не на каждого соседа (иначе сеть из пяти
 * зданий выписывала бы пять штук за один часовой такт), и починившись на
 * первом соседе, мы несём новую учётку всем следующим.
 */
async function downloadJournal(ctx, peer, { fetchImpl, timeoutMs, maxBlobBytes, env, auth, heal }) {
  const relayId = relayIdFor(ctx.pairing.group_key, peer);
  if (!relayId) return { ok: false, reason: 'relay_no_key' };

  assertControlUrlIsTestSafe(env, fetchImpl);   // PROD_GUARD_V1
  let res;
  for (;;) {
    try {
      res = await fetchImpl(relayUrl(relayId, env), {
        method: 'GET',
        headers: { Authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: 'relay_offline' };
    }
    if (res.ok || (res.status !== 401 && res.status !== 403)) break;
    const fresh = await heal();
    if (!fresh || fresh === auth.token) break;
    auth.token = fresh;
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, reason: unauthorizedReason(ctx.pairing) };
    // САМЫЙ ОБЫЧНЫЙ СЛУЧАЙ, и он не ошибка: сосед ещё ни разу не выгружался
    // (только что заведён, выключен, без интернета). Остальные соседи от этого
    // не страдают — потому эта причина и возвращается ПО СОСЕДУ, а не на обмен.
    if (res.status === 404) return { ok: false, reason: 'relay_empty' };
    return { ok: false, reason: 'relay_server_error' };
  }

  const bytes = await readBoundedBytes(res, maxBlobBytes).catch(() => null);
  if (bytes === null) return { ok: false, reason: 'relay_too_large' };
  if (!bytes.length) return { ok: false, reason: 'relay_empty' };

  const opened = openPayload(ctx.pairing.group_key, bytes);
  if (!opened.ok) {
    return { ok: false, reason: opened.reason === 'bad_key' ? 'relay_bad_key' : 'relay_bad_response' };
  }
  const slice = journalSlice(opened.payload, peer, ctx.self);
  if (slice === null) return { ok: false, reason: 'relay_bad_response' };
  return { ok: true, ...slice };
}

/**
 * Забрать журналы соседей и применить их. Сторона ЛЮБОГО узла.
 *
 * НИКОГДА не бросает и НИКОГДА не отменяет обмен целиком из-за одного соседа:
 * ответ — таблица «сосед → что вышло». Молчащий сосед (`relay_empty`) не мешает
 * остальным, и это главное свойство этой функции: сеть из пяти зданий, где
 * одно выключено, обязана продолжать работать вчетвером.
 *
 * РЕЗЕРВНАЯ КОПИЯ — ровно как у справочника, но ТОЛЬКО когда есть что
 * применять: снимать копию базы на каждый пустой часовой прогон значило бы
 * заваливать диск клиники копиями ради ничего. Снимается ОДИН раз на обмен,
 * перед первым применением; не удалось — не применяем ничего.
 *
 * @returns {Promise<{ok:true, peers:object}|{ok:false, reason:string, peers:object}>}
 */
export async function fetchJournals(db, dataDir, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  maxBlobBytes = MAX_BLOB_BYTES,
  env = process.env,
  now = () => new Date(),
  self = null,
  peers = null,
  applyImpl = applyBatch,
  backupImpl = createBackup,
} = {}) {
  const ctx = journalContext(db, dataDir, self);
  if (!ctx.ok) return { ...ctx, peers: {} };

  const list = Array.isArray(peers) && peers.length
    ? peers.map((p) => String(p == null ? '' : p).trim().toUpperCase()).filter((p) => p && p !== ctx.self)
    : journalPeers(db, ctx.self);
  if (!list.length) return { ok: false, reason: 'relay_no_peers', peers: {} };

  const out = {};
  let backed = false;
  // Одна учётка и одна попытка починки на ВЕСЬ обмен — см. шапку downloadJournal.
  const auth = { token: ctx.token };
  const heal = selfHealToken(db, dataDir, ctx.pairing, { fetchImpl, env, now });
  for (const peer of list) {
    const got = await downloadJournal(ctx, peer, { fetchImpl, timeoutMs, maxBlobBytes, env, auth, heal });
    if (!got.ok) { out[peer] = { reason: got.reason }; continue; }

    // КВИТАНЦИЯ — ПЕРВЫМ ДЕЛОМ (Задача 7b), до всякого применения и независимо
    // от того, есть ли для нас срез. Она про НАШ журнал, а не про его: сосед
    // сообщает, докуда он нас применил, и только теперь мы вправе перестать
    // это повторять и вычистить свой хвост. Не сложится применение ниже —
    // подтверждение всё равно верно: оно уже случилось у него.
    if (got.ack || got.ackPage) {
      try {
        markConfirmed(db, peer, got.ack, got.ackPage);
      } catch (e) {
        // Худшее следствие — лишний повтор среза через час. Ради него обмен
        // не срывают.
        console.warn('[branch-sync] could not record the receipt from', peer, ':', e && e.message);
      }
    }

    if (!got.records.length) {
      // Блоб есть, среза для нас в нём нет: сосед выгрузился, но нам ничего не
      // адресовал. Это успех с нулём работы, а не отказ.
      out[peer] = noWork();
      continue;
    }
    // НЕПОДТВЕРЖДЁННЫЙ ПОВТОР — не работа (Задача 7b). Сосед повторяет срез в
    // каждом блобе, пока не увидит нашу квитанцию, то есть как минимум один
    // такт всегда. Спросить надо ЗДЕСЬ, до резервной копии: снимать копию базы
    // ради среза, который мы уже разобрали, значит заваливать диск клиники
    // копиями каждый час.
    if (sliceAlreadyApplied(db, { peer, upto: got.upto, seed: got.seed, seedPage: got.seedPage })) {
      out[peer] = noWork(got.records.length, true);
      continue;
    }
    if (!backed) {
      try {
        await backupImpl(db, dataDir, 'safety');
        backed = true;
        // ЧИСТКА СРАЗУ ЗА КОПИЕЙ (ревью 7/7b, I1). Копия снимается на каждый
        // обмен, где есть что применять, — это 10–24 файла в сутки у клиники с
        // тремя филиалами, а на порции, которую база отвергает, и вовсе по
        // копии в час бесконечно. Чистка же по видам вызывалась только при
        // старте и внутри суточной копии, то есть могла не случиться неделями:
        // диск клиники заполнялся молча. KEEP_BY_KIND.safety = 5.
        pruneBackupsByKind(path.join(dataDir, 'backups'));
      } catch (e) {
        // Без копии не применяем — то же правило, что у справочника, и здесь
        // оно весомее: справочник можно привезти заново, чужие записи — нет.
        //
        // И это причина ПО СОСЕДУ, а не конец обмена (ревью 7/7b, M3): раньше
        // здесь стоял break, и остальные соседи молча оставались без ответа
        // вовсе — в таблице «сосед → что вышло» их просто не было, а обмен
        // при этом объявлялся успешным. Место на диске может кончиться, и
        // тогда важно видеть, что не применилось НИЧЕГО, у каждого поимённо.
        console.warn('[branch-sync] refusing to apply records without a backup:', e && e.message);
        out[peer] = { reason: 'backup_failed' };
        continue;
      }
    }
    try {
      // upto/seed — заголовок среза: по ним приём отличает неподтверждённый
      // повтор (применять второй раз незачем) от новой работы и знает, какую
      // квитанцию записать.
      out[peer] = applyImpl(db, got.records, {
        self: ctx.self, peer, upto: got.upto, seed: got.seed, seedPage: got.seedPage,
      });
      if (got.seed) {
        // Первичная загрузка идёт — расписание на этой стороне ускоряется, а
        // экран показывает, на какой мы странице.
        try {
          putState(db, SEEDING_KEY, new Date().toISOString());
          putState(db, SEED_PROGRESS_KEY, JSON.stringify({
            from: peer, page: got.seedPage, pages: got.seedPages, at: new Date().toISOString(),
          }));
        } catch (e) {
          console.warn('[branch-sync] could not record the seeding progress:', e && e.message);
        }
      }
    } catch (e) {
      // Транзакция приёма откатилась целиком (её держит applyBatch) — база
      // ровно такая, какой была, и порция приедет снова.
      console.warn('[branch-sync] could not apply the journal from', peer, ':', e && e.message);
      out[peer] = { reason: 'records_failed' };
    }
  }
  return { ok: true, peers: out };
}

/**
 * Обмен целиком: выложить своё, забрать чужое. Порядок важен — сначала
 * выгрузка: сосед, который синхронизируется через минуту, должен увидеть уже
 * сегодняшнее состояние, а не вчерашнее.
 */
// ОДИН ЗАМОК НА ОБА ВХОДА (ревью M5). Обмен запускают двое: часы и кнопка
// «Синхронизация» в окне регистратуры. Раньше у каждого был свой флаг, и они
// друг друга не видели — при том, что комментарий уверял в обратном. Два
// параллельных обмена — это две резервные копии, две выгрузки одного блоба и
// две транзакции приёма, спорящие за одну базу. Замок общий и живёт здесь,
// потому что здесь сам обмен; rpc/branch-sync.js берёт его же.
//
// ОЧЕРЕДЬ, А НЕ СКЛЕЙКА (ревью BRANCH_MAIN_PUSH_V1, 2026-09-03). Раньше
// опоздавший получал ОБЕЩАНИЕ ТОГО, кто уже в полёте, — и это тихо ломало
// кнопку главной клиники. Часовой такт на главной держит замок вокруг
// exchangeJournals, а тот отвечает {published, fetched}: ни ok, ни reason, ни
// message. Владелец, нажавший «Синхронизация» в эту секунду, не выкладывал
// копию справочника вовсе (publishCatalogue не звался), не получал записи
// своего прогона, ответ приходил чужой формы — и экран честно читал его как
// неудачу: «Не удалось синхронизировать». То есть ровно тот отказ, ради
// устранения которого правку и делали, возвращался раз в час на минуту.
//
// Теперь опоздавший ВСТАЁТ В ОЧЕРЕДЬ: дожидается идущей работы и выполняет
// СВОЮ целиком, со своим результатом. Смысл замка от этого не меняется — две
// работы по-прежнему никогда не идут одновременно, — а обещание каждый
// получает своё. Цена: два нажатия подряд теперь и правда два прогона, а не
// один; это честнее, чем показать второму нажавшему чужой ответ (та же
// причина, по которой здесь никогда не было «подождите, уже идёт»).
let exchangeTail = null;

/**
 * Пропустить работу через общий замок: если обмен уже идёт, наша работа
 * начнётся сразу после него.
 *
 * @param {() => (Promise<any>|any)} work
 * @returns {Promise<any>} результат ИМЕННО ЭТОЙ работы, а не соседней.
 */
export function withExchangeLock(work) {
  const prev = exchangeTail;
  // Чужая неудача не отменяет нашу работу: замок стоит в очередь по ЗАВЕРШЕНИЮ
  // предыдущей, каким бы оно ни было (оба обработчика — один и тот же work).
  const mine = prev ? prev.then(work, work) : Promise.resolve().then(work);
  // Хвост очереди отказов не помнит — иначе первая же неудача осталась бы
  // непойманным отказом и роняла бы сервер клиники.
  const tail = mine.then(() => {}, () => {});
  exchangeTail = tail;
  tail.then(() => { if (exchangeTail === tail) exchangeTail = null; });
  return mine;
}

export async function exchangeJournals(db, dataDir, opts = {}) {
  return {
    published: await publishJournal(db, dataDir, opts),
    fetched: await fetchJournals(db, dataDir, opts),
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
// выбор между «токен без нескольких дальних соседей» и «токена нет» очевиден.
// Экспортируется РАДИ ТЕСТА ДРЕЙФА (relay-e2e.test.js — единственный файл,
// который видит обе половины сразу): разъехавшись, эти два числа дадут либо 400
// на всю сеть, либо молча оброненных соседей.
export const MAX_SCOPE = 64;

// Буквы узлов, которые токен получает АВАНСОМ, не спрашивая, заведены ли они.
// A..Z — те самые буквы, которые letters.js раздаёт первым 26 филиалам, то есть
// всем существующим сетям и всем обозримым.
const ALPHABET = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

/**
 * Адреса, которые токен филиала должен уметь трогать.
 *
 * Справочник (адрес группы) — ПЕРВЫМ и всегда: с него начинается любая
 * синхронизация, и сервер кладёт первый адрес в relay_tokens.relay_id.
 *
 * ДАЛЬШЕ — ВЕСЬ АЛФАВИТ СРАЗУ, а не только заведённые сегодня буквы, и это
 * главное решение этой функции. Область считается ОДИН РАЗ, в момент выписки
 * (rpc/branch-sync.js ensureBranchToken выписывает, только если токена ещё нет),
 * а ключ подключения потом собирается из СОХРАНЁННОГО токена (branchKeyFor).
 * Перевыписки не происходит нигде, кроме перевыпуска ключа группы. Значит,
 * область по «сегодняшним» буквам означала бы: филиал B, получивший ключ, когда
 * в сети были A и B, НИКОГДА не получит права на адрес филиала C, заведённого
 * через месяц. Его чтение журнала C — 401 → «доступ отозван» → «возьмите новый
 * ключ», а новый ключ несёт тот же токен и не чинит ничего. Владелец при этом
 * не сделал ничего неправильного: он просто завёл третий филиал.
 *
 * Почему это ничего не стоит: адрес — HMAC от ключа группы (relay-crypto.js), и
 * право на адрес, по которому никто ничего не выкладывал, не даёт НИЧЕГО. Все 27
 * прав вместе — по-прежнему один токен из 64 на клинику и одна строка на адрес.
 * Альтернатива — механизм дозаписи прав в уже выписанный токен — это новая ручка
 * у поставщика, новое состояние и новый порядок событий, который можно нарушить.
 *
 * `letters` теперь только ДОПОЛНЯЕТ алфавит — сузить область они не могут. Нужны
 * они для сетей больше 26 зданий: letters.js раздаёт буквы по-табличному
 * (A..Z, AA..AZ, BA..), и 'AA' алфавитом не покрыт.
 *
 * Мусор в буквах не отказ, а пропуск. Буквы приходят из таблицы branches, куда
 * пишет не только этот код: NULL там обычен (rpc/branch-sync.js фильтрует их
 * запросом, но эта функция экспортируемому контракту не хозяйка), а собственная
 * буква клиники приезжает дважды. Повтор адреса на той стороне — нарушение
 * первичного ключа, то есть 500 вместо выписки; отказ из-за пустой строки —
 * филиал без резервного канала. Ни то ни другое не стоит одной кривой строки в
 * списке филиалов.
 */
function relayScope(groupKey, catalogueId, letters) {
  const ids = [catalogueId];
  // Алфавит идёт ПЕРЕД переданными буквами, поэтому обрезка по потолку режет
  // хвост из многобуквенных узлов, а не то, чем пользуется каждая живая сеть.
  for (const raw of [...ALPHABET, ...(Array.isArray(letters) ? letters : [])]) {
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

  return requestRelayToken({ token, relayId, relayIds, fetchImpl, timeoutMs, env });
}

/**
 * САМ ПОХОД ЗА УЧЁТКОЙ: один POST и перевод ответа в закрытый словарь причин.
 *
 * Вынесен из mintRelayToken, когда за учёткой пошёл ещё и сам филиал
 * (ensureOwnRelayToken ниже). Общая функция здесь обязательна, а не удобна:
 * разъехавшись, две половины отправляли бы РАЗНЫЕ тела на один маршрут — а тело
 * тут несёт совместимость со старой панелью поставщика (оба поля), и вторая
 * копия однажды осталась бы без одного из них.
 *
 * НИКОГДА не бросает; кто предъявляется и на какие адреса — решает вызывающий.
 */
async function requestRelayToken({ token, relayId, relayIds, fetchImpl, timeoutMs, env }) {
  assertControlUrlIsTestSafe(env, fetchImpl);   // PROD_GUARD_V1
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
 * BRANCH_SELF_TOKEN_V1 — ФИЛИАЛ ВЫПИСЫВАЕТ УЧЁТКУ РЕЗЕРВНОГО КАНАЛА СЕБЕ САМ.
 *
 * Зачем это вообще возможно и что меняет в отзыве — в шапке OWN_TOKEN_KEY.
 * Коротко: филиал предъявляет СВОЙ install_token (у активированного филиала он
 * есть — c-…-bN), а просит адреса, которые и так выводит из своего ключа
 * группы, поэтому нового доступа не получает.
 *
 * ОБЛАСТЬ — ТА ЖЕ, что просит главная клиника: справочник плюс весь алфавит
 * узлов (relayScope). Ровно та же функция, а не своя копия: филиал, выписавший
 * себе область уже, чем чужая, снова упёрся бы в 401 на соседе, заведённом
 * завтра, — то есть починил бы сегодняшний день и сломал следующий.
 *
 * НЕ ЧАЩЕ РАЗА В ЧАС и никогда не бросает. Отметка ставится на КАЖДУЮ попытку,
 * удачную и нет: удачная и так закрывает вопрос сохранённой учёткой, а
 * неудачная не должна повторяться каждым часовым прогоном — у поставщика
 * потолок 64 живых учётки на клинику.
 *
 * @param {boolean} [options.force] обойти часовой предохранитель — только для
 *   ДЕЙСТВИЯ ЧЕЛОВЕКА (связывание ключом), где ждать час бессмысленно.
 * @returns {Promise<{ok:true, token:string, relay_id:string, relay_ids:string[]}
 *   |{ok:false, reason:string}>}
 */
export async function ensureOwnRelayToken(db, dataDir, {
  fetchImpl = globalThis.fetch,
  timeoutMs = MINT_TIMEOUT_MS,
  env = process.env,
  now = () => new Date(),
  retryMs = OWN_TOKEN_RETRY_MS,
  force = false,
} = {}) {
  if (!db) return { ok: false, reason: 'relay_no_db' };
  const pairing = readPairing(dataDir);
  // ТОЛЬКО ВТОРИЧНЫЙ ФИЛИАЛ. Главная клиника предъявляет install_token и на
  // релее, и на check-in-е; выписывать ей учётку означало бы завести ей вторую
  // личность ради задачи, которой у неё нет.
  if (!pairing || pairing.role !== 'secondary') return { ok: false, reason: 'relay_not_secondary' };

  const relayId = relayIdFor(pairing.group_key);
  if (!relayId) return { ok: false, reason: 'relay_no_key' };
  const relayIds = relayScope(pairing.group_key, relayId, groupLetters(db));

  // Установка, связанная ключом, но НИКОГДА не активированная — тот самый
  // филиал, которому ключ привезли руками. Предъявить поставщику нечего, поход
  // кончился бы 401 и только задержал бы ответ на экране. Проверка ДО
  // предохранителя и до сети: это не «сегодня не вышло», а «нечем».
  const token = installToken(dataDir);
  if (!token) return { ok: false, reason: 'relay_not_enrolled' };

  const at = now();
  if (!force) {
    const last = Date.parse(getState(db, OWN_TOKEN_TRY_KEY) || '');
    if (Number.isFinite(last) && at.getTime() - last < retryMs) {
      return { ok: false, reason: 'relay_mint_throttled' };
    }
  }
  // ОТМЕТКА ДО ПОХОДА, а не после: упавший на середине запрос — ровно тот
  // случай, ради которого предохранитель и стоит.
  try { putState(db, OWN_TOKEN_TRY_KEY, at.toISOString()); }
  catch (e) { console.warn('[branch-sync] could not record the relay-token attempt:', e && e.message); }

  const r = await requestRelayToken({ token, relayId, relayIds, fetchImpl, timeoutMs, env });
  if (!r.ok) return r;

  try {
    // Вместе с АДРЕСОМ, на который выписана: перевыпуск ключа группы меняет все
    // адреса, и по этому полю сохранённая учётка становится негодной сама
    // (ownRelayToken), без чистки на стороне того, кто ключ перевыпустил.
    putState(db, OWN_TOKEN_KEY, JSON.stringify({ token: r.token, relay_id: relayId, at: at.toISOString() }));
  } catch (e) {
    // Учётка у поставщика уже выписана и второй раз её не покажут. Записать не
    // вышло — пользуемся ею хотя бы в этом запросе (ради него и шли), а вот
    // молчать нельзя: следующий прогон выпишет ещё одну и съест потолок.
    console.warn('[branch-sync] minted an own relay token and could not store it:', e && e.message);
    return { ...r, stored: false };
  }
  return r;
}

/**
 * Буквы узлов группы для области — best-effort.
 *
 * Тот же запрос, что у главной клиники (rpc/branch-sync.js ensureBranchToken), и
 * та же оговорка: буквы только ДОПОЛНЯЮТ алфавит A..Z и сузить область не
 * могут, поэтому пустой ответ ничего не ломает. Филиал знает соседей из списка
 * сети в справочнике (catalogue.js roster).
 */
function groupLetters(db) {
  try {
    return db.prepare(
      "SELECT letter FROM branches WHERE letter IS NOT NULL AND letter <> '' ORDER BY id"
    ).all().map((row) => row.letter);
  } catch (e) {
    console.warn('[branch-sync] could not list branch letters for the relay scope:', e && e.message);
    return [];
  }
}

/**
 * ОДНА попытка починки на вызов — замыкание, а не флаг в базе.
 *
 * Возвращает функцию, которая ПЕРВЫЙ раз пробует выписать учётку и отдаёт её,
 * а дальше всегда null. Отсюда и невозможность цикла: место вызова повторяет
 * запрос ровно тогда, когда получило непустой ответ, а второго непустого не
 * будет. Второй предохранитель — часовой, в самой выписке — про ПРОГОНЫ, этот
 * про один вызов; нужны оба, и путать их не надо.
 *
 * Главная клиника здесь не чинится никогда (проверка роли внутри выписки), и
 * установка без базы — тоже: сохранить учётку негде.
 */
function selfHealToken(db, dataDir, pairing, opts) {
  let used = false;
  return async () => {
    if (used) return null;
    used = true;
    if (!db || !pairing || pairing.role !== 'secondary') return null;
    let r;
    try {
      r = await ensureOwnRelayToken(db, dataDir, opts);
    } catch (e) {
      // Починка не вправе уронить синхронизацию: без неё было плохо, с
      // исключением станет хуже.
      console.warn('[branch-sync] could not mint an own relay token:', e && e.message);
      return null;
    }
    if (!r.ok) {
      // Не ошибка, а обычный ход событий: офлайн, предохранитель, нет активации.
      // Причина уедет на экран прежняя — та, что была до починки.
      if (r.reason !== 'relay_mint_throttled') {
        console.warn('[branch-sync] the branch could not mint its own relay token:', r.reason);
      }
      return null;
    }
    return r.token;
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
  const run = async () => {
    adoptRelayForExistingBranches(db, dataDir);
    try {
      // ТОТ ЖЕ ЗАМОК, ЧТО У ОБМЕНА ЗАПИСЯМИ (ревью BRANCH_MAIN_PUSH_V1).
      // Выгрузка копии — единственное, что оставалось снаружи: кнопка главной
      // клиники выкладывает справочник ПРИНУДИТЕЛЬНО (publishCatalogue, без
      // сверки хэша), и обе выгрузки могли пойти внахлёст. Кончалось это не
      // ошибкой, а тихой ложью: блоб на сервере ОДИН, побеждает тот, кто
      // дописал последним, а запись о выгрузке (LAST_PUBLISH) остаётся от
      // того, кто закончил позже. Разъехались бы они на одну правку цен —
      // филиалы сутки (REFRESH_MS) забирали бы старую копию, а экран главной
      // показывал бы, что новая отправлена.
      const r = await withExchangeLock(() => maybePublish(db, dataDir, runOpts));
      if (r && r.ok === false && r.reason !== 'relay_disabled' && r.reason !== 'relay_no_key') {
        console.warn('[branch-sync] relay publish did not happen:', r.reason);
      }
    } catch (e) {
      console.warn('[branch-sync] scheduled relay publish failed:', e && e.message);
    }

    // BRANCH_RECORDS_V1 (Задача 7) — обмен ЗАПИСЯМИ на ГЛАВНОЙ клинике, и только на ней.
    //
    // НОВОГО РАСПИСАНИЯ НЕ ЗАВОДИТСЯ (правило владельца: «по запросу и
    // постоянно раз в час»). Филиалы меняются записями внутри часового
    // runBranchSync (schedule-pull.js), но тот часовой прогон включается только
    // у ПОДКЛЮЧЁННОГО филиала (isSecondary): главной клинике справочник
    // забирать не у кого. Без этих двух строк пациент, заведённый в филиале,
    // появлялся бы в главной только после ручного нажатия «Синхронизация».
    //
    // У филиала этот же обмен делает runBranchSync, поэтому здесь проверка
    // роли: два разных таймера, делающих одно и то же, — это лишний трафик
    // и лишний вопрос «почему выгрузка дважды» в журнале сервера.
    try {
      if (readPairing(dataDir)?.role !== 'main') return;
      // ОДИН ОБМЕН ЗА РАЗ (ревью 7/7b, M5). Кнопка «Синхронизация» и часы —
      // это два входа в одну и ту же работу, и раньше они могли пойти
      // одновременно: обмен идёт секунды, а под нагрузкой и минуты. Два
      // параллельных обмена — это две резервные копии, две выгрузки одного
      // блоба и две транзакции приёма, спорящие за одну базу. Кнопка своё
      // совмещение имеет давно (inFlight в rpc/branch-sync.js), расписание —
      // теперь тоже.
      const ex = await withExchangeLock(() => exchangeJournals(db, dataDir, runOpts));
      const pub = ex.published;
      if (pub && pub.ok === false && !QUIET_JOURNAL_REASONS.has(pub.reason)) {
        console.warn('[branch-sync] journal publish did not happen:', pub.reason);
      }
    } catch (e) {
      console.warn('[branch-sync] scheduled journal exchange failed:', e && e.message);
    }
  };
  // Таймер не ждёт обещаний: run свои ошибки ловит сам, но страховка
  // от непойманного отказа стоит одной строки, а уронить может сервер клиники.
  const tick = () => { run().catch((e) => console.warn('[branch-sync] relay tick failed:', e && e.message)); };
  const initial = setTimeout(tick, initialDelayMs);
  initial.unref();
  const interval = setInterval(tick, intervalMs);
  interval.unref();
  // ПОКА ИДЁТ ПЕРВИЧНАЯ ЗАГРУЗКА — чаще (Задача 7e, I-3). Отдельный таймер, а
  // не переменный интервал: он ничего не делает, пока засева нет, и не трогает
  // часовой ритм, на который рассчитано всё остальное. Страница засева стоит
  // трёх тактов (выложили — забрали — подтвердили), поэтому именно такт и надо
  // укорачивать, иначе большая клиника засевает филиал неделями.
  const seedTick = () => {
    if (!seedingNow(db)) return;
    tick();
  };
  const seeding = setInterval(seedTick, SEEDING_INTERVAL_MS);
  seeding.unref();
  return { initial, interval, seeding };
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
  assertControlUrlIsTestSafe(env, fetchImpl);   // PROD_GUARD_V1
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

// BRANCH_REISSUE_V1 — попросить control plane выдать филиалу НОВЫЙ код активации.
//
// ЗАЧЕМ. Код активации филиала одноразовый: погашая его, поставщик стирает код
// и выдаёт установке install_token (control-plane/server/services/enrollment.js).
// Главная клиника же хранит выданный код навсегда (rpc/branch-sync.js,
// branch_sync.enroll.<id>) и вкладывает его в ключ подключения при каждом
// показе. Значит ПЕРЕУСТАНОВЛЕННЫЙ компьютер филиала не активируется НИКОГДА:
// код в ключе сгорел при первой активации, а взять другой главной клинике
// неоткуда. Поймано на тестовом филиале владельца 2026-09-02; обходной путь,
// которым он воспользовался, — активировать ноутбук как ОТДЕЛЬНУЮ клинику —
// оставляет установку с чужой личностью, которая синхронизироваться не может.
//
// ТА ЖЕ АУТЕНТИФИКАЦИЯ, ЧТО У ЗАВЕДЕНИЯ ФИЛИАЛА, и это не совпадение: на той
// стороне обе ручки лежат в одном файле и ходят через одну функцию
// (control-plane/server/routes/branch.js callerByInstallToken). Предъявляется
// install_token ГЛАВНОЙ клиники — единственной машины в группе, у которой есть
// чем доказать поставщику, кто она.
//
// ЦЕНА, КОТОРУЮ ПЛАТИТ СТАРАЯ УСТАНОВКА, названа прямо и вызывающим показана в
// окне подтверждения: перевыпуск гасит install_token прежней установки, и она
// перестаёт проходить check-in. Один филиал — один компьютер; две машины,
// молча делящие одну лицензию и один счёт, были бы хуже.
//
// clinic_id ФИЛИАЛА ЗДЕСЬ НЕ ВЫБИРАЕТСЯ ВОВСЕ: его передаёт вызывающий, и он же
// отвечает за то, чтобы адресат был верным (см. branch_sync.clinic.<id> и
// проверки перевыпуска в rpc/branch-sync.js — у филиалов старого выпуска номер
// ВЫЧИСЛЕН, поэтому там спрашивают владельца и сверяют имя в ответе). Здесь
// остаётся одно правило: пустой идентификатор — отказ, а не попытка.
//
// ОТВЕТ ВОЗВРАЩАЕТСЯ КАК ЕСТЬ, без подстановок запрошенного: сверять его с
// запросом — работа вызывающего, и подменять недостающие поля значило бы
// лишить эту сверку смысла.
//
// НИКОГДА не бросает; reason — тот же закрытый словарь, что у создания филиала,
// плюс reissue_not_found (поставщик такого филиала за этой клиникой не знает).
export async function reissueBranchOnControlPlane(dataDir, {
  clinicId = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = MINT_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const id = typeof clinicId === 'string' ? clinicId.trim() : '';
  // До сети, а не после: запрос без идентификатора — это POST на /reissue без
  // адресата, то есть 404 у поставщика и «филиал не найден» на экране. Правда
  // другая, и лечится она по-другому.
  if (!id) return { ok: false, reason: 'reissue_unknown_branch' };

  const token = installToken(dataDir);
  if (!token) return { ok: false, reason: 'branch_not_enrolled' };

  const base = String((env && env.EASYMED_CONTROL_URL) || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  assertControlUrlIsTestSafe(env, fetchImpl);   // PROD_GUARD_V1
  let res;
  try {
    res = await fetchImpl(base + '/cp/v1/branch/' + encodeURIComponent(id) + '/reissue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install_token: token }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: 'branch_offline' };
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'branch_unauthorized' };
    // 404 у этой ручки означает сразу три вещи — нет такого филиала, он не ваш,
    // он погашен, — и поставщик отвечает на все три одинаково НАМЕРЕННО (иначе
    // по разнице ответов перебирался бы чужой реестр). Значит и здесь причина
    // одна, и фраза у неё ведёт в поддержку, а не советует чинить своё.
    if (res.status === 404) return { ok: false, reason: 'reissue_not_found' };
    return { ok: false, reason: 'branch_server_error' };
  }

  let body;
  try { body = await res.json(); } catch { return { ok: false, reason: 'branch_server_error' }; }
  const code = body && typeof body.enrollment_code === 'string' ? body.enrollment_code.trim() : '';
  // Пустой ответ — это ключ без кода, то есть ключ, которым филиал не
  // активируется. Молча выдать такой значит отправить человека ставить систему,
  // которая не заведётся, — ровно та ошибка, ради которой этот перевыпуск и
  // написан.
  if (!code) return { ok: false, reason: 'branch_server_error' };
  return {
    ok: true,
    enrollment_code: code,
    // ЧТО ОТВЕТИЛ ПОСТАВЩИК, А НЕ ЧТО МЫ СПРАШИВАЛИ. Раньше здесь стояла
    // подстановка запрошенного идентификатора, когда в ответе его не было, —
    // и вызывающий, сверяя ответ с запросом (rpc/branch-sync.js, ревью
    // 2026-09-03 C1), сверял бы запрос сам с собой. Проверка, которую нельзя
    // провалить, не проверка: ответ без идентификатора — это ответ, про
    // который неизвестно, чей код в нём лежит, и решать это здесь нечем.
    clinic_id: typeof body.clinic_id === 'string' && body.clinic_id ? body.clinic_id : null,
    // Имя же служебное и необязательное: по нему вызывающий сверяет, тот ли
    // это филиал, но ответ без имени — не повод объявить перевыпуск неудачным.
    name: typeof body.name === 'string' && body.name ? body.name : null,
  };
}
