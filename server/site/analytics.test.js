// WEBSITE_V1 (задача W3) — маячок аналитики: сессии, просмотры, куки.
// Правило W3-R3 пронизывает почти каждый тест: /api/beacon ВСЕГДА отвечает
// 204, что бы ни случилось (мусор в теле, бот, превышение лимита).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSite } from './app.test.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { recordBeacon, pruneWebsiteAnalytics } from './analytics.js';
import { invalidateContentCache } from './content.js';

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
}

// W3-2 — свёртки/чистка тестируются напрямую через recordBeacon()/
// pruneWebsiteAnalytics(), без HTTP: это чистая работа с БД (см. заголовок
// файла analytics.js), а каждому тесту нужна СВОЯ база — getSettings()
// кэширует settings в module-scope Map по TTL, поэтому invalidateContentCache()
// обязателен после создания новой :memory:-базы, иначе pruneWebsiteAnalytics
// в одном тесте может прочитать settings, закэшированные для базы другого.
function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  invalidateContentCache();
  return db;
}

function statValue(db, day, metric, key = '') {
  const row = db.prepare('SELECT value FROM website_stats_daily WHERE day=? AND metric=? AND key=?').get(day, metric, key);
  return row ? row.value : 0;
}

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

async function beacon(base, body, cookie) {
  return fetch(base + '/api/beacon', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('маячок всегда отвечает 204 — даже на мусорное тело', async () => {
  const { server, base, db } = await startSite();
  try {
    const res = await fetch(base + '/api/beacon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(res.status, 204);
    assert.equal(countRows(db, 'website_sessions'), 0, 'мусор не должен создавать сессию');
  } finally { server.close(); }
});

test('первый маячок создаёт сессию и просмотр, выставляет обе куки', async () => {
  const { server, base, db } = await startSite();
  try {
    const res = await beacon(base, { path: '/uz/', page_type: 'home', ref: '', lang: 'uz' });
    assert.equal(res.status, 204);
    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, /wsid=[0-9a-f]{24}/);
    assert.match(setCookie, /wvid=[0-9a-f]{24}/);
    assert.equal(countRows(db, 'website_sessions'), 1);
    assert.equal(countRows(db, 'website_pageviews'), 1);
    const session = db.prepare('SELECT * FROM website_sessions').get();
    assert.equal(session.entry_path, '/uz/');
    assert.equal(session.pageviews, 1);
    assert.equal(session.is_returning, 0, 'куки wvid ещё не было — первый визит');
    const pv = db.prepare('SELECT * FROM website_pageviews').get();
    assert.equal(pv.path, '/uz/');
    assert.equal(pv.page_type, 'home');
  } finally { server.close(); }
});

test('второй маячок с той же кукой wsid переиспользует сессию', async () => {
  const { server, base, db } = await startSite();
  try {
    const first = await beacon(base, { path: '/uz/', page_type: 'home', ref: '', lang: 'uz' });
    const setCookie = first.headers.get('set-cookie') || '';
    const wsid = /wsid=([0-9a-f]{24})/.exec(setCookie)[1];
    const wvid = /wvid=([0-9a-f]{24})/.exec(setCookie)[1];

    const second = await beacon(base, { path: '/uz/doctors', page_type: 'doctors', ref: '', lang: 'uz' },
      `wsid=${wsid}; wvid=${wvid}`);
    assert.equal(second.status, 204);

    assert.equal(countRows(db, 'website_sessions'), 1, 'одна и та же сессия, не новая строка');
    assert.equal(countRows(db, 'website_pageviews'), 2);
    const session = db.prepare('SELECT * FROM website_sessions').get();
    assert.equal(session.id, wsid);
    assert.equal(session.pageviews, 2);
  } finally { server.close(); }
});

test('UA бота не пишет ничего в базу', async () => {
  const { server, base, db } = await startSite();
  try {
    const res = await fetch(base + '/api/beacon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
      body: JSON.stringify({ path: '/uz/', page_type: 'home', ref: '', lang: 'uz' }),
    });
    assert.equal(res.status, 204);
    assert.equal(countRows(db, 'website_sessions'), 0);
    assert.equal(countRows(db, 'website_pageviews'), 0);
    assert.ok(!(res.headers.get('set-cookie') || ''), 'боту куки не нужны');
  } finally { server.close(); }
});

test('строка запроса вырезается из сохранённого пути, utm попадает в сессию', async () => {
  const { server, base, db } = await startSite();
  try {
    await beacon(base, {
      path: '/uz/services?utm_source=fb&utm_medium=cpc&utm_campaign=promo',
      page_type: 'services', ref: '', lang: 'uz',
    });
    const pv = db.prepare('SELECT path FROM website_pageviews').get();
    assert.equal(pv.path, '/uz/services', 'query-строка не хранится в просмотре');
    const session = db.prepare('SELECT utm_source, utm_medium, utm_campaign FROM website_sessions').get();
    assert.equal(session.utm_source, 'fb');
    assert.equal(session.utm_medium, 'cpc');
    assert.equal(session.utm_campaign, 'promo');
  } finally { server.close(); }
});

// Fix 3 — entry_path сессии обязан быть тем же query-stripped путём, что и
// сохранённый просмотр: раньше сессия хранила path КАК ЕСТЬ, включая '?...',
// и туда же протекали произвольные query-параметры (например, чужой email).
test('entry_path сессии — без строки запроса, даже если в ней PII-подобный мусор', async () => {
  const { server, base, db } = await startSite();
  try {
    await beacon(base, {
      path: '/uz/appointment?utm_source=x&email=a@b.c',
      page_type: 'appointment', ref: '', lang: 'uz',
    });
    const session = db.prepare('SELECT entry_path FROM website_sessions').get();
    assert.ok(!session.entry_path.includes('?'), `entry_path не должен содержать '?': ${session.entry_path}`);
    assert.equal(session.entry_path, '/uz/appointment');
  } finally { server.close(); }
});

// Fix 2 — присланные куки wsid/wvid валидируются форматом /^[0-9a-f]{24}$/
// ДО того, как попадут в ответ или в SQL: иначе значение куки, пришедшее от
// клиента (например, `wvid=x; Domain=evil`, декодированное из query-encoded
// значения), эхом уходит обратно в Set-Cookie — классическая инъекция
// атрибутов куки через отражённый ввод.
test('невалидная кука wvid (инъекция атрибутов) не отражается в ответе — минтится свежая', async () => {
  const { server, base, db } = await startSite();
  try {
    const res = await beacon(base, { path: '/uz/', page_type: 'home', ref: '', lang: 'uz' },
      'wvid=x%3B%20Domain%3Devil');
    const setCookie = res.headers.get('set-cookie') || '';
    assert.ok(!/evil/i.test(setCookie), `инъекция не должна попасть в Set-Cookie: ${setCookie}`);
    assert.ok(!setCookie.includes('Domain='), `посторонний Domain= не должен появиться: ${setCookie}`);
    const m = /wvid=([^;]+)/.exec(setCookie);
    assert.ok(m, 'wvid должен быть выставлен');
    assert.match(m[1], /^[0-9a-f]{24}$/, `wvid должен быть свежим 24-hex значением: ${m[1]}`);
  } finally { server.close(); }
});

test('присланная кука wvid помечает сессию как возвращение', async () => {
  const { server, base, db } = await startSite();
  try {
    await beacon(base, { path: '/uz/', page_type: 'home', ref: '', lang: 'uz' }, 'wvid=aaaaaaaaaaaaaaaaaaaaaaaa');
    const session = db.prepare('SELECT is_returning FROM website_sessions').get();
    assert.equal(session.is_returning, 1);
  } finally { server.close(); }
});

test('реферер с хостом самого сайта (Host запроса) — это не внешний переход', async () => {
  const { server, base, db } = await startSite();
  try {
    // base — это http://127.0.0.1:<port> тестового сервера: тот же хост,
    // что попадёт в заголовок Host запроса маячка. Раньше same-site сверялся
    // только с settings.seo.base_url, который по умолчанию пуст — тогда
    // КАЖДЫЙ такой переход считался бы внешним и портил расчёт источников.
    await beacon(base, { path: '/uz/doctors', page_type: 'doctors', ref: base + '/uz/', lang: 'uz' });
    const session = db.prepare('SELECT referrer_host FROM website_sessions').get();
    assert.equal(session.referrer_host, '', 'переход с той же страницы сайта — не внешний источник');
  } finally { server.close(); }
});

test('мусорный lang сохраняется как пустая строка, а не протаскивается как есть', async () => {
  const { server, base, db } = await startSite();
  try {
    await beacon(base, { path: '/uz/', page_type: 'home', ref: '', lang: 'fr-CA<script>' });
    const session = db.prepare('SELECT lang FROM website_sessions').get();
    assert.equal(session.lang, '', 'lang не входит в белый список uz/ru/en');
  } finally { server.close(); }
});

test('61-й маячок за минуту с одного IP — всё ещё 204, но без новой строки', async () => {
  const { server, base, db } = await startSite();
  try {
    for (let i = 0; i < 60; i++) {
      const res = await beacon(base, { path: `/uz/?n=${i}`, page_type: 'home', ref: '', lang: 'uz' });
      assert.equal(res.status, 204);
    }
    const before = countRows(db, 'website_pageviews');
    const res61 = await beacon(base, { path: '/uz/', page_type: 'home', ref: '', lang: 'uz' });
    assert.equal(res61.status, 204, 'лимит не имеет права дать что-то, кроме 204');
    assert.equal(countRows(db, 'website_pageviews'), before, '61-й запрос не должен писать в базу');
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// W3-2 — суточные свёртки (website_stats_daily)
// ---------------------------------------------------------------------------

test('свёртки: 2 сессии по 3 просмотра каждая — все контрактные метрики точны', () => {
  const db = freshDb();
  const day = new Date().toISOString().slice(0, 10);

  // Сессия A: новый визит (кука wvid не пришла), desktop, внешний реферер google.com.
  const a1 = recordBeacon(db, { path: '/uz/', page_type: 'home', ref: 'https://google.com/x', lang: 'uz' },
    { ua: DESKTOP_UA });
  recordBeacon(db, { path: '/uz/doctors', page_type: 'doctors', ref: '', lang: 'uz' },
    { ua: DESKTOP_UA, wsid: a1.wsid, wvid: a1.wvid });
  recordBeacon(db, { path: '/uz/services', page_type: 'services', ref: '', lang: 'uz' },
    { ua: DESKTOP_UA, wsid: a1.wsid, wvid: a1.wvid });

  // Сессия B: возвращение (кука wvid уже была на первом маячке), mobile, реферер yandex.ru.
  const b1 = recordBeacon(db, { path: '/uz/about', page_type: 'about', ref: 'https://yandex.ru/search', lang: 'uz' },
    { ua: MOBILE_UA, wvid: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
  recordBeacon(db, { path: '/uz/contact', page_type: 'contact', ref: '', lang: 'uz' },
    { ua: MOBILE_UA, wsid: b1.wsid, wvid: b1.wvid });
  recordBeacon(db, { path: '/uz/faq', page_type: 'faq', ref: '', lang: 'uz' },
    { ua: MOBILE_UA, wsid: b1.wsid, wvid: b1.wvid });

  assert.equal(a1.isNew, true);
  assert.equal(b1.isNew, true);

  assert.equal(statValue(db, day, 'pageviews'), 6, 'все 6 просмотров учтены');
  for (const p of ['/uz/', '/uz/doctors', '/uz/services', '/uz/about', '/uz/contact', '/uz/faq']) {
    assert.equal(statValue(db, day, 'pageviews_by_path', p), 1, p);
  }
  assert.equal(statValue(db, day, 'sessions'), 2, 'ровно 2 новые сессии, не 6 (по числу просмотров)');
  assert.equal(statValue(db, day, 'sessions_by_source', 'google.com'), 1);
  assert.equal(statValue(db, day, 'sessions_by_source', 'yandex.ru'), 1);
  assert.equal(statValue(db, day, 'sessions_by_device', 'desktop'), 1);
  assert.equal(statValue(db, day, 'sessions_by_device', 'mobile'), 1);
  assert.equal(statValue(db, day, 'sessions_returning'), 1, 'только сессия B помечена как возврат');
});

// Fix 1 — защита от cardinality-DoS: количество уникальных ключей на пару
// (day, metric) ограничено сверху; переполнение сгребается в сентинел-ключ
// '(other)'. Путь просмотра приходит от клиента без ограничения на
// уникальность — без этой границы злоумышленник мог бы засыпать
// website_stats_daily миллионами строк (по строке на выдуманный путь).
test('свёртки: pageviews_by_path ограничен по числу уникальных ключей, излишек уходит в (other)', () => {
  const db = freshDb();
  const day = new Date().toISOString().slice(0, 10);

  const first = recordBeacon(db, { path: '/uz/p/0', page_type: 'other', ref: '', lang: 'uz' }, { ua: DESKTOP_UA });
  for (let i = 1; i < 502; i++) {
    recordBeacon(db, { path: `/uz/p/${i}`, page_type: 'other', ref: '', lang: 'uz' },
      { ua: DESKTOP_UA, wsid: first.wsid, wvid: first.wvid });
  }

  const rowCount = db.prepare(
    "SELECT COUNT(*) c FROM website_stats_daily WHERE day=? AND metric='pageviews_by_path'").get(day).c;
  assert.ok(rowCount <= 501, `строк не должно быть больше 500 реальных ключей + 1 (other): ${rowCount}`);
  const overflow = statValue(db, day, 'pageviews_by_path', '(other)');
  assert.ok(overflow >= 1, '(other) должен накопить хотя бы один переполнивший путь');
  assert.equal(overflow, 502 - 500, 'ровно избыток сверх лимита в 500 ключей');
});

test('свёртки: второй просмотр той же сессии НЕ увеличивает sessions', () => {
  const db = freshDb();
  const day = new Date().toISOString().slice(0, 10);
  const first = recordBeacon(db, { path: '/uz/', page_type: 'home', ref: '', lang: 'uz' }, { ua: DESKTOP_UA });
  recordBeacon(db, { path: '/uz/doctors', page_type: 'doctors', ref: '', lang: 'uz' },
    { ua: DESKTOP_UA, wsid: first.wsid, wvid: first.wvid });

  assert.equal(statValue(db, day, 'sessions'), 1, 'сессия одна — второй маячок её переиспользовал');
  assert.equal(statValue(db, day, 'pageviews'), 2, 'но оба просмотра учтены');
});

// ---------------------------------------------------------------------------
// W3-2 — pruneWebsiteAnalytics: чистка сырых данных по сроку хранения
// ---------------------------------------------------------------------------

function backdate(db, wsid, isoDate) {
  db.prepare('UPDATE website_pageviews SET created_at = ? WHERE session_id = ?').run(isoDate, wsid);
  db.prepare('UPDATE website_sessions SET last_seen = ? WHERE id = ?').run(isoDate, wsid);
}

function daysAgoIso(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

test('pruneWebsiteAnalytics: удаляет старое (91 день, дефолт 90), хранит недавнее и свёртки', () => {
  const db = freshDb();

  recordBeacon(db, { path: '/uz/', page_type: 'home', ref: '', lang: 'uz' }, { ua: DESKTOP_UA }); // недавняя
  const stale = recordBeacon(db, { path: '/uz/old', page_type: 'other', ref: '', lang: 'uz' }, { ua: DESKTOP_UA });
  backdate(db, stale.wsid, daysAgoIso(91));

  assert.equal(countRows(db, 'website_sessions'), 2);
  assert.equal(countRows(db, 'website_pageviews'), 2);
  const sessionsStatBefore = statValue(db, new Date().toISOString().slice(0, 10), 'sessions');

  const result = pruneWebsiteAnalytics(db);
  assert.deepEqual(result, { pageviews: 1, sessions: 1 });
  assert.equal(countRows(db, 'website_sessions'), 1, 'осталась только недавняя сессия');
  assert.equal(countRows(db, 'website_pageviews'), 1, 'остался только недавний просмотр');
  assert.equal(db.prepare('SELECT path FROM website_pageviews').get().path, '/uz/');

  // Свёртки — исторический отчёт, чистка сырых данных их не трогает.
  assert.equal(statValue(db, new Date().toISOString().slice(0, 10), 'sessions'), sessionsStatBefore);
});

test('pruneWebsiteAnalytics: сессия с живым просмотром переживает чистку, даже если last_seen устарел', () => {
  const db = freshDb();
  const s = recordBeacon(db, { path: '/uz/', page_type: 'home', ref: '', lang: 'uz' }, { ua: DESKTOP_UA });
  // Только last_seen устарел — сам просмотр (created_at) свежий.
  db.prepare('UPDATE website_sessions SET last_seen = ? WHERE id = ?').run(daysAgoIso(91), s.wsid);

  const result = pruneWebsiteAnalytics(db);
  assert.deepEqual(result, { pageviews: 0, sessions: 0 }, 'NOT EXISTS не срабатывает — просмотр ещё жив');
  assert.equal(countRows(db, 'website_sessions'), 1);
});

test('pruneWebsiteAnalytics: retention_days из настроек соблюдается, минимум клэмпается к 7', () => {
  const db = freshDb();
  db.prepare('UPDATE website_settings SET settings = ? WHERE id=1')
    .run(JSON.stringify({ analytics: { retention_days: 3 } })); // ниже минимума — должно клэмпнуться к 7
  invalidateContentCache();

  const s = recordBeacon(db, { path: '/uz/', page_type: 'home', ref: '', lang: 'uz' }, { ua: DESKTOP_UA });
  backdate(db, s.wsid, daysAgoIso(8)); // старше клэмпнутого минимума (7), но новее заявленных 3

  const result = pruneWebsiteAnalytics(db);
  assert.deepEqual(result, { pageviews: 1, sessions: 1 });
});

test('pruneWebsiteAnalytics: явный retention_days=30 из настроек соблюдается как есть', () => {
  const db = freshDb();
  db.prepare('UPDATE website_settings SET settings = ? WHERE id=1')
    .run(JSON.stringify({ analytics: { retention_days: 30 } }));
  invalidateContentCache();

  const s = recordBeacon(db, { path: '/uz/', page_type: 'home', ref: '', lang: 'uz' }, { ua: DESKTOP_UA });
  backdate(db, s.wsid, daysAgoIso(20));
  assert.deepEqual(pruneWebsiteAnalytics(db), { pageviews: 0, sessions: 0 }, '20 дней < 30 — рано удалять');

  backdate(db, s.wsid, daysAgoIso(40));
  assert.deepEqual(pruneWebsiteAnalytics(db), { pageviews: 1, sessions: 1 }, '40 дней > 30 — пора удалять');
});
