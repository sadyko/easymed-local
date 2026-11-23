// WEBSITE_V1 — страница записи на приём и страница «Спасибо» после отправки.
// Форма шлёт обычный POST на /api/requests (задача 10) — работает без JS;
// site.js прогрессивно улучшает её до fetch + инлайн-сообщение об успехе.
//
// ЭКРАНИРОВАНИЕ: page() вставляет body КАК ЕСТЬ (см. заголовок layout.js) —
// каждое значение из БД здесь обязано пройти через esc().
import { page, esc } from './layout.js';
import { t, pickContent } from '../i18n.js';
import { getSettings, publishedServices, publishedDoctors } from '../content.js';

const TIME_KEYS = ['morning', 'afternoon', 'evening'];

// Скрытые поля формы — тот же набор и тот же смысл, что и hiddenFields() в
// static-pages.js (задача 9): та функция там не экспортируется, поэтому
// копия здесь, как и в остальных страницах сайта (см. комментарий там же).
// ts — эпоха в мс на момент рендера страницы (не отправки формы) —
// requests.js/rate-limit.js используют её против спама.
function hiddenFields(lang, path, type, ts) {
  return `<input type="hidden" name="type" value="${esc(type)}">
<input type="hidden" name="lang" value="${esc(lang)}">
<input type="hidden" name="page" value="${esc(path)}">
<input type="hidden" name="ts" value="${ts}">
<input name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">`;
}

// ?service=slug и ?doctor=slug предзаполняют выбор (ссылки «Записаться» на
// карточках услуги/врача); ?department= и любые другие параметры тихо
// игнорируются — это не ошибка, а просто данные, до которых форме нет дела.
export function renderAppointment(db, lang, query) {
  const q = query && typeof query === 'object' ? query : {};
  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const path = `/${lang}/appointment`;
  const ts = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  const svcSlug = String(q.service || '');
  const docSlug = String(q.doctor || '');

  const serviceOptions = publishedServices(db)
    .map((s) => {
      const c = pickContent(s.content, lang);
      if (!c.name) return '';
      const selected = svcSlug && s.slug === svcSlug ? ' selected' : '';
      return `<option value="${esc(s.slug)}"${selected}>${esc(c.name)}</option>`;
    })
    .filter(Boolean)
    .join('');

  const doctorOptions = publishedDoctors(db)
    .map((d) => {
      const c = pickContent(d.content, lang);
      if (!c.name) return '';
      const selected = docSlug && d.slug === docSlug ? ' selected' : '';
      return `<option value="${esc(d.slug)}"${selected}>${esc(c.name)}</option>`;
    })
    .filter(Boolean)
    .join('');

  const timeRadios = TIME_KEYS.map((k) => `<label class="appt-radio">
<input type="radio" name="preferred_time" value="${k}">
<span>${esc(t(lang, `form.${k}`))}</span>
</label>`).join('');

  const body = `<section class="section appt-hero">
<div class="container appt-hero__inner">
<h1>${esc(t(lang, 'nav.appointment'))}</h1>
</div>
</section>
<section class="section">
<div class="container appt-wrap">
<form class="appt-form js-request-form" action="/api/requests" method="post"
  data-success-title="${esc(t(lang, 'form.sent_title'))}"
  data-success-text="${esc(t(lang, 'form.sent_text'))}"
  data-error-text="${esc(t(lang, 'form.error'))}">
${hiddenFields(lang, path, 'appointment', ts)}
<div class="form-field">
<label class="form-field__label" for="appt-service">${esc(t(lang, 'form.service'))}</label>
<select id="appt-service" name="service">
<option value="">${esc(t(lang, 'form.service'))}</option>
${serviceOptions}
</select>
</div>
<div class="form-field">
<label class="form-field__label" for="appt-doctor">${esc(t(lang, 'form.doctor'))}</label>
<select id="appt-doctor" name="doctor">
<option value="">${esc(t(lang, 'form.any_doctor'))}</option>
${doctorOptions}
</select>
</div>
<div class="form-row">
<div class="form-field">
<label class="form-field__label" for="appt-date">${esc(t(lang, 'form.date'))}</label>
<input id="appt-date" name="preferred_date" type="date" min="${esc(today)}">
</div>
<div class="form-field">
<span class="form-field__label">${esc(t(lang, 'form.time'))}</span>
<div class="appt-radios">${timeRadios}</div>
</div>
</div>
<div class="form-field">
<label class="form-field__label" for="appt-name">${esc(t(lang, 'form.name'))}<span class="form-field__req">*</span></label>
<input id="appt-name" name="full_name" type="text" autocomplete="name" required>
</div>
<div class="form-field">
<label class="form-field__label" for="appt-phone">${esc(t(lang, 'form.phone'))}<span class="form-field__req">*</span></label>
<input id="appt-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required>
</div>
<div class="form-field">
<label class="form-field__label" for="appt-message">${esc(t(lang, 'form.message'))}</label>
<textarea id="appt-message" name="message"></textarea>
</div>
<button class="btn btn-primary btn-block btn-lg" type="submit">${esc(t(lang, 'form.submit'))}</button>
</form>
</div>
</section>`;

  const title = `${t(lang, 'nav.appointment')} — ${clinicName}`;
  const description = `${clinicName} — ${t(lang, 'nav.appointment')}.`;
  return page({ db, lang, path, title, description, body, pageType: 'appointment' });
}

export function renderThanks(db, lang) {
  const settings = getSettings(db);
  const clinicName = settings.clinic_name || 'EasyMed Light';
  const path = `/${lang}/appointment/thanks`;

  const body = `<section class="section appt-thanks">
<div class="container appt-thanks__inner">
<h1>${esc(t(lang, 'form.sent_title'))}</h1>
<p>${esc(t(lang, 'form.sent_text'))}</p>
<div class="appt-thanks__actions">
<a class="btn btn-primary btn-lg" href="/${lang}/">${esc(t(lang, 'nav.home'))}</a>
</div>
</div>
</section>`;

  return page({
    db, lang, path,
    title: `${t(lang, 'form.sent_title')} — ${clinicName}`,
    description: t(lang, 'form.sent_text'),
    body,
    noindex: true,
    pageType: 'appointment',
  });
}
