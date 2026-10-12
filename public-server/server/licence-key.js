// PUBLIC_LICENCE_V1 — КАКИМ КЛЮЧОМ ПУБЛИЧНЫЙ СЕРВЕР ПРОВЕРЯЕТ ЛИЦЕНЗИИ КЛИНИК И
// СПИСОК ПРОИЗВОДИТЕЛЯ.
//
// По умолчанию — ключом, вшитым в программу (server/services/control/licence.js).
// Сверено 2026-10-12: это НАСТОЯЩИЙ ключ сервера лицензий (с 2026-08-22, коммит
// 6cd66c5c; страж — server/services/control/vendor-key.test.js), и им подписана
// каждая настоящая лицензия. Заметка плана 8b «вшит ключ разработки» устарела.
//
// PUBLIC_LICENCE_PUBLIC_KEY (путь к PEM) — только для стенда. Чужой ключ здесь —
// это «кто держит его закрытую половину, тот любая клиника»: подпишет себе
// лицензию с отпечатком своего ключа обмена, пришлёт свой box_key и получит
// данные пациентов из новых онлайн-записей. Поэтому ключ, отличный от вшитого,
// принимается только вместе с PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1, иначе служба
// не запускается. Тот же ключ, что вшит, — просто «вшитый».
import fs from 'node:fs';
import crypto from 'node:crypto';
import { vendorPublicKey } from '../../server/services/control/licence.js';

/** Отпечаток открытого ключа: первые 32 hex SHA-256 от DER (SPKI). */
export function keyFingerprint32(key) {
  return crypto.createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 32);
}

/**
 * @param {{path?:string, allowForeign?:boolean, readFile?:typeof fs.readFileSync}} [o]
 * @returns {{key: import('node:crypto').KeyObject|null, source:'compiled'|'override', fingerprint:string}}
 *   key null — вшитый ключ (verifyLicence и verifyFeed берут его сами)
 * @throws {Error} с именем переменной: файл — не открытый ключ Ed25519; чужой ключ без разрешения
 */
export function resolveLicenceKey({ path = '', allowForeign = false, readFile = fs.readFileSync } = {}) {
  const compiled = keyFingerprint32(vendorPublicKey());
  if (!path) return { key: null, source: 'compiled', fingerprint: compiled };
  let key;
  try { key = crypto.createPublicKey(readFile(path, 'utf8')); } catch { key = null; }
  if (!key || key.asymmetricKeyType !== 'ed25519') throw new Error('PUBLIC_LICENCE_PUBLIC_KEY: не открытый ключ Ed25519 (' + path + ')');
  const fingerprint = keyFingerprint32(key);
  if (fingerprint === compiled) return { key: null, source: 'compiled', fingerprint };
  if (!allowForeign) {
    throw new Error('PUBLIC_LICENCE_PUBLIC_KEY: ключ ' + fingerprint + ' — не ключ производителя (' + compiled + '). '
      + 'Чужим ключом служба проверяет лицензии только на стенде: PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1.');
  }
  return { key, source: 'override', fingerprint };
}
