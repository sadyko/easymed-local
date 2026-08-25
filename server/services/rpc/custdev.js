// CUSTDEV_V1 — граница Cust Dev: разбор аргументов и права. Вся логика живёт в
// services/custdev/.
//
// Права проверяются через canViewSection/canEditSection, а НЕ hasAnyRole со
// списком ролей в коде: доступ выдаётся галочкой в «Настройки → Роли», то есть
// набор ролей заранее неизвестен и проверять его надо ТАМ ЖЕ, где он хранится.
// Тот же выбор и по той же причине сделан для «Чата с пациентами».

import { canViewSection, canEditSection } from '../roles.js';
import { RpcError } from './crm-config.js';
import { syncCards } from '../custdev/sync.js';
import { listCards, reportFor } from '../custdev/board.js';
import { rateOutcome, ScoreError } from '../custdev/score.js';

const KEY = 'custdev';

function requireView(db, user) {
  if (!canViewSection(db, user, KEY)) {
    throw new RpcError('Раздел «Cust Dev» вам не выдан.', 403);
  }
}

function requireEdit(db, user) {
  requireView(db, user);
  if (!canEditSection(db, user, KEY)) {
    throw new RpcError('У вас доступ «Только просмотр»: оценивать карточки нельзя.', 403);
  }
}

// Границы периода приходят как местные 'YYYY-MM-DD'. Пустые не подставляем
// молча: доска всегда шлёт обе, а запрос без периода читал бы всю базу.
function period(args) {
  const from = String((args && args.from) || '').slice(0, 10);
  const to = String((args && args.to) || '').slice(0, 10);
  if (!from || !to) throw new RpcError('Не указан период.', 400);
  return { from, to };
}

function loadCard(db, args) {
  const id = Number(args && args.card_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Не указана карточка.', 400);
  const row = db.prepare('SELECT * FROM custdev_cards WHERE id = ?').get(id);
  if (!row) throw new RpcError('Карточка не найдена.', 404);
  return row;
}

export function custdevList(db, args, user) {
  requireView(db, user);
  return listCards(db, period(args));
}

export function custdevReport(db, args, user) {
  requireView(db, user);
  return reportFor(db, period(args));
}

/**
 * Досоздаёт карточки за период. Просмотра достаточно: это не изменение данных
 * клиники, а материализация того, что уже произошло у кассы.
 */
export function custdevSync(db, args, user) {
  requireView(db, user);
  return { created: syncCards(db, period(args)) };
}

export function custdevRate(db, args, user) {
  requireEdit(db, user);
  const card = loadCard(db, args);

  let outcome;
  try {
    outcome = rateOutcome(args);
  } catch (e) {
    // ScoreError несёт текст, который можно показать оператору как есть.
    if (e instanceof ScoreError) throw new RpcError(e.message, 400);
    throw e;
  }

  db.prepare(`UPDATE custdev_cards
                 SET score_registrar = ?, score_cashier = ?, score_doctor = ?,
                     status = ?, comment = ?,
                     called_by = ?, called_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
               WHERE id = ?`)
    .run(args.registrar, args.cashier, args.doctor,
         outcome.status, outcome.comment, (user && user.id) || null, card.id);

  return { id: card.id, status: outcome.status };
}

// Только ручные статусы. Вычисляемые три сюда не пускаем: они следуют из
// оценок, и поставленный руками «Доволен» разошёлся бы с ними навсегда.
const MANUAL = ['new', 'unreachable'];

export function custdevMark(db, args, user) {
  requireEdit(db, user);
  const card = loadCard(db, args);
  const status = String((args && args.status) || '');
  if (!MANUAL.includes(status)) {
    throw new RpcError('Этот статус выставляется оценками, а не вручную.', 400);
  }

  db.prepare(`UPDATE custdev_cards
                 SET status = ?, called_by = ?,
                     called_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
               WHERE id = ?`)
    .run(status, (user && user.id) || null, card.id);

  return { id: card.id, status };
}
