// WEBSITE_V1 — список врачей и карточка врача. Список — витрина в духе
// главной (см. home.js: doctorsSection), но со ВСЕМИ опубликованными
// врачами, а не первыми DOCTORS_LIMIT. Карточка — hero-блок + разделы
// био/образование/специализация, каждый только когда есть контент на
// выбранном языке (pickContent уже подмешивает фолбэк с других языков).
//
// ЭКРАНИРОВАНИЕ: page() вставляет body КАК ЕСТЬ (см. заголовок layout.js) —
// каждое значение из БД здесь обязано пройти через esc().
import { page, esc } from './layout.js';
import { t, pickContent } from '../i18n.js';
import { getSettings, publishedDoctors, doctorBySlug } from '../content.js';
import { mediaUrl, doctorAvatar, doctorCard, doctorSubject } from './helpers.js';
import { absUrl } from '../seo.js';

// Свободный текст языков через запятую/точку с запятой («ru, uz, en») —
// формат не регламентирован схемой (langs_spoken TEXT), поэтому разбираем
// максимально терпимо и молча пропускаем пустое.
function splitLangs(s) {
  return String(s || '').split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
}

// DOC_FILTER_V1 — фильтр по специальности и поиск по имени.
//
// Двадцать карточек в четыре колонки — это уже не витрина, а список, в котором
// ищут конкретного человека или конкретное направление. Устроено ТАК ЖЕ, как
// фильтр услуг (services.js/filterBar): те же классы .svc-filter*, та же пара
// «чипы + строка поиска», тот же контракт data-search. Вторая своя раскладка
// для того же действия означала бы, что посетитель учится сайту дважды.
//
// Работает БЕЗ JS: чипы — обычные ссылки с ?spec=, строка поиска — обычная
// форма с method=get. Скрипт (public/site/doctors.js) лишь убирает перезагрузку.
function doctorFilterBar(lang, specs, q, spec) {
  const href = (sp) => {
    const parts = [];
    if (sp) parts.push('spec=' + encodeURIComponent(sp));
    if (q) parts.push('q=' + encodeURIComponent(q));
    return `/${lang}/doctors${parts.length ? '?' + parts.join('&') : ''}`;
  };
  const chip = (value, label, count) => `<a class="svc-chip${
    value === spec ? ' is-current' : ''}" href="${esc(href(value))}" data-spec="${esc(value)}"${
    value === spec ? ' aria-current="true"' : ''}>${esc(label)}${
    count ? ` <span class="svc-chip__n">${count}</span>` : ''}</a>`;

  const chips = [chip('', t(lang, 'search.all'), 0)]
    .concat(specs.map((sp) => chip(sp.value, sp.label, sp.total)))
    .join('');

  return `<form class="svc-filter" method="get" action="/${lang}/doctors" role="search" data-doc-filter>
${spec ? `<input type="hidden" name="spec" value="${esc(spec)}">` : ''}
<div class="svc-filter__search">
<input class="svc-filter__input" type="search" name="q" value="${esc(q)}" autocomplete="off"
  placeholder="${esc(t(lang, 'search.placeholder_doctors'))}" aria-label="${esc(t(lang, 'search.placeholder_doctors'))}">
<button class="btn btn-primary svc-filter__go" type="submit">${esc(t(lang, 'search.submit'))}</button>
</div>
<div class="svc-filter__groups">${chips}</div>
</form>`;
}

export function renderDoctors(db, lang, query) {
  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';

  const qRaw = typeof (query && query.q) === 'string' ? query.q.trim() : '';
  const q = qRaw.slice(0, 80);
  const qLower = q.toLowerCase();
  const spec = typeof (query && query.spec) === 'string' ? query.spec.trim() : '';

  // Специальности собираем ИЗ САМИХ КАРТОЧЕК на выбранном языке: отдельного
  // справочника у сайта нет, а писать его ради фильтра значило бы завести
  // второй источник правды, который разойдётся с карточками.
  const all = publishedDoctors(db);
  const bySpec = new Map();
  for (const d of all) {
    const c = pickContent(d.content, lang);
    if (!c.name) continue;
    const sp = String(c.specialty || '').trim();
    if (!sp) continue;   // врач без специальности в чипы не попадает — подписать нечем
    if (!bySpec.has(sp)) bySpec.set(sp, 0);
    bySpec.set(sp, bySpec.get(sp) + 1);
  }
  const specs = [...bySpec.entries()]
    .map(([label, total]) => ({ value: label, label, total }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, 'ru'));

  const shown = [];
  for (const d of all) {
    const c = pickContent(d.content, lang);
    if (!c.name) continue;
    const sp = String(c.specialty || '').trim();
    if (spec && sp !== spec) continue;
    // Ищем по имени И специальности: посетитель набирает то «Алиев», то «лор».
    const hay = (c.name + ' ' + sp).toLowerCase();
    if (qLower && !hay.includes(qLower)) continue;
    shown.push({ d, hay, sp });
  }

  const cards = shown
    .map(({ d, hay, sp }) => {
      const card = doctorCard(lang, d);
      if (!card) return '';
      // data-search/data-spec — контракт для скрипта, тот же, что у услуг.
      return card.replace('<div class="doctor-card"',
        `<div class="doctor-card" data-search="${esc(hay)}" data-spec="${esc(sp)}"`);
    })
    .filter(Boolean)
    .join('');

  // Пустой результат обязан объяснять, ПОЧЕМУ пусто, и давать выход: иначе
  // человек решает, что сайт сломался, и уходит.
  const none = `<p class="svc-none" data-doc-none${cards ? ' hidden' : ''}>${esc(t(lang, 'search.nothing'))}
<a class="svc-none__reset" href="/${lang}/doctors">${esc(t(lang, 'search.reset'))}</a></p>`;

  const body = `<section class="section docs-list">
<div class="container">
<div class="section-head"><h1>${esc(t(lang, 'section.doctors'))}</h1></div>
${doctorFilterBar(lang, specs, q, spec)}
<div class="grid-4" data-doc-grid>${cards}</div>
${none}
</div>
</section>`;
  const title = `${t(lang, 'section.doctors')} — ${clinicName}`;
  const description = `${clinicName} — ${t(lang, 'section.doctors')}.`;
  return page({ db, lang, path: `/${lang}/doctors`, title, description, body, pageType: 'doctors' });
}

// null → страница не найдена (нет такого слага, не опубликован, или на
// выбранном/фолбэк-языке вообще нет имени) — вызывающий код (app.js)
// отвечает фирменной страницей 404.
export function renderDoctor(db, lang, slug) {
  const d = doctorBySlug(db, slug);
  if (!d) return null;
  const c = pickContent(d.content, lang);
  if (!c.name) return null;

  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const baseUrl = typeof settings.seo?.base_url === 'string' ? settings.seo.base_url.trim() : '';

  const photo = mediaUrl(d.photo_path);
  const years = Number(d.experience_years);
  const langs = splitLangs(d.langs_spoken)
    .map((l) => `<span class="badge badge--outline">${esc(l)}</span>`).join('');
  const media = photo
    ? `<img src="${esc(photo)}" alt="${esc(c.name)}" loading="lazy" width="480" height="480">`
    : doctorAvatar('doc-hero__avatar');
  const bookHref = `/${lang}/appointment?doctor=${encodeURIComponent(d.slug)}`;

  const details = [
    c.bio ? `<div class="doc-section"><p>${esc(c.bio)}</p></div>` : '',
    c.education ? `<div class="doc-section"><p>${esc(c.education)}</p></div>` : '',
    c.focus ? `<div class="doc-section"><p>${esc(c.focus)}</p></div>` : '',
  ].filter(Boolean).join('');

  const body = `<section class="section doc-hero">
<div class="container doc-hero__inner">
<div class="doc-hero__photo">${media}</div>
<div class="doc-hero__body">
<h1 class="doc-hero__name">${esc(c.name)}</h1>
${c.specialty ? `<p class="doc-hero__specialty">${esc(c.specialty)}</p>` : ''}
${Number.isFinite(years) && years > 0
    ? `<div class="doc-hero__meta"><span>${years} ${esc(t(lang, 'years_exp'))}</span></div>` : ''}
${langs ? `<div class="doc-hero__langs">${langs}</div>` : ''}
<a class="btn btn-primary btn-lg" href="${esc(bookHref)}"
  data-qr-open data-doctor="${esc(d.slug)}" data-subject="${esc(doctorSubject(lang, c, years))}">${esc(t(lang, 'cta.book'))}</a>
</div>
</div>
${details ? `<div class="container doc-details">${details}</div>` : ''}
</section>`;

  // Physician JSON-LD — временно инлайнится здесь напрямую через page({jsonLd}):
  // задача 11 ничего не меняет в этом файле, слой уже готов принять параметр.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Physician',
    name: c.name,
    url: absUrl(baseUrl, `/${lang}/doctors/${encodeURIComponent(d.slug)}`),
  };
  if (c.specialty) jsonLd.medicalSpecialty = c.specialty;
  if (photo) jsonLd.image = photo;

  const title = `${c.name} — ${clinicName}`;
  const description = c.specialty ? `${c.name} — ${c.specialty}. ${clinicName}.` : `${c.name} — ${clinicName}.`;

  return page({
    db, lang, path: `/${lang}/doctors/${encodeURIComponent(d.slug)}`,
    title, description, body, jsonLd, pageType: 'doctor',
  });
}
