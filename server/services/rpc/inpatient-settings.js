// INPATIENT_REQUIRED_V1 (2026-11-23) — ЧТО В СТАЦИОНАРЕ ОБЯЗАТЕЛЬНО: НАСТРОЙКИ КЛИНИКИ.
//
// Владелец: «in the stationary, we have a roadblocks as a unfilled title list,
// reception doctor filling, and others, we need to make some settings for that so
// we can switch the setup of the stationary documents lists as a required, not
// required fields».
//
// Одна строка настроек и журнал «кто менял» (миграция 298). Читается при КАЖДОМ
// запросе и не кэшируется — то же правило, что у набора документов (loadCaseDocSet):
// сервер живёт неделями, а клиника меняет настройку и ждёт её сразу. База старше 298
// читает умолчания — это поведение до этой правки, строка в строку.
//
// Модуль не импортирует inpatient-flow.js, inpatient-reviews.js, title-sheet.js и
// case-doc-types.js: они читают настройки ОТСЮДА, и обратный импорт замкнул бы кольцо.
// Поэтому и RpcError здесь свой (как в rpc/accommodation.js): маршрут смотрит на
// e.status, а не на класс.
import { hasAnyRole, effectiveRoles } from '../roles.js';
import { rpcT } from '../server-message.js';
import {
  SWITCH_KEYS, DEFAULT_TITLE_REQUIRED, TITLE_FIELD_KEYS,
  cleanTitleRequired, cleanRequiredSections, parseRequiredSections,
} from '../../../public/js/shared/inpatient-required.js';
import { sectionsFor } from '../../../public/js/shared/case-doc-sections.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// INPATIENT_REQUIRED_V1 (ревью) — ЧИТАЕТ ЛЮБОЙ ВОШЕДШИЙ. Списка ролей чтения больше нет:
// работу с документами стационара клиника выдаёт и другим ролям (requireGrant
// 'inpatient.patients' / 'inpatient.reviews'), и экран такого сотрудника, получив
// отказ, падал на правила по умолчанию — и спорил с сервером. Данных пациента в
// настройках нет. Аноним (нет пользователя или роли) по-прежнему получает отказ.
/**
 * Меняют те же, кто правит состав истории болезни. Это КОПИЯ DOC_TYPE_WRITE_ROLES:
 * case-doc-types.js импортирует этот модуль, обратный импорт замкнул бы кольцо.
 * Равенство списков держит тест (inpatient-settings.test.js).
 */
export const SETTINGS_WRITE_ROLES = ['admin', 'head_doctor'];

export const DEFAULT_SETTINGS = Object.freeze({
  intake_before_attending: 1, admitting_at_placement: 1, primary_needs_diagnosis: 1,
  discharge_needs_epicrisis: 1, title_required: 1,
  title_required_fields: Object.freeze(DEFAULT_TITLE_REQUIRED.slice()),
  updated_at: null, updated_by: null,
});

function nowUtc(db) {
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
}

function parseFields(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? cleanTitleRequired(v) : DEFAULT_TITLE_REQUIRED.slice();
  } catch (e) { return DEFAULT_TITLE_REQUIRED.slice(); }
}

/** Настройки как простой объект; база старше 298 или без базы — умолчания. */
export function loadInpatientSettings(db) {
  let row = null;
  try { row = db ? db.prepare('SELECT * FROM inpatient_settings WHERE id = 1').get() : null; }
  catch (e) { row = null; }   // база старше миграции 298
  if (!row) return Object.assign({}, DEFAULT_SETTINGS, { title_required_fields: DEFAULT_TITLE_REQUIRED.slice() });
  const out = { title_required_fields: parseFields(row.title_required_fields), updated_at: row.updated_at || null, updated_by: row.updated_by || null };
  for (const k of SWITCH_KEYS) out[k] = row[k] === 0 ? 0 : 1;
  return out;
}

/** Обязательные поля листа: лист не обязателен — не обязательно ничего. */
export function titleRequiredKeys(settings) {
  const s = settings || DEFAULT_SETTINGS;
  return s.title_required ? (s.title_required_fields || []).slice() : [];
}

/** Переключатели для экранов-списков (inpatient_capabilities, admission_flow_state). */
export function requiredFlags(settings) {
  const s = settings || DEFAULT_SETTINGS;
  const out = {};
  for (const k of SWITCH_KEYS) out[k] = !!s[k];
  return out;
}

export function logSettingChange(db, userId, field, oldValue, newValue, at) {
  db.prepare('INSERT INTO inpatient_settings_log (at, user_id, field, old_value, new_value) VALUES (?,?,?,?,?)')
    .run(at, userId || null, field, String(oldValue), String(newValue));
}

// INPATIENT_REQUIRED_V1 (ревью) — СТРОКА НАСТРОЕК НА МЕСТЕ. UPDATE … WHERE id = 1 без
// строки не меняет ничего и не жалуется: ответ говорил «изменено», а в базе пусто.
// Пропавшая строка встаёт с умолчаниями миграции, и уже к ней применяются изменения.
// База старше 298 (таблицы нет) — ничего не делаем и отвечаем false: там всё как сегодня.
export function ensureSettingsRow(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inpatient_settings'").get();
  if (!has) return false;
  db.prepare('INSERT OR IGNORE INTO inpatient_settings (id) VALUES (1)').run();
  return true;
}

// INPATIENT_REQUIRED_V1 (ревью) — «изменено когда и кем» для обоих входов: страницы
// «Стационар» и case_doc_type_save (тот писал строки журнала, а дату на странице не
// двигал). Транзакцию открывает вызывающий; база старше 298 — ничего не делает.
export function markSettingsUpdated(db, userId, at) {
  if (!ensureSettingsRow(db)) return;
  db.prepare('UPDATE inpatient_settings SET updated_at = ?, updated_by = ? WHERE id = 1').run(at, userId || null);
}

function boolArg(v, key) {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  throw rpcT(RpcError, 'Настройка {key}: нужно «да» или «нет».', { key }, 400);
}

// INPATIENT_REQUIRED_V1 (ревью) — проверка формы записи документа без базы. Одна для
// applyDocRequired и для inpatient_settings_save (тот проверяет КАЖДУЮ запись до
// слияния повторов: перекрытое «может быть» не должно проскакивать молча).
function docShape(a) {
  const hasRequired = a.required !== undefined && a.required !== null;
  const hasSections = a.required_sections !== undefined && a.required_sections !== null;
  const next = hasRequired ? boolArg(a.required, 'required') : null;
  if (hasSections && !Array.isArray(a.required_sections)) throw new RpcError('Обязательные разделы документа — список.', 400);
  return { hasRequired, hasSections, next };
}

/** Действующие документы набора с обязательностью и разделами — для страницы и экранов. */
function docsOf(db) {
  let rows = null;
  try {
    rows = db.prepare('SELECT kind, title, builtin, required, required_sections FROM case_doc_types WHERE active = 1 ORDER BY sort_order, id').all();
  } catch (e) {
    // База старше 298: колонок обязательности ещё нет — документы обязательны, как были.
    try { rows = db.prepare('SELECT kind, title, builtin FROM case_doc_types WHERE active = 1 ORDER BY sort_order, id').all(); }
    catch (e2) { rows = []; }   // база старше миграции 115
  }
  return rows.map((r) => ({
    kind: r.kind, title: r.title || '', builtin: !!r.builtin, required: r.required !== 0,
    required_sections: parseRequiredSections(r.required_sections, r.kind), sections: sectionsFor(r.kind),
  }));
}

/**
 * Обязательность документа и его обязательные разделы. Пишет только изменённое,
 * каждое изменение — строкой журнала. Зовут оба входа: страница «Стационар»
 * (inpatient_settings_save) и case_doc_type_save. Транзакцию открывает вызывающий.
 * Не прислано ни одно из двух полей — базу не трогает вовсе (и база старше 298 живёт).
 * @returns {number} сколько значений изменилось
 */
export function applyDocRequired(db, kind, input, user, at) {
  const a = input || {};
  // Проверка формы — до чтения базы: «не да/нет» и «не список» отказывают одинаково везде.
  const { hasRequired, hasSections, next } = docShape(a);   // INPATIENT_REQUIRED_V1 (ревью)
  const row = db.prepare('SELECT kind FROM case_doc_types WHERE kind = ?').get(kind);
  if (!row) throw rpcT(RpcError, 'Такого документа в наборе нет: {kind}.', { kind }, 404);
  if (!hasRequired && !hasSections) return 0;
  const cur = db.prepare('SELECT required, required_sections FROM case_doc_types WHERE kind = ?').get(kind);
  const uid = (user && user.id) || null;
  let changed = 0;
  if (hasRequired) {
    const prev = cur.required === 0 ? 0 : 1;
    if (next !== prev) {
      db.prepare('UPDATE case_doc_types SET required = ? WHERE kind = ?').run(next, kind);
      logSettingChange(db, uid, 'doc:' + kind + ':required', prev, next, at);
      changed += 1;
    }
  }
  if (hasSections) {
    const allowed = sectionsFor(kind);
    for (const s of a.required_sections) {
      if (!allowed.includes(String(s))) throw rpcT(RpcError, 'У этого документа нет раздела: {section}.', { section: String(s) }, 400);
    }
    const nextSections = JSON.stringify(cleanRequiredSections(a.required_sections, allowed));
    const prevSections = JSON.stringify(parseRequiredSections(cur.required_sections, kind));
    if (nextSections !== prevSections) {
      db.prepare('UPDATE case_doc_types SET required_sections = ? WHERE kind = ?').run(nextSections, kind);
      logSettingChange(db, uid, 'doc:' + kind + ':sections', prevSections, nextSections, at);
      changed += 1;
    }
  }
  return changed;
}

export function inpatientSettingsGet(db, _args, user) {
  // INPATIENT_REQUIRED_V1 (ревью) — любой вошедший; отказ — только анониму (см. выше).
  if (!effectiveRoles(user).length) throw new RpcError('Настройки стационара — недоступно вашей роли.', 403);
  const s = loadInpatientSettings(db);
  let log = [];
  try {
    log = db.prepare(`
      SELECT l.id, l.at, l.user_id, u.full_name AS user_name, l.field, l.old_value, l.new_value
        FROM inpatient_settings_log l LEFT JOIN users u ON u.id = l.user_id
       ORDER BY l.id DESC LIMIT 20`).all();
  } catch (e) { log = []; }   // база старше миграции 298
  const settings = {};
  for (const k of SWITCH_KEYS) settings[k] = s[k];
  settings.title_required_fields = s.title_required_fields.slice();
  return { settings, docs: docsOf(db), log, doc_titles: logDocTitles(db, log), updated_at: s.updated_at, can_edit: hasAnyRole(user, SETTINGS_WRITE_ROLES) };
}

/**
 * INPATIENT_REQUIRED_V1 (ревью) — имена документов, названных в журнале: { род: своё имя }.
 * Набор (docsOf) отдаёт только действующие, и строка журнала про свой документ клиники,
 * убранный из набора, называла его родом («own_7»). Читаются ВСЕ роды справочника, и
 * убранные (тот же приём, что loadCaseDocTitles в inpatient-reviews.js — импортировать его
 * отсюда нельзя: кольцо). Удалённого насовсем рода в базе нет — нет и имени (экран пишет
 * «Свой документ»); встроенный род без своего имени — '' (экран берёт словарное).
 */
function logDocTitles(db, log) {
  const kinds = [...new Set((log || []).map((l) => /^doc:(.+):(required|sections)$/.exec(String(l.field || ''))).filter(Boolean).map((m) => m[1]))];
  const out = {};
  if (!kinds.length) return out;
  try {
    const one = db.prepare('SELECT title FROM case_doc_types WHERE kind = ?');
    for (const k of kinds) {
      const r = one.get(k);
      if (r) out[k] = r.title || '';
    }
  } catch (e) { /* база старше миграции 115 — имён нет */ }
  return out;
}

const ALLOWED_KEYS = new Set([...SWITCH_KEYS, 'title_required_fields', 'docs']);
/** INPATIENT_REQUIRED_V1 (ревью) — ключи одной записи списка docs. */
const DOC_ENTRY_KEYS = new Set(['kind', 'required', 'required_sections']);

export function inpatientSettingsSave(db, args, user) {
  if (!hasAnyRole(user, SETTINGS_WRITE_ROLES)) throw new RpcError('Настройки стационара меняет главный врач или администратор.', 403);
  const a = args || {};
  for (const key of Object.keys(a)) {
    if (!ALLOWED_KEYS.has(key)) throw rpcT(RpcError, 'Неизвестная настройка стационара: {key}.', { key }, 400);
  }
  // Всё, что проверяется без базы, — ДО записи; документы проверяет applyDocRequired
  // внутри той же транзакции: отказ откатывает всё, половины изменений не остаётся.
  const nextSwitch = {};
  for (const k of SWITCH_KEYS) if (a[k] !== undefined && a[k] !== null) nextSwitch[k] = boolArg(a[k], k);
  let nextFields = null;
  if (a.title_required_fields !== undefined && a.title_required_fields !== null) {
    if (!Array.isArray(a.title_required_fields)) throw new RpcError('Обязательные поля титульного листа — список.', 400);
    for (const f of a.title_required_fields) {
      if (!TITLE_FIELD_KEYS.includes(String(f))) throw rpcT(RpcError, 'Неизвестное поле титульного листа: {key}.', { key: String(f) }, 400);
    }
    nextFields = cleanTitleRequired(a.title_required_fields);
  }
  const docs = a.docs === undefined || a.docs === null ? [] : a.docs;
  if (!Array.isArray(docs) || docs.some((d) => !d || typeof d !== 'object')) throw new RpcError('Список документов передан неверно.', 400);
  // INPATIENT_REQUIRED_V1 (ревью) — ключи записи документа проверяются так же, как ключи
  // верхнего уровня: опечатка («requried») давала 200 и «изменено 0», и клиника считала,
  // что документ стал «по желанию». Форма значений — тоже здесь, у КАЖДОЙ записи.
  for (const d of docs) {
    for (const key of Object.keys(d)) {
      if (!DOC_ENTRY_KEYS.has(key)) throw rpcT(RpcError, 'Неизвестная настройка стационара: {key}.', { key: 'docs.' + key }, 400);
    }
    docShape(d);
  }
  // INPATIENT_REQUIRED_V1 (ревью) — один род — одна запись. Повтор рода
  // ([{round, required:false}, {round, required:true}]) писал две противоречащие строки
  // журнала при неизменившемся итоге. Сливаем по роду: поле из более поздней записи
  // побеждает, поле, которого в ней нет, остаётся из ранней. Порядок — первого появления.
  const byKind = new Map();
  for (const d of docs) {
    const kind = String(d.kind || '');
    const m = byKind.get(kind) || { kind };
    if (d.required !== undefined && d.required !== null) m.required = d.required;
    if (d.required_sections !== undefined && d.required_sections !== null) m.required_sections = d.required_sections;
    byKind.set(kind, m);
  }

  const run = db.transaction(() => {
    const at = nowUtc(db);
    const uid = (user && user.id) || null;
    ensureSettingsRow(db);   // INPATIENT_REQUIRED_V1 (ревью) — пропавшая строка встаёт с умолчаниями
    const cur = loadInpatientSettings(db);
    let changed = 0;
    // Имя колонки — из SWITCH_KEYS, а не из запроса: SQL из тела запроса не строится.
    for (const k of SWITCH_KEYS) {
      if (!(k in nextSwitch) || cur[k] === nextSwitch[k]) continue;
      db.prepare(`UPDATE inpatient_settings SET ${k} = ? WHERE id = 1`).run(nextSwitch[k]);
      logSettingChange(db, uid, k, cur[k], nextSwitch[k], at);
      changed += 1;
    }
    if (nextFields) {
      const prev = JSON.stringify(cur.title_required_fields);
      const next = JSON.stringify(nextFields);
      if (prev !== next) {
        db.prepare('UPDATE inpatient_settings SET title_required_fields = ? WHERE id = 1').run(next);
        logSettingChange(db, uid, 'title_required_fields', prev, next, at);
        changed += 1;
      }
    }
    for (const d of byKind.values()) changed += applyDocRequired(db, d.kind, d, user, at);   // INPATIENT_REQUIRED_V1 (ревью)
    if (changed) markSettingsUpdated(db, uid, at);   // INPATIENT_REQUIRED_V1 (ревью)
    return changed;
  });
  const changed = run();
  return Object.assign(inpatientSettingsGet(db, {}, user), { changed });
}
