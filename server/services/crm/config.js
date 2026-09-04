// CRM_CONFIG_V1 — read/save for the CRM kanban vocabulary: columns, sources
// and the телефония disposition → column routing (migration 077).
//
// Database only, no role checks: the guard lives in rpc/crm-config.js at the
// RPC boundary, where every other guard in this codebase stands — so the
// telephony writer, which has no `user`, can call the list side of this module
// too. The exact shape (and reasoning) of telephony/settings.js.
//
// The reason this file is defensive out of proportion to its size: it is the
// only place that can BLANK THE CRM BOARD. A settings screen that saves an
// empty array, or deletes the column three hundred leads are sitting in, is
// not a cosmetic bug — it is a day of the call centre's work with nowhere to
// live. Every guard below is one such way to lose the board.

export class CrmConfigError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Keys end up in crm_requests.status/source, in /api/db filters and in the
// board's own DOM ids, so the alphabet is narrow on purpose (the plan's rule).
export const KEY_RE = /^[a-z0-9_]{1,32}$/;

// Binotel writes dispositions in upper case (ANSWER, VM-SUCCESS) and
// calls.disposition stores them verbatim — the routing key must match that
// spelling exactly or a rule silently never fires.
export const DISPOSITION_RE = /^[A-Z0-9_-]{1,32}$/;

// Token NAMES from Tag() in public/js/admin/ui.js, never free hex — the board
// keeps the house palette whatever the owner picks. '' is «no colour», which
// is how «Обработка остановлена» and «Нецелевой» look today.
export const STAGE_COLORS = Object.freeze(['info', 'warn', 'purple', 'teal', 'ok', 'crit', '']);
export const STAGE_KINDS = Object.freeze(['open', 'won', 'lost']);

export const DEFAULT_PROVIDER = 'binotel';

// Keys that may be renamed, recoloured, reordered and hidden — but NOT
// deleted, because code outside this table names them:
//   in_process / call  are the DEFAULTs of crm_requests.status/source, written
//                      by /api/db whenever a screen omits the field. A DEFAULT
//                      pointing at a deleted row turns every such INSERT into
//                      a foreign-key error.
//   telephony          is what lead-from-call.js writes as the source of a
//                      lead created from a phone call.
export const UNDELETABLE_STAGE_KEYS = Object.freeze(['in_process']);
export const UNDELETABLE_SOURCE_KEYS = Object.freeze(['call', 'telephony']);

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

const stageRow = (r) => ({
  key: r.key, label: r.label, color: r.color,
  position: r.position, is_active: !!r.is_active, kind: r.kind,
});
const sourceRow = (r) => ({
  key: r.key, label: r.label, position: r.position, is_active: !!r.is_active,
});

export function listStages(db) {
  // Inactive columns come back too, flagged: the settings screen must be able
  // to switch one back on, and the board needs to know a card's status still
  // has a label even when the column is hidden.
  return db.prepare('SELECT key, label, color, position, is_active, kind FROM crm_stages ORDER BY position, key')
    .all().map(stageRow);
}

export function listSources(db) {
  return db.prepare('SELECT key, label, position, is_active FROM crm_sources ORDER BY position, key')
    .all().map(sourceRow);
}

export function listRouting(db, provider = DEFAULT_PROVIDER) {
  return db.prepare('SELECT provider, disposition, action, stage_key FROM crm_call_routing WHERE provider = ? ORDER BY disposition')
    .all(String(provider || DEFAULT_PROVIDER));
}

/** Everything the board and the settings screen both need, in one read. */
export function crmConfig(db) {
  return { stages: listStages(db), sources: listSources(db), routing: listRouting(db) };
}

// --------------------------------------------------------------------------
// Shared normalisation
// --------------------------------------------------------------------------

// Typed keys are lower-cased rather than refused: «Recall» and «recall» are
// one column in the owner's head, and a screen that answered "bad key" to a
// capital letter would just be rude. The duplicate check below runs AFTER
// this, so folding can never quietly merge two columns into one.
function normKey(v) { return String(v ?? '').trim().toLowerCase(); }

function checkKey(key, what) {
  if (!KEY_RE.test(key)) {
    throw new CrmConfigError(`Недопустимый код «${key}» для ${what}: латиница, цифры и _ , до 32 символов.`);
  }
}

function normLabel(v, what) {
  const s = String(v ?? '').trim().slice(0, 64);
  if (!s) throw new CrmConfigError(`У ${what} должно быть название.`);
  return s;
}

// The plan writes the no-colour token as «none»; the value Tag() understands
// is the empty string. Accepted as an alias so the screen may send either —
// one vocabulary is stored, no translation layer anywhere else.
function normColor(v) {
  const s = String(v ?? '').trim();
  const c = s === 'none' ? '' : s;
  if (!STAGE_COLORS.includes(c)) {
    throw new CrmConfigError(`Неизвестный цвет «${s}». Доступны: ${STAGE_COLORS.filter(Boolean).join(', ')} или без цвета.`);
  }
  return c;
}

function requireArray(v, what) {
  if (!Array.isArray(v)) throw new CrmConfigError(`Ожидался список ${what}.`);
  return v;
}

// --------------------------------------------------------------------------
// saveStages — the WHOLE ordered array, one transaction
// --------------------------------------------------------------------------

/**
 * Takes the board as the screen has it: an ordered array of
 * `{ key, label, color, kind, is_active }`. Position is the array index, so
 * reorder + rename + recolour + add + hide are ONE save and ONE transaction —
 * which is what the screen actually does, and the only way a half-applied
 * reorder cannot leave two columns claiming position 3.
 */
export function saveStages(db, stages) {
  const wanted = requireArray(stages, 'колонок').map((s, i) => {
    const key = normKey(s && s.key);
    checkKey(key, 'колонки');
    const kind = String((s && s.kind) ?? 'open').trim();
    if (!STAGE_KINDS.includes(kind)) {
      throw new CrmConfigError(`Неизвестный тип колонки «${kind}» у «${key}».`);
    }
    return {
      key,
      label: normLabel(s && s.label, 'колонки'),
      color: normColor(s && s.color),
      kind,
      // Absent is_active means «active»: a screen that adds a column without
      // touching the toggle means to show it.
      is_active: (s && s.is_active) === undefined ? 1 : (s.is_active ? 1 : 0),
      position: i + 1,
    };
  });

  if (!wanted.length) throw new CrmConfigError('Оставьте хотя бы одну колонку канбана.');

  const seen = new Set();
  for (const s of wanted) {
    if (seen.has(s.key)) throw new CrmConfigError(`Код колонки «${s.key}» повторяется.`);
    seen.add(s.key);
  }

  const won = wanted.filter((s) => s.kind === 'won');
  // Exactly one conversion column, checked here as well as by the partial
  // unique index: the index would answer with a raw SQLite error, and the
  // owner needs a sentence. Two conversions is a fork with no owner — the
  // conversion is what registers a patient card.
  if (won.length !== 1) {
    throw new CrmConfigError(won.length
      ? 'Колонка-конверсия должна быть ровно одна.'
      : 'Отметьте одну колонку как конверсию — через неё заводится карта пациента.');
  }
  // Hiding the conversion column would remove the only path that registers a
  // patient, and leave the funnel with nowhere to record a win.
  if (!won[0].is_active) throw new CrmConfigError('Колонку-конверсию нельзя скрыть.');
  if (!wanted.some((s) => s.is_active)) throw new CrmConfigError('Хотя бы одна колонка должна быть видимой.');

  const existing = db.prepare('SELECT key FROM crm_stages').all().map((r) => r.key);
  const removed = existing.filter((k) => !seen.has(k));
  const leadCount = db.prepare('SELECT COUNT(*) AS n FROM crm_requests WHERE status = ?');
  for (const key of removed) {
    if (UNDELETABLE_STAGE_KEYS.includes(key)) {
      throw new CrmConfigError(`Колонку «${key}» удалить нельзя — она подставляется новым заявкам по умолчанию. Её можно скрыть.`, 409);
    }
    const n = leadCount.get(key).n;
    // Deactivate, never delete: the cards keep a status that still resolves to
    // a label, and the board simply stops offering the column.
    if (n) throw new CrmConfigError(`В колонке «${key}» ${n} заявок — её можно только скрыть, но не удалить.`, 409);
  }

  const upsert = db.prepare(`INSERT INTO crm_stages (key, label, color, position, is_active, kind)
    VALUES (@key, @label, @color, @position, @is_active, @kind)
    ON CONFLICT(key) DO UPDATE SET label = excluded.label, color = excluded.color,
      position = excluded.position, is_active = excluded.is_active, kind = excluded.kind`);
  const unroute = db.prepare("UPDATE crm_call_routing SET action = 'ignore', stage_key = NULL WHERE stage_key = ?");
  const drop = db.prepare('DELETE FROM crm_stages WHERE key = ?');
  const clearWon = db.prepare("UPDATE crm_stages SET kind = 'open' WHERE kind = 'won'");

  db.transaction(() => {
    // Handing the conversion from «Пришёл» to another column is a legitimate
    // edit, but the partial unique index is checked per ROW: setting the new
    // one first would collide with the old. So the flag is cleared from every
    // column BEFORE the upserts, and re-applied by them. At no point do two
    // columns claim it.
    clearWon.run();
    for (const key of removed) {
      // A rule that fed a column which no longer exists cannot stay 'create' —
      // the foreign key would refuse the delete, and a create rule pointing
      // nowhere would be a lead with no destination. The rule survives as
      // «не создавать», visibly, in the settings screen.
      unroute.run(key);
      drop.run(key);
    }
    for (const s of wanted) upsert.run(s);
    // Same reasoning for a column that was merely HIDDEN: a rule feeding a
    // column nobody can see produces leads that look lost. Flipping the rule
    // is the honest outcome, and it is visible on the routing card.
    for (const s of wanted) if (!s.is_active) unroute.run(s.key);
  })();

  return listStages(db);
}

// --------------------------------------------------------------------------
// saveSources
// --------------------------------------------------------------------------

/** Ordered array of `{ key, label, is_active }`; position is the index. */
export function saveSources(db, sources) {
  const wanted = requireArray(sources, 'источников').map((s, i) => {
    const key = normKey(s && s.key);
    checkKey(key, 'источника');
    return {
      key,
      label: normLabel(s && s.label, 'источника'),
      is_active: (s && s.is_active) === undefined ? 1 : (s.is_active ? 1 : 0),
      position: i + 1,
    };
  });

  if (!wanted.length) throw new CrmConfigError('Оставьте хотя бы один источник.');

  const seen = new Set();
  for (const s of wanted) {
    if (seen.has(s.key)) throw new CrmConfigError(`Код источника «${s.key}» повторяется.`);
    seen.add(s.key);
  }
  if (!wanted.some((s) => s.is_active)) throw new CrmConfigError('Хотя бы один источник должен быть видимым.');

  const existing = db.prepare('SELECT key FROM crm_sources').all().map((r) => r.key);
  const removed = existing.filter((k) => !seen.has(k));
  const leadCount = db.prepare('SELECT COUNT(*) AS n FROM crm_requests WHERE source = ?');
  for (const key of removed) {
    if (UNDELETABLE_SOURCE_KEYS.includes(key)) {
      throw new CrmConfigError(`Источник «${key}» удалить нельзя — на него ссылается сама система. Его можно скрыть.`, 409);
    }
    const n = leadCount.get(key).n;
    if (n) throw new CrmConfigError(`Источник «${key}» стоит у ${n} заявок — его можно только скрыть, но не удалить.`, 409);
  }

  const upsert = db.prepare(`INSERT INTO crm_sources (key, label, position, is_active)
    VALUES (@key, @label, @position, @is_active)
    ON CONFLICT(key) DO UPDATE SET label = excluded.label,
      position = excluded.position, is_active = excluded.is_active`);
  const drop = db.prepare('DELETE FROM crm_sources WHERE key = ?');

  db.transaction(() => {
    for (const key of removed) drop.run(key);
    for (const s of wanted) upsert.run(s);
  })();

  return listSources(db);
}

// --------------------------------------------------------------------------
// saveRouting
// --------------------------------------------------------------------------

/**
 * Array of `{ provider?, disposition, action, stage_key }`.
 *
 * UPSERT ONLY — rows absent from the payload are left alone, deliberately.
 * Binotel may add a disposition next year; an older settings screen saving
 * its shorter list must not silently drop the rule someone configured for it.
 * (Stages are the opposite: there the whole board IS the array.)
 */
export function saveRouting(db, rows) {
  const wanted = requireArray(rows, 'правил').map((r) => {
    const provider = normKey((r && r.provider) || DEFAULT_PROVIDER);
    checkKey(provider, 'АТС');
    const disposition = String((r && r.disposition) ?? '').trim().toUpperCase();
    if (!DISPOSITION_RE.test(disposition)) {
      throw new CrmConfigError(`Недопустимый статус звонка «${disposition}».`);
    }
    const action = String((r && r.action) ?? 'ignore').trim();
    if (action !== 'create' && action !== 'ignore') {
      throw new CrmConfigError(`Неизвестное действие «${action}» для статуса «${disposition}».`);
    }
    // 'ignore' forgets the column on purpose: keeping a stale stage_key on a
    // disabled rule is how a column deleted later becomes a foreign-key error
    // in a screen that has nothing to do with telephony.
    const stage_key = action === 'create' ? normKey(r && r.stage_key) : null;
    return { provider, disposition, action, stage_key };
  });

  const seen = new Set();
  for (const r of wanted) {
    const id = r.provider + '\0' + r.disposition;
    if (seen.has(id)) throw new CrmConfigError(`Статус звонка «${r.disposition}» указан дважды.`);
    seen.add(id);
  }

  const stage = db.prepare('SELECT key, is_active FROM crm_stages WHERE key = ?');
  for (const r of wanted) {
    if (r.action !== 'create') continue;
    const s = stage.get(r.stage_key);
    if (!s) throw new CrmConfigError(`Колонки «${r.stage_key}» не существует (статус «${r.disposition}»).`);
    // A rule may not aim at a hidden column: the lead would be created into a
    // column nobody sees, which reads to the clinic exactly like a lost lead.
    if (!s.is_active) throw new CrmConfigError(`Колонка «${r.stage_key}» скрыта — в неё нельзя направлять звонки.`);
  }

  const upsert = db.prepare(`INSERT INTO crm_call_routing (provider, disposition, action, stage_key)
    VALUES (@provider, @disposition, @action, @stage_key)
    ON CONFLICT(provider, disposition) DO UPDATE SET action = excluded.action, stage_key = excluded.stage_key`);

  db.transaction(() => { for (const r of wanted) upsert.run(r); })();

  return listRouting(db, wanted.length ? wanted[0].provider : DEFAULT_PROVIDER);
}

// --------------------------------------------------------------------------
// The whole screen, one save
// --------------------------------------------------------------------------

/**
 * Applies whichever of the three lists the screen sent, in ONE transaction.
 *
 * Order matters and is not alphabetical: stages first, because a routing rule
 * can only point at a column that already exists — saving a new column and a
 * rule aiming at it in the same request must work.
 *
 * better-sqlite3 nests transactions as SAVEPOINTs, so the per-list
 * transactions inside still behave as one atomic unit here.
 */
export function saveConfig(db, args = {}) {
  const out = {};
  db.transaction(() => {
    if (args.stages !== undefined) out.stages = saveStages(db, args.stages);
    if (args.sources !== undefined) out.sources = saveSources(db, args.sources);
    if (args.routing !== undefined) out.routing = saveRouting(db, args.routing);
  })();
  // Always the full picture back, not just what was sent: saving columns can
  // change routing (a hidden column switches its rules off), and a screen that
  // redrew only what it posted would show the owner a stale routing card.
  return crmConfig(db);
}
