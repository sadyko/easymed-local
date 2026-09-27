// PATIENT_MERGE_SERVER_V1 (2026-09-27) — объединение дублей делает СЕРВЕР.
//
// Раньше объединение шло из браузера (data.js mergePatients) таблица за
// таблицей через /api/db. Реестр не даёт клиенту менять patient_id у визитов и
// счетов, поэтому у дубля с историей визиты и счета оставались на нём,
// удаление карты падало на внешнем ключе, а часть строк к этому моменту уже
// переехала — карта оказывалась разорванной на две. Теперь всё — одной
// транзакцией: либо дубль целиком стал оставленной картой, либо не изменилось
// ничего.
//
// ЧТО ПЕРЕНОСИТСЯ — MERGE_TABLES ниже: каждая колонка схемы, указывающая на
// пациента. Тест (patient-merge.test.js) сверяет этот список со схемой: новая
// таблица с patient_id, не добавленная сюда, роняет тест, а не объединение у
// клиента. Строки, которые висят на пациенте через визит или счёт (услуги
// визита, анализы, талоны очереди, позиции счёта, платежи), едут вместе со
// своим визитом/счётом.
//
// ОСОБЫЕ СЛУЧАИ:
//   • patient_deposits (баланс) — строки журнала баланса заморожены (мигр.
//     160); смена владельца пропускается только по паре из merge_money_moves,
//     которую эта функция кладёт и убирает в своей транзакции. Баланс после
//     объединения = сумма обоих;
//   • patient_relationships — пара (a, b) уникальна: связи дубля строятся
//     заново на оставленную карту, связь с самим собой и повторы снимаются;
//   • patient_guardians — опекун «оставленная карта сама себе» снимается.
//
// ПОЛЯ КАРТЫ не сливаются, кроме пустых КОНТАКТОВ (M3, contactPatch ниже).
//
// ФИЛИАЛЫ — PATIENT_MERGE_BRANCHES_V1 («объединять и по зданиям тоже»,
// решение владельца 2026-09-27). Объединение — СОБЫТИЕ сети: строка
// patient_merges (мигр. 168) «drop_uid слита в keep_uid» едет журналом, и
// каждое здание, получив её, делает у себя то же самое (applyMergeHere —
// records.js зовёт её в конце приёма порции): переносит на keep всё, что у
// него лежит на drop, включая то, что между зданиями не ездит (баланс,
// госпитализации, давление, документы, журнал карты), и удаляет drop.
// Поэтому прежний отказ «карта уже передана в другое здание» снят, как и
// отказ «у дубля есть записи другого здания»: чужие строки здесь
// переносятся ЗДЕСЬ, а у их дома — событием. Кто и что правит:
//   • объединить может администратор ЛЮБОГО здания, где есть обе карты, —
//     в том числе карты, заведённые в другом здании (удаление дубля — часть
//     события, а не правка чужой строки в обход её дома);
//   • деньги каждое здание переносит СВОИ (patient_deposits не ездят): баланс
//     после объединения — сумма обоих в каждом здании отдельно;
//   • пустые контакты оставленной карты дополняет только ЕЁ ДОМ (там, где она
//     заведена) — чужую карту отсюда не правят, как и раньше.
//
// Права — как у прежнего объединения, которое заканчивалось удалением карты:
// только администратор.

import { hasAnyRole } from '../roles.js';
import { OPEN_STATUSES } from '../../../public/js/shared/admission-status.js';

// Четвёртая проверка, M3 — пустые КОНТАКТЫ оставленной карты дополняются из
// дубля (телефон дубля — вторым номером). Имя, дата рождения, документы и
// медицинские поля не трогаются: там выбирает человек, а не правило.
const CONTACT_FILL = ['email', 'address', 'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation'];

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Каждая колонка, указывающая на пациента. how: 'move' — простая замена;
// особые — см. шапку.
export const MERGE_TABLES = Object.freeze([
  { table: 'visits', cols: ['patient_id'], how: 'move' },
  { table: 'invoices', cols: ['patient_id'], how: 'move' },
  { table: 'admissions', cols: ['patient_id'], how: 'move' },
  { table: 'admission_prescriptions', cols: ['patient_id'], how: 'move' },
  { table: 'med_administrations', cols: ['patient_id'], how: 'move' },
  { table: 'recommended_services', cols: ['patient_id'], how: 'move' },
  { table: 'visit_documents', cols: ['patient_id'], how: 'move' },
  { table: 'patient_vitals', cols: ['patient_id'], how: 'move' },
  { table: 'patient_conditions', cols: ['patient_id'], how: 'move' },
  { table: 'patient_activity_log', cols: ['patient_id'], how: 'move' },
  { table: 'telegram_deliveries', cols: ['patient_id'], how: 'move' },
  { table: 'calls', cols: ['patient_id'], how: 'move' },
  { table: 'crm_requests', cols: ['patient_id'], how: 'move' },
  { table: 'custdev_cards', cols: ['patient_id'], how: 'move' },
  { table: 'patient_deposits', cols: ['patient_id'], how: 'money' },
  { table: 'patient_guardians', cols: ['patient_id', 'guardian_patient_id'], how: 'guardians' },
  { table: 'patient_relationships', cols: ['patient_id_a', 'patient_id_b'], how: 'relationships' },
]);

// Родство хранится одной строкой на пару, «младший» id — в a (как у экрана,
// data.js: сравнение строками), тип — со стороны a.
const REL_INVERSE = { parent: 'child', child: 'parent', spouse: 'spouse', sibling: 'sibling', guardian: 'guardian', other: 'other' };

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

/**
 * Перенести на keep всё, что указывает на drop (MERGE_TABLES). Карту drop не
 * трогает и не удаляет — это делает вызывающий. Внутри транзакции вызывающего.
 * @returns {Record<string, number>} сколько строк переехало по таблицам
 */
export function mergeRows(db, keep, drop) {
  const moved = {};
  for (const t of MERGE_TABLES) {
    if (t.how === 'move') {
      moved[t.table] = db.prepare(`UPDATE "${t.table}" SET patient_id = ? WHERE patient_id = ?`).run(keep, drop).changes;
    } else if (t.how === 'money') {
      db.prepare('INSERT OR IGNORE INTO merge_money_moves (drop_id, keep_id) VALUES (?, ?)').run(drop, keep);
      try {
        moved[t.table] = db.prepare('UPDATE patient_deposits SET patient_id = ? WHERE patient_id = ?').run(keep, drop).changes;
      } finally {
        db.prepare('DELETE FROM merge_money_moves WHERE drop_id = ? AND keep_id = ?').run(drop, keep);
      }
    } else if (t.how === 'guardians') {
      let n = db.prepare('UPDATE patient_guardians SET patient_id = ? WHERE patient_id = ?').run(keep, drop).changes;
      n += db.prepare('UPDATE patient_guardians SET guardian_patient_id = ? WHERE guardian_patient_id = ?').run(keep, drop).changes;
      db.prepare('DELETE FROM patient_guardians WHERE patient_id = ? AND guardian_patient_id = ?').run(keep, keep);
      moved[t.table] = n;
    } else if (t.how === 'relationships') {
      const rows = db.prepare('SELECT * FROM patient_relationships WHERE patient_id_a = ? OR patient_id_b = ?').all(drop, drop);
      db.prepare('DELETE FROM patient_relationships WHERE patient_id_a = ? OR patient_id_b = ?').run(drop, drop);
      const ins = db.prepare('INSERT OR IGNORE INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (?, ?, ?)');
      let n = 0;
      for (const r of rows) {
        let x = r.patient_id_a === drop ? keep : r.patient_id_a;
        let y = r.patient_id_b === drop ? keep : r.patient_id_b;
        let rt = r.relation_type;
        if (x === y) continue;   // связь с самим собой
        if (String(x) > String(y)) { [x, y] = [y, x]; rt = REL_INVERSE[rt] || rt; }
        n += ins.run(x, y, rt).changes;
      }
      moved[t.table] = n;
    }
  }
  return moved;
}

/**
 * M3 — какие ПУСТЫЕ контакты оставленной карты дополнить из дубля.
 * @returns {Record<string, string>} колонка → значение (пусто — дополнять нечего)
 */
export function contactPatch(keepRow, dropRow) {
  const empty = (v) => v == null || String(v).trim() === '';
  const patch = {};
  const phone2 = !empty(dropRow.phone) && dropRow.phone !== keepRow.phone ? dropRow.phone
    : (!empty(dropRow.phone_secondary) && dropRow.phone_secondary !== keepRow.phone ? dropRow.phone_secondary : null);
  if (empty(keepRow.phone_secondary) && phone2) patch.phone_secondary = phone2;
  for (const c of CONTACT_FILL) if (empty(keepRow[c]) && !empty(dropRow[c])) patch[c] = dropRow[c];
  return patch;
}

/**
 * Записать дополненные контакты на карту — только в ПУСТЫЕ поля (между
 * расчётом патча и записью карту могли заполнить). @returns {number} сколько колонок
 */
export function applyContactPatch(db, keepId, patch) {
  let n = 0;
  for (const [c, v] of Object.entries(patch || {})) {
    n += db.prepare(`UPDATE patients SET ${c} = ? WHERE id = ? AND (${c} IS NULL OR trim(${c}) = '')`).run(v, keepId).changes;
  }
  return n;
}

function openAdmissions(db, patientId) {
  return db.prepare(`SELECT COUNT(*) n FROM admissions WHERE patient_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`)
    .get(patientId, ...OPEN_STATUSES).n;
}

const labelOf = (row) => [row.full_name || '—', row.mrn ? '(' + row.mrn + ')' : ''].filter(Boolean).join(' ');

function logMerged(db, keep, dropRow, detail, summary, actor) {
  db.prepare(`INSERT INTO patient_activity_log (patient_id, entity_type, entity_id, entity_label, action, summary, detail,
                                                 actor_user_id, actor_name, actor_role)
              VALUES (?, 'patient', ?, ?, 'merged', ?, ?, ?, ?, ?)`)
    .run(keep, dropRow.id, labelOf(dropRow), summary, JSON.stringify(detail),
      actor.id == null ? null : actor.id, String(actor.name || ''), String(actor.role || ''));
}

/**
 * PATIENT_MERGE_BRANCHES_V1 — ОБЪЕДИНЕНИЕ, ПРИШЕДШЕЕ ИЗ ДРУГОГО ЗДАНИЯ.
 *
 * Событие уже случилось, и оно окончательно: здесь ничего не отказывается.
 * Даже две открытые госпитализации (у каждой карты своя, обе ЗДЕСЬ — отправитель
 * их видеть не мог, госпитализации между зданиями не ездят) не останавливают
 * перенос: остановить значило бы оставить карту-призрак, на которую сосед
 * больше ничего не пришлёт. Вместо отказа — отметка в журнале карты, чтобы
 * администратор выписал или отменил одну.
 *
 * Контакты НЕ дополняются здесь: вызывающий (records.js) делает это после
 * чистки журнала приёма и только если keep заведена здесь — правка своей
 * карты обязана уехать соседям обычным журналом. Патч возвращается.
 *
 * @returns {{moved: object, patch: object, twoOpenAdmissions: boolean}|null}
 */
export function applyMergeHere(db, { keepId, dropId, fromLetter = null }) {
  const getP = db.prepare('SELECT * FROM patients WHERE id = ?');
  const keepRow = getP.get(keepId);
  const dropRow = getP.get(dropId);
  if (!keepRow || !dropRow || keepId === dropId) return null;
  const twoOpen = openAdmissions(db, keepId) > 0 && openAdmissions(db, dropId) > 0;
  const moved = mergeRows(db, keepId, dropId);
  const where = fromLetter ? 'в здании ' + fromLetter : 'в другом здании';
  let summary = 'Объединено с дублем ' + labelOf(dropRow) + ' (' + where + ')';
  if (twoOpen) summary += '. Внимание: у карты две открытые госпитализации — выпишите или отмените одну.';
  logMerged(db, keepId, dropRow,
    { drop_id: dropId, drop_uid: dropRow.uid || null, keep_uid: keepRow.uid || null, from: fromLetter, moved, two_open_admissions: twoOpen },
    summary, { id: null, name: 'Синхронизация' + (fromLetter ? ' (' + fromLetter + ')' : ''), role: 'sync' });
  db.prepare('DELETE FROM patients WHERE id = ?').run(dropId);
  const patch = keepRow.sync_origin == null ? contactPatch(keepRow, dropRow) : {};
  return { moved, patch, twoOpenAdmissions: twoOpen };
}

// Один дубль: всё внутри транзакции вызывающего.
function mergeOne(db, keep, drop, user) {
  const getP = db.prepare('SELECT * FROM patients WHERE id = ?');
  const keepRow = getP.get(keep);
  const dropRow = getP.get(drop);
  if (!keepRow || !dropRow) throw new RpcError('Пациент не найден.', 400);
  // Четвёртая проверка, M1 — у двух карт не бывает двух открытых
  // госпитализаций одного человека: сначала выписка или отмена одной. Видно
  // только своё здание; госпитализации соседа он разберёт у себя (applyMergeHere).
  if (openAdmissions(db, keep) > 0 && openAdmissions(db, drop) > 0) {
    throw new RpcError('У обеих карт открыта госпитализация. Сначала выпишите пациента или отмените одну из них, потом объединяйте.', 400);
  }

  // PATIENT_MERGE_BRANCHES_V1 — СОБЫТИЕ ПЕРВЫМ: его номер в журнале ниже, чем
  // у переезда строк и надгробия дубля, значит сосед узнает о слиянии раньше,
  // чем увидит удаление (records.js не станет удалять карту, о слиянии которой
  // знает, — перенесёт её строки сам). Без uid (старая база до 083) карта не
  // в сети — событие не нужно.
  if (keepRow.uid && dropRow.uid) {
    db.prepare('INSERT INTO patient_merges (keep_uid, drop_uid) VALUES (?, ?)').run(keepRow.uid, dropRow.uid);
  }

  const moved = mergeRows(db, keep, drop);

  // M3 — пустые контакты СВОЕЙ карты (карту соседа дополнит её дом, получив
  // событие).
  if (keepRow.sync_origin == null) {
    const n = applyContactPatch(db, keep, contactPatch(keepRow, dropRow));
    if (n) moved.patients_contacts = n;
  }

  logMerged(db, keep, dropRow, { drop_id: drop, drop_uid: dropRow.uid || null, keep_uid: keepRow.uid || null, moved },
    'Объединено с дублем ' + labelOf(dropRow),
    { id: user.id, name: user.full_name || user.username || '', role: user.role || '' });

  // Карта дубля пуста — удаляем её так же, как прежнее объединение
  // (удаление уезжает к соседям надгробием, мигр. 084; при известном событии
  // сосед его не исполняет, а объединяет у себя).
  db.prepare('DELETE FROM patients WHERE id = ?').run(drop);
  return moved;
}

// merge_patients { keep_id, drop_id } или { keep_id, drop_ids: [...] }. Все
// дубли — ОДНОЙ транзакцией: если хоть один нельзя (нет карты, две открытые
// госпитализации), не объединяется ни один.
export function mergePatientsRpc(db, args, user) {
  if (!hasAnyRole(user, ['admin'])) throw new RpcError('Объединять карты может только администратор.', 403);
  const a = args || {};
  const keep = a.keep_id;
  const drops = Array.isArray(a.drop_ids) ? a.drop_ids : [a.drop_id];
  if (!isPositiveInt(keep) || !drops.length || drops.length > 50 || !drops.every(isPositiveInt)) {
    throw new RpcError('Выберите карту, которую оставить, и карты-дубли.', 400);
  }
  if (drops.includes(keep)) throw new RpcError('Нельзя объединить карту саму с собой.', 400);
  const uniq = [...new Set(drops)];

  return db.transaction(() => {
    const moved = {};
    for (const drop of uniq) {
      for (const [t, n] of Object.entries(mergeOne(db, keep, drop, user))) moved[t] = (moved[t] || 0) + n;
    }
    return { merged: true, keep_id: keep, drop_id: uniq[0], drop_ids: uniq, moved };
  })();
}
