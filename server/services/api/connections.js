// CLINIC_API_STEP7_V1 — ПОДКЛЮЧЕНИЯ API: имя в адресе, подключения, журнал.
//
// База, без проверки прав: ворота стоят на границе RPC (rpc/api-connections.js),
// как у crm/config.js. Значение ключа или секрета появляется здесь при выпуске
// и при «Показать» и уходит только в ответ вызывающему — ни в журнал
// (api_journal: кто / что / когда), ни в console.
import {
  KEY_PREFIX, SECRET_PREFIX, DEFAULTS, normalizeSlug, slugProblem, suggestSlug, apiBaseUrl,
  normalizeConnection, connectionProblems, orderedScopes, orderedEvents, maskSecret, keyExpiresAt,
} from '../../../public/js/shared/api-connections.js';
import { loadKek, seal, unseal, keyHash, newApiKey, newWebhookSecret, tailOf } from './secret-box.js';
import { readDraft, dropDraft } from './drafts.js';
import { requirePartnerAddress } from './partner-address.js';
import { ensureApiSource, renameApiSource, archiveApiSource } from '../crm/config.js';

export class ApiConnectionError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}
export const SERVICE_MESSAGES = Object.freeze({
  slugFirst:        'Сначала задайте короткое имя клиники в адресе API.',
  draftGone:        'Окно нового подключения устарело: показанный ключ не сохранён. Закройте окно и откройте его заново — ключ будет другим.',
  siteIsAuto:       'Подключение сайта клиники создаётся само, когда задано имя в адресе.',
  notFound:         'Подключение не найдено — возможно, его удалили. Обновите страницу.',
  siteUrlInCompany: 'Адрес сайта клиники меняется в «Компании», поле «Сайт».',
  siteNoDelete:     'Подключение сайта клиники не удаляется — его можно выключить.',
  confirmKey:       'Подтвердите выпуск нового ключа: прежний перестанет подходить сразу.',
  confirmSecret:    'Подтвердите выпуск нового секрета: прежний перестанет подходить сразу.',
  confirmDelete:    'Подтвердите удаление подключения.',
  badWhat:          'Неизвестно, что открыть: ключ или секрет.',
});
// Название подключения сайта пишется в базу; экран переводит его tr().
export const SITE_NAME = 'Сайт клиники';

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => own(o, k)).map((k) => [k, o[k]]));
function checkOrThrow(problems) {
  const first = Object.values(problems)[0];
  if (first) throw new ApiConnectionError(first);
}

export function actorOf(db, user) {
  const id = Number(user && user.id);
  if (!(id > 0)) return { id: null, name: '' };
  const r = db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(id);
  return { id, name: (r && (r.full_name || r.username)) || '' };
}
export function journal(db, { connectionId = null, actor, action, detail = {} }) {
  db.prepare('INSERT INTO api_journal (connection_id, user_id, user_name, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(connectionId, actor.id, actor.name, action, JSON.stringify(detail));
}

// ---- «Компания» (шаг 3) — только чтение; SELECT *: база до мигр. 240 без колонок профиля
function docSettings(db) {
  try { return db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {}; } catch { return {}; }
}
export const slugSuggestion = (db) => { const d = docSettings(db); return suggestSlug(d.name_en, d.name_uz); };
export const companyWebsite = (db) => String(docSettings(db).website || '');
export const clinicName = (db) => String(docSettings(db).clinic_name || '');

// ---- строка подключения: ключ и секрет — шифротекстом и отпечатком ------------
function insertConnection(db, c, kek, actor) {
  const issued = nowIso();
  return Number(db.prepare(`INSERT INTO api_connections (kind, name, site_url, contact, scopes, active,
      crm_source_key, owns_source, key_hash, key_sealed, key_tail, key_issued_at, key_issued_by_name,
      key_ttl, key_expires_at, rate_limit, ip_allow, webhook_url, webhook_events, secret_sealed, secret_tail,
      created_at, created_by, created_by_name, updated_at)
    VALUES (@kind, @name, @site_url, @contact, @scopes, @active, @crm_source_key, @owns_source,
      @key_hash, @key_sealed, @key_tail, @issued, @actor_name, @key_ttl, @key_expires_at, @rate_limit, @ip_allow,
      @webhook_url, @webhook_events, @secret_sealed, @secret_tail, @issued, @actor_id, @actor_name, @issued)`).run({
    kind: c.kind, name: c.name, site_url: c.site_url || '', contact: c.contact || '',
    scopes: JSON.stringify(orderedScopes(c.scopes)), active: c.active ? 1 : 0,
    crm_source_key: c.source.key, owns_source: c.source.owns,
    key_hash: keyHash(c.key), key_sealed: seal(c.key, kek), key_tail: tailOf(c.key),
    issued, actor_name: actor.name, actor_id: actor.id,
    key_ttl: c.key_ttl, key_expires_at: keyExpiresAt(issued, c.key_ttl), rate_limit: c.rate_limit, ip_allow: c.ip_allow || '',
    webhook_url: c.webhook_url || '', webhook_events: JSON.stringify(orderedEvents(c.webhook_events)),
    secret_sealed: seal(c.secret, kek), secret_tail: tailOf(c.secret),
  }).lastInsertRowid);
}

// ---- список -----------------------------------------------------------------
const arr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
// Наружу — БЕЗ key_hash / key_sealed / secret_sealed: маска и хвост, не больше.
function rowOut(r) {
  return {
    id: r.id, kind: r.kind, name: r.name, site_url: r.site_url, contact: r.contact,
    scopes: arr(r.scopes), active: !!r.active,
    crm_source_key: r.crm_source_key, crm_source_label: r.crm_source_label || r.crm_source_key, owns_source: !!r.owns_source,
    key_mask: maskSecret(KEY_PREFIX, r.key_tail), key_issued_at: r.key_issued_at, key_issued_by_name: r.key_issued_by_name,
    key_ttl: r.key_ttl, key_expires_at: r.key_expires_at, rate_limit: r.rate_limit, ip_allow: r.ip_allow,
    webhook_url: r.webhook_url, webhook_events: arr(r.webhook_events), secret_mask: maskSecret(SECRET_PREFIX, r.secret_tail),
    last_used_at: r.last_used_at, created_at: r.created_at, created_by_name: r.created_by_name,
  };
}
const LIST_SQL = `SELECT c.*, s.label AS crm_source_label FROM api_connections c
  LEFT JOIN crm_sources s ON s.key = c.crm_source_key WHERE c.deleted_at IS NULL`;
export function listConnections(db) {
  return db.prepare(LIST_SQL + " ORDER BY c.kind <> 'site', c.id").all().map(rowOut);
}
export function liveRow(db, id) {
  const n = Number(id);
  const r = Number.isInteger(n) && n > 0
    ? db.prepare('SELECT * FROM api_connections WHERE id = ? AND deleted_at IS NULL').get(n) : null;
  if (!r) throw new ApiConnectionError(SERVICE_MESSAGES.notFound, 404);
  return r;
}
export function getConnection(db, id) {
  const r = db.prepare(LIST_SQL + ' AND c.id = ?').get(Number(id));
  if (!r) throw new ApiConnectionError(SERVICE_MESSAGES.notFound, 404);
  return rowOut(r);
}

// ---- имя в адресе и подключение сайта клиники ---------------------------------
export function readSlug(db) {
  const r = db.prepare('SELECT slug FROM api_settings WHERE id = 1').get();
  return (r && r.slug) || '';
}
// Р10 — подключение сайта клиники: одно, создаётся само ВЫКЛЮЧЕННЫМ (ключ ещё
// никому не передан; включение требует адреса для партнёров — решение 11).
// Адрес сайта — «Сайт» «Компании», в подключении его нет. Источник — «Сайт».
function createSiteConnection(db, actor, kek) {
  const d = DEFAULTS.site;
  const source = ensureApiSource(db, { kind: 'site' });
  const id = insertConnection(db, { kind: 'site', name: SITE_NAME, scopes: d.scopes, active: 0, source,
    key: newApiKey(), secret: newWebhookSecret(), key_ttl: d.key_ttl, rate_limit: d.rate_limit, webhook_events: d.events }, kek, actor);
  journal(db, { connectionId: id, actor, action: 'created', detail: { kind: 'site', auto: true, source: source.key } });
  return id;
}
export function saveSlug(db, value, actor, { kekPath } = {}) {
  const slug = normalizeSlug(value);
  const problem = slugProblem(slug);
  if (problem) throw new ApiConnectionError(problem);
  const from = readSlug(db);
  const needSite = !db.prepare("SELECT 1 FROM api_connections WHERE kind = 'site'").get();
  if (from === slug && !needSite) return { slug, base_url: apiBaseUrl(slug), site_created: false };
  const kek = needSite ? loadKek({ kekPath, create: true }) : null;   // файл — до транзакции
  let siteId = null;
  db.transaction(() => {
    if (from !== slug) {
      db.prepare('UPDATE api_settings SET slug = ?, updated_at = ?, updated_by = ? WHERE id = 1').run(slug, nowIso(), actor.id);
      journal(db, { actor, action: 'slug_saved', detail: { from, to: slug } });
    }
    if (needSite) siteId = createSiteConnection(db, actor, kek);
  })();
  return { slug, base_url: apiBaseUrl(slug), site_created: siteId != null };
}

// ---- новое подключение (Symptex, партнёр) -------------------------------------
const CREATE_FIELDS = ['kind', 'name', 'site_url', 'contact', 'scopes', 'webhook_url', 'webhook_events',
  'rate_limit', 'key_ttl', 'ip_allow', 'active'];
export function createConnection(db, input, actor, { draftId, kekPath } = {}) {
  const a = input || {};
  const d = DEFAULTS[a.kind] || DEFAULTS.partner;
  const v = normalizeConnection({ site_url: '', contact: '', webhook_url: '', webhook_events: [], ip_allow: '',
    rate_limit: d.rate_limit, key_ttl: d.key_ttl, active: true, ...pick(a, CREATE_FIELDS) });
  if (v.kind === 'site') throw new ApiConnectionError(SERVICE_MESSAGES.siteIsAuto, 409);
  checkOrThrow(connectionProblems(v));
  if (!readSlug(db)) throw new ApiConnectionError(SERVICE_MESSAGES.slugFirst, 409);
  if (v.active === 1) requirePartnerAddress(db);   // решение владельца 11
  const draft = readDraft(draftId, actor.id);
  if (!draft) throw new ApiConnectionError(SERVICE_MESSAGES.draftGone, 409);
  const kek = loadKek({ kekPath, create: true });
  let id;
  db.transaction(() => {
    const source = ensureApiSource(db, { kind: v.kind, name: v.name });
    id = insertConnection(db, { ...v, source, key: draft.key, secret: draft.secret }, kek, actor);
    journal(db, { connectionId: id, actor, action: 'created',
      detail: { kind: v.kind, name: v.name, scopes: orderedScopes(v.scopes), source: source.key, active: !!v.active } });
  })();
  dropDraft(draftId);
  return { connection: getConnection(db, id), key: draft.key, secret: draft.secret };
}

// ---- журнал ------------------------------------------------------------------
export function listJournal(db, { connectionId = null, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const one = connectionId != null && connectionId !== '';
  const rows = db.prepare(`SELECT j.*, c.name AS connection_name FROM api_journal j
    LEFT JOIN api_connections c ON c.id = j.connection_id
    ${one ? 'WHERE j.connection_id = ?' : ''} ORDER BY j.id DESC LIMIT ${lim}`).all(...(one ? [Number(connectionId)] : []));
  return rows.map((r) => {
    let detail = {};
    try { detail = JSON.parse(r.detail); } catch { detail = {}; }
    return { id: r.id, at: r.at, connection_id: r.connection_id, connection_name: r.connection_name || '',
      user_name: r.user_name, action: r.action, detail };
  });
}

// ---- правка ----------------------------------------------------------------------
const EDITABLE = ['name', 'site_url', 'contact', 'scopes', 'webhook_url', 'webhook_events', 'rate_limit', 'key_ttl', 'ip_allow', 'active'];
const JOURNAL_FIELDS = ['name', 'site_url', 'contact', 'scopes', 'webhook_url', 'webhook_events', 'rate_limit', 'key_ttl', 'ip_allow'];
// В журнал — адрес без запроса и якоря: партнёры кладут туда токены.
const urlForJournal = (u) => { if (!u) return ''; try { const x = new URL(u); return x.origin + x.pathname; } catch { return ''; } };
function journalDetail(row, sets, changed) {
  const d = { fields: changed };
  if (changed.includes('name')) d.name = { from: row.name, to: sets.name };
  if (changed.includes('scopes')) {
    const a = arr(row.scopes); const b = arr(sets.scopes);
    d.scopes = { added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) };
  }
  if (changed.includes('webhook_url')) d.webhook_url = { from: urlForJournal(row.webhook_url), to: urlForJournal(sets.webhook_url) };
  if (changed.includes('rate_limit')) d.rate_limit = { from: row.rate_limit, to: sets.rate_limit };
  if (changed.includes('key_ttl')) d.key_ttl = { from: row.key_ttl, to: sets.key_ttl };
  return d;
}

/** Правка подключения: только присланное и изменённое; включение — с адресом для партнёров. */
export function updateConnection(db, id, patch, actor) {
  const row = liveRow(db, id);
  const v = normalizeConnection(pick(patch, EDITABLE));
  if (row.kind === 'site' && own(v, 'site_url')) throw new ApiConnectionError(SERVICE_MESSAGES.siteUrlInCompany, 409);
  checkOrThrow(connectionProblems(v, { partial: true }));
  const next = {};
  for (const k of ['name', 'site_url', 'contact', 'webhook_url', 'rate_limit', 'ip_allow']) if (own(v, k)) next[k] = v[k];
  if (own(v, 'scopes')) next.scopes = JSON.stringify(orderedScopes(v.scopes));
  if (own(v, 'webhook_events')) next.webhook_events = JSON.stringify(orderedEvents(v.webhook_events));
  if (own(v, 'key_ttl')) next.key_ttl = v.key_ttl;
  const changed = JOURNAL_FIELDS.filter((k) => own(next, k) && String(next[k]) !== String(row[k]));
  const turnOn = own(v, 'active') && v.active === 1 && row.active === 0;
  const turnOff = own(v, 'active') && v.active === 0 && row.active === 1;
  if (!changed.length && !turnOn && !turnOff) return getConnection(db, row.id);
  if (turnOn) requirePartnerAddress(db);   // решение владельца 11
  const sets = {};
  for (const k of changed) sets[k] = next[k];
  if (changed.includes('key_ttl')) sets.key_expires_at = keyExpiresAt(row.key_issued_at, next.key_ttl);
  if (turnOn || turnOff) sets.active = turnOn ? 1 : 0;
  sets.updated_at = nowIso();
  db.transaction(() => {
    const cols = Object.keys(sets);   // имена колонок — из списков выше, не из запроса
    db.prepare(`UPDATE api_connections SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => sets[c]), row.id);
    if (changed.includes('name') && row.owns_source) renameApiSource(db, row.crm_source_key, sets.name);
    if (changed.length) journal(db, { connectionId: row.id, actor, action: 'updated', detail: journalDetail(row, sets, changed) });
    if (turnOn || turnOff) journal(db, { connectionId: row.id, actor, action: turnOn ? 'enabled' : 'disabled' });
  })();
  return getConnection(db, row.id);
}

// ---- ключ и секрет: показать, выпустить новый ------------------------------------
const WHAT = Object.freeze({
  key:    { col: 'key_sealed', revealed: 'key_revealed', regenerated: 'key_regenerated', confirm: 'confirmKey' },
  secret: { col: 'secret_sealed', revealed: 'secret_revealed', regenerated: 'secret_regenerated', confirm: 'confirmSecret' },
});
function whatOf(what) {
  const w = Object.prototype.hasOwnProperty.call(WHAT, what) ? WHAT[what] : null;
  if (!w) throw new ApiConnectionError(SERVICE_MESSAGES.badWhat);
  return w;
}
/** «Показать» / «Скопировать» (решение владельца 5). KEK не создаётся: для чтения нового ключа шифрования не бывает. */
export function revealSecret(db, id, what, actor, { kekPath } = {}) {
  const w = whatOf(what);
  const row = liveRow(db, id);
  const value = unseal(row[w.col], loadKek({ kekPath }));
  journal(db, { connectionId: row.id, actor, action: w.revealed });
  return value;
}
/** Новый ключ или секрет: прежний не подходит сразу (Р17); срок ключа — от новой выдачи. */
export function regenerateSecret(db, id, what, actor, { kekPath, confirm } = {}) {
  const w = whatOf(what);
  if (confirm !== true) throw new ApiConnectionError(SERVICE_MESSAGES[w.confirm]);
  const row = liveRow(db, id);
  const kek = loadKek({ kekPath, create: true });
  const value = what === 'key' ? newApiKey() : newWebhookSecret();
  const at = nowIso();
  db.transaction(() => {
    if (what === 'key') {
      db.prepare(`UPDATE api_connections SET key_hash = ?, key_sealed = ?, key_tail = ?, key_issued_at = ?,
          key_issued_by_name = ?, key_expires_at = ?, updated_at = ? WHERE id = ?`)
        .run(keyHash(value), seal(value, kek), tailOf(value), at, actor.name, keyExpiresAt(at, row.key_ttl), at, row.id);
    } else {
      db.prepare('UPDATE api_connections SET secret_sealed = ?, secret_tail = ?, updated_at = ? WHERE id = ?')
        .run(seal(value, kek), tailOf(value), at, row.id);
    }
    journal(db, { connectionId: row.id, actor, action: w.regenerated });
  })();
  return { value, connection: getConnection(db, row.id) };
}

// ---- удаление — архив (Р12) ----------------------------------------------------------
export function deleteConnection(db, id, actor, { confirm } = {}) {
  if (confirm !== true) throw new ApiConnectionError(SERVICE_MESSAGES.confirmDelete);
  const row = liveRow(db, id);
  if (row.kind === 'site') throw new ApiConnectionError(SERVICE_MESSAGES.siteNoDelete, 409);
  const at = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE api_connections SET deleted_at = ?, deleted_by = ?, active = 0, key_hash = '', key_sealed = '',
        key_tail = '', secret_sealed = '', secret_tail = '', updated_at = ? WHERE id = ?`).run(at, actor.id, at, row.id);
    if (row.owns_source) archiveApiSource(db, row.crm_source_key);
    journal(db, { connectionId: row.id, actor, action: 'deleted', detail: { name: row.name } });
  })();
  return { ok: true };
}
