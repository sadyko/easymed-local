import { readBounded } from '../control/checkin.js';
import { readPairing, signRequest, CATALOGUE_PATH } from './pairing.js';

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
 *   not_main | server_error | too_large | bad_response
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
  const catalogue = body.catalogue;
  if (!catalogue || typeof catalogue !== 'object' || Array.isArray(catalogue)) {
    return { ok: false, reason: 'bad_response' };
  }

  // Ответ от нашей ли группы. Подпись это уже доказала (её нельзя посчитать без
  // секрета), но ответ мог прийти от УСТАНОВКИ ТОЙ ЖЕ группы после того, как
  // владелец перевыпустил ключ и адрес стал указывать в другое место. Дешёвая
  // проверка на очевидную рассинхронизацию, а не защита.
  if (typeof body.group_id === 'string' && body.group_id && body.group_id !== pairing.group_id) {
    return { ok: false, reason: 'bad_response' };
  }

  return { ok: true, group_id: pairing.group_id, catalogue, main_url: pairing.main_url };
}
