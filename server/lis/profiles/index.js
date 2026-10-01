// LIS_INGEST_V1 — реестр профилей.
//
// Добавить анализатор = добавить файл и одну строку здесь. Профиль — ДАННЫЕ, а
// не код: это и есть причина, по которой новая машина не переписывает движок, а
// поставка нового профиля доходит до каждой клиники обычным обновлением.
//
// LIS_REAL_ANALYZERS_V1_PROFILES — у профиля могут быть (тоже данные):
//   aliases            как прибор может назвать себя в MSH-3/4 (нет — [model]);
//   wire               провод: поля номера пробы, кода и значения (wire.js;
//                      нет — 'default', ровно как читались прежние профили);
//   oneTestPerMessage  по одному тесту в сообщении — бланк судится по серии
//                      (match.js planSeries);
//   connect            кто звонит: 'listen' — прибор на порт Easy-Med,
//                      'unknown' — по настройкам прибора (lab_devices.dial);
//   wireSource         откуда известен провод: 'documented', 'driver', 'siblings'.
import bc20 from './mindray-bc-20.js';
import bc5300 from './mindray-bc-5300.js';
import bs240 from './mindray-bs-240.js';
import cl900i from './mindray-cl-900i.js';
import bc2800 from './mindray-bc-2800.js';         // только RS-232 — приходит через переадресатор
import bc3000plus from './mindray-bc-3000-plus.js'; // только RS-232 — приходит через переадресатор
import bs200 from './mindray-bs-200.js';            // LIS_REAL_ANALYZERS_V1_PROFILES — биохимия, по одному тесту в сообщении
import a1000 from './autobio-autolumo-a1000.js';    // LIS_REAL_ANALYZERS_V1_PROFILES — ИХЛА, HL7 по сети (COM — через переадресатор)
import bc780 from './mindray-bc-780.js';            // LIS_REAL_ANALYZERS_V1_PROFILES — гематология, по документам соседних моделей

const ALL = Object.freeze([bc20, bc5300, bs240, cl900i, bc2800, bc3000plus, bs200, a1000, bc780]);
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

/**
 * LIS_REAL_ANALYZERS_V1_MODEL — как прибор может назвать себя: список профиля,
 * а без списка — сама модель (прежние профили).
 */
export function aliasesOf(p) {
  if (!p) return [];
  return Array.isArray(p.aliases) && p.aliases.length ? p.aliases : [p.model];
}
