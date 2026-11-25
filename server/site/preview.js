// WEBSITE_PREVIEW_V1 (2026-11-25, владелец: «on the right side there should be place which
// shows live change in website») — страница сайта с ЕЩЁ НЕ СОХРАНЁННЫМИ правками редактора.
//
// Рисуют те же рендеры, что и сам сайт: второго «похожего» вида нет, и предпросмотр не может
// разойтись с тем, что увидит посетитель. В базу не пишется ничего (site/content.js withDraft).
//
// Страница показывается в <iframe sandbox="allow-scripts" srcdoc> — без allow-same-origin:
// карта и прочий HTML из настроек не получают сессию программы. Из такой рамки браузер не шлёт
// cookie, поэтому стили и картинки берутся по адресу с секретным ключом (previewBase), который
// выдаёт только RPC после проверки прав; ключ живёт до перезапуска сервера.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { LANGS, DEFAULT_LANG } from './i18n.js';
import { withDraft } from './content.js';
import { renderNotFound } from './render/notfound.js';
import { renderHome } from './render/home.js';
import { renderDoctors, renderDoctor } from './render/doctors.js';
import { renderServices, renderService } from './render/services.js';
import { renderDepartments, renderDepartment } from './render/departments.js';
import { renderAbout, renderContact, renderFaq, renderLegal } from './render/static-pages.js';
import { renderNews, renderPost } from './render/news.js';
import { renderAppointment, renderThanks } from './render/appointment.js';

const TOKEN = randomBytes(24).toString('hex');
export const previewBase = () => '/site-preview/' + TOKEN;
export function previewTokenOk(v) {
  const a = Buffer.from(String(v || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LISTS = {
  '': renderHome, doctors: renderDoctors, services: renderServices, departments: renderDepartments,
  news: renderNews, about: renderAbout, contact: renderContact, faq: renderFaq, appointment: renderAppointment,
  privacy: (db, lang) => renderLegal(db, lang, 'privacy'),
  terms: (db, lang) => renderLegal(db, lang, 'terms'),
};
const ITEMS = { doctors: renderDoctor, services: renderService, departments: renderDepartment, news: renderPost };
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null);

/** '/ru/doctors/7?x=1' → HTML страницы; неизвестный адрес — 404 сайта. */
function renderPath(db, rawPath) {
  let u;
  try { u = new URL(String(rawPath || '/'), 'http://site.local'); } catch { u = new URL('http://site.local/'); }
  const parts = u.pathname.split('/').filter(Boolean);
  const lang = LANGS.includes(parts[0]) ? parts.shift() : DEFAULT_LANG;
  const [section = '', slug, extra] = parts;
  const query = Object.fromEntries(u.searchParams);
  let html = null;
  if (extra === undefined) {
    if (slug === undefined) { const fn = own(LISTS, section); html = fn ? fn(db, lang, query) : null; }
    else if (section === 'appointment' && slug === 'thanks') html = renderThanks(db, lang);
    else { const fn = own(ITEMS, section); html = fn ? fn(db, lang, slug) : null; }
  }
  return html || renderNotFound(db, lang);
}

// Мост рамки: переходы по ссылкам и прокрутка сообщаются редактору, а формы, маячок и сеть
// молчат — предпросмотр не создаёт заявок и не попадает в статистику посещений.
const BRIDGE = `<script>(function(){
navigator.sendBeacon=function(){return true};window.fetch=function(){return Promise.reject(new Error('preview'))};
var say=function(m){m.ws='preview';parent.postMessage(m,'*')};
window.addEventListener('submit',function(e){e.preventDefault();e.stopImmediatePropagation()},true);
window.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;
var h=a.getAttribute('href')||'';if(h.charAt(0)==='#')return;var done=e.defaultPrevented;e.preventDefault();
if(!done&&/^[/](uz|ru|en)([/?]|$)/.test(h))say({type:'nav',path:h})});
var t=0;window.addEventListener('scroll',function(){if(t)return;t=setTimeout(function(){t=0;say({type:'scroll',y:window.scrollY})},80)},{passive:true});
window.addEventListener('message',function(e){var d=e.data||{};if(e.source!==parent||d.ws!=='editor')return;
var el=null;if(d.target){try{el=document.querySelector(d.target)}catch(x){}}
document.documentElement.style.scrollBehavior='auto';
if(el){var r=el.getBoundingClientRect();window.scrollTo(0,Math.max(0,window.scrollY+r.top-90))}
else if(typeof d.y==='number')window.scrollTo(0,d.y)});
})();</script>`;

export function previewHtml(db, { settings, row, path } = {}) {
  // noAnalytics — счётчики посещений в предпросмотре не запускаются.
  const html = withDraft({ settings, row, noAnalytics: true }, () => renderPath(db, path));
  const base = previewBase();
  return html
    .replace(/(\b(?:src|href|poster)=")\/(assets|media)\//g, (_, attr, dir) => `${attr}${base}/${dir}/`)
    .replace('<head>', () => '<head>\n' + BRIDGE);
}

/** site.css ссылается на шрифты от корня сайта — у предпросмотра корень другой. */
export const previewCss = (css) => css.replace(/url\((['"]?)\/assets\//g, (_, q) => `url(${q}${previewBase()}/assets/`);
