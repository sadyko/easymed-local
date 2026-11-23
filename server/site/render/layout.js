// WEBSITE_V1 — каркас страницы публичного сайта: единственное место, где
// собирается <head>, шапка, подвал и мобильная панель действий. Все страницы
// (задачи 6–11) обязаны рендериться через page(), иначе разъедутся мета-теги,
// hreflang и мобильная навигация.
//
// ПРАВИЛО ЭКРАНИРОВАНИЯ: page() экранирует только то, что получает отдельными
// полями (title, description). body вставляется КАК ЕСТЬ — вызывающая страница
// сама обязана прогнать пользовательские данные через esc().
import { LANGS, DEFAULT_LANG, t, langUrl } from '../i18n.js';
import { getSettings, enabledLangsFromSettings, defaultLangFromSettings, publishedPosts } from '../content.js';
import { absUrl } from '../seo.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Настройки сайта частично по-языковые ({uz:…, ru:…}), частично простые
// строки — берём то, что подходит, без падений на кривом JSON.
function pickText(value, lang) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    for (const l of [lang, DEFAULT_LANG, ...LANGS]) {
      if (typeof value[l] === 'string' && value[l]) return value[l];
    }
  }
  return '';
}

function telHref(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return digits ? 'tel:' + digits : '';
}

const OG_LOCALE = { uz: 'uz_UZ', ru: 'ru_RU', en: 'en_US' };

// Подписи «обвязки» (меню, ориентиры, skip-link). В i18n.js их нет намеренно:
// это не контент сайта, а служебные ярлыки каркаса — живут вместе с каркасом.
const CHROME = {
  uz: { menu: 'Menyu', main_nav: 'Asosiy menyu', footer_nav: 'Sayt boʻlimlari', quick: 'Tezkor amallar', skip: 'Asosiy qismga oʻtish', close: 'Yopish' },
  ru: { menu: 'Меню', main_nav: 'Основное меню', footer_nav: 'Разделы сайта', quick: 'Быстрые действия', skip: 'Перейти к содержимому', close: 'Закрыть' },
  en: { menu: 'Menu', main_nav: 'Main navigation', footer_nav: 'Site sections', quick: 'Quick actions', skip: 'Skip to content', close: 'Close' },
};

function chrome(lang, key) {
  return (CHROME[lang] || CHROME[DEFAULT_LANG])[key];
}

// W4-R2 — пункт «Новости» в меню появляется только когда есть хоть одна
// опубликованная новость: пустой раздел в меню — тупик для посетителя.
// publishedPosts(db) уже кэширована (см. content.js, TTL 30с) — лишнего
// похода в БД на каждый рендер шапки/подвала это не добавляет.
function navItems(lang, db) {
  const items = [
    { href: `/${lang}/`, label: t(lang, 'nav.home') },
    { href: `/${lang}/doctors`, label: t(lang, 'nav.doctors') },
    { href: `/${lang}/services`, label: t(lang, 'nav.services') },
    { href: `/${lang}/departments`, label: t(lang, 'nav.departments') },
    { href: `/${lang}/about`, label: t(lang, 'nav.about') },
  ];
  if (publishedPosts(db).length > 0) {
    items.push({ href: `/${lang}/news`, label: t(lang, 'nav.news') });
  }
  items.push({ href: `/${lang}/contact`, label: t(lang, 'nav.contact') });
  return items;
}

function isActive(href, path) {
  const a = href.replace(/\/+$/, '') || '/';
  const b = String(path || '').replace(/\/+$/, '') || '/';
  return a === b;
}

// --- Иконки: инлайн-SVG, потому что CSP запрещает внешние ресурсы, а
// data:-картинки раздувают каждую страницу сильнее, чем сам путь. ---
const ICON = {
  phone: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.2.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1z"/></svg>',
  calendar: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  pin: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="11" r="2.6"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M21.8 4.6 18.9 19c-.2 1-.8 1.2-1.6.8l-4.5-3.3-2.2 2.1c-.2.2-.5.4-.9.4l.3-4.6 8.4-7.6c.4-.3-.1-.5-.6-.2L7.4 13.1 3 11.7c-1-.3-1-1 .2-1.4l17.3-6.7c.8-.3 1.5.2 1.3 1z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5.2"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13.5 21v-7.2h2.4l.4-2.8h-2.8V9.2c0-.8.2-1.4 1.4-1.4h1.5V5.3c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.1H8v2.8h2.5V21z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12c0 1.6.1 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8c1.6.4 7.8.4 7.8.4s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8c.3-1.6.4-3.2.4-4.8s-.1-3.2-.4-4.8M10 15.2V8.8l5.2 3.2z"/></svg>',
};

const SOCIAL_ORDER = [
  ['telegram', 'Telegram'],
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['youtube', 'YouTube'],
];

// W2 — переключатель показывает только языки, включённые в settings.langs
// (enabled приходит уже посчитанным из page(), чтобы не пересчитывать его в
// header()/footer() отдельно на каждый вызов).
function langSwitch(lang, path, enabled) {
  const pills = enabled.map((l) => {
    const cls = l === lang ? 'lang-switch__item is-current' : 'lang-switch__item';
    const cur = l === lang ? ' aria-current="true"' : '';
    return `<a class="${cls}" href="${esc(langUrl(l, path))}" hreflang="${l}" lang="${l}"${cur}>${l.toUpperCase()}</a>`;
  }).join('');
  return `<div class="lang-switch" role="group" aria-label="${esc(t(lang, 'langs_label'))}">${pills}</div>`;
}

function header(lang, path, settings, enabled, db) {
  const name = esc(settings.clinic_name || 'EasyMed Light');
  const tel = telHref(settings.contact?.phone);
  const links = navItems(lang, db).map((it) =>
    `<li><a class="site-nav__link${isActive(it.href, path) ? ' is-current' : ''}" href="${esc(it.href)}"${
      isActive(it.href, path) ? ' aria-current="page"' : ''}>${esc(it.label)}</a></li>`).join('');
  const phoneLink = tel
    ? `<a class="header-phone" href="${esc(tel)}">${ICON.phone}<span>${esc(settings.contact.phone)}</span></a>`
    : '';
  return `<header class="site-header">
<div class="container site-header__inner">
<a class="brand" href="/${lang}/"><img class="brand__mark" src="/assets/logo.webp" alt="" width="122" height="128"><span class="brand__name">${name}</span></a>
<nav class="site-nav" id="site-nav" aria-label="${esc(chrome(lang, 'main_nav'))}"><ul class="site-nav__list">${links}</ul>
<div class="site-nav__foot">${phoneLink}<a class="btn btn-primary" href="/${lang}/appointment">${esc(t(lang, 'nav.appointment'))}</a></div></nav>
<div class="header-actions">${langSwitch(lang, path, enabled)}${phoneLink}<a class="btn btn-primary header-cta" href="/${lang}/appointment">${esc(t(lang, 'cta.book'))}</a>
<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="${esc(chrome(lang, 'menu'))}"><span class="nav-toggle__bars" aria-hidden="true"></span></button>
</div>
</div>
</header>`;
}

// QUICK_REQUEST_V1 — быстрая заявка: имя и телефон, остальное подставляется.
//
// Кнопка «Оставить заявку» у услуги вела на /appointment: целая страница с
// выбором услуги, врача, даты и времени — ради того, чтобы человек оставил
// номер. На телефоне это почти гарантированный уход. Здесь ровно два поля, а
// услугу (или врача) окно берёт из нажатой кнопки.
//
// Окно ОДНО на страницу и живёт в каркасе: услуг на странице бывает за сотню,
// и рисовать форму рядом с каждой значило бы сотню форм в разметке.
//
// Без JS ничего не ломается: кнопка остаётся обычной ссылкой на /appointment,
// скрипт лишь перехватывает клик. Поэтому здесь НЕ <dialog>: без скрипта его
// поведение неотличимо от сломанного.
//
// ts — время РЕНДЕРА страницы: сервер отклоняет форму, отправленную быстрее чем
// за три секунды (requests.js), и это же значение нужно окну.
function quickRequest(lang, path, ts) {
  const f = (key) => esc(t(lang, key));
  return [
    '<div class="qr" id="qr" hidden>',
    '<div class="qr__backdrop" data-qr-close></div>',
    '<div class="qr__card" role="dialog" aria-modal="true" aria-labelledby="qr-title">',
    '<button class="qr__close" type="button" data-qr-close aria-label="'
      + esc(chrome(lang, 'close')) + '">×</button>',
    '<h2 class="qr__title" id="qr-title">' + f('cta.request') + '</h2>',
    '<p class="qr__subject" id="qr-subject" hidden></p>',
    '<form class="qr__form js-request-form" action="/api/requests" method="post"',
    ' data-success-title="' + f('form.sent_title') + '"',
    ' data-success-text="' + f('form.sent_text') + '"',
    ' data-error-text="' + f('form.error') + '">',
    '<input type="hidden" name="type" value="appointment">',
    '<input type="hidden" name="lang" value="' + esc(lang) + '">',
    '<input type="hidden" name="page" value="' + esc(path) + '">',
    '<input type="hidden" name="ts" value="' + ts + '">',
    '<input type="hidden" name="service" id="qr-service" value="">',
    '<input type="hidden" name="doctor" id="qr-doctor" value="">',
    '<input name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">',
    '<div class="form-field">',
    '<label class="form-field__label" for="qr-name">' + f('form.name') + '</label>',
    '<input id="qr-name" name="full_name" type="text" required autocomplete="name" maxlength="200">',
    '</div>',
    '<div class="form-field">',
    '<label class="form-field__label" for="qr-phone">' + f('form.phone') + '</label>',
    '<input id="qr-phone" name="phone" type="tel" required autocomplete="tel" inputmode="tel" maxlength="32">',
    '</div>',
    '<button class="btn btn-primary btn-lg qr__submit" type="submit">' + f('cta.request') + '</button>',
    '</form>',
    '</div>',
    '</div>',
  ].join('\n');
}

function footer(lang, path, settings, enabled, db) {
  const name = esc(settings.clinic_name || 'EasyMed Light');
  const address = pickText(settings.contact?.address, lang);
  const phone = settings.contact?.phone || '';
  const email = settings.contact?.email || '';
  const tel = telHref(phone);
  const social = SOCIAL_ORDER
    .filter(([key]) => typeof settings.social?.[key] === 'string' && settings.social[key].trim())
    .map(([key, label]) =>
      `<a class="social-link" href="${esc(settings.social[key].trim())}" rel="noopener noreferrer" target="_blank" aria-label="${label}" title="${label}">${ICON[key]}</a>`)
    .join('');
  const links = navItems(lang, db).slice(1)
    .map((it) => `<li><a href="${esc(it.href)}">${esc(it.label)}</a></li>`).join('');
  return `<footer class="site-footer" id="contacts">
<div class="container site-footer__grid">
<div class="site-footer__brand">
<div class="site-footer__name">${name}</div>
${address ? `<address class="site-footer__address">${esc(address)}</address>` : ''}
${social ? `<div class="site-footer__social">${social}</div>` : ''}
</div>
<nav class="site-footer__nav" aria-label="${esc(chrome(lang, 'footer_nav'))}"><ul>${links}</ul></nav>
<div class="site-footer__contacts">
${tel ? `<a class="site-footer__phone" href="${esc(tel)}">${esc(phone)}</a>` : ''}
${email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : ''}
<a class="btn btn-ghost" href="/${lang}/appointment">${esc(t(lang, 'cta.book'))}</a>
</div>
</div>
<div class="container site-footer__bottom">
<span>© ${new Date().getFullYear()} ${name}. ${esc(t(lang, 'footer.rights'))}</span>
${langSwitch(lang, path, enabled)}
</div>
</footer>`;
}

// Липкая нижняя панель — главный элемент мобильного UX: ~90% посетителей
// с телефона, и «позвонить» должно быть в большом пальце всегда.
function mobileBar(lang, settings) {
  const tel = telHref(settings.contact?.phone);
  const map = typeof settings.contact?.map_url === 'string' && settings.contact.map_url.trim()
    ? settings.contact.map_url.trim() : '#contacts';
  const external = map !== '#contacts' ? ' rel="noopener noreferrer" target="_blank"' : '';
  const call = tel
    ? `<a class="mobile-bar__item" href="${esc(tel)}">${ICON.phone}<span>${esc(t(lang, 'cta.call'))}</span></a>`
    : `<a class="mobile-bar__item" href="/${lang}/contact">${ICON.phone}<span>${esc(t(lang, 'cta.call'))}</span></a>`;
  return `<nav class="mobile-bar" aria-label="${esc(chrome(lang, 'quick'))}">
${call}
<a class="mobile-bar__item mobile-bar__item--primary" href="/${lang}/appointment">${ICON.calendar}<span>${esc(t(lang, 'cta.book'))}</span></a>
<a class="mobile-bar__item" href="${esc(map)}"${external}>${ICON.pin}<span>${esc(t(lang, 'cta.directions'))}</span></a>
</nav>`;
}

// W2 — settings.seo.title{uz,ru,en}: администратор задаёт «имя сайта» для
// <title>/og:title отдельно от clinic_name. Раньше это поле нигде не
// читалось; теперь page() — ЕДИНСТВЕННОЕ место, которое его учитывает, а не
// каждый renderer по отдельности: заголовки страниц по всему сайту устроены
// как «X — <имя сайта>» (или просто «<имя сайта>» на пустой странице), так
// что достаточно подменить суффикс/значение уже готового title, не трогая
// db/render/*.js. Пусто/не задано на языке — используем clinic_name как и
// раньше (settings уже посчитан в page(), поэтому берём его, а не db).
function siteTitle(settings, lang, fallbackName) {
  return pickText(settings.seo?.title, lang) || fallbackName;
}

// W4-R3 — раз-экранирование, ИСКЛЮЧЕНИЕ №3: settings.analytics.inject_snippet
// вставляется перед </body> КАК ЕСТЬ, без esc(). Исключения №1/№2 — тот же
// приём для settings.contact.map_embed (server/site/render/home.js и
// static-pages.js, см. комментарий там же «ЕДИНСТВЕННАЯ намеренно
// неэкранированная вставка на странице»): тот же уровень доверия — значение
// пишет администратор клиники через вкладку «SEO» настроек сайта (не
// посетитель с улицы), и, как и у карты, у кода аналитики (Google Analytics/
// Яндекс.Метрика) просто нет экранированной формы — весь смысл в исполняемом
// <script>, esc() превратил бы его в нерабочий текст.
function analyticsSnippet(settings) {
  const raw = settings.analytics?.inject_snippet;
  return typeof raw === 'string' && raw.trim() ? raw : '';
}

export function page({ db, lang, path, title, description, body, jsonLd, noindex, pageType } = {}) {
  const l = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  const p = path && String(path).startsWith('/') ? String(path) : `/${l}/`;
  const settings = getSettings(db);
  const baseUrl = typeof settings.seo?.base_url === 'string' ? settings.seo.base_url.trim() : '';
  const siteName = settings.clinic_name || 'EasyMed Light';
  const enabled = enabledLangsFromSettings(settings);
  const dl = defaultLangFromSettings(settings);
  const seoName = siteTitle(settings, l, siteName);
  let docTitle = title ? String(title) : siteName;
  if (seoName !== siteName) {
    if (docTitle === siteName) docTitle = seoName;
    else if (docTitle.endsWith(' — ' + siteName)) docTitle = docTitle.slice(0, -(' — ' + siteName).length) + ' — ' + seoName;
  }
  const desc = description ? String(description) : '';

  // W2 — hreflang-альтернативы только для включённых языков (settings.langs);
  // x-default указывает на язык по умолчанию (settings.default_lang), а не
  // всегда на константу DEFAULT_LANG — она остаётся лишь фолбэком внутри
  // defaultLangFromSettings() на случай мусора в настройках.
  const alternates = enabled
    .map((x) => `<link rel="alternate" hreflang="${x}" href="${esc(absUrl(baseUrl, langUrl(x, p)))}">`)
    .concat(`<link rel="alternate" hreflang="x-default" href="${esc(absUrl(baseUrl, langUrl(dl, p)))}">`)
    .join('\n');

  // JSON-LD НЕ экранируется через esc() — это JSON, а не HTML. От разрыва
  // тега защищает подмена '<' на \u003c, остающаяся валидным JSON.
  const ld = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>\n`
    : '';

  return `<!doctype html>
<html lang="${l}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(docTitle)}</title>
${desc ? `<meta name="description" content="${esc(desc)}">\n` : ''}<meta name="theme-color" content="#167873">
${noindex ? '<meta name="robots" content="noindex, follow">\n' : ''}<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(siteName)}">
<meta property="og:title" content="${esc(docTitle)}">
${desc ? `<meta property="og:description" content="${esc(desc)}">\n` : ''}<meta property="og:locale" content="${OG_LOCALE[l] || 'uz_UZ'}">
${baseUrl ? `<meta property="og:url" content="${esc(absUrl(baseUrl, p))}">\n<link rel="canonical" href="${esc(absUrl(baseUrl, p))}">\n` : ''}${alternates}
<link rel="icon" type="image/webp" href="/assets/logo.webp">
<link rel="stylesheet" href="/assets/site.css">
${ld}</head>
<body data-page-type="${esc(pageType || 'other')}">
<a class="skip-link" href="#main">${esc(chrome(l, 'skip'))}</a>
${header(l, p, settings, enabled, db)}
<main id="main">
${body || ''}
</main>
${footer(l, p, settings, enabled, db)}
${quickRequest(l, p, Date.now())}
${mobileBar(l, settings)}
<script src="/assets/site.js" defer></script>${
  // SERVICES_FILTER_V1 — живой поиск по услугам нужен ровно на одной странице,
  // поэтому и подключается только на ней, а не на всех. Перенос строки внутри
  // условия, а не снаружи: иначе на каждой НЕ-услуговой странице оставалась бы
  // пустая строка перед </body>.
  pageType === 'services' ? '\n<script src="/assets/services.js" defer></script>' : ''}${
  // DOC_FILTER_V1 — живой фильтр нужен только на странице врачей, и грузится
  // только там: site.js висит на КАЖДОЙ странице, и дописывать туда код ради
  // одной — значит платить весом на всех остальных.
  pageType === 'doctors' ? '\n<script src="/assets/doctors.js" defer></script>' : ''}${
  // HERO_SLIDESHOW_V1 — смена фото в заголовке есть только на главной.
  pageType === 'home' ? '\n<script src="/assets/hero.js" defer></script>' : ''}
${analyticsSnippet(settings)}</body>
</html>`;
}
