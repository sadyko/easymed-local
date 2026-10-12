// PUBLIC_API_V1 — ЛИЧНОСТЬ КЛИНИКИ ДЛЯ ПУБЛИЧНОГО СЕРВЕРА.
//
// Две пары ключей, созданные В КЛИНИКЕ и не покидающие её закрытыми половинами
// (файл <data>/.api-sync-key и копия .bak, рядом с базой, но не в ней — как
// .api-secrets-key шага 7):
//   • подпись (Ed25519) — каждый запрос клиники к публичному серверу подписан:
//     «МЕТОД\nПУТЬ\nВРЕМЯ\nsha256(тело)». Открытую половину клиника отдаёт при
//     ежечасной сверке с сервером лицензий (control/checkin.js), сервер
//     лицензий вписывает её отпечаток в подписанную лицензию (шаг 8c), и
//     публичный сервер узнаёт клинику по лицензии — без общего секрета и без
//     вопроса к серверу лицензий;
//   • ящик (X25519) — данные пациента в заявке (имя, телефон, комментарий)
//     публичный сервер запечатывает открытой половиной в миг приёма: в его базе
//     лежит только шифротекст, открыть который может лишь клиника (openSealed).
//
// Файл испорчен — берётся копия; испорчены оба — отказ, а не новая пара:
// новая пара означала бы новую регистрацию у сервера лицензий.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../control/config.js';

export const SYNC_KEY_FILE = '.api-sync-key';
export const SEAL_PREFIX = 'v1';
const HKDF_INFO = Buffer.from('easymed-seal-v1');

export class SyncIdentityError extends Error {}

export function defaultSyncKeyPath() {
  return process.env.EASYMED_API_SYNC_KEY_PATH || path.join(getDataDir(), SYNC_KEY_FILE);
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
const der = (key) => key.export({ format: 'der', type: key.type === 'public' ? 'spki' : 'pkcs8' });
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function writeDurable(file, content) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/** null — файла нет; false — файл есть, но испорчен; иначе — разобранная личность. */
function readIdentityFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
  try {
    const j = JSON.parse(text);
    if (!j || j.v !== 1) return false;
    const signPrivate = crypto.createPrivateKey({ key: Buffer.from(j.sign, 'base64'), format: 'der', type: 'pkcs8' });
    const boxPrivate = crypto.createPrivateKey({ key: Buffer.from(j.box, 'base64'), format: 'der', type: 'pkcs8' });
    if (signPrivate.asymmetricKeyType !== 'ed25519' || boxPrivate.asymmetricKeyType !== 'x25519') return false;
    return shape(signPrivate, boxPrivate);
  } catch { return false; }
}

function shape(signPrivate, boxPrivate) {
  const signPublicDer = der(crypto.createPublicKey(signPrivate));
  const boxPublicDer = der(crypto.createPublicKey(boxPrivate));
  return {
    signPrivate, boxPrivate,
    signPublic: b64(signPublicDer), boxPublic: b64(boxPublicDer),
    // Отпечаток ключа подписи — его вписывает в лицензию сервер лицензий (шаг 8c).
    fingerprint: sha256(signPublicDer).slice(0, 32),
  };
}

/**
 * PUBLIC_LICENCE_V1 — отпечаток ОТКРЫТОЙ половины ключа подписи, присланной
 * строкой base64 (DER SPKI): первые 32 hex SHA-256 от DER — та же формула, что
 * fingerprint выше и keyFingerprint публичного сервера (clinic-auth.js). Им
 * пользуется сервер лицензий: клиника шлёт открытую половину при сверке
 * (api_sync_public_key), отпечаток уходит в подписанную лицензию. Не Ed25519,
 * мусор, не каноническая запись DER, длиннее 200 знаков — ''. Никогда не бросает.
 */
export function syncKeyFingerprint(signPublicB64) {
  const s = typeof signPublicB64 === 'string' ? signPublicB64.trim() : '';
  if (!s || s.length > 200) return '';
  try {
    const raw = Buffer.from(s, 'base64');
    const key = crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || !der(key).equals(raw)) return '';
    return sha256(raw).slice(0, 32);
  } catch { return ''; }
}

/**
 * Личность клиники. Нет файла — null (или новая пара, если create).
 * @returns {{signPrivate, boxPrivate, signPublic:string, boxPublic:string, fingerprint:string}|null}
 */
export function loadSyncIdentity({ keyPath = defaultSyncKeyPath(), create = false } = {}) {
  const main = readIdentityFile(keyPath);
  if (main) return main;
  const bak = readIdentityFile(keyPath + '.bak');
  if (bak) return bak;
  if (main === false || bak === false) throw new SyncIdentityError('Файл ключа обмена с публичным сервером повреждён. Обратитесь в поддержку Easy-Med.');
  if (!create) return null;
  const sign = crypto.generateKeyPairSync('ed25519');
  const box = crypto.generateKeyPairSync('x25519');
  const text = JSON.stringify({ v: 1, sign: b64(der(sign.privateKey)), box: b64(der(box.privateKey)) });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  writeDurable(keyPath, text);
  writeDurable(keyPath + '.bak', text);
  return shape(sign.privateKey, box.privateKey);
}

/** Строка, которую подписывает клиника: метод, путь, время, отпечаток тела. */
export function canonicalRequest({ method, path: p, time, body = '' }) {
  return String(method).toUpperCase() + '\n' + String(p) + '\n' + String(time) + '\n' + sha256(Buffer.from(body || ''));
}
export function signRequest(identity, parts) {
  return crypto.sign(null, Buffer.from(canonicalRequest(parts)), identity.signPrivate).toString('base64');
}
/** Проверка подписи — так её делает публичный сервер (шаг 8b) и стенд тестов. */
export function verifyRequest(signPublicB64, parts, signatureB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(signPublicB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canonicalRequest(parts)), key, Buffer.from(String(signatureB64 || ''), 'base64'));
  } catch { return false; }
}

function sealKey(shared, ephPubDer, recipientPubDer) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPubDer, recipientPubDer]), HKDF_INFO, 32));
}

/** Запечатать для клиники (так делает публичный сервер при приёме заявки). */
export function sealFor(boxPublicB64, obj) {
  const recipientDer = Buffer.from(boxPublicB64, 'base64');
  const recipient = crypto.createPublicKey({ key: recipientDer, format: 'der', type: 'spki' });
  const eph = crypto.generateKeyPairSync('x25519');
  const ephDer = der(eph.publicKey);
  const key = sealKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient }), ephDer, recipientDer);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [SEAL_PREFIX, b64(ephDer), b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
}

/** Вскрыть запечатанное ключом клиники. Чужое, испорченное — бросает. */
export function openSealed(identity, sealed) {
  const [v, eph, iv, tag, ct] = String(sealed || '').split('.');
  if (v !== SEAL_PREFIX || !eph || !iv || !tag || !ct) throw new SyncIdentityError('Запечатанные данные заявки не открываются.');
  const ephDer = Buffer.from(eph, 'base64');
  const ephKey = crypto.createPublicKey({ key: ephDer, format: 'der', type: 'spki' });
  const key = sealKey(crypto.diffieHellman({ privateKey: identity.boxPrivate, publicKey: ephKey }), ephDer, Buffer.from(identity.boxPublic, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  const plain = Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  return JSON.parse(plain);
}
