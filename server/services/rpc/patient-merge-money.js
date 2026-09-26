// PATIENT_MERGE_MONEY_V1 (2026-09-26) — деньги дубля переходят к оставленной карте.
//
// Объединение дублей (Пациенты → «Объединить», public/js/admin/data.js
// mergePatients) идёт из браузера таблица за таблицей. Баланс пациента
// (patient_deposits: депозиты, зачисления возвратов, списания, кэшбэк) клиент
// больше не пишет — ревью I1, миграция 160 — поэтому деньги переносит сервер,
// одной транзакцией:
//   • все строки patient_deposits дубля → оставленной карте (баланс после
//     объединения = сумма обоих: формула считает строки владельца);
//   • счета депозитов дубля (DEP-…, без визита и госпитализации) — вместе со
//     своими депозитами. Счёт визита остаётся при визите: иначе счёт и визит
//     принадлежали бы разным картам.
//
// Строка баланса переходит к другому пациенту ТОЛЬКО здесь: триггер
// patient_deposits_owner_frozen (мигр. 160) пропускает смену patient_id лишь
// по паре из merge_money_moves, которую эта функция кладёт и убирает в своей
// транзакции.
//
// Права — как у удаления карты пациента, которым объединение заканчивается:
// только администратор (schema-registry patients.delete).
//
// Карты и сертификаты (patient_discounts, card_ledger) к пациенту не привязаны
// (карта — на предъявителя), переносить у них нечего.

import { hasAnyRole } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

export function patientMergeMoney(db, args, user) {
  if (!hasAnyRole(user, ['admin'])) throw new RpcError('Your role is not allowed to perform this action.', 403);
  const a = args || {};
  if (!isPositiveInt(a.keep_id) || !isPositiveInt(a.drop_id)) throw new RpcError('keep_id and drop_id must be positive integers.', 400);
  if (a.keep_id === a.drop_id) throw new RpcError('Нельзя объединить карту саму с собой.', 400);

  return db.transaction(() => {
    const has = db.prepare('SELECT id FROM patients WHERE id = ?');
    if (!has.get(a.keep_id) || !has.get(a.drop_id)) throw new RpcError('Пациент не найден.', 400);

    db.prepare('INSERT OR IGNORE INTO merge_money_moves (drop_id, keep_id) VALUES (?, ?)').run(a.drop_id, a.keep_id);
    try {
      const inv = db.prepare(`UPDATE invoices SET patient_id = ?
                               WHERE patient_id = ? AND visit_id IS NULL AND admission_id IS NULL
                                 AND id IN (SELECT invoice_id FROM patient_deposits WHERE kind = 'deposit' AND patient_id = ?)`)
        .run(a.keep_id, a.drop_id, a.drop_id);
      const dep = db.prepare('UPDATE patient_deposits SET patient_id = ? WHERE patient_id = ?').run(a.keep_id, a.drop_id);
      return { moved_deposits: dep.changes, moved_invoices: inv.changes };
    } finally {
      db.prepare('DELETE FROM merge_money_moves WHERE drop_id = ? AND keep_id = ?').run(a.drop_id, a.keep_id);
    }
  })();
}
