// CASE_DOC_SET_V2 — СОСТАВ ИСТОРИИ БОЛЕЗНИ КАК СПРАВОЧНИК КЛИНИКИ.
//
// Владелец (2026-09-08): «this list is hardcoded and the system asks for
// filling them, we need to make not hardcoded, and able to add a title
// document. its maybe before operation it can be anesthesist list etc etc. but
// we shoud give basic templates list + option».
//
// Набор из десяти документов был константой. Он верен для типовой хирургии и
// неверен для всех прочих: родильному нужен свой лист, реанимации — своя карта,
// а лишний «осмотр заведующего» у кого-то просто вечно висит просроченным и
// приучает не смотреть на красное. Здесь клиника правит набор сама.
//
// ЧТО КЛИНИКА МОЖЕТ, А ЧЕГО НЕТ:
//   • завести свой документ — имя, правило срока, часы, признак «только у
//     оперируемых», место в списке;
//   • у встроенного — поменять срок, место и включённость;
//   • ВЫКЛЮЧИТЬ документ из набора, но не удалить: на род ссылаются уже
//     написанные записи, и стереть род значило бы осиротить их;
//   • выписной эпикриз не выключается вовсе — его спрашивает гейт выписки
//     (rpc/inpatient.js) по имени, и без него выписка встанет молча.
//
// ПОЧЕМУ РОД (kind) НЕ МЕНЯЕТСЯ НИКОГДА. Это ключ, на который ссылаются
// admission_reviews.kind и собранные истории. Переименовать род — значит
// переписать написанное; переименовывают ИМЯ (title), а род остаётся.
import { RpcError } from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';
import { loadCaseDocSet } from './inpatient-reviews.js';

/** Кто правит состав: тот же круг, что назначает лечащего врача. */
export const DOC_TYPE_WRITE_ROLES = ['admin', 'head_doctor'];
/** Кто видит состав: все, кто ведёт пациента, — им же по нему и работать. */
export const DOC_TYPE_READ_ROLES = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];

/** Правила срока — ровно те, что умеет считать чек-лист. */
export const DUE_RULES = Object.freeze(['clock', 'period', 'surgical', 'at_discharge', 'none']);
/** Правила, которым нужны часы. У остальных часов не бывает. */
const RULES_WITH_HOURS = Object.freeze(['clock', 'period', 'surgical']);
/** Единственный блок, который сегодня умеет чек-лист. */
const BLOCKS = Object.freeze(['', 'surgical']);

/** Выписной эпикриз держит выписку; выключить его — сломать выписку молча. */
export const LOCKED_KINDS = Object.freeze(['discharge']);

const MAX_HOURS = 24 * 365;

function requireWrite(user) {
  if (!hasAnyRole(user, DOC_TYPE_WRITE_ROLES)) {
    throw new RpcError('Состав истории болезни меняет главный врач или администратор.', 403);
  }
}
function requireRead(user) {
  if (!hasAnyRole(user, DOC_TYPE_READ_ROLES)) {
    throw new RpcError('Состав истории болезни закрыт для вашей роли.', 403);
  }
}

const str = (v, max) => String(v === null || v === undefined ? '' : v).trim().slice(0, max);

function rowOf(db, kind) {
  return db.prepare('SELECT * FROM case_doc_types WHERE kind = ?').get(kind) || null;
}

/** Сколько записей уже написано этим родом — экран предупреждает перед выключением. */
function usedCount(db, kind) {
  try { return db.prepare('SELECT COUNT(*) n FROM admission_reviews WHERE kind = ?').get(kind).n; }
  catch (e) { return 0; }
}

/**
 * Весь состав, включая выключенное: экран настроек показывает и то, что убрали,
 * иначе вернуть документ в набор было бы нечем.
 */
export function caseDocTypesList(db, args, user) {
  requireRead(user);
  const rows = db.prepare('SELECT * FROM case_doc_types ORDER BY sort_order, id').all();
  return {
    types: rows.map((r) => ({
      kind: r.kind,
      title: r.title || '',
      due_rule: r.due_rule,
      due_hours: r.due_hours === null || r.due_hours === undefined ? null : Number(r.due_hours),
      block: r.block || '',
      sort_order: Number(r.sort_order) || 0,
      builtin: !!r.builtin,
      active: !!r.active,
      locked: LOCKED_KINDS.includes(r.kind),
      used: usedCount(db, r.kind),
    })),
    due_rules: DUE_RULES,
  };
}

/** Новый род: внутреннее имя, которого пользователь не видит и не выбирает. */
function nextKind(db) {
  const max = db.prepare("SELECT COALESCE(MAX(id), 0) m FROM case_doc_types").get().m;
  let n = Number(max) + 1;
  // Род мог быть заведён и удалён вручную — ищем свободный, а не верим счётчику.
  while (rowOf(db, 'own_' + n)) n += 1;
  return 'own_' + n;
}

function parse(a, { isNew, builtin }) {
  const title = str(a.title, 80);
  if (isNew && !title) throw new RpcError('Назовите документ — под этим именем он встанет в список.', 400);
  if (!builtin && !isNew && !title) throw new RpcError('Назовите документ — под этим именем он встанет в список.', 400);

  const due_rule = str(a.due_rule, 20) || 'clock';
  if (!DUE_RULES.includes(due_rule)) throw new RpcError('Неизвестное правило срока.', 400);

  let due_hours = null;
  if (RULES_WITH_HOURS.includes(due_rule)) {
    const n = Number(a.due_hours);
    if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > MAX_HOURS) {
      throw new RpcError('Срок — целое число часов от 1 до 8760.', 400);
    }
    due_hours = n;
  }

  const block = str(a.block, 20);
  if (!BLOCKS.includes(block)) throw new RpcError('Неизвестный блок документа.', 400);

  return { title, due_rule, due_hours, block: block || null };
}

/**
 * Завести свой документ или поправить существующий.
 *
 * У встроенного рода имя МОЖНО переопределить, и это осознанный размен:
 * встроенные имена переводятся на три языка, а своё имя — одно и на одном
 * языке. Клиника, которая назвала документ по-своему, обычно этого и хочет.
 */
export function caseDocTypeSave(db, args, user) {
  requireWrite(user);
  const a = args || {};
  const kind = str(a.kind, 60);
  const existing = kind ? rowOf(db, kind) : null;
  if (kind && !existing) throw new RpcError('Такого документа в наборе нет.', 404);

  const isNew = !existing;
  const fields = parse(a, { isNew, builtin: existing ? !!existing.builtin : false });

  if (isNew) {
    const own = nextKind(db);
    const last = db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM case_doc_types').get().m;
    db.prepare(`INSERT INTO case_doc_types (kind, title, due_rule, due_hours, block, sort_order, builtin, active)
                VALUES (?, ?, ?, ?, ?, ?, 0, 1)`)
      .run(own, fields.title, fields.due_rule, fields.due_hours, fields.block, Number(last) + 10);
    return { type: caseDocTypesList(db, {}, user).types.find((t) => t.kind === own) || null };
  }

  db.prepare('UPDATE case_doc_types SET title = ?, due_rule = ?, due_hours = ?, block = ? WHERE kind = ?')
    .run(fields.title, fields.due_rule, fields.due_hours, fields.block, kind);
  return { type: caseDocTypesList(db, {}, user).types.find((t) => t.kind === kind) || null };
}

/**
 * Включить или убрать документ из набора.
 *
 * Убрать — не значит стереть: написанные им записи остаются в истории болезни и
 * печатаются. Из чек-листа он просто уходит, и просроченным больше не висит.
 */
export function caseDocTypeSetActive(db, args, user) {
  requireWrite(user);
  const a = args || {};
  const kind = str(a.kind, 60);
  const row = rowOf(db, kind);
  if (!row) throw new RpcError('Такого документа в наборе нет.', 404);
  const active = a.active ? 1 : 0;
  if (!active && LOCKED_KINDS.includes(kind)) {
    throw new RpcError('Выписной эпикриз убрать нельзя: без него сервер не примет заявку на выписку.', 400);
  }
  if (!active) {
    const left = db.prepare('SELECT COUNT(*) n FROM case_doc_types WHERE active = 1 AND kind <> ?').get(kind).n;
    if (!left) throw new RpcError('В наборе должен остаться хотя бы один документ.', 400);
  }
  db.prepare('UPDATE case_doc_types SET active = ? WHERE kind = ?').run(active, kind);
  return { type: caseDocTypesList(db, {}, user).types.find((t) => t.kind === kind) || null };
}

/**
 * Порядок списка. Он же порядок собранной истории болезни, поэтому меняется
 * целиком и одним вызовом: два соседних обмена, приехавшие врозь, оставили бы
 * список в состоянии, которого никто не просил.
 */
export function caseDocTypesReorder(db, args, user) {
  requireWrite(user);
  const kinds = Array.isArray(args && args.kinds) ? args.kinds.map((k) => str(k, 60)) : [];
  if (!kinds.length) throw new RpcError('Порядок пуст.', 400);
  const known = new Set(db.prepare('SELECT kind FROM case_doc_types').all().map((r) => r.kind));
  for (const k of kinds) if (!known.has(k)) throw new RpcError(`Такого документа в наборе нет: ${k}.`, 404);
  const upd = db.prepare('UPDATE case_doc_types SET sort_order = ? WHERE kind = ?');
  const tx = db.transaction(() => { kinds.forEach((k, i) => upd.run((i + 1) * 10, k)); });
  tx();
  return caseDocTypesList(db, {}, user);
}

/** Набор, каким его видит чек-лист, — для тестов и для экрана «состав». */
export function caseDocSetPreview(db) { return loadCaseDocSet(db); }
