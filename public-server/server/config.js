// PUBLIC_SERVER_V1 — настройки публичного сервера: только из переменных
// окружения (systemd-служба задаёт их в EnvironmentFile, DEPLOY.md). Неверное
// значение — отказ запуска с именем переменной, а не тихое умолчание.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function int(env, name, def, min, max) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: ожидается целое число от ${min} до ${max}`);
  return n;
}

function trustProxyOf(raw) {
  const s = String(raw == null ? 'loopback' : raw).trim();
  if (s === '' || s === '0' || s === 'false') return false;
  return s;
}

/**
 * @returns {{port:number, bind:string, dataDir:string, baseUrl:string, licenceKeyPath:string, trustProxy:(string|false),
 *   requireHttps:boolean, offsetMin:number, syncSkewMs:number, selfIps:string[], metricsToken:string, webhooks:boolean}}
 */
export function readConfig(env = process.env, { root = SERVICE_ROOT } = {}) {
  const dataRaw = String(env.PUBLIC_DATA_DIR || '').trim();
  const base = String(env.PUBLIC_BASE_URL || 'https://api.easymed.uz').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/.test(base)) throw new Error('PUBLIC_BASE_URL: ожидается адрес вида https://api.easymed.uz');
  return {
    port: int(env, 'PUBLIC_PORT', 8095, 1, 65535),
    bind: String(env.PUBLIC_BIND || '127.0.0.1').trim(),
    dataDir: dataRaw ? path.resolve(root, dataRaw) : path.join(root, 'data'),
    baseUrl: base,
    licenceKeyPath: String(env.PUBLIC_LICENCE_PUBLIC_KEY || '').trim(),
    trustProxy: trustProxyOf(env.PUBLIC_TRUST_PROXY),
    requireHttps: String(env.PUBLIC_REQUIRE_HTTPS ?? '1').trim() !== '0',
    offsetMin: int(env, 'PUBLIC_TZ_OFFSET_MIN', 300, -720, 840),
    syncSkewMs: int(env, 'PUBLIC_SYNC_SKEW_MIN', 15, 1, 1440) * 60000,
    selfIps: String(env.PUBLIC_SELF_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
    metricsToken: String(env.PUBLIC_METRICS_TOKEN || '').trim(),
    webhooks: String(env.PUBLIC_WEBHOOKS ?? '1').trim() !== '0',
  };
}
