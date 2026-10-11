// PUBLIC_SERVER_V1 — ЧТО ПОПАДАЕТ В ЖУРНАЛ ЗАПРОСОВ ПАРТНЁРОВ (проверка 8b, C6).
//
// Журнал запросов (store/logs.js recordAccess, 30 дней) — для клиники: кто и
// что спрашивал её ключом. Писать в него КАЖДЫЙ запрос значило бы дать любому из
// интернета наполнять общий диск машины (Symptex, n8n — решение 16): одним IP —
// до 1200 строк в минуту. Поэтому строкой становится не всё:
//   • 429 (любой лимит) — никогда: только счётчик (stats().rate_limited);
//   • без ключа — только 401 (кто-то стучится неверным ключом — клинике это
//     важно знать; их и так не больше 30 в минуту с IP — лимит неверных ключей),
//     прочие отказы без ключа (503, 400 https) — только счётчик;
//   • в сутки (UTC) на одно подключение — не больше perKeyPerDay строк, на
//     запросы без ключа одной клиники — не больше keylessPerDay: ключ сайта
//     клиники по сути публичный, так что потолок нужен и строкам с ключом;
//   • всего строк — не больше totalMax (уборка 30 дней освобождает место).
// Счёт суток держится в памяти, а при первом за сутки запросе подключения
// берётся из базы — перезапуск службы потолок не обнуляет.
import { isoOf } from '../lib/time.js';

export const ACCESS_PER_KEY_PER_DAY = 20000;
export const ACCESS_KEYLESS_PER_DAY = 1000;
export const ACCESS_TOTAL_MAX = 1000000;

/**
 * @param {{perKeyPerDay?:number, keylessPerDay?:number, totalMax?:number}} [o]
 * @returns {{admit:(db:object, e:{clinicId:string, connectionId:(number|null), status:number, now:number})=>boolean,
 *   stats:()=>{rate_limited:number, keyless:number, over_key_day:number, over_total:number}}}
 */
export function createAccessJournal({ perKeyPerDay = ACCESS_PER_KEY_PER_DAY, keylessPerDay = ACCESS_KEYLESS_PER_DAY,
  totalMax = ACCESS_TOTAL_MAX } = {}) {
  const counts = new Map();
  let day = '';
  const skipped = { rate_limited: 0, keyless: 0, over_key_day: 0, over_total: 0 };

  // Строки уходят только уборкой по возрасту (с начала), так что номер последней
  // минус номер первой — их число; два поиска по ключу таблицы, без перебора.
  const total = (db) => db.prepare('SELECT (SELECT MAX(id) FROM access_log) - (SELECT MIN(id) FROM access_log) + 1 AS n').get().n || 0;
  const today = (db, clinicId, connectionId, since) =>
    db.prepare('SELECT COUNT(*) AS n FROM access_log WHERE clinic_id = ? AND connection_id IS ? AND at >= ?').get(clinicId, connectionId, since).n;

  function admit(db, { clinicId, connectionId = null, status, now }) {
    if (status === 429) { skipped.rate_limited += 1; return false; }
    const keyless = connectionId == null;
    if (keyless && status !== 401) { skipped.keyless += 1; return false; }
    const d = isoOf(now).slice(0, 10);
    if (d !== day) { day = d; counts.clear(); }
    const k = clinicId + '\n' + (keyless ? '' : connectionId);
    let n = counts.get(k);
    if (n === undefined) n = today(db, clinicId, keyless ? null : connectionId, d + 'T00:00:00Z');
    if (n >= (keyless ? keylessPerDay : perKeyPerDay)) { counts.set(k, n); skipped.over_key_day += 1; return false; }
    if (total(db) >= totalMax) { counts.set(k, n); skipped.over_total += 1; return false; }
    counts.set(k, n + 1);
    return true;
  }

  return { admit, stats: () => ({ ...skipped }) };
}
