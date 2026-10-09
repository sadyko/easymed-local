// LIS_PROXY_V1 — карточка «LIS Proxy» на экране «Анализаторы»: включить,
// выключить, адрес с ключом для лабораторных ПК, сменить ключ
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, разделы 1 и 7, Р20).
//
// Адрес с ключом — пропуск на запись значений прибора. Видят и меняют его
// администратор и лаборант (они настраивают лабораторные ПК); прочие роли
// раздела лаборатории видят только «включён / выключен». Настройка — файл
// data/lisproxy.json (server/lis/lisproxy-settings.js); RPC не видят req, папку
// данных берут из control/config.js (как лицензия).
import { hasAnyRole } from '../roles.js';
import { LAB_SECTION_ROLES } from '../../db/schema-registry.js';
import { getDataDir } from '../control/config.js';
import { lanAddresses } from '../branch-sync/pairing.js';
import { readProxySettings, writeProxySettings, newProxyKey } from '../../lis/lisproxy-settings.js';

class LisProxyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Кто видит адрес с ключом и меняет его (Р20). */
export const PROXY_KEY_ROLES = Object.freeze(['admin', 'lab']);

/**
 * Состояние для экрана: адреса — по каждому адресу этого ПК в сети, порт —
 * веб-порт Easy-Med (тот же, что печатает server/index.js при запуске).
 */
export function proxyState(dataDir, { port = Number(process.env.PORT || 8000), addresses = lanAddresses() } = {}) {
  const s = readProxySettings(dataDir);
  const urls = s.enabled ? addresses.map((ip) => 'http://' + ip + ':' + port + '/api/lisproxy?key=' + s.key) : [];
  return { enabled: s.enabled, key: s.enabled ? s.key : null, port, addresses, urls, changed_at: s.changed_at };
}

/** lis_proxy_get — чтение (READ_ONLY_RPCS). */
export function lisProxyGet(db, args, user) {
  if (!hasAnyRole(user, LAB_SECTION_ROLES)) throw new LisProxyError('Недостаточно прав', 403);
  const st = proxyState(getDataDir());
  if (hasAnyRole(user, PROXY_KEY_ROLES)) return { ...st, can_manage: true };
  return { enabled: st.enabled, key: null, port: st.port, addresses: [], urls: [], changed_at: st.changed_at, can_manage: false };
}

/**
 * lis_proxy_set — { enabled?: boolean, rotate?: true }. Первое включение
 * создаёт ключ; rotate — новый ключ (старый адрес перестаёт работать сразу:
 * файл читается на каждом запросе). Выключение ключ хранит.
 */
export function lisProxySet(db, args, user) {
  if (!hasAnyRole(user, PROXY_KEY_ROLES)) throw new LisProxyError('Недостаточно прав', 403);
  const a = args || {};
  if (a.enabled !== undefined && typeof a.enabled !== 'boolean') throw new LisProxyError('Укажите: включить или выключить LIS Proxy');
  if ((a.rotate !== undefined && a.rotate !== true) || (a.enabled === undefined && a.rotate !== true)) {
    throw new LisProxyError('Нечего менять: укажите «включить», «выключить» или «сменить ключ»');
  }
  const dir = getDataDir();
  const cur = readProxySettings(dir);
  const enabled = a.enabled === undefined ? cur.enabled : a.enabled;
  const key = a.rotate === true || !cur.key ? newProxyKey() : cur.key;
  writeProxySettings(dir, { enabled, key, changed_by: user && Number.isInteger(user.id) ? user.id : null });
  return lisProxyGet(db, {}, user);
}
