// WEBSITE_V1 — регрессия периметра безопасности публичного сайта: приватные
// данные ЕРП (пациенты, зарплаты, хэши паролей, MRN, users.full_name) не
// должны просочиться ни в один HTML/JSON-ответ. Это ПРОВЕРЯЮЩИЙ набор тестов
// (спека §11/§15) — он обязан проходить сразу же; падение здесь означает
// реальную утечку и лечится в коде сайта (content.js/render/*), а не в тесте.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSite } from './app.test.js';
import { seedSite, seededSlugs } from '../test-helpers/site-seed.js';
import { invalidateContentCache } from './content.js';
import { LANGS } from './i18n.js';

// Сид: базовый seedSite() (врач 'Алиев Шерзод', показанный в профиле — Easy-Med:
// врачи и услуги сайта — это публичные профили, не строки website_*) + пациент с настоящими ФИО/телефоном (сработает
// триггер patients_mrn_autogen и даст 'P-26-…') + обогащение doc1 приватными
// полями users (телефон/почта/фиксированная зарплата/хэш пароля — ни одно из
// них не читается ни одной моделью сайта, см. content.js) + известный
// публичный домен, чтобы sitemap.xml не был пуст.
//
// users.full_name у doc1 переписывается на постороннее имя ПОСЛЕДНИМ шагом:
// карточка/страница врача обязаны брать имя из публичного профиля
// (full_name_ru = 'Алиев Шерзод'), а не из служебного users.full_name. Значит 'Алиев Шерзод'
// должен остаться видимым, а 'Козлов Приватный' — не просочиться никогда.
// W4-3 — фиксированный слаг опубликованной новости: используется и в свипе
// FORBIDDEN (ниже, ENTITY_PAGES), и в performance-проверках (изображения
// ленты/статьи). Контент задан на ВСЕХ трёх языках, иначе pickContent()
// на языке без заголовка вернёт {} и renderPost()/renderNews() дадут 404 —
// свип ждёт 200 везде.
const NEWS_SLUG = 'test-post';

// Easy-Med — фото врача теперь из профиля (users.photo_url + файл в корзине
// doctor-photos хранилища), а не website_doctors.photo_path. Свой каталог
// хранилища на весь файл тестов: в нём лежат фото и показанного, и скрытого
// врача — второе нужно, чтобы доказать, что /media/doctor/<id> его не отдаёт.
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'easymed-security-storage-'));
process.on('exit', () => { try { fs.rmSync(STORAGE, { recursive: true, force: true }); } catch {} });
function putPhoto(db, id) {
  const dir = path.join(STORAGE, 'doctor-photos', 'doctors', String(id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'face.jpg'), Buffer.from('jpg-' + id));
  db.prepare('UPDATE users SET photo_url = ? WHERE id = ?').run('/api/storage/doctor-photos/doctors/' + id + '/face.jpg', id);
}
// Каждый запуск сайта в этом файле — с этим хранилищем.
const startSecure = () => startSite(seedSecurity, { storageDir: STORAGE });

// Скрытые в профиле врач и услуга (seedSite): id для проверок 404 по прямым ссылкам.
let HIDDEN = {};

function seedSecurity(db) {
  const info = seedSite(db);
  HIDDEN = { doctor: info.d2, service: info.s2 };
  db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов Секретов', '+998 90 555 44 33')").run();
  db.prepare(`UPDATE users SET phone='+998 91 777 66 55', email='doc1-secret@clinic.uz',
              salary_fixed=9999999, password_hash='SECRETHASH-XYZ' WHERE username='doc1'`).run();
  // W4-3 — фото врача (изначально пустое в seedSite) нужно для проверки
  // performance-атрибутов <img> на списке/карточке врача (ниже, тест
  // «изображения…»): без photo_path doctorCard()/renderDoctor() рисуют
  // doctorAvatar() вместо <img>, и проверять было бы нечего.
  putPhoto(db, info.d1);
  putPhoto(db, info.d2);
  // W4-3 — опубликованная новость с обложкой на всех языках: попадает и в
  // свип FORBIDDEN (ENTITY_PAGES ниже), и в performance-проверку <img>.
  db.prepare(`INSERT INTO website_posts (published, slug, cover_path, content, published_at)
              VALUES (1, ?, 'news/test-post.jpg',
                '{"uz":{"title":"Yangi boʻlim","excerpt":"Qisqacha."},
                  "ru":{"title":"Новый корпус","excerpt":"Кратко."},
                  "en":{"title":"New wing","excerpt":"Short."}}',
                strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run(NEWS_SLUG);
  const row = db.prepare('SELECT settings FROM website_settings WHERE id=1').get();
  const settings = JSON.parse(row.settings || '{}');
  settings.seo = { ...(settings.seo || {}), base_url: 'https://example-clinic.test' };
  db.prepare('UPDATE website_settings SET settings = ? WHERE id=1').run(JSON.stringify(settings));
  db.prepare("UPDATE users SET full_name='Козлов Приватный' WHERE username='doc1'").run();
  invalidateContentCache();
  return info;
}

const FORBIDDEN = [
  'SECRETHASH-XYZ',
  '+998 91 777 66 55',
  '998917776655', // тот же телефон, только цифрами
  'doc1-secret@clinic.uz',
  '9999999',
  'Иванов Секретов',
  'emsid',
  'P-26-', // префикс автогенерируемого MRN
  'Козлов Приватный', // users.full_name НЕ должно читаться страницей врача
  // Easy-Med — скрытые в профиле врач (is_public=0) и услуга (online_booking=0)
  // не появляются нигде: ни на страницах, ни в селектах записи, ни в sitemap.
  'Скрытый Врач',
  'Секретная услуга',
  'Maxfiy xizmat',
];

// Тот же набор путей, что регистрирует langRouter() в app.js (минус слаги —
// они подставляются отдельно), плюс '/' — главная данного языка.
// W4-3 — '/news' и '/news/<slug>' добавлены в общий свип: раньше новости
// (задача W4) не проверялись на утечку приватных данных вовсе.
// Easy-Med — слаги врача и услуги теперь «<id>-<латиница>»: список
// получает их из засеянной базы (seededSlugs).
const ENTITY_PAGES = (s) => [
  '/', '/doctors', '/doctors/' + s.doctor, '/services', '/services/' + s.service,
  '/departments', '/departments/kardiologiya', '/about', '/contact', '/faq',
  '/appointment', '/appointment/thanks', '/privacy', '/terms',
  '/news', `/news/${NEWS_SLUG}`,
];

function assertClean(body, label) {
  for (const s of FORBIDDEN) {
    assert.ok(!body.includes(s), `${label}: содержит запрещённую строку "${s}"`);
  }
}

function assertCsp(res, label) {
  assert.match(res.headers.get('content-security-policy') || '', /default-src/, `${label}: нет CSP-заголовка`);
}

function assertViewport(body, label) {
  assert.match(body, /<meta name="viewport" content="width=device-width, initial-scale=1">/,
    `${label}: нет мобильного viewport meta`);
}

function isHtml(res) {
  return /text\/html/.test(res.headers.get('content-type') || '');
}

// Сырой HTTP-запрос с path "как есть": в отличие от fetch()/WHATWG URL, узел
// http-модуля НЕ схлопывает сегменты "." и ".." на клиенте до отправки — так
// можно убедиться, что от traversal защищает именно сервер (express.static),
// а не нормализация URL в клиенте раньше него.
function rawGet(base, rawPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ hostname: u.hostname, port: u.port, path: rawPath, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('приватные данные ЕРП не просачиваются ни на одну публичную страницу (все языки)', async () => {
  const { server, base, db } = await startSecure();
  invalidateContentCache();
  const slugs = seededSlugs(db);
  try {
    for (const lang of LANGS) {
      for (const p of ENTITY_PAGES(slugs)) {
        const label = `${lang}${p}`;
        const res = await fetch(base + `/${lang}` + p, { redirect: 'manual' });
        const body = await res.text();
        assert.equal(res.status, 200, `${label}: ожидался 200`);
        assertCsp(res, label);
        assertClean(body, label);
        if (isHtml(res)) assertViewport(body, label);
      }
      // неизвестная страница — фирменная HTML-404 своего языка, тоже через page()
      const notFound = await fetch(base + `/${lang}/no-such-page-xyz`);
      const nfBody = await notFound.text();
      assert.equal(notFound.status, 404);
      assertCsp(notFound, `${lang} 404`);
      assertClean(nfBody, `${lang} 404`);
      assertViewport(nfBody, `${lang} 404`);
    }

    // «Алиев Шерзод» — публичное имя врача из профиля (full_name_ru) —
    // ОБЯЗАНО остаться видимым и на карточке, и на списке: это доказательство,
    // что страница читает профиль, а не users.full_name (теперь 'Козлов
    // Приватный', см. seedSecurity выше и общую проверку FORBIDDEN).
    const ruDoctorCard = await (await fetch(base + '/ru/doctors/' + slugs.doctor)).text();
    assert.match(ruDoctorCard, /Алиев Шерзод/);
    const ruDoctorsList = await (await fetch(base + '/ru/doctors')).text();
    assert.match(ruDoctorsList, /Алиев Шерзод/);

    // --- Общие (без языкового префикса) поверхности ---
    const root = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(root.status, 302);
    assertCsp(root, '/');
    assertClean(await root.text(), '/');

    const sitemap = await fetch(base + '/sitemap.xml');
    const sitemapBody = await sitemap.text();
    assertCsp(sitemap, 'sitemap.xml');
    assertClean(sitemapBody, 'sitemap.xml');
    assert.match(sitemapBody, /example-clinic\.test/, 'при заданном seo.base_url sitemap не должен быть пуст');
    assert.ok(sitemapBody.includes('/doctors/' + slugs.doctor), 'показанный врач в sitemap есть');
    assert.ok(!new RegExp('/doctors/' + HIDDEN.doctor + '(-|<)').test(sitemapBody), 'скрытого в профиле врача в sitemap нет');
    assert.ok(!new RegExp('/services/' + HIDDEN.service + '(-|<)').test(sitemapBody), 'услуги с online_booking=0 в sitemap нет');

    const robots = await fetch(base + '/robots.txt');
    const robotsBody = await robots.text();
    assertCsp(robots, 'robots.txt');
    assertClean(robotsBody, 'robots.txt');

    const media = await fetch(base + '/media/no-such-file.png');
    const mediaBody = await media.text();
    assert.equal(media.status, 404);
    assertCsp(media, '/media/no-such-file.png');
    assertClean(mediaBody, '/media/no-such-file.png');
    if (isHtml(media)) assertViewport(mediaBody, '/media/no-such-file.png');

    // POST /api/requests: ответ на ошибку валидации — тоже публичная
    // поверхность (JSON), ничего приватного возвращать не должен.
    const badReq = await fetch(base + '/api/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'contact', full_name: '', phone: '' }),
    });
    assert.equal(badReq.status, 400);
    assertClean(await badReq.text(), 'POST /api/requests (ошибка валидации)');
  } finally { server.close(); }
});

test('POST /api/requests: тело 40кб — 4xx JSON-конверт (граница периметра)', async () => {
  const { server, base } = await startSecure();
  invalidateContentCache();
  try {
    const res = await fetch(base + '/api/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'appointment', full_name: 'Test Bemor', phone: '+998 90 961 00 04',
        message: 'x'.repeat(40_000), lang: 'uz', website: '', ts: Date.now() - 10_000,
      }),
    });
    assert.ok(res.status >= 400 && res.status < 500, 'тело больше 32kb — это 4xx, не 500');
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const json = await res.json();
    assert.ok(json.error && json.error.code && json.error.message);
    assertClean(JSON.stringify(json), 'POST /api/requests (40kb)');
  } finally { server.close(); }
});

test('/assets: express.static не отдаёт файлы вне public/site (обход пути)', async () => {
  const { server, base } = await startSecure();
  invalidateContentCache();
  try {
    // Сырой запрос с буквальными ".." — обходит нормализацию URL на клиенте,
    // проверяет именно серверную защиту express.static/send.
    const raw = await rawGet(base, '/assets/../../server/index.js');
    assert.ok(raw.status === 404 || raw.status === 403,
      `literal .. должно быть отклонено сервером, получили ${raw.status}`);
    assert.ok(!raw.body.includes('createSiteApp'), 'исходник сервера не должен утечь через /assets');

    // Тот же вектор, но со слэшем в процентной кодировке — переживает и
    // клиентскую, и наивную серверную нормализацию по буквальному "/".
    const encoded = await fetch(base + '/assets/..%2F..%2Fserver%2Findex.js', { redirect: 'manual' });
    assert.ok(encoded.status === 404 || encoded.status === 403,
      `закодированный слэш в traversal должен быть отклонён, получили ${encoded.status}`);
    assert.ok(!(await encoded.text()).includes('createSiteApp'), 'исходник сервера не должен утечь через /assets');
  } finally { server.close(); }
});

test('поверхности ЕРП остаются 404 на публичном сайте (граница периметра)', async () => {
  const { server, base } = await startSecure();
  invalidateContentCache();
  try {
    for (const p of ['/admin.html', '/api/db', '/api/rpc/x', '/api/auth/login']) {
      const res = await fetch(base + p, { redirect: 'manual' });
      assert.equal(res.status, 404, `${p} должен быть 404 на публичном сайте`);
    }
  } finally { server.close(); }
});

// W4 задача 3 — сырой POST через node:http: в отличие от fetch(), Headers.get()
// на повторяющемся заголовке (несколько Set-Cookie в одном ответе — здесь их
// ровно два, wsid и wvid) отдаёт их СКЛЕЕННЫМИ в одну строку через ", " —
// удобно для regex-проверки значения, но непригодно для проверки, что
// HttpOnly стоит У КАЖДОЙ из двух кук по отдельности, а не только у одной.
// Модуль node:http, наоборот, кладёт повторяющийся заголовок как МАССИВ
// строк — то, что нужно здесь.
function rawHttp(base, { method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const reqHeaders = { ...headers };
    if (data !== undefined) reqHeaders['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ hostname: u.hostname, port: u.port, path: p, method, headers: reqHeaders }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

// W4 задача 3 — правило W3-R3 («маячок никогда не мешает сайту») уже покрыто
// пофункционально в analytics.test.js (мусорное тело, бот, 61-й запрос —
// везде 204). Здесь — периметровый срез той же гарантии ПЛЮС то, чего в
// analytics.test.js нет вовсе: (а) тело ответа никогда не эхо содержимого
// запроса (канарейка в path/ref/lang), (б) обе куки аналитики выставлены с
// HttpOnly — без него значение куки можно было бы прочитать через XSS
// (document.cookie) и использовать как отпечаток сессии посетителя.
test('POST /api/beacon: 204-контракт на периметре, тело ответа не эхо запроса, куки — HttpOnly', async () => {
  const { server, base } = await startSecure();
  invalidateContentCache();
  try {
    // (1) 204-контракт: мусорное тело, бот, штатный запрос, слишком длинный
    // JSON (>8kb — превышает express.json({limit:'8kb'}) на этом маршруте) —
    // ни один случай не имеет права дать что-то, кроме 204.
    const garbage = await fetch(base + '/api/beacon', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not-json',
    });
    assert.equal(garbage.status, 204, 'мусорное тело — 204, не 500');
    assert.equal(await garbage.text(), '', 'тело ответа пустое');

    const bot = await fetch(base + '/api/beacon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Googlebot/2.1' },
      body: JSON.stringify({ path: '/ru/', page_type: 'home', ref: '', lang: 'ru' }),
    });
    assert.equal(bot.status, 204, 'бот — 204, не 500');

    const oversized = await fetch(base + '/api/beacon', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/ru/', page_type: 'home', ref: '', lang: 'ru', junk: 'x'.repeat(9000) }),
    });
    assert.equal(oversized.status, 204, 'тело больше лимита 8kb — тоже 204, не 500 и не 413');

    // (2) 60/минуту — лимит; 61-й запрос с того же IP тоже обязан остаться
    // 204 (beaconLimiter закрывает ответ сам, до всякого парсинга/записи).
    for (let i = 0; i < 60; i++) {
      const res = await fetch(base + '/api/beacon', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `/ru/?n=${i}`, page_type: 'home', ref: '', lang: 'ru' }),
      });
      assert.equal(res.status, 204, `запрос ${i + 1}/60 в пределах лимита — 204`);
    }
    const over = await fetch(base + '/api/beacon', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/ru/', page_type: 'home', ref: '', lang: 'ru' }),
    });
    assert.equal(over.status, 204, '61-й запрос за минуту — 204, не 429');

    // (3) Тело ответа НИКОГДА не эхо запроса: канарейка кладётся в path/ref/
    // lang (все три поля, которые recordBeacon() читает из тела) — правило
    // W3-R3 требует res.status(204).end() без тела вообще, так что искать
    // канарейку в теле ответа странно, но именно это и доказывает контракт:
    // если бы кто-то однажды добавил res.json({...}) с диагностикой, канарейка
    // всплыла бы здесь.
    const canary = 'BEACON_ECHO_CANARY_9f3a';
    const echoCheck = await fetch(base + '/api/beacon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: `https://${canary}.test/` },
      body: JSON.stringify({ path: `/ru/?x=${canary}`, page_type: 'home', ref: `https://${canary}.test/`, lang: canary }),
    });
    assert.equal(echoCheck.status, 204);
    const echoBody = await echoCheck.text();
    assert.equal(echoBody, '', 'тело ответа маячка всегда пустое');
    assert.ok(!echoBody.includes(canary), 'канарейка из запроса не должна попасть в тело ответа');

    // (4) Обе куки аналитики — HttpOnly. Свежий IP/сервер (новый startSite),
    // чтобы не упереться в лимит 60/мин, исчерпанный пунктом (2) выше.
  } finally { server.close(); }
});

test('POST /api/beacon: обе куки (wsid, wvid) выставлены с HttpOnly', async () => {
  const { server, base } = await startSecure();
  invalidateContentCache();
  try {
    const res = await rawHttp(base, {
      method: 'POST', path: '/api/beacon', headers: { 'Content-Type': 'application/json' },
      body: { path: '/ru/', page_type: 'home', ref: '', lang: 'ru' },
    });
    assert.equal(res.status, 204);
    const setCookie = res.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie), 'ожидались два отдельных заголовка Set-Cookie');
    assert.equal(setCookie.length, 2, 'ровно две куки: wsid и wvid');
    const wsid = setCookie.find((c) => c.startsWith('wsid='));
    const wvid = setCookie.find((c) => c.startsWith('wvid='));
    assert.ok(wsid && /HttpOnly/i.test(wsid), `wsid должен быть HttpOnly: ${wsid}`);
    assert.ok(wvid && /HttpOnly/i.test(wvid), `wvid должен быть HttpOnly: ${wvid}`);
  } finally { server.close(); }
});

// W4-R3 (layout.js) — снипет аналитики (Google Analytics/Яндекс.Метрика)
// вставляется ТОЛЬКО когда администратор явно задал settings.analytics.
// inject_snippet (см. layout.test.js — юнит-проверка обоих направлений).
// Здесь — периметровая гарантия на полном фикстурном сайте (seedSecurity НЕ
// задаёт этот раздел настроек вовсе): ни один типичный маркер стороннего
// счётчика не должен появляться на публичной странице сам по себе.
test('снипет аналитики (GA/Метрика) отсутствует по умолчанию — settings.analytics не задан', async () => {
  const { server, base } = await startSecure();
  invalidateContentCache();
  try {
    for (const lang of LANGS) {
      const html = await (await fetch(base + `/${lang}/`)).text();
      assert.ok(!/googletagmanager\.com|gtag\(|google-analytics\.com|mc\.yandex\.ru|ym\(\d/.test(html),
        `${lang}: посторонний снипет аналитики не должен рендериться, пока settings.analytics.inject_snippet не задан`);
    }
  } finally { server.close(); }
});

// W4 задача 3 — сводный аудит Cache-Control по всей публичной поверхности:
// CSS/JS отдаются с no-cache (правки сайта должны быть видны сразу, без
// ручного сброса кэша браузера), шрифты — с долгим max-age (не меняются
// между релизами), картинки /media — ровно 'public, max-age=86400' (задача
// 12, уже проверено отдельно в media.test.js — здесь для полноты общего
// среза), а HTML-страницы вообще не должны нести 'private' — это ломает
// кэширование на обратных прокси перед сайтом.
test('Cache-Control: статика/медиа/HTML — правильная политика на каждом классе ресурсов', async () => {
  const { server, base } = await startSecure();
  try {
    const css = await fetch(base + '/assets/site.css');
    assert.equal(css.headers.get('cache-control'), 'no-cache', 'CSS — no-cache, чтобы правки были видны сразу');

    const js = await fetch(base + '/assets/site.js');
    assert.equal(js.headers.get('cache-control'), 'no-cache', 'JS — no-cache по той же причине');

    const font = await fetch(base + '/assets/fonts/manrope-cyrillic-ext.woff2');
    assert.equal(font.status, 200);
    const fontCache = font.headers.get('cache-control') || '';
    assert.ok(!/no-cache/.test(fontCache), 'шрифт не должен получить no-cache');
    const m = /max-age=(\d+)/.exec(fontCache);
    assert.ok(m && Number(m[1]) >= 86400, `шрифт должен кэшироваться надолго: ${fontCache}`);

    const home = await fetch(base + '/ru/');
    const homeCache = home.headers.get('cache-control');
    assert.ok(!homeCache || !homeCache.includes('private'),
      `HTML-страница не должна нести 'private' (ломает кэш на обратном прокси): ${homeCache}`);
  } finally { server.close(); }
});

test('Cache-Control: /media/<картинка> — public, max-age=86400', async () => {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easymed-security-media-'));
  fs.writeFileSync(path.join(mediaDir, 'photo.jpg'), Buffer.from('fake-jpg-bytes'));
  const { server, base } = await startSite(null, { mediaDir });
  try {
    const res = await fetch(base + '/media/photo.jpg');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  } finally {
    server.close();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

// W4 задача 3 — производительность, закодированная в тесте: КАЖДЫЙ <img> на
// списках/карточках врачей и новостей обязан нести и width/height (иначе
// браузер не может зарезервировать место под картинку до её загрузки — это
// и есть layout shift, CLS), и loading="lazy" (обе точки — ниже первого
// экрана: карточки в сетке и обложка статьи/врача, которые не обязаны грузиться
// раньше самого текста). helpers.js/doctors.js/news.js уже расставляют оба
// атрибута — это регрессионный якорь, а не разовая правка.
function imgTags(html) {
  return html.match(/<img\b[^>]*>/g) || [];
}

test('производительность: <img> у врачей/новостей — width+height+loading=lazy на каждом', async () => {
  const { server, base, db } = await startSecure();
  invalidateContentCache();
  try {
    const pages = [
      '/ru/doctors', '/ru/doctors/' + seededSlugs(db).doctor, '/ru/news', `/ru/news/${NEWS_SLUG}`,
    ];
    for (const p of pages) {
      const html = await (await fetch(base + p)).text();
      // LOGO_NOT_LAZY_V1 — правило про КОНТЕНТНЫЕ картинки: фото врачей и
      // обложки новостей лежат ниже сгиба, и лениться им полезно.
      //
      // Логотип в шапке — не контент, а обвязка: он виден сразу на каждой
      // странице, и loading="lazy" на нём задерживает самую заметную отрисовку
      // вместо того, чтобы её ускорить. Требовать от него ленивости — значит
      // требовать вреда, поэтому он исключён явно, а не «подогнан» под правило.
      const imgs = imgTags(html).filter((img) => !/class="[^"]*\bbrand__mark\b/.test(img));
      assert.ok(imgs.length > 0, `${p}: ожидалась хотя бы одна <img> (фото/обложка засеяны в seedSecurity)`);
      for (const img of imgs) {
        assert.match(img, /\bwidth="\d+"/, `${p}: <img> без width — ${img}`);
        assert.match(img, /\bheight="\d+"/, `${p}: <img> без height — ${img}`);
        assert.match(img, /\bloading="lazy"/, `${p}: <img> без loading="lazy" — ${img}`);
      }
    }
  } finally { server.close(); }
});

test('производительность: site.js подключён с defer', async () => {
  const { server, base } = await startSecure();
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/')).text();
    assert.match(html, /<script src="\/assets\/site\.js" defer><\/script>/,
      'site.js должен быть defer — не должен блокировать парсинг HTML');
  } finally { server.close(); }
});

// Easy-Med — показ врача и услуги решает ПРОФИЛЬ (тот же, что у Symptex и
// партнёров). Скрытый врач (is_public=0) и услуга с online_booking=0 не
// находятся ни по слагу, ни по голому id, ни через /media/doctor/<id>, хотя
// фото скрытого врача лежит на диске. Показанный — находится (контроль, что
// 404 здесь не от сломанной раздачи).
test('скрытые в профиле врач и услуга: 404 по прямым ссылкам, фото скрытого врача не отдаётся', async () => {
  const { server, base, db } = await startSecure();
  invalidateContentCache();
  try {
    const slugs = seededSlugs(db);
    assert.equal((await fetch(base + '/media/doctor/' + slugs.d1)).status, 200, 'фото показанного врача отдаётся');
    assert.equal((await fetch(base + '/media/doctor/' + HIDDEN.doctor)).status, 404, 'фото скрытого врача не отдаётся');
    for (const lang of LANGS) {
      assert.equal((await fetch(base + `/${lang}/doctors/${HIDDEN.doctor}`)).status, 404, `${lang}: скрытый врач по id`);
      assert.equal((await fetch(base + `/${lang}/doctors/${HIDDEN.doctor}-skrytyy-vrach`)).status, 404, `${lang}: скрытый врач по слагу`);
      assert.equal((await fetch(base + `/${lang}/services/${HIDDEN.service}`)).status, 404, `${lang}: скрытая услуга по id`);
      assert.equal((await fetch(base + `/${lang}/services/${HIDDEN.service}-maxfiy-xizmat`)).status, 404, `${lang}: скрытая услуга по слагу`);
      // Страница записи с подставленными скрытыми — без их имён (FORBIDDEN).
      const appt = await (await fetch(base + `/${lang}/appointment?doctor=${HIDDEN.doctor}&service=${HIDDEN.service}`)).text();
      assertClean(appt, `${lang}/appointment?doctor=скрытый`);
      for (const p of ['/', '/doctors', '/services', '/departments/kardiologiya', '/appointment']) {
        const html = await (await fetch(base + `/${lang}${p}`)).text();
        assert.ok(!html.includes(`/doctors/${HIDDEN.doctor}-`) && !html.includes(`/doctors/${HIDDEN.doctor}"`), `${lang}${p}: ссылки на скрытого врача нет`);
        assert.ok(!html.includes(`/media/doctor/${HIDDEN.doctor}"`), `${lang}${p}: фото скрытого врача не подключено`);
        assert.ok(!html.includes(`/services/${HIDDEN.service}-`) && !html.includes(`/services/${HIDDEN.service}"`), `${lang}${p}: ссылки на скрытую услугу нет`);
      }
    }
  } finally { server.close(); }
});
