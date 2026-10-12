// API_DOCS_V1 — ДОКУМЕНТАЦИЯ ДЛЯ ПАРТНЁРОВ: https://api.easymed.uz/docs
// (решение владельца 21, 2026-10-12). Одна страница на все клиники, всегда по
// коду этого сервера (docs/render.js). Без ключа, без данных клиник.
//
//   /docs            — по-русски (язык разработчиков в Узбекистане и язык
//                      ошибок API по умолчанию — одна ссылка, которую все шлют);
//   /docs/uz, /docs/en — узбекская и английская;
//   /docs/ru, /docs?lang=uz|en — перенаправление на свой адрес (у каждой
//                      страницы один адрес; ?lang — как у адресов API).
// Имя клиники «docs» занято (shared/api-connections.js RESERVED_SLUGS), так что с
// адресами клиник /<клиника>/v1/ страница не пересекается.
//
// Страница строится при первом запросе языка (~2 мс) и держится в памяти
// процесса (80–90 КБ на язык); кэш браузера — 5 минут с проверкой по ETag:
// после выпуска новая страница видна не позже чем через 5 минут. Ошибка
// построения — 500 только у этого адреса, служба запускается и без страницы.
import express from 'express';
import { renderDocs, DOCS_PAGE_LANGS } from '../docs/render.js';

export const DOCS_CACHE_SECONDS = 300;
export const DOCS_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** @param ctx {{baseUrl:string, uncollectedMaxMs?:number}} */
export function docsRouter(ctx) {
  const r = express.Router();
  const pages = new Map();
  const page = (lang) => {
    if (!pages.has(lang)) pages.set(lang, renderDocs({ lang, base: ctx.baseUrl, uncollectedMaxMs: ctx.uncollectedMaxMs }));
    return pages.get(lang);
  };
  const send = (req, res, lang) => {
    const html = page(lang);
    res.set('Cache-Control', 'public, max-age=' + DOCS_CACHE_SECONDS);
    res.set('Content-Security-Policy', DOCS_CSP);
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Language', lang);
    res.type('html').send(html);
  };
  const other = (l) => DOCS_PAGE_LANGS.includes(l) && l !== 'ru';
  r.get('/docs', (req, res) => {
    const q = String(req.query.lang || '').toLowerCase();
    if (other(q)) return res.redirect(301, '/docs/' + q);
    if (q === 'ru') return res.redirect(301, '/docs');
    return send(req, res, 'ru');
  });
  r.get('/docs/:lang', (req, res, next) => {
    const l = String(req.params.lang || '');
    if (l === 'ru') return res.redirect(301, '/docs');
    if (!other(l)) return next();
    return send(req, res, l);
  });
  return r;
}
