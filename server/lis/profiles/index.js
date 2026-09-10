// LIS_INGEST_V1 — реестр профилей.
//
// Добавить анализатор = добавить файл и одну строку здесь. Профиль — ДАННЫЕ, а
// не код: это и есть причина, по которой новая машина не переписывает движок, а
// поставка нового профиля доходит до каждой клиники обычным обновлением.
import bc20 from './mindray-bc-20.js';
import bc5300 from './mindray-bc-5300.js';
import bs240 from './mindray-bs-240.js';
import cl900i from './mindray-cl-900i.js';

const ALL = Object.freeze([bc20, bc5300, bs240, cl900i]);
const BY_KEY = new Map(ALL.map((p) => [p.key, p]));

export function listProfiles() { return ALL; }

/**
 * null, а не исключение: устройство могло остаться от снятого профиля, и экран
 * обязан показать его строкой «профиль не найден», а не упасть целиком.
 */
export function getProfile(key) { return BY_KEY.get(key) || null; }

/** Канал профиля по коду, без учёта регистра. null — код прибору незнаком. */
export function findChannel(key, code) {
  const p = getProfile(key);
  if (!p) return null;
  const want = String(code || '').trim().toUpperCase();
  return p.channels.find((c) => c.code.toUpperCase() === want) || null;
}
