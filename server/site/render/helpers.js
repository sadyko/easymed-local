// WEBSITE_V1 — мелкие хелперы рендера, общие для нескольких страниц
// (главная, список/профиль врача, ...). Вынесены из home.js, чтобы каждая
// страница не заводила свою копию mediaUrl/инициалов/форматирования цены.
import { esc } from './layout.js';
import { t, pickContent } from '../i18n.js';

// Картинки сайта отдаёт GET /media (задача 12). Ведущие слэши срезаем, чтобы
// путь из БД не превратился в ссылку на чужой origin («//evil.tld/x.png»);
// путь с «..» или обратным слэшем не чиним, а выбрасываем — браузер свернул
// бы «/media/../x» в «/x» и утащил запрос мимо медиа-маршрута.
export function mediaUrl(p) {
  const clean = String(p || '').trim().replace(/^[/\\]+/, '');
  if (!clean || clean.includes('\\') || clean.split('/').includes('..')) return '';
  return '/media/' + clean;
}

// DOC_AVATAR_ICON_V1 — врач без фото получает нейтральную пиктограмму, а не
// инициалы. Буквы на месте фото читались как контент («ЖШ» — кто это?), а
// «мужская/женская» заглушка потребовала бы поле «пол», которого в схеме нет
// и ради заглушки не будет. Пиктограмма одна на всех: голова, плечи и крест
// на груди — в манере dept-icons.js (24×24, обводка currentColor), чтобы
// рисованные элементы сайта оставались одной рукой.
const DOCTOR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true" focusable="false">'
  + '<circle cx="12" cy="7.2" r="3.4"/>'
  + '<path d="M5.2 20.4a6.9 6.9 0 0 1 13.6 0"/>'
  + '<path d="M12 15.4v3.4M10.3 17.1h3.4"/></svg>';

// Фото у врача есть не всегда — спокойная пиктограмма выглядит лучше битой
// картинки. Сигнатура прежняя по месту вызова (класс решает размер/фон через
// site.css), имя больше не нужно и не принимается.
export function doctorAvatar(className = 'doctor-card__avatar') {
  return `<div class="${className}" aria-hidden="true">${DOCTOR_ICON}</div>`;
}

// 50000 → «50 000 сум». Валюта одна, поэтому подпись к числу — обычное слово
// словаря (price.currency), а не формат денег. Разряды разделяет неразрывный
// пробел: цена не должна переноситься по строке посреди числа.
export function money(price, lang) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return '';
  const grouped = String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  return `${grouped}\u00A0${t(lang, 'price.currency')}`;
}

// Свободный текст языков через запятую/точку с запятой («ru, uz, en») —
// формат не регламентирован схемой (langs_spoken TEXT), поэтому разбираем
// максимально терпимо и молча пропускаем пустое.
function splitLangs(s) {
  return String(s || '').split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
}

// QR_SUBJECT_DETAIL_V1 — подпись врача в окне заявки: имя, специальность и
// стаж, а не одно имя. Окно перекрывает карточку, с которой его открыли, и
// подтверждение «к кому именно записываюсь» должно быть в самом окне, а не
// под ним. Разделитель между числом и словом — неразрывный пробел, как во
// всех прочих местах со стажем (см. meta в doctorCard).
export function doctorSubject(lang, c, years) {
  const detail = [
    String(c.specialty || '').trim(),
    Number.isFinite(years) && years > 0 ? `${years} ${t(lang, 'years_exp')}` : '',
  ].filter(Boolean).join(' · ');
  return detail ? `${c.name} — ${detail}` : c.name;
}

// Карточка врача — общая вёрстка для списка врачей (doctors.js) и раздела
// «врачи отделения» (departments.js): один и тот же вид, разный источник
// строк (publishedDoctors vs departmentDoctors — обе выдают одинаковый набор
// колонок, см. content.js).
// DOCTOR_CARD_ACTIONS_V1 — карточка врача с двумя кнопками.
//
// Карточка БОЛЬШЕ НЕ ССЫЛКА ЦЕЛИКОМ. Внутри <a> нельзя вложить вторую ссылку:
// браузер закроет внешний тег сам и вытолкнет кнопки наружу карточки. Поэтому
// кликабельны три вещи по отдельности — фото с именем ведёт к профилю,
// «Подробнее» туда же явной кнопкой, «Оставить заявку» открывает окно заявки
// с подставленным врачом.
//
// Кнопка заявки — НАСТОЯЩАЯ ссылка на /appointment?doctor=…: без JS она просто
// откроет полную страницу, как и раньше. data-qr-open перехватывает клик и
// показывает окно (public/site/site.js, QUICK_REQUEST_V1).
//
// aria-label с именем обязателен: два десятка кнопок с одним и тем же текстом
// в списке ссылок скринридера неразличимы.
export function doctorCard(lang, d) {
  const c = pickContent(d.content, lang);
  if (!c.name) return '';
  const slug = esc(encodeURIComponent(d.slug));
  const photo = mediaUrl(d.photo_path);
  const years = Number(d.experience_years);
  const media = photo
    ? `<img src="${esc(photo)}" alt="${esc(c.name)}" loading="lazy" width="480" height="360">`
    : doctorAvatar();
  const langs = splitLangs(d.langs_spoken)
    .map((l) => `<span class="badge badge--outline">${esc(l)}</span>`).join('');
  const meta = [
    Number.isFinite(years) && years > 0
      ? `<span>${years}\u00A0${esc(t(lang, 'years_exp'))}</span>` : '',
    langs,
  ].filter(Boolean).join('');
  return `<div class="doctor-card">
<a class="doctor-card__link" href="/${lang}/doctors/${slug}">
<span class="doctor-card__photo">${media}</span>
<span class="doctor-card__body">
<span class="doctor-card__name">${esc(c.name)}</span>
${c.specialty ? `<span class="doctor-card__specialty">${esc(c.specialty)}</span>` : ''}
${meta ? `<span class="doctor-card__meta">${meta}</span>` : ''}
</span>
</a>
<div class="doctor-card__actions">
<a class="btn btn-ghost doctor-card__btn" href="/${lang}/doctors/${slug}">${
  esc(t(lang, 'cta.learn_more'))}</a>
<a class="btn btn-primary doctor-card__btn" href="/${lang}/appointment?doctor=${slug}"
  data-qr-open data-doctor="${slug}" data-subject="${esc(doctorSubject(lang, c, years))}" aria-label="${
  esc(t(lang, 'cta.request'))} \u2014 ${esc(c.name)}">${esc(t(lang, 'cta.request'))}</a>
</div>
</div>`;
}

// PRICE_FROM_ORDER_V1 — «цена от» в правильном для языка порядке.
//
// Раньше каждый вызывающий склеивал сам: t(lang,'price.from') + ' ' + money().
// По-русски и по-английски это верно («от 30 000 000 сум», «from …»), а
// по-узбекски получалось «dan boshlab 30 000 000 so'm» — то есть предлог
// впереди, как в русском. В узбекском -dan boshlab это ПОСЛЕЛОГ: правильно
// «30 000 000 so'mdan boshlab». На сайте, где узбекский — язык по умолчанию,
// так была написана каждая цена.
//
// Порядок теперь решает ОДНО место, а не каждый вызывающий по отдельности.
export function priceFrom(price, lang) {
  const amount = money(price, lang);
  if (!amount) return '';
  const word = t(lang, 'price.from');
  if (!word || word === 'price.from') return amount;
  // Узбекский: послелог, без пробела — он приклеивается к слову валюты.
  if (lang === 'uz') return `${amount}${word}`;
  return `${word}\u00A0${amount}`;
}
