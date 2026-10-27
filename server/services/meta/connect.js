// META_LEADS_V1_GRAPH (подключение) — проверить токен и привязать страницу.
//
// Три вопроса к Meta, по порядку:
//   1. /me — чей это токен. Токен пользователя или системного пользователя
//      отвечает человеком; токен страницы — самой страницей.
//   2. /me/accounts — страницы, к которым у токена есть доступ. У каждой Meta
//      отдаёт СВОЙ токен страницы: именно им читаются формы и заявки (право
//      leads_retrieval действует на страницу). Он хранится отдельно
//      (page_token_sealed). У токена страницы список пуст — тогда страница
//      это /me, а отдельный токен не нужен.
//   3. /{page}/leadgen_forms — формы страницы: имя, состояние, число заявок.
//
// Отказ на любом шаге — ничего не сохраняется: экран показывает причину, а
// прежнее подключение (если было) остаётся рабочим. Токен в ответ не попадает
// ни в каком виде: экран получает страницу, список страниц и формы.

import { graphGet } from './graph.js';
import { readSettingsRow, getTokens, storeConnection } from './settings.js';

const str = (v) => (v == null ? '' : String(v)).trim();
const fail = (r) => ({ ok: false, reason: r.reason || 'server_error', code: r.code || 0, message: r.message || '' });

/**
 * connect(db, { token?, pageId? }, { fetchImpl, timeoutMs, kekPath })
 *   token  — новый токен; без него берётся сохранённый (повторная проверка, смена страницы);
 *   pageId — какую из страниц взять, если их несколько (по умолчанию — прежняя или первая).
 */
export async function connect(db, { token = '', pageId = '' } = {}, { fetchImpl, timeoutMs, kekPath } = {}) {
  let t = str(token);
  if (!t) {
    try { t = getTokens(db, { kekPath }).token; }
    catch (e) { return { ok: false, reason: 'kek', message: e && e.message ? e.message : 'Ключ шифрования недоступен.' }; }
  }
  if (!t) return { ok: false, reason: 'no_token', message: 'Токен не задан.' };
  const o = { token: t, fetchImpl, timeoutMs };

  const me = await graphGet('me', { fields: 'id,name' }, o);
  if (!me.ok) return fail(me);

  // У токена страницы /me/accounts может ответить отказом «не тот тип токена» —
  // это не ошибка подключения, а ответ «страниц нет». Сеть и токен — ошибка.
  const acc = await graphGet('me/accounts', { fields: 'id,name,access_token', limit: 100 }, o);
  let pages = [];
  if (acc.ok && acc.data && Array.isArray(acc.data.data)) {
    pages = acc.data.data.filter((p) => p && p.id).map((p) => ({ id: str(p.id), name: str(p.name), access_token: str(p.access_token) }));
  } else if (!acc.ok && (acc.reason === 'offline' || acc.reason === 'bad_token')) {
    return fail(acc);
  }

  let page, pageToken = '';
  if (pages.length) {
    const want = str(pageId) || str((readSettingsRow(db) || {}).page_id);
    const chosen = pages.find((p) => p.id === want) || pages[0];
    page = { id: chosen.id, name: chosen.name };
    pageToken = chosen.access_token || '';
  } else {
    page = { id: str(me.data.id), name: str(me.data.name) };
  }

  const forms = await graphGet(`${page.id}/leadgen_forms`, { fields: 'id,name,status,leads_count', limit: 100 }, { ...o, token: pageToken || t });
  if (!forms.ok) return fail(forms);
  const list = (Array.isArray(forms.data.data) ? forms.data.data : []).filter((f) => f && f.id)
    .map((f) => ({ id: str(f.id), name: str(f.name), status: str(f.status), leads_count: Number(f.leads_count) || 0 }));

  storeConnection(db, { token: t, pageToken, page, forms: list, expiresAt: null }, { kekPath });
  return {
    ok: true,
    me: { id: str(me.data.id), name: str(me.data.name) },
    page,
    pages: pages.map((p) => ({ id: p.id, name: p.name })),
    forms: list,
  };
}
