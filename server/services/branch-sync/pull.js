import { readBounded } from '../control/checkin.js';
import { readPairing, signRequest, CATALOGUE_PATH } from './pairing.js';
// STAFF_SYNC_SEAL_V1 — распечатывает ту же функция, что и у Маршрута Б.
import { openPayload } from './relay-crypto.js';
import { ACCEPT_HEADER, SEALED_FORM } from './catalogue.js';

// BRANCH_SYNC_V1 — сторона ВТОРИЧНОГО филиала: сходить в главный и принести
// справочник.
//
// Правило файла взято у control/checkin.js дословно, потому что положение
// точно такое же: СЕТИ МОЖЕТ НЕ БЫТЬ, И ЭТО НОРМА, А НЕ АВАРИЯ. Филиал за
// упавшим каналом, выключенный на ночь сервер главного филиала, перепутанный
// адрес — всё это обязано выглядеть как «сейчас не получилось, попробуем
// позже», а не как поломка. Поэтому наружу отсюда не летит ни одно исключение,
// и ни при каком ответе (пустом, обрезанном, гигантском, чужом) эта функция
// ничего не пишет — решение о записи принимает вызывающий, получив ok:true.

const TIMEOUT_MS = 20_000;

// Справочник больше ответа контрольной панели на порядки: в doc_settings лежит
// логотип клиники как data-URL (сотни килобайт), плюс сам прайс. 8 МБ — это
// «клиника с очень большим логотипом и очень длинным прайсом», и одновременно
// потолок, за которым отвечающая сторона перестала бы быть нашим главным
// филиалом. Ограничение реальное, а не косметическое: readBounded читает
// потоком и обрывает чтение на превышении, не набирая тело целиком в память.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Забрать справочник у главного филиала.
 *
 * @returns {Promise<{ok:true, group_id:string, catalogue:object, main_url:string}
 *                 | {ok:false, reason:string}>}
 *
 * НИКОГДА не бросает. reason — закрытый словарь, который rpc/branch-sync.js
 * переводит в русские фразы:
 *   not_paired | not_secondary | offline | unauthorized | clock_skew |
 *   not_main | server_error | too_large | bad_response |
 *   relay_no_key | relay_bad_key
 *
 * STAFF_SYNC_SEAL_V1 — последние две взяты у Маршрута Б ЦЕЛИКОМ, вместе с их
 * русскими фразами (REASONS в rpc/branch-sync.js), и это не экономия на
 * словаре: причина отказа одна и та же физически — ключ группы у филиала не
 * тот, что у главной клиники, — и чинится она одним действием на одной и той
 * же машине («получите новый ключ подключения»). Заведи мы здесь свои коды,
 * владелец читал бы два разных совета про одну поломку. Обе НЕ входят в
 * RELAY_FALLBACK_REASONS, и правильно: резервный канал работает тем же ключом
 * и отказал бы ровно так же.
 */
export async function pullCatalogue(dataDir, {
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  now = () => Date.now(),
} = {}) {
  const pairing = readPairing(dataDir);
  if (!pairing) return { ok: false, reason: 'not_paired' };
  // Главный филиал ни у кого справочник не забирает — он его раздаёт. Иначе
  // получилось бы кольцо, в котором ничья цена не является правдой.
  if (pairing.role !== 'secondary') return { ok: false, reason: 'not_secondary' };

  const ts = String(now());
  const url = pairing.main_url.replace(/\/+$/, '') + CATALOGUE_PATH;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'x-em-branch-group': pairing.group_id,
        'x-em-branch-ts': ts,
        'x-em-branch-sig': signRequest({
          secret: pairing.secret,
          groupId: pairing.group_id,
          ts,
          requestPath: CATALOGUE_PATH,
        }),
        // STAFF_SYNC_SEAL_V1 — «я умею распечатать». Заголовок ставится ТОЛЬКО
        // при наличии ключа группы: филиал, связанный старым ключом EMB1,
        // расшифровать ответ не смог бы, и попросив запечатанное, он остался бы
        // и без прайса. Без заголовка он получает прежнее открытое тело, но уже
        // без сотрудников — то есть теряет ровно то, чего всё равно не смог бы
        // прочитать.
        ...(pairing.group_key ? { [ACCEPT_HEADER]: SEALED_FORM } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // DNS, отказ в соединении, таймаут — всё это одно и то же для филиала:
    // главный сейчас недоступен. Различать дальше нечего, действие одно.
    return { ok: false, reason: 'offline' };
  }

  if (!res.ok) {
    if (res.status === 401) {
      // Единственная причина, которую отдающая сторона называет вслух — и
      // только уже проверенной стороне (см. routes/branch-sync.js).
      let code = null;
      try { code = JSON.parse(await readBounded(res, 64 * 1024) || '{}')?.error?.code ?? null; } catch { code = null; }
      return { ok: false, reason: code === 'clock_skew' ? 'clock_skew' : 'unauthorized' };
    }
    // 404 — по этому адресу отвечает Easy-Med, но он не главный филиал (или
    // адрес указывает на установку, где пару стёрли). Отдельная причина,
    // потому что чинится это не переключением ключа, а адресом.
    if (res.status === 404) return { ok: false, reason: 'not_main' };
    return { ok: false, reason: 'server_error' };
  }

  let text = null;
  try { text = await readBounded(res, maxResponseBytes); } catch { text = null; }
  // readBounded возвращает null ровно в одном случае — тело переросло потолок.
  if (text === null) return { ok: false, reason: 'too_large' };

  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.ok !== true) {
    return { ok: false, reason: 'bad_response' };
  }
  // STAFF_SYNC_SEAL_V1 — ДВЕ ФОРМЫ ОТВЕТА, и обе обязаны работать.
  //
  //   { ok, v: 2, sealed: '<base64>' }   — главный филиал 0.8 и новее;
  //   { ok, group_id, catalogue: {…} }   — главный филиал 0.7.x, который про
  //                                        запечатывание ещё не знает.
  //
  // Вторая принимается не из мягкости, а потому что иначе обновившийся филиал
  // перестал бы получать прайс от ещё не обновлённой главной клиники — то же
  // самое отваливание парка, от которого в pairing.js защищает приём ключей
  // EMB1. Сотрудников в таком теле не будет: их туда не кладёт ни старая
  // главная клиника (она их не выгружает вовсе), ни новая (см.
  // withoutSealedTables в routes/branch-sync.js).
  let payload = body;
  if (body.v === 2 || body.sealed !== undefined) {
    if (typeof body.sealed !== 'string' || !body.sealed) return { ok: false, reason: 'bad_response' };
    const opened = openPayload(pairing.group_key, Buffer.from(body.sealed, 'base64'));
    if (!opened.ok) {
      // no_key — ключа нет вовсе (связывание старым EMB1); bad_key — тег не
      // сошёлся: ключи разъехались ЛИБО кто-то подменил байты по дороге.
      // Различить второе и третье невозможно в принципе, и не нужно: действие
      // одно — не применять ничего.
      if (opened.reason === 'no_key') return { ok: false, reason: 'relay_no_key' };
      if (opened.reason === 'bad_key') return { ok: false, reason: 'relay_bad_key' };
      return { ok: false, reason: 'bad_response' };
    }
    payload = opened.payload;
    if (payload.ok !== true) return { ok: false, reason: 'bad_response' };
  }

  const catalogue = payload.catalogue;
  if (!catalogue || typeof catalogue !== 'object' || Array.isArray(catalogue)) {
    return { ok: false, reason: 'bad_response' };
  }

  // Ответ от нашей ли группы. Подпись это уже доказала (её нельзя посчитать без
  // секрета), но ответ мог прийти от УСТАНОВКИ ТОЙ ЖЕ группы после того, как
  // владелец перевыпустил ключ и адрес стал указывать в другое место. Дешёвая
  // проверка на очевидную рассинхронизацию, а не защита. У запечатанной формы
  // это поле берётся ИЗНУТРИ блоба — там его прикрывает тег, снаружи бы оно
  // ничего не значило.
  if (typeof payload.group_id === 'string' && payload.group_id && payload.group_id !== pairing.group_id) {
    return { ok: false, reason: 'bad_response' };
  }

  return { ok: true, group_id: pairing.group_id, catalogue, main_url: pairing.main_url };
}
