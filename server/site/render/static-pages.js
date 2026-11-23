// WEBSITE_V1 — статичные страницы: о клинике, контакты, вопросы-ответы,
// правовые документы (конфиденциальность/условия использования). Контактная
// и мини-форма обратного звонка отправляются на /api/requests (задача 10) —
// здесь только корректный HTML: обработка отправки и JS-улучшение форм
// (site.js) появятся вместе с самим эндпоинтом.
//
// ЭКРАНИРОВАНИЕ: page() вставляет body КАК ЕСТЬ (см. заголовок layout.js) —
// каждое значение из БД здесь обязано пройти через esc(). Единственное
// намеренное исключение — settings.contact.map_embed (см. renderContact),
// как и на главной (home.js/contactSection).
import { page, esc } from './layout.js';
import { t, pickContent, DEFAULT_LANG, LANGS } from '../i18n.js';
import { getSettings, publishedFaq, publishedTestimonials, clinicHours } from '../content.js';
import { faqJsonLd } from '../seo.js';

// Настройки заполняет администратор руками: значение может оказаться строкой
// там, где ждали {uz,ru,en}, числом там, где ждали строку, или мусором —
// тот же терпимый пикер, что и в home.js/layout.js (не экспортируется оттуда,
// поэтому копия здесь, как и в остальных рендерах сайта).
function pickText(value, lang) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    for (const l of [lang, DEFAULT_LANG, ...LANGS]) {
      const v = value[l];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
  }
  return '';
}

function telHref(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return digits ? 'tel:' + digits : '';
}

function paragraphs(text) {
  return String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`).join('');
}

// --------------------------------------------------------------------------
// О клинике: settings.about (per-lang {title, body}); при пустом about
// страница не остаётся пустой — переиспользует герой/статистику/«почему мы»/
// отзывы, те же данные, что уже показывает главная (settings.stats, why_us,
// publishedTestimonials). Секции-хелперы дублируют логику home.js намеренно:
// это отдельная страница со своим набором коммитуемых файлов задачи 9, а не
// повод трогать home.js.
function statsSection(lang, settings) {
  const stats = (Array.isArray(settings.stats) ? settings.stats : [])
    .map((s) => {
      if (!s || typeof s !== 'object') return '';
      const value = pickText(s.value, lang);
      const label = pickText(s.label, lang);
      if (!value && !label) return '';
      return `<div class="stat"><span class="stat__value">${esc(value)}</span>`
        + `<span class="stat__label">${esc(label)}</span></div>`;
    })
    .filter(Boolean)
    .join('');
  if (!stats) return '';
  return `<section class="section section--soft">
<div class="container"><div class="about-stats">${stats}</div></div>
</section>`;
}

function testimonialsSection(db, lang) {
  const all = publishedTestimonials(db);
  if (!all.length) return '';
  const cards = all
    .map((r) => {
      const c = pickContent(r.content, lang);
      if (!c.text) return '';
      const rating = Math.max(0, Math.min(5, Math.round(Number(r.rating) || 0)));
      const stars = rating
        ? `<div class="testimonial__rating" aria-label="${rating}/5">${
          '★'.repeat(rating)}${'☆'.repeat(5 - rating)}</div>`
        : '';
      return `<figure class="testimonial">
<p class="testimonial__text">${esc(c.text)}</p>
${stars}
${r.author_name ? `<figcaption class="testimonial__author">${esc(r.author_name)}</figcaption>` : ''}
</figure>`;
    })
    .filter(Boolean)
    .join('');
  if (!cards) return '';
  return `<section class="section section--soft"><div class="container">
<div class="section-head"><h2>${esc(t(lang, 'section.testimonials'))}</h2></div>
<div class="grid-3">${cards}</div>
</div></section>`;
}

export function renderAbout(db, lang) {
  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const about = pickContent(JSON.stringify(settings.about ?? {}), lang);
  const hero = pickContent(JSON.stringify(settings.hero ?? {}), lang);

  const heroTitle = about.title || hero.title || t(lang, 'nav.about');
  const leadSource = about.body || hero.subtitle || '';
  const lead = paragraphs(leadSource);

  const sections = [statsSection(lang, settings), testimonialsSection(db, lang)]
    .filter(Boolean).join('\n');

  const body = `<section class="section about-hero">
<div class="container about-hero__inner">
<h1>${esc(heroTitle)}</h1>
${lead ? `<div class="about-hero__lead">${lead}</div>` : ''}
</div>
</section>
${sections}`;

  const description = pickText(settings.seo?.description, lang)
    || (leadSource ? String(leadSource).slice(0, 160) : `${clinicName} — ${t(lang, 'nav.about')}.`);
  const title = heroTitle === clinicName ? heroTitle : `${heroTitle} — ${clinicName}`;

  return page({ db, lang, path: `/${lang}/about`, title, description, body, pageType: 'about' });
}

// --------------------------------------------------------------------------
// Контакты: адрес/телефон/e-mail, часы работы первого активного филиала,
// карта, и две формы (обращение + обратный звонок) на /api/requests.
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Часы работы филиала — намеренно терпимый разбор: `on` как синоним
// `enabled`, отсутствующий день = «закрыто», а если сам working_hours не
// распарсился в объект (content.js уже вернул hours=null) — блок часов не
// рисуется вовсе, вместо семи одинаковых «закрыто» на кривых данных.
// CONTACT_CARD_V1 — «09:00–18:00», если день действительно рабочий, иначе null.
// Формат дня задаёт админка филиалов, и там встречаются оба ключа включения
// (enabled/on) — исторически; принимаем любой, чтобы расписание не пропадало
// молча из-за того, каким именно ключом его когда-то сохранили.
function openRange(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const enabled = entry.enabled === true || entry.on === true;
  const from = typeof entry.from === 'string' ? entry.from.trim() : '';
  const to = typeof entry.to === 'string' ? entry.to.trim() : '';
  return enabled && from && to ? `${from}\u2013${to}` : null;
}

// CONTACT_CARD_V1 — одна строка режима работы для карточки контактов.
//
// Полная таблица на семь дней ниже по странице остаётся: она отвечает на
// вопрос «а в субботу?». Но в карточке нужна одна строка, поэтому одинаковые
// подряд идущие дни склеиваются в диапазон: «Пн–Пт 09:00–18:00, Сб 10:00–14:00»
// вместо семи строчек. Все семь дней с одним временем — «Ежедневно».
//
// null означает «сказать нечего» — строка режима работы тогда не рендерится
// вовсе, а не показывает пустоту или неправду.
export function hoursSummary(lang, clinic) {
  if (!clinic) return null;
  if (clinic.is_24_7) return t(lang, 'day.always');
  const hours = clinic.hours;
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) return null;

  const open = DAY_KEYS.map((d) => ({ day: d, range: openRange(hours[d]) }));
  if (!open.some((x) => x.range)) return null;
  if (open.every((x) => x.range === open[0].range)) {
    return `${t(lang, 'day.everyday')}, ${open[0].range}`;
  }

  const parts = [];
  let run = null;
  for (const x of open) {
    if (x.range && run && run.range === x.range) { run.end = x.day; continue; }
    if (run) parts.push(run);
    run = x.range ? { range: x.range, start: x.day, end: x.day } : null;
  }
  if (run) parts.push(run);

  return parts.map((r) => {
    const from = t(lang, `day.short.${r.start}`);
    const label = r.start === r.end ? from : `${from}\u2013${t(lang, `day.short.${r.end}`)}`;
    return `${label} ${r.range}`;
  }).join(', ');
}

// CONTACT_CARD_V1 — иконки строк карточки.
//
// Инлайн-SVG, потому что CSP сайта запрещает внешние ресурсы, а data:-картинки
// раздули бы страницу. Иконки ДЕКОРАТИВНЫЕ: смысл несёт текстовая подпись
// рядом («ТЕЛЕФОН», «АДРЕС»), поэтому aria-hidden — иначе скринридер прочитает
// каждую строку дважды.
const CONTACT_ICONS = {
  phone: '<path d="M4.2 5.6c0-.8.6-1.4 1.4-1.4h1.9c.6 0 1.1.4 1.3 1l.7 2.5c.1.5 0 1-.4 1.3l-1.2 1a11 11 0 0 0 4.1 4.1l1-1.2c.3-.4.8-.5 1.3-.4l2.5.7c.6.2 1 .7 1 1.3v1.9c0 .8-.6 1.4-1.4 1.4A12.5 12.5 0 0 1 4.2 5.6z"/>',
  telegram: '<path d="M20.5 4.6 3.9 10.9c-.8.3-.8 1.4 0 1.7l4.2 1.4 1.6 4.8c.2.7 1.1.9 1.6.3l2.3-2.4 4.2 3.1c.6.4 1.4.1 1.6-.6l2.6-13c.2-.8-.6-1.4-1.5-1z"/><path d="m8.2 14 9.6-6.7-7.1 8.1"/>',
  address: '<path d="M20 10.2c0 5.4-8 11.3-8 11.3s-8-5.9-8-11.3a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2.8"/>',
  email: '<rect x="3.2" y="5.4" width="17.6" height="13.2" rx="2.2"/><path d="m3.8 7 7.3 5.2c.5.4 1.3.4 1.8 0L20.2 7"/>',
  hours: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3 1.8"/>',
};

function contactIcon(kind) {
  return `<span class="contact-card__ico" aria-hidden="true">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"`
    + ` stroke-linecap="round" stroke-linejoin="round">${CONTACT_ICONS[kind]}</svg></span>`;
}

// CONTACT_CARD_V1 — строка карточки: иконка, мелкая подпись, значение.
//
// value — уже готовый HTML (ссылка или текст), потому что телефон и telegram
// обязаны быть кликабельны, а адрес — нет. Экранирование делает вызывающий
// код, здесь его повторять нельзя: esc() по готовой ссылке превратил бы её
// в текст.
function contactRow(kind, label, valueHtml) {
  if (!valueHtml) return '';
  return `<div class="contact-card__row">
${contactIcon(kind)}
<div class="contact-card__body">
<span class="contact-card__label">${esc(label)}</span>
<span class="contact-card__value">${valueHtml}</span>
</div>
</div>`;
}

// CONTACT_CARD_V1 — карточка контактов: телефон, telegram, адрес, почта,
// режим работы и кнопка записи.
//
// Пустые строки НЕ рендерятся: на клинике, где заполнен один телефон, карточка
// обязана быть карточкой из одной строки, а не четырьмя подписями над
// пустотой. Экспортируется, потому что этот же блок нужен секции контактов
// на главной — один дизайн в двух местах не должен разойтись двумя копиями.
export function contactCard(lang, data) {
  const { phone, telegram, address, email, hours } = data;
  const rows = [
    contactRow('phone', t(lang, 'contact.label_phone'),
      phone ? `<a href="${esc(telHref(phone))}">${esc(phone)}</a>` : ''),
    contactRow('telegram', t(lang, 'contact.label_telegram'),
      telegram ? `<a href="${esc(telegram)}" rel="noopener noreferrer" target="_blank">${
        esc(t(lang, 'contact.telegram_write'))}</a>` : ''),
    contactRow('address', t(lang, 'contact.label_address'), address ? esc(address) : ''),
    contactRow('email', t(lang, 'contact.label_email'),
      email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : ''),
    contactRow('hours', t(lang, 'contact.label_hours'), hours ? esc(hours) : ''),
  ].filter(Boolean).join('');
  if (!rows) return '';
  // QUICK_REQUEST_EVERYWHERE_V1 — кнопка открывает ОКНО заявки, а не страницу
  // записи. Страница с выбором услуги, врача, даты и времени спрашивает ровно то,
  // что колл-центр всё равно уточняет звонком — и теряет тех, кто не готов выбирать.
  // Предмет заявки здесь не подставляется намеренно: со страницы контактов
  // неизвестно, что человеку нужно.
  //
  // href остаётся настоящим: без JS и при открытии в новой вкладке страница
  // записи работает как раньше — она становится запасным входом, а не основным.
  return `<div class="contact-card">
<h2 class="contact-card__title">${esc(t(lang, 'nav.contact'))}</h2>
<div class="contact-card__rows">${rows}</div>
<a class="btn btn-primary btn-lg contact-card__cta" href="/${lang}/appointment" data-qr-open>${
  esc(t(lang, 'cta.book'))}</a>
</div>`;
}

function workingHoursBlock(lang, clinic) {
  if (!clinic) return '';
  if (clinic.is_24_7) {
    return `<div class="contact-hours">
<h2>${esc(t(lang, 'contact.hours_title'))}</h2>
<p>${esc(t(lang, 'day.always'))}</p>
</div>`;
  }
  const hours = clinic.hours;
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) return '';
  // CONTACT_CARD_V1 — если НИ ОДИН день не открыт, расписания просто нет:
  // филиал завели, часы не заполнили. Показать семь строк «Выходной» значит
  // сказать пациенту, что клиника закрыта всю неделю, — это хуже, чем не
  // сказать ничего, потому что выглядит как достоверный факт.
  if (!DAY_KEYS.some((d) => openRange(hours[d]))) return '';
  const rows = DAY_KEYS.map((d) => {
    const label = t(lang, `day.${d}`);
    const entry = hours[d];
    let text = t(lang, 'day.closed');
    if (entry && typeof entry === 'object') {
      const enabled = entry.enabled === true || entry.on === true;
      const from = typeof entry.from === 'string' ? entry.from.trim() : '';
      const to = typeof entry.to === 'string' ? entry.to.trim() : '';
      if (enabled && from && to) text = `${from}–${to}`;
    }
    return `<li><span class="contact-hours__day">${esc(label)}</span>`
      + `<span class="contact-hours__time">${esc(text)}</span></li>`;
  }).join('');
  return `<div class="contact-hours">
<h2>${esc(t(lang, 'contact.hours_title'))}</h2>
<ul class="contact-hours__list">${rows}</ul>
</div>`;
}

// Скрытые поля общие для обеих форм страницы (тип различается на вызове).
// ts — эпоха в мс на момент рендера страницы (не отправки формы) — задача 10
// использует её вместе с per-IP throttle против спама.
function hiddenFields(lang, path, type, ts) {
  return `<input type="hidden" name="type" value="${esc(type)}">
<input type="hidden" name="lang" value="${esc(lang)}">
<input type="hidden" name="page" value="${esc(path)}">
<input type="hidden" name="ts" value="${ts}">
<input name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">`;
}

function contactForm(lang, path, ts) {
  return `<form class="contact-form" action="/api/requests" method="post">
${hiddenFields(lang, path, 'contact', ts)}
<div class="form-field">
<label class="form-field__label" for="contact-name">${esc(t(lang, 'form.name'))}</label>
<input id="contact-name" name="name" type="text" autocomplete="name" required>
</div>
<div class="form-field">
<label class="form-field__label" for="contact-phone">${esc(t(lang, 'form.phone'))}</label>
<input id="contact-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required>
</div>
<div class="form-field">
<label class="form-field__label" for="contact-message">${esc(t(lang, 'form.message'))}</label>
<textarea id="contact-message" name="message"></textarea>
</div>
<button class="btn btn-primary btn-block" type="submit">${esc(t(lang, 'form.submit'))}</button>
</form>`;
}

function callbackForm(lang, path, ts) {
  return `<form class="contact-form contact-form--callback" action="/api/requests" method="post">
${hiddenFields(lang, path, 'callback', ts)}
<div class="form-field">
<label class="form-field__label" for="callback-name">${esc(t(lang, 'form.name'))}</label>
<input id="callback-name" name="name" type="text" autocomplete="name" required>
</div>
<div class="form-field">
<label class="form-field__label" for="callback-phone">${esc(t(lang, 'form.phone'))}</label>
<input id="callback-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required>
</div>
<button class="btn btn-primary btn-block" type="submit">${esc(t(lang, 'form.submit'))}</button>
</form>`;
}

export function renderContact(db, lang) {
  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const phone = String(settings.contact?.phone || '').trim();
  const address = pickText(settings.contact?.address, lang);
  const email = String(settings.contact?.email || '').trim();
  const mapUrl = String(settings.contact?.map_url || '').trim();
  const telegram = String(settings.social?.telegram || '').trim();
  const path = `/${lang}/contact`;
  const ts = Date.now();

  const clinic = clinicHours(db);
  const card = contactCard(lang, {
    phone, telegram, address, email, hours: hoursSummary(lang, clinic),
  });

  // ЕДИНСТВЕННАЯ намеренно неэкранированная вставка на странице: map_embed —
  // <iframe> карты, который администратор вставляет целиком (см. тот же
  // приём и то же обоснование в home.js/contactSection). Обёртка переиспользует
  // класс .home-map: тот же overflow:hidden-контейнер не даёт чужой разметке
  // сломать вёрстку, независимо от размеров, которые пришли из iframe.
  const embed = typeof settings.contact?.map_embed === 'string' && settings.contact.map_embed.trim()
    ? `<div class="home-map contact-map">${settings.contact.map_embed}</div>`
    : '';

  // Кнопка «как добраться» живёт ПОД картой, а при отсутствии карты — вместо
  // неё: ссылка на внешние карты полезна сама по себе, даже когда виджет не
  // вставлен.
  const mapLink = mapUrl
    ? `<div class="contact-side__actions"><a class="btn btn-ghost" href="${esc(mapUrl)}"
  rel="noopener noreferrer" target="_blank">${esc(t(lang, 'cta.directions'))}</a></div>`
    : '';
  const side = embed || mapLink ? `<div class="contact-side">${embed}${mapLink}</div>` : '';

  // Полная таблица часов — только когда расписание действительно заполнено
  // (workingHoursBlock сам вернёт пустоту, если все дни закрыты). В карточке
  // уже стоит сводка, поэтому таблица идёт отдельным блоком под ней и не
  // дублирует её построчно на узком экране.
  const hoursTable = workingHoursBlock(lang, clinic);

  // contact-grid--solo: карты нет — второй колонке нечего занимать, и карточка
  // растягивается вместо того, чтобы жаться в половину ширины ради пустоты.
  const body = `<section class="section contact-hero">
<div class="container"><div class="section-head"><h1>${esc(t(lang, 'nav.contact'))}</h1></div></div>
</section>
<section class="section">
<div class="container contact-grid${side ? '' : ' contact-grid--solo'}">
${card}
${side}
</div>
${hoursTable ? `<div class="container contact-hours-wrap">${hoursTable}</div>` : ''}
</section>
<section class="section section--soft">
<div class="container contact-forms">
<div class="contact-form-wrap">
<h2>${esc(t(lang, 'contact.form_title'))}</h2>
${contactForm(lang, path, ts)}
</div>
<div class="contact-form-wrap contact-form-wrap--callback">
<h2>${esc(t(lang, 'contact.callback_title'))}</h2>
${callbackForm(lang, path, ts)}
</div>
</div>
</section>`;

  const description = address || phone
    ? `${clinicName} \u2014 ${t(lang, 'nav.contact')}. ${[phone, address].filter(Boolean).join(', ')}.`
    : `${clinicName} \u2014 ${t(lang, 'nav.contact')}.`;

  return page({ db, lang, path, title: `${t(lang, 'nav.contact')} \u2014 ${clinicName}`, description, body, pageType: 'contact' });
}

// --------------------------------------------------------------------------
// Вопросы-ответы: та же выборка, что и секция FAQ на главной (publishedFaq),
// но на отдельной странице. Разметка — ровно <details><summary>…</summary>
// <p>…</p></details>, без дополнительной обёртки.
export function renderFaq(db, lang) {
  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const faq = publishedFaq(db);
  const items = faq
    .map((f) => {
      const c = pickContent(f.content, lang);
      if (!c.q) return '';
      return `<details class="faq-item">
<summary>${esc(c.q)}</summary>
<p>${esc(c.a || '')}</p>
</details>`;
    })
    .filter(Boolean)
    .join('');

  const body = `<section class="section">
<div class="container">
<div class="section-head"><h1>${esc(t(lang, 'section.faq'))}</h1></div>
${items ? `<div class="faq-list">${items}</div>` : `<p class="muted">${esc(t(lang, 'empty.faq'))}</p>`}
</div>
</section>`;

  const title = `${t(lang, 'section.faq')} — ${clinicName}`;
  const description = `${clinicName} — ${t(lang, 'section.faq')}.`;
  // FAQPage JSON-LD — только из пар с непустыми и вопросом, и ответом
  // (faqJsonLd сама фильтрует); при отсутствии валидных пар вернёт null,
  // и page() просто не напечатает <script type="application/ld+json">.
  const jsonLd = faqJsonLd(faq, lang);
  return page({ db, lang, path: `/${lang}/faq`, title, description, body, jsonLd, pageType: 'faq' });
}

// --------------------------------------------------------------------------
// Правовые документы: settings.legal = {privacy:{uz,ru,en}, terms:{uz,ru,en}},
// каждое значение — простой текст (не объект с полями, как у content.* сущностей),
// поэтому берём его тем же терпимым pickText, что и hero/stats/why_us выше.
// Пустой/кривой текст — не 404 и не пустая страница, а заглушка для клиники,
// помеченная noindex, пока реальный документ не опубликован через админку W2.
function legalKey(kind, suffix) {
  return kind === 'privacy' ? `legal.privacy_${suffix}` : `legal.terms_${suffix}`;
}

export function renderLegal(db, lang, kind) {
  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const legalAll = settings.legal && typeof settings.legal === 'object' ? settings.legal : {};
  const text = pickText(legalAll[kind], lang);
  const isStub = !text;
  const bodyText = isStub ? t(lang, legalKey(kind, 'stub')) : text;
  const title = t(lang, legalKey(kind, 'title'));

  const body = `<section class="section legal-page">
<div class="container legal-page__inner">
<h1>${esc(title)}</h1>
<div class="legal-content">${paragraphs(bodyText)}</div>
</div>
</section>`;

  return page({
    db, lang, path: `/${lang}/${kind}`,
    title: `${title} — ${clinicName}`,
    description: `${title} — ${clinicName}.`,
    body,
    noindex: isStub,
    pageType: 'legal',
  });
}
