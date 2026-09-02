// ROOMS_DELETE_V1 — удаление помещения из объединённого раздела.
//
// В schema-registry у floors/rooms/wards/beds `delete: { roles: [] }` — удалять
// через /api/db нельзя вообще, и это правильно: на этих строках висят приёмы,
// талоны очереди и госпитализации, а SQLite здесь без ON DELETE, поэтому
// физическое удаление оставило бы висячие ссылки в клинических данных.
//
// Поэтому удаление живёт здесь и работает по одному правилу: СНАЧАЛА
// посчитать, кто ссылается.
//   * никто не ссылается  → строку можно убрать физически;
//   * кто-то ссылается    → НЕ удаляем, а отключаем (active = 0) и честно
//                           говорим, что именно держит.
// Отключённое помещение исчезает из выбора, но визит трёхлетней давности
// по-прежнему знает, в каком кабинете он был. Это ровно то поведение, которого
// ждёт администратор, нажимая «Удалить» на палате с историей.
import { hasAnyRole } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ADMIN_ONLY = ['admin'];

// Кто может держать строку. Порядок важен только для текста сообщения.
const HOLDERS = {
  floor: [
    ['rooms', 'floor_id', 'кабинеты'],
    ['wards', 'floor_id', 'палаты'],
  ],
  room: [
    ['users', 'room_id', 'врачи'],
    ['services', 'room_id', 'услуги'],
    ['service_queue_tickets', 'room_id', 'талоны очереди'],
  ],
  ward: [
    ['beds', 'ward_id', 'койки'],
    ['admissions', 'ward_id', 'госпитализации'],
    ['admission_services', 'ward_id', 'начисления стационара'],
  ],
  bed: [
    ['admissions', 'bed_id', 'госпитализации'],
  ],
};
const TABLE = { floor: 'floors', room: 'rooms', ward: 'wards', bed: 'beds' };

export function roomsSetupDelete(db, args, user) {
  if (!hasAnyRole(user, ADMIN_ONLY)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
  const a = args || {};
  const kind = String(a.kind || '');
  const table = TABLE[kind];
  if (!table) throw new RpcError('kind must be one of: floor, room, ward, bed.', 400);
  const id = Number(a.id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('id is required.', 400);

  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new RpcError('Not found.', 400);

  // Койки палаты не считаются "чужой" ссылкой: их удаляют вместе с палатой,
  // если сами они ничем не заняты. Иначе палату с пустыми койками нельзя было
  // бы убрать никогда.
  const held = [];
  for (const [t, col, label] of (HOLDERS[kind] || [])) {
    let n = 0;
    try {
      n = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${col} = ?`).get(id).c;
    } catch (e) {
      continue;   // таблицы может не быть в этой сборке — тогда и держать нечем
    }
    if (kind === 'ward' && t === 'beds') {
      const busy = db.prepare(
        "SELECT COUNT(*) c FROM beds WHERE ward_id = ? AND status <> 'free'").get(id).c;
      const admitted = db.prepare(
        'SELECT COUNT(*) c FROM admissions WHERE ward_id = ?').get(id).c;
      if (!busy && !admitted) continue;   // пустые койки уйдут вместе с палатой
    }
    if (n > 0) held.push({ what: label, count: n });
  }

  if (held.length) {
    db.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).run(id);
    return {
      deleted: false,
      deactivated: true,
      held,
      message: 'На помещении есть данные (' +
        held.map((x) => x.what + ': ' + x.count).join(', ') +
        '), поэтому оно отключено, а не удалено — история останется целой.',
    };
  }

  const run = db.transaction(() => {
    if (kind === 'ward') db.prepare('DELETE FROM beds WHERE ward_id = ?').run(id);
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  });
  run();
  return { deleted: true, deactivated: false, held: [] };
}
