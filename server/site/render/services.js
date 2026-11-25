// WEBSITE_V1 — список услуг и карточка услуги. Список группирует опубликованные
// услуги по их опубликованному отделению (по department_id из services, а не
// по слагу): услуги без такого отделения (не привязаны или отделение снято
// с публикации) уходят в хвостовую группу "прочие услуги", чтобы ни одна
// опубликованная услуга не терялась молча.
//
// ЭКРАНИРОВАНИЕ: page() вставляет body КАК ЕСТЬ (см. заголовок layout.js) —
// каждое значение из БД здесь обязано пройти через esc().
import { page, esc } from './layout.js';
import { t, pickContent } from '../i18n.js';
import { getSettings, publishedServices, serviceBySlug, publishedDepartments } from '../content.js';
import { money } from './helpers.js';
import { absUrl } from '../seo.js';

// WEBSITE_SERVICES_LIST_V1 — в общем списке услуга идёт СТРОКОЙ.
//
// Плитки в три колонки рассчитаны на витрину из шести позиций. В каталоге
// их сотни, и внутри одной группы набирается двадцать «Гинекологических
// операций тип N», отличающихся только цифрой и ценой. Разницу между
// ними видно только тогда, когда цены стоят в одном столбце одна под другой,
// а не разбросаны по сетке.
//
// Эта разметка ЕДИНСТВЕННАЯ на все места, где показывают услугу: каталог, главная,
// страница отделения. Плитка serviceCard удалена — вторая вёрстка того же
// объекта расходится с первой при первой же правке, причём молча.
// SERVICES_FILTER_V1 — по чему ищет живой поиск.
//
// Имя ПЛЮС короткое описание: человек ищет «кровь», а услуга называется
// «ОАК» — без описания он её не найдёт. Нижний регистр считается ЗДЕСЬ, один
// раз на рендер, а не в браузере на каждую букву по семистам строкам.
function haystack(c) {
  return `${c.name || ''} ${c.short_desc || ''}`.toLowerCase();
}

export function serviceRow(lang, s) {
  const c = pickContent(s.content, lang);
  if (!c.name) return '';
  // Длительности в списке НЕТ намеренно. В базе она почти везде равна
  // дефолтным тридцати минутам — это слот расписания, а не обещание
  // пациенту. Повторённый семьсот раз один и тот же «30 мин» ничего не
  // различает и только шумит. На странице самой услуги она осталась.
  const price = money(s.price, lang);
  const slug = esc(encodeURIComponent(s.slug));
  // Строка больше не ссылка целиком: внутри <a> нельзя вложить вторую
  // ссылку — браузер разорвёт такую вёрстку и кнопка окажется СНАРУЖИ строки.
  // Поэтому кликабельны две вещи по отдельности: название ведёт к описанию
  // услуги, кнопка — сразу на заявку С ЭТОЙ услугой (?service=), чтобы человеку
  // не пришлось искать её в списке второй раз.
  //
  // aria-label с названием обязателен: семьсот кнопок с одним и тем же
  // текстом в списке ссылок скринридера неразличимы.
  return `<div class="svc-row" data-search="${esc(haystack(c))}">
<a class="svc-row__link" href="/${lang}/services/${slug}">
<span class="svc-row__name">${esc(c.name)}</span>
${c.short_desc ? `<span class="svc-row__desc">${esc(c.short_desc)}</span>` : ''}
</a>
${price ? `<span class="svc-row__price">${esc(t(lang, 'price.from'))} ${esc(price)}</span>` : ''}
<a class="btn btn-primary svc-row__cta" href="/${lang}/appointment?service=${slug}"
  data-qr-open data-service="${slug}" data-subject="${esc(c.name)}" aria-label="${
  esc(t(lang, 'cta.request'))} — ${esc(c.name)}">${esc(t(lang, 'cta.request'))}</a>
</div>`;
}

// SERVICES_FILTER_V1 — фильтр по группе и поиск по каталогу.
//
// Фильтрует СЕРВЕР, а не только браузер: ?q= и ?group= в адресе значат, что
// найденное можно прислать ссылкой, открыть с выключенным JS и что кнопка
// «Найти» работает сама по себе. Живой поиск по мере ввода — надстройка
// сверху (site.js), и её отсутствие ничего не ломает.
//
// Чипсы групп строятся по ПОЛНОМУ списку, а не по отфильтрованному: иначе,
// выбрав одну группу, человек потерял бы остальные и не смог переключиться.
export function renderServices(db, lang, query) {
  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const services = publishedServices(db);
  const departments = publishedDepartments(db);

  const qRaw = typeof (query && query.q) === 'string' ? query.q.trim() : '';
  const q = qRaw.slice(0, 80);                  // длиннее не ищут, а в <title> это попадает
  const qLower = q.toLowerCase();
  const group = typeof (query && query.group) === 'string' ? query.group.trim() : '';

  // Группы заводим только под отделения, у которых есть имя на выбранном
  // (с фолбэком) языке — иначе подписать секцию нечем, и её услуги уходят
  // в "прочие услуги" вместе с услугами без отделения вовсе.
  const deptGroupByDeptId = new Map();
  for (const d of departments) {
    const c = pickContent(d.content, lang);
    if (c.name) deptGroupByDeptId.set(d.department_id, { slug: d.slug, title: c.name, rows: [], total: 0 });
  }
  const other = { slug: 'other', title: t(lang, 'section.other_services'), rows: [], total: 0 };

  for (const s of services) {
    const c = pickContent(s.content, lang);
    if (!c.name) continue;
    const target = deptGroupByDeptId.get(s.department_id) || other;
    target.total += 1;                          // для чипсов: сколько ВСЕГО в группе
    if (group && target.slug !== group) continue;
    if (qLower && !haystack(c).includes(qLower)) continue;
    const row = serviceRow(lang, s);
    if (row) target.rows.push(row);
  }

  // Порядок секций = порядок отделений (уже отсортирован в content.js по
  // sort_order/id); "прочие услуги" — всегда последней группой.
  const all = [];
  for (const d of departments) {
    const g = deptGroupByDeptId.get(d.department_id);
    if (g && g.total) all.push(g);
  }
  if (other.total) all.push(other);

  const shown = all.filter((g) => g.rows.length);
  const filtering = !!(q || group);

  let listBody;
  if (!services.length) {
    listBody = `<p class="svc-empty">${esc(t(lang, 'empty.services'))}</p>`;
  } else {
    listBody = shown.map((g) => `<div class="svc-group" data-group="${esc(g.slug)}">
<h2 class="svc-group__title">${esc(g.title)}</h2>
<div class="svc-rows">${g.rows.join('')}</div>
</div>`).join('');
  }

  // Пустота обязана говорить, ПОЧЕМУ она пуста: «услуги скоро появятся» и
  // «по запросу ничего не найдено» — разные сообщения; первое на месте
  // второго читается как «сайт сломался». Блок рендерится ВСЕГДА и прячется
  // hidden — живому поиску нужно его показать, не ходя на сервер.
  const noneHidden = shown.length ? ' hidden' : '';
  const none = services.length
    ? `<p class="svc-none" data-svc-none${noneHidden}>${esc(t(lang, 'search.nothing'))}
<a class="svc-none__reset" href="/${lang}/services">${esc(t(lang, 'search.reset'))}</a></p>`
    : '';

  const body = `<section class="section svc-list">
<div class="container">
<div class="section-head"><h1>${esc(t(lang, 'section.services'))}</h1></div>
${services.length ? filterBar(lang, all, q, group) : ''}
${listBody}
${none}
</div>
</section>`;

  const base = t(lang, 'section.services');
  const title = q ? `${base}: ${q} — ${clinicName}` : `${base} — ${clinicName}`;
  const description = `${clinicName} — ${base}.`;
  return page({ db, lang, path: `/${lang}/services`, title, description, body, pageType: 'services' });
}

// SERVICES_FILTER_V1 — панель над списком: поле поиска и чипсы групп.
//
// Это настоящая <form method="get">: без JS кнопка «Найти» просто перезагружает
// страницу с ?q=. Группа едет скрытым полем, чтобы поиск не сбрасывал выбранную
// группу, а чипсы — ссылки, несущие текущий запрос с собой.
function filterBar(lang, groups, q, group) {
  const href = (g) => {
    const parts = [];
    if (g) parts.push('group=' + encodeURIComponent(g));
    if (q) parts.push('q=' + encodeURIComponent(q));
    return `/${lang}/services${parts.length ? '?' + parts.join('&') : ''}`;
  };
  const chip = (slug, label, count) => `<a class="svc-chip${
    slug === group ? ' is-current' : ''}" href="${esc(href(slug))}"${
    slug === group ? ' aria-current="true"' : ''}>${esc(label)}${
    count ? ` <span class="svc-chip__n">${count}</span>` : ''}</a>`;

  const chips = [chip('', t(lang, 'search.all'), 0)]
    .concat(groups.map((g) => chip(g.slug, g.title, g.total)))
    .join('');

  return `<form class="svc-filter" method="get" action="/${lang}/services" role="search" data-svc-filter>
${group ? `<input type="hidden" name="group" value="${esc(group)}">` : ''}
<div class="svc-filter__search">
<input class="svc-filter__input" type="search" name="q" value="${esc(q)}" autocomplete="off"
  placeholder="${esc(t(lang, 'search.placeholder'))}" aria-label="${esc(t(lang, 'search.placeholder'))}">
<button class="btn btn-primary svc-filter__go" type="submit">${esc(t(lang, 'search.submit'))}</button>
</div>
<div class="svc-filter__groups">${chips}</div>
</form>`;
}

// null → страница не найдена (нет такого слага, не опубликована, или на
// выбранном/фолбэк-языке вообще нет имени) — вызывающий код (app.js) отвечает
// фирменной страницей 404.
export function renderService(db, lang, slug) {
  const s = serviceBySlug(db, slug);
  if (!s) return null;
  const c = pickContent(s.content, lang);
  if (!c.name) return null;

  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const baseUrl = typeof settings.seo?.base_url === 'string' ? settings.seo.base_url.trim() : '';

  const price = money(s.price, lang);
  const minutes = Number(s.duration_minutes);
  const badges = [
    price ? `<span class="badge">${esc(t(lang, 'price.from'))} ${esc(price)}</span>` : '',
    Number.isFinite(minutes) && minutes > 0
      ? `<span class="badge badge--outline">${minutes} ${esc(t(lang, 'minutes'))}</span>` : '',
  ].filter(Boolean).join('');

  // Абзацы тела берём по пустой строке между ними — content.body хранится
  // простым текстом, а не HTML/markdown (см. схему website_services).
  const bodyParagraphs = c.body
    ? String(c.body).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
      .map((p) => `<p>${esc(p)}</p>`).join('')
    : '';

  const preparation = c.preparation
    ? `<div class="svc-section"><h2>${esc(t(lang, 'service.preparation'))}</h2><p>${esc(c.preparation)}</p></div>`
    : '';

  // Ссылка на отделение — только если у услуги вообще есть отделение (services.
  // department_id) И это отделение опубликовано с именем на нужном языке.
  const dept = s.department_id != null
    ? publishedDepartments(db).find((d) => d.department_id === s.department_id)
    : null;
  const deptName = dept ? pickContent(dept.content, lang).name : '';
  const deptLink = dept && deptName
    ? `<a class="btn btn-ghost" href="/${lang}/departments/${esc(encodeURIComponent(dept.slug))}">${esc(deptName)}</a>`
    : '';

  const bookHref = `/${lang}/appointment?service=${encodeURIComponent(s.slug)}`;

  const body = `<section class="section svc-hero">
<div class="container svc-hero__inner">
<h1>${esc(c.name)}</h1>
${badges ? `<div class="svc-hero__meta">${badges}</div>` : ''}
${c.short_desc ? `<p class="svc-hero__lead">${esc(c.short_desc)}</p>` : ''}
<div class="svc-hero__actions">
<a class="btn btn-primary btn-lg" href="${esc(bookHref)}">${esc(t(lang, 'cta.book'))}</a>
${deptLink}
</div>
</div>
${bodyParagraphs || preparation ? `<div class="container svc-details">
${bodyParagraphs}
${preparation}
</div>` : ''}
</section>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'MedicalProcedure',
    name: c.name,
    url: absUrl(baseUrl, `/${lang}/services/${encodeURIComponent(s.slug)}`),
  };
  if (c.short_desc) jsonLd.description = c.short_desc;

  const title = `${c.name} — ${clinicName}`;
  const description = c.short_desc ? `${c.name} — ${c.short_desc}. ${clinicName}.` : `${c.name} — ${clinicName}.`;

  return page({
    db, lang, path: `/${lang}/services/${encodeURIComponent(s.slug)}`,
    title, description, body, jsonLd, pageType: 'service',
  });
}
