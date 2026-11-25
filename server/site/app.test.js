// WEBSITE_V1 — второй слушатель: у публичного сайта нет НИЧЕГО от ЕРП.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createSiteApp } from './app.js';
import { invalidateContentCache } from './content.js';

// WEBSITE_V1 — opts прокидывается прямо в createSiteApp (задача 12 добавляет
// opts.mediaDir для подмены каталога /media в тестах); существующие вызовы
// без opts не меняют поведение.
export function startSite(prep, opts) {
  const db = openDb(':memory:');
  migrate(db);
  if (prep) prep(db);
  return new Promise((resolve) => {
    const server = createSiteApp(db, opts).listen(0, '127.0.0.1', () => {
      resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('корень отвечает редиректом на язык по умолчанию', async () => {
  const { server, base } = await startSite();
  try {
    const res = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/uz/');
  } finally { server.close(); }
});

test('заголовки безопасности стоят на каждом ответе', async () => {
  const { server, base } = await startSite();
  try {
    const res = await fetch(base + '/uz/', { redirect: 'manual' });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.ok(res.headers.get('referrer-policy'));
  } finally { server.close(); }
});

test('поверхностей ЕРП на сайте не существует', async () => {
  const { server, base } = await startSite();
  try {
    for (const p of ['/admin.html', '/admin', '/users', '/index.html',
                     '/js/admin/permissions.js', '/css/admin.css',
                     '/api/health', '/api/auth/login', '/api/db', '/api/rpc/run_report',
                     '/api/storage/clinic-docs/x', '/api/users']) {
      const res = await fetch(base + p, { redirect: 'manual' });
      assert.equal(res.status, 404, `${p} должен быть 404 на публичном сайте`);
    }
  } finally { server.close(); }
});

// W4 Task 2 — trust proxy (спека §4, «Hard precondition for going live behind
// any proxy/tunnel»): opts.trustProxy подменяет SITE_TRUST_PROXY для теста, не
// трогая process.env глобально (см. комментарий в createSiteApp). Оба теста
// бьют по /api/requests (rateLimit(), windowMs=60_000, max=5) — тот же
// маршрут, что и в спеке примера; beaconLimiter() читает req.ip тем же
// способом (app.set('trust proxy', …) — настройка самого Express-приложения,
// действует на ВСЕ маршруты сразу, а не по месту), поэтому отдельного теста
// на /api/beacon не требуется — там нечего проверять иначе, чем здесь.
const callbackBody = () => JSON.stringify({ type: 'callback', full_name: 'Тест', phone: '+998901234567' });
function postAs(base, xff) {
  return fetch(base + '/api/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: callbackBody(),
  });
}

test('trust proxy включён: X-Forwarded-For делит лимит заявок на отдельные IP-корзины', async () => {
  const { server, base } = await startSite(null, { trustProxy: 1 });
  try {
    for (let i = 0; i < 5; i++) {
      const res = await postAs(base, '1.2.3.4');
      assert.equal(res.status, 200, `запрос ${i + 1} от 1.2.3.4 укладывается в лимит 5/мин`);
    }
    const sixthSameIp = await postAs(base, '1.2.3.4');
    assert.equal(sixthSameIp.status, 429, '6-й запрос от того же IP — превышение лимита');

    const otherIp = await postAs(base, '5.6.7.8');
    assert.equal(otherIp.status, 200, 'другой IP за тем же прокси — своя, ещё пустая корзина лимита');
  } finally { server.close(); }
});

test('trust proxy выключен (по умолчанию): X-Forwarded-For игнорируется, все "клиенты" делят один лимит', async () => {
  const { server, base } = await startSite();
  try {
    for (let i = 0; i < 5; i++) {
      const res = await postAs(base, '1.2.3.4');
      assert.equal(res.status, 200);
    }
    const sixthOtherIp = await postAs(base, '5.6.7.8');
    assert.equal(sixthOtherIp.status, 429,
      'без trust proxy req.ip — адрес сокета, X-Forwarded-For не учитывается — тот же "клиент", та же корзина');
  } finally { server.close(); }
});

// Fix 1 (W4, launch-gate review) — CSP теперь считается заново на каждый
// запрос из settings.analytics.inject_snippet/settings.contact.map_embed
// (buildCsp() в app.js): по умолчанию (ни то, ни другое поле не заполнено)
// строка обязана остаться БАЙТ-В-БАЙТ той же строгой строкой, что была до
// Fix 1, — иначе это тихо ослабляет периметр для всех, кто эти функции не
// использует. С заполненным полем CSP расширяется РОВНО под эту функцию.
const STRICT_CSP = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";

function setWebsiteSettings(db, patch) {
  const row = db.prepare('SELECT settings FROM website_settings WHERE id=1').get();
  const settings = JSON.parse(row?.settings || '{}');
  Object.assign(settings, patch);
  db.prepare('UPDATE website_settings SET settings = ? WHERE id=1').run(JSON.stringify(settings));
  invalidateContentCache();
}

test('CSP: по умолчанию (ни snippet, ни map_embed не заданы) — строгая строка без изменений', async () => {
  const { server, base } = await startSite();
  try {
    const res = await fetch(base + '/uz/');
    assert.equal(res.headers.get('content-security-policy'), STRICT_CSP);
  } finally { server.close(); }
});

test('CSP: settings.analytics.inject_snippet задан — script-src/connect-src добавлены, frame-src отсутствует', async () => {
  const { server, base, db } = await startSite();
  try {
    setWebsiteSettings(db, { analytics: { inject_snippet: '<script>x</script>' } });
    const res = await fetch(base + '/uz/');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/www\.googletagmanager\.com https:\/\/mc\.yandex\.ru/);
    assert.match(csp, /connect-src 'self' https:\/\/\*\.google-analytics\.com https:\/\/mc\.yandex\.ru/);
    assert.match(csp, /img-src 'self' data: https:\/\/mc\.yandex\.ru/);
    assert.ok(!csp.includes('frame-src'), 'без map_embed frame-src добавляться не должен');
  } finally { server.close(); }
});

test('CSP: settings.contact.map_embed задан — frame-src добавлен, script-src отсутствует', async () => {
  const { server, base, db } = await startSite();
  try {
    setWebsiteSettings(db, { contact: { map_embed: '<iframe src="https://www.google.com/maps"></iframe>' } });
    const res = await fetch(base + '/uz/');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-src https:\/\/www\.google\.com https:\/\/yandex\.ru https:\/\/maps\.google\.com/);
    assert.ok(!csp.includes('script-src'), 'без inject_snippet script-src добавляться не должен');
  } finally { server.close(); }
});

test('неизвестная страница — HTML 404 на языке из пути', async () => {
  const { server, base } = await startSite();
  try {
    const res = await fetch(base + '/uz/no-such-page');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /text\/html/);
  } finally { server.close(); }
});
