// WEBSITE_V1 — список отделений и карточка отделения. Карточка отделения
// показывает описание, затем опубликованных врачей отделения (те же users,
// у кого department_id указывает на departments.id этого отделения) и
// опубликованные услуги отделения (services.department_id) — обе выборки
// уже отфильтрованы по published в content.js.
//
// ЭКРАНИРОВАНИЕ: page() вставляет body КАК ЕСТЬ (см. заголовок layout.js) —
// каждое значение из БД здесь обязано пройти через esc().
import { page, esc } from './layout.js';
import { t, pickContent } from '../i18n.js';
import {
  getSettings, publishedDepartments, departmentBySlug, departmentDoctors, departmentServices,
} from '../content.js';
import { mediaUrl, doctorCard } from './helpers.js';
import { serviceRow } from './services.js';
import { deptIcon } from './dept-icons.js';   // DEPT_ICONS_V1

// DEPT_LIST_ROWS_V1 — страница отделений как список строк, той же плиткой,
// что и блок направлений на главной (DEPT_COMPACT_V1): у отделений нет ни
// фото, ни описаний, и сетка «карточек» из четырнадцати пустых градиентных
// прямоугольников не сообщала ничего. Строка иконка+название+шеврон читается
// как оглавление и честна к реально заполненным данным.
function departmentRow(lang, d) {
  const c = pickContent(d.content, lang);
  if (!c.name) return '';
  return `<a class="dept-tile" href="/${lang}/departments/${esc(encodeURIComponent(d.slug))}">
<span class="dept-tile__ico" aria-hidden="true">${deptIcon(d.slug)}</span>
<span class="dept-tile__text">
<span class="dept-tile__name">${esc(c.name)}</span>
${c.short_desc || c.description ? `<span class="dept-tile__desc">${esc(c.short_desc || c.description)}</span>` : ''}
</span>
<span class="dept-tile__go" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
</a>`;
}

export function renderDepartments(db, lang) {
  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const rows = publishedDepartments(db).map((d) => departmentRow(lang, d)).filter(Boolean).join('');
  const body = `<section class="section dept-list">
<div class="container">
<div class="section-head"><h1>${esc(t(lang, 'section.departments'))}</h1></div>
${rows ? `<div class="dept-rows">${rows}</div>` : `<p class="dept-empty">${esc(t(lang, 'empty.departments'))}</p>`}
</div>
</section>`;
  const title = `${t(lang, 'section.departments')} — ${clinicName}`;
  const description = `${clinicName} — ${t(lang, 'section.departments')}.`;
  return page({ db, lang, path: `/${lang}/departments`, title, description, body, pageType: 'departments' });
}

// null → страница не найдена (нет такого слага, не опубликовано, или на
// выбранном/фолбэк-языке вообще нет имени) — вызывающий код (app.js) отвечает
// фирменной страницей 404.
export function renderDepartment(db, lang, slug) {
  const d = departmentBySlug(db, slug);
  if (!d) return null;
  const c = pickContent(d.content, lang);
  if (!c.name) return null;

  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';

  const img = mediaUrl(d.image_path);
  const media = img
    ? `<div class="dept-hero__photo"><img src="${esc(img)}" alt="${esc(c.name)}" loading="lazy" width="960" height="480"></div>`
    : '';

  const doctorCards = departmentDoctors(db, d.department_id).map((doc) => doctorCard(lang, doc)).filter(Boolean).join('');
  const serviceRows = departmentServices(db, d.department_id).map((s) => serviceRow(lang, s)).filter(Boolean).join('');

  const bookHref = `/${lang}/appointment?department=${encodeURIComponent(d.slug)}`;

  const hero = `<section class="section dept-hero">
<div class="container dept-hero__inner">
${media}
<div class="dept-hero__body">
<h1>${esc(c.name)}</h1>
${c.description ? `<p class="dept-hero__lead">${esc(c.description)}</p>` : ''}
<a class="btn btn-primary btn-lg" href="${esc(bookHref)}">${esc(t(lang, 'cta.book'))}</a>
</div>
</div>
</section>`;

  const doctorsSection = doctorCards
    ? `<section class="section section--soft"><div class="container">
<div class="section-head"><h2>${esc(t(lang, 'section.doctors'))}</h2></div>
<div class="grid-4">${doctorCards}</div>
</div></section>`
    : '';

  const servicesSection = serviceRows
    ? `<section class="section"><div class="container">
<div class="section-head"><h2>${esc(t(lang, 'section.services'))}</h2></div>
<div class="svc-rows">${serviceRows}</div>
</div></section>`
    : '';

  const body = hero + doctorsSection + servicesSection;

  const title = `${c.name} — ${clinicName}`;
  const description = c.description ? `${c.name} — ${c.description}. ${clinicName}.` : `${c.name} — ${clinicName}.`;

  return page({ db, lang, path: `/${lang}/departments/${encodeURIComponent(d.slug)}`, title, description, body, pageType: 'department' });
}
