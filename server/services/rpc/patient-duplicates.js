// PATIENT_DUP_RULE_V3 (3.25.0, решение владельца 2026-11-18) — «ДУБЛИКАТЫ»
// КАРТОТЕКИ СЧИТАЕТ СЕРВЕР, и считает ВСЮ картотеку.
//
// Прежде чип «Дубликаты · N» считал браузер (data.js findAllDuplicatePatientIds):
// одна выборка /api/db с .limit(1000) и группировка у себя. На картотеке в 70 000
// карт смотрелась только первая тысяча — дубль, заведённый позже, не находился
// никогда, — а без ограничения в браузер поехали бы все 70 000 строк. Здесь та же
// группировка тем же модулем (public/js/admin/patient-duplicates.js — чистый, без
// DOM), но строки не покидают сервер: в ответе только id групп.
//
// Два списка:
//   • sure — уверенные дубликаты, правило PATIENT_DUP_RULE_V2 БЕЗ ИЗМЕНЕНИЙ (тот же
//     ПИНФЛ; тот же телефон и то же имя);
//   • possible — «Возможные дубликаты — проверьте»: тот же телефон и та же дата
//     рождения при разных именах; то же ФИО и та же дата рождения (телефон
//     любой). Пары, отмеченные «Не дубликат», сюда не попадают.
//
// «Не дубликат» (patient_dup_dismiss) запоминает ПАРЫ карт группы в
// patient_dup_dismissals (мигр. 290): кто и когда. Карты пациентов не меняются.
// Право — то же, что у объединения карт (rpc/patient-merge.js: только
// администратор): разбор дубликатов — его работа; смотреть список может каждый,
// кому выдан раздел «Пациенты».
import { RpcError } from './crm-config.js';
import { effectiveRoles, canViewSection, hasAnyRole } from '../roles.js';
import { canRead } from '../../db/schema-registry.js';
import { duplicateScan, duplicateGroups, pairKey, POSSIBLE_REASONS } from '../../../public/js/admin/patient-duplicates.js';

// Больше карт за одно нажатие — это не «группа, похожая на одного человека», а
// ошибка экрана; то же ограничение, что у объединения (merge_patients, 50).
const MAX_DISMISS_CARDS = 50;
const REASONS = new Set(Object.values(POSSIBLE_REASONS));
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

// Право на «Не дубликат» — то же, что у merge_patients.
export function canDismissDuplicates(user) {
  return hasAnyRole(user, ['admin']);
}

/**
 * patient_duplicates_scan({}) → { sure: [[id…]…], possible: [{ ids, reasons }…], scanned, can_dismiss }
 * id в группе по возрастанию, группы с самой новой картой — сверху.
 */
export function patientDuplicatesScan(db, _args, user) {
  const roles = effectiveRoles(user);
  if (!canViewSection(db, user, 'patients') || !canRead('patients', roles)) {
    throw new RpcError('Раздел «Пациенты» вашей роли не выдан.', 403);
  }
  // Колонки — только то, чем сравнивают; наружу уходят одни id.
  const rows = db.prepare(`SELECT id, phone, national_id, first_name, last_name, middle_name, full_name, date_of_birth
                             FROM patients`).all();
  const dismissed = new Set();
  for (const r of db.prepare('SELECT patient_id_a AS a, patient_id_b AS b FROM patient_dup_dismissals').iterate()) {
    dismissed.add(pairKey(r.a, r.b));
  }
  const { sure, possible } = duplicateScan(rows, dismissed);
  return { sure, possible, scanned: rows.length, can_dismiss: canDismissDuplicates(user) };
}

/**
 * patient_dup_dismiss({ ids: [id…], reasons?: ['phone_dob' | 'name_dob'] }) → { dismissed, pairs }
 * Запоминает «эти карты — разные люди» для каждой пары группы, кроме пар, которые
 * уже уверенный дубликат (их правило отметка не отменяет — и записывать их «не
 * дубликатом» значило бы спорить с ним). Повтор — не ошибка: уже отмеченная пара
 * не дублируется (dismissed — сколько пар записано сейчас, pairs — сколько всего).
 */
export function patientDupDismiss(db, args, user) {
  if (!canDismissDuplicates(user)) {
    throw new RpcError('Отмечать «Не дубликат» может только администратор.', 403);
  }
  const a = args || {};
  const BAD = 'Отметить «Не дубликат» можно группу от двух до 50 карт.';
  if (!Array.isArray(a.ids) || !a.ids.every(isPositiveInt)) throw new RpcError(BAD, 400);
  const ids = [...new Set(a.ids)];
  if (ids.length < 2 || ids.length > MAX_DISMISS_CARDS) throw new RpcError(BAD, 400);
  let reasons = [];
  if (a.reasons !== undefined && a.reasons !== null) {
    if (!Array.isArray(a.reasons) || !a.reasons.every((r) => REASONS.has(r))) {
      throw new RpcError('Причина группы указана неверно.', 400);
    }
    reasons = [...new Set(a.reasons)];
  }

  const rows = db.prepare(`SELECT id, phone, national_id, first_name, last_name, middle_name, full_name, date_of_birth
                             FROM patients WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
  if (rows.length !== ids.length) throw new RpcError('Карта пациента не найдена.', 404);

  const sureOf = new Map();
  duplicateGroups(rows).forEach((g, i) => { for (const id of g) sureOf.set(id, i); });

  // Кто отметил: ссылка — только на существующего сотрудника (у встроенного
  // администратора id нет), имя — копией на момент отметки.
  const uid = isPositiveInt(user && user.id) && db.prepare('SELECT 1 FROM users WHERE id = ?').get(user.id) ? user.id : null;
  const name = String((user && (user.full_name || user.username)) || '');
  const ins = db.prepare(`INSERT OR IGNORE INTO patient_dup_dismissals
                            (patient_id_a, patient_id_b, reasons, dismissed_by, dismissed_by_name) VALUES (?, ?, ?, ?, ?)`);
  const sorted = [...ids].sort((x, y) => x - y);
  return db.transaction(() => {
    let pairs = 0, dismissed = 0;
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const x = sorted[i], y = sorted[j];
        const s = sureOf.get(x);
        if (s !== undefined && s === sureOf.get(y)) continue;
        pairs++;
        dismissed += ins.run(x, y, reasons.join(','), uid, name).changes;
      }
    }
    return { dismissed, pairs };
  })();
}
