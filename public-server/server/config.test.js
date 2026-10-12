// PUBLIC_SERVER_V1 — настройки: умолчания для работы за nginx на той же
// машине, переопределение переменными, неверное значение — отказ запуска.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readConfig, DEFAULT_UNCOLLECTED_MAX_HOURS, DEFAULT_SYNC_SKEW_MIN } from './config.js';

const ROOT = path.resolve('/srv/public-server');

test('умолчания: слушает только 127.0.0.1:8096 (8095 на машине — у сервера лицензий), за nginx (loopback), только https, Ташкент UTC+5', () => {
  const c = readConfig({}, { root: ROOT });
  assert.equal(c.port, 8096);
  assert.equal(c.bind, '127.0.0.1');
  assert.equal(c.dataDir, path.join(ROOT, 'data'));
  assert.equal(c.baseUrl, 'https://api.easymed.uz');
  assert.equal(c.trustProxy, 'loopback');
  assert.equal(c.requireHttps, true);
  assert.equal(c.offsetMin, 300);
  assert.equal(c.syncSkewMs, 15 * 60000);
  assert.equal(c.uncollectedMaxMs, 24 * 3600000);
  assert.deepEqual(c.selfIps, []);
  assert.equal(c.metricsToken, '');
  assert.equal(c.webhooks, true);
  assert.equal(c.licenceKeyPath, '');
  // PUBLIC_LICENCE_V1 — чужой ключ лицензий запрещён; список производителя — с сервера лицензий раз в минуту, без токена — не забирается.
  assert.equal(c.allowForeignLicenceKey, false);
  assert.equal(c.feedUrl, 'https://settings.easymed.uz/cp/v1/public-feed');
  assert.equal(c.feedToken, '');
  assert.equal(c.feedEveryMs, 60000);
});

test('переопределение переменными окружения', () => {
  const c = readConfig({
    PUBLIC_PORT: '9001', PUBLIC_BIND: '0.0.0.0', PUBLIC_DATA_DIR: '/var/lib/easymed-public', PUBLIC_BASE_URL: 'https://api.test/',
    PUBLIC_TRUST_PROXY: '0', PUBLIC_REQUIRE_HTTPS: '0', PUBLIC_TZ_OFFSET_MIN: '0', PUBLIC_SYNC_SKEW_MIN: '60', PUBLIC_UNCOLLECTED_MAX_HOURS: '48',
    PUBLIC_SELF_IPS: '45.77.242.169, 10.0.0.5', PUBLIC_METRICS_TOKEN: 'm', PUBLIC_WEBHOOKS: '0', PUBLIC_LICENCE_PUBLIC_KEY: '/etc/k.pem',
    PUBLIC_ALLOW_FOREIGN_LICENCE_KEY: '1', PUBLIC_FEED_URL: 'http://127.0.0.1:8095/cp/v1/public-feed', PUBLIC_FEED_TOKEN: ' f-TESTONLY ',
    PUBLIC_FEED_EVERY_SEC: '30',
  }, { root: ROOT });
  assert.equal(c.port, 9001);
  assert.equal(c.bind, '0.0.0.0');
  assert.equal(c.dataDir, path.resolve('/var/lib/easymed-public'));
  assert.equal(c.baseUrl, 'https://api.test');
  assert.equal(c.trustProxy, false);
  assert.equal(c.requireHttps, false);
  assert.equal(c.offsetMin, 0);
  assert.equal(c.syncSkewMs, 3600000);
  assert.equal(c.uncollectedMaxMs, 48 * 3600000);
  assert.deepEqual(c.selfIps, ['45.77.242.169', '10.0.0.5']);
  assert.equal(c.metricsToken, 'm');
  assert.equal(c.webhooks, false);
  assert.equal(c.licenceKeyPath, '/etc/k.pem');
  assert.equal(c.allowForeignLicenceKey, true);
  assert.equal(c.feedUrl, 'http://127.0.0.1:8095/cp/v1/public-feed');
  assert.equal(c.feedToken, 'f-TESTONLY');
  assert.equal(c.feedEveryMs, 30000);
});

test('неверное значение — отказ с именем переменной', () => {
  assert.throws(() => readConfig({ PUBLIC_PORT: 'восемь' }, { root: ROOT }), /PUBLIC_PORT/);
  assert.throws(() => readConfig({ PUBLIC_TZ_OFFSET_MIN: '5000' }, { root: ROOT }), /PUBLIC_TZ_OFFSET_MIN/);
  assert.throws(() => readConfig({ PUBLIC_BASE_URL: 'api.easymed.uz' }, { root: ROOT }), /PUBLIC_BASE_URL/);
  assert.throws(() => readConfig({ PUBLIC_UNCOLLECTED_MAX_HOURS: '0' }, { root: ROOT }), /PUBLIC_UNCOLLECTED_MAX_HOURS/);
  assert.throws(() => readConfig({ PUBLIC_FEED_URL: 'settings.easymed.uz/cp/v1/public-feed' }, { root: ROOT }), /PUBLIC_FEED_URL/);
  assert.throws(() => readConfig({ PUBLIC_FEED_EVERY_SEC: '5' }, { root: ROOT }), /PUBLIC_FEED_EVERY_SEC/);
});

test('сроки владельца и контролёра — именованные постоянные, одно место на каждый', () => {
  // Решение владельца 20 (2026-10-12): не забранная клиникой заявка ждёт сутки,
  // затем закрыта для партнёра (closed / not_collected), шифротекст стёрт.
  assert.equal(DEFAULT_UNCOLLECTED_MAX_HOURS, 24);
  // Решение контролёра (2026-10-12): допуск часов клиники — 15 минут.
  assert.equal(DEFAULT_SYNC_SKEW_MIN, 15);
});
