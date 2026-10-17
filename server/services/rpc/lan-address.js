// LAN_ADDRESS_V1 — экран «Адрес в сети» (Настройки → Настройки Easy-Med) и
// баннер администратора «Адрес сервера изменился».
//
//   lan_address_status  — адреса этого ПК, смена «было → стало», имя в сети.
//                         Чтение (READ_ONLY_RPCS): адрес сервера и имя знает
//                         любой сотрудник — он набирает их в браузере. MAC, имена
//                         сетевых карт, маска и подсказка роутера — только
//                         администратору (перепроверка 2026-10-17, решение 9):
//                         закреплять адрес в роутере — его работа.
//   lan_address_dismiss — «Скрыть до следующей смены»; только администратор.
//   lan_address_mdns    — имя в сети: включить / выключить; только администратор.
// Оба пишут файл data/lan-address.json этого ПК, а не данные клиники, поэтому
// работают и при просроченной лицензии (ALWAYS_ALLOWED_RPCS, как backup_*):
// клиника без подписки всё равно должна находить свой сервер.
import { hasAnyRole } from '../roles.js';
import { getDataDir } from '../control/config.js';
import { lanStatus, applyMdns } from '../lan/index.js';
import { dismissChange, setMdnsEnabled } from '../lan/state.js';

class LanAddressError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function requireUser(user) {
  if (!user) throw new LanAddressError('Войдите в систему.', 401);
}
// hasAnyRole, не user.role: администратор с основной ролью врача — тоже администратор (ADMIN_DOCTOR_V1).
function requireAdmin(user) {
  requireUser(user);
  if (!hasAnyRole(user, ['admin'])) throw new LanAddressError('Это меняет только администратор.', 403);
}

export function lanAddressStatus(db, args, user) {
  requireUser(user);
  const s = lanStatus(db, getDataDir());
  if (hasAnyRole(user, ['admin'])) return { ...s, can_manage: true };
  return { addresses: s.addresses.map((a) => ({ address: a.address })), port: s.port, change: s.change,
    name: s.name, mdns_enabled: s.mdns_enabled, can_manage: false };
}

export function lanAddressDismiss(db, args, user) {
  requireAdmin(user);
  const at = args && args.at;
  if (typeof at !== 'string' || !at) throw new LanAddressError('Не указано, какую смену адреса скрыть.');
  dismissChange(getDataDir(), at);
  return lanAddressStatus(db, {}, user);
}

// Не async: отказ (права, неверный ввод) бросается сразу, а ждём только запуска ответчика.
export function lanAddressMdns(db, args, user) {
  requireAdmin(user);
  const enabled = args && args.enabled;
  if (typeof enabled !== 'boolean') throw new LanAddressError('Укажите: включить или выключить имя в сети.');
  setMdnsEnabled(getDataDir(), enabled);
  return applyMdns().then(() => lanAddressStatus(db, {}, user));
}
