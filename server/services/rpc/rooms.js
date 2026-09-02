// ROOMS_SETUP_V1 — привязка врачей к кабинету.
//
// users НЕЛЬЗЯ писать через /api/db: в schema-registry у таблицы пустые write
// roles, и это намеренно — учётка сотрудника (роль, оклад, ставки) правится
// только своими путями, а не общим табличным редактором. Поэтому раздел
// «Помещения» не пишет users напрямую, а зовёт этот RPC, который трогает РОВНО
// одну колонку — room_id — и ничего больше.
//
// Врач сидит в ОДНОМ кабинете (users.room_id — скаляр), у кабинета врачей
// может быть много. Отсюда форма вызова: add[] переносит врача сюда (перебивая
// прежний кабинет), remove[] убирает отсюда (room_id = NULL). Обе стороны в
// одной транзакции: половинчатое применение оставило бы врача одновременно
// «убранным отсюда» и «не добавленным туда».
import { hasAnyRole } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ADMIN_ONLY = ['admin'];

export function roomAssignDoctors(db, args, user) {
  if (!hasAnyRole(user, ADMIN_ONLY)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
  const a = args || {};
  const roomId = Number(a.room_id);
  if (!Number.isInteger(roomId) || roomId <= 0) {
    throw new RpcError('room_id is required.', 400);
  }
  const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
  if (!room) throw new RpcError('Room not found.', 400);

  const ids = (x) => (Array.isArray(x) ? x : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const add = ids(a.add);
  const remove = ids(a.remove);

  // Назначаем только ВРАЧЕЙ: кабинет медсестры/кассира ничего не значит для
  // очереди, а чужой id в этом поле молча сломал бы доску очереди.
  const isDoctor = db.prepare('SELECT id FROM users WHERE id = ? AND is_doctor = 1');
  for (const id of add) {
    if (!isDoctor.get(id)) throw new RpcError('User ' + id + ' is not a doctor.', 400);
  }

  const setRoom = db.prepare('UPDATE users SET room_id = ? WHERE id = ?');
  const clearRoom = db.prepare('UPDATE users SET room_id = NULL WHERE id = ? AND room_id = ?');
  const run = db.transaction(() => {
    for (const id of remove) clearRoom.run(id, roomId);
    for (const id of add) setRoom.run(roomId, id);
  });
  run();

  const rows = db.prepare('SELECT id, full_name FROM users WHERE room_id = ? ORDER BY full_name').all(roomId);
  return { room_id: roomId, doctors: rows };
}
