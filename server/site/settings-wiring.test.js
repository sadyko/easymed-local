// W2 — «финальная волна»: раньше settings.default_lang/langs/seo.title
// писались админкой, но сайт их вообще не читал (жёстко висел на uz/всех
// трёх языках/clinic_name). Этот файл проверяет, что все три поля реально
// влияют на ответ сайта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSite } from './app.test.js';
import { seedSite } from './test-seed.js';
import { invalidateContentCache } from './content.js';

// Тот же приём, что и setBaseUrl() в seo.test.js: читаем settings, подмешиваем
// нужные поля в JS, сохраняем обратно ЦЕЛИКОМ (так же, как это делает
// вьюха website-settings.js — см. website-admin-flow.test.js).
function setSettings(db, patch) {
  const row = db.prepare('SELECT settings FROM website_settings WHERE id=1').get();
  const settings = JSON.parse(row?.settings || '{}');
  Object.assign(settings, patch);
  db.prepare('UPDATE website_settings SET settings = ? WHERE id=1').run(JSON.stringify(settings));
  invalidateContentCache();
}

test('default_lang: "/" редиректит на язык из настроек, а не всегда на /uz/', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  setSettings(db, {
    default_lang: 'ru',
    langs: ['ru', 'en'],
    seo: { base_url: 'https://example.uz', title: { ru: 'Клиника Тест' } },
  });
  try {
    const res = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/ru/');
  } finally { server.close(); }
});

test('langs: отключённый язык 302-редиректит на эквивалент в языке по умолчанию', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  setSettings(db, {
    default_lang: 'ru',
    langs: ['ru', 'en'],
    seo: { base_url: 'https://example.uz', title: { ru: 'Клиника Тест' } },
  });
  try {
    const res = await fetch(base + '/uz/', { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/ru/', 'uz отключён — /uz/ уводит на /ru/');

    const res2 = await fetch(base + '/uz/doctors', { redirect: 'manual' });
    assert.equal(res2.status, 302);
    assert.equal(res2.headers.get('location'), '/ru/doctors', 'редирект сохраняет остаток пути');
  } finally { server.close(); }
});

test('seo.title: подставляется в <title> вместо clinic_name', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  setSettings(db, {
    default_lang: 'ru',
    langs: ['ru', 'en'],
    seo: { base_url: 'https://example.uz', title: { ru: 'Клиника Тест' } },
  });
  try {
    const res = await fetch(base + '/ru/');
    assert.equal(res.status, 200);
    const html = await res.text();
    const titleMatch = /<title>([^<]*)<\/title>/.exec(html);
    assert.ok(titleMatch, 'у страницы есть <title>');
    assert.match(titleMatch[1], /Клиника Тест/);
  } finally { server.close(); }
});

test('langs: переключатель языков и hreflang не содержат отключённый язык', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  setSettings(db, {
    default_lang: 'ru',
    langs: ['ru', 'en'],
    seo: { base_url: 'https://example.uz', title: { ru: 'Клиника Тест' } },
  });
  try {
    const res = await fetch(base + '/ru/');
    const html = await res.text();
    assert.ok(!html.includes('hreflang="uz"'), 'отключённый uz не должен встречаться в hreflang/переключателе');
    assert.match(html, /hreflang="ru"/);
    assert.match(html, /hreflang="en"/);
    assert.match(html, /hreflang="x-default"/);
  } finally { server.close(); }
});

test('langs: sitemap.xml не содержит записей для отключённого языка', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  setSettings(db, {
    default_lang: 'ru',
    langs: ['ru', 'en'],
    seo: { base_url: 'https://example.uz', title: { ru: 'Клиника Тест' } },
  });
  try {
    const res = await fetch(base + '/sitemap.xml');
    const xml = await res.text();
    assert.ok(!xml.includes('/uz/'), 'sitemap не должен содержать /uz/ при отключённом uz');
    assert.match(xml, /<loc>https:\/\/example\.uz\/ru\/<\/loc>/);
  } finally { server.close(); }
});

// Fix-wave 2 — {default_lang:'uz', langs:['ru','en']} писался бы через
// прямой UPDATE в обход RPC-валидатора (та же гонка вкладок админки, что
// делает website_settings_save недостаточным сам по себе — см.
// website-admin-flow.test.js и website.test.js на стороне RPC). Без
// defaultLangFromSettings-фолбэка на первый ВКЛЮЧЁННЫЙ язык это давало
// бесконечный редирект: GET / -> /uz/ -> langRouter видит uz отключённым ->
// redirect на defaultLang(db) -> снова uz -> снова /uz/.
test('default_lang вне langs (в обход RPC-валидации): нет цикла редиректов, откат на первый включённый язык', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  setSettings(db, {
    default_lang: 'uz',
    langs: ['ru', 'en'],
    seo: { base_url: 'https://example.uz' },
  });
  try {
    const res = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/ru/', 'default_lang сам отключён — откат на первый enabled язык');

    const res2 = await fetch(base + '/uz/x', { redirect: 'manual' });
    assert.equal(res2.status, 302);
    assert.equal(res2.headers.get('location'), '/ru/x', 'нет цикла: один редирект уводит на рабочий путь');
  } finally { server.close(); }
});
