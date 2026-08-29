import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeAtomic } from '../control/checkin.js';

// BRANCH_SYNC_V1 — кто мы в группе филиалов и чем доказываем это друг другу.
//
// Форма списана с control/enroll.js: владелец получает КОД, вводит его в
// установке, после чего установка знает, к чему она привязана. Отличие ровно
// одно, и оно принципиальное — код здесь выпускает не сервер поставщика, а сам
// ГЛАВНЫЙ ФИЛИАЛ.
//
// Почему так (решение владельца «Вариант A», settings.easymed.uz — только
// посредник): на Этапе 1 посредник не нужен ни для чего. Всё, что он должен был
// бы передать — адрес главного филиала и общий секрет — целиком помещается в
// сам код, а филиалы по условию видят друг друга (одна сеть или VPN). Убрав
// его из цепочки, мы получаем связывание, которое работает в клинике вообще без
// интернета — ровно то свойство, ради которого этот продукт локальный, — и
// вдобавок на сервер поставщика не попадает даже адрес клиники. Место
// посредника оставлено: запись хранит `source`, и выпуск ключа сервером
// добавляется позже, ничего не меняя в транспорте.
//
// ПРАВИЛА ЭТОГО ФАЙЛА (те же, что у checkin.js/enroll.js):
//   * никогда не бросать наружу — испорченный или отсутствующий файл читается
//     как «не спарено», а не как авария;
//   * ничего не писать наполовину — только writeAtomic (tmp + rename);
//   * секрет живёт в каталоге данных клиники, а не в репозитории: файл лежит
//     рядом с control.json и licence.dat, которые .gitignore уже закрывает.

const FILE = 'branch-sync.json';

// Единственная точка протокола. Путь входит в подпись, поэтому обе стороны
// обязаны брать его отсюда: разойдись они на один символ — подпись перестала бы
// сходиться, и отладка выглядела бы как «неверный ключ».
export const CATALOGUE_PATH = '/api/branch-sync/catalogue';

// Версионный префикс в самом коде — чтобы установка со старым форматом сказала
// «код не подходит», а не разобрала его наполовину.
const KEY_PREFIX = 'EMB1-';

// Секрет группы: 32 случайных байта. Это ключ HMAC, а не пароль, который кто-то
// набирает руками, поэтому длина выбрана по стойкости, а не по удобству ввода.
const SECRET_BYTES = 32;

// Насколько разъезжаются часы двух клинических ПК, прежде чем подпись считается
// протухшей. Метка времени входит в подпись и ограничивает повтор чужого
// перехваченного запроса; 5 минут — это и защита от повтора, и запас на
// нормальный дрейф часов в локальной сети. Больший разброс — это уже сбитые
// часы, и вызывающая сторона должна услышать про часы, а не про «нет доступа»
// (см. reason 'clock_skew' в routes/branch-sync.js).
export const MAX_SKEW_MS = 5 * 60 * 1000;

// Экспортированы (BRANCH_SYNC_RELAY_V1) не для красоты, а чтобы кодировка
// существовала в проекте в ОДНОМ экземпляре: ключ группы для Маршрута Б лежит
// на диске и едет в ключе связывания той же самой base64url, и вторая её
// реализация разошлась бы с этой на хвостовых '=' в первый же день.
export const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// BRANCH_SYNC_RELAY_V1 — ключ шифрования группы: 32 байта, то есть AES-256.
// Живёт ЗДЕСЬ, а не в relay-crypto.js, чтобы не возникло кольца импортов:
// разбор ключа подключения (этот файл) обязан уметь проверить ключ группы, а
// криптография (relay-crypto.js) обязана уметь его декодировать, и общее знание
// должно лежать в том файле, который не зависит от второго.
export const GROUP_KEY_BYTES = 32;

/**
 * Ключ группы -> 32 сырых байта, либо null (нет ключа / не тот размер / мусор).
 *
 * null, а не исключение: «ключа нет» и «ключ испорчен» — оба про то, что
 * резервный канал недоступен, и оба обязаны выглядеть на экране состоянием, а
 * не аварией.
 */
export function decodeGroupKey(key) {
  if (Buffer.isBuffer(key)) return key.length === GROUP_KEY_BYTES ? key : null;
  if (typeof key !== 'string' || !key.trim()) return null;
  let buf;
  try { buf = unb64url(key.trim()); } catch { return null; }
  return buf.length === GROUP_KEY_BYTES ? buf : null;
}

export function pairingPath(dataDir) { return path.join(dataDir, FILE); }

/**
 * Запись о паре — или null, если её нет либо файл нечитаем.
 *
 * НИКОГДА не бросает. Испорченный JSON здесь означает «филиал не спарен»:
 * клиника продолжает работать в одиночку, что и есть нормальное состояние
 * установки Easy-Med. Валидация полная, а не «есть файл — значит спарены»:
 * половинчатая запись (без секрета, без адреса) хуже отсутствующей, потому что
 * экран показал бы «связан», а синхронизация молча не работала бы.
 */
export function readPairing(dataDir, { readFileSync = fs.readFileSync } = {}) {
  let raw;
  try { raw = readFileSync(pairingPath(dataDir), 'utf8'); } catch { return null; }
  let v;
  try { v = JSON.parse(typeof raw === 'string' && raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); }
  catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (v.role !== 'main' && v.role !== 'secondary') return null;
  if (typeof v.group_id !== 'string' || !v.group_id) return null;
  if (typeof v.secret !== 'string' || !v.secret) return null;
  // Адрес главного филиала обязателен только вторичному — ему туда ходить.
  // Главный может не знать своего внешнего адреса до того, как владелец его
  // впишет, и это не повод считать установку неспаренной.
  if (v.role === 'secondary' && !normalizeUrl(v.main_url)) return null;
  return v;
}

export function writePairing(dataDir, record, { writeFileSync, renameSync } = {}) {
  writeAtomic(pairingPath(dataDir), JSON.stringify(record, null, 2), { writeFileSync, renameSync });
  return record;
}

/** Разрыв пары. Данные, которые уже приехали, остаются — стирается только связь. */
export function clearPairing(dataDir, { unlinkSync = fs.unlinkSync } = {}) {
  try { unlinkSync(pairingPath(dataDir)); return true; }
  catch { return false; }
}

/**
 * Адрес, по которому вторичный филиал будет стучаться в главный.
 *
 * Нормализуется, а не принимается как есть: этот адрес попадает в ключ, а из
 * ключа — в fetch(). Разрешены только http/https и только origin (схема, хост,
 * порт) — путь, строка запроса и, главное, `user:pass@` отбрасываются. Логин с
 * паролем в URL превратил бы ключ связывания в переносчик чужих учётных данных,
 * а лишний путь тихо ломал бы сборку адреса запроса.
 *
 * @returns {string|null} origin без хвостового слэша, либо null если это не адрес
 */
export function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // Схемой считается только то, за чем идёт «//» — иначе «branch.uz:8000»
  // (обычная запись «хост:порт») было бы разобрано как схема «branch.uz».
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  // Схема есть, но не наша. Отвергаем, а НЕ дописываем http:// впереди:
  // 'file:///C:/windows' с приписанной схемой превращался в 'http://file' —
  // молча подменённый адрес хуже honest-отказа (поймано тестом).
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  // Владелец печатает «10.4.1.10:8000» гораздо чаще, чем «http://…».
  const withScheme = scheme ? raw : 'http://' + raw;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  if (u.username || u.password) return null;
  return u.origin;
}

const newGroupId = () => 'BR-' + randomBytes(6).toString('hex').toUpperCase();

/**
 * Сделать эту установку ГЛАВНЫМ филиалом и выдать ключ подключения.
 *
 * Повторный вызов НЕ перевыпускает секрет: ключ печатают, пересылают и вводят
 * не в один присест, и «нажал ещё раз — старый ключ умер» означало бы, что
 * связывание второго филиала рвёт связь первого. Адрес при этом обновить можно
 * (переехали на другой IP) — он не является тайной.
 *
 * @param {object} [opts]
 * @param {string} [opts.groupId]   BRANCH_SYNC_RELAY_V1 — идентификатор группы,
 *   созданный при АКТИВАЦИИ клиники (services/branch-sync/sync-group.js).
 *   Передаётся снаружи, а не читается здесь, чтобы этот модуль остался про
 *   записи и подписи и не зависел от файла, который заводит enroll.js.
 *   Используется только если пары ещё нет: у существующей группа не меняется.
 * @param {string} [opts.groupKey]  ключ шифрования группы (Маршрут Б). Кладётся
 *   в запись и в ключ подключения — это ЕДИНСТВЕННЫЙ путь, которым он попадает
 *   во второй филиал, и он никогда не проходит через сервер поставщика.
 * @param {boolean} [opts.rotate]   перевыпуск: новый секрет И новый ключ группы.
 *   Рвёт связь со ВСЕМИ уже подключёнными филиалами — по этому и только по
 *   этому пути, и владельца спрашивают об этом на экране заранее.
 *
 * @returns {{ok:true, record:object, key:string} | {ok:false, reason:string}}
 *   reason: bad_url | already_secondary | write_failed
 */
export function makeMainKey(dataDir, {
  url, groupId, groupKey, rotate = false, now = () => new Date(), writeFileSync, renameSync,
} = {}) {
  const existing = readPairing(dataDir);
  // Установка не может быть одновременно источником и приёмником справочника:
  // это кольцо, в котором цена услуги ездит по кругу и ни одна сторона не
  // является правдой. Сначала «Отвязать», потом «сделать главным».
  if (existing && existing.role === 'secondary') return { ok: false, reason: 'already_secondary' };

  const mainUrl = normalizeUrl(url);
  if (!mainUrl) return { ok: false, reason: 'bad_url' };

  const record = {
    role: 'main',
    // При перевыпуске старая группа умирает целиком — иначе «перевыпустил ключ»
    // означало бы, что Маршрут Б сломался, а Маршрут А продолжает пускать
    // старые филиалы, и обещание «отключит все филиалы» стало бы ложью.
    group_id: (rotate ? null : existing?.group_id) || groupId || newGroupId(),
    secret: (rotate ? null : existing?.secret) || b64url(randomBytes(SECRET_BYTES)),
    main_url: mainUrl,
    source: 'manual',
    created_at: (rotate ? null : existing?.created_at) || now().toISOString(),
    updated_at: now().toISOString(),
  };
  // Ключ группы дописывается ТОЛЬКО когда он есть: установка, спаренная до
  // появления Маршрута Б, продолжает работать по Маршруту А ровно как раньше,
  // а на экране честно пишется, что резервный канал станет доступен после
  // перевыпуска ключа подключения.
  // ПОРЯДОК ЗДЕСЬ ВАЖНЕЕ, ЧЕМ ВЫГЛЯДИТ: ключ УЖЕ СУЩЕСТВУЮЩЕЙ пары старше
  // любого переданного. Обратный порядок (groupKey первым) означал бы, что
  // «Показать ключ подключения» на настроенном главном филиале молча подменяет
  // ключ группы, как только sync-group.json почему-либо оказался другим —
  // восстановили каталог данных из старой копии, файл потеряли и он завёлся
  // заново. Все уже подключённые филиалы после такого перестали бы
  // расшифровывать копию, а на экране не изменилось бы ничего. Поймано
  // тестом «повторная выдача ключа не трогает ни секрет, ни ключ группы».
  const key = (rotate ? null : existing?.group_key) || groupKey || null;
  if (key) record.group_key = key;
  // Согласие на выгрузку копии на сервер поставщика — решение владельца, а не
  // побочный эффект нажатия «Сделать главным». Уже данное согласие переживает
  // повторную выдачу ключа; при перевыпуске оно тоже сохраняется (перевыпуск
  // про ключ, а не про канал).
  if (typeof existing?.relay === 'boolean') record.relay = existing.relay;

  try { writePairing(dataDir, record, { writeFileSync, renameSync }); }
  catch (e) {
    console.warn('[branch-sync] could not write the pairing file:', e && e.message);
    return { ok: false, reason: 'write_failed' };
  }
  return { ok: true, record, key: encodeKey(record) };
}

/**
 * Ключ, который владелец переносит во второй филиал.
 *
 * BRANCH_SYNC_RELAY_V1 — поле `k` (ключ шифрования группы) появляется здесь и
 * больше нигде. Ключ подключения владелец переносит РУКАМИ (мессенджер,
 * бумажка, флешка), и это сознательно выбранный канал: он не проходит через
 * settings.easymed.uz, поэтому поставщик не видит ключа даже мельком.
 */
export function encodeKey({ group_id, secret, main_url, group_key }) {
  const body = { v: 1, g: group_id, s: secret, u: main_url };
  if (group_key) body.k = group_key;
  return KEY_PREFIX + b64url(Buffer.from(JSON.stringify(body), 'utf8'));
}

/**
 * Разрешён ли этой установке резервный канал через сервер поставщика.
 *
 * Умолчания РАЗНЫЕ по ролям, и это не небрежность:
 *   * главный филиал — ВЫКЛЮЧЕНО, пока владелец не включит. Именно он выгружает
 *     байты наружу, и «по умолчанию отправляем копию справочника поставщику»
 *     было бы решением за владельца там, где обещание продукта — «данные не
 *     покидают клинику»;
 *   * подключённый филиал — ВКЛЮЧЕНО. Он ничего не выгружает, только пытается
 *     забрать уже лежащий блоб, и только когда прямой путь не удался. Если
 *     главный филиал согласия не давал, забирать просто нечего.
 */
export function relayEnabled(pairing) {
  if (!pairing) return false;
  if (pairing.role === 'main') return pairing.relay === true;
  return pairing.relay !== false;
}

/**
 * Разобрать введённый ключ. Пробелы и переводы строк вычищаются: ключ длинный,
 * его копируют через мессенджер и почту, и перенос строки посередине — самая
 * обычная судьба такой строки. Регистр НЕ трогаем — base64url регистрозависим.
 *
 * @returns {{ok:true, group_id, secret, main_url, group_key:string|null}
 *          | {ok:false, reason:'empty_key'|'bad_key'}}
 *   group_key === null — ключ выпущен установкой до появления Маршрута Б.
 *   Это не ошибка: Маршрут А работает, резервный канал просто недоступен.
 */
export function parseKey(text) {
  const cleaned = String(text || '').replace(/\s+/g, '');
  if (!cleaned) return { ok: false, reason: 'empty_key' };
  if (!cleaned.startsWith(KEY_PREFIX)) return { ok: false, reason: 'bad_key' };
  let body;
  try { body = JSON.parse(unb64url(cleaned.slice(KEY_PREFIX.length)).toString('utf8')); }
  catch { return { ok: false, reason: 'bad_key' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.v !== 1) return { ok: false, reason: 'bad_key' };
  const mainUrl = normalizeUrl(body.u);
  if (typeof body.g !== 'string' || !body.g || typeof body.s !== 'string' || !body.s || !mainUrl) {
    return { ok: false, reason: 'bad_key' };
  }
  // Ключ группы необязателен и проверяется по ДЛИНЕ, а не по «есть строка»:
  // 32 байта после base64url — это и есть ключ AES-256; всё прочее означало бы
  // ключ подключения, испорченный при переносе, и лучше остаться без резервного
  // канала, чем записать на диск огрызок и потом искать, почему не расшифровывается.
  const groupKey = typeof body.k === 'string' && decodeGroupKey(body.k) ? body.k : null;
  return { ok: true, group_id: body.g, secret: body.s, main_url: mainUrl, group_key: groupKey };
}

/**
 * Принять ключ на вторичном филиале.
 *
 * Проверки происходят ДО единственной записи на диск — то же правило, что у
 * enroll.js: установка либо остаётся ровно такой, какой была, либо получает
 * целую и осмысленную запись.
 *
 * @returns {{ok:true, record:object} | {ok:false, reason:string}}
 *   reason: empty_key | bad_key | already_main | write_failed
 */
export function pairWithKey(dataDir, keyText, { now = () => new Date(), writeFileSync, renameSync } = {}) {
  const parsed = parseKey(keyText);
  if (!parsed.ok) return parsed;

  const existing = readPairing(dataDir);
  // Симметрично makeMainKey: главный филиал не начинает вдруг забирать
  // справочник у кого-то ещё. Владелец должен сначала осознанно отвязаться.
  if (existing && existing.role === 'main') return { ok: false, reason: 'already_main' };

  const record = {
    role: 'secondary',
    group_id: parsed.group_id,
    secret: parsed.secret,
    main_url: parsed.main_url,
    source: 'manual',
    paired_at: now().toISOString(),
  };
  // Ключ группы приходит ТОЛЬКО отсюда — из ключа, который владелец перенёс
  // руками. Своего ключа (sync-group.json, выписанного при активации этой
  // установки) вторичный филиал не использует: группу определяет главный, а
  // два разных ключа в одной группе означали бы блоб, который никто не
  // расшифрует. Ключ, выпущенный до появления Маршрута Б, поля просто не несёт.
  if (parsed.group_key) record.group_key = parsed.group_key;
  try { writePairing(dataDir, record, { writeFileSync, renameSync }); }
  catch (e) {
    console.warn('[branch-sync] could not write the pairing file:', e && e.message);
    return { ok: false, reason: 'write_failed' };
  }
  return { ok: true, record };
}

// Подпись запроса. Секрет НИКОГДА не уходит в сеть — уходит HMAC от него по
// (группа, метка времени, путь). В локальной сети это обычный http без TLS, и
// «прислать сам секрет» означало бы отдать его любому, кто слушает провод;
// подпись же одноразова в пределах окна MAX_SKEW_MS и годится только для того
// пути, для которого посчитана.
export function signRequest({ secret, groupId, ts, requestPath }) {
  return b64url(createHmac('sha256', String(secret)).update(`${groupId}\n${ts}\n${requestPath}`).digest());
}

/**
 * Сверка подписи ЗА ПОСТОЯННОЕ ВРЕМЯ.
 *
 * Обычное `a === b` на строках выходит из сравнения на первом же несовпавшем
 * символе, и по времени ответа подпись можно подобрать байт за байтом. Сравниваем
 * сырые 32 байта дайджеста через timingSafeEqual, а не base64-строки: одно и то
 * же значение допускает разные записи в base64 (хвостовые '='), и сравнение
 * текста отвергало бы верную подпись.
 *
 * Несовпадение ДЛИНЫ отсеивается до timingSafeEqual (иначе он бросает) — это не
 * утечка: длина дайджеста фиксирована и известна всем.
 */
export function verifySignature({ secret, groupId, ts, requestPath, sig }) {
  const expected = unb64url(signRequest({ secret, groupId, ts, requestPath }));
  let given;
  try { given = unb64url(String(sig || '')); } catch { return false; }
  if (given.length !== expected.length) return false;
  try { return timingSafeEqual(given, expected); } catch { return false; }
}

/** Метка времени вне окна = устаревший (или подсунутый повторно) запрос. */
export function skewMs(ts, now = Date.now()) {
  // Отсутствующая метка — не «нулевая». Number(null) и Number('') дают 0, то
  // есть 1 января 1970 года, и без этой проверки запрос БЕЗ метки времени
  // выглядел бы как запрос с колоссальным расхождением часов — отказ был бы
  // тот же, но по неверной причине, и на экране филиала появилось бы
  // «проверьте дату и время» вместо правды.
  if (ts === null || ts === undefined || (typeof ts === 'string' && !ts.trim())) return Number.POSITIVE_INFINITY;
  const n = Number(ts);
  if (!Number.isFinite(n)) return Number.POSITIVE_INFINITY;
  return Math.abs(now - n);
}

/**
 * Адреса этого ПК в локальной сети — подсказка для поля «Адрес главного
 * филиала», чтобы владельцу не пришлось искать ipconfig.
 *
 * Своя копия, а не импорт одноимённой функции из server/index.js: тот файл —
 * точка входа процесса (он открывает базу, поднимает порт и запускает
 * планировщики), и импортировать его из сервиса означало бы тянуть весь запуск
 * ради шести строк перебора интерфейсов.
 */
export function lanAddresses({ interfaces = os.networkInterfaces() } = {}) {
  const out = [];
  for (const list of Object.values(interfaces || {})) {
    for (const iface of list || []) {
      if (iface && iface.family === 'IPv4' && !iface.internal && iface.address) out.push(iface.address);
    }
  }
  return out;
}

/** Первый разумный адрес «как нас видит второй филиал», либо null. */
export function suggestMainUrl({ port = Number(process.env.PORT || 8000), interfaces } = {}) {
  const [ip] = lanAddresses(interfaces ? { interfaces } : {});
  return ip ? `http://${ip}:${port}` : null;
}
