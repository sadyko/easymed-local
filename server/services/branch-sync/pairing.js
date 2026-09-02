import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeAtomic } from '../control/checkin.js';
// BRANCH_IDENTITY_V1 — связывание принимает БУКВУ филиала, а не только адрес и
// секрет. Зависимость направленная, и обратной ей быть нельзя: identity.js
// отсюда не импортирует ничего (он умеет только ПРИНЯТЬ букву), поэтому кольца
// не возникает, а у активации остаётся ровно один владелец — этот файл.
import { becomeSecondary } from './identity.js';

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

// KEY FORMAT v2. EMB1 keys are still accepted on purpose: every clinic paired
// before this release holds one, and refusing them would un-pair every existing
// branch the moment the update installed. A v1 key yields letter: null, and the
// caller allocates a letter then — the branch is no less identified, it simply
// learns its letter at activation instead of from the key.
//
// И РОВНО ТА ЖЕ ЗАБОТА В ОБРАТНУЮ СТОРОНУ, поэтому encodeKey переключается на
// EMB2 только когда ключу есть что нести сверх старого набора. Обновляют парк
// не одномоментно: главный филиал почти всегда обновится первым, и ключ, который
// он выдаёт, попадёт в филиал СО СТАРОЙ сборкой. Тот на незнакомый префикс
// ответит «ключ не подходит» — то самое отваливание, от которого защищает
// абзац выше, только с другого конца. Ключ без буквы и без токена по-прежнему
// EMB1, потому что в нём нет ни одного поля, которого старая сборка не поняла бы.
const KEY_PREFIX_V2 = 'EMB2-';

// Токен резервного канала (Задача 4) уезжает в заголовок
// `Authorization: Bearer <token>`, поэтому в нём допускаются только видимые
// ASCII-символы и никаких пробелов.
//
// И это НЕ про внедрение чужого заголовка: fetch в Node такое значение просто
// не отправит, а бросит TypeError. Цена — в том, что происходит с этим броском
// дальше: relay.js оборачивает свой fetch в try/catch и ЛЮБОЙ бросок переводит
// в 'relay_offline', то есть в «Нет связи с сервером Easy-Med». Один испорченный
// символ в токене навсегда превратился бы в жалобу на интернет, которую никто
// не связал бы с ключом подключения. Выпускает токен
// control-plane/server/routes/relay-token.js в base64url (43 символа), так что
// настоящий токен попадает в это множество целиком.
const RELAY_TOKEN_RE = /^[\x21-\x7E]+$/;

// Верхняя граница длины — не про формат, а про то, что эта строка ложится на
// диск клиники и уходит в заголовок HTTP. 256 символов — это шестикратный запас
// над выпускаемыми 43 и заведомо меньше любого предела на длину заголовка.
const RELAY_TOKEN_MAX = 256;

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
  // BRANCH_SELF_SERVICE_V1 — код активации филиала. НЕ попадает в record и не
  // пишется в файл пары: он одноразовый и принадлежит филиалу, а не этой
  // машине. Живёт ровно столько, сколько нужно, чтобы попасть в ключ.
  enrollCode = null,
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
  return { ok: true, record, key: encodeKey({ ...record, enroll_code: enrollCode }) };
}

/**
 * Ключ, который владелец переносит во второй филиал.
 *
 * BRANCH_SYNC_RELAY_V1 — поле `k` (ключ шифрования группы) появляется здесь и
 * больше нигде. Ключ подключения владелец переносит РУКАМИ (мессенджер,
 * бумажка, флешка), и это сознательно выбранный канал: он не проходит через
 * settings.easymed.uz, поэтому поставщик не видит ключа даже мельком.
 */
export function encodeKey({ group_id, secret, main_url, group_key, letter, relay_token, enroll_code, branch_name }) {
  // Нечего нести сверх старого набора — значит и формат старый. Не экономия
  // байтов, а совместимость вниз: см. KEY_PREFIX_V2.
  if (!letter && !relay_token && !enroll_code) return encodeLegacyV1({ group_id, secret, main_url, group_key });
  const body = { v: 2, g: group_id, s: secret, u: main_url };
  if (group_key) body.k = group_key;
  // `l` — буква филиала (её выдал ГЛАВНЫЙ филиал, letters.js), `t` — токен
  // резервного канала, выписанный главным филиалом на сервере поставщика.
  // Оба поля необязательны и оба разбираются по-разному — см. parseKey.
  if (letter) body.l = letter;
  // BRANCH_NAME_IN_KEY_V1 — имя филиала едет вместе с буквой.
  //
  // Без него филиал называл себя БУКВОЙ: в списке филиалов на его машине
  // стояли «C» и «Main Branch» — одно не имя, другое чужое. Имя знает главная
  // клиника (она его и вводила, заводя филиал), а узнать его самому филиалу
  // неоткуда: справочник он получит позже, а назваться должен в момент
  // активации.
  //
  // Поле необязательное: ключи, выданные до этой версии, его не имеют, и
  // филиал по-прежнему возьмёт букву как имя — хуже, чем раньше, не станет.
  if (branch_name) body.n = branch_name;
  if (relay_token) body.t = relay_token;
  // BRANCH_SELF_SERVICE_V1 — код активации филиала, выданный control plane по
  // запросу ГЛАВНОЙ клиники. Едет в ключе, потому что другого канала к машине
  // филиала нет: её ещё не существует, когда ключ выписывают. Ключ и так
  // передаётся из рук в руки как секрет — код не делает его секретнее.
  if (enroll_code) body.e = enroll_code;
  return KEY_PREFIX_V2 + b64url(Buffer.from(JSON.stringify(body), 'utf8'));
}

/**
 * Ключ ровно в том виде, в каком его выпускали до появления буквы филиала.
 *
 * Экспортирован не ради вызывающих (их нет — encodeKey сам сюда сворачивает),
 * а ради теста обратной совместимости: проверять разбор EMB1 надо на строке,
 * собранной СТАРЫМ кодом, а не на новой, которую подогнали под старый формат.
 * Держать её здесь дешевле, чем хранить в тесте константу-образец, которая
 * ничего не расскажет, если формат поедет.
 */
export function encodeLegacyV1({ group_id, secret, main_url, group_key }) {
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
 * @returns {{ok:true, group_id, secret, main_url, group_key:string|null,
 *            letter:string|null, relay_token:string|null}
 *          | {ok:false, reason:'empty_key'|'bad_key'|'bad_letter'}}
 *   group_key === null — ключ выпущен установкой до появления Маршрута Б.
 *   Это не ошибка: Маршрут А работает, резервный канал просто недоступен.
 *   letter === null — ключ выпущен до появления букв филиалов (EMB1) либо
 *   главным филиалом, который букв ещё не раздаёт. Тоже не ошибка — см.
 *   pairWithKey, который в этом случае базу не трогает.
 */
export function parseKey(text) {
  const cleaned = String(text || '').replace(/\s+/g, '');
  if (!cleaned) return { ok: false, reason: 'empty_key' };
  // Префикс задаёт ОЖИДАЕМУЮ версию, а не «одну из». Оба префикса длиной пять
  // символов, но срез считается от найденного, а не от KEY_PREFIX: одинаковая
  // длина — совпадение, а не правило, и следующий формат его не обязан хранить.
  const prefix = cleaned.startsWith(KEY_PREFIX_V2) ? KEY_PREFIX_V2
    : cleaned.startsWith(KEY_PREFIX) ? KEY_PREFIX : null;
  if (!prefix) return { ok: false, reason: 'bad_key' };
  const version = prefix === KEY_PREFIX_V2 ? 2 : 1;
  let body;
  try { body = JSON.parse(unb64url(cleaned.slice(prefix.length)).toString('utf8')); }
  catch { return { ok: false, reason: 'bad_key' }; }
  // Версия внутри обязана совпасть с префиксом снаружи. Расхождение — это ключ,
  // который кто-то правил руками: разобрать его «как получится» означало бы
  // принять поля одного формата по правилам другого.
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.v !== version) {
    return { ok: false, reason: 'bad_key' };
  }
  const mainUrl = normalizeUrl(body.u);
  if (typeof body.g !== 'string' || !body.g || typeof body.s !== 'string' || !body.s || !mainUrl) {
    return { ok: false, reason: 'bad_key' };
  }
  // Ключ группы необязателен и проверяется по ДЛИНЕ, а не по «есть строка»:
  // 32 байта после base64url — это и есть ключ AES-256; всё прочее означало бы
  // ключ подключения, испорченный при переносе, и лучше остаться без резервного
  // канала, чем записать на диск огрызок и потом искать, почему не расшифровывается.
  const groupKey = typeof body.k === 'string' && decodeGroupKey(body.k) ? body.k : null;

  // БУКВА — единственное поле ключа, испорченность которого отвергает ВЕСЬ ключ.
  // Ключ группы и токен при поломке просто обнуляются: цена — резервный канал.
  // Цена молча обнулённой буквы другая: филиал свяжется, буквы не получит и
  // начнёт печатать A-номера рядом с главным филиалом, который печатает свои, —
  // два разных человека с одним номером на карточках, ровно та коллизия, ради
  // которой буква и заведена. Поэтому «поле есть, но это не A-Z» отвергает ключ
  // целиком: владельца отправляют за новым ключом, и это поправимо в тот же день.
  //
  // ОТКАЗ НАЗЫВАЕТСЯ 'bad_letter', А НЕ 'bad_key', и различие здесь ровно одно —
  // что владелец прочтёт на экране. bad_key переводится как «проверьте, что ключ
  // скопирован целиком»: верный совет для обрезанного или искажённого при
  // пересылке ключа и бесполезный для этого случая. Ключ, выпущенный с
  // кириллической «С» вместо латинской «C» (буквы неразличимы на экране, а
  // клавиатура у выпускающего русская), скопирован целиком — копировать его
  // заново можно бесконечно. Лечится он перевыпуском ключа в главном филиале,
  // и это то, что говорит фраза bad_letter (rpc/branch-sync.js).
  //
  // Тот же код, что у identity.js normalizeLetter, и это не совпадение: там он
  // отвечает на «буква не A-Z» и «буква длиннее восьми», здесь — на «поле есть,
  // но буквой не является». Один код на одно положение дел, с какой бы стороны
  // в него ни пришли.
  //
  // Отсутствие поля и явный null — это НЕ порча, а «буквы в ключе нет»
  // (EMB1 или ключ главного филиала до раздачи букв).
  //
  // ЧТО ИМЕННО ПРОВЕРЯЕТСЯ ЗДЕСЬ, а что — нет. Здесь только тип: «в этом поле
  // лежит строка, похожая на букву». Годится ли ТАКАЯ буква — длина, регистр,
  // занятость, поддельная кириллица — решает identity.js (normalizeLetter и
  // проверки becomeSecondary), и решает он один: через него проходит КАЖДЫЙ, кто
  // принимает букву, а через разбор ключа — только тот, кто пришёл с ключом
  // (сегодня это единственный путь: Задача 6 вышла списком филиалов, который
  // букву не принимает, а согласованная перенумерация — это Этап 2 и её ещё нет).
  // Регистр здесь не приводится по той же причине: свёртка живёт там, и
  // вторая её копия разошлась бы с первой — тем более что именно свёртка умеет
  // ИЗГОТОВИТЬ латинскую букву из нелатинской ('ß' -> 'SS'). Здесь только
  // обрезаются пробелы по краям.
  let letter = null;
  let branchName = '';
  if (version === 2 && body.l !== undefined && body.l !== null) {
    letter = typeof body.l === 'string' ? body.l.trim() : '';
    branchName = typeof body.n === 'string' ? body.n.trim().slice(0, 120) : '';
    if (!/^[A-Za-z]+$/.test(letter)) return { ok: false, reason: 'bad_letter' };
  }

  // Токен резервного канала — по правилам ключа группы, а не буквы: без него
  // работает Маршрут А, и это состояние, а не поломка. Достижимо честным путём:
  // главный филиал выписывает токен на сервере поставщика, а ключ подключения
  // он умеет выдать и без интернета.
  const rawToken = version === 2 && typeof body.t === 'string' ? body.t.trim() : '';
  const relayToken = rawToken && rawToken.length <= RELAY_TOKEN_MAX && RELAY_TOKEN_RE.test(rawToken)
    ? rawToken : null;

  return {
    ok: true, group_id: body.g, secret: body.s, main_url: mainUrl, group_key: groupKey, branch_name: branchName,
    letter, relay_token: relayToken,
    // Код активации не валидируем формой: его проверяет control plane при
    // погашении, и вторая, независимая проверка формата здесь означала бы, что
    // смена формата кода на сервере молча ломает ключи.
    enroll_code: version === 2 && typeof body.e === 'string' && body.e.trim() ? body.e.trim() : null,
  };
}

/**
 * Вернуть файл пары ровно в то состояние, в котором он был до попытки.
 *
 * Буфер, а не строка, и это не мелочь: файл пишет не только этот модуль (его
 * правят руками, его восстанавливают из архива), и прочитанный как 'utf8' байт,
 * который в UTF-8 не складывается, возвращается уже как U+FFFD. Проверено:
 * 105-байтовый файл с русским текстом в CP1251 «восстанавливался» в 117 байт,
 * то есть откат портил ровно то, что обещал сохранить.
 *
 * Сам не бросает — откат уже идёт по пути отказа, и падение в нём подменило бы
 * причину, ради которой мы сюда попали, — но РЕЗУЛЬТАТ отдаёт наверх, потому
 * что несостоявшийся откат меняет ответ вызывающему (см. pairWithKey).
 *
 * @returns {boolean} файл действительно вернулся в прежнее состояние
 */
function restorePairingFile(dataDir, previousRaw, { writeFileSync, renameSync, unlinkSync, readFileSync = fs.readFileSync } = {}) {
  try {
    if (previousRaw !== null) {
      writeAtomic(pairingPath(dataDir), previousRaw, { writeFileSync, renameSync });
      return true;
    }
    if (clearPairing(dataDir, { unlinkSync })) return true;
    // clearPairing отвечает false на ЛЮБУЮ неудачу, включая «файла и так нет».
    // Отличить их можно только по диску — и спрашивать надо именно про диск:
    // вызывающему обещано, что после отказа файла НЕ ОСТАНЕТСЯ, а не что
    // системный вызов вернул успех.
    try { readFileSync(pairingPath(dataDir)); } catch { return true; }
    console.warn('[branch-sync] the pairing file could not be removed after a refused activation');
    return false;
  } catch (e) {
    console.warn('[branch-sync] could not roll the pairing file back after a refused activation:', e && e.message);
    return false;
  }
}

/**
 * Принять ключ на вторичном филиале.
 *
 * Проверки происходят ДО записей — то же правило, что у enroll.js: установка
 * либо остаётся ровно такой, какой была, либо получает целую и осмысленную
 * запись.
 *
 * ЗАПИСЕЙ ТЕПЕРЬ ДВЕ, И ПОРЯДОК ИХ ЗАДАН НЕ УДОБСТВОМ. Файл пары переписывается
 * сколько угодно раз; identity в базе (identity.js) — нет: она тратит букву, а
 * буква тратится однажды и навсегда, потому что номера под ней печатаются на
 * карточках. Поэтому сначала обратимое, потом необратимое:
 *
 *   1. файл пары — и текст файла до записи придержан для отката;
 *   2. becomeSecondary — последним.
 *
 * Отказ на шаге 2 откатывает шаг 1, и установка остаётся ровно прежней: это и
 * есть требование «отказ не пишет ничего». Обратный порядок отката не имеет —
 * потраченную букву вернуть нечем, — и оставлял бы установку, у которой база
 * говорит «вторичный», а файл «не спарен»: тот самый расход, о котором
 * предупреждает шапка identity.js (главным её после этого назначить МОЖНО).
 *
 * Откат — единственная запись здесь, которая сама может не удаться, и тогда
 * обещание выше не выполнено. Это НЕ прячется под причиной отказа: ответ
 * приходит с кодом 'rollback_failed' (исходная причина — в поле cause).
 *
 * Обрыв ПИТАНИЯ между шагами отката не получит, и это учтено: файл лёг, буква
 * не потрачена — повторное нажатие доводит дело до конца. Обрыв после шага 2
 * тоже переживается, потому что becomeSecondary для ТОЙ ЖЕ буквы идемпотентен
 * (Задача 3): повтор ничего не тратит и возвращает ту же identity.
 *
 * @param {object} [opts]
 * @param {object} [opts.db] база клиники. ОБЯЗАТЕЛЬНА, если ключ несёт букву:
 *   без неё связывание прошло бы, а identity молча осталась бы прежней — филиал
 *   печатал бы A-номера рядом с главным. Молчаливый пропуск здесь неотличим от
 *   нормальной работы месяцами, поэтому это отказ.
 *
 * @returns {{ok:true, record:object, identity:object|null}
 *          | {ok:false, reason:string, cause?:string}}
 *   identity — принятая identity, либо null, если В КЛЮЧЕ БУКВЫ НЕ БЫЛО (это не
 *   то же самое, что «у установки нет identity»: она есть всегда, миграция 080).
 *   reason: empty_key | bad_key | bad_letter | already_main | write_failed |
 *     identity_unavailable | rollback_failed | и любой код отказа identity.js
 *     (already_other_branch | already_numbered | letter_spent | letter_in_mrns |
 *     letter_on_branch | bad_letter | identity_missing) | identity_failed
 *   cause — только у 'rollback_failed': причина, по которой откатывались.
 */
export function pairWithKey(dataDir, keyText, {
  db, now = () => new Date(), writeFileSync, renameSync, readFileSync = fs.readFileSync, unlinkSync,
} = {}) {
  const parsed = parseKey(keyText);
  if (!parsed.ok) return parsed;

  const existing = readPairing(dataDir);
  // Симметрично makeMainKey: главный филиал не начинает вдруг забирать
  // справочник у кого-то ещё. Владелец должен сначала осознанно отвязаться.
  if (existing && existing.role === 'main') return { ok: false, reason: 'already_main' };

  // ДО первой записи, а не перед второй: вызывающий, забывший передать базу, не
  // должен оставить после себя даже файла.
  if (parsed.letter && !db) return { ok: false, reason: 'identity_unavailable' };

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
  // Токен резервного канала — по тому же правилу и по той же причине, что и
  // ключ группы: вторичный филиал НИКОГДА не активировался у поставщика, и это
  // единственная учётная запись, которая у него для Маршрута Б есть. Она
  // приезжает в ключе и не проходит через сервер поставщика ни в одну сторону.
  if (parsed.relay_token) record.relay_token = parsed.relay_token;

  // Байты файла ДО записи — материал для отката. Именно БАЙТЫ (без 'utf8'), и
  // именно сам файл, а не readPairing: испорченную запись readPairing показывает
  // как null, и восстанавливать её было бы нечем, а сохранить её надо — эти
  // байты принадлежат клинике, а не нам.
  let previousRaw = null;
  try { previousRaw = readFileSync(pairingPath(dataDir)); } catch { previousRaw = null; }

  try { writePairing(dataDir, record, { writeFileSync, renameSync }); }
  catch (e) {
    console.warn('[branch-sync] could not write the pairing file:', e && e.message);
    return { ok: false, reason: 'write_failed' };
  }

  // Ключ без буквы связывает как раньше и базу НЕ ТРОГАЕТ. Выдать букву здесь
  // было бы можно (letters.js рядом), и это была бы худшая из ошибок этого
  // этапа: журнал вторичного филиала знает только 'A' и 'P', поэтому ответ был
  // бы 'B' — буква, которую главный филиал уже отдал другому зданию. Выдаёт
  // ГЛАВНЫЙ, по единственному журналу парка; здесь букву только принимают.
  // Установка остаётся при своей identity (A/main) ровно как до обновления, и
  // получит букву, когда владелец принесёт ключ нового выпуска.
  if (!parsed.letter) return { ok: true, record, identity: null };

  let identity;
  try {
    // Имя филиала в ключе не едет: переименование — дело реестра филиалов
    // (Задача 6), а не активации. identity.js назовёт строку буквой.
    identity = becomeSecondary(db, { letter: parsed.letter, name: parsed.branch_name });
  } catch (e) {
    const restored = restorePairingFile(dataDir, previousRaw, {
      writeFileSync, renameSync, unlinkSync, readFileSync,
    });
    // Код причины проходит НАСКВОЗЬ и неизменным. 'already_numbered' — тупик:
    // экран согласия на разовую перенумерацию отнесён к Этапу 2 и не написан, а
    // русский текст этого кода честно отправляет владельца в поддержку. Подменять
    // код на общий 'identity_failed' всё равно нельзя: это единственный признак,
    // по которому тупик отличается от обычного отказа, и он же будет крючком для
    // того экрана, когда его напишут.
    const reason = e && typeof e.reason === 'string' ? e.reason : 'identity_failed';
    if (reason === 'identity_failed') {
      console.warn('[branch-sync] adopting the branch letter failed:', e && e.message);
    }
    // НО ЕСЛИ ОТКАТ НЕ УДАЛСЯ, отвечать «буква занята» нельзя, и это не
    // придирка к формулировке. На диске тогда лежит НОВАЯ запись (другая
    // группа, другой главный филиал), а identity в базе осталась прежней:
    // установка будет забирать справочник у нового главного и печатать
    // A-номера рядом с настоящим филиалом A — та самая коллизия, ради которой
    // весь этап и делается. Случай не выдуманный: на Windows антивирус или
    // агент резервного копирования держит файл, unlink отвечает EBUSY/EPERM.
    // Отдельный код нужен, чтобы Задача 6 могла сказать «установка в
    // несогласованном состоянии», а не назвать это занятой буквой; исходная
    // причина едет рядом, в cause, — она объясняет, ПОЧЕМУ откатывались.
    if (!restored) return { ok: false, reason: 'rollback_failed', cause: reason };
    return { ok: false, reason };
  }
  return { ok: true, record, identity };
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
