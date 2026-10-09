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

// CRM_UNIFY_V1 — «Колонка записи» и «Колонка конверсии»: одно правило с экраном.
import { bookedStageKey, bookedStageCandidates, conversionRefusal } from '../../../public/js/shared/crm-booked-stage.js';
import { rpcT } from '../server-message.js';   // CRM_UNIFY_V1 — отказ с числом карточек переводится на экране

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

// CRM_HEAD_MERGE_TAGS_V1 — метки карточек (миграция 150). Справочника может не
// быть у базы, которую ещё не довели до 150 (сервер новее базы на один запуск
// не бывает, но экран не должен падать и тогда): пустой список, не ошибка.
const tagRow = (r) => ({
  key: r.key, label: r.label, color: r.color, position: r.position, is_active: !!r.is_active,
});
export function listTags(db) {
  try {
    return db.prepare('SELECT key, label, color, position, is_active FROM crm_tags ORDER BY position, key').all().map(tagRow);
  } catch (e) {
    return [];
  }
}

/**
 * CRM_HEAD_MERGE_TAGS_V1 (ревью M4) — можно ли ставить эти метки на заявку.
 * Скрытую метку экран не предлагает, а несуществующую отверг бы внешний ключ
 * голой ошибкой SQLite — /api/db отвечает на это фразой (400), а не 500.
 * Возвращает текст отказа или null.
 */
export function tagInsertRefusal(db, rows) {
  const keys = [...new Set((Array.isArray(rows) ? rows : [rows]).map((r) => String((r && r.tag_key) ?? '')))];
  const active = new Map(listTags(db).map((t) => [t.key, t.is_active]));
  for (const k of keys) {
    if (!active.has(k)) return `Метки «${k}» нет в справочнике — поставить её нельзя.`;
    if (!active.get(k)) return `Метка «${k}» скрыта в настройках CRM — поставить её нельзя.`;
  }
  return null;
}

export function listRouting(db, provider = DEFAULT_PROVIDER) {
  return db.prepare('SELECT provider, disposition, action, stage_key FROM crm_call_routing WHERE provider = ? ORDER BY disposition')
    .all(String(provider || DEFAULT_PROVIDER));
}

/** Everything the board and the settings screen both need, in one read. */
export function crmConfig(db) {
  return {
    stages: listStages(db), sources: listSources(db), routing: listRouting(db), tags: listTags(db),
    settings: { ...readCrmSettings(db), booked_effective: scheduledStageKey(db) },   // CRM_UNIFY_V1
  };
}

// --------------------------------------------------------------------------
// CRM_LINKS_V1 — the funnel read by BEHAVIOUR, not by name.
// --------------------------------------------------------------------------
//
// Migration 077's own header: «Переименовать "Пришёл" в "Дошёл" можно; сделать
// две конверсии — нет». `kind` is what carries that promise, and code that ACTS
// on the funnel (a visit closing a lead, the call-centre report counting one)
// must ask for the keys instead of carrying a copy of the seeded eight. A
// clinic that adds «Ждёт оплаты» is using the feature, not breaking it — and a
// hardcoded list answers such a column by silently doing nothing.
//
// Hidden columns COUNT here: is_active decides whether the BOARD offers the
// column, not whether the leads already sitting in it are still open.
//
// Defensive to the point of never throwing: openStageKeys runs inside
// ensure_visit's write path, and a funnel lookup must not be able to refuse a
// visit. A failed read falls back to the vocabulary migration 077 seeds.
const SEED_OPEN = Object.freeze(['in_process', 'recall', 'scheduled', 'approved']);
const SEED_WON = 'came';
const SEED_LOST = Object.freeze(['no_show', 'stopped', 'not_qualified']);
export const SEED_NO_SHOW_STAGE = 'no_show';
export const SEED_SCHEDULED_STAGE = 'scheduled';

function stageKeysOfKind(db, kind, fallback) {
  try {
    const rows = db.prepare('SELECT key FROM crm_stages WHERE kind = ? ORDER BY position, key').all(kind);
    return rows.length ? rows.map((r) => r.key) : [...fallback];
  } catch (e) {
    return [...fallback];
  }
}

/** Stages a lead is still ALIVE in. */
export function openStageKeys(db) { return stageKeysOfKind(db, 'open', SEED_OPEN); }

/** Stages a lead is lost in — the no-show column among them. */
export function lostStageKeys(db) { return stageKeysOfKind(db, 'lost', SEED_LOST); }

/** The one conversion column — schema-guaranteed unique, never undefined. */
export function wonStageKey(db) {
  const keys = stageKeysOfKind(db, 'won', [SEED_WON]);
  return keys[0] || SEED_WON;
}

/**
 * «Не пришёл»: the seeded column while the clinic still has it, otherwise the
 * first lost one. Guessing another lost column BY NAME would be worse than
 * naming the only thing that is known — that the lead is lost.
 */
export function noShowStageKey(db) {
  const lost = lostStageKeys(db);
  if (lost.includes(SEED_NO_SHOW_STAGE)) return SEED_NO_SHOW_STAGE;
  return lost[0] || null;
}

/**
 * CRM_REAL_BOOKING_V1 — «ЗАПИСАН»: КОЛОНКА ЗАЯВКИ, ДЕРЖАЩЕЙ НАСТОЯЩИЙ СЛОТ.
 *
 * Владелец (2026-09-21) развёл два разных факта, которые продукт до сих пор
 * записывал одним: «человека записали» и «человек пришёл». Первому нужна своя
 * колонка, и у сидовой воронки она есть — «Записан» (миграция 077).
 *
 * CRM_UNIFY_V1 — ОДНО ПРАВИЛО С ЭКРАНОМ (public/js/shared/crm-booked-stage.js):
 * «Колонка записи» — открытая ВИДИМАЯ колонка ДО «Пришёл». Выбор
 * администратора в «CRM-канбан» (crm_settings.booked_stage), если он допустим;
 * иначе «Записан», если она есть и видна; иначе последняя такая. Раньше здесь
 * бралась сидовая даже скрытая, иначе последняя открытая по порядку — и после
 * конверсии тоже, а экран брал первую видимую: у клиники записанные уезжали в
 * «Успешно». Все, кто двигает карточку при записи (crmLinkVisit — шаги E и G,
 * touchRequest зеркала, откат отмены в crmVisitStatus, отчёт колл-центра),
 * спрашивают здесь.
 *
 * Пустой или нечитаемый справочник — сидовая «Записан»: переход заявки не
 * вправе отказать в визите. null — только у воронки без единой открытой
 * видимой колонки до конверсии; звонящий обязан это пережить.
 */
export function scheduledStageKey(db) {
  let stages = [];
  try { stages = listStages(db); } catch (e) { stages = []; }
  if (!stages.length) return SEED_SCHEDULED_STAGE;
  return bookedStageKey(stages, readCrmSettings(db).booked_stage);
}

// --------------------------------------------------------------------------
// CRM_UNIFY_V1 — НАСТРОЙКИ «CRM-КАНБАН» ЭТОЙ УСТАНОВКИ (crm_settings, мигр. 237)
// --------------------------------------------------------------------------

export const DEFAULT_WINDOW_HOURS = 72;
const MAX_WINDOW_HOURS = 720;

/** Настройки этой установки. Нет таблицы (старая база) — значения по умолчанию. */
export function readCrmSettings(db) {
  try {
    const r = db.prepare('SELECT booked_stage, window_hours FROM crm_settings WHERE id = 1').get();
    return {
      booked_stage: (r && typeof r.booked_stage === 'string' && r.booked_stage) || null,
      window_hours: r && Number(r.window_hours) > 0 ? Number(r.window_hours) : DEFAULT_WINDOW_HOURS,
    };
  } catch (e) {
    return { booked_stage: null, window_hours: DEFAULT_WINDOW_HOURS };
  }
}

/**
 * CRM_UNIFY_V1 — ОКНО ПОВТОРНОГО ОБРАЩЕНИЯ, в часах: crm_settings.window_hours,
 * иначе 72. Одна точка для стойки (какие карточки закрывает регистрация,
 * crm/visit-link.js) и для окна звонка и записи (задача 6).
 */
export function windowHours(db) {
  return readCrmSettings(db).window_hours;
}

// Отказы — целые фразы без подстановок: экран переводит их словарём
// (i18n-strings.js), а собранную фразу словарь не узнаёт.
const BOOKED_REFUSAL = 'Колонка записи должна быть открытой видимой колонкой перед колонкой-конверсией.';
const CONVERSION_REFUSALS = {
  missing: 'Выбранной колонки нет в воронке — обновите страницу.',
  lost: 'Проигрышная колонка не может быть колонкой конверсии.',
  no_show: '«Не пришёл» не может быть колонкой конверсии.',
  hidden: 'Скрытая колонка не может быть колонкой конверсии.',
  booked_none: 'Перед колонкой конверсии нужна открытая видимая колонка — в неё переходят записанные.',
  booked_order: BOOKED_REFUSAL,
};

/**
 * Сохранить то, что прислали: { booked_stage?, won_stage?, window_hours? }.
 *
 * won_stage — «Колонка конверсии (пришёл)» (дополнение владельца 2026-10-09).
 * Не хранится: вид won переносится на выбранную колонку, прежняя конверсия
 * становится открытой. Сначала снимается старая, потом ставится новая —
 * частичный уникальный индекс crm_stages_one_won проверяется построчно. Всё —
 * внутри транзакции saveConfig: отказ колонки записи после переноса откатывает
 * и перенос.
 *
 * CRM_UNIFY_V1 (ревью задачи 4, решение контролёра) — КОНВЕРСИЯ ЭТО РОЛЬ, И
 * КАРТОЧКИ ИДУТ ЗА НЕЙ. Перенос вида без карточек оставлял всю историю
 * «Пришёл» в ставшей открытой колонке: обход уносил её в «Не пришёл», запись
 * колл-центра цеплялась к карточке 2025 года, стойка двигала старые карточки,
 * звонок бывшего пациента не заводил лида, отчёт проваливался. Поэтому:
 *   1. новая колонка обязана быть ПУСТОЙ (ни одной карточки любого вида) —
 *      иначе её живые карточки стали бы ложными конверсиями; отказ 409 с числом;
 *   2. той же транзакцией все карточки прежней конверсии переезжают в новую,
 *      updated_at НЕ меняется (окно повторного обращения и «последнее
 *      движение» не должны счесть историю свежей); перенос — в журнал
 *      crm_conversion_log (кто, откуда, куда, сколько); прежняя колонка
 *      остаётся пустой открытой;
 *   3. правила звонков, создававшие карточки в новой колонке, выключаются (как
 *      у скрытой колонки в saveStages): звонок не рождает конверсию.
 *
 * Колонка записи проверяется по воронке ПОСЛЕ переноса: присланная — или
 * сохранённая, если её не прислали (сохранённая, которая уже не действовала,
 * Р10, сбрасывается на правило по умолчанию).
 */
export function saveCrmSettings(db, s = {}, actorId = null) {
  const has = (k) => Object.prototype.hasOwnProperty.call(s, k);
  const cur = readCrmSettings(db);
  const next = { ...cur };
  let stages = listStages(db);

  let booked = cur.booked_stage && bookedStageCandidates(stages).includes(cur.booked_stage) ? cur.booked_stage : null;
  if (has('booked_stage')) booked = s.booked_stage == null || s.booked_stage === '' ? null : normKey(s.booked_stage);

  if (has('won_stage')) {
    const key = normKey(s.won_stage);
    const current = (stages.find((x) => x.kind === 'won') || {}).key || null;
    if (key !== current) {
      const why = conversionRefusal(stages, key, booked);
      if (why) throw new CrmConfigError(CONVERSION_REFUSALS[why] || BOOKED_REFUSAL);
      // CRM_UNIFY_V1 — 1. цель пустая.
      const n = db.prepare('SELECT COUNT(*) AS n FROM crm_requests WHERE status = ?').get(key).n;
      if (n) {
        const label = (stages.find((x) => x.key === key) || {}).label || key;
        throw rpcT(CrmConfigError, 'В колонке «{label}» карточек: {n} — сначала перенесите их в другие колонки.', { label, n }, 409);
      }
      db.prepare("UPDATE crm_stages SET kind = 'open' WHERE kind = 'won' AND key <> ?").run(key);
      db.prepare("UPDATE crm_stages SET kind = 'won' WHERE key = ?").run(key);
      // CRM_UNIFY_V1 — 2. конвертированные карточки идут за ролью; updated_at не трогается.
      const moved = current
        ? db.prepare('UPDATE crm_requests SET status = ? WHERE status = ?').run(key, current).changes
        : 0;
      db.prepare('INSERT INTO crm_conversion_log (moved_by, from_stage, to_stage, cards_moved) VALUES (?, ?, ?, ?)')
        .run(actorId, current, key, moved);
      // CRM_UNIFY_V1 — 3. звонок не заводит карточку прямо в конверсию.
      db.prepare("UPDATE crm_call_routing SET action = 'ignore', stage_key = NULL WHERE stage_key = ?").run(key);
      stages = listStages(db);
    }
  }

  if (booked && !bookedStageCandidates(stages).includes(booked)) throw new CrmConfigError(BOOKED_REFUSAL);
  next.booked_stage = booked;

  if (has('window_hours')) {
    const h = typeof s.window_hours === 'string' && s.window_hours.trim() !== '' ? Number(s.window_hours) : s.window_hours;
    if (!Number.isInteger(h) || h < 1 || h > MAX_WINDOW_HOURS) {
      throw new CrmConfigError('Окно повторного обращения — целое число часов от 1 до 720.');
    }
    next.window_hours = h;
  }
  db.prepare(`UPDATE crm_settings SET booked_stage = ?, window_hours = ?, changed_by = ?,
                     changed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1`)
    .run(next.booked_stage, next.window_hours, actorId);
  return readCrmSettings(db);
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
 *
 * CRM_UNIFY_V1 (ревью задачи 4, R5) — ВИД КОЛОНКИ ЗДЕСЬ НЕ МЕНЯЕТСЯ. Присланный
 * kind существующей колонки игнорируется (остаётся тот, что в базе), новая
 * колонка всегда открытая. Конверсию двигают только настройки «Колонка
 * конверсии» (saveCrmSettings: пустая цель, карточки идут за ролью, журнал).
 * Раньше устаревшая вкладка «Колонки» молча откатывала перенос конверсии, а
 * собранный руками запрос делал «Не пришёл» конверсией в обход проверок.
 */
export function saveStages(db, stages) {
  const kindOf = new Map(db.prepare('SELECT key, kind FROM crm_stages').all().map((r) => [r.key, r.kind]));   // CRM_UNIFY_V1
  const wanted = requireArray(stages, 'колонок').map((s, i) => {
    const key = normKey(s && s.key);
    checkKey(key, 'колонки');
    // Неизвестное слово по-прежнему отказ: экран с таким видом — сломан.
    const sent = String((s && s.kind) ?? 'open').trim();
    if (!STAGE_KINDS.includes(sent)) {
      throw new CrmConfigError(`Неизвестный тип колонки «${sent}» у «${key}».`);
    }
    return {
      key,
      label: normLabel(s && s.label, 'колонки'),
      color: normColor(s && s.color),
      kind: kindOf.has(key) ? kindOf.get(key) : 'open',   // CRM_UNIFY_V1 — вид из базы; новая — открытая
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
  // CRM_UNIFY_V1 — виды берутся из базы, поэтому «ни одной» значит одно: колонку
  // конверсии убрали из списка (удаление). Её сначала сменяют в настройках.
  if (!won.length && [...kindOf.values()].includes('won')) {
    throw new CrmConfigError('Колонку конверсии нельзя удалить — сначала выберите другую колонку конверсии.', 409);
  }
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

  // CRM_UNIFY_V1 — kind пишется только у НОВОЙ строки; у существующей его не
  // трогает и правка (ON CONFLICT … без kind). Снимать won со всех колонок перед
  // записью (как раньше) больше незачем: здесь он не переезжает никогда.
  const upsert = db.prepare(`INSERT INTO crm_stages (key, label, color, position, is_active, kind)
    VALUES (@key, @label, @color, @position, @is_active, @kind)
    ON CONFLICT(key) DO UPDATE SET label = excluded.label, color = excluded.color,
      position = excluded.position, is_active = excluded.is_active`);
  const unroute = db.prepare("UPDATE crm_call_routing SET action = 'ignore', stage_key = NULL WHERE stage_key = ?");
  const drop = db.prepare('DELETE FROM crm_stages WHERE key = ?');

  db.transaction(() => {
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
    // CRM_UNIFY_V1 (ревью задачи 4) — колонку записи скрыли, удалили или
    // переставили за конверсию: выбор стирается сразу (Р10 — правило по
    // умолчанию), а не ждёт, пока колонку покажут снова и он молча оживёт.
    const booked = readCrmSettings(db).booked_stage;
    if (booked && !bookedStageCandidates(listStages(db)).includes(booked)) {
      try { db.prepare('UPDATE crm_settings SET booked_stage = NULL WHERE id = 1').run(); }
      catch { /* база без 237 — выбора нет */ }
    }
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
  // CRM_MULTI_SOURCE_V1 — «стоит у заявки» это и главный source, и любой ключ
  // её sources (миграция 231): удалённый ключ остался бы в списке заявки
  // висеть без подписи, а её следующее сохранение сервер отказал бы как
  // «нет в справочнике».
  const leadCount = db.prepare(`SELECT COUNT(*) AS n FROM crm_requests
    WHERE source = ? OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(sources) AND json_type(sources) = 'array'
                                                            THEN sources ELSE '[]' END) AS s WHERE s.value = ?)`);
  for (const key of removed) {
    if (UNDELETABLE_SOURCE_KEYS.includes(key)) {
      throw new CrmConfigError(`Источник «${key}» удалить нельзя — на него ссылается сама система. Его можно скрыть.`, 409);
    }
    const n = leadCount.get(key, key).n;
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
// saveTags — CRM_HEAD_MERGE_TAGS_V1
// --------------------------------------------------------------------------

/**
 * Ordered array of `{ key, label, color, is_active }`; position is the index —
 * the same whole-list save as sources, so reorder + rename + recolour are one
 * transaction. Unlike sources, an EMPTY list is fine: a clinic that uses no
 * tags has none. A tag that sits on cards may be hidden but not deleted —
 * deleting it would silently strip those cards, and nobody could say which.
 */
export function saveTags(db, tags) {
  const wanted = requireArray(tags, 'меток').map((s, i) => {
    const key = normKey(s && s.key);
    checkKey(key, 'метки');
    return {
      key,
      label: normLabel(s && s.label, 'метки'),
      color: normColor(s && s.color),
      is_active: (s && s.is_active) === undefined ? 1 : (s.is_active ? 1 : 0),
      position: i + 1,
    };
  });

  const seen = new Set();
  for (const s of wanted) {
    if (seen.has(s.key)) throw new CrmConfigError(`Код метки «${s.key}» повторяется.`);
    seen.add(s.key);
  }

  const existing = db.prepare('SELECT key FROM crm_tags').all().map((r) => r.key);
  const removed = existing.filter((k) => !seen.has(k));
  const used = db.prepare('SELECT COUNT(*) AS n FROM crm_request_tags WHERE tag_key = ?');
  for (const key of removed) {
    const n = used.get(key).n;
    if (n) throw new CrmConfigError(`Метка «${key}» стоит на ${n} заявках — её можно только скрыть, но не удалить.`, 409);
  }

  const upsert = db.prepare(`INSERT INTO crm_tags (key, label, color, position, is_active)
    VALUES (@key, @label, @color, @position, @is_active)
    ON CONFLICT(key) DO UPDATE SET label = excluded.label, color = excluded.color,
      position = excluded.position, is_active = excluded.is_active`);
  const drop = db.prepare('DELETE FROM crm_tags WHERE key = ?');

  db.transaction(() => {
    for (const key of removed) drop.run(key);
    for (const s of wanted) upsert.run(s);
  })();

  return listTags(db);
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
 *
 * CRM_UNIFY_V1 — settings ({ booked_stage?, won_stage?, window_hours? }) идут
 * ПОСЛЕДНИМИ: выбранная колонка может быть добавлена в ту же правку. Кто
 * сохранил — третьим аргументом от RPC (вошедший), не из тела запроса.
 */
export function saveConfig(db, args = {}, { actorId = null } = {}) {
  const out = {};
  db.transaction(() => {
    if (args.stages !== undefined) out.stages = saveStages(db, args.stages);
    if (args.sources !== undefined) out.sources = saveSources(db, args.sources);
    if (args.routing !== undefined) out.routing = saveRouting(db, args.routing);
    if (args.tags !== undefined) out.tags = saveTags(db, args.tags);   // CRM_HEAD_MERGE_TAGS_V1
    if (args.settings !== undefined) {   // CRM_UNIFY_V1
      if (!args.settings || typeof args.settings !== 'object' || Array.isArray(args.settings)) {
        throw new CrmConfigError('Ожидались настройки CRM-канбана.');
      }
      out.settings = saveCrmSettings(db, args.settings, actorId);
    }
  })();
  // Always the full picture back, not just what was sent: saving columns can
  // change routing (a hidden column switches its rules off), and a screen that
  // redrew only what it posted would show the owner a stale routing card.
  return crmConfig(db);
}
