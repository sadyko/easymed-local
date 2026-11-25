// WEBSITE_V1 — sitemap.xml, robots.txt, org/FAQ JSON-LD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSite } from './app.test.js';
import { seedSite, seededSlugs } from '../test-helpers/site-seed.js';
import { invalidateContentCache } from './content.js';

// Задаёт seo.base_url поверх фикстуры seedSite: читает текущие settings,
// подмешивает seo.base_url в JS (не через json_set в SQL — так проще
// проверить глазами, что получилось валидное значение), сохраняет обратно.
function setBaseUrl(db, baseUrl) {
  const row = db.prepare('SELECT settings FROM website_settings WHERE id=1').get();
  const settings = JSON.parse(row?.settings || '{}');
  settings.seo = { ...(settings.seo || {}), base_url: baseUrl };
  db.prepare('UPDATE website_settings SET settings = ? WHERE id=1').run(JSON.stringify(settings));
  invalidateContentCache();
}

test('sitemap.xml: без base_url — валидный, но пустой urlset', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/sitemap.xml');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/xml/);
    const xml = await res.text();
    assert.match(xml, /<urlset/);
    assert.ok(!xml.includes('<loc>'), 'без домена sitemap не должен содержать <loc>');
  } finally { server.close(); }
});

test('sitemap.xml: с base_url — абсолютные <loc> для опубликованных сущностей', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  setBaseUrl(db, 'https://example.uz');
  try {
    const res = await fetch(base + '/sitemap.xml');
    const xml = await res.text();
    assert.match(xml, /<loc>https:\/\/example\.uz\/ru\/doctors\/\d+-aliyev-sherzod<\/loc>/);
    assert.match(xml, /<loc>https:\/\/example\.uz\/uz\/<\/loc>/);
    // Fix 4 (W4, launch-gate review) — без опубликованных новостей список
    // /news в sitemap не попадает вовсе (тот же принцип W4-R2, что прячет
    // пункт «Новости» из меню, см. layout.js/navItems()): seedSite() новостей
    // не создаёт, поэтому /news здесь быть не должно.
    assert.ok(!xml.includes('/ru/news<'), 'без опубликованных новостей /news не должен попадать в sitemap');

    // Easy-Med: врача снимают в профиле (is_public), своей публикации у сайта нет
    const slug = seededSlugs(db).doctor;
    db.prepare("UPDATE users SET is_public = 0 WHERE username = 'doc1'").run();
    invalidateContentCache();
    const res2 = await fetch(base + '/sitemap.xml');
    const xml2 = await res2.text();
    assert.ok(!xml2.includes('/doctors/' + slug), 'снятый с публикации врач исчезает из sitemap');
  } finally { server.close(); }
});

test('sitemap.xml: опубликованная новость попадает в <loc>, снятая с публикации — нет', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  setBaseUrl(db, 'https://example.uz');
  try {
    db.prepare(`INSERT INTO website_posts (published, slug, content, published_at)
                VALUES (1, 'otkrytie-otdeleniya', '{"ru":{"title":"Открытие отделения"}}', '2026-01-01T00:00:00Z')`).run();
    invalidateContentCache();

    const res = await fetch(base + '/sitemap.xml');
    const xml = await res.text();
    assert.match(xml, /<loc>https:\/\/example\.uz\/ru\/news\/otkrytie-otdeleniya<\/loc>/);
    assert.match(xml, /<loc>https:\/\/example\.uz\/ru\/news<\/loc>/);

    db.prepare(`UPDATE website_posts SET published = 0`).run();
    invalidateContentCache();
    const res2 = await fetch(base + '/sitemap.xml');
    const xml2 = await res2.text();
    assert.ok(!xml2.includes('/news/otkrytie-otdeleniya'), 'снятая с публикации новость исчезает из sitemap');
    // Fix 4 — с последней новостью, снятой с публикации, список /news тоже
    // должен исчезнуть из sitemap (не только карточка самой новости).
    assert.ok(!xml2.includes('/ru/news<'), 'без опубликованных новостей список /news тоже исчезает из sitemap');
  } finally { server.close(); }
});

test('robots.txt: разрешает всё, кроме /api/, ссылается на sitemap когда есть домен', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/robots.txt');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/plain/);
    const noDomain = await res.text();
    assert.match(noDomain, /User-agent: \*/);
    assert.match(noDomain, /Disallow: \/api\//);
    assert.ok(!noDomain.includes('Sitemap:'), 'без base_url ссылки на sitemap быть не должно');

    setBaseUrl(db, 'https://example.uz');
    const res2 = await fetch(base + '/robots.txt');
    const withDomain = await res2.text();
    assert.match(withDomain, /Sitemap: https:\/\/example\.uz\/sitemap\.xml/);
  } finally { server.close(); }
});

test('главная: MedicalOrganization JSON-LD; FAQ: FAQPage JSON-LD с текстом вопроса', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const home = await fetch(base + '/ru/');
    const homeHtml = await home.text();
    assert.match(homeHtml, /"@type":"MedicalOrganization"/);

    const faq = await fetch(base + '/ru/faq');
    const faqHtml = await faq.text();
    assert.match(faqHtml, /"@type":"FAQPage"/);
    assert.match(faqHtml, /Как записаться\?/);
  } finally { server.close(); }
});
