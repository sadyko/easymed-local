// WEBSITE_V1 — главная страница: витрина клиники и главная точка входа.
// Каждая секция рендерится ТОЛЬКО когда под неё есть данные, поэтому на
// пустой БД страница не разваливается — остаются герой с названием клиники,
// блок контактов и призыв записаться.
//
// ЭКРАНИРОВАНИЕ: page() вставляет body КАК ЕСТЬ (см. заголовок layout.js),
// значит КАЖДОЕ значение из БД здесь обязано пройти через esc(). Единственное
// намеренное исключение — settings.contact.map_embed (см. contactSection).
import { page, esc } from './layout.js';
import { t, pickContent, DEFAULT_LANG, LANGS } from '../i18n.js';
import {
  getSettings, publishedDoctors, publishedServices, publishedDepartments,
  publishedTestimonials, publishedFaq, clinicHours } from '../content.js';
import { mediaUrl, money, priceFrom, doctorCard } from './helpers.js';
import { orgJsonLd } from '../seo.js';
import { deptIcon } from './dept-icons.js';   // DEPT_ICONS_V1
import { sortServices } from './service-order.js';   // CONSULT_FIRST_V1
// CONTACT_HOME_V1 — карточка контактов и сводка режима работы берутся
// готовыми: тот же блок на /contact собран ими же.
import { contactCard, hoursSummary } from './static-pages.js';

const FEATURED_LIMIT = 6;
const DOCTORS_LIMIT = 8;

// Настройки заполняет администратор руками: значение может оказаться строкой
// там, где ждали {uz,ru,en}, числом там, где ждали строку, или мусором.
// Ни один такой случай не имеет права уронить главную — молча пропускаем.
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

// HERO_ELEGANT_V1 — адрес дополнительной кнопки героя администратор вводит
// руками, значит это ровно такой же недоверенный ввод, как и всё остальное.
// esc() экранирует кавычки, но НЕ спасает от «javascript:…» внутри href —
// поэтому схему проверяем отдельно и молча выбрасываем непонятное.
function safeHref(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (/^(?:https?:\/\/|tel:|mailto:)/i.test(s)) return s;
  // «//evil.tld» — протокол-относительная ссылка на чужой origin, не свой путь.
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (s.startsWith('#')) return s;
  return '';
}

// HERO_ELEGANT_V1 — {label:{uz,ru,en}, href}. Кнопка появляется, только когда
// заполнены ОБЕ части: подпись без адреса — ссылка в никуда, адрес без
// подписи — пустое пятно, ни то ни другое показывать нельзя.
function heroCta(lang, cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const label = pickText(cfg.label, lang);
  const href = safeHref(cfg.href);
  if (!label || !href) return null;
  return { label, href };
}

// HERO_ELEGANT_V1 — ценовой «якорь» героя: «от 19 999 000 so'm», где число
// набрано крупно и акцентным цветом, а «от» и валюта — мелко и приглушённо.
// Группировку разрядов НЕ дублируем: берём готовую строку money() (тот же
// формат, что и у цен услуг) и режем её по ПОСЛЕДНЕМУ неразрывному пробелу —
// сам money() ставит его только между числом и словом валюты, внутри числа
// разряды тоже неразрывные, поэтому ищем именно последний.
function heroPrice(lang, raw) {
  const p = raw.price;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '';
  const full = money(p.amount, lang);   // пустая строка на мусоре и на 0
  if (!full) return '';
  const cut = full.lastIndexOf('\u00A0');
  const amount = cut > 0 ? full.slice(0, cut) : full;
  const currency = cut > 0 ? full.slice(cut + 1) : '';
  // Слово «от» — то же самое, что у карточек услуг (price.from), а не новая
  // строка: галочка в админке лишь решает, показывать его или нет.
  const from = p.from ? t(lang, 'price.from') : '';
  // Это НЕ заголовок: цена не структурирует страницу, она часть абзаца-строки.
  return `<p class="hero__price">${
    from ? `<span class="hero__price-from">${esc(from)}</span>` : ''
  }<span class="hero__price-amount">${esc(amount)}</span>${
    currency ? `<span class="hero__price-currency">${esc(currency)}</span>` : ''
  }</p>`;
}

// HERO_ELEGANT_V1 — коллаж из двух фото в форме арки. Первое фото — самый
// крупный элемент первого экрана, то есть LCP: грузим его обычным образом,
// без loading="lazy" (браузер откладывал бы именно ту картинку, ради которой
// страница и открыта). Второе — ниже и позади, ему lazy в самый раз.
// width/height стоят у обоих: без них браузер не резервирует место и страница
// прыгает при загрузке (CLS).
// HERO_SLIDESHOW_V1 — какие кадры показывает заголовок.
//
// Источников два: hero.photos — список произвольной длины, заведённый под
// смену кадров; hero.img1/img2 — прежняя пара. Список главнее, но пара
// остаётся рабочей, пока он пуст: у клиники уже загружено фото первым
// способом, и после выката заголовок не должен опустеть.
//
// Отдельной функцией и без разметки — чтобы правило «что показывать» можно
// было проверить тестом, не разбирая HTML.
export function heroFrames(raw) {
  const list = Array.isArray(raw && raw.photos) ? raw.photos : [];
  const fromList = list.map((p) => (typeof p === 'string' ? p : (p && p.path))).filter(Boolean);
  if (fromList.length) return fromList;
  return [raw && raw.img1, raw && raw.img2].filter(Boolean);
}

// КОЛЛАЖ ОСТАЁТСЯ, меняется его содержимое.
//
// Раскладка неподвижна: крупное переднее фото аркой и второе поменьше позади.
// Каждые 5 секунд обе позиции берут следующие снимки списка — переднее
// показывает photos[i], заднее photos[i+1]. Так коллаж всегда полон, каждый
// снимок успевает побывать и передним, и задним, и никогда не совпадает сам с
// собой.
//
// В КАЖДОЙ позиции лежат ВСЕ кадры сразу, лишние скрыты hidden. Подменять src
// нельзя: пока грузится следующий файл, на его месте белая вспышка во весь
// заголовок. Переход делает CSS по opacity, поэтому кадры обязаны уже быть в
// документе. Без JS виден ровно один кадр в каждой позиции — обычный коллаж.
function heroSlot(frames, cls, startIndex, title, lazyAll) {
  const imgs = frames.map((src, k) => {
    const visible = k === startIndex;
    // Первое фото переднего слота — LCP страницы: ему lazy противопоказан,
    // браузер отложил бы именно ту картинку, ради которой страницу открыли.
    const lazy = (lazyAll || !visible) ? ' loading="lazy"' : '';
    // Подпись несёт только видимый передний кадр: остальные — та же сцена,
    // и читалка не должна произносить заголовок клиники N раз подряд.
    const alt = (!lazyAll && visible) ? esc(title) : '';
    return `<img class="hero__frame" src="${esc(src)}" alt="${alt}"`
      + ` width="${lazyAll ? 380 : 520}" height="${lazyAll ? 475 : 650}"${lazy}${visible ? '' : ' hidden'}>`;
  }).join('');
  return `<div class="hero__photo ${cls}" data-hero-slot="${lazyAll ? 'back' : 'front'}">${imgs}</div>`;
}

function heroCollage(raw, title) {
  // Через mediaUrl прогоняем ДО подсчёта: он выбрасывает пути с «..» и
  // обратными слэшами, и отбраковка должна случиться раньше, чем мы решим,
  // сколько у нас кадров. Иначе один негодный путь дал бы «коллаж из одного
  // кадра» с пустым src вместо честного отсутствия блока.
  const frames = heroFrames(raw).map(mediaUrl).filter(Boolean);
  if (!frames.length) return '';

  // Один снимок — ни коллажа, ни смены: показывать нечего и не с чем чередовать.
  if (frames.length === 1) {
    return `<div class="hero__collage hero__collage--single">`
      + `<div class="hero__photo hero__photo--front">`
      + `<img src="${esc(frames[0])}" alt="${esc(title)}" width="520" height="650"></div></div>`;
  }

  // Заднее фото идёт в разметке первым: переднее должно перекрывать его, а не
  // наоборот, и порядок в потоке — единственное, что это задаёт без z-index-войн.
  const back = heroSlot(frames, 'hero__photo--back', 1 % frames.length, title, true);
  const front = heroSlot(frames, 'hero__photo--front', 0, title, false);
  return `<div class="hero__collage"${frames.length > 1 ? ' data-hero-slideshow' : ''}>${back}${front}</div>`;
}

// Иконка третьей кнопки — фиксированная, не настраиваемая: администратор
// задаёт подпись и адрес, вид кнопки — дело дизайна. aria-hidden, потому что
// смысл несёт подпись рядом, а не сердце.
const HERO_CTA3_ICON = '<svg class="hero__cta3-ico" viewBox="0 0 24 24" width="18" height="18"'
  + ' aria-hidden="true" focusable="false"><path fill="currentColor"'
  + ' d="M12 20.3l-1.1-1C5.4 14.4 2 11.3 2 7.5 2 4.4 4.4 2 7.5 2c1.7 0 3.4.8 4.5 2.1C13.1 2.8 14.8 2'
  + ' 16.5 2 19.6 2 22 4.4 22 7.5c0 3.8-3.4 6.9-8.9 11.8l-1.1 1z"/></svg>';

function heroSection(lang, settings, hero) {
  // hero (аргумент) — уже выбранный язык {title,subtitle,cta}; всё новое лежит
  // рядом с языковыми ветками и языка не имеет вовсе (цена, фото) либо имеет
  // свой формат {uz,ru,en} (кикер, подписи кнопок), поэтому читаем сырой объект.
  const raw = (settings.hero && typeof settings.hero === 'object' && !Array.isArray(settings.hero))
    ? settings.hero : {};
  const title = hero.title || settings.clinic_name || 'EasyMed Light';
  const subtitle = hero.subtitle || '';
  const kicker = pickText(raw.kicker, lang);
  const price = heroPrice(lang, raw);
  const cta2 = heroCta(lang, raw.cta2);
  const cta3 = heroCta(lang, raw.cta3);
  const collage = heroCollage(raw, title);
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
  // hero__inner--solo — фото не загружены: второй колонке нечего занимать, и
  // текст растягивается на всю ширину вместо половины с пустотой справа.
  return `<section class="hero home-hero">
<div class="container hero__inner${collage ? '' : ' hero__inner--solo'}">
<div class="hero__copy">
${kicker ? `<p class="hero__kicker">${esc(kicker)}</p>` : ''}
<h1>${esc(title)}</h1>
${price}
${subtitle ? `<p class="hero__lead">${esc(subtitle)}</p>` : ''}
<div class="hero__actions">
<a class="btn btn-primary btn-lg" href="/${lang}/appointment" data-qr-open>${esc(hero.cta || t(lang, 'cta.book'))}</a>
${cta2 ? `<a class="btn btn-ghost btn-lg" href="${esc(cta2.href)}">${esc(cta2.label)}</a>` : ''}
${cta3 ? `<a class="hero__cta3" href="${esc(cta3.href)}">${HERO_CTA3_ICON}<span>${esc(cta3.label)}</span></a>` : ''}
</div>
</div>
${collage}
${stats ? `<div class="hero__stats">${stats}</div>` : ''}
</div>
</section>`;
}

function servicesSection(db, lang) {
  const all = publishedServices(db);
  if (!all.length) return null;
  // «Витрина» — это featured; если администратор ничего не отметил, показываем
  // первые по порядку сортировки, чтобы секция не исчезала зря.
  const featured = all.filter((s) => Number(s.featured) === 1);
  // HOME_SERVICES_LIST_V1 — СТРОКАМИ, а не карточками, и той же разметкой
  // .svc-row, что и на странице услуг. Причины две.
  //
  // Во-первых, одинаковое должно выглядеть одинаково: человек, перешедший с
  // главной на «Все услуги», не должен заново разбираться, что перед ним.
  // Во-вторых, карточка растягивала одну строку названия на блок высотой
  // ~110px, и шесть услуг занимали пол-экрана ради шести строк текста.
  //
  // Длительность убрана намеренно, по той же причине, что и на странице услуг:
  // в базе она почти везде равна дефолтным тридцати минутам, то есть это слот
  // расписания, а не обещание пациенту. Повторённое шесть раз «30 daqiqa»
  // ничего не различает и только шумит.
  // CONSULT_FIRST_V1 — платные консультации первыми, затем бесплатные, затем
  // остальное. Сортируем ВНУТРИ выбранного, а не вместо выбора: если
  // администратор отметил витрину руками, автоматическое правило не вправе
  // выкидывать его услуги ради консультаций — оно лишь решает, в каком порядке
  // показать отмеченные. Не отмечено ничего — сортируется общий список.
  const cards = sortServices(featured.length ? featured : all).slice(0, FEATURED_LIMIT)
    .map((s) => {
      const c = pickContent(s.content, lang);
      if (!c.name) return '';
      const price = priceFrom(s.price, lang);
      const slug = esc(encodeURIComponent(s.slug));
      return `<div class="svc-row">
<a class="svc-row__link" href="/${lang}/services/${slug}">
<span class="svc-row__name">${esc(c.name)}</span>
${c.short_desc ? `<span class="svc-row__desc">${esc(c.short_desc)}</span>` : ''}
</a>
${price ? `<span class="svc-row__price">${esc(price)}</span>` : ''}
<a class="btn btn-primary svc-row__cta" href="/${lang}/appointment?service=${slug}"
  data-qr-open data-service="${slug}" data-subject="${esc(c.name)}" aria-label="${
  esc(t(lang, 'cta.request'))} — ${esc(c.name)}">${esc(t(lang, 'cta.request'))}</a>
</div>`;
    })
    .filter(Boolean)
    .join('');
  if (!cards) return null;
  return {
    title: t(lang, 'section.services'),
    body: `<div class="svc-list">${cards}</div>`,
    actions: `<div class="section-actions"><a class="btn btn-ghost" href="/${lang}/services">${
      esc(t(lang, 'cta.all_services'))}</a></div>`,
  };
}

// DOCTOR_CARD_ACTIONS_V1 — карточку берём у общего doctorCard.
//
// Здесь лежала ВТОРАЯ копия той же разметки. Пока карточка была тремя
// строчками, это стоило недорого; с кнопками и их data-атрибутами две копии
// разойдутся при первой же правке — и разойдутся молча, потому что обе
// продолжат работать.
function doctorsSection(db, lang) {
  const all = publishedDoctors(db);
  if (!all.length) return null;
  const cards = all.slice(0, DOCTORS_LIMIT).map((d) => doctorCard(lang, d)).filter(Boolean).join('');
  if (!cards) return null;
  return {
    title: t(lang, 'section.doctors'),
    body: `<div class="grid-4">${cards}</div>`,
    actions: `<div class="section-actions"><a class="btn btn-ghost" href="/${lang}/doctors">${
      esc(t(lang, 'cta.all_doctors'))}</a></div>`,
  };
}

function departmentsSection(db, lang) {
  const all = publishedDepartments(db);
  if (!all.length) return null;
  // DEPT_COMPACT_V1 — плитка, а не карточка-коробка.
  //
  // У всех четырнадцати отделений short_desc пуст, поэтому «карточка» была
  // коробкой с 24px полей вокруг одного слова. На телефоне это четырнадцать
  // блоков в одну колонку — экран за экраном пролистывания ради списка, который
  // целиком помещается в две колонки. Описание появится — плитка сама станет
  // выше и покажет его; пока его нет, незачем занимать место пустотой.
  // DEPT_ICONS_V1 — иконка слева и шеврон справа.
  //
  // Плитка с одним словом внутри рамки не читается как направление — она
  // читается как строка таблицы. Иконка даёт узнавание раньше чтения, шеврон
  // говорит, что сюда можно нажать. Ни то, ни другое не требует от клиники
  // ничего заполнять: иконка берётся по slug, и блок перестаёт выглядеть
  // пустым, даже пока short_desc не заполнен ни у одного отделения.
  //
  // Первая плитка выделена: в списке из двенадцати одинаковых прямоугольников
  // взгляду не за что зацепиться, и порядок (sort_order) перестаёт что-либо
  // значить. Выделяем ту, которую клиника сама поставила первой.
  const cards = all
    .map((d, i) => {
      const c = pickContent(d.content, lang);
      if (!c.name) return '';
      return `<a class="dept-tile${i === 0 ? ' dept-tile--lead' : ''}" href="/${lang}/departments/${esc(encodeURIComponent(d.slug))}">
<span class="dept-tile__ico" aria-hidden="true">${deptIcon(d.slug)}</span>
<span class="dept-tile__text">
<span class="dept-tile__name">${esc(c.name)}</span>
${c.short_desc ? `<span class="dept-tile__desc">${esc(c.short_desc)}</span>` : ''}
</span>
<span class="dept-tile__go" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
</a>`;
    })
    .filter(Boolean)
    .join('');
  if (!cards) return null;
  return {
    title: t(lang, 'section.departments'),
    body: `<div class="dept-grid">${cards}</div>`,
    // Ссылка на полный список — как у услуг и врачей выше: на главной блок
    // показывает направления, а отдельная страница рассказывает о каждом.
    actions: `<div class="section-actions"><a class="btn btn-ghost" href="/${lang}/departments">${
      esc(t(lang, 'cta.all_departments'))}</a></div>`,
  };
}

function testimonialsSection(db, lang) {
  const all = publishedTestimonials(db);
  if (!all.length) return null;
  const cards = all
    .map((r) => {
      const c = pickContent(r.content, lang);
      if (!c.text) return '';
      const rating = Math.max(0, Math.min(5, Math.round(Number(r.rating) || 0)));
      // Звёзды — цифры в aria-label, а не слова: переводить «5 из 5» нечем,
      // а «5/5» одинаково читается на всех трёх языках.
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
  if (!cards) return null;
  return { title: t(lang, 'section.testimonials'), body: `<div class="grid-3">${cards}</div>` };
}

function faqSection(db, lang) {
  const all = publishedFaq(db);
  if (!all.length) return null;
  const items = all
    .map((f) => {
      const c = pickContent(f.content, lang);
      if (!c.q) return '';
      return `<details class="faq-item">
<summary>${esc(c.q)}</summary>
<div class="faq-item__body"><p>${esc(c.a || '')}</p></div>
</details>`;
    })
    .filter(Boolean)
    .join('');
  if (!items) return null;
  return { title: t(lang, 'section.faq'), body: `<div class="home-faq">${items}</div>` };
}

// CONTACT_HOME_V1 — контакты на главной = та же карточка, что на /contact.
//
// Раньше здесь был свой список: телефон ссылкой, адрес, e-mail и «как
// добраться» — четыре строки подряд без подписей. На /contact к тому времени
// уже стояла карточка с иконками и подписанными полями, и два разных вида
// одного и того же блока расходились бы дальше с каждой правкой.
//
// Поэтому берём contactCard из static-pages.js как есть, а не повторяем его
// разметку: карточка сама не рисует пустые поля, так что на нынешних данных
// (заполнен только телефон) выходит короткая честная карточка, а не пять
// подписей над пустотой.
//
// Карта и кнопки под ней собраны теми же кусками, что и на /contact:
// .contact-side → .home-map + действия. Одинаковый блок в двух местах обязан
// быть одним кодом.
function contactSection(db, lang, settings) {
  const phone = String(settings.contact?.phone || '').trim();
  const address = pickText(settings.contact?.address, lang);
  const email = String(settings.contact?.email || '').trim();
  const telegram = String(settings.social?.telegram || '').trim();
  const mapUrl = String(settings.contact?.map_url || '').trim();
  const taxiUrl = String(settings.contact?.taxi_url || '').trim();

  const card = contactCard(lang, {
    phone, telegram, address, email, hours: hoursSummary(lang, clinicHours(db)),
  });

  // ЕДИНСТВЕННАЯ намеренно неэкранированная вставка на странице: map_embed —
  // это <iframe> карты, который администратор вставляет целиком, экранирование
  // превратило бы его в текст. Источник доверенный (website_settings пишет
  // только админка ЕРП), а размеры держит обёртка .home-map с overflow:hidden,
  // так что чужая разметка вёрстку не сломает.
  const embed = typeof settings.contact?.map_embed === 'string' && settings.contact.map_embed.trim()
    ? `<div class="home-map contact-map">${settings.contact.map_embed}</div>`
    : '';

  // Кнопки под картой. Каждая рисуется, только если её адрес задан: кнопка
  // «Вызвать такси», ведущая в никуда, хуже её отсутствия.
  const actions = [
    mapUrl ? `<a class="btn btn-ghost" href="${esc(mapUrl)}" rel="noopener noreferrer" target="_blank">${
      esc(t(lang, 'cta.directions'))}</a>` : '',
    taxiUrl ? `<a class="btn btn-taxi" href="${esc(taxiUrl)}" rel="noopener noreferrer" target="_blank">${
      esc(t(lang, 'cta.taxi'))}</a>` : '',
  ].filter(Boolean).join('');
  const side = embed || actions
    ? `<div class="contact-side">${embed}${actions ? `<div class="contact-side__actions">${actions}</div>` : ''}</div>`
    : '';

  return {
    // id="contacts" — цель ссылки «Как добраться» из мобильной панели. Такой
    // же id есть у подвала (layout.js): браузер берёт первый в документе, то
    // есть эту секцию, — на главной это и нужно.
    id: 'contacts',
    title: t(lang, 'nav.contact'),
    body: `<div class="contact-grid${side ? '' : ' contact-grid--solo'}">${card}${side}</div>`,
  };
}

// SITE_MINIMAL_V1 — чередования фона через секцию БОЛЬШЕ НЕТ.
//
// Полосы решали задачу «отделить секции друг от друга», но ценой того, что
// страница читалась как стопка серых лент, — а спокойный сайт отделяет секции
// воздухом и заголовком, а не заливкой. Фон остаётся инструментом, но
// точечным: им выделен только призыв к действию внизу (section--brand), и
// именно поэтому он там и работает.
//
// Второй аргумент (индекс) убран вместе с чередованием: он больше ни на что не
// влияет, а оставленный «на всякий случай» параметр — приглашение вернуть
// полосы обратно.
function renderSection(s) {
  return `<section class="section"${s.id ? ` id="${s.id}"` : ''}>
<div class="container">
<div class="section-head"><h2>${esc(s.title)}</h2></div>
${s.body}
${s.actions || ''}
</div>
</section>`;
}

export function renderHome(db, lang) {
  const settings = getSettings(db);
  const hero = pickContent(JSON.stringify(settings.hero ?? {}), lang);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const heroTitle = hero.title || clinicName;

  // HOME_MEDION_V1 — порядок страницы по образцу medion.uz: сначала «почему мы»
  // (сразу под геро), затем НАПРАВЛЕНИЯ, врачи и только потом отдельные услуги.
  // Прежний порядок начинался с прайс-листа услуг — это разговор о деньгах с
  // человеком, который ещё не понял, туда ли он попал. Направления отвечают на
  // «лечите ли вы моё», врачи — «кому я доверюсь», и лишь затем цены.
  const sections = [
    departmentsSection(db, lang),
    doctorsSection(db, lang),
    servicesSection(db, lang),
    testimonialsSection(db, lang),
    faqSection(db, lang),
    contactSection(db, lang, settings),
  ].filter(Boolean);

  const body = [
    heroSection(lang, settings, hero),
    ...sections.map(renderSection),
  ].join('\n');

  // Заголовок вкладки: «Здоровье — Клиника». Если герой не заполнен, он равен
  // названию клиники — дублировать его через тире незачем.
  const title = heroTitle === clinicName ? heroTitle : `${heroTitle} — ${clinicName}`;
  // Описание: подзаголовок героя, затем ручное seo.description, и лишь потом
  // сборка из словаря — новых захардкоженных строк на странице не заводим.
  const description = hero.subtitle
    || pickText(settings.seo?.description, lang)
    || `${clinicName} — ${t(lang, 'section.services')}, ${t(lang, 'section.doctors')}, ${t(lang, 'nav.appointment')}.`;

  // MedicalOrganization JSON-LD — только на главной: это точка входа, а не
  // каждая страница сайта (карточки врача/услуги несут собственные типы).
  const jsonLd = orgJsonLd(db, lang);

  return page({ db, lang, path: `/${lang}/`, title, description, body, jsonLd, pageType: 'home' });
}
