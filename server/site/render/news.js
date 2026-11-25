// WEBSITE_V1 (W4) — новости/блог: лента и карточка публикации. Тот же
// каркас, что и у doctors.js — page()/esc(), Article JSON-LD инлайнится
// прямо здесь, как Physician в doctors.js (общего билдера в seo.js для
// одиночных сущностей нет, там только orgJsonLd/faqJsonLd — для главной и
// списка вопросов-ответов, у которых ровно один экземпляр на сайт).
//
// ЭКРАНИРОВАНИЕ: page() вставляет body КАК ЕСТЬ (см. заголовок layout.js) —
// каждое значение из БД здесь обязано пройти через esc().
import { page, esc } from './layout.js';
import { t, pickContent } from '../i18n.js';
import { getSettings, publishedPosts, postBySlug } from '../content.js';
import { mediaUrl } from './helpers.js';
import { absUrl } from '../seo.js';

// published_at — строка вида 'YYYY-MM-DDTHH:MM:SSZ' (strftime в RPC); формат
// вывода один на все три языка (см. бриф задачи) — DD.MM.YYYY.
function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

// Тот же приём разбиения на абзацы, что и в static-pages.js (paragraphs) —
// копия намеренная: отдельная задача/файл, static-pages.js трогать незачем.
function paragraphs(text) {
  return String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`).join('');
}

function postCard(lang, p) {
  const c = pickContent(p.content, lang);
  if (!c.title) return '';
  const cover = mediaUrl(p.cover_path);
  const media = cover
    // 480x270 = 16:9, matching .news-card__cover's aspect-ratio in site.css —
    // intrinsic attributes must agree with the CSS box or the reserved space
    // (the whole point of width/height, avoiding layout shift) is wrong.
    ? `<img src="${esc(cover)}" alt="${esc(c.title)}" loading="lazy" width="480" height="270">`
    : '';
  const dateStr = formatDate(p.published_at);
  return `<a class="news-card" href="/${lang}/news/${esc(encodeURIComponent(p.slug))}">
${media ? `<div class="news-card__cover">${media}</div>` : ''}
<div class="news-card__body">
${dateStr ? `<span class="news-card__date">${esc(dateStr)}</span>` : ''}
<h3 class="news-card__title">${esc(c.title)}</h3>
${c.excerpt ? `<p class="news-card__excerpt">${esc(c.excerpt)}</p>` : ''}
</div>
</a>`;
}

export function renderNews(db, lang) {
  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const posts = publishedPosts(db);
  const cards = posts.map((p) => postCard(lang, p)).filter(Boolean).join('');
  const body = `<section class="section news-list">
<div class="container">
<div class="section-head"><h1>${esc(t(lang, 'nav.news'))}</h1></div>
${cards ? `<div class="grid-3">${cards}</div>` : `<p class="muted">${esc(t(lang, 'empty.news'))}</p>`}
</div>
</section>`;
  const title = `${t(lang, 'nav.news')} — ${clinicName}`;
  const description = `${clinicName} — ${t(lang, 'nav.news')}.`;
  return page({ db, lang, path: `/${lang}/news`, title, description, body, pageType: 'news' });
}

// null → страница не найдена (нет такого слага, не опубликована, или на
// выбранном/фолбэк-языке вообще нет заголовка) — вызывающий код (app.js)
// отвечает фирменной страницей 404, тот же приём, что у doctorBySlug.
export function renderPost(db, lang, slug) {
  const p = postBySlug(db, slug);
  if (!p) return null;
  const c = pickContent(p.content, lang);
  if (!c.title) return null;

  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const baseUrl = typeof settings.seo?.base_url === 'string' ? settings.seo.base_url.trim() : '';

  const cover = mediaUrl(p.cover_path);
  const dateStr = formatDate(p.published_at);
  const media = cover
    ? `<img src="${esc(cover)}" alt="${esc(c.title)}" loading="lazy" width="960" height="540">`
    : '';

  const body = `<article class="section news-post">
<div class="container news-post__inner">
${media ? `<div class="news-post__cover">${media}</div>` : ''}
<h1 class="news-post__title">${esc(c.title)}</h1>
${dateStr ? `<div class="news-post__date">${esc(dateStr)}</div>` : ''}
<div class="news-post__body">${paragraphs(c.body)}</div>
</div>
</article>`;

  // Article JSON-LD — headline/datePublished обязательны, image — только
  // когда обложка есть; JSON.stringify() сам выбрасывает ключи со значением
  // undefined, поэтому datePublished можно не проверять отдельно (published_at
  // у ОПУБЛИКОВАННОГО поста всегда заполнен — см. websiteContentPublish).
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: c.title,
    datePublished: p.published_at || undefined,
  };
  if (cover) jsonLd.image = absUrl(baseUrl, cover);

  const title = `${c.title} — ${clinicName}`;
  const description = c.excerpt ? c.excerpt : `${c.title} — ${clinicName}.`;

  // pageType 'post' (не 'news' — та у списка) — тот же приём, что у
  // doctors/doctor: список и карточку аналитика должна различать
  // (server/site/analytics.js — 'post' в белом списке PAGE_TYPES).
  return page({
    db, lang, path: `/${lang}/news/${encodeURIComponent(p.slug)}`,
    title, description, body, jsonLd, pageType: 'post',
  });
}
