// PUBLIC_SERVER_V1 — настройки: умолчания для работы за nginx на той же
// машине, переопределение переменными, неверное значение — отказ запуска.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readConfig } from './config.js';

const ROOT = path.resolve('/srv/public-server');

test('умолчания: слушает только 127.0.0.1:8095, за nginx (loopback), только https, Ташкент UTC+5', () => {
  const c = readConfig({}, { root: ROOT });
  assert.equal(c.port, 8095);
  assert.equal(c.bind, '127.0.0.1');
  assert.equal(c.dataDir, path.join(ROOT, 'data'));
  assert.equal(c.baseUrl, 'https://api.easymed.uz');
  assert.equal(c.trustProxy, 'loopback');
  assert.equal(c.requireHttps, true);
  assert.equal(c.offsetMin, 300);
  assert.equal(c.syncSkewMs, 15 * 60000);
  assert.deepEqual(c.selfIps, []);
  assert.equal(c.metricsToken, '');
  assert.equal(c.webhooks, true);
  assert.equal(c.licenceKeyPath, '');
});

test('переопределение переменными окружения', () => {
  const c = readConfig({
    PUBLIC_PORT: '9001', PUBLIC_BIND: '0.0.0.0', PUBLIC_DATA_DIR: '/var/lib/easymed-public', PUBLIC_BASE_URL: 'https://api.test/',
    PUBLIC_TRUST_PROXY: '0', PUBLIC_REQUIRE_HTTPS: '0', PUBLIC_TZ_OFFSET_MIN: '0', PUBLIC_SYNC_SKEW_MIN: '60',
    PUBLIC_SELF_IPS: '45.77.242.169, 10.0.0.5', PUBLIC_METRICS_TOKEN: 'm', PUBLIC_WEBHOOKS: '0', PUBLIC_LICENCE_PUBLIC_KEY: '/etc/k.pem',
  }, { root: ROOT });
  assert.equal(c.port, 9001);
  assert.equal(c.bind, '0.0.0.0');
  assert.equal(c.dataDir, path.resolve('/var/lib/easymed-public'));
  assert.equal(c.baseUrl, 'https://api.test');
  assert.equal(c.trustProxy, false);
  assert.equal(c.requireHttps, false);
  assert.equal(c.offsetMin, 0);
  assert.equal(c.syncSkewMs, 3600000);
  assert.deepEqual(c.selfIps, ['45.77.242.169', '10.0.0.5']);
  assert.equal(c.metricsToken, 'm');
  assert.equal(c.webhooks, false);
  assert.equal(c.licenceKeyPath, '/etc/k.pem');
});

test('неверное значение — отказ с именем переменной', () => {
  assert.throws(() => readConfig({ PUBLIC_PORT: 'восемь' }, { root: ROOT }), /PUBLIC_PORT/);
  assert.throws(() => readConfig({ PUBLIC_TZ_OFFSET_MIN: '5000' }, { root: ROOT }), /PUBLIC_TZ_OFFSET_MIN/);
  assert.throws(() => readConfig({ PUBLIC_BASE_URL: 'api.easymed.uz' }, { root: ROOT }), /PUBLIC_BASE_URL/);
});
