// WEBSITE_V1 — фирменная страница 404. Та же шапка/подвал/мобильная панель,
// что и у остальных страниц: посетитель с телефона не должен упираться в
// тупик — снизу всегда есть «позвонить» и «записаться».
import { page, esc } from './layout.js';
import { t } from '../i18n.js';

export function renderNotFound(db, lang) {
  const title = t(lang, 'notfound.title');
  const body = `<section class="section notfound">
<div class="container notfound__inner">
<div class="notfound__code" aria-hidden="true">404</div>
<h1 class="notfound__title">${esc(title)}</h1>
<p class="notfound__text">${esc(t(lang, 'notfound.text'))}</p>
<div class="notfound__actions">
<a class="btn btn-primary btn-lg" href="/${lang}/">${esc(t(lang, 'nav.home'))}</a>
<a class="btn btn-ghost btn-lg" href="/${lang}/appointment">${esc(t(lang, 'cta.book'))}</a>
</div>
</div>
</section>`;
  return page({ db, lang, path: `/${lang}/`, title, description: t(lang, 'notfound.text'), body, noindex: true, pageType: 'other' });
}
