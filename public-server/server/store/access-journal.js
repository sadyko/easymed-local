// PUBLIC_SERVER_V1 — ЧТО ПОПАДАЕТ В ЖУРНАЛ ЗАПРОСОВ ПАРТНЁРОВ (проверка 8b, C6;
// проверка исправлений 8b, F).
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
//     запросы без ключа одной клиники — не больше keylessPerDay;
//   • У КАЖДОЙ КЛИНИКИ — СВОЙ БЮДЖЕТ строк на весь срок хранения (30 дней):
//     min(ACCESS_CLINIC_MAX, ACCESS_TOTAL_MAX / число клиник). Занятые ключи одной
//     клиники (ключ сайта по сути публичный) больше не вытесняют журнал других;
//     доля KEYLESS_SHARE бюджета — запас только для 401 без ключа (неверный ключ
//     клиника видит, даже когда её ключи выбрали свою часть);
//   • общий потолок ACCESS_TOTAL_MAX — только защита диска: сумма бюджетов его
//     не превышает, и до него доходит лишь то, что пишется мимо бюджетов;
//   • где журнал неполон — одна строка-отметка за сутки на подключение и
//     причину: method 'SKIP', status 0, path — причина ('key_day', 'keyless_day',
//     'clinic_budget', 'total'), at — с какого мига. Клиника получает её тем же
//     каналом, что журнал (GET /_sync/v1/inbox?access_after=…; экраны — 8d).
//     Отметки — тоже строки клиники и считаются в её бюджет (их не больше
//     «подключения + 1» на причину в сутки — доли процента бюджета).
// Счёт суток и счёт клиники держатся в памяти, а при первом запросе берутся из
// базы (перезапуск службы потолки не обнуляет); счёт клиники у потолка
// пересчитывается не чаще раза в RECOUNT_MS — уборка 30 дней освобождает место.
import { isoOf } from '../lib/time.js';
import { recordAccess } from './logs.js';

export const ACCESS_PER_KEY_PER_DAY = 5000;
export const ACCESS_KEYLESS_PER_DAY = 1000;
export const ACCESS_CLINIC_MAX = 200000;
export const ACCESS_TOTAL_MAX = 2000000;
export const KEYLESS_SHARE = 0.1;
export const RECOUNT_MS = 60000;
export const SKIP_METHOD = 'SKIP';

/**
 * @param {{perKeyPerDay?:number, keylessPerDay?:number, clinicMax?:number, totalMax?:number}} [o]
 * @returns {{admit:(db:object, e:{clinicId:string, connectionId:(number|null), status:number, now:number})=>boolean,
 *   stats:()=>{rate_limited:number, keyless:number, over_key_day:number, over_clinic:number, over_total:number}}}
 */
export function createAccessJournal({ perKeyPerDay = ACCESS_PER_KEY_PER_DAY, keylessPerDay = ACCESS_KEYLESS_PER_DAY,
  clinicMax = ACCESS_CLINIC_MAX, totalMax = ACCESS_TOTAL_MAX } = {}) {
  const dayCounts = new Map();
  const marked = new Set();
  const clinicRows = new Map();
  let clinicsSeen = { n: 0, at: -Infinity };
  let day = '';
  const skipped = { rate_limited: 0, keyless: 0, over_key_day: 0, over_clinic: 0, over_total: 0 };
  const stale = (at, now) => Math.abs(now - at) >= RECOUNT_MS;

  // Строки уходят только уборкой по возрасту (с начала), так что номер последней
  // минус номер первой — их число; два поиска по ключу таблицы, без перебора.
  const total = (db) => db.prepare('SELECT (SELECT MAX(id) FROM access_log) - (SELECT MIN(id) FROM access_log) + 1 AS n').get().n || 0;
  const today = (db, clinicId, connectionId, since) => db.prepare(
    'SELECT COUNT(*) AS n FROM access_log WHERE clinic_id = ? AND connection_id IS ? AND at >= ? AND status > 0').get(clinicId, connectionId, since).n;
  // Строки клиники — по индексу access_log_clinic.
  const clinicCount = (db, clinicId, now, refresh) => {
    let c = clinicRows.get(clinicId);
    if (!c || (refresh && stale(c.at, now))) {
      c = { n: db.prepare('SELECT COUNT(*) AS n FROM access_log WHERE clinic_id = ?').get(clinicId).n, at: now };
      clinicRows.set(clinicId, c);
    }
    return c;
  };
  const budget = (db, now) => {
    if (stale(clinicsSeen.at, now)) clinicsSeen = { n: db.prepare('SELECT COUNT(*) AS n FROM clinics').get().n, at: now };
    return Math.max(1, Math.min(clinicMax, Math.floor(totalMax / Math.max(1, clinicsSeen.n))));
  };

  function refuse(db, reason, counter, { clinicId, connectionId, now }) {
    skipped[counter] += 1;
    const mark = [day, clinicId, connectionId == null ? '' : connectionId, reason].join('|');
    if (!marked.has(mark)) {
      marked.add(mark);
      recordAccess(db, { clinicId, connectionId, at: isoOf(now), method: SKIP_METHOD, path: reason, status: 0 });
    }
    return false;
  }

  function admit(db, { clinicId, connectionId = null, status, now }) {
    if (status === 429) { skipped.rate_limited += 1; return false; }
    const keyless = connectionId == null;
    if (keyless && status !== 401) { skipped.keyless += 1; return false; }
    const d = isoOf(now).slice(0, 10);
    if (d !== day) { day = d; dayCounts.clear(); marked.clear(); }
    const e = { clinicId, connectionId: keyless ? null : connectionId, now };
    const k = clinicId + '|' + (keyless ? '' : connectionId);
    let n = dayCounts.get(k);
    if (n === undefined) { n = today(db, clinicId, e.connectionId, d + 'T00:00:00Z'); dayCounts.set(k, n); }
    if (n >= (keyless ? keylessPerDay : perKeyPerDay)) return refuse(db, keyless ? 'keyless_day' : 'key_day', 'over_key_day', e);
    const b = budget(db, now);
    const limit = keyless ? b : b - Math.ceil(b * KEYLESS_SHARE);
    let c = clinicCount(db, clinicId, now, false);
    if (c.n >= limit) c = clinicCount(db, clinicId, now, true);
    if (c.n >= limit) return refuse(db, 'clinic_budget', 'over_clinic', e);
    if (total(db) >= totalMax) return refuse(db, 'total', 'over_total', e);
    dayCounts.set(k, n + 1);
    c.n += 1;
    return true;
  }

  return { admit, stats: () => ({ ...skipped }) };
}
