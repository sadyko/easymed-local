// PUBLIC_SERVER_V1 — стенд тестов публичного сервера: свой «производитель»
// (пара Ed25519 вместо настоящего ключа лицензий), подписанная им лицензия с
// отпечатком ключа клиники (так её подпишет шаг 8c), личность клиники из
// настоящего sync-identity.js, база во временной папке, подписанные запросы
// клиники и сервер на случайном порту (listen — без «плохих» портов fetch).
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { canonical } from '../../../server/services/control/canonical.js';
import { loadSyncIdentity, signRequest, SYNC_KEY_FILE } from '../../../server/services/api/sync-identity.js';
import { tmpDir, closeOnExit } from '../../../server/test-helpers/tmpdir.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { errorHandler } from '../lib/errors.js';

export const CLINIC_ID = 'c-000777';
export const NOW = Date.parse('2030-03-11T04:00:00Z');   // 09:00 в Ташкенте

export function testVendor() {
  return crypto.generateKeyPairSync('ed25519');
}

export function signTestLicence(vendor, payload) {
  const sig = crypto.sign(null, Buffer.from(canonical(payload), 'utf8'), vendor.privateKey).toString('base64');
  return JSON.stringify({ payload, sig });
}

/** Клиника: личность (ключи в своей временной папке) и лицензия с отпечатком её ключа. */
export function testClinic(vendor, { clinicId = CLINIC_ID, validUntil = '2030-04-01T00:00:00Z', issuedAt = '2030-03-10T00:00:00Z',
  subscription = undefined, identity = null } = {}) {
  const id = identity || loadSyncIdentity({ keyPath: path.join(tmpDir('em-pub-clinic-'), SYNC_KEY_FILE), create: true });
  const payload = { clinic_id: clinicId, clinic_name: 'Шифо', modules: [], valid_until: validUntil, issued_at: issuedAt,
    nonce: crypto.randomBytes(4).toString('hex'), api_sync_key: id.fingerprint, ...(subscription ? { subscription } : {}) };
  return { clinicId, identity: id, licence: signTestLicence(vendor, payload), payload };
}

export function testDb() {
  const dir = tmpDir('em-pub-db-');
  const file = path.join(dir, 'public.db');
  const db = openDb(file);
  closeOnExit(db);
  migrate(db);
  return { db, dir, file };
}

/** Заголовки подписанного запроса клиники — ровно как их ставит public-sync.js call(). */
export function signedHeaders(clinic, { method, path: p, body = '', time }) {
  return {
    'Content-Type': 'application/json',
    'X-EasyMed-Clinic': clinic.clinicId,
    'X-EasyMed-Key': clinic.identity.signPublic,
    'X-EasyMed-Time': time,
    'X-EasyMed-Signature': signRequest(clinic.identity, { method, path: p, time, body }),
    'X-EasyMed-Licence': Buffer.from(clinic.licence, 'utf8').toString('base64'),
  };
}

/** Сервер на случайном порту с одним маршрутизатором и обработчиком ошибок. */
export async function serve(mount, router, { trustProxy = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(mount, router);
  app.use(errorHandler());
  const server = await listen(app);
  return { base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** Подписанный запрос клиники к серверу стенда. body — объект (JSON) или Buffer. */
export async function syncCall(base, clinic, method, p, body, { time, type = 'application/json' } = {}) {
  const raw = body === undefined ? '' : Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = { ...signedHeaders(clinic, { method, path: p, body: raw, time }), 'Content-Type': type };
  const res = await fetch(base + p, { method, headers, body: raw === '' ? undefined : raw });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}
