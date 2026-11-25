// WEBSITE_V1 — SEO: общий absUrl(), JSON-LD билдеры (организация, FAQ) и
// генераторы sitemap.xml/robots.txt. Physician/MedicalProcedure JSON-LD
// остаются инлайн в doctors.js/services.js (задачи 8–9) — они уже рабочие,
// переносить их сюда незачем; здесь только то, что реально общее для
// нескольких файлов (absUrl) или не имеет другого дома (главная, FAQ,
// sitemap, robots).
import { LANGS } from './i18n.js';
import { pickContent } from './i18n.js';
import { getSettings, publishedDoctors, publishedServices, publishedDepartments, publishedPosts, enabledLangsFromSettings } from './content.js';

// Абсолютный URL появляется только когда домен уже известен (seo.base_url) —
// до этого лучше путь без хоста, чем неверный хост. Раньше эта функция была
// продублирована в layout.js/doctors.js/services.js — теперь единственный
// экземпляр здесь, остальные файлы импортируют его.
export function absUrl(baseUrl, p) {
  return baseUrl ? String(baseUrl).replace(/\/+$/, '') + p : p;
}

// Тот же терпимый пикер языковых полей настроек, что и в layout.js/home.js/
// static-pages.js (копия намеренная — см. пояснение в тех файлах).
function pickText(value, lang) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    for (const l of [lang, ...LANGS]) {
      const v = value[l];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
  }
  return '';
}

// MedicalOrganization для главной страницы — пустые поля не выводятся,
// чтобы на пустых настройках JSON-LD не врал пустыми строками.
export function orgJsonLd(db, lang) {
  const settings = getSettings(db);
  const baseUrl = typeof settings.seo?.base_url === 'string' ? settings.seo.base_url.trim() : '';
  const address = pickText(settings.contact?.address, lang);
  const jsonLd = { '@context': 'https://schema.org', '@type': 'MedicalOrganization' };
  if (settings.clinic_name) jsonLd.name = settings.clinic_name;
  if (settings.contact?.phone) jsonLd.telephone = settings.contact.phone;
  if (address) jsonLd.address = { '@type': 'PostalAddress', streetAddress: address };
  if (baseUrl) jsonLd.url = baseUrl;
  return jsonLd;
}

// FAQPage для страницы вопросов-ответов. Элементы без вопроса ИЛИ без
// ответа в JSON-LD не идут (в отличие от вёрстки страницы, где ответ может
// быть пустым) — Google требует непустой acceptedAnswer.text. Если валидных
// пар не нашлось вовсе — возвращаем null, вызывающий код тогда не печатает
// пустой <script type="application/ld+json">.
export function faqJsonLd(items, lang) {
  const mainEntity = (items || [])
    .map((f) => {
      const c = pickContent(f.content, lang);
      if (!c.q || !c.a) return null;
      return { '@type': 'Question', name: c.q, acceptedAnswer: { '@type': 'Answer', text: c.a } };
    })
    .filter(Boolean);
  if (!mainEntity.length) return null;
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity };
}

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

// Список постоянных (не-сущностных) страниц каждого языка — тот же набор,
// что регистрирует langRouter() в app.js, минус /appointment/thanks (у неё
// нет самостоятельной ценности для поисковика — это экран после отправки
// формы) и минус /privacy, /terms (юридические заглушки — намеренно noindex,
// см. static-pages.js/renderLegal).
const STATIC_PATHS = ['doctors', 'services', 'departments', 'about', 'contact', 'faq', 'appointment'];

// sitemap.xml: все опубликованные сущности × 3 языка + статичные страницы.
// Без известного домена (seo.base_url пуст) абсолютные <loc> строить не из
// чего — по решению спеки в этом случае sitemap отдаётся ВООБЩЕ без записей
// (валидный, но пустой urlset), а не с path-relative <loc> (это нарушило бы
// протокол sitemaps.org, требующий абсолютные URL).
export function sitemapXml(db) {
  const settings = getSettings(db);
  const baseUrl = typeof settings.seo?.base_url === 'string' ? settings.seo.base_url.trim() : '';
  const head = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
  const tail = '</urlset>';
  if (!baseUrl) return head + tail;

  const doctors = publishedDoctors(db);
  const services = publishedServices(db);
  const departments = publishedDepartments(db);
  const posts = publishedPosts(db);

  // W2 — sitemap отдаёт только языки, включённые в settings.langs: у
  // отключённого языка все URL 302-редиректят на язык по умолчанию
  // (langRouter в app.js), индексировать их отдельно незачем и вредно
  // (дубли контента для поисковика).
  const paths = [];
  for (const lang of enabledLangsFromSettings(settings)) {
    paths.push(`/${lang}/`);
    paths.push(`/${lang}/doctors`);
    for (const d of doctors) paths.push(`/${lang}/doctors/${encodeURIComponent(d.slug)}`);
    paths.push(`/${lang}/services`);
    for (const s of services) paths.push(`/${lang}/services/${encodeURIComponent(s.slug)}`);
    paths.push(`/${lang}/departments`);
    for (const d of departments) paths.push(`/${lang}/departments/${encodeURIComponent(d.slug)}`);
    // Fix 4 (W4, launch-gate review) — список новостей /news попадает в
    // sitemap только когда есть хоть одна опубликованная новость: то же
    // правило W4-R2, что уже прячет пункт «Новости» из меню (layout.js,
    // navItems()) — пустой раздел не должен индексироваться отдельно.
    if (posts.length > 0) paths.push(`/${lang}/news`);
    for (const post of posts) paths.push(`/${lang}/news/${encodeURIComponent(post.slug)}`);
    for (const p of STATIC_PATHS.slice(3)) paths.push(`/${lang}/${p}`);
  }

  const urls = paths.map((p) => `<url><loc>${escXml(absUrl(baseUrl, p))}</loc></url>`).join('');
  return head + urls + tail;
}

// robots.txt: сайт полностью открыт индексации, кроме /api/ (не страницы —
// JSON-эндпоинт приёма заявок, индексировать нечего и не нужно). Строка
// Sitemap: печатается только когда домен уже известен — ссылка на
// относительный sitemap.xml без домена бессмысленна для внешних роботов.
export function robotsTxt(db) {
  const settings = getSettings(db);
  const baseUrl = typeof settings.seo?.base_url === 'string' ? settings.seo.base_url.trim() : '';
  let out = 'User-agent: *\nAllow: /\nDisallow: /api/\n';
  if (baseUrl) out += `Sitemap: ${absUrl(baseUrl, '/sitemap.xml')}\n`;
  return out;
}
