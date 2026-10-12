// PUBLIC_SERVER_V1 — КЛИНИКИ НА ПУБЛИЧНОМ СЕРВЕРЕ: кто (лицензия), что
// показывает партнёрам (снимок, время), кому (подключения — отпечатки ключей).
//
// ЛИЦЕНЗИЯ — САМАЯ НОВАЯ ИЗ ВИДЕННЫХ (по issued_at). Клиника сама выбирает,
// какой licence.dat приложить; положи она старую лицензию без отметки «не
// оплачено» — решение владельца 17 обходилось бы. Поэтому состояние и
// отпечаток ключа берутся из самой новой лицензии: старая лицензия доказывает
// личность, только если её ключ — тот же, что в новой (иначе 401
// licence_outdated: ключ клиники сменили, старый больше не говорит за неё).
//
// ВСЁ, ЧТО ПРИСЛАЛА КЛИНИКА, — НЕ СТАРШЕ ПРЕЖНЕГО: ключи, снимок и время с
// generated_at раньше сохранённого не применяются (повтор перехваченного старого
// запроса не включит обратно выключенный ключ). Часы клиники при этом не дальше
// PUBLIC_SYNC_SKEW_MIN от сервера (clinic-auth.js), так что после исправления
// часов клиники обновления ждут не дольше этого допуска.
import crypto from 'node:crypto';
import { SCOPES, normalizeSlug, slugProblem } from '../../../public/js/shared/api-connections.js';
import { isoOf, msOf } from '../lib/time.js';

export const SLUG_ALIAS_DAYS = 30;
const DAY = 86400000;
const KEY_HASH_RE = /^[0-9a-f]{64}$/;
const ORIGIN_RE = /^https?:\/\/[^\s/]+$/i;
const MAX_CONNECTIONS = 200;

export const clinicRow = (db, clinicId) => db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get(clinicId) || null;

/**
 * Клиника прошла проверку подписи (clinic-auth.js) — записать её и лицензию.
 * @returns {{ok:true, clinic:object} | {ok:false, code:'licence_outdated'}}
 */
export function admitClinic(db, auth, now) {
  const at = isoOf(now);
  const row = clinicRow(db, auth.clinicId);
  const presented = msOf(auth.licence.issued_at) || 0;
  if (!row) {
    db.prepare(`INSERT INTO clinics (clinic_id, key_fp, licence_issued_at, licence_valid_until, licence_subscription, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(auth.clinicId, auth.fingerprint, auth.licence.issued_at, auth.licence.valid_until, auth.licence.subscription, at, at);
    return { ok: true, clinic: clinicRow(db, auth.clinicId) };
  }
  const stored = msOf(row.licence_issued_at) || 0;
  if (presented >= stored) {
    // Новый ключ клиники (ПК заменили) — прежний ящик больше не её: новые
    // заявки ждут, пока клиника пришлёт новый box_key (PUT /keys, тот же такт).
    const box = row.key_fp === auth.fingerprint ? row.box_key : null;
    db.prepare(`UPDATE clinics SET key_fp = ?, box_key = ?, licence_issued_at = ?, licence_valid_until = ?, licence_subscription = ?,
                last_seen_at = ? WHERE clinic_id = ?`)
      .run(auth.fingerprint, box, auth.licence.issued_at, auth.licence.valid_until, auth.licence.subscription, at, auth.clinicId);
    return { ok: true, clinic: clinicRow(db, auth.clinicId) };
  }
  if (row.key_fp !== auth.fingerprint) return { ok: false, code: 'licence_outdated' };
  db.prepare('UPDATE clinics SET last_seen_at = ? WHERE clinic_id = ?').run(at, auth.clinicId);
  return { ok: true, clinic: clinicRow(db, auth.clinicId) };
}

/**
 * То же решение, что admitClinic, но ничего не пишет: канал клиники отвечает
 * licence_outdated и 503 licence_lapsed ДО чтения тела и до проверки подписи
 * (ревью 8b, C1), а записывает клинику только после подписи.
 * @returns {{ok:true, licence:{licence_valid_until:string, licence_subscription:string}} | {ok:false, code:'licence_outdated'}}
 */
export function admissionOf(db, auth) {
  const row = clinicRow(db, auth.clinicId);
  const presented = { licence_valid_until: auth.licence.valid_until, licence_subscription: auth.licence.subscription };
  if (!row || (msOf(auth.licence.issued_at) || 0) >= (msOf(row.licence_issued_at) || 0)) return { ok: true, licence: presented };
  if (row.key_fp !== auth.fingerprint) return { ok: false, code: 'licence_outdated' };
  return { ok: true, licence: row };
}

/** Присланное не старше сохранённого (повтор старого запроса не откатывает). */
const notOlder = (generatedAt, storedAt) => !storedAt || (msOf(generatedAt) || 0) >= (msOf(storedAt) || 0);

function boxKeyOk(b64) {
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(String(b64 || ''), 'base64'), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'x25519';
  } catch { return false; }
}

const strings = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

/**
 * Одно подключение из PUT /keys. Неверное поле не роняет весь список (иначе
 * клиника не смогла бы выключить ни один ключ): права — только известные;
 * неверный срок — «истёк»; неверный отпечаток — подключение пропускается
 * (таким ключом не войти всё равно). IP проверяются при запросе: неверная
 * запись — ключ не пускается ни с какого адреса (routes/partner-auth.js).
 */
function connectionOf(c) {
  const id = Number(c && c.id);
  const hash = String((c && c.key_hash) || '').toLowerCase();
  if (!Number.isInteger(id) || id <= 0 || !KEY_HASH_RE.test(hash)) return null;
  const rate = Number(c.rate_limit);
  const exp = c.key_expires_at == null || c.key_expires_at === '' ? null : msOf(c.key_expires_at);
  return {
    id, kind: String(c.kind || '').slice(0, 16), active: c.active === true || c.active === 1 ? 1 : 0, key_hash: hash,
    scopes: JSON.stringify(SCOPES.filter((s) => strings(c.scopes).includes(s))),
    rate_limit: Number.isInteger(rate) && rate > 0 && rate <= 10000 ? rate : 60,
    key_expires_at: c.key_expires_at == null || c.key_expires_at === '' ? null : isoOf(exp == null ? 0 : exp),
    ip_allow: JSON.stringify(strings(c.ip_allow).slice(0, 50)),
    origins: JSON.stringify(strings(c.origins).filter((o) => ORIGIN_RE.test(o)).map((o) => o.toLowerCase()).slice(0, 10)),
  };
}

/** PUT /_sync/v1/keys — список подключений заменяется целиком. */
export function saveKeys(db, clinicId, body, now) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.connections) || body.connections.length > MAX_CONNECTIONS) return { error: 'bad_request' };
  if (!boxKeyOk(body.box_key)) return { error: 'bad_request' };
  const row = clinicRow(db, clinicId);
  if (!notOlder(body.generated_at, row.keys_at)) return { ok: true, ignored: true };
  const list = body.connections.map(connectionOf).filter(Boolean);
  if (new Set(list.map((c) => c.key_hash)).size !== list.length || new Set(list.map((c) => c.id)).size !== list.length) return { error: 'bad_request' };
  const used = new Map(db.prepare('SELECT id, last_used_at FROM connections WHERE clinic_id = ?').all(clinicId).map((r) => [r.id, r.last_used_at]));
  db.transaction(() => {
    db.prepare('UPDATE clinics SET box_key = ?, keys_at = ? WHERE clinic_id = ?').run(String(body.box_key), isoOf(msOf(body.generated_at) || now), clinicId);
    db.prepare('DELETE FROM connections WHERE clinic_id = ?').run(clinicId);
    const ins = db.prepare(`INSERT INTO connections (clinic_id, id, kind, active, key_hash, scopes, rate_limit, key_expires_at, ip_allow, origins, last_used_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of list) {
      ins.run(clinicId, c.id, c.kind, c.active, c.key_hash, c.scopes, c.rate_limit, c.key_expires_at, c.ip_allow, c.origins, used.get(c.id) || null);
    }
  })();
  return { ok: true, connections: list.length };
}

/**
 * Потолки снимка и времени (ревью 8b, C5; проверка исправлений 8b, C и E).
 * Списки — только объекты и не длиннее потолка; начала окон и строка свободы —
 * строки. Тело снимка и времени — не больше 4 МБ (routes/sync.js
 * SNAPSHOT_MAX_BYTES) и не больше PARSE_CONTAINERS_MAX объектов и списков
 * (parseBounded): 4 МБ пустых `{}` разбирались бы в ~90 МБ кучи. Клиника
 * размера дизайна (40 врачей × 30 дней, 2000 услуг) — ~0,75 МБ снимка и
 * ~0,6 МБ времени, ~15 тыс. объектов; 200 врачей × 30 дней — ~3 МБ времени.
 */
export const SNAPSHOT_LIMITS = Object.freeze({ branches: 200, doctors: 1000, services: 10000, packages: 2000,
  slotDoctors: 1000, slotDays: 62, slotStarts: 288 });
export const PARSE_CONTAINERS_MAX = 100000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Сколько объектов и списков в тексте JSON (скобки внутри строк не считаются). */
export function containersOf(text) {
  let n = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (inStr) {
      if (ch === 92) i += 1;            // \ — следующий знак экранирован
      else if (ch === 34) inStr = false;
    } else if (ch === 34) inStr = true;
    else if (ch === 123 || ch === 91) n += 1;   // { [
  }
  return n;
}

/**
 * Разбор тела клиники с потолком объектов и списков (проверка исправлений 8b, E):
 * сверх PARSE_CONTAINERS_MAX — не разбирается вовсе.
 * @returns {{value:any} | {error:'too_large'|'bad_json'}}
 */
export function parseBounded(text) {
  const s = String(text == null ? '' : text);
  if (!s.length) return { value: {} };
  if (containersOf(s) > PARSE_CONTAINERS_MAX) return { error: 'too_large' };
  try { return { value: JSON.parse(s) }; } catch { return { error: 'bad_json' }; }
}

function snapshotProblem(snap) {
  for (const k of ['branches', 'doctors', 'services', 'packages']) {
    const list = snap[k];
    if (list == null) continue;
    if (!Array.isArray(list)) return 'bad_request';
    if (list.length > SNAPSHOT_LIMITS[k]) return 'too_large';
    if (!list.every(isObj)) return 'bad_request';
  }
  return null;
}

function slotsProblem(slots) {
  const doctors = Object.values(slots.doctors);
  if (doctors.length > SNAPSHOT_LIMITS.slotDoctors) return 'too_large';
  for (const d of doctors) {
    if (!isObj(d)) return 'bad_request';
    if (d.days == null) continue;
    if (!Array.isArray(d.days)) return 'bad_request';
    if (d.days.length > SNAPSHOT_LIMITS.slotDays) return 'too_large';
    for (const day of d.days) {
      if (!isObj(day)) return 'bad_request';
      if (day.free != null && typeof day.free !== 'string') return 'bad_request';
      if (day.starts == null) continue;
      if (!Array.isArray(day.starts)) return 'bad_request';
      if (day.starts.length > SNAPSHOT_LIMITS.slotStarts) return 'too_large';
      if (!day.starts.every((x) => typeof x === 'string')) return 'bad_request';
    }
  }
  return null;
}

/**
 * PUT /_sync/v1/snapshot — снимок и имя в адресе. Имя занято другой клиникой
 * (или её прежним именем в течение 30 дней) — slug_taken. Своё прежнее имя
 * работает ещё SLUG_ALIAS_DAYS дней (макет: «старый адрес работает 30 дней»).
 */
export function saveSnapshot(db, clinicId, snap, now) {
  if (!snap || typeof snap !== 'object' || typeof snap.clinic !== 'object' || snap.clinic === null) return { error: 'bad_request' };
  const problem = snapshotProblem(snap);
  if (problem) return { error: problem };
  const slug = normalizeSlug(snap.slug);
  if (slugProblem(slug)) return { error: 'bad_slug' };
  const row = clinicRow(db, clinicId);
  if (!notOlder(snap.generated_at, row.snapshot_at)) return { ok: true, ignored: true };
  const at = isoOf(now);
  const owner = db.prepare('SELECT clinic_id FROM clinics WHERE slug = ? AND clinic_id <> ?').get(slug, clinicId);
  const alias = db.prepare('SELECT clinic_id FROM slug_aliases WHERE slug = ? AND clinic_id <> ? AND until_at > ?').get(slug, clinicId, at);
  if (owner || alias) return { error: 'slug_taken' };
  db.transaction(() => {
    if (row.slug && row.slug !== slug) {
      db.prepare('INSERT OR REPLACE INTO slug_aliases (slug, clinic_id, until_at) VALUES (?, ?, ?)')
        .run(row.slug, clinicId, isoOf(now + SLUG_ALIAS_DAYS * DAY));
    }
    db.prepare('DELETE FROM slug_aliases WHERE slug = ?').run(slug);
    db.prepare('UPDATE clinics SET slug = ?, snapshot = ?, snapshot_at = ? WHERE clinic_id = ?')
      .run(slug, JSON.stringify(snap), isoOf(msOf(snap.generated_at) || now), clinicId);
  })();
  return { ok: true };
}

/** PUT /_sync/v1/slots — свободное время («1» — свободно), без имён. */
export function saveSlots(db, clinicId, slots, now) {
  if (!slots || typeof slots !== 'object' || !slots.doctors || typeof slots.doctors !== 'object' || Array.isArray(slots.doctors)) return { error: 'bad_request' };
  const problem = slotsProblem(slots);
  if (problem) return { error: problem };
  const row = clinicRow(db, clinicId);
  if (!notOlder(slots.generated_at, row.slots_at)) return { ok: true, ignored: true };
  db.prepare('UPDATE clinics SET slots = ?, slots_at = ? WHERE clinic_id = ?').run(JSON.stringify(slots), isoOf(msOf(slots.generated_at) || now), clinicId);
  return { ok: true };
}

/** Клиника по имени в адресе — текущему или прежнему (30 дней); нет — null. */
export function resolveSlug(db, slug, now) {
  const s = normalizeSlug(slug);
  if (slugProblem(s)) return null;
  const row = db.prepare('SELECT * FROM clinics WHERE slug = ?').get(s);
  if (row) return row;
  const alias = db.prepare('SELECT clinic_id FROM slug_aliases WHERE slug = ? AND until_at > ?').get(s, isoOf(now));
  return alias ? clinicRow(db, alias.clinic_id) : null;
}

// Разобранные снимок и время — в памяти: снимок большой клиники — сотни
// килобайт, разбирать его на каждый запрос незачем.
//
// Ревью 8b, C5: одна запись на (клиника, вид), и она верна, пока текст в базе
// тот же (второй снимок в ту же секунду раньше не доходил до партнёров до
// 15 минут).
// Проверка исправлений 8b, E: потолок — по ОЦЕНКЕ КУЧИ разобранного (5 байт
// на знак текста — так выходит на настоящих снимках — плюс 32 байта на объект
// или список), всего не больше PARSE_CACHE_HEAP_MAX — четверть кучи службы
// (160 МБ); давние уходят первыми. Тело клиники ограничено 4 МБ и
// PARSE_CONTAINERS_MAX, так что любая запись (оценка до ~23 МБ) кэшируется:
// снимок и время большой клиники разбираются раз на изменение, а не на каждый
// запрос /slots.
export const PARSE_CACHE_HEAP_MAX = 40 * 1024 * 1024;
const heapOf = (text) => text.length * 5 + containersOf(text) * 32;
const cache = new Map();   // 'клиника:вид' → {text, value, heap}; порядок вставки — давность
let cacheChars = 0;
let cacheHeap = 0;
function parsedOf(clinic, kind) {
  const text = clinic && clinic[kind];
  if (!text) return null;
  const key = clinic.clinic_id + ':' + kind;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    if (hit.text === text) { cache.set(key, hit); return hit.value; }
    cacheChars -= hit.text.length;
    cacheHeap -= hit.heap;
  }
  let v = null;
  try { v = JSON.parse(text); } catch { v = null; }
  const heap = heapOf(text);
  if (heap <= PARSE_CACHE_HEAP_MAX) {
    while (cache.size && cacheHeap + heap > PARSE_CACHE_HEAP_MAX) {
      const [k0, e0] = cache.entries().next().value;
      cache.delete(k0);
      cacheChars -= e0.text.length;
      cacheHeap -= e0.heap;
    }
    cache.set(key, { text, value: v, heap });
    cacheChars += text.length;
    cacheHeap += heap;
  }
  return v;
}
/** Для тестов и наблюдения: записей, знаков текста и оценка кучи кэша разобранного. */
export const parseCacheStats = () => ({ entries: cache.size, bytes: cacheChars, heap: cacheHeap });
export const snapshotOf = (clinic) => parsedOf(clinic, 'snapshot');
export const slotsOf = (clinic) => parsedOf(clinic, 'slots');

/** Подключение по отпечатку ключа в этой клинике; нет — null. */
export function connectionByHash(db, clinicId, keyHash) {
  const c = db.prepare('SELECT * FROM connections WHERE clinic_id = ? AND key_hash = ?').get(clinicId, keyHash);
  if (!c) return null;
  const arr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
  return { ...c, scopes: arr(c.scopes), ip_allow: arr(c.ip_allow), origins: arr(c.origins) };
}

/** Активные подключения клиники, разрешившие этот сайт (CORS до ключа — предварительный запрос браузера). */
export function originAllowedForClinic(db, clinicId, origin) {
  const o = String(origin || '').toLowerCase();
  if (!o) return false;
  return db.prepare('SELECT origins FROM connections WHERE clinic_id = ? AND active = 1').all(clinicId)
    .some((r) => { try { return JSON.parse(r.origins).includes(o); } catch { return false; } });
}

/** «Последний запрос» подключения — не чаще раза в минуту на подключение (лишние записи в базу). */
export function markUsed(db, clinicId, connectionId, now) {
  db.prepare(`UPDATE connections SET last_used_at = ? WHERE clinic_id = ? AND id = ?
              AND (last_used_at IS NULL OR last_used_at <= ?)`).run(isoOf(now), clinicId, connectionId, isoOf(now - 60000));
}

