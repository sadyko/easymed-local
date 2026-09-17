// TELEPHONY_PROVIDERS_V1 (2026-09-14) — провайдеры телефонии кроме Binotel.
//
// Binotel остаётся в telephony_settings (одна строка, свой опрос, свои
// вебхуки, свой экран — settings.js). Здесь — все остальные: строка на
// провайдера в telephony_providers, открытые настройки в config (JSON),
// секреты в secret (JSON) — и наружу секреты не выходят никогда: экран видит
// только «ключ сохранён».
//
// Видов два: onlinePBX и «Мои Звонки». Третий добавляется строкой в KINDS и
// своим клиентом; таблица, права и экран не меняются.
//
// ГДЕ ЛЕЖИТ ВИД ПОДКЛЮЧЕНИЯ, и почему не в колонке kind (миграция 135).
// Колонка kind заведена (миграция 126) с ограничением CHECK (kind IN
// ('onlinepbx')): «Мои Звонки» в неё физически не вставляются. Расширить CHECK
// в SQLite можно только пересборкой таблицы — то есть удалив старую, а этого
// правило миграций не разрешает; вдобавок на эту таблицу смотрит внешний ключ
// calls.provider_id, и пересборка оторвала бы от подключений уже собранные
// звонки. Поэтому настоящий вид живёт в ДОБАВЛЕННОЙ колонке vendor, а kind
// остаётся историей: у каждой строки там 'onlinepbx' независимо от вида.
//
// ЧИТАТЬ НАДО vendor (через providerKind ниже) И НИКОГДА kind. Это закреплено
// тестом: запрос с фильтром по kind молча потеряет «Мои Звонки».
import { pbxAuth, pbxCall, pbxHistory, normalizeDomain } from './onlinepbx.js';
import { mzHistory, normalizeMzDomain } from './moizvonki.js';   // MOIZVONKI_V1

export class ProviderError extends Error {
  constructor(message, status = 400) { super(message); this.message = message; this.status = status; }
}

export const KINDS = {
  onlinepbx: {
    label: 'onlinePBX',
    // Что видит браузер и что он вправе прислать.
    publicFields: ['domain', 'default_extension'],
    // Что хранится закрыто. auth_key вводит человек; key_id/key выдаёт провайдер.
    secretFields: ['auth_key'],
    // Без чего провайдера нельзя ВКЛЮЧИТЬ. Включённый провайдер без ключа — это
    // молчаливый отказ на каждом звонке вместо честного «заполните поля».
    requiredToEnable: { config: ['domain'], secret: ['auth_key'] },
    requiredMessage: 'Чтобы включить onlinePBX, укажите домен и ключ API.',
  },
  // MOIZVONKI_V1 (2026-09-17). Владелец: «do not hardcode the my calls. leave
  // only the fields for call and api (like in the pbx and binotel)» — поэтому
  // адрес и ключ живут ЗДЕСЬ, в тех же полях настроек, что у onlinePBX, а не в
  // коде. user_name — почта сотрудника: у «Моих Звонков» она и подписывает
  // запрос, и решает, чей телефон зазвонит (разбор — в moizvonki.js).
  moizvonki: {
    label: 'Мои Звонки',
    publicFields: ['domain', 'user_name'],
    secretFields: ['api_key'],
    requiredToEnable: { config: ['domain', 'user_name'], secret: ['api_key'] },
    requiredMessage: 'Чтобы включить «Мои Звонки», укажите адрес, почту сотрудника и ключ API.',
  },
};

const MIN_POLL = 10;
const MAX_POLL = 3600;

function parseJson(s, fallback) {
  try { const v = JSON.parse(s || ''); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; }
}

/**
 * Вид подключения строки. vendor — настоящий (миграция 135), kind — история:
 * у всех строк там 'onlinepbx' из-за старого CHECK. Пустой vendor значит, что
 * строка заведена до миграции, то есть onlinePBX.
 */
export function providerKind(row) {
  return String((row && (row.vendor || row.kind)) || '');
}

function rowToPublic(row) {
  const cfg = parseJson(row.config, {});
  const sec = parseJson(row.secret, {});
  const k = providerKind(row);
  const kind = KINDS[k] || { publicFields: [], secretFields: [] };
  const out = {
    id: row.id, kind: k, kind_label: kind.label || k, name: row.name,
    enabled: !!row.enabled, poll_interval_sec: row.poll_interval_sec,
    last_poll_at: row.last_poll_at || null, last_call_at: row.last_call_at || null,
    last_error: row.last_error || '', updated_at: row.updated_at || null,
    config: {}, secret_set: {},
  };
  for (const f of kind.publicFields) out.config[f] = cfg[f] == null ? '' : cfg[f];
  for (const f of kind.secretFields) out.secret_set[f] = !!(sec[f] && String(sec[f]).trim());
  // Ключ, выданный провайдером, — признак, что подключение хоть раз удалось.
  out.authorized = !!(sec.key_id && sec.key);
  return out;
}

export function listProviders(db) {
  return db.prepare('SELECT * FROM telephony_providers ORDER BY id').all().map(rowToPublic);
}

export function getProviderRow(db, id) {
  return db.prepare('SELECT * FROM telephony_providers WHERE id = ?').get(Number(id)) || null;
}

/**
 * Создать или изменить провайдера. Секрет с пустым значением НЕ стирает
 * сохранённый (та же защита, что у Binotel: форма с пустым полем — обычное
 * сохранение, а не «забудь ключ»). Смена auth_key сбрасывает выданную пару
 * key_id/key — её получат заново при первом обращении.
 */
export function saveProvider(db, args = {}, userId = null) {
  const existing = args.id ? getProviderRow(db, args.id) : null;
  if (args.id && !existing) throw new ProviderError('Провайдер не найден.', 404);
  const kind = existing ? providerKind(existing) : String(args.kind || '');
  const def = KINDS[kind];
  if (!def) throw new ProviderError('Неизвестный провайдер телефонии.', 400);

  const name = String(args.name == null ? (existing ? existing.name : def.label) : args.name).trim().slice(0, 80) || def.label;
  const cfg = existing ? parseJson(existing.config, {}) : {};
  const sec = existing ? parseJson(existing.secret, {}) : {};
  const inCfg = args.config && typeof args.config === 'object' ? args.config : {};
  const inSec = args.secret && typeof args.secret === 'object' ? args.secret : {};
  for (const f of def.publicFields) {
    if (inCfg[f] === undefined) continue;
    cfg[f] = f === 'domain' ? normalizeDomain(inCfg[f]) : String(inCfg[f] == null ? '' : inCfg[f]).trim().slice(0, 200);
  }
  for (const f of def.secretFields) {
    const v = inSec[f];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const next = String(v).trim().slice(0, 300);
    if (next !== sec[f]) { sec[f] = next; delete sec.key_id; delete sec.key; delete sec.key_at; }
  }
  let poll = existing ? existing.poll_interval_sec : 30;
  if (args.poll_interval_sec !== undefined) {
    const n = Number(args.poll_interval_sec);
    if (!Number.isFinite(n)) throw new ProviderError('Интервал опроса — число секунд.', 400);
    poll = Math.max(MIN_POLL, Math.min(MAX_POLL, Math.round(n)));
  }
  const enabled = args.enabled === undefined ? (existing ? !!existing.enabled : false) : !!args.enabled;
  // Проверка «чего не хватает, чтобы включить» описана У ВИДА, а не написана
  // здесь по имени: третий провайдер не должен требовать правки этой функции.
  const need = def.requiredToEnable || { config: [], secret: [] };
  if (enabled) {
    const missing = (need.config || []).some((f) => !String(cfg[f] || '').trim())
                 || (need.secret || []).some((f) => !String(sec[f] || '').trim());
    if (missing) throw new ProviderError(def.requiredMessage || 'Заполните настройки подключения.', 400);
  }

  if (existing) {
    db.prepare(`UPDATE telephony_providers SET name=@name, enabled=@enabled, config=@config, secret=@secret,
        poll_interval_sec=@poll, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=@id`)
      .run({ id: existing.id, name, enabled: enabled ? 1 : 0, config: JSON.stringify(cfg), secret: JSON.stringify(sec), poll });
    return rowToPublic(getProviderRow(db, existing.id));
  }
  // kind ЗАПОЛНЯЕТСЯ ЛЕГЕНДОЙ: старый CHECK принимает только 'onlinepbx', а
  // настоящий вид кладётся в vendor (миграция 135 объясняет, почему так).
  const info = db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret, poll_interval_sec)
      VALUES ('onlinepbx', @vendor, @name, @enabled, @config, @secret, @poll)`)
    .run({ vendor: kind, name, enabled: enabled ? 1 : 0, config: JSON.stringify(cfg), secret: JSON.stringify(sec), poll });
  return rowToPublic(getProviderRow(db, info.lastInsertRowid));
}

export function deleteProvider(db, id) {
  const row = getProviderRow(db, id);
  if (!row) throw new ProviderError('Провайдер не найден.', 404);
  db.prepare('DELETE FROM telephony_providers WHERE id = ?').run(row.id);
  return { ok: true };
}

/** Секреты — только серверу: опросу, проверке, звонку. */
export function providerSecrets(row) {
  return parseJson(row.secret, {});
}
export function providerConfig(row) {
  return parseJson(row.config, {});
}

function rememberKey(db, id) {
  return (c) => {
    const row = getProviderRow(db, id);
    if (!row) return;
    const sec = parseJson(row.secret, {});
    sec.key_id = c.key_id; sec.key = c.key; sec.key_at = new Date().toISOString();
    db.prepare('UPDATE telephony_providers SET secret = ? WHERE id = ?').run(JSON.stringify(sec), row.id);
  };
}

/** Опции клиента для этого провайдера: домен, ключи, обновление ключа. */
export function pbxOptions(db, row, extra = {}) {
  const sec = providerSecrets(row);
  const cfg = providerConfig(row);
  return {
    domain: cfg.domain || '',
    creds: sec.key_id && sec.key ? { key_id: sec.key_id, key: sec.key } : null,
    authKey: sec.auth_key || '',
    onRenew: rememberKey(db, row.id),
    ...extra,
  };
}

export function recordProviderPoll(db, id, { ok, error = '' } = {}) {
  db.prepare(`UPDATE telephony_providers SET last_poll_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), last_error = ? WHERE id = ?`)
    .run(ok ? '' : String(error || '').slice(0, 300), Number(id));
}

export function noteProviderCall(db, id, startedAtIso) {
  db.prepare(`UPDATE telephony_providers SET
      last_call_at = CASE WHEN last_call_at IS NULL OR last_call_at < @t THEN @t ELSE last_call_at END
    WHERE id = @id`).run({ id: Number(id), t: String(startedAtIso) });
}

export const TEST_MESSAGES = {
  bad_credentials: 'Домен или ключ API не подходят. Проверьте данные в панели onlinePBX.',
  offline:         'Нет связи с onlinePBX. Проверьте интернет на этом компьютере.',
  server_error:    'onlinePBX ответил ошибкой. Попробуйте позже.',
  bad_response:    'Ответ onlinePBX не удалось разобрать. Попробуйте позже.',
  rate_limited:    'onlinePBX просит не чаще: подождите минуту и повторите.',
};

// Тот же набор причин, но ИМЕНЕМ ПРОВАЙДЕРА: администратор видит «Нет связи с
// „Моими Звонками“», а не «Нет связи с onlinePBX» на экране «Моих Звонков».
// TEST_MESSAGES остаётся как есть — на него уже ссылаются экран и тесты.
export function testMessage(reason, kind = 'onlinepbx') {
  const name = (KINDS[kind] && KINDS[kind].label) || 'телефония';
  const by = {
    bad_credentials: `Адрес или ключ API не подходят. Проверьте данные в личном кабинете «${name}».`,
    offline:         `Нет связи с «${name}». Проверьте интернет на этом компьютере.`,
    server_error:    `«${name}» ответили ошибкой. Попробуйте позже.`,
    bad_response:    `Ответ «${name}» не удалось разобрать. Попробуйте позже.`,
    rate_limited:    `«${name}» просят не чаще: подождите минуту и повторите.`,
  };
  if (kind === 'onlinepbx') return TEST_MESSAGES[reason] || TEST_MESSAGES.server_error;
  return by[reason] || by.server_error;
}

/**
 * «Проверить подключение»: введённые домен/ключ, если поля заполнены, иначе
 * сохранённые. Проверка — настоящий запрос истории за последнюю минуту:
 * ключ выдан, домен отвечает, история читается.
 */
export async function testProvider(db, args = {}, { pbxHistoryImpl = pbxHistory, pbxAuthImpl = pbxAuth, mzHistoryImpl = mzHistory } = {}) {
  const row = args.id ? getProviderRow(db, args.id) : null;
  const cfg = row ? providerConfig(row) : {};
  const sec = row ? providerSecrets(row) : {};
  const typed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

  // MOIZVONKI_V1 — у «Моих Звонков» нет выдаваемой пары ключей: подпись едет в
  // каждом запросе. Поэтому проверка короче — один безобидный запрос истории,
  // который никому не звонит.
  const kind = providerKind(row) || String(args.kind || 'onlinepbx');
  if (kind === 'moizvonki') {
    const mzDomain = normalizeMzDomain(typed(args.config && args.config.domain) || cfg.domain);
    const userName = typed(args.config && args.config.user_name) || cfg.user_name || '';
    const apiKey = typed(args.secret && args.secret.api_key) || sec.api_key || '';
    if (!mzDomain || !userName || !apiKey) return { ok: false, reason: 'bad_credentials', message: testMessage('bad_credentials', 'moizvonki') };
    const r = await mzHistoryImpl(mzDomain, Math.floor(Date.now() / 1000) - 60, { userName, apiKey });
    if (!r.ok) return { ok: false, reason: r.reason, message: testMessage(r.reason, 'moizvonki') };
    const list = r.data && (Array.isArray(r.data.calls) ? r.data.calls : (Array.isArray(r.data.result) ? r.data.result : []));
    return { ok: true, calls_last_minute: list.length };
  }

  const domain = normalizeDomain(typed(args.config && args.config.domain) || cfg.domain);
  const authKey = typed(args.secret && args.secret.auth_key) || sec.auth_key || '';
  if (!domain || !authKey) return { ok: false, reason: 'bad_credentials', message: TEST_MESSAGES.bad_credentials };
  // Введённый ключ отличается от сохранённого — проверяем именно его, без
  // кэша выданной пары.
  const useSaved = row && authKey === sec.auth_key && sec.key_id && sec.key;
  const opts = {
    domain, authKey,
    creds: useSaved ? { key_id: sec.key_id, key: sec.key } : null,
    onRenew: row && authKey === sec.auth_key ? rememberKey(db, row.id) : null,
  };
  if (!opts.creds) {
    const a = await pbxAuthImpl(domain, authKey);
    if (!a.ok) return { ok: false, reason: a.reason, message: TEST_MESSAGES[a.reason] || TEST_MESSAGES.server_error };
    opts.creds = { key_id: a.key_id, key: a.key };
    if (opts.onRenew) opts.onRenew(opts.creds);
  }
  const r = await pbxHistoryImpl(domain, Math.floor(Date.now() / 1000) - 60, opts);
  if (!r.ok) return { ok: false, reason: r.reason, message: TEST_MESSAGES[r.reason] || TEST_MESSAGES.server_error };
  return { ok: true, calls_last_minute: Array.isArray(r.data) ? r.data.length : 0 };
}

export { pbxCall };
